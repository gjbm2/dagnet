# Doc 12 — Temporal Adaptation: Recency Weighting

**Status**: Implemented (19-Mar-26)
**Date**: 19-Mar-26

---

## 1. Goal

The model should project from **current conditions**, not a historical
average. If conversion rates or latency have changed recently, the
forecast should reflect the change without waiting for old data to
age out of the training window.

## 2. Approaches considered and rejected

### Per-bin random walk

```
logit_p_t = logit_p_{t-1} + eps_t * sigma_drift
```

Failed: the funnel geometry between `eps_t` and `sigma_drift` made
NUTS unsampleable, even with 4 bins. The random walk creates
high-dimensional funnels that scale with bin count × edge count.

### Per-bin partial pooling (independent per bin, shared mean)

```
logit_p_t ~ Normal(logit_p_base, tau)
```

Failed: even with `tau` as a free variable and only 2 groups
(recent/historic), the tau-logit interaction created enough geometry
problems to prevent convergence within reasonable time.

### Per-bin partial pooling with fixed tau

Timed out. Even without estimating tau, the additional per-bin
variables and the per-trajectory p dispatch (especially in the Phase S
branch) created a PyTensor graph too complex for efficient evaluation.

### BASE + DELTA (recent bucket split)

```
logit_p_base_recent = logit_p_base + eps_drift * tau_fixed
```

Worked (rhat=1.002, 0 divergences, 26 vars) but introduced:
- Two arbitrary cutoff dates (p and mu) varying by data sufficiency
- Complex trajectory routing (recent vs historic Potentials)
- Unclear propagation from window edge signal to cohort path estimates
- Questions about what onset_cohort means in each period

The machinery was disproportionate to the goal.

## 3. Final approach: recency-weighted likelihood

Instead of modelling drift explicitly in parameter space, **weight
each trajectory's likelihood contribution by its recency**:

```
weight = exp(-ln2 * age_days / half_life_days)
```

where `age_days = today - anchor_day`.

Recent trajectories contribute ~1.0 to the likelihood. Old ones
decay toward 0. The posterior naturally reflects current conditions
because recent data dominates.

### Implementation

One multiplication per trajectory count in the Potential logp. Both
latent-CDF (Phase D) and fixed-CDF (Phase S) branches weight
interval counts and remainder counts by the trajectory's
`recency_weight`. No new model variables. No Potential splitting.
The model structure is unchanged (20 vars for the test graph).

The `RECENCY_HALF_LIFE_DAYS` setting (default 30, configurable per
graph via `forecastingSettingsService`) controls the weighting. This
is the same setting the analytic forecasting pipeline uses —
consistent semantics between Bayesian and analytic forecasts.

### Why this works

- **Window sees edge improvement first** → high-weight recent window
  trajectories pull edge-level `(mu, sigma)` toward current latency
- **FW composition propagates** → the edge-level posteriors compose
  into path-level CDFs automatically
- **Cohort completeness updates** → the cohort CDF uses the
  (now shifted) edge latencies, so immature cohort forecasts improve
- **No routing needed** → all trajectories participate, just at
  different strengths. No split, no bins, no cutoffs.

### Future: adaptive half-life from fit_history

When `fit_history` has 3+ entries, the DerSimonian-Laird `tau²`
(between-run variance) measures per-edge volatility. This can
modulate the effective half-life:

```
effective_half_life = base_half_life / (1 + k * tau²)
```

Volatile edges → shorter half-life → faster adaptation.
Stable edges → longer half-life → more data contributes.

This avoids a static half-life that's too aggressive for stable edges
or too conservative for volatile ones. Not implemented yet — requires
accumulated fit_history from multiple runs.

## 4. Phase D exit criteria status

| Criterion | Status |
|---|---|
| Latent latency variables | Done — `mu ~ Normal`, `sigma ~ Gamma` per edge |
| Path composition differentiable (FW) | Done — `pt_fw_chain`, verified by ancestor traversal |
| Completeness coupling fully joint | Done — cohort CDF uses latent path latency |
| Window couples to latent edge latency | Done — window CDF uses `(mu_lat, sigma_lat)` |
| Joint model distinguishes low-p from slow-latency | Done — convergence with 0 divergences |
| rhat/ESS acceptable | Done — rhat=1.001, ESS=2290 |
| Join-node collapse differentiable | Not tested — test graph has no non-trivial joins |
| Completeness-adjusted Multinomial per-sibling | Not tested — branch groups in test graph have <2 siblings with data |
| Recency weighting | Done — likelihood weighted by `exp(-ln2 * age / half_life)` |
| Cohort-level latency hierarchy | Done — onset_cohort, mu_cohort, sigma_cohort for 2+ latency-hop paths |
| Softplus onset | Done — smooth CDF boundary for latent onset |
