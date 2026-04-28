# 73j — Importance-sampling proposal overdispersion with likelihood-only weights

**Status**: Problem statement — for external review before implementation
**Date opened**: 28-Apr-26
**Originating context**: trajectory-band parity gap observed in [`73f`](73f-outside-in-cohort-engine-investigation.md) and only partially closed by [`docs/current/codebase/EPISTEMIC_DISPERSION_DESIGN.md`](../codebase/EPISTEMIC_DISPERSION_DESIGN.md).

---

## Background for a cold reader

The system models conversion funnels as directed graphs of user states. Each edge has a conversion probability `p` and a latency distribution (a shifted lognormal in location `μ`, scale `σ`, with a deterministic onset shift). Per-edge fits live as posteriors on `(μ, σ, onset, p)` — produced either by an offline MCMC pipeline or by an analytic surrogate that runs in the browser.

For queries that ask about conversion outcomes for an upstream cohort propagating through several edges, the engine builds a Monte Carlo carrier. It draws `S` samples of each upstream edge's parameters from that edge's posterior, propagates each draw through a lognormal CDF to obtain a per-draw arrival distribution at the downstream node, and uses those `S` arrival distributions as a proposal for importance sampling against the cohort's observed conversion counts. The reweighted particle set is meant to represent the conditioned posterior on the upstream parameters given the cohort evidence, and forms the basis of the chart's confidence bands.

## The defect

The proposal distribution is deliberately overdispersed. Each draw of upstream `μ` is sampled with SD `2 × μ_sd_posterior`, and similarly for `σ`, `onset`, `p`. This 2× factor is hardcoded as a constant called `DRIFT_FRACTION` (a misleading name; its actual purpose is unrelated to drift). The project handover that introduced it documents the rationale: a tighter proposal of `0.2 × μ_sd_posterior` had caused all `S` particles to land in essentially identical positions when cohort evidence was informative, weights collapsed to a near-uniform distribution, and the importance-sampling step degenerated to a no-op. Widening the proposal to `2 ×` resolved that by giving the likelihood enough variation across particles to discriminate. This is standard importance-sampling practice; overdispersion factors of 1.5 to 3× are conventional in the textbook treatment.

The textbook rule is also clear about the next step: importance weights must include the ratio of the target density to the proposal density. With proposal `q(θ)` and target `π(θ) ∝ prior(θ) × likelihood(y | θ)`, the per-particle weight is `w_i = prior(θ_i) × likelihood(y | θ_i) / q(θ_i)`. Reweighted draws then represent the target regardless of how much wider the proposal was made — the proposal width is "free" provided the `prior / q` ratio is in the weight.

The current implementation does not do this. The weight reduces to the cohort log-likelihood alone:

> `log_w_i = log likelihood(y | θ_i)`

with no `log prior(θ_i) − log q(θ_i)` term. The implementation implicitly treats the overdispersed proposal *as* the prior. The reweighted draws therefore represent `q(θ) × likelihood(y | θ)`, normalised — a posterior derived from a wider effective prior than the actual posterior we drew the proposal mean from.

## Why this matters: regime dependence

The error is regime-dependent.

When the cohort evidence is **strong** (many observations relative to the proposal width), the likelihood term varies sharply across particles. The reweighted posterior collapses onto the high-likelihood region, which in this regime is narrower than `q(θ)`. The overdispersion is harmlessly absorbed. This is the regime in which the handover's switch from `0.2×` to `2×` was tested, and it gave the expected non-degenerate effective sample size.

When the cohort evidence is **weak** (few observations, or a diffuse likelihood across the proposal support), the likelihood is approximately flat across particles. The reweighted posterior is approximately the proposal itself. Output uncertainty bands are then inflated by approximately the overdispersion factor — about 2× wider than the true conditioned posterior on each parameter. The carrier-convolution step downstream propagates this inflation into the trajectory.

