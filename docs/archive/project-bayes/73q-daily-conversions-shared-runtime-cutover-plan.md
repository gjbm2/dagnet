# 73q Daily Conversions Shared Runtime Cutover Plan

**Status**: Proposal — 4-May-26  
**Scope**: Transition daily conversions from the bespoke legacy trajectory path onto the current shared CF runtime machinery, without implementing 73p hierarchical per-Cohort conditioning.

## Summary

Daily conversions currently derives observed daily deltas from snapshot rows, then enriches `rate_by_cohort` rows through two direct `compute_forecast_trajectory` calls in `api_handlers.py`: one for `projected_y` / `forecast_y`, and one optional sweep for latency bands. That keeps daily conversions on the old trajectory engine after the main CF row/scalar path has moved to `ResolvedCFRuntime`.

This plan cuts over daily conversions to the current shared CF machinery on an **as-is semantic basis**:

- The selected set of **Cohorts** is still the set scoped by the `window()` or `cohort()` query.
- Conditioning remains the current request-level aggregated conditioning over that selected set of Cohorts.
- There is no per-Cohort posterior, no hierarchical MAP fit, no per-Cohort partial pooling, and no 73p batched `(N, S, T)` composition substrate.
- Daily conversions becomes a projectio; of the shared runtime plus the selected Cohort evidence table.

The intended result is one atomic edit set: one runtime-backed daily-conversions projection helper, one API-handler cutover, focused tests, and removal of the old daily-conversions `compute_forecast_trajectory` calls.

Compatibility target: preserve the broad daily-conversions semantics that are already right, not every incidental arithmetic detail of the old bespoke path. Where the legacy trajectory arithmetic and the current shared runtime disagree, the cutover should prefer the shared runtime if it is answering the same semantic question more directly.

## Terminology

Capitalisation is semantic.

- **Cohort** means the dated population selected by the query.
- **`cohort()`** means the QueryDSL mode.
- **Cohort mode** means the semantics selected by `cohort()`.
- **Window mode** means the semantics selected by `window()`.

Do not use lower-case "cohort" as a generic population term in the plan, code comments, or tests added for this work.

## Current State

`derive_daily_conversions` already owns observed snapshot arithmetic:

- `data`: observed daily deltas by `retrieved_at` date.
- `rate_by_cohort`: latest observed `x`, `y`, and `rate` per Cohort.
- `cohort_y_at_age`: observed cumulative `y` per Cohort age, used by latency-band evidence overlays.

The bespoke part is the enrichment block in `api_handlers.py` after `derive_daily_conversions` returns. It:

- resolves model params separately for daily conversions;
- constructs ad hoc `CohortEvidence` objects from `rate_by_cohort`;
- calls `compute_forecast_trajectory` at a maturity horizon to set `projected_y`, `forecast_y`, `completeness`, `layer`, and `forecast_bands`;
- optionally calls `compute_forecast_trajectory` once per latency-band tau to fill `latency_bands`;
- falls back to `annotate_rows` if the engine annotation fails.

That is now the wrong ownership boundary. Daily conversions should not own a second forecast engine call path. It should ask the same request-scoped CF runtime that powers Cohort maturity rows for conditioned subject/carrier surfaces, then perform only daily-conversions-specific date/count projection.

## Full Input Audit

Daily conversions is not a single-function input. It is assembled from the FE request envelope, BE subject resolution, snapshot reads, observed derivation, model/runtime preparation, display options, and FE normalisation. The cutover must preserve every one of these inputs or explicitly mark a legacy branch out of scope.

### FE request envelope

Modern callers send daily conversions through `/api/runner/analyze` with the snapshot-analysis shape.

Required top-level inputs:

- `analysis_type = 'daily_conversions'`.
- `analytics_dsl`: the subject path, such as `from(X).to(Y)`.
- `scenarios`: one or more scenario entries.
- `display_settings`: compute-affecting subset only; for daily conversions the live compute-affecting key is `show_latency_bands`.
- `mece_dimensions`: context dimensions safe to aggregate.
- `forecasting_settings`: present on the request but not a daily-conversions-specific authority.
- `no_cache`: optional cache bypass.

Per-scenario inputs:

- `scenario_id`, `name`, `colour`, and `visibility_mode`.
- `graph`: already scenario-materialised and re-contexted for the scenario's effective DSL.
- `effective_query_dsl`: the temporal/query-scope DSL, including `window()` or `cohort()`, optional `asat()` / `at()`, context clauses, and any current-layer chart constraint.
- `candidate_regimes_by_edge`: FE-computed candidate hash families per edge, separated by temporal family and context family.
- Legacy-only `snapshot_subjects`: still accepted by the BE fallback path, but modern preparation expects the BE to resolve subjects from `analytics_dsl` plus `effective_query_dsl`.

The cache/signature boundary includes the scenario graph, effective DSL, visibility mode, display settings, and, for older prepared shapes, snapshot subject coordinates. The cutover must not introduce an unkeyed daily-conversions input.

### BE subject-resolution inputs

`analysis_subject_resolution.py` classifies `daily_conversions` as:

- scope rule: `funnel_path`;
- read mode: `raw_snapshots`.

The resolver consumes:

- graph topology;
- the composed DSL (`analytics_dsl` plus per-scenario `effective_query_dsl`);
- `candidate_regimes_by_edge`;
- extracted `window()` or `cohort()` date bounds;
- path roles for each subject edge.

It synthesises subject dicts containing:

- `subject_id`;
- `param_id`;
- `core_hash`;
- `equivalent_hashes`;
- `candidate_regimes`;
- `read_mode`;
- `anchor_from`, `anchor_to`;
- `slice_keys`;
- `target.targetId`;
- `from_node`, `to_node`;
- `path_role`.

For daily conversions, the resolver does **not** populate `sweep_from` / `sweep_to`; those belong to sweep read modes. That matters: the observed derivation reads raw snapshots with an optional `as_at` ceiling, while the shared runtime may need a sweep-like prepared frame bundle to build evidence candidates and per-edge evidence sets.

### Snapshot-read inputs

The current daily-conversions derivation path reads snapshots through `query_snapshots`, not `query_snapshots_for_sweep`.

Inputs to `query_snapshots`:

- `param_id`;
- `core_hash`;
- `equivalent_hashes`;
- `slice_keys`;
- `anchor_from`, `anchor_to`;
- optional `as_at`;
- optional `retrieved_ats`;
- limit.

The query returns rows with:

- `param_id`, `core_hash`, `slice_key`;
- `anchor_day`;
- `retrieved_at`;
- `a`, `x`, `y`;
- latency observation fields: `median_lag_days`, `mean_lag_days`, `anchor_median_lag_days`, `anchor_mean_lag_days`, `onset_delta_days`.

After the DB read, `_apply_temporal_regime_selection` / `_apply_snapshot_regime_selection` may reduce the row set to one preferred regime per retrieval date. This is not optional: daily conversions must not sum multiple regimes for the same edge/date and double-count.

### Observed derivation inputs

`derive_daily_conversions` consumes the post-regime-selection rows. It requires:

- `anchor_day`;
- `retrieved_at`;
- `slice_key`, defaulting to empty string;
- `x` / `X`;
- `y` / `Y`.

Its observed arithmetic is:

- group rows by `(anchor_day, slice_key)`;
- sort each series by `retrieved_at`;
- compute positive `Y` deltas within each series and sum them by `retrieved_at` calendar date;
- take the latest `x` and `y` per `(anchor_day, slice_key)` and sum across slices to build one `rate_by_cohort` row per selected Cohort;
- carry forward each slice's cumulative `y` by Cohort age and sum across slices to build `cohort_y_at_age`.

These outputs remain authoritative evidence inputs after the cutover. The runtime projection must not rewrite them.

### Current bespoke enrichment inputs

The old enrichment block consumes:

- the scenario graph;
- `target_id` from the subject;
- the inferred Window mode / Cohort mode flag;
- model source preference from the graph;
- resolved model params for the target edge;
- `effective_query_dsl` to extract `asat()` / `at()` and derive the evaluation date;
- `rate_by_cohort`;
- `cohort_y_at_age`;
- `display_settings.show_latency_bands`;
- latency quantiles from the resolved latency distribution.

It then creates `CohortEvidence` and calls `compute_forecast_trajectory` twice in the daily-conversions path. Those two calls are the implementation detail this plan removes. The input information they use must either be carried into the shared runtime or into the new projection helper.

### Shared-runtime inputs required by the cutover

Building `ResolvedCFRuntime` for daily conversions requires more than the observed `rate_by_cohort` table. The runtime builder needs the same class of inputs currently supplied by Cohort maturity / CF paths:

