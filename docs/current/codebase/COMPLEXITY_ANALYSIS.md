# DagNet Application Complexity Analysis

**Date**: 27-Apr-26
**Purpose**: Identify and document the most complex aspects of the DagNet application

---

## Executive Summary

DagNet is a graph-based data analysis platform. Its complexity stems from:

1. **Multi-layered state synchronisation** across IndexedDB, in-memory registries, Zustand stores, ReactFlow, and GitHub.
2. **Path-probability and MSMDC graph algorithms** with state-space expansion and inclusion-exclusion query optimisation.
3. **A fetch / cache / merge pipeline** spread across a cluster of specialised services that plan, execute, and reconcile time-series and cohort data from external providers.
4. **Conditioned and cohort forecasting** that fit lag-distribution models, derive maturity, and generate epistemic/confidence bands.
5. **A Bayesian compiler and regression harness** with synthetic builders, JAX-based inference, and prior-sensitivity tooling.
6. **A snapshot-DB layer** that captures per-regime, per-slice retrievals as durable, signature-keyed artefacts.
7. **A hash-chain and signature-matching cluster** that links queries, plans, retrievals, and snapshots so cache hits can be proven across editor sessions.
8. **A DSL** with compound operators, query explosion, and inclusion-exclusion combination.
9. **A statistical-enhancement subsystem** doing lag-distribution fitting, path-T95 computation, and recency weighting.
10. **An analysis-ECharts pipeline** that hydrates, recomputes, and renders multiple chart families (cohort comparison, funnel, snapshots, surprise gauge, bridge).

**Overall complexity**: 🔴 **Very High** — domain knowledge (graph theory, statistics, Bayesian inference, time-series merging) required across most subsystems.

---

## 1. State Management & Synchronisation

### Complexity Level: 🔴 **Extremely High**

**Key files**:
- [`src/contexts/TabContext.tsx`](graph-editor/src/contexts/TabContext.tsx) — 3,147 LOC
- [`src/components/GraphCanvas.tsx`](graph-editor/src/components/GraphCanvas.tsx) — 2,895 LOC
- [`src/components/editors/GraphEditor.tsx`](graph-editor/src/components/editors/GraphEditor.tsx) — 2,647 LOC
- [`src/contexts/GraphStoreContext.tsx`](graph-editor/src/contexts/GraphStoreContext.tsx) — 725 LOC
- [`src/contexts/ScenariosContext.tsx`](graph-editor/src/contexts/ScenariosContext.tsx) — 1,935 LOC

### The challenge

Multiple sources of truth must stay synchronised:

1. **IndexedDB** (`db.files`) — durable source of truth for file content, dirty state, git SHAs, workspace state.
2. **FileRegistry** — in-memory cache layered over IndexedDB.
3. **GraphStore** (Zustand) — per-file graph state shared across tabs.
4. **ReactFlow state** — transformed presentation state.
5. **GitHub** — remote source of truth.
6. **What-If / Scenarios** — dual state (in-memory plus IndexedDB-persisted), with scenarios now seeded from graph JSON and round-tripped on commit.

### Complex synchronisation patterns

#### A. Bidirectional sync with loop prevention

GraphEditor uses an `isSyncingRef` guard so FileState↔GraphStore updates do not feed each other. Each direction sets the ref before propagating and clears it on a microtask, accepting the small risk of a race in exchange for breaking the feedback loop.

#### B. Per-file stores shared across tabs

Multiple tabs viewing the same file share one GraphStore instance. Undo/redo in one tab affects all tabs viewing the file. History stacks are per-tab; current state is shared. Requires careful coordination on commit/discard.

#### C. Editor-type history independence

- Graph editor — GraphStore history (shared per-file).
- Form editor — local `historyRef` (per-tab).
- Monaco editor — Monaco's internal stack (per-tab).

Switching editors does **not** merge history stacks.

### Why it's complex

1. **Race conditions** across tabs and between layers.
2. **Feedback loops** in bidirectional sync.
3. **Consistency** across IndexedDB, in-memory caches, and remote.
4. **Performance** — sync must be fast enough to not stall typing.
5. **Undo/redo** spanning multiple editors and tabs.

For full architecture see [`docs/current/codebase/SYNC_SYSTEM_OVERVIEW.md`](docs/current/codebase/SYNC_SYSTEM_OVERVIEW.md).

---

## 2. UpdateManager (Mapping Engine)

### Complexity Level: 🔴 **Very High**

**Key files**:
- [`src/services/UpdateManager.ts`](graph-editor/src/services/UpdateManager.ts) — 3,713 LOC
- [`src/services/updateManager/`](graph-editor/src/services/updateManager/) — `auditLog`, `mappingConfigurations`, `mappingEngine`, `nestedValueAccess`, `roundingUtils`, `types`

