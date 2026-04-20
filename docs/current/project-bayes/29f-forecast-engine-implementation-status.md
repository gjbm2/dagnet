# 29f — Forecast Engine: Implementation Status

**Date**: 16-Apr-26
**Revised**: 16-Apr-26 — accuracy review of phase statuses, codepath
divergence analysis added (§Codepath Divergence Analysis).
**Depends on**: doc 29 (design), doc 29e (implementation plan), doc 29g
(IS conditioning design)

---

## Summary

| Phase | Status | Key result |
|-------|--------|------------|
| 0 | Done | v1/v2 single-hop parity. Tests in `test_doc31_parity.py`. |
| 1 | Done | `resolve_model_params` — unified resolver with preference cascade. 8 tests. |
| 2 | **Superseded by G.1** | `compute_forecast_state_window` removed (G.3). The topo pass now calls `compute_forecast_trajectory` via `_evaluate_cohort` (G.1). |
| 3 | **Superseded by G.1** | `compute_forecast_state_cohort` removed (G.3). Carrier convolution retained in `_convolve_completeness_at_age` for `compute_forecast_summary` (surprise gauge). |
| 4 | Eliminated | Engine writes to existing fields per doc 29 §Schema Change — consumers already read them. BE is a full upgrade of FE values. Session log shows FE→BE parity per edge. |
| 5 | **In progress** | v3 row builder uses `compute_forecast_trajectory` for MC population model. Parity test (`v2-v3-parity-test.sh`) green on synth-mirror-4step (17/17). Two critical fixes landed 16-Apr-26: span widening for single-hop cohort, upstream evidence fetch for empirical carrier. |
| 6 | Done | CLI-based parity test (`v2-v3-parity-test.sh`) with data health checks, non-vacuousness gates, and 20% fan tolerance. 44 Python tests + 15 TS tests. |
| 7 | Not started | Future enhancements (posterior covariance, asat projection). |
| **G** | **In progress** | **Codepath generalisation** — unify topo pass and chart onto shared engine primitives. G.0 done, G.1 done, G.1b done (daily conversions), G.3 done, D20 fixed. See §Codepath Divergence Analysis and §Generalisation Plan. |

---

## Phase 5: cohort_maturity_v3 — In Progress

### What works (16-Apr-26)

v3 parity test (`graph-ops/scripts/v2-v3-parity-test.sh`) passes 17/17 on synth-mirror-4step:
- Single-hop cohort (wide + narrow date ranges)
- Multi-hop cohort (wide + narrow date ranges)
- Window mode baseline

The test uses CLI `analyse.sh` tooling — same pipeline as the browser (FE aggregation → subject resolution → hash lookup → snapshot query → BE handler → FE normalisation). No reimplemented hash lookup or manual handler calls.

### Critical fixes landed (15-16 Apr-26)

**D9 FIXED: v2 collapsed shortcut removed.** v2's handler for single-edge cohort mode was falling back to v1's `compute_cohort_maturity_rows`, which lacks upstream x conditioning (no carrier), doesn't do a topo pass, and uses a simpler population model that v2 was designed to replace. Every single-edge cohort chart in production was running v1. The collapsed shortcut has been removed. v2 now uses its own factorised path for all cases.

**D15: Span widening for single-edge cohort with upstream lag.** When anchor ≠ from_node in single-edge cohort mode, `mc_span_cdfs(from_node, to_node)` produces an edge-level CDF that completes too fast for anchor-relative ages. Pop D contributes nothing (remaining CDF ≈ 0), midpoint stays flat. Fix: widen the span to `mc_span_cdfs(anchor, to_node)` — path-level CDF gives correct Pop D timing. Override `mc_p_s` with edge-level p so the rate converges to edge p, not path p. Applied to both v2 and v3 handlers. Natural degeneration: multi-hop span is already path-level; window mode uses edge-level (correct); single-hop with anchor = from has no widening.

**D16: det_norm_cdf must be edge-level for E_i.** The deterministic CDF used for E_i computation (effective exposure for IS conditioning) must be edge-level even when the MC CDF is path-level. Path CDF at young frontier ages gives tiny E_i → IS conditioning doesn't fire → unconditioned (wide) fans. v2 uses edge kernel for `sp.C` (E_i) and widened span for `mc_cdf_arr` (population model). v3 now matches.

**D17: Upstream evidence fetch for v3.** v3's carrier fell back to Tier 3 (weak prior) on multi-hop because it didn't fetch upstream edge snapshot data. v2 fetches 2000+ upstream rows for empirical carrier (Tier 2). Fix: extracted `_fetch_upstream_observations()` as shared function, called from v3 handler. v3 carrier now reaches Tier 2 (empirical) matching v2.

### Design insight: one generalised loop

