## Src Slimdown Plan (Large File Modularisation)

**Created:** 15-Dec-25
**Last reviewed:** 16-Mar-26
**Status:** In progress — Phases A, B2–B4, C1 complete; B1 (sync engine) designed and ready for implementation

---

### Purpose

Several files under `graph-editor/src/` remain too large and mix multiple responsibilities. This plan defines a safe, test-guided approach to split those files into smaller, navigable modules **without creating duplicate code paths** and while preserving DagNet's architectural constraints (services own logic; UI owns composition).

This document is intended to be the **single source of truth** for the slimdown work. Earlier refactor proposals for the same surface area have been archived under `docs/archive/refactor/` (see "Related documents").

---

### Revision History

- **15-Dec-25**: Initial plan created.
- **14-Jan-26**: Up-front decisions agreed; programme order and PR sequences defined.
- **13-Mar-26**: Full re-analysis. All targets re-inventoried (significant growth since Jan). New target added (`analysisEChartsService`). Responsibility clusters re-mapped against current code. Test runlists updated. Programme order revised.
- **16-Mar-26**: Target 6 (GraphCanvas) Phase A complete — 5 modules extracted (~1,399 lines), file reduced from 7,134 to 5,671 lines. Target 6 section rewritten with 4-phase decomposition plan: Phase A (pure function extraction, DONE), Phase B (custom hook extraction), Phase C (context menu consolidation + JSX sub-components), Phase D (explicit state machine, deferred). Full ref inventory (27 refs, 4 categories) and architectural constraints documented.
- **16-Mar-26**: Target 5 `getFromSourceDirect` decomposition proposal added. Typed intermediate representations (compiler-pass architecture) with 6 implementation phases. Structural analysis of why the 5K-line function resists normal decomposition (83 mutable locals, forking control flow, partial-success accumulation). Alternatives considered: FetchContext bag, strategy pattern, event sourcing, mechanical sub-extraction.
- **16-Mar-26**: Target 6 Phases B2–B4 and C1 completed, reducing GraphCanvas from 5,671 to 3,779 lines. Extracted hooks: `useEdgeRouting` (B2), `useEdgeConnection` (B3), `useCanvasCreation` (B4a), `useLassoSelection` (B4b), `useNodeDrag` (B4c). Extracted component: `CanvasContextMenus` (C1). Phase B4 was split into three focused hooks rather than the originally planned single `useCanvasInteraction`. Phase B1 (sync engine) investigation revealed an implicit state machine across ~10 guard refs; comprehensive design document produced at `docs/current/refactor/b1-sync-engine-design.md` merging original Phase B1 (extraction) and Phase D (state machine formalisation) into a guard API approach. Pre-work investigations resolved 5 open questions: confirmed 1 dead ref (`isInSlowPathRebuildRef`), 1 latent race condition bug (`isDraggingNodeRef` fast-path clear), 2 unnecessary defensive clears, and 1 redundant safety valve. 75-test baseline recorded green. Preparatory cleanup (5 spurious mutation removals) ready for implementation.

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
  - `graph-editor/src/services/analysisEChartsService.ts` — **3,378** (NEW — did not exist in Jan plan)
- **UI**
  - `graph-editor/src/components/GraphCanvas.tsx` — **5,671** (down from 7,134 after Phase A extraction; originally 5,500 in Jan)
  - `graph-editor/src/components/PropertiesPanel.tsx` — **3,667** (+849 / +30%)
  - `graph-editor/src/components/edges/ConversionEdge.tsx` — **2,955** (−137 / −4%)

Secondary candidates (only after the above are stable):

- `graph-editor/src/contexts/TabContext.tsx` — **3,043** (+328 / +12%)
- `graph-editor/src/components/editors/GraphEditor.tsx` — **2,451** (+207 / +9%)
- `graph-editor/src/components/QueryExpressionEditor.tsx` — **2,318** (+186 / +9%)

**Total primary target surface area: ~39,427 lines** (up from ~30,469 in Jan).

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
6. `GraphCanvas.tsx` [IN PROGRESS — reduced from 7,134 to 3,779 lines; Phases A, B2–B4, C1 complete; B1 (sync engine, ~1,790 lines) designed and ready for implementation]
7. `PropertiesPanel.tsx` [unchanged priority; grew 30% but CanvasAnalysisPropertiesSection is already self-contained]
8. `ConversionEdge.tsx` [unchanged; shrank slightly; existing helpers already extracted]
9. Secondary candidates (only after the above are stable)

