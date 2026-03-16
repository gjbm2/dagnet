# Graph Write & Sync Architecture — Current State

**Date**: 13-Mar-26
**Status**: Documents the CURRENT system as-built, including a critical instability in the FileRegistry pending update mechanism.

**Related**: `codebase/APP_ARCHITECTURE.md` (app-level architecture overview)

---

## Overview

Every user interaction that modifies the graph (resize, drag, reroute, property edit, toggle) must propagate through a multi-stage sync pipeline:

```
User action → Zustand store → FileRegistry/IDB → notifyListeners → useFileState → (guard) → back to store?
                    ↑                                                                              |
                    └──────────────────────────────────────────────────────────────────────────────┘
```

The system is bidirectional: the store is the in-memory authority during a session, but FileRegistry/IDB is the persistence layer. Changes flow store→file (after canvas edits) and file→store (after external edits like JSON editor, revert, pull). Multiple guards exist to prevent the bidirectional sync from looping, but they have a critical gap.

---

## 1. Graph Write Paths (user action → Zustand store)

### 1a. Synchronous writers (via `setGraphDirect`)

These bypass the async `graphMutationService` wrapper and write directly to the Zustand store. They also manually update `graphRef.current` so rapid successive calls within the same render frame see the latest state.

| Trigger | Handler | Location (GraphCanvas.tsx) |
|---|---|---|
| Container resize | `handleUpdateContainer` | L1597 |
| Post-it resize | `handleUpdatePostit` | L1565 |
| Analysis chart resize | `handleUpdateAnalysis` | L1628 |

Pattern:
```
graphRef.current → structuredClone → mutate → setGraphDirect(next) → graphRef.current = next
```

### 1b. Async writers (via `setGraph` wrapper)

The `setGraph` wrapper (GraphCanvas L391-404) does `await import('graphMutationService')` then calls `graphMutationService.updateGraph(prevGraph, newGraph, setGraphDirect)`. The mutation service calls `setGraphDirect(newGraph)` immediately (L234 of graphMutationService.ts), then checks for topology changes and potentially kicks off async query regeneration.

The `setGraph` wrapper has `[graph, setGraphDirect, setAutoUpdating]` in its deps — it captures the current `graph` for use as `prevGraph` in topology comparison.

| Trigger | Handler | Location |
|---|---|---|
| Node drag end | `onNodeDragStop` | GraphCanvas L4567 |
| Auto-reroute | `performAutoReroute` | GraphCanvas L1135 |
| RF→Graph sync | useEffect | GraphCanvas L3483 |
| File→store sync | useEffect#12 | GraphEditor L1528 |
| Properties panel edits | various | via setGraph |

### 1c. `fromFlow` — ReactFlow state → graph model

`fromFlow(nodes, edges, original)` (transform.ts L170) starts from the `original` graph and patches:
- Conversion node positions from RF `node.position`
- Container/postit/analysis positions from RF `node.position`
- Container/postit/analysis dimensions from RF `node.data.container.width` / `node.data.postit.width` etc.
- Edge connectivity from RF edge source/target/handles

Called at three sites in GraphCanvas:
1. **L3062** (graph→RF sync, slow path end): to compute `lastSyncedReactFlowRef` guard value
2. **L3514** (RF→Graph sync): to build graph from current RF state
3. **L4581** (onNodeDragStop): to capture final drag positions

---

## 2. Store → File Sync (GraphEditor.tsx useEffect#13, L1638-1675)

**Trigger deps**: `[graph, graphRevision, updateData]`

**Guard**: `graphStr === lastSyncedContentRef.current` — skip if content unchanged.

**Action**:
1. `lastSyncedContentRef.current = graphStr`
2. `lastStoreRevisionWrittenRef.current = graphRevision`
3. `writtenStoreContentsRef.current.set(graphStr, graphRevision)` — records this content+revision for stale echo detection
4. `suppressFileToStoreUntilRef.current = Date.now() + 500` — blanket time suppression
5. `updateData(graph, { syncRevision: graphRevision, syncOrigin: 'store' })`

This calls `fileRegistry.updateFile(fileId, graph, { syncRevision, syncOrigin: 'store' })`.

---

## 3. FileRegistry.updateFile (TabContext.tsx L240-358)

### Normal path

