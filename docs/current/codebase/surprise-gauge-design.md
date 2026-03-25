# Surprise Gauge Analysis Type

**Status**: Phase 1 implementation in progress
**Date**: 24-Mar-26

---

## 1. Purpose

Shows at a glance whether current evidence for an edge is surprising
given the Bayesian posterior. For each model variable, computes where
the observed value falls in the posterior distribution and renders a
colour-coded gauge or band.

---

## 2. Layouts

### 2.1 Single var, single scenario — Semicircular dial

Needle points to observed quantile. Coloured arcs show confidence zones.
Centre = posterior mean (50th percentile, "expected").

### 2.2 One var, multiple scenarios — Horizontal band stack

Each row is a scenario. Bands are on a **shared real axis** (same units),
shifted left/right to each scenario's posterior mean. A dot marks the
observed value. The band shift shows how expectations differ across
scenarios; the dot position within its band shows how surprising the
observation is.

### 2.3 One scenario, multiple vars — Horizontal band stack

Each row is a variable. Bands are **individually centred** on each
variable's expected value. The axis is normalised (linear in σ, labelled
in percentiles). Dot position shows how far observed is from expected
in posterior-SD units.

---

## 3. Colour scheme

Symmetric. Same for dial arcs and band fills.

| Zone | Percentile range | σ range | Colour | Meaning |
|------|-----------------|---------|--------|---------|
| Centre | 20th–80th | 0–1.28σ | Green | Expected |
| Inner | 10th–20th / 80th–90th | 1.28–1.64σ | Yellow | Noteworthy |
| Mid | 5th–10th / 90th–95th | 1.64–1.96σ | Amber | Unusual |
| Outer | 1st–5th / 95th–99th | 1.96–2.58σ | Red | Surprising |
| Tail | <1st / >99th | >2.58σ | Dark red | Alarming |

Axis is linear in σ but tick labels show percentiles (50%, 80%, 90%,
95%, 99%). This gives uniform visual spacing with familiar labels.

---

## 4. Variables

### Phase 1 — available from parameter file scalars

| Variable | Posterior | Observed evidence | Derivation |
|----------|----------|-------------------|------------|
| **p** | Beta(α, β) | k, n from values entry | Exact Beta CDF: `quantile = Beta_CDF(k/n, α, β)` |
| **mu** | mu_mean ± mu_sd | `median_lag_days` from values entry | `obs_mu = ln(median_lag - onset_mean)`, normal CDF |
| **sigma** | sigma_mean ± sigma_sd | `mean_lag_days` / `median_lag_days` | `obs_sigma = sqrt(2 × ln(mean/median))`, normal CDF. Guard: n ≥ 30 |

### Phase 2 — requires snapshot DB query (BE has access)

| Variable | Posterior | Observed evidence | Derivation |
|----------|----------|-------------------|------------|
| **onset** | onset_mean ± onset_sd | Earliest conversion age in current window | Query snapshot DB: `min(lag_days) where y > 0`. Heuristic needed for robustness (e.g. 5th percentile of lag, not bare minimum) |
| **path_onset** | path_onset ± path_onset_sd | Earliest cohort conversion age | Query snapshot DB cohort frames: `min(cohort_age) where y > 0`. Same heuristic. |

---

## 5. Statistical tests

### p — exact posterior predictive

The posterior is Beta(α, β). For observed k out of n, the posterior
predictive is Beta-Binomial(n, α, β). The quantile is:

```
quantile = BetaBinomial_CDF(k, n, α, β)
```

This accounts for both posterior uncertainty and sampling noise.
No normal approximation needed.

### mu, sigma — normal approximation

The posterior marginals are approximately normal. The observed value
has its own sampling variance:

```
For mu:   obs = ln(median_lag - onset_mean)
          obs_se ≈ sqrt(π/2) × sigma_mean / sqrt(n)
          combined_sd = sqrt(mu_sd² + obs_se²)
          z = (obs - mu_mean) / combined_sd
          quantile = Φ(z)

For sigma: obs = sqrt(2 × ln(mean_lag / median_lag))
           Guard: skip if n < 30 or mean_lag ≤ median_lag
           combined_sd = sqrt(sigma_sd² + sampling_var)
           z = (obs - sigma_mean) / combined_sd
           quantile = Φ(z)
```

### onset, path_onset — normal approximation (Phase 2)

```
obs = heuristic from snapshot DB (e.g. 5th percentile of lag)
z = (obs - onset_mean) / onset_sd
quantile = Φ(z)
```

Note: onset sampling variance is harder to estimate. Phase 2 may
use just the posterior SD (ignoring observation noise) as a first
approximation, since the onset posterior SD is typically wide enough
to absorb it.

---

## 6. Implementation plan

### Phase 1

**Backend** (`api_handlers.py`):
- New handler for `analysis_type: 'surprise_gauge'`
- Reads Bayesian model vars entry from graph edge (`model_vars[]`
  where `source === 'bayesian'`)
- Reads current evidence from parameter file values (k, n,
  median_lag_days, mean_lag_days)
- Computes quantile per selected variable(s)
- Returns: `{ variables: [{ name, quantile, observed, expected,
  posterior_sd, zone, label }] }`

**Frontend**:
- Register `surprise_gauge` analysis type in `analysisTypes.ts`
- ECharts gauge series for single-var dial
- Custom horizontal band renderer for multi-var/multi-scenario
- Display settings: variable selector, orientation toggle

**Display settings** (registry):
- `surprise_var`: radio (p, mu, sigma) — default p
- `surprise_layout`: auto / dial / bands
- Standard legend, font size, animation settings

### Phase 2

**Backend additions**:
- Snapshot DB query for onset evidence (min lag where y > 0)
- Path onset from cohort frames
- Add `onset` and `path_onset` to variable selector options

---

## 7. Analysis type registration

```
id: 'surprise_gauge'
name: 'Expectation Gauge'
shortDescription: 'How surprising is current evidence given the Bayesian posterior'
icon: Gauge (or AlertTriangle)
snapshotContract: {
  scopeRule: 'single_edge',
  readMode: 'none',          // no snapshot read needed in Phase 1
  slicePolicy: 'any',
  timeBoundsSource: 'query_dsl_window',
  perScenario: true,
}
```

---

## 8. Design principles

1. **All computation in the BE.** The FE renders what it's given.
2. **Exact test for p** (Beta-Binomial predictive). Normal
   approximation for the rest.
3. **Sampling noise matters.** The surprise score must account for
   both posterior uncertainty AND observation noise. A single week
   with k=2, n=50 is noisy — the gauge should reflect that.
4. **Guard rails.** Skip sigma when n < 30. Skip onset/path_onset
   when snapshot data is insufficient. Show "insufficient data"
   rather than a misleading gauge.
5. **Linear-in-σ axis, percentile labels.** Uniform visual spacing,
   familiar units.
