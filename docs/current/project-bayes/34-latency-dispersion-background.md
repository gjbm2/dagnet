# Doc 34 — Latency Dispersion: Background, Design, and Implementation

**Date**: 10-Apr-26
**Updated**: 11-Apr-26
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

## 10. Devtool improvements made during this work

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
