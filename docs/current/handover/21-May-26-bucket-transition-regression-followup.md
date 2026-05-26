# Handover: Bucket Transition Regression Follow-up

**Date:** 21-May-26  
**Status:** IN PROGRESS / working tree remains very dirty  
**Scope:** Follow-up to `docs/current/handover/21-May-26-bucket-transition-algebra.md`, focused on newly regressed `test_cohort_factorised_outside_in.py` outside-in tests after the bucket-transition / empirical evidence work.

## Objective

Get the outside-in cohort forecast suite back to green while preserving the user's core intent:

- bucket placement must be a shared algebra, not local midpoint hacks;
- `window()`, `cohort(A=X)`, active `cohort(A!=X)`, identity carrier, non-latent / Dirac, single-hop, and multi-hop must be natural degeneracies of one runtime object;
- strict evidence rows must be honest about which evidence object they display;
- no new mode branches or defensive fallbacks inside the CF engine.

The immediate acceptance set the user named was:

- `test_active_single_hop_evidence_matches_selected_a_clock_snapshot_oracle`
- `test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x`
- `test_low_evidence_cohort_matches_factorised_convolution_oracle`
- `test_no_evidence_single_hop_matches_unconditioned_fw_convolution_midline`
- `test_low_evidence_single_hop_remains_near_unconditioned_oracle`
- `test_degenerate_identity_and_instant_carrier_oracles_reduce_to_subject_kernel`
- `test_multihop_latent_upstream_divergence`

Later, the user specifically directed investigation toward `test_first_latency_edge_with_nonlatent_chain_observed_collapses_to_window` and insisted on removing sparsity from `synth-mirror-4step` to disambiguate sparsity from algebraic defects.

## Current State

- DONE: Read the latest prior handover, the bucket-transition plan, and CF runtime docs before editing.
- DONE: Identified and fixed a real model-side double-placement bug.
  - `model_span_spine.build_per_draw_chain` now treats composed span CDFs as already-composed endpoint-labelled surfaces and differences them directly instead of sending them back through primitive bucket-K conversion.
  - A focused regression was added in `test_model_span_spine_selected_cohort.py` to pin this.
- DONE: Changed conditioned model composition to respect source basis.
  - `subject_span_composer._conditioned_kernel_maps` now produces endpoint and bucket kernels and providers choose by `BucketSourceBasis`.
  - This is data-driven by the DP-carried source basis, not by mode or hop count.
- DONE: Spliced observed strict evidence into E+F model rows during the observed epoch.
  - `model_span_spine.project_selected_cohort_rows` now replaces model `x_model_by_anchor` / `y_model_by_anchor` up to each cohort's `tau_observed` with strict empirical prefix surfaces before aggregating `rate_draws_model`.
  - This removed the earlier `evidence rate > midpoint` failures in the solid epoch.
- DONE: Consolidated one empirical helper branch.
  - Added `cumulative_empirical_rate_to_transition_for_basis` in `bucket_transition.py`.
  - `empirical_evidence_operator._empirical_kernel_for_source_bucket` now uses this helper instead of open-coding source-basis-to-offset logic.
  - This is a small consolidation only; many other placement helpers remain unconsolidated.
- DONE: Removed the defensive `age <= 0` guard inside `bucket_transition.cdf_to_bucket_transition`.
  - Rationale: `lookup()` already handles negative indices; zero is valid data and must not be forced to zero.
  - This fixed the local Dirac/bucket algebra tests but did not close the mirror canary by itself.
- DONE: Removed sparsity from `bayes/truth/synth-mirror-4step.truth.yaml`.
  - Changed `kappa_sim_default` to `1000000000.0`, added `kappa_step_default: 0.0`, set `failure_rate: 0.0`, `snapshot_start_offset: 0`, and `traffic_cv: 0.0`.
  - The fixture regenerated during a rerun; the mirror canary still failed, with a larger denominator gap.
- DONE: Increased `test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x` strict `evidence_y` absolute floor from `25.0` to `40.0`, per user instruction to increase tolerance very slightly.
  - The test passed when run alone immediately after that edit.
  - It should be rerun in the final current state to confirm after subsequent edits.
- IN PROGRESS: `test_first_latency_edge_with_nonlatent_chain_observed_collapses_to_window` still fails.
  - After dense fixture regeneration, isolated failure was `evidence_x`: window `8314.0`, cohort `8160.342551`, max diff `153.657449` at `tau=2`.
  - This is no longer plausibly a sparsity artefact.
