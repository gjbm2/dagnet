/**
 * StatisticalEnhancementService Unit Tests
 * 
 * Tests the statistical enhancement service including:
 * - Basic enhancers (NoOp, inverse-variance)
 * - LAG (Latency-Aware Graph) functions
 * 
 * @vitest-environment node
 */

import { describe, it, expect, vi } from 'vitest';
import {
  statisticalEnhancementService,
  NoOpEnhancer,
  // LAG functions
  erf,
  standardNormalCDF,
  standardNormalInverseCDF,
  logNormalCDF,
  logNormalSurvival,
  logNormalInverseCDF,
  fitLagDistribution,
  computeT95,
  estimatePInfinity,
  calculateCompleteness,
  computeEdgeLatencyStats,
  // Inbound-N functions
  computeInboundN,
  applyInboundNToGraph,
  getActiveEdges,
  // Graph-level LAG enhancement
  enhanceGraphLatencies,
  // LAG types
  type CohortData,
  type LagDistributionFit,
  type GraphForInboundN,
  type InboundNResult,
  type LAGHelpers,
  type ParameterValueForLAG,
  type GraphForPath,
} from '../statisticalEnhancementService';
import type { RawAggregation } from '../windowAggregationService';
import type { DateRange } from '../../types';
import {
  LATENCY_MIN_FIT_CONVERTERS,
  LATENCY_DEFAULT_SIGMA,
  LATENCY_T95_PERCENTILE,
  RECENCY_HALF_LIFE_DAYS,
} from '../../constants/latency';

describe('StatisticalEnhancementService', () => {
  const createMockRawAggregation = (
    n: number = 1000,
    k: number = 300
  ): RawAggregation => ({
    method: 'naive',
    n,
    k,
    mean: k / n,
    stdev: Math.sqrt((k / n) * (1 - k / n) / n),
    raw_data: [],
    window: { start: '2024-11-01', end: '2024-11-07' } as DateRange,
    days_included: 7,
    days_missing: 0,
    missing_dates: [],
    gaps: [],
    missing_at_start: false,
    missing_at_end: false,
    has_middle_gaps: false,
  });

  describe('NoOpEnhancer', () => {
    it('should pass through raw aggregation unchanged', () => {
      const enhancer = new NoOpEnhancer();
      const raw: RawAggregation = createMockRawAggregation(1000, 300);

      const result = enhancer.enhance(raw);

      expect(result.method).toBe('naive');
      expect(result.n).toBe(1000);
      expect(result.k).toBe(300);
      expect(result.mean).toBeCloseTo(0.3, 10);
      expect(result.stdev).toBeCloseTo(raw.stdev, 5);
      expect(result.confidence_interval).toBeNull();
      expect(result.trend).toBeNull();
      expect(result.metadata.raw_method).toBe('naive');
      expect(result.metadata.enhancement_method).toBe('none');
      expect(result.metadata.data_points).toBe(7);
    });

    it('should preserve all raw values exactly', () => {
      const enhancer = new NoOpEnhancer();
      const raw: RawAggregation = {
        method: 'naive',
        n: 5000,
        k: 1750,
        mean: 0.35,
        stdev: 0.0067,
        raw_data: [
          { date: '2024-11-01', n: 1000, k: 350, p: 0.35 },
          { date: '2024-11-02', n: 1000, k: 350, p: 0.35 },
        ],
        window: { start: '2024-11-01', end: '2024-11-02' } as DateRange,
        days_included: 2,
        days_missing: 0,
        missing_dates: [],
        gaps: [],
        missing_at_start: false,
        missing_at_end: false,
        has_middle_gaps: false,
      };

      const result = enhancer.enhance(raw);

      expect(result.n).toBe(5000);
      expect(result.k).toBe(1750);
      expect(result.mean).toBe(0.35);
      expect(result.stdev).toBe(0.0067);
    });
  });

  describe('StatisticalEnhancementService', () => {
    it('should enhance with default "inverse-variance" method', async () => {
      const raw: RawAggregation = createMockRawAggregation(1000, 300);

      const result = await statisticalEnhancementService.enhance(raw);

      expect(result.method).toBe('inverse-variance');
      expect(result.n).toBe(1000);
      expect(result.k).toBe(300);
      expect(result.mean).toBeCloseTo(0.3, 10);
      expect(result.metadata.enhancement_method).toBe('inverse-variance');
    });

    it('should enhance with explicit "none" method', async () => {
      const raw: RawAggregation = createMockRawAggregation(1000, 300);

      const result = await statisticalEnhancementService.enhance(raw, 'none');

      expect(result.method).toBe('naive');
      expect(result.n).toBe(1000);
      expect(result.k).toBe(300);
      expect(result.metadata.enhancement_method).toBe('none');
    });

    it('should fallback to "none" for unknown method (non-Python)', async () => {
      const raw: RawAggregation = createMockRawAggregation(1000, 300);
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Use a method that doesn't exist and isn't a Python method
      const result = await statisticalEnhancementService.enhance(raw, 'unknown-method' as any);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unknown enhancement method: unknown-method')
      );
      expect(result.method).toBe('naive');
      expect(result.n).toBe(1000);
      expect(result.metadata.enhancement_method).toBe('none');

      consoleSpy.mockRestore();
    });

    it('should register and use custom enhancer', async () => {
      const customEnhancer = {
        enhance(raw: RawAggregation) {
          return {
            method: 'custom',
            n: raw.n,
            k: raw.k,
            mean: raw.mean,
            stdev: raw.stdev,
            confidence_interval: [0.25, 0.35] as [number, number],
            trend: null,
            metadata: {
              raw_method: raw.method,
              enhancement_method: 'custom',
              data_points: raw.days_included,
            },
          };
        },
      };

      statisticalEnhancementService.registerEnhancer('custom', customEnhancer);

      const raw: RawAggregation = createMockRawAggregation(1000, 300);
      const result = await statisticalEnhancementService.enhance(raw, 'custom');

      expect(result.method).toBe('custom');
      expect(result.confidence_interval).toEqual([0.25, 0.35]);
      expect(result.metadata.enhancement_method).toBe('custom');
    });

    it('should handle edge case: zero conversions', async () => {
      const raw: RawAggregation = createMockRawAggregation(1000, 0);

      const result = await statisticalEnhancementService.enhance(raw);

      expect(result.n).toBe(1000);
      expect(result.k).toBe(0);
      expect(result.mean).toBe(0);
      expect(result.stdev).toBe(0);
    });

    it('should handle edge case: perfect conversion rate', async () => {
      const raw: RawAggregation = createMockRawAggregation(1000, 1000);

      const result = await statisticalEnhancementService.enhance(raw);

      expect(result.n).toBe(1000);
      expect(result.k).toBe(1000);
      expect(result.mean).toBe(1);
      expect(result.stdev).toBe(0);
    });

    it('should preserve days_included in metadata', async () => {
      const raw: RawAggregation = {
        method: 'naive',
        n: 5000,
        k: 1500,
        mean: 0.3,
        stdev: 0.0065,
        raw_data: [],
        window: { start: '2024-11-01', end: '2024-11-10' } as DateRange,
        days_included: 10,
        days_missing: 0,
        missing_dates: [],
        gaps: [],
        missing_at_start: false,
        missing_at_end: false,
        has_middle_gaps: false,
      };

      const result = await statisticalEnhancementService.enhance(raw);

      expect(result.metadata.data_points).toBe(10);
    });

    it('should use simple mean (k/n) and preserve k as actual observed count', async () => {
      // This test validates two critical fixes:
      // 1. k must be preserved as the actual observed success count, not derived from any estimate
      // 2. mean must be the simple mean (k/n), not a weighted mean that can be distorted
      //
      // Background: Inverse-variance weighting was causing issues because:
      // - Days with p=0 (weekends, data lag) aren't "estimates of 0%" - they're outliers
      // - These days got massive weight: n/0.01 = 100×n when p=0
      // - This distorted the weighted mean (e.g., actual 56% → weighted 16%)
      //
      // FIX: Use simple mean (k/n) which is the CORRECT observed conversion rate
      const raw: RawAggregation = {
        method: 'naive',
        n: 645,
        k: 361,
        mean: 361 / 645, // 0.5596...
        stdev: Math.sqrt((361/645) * (1 - 361/645) / 645),
        raw_data: [
          // High volume days with LOW conversion (would have dominated weighted average)
          { date: '2024-11-01', n: 83, k: 0, p: 0 },
          { date: '2024-11-02', n: 52, k: 40, p: 0.769 },
          { date: '2024-11-03', n: 47, k: 35, p: 0.745 },
          { date: '2024-11-04', n: 41, k: 33, p: 0.805 },
          { date: '2024-11-05', n: 40, k: 27, p: 0.675 },
          { date: '2024-11-06', n: 38, k: 4, p: 0.105 },  // Low conversion
          { date: '2024-11-07', n: 36, k: 28, p: 0.778 },
          { date: '2024-11-08', n: 33, k: 25, p: 0.758 },
          { date: '2024-11-09', n: 32, k: 30, p: 0.938 },
          { date: '2024-11-10', n: 32, k: 15, p: 0.469 },
          // More days...
          { date: '2024-11-11', n: 28, k: 0, p: 0 },
          { date: '2024-11-12', n: 25, k: 18, p: 0.72 },
          { date: '2024-11-13', n: 25, k: 17, p: 0.68 },
          { date: '2024-11-14', n: 23, k: 22, p: 0.957 },
          { date: '2024-11-15', n: 22, k: 16, p: 0.727 },
          { date: '2024-11-16', n: 20, k: 16, p: 0.8 },
          { date: '2024-11-17', n: 19, k: 13, p: 0.684 },
          { date: '2024-11-18', n: 18, k: 0, p: 0 },
          { date: '2024-11-19', n: 17, k: 11, p: 0.647 },
          { date: '2024-11-20', n: 14, k: 11, p: 0.786 },
        ],
        window: { start: '2024-11-01', end: '2024-11-20' } as DateRange,
        days_included: 20,
        days_missing: 0,
        missing_dates: [],
        gaps: [],
        missing_at_start: false,
        missing_at_end: false,
        has_middle_gaps: false,
      };

      const result = await statisticalEnhancementService.enhance(raw);

      // CRITICAL: k must be the actual observed count (361), NOT derived from any estimate
      expect(result.k).toBe(361);
      expect(result.n).toBe(645);
      
      // CRITICAL: mean must be the simple mean (k/n), NOT a weighted mean
      // Simple mean: 361/645 = 0.5596... ≈ 0.56 (rounded to 3 decimal places)
      expect(result.mean).toBeCloseTo(0.56, 2);
      
      // Verify k was NOT recalculated from mean (k should equal mean * n since mean = k/n)
      expect(result.k).toBe(Math.round(result.mean * result.n));
    });
  });
});

