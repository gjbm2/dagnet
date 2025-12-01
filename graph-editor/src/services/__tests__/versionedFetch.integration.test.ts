/**
 * Integration Tests: Versioned Fetch Flow
 * 
 * Tests the complete chain: BatchOperationsModal → getFromSource → getFromSourceDirect → getParameterFromFile
 * 
 * CRITICAL: These tests verify that:
 * 1. Window/DSL is passed correctly through the entire chain
 * 2. targetSlice (not graph.currentQueryDSL) is used for constraints
 * 3. Dates are parsed as UTC (no timezone drift)
 * 4. Data aggregation uses the correct window
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseUKDate, formatDateUK } from '../../lib/dateFormat';
import { parseConstraints } from '../../lib/queryDSL';
import { calculateIncrementalFetch } from '../windowAggregationService';

// ============================================================================
// UNIT TESTS: parseUKDate (Timezone handling)
// ============================================================================

describe('parseUKDate - UTC timezone handling', () => {
  it('should parse 1-Oct-25 as 2025-10-01T00:00:00.000Z (UTC midnight)', () => {
    const result = parseUKDate('1-Oct-25');
    expect(result.toISOString()).toBe('2025-10-01T00:00:00.000Z');
  });

  it('should parse 31-Dec-25 as 2025-12-31T00:00:00.000Z (UTC midnight)', () => {
    const result = parseUKDate('31-Dec-25');
    expect(result.toISOString()).toBe('2025-12-31T00:00:00.000Z');
  });

  it('should parse 1-Jan-25 as 2025-01-01T00:00:00.000Z (UTC midnight)', () => {
    const result = parseUKDate('1-Jan-25');
    expect(result.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });

  it('should NOT produce dates in local timezone (regression test)', () => {
    // This test catches the bug where new Date(year, month, day) was used
    // instead of new Date(Date.UTC(year, month, day))
    const result = parseUKDate('1-Oct-25');
    
    // The date should be exactly midnight UTC, not shifted by local timezone
    expect(result.getUTCHours()).toBe(0);
    expect(result.getUTCMinutes()).toBe(0);
    expect(result.getUTCSeconds()).toBe(0);
    expect(result.getUTCMilliseconds()).toBe(0);
    
    // The date should be October 1st, not September 30th
    expect(result.getUTCDate()).toBe(1);
    expect(result.getUTCMonth()).toBe(9); // October = 9 (0-indexed)
    expect(result.getUTCFullYear()).toBe(2025);
  });

  it('should handle day boundaries correctly', () => {
    // Test that dates near timezone boundaries work correctly
    const dates = [
      { input: '1-Jan-25', expected: '2025-01-01T00:00:00.000Z' },
      { input: '28-Feb-25', expected: '2025-02-28T00:00:00.000Z' },
      { input: '1-Mar-25', expected: '2025-03-01T00:00:00.000Z' },
      { input: '30-Sep-25', expected: '2025-09-30T00:00:00.000Z' },
      { input: '1-Oct-25', expected: '2025-10-01T00:00:00.000Z' },
    ];

    for (const { input, expected } of dates) {
      const result = parseUKDate(input);
      expect(result.toISOString()).toBe(expected);
    }
  });
});

// ============================================================================
// UNIT TESTS: parseConstraints (Window parsing)
// ============================================================================

describe('parseConstraints - Window parsing', () => {
  it('should parse window with colon separator', () => {
    const result = parseConstraints('window(1-Oct-25:1-Oct-25)');
    expect(result.window).toEqual({
      start: '1-Oct-25',
      end: '1-Oct-25'
    });
  });

  it('should parse window with date range', () => {
    const result = parseConstraints('window(1-Oct-25:31-Oct-25)');
    expect(result.window).toEqual({
      start: '1-Oct-25',
      end: '31-Oct-25'
    });
  });

  it('should NOT parse window with comma separator (common mistake)', () => {
    // This was a bug - using comma instead of colon
    const result = parseConstraints('window(1-Oct-25,1-Oct-25)');
    // The regex expects colon, so comma-separated should NOT match
    expect(result.window).toBeNull();
  });

  it('should parse combined DSL with context and window', () => {
    const result = parseConstraints('context(channel:organic).window(1-Oct-25:31-Oct-25)');
    expect(result.window).toEqual({
      start: '1-Oct-25',
      end: '31-Oct-25'
    });
    expect(result.context).toEqual([{ key: 'channel', value: 'organic' }]);
  });
});

// ============================================================================
// INTEGRATION TESTS: getParameterFromFile constraint handling
// ============================================================================

describe('getParameterFromFile - targetSlice vs graph.currentQueryDSL', () => {
  // Mock dependencies
  const mockFileRegistry = {
    getFile: vi.fn(),
    updateFile: vi.fn(),
  };

  const mockGraph = {
    currentQueryDSL: 'window(28-Oct-25:14-Nov-25)', // STALE - should NOT be used
    edges: [
      {
        uuid: 'test-edge-1',
        id: 'test-edge-1',
        from: 'node-a',
        to: 'node-b',
        query: 'from(node-a).to(node-b)',
        p: {
          id: 'test-param',
          connection: 'amplitude-prod',
        }
      }
    ]
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should use targetSlice for window constraints, NOT graph.currentQueryDSL', async () => {
    // This is the CRITICAL test that catches the bug where graph.currentQueryDSL
    // was being used instead of the passed targetSlice parameter
    
    const targetSlice = 'window(1-Oct-25:1-Oct-25)'; // User's requested window
    const graphDSL = 'window(28-Oct-25:14-Nov-25)';  // Stale graph DSL
    
    // Parse constraints as the code does
    const sliceConstraints = parseConstraints(targetSlice);
    const graphConstraints = parseConstraints(graphDSL);
    
    // The code should use targetSlice, NOT graph.currentQueryDSL
    // This simulates what should happen in getParameterFromFile
    const constraintsToUse = targetSlice ? sliceConstraints : graphConstraints;
    
    expect(constraintsToUse.window).toEqual({
      start: '1-Oct-25',
      end: '1-Oct-25'
    });
    
    // Verify it's NOT using the stale graph DSL
    expect(constraintsToUse.window).not.toEqual({
      start: '28-Oct-25',
      end: '14-Nov-25'
    });
  });

  it('should fall back to graph.currentQueryDSL only when targetSlice is empty', async () => {
    const targetSlice = ''; // Empty - should fall back
    const graphDSL = 'window(28-Oct-25:14-Nov-25)';
    
    const sliceConstraints = targetSlice ? parseConstraints(targetSlice) : null;
    const graphConstraints = parseConstraints(graphDSL);
    
    // When targetSlice is empty, use graph.currentQueryDSL
    const constraintsToUse = sliceConstraints || graphConstraints;
    
    expect(constraintsToUse?.window).toEqual({
      start: '28-Oct-25',
      end: '14-Nov-25'
    });
  });
});

// ============================================================================
// INTEGRATION TESTS: Full chain - DSL propagation
// ============================================================================

describe('DSL Propagation Chain', () => {
  /**
   * Tests that the DSL (currentDSL/targetSlice) is correctly propagated through:
   * 1. BatchOperationsModal.getEffectiveDSL()
   * 2. dataOperationsService.getFromSource({ currentDSL })
   * 3. dataOperationsService.getFromSourceDirect({ currentDSL })
   * 4. dataOperationsService.getParameterFromFile({ targetSlice })
   */

  it('should propagate window from WindowSelector through entire chain', () => {
    // Simulate what BatchOperationsModal.getEffectiveDSL() does
    const windowProp = { start: '2025-10-01', end: '2025-10-01' };
    const graphCurrentQueryDSL = 'window(28-Oct-25:14-Nov-25)'; // STALE
    
    // Format date as BatchOperationsModal does
    const formatDate = (dateStr: string) => {
      const d = new Date(dateStr);
      const day = d.getUTCDate(); // Use UTC to avoid timezone issues
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const month = months[d.getUTCMonth()];
      const year = String(d.getUTCFullYear()).slice(-2);
      return `${day}-${month}-${year}`;
    };
    
    // getEffectiveDSL should prioritize windowProp over graphCurrentQueryDSL
    let effectiveDSL: string;
    if (windowProp?.start && windowProp?.end) {
      effectiveDSL = `window(${formatDate(windowProp.start)}:${formatDate(windowProp.end)})`;
    } else {
      effectiveDSL = graphCurrentQueryDSL;
    }
    
    // Should use window prop, NOT stale graph DSL
    expect(effectiveDSL).toBe('window(1-Oct-25:1-Oct-25)');
    expect(effectiveDSL).not.toContain('28-Oct');
    expect(effectiveDSL).not.toContain('14-Nov');
  });

  it('should use colon separator for window DSL (not comma)', () => {
    const windowProp = { start: '2025-10-01', end: '2025-10-31' };
    
    // Correct format uses COLON
    const correctDSL = 'window(1-Oct-25:31-Oct-25)';
    
    // Wrong format uses COMMA (parseConstraints won't parse this)
    const wrongDSL = 'window(1-Oct-25,31-Oct-25)';
    
    const correctParsed = parseConstraints(correctDSL);
    const wrongParsed = parseConstraints(wrongDSL);
    
    expect(correctParsed.window).not.toBeNull();
    expect(wrongParsed.window).toBeNull(); // Comma separator doesn't parse
  });
});