### The challenge

Centralised service for **all data transformations** between domains:

1. **5 direction handlers**: `graph_internal`, `graph_to_file`, `file_to_graph`, `external_to_graph`, `external_to_file`.
2. **4 operation types**: `CREATE`, `UPDATE`, `APPEND`, `DELETE`.
3. **18+ mapping configurations**: parameter (`p`, `cost_gbp`, `labour_cost`), node (label, description, metadata), case (schedules, variants), context, event.

### Complex features

- **Override-flag handling** — `field_overridden` markers prevent overwriting user edits unless `ignoreOverrideFlags` is set.
- **Conflict resolution** — strategies are `skip`, `overwrite`, `prompt`, `error`; both batch and interactive modes are supported.
- **Field transformations** — date normalisation (UK format), DSL normalisation, ID generation, array merging.
- **Audit trail** — every change is logged for debugging and rollback.

### Why it's complex

1. **Combinatorial surface**: 5 directions × 4 operations × ~18 mappings.
2. **Override semantics**: when to respect vs ignore.
3. **Conflict strategies** with interactive prompts.
4. **Transform chains**: values may be transformed multiple times in one pipeline.

---

## 3. Data Fetch & Cache Pipeline

### Complexity Level: 🔴 **Very High**

The old monolithic `dataOperationsService.ts` (~9k LOC) has been split into a cluster:

**Thin orchestrator** (entry point):
- [`src/services/dataOperationsService.ts`](graph-editor/src/services/dataOperationsService.ts) — 713 LOC

**Decomposed helpers** under [`src/services/dataOperations/`](graph-editor/src/services/dataOperations/):
- `applyChanges`, `asatQuerySupport`, `batchMode`, `cacheManagement`, `evidenceForecastScalars`, `fileToGraphSync`, `getFromSourceDirect`, `graphToFileSync`, `logHelpers`, `querySignature`, `types`.

**Fetch orchestration cluster** (planning, policy, execution):
- [`fetchOrchestratorService.ts`](graph-editor/src/services/fetchOrchestratorService.ts), [`fetchPlanBuilderService.ts`](graph-editor/src/services/fetchPlanBuilderService.ts), `fetchPlanTypes.ts`, `fetchRefetchPolicy.ts`, `fetchTargetEnumerationService.ts`.
- [`fetchDataService.ts`](graph-editor/src/services/fetchDataService.ts) — 3,169 LOC (provider-side execution, query DSL → provider call).
- [`windowFetchPlannerService.ts`](graph-editor/src/services/windowFetchPlannerService.ts), [`retrieveAllSlicesPlannerService.ts`](graph-editor/src/services/retrieveAllSlicesPlannerService.ts), [`retrieveAllSlicesService.ts`](graph-editor/src/services/retrieveAllSlicesService.ts).

**Daily automation**:
- [`dailyAutomationJob.ts`](graph-editor/src/services/dailyAutomationJob.ts), [`dailyFetchService.ts`](graph-editor/src/services/dailyFetchService.ts), [`dailyRetrieveAllAutomationService.ts`](graph-editor/src/services/dailyRetrieveAllAutomationService.ts), [`stalenessNudgeService.ts`](graph-editor/src/services/stalenessNudgeService.ts), `stalenessNudgeJobs.ts`.

### Complex algorithms

- **Incremental fetch planning** — calculate which days require fetch given existing cache coverage, latency-based maturity thresholds, and refetch policy (`stale-while-revalidate`, etc.).
- **Time-series merge** — aggregate `n` and `k`, derive lag/latency statistics, compute onset delta from lag histograms, apply recency weighting, enforce completeness constraints, reconcile window vs cohort semantics.
- **Cache analysis** — identify gaps in cached time-series, group contiguous regions, apply maturity thresholds.
- **Query signature matching** — see §10.

### Provider abstraction

- **Amplitude** (live + staging) — event-based queries.
- **Sheets** — HRN-based queries.
- **Sheets context fallback** — when Amplitude lacks a context dimension.

### Why it's complex

1. **Many execution paths**: window vs cohort modes, multiple providers, multiple cache states.
2. **Statistical reconciliation** during merge.
3. **State coordination** with UpdateManager, FileRegistry, GraphStore, snapshot DB.
4. **Error handling**: rate limits, partial failures, retries.
5. **Performance**: incremental fetches, batching, cache hits.

---

## 4. Graph Algorithms & Path Calculations

### Complexity Level: 🔴 **Very High**

