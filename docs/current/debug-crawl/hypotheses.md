# Hypotheses — daily retrieve-all slow-crawl and host freeze

Working list. Status updated as the investigation produces evidence.

## Two distinct symptoms, often conflated

Throughout the investigation it became important to keep these separate, because they have different mechanisms:

- **Issue A** — While the daily run is active, the entire Windows host becomes catastrophically unresponsive (mouse barely moves, 20-second keystrokes, all foreground apps stalled). Recovers instantly when the Chromium process tree is killed.
- **Issue B** — The retrieve-all run consistently takes 8+ hours and does not complete. `outcome: in-progress` on every snapshot for the last 20+ days.

These are independent. Issue B happens on graph 3 specifically and is driven by Amplitude query latency vs. a 30 s client timeout. Issue A is an OS-level resource pathology that's almost certainly a memory phenomenon outside the renderer's v8 heap.

## Disproved

### H-MEMORY-PRESSURE-V8 (9-Apr-26 working hypothesis)

> Chromium's v8 heap grows during the run until the OS starts swapping.

**Status: disproved** by 196 sysdiag snapshots across 8–12 May ([sysdiag-trends.csv](sysdiag-trends.csv)).
- Heap `usedMB` oscillates 84–106 MB across full 8 h runs.
- `growthFromBaselineMB` is consistently negative.
- DOM nodes, IDB file count, fileRegistry totals are flat or oscillate, not monotonic.

The instrumentation that landed in 9-Apr-26 was the right move; the conclusion it points to is "look elsewhere — not the v8 heap".

### H-RENDERER-THREAD-STARVATION

> The renderer's main thread is CPU-saturated by per-item React/Zustand work, causing fetch response IPC to sit unprocessed for 30+ seconds and triggering the client-side AbortController.

**Status: disproved.** Cache reads (`GET_FROM_FILE`, pure renderer-thread work — IDB read + JSON.parse) stay at 10–20 ms throughout the 8-hour run, including during the windows when timeouts are occurring (see [findings-12-May-26.md](findings-12-May-26.md) §3 "Cache-hit duration by hour"). The renderer's event loop is verifiably not starved.

### H-REACT-CASCADE-PER-ITEM

> The React/Zustand cascade described in [headless-retrieveall-plan.md](../specs/headless-retrieveall-plan.md) still re-runs on every parameter file write during automation, consuming significant CPU.