The population model loop is the same for all cases. What changes is the inputs:
- **CDF**: from `mc_span_cdfs(span_x, to_node)` — span_x = anchor for widened single-hop cohort, from_node otherwise
- **p draws**: from `mc_span_cdfs(from_node, to_node)` — always edge-level
- **Carrier**: from `build_upstream_carrier` with upstream observations — handles x growth
- **det_norm_cdf (for E_i)**: from edge kernel — always edge-level

Cases degenerate naturally:
- Multi-hop cohort: span is already path-level. Carrier provides x growth.
- Single-hop cohort, anchor ≠ from: widened span gives path CDF. Carrier provides x growth.
- Single-hop cohort, anchor = from: no widening needed (path = edge). Carrier reach = 0.
- Window mode: edge CDF. No carrier. x = N_i fixed.

### Parity test design

The parity test (`graph-ops/scripts/v2-v3-parity-test.sh`) was designed from first principles after extensive failure with reimplemented Python tests.

**Phase 1 — Data health checks** (prevent vacuous tests):
- Graph JSON exists with expected edges
- Snapshot DB has rows per edge (cohort + window slice_keys)
- CLI analyse returns rows with `evidence_x > 0` (observed cohorts present)

**Phase 2 — Row-level parity**:
- midpoint: Δ < 0.03
- fan width (90% band) ratio: within [0.80, 1.20]
- forecast_x ratio: within [0.80, 1.20]
- forecast_y ratio: within [0.80, 1.20]

**Test cases**: wide + narrow date ranges for both single-hop and multi-hop cohort. The narrow range (young cohorts) catches the IS conditioning failure mode visible in production.

**Critical principle**: tests use `analyse.sh` (CLI tooling) which runs the exact same FE pipeline as the browser. Earlier Python tests reimplemented hash lookup and subject resolution, producing tests that passed vacuously with 0 cohorts while production was visibly broken. See anti-patterns 39-40 in `KNOWN_ANTI_PATTERNS.md`.

### What was painful and why

This workstream took far longer than it should have. The root causes:

1. **Testing against the wrong target.** v2's single-hop cohort fell through to v1 via the "collapsed shortcut". Every parity comparison was measuring v3 against v1, not v2. The real v2 implementation for this case had never run in production. Hours were spent matching v1's output when the correct target was v2's factorised path.

2. **Reimplemented test infrastructure.** Python pytest tests built manual hash lookup (`_get_candidate_regimes`), manual candidate regime construction, manual handler calls — reimplementing the FE pipeline. The hashes didn't match, cohorts were 0, tests passed vacuously. The CLI tooling (`analyse.sh`) that exercises the real pipeline was already built and documented in `cli-analyse.md`. It was not used.

3. **Code before tests.** Repeatedly: change code → run broken test → test passes → deploy → user sees it's broken → investigate → find the test was vacuous. The correct sequence (write test that fails → understand why → fix code → test passes) was not followed until the user forced it.

4. **Devtools treated as afterthought.** The hydrate tool was built but not tested — it broke core_hash alignment with snapshot data, making all downstream tests vacuous. The synth graph appeared to work (graph JSON existed, had edges) but the snapshot linkage was invisible. A 30-second check (`evidence_x > 0`) would have caught this immediately.

5. **Not reading the playbooks.** `cli-analyse.md` has a section titled "Synthetic graph testing" with the exact commands needed, including `--topo-pass` and `--no-snapshot-cache`. It was not read.

---

## Key Files

| File | Purpose |
|------|---------|
| `lib/runner/cohort_forecast_v3.py` | v3 row builder — thin consumer of engine |
| `lib/runner/forecast_state.py` | `compute_forecast_trajectory` (population model), `compute_forecast_summary` (IS) |
| `lib/api_handlers.py` | `_handle_cohort_maturity_v3` handler, `_fetch_upstream_observations` shared function |
| `graph-ops/scripts/v2-v3-parity-test.sh` | CLI-based parity test (17 checks) |
| `graph-ops/scripts/analyse.sh` | CLI analyse tool (same pipeline as browser) |
| `lib/tests/test_v2_v3_parity.py` | Legacy Python parity tests (to be replaced by CLI test) |

---

## Defects Found and Fixed

