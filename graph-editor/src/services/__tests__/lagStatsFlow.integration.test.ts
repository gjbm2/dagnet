/**
 * LAG Stats Flow Integration Tests
 * 
 * Tests the complete statistical flow from file fetch through to graph update:
 * - Evidence (from cohort() slices) - n, k, mean
 * - Forecast (from window() slices) - mean
 * - Completeness (derived from cohort ages, pathT95, mu, sigma)
 * - p.mean (blended from evidence + forecast weighted by completeness)
 * 
 * Scenarios cover:
 * - Single-edge graphs
 * - Multi-edge chains with cumulative pathT95
 * - Mixed latency/non-latency edges
 * - Various cohort window configurations
 * 
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  enhanceGraphLatencies,
  computeBlendedMean,
  computeEdgeLatencyStats,
  calculateCompleteness,
  fitLagDistribution,
  logNormalCDF,
  getActiveEdges,
  type CohortData,
  type GraphForPath,
  type LAGHelpers,
  type ParameterValueForLAG,
  type EdgeLAGValues,
} from '../statisticalEnhancementService';
import { aggregateCohortData, aggregateLatencyStats } from '../windowAggregationService';
import { UpdateManager } from '../UpdateManager';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a mock cohort slice with daily data
 */
function createCohortSlice(
  dates: string[],
  nDaily: number[],
  kDaily: number[],
  medianLagDays?: number[],
  anchorMedianLagDays?: number[],
  anchorMeanLagDays?: number[]
): ParameterValueForLAG {
  return {
    sliceDSL: `cohort(${dates[0]}:${dates[dates.length - 1]})`,
    dates,
    n: nDaily.reduce((a, b) => a + b, 0),
    k: kDaily.reduce((a, b) => a + b, 0),
    n_daily: nDaily,
    k_daily: kDaily,
    median_lag_days: medianLagDays,
    mean_lag_days: medianLagDays, // Simplify: use median as mean
    ...(anchorMedianLagDays ? { anchor_median_lag_days: anchorMedianLagDays } : {}),
    ...(anchorMeanLagDays ? { anchor_mean_lag_days: anchorMeanLagDays } : {}),
    mean: kDaily.reduce((a, b) => a + b, 0) / nDaily.reduce((a, b) => a + b, 0),
    data_source: { retrieved_at: '2025-12-10T00:00:00Z', type: 'test' },
  } as ParameterValueForLAG;
}

/**
 * Create a mock window slice (for forecast baseline)
 */
function createWindowSlice(
  dateRange: string,
  n: number,
  k: number,
  forecast: number
): ParameterValueForLAG {
  return {
    sliceDSL: `window(${dateRange})`,
    n,
    k,
    mean: k / n,
    forecast,
    data_source: { retrieved_at: '2025-12-10T00:00:00Z', type: 'test' },
  } as ParameterValueForLAG;
}

/**
 * Create LAG helpers for testing
 */
function createLAGHelpers(): LAGHelpers {
  return {
    aggregateCohortData: aggregateCohortData as LAGHelpers['aggregateCohortData'],
    aggregateLatencyStats,
  };
}

/**
 * Parse a date string (d-MMM-yy format) to Date
 */
function parseDate(dateStr: string): Date {
  const months: Record<string, number> = {
    'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5,
    'Jul': 6, 'Aug': 7, 'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
  };
  const parts = dateStr.split('-');
  const day = parseInt(parts[0], 10);
  const month = months[parts[1]];
  const year = 2000 + parseInt(parts[2], 10);
  return new Date(year, month, day);
}

// ============================================================================
// Test Scenarios
// ============================================================================

