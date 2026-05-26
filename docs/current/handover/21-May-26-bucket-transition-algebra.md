# Handover: Bucket Transition Algebra

**Date:** 21-May-26  
**Status:** IN PROGRESS / unstable working tree  
**Scope:** `docs/current/project-generalise/bucket-transition-algebra-implementation-plan-21-May-26.md`, the post-cutover `project-generalise` conditioned-forecast output path, and the attempt to replace mixed endpoint / midpoint placement conventions with one shared bucket-to-bucket algebra.

## Objective

Implement a shared bucket-to-bucket transition algebra for the new conditioned-forecast output path so that model surfaces, empirical strict evidence, operator-chain readouts, and public chart rows compare like-for-like.

The user’s core intent is **surface parity**:

- The same semantic object must use the same placement convention across empirical, model, and chart projections.
- `window()`, `cohort(A=X)`, active `cohort(A!=X)`, identity carrier, non-latent/Dirac, single-hop, and multi-hop must be data degeneracies of one algebra, not separate branches.
- Old endpoint/midpoint local hacks are not acceptable. The fix must explain and preserve saturation, conservation, identity/Dirac reduction, and A-clock selected evidence correctness.

This session did **not** complete the work. Several implementation attempts were made, some useful discoveries were made, but the current working tree contains partial changes and known failing tests.

## Current State

- IN PROGRESS: `graph-editor/lib/runner/bucket_transition.py`
  - New helper module was added.
  - It currently contains `BucketSourceBasis`, `BucketTransition`, endpoint conversion, cumulative-to-transition conversion, empirical interpolation helpers, and exact Dirac transition support.
  - It is not yet proven to be the right abstraction. The current basis plumbing is incomplete and outside-in tests still fail.

- IN PROGRESS: `graph-editor/lib/runner/empirical_evidence_operator.py`
  - Empirical primitive now carries additional fields such as `bucket_read_offset`, `timing_family`, and a source-specific transition-kernel method.
  - A raw-local empirical view was added so strict empirical subject operators can use raw local `k/n` rows while conditioning still consumes weighted evidence.
  - A source-bucket provider path was attempted.
  - This file is a major focus area and should be treated as unstable.

- IN PROGRESS: `graph-editor/lib/runner/timing_span.py`
  - `SpanDPTrace` was extended to carry `node_basis_by_node`.
  - `_run_dp_density_trace_from_seed` was modified so providers can receive a `BucketSourceBasis` and optionally return an output basis with their kernel.
  - This is the beginning of the structural basis-carrying fix, but it is not complete enough to close outside-in failures.

- IN PROGRESS: `graph-editor/lib/runner/model_span_spine.py`
  - Request-spine path was modified to pass empirical subject/carrier options and root basis through the projection path.
  - CLI / request draw-count plumbing was also touched indirectly via this work.
  - There were false starts: a phase-map shortcut was added, then partially superseded by basis plumbing. Audit carefully before continuing.

- IN PROGRESS: `graph-editor/lib/runner/subject_span_composer.py`
  - `EvidenceReadoutBinding` now carries `empirical_subject_read_offset`.
  - `compose_primitive_span` latent model kernels were moved to shared K, then reverted, then unreverted after user correction.
  - Current state intentionally has model-side K changes restored, but broad model-oracle regressions remain.

- IN PROGRESS: `graph-editor/lib/runner/span_operator_supply.py`
  - Latent model operator supply was moved to shared transition conversion, reverted, then restored.
  - Current state intentionally keeps model-side K treatment.

- IN PROGRESS: CLI and request setting plumbing
  - `graph-editor/src/cli/commands/analyse.ts` now accepts `--mc-draws`.
  - `graph-editor/src/services/analysisComputePreparationService.ts` carries optional `forecastingSettings`.
  - `graph-editor/src/lib/graphComputeClient.ts` merges those overrides into `forecasting_settings`.
  - `graph-editor/lib/runner/request_envelope.py` now reads `current_mc_draws()` for request envelope arrival-map construction.
  - This was added because `--mc-draws 2000` originally produced 1000/2000 shape mismatches.

