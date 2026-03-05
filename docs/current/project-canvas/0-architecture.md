# Canvas Annotation Layer — Architecture

**Status**: Design — ready for implementation  
**Date**: 5-Mar-26  
**Scope**: Shared rendering, transform, selection, clipboard, schema, and test architecture for all canvas object types

---

## 1. Overview

Canvas objects are visual elements that live inside the graph JSON — they pan, zoom, drag, and resize as part of the canvas. They do not participate in graph semantics (probability calculations, daily fetch, Bayesian engine) but they ARE first-class selectable, copyable, deletable objects that integrate with all standard edit operations.

Three canvas object types are planned:

| Type | Phase | Visual tier | Purpose |
|------|-------|-------------|---------|
| Post-it note | Phase 1 | Annotation (above nodes) | Coloured sticky note with editable text |
| Container | Phase 2 | Annotation (above nodes) | Labelled rectangle; group-drags contained nodes |
| Canvas analysis | Phase 3 | Foreground (above annotations) | Live analysis pinned to the canvas — chart or result card view |

Canvas objects share a common rendering layer architecture, transform pipeline, selection model, clipboard integration, and schema pattern. This document specifies those shared foundations.

---

## 2. Rendering Layer — Two-Tier Z-Index Model

### 2.1 ReactFlow Viewport Structure

ReactFlow's viewport element has a CSS `transform` (for pan/zoom), which creates a **stacking context**. Within it, three sibling subtrees exist:

```
.react-flow__viewport                          ← stacking context root (transform)
  ├─ svg.react-flow__edges                     ← position: absolute, z-index: auto
  ├─ div  [edge label renderer]                ← position: absolute, z-index: auto
  └─ div.react-flow__nodes                     ← position: absolute, NO z-index set
       ├─ div.react-flow__node-postit          ← z-index: -1    (background tier)
       ├─ div.react-flow__node-container       ← z-index: -1    (background tier)
       ├─ div.react-flow__node-conversion      ← z-index: 2000  (business objects)
       └─ div.react-flow__node-canvasChart     ← z-index: 2500  (foreground tier)
```

### 2.2 The Stacking Context Proof

The critical fact: **`.react-flow__nodes` does NOT create a stacking context.** It has `position: absolute` but no `z-index` (defaults to `auto`), no `transform`, no `opacity < 1`, no `filter`. Per the CSS specification (CSS 2.1 Appendix E), `position: absolute` alone without an explicit non-auto `z-index` does not create a stacking context.

Therefore, individual `.react-flow__node` wrappers participate **directly in the viewport's stacking context**, not a nested one within the nodes container.

The CSS painting order within a stacking context is:

1. Stacking context root background
2. **Child stacking contexts with negative z-index** (most negative first)
3. In-flow, non-positioned blocks
4. Non-positioned floats
5. In-flow inline content
6. Positioned elements with z-index: auto (DOM order)
7. **Child stacking contexts with positive z-index** (lowest first)

### 2.3 Tier Model — DOM Order, Not CSS z-index

**CRITICAL LESSON (Phase 1 implementation):** ReactFlow v11 completely owns inline `z-index` on node wrapper elements. Its internal `createNodeInternals()` recalculates z-index for every node on every state change, overwriting any value set via the `zIndex` node property or CSS `!important`. Empirically, all nodes converge to the same computed z-index (2000 with `elevateNodesOnSelect`).

**What does NOT work** (proven by debugging during Phase 1):
- Setting `zIndex` on node objects in `toFlow()` — ReactFlow overwrites it
- CSS `z-index: N !important` on `.react-flow__node-*` — overridden by ReactFlow's inline style recalculation
- `setNodes()` to update `zIndex` — overwritten on next render cycle by `createNodeInternals()`

**What DOES work — DOM order controls paint order:**
ReactFlow renders nodes in the order they appear in the `nodes` array. Later elements in the DOM paint on top (standard CSS painting order for elements at the same z-index). This is the ONLY reliable stacking mechanism.

| Elements | Visual role | Mechanism |
|---------|-------------|-----------|
| Edges SVG, edge labels | **Edges** | ReactFlow default rendering |
| Conversion nodes | **Business objects** | First in nodes array (from `toFlow()`) |
| Containers | **Annotation tier** | Appended after conversion nodes |
| Post-its | **Annotation tier** | Appended after containers |
| Canvas charts | **Foreground tier** | Appended last |

Final visual stack (bottom to top): **Edges → Nodes → Containers → Post-Its → Canvas Charts**

### 2.4 Z-Order Implementation Rules

**Cross-type stacking** is fixed by append order in `toFlow()`. Not user-controllable.

**Within-type z-order** (e.g. one post-it above another) uses array position in the graph data:
- `graph.postits[0]` = back, `graph.postits[last]` = front
- Z-order context menu operations (Bring to Front, Send to Back, etc.) reorder the graph array
- After reordering, call `reorderPostitNodes()` helper that sorts the ReactFlow nodes array to match the graph array order
- The helper: extracts non-postit + postit nodes, sorts postits by graph array index, concatenates: `[...nonPostit, ...sortedPostits]`