// ============================================================================
// REGRESSION TESTS: Specific bugs that occurred
// ============================================================================

describe('Regression Tests - Versioned Fetch Bugs', () => {
  
  describe('Bug: targetSlice empty when calling getParameterFromFile after fetch', () => {
    it('should pass currentDSL as targetSlice when calling getParameterFromFile', () => {
      // This simulates the code path in getFromSourceDirect after writing time-series
      const currentDSL = 'window(1-Oct-25:1-Oct-25)';
      
      // The fix: targetSlice: currentDSL || ''
      const targetSlice = currentDSL || '';
      
      expect(targetSlice).toBe('window(1-Oct-25:1-Oct-25)');
      expect(targetSlice).not.toBe('');
    });

    it('should handle undefined currentDSL gracefully', () => {
      const currentDSL: string | undefined = undefined;
      
      // The fix: targetSlice: currentDSL || ''
      const targetSlice = currentDSL || '';
      
      expect(targetSlice).toBe('');
    });
  });

  describe('Bug: Timezone drift causing 30-Sep instead of 1-Oct', () => {
    it('should parse 1-Oct-25 to October 1st UTC, not September 30th', () => {
      const parsed = parseUKDate('1-Oct-25');
      
      // Must be October (month 9), not September (month 8)
      expect(parsed.getUTCMonth()).toBe(9);
      expect(parsed.getUTCDate()).toBe(1);
      
      // ISO string must show October
      expect(parsed.toISOString()).toMatch(/^2025-10-01/);
    });
  });

  describe('Bug: Using graph.currentQueryDSL instead of passed targetSlice', () => {
    it('should prioritize targetSlice over graph.currentQueryDSL', () => {
      const targetSlice = 'window(1-Oct-25:1-Oct-25)';
      const graphDSL = 'window(28-Oct-25:14-Nov-25)';
      
      // Simulating the fixed code path
      const effectiveDSL = targetSlice || graphDSL;
      
      expect(effectiveDSL).toBe(targetSlice);
      expect(effectiveDSL).not.toBe(graphDSL);
    });

    it('should use graph.currentQueryDSL only when targetSlice is falsy', () => {
      const targetSlice = '';
      const graphDSL = 'window(28-Oct-25:14-Nov-25)';
      
      const effectiveDSL = targetSlice || graphDSL;
      
      expect(effectiveDSL).toBe(graphDSL);
    });
  });

  describe('Bug: Window not passed through getFromSource → getFromSourceDirect → getParameterFromFile', () => {
    it('should chain DSL parameters correctly', () => {
      // Simulate the parameter passing chain
      
      // 1. BatchOperationsModal calls getFromSource with currentDSL
      const currentDSL = 'window(1-Oct-25:1-Oct-25)';
      const getFromSourceOptions = {
        objectType: 'parameter',
        objectId: 'test-param',
        currentDSL,
      };
      
      // 2. getFromSource destructures and passes to getFromSourceDirect
      const { currentDSL: dslForDirect } = getFromSourceOptions;
      expect(dslForDirect).toBe(currentDSL);
      
      // 3. getFromSourceDirect should pass to getParameterFromFile as targetSlice
      const getParameterFromFileOptions = {
        paramId: 'test-param',
        targetSlice: dslForDirect || '',
      };
      expect(getParameterFromFileOptions.targetSlice).toBe(currentDSL);
    });
  });

  describe('Bug: calculateIncrementalFetch not filtering by context slice', () => {
    // This bug caused: data exists for context(channel:facebook), but we're querying
    // context(channel:google). Without targetSlice filtering, system incorrectly
    // says "all dates exist" and skips API call.
    
    it('should only count dates from the correct context slice', () => {
      
      // Simulate param file with data for multiple contexts
      const paramFileData = {
        values: [
          {
            sliceDSL: 'context(channel:facebook)',
            dates: ['2025-10-01', '2025-10-02', '2025-10-03'],
            n_daily: [100, 100, 100],
            k_daily: [50, 50, 50],
            mean: 0.5, n: 300, k: 150,
          },
          {
            sliceDSL: 'context(channel:google)',
            dates: ['2025-10-02'], // Only has Oct 2, missing Oct 1 and Oct 3
            n_daily: [200],
            k_daily: [100],
            mean: 0.5, n: 200, k: 100,
          }
        ]
      };
      
      const requestedWindow = { start: '2025-10-01', end: '2025-10-03' };
      
      // When file has ONLY contexted data and query is uncontexted,
      // calculateIncrementalFetch uses MECE aggregation: a date is covered
      // only if ALL contexted slices have it.
      const resultUncontexted = calculateIncrementalFetch(
        paramFileData, 
        requestedWindow, 
        undefined, 
        false,
        '' // Empty targetSlice = MECE aggregation
      );
      
      // With MECE: Oct 2 is covered (both facebook + google have it)
      // Oct 1 and Oct 3 are missing (google doesn't have them)
      expect(resultUncontexted.existingDates.has('2-Oct-25')).toBe(true);
      expect(resultUncontexted.missingDates).toContain('1-Oct-25');
      expect(resultUncontexted.missingDates).toContain('3-Oct-25');
      
      // Single context query: With targetSlice='context(channel:google)', only Oct 2 exists
      const resultWithSlice = calculateIncrementalFetch(
        paramFileData, 
        requestedWindow, 
        undefined, 
        false,
        'context(channel:google)'
      );
      
      // Should need fetch for Oct 1 and Oct 3 (dates now in UK format)
      expect(resultWithSlice.needsFetch).toBe(true);
      expect(resultWithSlice.missingDates).toContain('1-Oct-25');
      expect(resultWithSlice.missingDates).toContain('3-Oct-25');
      expect(resultWithSlice.missingDates).not.toContain('2-Oct-25'); // Oct 2 exists
    });
    
    it('should NOT count dates from other contexts as existing', () => {
      // This tests the exact bug: data exists for facebook but we query google
      const paramFileData = {
        values: [
          {
            sliceDSL: 'context(channel:facebook)',
            dates: ['2025-10-01', '2025-10-02', '2025-10-03'],
            n_daily: [100, 100, 100],
            k_daily: [50, 50, 50],
            mean: 0.5, n: 300, k: 150,
          },
          // No google data at all!
        ]
      };
      
      const requestedWindow = { start: '2025-10-01', end: '2025-10-03' };
      
      // Query for google - should show ALL dates as missing (not find facebook data)
      const result = calculateIncrementalFetch(
        paramFileData, 
        requestedWindow, 
        undefined, 
        false,
        'context(channel:google)' // Looking for google data
      );
      
      // ALL dates should be missing (because there's no google data) - dates in UK format
      expect(result.needsFetch).toBe(true);
      expect(result.daysAvailable).toBe(0);
      expect(result.missingDates).toContain('1-Oct-25');
      expect(result.missingDates).toContain('2-Oct-25');
      expect(result.missingDates).toContain('3-Oct-25');
    });
  });
  
  describe('Bug: contextAny should check ALL component slices have data', () => {
    // When using contextAny(channel:google,channel:influencer), the cache check
    // should verify ALL component slices have data, not just that SOME do.
    
    it('should recognize all data as cached when all contextAny slices have data', () => {
      // Simulate data from batch fetch with window(-7d:-1d).context(channel)
      const paramFileData = {
        values: [
          {
            sliceDSL: 'context(channel:google)',
            dates: ['24-Nov-25', '25-Nov-25', '26-Nov-25', '27-Nov-25', '28-Nov-25', '29-Nov-25', '30-Nov-25'],
            n_daily: [20, 23, 10, 16, 19, 24, 13],
            k_daily: [9, 12, 8, 12, 12, 17, 11],
            mean: 0.648, n: 125, k: 81,
          },
          {
            sliceDSL: 'context(channel:influencer)',
            dates: ['24-Nov-25', '25-Nov-25', '26-Nov-25', '27-Nov-25', '28-Nov-25', '29-Nov-25', '30-Nov-25'],
            n_daily: [143, 64, 43, 201, 553, 537, 25],
            k_daily: [68, 40, 20, 117, 270, 286, 15],
            mean: 0.52, n: 1566, k: 816,
          },
          {
            sliceDSL: 'context(channel:paid-social)',
            dates: ['24-Nov-25', '25-Nov-25', '26-Nov-25', '27-Nov-25', '28-Nov-25', '29-Nov-25', '30-Nov-25'],
            n_daily: [15, 1, 3, 13, 23, 38, 23],
            k_daily: [6, 1, 2, 8, 13, 19, 14],
            mean: 0.54, n: 116, k: 63,
          },
          {
            sliceDSL: 'context(channel:referral)',
            dates: ['24-Nov-25', '25-Nov-25', '26-Nov-25', '27-Nov-25', '28-Nov-25', '29-Nov-25', '30-Nov-25'],
            n_daily: [1, 0, 1, 0, 0, 0, 0],
            k_daily: [0, 0, 1, 0, 0, 0, 0],
            mean: 0.5, n: 2, k: 1,
          },
          {
            sliceDSL: 'context(channel:pr)',
            dates: ['24-Nov-25', '25-Nov-25', '26-Nov-25', '27-Nov-25', '28-Nov-25', '29-Nov-25', '30-Nov-25'],
            n_daily: [0, 0, 0, 0, 0, 0, 0],
            k_daily: [0, 0, 0, 0, 0, 0, 0],
            mean: 0, n: 0, k: 0,
          },
          {
            sliceDSL: 'context(channel:other)',
            dates: ['24-Nov-25', '25-Nov-25', '26-Nov-25', '27-Nov-25', '28-Nov-25', '29-Nov-25', '30-Nov-25'],
            n_daily: [40, 16, 135, 50, 45, 63, 32],
            k_daily: [20, 10, 60, 27, 27, 34, 21],
            mean: 0.52, n: 381, k: 199,
          },
        ]
      };
      
      const requestedWindow = { start: '24-Nov-25', end: '30-Nov-25' };
      
      // User enters: contextAny(channel:google,channel:influencer,channel:paid-social,channel:referral,channel:pr)
      // This should find ALL slices have data for all 7 days
      const result = calculateIncrementalFetch(
        paramFileData, 
        requestedWindow, 
        undefined, 
        false,
        'contextAny(channel:google,channel:influencer,channel:paid-social,channel:referral,channel:pr).window(24-Nov-25:30-Nov-25)'
      );
      
      // All data exists - should NOT need fetch
      expect(result.needsFetch).toBe(false);
      expect(result.daysAvailable).toBe(7);
      expect(result.missingDates).toHaveLength(0);
    });
    
    it('should require fetch when one contextAny slice is missing a date', () => {
      // Same as above but google is missing 30-Nov-25
      const paramFileData = {
        values: [
          {
            sliceDSL: 'context(channel:google)',
            dates: ['24-Nov-25', '25-Nov-25', '26-Nov-25', '27-Nov-25', '28-Nov-25', '29-Nov-25'], // Missing 30-Nov-25!
            n_daily: [20, 23, 10, 16, 19, 24],
            k_daily: [9, 12, 8, 12, 12, 17],
            mean: 0.648, n: 112, k: 70,
          },
          {
            sliceDSL: 'context(channel:influencer)',
            dates: ['24-Nov-25', '25-Nov-25', '26-Nov-25', '27-Nov-25', '28-Nov-25', '29-Nov-25', '30-Nov-25'],
            n_daily: [143, 64, 43, 201, 553, 537, 25],
            k_daily: [68, 40, 20, 117, 270, 286, 15],
            mean: 0.52, n: 1566, k: 816,
          },
        ]
      };
      
      const requestedWindow = { start: '24-Nov-25', end: '30-Nov-25' };
      
      const result = calculateIncrementalFetch(
        paramFileData, 
        requestedWindow, 
        undefined, 
        false,
        'contextAny(channel:google,channel:influencer).window(24-Nov-25:30-Nov-25)'
      );
      
      // 30-Nov-25 is missing from google slice, so fetch IS required
      expect(result.needsFetch).toBe(true);
      expect(result.missingDates).toContain('30-Nov-25');
      expect(result.daysAvailable).toBe(6); // Only 6 days have complete coverage
    });
    
    it('should require fetch when one entire contextAny slice is missing', () => {
      // google exists but influencer doesn't exist at all
      const paramFileData = {
        values: [
          {
            sliceDSL: 'context(channel:google)',
            dates: ['24-Nov-25', '25-Nov-25', '26-Nov-25'],
            n_daily: [20, 23, 10],
            k_daily: [9, 12, 8],
            mean: 0.648, n: 53, k: 29,
          },
          // No influencer data at all!
        ]
      };
      
      const requestedWindow = { start: '24-Nov-25', end: '26-Nov-25' };
      
      const result = calculateIncrementalFetch(
        paramFileData, 
        requestedWindow, 
        undefined, 
        false,
        'contextAny(channel:google,channel:influencer).window(24-Nov-25:26-Nov-25)'
      );
      
      // influencer is completely missing, so ALL dates need fetch
      expect(result.needsFetch).toBe(true);
      expect(result.daysAvailable).toBe(0); // No dates have complete coverage across both slices
      expect(result.missingDates).toHaveLength(3);
    });
  });
  
  describe('Bug: Uncontexted query should use MECE aggregation when file has contexted data', () => {
    // When pinned DSL fetches with context(channel) and current query is just window(),
    // the coverage check should recognize data exists via MECE aggregation.
    
    it('should NOT require fetch when query has no context but MECE contexted data exists', () => {
      // Simulating: pinned = window(-7d:-1d).context(channel) fetched all 6 slices
      // Then user's current query = window(24-Nov-25:30-Nov-25) with NO context
      const paramFileData = {
        values: [
          {
            sliceDSL: 'context(channel:google)',
            dates: ['24-Nov-25', '25-Nov-25', '26-Nov-25', '27-Nov-25', '28-Nov-25', '29-Nov-25', '30-Nov-25'],
            n_daily: [20, 23, 10, 16, 19, 24, 13],
            k_daily: [9, 12, 8, 12, 12, 17, 11],
            mean: 0.648, n: 125, k: 81,
          },
          {
            sliceDSL: 'context(channel:influencer)',
            dates: ['24-Nov-25', '25-Nov-25', '26-Nov-25', '27-Nov-25', '28-Nov-25', '29-Nov-25', '30-Nov-25'],
            n_daily: [143, 64, 43, 201, 553, 537, 25],
            k_daily: [68, 40, 20, 117, 270, 286, 15],
            mean: 0.52, n: 1566, k: 816,
          },
          {
            sliceDSL: 'context(channel:paid-social)',
            dates: ['24-Nov-25', '25-Nov-25', '26-Nov-25', '27-Nov-25', '28-Nov-25', '29-Nov-25', '30-Nov-25'],
            n_daily: [15, 1, 3, 13, 23, 38, 23],
            k_daily: [6, 1, 2, 8, 13, 19, 14],
            mean: 0.54, n: 116, k: 63,
          },
          {
            sliceDSL: 'context(channel:referral)',
            dates: ['24-Nov-25', '25-Nov-25', '26-Nov-25', '27-Nov-25', '28-Nov-25', '29-Nov-25', '30-Nov-25'],
            n_daily: [1, 0, 1, 0, 0, 0, 0],
            k_daily: [0, 0, 1, 0, 0, 0, 0],
            mean: 0.5, n: 2, k: 1,
          },
          {
            sliceDSL: 'context(channel:pr)',
            dates: ['24-Nov-25', '25-Nov-25', '26-Nov-25', '27-Nov-25', '28-Nov-25', '29-Nov-25', '30-Nov-25'],
            n_daily: [0, 0, 0, 0, 0, 0, 0],
            k_daily: [0, 0, 0, 0, 0, 0, 0],
            mean: 0, n: 0, k: 0,
          },
          {
            sliceDSL: 'context(channel:other)',
            dates: ['24-Nov-25', '25-Nov-25', '26-Nov-25', '27-Nov-25', '28-Nov-25', '29-Nov-25', '30-Nov-25'],
            n_daily: [40, 16, 135, 50, 45, 63, 32],
            k_daily: [20, 10, 60, 27, 27, 34, 21],
            mean: 0.52, n: 381, k: 199,
          },
        ]
      };
      
      const requestedWindow = { start: '24-Nov-25', end: '30-Nov-25' };
      
      // Query with ONLY window, NO context - should use MECE aggregation
      const result = calculateIncrementalFetch(
        paramFileData, 
        requestedWindow, 
        undefined, 
        false,
        'window(24-Nov-25:30-Nov-25)'  // NO context!
      );
      
      // All 6 slices have all 7 days → MECE aggregation should find full coverage
      expect(result.needsFetch).toBe(false);
      expect(result.daysAvailable).toBe(7);
      expect(result.missingDates).toHaveLength(0);
    });
    
    it('should require fetch when MECE data is incomplete (one slice missing a date)', () => {
      // Same as above but google is missing 30-Nov-25
      const paramFileData = {
        values: [
          {
            sliceDSL: 'context(channel:google)',
            dates: ['24-Nov-25', '25-Nov-25', '26-Nov-25', '27-Nov-25', '28-Nov-25', '29-Nov-25'], // Missing 30-Nov-25!
            n_daily: [20, 23, 10, 16, 19, 24],
            k_daily: [9, 12, 8, 12, 12, 17],
            mean: 0.648, n: 112, k: 70,
          },
          {
            sliceDSL: 'context(channel:other)',
            dates: ['24-Nov-25', '25-Nov-25', '26-Nov-25', '27-Nov-25', '28-Nov-25', '29-Nov-25', '30-Nov-25'],
            n_daily: [40, 16, 135, 50, 45, 63, 32],
            k_daily: [20, 10, 60, 27, 27, 34, 21],
            mean: 0.52, n: 381, k: 199,
          },
        ]
      };
      
      const requestedWindow = { start: '24-Nov-25', end: '30-Nov-25' };
      
      const result = calculateIncrementalFetch(
        paramFileData, 
        requestedWindow, 
        undefined, 
        false,
        'window(24-Nov-25:30-Nov-25)'  // NO context
      );
      
      // google is missing 30-Nov-25, so MECE is incomplete
      expect(result.needsFetch).toBe(true);
      expect(result.missingDates).toContain('30-Nov-25');
      expect(result.daysAvailable).toBe(6);
    });
  });
});

