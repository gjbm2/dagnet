# 20-May-26 Empirical Clock Mass Conservation Handover

### Objective

Fix and validate a post-cutover empirical evidence clocking defect in the selected-cohort spine.

The immediate symptom was `test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x` failing after the Stage 3-style cutover to `model_span_spine.project_selected_cohort_rows`. The deeper goal is to preserve strict empirical evidence integrity for `cohort()` multi-hop queries while still allowing the forecasting model to remain as accurate as possible. The user explicitly rejected papering over failures with loosened tolerances: outside-in tests are canaries for structural defects, not output to be adjusted until green.

Scope boundary agreed during the session:

- Strict empirical evidence must remain mass-conserving through `cohort()` multi-hop reclocking.
- Do not add mode branches or separate display-vs-rate empirical code paths.
- Do not hide errors by weakening outside-in oracles.
- Model/evidence parity should be considered only after the strict evidence algebra is correct.

### Current State

- DONE: Photocopy safety stash created.
  - Stash entry: `stash@{0}: On feature/snapshot-db-phase0: photocopy-feature-snapshot-db-phase0-2026-05-20`.
  - Pre/post `git status --short` diff was empty.

- DONE: Added a red/green toy test for cohort multi-hop mass conservation.
  - File: `graph-editor/lib/tests/test_evidence_clocking_spine_toy.py`.
  - Test: `test_uniform_latency_cohort_multihop_preserves_mass_conservation`.
  - It monkeypatches uniform timing densities and runs the real `handle_runner_analyze` path.
  - It proves `A->B`, `B->C`, and `C->D` mass conservation with prime probabilities `1/5` and `1/7`.
  - Before the fix, the test failed because `evidence_y` appeared at `tau=6` when expected cumulative D mass was zero.
  - After the fix, it passes.

- DONE: Applied the core empirical clock fix.
  - File: `graph-editor/lib/runner/empirical_evidence_operator.py`.
  - `_placement_aware_cumulative_rate` was renamed/reworked to `_bound_age_cumulative_rate`.
  - The hidden `source_index > 0` midpoint age shift was removed.
  - Empirical readout now uses exactly the `(source_day, age)` supplied by `EvidenceReadoutBinding`.

- DONE: Focused unit tests passed after the core fix.
  - `graph-editor/lib/tests/test_evidence_clocking_spine_toy.py::test_uniform_latency_cohort_multihop_preserves_mass_conservation`: passed.
  - `graph-editor/lib/tests/test_empirical_evidence_operator.py`: passed.
  - `graph-editor/lib/tests/test_model_span_spine_selected_cohort.py`: passed.
  - `ReadLints`: no linter errors for edited files.

- IN PROGRESS: Outside-in fallout is exposed and unresolved.
  - Focused outside-in command collected 8 tests: 5 passed, 3 failed.
  - Failures:
    - `test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x`: `evidence_y` and `rate` now lag the old oracle on the rising flank.
    - `test_active_single_hop_evidence_matches_selected_a_clock_snapshot_oracle`: same pattern, stronger.
    - `test_multihop_evidence_parity.py::TestMultihopCollapse::test_evidence_y_parity`: one tau just outside the 5% parity threshold.

- IN PROGRESS: `test_cohort_factorised_outside_in.py` still contains two edits from the earlier local test work.
  - Kept because the user said these were fine:
    - The `rate` check in `test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x` is now two-sided rather than one-sided.
    - The Epoch B model/evidence check was changed to a peel-away check.
  - Reverted/removed:
    - Loosened `evidence_y` tolerance was reverted to the previous `max(25, 1%)`.
    - Arbitrary Epoch A `0.025` tolerance was removed.
    - Added terminal-denominator negative-control oracle was removed at the user's request.

- NOT STARTED: Model-side parity correction.
  - The user asked to focus first on the core fix; model/evidence parity remains to be reasoned and scoped.

### Key Decisions & Rationale

- Decision: Do not solve the outside-in failure by tolerance weakening.
  - Why: The outside-in suite is a semantic oracle. The user repeatedly corrected attempts to loosen tolerances without first-principles justification. The failing tests are meant to detect structural defects.
  - Where: `graph-editor/lib/tests/test_cohort_factorised_outside_in.py` should not be further loosened until the model/evidence algebra is understood.

- Decision: Empirical readout must not secretly add a midpoint shift after `EvidenceReadoutBinding`.
  - Why: `cohort()` reclocking already smears evidence through per-draw arrival maps. Adding `+0.5` inside empirical readout creates a second hidden clock convention. In multi-hop `cohort()` queries this breaks the `m * k/n = k` cancellation between hops and can create early downstream evidence.
  - Where: `graph-editor/lib/runner/empirical_evidence_operator.py`, `_bound_age_cumulative_rate`.

