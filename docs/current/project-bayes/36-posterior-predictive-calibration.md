# Doc 36: Posterior Predictive Calibration

**Status**: Partial — `calibration.py` implemented, endpoint validated, trajectory blocked on synth DGP
**Date**: 11-Apr-26 (design), 12-Apr-26 (implementation)
**Depends on**: Doc 34 (kappa_lat), Doc 32 (LOO-ELPD), Doc 14 (Phase C)
**Implementation**: Doc 38 (findings and results)

---

## Objective

Verify that when the model says "90% of outcomes fall in this range",
approximately 90% of observed outcomes actually do. This is
**calibration** — the relationship between stated confidence and
empirical coverage.

LOO-ELPD (doc 32) answers "does the Bayesian model predict better than
the analytic null?" Calibration answers a different, complementary
question: "are the model's uncertainty claims honest?"

A model can have excellent LOO-ELPD (it predicts better than
alternatives) while still being miscalibrated (its 90% intervals
cover only 70% of data). Both are needed for trustworthy inference.

---

## Why this matters for DagNet

The FE draws confidence bands on:

- **Fan charts**: the shaded region around a conversion rate trajectory,
  derived from MC draws through `(p, mu, sigma, onset, kappa, kappa_lat)`
- **Posterior indicators**: the ± range shown on edge beads and cards
- **Cohort maturity curves**: forecast uncertainty bands

Users interpret these bands as "the true outcome should fall in here
with the stated probability". If the model is overconfident (bands too
narrow), users will be surprised by outcomes outside the range more
often than expected. If underconfident (bands too wide), the model
appears less informative than it is.

The dispersion parameters (`kappa` for p, `kappa_lat` for latency)
were specifically introduced to produce honest predictive uncertainty.
Calibration checking is how we verify they're working.

---

## What calibration means for each model component

### 1. Conversion rate p — "what fraction convert?"

**Observed data**: daily (n, k) counts — n users arrived, k converted.

**Predictive distribution**: for each posterior draw of (p, kappa),
the predicted k for a day with n arrivals is:

```
k_pred ~ BetaBinomial(n, p × kappa, (1 - p) × kappa)
```

Without overdispersion (kappa → ∞), this collapses to `Binomial(n, p)`.
The difference is the predictive variance: BetaBinomial has
`Var = n × p × (1-p) × (n + kappa) / (1 + kappa)`, which is larger
than Binomial's `n × p × (1-p)`.

**Calibration check**: for each observed (n_i, k_i), compute the
posterior predictive CDF at k_i. If calibrated, these CDF values
(PIT values) are Uniform(0, 1).

**Discrete correction**: because k is integer-valued, the CDF is a
step function. Use the randomised PIT:

```
u_i = F(k_i - 1) + V_i × [F(k_i) - F(k_i - 1)]
```

where `V_i ~ Uniform(0, 1)` and `F(k) = P(K ≤ k)` under the
posterior predictive. This produces continuous uniform PIT values
even for discrete data (Smith 1985, Czado et al. 2009).

### 2. Latency (mu, sigma, onset, kappa_lat) — "when do they convert?"

**Observed data**: trajectory intervals — for cohort day c, at
retrieval age t_j, the cumulative count is y_j out of n entrants.

**Predictive distribution**: the product-of-conditional-Binomials.
For each interval j, the conditional conversion count is:

```
d_j ~ BetaBinomial(n_j, q_j × kappa_lat, (1 - q_j) × kappa_lat)
```

where `q_j = p × ΔF_j / (1 - p × F_{j-1})` and `ΔF_j` is the CDF
increment from `ShiftedLogNormal(onset, mu, sigma)` over the interval.
Without kappa_lat, it's `Binomial(n_j, q_j)`.

**Calibration check**: same PIT approach, applied per interval. Each
(n_j, d_j) pair is one calibration observation. With ~100 cohort days
× ~5 intervals per day × 2 edges, a simple graph gives ~1000
calibration points per fit — enough for a reliable coverage curve.

