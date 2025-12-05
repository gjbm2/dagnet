## Project LAG: Core Latency Implementation Plan (New)

**Status:** Draft planning document  
**Based on:** `design.md`, `open-issues.md`, `implementation.md`, `implementation-open-issues.md`  
**Scope:** Core delivery phases (C1–C4 in `design.md §10`), limited to the latency-aware probability model and graph UI; excludes analytics extensions and Bayesian enhancements (covered in separate new implementation docs).

This document is a prose-only implementation plan. It describes what to change, where, and in which phase, and it enumerates the code files touched by the Project LAG design. All detailed algorithms, formulas, and semantics are defined in `design.md` and the linked architecture docs.

---

## 1. Phase C1 – Schema, Types, and Global Renames

**Goal:** Align all type systems (TypeScript, JSON/YAML schemas, Python) and core data surfaces with the latency model and the `labour_cost` naming, as specified in `design.md §3` and `open-issues.md §Code Impact Analysis`.

### 1.1 Global rename `cost_time` → `labour_cost`

**Design reference:** `design.md §3.3`, `open-issues.md GAP-7` and subsequent decisions.

**Behavioural goal:** Treat `labour_cost` as the human effort parameter and reserve `latency` for calendar-time effects. The rename is intended to be exact and global across the app and tests.

**Code files touched by the rename (current usages identified):**

- **Docs and design artefacts**
  - `docs/current/project-lag/implementation-open-issues.md`
  - `docs/current/project-lag/implementation.md`
  - `docs/current/project-lag/design.md`
  - `docs/current/project-lag/implementation-plan.md`
  - `docs/current/CONDITIONAL_PROBABILITY_ARCHITECTURE.md`
  - `docs/current/data-retrieval-detailed-flow.md`
  - `docs/current/data-fetch-architecture.md`
  - `docs/current/data-fetch-refactoring-proposal.md`
  - `docs/current/ANALYTICS_IMPLEMENTATION_STATUS.md`
  - `docs/current/project-analysis/ANALYTICS_IMPLEMENTATION_STATUS.md`
  - `docs/current/project-contexts/ANALYSIS_RETURN_SCHEMA.md`

- **Sample and registry data**
  - `param-registry/test/parameters/phone-order-duration.yaml`
  - `param-registry/test/graphs/ecommerce-checkout-flow.json`
  - `param-registry/test/parameters-index.yaml`

- **TypeScript core types and schemas**
  - `graph-editor/src/types/index.ts`
  - `graph-editor/src/types/scenarios.ts`
  - `graph-editor/public/param-schemas/parameter-schema.yaml`
  - `graph-editor/public/param-schemas/registry-schema.yaml`
  - `graph-editor/public/schemas/conversion-graph-1.0.0.json`
  - `graph-editor/public/schemas/conversion-graph-1.1.0.json`

- **Services and data flow (TS)**
  - `graph-editor/src/services/fetchDataService.ts`
  - `graph-editor/src/services/integrityCheckService.ts`
  - `graph-editor/src/services/queryRegenerationService.ts`
  - `graph-editor/src/services/dataOperationsService.ts`
  - `graph-editor/src/services/paramRegistryService.ts`
  - `graph-editor/src/services/UpdateManager.ts`
  - `graph-editor/src/services/GraphParamExtractor.ts`
  - `graph-editor/src/services/fileOperationsService.ts`
  - `graph-editor/src/services/whereUsedService.ts`
  - `graph-editor/src/services/graphIssuesService.ts`
  - `graph-editor/src/services/CompositionService.ts`
  - `graph-editor/src/services/ScenarioValidator.ts`
  - `graph-editor/src/services/DiffService.ts`