- Decision: Keep one empirical evaluator path.
  - Why: The user explicitly rejected branching. The repo invariants require mode differences to be encoded as data, not as evaluator branches. A separate strict path versus bucket-centred path would reintroduce parallel authorities.
  - Where: `evaluate_empirical_span_from_seed_flat_origins`, `_build_empirical_flat_kernel_provider`, and `_run_empirical_lookup_bound_trace` still route through the same provider/DP path in `graph-editor/lib/runner/empirical_evidence_operator.py`.

- Decision: Use a uniform-latency toy to isolate mass conservation.
  - Why: A lognormal fixture is too hard to reason about manually. Monkeypatching the timing density to uniform kernels preserves the real handler/reclocking path but makes expected mass shapes hand-computable. This avoids arbitrary stationarity assumptions.
  - Where: `graph-editor/lib/tests/test_evidence_clocking_spine_toy.py`, `test_uniform_latency_cohort_multihop_preserves_mass_conservation`.

- Decision: Do not remove Simpson/curvature correction globally.
  - Why: The issue is empirical strict evidence clocking. Model/conditioned curves are continuous surfaces and may still need Simpson/Lagrange-style interpolation for forecast quality. The user emphasised the goal is the best forecasting model, not parity for its own sake.
  - Where: `graph-editor/lib/runner/subject_span_composer.py` remains untouched; `_propagated_latent_timing_kernel` still uses the existing model-side interpolation.

- Decision: Treat model/evidence mismatch as a separate forecasting-quality question.
  - Why: After the empirical fix, strict evidence is mass-conserving but some outside-in model/evidence comparisons fail. The right next question is whether the model curve is forecast-correct, not whether it can be forced to match strict evidence by corrupting evidence.
  - Where: future work likely touches `graph-editor/lib/runner/subject_span_composer.py`, `graph-editor/lib/runner/model_span_spine.py`, and affected outside-in tests.

### Discoveries & Gotchas

- Reclocking itself is per-draw and integer-day based.
  - `prefix_arrival.py` builds scalar `weights` and per-draw `weights_draws`.
  - `primitive_evidence.py` applies those weights directly to evidence rows by `observed_date`.
  - No midpoint/Simpson correction is applied in the reclocking or evidence-binding steps.

- The hidden midpoint shift was later, in empirical readout.
  - The previous `_placement_aware_cumulative_rate` applied `age + 0.5` whenever `source_index > 0`.
  - This happened after `EvidenceReadoutBinding.lookup` had already chosen source day and age.

- The red toy confirmed an actual mass-conservation failure.
  - Before the fix, D evidence appeared at `tau=6` even though the hand-computed D mass should first appear at `tau=7`.
  - This is a concrete early-arrival defect, not MC noise.

- Existing toy files are useful but did not include the uniform monkeypatch.
  - `test_evidence_clocking_spine_toy.py` already runs the real handler path with monkeypatched snapshot rows.
  - The new work added the uniform latency monkeypatch inside that file.

- The outside-in failures after the core fix are expected fallout.
  - Removing the hidden empirical midpoint shift moves strict evidence later/back.
  - Old oracles or tolerances that implicitly expected midpoint-advanced empirical evidence now fail.

- The `git status` hook blocked an initial pre-check when `git branch --show-current` was included.
  - The successful photocopy used the canonical skill sequence after a simpler `git status` pre-check.

### Relevant Files

Backend runner:

- `graph-editor/lib/runner/empirical_evidence_operator.py` — empirical strict evidence operator; core fix applied here.
- `graph-editor/lib/runner/prefix_arrival.py` — builds per-draw arrival weights used for reclocking evidence.
- `graph-editor/lib/runner/primitive_evidence.py` — applies arrival weights to evidence rows.
- `graph-editor/lib/runner/model_span_spine.py` — selected-cohort row reducer using empirical and conditioned spans.
- `graph-editor/lib/runner/subject_span_composer.py` — conditioned/model span composition; model-side propagated latent timing correction remains here.
- `graph-editor/lib/runner/timing_span.py` — shared timing composition used by prefix arrival.
- `graph-editor/lib/runner/request_envelope.py` — builds carrier and subject arrival maps for active cohort queries.

Tests:

- `graph-editor/lib/tests/test_evidence_clocking_spine_toy.py` — toy handler tests; new uniform-latency mass-conservation test added.
- `graph-editor/lib/tests/test_empirical_evidence_operator.py` — focused empirical operator tests; currently green after the fix.
- `graph-editor/lib/tests/test_model_span_spine_selected_cohort.py` — focused selected-cohort spine tests; currently green after the fix.
- `graph-editor/lib/tests/test_cohort_factorised_outside_in.py` — canonical outside-in oracle; currently has remaining failures and two accepted local edits.
- `graph-editor/lib/tests/test_multihop_evidence_parity.py` — cohort/window multi-hop parity canary; one evidence-y parity failure remains after the fix.

