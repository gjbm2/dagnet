# Sync System Overview

Unified view of how data flows between Git, IndexedDB, FileRegistry, GraphStore, and ReactFlow — the sync arrows, triggers, guards, suppression mechanisms, and known races.

The integrative "map" tying together the detailed docs:

- `STATE_MANAGEMENT_REFERENCE.md` — inventory of all state storage layers and scopes (overlaps on the layer model; this doc focuses on *flow between layers*, that doc on *what lives where*)
- `GRAPH_WRITE_SYNC_ARCHITECTURE.md` — edit propagation pipeline detail (UI → UpdateManager → mutation → persistence)
- `SYNC_ENGINE_GUARD_STATE_MACHINE.md` — the 9 guard refs controlling sync direction and mutual exclusion
- `GRAPH_MUTATION_UPDATE_MANAGER.md` — how UpdateManager drives entity updates and topology changes
- `INDEXEDDB_PERSISTENCE_LAYER.md` — DB identity, tables, prefix contract
- `FILE_REGISTRY_LIFECYCLE.md` — in-memory cache lifecycle, dirty detection
- `GIT_OPERATIONS_ARCHITECTURE.md` — clone/pull/push/commit via GitHub API

## The five layers

```
Git Repository (remote authority, versioned, collaborative)
    ↕  clone / pull / commit (gitService, workspaceService)
IndexedDB db.files (browser persistence, source of truth for isDirty)
    ↕  dual-write on every mutation (both prefixed + unprefixed)
FileRegistry (in-memory Map, performance cache, listener notifications)
    ↕  file↔store sync (useEffect in GraphEditor.tsx)
GraphStore (Zustand, per-file, graph + graphRevision + history)
    ↕  graph↔RF sync (useEffect in GraphCanvas.tsx)
ReactFlow State (nodes/edges arrays, selection, viewport — UI only)
```

### Source of truth per concern

| Concern | Authority | Not authoritative |
|---------|-----------|-------------------|
| File content across sessions | IndexedDB | FileRegistry (empty on reload) |
| Dirty state for git operations | `db.getDirtyFiles()` | `fileRegistry.getDirtyFiles()` |
| Current graph during editing | GraphStore | FileRegistry (may lag by one sync cycle) |
| Node positions during drag | ReactFlow nodes state | GraphStore (overwritten on drag end) |
| Visual presentation | ReactFlow | GraphStore (different data shape) |

## The four sync flows

### Flow 1: Store → File (GraphEditor.tsx)

**Trigger**: `useEffect([graph, graphRevision])` — fires when graph or revision changes.

**Guards**:
1. Content match: skip if JSON equals last synced content

**Action**:
1. Record content + revision in `writtenStoreContentsRef` (Map, bounded to 25 entries)
2. Set `suppressFileToStoreUntilRef = Date.now() + 500` (blanket suppression)
3. Call `fileRegistry.updateFile(fileId, graph, { syncRevision: graphRevision, syncOrigin: 'store' })`

**Downstream**: FileRegistry writes to IDB (both prefixed + unprefixed), fires `notifyListeners()`, emits `dagnet:fileDirtyChanged` if dirty state changed.

### Flow 2: File → Store (GraphEditor.tsx)

**Trigger**: `useEffect([data, fileSyncOrigin, fileSyncRevision])` — fires when FileRegistry data changes.

**Guards** (checked in order):
1. **Layout suspend**: skip if `Date.now() < suspendLayoutUntilRef`
2. **Time suppression**: skip if `Date.now() < suppressFileToStoreUntilRef` (500ms after any store→file sync)
3. **Content match**: skip if JSON equals last synced content
4. **Stale echo rejection**: check `writtenStoreContentsRef.get(dataStr)` — if found and revision < current store revision, this is a stale echo of an older write → skip

**Action** (if all guards pass): `setGraph(data)` — overwrites store with file data.

**Stale echo defence**: `writtenStoreContentsRef` map tracks all content this store has written (content → revision). On incoming file→store, if the exact JSON was previously written by the store at a now-superseded revision, it's stale. **Primary defence** against the pending-replay race (see below).

### Flow 3: Graph → ReactFlow (GraphCanvas.tsx)

**Trigger**: `useEffect([graph, setNodes, setEdges, ...])` — fires when graph changes.

**Path selection**:
- **Fast path**: no topology change, no view mode change, no image boundary change → update edge data in-place, preserve drag/resize positions
- **Slow path**: full `toFlow(graph)` rebuild → new RF nodes/edges arrays

**Guards**:
- JSON match: skip if graph JSON equals last synced
- Drag guard: fast path preserves node position during `isDraggingNodeRef`
- Resize guard: fast path preserves node style during `isResizingNodeRef`
- Layout transaction guard: slow path skips during `sankeyLayoutInProgressRef`

