# Analysis Forecasting: Statistics on the Backend

**Status**: Architectural Note (not yet implemented)  
**Date**: 8-Feb-26  
**Related**: `1-reads.md`, `2-time-series-charting.md`, design.md §5

---

## 1. The Problem

All statistical and forecasting logic currently lives on the **frontend** (TypeScript). The backend (Python) analysis routes have no access to:

- Lognormal distribution fitting (`fitLagDistribution`)
- CDF evaluation (`logNormalCDF`, `logNormalSurvival`)
- Completeness estimation (what fraction of conversions have been observed for a cohort of age *t* days?)
- Evidence-forecast blending (`computeBlendedMean`)
- Onset delta correction (`toModelSpace` and related functions)
- Latency constants (`LATENCY_*`, `FORECAST_BLEND_LAMBDA`, etc.)

This means the backend can currently only **aggregate historic data** (sum DeltaY, count rows). It cannot:

- Project immature cohorts forward to estimate final conversion rates
- Draw fan charts showing expected completion trajectories
- Apply evidence-forecast blends to partially-observed cohorts
- Estimate cohort maturity/completeness per data point

These capabilities are required by the Phase 5 charting features (`2-time-series-charting.md` §2.3 evidence/forecast distinction, §2.4 fan charts, §5 completeness overlays) and will also be needed for any analysis type that returns projected values rather than raw observations.

---

## 2. Current Frontend Statistical Architecture

### 2.1 Pure Maths Layer (dependency-free)

**File**: `graph-editor/src/services/lagDistributionUtils.ts` (~350 lines)

Intentionally free of service dependencies. Pure functions:

- `erf(x)` — Error function (Abramowitz & Stegun approximation)
- `standardNormalCDF(x)` / `standardNormalInverseCDF(p)` — Phi and Phi-inverse
- `logNormalCDF(t, mu, sigma)` — Lognormal CDF
- `logNormalInverseCDF(p, mu, sigma)` — Lognormal quantile
- `logNormalSurvival(t, mu, sigma)` — 1 - CDF
- `fitLagDistribution(medianLag, meanLag, totalK)` — Fit mu/sigma from Amplitude-reported stats
- `toModelSpace(onsetDelta, median, mean, t95, age)` — Onset delta correction

Behaviour is locked by `lagDistribution.golden.test.ts`.

### 2.2 Orchestration Layer (service-dependent)

**File**: `graph-editor/src/services/statisticalEnhancementService.ts` (~3200 lines)

Uses the pure maths layer plus graph state, window aggregation, and forecasting settings to:

- Compute per-cohort completeness from lognormal CDF + cohort age
- Blend evidence (observed) with forecast (baseline) weighted by completeness
- Apply recency weighting and blend lambda controls
- Handle the full LAG (Latency-Aware Graph) pipeline: per-cohort → fit → completeness → blend → p.mean

### 2.3 Constants

**File**: `graph-editor/src/constants/latency.ts`

Defines all tuning constants: `LATENCY_DEFAULT_SIGMA`, `FORECAST_BLEND_LAMBDA`, `LATENCY_T95_PERCENTILE`, `ONSET_MASS_FRACTION_ALPHA`, etc.

---

## 3. What the Backend Needs

For forecasting/projection within analysis results, the backend requires:

### 3.1 Minimum Viable: Completeness Estimation

Given:
- A row with `anchor_day`, `retrieved_at`, `Y`, `X`
- A lognormal fit (mu, sigma) for the parameter's lag distribution
- An onset delta (days of dead-time before conversions begin)

Compute:
- `cohort_age_days = (retrieved_at.date() - anchor_day).days`
- `model_age = max(0, cohort_age_days - onset_delta)`
- `completeness = logNormalCDF(model_age, mu, sigma)`

This is sufficient for:
- Colouring bars by maturity (complete vs immature)
- Showing "expect ~X% more conversions" tooltips
- Basic evidence/forecast distinction

### 3.2 Full Projection: Evidence-Forecast Blend

Given completeness + a baseline conversion rate (from mature cohorts in the same window):
- `w_evidence = (completeness * n_query) / (lambda * n_baseline + completeness * n_query)`
- `projected_pct = w_evidence * observed_pct + (1 - w_evidence) * baseline_pct`

