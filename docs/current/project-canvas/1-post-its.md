# Phase 1: Post-It Notes

**Status**: Design — ready for implementation  
**Date**: 5-Mar-26  
**Prerequisite**: [0-architecture.md](0-architecture.md) — rendering layer, transform pattern, selection model, clipboard integration, test strategy

---

## 1. Overview

A post-it note is a coloured rectangle with user-editable text, draggable and resizable on the canvas. Post-its are visual aids only — they carry no graph semantics and are ignored by all analytics pipelines.

### 1.1 Design Goals

- Render **below edges** at all times (except when selected — z-index boost per architecture doc §2.3)
- Inline text editing via double-click, plus properties panel editing
- Draggable and resizable via standard ReactFlow node mechanics
- Persisted in the graph JSON alongside nodes and edges
- Colours drawn from an authentic 3M Post-it palette
- Minimal new code surface: reuse ReactFlow node system rather than a custom rendering layer

---

## 2. Data Model

### 2.1 TypeScript (already exists, minor refinements needed)

The `PostIt` interface and `postits` field already exist in `graph-editor/src/types/index.ts`:

```typescript
interface PostIt {
  id: string;       // UUID
  text: string;
  colour: string;   // hex, from the palette in §3
  width: number;    // px in flow coordinates
  height: number;   // px in flow coordinates
  x: number;        // flow-space x (was optional, make required)
  y: number;        // flow-space y (was optional, make required)
}
```

On `ConversionGraph`:

```typescript
postits?: PostIt[];
```

Change from current: `x` and `y` become required (non-optional). A postit without a position is nonsensical; the creation code always supplies one.

### 2.2 Python Pydantic Model (new — currently missing)

`graph-editor/lib/graph_types.py` has no `PostIt` model. The `Graph` class must gain a `postits` field, otherwise any Python pipeline that round-trips graph JSON will strip the array.

```python
class PostIt(BaseModel):
    """Canvas annotation: sticky note."""
    id: str
    text: str = Field("", max_length=4096)
    colour: str = Field(..., pattern=r"^#([0-9A-Fa-f]{6})$")
    width: float = Field(..., gt=0)
    height: float = Field(..., gt=0)
    x: float
    y: float
```

Add to `Graph`:

```python
postits: Optional[List[PostIt]] = Field(None, description="Canvas annotations (visual only, not graph semantics)")
```

### 2.3 JSON Schema

`graph-editor/public/schemas/conversion-graph-1.1.0.json` does not include postits. Add the `postits` array definition so that schema validation does not reject graphs containing post-its.

---

## 3. Colour Palette

Six colours based on real 3M Post-it product lines. Screen-accurate hex approximations of the physical note colours.

| Name | Hex | 3M Reference |
|------|-----|-------------|
| Canary Yellow | `#FFF475` | Original Post-it (Canary Yellow pad) |
| Power Pink | `#F4BFDB` | Post-it Super Sticky, Miami collection |
| Aqua Splash | `#B6E3E9` | Post-it Super Sticky, Bora Bora collection |
| Limeade | `#CEED9D` | Post-it Super Sticky, Bali collection |
| Neon Orange | `#FFD59D` | Post-it Super Sticky, Rio de Janeiro collection |
| Iris | `#D3BFEE` | Post-it Super Sticky, Bali collection |

The palette is defined once (constant array) and used by both the context-menu colour picker in `PostItNode` and the properties panel colour picker.

Default colour for new post-its: Canary Yellow.

---

## 4. PostItNode Component

### 4.1 Current State

`graph-editor/src/components/nodes/PostItNode.tsx` (247 lines) already exists with:
- Double-click to edit text (textarea, blur to save)
- `NodeResizer` for drag-to-resize
- Right-click context menu with colour picker and delete
- Folded-corner visual effect
- Comic Sans font

### 4.2 Modifications Needed