- graph;
- target edge id;
- query-from node `X`;
- query end node;
- selected anchor range;
- runtime horizon / `sweep_to` equivalent;
- `as_at`;
- scenario id;
- Window mode versus Cohort mode;
- whether the subject span is multi-hop;
- anchor node id for Cohort mode;
- resolved target model params;
- typed target evidence set and/or raw evidence candidates;
- target subject metadata for retrieval widening;
- per-edge subject evidence for non-target subject primitives;
- per-edge upstream evidence for carrier primitives in active Cohort mode;
- unconditioned overlay basis if latency-band or model-overlay projections need it.

The cutover must therefore introduce a small daily-conversions preparation step, not just a projection helper. That preparation step should reuse existing shared helpers where possible:

- subject resolution from `analysis_subject_resolution`;
- snapshot/regime preparation from `forecast_preparation.prepare_forecast_subject_entry` and `prepare_forecast_subject_group`;
- per-edge evidence map builders in `cohort_forecast_v3.py`;
- `build_resolved_cf_runtime`.

The preparation step must be explicit about the two evidence needs:

- observed daily conversions read raw snapshots and produce `data`, `rate_by_cohort`, and `cohort_y_at_age`;
- runtime conditioning/composition needs candidate material and per-edge evidence maps aligned with primitive clocks.

Those are related inputs, not interchangeable tables.

### Projection helper inputs

Once the runtime exists, the daily-conversions projection helper should consume:

- `ResolvedCFRuntime`;
- selected Cohort rows from `rate_by_cohort`;
- `cohort_y_at_age`;
- the observed `data` date range and any forecast date range chosen by the caller;
- `as_at` / evaluation date;
- display settings, especially latency-band toggle and band level if forecast bands are shown;
- mode metadata for Window mode versus Cohort mode, query-from `X`, anchor node `A`, and subject end.

It should return:

- enriched `rate_by_cohort` rows;
- optional additive forecast calendar-date rows if the caller needs a projected daily-count series;
- projection provenance when runtime projection is unavailable or degraded;
- `promoted_source` carried through from the runtime's resolved model record, preserving the FE hint that the legacy enrichment currently emits from `_resolved.source`.

### FE output inputs

`graphComputeClient.ts` normalises daily conversions by preferring `rate_by_cohort` over raw `data`.

The FE currently reads these backend fields:

- from `rate_by_cohort`: `date`, `x`, `y`, `rate`, `completeness`, `layer`, `evidence_y`, `forecast_y`, `projected_y`, `forecast_bands`, `latency_bands`;
- from the result: `total_conversions`, `date_range`, `promoted_source`;
- from the request: scenario labels/colours/visibility and subject labels.

Preserving the existing FE shape means the BE may add projected date-series fields, but it must not remove or rename the existing fields without a separate FE atom.

## Semantic Preservation Target

The old path is broadly correct in the questions it asks:

- observed daily conversions are evidence deltas from snapshot rows;
- each `rate_by_cohort` row represents one selected Cohort's latest observed `x`, `y`, and `Y / X` rate;
- immature selected Cohorts get projected future `Y` rather than being frozen at observed `y`;
- Window mode and Cohort mode remain different when the carrier is not identity;
- optional latency bands display evidence when the selected Cohort is old enough and forecast bands otherwise.

Those behaviours should survive the cutover.

The old path is not treated as a perfect arithmetic oracle. In particular, it is acceptable for projected counts or bands to move when the old trajectory path was reconstructing timing/probability state that the shared runtime now owns. The acceptance question is whether the new value is a projection of the correct runtime object for the same selected set of Cohorts, not whether it matches the old call to `compute_forecast_trajectory` exactly.

Non-negotiable preservation points:

- `data` remains observed evidence, not forecast output.
- `rate_by_cohort[].y` and `rate_by_cohort[].x` remain observed latest values.
- `projected_y` remains an eventual or requested-horizon projected count for the selected Cohort, not a rate.
- `forecast_y` remains the non-negative projected residual over observed `y`.
- `forecast_bands` and forecast `latency_bands` remain rate bands over `Y / X`.
- active Cohort mode uses the runtime's `A -> X` carrier for denominator arrival and the runtime's `X -> end` subject span for numerator progression.

## Arithmetic Authority