**Sync lock**: sets `isSyncingRef = true` before setState, clears after 100ms (slow) or 0ms (fast). Prevents RF→Graph from firing during Graph→RF.

### Flow 4: ReactFlow → Graph (GraphCanvas.tsx)

**Trigger**: `useEffect([nodes, edges])` — fires when RF state changes (drag, resize, selection connectors).

**Guards** (checked in order):
1. Sankey layout in progress → skip
2. Effects cooldown → skip
3. `isSyncingRef` → skip (prevents loop during Graph→RF)
4. `isDraggingNodeRef` → skip
5. Empty-state check (nodes=0 with graph.nodes>0) → skip (spurious)
6. JSON match → skip

**Action**: `fromFlow(nodes, edges, graph)` → `setGraph(updatedGraph)`.

## Suppression mechanisms

Two independent suppression systems prevent stale data from overwriting fresh state:

| Mechanism | Duration | Set by | Prevents |
|-----------|----------|--------|----------|
| **Time suppression** (`suppressFileToStoreUntilRef`) | 500ms | Store→File sync start | File→Store firing after store write echo returns |
| **MSMDC event suppression** (`dagnet:suppressFileToStoreSync`) | 1000ms | `graphMutationService.updateGraph()` dispatch | File→Store firing during query regeneration |

These stack: if MSMDC fires during a store→file sync, the suppression window is the later of the two.

## Custom events

| Event | Dispatched by | Listened by | Purpose |
|-------|--------------|-------------|---------|
| `dagnet:suppressFileToStoreSync` | graphMutationService (before setGraph) | GraphEditor | Extend file→store suppression during MSMDC |
| `dagnet:fileDirtyChanged` | FileRegistry.updateFile | UI components | Dirty state indicators |
| `dagnet:liveShareRefreshed` | liveShareSyncService | useShareChartFromUrl | Trigger chart recompute after share refresh |
| `dagnet:logicalIdChanged` | FileRegistry | Various | Parameter/context/case/node ID rename notification |
| `dagnet:bayesPosteriorsUpdated` | bayesPatchService.applyPatchAndCascade (after Tier 2) | useDSLReaggregation | Force live-edge posterior re-projection against the active DSL after a fit lands |

## Initialisation lifecycle

1. File created with `isInitializing: true` — dirty detection is **off** (normalisation absorbed)
2. Editor normalises content (sorts keys, injects defaults) → `updateFile` absorbs into `originalData`
3. `completeInitialization(fileId)` scheduled 500ms after load → sets `isInitializing: false`
4. From this point, dirty detection is **on**: `data ≠ originalData` → `isDirty: true`

**Failure mode**: if `completeInitialization()` never fires, file appears clean forever (all edits absorbed).

## Known races and failure modes

### Race 1: Pending replay stale echo

**Scenario**: rapid writes A→B→C within 500ms. FileRegistry queues pending updates. If pending B is replayed after suppression window expires and its exact JSON isn't in `writtenStoreContentsRef`, it looks like an external change → **store reverts from C to B**.

**Defence**: `opts` (including `syncOrigin`) is preserved during pending replay. `writtenStoreContentsRef` tracks content→revision map. Revision-based guard catches stale echoes even when `syncOrigin` is lost.

### Race 2: Pull completing during active editing

**Scenario**: user is editing a file, non-blocking pull completes and writes new content to FileRegistry.

**Defence**: 3-way merge (not remote-wins) preserves local changes. If conflicts exist, pull does not modify the file. After a successful auto-merge that absorbed local-only content, `file.originalData` MUST reflect the remote baseline (not the merged result), `file.isDirty` MUST stay true, and `isInitializing` MUST NOT be re-set on the merge path. Setting `originalData = mergedData` makes the next pull see `hasLocalChanges = false` and silently overwrite with remote (AP 55, I-20a). Setting `isInitializing = true` on the merge path re-engages the FileRegistry's absorption logic, which folds the local-only content into `originalData` on the next normalisation pass and produces the same silent loss one cycle later.

### Race 3: ReactFlow reset clobbering concurrent mutations

**Scenario**: selection connectors call `setNodes()` (type:reset) while user is resizing → resize changes discarded.

**Defence**: `onNodesChange` filters out type:reset during active resize/drag.

### Race 4: Graph→RF overwriting drag position

**Scenario**: graph updates (from unrelated pull) during user drag.

**Defence**: `isDraggingNodeRef` forces fast path, which preserves node position. On drag end, next Graph→RF sync may overwrite — but `fromFlow` on drag-end has already committed the final position.

### Race 5: Non-blocking pull during suppression window

**Scenario**: non-blocking pull starts during the 500ms file→store suppression window.

**Defence**: pull writes to FileRegistry, notification is suppressed. After 500ms expires, next file→store sync will fire with the merged content. If pull conflicted, the conflict modal blocks further sync until resolved.