| ID | Description | Status |
|----|-------------|--------|
| D1 | BE scalar overwrite bypassed promotion | Fixed |
| D2 | Topo pass re-fits mu/sigma for Bayesian edges | Pre-existing |
| D3 | Wrong test file created | Fixed |
| D4 | Tier 1 DRIFT_FRACTION crippled IS | Fixed |
| D5 | Reach-scaling bug in carrier convolution | Fixed |
| D6 | Schema bloat: ForecastState TS interface | Fixed (removed) |
| D7 | Missing dispersions in ModelVarsEntry | Fixed |
| D8 | IS ESS collapse | Fixed (per-cohort sequential IS) |
| D9 | v2 collapsed shortcut: single-hop cohort fell through to v1 | **Fixed 16-Apr-26** — removed shortcut, v2 uses factorised path |
| D10 | v3 evidence aggregation differs from v2 | Fixed (v3 now uses same per-cohort obs_x/obs_y) |
| D11 | v3 epoch boundary mismatch | Fixed |
| D12 | v3 handler missing response contract fields | Fixed |
| D13 | v1 handler gate didn't match cohort_maturity_v1 | Fixed |
| D14 | Parity tests too loose / vacuous | **Fixed 16-Apr-26** — CLI-based test with non-vacuousness gates |
| D15 | Single-hop cohort CDF too fast (edge-level vs anchor-relative ages) | **Fixed 16-Apr-26** — span widening |
| D16 | det_norm_cdf path-level breaks IS conditioning on young cohorts | **Fixed 16-Apr-26** — edge kernel for E_i |
| D17 | v3 carrier falls to weak prior (missing upstream evidence fetch) | **Fixed 16-Apr-26** — shared `_fetch_upstream_observations` |
| D18 | CLI topo pass does not scope cohorts to query DSL — IS conditioning uses full param file instead of DSL-windowed cohorts. All CLI topo pass outputs (param-pack, analyse --topo-pass, hydrate) affected. | **Fixed 16-Apr-26** — `runCliTopoPass` now parses DSL date range, builds `edge_contexts` with `scoped_cohorts`, sends `query_mode`. |
| D19 | Deterministic `forecast_y` diverges from MC `midpoint` for multi-hop-narrow. Root cause: `_compute_det_totals` uses unconditioned p (0.72) while MC uses IS-conditioned p (0.016). 45× difference in effective p. Pre-existing in v2. Blocks G.4. | **Open.** See `29f-defect-d19-det-mc-pop-c-divergence.md`. |
| D20 | Weak prior (kappa=20 or Beta(1,1)) in forecast sweep allows IS conditioning to overwhelm for per-cohort evaluation. Single young cohort with 1247 trials swings posterior from 10% to 50%. Manifests in daily conversions; stable in aggregate consumers (chart, topo pass). | **Fixed 16-Apr-26** — model resolver derives alpha/beta from evidence n/k; kappa=200 fallback. See `29f-defect-d20-weak-prior-is-collapse.md`. |

---

## Outstanding Work

### Remaining for Phase 5 completion

1. **Browser verification on production graph.** Parity test passes on synth. Need visual confirmation that v2 and v3 charts match in the FE render on the production graph with various cohort selections (young, old, mixed).

2. **Retire v2 (Phase 5.5).** After browser verification. Delete `cohort_forecast_v2.py`, `span_adapter.py`, v2 handler, v1 handler. v1 and v2 currently gated to dev only.

### Deferred

3. **IS ESS tuning.** Aggregate tempering is conservative (wider bands than full IS). Acceptable for now.

4. **Legacy resolver call site migration.** v2-only call sites. Retire with v2.

5. **v3 engine generalisation.** v3 currently delegates to `compute_forecast_trajectory` which reimplements v2's loop. The long-term goal (doc 29) is a single engine that naturally degenerates across all cases. The span-widening approach shows the path: one loop, different CDF/carrier inputs.

---

## Codepath Divergence Analysis (16-Apr-26)

### The problem

The generalised forecast engine was designed so that all consumers
(edge display, surprise gauge, cohort maturity chart) draw from a
**single set of engine primitives**. Cohort maturity v3 is the
reference consumer: it exercises the full forecast pipeline end-to-end.
If the graph's edge display uses a different codepath to compute the
same quantities, the two will drift — the chart shows one number, the
edge shows another.

Today there are **two parallel forecast pipelines** in
`forecast_state.py`, sharing some primitives but structurally
independent:

### Pipeline A: `compute_forecast_summary` (topo pass)

Called by `handle_stats_topo_pass` (api_handlers.py:4867). Produces
scalar forecasts written to graph fields (completeness,
completeness_stdev, blended_mean, p_sd).

### Pipeline B: `compute_forecast_trajectory` (chart)

Called by `compute_cohort_maturity_rows_v3` (cohort_forecast_v3.py:331).
Produces per-τ MC rate draws for chart fan bands.

### Shared primitives

| Primitive | Pipeline A | Pipeline B |
|-----------|-----------|-----------|
| `_compute_completeness_at_age` | Yes (MC draws + E_i) | Yes (CDF array construction) |
| `_convolve_completeness_at_age` | Yes (cohort mode completeness) | No (uses `upstream_cdf_mc` directly) |
| `_compose_rate_sd` | Yes (rate SD composition) | No (not applicable — returns raw draws) |
| `resolve_model_params` | Yes (called by handler) | Yes (called by v3) |
| `build_node_arrival_cache` | Yes (topo pass) | No (carrier built by handler from v2 `build_upstream_carrier`) |

