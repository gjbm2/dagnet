/**
 * Cache fulfilment for typical pinned DSL pattern:
 *
 *   or(cohort(-60d:),window(-60d:)).or(context(channel),context(geo))
 *
 * Contract:
 * - Retrieve-all-slices writes contexted cohort+window slices to the parameter file.
 * - A later uncontexted query `cohort(X:Y)` should be considered cache-covered for:
 *   - cohort() slices (evidence)
 *   - window() slices required for forecast.* (implicit baseline)
 * - Provided that EITHER channel OR geo forms a complete MECE partition.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hasFullSliceCoverageByHeader, calculateIncrementalFetch } from '../windowAggregationService';
import { contextRegistry } from '../contextRegistry';

describe('Pinned DSL pattern cache fulfilment via MECE (either key)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Simulate: channel is complete MECE, geo is incomplete.
    vi.spyOn(contextRegistry, 'detectMECEPartitionSync').mockImplementation((windows: any[], key: string) => {
      const values = windows.map(w => (w.sliceDSL || ''));
      if (key === 'channel') {
        const hasGoogle = values.some(v => v.includes('channel:google'));
        const hasMeta = values.some(v => v.includes('channel:meta'));
        const isComplete = hasGoogle && hasMeta;
        return { isMECE: true, isComplete, canAggregate: isComplete, missingValues: isComplete ? [] : ['meta'], policy: 'null' };
      }
      if (key === 'geo') {
        // Incomplete: only uk
        const hasUK = values.some(v => v.includes('geo:uk'));
        const hasUS = values.some(v => v.includes('geo:us'));
        const isComplete = hasUK && hasUS;
        return { isMECE: true, isComplete, canAggregate: isComplete, missingValues: isComplete ? [] : ['us'], policy: 'null' };
      }
      return { isMECE: false, isComplete: false, canAggregate: false, missingValues: [], policy: 'unknown' };
    });
  });

  it('uncontexted cohort() and window() queries are both considered cache-covered when one MECE key is complete', () => {
    // Use absolute UK dates (relative offsets are resolved upstream before cache-cutting).
    const requested = { start: '10-Dec-25', end: '12-Dec-25' };
    const dates = ['10-Dec-25', '11-Dec-25', '12-Dec-25'];

    const paramFileData: any = {
      values: [
        // COHORT slices (channel complete MECE)
        {
          sliceDSL: 'cohort(1-Dec-25:31-Dec-25).context(channel:google)',
          cohort_from: '1-Dec-25',
          cohort_to: '31-Dec-25',
          dates,
          n_daily: [10, 10, 10],
          k_daily: [1, 1, 1],
          mean: 0.1,
          evidence: { n: 100 },
        },
        {
          sliceDSL: 'cohort(1-Dec-25:31-Dec-25).context(channel:meta)',
          cohort_from: '1-Dec-25',
          cohort_to: '31-Dec-25',
          dates,
          n_daily: [20, 20, 20],
          k_daily: [2, 2, 2],
          mean: 0.2,
          evidence: { n: 200 },
        },
        // COHORT slices (geo incomplete)
        {
          sliceDSL: 'cohort(1-Dec-25:31-Dec-25).context(geo:uk)',
          cohort_from: '1-Dec-25',
          cohort_to: '31-Dec-25',
          dates,
          n_daily: [5, 5, 5],
          k_daily: [0, 0, 0],
          mean: 0.3,
          evidence: { n: 50 },
        },

        // WINDOW slices (channel complete MECE)
        {
          sliceDSL: 'window(1-Dec-25:31-Dec-25).context(channel:google)',
          window_from: '1-Dec-25',
          window_to: '31-Dec-25',
          dates,
          n_daily: [10, 10, 10],
          k_daily: [1, 1, 1],
          mean: 0.1,
          n: 100,
        },
        {
          sliceDSL: 'window(1-Dec-25:31-Dec-25).context(channel:meta)',
          window_from: '1-Dec-25',
          window_to: '31-Dec-25',
          dates,
          n_daily: [20, 20, 20],
          k_daily: [2, 2, 2],
          mean: 0.2,
          n: 200,
        },
        // WINDOW slices (geo incomplete)
        {
          sliceDSL: 'window(1-Dec-25:31-Dec-25).context(geo:uk)',
          window_from: '1-Dec-25',
          window_to: '31-Dec-25',
          dates,
          n_daily: [5, 5, 5],
          k_daily: [0, 0, 0],
          mean: 0.3,
          n: 50,
        },
      ],
    };

    // Cohort coverage (evidence)
    expect(
      hasFullSliceCoverageByHeader(paramFileData, requested, 'cohort(10-Dec-25:12-Dec-25)')
    ).toBe(true);

    // Window coverage (forecast prerequisites)
    expect(
      hasFullSliceCoverageByHeader(paramFileData, requested, 'window(10-Dec-25:12-Dec-25)')
    ).toBe(true);

    // Incremental fetch logic should also say "no fetch needed" in both modes.
    const cohortRes = calculateIncrementalFetch(
      paramFileData,
      requested,
      undefined,
      false,
      'cohort(10-Dec-25:12-Dec-25)'
    );
    expect(cohortRes.needsFetch).toBe(false);

    const windowRes = calculateIncrementalFetch(
      paramFileData,
      requested,
      undefined,
      false,
      'window(10-Dec-25:12-Dec-25)'
    );
    expect(windowRes.needsFetch).toBe(false);
  });
});


