# Retrieve-All Automation — Specification & Rebuild Plan

## Purpose

Headless, URL-triggered automation that refreshes data for one or more graphs. Designed to run unattended (e.g. scheduled via cron/Task Scheduler). Opens a browser window, does its work, closes itself.

---

## Part 1: Target Specification

### URL Parameters

| Parameter | Example | Meaning |
|-----------|---------|---------|
| `?retrieveall` | `?retrieveall` | Enumeration mode: pull, then process all graphs with `dailyFetch: true` |
| `?retrieveall=<names>` | `?retrieveall=graph-a,graph-b` | Explicit mode: pull, then process the named graphs |
| `?retrieveall=<name>&retrieveall=<name>` | `?retrieveall=graph-a&retrieveall=graph-b` | Explicit mode (repeated param variant) |
| `?graph=<name>&retrieveall` | `?graph=graph-a&retrieveall` | Explicit mode (boolean flag variant — graph name from `?graph`) |
| `?e2e=1` | `?retrieveall&e2e=1` | Test mode: countdown 0ms, close delay 500ms |
| `?noclose` | `?retrieveall&noclose` | Debug mode: never auto-close the window, regardless of outcome |

### Boot Contract

When the app loads with `?retrieveall` in the URL:

#### 1. Start blank

No tabs restored from IDB. No graph opened from the URL. The app renders with zero tabs.

TabContext initialises system files (credentials, connections, settings, hash mappings) but does nothing else. `loadFromURLData()` does NOT run — the automation job owns the full lifecycle.

#### 2. Wait for app readiness

The automation job waits for TWO conditions before proceeding:
- **NavigatorContext has finished init**: `dagnet:navigatorLoadComplete` has fired. This ensures the workspace exists in IDB and any first-init clone is complete. The job must NOT start pulling while NavigatorContext is still mid-clone.
- **TabContext provides tab operations**: `automationCtx.tabOps?.openTab` is available.

The hook bridges a `navigatorReady` flag into the automation context (set by listening for `dagnet:navigatorLoadComplete`). The job polls for `repo && navigatorReady && hasTabOps`. Timeout: 60s. If not ready in time, log a warning and abort.

#### 3. Pull once (remote wins)

Before opening any graph or assessing what to do, pull the full workspace from remote. This ensures the latest state — including the latest `dailyFetch` flags — is available.

After pulling, load workspace from IDB so graph enumeration can read it.

**If the pull fails:** log a warning (`DAILY_RETRIEVE_ALL_PRE_PULL_FAILED`) and proceed with whatever is cached in IDB. Do NOT abort the entire automation — the cached data may be slightly stale but is usually good enough. The automation will still retrieve fresh data from external sources and commit it.

#### 4. Determine target graphs

- **Enumeration mode** (`?retrieveall` with no value): scan IDB for all graphs with `dailyFetch: true`.
- **Explicit mode** (`?retrieveall=graph-a,graph-b`): use the provided names directly.

If no target graphs are found, log a warning and proceed to cleanup.

#### 5. Countdown

30s delay with banner UI. User can cancel via "Stop" action. In E2E mode (`?e2e=1`), countdown is 0ms.

#### 6. Per-graph loop

For each target graph:

1. Open a tab for the graph
2. Wait for graph data to load (60s timeout; skip graph if exceeded)
3. Run the per-graph workflow:
   - **Version check** (best-effort): abort if a newer app version is deployed
   - **Retrieve all slices**: fetch all parameter data from external sources
   - **Recompute global horizons** (best-effort): recalculate lag horizons
   - **Commit**: commit all dirty files; retry once if remote is ahead (pull + retry)
4. Keep session log tab focused between graphs

There is no per-graph pull. The single upfront pull in step 3 is sufficient.

#### 7. Cleanup

1. Remove `?retrieveall`, `?graph` from URL (prevent re-trigger on refresh)
2. Persist run log to IDB (outcome, entries, duration, app version)
3. Auto-close window:
   - **Success**: 10s delay
   - **Error/warning**: 12h delay (so the operator can inspect)
   - **E2E mode** (`?e2e=1`): 500ms delay
   - **No-close mode** (`?noclose`): never close

### Invariants

These must hold at all times during the automation lifecycle:

1. **No tab state restored during boot.** `loadTabsFromDB()` is skipped. `loadFromURLData()` is skipped. Zero tabs exist when the automation job starts.
2. **Pull completes before any graph tab is opened.** The upfront pull is the first substantive action after app readiness.
3. **No staleness nudges or auto-pull.** These are suppressed for the duration of the automation to prevent interference.
4. **One deliberate pull, not N+1.** The workspace is pulled once at the top. The per-graph workflow does not pull again. Exception: during commit, if remote is ahead (someone else pushed between our pull and our commit), the commit retry path pulls to resolve the race — this is a conflict-resolution pull, not a data-refresh pull.
5. **Cross-tab singleton.** Only one automation instance runs across all browser tabs/windows for the same origin.

### Suppressed Systems

During `?retrieveall` automation, the following are suppressed:

- Staleness nudges (`dagnet:nonudge` session flag)
- Auto-pull jobs
- Retrieve nudge jobs
- Version-check banner

### Session Logging

All steps log hierarchically via `sessionLogService`:

- **Root**: `DAILY_RETRIEVE_ALL`
- **Children**: `STEP_PULL` (upfront), `STEP_RETRIEVE`, `STEP_COMMIT` (per graph)
- **Warnings**: conflicts during pull, version mismatch, failed horizons, skipped graphs
- **Errors**: propagated, ending the operation with `'error'` level

### Persistent Run Log

After completion, a run log is persisted to IDB via `automationLogService`:

- `runId`: `retrieveall:<timestampMs>`
- `outcome`: `'success' | 'warning' | 'error' | 'aborted'`
- `graphs`: list of target graph names
- `entries`: full session log entries (hierarchical)
- `appVersion`, `repository`, `branch`, `durationMs`

