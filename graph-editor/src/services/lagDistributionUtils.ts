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

// =============================================================================
// Posterior quantile helpers for epistemic dispersion of lognormal-fit
// parameters. Design: docs/current/codebase/EPISTEMIC_DISPERSION_DESIGN.md.
// Formulas: Gelman BDA3 §3.2 (Jeffreys-prior posterior on (μ, σ²) for the
// Gaussian inference problem on ln(t)). Numerical methods: Numerical
// Recipes 3rd ed §6.2 (lower incomplete gamma) and §6.4 (incomplete beta).
// =============================================================================

/**
 * Log gamma via the Lanczos approximation. Accurate to ~1e-14 for x > 0.5.
 */
function logGamma(x: number): number {
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  const g = 7;
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < c.length; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * Regularised lower incomplete gamma P(s, x) = γ(s, x) / Γ(s).
 * Series expansion for x < s + 1; modified Lentz continued fraction otherwise.
 */
function regularizedLowerGamma(s: number, x: number): number {
  if (x < 0 || s <= 0) return NaN;
  if (x === 0) return 0;
  const EPS = 3e-16;
  const FPMIN = 1e-300;
  const ITMAX = 200;
  const lnGammaS = logGamma(s);

  if (x < s + 1) {
    let ap = s;
    let sum = 1 / s;
    let del = sum;
    for (let n = 0; n < ITMAX; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * EPS) break;
    }
    return sum * Math.exp(-x + s * Math.log(x) - lnGammaS);
  }

  let b = x + 1 - s;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= ITMAX; i++) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return 1 - Math.exp(-x + s * Math.log(x) - lnGammaS) * h;
}

/**
 * Regularised incomplete beta I_x(a, b) via continued fraction.
 */
function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    -(logGamma(a) + logGamma(b) - logGamma(a + b))
      + a * Math.log(x) + b * Math.log(1 - x)
  );
  if (x < (a + 1) / (a + b + 2)) {
    return front * betaContinuedFraction(x, a, b) / a;
  }
  return 1 - front * betaContinuedFraction(1 - x, b, a) / b;
}

function betaContinuedFraction(x: number, a: number, b: number): number {
  const EPS = 3e-16;
  const FPMIN = 1e-300;
  const ITMAX = 200;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= ITMAX; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/**
 * Student-t CDF F(t; ν) = P(T ≤ t).
 * Uses the identity F(t) = 1 - ½·I_{ν/(ν+t²)}(ν/2, ½) for t > 0 (symmetric for t < 0).
 */
export function studentTCDF(t: number, dof: number): number {
  if (dof <= 0) return NaN;
  if (t === 0) return 0.5;
  const ib = regularizedIncompleteBeta(dof / (dof + t * t), dof / 2, 0.5);
  return t > 0 ? 1 - 0.5 * ib : 0.5 * ib;
}

/**
 * Student-t inverse CDF (quantile function). For p > 0.5 returns a positive value.
 * Bisection over the CDF; converges in ~40 iterations to ~1e-12 absolute.
 */
export function studentTQuantile(p: number, dof: number): number {
  if (dof <= 0) return NaN;
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;
  const upper = p > 0.5;
  const target = upper ? p : 1 - p;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 50 && studentTCDF(hi, dof) < target; i++) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (studentTCDF(mid, dof) < target) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-12 * Math.max(1, hi)) break;
  }
  const result = 0.5 * (lo + hi);
  return upper ? result : -result;
}

/**
 * Chi-squared CDF F(x; ν) = P(χ² ≤ x) = P(ν/2, x/2).
 */
export function chiSquaredCDF(x: number, dof: number): number {
  if (dof <= 0) return NaN;
  if (x <= 0) return 0;
  return regularizedLowerGamma(dof / 2, x / 2);
}

/**
 * Chi-squared inverse CDF (quantile function). Uses Wilson-Hilferty as initial
 * guess and refines via bisection.
 */
export function chiSquaredQuantile(p: number, dof: number): number {
  if (dof <= 0) return NaN;
  if (p <= 0) return 0;
  if (p >= 1) return Infinity;
  const z = standardNormalInverseCDF(p);
  const wh = dof * Math.pow(1 - 2 / (9 * dof) + z * Math.sqrt(2 / (9 * dof)), 3);
  let lo = Math.max(1e-10, wh * 0.5);
  let hi = Math.max(wh * 2, lo * 2 + 1);
  for (let i = 0; i < 50 && chiSquaredCDF(hi, dof) < p; i++) hi *= 2;
  for (let i = 0; i < 50 && chiSquaredCDF(lo, dof) > p; i++) lo *= 0.5;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (chiSquaredCDF(mid, dof) < p) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-12 * Math.max(1, hi)) break;
  }
  return 0.5 * (lo + hi);
}

/**
 * Effective SD of μ for the Jeffreys-prior posterior μ | data ~ t_{N-1}(ȳ, s²/N).
 * Interval-matched at the central 90% interval: returns the SD of the Gaussian
 * whose 90% interval coincides with the t-posterior's. Equals (s/√N) · t_{N-1, 0.95} / 1.6449.
 * Defined for every N ≥ 2; converges to s/√N as N → ∞.
 */
export function epistemicMuSd(s: number, N: number): number {
  if (!Number.isFinite(s) || s <= 0 || N < 2) return 0;
  const z95 = standardNormalInverseCDF(0.95);
  const tQ = studentTQuantile(0.95, N - 1);
  return (s / Math.sqrt(N)) * (tQ / z95);
}

