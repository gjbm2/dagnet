/**
 * Unit tests for rate limit cooldown machinery in retrieveAllSlicesService.
 *
 * Tests that:
 * 1. Rate limit errors are detected correctly
 * 2. The cooldown helper function works
 * 3. The test override for cooldown duration works
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
