# Handover: Posterior Predictive Fan Chart — Bugs, Architecture, Epoch Unification

**Date**: 2-Apr-26
**Branch**: `feature/snapshot-db-phase0`
**Session context**: Long session covering bug fixes, architectural redesign of the MC fan from importance sampling to posterior predictive, per-cohort drift layer, and identification of the epoch-splitting problem. Multiple user corrections steered away from wrong diagnoses toward the real root causes.

---

## Objective

The cohort maturity fan chart must show a **posterior predictive interval** answering "with 90% confidence, where will this group of cohorts land?" This requires parameter uncertainty (from the Bayesian fit), per-cohort drift (real cohorts vary in p, mu, sigma, onset), and Binomial sampling noise.

The fan must:
- Degenerate to the model's unconditional predictive band at zero maturity
- Narrow progressively as evidence accumulates
- Be computed in a **single pass over all cohorts** regardless of epoch boundaries
- Use the same simulator for both the "model band" and the "conditioned fan"

An agreed multi-phase design is partially implemented (Phases 1-2 done, Phases 3-5 remain).

---

## Current State

### DONE — Bug fixes

- **`x_at_frontier` typo** in `cohort_forecast.py:888`. Diagnostic block referenced nonexistent `x_at_frontier` instead of `x_frontier`. The `NameError` crashed the entire cohort-mode MC computation, silently swallowed by `except Exception` in `api_handlers.py:1699`. Fan rendered without bands. Fix: `x_at_frontier` → `x_frontier`.

- **ISO date parsing in `resolveAsatPosterior`** in `posteriorSliceResolution.ts:280,293`. Used `parseUKDate()` which only handles `d-MMM-yy`. But `fitted_at` on posterior slices is ISO format (`2026-03-31T18:49:03Z`). Every `parseUKDate` call threw silently, every fit_history entry was skipped, `resolveAsatPosterior` returned undefined, and `reprojectPosteriorForDsl` (line 49-50) cleared `edge.p.latency.posterior` from the graph sent to the Python API. Fix: new `parseDateToMidnightMs()` in `posteriorSliceResolution.ts` handles both UK and ISO formats, truncating to UTC midnight for day-level comparison. **This was the root cause of "no Bayesian SDs reaching the Python API."** The user had to correct the agent multiple times before this was found — the agent initially blamed FE graph serialisation, then the MC gate, before the user pointed at the Python logs showing the data WAS on the edge.