- **React components and UI surfaces (TSX/CSS)**
  - `graph-editor/src/components/modals/AllSlicesModal.tsx`
  - `graph-editor/src/components/edges/ConversionEdge.tsx`
  - `graph-editor/src/components/WindowSelector.tsx`
  - `graph-editor/src/components/PropertiesPanel.tsx`
  - `graph-editor/src/components/GraphCanvas.tsx`
  - `graph-editor/src/components/LightningMenu.tsx`
  - `graph-editor/src/components/Navigator/NavigatorContent.tsx`
  - `graph-editor/src/components/Navigator/ObjectTypeSection.tsx`
  - `graph-editor/src/components/modals/BatchOperationsModal.tsx`
  - `graph-editor/src/components/EdgeContextMenu.tsx`
  - `graph-editor/src/components/EnhancedSelector.tsx`
  - `graph-editor/src/components/DataOperationsMenu.tsx`
  - `graph-editor/src/components/DataOperationsSections.tsx`
  - `graph-editor/src/components/ParameterSelector.tsx`
  - `graph-editor/src/components/NewFileModal.tsx`
  - `graph-editor/src/components/ParameterSection.tsx`
  - `graph-editor/src/components/edges/EdgeBeads.tsx`
  - `graph-editor/src/components/edges/edgeBeadHelpers.tsx`
  - `graph-editor/src/components/edges/edgeLabelHelpers.tsx`
  - `graph-editor/src/components/edges/BEAD_LABEL_BUILDER_README.md`

- **Hooks and utilities (TS)**
  - `graph-editor/src/hooks/useRemoveOverrides.ts`

- **Client-side graph / runner glue (TS)**
  - `graph-editor/src/lib/transform.ts`

- **Python models, selection, and runners**
  - `graph-editor/lib/msmdc.py`
  - `graph-editor/lib/graph_types.py`
  - `graph-editor/lib/api_handlers.py`
  - `graph-editor/lib/runner/runners.py`
  - `graph-editor/lib/runner/graph_builder.py`
  - `graph-editor/lib/runner/path_runner.py`

- **Tests (TS / TSX)**
  - `graph-editor/src/services/__tests__/dataOperations.integration.test.ts`
  - `graph-editor/src/services/__tests__/schemaTypesConsistency.test.ts`
  - `graph-editor/src/services/__tests__/schemaTypescriptParity.test.ts`
  - `graph-editor/src/services/__tests__/sampleDataIntegrity.test.ts`
  - `graph-editor/src/services/__tests__/sampleFilesIntegrity.test.ts`
  - `graph-editor/src/services/__tests__/provenance.test.ts`
  - `graph-editor/src/services/__tests__/idPreservation.test.ts`
  - `graph-editor/src/services/__tests__/UpdateManager.graphToGraph.test.ts`
  - `graph-editor/src/services/__tests__/fetchDataService.test.ts`
  - `graph-editor/src/services/__tests__/fileOperations.integration.test.ts`
  - `graph-editor/src/services/__tests__/edgeReconnection.test.ts`
  - `graph-editor/src/hooks/__tests__/useRemoveOverrides.test.ts`
  - `graph-editor/src/components/__tests__/EnhancedSelector.autoGet.test.ts`
  - `graph-editor/src/components/__tests__/WindowSelector.autoAggregation.test.ts`
  - `graph-editor/src/components/edges/__tests__/EdgeBeads.test.tsx`
  - `graph-editor/tests/pipeline-integrity/simple-query-flow.test.ts`
  - `graph-editor/tests/test_msmdc.py`
  - `graph-editor/tests/test_runners.py`

For this rename, the implementation should follow the usual pattern from earlier migrations: update TS types and schemas first, then Python models, then services/UI, and finally tests and sample data, keeping schema–type parity tests green (`schemaTypescriptParity`, `schemaTypesConsistency`) as the guardrails.

### 1.2 Latency configuration on edges (TS and Python)

**Design reference:** `design.md §3.1`, `design.md §9.2.H`, `open-issues.md §DATA ARCHITECTURE`.

**Intent:** Introduce a latency configuration object on edges, with fields such as `track`, `maturity_days`, `censor_days`, and `anchor_node_id`. These are configuration-level fields (not per-scenario) and must be present consistently across TS types, JSON schemas, and Python models.

