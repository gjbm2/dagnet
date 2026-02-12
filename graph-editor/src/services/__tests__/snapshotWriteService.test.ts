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
import {
  appendSnapshots,
  checkSnapshotHealth,
  querySnapshotsFull,
  querySnapshotsVirtual,
  querySnapshotRetrievals,
  batchAnchorCoverage,
  getBatchInventoryV2,
} from '../snapshotWriteService';

// Test fixtures
const BASE_PARAMS: Omit<AppendSnapshotsParams, 'rows'> = {
  param_id: 'test-repo-test-branch-checkout-conversion',
  canonical_signature: '{"c":"pytest-snapshotWriteService","x":{}}',
  inputs_json: { schema: 'pytest_flexi_sigs_v1', note: 'unit test' },
  sig_algo: 'sig_v1_sha256_trunc128_b64url',
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
        canonical_signature: '{"c":"xyz789","x":{}}',
        inputs_json: { schema: 'pytest_flexi_sigs_v1' },
        sig_algo: 'sig_v1_sha256_trunc128_b64url',
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
    it('SI-001: canonical_signature passed correctly', async () => {
      const rows = createTestRows(3);
      const canonicalSignature = '{"c":"unique-sig","x":{}}';
      
      await appendSnapshots({
        ...BASE_PARAMS,
        canonical_signature: canonicalSignature,
        rows,
      });
      
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.canonical_signature).toBe(canonicalSignature);
      // Frontend now computes and sends core_hash (hash-fixes.md Phase 2)
      expect(body.core_hash).toBeDefined();
      expect(typeof body.core_hash).toBe('string');
      expect(body.core_hash.length).toBeGreaterThan(0);
    });

    it('SI-002: cohort vs window should have different canonical_signature', async () => {
      const cohortSig = '{"c":"cohort-mode","x":{}}';
      const windowSig = '{"c":"window-mode","x":{}}';
      
      await appendSnapshots({
        ...BASE_PARAMS,
        canonical_signature: cohortSig,
        rows: [{ anchor_day: '2025-12-01', A: 100, X: 80, Y: 10 }],
      });
      
      await appendSnapshots({
        ...BASE_PARAMS,
        canonical_signature: windowSig,
        rows: [{ anchor_day: '2025-12-01', X: 80, Y: 10 }],
      });
      
      const body1 = JSON.parse(mockFetch.mock.calls[0][1].body);
      const body2 = JSON.parse(mockFetch.mock.calls[1][1].body);
      
      expect(body1.canonical_signature).toBe(cohortSig);
      expect(body2.canonical_signature).toBe(windowSig);
      expect(body1.canonical_signature).not.toBe(body2.canonical_signature);
    });

    it('SI-003: signature_stable_across_writes - same query produces same canonical_signature', async () => {
      const stableSig = '{"c":"stable-query","x":{}}';
      const rows = createTestRows(3);
      
      await appendSnapshots({ ...BASE_PARAMS, canonical_signature: stableSig, rows });
      await appendSnapshots({ ...BASE_PARAMS, canonical_signature: stableSig, rows });
      
      const body1 = JSON.parse(mockFetch.mock.calls[0][1].body);
      const body2 = JSON.parse(mockFetch.mock.calls[1][1].body);
      
      expect(body1.canonical_signature).toBe(body2.canonical_signature);
    });

    it('SI-004: inputs_json is sent (JSON object)', async () => {
      await appendSnapshots({ ...BASE_PARAMS, inputs_json: { schema: 'pytest_flexi_sigs_v1', a: 1 }, rows: createTestRows(1) });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.inputs_json).toEqual({ schema: 'pytest_flexi_sigs_v1', a: 1 });
    });

    it('SI-005: sig_algo is sent', async () => {
      await appendSnapshots({ ...BASE_PARAMS, sig_algo: 'sig_v1_sha256_trunc128_b64url', rows: createTestRows(1) });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.sig_algo).toBe('sig_v1_sha256_trunc128_b64url');
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

  // ===========================================================================
  // EH-*: Equivalent Hashes — FE request body contract
  //
  // These tests verify that the FE-to-BE contract for the new hash-mappings
  // migration is correct: when equivalent_hashes is provided, it appears in
  // the request body. When absent, neither equivalent_hashes nor
  // include_equivalents is sent (BE queries seed hash only).
  // ===========================================================================

  describe('Equivalent Hashes request-body contract (EH-*)', () => {
    const CLOSURE = [
      { core_hash: 'hash-B', operation: 'equivalent', weight: 1.0 },
      { core_hash: 'hash-C', operation: 'equivalent', weight: 1.0 },
    ];

    // ── querySnapshotsFull ──────────────────────────────────────────────

    it('EH-001: querySnapshotsFull sends equivalent_hashes and omits include_equivalents when closure provided', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true, rows: [], count: 0 }) });

      await querySnapshotsFull({
        param_id: 'repo-main-param-x',
        core_hash: 'hash-A',
        equivalent_hashes: CLOSURE,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.equivalent_hashes).toEqual(CLOSURE);
      expect(body.include_equivalents).toBeUndefined();
    });

    it('EH-002: querySnapshotsFull omits equivalent_hashes when closure not provided', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true, rows: [], count: 0 }) });

      await querySnapshotsFull({
        param_id: 'repo-main-param-x',
        core_hash: 'hash-A',
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.equivalent_hashes).toBeUndefined();
    });

    // ── querySnapshotsVirtual ───────────────────────────────────────────

    it('EH-003: querySnapshotsVirtual sends equivalent_hashes and sets include_equivalents=undefined when closure provided', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true, rows: [], count: 0, latest_retrieved_at_used: null, has_anchor_to: false }) });

      await querySnapshotsVirtual({
        param_id: 'repo-main-param-x',
        as_at: '2025-12-10T00:00:00Z',
        anchor_from: '2025-12-01',
        anchor_to: '2025-12-10',
        canonical_signature: '{"c":"test","x":{}}',
        equivalent_hashes: CLOSURE,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.equivalent_hashes).toEqual(CLOSURE);
      expect(body.include_equivalents).toBeUndefined();
    });

    it('EH-004: querySnapshotsVirtual omits both equivalent_hashes and include_equivalents when no closure', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true, rows: [], count: 0, latest_retrieved_at_used: null, has_anchor_to: false }) });

      await querySnapshotsVirtual({
        param_id: 'repo-main-param-x',
        as_at: '2025-12-10T00:00:00Z',
        anchor_from: '2025-12-01',
        anchor_to: '2025-12-10',
        canonical_signature: '{"c":"test","x":{}}',
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.equivalent_hashes).toBeUndefined();
      expect(body.include_equivalents).toBeUndefined();
    });

    // ── querySnapshotRetrievals ─────────────────────────────────────────

    it('EH-005: querySnapshotRetrievals sends equivalent_hashes and omits include_equivalents when closure provided', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true, retrieved_at: [], retrieved_days: [], latest_retrieved_at: null, count: 0 }) });

      await querySnapshotRetrievals({
        param_id: 'repo-main-param-x',
        core_hash: 'hash-A',
        equivalent_hashes: CLOSURE,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.equivalent_hashes).toEqual(CLOSURE);
      expect(body.include_equivalents).toBeUndefined();
    });

    it('EH-006: querySnapshotRetrievals omits both when no closure', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true, retrieved_at: [], retrieved_days: [], latest_retrieved_at: null, count: 0 }) });

      await querySnapshotRetrievals({
        param_id: 'repo-main-param-x',
        core_hash: 'hash-A',
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.equivalent_hashes).toBeUndefined();
      expect(body.include_equivalents).toBeUndefined();
    });

    // ── batchAnchorCoverage ─────────────────────────────────────────────

    it('EH-007: batchAnchorCoverage sends per-subject equivalent_hashes and omits include_equivalents', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ results: [{ subject_index: 0, coverage_ok: true, missing_anchor_ranges: [], present_anchor_day_count: 5, expected_anchor_day_count: 5, equivalence_resolution: { core_hashes: [], param_ids: [] } }] }) });

      await batchAnchorCoverage([{
        param_id: 'repo-main-param-x',
        core_hash: 'hash-A',
        slice_keys: ['window()'],
        anchor_from: '2025-12-01',
        anchor_to: '2025-12-05',
        equivalent_hashes: CLOSURE,
      }]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const subj = body.subjects[0];
      expect(subj.equivalent_hashes).toEqual(CLOSURE);
      expect(subj.include_equivalents).toBeUndefined();
    });

    it('EH-008: batchAnchorCoverage omits both per subject when no closure', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ results: [{ subject_index: 0, coverage_ok: true, missing_anchor_ranges: [], present_anchor_day_count: 5, expected_anchor_day_count: 5, equivalence_resolution: { core_hashes: [], param_ids: [] } }] }) });

      await batchAnchorCoverage([{
        param_id: 'repo-main-param-x',
        core_hash: 'hash-A',
        slice_keys: ['window()'],
        anchor_from: '2025-12-01',
        anchor_to: '2025-12-05',
      }]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const subj = body.subjects[0];
      expect(subj.equivalent_hashes).toBeUndefined();
      expect(subj.include_equivalents).toBeUndefined();
    });

    // ── getBatchInventoryV2 ─────────────────────────────────────────────

    it('EH-009: getBatchInventoryV2 sends equivalent_hashes_by_param and omits include_equivalents', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true, inventory_version: 2, inventory: {} }) });

      await getBatchInventoryV2(['repo-main-param-x'], {
        equivalent_hashes_by_param: { 'repo-main-param-x': CLOSURE },
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.equivalent_hashes_by_param).toEqual({ 'repo-main-param-x': CLOSURE });
      expect(body.include_equivalents).toBeUndefined();
    });

    it('EH-010: getBatchInventoryV2 omits both when no closure map', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true, inventory_version: 2, inventory: {} }) });

      await getBatchInventoryV2(['repo-main-param-x']);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.equivalent_hashes_by_param).toBeUndefined();
      expect(body.include_equivalents).toBeUndefined();
    });
  });
});