- **x-base mismatch in y forecast** in `cohort_forecast.py` (MC path ~line 917, deterministic midpoint ~line 1015). The y projection used `x_frontier` (frozen at cohort's tau_max) but the denominator used `x_at_tau` (model-derived, grows via upstream path CDF in cohort mode). This structurally suppressed rate below the model curve. Fix: both paths now use `x_forecast_arr`. Rate degenerates correctly to `p × CDF` at zero maturity.

### DONE — Phase 1: Direct posterior draws (no importance sampling)

- **Removed all importance sampling.** The MVN parameters on the edge are the POSTERIOR from the NUTS fit — they already incorporate evidence. The IS was double-counting by conditioning on the same evidence again. This caused ESS collapse: ESS=1/2000 for window mode with N=1566. A two-pass proposal-based IS was attempted and improved ESS to 53, but the fan was still too narrow because the conceptual error remained. The user diagnosed this as "the bands are wildly narrow — that's not right" and pushed until the double-counting was identified. Fix: direct `rng.multivariate_normal(theta_mean, posterior_cov, size=S)` draw, no reweighting.

- **Added Binomial predictive sampling** per cohort per MC draw. `y = k + Binomial(x_int, remaining_cdf × p)` replaces the deterministic `y = k + x × remaining_cdf × p`. This is the correct posterior predictive object for "where will this cohort land?"

### DONE — Phase 2: Per-cohort drift layer

- **Diagonal drift on transformed scales** for each immature cohort. Per MC draw, each cohort gets drifted (p, mu, sigma, onset) via: draw global θ from posterior MVN, draw δ_i from N(0, Σ_drift), compute θ_i = θ + δ_i on (logit-p, mu, log-sigma, log1p-onset) scales, transform back. CDF is recomputed per-cohort with drifted params. `DRIFT_FRACTION = 0.50` (50% of posterior variance on transformed scale). In `cohort_forecast.py` ~lines 798-860.

### DONE — Test updates

- `test_fan_equals_confidence_band_at_zero_maturity`: fan must be >= confidence band (not equal — fan includes Binomial noise the band doesn't). Asserts fan envelops band and isn't absurdly wider.
- `test_fan_narrows_with_evidence`: compares evidence fan width to zero-evidence fan width. Allows 25% excess for multi-cohort Binomial mixing effects.
- All 36 tests pass.

### IN PROGRESS — FE epoch dedup (stopgap)

- Added tau_days dedup in `graphComputeClient.ts` ~line 552. When multiple epoch blocks produce rows at the same tau, keeps the one with highest `cohorts_expected`. This is a **stopgap** — the user wants the real fix (single-loop computation, see Next Steps).

### NOT STARTED — Epoch unification (single-loop computation)

- The user's clear instruction: "epochs are a useful convention for discussion; they shouldn't shape the code flow, which should handle epoch transitions per cohort/tau as part of the logical conditionality." Currently `api_handlers.py` sends separate snapshot queries per epoch, calls `compute_cohort_maturity_rows` per epoch, and the FE stitches the results — creating overlap/zigzag at epoch boundaries. The fix is to gather all cohorts into one call.

### NOT STARTED — Phases 3-5

- Phase 3: Per-cohort IS conditioning on frontier evidence
- Phase 4: Stochastic x in cohort mode
- Phase 5: Unified simulator replacing `confidence_bands.py`

---

## Key Decisions & Rationale

### 1. Importance sampling was double-counting — removed entirely

**What**: All IS code (pilot draws, proposal construction, likelihood computation, resampling, scipy dependency) replaced with direct posterior MVN draw.

**Why**: Edge vars (means, SDs from NUTS fit) ARE the posterior. IS conditioned on the same evidence again, causing ESS=1 for window mode. A two-pass proposal IS improved ESS to 53 but bands were still too narrow — the double-counting was conceptual, not algorithmic. The user pushed hard on this: "the bands are wildly narrow for both window and cohort — collapsing to a singularity, which is just wrong."

**Where**: `cohort_forecast.py` ~lines 746-800. Former IS block replaced with `rng.multivariate_normal(theta_mean, posterior_cov, size=S)`.

### 2. Binomial predictive sampling, not deterministic y forecast

**What**: Each MC draw computes `y = k + Binomial(x, remaining_cdf × p)`.

**Why**: The chart answers "where will this group land?" — a prediction interval, not a confidence interval. The user specified this explicitly and asked about Binomial vs Beta-Binomial vs Poisson-Binomial. Answer: Binomial per-draw is correct; the marginal across p draws IS Beta-Binomial; the aggregate across cohorts with different rates IS Poisson-Binomial. Implementation as per-cohort Binomial + summation is exact. A Normal approximation was tried and reverted — it produced smooth curves but is not mathematically identical at small x.

**Where**: `cohort_forecast.py` ~lines 870-880. `rng.binomial(x_int, conv_prob)`.

### 3. Per-cohort drift on all four parameters, not just p

**What**: Hierarchical drift on (logit-p, mu, log-sigma, log1p-onset) per cohort.

**Why**: The user provided a detailed design analysis: Beta-Binomial alone (drift on p only) misses latency shape drift between cohorts. Real cohorts vary in onset, mu, sigma (different days of week, traffic quality). The drift layer is the "borrowing mechanism" — strongly shrunk (50% of posterior var) defaults to the global posterior but allows per-cohort deviation. Full design document was discussed covering: NUTS draw preservation (parked — MVN sufficient), commensurate priors (parked — drift prior serves same purpose), unified simulator (Phase 5).

**Where**: `cohort_forecast.py` ~lines 798-860. `DRIFT_FRACTION = 0.50`. Transforms via `scipy.special.logit/expit`.

### 4. Epochs should not shape the compute flow

**What**: The user's clear instruction: a single call to `compute_cohort_maturity_rows` with ALL cohorts, handling epoch transitions (solid/immature boundary) per cohort as logical conditionality within the loop.

**Why**: Current architecture sends separate snapshot queries per epoch, calls `compute_cohort_maturity_rows` per epoch, then stitches in the FE. This creates overlapping tau ranges between epochs, causing zigzag artifacts in the fan polygon. With 2 epochs both producing rows at tau=17, the FE draws conflicting fan bounds. The stopgap FE dedup helps but is architecturally wrong.

**Where**: The change spans `api_handlers.py` (epoch orchestration), `compute_cohort_maturity_rows` (already handles mixed-maturity cohorts per tau), and `graphComputeClient.ts` (epoch stitching).

### 5. Fan is wider than the confidence band — by design

**What**: The degeneration test allows fan >= confidence band at zero maturity.

**Why**: Fan is posterior predictive (parameter uncertainty + sampling noise). Confidence band is parameter-only. The fan is always wider. The user agreed this is correct: the zero-evidence degeneration target should be the unconditional predictive band, not the confidence band. Phase 5 will unify them.

---

## Discoveries & Gotchas

### `parseUKDate` silently fails on ISO timestamps

`parseUKDate()` in `dateFormat.ts` only handles `d-MMM-yy`. ISO strings (used by `fitted_at`) cause it to throw. Every caller wraps in try/catch that silently swallows. This caused `resolveAsatPosterior` to clear the posterior on every query. The failure was completely silent — no console warnings, no error logs. The agent spent significant time chasing FE graph serialisation before the user forced focus on the Python logs, which showed `edge_mu_sd=0.0` despite the edge having full Bayesian data.

### The `except Exception` in `api_handlers.py:1699` hides crashes

When `compute_cohort_maturity_rows` throws (e.g. NameError), the handler prints the error and continues to a fallback path producing rows without fan data. The chart renders "normally" without bands. This made the `x_at_frontier` crash invisible.

### Epoch overlap produces zigzag fan artifacts

Each epoch's `compute_cohort_maturity_rows` emits rows for tau=0 to max_tau. When two epochs have overlapping tau ranges (different anchor_from, same sweep_to), both produce rows at the same tau with different fan bounds. The FE pushes all rows into one array without dedup, causing the fan polygon to zigzag between epoch values. A stopgap dedup was added but the real fix is single-loop computation.

### The deterministic midpoint is a separate code path

`cohort_forecast.py` ~line 994 computes midpoint using per-cohort `posterior_rate = (alpha_0 + y) / (alpha_0 + beta_0 + n_eff)`. This is NOT derived from the MC draws. Both the MC path and the midpoint path needed the x-base fix independently. The midpoint does NOT yet use drift — it uses the global posterior rate. This may need alignment in future.

### `DRIFT_FRACTION` tuning

Started at 0.20 (fan barely wider). Bumped to 0.50 (visible but user said "a bit wider, not much"). The user didn't push for higher — the real width issue is the epoch overlap and the missing Phase 3 (per-cohort IS conditioning). The drift fraction may need further tuning on real data.

### `?nocache=1` URL param

The code checks for `nocache` (no hyphen) at `graphComputeClient.ts:242`. The user tried `?no-cache=1` which doesn't match. The user also tried `&nocache=1` (missing `?`) which breaks the URL. This caused confusion during debugging. The param only bypasses the `graphComputeClient` cache, not the compute signature dedup in `useCanvasAnalysisCompute`.

---

## Relevant Files

### Backend
- **`graph-editor/lib/runner/cohort_forecast.py`** — Core MC fan. Key areas: ~line 746 (posterior MVN draw), ~line 798 (drift layer), ~line 870 (Binomial predictive per cohort), ~line 888 (x_frontier diagnostic fix), ~line 994 (deterministic midpoint with x-base fix), ~line 970 (row emission loop). `DRIFT_FRACTION` at ~line 803.
- **`graph-editor/lib/api_handlers.py`** — `_handle_snapshot_analyze_subjects` orchestrates per-epoch calls. `_read_edge_model_params` extracts posterior SDs. The `except` at line 1699 swallows compute failures. **This is where epoch unification needs to happen.**
- **`graph-editor/lib/runner/confidence_bands.py`** — `compute_confidence_band()` — parameter-only band. Will be replaced by unified simulator (Phase 5).

### Frontend
- **`graph-editor/src/services/posteriorSliceResolution.ts`** — `parseDateToMidnightMs` fix, `resolveAsatPosterior`, `projectLatencyPosterior`.
- **`graph-editor/src/services/analysisComputePreparationService.ts`** — `reprojectPosteriorForDsl` mutates graph before API. Clears posterior when `resolveAsatPosterior` returns undefined.
- **`graph-editor/src/lib/graphComputeClient.ts`** — Epoch stitching ~line 547. Stopgap tau dedup added. `nocache` param at line 242.
- **`graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts`** — Fan polygon rendering ~line 306. `smooth: false` on the polygon shape (line 322). `fan_debug` console log at line 279.

### Tests
- **`graph-editor/lib/tests/test_cohort_forecast.py`** — `TestWindowZeroMaturityDegeneration` with updated assertions. All 36 tests pass.

### Docs
- **`docs/current/project-bayes/cohort-maturity/INDEX.md`** — Needs updating with this session's changes (still describes the removed IS approach).

---

## Next Steps

### 1. Epoch unification — single-loop computation (PRIORITY)

This is the user's explicit next instruction: "fix this properly."

**What**: Gather all cohort frames from all epochs into a single list and call `compute_cohort_maturity_rows` once with the full set. Each cohort carries its own tau_max (maturity level). The per-cohort loop already handles mixed maturity — mature cohorts use observed data, immature ones use Binomial forecast. No architectural change needed inside `compute_cohort_maturity_rows` itself.

**Where to change**:
- `api_handlers.py` — the epoch orchestration in `_handle_snapshot_analyze_subjects` (~line 1179-1700). Currently loops over epoch-specific snapshot subjects, calls `compute_cohort_maturity_rows` per epoch. Needs to: (a) collect frames from ALL epoch queries into one list, (b) call `compute_cohort_maturity_rows` once, (c) emit one set of maturity_rows.
- `graphComputeClient.ts` — the stopgap tau dedup (~line 552) can be simplified once there's one block per subject instead of multiple epoch blocks.

**Risks**: The snapshot queries are per-epoch (different anchor_from/to per epoch). The frames from different epochs may have different date ranges. `compute_cohort_maturity_rows` derives cohort_list from frames — it needs all frames in one call. Check that frame merging handles the epoch gap correctly (gap epochs have 0 rows).

### 2. Phase 3: Per-cohort IS conditioning on frontier evidence

After epoch unification, add per-cohort importance weighting. For each cohort, condition its drifted θ_i on its frontier evidence (k_i, N_i at tau_max_i). This is tractable because per-cohort evidence is small (N=10-50), unlike the global IS that collapsed at N=1566. Implementation: inside the per-cohort loop, compute Binomial log-likelihood of (k_i, N_i) under each draw's θ_i, importance-weight, resample within that cohort's draws.

### 3. Phase 4: Stochastic x in cohort mode

Make `x_forecast_arr` vary per MC draw. Currently `x_at_tau = a_pop × reach × CDF_path(τ)` is deterministic. With per-draw upstream (mu, sigma, onset), x should vary too.

### 4. Phase 5: Unified simulator

Replace `confidence_bands.py` with the same posterior predictive engine. Zero-evidence output = model band. Makes degeneration exact by construction.

### 5. Update INDEX.md

`docs/current/project-bayes/cohort-maturity/INDEX.md` is stale — describes the removed IS approach and lists §8.1 as the priority. Update to reflect Phase 1-2 completion, the epoch unification priority, and the agreed multi-phase design.

---

## Open Questions

### Blocking

- **Epoch frame merging**: When unifying epochs into a single call, how should frames from different epoch queries be merged? Each epoch query returns frames for its anchor range. Do we concatenate them? Do overlapping snapshot_dates need dedup? This needs investigation in `derive_cohort_maturity` and the snapshot query logic before implementing.

### Non-blocking

- **DRIFT_FRACTION tuning**: Currently 0.50. May need tuning on real data. Could be made configurable via display_settings.
- **Deterministic midpoint alignment with MC**: The midpoint uses global posterior_rate without drift. Should it use the median of the MC draws instead? Currently the midpoint line and fan median can diverge.
- **ECharts polygon smoothing**: `smooth: false` on the fan polygon. The user asked for smoothing but it created wave artifacts on the zigzag. Once the zigzag is fixed (epoch unification), smoothing could be revisited. Currently reverted to `smooth: false`.
- **`confidence_bands.py` retirement**: Phase 5 replaces it. Until then, the confidence band and fan have different semantics. The FE renders both.