// =============================================================================
// LAG (Latency-Aware Graph) Function Tests
// Design reference: design.md §5.3-5.6
// =============================================================================

describe('LAG Mathematical Utility Functions', () => {
  describe('erf (error function)', () => {
    it('should return 0 for input 0', () => {
      expect(erf(0)).toBeCloseTo(0, 6); // erf(0) = 0 within numerical precision
    });

    it('should return approx 0.8427 for input 1', () => {
      expect(erf(1)).toBeCloseTo(0.8427, 4);
    });

    it('should return approx -0.8427 for input -1', () => {
      expect(erf(-1)).toBeCloseTo(-0.8427, 4);
    });

    it('should approach 1 for large positive inputs', () => {
      expect(erf(3)).toBeCloseTo(0.9999779, 5);
    });

    it('should approach -1 for large negative inputs', () => {
      expect(erf(-3)).toBeCloseTo(-0.9999779, 5);
    });

    it('should be an odd function: erf(-x) = -erf(x)', () => {
      expect(erf(-2)).toBeCloseTo(-erf(2), 6);
      expect(erf(-0.5)).toBeCloseTo(-erf(0.5), 6);
    });
  });

  describe('standardNormalCDF (Φ)', () => {
    it('should return 0.5 for input 0', () => {
      expect(standardNormalCDF(0)).toBeCloseTo(0.5, 6); // Φ(0) = 0.5 within numerical precision
    });

    it('should return approx 0.8413 for input 1', () => {
      expect(standardNormalCDF(1)).toBeCloseTo(0.8413, 4);
    });

    it('should return approx 0.1587 for input -1', () => {
      expect(standardNormalCDF(-1)).toBeCloseTo(0.1587, 4);
    });

    it('should return approx 0.9772 for input 2', () => {
      expect(standardNormalCDF(2)).toBeCloseTo(0.9772, 4);
    });

    it('should return approx 0.9987 for input 3', () => {
      expect(standardNormalCDF(3)).toBeCloseTo(0.9987, 4);
    });

    it('should be bounded in [0, 1]', () => {
      expect(standardNormalCDF(-10)).toBeGreaterThanOrEqual(0);
      expect(standardNormalCDF(-10)).toBeLessThan(0.001);
      expect(standardNormalCDF(10)).toBeLessThanOrEqual(1);
      expect(standardNormalCDF(10)).toBeGreaterThan(0.999);
    });
  });

  describe('standardNormalInverseCDF (Φ⁻¹)', () => {
    it('should return 0 for input 0.5', () => {
      expect(standardNormalInverseCDF(0.5)).toBeCloseTo(0, 6); // Φ⁻¹(0.5) = 0
    });

    it('should return approx 1 for input 0.8413', () => {
      expect(standardNormalInverseCDF(0.8413)).toBeCloseTo(1, 2);
    });

    it('should return approx -1 for input 0.1587', () => {
      expect(standardNormalInverseCDF(0.1587)).toBeCloseTo(-1, 2);
    });

    it('should be inverse of standardNormalCDF', () => {
      // Φ⁻¹(Φ(x)) = x
      for (const x of [-2, -1, -0.5, 0, 0.5, 1, 2]) {
        const p = standardNormalCDF(x);
        expect(standardNormalInverseCDF(p)).toBeCloseTo(x, 4);
      }
    });

    it('should handle edge cases', () => {
      expect(standardNormalInverseCDF(0)).toBe(-Infinity);
      expect(standardNormalInverseCDF(1)).toBe(Infinity);
    });
  });
});

