# CF Spine Detachment And Analysis Standardisation Master Plan

**Date:** 26-May-26  
**Status:** In progress; progress reconciled against code 31-May-26 — Stages 0–4 complete, Stage 6 partially scaffolded; the neutral spine extraction (Stage 5) is the next major step, with Stages 7–9 and 73q Phase 8 outstanding  
**Scope:** Finish detaching the conditioned-forecast spine from `cohort_forecast_v3`, standardise `cohort_maturity` as the canonical analysis type, and migrate remaining forecast-backed analyses onto shared runtime/projection surfaces.

## Implementation Progress

<!-- managed manually until this plan is adopted by /implement-carefully; reconciled against code 31-May-26 -->

- [x] Stage 0 - Reconcile The Mid-Flight Baseline - completed 28-May-26 in this note
- [x] Stage 1 - Complete The 73q Shared Projection-Bundle Cutover - daily conversions and scalar CF cut over; 73q Phases 1-7 complete (27–31-May-26). Only 73q Phase 8 (companion `bridge_view` / `conversion_rate` migrations) remains, beyond this stage's original scope
- [x] Stage 2 - Retire `cohort_maturity_v1` And `cohort_maturity_v2` - completed via 73q Phase 6, 31-May-26; no production references remain in `graph-editor/lib` or `graph-editor/src`
- [x] Stage 3 - Move `surprise_gauge` Off The Legacy Trajectory Engine - completed via 73q Phase 5, 28-May-26; `_compute_surprise_gauge` reads the shared bundle, not the trajectory engine
- [x] Stage 4 - Delete The Legacy Trajectory Engine Public Path - completed via 73q Phase 7, 31-May-26; `compute_forecast_trajectory` has no definition and no call sites (residual mentions are comments/docstrings/tests); `forecast_state.py` trimmed 1869 → 133 LOC
- [ ] Stage 5 - Extract Neutral CF Runtime And Projection Modules - NOT STARTED (next). `cohort_forecast_v3.py` still owns `ResolvedCFRuntime`, `build_resolved_cf_runtime`, `build_cf_projection_bundle`, and the tau/date/scalar reducers. Prep landed: `runner/cf_analysis.py` (shared prepare boundary) and `runner/cf_projection_bundle.py` (`CFProjectionBundle`, `completeness_to_layer`, `latency_band_taus`) are split out
- [/] Stage 6 - Standardise Forecast-Backed Analyse Dispatch - partially scaffolded via 73q Phase 4: `runner/cf_analysis.py` holds the shared preparation boundary and the `reducer_for` selector. Bespoke handlers (`_compute_surprise_gauge`, `_handle_conditioned_forecast_impl`) and the in-`v3` reducers remain
- [ ] Stage 7 - Decide The `conversion_funnel` Final Integration Shape
- [ ] Stage 8 - Rewrite Codebase Docs And Close Stale Plans
- [ ] Stage 9 - Perimeter De-Fattening And Dead-Path Removal - cross-cutting; detailed item ledger owned by the companion proposal (see Summary)

## Summary

We are roughly halfway through the architectural migration. Stages 0–4 are complete and Stage 6 is partially scaffolded; the central remaining step is the neutral spine extraction (Stage 5), followed by the dispatch-standardisation closure (Stage 6), the `conversion_funnel` decision (Stage 7), and the documentation rewrite (Stage 8).

The hard numerical spine is largely present. `cohort_maturity`, `daily_conversions`, and `conditioned_forecast` all build a request-scoped `ResolvedCFRuntime` and reduce a shared `CFProjectionBundle`: `cohort_maturity` through the tau reducer, `daily_conversions` through the date reducer, and `conditioned_forecast` through the scalar reducer. The frontier-conditioned chart surfaces are named and wired for these consumers: strict evidence, `f_*` conditioned model, `ef_*` frontier-conditioned forecast, and optional model overlay.

The remaining problem is ownership. `cohort_forecast_v3.py` still owns the runtime object, candidate builders, frame-to-runtime assembly, selected-frontier helper, projection-bundle builder, scalar/date/tau reducers, and tau-row projection — extracting these into neutral modules is Stage 5, the central outstanding step. The reachability problems flagged at the original writing are resolved: `surprise_gauge` no longer relies on the legacy trajectory engine (which is now deleted), and `cohort_maturity_v1` / `cohort_maturity_v2` are retired with no production references. The codebase docs still describe both the old and new architectures in different places; reconciling them is Stage 8.

