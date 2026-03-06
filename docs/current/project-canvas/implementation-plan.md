# Canvas Objects — Implementation Plan

**Status**: Phases 1–3c complete; 3d (chart rendering consolidation) pending; 3e (result cards DnD) ~80%; 3f (schema unification + chart props + compositor) pending; 4–5 pending  
**Date**: 5-Mar-26 (updated 6-Mar-26)  
**Design docs**: [0-architecture.md](0-architecture.md), [1-post-its.md](1-post-its.md), [2-containers.md](2-containers.md), [3-canvas-analyses.md](3-canvas-analyses.md)

---

## Prerequisites ✅ COMPLETE

Two standalone commits before any phase begins.

### P1. Terminology rename (~5 files, ~15 occurrences) ✅

Rename scenario-creation terminology to eliminate "snapshot" ambiguity (architecture doc §11.1):

| Current | Proposed |
|---------|----------|
| `CreateSnapshotOptions` | `CaptureScenarioOptions` |
| `createSnapshot()` | `captureScenario()` |
| "Static snapshots" (UI label) | "Static scenarios" |
| Related comments/docstrings | Updated |

**Files**: `types/scenarios.ts`, `ScenariosContext.tsx`, `ScenariosPanel.tsx`, `ScenarioEditorModal.tsx`, `GraphEditor.tsx`

**Test**: run existing scenario tests to verify no regressions.

### P2. Rename "Objects" menu → "Elements" menu ✅

Rename `ObjectsMenu.tsx` → `ElementsMenu.tsx`. Update `MenuBar.tsx` import and label. No behaviour change — same three items (Add Node, Delete Selected, Sync Index).

**Files**: `ObjectsMenu.tsx` → `ElementsMenu.tsx`, `MenuBar.tsx`

**Test**: manual verification that the menu renders and all items work.

---

## Phase 1 — Post-It Notes ✅ COMPLETE

### 1a. Schema parity ✅

Add the `PostIt` type and `postits` array to all three schema layers. This lands first to prevent Python pipeline stripping.

**Files to change**:
- `graph-editor/src/types/index.ts` — make `PostIt.x` and `PostIt.y` required (currently optional)
- `graph-editor/lib/graph_types.py` — add `PostIt` model and `Graph.postits` field
- `graph-editor/public/schemas/conversion-graph-1.1.0.json` — add `postits` array definition

**Tests to write**:
- Extend `schemaParityAutomated.test.ts` to cover `PostIt` fields across TS / Python / JSON schema

### 1b. Foundation — rendering, drag, resize ✅

Wire postits into the ReactFlow canvas as a new node type. Verify CSS stacking, pointer events, and layout exclusions.

**Files to change**:
- `graph-editor/src/lib/transform.ts` — extend `toFlow()` to append postit nodes (after Sankey layout and conversion nodes, with `postit-` prefix); extend `fromFlow()` to partition and extract postit nodes. Do NOT set `draggable` or `selectable` on individual nodes — let global ReactFlow props control.
- `graph-editor/src/contexts/ElementToolContext.tsx` — standalone context for tool state (select/pan/new-node/new-postit); provided per graph tab from `GraphEditorInner`, consumed by `CanvasInner` and `PostItNode`. Must NOT be in `GraphEditor.tsx` (circular import risk).
- `graph-editor/src/components/GraphCanvas.tsx` — register `postit` in `nodeTypes`; exclude postit nodes from `fitView` calls; verify postit nodes are excluded from auto-layout (dagre). Pan mode: apply `rf-pan-mode` class to `<ReactFlow>` element; disable pointer-events on node/edge layers via CSS. Create mode: apply `rf-create-mode` class with crosshair cursor. Read tool state from `useElementTool()` context, NOT from props.
- `graph-editor/src/custom-reactflow.css` — pan-mode and create-mode CSS classes (architecture doc §2.6). Do NOT use `z-index !important` on node type selectors (architecture doc §2.4).
- `graph-editor/src/components/nodes/PostItNode.tsx` — update colour palette to 3M colours (post-its doc §3); ensure no `<Handle>` components; verify `NodeResizer` propagates size changes via `onUpdate`. Read `activeElementTool` from `useElementTool()` context to disable interaction in pan mode.

**Tests to write**:
- `toFlow()` with postits → correct prefix, type; array position maps to DOM order (z-order)
- `toFlow()` with multiple postits → z-order matches array order (bring-to-front = last in array)
- `fromFlow()` round-trip → position updated in `graph.postits[]`, no contamination of `graph.nodes[]`
- `toFlow()` with `graph.postits === undefined` → no error

**Playwright**:
- `postit-create-and-render.spec.ts` — create postit, verify renders above nodes

**Verify manually**:
- Pointer events: clicking on postit works
- MiniMap: postit not visible in minimap
- Lasso: postit included in lasso selection
- `onSelectionChange`: fires for postit node type
- Pan mode: grab cursor everywhere, no node/postit interaction
- Create-postit mode: crosshair cursor, click-drag draws rectangle

### 1c. CRUD, selection, edit operations ✅

Full create/select/update/delete/copy/paste lifecycle.

**Files to change**:
- `graph-editor/src/components/editors/GraphEditor.tsx` — add `selectedPostitId` / `onSelectedPostitChange` to `SelectionContextType`; listen for `dagnet:addPostit` event; add `selectedPostitId` to tab state persistence
- `graph-editor/src/components/GraphCanvas.tsx` — extend `onSelectionChange` to detect postit nodes (by prefix) and route to `onSelectedPostitChange`; route `onNodeContextMenu` to `PostItContextMenu` for postit nodes; add "Add Post-It" to pane context menu; extend `deleteSelected()` to remove postit nodes from `graph.postits[]`; update `metadata.updated_at` on all postit mutations
- `graph-editor/src/components/PostItContextMenu.tsx` **(new)** — colour picker (shared palette component), z-order controls (Bring to Front / Send to Back), copy, cut, delete
- `graph-editor/src/hooks/useCopyPaste.tsx` — add optional `postits` array to `DagNetSubgraphClipboardData`
- `graph-editor/src/lib/subgraphExtractor.ts` — extend `extractSubgraph()` to include selected postit nodes
- `graph-editor/src/services/UpdateManager.ts` — extend `pasteSubgraph()` to handle postits (new UUIDs, position offset)
- `graph-editor/src/components/MenuBar/EditMenu.tsx` — extend `dagnet:querySelection` response to include postit selection

