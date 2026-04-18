# 50 — Conditioned Forecast: generality gap (lagless edges + topology coverage)

**Status**: Problem statement + proposal — not yet implemented
**Created**: 18-Apr-26
**Related**: doc 45 (forecast-parity-design), doc 47 (whole-graph-forecast-pass), doc 29g (engine IS + sweep design)

## TL;DR

The whole-graph conditioned forecast (CF) handler at
`/api/forecast/conditioned` is not a general-purpose per-edge forecast.
It short-circuits past any edge whose promoted latency has `sigma <= 0`,
silently omitting that edge from the response. On some graphs (where
the BE topo pass happens to have synthesised a near-zero lag fit into
`analytic_be`) those edges accidentally receive a result; on others
(where no synthetic fit was written) they do not. Coverage depends on
upstream accidents of the pipeline rather than on the edge's semantics,
and the handler writes no `skipped_edges` entry to explain the omission.

The real defect is two-headed:

1. **Semantic**: CF conflates "conditioned forecast" with "lag-sweep
   forecast". For a lagless edge there is still probability
   conditioning to do (Beta-Binomial update on `y | x ~ Bin(p)`), and
   there is still a perfectly defined asymptotic `p`. CF currently has
   no path for that case.
2. **Topological**: the existing test graphs do not cover the mixed
   lagless / laggy topologies that real graphs routinely have. Today
   only two synth graphs exercise CF end-to-end
   (`synth-simple-abc`, `synth-mirror-4step`), both are pure linear
   chains, and the second actively demonstrates the "silent omit"
   behaviour without the test suite catching it.

This doc captures the problem in full and proposes a design for a
general-purpose CF that handles every edge class consistently and has
a topology test matrix covering at least the realistic shapes.

## 1. What CF does today

Entry point:
[`handle_conditioned_forecast`](graph-editor/lib/api_handlers.py)
(api_handlers.py).

Per edge it calls
[`compute_cohort_maturity_rows_v3`](graph-editor/lib/runner/cohort_forecast_v3.py)
and reads the asymptotic scalars off the returned rows. The row
builder begins with:

```python
if not resolved or resolved.latency.sigma <= 0:
    return []
```

Consequences:

- Edges whose promoted model_var has no usable latency (`sigma <= 0`)
  return **zero rows**.
- CF's response assembly only appends to `edge_results` when
  `maturity_rows` is non-empty. There is no corresponding
  `skipped_edges` entry when the omission is due to missing latency.
- Downstream consumers (FE `applyConditionedForecastToGraph`) never
  learn about the edge and the graph's existing `p.mean` / `p.latency`
  stays at whatever was last promoted — typically stale or prior-only.

### Why it "works" on some graphs and not others

Direct inspection of `bayes-test-gm-rebuild` vs `synth-mirror-4step`:

| Graph | Edge | edge.p.latency | mv[bayesian] | mv[analytic] | mv[analytic_be] |
|---|---|---|---|---|---|
| gm-rebuild | `Landing-page → household-created` | all None | all None | all None | **μ=-6.52, σ=2.81, t95=0.15** |
| gm-rebuild | `household-created → household-delegated` | all None | all None | all None | **μ=-6.46, σ=2.60, t95=0.11** |
| 4step | `m4-landing → m4-created` | all None | (no mv lat) | (no mv lat) | (no mv lat) |
| 4step | `m4-created → m4-delegated` | all None | (no mv lat) | (no mv lat) | (no mv lat) |

On `gm-rebuild`, `analytic_be` carries a BE-topo-synthesised "near-zero
lag" distribution (effectively instantaneous, `exp(-6.5) ≈ 0.0015`
days). The resolver picks `analytic_be` via the promotion chain, the
sweep runs with σ ≈ 2.8, and CF returns a value — numerically close to
what a Beta posterior would give, but via a path that isn't really
modelling "no latency" so much as "tiny latency with broad uncertainty".

