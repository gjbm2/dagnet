# Cohort Maturity Fan Chart — Specification

**Status**: Draft — for review before implementation
**Date**: 31-Mar-26

---

## 1. User-Facing Behaviour

The cohort maturity chart plots conversion rate (y/x) against age (τ)
for a group of Cohorts selected by the user's query DSL.

A **Cohort** is one anchor_day's worth of users.

At a given τ, a Cohort is **mature** if it has aged past τ (we have
evidence) or **immature** if it hasn't reached that age yet (we must
forecast).

When Bayesian posteriors are available, the chart shows:

| Visual element | Epoch A | Epoch B | Epoch C |
|----------------|---------|---------|---------|
| **Solid line** (complete evidence) | ✓ | — | — |
| **Dashed line** (incomplete evidence) | — | ✓ | — |
| **Dotted line** (augmented best estimate) | — | ✓ | ✓ |
| **Fan polygon** (uncertainty band) | — | ✓ | ✓ |

- Each scenario gets its own fan in its own colour.
- Model overlay curves (promoted, FE, BE, Bayesian) default to off.
- Without Bayesian posteriors: solid + dashed evidence lines only.

### 1.1 What each element means

- **Solid line**: observed y/x when ALL Cohorts are mature at this τ.
- **Dashed line**: observed y/x from mature Cohorts only.
  Progressively less complete as younger Cohorts become immature.
- **Dotted line**: augmented best estimate — evidence from mature
  Cohorts + model-forecast y for immature Cohorts, properly
  denominated.  Always ≥ the dashed evidence line in window() mode
  (see §5.3).
- **Fan polygon**: uncertainty band centred on the dotted midpoint.

### 1.2 Epochs (per-scenario)

Each scenario has its own anchor range → its own epoch boundaries.

| Epoch | τ range | Description |
|-------|---------|-------------|
| **A** | `0 .. tau_solid_max` | All Cohorts are mature. |
| **B** | `tau_solid_max+1 .. tau_future_max` | Some Cohorts immature. |
| **C** | `> tau_future_max` | All Cohorts immature. |

- `tau_solid_max = sweep_to − anchor_to`
- `tau_future_max = sweep_to − anchor_from`

---

## 2. Phasing

### Phase 1a: window(), single Cohort (§5, §5A)

Simplest case.  One Cohort, fixed x.  No epoch B (tau_solid_max =
tau_future_max).  Epoch A (full evidence) → epoch C (pure forecast).

The fan chart is the conditional uncertainty band: given what we
observed at tau_max, how does uncertainty grow as we project forward?
Uses the conditional variance formula (§5A).

### Phase 1b: window(), multiple Cohorts (§5, §5B)

Fixed x per Cohort but epoch B exists (some Cohorts immature).
Aggregation across Cohorts at different maturity levels.  Each
immature Cohort's y is forecast using the calibrated CDF ratio.
Fan width at each τ aggregates conditional uncertainty across the
Cohort group.

### Phase 2a: cohort(), single Cohort (§10)

Moving denominator.  x grows with τ.  No epoch B.  Requires upstream
x forecasting.

### Phase 2b: cohort(), multiple Cohorts (§10)

Moving denominator + epoch B aggregation.  The hard problem.

---

## 3. Architecture

All computation in Python BE.  FE is rendering only.

```
Python BE (api_handlers.py)
  └─ derive_cohort_maturity() → frames
  └─ annotate_rows() → adds projected_y
  └─ compute_cohort_maturity_rows() → complete per-τ rows
  └─ result['maturity_rows'] = rows

FE (graphComputeClient.ts)
  └─ reads result.maturity_rows
  └─ passes rows through (no computation)

Chart builder (cohortComparisonBuilders.ts)
  └─ draws what the rows say
```

The BE MUST produce `maturity_rows` for every cohort_maturity
subject, regardless of whether Bayes params exist.

---

## 4. Window Mode: What We Know

### 4.1 Per-Cohort data

Each Cohort (one anchor_day) has:
- **x**: count of people who entered at the from-node on that date.
  FIXED — does not grow with τ.
- **y(τ)**: cumulative conversions by age τ.  Grows with τ.
- **tau_max**: the Cohort's max observed age = `sweep_to − anchor_day`.
  At τ ≤ tau_max the Cohort is mature; at τ > tau_max it is immature.

