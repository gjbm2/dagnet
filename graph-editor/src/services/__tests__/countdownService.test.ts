import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock sessionLogService (fire-and-forget audit — never affects countdown state).
vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

// Fresh instance per test to avoid singleton cross-pollution.
async function freshCountdown() {
  const mod = await import('../countdownService');
  return mod.countdownService;
}

describe('countdownService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------- startCountdown ----------

  it('should create an active state with correct secondsRemaining', async () => {
    const cs = await freshCountdown();

    cs.startCountdown({ key: 'test', durationSeconds: 10 });

    const state = cs.getState('test');
    expect(state).toBeDefined();
    expect(state!.secondsRemaining).toBe(10);
    expect(state!.isActive).toBe(true);
    expect(state!.key).toBe('test');
  });

  // ---------- Timer ticks ----------

  it('should decrement secondsRemaining each second', async () => {
    const cs = await freshCountdown();

    cs.startCountdown({ key: 'test', durationSeconds: 5 });

    vi.advanceTimersByTime(1000);
    expect(cs.getState('test')!.secondsRemaining).toBe(4);

    vi.advanceTimersByTime(1000);
    expect(cs.getState('test')!.secondsRemaining).toBe(3);
  });

  // ---------- onExpire ----------

  it('should fire onExpire exactly once when countdown reaches 0', async () => {
    const cs = await freshCountdown();
    const onExpire = vi.fn();

    cs.startCountdown({ key: 'test', durationSeconds: 3, onExpire });

    vi.advanceTimersByTime(2000);
    expect(onExpire).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    // onExpire may be called via queueMicrotask or timeout — flush everything.
    await vi.advanceTimersByTimeAsync(0);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('should not call onExpire if countdown is cancelled before expiry', async () => {
    const cs = await freshCountdown();
    const onExpire = vi.fn();

    cs.startCountdown({ key: 'test', durationSeconds: 5, onExpire });
    vi.advanceTimersByTime(2000);

    cs.cancelCountdown('test');
    vi.advanceTimersByTime(10000);
    await vi.advanceTimersByTimeAsync(0);

    expect(onExpire).not.toHaveBeenCalled();
  });

  it('should clear state after countdown expires', async () => {
    const cs = await freshCountdown();

    cs.startCountdown({ key: 'test', durationSeconds: 2 });
    vi.advanceTimersByTime(2000);
    await vi.advanceTimersByTimeAsync(0);

    expect(cs.getState('test')).toBeUndefined();
  });

  // ---------- cancelCountdown ----------

  it('should remove state and stop the timer on cancel', async () => {
    const cs = await freshCountdown();

    cs.startCountdown({ key: 'test', durationSeconds: 10 });
    cs.cancelCountdown('test');

    expect(cs.getState('test')).toBeUndefined();

    // Advancing time should have no effect — timer is stopped.
    vi.advanceTimersByTime(15000);
    expect(cs.getState('test')).toBeUndefined();
  });

  // ---------- Restart semantics ----------

  it('should replace a running countdown without firing the old onExpire', async () => {
    const cs = await freshCountdown();
    const oldExpire = vi.fn();
    const newExpire = vi.fn();

    cs.startCountdown({ key: 'test', durationSeconds: 5, onExpire: oldExpire });
    vi.advanceTimersByTime(2000);

    // Restart with new duration and callback.
    cs.startCountdown({ key: 'test', durationSeconds: 3, onExpire: newExpire });

    // Old timer would have expired at t=5s, new at t=2s+3s = t=5s from start,
    // but we just restarted so it's 3s from now.
    vi.advanceTimersByTime(3000);
    await vi.advanceTimersByTimeAsync(0);

    expect(oldExpire).not.toHaveBeenCalled();
    expect(newExpire).toHaveBeenCalledTimes(1);
  });

  // ---------- Zero-duration countdown ----------

  it('should expire asynchronously for zero-duration countdown', async () => {
    const cs = await freshCountdown();
    const onExpire = vi.fn();

    cs.startCountdown({ key: 'test', durationSeconds: 0, onExpire });

    // Should not fire synchronously.
    expect(onExpire).not.toHaveBeenCalled();

    // Flush microtasks.
    await vi.advanceTimersByTimeAsync(0);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  // ---------- cancelCountdownsByPrefix ----------

  it('should cancel all countdowns matching a prefix and leave others running', async () => {
    const cs = await freshCountdown();
    const expireA = vi.fn();
    const expireB = vi.fn();
    const expireOther = vi.fn();

    cs.startCountdown({ key: 'op:pull:a', durationSeconds: 5, onExpire: expireA });
    cs.startCountdown({ key: 'op:pull:b', durationSeconds: 5, onExpire: expireB });
    cs.startCountdown({ key: 'other:x', durationSeconds: 5, onExpire: expireOther });

    cs.cancelCountdownsByPrefix('op:pull');

    expect(cs.getState('op:pull:a')).toBeUndefined();
    expect(cs.getState('op:pull:b')).toBeUndefined();
    expect(cs.getState('other:x')).toBeDefined();

    // Let the remaining one expire.
    vi.advanceTimersByTime(5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(expireA).not.toHaveBeenCalled();
    expect(expireB).not.toHaveBeenCalled();
    expect(expireOther).toHaveBeenCalledTimes(1);
  });

  // ---------- Absolute-time resilience ----------

  it('should catch up correctly when timer is throttled (multi-second advance)', async () => {
    const cs = await freshCountdown();

    cs.startCountdown({ key: 'test', durationSeconds: 10 });

    // Simulate browser throttling: jump 7 seconds at once.
    vi.advanceTimersByTime(7000);

    const state = cs.getState('test');
    // Should be 3 or fewer (absolute-time math), not 9 (simple decrement).
    expect(state!.secondsRemaining).toBeLessThanOrEqual(3);
    expect(state!.secondsRemaining).toBeGreaterThanOrEqual(2);
  });

  // ---------- Subscriber notifications ----------

  it('should notify subscribers on start, tick, and cancellation', async () => {
    const cs = await freshCountdown();
    const listener = vi.fn();
    cs.subscribe(listener);

    cs.startCountdown({ key: 'test', durationSeconds: 3 });
    expect(listener).toHaveBeenCalledTimes(1); // start

    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledTimes(2); // tick

    cs.cancelCountdown('test');
    expect(listener).toHaveBeenCalledTimes(3); // cancel
  });

  it('should stop calling a listener after unsubscribe', async () => {
    const cs = await freshCountdown();
    const listener = vi.fn();
    const unsub = cs.subscribe(listener);

    cs.startCountdown({ key: 'test', durationSeconds: 5 });
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledTimes(1); // no new calls
  });

  // ---------- runId guards (race condition) ----------

  it('should ignore in-flight expiry from a prior run after restart', async () => {
    const cs = await freshCountdown();
    const firstExpire = vi.fn();
    const secondExpire = vi.fn();

    // Start with 2s.
    cs.startCountdown({ key: 'test', durationSeconds: 2, onExpire: firstExpire });
    vi.advanceTimersByTime(1500);

    // Restart before first one expires.
    cs.startCountdown({ key: 'test', durationSeconds: 5, onExpire: secondExpire });

    // Original would have expired at 2s, 500ms from now.
    vi.advanceTimersByTime(600);
    await vi.advanceTimersByTimeAsync(0);
    expect(firstExpire).not.toHaveBeenCalled();

    // Let the second one expire.
    vi.advanceTimersByTime(5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(secondExpire).toHaveBeenCalledTimes(1);
    expect(firstExpire).not.toHaveBeenCalled();
  });

  // ---------- Negative/fractional durations ----------

  it('should clamp negative durations to 0 and expire asynchronously', async () => {
    const cs = await freshCountdown();
    const onExpire = vi.fn();

    cs.startCountdown({ key: 'test', durationSeconds: -5, onExpire });
    expect(cs.getState('test')!.secondsRemaining).toBe(0);

    await vi.advanceTimersByTimeAsync(0);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('should floor fractional durations', async () => {
    const cs = await freshCountdown();

    cs.startCountdown({ key: 'test', durationSeconds: 3.7 });
    expect(cs.getState('test')!.secondsRemaining).toBe(3);
  });
});
