# Doc 34 — Latency Dispersion: Background, Design, and Implementation

**Date**: 10-Apr-26
**Status**: Design ready for implementation (feature-flagged)

---

## 1. What this document is for

This note captures the current model's parameterisation of "whether"
and "when" people convert, explains exactly where we have proper
predictive aleatoric dispersion estimates and where we don't, and
frames the problem that needs solving.

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

**Likelihood terms that constrain p and kappa jointly:**

- Window observations: `k ~ Binomial(n, p * completeness)` — anchors
  p but does not constrain kappa
- Daily cohort observations: `k ~ BetaBinomial(n, p*kappa,
  (1-p)*kappa)` — this is the primary data source for kappa. The
  BetaBinomial models day-to-day variation in the observed rate beyond
  Binomial noise
- Endpoint BetaBinomial: mature trajectory endpoints also use
  `BetaBinomial(n, p*kappa, (1-p)*kappa)` — provides additional
  kappa constraint from across-cohort rate variation

**What kappa represents:**

Kappa is an overdispersion parameter. It says: "even if the true
long-run rate is p, on any given day the realised rate is a draw from
Beta(p*kappa, (1-p)*kappa)". High kappa = tight around p (close to
Binomial). Low kappa = large day-to-day scatter.

**The predictive distribution for p:**

Because kappa is sampled as a random variable, the model produces a
proper **predictive** distribution for the rate:

```
For each MCMC draw i:
    p_pred_i ~ Beta(p_i * kappa_i, (1 - p_i) * kappa_i)
```

This predictive distribution is wider than the posterior on p itself.
The posterior says "how precisely do we know the mean rate?" The
predictive says "what rate will we observe tomorrow?" The difference
is kappa — it captures the aleatoric (irreducible) scatter in the
rate process.

The exported `alpha/beta` and HDI in `PosteriorSummary` reflect this
predictive spread (for window mode; the cohort export path has the
issues documented in doc 33 §4.3).

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

Together, `ShiftedLogNormal(onset, mu, sigma)` defines a CDF:

```
CDF(t) = 0.5 * erfc(-(log(t - onset) - mu) / (sigma * sqrt(2)))
```

This CDF predicts what fraction of eventual converters have converted
by time `t`. It is the "completeness curve" — the timing model.

**Likelihood terms that constrain onset, mu, sigma:**

- Trajectory product-of-conditional-Binomials: each interval's
  conditional hazard `q_j = p * delta_F_j / (1 - p * F_{j-1})` depends
  on the CDF shape. The shape of the maturation curve across retrieval
  ages constrains `(onset, mu, sigma)` jointly with `p`
  (`model.py:1888-2117`)

Note: kappa does NOT appear in the trajectory likelihood. The
trajectory uses plain Binomial intervals, not BetaBinomial. This is
intentional — BetaBinomial with small kappa has a systematic upward
bias on p (journal 26-Mar-26). So the timing model (trajectories)
and the rate-overdispersion model (daily/endpoint BB) constrain the
same underlying p but through different likelihood terms.

**What the model does NOT have for latency:**

There is no kappa-analogue for the timing process. The model assumes
all trajectories share exactly the same CDF shape `(onset, mu,
sigma)`. Every cohort, every time period, every observation — all are
assumed to follow one fixed shifted lognormal. Any variation across
cohorts in their maturation speed is absorbed into the posterior
uncertainty on the shared parameters, but this is **epistemic**
uncertainty (how well we know the single true shape), not **aleatoric**
uncertainty (how much the shape genuinely varies).

### 2.3 The asymmetry, stated precisely

| Aspect | p (whether) | Latency (when) |
|--------|------------|----------------|
| Point estimate | p posterior mean | (onset, mu, sigma) posterior means |
| Epistemic uncertainty | posterior SD on p (shrinks with data) | posterior SDs on onset/mu/sigma (shrink with data) |
| Aleatoric overdispersion | **kappa (learned RV)** — captures genuine day-to-day rate variation | **Nothing** — no equivalent parameter |
| Predictive distribution | Beta(p*kappa, (1-p)*kappa) — proper, includes irreducible scatter | LogNormal(mu, sigma) with posterior SDs — epistemic only, no observation-level scatter |
| What the fan chart uses | p_sd from predictive (correct) | mu_sd/sigma_sd/onset_sd from posterior (wrong kind of uncertainty) |