**Selected state**: ReactFlow's `elevateNodesOnSelect` adds 1000 to internal z-index of selected nodes. This is sufficient to bring a selected object above siblings. Do NOT add CSS `!important` rules for selected state.

**DO NOT** use CSS `z-index !important` on `.react-flow__node-*` selectors. It will appear to work initially but break intermittently as ReactFlow recalculates internal z-index.

### 2.5 Tool Mode State — Context, Not Props

**CRITICAL LESSON (Phase 1 implementation):** The `activeElementTool` state (select/pan/new-node/new-postit) must reach `CanvasInner` reliably. It cannot be passed as a prop through `GraphCanvas` because:
- `CanvasHost` is defined as an inline component inside `GraphEditorInner`
- `canvasComponent` is wrapped in `useMemo` that doesn't include `activeElementTool` in its deps
- Adding it to deps would cause canvas remount on every tool change

**Solution**: `ElementToolContext` (in `src/contexts/ElementToolContext.tsx`) provides tool state per graph tab. `GraphEditorInner` provides it; `CanvasInner` and `PostItNode` consume it via `useElementTool()`. Context updates bypass all memoisation.

**Rule**: Any state that needs to flow from `GraphEditorInner` to `CanvasInner` and is NOT part of the graph data model should use a React context, not props through the `CanvasHost`/`canvasComponent` memo boundary.

### 2.6 Pan Mode — pointer-events: none, Not ReactFlow Props Alone

**CRITICAL LESSON (Phase 1 implementation):** Setting `nodesDraggable={false}` and `elementsSelectable={false}` on ReactFlow is necessary but NOT sufficient for pan mode. Per-node `draggable`/`selectable` values (if set) override global props. Interactive components inside nodes (editors, buttons) still receive events.

**Correct implementation**: Apply a CSS class `rf-pan-mode` to the `<ReactFlow>` element. CSS rules disable pointer-events on the entire node/edge layer:

```css
.rf-pan-mode .react-flow__node,
.rf-pan-mode .react-flow__nodes,
.rf-pan-mode .react-flow__edges,
.rf-pan-mode .react-flow__edge { pointer-events: none !important; }
```

This ensures the pane always receives drags. Combined with `cursor: grab !important` on `.rf-pan-mode *`, it produces consistent hand-mode behaviour.

**Do NOT** set per-node `draggable: true` or `selectable: true` in `toFlow()`. Leave them `undefined` so global ReactFlow props control behaviour.

### 2.5 Pointer Events

Background-tier canvas objects at z-index -1 are visually below the edges SVG (z-index: auto). For clicks to reach them, the edges SVG must not block events where no edge is drawn.

ReactFlow already sets `pointer-events: none` on `svg.react-flow__edges` and the edge label renderer div. Individual edge paths and labels opt in with explicit `pointer-events`. This allows click-through on empty areas — **no additional pointer-events CSS changes are needed** for background-tier objects.

Foreground-tier canvas objects (charts at z-index 2500) are above nodes and edges, so pointer events reach them naturally. However, they may occlude conversion nodes behind them. This is by design — the user chose to place the chart there; they can move it.

Event dispatch at a given click point (topmost handler wins):

| Click target | What handles it |
|-------------|----------------|
| Selected canvas object (z-index 3000) | The selected object |
| Canvas chart (z-index 2500) | The chart |
| Conversion node (z-index 2000) | The node |
| Edge path / interaction zone | Edge path (pointer-events: auto within SVG) |
| Edge label / bead | Edge label (pointer-events: auto within label renderer) |
| Post-it or container (z-index -1) | The annotation (no overlay blocking) |
| Empty canvas | `.react-flow__pane` (handles onPaneClick) |

### 2.6 MiniMap Exclusion

All canvas object types are excluded from the MiniMap. Use the `nodeColor` callback on `<MiniMap>` to return `'transparent'` for canvas object node types. Combined with `nodeStrokeColor` returning `'transparent'`, they become invisible in the minimap.

### 2.7 Assumptions and Browser Compatibility

| Assumption | Basis | Risk if violated |
|-----------|-------|-----------------|
| `.react-flow__nodes` has no z-index, transform, opacity, or filter | ReactFlow v11.10.3 default styles | Tier model breaks — all nodes in same stacking context |
| `svg.react-flow__edges` has `pointer-events: none` | Required for pane click to work | Background-tier objects not clickable — add explicit CSS fix |
| ReactFlow adds `.selected` class to selected nodes | Documented ReactFlow behaviour | Selected z-index boost doesn't work |
| ReactFlow adds `.react-flow__node-{type}` class | Documented ReactFlow behaviour | CSS z-index rules don't match |

Verify during Phase 1a and on any ReactFlow version update.

---

## 3. Canvas Object Exclusions from Graph Operations

Canvas objects are NOT graph semantics. Several existing operations must explicitly exclude them.

### 3.1 `fitView`

ReactFlow's `fitView` zooms to fit all nodes. Since canvas objects are ReactFlow nodes, they'd be included — a post-it far from the graph would cause excessive zoom-out. Use `fitView({ nodes: [...conversionNodesOnly] })` to pass only conversion nodes.