---

### Work Breakdown by Target (Procedural PR Sequence)

For each target below, follow the same internal sequencing per Decision 3.

---

#### Target 1 — `analysisEChartsService.ts` (3,378 lines) — NEW

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

#### Target 5 — `dataOperationsService.ts` (10,333 → 713 lines — 93% reduction)

**Status: DOS-PR1 through DOS-PR8 COMPLETE (16-Mar-26)**

All planned extractions are done. The facade is now 713 lines containing only `getFromSource` (versioned orchestrator, ~280 lines), `batchGetFromSource` (~95 lines), `extractSheetsUpdateDataForEdge` (~165 lines), delegate properties, re-exports, and the singleton. Zero TypeScript errors.

**Extracted modules** (in `graph-editor/src/services/dataOperations/`):

| Module | Lines | Contents | PR |
|--------|-------|----------|----|
| `getFromSourceDirect.ts` | 5,025 | Core DAS fetch — the single largest function in the codebase | DOS-PR8 |
| `fileToGraphSync.ts` | 2,242 | GET paths: `getParameterFromFile`, `getCaseFromFile`, `getNodeFromFile` | DOS-PR5 |
| `evidenceForecastScalars.ts` | 861 | `addEvidenceAndForecastScalars` | DOS-PR4 |
| `graphToFileSync.ts` | 525 | PUT paths: `putParameterToFile`, `putCaseToFile`, `putNodeToFile` | DOS-PR5 |
| `querySignature.ts` | 351 | `computeQuerySignature`, `extractContextKeysFromConstraints` | DOS-PR2 |
| `asatQuerySupport.ts` | 281 | asat() historical query support | DOS-PR3 |
| `cacheManagement.ts` | 158 | `openConnectionSettings`, `openForecastingSettings`, `clearCache` | DOS-PR6 |
| `batchMode.ts` | 137 | Batch mode & toast management | DOS-PR1 |
| `logHelpers.ts` | 126 | Formatting helpers, `compileExcludeQuery` | DOS-PR1 |
| `types.ts` | 89 | Shared types (`CacheAnalysisResult`, `GetFromSourceResult`, etc.) | DOS-PR5/8 |
| `applyChanges.ts` | 86 | Field-path change applicator | DOS-PR5 |

##### Why `getFromSourceDirect` resists decomposition

The function is a single 5,025-line scope with **83 mutable `let` declarations** that thread through sequential phases. Each phase reads and mutates variables declared in earlier phases, creating an implicit dataflow graph invisible to the type system.

Three structural forces lock the code together:

1. **Sequential mutation of shared locals.** Variables like `queryPayload` (line 689, built across ~600 lines), `querySignature` (line 1751, consumed 2,000 lines later during cache write), and `updateData` (line 2442, accumulated across the entire DAS response) are written in one phase and read in a distant later phase. Extracting any single phase requires passing 10–15 inputs and producing 5–10 outputs — the extracted function signature becomes as hard to understand as the inline code.

2. **Forking control flow.** The function forks at line 310 into an `asat()` path (snapshot queries) vs the main window/cohort path. These share setup (connection resolution, edge lookup, DSL parsing) and teardown (graph update, file write, toast). Extracting one fork still requires passing the entire shared context.

3. **Partial-success accumulation.** Variables like `didPersistAnyGap`, `hadGapFailureAfterSomeSuccess`, `failedGapIndex` (lines 2584–2587) track partial success across a gap-fill loop. The error handling at the end needs to know what happened in every prior phase, creating long-range data dependencies.

**Why normal refactoring patterns fail here:**

- **Extract method**: each phase reads/writes 10–20 locals from the enclosing scope — massive parameter lists or a god-object
- **Strategy pattern**: the three modes (asat / window / cohort) share 80% of setup and teardown — separate strategies would duplicate more than they save
- **Pipeline/chain**: phases are not independent transforms — phase N mutates state that phase N+2 reads, skipping N+1 — it is a DAG, not a pipeline

##### Proposal: typed intermediate representations (compiler-pass architecture)

**Core insight**: the coupling between phases is *data*, not *control*. The 83 mutable `let` variables are really a set of intermediate representations being built up sequentially. Making them explicit as typed structs is the fundamental unlock.

A compiler does not have one function that lexes, parses, type-checks, and emits. Each pass produces a well-defined IR that the next pass consumes. The same architecture applies here.

**Proposed stage IRs and their contents:**

