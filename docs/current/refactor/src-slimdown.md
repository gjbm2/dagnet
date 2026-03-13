## Src Slimdown Plan (Large File Modularisation)

**Created:** 15-Dec-25
**Last reviewed:** 13-Mar-26
**Status:** In progress — Target 1 (analysisEChartsService) completed 13-Mar-26

---

### Purpose

Several files under `graph-editor/src/` remain too large and mix multiple responsibilities. This plan defines a safe, test-guided approach to split those files into smaller, navigable modules **without creating duplicate code paths** and while preserving DagNet's architectural constraints (services own logic; UI owns composition).

This document is intended to be the **single source of truth** for the slimdown work. Earlier refactor proposals for the same surface area have been archived under `docs/archive/refactor/` (see "Related documents").

---

### Revision History

- **15-Dec-25**: Initial plan created.
- **14-Jan-26**: Up-front decisions agreed; programme order and PR sequences defined.
- **13-Mar-26**: Full re-analysis. All targets re-inventoried (significant growth since Jan). New target added (`analysisEChartsService`). Responsibility clusters re-mapped against current code. Test runlists updated. Programme order revised.
- **13-Mar-26**: Target 1 (`analysisEChartsService`) completed. 3,378-line god file split into 5 modules + 452-line facade. All 47 tests pass. Committed as `4f7536db` on `slimdown/src-modularisation`, merged to `feature/snapshot-db-phase0`.

---

### Scope (What This Plan Is / Isn't)

- **In scope**
  - Structural extraction and file modularisation
  - Naming, organisation, and dependency direction improvements
  - Deleting clearly-dead code only when it is obviously unused and protected by existing tests
- **Out of scope (unless explicitly approved later)**
  - Changes to caching semantics, query semantics, persistence formats, or data shape
  - "While we're here" feature work or large behavioural clean-ups

---

### Goals (What "Good" Looks Like)

- **Maintainability**: Each module has a single, clearly named responsibility and is small enough to be navigable.
- **Stable public surface**: Call sites keep importing from the same existing file paths unless there is an explicit, agreed migration.
- **No behavioural change**: Refactor steps are structural; behaviour remains identical unless explicitly approved.
- **No duplicate code paths**: We extract and centralise; we do not re-implement logic in multiple places.
- **Tests as proof**: Existing relevant tests remain green throughout (run per-file, not the full suite).

---

### Non‑Negotiables (Repo Rules to Preserve)

- **No logic in UI/menu files**: UI components and menus remain access points only; business logic stays in services/hooks.
- **IndexedDB is source of truth for git/data ops**: Avoid introducing new in-memory "truths" while moving code around.
- **Session logging**: External/data operations must keep `sessionLogService` coverage; do not lose log events during extraction.
- **UK date format**: Internal/UI/logging stays `d-MMM-yy` unless at an external API boundary.
- **Minimise surface area**: Avoid temporary compatibility shims and parallel entry points; keep one "canonical" import per domain.

---

### Current Inventory (as of 13-Mar-26)

Primary targets (current line counts, with delta from 14-Jan-26 plan):

- **Services**
  - `graph-editor/src/services/dataOperationsService.ts` — **10,333** (+1,459 / +16%)
  - `graph-editor/src/services/UpdateManager.ts` — **5,136** (+221 / +4%)
  - `graph-editor/src/services/statisticalEnhancementService.ts` — **3,434** (+328 / +11%)
  - `graph-editor/src/services/integrityCheckService.ts` — **3,589** (+517 / +17%)
  - `graph-editor/src/services/analysisEChartsService.ts` — **452** (facade; was 3,378; modularised 13-Mar-26)
- **UI**
  - `graph-editor/src/components/GraphCanvas.tsx` — **6,935** (+1,435 / +26%)
  - `graph-editor/src/components/PropertiesPanel.tsx` — **3,667** (+849 / +30%)
  - `graph-editor/src/components/edges/ConversionEdge.tsx` — **2,955** (−137 / −4%)

Secondary candidates (only after the above are stable):

- `graph-editor/src/contexts/TabContext.tsx` — **3,043** (+328 / +12%)
- `graph-editor/src/components/editors/GraphEditor.tsx` — **2,451** (+207 / +9%)
- `graph-editor/src/components/QueryExpressionEditor.tsx` — **2,318** (+186 / +9%)

**Total primary target surface area: ~36,501 lines** (down from ~39,427 after Target 1 completion; originally ~30,469 in Jan).

---

### Up-Front Decisions (Unchanged from 14-Jan-26 Unless Noted)

All 8 decisions from the Jan review remain in force. They are reproduced here with amendments marked.

**Decision 1 — Behavioural freeze (what we will not change during slimdown)**

During the slimdown phases, we treat the following as **frozen semantics**:

- Contexts/slice semantics (including when/where slice isolation is applied)
- Query signature behaviour (including warning vs indexing semantics)
- UK date handling behaviour (normalisation rules, boundary conversion, comparison semantics)
- Override gating, permission-flag propagation, and rebalancing triggers
- Session log event coverage and event identity (event names/categories/shape)
- "Single code path" guarantees (do not introduce alternate pathways during extraction)
- **[ADDED Mar-26]** Snapshot DB read/write semantics (asat() routing, dense row construction, signature-based filtering)
- **[ADDED Mar-26]** Forecasting blend logic (`computeBlendedMean` single path), evidence/forecast scalar computation
- **[ADDED Mar-26]** Fenton–Wilkinson path horizon estimation and cohort-mode path-anchored completeness
- **[ADDED Mar-26]** Canvas analysis result caching and chart boot tracing semantics
- **[ADDED Mar-26]** Atomic decoration restoration (pan/zoom bead suppression and `flushSync` restore)

