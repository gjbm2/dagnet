/**
 * Golden numerical tests for lag distribution maths (pre-refactor lock-in).
 *
 * These tests intentionally assert tight numeric expectations so we can:
 * - refactor/extract the pure maths into a shared module (Option A),
 * - prove behaviour is unchanged,
 * - delete the old in-service implementations.
 *
 * IMPORTANT (Phase 0 baseline): These tests form the "hard coverage" gate
 * before any onset-related stats changes. All tests must pass with current
 * code before onset implementation begins. See §4.0.5 in the onset
 * implementation plan.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  standardNormalInverseCDF,
  logNormalCDF,
  logNormalInverseCDF,
  fitLagDistribution,
  toModelSpace,
} from '../statisticalEnhancementService';
import { LATENCY_DEFAULT_SIGMA } from '../../constants/latency';

describe('lag distribution maths (golden)', () => {
  it('standardNormalInverseCDF has known anchor values', () => {
    // Basic anchors for Φ^-1(p)
    expect(standardNormalInverseCDF(0.5)).toBeCloseTo(0, 12);
    expect(standardNormalInverseCDF(0.841344746)).toBeCloseTo(1, 6);
    expect(standardNormalInverseCDF(0.977249868)).toBeCloseTo(2, 6);
  });

  it('logNormalCDF returns 0 for t <= 0', () => {
    const mu = Math.log(3);
    const sigma = 0.8;
    expect(logNormalCDF(0, mu, sigma)).toBe(0);
    expect(logNormalCDF(-1, mu, sigma)).toBe(0);
    expect(logNormalCDF(-100, mu, sigma)).toBe(0);
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

  it('logNormalCDF returns precomputed value at non-median point (t=5)', () => {
    // Canonical params: mu = ln(3), sigma = 0.8
    // Precomputed using scipy: lognorm.cdf(5, s=0.8, scale=3) ≈ 0.7384362945
    const mu = Math.log(3);
    const sigma = 0.8;
    // Tolerance: 6 decimal places (tight enough to catch drift, realistic for floating point)
    expect(logNormalCDF(5, mu, sigma)).toBeCloseTo(0.7384362945, 6);
  });

  it('logNormalInverseCDF returns precomputed value at p=0.95', () => {
    // Canonical params: mu = ln(3), sigma = 0.8
    // Characterisation test: locks in current implementation value
    const mu = Math.log(3);
    const sigma = 0.8;
    // Current implementation returns 11.184123061400983
    expect(logNormalInverseCDF(0.95, mu, sigma)).toBeCloseTo(11.1841, 4);
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
    // sigma must be exactly the default value from constants
    expect(fit.sigma).toBe(LATENCY_DEFAULT_SIGMA);
    expect(fit.empirical_quality_ok).toBe(true);
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

  it('toModelSpace shifts user-space (T) values into model-space (X) values', () => {
    const { onsetDeltaDays, medianXDays, meanXDays, t95XDays, ageXDays } = toModelSpace(
      2,
      10, // medianT
      12, // meanT
      20, // t95T
      9 // ageT
    );
    expect(onsetDeltaDays).toBe(2);
    expect(medianXDays).toBeCloseTo(8, 12);
    expect(meanXDays).toBeCloseTo(10, 12);
    expect(t95XDays).toBeCloseTo(18, 12);
    expect(ageXDays).toBeCloseTo(7, 12);
  });

  it('toModelSpace clamps model-space age at 0 during dead-time (ageT ≤ onset)', () => {
    const r = toModelSpace(5, 10, 12, 20, 5);
    expect(r.ageXDays).toBe(0);
  });

  it('toModelSpace clamps shifted lag values to a small positive epsilon when onset ≥ value', () => {
    const r = toModelSpace(100, 10, 12, 20, 9);
    // We do not assert the epsilon literal here; just assert it is > 0 and finite.
    expect(r.medianXDays).toBeGreaterThan(0);
    expect(Number.isFinite(r.medianXDays)).toBe(true);
    expect(r.meanXDays!).toBeGreaterThan(0);
    expect(Number.isFinite(r.meanXDays!)).toBe(true);
    expect(r.t95XDays!).toBeGreaterThan(0);
    expect(Number.isFinite(r.t95XDays!)).toBe(true);
    // Age still clamps to 0.
    expect(r.ageXDays).toBe(0);
  });
});


