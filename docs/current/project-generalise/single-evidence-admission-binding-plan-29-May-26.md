# Daily Conversions Admission Cutover Plan

**Date:** 29-May-26  
**Status:** Replacement plan, daily-conversions first  
**Scope:** Remove daily conversions' bespoke pre-reducer path. Daily conversions must reach the same `ForecastPreparation` and `CFProjectionBundle` as cohort maturity before its existing reducer runs.

## Implementation Progress

- [x] Stage 0 - Pin The Daily Fork In Tests — completed 29-May-26
- [x] Stage 1 - Add A Tiny Forecast Admission Helper — completed 29-May-26
- [x] Stage 2 - Repoint Daily Conversions To Shared Admission — completed 29-May-26
- [x] Stage 3 - Add Daily Static Guards — completed 29-May-26 (progress-list title corrected: the §Stage 3 body is "Add Daily Static Guards"; the duplicate-fetch/read-mode fork deletion landed in Stage 2)
- [ ] Stage 4 - Public Daily Acceptance

## Code Facts

Daily conversions already has the reducer/readout it needs:

- `derive_daily_conversions(rows)` consumes raw snapshot rows and emits observed `data`, `rate_by_cohort`, `cohort_y_at_age`, `total_conversions`, and `date_range`.
- `reduce_daily_conversions_rows(bundle, observed)` consumes `CFProjectionBundle` plus that observed output and joins per-Cohort projection surfaces onto the observed rows.

The shared admitted row set already exists:

- `prepare_forecast_subject_entry(...)` calls `query_snapshots_for_sweep(...)`.
- It applies `apply_temporal_regime_selection(...)`.
- It stores the post-regime rows on `per_edge_result["evidence_superset_rows"]`.
- `prepare_forecast_subject_group(...)` returns those per-edge results inside `ForecastPreparation`.
- `prepare_cf_projection_bundle(...)` already consumes the same `ForecastPreparation.per_edge_results` to build primitive candidates and projection surfaces.

The daily bug is pre-reducer bespoke admission:

- `_handle_daily_conversions(...)` resolves subjects with `path_analysis_type='daily_conversions'`.
- That maps through `ANALYSIS_TYPE_READ_MODES['daily_conversions'] == 'raw_snapshots'`.
- It then separately calls `query_snapshots(...)`.
- It then separately applies `_apply_temporal_regime_selection(...)`.
- It then feeds that second row set into `derive_daily_conversions(...)`.

The correct observed input is already present on the shared preparation object:

`target_per_edge_result["evidence_superset_rows"] -> derive_daily_conversions(rows)`

The projection side is already shared enough for this cut:

- `build_cf_projection_bundle(...)` builds `FrameEvidence`, `ResolvedCFRuntime`, selected retrieval frontier, and `SelectedCohortRowProjection`.
- `model_span_spine.project_selected_cohort_rows(...)` emits the aggregate strict evidence, `f_*`, `ef_*`, and per-Cohort `ef_*_by_cohort` arrays.
- `reduce_daily_conversions_rows(bundle, observed)` reads the per-Cohort `ef_*_by_cohort` surfaces and joins them to `observed["rate_by_cohort"]` by `anchor_day`.

Therefore this plan must not change spine projection, FC surfaces, scalar reduction, or the daily date reducer. The daily-conversions change is where `subjects` and `observed` come from.

## Core Decision

For this plan, daily conversions becomes a thin client of the existing forecast admission and projection path:

`forecast admission -> ForecastPreparation -> CFProjectionBundle -> daily reducer`

Daily conversions may differ only at reducer/response shaping:

- observed surface: `derive_daily_conversions(admitted_rows_for_target(preparation))`;
- forecast surface: `reduce_daily_conversions_rows(prepared.bundle, observed)`.

Everything before that must be shared with the forecast/cohort-maturity admission path.

## Non-Negotiable Constraints

- Do not redesign `derive_daily_conversions(...)`.
- Do not redesign `reduce_daily_conversions_rows(...)`.
- Do not change `build_cf_projection_bundle(...)`.
- Do not change `model_span_spine.project_selected_cohort_rows(...)`.
- Do not change `reduce_cf_scalars(...)`.
- Do not push observed daily fields through latency-mapped projection arrays.
- Do not preserve `query_snapshots(...)` as a daily fallback.
- Do not preserve `path_analysis_type='daily_conversions'` for forecast-backed daily admission.

