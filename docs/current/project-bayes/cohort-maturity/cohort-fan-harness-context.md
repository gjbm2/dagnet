# Cohort Maturity Fan Chart — Test Harness Context & Thread Summary

**Date**: 31-Mar-26
**Purpose**: Complete context dump from the implementation thread so work can resume
without loss of state after context breaks.

---

## 1. What We're Building

A **test harness** for the cohort maturity fan chart that:

1. Forks production code so that when a parameter is set, it loads a **single JSON
   fixture file** instead of hitting the live snapshot DB.
2. The **same parameter** works via `&test_fixture=fan_test_1` in the browser URL,
   so the user can visually verify the exact same synthetic data the tests see.
3. Every `cohort_maturity` chart on screen draws from the fixture when the param
   is active — no mixing of real and synthetic data.
4. A Python test harness calls the **same production code** (`compute_cohort_maturity_rows`)
   with the same fixture data, asserting mathematical invariants.

This is **NOT**:
- A mock of the entire DB or graph infrastructure.
- A synthetic graph creation exercise.
- An FE-side computation test.

It is a **data-source fork**: production computation code runs identically, only the
input data source changes.

---

## 2. The Fan Chart: What It Is

The cohort maturity chart plots conversion rate (y/x) against age (τ days) for a
group of Cohorts. A **Cohort** is one `anchor_day`'s worth of users.

When Bayesian posteriors are available, the chart shows:

| Visual | Epoch A (all mature) | Epoch B (some immature) | Epoch C (all immature) |
|--------|---------------------|------------------------|----------------------|
| **Solid line** — complete evidence | ✓ | — | — |
| **Dashed line** — incomplete evidence | — | ✓ | — |
| **Dotted line** — augmented best estimate (midpoint) | — | ✓ | ✓ |
| **Fan polygon** — uncertainty band | — | ✓ | ✓ |

### Epoch boundaries (per-scenario)

- `tau_solid_max = sweep_to − anchor_to` — all Cohorts mature up to here
- `tau_future_max = sweep_to − anchor_from` — oldest Cohort's max age

### Key formulas

**Midpoint** (augmented best estimate for immature Cohorts):
```
y_forecast(τ) = y_frozen × CDF(τ) / CDF(tau_max)
```
Calibrates to THIS Cohort's actual performance, never reverts to the generic model.
`y_forecast ≥ y_frozen` always (CDF monotonically increasing). In window mode,
`midpoint ≥ evidence` is guaranteed (same denominators, larger numerator).

**Conditional variance** (fan spreads from observation point):
```
Var[rate(τ) | rate(tau_obs)] = V(τ) − C(τ, τ_obs)² / (V(τ_obs) + V_binomial)
```
Where:
- `V(τ) = J(τ) · Σ · J(τ)ᵀ` — marginal variance (delta method)
- `C(τ, τ_obs) = J(τ) · Σ · J(τ_obs)ᵀ` — cross-covariance
- `V_binomial = rate_obs × (1 − rate_obs) / n_obs` — binomial observation noise
- `J(τ) = [∂rate/∂p, ∂rate/∂μ, ∂rate/∂σ, ∂rate/∂onset]` — Jacobian at τ

Fan is zero-width at the observation point, opens smoothly into the forecast region.

---

## 3. Architecture

All computation in Python BE. FE is rendering only. **NO MATHS IN FE.**

```
Python BE (api_handlers.py ~line 1518)
  └─ derive_cohort_maturity() → frames (from snapshot DB)
  └─ annotate_rows() → adds projected_y
  └─ compute_cohort_maturity_rows() → complete per-τ rows
  └─ result['maturity_rows'] = rows

FE (graphComputeClient.ts ~line 537)
  └─ reads block.result.maturity_rows from ALL matching blocks
  └─ collects rows from all epoch blocks (epoch stitching)
  └─ adds scenario_id, subject_id
  └─ passes rows through (NO computation)

Chart builder (cohortComparisonBuilders.ts)
  └─ parses rows into RowPoint objects
  └─ extracts tauSolidMax, tauFutureMax from row data
  └─ draws: solid (epoch A baseRate), dashed (epoch B baseRate),
     dotted (midpoint), fan polygon (fanUpper/fanLower)
  └─ fan polygon: smooth: false, includes zero-width boundary point
```

---

## 4. Key Files

### Python BE (computation)

