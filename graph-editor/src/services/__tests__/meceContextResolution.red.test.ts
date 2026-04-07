/**
 * RED TESTS: MECE context resolution across arbitrary slice topologies.
 *
 * These tests define the EXPECTED behaviour for resolving queries against
 * stored context-sliced data. They test the contract, not the implementation.
 *
 * Three inputs only:
 *   (a) what slices are present in the files (ParameterValue[])
 *   (b) what context definitions say about completeness (MECE status per key)
 *   (c) the queryDSL
 *
 * NO reference to dataInterestsDSL — that is used upstream to generate the
 * slices, but resolution must work from stored state alone.
 *
 * Slice topologies tested:
 *   - Single-key slices (from semicolon DSL patterns)
 *   - Multi-key slices (from dot-product DSL patterns)
 *   - Mixed single-key + multi-key slices
 *   - Arbitrarily deep cross-products (3+ keys)
 *   - Incomplete cross-products (missing cells)
 *   - Mixed MECE + non-MECE dimensions
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ParameterValue } from '../../types/parameterData';
import { selectImplicitUncontextedSliceSetSync } from '../meceSliceService';
import { contextRegistry } from '../contextRegistry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a ParameterValue with the minimum fields needed for resolution. */
function pv(args: {
  sliceDSL: string;
  retrieved_at: string;
  query_signature?: string | null;
  n?: number;
  k?: number;
  dates?: string[];
  n_daily?: number[];
  k_daily?: number[];
}): ParameterValue {
  return {
    sliceDSL: args.sliceDSL,
    dates: args.dates ?? ['2026-04-01'],
    n_daily: args.n_daily ?? [100],
    k_daily: args.k_daily ?? [50],
    n: args.n ?? 100,
    k: args.k ?? 50,
    window_from: '1-Mar-26',
    window_to: '1-Apr-26',
    query_signature: (args as any).query_signature ?? null,
    data_source: { type: 'amplitude', retrieved_at: args.retrieved_at } as any,
  } as any;
}

/**
 * Configure which context keys are MECE and their expected values.
 *
 * Keys not in this map are treated as non-MECE (policy='undefined').
 * Keys mapped to a string[] are MECE with those expected values.
 */