- DONE: A full-fidelity `/photocopy` attempt was made.
  - Stash name: `photocopy-feature-snapshot-db-phase0-2026-05-21`.
  - The stash was created, but verification diff was **not empty**. Three files that had staged+unstaged state became unstaged-only:
    - `graph-editor/lib/runner/cohort_forecast_v3.py`
    - `graph-editor/lib/runner/subject_span_composer.py`
    - `graph-editor/lib/runner/timing_particles.py`
  - Do not assume staged state is preserved. The user explicitly allowed continuing after this, but the handover should record the imperfection.

- BLOCKED / NOT DONE: Reversion audit.
  - The plan requires per-site reversion audit. This was not done.

- BLOCKED / NOT DONE: Correct chart-level §10.5 bucket-K tests.
  - Existing focused tests were updated and passed at various points, but they were too weak. They did not catch outside-in regressions.

## Key Decisions & Rationale

- **Decision: Treat old no-midpoint toys as stale only after proving the target algebra.**
  - Why: The user corrected that old toys expecting no midpoint may fail under the new convention, but this cannot be used to dismiss all failures.
  - Where: `graph-editor/lib/tests/test_evidence_clocking_spine_toy.py` was not edited during the later phase. Do not update toys casually.

- **Decision: `evidence_x` for active `cohort()` is carrier A-clock endpoint evidence and should not receive subject-style midpoint treatment.**
  - Why: The user forced reasoning from first principles. `evidence_x` starts at A and is already A-clocked carrier evidence. Once empirical carrier/root K uses endpoint alignment, the A-clock `evidence_x` oracle matched exactly.
  - Where: `model_span_spine._prepare_carrier_operator_family` passes endpoint-style empirical carrier treatment; `empirical_evidence_operator` has offset/basis machinery around this.

- **Decision: Subject evidence for `cohort()` is meaningful only on the A-clock, but factorised strict evidence still composes A-clocked X mass through subject progression.**
  - Why: The user rejected attempts to treat raw local window evidence as authoritative for cohort query evidence. The correct issue is not “use local evidence instead of A-clock evidence”; it is “reason correctly about subject progression given A-clocked X evidence.”
  - Where: `model_span_spine.project_selected_cohort_rows` remains the key handoff from `emp_x_value_flat` to `emp_y_trace`.

- **Decision: Applying K/midpoint to every model surface without updating model oracles creates broad regressions.**
  - Why: Several old tests compare `midpoint` against endpoint factorised model oracles. The user insisted the point of the workstream is parity, not preserving mixed conventions. The conclusion is not to revert model K, but to recognise that model/evidence/oracle conventions must be aligned.
  - Where: `subject_span_composer.py` and `span_operator_supply.py` currently keep model-side K changes restored.

- **Decision: A hop-count fix is wrong.**
  - Why: The user pointed out that “first hop gets midpoint, downstream does not” breaks non-latent/Dirac chains. The correct discriminator is source mass representation, not hop index.
  - Where: Avoid implementing `if first edge then 0.5 else 0.0` in `model_span_spine.py` or empirical operators.

- **Decision: Source basis must be carried by the DP, not guessed per primitive.**
  - Why: The same primitive can consume mass with different provenance. A primitive-level `bucket_read_offset` is too coarse.
  - Where: `timing_span.SpanDPTrace` and `_run_dp_density_trace_from_seed` now carry/pass `BucketSourceBasis`, but this is incomplete.

- **Decision: Do not treat passing focused tests as acceptance.**
  - Why: Focused tests repeatedly passed while outside-in tests failed. The old focused tests did not encode enough of the full output path.
  - Where: `graph-editor/lib/tests/test_bucket_transition_algebra.py`, `test_empirical_evidence_operator.py`, `test_model_span_spine_selected_cohort.py`.

## Discoveries & Gotchas

- The A-clock single-hop canary eventually passed after carrier/root denominator handling was corrected. This proved denominator clocking was not the remaining issue.

- Active multi-hop canary currently fails only on `evidence_y`:
  - `tau=24`: expected `1790`, got approximately `1825.45`.
  - `tau=25`: expected `2365`, got approximately `2395.50`.
  - This is deterministic; increasing draw count to 2000 did not change the values.