The desired end state is:

- a standard analyse pathway for forecast-backed analyses;
- `cohort_maturity` as the only live cohort maturity analysis type;
- a neutral CF spine used by multiple analysis reducers, not owned by a cohort-maturity-v3 file;
- thin analysis-specific reducers over shared runtime/projection surfaces;
- no public caller of the legacy trajectory engine;
- docs that describe the live architecture, not a mixture of historical states.

A companion proposal, [`cf-perimeter-cleanup-and-dead-path-removal-proposal-31-May-26.md`](cf-perimeter-cleanup-and-dead-path-removal-proposal-31-May-26.md), catalogues the cross-cutting **perimeter de-fattening and dead-path removal** surfaced by a full, documentation-blind read of the back-end forecast-production code (31-May-26). It changes no numerics and no invariants: it deletes paths that already have no production caller, moves statistics/render out of the perimeter handler into reducers, removes the ambient `mc_draws` settings channel, and retires shims the repo's no-shims rule already forbids. It owns **Stage 9** and routes individual items into Stages 5–8 where they belong. It deliberately does **not** duplicate the engine-fallback work owned by [`cf-defensive-coding-audit.md`](cf-defensive-coding-audit.md), the dispersion work owned by [`fc-kappa-predictive-dispersion-proposal-26-May-26.md`](fc-kappa-predictive-dispersion-proposal-26-May-26.md), or the evidence-admission work owned by the admission-binding plans.

## Current State

The current live state has five important facts.

First, the spine cutover has happened for the cohort-maturity row path. The row projector calls `model_span_spine.project_selected_cohort_rows`, and the public chart fields are now mapped to strict evidence, `f_*`, `ef_*`, and optional overlay surfaces.

Second, 73q Phases 1-7 have landed (27–31-May-26): `daily_conversions` no longer calls the legacy trajectory engine for forecast enrichment. It resolves subjects, prepares the shared forecast bundle through `runner/cf_analysis.py`, and applies `reduce_daily_conversions_rows`. The canonical daily response is bundle-only; `derive_daily_conversions` is not part of the daily-conversions chart path. The only open 73q phase is Phase 8 (companion `bridge_view` / `conversion_rate` migrations).

Third, `conditioned_forecast` has also moved to the scalar reducer. `_handle_conditioned_forecast_impl` now calls `prepare_cf_scalar_bundle` and `reduce_cf_scalars`, then frames the graph-enrichment response from scalar output plus bundle/runtime metadata. It no longer calls the cohort-maturity tau reducer or scrapes tau rows. The performance optimisation is not complete: `prepare_cf_scalar_bundle` still wraps `prepare_cf_projection_bundle`, still builds per-Cohort projection arrays, and currently passes `mc_draws_override=None`.

Fourth, the runtime and projection orchestration are not detached. `ResolvedCFRuntime`, `build_resolved_cf_runtime`, superset candidate builders, selected retrieval frontier construction, frame evidence setup, `build_cf_projection_bundle`, `_project_runtime_rows`, and the tau/date/scalar reducers still live in `cohort_forecast_v3.py`.

Fifth, `surprise_gauge` has been migrated off the legacy trajectory engine (73q Phase 5) and the engine itself is deleted (73q Phase 7), so there is no remaining public-path legacy-engine consumer. `cohort_maturity_v1` and `cohort_maturity_v2` have been retired (73q Phase 6) with no production references, so the neutral extraction (Stage 5) will not preserve three cohort-maturity surfaces. `conversion_funnel` still consumes public CF scalars through its own funnel reducer, which remains a separate hold-out engine pending the Stage 7 decision.

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

Predictive dispersion for the FC `ef_*` surface is owned by the kappa-realised FC proposal, [`fc-kappa-predictive-dispersion-proposal-26-May-26.md`](fc-kappa-predictive-dispersion-proposal-26-May-26.md). That proposal is not chart-only: when it lands, scalar reducers and `surprise_gauge` must consume the same kappa-realised FC predictive surface rather than the collapsed `alpha_pred` / `beta_pred` compatibility surface.

Reducers then consume that bundle:

