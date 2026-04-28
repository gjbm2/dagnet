/**
 * Per-day blend: observed rates with per-day weights.
 *
 * Mathematical invariant: completeness controls how much each day's observed
 * rate is trusted. It must not rewrite k/n into a de-biased rate before the
 * blend; doing both over-corrects near-mature cohort windows.
 *
 * Per-day weights (w_i from per-day c_i) remain. The rate those weights are
 * applied to is each day's observed k_i/n_i.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { computePerDayBlendedMean, logNormalCDF } from '../statisticalEnhancementService';
import { toModelSpaceAgeDays } from '../lagDistributionUtils';

// CDF params chosen to produce a range of completeness values at testable ages.
// mu=2.0, sigma=0.5, onset=0  →  median latency ≈ exp(2) = 7.4 days
const CDF_MU = 2.0;
const CDF_SIGMA = 0.5;
const ONSET = 0;

// Model constants (defaults from constants/latency.ts)
const LAMBDA = 0.15;
const ETA = 2.25;

/** Compute completeness for a given age using the same CDF the blend uses. */
function c(age: number): number {
  const ageX = toModelSpaceAgeDays(ONSET, age);
  return logNormalCDF(ageX, CDF_MU, CDF_SIGMA);
}

/** Compute the blend weight for a given c_i and n_i. */
function w(c_i: number, n_i: number, nBaseline: number): number {
  const cEff = c_i > 0 ? Math.min(1, Math.max(0, Math.pow(c_i, ETA))) : 0;
  const nEff = cEff * n_i;
  const remaining = Math.max(0, 1 - cEff);
  const m0Eff = LAMBDA * nBaseline * remaining;
  return (m0Eff + nEff) > 0 ? (nEff / (m0Eff + nEff)) : 0;
}

describe('Per-day blend: observed rates with per-day weights', () => {

  it('uses each day observed rate, not a completeness-debiased pooled rate', () => {
    const ages = [30, 3];    // age 30 → high c; age 3 → low c
    const c_A = c(30);       // ~0.997
    const c_B = c(3);        // ~0.036

    const cohorts = [
      { date: '2025-11-01', n: 100, k: 45, age: 30 },  // raw=0.45, debiased≈0.451
      { date: '2025-12-13', n: 100, k: 8,  age: 3 },   // raw=0.08, debiased≈2.2→clamped to 1.0
    ];
    const forecastMean = 0.50;
    const nBaseline = 200;

    // Compute expected blend from observed per-day rates:
    // blended_i = w_i × (k_i/n_i) + (1-w_i) × forecastMean
    // aggregate = Σ(n_i × blended_i) / Σn_i.
    const w_A = w(c_A, 100, nBaseline);
    const w_B = w(c_B, 100, nBaseline);
    const blended_A = w_A * 0.45 + (1 - w_A) * forecastMean;
    const blended_B = w_B * 0.08 + (1 - w_B) * forecastMean;
    const expectedBlend = (100 * blended_A + 100 * blended_B) / 200;

    const result = computePerDayBlendedMean({
      cohorts,
      forecastMean,
      nBaseline,
      cdfMu: CDF_MU,
      cdfSigma: CDF_SIGMA,
      onsetDeltaDays: ONSET,
    });

    expect(result).toBeDefined();
    expect(result!.blendedMean).toBeCloseTo(expectedBlend, 6);
  });

  it('should converge to evidence rate when all cohorts are fully mature', () => {
    // All cohorts at age 60 → c≈1 → w≈1 → blended ≈ evidence rate
    const cohorts = [
      { date: '2025-10-01', n: 100, k: 48, age: 60 },
      { date: '2025-10-02', n: 120, k: 55, age: 59 },
      { date: '2025-10-03', n: 80,  k: 42, age: 58 },
    ];
    const evidenceRate = (48 + 55 + 42) / (100 + 120 + 80);  // 145/300 = 0.4833

    const result = computePerDayBlendedMean({
      cohorts,
      forecastMean: 0.60,
      nBaseline: 300,
      cdfMu: CDF_MU,
      cdfSigma: CDF_SIGMA,
      onsetDeltaDays: ONSET,
    });

    expect(result).toBeDefined();
    // At c≈1, per-day weights approach one, so blended ≈ evidence rate.
    expect(result!.blendedMean).toBeCloseTo(evidenceRate, 2);
  });

  it('should converge to forecast when all cohorts are very immature', () => {
    // All cohorts at age 1 → c≈0.007 → w≈0 → blended ≈ forecastMean
    const cohorts = [
      { date: '2025-12-15', n: 100, k: 1, age: 1 },
      { date: '2025-12-14', n: 100, k: 0, age: 2 },
    ];
    const forecastMean = 0.55;

    const result = computePerDayBlendedMean({
      cohorts,
      forecastMean,
      nBaseline: 200,
      cdfMu: CDF_MU,
      cdfSigma: CDF_SIGMA,
      onsetDeltaDays: ONSET,
    });

    expect(result).toBeDefined();
    expect(result!.blendedMean).toBeCloseTo(forecastMean, 2);
  });

  it('does not exceed the observed/forecast envelope on mixed maturity data', () => {
    const cohorts = [
      { date: '2025-11-01', n: 150, k: 70, age: 25 },
      { date: '2025-11-15', n: 100, k: 20, age: 11 },
      { date: '2025-12-01', n: 80,  k: 3,  age: 5 },
    ];

    const result = computePerDayBlendedMean({
      cohorts,
      forecastMean: 0.60,
      nBaseline: 300,
      cdfMu: CDF_MU,
      cdfSigma: CDF_SIGMA,
      onsetDeltaDays: ONSET,
    });

    expect(result).toBeDefined();
    const observedRates = cohorts.map((cohort) => cohort.k / cohort.n);
    const lo = Math.min(0.60, ...observedRates);
    const hi = Math.max(0.60, ...observedRates);
    expect(result!.blendedMean).toBeGreaterThanOrEqual(lo);
    expect(result!.blendedMean).toBeLessThanOrEqual(hi);
  });
});
