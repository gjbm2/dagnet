/**
 * Fetch Policy Integration Tests
 * 
 * Tests the interplay between:
 * - shouldRefetch (policy decisions)
 * - calculateIncrementalFetch (gap detection)
 * - The resulting fetch windows in getFromSourceDirect
 * 
 * These tests verify that policy decisions correctly influence which
 * dates get fetched, without executing actual API calls.
 * 
 * Mock Strategy: We mock only the DAS runner (external API layer).
 * Everything else uses real code paths.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  calculateIncrementalFetch,
  mergeTimeSeriesIntoParameter,
} from '../windowAggregationService';
import {
  shouldRefetch,
  computeFetchWindow,
  analyzeSliceCoverage,
  type RefetchDecision,
} from '../fetchRefetchPolicy';
import { isolateSlice, extractSliceDimensions } from '../sliceIsolation';
import type { ParameterValue } from '../../types/parameterData';

// =============================================================================
// Test Infrastructure
// =============================================================================

const REFERENCE_DATE = new Date('2025-12-09T12:00:00Z');

function daysAgo(n: number): string {
  const d = new Date(REFERENCE_DATE);
  d.setDate(d.getDate() - n);
  const day = d.getDate();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${day}-${months[d.getMonth()]}-${String(d.getFullYear() % 100).padStart(2, '0')}`;
}

/** Build a param file fixture with controlled values */
function buildParamFile(values: ParameterValue[]): { values: ParameterValue[] } {
  return { values };
}

