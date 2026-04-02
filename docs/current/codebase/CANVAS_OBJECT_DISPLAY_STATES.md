# Canvas Object Display States

How canvas analyses, post-its, and containers handle minimise/maximise/collapse, including persistence, position offsets, and canvas view integration.

## Overview

Canvas objects (analyses and post-its) support a **minimise/restore** toggle that collapses them to a small icon anchored at a chosen corner. This state is **persisted to the graph file** — it survives page reload, git push/pull, and share links.

Containers do not minimise but have distinct visual states during drag and selection.

## Data model

Both `CanvasAnalysis` and `PostIt` have:

```
minimised: boolean (optional, defaults to false)
minimised_anchor: 'tl' | 'tr' | 'bl' | 'br' (optional, defaults to 'tl')
```

These fields are:
- Defined in TypeScript (`types/index.ts`), Python (`lib/graph_types.py`), and JSON schema
- Persisted to the graph YAML file on every mutation
- Part of the graph data model, not ephemeral UI state

## Two-level state system

### Graph-level state (always saved)

`graph.canvasAnalyses[].minimised` and `graph.postits[].minimised` are the authoritative source. Always persisted to file.

### Canvas View state (optional overlay)

`graph.canvasViews[].states[]` stores per-view snapshots of object states. When a named view is active and `applyLayout: true`, the view's states override graph defaults on apply. This allows multiple named snapshots of the same graph with different minimise states.

When the user toggles minimise/restore while a view is active and not locked, `canvasViewService.updateViewObjectState()` also updates the view's saved state.

## Minimise/restore mechanics

### Position offset

When minimising, the node position is adjusted so the minimised icon appears at the chosen corner:

```
minimised_dims = { width: 32, height: 32 }  // (type-specific for analyses)

dx = (anchor === 'tr' || anchor === 'br') ? node.width - minimised_dims.width : 0
dy = (anchor === 'bl' || anchor === 'br') ? node.height - minimised_dims.height : 0

On minimise:  x += dx, y += dy
On restore:   x -= dx, y -= dy
```

This ensures the minimised icon anchors at the chosen corner of the original bounds. The offset is deterministic from the anchor, so restore is lossless.

### Anchor persistence

`minimised_anchor` is preserved even when the object is restored (not minimised). This remembers the user's preferred corner for the next minimise.

### Restore animation

180ms animation window via `restoreAnimUntilRef`. Force-renders every frame during animation. `restoredAnchor` passed to render to show expand direction.

## Toggle UI components

### MinimiseCornerArrows (`canvas/MinimiseCornerArrows.tsx`)

**Normal state**: 4 buttons at corners, hover to reveal. Each corner clickable to minimise from that corner. Icons point inward (toward collapse anchor).

**Minimised state**: 1 button at the anchor corner. Click to restore. Icon points outward (away from anchor).

Hover opacities: 0 (hidden) → 0.15 (other corners) → 0.45 (all visible) → 0.85 (hovered corner). Transition: 450ms ease.

### MinimiseChevron (`canvas/MinimiseChevron.tsx`)

Single button left of node title bar. Chevron: down when normal, right when minimised. Opacity transition 180ms. Positioned relative to title bar centre.

### Context menus

`CanvasAnalysisContextMenu` and `PostItContextMenu` both conditionally show "Minimise" / "Restore" menu items with Minimize2/Maximize2 icons.

## Hover state logic

Dual hover tracking in node components:
- `hovered`: general node hover (debounced 800ms off-delay)
- `iconHovered`: corner/chevron icon hover (immediate on/off)
- `cornerHint`: tracks which corner is hovered (visual preview)
- Hint suppression: 500ms window after toggle to prevent flashing

## Bulk operations (GraphCanvas.tsx)