### Divergent implementations

| Computation | Pipeline A (topo pass) | Pipeline B (chart) |
|-------------|----------------------|-------------------|
| **MC draw generation** | Independent Normal draws for mu, onset (with correlation); separate Beta draw for p | Multivariate normal for (p, mu, sigma, onset) with full covariance. Or pre-computed `mc_span_cdfs` draws when span kernel provided. |
| **IS conditioning** | Aggregate across all cohorts simultaneously. Single tempered resampling pass. ESS target ≥ 20 via bisection. Path-level CDF for E_i. | Per-cohort sequential resampling. No tempering. Unconditional resampling whenever `E_fail ≥ 1`. Edge-level deterministic CDF for E_i. |
| **Completeness** | Explicit: `mean(weighted_completeness_draws)` post-IS. Path-level (with carrier convolution). | Implicit in Pop D/Pop C dynamics. No explicit completeness output. |
| **Rate semantics** | Posterior edge probability: `mean(p_draws)` after IS. NOT `p × completeness`. | Population aggregate: `Y_total / X_total` across cohorts and draws. Includes observed evidence splice. |
| **Pop D / Pop C** | Not present. | Full binomial sampling of frontier survivors + upstream post-frontier arrivals. |
| **Upstream carrier** | `build_node_arrival_cache` (topo-order walk, `read_edge_cohort_params`, `build_upstream_carrier` with no cohort list and no upstream obs). | Handler-constructed `XProvider` + `build_upstream_carrier` with real cohort list and upstream observations (Tier 2 empirical). |
| **Drift** | None. | Per-cohort logit-space drift (20% of posterior variance). |

### Consequences of divergence

1. **Completeness drift.** The topo pass computes completeness via
   path-level MC draws with aggregate IS tempering. The chart computes
   an implicit completeness via the Pop D/Pop C population model with
   per-cohort sequential IS. These are mathematically different
   quantities. The edge chevron can show a different completeness from
   what the chart trajectory implies at τ_observed.

2. **Rate drift.** The topo pass writes `blended_mean = mean(p_draws)`
   (posterior edge probability after IS). The chart's `midpoint` is
   `median(Y_total / X_total)` (population-level aggregate with
   evidence splice). For immature cohorts these diverge: the topo
   pass rate is asymptotic (completeness-unaware), while the chart
   rate accounts for maturity.

3. **IS conditioning discrepancy.** Aggregate tempered IS (topo pass)
   and per-cohort sequential IS (chart) produce systematically
   different posterior draws. The chart's sequential IS is more
   aggressive (each cohort resamples independently → effective
   tempering compounds). The topo pass's tempered IS is more
   conservative (wider bands, ESS-controlled).

4. **Carrier fidelity.** The topo pass builds the node arrival cache
   without upstream observations and without a cohort list — it gets
   Tier 3 (weak prior) carriers. The chart handler fetches real
   upstream snapshot data and builds the carrier with empirical
   observations — it gets Tier 2 carriers. Upstream-aware completeness
   from the topo pass is less informed than from the chart.

### What this means for users

A user opens a graph, sees edge completeness 65% and blended rate 0.32
from the topo pass. They open the cohort maturity chart for the same
edge and see the trajectory implies completeness ~70% and rate ~0.35 at
τ_observed. The discrepancy is not a bug — it reflects two different
computations answering similar but not identical questions. But from the
user's perspective, the graph and the chart should agree.

---

## Phase G: Codepath Generalisation Plan

### Principle

There is **one computation**: the per-cohort population model. It
takes a cohort (anchor_day, observed x/y, frontier age), model
params (p, mu, sigma, onset, posterior), upstream carrier, and
produces MC draws of (Y, X) at each τ — the conditioned forecast
of conversion counts.

Every forecast quantity in the app is a **read** from this
computation under one of two coordinate systems, with optional
aggregation:

**Coordinate system A — τ (age-rebased)**:
All cohorts share a common τ axis where τ=0 is each cohort's anchor
date. Used by the cohort maturity chart (sweeps τ from 0 to
max_tau).

**Coordinate system B — date (calendar)**:
Each cohort is evaluated at a single τᵢ = evaluation_date −
anchor_day_i. No shared τ axis. Used by daily conversions
(per-cohort results), graph display (aggregated scalar), and
surprise gauge.

The per-cohort computation is identical in both systems. What
differs is which τ values are evaluated and how results are
aggregated:

