# Automation Pipeline

How DagNet runs headless pull-retrieve-commit automation for scheduled data refresh.

## Overview

An automation run executes `pull → apply pending Bayes patches → per-graph (retrieve + commission Bayes) → drain Bayes fits` for one or more graphs. It tracks state through phases, supports cross-tab locking, and persists full diagnostics to IndexedDB.

## Automation Run State

**Location**: `automationRunService.ts`

Phases: `idle` --> `waiting` --> `countdown` --> `running` --> `stopping` --> `idle`

State includes: `runId`, `graphFileId`, `graphName`, `startedAtMs`, `stopRequested`, `countdownSecondsRemaining`

Subscribers notified on every state change for UI updates (banners, countdown display).

## Daily Fetch Flag

**Location**: `dailyFetchService.ts`

Per-graph boolean flag (`dailyFetch: true`) marking graphs for automatic processing.

- `getGraphsForWorkspace()`: queries IDB for all graph files, deduplicates prefixed/unprefixed variants
- `applyChanges()`: bulk-updates the flag, syncs to IDB (both variants), FileRegistry, and GraphStore

## Daily Automation Job

**Location**: `dailyAutomationJob.ts`

Registered as a reactive singleton with cross-tab locking. Two modes:

### Enumeration mode (default, `?retrieveall` on URL)

1. Wait for React context (repo/branch/tabOps) to become ready (60s timeout)
2. Pre-pull from Git to refresh workspace
3. Enumerate all graphs with `dailyFetch=true` from IDB

### Explicit mode (`?retrieveall=1&graph=graph1&graph=graph2`)

Uses provided graph names directly, skips enumeration.

### Three-phase execution (doc 28 §11.2.1)

