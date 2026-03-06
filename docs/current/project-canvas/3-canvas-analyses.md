# Phase 3: Canvas Analyses

**Status**: Design -- ready for implementation  
**Date**: 5-Mar-26  
**Prerequisite**: [0-architecture.md](0-architecture.md) -- rendering layer, transform pattern, selection model, clipboard integration, test strategy

---

## 1. Overview

Analysis results currently live in the analytics panel sidebar or in separate chart tabs. Phase 3 allows users to drag an analysis from the analytics panel directly onto the graph canvas, where it becomes a live, draggable, resizable object. The analysis can be rendered as either a **chart** (ECharts visualisation) or **result cards** (formatted statistics/table) -- toggled via `view_mode`.

Canvas analyses support multi-scenario analysis (the common case) and update live when the graph's query context or scenario data changes.

---

## 2. Data Model -- Recipe Only, No Result Storage

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
      analysis_type: string;       // what kind of analysis (fixed -- analysis identity)
      analytics_dsl?: string;      // which path/edges to analyse (fixed -- analysis identity)
                                   // NOT the window/context DSL -- that flows live from graph.currentQueryDSL
      what_if_dsl?: string;        // live: ignored (follows tab); frozen: captured at freeze
    };
    scenarios?: Array<{            // ABSENT when live; populated when frozen
      scenario_id: string;
      effective_dsl?: string;      // self-contained DSL -- portable without IDB records
      name?: string;
      colour?: string;
      visibility_mode?: 'f+e' | 'f' | 'e';
      is_live?: boolean;
    }>;
  };
  display?: CanvasAnalysisDisplay;  // how to render -- extensible, view-mode-specific
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

**Unified type**: a canvas analysis can be rendered as either a chart or result cards. The user toggles `view_mode` via the context menu or properties panel -- same data, different view. When dragged from a chart preview, defaults to `view_mode: 'chart'`. When dragged from the result cards area, defaults to `view_mode: 'cards'`.

On `ConversionGraph`:

```typescript
canvasAnalyses?: CanvasAnalysis[];
```

### 2.1 Why No `analysisResult` in the Graph JSON

Analysis results are derived data -- volatile, potentially large (10-50KB per chart), and cause git diff noise on every commit. Instead:

- The graph JSON stores only the **recipe**. Each canvas chart adds ~300-500 bytes.
- The canvas chart component **computes on mount** via `graphComputeClient`, which has its own in-memory cache (5-minute TTL, 50-entry LRU).
- During DnD, the result travels in the drag payload for instant first render (see §5), then lives in component state.

On page refresh or graph re-open, each canvas chart triggers a compute call (~1-2s). The compute cache means rapid re-renders (tab switching, pan/zoom) are instant. If the backend is unavailable, charts show a "compute unavailable" placeholder.

### 2.2 Recipe Shape -- Shared Chart Definition Schema

The core of a chart definition -- "what to compute and how to display it" -- is the same regardless of where the chart lives (in its own file, embedded in a graph, or compressed in a share URL). Currently this is expressed three separate times with gratuitous field name divergence:

| Concern | Chart file (`ChartFileDataV1.recipe`) | Canvas analysis (`CanvasAnalysis.recipe`) | Share payload (`SharePayloadV1`) |
|---------|--------------------------------------|------------------------------------------|----------------------------------|
| Analytics DSL | `analysis.query_dsl` | `analysis.analytics_dsl` | `analysis.query_dsl` |
| Scenario ID | `scenarios[].scenario_id` | `scenarios[].scenario_id` | `scenarios.items[].id` |
| Scenario DSL | `scenarios[].effective_dsl` | `scenarios[].effective_dsl` | `scenarios.items[].dsl` |
| Hide current | `display.hide_current` | (on `CanvasAnalysis.display`) | `scenarios.hide_current` |

**Phase 3d should unify these into a single `ChartRecipeCore` schema** (TS interface, Python Pydantic model, JSON schema fragment) that all three contexts import:

```
ChartRecipeCore:
  analysis:
    analysis_type: string
    analytics_dsl?: string      ← single canonical name (retire query_dsl alias)
    what_if_dsl?: string
  scenarios?: Array<{
    scenario_id: string
    effective_dsl?: string
    name?: string
    colour?: string
    visibility_mode?: 'f+e' | 'f' | 'e'
    is_live?: boolean
  }>
```

Each context wraps `ChartRecipeCore` with its own contextual metadata:

- **Chart file** (`ChartFileDataV1`): adds `parent` (file/tab IDs), `pinned_recompute_eligible`, `deps`/`deps_signature`, `display.hide_current`, `payload` (cached result + scenario IDs)
- **Canvas analysis** (`CanvasAnalysis`): adds `id`, `x`, `y`, `width`, `height`, `live`, `view_mode`, `chart_kind`, `title`, `display` (extensible render settings including `hide_current`)
- **Share payload** (`SharePayloadV1`): adds `graph_state`, `chart.kind`, `chart.title`, scenario display metadata (`current`, `hide_current`, `selected_scenario_dsl`)

This means:
- "Open as Tab" from a canvas chart = wrap the chart's `ChartRecipeCore` with chart-file metadata (add `parent`, `pinned_recompute_eligible`)
- Live share from a canvas chart = wrap the chart's `ChartRecipeCore` with share-payload metadata (add `graph_state`, compress)
- No adapter, no field remapping, no new builder -- the same core travels between contexts