If a proposed extraction *forces* a change to any of the above, the correct response is to **stop** and resolve that issue explicitly before proceeding.

**Decision 2 — Public surface and entrypoints** — Unchanged.

**Decision 3 — Standard extraction template** — Unchanged.

**Decision 4 — Module-boundary rubric** — Unchanged.

**Decision 5 — Explicit stop-list (areas requiring extra care / review)**

Before extracting code that touches any of these areas, pause and explicitly confirm the invariants being preserved:

- `UpdateManager` mapping initialisation and shared caching behaviour
- `UpdateManager` evidence/window/date handling
- `UpdateManager` rebalancing and override gating
- `dataOperationsService` slice/DSL flows (`targetSlice`, `currentDSL`) and signature warnings
- External→file append + file→graph update orchestration (versioned fetch)
- Fetch/refetch policy boundaries and "bust cache" semantics
- `GraphCanvas` / `ConversionEdge` scenario overlay rules (selection, suppression during pan/drag) and what-if propagation
- **[ADDED Mar-26]** `dataOperationsService.getFromSourceDirect()` closure state (DAS runner, fetch windows, time-series accumulator) — this 900-line closure is the highest-risk extraction target in the codebase
- **[ADDED Mar-26]** `statisticalEnhancementService.enhanceGraphLatencies()` DP state (nodePathT95, edgeFlowMass, nodeMedianLagPrior, nodePathMu/Sigma) — 1,454-line orchestrator
- **[ADDED Mar-26]** `integrityCheckService.validateGraph()` reference tracking sets (referencedParams etc.) — mutated during iteration, consumed by orphan detection
- **[ADDED Mar-26]** `GraphCanvas` Graph↔ReactFlow sync (fast path vs slow path, `lastSyncedGraphRef`, `isSyncingRef`) — ~1,300 lines of bidirectional sync
- **[ADDED Mar-26]** `TabContext` FileRegistry dual-ID handling (prefixed + unprefixed IDB records)

**Decision 6 — Deletion policy** — Unchanged.

**Decision 7 — Performance guardrails** — Unchanged.

**Decision 8 — Tests and authorisation gates** — Unchanged.

---

### Key Invariants to Preserve (Newer / Easy to Break)

These couplings exist today and must not be altered accidentally during extraction:

- **Contexts and slice semantics** — Slice/context/window behaviour flows through DSL and the slice-aware services. Signature mechanisms are used for integrity/staleness signalling.
- **Date format** — UK date format (`d-MMM-yy`) is expected internally; ISO is for external API boundaries only.
- **Single-path behaviour** — Avoid "special" code paths for auto-aggregation vs manual fetch, scenario overlays vs current layer, or menu vs toolbar actions.
- **[ADDED Mar-26] Snapshot DB + asat()** — Signature-based row filtering, dense row construction, virtual snapshot queries. These paths exist in both `dataOperationsService` (getParameterFromFile asat fork, getFromSourceDirect asat fork, snapshot write after DAS fetch) and `statisticalEnhancementService` (path-anchored completeness). Do not split them in ways that break the signature→DB→timeseries pipeline.
- **[ADDED Mar-26] Forecasting pipeline** — `computeBlendedMean()` is the single source of truth for blending evidence + forecast. It is called from `enhanceGraphLatencies()`. The evidence/forecast scalar computation in `dataOperationsService.addEvidenceAndForecastScalars()` feeds this. These must remain a single path.
- **[ADDED Mar-26] Canvas object lifecycle** — Post-its, containers, and canvas analyses follow a consistent create/update/delete/z-order pattern in GraphCanvas. Do not extract them into separate subsystems that diverge.

---

### Strategy: How We Split Without Breaking Things

Unchanged from the Jan plan. Summarised:

- Keep the existing file path as the facade (public entry point).
- Extract into sibling modules under a dedicated internal directory.
- Extract by dependency direction: pure utilities/types first, then domain logic, then orchestration.
- Prefer one-way module dependencies; create small shared modules rather than cycles.
- Avoid re-ordering side effects.

---

### Programme Order (Revised 13-Mar-26)

Execute in this order. Rationale for changes from Jan noted in brackets.

