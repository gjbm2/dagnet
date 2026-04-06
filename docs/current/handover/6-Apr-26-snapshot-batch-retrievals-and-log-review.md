# Handover: Snapshot Batch Retrievals & Log Review

**Date**: 6-Apr-26
**Branch**: `feature/snapshot-db-phase0`

---

## Objective

Three interleaved workstreams in this session:

1. **Log review of a prod daily retrieve-all run** (tmp8b.log) — diagnose fetch failures, snapshot write failures, and git sequencing safety.
2. **Rate-limit timeout detection** — Amplitude can throttle by hanging requests (~30s timeout) rather than returning 429. The existing `isRateLimitError()` didn't catch these, so the cooldown+retry mechanism didn't fire. Fix: broaden detection to include timeouts.
3. **Batch snapshot retrievals** — the `@` (asat) calendar fires 2N Vercel serverless function calls for N edges (inventory + retrievals per edge). On large graphs (31 edges = 62 calls), this overwhelms Vercel and the calendar shows "no snapshots." Fix: new batch endpoint + batched frontend flow. **This is the in-progress workstream with a known bug.**

---

## Current State

### Rate-limit timeout detection — DONE
- **`rateLimiter.ts`**: Added `isTimeoutError()` method. `isRateLimitError()` now also returns true for timeout patterns (`timeout`, `etimedout`, `econnreset`, `econnrefused`, `aborterror`, `the operation was aborted`, `failed to fetch`, `networkerror`).
- **`DASRunner.ts`**: Changed generic error fallback (line 733) to preserve original error message: `"Execution failed: ${error.message}"` instead of the opaque `"Execution failed. Check Session Log for details."`.
- **`retrieveAllSlicesService.ts`**: Updated comment and cooldown label to mention timeouts.
- **Tests updated**: `rateLimitCooldown.test.ts`, `fetchDataService.test.ts`. The pattern `"network error"` was removed from `isTimeoutError` because it was too broad — it caught test mocks that throw `new Error('Network error')`, causing `useFetchData` tests to timeout (the countdown timer triggered instead of returning immediately). Real browser network failures produce `"Failed to fetch"` (Chrome) or `"NetworkError..."` (Firefox), both already covered.
- All 112 tests pass across the 3 affected test files.

### Batch snapshot retrievals — IN PROGRESS (bug: frontend parity failure)

**Backend — DONE, tested, working:**
- **`snapshot_service.py`**: Added `query_batch_retrievals()` — accepts N subjects with per-subject `core_hash`, `slice_keys`, `equivalent_hashes`. Executes per-subject queries within a single DB connection.
- **`api_handlers.py`**: Added `handle_snapshots_batch_retrievals()`.
- **`python-api.py`**: Added routing for `snapshots-batch-retrievals` endpoint.
- **`dev-server.py`**: Added FastAPI route.
- **`vercel.json`**: Added rewrite rule.
- **Python parity verified**: Ran real-data comparison — `query_batch_retrievals` returns identical results to N individual `query_snapshot_retrievals` calls. 6 integration tests (BR-001 through BR-006) all pass against real Neon DB.

**Frontend client — DONE:**
- **`snapshotWriteService.ts`**: Added `getBatchRetrievals()`, `BatchRetrievalsSubject`, `BatchRetrievalsResult` types.

**Frontend integration — REVERTED (bug found):**
- Rewrote `getSnapshotCoverageForEdges` in `snapshotRetrievalsService.ts` to use the batch path. **It produced no results** when the user tested on `conversion-flow-v2-recs-collapsed` locally. The old per-edge path works correctly on the same data.
- **Reverted** `getSnapshotCoverageForEdges` back to the original N-parallel implementation.
- The `useDataDepthScores.ts` rewrite is still in place and **may also have the same bug** — it was changed to use the batch path but hasn't been tested yet. This needs to be reverted or fixed.
- **Root cause unknown**: The Python batch function has parity (proven by test). The bug is in how the frontend batched code constructs subjects from inventory results. A parity test (run both paths, assert identical coverage output) is needed to pinpoint the divergence.

