/**
 * Onset Delta Days - Cohort Slice Exclusion Tests
 * 
 * Tests that cohort() slices are correctly excluded from onset_delta_days aggregation.
 * 
 * DESIGN RATIONALE (from implementation-plan.md §0.3):
 * - Cohort() slices have histogram data limited to ~10 days, which is insufficient
 *   for long-latency edges — onset derived from cohort() data would be unreliable.
 * - Only window() slices provide reliable onset data.
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

describe('onset_delta_days Cohort Exclusion', () => {
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

  const createParamValue = (
    sliceDSL: string,
    onset: number | undefined,
  ): ParameterValueForLAG => ({
    mean: 0.5,
    n: 300,
    k: 150,
    dates: createDates(),
    n_daily: [100, 100, 100],
    k_daily: [50, 50, 50],
    median_lag_days: [5, 5, 5],
    mean_lag_days: [6, 6, 6],
    sliceDSL,
    ...(onset !== undefined && { latency: { onset_delta_days: onset } }),
  } as any);

  describe('Cohort slices with onset are ignored', () => {
    it('should ignore onset from cohort(date) slices', () => {
      const graph = createSimpleGraph();
      const paramLookup = new Map<string, ParameterValueForLAG[]>([
        ['start-to-a', [
          createParamValue('cohort(1-Jan-25)', 1),  // cohort - should be ignored
        ]],
      ]);

      const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);
      
      const edgeResult = result.edgeValues.find(v => v.edgeUuid === 'start-to-a');
      expect(edgeResult).toBeDefined();
      expect(edgeResult!.latency.onset_delta_days).toBeUndefined();
    });

    it('should ignore onset from cohort(date,context) slices', () => {
      const graph = createSimpleGraph();
      const paramLookup = new Map<string, ParameterValueForLAG[]>([
        ['start-to-a', [
          createParamValue('cohort(1-Jan-25,context(channel:paid))', 2),
        ]],
      ]);

      const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);
      
      const edgeResult = result.edgeValues.find(v => v.edgeUuid === 'start-to-a');
      expect(edgeResult).toBeDefined();
      expect(edgeResult!.latency.onset_delta_days).toBeUndefined();
    });

    it('should use window onset even when cohort has lower value', () => {
      const graph = createSimpleGraph();
      const paramLookup = new Map<string, ParameterValueForLAG[]>([
        ['start-to-a', [
          createParamValue('cohort(1-Jan-25)', 1),   // onset=1 but cohort, ignored
          createParamValue('window(30d)', 5),        // onset=5 from window, used
        ]],
      ]);

      const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);
      
      const edgeResult = result.edgeValues.find(v => v.edgeUuid === 'start-to-a');
      expect(edgeResult).toBeDefined();
      expect(edgeResult!.latency.onset_delta_days).toBe(5); // cohort with lower value ignored
    });

    it('should use window onset even when cohort has onset=0', () => {
      const graph = createSimpleGraph();
      const paramLookup = new Map<string, ParameterValueForLAG[]>([
        ['start-to-a', [
          createParamValue('cohort(1-Jan-25)', 0),   // onset=0 but cohort, ignored
          createParamValue('window(30d)', 3),        // onset=3 from window, used
        ]],
      ]);

      const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);
      
      const edgeResult = result.edgeValues.find(v => v.edgeUuid === 'start-to-a');
      expect(edgeResult).toBeDefined();
      expect(edgeResult!.latency.onset_delta_days).toBe(3);
    });
  });

  describe('Multiple cohort slices are all ignored', () => {
    it('should ignore all cohort slices regardless of onset values', () => {
      const graph = createSimpleGraph();
      const paramLookup = new Map<string, ParameterValueForLAG[]>([
        ['start-to-a', [
          createParamValue('cohort(1-Jan-25)', 0),
          createParamValue('cohort(8-Jan-25)', 1),
          createParamValue('cohort(15-Jan-25)', 2),
          createParamValue('cohort(22-Jan-25)', 3),
        ]],
      ]);

      const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);
      
      const edgeResult = result.edgeValues.find(v => v.edgeUuid === 'start-to-a');
      expect(edgeResult).toBeDefined();
      expect(edgeResult!.latency.onset_delta_days).toBeUndefined();
    });
  });

  describe('Mixed cohort and window slices', () => {
    it('should use min of window slices when multiple cohort and window slices exist', () => {
      const graph = createSimpleGraph();
      const paramLookup = new Map<string, ParameterValueForLAG[]>([
        ['start-to-a', [
          createParamValue('cohort(1-Jan-25)', 0),                          // ignored
          createParamValue('cohort(8-Jan-25)', 1),                          // ignored
          createParamValue('window(30d,context(channel:paid))', 5),         // included
          createParamValue('window(30d,context(channel:organic))', 3),      // included
          createParamValue('cohort(15-Jan-25)', 2),                         // ignored
        ]],
      ]);

      const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);
      
      const edgeResult = result.edgeValues.find(v => v.edgeUuid === 'start-to-a');
      expect(edgeResult).toBeDefined();
      expect(edgeResult!.latency.onset_delta_days).toBe(3); // min of window slices (3, 5)
    });
  });

  describe('Slice DSL pattern matching', () => {
    it('should correctly identify cohort slices by DSL pattern', () => {
      const graph = createSimpleGraph();
      const paramLookup = new Map<string, ParameterValueForLAG[]>([
        ['start-to-a', [
          // Various cohort patterns - all should be excluded
          createParamValue('cohort(1-Jan-25)', 1),
          createParamValue('cohort(1-Jan-25,context(x:y))', 1),
        ]],
      ]);

      const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);
      
      const edgeResult = result.edgeValues.find(v => v.edgeUuid === 'start-to-a');
      expect(edgeResult).toBeDefined();
      expect(edgeResult!.latency.onset_delta_days).toBeUndefined();
    });

    it('should correctly identify window slices by DSL pattern', () => {
      const graph = createSimpleGraph();
      const paramLookup = new Map<string, ParameterValueForLAG[]>([
        ['start-to-a', [
          // Various window patterns - all should be included
          createParamValue('window(30d)', 2),
          createParamValue('window(1-Jan-25:31-Jan-25)', 3),
          createParamValue('window(30d,context(x:y))', 4),
        ]],
      ]);

      const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);
      
      const edgeResult = result.edgeValues.find(v => v.edgeUuid === 'start-to-a');
      expect(edgeResult).toBeDefined();
      // Uncontexted window slice (onset=2) should take precedence
      expect(edgeResult!.latency.onset_delta_days).toBe(2);
    });
  });
});
