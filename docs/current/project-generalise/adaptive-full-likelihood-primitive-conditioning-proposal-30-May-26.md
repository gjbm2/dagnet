# Full-Likelihood Primitive Conditioning Proposal

**Date:** 30-May-26  
**Status:** staged proposal, revised 6-Jun-26  
**Scope:** Primitive conditioner importance-sampling quality in `graph-editor/lib/runner/primitive_conditioning.py`, with an escalation path into the shared timing-particle layer only if conditioner-local proposal improvements fail. Reducers, daily conversions, cohort maturity row projection, scalar reducers, chart code, and graph schemas should not change unless the final joint-proposal stage becomes necessary and exposes a new provenance field.

## 1. Purpose

The primitive conditioner needs a pragmatic way to condition aggregate model priors on scoped evidence without silently biasing the posterior and without producing visibly over-confident forecast bands when the fixed particle set collapses.

On 30-May-26 the legacy ESS-threshold tempering path was restored behind a request-only forensic flag, enabled by the `essthreshold` URL parameter and disabled by default. That flag is a diagnostic and rollback aid, not the target statistical design.

The target design is not "make ESS high". The target is:

- the target remains `prior × full_likelihood`;
- `λ` remains `1` in production;
- ESS remains a diagnostic, not a semantic control;
- proposal quality is improved before compute budget is expanded;
- downstream consumers continue to receive coherent primitive draw families.

The practical programme is an escalation ladder:

1. first improve probability proposal placement inside the existing conditioner;
2. then add conditioner-local adaptive candidate expansion if fixed placement is insufficient;
3. only then move to a true joint probability/timing proposal at the shared timing-particle boundary.

That ordering keeps the first implementation small and tests whether the known failure can be fixed without rewriting the timing/evidence-binding substrate.

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

## 4. Key Design Distinctions

### 4.1 Target versus proposal

The posterior target is:

`posterior(θ | evidence) ∝ prior(θ) × likelihood(evidence | θ)`

For latent primitives, `θ` includes probability and timing parameters. The current likelihood already conditions them jointly: each candidate `(p_s, CDF_s)` is scored against the full maturity-aware likelihood.

The failure is in candidate generation, not in the target. When the proposal particle set barely covers the scoped posterior, a few particles carry most of the weight. Tempering fixes the symptom by changing the target. The replacement must improve proposal coverage while keeping full-likelihood scoring.

### 4.2 Probability proposal versus timing proposal

Probability particles are currently sampled inside `primitive_conditioning.py`. Timing particles are different: they are shared with prefix-arrival and evidence binding through the timing-particle / `DrawFamilyKey` invariant. The same timing draw index must be used by:

- prefix-arrival weighting;
- primitive evidence binding;
- the latent likelihood inside primitive conditioning.

Therefore a probability-only proposal improvement can be local to `primitive_conditioning.py`. A timing-guided or fully joint proposal cannot be local: it must be introduced at the shared timing-particle boundary so evidence binding and likelihood scoring use the same timing worlds.

### 4.3 Public output count versus internal candidates

There are two different counts:

- The public request draw count, currently `mc_draws`, is the shape downstream composition expects. All primitives in the request must expose coherent arrays of this size.
- The internal candidate count, used only in later adaptive stages, is how many candidate particles the conditioner evaluates before it resamples the public draw family.

Any adaptive mechanism must grow the internal candidate pool, not change the output draw count per primitive. After the conditioner has accumulated the weighted candidate pool, it resamples exactly the request draw count as the primitive's public draw family.

This keeps the change local:

- composition still sees the same `draw_count`;
- `DrawFamilyKey` coherence still holds;
- row projection and scalar consumers do not need shape logic;
- cache identity only needs to include proposal algorithm/settings that can change the sampled posterior representation.

## 5. Proposed Runtime Behaviour

### 5.1 Stage 1 runtime: fixed p-guided proposal

For latent primitives, `_evaluate_likelihood_plan` should first replace the current probability proposal with an explicit proposal helper. In the default reproduction mode this helper returns the current proposal and the proposal correction cancels exactly.

Then add a p-guided mixture proposal:

- one component is the current prior/predictive Beta proposal;
- one component is a cheap evidence-guided Beta proposal derived from `_CohortLikelihoodPlan`;
- the mixture density is used in the importance correction.

The weight becomes:

`log_weight_s = log_likelihood_s + log_prior_p(p_s) - log_q_p(p_s)`

Timing particles are unchanged in Stage 1, so no timing-density correction is introduced. The latent likelihood still scores `(p_s, CDF_s)` jointly.

The evidence guide should be intentionally simple. Use the plan's weighted evidence summaries to estimate an evidence-implied rate, for example by dividing observed weighted conversions by weighted denominator and a prior/timing-derived completeness summary. Clamp only at the perimeter of Beta-parameter construction to keep the guide valid; the correction term, not the guide, preserves the posterior target.

### 5.2 Stage 2 runtime: adaptive conditioner-local candidate expansion

If Stage 1 does not fix the known narrow-band case, extend the conditioner to evaluate additional candidate batches while still staying inside `primitive_conditioning.py`.

