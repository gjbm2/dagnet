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

For each Cohort date `s` and each tau `τ`, compute:

```
x(s, τ) = Σ_i  a_s × p_path_i × CDF_path_i(τ)
```

where `a_s` is the anchor population for Cohort date `s`,
`p_path_i` is the path-level conversion rate from the anchor node
to the from-node via edge `e_i`, and `CDF_path_i(τ)` is the
path-level latency CDF evaluated at `τ`.

This gives a per-Cohort-date, per-tau `x` estimate that reflects:
- The correct shape of the upstream latency distribution per `s`
- The correct scaling by anchor population per `s`
- Summation across all incident edges at joins (not just one
  "dominant" upstream edge)

### 3.2 What this does NOT do

This `x(s, τ)` is purely model-derived. It is not conditioned on
any observed upstream data. If the actual arrival pattern at the
from-node deviates from what the path latency model predicts (because
the lognormal fit is poor, or the Fenton-Wilkinson composition is
loose, or the real data is non-stationary), the `x` estimate will
be off.

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

The per-Cohort-date `x(s, τ)` from this approach replaces the
current `x_forecast_arr` in the MC loop
(`cohort_forecast.py:787–792`). The rest of the Bayesian `y`
computation (§7.1 of the Bayes design doc) continues unchanged:

For each MC draw `b`, for each Cohort date `s`:

```
c_s^(b) = CDF(tau_max_s; θ^(b))
n_eff_s = x(s, tau_max_s) × c_s^(b)
E[r | data, θ^(b)] = (α₀ + k_s) / (α₀ + β₀ + n_eff_s)
y_forecast_s^(b)(τ) = k_s + x(s, tau_max_s) × [CDF(τ; θ^(b)) − c_s^(b)] × E[r | data, θ^(b)]
```

Note that `n_eff` uses `x(s, tau_max_s)` — the model-derived
arrivals at the observation point for this Cohort date — rather
than `x_frozen_s`. This means the Bayesian update is conditioned
on the model's view of how many people had arrived, not on the
snapshot's frozen count. The `k_s` (observed conversions) is still
from the snapshot.

For the **deterministic midpoint**, the same substitution applies
but using posterior means rather than per-draw values.

### 3.5 MC draws for upstream uncertainty

In Option 1, `x(s, τ)` is deterministic (uses point-estimate path
params). This means the fan bands reflect only target-edge parameter
uncertainty, not upstream uncertainty. This is the same limitation
as the current code.

To include upstream uncertainty in the fan, the MC draws could
sample `p_path_i` and `CDF_path_i` from their own posteriors per
draw. This is straightforward: the path params derive from edge
posteriors already available on the graph. Each draw `b` would
produce `x^(b)(s, τ)` from drawn path params, and the fan would
widen to reflect upstream model uncertainty. This is an incremental
enhancement within Option 1, not a separate option.

---

## 4. Option 2: Upstream-evidence-conditioned `x(s, τ)`

### 4.1 Approach

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

### 4.2 What this adds over Option 1

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

### 4.3 Data requirements

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

### 4.4 Scope of upstream evidence

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

### 4.5 Integration with the Bayesian `y` forecast

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

## 5. Comparison

| | Current | Option 1 | Option 2 |
|---|---------|----------|----------|
| `x` per Cohort date `s` | No — single `x_frozen` per Cohort, same CDF ratio for all `s` | Yes — model-derived `x(s, τ)` using path params × `a_s` | Yes — evidence-conditioned `y_forecast` per upstream edge per `s`, summed |
| Shape of `x(τ)` distribution | CDF ratio from one upstream edge, cliff at 0.01 guard | Correct shape from path-level latency model, sum across all incident edges | Correct shape, conditioned on actual upstream observations |
| Upstream data needed | None (point-estimate model vars) | None (path params already on graph) | Snapshot hashes for immediate upstream incident edges |
| FE plumbing change | None | None | FE must send upstream edge hashes in analysis commission |
| Conditioning on actual upstream observations | No | No | Yes |
| Upstream uncertainty in fan | No | Optional (sample path params per MC draw) | Yes (sample upstream posteriors per draw) |
| Main improvement | — | Per-Cohort-date shape; eliminates ratio cliff; correct join summation | All of Option 1, plus evidence-conditioned upstream forecast |

---

## 6. Recommended delivery

**Stage 1: Option 1.** Implement model-derived `x(s, τ)` using
path-level forecast vars already on the graph. No new data plumbing.
Fixes the per-Cohort-date shape problem and eliminates the CDF-ratio
cliff. Evaluate the resulting fan quality on real data.

**Stage 2: Option 2 (if needed).** If Stage 1 fans show visible
artefacts from model-data divergence on upstream edges, add upstream
snapshot hashes to the analysis commission and implement
evidence-conditioned upstream forecasting. This is a data plumbing
change (FE sends more hashes) plus a BE change (query + bind
upstream snapshots, run posterior predictive per upstream edge per
Cohort date).

The decision to proceed to Stage 2 should be based on visual
inspection of Stage 1 fans against real `cohort()` data with known
upstream behaviour, not on theoretical considerations.