- Broad regressions were introduced by model-surface K changes:
  - `test_low_evidence_cohort_matches_factorised_convolution_oracle`
  - `test_no_evidence_single_hop_matches_unconditioned_fw_convolution_midline`
  - `test_low_evidence_single_hop_remains_near_unconditioned_oracle`
  - `test_degenerate_identity_and_instant_carrier_oracles_reduce_to_subject_kernel`
  - `test_first_latency_edge_with_nonlatent_chain_observed_collapses_to_window`
  - User explicitly rejected dismissing these as “old endpoint oracles” without proper structural reasoning.

- `--mc-draws 2000` originally failed with shape mismatch because some arrival maps were built with default 1000 while runtime primitives used 2000.
  - Fix attempt: thread `forecastingSettings` through CLI / FE dispatch and use `current_mc_draws()` in `request_envelope.py`.
  - This needs validation, but the CLI 2000-draw command eventually ran and confirmed draw count did not affect the residual.

- The `/photocopy` stash verification failed due staged-state loss for three files. Do not assume pristine staging.

- The grouped outside-in run hung and was aborted. It showed multiple failures before being killed, but it did not produce a complete report.

- The user’s key correction: “investigate” does not mean “revert.” Do not revert or narrow changes unless explicitly instructed.

- The user’s key principle: if parity treatment is not applied, surfaces are not like-for-like and tests are not meaningful parity tests. This workstream is about parity between surface representations.

## Relevant Files

### Design / Context

- `docs/current/project-generalise/bucket-transition-algebra-implementation-plan-21-May-26.md`
  - Current implementation plan. Important but possibly incomplete relative to user’s evolving understanding.

- `docs/current/project-generalise/evidence-discretisation-investigation-21-May-26.md`
  - Investigation note with the key §10 bucket-K proposal and inventory.

- `docs/current/project-generalise/frontier-conditioned-chart-surface-proposal-21-May-26.md`
  - Adjacent chart-surface proposal; useful for future `e+f` semantics but do not conflate with current bucket-K fix.

- `docs/current/codebase/CF_ENGINE_DISCIPLINE.md`
  - Must follow. No defensive fallbacks / mode branches in engine core.

- `docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`
  - Semantic authority for carrier vs subject, displayed `Y/X`, identity carrier, factorised representation.

- `docs/current/codebase/CF_PRIMITIVE_SUBSTRATE.md`, `CF_ROW_PIPELINE.md`, `FORECAST_RUNTIME_ARCHITECTURE.md`
  - Required references for the CF primitive / row pipeline.

### Backend Runtime

- `graph-editor/lib/runner/bucket_transition.py`
  - New shared transition helper. Currently partial and unstable.

- `graph-editor/lib/runner/empirical_evidence_operator.py`
  - Empirical operator. Many changes. Current basis plumbing attempts live here.

- `graph-editor/lib/runner/timing_span.py`
  - DP trace and source-basis propagation. Structural fix began here.

- `graph-editor/lib/runner/model_span_spine.py`
  - New output-path spine. Critical handoff between empirical carrier `X` and subject `Y`.

- `graph-editor/lib/runner/subject_span_composer.py`
  - Conditioned/model span composition. Model-side K changes restored here.

- `graph-editor/lib/runner/span_operator_supply.py`
  - Model operator supply. Model-side K changes restored here.

- `graph-editor/lib/runner/prefix_arrival.py`
  - Prefix arrival and cache identity. Touched to use K and draw-count plumbing.

- `graph-editor/lib/runner/request_envelope.py`
  - Request envelope arrival maps. Touched to use `current_mc_draws()`.

- `graph-editor/lib/runner/cohort_forecast_v3.py`
  - Row projection integration and request runtime building. Touched for draw-count and output path integration.

### Frontend / CLI

- `graph-editor/src/cli/commands/analyse.ts`
  - Added `--mc-draws`.

- `graph-editor/src/services/analysisComputePreparationService.ts`
  - Added optional `forecastingSettings`.

- `graph-editor/src/lib/graphComputeClient.ts`
  - Merges `forecastingSettings` into backend request payloads.

### Tests