**Status: disproved.** The headless retrieve-all path *is* implemented and active. [dailyAutomationJob.ts:710-731](../../../graph-editor/src/services/dailyAutomationJob.ts#L710-L731) explicitly skips opening a graph tab; `setGraph` is wired directly to `fileRegistry.updateFile(graphFileId, g)` with no React subscriber. The expensive cascade does not fire during automation runs.

### H-FLAG-X-CAUSES-PURGE-SUPPRESSION

> `--disable-backgrounding-occluded-windows` specifically suppresses Chromium's memory-purge path, which is why the browser/GPU processes' commit grows.

**Status: not supported by primary source.** A directed Chromium source search found no call from the occlusion tracker into `MemoryPressureListener` or any cache-trim path. The flag's documented effect is renderer-priority demotion only. This claim should not have been put forward with the confidence it was; the user's pushback was correct. See [browser-flags-analysis.md](browser-flags-analysis.md) for the actual source-cited behaviour of each flag.

## Active, supported by evidence

### H-TIMEOUTS-ARE-AMPLITUDE-QUERY-LATENCY (Issue B)

> Specific big-cohort Amplitude queries on graph 3 take longer than the hard-coded 30 s client `AbortController` deadline. The retry path eventually succeeds but at the cost of 5-minute cooldowns per failed attempt.

**Status: strongly supported** by per-edge analysis in [timeout-pattern-analysis.md](timeout-pattern-analysis.md).
- Only 12 edges out of 37 ever time out. All 12 are on graph 3 (`li-energy-simple-v1`).
- Timeouts cluster on specific slice contexts: `lis-energy-blueprint:immediate-proposals-v2/v3` (78 of 181 timeouts) and `lis-onboarding-blueprint:other`, `low-intent-v9`.
- Even successful fetches on graph 3 cluster at 80 s median during the busy hours — far above the 30 s deadline.
- The 30 s timeout is hard-coded at [BrowserHttpExecutor.ts:62](../../../graph-editor/src/lib/das/BrowserHttpExecutor.ts#L62) with `defaultTimeoutMs ?? 30_000`. The executor already supports a per-request override via `request.timeout`, but the automation path doesn't currently plumb a longer value through.

**Fix candidates (independent of Issue A):**
1. Plumb a 90–120 s timeout through `dailyRetrieveAllAutomationService → retrieveAllSlicesService → dataOperationsService → BrowserHttpExecutor` for the automation path. Manual users keep 30 s for snappier interactive feedback.
2. Verify Vercel `python-api.py` has `maxDuration` set in [vercel.json](../../../graph-editor/vercel.json). Default is 10 s on Hobby plan, 60 s on Pro. If the function is killed at 10 s, no client-side change helps.
3. Fix the `cached=0` bug on graph 1 (next entry) — eliminates the need to re-fetch unchanged data.

### H-NO-CACHE-HITS-ON-GRAPH-1 (Issue B contributor)

> Graph 1 (`conversion-flow-v2-recs-collapsed`) reports `cached=0, fetched=80` on every daily run, even when the data has not changed. This is ~5 minutes per day of avoidable work and may share a root cause with whatever forces graph 3 to keep re-fetching.

**Status: active.** The cache-key / signature logic is the suspect path. May connect to the 6-Apr-26 observation that `compute-hash.ts` produces a different `core_hash` than the value stored in the DB. Worth investigating independently; the fix would have an outsized impact (turns an 8-hour grind into a few-minute pass on days when nothing changed).

### H-COMMIT-EXHAUSTION (Issue A leading hypothesis)

> The host freeze is **Windows System Commit exhaustion** driven by the Chromium *browser* and *GPU* processes (not the renderer's v8 heap). After ~8 hours of long-running headed Chrome, the process tree's committed memory approaches the Commit Limit; every kernel allocation page-faults; DWM, Win32k input, and cursor handling stall.

**Status: leading hypothesis, ~70% confidence, settled by one diagnostic.** See [host-freeze-mechanism.md](host-freeze-mechanism.md). Mechanism is well-documented by Microsoft and matches every observation including "instant recovery on process kill". The specific causal role of any one flag is much less clear than originally framed — the underlying cause is probably "long-running headed Chrome accumulates non-heap memory" generically.

**Diagnostic in progress**: Task Manager → Performance → Memory pane during pathology, plus [PowerShell capture script](perf-capture-windows.md) running for the whole run.

## Active — need additional instrumentation

### H-RUN-NEVER-COMPLETES (separate from Issue A)

> Outcome is `in-progress` on every snapshot for the last 20+ days. Either the user kills runs, or the automation hits an unrecoverable state and the outer loop never sets `outcome: succeeded`.

**Open:** trace the success path in `dailyRetrieveAllAutomationService` — is there a code path that sets `outcome: 'succeeded'`? Is it ever reached? Important because all our "8-hour run" timing analysis is skewed by not knowing what "done" actually looks like.

## Parking lot

- **DevTools open during automation runs** — Chrome retains console-logged objects regardless of production gating. Flagged in 9-Apr-26 handover, never confirmed. Probably not a factor.
- **Console mirroring** — `localStorage["dagnet:console-mirror"] === "1"` causes `safeSerialiseArgs` → `JSON.stringify` on every console call. Should be off in production.
- **Frontend batch retrievals parity bug** (6-Apr-26 handover) — `useDataDepthScores.ts` may still contain the batched rewrite that was reverted in `getSnapshotCoverageForEdges`. Independent of this investigation.
