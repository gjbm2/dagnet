# 50 — Conditioned Forecast: generality gap (lagless edges + topology coverage)

**Status**: Problem statement + proposal — not yet implemented
**Created**: 18-Apr-26
**Related**: doc 45 (forecast-parity-design), doc 47 (whole-graph-forecast-pass), doc 29g (engine IS + sweep design), doc 54 (cf-readiness-protocol — downstream consumer of the per-edge CF contract)

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

Current implementation. Run `compute_forecast_trajectory` with
IS-conditioning on the cohort trajectories, read `p_infinity_mean`
(post-p@∞-fix) at `saturation_tau`, derive `completeness` from the
CDF saturation. No change proposed.

### Class B — lagless edge with snapshot evidence

No lag distribution means all cohorts are mature immediately by
assumption: `completeness(τ) = 1.0` for all τ ≥ 0. There is no IS
conditioning on trajectory shape. How we produce the conditioned
rate depends on which source the promotion hierarchy has picked for
this edge, because the sources differ in whether their `α, β` is
already query-scoped — see
[FE_BE_STATS_PARALLELISM.md §"Dual-evidence treatment"](../codebase/FE_BE_STATS_PARALLELISM.md)
and
[STATS_SUBSYSTEMS.md §5 Confusion 8](../codebase/STATS_SUBSYSTEMS.md).

**Class B1 — `bayesian` promoted**. The Bayes `α, β` is aggregate
(trained on the full corpus, not query-scoped), so it is a
legitimate prior. The cohort contributes a Binomial likelihood
`y ~ Bin(n=x, p)`. The posterior is a conjugate Beta-Binomial update:

```
α' = α_bayes + Σ y_i
β' = β_bayes + Σ (x_i - y_i)
p_mean = α' / (α' + β')
p_sd   = √(α'·β' / ((α'+β')²·(α'+β'+1)))
completeness = 1.0
completeness_sd = 0.0
```

**Class B2 — `analytic` or `analytic_be` promoted**. The source's
`α, β` is already a query-scoped Jeffreys posterior built from the
window's `total_k, total_n`. It IS the conditioned answer. Read
directly:

```
p_mean = α / (α + β)
p_sd   = √(α·β / ((α+β)²·(α+β+1)))
completeness = 1.0
completeness_sd = 0.0
```

No update — doing one would count the window's evidence twice.

Today CF returns nothing for either sub-case. Proposed: CF routes
lagless edges through one of B1 or B2 depending on the promoted
source.

### Class C — edge with prior but no query-scoped snapshot evidence

