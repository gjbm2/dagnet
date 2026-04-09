# Handover: Retrieve-All Memory Pressure Investigation

**Date:** 9-Apr-26
**Branch:** `feature/snapshot-db-phase0`

---

## Objective

The `?retrieveall` automation (headless overnight batch that fetches data for all slices across all graphs) causes the **browser and entire Windows machine to slow to a crawl** on longer runs (1h+). The user initially suspected excessive logging; that has been ruled out. The working hypothesis is **memory pressure** — something accumulating during the run that grows the Chromium heap until the OS starts swapping.

The goal is to:
1. **Instrument** the run with periodic heap/memory diagnostics so we can see what's growing
2. **Identify** the specific data structure(s) or allocation pattern causing the leak/bloat
3. **Fix** the root cause (future session)

This is a production-impacting issue: the largest graph (`li-cohort-segmentation-v2`, 31 edges × 32 context slices = ~496 items) takes 4+ hours and makes the dedicated automation machine unusable.

---

## Current State

### Instrumentation (DONE)
- **`graph-editor/src/services/dailyAutomationJob.ts`** — Added a `SysDiag` snapshot that is appended to the git-persisted automation log every 10 minutes (on the existing `commitLogSnapshot` path). NOT written to IDB or session log.
- The snapshot captures:
  - V8 heap sizes (`performance.memory` — Chromium-only): used, total, limit, delta from previous, growth from baseline
  - Session log accumulation: top-level entry count, deep count (including children), approximate active operations
  - FileRegistry: total files, per-type breakdown, top 5 largest files with `data` and `originalData` sizes in KB
  - IDB: file count, automation log count
  - DOM: node count
- Each snapshot is ~1-1.5 KB. Over a 3h run that's ~25 KB added to the log.
- The `estimateSizeKB` function does `JSON.stringify` on the 5 largest files — a one-off ~5 MB transient allocation every 10 minutes. Accepted as tolerable.
- All wrapped in try/catch at every level — cannot crash the run.