**Tests to write**:
- Selection routing: click postit → `selectedPostitId` set, `selectedNodeId` cleared
- Delete: `deleteSelected()` with selected postit → removed from `graph.postits`, `metadata.updated_at` updated
- Copy/paste: pasted postit gets new UUID and offset position
- Subgraph copy with mixed types → both nodes and postits preserved

**Playwright**:
- `postit-select-boost.spec.ts` — click postit, verify z-index boost; click away, verify drop
- `postit-inline-edit.spec.ts` — double-click, type, blur, verify text persisted

### 1d. Properties panel + shared colour palette ✅

**Files to change**:
- `graph-editor/src/components/PostItColourPalette.tsx` **(new)** — shared component: 6 swatch grid, click to select, used by both context menu and properties panel
- `graph-editor/src/components/PropertiesPanel.tsx` — add postit branch (when `selectedPostitId` is set): text textarea (blur-to-save), colour palette picker
- `graph-editor/src/components/nodes/PostItNode.tsx` — replace inline colour palette with shared `PostItColourPalette`

**Tests**: manual verification of properties panel text/colour editing, undo/redo for postit property changes.

### 1e. Element palette + Elements menu ✅

**Files to change**:
- `graph-editor/src/components/ElementPalette.tsx` **(new)** — horizontal/vertical strip with Node + Post-It icons; drag (`dagnet-drag` with `objectType: 'new-node'` / `'new-postit'`) and click (dispatches `dagnet:addNode` / `dagnet:addPostit`)
- `graph-editor/src/components/editors/GraphEditor.tsx` — render `ElementPalette` above sidebar in maximised mode (absolutely positioned); listen for `dagnet:addPostit` event
- `graph-editor/src/components/SidebarIconBar.tsx` — render palette icons at top of icon bar in minimised mode (above panel icons, with divider)
- `graph-editor/src/components/GraphCanvas.tsx` — extend `handleDrop` with branches for `objectType: 'new-node'` and `'new-postit'` (create blank object at drop position)
- `graph-editor/src/components/MenuBar/ElementsMenu.tsx` (renamed from `ObjectsMenu.tsx`) — add "Add Post-It" item dispatching `dagnet:addPostit`

**Tests**: manual verification of drag-to-canvas and click-to-create from palette; verify palette visibility only in interactive graph tabs.

---

## Phase 2 — Containers ✅ COMPLETE

### Prerequisite: Generalise selection context ✅

Before Phase 2, refactor `SelectionContextType` to replace `selectedPostitId` with the generalised `selectedAnnotationId` / `selectedAnnotationType` pattern (architecture doc §6.2). Update all Phase 1 code that reads `selectedPostitId` to use the generalised fields.

**Files**: `GraphEditor.tsx`, `GraphCanvas.tsx`, `PropertiesPanel.tsx`, `PostItContextMenu.tsx`

**Test**: existing postit tests still pass after refactor.

### 2a. Schema parity ✅

**Files to change**:
- `graph-editor/src/types/index.ts` — add `Container` interface and `containers?` array on `ConversionGraph`
- `graph-editor/lib/graph_types.py` — add `Container` model and `Graph.containers` field
- `graph-editor/public/schemas/conversion-graph-1.1.0.json` — add `containers` array definition

**Tests**: extend `schemaParityAutomated.test.ts` for `Container` fields.

### 2b. Component, rendering, group drag, halo adaptation ✅

**Files to change**:
- `graph-editor/src/components/nodes/ContainerNode.tsx` **(new)** — labelled rectangle, dashed border, low-opacity fill, `NodeResizer`, inline label editing (double-click), no `<Handle>` components
- `graph-editor/src/lib/transform.ts` — extend `toFlow()`: append containers before postits (architecture doc §5.2), compute `data.haloColour` for conversion nodes inside containers (containers doc §7.2); extend `fromFlow()` for container partition
- `graph-editor/src/components/nodes/ConversionNode.tsx` — read `data.haloColour` (if present) for both halo mechanisms: box-shadow (`outerHalo`) and SVG stroke (`canvasBg` references)
- `graph-editor/src/components/GraphCanvas.tsx` — register `container` in `nodeTypes`; implement group drag in `onNodeDragStart` / `onNodeDrag` / `onNodeDragStop` (snapshot contained node set, apply delta, exclude selected nodes from contained set to prevent double-move); exclude container nodes from `fitView` and auto-layout

**Tests to write**:
- `toFlow()` with containers → correct prefix, type, appended after conversion nodes but before postits (DOM order = visual stacking)
- `data.haloColour` computation: node inside container → blended colour; node outside → absent
- Group drag: container drag moves contained nodes by same delta
- Group drag: nodes outside container not moved
- Group drag: selected nodes not double-moved
- Undo after group drag: single undo step restores all positions
- Resize: does not move contained nodes

**Playwright**:
- `container-group-drag.spec.ts`
- `container-halo-colour.spec.ts` (screenshot comparison)

### 2c. CRUD, selection, edit operations, properties panel ✅

