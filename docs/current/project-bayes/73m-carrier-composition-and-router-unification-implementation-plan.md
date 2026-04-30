# 73m — Phase 1 carrier composition and v3 router unification implementation plan

**Status**: Implementation plan, pending review  
**Date opened**: 30-Apr-26  
**Parent problem statements**: [`73h-v3-router-and-carrier-conditioning-forensic.md`](73h-v3-router-and-carrier-conditioning-forensic.md), [`73g-general-purpose-f14-problem-and-invariants.md`](73g-general-purpose-f14-problem-and-invariants.md)  
**Semantic source of truth**: [`docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md)  
**Required Phase 2**: [`73n-carrier-evidence-conditioning-implementation-plan.md`](73n-carrier-evidence-conditioning-implementation-plan.md)  
**Related but separate**: [`73i-shared-evidence-merge-design.md`](73i-shared-evidence-merge-design.md), [`73l-cli-completeness-parity-canary-drift.md`](73l-cli-completeness-parity-canary-drift.md), [`cohort-maturity-v3-midline-collapse-investigation.md`](../cohort-maturity-v3-midline-collapse-investigation.md)

## Purpose

This plan turns the first half of the 73h forensic findings into a bounded implementation sequence. It is deliberately narrower than the full semantic architecture in the cohort/window semantics note and narrower than the full 73g F14 programme.

The goal is to repair the current carrier-composition and v3 router defects without rebuilding the conditioned forecast system. The work makes the existing CF/v3 path obey the already-agreed object model:

- `carrier_to_x` is the denominator-side object for `A -> X`.
- `subject_span` is the numerator-side object for `X -> end`.
- The displayed rate is `Y / X`, not `Y / A`.
- Single-hop, multi-hop, `window()`, `cohort()`, `A = X`, and non-latency edges must differ by natural degeneration of these same objects.

This plan is **Phase 1**. It can close the carrier-composition and top-level router defects. It cannot, by itself, close the full 73h Issue 2 evidence-conditioning finding or all of 73g invariant 6. Full closure requires Phase 2 (`73n`) or an explicit decision record accepting a deliberately partial carrier-conditioning policy.

73h Issue 2 has two separable surfaces. The first is carrier composition: the enabled gate, the three carrier-construction writers, and the pattern where a composed kernel is prepared but discarded by a downstream branch. This Phase 1 plan closes that surface. The second is carrier evidence-conditioning: Tier-flip discontinuity and the absence of carrier-side IS or an equivalent typed conditioning policy. That surface belongs to Phase 2 (`73n`).

## Non-goals

This plan does not redesign the whole CF pass.

It does not implement full carrier-side importance-sampling conditioning. 73h correctly identifies that carrier and subject evidence-conditioning are not yet unified. This plan fixes carrier composition and the v3 router first. The remaining carrier-conditioning question is not optional cleanup; it is Phase 2 and is tracked in `73n`.

It does not address the 73l CLI completeness parity failures. Those are projection and response-mapping defects under 73g invariant 7.

It does not claim to fix the residual midline-saturation hierarchy defect unless the instrumentation from the midline-collapse investigation proves that the staged repairs close it.

It does not introduce gross-fitted whole-query numerators or widen the direct-cohort `p` conditioning seam beyond the current explicit admission rules.

## Core design contract

The implementation must keep six quantities distinct.

`population_root` defines the selected population and time origin. In `window()` it is `X`. In `cohort()` it is `A`.

`carrier_to_x` maps the selected population into arrivals at `X`. It has an eventual reach and a conditional arrival-time CDF. Reach scales denominator mass and absolute counts. It must not be treated as an extra multiplier on the displayed `Y / X` rate.

`subject_span` maps mass already at `X` into arrival at the subject end. It owns both the subject probability and the conditional subject timing CDF. In single-hop it degenerates to `X -> Y`. In multi-hop it remains the full `X -> Z` span, including span-level `p_XE`; it must not silently become the terminal edge's probability or timing object.

`path_completeness` is the evidence-facing completion object for an active factorised cohort. It combines the carrier arrival timing and subject progression timing on the observation clock used by the evidence. For `cohort(A != X)`, it is derived from `carrier_to_x` and `subject_span`; for `window()` and `A = X`, it degenerates to the subject-span completeness on the `X` clock. It is not a new semantic numerator representation and must not hide reach or subject probability inside an unnamed scalar.

`p_conditioning_evidence` states which evidence family is allowed to move the subject rate. It is not a carrier selector and must not retarget `carrier_to_x` or `subject_span`.

`projection` reads the resolved runtime object into rows, CF scalars, and graph fields. Projection must not reconstruct carrier or subject semantics.

## Mathematical invariants

For a factorised cohort query with population rooted at `A`, denominator node `X`, subject end `E`, carrier reach `r`, carrier conditional CDF `C_AX(t)`, subject probability `p_XE`, and subject conditional CDF `C_XE(t)`, absolute counts may depend on reach:

- denominator mass at `X` is governed by `A * r * C_AX(t)`;
- numerator mass is governed by carrier arrivals convolved with subject progression.

But the displayed rate remains `Y / X`. In the all-non-latency carrier case where `C_AX(t)` is a Dirac-at-zero shape, reach changes denominator mass and absolute numerator mass by the same factor. It must cancel out of the displayed subject rate.

Any IS likelihood or evidence-completeness calculation must name which denominator its evidence count uses before selecting a completeness curve. If the evidence trial count is anchor-population mass, carrier reach and carrier timing enter the success-probability slot on the anchor clock. If the evidence trial count is already denominator-at-`X` mass, the likelihood must use the corresponding `X`-denominated subject/path completeness and must not reintroduce carrier reach as a second subject-rate multiplier. This rule prevents `path_completeness` from becoming a covert `Y / A` rate.

Therefore acceptance tests must distinguish count curves from rate curves. A test may assert that cohort `evidence_x` differs from window because reach is less than one. It must not assert that the displayed `model_midpoint` or `p_infinity_mean` is simply `reach × window`.

The carrier CDF stored on runtime objects is conditional on reaching `X`. It should saturate to one over a sufficiently large horizon. Reach remains a separate scalar. Any consumer that needs joint mass must multiply reach once and only once.

Finite-horizon carrier normalisation is allowed only when the horizon captures essentially all topological reach. For synthetic/unit fixtures, `K[max_tau] / reach` must be at least `0.99` whenever reach is positive and the topology is expected to saturate inside the test horizon. The `0.99` threshold is a near-saturation contract: it allows small discretisation and tail error while forbidding a visibly horizon-shaped carrier. For live diagnostic paths, any ratio below `0.99` must be reported as a carrier-horizon warning with enough scope metadata to reproduce the case; any ratio below `0.95` is a blocking failure for this implementation plan until the horizon rule is revised. The `0.95` floor is deliberately conservative: losing more than five percent of eventual reach at the carrier horizon is too large to normalise away without changing count timing. The implementation must not silently compress a long tail into the display window.

The non-latency degeneration must be mathematically continuous with the latency path. In the `sigma_eff = 0` limit, the prepared span CDF is a Dirac/identity timing object, the trajectory path still reads the same resolved span probability object, and evidence update/blend semantics must remain equivalent to the closed-form Beta-Binomial answer within the explicit tolerance chosen for MC approximation. Removing the router is not sufficient unless this limit is proven.

## Stage 0 — Confirmation and test classification

Stage 0 makes the current target explicit before any production changes.

Classify the relevant `test_cohort_factorised_outside_in.py` cases into three groups:

- in scope and expected to close: the two terminal-non-latency router canaries, the two single-hop non-latent upstream cases, and the single-hop anchor-override carrier-completeness case;
- in scope only as an observed side effect: the midline-saturation case;
- out of scope: the 73l projection/completeness parity cases.

Record the current expected-red tests and the exact field each one asserts: rate, count, completeness, or provenance. Any test whose assertion conflates reach-scaled counts with displayed rate must be reworded before the implementation begins.

Also run a read-only call-site search for carrier and router construction surfaces before implementation starts. The initial known sites are named later in this plan, but the implementation must verify there are no additional live callers of `build_upstream_carrier`, `build_x_provider_from_graph`, inline `XProvider(...)`, `_non_latency_rows`, the target-edge latency router, or the target-edge `sigma <= 0` trajectory early return named in 73h at `forecast_state.py:979-981` that would keep the old contract alive.

Stop condition: no code changes until the test list states which semantic object each assertion is about, and the live call-site inventory has been recorded.

## Stage 1 — Carrier object contract tests

Stage 1 adds or updates unit-level tests around the carrier object before changing carrier construction.

The tests should prove:

- `window()` and `cohort()` with `A = X` produce identity carrier semantics;
- `cohort()` with `A != X` and positive reach produces an active carrier even when every upstream edge is non-latency;
- an all-non-latency `A -> X` carrier has conditional CDF equal to a Dirac-at-zero shape and reach equal to the topological product;
- a mixed latency/non-latency upstream path composes to the latency edge's timing shape with the non-latency edge acting as identity;
- a multi-edge upstream path computes reach topologically and timing by span-kernel composition;
- carrier conditional CDF and reach are not double-multiplied by consumers.
- horizon adequacy is enforced with the `0.99` fixture threshold and the `0.95` blocking threshold described above.

These tests should exercise the runtime object, not just final chart rows. They are the guard against accidentally moving a count correction into the displayed rate.

Stop condition: these tests are red for the current implementation for the expected reasons, or explicitly green where the current implementation already satisfies the new contract.

## Stage 2 — Shared carrier composition primitive

Stage 2 introduces one internal primitive for building a factorised `carrier_to_x` from the existing graph, anchor node, denominator node, temporal mode, and source preference.

The primitive owns:

- topological reach from `A` to `X`;
- span-kernel composition over the same `A -> X` topology;
- conditional carrier CDF construction;
- per-draw carrier CDF construction where MC draws are needed;
- horizon adequacy diagnostics.

The primitive must read per-edge resolved parameters through the same resolver path used by subject-span construction. It must not consume stale pre-composed `path_mu`, `path_sigma`, or `path_onset_delta_days` for live carrier construction.

The primitive should return a structured carrier object that clearly separates reach, deterministic conditional CDF, MC conditional CDF, tier/provenance, and horizon diagnostics.

For Phase 1, this primitive is a prior/composition primitive only. It must not select empirical observations, admit carrier evidence, or replace prior timing from observed arrivals. Those operations belong to 73n.

Stop condition: the primitive passes Stage 1 tests without being wired into all live callers, and it exposes carrier horizon diagnostics in a test-inspectable form.

## Stage 3 — Migrate all carrier construction sites together

Stage 3 wires the shared carrier primitive into every live carrier construction site in one bounded change.

The three required sites are:

- `forecast_runtime.build_x_provider_from_graph`, including the 73h gate at `forecast_runtime.py:965`;
- `forecast_state.build_node_arrival_cache`, the whole-graph carrier cache surface named in 73h at `forecast_state.py:363`;
- the inline `XProvider` construction in `api_handlers.py`, named in 73h at `api_handlers.py:1380`.

Partial migration is not allowed. A partial migration would leave scoped CF, whole-graph CF, and cohort_maturity on different carrier contracts.

The enabled gate becomes semantic rather than latency-based:

- enabled for `cohort()` when `A != X` and reach is positive;
- disabled for `window()`;
- disabled for `cohort()` when `A = X`;
- independent of whether the upstream chain has latency-bearing edges.

Phase 1 must not introduce a new empirical carrier-conditioning path. Live Phase 1 carrier construction must use the composed prior carrier only. Legacy empirical Tier 2 must be disabled or quarantined behind an explicit flag that defaults off for Phase 1, because leaving it reachable preserves the Tier-flip discontinuity identified in 73h and confounds the Stage 7 test signal. Empirical carrier timing belongs to 73n's typed evidence role.

Stop condition: all three live sites report the same carrier reach and compatible conditional CDF shape for the same `A -> X` scope, and diagnostics identify the carrier CDF source as composed-prior rather than empirical evidence-conditioned.

## Stage 4 — Subject-span CDF ownership

Stage 4 ensures the existing trajectory engine consistently consumes the prepared `subject_span` object and the derived `path_completeness` object.

When a prepared subject-span deterministic CDF or MC CDF is supplied, the trajectory engine must use the prepared object for subject-side progression. In multi-hop, the subject probability used by the likelihood and projection is the span-level `p_XE`, not the terminal edge's `p`; single-hop is the degenerate case where those objects coincide.

For the IS likelihood, per-draw completeness must come from a typed evidence-completeness source. For `window()` and `A = X`, that source may be the prepared subject-span draw matrix on the `X` clock. For active `cohort(A != X)`, the implementation must first state whether each evidence trial count is anchor-population mass or denominator-at-`X` mass, then use the corresponding `path_completeness` derived from `carrier_to_x` and `subject_span`. It must not use subject-span CDF alone for anchor-clock cohort evidence, and it must not multiply displayed subject rates by carrier reach to compensate.

In deterministic row/model projections, the implementation must state whether it reads the conditioned draw family, the unconditioned draw family, or the deterministic span/path CDF. It must not silently recompute edge-level completeness from the terminal edge when the semantic subject is a multi-hop span.

This stage is the prerequisite for safely retiring the v3 router. Without it, routing non-latency terminal edges into the trajectory path can still fall back to the wrong object.

This stage must explicitly forbid the 73h "computed and discarded" pattern: if the prepared runtime has composed the subject-span kernel, no later branch may ignore it and consume a terminal-edge-only object for the same query.

For the single-hop anchor-override carrier-completeness case, this means the CDF construction site named by 73h at `forecast_state.py:1047-1052` must read the prepared path/span timing object when the carrier is active, not only terminal-edge `(mu, sigma, onset)`. The expected test movement is that the single-hop anchor-override carrier-completeness case should improve only if the previous failure was caused by reading the wrong subject/carrier timing object. If it remains red, do not patch projection. Re-open the arithmetic trace against the resolved runtime object and the evidence denominator used by the likelihood.

Stop condition: focused tests prove that IS likelihood completeness, row completeness, and model-curve completeness read from the intended prepared subject-span or path-completeness object for multi-hop and single-hop cases, with diagnostics exposing the selected source, the subject probability source, and the evidence denominator.

## Stage 5 — Retire the v3 latency/non-latency router

Stage 5 removes the top-level router that sends terminal non-latency edges to a separate closed-form row builder.

All cohort_maturity v3 rows should flow through the existing trajectory machinery. Structurally non-latency edges must become natural degeneracies of the same span-kernel objects, not a separate row path.

This stage must also relax the target-edge `sigma <= 0` early return named in 73h at `forecast_state.py:979-981`. If a prepared span CDF exists, the trajectory must consume that object. A terminal non-latency edge in a multi-hop subject must not force all-zero trajectories when the composed subject span has upstream latency.

The old closed-form non-latency helper may remain temporarily for dev-only comparison or until all callers are confirmed migrated, but it must no longer own the live cohort_maturity v3 result. The same PR that retires the live router must either delete the helper or add a reviewed follow-up checklist item naming its remaining dev-only callers and deletion deadline.

Before deleting or bypassing the helper, add a focused equivalence test for a simple single-hop non-latency edge. The trajectory path should reproduce the closed-form Beta-Binomial limit within an explicit tolerance that accounts for MC approximation, or should use an analytically equivalent draw construction that makes the tolerance effectively exact. This test protects against turning the router canaries green while regressing simple non-latency edges.

Stop condition: the two terminal-non-latency router canaries pass because the composed subject span is honoured, not because a special case was added for those fixtures.

## Stage 6 — Projection and field audit

Stage 6 audits the projection layer touched by this work.

Projection may read:

- carrier reach and conditional CDF for counts;
- subject-span rate and conditional CDF for displayed rates and model curves;
- path-completeness diagnostics when evidence is on the anchor clock;
- existing `p_conditioning_evidence` metadata for conditioning provenance.

Projection must not:

- multiply displayed `Y / X` rates by carrier reach;
- infer subject span from the terminal edge;
- infer multi-hop `p_XE` from the terminal edge;
- choose evidence roles;
- rewrite `p_conditioning_evidence`;
- patch 73l completeness parity by re-deciding completeness locally.

This stage should include a small diagnostic or test that compares count fields and rate fields in the all-non-latency carrier case, proving reach appears in the former and cancels out of the latter.

Stop condition: rows, CF scalars, and graph projections touched by this work can be traced back to the resolved runtime object without a second semantic decision. Diagnostic output must include carrier reach, carrier CDF source, subject CDF source, subject probability source, path-completeness source when applicable, evidence denominator, and whether the legacy non-latency router was bypassed.

The diagnostic set must answer the four 73h F14 forensic-trace questions for the relevant public queries: which router path was taken or bypassed, whether the non-latency answer agrees with the `sigma_eff = 0` trajectory limit, which carrier source/tier supplied `carrier_to_x`, and whether projection read the resolved runtime object rather than re-deciding semantics.

## Stage 7 — Integration acceptance

Run focused acceptance, not broad expensive regression by default.

Regression discipline for `graph-editor/lib/tests/test_cohort_factorised_outside_in.py` is strict. Stage 0 establishes the baseline failures and expected-red cases in that file. This plan may only move tests in the documented direction. It must not create any new failing test in that module, must not xfail or skip an existing passing test, and must not relax a tolerance unless Stage 0 has already classified the old assertion as semantically wrong under the cohort/window contract. At Phase 1 closure, the module should have no new failures relative to the Stage 0 baseline, and every changed expectation in the file must be traceable to a named invariant in this plan.

Required gates:

- carrier object tests from Stage 1;
- all three carrier construction sites agree after Stage 3;
- subject-span CDF ownership test from Stage 4;
- the two terminal-non-latency router canaries;
- the simple non-latency closed-form equivalence test from Stage 5;
- the two single-hop non-latent upstream cases, reworded so they assert the correct count/rate semantics;
- the single-hop anchor-override carrier-completeness case;
- existing identity cases for `window()` and `A = X`.

If `test_v3_midline_at_saturation_converges_to_p` turns green, record it as an observed closure. If it remains red, do not expand this plan. Follow the midline-collapse investigation's instrumentation-first sequence.

If 73l parity tests remain red, do not treat that as failure of this plan. They are governed by the separate projection/response-mapping workstream.

## Stage 8 — Phase 2 handoff

After the scoped repair lands, hand off to `73n` with a short decision record for the remaining carrier evidence-conditioning question.

That record should answer whether the system will:

- extend IS-style conditioning to `carrier_to_x`;
- keep empirical carrier shape as a separate, explicitly-labelled policy;
- or leave carriers prior-only unless a separate admission rule selects empirical timing evidence.

This decision should be made with fresh evidence after carrier composition and router unification are no longer confounding the tests.

73h Issue 2 must not be marked fully closed at the end of 73m unless `73n` has also landed or a reviewed decision explicitly accepts a partial carrier-conditioning policy as the durable design.

## Review checklist

Before implementation starts, reviewers should be able to answer yes to all of the following:

- Does every stage state the runtime object it changes?
- Are reach, conditional carrier timing, subject probability, subject timing, evidence conditioning, and projection kept separate?
- Does the all-non-latency carrier case preserve `Y / X` semantics rather than scaling displayed rates by reach?
- Does multi-hop subject progression remain `X -> end`, not terminal-edge-only?
- Does multi-hop subject probability remain span-level `p_XE`, not terminal-edge-only?
- Does the IS likelihood use a named evidence denominator and the matching subject/path completeness object?
- Are all carrier construction sites migrated together?
- Has a fresh call-site inventory verified the three named carrier sites are still complete?
- Is full carrier evidence-conditioning explicitly out of scope for this implementation plan?
- Is empirical carrier evidence-conditioning prevented from sneaking into Phase 1?
- Are 73l projection failures explicitly out of scope?
- Are the carrier horizon thresholds numeric and enforced?
- Is simple non-latency closed-form equivalence protected before the router is retired?
- Are stop conditions strong enough to prevent a later stage from hiding an earlier semantic failure?

