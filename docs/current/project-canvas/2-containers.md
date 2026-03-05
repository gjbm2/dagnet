# Phase 2: Containers

**Status**: Design — ready for implementation  
**Date**: 5-Mar-26  
**Prerequisite**: [0-architecture.md](0-architecture.md) — rendering layer, transform pattern, selection model, clipboard integration, test strategy

---

## 1. Overview

A container is a labelled rectangle on the background annotation layer (below edges, below nodes). When the user drags a container, all conversion nodes whose positions fall within the container's bounds move with it.

Containers provide visual grouping ("Acquisition funnel", "Retention loop", "Payment flow") and spatial organisation. Unlike post-its, containers interact with business objects by governing their positions during drag.

---

## 2. Data Model

### 2.1 TypeScript

```typescript
interface Container {
  id: string;         // UUID
  label: string;      // title text, rendered at top of rectangle
  colour: string;     // border + light fill tint (hex)
  width: number;      // px in flow coordinates
  height: number;     // px in flow coordinates
  x: number;          // flow-space x position
  y: number;          // flow-space y position
}
```

On `ConversionGraph`:

```typescript
containers?: Container[];
```

### 2.2 Python Pydantic Model

```python
class Container(BaseModel):
    """Canvas annotation: labelled grouping rectangle."""
    id: str
    label: str = Field("Group", max_length=256)
    colour: str = Field(..., pattern=r"^#([0-9A-Fa-f]{6})$")
    width: float = Field(..., gt=0)
    height: float = Field(..., gt=0)
    x: float
    y: float
```

Add to `Graph`:

```python
containers: Optional[List[Container]] = Field(None, description="Canvas annotations: grouping rectangles")
```

### 2.3 JSON Schema

Add `containers` array property to `conversion-graph-1.1.0.json` with the object definition matching the TypeScript/Python fields.

---

## 3. Rendering

Containers are ReactFlow nodes with `type: 'container'`, rendered in the **background tier** at z-index -1 (architecture doc §2.3). They sit below edges and below conversion nodes.

When selected, z-index boosts to 3000 (above everything) for easy editing.

### 3.1 Visual Design

- A large, light-tinted rectangle
- Dashed or thin solid border in the `colour` value
- Fill: very low-opacity tint of `colour` (e.g. 10% opacity) so nodes and edges within remain clearly visible
- **Label bar** at the top — the container's `label` rendered in a slightly bolder/larger font, left-aligned
- No folded corner or skeuomorphic effects — the visual language is "structural grouping", distinct from post-its

### 3.2 Colour Palette

Muted structural colours rather than bright pastels. Distinct from the post-it palette to signal different intent.

Suggested palette (TBD during implementation):

| Name | Hex | Use |
|------|-----|-----|
| Slate | `#94A3B8` | Neutral grouping |
| Sage | `#86EFAC` | Success/growth flows |
| Sky | `#7DD3FC` | Information flows |
| Amber | `#FCD34D` | Attention/caution flows |
| Rose | `#FDA4AF` | Error/churn flows |
| Violet | `#C4B5FD` | Experimental/case flows |

Default colour for new containers: Slate.

---

## 4. ContainerNode Component

### 4.1 Structure

`graph-editor/src/components/nodes/ContainerNode.tsx` (new file):

- `NodeResizer` for drag-to-resize
- Label bar at top (text from `data.container.label`)
- Dashed border + tinted fill
- No `<Handle>` components (architecture doc §8.3)

### 4.2 Label Editing

The label is editable inline: **double-click** the label bar to enter edit mode (text input replaces static text). Blur or Enter commits the change via `onUpdate(container.id, { label: newLabel })`. Update `metadata.updated_at`.

This mirrors the post-it's double-click-to-edit pattern.

---

## 5. Selection and Properties Panel

### 5.1 Selection

Containers participate in all standard selection operations (architecture doc §6):

- **Click to select**: clears node/edge selection; shows container properties panel
- **Lasso**: included in lasso selection (they are ReactFlow nodes)
- **Select All**: included
- **Multi-select**: can be selected alongside other objects for bulk delete/copy

### 5.2 Properties Panel

