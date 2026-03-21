# Phase 7: Container/Content Split — Tabs as First-Class Canvas Objects

**Status**: Design — not started
**Date**: 20-Mar-26
**Prerequisite**: Phases 1–3 complete (canvas analyses exist and are draggable);
Phase 5 snap-to alignment guides (conceptual foundation for snap grouping)

---

## 1. Problem Statement

Canvas analysis objects currently conflate two concerns:

1. **Container** — position, size, data source (DSL), scenario policy
2. **Content** — what to render (analysis type, chart kind, facet, display settings)

This conflation causes several problems:

- **Tabs are buried inside AnalysisInfoCard** as a rendering detail, not
  exposed in the data model. The user cannot drag a tab out, snap it to
  another object, or promote it independently.
- **Scroll nesting** — the tab bar scrolls away with content because
  scroll containers are nested three deep (preview body → wrapper div →
  tab panel). Fixing this symptomatically is fragile; the real fix is
  structural.
- **Title headlines the analysis type** ("Cohort Maturity") rather than
  the data subject ("Household created → Delegated"), which is what the
  container actually owns.
- **"Open as Tab"** only works for the whole analysis, not for
  individual facets.
- **Snapshot calendar and other per-tab extras** (e.g. `infoTabExtra`)
  are lost during drag-to-pin because the drag payload has no concept of
  individual content items.

---

## 2. Design Principle

A canvas object is a **container** that owns a data source. Inside it
live one or more **content items**, each of which is a lens onto that
data. Content items can be moved between containers, extracted as new
containers, or promoted to editor tabs independently.

The tab bar is an emergent UI element: it appears when a container holds
multiple content items, and disappears when only one remains.

---

## 3. Data Model

### 3.1 Current (flat)

```
CanvasAnalysis (extends ChartDefinition)
├── id, x, y, width, height                    ← container
├── mode ('live'|'custom'|'fixed')              ← container
├── recipe.analysis.analytics_dsl               ← container (data source)
├── recipe.analysis.analysis_type               ← content
├── recipe.scenarios[]                          ← container
├── view_mode ('chart'|'cards')                 ← content
├── chart_kind                                  ← content
├── display {}                                  ← content
├── title                                       ← ambiguous
├── analysis_type_overridden                    ← content
└── chart_current_layer_dsl                     ← container (diagnostic)
```

### 3.2 Proposed (split)

**Container** — the ReactFlow node. Owns position, data source, scenario
policy.

```typescript
interface CanvasObjectContainer {
  id: string;                          // UUID
  x: number;                          // canvas position
  y: number;
  width: number;
  height: number;
  mode: CanvasAnalysisMode;           // 'live' | 'custom' | 'fixed'
  dsl: string;                        // analytics DSL — data source identity
  scenarios?: ChartRecipeScenario[];  // scenario policy (absent when live)
  content_items: ContentItem[];       // ordered list of content inside
  chart_current_layer_dsl?: string;   // diagnostic: composed query DSL
}
```

**ContentItem** — what is rendered inside a container. Each content item
is independently renderable.

```typescript
interface ContentItem {
  id: string;                          // UUID — stable across drag/reorder
  analysis_type: string;               // 'edge_info', 'cohort_maturity', etc.
  view_type: 'chart' | 'card';        // how to render
  chart_kind?: string;                 // which chart variant (when view_type = 'chart')
  facet?: string;                      // 'overview' | 'evidence' | 'forecast' | ...
  display?: Record<string, unknown>;   // font_size, scale_with_canvas, etc.
  title?: string;                      // per-content label override
  analysis_type_overridden?: boolean;
}
```

**On ConversionGraph** — the array name stays `canvasAnalyses` for
backward compatibility during migration:

```typescript
canvasAnalyses?: CanvasObjectContainer[];
```

### 3.3 Key design decisions

**The container knows nothing about what is inside it.** It owns
position, size, DSL, and scenario policy. It does not know analysis
types, facets, or display settings. A hover preview container is just a
pre-grouped collection of content items — no different from a container
the user assembles manually by dragging tabs together.

