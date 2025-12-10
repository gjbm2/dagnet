/**
 * Statistical Enhancement Service
 * 
 * Plugin point for statistical enhancement methods including:
 * - Basic enhancers (NoOp, inverse-variance)
 * - LAG (Latency-Aware Graph) functions for conversion forecasting
 * 
 * LAG Architecture (design.md §5):
 *   Per-cohort data → Lag CDF fitting → Formula A → p.mean, completeness
 * 
 * Original Architecture:
 *   RawAggregation → StatisticalEnhancementService → EnhancedAggregation
 */

import type { RawAggregation } from './windowAggregationService';
import { graphComputeClient } from '../lib/graphComputeClient';
import type { StatsEnhanceResponse } from '../lib/graphComputeClient';
import {
  LATENCY_MIN_FIT_CONVERTERS,
  LATENCY_MIN_MEAN_MEDIAN_RATIO,
  LATENCY_MAX_MEAN_MEDIAN_RATIO,
  LATENCY_DEFAULT_SIGMA,
  LATENCY_EPSILON,
  LATENCY_T95_PERCENTILE,
} from '../constants/latency';
import { RECENCY_HALF_LIFE_DAYS } from '../constants/statisticalConstants';

export interface EnhancedAggregation {
  method: string;
  n: number;
  k: number;
  mean: number;
  stdev: number;
  confidence_interval?: [number, number] | null;
  trend?: {
    direction: 'increasing' | 'decreasing' | 'stable';
    slope: number;
    significance: number;
  } | null;
  metadata: {
    raw_method: string;
    enhancement_method: string;
    data_points: number;
  };
}

export interface StatisticalEnhancer {
  enhance(raw: RawAggregation): EnhancedAggregation;
}

/**
 * Python stats service client interface
 * For heavy computations (MCMC, complex Bayesian inference, etc.)
 */
interface PythonStatsService {
  enhance(raw: RawAggregation, method: string): Promise<EnhancedAggregation>;
}

/**
 * Python stats service client implementation using GraphComputeClient
 */
class PythonStatsServiceClient implements PythonStatsService {
  async enhance(raw: RawAggregation, method: string): Promise<EnhancedAggregation> {
    // Call Python API via GraphComputeClient
    const response: StatsEnhanceResponse = await graphComputeClient.enhanceStats(
      {
        method: raw.method,
        n: raw.n,
        k: raw.k,
        mean: raw.mean,
        stdev: raw.stdev,
        raw_data: raw.raw_data,
        window: raw.window,
        days_included: raw.days_included,
        days_missing: raw.days_missing,
      },
      method
    );

    // Convert response to EnhancedAggregation format
    return {
      method: response.method,
      n: response.n,
      k: response.k,
      mean: response.mean,
      stdev: response.stdev,
      confidence_interval: response.confidence_interval ?? null,
      trend: response.trend ?? null,
      metadata: response.metadata,
    };
  }
}

/**
 * No-op enhancer - passes through raw aggregation unchanged
 */
export class NoOpEnhancer implements StatisticalEnhancer {
  enhance(raw: RawAggregation): EnhancedAggregation {
    return {
      method: raw.method,
      n: raw.n,
      k: raw.k,
      mean: raw.mean,
      stdev: raw.stdev,
      confidence_interval: null,
      trend: null,
      metadata: {
        raw_method: raw.method,
        enhancement_method: 'none',
        data_points: raw.days_included,
      },
    };
  }
}

/**
 * Inverse-variance weighting enhancer
 * 
 * Recalculates mean using inverse-variance weighting from daily data.
 * This gives more weight to days with larger sample sizes and accounts for variance.
 * 
 * Formula: p = Σ(w_i × p_i) / Σ(w_i) where w_i = n_i / (p_i × (1 - p_i))
 */
export class InverseVarianceEnhancer implements StatisticalEnhancer {
  enhance(raw: RawAggregation): EnhancedAggregation {
    // If no daily data, fall back to naive result
    if (!raw.raw_data || raw.raw_data.length === 0) {
      return {
        method: 'inverse-variance',
        n: raw.n,
        k: raw.k,
        mean: raw.mean,
        stdev: raw.stdev,
        confidence_interval: null,
        trend: null,
        metadata: {
          raw_method: raw.method,
          enhancement_method: 'inverse-variance',
          data_points: raw.days_included,
        },
      };
    }

    // CRITICAL: Use simple mean (k/n) as the primary calculation.
    // 
    // Inverse-variance weighting was causing issues because:
    // 1. Days with p=0 (e.g., weekends, data lag) aren't "estimates of 0%" - they're outliers
    // 2. These days get massive weight: n/0.01 = 100×n when p=0
    // 3. This distorts the weighted mean (e.g., 56% actual → 16% weighted)
    //
    // The simple mean (k/n) is the CORRECT observed conversion rate over the period.
    // For funnel data, each day's data is not an independent "estimate" to combine -
    // it's actual observed data, and the aggregate is simply total_k / total_n.
    
    // Use simple mean: this is the actual observed conversion rate
    const simpleMean = raw.n > 0 ? raw.k / raw.n : 0;
    const finalMean = Math.round(simpleMean * 1000) / 1000; // Round to 3 decimal places
    
    // CRITICAL: k is the actual observed success count - it's EVIDENCE, not an estimate.
    // We preserve raw.k (the sum of all k_daily values).
    // Users need to see actual observed k, not a derived value.
    
    // Recalculate stdev using simple mean
    const finalStdev = raw.n > 0 
      ? Math.sqrt((finalMean * (1 - finalMean)) / raw.n)
      : 0;

    return {
      method: 'inverse-variance',
      n: raw.n,
      k: raw.k,  // PRESERVE actual observed k
      mean: finalMean,  // Use simple mean (k/n) - the actual observed conversion rate
      stdev: finalStdev,
      confidence_interval: null,
      trend: null,
      metadata: {
        raw_method: raw.method,
        enhancement_method: 'inverse-variance',
        data_points: raw.days_included,
      },
    };
  }
}