function mockMECEStatus(meceKeys: Record<string, string[]>) {
  vi.spyOn(contextRegistry, 'detectMECEPartitionSync').mockImplementation(
    (windows: any[], key: string) => {
      const expected = meceKeys[key];
      if (!expected) {
        return {
          isMECE: false,
          isComplete: false,
          canAggregate: false,
          missingValues: [],
          policy: 'undefined',
        } as any;
      }

      const present = new Set<string>();
      for (const w of windows || []) {
        const dsl = String((w as any)?.sliceDSL ?? '');
        // Extract value for this key from potentially multi-key DSL
        const re = new RegExp(`context\\(\\s*${key}\\s*:\\s*([^)]+)\\s*\\)`);
        const m = dsl.match(re);
        if (m) present.add(m[1].trim());
      }
      const missing = expected.filter((v) => !present.has(v));
      return {
        isMECE: true,
        isComplete: missing.length === 0,
        canAggregate: missing.length === 0,
        missingValues: missing,
        policy: 'null',
      } as any;
    }
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MECE context resolution — single-key slices (semicolon pattern)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('L1: one MECE dim, uncontexted query → aggregate over it', () => {
    mockMECEStatus({ channel: ['google', 'meta'] });
    const values = [
      pv({ sliceDSL: 'context(channel:google)', retrieved_at: '2026-04-07T06:00:00Z' }),
      pv({ sliceDSL: 'context(channel:meta)', retrieved_at: '2026-04-07T06:00:00Z' }),
    ];
    const r = selectImplicitUncontextedSliceSetSync({ candidateValues: values, requireCompleteMECE: true });
    expect(r.kind).toBe('mece_partition');
    if (r.kind === 'mece_partition') {
      expect(r.key).toBe('channel');
      expect(r.values).toHaveLength(2);
    }
  });

  it('L2: two MECE dims (semicolon), uncontexted → pick one (freshest)', () => {
    mockMECEStatus({
      channel: ['google', 'meta'],
      geo: ['UK', 'US'],
    });
    const values = [
      // channel slices — older
      pv({ sliceDSL: 'context(channel:google)', retrieved_at: '2026-04-06T06:00:00Z', query_signature: 'sig-ch' }),
      pv({ sliceDSL: 'context(channel:meta)', retrieved_at: '2026-04-06T06:00:00Z', query_signature: 'sig-ch' }),
      // geo slices — newer
      pv({ sliceDSL: 'context(geo:UK)', retrieved_at: '2026-04-07T06:00:00Z', query_signature: 'sig-geo' }),
      pv({ sliceDSL: 'context(geo:US)', retrieved_at: '2026-04-07T06:00:00Z', query_signature: 'sig-geo' }),
    ];
    const r = selectImplicitUncontextedSliceSetSync({ candidateValues: values, requireCompleteMECE: true });
    expect(r.kind).toBe('mece_partition');
    if (r.kind === 'mece_partition') {
      expect(r.key).toBe('geo'); // newer
      expect(r.values).toHaveLength(2);
    }
  });

  it('L3: two dims, only one MECE, uncontexted → pick MECE one', () => {
    mockMECEStatus({ channel: ['google', 'meta'] }); // geo is NOT MECE
    const values = [
      pv({ sliceDSL: 'context(channel:google)', retrieved_at: '2026-04-07T06:00:00Z', query_signature: 'sig-ch' }),
      pv({ sliceDSL: 'context(channel:meta)', retrieved_at: '2026-04-07T06:00:00Z', query_signature: 'sig-ch' }),
      pv({ sliceDSL: 'context(geo:UK)', retrieved_at: '2026-04-07T06:00:00Z', query_signature: 'sig-geo' }),
      pv({ sliceDSL: 'context(geo:US)', retrieved_at: '2026-04-07T06:00:00Z', query_signature: 'sig-geo' }),
    ];
    const r = selectImplicitUncontextedSliceSetSync({ candidateValues: values, requireCompleteMECE: true });
    expect(r.kind).toBe('mece_partition');
    if (r.kind === 'mece_partition') {
      expect(r.key).toBe('channel');
    }
  });

  it('L4: two dims, neither MECE, uncontexted → not_resolvable', () => {
    mockMECEStatus({}); // nothing is MECE
    const values = [
      pv({ sliceDSL: 'context(channel:google)', retrieved_at: '2026-04-07T06:00:00Z' }),
      pv({ sliceDSL: 'context(geo:UK)', retrieved_at: '2026-04-07T06:00:00Z' }),
    ];
    const r = selectImplicitUncontextedSliceSetSync({ candidateValues: values, requireCompleteMECE: true });
    expect(r.kind).toBe('not_resolvable');
  });

  it('L5: three MECE dims (semicolon), uncontexted → pick one of three', () => {
    mockMECEStatus({
      channel: ['google', 'meta'],
      geo: ['UK', 'US'],
      device: ['mobile', 'desktop'],
    });
    const values = [
      pv({ sliceDSL: 'context(channel:google)', retrieved_at: '2026-04-05T06:00:00Z', query_signature: 'sig-ch' }),
      pv({ sliceDSL: 'context(channel:meta)', retrieved_at: '2026-04-05T06:00:00Z', query_signature: 'sig-ch' }),
      pv({ sliceDSL: 'context(geo:UK)', retrieved_at: '2026-04-06T06:00:00Z', query_signature: 'sig-geo' }),
      pv({ sliceDSL: 'context(geo:US)', retrieved_at: '2026-04-06T06:00:00Z', query_signature: 'sig-geo' }),
      pv({ sliceDSL: 'context(device:mobile)', retrieved_at: '2026-04-07T06:00:00Z', query_signature: 'sig-dev' }),
      pv({ sliceDSL: 'context(device:desktop)', retrieved_at: '2026-04-07T06:00:00Z', query_signature: 'sig-dev' }),
    ];
    const r = selectImplicitUncontextedSliceSetSync({ candidateValues: values, requireCompleteMECE: true });
    expect(r.kind).toBe('mece_partition');
    if (r.kind === 'mece_partition') {
      expect(r.key).toBe('device'); // newest
      expect(r.values).toHaveLength(2);
    }
  });

  it('L7: two MECE dims, one complete one incomplete, uncontexted → pick complete', () => {
    mockMECEStatus({
      channel: ['google', 'meta'],
      geo: ['UK', 'US', 'DE'], // 3 expected but only 2 present
    });
    const values = [
      pv({ sliceDSL: 'context(channel:google)', retrieved_at: '2026-04-06T06:00:00Z', query_signature: 'sig-ch' }),
      pv({ sliceDSL: 'context(channel:meta)', retrieved_at: '2026-04-06T06:00:00Z', query_signature: 'sig-ch' }),
      // geo newer but incomplete (missing DE)
      pv({ sliceDSL: 'context(geo:UK)', retrieved_at: '2026-04-07T06:00:00Z', query_signature: 'sig-geo' }),
      pv({ sliceDSL: 'context(geo:US)', retrieved_at: '2026-04-07T06:00:00Z', query_signature: 'sig-geo' }),
    ];
    const r = selectImplicitUncontextedSliceSetSync({ candidateValues: values, requireCompleteMECE: true });
    expect(r.kind).toBe('mece_partition');
    if (r.kind === 'mece_partition') {
      expect(r.key).toBe('channel'); // geo is incomplete, channel wins
    }
  });
});

