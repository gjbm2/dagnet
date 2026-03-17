# Canvas Rendering Architecture

**Source**: `docs/current/project-canvas/0-architecture.md` (sections 2-5)
**Last reviewed**: 17-Mar-26

This doc covers the rendering layer, z-index model, and transform pipeline for canvas objects (post-its, containers, canvas analyses).

---

## 1. Two-Tier Z-Index Model

### ReactFlow Viewport Structure

```
.react-flow__viewport                          ← stacking context root (transform)
  ├─ svg.react-flow__edges                     ← pointer-events: none
  ├─ div  [edge label renderer]                ← pointer-events: none
  └─ div.react-flow__nodes                     ← NO z-index set (critical!)
       ├─ conversion nodes                     ← z-index: 2000
       ├─ container nodes                      ← appended after conversion
       ├─ postit nodes                         ← appended after containers
       └─ canvasAnalysis nodes                 ← appended last (topmost)
```

### The Stacking Context Proof

**`.react-flow__nodes` does NOT create a stacking context.** It has `position: absolute` but no `z-index` (defaults to `auto`), no `transform`, no `opacity < 1`, no `filter`. Per CSS 2.1 Appendix E, `position: absolute` alone without explicit non-auto z-index does not create a stacking context.

Therefore, individual `.react-flow__node` wrappers participate **directly in the viewport's stacking context**.

### DOM Order Controls Paint Order (CRITICAL)

**ReactFlow v11 completely owns inline z-index on node wrapper elements.** Its internal `createNodeInternals()` recalculates z-index for every node on every state change, overwriting any value set via the `zIndex` node property or CSS `!important`.

**What does NOT work:**
- Setting `zIndex` on node objects in `toFlow()` — ReactFlow overwrites it
- CSS `z-index: N !important` on `.react-flow__node-*` — overridden by inline style
- `setNodes()` to update `zIndex` — overwritten on next render cycle

**What DOES work — DOM order:**
ReactFlow renders nodes in the order they appear in the `nodes` array. Later elements paint on top.

| Visual layer (bottom to top) | Mechanism |
|-----|-----------|
| Edges | ReactFlow default rendering |
| Conversion nodes | First in nodes array |
| Containers | Appended after conversion nodes |
| Post-its | Appended after containers |
| Canvas analyses | Appended last |

### Within-Type Z-Order

Array position in the graph data: `graph.postits[0]` = back, `graph.postits[last]` = front. Z-order context menu operations reorder the graph array, then a `reorder*Nodes()` helper sorts the ReactFlow nodes array to match.

---

## 2. Pan Mode — pointer-events: none

Setting `nodesDraggable={false}` and `elementsSelectable={false}` on ReactFlow is **necessary but NOT sufficient**. Per-node values override global props, and interactive components inside nodes still receive events.

**Correct implementation**: CSS class `rf-pan-mode` on `<ReactFlow>`:

```css
.rf-pan-mode .react-flow__node,
.rf-pan-mode .react-flow__nodes,
.rf-pan-mode .react-flow__edges,
.rf-pan-mode .react-flow__edge { pointer-events: none !important; }
```

**Do NOT** set per-node `draggable: true` or `selectable: true` in `toFlow()`.

---

## 3. Tool Mode State — Context, Not Props

`activeElementTool` state must reach `CanvasInner` reliably. It cannot be passed as a prop through `GraphCanvas` because `canvasComponent` is wrapped in `useMemo` that doesn't include it in deps.

**Solution**: `ElementToolContext` provides tool state per graph tab. `GraphEditorInner` provides it; `CanvasInner` and node components consume via `useElementTool()`.

**Rule**: Any state flowing from `GraphEditorInner` to `CanvasInner` that is NOT part of the graph data model should use a React context.

---

## 4. Transform Layer — `toFlow()` / `fromFlow()`

### ID Prefix Convention

| Type | ReactFlow node ID | Node type | Append order |
|------|-------------------|-----------|-------------|
| Container | `container-${id}` | `container` | After conversion nodes |
| Post-it | `postit-${id}` | `postit` | After containers |
| Canvas analysis | `analysis-${id}` | `canvasAnalysis` | Last (topmost) |

### `toFlow()` Extension

For each canvas object type, append typed ReactFlow nodes:
- `id`: prefixed per convention
- `type`: the ReactFlow node type name
- `position`: `{ x, y }` from object data
- `data`: object data plus callbacks (`onUpdate`, `onDelete`)
- `style`: `{ width, height }` from object data
- Do NOT set `zIndex`, `selectable`, or `draggable`

Canvas objects MUST be appended AFTER Sankey layout computation.

### `fromFlow()` Extension

Partition ReactFlow nodes by ID prefix:
1. `postit-` → postit bucket
2. `container-` → container bucket
3. `analysis-` → canvas analysis bucket
4. Everything else → graph nodes

---

## 5. Canvas Object Exclusions

| Operation | Canvas object behaviour |
|-----------|----------------------|
| `fitView` | Included (canvas objects are legitimate viewport content) |
| Auto-Layout (Dagre) | Excluded (keep manual positions) |
| Sankey View | Excluded from d3-sankey; appended after with stored positions |
| Graph Issues | Excluded (not graph semantics) |
| MiniMap | Excluded (return transparent colour) |

---

## 6. Key Source Locations

- `GraphCanvas.tsx` — `toFlow()`, `fromFlow()`, `onNodesChange`, node type registration
- `components/nodes/PostItNode.tsx` — post-it rendering
- `components/nodes/ContainerNode.tsx` — container rendering + group drag
- `components/nodes/CanvasAnalysisNode.tsx` — canvas analysis rendering
- `components/ElementPalette.tsx` — creation palette
- `contexts/ElementToolContext.tsx` — tool mode state