**Each content item owns its own `analysis_type`.** A single container
can hold an evidence card (from `edge_info`) alongside a cohort maturity
chart — both pointing at the same DSL. This is more flexible than
constraining a container to one analysis type.

**Position and size live at container level only.** Content items have
no position or size — they fill the container's content area. When a
content item is extracted from a container, it gets a new container
with position/size inherited from the source.

**Compute is per content item**, not per container. Each content item
independently triggers its own compute when it becomes the active tab.
Multiple content items with the same `analysis_type` in one container
share a cached result (the existing compute cache handles this).
FE-computed types (`node_info`, `edge_info`) are instant; backend types
use the existing LRU cache. Content items that need time to fetch
render their own loading state — the container does not wait for all
items to resolve before rendering.

**Content items are created at construction time, not derived from
results at render time.** When a container is created (hover preview
or pinned), the system determines which content items are appropriate
for the DSL and creates them all up front. Each content item then
independently computes/renders when it becomes the active tab. If a
content item's compute returns no data (e.g. no posteriors → forecast
tab is empty), it can render "No data" or be hidden from the tab bar
at render time via a dynamic visibility check.

**`facet` is optional.** A chart-type content item has no facet. A
card-type content item may have a facet (`'evidence'`, `'overview'`,
etc.) which filters the info card data to that section. When facet is
absent, all sections render (backward-compatible with current
`AnalysisInfoCard` behaviour).

---

## 4. Title and Chrome

### 4.1 Container title

The container title headlines the **data subject**, derived from the
DSL:

- **Edge DSL** (`from(a).to(b)`): "Node A → Node B" (resolved from
  `graph.nodes`)
- **Node DSL** (`node(a)`): "Node A"
- **Path DSL** (`from(a).via(b).to(c)`): "Node A → … → Node C"

The subject label is a pure derivation from DSL + graph node names. No
new data stored.

### 4.2 Single content item (folded title)

When a container holds one content item, the tab bar is hidden. The
container title folds to:

```
┌─ Household created — Cohort Maturity ▾ ──────┐
│                                               │
│  ... content ...                              │
│                                               │
└───────────────────────────────────────────────┘
```

The `▾` dropdown on the analysis type portion opens an analysis type
picker, allowing the user to **replace** the current content item's type
without adding/removing tabs.

A subtle `+` button after the dropdown allows adding a second content
item, which immediately transitions to the multi-tab layout.

### 4.3 Multiple content items (tab bar)

When a container holds multiple content items, a tab bar appears below
the title:

```
┌─ Household created ──────────────────────────┐
│ [Cohort Maturity ×] [Evidence ×] [Forecast ×] [+] │
│                                               │
│  ... active tab content ...                   │
│                                               │
└───────────────────────────────────────────────┘
```

- Each tab shows the content item's label (analysis type or facet name)
- `×` appears on hover for each tab — removes that content item
- `+` tab at the end opens the analysis type picker to add a new content
  item
- Tabs can be reordered by dragging within the bar
- Each tab label has a `▾` dropdown to change that content item's
  analysis type in-place

### 4.4 Transition between states

| Action | From | To |
|---|---|---|
| User clicks `+` or adds via dropdown | 1 content item | 2+ items: tab bar appears, title shortens to subject only |
| User `×`'s down to 1 content item | 2+ items | 1 item: tab bar disappears, title folds to "Subject — Type ▾" |
| User `×`'s last content item | 1 item | Container self-destructs (equivalent to delete) |

---

## 5. Drag Interactions

### 5.1 Tab drag gestures

Three drag gestures from a tab within a multi-tab container:

| Gesture | Target | Effect |
|---|---|---|
| Drag tab → canvas (empty space) | Canvas | **Move**: new container (inherits DSL + scenarios), source loses content item |
| Drag tab → existing container | Container tab bar | **Move**: content item adopts target container's DSL, source loses it |
| Ctrl+drag → anywhere | Canvas or container | **Duplicate**: copy of content item; source keeps original |

