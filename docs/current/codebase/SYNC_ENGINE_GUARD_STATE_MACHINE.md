# Sync Engine Guard State Machine

**Source**: `docs/current/refactor/b1-sync-engine-design.md` (sections 2-3)
**Last reviewed**: 17-Mar-26

Encodes the implicit state machine governing GraphCanvas's sync guard behaviour — the set of refs controlling which sync direction fires and when.

**See also**: `SYNC_SYSTEM_OVERVIEW.md` (integrative map), `GRAPH_WRITE_SYNC_ARCHITECTURE.md` (the edit propagation pipeline these guards protect)

---

## 1. The Guard Refs

The sync engine's behaviour is controlled by 9 refs forming an implicit mutual exclusion protocol: "don't run X while Y is in progress."

### Primary sync guards (control which sync direction fires)

| Ref | Purpose | Prevents |
|---|---|---|
| `isSyncingRef` | Graph→RF sync is in progress | RF→Graph sync from firing (loop prevention) |
| `isDraggingNodeRef` | User is dragging a node | Graph→RF sync from overwriting RF positions (forces fast path) |
| `isResizingNodeRef` | User is resizing a canvas object | Graph→RF sync from overwriting RF styles |

### Layout transaction guards (suppress cascading side-effects)

| Ref | Purpose | Prevents |
|---|---|---|
| `sankeyLayoutInProgressRef` | Sankey layout is running | Reroutes, what-if recomputes, RF→Graph sync |
| `effectsCooldownUntilRef` | Timestamp-based suppression window | Same as above (time-based) |
| `skipSankeyNodeSizingRef` | Sankey layout already set node sizes | Next Sankey sizing effect from re-computing |

### Throttle gates

| Ref | Purpose | Prevents |
|---|---|---|
| `recomputeInProgressRef` | rAF-throttled what-if recompute in flight | Double-scheduling of what-if edge recompute |
| `visualWhatIfUpdateRef` | Edge update is visual-only (what-if) | RF→Graph sync from persisting visual-only changes |
| `sankeyUpdatingRef` | Sankey node sizing in progress | Re-entrant Sankey sizing |

---

## 2. Guard Check Sites

Every location where a guard ref is read for control flow:

| Guard | Check site | Decision |
|---|---|---|
| `isSyncingRef` | `onNodesChange` | Skip reroute trigger if syncing |
| `isSyncingRef` | RF→Graph sync effect | Skip entire RF→Graph sync |
| `isDraggingNodeRef` | Main sync fast/slow decision | Force fast path during drag |
| `isDraggingNodeRef` | RF→Graph sync effect | Block RF→Graph sync during drag |
| `isResizingNodeRef` | Main sync fast/slow decision | Force fast path during resize |
| `isResizingNodeRef` | Fast path reconciliation | Preserve RF styles during resize |
| `isResizingNodeRef` | RF→Graph sync effect | Block RF→Graph sync during resize |
| `sankeyLayoutInProgressRef` | `onNodesChange` | Suppress reroute during layout |
| `sankeyLayoutInProgressRef` | What-if recompute effect | Skip recompute during layout |
| `sankeyLayoutInProgressRef` | RF→Graph sync effect | Skip sync during layout |
| `effectsCooldownUntilRef` | `onNodesChange` | Suppress reroute during cooldown |
| `effectsCooldownUntilRef` | What-if recompute effect | Skip recompute during cooldown |
| `effectsCooldownUntilRef` | RF→Graph sync effect | Skip sync during cooldown |
| `visualWhatIfUpdateRef` | RF→Graph sync effect | Skip sync for visual-only updates |
| `recomputeInProgressRef` | What-if recompute effect | Skip if already in progress |
| `sankeyUpdatingRef` | Sankey what-if effect | Skip if already updating |
| `skipSankeyNodeSizingRef` | Sankey what-if effect | Skip sizing after layout |

---

## 3. Guard API (`syncGuards.ts`)

