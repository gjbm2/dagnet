/**
 * Onset Delta Days Aggregation Tests
 * 
 * Tests the onset_delta_days aggregation logic in the LAG topo pass.
 * Onset is aggregated from window() slices only, using a weighted β-quantile across values,
 * weighted by number of dates in each window() series (dates.length).
 * 
 * Test Case Matrix (from implementation-plan.md §0.3.6 J):
 * - AGG-001: window:uncontexted onset=2 → 2 (Single uncontexted)
 * - AGG-002: window:ctx:A onset=3, window:ctx:B onset=5 → 3 (weighted median with equal weights)
 * - AGG-003: window:uncontexted onset=4 (many dates), window:ctx:A onset=2 (few dates) → 4 (weight dominates)
 * - AGG-004: cohort:date1 onset=1, window:ctx:A onset=5 → 5 (cohort excluded)
 * - AGG-005: No window slices → undefined (No onset available)
 * 
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  enhanceGraphLatencies,
  type LAGHelpers,
  type ParameterValueForLAG,
  type GraphForPath,
} from '../statisticalEnhancementService';

describe('onset_delta_days Aggregation', () => {
  // Helper to create dates for test data
  const createDates = (count: number = 3): string[] => {
    const now = new Date();
    return Array.from({ length: count }, (_, i) => {
      const d = new Date(now.getTime() - (count - i) * 24 * 60 * 60 * 1000);
      return d.toISOString().split('T')[0];
    });
  };

  // Mock LAG helpers with proper aggregation functions
  const mockHelpers: LAGHelpers = {
    aggregateCohortData: (values: ParameterValueForLAG[], queryDate: Date) => {
      // Convert parameter values to cohort data for LAG calculations
      return values.flatMap(v => {
        if (!v.dates) return [];
        return v.dates.map((date, i) => ({
          date,
          n: v.n_daily?.[i] ?? 100,
          k: v.k_daily?.[i] ?? 50,
          age: Math.floor((queryDate.getTime() - new Date(date).getTime()) / (1000 * 60 * 60 * 24)),
          median_lag_days: v.median_lag_days?.[i],
          mean_lag_days: v.mean_lag_days?.[i],
        }));
      });
    },
    aggregateWindowData: (values: ParameterValueForLAG[], queryDate: Date) => {
      // Same as cohort for testing purposes
      return values.flatMap(v => {
        if (!v.dates) return [];
        return v.dates.map((date, i) => ({
          date,
          n: v.n_daily?.[i] ?? 100,
          k: v.k_daily?.[i] ?? 50,
          age: Math.floor((queryDate.getTime() - new Date(date).getTime()) / (1000 * 60 * 60 * 24)),
          median_lag_days: v.median_lag_days?.[i],
          mean_lag_days: v.mean_lag_days?.[i],
        }));
      });
    },
    aggregateLatencyStats: (cohorts) => {
      const withLag = cohorts.filter(c => c.median_lag_days !== undefined && c.median_lag_days > 0);
      if (withLag.length === 0) return undefined;
      const totalK = withLag.reduce((sum, c) => sum + c.k, 0);
      const weightedMedian = withLag.reduce((sum, c) => sum + c.k * (c.median_lag_days || 0), 0);
      const weightedMean = withLag.reduce((sum, c) => sum + c.k * (c.mean_lag_days || c.median_lag_days || 0), 0);
      return {
        median_lag_days: totalK > 0 ? weightedMedian / totalK : 0,
        mean_lag_days: totalK > 0 ? weightedMean / totalK : 0,
      };
    },
  };

  // Create a simple graph with one edge
  const createSimpleGraph = (): GraphForPath => ({
    nodes: [
      { id: 'start', entry: { is_start: true } },
      { id: 'a' },
    ],
    edges: [
      {
        id: 'start-to-a',
        from: 'start',
        to: 'a',
        p: { mean: 0.5, latency: { latency_parameter: true, t95: 30 } },
      } as any,
    ],
  });

  // Create parameter values with specific onset and slice DSL
  const createParamValue = (
    sliceDSL: string,
    onset: number | undefined,
    dates: string[] = createDates()
  ): ParameterValueForLAG => ({
    mean: 0.5,
    n: 300,
    k: 150,
    dates,
    n_daily: [100, 100, 100],
    k_daily: [50, 50, 50],
    median_lag_days: [5, 5, 5],
    mean_lag_days: [6, 6, 6],
    sliceDSL,
    ...(onset !== undefined && { latency: { onset_delta_days: onset } }),
  } as any);

  describe('AGG-001: Single uncontexted window slice', () => {
    it('should use onset from single uncontexted window slice', () => {
      const graph = createSimpleGraph();
      const paramLookup = new Map<string, ParameterValueForLAG[]>([
        ['start-to-a', [createParamValue('window(30d)', 2)]],
      ]);

      const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);
      
      const edgeResult = result.edgeValues.find(v => v.edgeUuid === 'start-to-a');
      expect(edgeResult).toBeDefined();
      expect(edgeResult!.latency.onset_delta_days).toBe(2);
    });
  });

  describe('AGG-002: Multiple contexted window slices', () => {
    it('should use a weighted β-quantile across contexted window slices when no uncontexted exists', () => {
      const graph = createSimpleGraph();
      const paramLookup = new Map<string, ParameterValueForLAG[]>([
        ['start-to-a', [
          createParamValue('window(30d,context(channel:paid))', 3),
          createParamValue('window(30d,context(channel:organic))', 5),
        ]],
      ]);

      const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);
      
      const edgeResult = result.edgeValues.find(v => v.edgeUuid === 'start-to-a');
      expect(edgeResult).toBeDefined();
      // Default β is 0.5 (weighted median). With equal weights, this selects the smaller value (3).
      expect(edgeResult!.latency.onset_delta_days).toBe(3);
    });
  });

  describe('AGG-003: Weighted by window date-count', () => {
    it('should select onset using date-count weights (not a hard uncontexted precedence rule)', () => {
      const graph = createSimpleGraph();
      const paramLookup = new Map<string, ParameterValueForLAG[]>([
        ['start-to-a', [
          createParamValue('window(30d)', 4, createDates(100)),                     // many dates (dominant weight)
          createParamValue('window(30d,context(channel:paid))', 2, createDates(1)), // few dates
        ]],
      ]);

      const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);
      
      const edgeResult = result.edgeValues.find(v => v.edgeUuid === 'start-to-a');
      expect(edgeResult).toBeDefined();
      expect(edgeResult!.latency.onset_delta_days).toBe(4);
    });
  });

  describe('AGG-004: Cohort slices excluded', () => {
    it('should exclude cohort slices from onset aggregation', () => {
      const graph = createSimpleGraph();
      const paramLookup = new Map<string, ParameterValueForLAG[]>([
        ['start-to-a', [
          createParamValue('cohort(1-Jan-25)', 1),                         // cohort - should be excluded
          createParamValue('window(30d,context(channel:paid))', 5),        // window - should be used
        ]],
      ]);

      const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);
      
      const edgeResult = result.edgeValues.find(v => v.edgeUuid === 'start-to-a');
      expect(edgeResult).toBeDefined();
      expect(edgeResult!.latency.onset_delta_days).toBe(5); // cohort excluded, only window used
    });
  });

  describe('AGG-005: No window slices available', () => {
    it('should return undefined onset when only cohort slices exist', () => {
      const graph = createSimpleGraph();
      const paramLookup = new Map<string, ParameterValueForLAG[]>([
        ['start-to-a', [
          createParamValue('cohort(1-Jan-25)', 1),
          createParamValue('cohort(15-Jan-25)', 2),
        ]],
      ]);

      const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);
      
      const edgeResult = result.edgeValues.find(v => v.edgeUuid === 'start-to-a');
      expect(edgeResult).toBeDefined();
      expect(edgeResult!.latency.onset_delta_days).toBeUndefined();
    });

    it('should return undefined onset when window slices have no onset data', () => {
      const graph = createSimpleGraph();
      const paramLookup = new Map<string, ParameterValueForLAG[]>([
        ['start-to-a', [
          createParamValue('window(30d)', undefined), // no onset
        ]],
      ]);

      const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);
      
      const edgeResult = result.edgeValues.find(v => v.edgeUuid === 'start-to-a');
      expect(edgeResult).toBeDefined();
      expect(edgeResult!.latency.onset_delta_days).toBeUndefined();
    });
  });

  describe('Edge cases', () => {
    it('should handle onset_delta_days = 0 (immediate conversions)', () => {
      const graph = createSimpleGraph();
      const paramLookup = new Map<string, ParameterValueForLAG[]>([
        ['start-to-a', [createParamValue('window(30d)', 0)]],
      ]);

      const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);
      
      const edgeResult = result.edgeValues.find(v => v.edgeUuid === 'start-to-a');
      expect(edgeResult).toBeDefined();
      expect(edgeResult!.latency.onset_delta_days).toBe(0);
    });

    it('should handle mixed slices correctly', () => {
      const graph = createSimpleGraph();
      const paramLookup = new Map<string, ParameterValueForLAG[]>([
        ['start-to-a', [
          createParamValue('cohort(1-Jan-25)', 1),                          // excluded
          createParamValue('window(30d)', 3, createDates(50)),                         // dominant weight
          createParamValue('window(30d,context(channel:paid))', 2, createDates(1)),    // tiny weight
          createParamValue('cohort(15-Jan-25)', 0),                         // excluded
        ]],
      ]);

      const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);
      
      const edgeResult = result.edgeValues.find(v => v.edgeUuid === 'start-to-a');
      expect(edgeResult).toBeDefined();
      expect(edgeResult!.latency.onset_delta_days).toBe(3);
    });
  });
});