| File | Purpose |
|------|---------|
| `graph-editor/lib/runner/cohort_forecast.py` | `compute_cohort_maturity_rows()` — the main function under test. Takes `frames`, `graph`, `edge_params`, dates. Produces per-τ rows with rate, midpoint, fan bounds. |
| `graph-editor/lib/runner/confidence_bands.py` | `compute_conditional_confidence_band()` — conditional variance formula. `_jacobian_at()`, `_quadratic_form()`, `_bilinear_form()` helpers. |
| `graph-editor/lib/api_handlers.py` ~line 1518 | **Fork point** — where `compute_cohort_maturity_rows()` is called with `result['frames']` and `model_params`. This is where the fixture substitution goes. |
| `graph-editor/lib/tests/test_cohort_fan_controlled.py` | Existing 17-test suite (all pass). Tests midpoint monotonicity, calibration, fan width properties, multi-Cohort epoch B, CDF ratio, conditional band. User considers this **inadequate** — needs controlled end-to-end testing with visual verification. |

### FE (rendering only)

| File | Purpose |
|------|---------|
| `graph-editor/src/lib/graphComputeClient.ts` ~line 537 | Reads `maturity_rows` from BE response. Collects from ALL matching blocks (epoch stitching via `blocks.filter()`). |
| `graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts` | Chart builder. Draws solid/dashed/dotted/fan series. Fan polygon built by upper bounds forward + lower bounds backward. `smooth: false`. |
| `graph-editor/src/services/analysisComputePreparationService.ts` ~line 594 | Builds analysis request. `runBackendAnalysis()` dispatches to `graphComputeClient.analyzeSelection()` or `analyzeMultipleScenarios()`. |

### Docs

| File | Purpose |
|------|---------|
| `docs/current/project-bayes/cohort-maturity-fan-chart-spec.md` | Full spec: phases 1a/1b/2a/2b, architecture, formulas, edge cases. |
| `docs/current/project-bayes/programme.md` | Programme status. Includes "Date coherence" section about `fitted_at` blocking `asat()`. |

---

## 5. Data Shapes

### `compute_cohort_maturity_rows()` signature

```python
def compute_cohort_maturity_rows(
    frames: List[Dict[str, Any]],        # from derive_cohort_maturity / snapshot DB
    graph: Dict[str, Any],               # scenario graph with Bayes params on edges
    target_edge_id: str,                 # UUID of the target edge
    edge_params: Dict[str, float],       # resolved Bayes params for this edge
    anchor_from: str,                    # ISO date string
    anchor_to: str,                      # ISO date string
    sweep_to: str,                       # ISO date string
    is_window: bool = True,              # window() vs cohort() mode
    axis_tau_max: Optional[int] = None,  # max τ for axis extent
) -> List[Dict[str, Any]]:
```

### `frames` structure (input — comes from snapshot DB normally)

```python
[
    {
        "as_at_date": "2026-01-05",        # observation date
        "data_points": [
            {
                "anchor_day": "2026-01-01", # Cohort anchor date
                "x": 58,                    # from-node arrivals (fixed in window mode)
                "y": 12,                    # cumulative conversions at this τ
                "a": 58,                    # anchor entrants
            },
            {
                "anchor_day": "2026-01-02",
                "x": 62,
                "y": 8,
            },
            # ... one entry per Cohort
        ],
    },
    # ... one frame per as_at_date in sweep range
]
```

τ is derived as `as_at_date − anchor_day` for each data point.

### `edge_params` structure (input — comes from graph edge Bayes params)

```python
{
    'mu': 1.62,                      # log-mean of shifted lognormal latency
    'sigma': 0.8,                    # log-stdev
    'onset_delta_days': 4.0,         # dead-time before conversions begin
    'forecast_mean': 0.83,           # p — ultimate conversion probability
    'p_stdev': 0.05,                 # posterior SD of p
    'bayes_mu_sd': 0.20,             # posterior SD of mu
    'bayes_sigma_sd': 0.10,          # posterior SD of sigma
    'bayes_onset_sd': 1.5,           # posterior SD of onset
    'bayes_onset_mu_corr': -0.70,    # correlation between onset and mu posteriors
    'evidence_retrieved_at': '2026-01-12',  # last real data retrieval date
}
```

### `graph` structure (minimal — only needs target edge)