- IN PROGRESS / BLOCKED BY PERFORMANCE: `test_multihop_latent_upstream_divergence` is not failing a clean assertion; it times out / reports CLI `fetch failed` after a very long deep cohort request.
  - Earlier no-daemon run timed out after 300s.
  - Full suite run showed daemon `fetch failed` for the cohort request.
  - Treat this as a performance / server-path issue, not the same numerical issue as active multi-hop strict evidence.
- DONE: Full outside-in suite was run once after the tolerance edit but before the very latest guard/consolidation details settled.
  - Result at that time: `47 passed`, `3 failed`, `1 xfailed`, duration about 22m37s.
  - Failures: active multi-hop evidence, first latency edge with non-latent upstream chain, deep latent upstream divergence timeout.
  - Because edits continued afterward, rerun the relevant subset before trusting this as final.

## Key Decisions & Rationale

- **Decision: Do not keep chasing local midpoint offsets for the active multi-hop residual.**
  - **Why:** Varying `--mc-draws` from 250 to 4000 produced identical active multi-hop `evidence_y`, `rate`, and `midpoint` at the checked taus. This proved the residual on strict `evidence_y` was deterministic under the current row path, not MC draw noise.
  - **Where:** Probed through CLI `analyse --mc-draws`; relevant row owner is `model_span_spine.project_selected_cohort_rows`, not the old Pop C / Pop D reducer.

- **Decision: Treat `X` exactness in active multi-hop as evidence-object alignment, not proof that no latency map is involved.**
  - **Why:** The user correctly challenged earlier explanations. A-clock placement always uses a latency map. Exact `evidence_x` in `synth-lat4-flat` means the strict carrier output matches the gross denominator marginal, not that there is no latency convolution.
  - **Where:** Carrier and subject arrival maps are built through `request_envelope.py` and `prefix_arrival.py`; strict row output is emitted from `model_span_spine.project_selected_cohort_rows`.

- **Decision: Active multi-hop `evidence_y` residual is now acceptable as a small tolerance adjustment, not a runtime patch.**
  - **Why:** After fixes, the only active multi-hop failure was `evidence_y` at `tau=24` and `tau=25`: about +35 and +30 users. The user requested a very slight tolerance increase. A floor of `40.0` made the test pass alone.
  - **Where:** `graph-editor/lib/tests/test_cohort_factorised_outside_in.py`, inside `test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x`.

- **Decision: The non-latent upstream mirror failure is a carrier denominator basis issue, not midpoint.**
  - **Why:** The failure is a constant scale gap in `evidence_x`, not a timing bump. Window mode has an identity empirical carrier at `m4-delegated`; cohort mode propagates through upstream non-latent empirical edges `m4-landing -> m4-created -> m4-delegated` as rate-bearing edges. Dense fixture regeneration increased the gap, so sparsity is not the cause.
  - **Where:** `model_span_spine.project_selected_cohort_rows` currently computes `emp_x_value_flat` by evaluating `composed_empirical_carrier` from the selected root seed.

- **Decision: The old instant-carrier rescue behaviour was semantically closer to what the mirror test expects, but its implementation was branchy and was commented out for AP58 / engine-discipline reasons.**
  - **Why:** The old commented code in `model_span_spine.py` replaced `emp_x_value_flat` with the subject root observed `n` whenever the empirical carrier terminal was instant. That made non-latent upstream carrier behave like a denominator no-op. It was removed/commented because it was mode/case-style rescue and included silent fallback-like lookup.
  - **Where:** `model_span_spine.py` near the commented `_span_terminal_is_instant` / `_subject_root_n_seed_flat` block and the `emp_x_value_flat` assignment.

- **Decision: Removing the `age <= 0` guard was correct but insufficient.**
  - **Why:** The guard was bad defensive code inside the bucket algebra. It made Dirac-at-zero endpoint reads shift one day late. Removing it is algebraically correct and local bucket tests pass. But the mirror canary still failed afterward because the remaining issue is upstream empirical reach / count basis, not just zero-age support.
  - **Where:** `bucket_transition.cdf_to_bucket_transition`.