**Code files touched:**

- TypeScript types
  - `graph-editor/src/types/index.ts` (edge types, probability param types, latency config type)
  - `graph-editor/src/types/scenarios.ts` (scenario `EdgeParamDiff` structure for latency-related render fields)

- JSON graph schema
  - `graph-editor/public/schemas/conversion-graph-1.1.0.json` (baseline)
  - New version: `graph-editor/public/schemas/conversion-graph-1.2.0.json` to include latency fields, as outlined in `open-issues.md §Design Decisions Made`

- Python models and topology tools
  - `graph-editor/lib/graph_types.py` (Edge model: add latency configuration fields)
  - `graph-editor/lib/msmdc.py` (MSMDC output: include `anchor_node_id` and related latency metadata)

- Schema parity tests
  - `graph-editor/src/services/__tests__/schemaTypescriptParity.test.ts`
  - `graph-editor/src/services/__tests__/schemaTypesConsistency.test.ts`
  - `graph-editor/src/services/__tests__/sampleDataIntegrity.test.ts`
  - `graph-editor/src/services/__tests__/sampleFilesIntegrity.test.ts`

Implementation work here is purely structural: introduce the latency-related fields and ensure that schema, TS types, and Python models are coherent, deferring all behavioural logic to later phases.

### 1.3 Parameter schema and UI schema for latency slices

**Design reference:** `design.md §3.2–3.4`, `open-issues.md GAP-12`.

**Intent:** Extend parameter files so they can store cohort-aware data, latency summaries, and canonical slice labels, while keeping with the existing flat-array pattern.

**Code files touched:**

- YAML parameter schema and registry
  - `graph-editor/public/param-schemas/parameter-schema.yaml`  
    (new fields for cohort bounds, latency arrays, latency summary blocks, and canonical `sliceDSL`)
  - `graph-editor/public/param-schemas/registry-schema.yaml`  
    (ensure any references to parameter types account for added latency fields where relevant)

- Parameter UI schema
  - `graph-editor/public/ui-schemas/parameter-ui-schema.json`  
    (expose new latency and anchor blocks as editable sections, even if they are typically machine-generated)

- Sample data and integrity tests
  - Sample parameter files in `graph-editor/public/project-data/` (if any include `cost_time` or need latency fields)
  - `graph-editor/src/services/__tests__/sampleDataIntegrity.test.ts`
  - `graph-editor/src/services/__tests__/sampleFilesIntegrity.test.ts`

The implementation here is to wire in the new fields as per `design.md §3.2–3.4`, without adding any new behaviours beyond what is already described in those sections.

### 1.4 UpdateManager and integrity checks

**Design reference:** `design.md §9.2.G`, `open-issues.md GAP-13`, `open-issues.md DATA ARCHITECTURE`.

**Intent:** Ensure that latency configuration, evidence, and forecast fields flow correctly between graph edges and parameter files, and that invalid configurations are caught early.

**Code files touched:**

- Mapping and sync logic
  - `graph-editor/src/services/UpdateManager.ts`  
    (add mappings for `latency.*`, `p.forecast.*`, `p.evidence.*`, and derived display-only fields)

- Integrity checks
  - `graph-editor/src/services/integrityCheckService.ts`  
    (validate latency config: non-negative or positive `maturity_days`, bounded completeness, anchor presence, etc., as per design decisions)

- Issues reporting
  - `graph-editor/src/services/graphIssuesService.ts`  
    (surface latency-related configuration problems alongside existing graph issues)

These changes are mechanical applications of the mapping and validation patterns described in `open-issues.md`, not new design work.

---

## 2. Phase C2 – DSL and Query Architecture

**Goal:** Support `cohort()` alongside `window()`, construct the right DAS payloads for latency edges (including superfunnels), and propagate cohort/window mode from the UI down to the data layer, as described in `design.md §4` and `CONDITIONAL_PROBABILITY_ARCHITECTURE.md`.

### 2.1 TypeScript DSL parsing and construction