- `cohort_maturity` uses a tau reducer: collapse selected Cohorts by relative age and emit chart rows.
- `daily_conversions` uses a date reducer: keep selected Cohorts as dated rows and read contract-specific tau positions.
- `conditioned_forecast` uses a scalar reducer: read `p@infinity`, completeness, evidence totals, and provenance for graph enrichment or direct scalar consumers.
- `surprise_gauge` uses a diagnostic scalar reducer: compare unconditioned selected-Cohort surface values against FC evidence-conditioned selected-Cohort surface values without calling the trajectory engine.

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

This stage is mostly discharged by 73q Phases 1-4, but 73q as a programme is not closed.

73q remains the detailed execution plan for the shared projection-bundle cutover and its immediate consumers. The bundle and sibling reducers now exist for `cohort_maturity`, `daily_conversions`, and `conditioned_forecast`. The remaining 73q-owned work is the consumer/cleanup tail: `surprise_gauge`, scalar-callsite draw-count/performance cleanup, v1/v2 retirement, and stale-test/doc cleanup as recorded in 73q's progress section.

The bundle must expose the data needed by the sibling reducers:

- frame evidence and Cohort metadata from the existing frame-evidence builder;
- the request-scoped runtime;
- selected retrieval frontier information;
- selected-Cohort projection surfaces to the required horizon;
- per-Cohort `ef_*` surfaces, strict evidence surfaces, and projection status;
- per-Cohort completeness readouts before cross-Cohort aggregation.

The daily-conversions date reducer now reads from that bundle instead of calling the legacy trajectory engine. Its row evidence and projection fields are both read from the shared bundle; there is no secondary observed-row input.

Stage 1 must not scrape public cohort-maturity tau rows to feed daily conversions. The shared bundle is the common input; tau rows and date rows are sibling readouts.

Stop condition: `daily_conversions` no longer imports or calls the legacy trajectory engine for row annotation or latency-band projection. Its projection fields are produced by the date reducer over the shared bundle. 73q's strict expected-fails that name the daily-conversions legacy gap have either flipped and been deleted, or are explicitly reclassified with maintainer approval.

Current status (31-May-26): complete. The production-code condition was met 28-May-26, and 73q's remaining consumer/cleanup phases (5–7) have since closed, so the gate on starting Stage 5 is cleared. The only open 73q work is Phase 8 (companion `bridge_view` / `conversion_rate` migrations), which is forward companion work beyond this stage's original scope.

## Stage 2 - Retire `cohort_maturity_v1` And `cohort_maturity_v2`

**Status (31-May-26): Complete** — discharged by 73q Phase 6. No production references to `cohort_maturity_v1` / `cohort_maturity_v2` remain in `graph-editor/lib` or `graph-editor/src`.

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

**Status (28-May-26): Complete** — discharged by 73q Phase 5. `_compute_surprise_gauge` reads the shared forecast/projection bundle; the legacy trajectory engine is no longer imported or called.

`surprise_gauge` is the remaining public caller that still needs the legacy trajectory engine for forecast-backed semantics. 73q Phase 5a currently owns this migration. If 73q closes it, this stage becomes verification and deletion cleanup rather than a new implementation stage.

This stage builds a diagnostic scalar reducer over the same runtime/projection bundle. The reducer should answer the existing surprise-gauge question without constructing `CohortEvidence` by hand and without importing the trajectory engine.

The migration should preserve the user-facing concept: a compact diagnostic of whether the selected Cohort set's evidence-conditioned forecast is surprising relative to the unconditioned model expectation. The `p` comparison is unconditioned selected-Cohort rate at saturation versus FC selected-Cohort rate at saturation. The `completeness` comparison is unconditioned frontier/saturation rate ratio versus FC frontier/saturation rate ratio. Both comparisons stay on selected-Cohort `Y / X` surfaces.

The dispersion contract for this diagnostic must follow the kappa proposal above: the unconditioned side uses the model-overlay epistemic surface, while the FC side uses the kappa-realised predictive surface when that work lands. Do not bake collapsed `alpha_pred` / `beta_pred` into the diagnostic scalar reducer as a permanent FC predictive dispersion source.

Stop condition: `surprise_gauge` no longer imports or calls the legacy trajectory engine. Its tests cover prior-only, evidence-conditioned, and unavailable cases through the new reducer.

## Stage 4 - Delete The Legacy Trajectory Engine Public Path

