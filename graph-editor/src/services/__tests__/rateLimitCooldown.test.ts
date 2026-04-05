/**
 * Tests for rate limit cooldown machinery.
 *
 * Tests that:
 * 1. Rate limit errors are detected correctly
 * 2. The cooldown helper function works (with registry bridge)
 * 3. The test override for cooldown duration works
 * 4. formatCountdown displays human-readable times
 * 5. startRateLimitCountdown bridges countdown → operation registry
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  rateLimiter,
  AUTOMATION_RATE_LIMIT_COOLOFF_MINUTES,
  getEffectiveRateLimitCooloffMinutes,
} from '../rateLimiter';

describe('Rate Limit Detection', () => {
  it('detects 429 status code', () => {
    expect(rateLimiter.isRateLimitError('Error: 429')).toBe(true);
    expect(rateLimiter.isRateLimitError(new Error('Request failed with status 429'))).toBe(true);
  });

  it('detects "Too Many Requests" message', () => {
    expect(rateLimiter.isRateLimitError('Too Many Requests')).toBe(true);
    expect(rateLimiter.isRateLimitError('Error: Too Many Requests: Exceeded rate limit')).toBe(true);
  });

  it('detects Amplitude rate limit error format', () => {
    const amplitudeError = JSON.stringify({
      error: {
        http_code: 429,
        type: 'unspecified',
        message: 'Unspecified Error',
        metadata: { details: 'Too Many Requests: Exceeded rate limit with query of cost 1800' },
      },
    });
    expect(rateLimiter.isRateLimitError(amplitudeError)).toBe(true);
  });

  it('detects "Exceeded rate limit" message', () => {
    expect(rateLimiter.isRateLimitError('Exceeded rate limit')).toBe(true);
  });

  it('does not false positive on normal errors', () => {
    expect(rateLimiter.isRateLimitError('Network error')).toBe(false);
    expect(rateLimiter.isRateLimitError('Timeout')).toBe(false);
    expect(rateLimiter.isRateLimitError('Invalid response')).toBe(false);
  });
});

describe('Cooloff Constant', () => {
  it('has the correct value (61 minutes)', () => {
    expect(AUTOMATION_RATE_LIMIT_COOLOFF_MINUTES).toBe(61);
  });
});

describe('getEffectiveRateLimitCooloffMinutes', () => {
  const originalWindow = global.window;

  beforeEach(() => {
    // Reset any previous override
    if (typeof global.window !== 'undefined') {
      delete (global.window as any).__dagnetTestRateLimitCooloffMinutes;
    }
  });

  afterEach(() => {
    // Restore window
    if (typeof global.window !== 'undefined') {
      delete (global.window as any).__dagnetTestRateLimitCooloffMinutes;
    }
  });

  it('returns default value when no override is set', () => {
    expect(getEffectiveRateLimitCooloffMinutes()).toBe(61);
  });

  it('returns override value when window.__dagnetTestRateLimitCooloffMinutes is set', () => {
    // Set up window if needed for this test
    if (typeof global.window === 'undefined') {
      (global as any).window = {};
    }
    (global.window as any).__dagnetTestRateLimitCooloffMinutes = 0.1; // 6 seconds
    expect(getEffectiveRateLimitCooloffMinutes()).toBe(0.1);
  });

  it('ignores invalid override values (non-positive)', () => {
    if (typeof global.window === 'undefined') {
      (global as any).window = {};
    }
    (global.window as any).__dagnetTestRateLimitCooloffMinutes = 0;
    expect(getEffectiveRateLimitCooloffMinutes()).toBe(61);

    (global.window as any).__dagnetTestRateLimitCooloffMinutes = -5;
    expect(getEffectiveRateLimitCooloffMinutes()).toBe(61);
  });

  it('ignores non-number override values', () => {
    if (typeof global.window === 'undefined') {
      (global as any).window = {};
    }
    (global.window as any).__dagnetTestRateLimitCooloffMinutes = 'invalid';
    expect(getEffectiveRateLimitCooloffMinutes()).toBe(61);
  });
});

describe('Rate Limiter Backoff State', () => {
  beforeEach(() => {
    rateLimiter.reset();
  });

  it('reports rate limit errors and tracks consecutive errors', () => {
    rateLimiter.reportRateLimitError('amplitude', '429 Too Many Requests');
    const stats = rateLimiter.getStats();
    expect(stats.amplitude.consecutiveErrors).toBe(1);
    expect(stats.amplitude.currentBackoff).toBeGreaterThan(0);
  });

  it('increases backoff on consecutive errors', () => {
    rateLimiter.reportRateLimitError('amplitude', '429');
    const backoff1 = rateLimiter.getStats().amplitude.currentBackoff;

    rateLimiter.reportRateLimitError('amplitude', '429');
    const backoff2 = rateLimiter.getStats().amplitude.currentBackoff;

    expect(backoff2).toBeGreaterThan(backoff1);
  });

  it('resets backoff on success', () => {
    rateLimiter.reportRateLimitError('amplitude', '429');
    rateLimiter.reportRateLimitError('amplitude', '429');
    expect(rateLimiter.getStats().amplitude.consecutiveErrors).toBe(2);

    rateLimiter.reportSuccess('amplitude');
    expect(rateLimiter.getStats().amplitude.consecutiveErrors).toBe(0);
    expect(rateLimiter.getStats().amplitude.currentBackoff).toBe(0);
  });

  it('caps backoff at maximum', () => {
    // Amplitude max is 120000ms (2 minutes)
    for (let i = 0; i < 20; i++) {
      rateLimiter.reportRateLimitError('amplitude', '429');
    }
    expect(rateLimiter.getStats().amplitude.currentBackoff).toBeLessThanOrEqual(120000);
  });
});

// ============================================================================
// formatCountdown (OperationsToast display helper)
// ============================================================================

import { formatCountdown } from '../../components/OperationsToast';

describe('formatCountdown', () => {
  it('should format 61 minutes as "61:00"', () => {
    expect(formatCountdown(3660)).toBe('61:00');
  });

  it('should format 2m 5s as "2:05"', () => {
    expect(formatCountdown(125)).toBe('2:05');
  });

  it('should format exactly 1 minute as "1:00"', () => {
    expect(formatCountdown(60)).toBe('1:00');
  });

  it('should format sub-minute as seconds with "s" suffix', () => {
    expect(formatCountdown(59)).toBe('59s');
    expect(formatCountdown(1)).toBe('1s');
  });

  it('should format zero as "0s"', () => {
    expect(formatCountdown(0)).toBe('0s');
  });

  it('should clamp negative values to "0s"', () => {
    expect(formatCountdown(-5)).toBe('0s');
  });

  it('should floor fractional seconds', () => {
    expect(formatCountdown(61.9)).toBe('1:01');
    expect(formatCountdown(59.9)).toBe('59s');
  });
});

// ============================================================================
// startRateLimitCountdown (non-React bridge)
// ============================================================================

// Mock sessionLogService before importing the countdown service.
vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    addChild: vi.fn(),
    startOperation: vi.fn(() => 'mock-log-id'),
    endOperation: vi.fn(),
  },
}));

import { operationRegistryService } from '../operationRegistryService';
import { startRateLimitCountdown } from '../rateLimitCountdownService';

describe('startRateLimitCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Clean up any lingering operations from previous tests.
    const state = operationRegistryService.getState();
    for (const op of state.active) {
      operationRegistryService.complete(op.id, 'cancelled');
    }
    operationRegistryService.clearRecent();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should register a countdown operation in the registry', async () => {
    const promise = startRateLimitCountdown({ cooldownMinutes: 1 });

    const state = operationRegistryService.getState();
    const countdownOp = state.active.find(op => op.kind === 'rate-limit-cooldown');
    expect(countdownOp).toBeDefined();
    expect(countdownOp!.status).toBe('countdown');

    // Let the countdown expire to clean up.
    vi.advanceTimersByTime(60_000);
    await vi.runAllTimersAsync();
    await promise;
  });

  it('should resolve "expired" when countdown reaches zero', async () => {
    const promise = startRateLimitCountdown({ cooldownMinutes: 1 });

    // Advance past the 60-second countdown.
    vi.advanceTimersByTime(61_000);
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result).toBe('expired');
  });

  it('should resolve "aborted" when shouldStop returns true', async () => {
    let stop = false;
    const promise = startRateLimitCountdown({
      cooldownMinutes: 1,
      shouldStop: () => stop,
    });

    // Advance a bit, then signal abort.
    vi.advanceTimersByTime(5_000);
    stop = true;
    vi.advanceTimersByTime(1_000); // Trigger the abort check interval.

    const result = await promise;
    expect(result).toBe('aborted');
  });

  it('should sync countdown ticks to the operation registry', async () => {
    const promise = startRateLimitCountdown({ cooldownMinutes: 1 });

    // After a few ticks, the registry should show decremented seconds.
    vi.advanceTimersByTime(3_000);

    const state = operationRegistryService.getState();
    const countdownOp = state.active.find(op => op.kind === 'rate-limit-cooldown');
    expect(countdownOp).toBeDefined();
    expect(countdownOp!.countdownSecondsRemaining).toBeLessThan(60);
    expect(countdownOp!.countdownSecondsRemaining).toBeGreaterThan(50);
    expect(countdownOp!.countdownTotalSeconds).toBe(60);

    // Clean up.
    vi.advanceTimersByTime(60_000);
    await vi.runAllTimersAsync();
    await promise;
  });

  it('should complete own operation on expiry when no operationId provided', async () => {
    const promise = startRateLimitCountdown({ cooldownMinutes: 1 });

    vi.advanceTimersByTime(61_000);
    await vi.runAllTimersAsync();
    await promise;

    // The operation should now be in the recent list (terminal), not active.
    const state = operationRegistryService.getState();
    const activeCountdown = state.active.find(op => op.kind === 'rate-limit-cooldown');
    expect(activeCountdown).toBeUndefined();

    const recentCountdown = state.recent.find(op => op.kind === 'rate-limit-cooldown');
    expect(recentCountdown).toBeDefined();
    expect(recentCountdown!.status).toBe('complete');
  });

  it('should NOT complete operation when operationId is provided (caller owns lifecycle)', async () => {
    // Register an existing operation that the caller owns.
    const existingOpId = 'test-retrieve-all-op';
    operationRegistryService.register({
      id: existingOpId,
      kind: 'retrieve-all',
      label: 'Test Retrieve All',
      status: 'running',
    });

    const promise = startRateLimitCountdown({
      cooldownMinutes: 1,
      operationId: existingOpId,
    });

    vi.advanceTimersByTime(61_000);
    await vi.runAllTimersAsync();
    await promise;

    // The caller's operation should still be active (not moved to recent).
    const state = operationRegistryService.getState();
    const op = state.active.find(o => o.id === existingOpId);
    // setCountdown transitions to 'countdown'; after expiry the caller must transition back.
    // The helper should NOT have completed it.
    // It may be in active (if not completed) or recent (if completed by the helper — which it shouldn't).
    const inRecent = state.recent.find(o => o.id === existingOpId);
    expect(inRecent).toBeUndefined();

    // Clean up.
    operationRegistryService.complete(existingOpId, 'complete');
  });

  it('should handle cancel button click (via setCancellable) for owned operations', async () => {
    const promise = startRateLimitCountdown({ cooldownMinutes: 1 });

    vi.advanceTimersByTime(2_000);

    // Find the operation and invoke its cancel callback.
    const state = operationRegistryService.getState();
    const countdownOp = state.active.find(op => op.kind === 'rate-limit-cooldown');
    expect(countdownOp).toBeDefined();
    expect(countdownOp!.cancellable).toBe(true);
    expect(countdownOp!.onCancel).toBeDefined();

    countdownOp!.onCancel!();

    const result = await promise;
    expect(result).toBe('aborted');
  });
});