### 4.2 What the frames provide

One frame per calendar day in the sweep.  Each frame has one
data_point per Cohort (anchor_day) with cumulative (x, y, a) as
observed at that frame date.  Carry-forward: if a Cohort wasn't
retrieved on a given day, the previous day's values persist.

After `annotate_rows`, each data_point also has:
- `projected_y`: model-predicted total conversions at this τ
- `completeness`: fraction of eventual conversions observed so far
- `evidence_y`, `forecast_y`: observed vs predicted split

### 4.3 τ derivation

`τ = frame_date − anchor_day`.  Each Cohort appears once per frame
with a unique τ for that frame.

### 4.4 Per-Cohort per-τ lookup

From all frames, build: `cohort_at_tau[anchor_day][τ] = (x, y)`.
This gives the actual observed x/y for a specific Cohort at a
specific age.  Essential for the midpoint calculation — we need
each mature Cohort's actual (x, y) at the specific τ being computed,
not its last-frame frozen values.

---

## 5. Per-τ Row Computation (Window Mode)

### 5.1 Evidence rate

Bucket aggregation across all frames.  For each τ:

**Epoch A** (`τ ≤ tau_solid_max`):  all Cohorts mature.
```
rate = Σy / Σx   (all Cohorts)
```

**Epoch B** (`tau_solid_max < τ ≤ tau_future_max`):  some immature.
```
rate = Σy_mature / Σx_mature   (mature Cohorts only)
```

**Epoch C** (`τ > tau_future_max`):  all immature.
```
rate = null
```

A Cohort is "mature at τ" when `τ ≤ its tau_max`.

### 5.2 Midpoint (augmented best estimate)

For each τ in epochs B+C, iterate all Cohorts:

- **Mature Cohort at this τ**: contribute observed (x, y) from
  `cohort_at_tau[anchor_day][τ]` — the actual values at this age.
- **Immature Cohort at this τ** (window mode): x is fixed.
  y is forecast using the **calibrated CDF ratio** (see §5.2.1).

#### 5.2.1 Immature Cohort y forecast: calibrated CDF ratio

An immature Cohort has observed `y_frozen` conversions up to its
`tau_max`.  It cannot un-convert — `y_frozen` is a floor.  The model
tells us the SHAPE of how remaining conversions arrive (via the CDF),
but we calibrate to THIS Cohort's actual performance:

```
y_forecast(τ) = y_frozen × CDF(τ) / CDF(tau_max)
```

where CDF uses this edge's Bayes params.

Why this works:
- At τ = tau_max: `y_forecast = y_frozen × 1 = y_frozen`.  Continuous.
- At τ → ∞: `y_forecast → y_frozen / CDF(tau_max)`.  This is the
  Cohort's own implied eventual y, extrapolated from its actual
  performance using the model's shape.  NOT the generic model's p.
- `CDF(τ) / CDF(tau_max) ≥ 1` always (CDF monotonically increasing),
  so `y_forecast ≥ y_frozen` always.  Conversions only go up.
- If the Cohort outperforms the model, that outperformance is
  preserved.  If it underperforms, that is preserved too.  It never
  reverts to the generic model.

The rate: `y_forecast / x = evidence_rate × CDF(τ) / CDF(tau_max)`.

#### 5.2.2 Midpoint aggregation

```
For each Cohort:
  if mature at τ:
    contribute (x, y) from cohort_at_tau[anchor_day][τ]
  if immature at τ:
    contribute (x_frozen, y_frozen × CDF(τ) / CDF(tau_max_i))

midpoint = Σy / Σx
```

Null in epoch A (all Cohorts mature → midpoint = evidence).

### 5.3 Why midpoint ≥ evidence (window mode)

In window mode, x is fixed per Cohort.  For immature Cohorts:
- `x_forecast = x_frozen` (same x — window mode)
- `y_forecast = y_frozen × CDF(τ) / CDF(tau_max) ≥ y_frozen`

The midpoint denominator = evidence denominator (same x values).
The midpoint numerator ≥ evidence numerator (forecast y ≥ frozen y).

Therefore: `midpoint ≥ evidence` is guaranteed in window mode.

(This guarantee does NOT hold in cohort() mode — see §10.5.)

### 5.4 Fan bounds and conditional uncertainty