On `synth-mirror-4step`, no synthetic fit was written, `resolved.latency.sigma`
is zero, the row builder returns `[]`, and CF silently drops both
lagless edges. The graph-ops parity script
(`conditioned-forecast-parity-test.sh`) reports these as SKIP and
treats SKIP as failure, but the failure is not caught in CI (the
script is not wired in).

### Observed symptoms on a production-adjacent graph

On `bayes-test-gm-rebuild` with `cohort(1-Apr-26:9-Apr-26)`:

- Terminal edge `switch-registered → switch-success` got CF
  `p_mean = 0.2464` with `completeness ≈ 0.11` (very low maturity). The
  cohort-maturity v3 chart on the same graph, same DSL, showed a
  last-row midpoint ≈ 0.66 because the chart's axis extended to τ=90
  (2·path_t95 is the asymptote) while CF read midpoint at τ=26 (edge
  t95). That divergence was the user-observable "wildly irrelevant
  p.mean" that prompted this investigation and has now been fixed
  separately (saturation_tau split introduced in the same branch).

- The separate "accidental CF" issue documented here is independent:
  even after the p@∞ fix, the first two hops of
  `synth-mirror-4step` still silently drop out of the CF response.

## 2. What "conditioned forecast" should mean for every edge class

CF's job is to emit per-edge scalars (`p_mean`, `p_sd`, `completeness`,
`completeness_sd`) that reflect the posterior on this edge's
conversion rate conditioned on the observed evidence over the query
window. The quantity is always `y / x` on the edge. What changes
across edge classes is **how the conditioning works**.

### Class A — lag-equipped edge with snapshot evidence

Current implementation. Run `compute_forecast_sweep` with
IS-conditioning on the cohort trajectories, read `p_infinity_mean`
(post-p@∞-fix) at `saturation_tau`, derive `completeness` from the
CDF saturation. No change proposed.

### Class B — lagless edge with snapshot evidence

No lag distribution means all cohorts are mature immediately by
assumption: `completeness(τ) = 1.0` for all τ ≥ 0. There is no IS
conditioning on trajectory shape — the cohort contributes a
Binomial likelihood `y ~ Bin(n=x, p)`. The posterior on `p` is the
Beta-Binomial update:

```
α' = α_prior + Σ y_i
β' = β_prior + Σ (x_i - y_i)
p_mean = α' / (α' + β')
p_sd   = √(α'·β' / ((α'+β')²·(α'+β'+1)))
completeness = 1.0
completeness_sd = 0.0
```

