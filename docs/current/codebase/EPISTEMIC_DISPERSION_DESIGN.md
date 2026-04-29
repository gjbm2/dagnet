# Epistemic and predictive dispersion design — analytic stats pass

**Status**: Persistent design — design of record for the dispersion fields (`mu_sd`, `sigma_sd`, `onset_sd`, `alpha_pred`, `beta_pred`) emitted by the FE topo stats pass.
**Adopted**: 28-Apr-26
**Supersedes**: [`project-bayes/archive/heuristic-dispersion-design.md`](../project-bayes/archive/heuristic-dispersion-design.md) (the `1.25 × σ / √N` heuristic and its compounded corrections); also closes the §3.9 analytic dispersion discipline deferral recorded in [`model_resolver.py`](../../../graph-editor/lib/runner/model_resolver.py) ("no `alpha_pred` / `beta_pred` from analytic until an overdispersion model lands").
**Originating investigations**: [`project-bayes/73f`](../project-bayes/73f-outside-in-cohort-engine-investigation.md), [`project-bayes/73g`](../project-bayes/73g-general-purpose-f14-problem-and-invariants.md).
**Scope**: defines the formulas used by `statisticalEnhancementService.ts` for both the epistemic SDs on the lognormal latency parameters (`mu_sd`, `sigma_sd`, `onset_sd`) and the predictive (over-dispersion-aware) Beta concentration on the rate (`alpha_pred`, `beta_pred`); also defines the parameter-reading discipline in `forecast_runtime.py` that consumes them.

---

## 1. Purpose

Specify a research-grounded, general-purpose method for reporting parameter dispersion on the analytic stats pass output. Two parameter families need attention.

The **latency parameters** (μ, σ, onset) need an epistemic SD reflecting how uncertain the fitted point estimate is. The natural inference framework is the Gaussian/lognormal location–scale model on `ln(t)`; the dispersion is the standard error of the MLE under a Jeffreys prior. §3–§5 below cover the latency case.

The **rate parameter** (p) needs a *predictive* concentration — wider than the epistemic posterior, reflecting observation-level over-dispersion across cohorts. Without predictive width on the rate, the runner's importance-sampling step has no per-particle variation to discriminate against, and conditioning on cohort evidence silently becomes a no-op (the chart returns the model_vars value regardless of what the query DSL selected). §6 below covers the rate case.

The methods must work without arbitrary tuning across the full plausible sample-size range — from a handful of converters in a thin window to millions of converters in a saturated edge — and must rest on standard statistical theory rather than invented multipliers.

This document supersedes the design captured in [`project-bayes/archive/heuristic-dispersion-design.md`](../project-bayes/archive/heuristic-dispersion-design.md). That design used the asymptotic variance of the sample-median estimator (`1.25 × σ / √N`) as a stand-in for the standard error of the maximum-likelihood estimator. That substitution has no principled basis, and the intervening qualityInflation, drift-fraction, and fixed-floor corrections compounded the error rather than fixing it.

---

## 2. Problem

The analytic stats pass produces point estimates of the lognormal location and scale parameters from observed event-arrival times in a cohort window. Downstream consumers — the cohort-maturity fan chart, the conditioned-forecast subject-span object, confidence bands on the model curve — need a usable measure of how uncertain those point estimates are, expressed as a parameter standard deviation that the runner can propagate through its sweep.

Two facts frame the requirement.

First, the stats pass is the analytic surrogate for a Bayesian fit; its outputs feed the same downstream machinery the Bayes pipeline does. Per project specification, the analytic path emits **epistemic** dispersion only — it has no basis on which to construct a predictive (kappa-inflated) dispersion, because there is no kappa parameter being estimated. Predictive inflation is the runner's responsibility when the consumer needs a predictive band, not the stats pass's.

Second, the bucket size is unknown at design time. The same code path can be invoked on N = 2 converters (a brand-new edge with two observations) or N = 2,000,000 (a long-running edge in a steady-state product). The method we choose must degrade gracefully across that range without arbitrary cutoffs and without different code paths for different regimes.