/**
 * Statistical Enhancement Service
 * 
 * Provides a plugin architecture for statistical enhancement methods.
 * Routes simple operations to TypeScript enhancers (fast, synchronous)
 * and complex operations to Python service (heavy lifting, async).
 * 
 * Local (TS) methods:
 * - 'none': No-op pass-through
 * - 'inverse-variance': Weighted average by precision
 * 
 * Python methods (offloaded):
 * - 'mcmc': MCMC sampling for Bayesian inference
 * - 'bayesian-complex': Complex Bayesian models with custom priors
 * - 'trend-aware': ML-based trend detection
 * - 'robust': Robust statistics with outlier detection
 */
export class StatisticalEnhancementService {
  private enhancers: Map<string, StatisticalEnhancer> = new Map();
  private pythonService: PythonStatsService;

  constructor(pythonService?: PythonStatsService) {
    // Register default TypeScript enhancers
    this.registerEnhancer('none', new NoOpEnhancer());
    this.registerEnhancer('inverse-variance', new InverseVarianceEnhancer());
    
    // Initialize Python service (stub for now)
    this.pythonService = pythonService || new PythonStatsServiceClient();
  }

  /**
   * Register a new TypeScript enhancement method
   */
  registerEnhancer(name: string, enhancer: StatisticalEnhancer): void {
    this.enhancers.set(name, enhancer);
  }

  /**
   * Determine if a method should be offloaded to Python
   * 
   * Python methods are computationally expensive and benefit from NumPy/SciPy:
   * - MCMC sampling
   * - Complex Bayesian inference
   * - ML-based trend detection
   * - Large matrix operations
   */
  private shouldOffloadToPython(method: string): boolean {
    const pythonMethods = [
      'mcmc',
      'bayesian-complex',
      'trend-aware',
      'robust',
      'bayesian', // Alias for bayesian-complex
    ];
    
    return pythonMethods.includes(method.toLowerCase());
  }

  /**
   * Enhance raw aggregation with statistical method
   * 
   * Routes to TypeScript enhancers for simple operations (synchronous)
   * or Python service for complex operations (async).
   * 
   * @param raw Raw aggregation result
   * @param method Enhancement method
   * @returns Enhanced aggregation (Promise for Python methods, sync for TS methods)
   */
  enhance(raw: RawAggregation, method: string = 'inverse-variance'): EnhancedAggregation | Promise<EnhancedAggregation> {
    // Check if method should be offloaded to Python
    if (this.shouldOffloadToPython(method)) {
      return this.pythonService.enhance(raw, method);
    }

    // Use local TypeScript enhancer
    const enhancer = this.enhancers.get(method);
    
    if (!enhancer) {
      console.warn(`Unknown enhancement method: ${method}, falling back to 'none'`);
      const noOpEnhancer = this.enhancers.get('none')!;
      return noOpEnhancer.enhance(raw);
    }

    return enhancer.enhance(raw);
  }
}

// Singleton instance
export const statisticalEnhancementService = new StatisticalEnhancementService();

// =============================================================================
// LAG (Latency-Aware Graph) Statistical Functions
// Design reference: design.md §5.3-5.6
// =============================================================================

/**
 * Per-cohort data for latency calculations.
 * Represents one day's worth of cohort entries and their conversion data.
 */
export interface CohortData {
  /** Cohort entry date (d-MMM-yy format) */
  date: string;
  /** Number of users in this cohort (entered on this date) */
  n: number;
  /** Number of conversions observed from this cohort */
  k: number;
  /** Age of cohort in days (from entry to query date) */
  age: number;
  /** Median lag in days for converters in this cohort (optional) */
  median_lag_days?: number;
  /** Mean lag in days for converters in this cohort (optional) */
  mean_lag_days?: number;
}

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
 * Result of Formula A application to cohort data.
 * See design.md §5.3 for the derivation.
 */
export interface FormulaAResult {
  /** Blended probability (evidence + forecasted tail) */
  p_mean: number;
  /** Completeness measure (0-1) - fraction of eventual conversions observed */
  completeness: number;
  /** Sum of expected eventual conversions */
  total_k_hat: number;
  /** Sum of cohort sizes */
  total_n: number;
  /** Asymptotic conversion probability from mature cohorts */
  p_infinity: number;
  /** 95th percentile lag (time by which 95% of converters have converted) */
  t95: number;
  /** Per-cohort breakdown (for debugging/display) */
  cohort_details?: Array<{
    date: string;
    n: number;
    k: number;
    age: number;
    F_age: number;  // CDF at this age
    k_hat: number;  // Expected eventual conversions
  }>;
}

/**
 * Result of computing edge latency statistics.
 * This is the main output type for latency-enabled edges.
 */
export interface EdgeLatencyStats {
  /** Fitted lag distribution */
  fit: LagDistributionFit;
  /** 95th percentile lag in days */
  t95: number;
  /** Asymptotic conversion probability */
  p_infinity: number;
  /** Blended probability from Formula A */
  p_mean: number;
  /** Completeness measure (0-1) */
  completeness: number;
  /** Evidence probability (observed k/n) */
  p_evidence: number;
  /** Whether forecast is available (requires valid fit and p_infinity) */
  forecast_available: boolean;
}

// =============================================================================
// Mathematical Utility Functions
// =============================================================================