### Snapshot write failure diagnostics — NOT STARTED
- Plan was written at `/home/gjbm2/.claude/plans/polished-chasing-sutton.md` for adding better logging to snapshot write failures (the 12 empty-body failures in the prod log). Not implemented yet — deprioritised in favour of the batch retrievals work.

---

## Key Decisions & Rationale

1. **Timeout patterns kept specific, not broad**: `"network error"` was initially included in `isTimeoutError()` but removed because it caught test mocks. Real browser fetch failures use more specific strings (`"Failed to fetch"`, `"NetworkError when attempting to fetch resource"`). The user confirmed this correction.

2. **Batch retrievals uses per-subject queries within one connection, not UNION ALL**: Initially attempted complex UNION ALL SQL generation but abandoned it. The main performance win is eliminating N Vercel cold-start-prone serverless invocations, not reducing N queries to 1. One connection with N simple queries is simpler and still achieves the goal.

3. **Reverted frontend batch integration rather than debugging blind**: The user correctly insisted on a parity test before shipping. The old path works, the batch backend has parity at the Python level, so the bug is in the frontend wiring. Better to revert and prove parity first.

4. **`useDataDepthScores` also needs batching** — it has the same N-parallel `getSnapshotRetrievalsForEdge` pattern. Currently still contains the batched rewrite which may have the same bug. Needs attention.

---

## Discoveries & Gotchas

### Prod daily retrieve-all (tmp8b.log analysis)
- **Git sequencing is safe**: The commit-pull-retry pattern works correctly. When remote is ahead during commit, the system pulls, checks MERGE_DECISION (accepts remote for non-dirty files only), and retries the commit with only the current graph's dirty files.
- **77 fetch failures were NOT all 429s**: 62 were HTTP timeouts (30s, phase "unknown") from Amplitude throttling. The DASRunner was losing the original error message, replacing it with generic text. The `isRateLimitError()` check didn't match. Fixed by preserving the message and broadening detection.
- **12 SNAPSHOT_WRITE_FAILED entries**: All on the last cohort slice (`energy-blueprint-variant:none`). The Vercel Python function received empty request bodies. Confirmed via Python server logs (no POST requests reached the local server during that window — the app was on Vercel prod). The response format `{"error": "...", "detail": "...", "success": false}` confirmed `python-api.py` handler, not FastAPI. Root cause is Vercel platform — body forwarding failure. Interleaved with successes (8 succeeded at 12:49-12:51, 12 failed at 12:50-12:52, then 1 more success at 12:51). Not a cold-start issue.

### Prod `@` calendar failure
- The `@` calendar fires `getSnapshotCoverageForEdges` which fires N parallel `getSnapshotRetrievalsForEdge` calls. For `li-cohort-segmentation-v2` (31 edges), that's 62 Vercel function invocations. This overwhelms Vercel's concurrency limits, causing intermittent failures.
- `gm-rebuild-jan-26` (4 edges, 8 calls) sometimes works, sometimes doesn't — depends on whether the Vercel function is warm.
- `python-api.py` has **no `maxDuration` set** in `vercel.json` (only `bayes-webhook.ts` has it). Defaults to Vercel plan limit.
- The `@` calendar `fetch()` calls have **no AbortController/timeout** — they wait indefinitely for Vercel to respond or kill the function.

### Hash/signature observations
- The `compute-hash.ts` CLI tool computes a DIFFERENT core_hash than what's in the DB. This is because the CLI uses the current local code (which may differ from the deployed version that wrote the data). The hashes stored in parameter files (`query_signature` field in values) ARE the correct ones — they were written at fetch time by the same code that wrote to the DB.
- The `computeCurrentSignatureForEdge` (read path) uses the graph's full DSL for context keys, while the write path uses the per-slice DSL. This was flagged as a potential divergence but the user said it's well-tested. The user's view is that the issue is simpler — Vercel response timing, not hash mismatch.

---

## Relevant Files