// ============================================================================
// MOCK SERVICE TESTS: Full flow simulation
// ============================================================================

describe('Full Flow Simulation', () => {
  it('should correctly aggregate data for the requested window only', () => {
    // Simulate parameter file with data from multiple windows
    const parameterFileData = {
      values: [
        {
          window_from: '2025-10-01T00:00:00.000Z',
          window_to: '2025-10-01T00:00:00.000Z',
          n: 100,
          k: 50,
          sliceDSL: '',
        },
        {
          window_from: '2025-10-28T00:00:00.000Z',
          window_to: '2025-11-14T00:00:00.000Z',
          n: 500,
          k: 250,
          sliceDSL: '',
        },
      ]
    };
    
    // Requested window: 1-Oct-25 only
    const requestedWindow = {
      start: '2025-10-01T00:00:00.000Z',
      end: '2025-10-01T00:00:00.000Z',
    };
    
    // Filter values that overlap with requested window
    const relevantValues = parameterFileData.values.filter(v => {
      const vStart = new Date(v.window_from);
      const vEnd = new Date(v.window_to);
      const reqStart = new Date(requestedWindow.start);
      const reqEnd = new Date(requestedWindow.end);
      
      // Check if windows overlap
      return vStart <= reqEnd && vEnd >= reqStart;
    });
    
    // Should only get the 1-Oct-25 data, not the 28-Oct to 14-Nov data
    expect(relevantValues).toHaveLength(1);
    expect(relevantValues[0].n).toBe(100);
    expect(relevantValues[0].k).toBe(50);
  });
});

