# Epistemic dispersion design — analytic stats pass

**Status**: Persistent design — design of record for `mu_sd` / `sigma_sd` reported by the FE topo stats pass.
**Adopted**: 28-Apr-26
**Supersedes**: [`project-bayes/archive/heuristic-dispersion-design.md`](../project-bayes/archive/heuristic-dispersion-design.md) (the `1.25 × σ / √N` heuristic and its compounded corrections).
**Originating investigations**: [`project-bayes/73f`](../project-bayes/73f-outside-in-cohort-engine-investigation.md), [`project-bayes/73g`](../project-bayes/73g-general-purpose-f14-problem-and-invariants.md).
**Scope**: defines the formula used by `statisticalEnhancementService.ts` for epistemic SDs on the lognormal latency parameters, and the parameter-reading discipline in `forecast_runtime.py` that consumes them.

---

## 1. Purpose

Specify a research-grounded, general-purpose method for reporting epistemic uncertainty on the lognormal latency parameters (μ, σ) emitted by the analytic stats pass. The method must work without arbitrary tuning across the full plausible sample-size range — from a handful of converters in a thin window to millions of converters in a saturated edge — and must rest on standard statistical theory rather than invented multipliers.

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

## 6. Layer violation in the runner

A separate, related defect lives in the back-end runner's parameter-reading layer. When the runner constructs a per-cohort parameter pack, it reads four candidate fields in order — the predictive location SD, the bare (epistemic) location SD, an edge-level predictive SD, and an edge-level bare SD — and uses the first non-null positive value it finds. The rationale for the candidate ordering is sound when the source is a Bayesian fit that emits both epistemic and predictive fields: the predictive value already includes the kappa-driven inflation that the runner would otherwise need to apply, so reading it first short-circuits the inflation step and reduces redundant work.

When the source is the analytic stats pass, however, no predictive field is emitted (correctly, since the analytic source has no basis to compute one), and the runner falls through to the bare epistemic value. It then uses that bare value as if it were predictive, with no inflation applied. The downstream sweep therefore propagates an under-dispersed parameter distribution, masking the true predictive uncertainty.

The fix is independent of the dispersion design above but ships alongside it. The runner must distinguish between "predictive value is available, use it directly" and "only the epistemic value is available, apply the predictive-inflation step before use". The current single-fallback chain conflates the two cases. The resolution is to read predictive and epistemic into separate variables and to apply the predictive-inflation step explicitly when only epistemic is available, rather than relying on field-name precedence to imply semantics. The inflation step itself is the runner's existing kappa-based machinery; this design does not change it.

---

## 7. Implementation pointers

Three files participate in the change.

The front-end stats pass [`statisticalEnhancementService.ts`](../../../graph-editor/src/services/statisticalEnhancementService.ts) computes μ_sd and σ_sd today using the heuristic formulas. The relevant block is the per-cohort dispersion calculation that multiplies σ by √(π/2)/√N and then by the qualityInflation factor and clamps to a floor. That block is replaced by the interval-matched effective SD computation: take the relevant quantiles of the Student-t posterior on μ and the scaled inverse chi-squared posterior on σ, and report the half-range divided by the Gaussian z-score for the chosen interval. The qualityInflation factor and the fixed floor are removed.

The back-end runner [`forecast_runtime.py`](../../../graph-editor/lib/runner/forecast_runtime.py) reads the dispersion fields when constructing its per-cohort parameter pack. The candidate-ordering logic that conflates predictive and epistemic must be split. When only epistemic dispersion is present, the runner applies its existing kappa-based inflation step before propagating the value into the sweep. When predictive is present, the inflation step is skipped exactly as today. The runner's existing inflation machinery is the same machinery the Bayesian path would otherwise use; this design does not modify it.

The prior dispersion design [`project-bayes/archive/heuristic-dispersion-design.md`](../project-bayes/archive/heuristic-dispersion-design.md) is stamped as superseded. It remains available for historical context and to explain the provenance of values that may persist in fixtures generated under the old method, but it is no longer the design of record.

Tests must cover both ends of the N range and the small-N edge cases. The design does not enumerate test names; the [`project-bayes/73g`](../project-bayes/73g-general-purpose-f14-problem-and-invariants.md) invariant 8 applies — a passing test is only meaningful if it exercises the public path and asserts a contract, not an implementation quirk. The contract here is that the reported μ_sd matches the interval-matched effective SD of the t-posterior to within numerical tolerance for any N in the supported range, and that for analytic-source inputs the runner sees a predictively-inflated value at the point where it propagates parameter uncertainty.

---

## 8. References

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