---

## 3. How dispersion estimates currently reach the fan chart

The fan chart (cohort maturity, confidence bands) generates Monte
Carlo draws of `(p, mu, sigma, onset)` from a multivariate normal
centred on the posterior means with a covariance matrix built from
the exported SDs:

```python
sds = [p_sd, mu_sd, sigma_sd, onset_sd]
cov = diag(sds^2)
cov[3,1] = cov[1,3] = onset_mu_corr * onset_sd * mu_sd
draws ~ MVN(means, cov)
```

(`confidence_bands.py:93-103`, `cohort_forecast.py:691-693`,
`cohort_forecast_v2.py:737-739`)

For p: `p_sd` comes from the predictive distribution (via kappa).
This is the right quantity — it includes aleatoric scatter.

For latency: `mu_sd`, `sigma_sd`, `onset_sd` come from one of two
sources, depending on model variable promotion:

1. **Bayesian posterior SDs** — `np.std(trace.posterior[var])` from
   `inference.py:882-884`. These are pure epistemic: with many
   trajectories they shrink toward zero (mu_sd ≈ 0.005, onset_sd ≈
   0.010), implying we can predict individual conversion timing to
   sub-day precision. We cannot.

2. **Analytic heuristic SDs** — `stats_engine.py:618-633`. Formulas
   like `mu_sd = 1.25 * sigma / sqrt(k)`, `onset_sd = 0.10 * onset`.
   These approximate frequentist standard errors. They are also
   epistemic but coarser (they don't shrink as fast). They are not
   calibrated and have known problems (onset_sd amplification at the
   CDF inflection point, programme.md §1512-1568).

Neither source captures aleatoric variation in the timing process.
Both answer "how precisely do we know the average timing shape?" not
"how much does timing genuinely vary across cohorts/periods?"

### 3.1 The practical consequence

With sufficient data, Bayesian posterior SDs shrink. The fan chart
narrows to near-zero width on the latency dimension. This is
statistically correct *if you are predicting the mean CDF shape* but
wrong *if you are predicting what an individual future cohort's
maturation will look like*. The latter is what the fan chart is
supposed to show.

The analytic heuristic SDs don't shrink as fast (they scale as
1/sqrt(k) not 1/sqrt(ESS)), so they produce wider bands. But they
are still epistemic and they produce bands that are poorly calibrated
(too wide at the CDF inflection point due to onset_sd amplification,
too narrow in the tails).

---

## 4. What Phase C slice parameters are and are not

Phase C introduces per-context-slice latency parameters
(`model.py:1129-1168`):

```python
tau_mu_slice = pm.HalfNormal(sigma=0.3)       # how much mu varies across slices
tau_sigma_slice = pm.HalfNormal(sigma=0.2)     # how much sigma varies across slices
tau_onset_slice = pm.HalfNormal(sigma=0.5)     # how much onset varies across slices

mu_slice_i = mu_base + eps_i * tau_mu_slice    # per-slice mu
sigma_slice_i = max(sigma_base + eps_i * tau_sigma_slice, 0.01)
onset_slice_i = max(onset_base + eps_i * tau_onset_slice, 0.0)
```

These are **cross-slice shrinkage** parameters — they model how much
the timing shape differs between context slices (e.g. "organic" vs
"paid" traffic). They are hierarchical priors across slices, NOT
dispersion parameters for the timing process itself.

`tau_mu_slice` says: "the organic slice might have mu = 2.1 while the
paid slice has mu = 1.8". It does NOT say: "within the organic slice,
individual cohorts' timing varies beyond what LogNormal(2.1, sigma)
predicts".

So Phase C does not solve the problem described here. The per-slice
latency parameters still share the same structural gap: within each
slice, there is no aleatoric dispersion model for timing.

---

## 5. The inference coupling between p and latency

The "whether" and "when" processes are not independently inferrable.
In the product-of-conditional-Binomials likelihood, the conditional
hazard at interval j is:

```
q_j = p * delta_F_j / (1 - p * F_{j-1})
```

Both `p` and the CDF `F` (which depends on onset, mu, sigma) appear
in the same expression. The same observed maturation curve constrains
both. Concretely:

- If few conversions have happened by day 14, that could mean low p
  (few people convert at all) or slow timing (high mu, conversions
  haven't happened yet). The trajectory data alone cannot fully
  separate these.

- The daily BetaBinomial observations help break this degeneracy by
  anchoring p independently. But the coupling remains: immature
  cohorts where the CDF hasn't plateaued carry joint uncertainty
  between p and timing.

This coupling means:

1. **Any latency dispersion model will interact with p inference.**
   If per-cohort timing varies, the model must not attribute that
   variation to p. The existing onset-mu correlation
   (onset_mu_corr ≈ -0.3 to -0.7 in posterior samples) is already
   an expression of this coupling.

2. **Over-parameterisation risk is real.** Adding per-cohort latency
   dispersion without sufficient data per cohort could create
   unidentifiable ridges in the posterior. The sampler would see
   equivalent likelihood surfaces where high-p + slow-timing and
   low-p + fast-timing both explain the same trajectory.

3. **The coupling is strongest for immature cohorts** (where the CDF
   hasn't plateaued) and weakest for mature cohorts (where the CDF
   is near 1 and p is well-determined from the endpoint).

---

## 6. What a latency dispersion model would need to do

The goal is a predictive distribution for **when** a future cohort's
conversions will arrive, not just the mean timing shape. By analogy
with kappa for p:

- **kappa for p**: "tomorrow's observed rate is a draw from
  Beta(p*kappa, (1-p)*kappa)" — the predictive is wider than the
  posterior because kappa captures genuine day-to-day scatter.

- **The latency analogue**: "tomorrow's cohort will mature according
  to a CDF whose parameters (onset, mu, sigma) are drawn from a
  distribution centred on the posterior means, with learned spread
  that captures genuine cohort-to-cohort variation in timing."

The spread parameters would be the latency equivalents of kappa. They
would answer: "how much does the maturation speed genuinely vary
across cohorts, beyond what the fixed LogNormal shape predicts?"

Key constraints on any design:

1. **Must respect the p-latency coupling.** Cannot introduce
   per-cohort latency variation that is confounded with p variation.
   kappa already handles p variation; the latency dispersion must
   capture the residual timing variation conditional on p.

2. **Must be identifiable from trajectory data.** The
   product-of-conditional-Binomials decomposes each trajectory into
   intervals. Per-cohort latency dispersion is identifiable when
   multiple cohorts are observed at multiple ages — i.e. when the
   trajectories have different shapes, not just different levels.

3. **Must not over-parameterise.** The current model has 4–5 learned
   parameters per edge (p, kappa, mu, sigma, optionally onset). Adding
   3 dispersion parameters (tau_mu, tau_sigma, tau_onset) nearly
   doubles the parameter count. This needs enough trajectory data
   per edge to constrain.

4. **Must produce a predictive distribution that can feed the fan
   chart.** The fan chart's MC draw machinery
   (`confidence_bands.py`, `cohort_forecast.py`) already samples
   `(p, mu, sigma, onset)` from a covariance matrix. The latency
   dispersion parameters would replace the current SDs with learned
   predictive SDs rather than epistemic posterior SDs.

---

## 7. Current state of related work

| Item | Status | Relevance |
|------|--------|-----------|
| kappa as learned RV for p | Implemented | Gold standard — the pattern to emulate |
| Posterior SDs for mu/sigma/onset | Implemented | Epistemic only — wrong kind of uncertainty |
| Analytic heuristic SDs | Implemented but uncalibrated | Band-aid, also epistemic |
| Phase C cross-slice latency taus | Implemented | Cross-slice variation, NOT within-slice dispersion |
| Doc 33 dispersion forensic review | Open | Identifies defects in existing dispersion export |
| programme.md §1570-1583 | Documented | States the problem: "Bayesian latency SDs overstate predictive certainty" |
| Fan chart MC draw machinery | Implemented | Consumer — would use predictive SDs if they existed |

---

## 8. Design: per-cohort mu random effect

### 8.1 The parameterisation

Keep all existing shared edge parameters unchanged: `p`, `kappa`,
`onset`, `mu`, `sigma`. Add a per-cohort random effect on mu only:

```
u_c ~ Normal(0, 1)                     # per-cohort latent, non-centred
tau_mu ~ HalfNormal(s_tau)             # learned timing dispersion
mu_c = mu + tau_mu * u_c               # per-cohort log-time shift
F_c(t) = ShiftedLogNormalCDF(t; onset, mu_c, sigma)
```

The interval hazard becomes per-cohort:

```
q_{c,j} = p * (F_c(t_j) - F_c(t_{j-1})) / (1 - p * F_c(t_{j-1}))
```

For prediction, a future cohort draws:

```
u_new ~ Normal(0, 1)
mu_new = mu + tau_mu * u_new
```

`tau_mu` is the timing analogue of kappa: it captures how much the
maturation speed genuinely varies across cohorts, beyond what the
shared LogNormal(mu, sigma) predicts. It is a proper aleatoric
dispersion parameter, not an epistemic posterior SD.

### 8.2 Why this parameterisation

**Why mu only (not sigma, not onset):**

- mu controls the left/right shift of the CDF — it is the most
  identifiable parameter from trajectory data. Different cohorts
  maturing at different speeds manifests directly as horizontally
  shifted maturation curves.
- sigma (shape) is a structural property of the edge — how spread
  out individual conversion times are. This should not vary
  cohort-to-cohort. Adding per-cohort sigma would create a mu-sigma
  ridge per cohort.
- onset (hard left bound) is structurally correlated with mu
  (onset-mu posterior correlation is typically -0.3 to -0.7). Adding
  per-cohort onset on top of per-cohort mu would create
  identification problems.

**Why non-centred:**

Non-centred parameterisation (`mu + tau * eps` rather than
`mu_c ~ Normal(mu, tau)`) avoids the "funnel" geometry that NUTS
struggles with when tau is small. This is the same pattern used
throughout the model (see model.py glossary: "Non-centred
parameterisation") and in Phase C slice latency
(`model.py:1161-1164`).

**Why HalfNormal for tau_mu:**

HalfNormal concentrates mass near zero, acting as a regularising
prior that prefers small cohort-to-cohort variation. If the data
doesn't support timing overdispersion, tau_mu will be pulled toward
zero and the model degenerates to the current shared-mu
parameterisation. This is the same prior family used for Phase C
slice taus (`model.py:1136-1138`).

### 8.3 Interaction with existing parameters

**p and kappa:** kappa handles rate overdispersion (day-to-day
scatter in observed p). The per-cohort mu handles timing
overdispersion (cohort-to-cohort scatter in maturation speed). These
are conceptually independent — one is about whether people convert,
the other about when. The daily BetaBinomial observations anchor p
independently of the trajectory shape, which helps prevent the
mu random effect from absorbing rate variation.

**Trajectories use Binomial, not BetaBinomial.** The trajectory
likelihood (`model.py:1931`) explicitly avoids kappa. This is
deliberate (BetaBinomial with small kappa biases p upward). The
per-cohort mu random effect adds the right kind of variation to
trajectories — timing variation, not rate variation.

**onset-mu correlation:** The existing onset-mu correlation in the
posterior reflects structural coupling. The per-cohort mu random
effect operates on top of this — it shifts mu_c relative to the
shared mu, with onset fixed. This is correct: cohort-to-cohort
timing variation is primarily a location shift, not an onset shift.

### 8.4 Future upgrade path

If residual structure demands it after the 1D version is validated:

Upgrade to correlated 2D random effects on (onset, mu):

```
z_c ~ Normal(0, I_2)
(onset_c, mu_c) = (onset, mu) + L * z_c
```

where L is the Cholesky factor of a 2×2 covariance with scales
`tau_onset`, `tau_mu` and correlation `rho_onset_mu`.

Do NOT add per-cohort sigma_c — it is the easiest to make weakly
identified and the least likely to be empirically meaningful.

---

## 9. Implementation plan

### 9.1 Feature flag

Flag name: `latency_dispersion` (default: `false`).

Mechanism: `features.get("latency_dispersion", False)` in
`build_model()`, following the existing pattern for `overdispersion`,
`latent_onset`, etc. (`model.py:353-357`).

Regression run: `--feature latency_dispersion=true` via the existing
`test_harness.py` `--feature` CLI (`test_harness.py:384-437`).

### 9.2 Model construction — `model.py`

**Where:** `_emit_cohort_likelihoods()` (`model.py:1529`), inside
the single-path latent-latency block (`model.py:2048-2117`).

**What changes:**

1. **Create the random effect** (before the interval decomposition
   loop, after `trajs` is finalised):

   ```python
   if feat_latency_dispersion and has_latent_latency and not is_mixture:
       n_trajs = len(trajs)
       tau_mu_var = pm.HalfNormal(f"tau_mu_{safe_id}", sigma=0.2)
       eps_mu_vec = pm.Normal(
           f"eps_mu_cohort_{safe_id}", mu=0, sigma=1, shape=n_trajs)
       mu_per_cohort = mu_var + tau_mu_var * eps_mu_vec
   ```

2. **Replace the shared CDF with per-cohort CDFs.** Currently:

   ```python
   cdf_all = _compute_cdf_at_ages(onset, mu_var, sigma_var)
   cdf_curr = cdf_all[curr_idx_np]
   ```

   With per-cohort mu, we need the CDF evaluated at each interval's
   age using that interval's cohort's mu. The `traj_idx_per_interval`
   array (`model.py:2074`) already maps each interval to its
   trajectory index. So:

   ```python
   mu_per_interval = mu_per_cohort[traj_idx_np]  # shape (n_intervals,)
   ```

   Then evaluate the CDF inline with per-interval mu:

   ```python
   z = (log_ages_per_interval - mu_per_interval) / (sigma_var * sqrt(2))
   cdf_per_interval = 0.5 * erfc(-z)
   ```

   This replaces the current gather from `cdf_all[curr_idx_np]`.
   The onset handling (softplus for latent, subtraction for fixed)
   remains the same — it doesn't vary per cohort.

3. **The hazard formula is unchanged** — `q_j`, `delta_F`,
   `surv_prev`, `logp` all work the same way, they just use
   per-interval CDF values instead of shared CDF values.

4. **When the flag is off**, the code path is exactly as today.
   No performance or correctness impact on the default path.

**Mixture path:** Defer per-cohort mu for mixture (join-node) edges.
The mixture path (`model.py:1976-2046`) computes a weighted sum of
per-alternative CDFs. Adding per-cohort mu to each alternative is
more complex and can wait until the single-path version is validated.

**Phase C interaction:** When `has_slices` is true, each slice
already gets its own `mu_slice`. The per-cohort random effect would
apply within each slice: `mu_slice_c = mu_slice + tau_mu * eps_c`.
For the first implementation, only apply the random effect to the
aggregate (non-slice) emission path. Per-slice cohort dispersion
is a later extension.

### 9.3 Posterior extraction — `inference.py`

**Where:** `summarise_posteriors()`, latency posterior block
(`inference.py:870-964`).

**What to extract:**

```python
tau_mu_name = f"tau_mu_{safe_eid}"
if tau_mu_name in trace.posterior:
    tau_mu_samples = trace.posterior[tau_mu_name].values.flatten()
    tau_mu_mean = float(np.mean(tau_mu_samples))
    tau_mu_sd = float(np.std(tau_mu_samples))
```

**Predictive mu_sd:**

The predictive SD for mu combines epistemic uncertainty (posterior
SD on mu) with aleatoric dispersion (tau_mu):

```python
# For each MCMC draw, the predictive mu for a new cohort is:
#   mu_pred = mu_draw + tau_mu_draw * N(0,1)
# The variance is: Var(mu_draw) + E[tau_mu_draw^2]
# = posterior_var(mu) + E[tau_mu^2]
predictive_mu_var = mu_sd**2 + float(np.mean(tau_mu_samples**2))
predictive_mu_sd = float(np.sqrt(predictive_mu_var))
```

This `predictive_mu_sd` replaces the current `mu_sd` (which is
pure posterior SD) in the `LatencyPosteriorSummary`.

**New fields on `LatencyPosteriorSummary`** (`types.py`):

```python
tau_mu_mean: float | None = None    # learned timing dispersion
tau_mu_sd: float | None = None      # posterior SD on tau_mu
```

The existing `mu_sd` field is repurposed to carry the predictive SD
(epistemic + aleatoric) when tau_mu is available, and the pure
posterior SD when it is not (flag off). This means the fan chart
consumer code does not change — it already reads `mu_sd`.

### 9.4 Worker — `worker.py`

**Where:** `_build_unified_slices()`.

**What changes:** Thread `tau_mu_mean` and `tau_mu_sd` through to
the posterior output dict, following the existing pattern for
`onset_mean`, `onset_sd`, etc.

### 9.5 Fan chart consumption — no changes needed

The fan chart (`confidence_bands.py`, `cohort_forecast.py`,
`cohort_forecast_v2.py`) already samples `mu ~ N(mu_mean, mu_sd)`.
Because `mu_sd` is repurposed to carry the predictive SD, the fan
chart automatically gets wider bands when tau_mu > 0. No structural
change to the consumer code.

### 9.6 Regression validation

**Regression run comparison:**

Run the regression suite twice on the same synth graphs:

```bash
# Baseline (current model)
python bayes/run_regression.py

# With latency dispersion
python bayes/run_regression.py  # (after adding --feature support)
```

Via test_harness.py directly for a single graph:

```bash
python bayes/test_harness.py --graph synth-simple-abc \
    --feature latency_dispersion=true
```

**What to check:**

1. **tau_mu recovery**: Does the model recover the true tau_mu from
   synth data generated with known cohort-to-cohort timing variation?
   (Requires synth gen to support per-cohort mu variation — §9.7.)

2. **Null recovery**: On synth data with NO timing variation
   (tau_mu_true = 0), does tau_mu posterior concentrate near zero?
   Does enabling the flag degrade p, mu, sigma, onset recovery?

3. **Compute cost**: Wall time delta, ESS, Rhat for the new
   parameters.

4. **Convergence**: Does adding per-cohort mu worsen the onset-mu
   ridge (Rhat > 1.05, ESS < 200)?

### 9.7 Synth gen extension — `synth_gen.py`

Add optional per-cohort mu variation to the synthetic data generator:

- New truth file field: `tau_mu` per edge (default 0.0)
- When `tau_mu > 0`, each simulated cohort draws
  `mu_c = mu + tau_mu * N(0,1)` and uses `F_c` for that cohort's
  conversion timing
- This lets the regression suite test both tau_mu recovery and null
  behaviour

### 9.8 Files to change

| File | Change |
|------|--------|
| `bayes/compiler/model.py` | Feature flag, per-cohort mu random effect in `_emit_cohort_likelihoods` |
| `bayes/compiler/inference.py` | Extract tau_mu posterior, compute predictive mu_sd |
| `bayes/compiler/types.py` | Add `tau_mu_mean`, `tau_mu_sd` to `LatencyPosteriorSummary` |
| `bayes/worker.py` | Thread tau_mu fields through `_build_unified_slices` |
| `bayes/synth_gen.py` | Per-cohort mu variation in synth data generation |
| `bayes/tests/test_param_recovery.py` | tau_mu recovery assertions |

### 9.9 Implementation order

1. Add feature flag and tau_mu/eps_mu_cohort creation in `model.py`
   (flag off = no change)
2. Replace shared CDF with per-cohort CDF when flag is on
3. Extract tau_mu posterior in `inference.py`, compute predictive
   mu_sd
4. Add fields to `LatencyPosteriorSummary` in `types.py`
5. Thread through `worker.py`
6. Add synth gen per-cohort mu variation
7. Run regression: null recovery (tau_mu_true = 0, flag on)
8. Run regression: tau_mu recovery (tau_mu_true > 0, flag on)
9. Compare wall time and convergence diagnostics
