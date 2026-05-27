# CF Spine Detachment And Analysis Standardisation Master Plan

**Date:** 26-May-26  
**Status:** Draft for review  
**Scope:** Finish detaching the conditioned-forecast spine from `cohort_forecast_v3`, standardise `cohort_maturity` as the canonical analysis type, and migrate remaining forecast-backed analyses onto shared runtime/projection surfaces.

## Implementation Progress

<!-- managed manually until this plan is adopted by /implement-carefully -->

- [ ] Stage 0 - Reconcile The Mid-Flight Baseline
- [ ] Stage 1 - Complete The 73q Shared Projection-Bundle Cutover
- [ ] Stage 2 - Retire `cohort_maturity_v1` And `cohort_maturity_v2`
- [ ] Stage 3 - Move `surprise_gauge` Off The Legacy Trajectory Engine
- [ ] Stage 4 - Delete The Legacy Trajectory Engine Public Path
- [ ] Stage 5 - Extract Neutral CF Runtime And Projection Modules
- [ ] Stage 6 - Standardise Forecast-Backed Analyse Dispatch
- [ ] Stage 7 - Decide The `conversion_funnel` Final Integration Shape
- [ ] Stage 8 - Rewrite Codebase Docs And Close Stale Plans

## Summary

We are halfway through the architectural migration, not at the finish line.

The hard numerical spine is largely present. `cohort_maturity` v3 and `conditioned_forecast` both build a request-scoped `ResolvedCFRuntime` and project through the selected-Cohort spine. The frontier-conditioned chart surfaces are named and mostly wired: strict evidence, `f_*` conditioned model, `ef_*` frontier-conditioned forecast, and optional model overlay.

The remaining problem is ownership and reachability. `cohort_forecast_v3.py` still owns the runtime object, candidate builders, frame-to-runtime assembly, frontier helper, and tau-row projection. `daily_conversions` and `surprise_gauge` still rely on the legacy trajectory engine. `cohort_maturity_v1` and `cohort_maturity_v2` still exist as live dispatch identifiers. The docs still describe both the old and new architectures in different places.

The desired end state is:

- a standard analyse pathway for forecast-backed analyses;
- `cohort_maturity` as the only live cohort maturity analysis type;
- a neutral CF spine used by multiple analysis reducers, not owned by a cohort-maturity-v3 file;
- thin analysis-specific reducers over shared runtime/projection surfaces;
- no public caller of the legacy trajectory engine;
- docs that describe the live architecture, not a mixture of historical states.

## Current State

The current live state has four important facts.

First, the spine cutover has happened for the cohort-maturity row path. The row projector calls `model_span_spine.project_selected_cohort_rows`, and the public chart fields are now mapped to strict evidence, `f_*`, `ef_*`, and optional overlay surfaces.

Second, the runtime and projection orchestration are not detached. `ResolvedCFRuntime`, `build_resolved_cf_runtime`, superset candidate builders, selected retrieval frontier construction, frame evidence setup, and `_project_runtime_rows` still live in `cohort_forecast_v3.py`.

Third, the standard analyse pathway is not yet standard. `cohort_maturity` is special-cased in the backend dispatcher and `conditioned_forecast` is still an enrichment endpoint, not an ordinary analysis type. The two paths duplicate preparation and candidate-wiring logic before calling the same row builder.

Fourth, several public analyses still bypass the shared spine. `daily_conversions` has a detailed 73q plan to move onto a date reducer over a shared projection bundle, but it still calls the legacy trajectory engine today. `surprise_gauge` also calls the legacy trajectory engine. `conversion_funnel` consumes public CF scalars, but its own funnel reducer remains a separate hold-out engine.

## Design Principles

The migration must preserve the existing CF invariants.

One runtime object owns conditioning, composition, and projection-facing provenance. Analyses may reduce or display that object differently, but they must not rebuild carrier logic, subject spans, completeness, frontier semantics, or evidence admission locally.

Cases differ by degeneration, not by fork. Window mode, `cohort(A = X)`, active `cohort(A != X)`, single-hop, and multi-hop must remain data cases of the same runtime/projection chain.

Evidence admission is upstream of projection. Row reducers and graph writeback must not repair missing evidence by reading from a second layer or synthesising fallback counts.