Guards are formalised in `canvas/syncGuards.ts` as a module-level singleton with named transition functions. External code calls named operations rather than directly mutating refs.

### Transition functions (called by external code)

- `guards.beginInteraction(kind: 'drag' | 'resize')` — called by useNodeDrag / handleResizeStart
- `guards.endInteraction(kind: 'drag' | 'resize')` — called by useNodeDrag / handleResizeEnd
- `guards.beginLayoutTransaction(cooldownMs)` — called by performSankeyLayout
- `guards.endLayoutTransaction(extendCooldownMs)` — called by performSankeyLayout's setTimeout

### Query functions

- `guards.isBlocked()` — true if layout transaction or cooldown is active
- `guards.isInteracting()` — true if dragging or resizing
- `guards.isDragging()` — true if dragging specifically
- `guards.isResizing()` — true if resizing specifically
- `guards.isSyncing()` — true if Graph→RF sync is in progress

### Module-level singleton for node components

Node components (CanvasAnalysisNode, PostItNode, ContainerNode) cannot receive guard callbacks through ReactFlow node data — functions in `node.data` are unreliable in controlled mode (see `REACTFLOW_CONTROLLED_MODE.md`). Instead, they import `beginResizeGuard()` / `endResizeGuard()` directly from `syncGuards.ts`.

---

## 4. Known Design Issues

### setTimeout-based clearing with magic delays

Five different delay values (0, 50, 100, 150, 250ms) are used for clearing flags. None are tied to observable completion events. A slow frame or React batching change could violate assumptions.

### Legitimate setTimeout catalogue

| Delay | Location | Purpose |
|---|---|---|
| 0ms | RF→Graph `isSyncingRef` clear | Clear after RF→Graph sync |
| 0ms | Sankey `sankeyUpdatingRef` clear | Clear re-entrancy gate |
| 0ms | `visualWhatIfUpdateRef` clear | Clear visual-only flag |
| 100ms | Slow path `isSyncingRef` clear | Let cascading updates complete |
| 150ms | `sankeyLayoutInProgressRef` clear | Let Sankey effects settle |
| 250ms | Initial fitView | Wait for nodes to populate |

### Single-owner semantics

Each guard has exactly one "owner" that sets and clears it. Cross-owner mutations were identified as bugs/redundancies during the B1 refactor investigation and removed:

- Fast-path `isDraggingNodeRef` setTimeout(0) clear — **latent race condition** (removed)
- Edge scaling `isSyncingRef` defensive clear — **unnecessary** (removed)
- `handleDeleteNode`/`handleDeleteEdge` `isSyncingRef` clears — **redundant** (Graph→RF sync doesn't check this flag)

---

## 5. Three Guard Domains

The 9 guards group into 3 logical domains:

**Domain 1 — Sync direction control**: `syncing`, `interacting` (drag/resize)

**Domain 2 — Layout transaction**: `layoutTransaction`, `cooldownUntil`, `skipSankeyNodeSizing`

**Domain 3 — Throttle gates**: `recomputeInProgress`, `visualOnlyUpdate`, `sankeyUpdating`

---

## 6. Pitfalls

### Anti-pattern 9: Suppression-window race during rapid mutations

**Signature**: state appears correct immediately after a change but reverts to a previous value after ~500ms.

**Root cause**: store→file sync sets a 500ms suppression window on file→store sync. If the suppression expires before all pending FileRegistry writes complete, a stale file notification can overwrite the store.

**Fix**: check `suppressFileToStoreUntilRef` timing. Check `writtenStoreContentsRef` for stale-echo detection. See `SYNC_SYSTEM_OVERVIEW.md` for the full guard system.

## 7. Key Source Locations

- `canvas/syncGuards.ts` — guard API + module-level singleton
- `canvas/useGraphSync.ts` — sync engine hook, guard binding
- `GraphCanvas.tsx` `onNodesChange` — guard queries for reroute suppression
- `useNodeDrag` — drag guard transitions
- `useEdgeRouting` — reads `isBlocked()` and `isEffectsCooldownActive()`