/** Build a window ParameterValue with full coverage for a date range */
function buildWindowValue(options: {
  startDaysAgo: number;
  endDaysAgo: number;
  sliceDSL?: string;
  n?: number;
  k?: number;
}): ParameterValue {
  const { startDaysAgo, endDaysAgo, sliceDSL, n = 100, k = 50 } = options;
  
  const dates: string[] = [];
  for (let i = startDaysAgo; i >= endDaysAgo; i--) {
    dates.push(daysAgo(i));
  }
  
  const numDays = dates.length;
  const perDayN = Math.floor(n / numDays);
  const perDayK = Math.floor(k / numDays);
  
  return {
    mean: n > 0 ? k / n : 0,
    n,
    k,
    dates,
    n_daily: dates.map(() => perDayN),
    k_daily: dates.map(() => perDayK),
    window_from: dates[0],
    window_to: dates[dates.length - 1],
    sliceDSL: sliceDSL || `window(${dates[0]}:${dates[dates.length - 1]})`,
    data_source: {
      type: 'api',
      retrieved_at: new Date(REFERENCE_DATE.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    },
  };
}

/** Build a cohort ParameterValue */
function buildCohortValue(options: {
  dates: string[];
  sliceDSL?: string;
  n?: number;
  k?: number;
  retrievedDaysAgo?: number;
}): ParameterValue {
  const { dates, sliceDSL, n = 100, k = 50, retrievedDaysAgo = 1 } = options;
  
  const numDays = dates.length;
  const perDayN = Math.floor(n / numDays);
  const perDayK = Math.floor(k / numDays);
  
  const retrievedAt = new Date(REFERENCE_DATE);
  retrievedAt.setDate(retrievedAt.getDate() - retrievedDaysAgo);
  
  return {
    mean: n > 0 ? k / n : 0,
    n,
    k,
    dates,
    n_daily: dates.map(() => perDayN),
    k_daily: dates.map(() => perDayK),
    cohort_from: dates[0],
    cohort_to: dates[dates.length - 1],
    sliceDSL: sliceDSL || `cohort(anchor,${dates[0]}:${dates[dates.length - 1]})`,
    data_source: {
      type: 'api',
      retrieved_at: retrievedAt.toISOString(),
    },
  };
}

// =============================================================================
// 1. Policy "use_cache" Scenarios
// =============================================================================

describe('Policy: use_cache – No Fetch Required', () => {
  
  describe('Cohort with all mature data', () => {
    it('shouldRefetch returns use_cache for mature cohort slice', () => {
      // All cohort dates are > 10 days ago (mature with t95=7)
      const existingSlice = buildCohortValue({
        dates: [daysAgo(30), daysAgo(25), daysAgo(20), daysAgo(15), daysAgo(10)],
        retrievedDaysAgo: 2,
      });
      
      const decision = shouldRefetch({
        existingSlice,
        latencyConfig: { latency_parameter: true, t95: 7 },
        requestedWindow: { start: daysAgo(30), end: daysAgo(10) },
        isCohortQuery: true,
        referenceDate: REFERENCE_DATE,
      });
      
      expect(decision.type).toBe('use_cache');
    });
    
    it('computeFetchWindow returns null for use_cache', () => {
      const decision: RefetchDecision = { type: 'use_cache' };
      const coverage = { missingMatureDates: [], immatureDates: [] };
      
      const fetchWindow = computeFetchWindow(
        decision,
        coverage,
        { start: daysAgo(30), end: daysAgo(10) }
      );
      
      expect(fetchWindow).toBeNull();
    });
  });
  
  describe('Window with complete mature coverage and mature request', () => {
    it('calculateIncrementalFetch returns needsFetch=false for fully cached window', () => {
      // Param file has complete coverage for days 20-10
      const paramFile = buildParamFile([
        buildWindowValue({ startDaysAgo: 20, endDaysAgo: 10 }),
      ]);
      
      // Request exactly the cached range
      const result = calculateIncrementalFetch(
        paramFile,
        { start: daysAgo(20), end: daysAgo(10) },
        undefined, // no signature filter
        false,     // not busting cache
        ''         // no slice filter
      );
      
      expect(result.needsFetch).toBe(false);
      expect(result.daysAvailable).toBe(11); // Days 20 through 10 inclusive
      expect(result.daysToFetch).toBe(0);
    });
  });
});

// =============================================================================
// 2. Policy "partial" Scenarios
// =============================================================================

describe('Policy: partial – Immature Portion Refetch', () => {
  
  describe('Window straddling maturity cutoff', () => {
    it('shouldRefetch identifies correct immature portion', () => {
      // Request days 20-0 with t95=7
      // Cutoff is 8 days ago
      // Days 7-0 need refetch (immature)
      const decision = shouldRefetch({
        existingSlice: undefined,
        latencyConfig: { latency_parameter: true, t95: 7 },
        requestedWindow: { start: daysAgo(20), end: daysAgo(0) },
        isCohortQuery: false,
        referenceDate: REFERENCE_DATE,
      });
      
      expect(decision.type).toBe('partial');
      expect(decision.refetchWindow).toEqual({
        start: daysAgo(8),
        end: daysAgo(0),
      });
    });
    
    it('calculateIncrementalFetch finds missing dates when no aggregate data', () => {
      // Existing coverage: days 20-10, but WITHOUT aggregate data (only daily)
      // This bypasses the FAST PATH which checks for mean + n
      const dates: string[] = [];
      for (let i = 20; i >= 10; i--) dates.push(daysAgo(i));
      
      const value: ParameterValue = {
        // NO mean or n - this is the key to bypass FAST PATH
        dates,
        n_daily: dates.map(() => 100),
        k_daily: dates.map(() => 50),
        window_from: dates[0],
        window_to: dates[dates.length - 1],
      };
      const paramFile = buildParamFile([value]);
      
      // Request days 20-0
      const result = calculateIncrementalFetch(
        paramFile,
        { start: daysAgo(20), end: daysAgo(0) },
        undefined,
        false,
        ''
      );
      
      expect(result.needsFetch).toBe(true);
      // Missing: days 9-0 = 10 days
      expect(result.daysToFetch).toBe(10);
      // Available: days 20-10 = 11 days
      expect(result.daysAvailable).toBe(11);
    });
  });
  
  describe('Partial with mature gaps', () => {
    it('analyzeSliceCoverage detects gaps in mature region', () => {
      // Coverage has gap at day 15 in mature region
      const existingSlice = buildWindowValue({ startDaysAgo: 20, endDaysAgo: 16 });
      // Add another value for days 14-10, leaving day 15 missing
      const existingSlice2 = buildWindowValue({ startDaysAgo: 14, endDaysAgo: 10 });
      
      // Merge them to simulate current param file state
      // For this test, we manually construct the dates array
      const combinedDates = [
        ...existingSlice.dates!,
        // Gap at day 15
        ...existingSlice2.dates!,
      ];
      
      const combinedSlice: ParameterValue = {
        mean: 0.5,
        n: 1000,
        k: 500,
        dates: combinedDates,
        n_daily: combinedDates.map(() => 50),
        k_daily: combinedDates.map(() => 25),
        window_from: combinedDates[0],
        window_to: combinedDates[combinedDates.length - 1],
      };
      
      const coverage = analyzeSliceCoverage(
        combinedSlice,
        { start: daysAgo(20), end: daysAgo(0) },
        daysAgo(8) // cutoff
      );
      
      // Day 15 should be in missingMatureDates
      expect(coverage.missingMatureDates).toContain(daysAgo(15));
      expect(coverage.matureCoverage).toBe('partial');
    });
    
    it('computeFetchWindow extends to cover mature gaps', () => {
      const partialDecision: RefetchDecision = {
        type: 'partial',
        refetchWindow: { start: daysAgo(8), end: daysAgo(0) },
      };
      
      const coverage = {
        missingMatureDates: [daysAgo(15)], // Gap in mature region
        immatureDates: [daysAgo(7), daysAgo(6), daysAgo(5)],
      };
      
      const fetchWindow = computeFetchWindow(
        partialDecision,
        coverage,
        { start: daysAgo(20), end: daysAgo(0) }
      );
      
      // Should extend from day 15 (earliest gap) to day 0
      expect(fetchWindow!.start).toBe(daysAgo(15));
      expect(fetchWindow!.end).toBe(daysAgo(0));
    });
  });
  
  describe('t95-driven partial refetch', () => {
    it('uses t95 to determine immature cutoff', () => {
      // t95 = 14 days
      const decision = shouldRefetch({
        existingSlice: undefined,
        latencyConfig: { latency_parameter: true, t95: 14 },
        requestedWindow: { start: daysAgo(30), end: daysAgo(0) },
        isCohortQuery: false,
        referenceDate: REFERENCE_DATE,
      });
      
      expect(decision.type).toBe('partial');
      // Cutoff should be ceil(14) + 1 = 15 days ago
      expect(decision.matureCutoff).toBe(daysAgo(15));
      expect(decision.refetchWindow).toEqual({
        start: daysAgo(15),
        end: daysAgo(0),
      });
    });
    
    it('wider immature window means more days to fetch', () => {
      // Build value WITHOUT aggregate data to bypass FAST PATH
      const dates: string[] = [];
      for (let i = 30; i >= 16; i--) dates.push(daysAgo(i));
      
      const value: ParameterValue = {
        // NO mean or n
        dates,
        n_daily: dates.map(() => 100),
        k_daily: dates.map(() => 50),
        window_from: dates[0],
        window_to: dates[dates.length - 1],
      };
      const paramFile = buildParamFile([value]);
      
      const result = calculateIncrementalFetch(
        paramFile,
        { start: daysAgo(30), end: daysAgo(0) },
        undefined,
        false,
        ''
      );
      
      // Days 15-0 are missing = 16 days
      expect(result.needsFetch).toBe(true);
      expect(result.daysToFetch).toBe(16);
    });
  });
});

// =============================================================================
// 3. Policy "replace_slice" Scenarios (Cohort Mode)
// =============================================================================

describe('Policy: replace_slice – Full Cohort Replacement', () => {
  
  describe('Cohort with immature entries', () => {
    it('shouldRefetch returns replace_slice for immature cohorts', () => {
      const existingSlice = buildCohortValue({
        dates: [daysAgo(30), daysAgo(20), daysAgo(3)], // Day 3 is immature
        retrievedDaysAgo: 1,
      });
      
      const decision = shouldRefetch({
        existingSlice,
        latencyConfig: { latency_parameter: true, t95: 7 },
        requestedWindow: { start: daysAgo(30), end: daysAgo(0) },
        isCohortQuery: true,
        referenceDate: REFERENCE_DATE,
      });
      
      expect(decision.type).toBe('replace_slice');
      expect(decision.reason).toBe('immature_cohorts');
    });
    
    it('mergeTimeSeriesIntoParameter in cohort mode replaces entire slice', () => {
      // Existing cohort values
      const existingValues: ParameterValue[] = [
        buildCohortValue({ dates: [daysAgo(30), daysAgo(25)] }),
        buildCohortValue({ dates: [daysAgo(20), daysAgo(15)] }),
      ];
      
      // New fetch with different dates
      const newTimeSeries = [
        { date: daysAgo(10), n: 100, k: 50, p: 0.5 },
        { date: daysAgo(5), n: 100, k: 50, p: 0.5 },
      ];
      
      const result = mergeTimeSeriesIntoParameter(
        existingValues,
        newTimeSeries,
        { start: daysAgo(10), end: daysAgo(5) },
        undefined,
        undefined,
        undefined,
        'api',
        '',
        { isCohortMode: true }
      );
      
      // Should have exactly ONE cohort value (the new one)
      const cohortValues = result.filter(v => 
        v.cohort_from || v.cohort_to || v.sliceDSL?.includes('cohort(')
      );
      
      expect(cohortValues.length).toBe(1);
      expect(cohortValues[0].dates).toContain(daysAgo(10));
      expect(cohortValues[0].dates).toContain(daysAgo(5));
    });
  });
  
  describe('Cohort calculateIncrementalFetch bypass', () => {
    it('policy replace_slice means calculateIncrementalFetch is not used for fetch planning', () => {
      // Even if calculateIncrementalFetch would say "all cached", 
      // the replace_slice policy forces a full refetch
      const paramFile = buildParamFile([
        buildCohortValue({
          dates: [daysAgo(30), daysAgo(25), daysAgo(20), daysAgo(15), daysAgo(10), daysAgo(5)],
          retrievedDaysAgo: 1,
        }),
      ]);
      
      // For cohort mode with immature cohorts, policy says replace
      const decision = shouldRefetch({
        existingSlice: paramFile.values[0],
        latencyConfig: { latency_parameter: true, t95: 7 },
        requestedWindow: { start: daysAgo(30), end: daysAgo(0) },
        isCohortQuery: true,
        referenceDate: REFERENCE_DATE,
      });
      
      expect(decision.type).toBe('replace_slice');
      
      // computeFetchWindow returns full window for replace_slice
      const fetchWindow = computeFetchWindow(
        decision,
        { missingMatureDates: [], immatureDates: [] },
        { start: daysAgo(30), end: daysAgo(0) }
      );
      
      expect(fetchWindow).toEqual({ start: daysAgo(30), end: daysAgo(0) });
    });
  });
});

// =============================================================================
// 4. Policy "gaps_only" Scenarios (Non-Latency Edges)
// =============================================================================

describe('Policy: gaps_only – Standard Incremental Fetch', () => {
  
  describe('Non-latency edge (latency disabled)', () => {
    it('shouldRefetch returns gaps_only regardless of data state', () => {
      const decision = shouldRefetch({
        existingSlice: undefined,
        latencyConfig: { latency_parameter: false },
        requestedWindow: { start: daysAgo(30), end: daysAgo(0) },
        isCohortQuery: false,
        referenceDate: REFERENCE_DATE,
      });
      
      expect(decision.type).toBe('gaps_only');
    });
  });
  
  describe('Gap detection with non-latency edge', () => {
    it('calculateIncrementalFetch finds all gaps (no aggregate data)', () => {
      // Param file with a gap in the middle
      // Build values WITHOUT aggregate data to bypass FAST PATH
      const dates1: string[] = [];
      for (let i = 30; i >= 20; i--) dates1.push(daysAgo(i));
      
      const dates2: string[] = [];
      for (let i = 10; i >= 0; i--) dates2.push(daysAgo(i));
      
      const value1: ParameterValue = {
        dates: dates1,
        n_daily: dates1.map(() => 100),
        k_daily: dates1.map(() => 50),
        window_from: dates1[0],
        window_to: dates1[dates1.length - 1],
      };
      
      const value2: ParameterValue = {
        dates: dates2,
        n_daily: dates2.map(() => 100),
        k_daily: dates2.map(() => 50),
        window_from: dates2[0],
        window_to: dates2[dates2.length - 1],
      };
      
      const paramFile = buildParamFile([value1, value2]);
      
      const result = calculateIncrementalFetch(
        paramFile,
        { start: daysAgo(30), end: daysAgo(0) },
        undefined,
        false,
        ''
      );
      
      expect(result.needsFetch).toBe(true);
      // Gap is days 19-11 = 9 days
      expect(result.daysToFetch).toBe(9);
      expect(result.fetchWindows.length).toBe(1);
      // Note: fetchWindows use ISO format internally
      expect(result.fetchWindows[0].start).toContain('2025-11-20');
      expect(result.fetchWindows[0].end).toContain('2025-11-28');
    });
    
    it('multiple gaps produce multiple fetch windows (no aggregate data)', () => {
      // Param file with THREE regions, no aggregate data
      const dates1 = [daysAgo(30), daysAgo(29), daysAgo(28)];
      const dates2 = [daysAgo(20), daysAgo(19), daysAgo(18)];
      const dates3 = [daysAgo(5), daysAgo(4), daysAgo(3)];
      
      // Values without mean/n to bypass FAST PATH
      const value1: ParameterValue = {
        dates: dates1,
        n_daily: [100, 100, 100],
        k_daily: [50, 50, 50],
        window_from: dates1[0],
        window_to: dates1[dates1.length - 1],
      };
      
      const value2: ParameterValue = {
        dates: dates2,
        n_daily: [100, 100, 100],
        k_daily: [50, 50, 50],
        window_from: dates2[0],
        window_to: dates2[dates2.length - 1],
      };
      
      const value3: ParameterValue = {
        dates: dates3,
        n_daily: [100, 100, 100],
        k_daily: [50, 50, 50],
        window_from: dates3[0],
        window_to: dates3[dates3.length - 1],
      };
      
      const paramFile = buildParamFile([value1, value2, value3]);
      
      const result = calculateIncrementalFetch(
        paramFile,
        { start: daysAgo(30), end: daysAgo(0) },
        undefined,
        false,
        ''
      );
      
      expect(result.needsFetch).toBe(true);
      // Should have gaps: 27-21 (7 days), 17-6 (12 days), 2-0 (3 days)
      expect(result.fetchWindows.length).toBe(3);
    });
  });
});

// =============================================================================
// 5. Slice Isolation Integration
// =============================================================================

describe('Policy with Slice Isolation', () => {
  
  describe('Context-filtered fetch planning', () => {
    it('calculateIncrementalFetch respects slice isolation (no aggregate)', () => {
      // Param file with two context slices, WITHOUT aggregate to bypass FAST PATH
      const ukSlice: ParameterValue = {
        dates: [daysAgo(30), daysAgo(29), daysAgo(28)],
        n_daily: [333, 333, 334],
        k_daily: [166, 166, 168],
        window_from: daysAgo(30),
        window_to: daysAgo(28),
        sliceDSL: 'window(' + daysAgo(30) + ':' + daysAgo(28) + ').context(geo=UK)',
      };
      
      const usSlice: ParameterValue = {
        dates: [daysAgo(25), daysAgo(24), daysAgo(23)],
        n_daily: [333, 333, 334],
        k_daily: [166, 166, 168],
        window_from: daysAgo(25),
        window_to: daysAgo(23),
        sliceDSL: 'window(' + daysAgo(25) + ':' + daysAgo(23) + ').context(geo=US)',
      };
      
      const paramFile = buildParamFile([ukSlice, usSlice]);
      
      // Request for UK context only
      const result = calculateIncrementalFetch(
        paramFile,
        { start: daysAgo(30), end: daysAgo(20) },
        undefined,
        false,
        'context(geo=UK)' // Target slice
      );
      
      // UK slice covers 30-28, so 27-20 are missing = 8 days
      expect(result.needsFetch).toBe(true);
      expect(result.daysToFetch).toBe(8);
    });
  });
  
  describe('Mixed cohort/window param file', () => {
    it('window query treats file with aggregate data as cached', () => {
      // Param file with both window and cohort slices
      // Note: When aggregate data exists AND fully covers requested window, FAST PATH returns cached
      // CRITICAL: The window slice must FULLY CONTAIN the requested window for fast path to trigger
      const windowSlice: ParameterValue = {
        mean: 0.5, // Has aggregate data → FAST PATH triggers
        n: 1100,
        k: 550,
        dates: [daysAgo(30), daysAgo(29), daysAgo(28), daysAgo(27), daysAgo(26), 
                daysAgo(25), daysAgo(24), daysAgo(23), daysAgo(22), daysAgo(21), daysAgo(20)],
        n_daily: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100],
        k_daily: [50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50],
        window_from: daysAgo(30),
        window_to: daysAgo(20), // Must cover full requested window
        sliceDSL: `window(${daysAgo(30)}:${daysAgo(20)})`,
      };
      
      const cohortSlice: ParameterValue = {
        mean: 0.5,
        n: 300,
        k: 150,
        dates: [daysAgo(90), daysAgo(80), daysAgo(70)],
        n_daily: [100, 100, 100],
        k_daily: [50, 50, 50],
        cohort_from: daysAgo(90),
        cohort_to: daysAgo(70),
        sliceDSL: `cohort(anchor,${daysAgo(90)}:${daysAgo(70)})`,
      };
      
      const paramFile = buildParamFile([windowSlice, cohortSlice]);
      
      // Window query with aggregate data present AND full coverage → FAST PATH returns cached
      // This is CORRECT behavior: we have usable aggregate data covering the entire requested window
      const result = calculateIncrementalFetch(
        paramFile,
        { start: daysAgo(30), end: daysAgo(20) },
        undefined,
        false,
        '' // Uncontexted query
      );
      
      // FAST PATH: aggregate data exists with full coverage → no fetch needed
      expect(result.needsFetch).toBe(false);
    });
    
    it('policy evaluation uses correct slice type for window vs cohort queries', () => {
      // Window slice: all mature
      const windowSlice = buildWindowValue({ startDaysAgo: 30, endDaysAgo: 20 });
      windowSlice.data_source = { type: 'api', retrieved_at: new Date().toISOString() };
      
      // Cohort slice: has immature cohort
      const cohortSlice = buildCohortValue({ 
        dates: [daysAgo(60), daysAgo(50), daysAgo(5)], // Day 5 is immature
        retrievedDaysAgo: 1,
      });
      
      // Window query should see use_cache (window data is mature)
      const windowDecision = shouldRefetch({
        existingSlice: windowSlice,
        latencyConfig: { latency_parameter: true, t95: 7 },
        requestedWindow: { start: daysAgo(30), end: daysAgo(20) },
        isCohortQuery: false,
        referenceDate: REFERENCE_DATE,
      });
      expect(windowDecision.type).toBe('gaps_only');
      
      // Cohort query should see replace_slice (has immature cohort)
      const cohortDecision = shouldRefetch({
        existingSlice: cohortSlice,
        latencyConfig: { latency_parameter: true, t95: 7 },
        requestedWindow: { start: daysAgo(60), end: daysAgo(0) },
        isCohortQuery: true,
        referenceDate: REFERENCE_DATE,
      });
      expect(cohortDecision.type).toBe('replace_slice');
      expect(cohortDecision.hasImmatureCohorts).toBe(true);
    });
  });
  
  describe('Policy decision with contexted slice', () => {
    it('shouldRefetch uses existing slice matching context', () => {
      // Context-specific cohort slice
      const existingSlice = buildCohortValue({
        dates: [daysAgo(30), daysAgo(25), daysAgo(20)], // All mature
        retrievedDaysAgo: 1,
      });
      existingSlice.sliceDSL = `cohort(anchor,${daysAgo(30)}:${daysAgo(20)}).context(channel=organic)`;
      
      const decision = shouldRefetch({
        existingSlice,
        latencyConfig: { latency_parameter: true, t95: 7 },
        requestedWindow: { start: daysAgo(30), end: daysAgo(20) },
        isCohortQuery: true,
        referenceDate: REFERENCE_DATE,
      });
      
      expect(decision.type).toBe('use_cache');
    });
  });
});