/**
 * Effective SD of σ for the Jeffreys-prior posterior σ² | data ~ Inv-χ²(N-1, s²).
 * Interval-matched at the central 90% interval over σ (= sqrt of σ²).
 * Defined for every N ≥ 2.
 */
export function epistemicSigmaSd(s: number, N: number): number {
  if (!Number.isFinite(s) || s <= 0 || N < 2) return 0;
  const dof = N - 1;
  const z95 = standardNormalInverseCDF(0.95);
  const chiHi = chiSquaredQuantile(0.95, dof);
  const chiLo = chiSquaredQuantile(0.05, dof);
  const sigmaLo = Math.sqrt((dof * s * s) / chiHi);
  const sigmaHi = Math.sqrt((dof * s * s) / chiLo);
  return (sigmaHi - sigmaLo) / (2 * z95);
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
  totalK: number,
  maxMeanMedianRatioOverride?: number
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

  const maxMeanMedianRatio =
    (typeof maxMeanMedianRatioOverride === 'number' &&
      Number.isFinite(maxMeanMedianRatioOverride) &&
      maxMeanMedianRatioOverride > 0)
      ? maxMeanMedianRatioOverride
      : LATENCY_MAX_MEAN_MEDIAN_RATIO;

  if (ratio > maxMeanMedianRatio) {
    return {
      mu,
      sigma: LATENCY_DEFAULT_SIGMA,
      empirical_quality_ok: false,
      total_k: totalK,
      quality_failure_reason: `Mean/median ratio too high: ${ratio.toFixed(3)} > ${maxMeanMedianRatio}`,
    };
  }

  const sigma = Math.sqrt(2 * Math.log(ratio));
  // σ ≈ 0 when mean ≈ median (ratio ≈ 1): use default σ to avoid a degenerate
  // step-function CDF that produces binary completeness with no smooth transition.
  if (sigma < 1e-12) {
    return {
      mu,
      sigma: LATENCY_DEFAULT_SIGMA,
      empirical_quality_ok: true,
      total_k: totalK,
      quality_failure_reason: 'Mean/median ratio ≈ 1.0 (σ degenerate), using default σ',
    };
  }
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

// =============================================================================
// Onset conversion helper (user-space ↔ model-space)
// =============================================================================

/**
 * Small positive clamp (days) to prevent degenerate log operations after onset subtraction.
 *
 * Rationale:
 * - Model-space lag values are used inside ln(·) and must be > 0.
 * - If onset ≥ observed horizon, the correct limiting behaviour is "almost immediate" post-onset
 *   conversion with a very negative μ (but still finite), not NaN/Infinity.
 *
 * This value is deliberately tiny relative to "days" semantics.
 */
const ONSET_EPSILON_DAYS = 1e-6;

function normaliseOnsetDeltaDays(onsetDeltaDays?: number): number {
  if (typeof onsetDeltaDays !== 'number' || !Number.isFinite(onsetDeltaDays)) return 0;
  return Math.max(0, onsetDeltaDays);
}

function clampPositiveDays(valueDays: number): number {
  if (!Number.isFinite(valueDays)) return ONSET_EPSILON_DAYS;
  return valueDays > ONSET_EPSILON_DAYS ? valueDays : ONSET_EPSILON_DAYS;
}

export type ToModelSpaceResult = {
  onsetDeltaDays: number;
  medianXDays: number;
  meanXDays?: number;
  t95XDays?: number;
  ageXDays?: number;
};

/**
 * Convert a user-space positive day value (lag/horizon) into model-space (post-onset) days.
 * Result is clamped to a small positive epsilon.
 */
export function toModelSpaceLagDays(onsetDeltaDays: number | undefined, valueTDays: number): number {
  const delta = normaliseOnsetDeltaDays(onsetDeltaDays);
  return clampPositiveDays(valueTDays - delta);
}

/**
 * Convert a user-space cohort age (days since cohort start) into model-space age (post-onset).
 * Result is clamped at 0 (dead-time).
 */
export function toModelSpaceAgeDays(onsetDeltaDays: number | undefined, ageTDays: number): number {
  const delta = normaliseOnsetDeltaDays(onsetDeltaDays);
  if (!Number.isFinite(ageTDays)) return 0;
  return Math.max(0, ageTDays - delta);
}

/**
 * Convert user-space (T-space) latency values into model-space (X-space) values.
 *
 * Definitions:
 * - T = δ + X, where δ = onset_delta_days (dead-time), X is the post-onset stochastic lag.
 * - User-space values (persisted/displayed) are in T-space and include δ.
 * - Model-space values (used for fitting/CDF evaluation) are in X-space and exclude δ.
 *
 * Behaviour:
 * - median/mean/t95 are shifted by subtracting δ and clamped to a small positive epsilon.
 * - age is shifted by subtracting δ and clamped at 0 (dead-time → exactly 0 completeness).
 */
export function toModelSpace(
  onsetDeltaDays: number | undefined,
  medianTDays: number,
  meanTDays?: number,
  t95TDays?: number,
  ageTDays?: number
): ToModelSpaceResult {
  const delta = normaliseOnsetDeltaDays(onsetDeltaDays);

  const medianXDays = toModelSpaceLagDays(delta, medianTDays);
  const meanXDays = typeof meanTDays === 'number' ? toModelSpaceLagDays(delta, meanTDays) : undefined;
  const t95XDays = typeof t95TDays === 'number' ? toModelSpaceLagDays(delta, t95TDays) : undefined;
  const ageXDays = typeof ageTDays === 'number' ? toModelSpaceAgeDays(delta, ageTDays) : undefined;

  return { onsetDeltaDays: delta, medianXDays, meanXDays, t95XDays, ageXDays };
}