**Design reference:** `design.md §4.1–4.3`, `open-issues.md GAP-10–GAP-11`.

**Code files touched:**

- DSL parsing, normalisation, and explosion
  - `graph-editor/src/lib/queryDSL.ts`  
    (support `cohort()` parsing, canonicalisation, and constraint representation)
  - `graph-editor/src/lib/dslConstruction.ts`  
    (construct DSL fragments from graph selections, including cohort vs window choice)
  - `graph-editor/src/lib/dslExplosion.ts`  
    (ensure `cohort()` clauses participate correctly in slice explosion)

- DAS runner glue
  - `graph-editor/src/lib/das/DASRunner.ts`  
    (extend the query payload shape to carry cohort constraints and superfunnel information)
  - `graph-editor/src/lib/das/buildDslFromEdge.ts`  
    (default to cohort mode for latency-tracked edges, build superfunnels for A–X–Y as per design, and honour anchor configuration)

- Client–Python interface
  - `graph-editor/src/lib/graphComputeClient.ts`  
    (update `ParameterQuery` shape to include latency and anchor information where needed)

- Tests
  - `graph-editor/src/lib/__tests__/queryDSL.test.ts` (or nearest equivalent)
  - `graph-editor/src/lib/__tests__/dslExplosion.test.ts` (or nearest equivalent)
  - Any related tests named in `design.md §10.1.A–B`

The implementation work is to express the already-specified `cohort()` semantics in the TypeScript DSL tooling, exactly as laid out in the design.

### 2.2 Python DSL and MSMDC alignment

**Design reference:** `design.md §4.7`, `open-issues.md GAP-18`, `DATA_RETRIEVAL_QUERIES.md`.

**Code files touched:**

- Python DSL parsing and normalisation
  - `graph-editor/lib/query_dsl.py`  
    (ensure parity with the TS DSL for `cohort()`, including canonicalisation and validation)

- MSMDC generation and anchor computation
  - `graph-editor/lib/msmdc.py`  
    (compute `anchor_node_id` for all edges, extend `ParameterQuery` payloads for latency edges)

- Python tests
  - `graph-editor/tests/test_msmdc.py`
  - Any other DSL-related tests in `graph-editor/lib/tests/`

Here the work is strictly to bring the Python side into alignment with the DSL semantics and data fields already specified in `design.md` and the TS-side changes.

### 2.3 Connections and adapter scripts

**Design reference:** `design.md §4.4–4.6`, `design.md Appendix B`, `open-issues.md GAP-18`.

**Code files touched:**

- Amplitude connection defaults and adapter
  - `graph-editor/public/defaults/connections.yaml`  
    (extend the Amplitude adapter pre-request logic for cohort vs window modes, superfunnels, and latency-related extracts; update default parameters such as conversion window length; extract the additional latency-related fields from responses)

- Query expressions documentation
  - `graph-editor/public/docs/query-expressions.md`  
    (document `cohort()` semantics, canonical slice labels, and the interaction with latency tracking)

The adapter and documentation changes follow the concrete behaviours defined in the design; no new semantics are introduced here.

### 2.4 UI propagation of cohort/window mode

**Design reference:** `design.md §7.5`, `open-issues.md GAP-2`, `ANALYTICS_IMPLEMENTATION_STATUS.md` where relevant.

**Code files touched:**

- Mode selection and display
  - `graph-editor/src/components/WindowSelector.tsx`  
    (implement cohort/window mode dropdown, icon changes, and correct propagation of the chosen mode into the DSL construction path)
  - `graph-editor/src/components/modals/PinnedQueryModal.tsx`  
    (ensure pinned queries can represent cohort vs window mode explicitly)
  - `graph-editor/src/components/editors/GraphEditor.tsx`  
    (wire the window selector into the editor, including any defaulting to cohort mode)

- View preferences and state
  - `graph-editor/src/contexts/ViewPreferencesContext.tsx`  
    (persist per-tab cohort/window mode preferences where appropriate)
  - `graph-editor/src/contexts/GraphStoreContext.tsx`  
    (ensure that state passed to data fetching includes the selected mode)