- **Decision: The helper family remains too fragmented; only a small consolidation landed.**
  - **Why:** The user asked whether helper branching could be reduced. One empirical source-basis branch was centralised, but broader consolidation would require a staged design change across `timing_particles`, `prefix_arrival`, `subject_span_composer`, `empirical_evidence_operator`, `model_span_spine`, and old `cohort_forecast_v3` diagnostics.
  - **Where:** `bucket_transition.py` now owns `cumulative_empirical_rate_to_transition_for_basis`; other helper surfaces still remain.

## Discoveries & Gotchas

- `synth-lat4-flat` is flat/dense and has non-zero latency shape but no drift/sparsity/traffic variance. Its truth file has `sigma` values on edges, but simulation noise knobs are disabled.
- `synth-mirror-4step` originally had sparsity/noise: `failure_rate: 0.05`, `snapshot_start_offset: 50`, `traffic_cv: 1.0`, and `kappa_sim_default: 50.0`.
- Removing sparsity from `synth-mirror-4step` did not fix the mirror test; it made the `evidence_x` gap larger.
- In `synth-mirror-4step`, upstream non-latent edges are zero-latency but not probability-identity:
  - `m4-landing -> m4-created` has `p=0.18`;
  - `m4-created -> m4-delegated` has `p=0.55`.
  - Cohort-mode empirical carrier currently rate-propagates through both, while the test expects the observed delegated denominator to be authoritative.
- Before removing the bucket guard, diagnostics showed non-latent upstream empirical carrier active columns at `0`, `1`, and `2`, indicating artificial one-bucket delay per non-latent edge. Removing the guard fixed the local bucket algebra but did not close the mirror canary; the remaining problem is scale/count-basis.
- `test_multihop_latent_upstream_divergence` is expensive and unstable under current code. It should not be grouped casually when iterating; run it alone or last.
- `--mc-draws` is available for CLI `analyse`, and draw-count changes did not affect strict active multi-hop evidence values, confirming the strict row surface is deterministic under the current path.
- The `DrawFamilyKey` intentionally drops `scenario_id` and `scenario_seed` from its canonical identity. Changing scenario seed is not expected to perturb primitive draws under the current contract.
- The full diagnostic payload for active multi-hop can wedge or be extremely large; prefer compact diagnostics or targeted helper probes.
- The Python BE frequently reloads during these edits and tests may skip if the skip marker checks during a reload window. Always check `scripts/dev-server-check.sh` before concluding a test skipped for logical reasons.

## Relevant Files

### Backend Runtime

- `graph-editor/lib/runner/bucket_transition.py` — central bucket transition helper. Now has the zero-age guard removed and a new source-basis empirical helper.
- `graph-editor/lib/runner/empirical_evidence_operator.py` — empirical strict evidence operator. Now calls the new source-basis helper. Still owns strict empirical subject/carrier composition.
- `graph-editor/lib/runner/model_span_spine.py` — selected-cohort row spine. Key owner of current `evidence_x`, `evidence_y`, `rate`, `midpoint` row output. Contains commented old instant-carrier rescue logic.
- `graph-editor/lib/runner/subject_span_composer.py` — conditioned/model span composition. Now chooses endpoint vs bucket kernels by `BucketSourceBasis`.
- `graph-editor/lib/runner/timing_particles.py` — builds per-draw edge CDFs from latency particles; still uses bucket-transition conversion internally.
- `graph-editor/lib/runner/prefix_arrival.py` — builds carrier and subject arrival maps from timing particles and timing span composition.
- `graph-editor/lib/runner/cohort_forecast_v3.py` — row projection owner around `_project_runtime_rows`; now largely delegates selected row surfaces to `model_span_spine`, but still contains old diagnostic / legacy helpers.

### Tests

- `graph-editor/lib/tests/test_cohort_factorised_outside_in.py` — protected outside-in oracle. Current remaining important canaries: active multi-hop, mirror non-latent upstream, deep latent upstream timeout.
- `graph-editor/lib/tests/test_bucket_transition_algebra.py` — focused bucket transition tests. Passed after zero-age guard removal.
- `graph-editor/lib/tests/test_empirical_evidence_operator.py` — focused empirical operator tests. A small subset passed after helper consolidation.
- `graph-editor/lib/tests/test_model_span_spine_selected_cohort.py` — focused spine tests. Includes regression for composed CDF readout not reapplying bucket-K.
- `graph-editor/lib/tests/test_evidence_clocking_spine_toy.py` — existing toy tests; should remain reference context, but do not casually update unless semantics are settled.

### Fixtures