| Stage | IR name | Produced by | Consumed by | Approximate lines |
|-------|---------|-------------|-------------|-------------------|
| 0. Preamble | `FetchIntent` | Destructured from `options` + graph lookup | All subsequent stages | ~180 (lines 157–340) |
| 1. asat() fork | Early return (no IR) | — | — | ~195 (lines 308–505) |
| 2. Connection | `ResolvedConnection` | Connection resolution | Query building, DAS execution | ~175 (lines 506–680) |
| 3. Query | `QueryPlan` | DSL parsing, `buildDslFromEdge`, n_query construction | Cache analysis, DAS execution, signature | ~870 (lines 688–1560) |
| 4. Window/cache | `FetchPlan` | Incremental fetch, refetch policy, cache analysis | DAS execution loop | ~680 (lines 1620–2300) |
| 5. Execution | `ExecutionResult` | DAS runner, gap loop, per-gap persistence | Landing | ~1,500 (lines 2430–3930) |
| 6. Landing | `GetFromSourceResult` | Graph update, file write, toast, session log | Caller | ~1,095 (lines 3930–5025) |

**What each IR contains** (the mutable locals it replaces):

- **`FetchIntent`** — Immutable. The original request plus resolved entity references: `objectType`, `objectId`, `targetId`, `graph`, `setGraph`, `paramSlot`, `conditionalIndex`, `writeToFile`, `bustCache`, `currentDSL`, `targetSlice`, `logOpId`, `retrievalBatchAt`, `retrievalBatchAtISO`, `sliceDSLForLog`, `sliceDimensionsForLog`, `sliceLabelForLog`, `entityLabel`, `targetEntity`, `errorResult`, `fetchStats` (initial), `warnIfQueryIntentDropped`, `shouldThrowForAtomicityRateLimit`.

- **`ResolvedConnection`** — `connectionName`, `connectionString`. Plus the resolved persisted config source (graph vs file) so downstream phases know provenance.

- **`QueryPlan`** — `queryPayload`, `eventDefinitions`, `connectionProvider`, `supportsDailyTimeSeries`, `signatureContextKeys`, `edgeForQuerySignature`, `baseQueryPayload` (for dual-query / n_query), `needsDualQuery`, `explicitNQuery`, `nQueryString`, `nQueryIsComposite`, `explicitNQueryWasToOnlyNormalForm`, `explicitNQueryWindowDenomUsesFromCount`, `connectionSupportsNativeVisited`. This is the densest IR — it replaces 15+ mutable locals from the query-building phase.

- **`FetchPlan`** — `requestedWindow`, `requestedCohort`, `actualFetchWindows`, `querySignature`, `shouldSkipFetch`, `refetchPolicy`, `isCohortQuery`, `shouldCheckIncrementalFetch`, `hasOverrideWindows`. Plus the cache analysis callback result.

- **`ExecutionResult`** — `allTimeSeriesData`, `updateData`, `lastResultRaw`, `lastOnsetDeltaDays`, `queryParamsForStorage`, `fullQueryForStorage`, `isComposite`, `queryString`, `didAttemptExternalFetch`, `expectedDaysAttempted`, `didPersistAnyGap`, `hadGapFailureAfterSomeSuccess`, `gapFailureMessage`, `failedGapIndex`, `fetchStats` (final).

- **`GetFromSourceResult`** — Already exists as the return type. No new IR needed.

**The orchestrator becomes ~80 lines:**

The top-level `getFromSourceDirect` function becomes a thin sequencer: construct `FetchIntent`, call each stage function, pass the IR forward, return the result. Each stage function lives in its own file under `dataOperations/pipeline/`. The orchestrator is small enough to read in one screen — you can see the full pipeline at a glance.

**What this approach preserves:**

- **Frozen semantics**: each stage function contains the exact same code that exists today, just wrapped in a function that receives the previous IR and returns the next IR. No logic changes.
- **Error handling**: the top-level try/catch remains in the orchestrator. Stage functions throw on error (same as today). Partial-success state lives in `ExecutionResult`, not in function-scoped `let` variables.
- **Session logging**: `logOpId` travels through `FetchIntent`, so all stages can log children to the same operation.
- **Dynamic imports**: remain where they are (inside stage functions), not hoisted.

**What this approach changes:**

- The 83 mutable `let` declarations become fields on 5 typed interfaces. This is a structural change, not a behavioural one, but it touches nearly every line.
- Each stage function has a clearly typed input and output. You cannot accidentally read `querySignature` before it has been computed — the type system enforces stage ordering.
- Individual stages become independently testable: construct a `QueryPlan` directly and test execution without running the entire pipeline.