describe('MECE context resolution — multi-key slices (dot-product pattern)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('L8: context(a).context(b) both MECE, uncontexted → aggregate ALL cross-product slices', () => {
    mockMECEStatus({
      channel: ['google', 'meta'],
      geo: ['UK', 'US'],
    });
    // 2x2 = 4 cross-product slices
    const values = [
      pv({ sliceDSL: 'context(channel:google).context(geo:UK)', retrieved_at: '2026-04-07T06:00:00Z' }),
      pv({ sliceDSL: 'context(channel:google).context(geo:US)', retrieved_at: '2026-04-07T06:00:00Z' }),
      pv({ sliceDSL: 'context(channel:meta).context(geo:UK)', retrieved_at: '2026-04-07T06:00:00Z' }),
      pv({ sliceDSL: 'context(channel:meta).context(geo:US)', retrieved_at: '2026-04-07T06:00:00Z' }),
    ];
    const r = selectImplicitUncontextedSliceSetSync({ candidateValues: values, requireCompleteMECE: true });
    // Must aggregate all 4 slices — they partition the population
    expect(r.kind).toBe('mece_partition');
    if (r.kind === 'mece_partition') {
      expect(r.values).toHaveLength(4);
    }
  });

  it('L9: context(a).context(b), query context(a:v1) → aggregate over b for a=v1', async () => {
    mockMECEStatus({
      channel: ['google', 'meta'],
      geo: ['UK', 'US'],
    });
    const values = [
      pv({ sliceDSL: 'context(channel:google).context(geo:UK)', retrieved_at: '2026-04-07T06:00:00Z', n: 100, k: 40, dates: ['2026-04-01'], n_daily: [100], k_daily: [40] }),
      pv({ sliceDSL: 'context(channel:google).context(geo:US)', retrieved_at: '2026-04-07T06:00:00Z', n: 200, k: 80, dates: ['2026-04-01'], n_daily: [200], k_daily: [80] }),
      pv({ sliceDSL: 'context(channel:meta).context(geo:UK)', retrieved_at: '2026-04-07T06:00:00Z', n: 150, k: 60, dates: ['2026-04-01'], n_daily: [150], k_daily: [60] }),
      pv({ sliceDSL: 'context(channel:meta).context(geo:US)', retrieved_at: '2026-04-07T06:00:00Z', n: 250, k: 100, dates: ['2026-04-01'], n_daily: [250], k_daily: [100] }),
    ];

    // Query: context(channel:google) — should aggregate over geo for channel=google
    // Expected: n = 100 + 200 = 300, k = 40 + 80 = 120
    const { tryDimensionalReduction } = await import('../dimensionalReductionService');
    const r = tryDimensionalReduction(values, 'context(channel:google)');
    expect(r.kind).toBe('reduced');
    if (r.kind === 'reduced' && r.aggregatedValues) {
      expect(r.aggregatedValues).toHaveLength(1);
      expect(r.aggregatedValues[0].n).toBe(300);
      expect(r.aggregatedValues[0].k).toBe(120);
    }
  });

  it('L10: context(a).context(b), query context(b:w1) → aggregate over a for b=w1', async () => {
    mockMECEStatus({
      channel: ['google', 'meta'],
      geo: ['UK', 'US'],
    });
    const values = [
      pv({ sliceDSL: 'context(channel:google).context(geo:UK)', retrieved_at: '2026-04-07T06:00:00Z', n: 100, k: 40, dates: ['2026-04-01'], n_daily: [100], k_daily: [40] }),
      pv({ sliceDSL: 'context(channel:google).context(geo:US)', retrieved_at: '2026-04-07T06:00:00Z', n: 200, k: 80, dates: ['2026-04-01'], n_daily: [200], k_daily: [80] }),
      pv({ sliceDSL: 'context(channel:meta).context(geo:UK)', retrieved_at: '2026-04-07T06:00:00Z', n: 150, k: 60, dates: ['2026-04-01'], n_daily: [150], k_daily: [60] }),
      pv({ sliceDSL: 'context(channel:meta).context(geo:US)', retrieved_at: '2026-04-07T06:00:00Z', n: 250, k: 100, dates: ['2026-04-01'], n_daily: [250], k_daily: [100] }),
    ];

    // Query: context(geo:UK) — should aggregate over channel for geo=UK
    // Expected: n = 100 + 150 = 250, k = 40 + 60 = 100
    const { tryDimensionalReduction } = await import('../dimensionalReductionService');
    const r = tryDimensionalReduction(values, 'context(geo:UK)');
    expect(r.kind).toBe('reduced');
    if (r.kind === 'reduced' && r.aggregatedValues) {
      expect(r.aggregatedValues).toHaveLength(1);
      expect(r.aggregatedValues[0].n).toBe(250);
      expect(r.aggregatedValues[0].k).toBe(100);
    }
  });

  it('L11: context(a).context(b), a MECE b NOT MECE, uncontexted → not_resolvable', () => {
    mockMECEStatus({ channel: ['google', 'meta'] }); // geo NOT MECE
    const values = [
      pv({ sliceDSL: 'context(channel:google).context(geo:UK)', retrieved_at: '2026-04-07T06:00:00Z' }),
      pv({ sliceDSL: 'context(channel:google).context(geo:US)', retrieved_at: '2026-04-07T06:00:00Z' }),
      pv({ sliceDSL: 'context(channel:meta).context(geo:UK)', retrieved_at: '2026-04-07T06:00:00Z' }),
      pv({ sliceDSL: 'context(channel:meta).context(geo:US)', retrieved_at: '2026-04-07T06:00:00Z' }),
    ];
    const r = selectImplicitUncontextedSliceSetSync({ candidateValues: values, requireCompleteMECE: true });
    // Cannot aggregate — geo is not MECE so cross-product doesn't partition
    expect(r.kind).toBe('not_resolvable');
  });

  it('L12: context(a).context(b) both MECE but missing cell → not_resolvable', () => {
    mockMECEStatus({
      channel: ['google', 'meta'],
      geo: ['UK', 'US'],
    });
    // Only 3 of 4 cross-product cells present
    const values = [
      pv({ sliceDSL: 'context(channel:google).context(geo:UK)', retrieved_at: '2026-04-07T06:00:00Z' }),
      pv({ sliceDSL: 'context(channel:google).context(geo:US)', retrieved_at: '2026-04-07T06:00:00Z' }),
      pv({ sliceDSL: 'context(channel:meta).context(geo:UK)', retrieved_at: '2026-04-07T06:00:00Z' }),
      // MISSING: context(channel:meta).context(geo:US)
    ];
    const r = selectImplicitUncontextedSliceSetSync({ candidateValues: values, requireCompleteMECE: true });
    expect(r.kind).toBe('not_resolvable');
  });

  it('L13: context(a).context(b), query context(a:v1), b NOT MECE → cannot aggregate', async () => {
    mockMECEStatus({ channel: ['google', 'meta'] }); // geo NOT MECE
    const values = [
      pv({ sliceDSL: 'context(channel:google).context(geo:UK)', retrieved_at: '2026-04-07T06:00:00Z' }),
      pv({ sliceDSL: 'context(channel:google).context(geo:US)', retrieved_at: '2026-04-07T06:00:00Z' }),
      pv({ sliceDSL: 'context(channel:meta).context(geo:UK)', retrieved_at: '2026-04-07T06:00:00Z' }),
      pv({ sliceDSL: 'context(channel:meta).context(geo:US)', retrieved_at: '2026-04-07T06:00:00Z' }),
    ];

    const { tryDimensionalReduction } = await import('../dimensionalReductionService');
    const r = tryDimensionalReduction(values, 'context(channel:google)');
    // Cannot aggregate over geo because geo is not MECE
    expect(r.kind).toBe('not_reducible');
  });

  it('L14: 3-key cross-product, all MECE, uncontexted → aggregate all N*M*P slices', () => {
    mockMECEStatus({
      channel: ['google', 'meta'],
      geo: ['UK', 'US'],
      device: ['mobile', 'desktop'],
    });
    // 2x2x2 = 8 slices
    const combos = [];
    for (const ch of ['google', 'meta']) {
      for (const geo of ['UK', 'US']) {
        for (const dev of ['mobile', 'desktop']) {
          combos.push(pv({
            sliceDSL: `context(channel:${ch}).context(device:${dev}).context(geo:${geo})`,
            retrieved_at: '2026-04-07T06:00:00Z',
          }));
        }
      }
    }
    const r = selectImplicitUncontextedSliceSetSync({ candidateValues: combos, requireCompleteMECE: true });
    expect(r.kind).toBe('mece_partition');
    if (r.kind === 'mece_partition') {
      expect(r.values).toHaveLength(8);
    }
  });
});