**Key files**:
- [`graph-editor/lib/runner/path_runner.py`](graph-editor/lib/runner/path_runner.py) — 836 LOC (Python)
- [`graph-editor/lib/msmdc.py`](graph-editor/lib/msmdc.py) — 1,196 LOC (Python)
- [`graph-editor/src/lib/runner.ts`](graph-editor/src/lib/runner.ts) — 504 LOC (TypeScript)
- [`graph-editor/src/lib/graphPruning.ts`](graph-editor/src/lib/graphPruning.ts) — 263 LOC

### The challenge

Calculate **path probabilities** through directed graphs with:

1. **Conditional probabilities** — edges with `conditional_p` that depend on visited nodes.
2. **Multiple paths** from start to end.
3. **Cost calculations** — expected monetary and labour costs.
4. **Query-driven pruning** based on DSL constraints.

### Complex algorithms

- **State-space expansion** — when `conditional_p` is in play, the state is `(node, visited_tracked_human_ids_subset)` and the state space grows exponentially with the number of tracked nodes.
- **MSMDC query generation** — finds a minimal set of queries to retrieve all relevant paths using inclusion-exclusion (set cover, NP-hard in general).
- **Path T95** — cumulative latency along paths via topological DP: `path_t95(edge) = max(path_t95(incoming)) + edge.t95`. Handles cycles and multiple paths.

### Why it's complex

1. **Graph theory** — DAGs, topological sorting, path enumeration, cycle handling.
2. **Conditional logic** — state-space explosion.
3. **NP-hard sub-problems** in query optimisation.
4. **Performance** at large graphs.
5. **Mathematical correctness** of probability outputs.

---

## 5. DSL Parsing & Query Construction

### Complexity Level: 🟡 **High**

**Key files**:
- [`graph-editor/src/lib/queryDSL.ts`](graph-editor/src/lib/queryDSL.ts) — 979 LOC
- [`graph-editor/src/lib/dslExplosion.ts`](graph-editor/src/lib/dslExplosion.ts) — 348 LOC
- [`graph-editor/src/lib/das/compositeQueryExecutor.ts`](graph-editor/src/lib/das/compositeQueryExecutor.ts) — 390 LOC
- [`graph-editor/lib/query_dsl.py`](graph-editor/lib/query_dsl.py)

For terminology see [`docs/current/codebase/RESERVED_QUERY_TERMS_GLOSSARY.md`](docs/current/codebase/RESERVED_QUERY_TERMS_GLOSSARY.md).

### The challenge

Parse and execute the **domain-specific query language**:

1. **Atomic expressions** — `visited(a,b)`, `exclude(c)`, `context(key:value)`.
2. **Compound operators** — `;` (semicolon), `or()`, `minus()`, `plus()`.
3. **Query explosion** — expand compound expressions into atomic slices.
4. **Inclusion-exclusion** — combine sub-query results with coefficients.

### Complex features

- **Query explosion** — handles nested parentheses, prefix/suffix distribution (`(a;b).window(...)` → `[a.window(...), b.window(...)]`), Cartesian product expansion of bare keys.
- **Composite query execution** — combines `base − minus₁ − minus₂ + plus₁` with weighted coefficients, including time-series combination and edge-case handling.
- **Slice isolation** — keeps cohort/window slice keys distinct so signatures and caches do not collide.

### Why it's complex

1. **Parsing** of nested expressions and operator precedence.
2. **Explosion** can yield thousands of slices.
3. **Set-cover optimisation** is NP-hard.
4. **Mathematical correctness** of inclusion-exclusion combination.
5. **Cache consistency** across equivalent expressions.

---

## 6. Statistical Enhancement & Lag Fitting

### Complexity Level: 🔴 **Very High**

**Key files**:
- [`src/services/statisticalEnhancementService.ts`](graph-editor/src/services/statisticalEnhancementService.ts) — 3,836 LOC
- [`src/services/lagDistributionUtils.ts`](graph-editor/src/services/lagDistributionUtils.ts), [`lagFitAnalysisService.ts`](graph-editor/src/services/lagFitAnalysisService.ts), [`lagHorizonsService.ts`](graph-editor/src/services/lagHorizonsService.ts), [`lagMixtureAggregationService.ts`](graph-editor/src/services/lagMixtureAggregationService.ts).
- Python: [`graph-editor/lib/runner/lag_distribution_utils.py`](graph-editor/lib/runner/lag_distribution_utils.py), [`lag_fit_derivation.py`](graph-editor/lib/runner/lag_fit_derivation.py), [`lag_model_fitter.py`](graph-editor/lib/runner/lag_model_fitter.py).
- [`graph-editor/lib/stats_enhancement.py`](graph-editor/lib/stats_enhancement.py).

### The challenge

Apply statistical methods to enhance evidence and projections:

1. **Lag distribution fitting** — log-normal (or mixture) fits to latency histograms; MLE parameter estimation; percentile recovery (median, t95).
2. **Path T95** — cumulative latency along paths via topological DP.
3. **Statistical enhancement** — Bayesian smoothing, trend detection, MCMC.
4. **Recency weighting** — exponential decay over time (`RECENCY_HALF_LIFE_DAYS`).
5. **Lag-mixture aggregation** — combining per-edge lag distributions into path-level distributions.

### Why it's complex

1. **Statistical methods** — distribution fitting, MLE, mixture models, percentile recovery.
2. **Graph algorithms** — topological sort and DP over the active edge set.
3. **Numerical stability** — floating-point precision, log-space transforms, edge cases.
4. **Performance** — must run fast enough for live recompute.

---

## 7. Cohort Forecasting & Conditioned Forecast

### Complexity Level: 🔴 **Very High**

**Key TS files**:
- [`src/services/conditionedForecastService.ts`](graph-editor/src/services/conditionedForecastService.ts), `conditionedForecastSupersessionState.ts`.
- [`src/services/cohortRetrievalHorizon.ts`](graph-editor/src/services/cohortRetrievalHorizon.ts), [`forecastingSettingsService.ts`](graph-editor/src/services/forecastingSettingsService.ts).

**Key Python runners** under [`graph-editor/lib/runner/`](graph-editor/lib/runner/):
- `cohort_forecast.py`, `cohort_forecast_v2.py`, `cohort_forecast_v3.py`.
- `cohort_maturity_derivation.py`, `forecast_state.py`, `forecast_runtime.py`, `forecast_preparation.py`, `forecast_application.py`.
- `confidence_bands.py`, `epistemic_bands.py`, `daily_conversions_derivation.py`, `histogram_derivation.py`.

### The challenge

Project conversion outcomes for cohorts that are still maturing:

1. **Maturity derivation** — for each cohort, what proportion of its lag distribution has elapsed.
2. **Lag-conditioned projection** — extrapolate observed `k`/`n` to a hypothetical fully-mature cohort.
3. **Confidence and epistemic bands** — separate aleatoric (sampling) and epistemic (model/lag) uncertainty.
4. **Supersession** — when a fresh forecast lands, prior conditioned forecasts are marked superseded but kept for diagnostics.
5. **Settings governance** — `forecastingSettingsService` controls policy (lag model choice, recency, horizon).

### Why it's complex

1. **Composes** the lag-fitting pipeline (§6), cohort retrieval, the snapshot DB (§8), and statistical enhancement.
2. **Multiple algorithm versions** (`v2`, `v3`) coexist for back-comparison.
3. **Numerical care** — small samples, partial windows, censored cohorts.
4. **State**: supersession requires durable identifiers and dependency tracking.

---

## 8. Snapshot Database

### Complexity Level: 🟡 **High**

**Key TS services**:
- [`graphSnapshotService.ts`](graph-editor/src/services/graphSnapshotService.ts), [`snapshotDependencyPlanService.ts`](graph-editor/src/services/snapshotDependencyPlanService.ts), [`snapshotManagerContextService.ts`](graph-editor/src/services/snapshotManagerContextService.ts), [`snapshotRetrievalsService.ts`](graph-editor/src/services/snapshotRetrievalsService.ts), [`snapshotSubjectResolutionService.ts`](graph-editor/src/services/snapshotSubjectResolutionService.ts), [`snapshotWriteService.ts`](graph-editor/src/services/snapshotWriteService.ts).

**Python**:
- [`graph-editor/lib/snapshot_service.py`](graph-editor/lib/snapshot_service.py), [`graph-editor/lib/snapshot_regime_selection.py`](graph-editor/lib/snapshot_regime_selection.py), [`graph-editor/lib/slice_key_normalisation.py`](graph-editor/lib/slice_key_normalisation.py).

### The challenge

Persist per-regime, per-slice retrievals as durable, signature-keyed artefacts so that forecasts and analyses can be reproduced and superseded coherently. Snapshots:

1. **Subject resolution** — map a query/regime/slice tuple to a canonical subject identity.
2. **Dependency planning** — given a chart or forecast, plan the set of snapshots it depends on.
3. **Regime selection** — pick the right candidate regime for a given subject when generalisation is in play.
4. **Write coordination** — snapshots are written transactionally with their dependency graph.

### Why it's complex

1. **Identity discipline** — slice-key normalisation must be exact for cache reuse.
2. **Dependency graphs** — many-to-many between snapshots, charts, forecasts.
3. **Generalisation interaction** — see §12.

---

## 9. Bayes Compiler & Regression Infrastructure

### Complexity Level: 🔴 **Very High**

**Tree**: [`bayes/`](bayes/)