Important details:

- each batch is deterministic under the primitive draw-family key plus a batch discriminator;
- each batch evaluates full likelihood with `λ = 1`;
- weights include the same proposal correction as Stage 1;
- earlier batches are not regenerated;
- resampling happens once from the final accumulated pool;
- the public output remains exactly `draw_count`.

This stage may add more timing particles as part of extra candidate batches, but it does not re-bind evidence. It is still not a true timing-guided proposal. It only tests whether more conditioner-local joint candidates are enough.

### 5.3 Stage 3 runtime: true joint guided proposal

If Stage 2 still fails, the problem is likely joint timing/probability proposal coverage rather than probability placement alone. At that point the proposal must move upstream.

The shared proposal family should carry:

- probability draws;
- timing draws (`mu`, `sigma`, `onset`);
- proposal log density;
- prior log density;
- proposal provenance.

The flow becomes:

1. build a joint proposal particle family;
2. build prefix-arrival maps from that same timing family;
3. bind evidence using those arrival maps;
4. run primitive conditioning using the same joint particles;
5. weight by `log_likelihood + log_prior - log_q`.

A practical implementation may need a two-pass guide: first bind evidence under the current prior proposal to construct a guide, then build the final guided proposal and re-bind evidence. This is the expensive architectural stage and should not be attempted unless the conditioner-local stages fail.

## 6. Adequacy And Escalation

The staged programme uses acceptance against the known troublesome forecaster case, not an abstract ESS floor.

Stage 1 is accepted if p-guided proposal:

- keeps `λ = 1`;
- preserves the public output shape;
- produces sensible bands on the known case;
- does not pull the midpoint toward the prior in the way `essthreshold` does;
- has runtime close to current full-likelihood IS.

Stage 2 is entered only if Stage 1 fails the known case. It is accepted if bounded adaptive candidate expansion fixes the known case without unacceptable runtime.

Stage 3 is entered only if Stage 2 fails. Its acceptance must include a coherence test proving that the timing particles used for prefix-arrival/evidence binding are the same timing particles scored in the likelihood.

ESS, ESS ratio, and top-weight share remain diagnostics. They may justify escalation or an additional candidate batch, but they must not change `λ` and must not define statistical correctness.

## 7. Settings Surface

Add request-scoped settings only. They should not be part of persisted Bayes model signatures unless they change fitted model artefacts, which this proposal does not.

Suggested settings:

- probability proposal mode, if needed for tests (`prior`, `p_guided_mixture`);
- probability-guide concentration or cap, if not hard-coded conservatively;
- adaptive maximum candidate multiplier for Stage 2, if Stage 2 is implemented;
- batch growth policy for Stage 2;
- joint proposal mode/settings for Stage 3, if Stage 3 is implemented.

Stage 1 should be guarded by a short-lived request-only URL parameter while it is being proven against the known forecaster case. This is a comparison/rollout guard, not a product mode. It must be excluded from persisted Bayes model signatures, visibly named as temporary, and included in request/result cache identity while it exists so flagged and unflagged chart responses cannot collide.

Once the p-guided proposal is accepted, flip it to the default and remove the temporary URL parameter. Do not leave a permanent alternate proposal mode.

The current `is_ess_threshold_enabled` compatibility switch remains separate and should not be conflated with adaptive full-likelihood sampling.

## 8. Provenance

Primitive notes/provenance should expose enough to compare full-likelihood, adaptive, and temporary thresholded runs:

- algorithm mode: fixed prior proposal, p-guided proposal, adaptive p-guided candidate expansion, joint guided proposal, or legacy ESS-thresholded;
- likelihood temperature, which should be `1.0` except in the legacy flag path;
- public output draw count;
- candidate count and batch count where relevant;
- final ESS and ESS ratio;
- top-weight share;
- proposal guide summary, such as guide mean/concentration for Stage 1;
- cap-hit flag for adaptive stages.

This turns low particle quality into an observable condition rather than a hidden semantic change.

## 9. Implementation Stages

### Stage 0 - Temporary Comparison Flag

Already landed on 30-May-26:

- `essthreshold` URL parameter enables the old ESS-threshold λ search.
- Default remains full-likelihood `λ = 1`.
- The flag is request-only and excluded from model settings signatures.
- Focused tests prove the default and flagged branches differ.

Stage 0 is a forensic aid only. It should remain easy to delete after the full-likelihood proposal path is proven.

### Stage 1 - Fixed p-Guided Proposal

Make proposal sampling explicit inside the latent branch of `_evaluate_likelihood_plan`.

Atoms:

1. Add a helper that samples the current probability proposal and returns `proposal_p_draws`, `log_q_p`, and `log_prior_p`. In current mode, `log_q_p == log_prior_p`, so the output should match the existing path.
2. Update the latent weight calculation to use `log_likelihood + log_prior_p - log_q_p`.
3. Add a p-guided mixture proposal using `_CohortLikelihoodPlan` evidence summaries.
4. Keep timing particles exactly as they are.
5. Record proposal provenance in primitive notes.

Acceptance:

- prior-proposal reproduction mode matches current full-likelihood behaviour;
- p-guided mode keeps `λ = 1`;
- output arrays keep the original request draw shape;
- the known forecaster case no longer needs `essthreshold` if Stage 1 is sufficient;
- the temporary URL parameter cleanly separates flagged and unflagged cache entries;
- no files outside `primitive_conditioning.py` need semantic changes.

### Stage 2 - Conditioner-Local Adaptive Candidate Expansion

Implement batched candidate-pool growth inside the latent branch of `_evaluate_likelihood_plan`, building directly on the Stage 1 proposal helper.

The public primitive draw family remains the request `draw_count`. Only the internal candidate pool grows. Cache identity includes adaptive settings.

Acceptance:

- Stage 1 behaviour remains available as the first batch / non-adaptive degeneration;
- low-quality synthetic cases append at least one batch;
- output arrays keep the original request draw shape;
- resampling occurs once from the final accumulated weighted pool;
- λ remains `1.0` in adaptive mode;
- provenance reports candidate count, batch count, final ESS, ESS ratio, top-weight share, and cap-hit status;
- no evidence rebinding is introduced in this stage.

### Stage 3 - Shared Joint Probability/Timing Proposal

Only enter this stage if Stage 2 fails the known case or shows that timing proposal coverage is the dominant problem.

Move proposal generation to the shared particle boundary so timing particles used for prefix-arrival/evidence binding are identical to timing particles scored by primitive conditioning.

Acceptance:

- a joint proposal object carries probability draws, timing draws, proposal log density, prior log density, and provenance;
- evidence binding and likelihood scoring consume the same timing draw family;
- latent weights use `log_likelihood + log_prior - log_q`;
- output arrays keep the original request draw shape;
- cache identity includes joint proposal identity/settings;
- no projection or reducer performs fit/proposal selection.

### Stage 4 - Comparison And `essthreshold` Retirement

Run representative troublesome queries in three modes:

- current/default full-likelihood before the change, if still available in test harness;
- temporary p-guided or adaptive full-likelihood URL path;
- temporary `essthreshold`;

The desired outcome is that the new full-likelihood proposal path restores reasonable band width without matching the thresholded posterior's prior-biased midpoint when scoped evidence genuinely disagrees with the aggregate prior.

If Stage 3 still produces unreasonably narrow bands, the issue is not fixed-pool proposal placement. At that point the next investigation should be likelihood shape or predictive-dispersion structure, not ESS tempering.

Once the full-likelihood proposal path is accepted, remove or hard-deprecate the `essthreshold` branch.

At the same time, remove the temporary p-guided/adaptive URL parameter by making the accepted full-likelihood proposal path the default. The only surviving runtime should be the accepted full-likelihood proposal, not a menu of proposal modes.

## 10. Test Plan

Focused primitive-conditioner tests should cover:

- the default path uses full likelihood with `λ = 1`;
- the temporary `essthreshold` path remains opt-in;
- prior-proposal reproduction mode cancels `log_prior_p - log_q_p`;
- p-guided proposal changes proposal placement but keeps `λ = 1`;
- p-guided proposal preserves output draw shape;
- the p-guided URL parameter is request-only and cache-keyed while it exists;
- proposal provenance appears in primitive notes;
- adaptive mode, if implemented, appends batches under a controlled low-quality diagnostic;
- adaptive mode, if implemented, records cap-hit when the maximum pool is reached;
- joint-proposal mode, if implemented, proves timing particles used for evidence binding and likelihood scoring are the same family;
- cache identity separates prior, p-guided, adaptive, joint, and thresholded modes where those modes exist.

At least one synthetic or fixture-backed test should compare the known poor fixed proposal against the p-guided proposal and the temporary thresholded path. The full-likelihood proposal result should not be judged by matching `essthreshold`; it should preserve the full-likelihood midpoint while improving particle quality or visible bands.

Outside-in coverage should use one confirmed narrow-band query once the unit-level mechanics are stable. That test should assert user-visible band width or provenance, not internal particle arrays.

## 11. Open Decisions

1. **Guide construction for Stage 1.** The guide should be simple and local: derive a probability centre from `_CohortLikelihoodPlan` evidence summaries and a conservative completeness summary, then choose a moderate Beta concentration. This needs a concrete formula before implementation.

2. **Whether Stage 2 is needed.** Do not implement adaptive expansion unless Stage 1 fails the known case.

3. **Whether Stage 3 is needed.** Do not move proposal generation into the shared timing-particle boundary unless Stage 2 fails or timing coverage is clearly the limiting issue.

4. **How much provenance should be public.** Primitive notes may be enough for CLI/forensics; chart-level warning UI is separate and should not block the conditioner fix.

## 12. Success Criteria

The proposal succeeds when:

- full-likelihood conditioning remains the default statistical target;
- confirmed narrow-band cases no longer depend on `essthreshold` for reasonable bands;
- scoped evidence is not systematically pulled back toward the prior by hidden tempering;
- all downstream consumers continue to read the same primitive shape;
- the first sufficient stage in the escalation ladder is the one that ships;
- low particle quality is visible in provenance rather than silently repaired.