```python
{
    'edges': [{
        'uuid': 'test-edge-1',
        'from': 'A',
        'to': 'B',
        'p': {
            'latency': {
                'mu': 1.62, 'sigma': 0.8, 'onset_delta_days': 4.0,
                'posterior': {
                    'mu_mean': 1.62, 'sigma_mean': 0.8,
                    'onset_delta_days': 4.0,
                },
            },
            'forecast': {'mean': 0.83},
            'posterior': {'alpha': 20, 'beta': 5},
        },
    }],
}
```

### Output row schema

```python
{
    'tau_days': int,
    'rate': float | None,           # evidence rate (null in epoch C)
    'projected_rate': float | None,
    'midpoint': float | None,       # augmented estimate (null in epoch A)
    'fan_upper': float | None,
    'fan_lower': float | None,
    'tau_solid_max': int,
    'tau_future_max': int,
    'boundary_date': str,           # sweep_to ISO date
    'cohorts_covered_base': int,
    'cohorts_covered_projected': int,
}
```

---

## 6. FE Request Flow (for wiring the URL param)

### Request path

1. `analysisComputePreparationService.ts` → `prepareAnalysisComputeInputs()` builds `PreparedAnalysisComputeReady`
2. `runBackendAnalysis()` dispatches to `graphComputeClient.analyzeSelection()` or `.analyzeMultipleScenarios()`
3. `analyzeSelection()` (~line 1435) builds `AnalysisRequest`:
   ```typescript
   const request: AnalysisRequest = {
       scenarios: [scenarioEntry],
       query_dsl: queryDsl,
       analysis_type: analysisType,
       ...(displaySettings ? { display_settings: displaySettings } : {}),
   };
   ```
4. POST to `/api/runner/analyze` with JSON body
5. BE `api_handlers.py` receives `data` dict, routes to `_handle_snapshot_analyze_subjects(data)`

### AnalysisRequest interface (graphComputeClient.ts:1852)

```typescript
export interface AnalysisRequest {
    scenarios: ScenarioData[];
    query_dsl?: string;
    analysis_type?: string;
    forecasting_settings?: ForecastingSettings;
    display_settings?: Record<string, unknown>;
}
```

### Where to inject `test_fixture`

**FE side**: Add `test_fixture?: string` to `AnalysisRequest`. In `runBackendAnalysis()`,
detect URL param `new URLSearchParams(window.location.search).get('test_fixture')` and
include it in the request.

**BE side**: In `api_handlers.py` at line 1518, check `data.get('test_fixture')`. If
present, load the fixture JSON and substitute `frames` and `model_params` before calling
`compute_cohort_maturity_rows()`.

**Cache key**: `display_settings` is already hashed into the cache key. If `test_fixture`
is added to `display_settings` it auto-busts the cache. Alternatively add it to the
cache key directly.

---

## 7. The Fixture: Synthetic Dataset Specification

### Parameters

- **Mode**: window() — Phase 1
- **Anchor range**: 1-Jan-26 to 7-Jan-26 — 7 Cohorts, one per day
- **Sweep_to**: 13-Jan-26 (12 days from anchor_from)
- **x per Cohort**: varying slightly, e.g. [58, 62, 55, 67, 61, 53, 64]

### Model params (what the Bayes model believes)

- `p = 0.83` — model's ultimate conversion probability
- `mu = 1.62` — log-mean (gives median delay ≈ 5d from onset, so median lag from anchor ≈ 9d)
- `sigma = 0.8` — log-stdev
- `onset = 4.0` — dead-time (days)
- `p_sd = 0.05`, `mu_sd = 0.20`, `sigma_sd = 0.10`, `onset_sd = 1.5`
- `onset_mu_corr = -0.70`

### Evidence generation (how data actually accrues)

Evidence accrues at **0.8× the model-implied rate** — the Cohort is underperforming
vs the model. This creates the realistic and interesting case where evidence ≠ model.

```
p_actual = FACTOR × p_model = 0.8 × 0.83 = 0.664
```

For each Cohort (anchor_day `a`) with `x` users, at each observed τ:
```
y(τ) = round(x × p_actual × CDF(τ; onset=4, mu=1.62, sigma=0.8))
```

Frames are generated for each `as_at_date` from 1-Jan to 13-Jan. Each frame has one
data_point per Cohort whose anchor_day ≤ as_at_date. This produces successive daily
snapshots that closely resemble real data shape but at a controlled underperformance
factor.

### Epoch boundaries for this fixture