The shared runtime is the authority for conditioned probability and timing surfaces. Daily conversions should not reproduce the legacy trajectory engine's internal Pop C / Pop D implementation line for line.

The projection helper should instead encode only the accounting that is genuinely specific to daily conversions:

- selected Cohort identity and `anchor_day`;
- observed latest `x`, `y`, and `y_at_age`;
- calendar date to Cohort-age mapping;
- count scaling from runtime rate/probability surfaces to Cohort mass;
- cumulative-to-daily differencing for forecast calendar-date rows, if emitted.

If this exposes a mismatch between the old count arithmetic and the shared runtime projection, the test should assert the semantic contract directly: selected Cohorts, clock, denominator, subject span, evidence/projection boundary, and non-negative residuals. Do not pin the old arithmetic as an invariant unless it is independently derived from the semantics.

Projection horizon selection is part of this transfer of authority. The legacy enrichment derives a maturity horizon as `max(t95, 30)` inside the daily-conversions branch and passes it into `compute_forecast_trajectory`. After the cutover, horizon selection is the runtime's responsibility: the projection helper evaluates runtime surfaces at the request's evaluation date and at the per-Cohort age implied by that date, rather than at a daily-conversions-local maturity tau. Tests should accept whichever horizon the runtime chooses and assert independently-derived semantic bounds (non-negative residual, projected count not below observed `y`, bounded by denominator mass), not the legacy heuristic value.

## Design

### Runtime Ownership

Daily conversions should build or reuse the current `ResolvedCFRuntime` for the same subject, graph, query mode, selected Cohorts, `asat()`, slice/context, and evidence candidates as the analysis request.

The runtime remains responsible for:

- primitive evidence binding;
- primitive conditioning, including doc-52 handling;
- carrier identity versus composed carrier in Window mode, Cohort identity cases, and active Cohort mode;
- subject-span composition;
- exposing conditioned draw surfaces and provenance.

Daily conversions remains responsible only for:

- observed snapshot delta derivation;
- mapping calendar dates to each selected Cohort's age;
- count projection for `projected_y` / `forecast_y`;
- daily count differencing;
- preserving observed `rate_by_cohort` fields and latency-band display fields.

The implementation boundary is therefore:

- a preparation step gathers runtime inputs from the same request and snapshot material that daily conversions already uses;
- the runtime owns conditioning/composition;
- the daily-conversions helper owns date/count projection and response shaping.

### Projection Semantics

The projection uses the current request-level conditioned posterior. It does **not** produce a separate posterior per Cohort.

For each selected Cohort and each relevant calendar date, the projection evaluates the shared runtime surfaces at that Cohort's age on the request clock. In Window mode, the carrier is identity. In active Cohort mode, the denominator side is the `A -> X` carrier and the numerator side is the `X -> end` subject span. The displayed rate remains `Y / X`, never `Y / A`.

Projected counts are per-Cohort count projections from the current factorised runtime representation. The daily series is produced by differencing cumulative projected `Y` by calendar date after applying the Cohort/date age mapping. Observed deltas from `derive_daily_conversions` remain the evidence series; forecast deltas are additive projection fields, not a replacement for observed evidence.

Latency-band rows carry an evidence-versus-forecast boundary per Cohort and per band tau. The boundary is jointly owned by the runtime and the observed `cohort_y_at_age` map: a band reads observed `cohort_y_at_age` for a selected Cohort whose age has reached that band's tau on the request clock, and reads the runtime's conditioned latency surface at that tau otherwise. Daily conversions does not invent the boundary itself; it asks the runtime for the per-tau decision (or evaluates against the observed age threshold for the evidence side) and renders accordingly. The legacy per-band `compute_forecast_trajectory` sweep collapses into a single runtime evaluation per band tau in the projection helper.

### Output Contract

Preserve the existing daily-conversions response shape unless a consumer explicitly opts into new fields.

The cutover should preserve:

- `data` observed daily conversions;
- `rate_by_cohort` with `date`, `x`, `y`, `rate`;
- enriched `rate_by_cohort` fields: `completeness`, `evidence_y`, `projected_y`, `forecast_y`, `layer`, `forecast_bands`;
- optional `latency_bands`;
- `cf_mode`, `cf_reason`, and `promoted_source` where currently emitted.

If a projected calendar-date forecast series is added, it should be additive and clearly named as forecast/projection, while the existing `data` series remains observed evidence.