### 3.2 Auto-Layout (Dagre)

When the user triggers auto-layout, only conversion nodes are repositioned. Canvas objects keep their manual positions. The layout algorithm must filter by node type (exclude `postit-`, `container-`, `chart-` prefixes) before computing.

### 3.3 Sankey View

In Sankey mode, `toFlow()` uses d3-sankey to compute positions for conversion nodes. Canvas objects must be appended to the nodes array AFTER the Sankey layout runs and must keep their stored `x`/`y` positions.

### 3.4 Graph Issues Indicator

The "Graph Issues" validation checks (orphan nodes, missing edges, probability consistency) must exclude canvas objects. They are not part of graph semantics and must not generate issue warnings.

### 3.5 Dashboard Mode

In dashboard mode, canvas objects remain visible on the canvas. They are part of the visual content the user has composed. Interaction behaviour (drag, resize, edit) follows whatever editing constraints dashboard mode applies.

---

## 4. Graph Schema Pattern

### 4.1 Where Canvas Objects Live in the Graph JSON

Each canvas object type adds an optional array to `ConversionGraph`, at the same level as `nodes` and `edges`:

```typescript
interface ConversionGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  policies: Policies;
  metadata: Metadata;
  postits?: PostIt[];             // Phase 1
  containers?: Container[];       // Phase 2
  canvasAnalyses?: CanvasAnalysis[];  // Phase 3
  // ... existing fields (debugging, DSLs, etc.)
}
```

Canvas objects are **first-class citizens of the graph file**. They persist through IndexedDB, commit to git, round-trip through Python pipelines, and validate against the JSON schema.

### 4.2 Three-Layer Schema Parity

For each canvas object type, all three schema layers MUST be updated simultaneously. Failure to update any layer causes data stripping during round-trips.

| Layer | File | What to add |
|-------|------|------------|
| TypeScript | `graph-editor/src/types/index.ts` | Interface definition + optional array on `ConversionGraph` |
| Python Pydantic | `graph-editor/lib/graph_types.py` | `BaseModel` subclass + optional `List` field on `Graph` |
| JSON Schema | `graph-editor/public/schemas/conversion-graph-1.1.0.json` | Object definition + array property on the graph object |

**Schema parity is the FIRST implementation step for every phase**, not the last. If frontend code creates canvas objects before the Python model exists, automation pipelines strip them.

### 4.3 Common Fields Pattern

Every canvas object type shares a common spatial footprint:

```typescript
{
  id: string;       // UUID — unique within its type array
  x: number;        // flow-space x position
  y: number;        // flow-space y position
  width: number;    // px in flow coordinates
  height: number;   // px in flow coordinates
}
```

Beyond these, each type adds its own fields (text, colour, label, recipe, etc.) as specified in its phase doc.

### 4.4 Persistence Lifecycle

| Event | What happens to canvas objects |
|-------|-------------------------------|
| `setGraph(next)` | Canvas object arrays updated in GraphStore; file marked dirty in IDB; `metadata.updated_at` updated |
| `saveHistoryState()` | Graph snapshot (including canvas objects) pushed to undo stack |
| Git commit | Canvas objects serialised as part of graph JSON file |
| Git pull / clone | Canvas objects deserialised from graph JSON into IDB |
| Python round-trip | Canvas objects preserved IF Python model includes the field; STRIPPED if not |

### 4.5 Migration — Existing Graphs

Graphs predating this feature have no `postits`, `containers`, or `canvasCharts` arrays. All code must handle missing/`undefined` arrays gracefully:

- `toFlow()`: `(graph.postits || []).map(...)` — empty array if absent
- `fromFlow()`: preserve existing arrays if no ReactFlow nodes match the prefix
- PropertiesPanel: no canvas object section shown if array is absent/empty

No explicit migration step is needed — the arrays are optional and default to absent.

---

## 5. Transform Layer — `toFlow()` / `fromFlow()` Pattern

### 5.1 ID Prefix Convention

All canvas object types use distinct ID prefixes to avoid collision with graph node UUIDs and enable easy partitioning in `fromFlow()`:

| Type | ReactFlow node ID pattern | ReactFlow node type | Append order in `toFlow()` |
|------|--------------------------|-------------------|--------------------------|
| Container | `container-${container.id}` | `container` | After conversion nodes |
| Post-it | `postit-${postit.id}` | `postit` | After containers |
| Canvas analysis | `analysis-${analysis.id}` | `canvasAnalysis` | Last (topmost) |

Append order = DOM order = visual stacking order. See §2.4 for why this is the only reliable approach.

### 5.2 `toFlow()` Extension Pattern

For each canvas object type, `toFlow()` appends typed ReactFlow nodes to the nodes array alongside conversion nodes:

- `id`: prefixed per §5.1
- `type`: the ReactFlow node type name
- `position`: `{ x, y }` from the object data
- `data`: the object's data plus callbacks (`onUpdate`, `onDelete`, `onSelect`)
- `style`: `{ width, height }` from the object data (ReactFlow uses this for node dimensions)
- Do NOT set `zIndex`, `selectable`, or `draggable` on individual nodes — global ReactFlow props control these, and ReactFlow's internal z-index recalculation overwrites per-node values (§2.4)