When a container is selected, the properties panel shows:

**Label** — text input, blur-to-save. Same pattern as node label.

**Colour** — palette picker showing the container palette as clickable swatches. Selecting a colour commits immediately.

### 5.3 Update Mechanism

Mirror the existing `updateNode` / `updateEdge` pattern:

1. `structuredClone(graph)`
2. Find container by `selectedAnnotationId` in `next.containers`
3. Mutate the field
4. Update `next.metadata.updated_at`
5. `setGraph(next)`
6. `saveHistoryState('Update container <field>')`

---

## 6. Group Drag — Spatial Containment

The core behaviour: when a container starts dragging, identify which conversion nodes are "inside" it, and move them by the same delta on each drag tick.

### 6.1 Containment Test

A conversion node is "inside" a container if the node's centre point falls within the container's bounding rectangle. The centre is at `(node.position.x + node.measured.width / 2, node.position.y + node.measured.height / 2)`. ReactFlow provides `node.measured?.width` and `node.measured?.height` (v11) for the measured dimensions. Fallback to a default (e.g. 150×60) if measurements are not yet available.

### 6.2 Drag Mechanics

1. **`onNodeDragStart`** (container node detected by type/ID prefix) — snapshot the set of conversion node IDs whose centres are within the container bounds. Store this set in a ref.
2. **`onNodeDrag`** (fires on each drag tick) — compute the position delta since the last tick. For each node in the contained set, update its position by the same delta. Use `setNodes()` to batch-apply.
3. **`onNodeDragStop`** — clear the contained set ref. The final positions are written to the graph via the normal `fromFlow()` path. Call `saveHistoryState()` once — this captures the container move and all node moves as a single undo step.

### 6.3 Edge Cases

**Node dragged out of container**: if the user selects and drags an individual node out of a container's bounds, nothing special happens. Containment is purely spatial and re-evaluated at each container drag start. There is no persistent parent-child relationship.

**Overlapping containers**: if a node is inside two overlapping containers and both are dragged simultaneously (multi-select drag), the node moves once (avoid double-applying the delta). The simpler constraint: only the explicitly dragged container moves its contents.

**Container inside container**: not supported. Containers do not move other containers. Only conversion nodes are subject to group drag.

**Post-its and charts inside container**: not affected by group drag. Only conversion nodes move with the container.

**Multi-select drag with container + contained nodes**: if the user selects a container AND some of the nodes inside it, then drags the selection, both ReactFlow's multi-select drag and the container's group-drag would move the contained nodes — double-movement. The group drag logic must **exclude nodes that are part of the current ReactFlow selection** (i.e. nodes with `selected: true`). These are already being dragged by ReactFlow; the container should not move them additionally.

**Auto-layout after container placement**: if the user triggers auto-layout (dagre), conversion nodes are repositioned but containers are not (architecture doc §3.2). Nodes may end up outside their containers. This is acceptable — containment is ephemeral and spatial, not structural.

---

## 7. Node Halo Colour Adaptation

### 7.1 The Problem

Conversion nodes use a "halo" — a shape painted in the canvas background colour around the node boundary — to mask edge segments that overlap the node. This is a kludge to avoid formal SVG clipping paths. There are two implementations:

- **Flat/rectangular nodes** (Sankey view): `box-shadow: 0 0 0 5px ${canvasBg}` — a spread-only shadow
- **Curved-outline nodes** (normal view): SVG `<path stroke={canvasBg} strokeWidth={HALO_WIDTH}>` — a 20px stroke

Both hard-code `canvasBg` (`dark ? '#1e1e1e' : '#f8fafc'`). When a node is inside a container with a tinted background, the halo paints canvas-coloured rectangles/strokes that punch through the container's fill, creating a visible "hole" around each node.

### 7.2 The Fix

The halo colour must be the **effective background** at the node's position — the canvas background blended with the container's fill tint.

**In `toFlow()`**: for each conversion node, check if its centre falls within any container's bounding rectangle. If so, compute the effective background colour:

```
effectiveBg = blend(canvasBg, containerColour, containerFillOpacity)
```

