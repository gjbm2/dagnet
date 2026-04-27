# Plan: Headless Retrieve-All + BE Topo Pass Race Fix

**Historical note (`27-Apr-26`)**: this plan pre-dates the removal of the quick BE topo pass (24-Apr-26). References below to `beTopoPassService.ts`, the BE topo pass race condition, and `analytic_be` describe the system as it stood when the plan was written. See [project-bayes/73b](../project-bayes/73b-be-topo-removal-and-forecast-state-separation-plan.md) for the current BE surface. The Change-1 (headless retrieveall) part of the plan remains independently applicable; the Change-2 (race fix) is moot now that the BE topo pass is gone.

## Context

Two issues:

**1. Automation performance:** During `?retrieveall` automation, the per-graph loop opens a GraphEditor tab for each graph. This mounts ReactFlow, ScenariosContext, canvas analysis compute, chart recompute, edge geometry calculations, and 9 sync effects — ALL completely wasted during headless automation. Worse, every parameter file written during the retrieve (hundreds per graph) triggers the full cascade: `fileRegistry.updateFile()` → `notifyListeners()` → `useFileState` → GraphEditor re-render → Zustand setGraph → scenarios regen → chart recompute → canvas analysis → edge geometry. This makes the automation extremely slow and causes it to stall when the browser throttles background tabs.

**2. BE topo pass race condition (affects ALL retrieve paths):** The BE topo pass runs as a fire-and-forget async IIFE (fetchDataService.ts line 1957). It clones `finalGraph`, adds `analytic_be` model_vars, and calls `setGraph(beGraph)`. Meanwhile `computeAndApplyInboundN` (line 2132) also mutates `finalGraph` and calls `setGraph()`. The BE clone captures state BEFORE inbound-n — so the BE graph has no inbound-n results, and the inbound-n graph has no `analytic_be` entries. Last writer wins; the other's work is silently discarded.

## Scope

- **Change 1 (headless):** Scoped ONLY to the automated `?retrieveall` path in `dailyAutomationJob.ts`. The manual "Retrieve All Slices" from the Data menu is completely unaffected.
- **Change 2 (race fix):** Scoped to `fetchDataService.ts` Stage-2 section. Affects ALL retrieve paths (manual and automated). Fixes a correctness bug — not a new behaviour change.

## Exhaustive Dependency Trace

### What the retrieve service actually needs (proven by line-by-line trace)

The retrieve pipeline (`retrieveAllSlicesService.execute()` → `fetchDataService.fetchItems()` → `fetchSingleItemInternal()` → `dataOperationsService.getFromSourceDirect()`) was traced line by line. Every function in the chain was checked for dependencies on React state, Zustand/GraphStore, ScenariosContext, or mounted components.

**Result: NO React/Zustand/UI dependencies.** The entire pipeline operates through:
1. **Graph data object** — passed as parameter, tracked locally via `latestGraph` closure variable
2. **`getGraph()` callback** — called at the start of each slice (retrieveAllSlicesService line 333) and in the post-run refresh (line 1089). Returns the current graph data.
3. **`setGraph()` callback** — called via `trackingSetGraph` wrapper (line 744-747) which updates local `latestGraph` then calls the caller's `setGraph()`. Called after each parameter fetch, after LAG topo pass (line 1871), after inbound-n (line 1040), and for metadata stamping (line 1153).
4. **`fileRegistry.getFile()`** — called directly for parameter file lookups during Stage-2 LAG (lines 1501, 1661, 1728 of fetchDataService.ts). These are READS from the FileRegistry singleton.
5. **`fileRegistry.updateFile()`** — called indirectly via `dataOperationsService.getFromSourceDirect()` to persist fetched parameter/case data to IDB.
6. **Stateless services** — `sessionLogService`, `operationRegistryService`, `forecastingSettingsService` (read-only config), `UpdateManager` (pure graph mutation utility).