**Phase 0 — Apply pending Bayes patches.** After the upfront pull,
scans fileRegistry for `_bayes/patch-*.json` files (from previous
cycle's Bayes fits). Applies the newest per graph via
`scanForPendingPatches`, commits. Ensures yesterday's posteriors are
in place before today's retrieval.

**Phase 1 — Serial fetch + commission.** Per-graph loop: loads graph
headlessly from fileRegistry, calls
`dailyRetrieveAllAutomationService.run()`, then (if `runBayes` is
true on the graph) submits a Bayes fit via
`submitBayesFitForAutomation`. Collects pending fits. 30s start
delay before first graph (0s in tests/e2e).

**Phase 2 — Drain Bayes fits.** `Promise.race` on a shrinking pool
of polling promises. Each completed fit triggers a pull + commit.
30-minute timeout per fit. Failed fits are logged and skipped.
Abort-aware.

### Window management

- Opens Session Log tab for diagnostics
- Auto-closes window after run: 10s on success, 12h on warning/error, 500ms in e2e

## Per-Graph Workflow

**Location**: `dailyRetrieveAllAutomationService.ts`

Cross-tab locked via Web Locks API. Phases:

### 1. Version check (best-effort)

Compares local vs cached remote app version. Aborts if newer version deployed.

### 2. Pull phase

Calls `pullLatestRemoteWins()` -- accepts remote on conflicts.

### 3. Retrieve all phase

Calls `executeRetrieveAllSlicesWithProgressToast()` -- headless, checks DB coverage first.

### 4. Global horizons recompute (best-effort)

Recalculates lag horizons post-retrieve. Failure does not fail the automation.

### 5. Commit phase

Gets committable files, retries once if remote-ahead detected (pulls, then retries).

Abort checks (`shouldAbort?.()`) run before each major phase.

## UK Reference Day

**Location**: `ukReferenceDayService.ts`

Provides canonical "UK reference day" for dynamic DSL invalidation:
- `getReferenceDayUK()`: returns `formatDateUK(new Date())` (e.g. `"2-Apr-26"`)
- `getNextDayBoundaryMs()`: UTC milliseconds of next midnight boundary

Used to invalidate queries on day boundaries without explicit timestamp tracking.

## Automation Logging

**Location**: `automationLogService.ts`

Automation run logs are persisted in two places:

### 1. IndexedDB (primary safety net)

- `persistRunLog(log)`: serialise and store; prunes old runs (keeps max 30)
- `getRunLogs(limit?)`: retrieve recent runs, newest first
- `getRunLog(runId)`: single run by ID

### 2. Git-committed logs (crash-resilient, shared visibility)

During a run, the job commits a log snapshot to `.dagnet/automation-logs/{date}.json` in the data repo every 10 minutes (wall-clock based via `sleepUntilDeadline`, resilient to browser tab throttling). A final commit with the definitive outcome runs in the finally block. The same file is overwritten each time — git tracks history.

The periodic commit uses `automationLogService.commitLogToRepo()`, which loads credentials, serialises the current `getEntries()` output, and calls `gitService.commitAndPushFiles()` directly (the log file is not tracked in IDB or FileRegistry).

Periodic snapshots use outcome `'in-progress'`; the final commit uses the computed outcome (`success`/`warning`/`error`/`aborted`).

These files exist in git for diagnostics but are outside the whitelist that clone/pull uses, so they never enter IDB. With debug/trace children stripped by `endOperation`, committed files are lean (~10-100 KB).

### Log structure

- `runId`: `retrieveall:${timestampMs}`
- `outcome`: `'success' | 'warning' | 'error' | 'aborted' | 'in-progress'`
- `entries`: session log entries (debug/trace children stripped by `endOperation` — only info+ survive)
- `appVersion`, `repository`, `branch`, `durationMs`

### Console helpers (always available)

- `dagnetAutomationLogs(n?)`: summary table of last N runs
- `dagnetAutomationLogEntries(runId)`: full entries for one run
- `dagnetExportLog(runId?)`: download a run as JSON file (most recent if no runId)

## Rate Limit and Timeout Handling

**Location**: `rateLimiter.ts`, `retrieveAllSlicesService.ts`, `fetchDataService.ts`

The system distinguishes between explicit API rate limits (429 responses) and transient timeouts. These are handled differently:

### Error classification (`rateLimiter.ts`)

Three methods, from narrow to broad:

- `isExplicitRateLimitError(error)` — matches only server-side 429 responses: "429", "Too Many Requests", "Exceeded rate limit", "Exceeded concurrent limit"
- `isTimeoutError(error)` — matches network timeouts and connection failures: timeout, ETIMEDOUT, ECONNRESET, failed to fetch, AbortError, etc.
- `isRateLimitError(error)` — union of both. Used by `getFromSourceDirect.ts` atomicity guard where both cases should throw up to the orchestrator.

### Timeout handling (automated runs)

When a fetch times out during a retrieve-all, the system retries indefinitely with exponential backoff: 30s → 60s → 120s → 240s → cap at 5 minutes. The retry loop only exits on:
- **Success** — item fetched, continue to next
- **User abort** — stop the run
- **Explicit 429 during retry** — break out of timeout retries, enter cooldown path

Timeouts never trigger the 45-minute cooldown directly.

### Timeout handling (manual runs)

Shorter patience for interactive use: 2 retries with 15s → 30s backoff. If still failing, records the error and moves to the next item. No cooldown for pure timeouts.

### Explicit 429 handling

Only actual 429 responses trigger the 45-minute cooldown. After cooldown expires: mint a new `retrieved_at` batch timestamp for the scope, bust cache for the scope, retry the item.

### Why timeouts are not rate limits

Amplitude can return a 429 immediately ("Exceeded rate limit with query of cost 360") or hang the connection until it times out (~30s). Previously both were treated identically — a single timeout triggered a 45-minute cooldown. In a real incident (8-Apr-26), this caused 5 consecutive cooldowns (3h 45m wasted) from transient timeouts that would have resolved with a simple 30-60s retry.

## Session Logging Integration

All steps log hierarchically via `sessionLogService`. Per-item detail (cache analysis, signature filtering, DB coverage) is at debug/trace level and stripped at `endOperation`. Only info+ entries survive in the automation log.

- Root: `DAILY_RETRIEVE_ALL`
- Children: `STEP_RETRIEVE`, `STEP_COMMIT`
- Warnings: conflicts, version mismatch, failed horizons, rate limits
- Errors propagate, ending with `'error'` level

See `SESSION_LOG_ARCHITECTURE.md` for full details on levels, thresholds, and the viewer.

## Key Files

| File | Role |
|------|------|
| `src/services/automationRunService.ts` | Run state machine |
| `src/services/automationLogService.ts` | IDB persistence + git-committed run logs |
| `src/services/rateLimiter.ts` | Error classification (429 vs timeout), backoff state |
| `src/services/dailyFetchService.ts` | Per-graph dailyFetch + runBayes flag management |
| `src/services/dailyAutomationJob.ts` | Job orchestration (enumeration, 3-phase execution) |
| `src/services/dailyRetrieveAllAutomationService.ts` | Per-graph pull-retrieve-commit workflow |
| `src/services/bayesPatchService.ts` | Patch apply, cascade, pending-patch scanner |
| `src/services/bayesReconnectService.ts` | Reconnect, resume polling, automation Bayes submission |
| `src/services/ukReferenceDayService.ts` | Canonical UK reference day |