**Files to change**:
- `graph-editor/src/components/GraphCanvas.tsx` — extend `onSelectionChange` for containers (annotation routing); route `onNodeContextMenu` to `ContainerContextMenu`; add "Add Container" to pane context menu; extend `deleteSelected()` for containers; update `metadata.updated_at`
- `graph-editor/src/components/ContainerContextMenu.tsx` **(new)** — colour picker (container palette), z-order controls, copy, cut, delete
- `graph-editor/src/components/PropertiesPanel.tsx` — add container branch: label (text, blur-to-save), colour (palette picker)
- `graph-editor/src/hooks/useCopyPaste.tsx` — add optional `containers` array to `DagNetSubgraphClipboardData`
- `graph-editor/src/lib/subgraphExtractor.ts` — extend `extractSubgraph()` for containers
- `graph-editor/src/services/UpdateManager.ts` — extend `pasteSubgraph()` for containers
- `graph-editor/src/components/ElementPalette.tsx` — add Container icon
- `graph-editor/src/components/SidebarIconBar.tsx` — add Container icon to minimised palette
- `graph-editor/src/components/MenuBar/ElementsMenu.tsx` — add "Add Container" item

**Tests**: selection routing, delete, copy/paste for containers (same pattern as postit tests).

---

## Phase 3 — Canvas Analyses (3a–3c ✅, 3d PENDING, 3e ~80%, 3f PENDING)

### Prerequisite: DB-snapshot subject resolution service extraction ✅

Extract `resolveSnapshotSubjectsForScenario` from `AnalyticsPanel.tsx` into a shared service.

**Files to change**:
- `graph-editor/src/services/snapshotSubjectResolutionService.ts` **(new)** — the extracted function
- `graph-editor/src/components/panels/AnalyticsPanel.tsx` — refactor to call the new service

**Test**: run existing analytics/snapshot tests to verify no regressions.

### 3a. Schema parity ✅

**Files to change**:
- `graph-editor/src/types/index.ts` — add `CanvasAnalysis`, `CanvasAnalysisDisplay` interfaces (with `view_mode: 'chart' | 'cards'`), `canvasAnalyses?` array on `ConversionGraph`
- `graph-editor/lib/graph_types.py` — add `CanvasAnalysis`, `CanvasAnalysisDisplay` models (with `extra='allow'` on display), `Graph.canvasAnalyses` field
- `graph-editor/public/schemas/conversion-graph-1.1.0.json` — add `canvasAnalyses` array (with `additionalProperties: true` on display)

**Tests**: extend `schemaParityAutomated.test.ts`; verify `CanvasAnalysisDisplay` round-trips unknown fields via Python `extra='allow'`.

### 3b. Compute hook, rendering, DnD ✅

**Implementation notes**: DnD from analytics panel implemented on `AnalyticsPanel.tsx` results area (draggable wrapper + grip icon + pin button) rather than on individual chart preview components. Pin button enters draw-to-create mode (same as post-its/containers) rather than placing at viewport centre. Blank chart creation also added via element palette + elements menu (not in original plan).

**Files to change**:
- `graph-editor/src/hooks/useCanvasAnalysisCompute.ts` **(new)** — encapsulates all compute logic: reads graph from `useGraphStore()`, scenarios from `useScenariosContextOptional()` + `TabContext`, builds per-scenario graphs via `buildGraphForAnalysisLayer()`, calls snapshot subject resolution for DB-snapshot-backed types, calls `graphComputeClient.analyzeSelection/analyzeMultipleScenarios()`, 2-second trailing debounce for live mode, loading/error/backend-unavailable states, ECharts disposal on unmount
- `graph-editor/src/components/nodes/CanvasAnalysisNode.tsx` **(new)** — renders either `AnalysisChartContainer` (view_mode='chart') or `AnalysisResultCards` (view_mode='cards') + title header, loading skeleton, error state, `NodeResizer` with min 300×200, no `<Handle>` components; reads `tabId` from node data for scenario state access
- `graph-editor/src/lib/transform.ts` — extend `toFlow()` for analyses (prefix `analysis-`, z-index 2500, pass `tabId` in data); extend `fromFlow()` for analysis partition
- `graph-editor/src/components/GraphCanvas.tsx` — register `canvasAnalysis` in `nodeTypes`; extend `handleDrop` for `objectType: 'canvas-analysis'` (create `CanvasAnalysis` entry, transient cache for instant first render); listen for `dagnet:pinAnalysisToCanvas` event (create at viewport centre); exclude analysis nodes from `fitView` and auto-layout
- `graph-editor/src/custom-reactflow.css` — no z-index rules needed; canvas analyses are appended last in `toFlow()` so DOM order places them visually on top (architecture doc §2.4)
- Chart preview components — add drag affordance + "Pin to Canvas" button to each:
  - `graph-editor/src/components/charts/FunnelChartPreview.tsx`
  - `graph-editor/src/components/charts/BridgeChartPreview.tsx`
  - `graph-editor/src/components/charts/SnapshotHistogramChart.tsx`
  - `graph-editor/src/components/charts/SnapshotDailyConversionsChart.tsx`
  - `graph-editor/src/components/charts/SnapshotCohortMaturityChart.tsx`

  **Drag affordance**: the **entire chart preview** is the drag area (`draggable="true"` on the wrapper div, `onDragStart` sets the `dagnet-drag` payload). This works because the panel preview charts have no drag-based ECharts interactions — tooltips work on hover (no conflict with `draggable`), and HTML5 drag only fires after a deliberate mousedown + movement threshold. A **grip icon** (`GripVertical` from Lucide) in the top-right corner acts as a visual signal ("this is draggable"), with cursor `grab` on hover. The icon is not the only drag handle — it signals the capability; the user can grab from anywhere on the chart.

  **Suppress `dataZoom`/`brush` in panel previews**: in the rare case of funnels with 10+ stages, ECharts enables `dataZoom: { type: 'inside' }` (drag-to-pan). When `compactControls: true` (always true in the analytics panel), suppress both `dataZoom` and `brush` in the ECharts options to eliminate the conflict. The full tab view retains all interactive features.

  **"Pin to Canvas" button**: a small button (e.g. `Pin` icon from Lucide) adjacent to the existing "Open as Tab" button in the chart preview controls bar. Click dispatches `dagnet:pinChartToCanvas`. Tooltip: "Pin to canvas".

  **Visual feedback during drag**: `e.dataTransfer.setDragImage(chartWrapperElement, offsetX, offsetY)` — passes the chart preview's DOM node, which the browser captures as a bitmap snapshot and shows following the cursor (semi-transparent). The user sees the **actual chart** during drag, not a generic icon. The canvas shows a drop indicator (cursor `copy` via `dropEffect`).