**Advantages over the `FetchContext` bag:**

The earlier slimdown doc proposed a single `FetchContext` state object to replace the mutable locals. Per-stage IRs are strictly better because:

- A single bag does not enforce ordering — any field is accessible at any point, so you lose the compiler-pass guarantee that data flows forward only
- Per-stage IRs are self-documenting — reading `FetchPlan` tells you exactly what cache analysis produces, without reading 700 lines
- Stage boundaries become natural file boundaries, which is the goal of the slimdown

##### Risks and mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Large blast radius — touching every line in a 5K-line function | High | Incremental approach: extract one stage at a time, starting from the edges (asat fork, then landing, then connection resolution). Each extraction is a self-contained PR. |
| Regression in DAS fetch behaviour | High | 18 existing test files (listed below) provide dense coverage of the pipeline. Run the full test list after each stage extraction. |
| IR types become stale or drift from reality | Medium | IRs are derived mechanically from the current `let` declarations — no invention required. Each field maps 1:1 to an existing mutable local. |
| Over-abstraction — premature generalisation of stages | Low | Rule: each IR field must correspond to an existing variable. No new fields, no computed properties, no methods on IRs. IRs are plain data objects. |
| `asat()` fork shares too much context with main path | Low | The asat fork (lines 308–505) is already a self-contained early return. It only reads from `FetchIntent` — it does not need any downstream IR. This is the safest first extraction. |

##### Implementation sequence

**Phase 1 — Define IR types + extract asat fork** (lowest risk)
- Create `dataOperations/pipeline/types.ts` with `FetchIntent`, `ResolvedConnection`, `QueryPlan`, `FetchPlan`, `ExecutionResult` interfaces
- Extract asat fork (lines 308–505) into `dataOperations/pipeline/asatFork.ts` — takes `FetchIntent`, returns `GetFromSourceResult | null` (null = continue to main path)
- Orchestrator calls `asatFork(intent)` and returns early if non-null
- Run full test list

**Phase 2 — Extract connection resolution + query building**
- Extract lines 506–680 into `resolveConnection.ts` — takes `FetchIntent`, returns `ResolvedConnection`
- Extract lines 688–1560 into `buildQueryPlan.ts` — takes `FetchIntent` + `ResolvedConnection`, returns `QueryPlan`
- Orchestrator now reads: `intent → asatFork → resolveConnection → buildQueryPlan`
- Run full test list

**Phase 3 — Extract window/cache analysis**
- Extract lines 1620–2300 into `buildFetchPlan.ts` — takes `FetchIntent` + `QueryPlan`, returns `FetchPlan`
- This includes incremental fetch calculation, refetch policy, cache analysis callback, query signature computation
- Run full test list

**Phase 4 — Extract DAS execution loop**
- Extract lines 2430–3930 into `executeFetch.ts` — takes `FetchIntent` + `ResolvedConnection` + `QueryPlan` + `FetchPlan`, returns `ExecutionResult`
- This is the largest and most complex stage — includes the gap loop, per-gap persistence, composite query detection, DAS runner invocation
- Run full test list

**Phase 5 — Extract landing (graph update + file write)**
- Extract lines 3930–5025 into `landResult.ts` — takes `FetchIntent` + `ExecutionResult` + `QueryPlan`, returns `GetFromSourceResult`
- This includes the parameter graph update path, case graph update path, conditional_p handling, final toast/logging
- Run full test list

**Phase 6 — Collapse orchestrator**
- At this point `getFromSourceDirect.ts` should be ~80–120 lines: destructure options into `FetchIntent`, call each stage, return result
- Delete the original 5K-line function body
- Final full test run

Each phase is a single PR. Each PR can be reviewed independently. If any phase reveals unexpected coupling, the work can be paused without leaving the codebase in an inconsistent state — the orchestrator always delegates to the same code, whether it lives inline or in a stage file.

##### Alternatives considered and rejected

**Single `FetchContext` bag** — does not enforce stage ordering; any field accessible at any point; does not create natural file boundaries. This is the degenerate case of the pipeline approach with all IRs collapsed into one type.

**Strategy pattern (mode-first dispatch)** — three mode executors (asat / window / cohort) sharing preparation and teardown. This separates the mode dimension but not the phase dimension. The window and cohort paths share 90%+ of their code (query building, cache analysis, DAS execution); splitting by mode would duplicate 4,000+ lines.

