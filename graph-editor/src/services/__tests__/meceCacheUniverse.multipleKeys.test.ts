/**
 * MECE cache universe selection: multiple context families in the same file.
 *
 * Regression contract:
 * - For an uncontexted query, we should be able to satisfy it from ANY ONE complete MECE partition,
 *   not require all context families present in the file.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hasFullSliceCoverageByHeader, calculateIncrementalFetch } from '../windowAggregationService';
import { contextRegistry } from '../contextRegistry';

describe('MECE cache universe selection (multiple keys)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Provide MECE declarations for both keys, but only channel will be complete in the file.
    vi.spyOn(contextRegistry, 'detectMECEPartitionSync').mockImplementation((windows: any[], key: string) => {
      const values = windows.map(w => (w.sliceDSL || ''));
      if (key === 'channel') {
        // Expected: google, meta
        const hasGoogle = values.some(v => v.includes('channel:google'));
        const hasMeta = values.some(v => v.includes('channel:meta'));
        const isComplete = hasGoogle && hasMeta;
        return { isMECE: true, isComplete, canAggregate: isComplete, missingValues: isComplete ? [] : ['meta'], policy: 'null' };
      }
      if (key === 'geo') {
        // Expected: uk, us
        const hasUK = values.some(v => v.includes('geo:uk'));
        const hasUS = values.some(v => v.includes('geo:us'));
        const isComplete = hasUK && hasUS;
        return { isMECE: true, isComplete, canAggregate: isComplete, missingValues: isComplete ? [] : ['us'], policy: 'null' };
      }
      return { isMECE: false, isComplete: false, canAggregate: false, missingValues: [], policy: 'unknown' };
    });
  });

  it('hasFullSliceCoverageByHeader returns true when one MECE partition (channel) covers the window even if another key (geo) is incomplete', () => {
    const paramFileData: any = {
      values: [
        // Complete MECE partition for channel
        { sliceDSL: 'window(1-Dec-25:3-Dec-25).context(channel:google)', window_from: '1-Dec-25', window_to: '3-Dec-25' },
        { sliceDSL: 'window(1-Dec-25:3-Dec-25).context(channel:meta)', window_from: '1-Dec-25', window_to: '3-Dec-25' },
        // Incomplete for geo (missing us)
        { sliceDSL: 'window(1-Dec-25:3-Dec-25).context(geo:uk)', window_from: '1-Dec-25', window_to: '3-Dec-25' },
      ],
    };

    const ok = hasFullSliceCoverageByHeader(paramFileData, { start: '1-Dec-25', end: '3-Dec-25' }, 'window(1-Dec-25:3-Dec-25)');
    expect(ok).toBe(true);
  });

  it('calculateIncrementalFetch treats dates as cached when one complete MECE partition exists, even if another context family is incomplete', () => {
    const paramFileData: any = {
      values: [
        // channel google (daily)
        {
          sliceDSL: 'window(1-Dec-25:3-Dec-25).context(channel:google)',
          dates: ['1-Dec-25', '2-Dec-25', '3-Dec-25'],
          n_daily: [1, 1, 1],
          k_daily: [0, 0, 0],
        },
        // channel meta (daily)
        {
          sliceDSL: 'window(1-Dec-25:3-Dec-25).context(channel:meta)',
          dates: ['1-Dec-25', '2-Dec-25', '3-Dec-25'],
          n_daily: [1, 1, 1],
          k_daily: [0, 0, 0],
        },
        // geo uk only (incomplete)
        {
          sliceDSL: 'window(1-Dec-25:3-Dec-25).context(geo:uk)',
          dates: ['1-Dec-25', '2-Dec-25', '3-Dec-25'],
          n_daily: [1, 1, 1],
          k_daily: [0, 0, 0],
        },
      ],
    };

    const res = calculateIncrementalFetch(
      paramFileData,
      { start: '1-Dec-25', end: '3-Dec-25' },
      undefined,
      false,
      'window(1-Dec-25:3-Dec-25)'
    );
    expect(res.needsFetch).toBe(false);
    expect(res.daysToFetch).toBe(0);
  });
});