Projection reducers are allowed to own display/accounting choices. They are not allowed to own statistical semantics. For example, a tau reducer may choose to collapse Cohorts by age, and a date reducer may choose to emit one row per Cohort, but both must read the same projection bundle.

No stage may close as "architecturally complete" while the old path remains authoritative for its target surface. A cutover stage is complete only when the intended consumer is actually on the new path, tests exercise that path, and the old public route is unreachable or explicitly scheduled as a following deletion atom.

## Target Architecture

The target shape is a shared CF projection pipeline with analysis-specific reducers.

The shared part owns subject resolution, forecast preparation, evidence candidate construction, runtime construction, selected retrieval frontier, projection-bundle construction, runtime provenance, and per-Cohort/per-tau surfaces.

Reducers then consume that bundle:

- `cohort_maturity` uses a tau reducer: collapse selected Cohorts by relative age and emit chart rows.
- `daily_conversions` uses a date reducer: keep selected Cohorts as dated rows and read contract-specific tau positions.
- `conditioned_forecast` uses a scalar reducer: read `p@infinity`, completeness, evidence totals, and provenance for graph enrichment or direct scalar consumers.
- `surprise_gauge` uses a diagnostic scalar reducer: compare observed evidence against runtime-projected posterior surfaces without calling the trajectory engine.

The file layout after detachment should make that ownership obvious. A neutral runtime/projection module should own CF spine construction. `cohort_forecast_v3.py` should either disappear or become a thin compatibility wrapper for the `cohort_maturity` tau reducer until all callers are renamed.

## Stage 0 - Reconcile The Mid-Flight Baseline

Stage 0 records the true starting point before more changes land.

This stage should reconcile three ledgers: the selected-cohort projection cutover plan, 73q, and the v1/v2 retirement plan. It should record which selected-cohort cleanup atoms are already effectively complete in code, which are only doc cleanup, and which still require production changes.

The baseline must include:

- every public caller of `cohort_forecast_v3.py` symbols;
- every public caller of `forecast_state.compute_forecast_trajectory`;
- every backend dispatch branch for `cohort_maturity`, `cohort_maturity_v1`, `cohort_maturity_v2`, `cohort_maturity_v3`, and `conditioned_forecast`;
- every FE analysis-type normalisation or cache branch that still names v1 or v2;
- every strict xfail or known legacy-gap test that 73q is expected to flip;
- every codebase doc section that still presents the legacy selected-Cohort reducer, `SelectedAClockEvidence`, or `cohort_maturity_v3` as the current architecture.

Stop condition: a short baseline note is added to this plan or to an adjacent stage note, and no subsequent stage has to rediscover whether a symbol is live, dead, or historical.

## Stage 1 - Complete The 73q Shared Projection-Bundle Cutover

This is the next substantive stage.

73q should remain the detailed execution plan for `daily_conversions`. This umbrella plan depends on 73q producing a shared CF projection bundle that is not cohort-maturity-specific.

The bundle must expose the data needed by both reducers:

- frame evidence and Cohort metadata from the existing frame-evidence builder;
- the request-scoped runtime;
- selected retrieval frontier information;
- selected-Cohort projection surfaces to the required horizon;
- per-Cohort `ef_*` surfaces, strict evidence surfaces, and projection status;
- per-Cohort completeness readouts before cross-Cohort aggregation.

The daily-conversions date reducer then reads from that bundle instead of calling the legacy trajectory engine. Observed daily conversion counts remain owned by `derive_daily_conversions`; projection fields are read from the shared bundle.

Stage 1 must not scrape public cohort-maturity tau rows to feed daily conversions. The shared bundle is the common input; tau rows and date rows are sibling readouts.

Stop condition: `daily_conversions` no longer imports or calls the legacy trajectory engine for row annotation or latency-band projection. Its projection fields are produced by the date reducer over the shared bundle. 73q's strict expected-fails that name the daily-conversions legacy gap have either flipped and been deleted, or are explicitly reclassified with maintainer approval.

## Stage 2 - Retire `cohort_maturity_v1` And `cohort_maturity_v2`

Once 73q proves the spine is not cohort-maturity-specific, retire the legacy cohort-maturity identifiers.

