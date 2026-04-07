/**
 * jobSchedulerService integration tests
 *
 * Tests the unified scheduler with REAL operationRegistryService and
 * bannerManagerService (not mocked). Only sessionLogService is mocked
 * (external audit trail).
 *
 * Timer simulation via vi.useFakeTimers().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { jobSchedulerService } from '../jobSchedulerService';
import type { JobDefinition, JobContext } from '../jobSchedulerService';
import { operationRegistryService } from '../operationRegistryService';
import { bannerManagerService } from '../bannerManagerService';

// Mock sessionLogService (audit trail, not behavioural)
vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    isLevelEnabled: vi.fn(() => false),
    startOperation: vi.fn(() => 'mock-op-id'),
    addChild: vi.fn(),
    endOperation: vi.fn(),
  },
}));

// Mock database so IDB persistence and boot reconciliation resolve immediately.
vi.mock('../../db/appDatabase', () => ({
  db: {
    schedulerJobs: {
      where: vi.fn(() => ({
        anyOf: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
        below: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
      })),
      put: vi.fn(async () => {}),
      get: vi.fn(async () => undefined),
      update: vi.fn(async () => {}),
      bulkDelete: vi.fn(async () => {}),
    },
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a simple job definition with overrides. */
function makeJob(overrides: Partial<JobDefinition> & { id: string }): JobDefinition {
  return {
    schedule: { type: 'reactive' },
    presentation: 'silent',
    runFn: async () => {},
    ...overrides,
  };
}

/** Create a job whose runFn we can control (resolve/reject externally). */
function makeControllableJob(overrides: Partial<JobDefinition> & { id: string }) {
  let resolveFn!: () => void;
  let rejectFn!: (err: Error) => void;
  const calls: JobContext[] = [];

  const job = makeJob({
    ...overrides,
    runFn: async (ctx) => {
      calls.push(ctx);
      await new Promise<void>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
    },
  });

  return { job, resolve: () => resolveFn(), reject: (e: Error) => rejectFn(e), calls };
}

/** Flush microtasks and pending timers. */
async function flush(ms = 0) {
  if (ms > 0) vi.advanceTimersByTime(ms);
  // Flush microtasks (queueMicrotask, Promise resolution).
  // vi.advanceTimersByTimeAsync handles both timer advancement AND microtask flushing.
  await vi.advanceTimersByTimeAsync(0);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  jobSchedulerService._reset();
  // Clear any leftover state from previous tests.
  bannerManagerService.clearAll();
  operationRegistryService.clearRecent();
});

