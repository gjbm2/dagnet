# Service Directory

Quick-lookup table: what you need to do → which service owns it → where the tests live.

## Frontend Services (`graph-editor/src/services/`)

| Need to... | Service | Key test file(s) |
|------------|---------|-------------------|
| Git pull/push/commit/clone | `repositoryOperationsService.ts` | `gitService.integration.test.ts` |
| File CRUD (create/open/delete) | `fileOperationsService.ts` | `fileOperations.integration.test.ts` |
| Graph mutations (edges, nodes, probs) | `UpdateManager.ts` | `UpdateManager.test.ts`, `UpdateManager.graphToGraph.test.ts` |
| Topology change → query regen | `graphMutationService.ts` | `graphMutationService.*.test.ts` |
| Fetch data from external sources | `fetchDataService.ts` | `fetchDataService.test.ts` |
| Retrieve-all slices (batch fetch) | `retrieveAllSlicesService.ts` | `retrieveAllSlicesService.test.ts` |
| Data sync (file ↔ graph ↔ external) | `dataOperationsService.ts` | `dataOperationsService.*.test.ts` (12 files) |
| Scenario composition/rendering | `CompositionService.ts`, `ScenarioRenderer.ts` | `CompositionService.test.ts` |
| Chart compute/refresh/hydrate | `chartRecomputeService.ts`, `chartHydrationService.ts` | `chartDisplayPlanningService.test.ts` |
| Canvas analysis create/mutate | `canvasAnalysisCreationService.ts`, `canvasAnalysisMutationService.ts` | `canvasAnalysisCrud.integration.test.ts` |
| Workspace load/clone/restore | `workspaceService.ts` | `workspaceService.integration.test.ts` |
| IDB direct access | `db/appDatabase.ts` | (used by all integration tests) |
| Index rebuild | `indexRebuildService.ts` | `indexRebuild.critical.test.ts` |
| 3-way merge | `mergeService.ts` | `mergeService.test.ts` |
| Session logging | `sessionLogService.ts` | `sessionLogService.test.ts` |
| Hash/signature computation | `coreHashService.ts`, `signatureMatchingService.ts` | `coreHashService.test.ts`, `signatureMatchingService.test.ts` |
| Schema validation | `lib/schema.ts` | `schemaParityAutomated.test.ts` |
| Non-blocking pull | `nonBlockingPullService.ts` | `nonBlockingPullService.test.ts` |
| Automation runs | `dailyRetrieveAllAutomationService.ts` | `dailyRetrieveAllAutomationService.test.ts` |
| Integrity checks | `integrityCheckService.ts` | `integrityCheckService.*.test.ts` (7 files) |
| Stage-2 fetch enrichment | `fetchDataService.ts`, `lagHorizonsService.ts` | `conditionedForecastCompleteness.test.ts`, `windowCohortSemantics.paramPack.e2e.test.ts`, `headlessRetrieveAllParity.integration.test.ts` |
| Scenario materialisation (compose → project → FE topo) | `analysisComputePreparationService.ts` (`runScenarioMaterialisation`), `feTopoMaterialisationService.ts` (FE topo helper) | `analysisPrepStage5.integration.test.ts`, `analysisPrepRecontext.integration.test.ts`, `cliAnalysisPrepEngorgement.test.ts` |
| Request-graph cloning + engorgement | `lib/bayesGraphRuntime.ts` (`cloneGraphWithoutBayesRuntimeFields`), `lib/bayesEngorge.ts` | `analysisPrepRecontext.integration.test.ts` |
| Visibility-mode projection (TS-side helper, BE-side canonical) | TS: `CompositionService.applyProbabilityVisibilityModeToGraph` (compatibility-only, not on the prep path post-73e Stage 4); BE: `lib/runner/runners.py::_prepare_scenarios` → `lib/runner/graph_builder.py::apply_visibility_mode` | `CompositionService.probabilityVisibilityMode.strictEvidence.test.ts`, `test_conversion_funnel_v2.py`, `test_funnel_contract.py`, `test_lag_fields.py` |
| Bayes patch apply + cascade | `bayesPatchService.ts` | `bayesPatchServiceMerge.integration.test.ts`, `cliApplyPatch.test.ts` |
| Bayes reconnect + automation submit | `bayesReconnectService.ts` | (no dedicated test yet) |
| Daily fetch / runBayes flags | `dailyFetchService.ts` | `dailyFetchService.test.ts` |
| Integrity check (10-phase) | `integrityCheckService.ts` (4,177 LOC) | `integrityCheckService.*.test.ts` (7 files) — see [INTEGRITY_CHECK_SERVICE.md](INTEGRITY_CHECK_SERVICE.md) |
| FE↔Python compute boundary | `lib/graphComputeClient.ts` (2,478 LOC) | `graphComputeClient.test.ts` — see [GRAPH_COMPUTE_CLIENT.md](GRAPH_COMPUTE_CLIENT.md) |
| Chart rendering (ECharts) | `analysisECharts/` cluster (5,187 LOC) | `analysisEChartsService.*.test.ts` — see [ANALYSIS_ECHARTS_BUILDERS.md](ANALYSIS_ECHARTS_BUILDERS.md) |
| Display settings registry | `lib/analysisDisplaySettingsRegistry.ts` (1,530 LOC) | `analysisDisplaySettingsRegistry.test.ts` |