**Tests to write**:
- `useCanvasAnalysisCompute`: live mode returns result, re-computes on graph/DSL change (debounced)
- `useCanvasAnalysisCompute`: frozen mode computes once, does not re-run on graph change
- `toFlow()` with analyses → correct prefix `analysis-`, type `canvasAnalysis`, appended last in nodes array (topmost in DOM/visual stacking)
- `handleDrop` with `objectType: 'canvas-analysis'` → creates entry in `graph.canvasAnalyses`

**Playwright**:
- `canvas-chart-dnd.spec.ts` — drag chart preview to canvas, verify renders
- `canvas-chart-live-update.spec.ts` — pin chart, change window, verify re-render

### 3c. Properties panel, freeze/unfreeze, edit operations ✅

**Implementation notes**: Properties panel uses dynamic analysis type cards (same `analytics-type-card` CSS as AnalyticsPanel), `QueryExpressionEditor` for analytics DSL, result-driven chart kind toggle buttons. `analysisDisplaySettingsRegistry.ts` was not created — display settings are handled inline (registry will be added when settings grow). "Open as Tab" not yet wired. Clipboard infrastructure (copy/paste for canvasAnalyses) was already in place from prior work on `subgraphExtractor.ts` and `UpdateManager.ts`.

**Files to change**:
- `graph-editor/src/components/GraphCanvas.tsx` — extend `onSelectionChange` for analyses; route `onNodeContextMenu` to `CanvasAnalysisContextMenu`; extend `deleteSelected()` for analyses; update `metadata.updated_at`
- `graph-editor/src/components/CanvasAnalysisContextMenu.tsx` **(new)** — inline title edit, view mode toggle (chart/cards), chart kind selector (chart mode only), Display submenu (from registry), freeze/unfreeze, refresh, open as tab, z-order controls, copy, cut, delete
- `graph-editor/src/lib/analysisDisplaySettingsRegistry.ts` **(new)** — shared registry mapping view mode + chart kind → available display settings; drives both properties panel and context menu; starts empty, grows per view/chart kind
- `graph-editor/src/components/PropertiesPanel.tsx` — add analysis branch: title (text, blur-to-save), view mode toggle, chart kind (dropdown, chart mode only), live toggle, display settings (CollapsibleSection, from registry), read-only recipe/scenario info, refresh/open-as-tab/delete buttons
- `graph-editor/src/hooks/useCopyPaste.tsx` — add optional `canvasAnalyses` array to `DagNetSubgraphClipboardData`
- `graph-editor/src/lib/subgraphExtractor.ts` — extend `extractSubgraph()` for analyses
- `graph-editor/src/services/UpdateManager.ts` — extend `pasteSubgraph()` for analyses

**Freeze implementation**: on freeze, read current visible scenario state from `ScenariosContext` + tab `scenarioState`, serialise into `recipe.scenarios`; capture current `whatIfDSL` into `recipe.analysis.what_if_dsl`; set `live: false`. On unfreeze, clear `recipe.scenarios` and `recipe.analysis.what_if_dsl`; set `live: true`.

**"Open as Tab"**: take current `AnalysisResult` from hook state, build chart file recipe by adding `parent: { parent_file_id }` and `pinned_recompute_eligible: true`, call `chartOperationsService.openAnalysisChartTabFromAnalysis()`.

**Tests**: selection routing, delete, copy/paste, freeze/unfreeze state transitions, "Open as Tab" creates chart file with correct recipe.

---

---

### 3e. Result cards view + DnD from result cards (~80% complete)

**Done**: Cards rendering path in `CanvasAnalysisNode` (view_mode toggle), view mode toggle in context menu and properties panel, `handleDrop` reads `viewMode` from payload.  
**Pending**: Drag affordance on `AnalysisResultCards.tsx` in the analytics panel (making the result cards area draggable to canvas with `viewMode: 'cards'`).

**Files to change**:
- `graph-editor/src/components/nodes/CanvasAnalysisNode.tsx` — add cards rendering path (wraps `AnalysisResultCards` when `view_mode === 'cards'`)
- `graph-editor/src/components/analytics/AnalysisResultCards.tsx` — add drag affordance (entire result area draggable, grip icon as visual signal); `onDragStart` sets `dagnet-drag` payload with `objectType: 'canvas-analysis'` and `viewMode: 'cards'`
- `graph-editor/src/components/GraphCanvas.tsx` — `handleDrop` for `canvas-analysis` reads `viewMode` from payload to set initial `view_mode`
- `graph-editor/src/components/CanvasAnalysisContextMenu.tsx` — verify view mode toggle works (chart ↔ cards)
- `graph-editor/src/components/PropertiesPanel.tsx` — verify view mode toggle in properties panel

**Tests**: drag result cards to canvas → creates `CanvasAnalysis` with `view_mode: 'cards'`; toggle to chart view → renders ECharts; toggle back → renders cards.

---

## Phase 3d — Chart Rendering Consolidation (PENDING)

After canvas analyses are functional, consolidate the fragmented chart preview components into a single rendering surface. Currently 6 preview components each have their own layout logic, controls chrome, height calculations, and "Open as Tab" implementation. Snapshot charts build ECharts options inline rather than using `analysisEChartsService`.

**Goal**: `AnalysisChartContainer` becomes the true single rendering surface — not just a router to 6 independent components.

