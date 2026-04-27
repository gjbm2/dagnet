# Tour: a probability edit

A concrete walkthrough of what happens when a user edits a single edge's `p.mean` from 0.42 to 0.58 in the Properties panel. 12 frames from click to commit-ready.

Read this after [DOMAIN_PRIMER.md](DOMAIN_PRIMER.md) and [TOPOLOGY.md](TOPOLOGY.md), before the deep architecture docs. It exists to give you an integrative trace through every layer the more abstract docs describe in isolation.

---

## The trace

### Frame 1 — User clicks the edge

Selection update flows through ReactFlow → graph store. PropertiesPanel reads `selectedEdgeId` and renders the edge's current values from the graph. No persistence happens at this stage; selection lives in tab state.

Touched: `GraphCanvas.tsx` (ReactFlow selection handler), `PropertiesPanel.tsx`.

### Frame 2 — User changes `p.mean` to 0.58 and blurs the input

PropertiesPanel calls `UpdateManager.updateEdgeProbability(graph, edgeId, 0.58)`. UpdateManager is the **only** sanctioned mutation entry point (anti-pattern 41); inline graph mutations bypass sibling rebalancing, override-flag checks, and the audit log.

Touched: `PropertiesPanel.tsx`, `UpdateManager.ts`.

### Frame 3 — UpdateManager produces nextGraph

UpdateManager clones `graph`, mutates the clone, runs sibling rebalancing (other edges from the same source node have their probabilities adjusted to maintain sum ≤ 1, unless `_overridden` flags block them), and returns a new graph object.

Touched: `UpdateManager.ts` (`rebalanceEdgeProbabilities`).

**Why a new object**: React reconciliation requires a new reference. In-place mutation produces no visible change (anti-pattern 3).

### Frame 4 — setGraph(nextGraph)

GraphEditor's `setGraph` wrapper checks for topology change. A pure probability edit doesn't change topology, so it skips MSMDC regeneration and calls `setGraphDirect(nextGraph)` synchronously.

Topology changes — added/removed/reconnected edges — would route through `graphMutationService.updateGraph` → Python `/api/generate-all-queries` → applied queries.

Touched: `GraphEditor.tsx`, `graphMutationService.ts`.

### Frame 5 — Zustand store updates

GraphStore's `setGraphDirect` updates `graph` and increments `graphRevision`. The store is the in-memory authority during the session, shared across tabs viewing the same file.

Touched: `GraphStoreContext.tsx`.

### Frame 6 — Store → File sync (useEffect on `[graph, graphRevision]`)

GraphEditor's effect#13 fires:

1. Skip if `JSON.stringify(graph) === lastSyncedContentRef`.
2. Record `(content, graphRevision)` in `writtenStoreContentsRef` (used to reject stale echoes later).
3. Set `suppressFileToStoreUntilRef = Date.now() + 500` (blanket 500ms suppression of the reverse direction).
4. Call `updateData(graph, { syncRevision: graphRevision, syncOrigin: 'store' })`.