## Backend Services (`api/`)

For the full BE runner cluster umbrella, see [BE_RUNNER_CLUSTER.md](BE_RUNNER_CLUSTER.md).

| Need to... | Service | Key test file(s) |
|------------|---------|-------------------|
| Snapshot regime selection | `snapshot_regime_selection.py`, FE: `candidateRegimeService.ts` | `test_snapshot_regime_selection.py`, `test_regime_consumer_integration.py` |
| BE subject resolution (doc 31) | `analysis_subject_resolution.py`, `graph_select.py` | `test_analysis_subject_resolution.py`, `test_doc31_parity.py` |
| Analysis dispatch | `lib/api_handlers.py` (5,275 LOC) | (covered by per-handler tests) |
| Analysis runners | `runner/runners.py` (2,139 LOC) | `test_v2_v3_parity.py`, etc. |
| Forecast engine (doc 29) | `runner/forecast_state.py`, `runner/forecast_runtime.py`, `runner/model_resolver.py` | `test_v2_v3_parity.py`, `test_forecast_state_cohort.py`, CLI `v2-v3-parity-test.sh`, `chart-graph-agreement-test.sh` |
| Cohort maturity v3 | `runner/cohort_forecast_v3.py` | `test_v2_v3_parity.py`, CLI `v2-v3-parity-test.sh` |
| Span kernel (multi-hop) | `runner/span_kernel.py`, `runner/span_evidence.py`, `runner/span_upstream.py` | (exercised via cohort_maturity tests) |
| Per-analysis derivations | `runner/cohort_maturity_derivation.py`, `runner/daily_conversions_derivation.py`, `runner/lag_fit_derivation.py`, `runner/conversion_rate_derivation.py`, `runner/histogram_derivation.py` | per-derivation tests in `lib/tests/` |
| LOO-ELPD model adequacy | `bayes/compiler/loo.py`, FE: `bayesQualityTier.ts` | `test_loo.py` |
| PPC calibration | `bayes/compiler/calibration.py` | (validated via `--diag` on synth graphs) |

## CLI (`graph-editor/src/cli/`)

| Need to... | Service | Key test file(s) |
|------------|---------|-------------------|
| CLI disk loader | `src/cli/diskLoader.ts` | (smoke-tested manually) |
| CLI aggregation + LAG | `src/cli/aggregate.ts` | (smoke-tested manually) |
| CLI bootstrap (shared) | `src/cli/bootstrap.ts` | (smoke-tested manually) |