afterEach(() => {
  jobSchedulerService._reset();
  bannerManagerService.clearAll();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ===========================================================================
// Tier 1: Engine mechanics
// ===========================================================================

describe('Tier 1: Engine mechanics', () => {
  // --- Periodic ---

  it('should fire a periodic job immediately on registration, then at interval', async () => {
    let runCount = 0;
    const job = makeJob({
      id: 'test-periodic',
      schedule: { type: 'periodic', intervalMs: 10_000 },
      runFn: async () => { runCount++; },
    });

    jobSchedulerService.registerJob(job);
    await flush();

    // First run: immediate.
    expect(runCount).toBe(1);

    // Advance 10s: second run.
    await flush(10_000);
    expect(runCount).toBe(2);

    // Advance another 10s: third run.
    await flush(10_000);
    expect(runCount).toBe(3);
  });

  it('should not pile up periodic jobs when runFn takes longer than interval', async () => {
    let runCount = 0;
    let resolvers: (() => void)[] = [];

    const job = makeJob({
      id: 'test-slow-periodic',
      schedule: { type: 'periodic', intervalMs: 5_000 },
      runFn: async () => {
        runCount++;
        await new Promise<void>(r => resolvers.push(r));
      },
    });

    jobSchedulerService.registerJob(job);
    await flush();
    expect(runCount).toBe(1);

    // Advance 10s while first run is still in progress.
    await flush(10_000);
    // Should NOT have piled up — still only 1 run because concurrency guard.
    expect(runCount).toBe(1);

    // Complete the first run.
    resolvers[0]();
    await flush();

    // Now it should reschedule. Advance interval.
    await flush(5_000);
    expect(runCount).toBe(2);
  });

  // --- Boot gating ---

  it('should park boot-gated jobs until signalBootComplete()', async () => {
    let ran = false;
    const job = makeJob({
      id: 'test-boot-gated',
      schedule: { type: 'periodic', intervalMs: 60_000 },
      bootGated: true,
      runFn: async () => { ran = true; },
    });

    jobSchedulerService.registerJob(job);
    await flush(120_000); // Well past interval.

    expect(ran).toBe(false);
    expect(jobSchedulerService.getJobState('test-boot-gated')?.phase).toBe('boot-waiting');

    // Signal boot complete. The drain is async (reconciliation runs first),
    // so we need multiple flush cycles for the promise chain to resolve.
    jobSchedulerService.signalBootComplete();
    await flush();
    await flush();
    await flush();

    expect(ran).toBe(true);
  });

  it('should allow non-boot-gated jobs to run before boot complete', async () => {
    let ran = false;
    const job = makeJob({
      id: 'test-no-boot-gate',
      schedule: { type: 'periodic', intervalMs: 60_000 },
      bootGated: false,
      runFn: async () => { ran = true; },
    });

    jobSchedulerService.registerJob(job);
    await flush();

    expect(ran).toBe(true);
  });

  // --- Reactive ---

  it('should execute a reactive job only when run() is called', async () => {
    let runCount = 0;
    const job = makeJob({
      id: 'test-reactive',
      schedule: { type: 'reactive' },
      runFn: async () => { runCount++; },
    });

    jobSchedulerService.registerJob(job);
    await flush(60_000);
    expect(runCount).toBe(0);

    jobSchedulerService.run('test-reactive');
    await flush();
    expect(runCount).toBe(1);
  });

  // --- Debounced ---

  it('should fire debounced job after idle period', async () => {
    let runCount = 0;
    const job = makeJob({
      id: 'test-debounced',
      schedule: { type: 'debounced', idleMs: 2_000 },
      runFn: async () => { runCount++; },
    });

    jobSchedulerService.registerJob(job);

    jobSchedulerService.trigger('test-debounced');
    await flush(1_000); // Not yet.
    expect(runCount).toBe(0);

    await flush(1_000); // 2s total idle.
    expect(runCount).toBe(1);
  });

  it('should reset debounce timer on re-trigger', async () => {
    let runCount = 0;
    const job = makeJob({
      id: 'test-debounce-reset',
      schedule: { type: 'debounced', idleMs: 2_000 },
      runFn: async () => { runCount++; },
    });

    jobSchedulerService.registerJob(job);

    jobSchedulerService.trigger('test-debounce-reset');
    await flush(1_500); // 1.5s — almost there.

    jobSchedulerService.trigger('test-debounce-reset'); // Reset!
    await flush(1_500); // 1.5s from reset — not yet.
    expect(runCount).toBe(0);

    await flush(500); // 2s from last trigger.
    expect(runCount).toBe(1);
  });

  it('should respect maxWaitMs cap on debounced jobs', async () => {
    let runCount = 0;
    const job = makeJob({
      id: 'test-debounce-cap',
      schedule: { type: 'debounced', idleMs: 2_000, maxWaitMs: 5_000 },
      runFn: async () => { runCount++; },
    });

    jobSchedulerService.registerJob(job);

    // Keep triggering every 1s — debounce never gets 2s idle.
    for (let i = 0; i < 6; i++) {
      jobSchedulerService.trigger('test-debounce-cap');
      await flush(1_000);
    }

    // Should have fired at ~5s due to maxWaitMs cap.
    expect(runCount).toBe(1);
  });

  // --- Countdown ---

  it('should count down and then execute', async () => {
    let ran = false;
    const job = makeJob({
      id: 'test-countdown',
      schedule: { type: 'countdown', durationSeconds: 3 },
      presentation: 'operation',
      operationKind: 'test',
      operationLabel: 'Test countdown',
      runFn: async () => { ran = true; },
    });

    jobSchedulerService.registerJob(job);
    jobSchedulerService.run('test-countdown');
    await flush();

    // Should be in countdown phase.
    expect(jobSchedulerService.getJobState('test-countdown')?.phase).toBe('countdown');
    expect(jobSchedulerService.getJobState('test-countdown')?.countdownSecondsRemaining).toBe(3);

    await flush(1_000);
    expect(jobSchedulerService.getJobState('test-countdown')?.countdownSecondsRemaining).toBe(2);

    await flush(2_000); // Total 3s.
    await flush(); // Let execution complete.
    expect(ran).toBe(true);
  });

  it('should pause and resume countdown', async () => {
    let ran = false;
    const job = makeJob({
      id: 'test-pause',
      schedule: { type: 'countdown', durationSeconds: 5 },
      runFn: async () => { ran = true; },
    });

    jobSchedulerService.registerJob(job);
    jobSchedulerService.run('test-pause');
    await flush();

    await flush(2_000); // 3 seconds remaining.
    expect(jobSchedulerService.getJobState('test-pause')?.countdownSecondsRemaining).toBe(3);

    // Pause.
    jobSchedulerService.pause('test-pause');
    expect(jobSchedulerService.getJobState('test-pause')?.countdownPaused).toBe(true);

    await flush(10_000); // Time passes, but countdown is paused.
    expect(ran).toBe(false);
    expect(jobSchedulerService.getJobState('test-pause')?.countdownSecondsRemaining).toBe(3);

    // Resume.
    jobSchedulerService.resume('test-pause');
    expect(jobSchedulerService.getJobState('test-pause')?.countdownPaused).toBe(false);

    await flush(3_000); // 3 seconds from resume.
    await flush();
    expect(ran).toBe(true);
  });

  // --- Rate limiting ---

  it('should skip rate-limited invocations', async () => {
    let runCount = 0;
    const job = makeJob({
      id: 'test-rate-limit',
      schedule: { type: 'reactive' },
      rateLimitMs: 10_000,
      runFn: async () => { runCount++; },
    });

    jobSchedulerService.registerJob(job);

    jobSchedulerService.run('test-rate-limit');
    await flush();
    expect(runCount).toBe(1);

    // Immediately again — should be skipped.
    jobSchedulerService.run('test-rate-limit');
    await flush();
    expect(runCount).toBe(1);

    // After rate limit expires.
    await flush(10_000);
    jobSchedulerService.run('test-rate-limit');
    await flush();
    expect(runCount).toBe(2);
  });

  // --- Cancel ---

  it('should set shouldAbort=true when cancel is called during execution', async () => {
    const { job, resolve, calls } = makeControllableJob({
      id: 'test-cancel',
      schedule: { type: 'reactive' },
    });

    jobSchedulerService.registerJob(job);
    jobSchedulerService.run('test-cancel');
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].shouldAbort()).toBe(false);

    jobSchedulerService.cancel('test-cancel');
    expect(calls[0].shouldAbort()).toBe(true);

    resolve();
    await flush();
    expect(jobSchedulerService.getJobState('test-cancel')?.phase).toBe('cancelled');
  });

  it('should cancel a countdown before it fires', async () => {
    let ran = false;
    const job = makeJob({
      id: 'test-cancel-countdown',
      schedule: { type: 'countdown', durationSeconds: 5 },
      runFn: async () => { ran = true; },
    });

    jobSchedulerService.registerJob(job);
    jobSchedulerService.run('test-cancel-countdown');
    await flush();

    expect(jobSchedulerService.getJobState('test-cancel-countdown')?.phase).toBe('countdown');

    jobSchedulerService.cancel('test-cancel-countdown');
    expect(jobSchedulerService.getJobState('test-cancel-countdown')?.phase).toBe('cancelled');

    await flush(10_000);
    expect(ran).toBe(false);
  });
});