describe('MECE context resolution — mixed slices (semicolon + dot-product)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('L15: cross-product(a,b) + single-key(c), all MECE, uncontexted → pick one route', () => {
    mockMECEStatus({
      channel: ['google', 'meta'],
      geo: ['UK', 'US'],
      device: ['mobile', 'desktop'],
    });
    const values = [
      // Cross-product of channel x geo (4 slices, older)
      pv({ sliceDSL: 'context(channel:google).context(geo:UK)', retrieved_at: '2026-04-06T06:00:00Z', query_signature: 'sig-chgeo' }),
      pv({ sliceDSL: 'context(channel:google).context(geo:US)', retrieved_at: '2026-04-06T06:00:00Z', query_signature: 'sig-chgeo' }),
      pv({ sliceDSL: 'context(channel:meta).context(geo:UK)', retrieved_at: '2026-04-06T06:00:00Z', query_signature: 'sig-chgeo' }),
      pv({ sliceDSL: 'context(channel:meta).context(geo:US)', retrieved_at: '2026-04-06T06:00:00Z', query_signature: 'sig-chgeo' }),
      // Single-key device slices (2 slices, newer)
      pv({ sliceDSL: 'context(device:mobile)', retrieved_at: '2026-04-07T06:00:00Z', query_signature: 'sig-dev' }),
      pv({ sliceDSL: 'context(device:desktop)', retrieved_at: '2026-04-07T06:00:00Z', query_signature: 'sig-dev' }),
    ];
    const r = selectImplicitUncontextedSliceSetSync({ candidateValues: values, requireCompleteMECE: true });
    expect(r.kind).toBe('mece_partition');
    if (r.kind === 'mece_partition') {
      // Should pick device (newer) OR (channel x geo) — but NOT both
      // Either is valid as long as only one route is used
      const usedSliceCount = r.values.length;
      expect([2, 4]).toContain(usedSliceCount); // either 2 (device) or 4 (channel x geo)
      // And all values should be from the same route (no mixing)
      const keys = new Set(r.values.map(v => {
        const dims = v.sliceDSL ?? '';
        const matches = dims.match(/context\([^)]+\)/g) || [];
        return matches.length;
      }));
      expect(keys.size).toBe(1); // all single-key or all multi-key, not mixed
    }
  });

  it('L16: cross-product(a,b) + single-key(c), query context(a:v1) → reduce over b, ignore c', async () => {
    mockMECEStatus({
      channel: ['google', 'meta'],
      geo: ['UK', 'US'],
      device: ['mobile', 'desktop'],
    });
    const values = [
      pv({ sliceDSL: 'context(channel:google).context(geo:UK)', retrieved_at: '2026-04-07T06:00:00Z', n: 100, k: 40, dates: ['2026-04-01'], n_daily: [100], k_daily: [40] }),
      pv({ sliceDSL: 'context(channel:google).context(geo:US)', retrieved_at: '2026-04-07T06:00:00Z', n: 200, k: 80, dates: ['2026-04-01'], n_daily: [200], k_daily: [80] }),
      pv({ sliceDSL: 'context(channel:meta).context(geo:UK)', retrieved_at: '2026-04-07T06:00:00Z', n: 150, k: 60, dates: ['2026-04-01'], n_daily: [150], k_daily: [60] }),
      pv({ sliceDSL: 'context(channel:meta).context(geo:US)', retrieved_at: '2026-04-07T06:00:00Z', n: 250, k: 100, dates: ['2026-04-01'], n_daily: [250], k_daily: [100] }),
      pv({ sliceDSL: 'context(device:mobile)', retrieved_at: '2026-04-07T06:00:00Z', n: 500, k: 200, dates: ['2026-04-01'], n_daily: [500], k_daily: [200] }),
      pv({ sliceDSL: 'context(device:desktop)', retrieved_at: '2026-04-07T06:00:00Z', n: 200, k: 80, dates: ['2026-04-01'], n_daily: [200], k_daily: [80] }),
    ];

    const { tryDimensionalReduction } = await import('../dimensionalReductionService');
    const r = tryDimensionalReduction(values, 'context(channel:google)');
    expect(r.kind).toBe('reduced');
    if (r.kind === 'reduced' && r.aggregatedValues) {
      // Should use the cross-product slices for channel=google, aggregate over geo
      // n = 100 + 200 = 300, k = 40 + 80 = 120
      expect(r.aggregatedValues[0].n).toBe(300);
      expect(r.aggregatedValues[0].k).toBe(120);
    }
  });

  it('L17: cross-product(a,b) + single-key(c), query context(c:x1) → direct match', async () => {
    mockMECEStatus({
      channel: ['google', 'meta'],
      geo: ['UK', 'US'],
      device: ['mobile', 'desktop'],
    });
    const values = [
      pv({ sliceDSL: 'context(channel:google).context(geo:UK)', retrieved_at: '2026-04-07T06:00:00Z' }),
      pv({ sliceDSL: 'context(channel:google).context(geo:US)', retrieved_at: '2026-04-07T06:00:00Z' }),
      pv({ sliceDSL: 'context(channel:meta).context(geo:UK)', retrieved_at: '2026-04-07T06:00:00Z' }),
      pv({ sliceDSL: 'context(channel:meta).context(geo:US)', retrieved_at: '2026-04-07T06:00:00Z' }),
      pv({ sliceDSL: 'context(device:mobile)', retrieved_at: '2026-04-07T06:00:00Z', n: 500, k: 200 }),
      pv({ sliceDSL: 'context(device:desktop)', retrieved_at: '2026-04-07T06:00:00Z', n: 200, k: 80 }),
    ];

    const { isolateSlice } = await import('../sliceIsolation');
    const result = isolateSlice(values, 'context(device:mobile)');
    expect(result).toHaveLength(1);
    expect(result[0].n).toBe(500);
  });
});