**Status (31-May-26): Complete** — discharged by 73q Phase 7. `compute_forecast_trajectory` has no definition and no call sites anywhere in the codebase; `forecast_state.py` is trimmed to 133 LOC (retaining only `_resolve_edge_p`, `_warn_legacy_pmean_carrier`, and `CohortEvidence`). Residual mentions of the name are comments, docstrings, and test references — clearing those falls under Stage 8 doc/test cleanup.

After `surprise_gauge` migrates, the legacy trajectory engine should have no public production caller.

This stage is deletion and proof, not new behaviour. Verify every remaining caller of the trajectory engine and classify it as test oracle, historical compatibility, or dead code. Remove public-path callers first, then delete or quarantine the obsolete carrier types, node-arrival cache helpers, and trajectory-return structures that are no longer needed.

If a test still needs the old engine as a parity oracle, that test must be re-evaluated. The migration target is not long-term parity with the old engine; it is the shared runtime semantics. Keeping the old engine as a permanent oracle recreates the parallel-path problem this plan is meant to close.

Stop condition: production code has zero calls to the legacy trajectory engine, and any remaining references are explicitly test-only or removed. No new analysis can import it by accident.

## Stage 5 - Extract Neutral CF Runtime And Projection Modules

**Status (31-May-26): Not started — this is the next stage.** `cohort_forecast_v3.py` (≈124 KB) still owns `ResolvedCFRuntime` (the class), `build_resolved_cf_runtime`, the candidate builders, `build_cf_projection_bundle`, `compute_cohort_maturity_rows_v3`, and the three reducers (`reduce_cohort_maturity_rows`, `reduce_cf_scalars`, `reduce_daily_conversions_rows`). Preparatory extraction has landed: `runner/cf_analysis.py` holds the shared prepare boundary, and `runner/cf_projection_bundle.py` holds the `CFProjectionBundle` dataclass plus the `completeness_to_layer` and `latency_band_taus` helpers. The runtime, candidate builders, and reducers themselves have not yet moved out of `v3`. The 73q gate on starting this work is now cleared (see Stage 1).

Only after 73q's remaining consumer/cleanup phases are complete or explicitly deferred should the module ownership be cleaned up. Multiple consumers are already on the shared bundle (`cohort_maturity`, `daily_conversions`, and `conditioned_forecast`); the blocker is avoiding a structural extraction while 73q is still changing the scalar and diagnostic consumer contracts.

Move neutral CF concepts out of `cohort_forecast_v3.py` into appropriately named runtime/projection modules. The exact file names can be decided during implementation, but ownership should separate:

- runtime construction and `ResolvedCFRuntime`;
- evidence candidate construction from prepared per-edge results;
- selected retrieval frontier construction;
- projection-bundle construction;
- tau reducer for `cohort_maturity`;
- date reducer for `daily_conversions`;
- scalar reducers for `conditioned_forecast` and `surprise_gauge`.

Known current contents to lift from `cohort_forecast_v3.py` after 73q:

- candidate construction: `build_carrier_superset_candidates_by_edge`, `build_superset_candidates_by_edge`, `_aggregate_request_candidates`;
- runtime construction: `ResolvedCFRuntime`, `_runtime_seed`, `_runtime_scope`, `_primitive_scope_dates_for_edge`, `_build_span_resolutions`, `build_resolved_cf_runtime`;
- projection-bundle support: `_derive_saturation_tau`, `_root_window_carrier_n_by_anchor_day`, selected retrieval frontier helpers, `_runtime_completeness`, `FrameEvidence`, `build_cohort_evidence_from_frames`, `build_cf_projection_bundle`;
- reducers: `reduce_cohort_maturity_rows`, `reduce_daily_conversions_rows`, `reduce_cf_scalars`, `CFScalarReduction`;
- compatibility wrapper: `compute_cohort_maturity_rows_v3`, which should become a thin import wrapper or disappear once callers are repointed.

The extraction should be mechanical wherever possible. Behavioural changes belong in Stages 1 and 3; Stage 5 should make the existing shared architecture visible in the file structure.

Stop condition: `cohort_forecast_v3.py` no longer owns neutral CF runtime/projection concepts. It is either deleted, renamed to a cohort-maturity reducer module, or reduced to a temporary compatibility wrapper with a dated deletion plan.