## Target Daily Path

After this plan, `_handle_daily_conversions(...)` should do only this before response framing:

1. Build shared forecast admission using the same subject/read semantics as cohort maturity.
2. Receive a `ForecastPreparation`.
3. Select the target `per_edge_result` from `preparation.per_edge_results`.
4. Set `observed = derive_daily_conversions(target_per_edge_result["evidence_superset_rows"])`.
5. Build `prepared = prepare_cf_projection_bundle(preparation, ...)`.
6. Set `result = reduce_daily_conversions_rows(prepared.bundle, observed)`.

There is no separate daily snapshot query and no daily-specific evidence-admission read mode.

## Stage 0 - Pin The Daily Fork In Tests

Purpose: prove the current failure starts before reducer logic.

Work:

- Add a focused test for the known query:
  `from(simple-a).to(simple-b).window(10-Jan-26:10-Jan-26).asat(20-Jan-26)`.
- Build daily's current `ForecastPreparation` path and extract target `evidence_superset_rows`.
- Build daily's current direct `query_snapshots(...)` path.
- Assert the two row sets differ today on the actual defect signature:
  - latest admitted `retrieved_at`;
  - selected evidence frontier;
  - strict `sum(y)` / `sum(x)` for the selected Cohort;
  - daily row completeness versus scalar completeness.
- Add a second assertion that `derive_daily_conversions(evidence_superset_rows)` is the intended observed input after the cutover.

Stop condition:

- Test proves current daily `query_snapshots(...)` rows differ from shared admitted rows.
- Test names both daily pre-reducer forks: `path_analysis_type='daily_conversions'` and direct `query_snapshots(...)`.

## Stage 1 - Add A Tiny Forecast Admission Helper

Purpose: avoid baking cohort-maturity as a magic string into daily.

Work:

- Add a small helper module: `graph-editor/lib/runner/forecast_admission.py`.
- In that module, add `admit_forecast_evidence(...)`. This is the named extraction surface for the cohort-maturity evidence binder.
- The helper wraps:
  - `resolve_forecast_subjects(...)` using the existing forecast/cohort-maturity read semantics;
  - `prepare_forecast_subject_group(...)`.
- The helper may return the existing `ForecastPreparation`.
- Add helper accessors:
  - `target_per_edge_result(preparation)`;
  - `admitted_rows_for_target(preparation)`;
  - `admission_fingerprint(preparation)`.
- `_handle_daily_conversions(...)` must import this helper module in Stage 2. It must not import or call cohort-maturity handler code.
- Do not move cohort maturity, conditioned forecast, or surprise gauge in this stage.

Stop condition:

- Helper produces the same `ForecastPreparation` as the current cohort-maturity path for the known query.
- No production handler has changed behaviour yet.

## Stage 2 - Repoint Daily Conversions To Shared Admission

Purpose: delete daily's bespoke pre-reducer path.

Work:

- In `_handle_daily_conversions(...)`, replace the current `resolve_forecast_subjects(... path_analysis_type='daily_conversions' ...)` plus `prepare_forecast_subject_group(...)` sequence with the Stage 1 helper.
- Delete the direct `query_snapshots(...)` call.
- Delete the direct `_apply_temporal_regime_selection(...)` call on daily's second row set.
- Build `observed` only from `admitted_rows_for_target(preparation)`.
- Keep `reduce_daily_conversions_rows(prepared.bundle, observed)` unchanged.
- Keep the public daily-conversions response shape unchanged.

Stop condition:

- `_handle_daily_conversions` no longer imports or calls `query_snapshots`.
- `_handle_daily_conversions` no longer passes `path_analysis_type='daily_conversions'` into forecast-backed admission.
- `_handle_daily_conversions` no longer calls `_apply_temporal_regime_selection(...)` directly.
- The Stage 0 row-set comparison passes because daily reads shared admitted rows.
- The known daily completeness mismatch is no longer caused by admission-row divergence.

## Stage 3 - Add Daily Static Guards