- **Compiler**: [`bayes/compiler/`](bayes/compiler/) — graph → JAX model.
- **App**: [`bayes/app.py`](bayes/app.py) — service layer.
- **Regression / harness**: [`run_regression.py`](bayes/run_regression.py), [`regression_plans.py`](bayes/regression_plans.py), [`param_recovery.py`](bayes/param_recovery.py), [`prior_sensitivity.py`](bayes/prior_sensitivity.py), [`recovery_slices.py`](bayes/recovery_slices.py), [`softplus_sweep.py`](bayes/softplus_sweep.py), [`convergence_matrix.py`](bayes/convergence_matrix.py).
- **Diagnostics**: `diag_jax_nan*.py`, `diag_phase_a.py`, `diag_phase_b.py`, `diag_run.py`.
- **Migration / fixtures**: [`migrate_truth_files.py`](bayes/migrate_truth_files.py), [`fixtures/`](bayes/fixtures/), [`baselines/`](bayes/baselines/).
- **Synthetic builders**: `bayes/tests/synthetic.py` — every new compiler branch must add a synthetic builder (CLAUDE.md §4).

**FE bridge services**:
- [`bayesService.ts`](graph-editor/src/services/bayesService.ts), [`bayesPatchService.ts`](graph-editor/src/services/bayesPatchService.ts), [`bayesPriorService.ts`](graph-editor/src/services/bayesPriorService.ts), [`bayesReconnectService.ts`](graph-editor/src/services/bayesReconnectService.ts).
- Local-mode harness: [`graph-editor/lib/bayes_local.py`](graph-editor/lib/bayes_local.py).

### The challenge

1. **Compile graphs to a probabilistic model** that JAX/NumPyro can sample.
2. **Recover parameters** from synthetic data to validate the compiler.
3. **Track regression** across compiler changes via a baseline/results schema.
4. **Diagnose JAX NaNs**, prior drift, and convergence pathologies.
5. **Bridge** the Python compiler to the FE: prior editing, patching, reconnection, recovery slices.

### Why it's complex

1. **Probabilistic semantics** — getting compiler branches right requires both code and synthetic-builder updates.
2. **Numerical pathologies** — JAX NaN diagnostics are a recurring class of bug.
3. **CI cost** — `run_regression.py` is gated (CLAUDE.md gate 5) because runs take minutes-to-hours.

See [`bayes/DEVTOOLS.md`](bayes/DEVTOOLS.md) and [`bayes/TESTING_PLAYBOOK.md`](bayes/TESTING_PLAYBOOK.md) for entry points.

---

## 10. Hash Chain & Signature Matching

### Complexity Level: 🟡 **High**

**Services**:
- [`hashChainService.ts`](graph-editor/src/services/hashChainService.ts), [`hashMappingsService.ts`](graph-editor/src/services/hashMappingsService.ts), [`coreHashService.ts`](graph-editor/src/services/coreHashService.ts).
- [`signatureLinksApi.ts`](graph-editor/src/services/signatureLinksApi.ts), [`signatureLinksTabService.ts`](graph-editor/src/services/signatureLinksTabService.ts), [`signatureMatchingService.ts`](graph-editor/src/services/signatureMatchingService.ts), [`signaturePolicyService.ts`](graph-editor/src/services/signaturePolicyService.ts).
- [`querySignatureService.ts`](graph-editor/src/services/querySignatureService.ts), [`plannerQuerySignatureService.ts`](graph-editor/src/services/plannerQuerySignatureService.ts), [`graphTopologySignatureService.ts`](graph-editor/src/services/graphTopologySignatureService.ts), [`graphInputSignatureService.ts`](graph-editor/src/services/graphInputSignatureService.ts).

### The challenge

Generate, link, and validate deterministic signatures across queries, plans, retrievals, and snapshots so cache hits can be **proven** rather than guessed.

1. **Normalisation** — equivalent expressions must produce identical signatures.
2. **Hash chains** — link upstream signatures (graph topology, query, plan) to downstream artefacts (retrieval, snapshot, chart).
3. **Policy** — when a signature is allowed to be reused vs must be regenerated.
4. **Signature-links UI** — surface chains for inspection.

### Why it's complex

1. **Determinism** across time zones, ordering, and serialisation forms.
2. **Cross-service dependency** — every cache-touching subsystem must agree on signature semantics.
3. **Migration** — when signature semantics change, every downstream artefact's link must be reconciled.

This subsystem subsumes the original "query signature matching" complexity domain (now spans many services rather than one helper).

---

## 11. Window Aggregation

### Complexity Level: 🟡 **High**

**Key file**: [`src/services/windowAggregationService.ts`](graph-editor/src/services/windowAggregationService.ts) — 2,574 LOC

### The challenge