## The posterior/state propagation lesson

Common failure pattern: data exists in **three layers simultaneously** (param file → graph edge projected value → React render tree). Stage 4(b) removed the persistent `_posteriorSlices` stash on graph edges, so the slice library no longer lives in two places — the parameter file is the single source of truth for posteriors. Deleting from one layer is useless unless all are handled. Before modifying any state:

1. **Trace all locations** where the value lives — grep across param files, graph edges, and render props
2. **Trace what triggers React re-render** — in-place mutation does nothing; `setGraph` with a new reference is required
3. **Trace the cascade** — UpdateManager mapping configurations project param file fields onto graph edges; clearing the file doesn't clear the graph copy
4. **Test idempotently** — "delete when already deleted" must still clean up all derived state

Single most common cause of multi-attempt fixes. Read GRAPH_MUTATION_UPDATE_MANAGER.md for the mapping configurations.

### Three writers to `edge.p.posterior`, only one is DSL-aware

Worth knowing because the two DSL-blind writers (which run on every fit and every cascade) silently produce stale projections when the user is on a context-qualified or cohort-mode DSL:

- **`bayesPatchService.applyPatch`** — direct write at fit-apply time. Hardcodes `slicesRaw['window()']` and `slicesRaw['cohort()']`. Picks the bare aggregate slice. Has no `currentDSL` parameter.
- **UpdateManager mapping** at [`updateManager/mappingConfigurations.ts`](src/services/updateManager/mappingConfigurations.ts) — fires through the cascade whenever `getParameterFromFile` runs. Hardcodes `projectProbabilityPosterior(value, '')` (empty DSL). Picks the bare aggregate slice. Even though `getParameterFromFile` receives `targetSlice: currentDSL`, that DSL is used for window aggregation and slice-family `values[]` matching, NOT threaded into the posterior mapping.
- **`contextLiveGraphForCurrentDsl`** at [`posteriorSliceContexting.ts`](src/services/posteriorSliceContexting.ts) — invoked by [`useDSLReaggregation`](src/hooks/useDSLReaggregation.ts). DSL-aware: matches the slice key `${context-dims}.${mode}()` from the current DSL. Single source of truth for what should land on the live edge.

The DSL-aware re-projection is gated by `lastContextedDSLRef.current === currentDSL`, so it only fires on a DSL change. After a fresh fit, the DSL has not changed and the gate trips — leaving the bare-aggregate projection from the two DSL-blind writers in place. The 29-Apr-26 fix dispatches `dagnet:bayesPosteriorsUpdated` from `applyPatchAndCascade` after Tier 2 succeeds; `useDSLReaggregation` listens, runs `contextLiveGraphForCurrentDsl` against the active DSL, and `setGraph`s the result. This closes the gap created when Stage 4(b) removed `_posteriorSlices` AND the Bayes compiler started emitting context-qualified slices: pre-Stage-4(b), both shapes lived on the graph file together, so the user's view always matched the most recent fit. Now the file is the slice library and the graph holds only one projection at a time, so the FE must re-project on every event that could change the active slice — DSL change OR posterior arrival.

### Pull post-merge invariant

After a 3-way pull merge that absorbed local-only content, `file.originalData` must track the remote baseline (not the merged result), `file.isDirty` must remain `true`, and `isInitializing` must not be re-set on the merge path. Violating this produces the "second pull silently overwrites" failure (AP 55, I-20a). Symptom is most visible for files the user rarely edits directly — parameter YAMLs holding bayes posteriors are the canonical case.

## Key files

| File | Role |
|------|------|
| `src/components/editors/GraphEditor.tsx` | File↔Store bidirectional sync (effects #12, #13) |
| `src/components/GraphCanvas.tsx` | Graph↔RF sync (fast/slow paths, interaction guards) |
| `src/contexts/TabContext.tsx` | FileRegistry (pending updates, dirty detection, initialisation) |
| `src/contexts/GraphStoreContext.tsx` | GraphStore (graph, graphRevision, history) |
| `src/services/graphMutationService.ts` | MSMDC suppression dispatch |
| `src/services/workspaceService.ts` | Workspace load, `completeInitialization` scheduling |
| `src/services/repositoryOperationsService.ts` | Single-file pull (`pullFile`), 3-way merge invariants |
| `src/hooks/useDSLReaggregation.ts` | Live-edge posterior re-context on DSL change AND on `dagnet:bayesPosteriorsUpdated` |
| `src/services/posteriorSliceContexting.ts` | DSL-aware posterior projection (the only writer that knows the current DSL) |
| `src/services/bayesPatchService.ts` | Bayes patch apply + cascade; dispatches `dagnet:bayesPosteriorsUpdated` after Tier 2 |
| `src/db/appDatabase.ts` | IDB schema, `getDirtyFiles()` |
