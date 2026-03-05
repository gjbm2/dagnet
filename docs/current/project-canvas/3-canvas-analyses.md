# Phase 3: Canvas Analyses

**Status**: Design — ready for implementation  
**Date**: 5-Mar-26  
**Prerequisite**: [0-architecture.md](0-architecture.md) — rendering layer, transform pattern, selection model, clipboard integration, test strategy

---

## 1. Overview

Analysis results currently live in the analytics panel sidebar or in separate chart tabs. Phase 3 allows users to drag an analysis from the analytics panel directly onto the graph canvas, where it becomes a live, draggable, resizable object. The analysis can be rendered as either a **chart** (ECharts visualisation) or **result cards** (formatted statistics/table) — toggled via `view_mode`.

Canvas analyses support multi-scenario analysis (the common case) and update live when the graph's query context or scenario data changes.

---

## 2. Data Model — Recipe Only, No Result Storage

The canvas chart recipe reuses the same field names and conventions as the existing chart file recipe (`ChartFileDataV1['recipe']`), minus fields that are implicit when the chart lives inside its parent graph (`parent`, `pinned_recompute_eligible`). This makes conversion trivial when a canvas chart is opened as a tab (add those two fields).

```typescript
interface CanvasAnalysis {
  id: string;
  x: number;
  y: number;
  width: number;        // min ~300 for readability
  height: number;       // min ~200 for readability
  view_mode: 'chart' | 'cards';  // how to render: ECharts visualisation or formatted result cards
  chart_kind?: string;  // which chart type (only when view_mode = 'chart')
  live: boolean;        // if true, compute dynamically from current tab state
  title?: string;       // user-defined label (defaults to analysis name from result)
  recipe: {
    analysis: {
      analysis_type: string;       // what kind of analysis (fixed — analysis identity)
      analytics_dsl?: string;      // which path/edges to analyse (fixed — analysis identity)
                                   // NOT the window/context DSL — that flows live from graph.currentQueryDSL
      what_if_dsl?: string;        // live: ignored (follows tab); frozen: captured at freeze
    };
    scenarios?: Array<{            // ABSENT when live; populated when frozen
      scenario_id: string;
      effective_dsl?: string;      // self-contained DSL — portable without IDB records
      name?: string;
      colour?: string;
      visibility_mode?: 'f+e' | 'f' | 'e';
      is_live?: boolean;
    }>;
  };
  display?: CanvasAnalysisDisplay;  // how to render — extensible, view-mode-specific
}

interface CanvasAnalysisDisplay {
  hide_current?: boolean;
  // Extensible: settings grow here over time.
  // Python model uses extra='allow' to preserve unknown fields.
  // JSON schema uses additionalProperties: true.
  //
  // Chart-mode settings (apply when view_mode = 'chart'):
  //   orientation?: 'vertical' | 'horizontal';
  //   show_labels?: boolean;
  //   confidence_level?: 'none' | '80' | '90' | '95' | '99';
  //   axis_scale?: 'linear' | 'log';
  //   show_trend_line?: boolean;
  //
  // Cards-mode settings (apply when view_mode = 'cards'):
  //   compact?: boolean;           (headline stats only vs full table)
  //   visible_metrics?: string[];  (which metrics to show)
}
```

**Separation of concerns**: `recipe` defines WHAT to compute (analysis identity). `view_mode`, `chart_kind`, and `display` define HOW to render the result. `title` is user metadata. These are editable independently of the recipe.

**Unified type**: a canvas analysis can be rendered as either a chart or result cards. The user toggles `view_mode` via the context menu or properties panel — same data, different view. When dragged from a chart preview, defaults to `view_mode: 'chart'`. When dragged from the result cards area, defaults to `view_mode: 'cards'`.

On `ConversionGraph`:

```typescript
canvasAnalyses?: CanvasAnalysis[];
```

### 2.1 Why No `analysisResult` in the Graph JSON

Analysis results are derived data — volatile, potentially large (10-50KB per chart), and cause git diff noise on every commit. Instead:

- The graph JSON stores only the **recipe**. Each canvas chart adds ~300-500 bytes.
- The canvas chart component **computes on mount** via `graphComputeClient`, which has its own in-memory cache (5-minute TTL, 50-entry LRU).
- During DnD, the result travels in the drag payload for instant first render (see §5), then lives in component state.

On page refresh or graph re-open, each canvas chart triggers a compute call (~1-2s). The compute cache means rapid re-renders (tab switching, pan/zoom) are instant. If the backend is unavailable, charts show a "compute unavailable" placeholder.

### 2.2 Recipe Shape — Relationship to Chart File Recipe

The existing chart file system (`ChartFileDataV1`) has a mature recipe construct:

```
ChartFileDataV1.recipe:
  parent:                        ← implicit for canvas charts (parent = this graph)
    parent_file_id
    parent_tab_id
  analysis:                      ← SHARED (in canvas chart recipe)
    analysis_type
    analytics_dsl              (was query_dsl in chart files — renamed to avoid confusion with graph.currentQueryDSL)
    what_if_dsl
  scenarios[]:                   ← SHARED (in canvas chart recipe)
    scenario_id
    effective_dsl
    name, colour, visibility_mode, is_live
  display:                       ← MOVED: hide_current lives on CanvasChart.display (render concern)
    hide_current
  pinned_recompute_eligible      ← not applicable (always eligible — the graph is right here)
```

The canvas chart recipe contains `analysis` and `scenarios` (same field names, same snake_case convention). `display` settings (including `hide_current`) live on the top-level `CanvasChart.display` object rather than inside the recipe — they're render concerns, not compute concerns. Converting a canvas chart to a chart file recipe for "Open as Tab" requires adding `parent`, `pinned_recompute_eligible`, and moving `hide_current` into `recipe.display`.

The `deps` / `deps_signature` / staleness system from chart files is not used by canvas charts — live charts auto-refresh and frozen charts are intentionally static.

---

## 3. Scenario Handling — Live vs Frozen

Scenarios are **not** part of the graph file (by design). They are tab-scoped view layers stored in IDB, managed by `ScenariosContext`. Scenario *definitions* are per-file in IDB. Scenario *visibility* is per-tab in `editorState.scenarioState`.

Canvas charts respect this architecture:

### 3.1 Live Mode (`live: true`)

`recipe.scenarios` is **absent**. The chart dynamically reads from `ScenariosContext` and the tab's `scenarioState`:

- Visible scenario IDs from `getScenarioState(tabId).visibleScenarioIds`
- Scenario params from `ScenariosContext` (`baseParams`, `currentParams`, per-scenario params)
- Visibility modes from `getScenarioState(tabId).visibilityMode`
- Scenario colours from `ScenariosContext`
- What-If DSL from `editorState.whatIfDSL`

The chart is a **live view of the current tab's analysis state**. If the user toggles scenarios in the legend, adds scenarios, changes What-If, the chart updates (debounced 2s).

### 3.2 Frozen Mode (`live: false`)

At the moment the user freezes the chart, the current scenario state is **serialised into `recipe.scenarios`** — capturing `effective_dsl`, `name`, `colour`, `visibility_mode` for each visible scenario. `what_if_dsl` is captured in `recipe.analysis.what_if_dsl`. From this point, the chart computes from its frozen recipe and does not react to tab state changes.

The `effective_dsl` strings are self-contained — they encode the full parameter state. The compute backend applies them directly without needing IDB scenario records. This is the same mechanism that powers pinned chart file recompute.

### 3.3 Freeze/Unfreeze Flow

1. Chart is `live: true`, `recipe.scenarios` absent → chart follows tab state
2. User clicks "Freeze" → current visible scenario state serialised into `recipe.scenarios`, current What-If into `recipe.analysis.what_if_dsl`, `live` set to `false`
3. Chart now computes from frozen recipe, ignoring tab changes
4. User clicks "Unfreeze" → `recipe.scenarios` cleared, `recipe.analysis.what_if_dsl` cleared, `live` set to `true`
5. Chart reverts to following tab scenarios

### 3.4 What Stays Fixed vs What Follows Tab State