The JSON schema should define `ChartRecipeCore` as a `$ref`-able fragment that both the graph schema (`canvasAnalyses[].recipe`) and the chart file schema import rather than duplicating.

The `deps` / `deps_signature` / staleness system from chart files is not used by canvas charts -- live charts auto-refresh and frozen charts are intentionally static.

---

## 3. Scenario Handling -- Live vs Frozen

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

At the moment the user freezes the chart, the current scenario state is **serialised into `recipe.scenarios`** -- capturing `effective_dsl`, `name`, `colour`, `visibility_mode` for each visible scenario. `what_if_dsl` is captured in `recipe.analysis.what_if_dsl`. From this point, the chart computes from its frozen recipe and does not react to tab state changes.

The `effective_dsl` strings are self-contained -- they encode the full parameter state. The compute backend applies them directly without needing IDB scenario records. This is the same mechanism that powers pinned chart file recompute.

### 3.3 Freeze/Unfreeze Flow

1. Chart is `live: true`, `recipe.scenarios` absent → chart follows tab state
2. User clicks "Freeze" → current visible scenario state serialised into `recipe.scenarios`, current What-If into `recipe.analysis.what_if_dsl`, `live` set to `false`
3. Chart now computes from frozen recipe, ignoring tab changes
4. User clicks "Unfreeze" → `recipe.scenarios` cleared, `recipe.analysis.what_if_dsl` cleared, `live` set to `true`
5. Chart reverts to following tab scenarios

### 3.4 What Stays Fixed vs What Follows Tab State