// ===========================================================================
// Tier 2: UI routing
// ===========================================================================

describe('Tier 2: UI routing', () => {
  it('should register an operation in operationRegistryService for operation-presentation jobs', async () => {
    const job = makeJob({
      id: 'test-op-route',
      schedule: { type: 'reactive' },
      presentation: 'operation',
      operationKind: 'test-kind',
      operationLabel: 'Test operation',
      runFn: async () => {},
    });

    jobSchedulerService.registerJob(job);
    jobSchedulerService.run('test-op-route');
    await flush();

    // After completion, it should be in recent.
    const state = operationRegistryService.getState();
    const recent = state.recent.find(o => o.id === 'test-op-route');
    expect(recent).toBeDefined();
    expect(recent!.kind).toBe('test-kind');
    expect(recent!.status).toBe('complete');
  });

  it('should update operation progress when runFn calls setProgress', async () => {
    let capturedProgress = false;

    const job = makeJob({
      id: 'test-op-progress',
      schedule: { type: 'reactive' },
      presentation: 'operation',
      operationKind: 'test',
      operationLabel: 'Progress test',
      runFn: async (ctx) => {
        ctx.setProgress(5, 10, 'halfway');
        const op = operationRegistryService.get('test-op-progress');
        if (op?.progress?.current === 5 && op?.progress?.total === 10) {
          capturedProgress = true;
        }
      },
    });

    jobSchedulerService.registerJob(job);
    jobSchedulerService.run('test-op-progress');
    await flush();

    expect(capturedProgress).toBe(true);
  });

  it('should set banner for banner:app-update presentation', async () => {
    const job = makeJob({
      id: 'test-banner-update',
      schedule: { type: 'reactive' },
      presentation: 'banner:app-update',
      runFn: async (ctx) => {
        ctx.showBanner({
          label: 'New version available',
          actionLabel: 'Reload now',
        });
      },
    });

    jobSchedulerService.registerJob(job);
    jobSchedulerService.run('test-banner-update');
    await flush();

    const banners = bannerManagerService.getState().banners;
    const updateBanner = banners.find(b => b.id === 'app-update');
    expect(updateBanner).toBeDefined();
    expect(updateBanner!.label).toBe('New version available');
  });

  it('should set and clear automation banner for banner:automation presentation', async () => {
    const { job, resolve } = makeControllableJob({
      id: 'test-banner-auto',
      schedule: { type: 'reactive' },
      presentation: 'banner:automation',
    });

    // Override runFn to show banner, then wait for control.
    let resolveFn!: () => void;
    job.runFn = async (ctx) => {
      ctx.showBanner({ label: 'Automation running', actionLabel: 'Stop' });
      await new Promise<void>(r => { resolveFn = r; });
    };

    jobSchedulerService.registerJob(job);
    jobSchedulerService.run('test-banner-auto');
    await flush();

    // Banner should be set.
    let banners = bannerManagerService.getState().banners;
    expect(banners.find(b => b.id === 'automation')).toBeDefined();

    // Complete the job.
    resolveFn();
    await flush();

    // Banner should be cleared.
    banners = bannerManagerService.getState().banners;
    expect(banners.find(b => b.id === 'automation')).toBeUndefined();
  });

  it('should not write to operation registry or banner for silent jobs', async () => {
    const job = makeJob({
      id: 'test-silent',
      schedule: { type: 'reactive' },
      presentation: 'silent',
      runFn: async () => {},
    });

    jobSchedulerService.registerJob(job);
    jobSchedulerService.run('test-silent');
    await flush();

    const ops = operationRegistryService.getState();
    expect(ops.active.find(o => o.id === 'test-silent')).toBeUndefined();
    expect(ops.recent.find(o => o.id === 'test-silent')).toBeUndefined();

    const banners = bannerManagerService.getState().banners;
    expect(banners).toHaveLength(0);
  });
});