describe('MECE context resolution — edge cases', () => {
  afterEach(() => vi.restoreAllMocks());

  it('L18: duplicate context key context(a).context(a) should deduplicate', () => {
    // This is a degenerate case — should not produce cross-product of a with itself
    mockMECEStatus({ channel: ['google', 'meta'] });
    const values = [
      // These slices have the same key twice — should be treated as single-key
      pv({ sliceDSL: 'context(channel:google).context(channel:google)', retrieved_at: '2026-04-07T06:00:00Z' }),
      pv({ sliceDSL: 'context(channel:meta).context(channel:meta)', retrieved_at: '2026-04-07T06:00:00Z' }),
    ];
    const r = selectImplicitUncontextedSliceSetSync({ candidateValues: values, requireCompleteMECE: true });
    // Should still be resolvable — effectively single-key
    expect(r.kind).toBe('mece_partition');
    if (r.kind === 'mece_partition') {
      expect(r.values).toHaveLength(2);
    }
  });

  it('L19: context definition not loaded → fail-safe, cannot aggregate', () => {
    // Mock: no context definitions loaded at all
    vi.spyOn(contextRegistry, 'detectMECEPartitionSync').mockReturnValue({
      isMECE: false,
      isComplete: false,
      canAggregate: false,
      missingValues: [],
      policy: 'unknown',
    } as any);

    const values = [
      pv({ sliceDSL: 'context(channel:google)', retrieved_at: '2026-04-07T06:00:00Z' }),
      pv({ sliceDSL: 'context(channel:meta)', retrieved_at: '2026-04-07T06:00:00Z' }),
    ];
    const r = selectImplicitUncontextedSliceSetSync({ candidateValues: values, requireCompleteMECE: true });
    expect(r.kind).toBe('not_resolvable');
  });

  it('L20: 3-key cross-product, query with 2 specified keys → reduce over 1 remaining', async () => {
    mockMECEStatus({
      channel: ['google', 'meta'],
      geo: ['UK', 'US'],
      device: ['mobile', 'desktop'],
    });
    // 2x2x2 = 8 slices
    const values = [];
    for (const ch of ['google', 'meta']) {
      for (const geo of ['UK', 'US']) {
        for (const dev of ['mobile', 'desktop']) {
          values.push(pv({
            sliceDSL: `context(channel:${ch}).context(device:${dev}).context(geo:${geo})`,
            retrieved_at: '2026-04-07T06:00:00Z',
            n: 100,
            k: 50,
          }));
        }
      }
    }

    // Query: context(channel:google).context(geo:UK) → aggregate over device
    // Should find 2 matching slices (mobile + desktop for google/UK) and sum them
    const { tryDimensionalReduction } = await import('../dimensionalReductionService');
    const r = tryDimensionalReduction(values, 'context(channel:google).context(geo:UK)');
    expect(r.kind).toBe('reduced');
    if (r.kind === 'reduced' && r.aggregatedValues) {
      expect(r.aggregatedValues).toHaveLength(1);
      expect(r.aggregatedValues[0].n).toBe(200); // 100 + 100
    }
  });

  it('L21: semicolon slices context(a);context(b), query context(a:v1) → direct match, no aggregation needed', async () => {
    // When slices are from semicolon pattern, querying one key is a direct match
    mockMECEStatus({
      channel: ['google', 'meta'],
      geo: ['UK', 'US'],
    });
    const values = [
      pv({ sliceDSL: 'context(channel:google)', retrieved_at: '2026-04-07T06:00:00Z', n: 300, k: 120 }),
      pv({ sliceDSL: 'context(channel:meta)', retrieved_at: '2026-04-07T06:00:00Z', n: 400, k: 160 }),
      pv({ sliceDSL: 'context(geo:UK)', retrieved_at: '2026-04-07T06:00:00Z', n: 350, k: 140 }),
      pv({ sliceDSL: 'context(geo:US)', retrieved_at: '2026-04-07T06:00:00Z', n: 350, k: 140 }),
    ];

    const { isolateSlice } = await import('../sliceIsolation');
    const result = isolateSlice(values, 'context(channel:google)');
    expect(result).toHaveLength(1);
    expect(result[0].n).toBe(300);
  });

  it('L22: context(a).context(b).context(c), query context(a:v1) → reduce over b AND c', async () => {
    mockMECEStatus({
      channel: ['google', 'meta'],
      geo: ['UK', 'US'],
      device: ['mobile', 'desktop'],
    });
    const values = [];
    for (const ch of ['google', 'meta']) {
      for (const geo of ['UK', 'US']) {
        for (const dev of ['mobile', 'desktop']) {
          values.push(pv({
            sliceDSL: `context(channel:${ch}).context(device:${dev}).context(geo:${geo})`,
            retrieved_at: '2026-04-07T06:00:00Z',
            n: 100,
            k: 50,
          }));
        }
      }
    }

    // Query: context(channel:google) → aggregate over geo AND device
    // Should find 4 matching slices (2 geo x 2 device for google) and sum them
    const { tryDimensionalReduction } = await import('../dimensionalReductionService');
    const r = tryDimensionalReduction(values, 'context(channel:google)');
    expect(r.kind).toBe('reduced');
    if (r.kind === 'reduced' && r.aggregatedValues) {
      expect(r.aggregatedValues).toHaveLength(1);
      expect(r.aggregatedValues[0].n).toBe(400); // 4 slices x 100
    }
  });

  it('L23: context(a).context(b).context(c), one dim non-MECE, query uncontexted → not_resolvable', () => {
    mockMECEStatus({
      channel: ['google', 'meta'],
      geo: ['UK', 'US'],
      // device is NOT MECE
    });
    const values = [];
    for (const ch of ['google', 'meta']) {
      for (const geo of ['UK', 'US']) {
        for (const dev of ['mobile', 'desktop']) {
          values.push(pv({
            sliceDSL: `context(channel:${ch}).context(device:${dev}).context(geo:${geo})`,
            retrieved_at: '2026-04-07T06:00:00Z',
          }));
        }
      }
    }
    const r = selectImplicitUncontextedSliceSetSync({ candidateValues: values, requireCompleteMECE: true });
    expect(r.kind).toBe('not_resolvable');
  });

  it('L24: context(a).context(b).context(c), c non-MECE, query context(a:v1).context(b:w1) → cannot reduce over c', async () => {
    mockMECEStatus({
      channel: ['google', 'meta'],
      geo: ['UK', 'US'],
      // device NOT MECE
    });
    const values = [];
    for (const ch of ['google', 'meta']) {
      for (const geo of ['UK', 'US']) {
        for (const dev of ['mobile', 'desktop']) {
          values.push(pv({
            sliceDSL: `context(channel:${ch}).context(device:${dev}).context(geo:${geo})`,
            retrieved_at: '2026-04-07T06:00:00Z',
            n: 100,
            k: 50,
          }));
        }
      }
    }

    const { tryDimensionalReduction } = await import('../dimensionalReductionService');
    const r = tryDimensionalReduction(values, 'context(channel:google).context(geo:UK)');
    // Cannot aggregate over device — it's not MECE
    expect(r.kind).toBe('not_reducible');
  });

  it('L25: context(a).context(b).context(c), c non-MECE, query context(a:v1) → cannot reduce (b is MECE but c is not)', async () => {
    mockMECEStatus({
      channel: ['google', 'meta'],
      geo: ['UK', 'US'],
      // device NOT MECE
    });
    const values = [];
    for (const ch of ['google', 'meta']) {
      for (const geo of ['UK', 'US']) {
        for (const dev of ['mobile', 'desktop']) {
          values.push(pv({
            sliceDSL: `context(channel:${ch}).context(device:${dev}).context(geo:${geo})`,
            retrieved_at: '2026-04-07T06:00:00Z',
            n: 100,
            k: 50,
          }));
        }
      }
    }

    const { tryDimensionalReduction } = await import('../dimensionalReductionService');
    const r = tryDimensionalReduction(values, 'context(channel:google)');
    // Must reduce over BOTH geo and device. geo is MECE but device is NOT.
    // Cannot safely aggregate → not_reducible.
    expect(r.kind).toBe('not_reducible');
  });
});