**Steps**:
- Extract shared chart chrome into `AnalysisChartContainer` (controls bar, Open as Tab, Download CSV, height management)
- Move snapshot chart ECharts options into `analysisEChartsService` (consistent theme/tooltip handling)
- Simplify preview components to pure ECharts renderers — no layout, no chrome
- Normalise prop handling: all chart types support `fillHeight`, `compactControls`, `showToolbox`, `hideOpenAsTab`
- Fix `FunnelBridgeChartPreview` bug: uses `chartKind: 'analysis_funnel'` for Open as Tab (should be bridge)
- Give `SnapshotHistogramChart` the same controls (Open as Tab, Download CSV) as other chart types
- **Suppress scenario legends for canvas view**: when rendering inside a `CanvasAnalysisNode`, scenario legends are unnecessary — the scenario key is already visible at graph level via the scenario legend. Add a `hideScenarioLegend` prop (or derive from `compactControls` context) so canvas analyses render without per-chart scenario labels, reclaiming vertical space for the actual data.

**Chart display settings registry** (critical prerequisite for 3f-c):

Currently chart display settings are ad-hoc: orientation is derived from `chart_kind`, controls like `compactControls`/`showToolbox`/`fillHeight` are passed as component props, and some chart components have inline toggles that are local state (not persisted). This needs a unified pattern:

- Create `analysisDisplaySettingsRegistry.ts` — maps `chart_kind` → available display settings (key, label, type, options, default)
- Each chart kind declares its settings: e.g. `bridge` has `orientation` (vertical/horizontal), `funnel` has `show_labels` (boolean), `daily_conversions` has `show_trend_line` (boolean)
- Settings are stored in `CanvasAnalysisDisplay` (persisted on the graph JSON) and `display` on chart files
- Settings are surfaced in THREE places using the same registry:
  - **Chart props panel** (Section 4 in the properties panel restructure) — full settings, always available when a canvas analysis is selected
  - **Inline chart controls** — compact toggles rendered inside the chart chrome by `AnalysisChartContainer` for quick access
  - **Context menu** (`CanvasAnalysisContextMenu`) — quick-access settings in the right-click menu (e.g. font size, orientation)
- All three surfaces read/write from the same `display` object; the registry determines which settings appear where via flags: `propsPanel: true`, `inline: true`, `contextMenu: true`
- The registry pattern means adding a new setting = one registry entry + one `display` field + handling in the chart render component. No changes to panel or chrome code.
- Settings that conceptually have "auto vs manual" state (e.g. axis extents) use the overridden-field affordance (`AutomatableField`)

**Files to create**:
- `graph-editor/src/lib/analysisDisplaySettingsRegistry.ts` — registry type definitions and per-chart-kind setting declarations

**Files to change**:
- `AnalysisChartContainer.tsx` — read display settings from registry, render inline toggles for settings marked `inline: true`
- `PropertiesPanel.tsx` (3f-c Section 4) — render all settings marked `propsPanel: true` for the current chart kind from registry
- `CanvasAnalysisContextMenu.tsx` — render settings marked `contextMenu: true` as submenu items (Phase 4 context menu refactor should generalise the submenu rendering pattern so display settings plug in cleanly)
- All chart render components — read settings from `display` prop instead of deriving from `chart_kind` or local state

**Additional items (3d scope) identified during Phase 3e/3f work**:
- View mode toggle (chart ↔ cards) in properties panel doesn't update rendering for all analysis types — needs systematic registration of which analysis types support which view modes
- `AnalysisChartContainer` falls back to bridge for all unknown analysis types — canvas node now falls back to cards when no real chart kind exists, but the chart container itself still has the bridge fallback for panel use. Consolidation should clean this up.
- Canvas analysis title field in properties panel may not be responding to input (selection routing issue) — verify and fix during consolidation

**Test**: existing analytics tests + Playwright chart specs verify no regressions.

---

## Phase 3f — Chart Definition Schema Unification + Props Exposure + Scenario Compositor UI (PENDING)

**Design reference**: [3-canvas-analyses.md](3-canvas-analyses.md) §2.2 (shared schema), §3.5 (chart props exposure), §9 (properties panel)

This phase unifies the chart definition schema across chart files, canvas analyses, and share payloads; restructures the properties panel; and extracts a shared scenario layer list component. No new composition logic — reuses `augmentDSLWithConstraint()`, `ScenarioQueryEditModal`, `AutomatableField`, and existing CSS classes.

### 3f-prereq. `ChartRecipeCore` schema extraction

Extract the shared chart definition core into a single schema used by all three contexts (chart files, canvas analyses, share payloads).

**Files to change**:
- `graph-editor/src/types/chartRecipe.ts` **(new)** — `ChartRecipeCore`, `ChartRecipeScenario`, `ChartVisibilityMode` interfaces
- `graph-editor/src/types/index.ts` — `CanvasAnalysis.recipe` typed as `ChartRecipeCore`; remove inline recipe type
- `graph-editor/src/services/chartOperationsService.ts` — `ChartFileDataV1.recipe` wraps `ChartRecipeCore` (adds `parent`, `pinned_recompute_eligible`, `display`); retire `query_dsl` field name in favour of `analytics_dsl`
- `graph-editor/src/lib/sharePayload.ts` — align `SharePayloadV1` scenario field names with `ChartRecipeScenario` (`id` → `scenario_id`, `dsl` → `effective_dsl`)
- `graph-editor/lib/graph_types.py` — `ChartRecipeCore` and `ChartRecipeScenario` Pydantic models; `CanvasAnalysis.recipe` typed as `ChartRecipeCore`
- `graph-editor/public/schemas/conversion-graph-1.1.0.json` — extract `chartRecipeCore` as `$ref`-able definition; `canvasAnalyses[].recipe` references it

**Tests to write**:
- Extend `schemaParityAutomated.test.ts` to verify `ChartRecipeCore` and `ChartRecipeScenario` field parity across TS / Python / JSON schema
- Verify `ChartRecipeCore` round-trips via Python (unknown fields preserved on `CanvasAnalysisDisplay`)
- Verify `ChartFileDataV1.recipe` still satisfies existing chart file tests after migration to `ChartRecipeCore` wrapper

### 3f-a. Generalise share + "Open as Tab" to accept `ChartRecipeCore`