| Consumer | Coordinate | Per cohort τ | Aggregation | Output |
|----------|-----------|-------------|-------------|--------|
| Cohort maturity chart | A (τ) | All τ 0..max_tau | Sum Y/X across cohorts per τ, quantiles | rate(τ) curve + fan bands |
| Daily conversions | B (date) | Single τᵢ per cohort | None — per-cohort results | (evidence_y, forecast_y, projected_y, completeness) per anchor_day |
| Graph display (topo pass) | B (date) | Single τᵢ per cohort | n-weighted aggregate across cohorts | Scalar: blended_mean, completeness, p_sd |
| Surprise gauge | B (date) | Single τᵢ per cohort | n-weighted aggregate | Scalar: expected rate vs observed rate |

**Derived quantities are reads from the same draws**:

- `p.mean` (blended_mean) = median(sum_Y / sum_X) across cohorts
  at their own τᵢ values — coordinate B, aggregated
- `completeness` = n-weighted CDF at each cohort's τᵢ — coordinate
  B, aggregated
- `p.infinity` = the same computation at τ → ∞ (or equivalently,
  the asymptotic posterior rate from the draws) — coordinate A at
  the limit
- `forecast_y` per cohort = median(Y_draws[:, τᵢ]) − evidence_y —
  coordinate B, per-cohort
- `midpoint` at chart τ = median(sum_Y / sum_X) — coordinate A,
  aggregated

**One computation, one set of MC draws, one IS conditioning pass.**
This is compute-efficient (no redundant draws or repeated carrier
construction) and minimises the code defect surface area (one
codepath to test and maintain, not parallel implementations per
consumer).

### High-dimensional data and lossy collapse

The MC population model produces per-cohort `(S, T)` arrays:
`Y_cohort_i(S, T)` and `X_cohort_i(S, T)` — 2000 draws × T tau
values, for each cohort *i*.

Coordinate A and coordinate B are **different lossy collapses** of
this high-dimensional object. Neither can be recovered from the
other:

- **Coordinate A collapse** (per-τ, aggregated): sum across cohorts
  first → `Y_total(S, T)`, then collapse draws per τ column →
  `forecast_y(τ) = median(Y_total[:, τ])`. Loses per-cohort
  identity.

- **Coordinate B collapse** (per-cohort, at τᵢ): for each cohort
  *i*, read column τᵢ from `Y_cohort_i(S, T)` → `Y_i_draws(S,)`,
  then collapse draws → `forecast_y_i = median(Y_i_draws)`. Loses
  the τ curve.

Both outputs must be read from the pre-collapsed per-cohort `(S, T)`
arrays. The current sweep only retains coordinate A output
(`Y_total`, `X_total`, `rate_draws`) — it sums per-cohort
contributions and discards the per-cohort arrays.

**G.1 structural requirement**: the loop that calls `_evaluate_cohort`
must retain per-cohort column-τᵢ draws before summing into
`Y_total`. This is not optional — it cannot be reconstructed from
the aggregated output. One loop, one set of draws, two output paths
(A and B) read from the same per-cohort arrays at different points
in the aggregation pipeline.

### What "same codepath" means concretely

`_evaluate_cohort` (extracted in G.0) is the shared primitive. It
takes a single cohort + model draws + IS state, and produces
`(Y_cohort, X_cohort)` as `(S, T)` arrays. Every consumer calls it:

- **Cohort maturity**: calls with full T (all τ), sums across
  cohorts, takes quantiles at each τ column
- **Daily conversions**: calls with full T, reads column τᵢ per
  cohort, reports per-cohort counts
- **Graph display**: calls with full T, reads column τᵢ per cohort,
  aggregates across cohorts into scalar
- **Surprise gauge**: same as graph display, compares against
  observed

The MC draws, drift, IS conditioning, CDF arrays, and carrier are
constructed once per edge (or once per graph in the topo pass).
Each consumer reads from the same draw arrays. No consumer
recomputes the draws independently.

### Why `_compute_det_totals` and `annotate_rows` must go

Today two parallel codepaths compute forecast counts:

1. `_compute_det_totals` in `cohort_forecast_v3.py` — 70-line
   deterministic point-estimate. Produces `forecast_y` / `forecast_x`
   for the cohort maturity chart tooltip.
2. `annotate_rows` in `forecast_application.py` — separate CDF
   evaluation. Produces `completeness`, `projected_y`, `forecast_y`
   for daily conversions.

Both are lower-fidelity reimplementations of what `_evaluate_cohort`
already computes (with MC draws, IS conditioning, drift, Pop D/C).
They can and do diverge from the MC population model — the
multi-hop-narrow case shows a 50% gap between the deterministic
`forecast_y` and the MC median Y.