### 3. Branch group splits — "which path do they take?"

**Observed data**: multinomial counts (k_1, ..., k_K) out of n.

**Predictive distribution**:

```
(k_1, ..., k_K) ~ DirichletMultinomial(n, kappa × p_vec)
```

**Calibration check**: for each component k_i, compute the marginal
PIT (the marginal is BetaBinomial). Or use the multivariate PIT via
Rosenblatt transform. The marginal approach is simpler and sufficient
for our purposes.

### 4. Per-slice parameters (Phase C)

The hierarchical structure produces per-slice p, mu, sigma, onset
that are partially pooled toward the edge-level base. Calibration
should be checked **per slice**, not just at the aggregate level.
A poorly calibrated slice (tau_slice too strong, shrinking too much)
may be masked by well-calibrated aggregate coverage.

---

## Diagnostic outputs

### Primary: coverage curve

For a set of nominal levels α ∈ {0.10, 0.20, ..., 0.90, 0.95}, compute
the **empirical coverage**: what fraction of observations fall within
the α-level posterior predictive interval?

Plot empirical coverage (y) vs nominal level (x). A calibrated model
traces the diagonal. The deviation pattern is diagnostic:

- **Below diagonal** (empirical < nominal): overconfident. The 90%
  interval covers only 75% of data. Bands are too narrow.
  Cause: kappa or kappa_lat too large (insufficient overdispersion),
  or posterior too concentrated.

- **Above diagonal** (empirical > nominal): underconfident. The 90%
  interval covers 98% of data. Bands are too wide.
  Cause: kappa or kappa_lat too small, or priors too diffuse.

- **S-shaped crossing**: the model is well-calibrated at some levels
  but not others. Common with misspecified tails.

### Secondary: PIT histogram

Histogram of PIT values with Uniform(0, 1) reference line. Diagnostic
shapes:

- **Uniform**: calibrated.
- **U-shaped**: overdispersed model (or underdispersed data) — too many
  observations in the tails. Intervals too narrow.
- **Inverse-U (bell)**: underdispersed model — observations cluster in
  the middle. Intervals too wide.
- **Skewed**: systematic bias in location (p or mu).

### Tertiary: per-edge coverage summary

A single number per edge: the empirical coverage at the 90% level.
This goes into the regression report as a new audit layer.

```
9. Calibration:     2 edges
     80844ce8… coverage@90%=0.88 (197/224 obs)  PIT_ks=0.04 (p=0.82)
     69320810… coverage@90%=0.91 (186/204 obs)  PIT_ks=0.03 (p=0.95)
```

`PIT_ks` is the Kolmogorov-Smirnov statistic testing PIT uniformity.
Small values (< 0.1) with large p-values confirm calibration. This
is a single-number summary suitable for automated pass/fail gating.

---

## Implementation

### Computation (new module: `bayes/compiler/calibration.py`)

```
compute_calibration(trace, evidence, topology) → dict[edge_id, EdgeCalibration]
```

For each edge, for each observation type (window daily, cohort
trajectory intervals, branch group):

1. **Extract observations**: the (n, k) or (n, d) pairs from evidence.

2. **Compute posterior predictive CDF per observation**: for each
   posterior draw (p_s, kappa_s, mu_s, sigma_s, onset_s, kappa_lat_s),
   compute the predictive CDF at the observed value. Average across
   draws to get the posterior predictive CDF. This is an MC integral:

   ```
   F(k_obs) = (1/S) Σ_s F_BetaBinom(k_obs; n, p_s × kappa_s, (1-p_s) × kappa_s)
   ```

   where S is the number of posterior draws.

3. **Compute randomised PIT**: for discrete data, apply the randomised
   PIT transformation.

4. **Aggregate into coverage curve**: for each nominal level α, compute
   the fraction of PIT values in [α/2, 1 - α/2] (for equal-tailed
   intervals) or equivalently count how many observations fall within
   the α-level HDI. The HDI approach is more natural for skewed
   predictive distributions.