Aggregate time-series data with two semantically-distinct modes:

1. **Window mode** — daily aggregation over a date range.
2. **Cohort mode** — cohort-based aggregation (cohort indexed by `from_date`).

### Complex features

- **Aggregation** — sum `n`/`k`, derive probabilities, aggregate latency statistics, handle missing data.
- **Latency stats** — median, mean, t95.
- **Signature-keyed cache** — invalidation aware of underlying data freshness.

### Why it's complex

1. **Date handling** — UK day boundaries, time zones, edge cases (the `ukDayBoundarySchedulerService` and `ukReferenceDayService` exist for a reason).
2. **Statistical aggregation** with missing data.
3. **Cache invalidation** keyed by signature.
4. **Mode semantics** differ between window and cohort.

---

## 12. Generalisation & Regime Resolution

### Complexity Level: 🟡 **High**

**Services / files**:
- [`candidateRegimeService.ts`](graph-editor/src/services/candidateRegimeService.ts), [`analysisTypeResolutionService.ts`](graph-editor/src/services/analysisTypeResolutionService.ts), [`modelVarsResolution.ts`](graph-editor/src/services/modelVarsResolution.ts).
- Python: [`graph-editor/lib/runner/model_resolver.py`](graph-editor/lib/runner/model_resolver.py), [`graph-editor/lib/snapshot_regime_selection.py`](graph-editor/lib/snapshot_regime_selection.py), [`graph-editor/lib/runner/predicates.py`](graph-editor/lib/runner/predicates.py).
- Scenario portability: scenarios are seeded from graph JSON on first open and serialised back on commit (round-trip in `ScenariosContext.tsx`).

### The challenge

A single graph can carry multiple **regimes** (parameterisations) that apply under different predicates. At resolve time the system must pick the right candidate regime for the active context.

1. **Predicate evaluation** — match the active scenario / context against regime predicates.
2. **Candidate ranking** — when multiple regimes apply, pick the most specific.
3. **Snapshot interaction** — regime selection feeds snapshot subject resolution (§8).
4. **Variable resolution** — `modelVarsResolution` and `posteriorSliceResolution` translate regime + scenario into concrete model vars.

### Why it's complex

Generalisation cuts across the graph model, scenarios, snapshots, forecasting, and Bayes. Mistakes here surface as silent miscomputation rather than crashes.

---

## 13. Analysis ECharts Pipeline

### Complexity Level: 🟡 **High**

**Builders** under [`src/services/analysisECharts/`](graph-editor/src/services/analysisECharts/):
- `bridgeBuilders`, `cohortComparisonBuilders`, `echartsCommon`, `funnelBuilders`, `snapshotBuilders`, `surpriseGaugeBuilder`.

**Surrounding services**:
- [`analysisEChartsService.ts`](graph-editor/src/services/analysisEChartsService.ts), [`chartHydrationService.ts`](graph-editor/src/services/chartHydrationService.ts), [`chartRecomputeService.ts`](graph-editor/src/services/chartRecomputeService.ts), [`chartRefreshService.ts`](graph-editor/src/services/chartRefreshService.ts), [`chartOperationsService.ts`](graph-editor/src/services/chartOperationsService.ts), [`chartDisplayPlanningService.ts`](graph-editor/src/services/chartDisplayPlanningService.ts).
- [`canvasAnalysisCreationService.ts`](graph-editor/src/services/canvasAnalysisCreationService.ts), [`canvasAnalysisMutationService.ts`](graph-editor/src/services/canvasAnalysisMutationService.ts).
- Funnel: [`amplitudeFunnelBuilderService.ts`](graph-editor/src/services/amplitudeFunnelBuilderService.ts) bridged to [`graph-editor/lib/runner/funnel_engine.py`](graph-editor/lib/runner/funnel_engine.py).

### The challenge

1. **Multiple chart families** with different data shapes (cohort comparison, funnel, snapshot, surprise gauge, bridge).
2. **Hydration** from snapshots and live retrievals.
3. **Recompute** without re-fetching when only display state changes.
4. **Display planning** — layout, axes, legend rules per family.

### Why it's complex

1. **Data shapes** vary widely; builders must be coordinated with snapshot/forecast outputs.
2. **State**: charts depend on snapshots (§8), forecasts (§7), generalisation (§12), and signatures (§10).
3. **Performance**: large cohort comparisons can blow up render time without careful display planning.

---

## 14. Workspace & Git Sync

### Complexity Level: 🟡 **High**

