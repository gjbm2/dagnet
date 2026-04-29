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

/** Compute the blend weight for a given c_i and n_i.
 *
 * Mirrors `computePerDayBlendedMean` in statisticalEnhancementService:
 * standard conjugate Beta-binomial blend with prior pseudo-count
 * always present (no `(1 - cEff)` factor on m0Eff). Evidence's
 * influence scales with maturity-discounted nEff; the prior never
 * vanishes — "absence of evidence is not evidence of absence".
 */
function w(c_i: number, n_i: number, nBaseline: number): number {
  const cEff = c_i > 0 ? Math.min(1, Math.max(0, Math.pow(c_i, ETA))) : 0;
  const nEff = cEff * n_i;
  const m0Eff = LAMBDA * nBaseline;
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

  it('approaches evidence rate as evidence count overwhelms prior pseudo-count', () => {
    // All cohorts at age 60 → c≈1 → nEff = n; with n ≫ λ·nBaseline the
    // blend weight wEvidence = n/(n + λ·nBaseline) → 1, so blendedMean
    // approaches the pooled evidence rate. The prior is never given
    // zero weight (per "absence of evidence is not evidence of
    // absence"); evidence wins by accumulating count, not by forcing
    // the prior to vanish at maturity.
    const cohorts = [
      { date: '2025-10-01', n: 10000, k: 4800, age: 60 },
      { date: '2025-10-02', n: 12000, k: 5500, age: 59 },
      { date: '2025-10-03', n: 8000,  k: 4200, age: 58 },
    ];
    const totalN = 30000;
    const evidenceRate = (4800 + 5500 + 4200) / totalN;  // 14500/30000 = 0.4833
    const forecastMean = 0.60;
    const nBaseline = 300;

    const result = computePerDayBlendedMean({
      cohorts,
      forecastMean,
      nBaseline,
      cdfMu: CDF_MU,
      cdfSigma: CDF_SIGMA,
      onsetDeltaDays: ONSET,
    });

    expect(result).toBeDefined();
    // n=30000 vs λ·nBaseline=0.15·300=45 → wEvidence ≈ 30000/30045 ≈ 0.9985
    // The per-day blend's exact result differs slightly from a pooled
    // blend because each day weights its own w_i × rate_i; the
    // aggregate is n-weighted across days. Net result is still very
    // close to the pooled evidence rate.
    expect(result!.blendedMean).toBeCloseTo(evidenceRate, 2);
    // And it's much closer to evidence than to forecast.
    expect(Math.abs(result!.blendedMean - evidenceRate)).toBeLessThan(
      Math.abs(result!.blendedMean - forecastMean) * 0.05,
    );
  });

  it('keeps the prior present even at full maturity with sparse evidence', () => {
    // n comparable to λ·nBaseline → the prior should still carry
    // meaningful weight even when c≈1. This is the load-bearing
    // case: at completeness=1 with n=0 successes from a small sample,
    // the formula must NOT collapse to evidenceMean=0.
    const cohorts = [
      { date: '2025-10-01', n: 100, k: 0, age: 60 },  // mature, zero successes
    ];
    const forecastMean = 0.50;
    const nBaseline = 100;  // λ·nBaseline = 15, comparable to n

    const result = computePerDayBlendedMean({
      cohorts,
      forecastMean,
      nBaseline,
      cdfMu: CDF_MU,
      cdfSigma: CDF_SIGMA,
      onsetDeltaDays: ONSET,
    });

    expect(result).toBeDefined();
    // wEvidence = 100/(100 + 15) ≈ 0.87
    // blendedMean ≈ 0.87·0 + 0.13·0.50 ≈ 0.065
    // The prior contributes ~13% — not zero. "Absence of evidence is
    // not evidence of absence."
    expect(result!.blendedMean).toBeGreaterThan(0);
    const expectedW = 100 / (100 + LAMBDA * nBaseline);
    const expectedBlend = (1 - expectedW) * forecastMean;
    expect(result!.blendedMean).toBeCloseTo(expectedBlend, 4);
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