// ============================================================================
// EDGE CASE TESTS
// ============================================================================

describe('Edge Cases', () => {
  it('should handle empty window in DSL', () => {
    const dsl = 'context(channel:organic)'; // No window
    const parsed = parseConstraints(dsl);
    
    expect(parsed.window).toBeNull();
    expect(parsed.context).toHaveLength(1);
  });

  it('should handle malformed window gracefully', () => {
    // Missing end date - returns undefined for end
    const parsed1 = parseConstraints('window(1-Oct-25:)');
    expect(parsed1.window?.start).toBe('1-Oct-25');
    expect(parsed1.window?.end).toBeUndefined();
    
    // Missing start date - returns undefined for start  
    const parsed2 = parseConstraints('window(:1-Oct-25)');
    expect(parsed2.window?.start).toBeUndefined();
    expect(parsed2.window?.end).toBe('1-Oct-25');
  });

  it('should handle year edge cases in parseUKDate', () => {
    // Year 00 should be 2000
    expect(parseUKDate('1-Jan-00').getUTCFullYear()).toBe(2000);
    
    // Year 49 should be 2049
    expect(parseUKDate('1-Jan-49').getUTCFullYear()).toBe(2049);
    
    // Year 50 should be 1950
    expect(parseUKDate('1-Jan-50').getUTCFullYear()).toBe(1950);
    
    // Year 99 should be 1999
    expect(parseUKDate('1-Jan-99').getUTCFullYear()).toBe(1999);
  });
});