**Event-sourced fetch** — model the pipeline as a sequence of domain events with a reducer. Elegant for partial-success tracking but over-engineered for a graph editor. The existing try/catch + error propagation pattern is simpler and well-tested.

**Mechanical sub-extraction only** (asat fork + connection resolution + n_query construction as standalone functions) — this was the "low-risk" option in the previous plan. It removes ~920 lines but leaves a 4,100-line function with 60+ mutable locals. The structural problem remains unsolved — it just gets marginally smaller.

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
- `graph-editor/src/services/__tests__/dataOperationsService.asatSignatureSelection.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.asatSliceMatching.test.ts`
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
- `graph-editor/src/services/__tests__/versionedFetchFlow.e2e.test.ts`

---

#### Target 6 — `GraphCanvas.tsx` (3,779 lines; originally 7,134 lines)

**Architectural context:**

GraphCanvas is a monolithic React component that owns the ReactFlow canvas, bidirectional graph↔ReactFlow sync, all canvas interaction handlers, and the JSX render tree.

The bidirectional sync engine (graph→ReactFlow and ReactFlow→graph reconciliation) is essential complexity, not accidental — graph mutations originate from many locations outside the canvas (PropertiesPanel, data operations, UpdateManager, clipboard, etc.), so the sync must exist. This constraint rules out "controlled ReactFlow" as a simplification strategy.

The decomposition is structured as **encapsulation without architectural change**: custom hooks, JSX sub-components, state consolidation, and a guard API for the sync engine state machine.

**Extraction directory:** `graph-editor/src/components/canvas/` (existing directory)

**Phase A — Pure function extraction (COMPLETE, 16-Mar-26)**

Extracted into standalone modules:
- `canvas/GraphIssuesIndicatorOverlay.tsx` (148 lines) — self-contained sub-component
- `canvas/edgeGeometry.ts` (388 lines) — `getEdgeSortKey()`, `calculateEdgeOffsets()`
- `canvas/layoutAlgorithms.ts` (282 lines) — `computeDagreLayout()`, `computeSankeyLayout()`
- `canvas/creationTools.ts` (269 lines) — `createNodeInGraph()`, `createNodeFromFileInGraph()`, `createPostitInGraph()`, `createContainerInGraph()`, `createCanvasAnalysisInGraph()`, `buildAddChartPayload()`
- `canvas/pathHighlighting.ts` (312 lines) — `findAllPaths()`, `topologicalSort()`, `findPathEdges()`, `computeHighlightMetadata()`, `wouldCreateCycle()`

Total extracted: ~1,399 lines. GraphCanvas reduced from 7,134 to 5,671 lines. All 18 relevant tests passing. TypeScript clean.

**Phase B — Custom hook extraction (MOSTLY COMPLETE)**

Extract cohesive groups of state + effects + callbacks into custom hooks. Each hook encapsulates its own refs, state, and effects. GraphCanvas becomes a composition root that wires hooks together.

- **GC-B1 (sync engine hook)**: IN PROGRESS — see below. This is the single biggest remaining extraction (~1,790 lines). Full design document at `docs/current/refactor/b1-sync-engine-design.md`.

- **GC-B2 (edge routing hook)**: COMPLETE. Extracted into `canvas/useEdgeRouting.ts`. Owns: `skipNextRerouteRef`, reroute scheduling/debouncing, `performReroute()` logic, Sankey offset application. Returns `{ scheduleReroute, performReroute, setForceReroute }`.

- **GC-B3 (edge connection hook)**: COMPLETE. Extracted into `canvas/useEdgeConnection.ts`. Owns: `onConnect`, `onConnectStart`, `onConnectEnd`, connection validation, cycle detection (calls `wouldCreateCycle` from pathHighlighting). Returns the three ReactFlow connection handler callbacks.

- **GC-B4a (canvas creation hook)**: COMPLETE. Extracted into `canvas/useCanvasCreation.ts`. Owns creation tool wrappers over the extracted pure functions in `creationTools.ts`.

- **GC-B4b (lasso selection hook)**: COMPLETE. Extracted into `canvas/useLassoSelection.ts`. Owns lasso selection state and DOM event handling.

- **GC-B4c (node drag hook)**: COMPLETE. Extracted into `canvas/useNodeDrag.ts`. Owns `isDraggingNodeRef`, `hasNodeMovedRef`, drag start/stop handlers, and snap-to-guide integration.