The current implementation fails both of these tests. The location standard error is computed from the asymptotic variance of the sample median rather than the maximum-likelihood estimate, inflating it by a factor of √(π/2) ≈ 1.25 for no statistical reason. A separate qualityInflation factor doubles the result whenever a fit-quality gate flags the data, and a fixed floor of 0.02 prevents the value from collapsing to zero in saturated cases. None of these compounded corrections has a textbook foundation. There is also a layer violation in the runner: when the analytic stats pass omits a predictive standard deviation field (correctly, since it has no basis to compute one), the runner reads the bare epistemic value from the next-best field and treats it as if it were predictive, silently bypassing any predictive-inflation step the runner would otherwise apply.

---

## 3. Principled answer

Take logs. The model assumption is that ln(t) is normally distributed with parameters μ and σ. This is the textbook Gaussian inference problem, and the canonical answer is over a century old.

Under the standard reference (Jeffreys) prior on the location–scale Gaussian, π(μ, σ) ∝ 1/σ, the marginal posterior of the location parameter is exactly a Student-t distribution centred at the sample mean of ln(t), with scale s/√N and N−1 degrees of freedom. The marginal posterior of the variance parameter is a scaled inverse chi-squared distribution with N−1 degrees of freedom and scale s². These coincide numerically with the classical confidence intervals derived from the sampling distributions of the maximum-likelihood estimators after the unbiased-variance correction. They are exact for every N ≥ 2; they do not require asymptotic justification; they degenerate gracefully (heavy tails for small N, Gaussian asymptote for large N); and they form the foundation of the standard treatment in every reputable statistics textbook (Casella & Berger, *Statistical Inference*, 2nd ed., 2002, §5.3; Gelman et al., *Bayesian Data Analysis*, 3rd ed., 2013, §3.2; Bickel & Doksum, *Mathematical Statistics*, Vol. 1, 2nd ed., §4.4).

Concretely, the posterior on μ has scale parameter s/√N, where s is the sample standard deviation of ln(t). For large N this scale equals the standard deviation of the t-posterior because the t-distribution converges to a Gaussian. For small N the scale is unchanged but the tails of the posterior are heavier than Gaussian — in fact, the posterior variance of μ is finite only for N ≥ 4 (degrees of freedom > 2), and the posterior variance of σ is finite only for N ≥ 6. This is not a defect of the method; it is a true statement about how much information two or three data points carry about the underlying distribution. Any method that conjures a finite parameter variance from N = 2 is doing so by importing assumptions that are not supported by the data.

The current heuristic's `1.25 × σ / √N` traces back to the asymptotic variance of a different estimator entirely — the sample median, whose asymptotic variance is (π/2) σ²/N. The correct asymptotic variance of the maximum-likelihood location estimator is σ²/N. The 1.25 factor is the constant cost of using a less-efficient estimator; including it in the dispersion of a more-efficient estimator double-counts and is incorrect.

---

## 4. Single-scalar effective SD

Downstream consumers of the analytic stats output want a single scalar parameter standard deviation, not a posterior distribution. The runner propagates parameter uncertainty by sampling μ and σ from independent Gaussians during its sweep, so the consumer interface assumes a Gaussian shape.

The principled way to project a t-distribution onto a Gaussian-shaped scalar is the **interval-matched normal approximation** (Morgan & Henrion, *Uncertainty*, CUP 1990, §8.4). Pick a stated quantile range — the conventional choice is the central 90% interval — compute the corresponding quantiles of the t-posterior, and report the standard deviation of the Gaussian that has the same 90% interval. For a Gaussian, the 90% interval spans 2 × 1.645 standard deviations, so the effective SD is the half-range divided by 1.645.

This construction has three properties that recommend it. It is finite for every N ≥ 2, including the small-N regime where the t-posterior has no true variance. It converges exactly to s/√N in the large-N limit. And it has an explicit, documentable interpretation that does not pretend to be a true posterior moment when it is not: the value reported is the standard deviation of the Gaussian that matches the t-posterior's 90% interval, no more and no less. The same construction applies to σ via the scaled inverse chi-squared posterior.

