# Canvas Objects — Implementation Plan

**Status**: Ready to implement  
**Date**: 5-Mar-26  
**Design docs**: [0-architecture.md](0-architecture.md), [1-post-its.md](1-post-its.md), [2-containers.md](2-containers.md), [3-canvas-charts.md](3-canvas-charts.md)

---

## Prerequisites

Two standalone commits before any phase begins.

### P1. Terminology rename (~5 files, ~15 occurrences)

Rename scenario-creation terminology to eliminate "snapshot" ambiguity (architecture doc §11.1):

| Current | Proposed |
|---------|----------|
| `CreateSnapshotOptions` | `CaptureScenarioOptions` |
| `createSnapshot()` | `captureScenario()` |
| "Static snapshots" (UI label) | "Static scenarios" |
| Related comments/docstrings | Updated |

**Files**: `types/scenarios.ts`, `ScenariosContext.tsx`, `ScenariosPanel.tsx`, `ScenarioEditorModal.tsx`, `GraphEditor.tsx`

**Test**: run existing scenario tests to verify no regressions.

### P2. Rename "Objects" menu → "Elements" menu

Rename `ObjectsMenu.tsx` → `ElementsMenu.tsx`. Update `MenuBar.tsx` import and label. No behaviour change — same three items (Add Node, Delete Selected, Sync Index).

**Files**: `ObjectsMenu.tsx` → `ElementsMenu.tsx`, `MenuBar.tsx`

**Test**: manual verification that the menu renders and all items work.

---

## Phase 1 — Post-It Notes

### 1a. Schema parity

Add the `PostIt` type and `postits` array to all three schema layers. This lands first to prevent Python pipeline stripping.

**Files to change**:
- `graph-editor/src/types/index.ts` — make `PostIt.x` and `PostIt.y` required (currently optional)
- `graph-editor/lib/graph_types.py` — add `PostIt` model and `Graph.postits` field
- `graph-editor/public/schemas/conversion-graph-1.1.0.json` — add `postits` array definition

**Tests to write**:
- Extend `schemaParityAutomated.test.ts` to cover `PostIt` fields across TS / Python / JSON schema

### 1b. Foundation — rendering, drag, resize

Wire postits into the ReactFlow canvas as a new node type. Verify CSS stacking, pointer events, and layout exclusions.

**Files to change**:
- `graph-editor/src/lib/transform.ts` — extend `toFlow()` to append postit nodes (after Sankey layout, with `postit-` prefix, z-index -1); extend `fromFlow()` to partition and extract postit nodes
- `graph-editor/src/components/GraphCanvas.tsx` — register `postit` in `nodeTypes`; exclude postit nodes from `fitView` calls; verify postit nodes are excluded from auto-layout (dagre)
- `graph-editor/src/custom-reactflow.css` — add background-tier z-index rules and selected-state boost (architecture doc §2.4)
- `graph-editor/src/components/nodes/PostItNode.tsx` — update colour palette to 3M colours (post-its doc §3); remove Comic Sans; ensure no `<Handle>` components; verify `NodeResizer` propagates size changes via `onUpdate`

**Tests to write**:
- `toFlow()` with postits → correct prefix, type, z-index
- `fromFlow()` round-trip → position updated in `graph.postits[]`, no contamination of `graph.nodes[]`
- `toFlow()` with `graph.postits === undefined` → no error

**Playwright**:
- `postit-create-and-zindex.spec.ts` — create postit, verify renders below edges

**Verify manually**:
- Pointer events: clicking on postit in area not covered by edges works
- MiniMap: postit not visible in minimap
- Lasso: postit included in lasso selection
- `onSelectionChange`: fires for postit node type

### 1c. CRUD, selection, edit operations

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

### 1d. Properties panel + shared colour palette

**Files to change**:
- `graph-editor/src/components/PostItColourPalette.tsx` **(new)** — shared component: 6 swatch grid, click to select, used by both context menu and properties panel
- `graph-editor/src/components/PropertiesPanel.tsx` — add postit branch (when `selectedPostitId` is set): text textarea (blur-to-save), colour palette picker
- `graph-editor/src/components/nodes/PostItNode.tsx` — replace inline colour palette with shared `PostItColourPalette`

**Tests**: manual verification of properties panel text/colour editing, undo/redo for postit property changes.

### 1e. Element palette + Elements menu

**Files to change**:
- `graph-editor/src/components/ElementPalette.tsx` **(new)** — horizontal/vertical strip with Node + Post-It icons; drag (`dagnet-drag` with `objectType: 'new-node'` / `'new-postit'`) and click (dispatches `dagnet:addNode` / `dagnet:addPostit`)
- `graph-editor/src/components/editors/GraphEditor.tsx` — render `ElementPalette` above sidebar in maximised mode (absolutely positioned); listen for `dagnet:addPostit` event
- `graph-editor/src/components/SidebarIconBar.tsx` — render palette icons at top of icon bar in minimised mode (above panel icons, with divider)
- `graph-editor/src/components/GraphCanvas.tsx` — extend `handleDrop` with branches for `objectType: 'new-node'` and `'new-postit'` (create blank object at drop position)
- `graph-editor/src/components/MenuBar/ElementsMenu.tsx` (renamed from `ObjectsMenu.tsx`) — add "Add Post-It" item dispatching `dagnet:addPostit`