The fan must **spread out from the evidence endpoint** — at the
last observed τ, uncertainty is near zero (we have data); as we
project further, uncertainty grows.

This requires **conditional** uncertainty: the variance in rate(τ)
GIVEN that we observed rate(tau_max).

See §5A for single-Cohort treatment, §5B for multiple Cohorts.

### 5.5 projected_rate

- Epochs A+B: from bucket `sum_proj_y / sum_proj_x` (backend annotation)
- Epoch C: = midpoint

---

## 5A. Phase 1a: Single Cohort Fan Chart (window mode)

One Cohort, one x, one y(τ) curve.  `tau_solid_max = tau_future_max`.
Epoch B has zero width: A → C directly.

### 5A.1 Midpoint in epoch C

```
midpoint(τ) = (y_frozen / x) × CDF(τ) / CDF(tau_max)
            = evidence_rate × CDF(τ) / CDF(tau_max)
```

Continuous at the boundary.  Calibrated to this Cohort.

### 5A.2 Conditional variance formula

Using the delta method, rate(τ) and rate(tau_max) are jointly
normal (approximately), both depending on parameters θ = (p, μ, σ, onset):

```
rate(τ)       ≈ rate_model(τ)       + J(τ) · δθ
rate(tau_max) ≈ rate_model(tau_max) + J(tau_max) · δθ
```

where `J(τ) = [∂rate/∂p, ∂rate/∂μ, ∂rate/∂σ, ∂rate/∂onset]` at τ,
and `δθ ~ N(0, Σ)` with Σ the posterior covariance matrix.

The conditional variance of rate(τ) given that we observed
rate(tau_max) = evidence_rate:

```
Var[rate(τ) | rate(tau_max)] = V(τ) − C(τ, τ_m)² / V(τ_m)
```

where:
- `V(τ) = J(τ) · Σ · J(τ)ᵀ`                   — marginal variance at τ
- `V(τ_m) = J(τ_m) · Σ · J(τ_m)ᵀ`              — marginal variance at tau_max
- `C(τ, τ_m) = J(τ) · Σ · J(τ_m)ᵀ`             — cross-covariance

### 5A.3 Properties

**At τ = tau_max**: `C = V(τ_m)`, so conditional variance = 0.
Fan width = 0.  We have direct evidence — no uncertainty.  ✓

**At τ slightly past tau_max**: conditional variance is small.
Fan opens gradually.  ✓

**At intermediate τ (CDF transition region)**: fan is widest.
Multiple parameters (μ, σ, onset) contribute to CDF sensitivity
here.  ✓

**At τ → ∞ (maturity)**:
- `J(∞) = [1, 0, 0, 0]` (only p matters; CDF → 1)
- `V(∞) = Var(p)`
- `C(∞, τ_m) = CDF(τ_m) × Var(p)` (only p-p covariance survives)
- Conditional variance = `Var(p) × [1 − CDF(τ_m)² × Var(p) / V(τ_m)]`

This is a fraction of Var(p), NOT zero and NOT full Var(p):
- If tau_max is late (CDF(τ_m) ≈ 1): we've nearly measured p.
  Conditional variance ≈ 0.  Fan closes.  ✓
- If tau_max is early (CDF(τ_m) ≈ 0.3): p is poorly constrained.
  Conditional variance ≈ most of Var(p).  Fan stays wide.  ✓

The asymptotic band width is the portion of p uncertainty NOT
already constrained by the observation at tau_max.  This is the
correct physical behaviour.

### 5A.4 Fan bounds (single Cohort)

```
fan_half_width(τ) = k × sqrt(Var_cond(τ))

fan_centre(τ) = midpoint(τ)    (= evidence_rate × CDF(τ) / CDF(tau_max))

fan_upper(τ) = min(1, fan_centre + fan_half_width)
fan_lower(τ) = max(0, fan_centre − fan_half_width)
```

where k = z-multiplier for confidence level (1.645 for 90%, etc.).

### 5A.5 Implementation

Extend `compute_confidence_band` (or add a sibling function) to
compute the conditional band.  Inputs:

- All existing inputs (ages, p, mu, sigma, onset, SDs, correlation)
- Plus: `tau_observed` — the τ at which we have direct evidence

The function computes `V(τ)`, `C(τ, τ_observed)`, `V(τ_observed)`
at each τ, then returns conditional band bounds.