- `tau_solid_max = 13-Jan − 7-Jan = 6` — all 7 Cohorts mature for τ ≤ 6
- `tau_future_max = 13-Jan − 1-Jan = 12` — oldest Cohort has 12 days of data
- **Epoch B**: τ = 7..12 — progressively fewer mature Cohorts
- **Epoch C**: τ > 12 — all immature, pure forecast

### Maturity at sweep point

CDF(12, onset=4, mu=1.62, sigma=0.8):
- delay = 12 − 4 = 8
- z = (ln(8) − 1.62) / 0.8 = (2.08 − 1.62) / 0.8 ≈ 0.575
- Φ(0.575) ≈ 0.72
- rate = 0.664 × 0.72 ≈ 0.48 (oldest Cohort ~48% rate at τ=12)
- model_rate = 0.83 × 0.72 ≈ 0.60 (model expects ~60%)

The oldest Cohort is about 72% of the way through the CDF (~60% model-implied
completeness given p=0.83), achieving ~48% actual conversion rate vs ~60% model
expectation.

---

## 8. Known Bugs to Expose

### Bug 1: Evidence > midpoint in epoch B (multi-Cohort)

**Symptom**: The dashed evidence line goes above the dotted midpoint line in epoch B.
This violates the invariant that midpoint ≥ evidence in window mode.

**Root cause**: Denominator inconsistency. Evidence uses bucket-level `sum_y/sum_x`
which in some τ ranges only includes mature Cohorts with higher rates. Midpoint uses
the full augmented group including immature Cohorts forecast at their (lower) CDF-ratio
rates.

**Current state**: Partially addressed by changing evidence to `sum_y/sum_x` (all
Cohorts, including frozen carry-forward from immature). But the bucket only has real
data from mature Cohorts at high τ — immature Cohorts contribute their frozen y (lower
than their eventual y) while the midpoint uses their CDF-ratio forecast y (higher).

**The fixture should expose this**: with 7 Cohorts at different maturity levels in
epoch B, the evidence/midpoint ordering should be verifiable at each τ.

### Bug 2: Fan too narrow for multi-Cohort groups

**Symptom**: Fan width is ~3pp for n=983 at 69% completeness. Implausibly narrow.

**Root cause**: Conditional variance over-constrains when n is large. The formula
`V(τ) − C(τ,τ_obs)² / V(τ_obs)` can reduce variance almost to zero when the
observation has high precision (large n). The binomial noise term `V_binomial` was
added to weaken the conditioning for finite samples, but it may still be insufficient
for multi-Cohort groups.

**Current multi-Cohort fan aggregation** (cohort_forecast.py ~line 536):
```python
# Weighted average conditional half-width across immature Cohorts
avg_hw = total_hw_x / total_x_immature
immature_fraction = total_x_immature / total_x_aug
var_param = (avg_hw * immature_fraction) ** 2

# Binomial sampling variance for the forecast increment
immature_x_fraction = total_x_immature / total_x_aug
var_binomial = midpoint * (1 - midpoint) / total_x_aug * immature_x_fraction

fan_hw = sqrt(var_param + var_binomial)
```

The `immature_fraction` scaling may be overly aggressive. As the immature fraction
drops (more Cohorts mature at high τ), the fan collapses faster than it should.

---

## 9. What the Fork Looks Like (Implementation Plan)

### 9.1 Fixture JSON file

Location: `graph-editor/lib/runner/test_fixtures/fan_test_1.json`

Contains ALL arguments to `compute_cohort_maturity_rows()`:
```json
{
    "description": "7-Cohort window(1-Jan:7-Jan), sweep to 13-Jan, p=0.83, factor=0.8",
    "frames": [ ... ],
    "graph": { ... },
    "target_edge_id": "test-edge-1",
    "edge_params": { ... },
    "anchor_from": "2026-01-01",
    "anchor_to": "2026-01-07",
    "sweep_to": "2026-01-13",
    "is_window": true,
    "axis_tau_max": 60
}
```

### 9.2 Fork in api_handlers.py (~line 1518)

```python
# Before the compute_cohort_maturity_rows call:
_test_fixture = data.get('test_fixture') or data.get('display_settings', {}).get('test_fixture')
if _test_fixture:
    from runner.cohort_forecast import load_test_fixture
    _fixture = load_test_fixture(_test_fixture)
    maturity_rows = compute_cohort_maturity_rows(**_fixture)
else:
    # existing production code path
    maturity_rows = compute_cohort_maturity_rows(
        frames=result['frames'], graph=graph, ...
    )
```

