/**
 * Job Scheduler Service
 *
 * Unified system for all automated/recurring/long-lived work in the app.
 * Owns all timers (polling, countdowns, deadlines, debounce).
 * Routes UI presentation through operationRegistryService and bannerManagerService.
 *
 * Observable via useSyncExternalStore (same pattern as operationRegistryService).
 *
 * User-initiated operations (rename, fetch, commit, etc.) continue to use
 * operationRegistryService directly — the scheduler is for automated work only.
 */

import { operationRegistryService } from './operationRegistryService';
import type { OperationProgress, OperationSubStep } from './operationRegistryService';
import { bannerManagerService } from './bannerManagerService';
import { sessionLogService } from './sessionLogService';
import { db } from '../db/appDatabase';
import type { SchedulerJobRecord } from '../db/appDatabase';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobPhase =
  | 'idle'
  | 'boot-waiting'
  | 'scheduled'
  | 'countdown'
  | 'running'
  | 'complete'
  | 'error'
  | 'cancelled';

export type ScheduleType =
  | { type: 'periodic'; intervalMs: number; triggerOnFocus?: boolean }
  | { type: 'countdown'; durationSeconds: number }
  | { type: 'deadline'; getNextDeadlineMs: () => number }
  | { type: 'debounced'; idleMs: number; maxWaitMs?: number }
  | { type: 'reactive' };

export type PresentationType =
  | 'operation'
  | 'banner:app-update'
  | 'banner:automation'
  | 'silent';

export type ConcurrencyMode =
  | { mode: 'singleton'; onDuplicate?: 'skip' | 'cancel-replace' }
  | { mode: 'singleton:cross-tab'; lockName: string; onDuplicate?: 'skip' | 'cancel-replace' }
  | { mode: 'keyed'; keyFn: (params?: Record<string, unknown>) => string; onDuplicate?: 'skip' | 'cancel-replace' | 'queue' }
  | { mode: 'unrestricted' };

export interface BannerSpec {
  label: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  actionTitle?: string;
}

export interface JobContext {
  shouldAbort: () => boolean;
  setProgress: (current: number, total: number, detail?: string) => void;
  setLabel: (label: string) => void;
  setSubSteps: (steps: OperationSubStep[]) => void;
  showBanner: (spec: BannerSpec) => void;
  clearBanner: () => void;
  /** Acquire a pull lock for a repo/branch. Returns a release function. */
  acquirePullLock: (repo: string, branch: string) => Promise<() => void>;
  /** Access to the scheduler for triggering other jobs (e.g. auto-pull from git-check). */
  scheduler: Pick<JobSchedulerService, 'run' | 'cancel' | 'getJobState' | 'isJobSuppressed'>;
  /** Params passed to run(). */
  params?: Record<string, unknown>;
}

export interface JobDefinition {
  id: string;
  schedule: ScheduleType;
  bootGated?: boolean;
  runFn: (ctx: JobContext) => Promise<void>;
  presentation: PresentationType;
  operationKind?: string;
  operationLabel?: string;
  concurrency?: ConcurrencyMode;
  /** Rate-limit: minimum ms between invocations, regardless of schedule. */
  rateLimitMs?: number;
  /** Job IDs to suppress while this job is running. */
  suppress?: string[];
  /** Job IDs whose banners to suppress while this job is running. */
  suppressBannerFor?: string[];
  /** If true, job state is persisted to IDB for boot reconciliation. */
  persistent?: boolean;
  /** Called on boot for persisted jobs found in submitted/running state. */
  reconcileFn?: (record: PersistedJobRecord) => Promise<ReconcileResult>;
}

export interface PersistedJobRecord {
  jobId: string;
  jobDefId: string;
  status: 'submitted' | 'running' | 'complete' | 'error' | 'cancelled';
  params?: Record<string, unknown>;
  submittedAtMs: number;
  lastUpdatedAtMs: number;
  result?: unknown;
  error?: string;
}

export interface ReconcileResult {
  /** New status after reconciliation. */
  status: 'complete' | 'error' | 'running';
  /** If complete, optional result data. */
  result?: unknown;
  /** If error, optional error message. */
  error?: string;
  /** If complete and needs a pull, provide repo/branch. */
  pullAfter?: { repo: string; branch: string };
  /** Label for the operation toast on completion. */
  label?: string;
}

export interface JobState {
  id: string;
  phase: JobPhase;
  label?: string;
  countdownSecondsRemaining?: number;
  countdownTotalSeconds?: number;
  countdownPaused?: boolean;
  progress?: OperationProgress;
  error?: string;
  lastRunAtMs?: number;
  params?: Record<string, unknown>;
}