- Fetch flow glue and tests
  - `graph-editor/src/hooks/useFetchData.ts`
  - `graph-editor/src/services/fetchDataService.ts`
  - `graph-editor/src/services/__tests__/versionedFetchFlow.e2e.test.ts`
  - `graph-editor/src/services/__tests__/multiSliceCache.e2e.test.ts`
  - `graph-editor/src/services/__tests__/versionedFetch.integration.test.ts`
  - `graph-editor/src/services/__tests__/contextPassthrough.e2e.test.ts`
  - `graph-editor/src/services/__tests__/fullE2EMultiSlice.integration.test.tsx`
  - `graph-editor/src/services/__tests__/fetchButtonE2E.integration.test.tsx`
  - `graph-editor/src/components/__tests__/WindowSelector.autoAggregation.test.ts`
  - `graph-editor/src/components/__tests__/WindowSelector.coverage.test.ts`

The purpose of this phase is to ensure that when the user chooses cohort or window mode in the UI, the same intent flows through to the DAS payloads, matching the design’s examples.

---

## 3. Phase C3 – Data Retrieval, Storage, Aggregation, and Inference

**Goal:** Fetch latency-aware data from Amplitude (and other sources if relevant), store it in the extended parameter schema, and compute the mature/immature split and blended probabilities, as per `design.md §3`, `design.md §4.6–4.8`, and `design.md §5.0`.

### 3.1 Data operations and statistical enhancement (TS services)

**Design reference:** `design.md §4.7–4.8`, `design.md §5.0`, `DATA_RETRIEVAL_QUERIES.md`, `data-fetch-architecture.md`.

**Code files touched:**

- Data orchestration
  - `graph-editor/src/services/dataOperationsService.ts`  
    (extend get-from-source and transform flows to handle cohort-mode responses, latency arrays, and retrieval-time computation of forecast statistics)
  - `graph-editor/src/services/paramRegistryService.ts`  
    (store and merge extended slices, respect new cache and merge policies for latency edges)
  - `graph-editor/src/services/timeSeriesUtils.ts`  
    (reuse or extend time-series helpers where they intersect with cohort-aware windows)

- Aggregation and forecasting
  - `graph-editor/src/services/windowAggregationService.ts`  
    (implement cohort-aware aggregation, mature/immature split, completeness metric, and the blended probability policies from the design)
  - `graph-editor/src/services/statisticalEnhancementService.ts`  
    (coordinate higher-level statistical enhancements around the new latency evidence and forecasts)

- Tests
  - `graph-editor/src/services/__tests__/dataOperations.integration.test.ts`
  - `graph-editor/src/services/__tests__/statisticalEnhancementService.test.ts`
  - `graph-editor/src/services/__tests__/multiSliceCache.e2e.test.ts`
  - `graph-editor/src/services/__tests__/fullE2EMultiSlice.integration.test.tsx`
  - Any additional tests called out in `design.md §10.1.C–E`

The core requirement is that the implementation reflects the evidence/forecast separation, completeness metrics, and retrieval-time versus query-time computation split described in the design documents.

### 3.2 Parameter storage and slice lifecycle

**Design reference:** `design.md §3.2–3.5`, `design.md §4.7`, `data-retrieval-detailed-flow.md`.

**Code files touched:**

- Slice storage and merge
  - `graph-editor/src/services/paramRegistryService.ts`
  - `graph-editor/src/services/sliceIsolation.ts`

- Evidence and provenance
  - `graph-editor/src/services/GraphParamExtractor.ts`
  - `graph-editor/src/services/provenance.test.ts` (existing test)

The changes are to ensure that latency-related fields are persisted and merged according to the canonical slice rules and maturity-aware cache policies from the design.

### 3.3 Python data retrieval and enhancement

**Design reference:** `design.md Appendix A–B`, `stats_enhancement.py` design notes, `DATA_RETRIEVAL_QUERIES.md`.

