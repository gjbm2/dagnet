/**
 * Context Roundtrip Integration Tests
 * 
 * These tests verify the CRITICAL flow that keeps breaking:
 * 1. Fetch data with a context (e.g., context(channel:google))
 * 2. Write to parameter file with sliceDSL
 * 3. Read back from file using isolateSlice
 * 4. Verify correct data reaches the graph
 * 5. Context switching shows correct data (or no data if not cached)
 * 
 * BUGS CAUGHT BY THESE TESTS:
 * - mergeTimeSeriesIntoParameter not setting sliceDSL (data invisible after write)
 * - isolateSlice comparing full DSL (with window) vs sliceDSL (without window)
 * - extractSliceDimensions not stripping window from DSL
 * - Coverage cache keyed by window only, not DSL (stale cache on context switch)
 * - "Regular update" fallback not respecting slice isolation (showed wrong context data)
 * - No data for context showing stale data from other contexts
 * 
 * WHY EXISTING TESTS DIDN'T CATCH THESE:
 * - Unit tests mocked data with correct sliceDSL already set
 * - No tests for write→read roundtrip across context boundaries
 * - Cache behavior not tested with context changes
 * - Fallback paths not tested (only happy path)
 * - No tests for "switch to context with no data" scenario
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { 
  mergeTimeSeriesIntoParameter,
  calculateIncrementalFetch,
} from '../windowAggregationService';
import { isolateSlice, extractSliceDimensions } from '../sliceIsolation';
import type { ParameterValue } from '../../types/parameterData';

describe('Context Roundtrip Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('mergeTimeSeriesIntoParameter → isolateSlice roundtrip', () => {
    it('CRITICAL: data written with context must be readable with that context', () => {
      // This is the bug that kept breaking: mergeTimeSeriesIntoParameter wasn't setting sliceDSL
      
      // 1. Start with empty values
      const existingValues: ParameterValue[] = [];
      
      // 2. Simulate fetching data for context(channel:google)
      const newTimeSeries = [
        { date: '2025-10-01', n: 100, k: 15, p: 0.15 },
        { date: '2025-10-02', n: 110, k: 17, p: 0.155 },
      ];
      
      const fetchWindow = { 
        start: '2025-10-01T00:00:00.000Z', 
        end: '2025-10-02T23:59:59.000Z' 
      };
      
      // 3. Write to "file" (really just the values array)
      const sliceDSL = 'context(channel:google)';
      const afterWrite = mergeTimeSeriesIntoParameter(
        existingValues,
        newTimeSeries,
        fetchWindow,
        'test-signature',
        {},
        'from(a).to(b)',
        'amplitude',
        sliceDSL  // CRITICAL: This must be passed!
      );
      
      // 4. Verify sliceDSL was set to canonical window+context form
      expect(afterWrite.length).toBe(1);
      expect(afterWrite[0].sliceDSL).toBe('window(1-Oct-25:2-Oct-25).context(channel:google)');
      
      // 5. Read back with isolateSlice
      const targetSlice = 'context(channel:google).window(1-Oct-25:2-Oct-25)';
      const isolated = isolateSlice(afterWrite, targetSlice);
      
      // 6. CRITICAL: Data must be found!
      expect(isolated.length).toBe(1);
      expect(isolated[0].n).toBe(210); // Sum of n_daily
      expect(isolated[0].k).toBe(32);  // Sum of k_daily
    });

    it('CRITICAL: data written WITHOUT sliceDSL should NOT be found with context query', () => {
      // This simulates the OLD buggy behavior where sliceDSL wasn't set
      const valuesWithoutSliceDSL: ParameterValue[] = [
        {
          mean: 0.15,
          n: 100,
          k: 15,
          n_daily: [100],
          k_daily: [15],
          dates: ['2025-10-01'],
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-01T23:59:59.000Z',
          // sliceDSL NOT SET - simulating old bug
        }
      ];
      
      // Query with context should NOT find this data
      const isolated = isolateSlice(valuesWithoutSliceDSL, 'context(channel:google)');
      expect(isolated.length).toBe(0);
      
      // Query with empty context SHOULD find this data (legacy behavior)
      const isolatedEmpty = isolateSlice(valuesWithoutSliceDSL, '');
      expect(isolatedEmpty.length).toBe(1);
    });

    it('CRITICAL: multiple contexts should stay separate', () => {
      const values: ParameterValue[] = [];
      
      // Write google data
      const googleData = mergeTimeSeriesIntoParameter(
        values,
        [{ date: '2025-10-01', n: 100, k: 15, p: 0.15 }],
        { start: '2025-10-01T00:00:00.000Z', end: '2025-10-01T23:59:59.000Z' },
        'sig1', {}, 'q1', 'amplitude',
        'context(channel:google)'
      );
      
      // Write meta data
      const bothData = mergeTimeSeriesIntoParameter(
        googleData,
        [{ date: '2025-10-01', n: 200, k: 40, p: 0.2 }],
        { start: '2025-10-01T00:00:00.000Z', end: '2025-10-01T23:59:59.000Z' },
        'sig2', {}, 'q1', 'amplitude',
        'context(channel:meta)'
      );
      
      expect(bothData.length).toBe(2);
      
      // Each context should be isolated
      const googleIsolated = isolateSlice(bothData, 'context(channel:google)');
      const metaIsolated = isolateSlice(bothData, 'context(channel:meta)');
      
      expect(googleIsolated.length).toBe(1);
      expect(googleIsolated[0].n).toBe(100);
      
      expect(metaIsolated.length).toBe(1);
      expect(metaIsolated[0].n).toBe(200);
    });

    it('CRITICAL: repeated fetches for SAME slice family merge by date canonically', () => {
      // NEW DESIGN: mergeTimeSeriesIntoParameter performs a canonical merge
      // for a given slice family (same context/case dimensions).
      //
      // - Dates in the new fetch override existing dates for that slice.
      // - Dates outside the new window are preserved.
      // - A single merged value entry exists per slice family.
      
      // 1. Initial data: Oct 1-2 with n=100, k=15 per day
      const initialData = mergeTimeSeriesIntoParameter(
        [],
        [
          { date: '2025-10-01', n: 100, k: 15, p: 0.15 },
          { date: '2025-10-02', n: 100, k: 15, p: 0.15 },
        ],
        { start: '2025-10-01T00:00:00.000Z', end: '2025-10-02T23:59:59.000Z' },
        'sig1', {}, 'q1', 'amplitude',
        '' // uncontexted
      );
      
      expect(initialData.length).toBe(1);
      expect(initialData[0].n).toBe(200); // 100 + 100
      
      // 2. Re-fetch same dates with DIFFERENT values (simulating updated API data)
      // This MERGES into the canonical slice for this family
      const updatedData = mergeTimeSeriesIntoParameter(
        initialData,
        [
          { date: '2025-10-01', n: 150, k: 20, p: 0.133 },  // CHANGED values
          { date: '2025-10-02', n: 150, k: 25, p: 0.167 },  // CHANGED values
        ],
        { start: '2025-10-01T00:00:00.000Z', end: '2025-10-02T23:59:59.000Z' },
        'sig2', {}, 'q1', 'amplitude',
        '' // same slice
      );
      
      // NEW: Should still have 1 canonical entry for this slice family
      expect(updatedData.length).toBe(1);
      
      // Canonical entry now reflects the latest values for both days:
      // n = 150 + 150 = 300, k = 20 + 25 = 45
      expect(updatedData[0].n).toBe(300);
      expect(updatedData[0].k).toBe(45);
      
      // At aggregation time, this canonical entry already encodes the merged series
    });

    it('CRITICAL: partial overlap merges into a single canonical entry', () => {
      // NEW DESIGN: Each slice family has a single canonical entry.
      // Partial overlaps merge by date:
      // - Existing dates preserved unless overridden.
      // - New dates added.
      
      // Existing data: Oct 1-2
      const existingData = mergeTimeSeriesIntoParameter(
        [],
        [
          { date: '2025-10-01', n: 100, k: 10, p: 0.10 },
          { date: '2025-10-02', n: 100, k: 10, p: 0.10 },
        ],
        { start: '2025-10-01T00:00:00.000Z', end: '2025-10-02T23:59:59.000Z' },
        'sig1', {}, 'q1', 'amplitude', ''
      );
      
      // New data: Oct 2-3 (Oct 2 overlaps, Oct 3 is new)
      const afterSecondFetch = mergeTimeSeriesIntoParameter(
        existingData,
        [
          { date: '2025-10-02', n: 150, k: 20, p: 0.133 },  // Overlaps Oct 2
          { date: '2025-10-03', n: 200, k: 30, p: 0.15 },   // New
        ],
        { start: '2025-10-02T00:00:00.000Z', end: '2025-10-03T23:59:59.000Z' },
        'sig2', {}, 'q1', 'amplitude', ''
      );
      
      // NEW: Should have 1 canonical entry for this slice family
      expect(afterSecondFetch.length).toBe(1);
      
      // Canonical series now covers Oct 1-3 with:
      // Oct 1: n=100,k=10 (from first fetch)
      // Oct 2: n=150,k=20 (from second fetch, overrides first)
      // Oct 3: n=200,k=30 (from second fetch)
      //
      // Totals: n = 450, k = 60
      expect(afterSecondFetch[0].dates?.length).toBe(3);
      expect(afterSecondFetch[0].n).toBe(450);
      expect(afterSecondFetch[0].k).toBe(60);
    });
  });

  describe('extractSliceDimensions', () => {
    it('should strip window from DSL, keeping only context', () => {
      const full = 'context(channel:google).window(1-Oct-25:31-Oct-25)';
      const dimensions = extractSliceDimensions(full);
      expect(dimensions).toBe('context(channel:google)');
    });

    it('should preserve multiple contexts', () => {
      const full = 'context(channel:google).context(platform:ios).window(1-Oct-25:31-Oct-25)';
      const dimensions = extractSliceDimensions(full);
      // Contexts should be sorted alphabetically
      expect(dimensions).toBe('context(channel:google).context(platform:ios)');
    });

    it('should return empty string for window-only DSL', () => {
      const full = 'window(1-Oct-25:31-Oct-25)';
      const dimensions = extractSliceDimensions(full);
      expect(dimensions).toBe('');
    });

    it('should preserve case dimensions', () => {
      const full = 'case(experiment:treatment).window(1-Oct-25:31-Oct-25)';
      const dimensions = extractSliceDimensions(full);
      expect(dimensions).toBe('case(experiment:treatment)');
    });

    it('should handle empty string', () => {
      expect(extractSliceDimensions('')).toBe('');
    });
  });

  describe('isolateSlice with window in targetSlice', () => {
    it('CRITICAL: window in targetSlice should be ignored for matching', () => {
      const values: ParameterValue[] = [
        { sliceDSL: 'context(channel:google)', n: 100, k: 15, mean: 0.15 },
      ];
      
      // These should ALL match the same value
      const queries = [
        'context(channel:google)',
        'context(channel:google).window(1-Oct-25:31-Oct-25)',
        'window(-7d:).context(channel:google)',
        'context(channel:google).window(-30d:)',
      ];
      
      for (const query of queries) {
        const result = isolateSlice(values, query);
        expect(result.length, `Query "${query}" should find the value`).toBe(1);
        expect(result[0].n).toBe(100);
      }
    });
  });

  describe('Context switching with missing data', () => {
    it('CRITICAL: switching to context with no data should return empty, not other context data', () => {
      // When user switches to a context with no cached data,
      // isolateSlice should return empty - not data from other contexts
      
      const values: ParameterValue[] = [
        { 
          sliceDSL: 'context(channel:google)', 
          n: 100, 
          k: 15,
          mean: 0.15,
          n_daily: [100],
          k_daily: [15],
          dates: ['2025-10-01'],
        },
        // Note: NO data for context(channel:pr)
      ];
      
      // Query for pr context - should get EMPTY result (not google data)
      const prSlice = isolateSlice(values, 'context(channel:pr)');
      expect(prSlice.length).toBe(0);
      
      // Query for google context - should get the data
      const googleSlice = isolateSlice(values, 'context(channel:google)');
      expect(googleSlice.length).toBe(1);
      expect(googleSlice[0].n).toBe(100);
    });

    it('CRITICAL: isolateSlice with window should still match context-only sliceDSL', () => {
      const values: ParameterValue[] = [
        { sliceDSL: 'context(channel:google)', n: 100, k: 15, mean: 0.15 },
      ];
      
      // UI sends targetSlice with window, file has sliceDSL without window
      const result = isolateSlice(values, 'context(channel:google).window(1-Oct-25:31-Oct-25)');
      
      expect(result.length).toBe(1);
      expect(result[0].n).toBe(100);
    });
  });

  describe('calculateIncrementalFetch with context', () => {
    // Note: calculateIncrementalFetch signature is:
    // (paramFileData, requestedWindow, querySignature?, bustCache?, targetSlice?)
    
    it('CRITICAL: should only check dates within the same context slice', () => {
      // File has data for google context, Oct 1-3
      const paramFile = {
        values: [
          {
            sliceDSL: 'context(channel:google)',
            dates: ['2025-10-01', '2025-10-02', '2025-10-03'],
            n_daily: [100, 110, 120],
            k_daily: [15, 17, 18],
            window_from: '2025-10-01T00:00:00.000Z',
            window_to: '2025-10-03T23:59:59.000Z',
          },
          {
            sliceDSL: 'context(channel:meta)',
            dates: ['2025-10-01'],
            n_daily: [200],
            k_daily: [40],
            window_from: '2025-10-01T00:00:00.000Z',
            window_to: '2025-10-01T23:59:59.000Z',
          }
        ]
      };
      
      // Query for meta, Oct 1-3: should need to fetch Oct 2-3
      // Args: paramFile, window, querySignature, bustCache, targetSlice
      const metaResult = calculateIncrementalFetch(
        paramFile as any,
        { start: '2025-10-01T00:00:00.000Z', end: '2025-10-03T23:59:59.000Z' },
        undefined, // querySignature
        false, // bustCache
        'context(channel:meta)' // targetSlice
      );
      
      expect(metaResult.existingDates.size).toBe(1); // Only Oct 1 for meta
      expect(metaResult.missingDates.length).toBe(2); // Oct 2, 3 missing
      
      // Query for google, Oct 1-3: should have all dates
      const googleResult = calculateIncrementalFetch(
        paramFile as any,
        { start: '2025-10-01T00:00:00.000Z', end: '2025-10-03T23:59:59.000Z' },
        undefined, // querySignature
        false, // bustCache
        'context(channel:google)' // targetSlice
      );
      
      expect(googleResult.existingDates.size).toBe(3); // All 3 days for google
      expect(googleResult.missingDates.length).toBe(0); // Nothing missing
    });

    it('CRITICAL: uncontexted query on contexted-only file uses MECE aggregation', () => {
      // When file has ONLY contexted data but query is uncontexted,
      // calculateIncrementalFetch uses MECE aggregation: a date is "existing"
      // only if it exists in ALL contexted slices.
      const paramFile = {
        values: [
          {
            sliceDSL: 'context(channel:google)',
            dates: ['1-Oct-25'],  // UK format as stored
            n_daily: [100],
            k_daily: [15],
          }
        ]
      };
      
      // Uses MECE aggregation since file has ONLY contexted data
      const result = calculateIncrementalFetch(
        paramFile as any,
        { start: '2025-10-01T00:00:00.000Z', end: '2025-10-01T23:59:59.000Z' },
        undefined, // querySignature
        false, // bustCache
        '' // Empty targetSlice = uncontexted
      );
      
      // With only one slice (google), MECE considers dates covered if google has them
      expect(result.existingDates.size).toBe(1);  // Oct 1 exists in google = covered
      expect(result.missingDates.length).toBe(0); // Nothing missing
    });

    it('should work with mixed contexted and uncontexted data', () => {
      // Use UK date format as stored in real parameter files
      const paramFile = {
        values: [
          {
            sliceDSL: '', // Uncontexted data
            dates: ['1-Oct-25'],
            n_daily: [50],
            k_daily: [5],
          },
          {
            sliceDSL: 'context(channel:google)',
            dates: ['1-Oct-25', '2-Oct-25'],
            n_daily: [100, 110],
            k_daily: [15, 17],
          }
        ]
      };
      
      // Uncontexted query on mixed data: should use UNCONTEXTED data only
      // (not MECE aggregate from contexted data)
      const uncontextedResult = calculateIncrementalFetch(
        paramFile as any,
        { start: '2025-10-01T00:00:00.000Z', end: '2025-10-02T23:59:59.000Z' },
        undefined, // querySignature
        false, // bustCache
        '' // Empty targetSlice = uncontexted
      );
      
      expect(uncontextedResult.existingDates.size).toBe(1); // Only Oct 1 (from uncontexted)
      expect(uncontextedResult.missingDates.length).toBe(1); // Oct 2 missing (not in uncontexted)
      
      // Contexted query should find contexted data only (direct slice match)
      const googleResult = calculateIncrementalFetch(
        paramFile as any,
        { start: '2025-10-01T00:00:00.000Z', end: '2025-10-02T23:59:59.000Z' },
        undefined, // querySignature
        false, // bustCache
        'context(channel:google)' // targetSlice
      );
      
      expect(googleResult.existingDates.size).toBe(2); // Both days
      expect(googleResult.missingDates.length).toBe(0); // Nothing missing
    });
  });
});

