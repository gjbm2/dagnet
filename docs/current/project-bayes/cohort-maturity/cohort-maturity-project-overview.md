# Cohort Maturity Chart — Complete Project Overview

**Date**: 31-Mar-26
**Branch**: `feature/snapshot-db-phase0`
**Status**: Phase 1a (single Cohort, window mode) working. Phase 1b (multi-Cohort)
has two open bugs. Phase 2 (cohort mode) not started. Test harness not yet built.

---

## 1. What the Cohort Maturity Chart Is

The cohort maturity chart is the primary visualisation for understanding how
conversion rates evolve with age. It plots **conversion rate (y/x)** on the
y-axis against **age in days (τ)** on the x-axis.

A **Cohort** (always capital C) is one `anchor_day`'s worth of users — everyone
who entered at the from-node on a particular date.

The chart answers: "Given what we've observed so far, what do we expect the
final conversion rate to be, and how uncertain are we?"

### 1.1 The three epochs

At any given observation date (`sweep_to`), each Cohort has a maximum observed
age `tau_max = sweep_to − anchor_day`. Beyond that age, the Cohort is
**immature** — we must forecast.

| Epoch | τ range | What's happening |
|-------|---------|-----------------|
| **A** | `0 .. tau_solid_max` | ALL Cohorts in the group are mature. Pure evidence. |
| **B** | `tau_solid_max+1 .. tau_future_max` | SOME Cohorts are immature. Mixed evidence + forecast. |
| **C** | `> tau_future_max` | ALL Cohorts are immature. Pure forecast. |

Where:
- `tau_solid_max = sweep_to − anchor_to`
- `tau_future_max = sweep_to − anchor_from`

For a single Cohort, epoch B has zero width (A jumps directly to C).

### 1.2 Visual elements

| Element | Line style | When shown | What it means |
|---------|-----------|------------|---------------|
| **Evidence** | Solid | Epoch A | Observed y/x, all Cohorts present |
| **Evidence** | Dashed | Epoch B | Observed y/x, only mature Cohorts |
| **Midpoint** | Dotted | Epochs B+C | Best estimate: evidence + model forecast for immature |
| **Fan** | Filled polygon | Epochs B+C | Uncertainty band around midpoint |

Each scenario gets its own fan in its own colour. Model overlay curves
(analytic, Bayesian) default to off (`show_model_promoted: false`).

### 1.3 window() vs cohort() mode

- **window() mode** (Phase 1): `x` is fixed per Cohort — it's the count of
  people who converted at the from-node within the window. Simpler maths.
  `midpoint ≥ evidence` is guaranteed.

- **cohort() mode** (Phase 2, not yet implemented): `x` grows with τ — more
  members of the Cohort are still arriving upstream. Requires upstream x
  forecasting. The `midpoint ≥ evidence` guarantee breaks (see spec §10.5).

---

## 2. The Full Data Pipeline

### 2.1 End-to-end flow

```
Snapshot DB (PostgreSQL)
  │
  │  query_snapshots_for_sweep() — fetches raw rows per anchor_day per retrieval_date
  ▼
derive_cohort_maturity()  [cohort_maturity_derivation.py]
  │  Groups rows by (anchor_day, slice_key), builds daily grid,
  │  computes virtual snapshot at each date. Outputs frames[].
  ▼
annotate_rows()  [forecast_application.py]
  │  Adds completeness, layer, evidence_y, forecast_y, projected_y
  │  per data_point using model CDF.
  ▼
_read_edge_model_params()  [api_handlers.py:672]
  │  Extracts mu, sigma, onset, p, SDs, correlations from graph edge.
  │  Reads posterior, forecast, model_vars, evidence.retrieved_at.
  ▼
compute_cohort_maturity_rows()  [cohort_forecast.py:188]
  │  The core function. Takes frames + edge_params + dates.
  │  Produces per-τ rows with rate, midpoint, fan_upper, fan_lower.
  │  ALL the maths happens here.
  ▼
result['maturity_rows'] = rows  [api_handlers.py:1538]
  │
  │  POST /api/runner/analyze response
  ▼
graphComputeClient.ts  [line 537]
  │  Reads block.result.maturity_rows from ALL matching blocks.
  │  Collects rows from all epoch blocks (epoch stitching).
  │  Adds scenario_id, subject_id. NO computation.
  ▼
cohortComparisonBuilders.ts  [buildCohortMaturityEChartsOption()]
  │  Parses rows → RowPoint objects.
  │  Extracts per-scenario epoch boundaries from row data.
  │  Builds ECharts series: solid, dashed, dotted, fan polygon.
  ▼
ECharts renders the chart
```