Canvas objects MUST be appended AFTER Sankey layout computation (§3.3). In Sankey mode, conversion nodes get d3-sankey positions first, then canvas objects are appended with their stored positions.

**Append order within the background tier**: containers first, then postits. This means postits are always visually above containers if they overlap (later in the nodes array = later in DOM = rendered on top). Within each type, array order from the graph JSON determines stacking — "Bring to Front" moves an object to the end of its type array. Cross-type z-order control (e.g., a postit behind a container) is not supported — the type append order is fixed.

### 5.3 `fromFlow()` Extension Pattern

`fromFlow()` partitions the ReactFlow nodes array before processing:

1. Nodes with ID starting `postit-` → postit bucket
2. Nodes with ID starting `container-` → container bucket
3. Nodes with ID starting `chart-` → canvas chart bucket
4. All other nodes → graph nodes (existing processing)

For each bucket, extract position updates (and any size changes from `data`) and merge back into the corresponding array on the graph object.

Preserve annotations that don't have a corresponding ReactFlow node (e.g. if filtered out by some future mechanism).

### 5.4 Node Type Registration

All types registered in `nodeTypes` in `GraphCanvas.tsx`:

```typescript
const nodeTypes: NodeTypes = {
  conversion: ConversionNode,
  postit: PostItNode,
  container: ContainerNode,
  canvasAnalysis: CanvasAnalysisNode,
};
```

---

## 6. Selection, Clipboard, and Edit Operations

Canvas objects are selectable, copyable, cutable, pasteable, and deletable — they participate in all standard edit operations alongside nodes and edges.

### 6.1 Selection Model

**Single selection**: clicking a canvas object selects it and clears any node/edge selection (mutual exclusion). The properties panel shows the appropriate section for the selected object type.

**Multi-selection (lasso)**: the existing lasso handler (`GraphCanvas` Shift+drag) selects nodes whose bounding boxes intersect the lasso rectangle. Canvas objects of all types should participate in lasso selection — they ARE ReactFlow nodes, so they should already be included. **Verify during Phase 1a implementation.**

**Select All**: the `dagnet:selectAllNodes` event handler currently selects all ReactFlow nodes. Since canvas objects are ReactFlow nodes, they are selected by default. **Select All selects everything** (conversion nodes + canvas objects). This is consistent with standard select-all behaviour.

### 6.2 Selection Context

**Phase 1**: add `selectedPostitId` / `onSelectedPostitChange` to `SelectionContextType`.

**Phase 2+**: generalise to avoid per-type proliferation:

```typescript
selectedAnnotationId: string | null;
selectedAnnotationType: 'postit' | 'container' | 'canvasAnalysis' | null;
onSelectedAnnotationChange: (id: string | null, type: string | null) => void;
```

The `onSelectionChange` handler in GraphCanvas detects canvas object nodes by ID prefix or type and routes to `onSelectedAnnotationChange`, clearing node/edge selection.

### 6.3 Clipboard — Copy and Cut

The existing clipboard uses `DagNetClipboardData` (single object) and `DagNetSubgraphClipboardData` (multi-object). Canvas objects integrate into the subgraph model:

**`DagNetSubgraphClipboardData` extension**: add optional arrays for canvas objects:

```typescript
interface DagNetSubgraphClipboardData {
  type: 'dagnet-subgraph';
  nodes: GraphNode[];
  edges: GraphEdge[];
  postits?: PostIt[];               // NEW
  containers?: Container[];         // NEW
  canvasAnalyses?: CanvasAnalysis[]; // NEW
  sourceGraphId?: string;
  timestamp: number;
}
```

**`extractSubgraph()`** (`subgraphExtractor.ts`): extend to include selected canvas objects. When the user copies a selection that includes both conversion nodes and canvas objects, all selected items are captured.

**Edit menu Copy/Cut** (`EditMenu.tsx`): already queries selection via `dagnet:querySelection`. Extend the query response to include selected canvas objects. Cut = copy + delete.

**Context menus**: canvas object context menus gain a "Copy" item.

### 6.4 Clipboard — Paste

**`updateManager.pasteSubgraph()`**: extend to handle the new arrays. For each canvas object type, generate new UUIDs (to avoid ID collisions with existing objects), offset positions by a paste delta, and add to the graph.

**Paste locations**:
- Pane context menu: "Paste" pastes at click position (applies position offset)
- Edit menu: "Paste" pastes at a fixed offset from original positions

### 6.5 Delete

**`deleteSelected()`** in GraphCanvas: currently filters `nodes.filter(n => n.selected)` and `edges.filter(e => e.selected)`, then calls `updateManager.deleteNode()` / `deleteEdge()`. Extend to also find selected canvas object nodes (by ID prefix), and remove them from the appropriate graph arrays.

**Keyboard Delete/Backspace**: already calls `deleteSelected()`, so canvas objects are covered automatically once `deleteSelected()` is extended.

**Objects menu "Delete Selected"**: dispatches `dagnet:deleteSelected` → calls `deleteSelected()`. Covered.

### 6.6 Event Integration