describe('LAG Log-Normal Distribution Functions', () => {
  // Example: median = 5 days, mean = 7 days
  // mu = ln(5) ≈ 1.609
  // mean/median = 1.4, σ = sqrt(2 * ln(1.4)) ≈ 0.82
  const mu = Math.log(5);
  const sigma = Math.sqrt(2 * Math.log(7 / 5));

  describe('logNormalCDF', () => {
    it('should return 0 for t <= 0', () => {
      expect(logNormalCDF(0, mu, sigma)).toBe(0);
      expect(logNormalCDF(-1, mu, sigma)).toBe(0);
    });

    it('should return 0.5 at the median (exp(mu))', () => {
      const median = Math.exp(mu); // 5
      expect(logNormalCDF(median, mu, sigma)).toBeCloseTo(0.5, 4);
    });

    it('should approach 1 for large t', () => {
      expect(logNormalCDF(100, mu, sigma)).toBeGreaterThan(0.99);
    });

    it('should be monotonically increasing', () => {
      const values = [1, 2, 5, 10, 20];
      let prev = 0;
      for (const t of values) {
        const F = logNormalCDF(t, mu, sigma);
        expect(F).toBeGreaterThan(prev);
        prev = F;
      }
    });

    it('should handle degenerate case (sigma = 0)', () => {
      // All mass at median
      const median = Math.exp(mu);
      expect(logNormalCDF(median - 0.1, mu, 0)).toBe(0);
      expect(logNormalCDF(median, mu, 0)).toBe(1);
      expect(logNormalCDF(median + 0.1, mu, 0)).toBe(1);
    });
  });

  describe('logNormalSurvival', () => {
    it('should equal 1 - CDF', () => {
      const t = 7;
      expect(logNormalSurvival(t, mu, sigma)).toBeCloseTo(
        1 - logNormalCDF(t, mu, sigma),
        10
      );
    });

    it('should return 0.5 at the median', () => {
      const median = Math.exp(mu);
      expect(logNormalSurvival(median, mu, sigma)).toBeCloseTo(0.5, 4);
    });
  });

  describe('logNormalInverseCDF', () => {
    it('should return 0 for p <= 0', () => {
      expect(logNormalInverseCDF(0, mu, sigma)).toBe(0);
    });

    it('should return Infinity for p >= 1', () => {
      expect(logNormalInverseCDF(1, mu, sigma)).toBe(Infinity);
    });

    it('should return median for p = 0.5', () => {
      const median = Math.exp(mu);
      expect(logNormalInverseCDF(0.5, mu, sigma)).toBeCloseTo(median, 4);
    });

    it('should be inverse of logNormalCDF', () => {
      for (const t of [2, 5, 10, 20]) {
        const p = logNormalCDF(t, mu, sigma);
        expect(logNormalInverseCDF(p, mu, sigma)).toBeCloseTo(t, 3);
      }
    });
  });
});

describe('LAG Lag Distribution Fitting (§5.4)', () => {
  describe('fitLagDistribution', () => {
    it('should fit log-normal from median and mean', () => {
      // median = 5 days, mean = 7 days
      const fit = fitLagDistribution(5, 7, 100);

      expect(fit.mu).toBeCloseTo(Math.log(5), 6);
      expect(fit.sigma).toBeCloseTo(Math.sqrt(2 * Math.log(7 / 5)), 6);
      expect(fit.empirical_quality_ok).toBe(true);
      expect(fit.total_k).toBe(100);
    });

    it('should fail quality gate if k < minimum', () => {
      const fit = fitLagDistribution(5, 7, 20); // < 30

      expect(fit.empirical_quality_ok).toBe(false);
      expect(fit.quality_failure_reason).toContain('Insufficient converters');
      expect(fit.sigma).toBe(LATENCY_DEFAULT_SIGMA);
    });

    it('should use default sigma if mean not available', () => {
      const fit = fitLagDistribution(5, undefined, 100);

      expect(fit.mu).toBeCloseTo(Math.log(5), 6);
      expect(fit.sigma).toBe(LATENCY_DEFAULT_SIGMA);
      expect(fit.empirical_quality_ok).toBe(true);  // Allow fit with valid median
      expect(fit.quality_failure_reason).toContain('Mean lag not available');
    });

    it('should fall back to default sigma if mean/median ratio close to 1 but < 1 (low skew)', () => {
      // mean slightly less than median (ratio=0.95, >= 0.9): treat as low-skew data, allow to pass
      const fit = fitLagDistribution(10, 9.5, 100);

      expect(fit.empirical_quality_ok).toBe(true);
      expect(fit.sigma).toBe(LATENCY_DEFAULT_SIGMA);
      expect(fit.quality_failure_reason).toContain('< 1.0');
    });

    it('should fail quality gate if mean/median ratio too low (< 0.9)', () => {
      // mean much less than median (ratio=0.8, < 0.9): quality failure
      const fit = fitLagDistribution(10, 8, 100);

      expect(fit.empirical_quality_ok).toBe(false);
      expect(fit.sigma).toBe(LATENCY_DEFAULT_SIGMA);
      expect(fit.quality_failure_reason).toContain('ratio too low');
    });

    it('should fail quality gate if mean/median ratio > 3', () => {
      // Extremely skewed distribution
      const fit = fitLagDistribution(5, 20, 100);

      expect(fit.empirical_quality_ok).toBe(false);
      expect(fit.quality_failure_reason).toContain('ratio too high');
    });

    it('should handle zero median', () => {
      const fit = fitLagDistribution(0, 5, 100);

      expect(fit.empirical_quality_ok).toBe(false);
      expect(fit.quality_failure_reason).toContain('Invalid median');
    });

    it('should handle mean = median (σ = 0 case)', () => {
      // When mean = median, ratio = 1, ln(1) = 0, σ = 0
      const fit = fitLagDistribution(5, 5, 100);

      expect(fit.mu).toBeCloseTo(Math.log(5), 6);
      expect(fit.sigma).toBe(0);
      expect(fit.empirical_quality_ok).toBe(true);
    });
  });

  describe('computeT95', () => {
    it('should compute t95 from valid fit', () => {
      const fit: LagDistributionFit = {
        mu: Math.log(5),
        sigma: Math.sqrt(2 * Math.log(7 / 5)),
        empirical_quality_ok: true,
        total_k: 100,
      };

      const t95 = computeT95(fit, 30);

      // For median=5, mean=7: percentile should be meaningfully above the median.
      expect(t95).toBeGreaterThan(5);
      // Verify it's actually the configured percentile (not hard-coded 95%)
      expect(logNormalCDF(t95, fit.mu, fit.sigma)).toBeCloseTo(LATENCY_T95_PERCENTILE, 3);
    });

    it('should fall back to configured/default t95 when fit is not valid', () => {
      const fit: LagDistributionFit = {
        mu: Math.log(5),
        sigma: LATENCY_DEFAULT_SIGMA,
        empirical_quality_ok: false,
        total_k: 20,
      };

      const t95 = computeT95(fit, 30);

      expect(t95).toBe(30);
    });
  });
});