### 2.2 Epoch stitching

The FE splits long queries into multiple epoch subjects
(`subject_id::epoch:0`, `::epoch:1`, etc.), each with its own sweep range.
The BE processes each independently. The FE then:
1. Strips `::epoch:N` from subject IDs
2. Collects `maturity_rows` from ALL matching blocks (`blocks.filter()`,
   not `blocks.find()`)
3. Merges into one data array sorted by τ

---

## 3. Every File in the Pipeline

### 3.1 Python BE — Data Retrieval

**`graph-editor/lib/api_handlers.py`** (~1600 lines)

The orchestrator. `_handle_snapshot_analyze_subjects()` (line 615) processes
each scenario's snapshot subjects:

1. Calls `query_snapshots_for_sweep()` to fetch raw rows from snapshot DB
2. Calls `derive_cohort_maturity()` to build frames
3. Calls `annotate_rows()` to add forecast annotations
4. Calls `_read_edge_model_params()` (line 672) to extract Bayes params
5. Builds per-source model CDF curves + confidence bands (lines 1384–1513)
6. Calls `compute_cohort_maturity_rows()` (line 1524) for per-τ rows
7. Attaches `result['maturity_rows']` (line 1538)

Key function: `_read_edge_model_params(graph, target_id)` (line 672)
- Reads from `edge.p.latency.posterior` (MCMC) or `edge.p.latency` (flat)
- Extracts: mu, sigma, onset, forecast_mean, posterior_p (from alpha/beta),
  p_stdev, t95, path-level params, per-source model vars
- Extracts `evidence.retrieved_at` for `tau_observed` in fan chart (line 712)
- Extracts Bayesian uncertainty (mu_sd, sigma_sd, onset_sd) from model_vars
- Returns `model_params` dict used by all downstream computation

### 3.2 Python BE — Frame Derivation

**`graph-editor/lib/runner/cohort_maturity_derivation.py`** (300 lines)

`derive_cohort_maturity(rows, sweep_from, sweep_to)` (line 37):
- Input: raw snapshot rows from `query_snapshots_for_sweep()`
- Groups by `(anchor_day, slice_key)` — one series per group
- Normalises slice keys via `normalise_slice_key_for_matching()`
- Builds daily grid from `sweep_from` to `sweep_to`
- For each calendar day, computes virtual snapshot: latest y per Cohort as-of
  that date (carry-forward between retrievals)
- Output: `{"frames": [...], "anchor_range": {...}, "sweep_range": {...}}`

Each frame:
```python
{
    "as_at_date": "2026-01-05",
    "data_points": [
        {"anchor_day": "2026-01-01", "y": 42, "x": 100, "a": 100, "rate": 0.42},
        ...
    ],
    "total_y": 42,
}
```

### 3.3 Python BE — Forecast Annotation

**`graph-editor/lib/runner/forecast_application.py`**

`annotate_rows(rows, mu, sigma, onset_delta_days, forecast_mean)` (line 134):
- For each data point, computes `completeness = CDF(τ, mu, sigma, onset)`
- Classifies layer: `mature` (c ≥ 0.95), `forecast` (0 < c < 0.95), `evidence`
- Computes `projected_y = x × blended_rate` where blended mixes observed and model
- Adds: `completeness`, `layer`, `evidence_y`, `forecast_y`, `projected_y`

`compute_completeness(cohort_age_days, mu, sigma, onset)` (line 35):
- Shifted lognormal CDF: `log_normal_cdf(age - onset, mu, sigma)`
- Used by both `annotate_rows` and `cohort_forecast.py`

### 3.4 Python BE — Core Computation

**`graph-editor/lib/runner/cohort_forecast.py`** (591 lines)

The heart of the fan chart. Pure functions, no DB/file I/O.

`compute_cohort_maturity_rows(frames, graph, target_edge_id, edge_params,
anchor_from, anchor_to, sweep_to, is_window, axis_tau_max)` (line 188):

**Step 1: Resolve dates and params** (lines 233–260)
- Parse anchor/sweep dates
- Compute `tau_solid_max`, `tau_future_max`
- Extract Bayes params: mu, sigma, onset, p, all SDs, onset_mu_corr

**Step 2: Build per-Cohort info** (lines 268–296)
- From the last frame, get each Cohort's `x_frozen`, `y_frozen`, `tau_max`
- `cohort_info[anchor_day_str] = {anchor_day, x_frozen, y_frozen, tau_max}`