### 5.2 Last-tab-out rules

| Last tab dragged to | Effect |
|---|---|
| Canvas (empty space) | **Container moves** — degenerates to a reposition, no destroy/create cycle |
| Another container | **Content moves** into target, source container self-destructs |
| Ctrl+drag anywhere | **Duplicate** — source stays put (still has its one tab) |

### 5.3 Distinguishing tab-reorder from tab-extract

The drag gesture must distinguish "reorder within the tab bar" from
"extract to canvas". The heuristic:

- **Reorder**: pointer stays within the tab bar's vertical extent during
  drag. Tab slides horizontally among siblings.
- **Extract**: pointer exits the tab bar vertically (moves above or
  below by > N pixels). A ghost preview appears and the content item
  enters free drag mode.

This is the same pattern used by Chrome/Firefox for tab tear-off.

### 5.4 Whole-preview drag (hover preview)

When dragging the whole hover preview (not a specific tab) to the
canvas, the system creates a container with all content items that make
sense for that DSL. Content items are created up front at construction
time — each one independently computes/renders when it becomes the
active tab:

- **Edge info hover preview**: container with content items for each
  facet (overview, structure, evidence, forecast, diagnostics). All are
  created regardless of whether data exists yet — the content item's
  own render handles loading/empty states.
- **Node info hover preview**: same pattern
- **Chart hover preview**: container with one content item (the chart)

The hover preview itself is also a container (transient, not persisted).
When it pops up on edge hover, it creates the same set of content items.
Pinning to canvas simply persists the container and its content items
to the graph. The hover preview and the pinned canvas object are the
same data structure — one is ephemeral, the other is saved.

### 5.5 Drag payload revision

`buildPinDragData()` currently builds a flat payload. The revised
payload separates container and content concerns:

```typescript
interface PinDragPayload {
  type: 'dagnet-drag';
  objectType: 'canvas-analysis';
  // Container-level
  dsl: string;
  // Content-level (one or more items)
  contentItems: Array<{
    analysis_type: string;
    view_type: 'chart' | 'card';
    chart_kind?: string;
    facet?: string;
    display?: Record<string, unknown>;
  }>;
  // Layout hints
  drawWidth: number;
  drawHeight: number;
  // Cached result for instant first render
  analysisResult?: AnalysisResult;
}
```

---

## 6. Rendering Architecture

### 6.1 CanvasAnalysisNode changes

`CanvasAnalysisNode` becomes the container renderer:

- Renders the subject title in the header
- If `content_items.length === 1`: renders content directly, folded
  title with `▾` dropdown and `+` button
- If `content_items.length > 1`: renders tab bar at the node level
  (not inside AnalysisInfoCard), active content below
- Tab bar is a sibling of the content area, both inside the ReactFlow
  node — no nested scroll containers

### 6.2 Scroll structure (fixes the original bug)

```
CanvasAnalysisNode (ReactFlow node, flex column)
├── Header (subject title, flex-shrink: 0)
├── Tab bar (flex-shrink: 0, only if multiple items)
└── Content area (flex: 1, overflow-y: auto)
    └── Active content item renderer
```

Only the content area scrolls. The header and tab bar are pinned. This
eliminates the three-nested-scroll-containers problem entirely.

### 6.3 AnalysisInfoCard simplification

`AnalysisInfoCard` loses its `TabbedContainer`. It receives a `facet`
prop and filters its data rows to that facet. When `facet` is absent, it
renders all rows (backward compatibility for non-canvas contexts, e.g.
analytics panel sidebar).

The tab chrome (tab bar, tab switching, tab hover) moves up to
`CanvasAnalysisNode`.

### 6.4 Content item renderers

Each content item delegates to the appropriate renderer based on
`view_type`:

| `view_type` | Renderer | Notes |
|---|---|---|
| `'chart'` | ECharts via `AnalysisChartContainer` | Same as today |
| `'card'` | `AnalysisInfoCard` with `facet` prop | Filtered to one section |