// =============================================================================
// 6. Bust Cache Override
// =============================================================================

describe('Bust Cache Override', () => {
  
  it('calculateIncrementalFetch ignores existing data when bustCache=true', () => {
    // Param file with complete coverage
    const paramFile = buildParamFile([
      buildWindowValue({ startDaysAgo: 30, endDaysAgo: 0 }),
    ]);
    
    // Without bust cache: should say no fetch needed
    const normalResult = calculateIncrementalFetch(
      paramFile,
      { start: daysAgo(30), end: daysAgo(0) },
      undefined,
      false, // bustCache = false
      ''
    );
    expect(normalResult.needsFetch).toBe(false);
    
    // With bust cache: should want to fetch everything
    const bustResult = calculateIncrementalFetch(
      paramFile,
      { start: daysAgo(30), end: daysAgo(0) },
      undefined,
      true, // bustCache = true
      ''
    );
    expect(bustResult.needsFetch).toBe(true);
    expect(bustResult.daysToFetch).toBe(31); // All days 30-0
  });
  
  it('bust cache overrides use_cache policy effect', () => {
    // Even if policy would say use_cache, bustCache forces fetch
    // This tests the integration: policy + calculateIncrementalFetch + bustCache
    
    const existingSlice = buildCohortValue({
      dates: [daysAgo(30), daysAgo(25), daysAgo(20), daysAgo(15), daysAgo(10)],
      retrievedDaysAgo: 1,
    });
    
    // Policy says use_cache
    const decision = shouldRefetch({
      existingSlice,
      latencyConfig: { latency_parameter: true, t95: 7 },
      requestedWindow: { start: daysAgo(30), end: daysAgo(10) },
      isCohortQuery: true,
      referenceDate: REFERENCE_DATE,
    });
    expect(decision.type).toBe('use_cache');
    
    // But calculateIncrementalFetch with bustCache=true ignores that
    const paramFile = buildParamFile([existingSlice]);
    const result = calculateIncrementalFetch(
      paramFile,
      { start: daysAgo(30), end: daysAgo(10) },
      undefined,
      true, // bustCache
      ''
    );
    expect(result.needsFetch).toBe(true);
  });
});

