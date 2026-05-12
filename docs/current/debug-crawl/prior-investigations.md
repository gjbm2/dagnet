# Prior investigations into `?retrieveall` performance

Two prior sessions (6-Apr-26 and 9-Apr-26) looked at this problem. Full handover notes are in [docs/current/handover/](../handover/); short summaries below.

## 6-Apr-26 — rate-limit timeout detection + (failed) batch retrievals

[handover/6-Apr-26-snapshot-batch-retrievals-and-log-review.md](../handover/6-Apr-26-snapshot-batch-retrievals-and-log-review.md)

Two pieces of work, only one fully landed:

- **Landed.** Amplitude rate-limit detection was broadened to include timeout-like errors (`timeout`, `etimedout`, `aborterror`, `failed to fetch`, `networkerror`). Previously, Amplitude throttling that manifested as 30 s hangs (rather than HTTP 429) bypassed the retry/cooldown machinery entirely. After this change, `retrieveAllSlicesService` retries timed-out fetches with exponential backoff capped at 5 min. Tests for `rateLimitCooldown` and `fetchDataService` updated. [graph-editor/src/services/rateLimiter.ts](../../../graph-editor/src/services/rateLimiter.ts).
- **Reverted.** A frontend batching rewrite of `getSnapshotCoverageForEdges` (intended to replace 2 N Vercel calls with 1) produced empty coverage on the live data and was reverted. The Python `query_batch_retrievals` backend has proven parity; the frontend wiring did not. A parity test was the agreed next step. Note: `useDataDepthScores.ts` may still contain the batched rewrite — needs verification.

This is the work that gave us the current ~5-minute capped backoff observed in the May logs.

## 9-Apr-26 — sysdiag instrumentation + memory-pressure hypothesis

[handover/9-Apr-26-retrieve-all-memory-investigation.md](../handover/9-Apr-26-retrieve-all-memory-investigation.md)

The session's working hypothesis was that Chromium heap grows during long runs until the OS starts swapping, which is what the user perceives as the host slowing to a crawl. To test this, a `SysDiag` snapshot (heap, session log, FileRegistry, IDB, DOM) was added inside `commitLogSnapshot()` in `dailyAutomationJob.ts`, fired once per 10-minute log commit. Design choices:

- Diagnostics are appended as a synthetic `{kind: "sysdiag", ...}` entry on the in-memory log only when a commit fires. They are not written to IDB or the session log — that avoids triggering `notifyListeners` and re-renders that would themselves contribute to the problem being measured.
- The interval (10 min, not 60 s or per-slice) was deliberate: the snapshot itself does `JSON.stringify` on the 5 largest files (~5 MB transient allocation per snapshot), so the measurement is non-negligible.
- The instrumentation was committed but the analysis was deferred to a subsequent session — never picked up.

Plausible-but-unconfirmed suspects from that session, that the sysdiag data was supposed to confirm or rule out:

1. `fileRegistry.updateFile` on the graph file on every `setGraph` — 3× `JSON.stringify(graph)` + a `JSON.parse(JSON.stringify(graph))` + 2× IDB puts, on a graph that grows during the run.
2. `structuredClone(graph)` per item in `fileToGraphSync.ts:1646`.
3. Both `data` and `originalData` serialised on every dirty-detection check.
4. Session log growing unboundedly.

**The sysdiag data collected since (April → May) does not show heap, DOM, IDB, or session-log growth on the scale needed for the memory-pressure hypothesis to be correct.** See [findings-12-May-26.md](findings-12-May-26.md) for the data. The 9-Apr work was correct to instrument first; the conclusion the instrumentation pointed at is different from what was expected.

## What landed in the codebase from these sessions

- [graph-editor/src/services/rateLimiter.ts](../../../graph-editor/src/services/rateLimiter.ts) — `isTimeoutError()`, broadened `isRateLimitError()`.
- [graph-editor/src/services/retrieveAllSlicesService.ts](../../../graph-editor/src/services/retrieveAllSlicesService.ts) — comments and labels for timeout cooldown path; the actual retry-on-timeout machinery (30 → 60 → 120 → 240 → 300 s cap) is at lines ~947–1090.
- [graph-editor/src/lib/das/DASRunner.ts](../../../graph-editor/src/lib/das/DASRunner.ts):733 — preserves original error message so the retrieve service can match on it.
- [graph-editor/src/services/dailyAutomationJob.ts](../../../graph-editor/src/services/dailyAutomationJob.ts) — `takeSysDiag()` function and call site inside `commitLogSnapshot()`.

## What did NOT land but is described

- Headless retrieve-all path (skip the React/Zustand cascade per `setGraph`): [specs/headless-retrieveall-plan.md](../specs/headless-retrieveall-plan.md). Status of this implementation needs checking — it is the most promising single intervention if CPU pressure (not memory) turns out to be the host-side culprit.
- Frontend parity test for batched `getSnapshotCoverageForEdges`: drafted in the 6-Apr-26 handover, not implemented.
- Snapshot write-failure diagnostics (plan at `~/.claude/plans/polished-chasing-sutton.md`): never started.
