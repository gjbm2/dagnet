# Automation Pipeline

How DagNet runs headless pull-retrieve-commit automation for scheduled data refresh.

## Overview

An automation run executes `pull --> retrieve all --> commit` for one or more graphs. It tracks state through phases, supports cross-tab locking, and persists full diagnostics to IndexedDB.

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

### Per-graph execution

- Opens a tab for each graph (reuses if already open)
- Waits up to 60s for graph data to load from FileRegistry
- Calls `dailyRetrieveAllAutomationService.run()` per graph
- 30s start delay before first graph (0s in tests/e2e)

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

Persists complete run logs to IndexedDB (survives browser restart):

- `persistRunLog(log)`: serialise and store; prunes old runs (keeps max 30)
- `getRunLogs(limit?)`: retrieve recent runs, newest first
- `getRunLog(runId)`: single run by ID

### Log structure

- `runId`: `retrieveall:${timestampMs}`
- `outcome`: `'success' | 'warning' | 'error' | 'aborted'`
- `entries`: full session log entries (hierarchical with children)
- `appVersion`, `repository`, `branch`, `durationMs`

### Console helpers (always available)

- `dagnetAutomationLogs(n?)`: summary table of last N runs
- `dagnetAutomationLogEntries(runId)`: full entries for one run

## Session Logging Integration

All steps log hierarchically via `sessionLogService`:
- Root: `DAILY_RETRIEVE_ALL`
- Children: `STEP_PULL`, `STEP_RETRIEVE`, `STEP_COMMIT`
- Warnings: conflicts, version mismatch, failed horizons
- Errors propagate, ending with `'error'` level

## Key Files

| File | Role |
|------|------|
| `src/services/automationRunService.ts` | Run state machine |
| `src/services/automationLogService.ts` | Persistent run logging |
| `src/services/dailyFetchService.ts` | Per-graph dailyFetch flag management |
| `src/services/dailyAutomationJob.ts` | Job orchestration (enumeration, per-graph execution) |
| `src/services/dailyRetrieveAllAutomationService.ts` | Per-graph pull-retrieve-commit workflow |
| `src/services/ukReferenceDayService.ts` | Canonical UK reference day |
