# Doc 34 — Latency Dispersion: Background, Design, and Implementation

**Date**: 10-Apr-26
**Updated**: 13-Apr-26
**Status**: Implemented (feature-flagged `latency_dispersion`).
Per-interval BetaBinomial approach. Regression: 10/11 uncontexted
graphs pass parameter recovery with flag on. Remaining failure
(`synth-forecast-test`) is a pre-existing p recovery issue on a
join-downstream edge, not related to kappa_lat.

---

## 1. What this document is for

This note captures the current model's parameterisation of "whether"
and "when" people convert, explains exactly where we have proper
predictive aleatoric dispersion estimates and where we don't, and
documents the implemented solution.

---

## 2. The two processes the model captures

The Bayesian compiler models conversion along a graph edge as two
separable processes:

1. **Whether** someone converts — parameterised by `p` (a probability
   in [0, 1])
2. **When** they convert, given that they do — parameterised by a
   shifted lognormal CDF with parameters `(onset, mu, sigma)`

These are coupled in inference because the same trajectory data
constrains both simultaneously (the product-of-conditional-Binomials
likelihood in `model.py` decomposes each cohort's maturation curve
into interval hazards that depend on both `p` and the CDF shape).
But they are conceptually distinct quantities with distinct predictive
uncertainty stories.

### 2.1 The "whether" process: p and kappa

**Model structure:**

- `p ~ Beta(alpha, beta)` — the edge conversion probability
- `kappa ~ LogNormal(mu_k, sigma_k)` — per-edge overdispersion
  concentration

**What kappa represents:**

Kappa is an overdispersion parameter. It says: "even if the true
long-run rate is p, on any given day the realised rate is a draw from
Beta(p*kappa, (1-p)*kappa)". High kappa = tight around p (close to
Binomial). Low kappa = large day-to-day scatter.

**The predictive distribution for p:**

Because kappa is sampled as a random variable, the model produces a
proper **predictive** distribution for the rate. This predictive
distribution is wider than the posterior on p itself. The posterior
says "how precisely do we know the mean rate?" The predictive says
"what rate will we observe tomorrow?" The difference is kappa — it
captures the aleatoric (irreducible) scatter in the rate process.

**This is the gold standard.** p has a proper aleatoric predictive
distribution because the model explicitly parameterises the
observation-level overdispersion (kappa) as a learned random variable.

### 2.2 The "when" process: onset, mu, sigma

**Model structure:**

- `onset ~ softplus(Normal(...))` — minimum delay before any
  conversions (latent in Phase D.O, else frozen from histogram)
- `mu ~ Normal(mu_prior, sigma_prior)` — log-scale centre of the
  lognormal delay distribution
- `sigma ~ softplus(Normal(...))` — log-scale spread of the lognormal
  delay distribution

Together, `ShiftedLogNormal(onset, mu, sigma)` defines a CDF that
predicts what fraction of eventual converters have converted by
time `t`. It is the "completeness curve" — the timing model.

**What the model did NOT have for latency (before this work):**

There was no kappa-analogue for the timing process. The model assumed
all trajectories share exactly the same CDF shape `(onset, mu,
sigma)`. Any variation across cohorts in their maturation speed was
absorbed into the posterior uncertainty on the shared parameters, but
this is **epistemic** uncertainty (how well we know the single true
shape), not **aleatoric** uncertainty (how much the shape genuinely
varies).

### 2.3 The asymmetry, stated precisely

| Aspect | p (whether) | Latency (when) |
|--------|------------|----------------|
| Point estimate | p posterior mean | (onset, mu, sigma) posterior means |
| Epistemic uncertainty | posterior SD on p (shrinks with data) | posterior SDs on onset/mu/sigma (shrink with data) |
| Aleatoric overdispersion | **kappa (learned RV)** | **kappa_lat (learned RV)** — added by this work |
| Predictive distribution | Beta(p*kappa, (1-p)*kappa) | BetaBinomial per-interval (see §8) |
| What the fan chart uses | p_sd from predictive (correct) | mu_sd from posterior (epistemic only — §3) |

### 2.4 Phase C cross-slice latency parameters

Phase C introduces per-context-slice latency parameters
(`tau_mu_slice`, `tau_sigma_slice`, `tau_onset_slice` in
`model.py:1136-1138`). These are **cross-slice shrinkage** parameters
— they model how much the timing shape differs between context slices
(e.g. "organic" vs "paid" traffic). They are hierarchical priors
across slices, NOT dispersion parameters for the timing process itself.

`tau_mu_slice` says: "the organic slice might have mu = 2.1 while the
paid slice has mu = 1.8". It does NOT say: "within the organic slice,
individual cohorts' timing varies beyond what LogNormal(2.1, sigma)
predicts".

Phase C does not solve the problem described here.

---

## 3. How dispersion estimates reach the fan chart

The fan chart generates Monte Carlo draws of `(p, mu, sigma, onset)`
from a multivariate normal centred on the posterior means with a
covariance matrix built from exported SDs (`confidence_bands.py`,
`cohort_forecast.py`, `cohort_forecast_v2.py`).

For p: `p_sd` comes from the predictive distribution (via kappa).
This is the right quantity.

For latency: `mu_sd`, `sigma_sd`, `onset_sd` come from one of two
sources depending on model variable promotion:

1. **Bayesian posterior SDs** — pure epistemic. With many trajectories
   they shrink toward zero (mu_sd ≈ 0.005), implying sub-day
   prediction precision. We cannot predict to that accuracy.

2. **Analytic heuristic SDs** — approximate frequentist standard
   errors. Also epistemic but coarser. Not calibrated and have known
   problems (onset_sd amplification at the CDF inflection point,
   programme.md §1512-1568).

Neither source captures aleatoric variation in the timing process.

---

## 4. The inference coupling between p and latency

The "whether" and "when" processes are not independently inferrable.
In the product-of-conditional-Binomials likelihood, both `p` and
the CDF appear in the same expression. The daily BetaBinomial
observations help break this degeneracy by anchoring p independently,
but the coupling remains for immature cohorts.

This coupling means any latency dispersion model will interact with
p inference. Over-parameterisation risk is real.

---

## 5. Failed approach: per-cohort mu random effects

### 5.1 What was tried

Per-cohort latent mu offsets: `mu_c = mu + tau_mu * u_c` with
`u_c ~ N(0,1)` and `tau_mu ~ HalfNormal(0.2)`. Non-centred
parameterisation. One `tau_mu` per edge, N per-cohort offsets.

### 5.2 Why it failed

With ~97 trajectories and 97 per-cohort mu offsets, the model had
roughly as many mu parameters as data points. Each cohort's offset
absorbed its own trajectory's signal, leaving the shared mu
underconstrained. ESS collapsed to 3. The posterior mu collapsed to
the prior (0.0 for some edges). `corr(onset, mu) ≈ 0.97` — the
onset-mu ridge was completely unresolved.

### 5.3 Root cause

kappa works because it is ONE parameter constrained by MANY daily
observations. The per-cohort mu approach had N parameters constrained
by N trajectories — one-to-one. There was no pooling pressure.