### 9.3 Fixture loader in cohort_forecast.py

```python
def load_test_fixture(fixture_name: str) -> Dict[str, Any]:
    """Load a test fixture JSON and return kwargs for compute_cohort_maturity_rows."""
    import json, os
    fixture_dir = os.path.join(os.path.dirname(__file__), 'test_fixtures')
    path = os.path.join(fixture_dir, f'{fixture_name}.json')
    with open(path) as f:
        data = json.load(f)
    return {
        'frames': data['frames'],
        'graph': data['graph'],
        'target_edge_id': data['target_edge_id'],
        'edge_params': data['edge_params'],
        'anchor_from': data['anchor_from'],
        'anchor_to': data['anchor_to'],
        'sweep_to': data['sweep_to'],
        'is_window': data.get('is_window', True),
        'axis_tau_max': data.get('axis_tau_max'),
    }
```

### 9.4 FE URL param wiring

In `analysisComputePreparationService.ts`, `runBackendAnalysis()`:
```typescript
// Detect URL param
const testFixture = new URLSearchParams(window.location.search).get('test_fixture');

// Include in request (via display_settings or top-level)
const request: AnalysisRequest = {
    scenarios: [...],
    query_dsl: queryDsl,
    analysis_type: analysisType,
    ...(displaySettings ? { display_settings: displaySettings } : {}),
    ...(testFixture ? { test_fixture: testFixture } : {}),
};
```

Also add `test_fixture?: string` to `AnalysisRequest` interface in graphComputeClient.ts:1852.

And ensure the cache key includes it (graphComputeClient.ts:1391):
```typescript
+ (testFixture ? `|tf:${testFixture}` : '')
```

### 9.5 Python test

```python
# test_cohort_fan_harness.py
from runner.cohort_forecast import compute_cohort_maturity_rows, load_test_fixture

def test_fixture_fan_test_1():
    fixture = load_test_fixture('fan_test_1')
    rows = compute_cohort_maturity_rows(**fixture)

    # Invariant: midpoint ≥ evidence in window mode (epoch B)
    for r in rows:
        if r['midpoint'] is not None and r['rate'] is not None:
            assert r['midpoint'] >= r['rate'] - 1e-9

    # Invariant: midpoint monotonically increasing
    midpoints = [(r['tau_days'], r['midpoint']) for r in rows if r['midpoint'] is not None]
    for i in range(1, len(midpoints)):
        assert midpoints[i][1] >= midpoints[i-1][1] - 1e-9

    # Invariant: fan contains midpoint
    for r in rows:
        if r['fan_upper'] is not None and r['midpoint'] is not None:
            assert r['fan_lower'] <= r['midpoint'] <= r['fan_upper']

    # Invariant: fan zero-width at boundary
    boundary = [r for r in rows if r['tau_days'] == r['tau_solid_max']]
    for r in boundary:
        if r['fan_upper'] is not None:
            assert abs(r['fan_upper'] - r['fan_lower']) < 0.001

    # Invariant: fan opens (width increases from boundary)
    fan_rows = [(r['tau_days'], r['fan_upper'] - r['fan_lower'])
                for r in rows if r['fan_upper'] is not None and r['fan_lower'] is not None]
    # Check fan at τ=30 is wider than at τ=boundary+1
    # ... (specific assertions depend on fixture params)
```

---

## 10. What Has Been Built So Far

### Completed

- `confidence_bands.py`: Refactored with `_jacobian_at()`, `_quadratic_form()`,
  `_bilinear_form()` helpers. Added `compute_conditional_confidence_band()` with
  `n_obs` for binomial noise.
- `cohort_forecast.py`: Complete `compute_cohort_maturity_rows()` function with
  per-Cohort per-τ lookup, bucket aggregation, calibrated CDF ratio midpoint,
  conditional fan with binomial noise, epoch splitting.
- `api_handlers.py`: Wired `compute_cohort_maturity_rows()` into
  `_handle_snapshot_analyze_subjects()`. Added fallback for subjects without Bayes
  params. Added `evidence_retrieved_at` from `p.evidence.retrieved_at`.