**Step 3: Bucket aggregation** (lines 298–352)
- Build `cohort_at_tau[anchor_day][τ] = (x, y)` — per-Cohort per-τ lookup
- Build `buckets[τ]` with: `sum_y`, `sum_x`, `sum_y_mature`, `sum_x_mature`,
  `sum_proj_y`, `sum_proj_x`, counts

**Step 4: Determine tau_observed per Cohort** (lines 353–396)
- Primary: `evidence_retrieved_at` from graph edge → τ = retrieved_date - anchor_day
- Fallback: heuristic — last τ where y increased (not carry-forward)
- Critical: using wrong `tau_observed` makes fan too narrow

**Step 5: Compute conditional band half-widths** (lines 412–437)
- One set per unique `tau_observed` (one per Cohort observation point)
- Calls `compute_conditional_confidence_band()` with `n_obs` = sum of x for
  Cohorts mature at this tau_observed
- Stores: `cond_bands[tau_observed] = half_widths[τ]`

**Step 6: Emit rows** (lines 448–590)
For each τ from 0 to max_tau:

- **Evidence rate**: `sum_y / sum_x` from bucket (all Cohorts including
  carry-forward). Null in epoch C.

- **Midpoint** (lines 473–515): For each Cohort:
  - Mature at τ: use `cohort_at_tau[ad][τ]` observed values
  - Immature at τ: `y_forecast = y_frozen × CDF(τ) / CDF(tau_max)` (calibrated
    CDF ratio). `x_forecast = x_frozen` (window mode).
  - `midpoint = total_y_aug / total_x_aug`
  - Null in epoch A (midpoint = evidence, no value showing it)

- **Fan** (lines 522–560): Conditional uncertainty band
  - At `tau_solid_max`: zero-width (boundary point for polygon start)
  - For immature Cohorts: weighted average conditional half-width
  - `var_param = (avg_hw × immature_fraction)²`
  - `var_binomial = midpoint × (1-midpoint) / total_x_aug × immature_x_fraction`
  - `fan_hw = sqrt(var_param + var_binomial)`
  - `fan_upper = min(1, midpoint + fan_hw)`
  - `fan_lower = max(0, midpoint - fan_hw)`

Other functions:
- `forecast_rate(tau, p, mu, sigma, onset)` (line 29): `p × CDF(τ)`
- `read_edge_cohort_params(edge)` (line 57): extract params from graph edge dict
- `get_incoming_edges(graph, node_id)` (line 125): topology helper
- `upstream_arrival_rate(tau, graph, node_id)` (line 155): Phase 2 upstream forecasting
- `find_edge_by_id(graph, edge_id)` (line 139): edge lookup

### 3.5 Python BE — Confidence Bands

**`graph-editor/lib/runner/confidence_bands.py`** (289 lines)

Two band types:
1. **Unconditional** (`compute_confidence_band`): standard delta-method bands on
   the model CDF. Used for model overlay bands.
2. **Conditional** (`compute_conditional_confidence_band`): bands conditioned on
   observation at `tau_observed`. Used for the fan chart.

Key internals:

`_shifted_lognormal_cdf(t, onset, mu, sigma)` (line 50):
- `P(delay ≤ t) = Φ((ln(t-onset) - mu) / sigma)`

`_jacobian_at(t, p, mu, sigma, onset)` (line 59):
- Returns `(cdf, dr_dp, dr_dmu, dr_dsigma, dr_donset)` at age t
- `dr_dp = cdf` (rate scales linearly with p)
- `dr_dmu = p × (-phi/sigma)` (CDF sensitivity to location)
- `dr_dsigma = p × (-phi×z/sigma)` (CDF sensitivity to scale)
- `dr_donset = p × (-phi/(sigma×age))` (CDF sensitivity to shift)

`_quadratic_form(j, p_sd, mu_sd, sigma_sd, onset_sd, onset_mu_corr)` (line 95):
- Computes `J · Σ · Jᵀ` for variance
- Σ is diagonal except for onset-mu off-diagonal

`_bilinear_form(j1, j2, ...)` (line 123):
- Computes `J1 · Σ · J2ᵀ` for cross-covariance between two τ values

`compute_confidence_band(ages, p, mu, sigma, onset, SDs, corr, level)` (line 150):
- Standard delta-method band: `rate ± k × sqrt(J·Σ·Jᵀ)` at each τ
- Returns `(upper, lower)` lists

`compute_conditional_confidence_band(ages, tau_observed, ..., n_obs)` (line 204):
- The fan chart formula. Computes at each τ:
  - `V(τ)` = marginal variance
  - `V(τ_obs)` = marginal variance at observation point + binomial noise
  - `C(τ, τ_obs)` = cross-covariance
  - `Var_cond = V(τ) − C(τ,τ_obs)² / V(τ_obs)`