// ===========================================================================
// Tier 3: Concurrency and interference
// ===========================================================================

describe('Tier 3: Concurrency and interference', () => {
  it('should skip duplicate run() for singleton jobs', async () => {
    let runCount = 0;
    let resolvers: (() => void)[] = [];

    const job = makeJob({
      id: 'test-singleton',
      schedule: { type: 'reactive' },
      concurrency: { mode: 'singleton', onDuplicate: 'skip' },
      runFn: async () => {
        runCount++;
        await new Promise<void>(r => resolvers.push(r));
      },
    });

    jobSchedulerService.registerJob(job);

    jobSchedulerService.run('test-singleton');
    await flush();
    expect(runCount).toBe(1);

    // Second run while first is in progress.
    jobSchedulerService.run('test-singleton');
    await flush();
    expect(runCount).toBe(1); // Still 1 — skipped.

    resolvers[0]();
    await flush();
  });

  it('should suppress auto-pull when daily-automation is running', async () => {
    let autoPullRan = false;
    let resolveAutomation!: () => void;

    const automation = makeJob({
      id: 'daily-automation',
      schedule: { type: 'reactive' },
      suppress: ['auto-pull'],
      runFn: async () => {
        await new Promise<void>(r => { resolveAutomation = r; });
      },
    });

    const autoPull = makeJob({
      id: 'auto-pull',
      schedule: { type: 'reactive' },
      runFn: async () => { autoPullRan = true; },
    });

    jobSchedulerService.registerJob(automation);
    jobSchedulerService.registerJob(autoPull);

    // Start automation.
    jobSchedulerService.run('daily-automation');
    await flush();

    // Try to run auto-pull while automation is running.
    jobSchedulerService.run('auto-pull');
    await flush();
    expect(autoPullRan).toBe(false);

    // Complete automation.
    resolveAutomation();
    await flush();

    // Now auto-pull should work.
    jobSchedulerService.run('auto-pull');
    await flush();
    expect(autoPullRan).toBe(true);
  });

  it('should suppress version-check banner when daily-automation is running', async () => {
    let resolveAutomation!: () => void;

    const automation = makeJob({
      id: 'daily-automation',
      schedule: { type: 'reactive' },
      suppressBannerFor: ['version-check'],
      runFn: async () => {
        await new Promise<void>(r => { resolveAutomation = r; });
      },
    });

    const versionCheck = makeJob({
      id: 'version-check',
      schedule: { type: 'reactive' },
      presentation: 'banner:app-update',
      runFn: async (ctx) => {
        ctx.showBanner({ label: 'New version' });
      },
    });

    jobSchedulerService.registerJob(automation);
    jobSchedulerService.registerJob(versionCheck);

    // Start automation.
    jobSchedulerService.run('daily-automation');
    await flush();

    // Run version-check — it should run but banner should be suppressed.
    jobSchedulerService.run('version-check');
    await flush();

    const banners = bannerManagerService.getState().banners;
    expect(banners.find(b => b.id === 'app-update')).toBeUndefined();

    resolveAutomation();
    await flush();
  });

  it('should serialise pulls via acquirePullLock', async () => {
    const order: string[] = [];
    let releasePull1!: () => void;

    const job1 = makeJob({
      id: 'pull-1',
      schedule: { type: 'reactive' },
      concurrency: { mode: 'unrestricted' },
      runFn: async (ctx) => {
        const release = await ctx.acquirePullLock('repo', 'main');
        order.push('pull-1-start');
        // Hold the lock until we release externally.
        await new Promise<void>(r => { releasePull1 = () => { r(); }; });
        order.push('pull-1-end');
        release();
      },
    });

    const job2 = makeJob({
      id: 'pull-2',
      schedule: { type: 'reactive' },
      concurrency: { mode: 'unrestricted' },
      runFn: async (ctx) => {
        const release = await ctx.acquirePullLock('repo', 'main');
        order.push('pull-2-start');
        order.push('pull-2-end');
        release();
      },
    });

    jobSchedulerService.registerJob(job1);
    jobSchedulerService.registerJob(job2);

    // Start both concurrently.
    jobSchedulerService.run('pull-1');
    jobSchedulerService.run('pull-2');
    await flush();

    // pull-1 should have started, pull-2 should be waiting on the lock.
    expect(order).toEqual(['pull-1-start']);

    // Release pull-1's lock.
    releasePull1();
    await flush();

    // Now pull-2 should have run.
    expect(order).toEqual(['pull-1-start', 'pull-1-end', 'pull-2-start', 'pull-2-end']);
  });
});

