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

Persists run logs to IndexedDB (survives browser restart):

- `persistRunLog(log)`: serialise and store; prunes old runs (keeps max 30)
- `getRunLogs(limit?)`: retrieve recent runs, newest first
- `getRunLog(runId)`: single run by ID

### Log structure

- `runId`: `retrieveall:${timestampMs}`
- `outcome`: `'success' | 'warning' | 'error' | 'aborted'`
- `entries`: session log entries (debug/trace children stripped by `endOperation` — only info+ survive)
- `appVersion`, `repository`, `branch`, `durationMs`

### Console helpers (always available)

- `dagnetAutomationLogs(n?)`: summary table of last N runs
- `dagnetAutomationLogEntries(runId)`: full entries for one run

### Git-committed automation logs (planned)

Automation logs will be committed to `.dagnet/automation-logs/` in the repo. These files exist in git for diagnostics but are outside the whitelist that clone/pull uses, so they never enter IDB. With debug/trace entries stripped by `endOperation`, committed files are lean (~10-100 KB).

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
| `src/services/automationLogService.ts` | Persistent run logging |
| `src/services/dailyFetchService.ts` | Per-graph dailyFetch + runBayes flag management |
| `src/services/dailyAutomationJob.ts` | Job orchestration (enumeration, 3-phase execution) |
| `src/services/dailyRetrieveAllAutomationService.ts` | Per-graph pull-retrieve-commit workflow |
| `src/services/bayesPatchService.ts` | Patch apply, cascade, pending-patch scanner |
| `src/services/bayesReconnectService.ts` | Reconnect, resume polling, automation Bayes submission |
| `src/services/ukReferenceDayService.ts` | Canonical UK reference day |