### 5.4 Lesson

The right analogue of kappa for timing is a scalar parameter that
inflates variance at the observation level, not per-subject latent
variables. This is the frailty model insight from survival analysis
literature.

---

## 6. Implemented approach: per-interval BetaBinomial (kappa_lat)

### 6.1 The parameterisation

Add a single `kappa_lat` parameter per edge (LogNormal prior,
matching kappa). Replace the per-interval Binomial likelihood with
BetaBinomial:

Current (without flag):
```
q_j = p * delta_F_j / (1 - p * F_{j-1})
d_j ~ Binomial(n_j, q_j)
```

With `latency_dispersion=true`:
```
q_j = p * delta_F_j / (1 - p * F_{j-1})
d_j ~ BetaBinomial(n_j, q_j * kappa_lat, (1 - q_j) * kappa_lat)
```

One scalar parameter per edge. Same mean, inflated variance.
Same pattern as kappa for p. Native `pm.BetaBinomial` support in
PyMC (uses `BetaBinomial.dist()` + `pm.logp()` for weighted
Potential, avoiding manual gammaln that caused compilation timeouts
on larger graphs).

### 6.2 What kappa_lat captures

Per-interval overdispersion in the discrete-time hazard. If one
cohort happens to convert faster than the model predicts in early
intervals, the BetaBinomial absorbs that without distorting
onset/mu/sigma. Large kappa_lat = the shifted lognormal fits
tightly. Small kappa_lat = significant timing noise beyond what
the parametric CDF predicts.

### 6.3 What kappa_lat does NOT capture

Correlated within-cohort timing deviations. Each interval's noise
is independent. A cohort that is "systematically fast overall"
would need correlated q_j perturbations — that is the Gamma frailty
model (§7), which is the upgrade path if per-interval BetaBinomial
proves insufficient.

### 6.4 Scope of current implementation

- **Single-path trajectories**: kappa_lat is active. Both window and
  cohort obs_type trajectories get their own kappa_lat variable.
- **Mixture (join-node) trajectories**: kappa_lat is NOT yet active.
  The mixture path computes a weighted sum of per-alternative CDFs;
  adding kappa_lat there is more complex and deferred.
- **Phase C per-slice**: kappa_lat applies per-slice when slices
  have their own trajectory emissions.
- **Flag off**: zero impact on existing model. No new variables, no
  code path changes.

---

## 7. Future upgrade path: Gamma frailty

If posterior predictive checks show systematic cohort-level deviations
that per-interval BetaBinomial doesn't capture, upgrade to Gamma
frailty with complementary log-log link. This gives one scalar θ per
edge that captures correlated within-cohort timing variation with an
analytical marginal (no per-cohort latents). See Hougaard (2000)
Ch. 7, Singer & Willett (2003) Ch. 12.

Do NOT add per-cohort sigma_c — it is the easiest to make weakly
identified (§5.2).

---

## 8. Implementation details

### 8.1 Files changed

| File | Change |
|------|--------|
| `bayes/compiler/model.py` | Feature flag `latency_dispersion`, kappa_lat creation + BetaBinomial likelihood in `_emit_cohort_likelihoods` single-path block |
| `bayes/compiler/inference.py` | Extract kappa_lat posterior from trace, report in diagnostics |
| `bayes/compiler/types.py` | `kappa_lat_mean`, `kappa_lat_sd` on `LatencyPosteriorSummary` + webhook dict |
| `bayes/worker.py` | Thread kappa_lat fields through `_build_unified_slices` |
| `bayes/synth_gen.py` | Per-cohort mu variation via `tau_mu` truth file field (for generating synth data with known timing dispersion) |

### 8.2 Feature flag

`latency_dispersion` (default `false`). Set via `--feature
latency_dispersion=true` on `test_harness.py`, `param_recovery.py`,
or `run_regression.py`.

### 8.3 FE surfacing

No new FE concept needed. `mu_sd` in the existing pipeline already
carries the posterior SD. When kappa_lat is available, the fan chart
gets the right uncertainty automatically through the existing
`mu_sd` → `promoted_mu_sd` → `bayes_mu_sd` → MC draw path.

The user sees `μ ± sd` with the same meaning as `p ± sd`: "how much
will this vary?" Not "how precisely do we know the mean?".

kappa_lat itself is an internal model parameter, not surfaced to the
user. It is analogous to kappa — users don't see kappa either.

---

## 9. Regression results (11-Apr-26)

10 of 11 uncontexted synth graphs pass parameter recovery with
`latency_dispersion=true`. All 11 graphs bind snapshot data correctly
(zero fallbacks). kappa_lat is active on the 4 simple-chain graphs
(simple-abc, mirror-4step, drift10d10d, drift3d10d); the other 7
use the mixture path where kappa_lat is not yet implemented.

The one failure (`synth-forecast-test`) is a pre-existing p recovery
issue on a join-downstream edge (p truth=0.300, post=0.845), not
caused by kappa_lat.

---

## 10. Onset-mu identifiability and reparameterisation options

**Date**: 13-Apr-26
**Status**: Research complete. No code changes yet.

### 10.1 The problem, stated precisely

The shifted lognormal `T = onset + LogNormal(mu, sigma)` has a
well-documented identifiability problem: onset and mu create a narrow
curved ridge in the posterior. Increasing onset while decreasing mu
(or vice versa) produces near-identical likelihoods. The ridge is
non-linear because of the exp() relationship between mu and observable
location.

This is not a tuning issue. The brms package (Stan) reports typical
onset-mu correlations of -0.84 on well-behaved data (Bürkner,
[Stan Discourse: shifted lognormal parameters and priors][brms-ndt]).
Our §5 documents `corr(onset, mu) ≈ 0.97` in the per-cohort mu
experiment — the ridge is even more severe in our setting because we
observe interval counts, not raw delay values.

In the classical (frequentist) setting the problem is worse: the
global MLE for the 3-parameter lognormal does not exist because the
likelihood is unbounded as the threshold approaches the data minimum
(Cohen & Whitten, 1985; [Consistency of MLE for 3-param
lognormal][mle-consistency]).

### 10.2 Why our setting is distinct

Most literature on shifted lognormals assumes direct observation of
delay times. We observe **conversion counts in discrete time
intervals** and infer the latency distribution from the CDF shape
via a product-of-conditional-Binomials likelihood. This means:

- The hard-boundary singularity (likelihood → ∞ as onset → min(data))
  does not apply in the same form — we never observe a raw delay
  value that onset could approach.
- However, the **identifiability ridge is still real** because the CDF
  shape depends on `onset + exp(mu)` as an approximate location, and
  our interval-count data constrains the CDF shape, not the parameters
  individually.
- The gradient discontinuity issues documented for direct-observation
  models ([PyMC Discourse: lognormal constraint poor
  convergence][pymc-clip]) are less relevant, but NUTS divergences
  from the ridge geometry still apply.

### 10.3 Reparameterisation options