Touched: `GraphEditor.tsx` (effect#13), `TabContext.tsx`.

### Frame 7 — FileRegistry.updateFile

`updateFile` updates `file.data`, computes `isDirty = (data ≠ originalData)`, writes both IDB records (unprefixed + workspace-prefixed — invariant I-2), and notifies listeners with a deep-cloned snapshot.

If a previous `updateFile` is still in flight, this one queues into `pendingUpdates` and replays via `setTimeout(0)` after the in-flight write completes. This pending-replay path is the source of stale-data races (anti-pattern 9); the `writtenStoreContentsRef` guard catches them at the next read.

Touched: `TabContext.tsx` (FileRegistry), `appDatabase.ts`.

### Frame 8 — IDB writes complete, listeners fire

Other tabs viewing the same file receive the deep-cloned `FileState`. `useFileState` returns the new data plus `fileSyncOrigin: 'store'` and the new `fileSyncRevision`.

A `dagnet:fileDirtyChanged` event fires on `window`. Tab indicators light up; commit menu enables.

Touched: `TabContext.tsx`.

### Frame 9 — File → Store sync attempts (useEffect on `[data, fileSyncOrigin, fileSyncRevision]`)

GraphEditor's effect#12 fires in **every tab including the originating one**. Guards check, in order:

1. **Layout suspend** (`suspendLayoutUntilRef`).
2. **Time suppression** (`suppressFileToStoreUntilRef` set in Frame 6 — within 500ms, skip).
3. **Content match** (`dataStr === lastSyncedContentRef` → skip).
4. **Stale-echo rejection** — `writtenStoreContentsRef.get(dataStr)` returns the revision recorded in Frame 6; if `recordedRevision < currentStoreRevision`, this is a stale echo of an older write.

In the originating tab, time suppression catches it. In other tabs (no suppression set), content-match takes over once they've rendered.

If all guards passed (rare in the originating tab; common in other tabs first time), `setGraph(data)` would run and we'd be back at Frame 4 — but the content matches there too, so the next iteration short-circuits.

Touched: `GraphEditor.tsx` (effect#12).

### Frame 10 — Graph → ReactFlow sync

GraphCanvas's effect on `[graph, ...]` fires. With no topology/handle changes, **fast path**: update edge `data` in place, preserving React component identity. **Slow path** (used on topology changes or view-mode flips): full `toFlow(graph)` rebuild → `setNodes`, `setEdges`. During drag/resize, fast path is forced regardless of topology to preserve in-progress positions.

`isSyncingRef` is set to true before setState, cleared after 100ms (slow) or 0ms (fast). This prevents the reverse direction (RF → Graph) from firing.

Touched: `GraphCanvas.tsx`.

### Frame 11 — ReactFlow renders

The new probability flows through to `EdgeBeads` and `BeadLabelBuilder`. The displayed value updates. Bead width and colour adjust based on the new `p.mean`. If `BeadDisplayMode` is `data-values` or `path-rate`, the topo walk in `computeInboundN` re-runs with the updated probability to produce coherent sibling populations.

If sibling rebalancing changed neighbouring edges (Frame 3), they update too.

Touched: `ConversionEdge.tsx`, `EdgeBeads.tsx`, `statisticalEnhancementService.computeInboundN`.

### Frame 12 — User commits (later)

When the user clicks Commit:

1. `repositoryOperationsService.commitFiles()` queries `db.getDirtyFiles()` (NOT `fileRegistry.getDirtyFiles()` — IDB is the source of truth, anti-pattern 4).
2. Filtered by workspace prefix.
3. Pushed via the Git Data API (atomic multi-file commit: blobs → tree → commit → ref update).
4. `markSaved(fileId)` for each: `originalData = data`, `isDirty = false`, both IDB records updated.

Touched: `repositoryOperationsService.ts`, `gitService.ts`, `TabContext.markSaved`.

---

## What's NOT in this trace

- **Stage 2 enrichment.** A probability edit doesn't trigger fetch — no FE topo pass, no CF pass. Those run on data-fetch flows.
- **Bayes posterior changes.** The Bayes compiler runs offline; its results land via webhook → patch file → `bayesPatchService.applyPatch`. Independent of edit flow.
- **Scenario regeneration.** If the user is editing in a Custom or Fixed scenario, the edit captures into the scenario's diff overlay rather than the base graph. See [SCENARIO_SYSTEM_ARCHITECTURE.md](SCENARIO_SYSTEM_ARCHITECTURE.md).
- **Auto-reroute.** If positions changed (drag), an auto-reroute follow-up updates edge handles after `fromFlow`. Pure probability edits don't trigger this.
- **Hash recomputation.** Probability values aren't part of `core_hash`; the hash is unchanged.

---

## Common bug classes hidden in this trace

| Symptom | Likely frame |
|---|---|
| UI doesn't update after edit | 3 (in-place mutation, no new ref — AP 3) |
| Edit reverts after ~500ms | 7 (pending-replay races — AP 9) |
| Sibling probabilities don't sum to 1 | 2 (bypassed UpdateManager — AP 41) |
| Commit doesn't include the edit | 12 (used FileRegistry not IDB — AP 4) |
| Edit applies in one tab, not another | 9 (suppression window per-tab; check content-match guard) |
| File appears clean despite edit | 7 (`isInitializing` still true — AP 10) |
| Bead width doesn't reflect new probability | 11 (key mismatch in `computeInboundN` — AP 35) |

---

## Source files referenced

- `src/components/PropertiesPanel.tsx`
- `src/services/UpdateManager.ts`
- `src/services/graphMutationService.ts`
- `src/components/editors/GraphEditor.tsx`
- `src/components/GraphCanvas.tsx`
- `src/contexts/GraphStoreContext.tsx`
- `src/contexts/TabContext.tsx`
- `src/db/appDatabase.ts`
- `src/services/repositoryOperationsService.ts`
- `src/services/gitService.ts`
- `src/components/edges/ConversionEdge.tsx`
- `src/components/edges/EdgeBeads.tsx`
- `src/services/statisticalEnhancementService.ts`

---

## Other tours (TODO)

- **Tour: a data fetch from click to chart** — Stage 1 → Stage 2 (FE topo + CF race) → Stage 3 render. Covers the fetch pipeline, MSMDC, snapshots, FE/BE stats parallelism. Not yet written.
- **Tour: a Bayes fit roundtrip** — submit → Modal worker → webhook → atomic commit → patch apply → cascade. Covers the offline inference flow. Not yet written.
- **Tour: opening a graph cold** — workspace load → FileRegistry hydration → GraphStore → ReactFlow → first paint. Covers boot sequencing. Not yet written.