The alternative — using the t-posterior variance where it is finite (N ≥ 4) and falling back to interval matching below that — is also defensible, and it is what the existing heuristic effectively gestures at with its qualityInflation factor. But it introduces a discontinuity at N = 4 where the reported value jumps as the formula changes. The pure interval-matched construction avoids the discontinuity at zero cost.

---

## 5. Edge cases

For N = 1 the sample standard deviation is undefined and no fit can be reported. The stats pass should refuse to emit μ_sd and σ_sd in this case rather than fabricate a value. Downstream consumers must already handle the case where dispersion is unavailable, since this is also the case for edges that have never received any observations.

For N = 2 the sample standard deviation is defined but the t-posterior has 1 degree of freedom and is Cauchy-distributed in shape. The interval-matched effective SD is well defined and finite, but the underlying posterior has Cauchy-heavy tails. A consumer that propagates the effective SD through a Gaussian sweep will under-state the tail mass of the resulting parameter distribution. This is a true statement about what two data points can support, and the right response is to document it rather than hide it. The design therefore retains the interval-matched effective SD for N = 2 and notes the heavy-tail caveat in the field documentation.

For N = 3 the t-posterior has 2 degrees of freedom, the mean is defined, and the variance is not. The interval-matched effective SD is again finite and well behaved; the same caveat applies in milder form.

There is no domain-specific small-N threshold and no need for one. The interval-matched formula is well defined for every N ≥ 2 and degrades smoothly as N falls — wider intervals at low N, tighter at high N, exactly as the information content of the data dictates. A separate `empirical_quality_ok` gate already exists in the stats pass and decides whether the fit as a whole should be marked trustworthy; that gate is independent of dispersion estimation and is not modified by this design. Dispersion is reported wherever μ and σ are reported; consumers that wish to gate on overall fit quality can do so via the existing flag.

There is also no need for a fixed lower floor on the reported dispersion. The interval-matched effective SD is naturally bounded away from zero at every finite N, because the sample standard deviation s and the relevant t-quantiles are both positive. A floor was needed under the prior heuristic only because the qualityInflation and √(π/2) factors had no principled relationship to N and could in degenerate cases produce values smaller than the noise floor of the downstream forecaster. With the principled formula those degenerate cases do not arise.

---

## 6. Predictive rate dispersion via quasi-likelihood overdispersion

The §3–§5 design produces principled epistemic dispersion for the latency parameters. The rate parameter `p` requires a different treatment because the runner's importance-sampling step needs a *predictive* concentration on `p` — wider than the epistemic Beta — for the IS proposal to have meaningful per-particle variation. Without predictive width on the rate, the conditioning step at [`forecast_state.py:1093`](../../../graph-editor/lib/runner/forecast_state.py#L1093) silently becomes a no-op for the analytic source.

### Why the rate side needs separate treatment

The runner draws per-particle `(p, μ, σ, onset)` from a proposal parameterised by `(α_pred, β_pred, mu_sd_pred, sigma_sd_pred, onset_sd_pred)` and reweights the particles against per-cohort observations. For the IS step to discriminate particles meaningfully, the proposal width must be wider than the posterior — the proposal needs to span the region the data could plausibly favour, otherwise the reweighting collapses near the proposal mean.

The latency-side principled epistemic SDs from §3 happen to land at widths comparable to a Bayesian fit's kappa-inflated predictive on typical fixtures in this project, so for latency the layer violation is not currently load-bearing. The rate side is different: method-of-moments on the analytic Beta produces `α + β` in the tens of thousands when the cohort window has aggregated millions of observations. Concentration that high produces a near-delta proposal on `p`, with no per-particle variation for IS to reweight against. Bayesian fits emit a separately-fitted `α_pred + β_pred` typically in the tens to hundreds — wide enough for IS to be effective.