export interface JobSchedulerState {
  jobs: Map<string, JobState>;
  bootComplete: boolean;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface InternalJob {
  def: JobDefinition;
  state: JobState;
  timerId?: number;
  /** Absolute ms when the next fire is due (for deadline-based timers). */
  nextFireAtMs?: number;
  /** For debounced: first trigger time (for maxWaitMs cap). */
  debounceFirstTriggerAtMs?: number;
  /** Whether runFn is currently executing. */
  isRunning: boolean;
  /** Set to true when cancel is requested during a run. */
  abortRequested: boolean;
  /** Countdown deadline (epoch ms) for resilient tick tracking. */
  countdownDeadlineMs?: number;
  /** Countdown runId to ignore stale tick callbacks. */
  countdownRunId: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

type SchedulerListener = () => void;

class JobSchedulerService {
  private static instance: JobSchedulerService;

  static getInstance(): JobSchedulerService {
    if (!JobSchedulerService.instance) {
      JobSchedulerService.instance = new JobSchedulerService();
    }
    return JobSchedulerService.instance;
  }

  private jobs = new Map<string, InternalJob>();
  private listeners = new Set<SchedulerListener>();
  private version = 0;
  private cachedVersion = -1;
  private cachedState: JobSchedulerState = { jobs: new Map(), bootComplete: false };

  private _bootComplete = false;
  private _disposed = false;

  // Pull locks: one promise chain per repo-branch key.
  private pullLocks = new Map<string, Promise<void>>();

  // Focus/visibility listener refs (for cleanup).
  private focusHandler: (() => void) | null = null;
  private visibilityHandler: (() => void) | null = null;
  private focusListenersInstalled = false;

  // ---- Observable contract ------------------------------------------------

  subscribe(listener: SchedulerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): JobSchedulerState {
    if (this.cachedVersion === this.version) return this.cachedState;

    const jobs = new Map<string, JobState>();
    for (const [id, ij] of this.jobs) {
      jobs.set(id, { ...ij.state });
    }

    this.cachedState = { jobs, bootComplete: this._bootComplete };
    this.cachedVersion = this.version;
    return this.cachedState;
  }

  private emit(): void {
    this.version += 1;
    for (const l of this.listeners) l();
  }

  // ---- Registration -------------------------------------------------------

  registerJob(def: JobDefinition): void {
    if (this.jobs.has(def.id)) {
      // Re-registration: update definition but preserve state.
      const existing = this.jobs.get(def.id)!;
      existing.def = def;
      return;
    }

    const initialPhase: JobPhase =
      def.bootGated && !this._bootComplete ? 'boot-waiting' : 'idle';

    const ij: InternalJob = {
      def,
      state: {
        id: def.id,
        phase: initialPhase,
        label: def.operationLabel,
      },
      isRunning: false,
      abortRequested: false,
      countdownRunId: 0,
    };

    this.jobs.set(def.id, ij);
    this.emit();

    // If boot is already complete and job is not boot-gated, schedule it.
    if (initialPhase === 'idle') {
      this.scheduleJob(ij);
    }

    // Install focus/visibility listeners on first registration of a focus-triggered job.
    if (def.schedule.type === 'periodic' && def.schedule.triggerOnFocus && !this.focusListenersInstalled) {
      this.installFocusListeners();
    }
  }

  // ---- Boot coordination --------------------------------------------------

  signalBootComplete(): void {
    if (this._bootComplete) return;
    this._bootComplete = true;

    sessionLogService.debug('session', 'SCHEDULER_BOOT_COMPLETE', 'Job scheduler: boot complete, reconciling persisted jobs then draining boot-waiting jobs');

    // Reconcile persisted IDB jobs BEFORE draining boot-waiting jobs.
    // This ensures completed remote jobs (e.g. Bayes) are surfaced and their
    // post-completion pulls land before periodic jobs (e.g. daily-automation) fire.
    // Hard timeout: reconciliation must not block boot forever.
    const RECONCILE_TIMEOUT_MS = 30_000;
    const reconcileWithTimeout = Promise.race([
      this.reconcilePersistedJobs(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Boot reconciliation timed out after 30s')), RECONCILE_TIMEOUT_MS)
      ),
    ]);

    void reconcileWithTimeout.then(() => {
      this.drainBootWaitingJobs();
    }).catch((err) => {
      // Reconciliation failure or timeout must not block boot-waiting jobs.
      const msg = err instanceof Error ? err.message : String(err);
      sessionLogService.warning('session', 'SCHEDULER_RECONCILE_TIMEOUT', `Boot reconciliation failed: ${msg} — draining boot-waiting jobs anyway`);
      this.drainBootWaitingJobs();
    });
  }

  private drainBootWaitingJobs(): void {
    for (const ij of this.jobs.values()) {
      if (ij.state.phase === 'boot-waiting') {
        ij.state = { ...ij.state, phase: 'idle' };
        this.scheduleJob(ij);
      }
    }
    this.emit();
  }

  get bootComplete(): boolean {
    return this._bootComplete;
  }

  // ---- IDB persistence (for long-lived jobs) ------------------------------

  /**
   * Persist a job's state to IDB. Called on key transitions for persistent jobs.
   * Fire-and-forget — never blocks the scheduler.
   */
  private persistJobToIDB(ij: InternalJob, status: SchedulerJobRecord['status'], result?: unknown, error?: string): void {
    if (!ij.def.persistent) return;

    const record: SchedulerJobRecord = {
      jobId: `${ij.def.id}:${ij.state.params ? JSON.stringify(ij.state.params) : ''}:${Date.now()}`,
      jobDefId: ij.def.id,
      status,
      params: ij.state.params,
      submittedAtMs: Date.now(),
      lastUpdatedAtMs: Date.now(),
      result,
      error,
    };

    // Use the instance ID if the runFn set one in params.
    if (ij.state.params?.jobInstanceId) {
      record.jobId = String(ij.state.params.jobInstanceId);
    }

    void db.schedulerJobs.put(record).catch((e) => {
      sessionLogService.warning('session', 'SCHEDULER_IDB_PERSIST_ERROR',
        `Failed to persist job ${record.jobId} to IDB: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  /**
   * Update a persisted job's status in IDB.
   */
  private updatePersistedJobStatus(jobInstanceId: string, status: SchedulerJobRecord['status'], result?: unknown, error?: string): void {
    void (async () => {
      const existing = await db.schedulerJobs.get(jobInstanceId);
      if (!existing) return;
      await db.schedulerJobs.update(jobInstanceId, {
        status,
        lastUpdatedAtMs: Date.now(),
        ...(result !== undefined ? { result } : {}),
        ...(error !== undefined ? { error } : {}),
      });
    })().catch((e) => {
      sessionLogService.warning('session', 'SCHEDULER_IDB_UPDATE_ERROR',
        `Failed to update persisted job ${jobInstanceId} in IDB: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  /**
   * Reconcile persisted jobs on boot. Runs BEFORE boot-waiting jobs are drained.
   */
  private async reconcilePersistedJobs(): Promise<void> {
    try {
      // Find all jobs with status 'submitted' or 'running'.
      const staleJobs = await db.schedulerJobs
        .where('status')
        .anyOf('submitted', 'running')
        .toArray();

      if (staleJobs.length === 0) return;

      sessionLogService.debug('session', 'SCHEDULER_RECONCILE_START',
        `Reconciling ${staleJobs.length} persisted job(s)`, undefined,
        { jobIds: staleJobs.map(j => j.jobId) });

      for (const record of staleJobs) {
        const jobDef = this.getJobDefById(record.jobDefId);
        if (!jobDef?.reconcileFn) {
          // No reconcile function — mark as error:stale.
          const ageHours = (Date.now() - record.submittedAtMs) / (60 * 60 * 1000);
          await db.schedulerJobs.update(record.jobId, {
            status: 'error',
            error: `Stale job (${ageHours.toFixed(1)}h old, no reconcileFn)`,
            lastUpdatedAtMs: Date.now(),
          });
          continue;
        }

        try {
          const result = await jobDef.reconcileFn(record as any);

          await db.schedulerJobs.update(record.jobId, {
            status: result.status === 'running' ? 'running' : result.status,
            lastUpdatedAtMs: Date.now(),
            ...(result.result !== undefined ? { result: result.result } : {}),
            ...(result.error !== undefined ? { error: result.error } : {}),
          });

          // Surface outcome via operationRegistryService.
          if (result.status === 'complete' || result.status === 'error') {
            const label = result.label ?? `${record.jobDefId} ${result.status}`;
            operationRegistryService.register({
              id: `reconciled:${record.jobId}`,
              kind: record.jobDefId,
              label,
              status: result.status === 'complete' ? 'running' : 'running',
            });
            operationRegistryService.complete(
              `reconciled:${record.jobId}`,
              result.status === 'complete' ? 'complete' : 'error',
              result.error,
            );
          }

          // Post-completion pull if needed.
          if (result.pullAfter) {
            const release = await this.acquirePullLock(result.pullAfter.repo, result.pullAfter.branch);
            try {
              const repoOps = await import('./repositoryOperationsService');
              await repoOps.repositoryOperationsService.pullLatest(result.pullAfter.repo, result.pullAfter.branch);
            } finally {
              release();
            }
          }

          // If still running, resume polling as a sub-task (job-specific logic).
          if (result.status === 'running') {
            sessionLogService.debug('session', 'SCHEDULER_RECONCILE_RESUME',
              `Job ${record.jobId} still running remotely — will resume polling when job is triggered`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await db.schedulerJobs.update(record.jobId, {
            status: 'error',
            error: `Reconciliation failed: ${msg}`,
            lastUpdatedAtMs: Date.now(),
          });
          sessionLogService.error('session', 'SCHEDULER_RECONCILE_ERROR',
            `Reconciliation failed for ${record.jobId}: ${msg}`);
        }
      }

      // Prune records older than 7 days.
      const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const old = await db.schedulerJobs
        .where('submittedAtMs')
        .below(cutoffMs)
        .toArray();
      if (old.length > 0) {
        await db.schedulerJobs.bulkDelete(old.map(j => j.jobId));
      }

      sessionLogService.debug('session', 'SCHEDULER_RECONCILE_DONE',
        `Reconciliation complete (${staleJobs.length} job(s) processed, ${old.length} pruned)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sessionLogService.error('session', 'SCHEDULER_RECONCILE_FAILED',
        `Boot reconciliation failed: ${msg}`);
    }
  }

  private getJobDefById(defId: string): JobDefinition | undefined {
    const ij = this.jobs.get(defId);
    return ij?.def;
  }

  // ---- Triggering ---------------------------------------------------------

  /**
   * Manually trigger a reactive job (or force-fire any job).
   * For keyed concurrency, pass params with the key field.
   */
  run(jobId: string, params?: Record<string, unknown>): void {
    const ij = this.jobs.get(jobId);
    if (!ij) return;

    // Boot gate check.
    if (ij.def.bootGated && !this._bootComplete) {
      ij.state = { ...ij.state, phase: 'boot-waiting', params };
      this.emit();
      return;
    }

    // Suppression check.
    if (this.isJobSuppressed(jobId)) {
      sessionLogService.debug('session', 'SCHEDULER_JOB_SUPPRESSED', `Job ${jobId} suppressed by running job`, undefined, { jobId });
      return;
    }

    // Concurrency check.
    if (ij.isRunning && ij.def.concurrency?.mode !== 'unrestricted') {
      const onDup = (ij.def.concurrency as any)?.onDuplicate ?? 'skip';
      if (onDup === 'skip') return;
      if (onDup === 'cancel-replace') {
        ij.abortRequested = true;
        // The running instance will check shouldAbort() and exit.
        // We'll re-trigger after it finishes (handled in executeJob finally block).
        ij.state = { ...ij.state, params };
        return;
      }
    }

    // Rate-limit check.
    if (ij.def.rateLimitMs && ij.state.lastRunAtMs) {
      const elapsed = Date.now() - ij.state.lastRunAtMs;
      if (elapsed < ij.def.rateLimitMs) return;
    }

    // Countdown-schedule jobs go through countdown first.
    if (ij.def.schedule.type === 'countdown') {
      this.startCountdown(ij, ij.def.schedule.durationSeconds, params);
      return;
    }

    void this.executeJob(ij, params);
  }

  /**
   * Reset the debounce timer for a debounced job.
   */
  trigger(jobId: string): void {
    const ij = this.jobs.get(jobId);
    if (!ij || ij.def.schedule.type !== 'debounced') return;

    if (ij.def.bootGated && !this._bootComplete) return;

    const schedule = ij.def.schedule;
    const now = Date.now();

    // Track first trigger for maxWaitMs cap.
    if (!ij.debounceFirstTriggerAtMs) {
      ij.debounceFirstTriggerAtMs = now;
    }

    // If maxWaitMs cap reached, fire immediately.
    if (schedule.maxWaitMs && (now - ij.debounceFirstTriggerAtMs) >= schedule.maxWaitMs) {
      ij.debounceFirstTriggerAtMs = undefined;
      void this.executeJob(ij);
      return;
    }

    // Reset the debounce timer.
    this.clearTimer(ij);
    ij.nextFireAtMs = now + schedule.idleMs;
    ij.state = { ...ij.state, phase: 'scheduled' };
    this.scheduleTimer(ij, schedule.idleMs);
    this.emit();
  }

  /**
   * Cancel a running or countdown job.
   */
  cancel(jobId: string): void {
    const ij = this.jobs.get(jobId);
    if (!ij) return;

    this.clearTimer(ij);
    ij.abortRequested = true;

    if (ij.state.phase === 'countdown') {
      ij.state = { ...ij.state, phase: 'cancelled' };
      this.routeUIUpdate(ij, 'cancelled');
      this.onJobTerminal(ij);
      this.emit();
    }
    // If running, the runFn will check shouldAbort() and exit.
  }

  /**
   * Pause a countdown.
   */
  pause(jobId: string): void {
    const ij = this.jobs.get(jobId);
    if (!ij || ij.state.phase !== 'countdown') return;

    this.clearTimer(ij);
    ij.state = { ...ij.state, countdownPaused: true };
    this.routeCountdownTick(ij);
    this.emit();
  }

  /**
   * Resume a paused countdown.
   */
  resume(jobId: string): void {
    const ij = this.jobs.get(jobId);
    if (!ij || ij.state.phase !== 'countdown' || !ij.state.countdownPaused) return;

    const remaining = ij.state.countdownSecondsRemaining;
    if (remaining == null || remaining <= 0) {
      // Countdown already expired while paused — fire immediately.
      void this.executeJob(ij);
      return;
    }

    // Reset the deadline based on remaining seconds.
    ij.countdownDeadlineMs = Date.now() + remaining * 1000;
    ij.state = { ...ij.state, countdownPaused: false };
    ij.countdownRunId += 1;
    this.scheduleCountdownTick(ij, ij.countdownRunId);
    this.routeCountdownTick(ij);
    this.emit();
  }

  // ---- State inspection ---------------------------------------------------

  getJobState(jobId: string): JobState | undefined {
    const ij = this.jobs.get(jobId);
    return ij ? { ...ij.state } : undefined;
  }

  isJobSuppressed(jobId: string): boolean {
    for (const ij of this.jobs.values()) {
      if (!ij.isRunning) continue;
      if (ij.def.suppress?.includes(jobId)) return true;
    }
    return false;
  }

  isBannerSuppressed(jobId: string): boolean {
    for (const ij of this.jobs.values()) {
      if (!ij.isRunning) continue;
      if (ij.def.suppressBannerFor?.includes(jobId)) return true;
    }
    return false;
  }

  // ---- Pull lock ----------------------------------------------------------

  async acquirePullLock(repo: string, branch: string): Promise<() => void> {
    const key = `${repo}:${branch}`;

    // Chain onto any existing lock for this key.
    const existing = this.pullLocks.get(key) ?? Promise.resolve();

    let releaseFn!: () => void;
    const newLock = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });

    // The new lock starts after the existing one completes.
    const chained = existing.then(() => newLock);
    this.pullLocks.set(key, chained);

    // Wait for the existing lock to release before returning.
    await existing;

    return releaseFn;
  }

  // ---- Teardown -----------------------------------------------------------

  dispose(): void {
    this._disposed = true;
    for (const ij of this.jobs.values()) {
      this.clearTimer(ij);
    }
    this.jobs.clear();
    this.listeners.clear();
    this.pullLocks.clear();
    this.removeFocusListeners();
    this._bootComplete = false;
    this.version = 0;
    this.cachedVersion = -1;
    this.cachedState = { jobs: new Map(), bootComplete: false };
  }

  /** Reset for tests — clears all state without permanent disposal. */
  _reset(): void {
    this.dispose();
    this._disposed = false;
  }

  // ---- Internal: scheduling -----------------------------------------------

  private scheduleJob(ij: InternalJob): void {
    const { schedule } = ij.def;

    switch (schedule.type) {
      case 'periodic': {
        // Fire immediately on first schedule, then set up interval.
        ij.state = { ...ij.state, phase: 'scheduled' };
        ij.nextFireAtMs = Date.now() + schedule.intervalMs;
        // Fire immediately for the first run.
        void this.executeJob(ij);
        break;
      }
      case 'deadline': {
        const nextMs = schedule.getNextDeadlineMs();
        const delayMs = Math.max(0, nextMs - Date.now());
        // Cap individual setTimeout at 6 hours to handle sleep/throttling.
        const cappedDelay = Math.min(delayMs, 6 * 60 * 60 * 1000);
        ij.nextFireAtMs = nextMs;
        ij.state = { ...ij.state, phase: 'scheduled' };
        this.scheduleTimer(ij, cappedDelay);
        break;
      }
      case 'debounced':
        // Debounced jobs wait for trigger() calls.
        ij.state = { ...ij.state, phase: 'idle' };
        break;
      case 'reactive':
        // Reactive jobs wait for run() calls.
        ij.state = { ...ij.state, phase: 'idle' };
        break;
      case 'countdown':
        // Countdown jobs wait for run() calls, then show countdown.
        ij.state = { ...ij.state, phase: 'idle' };
        break;
    }

    this.emit();
  }

  private reschedulePeriodicJob(ij: InternalJob): void {
    if (ij.def.schedule.type !== 'periodic') return;

    const intervalMs = ij.def.schedule.intervalMs;
    ij.nextFireAtMs = Date.now() + intervalMs;
    ij.state = { ...ij.state, phase: 'scheduled' };
    this.scheduleTimer(ij, intervalMs);
    this.emit();
  }

  private rescheduleDeadlineJob(ij: InternalJob): void {
    if (ij.def.schedule.type !== 'deadline') return;

    const nextMs = ij.def.schedule.getNextDeadlineMs();
    const delayMs = Math.max(0, nextMs - Date.now());
    const cappedDelay = Math.min(delayMs, 6 * 60 * 60 * 1000);
    ij.nextFireAtMs = nextMs;
    ij.state = { ...ij.state, phase: 'scheduled' };
    this.scheduleTimer(ij, cappedDelay);
    this.emit();
  }

  // ---- Internal: timer management -----------------------------------------

  private scheduleTimer(ij: InternalJob, delayMs: number): void {
    this.clearTimer(ij);

    if (this._disposed) return;

    ij.timerId = window.setTimeout(() => {
      ij.timerId = undefined;

      // For deadline jobs, check if we've actually reached the deadline
      // (timer may have been capped at 6h).
      if (ij.def.schedule.type === 'deadline' && ij.nextFireAtMs) {
        if (Date.now() < ij.nextFireAtMs) {
          // Not yet — reschedule with remaining time.
          const remaining = ij.nextFireAtMs - Date.now();
          const cappedDelay = Math.min(remaining, 6 * 60 * 60 * 1000);
          this.scheduleTimer(ij, cappedDelay);
          return;
        }
      }

      // For debounced jobs, clear the first trigger tracker.
      if (ij.def.schedule.type === 'debounced') {
        ij.debounceFirstTriggerAtMs = undefined;
      }

      void this.executeJob(ij);
    }, delayMs) as unknown as number;
  }

  private clearTimer(ij: InternalJob): void {
    if (ij.timerId !== undefined) {
      window.clearTimeout(ij.timerId);
      ij.timerId = undefined;
    }
  }

  // ---- Internal: countdown ------------------------------------------------

  private startCountdown(ij: InternalJob, durationSeconds: number, params?: Record<string, unknown>): void {
    const seconds = Math.max(0, Math.floor(durationSeconds));

    ij.countdownRunId += 1;
    const runId = ij.countdownRunId;
    ij.countdownDeadlineMs = Date.now() + seconds * 1000;

    ij.state = {
      ...ij.state,
      phase: 'countdown',
      countdownSecondsRemaining: seconds,
      countdownTotalSeconds: seconds,
      countdownPaused: false,
      params,
    };

    this.routeUIUpdate(ij, 'countdown');
    this.routeCountdownTick(ij);
    this.emit();

    if (seconds <= 0) {
      // Fire immediately.
      queueMicrotask(() => void this.executeJob(ij, params));
      return;
    }

    this.scheduleCountdownTick(ij, runId);
  }

  private scheduleCountdownTick(ij: InternalJob, runId: number): void {
    this.clearTimer(ij);

    if (this._disposed) return;

    ij.timerId = window.setTimeout(() => {
      ij.timerId = undefined;

      // Stale tick guard.
      if (ij.countdownRunId !== runId) return;
      if (ij.state.phase !== 'countdown' || ij.state.countdownPaused) return;

      const deadline = ij.countdownDeadlineMs;
      const remaining = deadline
        ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
        : Math.max(0, (ij.state.countdownSecondsRemaining ?? 0) - 1);

      if (remaining <= 0) {
        // Countdown expired — execute.
        void this.executeJob(ij, ij.state.params);
        return;
      }

      if (remaining !== ij.state.countdownSecondsRemaining) {
        ij.state = { ...ij.state, countdownSecondsRemaining: remaining };
        this.routeCountdownTick(ij);
        this.emit();
      }

      this.scheduleCountdownTick(ij, runId);
    }, 1000) as unknown as number;
  }

  // ---- Internal: job execution --------------------------------------------

  private async executeJob(ij: InternalJob, params?: Record<string, unknown>, opts?: { skipRateLimit?: boolean }): Promise<void> {
    if (this._disposed) return;

    // Suppression check at execution time.
    if (this.isJobSuppressed(ij.def.id)) {
      // Reschedule if periodic/deadline.
      this.onJobTerminal(ij);
      return;
    }

    // Rate-limit check (skipped for focus/visibility-triggered fires).
    if (!opts?.skipRateLimit && ij.def.rateLimitMs && ij.state.lastRunAtMs) {
      const elapsed = Date.now() - ij.state.lastRunAtMs;
      if (elapsed < ij.def.rateLimitMs) {
        this.onJobTerminal(ij);
        return;
      }
    }

    // Concurrency guard.
    if (ij.isRunning && ij.def.concurrency?.mode !== 'unrestricted') {
      return;
    }

    this.clearTimer(ij);

    ij.isRunning = true;
    ij.abortRequested = false;
    ij.state = {
      ...ij.state,
      phase: 'running',
      label: ij.def.operationLabel ?? ij.state.label,
      progress: undefined,
      error: undefined,
      params: params ?? ij.state.params,
    };

    this.routeUIUpdate(ij, 'running');
    this.persistJobToIDB(ij, 'running');
    this.emit();

    const ctx: JobContext = {
      shouldAbort: () => ij.abortRequested,
      setProgress: (current, total, detail) => {
        ij.state = {
          ...ij.state,
          progress: { current, total, detail },
        };
        this.routeProgressUpdate(ij);
        this.emit();
      },
      setLabel: (label) => {
        ij.state = { ...ij.state, label };
        this.routeLabelUpdate(ij);
        this.emit();
      },
      setSubSteps: (steps) => {
        if (ij.def.presentation === 'operation') {
          operationRegistryService.setSubSteps(ij.def.id, steps);
        }
      },
      showBanner: (spec) => {
        if (this.isBannerSuppressed(ij.def.id)) return;
        const bannerId = this.getBannerId(ij.def);
        if (!bannerId) return;
        bannerManagerService.setBanner({
          id: bannerId,
          priority: bannerId === 'automation' ? 100 : 60,
          ...spec,
        });
      },
      clearBanner: () => {
        const bannerId = this.getBannerId(ij.def);
        if (bannerId) bannerManagerService.clearBanner(bannerId);
      },
      acquirePullLock: (repo, branch) => this.acquirePullLock(repo, branch),
      scheduler: {
        run: (id, p) => this.run(id, p),
        cancel: (id) => this.cancel(id),
        getJobState: (id) => this.getJobState(id),
        isJobSuppressed: (id) => this.isJobSuppressed(id),
      },
      params: params ?? ij.state.params,
    };

    try {
      await ij.def.runFn(ctx);
      const terminalPhase = ij.abortRequested ? 'cancelled' : 'complete';
      ij.state = {
        ...ij.state,
        phase: terminalPhase,
        lastRunAtMs: Date.now(),
      };
      this.routeUIUpdate(ij, terminalPhase);
      this.persistJobToIDB(ij, terminalPhase === 'cancelled' ? 'cancelled' : 'complete');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ij.state = {
        ...ij.state,
        phase: 'error',
        error: message,
        lastRunAtMs: Date.now(),
      };
      this.routeUIUpdate(ij, 'error', message);
      this.persistJobToIDB(ij, 'error', undefined, message);

      sessionLogService.error('session', 'SCHEDULER_JOB_ERROR', `Job ${ij.def.id} failed: ${message}`, undefined, {
        jobId: ij.def.id,
        error: message,
      });
    } finally {
      ij.isRunning = false;
      this.onJobTerminal(ij);
      this.emit();
    }
  }

  /**
   * Called after a job reaches a terminal state (complete/error/cancelled)
   * or is skipped. Handles rescheduling for periodic/deadline jobs.
   */
  private onJobTerminal(ij: InternalJob): void {
    switch (ij.def.schedule.type) {
      case 'periodic':
        this.reschedulePeriodicJob(ij);
        break;
      case 'deadline':
        this.rescheduleDeadlineJob(ij);
        break;
      default:
        // Reactive, countdown, debounced: stay in terminal state or go idle.
        if (!ij.isRunning && ij.state.phase !== 'complete' && ij.state.phase !== 'error' && ij.state.phase !== 'cancelled') {
          ij.state = { ...ij.state, phase: 'idle' };
        }
        break;
    }
  }

  // ---- Internal: UI routing -----------------------------------------------

  private getBannerId(def: JobDefinition): string | null {
    if (def.presentation === 'banner:app-update') return 'app-update';
    if (def.presentation === 'banner:automation') return 'automation';
    return null;
  }

  private routeUIUpdate(ij: InternalJob, phase: string, error?: string): void {
    const { def, state } = ij;

    if (def.presentation === 'operation') {
      const opId = def.id;

      switch (phase) {
        case 'countdown': {
          // Register or update operation in countdown state.
          const existing = operationRegistryService.get(opId);
          if (!existing) {
            operationRegistryService.register({
              id: opId,
              kind: def.operationKind ?? def.id,
              label: state.label ?? def.operationLabel ?? def.id,
              status: 'countdown',
              cancellable: true,
              onCancel: () => this.cancel(def.id),
            });
          }
          if (state.countdownSecondsRemaining != null) {
            operationRegistryService.setCountdown(opId, state.countdownSecondsRemaining);
          }
          break;
        }
        case 'running': {
          const existing = operationRegistryService.get(opId);
          if (!existing) {
            operationRegistryService.register({
              id: opId,
              kind: def.operationKind ?? def.id,
              label: state.label ?? def.operationLabel ?? def.id,
              status: 'running',
            });
          } else {
            operationRegistryService.setStatus(opId, 'running');
            if (state.label) operationRegistryService.setLabel(opId, state.label);
          }
          break;
        }
        case 'complete':
          operationRegistryService.complete(opId, 'complete');
          break;
        case 'error':
          operationRegistryService.complete(opId, 'error', error);
          break;
        case 'cancelled':
          operationRegistryService.complete(opId, 'cancelled');
          break;
      }
    } else if (def.presentation === 'banner:app-update' || def.presentation === 'banner:automation') {
      const bannerId = this.getBannerId(def)!;

      switch (phase) {
        case 'complete':
        case 'error':
        case 'cancelled':
          // Don't auto-clear app-update banner on complete — it stays until user clicks reload.
          if (def.presentation !== 'banner:app-update') {
            bannerManagerService.clearBanner(bannerId);
          }
          break;
        // Banner updates for running/countdown are done via ctx.showBanner() in the runFn.
      }
    }
    // 'silent': no UI updates.
  }

  private routeCountdownTick(ij: InternalJob): void {
    if (ij.def.presentation === 'operation' && ij.state.countdownSecondsRemaining != null) {
      operationRegistryService.setCountdown(ij.def.id, ij.state.countdownSecondsRemaining);
      if (ij.state.countdownPaused) {
        operationRegistryService.pauseCountdown(ij.def.id);
      }
    }
  }

  private routeProgressUpdate(ij: InternalJob): void {
    if (ij.def.presentation === 'operation' && ij.state.progress) {
      operationRegistryService.setProgress(ij.def.id, ij.state.progress);
    }
  }

  private routeLabelUpdate(ij: InternalJob): void {
    if (ij.def.presentation === 'operation' && ij.state.label) {
      operationRegistryService.setLabel(ij.def.id, ij.state.label);
    }
  }

  // ---- Internal: focus/visibility triggers --------------------------------

  private installFocusListeners(): void {
    if (this.focusListenersInstalled) return;
    if (typeof window === 'undefined') return;

    this.focusHandler = () => this.onFocusOrVisibility();
    this.visibilityHandler = () => {
      if (!document.hidden) this.onFocusOrVisibility();
    };

    window.addEventListener('focus', this.focusHandler);
    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.focusListenersInstalled = true;
  }

  private removeFocusListeners(): void {
    if (!this.focusListenersInstalled) return;
    if (typeof window === 'undefined') return;

    if (this.focusHandler) {
      window.removeEventListener('focus', this.focusHandler);
      this.focusHandler = null;
    }
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    this.focusListenersInstalled = false;
  }

  private onFocusOrVisibility(): void {
    if (this._disposed || !this._bootComplete) return;

    for (const ij of this.jobs.values()) {
      if (ij.def.schedule.type !== 'periodic') continue;
      if (!ij.def.schedule.triggerOnFocus) continue;
      if (ij.isRunning) continue;
      if (ij.state.phase !== 'scheduled' && ij.state.phase !== 'idle') continue;

      // Skip rate-limit for focus/visibility triggers.
      // Focus means "user is back" — they should see fresh state immediately.
      // The rate limit only applies to timer-driven periodic fires.

      void this.executeJob(ij, undefined, { skipRateLimit: true });
    }
  }
}

export const jobSchedulerService = JobSchedulerService.getInstance();