The target: both consumers read from `_evaluate_cohort`'s output.
`forecast_y = median(Y_draws[:, τ]) - evidence_y`. One computation,
one answer. The 50% divergence is a bug to fix in the MC sweep, not
a reason to keep the deterministic parallel path.

### The daily conversions bug

Daily conversions currently gets `completeness: 0, projected_y: 0,
forecast_y: 0` because `annotate_rows` cannot compute cohort age
(missing `anchor_day` key and `evaluation_date`). This is a wiring
bug, but fixing it by wiring `annotate_rows` correctly would add
another parallel codepath. The right fix is to route daily
conversions through `_evaluate_cohort` — same IS, same population
model, same draws — reading column τᵢ per cohort.

### Sequencing

#### G.0: Refactor the inner loop into a shared primitive

The core insight: a cohort maturity chart and a general graph forecast
run the **same per-cohort population model**. The only difference is
which τ values each cohort contributes at:

- **Chart (cohort maturity)**: every cohort is evaluated at every τ
  from 0 to max_tau. τ is rebased per cohort (τ=0 at anchor date).
  The chart sweeps the shared τ axis.

- **General forecast**: each cohort is evaluated at its own τᵢ
  (its actual age at evaluation date). There is no shared τ axis.
  The output is a single aggregate across cohorts, each at its own
  age.

Both modes need the same per-cohort computation:

1. E_i (effective exposure from obs_x trajectory + det_cdf)
2. Per-cohort drift (logit-space perturbation)
3. IS conditioning (per-cohort resampling)
4. Pop D: frontier survivors via q_late from CDF
5. Pop C: upstream post-frontier arrivals
6. Evidence splice: obs below frontier, forecast above
7. Accumulate Y, X

Today this lives inside `_run_cohort_loop` (forecast_state.py:1283),
which accumulates into `(S, T)` arrays — the full τ grid is baked
into the array shapes. The refactoring extracts the per-cohort
computation so that consumers can choose the τ evaluation mode.

**Status**: DONE (16-Apr-26). `_evaluate_cohort` extracted as a
module-level function in `forecast_state.py`. `_run_cohort_loop`
delegates to it. 17/17 CLI parity, 14/14 Python parity green.

The function signature:

```
_evaluate_cohort(
    cohort, S, T, det_cdf, drift_sds, theta_transformed,
    cdf_arr, upstream_cdf_mc, reach, apply_is, loop_rng, _expit,
) → (Y_cohort(S, T), X_cohort(S, T), is_ess, conditioned) | None
```

Returns `(S, T)` arrays — all τ columns materialised. Consumers
read the columns they need: all columns for cohort maturity
(coordinate A), column τᵢ per cohort for daily conversions and
graph display (coordinate B). Returns None for empty cohorts (no
RNG consumed — matches original `continue` semantics).

**Why this preserves parity**: the existing `_run_cohort_loop` is
unchanged in chart mode — `tau_eval=None` produces byte-identical
output. The v2-v3 parity test gates this: if the refactoring changes
the chart output, the parity test fails. The general forecast mode
(`tau_eval=τᵢ`) runs the same arithmetic on a single column.

`compute_forecast_trajectory` becomes a thin orchestrator that:
1. Draws params (unchanged)
2. Builds CDF array, det_cdf, drift, theta (unchanged)
3. Calls `_evaluate_cohort` per cohort (extracted)
4. Aggregates Y_total / X_total (unchanged)
5. Takes rate = Y_total / X_total (unchanged)

A new `compute_forecast_general` function uses the same orchestrator
preamble (steps 1–2) but calls `_evaluate_cohort` with each cohort's
own `tau_eval=τᵢ`, accumulating `(S, 1)` contributions into scalar
Y_total / X_total.

**Parity invariant**: for the chart mode, calling `_evaluate_cohort`
with `tau_eval=None` and summing must produce output identical to the
current `_run_cohort_loop`. The v2-v3 parity test (`v2-v3-parity-
test.sh`, 17/17 checks) is the acceptance gate. Any regression means
the extraction was wrong.

**Files touched**:
- `forecast_state.py` — extract `_evaluate_cohort`, refactor
  `_run_cohort_loop` to call it, add `compute_forecast_general`

#### G.1: Wire the topo pass to call `compute_forecast_general`

Replace the current `compute_forecast_summary` call in
`handle_stats_topo_pass` (api_handlers.py:4867) with
`compute_forecast_general`.

**Pre-requisite**: the topo pass handler must construct the same
inputs as the v3 chart handler:
- `mc_cdf_arr` / `mc_p_s` from `mc_span_cdfs` (currently only built
  in the chart handler)
- `det_norm_cdf` from edge kernel (currently only built in the chart
  handler)
- `span_alpha` / `span_beta` / `span_mu_sd` etc. from `build_span_params`
  (currently only built in the chart handler)