| Event | Current behaviour | Extension for canvas objects |
|-------|------------------|---------------------------|
| `dagnet:querySelection` | Returns selected nodes/edges | Include selected canvas objects (by type) |
| `dagnet:selectAllNodes` | Selects all ReactFlow nodes | Canvas objects are already ReactFlow nodes — selected by default |
| `dagnet:deleteSelected` | Deletes selected nodes/edges | Extend to delete selected canvas objects |

### 6.7 Properties Panel Branching

The properties panel gains canvas object branches alongside graph, node, and edge:

```
if (selectedAnnotationType === 'postit') → PostItPropertiesSection
if (selectedAnnotationType === 'container') → ContainerPropertiesSection
if (selectedAnnotationType === 'canvasAnalysis') → CanvasAnalysisPropertiesSection
```

Each section follows the existing blur-to-save pattern: local state on `onChange`, commit to graph via `structuredClone` + `setGraph` + `saveHistoryState` on `onBlur`.

---

## 7. Context Menus

Each canvas object type has its own context menu with type-specific items and shared common items.

### 7.1 Routing

ReactFlow's `onNodeContextMenu` fires for ALL node types (conversion nodes + canvas objects). The handler must route to the correct menu based on the right-clicked node's type:

```
onNodeContextMenu(event, node):
  if node.id starts with 'postit-'    → open PostItContextMenu
  if node.id starts with 'container-' → open ContainerContextMenu
  if node.id starts with 'analysis-'  → open CanvasAnalysisContextMenu
  else                                 → open NodeContextMenu (existing)
```

Each canvas object type has its own state variable (e.g. `postitContextMenu`, `containerContextMenu`, `chartContextMenu`) following the same pattern as `nodeContextMenu` and `edgeContextMenu`. All context menus are mutually exclusive — opening one closes any other.

### 7.2 Menu Components

Each canvas object type gets a standalone context menu component:

- `PostItContextMenu.tsx`
- `ContainerContextMenu.tsx`
- `CanvasAnalysisContextMenu.tsx`

These may use either the `ContextMenu` component (item-array pattern, used by tabs/navigator/scenarios) or custom JSX (used by existing graph canvas menus). The item-array pattern is preferred for new code.

### 7.3 Common Items

All canvas object context menus share these items:

**Z-order controls** (when multiple objects of the same type exist):

| Item | Array mutation | Visual effect |
|------|--------------|--------------|
| Bring to Front | Move to end of type array | Topmost within tier |
| Send to Back | Move to start of type array | Bottommost within tier |
| Bring Forward | Swap with next element | Up one level |
| Send Backward | Swap with previous element | Down one level |

Each is a lightweight array reorder: `structuredClone` → reorder → `setGraph` → `saveHistoryState` → `reorderPostitNodes()` (or equivalent for other types). No new data model fields — the array order in `graph.postits[]` / `graph.containers[]` / `graph.canvasCharts[]` IS the z-order. `toFlow()` appends objects in array order; later = rendered on top in the DOM.

**IMPORTANT**: after calling `setGraph`, also call a `reorder*Nodes()` helper that sorts the ReactFlow nodes array to match the new graph array order. This is necessary because the graph→ReactFlow sync fast path may not detect array-only reorders as "node count changed", so the DOM order might not update otherwise. The helper uses `setNodes()` to rearrange the ReactFlow array: non-type nodes first, then type nodes sorted by their position in the graph array. See architecture doc §2.4 for why DOM order is the only reliable z-order mechanism.

Z-order items are shown only when 2+ objects of the same type exist (no point showing "Bring to Front" for a solo post-it). They can be in a "Layer" or "Order" submenu to keep the menu compact.

**Standard edit items** (at the bottom, separated by divider):

| Item | Action |
|------|--------|
| Copy | Copies the object to clipboard |
| Cut | Copies and deletes |
| Delete | Removes from graph |

### 7.4 Type-Specific Items

| Type | Specific items | Notes |
|------|---------------|-------|
| Post-it | **Colour picker** (inline swatch grid) | Shared `PostItColourPalette` component |
| Container | **Colour picker** (inline swatch grid) | Container-specific palette |
| Canvas analysis | **Title** (editable inline) | Text input at top of menu; blur/Enter commits |
| Canvas analysis | **View mode** toggle | Switch between chart and cards view |
| Canvas analysis | **Chart kind** selector (chart view only) | Submenu or inline radio |
| Canvas analysis | **Freeze / Unfreeze** | Toggles `live` |
| Canvas analysis | **Refresh** | Manual recompute |
| Canvas analysis | **Open as Tab** | Opens full chart viewer |

Type-specific items appear above the common items, separated by a divider.

**Extensibility note for canvas charts**: as charting features mature, chart-kind-specific display settings (axis titles, show/hide legend, grid lines, etc.) will be added to both the properties panel and the context menu. The context menu should support a **"Display" submenu** that is dynamically populated from a registry of available settings for the current chart kind. This submenu starts empty in Phase 3 and grows as settings are implemented. The same registry drives both the properties panel Display section and the context menu Display submenu — single source of truth for available settings per chart kind.

### 7.5 Inline Custom Content