describe('LAG P-Infinity Estimation (§5.6, Appendix C.1)', () => {
  describe('estimatePInfinity', () => {
    it('should estimate from mature cohorts only with recency weighting', () => {
      const cohorts: CohortData[] = [
        { date: '1-Oct-25', n: 100, k: 60, age: 60 }, // mature (age > t95)
        { date: '15-Oct-25', n: 100, k: 55, age: 45 }, // mature
        { date: '1-Nov-25', n: 100, k: 40, age: 30 }, // mature (at boundary)
        { date: '15-Nov-25', n: 100, k: 20, age: 15 }, // immature
        { date: '1-Dec-25', n: 100, k: 5, age: 0 },   // brand new
      ];

      const t95 = 30; // Maturity threshold
      const pInf = estimatePInfinity(cohorts, t95);

      // Should use only first 3 cohorts (age >= 30) with recency weighting
      // DagNet uses true half-life semantics: w = exp(-ln(2) * age / H) = 2^(-age/H)
      //
      // IMPORTANT: RECENCY_HALF_LIFE_DAYS is a global constant; some test suites may mock it.
      // Compute the expected value from the runtime constant to make this test robust.
      const w = (age: number) => Math.exp(-Math.LN2 * age / RECENCY_HALF_LIFE_DAYS);
      const mature = cohorts.filter(c => c.age >= t95);
      const wk = mature.reduce((acc, c) => acc + (w(c.age) * c.k), 0);
      const wn = mature.reduce((acc, c) => acc + (w(c.age) * c.n), 0);
      const expected = wn > 0 ? (wk / wn) : undefined;
      // (Recency weighting favours the younger cohort with lower conversion)
      expect(expected).toBeDefined();
      expect(pInf).toBeCloseTo(expected as number, 6);
    });

    it('should return undefined if no mature cohorts', () => {
      const cohorts: CohortData[] = [
        { date: '15-Nov-25', n: 100, k: 20, age: 15 },
        { date: '1-Dec-25', n: 100, k: 5, age: 0 },
      ];

      const pInf = estimatePInfinity(cohorts, 30);

      expect(pInf).toBeUndefined();
    });

    it('should handle empty cohorts', () => {
      const pInf = estimatePInfinity([], 30);
      expect(pInf).toBeUndefined();
    });

    it('should handle cohorts with n=0', () => {
      const cohorts: CohortData[] = [
        { date: '1-Oct-25', n: 0, k: 0, age: 60 },
        { date: '15-Oct-25', n: 100, k: 50, age: 45 },
      ];

      const pInf = estimatePInfinity(cohorts, 30);

      expect(pInf).toBeCloseTo(0.5, 3);
    });
  });
});

describe('LAG completeness t95 tail constraint (Phase 2)', () => {
  it('inflates sigma and reduces completeness for young cohorts when authoritative t95 is larger than implied', () => {
    const cohorts: CohortData[] = [
      { date: '1-Dec-25', n: 100, k: 10, age: 1 },
      { date: '2-Dec-25', n: 100, k: 10, age: 2 },
      { date: '3-Dec-25', n: 100, k: 10, age: 3 },
    ];

    // Moment-fit will imply a relatively tight distribution.
    // IMPORTANT: defaultT95Days is only used when the fit fails. To apply an "authoritative" t95
    // tail-constraint, pass it via the edgeT95 parameter (authoritative horizon).
    const statsNoConstraint = computeEdgeLatencyStats(cohorts, 5, 5.2, 7);
    const statsWithConstraint = computeEdgeLatencyStats(cohorts, 5, 5.2, 7, 0, undefined, undefined, 60);

    expect(statsNoConstraint.fit.sigma).toBeLessThan(statsWithConstraint.fit.sigma);
    expect(statsWithConstraint.t95).toBeCloseTo(60, 2);
    expect(statsWithConstraint.completeness_cdf.tail_constraint_applied).toBe(true);
    expect(statsWithConstraint.completeness).toBeLessThanOrEqual(statsNoConstraint.completeness);
  });

  it('does not deflate sigma when authoritative t95 is smaller than implied', () => {
    const cohorts: CohortData[] = [
      { date: '1-Oct-25', n: 100, k: 50, age: 60 },
      { date: '15-Oct-25', n: 100, k: 48, age: 45 },
    ];

    // Provide an authoritative t95 that is smaller than the moment-implied t95 (but still > median).
    // The one-way constraint must NOT reduce sigma; it should only increase sigma when authoritative t95 is larger.
    const stats = computeEdgeLatencyStats(cohorts, 5, 7, 30, 0, undefined, undefined, 6);
    expect(stats.completeness_cdf.tail_constraint_applied).toBe(false);
    // sigma_min_from_t95 is still computed when authoritative t95 > median; it simply must not be applied.
    expect(stats.completeness_cdf.sigma_min_from_t95).toBeDefined();
    expect(stats.completeness_cdf.sigma).toBeCloseTo(stats.completeness_cdf.sigma_moments, 10);
  });
});

describe('LAG Completeness Calculation (§5.5)', () => {
  const mu = Math.log(5);
  const sigma = Math.sqrt(2 * Math.log(7 / 5));

  describe('calculateCompleteness', () => {
    it('should return 0 for brand new cohorts', () => {
      const cohorts: CohortData[] = [
        { date: '1-Dec-25', n: 100, k: 0, age: 0 },
      ];

      const completeness = calculateCompleteness(cohorts, mu, sigma);

      expect(completeness).toBeCloseTo(0, 4);
    });

    it('should return ~0.5 for cohorts at median age', () => {
      const cohorts: CohortData[] = [
        { date: '25-Nov-25', n: 100, k: 25, age: 5 }, // At median
      ];

      const completeness = calculateCompleteness(cohorts, mu, sigma);

      expect(completeness).toBeCloseTo(0.5, 1);
    });

    it('should approach 1 for very old cohorts', () => {
      const cohorts: CohortData[] = [
        { date: '1-Sep-25', n: 100, k: 50, age: 90 },
      ];

      const completeness = calculateCompleteness(cohorts, mu, sigma);

      expect(completeness).toBeGreaterThan(0.99);
    });

    it('should weight by cohort size', () => {
      // Two cohorts: one old (small), one new (large)
      const cohorts: CohortData[] = [
        { date: '1-Sep-25', n: 10, k: 5, age: 90 },   // F ≈ 1.0
        { date: '1-Dec-25', n: 90, k: 0, age: 0 },    // F ≈ 0.0
      ];

      const completeness = calculateCompleteness(cohorts, mu, sigma);

      // Weighted: (10 × 1 + 90 × 0) / 100 = 0.1
      expect(completeness).toBeCloseTo(0.1, 1);
    });

    it('should handle mixed maturity cohorts', () => {
      const cohorts: CohortData[] = [
        { date: '1-Oct-25', n: 100, k: 50, age: 60 },  // F ≈ 0.99
        { date: '25-Nov-25', n: 100, k: 25, age: 5 },  // F ≈ 0.5
        { date: '1-Dec-25', n: 100, k: 0, age: 0 },    // F ≈ 0
      ];

      const completeness = calculateCompleteness(cohorts, mu, sigma);

      // Should be around (0.99 + 0.5 + 0) / 3 ≈ 0.5
      expect(completeness).toBeGreaterThan(0.4);
      expect(completeness).toBeLessThan(0.6);
    });
  });
});