Console helpers for inspection:
- `dagnetAutomationLogs(n?)` — summary table of last N runs
- `dagnetAutomationLogEntries(runId)` — full entries for one run

### Target File Layout

| File | Role |
|------|------|
| `TabContext.tsx` | Boot-time init — skip tab restore AND `loadFromURLData()` in retrieveall mode |
| `useURLDailyRetrieveAllQueue.ts` | URL parsing, context bridge, job trigger |
| `dailyAutomationJob.ts` | Job orchestration: upfront pull, graph targeting, per-graph loop, cleanup |
| `dailyRetrieveAllAutomationService.ts` | Per-graph workflow: version check → retrieve → horizons → commit |
| `automationLogService.ts` | Run log persistence (unchanged) |

### E2E Tests

All tests use `?e2e=1` to eliminate delays. All tests seed IDB state (credentials, workspace, graph files) before navigating with `?retrieveall`.

#### 1. Blank boot

Navigate with `?retrieveall=test-graph&e2e=1`. Assert zero tabs exist before the automation job starts its first action (the upfront pull).

**Invariant tested**: no tab state restored during boot.

#### 2. Pull before tabs

Stub the GitHub API and track call order. Navigate with `?retrieveall=test-graph&e2e=1`. Assert that the pull API call occurs before any graph tab is opened.

**Invariant tested**: pull completes before any graph tab is opened.

#### 3. Enumeration mode

Seed two graphs: one with `dailyFetch: true`, one without. Navigate with `?retrieveall&e2e=1`. Assert only the flagged graph is processed (appears in the automation run log).

**Invariant tested**: enumeration respects `dailyFetch` flag.

#### 4. Explicit mode

Seed two graphs. Navigate with `?retrieveall=graph-a&e2e=1`. Assert only `graph-a` is processed.

**Invariant tested**: explicit mode processes only named graphs.

#### 5. Window close

Navigate with `?retrieveall=test-graph&e2e=1`. Spy on `window.close()`. Assert the spy fires after completion. Assert automation run log is persisted to IDB.

**Invariant tested**: window auto-closes and logs are persisted.

#### 6. No-close mode

Navigate with `?retrieveall=test-graph&e2e=1&noclose`. Wait for automation to complete. Assert `window.close()` is NOT called.

**Invariant tested**: `?noclose` prevents auto-close.

---

## Part 2: Current State (Pre-Rebuild Snapshot, 3-Apr-26)

This section captures what the existing implementation actually does so the rebuild doesn't accidentally lose anything that works, and so we know exactly what to rip out.

### Current Architecture

The implementation is split across 6 files with a React hook → scheduler job → per-graph service pipeline:

```
URL ?retrieveall=...
  → TabContext.tsx (boot: skip loadTabsFromDB, but STILL runs loadFromURLData which opens first graph tab)
  → useStalenessNudges.ts (sets dagnet:nonudge=1 to suppress nudges)
  → useURLDailyRetrieveAllQueue.ts (parses URL, bridges React context to job, triggers scheduler)
  → jobSchedulerService.registerJob('daily-automation', ...) via dailyAutomationJob.ts
  → runDailyAutomation() orchestrates: wait-for-ready → [enumerate] → countdown → per-graph loop
  → dailyRetrieveAllAutomationService.run() per graph: version-check → pull → retrieve → horizons → commit
  → cleanup: URL clean, persist log, auto-close window
```

### File-by-File Documentation

#### 1. TabContext.tsx (boot touchpoints)

**Lines 1098–1142: Init effect**
- Detects `?retrieveall` via `URLSearchParams.has('retrieveall')` (line 1106)
- Skips `loadTabsFromDB()` (line 1123) — correct
- Does NOT skip `loadFromURLData()` (line 1127) — **BUG: root cause of the tab-restore problem**

**Lines 1839–1884: Inside `loadFromURLData()`**
- Extracts first graph name from `?retrieveall=X` values (line 1843–1846)
- Falls through to `?graph` handling which opens a tab via `openTab()` (line 1875)
- This means the first graph tab is opened BEFORE any pull happens

**Lines 1791: Comment**
- References the hook: "A separate hook (useURLDailyRetrieveAllQueue) runs pull → retrieve → commit after load"

#### 2. useURLDailyRetrieveAllQueue.ts (hook)

**Pure functions (no side effects):**
- `parseURLParams()` — reads `retrieveall` and `graph` from URL
- `normaliseGraphNames()` — dedupes, splits commas
- `resolveTargetGraphNames()` — resolves explicit graph list

**Hook body:**
- Parses URL params on mount (useEffect, line 62)
- Every render: calls `updateDailyAutomationContext()` to push React state (navState, tabs, tabOps, fileRegistry) into the module-level `automationCtx` object (line 67–76)
- Once only: registers the daily-automation job and triggers it via `jobSchedulerService.run()` (lines 98–106)
- Module-level singleton guard `urlDailyRetrieveAllQueueProcessed` prevents double-fire

**Exports:**
- `useURLDailyRetrieveAllQueue()` — the hook
- `resetURLDailyRetrieveAllQueueProcessed()` — test helper

#### 3. dailyAutomationJob.ts (orchestration)

**Context store (module-level):**
- `DailyAutomationContext` interface: selectedRepo, selectedBranch, tabs, tabOps, fileRegistryGetFile
- `automationCtx` object — written by the hook every render, read by the job
- `updateDailyAutomationContext()` — Object.assign into automationCtx

**Helpers:**
- `sleep()`, `sleepUntilDeadline()` — async delays
- `inferGraphNameFromFileId()` — strips `graph-` prefix
- `enumerateDailyFetchGraphsFromIDB()` — queries IDB for all graph files, dedupes prefixed/unprefixed variants, filters by workspace + `dailyFetch: true`, returns sorted names
- `waitForGraphData()` — polls fileRegistry until graph data is loaded (60s timeout)
- `reassertTabFocus()` — dispatches `dagnet:switchToTab` events at multiple delays (0, 50, 200, 750ms)
- `getStartDelayMs()` — 30s prod, 0 in test/e2e
- `getCloseDelayMs()` — 10s success, 12h error, 0 test, 500ms e2e