Some menu items contain inline UI (colour swatch grids, radio groups). Two approaches:

- **Extend `ContextMenu`** with custom render slots
- **Build hybrid menus** that compose custom JSX above standard items

Either is acceptable. The existing `PostItNode.tsx` already has a working inline colour picker.

### 7.6 Menu Closing

Extend the existing shared close-on-click `useEffect` in GraphCanvas to include the new canvas object menu state variables.

---

## 8. Shared Behaviours

### 8.1 Undo/Redo

All canvas object mutations (create, delete, move, resize, edit properties) go through `setGraph()` + `saveHistoryState()`. They participate in the existing undo/redo stack automatically.

### 8.2 `metadata.updated_at`

When any canvas object is created, edited, or deleted, `graph.metadata.updated_at` must be updated. This matches the existing pattern for node/edge mutations. Include in every `structuredClone` + `setGraph` flow.

### 8.3 Node Handles

Canvas object nodes must NOT render ReactFlow handles (connection ports). They are not connectable — edges cannot start or end at a canvas object.

### 8.4 Creation Surfaces

Canvas objects can be created from three surfaces, each serving a different use case.

#### 8.4.1 Elements Menu (rename from "Objects")

The existing "Objects" top menu is renamed to **"Elements"** to reflect the expanded scope (canvas objects alongside conversion nodes). Rethought contents:

```
Elements
├─ Add Node
├─ Add Post-It            (Phase 1)
├─ Add Container          (Phase 2)
├─ ─────────────
├─ Delete Selected  ⌫
├─ ─────────────
└─ Sync Index from Graph...
```

Canvas charts are absent — they require an analysis result and are created from the analytics panel.

Each creation item dispatches a custom event (e.g. `dagnet:addPostit`). `GraphEditor` listens and delegates to `GraphCanvas` via refs, following the existing `dagnet:addNode` pattern.

#### 8.4.2 Pane Context Menu

Right-click on the canvas background. Same creation items as the Elements menu, creating the object at the right-click position (flow coordinates from `screenToFlowPosition`):

- "Add Node"
- "Add Post-It" (Phase 1)
- "Add Container" (Phase 2)
- Paste items (existing)
- Select All (existing)

#### 8.4.3 Element Palette (Sidebar)

A persistent strip of draggable/clickable icons, always visible regardless of which sidebar panel is active. This is the primary creation affordance for repeated placement.

**When sidebar is maximised** — horizontal strip above the panel tabs:

```
┌──────────────────┐
│ [◯] [□] [⬚]     │  ← element palette
│ Node  Note Cont. │
├──────────────────┤
│ Scenarios │ Props │
│ Tools │ Analytics │
├──────────────────┤
│  (panel content) │
└──────────────────┘
```

**When sidebar is minimised** (48px icon bar) — vertical strip above the panel icons:

```
▕ [◯] │  ← element palette
▕ [□] │
▕ [⬚] │
▕ ─── │  ← visual divider
▕ [S] │  ← Scenarios
▕ [P] │  ← Props
▕ [T] │  ← Tools
▕ [A] │  ← Analytics
```

**Icons:**
- **Node**: circle or rounded rectangle (existing node visual)
- **Post-It**: square with folded corner
- **Container**: dashed rectangle

Canvas charts are NOT in the palette — they require an analysis result. The analytics panel is the creation surface for charts.

##### Positioning — the palette is NOT a sidebar tab

The palette is too small (3 icons) to justify a full rc-dock panel. It's a fixed toolbar strip rendered OUTSIDE rc-dock, following the same pattern as `SidebarIconBar` (which is also absolutely positioned outside rc-dock, overlaid on the right edge).

**Minimised mode**: palette icons are rendered inside `SidebarIconBar.tsx`, at the top of the icon column above the panel icons, separated by a visual divider. Same icon size/style as the panel icons (20px Lucide icons).

**Maximised mode**: palette is an absolutely positioned div at the top of the sidebar area, inside `.graph-editor-dock-container`:

```jsx
{sidebarState.mode === 'maximized' && (
  <div style={{ position: 'absolute', top: 0, right: 0, width: sidebarWidth, height: PALETTE_HEIGHT, zIndex: 101 }}>
    <ElementPalette layout="horizontal" />
  </div>
)}
```

The rc-dock sidebar panel gets top padding equal to the palette height, so the panel tabs sit below the palette strip. The sidebar width is already tracked in `sidebarState.sidebarWidth`.

##### Visibility

The palette is only visible when a graph tab is active in interactive mode — same condition as the Elements menu (`fileId.startsWith('graph-')` and `viewMode === 'interactive'`). No palette in parameter/chart tabs or in read-only/share mode.

##### Interaction — Drag

Each palette icon is `draggable` with an `onDragStart` handler that sets the DnD payload. The payload uses the existing `dagnet-drag` format with **new objectType values** to distinguish palette creation from navigator placement:

| Palette icon | DnD payload | Handling in `handleDrop` |
|-------------|------------|--------------------------|
| Node | `{ type: 'dagnet-drag', objectType: 'new-node' }` | Create blank node at drop position (same logic as pane context menu "Add Node") |
| Post-It | `{ type: 'dagnet-drag', objectType: 'new-postit' }` | Create blank post-it at drop position |
| Container | `{ type: 'dagnet-drag', objectType: 'new-container' }` | Create blank container at drop position |