Companion cleanup (Stage 9 ledger): the `compute_cohort_maturity_rows_v3` compatibility wrapper is now test-only, and its handler docstring at `api_handlers.py:878` is stale — it still claims `_handle_cohort_maturity_v3` calls the wrapper when the handler reduces the bundle directly (companion item A6). Thread `mc_draws` as an explicit bundle-build parameter during this extraction so the scalar callsite's reduced-draw policy stops riding the settings `ContextVar` (companion item D1, which subsumes the Stage 1 draw-count tail).

## Stage 6 - Standardise Forecast-Backed Analyse Dispatch

**Status (31-May-26): Partially scaffolded.** `runner/cf_analysis.py` provides the shared preparation boundary (`prepare_cf_projection_bundle` / `prepare_cf_scalar_bundle`) and `reducer_for` for reducer selection, and the three forecast-backed analyses route through it. The full stop condition is not met: `_compute_surprise_gauge` and `_handle_conditioned_forecast_impl` are still bespoke handlers, and the reducers still live in `cohort_forecast_v3.py` pending Stage 5.

With the spine detached, standardise the backend dispatch shape.

The target is one forecast-backed analyse path:

1. resolve analysis subjects;
2. prepare forecast subject group;
3. build the shared CF runtime/projection bundle;
4. call the reducer registered for the requested analysis type;
5. wrap the result in the standard analysis response envelope.

`conditioned_forecast` may remain an enrichment endpoint for the fetch pipeline, but the scalar reducer it calls should be declared through the same forecast-backed reducer/client registry as standard analysis dispatch. The endpoint should be a transport convenience, not a separate implementation path. It does not need to masquerade as a render-only analysis type in `analysis_types.yaml`, but the reducer choice should be declarative rather than a bespoke import in the handler.

This stage should also clarify the FE request contract for analyses that need candidate regimes without using the snapshot-envelope response shape. The current `conversion_funnel` asymmetry is deliberate but should not be copied implicitly.

Stop condition: adding a forecast-backed analysis type means registering a reducer and its response schema, not adding a bespoke handler with local preparation and projection logic.

Companion cleanup (Stage 9 ledger): the bespoke handler bodies that currently block this stop condition are itemised as `_compute_surprise_gauge` (the surprise z-score in the handler, companion C1), `_append_synthetic_frames_impl` (forecast-tail maths in the handler, C2), and the multi-scenario chart-axis reduction / pad-out (C3). Each should become a registered reducer or a reducer-owned display step. The handler-side horizon sizing (`_compute_extent_for_scenario`) is carried to Open Questions rather than assumed a deviation.

## Stage 7 - Decide The `conversion_funnel` Final Integration Shape

`conversion_funnel` is adjacent rather than blocking.

It already consumes public CF scalars, so it does not block deletion of the trajectory engine. However, it remains a hold-out reducer with its own bar arithmetic and defensive-code debt.

This stage decides whether `conversion_funnel` should:

- stay as a scalar consumer of the public CF surface, with its perimeter tightened and defensive-code findings retired; or
- move onto the shared projection bundle as another reducer, if its stage bars need access to richer per-Cohort/per-tau surfaces.

The decision should be based on semantic need, not aesthetic uniformity. If scalar CF output is the correct abstraction for funnel bars, keep it and document that boundary. If funnel needs projection-bundle internals, migrate it deliberately rather than letting it grow a second private spine.

Stop condition: `conversion_funnel` has an explicit final integration decision and no longer appears as ambiguous architectural debt in the CF hold-out documentation.

Companion cleanup (Stage 9 ledger): the funnel's `runners.py:1488` `from api_handlers import handle_conditioned_forecast` (companion item B1) is the worst layering inversion in the back end — an engine runner reaching up into an HTTP request handler. Whichever integration shape is chosen, the inverted import must go: the conditioned-forecast scalar pipeline should be exposed as a shared reducer/client the funnel calls, not the endpoint handler.

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

Companion cleanup (Stage 9 ledger): alongside the doc rewrite, lift the forensic serialisation out of the compute layer — `forecast_runtime.serialise_runtime_bundle` (companion item E1) and the `model_span_spine._summarise_*` diagnostics (E2) — behind the diagnostics flag so the runtime/spine stay compute-only, and fix the stale in-code line cites (F7, e.g. `api_handlers.py:2251` citing ~3822 in a 3637-line file).

## Stage 9 - Perimeter De-Fattening And Dead-Path Removal

