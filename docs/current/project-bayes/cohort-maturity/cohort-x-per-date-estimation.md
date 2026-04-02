# Per-Cohort-Date `x` Estimation for `cohort()` Mode Fans

**Status**: Proposal
**Date**: 1-Apr-26
**Related**: `cohort-maturity-full-bayes-design.md` (§3, §6, §7.4),
`cohort-backend-propagation-engine-design.md`,
`fan-chart-mc-bug.md`,
`cohort-forecast-conditioning-attempts-1-Apr-26.md`

---

## 1. Context

The `cohort_maturity` fan chart in `cohort()` mode must estimate `x`
(arrivals at the subject edge's from-node) for each Cohort in the
scoped date group. In `window()` mode `x` is fixed per Cohort and this
problem does not arise. In `cohort()` mode `x` is a moving quantity:
upstream arrivals are still maturing, so `x` grows with `τ`.

The current implementation and the Bayesian design doc
(`cohort-maturity-full-bayes-design.md` §7.4) both treat `x` per
Cohort using a single frozen observation. This note argues that this
is insufficient for correctly shaped fans across a group of Cohorts
with different scope dates, proposes two staged improvements, and
identifies the data requirements for each.

---

## 2. The Problem

### 2.1 What the current code does

For each Cohort `i` with frozen observation at `tau_max_i`, the MC
fan computes:

```
x_forecast_i(τ) = x_frozen_i × upstream_CDF(τ) / upstream_CDF(tau_max_i)
```

using a single point-estimate upstream CDF from one upstream edge's
model vars (`cohort_forecast.py`, lines 781–792). The CDF ratio
scales `x_frozen_i` forward in time.

Problems:
- The CDF ratio explodes when `upstream_CDF(tau_max_i)` is small
  (immature Cohorts near the start of the latency curve). A hard
  guard at 0.01 creates a cliff.
- The same `x_frozen_i` is used as the anchor for every Cohort,
  regardless of its scope date. But different Cohorts in the group
  have different scope dates `s`, and the distribution of `x` at
  each `s` depends on when that Cohort started relative to the
  upstream latency. A Cohort that started 5 days ago has a very
  different `x` profile from one that started 90 days ago.
- The formula does not distinguish between Cohort dates at all — it
  treats the ratio `CDF(τ) / CDF(tau_max)` as uniform across the
  group.

### 2.2 What the Bayes design doc proposes (§7.4)

```
n_eff_up_i = a_i × upstream_CDF(tau_max_i)
E[r_up | x_frozen_i] = (α_up + x_frozen_i) / (α_up + β_up + n_eff_up_i)
x_forecast_i(τ) = x_frozen_i + a_i × [upstream_CDF(τ) − upstream_CDF(tau_max_i)] × E[r_up | data]
```

This is a correct Bayesian treatment of the ratio problem: it
conditions on `x_frozen_i` using the upstream posterior and avoids
the CDF-ratio blow-up. But it still anchors on a single `x_frozen_i`
per Cohort. The data requirements table (§6.2) explicitly states "No
snapshot-db data needed for upstream edges."

### 2.3 What is actually needed

For a group of Cohorts with scope dates `s_1 ... s_n`, the fan chart
needs `x(s, τ)` — the estimated arrivals at the subject edge's
from-node for Cohort date `s` at age `τ`. This is a two-dimensional
quantity, varying both across Cohort dates and across the tau grid.

Consider a subject edge three hops into the graph with a path
latency of ~30 days. Cohort `s_1` (started 90 days ago) has nearly
complete upstream arrivals — `x` is close to its final value at all
relevant `τ`. Cohort `s_n` (started 3 days ago) has barely any
upstream arrivals — `x` is tiny now but will grow substantially.
These two Cohorts need fundamentally different `x(τ)` curves, not
the same CDF ratio applied to different `x_frozen` values.

The current approach and the §7.4 formula both produce one
`x_forecast(τ)` curve per Cohort, anchored at a single `x_frozen`.
They do not model how `x` varies across `s` within the group.

---

## 3. Option 1: Model-derived `x(s, τ)` (no upstream snapshots)

### 3.1 Approach

For each upstream incident edge `e_i` to the subject edge's
from-node, the graph already carries path-level forecast vars:
`p_path_i`, `path_mu_i`, `path_sigma_i`, `path_onset_i` (computed
by `stats_engine.fw_compose_pair()`). These describe the expected
arrival rate from the anchor population through to the from-node via
edge `e_i`.

The model-derived upstream arrival curve for Cohort date `s` at
age `τ` is:

```
x_model(s, τ) = Σ_i  a_s × p_path_i × CDF_path_i(τ)
```

where `a_s` is the anchor population for Cohort date `s`,
`p_path_i` is the path-level conversion rate from the anchor node
to the from-node via edge `e_i`, and `CDF_path_i(τ)` is the
path-level latency CDF evaluated at `τ`.

However, the model curve alone is not used directly as `x`. Where
observed data exists, it takes precedence. The per-Cohort rule is:

```
x(s, τ) =
  x_observed(s, τ)                              if τ ≤ tau_max_s
  max(x_model(s, τ), x_frozen_s)                if τ > tau_max_s
```

That is: for ages where the Cohort has actual observed arrivals
(from the sweep data), use those. For ages beyond the observation
frontier, use the model forecast, floored at the last observed
value. Arrivals cannot un-happen, so the forecast must never fall
below what was actually seen.

The floor matters in practice. If the path model underestimates
arrivals for a particular Cohort (model predicts 80 arrivals by
`tau_max`, but 100 were observed), without the floor the denominator
would shrink below observed `y`, producing impossible rates > 1.

At the chart level, the epoch boundaries fall out naturally:
- **Epoch A** (all Cohorts mature at this `τ`): every Cohort
  contributes observed `x`. Pure evidence.
- **Epoch B** (some Cohorts mature, some immature): mature Cohorts
  contribute observed `x`, immature Cohorts contribute the floored
  model forecast.
- **Epoch C** (all Cohorts immature): all Cohorts contribute the
  floored model forecast.

This gives a per-Cohort-date, per-tau `x` estimate that reflects:
- The correct shape of the upstream latency distribution per `s`
- The correct scaling by anchor population per `s`
- Summation across all incident edges at joins (not just one
  "dominant" upstream edge)
- Observed data where available, model forecast only where needed

### 3.2 What this does NOT do

The model-derived `x_model(s, τ)` is not conditioned on any
observed upstream data. If the actual arrival pattern at the
from-node deviates from what the path latency model predicts
(because the lognormal fit is poor, or the Fenton-Wilkinson
composition is loose, or the real data is non-stationary), the
forecast beyond the observation frontier will be off. The floor at
`x_frozen_s` prevents the forecast from being *lower* than reality,
but does not correct it if the model *overestimates* future
arrivals.

This is acceptable as a first stage because:
- The `y`-forecasting on the subject edge IS conditioned on actual
  data via the Bayesian posterior predictive (§2 of the Bayes
  design doc).
- The `x` model uses the same latency parameters that Bayes
  inference fitted to real data — it is not uninformed.
- The per-Cohort-date shape is the primary improvement over the
  current single-ratio approach. Getting the shape right matters
  more than getting the absolute level exactly right.

### 3.3 Data requirements

| Data source | Target edge | Upstream edges |
|-------------|-------------|----------------|
| Snapshot DB (per-Cohort per-date) | Required | **Not needed** |
| File view (posterior + path params) | Required | Required |
| Graph topology (incoming edges) | Required | Required |

No new data plumbing. All required data is already on the graph
object sent to the BE in the analysis commission request.

### 3.4 Integration with the Bayesian `y` forecast

The per-Cohort `x(s, τ)` from this approach replaces the current
`x_forecast_arr` in the MC loop (`cohort_forecast.py:787–792`).
The subject-edge Bayesian `y` forecast continues to condition on
the subject edge's own frozen evidence — `x_frozen_s` and `k_s`
from the snapshot — not on the model-derived `x`.

For each MC draw `b`, for each Cohort date `s`:

```
c_s^(b) = CDF(tau_max_s; θ^(b))
n_eff_s = x_frozen_s × c_s^(b)
E[r | data, θ^(b)] = (α₀ + k_s) / (α₀ + β₀ + n_eff_s)
y_forecast_s^(b)(τ) = k_s + x_frozen_s × [CDF(τ; θ^(b)) − c_s^(b)] × E[r | data, θ^(b)]
```

The `y` forecast uses `x_frozen_s` (observed arrivals at the
subject edge) as the conditioning datum, because that is what was
actually observed at the edge. The model-derived `x(s, τ)` is used
only as the **denominator** when computing rates `y/x` for the
chart — it tells us how many people are expected to be in scope at
each `τ`, not how many the subject edge has seen convert.

For the **deterministic midpoint**, the same logic applies using
posterior means rather than per-draw values.

### 3.5 MC draws for upstream uncertainty

In Option 1, `x_model(s, τ)` is deterministic (uses point-estimate
path params). This means the fan bands reflect only target-edge
parameter uncertainty, not upstream uncertainty. This is the same
limitation as the current code.

To include upstream uncertainty in the fan, the MC draws could
sample `p_path_i` and `CDF_path_i` from their own posteriors per
draw. The path params derive from edge posteriors already available
on the graph. Each draw `b` would produce `x_model^(b)(s, τ)` from
drawn path params, and the fan would widen to reflect upstream model
uncertainty. This is an incremental enhancement within Option 1,
not a separate option.

---

## 4. Option 1b: Subject-conditioned upstream forecast (optional refinement)

### 4.1 Motivation

Option 1 uses the model forecast for `x` beyond the observation
frontier, floored at `x_frozen_s`. This means the model-derived
total `x_model(s, tau_max_s)` may differ from the observed
`x_frozen_s` — the model could predict either more or fewer
arrivals than were actually seen by `tau_max_s`. Option 1 handles
the "fewer" case via the floor, but the "more" case (model
overestimates) is uncorrected: the model's forward projection
starts from a base that doesn't match reality.

Option 1b addresses this by conditioning the upstream model
forecast on the observed subject `x_frozen_s`. It should only be
implemented if Option 1 fans show visible artefacts from
model-data divergence on real `cohort()` data. It is not needed if
the model's `x` estimates are close enough to observed values in
practice.

### 4.2 The conditioning problem

At a join, `x` is not a unitary distribution. It is the sum of
latent upstream arrival components, one per incoming edge:
`x_s(τ) = Σ_i x_i,s(τ)`. The observed `x_frozen_s` is the sum at
the frontier: `Σ_i x_i,s(tau_max_s) = x_frozen_s`.

Conditioning the joint upstream forecast on this observed sum is
non-trivial because:
- The conditioning is on the **sum**, not on the individual
  components.
- Once conditioned on the sum, the components become jointly
  coupled — if one route contributed more than expected, the others
  must have contributed less.
- The posterior over the components lives on a partition constrained
  by `x_frozen_s`, with negative dependence induced by the sum
  constraint.

### 4.3 Approach

For each Cohort date `s`:

1. Compute the model's prior expected arrivals per incoming edge
   at the frontier:
   `m_i(s) = a_s × p_path_i × CDF_path_i(tau_max_s)`

2. Derive frontier allocation weights that account for both
   route share and maturity:
   `w_i(s) = m_i(s) / Σ_j m_j(s)`

3. Allocate the observed total across routes:
   `z_i,s = x_frozen_s × w_i(s)`

4. Forecast each component forward from its allocated count using
   that route's own remaining-tail model:
   `x_i,s(τ) = z_i,s + a_s × p_path_i × [CDF_path_i(τ) − CDF_path_i(tau_max_s)]`
   floored at `z_i,s` (arrivals cannot un-happen per route).

5. Sum back to the node total:
   `x_s(τ) = Σ_i x_i,s(τ)`

At `τ = tau_max_s`, `x_s = Σ_i z_i,s = x_frozen_s` exactly. For
`τ > tau_max_s`, each component grows at its own rate.

The allocation weights `w_i(s)` can optionally be shrunk toward an
empirical route-share estimate derived from the latest `asat`-safe
upstream `frozen_y` values, if available. This should be treated as
a weak correction (small shrinkage strength), not hard evidence —
the upstream `frozen_y` is not same-Cohort data and mixes maturity
and route effects.

### 4.4 Per-Cohort rule (same structure as Option 1)

```
x(s, τ) =
  x_observed(s, τ)                              if τ ≤ tau_max_s
  max(x_conditioned(s, τ), x_frozen_s)          if τ > tau_max_s
```

where `x_conditioned(s, τ)` is the component-sum forecast from
§4.3 step 5. The floor is a safety guard; the conditioning should
already ensure monotonicity because each component only adds
non-negative remaining mass.

### 4.5 What this adds over Option 1

Option 1b ensures the upstream forecast passes through the observed
`x_frozen_s` at the frontier, so there is no model-data gap at the
observation point. Forward from there, the per-route decomposition
means routes with different maturities grow at different rates,
which is slightly more realistic than Option 1's aggregate model
curve.

The improvement is most visible when `x_model(s, tau_max_s)`
differs materially from `x_frozen_s` — i.e., when the path model
is a poor predictor of actual arrivals for specific Cohort dates.

### 4.6 Limitations

The latent partition of `x_frozen_s` across routes is prior-driven
(model path shares × maturity). Without upstream per-Cohort
snapshot evidence, the allocation is not identified by data. This
is why Option 1b is an approximation, not a full solve. Option 2
replaces the prior-driven allocation with actual upstream Cohort
evidence per edge, which is qualitatively cleaner.

---

## 5. Option 2: Upstream-evidence-conditioned `x(s, τ)`

### 5.1 Approach

For each upstream incident edge `e_i`, for each Cohort date `s`,
obtain the frozen observation `(x_frozen_i(s), y_frozen_i(s))` from
that edge's snapshot data. Then use the Bayesian posterior predictive
to forecast `y_i(s, τ)` — the expected conversions on edge `e_i`
for Cohort date `s` at age `τ`, conditioned on the observed data:

```
c_i_s = CDF_i(tau_max_i_s)
n_eff_i_s = x_frozen_i(s) × c_i_s
E[r_i | data] = (α_i + y_frozen_i(s)) / (α_i + β_i + n_eff_i_s)
y_forecast_i(s, τ) = y_frozen_i(s) + x_frozen_i(s) × [CDF_i(τ) − c_i_s] × E[r_i | data]
```

Then sum at the join:

```
x(s, τ) = Σ_i  y_forecast_i(s, τ)
```

This conditions the upstream `y` forecast on actual per-Cohort-date
evidence at each upstream edge, then derives `x` at the subject
edge's from-node as the sum of those forecasts.

### 5.2 What this adds over Options 1/1b

Option 1 uses the model's view of arrival rates. Option 2 conditions
on actual observed `(x, y)` per upstream edge per Cohort date. The
difference matters when:

- The real arrival rate at an upstream edge deviates from the model
  (data non-stationarity, model misfit, external events).
- A specific Cohort date `s` has unusually high or low upstream
  conversions that the model would not predict.
- The path-level Fenton-Wilkinson composition is a loose
  approximation of the true latency convolution.

For mature Cohorts (high `c_i_s`), the posterior predictive is
evidence-dominated and `y_forecast ≈ y_frozen` — Option 2 barely
differs from using raw frozen values. The improvement is most
visible for immature Cohorts where the Bayesian update meaningfully
blends prior and evidence.

### 5.3 Data requirements

| Data source | Target edge | Upstream edges |
|-------------|-------------|----------------|
| Snapshot DB (per-Cohort per-date) | Required | **Required** |
| File view (posterior + path params) | Required | Required |
| Graph topology (incoming edges) | Required | Required |

This is the key change: the FE must send snapshot hashes for each
**immediate upstream incident edge**, not just the subject edge,
when commissioning a `cohort_maturity` analysis in `cohort()` mode.

The FE already computes hashes for all edges during the planning
pass (`snapshotDependencyPlanService.ts`). The change is to include
upstream edges' hashes in the analysis commission request alongside
the subject edge's hashes. The BE receives these, queries snapshot
rows for each upstream edge, and uses them in the per-Cohort-date
Bayesian forecast.

### 5.4 Scope of upstream evidence

Only the **immediate incident edges** to the subject edge's
from-node require snapshot data. The Bayesian posterior predictive
on each upstream edge conditions on its own `(x_frozen, y_frozen)`
and uses its own model vars to forecast remaining conversions. It
does not require evidence from edges further upstream.

The limit condition for this one-level approach: the model vars on
the immediate upstream edges must be informative (promoted
posteriors from Bayes inference). If an upstream edge lacks a
promoted posterior, the engine falls back to the frequentist
`p.mean × CDF(τ)` point estimate — wider uncertainty, but not
biased. This is the basis-tier system described in
`cohort-backend-propagation-engine-design.md` §7.1.

Recursive propagation further upstream (conditioning upstream edge
`x` on *its* upstream evidence) is a future refinement. The
one-level approach is not biased by this omission — it simply does
not condition on deeper upstream evidence, so the posterior is wider
than it would be with full recursive propagation. This is honest
uncertainty, not systematic error.

### 5.5 Integration with the Bayesian `y` forecast

The per-Cohort-date `x(s, τ)` from Option 2 replaces
`x_forecast_arr` in the MC loop in the same way as Option 1
(§3.4). The downstream Bayesian `y` forecast on the subject edge
is unchanged.

For MC draws, each upstream edge `e_i` can also be sampled: draw
`θ_i^(b)` from edge `e_i`'s posterior, compute
`y_forecast_i^(b)(s, τ)` per draw, sum at the join. This
propagates upstream parameter uncertainty into the subject edge's
`x`, widening the fan to reflect both target-edge and upstream-edge
uncertainty. The cross-edge independence approximation and its
implications are discussed in
`cohort-backend-propagation-engine-design.md` §8.1.

---

## 6. Comparison

| | Current | Option 1 | Option 1b | Option 2 |
|---|---------|----------|-----------|----------|
| `x` per Cohort date `s` | No — single `x_frozen`, same CDF ratio for all `s` | Yes — model-derived, observed where available | Yes — conditioned on subject `x_frozen_s` | Yes — conditioned on upstream per-edge evidence |
| Shape of `x(τ)` | CDF ratio from one edge, cliff at 0.01 | Path-level model, sum across incident edges | Same shape, anchored at observed frontier | Correct shape from upstream Bayesian forecast |
| Observed `x` used | As ratio anchor only | In epoch A; as floor in B/C | As conditioning datum at frontier | Directly per upstream edge per `s` |
| Upstream data needed | None | None (path params on graph) | None (path params + subject `x_frozen`) | Snapshot hashes for incident edges |
| FE plumbing change | None | None | None | FE sends upstream hashes |
| Conditioning on upstream observations | No | No | On subject total only (prior-driven partition) | Yes — per edge per Cohort date |
| Upstream uncertainty in fan | No | Optional (sample path params) | Optional (sample path params) | Yes (sample upstream posteriors) |
| Complexity | Low | Low | Medium (partition solve) | Medium (snapshot plumbing) |
| Main improvement | — | Per-date shape; ratio cliff gone; join sum | Anchors forecast at observed `x` | Evidence-conditioned upstream |

---

## 7. Recommended delivery

**Stage 1: Option 1.** Implement model-derived `x(s, τ)` with the
observed/forecast per-Cohort rule (§3.1) using path-level forecast
vars already on the graph. No new data plumbing. Fixes the
per-Cohort-date shape problem, eliminates the CDF-ratio cliff, and
uses observed `x` where available. Evaluate the resulting fan
quality on real `cohort()` data.

**Stage 1b: Option 1b (if needed).** If Stage 1 fans show a visible
gap between `x_model(s, tau_max_s)` and `x_frozen_s` for immature
Cohorts — i.e., the model's arrival prediction at the frontier
doesn't match what was actually observed — implement the
subject-conditioned partition (§4). This anchors the forward
forecast at observed `x_frozen_s` per Cohort, at the cost of a
prior-driven latent allocation across incoming routes. Only build
this if the gap matters visually.

**Stage 2: Option 2 (if needed).** If Stages 1/1b fans still show
artefacts from model-data divergence on upstream edges — e.g., an
upstream edge with non-stationary behaviour that the model doesn't
capture — add upstream snapshot hashes to the analysis commission
and implement evidence-conditioned upstream forecasting (§5). This
is a data plumbing change (FE sends more hashes) plus a BE change
(query + bind upstream snapshots, run posterior predictive per
upstream edge per Cohort date).

Each stage decision should be based on visual inspection of fans
against real `cohort()` data with known upstream behaviour, not on
theoretical considerations.

---

## 8. Open calibration issues (post Option 1 implementation)

The following issues were identified during Option 1 implementation
and require resolution in sequence. They are maths/stats
calibration problems, not architectural or plumbing issues.

### 8.1 Zero-maturity degeneration invariant

**Invariant**: for both `window()` and `cohort()` modes, as Cohort
maturity → 0 (e.g. `cohort(-0d:)` or a window containing only
today's data), the fan chart must degenerate to the unconditional
Bayes model curve: `rate(τ) = p × CDF_edge(τ)`, with fan bands
equal to the unconditional confidence band from the edge posterior.

**Current status**: not confirmed. The frontier-conditioned y
formula `y = k + x_frontier × remaining_cdf × r` produces `y ≈ 0`
when `x_frontier ≈ 0` (zero-maturity Cohort with few arrivals),
so the Cohort contributes almost nothing to the aggregate — rather
than contributing the model curve.

**Investigation procedure**: for a true `cohort(-0d:)` subject,
dump per-Cohort terms at `τ = 0..5`:

- `N_i, k_i, c_i, n_eff_i, r_draw_i, x_i(τ), y_i(τ), y_i/x_i`
- Compare against `model_rate(τ) = posterior_p × CDF_edge(τ)`

Then decompose:

- Residual observed term: does `k_i / x_i(τ)` survive?
- Posterior draw vs model: does `median(r_draw)` match `p_model`?
- Mixed upstream bases: is the denominator on a different basis
  from the displayed Bayes model curve?

**Required fix**: likely a properly derived formula that handles
the convolution of upstream arrivals over time with edge-level
conversion timing (see `cohort-maturity-full-bayes-design.md`
§7.5). The per-tau population projection was tested experimentally
and gave better visual degeneration but on incorrect maths (double
time-scaling). A correct derivation is needed.

**Test**: write a fixture test with a single zero-maturity Cohort.
Assert that the MC fan midpoint converges to `p × CDF_edge(τ)` and
the fan bands match the unconditional confidence band within
tolerance. This test should pass for both `window()` and `cohort()`
modes.

### 8.2 Stochastic denominator (upstream x uncertainty in fan)

**Problem**: `x_forecast_arr` is currently deterministic across MC
draws. The denominator `X_total` is identical for all 2000 draws.
Fan width comes only from numerator variation (`y` via rate draws
and CDF draws). Upstream arrival uncertainty is not reflected.

**Proposal 2A** (Option-1-consistent stochastic denominator): sample
upstream path terms per draw. For each incoming route `u` and draw
`b`:

- Sample `p_u^(b)` from the upstream edge's probability posterior
- Sample `(μ_u^(b), σ_u^(b), onset_u^(b))` from the upstream
  edge's latency posterior
- Compute `cdf_u^(b)(τ)` from the drawn params
- Route mass: `m_u^(b)(τ) = p_u^(b) × cdf_u^(b)(τ)`

Then for each Cohort `s`:

```
R^(b)(τ) = Σ_u m_u^(b)(τ)        (MECE assumption)
x_model^(b)(s, τ) = a_s × reach × R^(b)(τ)
x^(b)(s, τ) = max(x_frozen_s, x_model^(b)(s, τ))
```

Now the denominator varies per draw, and the fan ratio `Y/X`
reflects both rate and arrival uncertainty.

**Prerequisite**: §8.1 must be resolved first. Stochastic `x` on
top of a broken degeneration formula will produce worse results,
not better.

**Proposal 2B** (consistency fix): the current implementation uses
`edge.p.mean` for `compute_reach_probability` but `_up['p']` from
`read_edge_cohort_params` (posterior path params) for the CDF
weights. These may be on different bases. Pick one posterior source
for both. This is a small fix that should be done regardless of
whether 2A is implemented.

### 8.3 Sequence

1. **§8.1**: investigate and fix the zero-maturity degeneration.
   Write the fixture test first. This is the most fundamental
   invariant — if it doesn't hold, other calibration work is
   wasted.
2. **§8.2 Proposal 2B**: consistency fix for reach vs CDF
   probability bases. Small, low-risk.
3. **§8.2 Proposal 2A**: stochastic denominator. Only after §8.1
   is resolved and confirmed by test.
4. Re-evaluate fan quality on real data after each step. If fans
   look correct after §8.1 + 2B, defer 2A.