Where `containerFillOpacity` is the design constant for container fill (e.g., 0.1). The blend is a simple per-channel linear interpolation:

```
R_eff = R_canvas * (1 - opacity) + R_container * opacity
```

Pass the result as `data.haloColour` on the ReactFlow conversion node.

**In `ConversionNode.tsx`**: read `data.haloColour` (if present) instead of computing `canvasBg`. Falls back to `canvasBg` when not inside a container. This applies to BOTH halo mechanisms (box-shadow for flat nodes, SVG stroke for curved nodes).

### 7.3 Multiple / Overlapping Containers

If a node is inside multiple overlapping containers, use the topmost container (last in DOM order, or last in the `containers` array). In practice, overlapping containers are rare and the visual difference between blending with one vs another is negligible.

### 7.4 Performance

The containment check in `toFlow()` is O(N × M) where N = conversion nodes, M = containers. For practical graph sizes (< 200 nodes, < 10 containers), this is negligible. If it ever matters, spatial indexing can be added.

### 7.5 Dark Mode

The blend uses the dark-mode canvas background (`#1e1e1e`) as the base when in dark mode. Container colours are the same in both themes — the tint is applied over the dark canvas background. The resulting halo colour will be slightly lighter/coloured compared to the dark canvas, which is correct.

---

## 8. Resize Behaviour

Resizing a container does NOT move nodes. It only changes the visual boundary. Nodes that were "inside" before resize might be outside after, and vice versa. Containment is ephemeral and spatial, not structural.

---

## 9. Creation and Deletion

### 8.1 Creation

Pane context menu: "Add Container". On click:

1. Generate a UUID for the container `id`
2. Create a `Container` with defaults: Slate colour, label "Group", 400×300 size, position from `contextMenu.flowX / flowY`
3. `structuredClone(graph)`, push to `next.containers` (initialise array if absent), update `metadata.updated_at`
4. `setGraph(next)`, `saveHistoryState('Add container')`
5. Close context menu
6. Select the new container

### 8.2 Deletion

Standard canvas object delete pattern (architecture doc §6.5):
- Right-click context menu → Delete
- Keyboard Delete/Backspace (via `deleteSelected()`)
- Edit menu Cut/Delete

All paths: find container by ID in `graph.containers`, remove it, update `metadata.updated_at`, `setGraph`, `saveHistoryState('Delete container')`.

### 8.3 Copy/Paste

Standard canvas object clipboard pattern (architecture doc §6.3–6.4):
- Copy captures the `Container` object
- Paste creates a new UUID and offsets the position
- Works in subgraph copy (when selected alongside nodes/other objects)

---

## 10. Key Implementation Risk

The group drag must not cause feedback loops in the `graph → ReactFlow → graph` sync cycle. During drag, position updates go through `setNodes()` (ReactFlow state) only, not through `setGraph()`. The `fromFlow()` call after drag stop captures all final positions. This matches the existing pattern for conversion node dragging.

**Performance**: on each drag tick, the delta is applied to all contained nodes via `setNodes()`. With many contained nodes (50+), this could cause lag. If observed, batch the delta application or use `requestAnimationFrame` throttling. Note as a risk but do not optimise prematurely.

---

## 11. Implementation Plan

**Prerequisite**: generalise `SelectionContextType` to `selectedAnnotationId` / `selectedAnnotationType` (architecture doc §6.2) — should be done before Phase 2 begins.

### Phase 2a: Schema parity (FIRST)

**Files**: `types/index.ts`, `graph_types.py`, `conversion-graph-1.1.0.json`, `schemaParityAutomated.test.ts`

- Add `Container` interface and `containers?` array to `ConversionGraph`
- Add Python `Container` model + `Graph.containers` field
- Add `containers` to JSON schema
- Run schema parity tests

### Phase 2b: Component + rendering + group drag

**Files**: `ContainerNode.tsx` (new), `transform.ts`, `GraphCanvas.tsx`, `custom-reactflow.css`