**Key files**:
- [`src/services/workspaceService.ts`](graph-editor/src/services/workspaceService.ts) — 2,374 LOC
- [`src/services/repositoryOperationsService.ts`](graph-editor/src/services/repositoryOperationsService.ts) — 1,487 LOC
- [`src/services/indexRebuildService.ts`](graph-editor/src/services/indexRebuildService.ts) — 557 LOC
- [`src/services/gitService.ts`](graph-editor/src/services/gitService.ts), [`graphGitService.ts`](graph-editor/src/services/graphGitService.ts).
- Live share: [`liveShareBootService.ts`](graph-editor/src/services/liveShareBootService.ts), [`liveShareHydrationService.ts`](graph-editor/src/services/liveShareHydrationService.ts), [`liveShareSyncService.ts`](graph-editor/src/services/liveShareSyncService.ts).

### The challenge

Manage workspace state across repositories:

1. **Workspace loading** — clone, load files, build registry, initialise IndexedDB.
2. **File management** — track files, dirty state, git state.
3. **Index management** — build and maintain index files (`nodes-index.yaml`, `parameters-index.yaml`, etc.).
4. **Sync** — pull/push with remote, conflict resolution.
5. **Live share** — boot/hydrate/sync shared sessions.

### Why it's complex

1. **Git operations** — clone, pull, push, commit, conflict resolution against GitHub.
2. **Multiple sources of truth** — must keep IndexedDB, FileRegistry, and remote consistent (CLAUDE.md §5: always use `db.getDirtyFiles()` for git ops).
3. **Performance** with large workspaces.
4. **Index integrity** — required by everything downstream.

---

## Complexity Metrics Summary

LOC figures as of 27-Apr-26.

### Largest individual files (top 25)

| Component | LOC | Complexity | Key challenges |
|-----------|-----|------------|----------------|
| `lib/api_handlers.py` | 5,275 | 🔴 Very High | BE dispatch monolith — snapshot vs runner routing, single 2,080-line function |
| `bayes/synth_gen.py` | 4,722 | 🔴 Very High | Synthetic data simulation, burn-in, hash injection, sparsity layer |
| `bayes/compiler/model.py` | 4,325 | 🔴 Extremely High | PyMC model construction — Phase 1/2/C, hierarchical Dirichlet, latent onset |
| `services/integrityCheckService.ts` | 4,177 | 🔴 Very High | 10-phase cross-graph validation, debounced + deep modes |
| `components/PropertiesPanel.tsx` | 4,038 | 🟡 High | Section-driven RJSF + Monaco + override flag UX, ~50 field types |
| `services/statisticalEnhancementService.ts` | 3,836 | 🔴 Extremely High | Distribution fitting, path-T95 DP, recency weighting |
| `services/UpdateManager.ts` (+ `updateManager/`) | 3,713 | 🔴 Very High | Combinatorial mappings, override logic, conflict resolution |
| `services/fetchDataService.ts` | 3,169 | 🔴 Very High | Provider abstraction, query execution, Stage 2 orchestration |
| `contexts/TabContext.tsx` | 3,147 | 🔴 Very High | State sync, multi-tab coordination |
| `components/edges/ConversionEdge.tsx` | 3,030 | 🟡 High | Edge rendering, beads, chevrons, hover preview, sankey, drag |
| `components/GraphCanvas.tsx` | 2,895 | 🟡 High | Rendering, layout, interactions |
| `lib/snapshot_service.py` | 2,693 | 🟡 High | All snapshot DB queries, connection pool, TTL cache |
| `components/editors/GraphEditor.tsx` | 2,647 | 🟡 High | State management, editor coordination |
| `services/windowAggregationService.ts` | 2,574 | 🟡 High | Time-series aggregation, signature cache |
| `lib/graphComputeClient.ts` | 2,478 | 🟡 High | FE↔Python protocol, per-type normalisers, TTL cache |
| `bayes/compiler/evidence.py` | 2,424 | 🔴 Very High | Evidence binding, trajectory construction, recency weights |
| `bayes/worker.py` | 2,420 | 🔴 Very High | Two-phase orchestration, Phase 2 frozen-prior pipeline, Modal entry |
| `services/workspaceService.ts` | 2,374 | 🟡 High | Git ops, workspace mgmt, live share |
| `components/QueryExpressionEditor.tsx` | 2,344 | 🟡 High | Monaco autocomplete, DSL chip parsing |
| `bayes/compiler/inference.py` | 2,251 | 🔴 Very High | nutpie integration, JAX backend, stall detector |
| `lib/runner/runners.py` | 2,139 | 🟡 High | Per-analysis dispatch (path, funnel, comparison, etc.) |
| `lib/runner/forecast_runtime.py` | 1,944 | 🔴 Very High | `PreparedForecastRuntimeBundle`, rate-conditioning seam |
| `services/ScenariosContext.tsx` | 1,935 | 🟡 High | Scenario state, regeneration, persistence |
| `services/analysisECharts/cohortComparisonBuilders.ts` | 1,915 | 🟡 High | Cohort maturity chart with epochs, bands, latency overlay |
| `lib/runner/forecast_state.py` | 1,819 | 🔴 Very High | `compute_forecast_trajectory`, `compute_forecast_summary`, IS conditioning |

