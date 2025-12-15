# Window/Cohort LAG — Worked Examples & Risk Notes (implementation-ready)

**Created:** 15-Dec-25  
**Purpose:** Collect worked examples and risk notes that justify the design choices in the main plans.

This document is not an “open issues” tracker. Any genuinely deferred requirements should be tracked in `/TODO.md`.

---

## 1) Cohort-mode anchor delay soft transition: stable weighting (finalised)

### 1.1 Context

In cohort mode we need an **effective upstream A→X delay** for completeness, even when cohort selections are immature and anchor lag evidence is sparse.

We have:

- **Prior** anchor delay (`prior_anchor_median_days`): derived from upstream baseline `window()` lag summaries (distribution-aware).
- **Observed** anchor delay (`observed_anchor_median_days`): derived from cohort-slice `anchor_median_lag_days[]` when present.
- **Blend**: `effective_anchor_median_days = w * observed_anchor_median_days + (1-w) * prior_anchor_median_days`, where `w` is in `[0,1]`.

The challenge is choosing a **stable, scale-aware** weight without assuming fixed cohort sizes across edges/contexts.

### 1.2 Proposed weighting basis (approved direction)

Use the edge’s **forecast scale** as the normaliser:

- We already compute `p.n` and `p.mean` in the topo/LAG pass.
- Therefore we have an indicative forecast of **how many conversions** the edge would produce (eventually) under the current scenario.

That forecast provides a principled basis for “how much we should trust observed anchor lag” for downstream completeness, because it adapts automatically to the scale of the edge/context.

### 1.3 Proposed spec: weight function (simple, stable)

We define a single weight `w` in `[0,1]` that determines how much we trust the **observed anchor delay** (from cohort slices) vs the **prior anchor delay** (from baseline window priors).

Inputs:

- **forecast_conversions**: `p.n * p.mean` (expected eventual conversions for this edge under the current scenario/view).
- **anchor_lag_coverage**: fraction in `[0,1]` of cohort-days in the selected cohort date range that have a valid `anchor_median_lag_days[d]`.
- **effective_forecast_conversions**: `anchor_lag_coverage * forecast_conversions`

Weight:

- `w = 1 - exp(-effective_forecast_conversions / ANCHOR_DELAY_BLEND_K_CONVERSIONS)`

Blended anchor delay:

- `effective_anchor_median_days = w * observed_anchor_median_days + (1 - w) * prior_anchor_median_days`

Constant:

- `ANCHOR_DELAY_BLEND_K_CONVERSIONS` (proposed initial value: `50`)

Guard rails:

- If `anchor_median_lag_days[]` is missing entirely, or `anchor_lag_coverage = 0`, then `w = 0`.
- If we cannot produce a valid `observed_anchor_median_days`, then `w = 0`.
- No other clamps in Phase 1 (keep it simple and testable).

### 1.4 Worked examples (what w looks like in practice)

Using `ANCHOR_DELAY_BLEND_K_CONVERSIONS = 50` and `w = 1 - exp(-effective_forecast_conversions / 50)`.

| Scenario | forecast_conversions (`p.n*p.mean`) | anchor_lag_coverage | effective_forecast_conversions | w |
|---|---:|---:|---:|---:|
| No anchor lag coverage (forced prior) | 100 | 0.0 | 0 | 0.000 |
| Tiny edge, full coverage | 1 | 1.0 | 1 | 0.020 |
| Small edge, full coverage | 10 | 1.0 | 10 | 0.181 |
| Medium edge, 50% coverage | 100 | 0.5 | 50 | 0.632 |
| Medium edge, 10% coverage | 100 | 0.1 | 10 | 0.181 |
| Large edge, 10% coverage | 500 | 0.1 | 50 | 0.632 |
| Large edge, 50% coverage | 500 | 0.5 | 250 | 0.993 |
| Huge edge, low coverage | 2000 | 0.1 | 200 | 0.982 |

### 1.5 Worked examples (end-to-end completeness impact)

This section shows, end-to-end, what we would actually report as cohort-mode completeness after:

- applying the proposed upstream anchor-delay weighting, and then
- computing completeness from the edge’s X→Y lag CDF at the cohort effective age.

#### Starting assumptions for all worked examples

- `ANCHOR_DELAY_BLEND_K_CONVERSIONS = 50`
- Upstream A→X delay inputs:
  - `prior_anchor_median_days` (from baseline-window priors)
  - `observed_anchor_median_days` (from cohort-slice `anchor_median_lag_days[]`, aggregated over the selected cohort date range)
- Edge lag shape (X→Y) for completeness is lognormal fitted from:
  - `median_lag_days = 5`
  - `mean_lag_days = 7`

#### Calculation steps used for every row (this is what the system would do)

1. Compute forecast scale (expected eventual conversions):
   - `forecast_conversions = p.n * p.mean`
2. Compute anchor lag coverage:
   - `anchor_lag_coverage` = fraction of cohort-days in the selected cohort date range with valid `anchor_median_lag_days[d]`
3. Compute effective forecast scale:
   - `effective_forecast_conversions = anchor_lag_coverage * forecast_conversions`
4. Compute the weight:
   - `w = 1 - exp(-effective_forecast_conversions / 50)`
5. Compute effective anchor delay (median):
   - `effective_anchor_median_days = w * observed_anchor_median_days + (1 - w) * prior_anchor_median_days`
6. Compute cohort effective age for X→Y:
   - `effective_age_days = max(0, anchor_age_days - effective_anchor_median_days)`
7. Compute reported cohort-mode completeness:
   - `reported_completeness = CDF_X_to_Y(effective_age_days)` using the lognormal CDF derived from (`median_lag_days = 5`, `mean_lag_days = 7`)

#### Worked examples table (numbers follow the above steps exactly)

| Scenario | anchor_age_days | prior_anchor_median_days | observed_anchor_median_days | forecast_conversions (`p.n*p.mean`) | anchor_lag_coverage | effective_forecast_conversions | w | effective_anchor_median_days | effective_age_days | reported_completeness |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Very immature cohort; upstream delay likely dominates | 7 | 8 | 4 | 100 | 0.1 | 10.0 | 0.1813 | 7.2749 | 0.0000 | 0.0000 |
| Two-week cohort; sparse anchor lag → mostly prior | 14 | 8 | 4 | 10 | 0.2 | 2.0 | 0.0392 | 7.8432 | 6.1568 | 0.6001 |
| Two-week cohort; moderate signal → mixed | 14 | 8 | 4 | 100 | 0.5 | 50.0 | 0.6321 | 5.4715 | 8.5285 | 0.7425 |
| Two-week cohort; strong signal → mostly observed | 14 | 8 | 4 | 500 | 0.8 | 400.0 | 0.9997 | 4.0013 | 9.9987 | 0.8009 |
| Older cohort; even modest signal is enough | 30 | 12 | 6 | 100 | 0.2 | 20.0 | 0.3297 | 10.0219 | 19.9781 | 0.9544 |
| Downstream heterogeneity: prior very long, observed short, high scale | 14 | 20 | 6 | 500 | 0.5 | 250.0 | 0.9933 | 6.0943 | 7.9057 | 0.7117 |

Important clarification:

- **Observed conversions are not shown in this table.** They live on the edge evidence:
  - observed_n: `edge.p.evidence.n`
  - observed_k: `edge.p.evidence.k`
  - observed_mean: `edge.p.evidence.mean = observed_k / observed_n`
- `forecast_conversions = p.n * p.mean` is not observed_k. It is an expected eventual conversions scale signal used only to weight the upstream anchor-delay blend.
- `anchor_lag_coverage` is not observed_n. It is a cohort-day coverage fraction indicating how much `anchor_median_lag_days[]` signal exists in the selected cohort range.

---

## 2) Worked examples: blend sensitivity to completeness (misfit / fat tails risk)

This section shows, numerically, how `p.mean` changes if **completeness is wrong** (e.g. because the lag fit is a poor approximation for a long / fat-tailed edge).

### 2.1 The blend formula we actually use

Inputs:

- evidence_mean: `p.evidence.mean`
- forecast_mean: `p.forecast.mean` (baseline window)
- n_query: `p.n` (or evidence.n where appropriate)
- n_baseline: the sample size behind the forecast baseline (baseline window slice)
- completeness: the lag-CDF-derived completeness for the selected cohorts
- lambda: `FORECAST_BLEND_LAMBDA` (currently `0.75`)

Weights:

- `n_eff = completeness * n_query`
- `w_evidence = n_eff / (lambda * n_baseline + n_eff)`
- `p.mean = w_evidence * evidence_mean + (1 - w_evidence) * forecast_mean`

### 2.2 What “completeness misfit” does to p.mean

Below, each row compares:

- an **estimated completeness** (what the system would compute, potentially wrong under misfit), vs
- a **true completeness** (what you’d want if you had the true lag distribution),

and shows the resulting `w_evidence` and `p.mean`.

Assumptions (fixed for this table):

- `FORECAST_BLEND_LAMBDA = 0.75`

| Scenario | evidence_mean | forecast_mean | n_query | n_baseline | completeness_est | w_evidence_est | p.mean_est | completeness_true | w_evidence_true | p.mean_true | How misfit shows up |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Edge A (typical): completeness under-estimated | 0.20 | 0.35 | 120 | 1000 | 0.30 | 0.0458 | 0.3431 | 0.60 | 0.0876 | 0.3369 | p.mean stays too close to forecast (undercounts evidence) |
| Edge A (typical): completeness over-estimated | 0.20 | 0.35 | 120 | 1000 | 0.60 | 0.0876 | 0.3369 | 0.30 | 0.0458 | 0.3431 | p.mean moves too far toward evidence (overreacts) |
| Edge B (fat tail): completeness over-estimated (lognormal too optimistic) | 0.05 | 0.25 | 200 | 1500 | 0.70 | 0.1107 | 0.2279 | 0.20 | 0.0343 | 0.2431 | p.mean pulled down toward low evidence too early; systematic under-forecast risk on long tails |
| Edge B (fat tail): completeness under-estimated (lognormal too pessimistic) | 0.05 | 0.25 | 200 | 1500 | 0.20 | 0.0343 | 0.2431 | 0.70 | 0.1107 | 0.2279 | p.mean stays too high (forecast-heavy) even when evidence is already informative |
| Edge C (downstream high flow): completeness over-estimated | 0.40 | 0.55 | 5000 | 2000 | 0.90 | 0.7500 | 0.4375 | 0.50 | 0.6250 | 0.4563 | big n_query means completeness errors translate into noticeable p.mean shifts |
| Edge C (downstream high flow): completeness under-estimated | 0.40 | 0.55 | 5000 | 2000 | 0.50 | 0.6250 | 0.4563 | 0.90 | 0.7500 | 0.4375 | p.mean stays forecast-heavy longer than it should, even with lots of flow |
| Edge D (sparse): completeness over-estimated | 0.10 | 0.30 | 20 | 2000 | 0.80 | 0.0106 | 0.2979 | 0.20 | 0.0027 | 0.2995 | sparse edges are forecast-dominated regardless; misfit has small effect on p.mean |
| Edge D (sparse): completeness under-estimated | 0.10 | 0.30 | 20 | 2000 | 0.20 | 0.0027 | 0.2995 | 0.80 | 0.0106 | 0.2979 | same: most of the time you’ll see forecast, which is desirable for low-signal edges |

### 2.3 Practical “where will I notice this?” guide

- If the edge is **fat-tailed** and the lognormal fit tends to **over-estimate completeness**, you’ll see `p.mean` swing toward `p.evidence.mean` too early (often depressing `p.mean` for recent cohorts/windows).
- The risk is largest when:
  - `n_query` is large (downstream edges with lots of flow), and
  - `n_baseline` is not overwhelmingly larger than `n_query`, and
  - completeness sits in the “mid-range” (because `n_eff = completeness * n_query` is where the blend actually moves).
- If the edge is sparse, the blend is forecast-heavy almost regardless; misfit matters less.