describe('LAG computeEdgeLatencyStats (Main Entry Point)', () => {
  it('should compute full statistics for latency edge', () => {
    const cohorts: CohortData[] = [
      { date: '1-Oct-25', n: 100, k: 50, age: 60 },
      { date: '15-Oct-25', n: 100, k: 48, age: 45 },
      { date: '1-Nov-25', n: 100, k: 45, age: 30 },
      { date: '15-Nov-25', n: 100, k: 30, age: 15 },
      { date: '1-Dec-25', n: 100, k: 10, age: 0 },
    ];

    const stats = computeEdgeLatencyStats(cohorts, 5, 7, 30);

    // Basic structure
    expect(stats.fit).toBeDefined();
    expect(stats.t95).toBeGreaterThan(0);
    expect(stats.p_infinity).toBeGreaterThan(0);
    expect(stats.completeness).toBeGreaterThan(0);
    expect(stats.completeness).toBeLessThanOrEqual(1);
    expect(stats.p_evidence).toBeCloseTo(183 / 500, 3);
    expect(stats.forecast_available).toBe(true);
    expect(stats.completeness_cdf).toBeDefined();
    expect(Number.isFinite(stats.completeness_cdf.mu)).toBe(true);
    expect(Number.isFinite(stats.completeness_cdf.sigma)).toBe(true);
  });

  it('should set forecast_available = false when no mature cohorts', () => {
    const cohorts: CohortData[] = [
      { date: '15-Nov-25', n: 100, k: 30, age: 15 },
      { date: '1-Dec-25', n: 100, k: 10, age: 0 },
    ];

    const stats = computeEdgeLatencyStats(cohorts, 5, 7, 30);

    // No cohorts old enough for p_infinity estimation
    expect(stats.forecast_available).toBe(false);
    // Without forecast fallback, p_infinity is set to p_evidence
    expect(stats.p_infinity).toBeCloseTo(stats.p_evidence, 12);
  });

  it('should handle edge case: single mature cohort', () => {
    const cohorts: CohortData[] = [
      { date: '1-Oct-25', n: 100, k: 50, age: 60 },
    ];

    const stats = computeEdgeLatencyStats(cohorts, 5, 7, 30);

    expect(stats.p_infinity).toBeCloseTo(0.5, 3);
    expect(stats.p_evidence).toBeCloseTo(0.5, 3);
    expect(stats.forecast_available).toBe(true);
  });

  it('should handle edge case: all brand new cohorts', () => {
    const cohorts: CohortData[] = [
      { date: '1-Dec-25', n: 100, k: 0, age: 0 },
      { date: '2-Dec-25', n: 100, k: 0, age: 0 },
    ];

    const stats = computeEdgeLatencyStats(cohorts, 5, 7, 30);

    expect(stats.completeness).toBeCloseTo(0, 4);
    expect(stats.p_evidence).toBe(0);
  });

  it('should fail fit quality if insufficient converters', () => {
    const cohorts: CohortData[] = [
      { date: '1-Oct-25', n: 100, k: 10, age: 60 }, // Only 10 converters total
    ];

    const stats = computeEdgeLatencyStats(cohorts, 5, 7, 30);

    expect(stats.fit.empirical_quality_ok).toBe(false);
    expect(stats.fit.quality_failure_reason).toContain('Insufficient');
    // Should fall back to configured/default t95 for t95
    expect(stats.t95).toBe(30);
  });
});

