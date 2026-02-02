/**
 * Snapshot Write Service Tests (Phase 1)
 * 
 * Tests the write path for the snapshot database feature.
 * 
 * Test Categories:
 * - WI-*: Write Integrity (8 tests)
 * - SI-*: Signature Integrity (5 tests) 
 * - GD-*: Graceful Degradation (2 tests)
 * 
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SnapshotRow, AppendSnapshotsParams } from '../snapshotWriteService';

// Mock fetch for all tests
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocking
import { appendSnapshots, checkSnapshotHealth } from '../snapshotWriteService';

// Test fixtures
const BASE_PARAMS: Omit<AppendSnapshotsParams, 'rows'> = {
  param_id: 'test-repo-test-branch-checkout-conversion',
  core_hash: 'abc123def456',
  slice_key: '',
  retrieved_at: new Date('2025-12-10T12:00:00Z'),
};

function createTestRows(count: number, withLatency = true): SnapshotRow[] {
  return Array.from({ length: count }, (_, i) => {
    const day = String(i + 1).padStart(2, '0');
    return {
      anchor_day: `2025-12-${day}`,
      X: 100 + i * 10,
      Y: 15 + i,
      ...(withLatency ? {
        median_lag_days: 5.2 + i * 0.1,
        mean_lag_days: 6.1 + i * 0.1,
        anchor_median_lag_days: 3.5 + i * 0.1,
        anchor_mean_lag_days: 4.2 + i * 0.1,
      } : {}),
    };
  });
}

describe('Snapshot Write Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: successful response
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, inserted: 10 }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // WI-*: Write Integrity Tests
  // ===========================================================================
  
  describe('Write Integrity (WI-*)', () => {
    it('WI-001: write_simple_uncontexted - writes 10 rows with empty slice_key', async () => {
      const rows = createTestRows(10);
      
      const result = await appendSnapshots({
        ...BASE_PARAMS,
        slice_key: '',  // Uncontexted
        rows,
      });
      
      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/snapshots/append');
      
      const body = JSON.parse(options.body);
      expect(body.slice_key).toBe('');
      expect(body.rows).toHaveLength(10);
      expect(body.rows[0].X).toBe(100);
      expect(body.rows[0].Y).toBe(15);
    });

    it('WI-002: write_with_all_latency - all 4 latency columns populated', async () => {
      const rows = createTestRows(5, true);
      
      await appendSnapshots({
        ...BASE_PARAMS,
        rows,
      });
      
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const row = body.rows[0];
      
      expect(row.median_lag_days).toBeDefined();
      expect(row.mean_lag_days).toBeDefined();
      expect(row.anchor_median_lag_days).toBeDefined();
      expect(row.anchor_mean_lag_days).toBeDefined();
    });

    it('WI-003: write_contexted_slice - slice_key matches context DSL', async () => {
      const rows = createTestRows(5);
      const contextSlice = 'context(channel:google)';
      
      await appendSnapshots({
        ...BASE_PARAMS,
        slice_key: contextSlice,
        rows,
      });
      
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.slice_key).toBe(contextSlice);
    });

    it('WI-004: write_cohort_mode - A column populated for cohort queries', async () => {
      const rows: SnapshotRow[] = [
        { anchor_day: '2025-12-01', A: 100, X: 80, Y: 10 },
        { anchor_day: '2025-12-02', A: 95, X: 75, Y: 12 },
      ];
      
      await appendSnapshots({
        ...BASE_PARAMS,
        rows,
      });
      
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.rows[0].A).toBe(100);
      expect(body.rows[1].A).toBe(95);
    });

    it('WI-005: write_window_mode - A column undefined for window queries', async () => {
      const rows: SnapshotRow[] = [
        { anchor_day: '2025-12-01', X: 100, Y: 15 },  // No A
        { anchor_day: '2025-12-02', X: 110, Y: 17 },
      ];
      
      await appendSnapshots({
        ...BASE_PARAMS,
        rows,
      });
      
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.rows[0].A).toBeUndefined();
      expect(body.rows[0].X).toBe(100);
    });

    it('WI-006: write_idempotent - returns success even if no new rows inserted', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, inserted: 0 }),  // Duplicates ignored
      });
      
      const rows = createTestRows(5);
      const result = await appendSnapshots({ ...BASE_PARAMS, rows });
      
      expect(result.success).toBe(true);
      expect(result.inserted).toBe(0);  // All were duplicates
    });

    it('WI-007: write_workspace_prefix - param_id includes workspace prefix', async () => {
      const rows = createTestRows(3);
      
      await appendSnapshots({
        param_id: 'my-repo-feature-branch-checkout-param',
        core_hash: 'xyz789',
        slice_key: '',
        retrieved_at: new Date(),
        rows,
      });
      
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.param_id).toBe('my-repo-feature-branch-checkout-param');
      expect(body.param_id).toContain('-');  // Has workspace prefix
    });

    it('WI-008: write_preserves_nulls - missing latency data not sent as 0', async () => {
      const rows: SnapshotRow[] = [
        { anchor_day: '2025-12-01', X: 100, Y: 15 },  // No latency
      ];
      
      await appendSnapshots({
        ...BASE_PARAMS,
        rows,
      });
      
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // Should be undefined, not 0
      expect(body.rows[0].median_lag_days).toBeUndefined();
      expect(body.rows[0].mean_lag_days).toBeUndefined();
    });
  });

  // ===========================================================================
  // SI-*: Signature Integrity Tests
  // ===========================================================================
  
  describe('Signature Integrity (SI-*)', () => {
    it('SI-001: signature_matches_file - core_hash is passed correctly', async () => {
      const rows = createTestRows(3);
      const coreHash = 'unique-hash-for-this-query';
      
      await appendSnapshots({
        ...BASE_PARAMS,
        core_hash: coreHash,
        rows,
      });
      
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.core_hash).toBe(coreHash);
    });

    it('SI-002: signature_cohort_vs_window - different modes should have different hashes', async () => {
      // This test validates that the caller should use different hashes for different modes
      // The service just passes through whatever hash it receives
      const cohortHash = 'cohort-mode-hash';
      const windowHash = 'window-mode-hash';
      
      await appendSnapshots({
        ...BASE_PARAMS,
        core_hash: cohortHash,
        rows: [{ anchor_day: '2025-12-01', A: 100, X: 80, Y: 10 }],
      });
      
      await appendSnapshots({
        ...BASE_PARAMS,
        core_hash: windowHash,
        rows: [{ anchor_day: '2025-12-01', X: 80, Y: 10 }],
      });
      
      const body1 = JSON.parse(mockFetch.mock.calls[0][1].body);
      const body2 = JSON.parse(mockFetch.mock.calls[1][1].body);
      
      expect(body1.core_hash).toBe(cohortHash);
      expect(body2.core_hash).toBe(windowHash);
      expect(body1.core_hash).not.toBe(body2.core_hash);
    });

    it('SI-003: signature_stable_across_writes - same query produces same hash', async () => {
      const stableHash = 'stable-query-hash';
      const rows = createTestRows(3);
      
      await appendSnapshots({ ...BASE_PARAMS, core_hash: stableHash, rows });
      await appendSnapshots({ ...BASE_PARAMS, core_hash: stableHash, rows });
      
      const body1 = JSON.parse(mockFetch.mock.calls[0][1].body);
      const body2 = JSON.parse(mockFetch.mock.calls[1][1].body);
      
      expect(body1.core_hash).toBe(body2.core_hash);
    });

    it('SI-004: context_def_hashes stored for future strict matching', async () => {
      const contextDefHashes = {
        channel: 'hash-of-channel-context-def',
        region: 'hash-of-region-context-def',
      };
      
      await appendSnapshots({
        ...BASE_PARAMS,
        context_def_hashes: contextDefHashes,
        rows: createTestRows(3),
      });
      
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.context_def_hashes).toEqual(contextDefHashes);
    });

    it('SI-005: null context_def_hashes when not provided', async () => {
      await appendSnapshots({
        ...BASE_PARAMS,
        // No context_def_hashes
        rows: createTestRows(3),
      });
      
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.context_def_hashes).toBeNull();
    });
  });

  // ===========================================================================
  // GD-*: Graceful Degradation Tests
  // ===========================================================================
  
  describe('Graceful Degradation (GD-*)', () => {
    it('GD-001: write_db_unavailable - returns failure but does not throw', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve('Database unavailable'),
      });
      
      const rows = createTestRows(5);
      const result = await appendSnapshots({ ...BASE_PARAMS, rows });
      
      // Should NOT throw - just return failure
      expect(result.success).toBe(false);
      expect(result.inserted).toBe(0);
      expect(result.error).toContain('Database unavailable');
    });

    it('GD-002: write_network_error - returns failure but does not throw', async () => {
      mockFetch.mockRejectedValue(new Error('Network error: connection refused'));
      
      const rows = createTestRows(5);
      const result = await appendSnapshots({ ...BASE_PARAMS, rows });
      
      // Should NOT throw - just return failure
      expect(result.success).toBe(false);
      expect(result.inserted).toBe(0);
      expect(result.error).toContain('Network error');
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================
  
  describe('Edge Cases', () => {
    it('returns success with 0 inserted for empty rows array', async () => {
      const result = await appendSnapshots({
        ...BASE_PARAMS,
        rows: [],
      });
      
      expect(result.success).toBe(true);
      expect(result.inserted).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();  // Should skip API call
    });

    it('includes onset_delta_days when provided', async () => {
      const rows: SnapshotRow[] = [
        { anchor_day: '2025-12-01', X: 100, Y: 15, onset_delta_days: 3.5 },
      ];
      
      await appendSnapshots({ ...BASE_PARAMS, rows });
      
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.rows[0].onset_delta_days).toBe(3.5);
    });

    it('converts retrieved_at Date to ISO string', async () => {
      const timestamp = new Date('2025-12-10T15:30:45.123Z');
      
      await appendSnapshots({
        ...BASE_PARAMS,
        retrieved_at: timestamp,
        rows: createTestRows(1),
      });
      
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.retrieved_at).toBe('2025-12-10T15:30:45.123Z');
    });
  });

  // ===========================================================================
  // Health Check
  // ===========================================================================
  
  describe('Health Check', () => {
    it('returns ok status when DB is connected', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'ok', db: 'connected' }),
      });
      
      const result = await checkSnapshotHealth();
      
      expect(result.status).toBe('ok');
      expect(result.db).toBe('connected');
    });

    it('returns error status when DB is unavailable', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
      });
      
      const result = await checkSnapshotHealth();
      
      expect(result.status).toBe('error');
    });

    it('handles network errors gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));
      
      const result = await checkSnapshotHealth();
      
      expect(result.status).toBe('error');
      expect(result.error).toContain('Network error');
    });
  });
});
