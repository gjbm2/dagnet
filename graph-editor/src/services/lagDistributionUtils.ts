/**
 * Lag distribution utilities (pure maths)
 *
 * Single source of truth for lognormal fitting and quantiles.
 * Intentionally free of service dependencies (no session logging, no graph, no DB).
 *
 * Used by:
 * - statisticalEnhancementService (graph-level LAG orchestration)
 * - lagMixtureAggregationService (MECE mixture medians)
 *
 * Behaviour is locked in by:
 * - src/services/__tests__/lagDistribution.golden.test.ts
 */
import {
  LATENCY_DEFAULT_SIGMA,
  LATENCY_MAX_MEAN_MEDIAN_RATIO,
  LATENCY_MIN_FIT_CONVERTERS,
  LATENCY_MIN_MEAN_MEDIAN_RATIO,
} from '../constants/latency';

/**
 * Fitted log-normal distribution parameters.
 * See design.md §5.4.1 for the log-normal CDF formula.
 */
export interface LagDistributionFit {
  /** μ parameter (location) - ln(median) */
  mu: number;
  /** σ parameter (scale/spread) */
  sigma: number;
  /** Whether the fit passed quality gates */
  empirical_quality_ok: boolean;
  /** Total converters used for fitting */
  total_k: number;
  /** Reason if quality failed */
  quality_failure_reason?: string;
}

/**
 * Error function (erf) approximation.
 * Uses Horner form of the approximation from Abramowitz & Stegun (1964).
 * Maximum error: 1.5 × 10⁻⁷
 */
export function erf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);

  const t = 1.0 / (1.0 + p * x);
  const y =
    1.0 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) *
      Math.exp(-x * x);

  return sign * y;
}

/**
 * Standard normal CDF (Φ) using the error function approximation.
 * Φ(x) = 0.5 * (1 + erf(x / sqrt(2)))
 */
export function standardNormalCDF(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * Inverse standard normal CDF (Φ⁻¹) - quantile function.
 * Uses the Acklam approximation with high accuracy.
 */
export function standardNormalInverseCDF(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;

  const a = [
    -3.969683028665376e1,
    2.209460984245205e2,
    -2.759285104469687e2,
    1.38357751867269e2,
    -3.066479806614716e1,
    2.506628277459239e0,
  ];
  const b = [
    -5.447609879822406e1,
    1.615858368580409e2,
    -1.556989798598866e2,
    6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3,
    -3.223964580411365e-1,
    -2.400758277161838e0,
    -2.549732539343734e0,
    4.374664141464968e0,
    2.938163982698783e0,
  ];
  const d = [
    7.784695709041462e-3,
    3.224671290700398e-1,
    2.445134137142996e0,
    3.754408661907416e0,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  let q: number;
  let r: number;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q +
        c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (
      (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r +
        a[5]) *
        q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q +
        c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
}

/**
 * Log-normal CDF.
 * F(t) = Φ((ln(t) - μ) / σ)
 */
export function logNormalCDF(t: number, mu: number, sigma: number): number {
  if (t <= 0) return 0;
  if (sigma <= 0) {
    return t >= Math.exp(mu) ? 1 : 0;
  }
  return standardNormalCDF((Math.log(t) - mu) / sigma);
}

export function logNormalSurvival(t: number, mu: number, sigma: number): number {
  return 1 - logNormalCDF(t, mu, sigma);
}

/**
 * Log-normal inverse CDF (quantile function).
 * Returns t such that F(t) = p.
 */
export function logNormalInverseCDF(p: number, mu: number, sigma: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return Infinity;
  return Math.exp(mu + sigma * standardNormalInverseCDF(p));
}

/**
 * Fit log-normal distribution from median and mean lag data.
 *
 * From design.md §5.4.2:
 * - μ = ln(median)
 * - σ = sqrt(2 * ln(mean/median))
 */
export function fitLagDistribution(
  medianLag: number,
  meanLag: number | undefined,
  totalK: number
): LagDistributionFit {
  if (!Number.isFinite(medianLag)) {
    return {
      mu: 0,
      sigma: LATENCY_DEFAULT_SIGMA,
      empirical_quality_ok: false,
      total_k: totalK,
      quality_failure_reason: `Invalid median lag (non-finite): ${String(medianLag)}`,
    };
  }

  if (totalK < LATENCY_MIN_FIT_CONVERTERS) {
    return {
      mu: medianLag > 0 ? Math.log(medianLag) : 0,
      sigma: LATENCY_DEFAULT_SIGMA,
      empirical_quality_ok: false,
      total_k: totalK,
      quality_failure_reason: `Insufficient converters: ${totalK} < ${LATENCY_MIN_FIT_CONVERTERS}`,
    };
  }

  if (medianLag <= 0) {
    return {
      mu: 0,
      sigma: LATENCY_DEFAULT_SIGMA,
      empirical_quality_ok: false,
      total_k: totalK,
      quality_failure_reason: `Invalid median lag: ${medianLag}`,
    };
  }

  const mu = Math.log(medianLag);

  if (meanLag === undefined || meanLag <= 0) {
    return {
      mu,
      sigma: LATENCY_DEFAULT_SIGMA,
      empirical_quality_ok: true,
      total_k: totalK,
      quality_failure_reason: 'Mean lag not available, using default σ',
    };
  }

  const ratio = meanLag / medianLag;
  if (ratio < 1.0) {
    const isCloseToOne = ratio >= LATENCY_MIN_MEAN_MEDIAN_RATIO;
    return {
      mu,
      sigma: LATENCY_DEFAULT_SIGMA,
      empirical_quality_ok: isCloseToOne,
      total_k: totalK,
      quality_failure_reason: isCloseToOne
        ? `Mean/median ratio ${ratio.toFixed(3)} < 1.0 (using default σ)`
        : `Mean/median ratio too low: ${ratio.toFixed(3)} < ${LATENCY_MIN_MEAN_MEDIAN_RATIO}`,
    };
  }

  if (ratio > LATENCY_MAX_MEAN_MEDIAN_RATIO) {
    return {
      mu,
      sigma: LATENCY_DEFAULT_SIGMA,
      empirical_quality_ok: false,
      total_k: totalK,
      quality_failure_reason: `Mean/median ratio too high: ${ratio.toFixed(3)} > ${LATENCY_MAX_MEAN_MEDIAN_RATIO}`,
    };
  }

  const sigma = Math.sqrt(2 * Math.log(ratio));
  // σ = 0 is a valid degenerate lognormal when mean == median (ratio == 1).
  if (!Number.isFinite(sigma) || sigma < 0) {
    return {
      mu,
      sigma: LATENCY_DEFAULT_SIGMA,
      empirical_quality_ok: false,
      total_k: totalK,
      quality_failure_reason: `Invalid sigma computed from ratio ${ratio.toFixed(3)}`,
    };
  }

  return {
    mu,
    sigma,
    empirical_quality_ok: true,
    total_k: totalK,
  };
}