describe('LAG Stats Flow - Expected Values', () => {
  const helpers = createLAGHelpers();

  describe('Blend formula via enhanceGraphLatencies (single canonical path)', () => {
    it('computes blended p.mean when evidence + forecast are present (canonical blend)', () => {
      const graph: GraphForPath = {
        nodes: [{ id: 'A', type: 'start' }, { id: 'B' }],
        edges: [
          {
            id: 'e1',
            uuid: 'e1',
            from: 'A',
            to: 'B',
            p: {
              mean: 0.71, // initial, will be overwritten by blend
              latency: { latency_parameter: true, t95: 30 },
              evidence: { mean: 0.71, n: 97, k: 69 },
              forecast: { mean: 0.98 },
            },
          },
        ],
      };

      const cohortSlice = createCohortSlice(
        ['1-Nov-25', '6-Nov-25', '11-Nov-25'],
        [32, 33, 32],
        [23, 23, 23],
        [13.5, 13.5, 13.5]
      );

      const windowSlice = createWindowSlice('18-Nov-25:10-Dec-25', 412, 404, 0.98);

      const paramLookup = new Map<string, ParameterValueForLAG[]>();
      paramLookup.set('e1', [cohortSlice, windowSlice]);

      const result = enhanceGraphLatencies(
        graph,
        paramLookup,
        new Date('2025-12-10'),
        helpers,
        { start: new Date('2025-11-01'), end: new Date('2025-11-30') }
      );

      expect(result.edgesWithLAG).toBe(1);
      expect(result.edgeValues.length).toBe(1);

      const e1 = result.edgeValues[0];
      expect(e1.blendedMean).toBeDefined();
      expect(e1.forecast?.mean).toBe(0.98);
      const evidenceMeanExact = 69 / 97;
      // Evidence block on the edge may be pre-populated / rounded by the pipeline;
      // the blend itself uses cohort-derived totals. Keep this assertion aligned with the fixture.
      expect(e1.evidence?.mean).toBe(0.71);

      const expected = computeBlendedMean({
        // Use the exact cohort-derived evidence mean (k/n), not a rounded literal.
        // enhanceGraphLatencies uses cohort totals, so rounding here can create ~1e-3 drift.
        evidenceMean: evidenceMeanExact,
        forecastMean: 0.98,
        completeness: e1.latency.completeness,
        nQuery: 97,
        nBaseline: 412,
      });
      expect(expected).toBeDefined();
      expect(e1.blendedMean).toBeCloseTo(expected!, 10);
      expect(e1.blendedMean!).toBeGreaterThanOrEqual(0.71);
      expect(e1.blendedMean!).toBeLessThanOrEqual(0.98);
    });

    it('uses pure forecast when nQuery is zero (no arrivals yet)', () => {
      const graph: GraphForPath = {
        nodes: [{ id: 'A', type: 'start' }, { id: 'B' }],
        edges: [
          {
            id: 'e1',
            uuid: 'e1',
            from: 'A',
            to: 'B',
            p: {
              mean: 0.5, // initial
              latency: { latency_parameter: true, t95: 30 },
              evidence: { mean: 0, n: 0, k: 0 }, // nQuery=0
              forecast: { mean: 0.95 },
            },
          },
        ],
      };

      const cohortSlice = createCohortSlice(['1-Dec-25'], [0], [0], [5]);
      const windowSlice = createWindowSlice('18-Nov-25:10-Dec-25', 500, 475, 0.95);

      const paramLookup = new Map<string, ParameterValueForLAG[]>();
      paramLookup.set('e1', [cohortSlice, windowSlice]);

      const result = enhanceGraphLatencies(
        graph,
        paramLookup,
        new Date('2025-12-10'),
        helpers,
        { start: new Date('2025-12-01'), end: new Date('2025-12-01') }
      );

      const e1 = result.edgeValues[0];
      expect(e1.forecast?.mean).toBe(0.95);
      expect(e1.blendedMean).toBeDefined();
      expect(e1.blendedMean).toBeCloseTo(0.95, 10);
    });

    // NOTE: nBaseline is intentionally taken from the window slice header `n` (not recency-weighted),
    // so that limited/immature evidence does not override the long-run baseline too aggressively.

    it('uses forecast when cohorts are immature and k=0, and anchor lag prevents false completeness', () => {
      const graph: GraphForPath = {
        nodes: [{ id: 'A', type: 'start' }, { id: 'B' }],
        edges: [
          {
            id: 'e1',
            uuid: 'e1',
            from: 'A',
            to: 'B',
            p: {
              // Must be > epsilon so the edge is considered active and gets LAG-enhanced.
              // (In real graphs this can be 0 before enhancement; this test focuses on the
              // anchor-lag behaviour once the edge is processed.)
              mean: 0.0001,
              latency: { latency_parameter: true, t95: 10 },
              evidence: { mean: 0, n: 6, k: 0 },
              forecast: { mean: 0.7894333890974398 },
            },
          },
        ],
      };

      // Cohorts are 5–7 days old at analysis time, but A→X anchor lag is ~12 days,
      // so effective age at this edge is 0 for all cohorts → completeness should be very low.
      const cohortSlice = createCohortSlice(
        ['4-Dec-25', '5-Dec-25', '6-Dec-25'],
        [2, 2, 2],
        [0, 0, 0],
        [6, 6, 6],
        [12, 12, 12]
      );
      const windowSlice = createWindowSlice('11-Oct-25:9-Dec-25', 1576, 1112, 0.7894333890974398);

      const paramLookup = new Map<string, ParameterValueForLAG[]>();
      paramLookup.set('e1', [cohortSlice, windowSlice]);

      const result = enhanceGraphLatencies(
        graph,
        paramLookup,
        new Date('2025-12-11'),
        helpers,
        { start: new Date('2025-12-04'), end: new Date('2025-12-06') }
      );

      const e1 = result.edgeValues[0];
      expect(e1.forecast?.mean).toBeCloseTo(0.7894333890974398, 12);
      expect(e1.blendedMean).toBeDefined();
      // Canonical blend: with evidenceMean=0 and very low completeness, p.mean≈forecast
      expect(e1.blendedMean!).toBeCloseTo(0.7894333890974398, 12);
      // Completeness should not be high once anchor lag is applied (effective ages clamp to 0)
      expect(e1.latency.completeness).toBeLessThan(0.2);
    });

    it('blended mean moves closer to evidence as cohorts become more complete', () => {
      const graph: GraphForPath = {
        nodes: [{ id: 'A', type: 'start' }, { id: 'B' }],
        edges: [
          {
            id: 'e1',
            uuid: 'e1',
            from: 'A',
            to: 'B',
            p: {
              mean: 0.5,
              latency: { latency_parameter: true, t95: 30 },
              evidence: { mean: 0.5, n: 500, k: 250 },
              forecast: { mean: 0.98 },
            },
          },
        ],
      };

      // Cohorts far older than lag → completeness high.
      const cohortSlice = createCohortSlice(
        ['1-Oct-25', '5-Oct-25', '10-Oct-25'],
        [200, 150, 150],
        [100, 75, 75],
        [2, 2, 2]
      );
      const windowSlice = createWindowSlice('18-Nov-25:10-Dec-25', 400, 392, 0.98);

      const paramLookup = new Map<string, ParameterValueForLAG[]>();
      paramLookup.set('e1', [cohortSlice, windowSlice]);

      const result = enhanceGraphLatencies(
        graph,
        paramLookup,
        new Date('2025-12-10'),
        helpers,
        { start: new Date('2025-10-01'), end: new Date('2025-10-31') }
      );

      const e1 = result.edgeValues[0];
      expect(e1.latency.completeness).toBeGreaterThan(0.8);

      const distanceToEvidence = Math.abs((e1.blendedMean ?? 0) - 0.5);
      const distanceToForecast = Math.abs((e1.blendedMean ?? 0) - 0.98);
      expect(distanceToEvidence).toBeLessThan(distanceToForecast);
    });

    it('blended mean moves closer to forecast as cohorts become less complete', () => {
      const graph: GraphForPath = {
        nodes: [{ id: 'A', type: 'start' }, { id: 'B' }],
        edges: [
          {
            id: 'e1',
            uuid: 'e1',
            from: 'A',
            to: 'B',
            p: {
              mean: 0.3,
              latency: { latency_parameter: true, t95: 30 },
              evidence: { mean: 0.3, n: 100, k: 30 },
              forecast: { mean: 0.98 },
            },
          },
        ],
      };

      // Very fresh cohorts relative to lag → completeness low.
      const cohortSlice = createCohortSlice(
        ['9-Dec-25', '10-Dec-25'],
        [50, 50],
        [15, 15],
        [10, 10]
      );
      const windowSlice = createWindowSlice('18-Nov-25:10-Dec-25', 400, 392, 0.98);

      const paramLookup = new Map<string, ParameterValueForLAG[]>();
      paramLookup.set('e1', [cohortSlice, windowSlice]);

      const result = enhanceGraphLatencies(
        graph,
        paramLookup,
        new Date('2025-12-10'),
        helpers,
        { start: new Date('2025-12-09'), end: new Date('2025-12-10') }
      );

      const e1 = result.edgeValues[0];
      expect(e1.latency.completeness).toBeLessThan(0.6);

      const distanceToEvidence = Math.abs((e1.blendedMean ?? 0) - 0.3);
      const distanceToForecast = Math.abs((e1.blendedMean ?? 0) - 0.98);
      expect(distanceToForecast).toBeLessThan(distanceToEvidence);
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 0 – Design-driven LAG invariants (TDD baseline)
  // These tests encode the canonical behaviour from stats-convolution-schematic.md.
  // Some are expected to FAIL against the current implementation and will drive
  // the forthcoming fixes.
  // ---------------------------------------------------------------------------

  describe('Phase 0 – Design-driven LAG invariants', () => {
    /**
     * T1. Completeness uses anchor_median_lag (observed), not path_t95
     *
     * Design:
     * - For a first latency edge from the anchor, there is no upstream anchor lag:
     *   effective_age = anchor_age, so mature cohorts should have completeness ~1.
     *
     * This test asserts that property directly for a simple, mature single-edge case.
     */
    it('T1: should report high completeness for mature cohorts on the first latency edge', () => {
      // Cohorts that are well beyond the edge lag: ages 20–24 days, median lag ≈ 3 days.
      const cohorts: CohortData[] = [
        { date: '10-Nov-25', n: 100, k: 90, age: 24, median_lag_days: 3, mean_lag_days: 3 },
        { date: '11-Nov-25', n: 100, k: 88, age: 23, median_lag_days: 3, mean_lag_days: 3 },
        { date: '12-Nov-25', n: 100, k: 87, age: 22, median_lag_days: 3, mean_lag_days: 3 },
        { date: '13-Nov-25', n: 100, k: 86, age: 21, median_lag_days: 3, mean_lag_days: 3 },
        { date: '14-Nov-25', n: 100, k: 85, age: 20, median_lag_days: 3, mean_lag_days: 3 },
      ];

      const stats = computeEdgeLatencyStats(
        cohorts,
        3,   // aggregateMedianLag
        3,   // aggregateMeanLag
        30,  // fallbackT95Days
        0    // anchorMedianLag (first latency edge)
      );

      // Design expectation: highly mature cohorts → completeness near 1.
      expect(stats.completeness).toBeGreaterThan(0.9);
    });

    /**
     * T2. Cohort ages relative to TODAY, not DSL window end
     *
     * Design:
     * - aggregateCohortData should compute age as (analysis_date - cohort_date),
     *   independent of the cohort window bounds used to select which cohorts are included.
     *
     * Note: The implementation already follows this design via queryDate, so this
     * test is expected to PASS and serves as a guard against regressions.
     */
    it('T2: should calculate cohort age relative to analysis date, not cohort window end', () => {
      const analysisDate = new Date('2025-12-01');
      const cohortWindow = {
        start: new Date('2025-11-01'),
        end: new Date('2025-11-07'),
      };

      // Single cohort on 1-Nov-25; when analysed on 1-Dec-25 it should be ~30 days old.
      const dates = ['1-Nov-25'];
      const nDaily = [100];
      const kDaily = [50];
      const medianLag = [3];

      const cohortSlice = createCohortSlice(dates, nDaily, kDaily, medianLag);

      const cohorts = aggregateCohortData([cohortSlice], analysisDate, cohortWindow);

      expect(cohorts.length).toBe(1);
      // 1-Nov-25 → 1-Dec-25: 30 days (ignoring subtle timezone differences)
      expect(cohorts[0].age).toBeGreaterThanOrEqual(29);
      expect(cohorts[0].age).toBeLessThanOrEqual(31);
    });

    /**
     * T4. Mature cohort with short-lag edge has ~100% completeness
     *
     * Design:
     * - For an edge with a short lag (median ~3 days, maturity ~7 days),
     *   a 4-week-old cohort should be essentially 100% complete.
     *
     * This test asserts the high-level invariant directly.
     */
    it('T4: should report ~100% completeness for a 4-week-old cohort on a short-lag edge', () => {
      const cohorts: CohortData[] = [
        { date: '1-Nov-25', n: 100, k: 60, age: 28, median_lag_days: 3, mean_lag_days: 3 },
      ];

      const stats = computeEdgeLatencyStats(
        cohorts,
        3,   // aggregateMedianLag
        3,   // aggregateMeanLag
        7,   // fallbackT95Days (short)
        0    // pathT95
      );

      // With age far beyond t95, completeness should be essentially 1.
      expect(stats.completeness).toBeGreaterThan(0.95);
    });

    /**
     * T5. p_infinity fallback when no window() slice
     *
     * Design:
     * - If there is no window() slice providing p.forecast.mean, but LAG can
     *   estimate a reliable p_infinity from mature cohorts, that p_infinity
     *   should serve as the forecast baseline for blending.
     *
     * This test currently FAILS because enhanceGraphLatencies only blends when
     * edge.p.forecast.mean is already present on the edge.
     */
    it('T5: should use p_infinity as forecast baseline when no window slice is available', () => {
      const graph: GraphForPath = {
        nodes: [
          { id: 'A', type: 'start' },
          { id: 'B' },
        ],
        edges: [
          {
            id: 'e1',
            uuid: 'e1',
            from: 'A',
            to: 'B',
            p: {
              mean: 0.5,
              latency: { latency_parameter: true, t95: 30 },
              // IMPORTANT: No forecast.mean here – we want cohort-only forecast.
              evidence: { mean: 0.4, n: 500, k: 200 },
            },
          },
        ],
      };

      // Cohort-only data for e1, no window slice
      // Use older cohorts so that at least some are clearly "mature" relative to t95.
      const cohortSlice = createCohortSlice(
        ['1-Oct-25', '5-Oct-25', '10-Oct-25', '15-Oct-25', '20-Oct-25'],
        [100, 100, 100, 100, 100],
        [60, 58, 59, 61, 62], // evidence mean ≈ 0.60
        [3, 3, 3, 3, 3]
      );

      const paramLookup = new Map<string, ParameterValueForLAG[]>();
      paramLookup.set('e1', [cohortSlice]);

      const queryDate = new Date('2025-12-01');
      const cohortWindow = {
        start: new Date('2025-10-01'),
        end: new Date('2025-10-31'),
      };

      const result = enhanceGraphLatencies(
        graph,
        paramLookup,
        queryDate,
        helpers,
        cohortWindow
      );

      expect(result.edgesWithLAG).toBe(1);
      expect(result.edgeValues.length).toBe(1);

      const e1Result = result.edgeValues[0];

      // Design expectation: even without a window() slice, we should have a blended mean
      // based on p_infinity (from mature cohorts) and evidence.
      expect(e1Result.latency.completeness).toBeGreaterThan(0); // cohorts are not fresh
      expect(e1Result.blendedMean).toBeDefined();
    });
  });

  describe('Scenario 1: Single Edge - Fully Mature Cohort', () => {
    /**
     * Single latency edge with mature cohort (age > t95)
     * 
     * Setup:
     * - t95 = 5 days (median lag ~2 days → mu ≈ 0.69)
     * - Cohort ages: 10-14 days (all mature)
     * - Expected: completeness ≈ 100%, p.mean ≈ evidence.mean
     */
    it('should report high completeness when cohorts are much older than lag', () => {
      // Cohort data: 5 days of data, 10-14 days old – all well beyond a median lag of 2 days.
      const cohorts: CohortData[] = [
        { date: '13-Nov-25', n: 100, k: 55, age: 14, median_lag_days: 2, mean_lag_days: 2 },
        { date: '14-Nov-25', n: 120, k: 66, age: 13, median_lag_days: 2, mean_lag_days: 2 },
        { date: '15-Nov-25', n: 110, k: 58, age: 12, median_lag_days: 2, mean_lag_days: 2 },
        { date: '16-Nov-25', n: 130, k: 72, age: 11, median_lag_days: 2, mean_lag_days: 2 },
        { date: '17-Nov-25', n: 140, k: 77, age: 10, median_lag_days: 2, mean_lag_days: 2 },
      ];
      
      const totalN = cohorts.reduce((s, c) => s + c.n, 0);  // 600
      const totalK = cohorts.reduce((s, c) => s + c.k, 0);  // 328
      const evidenceMean = totalK / totalN;  // ~0.547
      
      const stats = computeEdgeLatencyStats(
        cohorts,
        2,      // aggregateMedianLag
        2,      // aggregateMeanLag
        30,     // fallbackT95Days
        0       // pathT95 (first edge)
      );
      
      // Completeness: all cohorts are 10-14 days old relative to a short lag,
      // so almost all eventual converters should have had time to convert.
      expect(stats.completeness).toBeGreaterThan(0.8);

      // p_evidence should still be the simple k / n aggregate.
      expect(stats.p_evidence).toBeCloseTo(evidenceMean, 2);
    });
  });

  describe('Scenario 2: Single Edge - Fresh Cohort', () => {
    /**
     * Single latency edge with very fresh cohort (age < t95)
     * 
     * Setup:
     * - t95 = 10 days (median lag ~4 days)
     * - Cohort ages: 0-3 days (very immature)
     * - Expected: completeness ≈ 0-20%, p.mean → forecast.mean
     */
    it('should report low completeness when cohorts are very fresh', () => {
      // Fresh cohorts: 0-3 days old
      const cohorts: CohortData[] = [
        { date: '24-Nov-25', n: 100, k: 10, age: 3, median_lag_days: 4, mean_lag_days: 4 },
        { date: '25-Nov-25', n: 120, k: 8, age: 2, median_lag_days: 4, mean_lag_days: 4 },
        { date: '26-Nov-25', n: 110, k: 5, age: 1, median_lag_days: 4, mean_lag_days: 4 },
        { date: '27-Nov-25', n: 130, k: 2, age: 0, median_lag_days: 4, mean_lag_days: 4 },
      ];
      
      const totalK = cohorts.reduce((s, c) => s + c.k, 0);  // 25
      const totalN = cohorts.reduce((s, c) => s + c.n, 0);  // 460
      const evidenceMean = totalK / totalN;  // ~0.054
      
      const stats = computeEdgeLatencyStats(
        cohorts,
        4,      // aggregateMedianLag  
        4,      // aggregateMeanLag
        30,     // fallbackT95Days
        0       // pathT95
      );
      
      // Completeness: ages 0-3 vs a longer lag → very low.
      // CDF(3, mu, sigma) for mu=ln(4), sigma=0.5 → ~10-30%
      expect(stats.completeness).toBeLessThan(0.4);
      
      // Evidence mean should be low (many users haven't converted yet)
      expect(stats.p_evidence).toBeCloseTo(evidenceMean, 2);
    });
  });

  describe('Scenario 3: Two-Edge Chain - Downstream Path Adjustment', () => {
    /**
     * Two edges in series: A → B → C
     * 
     * Edge A→B: t95 = 5 days, pathT95 = 5
     * Edge B→C: t95 = 8 days, pathT95 = 13 (5 + 8)
     * 
     * For B→C, cohort ages are adjusted by upstream pathT95:
     * - Raw age 15 days → adjusted age = 15 - 5 = 10 days
     * 
     * This tests the path_t95 adjustment logic.
     */
    it('should not increase completeness when upstream pathT95 is applied', () => {
      // Edge B→C cohorts with raw ages 10-14
      // pathT95 from upstream = 5 days
      const cohorts: CohortData[] = [
        { date: '13-Nov-25', n: 100, k: 40, age: 14, median_lag_days: 3, mean_lag_days: 3 },
        { date: '14-Nov-25', n: 100, k: 38, age: 13, median_lag_days: 3, mean_lag_days: 3 },
        { date: '15-Nov-25', n: 100, k: 35, age: 12, median_lag_days: 3, mean_lag_days: 3 },
        { date: '16-Nov-25', n: 100, k: 30, age: 11, median_lag_days: 3, mean_lag_days: 3 },
        { date: '17-Nov-25', n: 100, k: 25, age: 10, median_lag_days: 3, mean_lag_days: 3 },
      ];
      
      // Without upstream pathT95, we treat raw ages directly.
      const statsNoPath = computeEdgeLatencyStats(
        cohorts,
        3,
        3,
        30,
        0
      );

      // With upstream pathT95, effective ages are reduced, so completeness should fall.
      const statsWithPath = computeEdgeLatencyStats(
        cohorts,
        3,
        3,
        30,
        5
      );

      // Downstream effective ages must never make completeness higher than the
      // same cohorts evaluated without pathT95 applied.
      expect(statsWithPath.completeness).toBeLessThanOrEqual(statsNoPath.completeness);
      expect(statsWithPath.completeness).toBeGreaterThanOrEqual(0);
    });
    
    it('should clamp adjusted ages at zero', () => {
      // Cohorts with raw ages less than pathT95
      // pathT95 = 15, but cohorts are only 5-10 days old
      const cohorts: CohortData[] = [
        { date: '17-Nov-25', n: 100, k: 5, age: 10, median_lag_days: 3, mean_lag_days: 3 },
        { date: '18-Nov-25', n: 100, k: 3, age: 9, median_lag_days: 3, mean_lag_days: 3 },
        { date: '19-Nov-25', n: 100, k: 2, age: 8, median_lag_days: 3, mean_lag_days: 3 },
        { date: '20-Nov-25', n: 100, k: 1, age: 7, median_lag_days: 3, mean_lag_days: 3 },
        { date: '21-Nov-25', n: 100, k: 0, age: 6, median_lag_days: 3, mean_lag_days: 3 },
      ];
      
      const pathT95Upstream = 15;  // More than any cohort age
      
      const stats = computeEdgeLatencyStats(
        cohorts,
        3,              // aggregateMedianLag
        3,              // aggregateMeanLag
        30,             // fallbackT95Days
        pathT95Upstream // pathT95 larger than cohort ages
      );
      
      // All adjusted ages = 0 (clamped)
      // CDF(0) = 0, so completeness should be ~0
      expect(stats.completeness).toBeLessThan(0.01);
    });
  });

  describe('Scenario 4: Three-Edge Chain - Cumulative Path T95', () => {
    /**
     * Three edges: A → B → C → D
     * 
     * A→B: t95 = 5
     * B→C: t95 = 10, pathT95 = 15 (5 + 10)
     * C→D: t95 = 8, pathT95 = 23 (15 + 8)
     * 
     * Tests that completeness decreases significantly for deep downstream edges.
     */
    it('should show decreasing completeness for deeper downstream edges', () => {
      const graph: GraphForPath = {
        nodes: [
          { id: 'A', type: 'start' },
          { id: 'B' },
          { id: 'C' },
          { id: 'D' },
        ],
        edges: [
          { 
            id: 'e1', uuid: 'e1', from: 'A', to: 'B', 
            p: { 
              mean: 0.5, 
              latency: { latency_parameter: true, t95: 5 },
              forecast: { mean: 0.5 },
              evidence: { mean: 0.48, n: 500, k: 240 },
            } 
          },
          { 
            id: 'e2', uuid: 'e2', from: 'B', to: 'C', 
            p: { 
              mean: 0.3, 
              latency: { latency_parameter: true, t95: 10 },
              forecast: { mean: 0.3 },
              evidence: { mean: 0.25, n: 240, k: 60 },
            } 
          },
          { 
            id: 'e3', uuid: 'e3', from: 'C', to: 'D', 
            p: { 
              mean: 0.6, 
              latency: { latency_parameter: true, t95: 8 },
              forecast: { mean: 0.6 },
              evidence: { mean: 0.35, n: 60, k: 21 },
            } 
          },
        ],
      };
      
      // Create cohort data for each edge (cohorts aged 10-14 days)
      const createCohorts = (kRatio: number): CohortData[] => [
        { date: '13-Nov-25', n: 100, k: Math.round(100 * kRatio), age: 14, median_lag_days: 2 },
        { date: '14-Nov-25', n: 100, k: Math.round(100 * kRatio), age: 13, median_lag_days: 2 },
        { date: '15-Nov-25', n: 100, k: Math.round(100 * kRatio), age: 12, median_lag_days: 2 },
        { date: '16-Nov-25', n: 100, k: Math.round(100 * kRatio), age: 11, median_lag_days: 2 },
        { date: '17-Nov-25', n: 100, k: Math.round(100 * kRatio), age: 10, median_lag_days: 2 },
      ];
      
      // Edge 1: pathT95 = 0
      const stats1 = computeEdgeLatencyStats(createCohorts(0.48), 2, 2, 30, 0);
      
      // Edge 2: pathT95 = 5 (from edge 1)
      const stats2 = computeEdgeLatencyStats(createCohorts(0.25), 2, 2, 30, 5);
      
      // Edge 3: pathT95 = 15 (from edges 1+2)
      const stats3 = computeEdgeLatencyStats(createCohorts(0.35), 2, 2, 30, 15);
      
      // Completeness should not increase as pathT95 increases
      expect(stats1.completeness).toBeGreaterThanOrEqual(stats2.completeness);
      expect(stats2.completeness).toBeGreaterThanOrEqual(stats3.completeness);
      
      // First edge should have high completeness (pathT95=0)
      expect(stats1.completeness).toBeGreaterThan(0.8);
      
      // Last edge should have much lower completeness (pathT95=15, ages 10-14)
      // Adjusted ages: 10-15 = -5 → 0, so most cohorts have 0 effective age
      expect(stats3.completeness).toBeLessThan(0.3);
    });
  });

  describe('Scenario 5: Mixed Latency/Non-Latency Path', () => {
    /**
     * Path with mixed edges: A → B → C → D
     * 
     * A→B: non-latency (latency not enabled)
     * B→C: latency (t95 = 10)
     * C→D: latency (t95 = 5, pathT95 = 10)
     * 
     * Non-latency edges should not contribute to pathT95.
     */
    it('should not include non-latency edges in pathT95', () => {
      // B→C cohorts with ages 12-16
      const cohortsBC: CohortData[] = [
        { date: '11-Nov-25', n: 100, k: 35, age: 16, median_lag_days: 4 },
        { date: '12-Nov-25', n: 100, k: 33, age: 15, median_lag_days: 4 },
        { date: '13-Nov-25', n: 100, k: 30, age: 14, median_lag_days: 4 },
        { date: '14-Nov-25', n: 100, k: 28, age: 13, median_lag_days: 4 },
        { date: '15-Nov-25', n: 100, k: 25, age: 12, median_lag_days: 4 },
      ];
      
      // B→C: upstream A→B is non-latency, so pathT95 = 0
      const statsBC = computeEdgeLatencyStats(cohortsBC, 4, 4, 30, 0);
      
      // C→D cohorts with same ages
      const cohortsCD: CohortData[] = [
        { date: '11-Nov-25', n: 35, k: 20, age: 16, median_lag_days: 2 },
        { date: '12-Nov-25', n: 33, k: 18, age: 15, median_lag_days: 2 },
        { date: '13-Nov-25', n: 30, k: 16, age: 14, median_lag_days: 2 },
        { date: '14-Nov-25', n: 28, k: 14, age: 13, median_lag_days: 2 },
        { date: '15-Nov-25', n: 25, k: 12, age: 12, median_lag_days: 2 },
      ];
      
      // C→D: upstream includes B→C (t95 ~10), so pathT95 ~10
      const statsCD = computeEdgeLatencyStats(cohortsCD, 2, 2, 30, statsBC.t95);
      
      // B→C should have completeness that is at least as high as C→D, since
      // only C→D sits behind upstream latency.
      expect(statsBC.completeness).toBeGreaterThanOrEqual(statsCD.completeness);
    });
  });

  describe('Scenario 6: Completeness aggregation matches CDF average', () => {
    /**
     * Design (§5.5 in design.md):
     *   completeness_i = F(a_i)
     *   completeness   = Σ n_i F(a_i) / Σ n_i
     *
     * This test encodes that definition directly using logNormalCDF as the oracle
     * for per-cohort completeness, and compares it to calculateCompleteness.
     */
    it('should equal the n-weighted average of per-cohort CDFs', () => {
      const cohorts: CohortData[] = [
        { date: '23-Nov-25', n: 50,  k: 29, age: 5, median_lag_days: 2, mean_lag_days: 2 },
        { date: '24-Nov-25', n: 97,  k: 44, age: 4, median_lag_days: 2, mean_lag_days: 2 },
        { date: '25-Nov-25', n: 62,  k: 31, age: 3, median_lag_days: 2, mean_lag_days: 2 },
        { date: '26-Nov-25', n: 90,  k: 44, age: 2, median_lag_days: 2, mean_lag_days: 2 },
        { date: '27-Nov-25', n: 156, k: 91, age: 1, median_lag_days: 2, mean_lag_days: 2 },
      ];

      const mu = Math.log(2);   // median lag ≈ 2 days
      const sigma = 0.5;        // typical dispersion

      const totalN = cohorts.reduce((sum, c) => sum + c.n, 0);
      const expected =
        cohorts.reduce((sum, c) => sum + c.n * logNormalCDF(c.age, mu, sigma), 0) /
        totalN;

      const actual = calculateCompleteness(cohorts, mu, sigma);

      // Allow small numerical tolerance, but require close agreement with spec.
      expect(actual).toBeCloseTo(expected, 2);
    });
  });

  describe('Scenario 7: Cohort Window Filtering', () => {
    /**
     * Test that LAG calculation uses ONLY cohorts within the DSL window.
     * 
     * Parameter file has 30 days of data (1-Nov to 30-Nov)
     * DSL query window: 20-Nov to 25-Nov (6 days)
     * 
     * Only cohorts within 20-Nov to 25-Nov should be used for completeness.
     */
    it('should filter cohorts to DSL window', () => {
      const queryDate = new Date('2025-11-25');
      const cohortWindow = {
        start: new Date('2025-11-20'),
        end: new Date('2025-11-25'),
      };
      
      // Create cohort slice with 30 days of data
      const dates = [];
      const nDaily = [];
      const kDaily = [];
      const medianLag = [];
      for (let i = 1; i <= 30; i++) {
        const day = i.toString().padStart(2, '0');
        dates.push(`${i}-Nov-25`);
        nDaily.push(100);
        kDaily.push(50);
        medianLag.push(3);
      }
      
      const cohortSlice = createCohortSlice(dates, nDaily, kDaily, medianLag);
      
      // Without filter: should get 30 cohorts
      const cohortsAll = aggregateCohortData([cohortSlice], queryDate);
      expect(cohortsAll.length).toBe(30);
      
      // With filter: should get only 6 cohorts (20-25 Nov)
      const cohortsFiltered = aggregateCohortData([cohortSlice], queryDate, cohortWindow);
      expect(cohortsFiltered.length).toBe(6);
      
      // Verify the dates are correct
      const filteredDates = cohortsFiltered.map(c => c.date);
      expect(filteredDates).toContain('20-Nov-25');
      expect(filteredDates).toContain('25-Nov-25');
      expect(filteredDates).not.toContain('19-Nov-25');
      expect(filteredDates).not.toContain('26-Nov-25');
    });
  });

  describe('Scenario 8: enhanceGraphLatencies Integration', () => {
    /**
     * Full integration test of enhanceGraphLatencies
     * 
     * Graph: A → B → C
     * A→B: latency edge with cohort and window data
     * B→C: latency edge with cohort and window data
     * 
     * Verify that returned EdgeLAGValues have correct:
     * - t95
     * - path_t95
     * - completeness
     * - blendedMean
     */
    it('should compute LAG values for multi-edge graph', () => {
      const graph: GraphForPath = {
        nodes: [
          { id: 'A', type: 'start' },
          { id: 'B' },
          { id: 'C' },
        ],
        edges: [
          { 
            id: 'e1', uuid: 'e1', from: 'A', to: 'B',
            p: {
              mean: 0.5,
              latency: { latency_parameter: true, t95: 30 },
              forecast: { mean: 0.55 },
              evidence: { mean: 0.48, n: 500, k: 240 },
            },
          },
          { 
            id: 'e2', uuid: 'e2', from: 'B', to: 'C',
            p: {
              mean: 0.3,
              latency: { latency_parameter: true, t95: 30 },
              forecast: { mean: 0.35 },
              evidence: { mean: 0.25, n: 200, k: 50 },
            },
          },
        ],
      };
      
      // Create param lookup with cohort and window data
      const paramLookup = new Map<string, ParameterValueForLAG[]>();
      
      // Edge 1 data
      paramLookup.set('e1', [
        createCohortSlice(
          ['20-Nov-25', '21-Nov-25', '22-Nov-25', '23-Nov-25', '24-Nov-25'],
          [100, 100, 100, 100, 100],
          [48, 50, 52, 45, 47],
          [2, 2, 2, 2, 2]
        ),
        createWindowSlice('1-Nov-25:19-Nov-25', 2000, 1100, 0.55),
      ]);
      
      // Edge 2 data  
      paramLookup.set('e2', [
        createCohortSlice(
          ['20-Nov-25', '21-Nov-25', '22-Nov-25', '23-Nov-25', '24-Nov-25'],
          [48, 50, 52, 45, 47],
          [12, 13, 14, 10, 11],
          [5, 5, 5, 5, 5]
        ),
        createWindowSlice('1-Nov-25:19-Nov-25', 1100, 385, 0.35),
      ]);
      
      const queryDate = new Date('2025-11-24');
      const cohortWindow = {
        start: new Date('2025-11-20'),
        end: new Date('2025-11-24'),
      };
      
      const result = enhanceGraphLatencies(
        graph,
        paramLookup,
        queryDate,
        helpers,
        cohortWindow
      );
      
      expect(result.edgesWithLAG).toBe(2);
      expect(result.edgeValues.length).toBe(2);
      
      // Find results by edge ID
      const e1Result = result.edgeValues.find(v => v.edgeUuid === 'e1');
      const e2Result = result.edgeValues.find(v => v.edgeUuid === 'e2');
      
      expect(e1Result).toBeDefined();
      expect(e2Result).toBeDefined();
      
      // Edge 1: first in path, pathT95 should equal its own t95
      expect(e1Result!.latency.t95).toBeGreaterThan(0);
      expect(e1Result!.latency.path_t95).toBe(e1Result!.latency.t95);
      
      // Edge 2: downstream, pathT95 should be greater than its own t95
      expect(e2Result!.latency.t95).toBeGreaterThan(0);
      expect(e2Result!.latency.path_t95).toBeGreaterThan(e2Result!.latency.t95);
      
      // Completeness should be higher for edge 1 (no upstream latency)
      expect(e1Result!.latency.completeness).toBeGreaterThan(e2Result!.latency.completeness);
      
      // Both should have blended means
      expect(e1Result!.blendedMean).toBeDefined();
      expect(e2Result!.blendedMean).toBeDefined();
      
      // Canonical blend: bounded between evidence and forecast (and within [0, 1]).
      if (e1Result!.blendedMean !== undefined) {
        expect(e1Result!.blendedMean).toBeGreaterThanOrEqual(0);
        expect(e1Result!.blendedMean).toBeLessThanOrEqual(1);
      }
    });

    it('uses anchor+edge moment-matched path_t95 (Option A) to avoid compounding conservatism', () => {
      // Graph: A → B → C → D
      // We'll make upstream edges have large t95 with realistic variance (mean > median),
      // but for the downstream edge C→D we provide anchor_* (A→C) lag data
      // that is materially smaller than the conservative topo sum of upstream t95s.
      //
      // KEY INSIGHT: For Option A to provide benefit, upstream edges must have
      // non-zero variance (mean > median). Otherwise their t95 = median exactly
      // (no conservatism to compound), and the moment-matched estimate may actually
      // be larger due to the variance introduced by anchor data.
      const graph: GraphForPath = {
        nodes: [
          { id: 'A', type: 'start' },
          { id: 'B' },
          { id: 'C' },
          { id: 'D' },
        ],
        edges: [
          {
            id: 'e1', uuid: 'e1', from: 'A', to: 'B',
            // IMPORTANT: Do NOT pre-seed t95 here; edge.p.latency.t95 is treated as authoritative
            // and will override the computed t95 derived from lag arrays. This scenario is
            // explicitly validating the computed/moment-matched path behaviour.
            p: { mean: 0.5, latency: { latency_parameter: true }, forecast: { mean: 0.5 }, evidence: { mean: 0.5, n: 1000, k: 500 } },
          },
          {
            id: 'e2', uuid: 'e2', from: 'B', to: 'C',
            p: { mean: 0.5, latency: { latency_parameter: true }, forecast: { mean: 0.5 }, evidence: { mean: 0.5, n: 1000, k: 500 } },
          },
          {
            id: 'e3', uuid: 'e3', from: 'C', to: 'D',
            p: { mean: 0.5, latency: { latency_parameter: true }, forecast: { mean: 0.5 }, evidence: { mean: 0.5, n: 1000, k: 500 } },
          },
        ],
      };

      const dates = ['20-Nov-25', '21-Nov-25', '22-Nov-25', '23-Nov-25', '24-Nov-25'];

      // Upstream edges: large lag with VARIANCE (mean > median for realistic right-skew)
      // This gives them larger t95 values at high percentiles, so topo sum compounds.
      // Ensure total converters >= 30 for empirical fit.
      const e1Cohort = createCohortSlice(
        dates,
        [200, 200, 200, 200, 200],
        [60, 60, 60, 60, 60],
        [10, 10, 10, 10, 10]  // median_lag_days
      );
      // Add realistic variance: mean > median (typical right-skew)
      (e1Cohort as any).mean_lag_days = [12, 12, 12, 12, 12];
      
      const e2Cohort = createCohortSlice(
        dates,
        [200, 200, 200, 200, 200],
        [60, 60, 60, 60, 60],
        [10, 10, 10, 10, 10]  // median_lag_days
      );
      // Add realistic variance: mean > median
      (e2Cohort as any).mean_lag_days = [12, 12, 12, 12, 12];

      // Downstream edge: small edge lag (C→D), but include anchor lags (A→C)
      // that are materially smaller than the conservative sum of upstream t95s.
      // Anchor median=8, mean=10 (measured actual A→C time, much less than topo sum)
      const e3Cohort = createCohortSlice(
        dates,
        [200, 200, 200, 200, 200],
        [60, 60, 60, 60, 60],
        [3, 3, 3, 3, 3],  // edge lag C→D (median)
        // anchor medians (A→C) - measured actual time from A to C
        [8, 8, 8, 8, 8],
        // anchor means (A→C)
        [10, 10, 10, 10, 10]
      );
      // Add edge mean for C→D
      (e3Cohort as any).mean_lag_days = [4, 4, 4, 4, 4];

      const paramLookup = new Map<string, ParameterValueForLAG[]>();
      paramLookup.set('e1', [e1Cohort, createWindowSlice('1-Nov-25:19-Nov-25', 2000, 1000, 0.5)]);
      paramLookup.set('e2', [e2Cohort, createWindowSlice('1-Nov-25:19-Nov-25', 2000, 1000, 0.5)]);
      paramLookup.set('e3', [e3Cohort, createWindowSlice('1-Nov-25:19-Nov-25', 2000, 1000, 0.5)]);

      const queryDate = new Date('2025-11-24');
      const cohortWindow = { start: new Date('2025-11-20'), end: new Date('2025-11-24') };

      const result = enhanceGraphLatencies(graph, paramLookup, queryDate, helpers, cohortWindow);
      const e1Result = result.edgeValues.find(v => v.edgeUuid === 'e1');
      const e2Result = result.edgeValues.find(v => v.edgeUuid === 'e2');
      const e3Result = result.edgeValues.find(v => v.edgeUuid === 'e3');

      expect(e1Result).toBeDefined();
      expect(e2Result).toBeDefined();
      expect(e3Result).toBeDefined();

      // Topo fallback accumulation: path_t95(to C) + t95(C→D)
      // With variance, this compounds conservatism at high percentiles.
      const topoFallbackForE3 = (e2Result!.latency.path_t95 ?? 0) + e3Result!.latency.t95;

      // Option A uses anchor+edge moment-matched estimate (A→C + C→D as lognormal sum).
      // Since anchor median (8d) << topo sum (much larger with variance),
      // the combined A→D estimate should be materially smaller.
      expect(e3Result!.latency.path_t95).toBeLessThan(topoFallbackForE3 - 1e-9);
      // Still must be at least the edge-local t95
      expect(e3Result!.latency.path_t95).toBeGreaterThanOrEqual(e3Result!.latency.t95);
    });
  });

  describe('Scenario 9: Window-Only Forecast', () => {
    /**
     * Test that forecast comes from window() slices, not cohort() slices.
     * 
     * The forecast value should be the p_infinity from mature window data.
     */
    it('should use forecast from window slice, not cohort slice', () => {
      const cohortSlice = createCohortSlice(
        ['20-Nov-25', '21-Nov-25', '22-Nov-25'],
        [100, 100, 100],
        [40, 42, 38],  // evidence mean = 120/300 = 0.4
        [3, 3, 3]
      );
      
      const windowSlice = createWindowSlice(
        '1-Nov-25:19-Nov-25',
        3000,
        1800,
        0.6  // forecast = 0.6 (from mature window data)
      );
      
      // The window slice forecast (0.6) should be used, not derived from cohort (0.4)
      expect(windowSlice.forecast).toBe(0.6);
      expect(cohortSlice.mean).toBeCloseTo(0.4, 2);
    });
  });

  describe('Scenario 10: Edge Cases', () => {
    it('should handle empty cohort data gracefully', () => {
      const cohorts: CohortData[] = [];
      
      // Should not throw, should return safe defaults
      const result = calculateCompleteness(cohorts, 0.69, 0.5);
      expect(result).toBe(0);
    });
    
    it('should handle zero n cohorts', () => {
      const cohorts: CohortData[] = [
        { date: '20-Nov-25', n: 0, k: 0, age: 5 },
        { date: '21-Nov-25', n: 0, k: 0, age: 4 },
      ];
      
      const result = calculateCompleteness(cohorts, 0.69, 0.5);
      expect(result).toBe(0);  // No population, no completeness
    });
    
    it('should handle very old cohorts (100% complete)', () => {
      const cohorts: CohortData[] = [
        { date: '1-Oct-25', n: 100, k: 50, age: 60, median_lag_days: 3 },
        { date: '2-Oct-25', n: 100, k: 48, age: 59, median_lag_days: 3 },
      ];
      
      // With ages 59-60 days and a short median lag, cohorts should be highly complete.
      // NOTE: The tail constraint is one-way and only applies when an authoritative t95
      // (edge.p.latency.t95) is provided and is larger than the moment-implied tail.
      // Here we do not provide an authoritative t95, so the constraint should not apply.
      const stats = computeEdgeLatencyStats(cohorts, 3, 3, 30, 0);
      expect(stats.completeness_cdf.tail_constraint_applied).toBe(false);
      expect(stats.completeness).toBeGreaterThan(0.95);
      expect(stats.completeness).toBeLessThanOrEqual(1);
    });
    
    it('should handle cohorts with k > n as invalid data', () => {
      // This shouldn't happen but the code should handle it gracefully
      const cohorts: CohortData[] = [
        { date: '20-Nov-25', n: 50, k: 60, age: 5 },  // Invalid: k > n
      ];
      
      // Should still compute something, but data is invalid
      const result = calculateCompleteness(cohorts, 0.69, 0.5);
      expect(result).toBeDefined();
    });
  });
});

describe('Anchor Lag Data Flow (C1 e2e)', () => {
  const helpers = createLAGHelpers();

  /**
   * Test the complete flow of anchor_median_lag_days from param files
   * through the stats service to ensure:
   * 1. Data is correctly extracted from param file format
   * 2. Stats service computes k-weighted anchorMedianLag
   * 3. Cohort ages are adjusted by anchor lag
   * 4. Debug output includes anchor lag info for session log visibility
   */

  describe('Anchor lag extraction from param file format', () => {
    it('should extract anchor_median_lag_days from cohort slice to CohortData', () => {
      // Simulate param file data with anchor lag arrays
      const cohortSlice: ParameterValueForLAG = {
        sliceDSL: 'cohort(household-created,1-Nov-25:5-Nov-25)',
        dates: ['1-Nov-25', '2-Nov-25', '3-Nov-25', '4-Nov-25', '5-Nov-25'],
        n: 500,
        k: 200,
        n_daily: [100, 100, 100, 100, 100],
        k_daily: [40, 42, 38, 41, 39],
        median_lag_days: [6, 6.5, 5.8, 6.2, 6.1],  // X→Y lag
        mean_lag_days: [7, 7.2, 6.9, 7.1, 7.0],
        // CRITICAL: anchor lag data from 3-step funnel (A→X lag)
        anchor_n_daily: [200, 210, 195, 205, 190],  // Anchor cohort entry counts
        anchor_median_lag_days: [12, 11.5, 12.2, 11.8, 12.1],  // A→X upstream lag
        anchor_mean_lag_days: [14, 13.5, 14.2, 13.8, 14.1],
        mean: 0.4,
        data_source: { retrieved_at: '2025-12-10T00:00:00Z', type: 'amplitude' },
      } as ParameterValueForLAG;

      // Use aggregateCohortData to convert to CohortData
      const analysisDate = new Date('2025-12-10');
      const cohortWindow = {
        start: new Date('2025-11-01'),
        end: new Date('2025-11-05'),
      };
      
      const cohorts = aggregateCohortData([cohortSlice], analysisDate, cohortWindow);

      // Verify anchor lag data is present on cohorts
      expect(cohorts.length).toBe(5);
      
      // First cohort should have anchor lag
      expect(cohorts[0].anchor_median_lag_days).toBe(12);
      expect(cohorts[1].anchor_median_lag_days).toBe(11.5);
      expect(cohorts[4].anchor_median_lag_days).toBe(12.1);
    });

    it('should handle missing anchor_median_lag_days gracefully (legacy data)', () => {
      // Legacy param file without anchor lag data
      const legacySlice: ParameterValueForLAG = {
        sliceDSL: 'cohort(1-Nov-25:5-Nov-25)',
        dates: ['1-Nov-25', '2-Nov-25', '3-Nov-25'],
        n: 300,
        k: 120,
        n_daily: [100, 100, 100],
        k_daily: [40, 42, 38],
        median_lag_days: [6, 6.5, 5.8],
        mean_lag_days: [7, 7.2, 6.9],
        // NO anchor_median_lag_days - legacy format
        mean: 0.4,
        data_source: { retrieved_at: '2025-12-10T00:00:00Z', type: 'amplitude' },
      } as ParameterValueForLAG;

      const analysisDate = new Date('2025-12-10');
      const cohortWindow = {
        start: new Date('2025-11-01'),
        end: new Date('2025-11-05'),
      };
      
      const cohorts = aggregateCohortData([legacySlice], analysisDate, cohortWindow);

      // Cohorts should still be valid, just without anchor lag
      expect(cohorts.length).toBe(3);
      expect(cohorts[0].anchor_median_lag_days).toBeUndefined();
    });
  });

  describe('Stats service anchor lag consumption', () => {
    it('should compute k-weighted anchorMedianLag and adjust ages', () => {
      // Cohorts with anchor lag data (downstream edge)
      const cohorts: CohortData[] = [
        { date: '1-Nov-25', n: 100, k: 40, age: 39, median_lag_days: 6, anchor_median_lag_days: 12 },
        { date: '2-Nov-25', n: 100, k: 42, age: 38, median_lag_days: 6, anchor_median_lag_days: 11 },
        { date: '3-Nov-25', n: 100, k: 38, age: 37, median_lag_days: 6, anchor_median_lag_days: 13 },
      ];

      // k-weighted avg anchor lag = (40*12 + 42*11 + 38*13) / 120 = 11.93
      const expectedAnchorLag = (40 * 12 + 42 * 11 + 38 * 13) / 120;

      const stats = computeEdgeLatencyStats(
        cohorts,
        6,      // aggregateMedianLag
        7,      // aggregateMeanLag
        30,     // fallbackT95Days
        expectedAnchorLag  // Should be computed internally from cohorts, but we pass for verification
      );

      // Effective ages should be reduced by anchor lag
      // Original ages: 39, 38, 37 → After anchor adjustment: ~27, ~26, ~24
      // With effective ages in the 24-27 day range and t95 ~12 days, completeness should be high
      expect(stats.completeness).toBeGreaterThan(0.8);
    });

    it('should use anchorMedianLag=0 when no anchor data present (first edge)', () => {
      // First latency edge - no upstream anchor lag
      const cohorts: CohortData[] = [
        { date: '1-Nov-25', n: 100, k: 40, age: 20, median_lag_days: 3 },
        { date: '2-Nov-25', n: 100, k: 42, age: 19, median_lag_days: 3 },
        { date: '3-Nov-25', n: 100, k: 38, age: 18, median_lag_days: 3 },
      ];

      const stats = computeEdgeLatencyStats(
        cohorts,
        3,      // aggregateMedianLag
        3,      // aggregateMeanLag
        30,     // fallbackT95Days
        0       // anchorMedianLag = 0 (first edge)
      );

      // No age adjustment, ages 18-20 with short median lag → high completeness.
      // No authoritative edge t95 is provided here, so the tail constraint should not apply.
      expect(stats.completeness_cdf.tail_constraint_applied).toBe(false);
      expect(stats.completeness).toBeGreaterThan(0.85);
      expect(stats.completeness).toBeLessThanOrEqual(1);
    });
  });

  describe('End-to-end: param file → enhanceGraphLatencies → debug output', () => {
    it('should include anchor lag in debug output for session log visibility', () => {
      // Create a graph with a downstream edge
      const graph: GraphForPath = {
        nodes: [
          { id: 'A', type: 'start' },
          { id: 'X' },
          { id: 'Y' },
        ],
        edges: [
          {
            id: 'e-a-x',
            uuid: 'e-a-x',
            from: 'A',
            to: 'X',
            p: {
              mean: 0.5,
              latency: { latency_parameter: true, t95: 30 },
            },
          },
          {
            id: 'e-x-y',
            uuid: 'e-x-y',
            from: 'X',
            to: 'Y',
            p: {
              mean: 0.4,
              latency: { latency_parameter: true, t95: 30 },
              evidence: { mean: 0.35, n: 300, k: 105 },
            },
          },
        ],
      };

      // Cohort slice for X→Y with anchor lag (A→X upstream lag)
      const xySlice: ParameterValueForLAG = {
        sliceDSL: 'cohort(household-created,1-Nov-25:3-Nov-25)',
        dates: ['1-Nov-25', '2-Nov-25', '3-Nov-25'],
        n: 300,
        k: 105,
        n_daily: [100, 100, 100],
        k_daily: [35, 37, 33],
        median_lag_days: [6, 6, 6],
        mean_lag_days: [7, 7, 7],
        anchor_median_lag_days: [12, 11, 13],  // A→X upstream lag
        mean: 0.35,
        data_source: { retrieved_at: '2025-12-10T00:00:00Z', type: 'amplitude' },
      } as ParameterValueForLAG;

      // Empty A→X edge data (first edge, no anchor lag)
      const axSlice = createCohortSlice(
        ['1-Nov-25', '2-Nov-25', '3-Nov-25'],
        [200, 210, 195],
        [100, 105, 97],
        [3, 3, 3]  // Short lag for first edge
      );

      const paramLookup = new Map<string, ParameterValueForLAG[]>();
      paramLookup.set('e-a-x', [axSlice]);
      paramLookup.set('e-x-y', [xySlice]);

      const queryDate = new Date('2025-12-10');
      const cohortWindow = {
        start: new Date('2025-11-01'),
        end: new Date('2025-11-03'),
      };

      const result = enhanceGraphLatencies(
        graph,
        paramLookup,
        queryDate,
        helpers,
        cohortWindow
      );

      // Find the X→Y edge result
      const xyResult = result.edgeValues.find(v => v.edgeUuid === 'e-x-y');
      expect(xyResult).toBeDefined();

      // Verify debug output includes anchor lag info
      expect(xyResult!.debug).toBeDefined();
      expect(xyResult!.debug!.anchorMedianLag).toBeGreaterThan(0);
      expect(xyResult!.debug!.cohortsWithAnchorLag).toBe(3);

      // Sample cohorts should include per-cohort anchor lag
      expect(xyResult!.debug!.sampleCohorts[0].anchorLag).toBeDefined();
      expect(xyResult!.debug!.sampleCohorts[0].anchorLag).toBeCloseTo(12, 0);
    });

    it('should flag missing anchor data in debug output', () => {
      const graph: GraphForPath = {
        nodes: [
          { id: 'A', type: 'start' },
          { id: 'B' },
        ],
        edges: [
          {
            id: 'e1',
            uuid: 'e1',
            from: 'A',
            to: 'B',
            p: {
              mean: 0.5,
              latency: { latency_parameter: true, t95: 30 },
            },
          },
        ],
      };

      // Legacy cohort slice WITHOUT anchor lag data
      const legacySlice = createCohortSlice(
        ['1-Nov-25', '2-Nov-25', '3-Nov-25'],
        [100, 100, 100],
        [50, 52, 48],
        [3, 3, 3]
      );

      const paramLookup = new Map<string, ParameterValueForLAG[]>();
      paramLookup.set('e1', [legacySlice]);

      const queryDate = new Date('2025-12-10');
      const cohortWindow = {
        start: new Date('2025-11-01'),
        end: new Date('2025-11-03'),
      };

      const result = enhanceGraphLatencies(
        graph,
        paramLookup,
        queryDate,
        helpers,
        cohortWindow
      );

      const e1Result = result.edgeValues.find(v => v.edgeUuid === 'e1');
      expect(e1Result).toBeDefined();

      // Debug should show no anchor data
      expect(e1Result!.debug!.anchorMedianLag).toBe(0);
      expect(e1Result!.debug!.cohortsWithAnchorLag).toBe(0);

      // Sample cohorts should have undefined anchor lag
      expect(e1Result!.debug!.sampleCohorts[0].anchorLag).toBeUndefined();
    });
  });
});

describe('LAG Mathematical Functions', () => {
  describe('logNormalCDF', () => {
    it('should return 0 for age = 0', () => {
      // CDF(0) = 0 for any lognormal distribution
      expect(logNormalCDF(0, 1, 0.5)).toBe(0);
    });
    
    it('should return ~0.5 at the median', () => {
      // For lognormal, median = exp(mu)
      // If mu = ln(5) ≈ 1.61, median = 5
      const mu = Math.log(5);
      expect(logNormalCDF(5, mu, 0.5)).toBeCloseTo(0.5, 1);
    });
    
    it('should approach 1 for very large ages', () => {
      expect(logNormalCDF(1000, 1, 0.5)).toBeGreaterThan(0.99);
    });
  });
  
  describe('fitLagDistribution', () => {
    it('should compute mu from median lag', () => {
      // mu = ln(median)
      const fit = fitLagDistribution(5, 6, 100);
      expect(fit.mu).toBeCloseTo(Math.log(5), 2);
    });
    
    it('should use default sigma for low k', () => {
      const fit = fitLagDistribution(5, 6, 10);  // Low k
      expect(fit.sigma).toBe(0.5);  // Default
      expect(fit.empirical_quality_ok).toBe(false);
    });
    
    it('should compute empirical sigma for high k', () => {
      // sigma = sqrt(2 * (ln(mean) - ln(median))) when mean > median
      const fit = fitLagDistribution(5, 7, 500);  // High k, mean > median
      expect(fit.empirical_quality_ok).toBe(true);
      // sigma should be computed from mean/median ratio
    });
  });
});

/**
 * T6: Scenario-Aware Active Edges (B3 fix validation)
 * 
 * Design (§11.5 in schematic):
 *   - getActiveEdges() should respect whatIfDSL
 *   - Edges with effective probability = 0 under a scenario should be excluded
 *   - This affects path_t95 computation and LAG calculations
 */
describe('Phase 3 – Scenario-Aware Active Edges (B3)', () => {
  describe('getActiveEdges with scenario', () => {
    it('should include all edges when no scenario is applied', () => {
      const graph: GraphForPath = {
        nodes: [
          { id: 'A', type: 'state' },
          { id: 'B', type: 'state' },
          { id: 'C', type: 'state' },
        ],
        edges: [
          { id: 'e1', from: 'A', to: 'B', p: { mean: 0.5 } },
          { id: 'e2', from: 'A', to: 'C', p: { mean: 0.5 } },
        ],
      };
      
      const activeEdges = getActiveEdges(graph);
      
      expect(activeEdges.size).toBe(2);
      expect(activeEdges.has('e1')).toBe(true);
      expect(activeEdges.has('e2')).toBe(true);
    });
    
    it('should exclude edges with zero probability', () => {
      const graph: GraphForPath = {
        nodes: [
          { id: 'A', type: 'state' },
          { id: 'B', type: 'state' },
          { id: 'C', type: 'state' },
        ],
        edges: [
          { id: 'e1', from: 'A', to: 'B', p: { mean: 0.5 } },
          { id: 'e2', from: 'A', to: 'C', p: { mean: 0 } },  // Zero prob
        ],
      };
      
      const activeEdges = getActiveEdges(graph);
      
      expect(activeEdges.size).toBe(1);
      expect(activeEdges.has('e1')).toBe(true);
      expect(activeEdges.has('e2')).toBe(false);  // Excluded
    });
    
    it('should respect epsilon threshold', () => {
      const graph: GraphForPath = {
        nodes: [
          { id: 'A', type: 'state' },
          { id: 'B', type: 'state' },
        ],
        edges: [
          { id: 'e1', from: 'A', to: 'B', p: { mean: 1e-10 } },  // Below default epsilon
        ],
      };
      
      // Default epsilon is 1e-9
      const activeEdges = getActiveEdges(graph);
      expect(activeEdges.size).toBe(0);  // 1e-10 < 1e-9
      
      // Custom lower epsilon
      const activeEdgesCustom = getActiveEdges(graph, undefined, 1e-12);
      expect(activeEdgesCustom.size).toBe(1);  // 1e-10 > 1e-12
    });
  });

  // ============================================================================
  // §0.3: onset_delta_days Flow Through LAG Pass
  // ============================================================================
  
  describe('onset_delta_days Through LAG Pass (§0.3)', () => {
    const helpers = createLAGHelpers();
    
    /**
     * Helper to create a window slice with onset_delta_days
     */
    function createWindowSliceWithOnset(
      dateRange: string,
      n: number,
      k: number,
      forecast: number,
      onsetDeltaDays: number,
      datesWeight: number = 1
    ): ParameterValueForLAG {
      return {
        sliceDSL: `window(${dateRange})`,
        n,
        k,
        mean: k / n,
        forecast,
        dates: Array.from({ length: Math.max(0, datesWeight) }, () => '1-Nov-25'),
        latency: {
          onset_delta_days: onsetDeltaDays,
        },
        data_source: { retrieved_at: '2025-12-10T00:00:00Z', type: 'test' },
      } as ParameterValueForLAG;
    }
    
    it('includes onset_delta_days in EdgeLAGValues output (single window slice)', () => {
      const graph: GraphForPath = {
        nodes: [
          { id: 'A', type: 'start' },
          { id: 'B', type: 'end' },
        ],
        edges: [
          {
            id: 'e1', uuid: 'e1', from: 'A', to: 'B',
            p: {
              mean: 0.5,
              latency: { latency_parameter: true },
              forecast: { mean: 0.5 },
              evidence: { mean: 0.5, n: 1000, k: 500 },
            },
          },
        ],
      };
      
      const dates = ['20-Nov-25', '21-Nov-25', '22-Nov-25', '23-Nov-25', '24-Nov-25'];
      
      const paramLookup = new Map();
      paramLookup.set('e1', [
        createCohortSlice(dates, [200, 200, 200, 200, 200], [100, 100, 100, 100, 100], [5, 5, 5, 5, 5]),
        createWindowSliceWithOnset('1-Nov-25:19-Nov-25', 1100, 550, 0.50, 3, 19), // onset = 3 days (19d weight)
      ]);
      
      const queryDate = new Date('2025-11-24');
      const cohortWindow = {
        start: new Date('2025-11-20'),
        end: new Date('2025-11-24'),
      };
      
      const result = enhanceGraphLatencies(
        graph,
        paramLookup,
        queryDate,
        helpers,
        cohortWindow
      );
      
      expect(result.edgesWithLAG).toBe(1);
      expect(result.edgeValues.length).toBe(1);
      
      const e1Result = result.edgeValues.find(v => v.edgeUuid === 'e1');
      expect(e1Result).toBeDefined();
      
      // §0.3: onset_delta_days should be extracted from window slice and included in EdgeLAGValues
      expect(e1Result!.latency.onset_delta_days).toBe(3);
    });

    it('t95 and path_t95 are inclusive of onset (user-space horizons)', () => {
      const helpers = createLAGHelpers();

      const makeGraph = (): GraphForPath => ({
        nodes: [
          { id: 'A', type: 'start' },
          { id: 'B', type: 'end' },
        ],
        edges: [
          {
            id: 'e1', uuid: 'e1', from: 'A', to: 'B',
            p: {
              mean: 0.5,
              latency: { latency_parameter: true },
              forecast: { mean: 0.5 },
              evidence: { mean: 0.5, n: 1000, k: 500 },
            },
          },
        ],
      });

      const dates = ['20-Nov-25', '21-Nov-25', '22-Nov-25', '23-Nov-25', '24-Nov-25'];
      const queryDate = new Date('2025-11-24');
      const cohortWindow = {
        start: new Date('2025-11-20'),
        end: new Date('2025-11-24'),
      };

      // Case A: onset = 0, user-space median lag = 5
      const paramLookupA = new Map();
      paramLookupA.set('e1', [
        createCohortSlice(dates, [200, 200, 200, 200, 200], [100, 100, 100, 100, 100], [5, 5, 5, 5, 5]),
        createWindowSliceWithOnset('1-Nov-25:19-Nov-25', 1100, 550, 0.50, 0, 19),
      ]);
      const resultA = enhanceGraphLatencies(makeGraph(), paramLookupA, queryDate, helpers, cohortWindow);
      const e1A = resultA.edgeValues.find(v => v.edgeUuid === 'e1');
      expect(e1A).toBeDefined();
      expect(e1A!.latency.onset_delta_days).toBe(0);

      // Case B: onset = 3, but keep model-space distribution fixed by shifting user-space median lag by +3.
      const paramLookupB = new Map();
      paramLookupB.set('e1', [
        createCohortSlice(dates, [200, 200, 200, 200, 200], [100, 100, 100, 100, 100], [8, 8, 8, 8, 8]),
        createWindowSliceWithOnset('1-Nov-25:19-Nov-25', 1100, 550, 0.50, 3, 19),
      ]);
      const resultB = enhanceGraphLatencies(makeGraph(), paramLookupB, queryDate, helpers, cohortWindow);
      const e1B = resultB.edgeValues.find(v => v.edgeUuid === 'e1');
      expect(e1B).toBeDefined();
      expect(e1B!.latency.onset_delta_days).toBe(3);

      // t95 and path_t95 are stored/displayed in user-space (T-space), so they must increase by δ.
      expect(e1B!.latency.t95).toBeCloseTo(e1A!.latency.t95 + 3, 6);
      expect(e1B!.latency.path_t95).toBeCloseTo(e1A!.latency.path_t95 + 3, 6);
    });
    
    it('aggregates onset_delta_days via weighted β-quantile across window slices (weighted by dates.length)', () => {
      const graph: GraphForPath = {
        nodes: [
          { id: 'A', type: 'start' },
          { id: 'B', type: 'end' },
        ],
        edges: [
          {
            id: 'e1', uuid: 'e1', from: 'A', to: 'B',
            p: {
              mean: 0.5,
              latency: { latency_parameter: true },
              forecast: { mean: 0.5 },
              evidence: { mean: 0.5, n: 1000, k: 500 },
            },
          },
        ],
      };
      
      const dates = ['20-Nov-25', '21-Nov-25', '22-Nov-25', '23-Nov-25', '24-Nov-25'];
      
      // Helper for contexted window slices with onset
      function createContextedWindowSliceWithOnset(
        dateRange: string,
        context: string,
        n: number,
        k: number,
        forecast: number,
        onsetDeltaDays: number,
        datesWeight: number
      ): ParameterValueForLAG {
        return {
          sliceDSL: `window(${dateRange}).context(${context})`,
          n,
          k,
          mean: k / n,
          forecast,
          dates: Array.from({ length: Math.max(0, datesWeight) }, () => '1-Nov-25'),
          latency: { onset_delta_days: onsetDeltaDays },
          data_source: { retrieved_at: '2025-12-10T00:00:00Z', type: 'test' },
        } as ParameterValueForLAG;
      }
      
      // Two contexted window slices with different onsets.
      // Default β is 0.5 (weighted median). Weight uses number of dates in each window series.
      const paramLookup = new Map();
      paramLookup.set('e1', [
        createCohortSlice(dates, [200, 200, 200, 200, 200], [100, 100, 100, 100, 100], [5, 5, 5, 5, 5]),
        createContextedWindowSliceWithOnset('1-Nov-25:10-Nov-25', 'channel:google', 500, 250, 0.50, 5, 100), // onset = 5 (dominant weight)
        createContextedWindowSliceWithOnset('11-Nov-25:19-Nov-25', 'channel:paid', 600, 300, 0.50, 2, 1),     // onset = 2 (tiny weight)
      ]);
      
      const queryDate = new Date('2025-11-24');
      const cohortWindow = {
        start: new Date('2025-11-20'),
        end: new Date('2025-11-24'),
      };
      
      const result = enhanceGraphLatencies(
        graph,
        paramLookup,
        queryDate,
        helpers,
        cohortWindow
      );
      
      const e1Result = result.edgeValues.find(v => v.edgeUuid === 'e1');
      expect(e1Result).toBeDefined();
      
      // §0.3: Weighted median should select the dominant slice onset (5), not the min (2).
      expect(e1Result!.latency.onset_delta_days).toBe(5);

      // And ensure that this min() result is what is written onto the graph edge
      // (this is what the frontend UI reads: edge.p.latency.onset_delta_days).
      const um = new UpdateManager();
      const nextGraph = um.applyBatchLAGValues(
        graph as any,
        result.edgeValues.map((ev) => ({
          edgeId: ev.edgeUuid,
          conditionalIndex: ev.conditionalIndex,
          latency: ev.latency as any,
          blendedMean: ev.blendedMean,
          forecast: ev.forecast,
          evidence: ev.evidence,
        })),
        { writeHorizonsToGraph: true }
      );
      const e1 = (nextGraph as any).edges.find((e: any) => e.uuid === 'e1' || e.id === 'e1');
      expect(e1?.p?.latency?.onset_delta_days).toBe(5);
    });
    
    it('does not blindly prefer uncontexted slices; weighting by window date-count controls aggregation', () => {
      const graph: GraphForPath = {
        nodes: [
          { id: 'A', type: 'start' },
          { id: 'B', type: 'end' },
        ],
        edges: [
          {
            id: 'e1', uuid: 'e1', from: 'A', to: 'B',
            p: {
              mean: 0.5,
              latency: { latency_parameter: true },
              forecast: { mean: 0.5 },
              evidence: { mean: 0.5, n: 1000, k: 500 },
            },
          },
        ],
      };
      
      const dates = ['20-Nov-25', '21-Nov-25', '22-Nov-25', '23-Nov-25', '24-Nov-25'];
      
      function createContextedWindowSliceWithOnset(
        dateRange: string,
        context: string,
        n: number,
        k: number,
        forecast: number,
        onsetDeltaDays: number,
        datesWeight: number
      ): ParameterValueForLAG {
        return {
          sliceDSL: `window(${dateRange}).context(${context})`,
          n,
          k,
          mean: k / n,
          forecast,
          dates: Array.from({ length: Math.max(0, datesWeight) }, () => '1-Nov-25'),
          latency: { onset_delta_days: onsetDeltaDays },
          data_source: { retrieved_at: '2025-12-10T00:00:00Z', type: 'test' },
        } as ParameterValueForLAG;
      }
      
      // Mix of uncontexted and contexted slices
      const paramLookup = new Map();
      paramLookup.set('e1', [
        createCohortSlice(dates, [200, 200, 200, 200, 200], [100, 100, 100, 100, 100], [5, 5, 5, 5, 5]),
        createWindowSliceWithOnset('1-Nov-25:19-Nov-25', 1100, 550, 0.50, 4, 100), // onset = 4 (dominant weight)
        createContextedWindowSliceWithOnset('1-Nov-25:10-Nov-25', 'channel:google', 500, 250, 0.50, 1, 1), // onset = 1 (tiny weight)
      ]);
      
      const queryDate = new Date('2025-11-24');
      const cohortWindow = {
        start: new Date('2025-11-20'),
        end: new Date('2025-11-24'),
      };
      
      const result = enhanceGraphLatencies(
        graph,
        paramLookup,
        queryDate,
        helpers,
        cohortWindow
      );
      
      const e1Result = result.edgeValues.find(v => v.edgeUuid === 'e1');
      expect(e1Result).toBeDefined();
      
      // §0.3: Weighted median should select the dominant-weight slice onset (4).
      expect(e1Result!.latency.onset_delta_days).toBe(4);
    });
  });
});

