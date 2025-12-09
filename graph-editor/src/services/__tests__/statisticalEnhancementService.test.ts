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
  applyFormulaA,
  applyFormulaAToAll,
  calculateCompleteness,
  computeEdgeLatencyStats,
  // LAG types
  type CohortData,
  type LagDistributionFit,
} from '../statisticalEnhancementService';
import type { RawAggregation } from '../windowAggregationService';
import type { DateRange } from '../../types';
import {
  LATENCY_MIN_FIT_CONVERTERS,
  LATENCY_DEFAULT_SIGMA,
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
      expect(fit.empirical_quality_ok).toBe(false);
      expect(fit.quality_failure_reason).toContain('Mean lag not available');
    });

    it('should fail quality gate if mean/median ratio < 1', () => {
      // mean < median is invalid for log-normal
      const fit = fitLagDistribution(10, 8, 100);

      expect(fit.empirical_quality_ok).toBe(false);
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

      // For median=5, mean=7: t95 should be around 12-15 days
      expect(t95).toBeGreaterThan(10);
      expect(t95).toBeLessThan(20);
      // Verify it's actually the 95th percentile
      expect(logNormalCDF(t95, fit.mu, fit.sigma)).toBeCloseTo(0.95, 3);
    });

    it('should fall back to maturityDays if fit is not valid', () => {
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
      // With H=30 (half-life):
      //   age 60: w = exp(-60/30) ≈ 0.135, k=60, n=100
      //   age 45: w = exp(-45/30) ≈ 0.223, k=55, n=100
      //   age 30: w = exp(-30/30) ≈ 0.368, k=40, n=100
      // weighted k ≈ 8.1 + 12.3 + 14.7 = 35.1
      // weighted n ≈ 13.5 + 22.3 + 36.8 = 72.6
      // p_∞ ≈ 35.1 / 72.6 ≈ 0.483
      // (Recency weighting favours the younger cohort with lower conversion)
      expect(pInf).toBeCloseTo(0.483, 2);
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

describe('LAG Formula A (§5.3)', () => {
  // Scenario: median lag = 5 days, mean lag = 7 days
  const mu = Math.log(5);
  const sigma = Math.sqrt(2 * Math.log(7 / 5));
  const pInfinity = 0.5; // 50% asymptotic conversion rate

  describe('applyFormulaA', () => {
    it('should return k for fully mature cohorts (F ≈ 1)', () => {
      const cohort: CohortData = {
        date: '1-Oct-25',
        n: 100,
        k: 50,
        age: 100, // Very old, F(100) ≈ 1
      };

      const kHat = applyFormulaA(cohort, pInfinity, mu, sigma);

      // Should return observed k since cohort is fully mature
      expect(kHat).toBeCloseTo(50, 1);
    });

    it('should forecast additional conversions for immature cohorts', () => {
      const cohort: CohortData = {
        date: '25-Nov-25',
        n: 100,
        k: 10,
        age: 5, // Young cohort, F(5) ≈ 0.5 (at median)
      };

      const kHat = applyFormulaA(cohort, pInfinity, mu, sigma);

      // Should be greater than observed k (forecasts additional conversions)
      expect(kHat).toBeGreaterThan(10);
      // But not greater than n (max possible)
      expect(kHat).toBeLessThanOrEqual(100);
    });

    it('should return k = 0 for empty cohorts', () => {
      const cohort: CohortData = {
        date: '1-Dec-25',
        n: 0,
        k: 0,
        age: 0,
      };

      const kHat = applyFormulaA(cohort, pInfinity, mu, sigma);

      expect(kHat).toBe(0);
    });

    it('should handle brand new cohorts (age = 0, F = 0)', () => {
      const cohort: CohortData = {
        date: '1-Dec-25',
        n: 100,
        k: 0,
        age: 0,
      };

      const kHat = applyFormulaA(cohort, pInfinity, mu, sigma);

      // F(0) = 0, S(0) = 1
      // Formula: k + (n-k) × (p_∞ × 1) / (1 - p_∞ × 0) = 0 + 100 × 0.5 / 1 = 50
      expect(kHat).toBeCloseTo(50, 1);
    });

    it('should handle cohort at median age (F = 0.5)', () => {
      const cohort: CohortData = {
        date: '25-Nov-25',
        n: 100,
        k: 25, // Observed 25%, but we expect 50% eventually
        age: 5, // At median
      };

      const kHat = applyFormulaA(cohort, pInfinity, mu, sigma);

      // F(5) ≈ 0.5, S(5) ≈ 0.5
      // k + (100-25) × (0.5 × 0.5) / (1 - 0.5 × 0.5) = 25 + 75 × 0.25/0.75 = 25 + 25 = 50
      expect(kHat).toBeCloseTo(50, 1);
    });
  });

  describe('applyFormulaAToAll', () => {
    it('should aggregate across all cohorts', () => {
      const cohorts: CohortData[] = [
        { date: '1-Oct-25', n: 100, k: 50, age: 60 },  // Mature
        { date: '15-Oct-25', n: 100, k: 48, age: 45 }, // Mature
        { date: '1-Nov-25', n: 100, k: 45, age: 30 },  // At t95 boundary
        { date: '15-Nov-25', n: 100, k: 30, age: 15 }, // Immature
        { date: '1-Dec-25', n: 100, k: 10, age: 0 },   // Brand new
      ];

      const fit: LagDistributionFit = {
        mu,
        sigma,
        empirical_quality_ok: true,
        total_k: 183,
      };

      const result = applyFormulaAToAll(cohorts, pInfinity, fit, 30);

      expect(result.total_n).toBe(500);
      expect(result.p_infinity).toBe(pInfinity);
      expect(result.p_mean).toBeGreaterThan(0);
      expect(result.p_mean).toBeLessThanOrEqual(1);
      // Blended should be >= evidence (forecasting adds to observed)
      const pEvidence = 183 / 500;
      expect(result.p_mean).toBeGreaterThanOrEqual(pEvidence - 0.01);
    });

    it('should include per-cohort details when requested', () => {
      const cohorts: CohortData[] = [
        { date: '1-Nov-25', n: 100, k: 50, age: 30 },
        { date: '15-Nov-25', n: 100, k: 30, age: 15 },
      ];

      const fit: LagDistributionFit = {
        mu,
        sigma,
        empirical_quality_ok: true,
        total_k: 80,
      };

      const result = applyFormulaAToAll(cohorts, pInfinity, fit, 30, true);

      expect(result.cohort_details).toBeDefined();
      expect(result.cohort_details).toHaveLength(2);
      expect(result.cohort_details![0].date).toBe('1-Nov-25');
      expect(result.cohort_details![0].F_age).toBeGreaterThan(0);
      expect(result.cohort_details![0].k_hat).toBeGreaterThanOrEqual(50);
    });
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
    expect(stats.p_mean).toBeGreaterThan(0);
    expect(stats.p_mean).toBeLessThanOrEqual(1);
    expect(stats.completeness).toBeGreaterThan(0);
    expect(stats.completeness).toBeLessThanOrEqual(1);
    expect(stats.p_evidence).toBeCloseTo(183 / 500, 3);
    expect(stats.forecast_available).toBe(true);
  });

  it('should set forecast_available = false when no mature cohorts', () => {
    const cohorts: CohortData[] = [
      { date: '15-Nov-25', n: 100, k: 30, age: 15 },
      { date: '1-Dec-25', n: 100, k: 10, age: 0 },
    ];

    const stats = computeEdgeLatencyStats(cohorts, 5, 7, 30);

    // No cohorts old enough for p_infinity estimation
    expect(stats.forecast_available).toBe(false);
    // p_mean should equal p_evidence (no forecasting possible)
    expect(stats.p_mean).toBeCloseTo(stats.p_evidence, 6);
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
    // Should fall back to maturityDays for t95
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
    it('should always return 0 ≤ p_mean ≤ 1', () => {
      const cohorts: CohortData[] = [
        { date: '1-Oct-25', n: 100, k: 50, age: 60 },
        { date: '1-Dec-25', n: 100, k: 0, age: 0 },
      ];

      // Test with various parameters
      for (const medianLag of [1, 5, 10, 30]) {
        for (const meanLag of [medianLag, medianLag * 1.5, medianLag * 2]) {
          const stats = computeEdgeLatencyStats(cohorts, medianLag, meanLag, 30);
          expect(stats.p_mean).toBeGreaterThanOrEqual(0);
          expect(stats.p_mean).toBeLessThanOrEqual(1);
        }
      }
    });
  });

  describe('Forecast ≥ evidence', () => {
    it('should satisfy p_mean ≥ p_evidence (forecasting adds, not subtracts)', () => {
      const cohorts: CohortData[] = [
        { date: '1-Oct-25', n: 100, k: 50, age: 60 },
        { date: '15-Nov-25', n: 100, k: 20, age: 15 },
        { date: '1-Dec-25', n: 100, k: 5, age: 0 },
      ];

      const stats = computeEdgeLatencyStats(cohorts, 5, 7, 30);

      // Allow small numerical tolerance
      expect(stats.p_mean).toBeGreaterThanOrEqual(stats.p_evidence - 0.001);
    });
  });

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
      expect(Number.isFinite(stats.p_mean)).toBe(true);
      expect(Number.isFinite(stats.completeness)).toBe(true);
      expect(Number.isFinite(stats.p_evidence)).toBe(true);
    });
  });
});