Docs / context:

- `docs/current/project-generalise/selected-cohort-projection-cutover-plan.md` — Stage 3/selected-cohort cutover plan and acceptance expectations.
- `docs/current/project-generalise/model-first-strict-span-cutover-plan-13-May-26.md` — broader no-branching cutover plan.
- `docs/current/project-generalise/window-cohort-multihop-evidence-degeneracy-note.md` — cohort/window lookup-binding invariants.
- `docs/current/codebase/CF_ENGINE_DISCIPLINE.md` — no defensive/fallback/branching rules for the CF engine.
- `docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` — semantic source for carrier vs subject and displayed `Y/X`.
- `docs/current/codebase/BE_RUNNER_CLUSTER.md`, `STATS_SUBSYSTEMS.md`, `FE_BE_STATS_PARALLELISM.md` — required runner-scope context.

### Next Steps

1. Inspect the exact current diff before editing further.
   - Files: `graph-editor/lib/runner/empirical_evidence_operator.py`, `graph-editor/lib/tests/test_evidence_clocking_spine_toy.py`, `graph-editor/lib/tests/test_cohort_factorised_outside_in.py`.
   - Confirm the only intended code change is removal of the hidden empirical midpoint shift.
   - Confirm no earlier unauthorised tolerance weakening remains except the two changes the user explicitly accepted.

2. Decide how to handle `test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x`.
   - File: `graph-editor/lib/tests/test_cohort_factorised_outside_in.py`.
   - Current failure after the empirical fix: strict evidence now lags the old raw selected oracle on the rising flank.
   - Do not loosen tolerances blindly. First decide whether the old oracle should be recomputed under the now-correct mass-conserving convention or whether the runtime still has an error.

3. Revisit `test_active_single_hop_evidence_matches_selected_a_clock_snapshot_oracle`.
   - File: `graph-editor/lib/tests/test_cohort_factorised_outside_in.py`.
   - It had recent tolerance/slack changes before this session. After the empirical fix, those assumptions may be stale.
   - Determine whether the single-hop oracle should now tighten or whether the fixture is exposing a separate convention mismatch.

4. Investigate model/evidence Epoch A parity as a model-quality problem.
   - Files likely involved: `graph-editor/lib/runner/subject_span_composer.py`, `graph-editor/lib/runner/model_span_spine.py`.
   - Do not change model-side Simpson correction casually. The user warned removing it could break forecast quality.
   - Compare model midpoint to strict evidence and to analytic/continuous or held-out truth after the empirical fix. The goal is forecast accuracy, not visual parity for its own sake.

5. Run focused tests after any model-side change.
   - Start with:
     - `graph-editor/lib/tests/test_evidence_clocking_spine_toy.py::test_uniform_latency_cohort_multihop_preserves_mass_conservation`
     - `graph-editor/lib/tests/test_empirical_evidence_operator.py`
     - `graph-editor/lib/tests/test_model_span_spine_selected_cohort.py`
   - Then outside-in:
     - `test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x`
     - `test_active_single_hop_evidence_matches_selected_a_clock_snapshot_oracle`
     - `test_window_multihop_evidence_matches_rate_attributed_db_oracle`
     - `test_multihop_evidence_parity.py`

6. Clean up test comments once semantics are settled.
   - Several comments in `test_cohort_factorised_outside_in.py` around recent single-hop tolerance changes may now be misleading if the empirical fix changes the expected gap.
   - Do not update comments until the actual final assertions are decided.

### Open Questions

- BLOCKING: Should the old outside-in raw selected-clock oracle be considered stale after the mass-conserving empirical fix?
  - Needs investigation against the hand-computable toy and real fixture traces.

- BLOCKING: What model-side convention maximises forecast accuracy while remaining comparable to correct strict evidence?
  - The user explicitly cares about forecast quality, not parity for parity's sake.
  - Do not remove model Simpson correction globally without proof.

- NON-BLOCKING: Should a separate display-only bucket-centred empirical surface ever exist?
  - This was discussed and effectively rejected for now because it risks parallel authorities and violates the no-branching discipline unless designed very carefully.

- NON-BLOCKING: Should the new uniform-latency toy be moved or split?
  - It currently lives in `test_evidence_clocking_spine_toy.py` and uses the handler boundary. That is useful, but a smaller direct spine-level variant may also be useful later.