**Code files touched:**

- API handlers and retrieval paths
  - `graph-editor/lib/api_handlers.py`

- Statistical enhancement utilities
  - `graph-editor/lib/stats_enhancement.py`

- Tests
  - `graph-editor/lib/tests/` (relevant files exercising Amplitude-like responses and latency extraction)

The Python-side changes are to mirror the additional latency fields and statistics captured during retrieval, in line with the behaviour defined in the design.

---

## 4. Phase C4 – Rendering, UI Interaction, and Scenario Controls

**Goal:** Expose latency-aware probabilities and completeness visually on the graph, allow per-scenario control over evidence vs forecast display, and surface latency configuration in the properties panel, as specified in `design.md §7` and `open-issues.md (Per-scenario visibility, Properties Panel UI, Edge tooltips)`.

### 4.1 Edge rendering and beads

**Design reference:** `design.md §7.1–7.4`, `open-issues.md GAP-3`, `GAP-8`.

**Code files touched:**

- Edge rendering and styling
  - `graph-editor/src/components/edges/ConversionEdge.tsx`
  - `graph-editor/src/components/edges/EdgeBeads.tsx`
  - `graph-editor/src/components/edges/edgeBeadHelpers.tsx`
  - `graph-editor/src/components/edges/edgeLabelHelpers.tsx`
  - `graph-editor/src/lib/nodeEdgeConstants.ts`

- Graph canvas and overlays
  - `graph-editor/src/components/GraphCanvas.tsx`
  - `graph-editor/src/components/ScenarioOverlayRenderer.tsx`

- Tests
  - `graph-editor/src/components/edges/__tests__/EdgeBeads.test.tsx`

In this phase, the implementation should map the evidence/forecast/mean and completeness values coming from the services into the inner and outer edge layers, bead content, and any related styling, following the visual semantics in the design.

### 4.2 Properties panel and latency configuration UI

**Design reference:** `design.md §7.7`, `open-issues.md GAP-9`, `Properties Panel Latency UI` section in `open-issues.md`.

**Code files touched:**

- Properties panel
  - `graph-editor/src/components/PropertiesPanel.tsx`

- Supporting scenarios and validation
  - `graph-editor/src/services/ScenarioValidator.ts`
  - `graph-editor/src/services/UpdateManager.ts`

The panel changes are limited to surfacing the latency configuration controls and displaying the fields that are already defined in the design; derived statistics remain on beads and tooltips.

### 4.3 Scenario-level visibility controls

**Design reference:** `design.md §7.3`, `open-issues.md (Per-scenario visibility)`.

**Code files touched:**

- Scenario chips and legend
  - `graph-editor/src/components/ScenarioLegend.tsx`
  - `graph-editor/src/components/ScenarioLegend.css`

- Scenario context and state
  - `graph-editor/src/contexts/ScenariosContext.tsx`

These changes introduce the F+E, F-only, E-only, and hidden states per scenario, as already described in the design, wiring them through to the rendering layer implemented in §4.1.

### 4.4 Tooling, menus, and data operations UI

**Design reference:** `design.md §7.5–7.7`, `data-fetch-architecture.md`.

**Code files touched:**

- Data operations entry points
  - `graph-editor/src/components/DataOperationsMenu.tsx`
  - `graph-editor/src/components/DataOperationsSections.tsx`
  - `graph-editor/src/components/EnhancedSelector.tsx`
  - `graph-editor/src/components/modals/BatchOperationsModal.tsx`

- Fetch and pinning UI
  - `graph-editor/src/components/modals/AllSlicesModal.tsx`
  - `graph-editor/src/components/modals/PinnedQueryModal.tsx`
  - `graph-editor/src/components/WindowSelector.tsx`

The work here is to ensure that the new latency-aware query shapes and cohort/window modes are discoverable and correctly wired into the existing fetch and pin flows, without introducing any new business logic into menu components.

### 4.5 Sibling probability constraint warnings

