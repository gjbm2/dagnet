# Cohort Maturity Curves — Full Bayes Design

**Status**: Draft design with partial implementation; some sections below
describe target state rather than the exact current code
**Date**: 1-Apr-26
**Updated**: 7-Apr-26
**Supersedes**: The CDF-ratio midpoint formula in cohort-maturity-fan-chart-spec.md §5.2.1
**Related**: cohort-maturity-fan-chart-spec.md, fan-chart-mc-bug.md, cohort-forecast-conditioning-attempts-1-Apr-26.md

---

## 0. Current implementation delta (7-Apr-26)

This note still captures the intended algebra, but the implementation has
already moved beyond several assumptions in the original draft.

**Already in code**:

- `cohort_forecast.py` now uses direct posterior draws, not the older global
  importance-sampling approach.
- The fan uses a posterior-predictive simulator with per-Cohort drift and
  local frontier conditioning, not the earlier conditional-band-only path.
- `tau_observed` is derived from real evidence depth, preferring
  `evidence_retrieved_at` over sweep-derived age.
- Epoch B carry-forward is implemented via dense `obs_x` and `obs_y` arrays.
- The main Bayes path now uses `calculate_path_probability()` and threads
  `anchor_node_id` into cohort-mode reach computation.

**Still not implemented from this design**:

- The subject-conditioned upstream forecast proposed in §7.4.
- A graph-wide propagation engine for `x(s,τ)` state.
- A principled convolution replacing the current `Y_C` shortcut discussed in
  §7.5.

Read this document as: "target algebra plus live implementation gaps", not as
"a verbatim description of the current code path".

---

## 1. Problem Statement

The current immature-Cohort forecast uses direct CDF scaling:

```
y_forecast(τ) = y_frozen × CDF(τ) / CDF(tau_max)       (midpoint)
y_forecast = k_i + (N_i − k_i) × (q − q_a) / (1 − q_a) (MC fan)
```

Both formulas break when Cohorts are very immature (low τ_max, CDF near
zero):

- **Midpoint**: `CDF(tau_max)` in the denominator → ratio explodes.
  Current guard (`> 0.01` threshold) creates a cliff, not a smooth
  transition.
- **MC fan**: sparse evidence means stochastic draws dominate, causing
  collapse to near-zero midpoints and zero-width bands.

The root cause is that both formulas are **frequentist extrapolation** —
"observed / completeness" — which has infinite variance when completeness
is small.  Prior attempts to fix this with heuristic guards (hard clips,
effective sample size, conditional rate blending) were reverted because
they mixed numerical stabilisation with modelling assumptions.

The fix: proper Bayesian updating that naturally blends prior (model)
with likelihood (evidence) as a function of effective sample size, which
itself is a function of completeness/maturity.

---

## 2. The Bayesian Update

### 2.1 Setup

For each immature Cohort *i* at its observation age τ_max_i:

| Symbol | Meaning | Source |
|--------|---------|--------|
| `r` | True conversion rate at this edge | To be estimated |
| `α₀, β₀` | Prior Beta parameters | Edge posterior (`alpha`/`beta` or `path_alpha`/`path_beta`) |
| `k_i` | Observed conversions | `y_frozen` from frames |
| `x_i` | Observed from-node arrivals | `x_frozen` from frames |
| `c_i` | Completeness at τ_max_i | `CDF(τ_max_i; onset, mu, sigma)` |

### 2.2 Prior

The model says the Cohort's conversion rate is:

```
r ~ Beta(α₀, β₀)
```

where `α₀` and `β₀` come from the Bayesian inference posterior on this
edge.  The prior mean is `α₀ / (α₀ + β₀)` and the prior concentration
is `κ = α₀ + β₀` (effective prior sample size).

### 2.3 Effective trials

At age τ_max_i, the Cohort has had `x_i` arrivals at the from-node, but
only a fraction `c_i = CDF(τ_max_i)` of those have had their full
conversion window elapse.  The effective number of "resolved" trials is:

```
n_eff_i = x_i × c_i
```

Of these, `k_i` converted.  The remaining `x_i × (1 − c_i)` arrivals
are still in their conversion window — their outcome is unknown, not
negative.