The Jacobian computation already exists in `confidence_bands.py`.
The new part is computing the cross-covariance `C(τ, τ_observed)`
at each τ, which uses the same Jacobian evaluated at `τ_observed`
(computed once) dotted with the Jacobian at each τ via Σ.

### 5A.6 Determining tau_observed

`tau_observed` is NOT simply `sweep_to − anchor_day`.  The sweep may
extend beyond the last real retrieval using carry-forward frames.
Evidence at the carry-forward ages is stale — the same y/x as at
the last real retrieval.  Using a stale tau_observed makes the
conditional band too narrow (the observation "constrains" at an age
the Cohort hasn't truly reached).

The correct `tau_observed` is the last τ at which REAL evidence
was obtained — where y actually changed (increased) or where a
genuine retrieval occurred.

**Heuristic**: walk backwards from the last frame to find the last
τ where `y` increased from the previous τ.  If y was always static,
use the first τ where y > 0.  If y is always 0, the Cohort has no
real evidence — fall back to unconditional band.

**Better (future)**: mark each frame's data_points as `is_real` vs
`is_carry_forward` in `derive_cohort_maturity`, and use the last
`is_real` frame for tau_observed.

This is a **critical correctness issue** — using the wrong
tau_observed makes the fan far too narrow.

---

## 5B. Phase 1b: Multiple Cohorts Fan Chart (window mode)

Multiple Cohorts, each with different tau_max.  Epoch B exists.

### 5B.1 Midpoint (same as §5.2)

Aggregation across mature + immature Cohorts using the calibrated
CDF ratio for each immature Cohort's y forecast.

### 5B.2 Fan width: aggregation challenge

Each Cohort has its own tau_max and therefore its own conditional
uncertainty.  The fan for the aggregate rate must combine these.

At each τ in epoch B+C, the aggregate rate is:

```
rate_agg(τ) = Σ_i y_i(τ) / Σ_i x_i
```

For mature Cohorts, y_i is observed (no uncertainty).
For immature Cohorts, y_i is forecast with conditional variance.

The variance of the aggregate:

```
Var[rate_agg(τ)] = Σ_i (x_i / Σx)² × Var_cond_i(τ)
```

where `Var_cond_i(τ)` is the conditional variance for Cohort i
(zero for mature Cohorts; computed per §5A.2 for immature ones
using that Cohort's tau_max_i as the conditioning point).

Note: immature Cohorts share the same model parameters, so their
forecast errors are correlated.  The correct formula includes
covariance terms:

```
Var[rate_agg(τ)] = Σ_i Σ_j (x_i × x_j / (Σx)²) × Cov_cond_ij(τ)
```

where `Cov_cond_ij(τ)` is the conditional covariance between
Cohort i's and Cohort j's forecast errors, both conditioned on
their respective observations.

For two immature Cohorts i and j with tau_max_i and tau_max_j:

```
Cov_cond_ij(τ) = J(τ)·Σ·J(τ)ᵀ
               − [J(τ)·Σ·J(τ_m_i)ᵀ × J(τ)·Σ·J(τ_m_j)ᵀ] / ...
```

This gets complex.  A practical simplification: treat all immature
Cohorts' errors as perfectly correlated (conservative — overestimates
the fan width).  Then:

```
fan_half_width_agg(τ) ≈ (Σ_immature x_i / Σx) × max_i(fan_half_width_i(τ))
```

Or use the weighted average conditional SD across immature Cohorts.

**Decision needed**: exact covariance treatment vs conservative
approximation.  For Phase 1b, the conservative approximation may
suffice.

---

## 6. Frames Data Shape

```python
{
    "as_at_date": "2026-03-15",
    "data_points": [
        {
            "anchor_day": "2026-03-01",
            "y": 42,           # cumulative conversions
            "x": 100,          # from-node arrivals (fixed in window mode)
            "a": 200,          # anchor entrants
            "rate": 0.42,
            # After annotate_rows:
            "completeness": 0.65,
            "layer": "evidence",
            "evidence_y": 42,
            "forecast_y": 12,
            "projected_y": 54,
        },
        ...
    ],
}
```

---

## 7. Epoch Splitting and Stitching

### 7.1 The FE sends epoch-split subjects

Multiple subjects per logical subject: `subject_id::epoch:0`,
`::epoch:1`, etc.  Each epoch has its own `sweep_from`/`sweep_to`
and `slice_keys`.

### 7.2 BE processes each independently

One `compute_cohort_maturity_rows` call per epoch subject.

### 7.3 FE stitches

Collapses `::epoch:N` from subject IDs, merges `maturity_rows`
from all epochs.  Per-τ rows from different epochs don't overlap
(different sweep ranges → different τ values).

### 7.4 Sparse buckets

The function receives frames for one epoch only.  Some τ values
in the range [0, max_tau] will have no bucket data (covered by
other epochs' frames).  Rows are only emitted for τ values where
bucket data or model data exists.

---

## 8. Continuity

### 8.1 A → B boundary

All Cohorts still mature.  `rate` is continuous.  Midpoint starts
at null (or = evidence).  Fan starts at zero width.

### 8.2 B → C boundary

Last mature Cohort becomes immature.  Midpoint switches from using
observed (x, y) to forecast for that Cohort.  The forecast at
τ_max + 1 is close to observed at τ_max (one day's increment).

Approximate continuity.  Small jump acceptable.

### 8.3 Evidence → midpoint at epoch C

Dashed evidence line ends.  Dotted midpoint continues.  Any gap
between them at the boundary represents the model's predicted
additional conversion from the immature fraction.

---

## 9. Edge Cases

### 9.1 No Bayes posteriors

Rows have `rate` and `projected_rate` only.  midpoint/fan null.
Chart shows solid + dashed evidence lines.

### 9.2 Single Cohort

`tau_solid_max = tau_future_max`.  Epoch B is zero width.
Chart: solid (A) → dotted + fan (C).

### 9.3 Zero x Cohort

Skipped in all aggregations.

### 9.4 Band data doesn't cover all τ

Fan null for those τ.  Midpoint still computed.

### 9.5 Epoch gaps

Gap epochs produce empty frames → no maturity_rows.

### 9.6 No incoming edges (from-node is a start node)

Window mode: doesn't matter (x is fixed, no upstream needed).
Cohort mode (Phase 2): fall back to x_frozen.

---

## 10. Phase 2: cohort() Mode

### 10.1 The core difference: x is not fixed

In cohort() mode, each Cohort is anchored at node A (the anchor
node).  x at this edge's from-node is the count of A-entrants that
have completed the upstream path A → from-node.  This grows with τ
— more members of the Cohort are still arriving upstream.

At any τ:  `x(τ) ≈ a × upstream_path_rate(τ)`

where `a` is the anchor population and `upstream_path_rate` is the
composed CDF from anchor to from-node.

When a Cohort is immature at τ (hasn't aged past τ), x_frozen is NOT
its true x at that age — more members are still arriving upstream.
This is the fundamental complication.

### 10.2 Upstream x forecasting

For an immature Cohort at age τ > tau_max:

```
x_forecast(τ) = x_frozen × upstream_rate(τ) / upstream_rate(tau_max)
```

This scales the last-observed x by the ratio of how much the upstream
CDF has advanced since the Cohort's evidence froze.

**upstream_rate(τ)** is computed from the edges incoming to this
edge's from-node.  Each incoming edge carries path-level Bayes params
(composed by the inference engine from anchor all the way to that
edge's target, which IS this edge's from-node).  So:

```
upstream_rate(τ) = Σ forecast_rate(τ, p_i, mu_i, sigma_i, onset_i)
```

summed across incoming edges i.  No recursive graph traversal needed —
the path-level params already compose the full upstream chain.

### 10.3 y forecasting (same as window mode)

```
y_forecast(τ) = x_forecast(τ) × edge_rate(τ)
```

where `edge_rate(τ) = p × CDF(τ; mu, sigma, onset)` uses this edge's
cohort-level Bayes params (`path_mu`, `path_sigma`, `path_onset`,
`posterior_p_cohort`).

Note: in cohort() mode the edge's CDF params are path-level (composed
from anchor to target), not edge-level.  This is because the Cohort
is anchored at A, not at x.

### 10.4 Midpoint computation

Same structure as window mode but with forecast x:

```
For each Cohort:
  if mature at τ:
    use cohort_at_tau[anchor_day][τ] → actual (x, y) at this age
  if immature at τ:
    x_forecast = x_frozen × upstream_rate(τ) / upstream_rate(tau_max)
    y_forecast = x_forecast × edge_rate(τ)

midpoint = Σy_augmented / Σx_augmented
```

### 10.5 midpoint vs evidence: the denominator problem

In window mode, midpoint ≥ evidence is guaranteed because x is fixed
(same denominators).

In cohort() mode, this guarantee BREAKS.  Here's why:

```
evidence_rate = Σy_mature / Σx_mature

midpoint = (Σy_mature + Σy_forecast) / (Σx_mature + Σx_forecast)
```

`Σx_forecast` includes forecast x for immature Cohorts, which may be
larger than x_frozen (because x grows upstream).  And `Σy_forecast`
is the model's predicted y for those Cohorts.

If the forecast rate `y_forecast / x_forecast` is lower than the
mature evidence rate `Σy_mature / Σx_mature`, the midpoint is pulled
below evidence.  This happens when mature Cohorts outperform the
model — the immature Cohorts (represented by the model at their
forecast rate) dilute the aggregate.

**This is mathematically correct.**  The full-group estimated rate IS
lower than the mature-subset rate when the model predicts immature
Cohorts convert at a lower rate.

**But it's visually confusing** — the dotted "augmented" line sits
below the dashed "incomplete" line.

#### Options

1. **Accept it.**  The midpoint is the honest full-group estimate.
   The user sees that mature Cohorts outperform the model's
   prediction for the immature ones.  This is real information.

2. **Show both lines but label clearly.**  The dashed line is
   "mature Cohorts" (a biased subset).  The dotted line is
   "all Cohorts (estimated)" (the unbiased estimate).  It's correct
   for the dotted line to be lower when the subset is biased upward.

3. **Use the same denominator for both.**  If the evidence line also
   uses the full-group denominator (including carry-forward x from
   immature Cohorts), then both lines share a base and midpoint ≥
   evidence holds.  But the evidence line then sags below the
   epoch A solid line (because the denominator grows while frozen y
   lags), which is also visually confusing.

**Decision needed.**

### 10.6 Upstream data availability

The scenario graph carries Bayes posteriors on each edge (properly
contexted per scenario via `reprojectPosteriorForDsl`).  The incoming
edges to the from-node can be found with `get_incoming_edges(graph,
from_node_id)`.  Each edge's params are read with
`read_edge_cohort_params(edge)`, which prefers path-level posteriors.

If no incoming edges have Bayes params (e.g. the from-node is a start
node, or posteriors haven't been computed), upstream_rate returns None
and the code falls back to `x_frozen` (assume x doesn't grow).  This
is equivalent to window mode behaviour — a safe degradation.

### 10.7 Edge cases specific to cohort() mode

**From-node is the anchor node (single-edge path)**:
There's no upstream path.  x = a (all anchor entrants arrive
directly).  x is effectively fixed.  Equivalent to window mode.

**Multiple incoming edges**:
upstream_rate sums forecast_rate across all incoming edges.  This
handles branching/merging in the graph topology.

**Upstream params are stale or missing for some edges**:
Edges without params are skipped in the sum.  If ALL incoming edges
lack params, falls back to x_frozen.

**upstream_rate(tau_max) ≈ 0**:
Division by near-zero.  Guard: if `upstream_rate(tau_max) < epsilon`,
fall back to x_frozen.

### 10.8 Test complexity

cohort() mode tests require:
- A multi-edge graph with Bayes posteriors on upstream edges
- Snapshot DB data with per-Cohort per-day frames
- Verification that x_forecast grows correctly with τ
- Verification of midpoint when forecast rate < mature evidence rate
- Verification of fallback when upstream params are missing

This is significantly more complex than window() mode tests.

---

## 11. Output Row Schema

Each row in `maturity_rows`:

```python
{
    'tau_days': int,
    'rate': float | None,          # evidence rate (null in epoch C)
    'projected_rate': float | None,
    'midpoint': float | None,      # augmented estimate (null in epoch A)
    'fan_upper': float | None,
    'fan_lower': float | None,
    'tau_solid_max': int,
    'tau_future_max': int,
    'boundary_date': str,          # sweep_to ISO date
    'cohorts_covered_base': int,   # mature Cohorts at this τ
    'cohorts_covered_projected': int,
}
```