**Job registration:**
- `registerDailyAutomationJob()` — singleton, registers with scheduler as reactive job
- Cross-tab lock: `dagnet:daily-retrieveall`, onDuplicate: skip
- Suppresses: `auto-pull`, `retrieve-nudge`
- Suppresses banners for: `version-check`
- NOT boot-gated (has own wait loop to avoid E2E deadlocks)

**runDailyAutomation() flow:**
1. Wait for app ready (poll automationCtx for repo + tabOps, 60s timeout)
2. IF enumeration mode: pull remote-wins → loadWorkspaceFromIDB → enumerate dailyFetch graphs
3. IF explicit mode: skip pull, use provided names directly — **BUG: no upfront pull in explicit mode**
4. Open session log tab
5. Countdown (30s prod, 0 e2e)
6. Per-graph loop:
   - Check if tab already exists (automationCtx.tabs) — reuse or open new
   - Reassert session log focus
   - Wait for graph data to load (60s)
   - Call `dailyRetrieveAllAutomationService.run()` per graph
7. Finally block (always runs):
   - Restore document.title
   - Clean URL params (?retrieveall, ?graph)
   - Determine outcome from session log entries (success/warning/error/aborted)
   - Persist run log via automationLogService
   - Sleep until close deadline
   - Call window.close()

**Test helpers:**
- `_resetDailyAutomationJob()` — resets singleton + context
- `__dagnetEnumerateDailyFetchGraphs` exposed on window in dev mode

#### 4. dailyRetrieveAllAutomationService.ts (per-graph workflow)

**Singleton class with Web Locks:**
- `withCrossTabLock()` — Web Locks API with lock name `dagnet:daily-retrieveall`
- Note: this is the SAME lock name as the scheduler job — redundant double-locking

**runInternal() flow:**
1. Abort check
2. Version check (best-effort): refreshRemoteAppVersionIfDue → isRemoteAppVersionNewerThanLocal → abort if newer
3. **Pull (remote wins)** — **REDUNDANT: the upfront pull already did this** (in enumeration mode; in explicit mode this is the ONLY pull)
4. Abort check
5. Retrieve all slices via `executeRetrieveAllSlicesWithProgressToast()`
6. Recompute global horizons (best-effort)
7. Abort check
8. Commit loop (retry once if remote-ahead):
   - Get committable files
   - Commit with remote-ahead callback that pulls again
   - On "please commit again" error, retry once

**Session logging:**
- Root op: `DAILY_RETRIEVE_ALL`
- Children: `STEP_PULL`, `STEP_RETRIEVE`, `RETRIEVE_COMPLETE`, `HORIZONS_GLOBAL_RECOMPUTE_FAILED`, `STEP_COMMIT`, `COMMIT_SKIPPED`, `COMMIT_COMPLETE`, `COMMIT_RETRY`, `REMOTE_AHEAD_PULL`, `UPDATE_REQUIRED_ABORT`

#### 5. automationRunService.ts (legacy state machine)

**NOT USED by the current scheduler-based flow.** The scheduler has its own state management. This is dead code preserved only because `useAutomationRunState.ts` imports it.

- Phases: idle → waiting → countdown → running → stopping → idle
- State: runId, graphFileId, graphName, startedAtMs, stopRequested, countdownSecondsRemaining
- Subscribers notified on state change

#### 6. useAutomationRunState.ts (legacy hook)

`useSyncExternalStore` wrapper around `automationRunService`. **Dead code** — nothing renders based on this.

#### 7. AutomationBanner.tsx (dead stub)

Returns null. Comment says "kept as an empty stub to avoid breaking imports. Will be removed in Phase 6 cleanup." The scheduler manages its own banner via `presentation: 'banner:automation'`.

#### 8. automationLogService.ts (run log persistence)

**This is clean and stays.** Persists run logs to IDB, prunes to 30 entries. Console helpers:
- `dagnetAutomationLogs(n?)` — summary table
- `dagnetAutomationLogEntries(runId)` — full entries

#### 9. useStalenessNudges.ts (suppression)

**Lines 85–88:** When `?retrieveall` is in URL, sets `dagnet:nonudge=1` in sessionStorage → `suppressStalenessNudges = true` → all nudge jobs exit early. **This is correct and stays.**

### Known Bugs

1. **`loadFromURLData()` opens graph tab before pull** — TabContext line 1127 runs unconditionally in retrieveall mode, and line 1875 opens the first graph tab. This violates "start blank".

2. **Explicit mode has no upfront pull** — Only enumeration mode (lines 255–264) pulls before enumerating. Explicit mode jumps straight to the per-graph loop. The per-graph service then pulls per-graph, but tabs are already open before that pull.

3. **Per-graph pull is redundant in enumeration mode** — The upfront pull at line 259 gets latest, then the per-graph service pulls AGAIN at line 94 of dailyRetrieveAllAutomationService.ts.