- Create `ContainerNode.tsx` component (labelled rectangle, dashed border, light fill, inline label editing, NodeResizer)
- Register `container` node type in `GraphCanvas.tsx`
- Extend `toFlow()` / `fromFlow()` for containers (prefix: `container-${id}`, z-index: -1)
- In `toFlow()`, compute `data.haloColour` for conversion nodes inside containers (§7.2)
- Update `ConversionNode.tsx` to read `data.haloColour` for both halo implementations (box-shadow + SVG stroke)
- Implement group drag in `onNodeDragStart` / `onNodeDrag` / `onNodeDragStop`
- Exclude container nodes from `fitView` and auto-layout
- CSS: background tier z-index already specified in architecture doc §2.4

### Phase 2c: CRUD + selection + edit operations + properties panel

**Files**: `GraphEditor.tsx`, `GraphCanvas.tsx`, `ContainerContextMenu.tsx` (new), `PropertiesPanel.tsx`, `useCopyPaste.tsx`, `subgraphExtractor.ts`, `EditMenu.tsx`

- Wire `onSelectionChange` to detect container selection (using generalised annotation selection)
- Route `onNodeContextMenu` to `ContainerContextMenu` for container nodes
- Create `ContainerContextMenu.tsx` (colour picker, copy, cut, delete)
- Add container branch to PropertiesPanel (label, colour)
- Add "Add Container" to pane context menu
- Extend `deleteSelected()` to handle container nodes
- Extend `extractSubgraph()` and `pasteSubgraph()` for containers
- Extend `dagnet:querySelection` response to include containers
- Add Container icon to `ElementPalette.tsx` (drag + click creation)
- Add "Add Container" to Elements menu (dispatches `dagnet:addContainer`)

---

## 12. Test Plan

Following the architecture doc §9 test strategy.

### 11.1 Transform Round-Trip

- `toFlow()` with containers → ReactFlow nodes with `container-` prefix, type `container`, z-index -1
- `fromFlow()` with container nodes → updates `graph.containers[]`, does not contaminate `graph.nodes[]`
- `graph.containers === undefined` → no error

### 11.2 Group Drag

- Container drag moves contained conversion nodes by the same delta
- Nodes whose centre is OUTSIDE the container are NOT moved
- Post-its inside a container's bounds are NOT moved (only conversion nodes)
- Multi-select: if a contained node is also selected, it is NOT double-moved
- Undo after container drag restores both container and contained node positions (single undo step)

### 11.3 Selection

- Clicking a container sets `selectedAnnotationId` / `selectedAnnotationType` correctly
- Clicking a container clears node/edge selection

### 11.4 Delete

- `deleteSelected()` with a selected container → removed from `graph.containers`, `metadata.updated_at` updated
- Deleting a container does NOT delete the conversion nodes that were inside it

### 11.5 Copy/Paste

- Copy container → paste → new UUID, offset position, same label/colour/size
- Subgraph copy (nodes + containers) → paste → both types present

### 12.6 Resize

- Resizing a container does NOT move any contained nodes

### 12.7 Halo Colour Adaptation

- `toFlow()` with a node inside a container → `data.haloColour` is set to the blended colour (canvas bg + container tint)
- `toFlow()` with a node NOT inside any container → `data.haloColour` is absent or undefined
- ConversionNode renders box-shadow halo with `data.haloColour` when present, `canvasBg` when absent
- ConversionNode renders SVG stroke halo with `data.haloColour` when present, `canvasBg` when absent
- Playwright visual test: node inside coloured container has no visible "punch-through" of canvas colour around it (screenshot comparison)

### 12.8 Schema Parity

- Extend `schemaParityAutomated.test.ts` to cover `Container` fields

---

## 13. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Group drag feedback loop in graph↔ReactFlow sync | Medium | High | During drag, only `setNodes()` — never `setGraph()`. Verify no graph state updates fire during drag. |
| Multi-select + container drag double-moves nodes | Medium | Medium | Exclude `selected: true` nodes from the contained set. Test explicitly. |
| Group drag performance with many contained nodes | Low | Medium | Batch delta application. Note: 50+ nodes in a single container is unusual. |
| Auto-layout displaces nodes from containers | Low | Low | Acceptable — containment is spatial, not structural. |
| Measured node dimensions not available on first render | Low | Medium | Fallback to default dimensions for containment test. |
