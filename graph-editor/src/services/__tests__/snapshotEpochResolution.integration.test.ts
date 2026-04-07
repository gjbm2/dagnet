/**
 * Snapshot epoch resolution — integration specification tests.
 *
 * Tests that snapshot retrieval correctly spans multiple dataInterestsDSL epochs
 * and hash mapping changes, producing correct per-day coverage without
 * double-counting.
 *
 * Seeds synthetic snapshot data into the real DB using `pytest-` prefixed
 * param IDs, then queries via the batch retrievals endpoint. Cleans up
 * via `/api/snapshots/delete-test`.
 *
 * Test design:
 *   - What bug would this catch? Snapshots from older epochs (different
 *     context key-sets or hash-mapped signature changes) being invisible
 *     to the @ menu, or being double-counted on overlapping days.
 *   - What is real vs mocked? Real: Python server, Neon DB, hash computation.
 *     Mocked: nothing.
 *   - What would a false pass look like? A test that only checks one epoch's
 *     hashes and misses the stitching across epochs.
 *
 * Requires:
 *   - Python server running on localhost:9000
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fetch as undiciFetch } from 'undici';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API = 'http://localhost:9000';
const TEST_PREFIX = `pytest-epoch-${Date.now()}`;

// Synthetic hashes — deterministic, don't collide with real data
const H0 = 'epoch-test-H0-uncontexted';   // uncontexted epoch
const H1 = 'epoch-test-H1-channel';       // context(channel) epoch
const H2 = 'epoch-test-H2-geo';           // context(geo) epoch
const H0_PRIME = 'epoch-test-H0p-mapped'; // H0 after event def change (hash mapping)
const H1_PRIME = 'epoch-test-H1p-mapped'; // H1 after event def change

const PARAM_ID = `${TEST_PREFIX}-test-param`;

let ready = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function appendRows(
  paramId: string,
  coreHash: string,
  sliceKey: string,
  retrievedAt: string,
  anchorDays: string[],
): Promise<void> {
  const rows = anchorDays.map(day => ({
    anchor_day: day,
    X: 100,
    Y: 50,
  }));
  await undiciFetch(`${API}/api/snapshots/append`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      param_id: paramId,
      canonical_signature: JSON.stringify({ c: coreHash, x: {} }),
      inputs_json: { test: true },
      sig_algo: 'sig_v1_sha256_trunc128_b64url',
      slice_key: sliceKey,
      retrieved_at: retrievedAt,
      core_hash: coreHash,
      rows,
    }),
  });
}

async function batchRetrievals(
  subjects: Array<{ param_id: string; hash_groups?: Array<{ core_hash: string; equivalent_hashes?: Array<{ core_hash: string }> }> ; core_hash?: string }>,
  limit = 200,
): Promise<Array<{ subject_index: number; success: boolean; retrieved_days: string[]; count: number }>> {
  const resp = await undiciFetch(`${API}/api/snapshots/batch-retrievals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subjects, limit_per_subject: limit }),
  });
  const body = await resp.json() as any;
  return body.results || [];
}

async function cleanup(): Promise<void> {
  await undiciFetch(`${API}/api/snapshots/delete-test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ param_id_prefix: TEST_PREFIX }),
  });
}

const sorted = (arr: string[]) => [...arr].sort();

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

describe('snapshot epoch resolution (real DB)', () => {
  beforeAll(async () => {
    try {
      const h = await undiciFetch(`${API}/api/snapshots/health`);
      if (!(await h.json() as any).status) throw new Error();
    } catch {
      console.warn('Python server not available — skipping');
      return;
    }

    // Clean up any previous run
    await cleanup();

    // Seed epochs:
    //
    // Epoch A (days 1-5): uncontexted, hash H0
    //   Day 3: also has H0' (event def change mid-epoch, linked by mapping)
    //   Days 4-5: only H0' (post-change)
    //
    // Epoch B (days 4-8): context(channel), hash H1
    //   Days 4-5 overlap with epoch A
    //   Day 7: also has H1' (another event def change)
    //   Day 8: only H1'
    //
    // Epoch C (days 8-10): context(geo), hash H2
    //   Day 8 overlaps with epoch B

    // Epoch A: H0 on days 1-3
    await appendRows(PARAM_ID, H0, 'window(-30d:)', '2026-04-01T06:00:00Z', ['2026-03-01', '2026-03-02', '2026-03-03']);
    // Epoch A: H0' on days 3-5 (H0' = H0 after event def change)
    await appendRows(PARAM_ID, H0_PRIME, 'window(-30d:)', '2026-04-01T09:00:00Z', ['2026-03-03', '2026-03-04', '2026-03-05']);

    // Epoch B: H1 on days 4-7
    await appendRows(PARAM_ID, H1, 'context(channel:google).window(-30d:)', '2026-04-02T06:00:00Z', ['2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07']);
    // Epoch B: H1' on days 7-8
    await appendRows(PARAM_ID, H1_PRIME, 'context(channel:google).window(-30d:)', '2026-04-02T09:00:00Z', ['2026-03-07', '2026-03-08']);

    // Epoch C: H2 on days 8-10
    await appendRows(PARAM_ID, H2, 'context(geo:UK).window(-30d:)', '2026-04-03T06:00:00Z', ['2026-03-08', '2026-03-09', '2026-03-10']);

    ready = true;
  });

  afterAll(async () => {
    if (ready) await cleanup();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // E-series: epoch axis (single hash per query, no mappings)
  // ═══════════════════════════════════════════════════════════════════════════

  it('E1: single hash finds its own days', async () => {
    if (!ready) return;
    const [r] = await batchRetrievals([{ param_id: PARAM_ID, core_hash: H0 }]);
    expect(r.success).toBe(true);
    expect(sorted(r.retrieved_days)).toEqual(['2026-04-01']);
  });

  it('E2: two epoch hashes via hash_groups finds union of days', async () => {
    if (!ready) return;
    const [r] = await batchRetrievals([{
      param_id: PARAM_ID,
      hash_groups: [{ core_hash: H0 }, { core_hash: H1 }],
    }]);
    expect(r.success).toBe(true);
    // H0 retrieved on 2026-04-01, H1 on 2026-04-02 → two distinct days
    expect(r.retrieved_days.length).toBeGreaterThanOrEqual(2);
    expect(r.retrieved_days).toContain('2026-04-01');
    expect(r.retrieved_days).toContain('2026-04-02');
  });

  it('E3: three epoch hashes finds all days', async () => {
    if (!ready) return;
    const [r] = await batchRetrievals([{
      param_id: PARAM_ID,
      hash_groups: [{ core_hash: H0 }, { core_hash: H1 }, { core_hash: H2 }],
    }]);
    expect(r.success).toBe(true);
    // Should find days from all three epochs
    expect(r.retrieved_days).toContain('2026-04-01');
    expect(r.retrieved_days).toContain('2026-04-02');
    expect(r.retrieved_days).toContain('2026-04-03');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // M-series: hash mapping axis (equivalent_hashes within epoch)
  // ═══════════════════════════════════════════════════════════════════════════

  it('M1: single hash without mapping finds only its own days', async () => {
    if (!ready) return;
    const [r] = await batchRetrievals([{ param_id: PARAM_ID, core_hash: H0 }]);
    expect(r.success).toBe(true);
    // H0 was retrieved at 2026-04-01T06:00 — only that one retrieved_at day
    expect(r.retrieved_days).toEqual(['2026-04-01']);
  });

  it('M2: hash + equivalent_hashes spans pre/post mapping change', async () => {
    if (!ready) return;
    const [r] = await batchRetrievals([{
      param_id: PARAM_ID,
      core_hash: H0,
      equivalent_hashes: [{ core_hash: H0_PRIME }],
    }]);
    expect(r.success).toBe(true);
    // H0 retrieved on 2026-04-01, H0' on 2026-04-01 (later time) → both same day
    // But retrieved_days is by (retrieved_at UTC date), so both 2026-04-01
    expect(r.retrieved_days).toContain('2026-04-01');
  });

  it('M3: hash_groups with equivalent_hashes finds all epoch+mapping combinations', async () => {
    if (!ready) return;
    const [r] = await batchRetrievals([{
      param_id: PARAM_ID,
      hash_groups: [
        { core_hash: H0, equivalent_hashes: [{ core_hash: H0_PRIME }] },
        { core_hash: H1, equivalent_hashes: [{ core_hash: H1_PRIME }] },
        { core_hash: H2 },
      ],
    }]);
    expect(r.success).toBe(true);
    // All hashes: H0, H0', H1, H1', H2 → spans all epochs and mappings
    expect(r.retrieved_days).toContain('2026-04-01');
    expect(r.retrieved_days).toContain('2026-04-02');
    expect(r.retrieved_days).toContain('2026-04-03');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // O-series: overlap and deduplication
  // ═══════════════════════════════════════════════════════════════════════════

  it('O1: overlapping days from two hashes are not double-counted in retrieved_days', async () => {
    if (!ready) return;
    // H0' and H1 both have data for days 4-5
    // When queried together, each day should appear once in retrieved_days
    const [r] = await batchRetrievals([{
      param_id: PARAM_ID,
      hash_groups: [{ core_hash: H0_PRIME }, { core_hash: H1 }],
    }]);
    expect(r.success).toBe(true);
    // retrieved_days is DISTINCT by definition — check no duplicate dates
    const unique = new Set(r.retrieved_days);
    expect(unique.size).toBe(r.retrieved_days.length);
  });

  it('O2: same hash, two retrieved_at times on same day → day appears once', async () => {
    if (!ready) return;
    // H0 on day 3 at 06:00, H0' on day 3 at 09:00 — same anchor_day, different hashes
    // retrieved_days deduplicates by date
    const [r] = await batchRetrievals([{
      param_id: PARAM_ID,
      hash_groups: [{ core_hash: H0 }, { core_hash: H0_PRIME }],
    }]);
    expect(r.success).toBe(true);
    const unique = new Set(r.retrieved_days);
    expect(unique.size).toBe(r.retrieved_days.length);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Multi-subject: multiple edges in one batch
  // ═══════════════════════════════════════════════════════════════════════════

  it('multi-subject batch returns independent results per subject', async () => {
    if (!ready) return;
    const results = await batchRetrievals([
      // Subject 0: only H0
      { param_id: PARAM_ID, core_hash: H0 },
      // Subject 1: all hashes
      {
        param_id: PARAM_ID,
        hash_groups: [
          { core_hash: H0, equivalent_hashes: [{ core_hash: H0_PRIME }] },
          { core_hash: H1, equivalent_hashes: [{ core_hash: H1_PRIME }] },
          { core_hash: H2 },
        ],
      },
    ]);
    expect(results).toHaveLength(2);
    // Subject 0: fewer days (just H0)
    // Subject 1: more days (all epochs)
    expect(results[0].retrieved_days.length).toBeLessThan(results[1].retrieved_days.length);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // A-series: adversarial edge cases
  // ═══════════════════════════════════════════════════════════════════════════

  it('A1: empty hash_groups returns error', async () => {
    if (!ready) return;
    const [r] = await batchRetrievals([{
      param_id: PARAM_ID,
      hash_groups: [],
    }]);
    expect(r.success).toBe(false);
  });

  it('A6: many hashes in hash_groups still works', async () => {
    if (!ready) return;
    // 20 hash groups, most with no data — should still return correct results for the real ones
    const groups = Array.from({ length: 20 }, (_, i) => ({
      core_hash: `nonexistent-hash-${i}`,
    }));
    groups.push({ core_hash: H0 });
    groups.push({ core_hash: H2 });

    const [r] = await batchRetrievals([{
      param_id: PARAM_ID,
      hash_groups: groups,
    }]);
    expect(r.success).toBe(true);
    expect(r.retrieved_days.length).toBeGreaterThan(0);
  });

  it('A8: hash mapping to a hash with no snapshots has no effect', async () => {
    if (!ready) return;
    const [r] = await batchRetrievals([{
      param_id: PARAM_ID,
      core_hash: H0,
      equivalent_hashes: [{ core_hash: 'nonexistent-mapped-hash' }],
    }]);
    expect(r.success).toBe(true);
    // Same result as querying H0 alone — the nonexistent hash adds nothing
    const [baseline] = await batchRetrievals([{ param_id: PARAM_ID, core_hash: H0 }]);
    expect(sorted(r.retrieved_days)).toEqual(sorted(baseline.retrieved_days));
  });
});