**Confirmed NOT used by the pipeline:**
- `useGraphStore` / `useGraphStore.getState()` — grep confirms zero calls in fetchDataService.ts
- `useScenariosContext` — not imported by any service file
- `useFileState` — not imported by any service file
- `useTabContext` — not imported by any service file
- Any React hooks — services are plain TypeScript classes/functions

### What `setGraph()` does in each path

**Tab-open path (current):**
```
setGraph(g) → tabOps.updateTabData(graphFileId, g)
  → fileRegistry.updateFile(graphFileId, g)
    → db.files.put(file)                          // IDB write
    → notifyListeners(graphFileId, file)           // Fire subscribers
      → useFileState subscriber → setFile(clone)   // React re-render
        → GraphEditor useEffect → setGraph(data)   // Zustand update
          → ScenariosContext → extractParams        // Param extraction
          → ScenariosContext → regenerateAllLive    // Scenario regen
          → ScenariosContext → chartReconcile       // Chart recompute
          → useGraphSync → ReactFlow node/edge sync // Canvas re-render
          → useCanvasAnalysisCompute → recompute    // Analysis compute
          → Edge geometry recalculation             // Layout math
```

**Headless path (proposed):**
```
setGraph(g) → fileRegistry.updateFile(graphFileId, g)
  → db.files.put(file)                            // IDB write (same)
  → notifyListeners(graphFileId, file)             // Fire subscribers
    → (no subscribers — no GraphEditor mounted)    // NO-OP
  → dagnet:fileDirtyChanged event                  // Dispatched (harmless)
```

The IDB write is identical. The only difference is the cascade — which produces no graph mutations (confirmed below).

### Proof that committed data is identical in both paths

#### Graph mutations during retrieve-all

Four sources of graph mutations were identified and traced:

**A. Parameter file → graph edge propagation** (`getParameterFromFile` in fileToGraphSync.ts line 1899):
Merges `edge.p.mean`, `edge.p.stdev`, `edge.p.evidence.*`, and `analytic` model_vars entries into the graph. Calls `setGraph(finalGraph)`.
- Tab-open path: `setGraph()` → `tabOps.updateTabData()` → `fileRegistry.updateFile()` — writes to FileRegistry
- Headless path: `setGraph()` → `fileRegistry.updateFile()` — same write
- **Identical outcome.**

**B. FE topo pass / LAG** (fetchDataService.ts line 1871):
Writes `p.latency.t95`, `p.latency.path_t95`, `p.latency.completeness`, `p.mean` (blended) to edges via `UpdateManager.applyBatchLAGValues()`. Calls `setGraph(nextGraph)`.
- Both paths: `setGraph()` → `fileRegistry.updateFile()` — same write
- **Identical outcome.**