Purpose: make the daily cleanup hard to regress.

Work:

- Add a static test that fails if `_handle_daily_conversions` imports or calls `query_snapshots`.
- Add a static test that fails if `_handle_daily_conversions` passes `path_analysis_type='daily_conversions'`.
- Add a static test that fails if `_handle_daily_conversions` calls `_apply_temporal_regime_selection(...)`.
- Add a focused behavioural test that compares daily's admission fingerprint to cohort maturity's for the known query.

Stop condition:

- Static guards fail on the old daily code and pass on the cutover.
- Daily and cohort maturity share the same admitted-row fingerprint for the known query.

## Stage 4 - Public Daily Acceptance

Purpose: prove the daily villain is neutralised without changing the spine.

Work:

- Run the known public daily-conversions test against:
  - `daily_conversions`;
  - `conditioned_forecast`;
  - param-pack/scalar output where relevant.
- Verify daily observed rows are still produced by `derive_daily_conversions(...)`.
- Verify daily forecast enrichment fields are still produced by `reduce_daily_conversions_rows(...)`.
- Verify `build_cf_projection_bundle(...)`, `model_span_spine.project_selected_cohort_rows(...)`, and `reduce_cf_scalars(...)` are untouched by this stage.

Stop condition:

- The current daily mismatch is closed.
- Daily has no evidence-admission code of its own.
- The next cleanup can move `surprise_gauge` and `conditioned_forecast` onto the same helper without daily-specific complications.

## Non-Goals

- Do not redesign `derive_daily_conversions`.
- Do not redesign `derive_cohort_maturity`.
- Do not redesign `CFProjectionBundle`.
- Do not redesign `ResolvedCFRuntime`.
- Do not redesign `model_span_spine.project_selected_cohort_rows`.
- Do not redesign `reduce_daily_conversions_rows`.
- Do not change primitive conditioning.
- Do not introduce a new evidence algebra.
- Do not migrate `conditioned_forecast`.
- Do not migrate `surprise_gauge`.
- Do not migrate unrelated observed-only analyses.

## Appendix A - Target Analysis Production Schematic

