import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock sessionLogService (fire-and-forget audit — never affects state).
// This mock assumes audit logging is side-effect-only, validated by the
// service's own try/catch in auditOperationEvent.
vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

// We need a fresh instance per test to avoid cross-test pollution.
// The service uses a singleton, so we re-import after resetting modules.
async function freshRegistry() {
  // Dynamic import with cache-bust via resetModules in beforeEach.
  const mod = await import('../operationRegistryService');
  return mod.operationRegistryService;
}

describe('operationRegistryService', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // ---------- Registration defaults ----------

  it('should register an operation with status pending and cancellable false by default', async () => {
    const reg = await freshRegistry();

    reg.register({ id: 'op-1', kind: 'test', label: 'Test Op' });

    const state = reg.getState();
    expect(state.active).toHaveLength(1);
    expect(state.active[0].id).toBe('op-1');
    expect(state.active[0].status).toBe('pending');
    expect(state.active[0].cancellable).toBe(false);
    expect(state.active[0].startedAtMs).toBeUndefined();
  });

  it('should set status to running and populate startedAtMs when initial progress is provided', async () => {
    const reg = await freshRegistry();

    reg.register({
      id: 'op-2',
      kind: 'test',
      label: 'With progress',
      progress: { current: 0, total: 10 },
    });

    const op = reg.getState().active[0];
    expect(op.status).toBe('running');
    expect(op.startedAtMs).toBeTypeOf('number');
    expect(op.progress).toEqual({ current: 0, total: 10 });
  });

  // ---------- setStatus transitions ----------

  it('should move operation to recent when setStatus is called with a terminal status', async () => {
    const reg = await freshRegistry();

    reg.register({ id: 'op-1', kind: 'test', label: 'Test' });
    reg.setStatus('op-1', 'complete');

    const state = reg.getState();
    expect(state.active).toHaveLength(0);
    expect(state.recent).toHaveLength(1);
    expect(state.recent[0].id).toBe('op-1');
    expect(state.recent[0].status).toBe('complete');
    expect(state.recent[0].completedAtMs).toBeTypeOf('number');
  });

  it('should set startedAtMs on first transition to running but not overwrite on subsequent calls', async () => {
    const reg = await freshRegistry();

    reg.register({ id: 'op-1', kind: 'test', label: 'Test' });
    reg.setStatus('op-1', 'running');
    const firstStarted = reg.getState().active[0].startedAtMs;
    expect(firstStarted).toBeTypeOf('number');

    // Second call to running should not overwrite.
    reg.setStatus('op-1', 'running');
    expect(reg.getState().active[0].startedAtMs).toBe(firstStarted);
  });

  it('should clear countdown fields when transitioning away from countdown status', async () => {
    const reg = await freshRegistry();

    reg.register({ id: 'op-1', kind: 'test', label: 'Test', status: 'countdown' });
    reg.setCountdown('op-1', 10);

    // Verify countdown is set.
    expect(reg.getState().active[0].countdownSecondsRemaining).toBe(10);

    // Transition to running — countdown fields should be cleared.
    reg.setStatus('op-1', 'running');
    const op = reg.getState().active[0];
    expect(op.countdownSecondsRemaining).toBeUndefined();
    expect(op.status).toBe('running');
  });

  // ---------- setProgress ----------

  it('should auto-promote status to running when setProgress is called on a non-running operation', async () => {
    const reg = await freshRegistry();

    reg.register({ id: 'op-1', kind: 'test', label: 'Test' });
    expect(reg.getState().active[0].status).toBe('pending');

    reg.setProgress('op-1', { current: 3, total: 10, detail: 'Item 3/10' });

    const op = reg.getState().active[0];
    expect(op.status).toBe('running');
    expect(op.progress).toEqual({ current: 3, total: 10, detail: 'Item 3/10' });
    expect(op.startedAtMs).toBeTypeOf('number');
  });

  // ---------- setLabel ----------

  it('should not emit when setLabel is called with the same label', async () => {
    const reg = await freshRegistry();
    const listener = vi.fn();

    reg.register({ id: 'op-1', kind: 'test', label: 'Original' });
    reg.subscribe(listener);
    listener.mockClear();

    reg.setLabel('op-1', 'Original');
    expect(listener).not.toHaveBeenCalled();

    reg.setLabel('op-1', 'Changed');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(reg.getState().active[0].label).toBe('Changed');
  });

  // ---------- Countdown state machine ----------

  it('should capture countdownTotalSeconds only on first setCountdown call', async () => {
    const reg = await freshRegistry();

    reg.register({ id: 'op-1', kind: 'test', label: 'Test', status: 'countdown' });
    reg.setCountdown('op-1', 15);
    expect(reg.getState().active[0].countdownTotalSeconds).toBe(15);

    // Subsequent tick — total must not change.
    reg.setCountdown('op-1', 12);
    const op = reg.getState().active[0];
    expect(op.countdownSecondsRemaining).toBe(12);
    expect(op.countdownTotalSeconds).toBe(15);
  });

  it('should preserve countdownPaused flag across setCountdown ticks', async () => {
    const reg = await freshRegistry();

    reg.register({ id: 'op-1', kind: 'test', label: 'Test', status: 'countdown' });
    reg.setCountdown('op-1', 10);
    reg.pauseCountdown('op-1');
    expect(reg.getState().active[0].countdownPaused).toBe(true);

    // Tick while paused — paused flag must survive.
    reg.setCountdown('op-1', 8);
    expect(reg.getState().active[0].countdownPaused).toBe(true);
  });

  it('should no-op pauseCountdown when not in countdown status', async () => {
    const reg = await freshRegistry();
    const listener = vi.fn();

    reg.register({ id: 'op-1', kind: 'test', label: 'Test' }); // status: pending
    reg.subscribe(listener);
    listener.mockClear();

    reg.pauseCountdown('op-1');
    expect(listener).not.toHaveBeenCalled();
  });

  it('should no-op pauseCountdown when already paused', async () => {
    const reg = await freshRegistry();

    reg.register({ id: 'op-1', kind: 'test', label: 'Test', status: 'countdown' });
    reg.setCountdown('op-1', 10);
    reg.pauseCountdown('op-1');

    const listener = vi.fn();
    reg.subscribe(listener);

    reg.pauseCountdown('op-1');
    expect(listener).not.toHaveBeenCalled();
  });

  it('should no-op resumeCountdown when not paused', async () => {
    const reg = await freshRegistry();

    reg.register({ id: 'op-1', kind: 'test', label: 'Test', status: 'countdown' });
    reg.setCountdown('op-1', 10);

    const listener = vi.fn();
    reg.subscribe(listener);

    reg.resumeCountdown('op-1');
    expect(listener).not.toHaveBeenCalled();
  });

  it('should transition from paused to unpaused on resumeCountdown', async () => {
    const reg = await freshRegistry();

    reg.register({ id: 'op-1', kind: 'test', label: 'Test', status: 'countdown' });
    reg.setCountdown('op-1', 10);
    reg.pauseCountdown('op-1');
    expect(reg.getState().active[0].countdownPaused).toBe(true);

    reg.resumeCountdown('op-1');
    expect(reg.getState().active[0].countdownPaused).toBe(false);
  });

  // ---------- complete() ----------

  it('should move to recent with error message when complete is called with error outcome', async () => {
    const reg = await freshRegistry();

    reg.register({ id: 'op-1', kind: 'test', label: 'Test' });
    reg.complete('op-1', 'error', 'Something broke');

    const state = reg.getState();
    expect(state.active).toHaveLength(0);
    expect(state.recent).toHaveLength(1);
    expect(state.recent[0].status).toBe('error');
    expect(state.recent[0].error).toBe('Something broke');
  });

  it('should move to recent with cancelled status when complete is called with cancelled outcome', async () => {
    const reg = await freshRegistry();

    reg.register({ id: 'op-1', kind: 'test', label: 'Test' });
    reg.complete('op-1', 'cancelled');

    expect(reg.getState().recent[0].status).toBe('cancelled');
  });

  // ---------- Recent ring buffer ----------

  it('should evict oldest recent operations when exceeding MAX_RECENT (20)', async () => {
    const reg = await freshRegistry();

    for (let i = 0; i < 25; i++) {
      reg.register({ id: `op-${i}`, kind: 'test', label: `Op ${i}` });
      reg.complete(`op-${i}`, 'complete');
    }

    const state = reg.getState();
    expect(state.active).toHaveLength(0);
    expect(state.recent).toHaveLength(20);

    // Most recent should be first.
    expect(state.recent[0].id).toBe('op-24');
    // Oldest surviving should be op-5 (0–4 evicted).
    expect(state.recent[19].id).toBe('op-5');
  });

  // ---------- remove() ----------

  it('should remove from active and emit', async () => {
    const reg = await freshRegistry();

    reg.register({ id: 'op-1', kind: 'test', label: 'Test' });
    const listener = vi.fn();
    reg.subscribe(listener);

    reg.remove('op-1');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(reg.getState().active).toHaveLength(0);
  });

  it('should remove from recent and emit', async () => {
    const reg = await freshRegistry();

    reg.register({ id: 'op-1', kind: 'test', label: 'Test' });
    reg.complete('op-1', 'complete');

    const listener = vi.fn();
    reg.subscribe(listener);

    reg.remove('op-1');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(reg.getState().recent).toHaveLength(0);
  });

  it('should not emit when removing a non-existent operation', async () => {
    const reg = await freshRegistry();
    const listener = vi.fn();
    reg.subscribe(listener);

    reg.remove('does-not-exist');
    expect(listener).not.toHaveBeenCalled();
  });

  // ---------- clearRecent() ----------

  it('should empty the recent array and emit', async () => {
    const reg = await freshRegistry();

    reg.register({ id: 'op-1', kind: 'test', label: 'Test' });
    reg.complete('op-1', 'complete');
    expect(reg.getState().recent).toHaveLength(1);

    const listener = vi.fn();
    reg.subscribe(listener);

    reg.clearRecent();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(reg.getState().recent).toHaveLength(0);
  });

  it('should not emit when clearRecent is called on an already empty recent list', async () => {
    const reg = await freshRegistry();
    const listener = vi.fn();
    reg.subscribe(listener);

    reg.clearRecent();
    expect(listener).not.toHaveBeenCalled();
  });

  // ---------- get() ----------

  it('should find operations in active by ID', async () => {
    const reg = await freshRegistry();

    reg.register({ id: 'op-1', kind: 'test', label: 'Active' });
    expect(reg.get('op-1')?.label).toBe('Active');
  });

  it('should find operations in recent by ID', async () => {
    const reg = await freshRegistry();

    reg.register({ id: 'op-1', kind: 'test', label: 'Done' });
    reg.complete('op-1', 'complete');
    expect(reg.get('op-1')?.label).toBe('Done');
    expect(reg.get('op-1')?.status).toBe('complete');
  });

  it('should return undefined for non-existent ID', async () => {
    const reg = await freshRegistry();
    expect(reg.get('nope')).toBeUndefined();
  });

  // ---------- getState() caching (useSyncExternalStore contract) ----------

  it('should return the same reference from getState when no mutations have occurred', async () => {
    const reg = await freshRegistry();

    reg.register({ id: 'op-1', kind: 'test', label: 'Test' });
    const first = reg.getState();
    const second = reg.getState();
    expect(first).toBe(second);
  });

  it('should return a new reference from getState after a mutation', async () => {
    const reg = await freshRegistry();

    reg.register({ id: 'op-1', kind: 'test', label: 'Test' });
    const before = reg.getState();

    reg.setLabel('op-1', 'Changed');
    const after = reg.getState();
    expect(before).not.toBe(after);
  });

  // ---------- Subscriber lifecycle ----------

  it('should stop calling a listener after unsubscribe', async () => {
    const reg = await freshRegistry();
    const listener = vi.fn();

    const unsub = reg.subscribe(listener);
    reg.register({ id: 'op-1', kind: 'test', label: 'Test' });
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    reg.register({ id: 'op-2', kind: 'test', label: 'Test 2' });
    expect(listener).toHaveBeenCalledTimes(1); // no additional call
  });

  // ---------- setCancellable ----------

  it('should update the cancel callback and cancellable flag', async () => {
    const reg = await freshRegistry();
    const cancelFn = vi.fn();

    reg.register({ id: 'op-1', kind: 'test', label: 'Test' });
    expect(reg.getState().active[0].cancellable).toBe(false);

    reg.setCancellable('op-1', cancelFn);
    const op = reg.getState().active[0];
    expect(op.cancellable).toBe(true);
    expect(op.onCancel).toBe(cancelFn);
  });

  // ---------- setSubSteps ----------

  it('should attach sub-steps to an operation', async () => {
    const reg = await freshRegistry();

    reg.register({ id: 'op-1', kind: 'test', label: 'Test' });
    reg.setSubSteps('op-1', [
      { label: 'Step A', status: 'complete' },
      { label: 'Step B', status: 'running' },
    ]);

    const op = reg.getState().active[0];
    expect(op.subSteps).toHaveLength(2);
    expect(op.subSteps![0].label).toBe('Step A');
    expect(op.subSteps![1].status).toBe('running');
  });

  // ---------- Ordering ----------

  it('should sort active operations most-recent first by startedAtMs', async () => {
    const reg = await freshRegistry();

    reg.register({ id: 'op-old', kind: 'test', label: 'Old', progress: { current: 0, total: 1 } });
    // Small delay to ensure different timestamps.
    await new Promise((r) => setTimeout(r, 5));
    reg.register({ id: 'op-new', kind: 'test', label: 'New', progress: { current: 0, total: 1 } });

    const active = reg.getState().active;
    expect(active[0].id).toBe('op-new');
    expect(active[1].id).toBe('op-old');
  });

  // ---------- No-op on missing IDs ----------

  it('should silently no-op all mutation methods when called with a non-existent ID', async () => {
    const reg = await freshRegistry();
    const listener = vi.fn();
    reg.subscribe(listener);

    reg.setStatus('nope', 'running');
    reg.setProgress('nope', { current: 1, total: 2 });
    reg.setLabel('nope', 'X');
    reg.setCancellable('nope', vi.fn());
    reg.setCountdown('nope', 5);
    reg.pauseCountdown('nope');
    reg.resumeCountdown('nope');
    reg.setSubSteps('nope', []);
    reg.complete('nope', 'complete');

    expect(listener).not.toHaveBeenCalled();
  });
});