| Operation | Scope | Behaviour |
|-----------|-------|-----------|
| `handleMinimiseAll()` | All non-minimised objects | Preserves existing anchor or defaults to 'tl' |
| `handleRestoreAll()` | All minimised objects | Preserves anchor for re-minimise |
| `handleMinimiseSelected(ids)` | Selected objects only | Same |
| `handleRestoreSelected(ids)` | Selected objects only | Same |

## Canvas view integration

`canvasViewService.ts` functions:

- `snapshotStates(graph)`: extracts all postits & analyses minimised states into view-storable array
- `applyCanvasView(graph, view)`: applies view's saved object states back to graph (if `applyLayout` enabled), including position adjustment for anchor
- `updateViewObjectState(graph, viewId, objectId, objectType, minimised, anchor)`: updates single object's state within a view

## Container display states

Containers (`ContainerNode.tsx`) do not minimise, but have:
- **Colour variants**: user-selectable background colour
- **Child drag visual**: children become semi-transparent during container drag
- **Selection highlight**: border change on selection
- **Z-order context menu**: bring to front / send to back

## Post-it display states

Post-its (`PostItNode.tsx`) have:
- **Normal**: displays content text, colour background
- **Editing**: inline editor replaces content display (toggle on click)
- **Minimised**: 32px icon at anchor corner (same mechanics as canvas analysis)
- **Colour variants**: user-selectable via context menu

## Properties panel and navigator collapse

These use **different patterns** from canvas object minimise:

### Properties panel sections (`CollapsibleSection.tsx`)

- `isExpanded: boolean` (React useState, NOT persisted)
- Toggle on section header click
- Resets on tab switch or page reload
- Used in PropertiesPanel for node properties, edge properties, metadata sections

### Navigator sections (`ObjectTypeSection.tsx`)

- `isCollapsed: boolean` (React local state, NOT persisted)
- Toggle on section header click
- Resets on page reload
- Per object type (graphs, parameters, contexts, etc.)

### Sidebar minimise (`GraphEditor.tsx` + `useSidebarState`)

- `sidebarState.mode: 'minimized' | 'maximized'` (persisted to IDB via tab editorState)
- Toggle via chevron button
- Width tracked via ResizeObserver
- See SIDEBAR_AND_PANELS_ARCHITECTURE.md for full detail

## Data flow summary

```
User clicks corner arrow / context menu / chevron
  ↓
handleMinimise(anchor) or handleRestore()
  ↓
Calculate position offset from anchor
  ↓
onUpdate(id, { minimised, minimised_anchor, x, y })
  ↓
Graph store updates → GraphCanvas re-renders
  ↓
If active canvas view NOT locked:
  canvasViewService.updateViewObjectState() → saves to view.states[]
  ↓
On file save: YAML includes minimised + minimised_anchor
  ↓
On next load: object restores to saved minimised state
```

## Key invariants

1. **Anchor is persistent**: even when not minimised, `minimised_anchor` stays to remember user's preferred corner
2. **Position reversibility**: offset is deterministic from anchor — restore is always lossless
3. **View override is optional**: canvas views are opt-in snapshots; graph minimised state is always the authoritative fallback
4. **Graph-persisted, not ephemeral**: minimised state survives reload, push, pull, and share

## Key files

| File | Role |
|------|------|
| `src/components/nodes/CanvasAnalysisNode.tsx` | Analysis minimise/restore logic |
| `src/components/nodes/PostItNode.tsx` | Post-it minimise/restore + editing toggle |
| `src/components/nodes/ContainerNode.tsx` | Container display states |
| `src/components/canvas/MinimiseCornerArrows.tsx` | 4-corner arrow UI |
| `src/components/canvas/MinimiseChevron.tsx` | Left-side chevron UI |
| `src/services/canvasViewService.ts` | View state snapshot/apply |
| `src/components/GraphCanvas.tsx` | Bulk minimise/restore operations |
| `src/components/CollapsibleSection.tsx` | Panel section collapse (different pattern) |
| `src/hooks/useSidebarState.ts` | Sidebar minimise (IDB-persisted, different pattern) |