The existing v1/v2 retirement plan owns the detailed mechanics. The intended shape is soft migration first, deletion second:

- backend dispatch aliases `cohort_maturity_v1` and `cohort_maturity_v2` to canonical `cohort_maturity`;
- frontend load-time normalisation rewrites saved legacy identifiers to canonical `cohort_maturity`;
- user-visible registries and resolution services stop presenting v1 and v2;
- dedicated v1/v2 handlers, modules, tests, and examples are deleted once unreachable;
- retrospective docs remain historical, while live docs present only `cohort_maturity`.

This stage should not modify v3 semantics. It is a naming and reachability cleanup that removes two parallel analysis surfaces before the neutral CF extraction happens.

Stop condition: a request or saved analysis using v1 or v2 resolves to `cohort_maturity`, and repo-wide live-code search shows no production branch that depends on distinct v1/v2 behaviour.

## Stage 3 - Move `surprise_gauge` Off The Legacy Trajectory Engine

After 73q, `surprise_gauge` should be the remaining public caller that still needs the legacy trajectory engine for forecast-backed semantics.

This stage builds a diagnostic scalar reducer over the same runtime/projection bundle. The reducer should answer the existing surprise-gauge question without constructing `CohortEvidence` by hand and without importing the trajectory engine.

The migration should preserve the current user-facing concept: a compact diagnostic of whether observed evidence is surprising relative to the model. What changes is the authority for the model/evidence comparison. It should read from the runtime's conditioned and unconditioned surfaces, plus the admitted evidence/provenance surfaces, rather than from the old trajectory return object.

Stop condition: `surprise_gauge` no longer imports or calls the legacy trajectory engine. Its tests cover prior-only, evidence-conditioned, and unavailable cases through the new reducer.

## Stage 4 - Delete The Legacy Trajectory Engine Public Path

After `daily_conversions` and `surprise_gauge` migrate, the legacy trajectory engine should have no public production caller.

This stage is deletion and proof, not new behaviour. Verify every remaining caller of the trajectory engine and classify it as test oracle, historical compatibility, or dead code. Remove public-path callers first, then delete or quarantine the obsolete carrier types, node-arrival cache helpers, and trajectory-return structures that are no longer needed.

If a test still needs the old engine as a parity oracle, that test must be re-evaluated. The migration target is not long-term parity with the old engine; it is the shared runtime semantics. Keeping the old engine as a permanent oracle recreates the parallel-path problem this plan is meant to close.

Stop condition: production code has zero calls to the legacy trajectory engine, and any remaining references are explicitly test-only or removed. No new analysis can import it by accident.

## Stage 5 - Extract Neutral CF Runtime And Projection Modules

Only after multiple consumers are on the shared bundle should the module ownership be cleaned up.

Move neutral CF concepts out of `cohort_forecast_v3.py` into appropriately named runtime/projection modules. The exact file names can be decided during implementation, but ownership should separate:

- runtime construction and `ResolvedCFRuntime`;
- evidence candidate construction from prepared per-edge results;
- selected retrieval frontier construction;
- projection-bundle construction;
- tau reducer for `cohort_maturity`;
- date reducer for `daily_conversions`;
- scalar reducers for `conditioned_forecast` and `surprise_gauge`.

The extraction should be mechanical wherever possible. Behavioural changes belong in Stages 1 and 3; Stage 5 should make the existing shared architecture visible in the file structure.

Stop condition: `cohort_forecast_v3.py` no longer owns neutral CF runtime/projection concepts. It is either deleted, renamed to a cohort-maturity reducer module, or reduced to a temporary compatibility wrapper with a dated deletion plan.

## Stage 6 - Standardise Forecast-Backed Analyse Dispatch

With the spine detached, standardise the backend dispatch shape.

The target is one forecast-backed analyse path:

1. resolve analysis subjects;
2. prepare forecast subject group;
3. build the shared CF runtime/projection bundle;
4. call the reducer registered for the requested analysis type;
5. wrap the result in the standard analysis response envelope.

`conditioned_forecast` may remain an enrichment endpoint for the fetch pipeline, but the scalar reducer it calls should be the same one available to standard analysis dispatch. The endpoint should be a transport convenience, not a separate implementation path.