**Files to change**:
- `graph-editor/src/services/shareLinkService.ts` — extract core payload builder that accepts `ChartRecipeCore` + identity + display metadata; existing `buildLiveChartShareUrlFromChartFile` becomes a thin wrapper that reads from chart file and delegates; new `buildLiveChartShareUrlFromCanvasAnalysis` reads from `CanvasAnalysis.recipe` and delegates to same core
- `graph-editor/src/services/chartOperationsService.ts` — `openAnalysisChartTabFromAnalysis` accepts `ChartRecipeCore` directly; add convenience overload for canvas analyses (adds `parent` from current graph context)
- `graph-editor/src/hooks/useShareChartFromUrl.ts` — align field name expectations with unified `ChartRecipeScenario` shape
- `graph-editor/src/hooks/useShareBundleFromUrl.ts` — same alignment

**Tests to write**:
- Build share payload from a `ChartRecipeCore` (canvas analysis source) → payload has correct field names, scenarios aligned
- Build share payload from a chart file source → same payload shape (regression)
- "Open as Tab" from canvas analysis recipe → chart file created with correct `parent`, `pinned_recompute_eligible`, and `analytics_dsl`
- Share payload round-trip: encode → decode → field names match `ChartRecipeScenario`

### 3f-b. `ScenarioLayerList` extraction from `ScenariosPanel`

Extract the scenario row rendering into a shared component that both `ScenariosPanel` (sidebar) and the chart properties panel can drive.

**Files to change**:
- `graph-editor/src/components/panels/ScenarioLayerList.tsx` **(new)** — shared layer-list rendering component:
  - Props: `items: ScenarioLayerItem[]` (id, name, colour, visible, mode, isLive, tooltip), optional callbacks (`onToggleVisibility`, `onCycleMode`, `onRename`, `onColourChange`, `onReorder`, `onDelete`, `onEdit`), `currentSlot?: ReactNode` (for Current row extra content e.g. What-If panel)
  - Renders Base row, user scenario rows, Current row using existing CSS classes (`.scenario-row`, `.scenario-colour-swatch`, `.scenario-name`, etc.)
  - DnD reorder via `onReorder(fromIndex, toIndex)` callback
  - Context menu items driven by which callbacks are provided (absent = suppressed)
  - Absent callbacks suppress corresponding action buttons (e.g. no `onDelete` = no trash icon)
- `graph-editor/src/components/panels/ScenariosPanel.tsx` — refactor to wrap `ScenarioLayerList`: provides data from `ScenariosContext` + tab state, passes callbacks, renders sidebar chrome (header, New Scenario menu, Flatten, To Base, What-If panel, modals) around the shared list
- `graph-editor/src/components/panels/ScenariosPanel.css` — no changes (CSS classes already standalone, not parent-scoped)
- `graph-editor/src/types/scenarioLayerList.ts` **(new)** — `ScenarioLayerItem` interface

**Tests to write**:
- `ScenarioLayerList` with full callbacks → renders all action buttons (visibility, mode, edit, delete)
- `ScenarioLayerList` with `onDelete` absent → no trash icon rendered
- `ScenarioLayerList` with `onRename` absent → name not clickable-to-edit
- `ScenariosPanel` refactored → existing scenario panel behaviour unchanged (regression suite)
- DnD reorder fires `onReorder` with correct indices

### 3f-c. Properties panel restructure + scenario compositor

Restructure the canvas analysis properties panel into four sections and wire the scenario compositor.

**Files to change**:
- `graph-editor/src/components/PropertiesPanel.tsx` — replace `CanvasAnalysisPropertiesSection` with four-section layout:
  - Section 1 (Analysis Identity): `QueryExpressionEditor` for `analytics_dsl` (with `suggestionsScope: 'graph'`), analysis type card selector (reuse `analytics-type-card` CSS)
  - Section 2 (Scenario Compositor): `ScenarioLayerList` in live mode (read-only, from tab state) or copied mode (editable, from `recipe.scenarios`); chart "Current layer" DSL fragment field with `AutomatableField` wrapper; freeze/unfreeze toggle; "Capture from tab" button (copied mode); "Use as Current" in scenario context menu (copied mode)
  - Section 3 (Chart Kind): card-based selector driven by `result.semantics.chart`
  - Section 4 (Display Settings): renders all settings for the current `chart_kind` from `analysisDisplaySettingsRegistry` (created in Phase 3d). Each setting is a typed control (checkbox, radio, select, slider) driven by the registry definition. `AutomatableField` wrapper for settings with auto/manual state. Initial settings: cards font size (S/M/L/XL), bridge orientation (vertical/horizontal). All settings persist in `CanvasAnalysisDisplay`. The same registry drives both this panel section AND inline chart controls in `AnalysisChartContainer` — one definition, two surfaces.
- `graph-editor/src/components/QueryExpressionEditor.tsx` — add `suggestionsScope?: 'graph' | 'registry' | 'both'` prop; when `'graph'`, suppress registry nodes/cases from autocomplete suggestions; default to `'both'` for backward compatibility
- `graph-editor/src/hooks/useCanvasAnalysisCompute.ts` — inject chart fragment via `augmentDSLWithConstraint()` in `getQueryDslForScenario()` (live mode) and per-scenario DSL resolution (copied mode), before `composeSnapshotDsl()`; read fragment from `analysis.chart_current_layer_dsl` (new field on `CanvasAnalysis`)
- `graph-editor/src/types/index.ts` — add `chart_current_layer_dsl?: string` to `CanvasAnalysis`
- `graph-editor/lib/graph_types.py` — add `chart_current_layer_dsl` to `CanvasAnalysis` model
- `graph-editor/public/schemas/conversion-graph-1.1.0.json` — add `chart_current_layer_dsl` to `canvasAnalyses` items
- `graph-editor/src/components/modals/ScenarioQueryEditModal.tsx` — no changes needed (already accepts `currentDSL`, `inheritedDSL`, `onSave` — chart properties section provides chart-appropriate values)
- `graph-editor/src/components/CanvasAnalysisContextMenu.tsx` — add "Capture from tab" and "Use as Current" items for copied-mode scenarios; wire `ScenarioQueryEditModal` for scenario DSL editing
- `graph-editor/src/components/GraphCanvas.tsx` + `ElementPalette.tsx` — "Add Analysis" from element palette (click or draw-to-create) should read the current ReactFlow selection and pre-populate `analytics_dsl` from it using the same `constructQueryDSL` path the analytics panel uses. Currently creates a blank analysis with no DSL; should instead create one that matches the current selection (e.g. `from(a).to(b)` if two nodes are selected)