- `V_binomial = rate_obs × (1 - rate_obs) / n_obs` accounts for finite sample
- Returns `half_widths` list (not upper/lower — caller centres on midpoint)

### 3.6 FE — Request Building

**`graph-editor/src/services/analysisComputePreparationService.ts`** (625 lines)

`prepareAnalysisComputeInputs()` (line 339):
- Builds `PreparedAnalysisComputeReady` from canvas state
- Resolves `snapshot_subjects` per scenario via `resolveSnapshotSubjectsForScenario()`
- Resolves compute-affecting display settings via `resolveComputeAffectingDisplay()`

`runBackendAnalysis(prepared)` (line 594):
- Dispatches to `graphComputeClient.analyzeSelection()` (single scenario) or
  `.analyzeMultipleScenarios()` (multi)
- Builds `AnalysisRequest` with: `scenarios`, `query_dsl`, `analysis_type`,
  `display_settings`

### 3.7 FE — Network & Normalisation

**`graph-editor/src/lib/graphComputeClient.ts`** (~1900 lines)

`analyzeSelection()` (line 1376):
- Builds `AnalysisRequest` (line 1435)
- POST to `/api/runner/analyze`
- Cache key includes: graph hash, query_dsl, analysis_type, visibility_mode,
  snapshot subjects signature, display_settings hash, `COHORT_MATURITY_CACHE_VERSION=17`

`AnalysisRequest` interface (line 1852):
```typescript
{
    scenarios: ScenarioData[];
    query_dsl?: string;
    analysis_type?: string;
    forecasting_settings?: ForecastingSettings;
    display_settings?: Record<string, unknown>;
}
```

Cohort maturity normalisation (line 535):
- Reads `block.result.maturity_rows` from ALL matching blocks
- `blocks.filter()` collects from all epochs (NOT `blocks.find()`)
- For each row: adds `scenario_id`, `subject_id`, `analysis_type`
- Sorts by scenario → subject → tau_days
- Builds dimension_values for scenario and subject axes

### 3.8 FE — Chart Builder

**`graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts`** (~500 lines)

`buildCohortMaturityEChartsOption(result, settings, extra)` (line 36):

**Row parsing** (lines 90–128):
- Parses BE rows into `RowPoint` objects with: tauDays, baseRate, projectedRate,
  midpoint, fanUpper, fanLower, tauSolidMax, tauFutureMax, cohort counts

**Per-scenario epoch boundaries** (lines 171–172):
```typescript
const sSolidMax = points.reduce((m, p) => p.tauSolidMax !== null ? Math.max(m, p.tauSolidMax) : m, 0);
const sFutureMax = points.reduce((m, p) => p.tauFutureMax !== null ? Math.max(m, p.tauFutureMax) : m, 0);
```

**Series construction** (lines 164–279):

For `mode === 'f'`: single dashed line with `projectedRate` + area fill.

For `mode === 'f+e'` or `'e'`:
1. **Solid** (`${scenarioId}::solid`): `baseRate` where `τ ≤ sSolidMax`
2. **Dashed** (`${scenarioId}::dashedEvidence`): `baseRate` where `sSolidMax ≤ τ ≤ sFutureMax`, opacity 0.75
3. **Dotted** (`${scenarioId}::midpoint`): `midpoint` where `τ ≥ sSolidMax && midpoint !== null`, opacity 0.6
4. **Fan** (`${scenarioId}::fan`): custom ECharts polygon series (type: 'custom')

**Fan polygon rendering** (lines 253–272):
- Collects `[tauDays, fanUpper, fanLower]` tuples
- `renderItem()` builds polygon: upper bounds left→right, then lower bounds right→left
- `smooth: false` (spline overshoot caused edge bulge — fixed)
- Colour: scenario colour with alpha, or theme-appropriate neutral
- `z: 2` (behind data lines), `silent: true`

**Model overlay** (lines 282–349):
- Reads `result.metadata.model_curves` per subject
- Per-source curves: bayesian (dotted), analytic FE (dot-dash), analytic BE (dot-dot-dash)
- Neutral grey colour (colours reserved for scenarios)
- `show_model_promoted` defaults to `false`
- Bayesian confidence band rendered as a filled polygon behind the curve

---

## 4. The Maths

### 4.1 Midpoint: calibrated CDF ratio

For an immature Cohort with `y_frozen` conversions observed up to `tau_max`:

```
y_forecast(τ) = y_frozen × CDF(τ) / CDF(tau_max)
```