These `new-*` objectTypes are distinct from the navigator's `node` (which carries an `objectId` referencing a registry entry). `handleDrop` in GraphCanvas adds branches for each.

Custom drag images via `e.dataTransfer.setDragImage()` provide visual feedback: a small coloured rectangle matching the object type.

##### Interaction — Click

Click on a palette icon creates the object at the viewport centre. The palette component does NOT have access to the ReactFlow instance (it renders outside the ReactFlow component tree). Instead, it dispatches custom events:

- Node icon click → `window.dispatchEvent(new CustomEvent('dagnet:addNode'))`
- Post-It icon click → `window.dispatchEvent(new CustomEvent('dagnet:addPostit'))`
- Container icon click → `window.dispatchEvent(new CustomEvent('dagnet:addContainer'))`

`GraphEditor` listens for these events and delegates to `GraphCanvas` via refs. `GraphCanvas` creates the object at the viewport centre using `screenToFlowPosition()`. This is the same pattern used by the Elements menu items.

##### Component structure

`ElementPalette.tsx` (new):

- Props: `layout: 'horizontal' | 'vertical'`, `onCreateElement?: (type: string) => void`
- Renders icons with tooltips ("Conversion Node", "Post-It Note", "Container")
- Each icon: `draggable`, `onDragStart`, `onClick`, `tabIndex={0}`, `aria-label`
- Horizontal layout for maximised sidebar, vertical layout for minimised icon bar

##### Incremental build-out

- **Phase 1e**: palette with Node + Post-It icons
- **Phase 2d**: add Container icon to palette
- Charts are never in the palette (analytics panel is the creation surface)

#### 8.4.4 Canvas Charts — Analytics Panel

Canvas charts are created exclusively from the analytics panel:
- DnD from chart preview to canvas (Phase 3)
- "Pin to Canvas" button on chart preview (Phase 3)

This is because charts require a computed analysis result and a recipe — there's no "blank" chart to create.

---

## 9. Test Strategy

Integration tests are the default for this codebase (see `.cursorrules`). Each phase's test plan is specified in its own doc; this section defines the shared test patterns.

### 9.1 Transform Round-Trip Tests

For each canvas object type, verify:

- `toFlow()` emits a ReactFlow node with the correct ID prefix, type, position, and z-index
- `fromFlow()` extracts the canvas object node, updates position, and writes back to the correct graph array
- Round-trip: `toFlow()` → mutate position → `fromFlow()` → verify position updated in graph
- Partitioning: canvas object nodes do NOT contaminate the conversion nodes array (and vice versa)
- Missing arrays: `toFlow()` handles `graph.postits === undefined` without error

### 9.2 Selection Tests

- Clicking a canvas object node sets the correct selection state (`selectedAnnotationId` / `selectedAnnotationType`)
- Selecting a canvas object clears node/edge selection (mutual exclusion)
- Selecting a conversion node clears canvas object selection

### 9.3 Delete Tests

- `deleteSelected()` with a selected canvas object removes it from the correct graph array
- `deleteSelected()` with mixed selection (conversion nodes + canvas objects) removes both types
- Deletion clears selection for the deleted object

### 9.4 Copy/Paste Tests

- Copying a canvas object and pasting creates a new UUID (no collision with original)
- Pasted object has offset position
- Subgraph copy with mixed types (nodes + edges + canvas objects) preserves all types

### 9.5 Schema Parity Tests

The existing `schemaParityAutomated.test.ts` should be extended (or a new test added) to verify that every field in the TypeScript interface exists in the Python model and JSON schema.

### 9.6 Playwright E2E Tests

Integration tests (Vitest) cover data flow and state management. But canvas object rendering, z-index stacking, DnD interactions, and live chart updates cannot be verified without real browser rendering. A small, focused set of Playwright specs is required.

Per `.cursorrules`: each spec must complete in ~10-15s. One focused interaction per spec, not full workflows.

**Phase 1 — Post-Its:**

| Spec | Invariant protected |
|------|-------------------|
| `postit-create-and-zindex.spec.ts` | Right-click canvas → "Add Post-It" → verify element renders; verify it is visually below an edge that crosses over it (z-index -1 vs auto) |
| `postit-select-boost.spec.ts` | Click post-it → verify it jumps above nodes (z-index 3000); click elsewhere → verify it drops back below edges |
| `postit-inline-edit.spec.ts` | Double-click post-it → type text → blur → verify text persisted in the post-it element |

**Phase 2 — Containers:**

| Spec | Invariant protected |
|------|-------------------|
| `container-group-drag.spec.ts` | Create container encompassing a node → drag container → verify node moved by same delta |
| `container-halo-colour.spec.ts` | Create coloured container → place node inside → screenshot comparison: node halo blends with container background (not canvas background) |

**Phase 3 — Canvas Charts:**