The `AnalysisChartContainer` still handles chart kind resolution,
display settings, and scenario rendering. It just no longer needs to
handle the info card tab switching — that's been promoted to the
container level.

---

## 7. "Open as Tab" Generalisation

### 7.1 Current behaviour

"Open as Tab" on a canvas analysis creates a chart file tab containing
the whole analysis. The `ChartRecipeCore` is serialised from the canvas
analysis into a chart file with added `parent` and
`pinned_recompute_eligible` fields.

### 7.2 Revised behaviour

Any individual content item can be opened as an editor tab:

- Right-click a tab → "Open as Tab" — creates an editor tab for that
  specific content item (analysis type, chart kind, facet, display)
- The DSL is baked from the container into the chart file recipe
- The content item stays in the canvas container (it is a copy, not a
  move)

### 7.3 Editor tab bar and rc-dock

The editor tab bar operates in normal DOM space (no canvas transforms).
This is the appropriate level for a docking library (rc-dock, dockview,
or similar) if split-view, tab reordering, or dock-to-edge features are
desired.

rc-dock and similar libraries assume untransformed coordinate space,
which makes them unsuitable for canvas-level tab management but
well-suited for editor-level tab management. The two layers use
different tools:

| Layer | Coordinate space | Tool |
|---|---|---|
| **Canvas** (container/content) | ReactFlow transformed | Custom ReactFlow node rendering |
| **Editor** (tab bar, split views) | Normal DOM | Existing custom tabs, or rc-dock if split-view is desired |

A content item can move between layers:

- **Canvas → Editor**: "Open as Tab" — copies content item to editor tab
- **Editor → Canvas**: drag editor tab onto canvas — creates new
  container with that content item (future, not required for initial
  implementation)

---

## 8. Snap Grouping (Future — Deferred)

Snap grouping allows containers to dock to each other spatially, forming
a visual group. This extends Phase 5's alignment guides from
"snap during drag" to "maintain spatial relationship".

This is a general canvas feature, not specific to the container/content
split. The container/content split enables it (tabs can be extracted and
re-snapped) but does not require it for initial delivery.

Design to be written separately when the container/content split is
stable.

---

## 9. Migration

### 9.1 Backward compatibility

Existing `CanvasAnalysis` objects in saved graphs have the flat
structure. On load, the migration is mechanical:

```
Flat CanvasAnalysis → CanvasObjectContainer:
  - id, x, y, width, height, mode  → container (unchanged)
  - recipe.analysis.analytics_dsl  → container.dsl
  - recipe.scenarios               → container.scenarios
  - recipe.analysis.analysis_type  → content_items[0].analysis_type
  - view_mode                      → content_items[0].view_type
  - chart_kind                     → content_items[0].chart_kind
  - display                        → content_items[0].display
  - title                          → content_items[0].title
  - analysis_type_overridden       → content_items[0].analysis_type_overridden
```

This produces a container with one content item — behaviourally
identical to the current rendering.

### 9.2 Python Pydantic model

```python
class ContentItem(BaseModel):
    id: str
    analysis_type: str = ""
    view_type: Literal["chart", "card"] = "chart"
    chart_kind: str | None = None
    facet: str | None = None
    display: dict[str, Any] = Field(default_factory=dict)
    title: str | None = None
    analysis_type_overridden: bool | None = None

    class Config:
        extra = "allow"

class CanvasObjectContainer(BaseModel):
    id: str
    x: float
    y: float
    width: float
    height: float
    mode: Literal["live", "custom", "fixed"] = "live"
    dsl: str = ""
    scenarios: list[dict[str, Any]] = Field(default_factory=list)
    content_items: list[ContentItem] = Field(default_factory=list)
    chart_current_layer_dsl: str | None = None

    class Config:
        extra = "allow"
```

### 9.3 YAML schema

