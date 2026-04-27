# ReactFlow Controlled Mode: Mental Model and Pitfalls

**Date**: 17-Mar-26
**Purpose**: Encode hard-won understanding of how ReactFlow v11's controlled mode actually works internally, what breaks when you fight it, and the patterns that survive reliably. We have repeatedly lost days debugging symptoms whose root causes were invisible without this mental model.

---

## The controlled mode pipeline

DagNet uses ReactFlow in **controlled mode**: the `nodes` prop on `<ReactFlow>` is the source of truth. ReactFlow never mutates it directly; it sends proposed changes through `onNodesChange`.

Pipeline for a single state update:

```
React state (nodes)
  ──[useStoreUpdater useEffect]──>  Zustand store (nodeInternals)
  ──[NodeRenderer reads store]──>   Rendered DOM
```

### The two-render lag

`useStoreUpdater` syncs controlled `nodes` into `nodeInternals` via a `useEffect` (post-render). `NodeRenderer` reads from `nodeInternals` (Zustand store), NOT from the `nodes` prop.

Every controlled state update therefore causes **two renders**:

1. First render: React state is updated, but `nodeInternals` still holds the **previous** values. NodeRenderer paints stale positions.
2. The `useEffect` fires, syncing `nodeInternals`. This triggers a **second** render with correct values.

**Why bottom-right resize doesn't bounce but left/top does**: bottom-right resize only changes `width`/`height` (CSS properties on the node element). Left/top resize changes `position` (CSS `transform`), and the stale `transform` from render 1 visibly moves the node to its old position before render 2 corrects it.

**Mitigation**: during high-frequency interactions (resize, drag), apply changes directly to `nodeInternals` via `rfStore.setState()` synchronously in `onNodesChange`, before the controlled state update. Eliminates the stale-first-render problem. See GraphCanvas.tsx `onNodesChange` handler.

---

## type:'reset' changes — the nuclear option

When code calls `useReactFlow().setNodes(fn)` in controlled mode:

1. ReactFlow reads `getNodes()` from the Zustand store (nodeInternals)
2. Applies the setter function to produce new nodes
3. Creates `type: 'reset'` changes for EACH resulting node
4. Calls `onNodesChange` with those changes

In `applyNodeChanges`, if ANY change has `type: 'reset'`, it **replaces the entire node array** with `changes.filter(c => c.type === 'reset').map(c => c.item)`, discarding ALL other changes in the same batch.

Any `setNodes()` call (e.g. SelectionConnectors updating halo highlights) can clobber concurrent resize/drag changes if they're in the same `onNodesChange` batch.

**Mitigation**: during active resize/drag, filter out `type: 'reset'` changes in `onNodesChange`. See the `resizing` guard in GraphCanvas.tsx.

---

## Functions in node.data are unreliable

**This is the single most expensive lesson in this codebase.**

ReactFlow stores nodes in a Zustand store (`nodeInternals`). In controlled mode, nodes round-trip through:

```
controlled nodes prop
  → useStoreUpdater → nodeInternals (Zustand Map)
  → getNodes() (called by setNodes, SelectionConnectors, etc.)
  → onNodesChange with type:'reset'
  → applyNodeChanges → new controlled state
```

During this round-trip, `node.data` is preserved as a plain object. But function references in `data` can be silently lost when:

- `type:'reset'` changes reconstruct nodes from `nodeInternals` state
- The sync effect (useGraphSync) applies a fast-path that skips re-setting data when it detects no "data change" — but the change detection doesn't include function identity
- React.memo prevents re-render, so stale `data` with missing functions persists

Symptom: a callback that works on first render but becomes `undefined` after some unrelated interaction triggers a `setNodes()` round-trip. Nearly impossible to debug from symptoms alone:

1. The callback IS set correctly on node creation
2. It disappears silently (no error, no warning)
3. Loss is triggered by unrelated code (SelectionConnectors halo updates)
4. Any fix that re-threads the callback through `data` will work temporarily and then break again on the next round-trip

### The solution: module-level singletons

**Never pass interaction callbacks (resize, drag guards) through ReactFlow node data.** Use module-level singleton state that node components import directly.

Pattern (same as useGroupResize):

```
// syncGuards.ts — module-level singleton
let _guards: SyncGuards | null = null;
export function bindSyncGuards(guards: SyncGuards) { _guards = guards; }
export function beginResizeGuard() { _guards?.beginInteraction('resize'); }

// useGraphSync.ts — bind on each render
bindSyncGuards(guards);

// CanvasAnalysisNode.tsx — call directly, no data prop needed
import { beginResizeGuard } from '../canvas/syncGuards';
const handleResizeStart = useCallback(() => {
  beginResizeGuard();
  groupResizeStart(`analysis-${id}`);
}, []);
```

Bypasses the ReactFlow data pipeline. The function reference is a stable module-level export — never lost by node round-trips.

**Rule**: if a node component needs to call something in the sync engine (guards, group operations), it should import a module-level function, not receive a callback through `data`.

---

## ResizeObserver dimension changes

ReactFlow attaches ResizeObservers to node DOM elements. When a node's size changes (for any reason), the observer fires and sends `type: 'dimensions'` changes through `onNodesChange`.

During group resize, `groupResize()` manipulates peer node DOM styles directly (for performance). This triggers ResizeObserver, which sends dimension changes that lack `updateStyle: true`. When `applyNodeChanges` processes these, it sets `node.width`/`node.height` but NOT `node.style`, causing React to overwrite the DOM manipulation on the next render.

**Mitigation**: during active resize, filter out `type: 'dimensions'` changes that don't have `resizing: true` or `resizing: false` (these are the "real" resize changes from d3-drag; everything else is ResizeObserver noise).

---

## Summary of interaction-safe patterns

| Need | Wrong approach | Right approach |
|---|---|---|
| Pass callback to node component | `node.data.onResizeStart = fn` | Module-level singleton import |
| Update node during drag/resize | `setNodes()` (creates type:'reset') | Direct DOM manipulation + commit in onEnd |
| Prevent sync clobbering during interaction | Hope it doesn't happen | Guard flag + filter in onNodesChange |
| Prevent two-render position bounce | Nothing (accept the flicker) | Sync nodeInternals directly via rfStore.setState() |
| Save final state after interaction | `onUpdate()` mid-drag | `onUpdate()` only in onEnd handler |

---

## Key source locations

- `syncGuards.ts` — guard state + module-level singleton for resize/drag guards
- `useGroupResize.ts` — module-level singleton for group resize cascading
- `useGraphSync.ts` — Graph-to-ReactFlow sync engine, guard binding
- `GraphCanvas.tsx` `onNodesChange` — filtering + synchronous nodeInternals update
- `@reactflow/core/dist/esm/index.js` line ~2241 — `applyNodeChanges` type:'reset' behaviour
- `@reactflow/core/dist/esm/index.js` line ~1231 — `useStoreUpdater` controlled mode sync
- `@reactflow/node-resizer/dist/esm/index.js` — d3-drag resize internals