```
REQUEST
  |
  |  graph + subject DSL + temporal DSL + candidate regimes + context/asat
  v
SUBJECT RESOLUTION
  |
  |  forecast-backed paths use forecast/cohort-maturity admission semantics
  |  final analysis type must not choose read mode
  v
FORECAST EVIDENCE ADMISSION
  |
  |  prepare_forecast_subject_group(...)
  |
  +-- per subject:
  |     |
  |     |  prepare_forecast_subject_entry(...)
  |     |    -> query_snapshots_for_sweep(...)
  |     |    -> apply_temporal_regime_selection(...)
  |     |    -> derive_cohort_maturity(...)
  |     |
  |     v
  |   per_edge_result
  |     |
  |     +-- evidence_superset_rows      raw admitted rows after regime selection
  |     +-- derivation_result           cohort-maturity frame materialisation
  |     +-- subject metadata            target id, path role, from/to
  |
  +-- composed_frames                  span_evidence composition over per-edge frames
  +-- envelope_plan                    request-envelope / arrival-map fetch bounds
  |
  v
FORECAST PREPARATION
  ForecastPreparation(
    per_edge_results,
    composed_frames,
    envelope_plan,
    query_from_node,
    query_to_node,
    anchor_node,
    last_edge_id,
    bounds/provenance
  )
  |
  v
PROJECTION / SPINE
  |
  |  prepare_cf_projection_bundle(ForecastPreparation, ...)
  |     |
  |     +-- prepare_forecast_runtime_inputs(...)
  |     |     |
  |     |     |  consumes composed_frames + per_edge_results + envelope_plan
  |     |     v
  |     |   runtime inputs / resolved model
  |     |
  |     +-- build candidate pools from per_edge_results["evidence_superset_rows"]
  |     |     |
  |     |     +-- build_superset_candidates_by_edge(...)
  |     |     +-- build_carrier_superset_candidates_by_edge(...)
  |     |
  |     +-- build_cohort_evidence_from_frames(...)
  |     +-- build_resolved_cf_runtime(...)
  |     +-- model_span_spine.project_selected_cohort_rows(...)
  |     |
  |     v
  |   CFProjectionBundle
  |     |
  |     +-- FrameEvidence
  |     +-- ResolvedCFRuntime
  |     +-- SelectedRetrievalFrontier
  |     +-- SelectedCohortRowProjection
  |           |
  |           +-- aggregate strict evidence / f_* / ef_* surfaces
  |           +-- per-Cohort ef_*_by_cohort surfaces
  |
  v
REDUCER SELECTION
  |
  |  Nothing above this point is selected by final analysis type.
  |  Analysis type chooses only the reducer / response envelope below.


PUBLIC REDUCERS
  |
  +-- cohort_maturity
  |     |
  |     |  reduce_cohort_maturity_rows(CFProjectionBundle)
  |     |  reads aggregate tau surfaces from SelectedCohortRowProjection
  |     v
  |   rows by tau
  |
  +-- daily_conversions
  |     |
  |     |  observed = derive_daily_conversions(
  |     |      target_per_edge_result["evidence_superset_rows"]
  |     |  )
  |     |
  |     |  reduce_daily_conversions_rows(CFProjectionBundle, observed)
  |     |  joins observed.rate_by_cohort rows to per-Cohort ef_* surfaces
  |     v
  |   daily observed fields + forecast enrichment fields
  |
  +-- conditioned_forecast / param-pack scalar
        |
        |  reduce_cf_scalars(CFProjectionBundle)
        |  reads scalar reductions over the same bundle
        v
      scalar probability / completeness / evidence fields


THE BUG TO REMOVE
  |
  |  current _handle_daily_conversions forks before reducer selection:
  |
  |    resolve_forecast_subjects(path_analysis_type='daily_conversions')
  |
  |  and then does this extra observed-row admission path:
  |
  |    query_snapshots(...)
  |      -> apply_temporal_regime_selection(...)
  |      -> derive_daily_conversions(...)
  |
  |  Both are pre-reducer forks. Both must be deleted/repointed so
  |  daily_conversions follows the same REQUEST -> CFProjectionBundle path
  |  as cohort_maturity and conditioned_forecast before reducer selection.
  |
  v
DELETE THESE PRE-REDUCER FORKS
```

## Appendix B - Current Code Divergence Audit

The "improved four" in this plan are:

- `cohort_maturity`;
- `daily_conversions`;
- `conditioned_forecast`;
- `surprise_gauge`.

They are the forecast-backed analyses that should share one path until reducer selection. The following list is the current code reality.

### Frontend / Transport Divergences

`cohort_maturity`, `daily_conversions`, and `surprise_gauge` normally dispatch through `/api/runner/analyze`:

- FE path: `runPreparedAnalysis(...) -> runBackendAnalysis(...)`;
- single-scenario transport: `graphComputeClient.analyzeSelection(...)`;
- multi-scenario transport: `graphComputeClient.analyzeMultipleScenarios(...)`;
- BE dispatch: `handle_runner_analyze(...)`.

`conditioned_forecast` is special-cased before `/api/runner/analyze`:

- FE path: `runPreparedAnalysis(...) -> runBackendAnalysis(...)`;
- special branch: `if prepared.analysisType === 'conditioned_forecast'`;
- transport: `graphComputeClient.forecastConditionedScenarios(...)`;
- endpoint: `/api/forecast/conditioned`;
- BE dispatch: `_handle_conditioned_forecast_impl(...)`.

There is also a separate browser graph-mutating conditioned-forecast enrichment path:

- `conditionedForecastService.runConditionedForecast(...)`;
- used by the fetch/materialisation pipeline;
- distinct from read-only `graphComputeClient.forecastConditionedScenarios(...)`;
- not one of the reducer analyses, but it feeds param-pack output through graph enrichment.

### Backend Entry-Point Divergences

`cohort_maturity` has its own handler:

- `_handle_cohort_maturity_v3(...)`;
- calls `resolve_forecast_subjects(... path_analysis_type='cohort_maturity', whole_graph_analysis_type=None)`;
- calls `prepare_forecast_subject_group(...)`;
- calls `prepare_cf_projection_bundle(...)`;
- calls `reducer_for('cohort_maturity')`.