5. **KS test**: test PIT uniformity via Kolmogorov-Smirnov.

### Performance considerations

For each observation, we evaluate the predictive CDF across all
posterior draws. With S=2000 draws × 4 chains = 8000 samples and
~1000 observations, this is 8M CDF evaluations. For BetaBinomial,
each CDF evaluation is a call to `scipy.stats.betabinom.cdf()` — fast
(microseconds each), so total ~8 seconds. Acceptable as a post-sampling
diagnostic.

For trajectory intervals with latent latency, the CDF computation
involves `ShiftedLogNormal` and the conditional hazard `q_j`. This is
more expensive but still O(seconds) — the CDF values are scalar
functions of the drawn parameters, not PyTensor graph evaluations.

### Integration with regression pipeline

1. **Worker**: call `compute_calibration()` after `compute_loo_scores()`,
   pass results to `summarise_posteriors()` for inclusion in the
   result payload.

2. **Harness log**: emit per-edge calibration summary lines:
   ```
   calibration: {uuid}… coverage@90%=0.88 n_obs=224 PIT_ks=0.04
   ```

3. **Audit**: parse calibration lines, add as layer 9.

4. **Pass/fail gate**: warn if coverage@90% < 0.80 or > 0.97
   (substantially miscalibrated). Fail if < 0.70 (severely
   overconfident — the bands are meaningless).

### Downstream uses

Beyond regression, calibration results can be:

- **Stored in the posterior payload** (`calibration_coverage_90`,
  `pit_ks_pvalue` per edge) so the FE can show a calibration badge.
- **Used to auto-adjust band widths**: if empirical coverage at 90%
  is only 80%, the FE could widen bands by a correction factor. This
  is "recalibration" — a post-hoc fix for miscalibrated models. Not
  recommended as a first step (fix the model instead), but useful as
  a safety net.
- **Tracked over time**: a graph's calibration across successive fits
  reveals whether model improvements (kappa_lat, new priors) actually
  improve coverage.

---

## Relationship to existing diagnostics

| Diagnostic | Question answered | Complementary? |
|-----------|-------------------|----------------|
| **Parameter recovery** (synth) | Does the model recover known truth? | Yes — recovery says params are right, calibration says uncertainty is right |
| **LOO-ELPD** (doc 32) | Does the model predict better than alternatives? | Yes — LOO compares models, calibration checks absolute honesty |
| **rhat / ESS** | Did the sampler converge? | Yes — convergence is necessary but not sufficient for calibration |
| **kappa / kappa_lat** | Is overdispersion captured? | Calibration directly tests whether kappa/kappa_lat produce honest intervals |
| **PPC (visual)** | Does replicated data look like real data? | Calibration is the quantitative version — replaces subjective visual assessment |

---

## What this replaces

Currently, the only check on interval honesty is visual: a developer
looks at the fan chart and judges whether the bands "look right".
This is subjective, inconsistent, and impossible to automate. The
calibration check replaces this with a number: coverage@90%=0.88
means the bands are slightly narrow, coverage@90%=0.91 means they're
spot on.

---

## Relationship to generalised forecast engine (doc 29)

PPC calibration and the generalised forecast engine (doc 29) share one
critical primitive: evaluating `ShiftedLogNormal` CDF at a retrieval
age to get the conditional hazard `q_j = p × ΔF / (1 - p × F_prev)`.
The forecast engine uses this to project maturity curves forward; PPC
uses it to compute the predictive CDF at an observed count backward.
Same maths, different direction.

PPC should **not** use the forecast engine's higher-level abstractions
(span kernels, x_providers, multi-hop composition, analysis-type
registration). Those are about composing analyses across time horizons
and analysis types. PPC is pointwise: one observation, one set of
posterior draws, one CDF evaluation.

PPC should **share the CDF/hazard primitives**:

- `shifted_lognormal_cdf()` from `compiler/completeness.py` — already
  exists, used by both model.py and evidence.py
- The conditional hazard computation (numpy version of what model.py
  does in PyTensor) — PPC needs this in pure Python for evaluating
  against posterior draws
- `scipy.stats.betabinom.cdf()` for the predictive distribution

When the generalised forecast engine extracts a pure-Python
`evaluate_edge_predictive_cdf(age, p, mu, sigma, onset, kappa,
kappa_lat, n)` function, PPC should consolidate onto it rather than
maintaining its own copy. But PPC should not wait for that extraction
— build with its own numpy hazard evaluation now, consolidate later.

This is a candidate for the "shared primitive" layer that doc 29
Phase B should extract: a model-evaluation function that both the
forecast engine and the calibration checker can call.

---

## Open design questions

1. **Per-edge or per-observation-type?** A single edge has window daily
   obs, cohort trajectory intervals, and possibly branch group counts.
   Should calibration be reported separately for each type? Probably
   yes — the window daily path uses BetaBinomial while the trajectory
   path uses product-of-conditional-Binomials, and they may have
   different calibration properties.

2. **Phase 1 vs Phase 2 calibration**: Phase 1 fits to window data;
   Phase 2 refits to cohort data using Phase 1 posteriors as priors.
   Should calibration check Phase 1 predictions against window data,
   Phase 2 predictions against cohort data, or the final model against
   all data? The last risks double-dipping (checking the model against
   data it was trained on). For regression on synth data where truth is
   known, this is less of a concern — we're checking the predictive
   distribution, not fitting it.

3. **Cross-validated calibration**: to avoid the double-dipping concern,
   use LOO-style leave-one-out PIT values. ArviZ's `loo_pit()` function
   does exactly this — it computes PIT values using the LOO predictive
   distribution (each observation's PIT is computed without that
   observation in the fit). This is more rigorous but requires the
   pointwise log-likelihood that we've now wired up for trajectory
   Potentials. This is the recommended approach.

4. **Threshold calibration**: for the pass/fail gate, what coverage
   deviation is acceptable? With 200 observations, the standard error
   of empirical coverage at 90% is `sqrt(0.9 × 0.1 / 200) ≈ 0.021`.
   So coverage in [0.86, 0.94] is within 2 SE of perfect. A threshold
   of 0.80 (5 SE below) is conservative; 0.85 (2.5 SE) is moderate.

---

## References

- Talts, S., Betancourt, M., Simpson, D., Vehtari, A., & Gelman, A.
  (2018). [Validating Bayesian Inference Algorithms with Simulation-Based Calibration](https://arxiv.org/pdf/1804.06788).
- Czado, C., Gneiting, T., & Held, L. (2009). Predictive model
  assessment for count data. *Biometrics*, 65(4), 1254-1261.
  (Randomised PIT for discrete distributions.)
- Gelman, A. (2017). [Bayesian posteriors are calibrated by definition](https://statmodeling.stat.columbia.edu/2017/04/12/bayesian-posteriors-calibrated/).
  (Why calibration checking is still necessary despite this property.)
- Gelman, A. (2012). [Yes, checking calibration of probability forecasts is part of Bayesian statistics](https://statmodeling.stat.columbia.edu/2012/12/06/yes-checking-calibration-of-probability-forecasts-is-part-of-bayesian-statistics/).
- ArviZ: [PIT ECDF plot documentation](https://arviz-plots.readthedocs.io/en/stable/gallery/plot_ppc_pit.html),
  [Prior and Posterior Predictive Checks](https://www.pymc.io/projects/docs/en/stable/learn/core_notebooks/posterior_predictive.html).
- Stan: [Posterior and Prior Predictive Checks](https://mc-stan.org/docs/stan-users-guide/posterior-predictive-checks.html),
  [Simulation-Based Calibration](https://mc-stan.org/docs/stan-users-guide/simulation-based-calibration.html).