Note: The originally planned single "GC-B4 (useCanvasInteraction)" hook was split into three focused hooks (B4a–c) during implementation, as the responsibilities were sufficiently distinct.

**Phase B1 — Sync engine extraction + guard formalisation (HIGH RISK, DESIGNED)**

**Design document:** `docs/current/refactor/b1-sync-engine-design.md`

This phase merges the original Phase B1 (sync engine extraction) and Phase D (state machine formalisation). A mechanical extraction without formalisation would just relocate the problem — the implicit state machine would be equally opaque in a new file.

**Current state:** Pre-work investigations complete. The ~10 guard refs form an implicit mutual exclusion protocol with no documented transition table and 5 different setTimeout delay values. Investigation confirmed:
- `isInSlowPathRebuildRef` is **dead code** (never set to true)
- Fast-path `isDraggingNodeRef` setTimeout(0) clear is a **latent race condition bug**
- Edge scaling `isSyncingRef` defensive clear is **unnecessary**
- `handleDeleteNode`/`handleDeleteEdge` `isSyncingRef` clears are **redundant**

**Proposed approach:** Guard API — named transition functions (`guards.beginSync()`, `guards.endInteraction('drag')`, etc.) that centralise all guard state in one place with single-owner semantics. This replaces the original Phase D proposal (discriminated union for all flags) with a more incremental approach that preserves the existing independent-flag semantics while adding a formal API boundary. The discriminated union remains a possible future refinement once the guard API is stable.

**Implementation sequence:**
1. Preparatory cleanup — remove 5 spurious mutations (dead code, latent bug, redundant clears), tested individually
2. Sub-phase 1 — create guard API module (`canvas/syncGuards.ts`), replace raw ref mutations one by one
3. Sub-phase 2 — extract 9 effects + refs into `canvas/useGraphSync.ts`
4. Sub-phase 3 — clean up cross-boundary ref access, wire external callers to guard API

**Estimated result after B1:** GraphCanvas drops from ~3,779 to ~1,989 lines.

**Stop/gates for B1:**
- After preparatory cleanup: user performs manual smoke test (section 4.7 of design doc)
- After Sub-phase 1: every guard ref mutated only through guard API; dev-mode warnings for illegal transitions
- After Sub-phase 2: dependency arrays verified unchanged; no render loops; core tests green
- After Sub-phase 3: no code outside hook directly reads/writes guard refs

**Phase C — Context menu consolidation + JSX sub-components (PARTIALLY COMPLETE)**

- **GC-C1 (context menus)**: COMPLETE. Context menu state consolidated and JSX rendering extracted into `canvas/CanvasContextMenus.tsx`.

- **GC-C2 (JSX sub-components)**: NOT STARTED. Extract distinct regions of the render tree into sub-components that receive props from GraphCanvas:
  - `canvas/CanvasToolbar.tsx` — toolbar region
  - `canvas/CanvasMinimap.tsx` — minimap + panel overlays
  - `canvas/CanvasDialogs.tsx` — modal dialogs (add chart, confirmations)
  These are presentational extractions — they receive props/callbacks and render JSX. No state ownership changes.

**Stop/gates for C2:**
- After GC-C2: confirm toolbar, minimap, and dialog rendering is visually identical.

**Estimated result after all phases:** GraphCanvas drops to ~1,200–1,500 lines — essentially a composition root that instantiates hooks, wires them together, and renders ReactFlow with sub-components.

**Phase D — MERGED INTO B1 (see above)**

The original Phase D (explicit state machine for sync guards) has been merged into Phase B1. The investigation work that was originally deferred "until Phase B is stable" was completed during B1 design. The guard API approach is more incremental than the originally proposed discriminated union and serves as a prerequisite for any future state machine refinement.

**Core tests (all phases):**
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
- **[UPDATED] Graph↔ReactFlow sync engine** — Mitigation: extract into `useGraphSync` hook with guard API (`syncGuards.ts`). Phases B1 and D merged — guard formalisation happens during extraction, not after. Pre-work investigations complete: 1 dead ref, 1 latent bug, 2 unnecessary defensive clears identified and queued for removal before extraction begins. Full design at `docs/current/refactor/b1-sync-engine-design.md`. 75-test baseline green.
- **[NEW] Implicit sync guard state machine** — 8 boolean refs form an undeclared mutual exclusion protocol. Converting to an explicit typed state machine (Phase D) requires mapping all transitions and confirming interleaved effects are handled. Deferred until the refs are co-located within `useGraphToReactFlowSync` (Phase B).

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
