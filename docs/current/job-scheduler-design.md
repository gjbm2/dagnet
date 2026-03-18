# Job Scheduler — Design Document

**Status**: Implementation in progress
**Date**: 18-Mar-26
**Problem**: Multiple overlapping scheduling/state systems (countdownService, automationRunService, bannerManagerService, operationRegistryService, stalenessNudgeService, nonBlockingPullService, ukDayBoundarySchedulerService, plus scattered setInterval/setTimeout) cause race conditions, duplicated logic, and regression-prone automation pathways. Since introducing the progress indicator, automation has regressed because there's no single system owning when and how jobs run.

**Solution**: One unified `jobSchedulerService` that owns all automated/recurring/long-lived work. It exposes state to UI through existing services (operationRegistryService for OperationsToast, bannerManagerService for exactly two banner types).

---

## Architecture

### Single source of truth

```
jobSchedulerService (owns all timers, scheduling, boot gating, concurrency)
       │
       ├──> operationRegistryService (OperationsToast) ──> OperationsToast.tsx
       │
       └──> bannerManagerService (2 banner types only) ──> BannerHost.tsx
                │
                ├── 'app-update' banner (new version available)
                └── 'automation' banner (daily retrieveall running)
```

User-initiated operations (rename, fetch, commit, pull-all, etc.) continue to write to operationRegistryService directly. The scheduler is for automated/recurring work only.

### What the scheduler owns

- All recurring timers (polling intervals, deadlines, debounce)
- All countdown timers (with pause/resume)
- Boot coordination (reliable latch, no race conditions)
- Job concurrency (singleton, cross-tab, keyed)
- Job suppression (daily-automation suppresses auto-pull, retrieve-nudge)
- Pull serialisation (one pull at a time per repo/branch)
- Focus/visibility-triggered re-evaluation
- IDB persistence for long-lived jobs (Bayes fits, daily automation)
- Boot reconciliation of persisted jobs

### What the scheduler does NOT own

- Business logic for staleness decisions (stays in stalenessNudgeService)
- Git/file/data operations (stay in their respective services)
- UI rendering (stays in OperationsToast, BannerHost, CountdownBanner)
- User-initiated operation tracking (stays in operationRegistryService)

---

## Job Definitions

| Job ID | Schedule | Boot-gated | Presentation | Persistent | Currently in |
|---|---|---|---|---|---|
| `boot` | reactive | no | operation | no | useBootProgress |
| `version-check` | periodic(10min), triggerOnFocus | yes | banner:app-update | no | useStalenessNudges |
| `git-remote-check` | periodic(30min), triggerOnFocus | yes | silent | no | useStalenessNudges |
| `auto-pull` | reactive | yes | operation (countdown) | no | nonBlockingPullService |
| `retrieve-nudge` | reactive | yes | operation (transient) | no | useStalenessNudges |
| `daily-automation` | reactive | yes | banner:automation | yes | useURLDailyRetrieveAllQueue |
| `uk-day-boundary` | deadline(midnight UK) | no | silent | no | ukDayBoundarySchedulerService |
| `health-check` | periodic(5min) | no | silent | no | useHealthStatus |
| `graph-integrity` | debounced(2s) | yes | silent | no | graphIssuesService |
| `bayes-fit` | reactive | yes | operation | yes | useBayesTrigger |

---

## Scheduling Patterns

### periodic(intervalMs)

Deadline-based recurring timer. Stores `nextFireAtMs = Date.now() + intervalMs` and uses adaptive setTimeout. Resilient to background-tab throttling (browsers clamp setTimeout in background tabs; absolute deadline means we catch up immediately when the tab regains focus).

Never uses `setInterval` — each invocation schedules the next via setTimeout from the completion time. This prevents pile-up when jobs take longer than the interval.

Optional `triggerOnFocus: true` causes the job to re-evaluate on tab focus/visibility change, subject to rate-limiting.

### countdown(durationSeconds)

One-shot delayed execution with visible countdown. User can cancel (veto), pause, or resume. Countdown ticks use the same deadline-based approach as countdownService (absolute `countdownDeadlineMs`, recalculated on each tick).

### deadline(getNextDeadlineMs)

Fires at a computed absolute time, then calls `getNextDeadlineMs()` to schedule the next. Individual setTimeout calls are capped at 6 hours (to handle system sleep); the timer re-evaluates and re-schedules with remaining time on each wake.