This regime is where the project's outside-in trajectory parity tests against analytic convolution oracles currently fail. The observed magnitude — engine output sitting roughly 30–50% of the oracle's value at low τ in the weak-evidence test — is consistent in direction and order of magnitude with a 2× too-wide carrier proposal feeding into the convolution. (It is not the full explanation; a separate fix to the analytic source's input `μ_sd` was recently landed and closed about 14× of the gap. The residual gap is plausibly the issue described here.)

## Options

### Option 1 — Add the `prior / proposal` ratio to the weight

Standard importance-sampling correction: extend the per-particle log-weight to include `log prior(θ_i) − log q(θ_i)` before normalisation. Output then represents the target regardless of proposal width. Both the strong-evidence non-degenerate effective sample size — which the handover's switch to `2×` was protecting — and the weak-evidence correct posterior width are preserved.

Cost: one extra log-density evaluation per particle for the proposal `q` and one for the prior. The proposal is a Gaussian per parameter centred on the posterior mean with the overdispersed SD, all in closed form. The prior is the per-edge posterior summary that the engine already has access to (Bayesian fit or analytic surrogate). Computationally negligible.

Caveat: the analytic surrogate's "prior" is its own moment-matched posterior; for purposes of this correction it functions identically to the Bayesian posterior — both are summaries of conjugate-form fits and have closed-form densities.

### Option 2 — Drop the overdispersion factor to 1.0

Set `q = prior`. The missing `prior / q` ratio collapses to unity, so likelihood-only weights become mathematically correct.

Cost: smaller effective sample size when cohort evidence is strong. The handover characterised this as "crippling" the importance-sampling step, but the underlying behaviour is correct: when evidence is strongly informative, the conditioned posterior really is sharply concentrated, and a sample-from-prior approach produces few useful particles. Computationally wasteful in that regime; mathematically clean.

### Option 3 — Defensive mixture proposal with corrected weights

Combine Option 1's correction with a proposal that mixes the prior with a broad fallback density: `q = α × prior + (1 − α) × broad`. This guarantees tail coverage in regimes where the prior may be too narrow to capture posterior mass under unusual evidence, while keeping the bulk of particles in the prior region. Weights are computed as `prior × likelihood / q`, exactly as in Option 1; the change is purely to the proposal shape.

Cost: more elaborate. The broad-fallback density must be specified, its support must contain the prior's support, and the mixture weight `α` must be chosen. Rarely necessary if the prior is already a reasonable fit summary and Option 1 is implemented correctly.

## Recommendation

Option 1.

It is the smallest principled change. It addresses the defect where it lies — in the weight computation, not in the proposal width. It preserves the non-degenerate effective sample size behaviour that the handover documented as a real regression fix when the proposal width was too narrow. It restores correct posterior width in the weak-evidence regime where the current implementation visibly fails the trajectory parity tests.

The fix is local to one function — the importance-sampling step that builds the weight vector from the cohort likelihood. The proposal-construction code, the carrier-convolution downstream, and the consumer surfaces are untouched.

Tests should cover at minimum two regimes. In the strong-evidence regime, the corrected weights should give a posterior consistent with the current implementation, since the overdispersion is harmlessly absorbed there and the new `prior / q` ratio is small relative to the likelihood variation. In the weak-evidence regime, the corrected weights should give a posterior whose carrier-convolution output matches the analytic convolution oracle to within numerical tolerance at the low-τ band where the current implementation fails by a factor of ~3.

## Relationship to the recently-landed dispersion design

This issue is independent of and downstream from the fix recorded in [`docs/current/codebase/EPISTEMIC_DISPERSION_DESIGN.md`](../codebase/EPISTEMIC_DISPERSION_DESIGN.md). That fix corrected the analytic source's input `μ_sd` and `σ_sd`, which had been computed via a heuristic with no first-principles derivation; they are now the interval-matched effective SDs of the Jeffreys-prior posteriors on `μ` and `σ²`. The issue described here is in the next layer up: how those (now-correct) input dispersions are used to construct an importance-sampling proposal, and whether the reweighting step is mathematically sound.

The dispersion fix moved the trajectory parity gap by about 14× in the right direction (the failing test at low τ went from approximately `0.0006` to `0.0085` against an oracle of `0.0285`). The residual ~3× gap is plausibly the issue described here, though confirming that requires implementing Option 1 and re-running the parity test.

## Reading list

- Project handover that introduced `2×` and explains the original `0.2× → 2×` change: `docs/current/handover/14-Apr-26-forecast-engine-phase3-carrier-hierarchy.md` §D4.
- The recently-landed input-dispersion design: [`docs/current/codebase/EPISTEMIC_DISPERSION_DESIGN.md`](../codebase/EPISTEMIC_DISPERSION_DESIGN.md).
- The trajectory parity tests this issue reproduces against: [`73f`](73f-outside-in-cohort-engine-investigation.md), specifically the low-evidence cohort tests against the factorised-convolution oracle.
- Standard treatment of importance sampling and target/proposal weight correction: Robert & Casella, *Monte Carlo Statistical Methods*, 2nd ed., Springer, 2004, §3.3; Owen, *Monte Carlo theory, methods and examples* (online), 2013, ch. 9.