The asymmetry between epistemic and predictive on the rate side is therefore the load-bearing element. Without it, "conditioning on cohort evidence" silently becomes "ignore the cohort evidence, return the analytic model_vars".

### Method: Beta-Binomial method-of-moments overdispersion

The standard textbook approach is the Williams (1975) / Crowder (1978) method-of-moments estimator for the Beta-Binomial concentration, on the quasi-likelihood foundation of Wedderburn (1974). McCullagh & Nelder, *Generalized Linear Models*, 2nd ed., 1989, §4.5 and §9.2.4 give the canonical treatment for binary cohort data; the Williams form is the version that handles unequal `n_i`, which is the regime that applies here.

The generative model is

```
p_i ~ Beta(α, β)             [latent rate per cohort, κ = α + β]
k_i | p_i, n_i ~ Binomial(n_i, p_i)
```

Per-cohort the squared standardised residual contributes

```
(k_i − n_i ŝ)² / (n_i · ŝ(1 − ŝ))   with expectation   1 + (n_i − 1) / (κ + 1)
```

Summed across N cohorts with `S = Σ n_i`, `K = Σ k_i`, `ŝ = K/S`:

```
X² = Σ_i (k_i − n_iŝ)² / (n_i ŝ(1 − ŝ))      [Pearson statistic]
E[X²] = N + (S − N) / (κ + 1)
```

Solving the moment equation for `κ` gives the estimator:

```
κ_pred = (S − N) / (X² − (N − 1)) − 1
α_pred = κ_pred · ŝ
β_pred = κ_pred · (1 − ŝ)
```

Equivalent and slightly more numerically stable form using `φ̂ = X² / (N − 1)` as the Pearson dispersion factor:

```
κ_pred = (S − N) / ((N − 1) · (φ̂ − 1)) − 1
```

Why this is the right concentration to emit. The IS conditioning step needs the **per-cohort predictive width** — how variable a *new cohort observation* would be — so the proposal can span the regions the data could plausibly favour. The aggregate-rate concentration `S/φ̂ − 1` describes how tight the *aggregate* rate posterior is (variance `φ̂ · ŝ(1−ŝ) / S`); on a long window of millions of trials it produces a near-delta proposal that collapses IS reweighting. The per-cohort concentration `(S − N) / (X² − (N − 1)) − 1` recovers the typical Bayesian fit's `α_pred + β_pred` (tens to hundreds for this project's fixtures), giving IS meaningful per-particle variation and matching what a hierarchical Beta-Binomial fit would produce by MCMC.

The properties that recommend this construction:

- The estimator derives from the data — different fixtures with different actual over-dispersion get different `κ_pred`, with no constant pulled out of the air.
- It reduces to the pure-Binomial limit (`κ_pred → ∞`, capped at the pure-Binomial concentration `S − 1`) when no over-dispersion is present, which is the right limit for ideally-modelled data.
- Single linear pass, O(N) time, O(1) memory, no MC, no iteration. Computationally negligible alongside the existing analytic stats pass aggregation.
- It is the moment-of-moments equivalent of what the Bayesian pipeline computes via MCMC for the per-cohort concentration `κ` — same statistical content, single-pass machinery suitable for FE, comparable order of magnitude to the Bayesian fit on the same evidence.

### Edge cases for the rate-side formula