### Backend (Python)
- `graph-editor/lib/snapshot_service.py` — `query_batch_retrievals()` added (~line 1738). Core batch retrieval logic.
- `graph-editor/lib/api_handlers.py` — `handle_snapshots_batch_retrievals()` added (~line 2453). Request handler.
- `graph-editor/api/python-api.py` — Vercel serverless handler. Added routing for `snapshots-batch-retrievals`.
- `graph-editor/dev-server.py` — FastAPI dev server. Added `/api/snapshots/batch-retrievals` route.
- `graph-editor/vercel.json` — Added rewrite for the new endpoint.

### Frontend
- `graph-editor/src/services/snapshotWriteService.ts` — `getBatchRetrievals()` client function added. `querySnapshotRetrievals()` unchanged.
- `graph-editor/src/services/snapshotRetrievalsService.ts` — `getSnapshotCoverageForEdges()` **REVERTED** to original N-parallel implementation. `getSnapshotRetrievalsForEdge()` and `computeCurrentSignatureForEdge()` unchanged.
- `graph-editor/src/hooks/useDataDepthScores.ts` — **STILL CONTAINS batched rewrite** — needs reverting or fixing.
- `graph-editor/src/services/rateLimiter.ts` — `isTimeoutError()` added, `isRateLimitError()` broadened.
- `graph-editor/src/lib/das/DASRunner.ts` — Error message preservation (line 733).
- `graph-editor/src/services/retrieveAllSlicesService.ts` — Comment and label updated for timeout detection.
- `graph-editor/src/components/WindowSelector.tsx` — `loadAsatDays()` is the `@` calendar entry point (line 315). Read-only context.

### Tests
- `graph-editor/lib/tests/test_snapshot_integration.py` — 6 new BR-* tests for `query_batch_retrievals`. All pass.
- `graph-editor/src/services/__tests__/rateLimitCooldown.test.ts` — Updated for timeout detection.
- `graph-editor/src/services/__tests__/fetchDataService.test.ts` — `"Network timeout"` → `"Invalid response format"` in non-rate-limit test.

### Logs & diagnostics
- `tmp8b.log` — The prod session log analysed in this session (140K lines, 6-Apr-26).
- `debug/tmp.python-server.jsonl` — Local Python server log (confirmed no snapshot POSTs during the failure window).

---

## Next Steps

1. **Revert `useDataDepthScores.ts`** back to the original N-parallel `getSnapshotRetrievalsForEdge` pattern. It currently contains the batched rewrite which has the same untested bug as the reverted `getSnapshotCoverageForEdges`.

2. **Write a frontend parity test** for `getSnapshotCoverageForEdges`. The test should:
   - Set up a mock graph with N edges and mock `getSnapshotRetrievalsForEdge` responses
   - Run the original N-parallel implementation
   - Run the batched implementation
   - Assert identical `coverageByDay`, `allDays`, `totalParams`
   - This will pinpoint where the batched frontend code diverges

3. **Fix the batched `getSnapshotCoverageForEdges`** based on what the parity test reveals. The Python backend has proven parity — the bug is in how the frontend constructs inventory/retrieval subjects.

4. **Once parity is proven**, switch `getSnapshotCoverageForEdges` and `useDataDepthScores` to the batch path.

5. **Add `maxDuration` for `python-api.py`** in `vercel.json` — if the Vercel account is on Pro plan, set to 60. This helps with cold-start timeouts independent of the batching work.

6. **Consider snapshot write diagnostics** (plan at `.claude/plans/polished-chasing-sutton.md`) — add logging to capture request body size, response status, timing, and backend diagnostics for the empty-body failures. Lower priority than the batch work.

---

## Open Questions

1. **What Vercel plan is the deployment on?** (Hobby = 10s max, Pro = 60s). This determines whether `maxDuration: 60` is possible. **Non-blocking** — batching reduces the need for long timeouts.

2. **Is the `useDataDepthScores` batch rewrite causing visible issues right now?** The data depth overlay may not be active in normal use, so it might not be noticed. **Potentially blocking** — should be reverted as step 1.

3. **Should the snapshot write diagnostics be implemented in this branch or a separate one?** The plan exists but wasn't started. **Non-blocking.**