All options below are **mathematically identical** to the current
model — they are coordinate transforms of the sampling space. All
downstream consumers (posterior extraction, FW convolutions,
rendering, warm-start) continue to see `(onset, mu, sigma)` after
back-transformation. The model block performs the forward transform
internally.

#### Option A: Sample median_excess = exp(mu)

Sample `median_excess` on the data scale (days), derive
`mu = log(median_excess)` inside the model.

- **Rationale**: removes the exp() nonlinearity from the posterior
  geometry, straightening the banana-shaped ridge into something more
  elliptical. HMC handles ellipses well.
- **Limitation**: the ridge between onset and median_excess persists
  because the data primarily constrains their sum. The improvement is
  partial — the nonlinearity is removed but the correlation remains.
- **Implementation**: one-line change at `model.py:777-800`. Replace
  `pm.Normal("mu_lat_...")` with `pm.LogNormal("median_excess_lat_...",
  ...)` and define `mu = pm.math.log(median_excess)`.
- **Prior**: LogNormal centred at exp(mu_prior), or Gamma with mode
  at exp(mu_prior). Both enforce positivity naturally.

#### Option B: Sample total_median = onset + exp(mu)

Sample the overall median of the shifted lognormal directly, derive
`mu = log(total_median - onset)` inside the model. Requires
`onset < total_median`.

- **Rationale**: the data most directly constrains the overall median
  (it is approximately the sample median of the delay distribution).
  This parameter is well-identified. The ridge disappears because
  onset and total_median have distinct roles — onset shifts the
  support, total_median locates the bulk.
- **Limitation**: introduces a constraint `onset < total_median` that
  must be enforced (e.g. via ordering or a log-difference transform).
  More complex to implement than Option A.
- **Evidence**: analogous to the quantile-based reparameterisation
  shown to dramatically improve MCMC convergence for GEV distributions
  ([Reparameterisation of extreme value framework, 2023][gev-reparam];
  [Orthogonal reparameterisation for improved Bayesian
  workflow][orthog-reparam]).

#### Option C: Onset as proportion (shiftprop)

Sample `onset_prop ~ Beta(a, b)` on [0, 1], derive
`onset = onset_prop × max_onset` where `max_onset` is an externally
set upper bound.

- **Rationale**: this is what brms does internally for the `ndt`
  (non-decision time) parameter ([brms shifted_lognormal
  family][brms-shifted]). The Beta prior naturally keeps mass away
  from the boundary. The logit-scale transform gives the sampler
  unconstrained geometry.
- **Limitation**: requires choosing `max_onset`, which embeds a hard
  assumption. In our setting, graph topology could provide this
  (minimum plausible delay from upstream path structure).
- **Evidence**: Bürkner recommends this approach and notes that
  models without it have initialisation and convergence problems
  ([Stan Discourse: starting values for ndt][brms-init]).

#### Option D: Graph-derived informative onset priors

Use the conversion graph structure to derive tight priors on onset
per edge. Downstream edges have onset constrained by the minimum
plausible delay through all upstream paths.

- **Rationale**: onset is not a free parameter in our domain — it is
  constrained by the physics of the conversion funnel. Treating it as
  free is what makes it trade off with mu. Constraining it with domain
  knowledge is correct modelling, not a hack.
- **Limitation**: requires a topology pass to compute minimum upstream
  delays. Already partially implemented (onset_delta_days from lag
  summaries).
- **Combines well with Options A or B**: graph priors constrain onset,
  reparameterisation improves the mu-side geometry.

### 10.4 Recommended approach

Combine **Option A** (sample median_excess) with **Option D**
(graph-derived onset priors) as a first step:

1. Reparameterise mu → median_excess inside the model block. This is
   a minimal, self-contained change that improves posterior geometry
   without touching any downstream code.
2. Verify on synth regression that onset-mu correlation improves and
   parameter recovery is at least as good as current.
3. If the ridge remains problematic, escalate to **Option B**
   (total_median), which is the strongest reparameterisation but
   requires more implementation work.

The key implementation point: `mu = log(median_excess)` is computed
inside the model as a `pm.Deterministic`. All existing posterior
extraction code in `inference.py` reads `mu_lat_{id}` from the trace
— this variable name can be retained as a Deterministic, so no
downstream changes are needed. Alternatively, extract `median_excess`
and convert to mu in `summarise_posteriors`.

### 10.5 References

[brms-ndt]: https://discourse.mc-stan.org/t/understanding-shifted-lognormal-parameters-and-priors/13519
  "Understanding shifted lognormal parameters and priors — Stan
  Discourse (brms). Reports cor(Intercept, ndt_Intercept) = -0.84."

[brms-init]: https://discourse.mc-stan.org/t/setting-starting-values-on-ndt-intercept-of-shifted-lognormal-model/17332
  "Setting starting values on ndt intercept of shifted lognormal
  model — Stan Discourse. Bürkner on initialisation difficulties."

[brms-shifted]: https://rdrr.io/cran/brms/man/Shifted_Lognormal.html
  "brms::Shifted_Lognormal family documentation. Internal shiftprop
  parameterisation."

[pymc-clip]: https://discourse.pymc.io/t/lognormal-constraint-poor-convergence/15901
  "Lognormal constraint poor convergence — PyMC Discourse. Documents
  gradient discontinuity from clipping near the threshold boundary."

[mle-consistency]: https://www.sciencedirect.com/science/article/abs/pii/S0167715215001856
  "On the consistency of the MLE for the three-parameter lognormal
  distribution. The global MLE does not exist."

[gev-reparam]: https://arxiv.org/abs/2210.05224
  "Reparameterization of extreme value framework for improved
  Bayesian workflow (2023). Quantile-based reparameterisation
  dramatically improves MCMC convergence."

[orthog-reparam]: https://www.sciencedirect.com/science/article/abs/pii/S0167947323001184
  "Orthogonal reparameterisation significantly improves MCMC
  convergence, ESS, and facilitates Jeffreys/PC prior derivation."

[cohen-whitten]: https://www.researchgate.net/publication/230516937_Estimation_of_parameters_in_the_three_parameter_lognormal_distribution
  "Cohen & Whitten (1985). Estimation of parameters in the
  three-parameter lognormal distribution."

[stan-reparam]: https://mc-stan.org/docs/2_18/stan-users-guide/reparameterization-section.html
  "Stan User's Guide: Reparameterization. General principles for
  reducing posterior correlation via coordinate transforms."

[stan-priors]: https://github.com/stan-dev/stan/wiki/Prior-Choice-Recommendations
  "Stan Prior Choice Recommendations. Gelman et al. (1996) advice:
  reparameterise to aim for approximate prior independence."

[modrak-rt]: https://www.martinmodrak.cz/2021/04/01/using-brms-to-model-reaction-times-contaminated-with-errors/
  "Martin Modrak: Using brms to model reaction times with shifted
  lognormal. Practical experience with ndt parameterisation."

[pymc-shifted-ppc]: https://discourse.pymc.io/t/sampling-posterior-predictive-from-shifted-lognormal/5172
  "Sampling posterior predictive from shifted lognormal — PyMC
  Discourse."