| Case | Fallback | Rationale |
|---|---|---|
| **N = 1** | `κ_pred = S − 1` (pure Binomial) | A single cohort cannot estimate over-dispersion. Pure Binomial is the only defensible answer. |
| **N = 2** | Use the formula with the floor; estimator is noisy but defined. | Chi-squared has 1 df. Some authors (Breslow 1984) suggest shrinking toward 1 for very small N; the `max(1, ·)` floor on `κ_pred` is sufficient in practice. |
| **`ŝ` near 0 or 1** (denominator unstable) | Substitute Jeffreys-smoothed `ŝ_J = (K + ½)/(S + 1)` in the X² denominator only. | Agresti & Coull (1998) — preserves estimator consistency, prevents division blow-up. |
| **No detected over-dispersion** (`X² ≤ N − 1`) | `κ_pred = S − 1` (pure Binomial). | When the Pearson statistic doesn't exceed its residual-df expectation, the data is consistent with a pure Binomial; the formula's `κ_pred → ∞` limit is capped at the pure-Binomial concentration. Allowing the formula to run unbounded would produce a predictive Beta tighter than the pure-Binomial — incoherent for an IS proposal. |
| **Resulting `κ_pred ≤ 1`** (extreme over-dispersion or numerical edge) | Floor at 1. | Below `κ_pred = 1` the Beta proposal is not unimodal at the mean; for an IS proposal we want at least a unimodal Beta centred near the empirical rate. |

### Latency-side predictive deferral

A parallel Pearson chi-squared overdispersion estimator on log-arrival times is straightforward in principle (test residual variance of `ln(t_i) − μ̂` against the MLE-implied σ²/N). It is not implemented here because the principled epistemic latency SD from §3 happens to come out at a width comparable to a typical Bayesian κ_lat-inflated predictive on this project's fixtures, so the layer violation does not currently bite on the latency side. If a future fixture reveals the latency-side asymmetry biting analogously, the same machinery applies and the same single-pass treatment can be added.

---

## 7. Layer violation in the runner

A defect lives in the back-end runner's parameter-reading layer. When the runner constructs a per-cohort parameter pack, it reads candidate fields in order — predictive first, bare (epistemic) as fallback — and uses the first non-null positive value it finds. The rationale is sound when the source emits both epistemic and predictive fields: the predictive value already includes the kappa-driven inflation, so reading it first short-circuits any further inflation step.

When the source is the analytic stats pass, the previous design did not emit predictive fields (per the §3.9 deferral). The runner fell through to the bare epistemic value and used it as if it were predictive, with no inflation applied. The downstream sweep then propagated an under-dispersed parameter distribution, with the consequences described in §6 — the IS conditioning step silently became a no-op for the analytic source on the rate side.

The resolution closes the loop in two parts. The analytic stats pass now emits `α_pred` and `β_pred` populated by the §6 quasi-likelihood overdispersion formula; the rate side of the layer violation thereby self-resolves. The latency-side `mu_sd_pred` / `sigma_sd_pred` / `onset_sd_pred` are not emitted (per the deferral noted at the end of §6); the runner continues to fall back to the bare epistemic values for those fields, accepting that for analytic sources the latency-side predictive width is whatever the principled epistemic formula produces — which is comparable to typical Bayesian kappa-inflated predictive on this project's fixtures, so the substitution is acceptable until the latency-side overdispersion estimator lands.