### debounced(idleMs, maxWaitMs?)

Not auto-fired. External code calls `scheduler.trigger(jobId)` to reset the debounce timer. Fires after `idleMs` of no triggers. Optional `maxWaitMs` caps total wait from first trigger.

### reactive

No timer. External code calls `scheduler.run(jobId, params?)`. The scheduler manages lifecycle state, boot gating, concurrency, suppression, and UI routing.

---

## Job Lifecycle

```
idle --> [boot-waiting] --> scheduled --> [countdown] --> running --> complete | error | cancelled
                                              ^                          |
                                              +-------- (reschedule) ----+
```

- Periodic/deadline jobs reschedule after completion
- Concurrency guard: runFn never invoked concurrently with itself
- Rate-limit: configurable minimum interval between invocations

---

## Boot Coordination

**Problem**: The old boot gate used `window.__dagnetTabContextInitDone` (a flag on window) plus a `dagnet:tabContextInitDone` CustomEvent. If the event fires before the listener registers, it's missed. The flag check is a fallback, but hooks may not re-render to check it.

**Solution**: Simple boolean latch inside the scheduler.

- `signalBootComplete()` called from `useBootProgress` when both TabContext and Navigator are done
- Jobs with `bootGated: true` are parked in `boot-waiting` until the latch opens
- No event listener needed, no window flag dependency — latch is synchronous and race-free
- Boot reconciliation of persisted IDB jobs runs during `signalBootComplete()`, BEFORE periodic jobs start firing

---

## Concurrency and Interference

### Concurrency modes

- `singleton` — at most one instance running. Duplicate triggers: skip or cancel-replace
- `singleton:cross-tab` — Web Locks API enforcement across tabs
- `keyed(keyFn)` — one instance per key (e.g. one bayes-fit per graph)
- `unrestricted` — multiple concurrent instances allowed

### Suppression rules

| Running job | Suppressed jobs | Reason |
|---|---|---|
| `daily-automation` | `auto-pull`, `retrieve-nudge` | Automation does its own pulls and retrieves |
| `daily-automation` | `version-check` (banner only) | Automation checks version per-graph internally |

Suppressed jobs are skipped (not queued). They re-evaluate on the next polling cycle.

### Pull serialisation

All jobs that pull from git go through `acquirePullLock(repo, branch)`. Only one pull runs at a time per repo/branch. If daily-automation is running (holding the lock for its full duration), other pull requests queue behind it.

This replaces the ad-hoc `isNonBlockingPullActive()` guard.

### Interference matrix

| Scenario | Behaviour |
|---|---|
| Bayes fit (remote) + daily-automation | Allow both — Bayes runs on Modal, automation runs locally |
| Bayes post-completion pull + daily-automation | Serialise via pull lock |
| Boot reconciliation + daily-automation | Reconciliation runs first (before periodic jobs drain) |
| Stale persisted daily-automation (>12h) + new run | Supersede old record |
| Stale persisted bayes-fit + new fit (same graph) | Reconcile old job first, then allow new |

---

## IDB Persistence

Jobs marked `persistent: true` have their state written to IDB on key transitions.

**IDB table**: `schedulerJobs` in appDatabase.ts

Fields: jobId, jobDefId, status, params, submittedAtMs, lastUpdatedAtMs, result, error

**Boot reconciliation sequence**:
1. Query IDB for `submitted` or `running` records
2. Call job definition's `reconcileFn(record)` — polls external state
3. If completed: surface outcome via operationRegistryService, queue post-completion pull if needed
4. If still running: resume polling
5. After reconciliation: drain boot-waiting periodic jobs

Records older than 7 days are pruned automatically.

---

## Test Coverage Strategy

### Guiding principle

The scheduler is the single system driving all automation. If it breaks, automation pathways break silently — exactly the regression that motivated this work. Tests must catch **real integration bugs**, not just verify mocked interfaces.

### Test tiers

**Tier 1: Scheduler engine integration tests** (fake-indexeddb, vi.useFakeTimers)

These test the scheduler's internal mechanics with real timer simulation. No mocking of the scheduler itself — test the actual scheduling, state transitions, and UI routing.

