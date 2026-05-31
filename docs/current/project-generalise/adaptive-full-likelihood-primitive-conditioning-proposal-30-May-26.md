# Adaptive Full-Likelihood Primitive Conditioning Proposal

**Date:** 30-May-26  
**Status:** proposal  
**Scope:** Primitive conditioner importance-sampling quality in `graph-editor/lib/runner/primitive_conditioning.py`. The intended production fix is local to primitive conditioning and request-scoped forecasting settings. Reducers, daily conversions, cohort maturity row projection, scalar reducers, and graph schemas should not change for the core fix.

## 1. Purpose

The primitive conditioner needs a pragmatic way to condition aggregate model priors on scoped evidence without silently biasing the posterior and without producing visibly over-confident forecast bands when the fixed particle set collapses.

On 30-May-26 the legacy ESS-threshold tempering path was restored behind a request-only forensic flag, enabled by the `essthreshold` URL parameter and disabled by default. That flag is a diagnostic and rollback aid, not the target statistical design.

The target design is adaptive full-likelihood importance sampling:

- the target remains `prior × full_likelihood`;
- `λ` remains `1` in production;
- ESS remains a diagnostic, not a semantic control;
- the conditioner adapts computation budget, not the posterior;
- downstream consumers continue to receive coherent primitive draw families.

## 2. Confirmed Problem

Two facts are now established:

- Removing the ESS threshold avoids the old systematic bias. The old path weakened scoped evidence by searching for a smaller likelihood temperature `λ` whenever too few particles survived. That changed the posterior toward the prior in exactly the cases where scoped evidence was sharp or surprising.
- Running the current full-likelihood path with a fixed particle count can produce unreasonably narrowed forecast bands. The failure mode is particle degeneracy: after full-likelihood weighting, too few coherent `(p, CDF)` particles carry most of the mass, so the resampled posterior/fan can under-represent uncertainty.

These facts are not contradictory. The threshold fixed a Monte Carlo degeneracy symptom by changing the statistical target. We need to fix the Monte Carlo approximation while preserving the target.

Low ESS in this context means "the proposal particle set did not adequately cover the scoped posterior". It does not mean "there was little evidence", and it must not be used as a reason to dilute evidence.

## 3. Non-Goals

This proposal does not introduce a new forecast path, row reducer, daily-conversions rule, or cohort-maturity display rule.

It does not reintroduce default likelihood tempering. The `essthreshold` flag may remain temporarily for comparison runs, but it must stay visibly marked as a compatibility path.

It does not solve predictive dispersion structure generally. The kappa-realised FC proposal remains the separate plan for the unit at which realised-rate variation enters forecast bands. This proposal addresses the primitive conditioner's importance-sampling particle quality.

It does not require per-primitive output draw counts to vary. Per-primitive variable output shapes would break draw-family coherence through composition.

## 4. Key Design Distinction

There are two different counts:

- The public request draw count, currently `mc_draws`, is the shape downstream composition expects. All primitives in the request must expose coherent arrays of this size.
- The internal proposal pool count is how many candidate particles the conditioner evaluates before it resamples the public draw family.

The adaptive mechanism should grow the internal proposal pool, not change the output draw count per primitive. After the conditioner has accumulated an adequate weighted pool, it resamples exactly the request draw count as the primitive's public draw family.

This keeps the change local:

- composition still sees the same `draw_count`;
- `DrawFamilyKey` coherence still holds;
- row projection and scalar consumers do not need shape logic;
- cache identity only needs to include the adaptive algorithm/settings that can change the posterior.

## 5. Proposed Runtime Behaviour

For latent primitives, `_evaluate_likelihood_plan` should use a batched full-likelihood self-normalised importance-sampling loop.

The conditioner starts with an initial proposal batch. For each batch it samples coherent probability and timing particles, computes the existing full multinomial log-likelihood with `λ = 1`, and appends particles plus log-likelihoods to an accumulated pool.

After each append, it normalises weights across the whole accumulated pool and computes a small set of primitive-local stability diagnostics. If the weighted estimate is adequate, or the maximum proposal-pool budget is reached, it stops. It then resamples the public `draw_count` from the final accumulated weighted pool exactly once.

Important details:

- Earlier batches are not regenerated when more particles are added.
- Batches must be deterministic under the primitive draw-family key plus an algorithm/batch discriminator.
- `p` draws and CDF draws must remain coherent pairs through weighting, resampling, and doc-52 blending.
- The likelihood formula does not change between batches.
- Resampling happens once at the end, not after each batch.

## 6. Adequacy Criterion

The stopping rule should be tied to output precision, not an ESS floor.

The first implementation should use simple stability diagnostics over the accumulated weighted pool. Candidate diagnostics:

- weighted posterior mean of `p`;
- weighted central quantiles of `p`;
- selected CDF summaries at the frontier/saturation grid points already used by the primitive;
- top-weight share and ESS/relative ESS as reported diagnostics only.

Adequacy should mean that the exposed primitive answer is stable enough for downstream display/forecast precision. If a tolerance is needed, it should be a named request setting tied to product precision, not a hidden literal inside the conditioner. ESS may trigger "consider another batch", but it must not be the definition of correctness and must not alter `λ`.

If the maximum pool budget is reached before adequacy, the conditioner still returns the full-likelihood result from the best accumulated pool. Provenance must state that the cap was hit.