| Spec | Invariant protected |
|------|-------------------|
| `canvas-chart-dnd.spec.ts` | Run analysis in analytics panel → drag chart preview to canvas → verify chart node renders at drop position |
| `canvas-chart-live-update.spec.ts` | Pin live chart → change window selector → verify chart shows loading state → verify chart re-renders (content changes) |

**Chart specs require a running Python backend** for compute. If the backend is unavailable, these specs should be skipped (not failed) via a pre-check.

**Visual regression approach**: for z-index and halo-colour specs, use Playwright screenshot comparison (`expect(page).toHaveScreenshot()`) with a tolerance for antialiasing. Establish baseline screenshots during Phase 1a.

---

## 10. Cross-Phase Dependency View

```
Prerequisites (before any phase):
  ├─ Terminology rename: createSnapshot → captureScenario (§11.1, ~5 files)
  ├─ Rename "Objects" menu → "Elements" menu (ObjectsMenu.tsx → ElementsMenu.tsx)
  └─ DB-snapshot subject resolution service extraction (Phase 3 prerequisite)

Phase 1 — Post-Its:
  1a: Schema parity (TS + Python + JSON schema) ← FIRST
  1b: Foundation (toFlow/fromFlow, CSS, rendering, MiniMap, fitView/layout exclusions)
  1c: CRUD + selection + edit operations (delete, copy/paste, context menu)
  1d: Properties panel + shared palette
  1e: Element palette in sidebar (ElementPalette.tsx — Node + Post-It icons)
      + "Add Post-It" in Elements menu and pane context menu

Phase 2 — Containers:
  Prerequisite: Generalise SelectionContextType (selectedAnnotationId/Type)
  2a: Schema parity
  2b: Component + rendering + group drag
  2c: CRUD + selection + edit operations + properties panel
  2d: Add Container icon to element palette + Elements menu + pane context menu

Phase 3 — Canvas Analyses (charts + result cards):
  Prerequisite: DB-snapshot subject resolution service extraction
  3a: Schema parity (CanvasAnalysis with view_mode)
  3b: Compute hook + chart rendering + DnD from analytics panel
  3c: Properties panel + freeze/unfreeze + edit operations
  3d: Chart rendering consolidation (6 preview components → single surface)
  3e: Result cards view_mode + DnD from result cards area

Phase 5 — Snap-to Alignment Guides:
  5a: useSnapToGuides hook + onNodesChange pipeline
  5b: SnapGuideLines SVG rendering
  5c: Alt-to-suppress + View menu toggle
```

Each phase's internal steps are detailed in its own doc. Schema parity is always the first step — never the last.

---

## 11. Terminology — "Snapshot" Disambiguation

The word "snapshot" has been used loosely in this codebase. For clarity across all canvas object docs and future implementation, these definitions are binding:

| Term | Meaning | Example |
|------|---------|---------|
| **DB snapshot** (or just "snapshot") | A data snapshot stored in IndexedDB — fetched from Amplitude/external sources and cached for historical analysis | `snapshotDependencyPlanService`, `SnapshotHistogramChart`, `snapshotWriteService` |
| **Snapshot-backed analysis** | An analysis type that reads from DB snapshots rather than computing from live graph params | `lag_histogram`, `daily_conversions`, `cohort_maturity` |
| **Static scenario** | A scenario whose parameters are frozen at a point in time and do not auto-update from live data | Formerly called "snapshot scenario" — `is_live: false` |
| **Live scenario** | A scenario that auto-updates its parameters from external data sources | `is_live: true` |
| **Captured scenario** | The action of creating a static scenario from the current parameter state | Formerly called "creating a snapshot" — `captureScenario()` |

**The word "snapshot" must NOT be used to mean "static scenario" or "non-live scenario."** It refers exclusively to DB data snapshots.

### 11.1 Codebase Rename (Prerequisite)

The following renames remove the ambiguity from existing code:

| Current | Proposed | Files |
|---------|----------|-------|
| `CreateSnapshotOptions` | `CaptureScenarioOptions` | `types/scenarios.ts`, `ScenariosContext.tsx` |
| `createSnapshot()` | `captureScenario()` | `ScenariosContext.tsx`, `ScenariosPanel.tsx`, `ScenarioEditorModal.tsx`, `GraphEditor.tsx` |
| "Static snapshots" (UI label) | "Static scenarios" | `ScenariosPanel.tsx` |
| "static snapshots do not fetch" (comment) | "static scenarios do not fetch" | `ScenariosContext.tsx` |
| "Snapshot creation" (docstring) | "Scenario capture" | `ScenariosContext.tsx` |

This rename is bounded (~5 files, ~15 occurrences) and should be done as a standalone commit before canvas object implementation begins.

---

## 12. Out of Scope (All Phases)

- **Connector lines between canvas objects** — not planned.
- **Rich text in post-its** — plain text only.
- **Post-it templates / presets** — not planned.
- **Cross-type z-order control** — a postit cannot be sent behind a container (or vice versa). The fixed type append order (containers → postits) determines cross-type stacking. Within-type z-order IS controllable via context menu.
- **Container nesting** — containers do not contain other containers.
- **Chart editing on canvas** — chart configuration (changing chart kind, modifying query) is done via properties panel or full tab view, not inline on canvas.