4. **Tab reuse logic is vestigial** — Line 358 checks for existing tabs, but since we skip loadTabsFromDB, the only way tabs exist is if loadFromURLData opened them (bug #1).

5. **Double Web Lock** — Both the scheduler job (line 182) and the per-graph service (line 39) acquire the same `dagnet:daily-retrieveall` lock. Redundant.

6. **automationRunService is dead code** — The scheduler replaced it but it was never deleted.

7. **AutomationBanner is dead code** — Returns null, kept "to avoid breaking imports".

### What Works and Must Be Preserved in Rebuild

1. **Enumeration logic** — `enumerateDailyFetchGraphsFromIDB()` correctly handles prefixed/unprefixed fileId deduplication, workspace scoping, and alphabetical sorting.

2. **URL parameter parsing** — `parseURLParams()`, `normaliseGraphNames()`, `resolveTargetGraphNames()` handle all URL variants correctly.

3. **Nudge suppression** — `dagnet:nonudge` sessionStorage flag suppresses staleness nudges, auto-pull, and version-check banner during automation.

4. **Scheduler integration** — Reactive job, cross-tab singleton lock, banner presentation, abort support via `ctx.shouldAbort()`.

5. **Per-graph workflow** — Version check, retrieve-all, horizons recompute, commit-with-retry are all correct (minus the redundant pull).

6. **Run log persistence** — automationLogService cleanly persists and prunes logs.

7. **Window close with outcome-dependent delay** — 10s success, 12h error, 500ms e2e.

8. **Context bridge pattern** — The hook pushing React state into a module-level object that the service-layer job reads. Avoids the job needing React context directly.

9. **Session logging** — Hierarchical logging with meaningful operation codes.

10. **Document title updates** — Shows automation phase in browser tab title for operator visibility.

### Existing Tests (all to be replaced)

| File | Type | What it tests | Quality |
|------|------|---------------|---------|
| `dailyRetrieveAllAutomationService.test.ts` | vitest, fully mocked | Per-graph ordering, version check, abort, commit retry | Tests the old design (with per-graph pull). All mocked — proves nothing about real integration. |
| `useURLDailyRetrieveAll.test.ts` | vitest, happy-dom, heavily mocked | Hook triggering, multi-graph serialisation, delayed repo init, enumeration mode | Exercises the hook but through 10 layers of mocks. Fragile. |
| `useURLDailyRetrieveAllQueue.dailyFetch.test.ts` | vitest, mocked DB | Enumeration filtering, workspace scoping, dedup, sorting | Copy-pastes the enumeration function rather than importing it. Tests the copy, not the real code. |
| `automationWindowClose.spec.ts` | Playwright E2E | Window.close() fires after error outcome | Only tests error path. Seeds a tab which is wrong for the new spec. |

---

## Part 3: Rebuild Teardown Inventory

### Files to delete entirely

| File | Reason |
|------|--------|
| `src/services/dailyAutomationJob.ts` | Rewrite from scratch |
| `src/services/dailyRetrieveAllAutomationService.ts` | Rewrite from scratch |
| `src/hooks/useURLDailyRetrieveAllQueue.ts` | Rewrite from scratch |
| `src/services/automationRunService.ts` | Dead code |
| `src/hooks/useAutomationRunState.ts` | Dead code |
| `src/components/AutomationBanner.tsx` | Dead code |
| `src/services/__tests__/dailyRetrieveAllAutomationService.test.ts` | Replaced by E2E |
| `src/hooks/__tests__/useURLDailyRetrieveAll.test.ts` | Replaced by E2E |
| `src/hooks/__tests__/useURLDailyRetrieveAllQueue.dailyFetch.test.ts` | Replaced by E2E |
| `e2e/automationWindowClose.spec.ts` | Replaced by new E2E suite |

### Files requiring surgery (not deletion)

| File | What to change |
|------|---------------|
| `TabContext.tsx` | Skip `loadFromURLData()` in retrieveall mode (line 1127). Remove `?retrieveall` graph-opening logic from `loadFromURLData()` (lines 1839–1884). |
| `AppShell.tsx` | Remove `useURLDailyRetrieveAllQueue()` call (line 73). Remove `AutomationBanner` import (line 28) and render (lines 2158, 2174). Replace with new hook. |

### Files requiring import fixup

| File | Reference to fix |
|------|-----------------|
| `GraphEditor.tsx` | Comment on line 101 referencing old hook name (cosmetic) |
| `workspaceService.integration.test.ts` | Lines 1296, 1298, 1300 — file list assertions mentioning old filenames |

### Files to keep unchanged

| File | Reason |
|------|--------|
| `automationLogService.ts` | Clean, independent, works |
| `jobSchedulerService.ts` | Scheduler infrastructure — new job registers here |
| `useStalenessNudges.ts` | `?retrieveall` suppression is correct |
| `dailyFetchService.ts` | UI concern for managing the flag, not part of automation |

### Potential interference points (must guard in rebuild)

| Risk | Source | Mitigation |
|------|--------|------------|
| NavigatorContext auto-clone on first init | NavigatorContext.tsx lines 71–108, 545–549 | Automation's upfront pull must wait for NavigatorContext init (`dagnet:navigatorLoadComplete`) |
| NavigatorContext empty-workspace re-clone | NavigatorContext.tsx lines 583–594 | Seed workspace properly in E2E tests |
| Post-init auth check GitHub API call | AppShell.tsx lines 244–256 | Low risk (read-only check), but could show auth-expired modal |
| `dagnet:switchToTab` resurrecting stale tabs from IDB | TabContext.tsx lines 1152–1166 | Audit all `reassertTabFocus` callers; only dispatch for tabs the automation created |
| `dagnet:openTemporaryTab` from services | TabContext.tsx lines 1146–1148 | Expected for session log tab; no other services should fire during automation |
| `?clear`/`?clearall` URL params | AppShell.tsx lines 2189–2221 | Operator awareness — don't combine with `?retrieveall` |

---

## Part 4: Implementation Plan

### Phasing Overview

```
Phase 1: TEARDOWN — delete old code, fix broken imports, verify app still boots
  ── GATE 1: app boots clean, no TS errors, existing unrelated tests pass ──
Phase 2: REBUILD SERVICES — new dailyAutomationJob.ts, new dailyRetrieveAllAutomationService.ts (pure TS, no React)
  ── GATE 2: new services compile, manual inspection of flow logic ──
Phase 3: REBUILD HOOK + WIRING — new useURLDailyRetrieveAllQueue.ts (React), TabContext surgery, AppShell wiring
  ── GATE 3: app boots with ?retrieveall, blank screen, automation job starts and logs to session log ──
Phase 4: E2E TEST SUITE — write all 6 Playwright specs against the rebuilt code
  ── GATE 4: all 6 E2E specs pass ──
Phase 5: MANUAL SMOKE TEST — run with real credentials against a real repo
  ── GATE 5: user confirms it works end-to-end ──
```

---

### Phase 1: TEARDOWN

**Objective:** Remove all old retrieve-all code. App must boot and compile without it.

#### Step 1.1: Delete dead code files

Delete the following 6 files:

| # | File | Why |
|---|------|-----|
| 1 | `src/services/automationRunService.ts` | Dead code — not used by scheduler-based flow |
| 2 | `src/hooks/useAutomationRunState.ts` | Dead code — only consumer of automationRunService |
| 3 | `src/components/AutomationBanner.tsx` | Dead code — returns null |
| 4 | `src/services/dailyAutomationJob.ts` | Being rewritten from scratch |
| 5 | `src/services/dailyRetrieveAllAutomationService.ts` | Being rewritten from scratch |
| 6 | `src/hooks/useURLDailyRetrieveAllQueue.ts` | Being rewritten from scratch |

#### Step 1.2: Delete old test files

Delete the following 4 test files:

| # | File | Why |
|---|------|-----|
| 1 | `src/services/__tests__/dailyRetrieveAllAutomationService.test.ts` | Tests old design |
| 2 | `src/hooks/__tests__/useURLDailyRetrieveAll.test.ts` | Tests old hook |
| 3 | `src/hooks/__tests__/useURLDailyRetrieveAllQueue.dailyFetch.test.ts` | Tests copy-pasted function |
| 4 | `e2e/automationWindowClose.spec.ts` | Tests old flow |

#### Step 1.3: Fix AppShell.tsx

**File:** `src/AppShell.tsx`

- **Line 27:** Remove `import { useURLDailyRetrieveAllQueue } from './hooks/useURLDailyRetrieveAllQueue';`
- **Line 28:** Remove `import { AutomationBanner } from './components/AutomationBanner';`
- **Line 73:** Remove `useURLDailyRetrieveAllQueue();`
- **Line 2158:** Remove `<AutomationBanner />`
- **Line 2174:** Remove `<AutomationBanner />`

#### Step 1.4: Fix GraphEditor.tsx

**File:** `src/components/editors/GraphEditor.tsx`

- **Lines 100–101:** Remove or update comment referencing `useURLDailyRetrieveAllQueue`
- **Lines 103–105:** Remove dead `URLDailyRetrieveAllProcessor` function (returns null)
- **Line 2165:** Remove `<URLDailyRetrieveAllProcessor fileId={fileId} />`
- **Line 2189:** Remove `<URLDailyRetrieveAllProcessor fileId={fileId} />`

#### Step 1.5: Fix workspaceService.integration.test.ts

**File:** `src/services/__tests__/workspaceService.integration.test.ts`

- **Lines 1296–1300:** Remove the three filename strings from the file-list assertion:
  - `'dailyRetrieveAllAutomationService.ts'`
  - `'dailyAutomationJob.ts'`
  - `'useURLDailyRetrieveAllQueue.ts'`

#### Step 1.6: TabContext surgery (boot gate only)

**File:** `src/contexts/TabContext.tsx`

**Approach:** Add an early return inside `loadFromURLData()` for retrieveall mode. This is safer than wrapping the call site because `loadFromURLData()` also handles `?graph=`, `?parameter=`, `?context=`, `?case=`, live share, and static share — we must not break those paths.

**Change:** Inside `loadFromURLData()`, at the top of the function body (before any URL processing), add an early return. Pass the already-computed `isRetrieveAllMode` flag as a parameter rather than re-parsing the URL:

1. **Init effect (line 1127):** Change `await loadFromURLData();` to `await loadFromURLData(isRetrieveAllMode);`
2. **`loadFromURLData()` signature:** Add parameter `isRetrieveAllMode: boolean = false`
3. **`loadFromURLData()` body, first line:** Add:
   ```
   if (isRetrieveAllMode) {
     console.log('[TabContext] retrieveall mode — skipping loadFromURLData (automation job owns lifecycle)');
     return;
   }
   ```

Lines 1839–1884 (the `?retrieveall` graph-opening logic inside `loadFromURLData`) become unreachable in retrieveall mode but are left in place — they handle `?graph=` in normal (non-retrieveall) boot.

#### GATE 1: Verify teardown

Run these checks. ALL must pass before proceeding to Phase 2.

1. **TypeScript compiles:** `cd graph-editor && npx tsc --noEmit` — zero errors
2. **App boots normally:** `npm run dev`, open in browser, verify normal workspace loading works (no `?retrieveall`)
3. **App boots with `?retrieveall`:** open with `?retrieveall=test&e2e=1` — should show blank screen, no tabs, no errors in console. Automation won't run yet (hook not wired), but boot must not crash.
4. **Existing unrelated tests pass:** run a representative subset (e.g. `npm test -- --run src/services/__tests__/fileOperations.integration.test.ts`) to confirm we haven't broken anything

---

### Phase 2: REBUILD SERVICES

**Objective:** Write the new service-layer files. These are pure TypeScript with no React dependency — they can be tested in isolation.

#### Step 2.1: Write new `dailyRetrieveAllAutomationService.ts`

**File:** `src/services/dailyRetrieveAllAutomationService.ts`

This is the per-graph workflow. Changes from old version:
- **Remove** the `pullLatestRemoteWins` call — upfront pull is in the job, not here
- **Remove** the `withCrossTabLock` wrapper — the scheduler handles cross-tab locking
- **Keep** version check (best-effort) via `stalenessNudgeService`
- **Keep** retrieve all slices via `executeRetrieveAllSlicesWithProgressToast`
- **Keep** horizons recompute (best-effort) via `lagHorizonsService.recomputeHorizons()`
- **Keep** commit with retry via `repositoryOperationsService.commitFiles()` / `.getCommittableFiles()`
- **Keep** all abort checks
- **Keep** all session logging
- **Keep** `formatDateUK` for commit message: `Daily data refresh (<graphName>) - <date>`
- **Keep** `inferGraphName` helper (strips `graph-` prefix from fileId)

Interface:
```
DailyRetrieveAllAutomationOptions {
  repository: string;
  branch: string;
  graphFileId: string;
  getGraph: () => GraphData | null;
  setGraph: (g: GraphData | null) => void;
  shouldAbort?: () => boolean;
}
```

Session log structure (per graph):
- Root: `DAILY_RETRIEVE_ALL` with `(repo/branch, graph: name)`
- Children: `UPDATE_REQUIRED_ABORT`, `STEP_RETRIEVE`, `RETRIEVE_COMPLETE`, `HORIZONS_GLOBAL_RECOMPUTE_FAILED`, `STEP_COMMIT`, `COMMIT_SKIPPED`, `COMMIT_COMPLETE`, `COMMIT_RETRY`, `REMOTE_AHEAD_PULL`

Note: `STEP_PULL` is removed from the per-graph service — the upfront pull is logged by the job.

#### Step 2.2: Write new `dailyAutomationJob.ts`

**File:** `src/services/dailyAutomationJob.ts`

This is the orchestration job. Changes from old version:
- **Always pull upfront** in both enumeration and explicit mode (not just enumeration)
- **Remove** tab reuse logic — always open fresh
- **Add** `?noclose` support to `getCloseDelayMs()`
- **Keep** context store pattern (`DailyAutomationContext`, `updateDailyAutomationContext()`)
- **Keep** `enumerateDailyFetchGraphsFromIDB()` (preserve exact dedup/scoping logic)
- **Keep** `waitForGraphData()`, `reassertTabFocus()`, `getStartDelayMs()`
- **Keep** scheduler job registration (reactive, singleton:cross-tab, suppress auto-pull + retrieve-nudge)
- **Keep** session log tab opening
- **Keep** countdown
- **Keep** per-graph loop (open tab → wait for data → run per-graph service)
- **Keep** finally block (URL cleanup, outcome determination, run log persistence, window close)
- **Keep** document title updates
- **Keep** `_resetDailyAutomationJob()` test helper
- **Keep** `__dagnetEnumerateDailyFetchGraphs` dev-mode window exposure

**Exports:**
- `DailyAutomationContext` (interface — includes `navigatorReady: boolean` field)
- `updateDailyAutomationContext(ctx)`
- `registerDailyAutomationJob()`
- `_resetDailyAutomationJob()` (test helper)

**runDailyAutomation() new flow:**
1. Show banner, wait for app ready (poll automationCtx for `repo && navigatorReady && hasTabOps`, 60s timeout)
2. **Pull upfront (remote wins)** — ALWAYS, both modes
3. **Load workspace from IDB** — ALWAYS, after pull
4. **Determine targets:**
   - Enumeration mode: `enumerateDailyFetchGraphsFromIDB()`
   - Explicit mode: use `params.graphNames` directly
5. If no targets, log warning, proceed to cleanup
6. Open session log tab
7. Countdown (30s prod, 0 e2e)
8. Per-graph loop:
   - Open tab (always fresh — no reuse check)
   - Reassert session log focus
   - Wait for graph data (60s)
   - Call `dailyRetrieveAllAutomationService.run()`
9. Finally: restore title, clean URL, determine outcome, persist log, close window

**`getCloseDelayMs()` updated logic:**
```
if (test mode) return 0;
if (e2e mode) return 500;
if (?noclose) return Infinity;  // NEW
if (success) return 10_000;
return 12 * 60 * 60 * 1000;  // error/warning
```

For `Infinity`: replace the `sleepUntilDeadline` + `window.close()` with a check:
```
if (closeDelayMs === Infinity) {
  sessionLogService.info('session', 'AUTOMATION_WINDOW_KEPT_OPEN', '?noclose: window will remain open for inspection');
} else {
  await sleepUntilDeadline(closeDelayMs);
  try { window.close(); } catch { }
}
```

**Session log structure (job-level):**
- `DAILY_RETRIEVE_ALL_WAITING` — waiting for app ready
- `DAILY_RETRIEVE_ALL_ABORTED` — user cancelled
- `DAILY_RETRIEVE_ALL_PRE_PULL` — upfront pull starting
- `DAILY_RETRIEVE_ALL_PRE_PULL_CONFLICTS` — conflicts resolved
- `DAILY_RETRIEVE_ALL_PRE_PULL_FAILED` — pull failed (proceed with cached)
- `DAILY_RETRIEVE_ALL_SKIPPED` — app not ready / no graphs / graph didn't load
- `DAILY_RETRIEVE_ALL_NO_GRAPHS` — no dailyFetch graphs found
- `DAILY_RETRIEVE_ALL_FOUND` — enumerated N graphs
- `DAILY_RETRIEVE_ALL_GRAPH_START` — starting graph N/M
- `DAILY_RETRIEVE_ALL_GRAPH_COMPLETE` — completed graph N/M
- `AUTOMATION_WINDOW_CLOSE` — closing/keeping window
- `AUTOMATION_WINDOW_KEPT_OPEN` — noclose mode

#### GATE 2: Verify rebuild compiles

1. **TypeScript compiles:** `cd graph-editor && npx tsc --noEmit` — zero errors
2. **No circular imports:** verify the import graph is clean (job imports service, hook imports job — no cycles)
3. **Manual inspection:** read through both new service files to verify the flow matches the spec:
   - Job pulls upfront in BOTH modes
   - Per-graph service does NOT pull
   - `?noclose` is handled
   - No tab reuse logic
   - Cross-tab lock is on the job only (not duplicated in per-graph service)

---

### Phase 3: WIRING

**Objective:** Wire the new hook into AppShell, verify the full flow works in the browser.

#### Step 3.1: Write new `useURLDailyRetrieveAllQueue.ts`

**File:** `src/hooks/useURLDailyRetrieveAllQueue.ts`

Changes from old version:
- **Keep** `parseURLParams()`, `normaliseGraphNames()`, `resolveTargetGraphNames()`
- **Keep** module-level singleton guard
- **Keep** context bridge (every render pushes to `updateDailyAutomationContext`)
- **Keep** job registration + trigger logic
- **Keep** `resetURLDailyRetrieveAllQueueProcessed()` test helper
- **Keep** `isShareMode()` guard (don't trigger automation in share mode)
- **Add** `navigatorReady` flag to the context bridge. Listen for `dagnet:navigatorLoadComplete` event (via a `useEffect` with `addEventListener`). Push `navigatorReady: true` into `updateDailyAutomationContext()` when the event fires. If the event already fired before mount (check `window.__dagnetNavigatorLoadComplete`), set immediately.
- **Add** `navigatorReady` field to `DailyAutomationContext` interface (in dailyAutomationJob.ts)

The job's wait loop then checks `repo && navigatorReady && hasTabOps` instead of just `repo && hasTabOps`.

#### Step 3.2: Wire hook into AppShell.tsx

- Add import: `import { useURLDailyRetrieveAllQueue } from './hooks/useURLDailyRetrieveAllQueue';`
- Add call in `MainAppShellContent`: `useURLDailyRetrieveAllQueue();`
- No AutomationBanner needed — scheduler manages its own banner

#### Step 3.3: Verify boot with `?retrieveall`

Manual check in browser:

1. Open `http://localhost:5173/?retrieveall=test-graph&e2e=1`
2. Verify: zero tabs on screen
3. Verify: automation banner appears ("Automation running")
4. Verify: session log shows `DAILY_RETRIEVE_ALL_PRE_PULL`
5. Verify: pull happens (will fail without real credentials — that's fine, check the log)
6. Verify: no console errors related to missing imports or undefined references

#### Step 3.4: Verify normal boot is unaffected

1. Open `http://localhost:5173/` (no params)
2. Verify: saved tabs restore normally
3. Verify: `?graph=X` still opens a graph tab
4. Verify: no regressions in normal workflow

#### GATE 3: Wiring verified

1. App boots blank with `?retrieveall`
2. Automation job starts, shows banner, logs to session log
3. Pull step runs (may fail without real credentials — that's fine; session log should show `DAILY_RETRIEVE_ALL_PRE_PULL_FAILED` warning, not a crash)
4. Normal boot (no `?retrieveall`) is unaffected
5. `?graph=X` still works in normal mode
6. No console errors in either mode (session log warnings are expected, console errors are not)

---

### Phase 4: E2E TEST SUITE

**Objective:** Write all 6 Playwright E2E specs. These are the real tests — they run in a real browser with real IDB.

**File:** `e2e/retrieveallAutomation.spec.ts` (single file, 6 tests)

**Test infrastructure (shared across all tests):**

- `seedCredentials(page)` — seeds credentials file in IDB with `repo-1` / `main` / `fake-token`
- `seedWorkspace(page)` — seeds workspace record in IDB for `repo-1` / `main`
- `seedGraph(page, name, opts?)` — seeds a graph file (both prefixed and unprefixed variants) with optional `dailyFetch` flag
- `seedAppState(page)` — seeds app state with `repo-1` / `main` selected, zero tabs, no activeTabId
- `installStubs(page)` — stubs GitHub API (return empty tree for pull) and compute server (return success)
- `installWindowCloseSpy(page)` — `addInitScript` that replaces `window.close` with a spy

**Key difference from old E2E:** No tab is seeded. The app state has zero tabs and no activeTabId. This matches the spec ("start blank").

**GitHub API stub strategy:** The pull step calls `pullLatestRemoteWins` → `gitService` → GitHub API. The endpoints hit are:

1. `GET /repos/:owner/:repo/git/ref/heads/:branch` — returns `{ ref, object: { sha } }` (remote HEAD)
2. `GET /repos/:owner/:repo/git/trees/:sha?recursive=1` — returns `{ tree: [...] }` (file listing)
3. `GET /repos/:owner/:repo/git/blobs/:sha` — returns file content (only for changed files)

For E2E, stub all `https://api.github.com/**` routes. The simplest approach: return the SAME SHA that's already in the workspace record (simulating "already up to date" — no files changed). This means:
- Ref endpoint: return `{ ref: 'refs/heads/main', object: { sha: '<seeded-sha>', type: 'commit' } }`
- Tree endpoint: return `{ sha: '<seeded-sha>', tree: [] }` (empty tree — no changes)
- Blob endpoint: should never be called (no changes)

The existing `playwright.config.ts` provides `VITE_CREDENTIALS_JSON` with test tokens. The seeded workspace record must include a `lastSyncedSha` matching the stubbed ref SHA so the pull sees "already up to date".

**Asserting ordering from Playwright:** Playwright cannot intercept browser-internal CustomEvents. For tests that need to verify ordering (e.g. pull-before-tabs), use one of:
- **Session log ordering**: after automation completes, read session log entries via `page.evaluate()`. Assert `DAILY_RETRIEVE_ALL_PRE_PULL` appears before `DAILY_RETRIEVE_ALL_GRAPH_START`.
- **`addInitScript` monkey-patching**: inject a script that wraps `db.tabs.add` to record a timestamp, and compare against the GitHub API stub's call timestamp.

Prefer session log ordering — it's simpler and tests the real observable behaviour.

#### Test 1: Blank boot

```
test('starts with zero tabs before automation begins')
```
- Seed: credentials, workspace, one graph, app state (no tabs)
- Navigate: `?retrieveall=test-graph&e2e=1`
- Assert: poll for `window.__dagnetTabContextInitDone === true`
- Assert: `db.tabs.count() === 0` at the moment init completes (before automation job runs)
- Invariant: no tab state restored during boot

#### Test 2: Pull before tabs

```
test('pull completes before any graph tab is opened')
```
- Seed: credentials, workspace, one graph, app state
- Install stubs (GitHub API returns "up to date")
- Install window.close spy
- Navigate: `?retrieveall=test-graph&e2e=1`
- Wait for automation to complete (poll `__dagnetWindowCloseCalled`)
- Read session log entries via `page.evaluate(() => sessionLogService.getEntries())`
- Find indices of `DAILY_RETRIEVE_ALL_PRE_PULL` and `DAILY_RETRIEVE_ALL_GRAPH_START`
- Assert: pull index < graph-start index (pull logged before any graph processing began)
- Invariant: pull completes before any graph tab is opened

#### Test 3: Enumeration mode

```
test('enumeration mode processes only dailyFetch graphs')
```
- Seed: credentials, workspace, two graphs:
  - `graph-enabled` with `dailyFetch: true`
  - `graph-disabled` with `dailyFetch: false`
- Seed: app state
- Navigate: `?retrieveall&e2e=1` (no graph name — enumeration mode)
- Wait for automation to complete
- Read automation run log from IDB
- Assert: `log.graphs` contains only `['enabled']`
- Invariant: enumeration respects `dailyFetch` flag

#### Test 4: Explicit mode

```
test('explicit mode processes only named graphs')
```
- Seed: credentials, workspace, two graphs (`graph-a`, `graph-b`)
- Seed: app state
- Navigate: `?retrieveall=graph-a&e2e=1`
- Wait for automation to complete
- Read automation run log from IDB
- Assert: `log.graphs` equals `['graph-a']`
- Invariant: explicit mode processes only named graphs

#### Test 5: Window close

```
test('window.close() fires after completion and log is persisted')
```
- Seed: credentials, workspace, one graph, app state
- Install window.close spy
- Navigate: `?retrieveall=test-graph&e2e=1`
- Wait for `__dagnetWindowCloseCalled === true`
- Read automation run log from IDB
- Assert: log exists, has outcome, has graphs, has entries
- Invariant: window auto-closes and logs are persisted

#### Test 6: No-close mode

```
test('?noclose prevents window.close()')
```
- Seed: credentials, workspace, one graph, app state
- Install window.close spy
- Navigate: `?retrieveall=test-graph&e2e=1&noclose`
- Wait for automation to complete (poll for automation log in IDB — it's persisted before the close decision)
- Wait an additional 2 seconds
- Assert: `__dagnetWindowCloseCalled` is NOT true
- Invariant: `?noclose` prevents auto-close

#### GATE 4: All E2E tests pass

Run: `cd graph-editor && CI= PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright" npm run -s e2e -- e2e/retrieveallAutomation.spec.ts --workers=1 --retries=0 --reporter=line --timeout=60000 --global-timeout=180000`

Note: generous timeouts because the automation includes app boot (~2-4s), wait-for-ready polling, and the full pull→retrieve→commit pipeline. The playwright config default is 120s per test.

All 6 tests must pass. If any fail:
- Read the failure output in full
- Fix the issue in the service/hook/TabContext code
- Re-run only the failing test
- Do not proceed until all 6 pass

---

### Phase 5: MANUAL SMOKE TEST

**Objective:** Verify the rebuilt automation works end-to-end with real credentials against a real repo.

#### Step 5.1: Enumeration mode

1. Open app normally, ensure at least one graph has `dailyFetch: true`
2. Close the tab
3. Navigate to `?retrieveall&noclose`
4. Observe:
   - App starts blank (no tabs)
   - Banner shows "Automation running"
   - Pull happens (check session log)
   - Graph(s) with `dailyFetch: true` are enumerated
   - Countdown runs (30s)
   - Per-graph: tab opens, retrieve runs, commit happens
   - Session log shows full hierarchy
   - Window stays open (`?noclose`)
5. Check automation run log: `dagnetAutomationLogs()` in console

#### Step 5.2: Explicit mode

1. Navigate to `?retrieveall=<graph-name>&noclose`
2. Observe same flow but for the specific graph only

#### Step 5.3: Window close (without `?noclose`)

1. Navigate to `?retrieveall=<graph-name>`
2. Observe automation runs and window closes after 10s on success

#### GATE 5: User confirms

User verifies:
- Blank boot (no tab restoration)
- Pull before tabs
- Correct graph targeting
- Retrieve + commit works
- Session log is complete
- Run log is persisted
- Window close / noclose both work

---

### Known Considerations (not bugs — documented for awareness)

1. **Stale IDB tabs persist after automation.** The automation opens graph tabs which persist to IDB. On next normal boot (without `?retrieveall`), `loadTabsFromDB()` restores them. This is acceptable — the operator sees the graphs that were automated. No cleanup needed.

2. **`?retrieveall` stays in URL during the run.** The URL is only cleaned in the finally block. If the user refreshes mid-automation, it re-triggers. Same behaviour as old code. Acceptable — automation runs are unattended.

3. **`?noclose` and `?e2e` are not cleaned from the URL.** Harmless — `?noclose` is only meaningful during automation, and `?e2e` only affects delay timings. Both are inert on normal boot.

4. **Boot-gated jobs may fire once before daily-automation registers its `suppress` list.** If `signalBootComplete()` fires before the daily-automation job is registered, boot-gated jobs (version-check, git-remote-check) may run once. They check `nc.suppressed` (set by `useStalenessNudges` on mount) and exit early. This is safe as long as `useStalenessNudges` has rendered before boot completes — which it does, because it's called in `AppShellContent` which renders before `useBootProgress` signals completion.

5. **Multi-graph commit ordering.** If graph A commits, then graph B's commit sees remote-ahead (because graph A just pushed), the commit retry pulls to resolve. This is a third pull (upfront + graph A commit-retry + graph B commit-retry in worst case). This is correct conflict-resolution behaviour, not a design flaw.

---

### Post-Rebuild Cleanup

After all gates pass:

1. **Update `AUTOMATION_PIPELINE.md`** — reflect the new flow (single upfront pull, no per-graph pull, `?noclose` param)
2. **Delete this spec's Part 2 and Part 3** — they document the old implementation which no longer exists
3. **Update `CLAUDE.md` Service Directory** — if any service names or test file paths changed