| Input | Live mode | Frozen mode |
|-------|-----------|-------------|
| `analysis_type` | Fixed (from recipe — defines the chart's identity) | Fixed (from recipe) |
| `analytics_dsl` | Fixed (from recipe — defines which path/nodes/edges to analyse) | Fixed (from recipe) |
| `what_if_dsl` | **Live** — from tab's `editorState.whatIfDSL` | **Frozen** — from `recipe.analysis.what_if_dsl` |
| Graph structure/params | **Live** — from `useGraphStore()` | **Live** — still reads current graph structure (but does NOT re-compute automatically; computes once on mount) |
| Window / context / query state | **Live** — from graph's `currentQueryDSL` via `useGraphStore()` | **Frozen** — window at freeze time captured implicitly via `effective_dsl` |
| Visible scenarios | **Live** — from `ScenariosContext` + tab `scenarioState` | **Frozen** — from `recipe.scenarios` |
| Scenario params | **Live** — from `ScenariosContext` (version-stamped) | **Frozen** — from `recipe.scenarios[].effective_dsl` |
| Visibility modes (f/e/f+e) | **Live** — from tab `scenarioState.visibilityMode` | **Frozen** — from `recipe.scenarios[].visibility_mode` |

**Key distinction**: `recipe.analysis.analytics_dsl` captures the *analytics-specific* query — which edges, nodes, or path the chart analyses (e.g., `from(550e8400-...).to(52207d6c-...)` for a funnel, or a specific edge for daily conversions). This is the chart's identity and is always fixed. It is deliberately named `analytics_dsl` (not `query_dsl`) to avoid confusion with `graph.currentQueryDSL` which carries the window/context state and flows through live.

**UUID stability**: the analytics DSL uses node UUIDs, not human-readable IDs. UUIDs are stable across renames; human IDs can change. If a referenced node is deleted from the graph, the compute will error for that analysis — the chart shows an error state.

The *window and context* (e.g., `window(-90d:)`, `context(channel:google)`) are part of the graph's `currentQueryDSL`, which flows through because the chart reads the current graph from `useGraphStore()`. When the user changes the window selector, the graph state changes, triggering a live chart re-compute. For snapshot analyses, the new window determines which date range of snapshots is fetched.

---

## 4. Rendering

Canvas charts are ReactFlow nodes with `type: 'canvasChart'`, rendered in the **foreground tier** at z-index 2500 (above conversion nodes at 2000). Charts are prominent data displays that need to be readable — they render above the graph, not below it.

ECharts renders into a `<div>` with a fixed pixel size. Inside a ReactFlow node, this works naturally — the node has a fixed width/height in flow coordinates, and ECharts fills it. The viewport CSS `transform` handles zoom scaling.

### 4.1 Interaction Model — Selected vs Unselected

- **Unselected** (z-index 2500): chart is visible and readable above nodes and edges. Tooltips and hover effects work normally. The chart may occlude conversion nodes behind it — this is by design (the user chose to place it there; they can move it).
- **Selected** (z-index 3000): chart is above all other canvas objects. Useful when multiple foreground objects overlap.
- **Deselected**: drops back to z-index 2500.

### 4.2 Node Unmount/Remount

ReactFlow may unmount node components when they scroll off-screen (node virtualization, if enabled). When the node re-enters the viewport, the component remounts. The `useCanvasChartCompute` hook must handle this:

- If the compute client cache has a hit (within 5-minute TTL), the chart renders instantly on remount.
- If the cache has expired, a recompute triggers (~1-2s with loading skeleton).
- ECharts instances must be properly disposed on unmount (`chart.dispose()` in a cleanup `useEffect`) to prevent memory leaks.

### 4.3 Single Rendering Codepath

Canvas charts, chart tabs, and analytics panel previews all render through the same component: `AnalysisChartContainer`. This is the single chart kind router — it takes an `AnalysisResult` and delegates to the appropriate ECharts component (`AnalysisFunnelBarEChart`, `AnalysisBridgeEChart`, etc.).

```
Analytics panel preview  → AnalysisChartContainer → ECharts components
Chart tab (ChartViewer)  → AnalysisChartContainer → same components
Canvas chart node        → AnalysisChartContainer → same components
```

No chart rendering logic is duplicated for the canvas surface. Any improvement to chart rendering (new chart kinds, better ECharts options, display settings) benefits all three surfaces automatically. The display settings registry (§9.4) feeds into the ECharts options builders (`analysisEChartsService.ts`), which are shared.

The only differences between surfaces are layout/behaviour props:

| Surface | `compactControls` | `height` | `showToolbox` | "Open as Tab" |
|---------|------------------|----------|--------------|--------------|
| Analytics panel | `true` | Panel size | Suppressed | Via chart preview button |
| Chart tab | `false` | `fillHeight` | `true` | N/A (already a tab) |
| Canvas chart | `true` | Fixed from canvas object | Suppressed | Via properties panel |

### 4.4 `AnalysisChartContainer` Props

`AnalysisChartContainer` needs these props:

```typescript
result: AnalysisResult;              // from useCanvasChartCompute
visibleScenarioIds: string[];        // live: from context; frozen: from recipe.scenarios
scenarioVisibilityModes?: Record<string, 'f+e' | 'f' | 'e'>;   // live: from context; frozen: from recipe
scenarioDslSubtitleById?: Record<string, string>;                 // can be empty
```

The container's internal "Open as tab" button can be hidden in canvas mode.

---

## 5. Drag-to-Canvas from Analysis Panel

GraphCanvas already has DnD infrastructure: `handleDragOver` and `handleDrop` process `application/json` payloads with a `dagnet-drag` discriminator, using `screenToFlowPosition()` for placement. Navigator node drops already work through this path.

### 5.1 Drag Source

The **entire chart preview** is the drag area (`draggable="true"` on the wrapper div). This works because panel preview charts have no drag-based ECharts interactions in the common case — tooltips work on hover (no conflict with `draggable`), and HTML5 drag only fires after a deliberate mousedown + movement threshold.

A **grip icon** (`GripVertical` from Lucide) in the top-right corner acts as a visual signal ("this is draggable") with cursor `grab`. Users can drag from anywhere on the chart, not just the icon.

When `compactControls: true` (always true in the analytics panel), `dataZoom` and `brush` are suppressed in the ECharts options to eliminate any conflict with HTML5 drag. The full tab view retains all interactive features.

`e.dataTransfer.setDragImage(chartWrapperElement, offsetX, offsetY)` captures the chart preview's DOM node as a bitmap snapshot — the user sees the **actual chart** following the cursor during drag (semi-transparent, standard browser behaviour).

On drag start:

```
dataTransfer.setData('application/json', JSON.stringify({
  type: 'dagnet-drag',
  objectType: 'canvas-chart',
  chartKind: '...',
  recipe: { analysis: { analysis_type, analytics_dsl } },   // no scenarios — live by default
  analysisResult: currentResult,   // carried for instant first render, NOT persisted in graph
}));
dataTransfer.effectAllowed = 'copy';
```

### 5.2 Drop Target

`handleDrop` in GraphCanvas gains a branch for `objectType === 'canvas-chart'`:

1. Extract recipe and result from the drag payload
2. Compute flow-space position via `screenToFlowPosition({ x: e.clientX, y: e.clientY })`
3. Create a `CanvasChart` entry with UUID, position, default size (400×300), recipe, `live: true`
4. `structuredClone(graph)` → push to `next.canvasCharts` → update `metadata.updated_at` → `setGraph(next)` → `saveHistoryState('Pin chart to canvas')`
5. Pass the carried `analysisResult` to the new chart node via a transient cache (module-level `Map<chartId, AnalysisResult>`) so first render is instant

### 5.3 "Pin to Canvas" Button (Secondary Interaction)

A button on chart previews alongside "Open as Tab". On click, creates the canvas chart at the centre of the current viewport via a custom event:

`window.dispatchEvent(new CustomEvent('dagnet:pinChartToCanvas', { detail: { recipe, analysisResult } }))`

GraphCanvas listens for this event, computes viewport centre, and creates the chart. This matches existing cross-component patterns (`dagnet:selectAllNodes`, `dagnet:openTemporaryTab`).

---

## 6. Compute Hook — `useCanvasChartCompute(recipe, live)`

Canvas chart nodes render inside the GraphEditor's component subtree and have access to `ScenariosContext` via `useScenariosContextOptional()`, the graph via `useGraphStore()`, and tab state via `TabContext`.

### 6.1 Live Mode Compute

1. Reads graph from `useGraphStore()` (includes `currentQueryDSL` for window/context)
2. Reads current visible scenarios, `baseParams`, `currentParams`, colours, visibility modes from `ScenariosContext` + tab `scenarioState`
3. For each visible scenario, calls `buildGraphForAnalysisLayer()` to build the scenario-specific graph
4. For DB-snapshot-backed analysis types (`lag_histogram`, `daily_conversions`, `cohort_maturity`): calls the shared DB-snapshot subject resolution service to resolve subjects from IDB using the current window and edge/path context
5. Calls `graphComputeClient.analyzeMultipleScenarios()` (or `analyzeSelection()` for single-scenario), passing DB-snapshot subjects where applicable
6. Re-runs when graph, `currentQueryDSL`, scenario state, or What-If state changes (debounced 2s)
7. Returns `{ result: AnalysisResult | null, loading: boolean, error: string | null }`

This is the same data flow as the AnalyticsPanel — the chart is a live view of the current tab's analysis state.

### 6.2 Frozen Mode Compute

1. Reads graph from `useGraphStore()` (for structure)
2. Builds scenario entries from `recipe.scenarios` using their `effective_dsl` values
3. Calls `graphComputeClient.analyzeMultipleScenarios()` with the frozen scenario data
4. Computes **once on mount** and does not re-run
5. If a frozen scenario's `effective_dsl` is invalid (graph structure changed), that scenario errors gracefully

### 6.3 Tab State Access

The hook needs the current tab's `tabId` to read `scenarioState`. This is provided either:
- Through the ReactFlow node `data` (set in `toFlow()`)
- Via a dedicated context wrapping the canvas

The AnalyticsPanel reads scenario visibility from `operations.getScenarioState(tabId)` via TabContext. The compute hook follows the same pattern.

---

## 7. Live Refresh

When `live` is true, the hook watches:

- `graph` reference from GraphStore (structural/parameter changes)
- `currentQueryDSL` from GraphStore (window and context changes — this is how the window selector drives chart updates)
- Visible scenario IDs and `version` stamps from ScenariosContext (scenario add/remove/edit)
- Scenario visibility modes from tab `scenarioState`
- `whatIfDSL` from tab `editorState`

Changes trigger a **2-second trailing debounce**. During compute, a loading overlay appears on the chart. If the compute fails, the chart retains its last successful result and shows an error badge.

**Rate limiting**: debounce is per-chart. With 3 live charts, a DSL change triggers 3 debounced computes — each potentially a cache hit (same graph + DSL = same cache key). The compute client deduplicates via its LRU cache.

---

## 8. "Open as Tab" from Canvas Chart

Properties panel includes an "Open as Tab" button. On click:

1. Take the canvas chart's current computed `AnalysisResult` (from hook state)
2. Build a chart file recipe by adding `parent: { parent_file_id }` and `pinned_recompute_eligible: true`
3. Call `chartOperationsService.openAnalysisChartTabFromAnalysis()`
4. A full chart tab opens with the same data

The canvas chart and the tab chart are independent copies.

---

## 9. Properties Panel

When a canvas chart is selected, the properties panel shows:

### 9.1 Editable Fields

**Title** — text input, blur-to-save. Displayed on the chart node as a header. If absent, the chart uses `result.analysis_name` from the compute response.

**Chart kind** — dropdown or radio buttons listing the available visual representations for this analysis type. Available kinds come from `result.semantics.chart.recommended` + `alternatives` (computed at render time). Changing the kind re-renders the chart immediately (no recompute needed — same data, different visualisation). The selected kind persists in `chart_kind` on the `CanvasChart`.

Current chart kinds: `funnel`, `bridge`, `bridge_horizontal`, `histogram`, `daily_conversions`, `cohort_maturity`. Not all are available for every analysis type — the dropdown only shows kinds that the compute result reports as valid.

**Live toggle** — checkbox. Freeze/unfreeze per §7.

**Display settings** — a `CollapsibleSection` that renders settings appropriate for the current `chart_kind`. Settings are chart-kind-specific and grow organically as charting features mature:

| Chart kind | Current settings | Planned future settings |
|-----------|-----------------|----------------------|
| `bridge` / `bridge_horizontal` | (none in Phase 3) | Orientation toggle, show running total line |
| `funnel` | (none in Phase 3) | Show/hide step labels, show/hide confidence intervals |
| `histogram` | (none in Phase 3) | Axis scale (linear/log), bin count |
| `daily_conversions` | (none in Phase 3) | Show/hide trend line, date range display |
| `cohort_maturity` | (none in Phase 3) | Show/hide progress markers |

The Display section is hidden when no settings exist for the current chart kind. As settings are added, a registry pattern maps chart kinds to their available display settings, so the properties panel renders the appropriate controls dynamically.

All display settings persist in the `display` object on `CanvasChart` and are preserved through round-trips (Python `extra='allow'`, JSON schema `additionalProperties: true`).

### 9.2 Read-Only Fields

**Analysis type** — badge showing the analysis name (e.g. "Conversion Funnel", "Daily Conversions").

**Analytics DSL** — monospace display of `recipe.analysis.analytics_dsl`. This is the chart's analytical identity (which path/edges it covers). Not editable — to change the query, create a new chart.

**Scenarios** — list with colour swatches:
- Live mode: "Following tab scenarios" + current visible scenario names/colours
- Frozen mode: scenario names/colours from `recipe.scenarios`, with warning badges for any whose `effective_dsl` fails to compute

### 9.3 Action Buttons

- **Refresh** — manual one-shot recompute (useful when live mode is off, or to force a refresh)
- **Open as Tab** — opens the chart in a full tab with all ChartViewer features
- **Delete** — removes the chart from the graph

### 9.4 Extensibility Approach

The `CanvasChartDisplay` interface and the chart UI surfaces (properties panel, context menu) are designed to grow together without breaking changes.

**Data model extensibility**: `CanvasChartDisplay` grows by adding fields. Python `extra='allow'` and JSON schema `additionalProperties: true` preserve unknown fields during round-trips. Old clients ignore new settings (component defaults). New clients handle missing settings (field defaults). No schema migrations needed.

**UI extensibility via a shared display settings registry**: a single registry maps chart kinds to their available display settings:

```typescript
const CHART_DISPLAY_SETTINGS: Record<string, DisplaySettingDef[]> = {
  bridge: [
    // { key: 'orientation', label: 'Orientation', type: 'radio', options: [...] },
  ],
  funnel: [
    // { key: 'show_labels', label: 'Show labels', type: 'checkbox' },
  ],
  // ... grows per chart kind
};
```

Both the **properties panel Display section** and the **context menu Display submenu** read from this registry. Adding a new setting = one registry entry + one field on `CanvasChartDisplay` + handling in the chart render component. Both UI surfaces pick it up automatically.

The registry starts empty in Phase 3. As charting features mature (axis titles, show/hide legend, grid lines, confidence intervals, etc.), settings are added per chart kind without structural changes to the panel or menu code.

---

## 10. Edge Case Matrix

### 10.1 By Scenario State

| Scenario state | Live chart behaviour | Frozen chart behaviour |
|---------------|---------------------|----------------------|
| No scenarios (just "current") | Computes single-scenario for "current" | Computes from `recipe.scenarios` (may be single "current" entry) |
| Scenarios defined, some visible | Computes multi-scenario for visible set | Uses frozen `effective_dsl` per scenario |
| Scenarios defined, none visible (just "current") | Computes single-scenario for "current" | Uses frozen recipe (shows whatever was visible at freeze time) |
| Live scenarios (`is_live: true`) | Includes in compute; updates when scenario regenerates | Frozen `effective_dsl` captures state at freeze time |
| User adds a new scenario after chart creation | Chart picks it up when made visible | Not affected (frozen) |
| User deletes a scenario that chart was showing | Chart drops it from next compute (no longer visible) | Frozen `effective_dsl` still applied; if DSL references deleted nodes, that scenario errors gracefully |

### 10.2 By Tab Context

| Situation | Live chart behaviour | Frozen chart behaviour |
|-----------|---------------------|----------------------|
| Single tab | Reads from that tab's context | Uses frozen recipe |
| Two tabs, same graph | Each tab's live charts follow their own tab's scenario visibility | Frozen charts identical across tabs (recipe in graph JSON) |
| Tab closed, chart not visible | N/A | N/A |
| Tab reopened (scenario visibility resets to `['current']`) | Live chart shows only "current" until user re-enables scenarios | Frozen chart unaffected |
| Session restore (browser refresh) | Scenario visibility restored from persisted tab state; chart resumes | Frozen chart computes from recipe on mount |
| What-If toggled on | Chart includes What-If overlay | Not affected (frozen `what_if_dsl`) |
| What-If toggled off | Chart drops What-If overlay | Not affected |
| Two tabs, different What-If state | Each tab's live charts follow their own What-If | Frozen charts use their recipe's `what_if_dsl` |

### 10.3 By Graph Storage State

| State | Live chart behaviour | Frozen chart behaviour |
|-------|---------------------|----------------------|
| Normal committed graph | Standard | Standard |
| New graph (not yet in git) | Standard — canvas charts don't care about git state | Standard |
| Dirty graph (modified, not committed) | Standard — works from GraphStore | Standard |
| Fresh clone (no IDB scenario records) | Computes for "current" only (no scenarios in context). **DB-snapshot-backed charts** (lag, daily, cohort): snapshot data may not yet be in IDB on a fresh clone — chart shows "no data available" until the user runs a data fetch (daily fetch or manual retrieve). Computed charts (funnel, bridge, etc.) work normally. | Computes from `recipe.scenarios[].effective_dsl` — self-contained, no IDB scenario dependency. DB-snapshot data availability same as live. |
| Fresh clone + user creates scenarios | Live chart picks up new scenarios as they're added to visibility | Not affected |
| Graph merge (two users both added canvas charts) | Standard 3-way merge on `canvasCharts[]` array | Standard |

### 10.4 By Chart Mode

| Scenario | Behaviour |
|----------|-----------|
| Live chart, user changes window via window selector | Graph's `currentQueryDSL` changes → graph state changes → live chart re-computes with new window. The chart's analytics DSL (`recipe.analysis.analytics_dsl` — from/to path) stays fixed; the window flows through the graph state. For DB-snapshot-backed charts, the new window triggers DB-snapshot subject re-resolution for the new date range. |
| Live chart, user changes graph structure (add/rename/delete nodes) | Chart re-computes with new graph structure. If `recipe.analysis.analytics_dsl` references deleted nodes, compute may error. |
| Frozen chart, graph structure changes | Does not re-compute. If user manually refreshes, the compute uses the frozen `effective_dsl` against the new graph structure — may error for scenarios referencing deleted nodes. |
| Canvas chart + undo/redo | All mutations go through `setGraph` + `saveHistoryState`. Undo restores previous graph snapshot. Undo of a freeze restores `recipe.scenarios` to absent. Live charts re-compute from restored state. |
| Canvas chart + commit/push | `canvasCharts[]` committed as part of graph JSON. Live charts: ~200 bytes (no scenarios). Frozen charts: ~500 bytes (includes effective_dsl). Clean diffs. |
| Backend unavailable | Loading skeleton → timeout → "Analysis backend unavailable" placeholder. Recipe preserved. User can retry when backend returns. |
| Canvas chart in read-only/share mode | Computes normally (read-only operation). Edits (move, resize, freeze) blocked by share mode permissions. |

---

## 11. Supported Analysis Types

All analysis types are in scope for Phase 3 — both computed analyses (funnel, bridge, path) and DB-snapshot-backed analyses (lag histogram, daily conversions, cohort maturity). The primary use case for canvas charts — pinning "daily conversions" or "cohort maturity" charts for key params — requires DB-snapshot-backed analysis support from day one.

**Terminology note** (see architecture doc §8): "snapshot" here means **DB data snapshots** stored in IndexedDB — fetched from external sources and used by the compute backend. It does NOT mean "static/non-live scenarios."

### 11.1 DB-Snapshot-Backed Analysis Prerequisite

DB-snapshot-backed analyses (`lag_histogram`, `daily_conversions`, `cohort_maturity`) require `snapshotSubjects` resolution: composing the analytics DSL with the current window, resolving edge subjects via `snapshotDependencyPlanService`, computing core hashes, and reading snapshot data from IDB.

This logic is currently embedded as a ~100-line inline function (`resolveSnapshotSubjectsForScenario`) in `AnalyticsPanel.tsx`. **Extracting this into a shared service is a prerequisite for Phase 3a.** The extraction is bounded work — the function is self-contained and only needs to be moved to a service that both the AnalyticsPanel and `useCanvasChartCompute` can call.

### 11.2 What Is NOT in Scope

Canvas charts built from **static (non-live) scenarios** are out of scope for Phase 3. Live charts follow the tab's current scenario state (which may include live scenarios). Frozen charts capture the effective DSL at freeze time. But building a canvas chart that specifically targets a static scenario's frozen historical parameter set (rather than the current graph state) is a future consideration.

### 11.3 Full Analysis Type Support

| Analysis type | Supported | Notes |
|--------------|-----------|-------|
| `graph_overview` | Yes | Computed from live graph |
| `from_node_outcomes` | Yes | Computed from live graph |
| `to_node_reach` | Yes | Computed from live graph |
| `bridge_view` | Yes | Computed from live graph |
| `path_through` | Yes | Computed from live graph |
| `path_between` | Yes | Computed from live graph |
| `outcome_comparison` | Yes | Computed from live graph |
| `branch_comparison` | Yes | Computed from live graph |
| `conversion_funnel` | Yes | Computed from live graph |
| `constrained_path` | Yes | Computed from live graph |
| `branches_from_start` | Yes | Computed from live graph |
| `multi_waypoint` | Yes | Computed from live graph |
| `multi_outcome_comparison` | Yes | Computed from live graph |
| `multi_branch_comparison` | Yes | Computed from live graph |
| `general_selection` | Yes | Computed from live graph |
| `lag_histogram` | Yes | DB-snapshot-backed (requires service extraction) |
| `daily_conversions` | Yes | DB-snapshot-backed (requires service extraction) |
| `cohort_maturity` | Yes | DB-snapshot-backed (requires service extraction) |

---

## 12. Scope Summary

| Capability | In scope | Not planned |
|-----------|---------|------------|
| Schema parity (TS + Python + JSON schema) | **Phase 3a** | |
| Live canvas chart, single + multi-scenario | **Phase 3b** | |
| Live chart follows window / context / What-If | **Phase 3b** | |
| All analysis types incl. DB-snapshot-backed | **Phase 3b** (prerequisite: service extraction) | |
| DnD from analytics panel to canvas | **Phase 3b** | |
| "Pin to Canvas" button (fallback) | **Phase 3b** | |
| Properties panel (title, chart kind, display, live toggle, refresh, delete) | **Phase 3c** | |
| Frozen canvas chart (effective_dsl, self-contained) | **Phase 3c** | |
| Freeze/unfreeze (serialise/clear scenarios) | **Phase 3c** | |
| "Open as Tab" from canvas chart | **Phase 3c** | |
| Canvas chart result persistence in IDB | | **No** — compute on demand |
| Canvas chart as separate git-tracked file | | **No** — lives in graph JSON |

---

## 13. Implementation Steps

### Prerequisites

**DB-snapshot subject resolution service extraction**
- Extract `resolveSnapshotSubjectsForScenario` from `AnalyticsPanel.tsx` into a shared service (e.g. `snapshotSubjectResolutionService.ts`)
- Refactor AnalyticsPanel to call the new service (verify no regressions via existing tests)

**Terminology rename** (see architecture doc §11.1)
- Rename `createSnapshot` → `captureScenario` and related symbols

### Phase 3a: Schema parity (FIRST)

**Files**: `types/index.ts`, `graph_types.py`, `conversion-graph-1.1.0.json`, `schemaParityAutomated.test.ts`

- Add `CanvasChart` + `CanvasChartDisplay` interfaces, `canvasCharts?` array on `ConversionGraph`
- Add Python `CanvasChart` + `CanvasChartDisplay` models (with `extra='allow'` on display), `Graph.canvasCharts` field
- Add `canvasCharts` to JSON schema (with `additionalProperties: true` on display)
- Run schema parity tests

### Phase 3b: Compute hook + rendering + DnD

**Files**: `useCanvasChartCompute.ts` (new), `CanvasChartNode.tsx` (new), `transform.ts`, `GraphCanvas.tsx`, `custom-reactflow.css`, chart preview components

- Create `useCanvasChartCompute` hook:
  - Graph/scenario access via `useGraphStore()`, `useScenariosContextOptional()`, `TabContext`
  - Single + multi-scenario compute via `graphComputeClient`
  - DB-snapshot subject resolution via the extracted service (for lag/daily/cohort types)
  - Debounced live refresh on graph, DSL, scenario, window, and What-If changes
  - Loading / error / backend-unavailable states
  - Proper ECharts disposal on unmount
- Create `CanvasChartNode.tsx` component (wraps `AnalysisChartContainer` + loading skeleton + error state + title header)
- Register `canvasChart` node type in `GraphCanvas.tsx`
- Extend `toFlow()` / `fromFlow()` for canvas charts (prefix: `chart-${id}`, z-index: 2500, after Sankey layout)
- Exclude chart nodes from `fitView` and auto-layout
- Extend `handleDrop` in GraphCanvas for `objectType: 'canvas-chart'`
- Add drag handle + `onDragStart` to chart preview components (all chart types)
- Add "Pin to Canvas" button to chart preview components (custom event + viewport centre placement)
- CSS: foreground tier z-index (2500) per architecture doc §2.4
- MiniMap exclusion

### Phase 3c: Properties panel + chart management + edit operations

**Files**: `GraphEditor.tsx`, `GraphCanvas.tsx`, `CanvasChartContextMenu.tsx` (new), `PropertiesPanel.tsx`, `useCopyPaste.tsx`, `subgraphExtractor.ts`, `EditMenu.tsx`

- Extend selection context for canvas charts (use generalised annotation selection)
- Route `onNodeContextMenu` to `CanvasChartContextMenu` for chart nodes
- Create `CanvasChartContextMenu.tsx` (inline title edit, chart kind selector, Display submenu (empty initially, extensible via registry), freeze/unfreeze, refresh, open as tab, z-order, copy, cut, delete)
- Add canvas chart branch to PropertiesPanel (title, chart kind, live toggle, display settings, recipe info, refresh, open-as-tab, delete)
- Wire "Open as Tab" to `chartOperationsService.openAnalysisChartTabFromAnalysis()`
- Extend `deleteSelected()` for canvas chart nodes
- Extend `DagNetSubgraphClipboardData` with optional `canvasCharts` array
- Extend `extractSubgraph()` and `pasteSubgraph()` for canvas charts
- Extend `dagnet:querySelection` response to include canvas charts
- Implement freeze/unfreeze (scenario state serialisation/clearing)

---

## 14. Test Plan

Following the architecture doc §9 test strategy.

### 14.1 Transform Round-Trip

- `toFlow()` with canvas charts → ReactFlow nodes with `chart-` prefix, type `canvasChart`, z-index 2500
- `fromFlow()` with chart nodes → updates `graph.canvasCharts[]` positions, does not contaminate `graph.nodes[]`
- `graph.canvasCharts === undefined` → no error

### 14.2 Compute Hook

- `useCanvasChartCompute` with a live recipe + graph → returns `AnalysisResult` with loading/error states
- Live mode: changing `graph` reference triggers recompute (after debounce)
- Live mode: changing `currentQueryDSL` triggers recompute (this is how window changes propagate)
- Frozen mode: changing graph does NOT trigger recompute (computes once on mount)
- Frozen mode: recipe with `effective_dsl` for a deleted node → error for that scenario, remaining scenarios render

### 14.3 DnD

- Dropping `objectType: 'canvas-chart'` creates a `CanvasChart` in `graph.canvasCharts` at the correct flow position
- Transient cache provides instant first render (no loading skeleton on initial DnD)

### 14.4 Freeze/Unfreeze

- Freeze: current visible scenario state serialised into `recipe.scenarios`; `live` set to `false`
- Unfreeze: `recipe.scenarios` cleared; `live` set to `true`
- Undo of freeze restores `recipe.scenarios` to absent

### 14.5 "Open as Tab"

- Creates a chart file via `chartOperationsService` with correct recipe conversion (adds `parent`, `pinned_recompute_eligible`)
- Tab opens with the same data

### 14.6 Selection, Delete, Copy/Paste

- Standard canvas object tests per architecture doc §9.2–9.4, adapted for canvas charts

### 14.7 Schema Parity

- Extend `schemaParityAutomated.test.ts` to cover `CanvasChart` + `CanvasChartDisplay` fields
- Verify `CanvasChartDisplay` round-trips unknown fields (Python `extra='allow'`)

---

## 15. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| ECharts performance — multiple live instances | Medium | Medium | Use `renderer: 'canvas'` for lighter DOM. Recommend max ~5 canvas charts. Consider `lazyUpdate: true`. |
| First-render compute delay on graph open | High (by design) | Low | Loading skeleton is acceptable for 1-2s. Compute cache eliminates delay for repeated renders. |
| Backend unavailable | Medium | Medium | Placeholder message. Charts are supplementary — not critical to graph editing. |
| Recipe DSL invalid after graph restructure | Medium | Low | Compute returns error; chart shows error state. User can delete or recreate. |
| Frozen scenario DSL invalid after restructure | Low | Low | That scenario errors; chart renders remaining scenarios. |
| DnD payload size | Low | Low | Results typically 5-50KB. `dataTransfer` handles this in all modern browsers. |
| Zoom scaling makes ECharts blurry | Medium | Low | CSS-transformed canvas elements slightly soft at high zoom. Acceptable for Phase 3. |
| Tab state access from ReactFlow node component | Medium | Medium | Node needs `tabId` for scenario state. Pass via node `data` or dedicated context. Verify during Phase 3a. |
