/**
 * Per-day blend: pooled de-biasing with per-day weights.
 *
 * Mathematical invariant: the evidence rate used in the blend should be
 * the pooled MLE  p̂ = Σk / Σ(n×c),  NOT per-day de-biased rates k_i/(n_i×c_i).
 *
 * The pooled MLE is the minimum-variance unbiased estimator under
 * k_i ~ Binomial(n_i, p × c_i).  Per-day de-biasing amplifies noise
 * (dividing by small c_i) while the pooled version cancels noise across days.
 *
 * Per-day WEIGHTS (w_i from per-day c_i) remain — they control how much
 * each day trusts evidence vs forecast.  But the RATE those weights are
 * applied to is the pooled estimate.
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

describe('Per-day blend: pooled de-biasing with per-day weights', () => {

  it('should use the pooled de-biased rate, not per-day de-biased rates', () => {
    // Two cohorts with same true rate p≈0.5 but different completeness.
    // Cohort B (immature) randomly over-converted — 8 conversions from
    // an expected ≈5 (n=100, p=0.5, c≈0.1).
    //
    // Per-day de-biasing amplifies cohort B's noise: 8/(100×c_B) ≈ 0.8
    // Pooled de-biasing absorbs it: (45+8)/(100×c_A + 100×c_B) ≈ 0.53
    //
    // The blend result should match the pooled formula.
    const ages = [30, 3];    // age 30 → high c; age 3 → low c
    const c_A = c(30);       // ~0.997
    const c_B = c(3);        // ~0.036

    const cohorts = [
      { date: '2025-11-01', n: 100, k: 45, age: 30 },  // raw=0.45, debiased≈0.451
      { date: '2025-12-13', n: 100, k: 8,  age: 3 },   // raw=0.08, debiased≈2.2→clamped to 1.0
    ];
    const forecastMean = 0.50;
    const nBaseline = 200;

    const pooledRate = (45 + 8) / (100 * c_A + 100 * c_B);

    // Compute expected blend from pooled formula:
    // blended_i = w_i × pooledRate + (1-w_i) × forecastMean
    // aggregate = Σ(n_i × blended_i) / Σn_i
    const w_A = w(c_A, 100, nBaseline);
    const w_B = w(c_B, 100, nBaseline);
    const blended_A = w_A * pooledRate + (1 - w_A) * forecastMean;
    const blended_B = w_B * pooledRate + (1 - w_B) * forecastMean;
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
    // At c≈1, pooled rate ≈ raw rate, w≈1, so blended ≈ evidence rate
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

  it('pooled rate should equal Σk / Σ(n×c) — verifiable from result diagnostics', () => {
    // The pooled de-biased rate used in the blend should be recoverable
    // from the per-day diagnostics: Σk / Σ(n×c)
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

    // Compute expected pooled rate from known CDF values
    const totalK = 70 + 20 + 3;
    const effectiveN = 150 * c(25) + 100 * c(11) + 80 * c(5);
    const pooledRate = totalK / effectiveN;

    // The blend with per-day weights applied to the pooled rate should match
    const w_25 = w(c(25), 150, 300);
    const w_11 = w(c(11), 100, 300);
    const w_5  = w(c(5),  80,  300);
    const blended_25 = w_25 * pooledRate + (1 - w_25) * 0.60;
    const blended_11 = w_11 * pooledRate + (1 - w_11) * 0.60;
    const blended_5  = w_5  * pooledRate + (1 - w_5)  * 0.60;
    const expectedBlend = (150 * blended_25 + 100 * blended_11 + 80 * blended_5) / 330;

    expect(result!.blendedMean).toBeCloseTo(expectedBlend, 6);
  });
});