Invariants to protect:
- Periodic job fires at the configured interval (advance timers, verify execution count)
- Deadline job fires at the deadline (not before, not missed after sleep simulation)
- Debounced job resets on re-trigger, fires after idle period, respects maxWaitMs cap
- Countdown ticks down accurately, pauses/resumes correctly, fires on expiry
- Boot-gated jobs do not fire before signalBootComplete()
- Boot-gated jobs fire after signalBootComplete() without needing additional triggers
- Rate-limited jobs skip invocations that are too close together
- Singleton concurrency prevents double-execution
- Cancel mid-run: shouldAbort() returns true, job transitions to cancelled

**Tier 2: UI routing integration tests** (real operationRegistryService + bannerManagerService)

These test that the scheduler correctly writes into the existing UI services. Use real service instances (not mocked).

Invariants to protect:
- Operation-presentation job creates an operation in the registry on run, completes it on finish
- Countdown-presentation job creates a countdown operation, ticks update registry, expiry transitions to running
- Banner-presentation job sets the correct banner, clears it on completion
- Suppressed banners are not set even when the job runs
- Silent jobs produce no registry or banner entries

**Tier 3: Concurrency and interference integration tests**

These test multi-job interactions with real async execution.

Invariants to protect:
- When daily-automation is running, auto-pull trigger is skipped
- When daily-automation is running, version-check runs but its banner is suppressed
- Pull lock serialises concurrent pulls (two jobs trying to pull simultaneously: second waits)
- Singleton job: second trigger while first is running is skipped

**Tier 4: IDB persistence integration tests** (fake-indexeddb)

Invariants to protect:
- Persistent job writes record to IDB on submission, updates on completion
- Boot reconciliation finds stale records, calls reconcileFn, surfaces outcomes
- Reconciliation runs before periodic jobs start (ordering test)
- Records older than 7 days are pruned
- Non-persistent jobs do NOT write to IDB

**Tier 5: Migration smoke tests** (per-phase)

After each migration phase, a smoke test that:
- Registers the actual production job definitions (or close approximations)
- Simulates the boot sequence
- Verifies the job fires and produces the expected UI output
- These catch wiring bugs between the scheduler and the services it calls

### What NOT to test

- The business logic inside runFn (that's tested in the existing service tests)
- The UI rendering of OperationsToast/BannerHost (that's React component testing)
- External API calls (mocked at the service boundary as usual)

### Test file locations

- `graph-editor/src/services/__tests__/jobSchedulerService.test.ts` — Tiers 1-4
- Tier 5 smoke tests live alongside the migration in each phase's modified test files

---

## Migration Phases

### Phase 0 — Foundation
Create jobSchedulerService with core engine. Write Tier 1-4 tests. No behaviour change.

### Phase 1 — Simple pollers
Migrate ukDayBoundary, healthCheck, graphIssues timers. Low risk, self-contained.

### Phase 2 — Boot coordination
signalBootComplete() from useBootProgress. Fix the race condition.

### Phase 3 — Countdown and staleness
Migrate auto-pull countdown, version-check, git-remote-check. Slim useStalenessNudges. Remove countdownService.

### Phase 4 — Daily automation
Migrate useURLDailyRetrieveAllQueue. Remove automationRunService.

### Phase 5 — IDB persistence and Bayes
Add schedulerJobs table. Implement persistence lifecycle and boot reconciliation. Migrate useBayesTrigger.

### Phase 6 — Cleanup
Remove dead code, update tests, final verification.

---

## Files Reference

| File | Role |
|---|---|
| `src/services/jobSchedulerService.ts` | The unified scheduler (new) |
| `src/services/operationRegistryService.ts` | UI sink for operations (preserved) |
| `src/services/bannerManagerService.ts` | UI sink for banners (preserved, restricted to 2 IDs) |
| `src/services/stalenessNudgeService.ts` | Decision logic (preserved, scheduling removed) |
| `src/hooks/useStalenessNudges.ts` | Simplified to ~60 lines |
| `src/hooks/useURLDailyRetrieveAllQueue.ts` | Simplified to ~40 lines |
| `src/hooks/useBootProgress.ts` | Gains signalBootComplete() call |
| `src/services/countdownService.ts` | Removed (absorbed into scheduler) |
| `src/services/automationRunService.ts` | Removed (absorbed into scheduler) |
| `src/db/appDatabase.ts` | Gains schedulerJobs table |