where the prior `(α, β)` comes from the promoted `model_vars` source
(Bayesian posterior if available, else analytic point estimate
centred at the source's `p_mean`).

Today CF returns None. Proposed: CF returns the Beta-Binomial
posterior scalars above.

### Class C — edge with no evidence (lag-equipped or not)

No snapshot rows in the query window. Two reasonable behaviours:

1. Return `p_mean` verbatim from the promoted model_var (prior-only —
   "no update from this query").
2. Return an explicit `skipped_edges` entry with `reason='no evidence
   in window'` and NO result. FE keeps the existing scalar unchanged.

Today the handler's `skipped_edges` channel exists but is under-used:
missing-evidence and missing-latency cases both silently drop. Proposed:
always route such edges through `skipped_edges` with a structured
`reason` field, never via a silent omit.

### Class D — probability-only edges (`p.id` set, no latency, prior absent)

Rare but valid. If the edge has neither evidence nor a prior, CF cannot
compute anything — `skipped_edges` with
`reason='no prior and no evidence'`.

## 3. Proposal

### 3.1 Split the CF per-edge pipeline into two code paths sharing one response shape

Inside `compute_cohort_maturity_rows_v3` (or, more cleanly, in a small
new helper in `runner/` — see §3.3), branch at the top:

```python
if resolved.latency.sigma > 0:
    # Class A — current lag-sweep path. Returns rows + p@∞ scalars.
    return _lag_sweep_rows(...)
else:
    # Class B — Beta-Binomial posterior. Returns a minimal row set
    # with p_infinity_mean / p_infinity_sd from the closed form and
    # completeness = 1.0, completeness_sd = 0.0.
    return _lagless_rows(...)
```

`_lagless_rows` builds a row set over the display range (`max_tau`
= `axis_tau_max` if set, else the query's `tau_future_max`) with the
same schema current rows use. Every row carries the same
`p_infinity_mean` / `p_infinity_sd` scalar (computed once, closed-form).
`midpoint` / `fan_*` are either populated with the same scalar (trivial
since there is no τ dependence) or marked None — decision per §4 below.

### 3.2 Structured `skipped_edges` channel

The CF response already has a `skipped_edges` array. Enforce that every
parameterised edge in the input graph appears either in `edges` (with a
result) OR in `skipped_edges` (with a `reason`). No silent drops.
Reasons: `'no latency and no evidence'`, `'no snapshot rows after
regime selection'`, `'DSL matched no subjects on this edge'`,
`'resolver returned no promoted source'`.

### 3.3 Shared helper for the per-edge call

Today the v3 chart handler and CF handler each assemble ~200 lines of
kernel + carrier + x_provider + frame-composition setup around the
same underlying `compute_cohort_maturity_rows_v3` call, with subtle
drift between them (the surfaced max_tau issue from doc 45 follow-up
is one example). Extracting a shared helper — `compute_edge_forecast_scalars(
graph, edge, subjects, effective_query_dsl, ...)` returning the normalised
response dict — would:

- Force parity between "what CF writes to the graph" and "what the v3
  chart displays at the saturation τ" by construction (same function,
  one call per edge vs one call for the subject in v3).
- Eliminate silent drops by making the response contract explicit.
- Localise the lagless / laggy / empty-evidence branching.

This is not a blocker for the current fix (Class B handling), but it is
the natural shape once the Class B path exists.

## 4. Design questions to resolve

Listed so a follow-up design doc can close them before implementation.

1. **Chart display for lagless edges**. The v3 chart today returns
   empty rows for lagless edges, so the chart is blank. With Class B
   implemented the chart could either stay blank (trivial — no time
   evolution to plot) or render a flat line at `p_infinity_mean`.
   Recommendation: stay blank for now; surface the scalar via the edge
   badge / hover instead.

2. **`completeness` semantics for lagless edges**. Proposed `= 1.0`
   since no residual maturation is expected. An argument for `None` is
   that "completeness" is an untagged-population-vs-arrived ratio that
   isn't well-defined without a lag CDF. Decision: `1.0` with a
   provenance flag (`completeness_source: 'lagless'`) on the row so
   consumers can distinguish.

3. **Prior choice when no Bayesian posterior is promoted**. If the
   edge has only `analytic` (flat point estimate), the Beta prior's
   concentration is undefined. Options: (a) use a weakly-informative
   prior (`α=β=1`) that doesn't meaningfully shift the rate; (b) use
   the analytic point as a Dirac, in which case CF output ≡ evidence
   rate; (c) use the κ from the promoted source's confidence band,
   mapped to α/β. Recommendation: (a) when no `α`, `β`, or `κ`
   available; otherwise use the promoted source's `α_pred`, `β_pred`.

4. **Sibling PMF consistency**. CF currently writes per-edge
   `p_mean` and expects `UpdateManager.applyBatchLAGValues` to
   rebalance siblings. With Class B edges now producing numbers, the
   sibling group containing a lagless edge + laggy siblings must
   still sum to ≤ 1. Need to verify `UpdateManager` is indifferent to
   the source (lagless Beta posterior vs lag-sweep p@∞) and handles
   both consistently.

## 5. Test matrix (minimum)

Before declaring CF general-purpose, the following must be green.
Fixture graphs live in the data repo under `graphs/` (or a new
`graphs/cf-topology-fixtures/` subdir).

### 5.1 Topology fixtures

| # | Name | Shape | Purpose |
|---|------|-------|---------|
| T1 | `cf-fix-linear-all-lag` | a→b→c→d, all edges lag-equipped | Regression for current Class A path |
| T2 | `cf-fix-linear-no-lag` | a→b→c→d, no edges lag-equipped | New Class B coverage |
| T3 | `cf-fix-linear-mixed` | a→b(lag)→c(no-lag)→d(lag) | Mixed class coverage; the case that motivated this doc |
| T4 | `cf-fix-branching` | a→b, a→c (siblings, one lag one not) | Sibling PMF invariant under mixed classes |
| T5 | `cf-fix-join` | a→c, b→c (converging, different lag profiles) | Join-node completeness composition |
| T6 | `cf-fix-diamond` | a→{b,c}→d (classic diamond) | Fanout + rejoin with lag |
| T7 | `cf-fix-deep-mixed` | 5+ hop chain alternating lagless / laggy | Depth stress + cumulative path latency |

### 5.2 Semantic matrix (per fixture)

For each applicable fixture, cover:

- **Query modes**: `window(-30d:)`, `cohort(-60d:-30d)`, `asat(...)` (at least one)
- **Maturity**: (recent, still-maturing) vs (old, saturated) cohorts
- **Evidence density**: (dense, many cohorts × many days) vs (sparse, few cohorts)
- **No-evidence edge cases**: DSL that resolves to zero snapshot rows for a subject; must appear in `skipped_edges`
- **Prior availability**: edge with Bayesian posterior vs edge with analytic-only source

### 5.3 Acceptance invariants

1. **No silent drops**: for every parameterised edge (`p.id` set),
   exactly one of `edges[i]` or `skipped_edges[i]` is emitted.
2. **Lagless numerical correctness**: Class B `p_mean` matches the
   closed-form Beta-Binomial posterior on a handcrafted fixture with
   known counts, to 4dp. `p_sd` matches the Beta SD closed form.
3. **Class A ↔ Class B continuity**: on a fixture where an edge has
   near-zero `sigma` (→ 0), the lag-sweep limit and the lagless
   closed form agree within MC variance (≤ 0.01 on p_mean).
4. **Chart parity**: for lag-equipped edges, CF's `p_infinity_mean`
   equals the v3 chart's last-row `p_infinity_mean` on the same
   subject + DSL, to 4dp. (Already holds post-p@∞ fix.)
5. **Sibling PMF**: every sibling group sums to ≤ 1.0 after
   `UpdateManager.applyBatchLAGValues` under mixed-class edges.
6. **Whole-graph coverage**: the CF response for a topology fixture
   lists every parameterised edge, no omissions.

### 5.4 Wiring

A new CLI harness `graph-ops/scripts/cf-topology-suite.sh` drives
the topology fixtures through the CLI and asserts the above
invariants. The existing `conditioned-forecast-parity-test.sh` covers
only "per-edge CF ↔ v3 chart parity for the terminal edge"; it stays
as a smoke test and the topology suite becomes the whole-graph
contract test. Neither runs against production graphs.

## 6. Scope and sequencing

This is a doc-45 follow-on. The p@∞ fix (saturation_tau split) landed
in the same branch and is independent; it should ship first.
Sequencing:

1. Ship the p@∞ fix (in progress — under review).
2. Build the topology fixtures (T1–T7) and the CLI harness.
3. Implement Class B (lagless Beta-Binomial path) behind the fixtures.
4. Enforce structured `skipped_edges` and delete the silent-drop paths.
5. (Optional, if the extracted helper in §3.3 is wanted) refactor the
   v3 chart handler and CF handler onto a shared per-edge helper.

Each step committed as a separate PR with its own regression gate.

## 7. Out of scope

- Bayesian fit itself (that lives under the Phase A/B/C compiler work).
- Sampling / MCMC performance (P3.21).
- `conversion_rate` analysis type (doc 49) — that's a different
  handler with its own lagless story already in flight.
- Asat() reconstruction for lagless edges (depends on doc 42 / P3.10).