- `graphComputeClient.ts`: Gutted all FE-side bucket aggregation. Now reads
  `maturity_rows` from BE, passes through. Collects from ALL matching blocks
  (epoch stitching via `blocks.filter()`).
- `cohortComparisonBuilders.ts`: Chart builder draws solid/dashed/dotted/fan.
  Fan polygon with `smooth: false`. Per-scenario epoch boundaries from row data.
- `test_cohort_fan_controlled.py`: 17 controlled tests, all pass. Covers single
  Cohort midpoint, fan width, multi-Cohort epoch B, CDF ratio, conditional band.
- `cohort-maturity-fan-chart-spec.md`: Full spec document.

### Not yet built

- Test fixture JSON file
- Fork in api_handlers.py for fixture loading
- FE URL param wiring
- Fixture-based Python test
- `test_fixtures/` directory created but empty

### Not yet started (Phase 2)

- cohort() mode (moving denominator, upstream x forecasting)
- Removal of diagnostic prints from production code
- Spec update to reflect current implementation state

---

## 11. Bugs Fixed During Development

| Bug | Root cause | Fix |
|-----|-----------|-----|
| FE computing fan/midpoint | Logic in FE instead of BE | Gutted all FE computation, moved to `compute_cohort_maturity_rows()` |
| Fan suddenly wide at epoch C | `fraction_forecast` used current row's `evidence_rate` (null in C) | Use `ev_rate_at_boundary` as constant |
| Gap between epochs A and B | Midpoint null at `tau_solid_max` | Changed `tau <= tau_solid_max` to `tau < tau_solid_max` |
| Polygon edge bulge | ECharts `smooth: 0.3` spline overshoot | Changed to `smooth: false` |
| FE not finding maturity_rows | `blocks.find()` returned first epoch (empty) | Changed to `blocks.filter()` for all epochs |
| f-string format error | Ternary inside f-string format spec | Pre-compute formatted strings |
| Fan too narrow | Conditional variance over-constrains with large n | Added `n_obs` to binomial noise in observation |

---

## 12. Existing Test Suite (test_cohort_fan_controlled.py)

17 tests, all passing. Classes:

- **TestSingleCohortMidpoint** (4 tests): monotonicity, boundary equality,
  exceeds evidence in C, calibrated to evidence (not generic model)
- **TestFanWidth** (4 tests): zero at boundary, opens in C, wider with small n,
  contains midpoint
- **TestMultiCohortEpochB** (3 tests): epoch B rows exist, midpoint ≥ evidence,
  midpoint monotonic across epochs
- **TestCDFRatioCalibration** (3 tests): ratio=1 at boundary, monotonically
  increasing, converges to 1/CDF(tau_max)
- **TestConditionalBand** (3 tests): near-zero at observation, wider with small n,
  opens from observation

Uses helpers `make_single_cohort_frames()` and `make_graph()` with hardcoded
`EDGE_PARAMS` (mu=2.0, sigma=0.5, onset=2.0, p=0.80).

**User's objection**: These tests use toy synthetic frames with manually specified
`y_by_tau` values. They don't test with realistic multi-day evidence accrual from
a distribution, don't cover a sensible range of parameters, and can't be visually
verified in the browser.

---

## 13. User Preferences & Corrections (from this thread)

1. **ALL computation in Python BE. FE is rendering only. NO MATHS IN FE.**
   Violated repeatedly; user furious each time.

2. **Don't create overkill infrastructure.** Synthetic graphs just to test fan
   maths is overkill. Fork production code with a param instead.

3. **One JSON fixture file.** Not a fixture generator framework, not multiple
   fixture files, not a parametric test suite. One file, one dataset.

4. **Same param works in browser.** The user must be able to see exactly what
   the test sees. `&test_fixture=fan_test_1` in the URL.

5. **Evidence must accrue from a distribution × FACTOR.** Not arbitrary
   hand-picked y values. Generate y from `p_actual × CDF(τ)` where
   `p_actual = 0.8 × p_model`. This creates realistic data shape.

6. **"Cohort" always capital C.** "Immature" not "dropped."

7. **Fan must spread from observation point, not start wide.**

8. **Midpoint uses CDF ratio calibration** — THIS Cohort's performance, never
   reverts to generic model. "We KNOW things about this cohort."

9. **Don't iterate on visual testing without controlled inputs first.** "This is
   an exquisitely painful form of torture — iteratively cycling around obviously
   shit charts rather than testing LOGIC against CONTROLLED inputs."