The runner code itself does not need behavioural change. Its existing `_pick_sd` candidate-ordering logic and its existing alpha_pred-first preference at [`forecast_state.py:938-942`](../../../graph-editor/lib/runner/forecast_state.py#L938) are now correct under the broader design — the analytic source emits a real predictive `α_pred` and the runner consumes it without further inflation.

---

## 8. Schema implications

The predictive fields produced by the FE topo stats pass need a transport channel down to the runner. The Bayesian patch service already writes both bare and `_pred` variants of the rate concentration (`alpha`, `beta`, `alpha_pred`, `beta_pred`) into the `posterior` block on the edge. The analytic source previously omitted the `_pred` variants by design.

This design adds two fields to the analytic source's `model_vars[analytic].probability` block:

- `alpha_pred: number` — kappa-inflated predictive Beta α from the §6 formula.
- `beta_pred: number` — kappa-inflated predictive Beta β from the §6 formula.

These fields already exist in the runner's resolver schema for the Bayesian source; the analytic block previously omitted them by design. With the §6 overdispersion model now landed, the previous omission is replaced by population.

The existing tests that assert the analytic source omits `alpha_pred` / `beta_pred` (e.g. [`contextMECEEquivalence.modelVars.e2e.test.ts:257-263`](../../../graph-editor/src/services/__tests__/contextMECEEquivalence.modelVars.e2e.test.ts#L257)) need to be updated to instead assert that these fields are populated when valid cohort data is available, and absent when the §6 edge-case fallbacks kick in (N = 0, no usable cohort data, etc.).

The CF consumer side requires no change. The runner already prefers `*_pred` fields when present and falls back to bare fields when absent, so populating `alpha_pred` / `beta_pred` from the analytic source is automatically picked up by the existing IS-proposal construction at [`forecast_state.py:938-942`](../../../graph-editor/lib/runner/forecast_state.py#L938). The fallback path that reads bare `alpha` / `beta` (epistemic) when `*_pred` is absent remains in place for sources that never emit predictive fields.

The latency-side predictive fields (`mu_sd_pred`, `sigma_sd_pred`, `onset_sd_pred`) are not added to the analytic source's `model_vars[analytic].latency` block in this design (per the deferral at the end of §6). The schema admits them already on the Bayesian side; the analytic side simply omits them. The runner falls back to the bare epistemic SDs for analytic-source latency, which is correct under the principled epistemic formula from §3.

---

## 9. Implementation pointers

Three areas of code participate in the design.

**Latency epistemic SDs (§3–§5).** The front-end stats pass [`statisticalEnhancementService.ts`](../../../graph-editor/src/services/statisticalEnhancementService.ts) previously computed `mu_sd` and `sigma_sd` via the heuristic `1.25 × σ / √N · qualityInflation` clamped to a floor of `0.02`. That block is replaced by the interval-matched effective SD computation: take the relevant quantiles of the Student-t posterior on μ and the scaled inverse chi-squared posterior on σ, and report the half-range divided by the Gaussian z-score for the chosen interval. The `qualityInflation` factor and the fixed floor are removed. The math primitives (Student-t quantile, χ² quantile, regularised incomplete beta and gamma) live in [`lagDistributionUtils.ts`](../../../graph-editor/src/services/lagDistributionUtils.ts).

**Rate predictive concentration (§6).** The analytic stats pass also computes `α_pred` and `β_pred` via the Pearson chi-squared overdispersion formula. The computation runs over the per-cohort `(k_i, n_i)` tuples already aggregated by FE topo for the rate fit; it adds a single linear pass at negligible cost. The output is written to `model_vars[analytic].probability.{alpha_pred, beta_pred}` via [`buildAnalyticProbabilityBlock`](../../../graph-editor/src/services/modelVarsResolution.ts) (or its analytic-source equivalent). Existing tests asserting `alpha_pred` / `beta_pred` are *omitted* on the analytic block need updating (see §8 for the test pointer).

**Runner consumer.** The back-end runner [`forecast_runtime.py`](../../../graph-editor/lib/runner/forecast_runtime.py) and [`forecast_state.py`](../../../graph-editor/lib/runner/forecast_state.py) require no behavioural change. Their existing `_pick_sd` candidate-ordering logic and `alpha_pred`-first preference are correct under the new design — once the analytic source emits real predictive fields, those fields are consumed without further inflation. A clarifying comment at the `_pick_sd` site documents the now-correct semantics.

**Archived prior design.** The prior dispersion design [`project-bayes/archive/heuristic-dispersion-design.md`](../project-bayes/archive/heuristic-dispersion-design.md) is stamped as superseded. It remains available for historical context and to explain the provenance of values that may persist in fixtures generated under the old method, but it is no longer the design of record.

**Tests.** Tests must cover both ends of the N range and the small-N edge cases. The design does not enumerate test names; the [`project-bayes/73g`](../project-bayes/73g-general-purpose-f14-problem-and-invariants.md) invariant 8 applies — a passing test is only meaningful if it exercises the public path and asserts a contract, not an implementation quirk. The contracts are: (a) reported `mu_sd` matches the interval-matched effective SD of the t-posterior to within numerical tolerance for any N ≥ 2 in the supported range; (b) reported `α_pred + β_pred` recovers `S − 1` in the no-overdispersion limit and produces `(S − N) / (X² − (N − 1)) − 1` for non-trivial Pearson `X²`; (c) cross-source parity tests (analytic vs Bayes on the same evidence) close to within tolerance under the now-comparable proposal widths.

---

## 10. References

### Latency-side (§3–§5)

- Casella, G. & Berger, R. L., *Statistical Inference*, 2nd ed., Duxbury, 2002. §5.3 (sampling distributions of the sample mean and variance), §9.2 (interval estimation).
- Gelman, A., Carlin, J. B., Stern, H. S., Dunson, D. B., Vehtari, A. & Rubin, D. B., *Bayesian Data Analysis*, 3rd ed., CRC Press, 2013. §3.2 (the normal model with unknown mean and variance), Appendix A (standard distributions).
- Bickel, P. J. & Doksum, K. A., *Mathematical Statistics*, Vol. 1, 2nd ed., Pearson, 2007. §4.4 (sampling distributions of estimators).
- Lehmann, E. L. & Casella, G., *Theory of Point Estimation*, 2nd ed., Springer, 1998. §6.3 (asymptotic Fisher information).
- Pawitan, Y., *In All Likelihood: Statistical Modelling and Inference Using Likelihood*, OUP, 2001. Ch. 3 and Ch. 9 (likelihood-based inference and small-sample considerations).
- Meeker, W. Q. & Escobar, L. A., *Statistical Methods for Reliability Data*, Wiley, 1998. Ch. 8 (lognormal life data; Wald vs likelihood-ratio confidence intervals).
- Lawless, J. F., *Statistical Models and Methods for Lifetime Data*, 2nd ed., Wiley, 2003. §5.1 (lognormal regression and standard errors).
- Morgan, M. G. & Henrion, M., *Uncertainty: A Guide to Dealing with Uncertainty in Quantitative Risk and Policy Analysis*, CUP, 1990. §8.4 (matching a Gaussian to a stated quantile range).
- Johnson, N. L., Kotz, S. & Balakrishnan, N., *Continuous Univariate Distributions*, Vol. 2, 2nd ed., Wiley, 1995. Ch. 28 (Student-t distribution: moments and finiteness conditions).
- Gelman, A., "Prior distributions for variance parameters in hierarchical models", *Bayesian Analysis* 1 (2006), 515–533.
- Berger, J. O. & Bernardo, J. M., "Estimating a product of means: Bayesian analysis with reference priors", *J. Am. Stat. Assoc.* 84 (1989), 200–207.

### Rate-side (§6)

- Wedderburn, R. W. M., "Quasi-likelihood functions, generalized linear models, and the Gauss-Newton method", *Biometrika* 61 (1974), 439–447.
- Williams, D. A., "The analysis of binary responses from toxicological experiments involving reproduction and teratogenicity", *Biometrics* 31 (1975), 949–952.
- McCullagh, P. & Nelder, J. A., *Generalized Linear Models*, 2nd ed., Chapman & Hall, 1989. §4.5 (binary data, overdispersion), §9.2.4 (quasi-likelihood with dispersion).
- Crowder, M. J., "Beta-binomial ANOVA for proportions", *Applied Statistics* 27 (1978), 34–37.
- Skellam, J. G., "A probability distribution derived from the binomial distribution by regarding the probability of success as variable between the sets of trials", *J. R. Stat. Soc. B* 10 (1948), 257–261.
- Agresti, A. & Coull, B. A., "Approximate is better than 'exact' for interval estimation of binomial proportions", *American Statistician* 52 (1998), 119–126.
- Breslow, N., "Extra-Poisson variation in log-linear models", *Applied Statistics* 33 (1984), 38–44.
- Collett, D., *Modelling Binary Data*, 2nd ed., Chapman & Hall, 2002. §6.3 (overdispersion in logistic regression).
- Liang, K.-Y. & Zeger, S. L., "Longitudinal data analysis using generalized linear models", *Biometrika* 73 (1986), 13–22.
