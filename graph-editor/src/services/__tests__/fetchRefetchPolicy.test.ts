/**
 * Tests for fetchRefetchPolicy.ts
 * 
 * Validates maturity-aware refetch decisions as specified in design.md §4.7.3:
 * - Non-latency edges: gaps_only (standard incremental)
 * - Window() with latency: partial refetch of immature portion
 * - Cohort(): replace slice if immature, use cache if mature
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  shouldRefetch,
  analyzeSliceCoverage,
  computeFetchWindow,
  computeEffectiveCohortMaturity,
  type RefetchDecision,
} from '../fetchRefetchPolicy';
import type { ParameterValue } from '../../types/parameterData';

// Helper to create dates in UK format
function ukDate(daysAgo: number, reference: Date = new Date()): string {
  const d = new Date(reference);
  d.setDate(d.getDate() - daysAgo);
  const day = d.getDate();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[d.getMonth()];
  const year = d.getFullYear() % 100;
  return `${day}-${month}-${year}`;
}

describe('fetchRefetchPolicy', () => {
  const referenceDate = new Date('2025-12-09T12:00:00Z');
  
  describe('shouldRefetch - t95 preference and conservative default', () => {
    it('should use t95 as effective maturity when available', () => {
      // t95 = 14 days (from CDF fitting)
      const decision = shouldRefetch({
        existingSlice: undefined,
        latencyConfig: { 
          latency_parameter: true,
          t95: 14, // 95th percentile lag
        },
        // Window from 20 days ago to today
        requestedWindow: { start: ukDate(20, referenceDate), end: ukDate(0, referenceDate) },
        isCohortQuery: false,
        referenceDate,
      });
      
      expect(decision.type).toBe('partial');
      // Cutoff should be t95 + 1 = 15 days ago
      expect(decision.matureCutoff).toBe(ukDate(15, referenceDate));
    });

    it('computeEffectiveCohortMaturity prefers path_t95 over t95', () => {
      expect(computeEffectiveCohortMaturity({ latency_parameter: true, t95: 7, path_t95: 21 })).toBe(21);
      expect(computeEffectiveCohortMaturity({ latency_parameter: true, t95: 7 })).toBe(7);
      expect(computeEffectiveCohortMaturity({ latency_parameter: true, t95: undefined, path_t95: undefined })).toBe(30);
    });
    
    it('should fall back to conservative default when t95 is not available', () => {
      const decision = shouldRefetch({
        existingSlice: undefined,
        latencyConfig: { 
          latency_parameter: true,
          t95: undefined, // Not yet computed
        },
        requestedWindow: { start: ukDate(20, referenceDate), end: ukDate(0, referenceDate) },
        isCohortQuery: false,
        referenceDate,
      });
      
      expect(decision.type).toBe('partial');
      // Cutoff should be default + 1 = 31 days ago
      expect(decision.matureCutoff).toBe(ukDate(31, referenceDate));
    });
    
    it('should treat t95=0 as missing and fall back to conservative default', () => {
      const decision = shouldRefetch({
        existingSlice: undefined,
        latencyConfig: { 
          latency_parameter: true,
          t95: 0, // Invalid/degenerate t95
        },
        requestedWindow: { start: ukDate(20, referenceDate), end: ukDate(0, referenceDate) },
        isCohortQuery: false,
        referenceDate,
      });
      
      expect(decision.type).toBe('partial');
      expect(decision.matureCutoff).toBe(ukDate(31, referenceDate));
    });
    
    it('should round up t95 to be conservative', () => {
      // t95 = 10.3 days should round up to 11 days
      const decision = shouldRefetch({
        existingSlice: undefined,
        latencyConfig: { 
          latency_parameter: true,
          t95: 10.3,
        },
        requestedWindow: { start: ukDate(20, referenceDate), end: ukDate(0, referenceDate) },
        isCohortQuery: false,
        referenceDate,
      });
      
      expect(decision.type).toBe('partial');
      // Cutoff should be ceil(10.3) + 1 = 12 days ago
      expect(decision.matureCutoff).toBe(ukDate(12, referenceDate));
    });
  });
  
  describe('shouldRefetch - Non-latency edges', () => {
    it('should return gaps_only for edge without latency config', () => {
      const decision = shouldRefetch({
        existingSlice: undefined,
        latencyConfig: undefined,
        requestedWindow: { start: ukDate(7, referenceDate), end: ukDate(0, referenceDate) },
        isCohortQuery: false,
        referenceDate,
      });
      
      expect(decision.type).toBe('gaps_only');
    });
    
    it('should return gaps_only for edge with latency_parameter disabled', () => {
      const decision = shouldRefetch({
        existingSlice: undefined,
        latencyConfig: { latency_parameter: false },
        requestedWindow: { start: ukDate(7, referenceDate), end: ukDate(0, referenceDate) },
        isCohortQuery: false,
        referenceDate,
      });
      
      expect(decision.type).toBe('gaps_only');
    });
  });
  
  describe('shouldRefetch - Window mode with latency', () => {
    it('should return partial refetch for window that includes immature dates', () => {
      const decision = shouldRefetch({
        existingSlice: undefined,
        latencyConfig: { latency_parameter: true, t95: 7 },
        requestedWindow: { start: ukDate(14, referenceDate), end: ukDate(0, referenceDate) },
        isCohortQuery: false,
        referenceDate,
      });
      
      expect(decision.type).toBe('partial');
      expect(decision.matureCutoff).toBeDefined();
      expect(decision.refetchWindow).toBeDefined();
    });
    
    it('should return gaps_only for window that is entirely mature', () => {
      const decision = shouldRefetch({
        existingSlice: undefined,
        latencyConfig: { latency_parameter: true, t95: 7 },
        // Window ends 10 days ago, beyond the 8-day maturity cutoff
        requestedWindow: { start: ukDate(20, referenceDate), end: ukDate(10, referenceDate) },
        isCohortQuery: false,
        referenceDate,
      });
      
      expect(decision.type).toBe('gaps_only');
    });
    
    it('should calculate correct maturity cutoff', () => {
      const decision = shouldRefetch({
        existingSlice: undefined,
        latencyConfig: { latency_parameter: true, t95: 7 },
        requestedWindow: { start: ukDate(14, referenceDate), end: ukDate(0, referenceDate) },
        isCohortQuery: false,
        referenceDate,
      });
      
      // Cutoff should be t95 + 1 = 8 days ago
      expect(decision.type).toBe('partial');
      expect(decision.matureCutoff).toBe(ukDate(8, referenceDate));
    });

    it('should suppress immature refetch when slice was fetched very recently (cooldown)', () => {
      const existingSlice: ParameterValue = {
        mean: 0.5,
        n: 10,
        k: 5,
        dates: [ukDate(1, referenceDate), ukDate(0, referenceDate)],
        n_daily: [10, 10],
        k_daily: [5, 5],
        sliceDSL: 'window(-60d:)',
        data_source: {
          type: 'api',
          retrieved_at: new Date(referenceDate.getTime() - 5 * 60 * 1000).toISOString(), // 5 minutes ago
        },
      };

      const decision = shouldRefetch({
        existingSlice,
        latencyConfig: { latency_parameter: true, t95: 7 },
        requestedWindow: { start: ukDate(14, referenceDate), end: ukDate(0, referenceDate) },
        isCohortQuery: false,
        referenceDate,
      });

      expect(decision.type).toBe('gaps_only');
      expect(decision.reason).toBe('recent_fetch_cooldown');
      expect(decision.cooldownApplied).toBe(true);
      expect(decision.wouldRefetchWindow).toBeDefined();
    });
  });
  
  describe('shouldRefetch - Cohort mode', () => {
    const existingCohortSlice: ParameterValue = {
      mean: 0.5,
      n: 1000,
      k: 500,
      dates: [
        ukDate(30, referenceDate),
        ukDate(20, referenceDate),
        ukDate(10, referenceDate),
        ukDate(5, referenceDate), // Immature if effective maturity > 5
      ],
      n_daily: [100, 100, 100, 100],
      k_daily: [50, 50, 50, 50],
      cohort_from: ukDate(30, referenceDate),
      cohort_to: ukDate(5, referenceDate),
      sliceDSL: `cohort(anchor,${ukDate(30, referenceDate)}:${ukDate(5, referenceDate)})`,
      data_source: {
        type: 'api',
        retrieved_at: new Date(referenceDate.getTime() - 24 * 60 * 60 * 1000).toISOString(), // 1 day ago
      },
    };
    
    it('should return replace_slice when cohort has immature cohorts', () => {
      const decision = shouldRefetch({
        existingSlice: existingCohortSlice,
        latencyConfig: { latency_parameter: true, t95: 7 },
        requestedWindow: { start: ukDate(30, referenceDate), end: ukDate(0, referenceDate) },
        isCohortQuery: true,
        referenceDate,
      });
      
      expect(decision.type).toBe('replace_slice');
      expect(decision.hasImmatureCohorts).toBe(true);
      expect(decision.reason).toBe('immature_cohorts');
    });

    it('prefers path_t95 for cohort maturity (cumulative lag)', () => {
      // Construct a slice that is mature under edge t95=7 (15 days ago),
      // but still immature under path_t95=21 (21-day cumulative lag).
      const slice: ParameterValue = {
        mean: 0.5,
        n: 1000,
        k: 500,
        dates: [ukDate(15, referenceDate)],
        n_daily: [100],
        k_daily: [50],
        cohort_from: ukDate(15, referenceDate),
        cohort_to: ukDate(15, referenceDate),
        sliceDSL: `cohort(anchor,${ukDate(15, referenceDate)}:${ukDate(15, referenceDate)})`,
        data_source: {
          type: 'api',
          retrieved_at: new Date(referenceDate.getTime() - 24 * 60 * 60 * 1000).toISOString(), // 1 day ago
        },
      };

      // With only edge t95=7, this should be mature → use_cache.
      const edgeOnly = shouldRefetch({
        existingSlice: slice,
        latencyConfig: { latency_parameter: true, t95: 7 },
        requestedWindow: { start: ukDate(30, referenceDate), end: ukDate(0, referenceDate) },
        isCohortQuery: true,
        referenceDate,
      });
      expect(edgeOnly.type).toBe('use_cache');

      // With path_t95=21, this should be immature → replace_slice.
      const withPath = shouldRefetch({
        existingSlice: slice,
        latencyConfig: { latency_parameter: true, t95: 7, path_t95: 21 },
        requestedWindow: { start: ukDate(30, referenceDate), end: ukDate(0, referenceDate) },
        isCohortQuery: true,
        referenceDate,
      });
      expect(withPath.type).toBe('replace_slice');
      expect(withPath.reason).toBe('immature_cohorts');
    });

    it('should suppress replace_slice when cohort slice was fetched very recently (cooldown)', () => {
      const recentImmatureSlice: ParameterValue = {
        ...existingCohortSlice,
        data_source: {
          type: 'api',
          retrieved_at: new Date(referenceDate.getTime() - 2 * 60 * 1000).toISOString(), // 2 minutes ago
        },
      };

      const decision = shouldRefetch({
        existingSlice: recentImmatureSlice,
        latencyConfig: { latency_parameter: true, t95: 7 },
        requestedWindow: { start: ukDate(30, referenceDate), end: ukDate(0, referenceDate) },
        isCohortQuery: true,
        referenceDate,
      });

      expect(decision.type).toBe('gaps_only');
      expect(decision.reason).toBe('recent_fetch_cooldown');
      expect(decision.cooldownApplied).toBe(true);
      expect(decision.hasImmatureCohorts).toBe(true);
    });
    
    it('should return use_cache when all cohorts are mature', () => {
      // Create a slice with only mature cohorts (all dates > 7 days ago)
      const matureSlice: ParameterValue = {
        ...existingCohortSlice,
        dates: [
          ukDate(30, referenceDate),
          ukDate(20, referenceDate),
          ukDate(10, referenceDate),
        ],
        n_daily: [100, 100, 100],
        k_daily: [50, 50, 50],
        cohort_to: ukDate(10, referenceDate),
      };
      
      const decision = shouldRefetch({
        existingSlice: matureSlice,
        latencyConfig: { latency_parameter: true, t95: 7 },
        requestedWindow: { start: ukDate(30, referenceDate), end: ukDate(10, referenceDate) },
        isCohortQuery: true,
        referenceDate,
      });
      
      expect(decision.type).toBe('use_cache');
      expect(decision.hasImmatureCohorts).toBe(false);
    });

    it('should prefer path_t95 over t95 for cohort maturity', () => {
      // This slice is mature under edge t95=7 (most recent cohort date is 10 days ago),
      // but immature under path_t95=21 (10 days ago is within the 21-day maturity horizon).
      const matureByEdgeButImmatureByPath: ParameterValue = {
        ...existingCohortSlice,
        dates: [
          ukDate(30, referenceDate),
          ukDate(20, referenceDate),
          ukDate(10, referenceDate),
        ],
        n_daily: [100, 100, 100],
        k_daily: [50, 50, 50],
        cohort_to: ukDate(10, referenceDate),
      };

      const decision = shouldRefetch({
        existingSlice: matureByEdgeButImmatureByPath,
        latencyConfig: { latency_parameter: true, t95: 7, path_t95: 21 },
        requestedWindow: { start: ukDate(30, referenceDate), end: ukDate(10, referenceDate) },
        isCohortQuery: true,
        referenceDate,
      });

      expect(decision.type).toBe('replace_slice');
      expect(decision.hasImmatureCohorts).toBe(true);
      expect(decision.reason).toBe('immature_cohorts');
    });
    
    it('should return replace_slice when no existing slice exists', () => {
      const decision = shouldRefetch({
        existingSlice: undefined,
        latencyConfig: { latency_parameter: true, t95: 7 },
        requestedWindow: { start: ukDate(30, referenceDate), end: ukDate(0, referenceDate) },
        isCohortQuery: true,
        referenceDate,
      });
      
      expect(decision.type).toBe('replace_slice');
      expect(decision.reason).toBe('no_existing_slice');
    });
    
    it('should return replace_slice when slice has no dates', () => {
      const emptySlice: ParameterValue = {
        mean: 0.5,
        n: 1000,
        k: 500,
        dates: [],
        n_daily: [],
        k_daily: [],
      };
      
      const decision = shouldRefetch({
        existingSlice: emptySlice,
        latencyConfig: { latency_parameter: true, t95: 7 },
        requestedWindow: { start: ukDate(30, referenceDate), end: ukDate(0, referenceDate) },
        isCohortQuery: true,
        referenceDate,
      });
      
      expect(decision.type).toBe('replace_slice');
      expect(decision.reason).toBe('no_cohort_dates');
    });
  });
  
  describe('analyzeSliceCoverage', () => {
    it('should identify missing mature dates', () => {
      const existingSlice: ParameterValue = {
        mean: 0.5,
        n: 100,
        k: 50,
        dates: [ukDate(14, referenceDate), ukDate(12, referenceDate)], // Missing 13 days ago
        n_daily: [50, 50],
        k_daily: [25, 25],
      };
      
      const coverage = analyzeSliceCoverage(
        existingSlice,
        { start: ukDate(14, referenceDate), end: ukDate(10, referenceDate) },
        ukDate(8, referenceDate)
      );
      
      expect(coverage.missingMatureDates.length).toBeGreaterThan(0);
      expect(coverage.matureCoverage).toBe('partial');
    });
    
    it('should identify all dates as immature when within maturity window', () => {
      const existingSlice: ParameterValue = {
        mean: 0.5,
        n: 100,
        k: 50,
        dates: [ukDate(5, referenceDate)],
        n_daily: [100],
        k_daily: [50],
      };
      
      const coverage = analyzeSliceCoverage(
        existingSlice,
        { start: ukDate(5, referenceDate), end: ukDate(0, referenceDate) },
        ukDate(8, referenceDate) // Cutoff is 8 days ago
      );
      
      // All 6 dates (5 days ago to today) should be immature
      expect(coverage.immatureDates.length).toBe(6);
    });
    
    it('should return none for coverage when no slice exists', () => {
      const coverage = analyzeSliceCoverage(
        undefined,
        { start: ukDate(14, referenceDate), end: ukDate(0, referenceDate) },
        ukDate(8, referenceDate)
      );
      
      expect(coverage.matureCoverage).toBe('none');
    });
  });
  
  describe('computeFetchWindow', () => {
    const requestedWindow = { start: ukDate(14, referenceDate), end: ukDate(0, referenceDate) };
    
    it('should return null for use_cache policy', () => {
      const decision: RefetchDecision = { type: 'use_cache' };
      const coverage = { missingMatureDates: [], immatureDates: [] };
      
      const result = computeFetchWindow(decision, coverage, requestedWindow);
      
      expect(result).toBeNull();
    });
    
    it('should return full window for replace_slice policy', () => {
      const decision: RefetchDecision = { type: 'replace_slice' };
      const coverage = { missingMatureDates: [], immatureDates: [] };
      
      const result = computeFetchWindow(decision, coverage, requestedWindow);
      
      expect(result).toEqual(requestedWindow);
    });
    
    it('should return refetch window for partial policy', () => {
      const refetchWindow = { start: ukDate(7, referenceDate), end: ukDate(0, referenceDate) };
      const decision: RefetchDecision = { type: 'partial', refetchWindow };
      const coverage = { missingMatureDates: [], immatureDates: [] };
      
      const result = computeFetchWindow(decision, coverage, requestedWindow);
      
      expect(result).toEqual(refetchWindow);
    });
    
    it('should extend partial window to include mature gaps', () => {
      const refetchWindow = { start: ukDate(7, referenceDate), end: ukDate(0, referenceDate) };
      const decision: RefetchDecision = { type: 'partial', refetchWindow };
      const coverage = { 
        missingMatureDates: [ukDate(12, referenceDate)], // Gap in mature portion
        immatureDates: [ukDate(3, referenceDate)] 
      };
      
      const result = computeFetchWindow(decision, coverage, requestedWindow);
      
      // Should extend to include the mature gap
      expect(result!.start).toBe(ukDate(12, referenceDate));
      expect(result!.end).toBe(refetchWindow.end);
    });
  });
});