## Invariants

This atom must preserve these controls:

- **Selected-set conditioning**: the posterior is conditioned on the full selected set of Cohorts scoped by the `window()` or `cohort()` query, exactly as the current shared CF runtime does.
- **No 73p semantics**: no hierarchical per-Cohort posterior, no hyperprior fitting, no partial pooling, no new per-Cohort posterior schema.
- **No duplicate forecast engine**: daily conversions must not call `compute_forecast_trajectory` after the cutover. The only remaining public-path caller should be whatever non-daily consumer is explicitly still pending migration.
- **No projection-time conditioning**: the daily-conversions helper must not bind evidence, condition primitives, apply doc-52, choose priors, or rebuild carrier/subject spans.
- **Y/X invariant**: rates are always subject-end `Y` over denominator-at-`X`; Cohort mode must not become `Y / A`.
- **Carrier ownership**: in active Cohort mode, denominator arrival is owned by the runtime carrier object. Daily conversions must not recompute or bypass `A -> X`.
- **Subject ownership**: numerator progression is owned by the runtime subject span. Daily conversions must not silently use a terminal edge when the request subject is multi-hop.
- **Observed evidence preserved**: `derive_daily_conversions` remains the source for observed daily deltas and observed `y_at_age`; the runtime projection does not rewrite observed history.
- **No legacy fallback**: remove the daily-conversions `annotate_rows` fallback. If the runtime cannot project, emit unavailable/degraded projection fields with provenance rather than silently switching machinery.
- **Terminology discipline**: use **Cohort**, **`cohort()`**, **Cohort mode**, and **Window mode** consistently.

## Atomic Edit Set

This should land as one cohesive change rather than a staged migration.

1. Add a daily-conversions runtime-preparation helper that starts from the existing scenario, subject, graph, selected Cohorts, and snapshot rows, and produces the inputs required by `build_resolved_cf_runtime`.
2. Add a daily-conversions projection helper near the current runtime row projection helpers in `cohort_forecast_v3.py`, or in a narrow runner module imported by that file if local size becomes unwieldy.
3. The projection helper consumes a `ResolvedCFRuntime`, selected Cohort rows from the daily-conversions derivation, the observed `cohort_y_at_age` map, the date axis, and display options. It returns enriched `rate_by_cohort` rows and, if needed, additive projected daily-count rows.
4. Reuse existing shared helpers for subject resolution, snapshot/regime preparation, per-edge evidence maps, and runtime construction. Do not introduce a third subject-resolution or evidence-binding path.
5. Replace the daily-conversions enrichment block in `api_handlers.py` with the runtime-preparation plus runtime-backed projection call.
6. Delete the two daily-conversions `compute_forecast_trajectory` calls and the daily-conversions `annotate_rows` fallback.
7. Preserve legacy response field names for FE compatibility.
8. Add focused tests proving every input class in the audit is honoured and that the API handler no longer calls the legacy trajectory path for daily conversions.

## Deletion and Retirement Scope

The atom should delete or rewrite daily-conversions-specific legacy code that becomes unreachable after the runtime cutover.

Delete from the daily-conversions branch in `api_handlers.py`:

- the local import of `compute_forecast_trajectory` and `CohortEvidence`;
- the main `_engine_cohorts`, `_row_map`, and `_cohort_real_ages` construction whose only purpose is to call `compute_forecast_trajectory`;
- the main `_sweep = compute_forecast_trajectory(...)` call;
- the per-latency-band `_band_cohorts` construction whose only purpose is to call `compute_forecast_trajectory`;
- the `_band_sweep = compute_forecast_trajectory(...)` call;
- the daily-conversions `annotate_rows` fallback block;
- comments that describe daily conversions as a surviving legacy trajectory-engine consumer.

Rewrite rather than preserve:

- `TestDailyConversionsEngineAnnotation`-style tests that directly bless `compute_forecast_trajectory` as the daily-conversions enrichment mechanism. Keep the semantic assertions, but point them at the runtime-backed projection.
- Any daily-conversions monkeypatch or static assertion whose only purpose is to prove the old trajectory call fired.

Keep:

- `derive_daily_conversions` and its observed-delta tests.
- FE normalisation of `rate_by_cohort` fields in `graphComputeClient.ts`.
- `compute_forecast_trajectory` itself, because `surprise_gauge` remains outside this plan.
- `annotate_rows` generally, because other legacy paths still use it; only the daily-conversions fallback is retired here.
- `cohort_y_at_age`, because latency-band evidence overlays still need observed cumulative `y` by selected Cohort age.

The daily-conversions `annotate_rows` fallback is, in any case, already a no-op for the projection fields it claims to populate: a known field-name mismatch causes it to write zeros rather than meaningful `projected_y` / `forecast_y` values when the engine call fails. Removing it does not change observable production behaviour; it removes a misleading code path that has been silently masking engine failures.

After the atom, static search should show:

- no daily-conversions call to `compute_forecast_trajectory` in `api_handlers.py`;
- no daily-conversions construction of `CohortEvidence`;
- no daily-conversions fallback to `annotate_rows`;
- any remaining `compute_forecast_trajectory` reference is either `surprise_gauge`, a non-daily test/support path, or historical documentation.

## Test Plan

Focused tests should cover:

- Request-envelope preservation: `analytics_dsl`, per-scenario `effective_query_dsl`, scenario graph, candidate regimes, MECE dimensions, and compute-affecting display settings reach the daily-conversions preparation path.
- Subject-resolution preservation: daily conversions still resolves the same target edge/path roles and selected date bounds from `window()` and `cohort()`.
- Snapshot-read preservation: raw observed daily deltas still come from `query_snapshots`-style rows with `anchor_day`, `retrieved_at`, `slice_key`, `x`, and `y`.
- Regime-selection preservation: multiple candidate regimes for the same retrieval date do not double-count.
- Existing observed daily delta derivation remains unchanged for single-slice and MECE slice inputs.
- Daily conversions still emits semantically plausible `projected_y` / `forecast_y` for immature selected Cohorts under the runtime-backed path: projected count is not below observed `y`, residual is non-negative, and values are bounded by the relevant denominator mass.
- Window mode and active Cohort mode produce distinct projections when the carrier is non-identity.
- Multi-hop daily conversions read the full subject span, not the terminal edge.
- Latency-band overlays are preserved, with evidence bands still reading observed `cohort_y_at_age` and forecast bands reading runtime projection surfaces.
- `show_latency_bands` remains the compute-affecting switch for latency bands.
- The daily-conversions API path does not call `compute_forecast_trajectory`.
- The daily-conversions API path does not fall back to `annotate_rows`.
- `Y / X` is preserved in rate fields; no `Y / A` projection is introduced.
- Tests avoid exact parity with the old trajectory arithmetic unless the expected value is derived independently from the semantic contract.
- Projection horizon is sourced from the runtime, not from the legacy `max(t95, 30)` heuristic; tests assert the projected count satisfies an independently-derived semantic bound (non-negative residual, not below observed `y`, bounded by denominator mass) at the request evaluation date rather than pinning the legacy horizon value.
- `promoted_source` continues to be emitted on the daily-conversions response under the runtime-backed path, sourced from the runtime's resolved model record rather than the legacy local resolver call.
- Latency-band evidence-versus-forecast boundary: a band whose tau is below the selected Cohort's age on the request clock reads observed `cohort_y_at_age`; otherwise it reads the runtime's conditioned latency surface. Tests cover both sides of the boundary for the same Cohort across band taus.
- Static check: daily-conversions preparation imports its subject-resolution and evidence-binding helpers from `analysis_subject_resolution`, `forecast_preparation`, and the existing `cohort_forecast_v3` per-edge evidence builders. No new subject-resolution module, evidence-binding helper, or runtime-construction wrapper is introduced.

## Non-Goals

- No 73p hierarchical per-Cohort conditioning.
- No per-Cohort posterior schema.
- No new frontend chart type requirement.
- No migration of `surprise_gauge`.
- No change to observed snapshot delta derivation.
- No change to FE normalisation, except for accepting additive fields already present in the backend response.
- No gross-fitted numerator admission.
- No broad rewrite of Cohort maturity rows.

## Acceptance

The atom is complete when:

- daily conversions derives forecast enrichment from the shared runtime, not the old trajectory engine;
- existing daily-conversions response fields remain present;
- tests prove the key invariants above;
- static search shows no daily-conversions `compute_forecast_trajectory` call remains in `api_handlers.py`;
- any remaining `compute_forecast_trajectory` public caller is explicitly outside this plan's scope.