- `from_node_arrival` with empirical carrier (currently the topo pass
  builds a less informed carrier)

This means extracting the span kernel + carrier construction from the
v3 chart handler into a shared preparation function that both the topo
pass and the chart handler call.

**CohortEvidence construction**: the topo pass receives per-cohort
`(date, age, n, k)` from the FE. Converting to `CohortEvidence`
is straightforward: `x_frozen=n, y_frozen=k, frontier_age=age,
a_pop=n`. The obs_x/obs_y trajectory arrays can be left minimal
(single-point: `[n]` and `[k]`) — the per-cohort loop degrades
gracefully (E_i falls back to N_i, IS still fires from k/n).

Snapshot data is never *required*. It *improves* the forecast in
two ways: (a) per-τ obs_x trajectories give a more precise E_i for
IS conditioning, and (b) upstream observations promote the carrier
from Tier 3 to Tier 2. Both are "condition where available"
improvements, not prerequisites. The engine must produce a valid
forecast from model params alone — snapshot data narrows the bands.

**Files touched**:
- `forecast_state.py` — `compute_forecast_general` (from G.0)
- `api_handlers.py` — `handle_stats_topo_pass` calls new function
- New shared module or functions for span kernel + carrier preparation

#### G.2: Improve carrier fidelity (optional, not blocking)

G.1 can land without this. The topo pass will produce valid forecasts
using whatever carrier is available — Tier 3 (weak prior) from model
params alone. G.2 improves the carrier to Tier 2 (empirical) by
fetching upstream snapshot data, narrowing the bands to match the
chart's quality.

The topo pass currently calls `build_node_arrival_cache` which calls
`build_upstream_carrier` with no cohort list and no upstream
observations (Tier 3). The chart handler calls `build_upstream_carrier`
with real cohort list and upstream observations (Tier 2).