1. `file.data = newData` (L302, synchronous)
2. `file.syncOrigin = opts?.syncOrigin` (L304)
3. `await db.files.put(file)` — unprefixed IDB write (L326)
4. `await db.files.put(prefixedFile)` — prefixed IDB write (L332)
5. `this.notifyListeners(fileId, file)` — deep-clones data via `JSON.parse(JSON.stringify())` (L336)

### Re-entrant guard and pending queue

If `updateFile` is called while a previous call for the same fileId is still awaiting its IDB writes:

```typescript
if (this.updatingFiles.has(fileId)) {
    this.pendingUpdates.set(fileId, newData);   // L249 — stores data ONLY, not opts
    return;                                      // L251 — returns immediately
}
```

In the `finally` block (L347-357), after IDB writes complete:

```typescript
this.updatingFiles.delete(fileId);               // L348
const pending = this.pendingUpdates.get(fileId);  // L349
if (pending !== undefined) {
    this.pendingUpdates.delete(fileId);           // L351
    setTimeout(() => {
        void this.updateFile(fileId, pending);    // L354 — NO opts! syncOrigin LOST
    }, 0);
}
```

### notifyListeners (L707-738)

Deep-clones `file.data` via `JSON.parse(JSON.stringify(file.data))`, creating new object references every time. Subscribers (useFileState hooks) always receive a "new" object, causing React re-renders.

---

## 4. File → Store Sync (GraphEditor.tsx useEffect#12, L1528-1636)

**Trigger deps**: `[data, setGraph, saveHistoryState, fileId, fileSyncOrigin, fileSyncRevision]`

**Guards (checked in order)**:

1. **Layout suspend** (L1531): `Date.now() < suspendLayoutUntilRef.current`
2. **Time suppression** (L1543): `Date.now() < suppressFileToStoreUntilRef.current` — 500ms blanket suppression after any store→file sync
3. **Content match** (L1573): `dataStr === lastSyncedContentRef.current` — skip if data matches last synced content
4. **Stale echo rejection** (L1588): `fileSyncOrigin === 'store' && recordedRevision < currentStoreRevision` — skip if this is an echo of an older store write

**If all guards pass**: `setGraph(data)` at L1619 — overwrites the store with file data.

---

## 5. Graph → ReactFlow Sync (GraphCanvas.tsx L1774-3078)

**Trigger deps**: `[graph, setNodes, setEdges, handleUpdateNode, handleDeleteNode, handleUpdateEdge, handleDeleteEdge, handleReconnect, onDoubleClickNode, onDoubleClickEdge, onSelectEdge, effectiveActiveTabId, tabs, useSankeyView, showNodeImages, effectiveWhatIfDSL]`

**Guard**: `graphJson === lastSyncedGraphRef.current` — skip if graph JSON unchanged.

### Fast/slow path decision (L2013-2015)

Fast path when: no edge count/ID/handle changes, no view mode changes, no image boundary changes, and either `isDraggingNodeRef.current` is true OR no node position changes.

### Fast path behaviour

- Updates edge data in place (preserving React component identity)
- Updates canvas object nodes (postit/container/analysis) from graph data
- **Resize guard** (`isResizingNodeRef.current`): if true, preserves RF node style (width/height) — prevents graph→RF sync from overwriting the in-progress resize visual
- **Drag guard** (`isDraggingNodeRef.current`): if true, preserves RF node position — prevents graph→RF sync from overwriting the in-progress drag position
- Always updates `data.container`/`data.postit`/`data.analysis` from graph — this pushes updated dimensions to the node component

### Slow path behaviour

Full rebuild via `toFlow(graph, callbacks)` → creates all RF nodes/edges from scratch → `setNodes(...)` + `setEdges(...)`. Then computes `lastSyncedReactFlowRef = JSON.stringify(fromFlow(newNodes, mergedEdges, graph))`.

---

## 6. ReactFlow → Graph Sync (GraphCanvas.tsx L3483-3533)

**Trigger deps**: `[nodes, edges]` — note: `graph` is accessed via closure but NOT in deps.

**Guards (checked in order)**:

1. `sankeyLayoutInProgressRef` / effects cooldown
2. `visualWhatIfUpdateRef` — skip visual-only what-if changes
3. `isSyncingRef.current` — skip during graph→RF sync
4. `isDraggingNodeRef.current` — block during drag
5. Empty-state checks (nodes=0 with graph.nodes>0, edges=0 with graph.edges>0)
6. `lastSyncedReactFlowRef` JSON match — skip if fromFlow output unchanged

**Action**: `fromFlow(nodes, edges, graph)` → `setGraph(updatedGraph)` (async wrapper)

---

## 7. Critical Instability: Pending Update Stale Data Replay

### The bug

During rapid graph writes (resize at 50ms debounce, drag, reroute), the FileRegistry pending update mechanism creates a path where **stale graph data is written back to the store**, reverting the user's changes.

### Detailed sequence (rapid updates A → B → C)

```
T=0ms   setGraphDirect(A)
        store→file: updateFile(fileId, A, {syncOrigin:'store'}) → IDB write starts

T=50ms  setGraphDirect(B)
        store→file: updateFile(fileId, B, {syncOrigin:'store'})
        → updatingFiles.has(fileId) = TRUE (A's IDB write in progress)
        → pendingUpdates.set(fileId, B)  ← data only, no opts

T=80ms  A's IDB write completes
        → notifyListeners(A, syncOrigin:'store')
        → finally: updatingFiles.delete(fileId)
        → pending = B → setTimeout(() => updateFile(fileId, B), 0)  ← NO opts

T=80ms  [same tick] setGraphDirect(C)  (next resize event)
        store→file: updateFile(fileId, C, {syncOrigin:'store'})
        → updatingFiles.has(fileId) = FALSE → proceeds
        → file.data = C, syncOrigin = 'store', IDB write starts

T=81ms  [setTimeout fires] updateFile(fileId, B)  ← stale data, no opts
        → updatingFiles.has(fileId) = TRUE (C's write in progress)
        → pendingUpdates.set(fileId, B)  ← stale B RE-QUEUED as pending!

T=120ms C's IDB write completes
        → notifyListeners(C, syncOrigin:'store')
        → file→store sync: content matches lastSyncedContent → suppressed ✓
        → finally: pending = B → setTimeout(() => updateFile(fileId, B), 0)  ← STILL stale

T=121ms [setTimeout fires] updateFile(fileId, B)  ← stale!
        → updatingFiles.has(fileId) = FALSE → proceeds
        → file.data = B (STALE!), file.syncOrigin = undefined
        → IDB writes...

T=160ms B's IDB write completes
        → notifyListeners(B, syncOrigin: undefined)
        → useFileState receives: data=B, fileSyncOrigin=undefined

T=160ms file→store sync evaluates:
        1. Time suppression: suppressFileToStoreUntilRef was set at T=80ms (C's sync)
           → now + 500 = T=580ms → T=160ms < T=580ms → SUPPRESSED ✓ (usually)
           BUT: if more time has passed (slower IDB, more pending cycles) → EXPIRED
        2. Content match: JSON(B) ≠ lastSyncedContentRef(C) → MISMATCH
        3. Stale echo: fileSyncOrigin = undefined (not 'store') → GUARD BYPASSED
        → setGraph(B) → STORE REVERTS FROM C TO B
```

### Why the 500ms suppression isn't always sufficient

Each pending replay cycle adds: `setTimeout(0)` delay + two IDB writes. With multiple intermediate updates and re-queuing, the total latency from the last `suppressFileToStoreUntilRef` reset to the final stale notification can exceed 500ms.

More importantly, the **stale data overwrites `file.data` and IDB** even when the file→store sync IS suppressed. This means the file itself is corrupted with stale data, which can resurface on tab restore, refresh, or any other read from IDB.

### Two contributing defects

1. **L354**: `this.updateFile(fileId, pending)` called without opts → `syncOrigin` permanently lost → stale echo guard in file→store sync is bypassed
2. **L249**: `pendingUpdates.set(fileId, newData)` stores only data, not opts. Stale pending data can be re-queued indefinitely when new writes overlap with setTimeout replays, creating an unbounded chain of stale replays.

### Symptoms

- Container/postit/analysis resize snaps back to previous dimensions
- Node movement reverts to pre-drag positions
- Auto-reroute toggle reverts edge handle assignments
- Any rapid sequence of graph mutations can trigger the revert