| Input | Live mode | Frozen mode |
|-------|-----------|-------------|
| `analysis_type` | Fixed (from recipe -- defines the chart's identity) | Fixed (from recipe) |
| `analytics_dsl` | Fixed (from recipe -- defines which path/nodes/edges to analyse) | Fixed (from recipe) |
| `what_if_dsl` | **Live** -- from tab's `editorState.whatIfDSL` | **Frozen** -- from `recipe.analysis.what_if_dsl` |
| Graph structure/params | **Live** -- from `useGraphStore()` | **Live** -- still reads current graph structure (but does NOT re-compute automatically; computes once on mount) |
| Window / context / query state | **Live** -- from graph's `currentQueryDSL` via `useGraphStore()` | **Frozen** -- window at freeze time captured implicitly via `effective_dsl` |
| Visible scenarios | **Live** -- from `ScenariosContext` + tab `scenarioState` | **Frozen** -- from `recipe.scenarios` |
| Scenario params | **Live** -- from `ScenariosContext` (version-stamped) | **Frozen** -- from `recipe.scenarios[].effective_dsl` |
| Visibility modes (f/e/f+e) | **Live** -- from tab `scenarioState.visibilityMode` | **Frozen** -- from `recipe.scenarios[].visibility_mode` |

**Key distinction**: `recipe.analysis.analytics_dsl` captures the *analytics-specific* query -- which edges, nodes, or path the chart analyses (e.g., `from(550e8400-...).to(52207d6c-...)` for a funnel, or a specific edge for daily conversions). This is the chart's identity and is always fixed. It is deliberately named `analytics_dsl` (not `query_dsl`) to avoid confusion with `graph.currentQueryDSL` which carries the window/context state and flows through live.

**UUID stability**: the analytics DSL uses node UUIDs, not human-readable IDs. UUIDs are stable across renames; human IDs can change. If a referenced node is deleted from the graph, the compute will error for that analysis -- the chart shows an error state.

The *window and context* (e.g., `window(-90d:)`, `context(channel:google)`) are part of the graph's `currentQueryDSL`, which flows through because the chart reads the current graph from `useGraphStore()`. When the user changes the window selector, the graph state changes, triggering a live chart re-compute. For snapshot analyses, the new window determines which date range of snapshots is fetched.

---

## 3.5 Chart Props Exposure -- DSL Layering + Scenario-Sourced Compositor

Phase 3 introduced canvas analyses as a *live view* of tab state (when `live: true`) or a *portable frozen recipe* (when `live: false`). The next step is to improve how a chart's inputs are exposed and editable, without inventing new ergonomics.

This sub-phase establishes a single mental model:

- The canvas chart has an **analysis identity** (analysis DSL + analysis type).
- The chart's **data interest** is defined by a **query DSL compositor** that is conceptually the same as the scenarios palette.
- "Live vs frozen" is primarily a **source-of-truth boundary** for scenarios (tab vs graph), while DSL composition uses the **existing override + compositing patterns** already in the app.

### 3.5.1 Inputs to a Canvas Analysis

Canvas analyses rely on four categories of inputs:

1. **Analysis identity (analysis DSL)**: `recipe.analysis.analytics_dsl` -- which nodes/edges/path the analysis is about.
2. **Scenario compositor**: which scenario layers are used, and what DSL each layer resolves to.
3. **Chart type**: `chart_kind` -- how to visualise the analysis result (depends on identity + scenario compositor).
4. **Chart-specific display settings**: `display` -- render-only options (axis extents, orientation, legend, etc.), designed to grow over time.

This deliberately mirrors existing "layered" architecture:

- DSL compositing uses `augmentDSLWithConstraint()` and the scenario regeneration stack semantics (smart merge, context key replacement, date-mode exclusivity, explicit clear via empty clauses).
- Override UI uses the existing overridden-field pattern (`*_overridden` semantics and the `AutomatableField` affordance).

### 3.5.2 Analysis DSL (Editable) -- Reuse `QueryExpressionEditor`

The analysis DSL remains an editable field surfaced directly in the chart props panel. This already exists and is the correct direction: chart identity should be inspectable and adjustable.

**Implementation note (current behaviour + known UX bug):**
`QueryExpressionEditor` currently merges:

- Nodes/cases from the **loaded graph**, and
- Nodes/cases from the global **registry** (via `registryService.getItems('node'|'case')`),

and then uses the union for autocomplete suggestions. For canvas analysis identity editing this is confusing because it suggests many IDs that are not present in the loaded graph.

For this sub-phase the editor should default to **graph-scoped suggestions**, and only offer registry items via an explicit affordance (e.g. "Include registry suggestions" toggle, or a secondary picker). The goal is not to remove registry functionality globally, but to make the default behaviour match user expectation on the canvas surface.

### 3.5.3 Scenario Compositor -- The Chart's Query DSL is a "Current Layer"

The key conceptual move is to treat a chart's query DSL as a "Current layer" exactly like the scenarios palette:

- The graph provides an inherited DSL baseline (the user's current query/window/context choice).
- The chart optionally adds (or overrides) a DSL fragment representing the chart's *data interest*.
- Each scenario shown on the chart resolves to a distinct effective DSL via the existing compositor semantics.

This implies a natural UI and data model flow: show a scenario list (like the scenarios panel), but make clear what is inherited vs chart-owned.

#### Live mode -- "inherit tab scenarios; override only the chart's Current layer"

When `live: true`, the chart is still a view of the current tab. The scenario list remains tab-sourced, but the chart can apply a chart-specific "Current layer" DSL fragment.

Concretely:

- Scenario list is inherited from tab:
  - visible scenario IDs (tab `scenarioState.visibleScenarioIds`)
  - scenario colours/names (from `ScenariosContext`)
  - scenario visibility modes (tab `scenarioState` visibility mode)
- The chart exposes **one editable DSL field** (the chart's "Current layer" DSL fragment):
  - default: empty (pure inheritance)
  - override semantics: uses the same overridden-field affordance as elsewhere
  - composition semantics: applied via `augmentDSLWithConstraint()` (smart merge)

Interpretation:

- Editing the chart's "Current layer" DSL fragment does **not** change the graph's query DSL or the tab's scenarios.
- It changes only the DSL used for this chart's compute, and it should apply consistently to all scenarios on the chart (so multi-scenario comparisons remain coherent).

This gives the power you want ("this chart is about influencer channel regardless of what the graph is doing") while staying inside established patterns:

- The chart does not become a new scenario system.
- It reuses the existing DSL merge engine and override affordance.

#### Frozen / copied mode -- "scenarios are copied onto the chart; fully editable"

When `live: false`, scenarios become chart-owned and persisted in the graph via `recipe.scenarios`.

This is a true binary source boundary:

- **Live scenarios**: no scenario definitions stored on the chart (tab is the source of truth).
- **Copied scenarios**: the chart stores a complete scenario definitions array (the chart/graph is the source of truth).

In copied mode the scenario compositor UI should become fully editable. However, chart-owned scenarios are fundamentally **DSL-labelled entries**, not param-pack overlays. The recipe shape (`scenario_id`, `effective_dsl`, `name`, `colour`, `visibility_mode`) carries no `ScenarioParams` -- the compute backend derives parameters from the graph + DSL at compute time.

**Parallel comparisons, not incremental composition**: Unlike the scenarios palette (where scenarios are stacked overlays -- Base → Scenario 1 → Scenario 2 → Current, with later layers overriding earlier ones), chart-owned scenarios are **parallel peers**. Each scenario is an independent (graph, DSL) pair sent to the compute backend; results are rendered side by side. There is no incremental composition between chart scenarios.

Series order still matters -- it determines legend order, chart stacking/layering, and colour assignment -- but it does not affect the computed values. Each scenario's result is independent of its neighbours in the list.

This is a deliberate simplification for Phase 3d. The tab system's incremental composition relies on `ScenarioParams` (sparse param diffs that overlay onto each other). Storing param packs on the graph JSON would add 1-5KB per scenario and introduce staleness concerns (frozen params vs evolving graph structure). If users need frozen param-overlay comparisons, they keep the chart live (where the tab's full composition pipeline applies). A future phase could add optional `params` to the recipe scenario shape if this proves insufficient.

This distinction determines which scenario operations are meaningful on a chart:

**Meaningful operations (chart-owned scenarios):**

- Edit scenario name, colour -- display metadata, stored directly on `recipe.scenarios[i]`
- Edit scenario DSL (`effective_dsl`) -- the main edit affordance; uses `ScenarioQueryEditModal` (reused directly). The "inherited DSL" context in the modal would be the chart's baseline (graph `currentQueryDSL` at freeze time or the chart's own composed state) rather than the tab's `computeInheritedDSL` chain
- Toggle visibility mode (f+e / f / e) -- controls which probability layer the backend returns; already in the recipe shape
- Toggle visibility (show/hide) -- useful for temporarily hiding a scenario from compute without deleting it; stored as a boolean on the recipe entry
- Reorder scenarios -- controls legend/stacking order in multi-scenario charts
- Delete from chart -- remove from `recipe.scenarios`
- Add scenario -- creates a new `effective_dsl` entry with a name and colour; the user is saying "I want this chart to also compare with DSL X"
- Capture from tab -- import the current tab's scenario state (visible scenarios, their effective DSLs, colours, names, visibility modes) as new entries in `recipe.scenarios`. This is additive freeze: "add the tab's current comparisons to this chart." Reuses the same serialisation path as freeze
- Use as Current -- push this scenario's `effective_dsl` to the graph's `currentQueryDSL`. Cross-boundary operation: the user is saying "I like what this chart scenario is showing; apply that query to the whole graph"

**Operations that do NOT apply (and why):**

- **Put to Base** -- no incremental composition between chart scenarios; the chart-level DSL fragment (§3.5.7) serves the "change shared parameters uniformly" need instead
- **Flatten** -- no param-pack overlays to merge; chart scenarios are parallel peers, not a compositional stack
- **Create live scenario** -- live scenarios regenerate via `ScenariosContext` infrastructure; chart scenarios are self-contained and don't regenerate from source. The equivalent action is "Add scenario" (a new DSL entry)
- **Regenerate / Refresh from source** -- requires the full scenario regeneration pipeline; chart-level "Refresh" (recompute) already handles this
- **Open in ScenarioEditorModal** (param-pack YAML editor) -- chart scenarios carry no param packs; the editor would have nothing to show. The `ScenarioQueryEditModal` (DSL editor) is the correct affordance
- **Copy param packs** -- no param packs to copy
- **Share link** -- chart scenarios travel with the graph JSON; no need for a separate share mechanism
- **Merge down** -- operates on param overlays between stacked layers; chart scenarios are parallel peers with no incremental composition

**"Current" and "Base" on a chart:**

- `{ scenario_id: 'current' }` is always present -- it represents the graph with no scenario overlay, using the chart's effective DSL. Not deletable.
- `{ scenario_id: 'base' }` is present only if Base was visible at freeze time. It's just another DSL entry on the chart.

This analysis determines how the `ScenarioLayerList` extraction works: the shared component renders rows with the same visual language, but the **available context menu items and action buttons** are driven by which callbacks the parent provides. The chart properties section simply omits callbacks for operations that don't apply (no `onCapture`, no `onFlatten`, no `onOpenParamEditor`, etc.).

This should reuse the established Scenarios panel display language **by extracting the scenario layer list from `ScenariosPanel` into a shared component**.

`ScenariosPanel` currently contains three distinct concerns:

1. **Layer list rendering** -- scenario rows (colour swatch, name, visibility/mode toggles, DnD reorder, inline edit, context menu). This is the visual language. It is already data-driven: each row takes an id, name, colour, visibility state, mode, isLive flag, and callback handlers. The row doesn't care where the scenario came from.
2. **Sidebar chrome** -- header, "New Scenario" dropdown, Flatten, To Base, What-If panel, editor/query modals.
3. **Data source + handlers** -- reads from `ScenariosContext` + tab state; callbacks into context CRUD operations.

The generalisation is to extract concern (1) into a shared `ScenarioLayerList` component:

- Takes a normalised `ScenarioLayerItem[]` array (id, name, colour, visible, mode, isLive, tooltip).
- Takes optional callbacks: `onToggleVisibility`, `onCycleMode`, `onRename`, `onColourChange`, `onReorder`, `onDelete`, `onEdit`. Absent callbacks = feature suppressed.
- Renders Base row, user scenario rows, Current row using the existing CSS classes (`.scenario-row`, `.scenario-colour-swatch`, `.scenario-name`, etc.).
- DnD reorder logic already self-contained -- needs only an `onReorder(fromIndex, toIndex)` interface.

`ScenariosPanel` becomes a thin wrapper: it provides data from `ScenariosContext` + tab state, passes callbacks, and renders sidebar chrome around the shared list. No behaviour change.

The chart properties section becomes a second consumer: it provides data from either tab state (live mode, read-only) or `recipe.scenarios` (copied mode, editable), passes the appropriate callbacks, and renders chart-specific chrome (live/copied toggle, Current layer DSL fragment) around the same shared list.

Both surfaces get identical visual language, identical CSS, identical interaction affordances. No new display classes, no duplicated rendering logic.

### 3.5.4 Composition Semantics -- Reuse the Existing DSL Smart Merge

The compositor should reuse the existing DSL composition semantics already relied upon by scenarios:

- **Smart merge**: `augmentDSLWithConstraint(existing, addition)`
  - combines different constraint types
  - replaces same context key (e.g. `context(channel:influencer)` knocks out any inherited `context(channel:...)`)
  - preserves other context keys
  - enforces date-mode exclusivity (window vs cohort)
  - supports explicit clears via empty clauses (e.g. `context()`, `asat()`)

Where the chart needs a "replace vs augment" choice, it should follow the established pattern: default to augment; allow explicit replace for advanced use. The goal is to prevent new bespoke composition rules.

### 3.5.5 Chart Type Selector -- Reuse the Analysis Panel Card UI

Chart type selection (`chart_kind`) should remain driven by the computed result's chart semantics (recommended + alternatives). The UI should reuse the Analysis panel's card-based selector styling (the same class family used for analysis type selection), rather than introducing a new visual language.

Availability depends on:

- analysis identity (analysis type + analysis DSL)
- the scenario compositor state (number of scenarios visible, snapshot requirements, etc.)

### 3.5.6 Display Settings -- Extensible, Chart-Kind-Specific, Override-Friendly

Display settings will expand over time and must remain forward-compatible:

- Persist settings in `display` on the canvas analysis (not in the recipe)
- Keep schema permissive (Python `extra='allow'`, JSON schema `additionalProperties: true`)
- Render controls based on `chart_kind` via a shared registry (properties panel + context menu can both read it)

Many display settings naturally want an "auto vs manual" affordance (e.g. axis extents). Where this is true, the UI should use the existing overridden-field affordance (manual override toggles on; clearing returns to "auto").

### 3.5.7 Chart "Current Layer" Fragment -- Applies in Both Modes

The chart's "Current layer" DSL fragment applies **in both live and copied mode**. It composes via `augmentDSLWithConstraint()` uniformly across all scenarios, regardless of source.

- **Live mode**: composes onto each tab-sourced scenario's query DSL (from `getQueryDslForScenario()`).
- **Copied mode**: composes onto each chart-owned scenario's `effective_dsl`.

This is essential for copied mode ergonomics. Without it, changing a shared parameter (e.g. switching from a 30-day to a 90-day window) requires individually editing every scenario's `effective_dsl`. With the fragment, the user edits one field and the change applies uniformly -- the same "shared baseline" benefit that "Put to Base" provides in the tab system, without requiring the tab's regeneration infrastructure.

Because chart scenarios are parallel (not incrementally composed), the fragment is the only cross-scenario composition mechanism. Each scenario's final effective query is: `augmentDSLWithConstraint(scenario.effective_dsl, chartFragment)`. There is no inter-scenario layering.

**Injection point in the compute chain**: the chart fragment must be composed into the scenario's query DSL **before** it reaches `composeSnapshotDsl()` and the fetch plan builder. Concretely, in `useCanvasAnalysisCompute`, the `getQueryDslForScenario()` wrapper (live mode) or the per-scenario DSL resolution (copied mode) augments with the chart fragment before any downstream consumer sees it. This ensures snapshot subject resolution, date range extraction, and cache keys all reflect the chart's data interest.

**UX note**: the fragment lives on the analysis object (not on the recipe scenarios), so it survives freeze/unfreeze transitions. The user should be able to see and clear it in the properties panel in both modes.

### 3.5.8 What-If DSL -- Remains a Separate Channel

`what_if_dsl` is deliberately kept separate from the chart's Current layer DSL fragment. The existing codebase separates fetch-affecting parts (window, context, asat, cohort) from what-if parts (case, visited, exclude) via `splitDSLParts()`. This split matters because fetch parts determine which data to retrieve, while what-if parts are overlays applied after retrieval.

The chart's Current layer fragment addresses **data interest** (which context/window to use). What-If addresses **parameter overlays** (which case variants / visited constraints to apply). Merging them into a single fragment would conflate fetch with overlay and break the `splitDSLParts` architecture.

In live mode, What-If continues to flow from `editorState.whatIfDSL`. In copied mode, it is captured in `recipe.analysis.what_if_dsl` at freeze time. No change to the existing What-If channel.

---

## 4. Rendering

Canvas charts are ReactFlow nodes with `type: 'canvasChart'`, rendered in the **foreground tier** at z-index 2500 (above conversion nodes at 2000). Charts are prominent data displays that need to be readable -- they render above the graph, not below it.

ECharts renders into a `<div>` with a fixed pixel size. Inside a ReactFlow node, this works naturally -- the node has a fixed width/height in flow coordinates, and ECharts fills it. The viewport CSS `transform` handles zoom scaling.

### 4.1 Interaction Model -- Selected vs Unselected

- **Unselected** (z-index 2500): chart is visible and readable above nodes and edges. Tooltips and hover effects work normally. The chart may occlude conversion nodes behind it -- this is by design (the user chose to place it there; they can move it).
- **Selected** (z-index 3000): chart is above all other canvas objects. Useful when multiple foreground objects overlap.
- **Deselected**: drops back to z-index 2500.

### 4.2 Node Unmount/Remount

ReactFlow may unmount node components when they scroll off-screen (node virtualization, if enabled). When the node re-enters the viewport, the component remounts. The `useCanvasChartCompute` hook must handle this:

- If the compute client cache has a hit (within 5-minute TTL), the chart renders instantly on remount.
- If the cache has expired, a recompute triggers (~1-2s with loading skeleton).
- ECharts instances must be properly disposed on unmount (`chart.dispose()` in a cleanup `useEffect`) to prevent memory leaks.

### 4.3 Single Rendering Codepath

Canvas charts, chart tabs, and analytics panel previews all render through the same component: `AnalysisChartContainer`. This is the single chart kind router -- it takes an `AnalysisResult` and delegates to the appropriate ECharts component (`AnalysisFunnelBarEChart`, `AnalysisBridgeEChart`, etc.).

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

The **entire chart preview** is the drag area (`draggable="true"` on the wrapper div). This works because panel preview charts have no drag-based ECharts interactions in the common case -- tooltips work on hover (no conflict with `draggable`), and HTML5 drag only fires after a deliberate mousedown + movement threshold.

A **grip icon** (`GripVertical` from Lucide) in the top-right corner acts as a visual signal ("this is draggable") with cursor `grab`. Users can drag from anywhere on the chart, not just the icon.

When `compactControls: true` (always true in the analytics panel), `dataZoom` and `brush` are suppressed in the ECharts options to eliminate any conflict with HTML5 drag. The full tab view retains all interactive features.

`e.dataTransfer.setDragImage(chartWrapperElement, offsetX, offsetY)` captures the chart preview's DOM node as a bitmap snapshot -- the user sees the **actual chart** following the cursor during drag (semi-transparent, standard browser behaviour).

On drag start:

```
dataTransfer.setData('application/json', JSON.stringify({
  type: 'dagnet-drag',
  objectType: 'canvas-chart',
  chartKind: '...',
  recipe: { analysis: { analysis_type, analytics_dsl } },   // no scenarios -- live by default
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

## 6. Compute Hook -- `useCanvasChartCompute(recipe, live)`

Canvas chart nodes render inside the GraphEditor's component subtree and have access to `ScenariosContext` via `useScenariosContextOptional()`, the graph via `useGraphStore()`, and tab state via `TabContext`.

### 6.1 Live Mode Compute

1. Reads graph from `useGraphStore()` (includes `currentQueryDSL` for window/context)
2. Reads current visible scenarios, `baseParams`, `currentParams`, colours, visibility modes from `ScenariosContext` + tab `scenarioState`
3. For each visible scenario, calls `buildGraphForAnalysisLayer()` to build the scenario-specific graph
4. For DB-snapshot-backed analysis types (`lag_histogram`, `daily_conversions`, `cohort_maturity`): calls the shared DB-snapshot subject resolution service to resolve subjects from IDB using the current window and edge/path context
5. Calls `graphComputeClient.analyzeMultipleScenarios()` (or `analyzeSelection()` for single-scenario), passing DB-snapshot subjects where applicable
6. Re-runs when graph, `currentQueryDSL`, scenario state, or What-If state changes (debounced 2s)
7. Returns `{ result: AnalysisResult | null, loading: boolean, error: string | null }`

This is the same data flow as the AnalyticsPanel -- the chart is a live view of the current tab's analysis state.

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
- `currentQueryDSL` from GraphStore (window and context changes -- this is how the window selector drives chart updates)
- Visible scenario IDs and `version` stamps from ScenariosContext (scenario add/remove/edit)
- Scenario visibility modes from tab `scenarioState`
- `whatIfDSL` from tab `editorState`

Changes trigger a **2-second trailing debounce**. During compute, a loading overlay appears on the chart. If the compute fails, the chart retains its last successful result and shows an error badge.

**Rate limiting**: debounce is per-chart. With 3 live charts, a DSL change triggers 3 debounced computes -- each potentially a cache hit (same graph + DSL = same cache key). The compute client deduplicates via its LRU cache.

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

This section is intentionally structured into four UI sections that match the chart input model.

#### Section 1 -- Analysis DSL (Editable)

- Editable analysis identity:
  - analysis DSL (`recipe.analysis.analytics_dsl`) using `QueryExpressionEditor`
  - analysis type (`recipe.analysis.analysis_type`) using the same card-based selector UI already used in the Analytics panel
- Default autocomplete should be graph-scoped (see §3.5.2 known UX issue); registry suggestions should be opt-in.

#### Section 2 -- Scenario Source + Per-Field Overrides

**Design decision (6-Mar-26)**: "Frozen/live" replaced by per-field override semantics. Scenario source is the one binary toggle; all other chart fields use per-field `_overridden` + `AutomatableField`, matching the existing node/edge override pattern.

| Dimension | Auto/inherited | Overridden/owned |
|---|---|---|
| Scenarios | Follow tab visibility + context | Chart owns `recipe.scenarios` array |
| Analytics DSL | From drag source / graph selection | User-edited (`analytics_dsl_overridden`) |
| Query DSL fragment | Absent | Present (composes onto all scenarios) |
| Chart kind | Auto from `result.semantics.chart` | User-pinned (`chart_kind_overridden`) |
| Display settings | Registry defaults | Per-setting user values |

**Scenario source toggle**: "Following tab" / "Chart-owned"

- Following tab: read-only scenario list via `ScenarioLayerList` (from tab state)
- Chart-owned: editable scenario list via `ScenarioLayerList` (from `recipe.scenarios`) -- edit name, colour, visibility mode, DSL; reorder; delete
- "Capture from tab": copies visible tab scenarios into `recipe.scenarios`
- "Return to tab": clears `recipe.scenarios`

**Chart DSL fragment** (`chart_current_layer_dsl`): applies in both modes via `augmentDSLWithConstraint()`. Wrapped in `AutomatableField`. Survives source transitions.

**Node badge**: LIVE (green) when scenarios follow tab AND no chart fragment. CUSTOM (amber) otherwise. This is the glanceable data-level indicator -- it tells the user whether this chart is computing something different from what the tab would give.

**Display settings overrides** are tracked separately in Section 4 header (e.g. "2 overrides" + "clear overrides"). These are cosmetic and don't affect the LIVE/CUSTOM badge. "Reset all settings" in props panel clears the entire `display` object back to auto.

#### Section 3 -- Chart Type Selector (Chart Kind)

- A selector for `chart_kind` driven by `result.semantics.chart` (recommended + alternatives).
- Styling reuses the analysis panel's card-based selection language.
- Wrapped in `AutomatableField` -- auto (follows result semantics) or overridden (user-pinned). When overridden, shows `ZapOff` indicator.

#### Section 4 -- Chart-Specific Display Settings

- Chart-kind-specific settings stored in `display` (extensible, forward-compatible).
- Designed for long-term growth: axis extents, horizontal vs vertical layouts, legend toggles, confidence levels, etc.
- Settings with `overridable: true` in the registry are wrapped in `AutomatableField` -- null = auto, non-null = manual override.
- Override count contributes to the section header badge.

### 9.2 Read-Only Fields

Read-only fields are informational, intended to help users understand "what this chart is doing" at a glance even when the editable controls are collapsed.

- **Effective chart identity summary**: analysis type + analysis DSL
- **Scenario sourcing summary**:
  - live mode: "Following tab scenarios"
  - copied mode: "Scenarios stored on chart"
  - in copied mode, show warnings if any persisted `effective_dsl` fails to compute against the current graph

### 9.3 Action Buttons

- **Refresh** -- manual one-shot recompute (useful when live mode is off, or to force a refresh)
- **Open as Tab** -- opens the chart in a full tab with all ChartViewer features
- **Delete** -- removes the chart from the graph

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
| New graph (not yet in git) | Standard -- canvas charts don't care about git state | Standard |
| Dirty graph (modified, not committed) | Standard -- works from GraphStore | Standard |
| Fresh clone (no IDB scenario records) | Computes for "current" only (no scenarios in context). **DB-snapshot-backed charts** (lag, daily, cohort): snapshot data may not yet be in IDB on a fresh clone -- chart shows "no data available" until the user runs a data fetch (daily fetch or manual retrieve). Computed charts (funnel, bridge, etc.) work normally. | Computes from `recipe.scenarios[].effective_dsl` -- self-contained, no IDB scenario dependency. DB-snapshot data availability same as live. |
| Fresh clone + user creates scenarios | Live chart picks up new scenarios as they're added to visibility | Not affected |
| Graph merge (two users both added canvas charts) | Standard 3-way merge on `canvasCharts[]` array | Standard |

### 10.4 By Chart Mode

| Scenario | Behaviour |
|----------|-----------|
| Live chart, user changes window via window selector | Graph's `currentQueryDSL` changes → graph state changes → live chart re-computes with new window. The chart's analytics DSL (`recipe.analysis.analytics_dsl` -- from/to path) stays fixed; the window flows through the graph state. For DB-snapshot-backed charts, the new window triggers DB-snapshot subject re-resolution for the new date range. |
| Live chart, user changes graph structure (add/rename/delete nodes) | Chart re-computes with new graph structure. If `recipe.analysis.analytics_dsl` references deleted nodes, compute may error. |
| Frozen chart, graph structure changes | Does not re-compute. If user manually refreshes, the compute uses the frozen `effective_dsl` against the new graph structure -- may error for scenarios referencing deleted nodes. |
| Canvas chart + undo/redo | All mutations go through `setGraph` + `saveHistoryState`. Undo restores previous graph snapshot. Undo of a freeze restores `recipe.scenarios` to absent. Live charts re-compute from restored state. |
| Canvas chart + commit/push | `canvasCharts[]` committed as part of graph JSON. Live charts: ~200 bytes (no scenarios). Frozen charts: ~500 bytes (includes effective_dsl). Clean diffs. |
| Backend unavailable | Loading skeleton → timeout → "Analysis backend unavailable" placeholder. Recipe preserved. User can retry when backend returns. |
| Canvas chart in read-only/share mode | Computes normally (read-only operation). Edits (move, resize, freeze) blocked by share mode permissions. |

---

## 11. Supported Analysis Types

All analysis types are in scope for Phase 3 -- both computed analyses (funnel, bridge, path) and DB-snapshot-backed analyses (lag histogram, daily conversions, cohort maturity). The primary use case for canvas charts -- pinning "daily conversions" or "cohort maturity" charts for key params -- requires DB-snapshot-backed analysis support from day one.

**Terminology note** (see architecture doc §8): "snapshot" here means **DB data snapshots** stored in IndexedDB -- fetched from external sources and used by the compute backend. It does NOT mean "static/non-live scenarios."

### 11.1 DB-Snapshot-Backed Analysis Prerequisite

DB-snapshot-backed analyses (`lag_histogram`, `daily_conversions`, `cohort_maturity`) require `snapshotSubjects` resolution: composing the analytics DSL with the current window, resolving edge subjects via `snapshotDependencyPlanService`, computing core hashes, and reading snapshot data from IDB.

This logic is currently embedded as a ~100-line inline function (`resolveSnapshotSubjectsForScenario`) in `AnalyticsPanel.tsx`. **Extracting this into a shared service is a prerequisite for Phase 3a.** The extraction is bounded work -- the function is self-contained and only needs to be moved to a service that both the AnalyticsPanel and `useCanvasChartCompute` can call.

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
| Chart rendering consolidation (single rendering surface, shared chrome) | **Phase 3d** | |
| Result cards DnD from analytics panel | **Phase 3e** | |
| Chart definition schema unification + props exposure + scenario compositor UI | **Phase 3f** | |
| Canvas chart result persistence in IDB | | **No** -- compute on demand |
| Canvas chart as separate git-tracked file | | **No** -- lives in graph JSON |

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

### Phase 3f: Chart definition schema unification + props exposure + scenario compositor UI

See [implementation-plan.md](implementation-plan.md) Phase 3f for full file lists, test invariants, and Playwright specs.

This phase unifies the chart definition schema and improves chart prop exposure by reusing established patterns rather than inventing new systems.

**Schema unification (prerequisite):**

- Extract `ChartRecipeCore` as a shared TS interface, Python Pydantic model, and JSON schema `$ref` fragment (§2.2)
- Migrate `ChartFileDataV1.recipe` to wrap `ChartRecipeCore` (add `parent`, `pinned_recompute_eligible`)
- Migrate `CanvasAnalysis.recipe` to use `ChartRecipeCore` directly
- Unify field names: retire `query_dsl` alias in favour of `analytics_dsl`; align scenario field names across chart file, canvas analysis, and share payload
- Generalise `shareLinkService` to accept a `ChartRecipeCore` + identity, rather than reading from chart file internals -- enables canvas analysis live share without a new builder
- Generalise `chartOperationsService.openAnalysisChartTabFromAnalysis` to accept a `ChartRecipeCore` -- enables "Open as Tab" from canvas analysis without field remapping
- Run schema parity tests after migration

**ScenarioLayerList extraction:**

- Extract shared layer-list rendering component from `ScenariosPanel` (rows, swatches, DnD, inline edit, context menu)
- `ScenariosPanel` becomes a thin wrapper (sidebar chrome + `ScenariosContext` data source)
- Chart properties section becomes a second consumer (chart chrome + tab or recipe data source)

**Properties panel restructure:**

- Four sections per §3.5 and §9: analysis DSL, scenario compositor, chart kind, display settings
- Scenario compositor:
  - Live mode: display tab scenarios read-only via `ScenarioLayerList` + chart "Current layer" DSL fragment (§3.5.7)
  - Copied mode: display chart-owned `recipe.scenarios` via `ScenarioLayerList` with edit callbacks (name/colour/mode/DSL/reorder/add/capture-from-tab/use-as-current); chart scenarios are parallel peers, not incrementally composed (§3.5.3)
  - `ScenarioQueryEditModal` reused for DSL editing in both modes

**DSL composition:**

- Reuse `augmentDSLWithConstraint()` for smart merge semantics (no bespoke merge rules)
- Chart fragment injected before `composeSnapshotDsl()` in both live and copied mode (§3.5.7)
- What-If DSL remains a separate channel (§3.5.8)

**QueryExpressionEditor UX:**

- Add `suggestionsScope` prop (default graph-scoped for canvas analysis surface)
- Make registry suggestions opt-in for this surface

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

- Standard canvas object tests per architecture doc §9.2--9.4, adapted for canvas charts

### 14.7 Chart Props Exposure / Compositor (Phase 3f)

See [implementation-plan.md](implementation-plan.md) Phase 3f for full test invariant list. Key invariants:

- `ChartRecipeCore` schema parity across TS / Python / JSON schema
- Chart fragment composition in live and copied mode (window/context smart merge, snapshot subject resolution)
- `ScenarioLayerList`: absent callbacks suppress affordances; DnD reorder fires correct indices
- Copied-mode scenario CRUD: edit DSL, rename, reorder, delete, capture from tab, use as current
- Share payload from canvas analysis recipe → correct field names, round-trip fidelity
- "Open as Tab" from canvas analysis → chart file with correct `ChartRecipeCore` wrapper
- `QueryExpressionEditor` graph-scoped suggestions for this surface

### 14.8 Schema Parity

- Extend `schemaParityAutomated.test.ts` to cover `CanvasAnalysis` + `CanvasAnalysisDisplay` + `ChartRecipeCore` + `ChartRecipeScenario` fields
- Verify `CanvasAnalysisDisplay` round-trips unknown fields (Python `extra='allow'`)
- Verify `ChartRecipeCore` is structurally identical when used from `CanvasAnalysis.recipe` vs `ChartFileDataV1.recipe`

---

## 15. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| ECharts performance -- multiple live instances | Medium | Medium | Use `renderer: 'canvas'` for lighter DOM. Recommend max ~5 canvas charts. Consider `lazyUpdate: true`. |
| First-render compute delay on graph open | High (by design) | Low | Loading skeleton is acceptable for 1-2s. Compute cache eliminates delay for repeated renders. |
| Backend unavailable | Medium | Medium | Placeholder message. Charts are supplementary -- not critical to graph editing. |
| Recipe DSL invalid after graph restructure | Medium | Low | Compute returns error; chart shows error state. User can delete or recreate. |
| Frozen scenario DSL invalid after restructure | Low | Low | That scenario errors; chart renders remaining scenarios. |
| DnD payload size | Low | Low | Results typically 5-50KB. `dataTransfer` handles this in all modern browsers. |
| Zoom scaling makes ECharts blurry | Medium | Low | CSS-transformed canvas elements slightly soft at high zoom. Acceptable for Phase 3. |
| Tab state access from ReactFlow node component | Medium | Medium | Node needs `tabId` for scenario state. Pass via node `data` or dedicated context. Verify during Phase 3a. |
