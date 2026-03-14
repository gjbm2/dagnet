# Phase 5: Snap-to Alignment Guides

**Status**: 5a (Alignment commands) complete; 5b (Snap-to guides) not started
**Date**: 14-Mar-26
**Prerequisite**: Phases 1-3 complete (canvas objects exist and are draggable)

---

## 1. Overview

When dragging any object on the canvas (conversion node, post-it, container, canvas analysis), the object snaps to align with edges and centres of nearby objects. Temporary guide lines appear showing the alignment axis. This is the standard snap-to-align behaviour familiar from Figma, Sketch, PowerPoint, and similar tools.

---

## 2. Snap Types

### 2.1 Edge Alignment

Snap the dragged object's edges (top, bottom, left, right) to the corresponding edges of nearby objects.

```
Dragging node A near node B:

  ┌──────┐
  │  B   │
  └──────┘
      │ ← guide line (vertical, aligned left edges)
  ┌──────┐
  │  A   │  ← snaps so A.left === B.left
  └──────┘
```

Snap targets per axis:
- **Vertical alignment**: left edge, right edge, horizontal centre
- **Horizontal alignment**: top edge, bottom edge, vertical centre

### 2.2 Centre Alignment

Snap the dragged object's centre to the centre of nearby objects.

```
  ┌──────────┐
  │     B    │
  └──────────┘
       │ ← guide line (vertical, aligned centres)
    ┌──────┐
    │  A   │  ← snaps so A.centreX === B.centreX
    └──────┘
```

### 2.3 Spacing (future)

Snap to maintain equal spacing between three or more objects in a row/column. More complex — deferred. The architecture supports it (same interception point), but the computation is O(N²) and the guide line rendering is more involved.

---

## 3. Visual Feedback — Guide Lines

When a snap activates, a temporary guide line appears on the canvas:

- Thin line (1px, accounting for zoom) in a distinct colour (e.g., `#3b82f6` blue or `#ec4899` pink)
- Spans the full extent of the alignment (from the snapped object to the target object, or beyond)
- Appears during drag, disappears on drag stop
- Multiple guide lines can appear simultaneously (e.g., aligned left edge AND top edge)

### 3.1 Rendering Approach

Guide lines render inside the ReactFlow viewport so they pan/zoom with the canvas. Two options:

**Option A: SVG overlay** — an `<svg>` element inside the viewport, siblings of the edges/nodes layers. Draws `<line>` elements for each guide. Performant and resolution-independent.

**Option B: HTML divs** — absolutely positioned `<div>` elements inside the viewport. Same approach as the lasso rectangle.

Option A is preferred — SVG lines are crisp at any zoom level, and the rendering is simple (just `<line x1 y1 x2 y2>`).

### 3.2 State Management

Guide line state is managed in a **ref** (not React state) to avoid re-renders on every drag tick. The ref holds an array of `{ axis: 'x' | 'y', position: number, from: number, to: number }`. A lightweight render loop (direct DOM mutation or a single `forceUpdate` throttled to animation frames) updates the guide line SVG.

---

## 4. Implementation — `onNodesChange` Interception

### 4.1 Why `onNodesChange`, Not `onNodeDrag`

ReactFlow's `onNodeDrag` fires AFTER the position is applied. To snap, we need to MODIFY the position before it's applied. `onNodesChange` fires with pending changes (including `{ type: 'position', position, dragging }`) that we can intercept and adjust.

The existing `onNodesChange`:

```typescript
const onNodesChange = useCallback((changes) => {
  const filteredChanges = changes.filter(change => change.type !== 'remove');
  setNodes(nds => applyNodeChanges(filteredChanges, nds));
}, [setNodes]);
```

With snap:

```typescript
const onNodesChange = useCallback((changes) => {
  const filteredChanges = changes.filter(change => change.type !== 'remove');
  const snappedChanges = snapEnabled
    ? applySnapToChanges(filteredChanges, nodesRef.current, snapThreshold)
    : filteredChanges;
  updateGuideLines(snappedChanges);  // update ref, trigger guide line render
  setNodes(nds => applyNodeChanges(snappedChanges, nds));
}, [setNodes, snapEnabled, snapThreshold]);
```

`applySnapToChanges` examines each `position` change with `dragging: true`, computes the nearest alignment targets, and adjusts the position if within threshold.

### 4.2 The `applySnapToChanges` Function