No snapshot rows matched the user's DSL window for this edge. This
does *not* mean "no evidence" in any broad sense: the resolver's
α/β already folds in parameter-file observations and the Bayesian
aggregate fit (via the D20 fallback chain in
[model_resolver.py:328-352](graph-editor/lib/runner/model_resolver.py#L328-L352)).
What's missing is the query-window-specific snapshot evidence that
would refine that prior further.

Mathematically, the posterior given zero new snapshot evidence IS
the existing prior. The correct answer is therefore a normal
`edge_results` entry populated from the promoted source:

- `p_mean` = source's `α / (α + β)` (or equivalent prior mean)
- `p_sd` = source's prior SD (Beta closed form or heuristic)
- `completeness` = `1.0` for lagless edges, CDF-at-query-date for
  laggy edges (i.e. the same completeness the topo pass computes —
  CF does not add information about maturity when it has no new
  evidence)

This is NOT a skip. The user gets a real number (the best available
estimate given the absence of window evidence), downstream consumers
see that CF processed the edge, and the readiness store (doc 54)
marks it as applied. Earlier versions of this doc listed "no
evidence in window" as a `skipped_edges` reason — that was wrong
by the unified-design-principle: returning the prior is the honest
answer, skipping is silence.

### Class D — no prior AND no evidence

This is the only genuine skip case. The edge has neither a
promoted source (no `model_vars`, no posterior, no promoted scalars)
nor any snapshot rows. CF has literally nothing to report.
Structured `skipped_edges` entry with
`reason = 'no prior and no evidence'`. In practice these are
structural-only edges or misconfigured parameterisations — rare in
normal graphs.

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
`p_infinity_mean` / `p_infinity_sd` scalar (computed once,
closed-form), and τ-dependent fields (`midpoint`, `fan_*`) are
populated with that same scalar. This makes Class B the natural
σ→0 limit of Class A — the chart renders a flat line with a flat
band as a degenerate case of the existing fan, with no chart-layer
branch. See §4 Q1 resolution.

Class C (no evidence in window) falls out of the same row builder
in either branch — if the evidence `Σn = 0`, the "update" step is a
no-op (B) or the IS likelihood collapses to the proposal (A), and
the result is the prior. No separate code path needed at the row
level; the response-assembly layer labels the result prior-only
for provenance.

### 3.2 Structured `skipped_edges` channel

The CF response already has a `skipped_edges` array. Enforce that
every parameterised edge in the input graph appears either in
`edges` (with a result) OR in `skipped_edges` (with a `reason`).
No silent drops. Under the unified design of §2, there is exactly
one skip reason:

- `'no prior and no evidence'` — Class D. The edge has no promoted
  source and no snapshot rows. CF cannot compute anything.

Every other state has a real answer:
- Evidence present, lag present → Class A (IS-conditioned MC).
- Evidence present, no lag → Class B (Beta-Binomial direct).
- No evidence, prior present → Class C (return the prior).

The richer reason vocabulary in earlier versions of this doc
(`'no snapshot rows after regime selection'`, `'DSL matched no
subjects on this edge'`, `'resolver returned no promoted source'`,
etc.) was a symptom of conflating "CF did not update" with "CF
cannot compute". Only the latter warrants a skip.

This structured channel is the contract [doc 54 (CF readiness
protocol)](54-cf-readiness-protocol.md) consumes to distinguish "CF
still pending" from "CF ran and intentionally skipped this edge" from
"CF failed". Class B edges (lagless with evidence) must mark as
CF-applied in the readiness store — not forever-pending — so
downstream analyses with `cf_dependency: preferred` can upgrade from
approximate to definitive correctly. Reason strings here are part of
the public contract; pick them with doc 54's consumer behaviour in
mind.

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

## 4. Design questions — resolved (20-Apr-26)

1. ~~**Chart display for lagless edges**~~. **Resolved**: no special
   handling. Class B is the σ→0 limit of Class A — `_lagless_rows`
   emits the same row schema as `_lag_sweep_rows`, with the
   time-independent scalars populated across all τ. The chart
   renders a flat line with a flat band naturally, as a degenerate
   case of the existing fan chart. No marker, no chart-layer branch.
   (See §5.3 acceptance invariant 3 — "Class A ↔ Class B continuity".)

2. ~~**`completeness` semantics for lagless edges**~~. **Resolved**:
   `completeness = 1.0`, `completeness_sd = 0.0`. No new field or
   provenance flag — consumers that need to distinguish can read
   `resolved.latency.sigma` directly.

3. ~~**Prior choice**~~. **Resolved** via the promotion hierarchy.
   There is no new prior-choice decision to make; the promoted
   source determines which sub-path Class B takes (see §2 Class B):
   - **B1 (`bayesian` promoted)**: Bayes `α, β` is aggregate and
     safe as a prior → conjugate Beta-Binomial update with
     query-scoped `Σk, Σn`.
   - **B2 (`analytic` / `analytic_be` promoted)**: source's `α, β`
     is already a query-scoped Jeffreys posterior → read directly,
     no update (double-counting avoidance).
   Grounded in
   [FE_BE_STATS_PARALLELISM.md §"Dual-evidence treatment"](../codebase/FE_BE_STATS_PARALLELISM.md)
   and
   [STATS_SUBSYSTEMS.md §5 Confusion 8](../codebase/STATS_SUBSYSTEMS.md).

4. ~~**Sibling PMF consistency**~~. **Verified not a risk** (20-Apr-26).
   The apply path goes
   `applyConditionedForecastToGraph` ([conditionedForecastService.ts:156](graph-editor/src/services/conditionedForecastService.ts#L156))
   → `updateManager.applyBatchLAGValues`
   ([:222](graph-editor/src/services/conditionedForecastService.ts#L222)).
   The rebalancer's sibling selector
   ([`findSiblingsForRebalance` :271–280](graph-editor/src/services/conditionedForecastService.ts#L271-L280))
   filters on `source node + case_variant + has p.mean` only — it
   does not inspect `completeness`, `sigma`, or any lag field.
   `distributeWithExactSum`
   ([:311–374](graph-editor/src/services/conditionedForecastService.ts#L311-L374))
   redistributes weight using only the siblings' `p.mean` values;
   `completeness` is metadata, not an arithmetic input. The Class B
   path changes a lagless sibling from "no `p.mean`, excluded from
   rebalance" to "has `p.mean` with `completeness=1.0`, included in
   rebalance" — structurally identical to any other sibling with
   CF-written `p.mean`. No new branch, no new invariant. This
   question is closed; left in place as a record so the concern is
   not re-opened by future readers.

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

Two CLI harnesses back the test matrix:

- [`graph-ops/scripts/cf-topology-suite.sh`](../../../graph-ops/scripts/cf-topology-suite.sh) —
  drives each topology fixture through
  `conditioned-forecast-parity-test.sh` and asserts the **structural**
  invariants (no silent drops, chart↔CF parity, sibling PMF ≤ 1.0).
  6/6 fixtures green as of 20-Apr-26.

- [`graph-ops/scripts/cf-truth-parity.sh`](../../../graph-ops/scripts/cf-truth-parity.sh) —
  compares per-edge CF `p_mean` against `truth.yaml` ground truth.
  **Asserts on lagless (Class B) edges** at tolerance `|Δ| < 0.05`;
  reports laggy (Class A) deltas informationally. All 10 Class B
  edges across the fixture suite pass on 20-Apr-26, including the
  `laggy → lagless → laggy` configuration (cf-fix-deep-mixed
  edges b→c→d→e).

Chart↔CF parity is a tautology of construction (both paths route
through `compute_cohort_maturity_rows_v3`) — it catches handler
drift but not arithmetic errors in the shared row builder. Truth
parity is the stronger check and must remain green for Class B.

### 5.5 Pre-existing laggy-edge bias (out of scope for this doc)

`cf-truth-parity.sh` reveals a systematic undershoot on Class A
edges even in all-laggy fixtures (`synth-simple-abc`: truth 0.70 vs
CF 0.60; truth 0.60 vs CF 0.50). The bias:

- Is present in fixtures that pre-date doc 50 and is observable on
  code paths this doc does not touch.
- Shrinks as the query window widens relative to path `t95` (cohort
  maturity effect), but does not vanish.
- Can exceed 0.5 on cohort-mode terminal edges when query-window
  cohorts are very immature (e.g. `synth-mirror-4step`
  `m4-registered → m4-success` with truth 0.70 vs CF 0.018 under
  `cohort(7-Mar-26:21-Mar-26)`).
- Does NOT worsen when a lagless edge sits upstream of a laggy
  edge (cf-fix-deep-mixed delta magnitudes are consistent with the
  same-signed bias seen on all-laggy fixtures).

This is a distinct CF accuracy investigation. Not a doc-50 issue.
The truth-parity test reports it informationally so it's surfaced,
not hidden.

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