- `graph-editor/lib/tests/test_cohort_factorised_outside_in.py`
  - Primary outside-in oracle suite. Multiple current failures.

- `graph-editor/lib/tests/test_bucket_transition_algebra.py`
  - New focused tests. Too weak as acceptance.

- `graph-editor/lib/tests/test_empirical_evidence_operator.py`
  - Focused empirical operator tests. Currently pass after latest changes.

- `graph-editor/lib/tests/test_model_span_spine_selected_cohort.py`
  - Focused spine tests. Currently pass after latest changes.

- `graph-editor/lib/tests/test_evidence_clocking_spine_toy.py`
  - Existing toy tests. Do not update until target semantics are settled.

## Next Steps

1. **Do not make further code changes until the latest structural state is reviewed.**
   - The current implementation has basis plumbing, but outside-in failures remain.
   - The user explicitly wants reasoning, not hacking.

2. **Classify current failing outside-in tests under current code.**
   - Run failures individually, not the whole grouped run.
   - Start with:
     - `test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x`
     - `test_low_evidence_cohort_matches_factorised_convolution_oracle`
     - `test_no_evidence_single_hop_matches_unconditioned_fw_convolution_midline`
     - `test_low_evidence_single_hop_remains_near_unconditioned_oracle`
     - `test_degenerate_identity_and_instant_carrier_oracles_reduce_to_subject_kernel`
     - `test_first_latency_edge_with_nonlatent_chain_observed_collapses_to_window`
   - For each, identify surface under test, oracle convention, runtime convention, and whether failure is stale oracle or true mixed-convention bug.

3. **Investigate identity / instant / non-latent regressions first.**
   - These should pass under any correct bucket algebra.
   - If they fail, source basis propagation or Dirac handling is wrong.
   - Focus files:
     - `bucket_transition.py`
     - `timing_span.py`
     - `subject_span_composer.py`
     - `model_span_spine.py`

4. **Investigate model surface regressions separately from empirical evidence regressions.**
   - `low_evidence_*` tests assert `midpoint`.
   - Determine whether model `midpoint` should be K or endpoint under final contract.
   - If K, update model oracles; if endpoint, change model surfaces accordingly. Do not mix silently.

5. **Resolve active multi-hop residual only after identity/non-latent reductions are clean.**
   - The current residual is small but not the only problem.
   - Do not tune interpolation offsets until structural reductions pass.

6. **After structural fixes, run focused then outside-in.**
   - Focused:
     - `test_bucket_transition_algebra.py`
     - `test_empirical_evidence_operator.py`
     - `test_model_span_spine_selected_cohort.py`
     - `test_subject_span_composer.py`
   - Outside-in individual canaries, not a huge grouped run.

7. **Only after tests are classified and green, update docs.**
   - The current implementation plan may need revision to state basis propagation explicitly.

## Open Questions

- **Blocking:** Should model `midpoint` surfaces move to bucket-K, or should K apply only to empirical evidence/output operators? The user’s parity principle suggests model must be treated consistently, but the existing model oracles must then be updated.

- **Blocking:** What is the exact source-basis contract for identity, Dirac, non-latent, and latent output mass? Current enum is a start, not fully validated.

- **Blocking:** Are outside-in A-clock raw DB oracles supposed to remain endpoint truth, or should canary oracles be transformed into K-derived expected curves? The user seems to expect old semantic tests should still pass in principle, so do not assume stale oracle without proof.

- **Non-blocking:** `--mc-draws` CLI plumbing exists and should be kept if clean; it is useful for future diagnostics.

- **Non-blocking:** The `photocopy` stash exists but did not perfectly preserve staged state. Mention this if the next agent intends to rely on staged/unstaged layout.

## Known Test Signals

- Last focused suite after basis plumbing: `44 passed`.
- Last active single-hop canary: passed.
- Last active multi-hop canary: failed at τ=24 and τ=25 `evidence_y`.
- Last broad selected run before handover: 6 failures, 1 pass among the selected outside-in tests.
- `test_multihop_latent_upstream_divergence` also produced a `fetch failed` in a long grouped run; this may be infrastructure/timeout rather than direct algebra failure and should be rerun alone if needed.