## 7. Settings Surface

Add request-scoped settings only. They should not be part of persisted Bayes model signatures unless they change fitted model artefacts, which this proposal does not.

Suggested settings:

- adaptive primitive IS enabled/disabled;
- initial proposal-pool size;
- maximum proposal-pool size;
- batch growth policy;
- output-stability tolerance or display-precision target.

The existing `mc_draws` remains the public output draw count. It may also serve as the default initial proposal-pool size if no separate setting is provided.

The current `is_ess_threshold_enabled` compatibility switch remains separate and should not be conflated with adaptive full-likelihood sampling.

## 8. Provenance

Primitive notes/provenance should expose enough to compare full-likelihood, adaptive, and temporary thresholded runs:

- algorithm mode: fixed full-likelihood, adaptive full-likelihood, or legacy ESS-thresholded;
- likelihood temperature, which should be `1.0` except in the legacy flag path;
- public output draw count;
- proposal-pool count;
- batch count;
- final ESS and ESS ratio;
- top-weight share;
- adequacy metric and pass/fail;
- cap-hit flag.

This turns low particle quality into an observable condition rather than a hidden semantic change.

## 9. Implementation Stages

### Stage 0 - Temporary Comparison Flag

Already landed on 30-May-26:

- `essthreshold` URL parameter enables the old ESS-threshold λ search.
- Default remains full-likelihood `λ = 1`.
- The flag is request-only and excluded from model settings signatures.
- Focused tests prove the default and flagged branches differ.

Stage 0 is a forensic aid only. It should remain easy to delete after the adaptive path is proven.

### Stage 1 - Instrument Fixed Full-Likelihood Quality

Before adding adaptation, record the diagnostics listed above for the existing fixed-pool full-likelihood path. This establishes how often production-like requests are particle-dominated and gives a baseline against the temporary thresholded behaviour.

Acceptance:

- diagnostics appear in primitive notes/provenance;
- no answer changes relative to current default full-likelihood behaviour;
- the `essthreshold` comparison path remains opt-in.

### Stage 2 - Add Adaptive Internal Proposal Pool

Implement batched full-likelihood proposal-pool growth inside the latent branch of `_evaluate_likelihood_plan`.

The public primitive draw family remains the request `draw_count`. Only the internal candidate pool grows. Cache identity includes the adaptive settings.

Acceptance:

- default-off behaviour remains bit-for-bit equivalent where adaptive mode is disabled;
- with adaptive mode enabled, low-quality synthetic cases append at least one batch;
- output arrays keep the original request draw shape;
- resampling occurs once from the final accumulated weighted pool;
- λ remains `1.0` in adaptive mode;
- provenance reports pool count, batch count, final ESS, ESS ratio, top-weight share, adequacy status, and cap-hit status.

### Stage 3 - Production Comparison And Flag Retirement

Run representative troublesome queries in three modes:

- fixed full-likelihood default;
- temporary `essthreshold`;
- adaptive full-likelihood.

The desired outcome is that adaptive full-likelihood restores reasonable band width without matching the thresholded posterior's prior-biased midpoint when scoped evidence genuinely disagrees with the aggregate prior.

If adaptive full-likelihood still produces unreasonably narrow bands at a high pool budget, the issue is not fixed-pool Monte Carlo collapse. At that point the next investigation should be likelihood shape, proposal family, or predictive-dispersion structure, not ESS tempering.

Once adaptive full-likelihood is accepted, remove or hard-deprecate the `essthreshold` branch.

## 10. Test Plan

Focused primitive-conditioner tests should cover:

- the default path uses full likelihood with `λ = 1`;
- the temporary `essthreshold` path remains opt-in;
- adaptive mode never changes `λ`;
- adaptive mode appends batches under a controlled low-quality diagnostic;
- adaptive mode preserves output draw shape;
- adaptive mode records cap-hit when the maximum pool is reached;
- full-likelihood fixed and adaptive paths share the same likelihood accumulator;
- cache identity separates fixed, adaptive, and thresholded modes.

At least one synthetic test should compare a deliberately small fixed pool against a large-pool reference. The adaptive result should move toward the large-pool full-likelihood reference, not toward the thresholded tempered result.

Outside-in coverage should use one confirmed narrow-band query once the unit-level mechanics are stable. That test should assert user-visible band width or provenance, not internal particle arrays.

## 11. Open Decisions

The main open decision is the adequacy metric. It should be chosen conservatively and documented as a product precision target. It must not become a disguised ESS floor.

The second open decision is whether the first adaptive implementation should be opt-in by a separate URL/request flag or enabled by default once tests pass. Given the recent band regression, the safer path is opt-in for comparison, then default-on after representative runs show stable behaviour.

The third open decision is how much of the diagnostic surface should be public. Primitive notes may be enough for CLI/forensics; chart-level warning UI is separate and should not block the conditioner fix.

## 12. Success Criteria

The proposal succeeds when:

- full-likelihood conditioning remains the default statistical target;
- confirmed narrow-band cases no longer depend on `essthreshold` for reasonable bands;
- scoped evidence is not systematically pulled back toward the prior by hidden tempering;
- all downstream consumers continue to read the same primitive shape;
- low particle quality is visible in provenance rather than silently repaired.