**Tests to write**:
- Chart fragment composition (live mode): `augmentDSLWithConstraint(scenarioQueryDsl, chartFragment)` applied uniformly to all visible scenarios before compute
- Chart fragment composition (copied mode): `augmentDSLWithConstraint(recipe.scenario.effective_dsl, chartFragment)` applied before compute
- Chart fragment with window override: chart fragment `window(-90d:)` replaces scenario's `window(-30d:)` in composed result
- Chart fragment with context addition: chart fragment `context(channel:influencer)` added to scenario DSL that has no channel context
- Chart fragment empty: no composition, scenario DSL used as-is
- Snapshot subject resolution: chart fragment's window/context is reflected in resolved snapshot subjects (not just in display)
- `suggestionsScope: 'graph'` on `QueryExpressionEditor`: only graph nodes appear in autocomplete, not registry nodes
- Freeze with chart fragment: fragment preserved on analysis object after `live` set to `false`
- Unfreeze: fragment preserved, `recipe.scenarios` cleared
- "Capture from tab": adds current tab visible scenarios to `recipe.scenarios` (additive, not replacing)
- "Use as Current": pushes scenario's `effective_dsl` to `graphStore.setCurrentDSL()`
- Copied-mode scenario edit: editing `effective_dsl` via `ScenarioQueryEditModal` → updated in `recipe.scenarios`, chart recomputes
- Copied-mode scenario delete: removed from `recipe.scenarios`, chart recomputes with remaining scenarios
- Copied-mode scenario reorder: `recipe.scenarios` array order changes, chart legend order updates

**Playwright specs**:
- `canvas-analysis-chart-fragment.spec.ts` — set chart fragment on live chart, verify recompute reflects the fragment; clear fragment, verify revert
- `canvas-analysis-copied-scenarios.spec.ts` — freeze chart, edit scenario DSL, verify chart updates; add scenario via "Capture from tab", verify it appears; delete scenario, verify removed
- `canvas-analysis-live-share.spec.ts` — freeze chart with edited scenarios, live share → recipient sees correct chart with correct scenario set. Extends the existing live share Playwright specs to cover the canvas-analysis → `ChartRecipeCore` → share URL → boot path (complements existing chart-file share specs)

---

## Phase 4 — Context menu tidy-up (PENDING)

See 4-context-menu-refactor.md

**Display settings in context menus**: `CanvasAnalysisContextMenu` should render display settings marked `contextMenu: true` in the `analysisDisplaySettingsRegistry` as submenu items. The context menu refactor should generalise submenu rendering (consistent styling via `dagnet-popup`, Lucide icons, theme support) so that registry-driven display settings plug in without bespoke code per setting. E.g. font size (S/M/L/XL radio), orientation (vertical/horizontal toggle), show/hide legend (checkbox).

**Known issues**: `CanvasAnalysisContextMenu` view mode submenu is detached from parent (positioning bug).

---

## Phase 5 — Snap-to Alignment Guides (PENDING)

See [5-snap-to.md](5-snap-to.md) for full design.

Snap logic is purely additive — wraps `onNodesChange`, adds guide line SVG. No data model, schema, or persistence changes. All canvas object types participate (both as snap sources and targets).

**Key architectural note for Phases 1-3**: structure `onNodesChange` as a pipeline of change processors (filter removes → snap → apply) so the snap logic composes cleanly when added later. Always set `style: { width, height }` on canvas object ReactFlow nodes so dimensions are available for alignment calculations.

### 5a. Hook + pipeline

- Create `useSnapToGuides` hook (change processor, guide line state, threshold, enabled flag)
- Integrate into `GraphCanvas.tsx` `onNodesChange` pipeline

### 5b. Guide line rendering

- Create `SnapGuideLines.tsx` (SVG overlay inside ReactFlow viewport, ref-based state, rAF throttled)

### 5c. Toggle + preference

- Wire Alt-key detection for temporary suppress
- Add "Snap to guides" toggle to View menu
- Persist in `editorState`

---

## Additions Beyond Original Plan

Implemented during Phase 3 but not in the original spec:

- **Blank chart creation from element palette**: BarChart3 icon in `ElementPalette.tsx` — click to enter draw mode, drag to canvas for default size. "Add Analysis" in `ElementsMenu.tsx`. `new-analysis` tool type in `ElementToolContext.tsx`.
- **Properties panel parity with analytics panel**: Dynamic analysis type cards (same `analytics-type-card` CSS), `QueryExpressionEditor` for DSL editing, result-driven chart kind toggle buttons, shared result cache (`canvasAnalysisResultCache`).
- **Dashboard mode fitView**: `fitView` in dashboard mode includes all elements (nodes + post-its + containers + analyses), not just conversion nodes.
- **Delete icon on canvas analysis nodes**: `×` button in top-right when selected (matching post-it/container pattern).
- **Compute hook reads from graph store**: `useCanvasAnalysisCompute` reads the latest analysis from the graph store (not stale ReactFlow node data) so properties panel edits take effect immediately.

---

## Summary: New Files

