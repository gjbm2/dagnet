# Job Scheduler — Codebase Architecture

**Last updated**: 18-Mar-26

## What it is

`jobSchedulerService` is the unified system for all automated/recurring/long-lived work in the app. It owns all timers (polling, countdowns, deadlines, debounce) and routes UI presentation through `operationRegistryService` (for OperationsToast) and `bannerManagerService` (for banners).

User-initiated operations (rename, fetch, commit, pull-all, etc.) continue to use `operationRegistryService` directly. The scheduler is for automated work only.

## Why it exists

Before the scheduler, the app had multiple overlapping scheduling/state systems: `countdownService`, `automationRunService`, `bannerManagerService`, `operationRegistryService` (used for both scheduling and display), `stalenessNudgeService`, `nonBlockingPullService`, `ukDayBoundarySchedulerService`, plus `setInterval`/`setTimeout` scattered across hooks. Each implemented its own timer management, boot-gating, and UI routing. The result was:

- Race condition in boot gate (event listener could miss the boot-done event)
- Duplicated timer management logic
- No centralised concurrency or suppression rules
- Automation pathways breaking silently when one system changed

## Key files

| File | Role |
|---|---|
| `src/services/jobSchedulerService.ts` | Core scheduler: registration, state machine, timer engine, boot latch, concurrency, suppression, pull lock, focus/visibility triggers, IDB persistence, UI routing |
| `src/services/stalenessNudgeJobs.ts` | Job definitions for version-check, git-remote-check, retrieve-nudge. Context bridge between React hooks and service-level scheduler |
| `src/services/dailyAutomationJob.ts` | Job definition for daily-automation (?retrieveall). Contains the full per-graph orchestration loop |
| `src/services/stalenessNudgeService.ts` | Pure decision logic (when is something stale?). No scheduling — called by job runFns |
| `src/hooks/useStalenessNudges.ts` | Thin React hook: registers jobs, updates context store, provides conflict modal |
| `src/hooks/useURLDailyRetrieveAllQueue.ts` | Thin React hook: parses URL params, calls scheduler.run() |
| `src/hooks/useBootProgress.ts` | Calls `jobSchedulerService.signalBootComplete()` when both TabContext and Navigator are ready |

## How it works

### Job lifecycle

```
idle --> [boot-waiting] --> scheduled --> [countdown] --> running --> complete | error | cancelled
                                              ^                          |
                                              +-------- (reschedule) ----+
```

### Scheduling patterns

- **periodic(intervalMs)** — deadline-based recurring timer. Resilient to background-tab throttling. Optional `triggerOnFocus` for re-evaluation on tab focus
- **countdown(durationSec)** — one-shot with visible countdown, pause/resume/cancel
- **deadline(getNextMs)** — fires at computed absolute time, then reschedules
- **debounced(idleMs)** — external code calls `trigger(jobId)` to reset; fires after idle period
- **reactive** — no timer; external code calls `run(jobId)`

### Boot coordination

Simple boolean latch. `signalBootComplete()` is called once from `useBootProgress`. Jobs with `bootGated: true` are parked until the latch opens. No event listeners, no window flags — race condition is structurally impossible.

On boot, persisted IDB jobs are reconciled BEFORE periodic jobs start firing, ensuring completed remote jobs (e.g. Bayes fits) have their post-completion pulls land first.

### UI routing

- `presentation: 'operation'` — writes to `operationRegistryService`, appears in OperationsToast
- `presentation: 'banner:app-update'` — persistent banner for new version
- `presentation: 'banner:automation'` — persistent banner for daily automation cycle
- `presentation: 'silent'` — session log only

### Concurrency and suppression

Jobs declare `suppress: ['job-id-1', ...]` to prevent other jobs from firing while they run. The daily-automation job suppresses auto-pull and retrieve-nudge.

Pull serialisation: `acquirePullLock(repo, branch)` ensures only one pull runs at a time per repo/branch. Multiple jobs that need to pull (auto-pull, daily-automation, Bayes post-completion) all go through this lock.

### IDB persistence

Jobs with `persistent: true` write state to `db.schedulerJobs` on key transitions. On boot, the scheduler reconciles stale records by calling the job definition's `reconcileFn`. Records older than 7 days are pruned.

## Registered jobs

| Job ID | Schedule | Boot-gated | Presentation | Registered by |
|---|---|---|---|---|
| `version-check` | periodic(10min), triggerOnFocus | yes | banner:app-update | stalenessNudgeJobs.ts |
| `git-remote-check` | periodic(30min), triggerOnFocus | yes | silent | stalenessNudgeJobs.ts |
| `retrieve-nudge` | reactive | yes | silent (manual ops) | stalenessNudgeJobs.ts |
| `daily-automation` | reactive | yes | banner:automation | dailyAutomationJob.ts |
| `uk-day-boundary` | deadline(midnight UK) | no | silent | ukDayBoundarySchedulerService.ts |
| `graph-integrity` | debounced(2s) | yes | silent | graphIssuesService.ts |

## Context bridge pattern

Scheduler jobs are service-level (no React context). React hooks that have context (repo, branch, share mode) write to a module-level context store on every render. Job runFns read from this store.

```
React hook render --> updateNudgeContext({ repo, branch, ... })
                                |
Scheduler job fires --> getNudgeContext() --> uses fresh values
```

This is the same pattern as `latestNavStateRef` in the old `useURLDailyRetrieveAllQueue`, but centralised and explicit.

## Adding a new job

1. Define the job in the appropriate service file (or create a new `*Job.ts` file)
2. Call `jobSchedulerService.registerJob({ id, schedule, bootGated, presentation, runFn, ... })`
3. If the job needs React context, use the context bridge pattern (module-level store + update function)
4. If the job can outlive a browser session, set `persistent: true` and provide a `reconcileFn`
5. Add the job to the table above and in `docs/current/job-scheduler-design.md`

## Legacy systems (still present, being migrated)

- `countdownService` — still used by share-live countdown, nonBlockingPullService, retrieveAllSlicesService. Will be absorbed into the scheduler as those consumers are migrated
- `automationRunService` — dead code (no consumers). Can be deleted
- `useAutomationRunState` — dead code. Can be deleted
- `useCountdown` / `useOperationCountdown` — still used by countdown consumers above
