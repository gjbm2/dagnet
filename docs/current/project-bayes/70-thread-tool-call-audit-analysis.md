# Thread-Derived Change Analysis

This analysis is tied to the retained disk records used in the other three audit artefacts:

- `67-thread-tool-call-audit-before-start.md`
- `68-thread-tool-call-audit-after-reversion.md`
- `69-thread-tool-call-audit-diff.md`

It covers the **net residual changes after the partial reversion**, not the fully reverted prepare-step split itself.

## Scope note

The retained records capture changed regions, not full-file snapshots. The analysis below is therefore about each surviving changed region, which is the part that still affects the tree after the rollback.

## `graph-editor/lib/api_handlers.py`

1. `_compute_surprise_gauge()` no longer consults `should_enable_direct_cohort_p_conditioning()`.

This is behavioural. It removes the only retained admission seam for exact-subject direct cohort conditioning in the surprise-gauge path.

2. `_compute_surprise_gauge()` now hardcodes `p_conditioning_source='aggregate_evidence'`.

This is behavioural. It erases provenance that previously distinguished the direct exact-subject cohort path from the generic aggregate path.

3. `_fetch_upstream_observations()` no longer accepts `subject_is_window`; donor subjects are always prepared with `subject_is_window=True`.

This is behavioural and high-risk. For cohort-mode donor reads, it can bind upstream evidence on the window family even when the caller was cohort-rooted.

4. `_handle_cohort_maturity_v3()` now delegates runtime assembly to `prepare_forecast_runtime_inputs()`.

This is behavioural, not cosmetic. The row-builder API rollback happened, but the handler still moved onto the new shared runtime builder, so the refactor was only partially reverted.

5. `handle_conditioned_forecast()` now delegates runtime assembly to `prepare_forecast_runtime_inputs()`.

This is behavioural for the same reason as the v3 handler change. CF and v3 now share a new runtime-preparation seam that did not exist before the thread.

6. The handler call-sites stopped passing `edge_cdf_arr`, `det_span_p`, and `display_settings` in the retained net hunks.

This is behavioural where those values previously influenced execution, and at minimum it narrows the explicit input surface seen by `compute_cohort_maturity_rows_v3()`.

## `graph-editor/lib/runner/cohort_forecast_v3.py`

1. The monolithic `compute_cohort_maturity_rows_v3(...)` API was restored.

This is mostly rollback, not a residual bug by itself. It matters because the file is no longer on the two-step prepare/project split.

2. `_direct_cohort_p_conditioning` is forcibly set to `False` inside `_prepare_runtime_bundle()`.

This is behavioural. It leaves the old admission-shaped wiring in place while guaranteeing that the path can never be taken.

3. The import of `should_enable_direct_cohort_p_conditioning()` was removed.

This is behavioural only because of item 2; on its own it would be a compatibility cleanup.

4. The remaining `FrameEvidence` movement and many small formatting edits are not behaviourally important.

These are churn, but they are not the changes driving the instability.

## `graph-editor/lib/runner/forecast_runtime.py`

1. `PreparedConditioningEvidence.direct_cohort_enabled` was removed.

This is behavioural at the contract layer. The runtime bundle can no longer serialise or retain that distinction.

2. `build_prepared_runtime_bundle()` now discards `p_conditioning_direct_cohort`.

This is behavioural. The runtime-builder signature still admits the concept, but the implementation explicitly throws it away.

3. `build_prepared_runtime_bundle()` now defaults `temporal_family` to `'window'` whenever no explicit value is provided.

This is behavioural. The earlier fallback preserved `mode == 'cohort'`; the new one does not.

4. `serialise_runtime_bundle()` no longer exposes `direct_cohort_enabled`.

This is a contract change. Downstream inspection and tests can no longer observe that field.

5. `should_enable_direct_cohort_p_conditioning()` was re-added as a no-op that always returns `False`.

This is behavioural and misleading. It makes the code look wired for WP8-style admission while guaranteeing that it never admits.

6. `PreparedForecastSolveInputs`, `_resolve_subject_temporal_mode()`, and `prepare_forecast_runtime_inputs()` were added.

This is the biggest surviving structural change. It is not just refactoring churn; both handlers now depend on this new shared runtime-preparation layer.

7. `_resolve_subject_temporal_mode()` switches the resolved rate family based on `A != X`.

This is behavioural. It changes which posterior family the shared runtime builder resolves for cohort-mode subjects.

## `graph-editor/lib/runner/forecast_state.py`

1. Zero-denominator fallback now keeps upstream carrier shape by convolving the upstream carrier with the subject span when carrier data exists.

This is behavioural. It changes the degenerate curve family used when the population model produces no denominator mass.

2. IS/rate conditioning is now skipped whenever `resolved.alpha_beta_query_scoped` is true.

This is behavioural. Query-scoped resolved posteriors bypass the old conditioning path entirely.

3. Completeness weighting now falls back from `x_frozen` to `a_pop` when `x_frozen <= 0`.

This is behavioural. It changes the cohort weighting used in the completeness aggregate.

## `graph-editor/lib/tests/test_cf_query_scoped_degradation.py`

1. `NOTE:` blocks were added explaining why red tests might now be attributable to the deleted degraded branch rather than missing provenance.

These comments are not behaviour, but they explicitly rationalise changed semantics in the tests.

2. Capture and assertion of `p_conditioning_direct_cohort` were removed.

This weakens the test contract. It stops checking the direct-cohort flag entirely.

3. The expected source changed from `'direct_cohort_exact_subject'` to `'aggregate_evidence'`.

This is a test expectation rewrite reflecting the behavioural regression in `api_handlers.py`.

## `graph-editor/lib/tests/test_cohort_maturity_v3_contract.py`

1. The retained net change is only the position of `band_level=0.90`.

This is cosmetic in the saved net diff.

## `graph-editor/lib/tests/test_v2_v3_parity.py`

1. `subject_is_window` was flipped from `False` to `True` in the preparation fixture.

This is behavioural in the test harness. It changes the semantic family the test is exercising.

2. Capture of `p_conditioning_direct_cohort` was removed.

This weakens the observable contract of the runtime-bundle call.

3. Expectations changed from `'direct_cohort_exact_subject'` to `'snapshot_frames'`.

This is a test expectation rewrite reflecting the new shared-runtime path rather than the old direct-cohort path.

## `docs/current/project-bayes/66-shared-cf-runtime-and-wp8-admission-plan.md`

1. Stage 2 was expanded to make the shared runtime-builder extraction explicit.

This is a documentation change only, but it matters because the code then partially implemented that plan and only partially rolled it back.

2. Stage 3 was tightened to say the row builder should become projection-only after Stage 2.

Again documentation-only, but it recorded the refactor direction that drove the subsequent churn.

## Bottom line

The residual state after the rollback is not “back where it started”. The prepare/project split in `cohort_forecast_v3.py` was removed, but the new shared runtime-preparation layer, the surprise-gauge provenance collapse, the hardcoded donor `subject_is_window=True`, the direct-cohort no-op wiring, the `forecast_state.py` engine changes, and the matching test expectation rewrites all remain in the retained post-reversion diff.