| File | Phase | Purpose |
|------|-------|---------|
| `ElementToolContext.tsx` | 1b | Tool state context (per tab); consumed by CanvasInner and PostItNode |
| `PostItContextMenu.tsx` | 1c | Post-it right-click menu |
| `PostItColourPalette.tsx` | 1d | Shared colour swatch component |
| `ElementPalette.tsx` | 1e | Drag/click creation strip |
| `ElementsMenu.tsx` | 1e | Renamed from `ObjectsMenu.tsx` |
| `ContainerNode.tsx` | 2b | Container ReactFlow node component |
| `ContainerContextMenu.tsx` | 2c | Container right-click menu |
| `snapshotSubjectResolutionService.ts` | 3 prereq | Extracted from AnalyticsPanel |
| `useCanvasAnalysisCompute.ts` | 3b | Analysis compute hook (shared by chart + cards views) |
| `CanvasAnalysisNode.tsx` | 3b | Analysis ReactFlow node (renders chart or cards by view_mode) |
| `analysisDisplaySettingsRegistry.ts` | 3c | Shared registry: view mode + chart kind → display settings |
| `CanvasAnalysisContextMenu.tsx` | 3c | Analysis right-click menu (view toggle, chart kind, freeze, etc.) |
| `chartRecipe.ts` (types) | 3f-prereq | `ChartRecipeCore`, `ChartRecipeScenario` shared interfaces |
| `scenarioLayerList.ts` (types) | 3f-b | `ScenarioLayerItem` interface |
| `ScenarioLayerList.tsx` | 3f-b | Shared scenario layer-list rendering (rows, swatches, DnD, inline edit) |
| `useSnapToGuides.ts` | 5a | Snap alignment hook (change processor + guide state) |
| `SnapGuideLines.tsx` | 5b | SVG guide line overlay inside ReactFlow viewport |

## Summary: Modified Files

| File | Phases | Changes |
|------|--------|---------|
| `types/index.ts` | 1a, 2a, 3a, 3f | PostIt, Container, CanvasAnalysis; add `chart_current_layer_dsl`; recipe typed as `ChartRecipeCore` |
| `graph_types.py` | 1a, 2a, 3a, 3f | Python models; `ChartRecipeCore`/`ChartRecipeScenario`; `chart_current_layer_dsl` |
| `conversion-graph-1.1.0.json` | 1a, 2a, 3a, 3f | Schema definitions; `chartRecipeCore` as `$ref`; `chart_current_layer_dsl` |
| `transform.ts` | 1b, 2b, 3b | `toFlow()` / `fromFlow()` extensions for each type |
| `GraphCanvas.tsx` | 1b–1e, 2b–2c, 3b–3c | nodeTypes, selection routing, context menu routing, `handleDrop`, `deleteSelected`, fitView/layout exclusions, group drag |
| `GraphEditor.tsx` | 1c, 1e, 2 prereq | Selection context, event listeners, palette rendering |
| `ConversionNode.tsx` | 2b | `data.haloColour` for both halo mechanisms |
| `PropertiesPanel.tsx` | 1d, 2c, 3c, 3f | Postit, container, chart property sections; four-section chart props restructure |
| `custom-reactflow.css` | 1b | Pan-mode + create-mode CSS classes (no z-index rules — DOM order controls stacking) |
| `useCopyPaste.tsx` | 1c, 2c, 3c | Subgraph clipboard extensions |
| `subgraphExtractor.ts` | 1c, 2c, 3c | Extract selected canvas objects |
| `UpdateManager.ts` | 1c, 2c, 3c | Paste canvas objects |
| `EditMenu.tsx` | 1c | Selection query response |
| `MenuBar.tsx` | 1e | Import rename |
| `SidebarIconBar.tsx` | 1e, 2c | Palette icons |
| `AnalyticsPanel.tsx` | 3 prereq | Refactor to use extracted service |
| `FunnelChartPreview.tsx` | 3b | Drag handle + pin button |
| `BridgeChartPreview.tsx` | 3b | Drag handle + pin button |
| `SnapshotHistogramChart.tsx` | 3b | Drag handle + pin button |
| `SnapshotDailyConversionsChart.tsx` | 3b | Drag handle + pin button |
| `SnapshotCohortMaturityChart.tsx` | 3b | Drag handle + pin button |
| `chartOperationsService.ts` | 3f | Recipe typed as `ChartRecipeCore` wrapper; accepts `ChartRecipeCore` for "Open as Tab" |
| `shareLinkService.ts` | 3f | Core payload builder accepts `ChartRecipeCore` + identity; existing builders become thin wrappers |
| `sharePayload.ts` | 3f | Align scenario field names with `ChartRecipeScenario` |
| `useCanvasAnalysisCompute.ts` | 3f | Chart fragment injection via `augmentDSLWithConstraint()` in both live/copied mode |
| `QueryExpressionEditor.tsx` | 3f | Add `suggestionsScope` prop |
| `ScenariosPanel.tsx` | 3f | Refactor to wrap `ScenarioLayerList` (no behaviour change) |
| `CanvasAnalysisContextMenu.tsx` | 3f | Capture from tab, Use as Current, scenario DSL edit items |
| `useShareChartFromUrl.ts` | 3f | Align field name expectations with unified `ChartRecipeScenario` |
| `useShareBundleFromUrl.ts` | 3f | Same alignment |
| `schemaParityAutomated.test.ts` | 1a, 2a, 3a, 3f | Extended for each type; `ChartRecipeCore` parity |

## Summary: Playwright Specs

| Spec | Phase | Invariant |
|------|-------|-----------|
| `postit-create-and-render.spec.ts` | 1b | Renders above nodes |
| `postit-select-boost.spec.ts` | 1c | Selected postit visually above siblings |
| `postit-inline-edit.spec.ts` | 1c | Text editing persists |
| `container-group-drag.spec.ts` | 2b | Drag moves contained nodes |
| `container-halo-colour.spec.ts` | 2b | Halo adapts to container background |
| `canvas-chart-dnd.spec.ts` | 3b | DnD creates chart on canvas |
| `canvas-chart-live-update.spec.ts` | 3b | Chart re-renders on DSL change |
| `canvas-analysis-chart-fragment.spec.ts` | 3f | Chart fragment composes onto scenarios, recompute reflects it |
| `canvas-analysis-copied-scenarios.spec.ts` | 3f | Freeze, edit scenario DSL, capture from tab, delete scenario |
| `canvas-analysis-live-share.spec.ts` | 3f | Live share from canvas analysis → recipient sees correct chart |
