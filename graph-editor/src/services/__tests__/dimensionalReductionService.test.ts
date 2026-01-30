import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ParameterValue } from '../../types/parameterData';
import {
  extractContextMap,
  clearContextMapCache,
  matchesSpecifiedDimensions,
  getUnspecifiedDimensionsFromMaps,
  verifyMECEForDimension,
  verifyAllCombinationsExist,
  dedupeSlices,
  aggregateSlices,
  tryDimensionalReduction,
} from '../dimensionalReductionService';
import { contextRegistry } from '../contextRegistry';

// ─────────────────────────────────────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeSlice(
  sliceDSL: string,
  dates: string[],
  n_daily: number[],
  k_daily: number[],
  overrides?: Partial<ParameterValue>
): ParameterValue {
  return {
    sliceDSL,
    dates,
    n_daily,
    k_daily,
    n: n_daily.reduce((a, b) => a + b, 0),
    k: k_daily.reduce((a, b) => a + b, 0),
    mean: n_daily.reduce((a, b) => a + b, 0) > 0
      ? k_daily.reduce((a, b) => a + b, 0) / n_daily.reduce((a, b) => a + b, 0)
      : undefined,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// extractContextMap Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('extractContextMap', () => {
  beforeEach(() => {
    clearContextMapCache();
  });

  it('extracts single context dimension', () => {
    const map = extractContextMap('context(channel:google)');
    expect(map.get('channel')).toBe('google');
    expect(map.size).toBe(1);
  });

  it('extracts multiple context dimensions', () => {
    const map = extractContextMap('context(channel:google).context(device:mobile)');
    expect(map.get('channel')).toBe('google');
    expect(map.get('device')).toBe('mobile');
    expect(map.size).toBe(2);
  });

  it('handles context with window', () => {
    const map = extractContextMap('context(channel:google).window(1-Oct-25:31-Oct-25)');
    expect(map.get('channel')).toBe('google');
    expect(map.size).toBe(1);
  });

  it('returns empty map for uncontexted', () => {
    const map = extractContextMap('window(1-Oct-25:31-Oct-25)');
    expect(map.size).toBe(0);
  });

  it('returns empty map for empty string', () => {
    const map = extractContextMap('');
    expect(map.size).toBe(0);
  });

  it('returns empty map for undefined', () => {
    const map = extractContextMap(undefined as unknown as string);
    expect(map.size).toBe(0);
  });

  it('caches results (memoisation)', () => {
    const dsl = 'context(channel:google).context(device:mobile)';
    const map1 = extractContextMap(dsl);
    const map2 = extractContextMap(dsl);
    expect(map1).toBe(map2); // Same reference
  });

  it('clearContextMapCache clears the cache', () => {
    const dsl = 'context(channel:google)';
    const map1 = extractContextMap(dsl);
    clearContextMapCache();
    const map2 = extractContextMap(dsl);
    expect(map1).not.toBe(map2); // Different reference after clear
    expect(map1.get('channel')).toBe(map2.get('channel')); // Same content
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// matchesSpecifiedDimensions Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('matchesSpecifiedDimensions', () => {
  it('returns true when slice has all specified dimensions', () => {
    const sliceMap = new Map([['channel', 'google'], ['device', 'mobile']]);
    const queryMap = new Map([['channel', 'google']]);
    expect(matchesSpecifiedDimensions(sliceMap, queryMap)).toBe(true);
  });

  it('returns true when both have same dimensions', () => {
    const sliceMap = new Map([['channel', 'google']]);
    const queryMap = new Map([['channel', 'google']]);
    expect(matchesSpecifiedDimensions(sliceMap, queryMap)).toBe(true);
  });

  it('returns false when value differs', () => {
    const sliceMap = new Map([['channel', 'meta']]);
    const queryMap = new Map([['channel', 'google']]);
    expect(matchesSpecifiedDimensions(sliceMap, queryMap)).toBe(false);
  });

  it('returns false when slice missing required dimension', () => {
    const sliceMap = new Map([['device', 'mobile']]);
    const queryMap = new Map([['channel', 'google']]);
    expect(matchesSpecifiedDimensions(sliceMap, queryMap)).toBe(false);
  });

  it('returns true when query has no dimensions (uncontexted)', () => {
    const sliceMap = new Map([['channel', 'google']]);
    const queryMap = new Map<string, string>();
    expect(matchesSpecifiedDimensions(sliceMap, queryMap)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getUnspecifiedDimensionsFromMaps Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('getUnspecifiedDimensionsFromMaps', () => {
  it('returns keys in slice but not in query', () => {
    const sliceMap = new Map([['channel', 'google'], ['device', 'mobile']]);
    const queryMap = new Map([['channel', 'google']]);
    expect(getUnspecifiedDimensionsFromMaps(sliceMap, queryMap)).toEqual(['device']);
  });

  it('returns all slice keys when query is empty', () => {
    const sliceMap = new Map([['channel', 'google'], ['device', 'mobile']]);
    const queryMap = new Map<string, string>();
    expect(getUnspecifiedDimensionsFromMaps(sliceMap, queryMap).sort()).toEqual(['channel', 'device']);
  });

  it('returns empty array when slice and query have same keys', () => {
    const sliceMap = new Map([['channel', 'google']]);
    const queryMap = new Map([['channel', 'google']]);
    expect(getUnspecifiedDimensionsFromMaps(sliceMap, queryMap)).toEqual([]);
  });

  it('returns sorted keys', () => {
    const sliceMap = new Map([['z', '1'], ['a', '2'], ['m', '3']]);
    const queryMap = new Map<string, string>();
    expect(getUnspecifiedDimensionsFromMaps(sliceMap, queryMap)).toEqual(['a', 'm', 'z']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyAllCombinationsExist Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('verifyAllCombinationsExist', () => {
  beforeEach(() => {
    clearContextMapCache();
  });

  it('returns complete for single dimension', () => {
    const slices = [
      makeSlice('context(channel:google)', ['1-Oct-25'], [100], [50]),
      makeSlice('context(channel:meta)', ['1-Oct-25'], [100], [50]),
    ];
    const result = verifyAllCombinationsExist(slices, ['channel']);
    expect(result.complete).toBe(true);
  });

  it('returns complete when all 2D combinations exist', () => {
    const slices = [
      makeSlice('context(channel:google).context(device:mobile)', ['1-Oct-25'], [100], [50]),
      makeSlice('context(channel:google).context(device:desktop)', ['1-Oct-25'], [100], [50]),
      makeSlice('context(channel:meta).context(device:mobile)', ['1-Oct-25'], [100], [50]),
      makeSlice('context(channel:meta).context(device:desktop)', ['1-Oct-25'], [100], [50]),
    ];
    const result = verifyAllCombinationsExist(slices, ['channel', 'device']);
    expect(result.complete).toBe(true);
  });

  it('returns incomplete when combination missing', () => {
    const slices = [
      makeSlice('context(channel:google).context(device:mobile)', ['1-Oct-25'], [100], [50]),
      makeSlice('context(channel:google).context(device:desktop)', ['1-Oct-25'], [100], [50]),
      makeSlice('context(channel:meta).context(device:mobile)', ['1-Oct-25'], [100], [50]),
      // Missing: meta + desktop
    ];
    const result = verifyAllCombinationsExist(slices, ['channel', 'device']);
    expect(result.complete).toBe(false);
    expect(result.missingCombinations.length).toBeGreaterThan(0);
  });

  it('limits missing combinations to 10', () => {
    // Create many missing combinations
    const slices = [
      makeSlice('context(a:1).context(b:1).context(c:1)', ['1-Oct-25'], [100], [50]),
    ];
    const result = verifyAllCombinationsExist(slices, ['a', 'b', 'c']);
    // Even if many are missing, we only report up to 10
    expect(result.missingCombinations.length).toBeLessThanOrEqual(10);
  });

  it('rejects > 4 dimensions with warning', () => {
    const slices = [
      makeSlice('context(a:1).context(b:1).context(c:1).context(d:1).context(e:1)', ['1-Oct-25'], [100], [50]),
    ];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = verifyAllCombinationsExist(slices, ['a', 'b', 'c', 'd', 'e']);
    expect(result.complete).toBe(false);
    expect(result.missingCombinations).toContain('too_many_dimensions');
    warnSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dedupeSlices Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('dedupeSlices', () => {
  it('keeps unique slices', () => {
    const slices = [
      makeSlice('context(channel:google)', ['1-Oct-25'], [100], [50]),
      makeSlice('context(channel:meta)', ['1-Oct-25'], [200], [100]),
    ];
    const deduped = dedupeSlices(slices);
    expect(deduped.length).toBe(2);
  });

  it('removes duplicate keeping fresher', () => {
    const older = makeSlice('context(channel:google)', ['1-Oct-25'], [100], [50], {
      window_from: '1-Oct-25',
      window_to: '1-Oct-25',
      data_source: { type: 'amplitude', retrieved_at: '2025-10-01T00:00:00Z' },
    });
    const newer = makeSlice('context(channel:google)', ['1-Oct-25'], [150], [75], {
      window_from: '1-Oct-25',
      window_to: '1-Oct-25',
      data_source: { type: 'amplitude', retrieved_at: '2025-10-02T00:00:00Z' },
    });

    const deduped = dedupeSlices([older, newer]);
    expect(deduped.length).toBe(1);
    expect(deduped[0].n_daily![0]).toBe(150); // Kept the newer one
  });

  it('treats different window ranges as distinct', () => {
    const slice1 = makeSlice('context(channel:google)', ['1-Oct-25'], [100], [50], {
      window_from: '1-Oct-25',
      window_to: '1-Oct-25',
    });
    const slice2 = makeSlice('context(channel:google)', ['2-Oct-25'], [100], [50], {
      window_from: '2-Oct-25',
      window_to: '2-Oct-25',
    });

    const deduped = dedupeSlices([slice1, slice2]);
    expect(deduped.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// aggregateSlices Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('aggregateSlices', () => {
  it('returns null for empty array', () => {
    expect(aggregateSlices([])).toBe(null);
  });

  it('returns single slice unchanged', () => {
    const slice = makeSlice('context(channel:google)', ['1-Oct-25', '2-Oct-25'], [100, 200], [50, 100]);
    const result = aggregateSlices([slice]);
    expect(result).toBe(slice);
  });

  it('sums n_daily and k_daily correctly', () => {
    const slice1 = makeSlice('context(channel:google)', ['1-Oct-25', '2-Oct-25'], [100, 200], [50, 100]);
    const slice2 = makeSlice('context(channel:meta)', ['1-Oct-25', '2-Oct-25'], [150, 250], [75, 125]);

    const result = aggregateSlices([slice1, slice2]);
    expect(result).not.toBe(null);
    expect(result!.n_daily).toEqual([250, 450]);
    expect(result!.k_daily).toEqual([125, 225]);
    expect(result!.n).toBe(700);
    expect(result!.k).toBe(350);
    expect(result!.mean).toBeCloseTo(0.5);
  });

  it('returns null when date arrays differ in length', () => {
    const slice1 = makeSlice('context(channel:google)', ['1-Oct-25'], [100], [50]);
    const slice2 = makeSlice('context(channel:meta)', ['1-Oct-25', '2-Oct-25'], [100, 200], [50, 100]);

    expect(aggregateSlices([slice1, slice2])).toBe(null);
  });

  it('returns null when date values differ', () => {
    const slice1 = makeSlice('context(channel:google)', ['1-Oct-25'], [100], [50]);
    const slice2 = makeSlice('context(channel:meta)', ['2-Oct-25'], [100], [50]);

    expect(aggregateSlices([slice1, slice2])).toBe(null);
  });

  it('sets sliceDSL to empty string (uncontexted)', () => {
    const slice1 = makeSlice('context(channel:google)', ['1-Oct-25'], [100], [50]);
    const slice2 = makeSlice('context(channel:meta)', ['1-Oct-25'], [100], [50]);

    const result = aggregateSlices([slice1, slice2]);
    expect(result!.sliceDSL).toBe('');
  });

  it('preserves data_source from template slice', () => {
    const slice1 = makeSlice('context(channel:google)', ['1-Oct-25'], [100], [50], {
      data_source: { type: 'amplitude', retrieved_at: '2025-10-01T00:00:00Z' },
    });
    const slice2 = makeSlice('context(channel:meta)', ['1-Oct-25'], [100], [50]);
    const slice3 = makeSlice('context(channel:bing)', ['1-Oct-25'], [100], [50]);

    const result = aggregateSlices([slice1, slice2, slice3]);
    // Preserves data_source from first (template) slice
    expect(result!.data_source?.type).toBe('amplitude');
    expect(result!.data_source?.retrieved_at).toBe('2025-10-01T00:00:00Z');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tryDimensionalReduction Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('tryDimensionalReduction', () => {
  beforeEach(() => {
    clearContextMapCache();

    // Mock MECE detection - by default return MECE
    vi.spyOn(contextRegistry, 'detectMECEPartitionSync').mockReturnValue({
      isMECE: true,
      isComplete: true,
      canAggregate: true,
      missingValues: [],
      otherPolicy: 'undefined',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns exact match when no unspecified dimensions', () => {
    const slices = [
      makeSlice('context(channel:google)', ['1-Oct-25'], [100], [50]),
    ];

    const result = tryDimensionalReduction(slices, 'context(channel:google)');
    expect(result.kind).toBe('reduced');
    expect(result.aggregatedValues).toHaveLength(1);
    expect(result.diagnostics.unspecifiedDimensions).toEqual([]);
  });

  it('aggregates single unspecified dimension', () => {
    const slices = [
      makeSlice('context(channel:google).context(device:mobile)', ['1-Oct-25'], [100], [50]),
      makeSlice('context(channel:google).context(device:desktop)', ['1-Oct-25'], [200], [100]),
    ];

    const result = tryDimensionalReduction(slices, 'context(channel:google)');
    expect(result.kind).toBe('reduced');
    expect(result.aggregatedValues).toHaveLength(1);
    expect(result.aggregatedValues![0].n_daily).toEqual([300]);
    expect(result.aggregatedValues![0].k_daily).toEqual([150]);
    expect(result.diagnostics.unspecifiedDimensions).toEqual(['device']);
  });

  it('returns not_reducible when no matching slices', () => {
    const slices = [
      makeSlice('context(channel:meta)', ['1-Oct-25'], [100], [50]),
    ];

    const result = tryDimensionalReduction(slices, 'context(channel:google)');
    expect(result.kind).toBe('not_reducible');
    expect(result.reason).toBe('no_matching_slices');
  });

  it('returns not_reducible when dimension not MECE', () => {
    vi.spyOn(contextRegistry, 'detectMECEPartitionSync').mockReturnValue({
      isMECE: false,
      isComplete: false,
      canAggregate: false,
      missingValues: ['bing'],
      otherPolicy: 'undefined',
    });

    const slices = [
      makeSlice('context(channel:google).context(device:mobile)', ['1-Oct-25'], [100], [50]),
      makeSlice('context(channel:google).context(device:desktop)', ['1-Oct-25'], [200], [100]),
    ];

    const result = tryDimensionalReduction(slices, 'context(channel:google)');
    expect(result.kind).toBe('not_reducible');
    expect(result.reason).toBe('dimension_not_mece:device');
  });

  it('returns not_reducible when dimension not aggregatable', () => {
    vi.spyOn(contextRegistry, 'detectMECEPartitionSync').mockReturnValue({
      isMECE: true,
      isComplete: true,
      canAggregate: false,
      missingValues: [],
      otherPolicy: 'keep_other',
    });

    const slices = [
      makeSlice('context(channel:google).context(device:mobile)', ['1-Oct-25'], [100], [50]),
    ];

    const result = tryDimensionalReduction(slices, 'context(channel:google)');
    expect(result.kind).toBe('not_reducible');
    expect(result.reason).toBe('dimension_not_aggregatable:device');
  });

  it('returns not_reducible when aggregation fails (misaligned dates)', () => {
    const slices = [
      makeSlice('context(channel:google).context(device:mobile)', ['1-Oct-25'], [100], [50]),
      makeSlice('context(channel:google).context(device:desktop)', ['2-Oct-25'], [200], [100]),
    ];

    const result = tryDimensionalReduction(slices, 'context(channel:google)');
    expect(result.kind).toBe('not_reducible');
    expect(result.reason).toBe('aggregation_failed');
  });

  it('handles uncontexted query over contexted cache', () => {
    const slices = [
      makeSlice('context(channel:google)', ['1-Oct-25'], [100], [50]),
      makeSlice('context(channel:meta)', ['1-Oct-25'], [200], [100]),
    ];

    const result = tryDimensionalReduction(slices, 'window(1-Oct-25:1-Oct-25)');
    expect(result.kind).toBe('reduced');
    expect(result.aggregatedValues).toHaveLength(1);
    expect(result.aggregatedValues![0].n_daily).toEqual([300]);
    expect(result.diagnostics.unspecifiedDimensions).toEqual(['channel']);
  });

  it('filters to matching specified dimensions before reduction', () => {
    const slices = [
      makeSlice('context(channel:google).context(device:mobile)', ['1-Oct-25'], [100], [50]),
      makeSlice('context(channel:google).context(device:desktop)', ['1-Oct-25'], [200], [100]),
      makeSlice('context(channel:meta).context(device:mobile)', ['1-Oct-25'], [150], [75]),
      makeSlice('context(channel:meta).context(device:desktop)', ['1-Oct-25'], [250], [125]),
    ];

    const result = tryDimensionalReduction(slices, 'context(channel:google)');
    expect(result.kind).toBe('reduced');
    // Should only aggregate the 2 google slices, not the meta ones
    expect(result.diagnostics.slicesUsed).toBe(2);
    expect(result.aggregatedValues![0].n_daily).toEqual([300]); // 100 + 200
  });

  it('verifies multi-dimensional combinations', () => {
    // Missing one combination
    const slices = [
      makeSlice('context(channel:google).context(device:mobile)', ['1-Oct-25'], [100], [50]),
      makeSlice('context(channel:google).context(device:desktop)', ['1-Oct-25'], [200], [100]),
      makeSlice('context(channel:meta).context(device:mobile)', ['1-Oct-25'], [150], [75]),
      // Missing: meta + desktop
    ];

    const result = tryDimensionalReduction(slices, 'window(1-Oct-25:1-Oct-25)');
    expect(result.kind).toBe('not_reducible');
    expect(result.reason).toBe('incomplete_combinations');
  });

  it('dedupes before aggregation', () => {
    // Duplicate slices - use data_source.retrieved_at for freshness comparison
    const slices = [
      makeSlice('context(channel:google)', ['1-Oct-25'], [100], [50], {
        window_from: '1-Oct-25',
        window_to: '1-Oct-25',
        data_source: { type: 'amplitude', retrieved_at: '2025-10-01T00:00:00Z' },
      }),
      makeSlice('context(channel:google)', ['1-Oct-25'], [150], [75], {
        window_from: '1-Oct-25',
        window_to: '1-Oct-25',
        data_source: { type: 'amplitude', retrieved_at: '2025-10-02T00:00:00Z' },
      }),
      makeSlice('context(channel:meta)', ['1-Oct-25'], [200], [100]),
    ];

    const result = tryDimensionalReduction(slices, 'window(1-Oct-25:1-Oct-25)');
    expect(result.kind).toBe('reduced');
    // Should use 2 slices (deduped google + meta), not 3
    expect(result.diagnostics.slicesUsed).toBe(2);
    // Uses the fresher google slice (150) + meta (200)
    expect(result.aggregatedValues![0].n_daily).toEqual([350]);
  });

  it('updates sliceDSL to remaining dimensions', () => {
    const slices = [
      makeSlice('context(channel:google).context(device:mobile)', ['1-Oct-25'], [100], [50]),
      makeSlice('context(channel:google).context(device:desktop)', ['1-Oct-25'], [200], [100]),
    ];

    const result = tryDimensionalReduction(slices, 'context(channel:google)');
    expect(result.kind).toBe('reduced');
    expect(result.aggregatedValues![0].sliceDSL).toBe('context(channel:google)');
  });
});