### 2.4 Posterior

```
r | data ~ Beta(α₀ + k_i, β₀ + n_eff_i − k_i)
```

Posterior mean:

```
E[r | data] = (α₀ + k_i) / (α₀ + β₀ + n_eff_i)
```

### 2.5 Regime behaviour

| Maturity | c_i | n_eff_i | Posterior |
|----------|-----|---------|----------|
| Very immature | ≈ 0 | ≈ 0 | ≈ prior (trust model) |
| Partially mature | 0.5 | x_i/2 | Balanced blend |
| Fully mature | ≈ 1 | ≈ x_i | Dominated by evidence |

The transition is **smooth**, governed by `n_eff_i` growing with `c_i`.
No threshold guards, no cliffs, no heuristics.

### 2.6 Forecast at age τ > τ_max_i

Expected conversions at age τ:

```
E[y_i(τ)] = k_i + x_i × [CDF(τ) − CDF(τ_max_i)] × E[r | data]
```

The first term preserves observed conversions (can't un-convert).  The
second term uses the posterior rate to predict additional conversions in
the remaining CDF window.

Equivalently, the total expected count:

```
E[y_i(τ)] = k_i + x_i × [CDF(τ) − c_i] × (α₀ + k_i) / (α₀ + β₀ + n_eff_i)
```

### 2.7 Comparison with current CDF-ratio formula

Current formula:

```
y_forecast = y_frozen × CDF(τ) / CDF(tau_max)
```

This is the **maximum-likelihood estimator** (MLE): it infers the rate
as `k / (x × c)` and projects forward.  When `c` is small, the MLE has
enormous variance.

The Bayesian formula shrinks toward the prior when evidence is weak:
- At c ≈ 0: `E[y(τ)] ≈ x × CDF(τ) × α₀/(α₀+β₀)` — pure model prediction.
- At c ≈ 1: `E[y(τ)] ≈ k + x × [CDF(τ) − c] × k/(x×c)` — approaches
  the CDF-ratio formula.  The two converge when evidence is strong.

---

## 3. Denominator Policy (cohort mode)

### 3.1 The problem

In cohort() mode, `x` grows with τ (upstream arrivals are still coming).
For an immature Cohort, `x_frozen` understates `x(τ)`.

If the evidence line uses `x_frozen` while the midpoint uses `x_forecast`,
the denominators diverge and the evidence line is artificially inflated
relative to the midpoint — producing the perverse visual where evidence
sits above the forecast.

### 3.2 Policy: denominator follows f/e flag

| Mode | Evidence line | Midpoint line | Fan | Denominator |
|------|--------------|---------------|-----|-------------|
| **e only** | y_observed / x_frozen | Not shown | Not shown | x_frozen (self-consistent, no forecast context) |
| **f only** | Not shown | Model curve: p × CDF(τ) | Unconditional band | N/A (rate is unitless) |
| **f+e** | y_observed / x_forecast | Posterior predictive / x_forecast | Conditional band | x_forecast (common, ensures midpoint ≥ evidence) |

In **f+e** mode, both lines use `x_forecast` as denominator so they are
directly comparable.  The `midpoint ≥ evidence` guarantee holds because
`y_augmented ≥ y_observed` and the denominators are identical.

In **e only** mode, `x_frozen` is the honest denominator — no forecast
context exists against which denominator mismatch would be misleading.

In **f only** mode, no Cohort-level data is used.  The output is just
the model curve evaluated at the edge's posterior params.

### 3.3 x_forecast computation (cohort mode, f+e)

For an immature Cohort at age τ > tau_max_i:

```
x_forecast_i(τ) = a_i × upstream_path_rate(τ)
```

where `upstream_path_rate(τ)` is computed from the upstream edge(s)'
posterior parameters (already on the graph as `path_mu`, `path_sigma`,
etc.).  Calibrated to the observed x:

```
x_forecast_i(τ) = x_frozen_i × upstream_rate(τ) / upstream_rate(tau_max_i)
```

with the same Bayesian treatment to avoid blow-up when
`upstream_rate(tau_max_i)` is small: use the upstream posterior to
condition the upstream arrival forecast on the observed x_frozen.

### 3.4 Window mode

In window() mode, `x` is fixed per Cohort.  `x_forecast = x_frozen`
always.  The denominator policy simplifies to the same x for all lines
in all modes.

---

## 4. The Three f/e Paths

### 4.1 f+e (blend) — the full computation

This is the primary path.  `visibility_mode` must flow from the scenario
into `compute_cohort_maturity_rows`.

**Inputs**: frames, graph, edge_params (including α₀, β₀), upstream
params (cohort mode only).

**Per-Cohort per-τ**:

1. Compute `c_i = CDF(τ_max_i)` and `n_eff_i = x_i × c_i`.
2. Posterior: `Beta(α₀ + k_i, β₀ + n_eff_i − k_i)`.
3. For τ > tau_max_i:
   - `E[y_i(τ)] = k_i + x_i × [CDF(τ) − c_i] × E[r | data]`
   - In cohort mode: `x_forecast_i(τ)` from upstream posterior.
   - In window mode: `x_forecast_i(τ) = x_frozen_i`.
4. Aggregate across Cohorts: `midpoint = Σ E[y_i] / Σ x_i` (where x_i
   is x_forecast in cohort mode, x_frozen in window mode).

**MC fan (stochastic)**:

For each MC draw *b*:
1. Draw `θ^(b) = (p, mu, sigma, onset)` from MVN posterior.
2. For each immature Cohort, compute the Bayesian posterior for this
   draw: `r^(b) ~ Beta(α₀ + k_i, β₀ + n_eff_i^(b) − k_i)` where
   `n_eff_i^(b) = x_i × CDF(τ_max_i; θ^(b))`.
3. Use the posterior mean (not a sample from it — avoids double
   stochasticity) as the rate for forecasting.
4. Aggregate across Cohorts, collect quantiles.

This naturally produces:
- Zero fan width at τ_max (evidence is direct, no uncertainty).
- Gradually widening fan as τ increases.
- Fan width → unconditional band width as evidence becomes negligible.
- Smooth, well-behaved transition at all maturity levels.

### 4.2 e only — evidence, no forecast

Skip the MC entirely.  For each τ:

- Epoch A: `rate = Σ y_observed / Σ x_frozen` (all Cohorts mature).
- Epoch B: `rate = Σ y_mature / Σ x_mature` (mature Cohorts only).
- Epoch C: no data → no line.

No midpoint, no fan.  `x_frozen` is the denominator (§3.2).

### 4.3 f only — forecast, no evidence

No per-Cohort data used.  Evaluate the model curve:

```
rate(τ) = p × CDF(τ; onset, mu, sigma)
```

Fan: unconditional confidence band from `compute_confidence_band()`
(already implemented in confidence_bands.py).  MC draws of θ, evaluate
`p × CDF(τ; θ)` per draw, take quantiles.

No epoch distinction — the curve covers the full τ range.

---

## 5. Where the Prior Parameters Come From

### 5.1 Alpha/Beta on the edge

The Bayesian inference engine already produces:

- `p.posterior.alpha` / `p.posterior.beta` — window-level
- `p.posterior.path_alpha` / `p.posterior.path_beta` — cohort-level

These are read by `read_edge_cohort_params()` at
cohort_forecast.py:95–107.  The cohort-level values are preferred in
cohort mode.

### 5.2 Deriving α₀, β₀ from posterior mean and SD

If only `posterior_p` and `p_stdev` are available (not alpha/beta
directly):

```
κ = p × (1 − p) / σ² − 1       (method of moments)
α₀ = p × κ
β₀ = (1 − p) × κ
```

where `p = posterior_p` and `σ = p_stdev`.

### 5.3 Fallback when no posterior exists

If the edge has no Bayesian posterior (only `forecast_mean`), use a
weakly informative prior:

```
α₀ = forecast_mean × κ_default
β₀ = (1 − forecast_mean) × κ_default
```

where `κ_default` is a configurable effective sample size (e.g. 10–50)
representing how much to trust the forecast in the absence of a real
posterior.  This is a policy decision.

---

## 6. Data Requirements

### 6.1 Target edge: snapshot-db data required

The per-Cohort per-date history (frames from `derive_cohort_maturity`)
provides (k_i, x_i, tau_max_i) per Cohort.  This is the evidence that
gets fed into the Bayesian update.  Already flowing through the pipeline.

### 6.2 Upstream edges (cohort mode): file view sufficient

The upstream x-forecast needs only the upstream edge's posterior
parameters (p, mu, sigma, onset) — already on the graph from the file
view.  No snapshot-db data needed for upstream edges.

The file view for an edge contains the model parameters (the result of
inference already run on that edge's own data).  The maturity-curve MC
consumes those parameters as a prior on upstream behaviour.

### 6.3 Summary

| Data source | Target edge | Upstream edges |
|-------------|-------------|----------------|
| Snapshot DB (per-Cohort per-date) | Required | Not needed |
| File view (posterior params) | Required | Required (cohort mode) |
| Graph topology (incoming edges) | Required | Required (cohort mode) |

---

## 7. Code Changes

### 7.1 `compute_cohort_maturity_rows()` — cohort_forecast.py

Three changes:

1. **Accept `visibility_mode`** parameter (default `'f+e'`).  Branch at
   top level:
   - `'e'`: skip MC, emit evidence-only rows (current bucket logic).
   - `'f'`: skip Cohort iteration, emit model curve + unconditional band.
   - `'f+e'`: full Bayesian computation (below).

2. **Accept `alpha_0` and `beta_0`** (or derive from edge_params).  Use
   these as the prior for the per-Cohort Bayesian update.

3. **Replace CDF-ratio formulas** with Bayesian posterior predictive:

   **Midpoint** (deterministic, lines 824–846):
   - Currently: `y_forecast = y_frozen × CDF(τ) / CDF(tau_max)`
   - Replace: `y_forecast = k_i + x_i × [CDF(τ) − c_i] × E[r|data]`
   - where `E[r|data] = (α₀ + k_i) / (α₀ + β₀ + n_eff_i)`

   **MC fan** (stochastic, lines 667–681):
   - Currently: `y_forecast = k_i + (N_i − k_i) × (q − q_a) / (1 − q_a)`
   - Replace: per-draw Bayesian update using `c_i^(b) = CDF(τ_max_i; θ^(b))`,
     then `y_forecast = k_i + x_i × [CDF(τ; θ^(b)) − c_i^(b)] × E[r|data, θ^(b)]`

### 7.2 `annotate_data_point()` — forecast_application.py

The blend formula at lines 115–119:

```python
blended_rate = c * evidence_rate + (1.0 - c) * model_rate_at_tau
```

This is an ad-hoc approximation of the Bayesian update.  Replace with:

```python
n_eff = x * c
posterior_rate = (alpha_0 + y) / (alpha_0 + beta_0 + n_eff)
projected_y = y + x * max(0, forecast_mean * c_at_full - c) * posterior_rate
```

Or alternatively, keep this function as-is (it's used for frame
annotation, not the maturity chart) and let the maturity chart use the
proper Bayesian formula in `compute_cohort_maturity_rows`.  The frame
annotation is informational; the maturity chart is the authoritative
computation.

**Decision needed**: whether to align `annotate_data_point` with the new
formula or leave it as an independent approximation.

### 7.3 `api_handlers.py`

Pass `visibility_mode` from the scenario into
`compute_cohort_maturity_rows()`.  Currently the scenario's
`visibility_mode` is read at line 596 but not forwarded to the
maturity computation.

Pass `alpha_0`, `beta_0` (or the raw alpha/beta from the edge
posterior) through `edge_params` so `compute_cohort_maturity_rows` can
use them.

### 7.4 Upstream x-forecast (cohort mode)

This section is now a **next-step design**, not a description of the current
implementation.

The current code no longer uses the old CDF-ratio form. It now computes
observed `x` where the Cohort is still within its frontier and uses a
model-derived `x_at_tau = max(a_pop × reach × weighted_upstream_cdf(τ), x_frozen)`
beyond the frontier, with a per-draw upstream CDF mixture in the MC fan.

What is still **not** implemented is the subject-conditioned upstream update
proposed below. That remains the design candidate if the local shortcut needs
to be replaced before a full graph-wide propagation engine exists.

Instead of the older ratio shortcut, one possible Bayesian treatment is to use
the upstream posterior to condition on the observed `x_frozen`:

```
n_eff_up_i = a_i × upstream_CDF(tau_max_i)
E[r_up | x_frozen_i] = (α_up + x_frozen_i) / (α_up + β_up + n_eff_up_i)
x_forecast_i(τ) = x_frozen_i + a_i × [upstream_CDF(τ) − upstream_CDF(tau_max_i)] × E[r_up | data]
```

This avoids the blow-up when `upstream_CDF(tau_max)` is small.

### 7.5 Open issue: y projection base in cohort mode

The current y formula projects future conversions from the frontier
population:

```
y(τ) = k + x_at_frontier × [CDF_edge(τ) − CDF_edge(tau_max)] × E[r|data]
```

where `x_at_frontier` is a scalar: the model's estimate of arrivals
at the observation point. This is structurally correct for the
posterior predictive — it conditions on a fixed population and
projects their remaining conversions.

However, for low-maturity Cohorts (`tau_max` small), the y
projection is anchored at `x_at_frontier` (a scalar — the model's
estimate of arrivals at the observation point, floored at
`x_frozen`). Meanwhile the denominator `x_model(τ)` grows with `τ`
to the full model-predicted arrival count `a × reach × CDF_path(τ)`.
The rate `y/x` is therefore depressed: the numerator scales with
the frontier population while the denominator scales with the full
model population. As maturity → 0, the rate does not converge to
`p × CDF_edge(τ)` (the unconditional model curve), which is the
expected limiting behaviour.

An alternative formula was tested experimentally:

```
y(τ) = k + x_model(τ) × [CDF_edge(τ) − CDF_edge(tau_max)] × E[r|data]
```

where `x_model(τ)` is the per-tau model-derived arrival count (a
`(T,)` array, not a scalar). This produced visually better
degeneration for immature Cohorts — the fan approached the model
curve as maturity decreased. However, it was reverted because
`x_model(τ)` already encodes upstream time maturation via
`CDF_path(τ)`, and multiplying by `remaining_cdf` (edge time
maturation) introduces double time-scaling. The resulting formula is
a different model, not a correction of the existing one.

The correct approach to achieving the degenerate-to-model invariant
likely requires a formula that properly handles the convolution of
upstream arrivals over time with edge-level conversion timing —
i.e., accounting for the fact that people arrive at the from-node
at different times and each has a different remaining conversion
window. The current formula assumes all arrivals happened before
`tau_max`, which is wrong for the immature case.

This is noted as an open modelling question. The per-tau population
projection gave empirically better results but on incorrect maths;
the frontier-conditioned formula has correct maths but wrong
limiting behaviour. A properly derived convolution formula would
resolve both.

---

## 8. Properties and Invariants

### 8.1 Continuity at τ = tau_max

At the boundary between mature and immature:

```
E[y(tau_max)] = k_i + x_i × [CDF(tau_max) − c_i] × E[r|data]
             = k_i + x_i × 0 × E[r|data]
             = k_i
```

The forecast starts exactly at the observed value.  Continuous.  ✓

### 8.2 Monotonicity

`CDF(τ) − c_i` is non-negative and increasing for τ ≥ tau_max_i.
`E[r|data] > 0`.  Therefore `E[y(τ)]` is non-decreasing.  ✓

### 8.3 midpoint ≥ evidence (f+e mode, common denominator)

In f+e mode, both lines use x_forecast as denominator.  For each
immature Cohort, `E[y_i(τ)] ≥ k_i` (§8.2).  Therefore the midpoint
numerator ≥ evidence numerator, and the denominators are equal.
`midpoint ≥ evidence`.  ✓

### 8.4 Asymptotic rate

As τ → ∞, `CDF(τ) → 1`:

```
E[y_i(∞)] = k_i + x_i × (1 − c_i) × E[r|data]
```

The implied rate:

```
E[y_i(∞)] / x_i = k_i/x_i + (1 − c_i) × E[r|data]
```

For a mature Cohort (c_i ≈ 1): `≈ k_i/x_i` — pure evidence.  ✓
For an immature Cohort (c_i ≈ 0): `≈ E[r|data] ≈ α₀/(α₀+β₀)` — pure
model.  ✓

### 8.5 Fan width

At τ = tau_max_i: the MC draws all produce `E[y] = k_i` (no uncertainty
in observed values).  Fan width = 0.  ✓

As τ increases: draws diverge because each draw has a different θ, hence
a different `CDF(τ; θ)` and a different posterior rate.  Fan opens
gradually.  ✓

For very immature Cohorts: `n_eff ≈ 0`, posterior ≈ prior.  Fan width ≈
unconditional band.  The evidence barely constrains the forecast, which
is correct.  ✓

---

## 9. Implementation Phases

### Phase 1: Window mode (f+e)

- Replace CDF-ratio midpoint with Bayesian posterior predictive.
- Replace MC fan's CDF-ratio formula with per-draw Bayesian update.
- Add visibility_mode branching (e-only, f-only paths).
- Derive α₀, β₀ from edge posterior or forecast_mean.
- x_forecast = x_frozen (window mode, no upstream needed).

### Phase 2: Cohort mode (f+e)

- Apply Bayesian treatment to upstream x-forecast.
- Implement common-denominator policy (x_forecast for both lines).
- Handle the upstream posterior conditioning.

### Phase 3: Align annotate_data_point (optional)

- Decide whether the frame annotation formula should match the maturity
  chart Bayesian formula, or remain an independent approximation.
- If aligning: pass α₀, β₀ through to `annotate_data_point`.

---

## 10. Blind Test Design

Tests written from the contract (this document), not from the
implementation.  They encode the expected behaviour of the full Bayes
approach.  Tests that exercise the immature-cohort regime should FAIL
against the current CDF-ratio implementation and PASS after the Bayesian
update is implemented.

### 10.1 Invariants under test

| # | Invariant | What a failure means |
|---|-----------|---------------------|
| I1 | **Immature-cohort stability**: When CDF(tau_max) ≈ 0, midpoint ≈ model rate (not ∞) | CDF-ratio blow-up is still present |
| I2 | **Mature-cohort fidelity**: When CDF(tau_max) ≈ 1, midpoint ≈ evidence rate | Bayesian update over-shrinks toward prior |
| I3 | **Smooth blend transition**: midpoint varies continuously from model-dominated to evidence-dominated as maturity increases; no cliff at any threshold | A hard threshold guard remains in the code |
| I4 | **Prior strength governs shrinkage**: larger κ = α₀ + β₀ → midpoint stays closer to model for longer | Prior parameters are not flowing into the update |
| I5 | **Continuity at tau_max**: forecast y at τ = tau_max equals observed y exactly | The forecast formula has a discontinuity at the boundary |
| I6 | **Monotonicity**: midpoint is non-decreasing with τ | The Bayesian formula breaks monotonicity (should not) |
| I7 | **Fan width zero at tau_max, opens after**: conditional fan starts at zero width and grows | Conditioning logic is broken |

### 10.2 Scenarios

All scenarios use window mode (x fixed) unless stated otherwise.  Model
params: mu=1.62, sigma=0.8, onset=4.0, p=0.83 (matching fan_test_1).

#### S1: Very immature single Cohort (τ_max < onset)

- anchor=1-Jan, sweep_to=4-Jan → tau_max=3, CDF(3)=0 (pre-onset)
- x=100, y=0 (no conversions — haven't passed dead time)
- **Expected**: midpoint in epoch C should converge toward
  `p × CDF(τ) ≈ 0.83 × CDF(τ)`.  Must NOT be null, NaN, or zero
  everywhere.  At τ=20 (well past onset), midpoint should be within
  a reasonable range of the model curve.
- **Tolerance**: midpoint at τ=20 within ±30% of `0.83 × CDF(20)`.

#### S2: Barely-past-onset single Cohort (CDF ≈ 0.05)

- anchor=1-Jan, sweep_to=10-Jan → tau_max=9, onset=4 → model-age=5 →
  CDF(5; mu=1.62, sigma=0.8) ≈ 0.12
- x=100, y=5 (5% observed rate, model predicts ~10% at this age)
- **Expected**: midpoint should be pulled toward model (prior dominates
  when n_eff ≈ 12 is small relative to κ).  At τ=30, midpoint should
  be in [0.4, 0.8] (not blown up to >1 or collapsed to near-zero).
- **Key assertion**: midpoint at τ=30 is strictly less than
  `y_frozen / x × CDF(30) / CDF(9)` (the CDF-ratio formula),
  because the Bayesian shrinkage toward the prior damps the
  extrapolation.

#### S3: Mature single Cohort (CDF ≈ 0.95)

- anchor=1-Jan, sweep_to=1-Feb → tau_max=31, CDF(31) ≈ 0.96
- x=100, y=60 (60% rate — below model's 83%)
- **Expected**: midpoint at τ=60 should be close to evidence
  extrapolation (0.60 / 0.96 ≈ 0.625), NOT the model's 0.83.
  Evidence dominates because n_eff ≈ 96 >> κ.
- **Tolerance**: midpoint at τ=60 within 0.05 of 0.625.

#### S4: Mixed maturity group — 7 Cohorts, extreme spread

- Same structure as fan_test_1 but sweep_to pushed to 8-Jan (so the
  youngest Cohort has tau_max=1, CDF≈0; oldest has tau_max=7, CDF≈0.15).
- All Cohorts very immature.  Evidence is sparse.
- **Expected**: aggregate midpoint in epoch C should be close to the
  model curve (all Cohorts immature → prior dominates for all).
  Must NOT collapse to near-zero (the bug in fan-chart-mc-bug.md).
- **Key assertion**: midpoint at τ=30 > 0.3 (model predicts ~0.6 at
  this point; anything below 0.3 means the prior isn't engaging).

#### S5: Evidence matches model perfectly

- Use `_regenerate_frames` with tf_factor=1.0 (evidence at model rate).
- **Expected**: midpoint ≈ evidence ≈ model throughout.  Fan is
  relatively narrow (no model-evidence tension).
- **Tolerance**: |midpoint − evidence| < 0.03 wherever both exist.

#### S6: Evidence far above model (outperformer)

- Use `_regenerate_frames` with tf_factor=1.3 (evidence 30% above model).
- **Expected**: for mature Cohorts, midpoint tracks evidence (above
  model).  For immature Cohorts, midpoint is pulled back toward model.
  Overall midpoint at large τ between model and evidence asymptotes.

#### S7: Evidence far below model (underperformer)

- Use `_regenerate_frames` with tf_factor=0.4 (evidence 60% below model).
- **Expected**: for mature Cohorts, midpoint tracks evidence (well below
  model).  For immature Cohorts, midpoint is pulled toward model.
  Overall: midpoint sits between 0.4×model and model.

#### S8: Prior strength sensitivity

- Same evidence (S2 fixture), but two runs with different α₀/β₀:
  - **Strong prior**: alpha=50, beta=10 (κ=60, mean=0.83)
  - **Weak prior**: alpha=5, beta=1 (κ=6, mean=0.83)
- **Expected**: strong-prior midpoint is closer to 0.83 than weak-prior
  midpoint at every τ in epoch C.  Both converge toward evidence as τ
  grows, but the strong prior resists longer.

#### S9: f-only mode (no evidence)

- Same fixture as S1 but visibility_mode='f'.
- **Expected**: rows should contain midpoint = p × CDF(τ) across full
  τ range.  Fan = unconditional band.  No evidence rate in any row.
  No epoch distinction (continuous curve from τ=0).

#### S10: e-only mode (no forecast)

- Same fixture as fan_test_1 but visibility_mode='e'.
- **Expected**: evidence rate present in epochs A and B.  Null in
  epoch C.  midpoint is null everywhere.  fan_upper/fan_lower are null
  everywhere.  No forecast computation performed.

### 10.3 Fixture extensions needed

1. **fan_test_bayes_immature.json**: New fixture with very short sweep
   (sweep_to close to onset) creating extremely immature Cohorts.
   Same model params as fan_test_1 for comparability.

2. **fan_test_1 with alpha/beta**: The existing fixture already has
   `posterior.alpha=20.75, posterior.beta=4.25` on the graph edge.
   The edge_params dict needs `posterior_alpha` and `posterior_beta`
   added (or derived from p_stdev via method of moments) so the
   Bayesian update can use them.

3. **`_regenerate_frames` with prior overrides**: Extend `load_test_fixture`
   to accept alpha/beta overrides in `edge_params` for S8.

### 10.4 Test file location

`graph-editor/lib/tests/test_cohort_maturity_bayes.py`

New file — no existing test file covers the Bayesian update contract
(the closest, `test_cohort_fan_harness.py`, tests the current CDF-ratio
implementation).  Per CLAUDE.md, a new file is appropriate when there is
"manifestly no better place" — the Bayesian invariants are a distinct
contract from the existing CDF-ratio tests.

### 10.5 What is NOT tested here

- Frontend rendering (ECharts series construction) — tested separately.
- Epoch stitching — tested in existing harness.
- Frame derivation from snapshot DB — tested in
  `test_cohort_maturity_derivation.py`.
- Upstream x-forecast for cohort mode — deferred to Phase 2.
- `annotate_data_point` alignment — deferred to Phase 3.

---

## 11. Residual implementation blockers (current `cohort_forecast.py`)

The original 2-Apr-26 forensic review identified five defects. Some of those
are now resolved on the primary Bayes path; the remaining blockers are more
specific than the older section suggested.

### 11.1 RESOLVED ON PRIMARY PATH — Shared-ancestor reach traversal bug

The main cohort-mode path no longer uses the deleted recursive
`compute_reach_probability()` helper. It now calls
`calculate_path_probability()` from `path_runner.py`, which removes the old
shared-ancestor `_visited` bug from the primary Bayes path.

### 11.2 RESOLVED — Anchor threading

The main Bayes path now passes `anchor_node_id` into
`compute_cohort_maturity_rows()`, so reach is anchored correctly when that path
is used.

The no-Bayes fallback in `api_handlers.py` now also resolves and passes
`anchor_node_id` (fixed 7-Apr-26), so anchoring is consistent across both
paths.

### 11.3 LIVE — Inconsistent probability sources in denominator model

This is still a real blocker. `reach` and the upstream latency mixture are not
yet guaranteed to use one common posterior basis end-to-end. The denominator
path therefore remains only approximately coherent.

### 11.4 LIVE — Silent fallback from path-level to edge-level latency

`read_edge_cohort_params()` now correctly preserves zero-valued latency fields,
but it still falls back from path-level latency to edge-level latency when
path-level fields are absent. That keeps a semantic downgrade path alive in
cohort mode.

### 11.5 RESOLVED ON PRIMARY PATH — Per-node capping distortion

The old recursive `min(total, 1.0)` distortion no longer applies to the main
Bayes path because that path no longer uses the old recursive reach helper.

### 11.6 LIVE — `Y_C` remains a cumulative-arrivals shortcut

The current code no longer applies a flat ultimate rate to `X_C`; it uses the
tau-dependent model rate `p × CDF(τ)`. But this is still a shortcut: it
applies a cumulative conversion rate directly to cumulative post-frontier
arrivals rather than deriving the proper convolution of arrival timing and
edge-level conversion timing.

### 11.7 LIVE — No graph-wide propagation engine yet

The current `cohort()` denominator path is still local to the subject edge:
`a_pop × reach × weighted_upstream_cdf(τ)`, with observed `x` used where
available and a floor at observed `x_frozen`. That is not yet the graph-wide
per-node, per-Cohort propagation model proposed in
`cohort-backend-propagation-engine-design.md`.

### 11.8 Summary

The main Bayes path is materially better than the 2-Apr-26 implementation:
carry-forward is in place, real evidence depth is respected, anchor threading
exists on the primary path, and the deleted recursive reach helper no longer
defines the result.

The remaining items are narrower and are better characterised as known
approximations rather than blockers — each produces reasonable results for
current use cases but could be improved:

- denominator basis consistency
- silent path→edge latency downgrade
- heuristic `Y_C`
- lack of graph-wide propagation for `x(s,τ)`