The JSON schema for `canvasAnalyses[]` items gains `content_items` as
a required array and `dsl` as a required string. The flat fields
(`view_mode`, `chart_kind`, `recipe.analysis.analysis_type`, `display`,
`title`) become deprecated aliases resolved during migration.

---

## 10. Implementation Phases

### 10a: Data model split + single-content-item parity

- Define `ContentItem` and `CanvasObjectContainer` types
- Write migration function (flat → split)
- Update `buildCanvasAnalysisObject`, `createCanvasAnalysisInGraph`
- Update `CanvasAnalysisNode` to read from `content_items[0]`
- Update mutation service
- All existing behaviour preserved — no visible change to user
- **Exit criterion**: all existing canvas analysis tests pass with new
  data model

### 10b: Tab bar at container level

- Move tab rendering from `AnalysisInfoCard` / `TabbedContainer` to
  `CanvasAnalysisNode`
- Add `facet` prop to `AnalysisInfoCard`
- Multi-content-item rendering with tab bar
- `+` tab, `×` on hover, tab reorder within bar
- **Exit criterion**: edge info hover preview pinned to canvas shows
  working tabs at the container level; scroll bug is fixed

### 10c: Tab drag-out and merge

- Tab extract gesture (vertical exit from tab bar)
- Drag to canvas: create new container
- Drag to existing container: merge content item
- Ctrl+drag: duplicate
- Last-tab-out degenerate cases
- **Exit criterion**: content items can be freely moved between
  containers

### 10d: Title and chrome revision

- Container title derived from DSL (subject label)
- Folded single-tab title with `▾` dropdown
- Analysis type picker in dropdown and `+` tab
- **Exit criterion**: titles show data subjects; type switching works

### 10e: Open as Tab generalisation

- Per-content-item "Open as Tab" in tab context menu
- DSL baked from container into chart file recipe
- **Exit criterion**: individual facets can be opened as editor tabs

---

## 11. Files Affected

| File | Change |
|---|---|
| `src/types/index.ts` | `ContentItem` interface, revised `CanvasAnalysis` / `CanvasObjectContainer` |
| `src/types/chartRecipe.ts` | Possible `ChartRecipeCore` adjustments |
| `src/services/canvasAnalysisCreationService.ts` | `buildCanvasAnalysisObject` creates container + content item |
| `src/services/canvasAnalysisMutationService.ts` | Mutations operate on content items within containers |
| `src/components/nodes/CanvasAnalysisNode.tsx` | Tab bar rendering, content item switching, drag-out handlers |
| `src/components/analytics/AnalysisInfoCard.tsx` | Remove `TabbedContainer`, add `facet` prop |
| `src/components/shared/TabbedContainer.tsx` | Retained for non-canvas use (analytics panel sidebar) |
| `src/components/HoverAnalysisPreview.tsx` | `buildPinDragData` revised for container/content payload |
| `src/components/canvas/creationTools.ts` | `createCanvasAnalysisInGraph` handles new payload shape |
| `src/components/charts/AnalysisChartContainer.tsx` | Remove info card wrapper div scroll; content area owns scroll |
| `src/components/CanvasAnalysisContextMenu.tsx` | Per-tab context menu, "Open as Tab" per content item |
| `src/hooks/useCanvasAnalysisCompute.ts` | Receives `{ dsl, analysis_type }` per content item |
| `lib/graph_types.py` | `ContentItem` and `CanvasObjectContainer` Pydantic models |
| `src/styles/components-dark.css` | Tab bar styles at container level |

---

## 12. Relationship to Other Docs

- **Phase 3 (canvas analyses)**: this doc supersedes the data model
  section (§2) and rendering sections of Phase 3. Phase 3's scenario
  handling (§3), creation flow (§5), and "Open as Tab" (§7) are revised
  here.
- **Phase 5 (snap-to)**: alignment guides remain as designed. Snap
  grouping (containers docking to each other) is deferred to a future
  doc.
- **Phase 6 (tristate scenario mode)**: scenario mode (`live` /
  `custom` / `fixed`) stays at container level. No change to mode
  cycling logic.