### Investigation findings (NOT YET CONFIRMED — hypotheses only)
- The run is NOT getting measurably slower in throughput terms: items complete at a steady ~20-30s/item throughout the last 90 minutes of a 4h+ run
- Amplitude timeouts (~3-5 per 10-min window) are likely a **symptom** of memory pressure (browser can't process HTTP responses before the 30s deadline), not a separate issue — each retry succeeds immediately
- The sysdiag data does not yet exist — the current live run is on the old code. The next run after a rebuild will produce the first diagnostic data.

### Build/deploy (NOT STARTED)
- The changes have NOT been committed or built yet. The user needs to rebuild and restart the automation browser for the instrumentation to take effect.

---

## Key Decisions & Rationale

### Write diagnostics to git-persisted log only, not IDB or session log
- **What:** The sysdiag entry is appended as a synthetic entry in the `entries` array of the `AutomationRunLog` that gets committed to `.dagnet/automation-logs/` via git every 10 minutes.
- **Why:** Writing to session log would trigger `notifyListeners` → UI re-renders → making the problem worse. Writing to IDB on the 60s flush would add unnecessary overhead. The git log is already being committed every 10 minutes — piggybacking on that is free.
- **Where:** `dailyAutomationJob.ts`, inside `commitLogSnapshot()` (~line 406).

### Don't snapshot more frequently than 10 minutes
- **What:** The user explicitly rejected per-slice (every ~30s) and per-60s-flush intervals.
- **Why:** The diagnostic itself does `JSON.stringify` on the 5 largest files, which is a ~5 MB allocation. Doing that every minute would contribute to the very problem we're trying to measure.

### Use `performance.memory` (Chromium-only)
- **What:** The heap section uses `(performance as any).memory` which is non-standard but available in Chromium.
- **Why:** The automation browser is always Chromium. This gives us `usedJSHeapSize`, `totalJSHeapSize`, and `jsHeapSizeLimit` — exactly what we need to track heap growth.

---

## Discoveries & Gotchas

### What was ruled out as the primary cause
1. **Excessive logging** — ruled out by the user before the session started
2. **Per-item fetch cost** — throughput is steady at ~20-30s/item throughout; no progressive degradation in fetch speed
3. **Intervals/timers running during idle** — checked all `setInterval` calls in the codebase; nothing significant runs during timeout backoffs
4. **Session log accumulation** — only ~5 MB total for a full run; not enough to crash a machine
5. **Console.log with large objects** — `console.log` at `TabContext.tsx:141` logs full `file.data` on every `notifyListeners`, but user confirmed console logging is gated in production builds

### What remains plausible but unconfirmed
1. **`fileRegistry.updateFile` on the graph file per `setGraph` call** — does 3× `JSON.stringify(graph)` + 1× `JSON.parse(JSON.stringify(graph))` + 2× IDB puts, all on the growing graph object. Over 620+ items, that's potentially ~10 GB of transient string allocations. Whether V8 can GC these fast enough is the question.
2. **IDB write volume** — 2× `db.files.put()` per `setGraph` call, each serialising the full `FileState` (which includes both `data` and `originalData`). Chromium's IDB implementation (LevelDB) may hold write-ahead logs or transaction journals in memory.
3. **`structuredClone(graph)` in `fileToGraphSync.ts:1646`** — full deep clone of the graph per item, with the graph growing during the run.
4. **The graph file in FileRegistry holds both `data` (growing, 3-5 MB populated) and `originalData` (small, ~70 KB from disk)** — the `data` + `originalData` are both serialised on every dirty-detection comparison.

### Production scale numbers
- Largest graph: `li-cohort-segmentation-v2` — 31 edges, 32 context slices, ~496 planned items
- Parameter files: ~200 KB each on disk, 31 files
- The run processes 4 graphs sequentially; the first 2 are small (88 items total, done in ~20 min), the 3rd is the monster
- Current run: 620/651 items complete on graph 3, 70 timeout retries (64 recovered), 0 actual failures, 257 minutes elapsed

### The timeout-memory feedback loop
Amplitude timeouts (30s) are likely caused by the browser's main thread being blocked by GC pauses, preventing timely HTTP response processing. Each timeout triggers a 30s backoff, extending the run, causing more graph mutations, more memory pressure. This is a hypothesis — the sysdiag data will confirm or refute it.

---

## Relevant Files

### Changed
- **`graph-editor/src/services/dailyAutomationJob.ts`** — Added `SysDiag` interface, `takeSysDiag()` function, and the call site in `commitLogSnapshot()`. Lines ~28-208 (new code), ~406 (call site).

### Read for investigation (not changed)
- **`graph-editor/src/services/retrieveAllSlicesService.ts`** — The main retrieve-all loop. `execute()` method iterates slices × items, calling `dataOperationsService.getFromSource()` per item.
- **`graph-editor/src/services/dataOperations/getFromSourceDirect.ts`** — The per-item fetch implementation. 116 session log calls, multiple `structuredClone` calls, multiple `setGraph` paths.
- **`graph-editor/src/services/dataOperations/fileToGraphSync.ts`** — `getParameterFromFile()` at line 65. Does `structuredClone(graph)` at line 1646, calls `setGraph` at line 1902.
- **`graph-editor/src/contexts/TabContext.tsx`** — `FileRegistry.updateFile()` at line 261. Does 3× `JSON.stringify` for dirty detection (lines 281, 305-307), `JSON.parse(JSON.stringify(file.data))` in `notifyListeners` (line 789), 2× `db.files.put()` (lines 374, 380).
- **`graph-editor/src/contexts/GraphStoreContext.tsx`** — Zustand store. `setGraph` at line 109 does `normaliseCanvasAnalysis` on every call, has diagnostic `console.log` with `new Error().stack` at line 132 (gated in prod).
- **`graph-editor/src/services/graphMutationService.ts`** — `updateGraph()` at line 205. `detectTopologyChange()` at line 70 has O(edges²) `find()` in a loop (lines 148, 176).
- **`graph-editor/src/components/MenuBar/DataMenu.tsx`** — `handleSetGraph` at line 177 calls both `graphStore.setGraph()` AND `fileRegistry.updateFile()` on every graph update.
- **`graph-editor/src/services/sessionLogService.ts`** — `entries` array grows unboundedly during a run (never pruned). `getEntries()` returns `[...this.entries]` (shallow copy).
- **`graph-editor/src/services/automationLogService.ts`** — `progressiveFlush()` does `JSON.parse(JSON.stringify(log.entries))` every 60s.
- **`graph-editor/src/services/consoleMirrorService.ts`** — When enabled, intercepts every `console.log` and calls `safeSerialiseArgs` → `JSON.stringify` on each argument.
- **`graph-editor/src/services/dailyRetrieveAllAutomationService.ts`** — Orchestrates per-graph retrieve-all; passes `getGraph`/`setGraph` to the service.

### Automation log (data)
- **`nous-conversion/.dagnet/automation-logs/retrieve-all-9-Apr-26.json`** — 5.1 MB, 2360 entries, outcome `in-progress`, 257 min elapsed at last commit. This is the current (pre-instrumentation) run.

---

## Next Steps

1. **Commit and build** the `dailyAutomationJob.ts` changes so the next automation run includes sysdiag snapshots.

2. **Run the automation** and let it complete (or at least get through graph 3). The sysdiag entries will appear in the `.dagnet/automation-logs/` JSON file.

3. **Analyse the sysdiag data** — look for:
   - Is `heap.usedMB` growing monotonically? If so, by how much per 10-min window?
   - Which FileRegistry files are growing? Is the graph file's `dataSizeKB` increasing?
   - Is `sessionLog.totalEntriesDeep` correlating with heap growth?
   - Is `dom.nodeCount` growing? (Would indicate a React rendering leak.)
   - Compare heap growth rate with timeout frequency.

4. **Based on findings, implement fixes.** Likely candidates:
   - **Skip `fileRegistry.updateFile` during batch mode** — defer the graph file write to once per slice or once at completion. This would eliminate 3× `JSON.stringify` + `JSON.parse(JSON.stringify)` + 2× IDB puts per item.
   - **Skip `notifyListeners` deep clone during batch mode** — the `JSON.parse(JSON.stringify(file.data))` at `TabContext.tsx:789` creates a full graph clone for each listener on every update.
   - **Prune session log entries mid-run** — strip completed operations' children to free memory.
   - **Batch IDB writes** — coalesce multiple `db.files.put()` calls into periodic flushes instead of per-item.

---

## Open Questions

1. **Is the graph file being written to IDB on every `setGraph` during retrieve-all?** — The `handleSetGraph` in `DataMenu.tsx` calls `fileRegistry.updateFile(activeTab.fileId, newGraph)` which writes to IDB. But retrieve-all's `setGraph` might go through a different path (e.g. direct store write). Need to confirm which `setGraph` the automation service uses. **Non-blocking** — the sysdiag data will reveal whether IDB writes are the bottleneck.

2. **Is the automation browser running with DevTools open?** — If so, Chrome retains references to all console-logged objects regardless of production gating. This could be a major source of retained memory. **Non-blocking** — should verify with the user.

3. **Is console mirroring enabled during automation runs?** — If `localStorage["dagnet:console-mirror"] === "1"`, then every `console.log` gets `JSON.stringify`'d via `safeSerialiseArgs`. **Non-blocking** — the sysdiag data will show if this is a factor.