**Status (31-May-26): Not started.** The detailed item ledger, severities, and sequencing live in the companion proposal [`cf-perimeter-cleanup-and-dead-path-removal-proposal-31-May-26.md`](cf-perimeter-cleanup-and-dead-path-removal-proposal-31-May-26.md).

This stage is cross-cutting rather than strictly sequential. It carries the structural cleanup a full, documentation-blind read of the back-end forecast-production code surfaced (31-May-26) — the work the spine migration makes safe but does not itself itemise. It is **structural only**: no numerical or invariant change, and every atom must keep fixtures and oracles bit-for-bit green. It respects this plan's principles, in particular that reducers may own display while the engine may not — render that lives in a reducer is not flagged; render in the runtime/compute layer or the HTTP handler is.

The companion groups its atoms as: dead-path deletion (modules with zero production callers — `span_adapter.py`, `predicates.py`, the dead `path_runner` state-space engine, `confidence_bands.py`, `span_operator_supply.py`); the inverted dependency arrows (the funnel→handler import, the prepare→DB reach-through); perimeter statistics/render relocation (surprise gauge, synthetic-tail, chart-axis); the ambient `mc_draws` settings channel made an explicit parameter; runtime-layer diagnostics moved behind the diagnostics flag; and shim/vestigial removal under the repo's no-shims rule.

Sequencing: dead-path deletion and shim removal are safe now and independent of Stage 5; the draws-explicit and perimeter-relocation atoms accompany Stages 5–6; the funnel inverted-arrow atom lands with the Stage 7 decision; diagnostics-relocation and stale-cite fixes land with the Stage 8 doc rewrite. A god-module split beyond `cohort_forecast_v3` (`api_handlers`, `model_span_spine`, `runners`, `snapshot_service`, and the `timing_span` API/DP-core fusion) is explicitly **deferred** out of this stage to avoid colliding with Stage 5.

Stop condition: the companion's Stage 9 acceptance criteria are met — no dead module remains undeleted, `mc_draws` is an explicit parameter through the `cf_analysis` bundle boundary (and the nested broadcast-collapse `use_request_settings` workaround is gone), no statistics or chart maths remain in `api_handlers.py`, and no `if False:` / hard-`False` capability gate / "DO NOT call from production" fallback / overdue dated-deletion shim remains on the forecast path.

## Acceptance Criteria

The whole programme is complete when:

- `cohort_maturity` is the only live cohort-maturity identifier in normal UI and CLI examples;
- v1/v2 are accepted only as deprecated aliases at explicit compatibility boundaries;
- `surprise_gauge` no longer calls the legacy trajectory engine;
- production code has zero public-path calls to the legacy trajectory engine;
- neutral CF runtime/projection modules own the spine;
- `cohort_maturity`, `daily_conversions`, and `conditioned_forecast` read sibling outputs of the same shared bundle;
- adding a new forecast-backed analysis type does not require importing from `cohort_forecast_v3.py` or `forecast_state.py`;
- docs and tests no longer present the legacy reducer or versioned cohort-maturity types as current architecture;
- the companion proposal's Stage 9 acceptance criteria are met: no dead modules remain, `mc_draws` is an explicit bundle-boundary parameter, no statistics or chart maths remain in the perimeter handler, and no forbidden shims remain on the forecast path — all with bit-for-bit identical numerical output.

## Open Questions

1. Should `conditioned_forecast` become a formal analysis type in addition to remaining an enrichment endpoint, or should it stay endpoint-only while sharing the scalar reducer internally?

2. Should `conversion_funnel` remain a scalar consumer of CF output, or should it become a projection-bundle reducer?

3. When `cohort_forecast_v3.py` is emptied of neutral runtime concepts, should it be renamed to a cohort-maturity reducer module immediately, or kept briefly as a compatibility wrapper to reduce review risk?

4. Which stale plans should be archived versus left in `docs/current/` with a completion note? The answer should be decided once Stage 8 starts, not piecemeal during earlier implementation.

5. Is handler-side horizon sizing (`_compute_extent_for_scenario` composing a span-kernel t95 in the perimeter) acceptable perimeter policy, or should `compute_extent` be an input the engine derives? The code's own comments frame it as deliberate "perimeter-owned render-calc policy"; the companion proposal surfaces it as a Stage 6 decision rather than a silent split.