```
applySnapToChanges(changes, allNodes, threshold):
  for each change where type === 'position' && dragging:
    draggedNode = find node by change.id in allNodes
    draggedRect = { x: change.position.x, y: change.position.y, w: draggedNode.width, h: draggedNode.height }

    targetNodes = allNodes.filter(n => n.id !== change.id)

    bestSnapX = null, bestSnapY = null

    for each targetNode in targetNodes:
      targetRect = { x, y, w, h } from targetNode

      // Check all edge + centre alignments on X axis
      for each (draggedEdge, targetEdge) in X-axis alignment pairs:
        delta = targetEdge - draggedEdge
        if |delta| < threshold && (bestSnapX === null || |delta| < |bestSnapX.delta|):
          bestSnapX = { delta, guidePosition, guideExtent }

      // Same for Y axis
      ...

    if bestSnapX: change.position.x += bestSnapX.delta
    if bestSnapY: change.position.y += bestSnapY.delta

    record guide lines from bestSnapX, bestSnapY

  return snappedChanges
```

### 4.3 Alignment Pairs

For two rectangles A (dragged) and B (target), the alignment pairs per axis are:

**X-axis (vertical guide lines):**
- A.left ↔ B.left
- A.left ↔ B.right
- A.left ↔ B.centreX
- A.right ↔ B.left
- A.right ↔ B.right
- A.right ↔ B.centreX
- A.centreX ↔ B.left
- A.centreX ↔ B.right
- A.centreX ↔ B.centreX

**Y-axis (horizontal guide lines):** same pattern with top/bottom/centreY.

That's 9 checks per axis × N target nodes. For 200 nodes, that's ~3600 comparisons per drag tick — well under 1ms.

### 4.4 Snap Threshold

The threshold is in **flow coordinates** (not screen pixels). A reasonable default is 5-8px in flow space. At high zoom, this feels tighter; at low zoom, looser. This matches Figma's behaviour.

The threshold could be user-configurable (View menu or a preference), but a fixed default is sufficient for Phase 5.

---

## 5. Snap Toggle

Users sometimes want free placement without snapping. Two mechanisms:

- **Keyboard modifier**: hold `Alt` during drag to temporarily disable snap. This is the standard UX convention (Figma, Sketch, PowerPoint all use Alt to suppress snap).
- **Persistent toggle**: a toggle in the View menu or toolbar ("Snap to guides: on/off"). Persisted in `editorState`.

Both should be implemented. The Alt-to-suppress is essential for fine positioning; the persistent toggle is for users who find snapping annoying.

---

## 6. What Snaps to What

All draggable objects on the canvas participate — both as snap sources (being dragged) and snap targets (providing alignment edges):

| Object type | As snap source | As snap target |
|-------------|---------------|---------------|
| Conversion node | Yes | Yes |
| Post-it | Yes | Yes |
| Container | Yes | Yes |
| Canvas analysis | Yes | Yes |