This stage should also clarify the FE request contract for analyses that need candidate regimes without using the snapshot-envelope response shape. The current `conversion_funnel` asymmetry is deliberate but should not be copied implicitly.

Stop condition: adding a forecast-backed analysis type means registering a reducer and its response schema, not adding a bespoke handler with local preparation and projection logic.

## Stage 7 - Decide The `conversion_funnel` Final Integration Shape

`conversion_funnel` is adjacent rather than blocking.

It already consumes public CF scalars, so it does not block deletion of the trajectory engine. However, it remains a hold-out reducer with its own bar arithmetic and defensive-code debt.

This stage decides whether `conversion_funnel` should:

- stay as a scalar consumer of the public CF surface, with its perimeter tightened and defensive-code findings retired; or
- move onto the shared projection bundle as another reducer, if its stage bars need access to richer per-Cohort/per-tau surfaces.

The decision should be based on semantic need, not aesthetic uniformity. If scalar CF output is the correct abstraction for funnel bars, keep it and document that boundary. If funnel needs projection-bundle internals, migrate it deliberately rather than letting it grow a second private spine.

Stop condition: `conversion_funnel` has an explicit final integration decision and no longer appears as ambiguous architectural debt in the CF hold-out documentation.

## Stage 8 - Rewrite Codebase Docs And Close Stale Plans

The final stage is documentation and stale-plan closure.

Several docs currently describe the old and new architectures side by side. That is useful during migration but dangerous after cutover.

Rewrite the current references so they agree on the live architecture:

- `CF_MAP.md` should show the neutral runtime/projection bundle and reducers, not a `cohort_forecast_v3`-owned row pipeline.
- `CF_ROW_PIPELINE.md` should describe the live selected-Cohort projection path and the sibling tau/date/scalar reducers.
- `FORECAST_RUNTIME_ARCHITECTURE.md` should describe runtime construction and projection ownership after extraction.
- `CF_HOLD_OUT_ENGINES.md` should either disappear or describe only intentionally remaining hold-outs.
- `STATS_SUBSYSTEMS.md` should distinguish the CF enrichment endpoint from the standard analyse reducers without implying separate engines.
- `ANALYSIS_TYPES_CATALOGUE.md` should present `cohort_maturity` as canonical and describe `daily_conversions` / `surprise_gauge` as shared-spine consumers once migrated.
- `INVARIANTS.md` should reference the new neutral module names where it currently cites old row-pipeline symbols.

Then close or archive superseded plans: selected-cohort cutover, v1/v2 retirement, 73q, and any older cohort-maturity atom plans that still describe pre-spine machinery as live.

Stop condition: a new agent reading the codebase docs sees one architecture, one canonical cohort-maturity analysis type, and one clear route for adding a forecast-backed analysis.

## Acceptance Criteria

The whole programme is complete when:

- `cohort_maturity` is the only live cohort-maturity identifier in normal UI and CLI examples;
- v1/v2 are accepted only as deprecated aliases at explicit compatibility boundaries;
- `daily_conversions` and `surprise_gauge` no longer call the legacy trajectory engine;
- production code has zero public-path calls to the legacy trajectory engine;
- neutral CF runtime/projection modules own the spine;
- `cohort_maturity`, `daily_conversions`, and `conditioned_forecast` read sibling outputs of the same shared bundle;
- adding a new forecast-backed analysis type does not require importing from `cohort_forecast_v3.py` or `forecast_state.py`;
- docs and tests no longer present the legacy reducer or versioned cohort-maturity types as current architecture.

## Open Questions

1. Should `conditioned_forecast` become a formal analysis type in addition to remaining an enrichment endpoint, or should it stay endpoint-only while sharing the scalar reducer internally?

2. Should `conversion_funnel` remain a scalar consumer of CF output, or should it become a projection-bundle reducer?

3. When `cohort_forecast_v3.py` is emptied of neutral runtime concepts, should it be renamed to a cohort-maturity reducer module immediately, or kept briefly as a compatibility wrapper to reduce review risk?

4. Which stale plans should be archived versus left in `docs/current/` with a completion note? The answer should be decided once Stage 8 starts, not piecemeal during earlier implementation.