- `bayes/truth/synth-mirror-4step.truth.yaml` — edited to remove sparsity/noise. Fixture regenerated during test run. Still fails mirror canary.
- `bayes/truth/synth-lat4-flat.truth.yaml` — flat/dense active multi-hop fixture. Active multi-hop now close; tolerance adjusted.

### Docs / Context

- `docs/current/handover/21-May-26-bucket-transition-algebra.md` — previous handover from the earlier session.
- `docs/current/project-generalise/bucket-transition-algebra-implementation-plan-21-May-26.md` — current plan / intended algebra.
- `docs/current/project-generalise/evidence-discretisation-investigation-21-May-26.md` — investigation note with inventory and prior midpoint reasoning.
- `docs/current/codebase/CF_ENGINE_DISCIPLINE.md` — no defensive fallbacks / no case-fork rules; especially relevant before touching the instant-carrier rescue.
- `docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` — semantic authority for carrier vs subject and denominator at X.
- `docs/current/codebase/CF_PRIMITIVE_SUBSTRATE.md`, `CF_ROW_PIPELINE.md`, `FORECAST_RUNTIME_ARCHITECTURE.md` — required context for runtime changes.

## Next Steps

1. **Verify final current subset before further edits.**
   - Run:
     - `test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x`
     - `test_first_latency_edge_with_nonlatent_chain_observed_collapses_to_window`
     - `test_no_evidence_single_hop_matches_unconditioned_fw_convolution_midline`
     - `test_degenerate_identity_and_instant_carrier_oracles_reduce_to_subject_kernel`
   - Expect active multi-hop to pass with the tolerance floor; expect mirror non-latent to fail unless fixed.

2. **Fix mirror non-latent upstream carrier as a data/algebra issue, not by reintroducing branchy rescue.**
   - Target files: `model_span_spine.py`, possibly `empirical_evidence_operator.py`.
   - Desired semantic: when the empirical carrier span is instant / non-latent for timing, the denominator clock should be a no-op, but strict denominator mass should be sourced from observed X-root evidence rather than product of upstream rates.
   - Risk: restoring the old commented `_subject_root_n_seed_flat` directly will violate engine discipline. Try to encode the observed-X denominator as an explicit basis object passed into the spine, or as a natural zero-edge / identity data surface.

3. **Re-run mirror canary after the fix.**
   - Use only `test_first_latency_edge_with_nonlatent_chain_observed_collapses_to_window` first.
   - If it passes, run nearby non-latent / identity tests:
     - `test_multihop_non_latent_upstream_collapse`
     - `test_degenerate_identity_and_instant_carrier_oracles_reduce_to_subject_kernel`
     - `test_a_equals_x_identity_collapses_to_window`

4. **Investigate `test_multihop_latent_upstream_divergence` timeout separately.**
   - This is currently a performance / CLI fetch failure, not a numerical assertion.
   - Run it alone, preferably with daemon diagnostics disabled if possible.
   - Check Python server log for the long cohort request; earlier grouped run showed 300s timeout / `fetch failed`.

5. **Consider a broader helper consolidation after tests are stable.**
   - Inventory still includes scattered endpoint / bucket placement helpers.
   - Do not do this as a drive-by while fixing the mirror test; it needs a small plan and reversion audit.

6. **After final runtime changes, rerun the full outside-in suite.**
   - Last full result before final guard / mirror changes settled was `47 passed`, `3 failed`, `1 xfailed`.
   - Full suite can take over 20 minutes and may stall on the deep latent test.

## Open Questions

- **Blocking:** What is the clean algebraic representation for “instant upstream carrier is a denominator no-op” that avoids resurrecting the old branchy `_subject_root_n_seed_flat` rescue?
- **Blocking:** Should strict denominator mass for active cohorts always be an explicit observed-X basis when available, with carrier timing only owning clock placement? This would align with the mirror canary but needs careful framing against active latent carrier cases.
- **Blocking:** Is `test_multihop_latent_upstream_divergence` timeout due to a new performance regression from the bucket/spine changes, or was it already fragile on the deep fixture?
- **Non-blocking:** Should `synth-mirror-4step` remain dense/noiseless after this investigation, or should sparsity be restored once the algebraic issue is isolated?
- **Non-blocking:** Should the old `cohort_forecast_v3` diagnostic variants (`production`, `midpoint`, `integer`, `ff_integer`) be retired after the shared transition contract is stable?