Unify by having the topo pass handler fetch upstream observations
(same as the chart handler's `_fetch_upstream_observations`). The BE
already has the fetching infrastructure
(`_fetch_upstream_observations` exists as a shared function).

**Files touched**:
- `api_handlers.py` — topo pass handler calls
  `_fetch_upstream_observations` per edge
- Possibly `snapshot_service.py` — if query needs adjustment for
  topo pass context

**Performance note**: fetching upstream observations per edge in the
topo pass adds DB queries. For a 10-edge graph this might add
~200ms. Acceptable for the initial implementation; cacheable later
(upstream obs are shared across edges with the same from-node).

**Graceful degradation principle**: snapshot data is never a
prerequisite. The engine produces a valid forecast from model params
alone. Snapshot data conditions the forecast where available:
- Per-τ obs_x trajectories → better E_i for IS → narrower bands
- Upstream observations → Tier 2 carrier → better upstream-aware
  completeness
- Neither → Tier 3 carrier + scalar E_i fallback → wider but valid
  bands

#### G.3: Retire dead code — DONE 16-Apr-26

Removed:
- `compute_forecast_state_window` (~105 lines)
- `compute_forecast_state_cohort` (~190 lines)
- `_compute_weighted_completeness_sd` (~16 lines)
- `test_forecast_state_window.py` (236 lines — entire file)
- `TestCohortModeForecastState` and `TestPhase3ParityEnrichedSynth`
  test classes (~300 lines)

Retained:
- `compute_forecast_summary` — still used by surprise gauge
- `_convolve_completeness_at_age` — used by the above
- `_compose_rate_sd` — utility, may be needed later

#### G.4: Retire parallel forecast count computations

Two parallel codepaths produce forecast counts independently of the
MC population model:

1. `_compute_det_totals` in `cohort_forecast_v3.py` (~70 lines) —
   deterministic Pop D + Pop C for `forecast_y`/`forecast_x` in the
   cohort maturity chart tooltip. This is coordinate system A
   (per-τ, aggregated across cohorts) reimplemented as a point
   estimate instead of reading from the MC draws.

2. `annotate_rows` in `forecast_application.py` — separate CDF
   evaluation for `completeness`, `projected_y`, `forecast_y` in
   daily conversions. This is coordinate system B (per-cohort at
   each cohort's own τ) reimplemented as a separate CDF evaluation.

Both should read from `_evaluate_cohort`'s output instead:

- `_compute_det_totals` → `forecast_y(τ) = median(Σ_cohorts
  Y_draws[:, τ])`, `forecast_x(τ) = median(Σ_cohorts X_draws[:,
  τ])`. Coordinate A, aggregated, read from the sweep's existing
  Y_total / X_total arrays. The sweep already accumulates these —
  `det_y_total` and `det_x_total` are the median across draws.

- `annotate_rows` → per-cohort: `completeness = CDF(τᵢ)`,
  `projected_y = median(Y_draws[:, τᵢ])`. Coordinate B, per-cohort,
  read from `_evaluate_cohort` at column τᵢ.

**Prerequisite**: the MC sweep's Pop C uses `from_node_arrival.mc_cdf`
(built by `build_upstream_carrier` in the v3 handler) while
`_compute_det_totals` uses `upstream_path_cdf_arr` (built from a
separate carrier construction in v3). For multi-hop-narrow, the MC
carrier produces small Pop C growth (Y: 9→9.8) while the
deterministic carrier produces large growth (Y: 14→29). The
carriers differ because they're built from different inputs
(different reach, different tier). Root cause (16-Apr-26): two
parallel carrier constructions within v3 — same class of problem
as the topo pass divergence. Fix: ensure the MC sweep and the
deterministic computation use the same carrier. This likely means
passing `upstream_path_cdf_arr` into the sweep as the Pop C
carrier, or consolidating carrier construction into a single path.

**Sequencing**: fix the MC bug first, then replace both parallel
paths with reads from the sweep. This also fixes the daily
conversions bug (missing completeness/forecast_y) by routing it
through the engine rather than patching `annotate_rows`.

**Files touched** (after MC bug fix):
- `cohort_forecast_v3.py` — remove `_compute_det_totals`, read
  `forecast_y`/`forecast_x` from `sweep.det_y_total` /
  `sweep.det_x_total`
- `forecast_application.py` — `annotate_rows` becomes a thin
  wrapper that reads from engine output when available
- `api_handlers.py` — daily conversions annotation path routes
  through engine

#### G.5: Centralise evidence aggregation

v3's evidence aggregation (cohort_at_tau loop, evidence_by_tau
construction, `_compute_evidence_at_tau`) is ~100 lines of v3-local
code. Daily conversions has its own evidence aggregation in
`derive_daily_conversions`. The topo pass reads evidence from the
FE's cohort_data.

All three should read observed (x, y) from the same `CohortEvidence`
objects that feed `_evaluate_cohort`. The evidence is already there
(obs_x, obs_y arrays). Aggregation is a coordinate-system choice:
per-τ for cohort maturity (A), per-cohort for daily conversions (B),
n-weighted for graph display (B).

Lower priority — evidence aggregation doesn't involve the MC draws
or IS conditioning, so the defect surface is smaller. But it's still
duplicated logic across three consumers.

### Dependency graph

```
G.0 (extract _evaluate_cohort)              ✅ DONE
  │
  ├── G.1 (wire topo pass — coord B)       ✅ DONE
  │
  ├── G.1b (wire daily conversions — coord B, per-cohort)  ✅ DONE
  │
  ├── G.2 (improve carrier fidelity)       ← independent, not blocking
  │
  ├── G.3 (retire dead code)               ✅ DONE
  │
  ├── G.4 (retire _compute_det_totals + annotate_rows)
  │     └── prerequisite: D19 (det/MC Pop C divergence)
  │
  ├── D20 (weak prior fix)                 ✅ FIXED
  │
  └── G.5 (centralise evidence aggregation) ← lowest priority
```

### Parity invariants (acceptance criteria)

These are ordered by rigour. Each gate must pass before proceeding.

1. **v2-v3 parity regression gate (BLOCKING)**: the existing CLI
   parity test (`v2-v3-parity-test.sh`, 17/17 checks) must stay
   green after G.0. This is the primary safety net. The refactoring
   of `_run_cohort_loop` into `_evaluate_cohort` calls must produce
   byte-identical `rate_draws` in chart mode. If any check regresses,
   the extraction is wrong — not the test.

2. **Same-primitive guarantee**: a code audit confirms that both
   `compute_forecast_trajectory` (chart) and `compute_forecast_general`
   (topo pass) call the same `_evaluate_cohort` function — not
   parallel implementations. The two differ only in τ evaluation
   mode (all-τ vs per-cohort-τ).

3. **Chart-graph agreement**: for any edge, the topo pass's
   `blended_mean` must equal `median(rate_draws[:, τ_observed])`
   from a chart sweep on the same edge with the same inputs, within
   MC variance tolerance (< 2%). Test by running both computations
   on the synth graph and comparing.

4. **Carrier parity**: the topo pass's upstream carrier reaches the
   same tier (Tier 1/2/3) as the chart's carrier for the same edge.
   Verified by comparing session log `[v3] carrier: tier=` output
   between chart and topo pass.

5. **IS parity**: the topo pass uses the same per-cohort sequential
   IS conditioning strategy as the chart. No aggregate IS vs
   sequential IS divergence. Verified by comparing `is_ess` and
   `n_cohorts_conditioned` between chart and topo pass.

6. **No FE→BE regression**: session log FE→BE parity per edge stays
   within existing tolerance after G.1.