describe('LAG Property-Based Tests', () => {
  // These test invariants that should hold for any valid inputs
  
  describe('CDF bounds', () => {
    it('should always return 0 ≤ F(t) ≤ 1', () => {
      const mu = Math.log(5);
      const sigma = 0.8;

      for (const t of [0, 0.001, 1, 5, 10, 50, 100, 1000]) {
        const F = logNormalCDF(t, mu, sigma);
        expect(F).toBeGreaterThanOrEqual(0);
        expect(F).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('CDF monotonicity', () => {
    it('should satisfy F(t1) ≤ F(t2) for t1 ≤ t2', () => {
      const mu = Math.log(5);
      const sigma = 0.8;

      let prevF = 0;
      for (const t of [0, 1, 2, 5, 10, 20, 50]) {
        const F = logNormalCDF(t, mu, sigma);
        expect(F).toBeGreaterThanOrEqual(prevF);
        prevF = F;
      }
    });
  });

  describe('Completeness bounds', () => {
    it('should always return 0 ≤ completeness ≤ 1', () => {
      const mu = Math.log(5);
      const sigma = 0.8;

      // Test with various cohort configurations
      const configs = [
        [{ date: '1-Dec-25', n: 100, k: 0, age: 0 }],
        [{ date: '1-Oct-25', n: 100, k: 50, age: 90 }],
        [
          { date: '1-Oct-25', n: 50, k: 25, age: 60 },
          { date: '1-Dec-25', n: 150, k: 0, age: 0 },
        ],
      ];

      for (const cohorts of configs) {
        const completeness = calculateCompleteness(cohorts as CohortData[], mu, sigma);
        expect(completeness).toBeGreaterThanOrEqual(0);
        expect(completeness).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('Forecast bounds', () => {
    it('should always return 0 ≤ p_infinity ≤ 1', () => {
      const cohorts: CohortData[] = [
        { date: '1-Oct-25', n: 100, k: 50, age: 60 },
        { date: '1-Dec-25', n: 100, k: 0, age: 0 },
      ];

      // Test with various parameters
      for (const medianLag of [1, 5, 10, 30]) {
        for (const meanLag of [medianLag, medianLag * 1.5, medianLag * 2]) {
          const stats = computeEdgeLatencyStats(cohorts, medianLag, meanLag, 30);
          expect(stats.p_infinity).toBeGreaterThanOrEqual(0);
          expect(stats.p_infinity).toBeLessThanOrEqual(1);
        }
      }
    });
  });

  // NOTE (Phase 2): p.mean is computed via the canonical blend in the topo pass, not here.

  describe('Zero n handling', () => {
    it('should handle n = 0 gracefully without division by zero', () => {
      const cohorts: CohortData[] = [
        { date: '1-Oct-25', n: 0, k: 0, age: 60 },
        { date: '1-Nov-25', n: 100, k: 50, age: 30 },
      ];

      // Should not throw
      expect(() => computeEdgeLatencyStats(cohorts, 5, 7, 30)).not.toThrow();
    });
  });

  describe('NaN propagation prevention', () => {
    it('should not produce NaN or Infinity for finite inputs', () => {
      const cohorts: CohortData[] = [
        { date: '1-Oct-25', n: 100, k: 50, age: 60 },
        { date: '1-Dec-25', n: 100, k: 10, age: 0 },
      ];

      const stats = computeEdgeLatencyStats(cohorts, 5, 7, 30);

      expect(Number.isFinite(stats.t95)).toBe(true);
      expect(Number.isFinite(stats.p_infinity)).toBe(true);
      expect(Number.isFinite(stats.completeness)).toBe(true);
      expect(Number.isFinite(stats.p_evidence)).toBe(true);
      expect(Number.isFinite(stats.completeness_cdf.mu)).toBe(true);
      expect(Number.isFinite(stats.completeness_cdf.sigma)).toBe(true);
    });
  });

  describe('Path-adjusted completeness (pathT95 parameter)', () => {
    it('should reduce completeness for downstream edges with pathT95', () => {
      // Cohorts with ages 30, 15, 0 days from anchor
      const cohorts: CohortData[] = [
        { date: '1-Nov-25', n: 100, k: 45, age: 30 },
        { date: '15-Nov-25', n: 100, k: 30, age: 15 },
        { date: '1-Dec-25', n: 100, k: 10, age: 0 },
      ];

      // Without pathT95 (first edge in chain)
      const statsNoPath = computeEdgeLatencyStats(cohorts, 5, 7, 30, 0);

      // With pathT95 = 15 days (downstream edge - users spent 15 days to get here)
      const statsWithPath = computeEdgeLatencyStats(cohorts, 5, 7, 30, 15);

      // Completeness should be LOWER with pathT95 because effective ages are reduced
      // e.g., 30-day cohort becomes 15-day effective age, 15-day becomes 0-day
      expect(statsWithPath.completeness).toBeLessThan(statsNoPath.completeness);
    });

    it('should clamp effective age to 0 when pathT95 exceeds cohort age', () => {
      const cohorts: CohortData[] = [
        { date: '1-Dec-25', n: 100, k: 10, age: 5 },  // 5 days old
      ];

      // pathT95 = 10 days (longer than cohort age of 5)
      // Effective age should clamp to 0, not go negative
      const stats = computeEdgeLatencyStats(cohorts, 5, 7, 30, 10);

      // Should not throw and should produce valid completeness
      expect(Number.isFinite(stats.completeness)).toBe(true);
      expect(stats.completeness).toBeGreaterThanOrEqual(0);
    });
  });
});

// =============================================================================
// Inbound-N Tests (forecast population propagation)
// =============================================================================

describe('computeInboundN', () => {
  // Helper to create a simple test graph
  function createTestGraph(config: {
    edges: Array<{
      id: string;
      from: string;
      to: string;
      pMean: number;
      evidenceN?: number;
      evidenceK?: number;
    }>;
  }): GraphForInboundN {
    // Extract unique node IDs
    const nodeIds = new Set<string>();
    for (const edge of config.edges) {
      nodeIds.add(edge.from);
      nodeIds.add(edge.to);
    }

    return {
      nodes: Array.from(nodeIds).map(id => ({ id, type: id === 'start' ? 'start' : undefined })),
      edges: config.edges.map(e => ({
        id: e.id,
        uuid: e.id,
        from: e.from,
        to: e.to,
        p: {
          mean: e.pMean,
          evidence: e.evidenceN !== undefined ? { n: e.evidenceN, k: e.evidenceK ?? 0 } : undefined,
        },
      })),
    };
  }

  describe('anchor edge (A=X): p.n equals evidence.n', () => {
    it('should set p.n = evidence.n for edges from START node', () => {
      const graph = createTestGraph({
        edges: [
          { id: 'start-to-x', from: 'start', to: 'x', pMean: 0.5, evidenceN: 1000, evidenceK: 500 },
        ],
      });

      const activeEdges = new Set(['start-to-x']);
      const getEffectiveP = (edgeId: string) => graph.edges.find(e => e.id === edgeId)?.p?.mean ?? 0;

      const result = computeInboundN(graph, activeEdges, getEffectiveP);

      expect(result.get('start-to-x')?.n).toBe(1000);
      expect(result.get('start-to-x')?.forecast_k).toBe(500); // 1000 * 0.5
      expect(result.get('start-to-x')?.effective_p).toBe(0.5);
    });
  });

  describe('downstream edge (X→Y): p.n equals sum of inbound forecast.k', () => {
    it('should propagate population through single path', () => {
      // A → X → Y
      // A=X has n=1000, p=0.5 → forecast.k=500 arrives at X
      // X→Y should have p.n=500
      const graph = createTestGraph({
        edges: [
          { id: 'a-to-x', from: 'start', to: 'x', pMean: 0.5, evidenceN: 1000, evidenceK: 500 },
          { id: 'x-to-y', from: 'x', to: 'y', pMean: 0.8, evidenceN: 400, evidenceK: 320 },
        ],
      });

      const activeEdges = new Set(['a-to-x', 'x-to-y']);
      const getEffectiveP = (edgeId: string) => graph.edges.find(e => e.id === edgeId)?.p?.mean ?? 0;

      const result = computeInboundN(graph, activeEdges, getEffectiveP);

      // A→X: p.n=1000 (evidence.n), forecast.k=500
      expect(result.get('a-to-x')?.n).toBe(1000);
      expect(result.get('a-to-x')?.forecast_k).toBe(500);

      // X→Y: p.n=500 (inbound forecast.k at X), forecast.k=400
      expect(result.get('x-to-y')?.n).toBe(500);
      expect(result.get('x-to-y')?.forecast_k).toBe(400); // 500 * 0.8
    });

    it('should sum multiple inbound edges', () => {
      // A → X (p=0.5, n=1000) → Y
      // A → Z (p=0.3, n=1000) → Y
      // Y should receive 500 + 300 = 800
      const graph = createTestGraph({
        edges: [
          { id: 'a-to-x', from: 'start', to: 'x', pMean: 0.5, evidenceN: 1000, evidenceK: 500 },
          { id: 'a-to-z', from: 'start', to: 'z', pMean: 0.3, evidenceN: 1000, evidenceK: 300 },
          { id: 'x-to-y', from: 'x', to: 'y', pMean: 1.0 },
          { id: 'z-to-y', from: 'z', to: 'y', pMean: 1.0 },
        ],
      });

      const activeEdges = new Set(['a-to-x', 'a-to-z', 'x-to-y', 'z-to-y']);
      const getEffectiveP = (edgeId: string) => graph.edges.find(e => e.id === edgeId)?.p?.mean ?? 0;

      const result = computeInboundN(graph, activeEdges, getEffectiveP);

      // Both edges from X and Z to Y should receive their respective inbound populations
      expect(result.get('x-to-y')?.n).toBe(500);
      expect(result.get('z-to-y')?.n).toBe(300);
    });
  });

  describe('scenario/conditional_p selection', () => {
    it('should use effective probability from getEffectiveP callback', () => {
      const graph = createTestGraph({
        edges: [
          { id: 'a-to-x', from: 'start', to: 'x', pMean: 0.5, evidenceN: 1000, evidenceK: 500 },
          { id: 'x-to-y', from: 'x', to: 'y', pMean: 0.8 },
        ],
      });

      const activeEdges = new Set(['a-to-x', 'x-to-y']);
      
      // Simulate scenario override: x-to-y has conditional_p activated at 0.9
      const getEffectiveP = (edgeId: string) => {
        if (edgeId === 'x-to-y') return 0.9; // Override!
        return graph.edges.find(e => e.id === edgeId)?.p?.mean ?? 0;
      };

      const result = computeInboundN(graph, activeEdges, getEffectiveP);

      // X→Y should use effective_p=0.9, not base p.mean=0.8
      expect(result.get('x-to-y')?.effective_p).toBe(0.9);
      expect(result.get('x-to-y')?.forecast_k).toBe(450); // 500 * 0.9
    });

    it('should treat deactivated edges (p=0) correctly', () => {
      const graph = createTestGraph({
        edges: [
          { id: 'a-to-x', from: 'start', to: 'x', pMean: 0.5, evidenceN: 1000 },
          { id: 'x-to-y', from: 'x', to: 'y', pMean: 0.8 },
          { id: 'x-to-z', from: 'x', to: 'z', pMean: 0.2 }, // Will be deactivated
        ],
      });

      const activeEdges = new Set(['a-to-x', 'x-to-y', 'x-to-z']);
      
      // Simulate x-to-z being deactivated by whatIf
      const getEffectiveP = (edgeId: string) => {
        if (edgeId === 'x-to-z') return 0; // Deactivated!
        return graph.edges.find(e => e.id === edgeId)?.p?.mean ?? 0;
      };

      const result = computeInboundN(graph, activeEdges, getEffectiveP);

      // X→Z should have forecast.k=0 because effective_p=0
      expect(result.get('x-to-z')?.forecast_k).toBe(0);
      expect(result.get('x-to-z')?.effective_p).toBe(0);
    });
  });

  describe('applyInboundNToGraph', () => {
    it('should update edge p.n values', () => {
      const graph = createTestGraph({
        edges: [
          { id: 'a-to-x', from: 'start', to: 'x', pMean: 0.5, evidenceN: 1000 },
        ],
      });

      const inboundNMap = new Map<string, InboundNResult>([
        ['a-to-x', { n: 1000, forecast_k: 500, effective_p: 0.5 }],
      ]);

      applyInboundNToGraph(graph, inboundNMap);

      expect(graph.edges[0].p?.n).toBe(1000);
    });
  });

  describe('edge cases', () => {
    it('should handle empty graph', () => {
      const graph: GraphForInboundN = { nodes: [], edges: [] };
      const activeEdges = new Set<string>();
      const getEffectiveP = () => 0;

      const result = computeInboundN(graph, activeEdges, getEffectiveP);

      expect(result.size).toBe(0);
    });

    it('should handle no active edges', () => {
      const graph = createTestGraph({
        edges: [
          { id: 'a-to-x', from: 'start', to: 'x', pMean: 0, evidenceN: 1000 },
        ],
      });

      const activeEdges = new Set<string>(); // No active edges
      const getEffectiveP = () => 0;

      const result = computeInboundN(graph, activeEdges, getEffectiveP);

      expect(result.size).toBe(0);
    });

    it('should handle missing evidence.n gracefully', () => {
      const graph = createTestGraph({
        edges: [
          { id: 'a-to-x', from: 'start', to: 'x', pMean: 0.5 }, // No evidence
        ],
      });

      const activeEdges = new Set(['a-to-x']);
      const getEffectiveP = () => 0.5;

      const result = computeInboundN(graph, activeEdges, getEffectiveP);

      // Should use 0 as default when no evidence.n
      expect(result.get('a-to-x')?.n).toBe(0);
    });
  });
});

// =============================================================================
// enhanceGraphLatencies Tests (Graph-Level Topo Pass)
// =============================================================================

describe('enhanceGraphLatencies', () => {
  // Mock helpers that simulate windowAggregationService functions
  const mockHelpers: LAGHelpers = {
    aggregateCohortData: (values: ParameterValueForLAG[], queryDate: Date) => {
      // Simple mock: create one cohort per value with dates
      return values.flatMap(v => {
        if (!v.dates) return [];
        return v.dates.map((date, i) => ({
          date,
          n: v.n_daily?.[i] ?? 100,
          k: v.k_daily?.[i] ?? 50,
          age: Math.floor((queryDate.getTime() - new Date(date).getTime()) / (1000 * 60 * 60 * 24)),
          median_lag_days: v.median_lag_days?.[i],
          mean_lag_days: v.mean_lag_days?.[i],
          anchor_median_lag_days: v.anchor_median_lag_days?.[i],
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

  function createLatencyGraph(): GraphForPath {
    return {
      nodes: [
        { id: 'start', entry: { is_start: true } },
        { id: 'a' },
        { id: 'b' },
        { id: 'c' },
      ],
      edges: [
        { id: 'start-to-a', from: 'start', to: 'a', p: { mean: 0.8, latency: { latency_parameter: true, t95: 30 } } },
        { id: 'a-to-b', from: 'a', to: 'b', p: { mean: 0.6, latency: { latency_parameter: true, t95: 30 } } },
        { id: 'b-to-c', from: 'b', to: 'c', p: { mean: 0.4, latency: { latency_parameter: true, t95: 30 } } },
      ],
    };
  }

  function createParamLookup(): Map<string, ParameterValueForLAG[]> {
    const now = new Date();
    const dates = [
      new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    ];

    return new Map([
      ['start-to-a', [{
        mean: 0.8,
        n: 300,
        k: 240,
        dates,
        n_daily: [100, 100, 100],
        k_daily: [80, 80, 80],
        median_lag_days: [5, 5, 5],
        mean_lag_days: [6, 6, 6],
      }]],
      ['a-to-b', [{
        mean: 0.6,
        n: 240,
        k: 144,
        dates,
        n_daily: [80, 80, 80],
        k_daily: [48, 48, 48],
        median_lag_days: [7, 7, 7],
        mean_lag_days: [8, 8, 8],
      }]],
      ['b-to-c', [{
        mean: 0.4,
        n: 144,
        k: 58,
        dates,
        n_daily: [48, 48, 48],
        k_daily: [19, 19, 20],
        median_lag_days: [10, 10, 10],
        mean_lag_days: [12, 12, 12],
      }]],
    ]);
  }

  it('should compute t95 for each edge', () => {
    const graph = createLatencyGraph();
    const paramLookup = createParamLookup();

    const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);

    // First check how many edges were actually processed
    expect(result.edgesProcessed).toBeGreaterThan(0);
    expect(result.edgesWithLAG).toBe(3);
    
    // Each edge should have t95 computed in edgeValues (not mutated directly on graph)
    expect(result.edgeValues.length).toBe(3);
    for (const edgeValue of result.edgeValues) {
      expect(edgeValue.latency.t95).toBeGreaterThan(0);
      expect(Number.isFinite(edgeValue.latency.t95)).toBe(true);
    }
  });

  it('PARITY: should emit EdgeLAGValues for conditional_p[i] when paramLookup includes composite key', () => {
    const now = new Date();
    const dates = [
      new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    ];

    const graph: GraphForPath = {
      nodes: [
        { id: 'start', entry: { is_start: true } },
        { id: 'a' },
      ],
      edges: [
        {
          id: 'start-to-a',
          from: 'start',
          to: 'a',
          p: { mean: 0.8, latency: { latency_parameter: true, t95: 30 } },
          conditional_p: [
            {
              condition: 'context(channel:paid)',
              p: { mean: 0.9, latency: { latency_parameter: true, t95: 30 } },
            },
          ],
        } as any,
      ],
    };

    const paramLookup = new Map<string, ParameterValueForLAG[]>([
      [
        'start-to-a',
        [
          {
            mean: 0.8,
            n: 300,
            k: 240,
            dates,
            n_daily: [100, 100, 100],
            k_daily: [80, 80, 80],
            median_lag_days: [5, 5, 5],
            mean_lag_days: [6, 6, 6],
            // Provide onset on a window slice (uncontexted)
            sliceDSL: 'window(30d)',
            latency: { onset_delta_days: 2 },
          } as any,
        ],
      ],
      [
        'start-to-a:conditional[0]',
        [
          {
            mean: 0.9,
            n: 300,
            k: 270,
            dates,
            n_daily: [100, 100, 100],
            k_daily: [90, 90, 90],
            median_lag_days: [7, 7, 7],
            mean_lag_days: [9, 9, 9],
            // Provide onset on a window slice (uncontexted)
            sliceDSL: 'window(30d)',
            latency: { onset_delta_days: 4 },
          } as any,
        ],
      ],
    ]);

    const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);

    // Base edge output
    const base = result.edgeValues.find((v) => v.edgeUuid === 'start-to-a' && v.conditionalIndex === undefined);
    expect(base).toBeDefined();

    // Conditional output
    const cp0 = result.edgeValues.find((v) => v.edgeUuid === 'start-to-a' && v.conditionalIndex === 0);
    expect(cp0).toBeDefined();
    expect(cp0!.latency.onset_delta_days).toBe(4);
  });

  it('should compute cumulative path_t95 for downstream edges', () => {
    const graph = createLatencyGraph();
    const paramLookup = createParamLookup();

    const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);

    // Find edge values by edge ID
    const startToA = result.edgeValues.find(v => v.edgeUuid === 'start-to-a');
    const aToB = result.edgeValues.find(v => v.edgeUuid === 'a-to-b');
    const bToC = result.edgeValues.find(v => v.edgeUuid === 'b-to-c');

    // path_t95 should accumulate along the chain
    expect(startToA?.latency.path_t95).toBeGreaterThan(0);
    expect(aToB?.latency.path_t95).toBeGreaterThan(startToA?.latency.path_t95 || 0);
    expect(bToC?.latency.path_t95).toBeGreaterThan(aToB?.latency.path_t95 || 0);
  });

  it('should compute lower completeness for downstream edges', () => {
    const graph = createLatencyGraph();
    const paramLookup = createParamLookup();

    const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);

    // Find edge values by edge ID
    const startToA = result.edgeValues.find(v => v.edgeUuid === 'start-to-a');
    const aToB = result.edgeValues.find(v => v.edgeUuid === 'a-to-b');
    const bToC = result.edgeValues.find(v => v.edgeUuid === 'b-to-c');

    // Completeness should decrease for downstream edges due to path adjustment
    // (effective age is reduced by upstream anchor_median_lag)
    expect(startToA?.latency.completeness).toBeGreaterThan(0);
    expect(aToB?.latency.completeness).toBeLessThanOrEqual(startToA?.latency.completeness || 1);
    expect(bToC?.latency.completeness).toBeLessThanOrEqual(aToB?.latency.completeness || 1);
  });

  it('should skip edges without latency_parameter', () => {
    const graph: GraphForPath = {
      nodes: [
        { id: 'start', entry: { is_start: true } },
        { id: 'a' },
      ],
      edges: [
        { id: 'start-to-a', from: 'start', to: 'a', p: { mean: 0.8 } }, // No latency config
      ],
    };

    const paramLookup = new Map([
      ['start-to-a', [{ mean: 0.8, n: 100, k: 80 }]],
    ]);

    const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);

    expect(result.edgesWithLAG).toBe(0);
  });

  it('should skip edges without param data', () => {
    const graph = createLatencyGraph();
    const emptyLookup = new Map<string, ParameterValueForLAG[]>();

    const result = enhanceGraphLatencies(graph, emptyLookup, new Date(), mockHelpers);

    expect(result.edgesWithLAG).toBe(0);
  });

  it('should handle empty graph', () => {
    const graph: GraphForPath = { nodes: [], edges: [] };
    const paramLookup = new Map<string, ParameterValueForLAG[]>();

    const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);

    expect(result.edgesProcessed).toBe(0);
    expect(result.edgesWithLAG).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // FORECAST BLEND TESTS
  // ═══════════════════════════════════════════════════════════════════════════

  describe('forecast blending', () => {
    function createGraphWithForecast(): GraphForPath {
      return {
        nodes: [
          { id: 'start', entry: { is_start: true } },
          { id: 'end' },
        ],
        edges: [
          {
            id: 'start-to-end',
            from: 'start',
            to: 'end',
            p: {
              mean: 0.5,  // Initial mean (will be overwritten by blend)
              latency: { latency_parameter: true, t95: 30 },
              evidence: { mean: 0.3, n: 1000 },
              forecast: { mean: 0.7 },
            },
          },
        ],
      };
    }

    function createMatureCohorts() {
      const now = new Date();
      // All cohorts are 30+ days old (mature)
      const dates = [
        new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        new Date(now.getTime() - 32 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      ];
      return new Map([
        ['start-to-end', [{
          mean: 0.3,
          n: 300,
          k: 90,
          dates,
          n_daily: [100, 100, 100],
          k_daily: [30, 30, 30],
          median_lag_days: [5, 5, 5],
          mean_lag_days: [6, 6, 6],
        }]],
      ]);
    }

    function createImmatureCohorts() {
      const now = new Date();
      // All cohorts are very recent (1-2 days old) with high lag → very immature
      const dates = [
        new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        new Date(now.getTime() - 0.5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      ];
      return new Map([
        ['start-to-end', [
          // Cohort slice: immature cohorts for evidence
          {
            mean: 0.3,
            n: 300,
            k: 90,
            dates,
            n_daily: [100, 100, 100],
            k_daily: [30, 30, 30],
            // Higher lag means lower completeness for young cohorts
            median_lag_days: [10, 10, 10],
            mean_lag_days: [12, 12, 12],
            sliceDSL: 'cohort(1-Dec-25:3-Dec-25)',  // Mark as cohort slice
          },
          // Window slice: provides nBaseline for the forecast
          // In production, edge.p.forecast.mean comes FROM this window slice
          {
            mean: 0.7,
            n: 500,  // nBaseline for blend formula
            k: 350,
            forecast: 0.7,  // The forecast value
            sliceDSL: 'window(30d)',  // Mark as window slice
          },
        ]],
      ]);
    }

    it('should blend evidence and forecast based on completeness', () => {
      const graph = createGraphWithForecast();
      const paramLookup = createMatureCohorts();

      enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);

      const edge = graph.edges[0];
      
      // With evidence.mean=0.3, forecast.mean=0.7, high completeness should 
      // produce a blended mean closer to evidence
      expect(edge.p?.mean).toBeDefined();
      expect(edge.p?.mean).toBeGreaterThan(0.3);  // Not pure evidence
      expect(edge.p?.mean).toBeLessThan(0.7);     // Not pure forecast
    });

    it('should weight evidence more heavily when completeness is high', () => {
      const graph = createGraphWithForecast();
      const paramLookup = createMatureCohorts();

      const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);

      const edgeValue = result.edgeValues.find(v => v.edgeUuid === 'start-to-end');
      const evidenceMean = 0.3;
      const forecastMean = 0.7;
      const blendedMean = edgeValue?.blendedMean;

      // High completeness → blended mean closer to evidence
      // Distance to evidence should be less than distance to forecast
      const distToEvidence = Math.abs((blendedMean ?? 0) - evidenceMean);
      const distToForecast = Math.abs((blendedMean ?? 0) - forecastMean);
      
      expect(distToEvidence).toBeLessThan(distToForecast);
    });

    it('should weight forecast more heavily when completeness is low', () => {
      const graph = createGraphWithForecast();
      const paramLookup = createImmatureCohorts();

      const result = enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);

      // First verify we got results
      expect(result.edgesWithLAG).toBe(1);
      expect(result.edgeValues.length).toBe(1);
      
      const edgeValue = result.edgeValues[0];
      expect(edgeValue).toBeDefined();
      expect(edgeValue.edgeUuid).toBe('start-to-end');
      
      const evidenceMean = 0.3;
      const forecastMean = 0.7;
      const completeness = edgeValue.latency.completeness;

      // Low completeness → blended mean closer to forecast
      // With very immature cohorts (0.5-2 days old with median lag 10), completeness should be low
      expect(completeness).toBeLessThan(0.5);
      
      // With window slice providing nBaseline, blend should now be computed
      expect(edgeValue.blendedMean).toBeDefined();
      
      // Distance to forecast should be less than distance to evidence
      const distToEvidence = Math.abs(edgeValue.blendedMean! - evidenceMean);
      const distToForecast = Math.abs(edgeValue.blendedMean! - forecastMean);
      expect(distToForecast).toBeLessThan(distToEvidence);
    });

    it('should not blend if evidence is missing', () => {
      const graph: GraphForPath = {
        nodes: [
          { id: 'start', entry: { is_start: true } },
          { id: 'end' },
        ],
        edges: [
          {
            id: 'start-to-end',
            from: 'start',
            to: 'end',
            p: {
              mean: 0.5,
              latency: { latency_parameter: true, t95: 30 },
              // No evidence
              forecast: { mean: 0.7 },
            },
          },
        ],
      };
      const paramLookup = createMatureCohorts();

      enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);

      const edge = graph.edges[0];
      // Mean should remain unchanged (no blend without evidence)
      expect(edge.p?.mean).toBe(0.5);
    });

    it('should not blend if forecast is missing', () => {
      const graph: GraphForPath = {
        nodes: [
          { id: 'start', entry: { is_start: true } },
          { id: 'end' },
        ],
        edges: [
          {
            id: 'start-to-end',
            from: 'start',
            to: 'end',
            p: {
              mean: 0.5,
              latency: { latency_parameter: true, t95: 30 },
              evidence: { mean: 0.3, n: 1000 },
              // No forecast
            },
          },
        ],
      };
      const paramLookup = createMatureCohorts();

      enhanceGraphLatencies(graph, paramLookup, new Date(), mockHelpers);

      const edge = graph.edges[0];
      // Mean should remain unchanged (no blend without forecast)
      expect(edge.p?.mean).toBe(0.5);
    });
  });
});