Container group drag: when a container is being dragged, the **container** snaps (it's the object being dragged). Contained nodes move with it but do NOT independently snap. Their position changes (applied programmatically in `onNodeDrag`) are not `dragging: true` in `onNodesChange`, so the snap logic naturally excludes them.

Multi-select drag: the entire selection moves together. Snap applies to the **selection bounding box**, not to individual nodes. This prevents conflicting snap targets within the selection. (Implementation detail: detect multi-select drag, compute selection bbox, snap the bbox, apply delta to all selected nodes.)

---

## 7. Architectural Considerations for Earlier Phases

**No blockers.** The snap implementation is purely additive — it wraps `onNodesChange` and adds guide line rendering. No changes to the data model, schema, transform layer, or persistence.

However, two things to keep in mind during Phases 1-3:

### 7.1 `onNodesChange` Must Remain Composable

The snap logic wraps `onNodesChange` by intercepting position changes. If earlier phases modify `onNodesChange` for other purposes (e.g., container group drag applies additional position changes), the snap wrapper must compose cleanly.

**Recommendation**: structure `onNodesChange` as a pipeline of change processors:

```
onNodesChange(changes)
  → filterRemoves(changes)           // existing: prevent auto-deletion
  → applySnapToChanges(changes)      // Phase 5: snap alignment
  → applyNodeChanges(changes, nodes) // ReactFlow: apply to state
```

Phase 2's container group drag operates in `onNodeDrag` (not `onNodesChange`), so there's no direct conflict. But if future features intercept `onNodesChange`, the pipeline pattern keeps things composable.

### 7.2 Node Dimensions Must Be Available

Snap alignment needs node width/height to compute edges and centres. ReactFlow provides `node.measured?.width` and `node.measured?.height` (v11). Canvas objects set explicit dimensions via `style: { width, height }` in `toFlow()`.

**Recommendation**: during Phases 1-3, always set `style: { width, height }` on canvas object ReactFlow nodes (already specified in the architecture doc). This ensures dimensions are available for snap calculations even before ReactFlow measures the node.

---

## 8. Performance

- O(N) alignment checks per drag tick (N = total nodes on canvas)
- 9 alignment pairs per axis × 2 axes = 18 comparisons per target node
- 200 nodes → ~3600 comparisons per tick → well under 1ms
- Guide line rendering: direct DOM mutation (ref-based), no React re-render
- No spatial indexing needed for typical graph sizes

If future graphs exceed ~500 nodes, spatial indexing (quadtree or simple grid) can be added. Not worth the complexity now.

---

## 9. Explicit Alignment, Distribution & Equal-Size Commands

**Status**: COMPLETE (14-Mar-26)

Complementary to drag-time snapping: explicit commands that align, distribute, or equalise the size of selected objects on demand. Standard in Figma, Sketch, PowerPoint, Illustrator.

### 9.1 Commands

**Alignment commands** (require 2+ selected objects):

| Command | Behaviour |
|---------|-----------|
| Align left edges | Set all selected objects' left edge to the minimum left edge in the selection |
| Align right edges | Set all selected objects' right edge to the maximum right edge in the selection |
| Align top edges | Set all selected objects' top edge to the minimum top edge in the selection |
| Align bottom edges | Set all selected objects' bottom edge to the maximum bottom edge in the selection |
| Align centre horizontally | Set all selected objects' horizontal centre to the horizontal centre of the selection bounding box |
| Align centre vertically | Set all selected objects' vertical centre to the vertical centre of the selection bounding box |

**Distribution commands** (require 3+ selected objects):

| Command | Behaviour |
|---------|-----------|
| Distribute horizontally | Space objects evenly along the X axis (equal gaps between bounding boxes, preserving leftmost and rightmost positions) |
| Distribute vertically | Space objects evenly along the Y axis (equal gaps between bounding boxes, preserving topmost and bottommost positions) |

**Equal-size commands** (require 2+ selected objects):

| Command | Behaviour |
|---------|-----------|
| Make equal width | Set all selected objects' width to the average width of the selection |
| Make equal height | Set all selected objects' height to the average height of the selection |

### 9.2 Anchor Behaviour

Following Figma's default: alignment is relative to the **selection bounding box**, not to any single object. E.g., "Align left" moves all objects to the leftmost edge already present in the selection — no object moves further left than the current leftmost.

Distribution preserves the positions of the two outermost objects and redistributes the interior objects to achieve equal spacing.

Equal-size uses the arithmetic mean of the selection's dimensions.

### 9.3 Access Points

All command sets appear in three places (per the "menus are access points" principle — no logic in menu files):

1. **MultiSelectContextMenu** — shown when right-clicking with 2+ objects selected and the selection includes any canvas objects (post-its, containers, analyses) or is mixed-type. "Align" submenu with all commands.
2. **NodeContextMenu** — shown when right-clicking with 2+ conversion nodes selected (nodes-only multi-select). "Align" submenu appended to existing node context menu items.
3. **Elements menu** (top menu bar) — "Align" submenu, available when a graph tab is active. Commands dispatched via `dagnet:align` / `dagnet:distribute` / `dagnet:equalSize` CustomEvents.

Commands are greyed out (not hidden) when the selection count is insufficient — this makes the feature discoverable.

### 9.4 Service Layer

All alignment/distribution/equal-size logic lives in `alignmentService.ts` (pure geometry, no side effects). The service:

- `computeAlignment(nodes, command)` → array of `PositionUpdate` (only moved nodes)
- `computeDistribution(nodes, command)` → array of `PositionUpdate` (only moved nodes)
- `computeEqualSize(nodes, command)` → array of `SizeUpdate` (only changed nodes)
- `toNodeRect(node)` → extracts `NodeRect` from a ReactFlow node (style → measured → defaults)

### 9.5 Graph Store Write-back

ReactFlow state is NOT the source of truth. The graph store is. The graph→ReactFlow sync overwrites any ReactFlow-only changes on the next cycle (e.g. on deselection).

`useAlignSelection` handles both layers:
1. Updates ReactFlow nodes via `setNodes` (immediate visual feedback)
2. Updates the graph store via `setGraphDirect` (persistence):
   - Conversion nodes: `layout.x/y` (keyed by uuid)
   - Post-its: `x/y`, `width/height` (keyed by `postit-{id}`)
   - Containers: `x/y`, `width/height` (keyed by `container-{id}`)
   - Canvas analyses: `x/y`, `width/height` (keyed by `analysis-{id}`)
3. Saves undo history via `saveHistoryState`

### 9.6 Implementation Artefacts

| File | Role |
|------|------|
| `src/services/alignmentService.ts` | Pure geometry: `computeAlignment`, `computeDistribution`, `computeEqualSize`, `toNodeRect` |
| `src/services/__tests__/alignmentService.test.ts` | 32 tests: all alignment commands, distribution, equal-size, edge cases, `toNodeRect` |
| `src/hooks/useAlignSelection.ts` | Hook wiring: selection → service → `setNodes` + graph store write-back + undo history |
| `src/components/MultiSelectContextMenu.tsx` | Context menu for mixed/canvas-object multi-select (Align submenu) |
| `src/components/NodeContextMenu.tsx` | Added optional Align submenu for nodes-only multi-select |
| `src/components/MenuBar/ElementsMenu.tsx` | Added Align submenu dispatching CustomEvents |
| `src/components/GraphCanvas.tsx` | Routing: `onNodeContextMenu` routes to correct context menu; lasso fix using `toNodeRect` |

### 9.7 Lasso Selection Fix

Fixed lasso selection to use actual node dimensions (via `toNodeRect`) instead of hardcoded `DEFAULT_NODE_WIDTH × 60`. Large canvas objects (charts at ~400×300) were nearly impossible to lasso-select with hardcoded dimensions.

---

## 10. Implementation Steps

### 10.1 Snap-to Guides (drag-time) — NOT STARTED

- Create `useSnapToGuides` hook:
  - Accepts snap threshold, enabled flag, Alt-key state
  - Returns a change processor function for the `onNodesChange` pipeline
  - Manages guide line state (ref-based)
  - Exposes guide line data for rendering
- Create `SnapGuideLines.tsx` component:
  - Renders SVG guide lines inside the ReactFlow viewport
  - Reads guide line state from the hook
  - Uses `requestAnimationFrame` throttling to avoid excessive DOM updates
- Integrate into `GraphCanvas.tsx`:
  - Wrap `onNodesChange` with the snap processor
  - Render `SnapGuideLines` inside the ReactFlow component
  - Wire Alt-key detection (existing `handleKeyDown` / `handleKeyUp` pattern)
- Add "Snap to guides" toggle to View menu
- Persist snap preference in `editorState`

### 10.2 Alignment, Distribution & Equal-Size Commands — COMPLETE (14-Mar-26)

- ✅ Created `alignmentService.ts` (pure geometry functions)
- ✅ Created `useAlignSelection` hook with graph store write-back and undo history
- ✅ Added "Align" submenu to MultiSelectContextMenu, NodeContextMenu, and ElementsMenu
- ✅ Context menu routing in `onNodeContextMenu`: canvas objects → MultiSelectContextMenu; nodes only → NodeContextMenu with alignment appended
- ✅ Added `computeEqualSize` for Make Equal Width / Make Equal Height
- ✅ Fixed lasso selection to use actual node dimensions
- ✅ 32 tests passing in `alignmentService.test.ts`

---

## 11. Test Plan

### Integration tests — Snap-to guides
- Position change with snap enabled → position snaps to aligned target within threshold
- Position change with snap enabled, no nearby targets → position unchanged
- Position change with snap disabled (Alt held) → position unchanged
- Multi-select snap uses selection bounding box, not individual nodes

### Integration tests — Alignment, distribution & equal-size (covered)
- ✅ Align left with 3 objects → all left edges equal the minimum left edge
- ✅ Align centre horizontally → all horizontal centres equal the selection bbox centre
- ✅ Distribute horizontally with 4 objects → equal gaps between bounding boxes, outermost objects unmoved
- ✅ Distribute with exactly 2 objects → no-op (command disabled)
- ✅ Align with 1 object → no-op (command disabled)
- ✅ Mixed object types (node, post-it, container) → alignment works on bounding boxes regardless of type
- ✅ Equal width → all widths set to average, heights preserved
- ✅ Equal height → all heights set to average, widths preserved
- ✅ Already equal → no-op (no updates returned)

### Playwright
- `snap-alignment-guides.spec.ts` — drag node near another node → guide line appears → node snaps to alignment; release → guide line disappears
- `alignment-commands.spec.ts` — select 3 nodes → context menu → Align left → verify positions; select 4 nodes → Distribute horizontally → verify equal spacing