Properties:
- At `τ = tau_max`: ratio = 1, so `y_forecast = y_frozen` (continuous)
- At `τ → ∞`: `y_forecast → y_frozen / CDF(tau_max)` (this Cohort's implied eventual y)
- `CDF(τ) / CDF(tau_max) ≥ 1` always (CDF monotonic) → `y_forecast ≥ y_frozen`
- Calibrated to THIS Cohort's performance, never reverts to generic model p
- If Cohort outperforms model, outperformance preserved. If underperforms, preserved too.

Rate form: `rate_forecast(τ) = evidence_rate × CDF(τ) / CDF(tau_max)`

### 4.2 Multi-Cohort midpoint aggregation

At each τ in epochs B+C:

```
For each Cohort i:
    if mature at τ:  (x_i, y_i) = cohort_at_tau[anchor_day_i][τ]  (actual observed)
    if immature:     x_i = x_frozen_i,  y_i = y_frozen_i × CDF(τ) / CDF(tau_max_i)

midpoint(τ) = Σ y_i / Σ x_i
```

In window mode: `midpoint ≥ evidence` is guaranteed because all x values are the
same (window mode: x fixed), and forecast y ≥ frozen y for every immature Cohort.

### 4.3 Conditional variance (fan chart)

The fan must spread from zero at the observation point. This requires **conditional**
uncertainty: Var[rate(τ) | observed rate(tau_obs)].

Using the multivariate delta method:

```
rate(τ)       ≈ rate_model(τ)       + J(τ) · δθ
rate(tau_obs) ≈ rate_model(tau_obs) + J(tau_obs) · δθ
```

where `J(τ) = [∂rate/∂p, ∂rate/∂μ, ∂rate/∂σ, ∂rate/∂onset]` and `δθ ~ N(0, Σ)`.

Conditional variance:
```
Var[rate(τ) | rate(tau_obs)] = V(τ) − C(τ, τ_obs)² / V(τ_obs)
```

where:
- `V(τ) = J(τ) · Σ · J(τ)ᵀ` — marginal variance at τ
- `V(τ_obs) = J(τ_obs) · Σ · J(τ_obs)ᵀ + V_binomial` — observation variance + noise
- `C(τ, τ_obs) = J(τ) · Σ · J(τ_obs)ᵀ` — cross-covariance
- `V_binomial = rate_obs × (1 − rate_obs) / n_obs` — binomial sampling noise

The `V_binomial` term is critical: without it, the observation perfectly constrains
the model parameters (σ(τ_obs)² cancels exactly), making Var_cond = 0 at τ_obs and
the fan too narrow everywhere. With `n_obs`, the observation is noisy, so the
conditioning is imperfect — physically correct.

### 4.4 Asymptotic behaviour

At τ → ∞:
- `J(∞) = [1, 0, 0, 0]` (only p matters; CDF → 1)
- `V(∞) = Var(p)`
- `C(∞, τ_obs) = CDF(τ_obs) × Var(p)`
- Conditional variance = `Var(p) × [1 − CDF(τ_obs)² × Var(p) / V(τ_obs)]`

This is a fraction of Var(p), not zero and not full Var(p):
- If tau_obs is late (CDF ≈ 1): we've nearly measured p. Fan closes. ✓
- If tau_obs is early (CDF ≈ 0.3): p poorly constrained. Fan stays wide. ✓

### 4.5 Multi-Cohort fan aggregation (current implementation)

At each τ, for immature Cohorts:
```python
avg_hw = Σ(x_i × hw_i) / Σ(x_immature)     # x-weighted avg conditional half-width
immature_fraction = Σ(x_immature) / Σ(x_all)
var_param = (avg_hw × immature_fraction)²     # parameter uncertainty, scaled down
var_binomial = midpoint × (1-midpoint) / Σ(x_all) × immature_x_fraction  # sampling noise
fan_hw = sqrt(var_param + var_binomial)
```

**Known issue**: this may over-scale. The `immature_fraction²` factor reduces the
fan aggressively as more Cohorts mature, producing implausibly narrow bands.

### 4.6 Covariance matrix Σ

Currently models 5 elements:
- Diagonal: `Var(p)`, `Var(mu)`, `Var(sigma)`, `Var(onset)`
- Off-diagonal: `Cov(onset, mu) = onset_mu_corr × onset_sd × mu_sd`
  (typically ≈ -0.7 to -0.9 — onset and mu trade off on short-onset edges)
- All other cross-terms assumed zero (could add mu-sigma in future)

---

## 5. Work Completed

### 5.1 Python BE

- **`confidence_bands.py`**: Refactored from monolithic function into extracted
  helpers (`_jacobian_at`, `_quadratic_form`, `_bilinear_form`). Added
  `compute_conditional_confidence_band()` with `n_obs` parameter for binomial
  noise in the observation. This is the function that produces the fan shape.

- **`cohort_forecast.py`**: Created from scratch. Complete
  `compute_cohort_maturity_rows()` with: per-Cohort per-τ lookup, bucket
  aggregation tracking mature/immature separately, calibrated CDF ratio
  midpoint, conditional fan with binomial noise, epoch-aware row emission,
  diagnostic prints at epoch boundaries. Also: `forecast_rate()`,
  `read_edge_cohort_params()`, `get_incoming_edges()`, `find_edge_by_id()`,
  `upstream_arrival_rate()`.

- **`api_handlers.py`**: Wired `compute_cohort_maturity_rows()` into
  `_handle_snapshot_analyze_subjects()` at line 1518. Added fallback path for
  subjects without Bayes params (line 1543). Added `evidence_retrieved_at`
  extraction from `p.evidence.retrieved_at` in `_read_edge_model_params()`.

### 5.2 FE

- **`graphComputeClient.ts`**: Gutted ALL FE-side bucket aggregation for
  cohort_maturity. Previously the FE was computing `dataByKey`,
  `readLatencyDays`, `cohortXByMaxAge`, `bandUpperByTau`, `modelRateByTau`,
  and generating synthetic epoch C rows. All of this was removed. Now it
  reads `maturity_rows` from BE results and passes them through. Changed
  from `blocks.find()` (returned first epoch, often empty) to
  `blocks.filter()` (collects from all epochs).

- **`cohortComparisonBuilders.ts`**: Rebuilt chart rendering. Removed crown
  fill series, old FE-computed fan, model lookup maps. Added: solid/dashed/
  dotted/fan series per scenario. Fan polygon: upper→lower polygon with
  `smooth: false` (fixed spline overshoot). Per-scenario epoch boundaries
  from row data. `show_model_promoted` default changed to `false`.

### 5.3 Tests

- **`test_cohort_fan_controlled.py`**: 17 controlled tests, all passing.
  5 test classes covering: single Cohort midpoint (4 tests), fan width (4),
  multi-Cohort epoch B (3), CDF ratio calibration (3), conditional band (3).
  Uses `make_single_cohort_frames()` and `make_graph()` helpers with
  hardcoded params (mu=2.0, sigma=0.5, onset=2.0, p=0.80).

### 5.4 Documentation

- **`cohort-maturity-fan-chart-spec.md`**: Full specification. 11 sections
  covering: user-facing behaviour, phasing (1a/1b/2a/2b), architecture,
  window mode data, per-τ row computation, conditional variance formulas,
  multi-Cohort aggregation, epoch splitting/stitching, continuity, edge
  cases, cohort() mode design (Phase 2).

- **`programme.md`**: Added "Date coherence: fitted_at / model_trained_at /
  source_at" section documenting the date field mess that blocks reliable
  `asat()` testing of fan charts.

---

## 6. Bugs Fixed During This Work

| # | Bug | Root cause | Fix |
|---|-----|-----------|-----|
| 1 | FE computing fan/midpoint instead of BE | Logic put in FE (violated architecture) | Gutted all FE computation, moved to `compute_cohort_maturity_rows()` |
| 2 | Evidence > midpoint in epoch B | Different denominators (evidence = mature-only, midpoint = full group) | Changed evidence to `sum_y/sum_x` (all Cohorts including carry-forward) |
| 3 | Fan suddenly wide at epoch C boundary | `fraction_forecast` used current row's `evidence_rate` (null in C → division error) | Use `ev_rate_at_boundary` as a constant computed once at `tau_solid_max` |
| 4 | Gap between epochs A and B | Midpoint was null at `tau_solid_max` (condition was `tau <= tau_solid_max`) | Changed to `tau < tau_solid_max` so midpoint starts AT the boundary |
| 5 | Fan polygon edge bulge | ECharts `smooth: 0.3` spline interpolation overshoots | Changed to `smooth: false` on all polygons |
| 6 | FE not finding maturity_rows | `blocks.find()` returned first matching block (often epoch 0, empty) | Changed to `blocks.filter()` to collect rows from ALL epoch blocks |
| 7 | f-string format error in diagnostics | Ternary expression inside f-string format spec | Pre-computed formatted strings before f-string |
| 8 | Fan too narrow (single Cohort) | Conditional variance over-constrains with exact observation | Added `n_obs` to `compute_conditional_confidence_band()` — binomial noise weakens conditioning |
| 9 | No confidence bands when promoted source is Bayes | `promotedSource` check looked for wrong field | Fixed source detection in chart builder |

---

## 7. Known Open Bugs

### 7.1 Evidence > midpoint in epoch B (multi-Cohort)

**Status**: Partially fixed but still reproducible with certain data shapes.

**Symptom**: Dashed evidence line goes above dotted midpoint in epoch B.

**Analysis**: The evidence line uses bucket `sum_y/sum_x`. In epoch B, some
Cohorts are immature — their y in the bucket is their frozen (lower) y, but
their x is still counted. The midpoint uses CDF-ratio augmented y for these
same Cohorts (higher). But the bucket's `sum_y` for immature Cohorts is their
CARRY-FORWARD y (from the last retrieval), while the midpoint's y_forecast uses
`y_frozen × CDF(τ) / CDF(tau_max)`.

The subtle issue: at certain τ values in epoch B, a Cohort's carry-forward y in
the bucket can be HIGHER than its CDF-ratio forecast y if the Cohort was
overperforming the model at its last retrieval, and the CDF ratio at this
particular τ hasn't caught up.

### 7.2 Fan too narrow for multi-Cohort groups

**Status**: Open.

**Symptom**: Fan width ~3pp for n=983 at 69% completeness with 17 Cohorts.
Implausibly narrow — at 69% completeness there should be meaningful uncertainty
about the final rate.

**Analysis**: The `immature_fraction` scaling in the multi-Cohort aggregation
(line 548) may be over-reducing. The formula squares the immature fraction:
`var_param = (avg_hw × immature_fraction)²`. As immature Cohorts become a
smaller fraction of the group (more Cohorts mature at higher τ), the fan
collapses quadratically.

Alternative approach (not yet implemented): treat immature Cohorts' errors as
perfectly correlated (conservative but honest). This gives:
`fan_hw_agg ≈ (Σ_immature x_i / Σ x) × max_i(fan_hw_i)`

---

## 8. Phasing

### Phase 1a: window(), single Cohort — DONE
- Single Cohort, fixed x, no epoch B
- Midpoint: calibrated CDF ratio
- Fan: conditional variance + binomial noise
- Tests: 17/17 pass

### Phase 1b: window(), multiple Cohorts — IN PROGRESS
- Multiple Cohorts, epoch B exists
- Midpoint: multi-Cohort aggregation with CDF ratio per immature Cohort
- Fan: weighted average conditional bands + binomial noise
- **Bugs**: evidence>midpoint, fan too narrow
- **Next**: build test harness to diagnose

### Phase 2a: cohort(), single Cohort — NOT STARTED
- Moving denominator: x grows with τ
- Requires `upstream_arrival_rate()` (function exists, not yet wired)
- `x_forecast(τ) = x_frozen × upstream_rate(τ) / upstream_rate(tau_max)`

### Phase 2b: cohort(), multiple Cohorts — NOT STARTED
- Moving denominator + epoch B aggregation
- `midpoint ≥ evidence` guarantee breaks (different x denominators)
- The hardest problem. See spec §10.

---

## 9. Test Harness Plan (Not Yet Built)

The user rejected the existing test suite as inadequate. It uses toy synthetic
frames with hand-picked y values. The requirement is:

1. **Fork production code** so when called with a param, it loads synthetic data
   from a JSON fixture instead of hitting the snapshot DB.
2. **One JSON fixture** with a realistic synthetic dataset: 7 Cohorts
   (`window(1-Jan:7-Jan)`), evidence accruing at 0.8× the model rate, plausible
   mu/sigma/onset/p with dispersions.
3. **Same param works via URL** (`&test_fixture=fan_test_1`) so the user can
   visually verify the chart in the browser.
4. **Python test** calls the same production `compute_cohort_maturity_rows()`
   with the fixture data, asserting invariants (midpoint ≥ evidence, monotonicity,
   fan containment, fan opening).

See `docs/current/project-bayes/cohort-fan-harness-context.md` for full
implementation plan including data shapes, fork points, FE wiring, and fixture
specification.

---

## 10. Upstream Dependencies

### 10.1 Snapshot DB

The snapshot DB stores raw conversion data per (anchor_day, retrieved_at,
slice_key). `query_snapshots_for_sweep()` fetches rows for a given anchor range
and sweep window. This is the ground truth data source.

### 10.2 Bayes posteriors on graph edges

The Bayesian inference engine (Project Bayes) fits latency CDFs to conversion
data and produces posteriors on each edge: `p.posterior.alpha/beta` (probability),
`p.latency.posterior.mu_mean/sigma_mean/onset_delta_days` (latency). These
provide the model parameters and their uncertainties (SDs, correlations) that
drive the fan chart.

Key posterior fields:
- `posterior.alpha/beta` → window-level posterior p (edge-level)
- `posterior.path_alpha/path_beta` → cohort-level posterior p (path-composed)
- `latency.posterior.mu_mean/sigma_mean` → edge-level latency
- `latency.posterior.path_mu_mean/path_sigma_mean` → path-level latency
- `model_vars[source='bayesian'].latency.mu_sd/sigma_sd/onset_sd` → uncertainties

### 10.3 Posterior slice resolution

`resolveAsatPosterior` (doc 25) checks `posterior.fitted_at` to decide whether a
posterior is valid for a given `asat()` date. If `fitted_at` is after `asat`, the
posterior is rejected → edge has no Bayes params → no fan chart. This has caused
testing friction (user had to manually fudge dates). See programme.md "Date
coherence" section.

### 10.4 Display settings

Compute-affecting display settings flow through the analysis request:
- `bayes_band_level`: confidence level (80/90/95/99/off) for model confidence bands
- `show_model_promoted`: whether to show the promoted model CDF overlay (default: false)

These are resolved via `resolveComputeAffectingDisplay()` in
`analysisDisplaySettingsRegistry.ts` and sent as `display_settings` in the request.

---

## 11. Key Design Decisions

1. **ALL computation in Python BE. FE is rendering only.** Violated repeatedly
   during development; corrected each time. The FE receives complete rows and
   draws what they say.

2. **Midpoint uses CDF ratio calibration, not generic model.** `y_forecast =
   y_frozen × CDF(τ)/CDF(tau_max)`. This anchors to THIS Cohort's actual
   performance. It never reverts to the model's generic p.

3. **Fan uses conditional variance, not marginal.** The fan must start from
   zero width at the observation point. Unconditional bands would start wide.

4. **Binomial noise in the conditioning.** Without `n_obs`, the observation
   perfectly constrains parameters, making the fan unrealistically narrow.
   `V_binomial = rate × (1-rate) / n_obs` weakens the conditioning appropriately.

5. **Per-Cohort tau_observed from evidence_retrieved_at.** The sweep may extend
   beyond the last real retrieval via carry-forward frames. Using the sweep
   endpoint as tau_observed overstates evidence and narrows the fan.

6. **smooth: false on fan polygons.** ECharts spline interpolation causes
   overshoot at polygon edges (bulge effect).

7. **blocks.filter() not blocks.find() for epoch stitching.** Each epoch produces
   its own maturity_rows. The FE must collect from ALL matching blocks.

8. **show_model_promoted defaults to false.** Model CDF overlays distract from
   the evidence + fan view. User can toggle on if needed.

---

## 12. Git History

Key commits on `feature/snapshot-db-phase0` (reverse chronological):

```
cfbf27b7 Pre-release commit for v1.9.4-beta
ff53f81f Fan charts coming soon...
89df2b00 Pre-release commit for v1.9.2-beta
bedbe39b Semi-stable; path dispersion and onset correlation work needed
61a21df3 fetch refactor
f8d1d729 Model vars roundtrip
7c322462 Pre-release commit for v1.8.0-beta
cbd7c232 Ready for Bayes Phase D (finally). Added Data Quality view.
f60b8e1c Bayes phase D-2.5
188cc485 Bayesian surfacing
4f7536db Modularise analysisEChartsService (AEC-PR1-PR6)
035d69e7 cohort fixing
b289b03c Data integrity issue with mapped hashes snapshots
51485e98 Pre-release commit for v1.5.0-beta
56e04f89 Updates ahead of forecasting
```

Branch diff vs main: **618 files changed, 150304 insertions, 29272 deletions.**

---

## 13. Diagnostic Infrastructure

### 13.1 BE diagnostic prints (to be removed before release)

`cohort_forecast.py` line 563: prints at epoch boundary τ values:
```
[fan_diag] tau=6 ev=0.2341 mid=0.2380 bucket_y/x=161/205 aug_y/x=778.5/983 fan=[0.2100,0.2660]
```

`api_handlers.py` line 1536: prints on every maturity_rows computation:
```
[cohort_maturity_rows] Computed 61 rows for subject_id  is_window=True  SDs={...}
```

### 13.2 FE diagnostic logging

`graphComputeClient.ts` line 1461 (DEV only): logs raw BE response shape for
cohort_maturity including frame counts, result keys, error state.

### 13.3 DevTools globals

In DEV mode:
- `window.__dagnetLastAnalyzeRequest` — full request object
- `window.__dagnetLastAnalyzeResponse` — full response object
- `window.__dagnetAnalyzeHistory` — rolling history of last 10 requests