[hill-1963]: Hill, B.M. (1963). The three-parameter lognormal
  distribution and Bayesian analysis of a point-source epidemic.
  JASA 58(301), 72-84. Warns that priors must assign negligible
  probability near the threshold singularity.

[hougaard-2000]: Hougaard, P. (2000). Analysis of Multivariate
  Survival Data. Springer. Ch. 7: Gamma frailty models.

---

## 11. Further research: the three-way surface and quantile reparameterisation

**Date**: 13-Apr-26
**Status**: Research notes. No code changes.

### 11.1 The onset-sigma ridge (overlooked in §10)

§10 focuses on the onset-mu ridge. But in our discrete-time setting,
**onset and sigma also trade off**: a wider sigma with earlier onset
produces similar interval-boundary CDF values to a narrower sigma with
later onset. The data constrains the CDF shape at interval boundaries,
not the parameters individually — so any pair of parameters whose
combined effect on boundary CDF values is degenerate will form a ridge.

This means the identifiability problem is a **three-way surface**
(onset, mu, sigma), not a two-parameter ridge. Option A (sample
median_excess) straightens the onset-mu axis but leaves the
onset-sigma and mu-sigma axes untouched.

### 11.2 Why quantiles are the natural sampling coordinates

Our interval-count likelihood constrains **CDF values at interval
boundaries**. The CDF of the shifted lognormal at boundary `t_j` is:

```
F(t_j) = Phi((log(t_j - onset) - mu) / sigma)
```

The data most directly identifies these CDF values — not (onset, mu,
sigma) individually. A parameterisation that samples quantities
corresponding to CDF features should therefore be better identified.

**Quantile parameterisation**: sample `(onset, p50, p90)` where p50
and p90 are the 50th and 90th percentiles of the shifted lognormal.
Then derive:

```
mu    = log(p50 - onset)
sigma = (log(p90 - onset) - mu) / Phi^{-1}(0.9)
      = (log(p90 - onset) - log(p50 - onset)) / 1.2816
```

**Why this orthogonalises all three parameters**:

- `onset` controls where the CDF lifts off zero — identified by the
  earliest intervals with non-zero conversions.
- `p50` controls where the CDF crosses 0.5 — identified by the
  interval where roughly half of eventual converters have arrived.
- `p90` controls the tail — identified by the late intervals where
  the CDF approaches 1.

These three quantities answer **distinct empirical questions** about
the maturation curve. No ridge because increasing p50 does not
compensate for decreasing onset in the way that increasing mu does.

**Ordering constraint**: `onset < p50 < p90` is enforced naturally
via log-differences:

```
onset         ~ prior (see §10.3 Options C/D)
log_gap_50    ~ Normal(...)    # log(p50 - onset)
log_gap_90_50 ~ Normal(...)    # log(p90 - p50)
p50 = onset + exp(log_gap_50)
p90 = p50   + exp(log_gap_90_50)
```

**Relationship to Options A and B**: Option B (sample total_median)
is the special case where only p50 is reparameterised. The full
quantile parameterisation extends this to also reparameterise sigma
via p90, addressing the onset-sigma ridge that Option B alone does
not resolve.

**Theoretical basis**: the GEV quantile reparameterisation
([gev-reparam]) demonstrated dramatic MCMC convergence improvements
by sampling quantiles instead of distributional parameters. The
approach is general to any location-scale family. The 2025 paper on
orthogonal GEV parameterisations ([orthog-gev]) explicitly states
that for the full three-parameter case (threshold + location + scale),
analytical orthogonalisation is "very challenging, if not impossible"
— quantile parameterisation sidesteps this by choosing coordinates
that are *empirically* rather than *analytically* orthogonal.

**Prior elicitation**: priors on quantiles are more intuitive than
priors on log-scale parameters. "Median conversion delay is 10–20
days" is directly expressible as a prior on p50. "90th percentile
delay is 30–60 days" is directly expressible as a prior on p90.

### 11.3 Alternative families

If reparameterisation within the shifted lognormal family proves
insufficient, switching family entirely may be cleaner than further
contortions.

| Family | Onset ridge severity | Notes |
|--------|---------------------|-------|
| Shifted lognormal | Severe (three-way) | Current model. Ridge is intrinsic to the family. |
| **Shifted Weibull** | Moderate | Monotonic hazard — shape and scale have more distinct CDF signatures at interval boundaries. Two shape parameters instead of three reduces the ridge dimension. |
| **Ex-Gaussian** | None | No shift parameter. Gaussian component captures the bulk timing; exponential component τ captures late converters. Eliminates the onset concept entirely. |
| Shifted Gamma | Moderate | Similar to Weibull. Allows non-monotonic hazard but adds complexity. |

The **ex-Gaussian** is the most radical option: it eliminates the
onset parameter and replaces the shifted lognormal with
`Normal(mu_g, sigma_g) + Exponential(tau)`. The convolution has a
closed-form CDF. The three parameters (mu_g, sigma_g, tau) are
well-identified because they control different parts of the density
shape (symmetric bulk vs right tail). This family is standard in
reaction-time modelling (Matzke & Wagenmakers, 2009; [beests]).