`daily_conversions` has its own handler:

- `_handle_daily_conversions(...)`;
- calls `resolve_forecast_subjects(... path_analysis_type='daily_conversions', whole_graph_analysis_type=None)`;
- calls `prepare_forecast_subject_group(...)`;
- then performs a second direct observed-row fetch via `query_snapshots(...)`;
- calls `_apply_temporal_regime_selection(...)` on that second row set;
- calls `derive_daily_conversions(...)` on that second row set;
- calls `prepare_cf_projection_bundle(...)`;
- calls `reducer_for('daily_conversions')`.

`conditioned_forecast` has its own endpoint handler:

- `_handle_conditioned_forecast_impl(...)`;
- calls `resolve_forecast_subjects(... path_analysis_type='cohort_maturity', whole_graph_analysis_type='conditioned_forecast')`;
- splits into whole-graph versus path-scoped subject groups;
- in whole-graph mode, topologically orders subjects and processes one edge group at a time;
- calls `prepare_forecast_subject_group(...)` per subject group;
- calls `prepare_cf_scalar_bundle(...)`;
- calls `reduce_cf_scalars(...)`;
- frames the scalar fields as `p_mean`, `p_sd`, `p_sd_epistemic`, `completeness`, evidence `k/n`.

`surprise_gauge` enters through the generic snapshot handler:

- `_handle_snapshot_analyze_subjects(...)` detects `analysis_type == 'surprise_gauge'`;
- calls `_compute_surprise_gauge(...)`;
- `_compute_surprise_gauge(...)` receives a pre-resolved `subj` rather than calling `resolve_forecast_subjects(...)`;
- calls `prepare_forecast_subject_group(...)` with `subjects=[subj]`;
- calls `prepare_cf_scalar_bundle(...)`;
- calls `reduce_cf_scalars(...)`;
- frames the scalar reducer output into gauge z-scores.

### Subject Resolution Divergences

`cohort_maturity` uses forecast-style path resolution:

- final analysis type passed to subject resolution: `cohort_maturity`;
- `ANALYSIS_TYPE_READ_MODES['cohort_maturity'] == 'cohort_maturity'`;
- `_resolve_sweep_bounds(...)` sets sweep bounds and caps by `asat`.

`daily_conversions` uses daily-specific path resolution:

- final analysis type passed to subject resolution: `daily_conversions`;
- `ANALYSIS_TYPE_READ_MODES['daily_conversions'] == 'raw_snapshots'`;
- `_resolve_sweep_bounds(...)` returns `(None, None)`;
- this means the `subjects` handed into `prepare_forecast_subject_group(...)` are already stamped differently before the shared preparation function runs.

`conditioned_forecast` has two resolution modes:

- path-scoped mode uses `path_analysis_type='cohort_maturity'`;
- whole-graph mode uses `whole_graph_analysis_type='conditioned_forecast'`;
- `ANALYSIS_TYPE_SCOPE_RULES['conditioned_forecast'] == 'all_graph_parameters'`;
- `ANALYSIS_TYPE_READ_MODES['conditioned_forecast'] == 'cohort_maturity'`;
- whole-graph mode then rewrites each subject as `path_role='only'` before per-edge preparation.

`surprise_gauge` does not call `resolve_forecast_subjects(...)` inside `_compute_surprise_gauge(...)`:

- it receives `subj` from `_handle_snapshot_analyze_subjects(...)`;
- FE registry declares `surprise_gauge.snapshotContract.readMode = 'sweep_simple'`;
- BE `ANALYSIS_TYPE_READ_MODES['surprise_gauge'] == 'sweep_simple'`;
- `_compute_surprise_gauge(...)` infers `is_window` from `slice_keys` and raw DSL string, not from a shared resolved request object.

### Evidence Admission Divergences

All four eventually call `prepare_forecast_subject_group(...)`, but not from the same resolved input shape.

`cohort_maturity`:

- one call to `prepare_forecast_subject_group(...)`;
- subject list came from `path_analysis_type='cohort_maturity'`;
- no second snapshot fetch for the reducer.

`daily_conversions`:

- one call to `prepare_forecast_subject_group(...)`;
- subject list came from `path_analysis_type='daily_conversions'`;
- second direct fetch: `query_snapshots(...)`;
- second regime selection: `_apply_temporal_regime_selection(...)`;
- second raw-row reducer input: `derive_daily_conversions(rows_from_query_snapshots)`.

`conditioned_forecast`:

- calls `prepare_forecast_subject_group(...)` inside a request-scoped `use_request_settings(...)` override that lowers `mc_draws`;
- whole-graph mode carries a running `all_per_edge_results` donor cache across edge groups;
- path-scoped mode still enters through the conditioned-forecast endpoint rather than `/api/runner/analyze`.

`surprise_gauge`:

- does pre-admission model resolution with `resolve_model_params(...)`;
- refuses before evidence admission when no resolved params or `sigma <= 0`;
- requires snapshot subject fields before evidence admission;
- calls `prepare_forecast_subject_group(...)` only after those checks;
- derives display `retrieved_at` from `preparation.per_edge_results[0]["derivation_result"]["frames"]`, not from a shared admission fingerprint.

### Projection / Bundle Divergences

`cohort_maturity` calls `prepare_cf_projection_bundle(...)` with:

- `include_epistemic_overlay=True`;
- `use_prepared_resolved=True`;
- `show_model_curve=display_settings.show_model_curve`;
- `per_edge_results_by_uuid={}`.

`daily_conversions` calls `prepare_cf_projection_bundle(...)` with:

- `include_epistemic_overlay=False`;
- `use_prepared_resolved=False`;
- `show_model_curve=False`;
- `per_edge_results_by_uuid={}`.

`conditioned_forecast` calls `prepare_cf_scalar_bundle(...)` with:

- scalar-only helper;
- `show_model_curve` hardcoded off by the helper;
- `use_prepared_resolved` hardcoded off by the helper;
- `include_epistemic_overlay=True` at the current call site;
- `per_edge_results_by_uuid=all_per_edge_results`;
- request-scoped reduced draw count.

`surprise_gauge` calls `prepare_cf_scalar_bundle(...)` with:

- scalar-only helper;
- `include_epistemic_overlay=True`;
- `per_edge_results_by_uuid={}`;
- default current forecast settings rather than the conditioned-forecast endpoint's reduced-draw wrapper.

### Reducer / Response Divergences

These are the intended differences and should remain after the cleanup:

- `cohort_maturity` uses `reduce_cohort_maturity_rows(...)` and emits rows by tau.
- `daily_conversions` uses `derive_daily_conversions(...)` for observed fields, then `reduce_daily_conversions_rows(...)` to join those rows to per-Cohort projection surfaces.
- `conditioned_forecast` uses `reduce_cf_scalars(...)` and maps scalar reducer fields onto the conditioned-forecast response schema.
- `surprise_gauge` uses `reduce_cf_scalars(...)` and maps scalar reducer fields onto two z-score gauge variables.

### Pre-Reducer Divergences That Must Be Removed

These violate the target invariant directly:

- `daily_conversions` passes `path_analysis_type='daily_conversions'` before admission.
- `daily_conversions` has a second `query_snapshots(...)` admission path.
- `daily_conversions` runs a second `_apply_temporal_regime_selection(...)`.
- `surprise_gauge` receives a pre-resolved `subj` from the generic snapshot path instead of using the same named forecast admission entry point.
- `surprise_gauge` infers window/cohort from `slice_keys` and raw DSL string instead of the shared resolved request object.
- `surprise_gauge` resolves model params and may refuse before evidence admission, while the other forecast-backed paths let bundle/runtime construction own that boundary.
- `conditioned_forecast` is transported through a separate endpoint before reaching the backend, so it bypasses the `/api/runner/analyze` envelope used by the other three analyses.
- `conditioned_forecast` whole-graph mode has a topological subject-group loop and donor-cache threading that path analyses do not use.

### Post-Reducer Differences That Are Allowed

These are response-shape differences only:

- cohort maturity tau rows;
- daily conversion date/Cohort rows;
- conditioned-forecast graph-write scalar fields;
- surprise-gauge z-score variables.

They must remain downstream of the single shared path to `CFProjectionBundle`.