### Smaller but architecturally central

| Component | LOC | Why it matters |
|-----------|-----|----------------|
| `lib/runner/cohort_forecast_v3.py` | 1,708 | Closed-form non-latency rows + MC sweep dispatch |
| `services/retrieveAllSlicesService.ts` | 1,651 | Daily automation execution path |
| `services/windowFetchPlannerService.ts` | 1,629 | Staleness/coverage planning |
| `lib/runner/cohort_forecast.py` | 1,638 | v1 cohort maturity (legacy) |
| `lib/analysisDisplaySettingsRegistry.ts` | 1,530 | Central chart-display-settings registry |
| `lib/msmdc.py` | 1,196 | Set-cover query optimisation |
| `services/queryRegenerationService.ts` | 1,162 | FE-side MSMDC orchestrator |
| `bayes/tracker/` | 1,553 | MCP server for investigation tracking |
| `lib/runner/path_runner.py` | 836 | State-space expansion, conditional probabilities |
| `services/dataOperationsService.ts` (+ `dataOperations/`) | 713 (orchestrator) | Thin orchestrator over the fetch/cache cluster |

### Aggregate clusters

Read these as wholes rather than as individual files:

- **BE runner cluster** — `graph-editor/lib/runner/` 18,481 LOC across forecast / cohort_forecast / runners / derivations. See [BE_RUNNER_CLUSTER.md](BE_RUNNER_CLUSTER.md).
- **Fetch orchestration cluster** — `dataOperations/` + `fetchDataService` + `windowFetchPlannerService` + `fetchPlanBuilderService` (~12,000 LOC across §3).
- **Bayes tree** — `bayes/` 36,113 LOC (Python only, plus tests). Compiler 7,902 + worker 2,420 + run_regression 1,768 + synth_gen 4,722 + tracker 1,553 + diagnostics ~3,000.
- **Hash/signature cluster** — see §10.
- **analysisECharts builders** — 5,187 LOC across 6 chart builders. See [ANALYSIS_ECHARTS_BUILDERS.md](ANALYSIS_ECHARTS_BUILDERS.md).
- **Hooks** — 93 files, 20,730 LOC. See [HOOKS_INVENTORY.md](HOOKS_INVENTORY.md).
- **Tests** — ~170,000 LOC across `services/__tests__` (108k), `lib/tests` (33k), `bayes/tests` (19k), `e2e` (12k).

---

## Recommendations

### 1. Continue the decomposition pattern

The `dataOperations/`, `updateManager/`, and `analysisECharts/` subdirectories show the pattern that works: keep a thin orchestrator at the top and put helpers in a co-located subdirectory. `statisticalEnhancementService.ts` (3,836 LOC) and `fetchDataService.ts` (3,169 LOC) are candidates for the same treatment.

### 2. Test coverage where state crosses subsystems

The riskiest defects sit on the seams: snapshot↔forecast, generalisation↔snapshot, hash chain↔cache, scenario round-trip↔git sync. Integration tests at these seams catch what unit tests cannot.

### 3. Document seams, not just files

Codebase docs under [`docs/current/codebase/`](docs/current/codebase/) — particularly `SYNC_SYSTEM_OVERVIEW.md`, `RESERVED_QUERY_TERMS_GLOSSARY.md`, `TESTING_STANDARDS.md`, `SERVICE_DIRECTORY.md` — are the canonical entry points. Keep them as the seams change.

### 4. Type safety at signatures

Signature inputs and outputs are the system's contract. Strong types here pay back disproportionately because every cache-touching subsystem depends on them.

### 5. Bayes compiler discipline

Per CLAUDE.md §4, every new compiler branch needs a synthetic builder. This is the highest-leverage rule in the codebase: it prevents an entire class of "looks fine in dev, blows up in regression" failures.

---

## Conclusion

DagNet's complexity is **inherent to the domain**: graph-based probability and cost calculation, time-series merging across providers, Bayesian inference over compiled graphs, and signature-keyed caching. The codebase has matured from a few large monoliths to a denser fabric of co-located service clusters; the dominant complexity now lives in the **interactions** between subsystems (forecast ↔ snapshot ↔ generalisation ↔ signature) rather than in any single file.

**Key takeaway**: read by *cluster*, not by file. The fetch cluster, the forecasting cluster, the Bayes tree, the snapshot DB, and the signature cluster each have their own internal logic, and the seams between them are where the work — and the bugs — live.
