# 73n — Carrier conditioning from admitted window evidence

**Status**: Archived superseded draft  
**Date opened**: 30-Apr-26  
**Archived**: 30-Apr-26  
**Archive reason**: Superseded by the full `73n` rewrite centred on conditioned transition primitives as the common CF substrate for `window()`, `subject_span`, and `carrier_to_x`.  
**Original location**: [`../73n-carrier-evidence-conditioning-implementation-plan.md`](../73n-carrier-evidence-conditioning-implementation-plan.md)

## Archive note

This draft framed the problem as carrier-specific evidence conditioning: it introduced a `carrier_to_x_arrivals` evidence role and a joint carrier-plus-subject IS likelihood. The replacement plan generalises further: evidence conditioning is treated as a primitive transition problem where each `window(U-V)` transition is conditioned first, residual transitions are derived by policy, and `window()`, `subject_span`, and `carrier_to_x` all consume the same posterior primitive objects.

Substantive material preserved below for reference: the joint particle-state design, the observation-shape taxonomy, the likelihood algebra (single-frontier Binomial, trajectory conditional-binomial, anchor-population path-completeness convolution), the carrier evidence identity model, the implementation surface map, and the staged acceptance tests. Several of these remain useful as detail under the primitive-conditioning substrate, even though the top-level framing has been replaced.

---

# Superseded draft (preserved verbatim from git HEAD prior to rewrite)

