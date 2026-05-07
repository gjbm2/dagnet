/**
 * Golden tests for the epistemic dispersion primitives in lagDistributionUtils.
 *
 * Design: docs/current/codebase/EPISTEMIC_DISPERSION_DESIGN.md.
 * Contract: μ_sd and σ_sd are the SDs of the Gaussian whose central 90%
 * interval matches the Jeffreys-prior posterior on (μ, σ²) for the
 * Gaussian inference problem on ln(t).
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  studentTQuantile,
  studentTCDF,
  chiSquaredQuantile,
  chiSquaredCDF,
  epistemicMuSd,
  epistemicSigmaSd,
  rateOverdispersionPredictiveBeta,
  rateRecentBlockPredictiveBeta,
} from '../lagDistributionUtils';

describe('Student-t quantile / CDF', () => {
  // Reference values from a standard t-table (e.g. NIST e-Handbook §1.3.6.7.2).
  it('matches t_{ν, 0.95} table values', () => {
    expect(studentTQuantile(0.95, 1)).toBeCloseTo(6.3138, 3);
    expect(studentTQuantile(0.95, 2)).toBeCloseTo(2.9200, 3);
    expect(studentTQuantile(0.95, 5)).toBeCloseTo(2.0150, 3);
    expect(studentTQuantile(0.95, 10)).toBeCloseTo(1.8125, 3);
    expect(studentTQuantile(0.95, 30)).toBeCloseTo(1.6973, 3);
    expect(studentTQuantile(0.95, 100)).toBeCloseTo(1.6602, 3);
  });

  it('approaches the standard normal quantile for large ν', () => {
    expect(studentTQuantile(0.95, 100000)).toBeCloseTo(1.6449, 2);
  });

  it('is symmetric about zero', () => {
    for (const dof of [1, 5, 30]) {
      expect(studentTQuantile(0.05, dof)).toBeCloseTo(-studentTQuantile(0.95, dof), 6);
    }
  });

  it('CDF and quantile are inverses', () => {
    for (const dof of [1, 2, 5, 10, 30, 100]) {
      for (const p of [0.05, 0.1, 0.5, 0.9, 0.95]) {
        const t = studentTQuantile(p, dof);
        expect(studentTCDF(t, dof)).toBeCloseTo(p, 6);
      }
    }
  });
});

describe('chi-squared quantile / CDF', () => {
  // Reference values from a standard χ² table.
  it('matches χ²_{ν, p} table values', () => {
    expect(chiSquaredQuantile(0.05, 1)).toBeCloseTo(0.0039, 3);
    expect(chiSquaredQuantile(0.95, 1)).toBeCloseTo(3.8415, 3);
    expect(chiSquaredQuantile(0.05, 5)).toBeCloseTo(1.1455, 3);
    expect(chiSquaredQuantile(0.95, 5)).toBeCloseTo(11.0705, 3);
    expect(chiSquaredQuantile(0.05, 30)).toBeCloseTo(18.4927, 2);
    expect(chiSquaredQuantile(0.95, 30)).toBeCloseTo(43.7730, 2);
  });

  it('CDF and quantile are inverses', () => {
    for (const dof of [1, 2, 5, 10, 30, 100]) {
      for (const p of [0.05, 0.1, 0.5, 0.9, 0.95]) {
        const x = chiSquaredQuantile(p, dof);
        expect(chiSquaredCDF(x, dof)).toBeCloseTo(p, 6);
      }
    }
  });
});

describe('epistemicMuSd', () => {
  // For very large N the t-quantile collapses to z = 1.6449 and the formula
  // reduces to s/√N — the asymptotic SE of the MLE location estimator.
  it('converges to s/√N for large N', () => {
    const s = 0.5;
    const N = 10000;
    expect(epistemicMuSd(s, N)).toBeCloseTo(s / Math.sqrt(N), 4);
  });

  // For small N the formula returns t_{N-1, 0.95} · s/√N / 1.6449. We can
  // check the multiplicative inflation factor against the t-table.
  it('matches the interval-matched formula at N = 5', () => {
    const s = 0.6;
    const N = 5;
    // t_{4, 0.95} = 2.1318 (table); z_{0.95} = 1.6449
    const expected = (s / Math.sqrt(N)) * (2.1318 / 1.6449);
    expect(epistemicMuSd(s, N)).toBeCloseTo(expected, 3);
  });

  it('is finite at N = 2 (Cauchy-tailed posterior)', () => {
    const v = epistemicMuSd(0.5, 2);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(0);
  });

  it('returns 0 when N < 2 or s <= 0', () => {
    expect(epistemicMuSd(0.5, 1)).toBe(0);
    expect(epistemicMuSd(0.5, 0)).toBe(0);
    expect(epistemicMuSd(0, 100)).toBe(0);
    expect(epistemicMuSd(-0.1, 100)).toBe(0);
  });

  it('is monotone non-increasing in N for fixed s', () => {
    const s = 0.5;
    let prev = Infinity;
    for (const N of [2, 5, 10, 100, 1000, 10000]) {
      const v = epistemicMuSd(s, N);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('epistemicSigmaSd', () => {
  // For large ν the scaled-inv-χ² posterior on σ² is approximately Gaussian
  // with SD ≈ σ √(2/ν), so σ has SD ≈ σ/√(2ν) by the delta method.
  it('approaches σ/√(2N) for large N', () => {
    const s = 0.5;
    const N = 10000;
    const asymptotic = s / Math.sqrt(2 * N);
    expect(epistemicSigmaSd(s, N)).toBeCloseTo(asymptotic, 3);
  });

  it('is finite at N = 2', () => {
    const v = epistemicSigmaSd(0.5, 2);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(0);
  });

  it('returns 0 when N < 2 or s <= 0', () => {
    expect(epistemicSigmaSd(0.5, 1)).toBe(0);
    expect(epistemicSigmaSd(0, 100)).toBe(0);
  });

  it('is monotone non-increasing in N for fixed s', () => {
    const s = 0.5;
    let prev = Infinity;
    for (const N of [2, 5, 10, 100, 1000, 10000]) {
      const v = epistemicSigmaSd(s, N);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('downstream contract — values in plausible Bayes posterior range', () => {
  // Sanity check against the prior heuristic that produced 1.25 × σ / √N.
  // For N=20, σ=0.6, the heuristic gave ~0.168 and qualityInflation could
  // double it. The principled formula gives the t-posterior interval-matched
  // value, which sits in a comparable order of magnitude but without the
  // arbitrary 1.25 factor.
  it('produces order-of-magnitude-comparable values to typical Bayes posteriors', () => {
    // N=20 converters with σ=0.6 — typical edge.
    const muSd = epistemicMuSd(0.6, 20);
    const sigmaSd = epistemicSigmaSd(0.6, 20);
    // Bayes posterior typical range: μ_sd 0.02–0.15, σ_sd 0.01–0.10.
    expect(muSd).toBeGreaterThan(0.05);
    expect(muSd).toBeLessThan(0.25);
    expect(sigmaSd).toBeGreaterThan(0.05);
    expect(sigmaSd).toBeLessThan(0.20);
  });

  it('collapses tightly for high N', () => {
    // N=20000 — saturated edge — should give very tight epistemic SDs.
    const muSd = epistemicMuSd(0.6, 20000);
    const sigmaSd = epistemicSigmaSd(0.6, 20000);
    expect(muSd).toBeLessThan(0.01);
    expect(sigmaSd).toBeLessThan(0.01);
  });
});

describe('rateRecentBlockPredictiveBeta — FE-topo predictive-rate estimator', () => {
  const buildDriftSeries = (days: number, rateStart: number, rateEnd: number, nPerDay: number) => {
    const nDaily: number[] = [];
    const kDaily: number[] = [];
    for (let i = 0; i < days; i++) {
      const localRate = rateStart + (rateEnd - rateStart) * (i / (days - 1));
      const k = Math.round(nPerDay * localRate);
      nDaily.push(nPerDay);
      kDaily.push(k);
    }
    return { nDaily, kDaily };
  };

  const buildMatureRows = (
    nDaily: number[],
    kDaily: number[],
    immatureTail: number,
    halfLife: number,
  ) => {
    const cutoff = nDaily.length - immatureTail;
    const rows: Array<{ n: number; k: number; weight: number; blockKey: number; x: number }> = [];
    const asOfIndex = nDaily.length - 1;
    for (let i = 0; i < cutoff; i++) {
      const age = asOfIndex - i;
      const w = Math.exp(-Math.LN2 * age / halfLife);
      rows.push({
        n: nDaily[i],
        k: kDaily[i],
        weight: w,
        blockKey: Math.floor(age / 7),
        x: age,
      });
    }
    return rows;
  };

  const betaSd = (alpha: number, beta: number) => {
    const s = alpha + beta;
    return Math.sqrt((alpha * beta) / (s * s * (s + 1)));
  };

  it('keeps smooth production-shaped drift from collapsing analytic predictive kappa near the floor', () => {
    const { nDaily, kDaily } = buildDriftSeries(190, 0.85, 0.35, 100);
    const raw = rateOverdispersionPredictiveBeta(nDaily, kDaily);
    const matureRows = buildMatureRows(nDaily, kDaily, 18, 30);
    const weightedMean =
      matureRows.reduce((sum, row) => sum + row.weight * row.k, 0) /
      matureRows.reduce((sum, row) => sum + row.weight * row.n, 0);
    const block = rateRecentBlockPredictiveBeta(matureRows, {
      mean: weightedMean,
      minKappa: 20,
    });

    expect(raw).toBeDefined();
    expect(block).toBeDefined();
    expect(raw!.kappa_pred).toBeLessThan(20);
    expect(block!.kappa_pred).toBeGreaterThanOrEqual(20);
    expect(betaSd(block!.alpha_pred, block!.beta_pred)).toBeLessThan(0.11);
  });

  it('still widens when recent mature weekly blocks have genuine residual volatility', () => {
    const days = 140;
    const nDaily: number[] = [];
    const kDaily: number[] = [];
    for (let i = 0; i < days; i++) {
      const n = 100;
      const trend = 0.72 - 0.18 * (i / (days - 1));
      const blockOffset = Math.floor(i / 7) % 2 === 0 ? 0.10 : -0.10;
      const rate = Math.max(0.05, Math.min(0.95, trend + blockOffset));
      const k = Math.round(n * rate);
      nDaily.push(n);
      kDaily.push(k);
    }
    const volatileRows = buildMatureRows(nDaily, kDaily, 18, 30);
    const smoothSeries = buildDriftSeries(days, 0.72, 0.54, 100);
    const smooth = buildMatureRows(
      smoothSeries.nDaily,
      smoothSeries.kDaily,
      18,
      30,
    );
    const volatileMean =
      volatileRows.reduce((sum, row) => sum + row.weight * row.k, 0) /
      volatileRows.reduce((sum, row) => sum + row.weight * row.n, 0);
    const smoothMean =
      smooth.reduce((sum, row) => sum + row.weight * row.k, 0) /
      smooth.reduce((sum, row) => sum + row.weight * row.n, 0);

    const volatile = rateRecentBlockPredictiveBeta(volatileRows, {
      mean: volatileMean,
      minKappa: 1,
    });
    const smoothResult = rateRecentBlockPredictiveBeta(smooth, {
      mean: smoothMean,
      minKappa: 1,
    });

    expect(volatile).toBeDefined();
    expect(smoothResult).toBeDefined();
    expect(volatile!.kappa_pred).toBeLessThan(smoothResult!.kappa_pred);
    expect(betaSd(volatile!.alpha_pred, volatile!.beta_pred)).toBeGreaterThan(
      betaSd(smoothResult!.alpha_pred, smoothResult!.beta_pred),
    );
  });

  it('does not emit near-uniform predictive Betas for stationary mature data', () => {
    const days = 150;
    const nDaily: number[] = [];
    const kDaily: number[] = [];
    for (let i = 0; i < days; i++) {
      const n = 80;
      const rate = 0.61 + 0.03 * Math.sin(i * 0.7) + 0.02 * Math.cos(i * 1.1);
      nDaily.push(n);
      kDaily.push(Math.round(n * rate));
    }
    const rows = buildMatureRows(nDaily, kDaily, 18, 30);
    const mean =
      rows.reduce((sum, row) => sum + row.weight * row.k, 0) /
      rows.reduce((sum, row) => sum + row.weight * row.n, 0);
    const result = rateRecentBlockPredictiveBeta(rows, { mean, minKappa: 20 });

    expect(result).toBeDefined();
    expect(result!.kappa_pred).toBeGreaterThanOrEqual(20);
    expect(betaSd(result!.alpha_pred, result!.beta_pred)).toBeLessThan(0.11);
  });
});