// =============================================================================
// 7. FetchPlan Builder (first-principles redesign)
// =============================================================================

import {
  buildFetchPlan,
  type FileStateAccessor,
  type ConnectionChecker,
} from '../fetchPlanBuilderService';
import {
  plansEqual,
  canonicalisePlan,
  summarisePlan,
  mergeDatesToWindows,
} from '../fetchPlanTypes';
import type { Graph, DateRange } from '../../types';

describe('FetchPlan Builder', () => {
  // Test helpers
  function createMockFileState(files: Record<string, { data?: { values?: ParameterValue[] } }>): FileStateAccessor {
    return {
      getParameterFile(objectId: string) {
        return files[`parameter-${objectId}`];
      },
      getCaseFile(objectId: string) {
        return files[`case-${objectId}`];
      },
    };
  }
  
  function createMockConnectionChecker(connectedEdges: Set<string>, connectedNodes?: Set<string>): ConnectionChecker {
    return {
      hasEdgeConnection(edge: any): boolean {
        const edgeId = edge?.uuid || edge?.id || '';
        return connectedEdges.has(edgeId);
      },
      hasCaseConnection(node: any): boolean {
        const nodeId = node?.uuid || node?.id || '';
        return connectedNodes?.has(nodeId) ?? false;
      },
    };
  }
  
  function createSimpleGraph(edges: Array<{ id: string; paramId: string; connection?: string }>): Graph {
    return {
      nodes: [],
      edges: edges.map(e => ({
        uuid: e.id,
        id: e.id,
        from: 'A',
        to: 'B',
        // IMPORTANT: production schema: provider connection is on the param slot, not on the edge.
        p: { id: e.paramId, connection: e.connection },
      })),
    };
  }

  describe('Basic plan building', () => {
    it('produces empty plan for graph with no edges', () => {
      const result = buildFetchPlan({
        graph: { nodes: [], edges: [] },
        dsl: 'window(1-Dec-25:9-Dec-25)',
        window: { start: '1-Dec-25', end: '9-Dec-25' },
        referenceNow: REFERENCE_DATE.toISOString(),
        fileState: createMockFileState({}),
        connectionChecker: createMockConnectionChecker(new Set()),
      });
      
      expect(result.plan.items).toHaveLength(0);
      expect(result.diagnostics.totalItems).toBe(0);
    });
    
    it('classifies item as fetch when no file data and has connection', () => {
      const graph = createSimpleGraph([
        { id: 'edge-1', paramId: 'test-param', connection: 'amplitude-prod' },
      ]);
      
      const result = buildFetchPlan({
        graph,
        dsl: 'window(1-Dec-25:9-Dec-25)',
        window: { start: '1-Dec-25', end: '9-Dec-25' },
        referenceNow: REFERENCE_DATE.toISOString(),
        fileState: createMockFileState({}),
        connectionChecker: createMockConnectionChecker(new Set(['edge-1'])),
      });
      
      expect(result.plan.items).toHaveLength(1);
      expect(result.plan.items[0].classification).toBe('fetch');
      expect(result.plan.items[0].windows).toHaveLength(1);
      expect(result.plan.items[0].windows[0].reason).toBe('missing');
    });

    it('regression: production connection detection recognises param-slot connection (no edge.connection)', async () => {
      // This test would have failed under the bug: createProductionConnectionChecker incorrectly checked edge.connection.
      const graph = createSimpleGraph([
        { id: 'edge-1', paramId: 'test-param', connection: 'amplitude-prod' },
      ]);

      // Use production dependencies (real fileRegistry + production connection checker).
      // Ensure file is absent so the only question is "is it fetchable?".
      const { fileRegistry } = await import('../../contexts/TabContext');
      vi.spyOn(fileRegistry, 'getFile').mockReturnValue(undefined as any);

      const { buildFetchPlanProduction } = await import('../fetchPlanBuilderService');
      const result = buildFetchPlanProduction(
        graph,
        'window(1-Dec-25:9-Dec-25)',
        { start: '1-Dec-25', end: '9-Dec-25' },
        { referenceNow: REFERENCE_DATE.toISOString() }
      );

      expect(result.plan.items).toHaveLength(1);
      expect(result.plan.items[0].classification).toBe('fetch');
      expect(result.diagnostics.itemsUnfetchable).toBe(0);
    });
    
    it('classifies item as unfetchable when no file and no connection', () => {
      const graph = createSimpleGraph([
        { id: 'edge-1', paramId: 'test-param' }, // no connection
      ]);
      
      const result = buildFetchPlan({
        graph,
        dsl: 'window(1-Dec-25:9-Dec-25)',
        window: { start: '1-Dec-25', end: '9-Dec-25' },
        referenceNow: REFERENCE_DATE.toISOString(),
        fileState: createMockFileState({}),
        connectionChecker: createMockConnectionChecker(new Set()),
      });
      
      expect(result.plan.items).toHaveLength(1);
      expect(result.plan.items[0].classification).toBe('unfetchable');
      expect(result.plan.items[0].unfetchableReason).toBe('no_connection_and_no_file');
    });
    
    it('classifies item as covered when file has full coverage', () => {
      const graph = createSimpleGraph([
        { id: 'edge-1', paramId: 'test-param', connection: 'amplitude-prod' },
      ]);
      
      // File has coverage for the requested window
      const fileState = createMockFileState({
        'parameter-test-param': {
          data: {
            values: [buildWindowValue({ startDaysAgo: 30, endDaysAgo: 0 })],
          },
        },
      });
      
      const result = buildFetchPlan({
        graph,
        dsl: `window(${daysAgo(30)}:${daysAgo(0)})`,
        window: { start: daysAgo(30), end: daysAgo(0) },
        referenceNow: REFERENCE_DATE.toISOString(),
        fileState,
        connectionChecker: createMockConnectionChecker(new Set(['edge-1'])),
      });
      
      expect(result.plan.items).toHaveLength(1);
      expect(result.plan.items[0].classification).toBe('covered');
      expect(result.plan.items[0].windows).toHaveLength(0);
    });
  });

  describe('Gap detection (Invariant A: missing is never skipped)', () => {
    it('detects gap at start of window', () => {
      const graph = createSimpleGraph([
        { id: 'edge-1', paramId: 'test-param', connection: 'amplitude-prod' },
      ]);
      
      // File has coverage for days 20-0, but we request 30-0 (gap at start)
      const fileState = createMockFileState({
        'parameter-test-param': {
          data: {
            values: [buildWindowValue({ startDaysAgo: 20, endDaysAgo: 0 })],
          },
        },
      });
      
      const result = buildFetchPlan({
        graph,
        dsl: `window(${daysAgo(30)}:${daysAgo(0)})`,
        window: { start: daysAgo(30), end: daysAgo(0) },
        referenceNow: REFERENCE_DATE.toISOString(),
        fileState,
        connectionChecker: createMockConnectionChecker(new Set(['edge-1'])),
      });
      
      expect(result.plan.items[0].classification).toBe('fetch');
      expect(result.diagnostics.itemDiagnostics[0].missingDates).toBeGreaterThan(0);
      
      // The missing window should cover the gap at start
      const missingWindows = result.plan.items[0].windows.filter(w => w.reason === 'missing');
      expect(missingWindows.length).toBeGreaterThan(0);
    });
    
    it('detects gap in middle of window', () => {
      const graph = createSimpleGraph([
        { id: 'edge-1', paramId: 'test-param', connection: 'amplitude-prod' },
      ]);
      
      // File has coverage for days 30-20 and 10-0, gap in middle (19-11)
      const fileState = createMockFileState({
        'parameter-test-param': {
          data: {
            values: [
              buildWindowValue({ startDaysAgo: 30, endDaysAgo: 20 }),
              buildWindowValue({ startDaysAgo: 10, endDaysAgo: 0 }),
            ],
          },
        },
      });
      
      const result = buildFetchPlan({
        graph,
        dsl: `window(${daysAgo(30)}:${daysAgo(0)})`,
        window: { start: daysAgo(30), end: daysAgo(0) },
        referenceNow: REFERENCE_DATE.toISOString(),
        fileState,
        connectionChecker: createMockConnectionChecker(new Set(['edge-1'])),
      });
      
      expect(result.plan.items[0].classification).toBe('fetch');
      expect(result.diagnostics.itemDiagnostics[0].missingDates).toBeGreaterThan(0);
    });
    
    it('detects gap at end of window', () => {
      const graph = createSimpleGraph([
        { id: 'edge-1', paramId: 'test-param', connection: 'amplitude-prod' },
      ]);
      
      // File has coverage for days 30-10, but we request 30-0 (gap at end)
      const fileState = createMockFileState({
        'parameter-test-param': {
          data: {
            values: [buildWindowValue({ startDaysAgo: 30, endDaysAgo: 10 })],
          },
        },
      });
      
      const result = buildFetchPlan({
        graph,
        dsl: `window(${daysAgo(30)}:${daysAgo(0)})`,
        window: { start: daysAgo(30), end: daysAgo(0) },
        referenceNow: REFERENCE_DATE.toISOString(),
        fileState,
        connectionChecker: createMockConnectionChecker(new Set(['edge-1'])),
      });
      
      expect(result.plan.items[0].classification).toBe('fetch');
      expect(result.diagnostics.itemDiagnostics[0].missingDates).toBeGreaterThan(0);
    });
  });

  describe('Plan canonicalisation and equality', () => {
    it('canonicalises plan with sorted items and windows', () => {
      const plan = {
        version: 1 as const,
        createdAt: '2025-12-09T12:00:00Z',
        referenceNow: '2025-12-09T12:00:00Z',
        dsl: 'test',
        items: [
          {
            itemKey: 'parameter:z:e1::',
            type: 'parameter' as const,
            objectId: 'z',
            targetId: 'e1',
            mode: 'window' as const,
            sliceFamily: '',
            querySignature: '',
            classification: 'fetch' as const,
            windows: [
              { start: '5-Dec-25', end: '9-Dec-25', reason: 'missing' as const, dayCount: 5 },
              { start: '1-Dec-25', end: '3-Dec-25', reason: 'missing' as const, dayCount: 3 },
            ],
          },
          {
            itemKey: 'parameter:a:e2::',
            type: 'parameter' as const,
            objectId: 'a',
            targetId: 'e2',
            mode: 'window' as const,
            sliceFamily: '',
            querySignature: '',
            classification: 'covered' as const,
            windows: [],
          },
        ],
      };
      
      const canonical = canonicalisePlan(plan);
      
      // Items should be sorted by itemKey
      expect(canonical.items[0].itemKey).toBe('parameter:a:e2::');
      expect(canonical.items[1].itemKey).toBe('parameter:z:e1::');
      
      // Windows should be sorted by start date
      expect(canonical.items[1].windows[0].start).toBe('1-Dec-25');
      expect(canonical.items[1].windows[1].start).toBe('5-Dec-25');
    });
    
    it('plansEqual returns true for equivalent plans', () => {
      const plan1 = {
        version: 1 as const,
        createdAt: '2025-12-09T12:00:00Z',
        referenceNow: '2025-12-09T12:00:00Z',
        dsl: 'test',
        items: [
          {
            itemKey: 'parameter:a:e1::',
            type: 'parameter' as const,
            objectId: 'a',
            targetId: 'e1',
            mode: 'window' as const,
            sliceFamily: '',
            querySignature: '',
            classification: 'covered' as const,
            windows: [],
          },
        ],
      };
      
      const plan2 = { ...plan1 }; // Same plan
      
      expect(plansEqual(plan1, plan2)).toBe(true);
    });

    it('plansEqual returns false when a nested semantic field differs', () => {
      const plan1 = {
        version: 1 as const,
        createdAt: '2025-12-09T12:00:00Z',
        referenceNow: '2025-12-09T12:00:00Z',
        dsl: 'test',
        items: [
          {
            itemKey: 'parameter:a:e1::',
            type: 'parameter' as const,
            objectId: 'a',
            targetId: 'e1',
            mode: 'window' as const,
            sliceFamily: '',
            querySignature: 'sig-1',
            classification: 'fetch' as const,
            windows: [
              { start: '1-Dec-25', end: '1-Dec-25', reason: 'missing' as const, dayCount: 1 },
            ],
          },
        ],
      };

      const plan2 = {
        ...plan1,
        items: [
          {
            ...plan1.items[0],
            windows: [
              // Same window dates, but reason differs => semantic difference
              { start: '1-Dec-25', end: '1-Dec-25', reason: 'stale' as const, dayCount: 1 },
            ],
          },
        ],
      };

      expect(plansEqual(plan1, plan2)).toBe(false);
    });

    it('plansEqual returns true for plans with different insertion order but identical semantics', () => {
      const planA = {
        version: 1 as const,
        createdAt: '2025-12-09T12:00:00Z',
        referenceNow: '2025-12-09T12:00:00Z',
        dsl: 'test',
        items: [
          {
            itemKey: 'parameter:z:e2::',
            type: 'parameter' as const,
            objectId: 'z',
            targetId: 'e2',
            mode: 'window' as const,
            sliceFamily: '',
            querySignature: 'sig-z',
            classification: 'covered' as const,
            windows: [],
          },
          {
            itemKey: 'parameter:a:e1::',
            type: 'parameter' as const,
            objectId: 'a',
            targetId: 'e1',
            mode: 'window' as const,
            sliceFamily: '',
            querySignature: 'sig-a',
            classification: 'fetch' as const,
            windows: [
              { start: '2-Dec-25', end: '3-Dec-25', reason: 'missing' as const, dayCount: 2 },
              { start: '1-Dec-25', end: '1-Dec-25', reason: 'missing' as const, dayCount: 1 },
            ],
          },
        ],
      };

      const planB = {
        version: 1 as const,
        createdAt: '2025-12-09T12:00:00Z',
        referenceNow: '2025-12-09T12:00:00Z',
        dsl: 'test',
        items: [
          // Same semantics, but items/windows are provided in different orders
          {
            itemKey: 'parameter:a:e1::',
            type: 'parameter' as const,
            objectId: 'a',
            targetId: 'e1',
            mode: 'window' as const,
            sliceFamily: '',
            querySignature: 'sig-a',
            classification: 'fetch' as const,
            windows: [
              { start: '1-Dec-25', end: '1-Dec-25', reason: 'missing' as const, dayCount: 1 },
              { start: '2-Dec-25', end: '3-Dec-25', reason: 'missing' as const, dayCount: 2 },
            ],
          },
          {
            itemKey: 'parameter:z:e2::',
            type: 'parameter' as const,
            objectId: 'z',
            targetId: 'e2',
            mode: 'window' as const,
            sliceFamily: '',
            querySignature: 'sig-z',
            classification: 'covered' as const,
            windows: [],
          },
        ],
      };

      expect(plansEqual(planA, planB)).toBe(true);
    });
  });

  describe('Case handling', () => {
    function createGraphWithCase(caseId: string, nodeId: string): Graph {
      return {
        nodes: [{
          uuid: nodeId,
          id: nodeId,
          label: nodeId,
          case: {
            id: caseId,
            connection: { type: 'statsig' as const },
          },
        }],
        edges: [],
      };
    }
    
    it('classifies case with no file data and connection as fetch', () => {
      const graph = createGraphWithCase('test-case', 'node-1');
      
      const result = buildFetchPlan({
        graph,
        dsl: `window(${daysAgo(7)}:${daysAgo(0)})`,
        window: { start: daysAgo(7), end: daysAgo(0) },
        referenceNow: REFERENCE_DATE.toISOString(),
        fileState: createMockFileState({}),
        connectionChecker: createMockConnectionChecker(new Set(), new Set(['node-1'])),
      });
      
      expect(result.plan.items).toHaveLength(1);
      expect(result.plan.items[0].type).toBe('case');
      expect(result.plan.items[0].classification).toBe('fetch');
    });
    
    it('classifies case with file data as covered', () => {
      const graph = createGraphWithCase('test-case', 'node-1');
      
      const result = buildFetchPlan({
        graph,
        dsl: `window(${daysAgo(7)}:${daysAgo(0)})`,
        window: { start: daysAgo(7), end: daysAgo(0) },
        referenceNow: REFERENCE_DATE.toISOString(),
        fileState: createMockFileState({
          'case-test-case': { data: { schedules: [{ retrieved_at: new Date().toISOString() }] } },
        }),
        connectionChecker: createMockConnectionChecker(new Set(), new Set(['node-1'])),
      });
      
      expect(result.plan.items).toHaveLength(1);
      expect(result.plan.items[0].type).toBe('case');
      expect(result.plan.items[0].classification).toBe('covered');
    });
    
    it('classifies case with no file and no connection as unfetchable', () => {
      const graph: Graph = {
        nodes: [{
          uuid: 'node-1',
          id: 'node-1',
          label: 'node-1',
          case: {
            id: 'test-case',
            // No case.connection
          },
        }],
        edges: [],
      };
      
      const result = buildFetchPlan({
        graph,
        dsl: `window(${daysAgo(7)}:${daysAgo(0)})`,
        window: { start: daysAgo(7), end: daysAgo(0) },
        referenceNow: REFERENCE_DATE.toISOString(),
        fileState: createMockFileState({}),
        connectionChecker: createMockConnectionChecker(new Set(), new Set()), // No connections
      });
      
      expect(result.plan.items).toHaveLength(1);
      expect(result.plan.items[0].type).toBe('case');
      expect(result.plan.items[0].classification).toBe('unfetchable');
    });
  });

  describe('mergeDatesToWindows (minimal contiguous windows)', () => {
    it('merges consecutive dates into single window', () => {
      const dates = ['1-Dec-25', '2-Dec-25', '3-Dec-25', '4-Dec-25'];
      const windows = mergeDatesToWindows(dates, 'missing');
      
      expect(windows).toHaveLength(1);
      expect(windows[0].start).toBe('1-Dec-25');
      expect(windows[0].end).toBe('4-Dec-25');
      expect(windows[0].dayCount).toBe(4);
    });
    
    it('produces multiple windows for non-consecutive dates', () => {
      const dates = ['1-Dec-25', '2-Dec-25', '5-Dec-25', '6-Dec-25'];
      const windows = mergeDatesToWindows(dates, 'missing');
      
      expect(windows).toHaveLength(2);
      expect(windows[0].start).toBe('1-Dec-25');
      expect(windows[0].end).toBe('2-Dec-25');
      expect(windows[1].start).toBe('5-Dec-25');
      expect(windows[1].end).toBe('6-Dec-25');
    });
    
    it('handles single date', () => {
      const dates = ['1-Dec-25'];
      const windows = mergeDatesToWindows(dates, 'missing');
      
      expect(windows).toHaveLength(1);
      expect(windows[0].start).toBe('1-Dec-25');
      expect(windows[0].end).toBe('1-Dec-25');
      expect(windows[0].dayCount).toBe(1);
    });
    
    it('returns empty array for no dates', () => {
      const windows = mergeDatesToWindows([], 'missing');
      expect(windows).toHaveLength(0);
    });
  });
});