**Tests**: manual verification of drag-to-canvas and click-to-create from palette; verify palette visibility only in interactive graph tabs.

---

## Phase 2 — Containers

### Prerequisite: Generalise selection context

Before Phase 2, refactor `SelectionContextType` to replace `selectedPostitId` with the generalised `selectedAnnotationId` / `selectedAnnotationType` pattern (architecture doc §6.2). Update all Phase 1 code that reads `selectedPostitId` to use the generalised fields.

**Files**: `GraphEditor.tsx`, `GraphCanvas.tsx`, `PropertiesPanel.tsx`, `PostItContextMenu.tsx`

**Test**: existing postit tests still pass after refactor.

### 2a. Schema parity

**Files to change**:
- `graph-editor/src/types/index.ts` — add `Container` interface and `containers?` array on `ConversionGraph`
- `graph-editor/lib/graph_types.py` — add `Container` model and `Graph.containers` field
- `graph-editor/public/schemas/conversion-graph-1.1.0.json` — add `containers` array definition

**Tests**: extend `schemaParityAutomated.test.ts` for `Container` fields.

### 2b. Component, rendering, group drag, halo adaptation

**Files to change**:
- `graph-editor/src/components/nodes/ContainerNode.tsx` **(new)** — labelled rectangle, dashed border, low-opacity fill, `NodeResizer`, inline label editing (double-click), no `<Handle>` components
- `graph-editor/src/lib/transform.ts` — extend `toFlow()`: append containers before postits (architecture doc §5.2), compute `data.haloColour` for conversion nodes inside containers (containers doc §7.2); extend `fromFlow()` for container partition
- `graph-editor/src/components/nodes/ConversionNode.tsx` — read `data.haloColour` (if present) for both halo mechanisms: box-shadow (`outerHalo`) and SVG stroke (`canvasBg` references)
- `graph-editor/src/components/GraphCanvas.tsx` — register `container` in `nodeTypes`; implement group drag in `onNodeDragStart` / `onNodeDrag` / `onNodeDragStop` (snapshot contained node set, apply delta, exclude selected nodes from contained set to prevent double-move); exclude container nodes from `fitView` and auto-layout

**Tests to write**:
- `toFlow()` with containers → correct prefix, type, z-index -1, appended before postits
- `data.haloColour` computation: node inside container → blended colour; node outside → absent
- Group drag: container drag moves contained nodes by same delta
- Group drag: nodes outside container not moved
- Group drag: selected nodes not double-moved
- Undo after group drag: single undo step restores all positions
- Resize: does not move contained nodes

**Playwright**:
- `container-group-drag.spec.ts`
- `container-halo-colour.spec.ts` (screenshot comparison)

### 2c. CRUD, selection, edit operations, properties panel

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

## Phase 3 — Canvas Analyses

### Prerequisite: DB-snapshot subject resolution service extraction

Extract `resolveSnapshotSubjectsForScenario` from `AnalyticsPanel.tsx` into a shared service.

**Files to change**:
- `graph-editor/src/services/snapshotSubjectResolutionService.ts` **(new)** — the extracted function
- `graph-editor/src/components/panels/AnalyticsPanel.tsx` — refactor to call the new service

**Test**: run existing analytics/snapshot tests to verify no regressions.

### 3a. Schema parity

**Files to change**:
- `graph-editor/src/types/index.ts` — add `CanvasAnalysis`, `CanvasAnalysisDisplay` interfaces (with `view_mode: 'chart' | 'cards'`), `canvasAnalyses?` array on `ConversionGraph`
- `graph-editor/lib/graph_types.py` — add `CanvasAnalysis`, `CanvasAnalysisDisplay` models (with `extra='allow'` on display), `Graph.canvasAnalyses` field
- `graph-editor/public/schemas/conversion-graph-1.1.0.json` — add `canvasAnalyses` array (with `additionalProperties: true` on display)

**Tests**: extend `schemaParityAutomated.test.ts`; verify `CanvasAnalysisDisplay` round-trips unknown fields via Python `extra='allow'`.

### 3b. Compute hook, rendering, DnD