// ===========================================================================
// Tier 2 supplement: Countdown + operation registry integration
// ===========================================================================

describe('Countdown + operation registry integration', () => {
  it('should reflect countdown ticks in operationRegistryService', async () => {
    const job = makeJob({
      id: 'test-countdown-op',
      schedule: { type: 'countdown', durationSeconds: 3 },
      presentation: 'operation',
      operationKind: 'auto-pull',
      operationLabel: 'Pulling latest',
      runFn: async () => {},
    });

    jobSchedulerService.registerJob(job);
    jobSchedulerService.run('test-countdown-op');
    await flush();

    // Check initial countdown in registry.
    let op = operationRegistryService.get('test-countdown-op');
    expect(op).toBeDefined();
    expect(op!.status).toBe('countdown');
    expect(op!.countdownSecondsRemaining).toBe(3);

    // Tick.
    await flush(1_000);
    op = operationRegistryService.get('test-countdown-op');
    expect(op!.countdownSecondsRemaining).toBe(2);

    // Let it complete.
    await flush(2_000);
    await flush();

    // Should be in recent as complete.
    const state = operationRegistryService.getState();
    const recent = state.recent.find(o => o.id === 'test-countdown-op');
    expect(recent).toBeDefined();
    expect(recent!.status).toBe('complete');
  });
});

// ===========================================================================
// Tier 4: IDB persistence
// ===========================================================================