### 3.3 Fan Charts: Quantile Projections

Given the lognormal fit and current completeness:
- Project forward: "at time *t + dt*, expected completeness will be..."
- Compute confidence bands around the projection using snapshot variance

---

## 4. Architectural Options

### Option A: Port Pure Maths to Python

**What**: Create `graph-editor/lib/runner/lag_distribution_utils.py` as a direct port of `lagDistributionUtils.ts`.

**Scope**: ~200 lines of Python. Pure functions, no dependencies beyond `math` stdlib.

**Advantages**:
- Backend is self-contained; no cross-language calls
- Python is the natural home for numerical computation
- Pure functions are trivial to port and verify
- Golden tests can ensure parity (same inputs → same outputs to within floating-point tolerance)

**Disadvantages**:
- Two implementations to maintain (TS + Python)
- Risk of drift if one side is updated and the other isn't

**Mitigation**:
- Golden test suite: a shared fixture file (JSON) with inputs and expected outputs, run by both TS and Python test suites
- The pure maths layer changes extremely rarely (lognormal CDF doesn't evolve)
- Constants shared via a single YAML/JSON file that both languages read

### Option B: Frontend Computes Forecasting Inputs, Sends to Backend

**What**: Frontend computes lognormal fits, completeness values, and blend inputs for each subject, and includes them in the `snapshot_dependencies` request alongside the DB coordinates.

**Scope**: Frontend already has all the inputs (lag stats from parameter files, onset delta, t95). It would compute `{mu, sigma, onset_delta, completeness_at_now}` per subject and include it in the request.

**Advantages**:
- Single source of truth for statistical computation (frontend only)
- Backend remains purely mechanical (aggregate + format)
- No code duplication

**Disadvantages**:
- Frontend must compute forecasting inputs for every subject in every analysis request, even when not needed
- Backend cannot do any projection logic that needs the CDF at arbitrary points (e.g. "what will completeness be in 7 days?")
- Fan charts require CDF evaluation at many points per cohort — impractical to pre-compute all of them on the frontend
- Tightly couples analysis request shape to forecasting model internals

### Option C: Shared WASM Module

**What**: Compile the pure maths layer to WASM (or use a language that targets both JS and Python like Rust via wasm-bindgen + PyO3).

**Advantages**:
- Single source code, both runtimes use it
- Guaranteed parity

**Disadvantages**:
- Massive engineering overhead for ~200 lines of arithmetic
- Build complexity, deployment complexity
- Over-engineered for the problem size

---

## 5. Recommendation: Option A (Port Pure Maths to Python)

Option A is the clear winner for this scale of problem:

1. **The pure maths layer is small** (~200 lines), stable (lognormal CDF doesn't change), and dependency-free. Porting is a few hours of work.

2. **Golden tests eliminate drift risk**. A shared fixture file (`tests/fixtures/lag-distribution-golden.json`) with input/output pairs, tested by both `lagDistribution.golden.test.ts` and `test_lag_distribution.py`, ensures the two implementations agree.

3. **Constants can be shared** via a single YAML file (`constants/latency.yaml`) read by both TS and Python, eliminating the risk of constant drift.

4. **The backend gains full forecasting capability**: it can evaluate the CDF at any point, compute completeness for any cohort age, project forward, and generate fan chart quantiles — all without the frontend needing to pre-compute anything.

5. **Option B fails for fan charts**: fan charts require CDF evaluation at many points per cohort per subject. Pre-computing all of these on the frontend and sending them in the request is impractical and architecturally wrong (the frontend shouldn't need to know what analysis-specific computations the backend will perform).

---

## 6. Implementation Plan (When Forecasting is Needed)

This work is **deferred** until the basic read path (Phase 1-2 of `1-reads.md`) is working. When forecasting is needed:

### 6.1 Port Pure Maths

1. Create `graph-editor/lib/runner/lag_distribution_utils.py`:
   - `erf(x)`, `standard_normal_cdf(x)`, `standard_normal_inverse_cdf(p)`
   - `lognormal_cdf(t, mu, sigma)`, `lognormal_inverse_cdf(p, mu, sigma)`, `lognormal_survival(t, mu, sigma)`
   - `fit_lag_distribution(median_lag, mean_lag, total_k)`
   - `to_model_space(onset_delta, median, mean, t95, age)`

2. Create shared golden fixture: `tests/fixtures/lag-distribution-golden.json`
   - Input/output pairs covering edge cases (zero sigma, extreme ratios, onset subtraction)
   - Both TS and Python test suites consume this fixture

### 6.2 Share Constants

1. Create `constants/latency.yaml` with all tuning constants
2. TS loader: read YAML at build time or import as JSON
3. Python loader: read YAML at import time
4. Remove hardcoded constants from `latency.ts` (replace with loader)

### 6.3 Backend Forecasting Functions

1. Create `graph-editor/lib/runner/forecasting_derivation.py`:
   - `compute_completeness(anchor_day, retrieved_at, mu, sigma, onset_delta)` → float
   - `compute_evidence_forecast_blend(observed_pct, baseline_pct, completeness, n_query, n_baseline, lambda_)` → float
   - `derive_with_forecast(rows, lag_fit, baseline_pct)` → list of `{date, observed, projected, completeness, layer}`
   - `derive_fan_chart(rows, lag_fit, confidence_levels)` → list of `{date, median, ci_50_low, ci_50_high, ci_90_low, ci_90_high}`

### 6.4 Lag Fit Data: Derived from Snapshot Rows, Not from the Graph

**Important**: The `edge.p.latency` fields on the graph (`median_lag_days`, `mean_lag_days`, `completeness`) are **outputs** of the frontend's statistical enhancement service, written back after computation. They are NOT the primary inputs to fitting. The actual inputs are **per-cohort daily time-series data** from the parameter file.

For backend forecasting, the backend should **recompute lag statistics from the snapshot rows it just retrieved**, not read stale display values from the graph edge. This is more correct because the snapshot data being analysed may cover a different time range than what the graph's latency values reflect.

**What the backend derives from snapshot DB rows**:
- Aggregate `median_lag_days` and `mean_lag_days` (weighted across anchor_days)
- `totalK` (sum of Y values)
- `onset_delta_days` (from rows, if available)

**What the backend reads from the graph edge** (optional authoritative constraints only):
- `edge.p.latency.t95` — authoritative if user-overridden or derived from richer data. Used as a one-way constraint to widen the lognormal sigma (never narrows it).
- `edge.p.latency.onset_delta_days` — authoritative if user-overridden.

**Fitting sequence (backend)**:
1. From snapshot rows: compute weighted aggregate `median_lag`, `mean_lag`, `totalK`
2. `fit_lag_distribution(median, mean, totalK)` → `(mu, sigma)`
3. If `edge.p.latency.t95` exists: apply one-way t95 constraint (may increase sigma)
4. Evaluate CDF at required points for completeness/projection

This means:
- No `lag_fit` field is needed on `SnapshotSubjectRequest`
- The backend derives everything from the data it just retrieved
- The graph provides only authoritative constraints (t95, onset if overridden)
- The frontend does not pre-compute or duplicate lag fit parameters

---

## 7. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| TS/Python numerical drift | Low | Medium | Golden test suite with tight tolerances |
| Constant drift | Low | High | Single YAML source, both languages read it |
| Forecasting model changes (mu/sigma fitting) | Low | Medium | Changes go to both implementations; golden tests catch drift |
| Onset delta semantics diverge | Medium | High | Shared golden fixtures include onset edge cases |

---

## 8. Resolved Questions

1. **When does the backend need forecasting?** Only when analysis results include projected/forecast values (fan charts, evidence/forecast split, completeness overlays). Basic aggregation (lag histogram, daily conversions) does NOT need it. The design must anticipate forecasting from the start (request shape, per-subject metadata fields) even if the backend derivation functions are implemented later.

2. **Should the frontend pre-compute lag fits per subject, or should the backend read them from the parameter file?** **Answer: Frontend provides `lag_fit` in the analysis request.** The backend does not access parameter files — that is an important architectural separation we have maintained throughout. If the backend is moved to a separate server, it will not have access to git-backed parameter files or the file registry. The frontend has everything it needs (parameter file is already loaded) and includes the fitted model parameters in the request payload. The backend evaluates the model at whatever points the analysis requires.

3. **SciPy vs pure Python?** Initial port uses pure Python (`math` stdlib only). NumPy will likely be needed in due course for more sophisticated statistics (kernel density estimation, bootstrap resampling for fan charts, matrix operations for multi-parameter joint projections). The pure maths module should be designed so that a NumPy-backed version can replace it without changing the interface.

---

## 9. What `reads.md` Must Anticipate (Even Before Forecasting is Implemented)

The snapshot read path (`1-reads.md`) must be designed so that forecasting can be added without restructuring the request shape or the backend execution model. Specifically:

### 9.1 Lag Fit Data: Backend Derives from Snapshot Rows

The `edge.p.latency` fields on the graph (`median_lag_days`, `mean_lag_days`, `completeness`) are **outputs** of the frontend enhancement service, not primary inputs to fitting. The actual inputs are per-cohort daily data.

For backend forecasting, the backend recomputes lag statistics from the **snapshot rows it just retrieved from the DB** (each row has `median_lag_days`, `mean_lag_days`, `onset_delta_days`). The graph provides only **authoritative constraints**: `edge.p.latency.t95` (if set) and `edge.p.latency.onset_delta_days` (if user-overridden).

No additional per-subject lag fit fields are needed on `SnapshotSubjectRequest`. The backend has everything it needs from the DB rows + the graph's authoritative constraints.

### 9.2 Backend Derivation Functions Must Accept Lag Fit Parameters

Even in Phase 1, the derivation function signatures should accept lag fit parameters (defaulting to None/unused). This avoids a signature-breaking change when forecasting is added:

- `derive_lag_histogram(rows, lag_fit=None)` — Phase 1: ignores lag_fit. Phase N: annotates bins with completeness.
- `derive_daily_conversions(rows, lag_fit=None)` — Phase 1: ignores lag_fit. Phase N: adds `completeness` and `projected` fields per day.
- `derive_cohort_maturity(rows, lag_fit=None)` — New analysis type in Phase N: requires lag_fit to draw maturity curves.

### 9.3 Result Shape Must Support Layered Data (Evidence + Forecast)

The analysis result schema should from the start support a `layer` field on data points (even if all points are `layer: 'evidence'` in Phase 1). This enables the frontend chart components to distinguish solid (evidence) from dashed (forecast) rendering without result schema changes.

### 9.4 The As-At Sweep Mode is the Foundation for Cohort Maturity

The "as-at sweep" read mode (retrieve virtual snapshots at multiple points in time for the same anchor range) is the data foundation for both:
- **Cohort maturity curves** (how did the observed conversion rate evolve as data arrived?)
- **Forecast overlays** (given the current completeness at each as-at point, what was the projected final rate?)

The sweep mode must be designed as a first-class read mode, not a special case. The backend should efficiently execute it (single query with multiple as-at boundaries, or a range-based approach, rather than N separate virtual snapshot queries).

### 9.5 Backend Must Be Able to Extract Authoritative Constraints from the Graph

The backend receives both `snapshot_subjects` (DB coordinates) and `scenarios[].graph`. For forecasting:

**Primary inputs** (from snapshot DB rows): `median_lag_days`, `mean_lag_days`, `onset_delta_days` per row → backend aggregates these into fitting inputs.

**Authoritative constraints** (from graph edge, via `target.targetId`):
- `edge.p.latency.t95` — if set, used as one-way constraint on sigma (only widens, never narrows)
- `edge.p.latency.onset_delta_days` — if user-overridden, used instead of row-level onset

Note: `edge.p.latency.median_lag_days` and `edge.p.latency.mean_lag_days` are **display outputs** from the frontend's last enhancement pass, NOT primary fitting inputs. The backend should compute aggregates from the snapshot data being analysed, not read stale values from the graph.

The backend Python code must include a utility to locate an edge in a scenario graph by UUID and extract its latency config. This is a simple graph traversal.

---

## 10. References

- `lagDistributionUtils.ts` — Pure maths (frontend, current implementation)
- `statisticalEnhancementService.ts` — Orchestration (frontend, current)
- `constants/latency.ts` — Tuning constants (frontend, current)
- `2-time-series-charting.md` §2.3, §2.4, §5 — Forecast/fan chart requirements
- design.md §5 — LAG architecture specification