1. **Replace colour palette** — swap the generic hex values for the §3 palette.
2. **Extract palette component** — move the colour swatch grid to a shared component (`PostItColourPalette.tsx`), used by both the node's context menu and the properties panel.
3. **Wire `onSelect` to selection context** — currently `onSelect` is in the data interface but not connected.
4. **Ensure resize updates propagate** — the `onUpdate` callback must write `width` and `height` back through `fromFlow()` or directly to graph state.
5. **Remove Comic Sans** — use the editor's standard font family. Post-it visual identity comes from colour and shape, not a novelty font.
6. **Dark mode support** — text colour should adjust when the canvas is in dark mode. The note colour itself stays the same (a yellow post-it is still yellow in a dark room), but the text needs sufficient contrast. Use dark text (#333) on all palette colours — they are all light pastels with adequate contrast.
7. **Text overflow** — long text wraps (`white-space: pre-wrap`) and overflows hidden. No scroll. If the user needs more space, they resize the post-it. This matches the existing component behaviour.

### 4.3 Node Handles

Post-it nodes must NOT render ReactFlow handles. See architecture doc §8.3.

---

## 5. Properties Panel

### 5.1 New Branch

`PropertiesPanel.tsx` currently has three branches: graph properties (no selection), node properties, edge properties. Add a fourth for post-its.

### 5.2 Post-It Properties Section

Two editable fields, following the existing blur-to-save pattern:

**Text** — a `<textarea>` with local state on `onChange`, commit to graph on `onBlur`. Same pattern as the node description field.

**Colour** — a palette picker showing the six colours from §3 as clickable swatches. Selecting a colour commits immediately (no blur needed). Same visual as the right-click colour picker in `PostItNode`, extracted to the shared `PostItColourPalette` component.

### 5.3 Update Mechanism

Mirror the `updateNode` / `updateEdge` pattern:

1. `structuredClone(graph)`
2. Find postit by `selectedPostitId` in `next.postits`
3. Mutate the field
4. Update `next.metadata.updated_at`
5. `setGraph(next)`
6. `saveHistoryState('Update postit <field>')`

---

## 6. Creation and Deletion

### 6.1 Pane Context Menu

Add an "Add Post-It" item to the pane right-click context menu in `GraphCanvas.tsx` (alongside the existing "Add node" item). On click:

1. Generate a UUID for the postit `id`
2. Create a `PostIt` with default values: Canary Yellow, empty text, 200×150 size, position from `contextMenu.flowX / flowY`
3. `structuredClone(graph)`, push new postit to `next.postits` (initialise array if absent), update `metadata.updated_at`
4. `setGraph(next)`, `saveHistoryState('Add postit')`
5. Close context menu
6. Select the new postit

### 6.2 Deletion

Standard canvas object delete pattern (architecture doc §6.5):
- Right-click context menu → Delete
- Keyboard Delete/Backspace (via extended `deleteSelected()`)
- Edit menu Cut/Delete

All paths: find postit by ID in `graph.postits`, remove it, update `metadata.updated_at`, `setGraph`, `saveHistoryState('Delete postit')`. Clear selection if the deleted postit was selected.

### 6.3 Copy/Paste

Standard canvas object clipboard pattern (architecture doc §6.3–6.4):
- Copy captures the `PostIt` object
- Paste creates a new UUID and offsets the position
- Works in subgraph copy (when selected alongside nodes/other objects)

---

## 7. Implementation Plan

### Phase 1a: Schema parity (FIRST)

**Files**: `types/index.ts`, `graph_types.py`, `conversion-graph-1.1.0.json`, `schemaParityAutomated.test.ts`

- Make `x`, `y` required (non-optional) in TypeScript `PostIt` interface
- Add Python `PostIt` model + `Graph.postits` field
- Add `postits` to JSON schema
- Run schema parity tests — verify three-layer agreement
- This MUST land before any frontend code that creates postits

### Phase 1b: Foundation (rendering + drag + resize)

**Files**: `transform.ts`, `GraphCanvas.tsx`, `custom-reactflow.css`, `PostItNode.tsx`

- Register `postit` node type
- Extend `toFlow()` to emit postit nodes (after Sankey layout — architecture doc §5.2)
- Extend `fromFlow()` to extract postit nodes (partitioning by prefix — architecture doc §5.3)
- Add CSS z-index rules (architecture doc §2.4)
- Add MiniMap exclusion (architecture doc §2.6)
- Exclude postit nodes from `fitView` (architecture doc §3.1)
- Exclude postit nodes from auto-layout (architecture doc §3.2)
- Verify pointer events work as expected (architecture doc §2.5)
- Verify lasso selection includes postit nodes
- Verify `onSelectionChange` fires for postit nodes

### Phase 1c: CRUD + selection + edit operations

**Files**: `GraphEditor.tsx`, `GraphCanvas.tsx`, `PostItNode.tsx`, `PostItContextMenu.tsx` (new), `useCopyPaste.tsx`, `subgraphExtractor.ts`, `EditMenu.tsx`

- Extend `SelectionContextType` with `selectedPostitId`
- Wire `onSelectionChange` to detect postit selection (routing by ID prefix)
- Route `onNodeContextMenu` to `PostItContextMenu` for postit nodes (architecture doc §7.1)
- Create `PostItContextMenu.tsx` (colour picker, copy, cut, delete)
- Add "Add Post-It" to pane context menu
- Extend `deleteSelected()` to handle postit nodes (by ID prefix)
- Extend `DagNetSubgraphClipboardData` with optional `postits` array
- Extend `extractSubgraph()` to include selected postits
- Extend `updateManager.pasteSubgraph()` to handle postits (new UUIDs, position offset)
- Extend `dagnet:querySelection` response to include postits
- Wire inline text editing (`onUpdate` callback)
- Wire colour change (`onUpdate` callback)
- Undo/redo verification
- Verify Select All includes postit nodes

### Phase 1d: Properties panel + shared colour palette

**Files**: `PropertiesPanel.tsx`, `PostItColourPalette.tsx` (new, shared), `PostItNode.tsx`

- Extract colour palette to shared component
- Add postit branch to PropertiesPanel (text, colour)
- Replace PostItNode's inline palette with shared component
- Update PostItNode colour constants to §3 palette

### Phase 1e: Creation UI — element palette + menus

**Files**: `ElementPalette.tsx` (new), `SidebarIconBar.tsx`, `GraphEditor.tsx`, `ObjectsMenu.tsx` → `ElementsMenu.tsx`, `MenuBar.tsx`

- Rename "Objects" menu to "Elements" (`ObjectsMenu.tsx` → `ElementsMenu.tsx`, update `MenuBar.tsx`)
- Add "Add Post-It" to Elements menu (dispatches `dagnet:addPostit`, handled by GraphEditor → GraphCanvas)
- Create `ElementPalette.tsx` component with Node + Post-It icons
- Integrate palette into sidebar maximised view (above rc-dock tabs in GraphEditor)
- Integrate palette into sidebar minimised view (above panel icons in SidebarIconBar)
- Wire drag: palette icons → `dagnet-drag` DnD payload → `handleDrop` in GraphCanvas
- Wire click: palette icons → create at viewport centre via `screenToFlowPosition`

---

## 8. Test Plan

Following the architecture doc §9 test strategy and the codebase's integration-first testing standards.

### 8.1 Transform Round-Trip

- `toFlow()` with a graph containing postits → emits ReactFlow nodes with `postit-` prefixed IDs, type `postit`, correct position, z-index -1
- `fromFlow()` with postit ReactFlow nodes → updates `graph.postits[]` positions, does not contaminate `graph.nodes[]`
- Round-trip: create postit → `toFlow()` → mutate position → `fromFlow()` → verify `graph.postits[0].x/y` updated
- `toFlow()` with `graph.postits === undefined` → no error, returns empty array for postits

### 8.2 Selection

- Selecting a postit node fires `onSelectedPostitChange` with the correct ID (prefix stripped)
- Selecting a postit clears `selectedNodeId` and `selectedEdgeId`
- Selecting a conversion node clears `selectedPostitId`

### 8.3 Delete

- `deleteSelected()` with a selected postit → postit removed from `graph.postits`, `metadata.updated_at` updated
- `deleteSelected()` with mixed selection (conversion node + postit) → both removed from respective arrays

### 8.4 Copy/Paste

- Copy a postit → paste → pasted postit has new UUID, offset position, same text/colour/size
- Subgraph copy (nodes + postits) → paste → both types present in pasted result

### 8.5 Schema Parity

- Extend existing `schemaParityAutomated.test.ts` to cover `PostIt` fields across TS / Python / JSON schema

---

## 9. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| `.react-flow__nodes` creates a stacking context in some browser/version | Low | High — postits render above edges | Test in Chrome, Firefox, Safari. See architecture doc §2.7. |
| ReactFlow update changes viewport DOM structure | Low | High — CSS assumptions break | Pin ReactFlow version; document assumption in code comment. |
| `pointer-events: none` on edges SVG is not the default in ReactFlow v11.10.3 | Low | Medium — postits not clickable | Verify during Phase 1b. Add explicit CSS fix if needed. |
| Postit drag stays below edges during drag | Medium | Low — cosmetic only | Acceptable for Phase 1. Future: CSS `.dragging` z-index boost if needed. |
| `fromFlow()` extraction breaks if node IDs collide | Very Low | High — data corruption | The `postit-` prefix makes collision effectively impossible; assert in tests. |
| Large number of postits degrades performance | Very Low | Medium | Simple DOM rectangles. Far cheaper than conversion nodes. |
