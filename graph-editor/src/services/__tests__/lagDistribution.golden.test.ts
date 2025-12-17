/**
 * Golden numerical tests for lag distribution maths (pre-refactor lock-in).
 *
 * These tests intentionally assert tight numeric expectations so we can:
 * - refactor/extract the pure maths into a shared module (Option A),
 * - prove behaviour is unchanged,
 * - delete the old in-service implementations.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  standardNormalInverseCDF,
  logNormalCDF,
  logNormalInverseCDF,
  fitLagDistribution,
} from '../statisticalEnhancementService';

describe('lag distribution maths (golden)', () => {
  it('standardNormalInverseCDF has known anchor values', () => {
    // Basic anchors for Φ^-1(p)
    expect(standardNormalInverseCDF(0.5)).toBeCloseTo(0, 12);
    expect(standardNormalInverseCDF(0.841344746)).toBeCloseTo(1, 6);
    expect(standardNormalInverseCDF(0.977249868)).toBeCloseTo(2, 6);
  });

  it('logNormalCDF and inverseCDF are consistent at the median', () => {
    const mu = Math.log(3);
    const sigma = 0.8;
    const t50 = logNormalInverseCDF(0.5, mu, sigma);
    // For lognormal, the median is exp(mu) exactly.
    expect(t50).toBeCloseTo(3, 12);
    // Numerical implementation has small floating error; keep tolerance tight but realistic.
    expect(logNormalCDF(3, mu, sigma)).toBeCloseTo(0.5, 8);
  });

  it('fitLagDistribution implements the moments formula for typical inputs', () => {
    // Design: mu = ln(median), sigma = sqrt(2 ln(mean/median))
    const median = 2;
    const mean = 4;
    const totalK = 200; // above quality gate
    const fit = fitLagDistribution(median, mean, totalK);

    expect(fit.empirical_quality_ok).toBe(true);
    expect(fit.mu).toBeCloseTo(Math.log(2), 12);
    expect(fit.sigma).toBeCloseTo(Math.sqrt(2 * Math.log(2)), 12);
  });

  it('fitLagDistribution uses default sigma when mean is missing (but keeps mu from median)', () => {
    const median = 5;
    const fit = fitLagDistribution(median, undefined, 500);
    expect(fit.mu).toBeCloseTo(Math.log(5), 12);
    // sigma is a constant; we just assert it is finite and > 0 (exact value is in constants).
    expect(Number.isFinite(fit.sigma)).toBe(true);
    expect(fit.sigma).toBeGreaterThan(0);
  });

  it('fitLagDistribution fails quality gate when totalK is below threshold (but remains stable)', () => {
    const median = 2;
    const mean = 4;
    const fit = fitLagDistribution(median, mean, 1);
    expect(fit.empirical_quality_ok).toBe(false);
    expect(Number.isFinite(fit.mu)).toBe(true);
    expect(Number.isFinite(fit.sigma)).toBe(true);
    expect(fit.sigma).toBeGreaterThan(0);
  });
});