**Cost**: loss of the interpretable "minimum delay before any
conversion" concept. The ex-Gaussian support starts at -∞ (though
mass below zero is negligible for reasonable parameters). If the
onset concept is important for domain reasons (e.g. "it takes at
least N days to complete this conversion step"), the ex-Gaussian
does not naturally express this.

**Shifted Weibull** retains the onset concept with a simpler
identifiability structure. The CDF is
`1 - exp(-((t - onset) / lambda)^k)` — two shape parameters (lambda,
k) instead of three (onset, mu, sigma) once onset is separated. The
monotonic hazard is a limitation (cannot model non-monotonic
conversion rates within a step), but most conversion funnel edges
have monotonically increasing hazard in practice.

### 11.4 Cox-Reid orthogonalisation: theoretical limits

The Cox-Reid (1987) framework establishes conditions for
information-orthogonal parameterisations where the Fisher information
matrix is block-diagonal. For threshold-location-scale families:

- **Two-parameter case** (onset fixed): orthogonal reparameterisation
  of (mu, sigma) is tractable and yields asymptotically uncorrelated
  MLEs ([orthog-gev]).
- **Three-parameter case** (onset free): the orthogonal transform
  involves solving a PDE system that has no known closed-form solution
  for the lognormal family.

**Practical implication**: if onset can be constrained via domain
knowledge (Option D), Cox-Reid orthogonalisation of (mu, sigma) is
feasible and would complement the quantile approach. If onset must
remain free, the quantile parameterisation is the best available
alternative to analytical orthogonalisation.

### 11.5 Current parameterisation (for reference)

```
onset   ~ softplus(Normal(...))          — minimum delay
mu      ~ Normal(mu_prior, sigma_prior)  — log-scale centre
sigma   ~ Gamma(alpha, beta)             — log-scale spread
t95_obs ~ Normal(t95_model, sigma_t95)   — soft constraint (bolt-on)

where  t95_model = onset + exp(mu + 1.6449 * sigma)
```

sigma and onset trade off (§11.1). The t95 soft constraint partially
anchors this, but as an observation it competes with the likelihood
rather than structurally resolving the ridge.

### 11.6 Available prior information (what we actually have today)

Any reparameterisation must derive its priors from these sources —
nothing else exists.

| Source | Field | Available? | Notes |
|--------|-------|-----------|-------|
| Analytic stats pass | `ev.latency_prior.mu` | Always (when latency active) | From histogram fit |
| Analytic stats pass | `ev.latency_prior.sigma` | Always (when latency active) | From histogram fit |
| Histogram 1st percentile | `lp.onset_delta_days` | Always | Can be 0 |
| Histogram spread | `lp.onset_uncertainty` | Always | Floored to 1.0 |
| Histogram observations | `lp.onset_observations` | Sometimes | Needs ≥3 retrievals |
| Histogram 95th percentile | `et.t95_days` | **Sometimes None** | Guarded at `model.py:812` |

Key constraints on any proposal:
- `onset_delta_days = 0` is common. Any transform involving
  `log(onset)` or `logit(onset / X)` must handle this gracefully
  (→ -∞ on the transformed scale).
- `t95_days` is not always available. A fallback is needed.
- `mu_prior` and `sigma_prior` from the analytic pass are always
  available but are point estimates from a histogram fit, not
  calibrated Bayesian priors.

### 11.7 Proposal A: sample (onset, mu, raw_gap) — replace sigma only

**Status**: Superseded by Proposal B (§11.8). Documented here to
record the reasoning that led to it.

**Idea**: keep onset and mu as sampled parameters. Replace sigma with
`raw_gap ~ Normal(...)` where `sigma = softplus(raw_gap) / 1.6449`.
The existing t95 soft constraint block disappears; its information
enters through the prior on `raw_gap`.

**What this addresses**: the onset-sigma ridge. Sigma is no longer
free — it is a deterministic function of raw_gap, and the t95
information anchors raw_gap via its prior.

**Critical limitation (identified by external review)**: this does
NOT change the sampling geometry for the onset-mu ridge. The sampler
still operates in coordinates where onset and mu are independent
axes. `raw_gap` is just sigma under a monotonic transform — the
sampler's view of the (onset, mu) subspace is identical to the
current model.

Concretely: the sampler coordinates are `(eps_onset, mu, raw_gap)`.
Since `raw_gap → sigma` is monotonic, this is topologically
`(onset, mu, sigma)` — the same three-way ridge, with one axis
warped. The onset-mu correlation is untouched.

This proposal solves half the problem. For the full solution, see
Proposal B.

### 11.8 Proposal B: sample (m, a, r) — full reparameterisation

**Status**: Proposed. Reviewed. Reference implementation drafted.
**Date**: 13-Apr-26.
**Origin**: External review of Proposal A identified that sampling
`(onset, mu, raw_gap)` is topologically `(onset, mu, sigma)` and
leaves the onset-mu ridge untouched. This proposal replaces all three
sampling coordinates.

#### 11.8.1 The key insight

The data most directly constrains t50 (the median delay including
onset). The onset-mu ridge exists because the data pins t50 tightly
but is largely indifferent to how t50 decomposes into onset vs
exp(mu). A good parameterisation should make t50 a sampled coordinate
and relegate the onset/mu split to a separate axis.

Similarly, the onset-sigma ridge exists because the data constrains
the tail position (approximately t95) but is indifferent to how that
is decomposed. The tail stretch relative to the median gap should be
a separate axis.

#### 11.8.2 The (m, a, r) coordinates

Sample three unconstrained latents:

```
m ~ Normal(m_prior, m_sigma)     — log overall timescale
a ~ Normal(a_prior, a_sigma)     — logit onset fraction
r ~ Normal(r_prior, r_sigma)     — log tail stretch ratio
```

Derive the physical quantities:

```
t50   = exp(m)
onset = t50 × sigmoid(a)
mu    = m - softplus(a)             [exact algebraic identity]
sigma = softplus(r) / Z_95
t95   = onset + exp(mu + Z_95 × sigma)
```

The inverse (from current parameters to (m, a, r)):

```
m = log(onset + exp(mu))
a = logit(onset / (onset + exp(mu)))
r = log(expm1(Z_95 × sigma))       [= inverse_softplus(Z_95 × sigma)]
```

This is exact and invertible. The model is mathematically identical
to the current shifted lognormal — it is a coordinate transform of
the sampling space, nothing more.

**Algebraic verification of `mu = m - softplus(a)`**:

```
mu  = log(t50 - onset)
    = log(exp(m) - exp(m) × sigmoid(a))
    = log(exp(m) × (1 - sigmoid(a)))
    = m + log(sigmoid(-a))
    = m - softplus(a)               [since log(sigmoid(-x)) = -softplus(x)]
```

This identity is critical: it avoids computing `t50 - onset` and
taking its log (which would need a floor guard). The softplus path
is smooth everywhere and gradient-friendly.

#### 11.8.3 Why these coordinates are better

**m (log-timescale)**: the data most directly constrains t50, the
overall median delay. m = log(t50) is the well-identified direction.
The sampler can pin m tightly from the likelihood without needing to
resolve the onset/mu decomposition.

**a (onset fraction)**: the poorly-identified onset-mu tradeoff is
isolated into a single axis. The sampler can explore how much of t50
is "dead time" (onset) vs "active delay" (exp(mu)) by moving along
a, without disturbing the well-constrained m. The ridge becomes a
single coordinate rather than a correlation between two coordinates.

**r (tail stretch)**: the poorly-identified onset-sigma tradeoff is
similarly isolated. r = log((t95 - t50) / (t50 - onset)) measures
how stretched the tail is relative to the median gap. This is a ratio
— it is independent of the overall timescale m and the onset
fraction a.

**The critical difference from Proposal A**: in Proposal A, the
sampler operates in `(onset, mu, raw_gap)` which is topologically
`(onset, mu, sigma)`. In Proposal B, the sampler operates in
`(m, a, r)` which mixes onset and mu into the same coordinates. The
onset-mu ridge is structurally dissolved, not merely constrained by
priors.

#### 11.8.4 Prior derivation from available data

All priors are derived from the analytic stats pass values that are
always available when latency is active (§11.6):

```python
# Inputs: always available
onset_prior_days = max(lp.onset_delta_days, 0.0)
mu_prior         = ev.latency_prior.mu
sigma_prior      = ev.latency_prior.sigma

# Forward transform to (m, a, r)
t50_prior_days = onset_prior_days + math.exp(mu_prior)
m_prior        = math.log(t50_prior_days)

# onset fraction — handle onset=0 gracefully
if onset_prior_days < 1e-6:
    a_prior = -5.0   # sigmoid(-5) ≈ 0.007 → onset ≈ 0.7% of t50
else:
    a_prior = math.log(onset_prior_days
                       / (t50_prior_days - onset_prior_days))

# tail stretch — inverse_softplus(Z_95 * sigma_prior)
r_prior = math.log(math.expm1(Z_95 * sigma_prior))
```

**The onset=0 case**: when `onset_delta_days = 0`, the logit
transform gives `a = -∞`. We handle this by setting `a_prior = -5.0`
(i.e. `sigmoid(-5) ≈ 0.007`, so onset ≈ 0.7% of t50). This is a
regularised "essentially zero onset" prior. The sampler can still
push a more negative if the data supports truly zero onset, or pull
it toward zero if there is evidence for a non-trivial onset.

**Prior widths**:

```python
m_sigma = max(_mu_prior_sigma_floor, sigma_prior, 0.3)
a_sigma = 2.0
r_sigma = 0.5
```

- `m_sigma`: inherits the existing heuristic from the current model
  (`model.py:783`) which uses `sigma_prior` (the lognormal sigma) as
  a proxy for uncertainty on the log-location. This is not principled
  — it conflates the distribution's spread with our uncertainty about
  its location — but it is the status quo. The floor of 0.3 ensures
  the prior is not degenerate for edges with very small sigma. For
  edges with large sigma (≈ 1.5), m_sigma will be wide even if the
  analytic t50 estimate is precise; the regression should confirm
  this does not cause problems.
- `a_sigma = 2.0`: on the logit scale, ±2σ from `a_prior = -5.0`
  gives onset fraction in [0.01%, 27%] of t50. Wide enough for the
  data to push onset away from zero if warranted. For edges with
  onset observations (≥3 retrievals), the observations attached to
  the derived onset node will tighten the effective posterior on a
  regardless. For edges without onset observations, 2.0 may need
  widening to 2.5–3.0 — the regression will inform this.
- `r_sigma = 0.5`: allows sigma to vary by roughly ±50% from its
  analytic estimate at ±1σ. Conservative; can be widened if the
  posterior is prior-dominated.

**When t95_days is available**: it provides an independent data source
for r. Two design options:

1. **Use t95_days to set r_prior** (preferred when t95 is trusted):

   ```python
   if (et.t95_days is not None
           and float(et.t95_days) > t50_prior_days + 1e-6):
       t95_prior_days = float(et.t95_days)
       r_prior = math.log(
           max((t95_prior_days - t50_prior_days)
               / max(t50_prior_days - onset_prior_days, 0.25),
               1e-6))
   ```

   This replaces the sigma-derived r_prior with a t95-derived one.
   When both t95_days and sigma_prior are available, t95_days is
   preferred because it comes directly from the histogram tail rather
   than via the analytic fit.

2. **Retain t95 as an optional soft observation** on the derived
   t95 Deterministic node. This provides extra anchoring from the
   histogram without changing the sampling coordinates:

   ```python
   if et.t95_days is not None:
       pm.Normal(f"t95_obs_{safe_id}",
                 mu=t95_var, sigma=t95_sigma,
                 observed=np.float64(et.t95_days))
   ```

   This is separate from the coordinate definition and can be
   toggled independently.

The revised reference implementation (§11.8.10) uses option 1 for
the prior and does not include a t95 observation. Option 2 can be
added later if the regression shows the tail is under-constrained.

#### 11.8.5 Interaction with existing onset machinery

The current model has substantial onset infrastructure (§11.6):
non-centred `eps_onset` parameterisation, per-retrieval onset
observations, autocorrelation-corrected effective sample size
(`model.py:449-530`). Under Proposal B, onset is derived from
`(m, a)` rather than sampled directly.

**The onset observations can still be used.** The derived onset
`= exp(m) × sigmoid(a)` is a Deterministic node. Per-retrieval
onset observations can be attached to it as `pm.Normal` observations
exactly as today. The difference is that the gradient flows back
through m and a rather than through eps_onset.

**The non-centred onset parameterisation is replaced**, not adapted.
Currently `eps_onset ~ N(0,1)` feeds through `softplus(prior + eps ×
sigma)` to produce onset. Under Proposal B, onset is
`exp(m) × sigmoid(a)` — the sampling coordinates are m and a, not
eps_onset. The softplus non-centring trick is no longer needed because
m and a are unconstrained reals (no positivity constraint to enforce
on the sampling coordinates).

**onset_vars dict**: currently maps `edge_id → onset_var` (a PyMC
variable). Under Proposal B, onset_var is a `pm.Deterministic` node
derived from m and a. The dict interface is unchanged — downstream
code that reads `onset_vars[edge_id]` sees a tensor, doesn't care
how it was produced.

#### 11.8.6 Positivity and ordering constraints

All constraints are handled by the transform structure:

- **onset ≥ 0**: `onset = exp(m) × sigmoid(a)`. Both `exp(m)` and
  `sigmoid(a)` are positive, so onset is always positive.
- **t50 > onset**: `t50 - onset = exp(m) × sigmoid(-a)`, always
  positive.
- **sigma > 0**: `sigma = softplus(r) / Z_95`, always positive.
- **t95 > t50**: `t95 - t50 = exp(r) × (t50 - onset)`, always
  positive (exp(r) > 0 and t50 > onset as above).

No floor clamps, no gradient discontinuities, no ordering
constraints to enforce. The transform is clean.

#### 11.8.7 Files changed

| File | Change | Scope |
|------|--------|-------|
| `model.py` §3 | Replace `pm.Normal("mu_lat_...")` + `pm.Gamma("sigma_lat_...")` + `eps_onset` + `softplus` with `pm.Normal("m_lat_...")` + `pm.Normal("a_lat_...")` + `pm.Normal("r_lat_...")`. Derive onset, mu, sigma, t50, t95 as `pm.Deterministic` nodes. | ~50 lines replaced |
| `model.py` §3 | Prior arithmetic: compute `(m_prior, a_prior, r_prior)` from `(onset_prior, mu_prior, sigma_prior)`. Handle onset=0 case. Use t95_days for r_prior when available. | ~15 lines added |
| `model.py` §3 | Onset observations block: repoint to derived onset Deterministic. Unchanged in structure. | ~5 lines changed |
| `model.py` §3 | Remove t95 soft constraint block (`model.py:803-825`). t95 information enters through r_prior instead. | ~20 lines removed |
| `inference.py` | Extraction of mu/sigma/onset unchanged (Deterministic nodes in trace). Add extraction of m/a/r for diagnostics (correlation checks). | ~10 lines added |
| `worker.py` | No change — consumes mu_mean, sigma_mean, onset_mean, etc. | 0 |
| `types.py` | No change to `LatencyPosteriorSummary`. | 0 |
| FE code | No change. | 0 |

#### 11.8.8 What this does NOT address

- **Phase 2 frozen latency** — Phase 2 freezes `(mu, sigma, onset)`
  as constants (`model.py:760-770`). This path doesn't sample
  anything, so the reparameterisation is irrelevant. No change needed.
- **Phase C per-slice latency** — the `tau_mu_slice` / `tau_sigma_slice`
  cross-slice shrinkage parameters operate on (mu, sigma) space. They
  would need analogous treatment for full consistency, but can be
  deferred behind the feature flag.
- **Mixture (join-node) paths** — these compute a weighted CDF sum
  where t50/t95 are not simply the shifted lognormal quantiles.
  Deferred, matching the kappa_lat scope (§6.4).
- **Cohort-level (path) latency variables** (§4 in model.py) — these
  create path-level mu/sigma that deviate from edge-level sums. They
  would need the same reparameterisation for consistency. Can be
  deferred.

#### 11.8.9 Validation plan

1. Feature-flag the change (`latency_reparam`, default `false`).
2. Run `param_recovery.py` on the 4 simple-chain synth graphs
   (simple-abc, mirror-4step, drift10d10d, drift3d10d) with the flag
   on. Key diagnostics:
   - **corr(m, a)** vs current **corr(onset, mu)** — should be
     substantially lower.
   - **corr(m, r)** vs current **corr(onset, sigma)** — should be
     substantially lower.
   - **ESS** for all latency parameters — should improve.
   - **Parameter recovery** — onset, mu, sigma truth values should
     be recovered at least as well as current.
3. Check `sigma_sd` from the trace is not artificially deflated —
   the deterministic sigma inherits uncertainty from m, a, and r
   jointly.
4. Run the full 11-graph regression with both `latency_dispersion`
   and `latency_reparam` to check for interactions with kappa_lat.
5. If onset=0 edges show pathological behaviour (a drifting to -∞),
   tighten `a_sigma` or add a mild `pm.Potential` penalty.

#### 11.8.10 Reference implementation (reviewed)

The following block replaces the Phase 1 onset + latency sections
in `model.py` §3. It has been through two rounds of external review;
review notes are recorded in §11.8.11.

```python
# Proposal B: sample (m, a, r), derive onset/mu/sigma/t95.
#
#   m = log(t50)
#   a = logit(onset / t50)
#   r = inverse_softplus(Z_95 * sigma) = log(exp(Z_95 * sigma) - 1)
#
# Exact back-transform:
#   t50   = exp(m)
#   onset = t50 * invlogit(a)
#   mu    = m - softplus(a)                 # exact identity
#   sigma = softplus(r) / Z_95              # always > 0
#   t95   = onset + exp(mu + Z_95 * sigma)

if is_phase2:
    # unchanged
    frozen = phase2_frozen.get(edge_id, {})
    mu_frozen = frozen.get("mu", ev.latency_prior.mu)
    sigma_frozen = frozen.get("sigma", ev.latency_prior.sigma)
    mu_var = pt.as_tensor_variable(np.float64(mu_frozen))
    sigma_var = pt.as_tensor_variable(
        np.float64(max(sigma_frozen, _sigma_floor)))
    latency_vars[edge_id] = (mu_var, sigma_var)
    diagnostics.append(
        f"  latency: {edge_id[:8]}… mu={mu_frozen:.3f}, "
        f"sigma={sigma_frozen:.3f} → frozen (Phase 1)"
    )
else:
    # ── Inputs from current analytic prior machinery ──
    onset_prior_days = max(lp.onset_delta_days, 0.0)
    mu_prior = ev.latency_prior.mu
    sigma_prior = ev.latency_prior.sigma

    # ── Forward transform of current priors into (m, a, r) ──
    t50_prior_days = onset_prior_days + _math.exp(mu_prior)
    m_prior = _math.log(t50_prior_days)

    # Handle onset=0 without sending a_prior to -inf
    if onset_prior_days < 1e-6:
        a_prior = -5.0
    else:
        a_prior = _math.log(
            onset_prior_days
            / (t50_prior_days - onset_prior_days))

    # Prefer analytic t95 for r_prior when available;
    # otherwise derive from sigma_prior.
    if (et.t95_days is not None
            and float(et.t95_days) > t50_prior_days + 1e-6):
        t95_prior_days = float(et.t95_days)
        r_prior = _math.log(
            max((t95_prior_days - t50_prior_days)
                / max(t50_prior_days - onset_prior_days,
                      0.25),
                1e-6))
    else:
        # inverse_softplus(Z_95 * sigma_prior)
        r_prior = _math.log(_math.expm1(Z_95 * sigma_prior))

    # ── Prior widths ──
    # m_sigma: heuristic carry-over from current model
    # (uses lognormal sigma as proxy for log-location
    # uncertainty — not principled, but status quo).
    m_sigma = max(_mu_prior_sigma_floor, sigma_prior, 0.3)
    a_sigma = 2.0
    r_sigma = 0.5

    # ── Unconstrained sampling coordinates ──
    m_lat = pm.Normal(
        f"m_lat_{safe_id}", mu=m_prior, sigma=m_sigma)
    a_lat = pm.Normal(
        f"a_lat_{safe_id}", mu=a_prior, sigma=a_sigma)
    r_lat = pm.Normal(
        f"r_lat_{safe_id}", mu=r_prior, sigma=r_sigma)

    # ── Deterministic quantile / shape nodes ──
    t50_var = pm.Deterministic(
        f"t50_lat_{safe_id}", pt.exp(m_lat))
    onset_frac_var = pm.Deterministic(
        f"onset_frac_{safe_id}", pm.math.invlogit(a_lat))
    onset_var = pm.Deterministic(
        f"onset_{safe_id}", t50_var * onset_frac_var)
    mu_var = pm.Deterministic(
        f"mu_lat_{safe_id}",
        m_lat - pt.softplus(a_lat))
    sigma_var = pm.Deterministic(
        f"sigma_lat_{safe_id}",
        pt.softplus(r_lat) / Z_95)
    t95_var = pm.Deterministic(
        f"t95_lat_{safe_id}",
        onset_var + pt.exp(mu_var + Z_95 * sigma_var))

    onset_vars[edge_id] = onset_var
    latency_vars[edge_id] = (mu_var, sigma_var)

    diagnostics.append(
        f"  latency: {edge_id[:8]}… "
        f"m_prior={m_prior:.3f}, a_prior={a_prior:.3f}, "
        f"r_prior={r_prior:.3f} "
        f"(a_sigma={a_sigma:.1f}, r_sigma={r_sigma:.1f})"
        f" → latent")

    # The existing onset-observation block (onset_obs,
    # pm.Normal("onset_obs_...")) is kept unchanged,
    # repointed to onset_var.
    #
    # The old t95 soft-constraint block is removed.
    # t95 information enters through r_prior (or
    # optionally via a pm.Normal on t95_var — see §11.8.4).
```

#### 11.8.11 Review notes

**Round 1 review** (on initial draft):

1. **`mu = m - softplus(a)` instead of `log(t50 - onset)`**: the
   initial draft computed mu as `pt.log(pt.maximum(t50 - onset,
   floor))`. The algebraic identity `mu = m - softplus(a)` is exact,
   requires no floor constant, and has no gradient discontinuity.
   Adopted in revised draft.

2. **sigma floor clamp removed**: the initial draft included
   `pt.maximum(softplus(r) / Z_95, _sigma_floor)`. Since
   `softplus(r) > 0` for all r, the floor never activates. Removing
   it eliminates a gradient discontinuity and is consistent with
   §11.8.6's claim of "no floor clamps". Adopted.

3. **`a_sigma` widened from 1.0 to 2.0**: with a_sigma=1.0 and
   a_prior=-5.0 (onset=0 case), reaching onset = 10% of t50
   requires moving ~5σ from the prior — effectively impossible. The
   current model allows onset to wander ~2 days from zero via
   `softplus(0 + eps)`. With a_sigma=2.0, reaching that level of
   onset fraction is ~2σ from the prior — reachable. Adopted.

4. **`m_sigma` heuristic acknowledged**: the use of `sigma_prior`
   (lognormal sigma) as prior width on m is not principled — it
   conflates the distribution's spread with uncertainty about its
   location. Carried over from the current model as status quo.
   Labelled explicitly. For edges with large sigma (≈ 1.5), m_sigma
   may be too wide even if the analytic t50 is precise. The
   regression will test this.

5. **`onset_frac_var` Deterministic retained**: diagnostic-only
   (useful for prior-posterior contraction checks on a). Increases
   trace size slightly per edge. Can be dropped if trace size
   becomes a concern on larger graphs.

6. **`t95_var` Deterministic retained**: enables direct posterior
   predictive checks on the 95th percentile. Useful for diagnostics
   and for the optional t95 observation (§11.8.4 option 2).

**Round 2 review** (on revised draft):

7. **m_sigma still includes sigma_prior in the max**: acknowledged
   as heuristic. For high-dispersion edges (sigma ≈ 1.5), the prior
   on m is wide even when the analytic t50 is precise. Monitor in
   regression.

8. **t95_var chains through three Deterministic nodes**: PyTensor
   should optimise this. The direct form
   `exp(m) × (1 + sigmoid(-a) × exp(r))` avoids the intermediate
   graph but is less readable. Not worth doing unless compilation
   time regresses.

9. **a_sigma for edges with vs without onset observations**: the
   onset observations attached to onset_var will tighten a's
   posterior for edges with ≥3 retrievals. For edges without, 2.0
   is all you have. Consider widening to 2.5–3.0 for those edges
   if the regression shows a is prior-dominated.

**Open tuning questions** (for regression to resolve):

- `a_sigma`: 2.0 default, possibly 2.5–3.0 for edges without
  onset observations.
- `r_sigma`: 0.5 default, possibly wider if posterior is
  prior-dominated.
- `m_sigma`: heuristic carry-over — watch for over-widening on
  high-sigma edges.

### 11.9 Proposal A vs Proposal B: decision record

| Criterion | Proposal A (onset, mu, raw_gap) | Proposal B (m, a, r) |
|-----------|--------------------------------|----------------------|
| Onset-sigma ridge | Resolved | Resolved |
| Onset-mu ridge | **Not addressed** | Resolved |
| Implementation complexity | Low (~30 lines) | Moderate (~80 lines) |
| Onset observation compatibility | Unchanged | Requires repointing to derived onset |
| onset=0 handling | No issue | Needs `a_prior = -5.0` regularisation |
| Downstream changes | Zero | Zero (same Deterministic names) |
| Sampler geometry | One axis improved | All three axes improved |

**Recommendation**: Proposal B. The onset-mu ridge is the more severe
of the two ridges (§10.1 documents `corr(onset, mu) ≈ 0.97`). A
reparameterisation that only addresses onset-sigma (Proposal A) leaves
the harder problem untouched. Proposal B addresses both for moderate
additional implementation cost.

Proposal A is documented as a fallback if Proposal B encounters
unexpected difficulties (e.g. the onset observation block interacts
badly with the (m, a) derived onset).

### 11.10 General recommendation (updated)

1. **Proposal B (m, a, r) reparameterisation** (§11.8) — resolve both
   the onset-mu and onset-sigma ridges in one change. Uses only prior
   information we have today. Zero downstream changes.

2. **Option D** (graph-derived onset priors, §10.3) — can be layered
   on as a tighter prior on `a` for edges where graph topology
   constrains onset. Complementary, not competing.

3. **Ex-Gaussian** (§11.3) — research track if the shifted lognormal
   family proves fundamentally unsuitable despite reparameterisation.

### 11.7 Additional references

[orthog-gev]: https://arxiv.org/html/2602.16283
  "Orthogonal parametrisations of Extreme-Value distributions (2025).
  Shows analytical orthogonalisation is intractable for the full
  three-parameter threshold-location-scale case."

[beests]: https://pmc.ncbi.nlm.nih.gov/articles/PMC3857542/
  "Release the BEESTS: Bayesian Estimation of Ex-Gaussian
  STop-Signal Reaction Time Distributions (Matzke et al., 2013)."

[qpd-elicit]: https://pubsonline.informs.org/doi/10.1287/deca.2024.0219
  "Quantile-Parameterised Distributions for Expert Knowledge
  Elicitation (2024). Theoretical basis for sampling quantiles
  instead of distributional parameters."

[cox-reid-1987]: https://rss.onlinelibrary.wiley.com/doi/10.1111/j.2517-6161.1987.tb01422.x
  "Cox & Reid (1987). Parameter Orthogonality and Approximate
  Conditional Inference. Foundation for information-orthogonal
  reparameterisation."

[shifted-weibull]: https://link.springer.com/article/10.1007/s40009-023-01287-y
  "Shifted mixture models using Weibull, Lognormal, and Gamma
  distributions (2023). Estimable shift parameter approach."

---

## 12. Devtool improvements made during this work

Several regression infrastructure defects were discovered and fixed:

- **Synth data gate** (`test_harness.py`): added automatic bootstrap
  when snapshot DB has no data for a synth graph, preventing MCMC
  from running on empty evidence.
- **`--clean` flag**: consolidated `--clean-pyc` (bytecode cache) and
  synth-meta cache busting into one flag. Prevents stale Python
  bytecode or stale hash computations from producing wrong results.
- **Run ID binding**: `run_regression.py` generates a unique run ID
  and passes it as `--job-label` to prevent parallel regression runs
  from cross-contaminating log files.
- **Multi-layered audit**: `_audit_harness_log()` extracts per-graph
  status across all layers (completion, data binding, priors, feature
  flags, kappa_lat presence, inference results, convergence). The
  regression summary now shows `data=Xsnap/Yfb kl=Z mu=N` per graph
  and FAILs any graph with fallback binding or missing kappa_lat.
- **Audit tests**: `bayes/tests/test_regression_audit.py` — 20 blind
  tests against synthetic harness logs covering healthy, fallback,
  missing kappa_lat, missing priors, incomplete, and missing log
  scenarios.
- **`param_recovery.py` log reading**: reads both `graph-{name}` and
  `{name}` log file variants to handle the `--fe-payload` path's
  different graph_id naming.
- **Native BetaBinomial**: switched from manual gammaln log-pmf to
  `pm.BetaBinomial.dist()` + `pm.logp()` to fix PyTensor compilation
  timeouts on larger graphs (diamond, 3way-join).