**C. BE topo pass** (fetchDataService.ts lines 1954-1996, async fire-and-forget):
Runs `runBeTopoPass()`, writes `analytic_be` model_vars entries to edges via `upsertModelVars()`. Calls `setGraph(beGraph)` at line 1984.
- Tab-open path: `setGraph(beGraph)` → `tabOps.updateTabData()` → `fileRegistry.updateFile()` — writes to FileRegistry. Then store→file sync fires (GraphEditor useEffect#13), but only writes back the same data.
- Headless path: `setGraph(beGraph)` → `fileRegistry.updateFile()` — same write. No store→file sync (no mounted GraphEditor), but the data is already in FileRegistry from the direct write.
- **Identical outcome.** The store→file sync in the tab-open path is redundant — it writes the same data that `updateFile()` already wrote.

**D. Inbound-n computation** (fetchDataService.ts line 1040/2128):
Writes `p.n` (forecast population), `p.forecast.k` to edges. Calls `setGraph(updatedGraph)`.
- Both paths: `setGraph()` → `fileRegistry.updateFile()` — same write
- **Identical outcome.**

**E. Race between BE topo pass and inbound-n** (both async):
Both construct a clone of `finalGraph` and mutate it independently. Both call `setGraph()`. The last writer wins in FileRegistry. This race exists in BOTH paths identically — the ordering is non-deterministic either way.

#### Cascade effects that DON'T modify the graph

ScenariosContext subscribes to graph changes and runs:
1. `extractParamsFromGraph()` — extracts parameters into scenario state. Does NOT modify `graph.edges` or `graph.nodes`.
2. `regenerateAllLive()` — regenerates live scenario DSLs. Modifies scenario overlay state only, NOT the graph.
3. `scheduleChartReconcile()` → `recomputeOpenChartsForGraph()` — reconciles chart analyses. Modifies chart files, NOT the graph.

`graphMutationService` — NOT subscribed to store changes. Only triggered by explicit UI edits. Does NOT run during retrieve-all.

None of these write back to the graph data structure. Skipping them produces no difference in committed files.

#### The store→file sync is redundant (not a data source)

GraphEditor.tsx line 1868: `updateData(graph, { syncRevision, syncOrigin: 'store' })` calls `fileRegistry.updateFile()` with the raw `graph` object from Zustand. It adds no fields. It's a passthrough of whatever `setGraph()` put into the store. Since `setGraph()` was called with the same data that was written to FileRegistry by `updateFile()`, the store→file sync writes the same data again — a no-op.

#### `commitFiles()` reads from FileRegistry

`commitFiles()` at repositoryOperationsService.ts line 1149 reads from `fileRegistry.getFile(fileId)` — the same singleton that all `setGraph` paths write to. In both tab-open and headless paths, the retrieve pipeline writes graph data to FileRegistry via `fileRegistry.updateFile()`. The commit reads it back. The data is identical.

For parameter files: `getFromSourceDirect.ts` writes fetched data via `fileRegistry.updateFile('parameter-xxx', data)`. The commit reads it via `fileRegistry.getFile('parameter-xxx')`. Same singleton, same data.

### lagHorizonsService.recomputeHorizons() trace

Called after retrieve-all completes (dailyRetrieveAllAutomationService.ts line 131).

Dependencies:
- **`getGraph()` callback** — reads current graph (line 67 of lagHorizonsService.ts)
- **`setGraph()` callback** — writes normalized graph (line 81), writes post-LAG graph (line 106)
- **`fileRegistry.getFile('parameter-xxx')`** — reads parameter files for override flags (line 67)
- **`fetchDataService.fetchItems()`** — called with `mode: 'from-file'` to run Stage-2 LAG (line 86-109)
- **`forecastingSettingsService`** — read-only config

Does NOT need: GraphStore/Zustand, ScenariosContext, mounted components, React hooks.

`fileRegistry` is already populated by `loadWorkspaceFromIDB` (which runs before the per-graph loop). Parameter files are also populated by the retrieve step before horizons runs. All dependencies are satisfied without a mounted tab.

### `getUpdatedGraph()` behaviour

In `fetchItems()`, line 1173: `const currentGraph = getUpdatedGraph?.() ?? latestGraph ?? graph;`

Current automation path passes: `() => getGraph() as any` where `getGraph` is `() => fileRegistryGetFile(graphFileId)?.data`

Proposed headless path passes: `() => fileRegistry.getFile(graphFileId)?.data || null`

These are functionally identical — both read from the same FileRegistry singleton. The `fileRegistryGetFile` in `automationCtx` is literally `(fileId) => fileRegistry.getFile(fileId)` (set in the hook at useURLDailyRetrieveAllQueue.ts line 75).

### BE topo pass (async fire-and-forget)

fetchDataService.ts lines 1950-1992: runs `runBeTopoPass()` as an async IIFE without await. This runs in parallel with inbound-n computation. It reads `finalGraph` (a local variable) and calls `setGraph()` when done.

In the tab-open path, this `setGraph()` call triggers the full React cascade. In the headless path, it writes to FileRegistry (IDB persisted) but no cascade fires. The BE topo results are still persisted to FileRegistry/IDB either way.

## The Change

**Single file:** `graph-editor/src/services/dailyAutomationJob.ts`

### Add import

```typescript
import { fileRegistry } from '../contexts/TabContext';
```

### Replace per-graph block

**Current code** (inside the per-graph try block):
```typescript
const graphItem: RepositoryItem = { id: graphName, name: graphName, type: 'graph', path: `graphs/${graphName}.json` };
if (automationCtx.tabOps) {
  await automationCtx.tabOps.openTab(graphItem, 'interactive', false);
}
if (logTabId) reassertTabFocus(logTabId, [0, 50, 200, 750]);
const loaded = await waitForGraphData(graphFileId, 60_000, 250, () => ctx.shouldAbort());
if (!loaded) {
  sessionLogService.warning('session', 'DAILY_RETRIEVE_ALL_SKIPPED', `${sequenceInfo} ...`);
  continue;
}
await dailyRetrieveAllAutomationService.run({
  ...
  getGraph: () => (automationCtx.fileRegistryGetFile(graphFileId) as any)?.data || null,
  setGraph: (g) => automationCtx.tabOps?.updateTabData(graphFileId, g),
  ...
});
```

**New code:**
```typescript
// Load graph from FileRegistry (already populated by loadWorkspaceFromIDB).
// No tab opened — avoid mounting GraphEditor and all its expensive rendering/compute.
let graphFile = fileRegistry.getFile(graphFileId);
if (!graphFile?.data) {
  // Fallback: try restoring from IDB directly (with workspace for prefixed key lookup).
  graphFile = await fileRegistry.restoreFile(graphFileId, { repository: repoFinal, branch: branchFinal }) ?? undefined;
}
if (!graphFile?.data || graphFile.type !== 'graph') {
  sessionLogService.warning('session', 'DAILY_RETRIEVE_ALL_SKIPPED',
    `${sequenceInfo} Skipped: graph data not found in workspace`);
  continue;
}

await dailyRetrieveAllAutomationService.run({
  ...
  getGraph: () => fileRegistry.getFile(graphFileId)?.data || null,
  setGraph: (g) => { if (g) void fileRegistry.updateFile(graphFileId, g); },
  ...
});
```

### What stays the same

- Wait loop (still waits for repo + navigatorReady + tabOps for session log)
- Upfront pull + loadWorkspaceFromIDB
- Session log tab opening
- dailyRetrieveAllAutomationService.run() interface
- lagHorizonsService.recomputeHorizons() — same callbacks
- Commit step — reads from FileRegistry (same as before)
- Countdown, banner, abort checks, cleanup — all unchanged
- Manual retrieve-all from Data menu — completely unaffected

### What changes

- No graph tab opened during automation → no GraphEditor mounted
- No ReactFlow, no ScenariosContext, no chart recompute, no canvas analysis, no edge geometry
- Every `fileRegistry.updateFile()` call during retrieve fires `notifyListeners()` which is a no-op (no subscribers for that fileId without a mounted editor)
- `dagnet:fileDirtyChanged` events still fire (harmless — UI listeners update badges/indicators)
- `waitForGraphData()` function becomes unused by automation but is still used conceptually — keep it (manual paths may want it later)

## Verification

1. **TypeScript compiles:** `npx tsc --noEmit`
2. **E2E tests pass:** existing 6 Playwright specs
3. **Manual smoke test with `?retrieveall&noclose`:**
   - Session log shows GRAPH_START → DAILY_RETRIEVE_ALL → STEP_RETRIEVE → RETRIEVE_COMPLETE → STEP_COMMIT → GRAPH_COMPLETE for each graph
   - No "Loading tab..." UI — no tabs opened
   - Committed files appear in git (check via `dagnetAutomationLogs()`)
   - Run dramatically faster than before
4. **Compare commit content:** Run automation on a graph, then compare committed parameter files with a manual retrieve-all on the same graph. Files should be identical (same LAG values, same parameter data, same graph metadata).

---

## Change 2: Fix BE Topo Pass Race Condition

**File:** `graph-editor/src/services/fetchDataService.ts`

### The bug

Lines 1957-1996: BE topo pass runs as `(async () => { ... })()` — fire-and-forget.

Line 1966: `const beGraph = structuredClone(finalGraph)` — clones BEFORE inbound-n runs.
Line 1984: `setGraph(beGraph)` — writes graph with `analytic_be` but WITHOUT inbound-n results.
Line 2132: `computeAndApplyInboundN(finalGraph, setGraph, ...)` — writes graph with inbound-n but WITHOUT `analytic_be`.

Last writer wins. The other's results are discarded.

### The fix

Make the BE topo pass sequential instead of fire-and-forget. Apply BE entries to `finalGraph` directly (no clone), then run inbound-n on the same graph.

**Current order:**
```
FE LAG → setGraph(lagGraph)
BE topo (fire-and-forget async IIFE, clones finalGraph)  ← RACES
inbound-n (uses finalGraph)                               ← RACES
```

**New order:**
```
FE LAG → setGraph(lagGraph)
BE topo (awaited, applies to finalGraph directly)
setGraph(finalGraph)  ← single write with both FE + BE results
inbound-n (uses finalGraph with both FE + BE)
```

**Specific changes:**
1. Remove the async IIFE wrapper (lines 1957, 1996)
2. Await `runBeTopoPass()` directly
3. Apply BE entries to `finalGraph` in place (remove `structuredClone` at line 1966, use `finalGraph` directly)
4. Call `setGraph(finalGraph)` once after BE entries are applied (replaces line 1984's `setGraph(beGraph)`)
5. Move the parity comparison (`compareModelVarsSources`) after the BE upsert but before inbound-n
6. Keep the try/catch — if BE topo fails, log warning and continue (same as current behaviour, just not fire-and-forget)
7. `computeAndApplyInboundN` at line 2132 now receives `finalGraph` with both FE LAG + BE entries

**Tradeoff:** Adds ~200-500ms backend round-trip before inbound-n runs. But the previous "parallel" execution was broken (race condition), so this fixes correctness at negligible cost.

**Timeout:** Add a 5-second timeout to the `fetch()` call inside `runBeTopoPass()` (beTopoPassService.ts ~line 229). If the Python server doesn't respond, return empty result and continue. This prevents a slow/down backend from blocking the entire Stage-2 pipeline indefinitely.

---

## Change 3: Fix FileRegistry Re-entrancy Stale Data

**File:** `graph-editor/src/contexts/TabContext.tsx`

### The bug

`updateFile()` has a re-entrancy guard (line 249). When a second `updateFile()` call arrives for the same fileId while the first is still writing to IDB, the second call is queued in `pendingUpdates` and returns immediately. Critically, the in-memory `file.data` is NOT updated by the queued call — it stays at the previous value until the pending update is replayed after the first IDB write completes.

This means `getFile(fileId).data` returns **stale data** between the queued call and the replay. Any code that reads the file during this window (e.g. `getGraph()` in retrieveAllSlicesService) gets an outdated graph.

This bug affects BOTH the tab-open and headless paths (the tab-open path masks it because the store→file sync eventually catches up), but the headless path is more exposed because there's no masking sync.

### The fix

Update `file.data` IMMEDIATELY in the re-entrant path, before queuing. The IDB write is still deferred, but the in-memory cache always reflects the latest value.

**Current code** (TabContext.tsx ~line 249):
```typescript
if (this.updatingFiles.has(fileId)) {
  const gen = this.fileGenerations.get(fileId) || 0;
  this.pendingUpdates.set(fileId, { data: newData, opts, generation: gen });
  return;
}
```

**New code:**
```typescript
if (this.updatingFiles.has(fileId)) {
  // Update in-memory IMMEDIATELY so getFile() always returns latest.
  // The IDB write is deferred to the pending replay.
  const file = this.files.get(fileId);
  if (file) {
    file.data = newData;
    file.lastModified = Date.now();
    // Compute isDirty immediately to avoid transient inconsistency.
    // Must match the logic in the normal path (lines 318-326).
    if (!file.isInitializing) {
      const newDataStr = JSON.stringify(newData);
      const originalDataStr = JSON.stringify(file.originalData);
      file.isDirty = newDataStr !== originalDataStr;
    }
    if (opts?.syncRevision !== undefined) file.syncRevision = opts.syncRevision;
    if (opts?.syncOrigin !== undefined) file.syncOrigin = opts.syncOrigin;
  }
  const gen = this.fileGenerations.get(fileId) || 0;
  this.pendingUpdates.set(fileId, { data: newData, opts, generation: gen });
  return;
}
```

This also fixes the prefixed-vs-unprefixed IDB divergence risk: `commitFiles` reads from the in-memory FileRegistry (line 1149 of repositoryOperationsService.ts), which now always has the latest data. The IDB writes are eventually consistent — the pending replay writes the correct data to both IDB records.

Note: `notifyListeners` deep-clones data only when there are subscribers (line 747: `if (callbacks)`). In headless mode with no mounted editors, there are no subscribers — no wasted clones.

Note: `commitFiles` uses content-based SHA comparison (line 783+), not `isDirty` flag, for determining committable files. But `isDirty` affects UI indicators (dirty badges, tab dots) and should be correct for when the user later opens the app normally.

### Scope

This change affects ALL code paths that use `fileRegistry.updateFile()` — but it's a bugfix. The in-memory cache should always reflect the latest write, regardless of IDB write status. No caller expects `getFile()` to return stale data after `updateFile()` returns.

---

## Verification

1. **TypeScript compiles:** `npx tsc --noEmit`
2. **E2E tests pass:** existing 6 Playwright retrieve-all specs
3. **Existing vitest suite passes:** run full suite to catch regressions from Changes 2 and 3
4. **Manual smoke test with `?retrieveall&noclose`:**
   - Session log shows GRAPH_START → DAILY_RETRIEVE_ALL → STEP_RETRIEVE → RETRIEVE_COMPLETE → STEP_COMMIT → GRAPH_COMPLETE for each graph
   - No "Loading tab..." UI — no tabs opened
   - Committed files appear in git (check via `dagnetAutomationLogs()`)
   - Run dramatically faster than before
5. **Compare commit content:** Run automation on a graph, then compare committed parameter files with a manual retrieve-all on the same graph. Files should be identical (same LAG values, same parameter data, same graph metadata, same `analytic_be` entries).
6. **Verify BE topo pass results present:** After a manual fetch on a graph with the Python server running, check that `edge.p.model_vars` contains BOTH `analytic` and `analytic_be` entries. Previously one could be lost to the race.

---

## Files

- `graph-editor/src/services/dailyAutomationJob.ts` — **edit**: replace per-graph openTab+wait with direct FileRegistry access (Change 1)
- `graph-editor/src/services/fetchDataService.ts` — **edit**: fix BE topo pass race condition (Change 2, lines ~1954-2132)
- `graph-editor/src/contexts/TabContext.tsx` — **edit**: fix re-entrancy stale data in `updateFile()` (Change 3, lines ~249-253)
- `graph-editor/src/services/beTopoPassService.ts` — **edit**: add 5s fetch timeout (Change 2 companion)
- `graph-editor/src/services/retrieveAllSlicesService.ts` — **read-only reference**: confirmed callback-only interface
- `graph-editor/src/services/lagHorizonsService.ts` — **read-only reference**: confirmed works with FileRegistry directly
- `graph-editor/src/services/repositoryOperationsService.ts` — **read-only reference**: confirmed commitFiles reads from FileRegistry