**Design reference:** `design.md §5.0.4`.

**Code files touched:**

- Integrity and issue detection
  - `graph-editor/src/services/integrityCheckService.ts`
  - `graph-editor/src/services/graphIssuesService.ts`

- UI surfaces for warnings
  - `graph-editor/src/components/GraphCanvas.tsx` (issue indicators)
  - `graph-editor/src/components/PropertiesPanel.tsx` (node-level warning display)
  - Existing PMF warning UI components (if any)

**Implementation tasks:**

1. Add sibling sum check to `integrityCheckService`: for each node with multiple outgoing edges where both have `maturity_days > 0`, compute `Σ p.mean` and `Σ p.evidence`.

2. Issue classification per `design.md §5.0.4`:
   - `Σ p.evidence > 1.0`: Error (data inconsistency)
   - `Σ p.mean > 1.0` AND `Σ p.evidence ≤ 1.0`: Info-level (forecasting artefact)
   - Use threshold formula from design: warn if excess exceeds `(1 - completeness) × max(0, Σ p.forecast - 1) × 1.5`

3. Surface warnings via existing `graphIssuesService` patterns; ensure they appear in the Issues panel and optionally as node-level indicators.

---

## 5. Phase C5 – Tests and Validation (Core Latency)

**Goal:** Update and extend automated tests so that the latency model behaviour is protected end-to-end, following `design.md §10` and the testing guidelines in the repository.

### 5.1 TypeScript and React tests

**Design reference:** `design.md §10.1–10.3`, `TESTING_STRATEGY.md` where applicable.

**Key test files to touch or add:**

- DSL and query construction
  - `graph-editor/src/lib/__tests__/queryDSL.test.ts`
  - `graph-editor/src/lib/__tests__/dslExplosion.test.ts`

- Data retrieval and aggregation
  - `graph-editor/src/services/__tests__/dataOperations.integration.test.ts`
  - `graph-editor/src/services/__tests__/windowAggregationService.test.ts` (if not present, add as per `design.md §10.1.D`)
  - `graph-editor/src/services/__tests__/statisticalEnhancementService.test.ts`
  - `graph-editor/src/services/__tests__/multiSliceCache.e2e.test.ts`
  - `graph-editor/src/services/__tests__/versionedFetchFlow.e2e.test.ts`
  - `graph-editor/src/services/__tests__/versionedFetch.integration.test.ts`
  - `graph-editor/src/services/__tests__/contextPassthrough.e2e.test.ts`
  - `graph-editor/src/services/__tests__/fullE2EMultiSlice.integration.test.tsx`

- UI and interaction
  - `graph-editor/src/components/__tests__/WindowSelector.autoAggregation.test.ts`
  - `graph-editor/src/components/__tests__/WindowSelector.coverage.test.ts`
  - `graph-editor/src/components/edges/__tests__/EdgeBeads.test.tsx`
  - Any tests around scenario chips and legend, near `ScenarioLegend.tsx`

### 5.2 Python tests

**Design reference:** `design.md §10.2`, `DATA_RETRIEVAL_QUERIES.md`.

**Key test files to touch or add:**

- DSL and MSMDC
  - `graph-editor/tests/test_msmdc.py`
  - Any tests in `graph-editor/lib/tests/` that validate query DSL handling

- Runners and path timing hooks (where latency is threaded through)
  - `graph-editor/tests/test_runners.py`

These tests collectively should verify the complete latency-aware flow from DSL construction through data retrieval, parameter storage, and visualisation, anchored to the behaviours and examples already documented in `design.md`.

---

## 6. Out-of-Scope for This Core Plan

The following areas are explicitly deferred to the separate new implementation documents:

- Analytics extensions (tables and charts in the Analytics panel), per `design.md §8`
- Bayesian and hierarchical lag fitting, per `design.md §5.1–5.3`
- Full time-indexed DAG runner integration and Monte Carlo bands, per `design.md §6`

Those phases build on top of the surfaces and behaviours laid out in this core implementation plan.