1. `analysisEChartsService.ts` — **NEW TARGET, moved to #1** [cleanest seams; low coupling between clusters; excellent first-win to build confidence]
2. `UpdateManager.ts` [unchanged priority; moderate growth, well-understood clusters]
3. `integrityCheckService.ts` [moved up from #4; new check categories are self-contained; validateGraph() monolith is a clear extraction target]
4. `statisticalEnhancementService.ts` [unchanged priority; topology helpers extractable, but 1,454-line orchestrator is high risk]
5. `dataOperationsService.ts` [moved from #2 to #5; grew by 1,459 lines; 900-line closure makes extraction hardest; benefits from earlier targets reducing cognitive load]
6. `GraphCanvas.tsx` [moved from #5 to #6; grew 26% but many clusters are already in canvas/ directory]
7. `PropertiesPanel.tsx` [unchanged priority; grew 30% but CanvasAnalysisPropertiesSection is already self-contained]
8. `ConversionEdge.tsx` [unchanged; shrank slightly; existing helpers already extracted]
9. Secondary candidates (only after the above are stable)

---

### Work Breakdown by Target (Procedural PR Sequence)

For each target below, follow the same internal sequencing per Decision 3.

---

#### Target 1 — `analysisEChartsService.ts` (3,378 → 452 lines) — COMPLETED 13-Mar-26

**Current clusters:**
- A: Theming & common display settings (~220 lines)
- B: Dimension & metadata helpers (~150 lines)
- C: Funnel builders (~550 lines)
- D: Bridge/waterfall builder (~650 lines)
- E: Snapshot-based builders — histogram, daily conversions, lag fit (~650 lines)
- F: Cohort maturity builder (~330 lines)
- G: Comparison builders with shared state helper (~620 lines)
- H: Chart option dispatcher & post-processing (~400 lines)

**Extraction directory:** `graph-editor/src/services/analysisECharts/`

**PR sequence:**

- **AEC-PR1 (theming + metadata helpers)**: Extract Clusters A+B into `analysisECharts/echartsCommon.ts`. These are the highest-traffic internal helpers (called by every builder). Pure functions, zero risk.
- **AEC-PR2 (funnel builders)**: Extract Cluster C into `analysisECharts/funnelBuilders.ts`. Self-contained; depends only on common helpers.
- **AEC-PR3 (bridge builder)**: Extract Cluster D into `analysisECharts/bridgeBuilder.ts`. Self-contained.
- **AEC-PR4 (snapshot builders)**: Extract Cluster E into `analysisECharts/snapshotBuilders.ts`. Histogram, daily conversions, lag fit grouped by data provenance.
- **AEC-PR5 (cohort maturity + comparison builders)**: Extract Clusters F+G into `analysisECharts/cohortMaturityBuilder.ts` and `analysisECharts/comparisonBuilders.ts`. Comparison builders share `buildComparisonChartState()` — keep it with them.
- **AEC-PR6 (facade tidy-up)**: Reduce `analysisEChartsService.ts` to dispatcher (Cluster H) + re-exports.

**Stop/gates:** After AEC-PR2: confirm chart output is pixel-identical (run visual diff or manual spot-check).

**Core tests:**
- `graph-editor/src/services/__tests__/analysisEChartsService.bridge.test.ts`
- `graph-editor/src/services/__tests__/analysisEChartsService.dispatch.test.ts`
- `graph-editor/src/services/__tests__/analysisEChartsService.funnel.test.ts`
- `graph-editor/src/services/__tests__/analysisEChartsService.funnelBar.stepChange.test.ts`
- `graph-editor/src/services/__tests__/analysisEChartsService.funnelBar.test.ts`
- `graph-editor/src/services/__tests__/analysisEChartsService.funnelBridge.test.ts`

**Safety net tests:**
- `graph-editor/src/services/__tests__/chartDisplayPlanningService.test.ts`
- `graph-editor/src/services/__tests__/chartOperationsService.bridgeDslInjection.test.ts`

---

#### Target 2 — `UpdateManager.ts` (5,136 lines)

**Current clusters (updated):**
- A: Types & contracts (~115 lines)
- B: Rounding utilities (~15 lines)
- C: Edge parameter locking (~15 lines)
- D: Edge rebalancing (~170 lines)
- E: Direct edge probability updates (~210 lines)
- F: Direction handlers (~230 lines)
- G: Operation implementations (~400 lines) including core `applyMappings()` engine
- H: Mapping configuration (~1,200 lines) — 18 configs across 5 directions
- I: Nested value access utilities (~80 lines)
- J: Audit trail & logging (~30 lines)
- K: Conditional probability management (~230 lines)
- L: Graph mutation operations (delete, rebalance, colour propagation) (~400 lines)
- M: Copy/paste & bulk operations (~800 lines)
- N: Graph helper methods (~20 lines)

**Extraction directory:** `graph-editor/src/services/updateManager/`

**PR sequence:**

- **UM-PR1 (types + pure helpers)**: Extract Clusters A, B, C, I, J, N into `updateManager/types.ts`, `updateManager/roundingUtils.ts`, `updateManager/nestedValueAccess.ts`, `updateManager/auditLog.ts`.
- **UM-PR2 (mapping configuration)**: Extract Cluster H into `updateManager/mappingConfigurations.ts`. This is the largest single cluster (~1,200 lines) and is purely declarative.
- **UM-PR3 (mapping engine + operations)**: Extract Cluster G (`applyMappings()` and all operation implementations) into `updateManager/mappingEngine.ts`.
- **UM-PR4 (edge rebalancing + conditional probability)**: Extract Clusters D, E, K into `updateManager/edgeRebalancing.ts` and `updateManager/conditionalProbability.ts`.
- **UM-PR5 (graph mutations + copy/paste)**: Extract Clusters L, M into `updateManager/graphMutations.ts` and `updateManager/clipboardOperations.ts`.
- **UM-PR6 (facade tidy-up)**: Reduce `UpdateManager.ts` to direction handlers (Cluster F) + class shell that composes extracted modules.

**Stop/gates:**
- After UM-PR2: explicitly confirm shared mapping initialisation and caching behaviour is unchanged.
- After UM-PR4: explicitly confirm evidence/window/date handling and rebalancing semantics are unchanged.

**Core tests:**
- `graph-editor/src/services/UpdateManager.test.ts`
- `graph-editor/src/services/__tests__/UpdateManager.rebalance.test.ts`
- `graph-editor/src/services/__tests__/UpdateManager.graphToGraph.test.ts`
- `graph-editor/src/services/__tests__/updateManager.externalToGraphEvidenceFields.test.ts`
- `graph-editor/src/services/__tests__/updateManager.updateConditionalProbabilityEvidenceWindow.test.ts`
- `graph-editor/src/services/__tests__/updateManager.applyBatchLAGValues.pStdevFallback.test.ts` **(NEW)**

**Safety net tests:**
- `graph-editor/tests/unit/update-manager-uuids.test.ts`
- `graph-editor/tests/state-sync/multi-source-truth.test.ts`

---

#### Target 3 — `integrityCheckService.ts` (3,589 lines)

**Current clusters (updated):**
- A: Entry point & data preparation (~70 lines)
- B: File ID manipulation & utilities (~100 lines)
- C: ID format validation (~80 lines)
- D: Type-specific file validators (~310 lines)
- E: Graph validation core (~1,020 lines) — **monolith; 29% of file**
- F: Graph semantic validation (~210 lines) — NEW since Jan
- G: Drift detection (direct vs versioned) (~180 lines) — NEW since Jan
- H: Registry/index validation (~170 lines)
- I: Orphan detection (~60 lines)
- J: Duplicate detection (~65 lines)
- K: Cross-graph consistency (~30 lines)
- L: External system validation — credentials + images (~310 lines)
- M: Face alignment validation (~230 lines) — NEW since Jan
- N: Logging & output (~240 lines)

**Extraction directory:** `graph-editor/src/services/integrityCheck/`

**PR sequence:**

- **ICS-PR1 (types + utilities)**: Extract Clusters B, C, N into `integrityCheck/types.ts`, `integrityCheck/fileIdUtils.ts`, `integrityCheck/reportGenerator.ts`.
- **ICS-PR2 (file validators)**: Extract Cluster D into `integrityCheck/fileValidators.ts` (parameter, case, node, event, context validators).
- **ICS-PR3 (graph validation split)**: Split Cluster E into sub-methods within `integrityCheck/graphValidator.ts`: `validateGraphNodes()`, `validateGraphEdges()`, `validateGraphSiblingConstraints()`, `validateGraphTopology()`. Keep reference tracking sets as shared state passed between sub-methods.
- **ICS-PR4 (semantic + drift + face alignment)**: Extract Clusters F, G, M into `integrityCheck/semanticValidator.ts`, `integrityCheck/driftValidator.ts`, `integrityCheck/faceAlignmentValidator.ts`.
- **ICS-PR5 (registry + orphan + external)**: Extract Clusters H, I, J, K, L into `integrityCheck/registryValidator.ts`, `integrityCheck/externalValidator.ts`.
- **ICS-PR6 (facade tidy-up)**: Reduce `integrityCheckService.ts` to orchestrator (Cluster A) that calls extracted validators in sequence.

**Stop/gates:**
- After ICS-PR3: confirm reference tracking sets are built correctly (no dropped references → orphan false positives).
- After ICS-PR4: confirm check coverage is unchanged (no dropped checks).

**Core tests:**
- `graph-editor/src/services/__tests__/integrityCheckService.fileId.test.ts`
- `graph-editor/src/services/__tests__/integrityCheckService.blankStringEqualsUndefined.test.ts`
- `graph-editor/src/services/__tests__/integrityCheckService.graphParameterDrift.test.ts`
- `graph-editor/src/services/__tests__/integrityCheckService.graphCaseDrift.test.ts`
- `graph-editor/src/services/__tests__/integrityCheckService.conditionalSiblingAlignment.test.ts`
- `graph-editor/src/services/__tests__/integrityCheckService.semanticEvidenceIssues.test.ts`
- `graph-editor/src/services/__tests__/integrityCheckService.faceAlignment.test.ts` **(NEW)**

**Safety net tests:**
- `graph-editor/src/services/__tests__/sampleFilesIntegrity.test.ts`

---

#### Target 4 — `statisticalEnhancementService.ts` (3,434 lines)

**Current clusters (updated):**
- A: Statistical enhancement plugin system (~335 lines) including `computeBlendedMean()`
- B: Mathematical utilities — log-normal, Fenton–Wilkinson, recency weighting (~170 lines)
- C: Completeness calculation with tail constraint (~210 lines)
- D: Edge latency statistics — `computeEdgeLatencyStats()` (~200 lines)
- E: Graph topology & active edges — adjacency, path_t95 DP (~370 lines)
- F: Master batch enhancement — `enhanceGraphLatencies()` (~1,454 lines) — **42% of file, highest-risk cluster**
- G: Inbound-N forecast population DP (~160 lines)
- H: Topology sort utilities (~47 lines)

**Extraction directory:** `graph-editor/src/services/statisticalEnhancement/`

**PR sequence:**

- **SES-PR1 (topology + inbound-N)**: Extract Clusters E, G, H into `statisticalEnhancement/graphTopology.ts` and `statisticalEnhancement/inboundN.ts`. These are pure graph algorithms with no LAG-specific coupling.
- **SES-PR2 (math + completeness)**: Extract Clusters B, C into `statisticalEnhancement/lagMathUtils.ts`. Pure functions; high reuse value.
- **SES-PR3 (edge stats + enhancement plugin)**: Extract Clusters A, D into `statisticalEnhancement/enhancementPlugins.ts` and `statisticalEnhancement/edgeLatencyStats.ts`.
- **SES-PR4 (facade tidy-up)**: Reduce the main file to Cluster F (`enhanceGraphLatencies()` orchestrator) + re-exports. Do NOT attempt to split the 1,454-line orchestrator — it contains tightly-coupled DP state that would be dangerous to separate.

**Stop/gates:**
- After SES-PR2: confirm no changes to numeric output behaviour, rounding, or default assumptions. Run golden test.
- After SES-PR3: confirm `computeBlendedMean()` single-path guarantee preserved.

**Core tests:**
- `graph-editor/src/services/__tests__/statisticalEnhancementService.test.ts`
- `graph-editor/src/services/__tests__/lagDistribution.golden.test.ts`
- `graph-editor/src/services/__tests__/lagStatsFlow.integration.test.ts`
- `graph-editor/src/services/__tests__/pathT95Computation.test.ts`
- `graph-editor/src/services/__tests__/pathT95CompletenessConstraint.test.ts`
- `graph-editor/src/services/__tests__/pathT95JoinWeightedConstraint.test.ts`
- `graph-editor/src/services/__tests__/addEvidenceAndForecastScalars.test.ts`
- `graph-editor/src/services/__tests__/cohortHorizonIntegration.test.ts`
- `graph-editor/src/services/__tests__/fetchMergeEndToEnd.test.ts`
- `graph-editor/src/services/__tests__/selectLatencyToApplyForTopoPass.test.ts` **(NEW)**
- `graph-editor/src/services/__tests__/onset_aggregation.test.ts` **(NEW)**
- `graph-editor/src/services/__tests__/onset_cohort_excluded.test.ts` **(NEW)**
- `graph-editor/src/services/__tests__/onset_override_flow.test.ts` **(NEW)**
- `graph-editor/src/services/__tests__/onset_shifted_completeness.test.ts` **(NEW)**

**Safety net tests:**
- `graph-editor/src/services/__tests__/cohortEvidenceDebiasing.e2e.test.ts`
- `graph-editor/src/services/__tests__/windowCohortSemantics.paramPack.e2e.test.ts`
- `graph-editor/src/services/__tests__/paramPackCsvRunner.csvDriven.tool.test.ts`

---

#### Target 5 — `dataOperationsService.ts` (10,333 lines)

**Current clusters (updated):**
- A: Batch mode & toast management (~110 lines)
- B: Logging & formatting helpers (~55 lines)
- C: Query compilation & DSL processing (~50 lines)
- D: Query signature computation & validation (~295 lines)
- E: As-at (asat) historical query support (~570 lines) — NEW since Jan
- F: File→graph sync (GET paths) — getParameterFromFile, getCaseFromFile, getNodeFromFile (~2,600 lines)
- G: Graph→file sync (PUT paths) — putParameterToFile, putCaseToFile, putNodeToFile (~830 lines)
- H: Source data fetching (versioned path) — getFromSource orchestrator (~280 lines)
- I: Core data fetch — `getFromSourceDirect()` (~4,700 lines) — **45% of file, 900-line closure, highest-risk extraction in the codebase**
- J: Evidence & forecast scalar computation (~835 lines) — NEW since Jan
- K: Batch operations (~95 lines)
- L: Cache & settings UI (~150 lines)

**Extraction directory:** `graph-editor/src/services/dataOperations/`

**PR sequence:**

- **DOS-PR1 (types + small helpers)**: Extract Clusters A, B, C into `dataOperations/batchMode.ts`, `dataOperations/logHelpers.ts`, `dataOperations/queryCompiler.ts`.
- **DOS-PR2 (signature computation)**: Extract Cluster D into `dataOperations/querySignature.ts`. `computeQuerySignature()` is already a standalone exported function.
- **DOS-PR3 (asat query support)**: Extract Cluster E into `dataOperations/asatQuerySupport.ts`. Includes `selectQuerySignatureForAsat()`, `convertVirtualSnapshotToTimeSeries()`, `fireAsatWarnings()`, `buildDenseSnapshotRowsForDbWrite()`.
- **DOS-PR4 (evidence + forecast scalars)**: Extract Cluster J into `dataOperations/evidenceForecastScalars.ts`. `addEvidenceAndForecastScalars()` is already test-exposed.
- **DOS-PR5 (file↔graph sync)**: Extract Clusters F, G into `dataOperations/fileToGraphSync.ts` and `dataOperations/graphToFileSync.ts`.
- **DOS-PR6 (cache & settings)**: Extract Cluster L into `dataOperations/cacheManagement.ts`.
- **DOS-PR7 (facade tidy-up)**: Reduce `dataOperationsService.ts` to Clusters H, I, K (versioned fetch orchestration, core DAS execution, batch operations) + re-exports. Do NOT attempt to split the `getFromSourceDirect()` closure — the state management risk outweighs the readability benefit at this stage.

**Stop/gates:**
- After DOS-PR3: explicitly confirm asat() routing, signature selection, and snapshot DB write semantics are unchanged.
- After DOS-PR5: explicitly confirm slice/DSL flows, permission copy modes, and signature warning behaviour are unchanged.

**Core tests:**
- `graph-editor/src/services/__tests__/dataOperationsService.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.integration.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.incrementalGapPersistence.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.openEndedWindowResolution.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.directFetchFailurePropagation.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.forecastFromDailyArrays.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.persistedConfigByMode.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.casePersistedConfigByMode.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.putParameterToFile.metadataOnly.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.putParameterToFile.forceCopyClearsNQuery.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.asatSignatureSelection.test.ts` **(NEW)**
- `graph-editor/src/services/__tests__/dataOperationsService.asatSliceMatching.test.ts` **(NEW)**
- `graph-editor/src/services/__tests__/versionedFetch.integration.test.ts`
- `graph-editor/src/services/__tests__/fetchPolicyIntegration.test.ts`
- `graph-editor/src/services/__tests__/fetchDataService.test.ts`
- `graph-editor/src/services/__tests__/fetchDataService.fromFile.permissionsDefault.test.ts`
- `graph-editor/src/services/__tests__/fetchDataService.conditionalFetchPlanning.test.ts`
- `graph-editor/src/services/__tests__/addEvidenceAndForecastScalars.test.ts`

**Safety net tests:**
- `graph-editor/tests/pipeline-integrity/simple-query-flow.test.ts`
- `graph-editor/tests/pipeline-integrity/composite-query-flow.test.ts`
- `graph-editor/tests/identity/signature-consistency.test.ts`
- `graph-editor/src/services/__tests__/versionedFetchFlow.e2e.test.ts` **(NEW)**

---

#### Target 6 — `GraphCanvas.tsx` (6,935 lines)

**Current clusters (updated):**
- Core state management (~265 lines)
- Edge geometry & bundling — `calculateEdgeOffsets()`, `getEdgeSortKey()` (~375 lines)
- Edge connection & routing — optimal handles, reroute, reconnect (~455 lines)
- Node & edge CRUD (~505 lines)
- Canvas objects CRUD — post-its, containers, canvas analyses (~210 lines) — NEW since Jan
- Selection & events (~180 lines)
- Graph↔ReactFlow sync — fast path + slow path (~1,310 lines) — **largest cluster, highest risk**
- Layout algorithms — dagre, sankey, hide (~375 lines)
- Creation tools — addNode, addPostit, addContainer, addAnalysis (~645 lines)
- Copy/paste/drag-drop (~255 lines)
- Context menus (~740 lines)
- Pan/zoom & decoration management (~135 lines) — NEW since Jan (atomic restore)
- What-if/scenario rendering (~65 lines)
- Snapshot boot tracing (~90 lines) — NEW since Jan
- JSX render tree (~990 lines)

**Extraction directory:** `graph-editor/src/components/canvas/` (existing directory)

**PR sequence:**

- **GC-PR1 (edge geometry)**: Extract edge geometry & bundling into `canvas/edgeGeometry.ts`. Pure computations.
- **GC-PR2 (layout algorithms)**: Extract dagre + sankey layout into `canvas/layoutAlgorithms.ts`.
- **GC-PR3 (canvas object CRUD)**: Extract post-it, container, analysis handlers into `canvas/canvasObjectHandlers.ts`. These follow a consistent pattern and are self-contained.
- **GC-PR4 (creation tools + copy/paste)**: Extract creation tools and clipboard operations into `canvas/creationTools.ts` and `canvas/clipboardOperations.ts`.
- **GC-PR5 (context menus)**: Extract context menu handlers into `canvas/contextMenuHandlers.ts`.
- **GC-PR6 (facade tidy-up)**: Reduce GraphCanvas to core state, Graph↔ReactFlow sync, selection, pan/zoom, and JSX render. Do NOT extract the sync engine — it is too tightly coupled to React state and refs.

**Stop/gates:**
- After GC-PR2: explicitly confirm no render-loop or reactivity changes (dependency arrays and state ownership preserved).
- After GC-PR4: explicitly confirm canvas object creation flows are unchanged (node, post-it, container, analysis).

**Core tests:**
- `graph-editor/src/components/canvas/__tests__/buildScenarioRenderEdges.test.ts`
- `graph-editor/src/components/canvas/__tests__/buildScenarioRenderEdges.efGeometry.test.ts`
- `graph-editor/src/components/edges/__tests__/EdgeBeads.test.tsx`
- `graph-editor/src/components/edges/__tests__/EdgeBeads.probabilityMode.test.tsx`
- `graph-editor/src/components/edges/__tests__/EdgeBeads.probabilityMode.scalarEvidence.test.tsx`
- `graph-editor/src/components/edges/__tests__/EdgeBeads.derivedBracket.test.tsx`
- `graph-editor/src/components/edges/__tests__/EdgeBeads.derivedForecastBracket.test.tsx`
- `graph-editor/src/components/edges/__tests__/ConversionEdge.sankeyParity.test.tsx`
- `graph-editor/src/services/__tests__/graphStoreSyncIntegration.test.ts`
- `graph-editor/src/services/__tests__/edgeReconnection.test.ts`

**Safety net tests:**
- `graph-editor/tests/smoke.test.ts`

---

#### Target 7 — `PropertiesPanel.tsx` (3,667 lines)

**Current clusters (updated):**
- A: Validation & formatting helpers (~65 lines)
- B: CanvasAnalysisPropertiesSection sub-component (~480 lines) — NEW since Jan, already self-contained
- C: Main component state management (~120 lines)
- D: Effect hooks for data sync (~355 lines)
- E: Graph mutation helpers (~290 lines)
- F: Probability & conditional probability management (~185 lines)
- G: Query regeneration (~120 lines)
- H: Main render logic (JSX) (~2,055 lines) — includes graph metadata, node/edge/container/postit/analysis sections

**Extraction directory:** `graph-editor/src/components/panels/properties/`

**PR sequence:**

- **PP-PR1 (validation + formatting helpers)**: Extract Cluster A into `panels/properties/validationHelpers.ts`.
- **PP-PR2 (canvas analysis section)**: Extract Cluster B into `panels/properties/CanvasAnalysisPropertiesSection.tsx`. This is already a self-contained sub-component with its own state, effects, and render tree — the easiest extraction in this target.
- **PP-PR3 (graph mutation helpers)**: Extract Clusters E, F, G into `panels/properties/graphMutationHelpers.ts`. These are callback factories that delegate to services.
- **PP-PR4 (section components)**: Extract major render sections from Cluster H into dedicated components: `panels/properties/NodePropertiesSection.tsx`, `panels/properties/EdgePropertiesSection.tsx`, `panels/properties/GraphMetadataSection.tsx`.
- **PP-PR5 (facade tidy-up)**: Reduce `PropertiesPanel.tsx` to state setup (C), effects (D), and composition/wiring.

**Stop/gates:**
- After PP-PR3: confirm persistence wiring and "authoritative DSL" behaviour unchanged.

**Core tests:**
- `graph-editor/src/components/__tests__/PropertiesPanel.hooks.test.tsx`
- `graph-editor/src/components/__tests__/PropertiesPanel.latencyToggleTriggersGraphMutation.test.tsx`
- `graph-editor/src/components/__tests__/CanvasAnalysisPropertiesSection.test.tsx` **(NEW)**

**Safety net tests:**
- `graph-editor/src/components/__tests__/QueryExpressionEditor.test.tsx`

---

#### Target 8 — `ConversionEdge.tsx` (2,955 lines)

**Current clusters (updated):**
- Constants & configuration (~15 lines)
- Edge rendering pipeline including lag layer data (~85 lines)
- Path & geometry computation — Bezier, smooth-step, face direction (~610 lines)
- Offset path & text rendering (~45 lines)
- Completeness chevron rendering (~110 lines) — NEW since Jan
- Interaction handlers (~195 lines)
- Parameter attachment drag-drop (~100 lines) — NEW since Jan
- Hover & tooltip management (~75 lines)
- Scenario overlay rendering (~60 lines)
- Main render function (JSX) (~855 lines)

**Extraction directory:** `graph-editor/src/components/edges/` (existing directory)

**PR sequence:**

- **CE-PR1 (path geometry)**: Extract path & geometry computation into `edges/edgePathGeometry.ts` (Bezier curves, smooth-step, face direction, offset paths). Pure computations.
- **CE-PR2 (completeness chevron)**: Extract chevron rendering into `edges/CompletenessChevron.tsx` as a sub-component.
- **CE-PR3 (interaction handlers)**: Extract interaction handlers + parameter drag-drop into `edges/edgeInteractionHandlers.ts`.
- **CE-PR4 (facade tidy-up)**: Reduce `ConversionEdge.tsx` to composition and wiring.

**Stop/gates:**
- After CE-PR3: confirm scenario overlay selection rules and bead suppression semantics are unchanged.

**Core tests:**
- `graph-editor/src/components/edges/__tests__/ConversionEdge.sankeyParity.test.tsx`

**Safety net tests:**
- `graph-editor/src/components/edges/__tests__/EdgeBeads.test.tsx`
- `graph-editor/src/components/edges/__tests__/EdgeBeads.probabilityMode.test.tsx`

---

#### Secondary Candidates (Only After Primary Targets Stabilise)

Apply the same procedural approach. PR sequences defined here for completeness.

##### Secondary 1 — `TabContext.tsx` (3,043 lines)

Key observation: FileRegistry class is ~950 lines and could be its own module.

- **TC-PR1 (serialization + types)**: Extract serialization helpers and type definitions.
- **TC-PR2 (FileRegistry extraction)**: Extract FileRegistry class into `contexts/tabContext/FileRegistry.ts`. This is the single largest self-contained unit.
- **TC-PR3 (live share & URL boot)**: Extract live share bootstrap logic into `contexts/tabContext/liveShareBoot.ts`.
- **TC-PR4 (tab operations)**: Extract tab CRUD operations into `contexts/tabContext/tabOperations.ts`.
- **TC-PR5 (facade tidy-up)**: Reduce `TabContext.tsx` to provider composition + hooks.

Tests:
- `graph-editor/tests/state-sync/multi-source-truth.test.ts`
- `graph-editor/src/services/__tests__/graphStoreSyncIntegration.test.ts`

##### Secondary 2 — `GraphEditor.tsx` (2,451 lines)

- **GE-PR1 (processors & wrappers)**: Extract URL processors and ScenarioLegendWrapper into dedicated files.
- **GE-PR2 (sidebar state)**: Extract sidebar state machine into `editors/graphEditor/useSidebarState.ts`.
- **GE-PR3 (selection context)**: Extract selection handlers and context into `editors/graphEditor/useSelectionHandlers.ts`.
- **GE-PR4 (facade tidy-up)**: Reduce `GraphEditor.tsx` to composition + context providers.

Tests:
- `graph-editor/tests/smoke.test.ts`
- `graph-editor/src/services/__tests__/graphStoreSyncIntegration.test.ts`

##### Secondary 3 — `QueryExpressionEditor.tsx` (2,318 lines)

- **QEE-PR1 (parsing)**: Extract chip parsing logic into `editors/queryExpression/parseQueryToChips.ts`.
- **QEE-PR2 (Monaco setup)**: Extract language registration and autocomplete provider into `editors/queryExpression/monacoSetup.ts`.
- **QEE-PR3 (chip rendering)**: Extract chip UI components into `editors/queryExpression/ChipDisplay.tsx`.
- **QEE-PR4 (facade tidy-up)**: Reduce editor to composition + state coordination.

Tests:
- `graph-editor/src/components/__tests__/QueryExpressionEditor.test.tsx`
- `graph-editor/tests/unit/query-dsl.test.ts`
- `graph-editor/tests/unit/composite-query-parser.test.ts`

---

### Programme-Level Gates (When to Stop and Reassess)

Stop and reassess before continuing if any of the following occur:

- A PR requires editing existing tests (approval needed).
- A refactor step forces a change to frozen semantics (Decision 1).
- A circular dependency emerges that cannot be resolved by a small shared types/helpers module.
- A UI refactor introduces a render loop or performance regression that cannot be resolved without behavioural change.

---

### Execution Plan (Phased, Safe, and Test-Guided)

#### Phase 0 — Readiness and Guardrails (must be true before the first implementation PR)

- Confirm there are no other active refactors touching the same mega files (to avoid merge-conflict churn).
- Confirm the first target in the programme order (analysisEChartsService) and pick the first extractable cluster (theming + metadata helpers).
- Document the exact test file paths in the PR description.
- Confirm whether any test-file edits might be required; if yes, obtain explicit approval first.

#### Phase 1 — Extract "Pure" Modules (Low Risk)

For each target file:
- Extract constants, types, and pure helper functions into a dedicated internal directory.
- Keep imports one-directional (facade imports helpers).
- Keep behaviour unchanged.

#### Phase 2 — Extract Subsystems (Medium Risk)

- Move coherent clusters into dedicated modules.
- Keep orchestration in the facade until the end of this phase.

#### Phase 3 — Clean-up and Documentation (Controlled)

- Delete clearly dead code only when obviously unused and protected by existing tests.
- Add brief module-level responsibility notes.

---

### Testing Plan

Principles:
- Run tests by **explicit file paths** only.
- Do not run the full suite unless explicitly requested.
- If a refactor step requires updating an existing test file, obtain explicit approval first.

---

### Risk Register (Updated 13-Mar-26)

- **Circular dependencies after splitting** — Mitigation: extract shared types/utilities; keep one-way dependencies.
- **Behavioural drift from "small" refactor** — Mitigation: small PRs; stable entrypoints; revert quickly.
- **Loss of session logging coverage** — Mitigation: treat logging as part of orchestration boundaries.
- **UI performance regressions** — Mitigation: preserve memoisation; avoid new state layers.
- **Accidental slice/date semantic changes** — Mitigation: treat as invariants; move code first.
- **[NEW] getFromSourceDirect closure extraction** — Mitigation: do NOT extract this closure during slimdown. Flag for future consideration only after surrounding modules are stable.
- **[NEW] enhanceGraphLatencies DP state** — Mitigation: do NOT split this orchestrator. Extract its dependencies (topology, math, edge stats) but leave the 1,454-line traversal intact.
- **[NEW] integrityCheckService reference tracking** — Mitigation: pass reference sets explicitly between extracted sub-validators; do not convert to class state.
- **[NEW] Graph↔ReactFlow sync engine** — Mitigation: do NOT extract. Leave fast/slow path in GraphCanvas; extract everything else around it.

---

### Definition of Done

This slimdown effort is "done" when:

- Each primary target file is reduced to a maintainable size, or replaced by a thin facade that delegates to internal modules.
- Each new module has a single responsibility and a clear name aligned with existing directory structure.
- No duplicate code paths exist for the same operation.
- Relevant existing tests for the touched domains pass.
- Session logging for external/data operations remains intact.
- Snapshot DB, forecasting, and canvas analysis semantics remain unchanged.

---

### Related Documents

- **Primary plan**: this file.
- **Complexity analysis**: `docs/current/codebase/COMPLEXITY_ANALYSIS.md`
- **Archived (superseded) refactor proposals**:
  - `docs/archive/refactor/REFACTORING_PLAN_GRAPH_COMPONENTS.md`
  - `docs/archive/refactor/GRAPH_CANVAS_ARCHITECTURE.md`
  - `docs/archive/refactor/GRAPH_EDITOR_ARCHITECTURE.md`