**Status**: Implementation plan, pending review  
**Date opened**: 30-Apr-26  
**Depends on**: [`73m-carrier-composition-and-router-unification-implementation-plan.md`](73m-carrier-composition-and-router-unification-implementation-plan.md)  
**Parent problem statements**: [`73h-v3-router-and-carrier-conditioning-forensic.md`](73h-v3-router-and-carrier-conditioning-forensic.md), [`73g-general-purpose-f14-problem-and-invariants.md`](73g-general-purpose-f14-problem-and-invariants.md)  
**Semantic source of truth**: [`docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md)  
**Evidence merge foundation**: [`73i-shared-evidence-merge-design.md`](73i-shared-evidence-merge-design.md)

## Purpose

73m fixes the first half of the 73h carrier problem: `carrier_to_x` becomes a real composed runtime object rather than a stale path-scalar mixture. This plan fixes the second half: evidence that describes `A -> X` arrivals must bind to `carrier_to_x` under an explicit statistical contract. For this plan to count as carrier evidence-conditioning closure, that contract must cover both arrival timing and carrier reach/probability.

The goal is not to rebuild the whole conditioned forecast system. The goal is to add a principled carrier-conditioning layer on top of the corrected carrier object, so the runtime can say exactly:

- what evidence was admitted for `carrier_to_x`;
- whether that evidence moved carrier timing, reach/probability, both, or neither;
- how that conditioning interacts with subject-side conditioning;
- how projection reads the conditioned object without re-deciding semantics.

73h should not be considered fully closed until both 73m and this plan are addressed. For active `cohort(A != X)`, that means carrier and subject evidence are conditioned together in one joint particle state and one joint likelihood. This plan has no alternate carrier-conditioning implementation branch.

## Non-goals

This plan does not alter the meaning of the displayed rate. It remains `Y / X`.

It does not allow anchor-rooted whole-query numerator evidence to become subject evidence. Evidence for `A -> X` conditions `carrier_to_x`; evidence for `X -> end` conditions `subject_span` or subject rate. Whatever subject evidence is admitted by the typed subject evidence roles must be consumed inside the joint carrier-plus-subject likelihood for active `cohort(A != X)`, not in a separate subject-only pass.

It does not promote a gross-fitted whole-query numerator representation.

It does not solve 73l projection parity.

It does not require or design a pass-local topological carrier-state cache. Reusing conditioned carrier states across a whole-graph CF traversal is an obvious performance and maintainability improvement, but it is separable from this plan's correctness requirement. That cache should be specified separately, for example as `73o`, and its first acceptance criterion should be numerical parity with the uncached path.

## Core distinction

Carrier composition and carrier conditioning are different.

Carrier composition answers: given resolved per-edge priors and topology, what is the prior arrival distribution from `A` to `X`?

Carrier conditioning answers: given observed arrivals at `X` for the selected population, how should the carrier prior be updated or selected? The conditioned carrier object has two separable but related parts:

- reach/probability: eventual probability of arriving at `X`;
- timing: conditional distribution of arrival age, given eventual arrival at `X`.

The current system partially conditions carrier timing through empirical Tier 2 shape construction, but that is not the same statistical operation as subject-side IS conditioning, and it does not infer carrier reach. This plan replaces the implicit tier flip with one joint conditioning path over carrier reach, carrier timing, subject-span probability, and subject-span timing.

## Evidence role contract

Introduce an explicit carrier evidence role in the shared evidence model:

- role: `carrier_to_x_arrivals`;
- object conditioned: `carrier_to_x`;
- semantic question: for population rooted at `A`, who has arrived at denominator node `X` by age `tau`?
- admissible raw evidence family: observed `A -> X` arrivals on the anchor clock for the same selected population, date bounds, context, regime, and as-at boundary;
- forbidden evidence family: subject-end `Y` or `Z` observations, terminal-edge rows, and whole-query numerator rows unless separately admitted as exact carrier-arrival observations.

This role is distinct from:

- `window_subject_helper`, which conditions an `X -> end` subject helper;
- `direct_cohort_exact_subject`, which may condition subject rate for exact single-hop cohort subjects;
- Bayes Phase 1 and Phase 2 roles, which serve model fitting rather than live CF carrier conditioning.

For this plan, carrier evidence conditions the **whole `A -> X` carrier object** unless the evidence candidate explicitly carries a reviewed path identity. Edge-local rows for a terminal upstream edge are not automatically whole-carrier evidence in fan-in or multi-path topologies. If attribution to a specific path is missing, the candidate may only be admitted to the whole-carrier role when the adapter can prove the observation was generated by the same full `A -> X` selector as the runtime object.

## Carrier observation-shape taxonomy

Before conditioning consumes evidence, every admitted carrier candidate must declare its observation shape. Counts alone are not enough.

Supported observation shapes are:

- `single_frontier_cumulative`: one observation at age `tau`, with `x_tau` arrivals at `X` out of the selected `A` population by that age;
- `trajectory_cumulative`: multiple cumulative observations for the same cohort day at multiple ages;
- `daily_increment`: arrivals into `X` during one age/day bin rather than cumulative arrivals by that age;
- `exact_member_arrival`: member-level or hash-level arrival facts that can be aggregated without cumulative double-counting.

`reconstructed_asat` is not a separate likelihood family. It is a provenance flag describing how evidence was materialised. The underlying observation shape remains one of the four shapes above, and the adapter must preserve that original shape.

Each shape has different likelihood and dedupe rules. In particular, cumulative rows at multiple ages for the same cohort day must not be treated as independent `single_frontier_cumulative` observations. They either become a trajectory likelihood or must be reduced to one explicitly chosen frontier observation with provenance.

If an adapter cannot classify the shape, the candidate is rejected as `unknown_carrier_observation_shape`.

The first implementation admits only `single_frontier_cumulative` and `trajectory_cumulative` carrier evidence. `daily_increment` and `exact_member_arrival` must be represented in the schema and rejected with explicit skip reasons until their adapters and likelihoods are implemented. This prevents a caller from silently treating increments or member facts as cumulative frontier counts.

## First implementation constants

This implementation fixes the following modelling choices so agents do not invent them while coding.

Carrier reach prior:

- family: Beta;
- mean: 73m `topological_reach_prior`, clipped to `[1e-6, 1 - 1e-6]` only for numerical stability;
- concentration: `carrier_reach_prior_strength = 50`;
- parameters: `alpha = mean * carrier_reach_prior_strength`, `beta = (1 - mean) * carrier_reach_prior_strength`;
- support: open interval `(0, 1)` numerically clipped at likelihood boundaries, with non-zero density across the plausible posterior region;
- posterior summary: mean, median, central interval, and effective sample size from the resampled reach particles;
- diagnostic fields: prior mean, prior strength, posterior mean, posterior median, posterior interval, and whether admitted carrier evidence moved the posterior mean by more than the test threshold.

This fixed prior strength is intentionally explicit rather than claimed optimal. If later calibration changes it, that change needs its own test update and decision note. Stage 5 must not choose a new strength opportunistically to satisfy a fixture. The prior must not assign zero probability to plausible posterior regions; tests must include a case where evidence materially above the topological prior can still move reach upward rather than being effectively truncated by the prior.

Carrier timing prior:

- source: 73m composed conditional carrier CDF draw family;
- meaning: conditional on eventual arrival at `X`;
- identity carrier: Dirac-at-zero timing with reach one;
- finite horizon: inherits 73m's horizon adequacy diagnostics.

Subject prior:

- probability and timing come from the prepared `subject_span` draw family already used by the current subject-side IS path;
- multi-hop subject probability is span-level `p_XE`, not terminal-edge probability.

## Carrier evidence source contract

The first implementation may admit carrier evidence only when the source can prove a whole-carrier `A -> X` observation.

Valid first implementation sources:

- snapshot or reconstructed rows whose row semantics explicitly provide anchor population `a`, denominator arrivals `x`, anchor node `A`, denominator node `X`, observation age/date on the anchor clock, selected date bounds, context/regime identity, and as-at boundary for the same runtime request;
- file-backed rows only when their slice metadata proves the same whole `A -> X` selector and carries `a` and `x` counts for denominator arrival, not subject-end `y`.

Invalid first implementation sources:

- target-edge `_bayes_evidence` rows that only describe `X -> end` subject evidence;
- terminal upstream edge rows used as if they were whole `A -> X` carrier evidence;
- fan-in or multi-path rows without whole-carrier selector proof;
- rows that expose only `n/k` for subject conversion and do not expose `a/x` carrier-arrival counts.

If no current data structure can prove whole-carrier scope for a query, the implementation must reject carrier evidence for that query and report `missing_whole_carrier_scope_proof`. It must not fall back to edge-local carrier evidence.

Carrier evidence is not admitted for degenerate carriers. In `window()` and `cohort(A = X)`, the runtime carrier is identity reach one with Dirac-at-zero timing; any candidate claiming to condition `carrier_to_x` must be rejected as `identity_carrier_has_no_arrival_solve` or recorded as an explicit no-op diagnostic. It must not alter the identity carrier.

## Carrier evidence identity model

Do not shoehorn carrier evidence into the current subject-shaped `EvidenceIdentity(subject_from, subject_to)` contract.

Stage 2 must add a carrier-specific identity path. The implementation may do this by adding a parallel `CarrierEvidenceIdentity`/`CarrierEvidenceScope`, or by generalising `EvidenceIdentity` into a tagged union. In either case, carrier evidence identity must name carrier fields directly:

- role `carrier_to_x_arrivals`;
- population root or anchor node `A`;
- denominator node `X`;
- mode and time origin;
- selected cohort date bounds and anchor-day set;
- selected population identity or selector hash;
- population identity kind, distinguishing exact-member identity from selector-only identity;
- carrier scope, either whole `A -> X` or explicit path identity;
- context, case, regime, hash family, and as-at boundary;
- observation shape;
- weighting or aggregation procedure;
- source semantic role.

The subject fields `subject_from` and `subject_to` must not be reused as ambiguous aliases for carrier root and denominator. Adapter and merge tests must fail if a carrier candidate can be constructed without the carrier identity fields above.

Exact-member population identity is preferred. Selector-only identity is admissible only when mode, anchor, denominator, date bounds, anchor-day set, context, regime, as-at boundary, temporal basis, weighting or aggregation procedure, and selector hash all match exactly; provenance must label it as selector-only so reviewers can distinguish it from exact-member evidence.

## Current implementation gap

The current CF sweep already has the right *subject-side* pattern for `window()` and identity-carrier cases. In `forecast_state.compute_forecast_trajectory`, the aggregate IS step builds a likelihood from subject evidence, computes one set of weights, and reindexes `p_draws`, `cdf_arr`, `upstream_cdf_mc`, and `edge_cdf_arr` with the same sampled indices. That means subject probability and subject timing can move together as one particle family.

The active `cohort(A != X)` path is not equivalent. The upstream carrier enters the sweep as `from_node_arrival.reach` plus `upstream_cdf_mc`. Reach is a scalar, carrier timing is not likelihood-conditioned by carrier-arrival evidence, and the subject evidence likelihood is still assembled from subject `(n, k, tau)` only. The projection later combines subject draws with carrier arrays, but the carrier was not part of the posterior that produced those subject draws.

That is the implementation defect this plan fixes. The repair is not a new policy layer. It is a concrete refactor of the existing aggregate IS path so active cohort solves use the same one-posterior discipline that already exists for subject-side window solves.

## Target implementation shape

For active `cohort(A != X)`, the runtime constructs one joint particle state:

- `carrier_reach_draws`: eventual probability of reaching denominator node `X`;
- `carrier_cdf_arr`: conditional arrival CDF for `A -> X`, given eventual arrival;
- `subject_p_draws`: span-level subject probability for `X -> end`;
- `subject_cdf_arr`: span-level subject timing CDF for `X -> end`;
- `edge_cdf_arr`: terminal-edge timing helper where projection genuinely needs Pop D edge-local timing.

The same joint draw index must refer to one coherent carrier-plus-subject world. Carrier evidence and subject evidence contribute terms to one joint log-likelihood. The implementation then performs one ESS-targeted tempering decision and one resample of every array in the joint state.

`window()` and `cohort(A = X)` are natural degeneracies. The carrier state is reach one and Dirac-at-zero timing, so the existing subject-side IS behaviour is preserved.

## Mathematical invariants

Carrier evidence may move the distribution of arrival time at `X` and may move the eventual probability of arriving at `X`. It must not move the subject rate directly.

The carrier object must distinguish:

- `topological_reach_prior`: graph-composed prior reach before scoped carrier evidence;
- `conditioned_reach_posterior`: posterior summary after admitted carrier evidence;
- `conditional_timing_cdf`: arrival-time CDF conditional on eventual arrival at `X`;
- provenance saying whether carrier evidence moved reach, timing, both, or neither.

Carrier-side likelihoods put reach and timing in the success-probability slot. For a `single_frontier_cumulative` observation with selected anchor population `A_i`, observed arrivals `x_i`, carrier reach draw `r_s`, and conditional carrier CDF `C_AX,s(tau_i)`, the likelihood is `x_i ~ Binomial(A_i, r_s * C_AX,s(tau_i))`. The trial count is the selected anchor population. Implementations must not substitute `Binomial(A_i * r_s, C_AX,s(tau_i))`.

For `trajectory_cumulative`, one cohort day with cumulative observations at increasing ages `tau_1 < ... < tau_m` must be treated as one trajectory, not `m` independent frontier rows. For draw `s`, define `q_j,s = r_s * C_AX,s(tau_j)`. The likelihood is a product of conditional binomials over increments: `x_1 ~ Binomial(A_i, q_1,s)` and, for `j > 1`, `x_j - x_{j-1} ~ Binomial(A_i - x_{j-1}, (q_j,s - q_{j-1,s}) / (1 - q_{j-1,s}))`, with clipping only for numerical stability and monotonicity validation before likelihood evaluation. If cumulative counts are non-monotone, the trajectory is rejected as `non_monotone_carrier_trajectory`.

For `daily_increment`, the first implementation rejects the candidate as `unsupported_carrier_observation_shape_daily_increment`. A future implementation must define increment-bin likelihoods before admitting it.

For `exact_member_arrival`, the first implementation rejects the candidate as `unsupported_carrier_observation_shape_exact_member_arrival`. A future implementation must define member-level or aggregated arrival-time likelihoods before admitting it.

Subject-side likelihoods use the same maturity-aware form as the current aggregate IS path, but their completeness source must be the typed subject/path completeness object from 73m. For active cohort evidence on the anchor clock, the subject likelihood must use the joint carrier-plus-subject path completeness for the evidence denominator, not subject-span CDF alone.

For subject evidence whose trial count is already denominator-at-`X` mass, the likelihood remains `k_i ~ Binomial(n_i, p_XE,s * C_XE,s(tau_i))`, where `n_i` is denominator-at-`X` evidence, `p_XE,s` is the subject-span probability draw, and `C_XE,s` is the subject-span timing draw on the `X` clock.

For subject evidence whose trial count is anchor-population mass, the likelihood is `k_i ~ Binomial(A_i, r_s * C_AX_to_E,s(tau_i))`, where `C_AX_to_E,s(tau)` is the joint carrier-arrival and subject-progression completion probability for draw `s`, including subject probability exactly once. Equivalently, `r_s` and carrier timing enter through the carrier-to-subject convolution, not as a second multiplier on a displayed `Y / X` rate. The implementation must name the evidence denominator before choosing one of these formulas.

The active-cohort path-completeness term is a discrete convolution over the same tau grid as the projection. For draw `s`, with carrier conditional arrival increments `dC_AX,s(u)` and subject conditional timing CDF `C_XE,s(v)`, the joint success probability by anchor age `tau` is `r_s * p_XE,s * sum_{u=0..tau} dC_AX,s(u) * C_XE,s(tau - u)`. This is the only active-carrier subject-completeness form for anchor-population evidence. Multiplying CDFs at the same tau, dropping subject timing, or replacing the carrier with a point lag is wrong except in the corresponding degenerate fixture where those forms are mathematically identical.

Projection multiplies conditioned reach by conditional carrier timing when it needs absolute denominator mass. Projection must not multiply displayed subject rates by reach as a fake correction.

## Implementation surface map

The implementation touches these surfaces:

- `graph-editor/lib/evidence_merge.py`: add the carrier evidence role and identity validation.
- `graph-editor/lib/runner/evidence_adapters.py`: add adapters that emit carrier-arrival candidates from snapshot, file-backed, and reconstructed rows.
- `graph-editor/lib/runner/forecast_runtime.py`: extend `PreparedForecastRuntimeBundle`, `PreparedCarrierToX`, and `PreparedForecastSolveInputs` so runtime preparation carries carrier evidence and joint-state inputs beside subject evidence.
- `graph-editor/lib/runner/forecast_state.py`: introduce a joint particle state and replace the subject-only aggregate IS block in `compute_forecast_trajectory`.
- `graph-editor/lib/runner/cohort_forecast_v3.py`: pass the prepared joint runtime inputs through the v3 row builder and expose diagnostics.
- `graph-editor/lib/api_handlers.py`: ensure conditioned_forecast and cohort_maturity entry points call the same prepared runtime path and return provenance.
- `graph-editor/lib/tests/test_cohort_factorised_outside_in.py` and focused unit tests near `test_forecast_state_cohort.py`: prove the new contract through public and lower-level surfaces.

## Stage 0 — Baseline current behaviour

Stage 0 records the current implementation shape before changing code.

Required trace:

- identify the current aggregate IS block in `forecast_state.compute_forecast_trajectory`;
- record which arrays are currently reindexed together after subject evidence weighting;
- record that `from_node_arrival.reach` is scalar and not conditioned by carrier evidence;
- record how `upstream_cdf_mc` is built and where it is currently reindexed;
- record which evidence role `_resolve_evidence_role` selects for `window()`, exact single-hop cohort, and multi-hop cohort;
- record which public tests currently demonstrate anchor-depth or carrier-conditioning drift.

Stop condition: a short implementation note identifies the exact current code lines to replace or extend, and classifies the relevant tests as expected-red, expected-green, or new.

## Stage 1 — Define joint particle state

Stage 1 adds a small runtime representation for the joint state before changing the likelihood.

The state must carry:

- subject probability draws, currently `p_draws`;
- subject timing draws, currently `cdf_arr`;
- optional edge-local timing helper, currently `edge_cdf_arr`;
- carrier reach draws, new;
- carrier timing draws, currently `upstream_cdf_mc` when present;
- unconditioned copies of the same fields for doc-52 blending and diagnostics;
- provenance linking each field to its prior source and evidence role.

The implementation should not duplicate the entire trajectory engine. It should wrap the existing arrays that `compute_forecast_trajectory` already constructs, then add the missing carrier reach dimension and provenance. The unconditioned copies are required for the existing doc-52 subset-conditioning blend, which mixes conditioned and unconditioned draw families to avoid double-counting selected Cohorts already represented in the aggregate training mass.

`edge_cdf_arr` is not a subject-span substitute. It may be read only by the Pop D edge-local residual projection where the member is already at the terminal edge's from-node. The subject likelihood, active-cohort path completeness, Pop C projection, and multi-hop model curve must read the prepared subject-span CDF, not `edge_cdf_arr`.

For identity carriers, `carrier_reach_draws` is all ones and `carrier_cdf_arr` is a Dirac/identity matrix. For inactive carriers, the joint state degenerates to the existing subject state.

Stop condition: unit tests can instantiate the joint state for window, `A = X`, and active `cohort(A != X)` and verify shape alignment across all arrays.

## Stage 2 — Add carrier evidence identity and merge support

Stage 2 extends the shared evidence layer with `carrier_to_x_arrivals` and a carrier-specific identity path. The current `EvidenceIdentity(subject_from, subject_to)` shape is not sufficient for carrier evidence and must not be reused by aliasing subject fields.

The role identity must include:

- mode and time origin;
- anchor node and population root;
- denominator node `X`;
- selected cohort date bounds and anchor-day set;
- selected population identity or selector hash;
- population identity kind, exact-member or selector-only;
- context, case, regime, and hash-family identity;
- as-at boundary;
- temporal evidence basis on the carrier clock;
- weighting or aggregation procedure;
- observation shape;
- carrier scope, either whole `A -> X` or explicit reviewed path identity;
- source semantic role so subject or numerator rows can be rejected.

The merge output must expose carrier evidence totals, included observations, skipped observations, source totals, shape counts, carrier scope, and provenance.

Stop condition: pure merge tests prove carrier evidence is admitted only for matching `A -> X` and rejected for subject-end evidence, wrong clock, wrong population, wrong population identity kind, wrong weighting or aggregation procedure, wrong carrier scope, identity-carrier mode, unknown observation shape, daily increments, exact-member rows, and edge-local rows in fan-in or multi-path carriers without a valid whole-carrier selector. Tests must also prove carrier identity cannot be constructed with only subject-shaped `subject_from`/`subject_to` fields.

## Stage 3 — Add carrier evidence adapters

Stage 3 adds thin adapters in `evidence_adapters.py` for carrier-arrival evidence.

Adapters must convert existing snapshot, file-backed, and reconstructed-as-at rows into carrier candidates only when the source contract above is met. They may understand current row shapes, but they must not make the final admission decision and must not sum evidence outside `merge_evidence_candidates`.

Each carrier candidate must carry:

- source kind;
- anchor identity;
- denominator node `X`;
- observed age or observed date on the carrier clock;
- retrieved-at or as-at materialisation marker;
- context and regime identity;
- selected population identity or selector hash;
- population identity kind;
- counts representing arrival at `X` out of the selected anchor population;
- observation shape and trajectory grouping metadata;
- carrier scope proof;
- weighting or aggregation procedure;
- source semantic role.

Stop condition: adapter tests prove that `Y` or `Z` rows cannot become carrier evidence, target-edge `_bayes_evidence` subject rows are rejected as carrier evidence, whole-carrier `a/x` rows are admitted when scope proof is present, and cumulative multi-age rows for one cohort day are grouped or reduced rather than treated as independent frontier observations.

## Stage 4 — Prepare carrier and subject evidence together

Stage 4 extends `forecast_runtime.prepare_forecast_runtime_inputs`.

Preparation must now produce, for one forecast subject:

- 73m `carrier_to_x` prior object with topological reach prior and conditional timing draws;
- carrier evidence set for `carrier_to_x`;
- subject-span object and subject evidence set or existing `p_conditioning_evidence`;
- joint particle-state configuration;
- provenance for both evidence roles.

The runtime bundle must keep carrier evidence separate from `p_conditioning_evidence`; it must not overload the subject evidence object with carrier fields.

The current subject evidence extras path can remain temporarily for subject evidence, but carrier evidence must not be represented as anonymous `(age, n, k)` tuples by the time it reaches the joint likelihood assembler. It needs role, denominator, observation shape, and carrier scope.

Stop condition: diagnostics for a cohort query show carrier evidence and subject evidence side by side, with different roles and clocks, show the carrier topological reach prior before conditioning, and show `missing_whole_carrier_scope_proof` rather than silently admitting edge-local evidence when the source cannot prove whole-carrier scope.

## Stage 5 — Build carrier reach draws

Stage 5 turns 73m's topological reach into a particle dimension.

For the first implementation, the reach prior is the fixed Beta contract above: mean equal to 73m `topological_reach_prior`, concentration `carrier_reach_prior_strength = 50`, and support `[0, 1]`. A scalar repeated across all particles is not sufficient once admitted carrier evidence exists, because it cannot condition reach.

The draw count and random seed handling must align with the existing trajectory draw count so one joint index covers carrier and subject arrays.

Stop condition: tests prove that carrier reach draws exist for active `cohort(A != X)`, degenerate to one for `window()` and `A = X`, and can move after carrier likelihood weighting.

## Stage 6 — Replace subject-only IS with joint likelihood assembly

Stage 6 replaces the current subject-only aggregate IS block in `forecast_state.compute_forecast_trajectory`.

The new path should be structured as small internal helpers:

- build the joint prior particle state from existing subject arrays plus carrier arrays;
- convert subject evidence into subject likelihood terms;
- convert carrier evidence into carrier likelihood terms;
- compute subject/path completeness per draw using the same joint carrier and subject draw when the evidence denominator requires carrier-to-subject path completeness;
- choose the subject likelihood formula based on whether the evidence denominator is denominator-at-`X` mass or anchor-population mass;
- sum all likelihood terms into one `log_lik`;
- run one ESS-targeted tempering search;
- resample every joint state array with the same indices.

The current window behaviour is the parity oracle. With identity carrier inputs and no carrier evidence, the new helper must reproduce the existing subject-only IS result within the existing stochastic tolerance.

The ESS target remains the existing aggregate-IS target for the first implementation. The helper must expose pre-temper ESS, selected tempering lambda, post-temper ESS, and whether the full-strength likelihood was accepted. If no lambda can satisfy the ESS target, the solve must report an explicit tempering failure or controlled degraded mode; it must not silently resample a single-particle posterior as if healthy.

Stop condition: focused tests prove that one resample reindexes subject probability, subject timing, carrier reach, carrier timing, and edge-local timing together. Tests must fail if carrier and subject arrays are resampled independently. A carrier-evidence-only test must also prove that carrier likelihood terms affect `log_lik`: with subject evidence absent or degenerate, informative carrier evidence must move the reach posterior. This catches the current bug shape where subject-only weights are applied to jointly reindexed arrays.

## Stage 7 — Update population projection

Stage 7 updates projection after the joint state exists.

`_evaluate_cohort` and any equivalent projection helper must consume conditioned carrier reach per draw, not a scalar `reach`, when active carrier evidence is present. Pop C denominator mass should use `a_pop * carrier_reach_draws[:, None] * carrier_cdf_arr`. Pop C numerator mass should convolve carrier arrivals with the subject-span timing draw from the same particle and multiply by the subject probability draw from the same particle.

Projection must continue to preserve `Y / X` semantics. Reach affects counts, denominator arrival, Pop C mass, and path completeness; it must not be applied as an extra multiplier on displayed subject rates.

The carrier/subject convolution must run on the 73m-validated tau horizon. Horizon adequacy for both carrier and subject CDFs is a precondition for this stage; if either side fails the 73m horizon thresholds, projection must surface the diagnostic rather than silently compressing the tail into the displayed window.

Stop condition: projection tests prove conditioned reach affects count fields and path completeness, while displayed rates remain `Y / X` and do not become `Y / A`.

## Stage 8 — Cross-surface provenance

Stage 8 exposes compact provenance wherever CF diagnostics already expose subject-conditioning provenance.

The response-visible provenance should identify:

- carrier evidence role;
- subject evidence role;
- raw carrier evidence totals and raw subject evidence totals;
- skipped counts by reason;
- observation-shape counts;
- topological reach prior;
- conditioned reach posterior summary;
- carrier timing prior and conditioned timing summary;
- subject probability and timing posterior summary;
- ESS, tempering lambda, and resample count;
- draw-coupling rule;
- evidence denominator used by subject/path completeness likelihood;
- as-at boundary and scenario scope.

Stop condition: a CF response or diagnostic payload can explain both carrier and subject evidence binding without reading logs.

## Stage 9 — Acceptance tests

Required tests:

- existing window subject-conditioning parity: identity carrier reproduces current subject-only IS behaviour;
- active single-hop cohort: carrier reach, carrier timing, subject probability, and subject timing are jointly sampled and jointly resampled;
- active multi-hop cohort: subject span is `X -> end`, not terminal-edge-only, and carrier/path completeness uses the same joint particle;
- internal guard: multi-hop subject likelihood and Pop C projection fail if they read `edge_cdf_arr` instead of the prepared subject-span CDF;
- near-saturation carrier evidence below topological reach moves conditioned reach down;
- near-saturation carrier evidence above topological reach moves conditioned reach up subject to support and caps;
- high-prior-conflict case: evidence far above topological reach still moves posterior upward, proving the Beta prior does not effectively truncate plausible reach;
- early carrier evidence shares uncertainty between reach and timing rather than forcing a deterministic reach update;
- sparse single-observation carrier evidence produces a non-degenerate posterior and visible ESS/tempering provenance;
- realistic strong-evidence carrier case preserves post-temper ESS above the target or reports an explicit controlled failure;
- trajectory cumulative carrier evidence is handled as one trajectory likelihood and rejects non-monotone cumulative counts;
- daily increment and exact-member carrier shapes are rejected with explicit unsupported-shape reasons in the first implementation;
- target-edge `_bayes_evidence` subject rows cannot be used as whole-carrier evidence;
- degenerate carrier modes (`window()` and `A = X`) reject or no-op carrier evidence with explicit provenance and do not alter the identity carrier;
- carrier-arrival evidence alone does not directly move subject `p`;
- subject-end evidence cannot enter the carrier role;
- carrier-arrival evidence cannot enter subject-rate conditioning;
- active cohort subject evidence with denominator-at-`X` mass uses the subject-span likelihood without reintroducing carrier reach;
- active cohort subject evidence with anchor-population mass uses joint carrier-plus-subject path completeness;
- active cohort anchor-population subject likelihood matches the discrete carrier/subject convolution on a small analytic fixture;
- fan-in or multi-path carrier rejects edge-local evidence unless whole-carrier scope is proven;
- selector-only population identity is labelled in provenance and rejected unless selector, date bounds, anchor-day set, temporal basis, weighting or aggregation procedure, context, regime, and as-at all match;
- cumulative multi-age evidence is not double-counted as independent frontier observations;
- `window()` and `A = X` remain identity-carrier degeneracies;
- cached and uncached carrier-state paths remain equivalent once 73o is implemented, but 73o is not required for these tests.

Regression discipline for `test_cohort_factorised_outside_in.py` is strict. This plan may only move tests in the documented direction, must not xfail or skip existing passing tests, and must not relax assertions to hide changed semantics.

Stop condition: all required focused tests pass, and any outside-in expectation change names the carrier evidence role, observation shape, joint conditioning contract, and projection object that justify it.

## Stage 10 — Closure criteria for 73h Issue 2

73h Issue 2 can be called closed only when:

- `carrier_to_x` is composed by 73m and jointly conditioned here with reach and timing;
- `subject_span` and subject rate are jointly conditioned with carrier state where the evidence denominator requires path completeness;
- evidence roles are typed and auditable;
- projection reads the joint conditioned state without choosing semantics again;
- legacy Tier 2 dispatcher paths are retired or routed through typed carrier evidence adapters;
- diagnostics expose enough provenance to explain which evidence conditioned which object.

## Separate performance follow-up

This plan does not require a pass-local topological carrier-state cache for correctness. An implementation can satisfy the reach-conditioning tests by recomputing carrier objects from first principles, provided the recomputed object carries the correct conditioned reach and timing semantics.

A separate follow-up, tentatively `73o`, specifies topological carrier-state caching as a performance and maintainability improvement. That plan should cache scenario/query-scoped conditioned carrier or node-arrival states, prove cached and uncached projections are numerically equivalent, and only then optimise repeated carrier composition across whole-graph CF traversals.

Subject evidence typing is still asymmetric after this plan if subject evidence continues to flow through legacy extras while carrier evidence uses carrier-specific typed identities. That asymmetry is allowed only as a temporary migration state. A follow-up must either route subject evidence through an equally typed identity model or delete the legacy subject extras once all live callers consume typed subject evidence sets directly.

## Review checklist

Reviewers should reject an implementation if:

- it leaves carrier reach fixed while claiming carrier conditioning closure;
- it conditions carrier timing outside the joint posterior;
- it performs separate carrier and subject resamples for active `cohort(A != X)`;
- carrier and subject particles are paired by reused indices after separate resampling;
- carrier evidence is represented as loose tuples without role identity;
- subject-end evidence can enter the carrier role;
- carrier-arrival evidence can enter subject-rate conditioning;
- cumulative carrier rows are double-counted as independent observations;
- edge-local rows are admitted as whole-carrier evidence in fan-in or multi-path carriers without proof;
- evidence with the wrong mode, temporal basis, as-at boundary, context, regime, or selected population is admitted;
- evidence with the wrong weighting or aggregation procedure is admitted;
- selector-only population identity is treated as exact-member identity;
- conditioned reach is not represented separately from topological reach prior;
- reach prior concentration differs from `carrier_reach_prior_strength = 50` without a reviewed calibration update and test change;
- carrier evidence in `window()` or `A = X` changes the identity carrier;
- active-cohort path completeness uses multiplied CDFs, a point-lag approximation, or subject-span CDF alone instead of the carrier/subject convolution;
- multi-hop subject likelihood or Pop C projection reads `edge_cdf_arr` as the subject-span timing source;
- ESS collapse is hidden rather than exposed through tempering diagnostics;
- projection multiplies displayed rates by reach;
- projection recomputes topological reach after a reach posterior has been conditioned;
- `window()` or `A = X` stops degenerating to identity carrier semantics;
- diagnostics cannot explain which evidence conditioned which object.