describe('Tier 4: IDB persistence', () => {
  // The DB is mocked (vi.mock above), so these tests verify the scheduler
  // calls the right IDB methods at the right times — not the IDB roundtrip itself.
  // A full roundtrip test with fake-indexeddb belongs in a separate file when
  // the Bayes reconcileFn is implemented.

  it('should call db.schedulerJobs.put() when a persistent job starts running', async () => {
    const { db } = await import('../../db/appDatabase');

    const job = makeJob({
      id: 'test-persist',
      schedule: { type: 'reactive' },
      persistent: true,
      runFn: async () => {},
    });

    jobSchedulerService.registerJob(job);
    jobSchedulerService.run('test-persist');
    await flush();

    // Should have been called at least once (on running state).
    expect(db.schedulerJobs.put).toHaveBeenCalled();
    const putCall = (db.schedulerJobs.put as any).mock.calls[0][0];
    expect(putCall.jobDefId).toBe('test-persist');
    expect(putCall.status).toBe('running');
  });

  it('should NOT call db.schedulerJobs.put() for non-persistent jobs', async () => {
    const { db } = await import('../../db/appDatabase');
    (db.schedulerJobs.put as any).mockClear();

    const job = makeJob({
      id: 'test-no-persist',
      schedule: { type: 'reactive' },
      persistent: false,
      runFn: async () => {},
    });

    jobSchedulerService.registerJob(job);
    jobSchedulerService.run('test-no-persist');
    await flush();

    expect(db.schedulerJobs.put).not.toHaveBeenCalled();
  });

  it('should call reconcileFn for stale persisted jobs on boot', async () => {
    const { db } = await import('../../db/appDatabase');

    const reconcileFn = vi.fn(async () => ({
      status: 'complete' as const,
      label: 'Reconciled test job',
    }));

    // Set up the mock to return a stale job record.
    const staleRecord = {
      jobId: 'bayes-fit:graph-x:123',
      jobDefId: 'test-reconcile',
      status: 'running',
      submittedAtMs: Date.now() - 60_000,
      lastUpdatedAtMs: Date.now() - 60_000,
    };

    (db.schedulerJobs.where as any).mockReturnValue({
      anyOf: vi.fn(() => ({ toArray: vi.fn(async () => [staleRecord]) })),
      below: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
    });
    (db.schedulerJobs.update as any).mockResolvedValue(undefined);

    // Register a job with a reconcileFn BEFORE signalBootComplete.
    const job = makeJob({
      id: 'test-reconcile',
      schedule: { type: 'reactive' },
      persistent: true,
      reconcileFn,
      runFn: async () => {},
    });

    jobSchedulerService.registerJob(job);
    jobSchedulerService.signalBootComplete();

    // Flush multiple times for async reconciliation chain.
    await flush();
    await flush();
    await flush();

    expect(reconcileFn).toHaveBeenCalledTimes(1);
    expect(reconcileFn).toHaveBeenCalledWith(staleRecord);

    // IDB should be updated with the reconciled status.
    expect(db.schedulerJobs.update).toHaveBeenCalledWith(
      'bayes-fit:graph-x:123',
      expect.objectContaining({ status: 'complete' })
    );
  });

  it('should drain boot-waiting jobs even if reconciliation times out', async () => {
    // This test verifies the 30s timeout safety net.
    // We can't actually wait 30s in a test, so we verify the drain happens
    // even when reconciliation rejects.
    const { db } = await import('../../db/appDatabase');

    // Make the stale jobs query throw to simulate failure.
    (db.schedulerJobs.where as any).mockReturnValue({
      anyOf: vi.fn(() => ({ toArray: vi.fn(async () => { throw new Error('IDB corrupted'); }) })),
      below: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
    });

    let bootJobRan = false;
    const job = makeJob({
      id: 'test-boot-after-fail',
      schedule: { type: 'reactive' },
      bootGated: true,
      runFn: async () => { bootJobRan = true; },
    });

    jobSchedulerService.registerJob(job);
    jobSchedulerService.signalBootComplete();
    await flush();
    await flush();
    await flush();

    // Boot-waiting jobs should still drain despite reconciliation failure.
    // The job is reactive so it won't auto-fire, but it should be in 'idle' not 'boot-waiting'.
    expect(jobSchedulerService.getJobState('test-boot-after-fail')?.phase).not.toBe('boot-waiting');

    // Manually trigger it to verify it's runnable.
    jobSchedulerService.run('test-boot-after-fail');
    await flush();
    expect(bootJobRan).toBe(true);
  });
});