**Files to change**:
- `graph-editor/src/hooks/useCanvasAnalysisCompute.ts` **(new)** — encapsulates all compute logic: reads graph from `useGraphStore()`, scenarios from `useScenariosContextOptional()` + `TabContext`, builds per-scenario graphs via `buildGraphForAnalysisLayer()`, calls snapshot subject resolution for DB-snapshot-backed types, calls `graphComputeClient.analyzeSelection/analyzeMultipleScenarios()`, 2-second trailing debounce for live mode, loading/error/backend-unavailable states, ECharts disposal on unmount
- `graph-editor/src/components/nodes/CanvasAnalysisNode.tsx` **(new)** — renders either `AnalysisChartContainer` (view_mode='chart') or `AnalysisResultCards` (view_mode='cards') + title header, loading skeleton, error state, `NodeResizer` with min 300×200, no `<Handle>` components; reads `tabId` from node data for scenario state access
- `graph-editor/src/lib/transform.ts` — extend `toFlow()` for analyses (prefix `analysis-`, z-index 2500, pass `tabId` in data); extend `fromFlow()` for analysis partition
- `graph-editor/src/components/GraphCanvas.tsx` — register `canvasAnalysis` in `nodeTypes`; extend `handleDrop` for `objectType: 'canvas-analysis'` (create `CanvasAnalysis` entry, transient cache for instant first render); listen for `dagnet:pinAnalysisToCanvas` event (create at viewport centre); exclude analysis nodes from `fitView` and auto-layout
- `graph-editor/src/custom-reactflow.css` — foreground-tier z-index rule for `canvasAnalysis` (2500)
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
- `toFlow()` with analyses → correct prefix `analysis-`, type `canvasAnalysis`, z-index 2500
- `handleDrop` with `objectType: 'canvas-analysis'` → creates entry in `graph.canvasAnalyses`

**Playwright**:
- `canvas-chart-dnd.spec.ts` — drag chart preview to canvas, verify renders
- `canvas-chart-live-update.spec.ts` — pin chart, change window, verify re-render

### 3c. Properties panel, freeze/unfreeze, edit operations

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

### 3e. Result cards view + DnD from result cards

**Files to change**:
- `graph-editor/src/components/nodes/CanvasAnalysisNode.tsx` — add cards rendering path (wraps `AnalysisResultCards` when `view_mode === 'cards'`)
- `graph-editor/src/components/analytics/AnalysisResultCards.tsx` — add drag affordance (entire result area draggable, grip icon as visual signal); `onDragStart` sets `dagnet-drag` payload with `objectType: 'canvas-analysis'` and `viewMode: 'cards'`
- `graph-editor/src/components/GraphCanvas.tsx` — `handleDrop` for `canvas-analysis` reads `viewMode` from payload to set initial `view_mode`
- `graph-editor/src/components/CanvasAnalysisContextMenu.tsx` — verify view mode toggle works (chart ↔ cards)
- `graph-editor/src/components/PropertiesPanel.tsx` — verify view mode toggle in properties panel

**Tests**: drag result cards to canvas → creates `CanvasAnalysis` with `view_mode: 'cards'`; toggle to chart view → renders ECharts; toggle back → renders cards.

---

## Phase 3d — Chart Rendering Consolidation

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

**Test**: existing analytics tests + Playwright chart specs verify no regressions.

---

## Phase 5 — Snap-to Alignment Guides

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

## Summary: New Files

| File | Phase | Purpose |
|------|-------|---------|
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
| `useSnapToGuides.ts` | 5a | Snap alignment hook (change processor + guide state) |
| `SnapGuideLines.tsx` | 5b | SVG guide line overlay inside ReactFlow viewport |

## Summary: Modified Files

| File | Phases | Changes |
|------|--------|---------|
| `types/index.ts` | 1a, 2a, 3a | PostIt (refine), Container, CanvasAnalysis interfaces |
| `graph_types.py` | 1a, 2a, 3a | Python models for each type |
| `conversion-graph-1.1.0.json` | 1a, 2a, 3a | Schema definitions for each type |
| `transform.ts` | 1b, 2b, 3b | `toFlow()` / `fromFlow()` extensions for each type |
| `GraphCanvas.tsx` | 1b–1e, 2b–2c, 3b–3c | nodeTypes, selection routing, context menu routing, `handleDrop`, `deleteSelected`, fitView/layout exclusions, group drag |
| `GraphEditor.tsx` | 1c, 1e, 2 prereq | Selection context, event listeners, palette rendering |
| `ConversionNode.tsx` | 2b | `data.haloColour` for both halo mechanisms |
| `PropertiesPanel.tsx` | 1d, 2c, 3c | Postit, container, chart property sections |
| `custom-reactflow.css` | 1b, 3b | Background-tier + foreground-tier z-index rules |
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
| `schemaParityAutomated.test.ts` | 1a, 2a, 3a | Extended for each type |

## Summary: Playwright Specs

| Spec | Phase | Invariant |
|------|-------|-----------|
| `postit-create-and-zindex.spec.ts` | 1b | Renders below edges |
| `postit-select-boost.spec.ts` | 1c | Z-index boost on select/deselect |
| `postit-inline-edit.spec.ts` | 1c | Text editing persists |
| `container-group-drag.spec.ts` | 2b | Drag moves contained nodes |
| `container-halo-colour.spec.ts` | 2b | Halo adapts to container background |
| `canvas-chart-dnd.spec.ts` | 3b | DnD creates chart on canvas |
| `canvas-chart-live-update.spec.ts` | 3b | Chart re-renders on DSL change |