/**
 * Standard normal CDF (Φ) using the error function approximation.
 * Φ(x) = 0.5 * (1 + erf(x / sqrt(2)))
 * 
 * @param x - Input value
 * @returns Probability P(Z ≤ x) where Z ~ N(0,1)
 */
export function standardNormalCDF(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * Error function (erf) approximation.
 * Uses Horner form of the approximation from Abramowitz & Stegun (1964).
 * Maximum error: 1.5 × 10⁻⁷
 * 
 * @param x - Input value
 * @returns erf(x)
 */
export function erf(x: number): number {
  // Constants for the approximation
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;

  // Save the sign of x
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);

  // A&S formula 7.1.26
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return sign * y;
}

/**
 * Inverse standard normal CDF (Φ⁻¹) - quantile function.
 * Uses the Acklam approximation with high accuracy.
 * 
 * @param p - Probability (0 < p < 1)
 * @returns x such that Φ(x) = p
 */
export function standardNormalInverseCDF(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;

  // Coefficients for the rational approximation
  const a = [
    -3.969683028665376e+01,
     2.209460984245205e+02,
    -2.759285104469687e+02,
     1.383577518672690e+02,
    -3.066479806614716e+01,
     2.506628277459239e+00,
  ];
  const b = [
    -5.447609879822406e+01,
     1.615858368580409e+02,
    -1.556989798598866e+02,
     6.680131188771972e+01,
    -1.328068155288572e+01,
  ];
  const c = [
    -7.784894002430293e-03,
    -3.223964580411365e-01,
    -2.400758277161838e+00,
    -2.549732539343734e+00,
     4.374664141464968e+00,
     2.938163982698783e+00,
  ];
  const d = [
     7.784695709041462e-03,
     3.224671290700398e-01,
     2.445134137142996e+00,
     3.754408661907416e+00,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  let q: number, r: number;

  if (p < pLow) {
    // Rational approximation for lower region
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    // Rational approximation for central region
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    // Rational approximation for upper region
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
}

// =============================================================================
// Log-Normal Distribution Functions
// =============================================================================

/**
 * Log-normal CDF.
 * F(t) = Φ((ln(t) - μ) / σ)
 * 
 * See design.md §5.4.1
 * 
 * @param t - Time value (must be > 0)
 * @param mu - Location parameter (ln of median)
 * @param sigma - Scale parameter
 * @returns P(T ≤ t) where T ~ LogNormal(μ, σ)
 */
export function logNormalCDF(t: number, mu: number, sigma: number): number {
  if (t <= 0) return 0;
  if (sigma <= 0) {
    // Degenerate case: all mass at exp(mu)
    return t >= Math.exp(mu) ? 1 : 0;
  }
  return standardNormalCDF((Math.log(t) - mu) / sigma);
}

/**
 * Log-normal survival function (complement of CDF).
 * S(t) = 1 - F(t) = P(T > t)
 * 
 * @param t - Time value (must be > 0)
 * @param mu - Location parameter
 * @param sigma - Scale parameter
 * @returns P(T > t)
 */
export function logNormalSurvival(t: number, mu: number, sigma: number): number {
  return 1 - logNormalCDF(t, mu, sigma);
}

/**
 * Log-normal inverse CDF (quantile function).
 * Returns t such that F(t) = p.
 * 
 * @param p - Probability (0 < p < 1)
 * @param mu - Location parameter
 * @param sigma - Scale parameter
 * @returns Quantile value
 */
export function logNormalInverseCDF(p: number, mu: number, sigma: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return Infinity;
  return Math.exp(mu + sigma * standardNormalInverseCDF(p));
}

// =============================================================================
// Lag Distribution Fitting
// =============================================================================

/**
 * Fit log-normal distribution from median and mean lag data.
 * 
 * From design.md §5.4.2:
 * - μ = ln(median)
 * - σ = sqrt(2 * ln(mean/median))
 * 
 * @param medianLag - Median lag in days
 * @param meanLag - Mean lag in days (optional, uses default σ if not provided)
 * @param totalK - Total converters (for quality gate)
 * @returns Fitted distribution parameters
 */
export function fitLagDistribution(
  medianLag: number,
  meanLag: number | undefined,
  totalK: number
): LagDistributionFit {
  // Guard against non-finite medianLag (undefined/NaN) early to avoid NaN propagation
  if (!Number.isFinite(medianLag)) {
    return {
      mu: 0,
      sigma: LATENCY_DEFAULT_SIGMA,
      empirical_quality_ok: false,
      total_k: totalK,
      quality_failure_reason: `Invalid median lag (non-finite): ${String(medianLag)}`,
    };
  }
  // Quality gate: minimum converters
  if (totalK < LATENCY_MIN_FIT_CONVERTERS) {
    return {
      mu: medianLag > 0 ? Math.log(medianLag) : 0,
      sigma: LATENCY_DEFAULT_SIGMA,
      empirical_quality_ok: false,
      total_k: totalK,
      quality_failure_reason: `Insufficient converters: ${totalK} < ${LATENCY_MIN_FIT_CONVERTERS}`,
    };
  }

  // Edge case: zero or negative median
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

  // If mean not available, fall back to default σ but ALLOW fit to be used.
  // We have valid median, so we can compute a reasonable t95 with default σ.
  if (meanLag === undefined || meanLag <= 0) {
    return {
      mu,
      sigma: LATENCY_DEFAULT_SIGMA,
      empirical_quality_ok: true,  // Allow fit - we have valid median
      total_k: totalK,
      quality_failure_reason: 'Mean lag not available, using default σ',
    };
  }

  // Check mean/median ratio
  const ratio = meanLag / medianLag;
  
  // CRITICAL: Math requires ratio >= 1.0 for valid sigma calculation.
  // sigma = sqrt(2 * ln(ratio)) → ln(ratio) must be >= 0 → ratio must be >= 1.0
  // For ratios < 1.0 (mean < median, which shouldn't happen for log-normal but can
  // occur due to data noise), use default sigma but allow fit to proceed if ratio
  // is close to 1.0 (i.e., >= LATENCY_MIN_MEAN_MEDIAN_RATIO).
  if (ratio < 1.0) {
    // Ratio below 1.0 means we can't compute sigma from the formula.
    // If it's close to 1.0 (>= 0.9), treat as valid but use default sigma.
    // If it's too low (< 0.9), mark as quality failure.
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

  // Compute sigma from mean/median ratio
  // mean/median = exp(σ²/2) → σ = sqrt(2 * ln(mean/median))
  const sigma = Math.sqrt(2 * Math.log(ratio));

  return {
    mu,
    sigma,
    empirical_quality_ok: true,
    total_k: totalK,
  };
}

/**
 * Compute t95 (95th percentile) from fitted distribution.
 * This is the time by which 95% of eventual converters have converted.
 * 
 * @param fit - Fitted distribution
 * @param maturityDays - Fallback if fit is not valid
 * @returns t95 in days
 */
export function computeT95(fit: LagDistributionFit, maturityDays: number): number {
  if (fit.empirical_quality_ok) {
    return logNormalInverseCDF(LATENCY_T95_PERCENTILE, fit.mu, fit.sigma);
  }
  // Fallback to user-configured maturity days
  return maturityDays;
}

// =============================================================================
// P-Infinity Estimation (§5.6, Appendix C.1)
// =============================================================================

/**
 * Compute recency weight for a cohort.
 * 
 * w = exp(-age / H)
 * 
 * where H is the half-life in days (RECENCY_HALF_LIFE_DAYS).
 * A cohort H days old has half the weight of a brand-new cohort.
 * 
 * @param age - Cohort age in days
 * @returns Weight in (0, 1]
 */
function computeRecencyWeight(age: number): number {
  return Math.exp(-age / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Estimate asymptotic conversion probability from mature cohorts.
 * 
 * Uses recency-weighted averaging (design.md Appendix C.1):
 *   p_∞ = Σ(w_i × k_i) / Σ(w_i × n_i)
 * 
 * where w_i = exp(-age_i / H) and H = RECENCY_HALF_LIFE_DAYS.
 * 
 * This favours recent mature cohorts over older ones, making p_∞ responsive
 * to changes in conversion behaviour while still being based on mature data.
 * 
 * See design.md §5.6, Appendix C.1
 * 
 * @param cohorts - Array of cohort data
 * @param t95 - Maturity threshold (cohorts older than this are "mature")
 * @returns Asymptotic probability, or undefined if no mature cohorts
 */
export function estimatePInfinity(cohorts: CohortData[], t95: number): number | undefined {
  // Filter to mature cohorts (age >= t95)
  const matureCohorts = cohorts.filter(c => c.age >= t95);
  
  if (matureCohorts.length === 0) {
    return undefined;
  }

  // Recency-weighted sums (design.md Appendix C.1)
  let weightedN = 0;
  let weightedK = 0;
  
  for (const c of matureCohorts) {
    const w = computeRecencyWeight(c.age);
    weightedN += w * c.n;
    weightedK += w * c.k;
  }

  if (weightedN === 0) {
    return undefined;
  }

  return weightedK / weightedN;
}

// =============================================================================
// Formula A: Bayesian Forecasting (§5.3)
// =============================================================================

/**
 * Apply Formula A to forecast eventual conversions for a single cohort.
 * 
 * k̂_i = k_i + (n_i - k_i) × (p_∞ × S(a_i)) / (1 - p_∞ × F(a_i))
 * 
 * See design.md §5.3
 * 
 * @param cohort - Cohort data (n, k, age)
 * @param pInfinity - Asymptotic conversion probability
 * @param mu - Log-normal μ parameter
 * @param sigma - Log-normal σ parameter
 * @returns Expected eventual conversions for this cohort
 */
export function applyFormulaA(
  cohort: CohortData,
  pInfinity: number,
  mu: number,
  sigma: number
): number {
  const { n, k, age } = cohort;

  // Edge case: no users in cohort
  if (n === 0) return 0;

  // Compute F(age) and S(age)
  const F_age = logNormalCDF(age, mu, sigma);
  const S_age = 1 - F_age;

  // Mature cohort: all conversions observed
  if (F_age >= 1 - LATENCY_EPSILON) {
    return k;
  }

  // Denominator: 1 - p_∞ × F(a_i)
  const denominator = 1 - pInfinity * F_age;

  // Guard against division by zero or blow-up
  if (denominator < LATENCY_EPSILON) {
    // Fall back to observed k (conservative)
    return k;
  }

  // Formula A: k̂_i = k_i + (n_i - k_i) × (p_∞ × S(a_i)) / (1 - p_∞ × F(a_i))
  const unconverted = n - k;
  const forecastedTail = unconverted * (pInfinity * S_age) / denominator;

  return k + forecastedTail;
}

/**
 * Apply Formula A to all cohorts and compute aggregate statistics.
 * 
 * @param cohorts - Array of cohort data
 * @param pInfinity - Asymptotic probability (from mature cohorts)
 * @param fit - Fitted lag distribution
 * @param maturityDays - Fallback maturity threshold
 * @param includeDetails - Whether to include per-cohort breakdown
 * @returns Formula A result with p_mean, completeness, t95
 */
export function applyFormulaAToAll(
  cohorts: CohortData[],
  pInfinity: number,
  fit: LagDistributionFit,
  maturityDays: number,
  includeDetails: boolean = false
): FormulaAResult {
  const { mu, sigma } = fit;
  const t95 = computeT95(fit, maturityDays);

  let totalN = 0;
  let totalKHat = 0;
  let weightedCompleteness = 0;
  const details: FormulaAResult['cohort_details'] = includeDetails ? [] : undefined;

  for (const cohort of cohorts) {
    if (cohort.n === 0) continue;

    const F_age = logNormalCDF(cohort.age, mu, sigma);
    const kHat = applyFormulaA(cohort, pInfinity, mu, sigma);

    totalN += cohort.n;
    totalKHat += kHat;
    weightedCompleteness += cohort.n * F_age;

    if (details) {
      details.push({
        date: cohort.date,
        n: cohort.n,
        k: cohort.k,
        age: cohort.age,
        F_age,
        k_hat: kHat,
      });
    }
  }

  // Aggregate results
  const pMean = totalN > 0 ? totalKHat / totalN : 0;
  const completeness = totalN > 0 ? weightedCompleteness / totalN : 0;

  return {
    p_mean: pMean,
    completeness,
    total_k_hat: totalKHat,
    total_n: totalN,
    p_infinity: pInfinity,
    t95,
    cohort_details: details,
  };
}

// =============================================================================
// Completeness Calculation (§5.5)
// =============================================================================

/**
 * Calculate completeness from cohort data and fitted distribution.
 * 
 * completeness = Σ(n_i × F(a_i)) / Σn_i
 * 
 * See design.md §5.5
 * 
 * @param cohorts - Array of cohort data
 * @param mu - Log-normal μ parameter
 * @param sigma - Log-normal σ parameter
 * @returns Completeness measure (0-1)
 */
export function calculateCompleteness(
  cohorts: CohortData[],
  mu: number,
  sigma: number
): number {
  let totalN = 0;
  let weightedSum = 0;

  for (const cohort of cohorts) {
    if (cohort.n === 0) continue;
    const F_age = logNormalCDF(cohort.age, mu, sigma);
    totalN += cohort.n;
    weightedSum += cohort.n * F_age;
  }

  return totalN > 0 ? weightedSum / totalN : 0;
}

// =============================================================================
// Main Edge Latency Computation
// =============================================================================

/**
 * Compute full latency statistics for an edge from cohort data.
 * 
 * This is the main entry point for LAG calculations. It:
 * 1. Fits the lag distribution from aggregate median/mean
 * 2. Computes t95 (95th percentile lag)
 * 3. Estimates p_infinity from mature cohorts
 * 4. Applies Formula A to compute p_mean and completeness
 * 
 * @param cohorts - Per-cohort data array
 * @param aggregateMedianLag - Weighted aggregate median lag
 * @param aggregateMeanLag - Weighted aggregate mean lag (optional)
 * @param maturityDays - User-configured maturity threshold
 * @param pathT95 - Cumulative t95 from anchor to this edge's source node (for downstream edges)
 * @returns Full edge latency statistics
 */
export function computeEdgeLatencyStats(
  cohorts: CohortData[],
  aggregateMedianLag: number,
  aggregateMeanLag: number | undefined,
  maturityDays: number,
  pathT95: number = 0
): EdgeLatencyStats {
  // Calculate total k for quality gate
  const totalK = cohorts.reduce((sum, c) => sum + c.k, 0);
  const totalN = cohorts.reduce((sum, c) => sum + c.n, 0);

  // DEBUG: Log input values
  console.log('[LAG_DEBUG] COMPUTE_STATS input:', {
    cohortsCount: cohorts.length,
    aggregateMedianLag,
    aggregateMeanLag,
    maturityDays,
    pathT95,
    totalK,
    totalN,
    sampleCohort: cohorts[0] ? {
      date: cohorts[0].date,
      n: cohorts[0].n,
      k: cohorts[0].k,
      age: cohorts[0].age,
      median_lag_days: cohorts[0].median_lag_days,
      mean_lag_days: cohorts[0].mean_lag_days,
    } : 'no cohorts'
  });

  // For downstream edges, adjust cohort ages by subtracting path_t95.
  // This reflects that by the time users reach this edge, they've already
  // spent path_t95 days traversing upstream edges.
  // effectiveAge = max(0, rawAge - pathT95)
  const adjustedCohorts: CohortData[] = pathT95 > 0
    ? cohorts.map(c => ({
        ...c,
        age: Math.max(0, c.age - pathT95),
      }))
    : cohorts;
  
  if (pathT95 > 0) {
    console.log('[LAG_DEBUG] Path-adjusted ages:', {
      pathT95,
      originalAges: cohorts.slice(0, 3).map(c => c.age),
      adjustedAges: adjustedCohorts.slice(0, 3).map(c => c.age),
    });
  }

  // Step 1: Fit lag distribution
  const fit = fitLagDistribution(aggregateMedianLag, aggregateMeanLag, totalK);
  
  // DEBUG: Log fit result
  console.log('[LAG_DEBUG] COMPUTE_FIT result:', {
    mu: fit.mu,
    sigma: fit.sigma,
    empirical_quality_ok: fit.empirical_quality_ok,
    quality_failure_reason: fit.quality_failure_reason,
    total_k: fit.total_k,
  });

  // Step 2: Compute t95
  const t95 = computeT95(fit, maturityDays);

  // Step 3: Estimate p_infinity from mature cohorts
  // NOTE: Use ORIGINAL cohorts for p_infinity estimation (raw age determines maturity)
  const pInfinityEstimate = estimatePInfinity(cohorts, t95);

  // Evidence probability (observed k/n)
  const pEvidence = totalN > 0 ? totalK / totalN : 0;

  // If no mature cohorts, forecast is not available
  if (pInfinityEstimate === undefined) {
    return {
      fit,
      t95,
      p_infinity: pEvidence, // Fall back to evidence as estimate
      p_mean: pEvidence,     // Can't forecast without p_infinity
      // Use ADJUSTED cohorts for completeness (reflects effective age at this edge)
      completeness: calculateCompleteness(adjustedCohorts, fit.mu, fit.sigma),
      p_evidence: pEvidence,
      forecast_available: false,
    };
  }

  // Step 4: Apply Formula A
  // Use ADJUSTED cohorts for completeness calculation
  const result = applyFormulaAToAll(adjustedCohorts, pInfinityEstimate, fit, maturityDays);

  return {
    fit,
    t95,
    p_infinity: pInfinityEstimate,
    p_mean: result.p_mean,
    completeness: result.completeness,
    p_evidence: pEvidence,
    forecast_available: true,
  };
}

// =============================================================================
// Path Maturity Calculation (Topological DP)
// Design reference: design.md §4.7.2
// =============================================================================

/**
 * Simple graph edge interface for path maturity calculations.
 * Matches the minimal structure needed from Graph.edges.
 */
export interface GraphEdgeForPath {
  id?: string;
  uuid?: string;
  from: string;
  to: string;
  p?: {
    latency?: {
      maturity_days?: number;
      t95?: number;
      path_t95?: number;
    };
    mean?: number;
  };
  conditional_p?: Array<{
    p?: {
      mean?: number;
      latency?: {
        t95?: number;
      };
    };
  }>;
}

/**
 * Simple graph node interface for path maturity calculations.
 */
export interface GraphNodeForPath {
  id: string;
  type?: string;
  entry?: {
    is_start?: boolean;
  };
}

/**
 * Graph interface for path maturity calculations.
 */
export interface GraphForPath {
  nodes: GraphNodeForPath[];
  edges: GraphEdgeForPath[];
}

/**
 * Get the effective edge ID (uuid or id).
 */
function getEdgeId(edge: GraphEdgeForPath): string {
  return edge.uuid || edge.id || `${edge.from}->${edge.to}`;
}

/**
 * Determine which edges are "active" under a given scenario.
 * 
 * An edge is active if its effective probability > epsilon.
 * For latency calculations, we only consider edges that are actually
 * contributing to the flow.
 * 
 * @param graph - The graph to analyse
 * @param whatIfDSL - Optional scenario DSL for probability overrides
 * @param epsilon - Threshold below which edges are inactive (default 1e-9)
 * @returns Set of active edge IDs
 */
export function getActiveEdges(
  graph: GraphForPath,
  whatIfDSL?: string,
  epsilon: number = 1e-9
): Set<string> {
  const activeEdges = new Set<string>();

  for (const edge of graph.edges) {
    // Get effective probability
    // In a full implementation, this would use computeEffectiveEdgeProbability
    // from lib/whatIf.ts with the whatIfDSL. For now, use p.mean.
    const effectiveP = edge.p?.mean ?? 0;

    if (effectiveP > epsilon) {
      activeEdges.add(getEdgeId(edge));
    }
  }

  return activeEdges;
}

/**
 * Build an adjacency list for topological traversal.
 * Maps node ID -> list of outgoing edges.
 */
function buildAdjacencyList(
  graph: GraphForPath,
  activeEdges: Set<string>
): Map<string, GraphEdgeForPath[]> {
  const adjacency = new Map<string, GraphEdgeForPath[]>();

  for (const edge of graph.edges) {
    const edgeId = getEdgeId(edge);
    if (!activeEdges.has(edgeId)) continue;

    const outgoing = adjacency.get(edge.from) || [];
    outgoing.push(edge);
    adjacency.set(edge.from, outgoing);
  }

  return adjacency;
}

/**
 * Build reverse adjacency (node -> incoming edges).
 */
function buildReverseAdjacency(
  graph: GraphForPath,
  activeEdges: Set<string>
): Map<string, GraphEdgeForPath[]> {
  const reverseAdj = new Map<string, GraphEdgeForPath[]>();

  for (const edge of graph.edges) {
    const edgeId = getEdgeId(edge);
    if (!activeEdges.has(edgeId)) continue;

    const incoming = reverseAdj.get(edge.to) || [];
    incoming.push(edge);
    reverseAdj.set(edge.to, incoming);
  }

  return reverseAdj;
}

/**
 * Find START nodes (nodes with entry.is_start=true or no incoming edges).
 */
function findStartNodes(
  graph: GraphForPath,
  activeEdges: Set<string>
): string[] {
  const reverseAdj = buildReverseAdjacency(graph, activeEdges);
  const startNodes: string[] = [];

  for (const node of graph.nodes) {
    // Explicit start via entry.is_start (the actual pattern used in graphs)
    if (node.entry?.is_start === true) {
      startNodes.push(node.id);
      continue;
    }
    
    // No incoming active edges (fallback for graphs without explicit start markers)
    const incoming = reverseAdj.get(node.id) || [];
    if (incoming.length === 0) {
      // Check if this node has any outgoing edges (otherwise it's disconnected)
      const hasOutgoing = graph.edges.some(e => 
        e.from === node.id && activeEdges.has(getEdgeId(e))
      );
      if (hasOutgoing) {
        startNodes.push(node.id);
      }
    }
  }

  return startNodes;
}

/**
 * Compute path_t95 for all edges using topological DP.
 * 
 * path_t95 is the cumulative latency from the anchor (start) to the
 * end of this edge. It's computed as:
 *   path_t95(edge) = max(path_t95(incoming edges to edge.from)) + edge.t95
 * 
 * This is a transient value computed per-query/scenario, not persisted.
 * 
 * @param graph - The graph with edges that have t95 values
 * @param activeEdges - Set of edge IDs that are active under current scenario
 * @param anchorNodeId - Optional: specific anchor node (if omitted, uses all START nodes)
 * @returns Map of edge ID -> path_t95
 */
export function computePathT95(
  graph: GraphForPath,
  activeEdges: Set<string>,
  anchorNodeId?: string
): Map<string, number> {
  const pathT95 = new Map<string, number>();
  const nodeT95 = new Map<string, number>(); // Max path_t95 to reach each node

  // Build adjacency structures
  const adjacency = buildAdjacencyList(graph, activeEdges);
  const reverseAdj = buildReverseAdjacency(graph, activeEdges);

  // Find start nodes
  const startNodes = anchorNodeId ? [anchorNodeId] : findStartNodes(graph, activeEdges);

  // Initialise start nodes with t95 = 0
  for (const startId of startNodes) {
    nodeT95.set(startId, 0);
  }

  // Topological order traversal using Kahn's algorithm
  // Count incoming edges for each node
  const inDegree = new Map<string, number>();
  for (const node of graph.nodes) {
    const incoming = reverseAdj.get(node.id) || [];
    inDegree.set(node.id, incoming.length);
  }

  // Queue starts with nodes that have no incoming edges (or are start nodes)
  const queue: string[] = [];
  for (const [nodeId, degree] of inDegree) {
    if (degree === 0 || startNodes.includes(nodeId)) {
      queue.push(nodeId);
    }
  }

  // Process nodes in topological order
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    const nodePathT95 = nodeT95.get(nodeId) ?? 0;

    // Process all outgoing edges
    const outgoing = adjacency.get(nodeId) || [];
    for (const edge of outgoing) {
      const edgeId = getEdgeId(edge);
      const edgeT95 = edge.p?.latency?.t95 ?? 0;

      // path_t95 for this edge = path to source node + edge's own t95
      const edgePathT95 = nodePathT95 + edgeT95;
      pathT95.set(edgeId, edgePathT95);

      // Update the target node's max path_t95
      const targetNodeId = edge.to;
      const currentTargetT95 = nodeT95.get(targetNodeId) ?? 0;
      nodeT95.set(targetNodeId, Math.max(currentTargetT95, edgePathT95));

      // Decrease in-degree and add to queue if ready
      const newInDegree = (inDegree.get(targetNodeId) ?? 1) - 1;
      inDegree.set(targetNodeId, newInDegree);
      if (newInDegree === 0 && !queue.includes(targetNodeId)) {
        queue.push(targetNodeId);
      }
    }
  }

  return pathT95;
}

/**
 * Apply computed path_t95 values to edges (transient, not persisted).
 * 
 * This updates the in-memory graph edges with path_t95 for display/caching.
 * The values are scenario-specific and should be recomputed when the
 * scenario changes.
 * 
 * @param graph - Graph to update (mutated in place)
 * @param pathT95Map - Map of edge ID -> path_t95
 */
export function applyPathT95ToGraph(
  graph: GraphForPath,
  pathT95Map: Map<string, number>
): void {
  for (const edge of graph.edges) {
    const edgeId = getEdgeId(edge);
    const pathT95 = pathT95Map.get(edgeId);

    if (pathT95 !== undefined && edge.p?.latency) {
      edge.p.latency.path_t95 = pathT95;
    }
  }
}

/**
 * Get edges sorted in topological order (upstream edges first).
 * 
 * Used for batch fetching to ensure upstream t95 values are computed
 * before they're needed for downstream path_t95 calculations.
 * 
 * @param graph - The graph to sort
 * @param activeEdges - Set of active edge IDs
 * @returns Array of edges in topological order
 */
export function getEdgesInTopologicalOrder(
  graph: GraphForPath,
  activeEdges: Set<string>
): GraphEdgeForPath[] {
  const sorted: GraphEdgeForPath[] = [];
  const visited = new Set<string>();

  // Build adjacency structures
  const reverseAdj = buildReverseAdjacency(graph, activeEdges);

  // Find start nodes
  const startNodes = findStartNodes(graph, activeEdges);

  // DFS to produce topological order
  function visit(nodeId: string): void {
    // Process all edges ending at this node
    const incoming = reverseAdj.get(nodeId) || [];
    for (const edge of incoming) {
      const edgeId = getEdgeId(edge);
      if (visited.has(edgeId)) continue;
      
      // First visit the source node's incoming edges (recursively)
      visit(edge.from);
      
      // Then add this edge
      visited.add(edgeId);
      sorted.push(edge);
    }
  }

  // Start from all nodes (to handle disconnected components)
  for (const node of graph.nodes) {
    visit(node.id);
  }

  return sorted;
}

// =============================================================================
// Inbound-N: Forecast Population Computation (see inbound-n-fix.md)
// =============================================================================

/**
 * Extended edge interface for inbound-n calculations.
 * Includes evidence.n which is needed to seed anchor edges.
 */
export interface GraphEdgeForInboundN extends GraphEdgeForPath {
  p?: GraphEdgeForPath['p'] & {
    evidence?: {
      n?: number;
      k?: number;
    };
    n?: number; // Will be set by computeInboundN
  };
}

/**
 * Extended graph interface for inbound-n calculations.
 */
export interface GraphForInboundN {
  nodes: GraphNodeForPath[];
  edges: GraphEdgeForInboundN[];
}

/**
 * Result of inbound-n computation for a single edge.
 */
export interface InboundNResult {
  /** Forecast population for this edge (p.n) */
  n: number;
  /** Internal: expected converters on this edge (p.n * p.mean) */
  forecast_k: number;
  /** The effective probability used (from whatIf or base p.mean) */
  effective_p: number;
}

/**
 * Compute inbound-n (forecast population) for all edges using topological DP.
 * 
 * This implements the step-wise convolution from design doc inbound-n-fix.md:
 * - For anchor edges (from START node): p.n = evidence.n
 * - For downstream edges: p.n = sum of inbound forecast.k at the from-node
 * - For each edge: forecast.k = p.n * effective_probability
 * 
 * The effective probability accounts for scenario/whatIf overrides including
 * conditional_p activation under the current scenario.
 * 
 * @param graph - The graph with edges that have evidence.n and p.mean
 * @param activeEdges - Set of edge IDs that are active under current scenario
 * @param getEffectiveP - Function to get effective probability for an edge under scenario
 *                        (should wrap computeEffectiveEdgeProbability from whatIf.ts)
 * @param anchorNodeId - Optional: specific anchor node (if omitted, uses all START nodes)
 * @returns Map of edge ID -> InboundNResult
 */
export function computeInboundN(
  graph: GraphForInboundN,
  activeEdges: Set<string>,
  getEffectiveP: (edgeId: string) => number,
  anchorNodeId?: string
): Map<string, InboundNResult> {
  const results = new Map<string, InboundNResult>();
  
  // nodePopulation[nodeId] = total expected arrivals at this node
  // For START nodes, this is the sum of evidence.n on outgoing edges
  // For other nodes, this is the sum of inbound forecast.k
  const nodePopulation = new Map<string, number>();

  // Build adjacency structures (cast to include evidence field)
  const adjacency = buildAdjacencyList(graph, activeEdges) as Map<string, GraphEdgeForInboundN[]>;
  const reverseAdj = buildReverseAdjacency(graph, activeEdges) as Map<string, GraphEdgeForInboundN[]>;

  // Find start nodes
  const startNodes = anchorNodeId ? [anchorNodeId] : findStartNodes(graph, activeEdges);
  
  console.log('[computeInboundN] Setup:', {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    activeEdgeCount: activeEdges.size,
    startNodes,
    nodesWithEntry: graph.nodes.filter(n => n.entry?.is_start).map(n => n.id),
    adjacencyKeys: Array.from(adjacency.keys()),
  });

  // Initialise start node populations from their outgoing edges' evidence.n
  // For a START node, the population is defined by the cohort size entering
  // We take the max evidence.n from outgoing edges as the anchor population
  for (const startId of startNodes) {
    const outgoing = adjacency.get(startId) || [];
    let maxEvidenceN = 0;
    for (const edge of outgoing) {
      const evidenceN = edge.p?.evidence?.n ?? 0;
      maxEvidenceN = Math.max(maxEvidenceN, evidenceN);
    }
    nodePopulation.set(startId, maxEvidenceN);
  }

  // Topological order traversal using Kahn's algorithm
  // Count incoming edges for each node
  const inDegree = new Map<string, number>();
  for (const node of graph.nodes) {
    const incoming = reverseAdj.get(node.id) || [];
    inDegree.set(node.id, incoming.length);
  }

  // Queue starts with nodes that have no incoming edges (or are start nodes)
  const queue: string[] = [];
  for (const [nodeId, degree] of inDegree) {
    if (degree === 0 || startNodes.includes(nodeId)) {
      queue.push(nodeId);
    }
  }

  // Process nodes in topological order
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    const nodeN = nodePopulation.get(nodeId) ?? 0;

    // Process all outgoing edges from this node
    const outgoing = adjacency.get(nodeId) || [];
    for (const edge of outgoing) {
      const edgeId = getEdgeId(edge);
      
      // Get effective probability under current scenario
      const effectiveP = getEffectiveP(edgeId);
      
      // For anchor edges (from START), p.n = evidence.n
      // For downstream edges, p.n = nodePopulation (sum of inbound forecast.k)
      const isAnchorEdge = startNodes.includes(nodeId);
      const edgeN = isAnchorEdge 
        ? (edge.p?.evidence?.n ?? nodeN) 
        : nodeN;
      
      // forecast.k = p.n * effective_probability
      const forecastK = edgeN * effectiveP;
      
      results.set(edgeId, {
        n: edgeN,
        forecast_k: forecastK,
        effective_p: effectiveP,
      });

      // Add this edge's forecast.k to the target node's population
      const targetNodeId = edge.to;
      const currentTargetN = nodePopulation.get(targetNodeId) ?? 0;
      nodePopulation.set(targetNodeId, currentTargetN + forecastK);

      // Decrease in-degree and add to queue if ready
      const newInDegree = (inDegree.get(targetNodeId) ?? 1) - 1;
      inDegree.set(targetNodeId, newInDegree);
      if (newInDegree === 0 && !queue.includes(targetNodeId)) {
        queue.push(targetNodeId);
      }
    }
  }

  return results;
}

/**
 * Apply computed inbound-n values to edges.
 * 
 * This updates the in-memory graph edges with p.n for display/caching.
 * The values are scenario-specific and should be recomputed when the
 * scenario or DSL changes.
 * 
 * @param graph - Graph to update (mutated in place)
 * @param inboundNMap - Map of edge ID -> InboundNResult
 */
export function applyInboundNToGraph(
  graph: GraphForInboundN,
  inboundNMap: Map<string, InboundNResult>
): void {
  for (const edge of graph.edges) {
    const edgeId = getEdgeId(edge);
    const result = inboundNMap.get(edgeId);

    if (result !== undefined && edge.p) {
      edge.p.n = result.n;
    }
  }
}

