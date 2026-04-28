# Separate scenario materialisation from request transport

> Originally drafted as Section 8 of [73b-final-outstanding.md](73b-final-outstanding.md), then extracted to its own file. Cross-references prefixed `73b §` point to sections of that parent doc; section numbers in this file (§8.1 onwards) are retained from the original.

This section is a proposal, not a stage of work. It exists for review before any code is touched.

The current implementation mixes two different jobs:

1. **Scenario materialisation** — producing a graph object that already represents a scenario's intended state for an effective DSL.
2. **Request transport preparation** — making an isolated backend-bound copy of that graph, attaching transient request-only material, and dispatching it to the correct endpoint.

The mess in 73b §3.2 / 73b §7.1 is a symptom of that boundary being blurred. "Custom mode" is a chart/recipe policy, not a backend contract. `visibility_mode` is a scenario metadata selector, not a reason to rewrite the canonical scenario graph. CF enrichment and read-only analysis have different lifecycles, but they should consume the same scenario-graph transport shape once a scenario has been materialised.

### 8.1 Diagnosis recap

**Problem A — materialisation and transport are conflated.** `prepareAnalysisComputeInputs` currently builds scenario graphs, applies visibility projection, re-contexts posterior fields, engorges BE-only fields, and decides dispatch metadata in one function. That makes it easy for request-only fields to leak back onto caller-owned graphs. The concrete bug is the f+e mutation hole: custom-mode prep aliases `scenario.graph` directly into `scenarioGraph` ([analysisComputePreparationService.ts:445-447](graph-editor/src/services/analysisComputePreparationService.ts#L445)); `applyProbabilityVisibilityModeToGraph` returns the same object for `visibility_mode: 'f+e'` ([CompositionService.ts:48](graph-editor/src/services/CompositionService.ts#L48)); then `recontextScenarioGraph` mutates the aliased graph by projecting posterior fields and engorging `_posteriorSlices`, `_bayes_evidence`, and `_bayes_priors`.

**Problem B — visibility projection is happening too early.** Scenario graphs already carry the layered probability surfaces: promoted forecast (`p.forecast.*`), evidence (`p.evidence.*`), and current answer (`p.mean`, `p.stdev`, completeness). A request graph should carry those layers intact plus `visibility_mode` metadata. Legacy scalar graph runners may still need a local working graph where the single edge probability has been projected to forecast/evidence/blended, but that is a runner adapter concern. It should not mutate the canonical scenario graph sent to CF, cohort maturity, or model-resolver consumers.

**Problem C — in-schema slice projection belongs to materialisation.** The FetchPlanner / from-file refresh path already knows the effective DSL and the relevant parameter files. That is the right place to project file-backed, in-schema graph state: `p.posterior.*`, `p.latency.posterior.*`, `model_vars[bayesian]`, and the promoted `p.forecast.*` surface via `applyPromotion`. Request transport should not silently perform half of materialisation. If a scenario has not been materialised, the caller should materialise it first or be blocked with a clear reason.

**Problem D — the CF endpoint fork duplicates transport.** The CLI's `analyse` command branches on `analysisType === 'conditioned_forecast'` ([cli/commands/analyse.ts:296-328](graph-editor/src/cli/commands/analyse.ts#L296)) and POSTs directly to `/api/forecast/conditioned` instead of going through the prepared-analysis dispatch path. That fork drops `prepared.displaySettings` (73b §7.1), re-engorges graphs that have already gone through analysis preparation, and keeps the CLI from being a clean exercise of the FE path.

### 8.2 Target model

The target is one scenario graph contract, used by FE and CLI, by chart analyses and read-only CF requests, and by both single-scenario and multi-scenario callers.

#### 8.2.1 Scenario materialisation sequence

Scenario materialisation produces graph objects that represent the scenario's intended world for the effective DSL. It runs uniformly across every caller and is upstream of backend request dispatch — there is no transitional "projection inside transport" adapter. The audit (§8.2.1b) found that four callers already run the full materialisation sequence (current edit, live regeneration, refresh-all/boot, share restore); four do not (custom params recipe, graph-bearing custom recipe, fixed recipe, CLI `analyse`). Stage 5 item 7 extracts the FE topo step into a standalone helper so the laggard callers run the same sequence.

1. **Resolve scenario source policy.** Live scenarios come from tab scenario state; custom and fixed canvas/chart recipes come from stored scenario specs; CLI scenarios come from parsed command flags. The policy decides where scenario definitions come from, but it does not define a backend contract.
2. **Resolve the effective DSL per scenario.** Live scenarios inherit Base plus lower live scenario DSLs as today. Custom recipes combine the current/base DSL with stored deltas. Fixed recipes use their baked absolute DSL. CLI scenarios use the explicit temporal/context DSL after subject extraction.
3. **Compose parameter overlays when required.** Current uses the current graph projection. Live scenario regeneration composes Base plus the visible overlays below the scenario before fetching. Custom/fixed specs that carry `params` apply those params to the chosen base graph. Specs that carry an already materialised `graph` do not need overlay composition at this step.
4. **Hydrate file-backed data for the effective DSL.** The FetchPlanner identifies the required parameter/case files and slice identity. From-file refresh or fetch execution projects file-backed state onto the scenario graph for that effective DSL. This is where in-schema projection belongs: `p.posterior.*`, `p.latency.posterior.*`, `model_vars[bayesian]`, and promotion to `p.forecast.*`.
5. **Run FE topo on the isolated scenario graph.** `enhanceGraphLatencies` plus the Step 2 promotion / current-answer derivation runs for every materialised scenario, populating `model_vars[analytic]` and the current-answer surface (`p.mean`, `p.sd`, `p.latency.completeness`, …). This step is mandatory and uniform across all callers — there is no replay path that bypasses it. Graph-bearing custom recipes are materialised like everything else; their captured current-answer scalars and `model_vars[analytic]` are overwritten by re-derivation against current parameter files. Trade-off explicitly accepted: uniform pipeline behaviour is preferred over preservation of captured numbers. If a future feature needs frozen-snapshot semantics, that is scoped separately.
6. **Run CF enrichment only when the materialisation lifecycle requires final graph state.** Current fetch, live scenario regeneration, share/chart refresh, and CLI deterministic aggregation may wait for or apply CF according to their lifecycle. Pure read-only request transport does not itself make a graph "more current"; it consumes whatever materialised graph the caller supplies.

Output: a materialised scenario set. Each scenario has a graph whose in-schema layers reflect its effective DSL, plus scenario metadata such as id, name, colour, `visibility_mode`, and effective DSL.

#### 8.2.1a Persistence audit (28-Apr-26)

The audit covered the storage paths in this codebase that persist or replay scenario state. Findings below answer five questions for each path: does the path supply a materialised graph; where is the materialise-first step; which in-schema fields survive replay; which fields are re-derived; are request-only fields kept out of persisted state.

##### Tab scenario packs (live scenario deltas in IDB)

1. Params-only. Scenario records in `db.scenarios` carry `params: ScenarioParams`; the live graph itself is never persisted in scenario records. On replay, `ScenariosContext` composes params with the base graph via [buildGraphForAnalysisLayer()](graph-editor/src/services/CompositionService.ts#L401) before each analysis or render.
2. Capture uses [extractDiffParams()](graph-editor/src/services/GraphParamExtractor.ts#L487); replay uses [applyComposedParamsToGraph()](graph-editor/src/services/CompositionService.ts#L179). Live-scenario regeneration calls `buildGraphForAnalysisLayer` per scenario, materialising each one independently.
3. In-schema fields preserved are exactly the explicit whitelists [PROBABILITY_POSTERIOR_FIELD_WHITELIST](graph-editor/src/services/GraphParamExtractor.ts#L191) and [LATENCY_FIELD_WHITELIST](graph-editor/src/services/GraphParamExtractor.ts#L176): `p.mean`, `p.stdev`, `p.stdev_pred`, `p.n`, `p.posterior.{alpha, beta, hdi_lower, hdi_upper, ess, rhat, fitted_at, fingerprint, provenance, cohort_alpha, cohort_beta}`, `p.forecast.{mean, stdev}`, `p.evidence.{mean, stdev, n, k}`, `p.latency.{completeness, t95, posterior.*}`.
4. Re-derived on replay (not stored): `p.latency.{mu, sigma, onset_delta_days, promoted_*}` are produced via the promotion cascade in [posteriorSliceContexting](graph-editor/src/services/posteriorSliceContexting.ts) when contextualising for the active DSL.
5. Request-only fields (`_posteriorSlices`, `_bayes_evidence`, `_bayes_priors`) are not in any whitelist and are never serialised into params. Engorgement runs on request-graph copies via [engorgeGraphEdges()](graph-editor/src/lib/bayesEngorge.ts#L362). Live-graph persistence is protected by [stripBayesRuntimeFieldsFromGraphInPlace()](graph-editor/src/lib/bayesGraphRuntime.ts#L31), called before any save to IDB or repo.

##### Chart files — custom recipe, params-only

1. Params-only. `CanvasAnalysis.recipe.scenarios[].params` is a params overlay; no graph is stored. On replay, [prepareAnalysisComputeInputs()](graph-editor/src/services/analysisComputePreparationService.ts#L357) applies the params via `applyComposedParamsToGraph()` before recontexting.
2. The materialise-first step is inside `prepareAnalysisComputeInputs`: `applyComposedParamsToGraph(scenarioGraph, scenario.params)` followed by [recontextScenarioGraph()](graph-editor/src/services/analysisComputePreparationService.ts#L35). Today this happens *during* request preparation — that is exactly the conflation 73e seeks to relocate, and is also where the 73b §3.2 mutation hole lives.
3. Same whitelist as tab packs. Capture path is [captureTabScenariosToRecipe](graph-editor/src/services/captureTabScenariosService.ts) using [getComposedParamsForLayer()](graph-editor/src/services/CompositionService.ts#L125).
4. Latency Bayesian scalars re-derived during materialisation via [contextGraphForEffectiveDsl()](graph-editor/src/services/posteriorSliceContexting.ts).
5. Not applicable for params-only recipes (no graph object). The `analysis_result` carried in chart `payload` is an `AnalysisResult` DTO, not a graph.

##### Chart files — custom recipe, graph-bearing

1. The recipe carries an already-materialised graph. [analysisComputePreparationService.ts:444](graph-editor/src/services/analysisComputePreparationService.ts#L444) checks `hasGraphShape(scenario.graph)` and uses it directly.
2. The stored graph *is* the materialise-first artefact; no further composition runs at replay.
3. Same whitelisted set, embedded in the stored graph object. Latency Bayesian scalars are read directly from the stored graph rather than re-derived.
4. Nothing is re-derived. This is safe only while parameter files and effective DSL are stable between capture and replay.
5. **Risk**: the audit found no explicit Bayes-runtime strip pass between "engorged analysis output" and "graph stored in chart recipe" inside `chartOperationsService`. If an engorged graph is captured into a recipe before stripping, `_posteriorSlices` / `_bayes_evidence` / `_bayes_priors` could leak into persisted JSON. This is the most plausible existing leak surface.

##### Chart files — fixed recipe

1. Data-only. Fixed-recipe charts (`analysis_funnel`, `analysis_bridge`) carry no graph and no params, only the analysis result DTO and scenario metadata. On replay the analysis is re-executed from DSL plus scenario definitions.
2. Not applicable — replay re-runs the analysis with fresh materialisation.
3. Not applicable.
4. Not applicable.
5. Not applicable; only the analysis result payload (a DTO) is stored.

##### Share payloads

1. DSL-only. Share payloads ([sharePayload.ts](graph-editor/src/lib/sharePayload.ts)) carry DSLs (`graph_state.base_dsl`, `graph_state.current_query_dsl`, `scenarios.items[].dsl`, `analysis.query_dsl`), not params or graphs.
2. On share boot, [shareBootResolver.ts](graph-editor/src/lib/shareBootResolver.ts) loads the graph file from the repo (or static payload) and re-materialises via composition. Live scenarios are reconstructed from `scenarios.items[].dsl`.
3. Not applicable — payloads carry text only.
4. Everything; share payloads are snapshots of the DSL, not of the data.
5. Safe — payloads are text-only. The `analysis_result` sub-object included in chart-target shares is a plain DTO.

##### Canvas / view restore

1. Layout-only. [snapshotScenarios()](graph-editor/src/services/canvasViewService.ts#L116) captures scenario blueprints with `.queryDSL` (live) or `.params` (custom), plus `.visibility_mode`. No graphs are stored.
2. Views do not materialise graphs; [applyCanvasView()](graph-editor/src/services/canvasViewService.ts#L184) applies layout state only. Scenario composition happens elsewhere via the active `ScenariosContext`.
3. Scenario blueprints store `.params` (same whitelist as tab packs) for custom and `.queryDSL` for live. No posterior or latency fields live in the view itself.
4. Not applicable; views are layout, not graphs.
5. Not applicable.

##### Refresh-all / boot hydration

1. Re-materialised on demand. Boot hydration does not replay full scenarios from a snapshot; each scenario is rebuilt via `buildGraphForAnalysisLayer()` when needed.
2. Refresh-all triggers re-composition and re-contexting for the current DSL.
3. Materialised graphs include all whitelisted in-schema fields. On DSL change, [contextLiveGraphForCurrentDsl()](graph-editor/src/services/posteriorSliceContexting.ts) re-projects posteriors to the new effective DSL.
4. Latency Bayesian scalars re-derived on every materialisation/refresh via contexting.
5. Live graph protected by `stripBayesRuntimeFieldsFromGraphInPlace()` before save. Request graphs engorged on copies only via [buildEngorgedBayesGraphSnapshot()](graph-editor/src/lib/bayesEngorge.ts#L449).

##### Risk summary

The audit closes more questions than it opens.

- **Materialise-first is already in place for params-only persistence.** Tab packs, custom params recipes, canvas view blueprints, and share payloads are params-or-DSL only and rely on a materialise-first replay step that already exists. If in-schema projection moves out of `recontextScenarioGraph`, the projection step must remain in the per-scenario analysis path — but no storage redesign is required for these paths.
- **Graph-bearing custom recipes are the live leak risk.** No explicit Bayes-runtime strip pass was found between "engorged analysis output" and "chart recipe persistence". This finding is new (not flagged in 73b §3.2, which covers only the in-prep mutation alias). Closed by Stage 1 item 6: the same clone/strip helper that fixes the in-prep mutation hole runs at chart-write sites that embed a graph snapshot.
- **Share boot relies on parameter file availability.** Replay re-materialises from the repo at boot. If a parameter file's posterior changes between author and viewer, the replayed graph will carry different Bayesian scalars. This is the documented contract — shares snapshot DSL, not data — but it should be reflected in the materialisation/replay contract once the contract is documented.

Conclusion: the staged plan does not need a transitional "request-side projection allowed for path X" carve-out for any params-only path. Custom recipes carrying full graphs do need a strip-before-store guarantee, and the audit recommends it ship with Stage 1 (the clone/strip helper exists) rather than wait for Stage 5.

#### 8.2.1b Caller audit (28-Apr-26)

The audit mapped each production caller against the seven properties of the materialise/transport flow: composition, external fetch, from-file hydration, FE topo (Stage 2), CF, state storage, failure mode.

##### Current query edit

- **Composition**: runs `buildGraphForAnalysisLayer` for the `current` layer only via `useCanvasAnalysisCompute`. No overlay composition over lower scenarios; the live graph at `current` is used directly with optional `whatIfDSL` applied through [applyComposedParamsToGraph()](graph-editor/src/services/CompositionService.ts#L179).
- **External fetch**: `allowFetchFromSource` defaults to true in canvas flows. DSL change triggers `windowFetchPlannerService.analyse()` and conditional `executeFetchPlan()` via [useDSLReaggregation.ts](graph-editor/src/hooks/useDSLReaggregation.ts).
- **From-file hydration**: [useDSLReaggregation.ts:215](graph-editor/src/hooks/useDSLReaggregation.ts#L215) runs `fetchItems(items, { mode: 'from-file' })` when planner outcome is `'covered'`. Live re-contexting via [contextLiveGraphForCurrentDsl()](graph-editor/src/hooks/useDSLReaggregation.ts#L121) projects parameter file slices onto `p.posterior.*`.
- **FE topo**: `fetchItems()` runs with default `skipStage2: false`; `enhanceGraphLatencies` populates `model_vars[analytic]` on the live graph in batch mode (call site in [fetchDataService.ts](graph-editor/src/services/fetchDataService.ts) around L2114).
- **CF**: graph-mutating CF via `runConditionedForecast()` from [fetchDataService.ts](graph-editor/src/services/fetchDataService.ts) (around L2297) applied to the live graph through `UpdateManager.applyBatchLAGValues`.
- **State storage**: live graph persists to IDB via the GraphStore `setGraph()` path; current params merge back into the live layer via `setCurrentParams()`.
- **Failure mode**: single-scenario; planner failure shows a warning toast and an operation registry entry. Fetch is skipped but the current graph remains usable. No silent-miss surface.

##### Live scenario regeneration

- **Composition**: each visible scenario composed independently from Base plus overlays below it in the visible stack via `computeInheritedDSL()` and `applyComposedParamsToGraph()`. Each scenario receives a fresh baseline graph copy.
- **External fetch**: controlled by `options?.allowFetchFromSource` (defaults true in canvas; false in share/live-link contexts). Planner is skipped when false; from-file refresh only.
- **From-file hydration**: `fetchDataService.fetchItems()` with `mode: 'from-file'` per scenario; from-file refresh projects slices via `posteriorSliceContexting`.
- **FE topo**: Stage 2 runs by default (`skipStage2: false`).
- **CF**: graph-mutating CF runs as part of the Stage-2 race when planner included CF items.
- **State storage**: extracted diff params persist to `scenario.params` in `ScenariosContext` and IDB via the storage hook. Live graph remains the authority; scenario params are sparse deltas.
- **Failure mode**: `regenerateAllLive()` continues with remaining scenarios on per-scenario error; failed scenarios are marked "regeneration failed". Stale params may render if fetch times out — partial render risk.

##### Refresh all / view restore / boot hydration

- **Composition**: each visible scenario composed independently from Base plus overlays below (same flow as live regeneration).
- **External fetch**: `allowFetchFromSource: false` for boot/share contexts (set via the share boot hooks). Planner is skipped; from-file only.
- **From-file hydration**: bulk `fetchItems({ mode: 'from-file' })` per scenario.
- **FE topo**: Stage 2 runs by default unless `skipStage2: true` is explicitly passed.
- **CF**: graph-mutating CF runs in the Stage-2 race for each scenario.
- **State storage**: scenario params persist to IDB through `ScenariosContext`. Boot hydration commits state once all scenarios are ready (atomic).
- **Failure mode**: partial render. Per-scenario errors are logged but the loop continues; failed scenarios show stale or missing data.

##### Custom recipe — params only

- **Composition**: `applyComposedParamsToGraph()` applies stored params to the base graph; no overlay composition. Entry point at [analysisComputePreparationService.ts:415](graph-editor/src/services/analysisComputePreparationService.ts#L415).
- **External fetch**: not applicable; params are baked into the recipe.
- **From-file hydration**: deferred to request-prep. [recontextScenarioGraph()](graph-editor/src/services/analysisComputePreparationService.ts#L35) projects parameter file slices into the composed graph.
- **FE topo**: does not run during recipe materialisation. `prepareAnalysisComputeInputs` does not call `fetchDataService.fetchItems()` for custom/fixed recipes — request graphs are prepared inline without Stage-2 enhancement. **Gap**: scenarios lack `model_vars[analytic]`.
- **CF**: does not run during recipe materialisation. Read-only analysis dispatch currently omits CF enrichment; the CLI's CF branch routes outside the prepared dispatcher (73b §7.1).
- **State storage**: graph is dispatched to backend; no IDB persistence expected.
- **Failure mode**: if `resolveParameterFile` is absent or lookup fails, in-schema projection is silently skipped. Engorgement still clears `_posteriorSlices` to prevent leakage — but the graph carries stale or missing posterior. Silent miss.

##### Custom recipe — graph-bearing

- **Composition**: recipe supplies a pre-materialised graph; no composition step. [analysisComputePreparationService.ts:444](graph-editor/src/services/analysisComputePreparationService.ts#L444) checks `hasGraphShape(scenario.graph)` and uses it directly.
- **External fetch**: not applicable.
- **From-file hydration**: same as params-only — deferred to request-prep.
- **FE topo**: does not run today. Closed by Stage 5 item 7: graph-bearing recipes run the same FE topo helper as everything else, so `model_vars[analytic]` and the current-answer surface are re-derived regardless of what the captured graph carries.
- **CF**: does not run.
- **State storage**: graph dispatched to backend; no IDB persistence expected. (See §8.2.1a: chart writes lack an explicit Bayes-runtime strip pass before storage — closed by Stage 1 item 6.)
- **Failure mode**: stale or incomplete graphs are not detected at prep time today. Closed by Stage 5 items 3 + 7: graph-bearing recipes are re-materialised on every replay, so the captured graph is informational rather than authoritative; if projection fails because parameter files are missing, the failure is session-logged per Stage 5 item 6.

##### Fixed recipe

- **Composition**: `effective_dsl` is baked absolute (not rebased). [applyProbabilityVisibilityModeToGraph()](graph-editor/src/services/CompositionService.ts#L43) applies stored visibility mode; no param composition.
- **External fetch**: not applicable.
- **From-file hydration**: `recontextScenarioGraph()` projects parameter file slices using the recipe's `effective_dsl`; DSL is from recipe, not current graph.
- **FE topo**: does not run.
- **CF**: does not run.
- **State storage**: dispatched to backend; no IDB persistence.
- **Failure mode**: malformed `effective_dsl` or missing files cause silent degradation in projection. Silent miss.

##### Share restore

- **Composition**: `buildGraphForAnalysisLayer()` is not called during chart restore; for chart files, the graph is restored from `graph_state` in the payload via the share-boot hooks.
- **External fetch**: `allowFetchFromSource: false` is explicitly set. Planner is skipped; only from-file fetch attempted.
- **From-file hydration**: `regenerateScenario()` with `allowFetchFromSource: false` runs from-file refresh; from-file hydration projects parameter file slices.
- **FE topo**: runs via `fetchItems()` with default `skipStage2: false`.
- **CF**: graph-mutating CF runs in the Stage-2 race only if planner included items, but planner is skipped — so CF runs only if the share bundle pre-computed CF data (atypical for static shares).
- **State storage**: restored scenarios persist to IDB via `ScenariosContext`. Share bundle state is transient; scenarios are hydrated into the live context.
- **Failure mode**: from-file refresh failure (missing files) shows scenarios as "unavailable" or stale. Share bundles can render with incomplete posterior if parameter files are missing from the repo.

##### CLI analyse — standard analyses

- **Composition**: each scenario aggregated independently via `aggregateAndPopulateGraph()` running fetch/from-file for that scenario's `queryDsl`. Scenarios are not composed cumulatively; each is base + its params.
- **External fetch**: controlled by `--allow-external-fetch`. `mode: 'versioned'` if true; `mode: 'from-file'` if false.
- **From-file hydration**: `aggregateAndPopulateGraph()` runs the fetch pipeline with `resolveParameterFile` from the bundle parameter map; from-file refresh projects slices via `contextGraphForEffectiveDsl()`.
- **FE topo**: today, `prepareAnalysisComputeInputs` does not trigger `fetchItems()` for custom-mode scenarios with pre-aggregated graphs and Stage 2 is skipped at request-prep time. CLI scenarios therefore arrive at transport without `model_vars[analytic]` or the current-answer surface, which can produce CLI/browser numerical divergence. Closed by Stage 5 item 7: CLI invokes the FE topo helper as part of materialisation, matching browser semantics.
- **CF**: does not apply. Standard analyses route through `runPreparedAnalysis()` to the backend analyser; the backend owns CF if needed.
- **State storage**: none. Result is written to stdout; scenarios are ephemeral.
- **Failure mode**: aggregation failure logs a warning and continues with remaining scenarios. Prepared state of `'blocked'` exits with an error message.

##### CLI analyse — `conditioned_forecast` branch

- **Composition**: same as standard — independent aggregation per scenario via `aggregateAndPopulateGraph()`.
- **External fetch**: same — controlled by `--allow-external-fetch`.
- **From-file hydration**: `aggregateAndPopulateGraph()` runs from-file refresh; in addition, [buildConditionedForecastGraphSnapshot()](graph-editor/src/cli/commands/analyse.ts#L311) is called to engorge request-only fields.
- **FE topo**: does not run before [/api/forecast/conditioned](graph-editor/src/cli/commands/analyse.ts#L304) dispatch. CLI bypasses the prepared dispatcher and hand-rolls the CF payload at [analyse.ts:296](graph-editor/src/cli/commands/analyse.ts#L296), calling `buildConditionedForecastGraphSnapshot()` directly on prepared scenarios. **Defect**: double-engorgement (`recontextScenarioGraph` already engorged) and `display_settings` omitted (73b §7.1).
- **CF**: dispatches directly to `/api/forecast/conditioned`, not through `runPreparedAnalysis()`.
- **State storage**: stdout; ephemeral.
- **Failure mode**: HTTP failure exits with fatal error. No partial retry or fallback.

##### Materialisation gap summary

Callers that already produce a fully-materialised graph at the `prepareAnalysisComputeInputs` boundary, and which run all relevant materialisation steps upstream:

1. **Current query edit** — composition (current-only), from-file, FE topo, and CF run upstream via `useDSLReaggregation` before analysis prep.
2. **Live scenario regeneration** — composition, from-file, Stage 2, CF run in-context per scenario.
3. **Refresh all / view restore / boot hydration** — bulk materialisation via `regenerateAllLive`.
4. **Share restore** — composition, from-file, and Stage 2 run during scenario regeneration before analysis prep, with `allowFetchFromSource: false`.

Callers that need an adapter or materialise-first step before transport:

5. **Custom recipe — params only**: today, from-file projection happens in transport, not materialisation; Stage 2 is skipped; `model_vars[analytic]` missing; CF not applied. Closed by Stage 5 items 2 + 7.
6. **Custom recipe — graph-bearing**: today, assumes the recipe graph is already materialised; no validation; FE topo doesn't run; also the source of the graph-bearing-recipe leak surface flagged in §8.2.1a. Closed by Stage 1 item 6 (strip leak surface) and Stage 5 items 3 + 7 (uniform materialisation including FE topo).
7. **Fixed recipe**: today, same gap as params-only; Stage 2 not run at prep. Closed by Stage 5 items 2 + 7.
8. **CLI analyse — standard**: today, aggregates per scenario before prep but Stage 2 is skipped; scenarios lack `model_vars[analytic]`. Closed by Stage 5 item 7.
9. **CLI analyse — `conditioned_forecast`**: double-engorgement and `display_settings` omission (73b §7.1); routes outside the prepared dispatcher. Closed by Stage 2 of this proposal.

Silent-miss surfaces (no error, just degraded output):

- Custom and fixed recipes silently skip in-schema projection if `resolveParameterFile` lookup fails. The graph carries stale or missing posterior with no error. Closed by Stage 5 item 6.
- Share restore silently degrades if parameter files are missing from the repo at boot. Closed by Stage 5 item 6.
- CLI standard analyses skip Stage 2 (FE topo) today. Closed by Stage 5 item 7.

The audit confirms the proposal's working assumption: callers split cleanly into "already materialised" and "materialised inside transport". Stages 1, 2, and 5 cover the five caller groups that need work; the four already-materialised callers should not regress.

#### 8.2.2 Request transport sequence

Request transport preparation starts only after materialisation.

1. **Take the materialised scenario graph as input.** Materialised means composition, file projection, and FE topo have all run for the effective DSL. The graph must not be caller-owned mutable state that transport helpers may mutate in place.
2. **Use a coherent parameter-file view.** Engorgement should use the same file view, revision, or resolver context as materialisation where practical. If the implementation cannot guarantee that, first measure whether the race exists and use existing dependency stamps before adding new invalidation machinery.
3. **Clone and strip request-runtime fields.** The backend-bound graph is a fresh copy, with stale request-only runtime fields removed before new request-only fields are attached. This closes the f+e aliasing bug without relying on visibility-mode side effects for cloning.
4. **Engorge request-only Bayes material.** Attach `_posteriorSlices`, `_bayes_evidence`, and `_bayes_priors` to the cloned request graph from parameter files. These fields are out-of-schema process-boundary payload and must never persist back onto live graphs, scenario recipes, or chart files.
5. **Attach transport metadata.** Each scenario carries `scenario_id`, name, colour, `effective_query_dsl`, `visibility_mode`, candidate regimes, and compute-affecting display settings. `visibility_mode` travels as metadata, not as a mutation to the scenario graph's layered probability state.
6. **Dispatch by endpoint inside the prepared-analysis layer.** Read-only analyses dispatch to `/api/runner/analyze`; read-only conditioned forecast dispatches to `/api/forecast/conditioned`; callers such as CLI and canvas should not hand-roll endpoint-specific scenario payloads.

#### 8.2.3 Legacy scalar-runner visibility adapter — audit (28-Apr-26)

Audit findings answering the four questions raised by §8.2.3.

##### TS-side `applyProbabilityVisibilityModeToGraph` call sites

There are exactly two production call sites:

1. [CompositionService.ts:423](graph-editor/src/services/CompositionService.ts#L423) — inside `buildGraphForAnalysisLayer` when an explicit `visibilityMode` is passed. Returns a new graph (the helper itself returns a new object; see also the f+e aliasing bug at 73b §3.2).
2. [analysisComputePreparationService.ts:457](graph-editor/src/services/analysisComputePreparationService.ts#L457) — custom-recipe scenario prep. Applies `visibilityMode` to the scenario graph before re-contexting and engorgement.

The helper itself is defined at [CompositionService.ts:43](graph-editor/src/services/CompositionService.ts#L43).

##### BE-side `apply_visibility_mode` call sites

The Python helper is defined at [graph_builder.py:579](graph-editor/lib/runner/graph_builder.py#L579). It is called from exactly one place:

- [runners.py:69](graph-editor/lib/runner/runners.py#L69), inside `_prepare_scenarios` ([runners.py:31](graph-editor/lib/runner/runners.py#L31)).

`_prepare_scenarios` is called by every scalar-runner consumer in the codebase — at least 13 sites in [runners.py](graph-editor/lib/runner/runners.py) (lines 121, 213, 391, 614, 692, 817, 1175, 1674, 1864, 1961, 2044, …) covering: `run_path`, `run_path_to_end`, `run_single_node_entry`, `run_bridge_view`, `run_path_through`, `run_end_comparison`, `run_branch_comparison`, `run_partial_path`, `run_general_stats`, plus the conversion-funnel and constrained-path runners. All of these convert the request graph to NetworkX, then read the scalar `edge.p` set by `apply_visibility_mode`. None re-applies visibility itself.

Layered-graph analyses (`cohort_maturity`, `daily_conversions`, `lag_*`, `surprise_gauge`) do **not** call `_prepare_scenarios` and are therefore unaffected — they receive the request graph with all layered surfaces intact, as Stage 4 step 3 requires.

##### Tests pinning output semantics

These pin runtime output and would survive a TS→Python relocation provided the Python logic produces the same numbers (which it does today):

- [CompositionService.probabilityVisibilityMode.strictEvidence.test.ts:23-41](graph-editor/src/services/__tests__/CompositionService.probabilityVisibilityMode.strictEvidence.test.ts#L23) — `e` mode reads `p.evidence.mean`.
- [CompositionService.probabilityVisibilityMode.strictEvidence.test.ts:43-59](graph-editor/src/services/__tests__/CompositionService.probabilityVisibilityMode.strictEvidence.test.ts#L43) — sibling residual allocation when evidence is missing.
- [CompositionService.analysisIsolation.test.ts:7-63](graph-editor/src/services/__tests__/CompositionService.analysisIsolation.test.ts#L7) — non-cumulative per-scenario composition (independent of visibility).
- `test_conversion_funnel_v2.py` — output values for e/f/f+e modes (e.g. `test_e_mode_bars_match_evidence_ratios`, `test_f_mode_bars_match_path_product_of_means`).
- `test_funnel_contract.py`, `test_lag_fields.py` — additional Python visibility coverage at the request-graph level.

##### Tests pinning implementation location

None found. No test asserts "projection runs in TS" or "projection runs before dispatch" or pins a specific file/function as the projection owner. All visibility tests assert output values or composition semantics, not execution location.

##### Localisation safety

Python's `_prepare_scenarios` already owns visibility for every scalar-runner consumer. Scalar runners read `edge.p` directly after `_prepare_scenarios` runs; none re-applies visibility, and none would tolerate double-application either. If TS stops projecting:

- Python applies `apply_visibility_mode` to the same scenario graph and produces the same `edge.p` values that scalar runners then consume.
- Tests asserting output values continue to pass (Python is the sole projector and produces identical numbers).
- The f+e aliasing bug fixed by Stage 1 stops mattering altogether for scalar-runner consumers, because TS no longer projects.
- Layered-graph analyses are unaffected — they never went through `_prepare_scenarios` in the first place, and would now also avoid any TS-side projection of their request graph.

The only requirement is that `visibility_mode` still travels as scenario metadata so Python knows what to apply. §8.2.2 step 5 already specifies this.

##### Conclusion

**Safe to remove TS-side visibility projection for scalar-runner consumers.** Python `_prepare_scenarios` is the canonical owner; TS projection is duplicate work that today only exists for historical reasons and is the source of the f+e aliasing bug at 73b §3.2.

Removal is also clean for layered-graph analyses: the audit confirmed no `cohort_maturity` / `daily_conversions` / `lag_*` / `surprise_gauge` runner currently calls `_prepare_scenarios`, so removing TS projection prevents accidental destructive projection on their request graphs and matches Stage 4 step 3's intent.

Stage 4 can therefore proceed concretely rather than conditionally — see updated stage body.

### 8.3 Implementation plan

The research pass changes the implementation plan in one important way: do **not** start by moving all contexting/materialisation work. Current code has real caller differences:

- production preparation callers are `useCanvasAnalysisCompute`, `AnalyticsPanel`, and CLI `analyse`;
- scenario packs are sparse deltas and do **not** carry `model_vars`;
- TS and Python both currently perform visibility projection in different places;
- browser CF shares engorgement utilities with analysis prep, but does **not** run the full effective-DSL re-contexting step that CLI/read-only analysis prep runs;
- `graphComputeClient` cache keys are intentionally lean and should be sanity-checked, not redesigned as part of the first cleanup.

The implementation should therefore proceed in stages that reduce known risk first and only move boundaries after the relevant caller has coverage.

#### Stage 0 — consumer contract review (complete)

Purpose: make the intended consumer contracts explicit before changing code. This review has been completed; concrete consequences have been moved into the implementation stages below.

1. **Read-only CLI conditioned forecast — done.**
2. **Browser canvas/panel live analysis — done.**
3. **Browser custom/fixed chart or canvas analysis — done.**
4. **Browser CF enrichment for Current — done.**
5. **Live scenario regeneration — done.**
6. **Python scalar graph runners — done.**
7. **Snapshot/forecast analyses such as cohort maturity — done.**
8. **Chart/share restore and refresh — done.**
9. **Analysis cache — done.**

#### Stage 1 — fix the known mutation leak without changing semantics

Purpose: close 73b §3.2 safely.

1. **Blind test first.** Add the custom f+e mutation guard before changing implementation: `mode: 'custom'`, caller-provided `scenario.graph`, `visibility_mode: 'f+e'`, and `resolveParameterFile`; assert returned graph identity differs from input graph and request-only fields appear only on the returned graph.
2. In `prepareAnalysisComputeInputs`, ensure every custom-mode `scenario.graph` is cloned before any visibility projection, re-contexting, or engorgement can run.
3. Prefer a clone helper that strips stale request-only runtime fields before re-attaching fresh request-only fields.
4. Preserve existing params-only custom/fixed behaviour. Stage 1 must not require recipes to carry full materialised graphs.
5. Keep TS-side visibility projection and current re-contexting behaviour unchanged in this stage.
6. **Close the persisted leak surface (§8.2.1a graph-bearing custom recipes).** The clone/strip helper from items 2–3 must also run at the chart-write sites that embed a full graph snapshot in a custom recipe, so request-only attachments cannot leak to disk via a saved chart. Add a save-side mutation guard mirroring item 1: capture an engorged graph, save it through the chart-write path, assert no `_posteriorSlices`, `_bayes_evidence`, or `_bayes_priors` survive on the persisted file. No new helper code — the helper from items 2–3 is reused as-is at one additional call site.

This stage remains tightly scoped: items 2–3's helper is the only new code, and items 1, 5, and 6 are guard tests plus existing-call-site wiring.

#### Stage 2 — consolidate read-only CF dispatch

Purpose: close 73b §7.1 and remove the CLI special case.

Stage 0 conclusion for this consumer: read-only CLI `conditioned_forecast` is an analysis command surface, not graph enrichment. It already runs `prepareAnalysisComputeInputs(mode: 'custom')` with per-scenario materialised graphs and `resolveParameterFile`, but then bypasses `runPreparedAnalysis`, builds a hand-rolled `/api/forecast/conditioned` payload, omits `display_settings`, and calls `buildConditionedForecastGraphSnapshot` on graphs that have already been through preparation. That is a real contract defect, not just missing coverage.

1. **Blind test first.** Add one focused CLI/prepared-dispatch `conditioned_forecast` test with fetch mocked. It must fail against current code by proving the command should use the prepared CF dispatcher, forward `display_settings`, preserve scenario ids/effective DSL/candidate regimes, and not perform a second engorgement pass on a transport-ready graph.
2. Add a prepared CF dispatcher used by `runPreparedAnalysis` when `analysisType === 'conditioned_forecast'`.
3. Build the CF payload from the already prepared scenarios and forward `prepared.displaySettings`.
4. Delete the CLI's direct `/api/forecast/conditioned` branch.
5. Avoid double-engorgement: if the prepared graph is already the request graph, do not call `buildConditionedForecastGraphSnapshot` again on it. If clone/strip is still needed for transport hygiene, do it once in the shared prepared-CF payload builder.
6. Keep browser graph-mutating CF enrichment (`runConditionedForecast` from `fetchDataService`) on its existing lifecycle. It already owns the Stage-2 race, supersession generation, timeout, fast-path merge, slow-path overwrite, and `UpdateManager.applyBatchLAGValues` apply semantics; it must not be routed through read-only prepared dispatch in this stage.

This stage aligns CLI/read-only analysis without touching the fetch-pipeline CF race/apply path.

#### Stage 3 — close 73b §3.1 in the live/materialisation path

Purpose: make live/current DSL re-contexting update the full in-schema Bayesian surface.

1. **Blind test first.** Add/adjust the `liveEdgeReContextOnDslChange` shape so it exercises the production hook/service path, not a test-only helper. Changing current DSL should update `p.posterior.*`, `p.latency.posterior.*`, upsert `model_vars[bayesian]`, preserve `model_vars[analytic]`, and refresh `p.forecast.*` via promotion.
2. Update production live/current DSL re-contexting so the selected slice updates `p.posterior.*`, `p.latency.posterior.*`, `model_vars[bayesian]`, and then runs promotion.
3. Preserve `model_vars[analytic]`.
4. Do not require scenario packs to carry `model_vars`; continue treating deeper source state as file-backed unless a later audit proves packs need a field added.

This stage moves the obvious live-path gap without forcing a full scenario-pack redesign.

#### Stage 4 — remove TS-side visibility projection

Purpose: per §8.2.3 audit, Python `_prepare_scenarios` already owns visibility for every scalar-runner consumer; TS-side projection is duplicate work and the source of the 73b §3.2 aliasing bug. Stage 4 removes it.

1. **Blind tests first.** Run the existing visibility coverage as a baseline before changing code: TS `CompositionService.probabilityVisibilityMode.strictEvidence.test.ts`, `CompositionService.analysisIsolation.test.ts`; Python `test_conversion_funnel_v2.py`, `test_funnel_contract.py`, `test_lag_fields.py`. Capture the current output numbers; these must be unchanged after Stage 4.
2. Remove the visibility projection call at [analysisComputePreparationService.ts:457](graph-editor/src/services/analysisComputePreparationService.ts#L457). Custom-recipe scenario prep stops projecting before re-contexting / engorgement.
3. Drop the `visibilityMode` parameter from [`buildGraphForAnalysisLayer`](graph-editor/src/services/CompositionService.ts#L401) and the projection branch at [CompositionService.ts:422-424](graph-editor/src/services/CompositionService.ts#L422). Update all call sites that currently pass `visibilityMode` to drop the argument.
4. Keep the helper `applyProbabilityVisibilityModeToGraph` itself ([CompositionService.ts:43](graph-editor/src/services/CompositionService.ts#L43)) in place for now in case any non-production caller (storybook, debug tooling) still needs it. Removing the helper entirely is a small follow-up once grep confirms zero call sites.
5. Confirm `visibility_mode` still travels as scenario metadata in the transport payload (§8.2.2 step 5) so Python's `_prepare_scenarios` keeps receiving it.
6. Re-run the baseline tests from item 1. Output values must match exactly; if any number moves, stop and investigate — Python's `apply_visibility_mode` is supposed to produce identical results.
7. Confirm via grep that no `cohort_maturity` / `daily_conversions` / `lag_*` / `surprise_gauge` runner currently calls `_prepare_scenarios`. The audit found none; this is a final sanity check before merge.

This stage is now concrete rather than conditional. The audit established that Python is the canonical owner and TS projection is removable; Stage 4 just executes that.

#### Stage 5 — materialise custom/fixed/share paths where needed

Purpose: remove remaining request-prep materialisation only after the caller can supply a real materialised graph.

1. **Blind tests first.** Add/adjust only the tests required by the path being changed:
   - fixed-mode DSL test: fixed `effective_dsl` is baked absolute and must not be rebased or combined with the current graph DSL during preparation;
   - scenario-regeneration pack extraction test: after FE topo + CF update the isolated scenario graph, `extractDiffParams` captures scenario-visible CF/current-answer fields needed for replay and does not capture request-only fields;
   - share/chart test only if a touched path changes: per-scenario graphs from payload graph_state + scenario definitions, bridge current-last ordering, effective_query_dsl/candidate regimes for snapshot analyses, no silent partial requests.
2. For params-only custom and fixed recipes, materialise before transport. Apply the params overlay, project file-backed posterior slices for the effective DSL, run FE topo. Request-prep consumes an already-materialised graph; no transitional in-prep projection.
3. For graph-bearing custom recipes, materialise like everything else. The captured graph is a starting point, not a frozen artefact: projection refreshes `p.posterior.*` and `p.latency.posterior.*` from current parameter files, and FE topo refreshes `model_vars[analytic]` plus the current-answer surface. If the captured graph is internally consistent and no parameter files have evolved since capture, the materialised result reproduces the same numbers; otherwise it reflects current files. There is no replay path that preserves captured numerical state.
4. For share restore and chart refresh, preserve the existing contract: share boot uses isolated storage, dependency hydration, no external fetch unless explicitly allowed, `buildGraphForAnalysisLayer`, candidate regime attachment for snapshot analyses, and explicit failure/blocking when workspace identity or date range is missing.
5. Keep scenario packs sparse unless a specific missing field is proven to be required and cannot be re-derived from graph/file state.
6. **Materialisation failure must be observable (closes §8.2.1b silent-miss surfaces).** When materialisation cannot complete for a scenario edge — parameter file absent, slice missing for the effective DSL — the step must emit a `warning`-level `sessionLogService` entry naming the affected edge, the missing input (file path or slice key), and the scenario id. The scenario must carry a "not fully materialised" marker through to dispatch rather than being silently treated as ready. Downstream surfacing — a "data unavailable" badge on the chart, a "missing parameter files" banner on share restore, a non-zero CLI exit listing the affected scenarios — reads that signal; it does not invent it. The session log entry is the contract; the visible UI/CLI is its rendering.
7. **FE topo runs in every materialisation path (closes §8.2.1b CLI Stage 2 gap and the recipe gaps).** Extract FE topo invocation (`enhanceGraphLatencies` plus Step 2 promotion / current-answer derivation) from being fetch-pipeline-only into a standalone helper callable from any materialisation site after projection lands. Wire the four laggard callers — params-only custom recipe, graph-bearing custom recipe, fixed recipe, CLI `analyse` — into the helper. The four callers that already materialise (current edit, live regeneration, refresh-all/boot, share restore) keep invoking FE topo through the fetch pipeline; the new helper is the same code, just usable outside it.

#### Stage 6 — CLI flag `--no-be` for simulating "no BE available"

Purpose: provide a deterministic, supported way to run CLI commands as if the backend were unreachable. Same end state a user gets working offline, but on demand. Principally a diagnostic affordance: re-running `param-pack` or `analyse` with vs without `--no-be` distinguishes BE-introduced divergence (CF arithmetic, snapshot-DB queries, `/api/runner/analyze` outputs) from upstream FE-only divergence, which is today only achievable by inducing a network failure.

Important framing: `--no-be` is **not** a no-op for analyses that don't themselves dispatch CF. The flag suppresses every BE call in the run — CF dispatch through the fetch pipeline, `/api/runner/analyze` calls, snapshot-DB queries that go through BE handlers. So:
- For `param-pack`: the only BE call today is CF; `--no-be` is functionally `--no-cf` for this command.
- For `analyse --type conditioned_forecast`: same as above — CF is suppressed, FE topo provisional values stand.
- For `analyse --type cohort_maturity_v3` / `surprise_gauge` / runner-analyze types: the analysis cannot complete because it requires BE-side compute. The flag must surface a clean failure (named scenarios, named analysis type, named missing dependency: BE) rather than a cryptic timeout or success-with-empty-output.
- For analyses that read graph state populated by CF (most of them — anything reading L5 `p.mean`/`p.stdev`/completeness or CF-supplied L4 `evidence_k/n`): the post-fetch graph state under `--no-be` is FE-topo-only, so any later analysis sees provisional values. That is the offline equivalence — it is the point.

End state under `--no-be` (when the command can complete at all):
- L5 populated by FE topo Step 2 provisional values only.
- L4 populated by FE data fetch only; CF's `evidence_k/n` writes do not fire.
- L1 / L1.5 / L2 / L3 unchanged (those have no BE writers).
- CF response-only fields (`cf_mode`, `cf_reason`, `conditioning{}`, `tau_max`, etc.) absent.
- `applyConditionedForecastToGraph` does not run.

Items:

1. **Blind tests first.** Three cases:
   (a) `param-pack` runs with `--no-be` set: assert no fetch is dispatched to the BE host (mock the fetch and assert no calls), `cf_mode` does not appear on output edges, and `p.mean` matches FE-topo Step 2 rather than the post-CF value.
   (b) `analyse --type conditioned_forecast` with `--no-be`: same shape — no BE call, output reflects FE-topo provisional state.
   (c) `analyse --type cohort_maturity_v3` (or any runner-analyze type) with `--no-be`: command exits non-zero with a single clear message naming the analysis type and that BE compute is required. No partial output. No silent success.
   All three must fail against current code.

2. **Single inhibition point in `fetchDataService.fetchItems`.** Add `FetchOptions.skipBackendCalls?: boolean` (default false). When set, the cfPromise short-circuits to `Promise.resolve([])` immediately and any other BE-bound call inside the fetch pipeline (snapshot retrieval that goes via the BE host, etc.) is similarly suppressed. The existing fast-path-deadline / fallback logic at [fetchDataService.ts](../../graph-editor/src/services/fetchDataService.ts) handles the rest naturally — same code path the timeout-fallback already exercises. No changes to the apply mapping or any consumer.

3. **CLI plumbing.** Add `AggregateOptions.skipBackendCalls` in [aggregate.ts](../../graph-editor/src/cli/aggregate.ts) and forward it into `fetchItems`. Register `--no-be` in `extraOptions` for [paramPack.ts](../../graph-editor/src/cli/commands/paramPack.ts) and [analyse.ts](../../graph-editor/src/cli/commands/analyse.ts), mirroring the existing `--no-snapshot-cache` registration. Lift the parsed flag into the option. `hydrate.ts` does not dispatch BE calls — accept the flag silently as a no-op for consistency rather than error.

4. **Direct CF dispatch path in `analyse.ts`.** The analyse command currently has a direct-CF path that bypasses the fetch pipeline (`buildConditionedForecastGraphSnapshot` call site in `analyse.ts`). Stage 2 of this proposal collapses that path into prepared dispatch; if Stage 6 lands after Stage 2, the gating is in one place. If Stage 6 lands before Stage 2, gate the direct path explicitly — bail before the snapshot build when `--no-be` is set, return an empty CF result, emit a session-log entry.

5. **Runner-analyze fail-fast.** For analyse types that require BE-side compute (cohort_maturity_v3, conversion_funnel, lag_*, daily_conversions, conversion_rate, surprise_gauge, branch_comparison, runner registry types), `--no-be` must surface a clean failure at the dispatch site rather than letting the BE call attempt-and-error. Add a single guard at the runner-analyze dispatch point that, when `skipBackendCalls` is true, throws a typed error naming the analysis type and that BE compute is required. The CLI catches and renders this as a non-zero exit with a one-line message; no partial output.

6. **Output labelling.** Param-pack output must carry `be_skipped: true` in pack metadata when the flag was used. Otherwise downstream consumers cannot tell whether `p.mean = 0.42` is BE-authoritative (CF) or FE-topo provisional. One field; non-trivially important. Place alongside any existing run-mode metadata in the pack header.

7. **Session log entry.** When `--no-be` is set, emit a single `info`-level `sessionLogService` entry naming the command, scenarios affected, and the reason (`be_disabled_by_flag`). The durable record explains why a run produced provisional values; complements the metadata flag.

8. **BE-internal CF (out of scope, documented).** The funnel runner (interface I17 in [FORECAST_STACK_DATA_FLOW.md](../codebase/FORECAST_STACK_DATA_FLOW.md)) makes its own whole-graph CF call from `funnel_engine.py`. Under `--no-be` the funnel runner is unreachable anyway (item 5 fails the dispatch fast), so this limitation does not surface for `--no-be`. It would surface only if a future flag tried to allow `/api/runner/analyze` while suppressing CF inside it; that is not Stage 6's scope.

9. **Re-run the focused suites with the flag.** With `--no-be` available, re-run [abBcSmoothLag.paramPack.amplitude.e2e.test.ts](../../graph-editor/src/services/__tests__/abBcSmoothLag.paramPack.amplitude.e2e.test.ts) and the 73b §5 Group 3 outside-in cases under the flag. If the failing scalars come into tolerance with `--no-be` set, the divergence is in BE arithmetic (most likely CF); if they don't, the divergence is upstream of BE. Record the result in [73b-final-outstanding.md](73b-final-outstanding.md) §3.7 / §5 as a triage hint.

This stage is a tightly scoped diagnostic affordance. It does not change BE semantics, does not move any code from FE to BE, and does not introduce a new caller class. It is one option on existing services, two CLI flag wirings, and a guard at the runner-analyze dispatch site.

#### Stage 7 — cache sanity and test cleanup

Purpose: avoid stale results introduced by the boundary change.

1. **Blind cache/test decision first.** For each path changed in Stages 1–5, check whether current cache identity already covers the changed output-affecting inputs. Add a cache-key test only when the stage changes or newly depends on an input not currently represented.
2. Current cache identity already includes graph signature (`p.mean` + topology/case weights), effective DSL, `visibility_mode`, display settings, scenario ids, analysis type, cohort-maturity cache version, and test fixture URL state. It does **not** currently include candidate regimes, MECE dimensions, diagnostics flag in multi-scenario requests, or graph fields not represented by `p.mean`. Treat these as correctness risks only if a touched stage makes one of them output-affecting for a cached path.
3. Fix only correctness misses discovered by those changes; do not redesign cache granularity or lifetime.
4. Convert CLI tests that are intended to protect CLI behaviour but currently POST directly to the BE.
5. Re-run the focused TS suites plus the 73b §5 outside-in Python suite. Numerical movement in 73b §5 Groups 2/3 is not expected from transport cleanup; if it occurs, stop and investigate.

#### Stage 8 — document the final system contract

Purpose: make the post-cleanup behaviour durable outside this proposal.

1. Update the canonical codebase forecast-flow documentation after the implementation is complete. At minimum, revise [FORECAST_STACK_DATA_FLOW.md](../codebase/FORECAST_STACK_DATA_FLOW.md) so it describes the final materialisation sequence, prepared analysis transport envelope, endpoint dispatch split (`/api/runner/analyze` vs `/api/forecast/conditioned`), and the distinction between read-only CF dispatch, graph-mutating CF enrichment, CLI param-pack production, and Bayes-run commissioning.
2. Update CLI / graph-ops docs where behaviour changed. At minimum, revise the CLI analysis and param-pack references so they state that `cli analyse` and the browser share the prepared-analysis path, while `cli param-pack` shares the graph-population/extraction path rather than analysis dispatch. Document the `--no-be` flag's contract (Stage 6) — when it suppresses cleanly vs when it surfaces a fail-fast non-zero exit.
3. Update service-directory or invariant docs if ownership changed. The documentation should name the owner of scenario materialisation, request transport cloning/engorgement, TypeScript-vs-Python visibility projection, and request-only Bayes runtime fields.
4. Remove or rewrite any stale project docs that still describe request-side materialisation as the intended design. If a project note is retained as historical context, mark that explicitly.
5. Documentation is the final stage because it should describe what actually shipped, not what the proposal hoped would ship. Do not complete Stage 8 until Stages 1–7 are implemented and the final tests have confirmed the boundary behaviour.

### 8.4 Things this proposal explicitly does not do

- **It does not collapse all scenario source policies into one UI mode.** Live, custom, and fixed remain useful user concepts. The consolidation is below that layer: once materialised, all scenarios share one graph contract. A future fourth mode — 'static', for frozen-snapshot semantics that preserve captured numbers across replay — is acknowledged separately in TODO.md.
- **It does not fold graph-mutating CF enrichment into read-only analysis dispatch.** Enrichment is part of the fetch pipeline and writes back through `UpdateManager`; read-only CF analysis returns endpoint results. They share transport construction, not lifecycle.
- **It does not require a single backend endpoint.** `/api/runner/analyze` and `/api/forecast/conditioned` can remain separate. The simplification is one prepared scenario transport shape and one caller-side dispatch surface.
- **It does not retire the legacy scalar-runner visibility adapter immediately.** That adapter is retained as a contained compatibility layer until the scalar runners read layered graph fields directly.
- **It does not optimise CF scenario bundling.** The CF endpoint already accepts `scenarios[]`, and the cleaned-up transport should preserve that shape, but bundling multiple graph-mutating CF materialisation calls is an optimisation, not a core cleanup requirement. Current-only query edits can remain single-scenario; bulk view restore / refresh-all style events can be considered later.
- **It does not redesign caching.** Obvious cache correctness regressions must be avoided, but cache granularity, lifetime, and multi-scenario batching strategy belong in a later optimisation phase.
- **It does not retire `parity-test`** — already done (deleted 28-Apr-26).
- **It does not provide a frozen-snapshot mode for static scenarios.** Graph-bearing custom recipes are materialised on replay; captured current-answer scalars are overwritten by re-derivation against current parameter files. Uniform materialisation is preferred over preservation; if frozen numbers are needed in future, that is a separate feature scoped separately.

### 8.5 Acceptance criteria

1. Scenario materialisation for current, live scenarios, custom recipes, fixed recipes, and CLI scenarios has one documented sequence for DSL resolution, overlay composition, file-backed projection, FE topo, and optional CF enrichment.
2. In-schema Bayesian projection (`p.posterior.*`, `p.latency.posterior.*`, `model_vars[bayesian]`, promotion to `p.forecast.*`) happens during materialisation for every caller. Request-side projection during transport is removed; the materialisation pipeline is the single owner of in-schema projection.
3. Request transport clones and engorges without mutating the caller's graph. A custom/f+e/scenario.graph guard test proves `_posteriorSlices`, `_bayes_evidence`, and `_bayes_priors` do not leak back to the input graph.
4. `visibility_mode` handling is audited and output-safe. If TS-side projection is removed or narrowed, scalar-runner output parity is protected by targeted tests.
5. CLI `analyse --type conditioned_forecast` and `analyse --type cohort_maturity` both go through the prepared-analysis dispatch surface. There is no direct CF fetch branch in `cli/commands/analyse.ts`.
6. CF payloads include `display_settings` from the prepared analysis state, so `axis_tau_max` and other compute-affecting display settings resolve identically across FE and CLI.
7. Scenario storage and chart/share replay paths are audited before removing any fallback projection they currently rely on. Existing canvas custom/fixed-mode tabs and chart files continue to render unchanged.
8. Obvious cache correctness regressions are ruled out; performance cache redesign remains out of scope.
9. The 73b §5 outside-in suite is run again after the cleanup lands. 73b §5 Group 2 and Group 3 numerical signatures are not expected to move; if they do, the transport cleanup has exposed or altered engine semantics and must be investigated before closure.
10. The post-cleanup materialisation, analysis transport, CF dispatch, param-pack, and Bayes commissioning contracts are documented in canonical codebase / CLI docs. The docs distinguish shipped behaviour from historical project notes.

### 8.6 Suggested sequencing

1. **Stage 1 first.** Fix custom `scenario.graph` transport isolation without changing semantics.
2. **Stage 2 second.** Route read-only CF through prepared dispatch, delete the CLI CF fork, and forward display settings.
3. **Stage 3 third.** Close 73b §3.1 by making live/current DSL re-contexting update the full in-schema Bayesian surface, including `model_vars[bayesian]` and promotion.
4. **Stage 4 fourth.** Remove TS-side visibility projection (`applyProbabilityVisibilityModeToGraph` call sites at `CompositionService.ts:423` and `analysisComputePreparationService.ts:457`); Python `_prepare_scenarios` becomes the sole projector. Preserve scalar-runner output parity.
5. **Stage 5 fifth.** Extract FE topo invocation into a standalone helper, wire the four laggard callers (custom params, graph-bearing custom, fixed, CLI standard) into the unified materialisation path, and add the session-log + not-materialised marker contract for failure cases. Preserve the share/chart restore contract.
6. **Stage 6 sixth.** Add CLI `--no-be` flag for simulating "no BE available". Single inhibition point in `fetchDataService.fetchItems`; runner-analyze fail-fast guard for analyses that require BE compute. Diagnostic affordance for distinguishing BE vs FE divergence.
7. **Stage 7 seventh.** Check cache sanity, clean up CLI tests that bypass the public command path, then re-run the focused TS suites and the 73b §5 outside-in Python suite.
8. **Stage 8 eighth.** Update canonical codebase and CLI docs to reflect the shipped contracts and remove stale descriptions of the old request-prep materialisation behaviour. Includes documenting the `--no-be` flag's contract.
9. **Optimisation phases later.** Evaluate CF multi-scenario bundling for bulk materialisation events after the core contract is stable. Evaluate cache granularity / cache-lifetime improvements separately.

### 8.7 What this proposal closes or leaves open

- **73b §7.1 is closed** by routing read-only CF through prepared dispatch with display settings.
- **73b §3.2 is closed** by clone/strip/engorge transport isolation.
- **73b §3.1 is pulled into scope** because the materialisation contract must own `model_vars[bayesian]` and promotion.
- **73b §3.4 is partially closed** by making the CLI command path the canonical seam; the test conversions remain an explicit implementation step.
- **73b §3.3 is unchanged** except that future parity tests should distinguish materialisation parity from transport/engorgement parity.
- **Stage 0 consumer review is complete**; remaining risks are represented in Stages 1–7.
- **The FE topo location question is closed**: FE topo runs in every materialisation path, extracted into a standalone helper callable from any materialisation site (Stage 5 item 7). The static-scenario preservation question is explicitly out of scope (§8.4).
- **The visibility projection question is closed**: §8.2.3 audit found Python `_prepare_scenarios` is the canonical owner. Stage 4 removes TS-side projection (`applyProbabilityVisibilityModeToGraph` call sites) without changing scalar-runner output.
- **The "no BE available" diagnostic affordance is in scope**: Stage 6 adds `--no-be` to CLI `param-pack` and `analyse`, suppressing every BE call in the run and surfacing a clean fail-fast for analysis types that require BE compute. Mirrors the existing offline / BE-unreachable end state but on demand.
- **The documentation-closeout question is explicit**: Stage 8 updates canonical codebase and CLI docs after the shipped behaviour is known, so this proposal does not remain the only source of truth.
- **CF scenario bundling and cache performance tuning remain open optimisations**, explicitly separate from this cleanup's core correctness work.

End of proposal.

## Implementation progress

<!-- managed by /implement-carefully — edit checkboxes manually only when the skill is not running -->

- [x] Stage 0 — completed (consumer contract review, recorded in §8.3 body before this block existed)
- [x] Stage 1 — completed 28-Apr-26
- [x] Stage 2 — completed 28-Apr-26
- [x] Stage 3 — completed 28-Apr-26
- [ ] Stage 4
- [ ] Stage 5
- [ ] Stage 6 (`--no-be` CLI flag — added 28-Apr-26)
- [ ] Stage 7
- [ ] Stage 8
