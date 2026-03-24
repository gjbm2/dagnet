/**
 * Stats engine parity contract — FE side.
 *
 * Canonical test vectors with hardcoded expected values that MUST match
 * the BE (Python) implementation. The same vectors appear in
 * lib/tests/test_stats_parity_contract.py. If either side drifts,
 * its test breaks.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  fitLagDistribution,
  logNormalCDF,
  logNormalInverseCDF,
} from '../lagDistributionUtils';
import { computeBlendedMean, computeEdgeLatencyStats, type CohortData } from '../statisticalEnhancementService';

// ── Tolerances ──────────────────────────────────────────────────────────────
// These are tight: the implementations must agree to high precision.
const TOL = 1e-9;       // mu, sigma, blended mean (pure arithmetic)
const TOL_CDF = 1e-6;   // CDF (FE Acklam approx vs BE scipy — ~7 decimal agreement)
const TOL_T95 = 1e-4;   // t95 (exp amplifies CDF approximation differences)

// ── Vector 1: fitLagDistribution ────────────────────────────────────────────
describe('parity: fitLagDistribution', () => {
  it('median=7, mean=9.5, k=500 → mu/sigma from moments', () => {
    const fit = fitLagDistribution(7.0, 9.5, 500);
    expect(fit.mu).toBeCloseTo(1.945910149055313, 10);
    expect(fit.sigma).toBeCloseTo(0.781513467000002, 10);
    expect(fit.empirical_quality_ok).toBe(true);
  });

  it('median=3, mean=undefined, k=500 → default sigma', () => {
    const fit = fitLagDistribution(3.0, undefined, 500);
    expect(fit.mu).toBeCloseTo(1.098612288668110, 10);
    expect(fit.sigma).toBeCloseTo(0.5, 10); // LATENCY_DEFAULT_SIGMA
  });

  it('low k (k=10) → quality flag false', () => {
    const fit = fitLagDistribution(7.0, 9.5, 10);
    expect(fit.empirical_quality_ok).toBe(false);
    expect(fit.sigma).toBeCloseTo(0.5, 10); // falls back to default
  });
});

// ── Vector 2: logNormalCDF ──────────────────────────────────────────────────
describe('parity: logNormalCDF', () => {
  const mu = 1.945910149055313;
  const sigma = 0.781513467000002;

  it('CDF(18, mu, sigma) ≈ 0.8866 (mature cohort)', () => {
    expect(logNormalCDF(18, mu, sigma)).toBeCloseTo(0.886573137615063, 6);
  });

  it('CDF(3, mu, sigma) ≈ 0.1391 (immature cohort)', () => {
    expect(logNormalCDF(3, mu, sigma)).toBeCloseTo(0.139143465967953, 6);
  });

  it('CDF(0, mu, sigma) = 0', () => {
    expect(logNormalCDF(0, mu, sigma)).toBe(0);
  });

  it('CDF(-1, mu, sigma) = 0', () => {
    expect(logNormalCDF(-1, mu, sigma)).toBe(0);
  });
});

// ── Vector 3: logNormalInverseCDF (t95) ─────────────────────────────────────
describe('parity: logNormalInverseCDF', () => {
  it('t95 for fit1 (median=7, mean=9.5)', () => {
    const mu = 1.945910149055313;
    const sigma = 0.781513467000002;
    expect(logNormalInverseCDF(0.95, mu, sigma)).toBeCloseTo(25.314703926093792, 6);
  });

  it('t95 for fit2 (median=3, default sigma)', () => {
    const mu = 1.098612288668110;
    const sigma = 0.5;
    expect(logNormalInverseCDF(0.95, mu, sigma)).toBeCloseTo(6.828049825542952, 6);
  });

  it('inverseCDF(0) = 0', () => {
    expect(logNormalInverseCDF(0, 1.0, 0.5)).toBe(0);
  });

  it('inverseCDF(1) = Infinity', () => {
    expect(logNormalInverseCDF(1, 1.0, 0.5)).toBe(Infinity);
  });
});

// ── Vector 4: computeBlendedMean ────────────────────────────────────────────
describe('parity: computeBlendedMean', () => {
  const model = {
    FORECAST_BLEND_LAMBDA: 0.15,
    LATENCY_BLEND_COMPLETENESS_POWER: 2.25,
  };

  it('moderate completeness (0.6)', () => {
    const result = computeBlendedMean({
      evidenceMean: 0.05,
      forecastMean: 0.08,
      completeness: 0.6,
      nQuery: 200,
      nBaseline: 1000,
    }, model);
    expect(result).toBeCloseTo(0.068537033909537, 10);
  });

  it('high completeness (0.95) → mostly evidence', () => {
    const result = computeBlendedMean({
      evidenceMean: 0.05,
      forecastMean: 0.08,
      completeness: 0.95,
      nQuery: 200,
      nBaseline: 1000,
    }, model);
    expect(result).toBeCloseTo(0.052521182878623, 10);
  });

  it('zero completeness → pure forecast', () => {
    const result = computeBlendedMean({
      evidenceMean: 0.05,
      forecastMean: 0.08,
      completeness: 0.0,
      nQuery: 200,
      nBaseline: 1000,
    }, model);
    expect(result).toBeCloseTo(0.08, 10);
  });

  it('nBaseline=0 → undefined', () => {
    const result = computeBlendedMean({
      evidenceMean: 0.05,
      forecastMean: 0.08,
      completeness: 0.6,
      nQuery: 200,
      nBaseline: 0,
    }, model);
    expect(result).toBeUndefined();
  });
});

// ── Vector 5: Fenton-Wilkinson composition ──────────────────────────────────
// FW composition is tested via its effect on t95: compose two edges,
// compute path_t95 from the composed distribution.
describe('parity: FW lognormal composition', () => {
  it('compose(mu=1.5,sigma=0.6) + (mu=2.0,sigma=0.4) → path mu/sigma', () => {
    // FW moment matching: X1 + X2 ≈ LN(mu_fw, sigma_fw)
    const mu_a = 1.5, sigma_a = 0.6;
    const mu_b = 2.0, sigma_b = 0.4;

    const mean_a = Math.exp(mu_a + sigma_a ** 2 / 2);
    const mean_b = Math.exp(mu_b + sigma_b ** 2 / 2);
    const var_a = (Math.exp(sigma_a ** 2) - 1) * Math.exp(2 * mu_a + sigma_a ** 2);
    const var_b = (Math.exp(sigma_b ** 2) - 1) * Math.exp(2 * mu_b + sigma_b ** 2);

    const m = mean_a + mean_b;
    const v = var_a + var_b;

    const sigma_sq = Math.log(1 + v / m ** 2);
    const sigma_fw = Math.sqrt(sigma_sq);
    const mu_fw = Math.log(m) - sigma_sq / 2;

    expect(mu_fw).toBeCloseTo(2.531031379595798, 10);
    expect(sigma_fw).toBeCloseTo(0.352090536095916, 10);

    // path_t95 from composed distribution
    const path_t95 = logNormalInverseCDF(0.95, mu_fw, sigma_fw);
    expect(path_t95).toBeCloseTo(22.424828829811858, 6);
  });
});

// ── Vector 6: Full pipeline — computeEdgeLatencyStats ───────────────────────
// This is the critical parity test: same cohorts + params through the full
// edge-level pipeline must produce the same outputs on FE and BE.
describe('parity: computeEdgeLatencyStats (full pipeline)', () => {
  const cohorts: CohortData[] = [
    { date: '2025-11-01', age: 60, n: 100, k: 85, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-11-05', age: 56, n: 120, k: 98, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-11-10', age: 51, n: 90,  k: 72, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-11-15', age: 46, n: 110, k: 82, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-11-20', age: 41, n: 95,  k: 65, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-11-25', age: 36, n: 105, k: 60, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-12-01', age: 31, n: 80,  k: 38, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-12-05', age: 27, n: 115, k: 42, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-12-10', age: 22, n: 100, k: 28, median_lag_days: 5.0, mean_lag_days: 7.0 },
    { date: '2025-12-15', age: 17, n: 90,  k: 15, median_lag_days: 5.0, mean_lag_days: 7.0 },
  ];

  it('should produce mu/sigma/t95/completeness/p_evidence/p_infinity matching BE', () => {
    const result = computeEdgeLatencyStats(
      cohorts,
      /* aggregateMedianLag */ 5.0,
      /* aggregateMeanLag */ 7.0,
      /* defaultT95Days */ 30.0,
      /* anchorMedianLag */ 0,
      /* fitTotalKOverride */ undefined,
      /* pInfinityCohortsOverride */ undefined,
      /* edgeT95 */ undefined,
      /* recencyHalfLifeDays */ 30.0,
      /* onsetDeltaDays */ 2.0,
      /* maxMeanMedianRatioOverride */ undefined,
      /* applyAnchorAgeAdjustment */ false,
    );

    // These values are the BE's output for the same inputs.
    // If either side changes, its test breaks.
    expect(result.fit.mu).toBeCloseTo(1.0986122886681098, 6);
    expect(result.fit.sigma).toBeCloseTo(1.0107676525947897, 6);
    expect(result.fit.empirical_quality_ok).toBe(true);
    expect(result.t95).toBeCloseTo(17.8184523080876, 4);
    expect(result.completeness).toBeCloseTo(0.9864722632086734, 4);
    expect(result.p_evidence).toBeCloseTo(0.582089552238806, 6);
    expect(result.p_infinity).toBeCloseTo(0.5663243456570916, 4);
    expect(result.forecast_available).toBe(true);
  });
});
