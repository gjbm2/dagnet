# Findings: 8-May → 12-May `?retrieveall` runs

Built from the automation logs in [logs/](logs/) and the consolidated [sysdiag-trends.csv](sysdiag-trends.csv) (196 snapshots across 5 days).

## 1. Run shape (consistent across 5 days)

| Date | Graphs planned | Duration captured | Errors | Outcome at last snapshot |
|---|---|---|---|---|
| 8-May | cf-v2, gm-rebuild, li-energy-simple-v1 | 7.95 h | 148 | in-progress |
| 9-May | cf-v2, gm-rebuild, li-cohort-segmentation-v2, li-energy-simple-v1 | 8.23 h | 191 | in-progress |
| 10-May | cf-v2, gm-rebuild, li-cohort-segmentation-v2, li-energy-simple-v1 | 8.06 h | 191 | in-progress |
| 11-May | cf-v2, gm-rebuild, li-cohort-segmentation-v2, li-energy-simple-v1 | 8.16 h | 179 | in-progress |
| 12-May | cf-v2, gm-rebuild, li-energy-simple-v1 | 8.14 h | 181 | in-progress |

Every run starts at ~04:00 BST and is still `in-progress` ~8 h later when snapshotting stops. Either the user terminates the run or the automation hangs indefinitely on the final graph.

For each run, graph 1 (`conversion-flow-v2-recs-collapsed`, 80 items, 8 slices) completes in ~4–5 min with 0 errors; graph 2 (`gm-rebuild-jan-26`, 8 items, 4 slices) completes in ~38 s with 0 errors. The third (and fourth, when present) graph never completes within the snapshot window. **Almost all error and time cost lives in graph 3+**.

## 2. Heap is flat — memory pressure hypothesis is disproven

From sysdiag-trends.csv, 12-May-26 (representative; other days are similar):

```
snapIdx  elapMin  usedMB  growthMB  domNodes  idbFiles  errs
   0       10.3   190.7        0     6,916       308       0   ← warm-up
   1       20.4    94.5     -96.2   14,215       308       0   ← graph 1 just finished
   …
  19      259.0   104.2     -86.5   17,378       308      97
  29      394.6   102.4     -88.3   14,854       308     144   ← drop is graph transition
   …
  37      488.2    98.0     -92.7   14,958       308     181   ← 8.1 h in, "in-progress"
```

Heap `usedMB` oscillates between **84 and 106 MB** across all 196 snapshots on all 5 days. `growthFromBaselineMB` is consistently between −68 and −106; i.e. heap is **below** baseline for almost the entire run. There is no monotonic growth, no asymptote toward the 4 GB v8 limit. DOM nodes oscillate (~6 k → 18 k → back to ~15 k as a graph transition occurs); they do not run away. IDB file count and `fileRegistry` totals are constant.

The 9-Apr-26 working hypothesis — that the host OS slows down because the Chromium heap grows until it forces swap — is not supported by any of the sysdiag data collected since the instrumentation landed.

## 3. Where the 8 hours actually go

For the 12-May log, walking the ordered timeline of all 913 `DATA_FETCH_VERSIONED` + `GET_FROM_FILE` operations:

```
Gap between consecutive fetches:
  < 1 s   : 347   ← cached reads
  1–5 s   : 206
  5–15 s  :  35
  15–30 s :  59
  30–60 s :  58
  60–180 s: 189   ← retry waits (30/60/120 s tier)
  180–600s:  18   ← retry waits at the 300 s cap
  > 600 s :   0
```

The 10 longest gaps are all 310 s — exactly the capped retry interval, and each one is bracketed by a `Request timeout after 30000ms` followed by a successful retry of the same edge. The Amplitude-timeout retry path in `retrieveAllSlicesService.ts:937–1090` is doing exactly what it was designed to do, and that work consumes most of the wall clock.

Sum of inter-fetch gaps equals the full first-to-last span (29,164 s). Errors arrive at a steady **~22 / hour** on every day — there is no burst, no recovery, no escalation. This shape is consistent with an Amplitude-side limitation that throttles a fixed slice of requests rather than a memory- or CPU-driven degradation in the client.

## 4. Why some fetches always time out, and why `cached=0`

Two narrower observations worth following up:

- Every `BATCH_ALL_SLICES` for graph 1 (cf-v2) reports `cached=0, fetched=80`. That graph's data presumably did not change overnight; we'd expect 80 cache hits, not 80 fresh fetches. Either signatures are mismatching, the cache is being invalidated upstream, or the headless path is explicitly bypassing it. This is ~5 min/day of avoidable work and may share a root cause with whatever forces graph 3 to re-fetch on every run.
- The error rate is roughly constant (~22 / h) regardless of which graphs are in the run. That suggests the timeouts are independent of graph identity and tied to a per-request or per-second property of Amplitude / Vercel / the client. Worth correlating: do timeouts cluster on particular event names, particular slice patterns, or particular times of day?

## 5. What we still cannot see

The sysdiag captures **inside the automation tab**. We have no instrumentation on:

- Total Chrome process tree memory (working set, GPU process, renderer processes for other tabs).
- Disk queue / page-fault rate on the host.
- Number of open TCP connections held by the Vercel `fetch()` calls.
- Whether the React/Zustand cascade described in [specs/headless-retrieveall-plan.md](../specs/headless-retrieveall-plan.md) is still firing during automation (which would chew CPU even with a flat heap).

If the host machine genuinely slows to a crawl during these runs, the cause is almost certainly outside the JS heap.

## 6. Cross-references

- 6-Apr-26: Amplitude timeout detection (`rateLimiter.isTimeoutError`) and broadening of `isRateLimitError` to include timeouts — [handover/6-Apr-26-snapshot-batch-retrievals-and-log-review.md](../handover/6-Apr-26-snapshot-batch-retrievals-and-log-review.md).
- 9-Apr-26: SysDiag instrumentation in `dailyAutomationJob.ts`, original memory-pressure hypothesis — [handover/9-Apr-26-retrieve-all-memory-investigation.md](../handover/9-Apr-26-retrieve-all-memory-investigation.md).
- Headless retrieve-all plan (skips React cascade per `setGraph`) — [specs/headless-retrieveall-plan.md](../specs/headless-retrieveall-plan.md).
