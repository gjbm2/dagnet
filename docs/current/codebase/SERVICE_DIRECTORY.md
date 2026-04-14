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
| FE/BE stats parity | `forecastingParityService.ts`, `beTopoPassService.ts` | `forecastingParity.*.test.ts` |
| Bayes patch apply + cascade | `bayesPatchService.ts` | `bayesPatchServiceMerge.integration.test.ts`, `cliApplyPatch.test.ts` |
| Bayes reconnect + automation submit | `bayesReconnectService.ts` | (no dedicated test yet) |
| Daily fetch / runBayes flags | `dailyFetchService.ts` | `dailyFetchService.test.ts` |

## Backend Services (`api/`)

| Need to... | Service | Key test file(s) |
|------------|---------|-------------------|
| Snapshot regime selection | `snapshot_regime_selection.py`, FE: `candidateRegimeService.ts` | `test_snapshot_regime_selection.py`, `test_regime_consumer_integration.py` |
| BE subject resolution (doc 31) | `analysis_subject_resolution.py`, `graph_select.py` | `test_analysis_subject_resolution.py`, `test_doc31_parity.py`, CLI `parity-test.sh` |
| LOO-ELPD model adequacy | `bayes/compiler/loo.py`, FE: `bayesQualityTier.ts` | `test_loo.py` |
| PPC calibration | `bayes/compiler/calibration.py` | (validated via `--diag` on synth graphs) |

## CLI (`graph-editor/src/cli/`)

| Need to... | Service | Key test file(s) |
|------------|---------|-------------------|
| CLI disk loader | `src/cli/diskLoader.ts` | (smoke-tested manually) |
| CLI aggregation + LAG | `src/cli/aggregate.ts` | (smoke-tested manually) |
| CLI bootstrap (shared) | `src/cli/bootstrap.ts` | (smoke-tested manually) |
