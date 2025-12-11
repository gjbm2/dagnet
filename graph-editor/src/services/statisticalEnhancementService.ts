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
import { RECENCY_HALF_LIFE_DAYS, FORECAST_BLEND_LAMBDA, PRECISION_DECIMAL_PLACES } from '../constants/statisticalConstants';
import { computeEffectiveEdgeProbability, type WhatIfOverrides } from '../lib/whatIf';

// =============================================================================
// Shared Blend Calculation (Single Source of Truth)
// =============================================================================

/**
 * Inputs for the forecast blend calculation.
 * Used by both addEvidenceAndForecastScalars and enhanceGraphLatencies.
 */
export interface BlendInputs {
  /** Observed conversion rate from cohort evidence */
  evidenceMean: number | undefined;
  /** Forecast conversion rate from mature window baseline */
  forecastMean: number;
  /** Completeness fraction (0-1) from LAG CDF. undefined = not computed, skip blend */
  completeness: number | undefined;
  /** Query population: p.n (forecast) or evidence.n (observed) */
  nQuery: number;
  /** Baseline sample size from window slice */
  nBaseline: number;
}

/**
 * Compute blended p.mean from evidence and forecast.
 * 
 * Formula (forecast-fix.md):
 *   w_evidence = (completeness × n_query) / (λ × n_baseline + completeness × n_query)
 *   p.mean = w_evidence × evidence.mean + (1 - w_evidence) × forecast.mean
 * 
 * When n_query = 0 (no arrivals yet):
 *   w_evidence = 0 → returns pure forecast.mean
 * 
 * This is the SINGLE source of truth for blend calculation.
 * Called by both:
 *   - addEvidenceAndForecastScalars (single-edge path)
 *   - enhanceGraphLatencies (batch path)
 * 
 * @returns Blended mean, or undefined if blend cannot be computed
 */
export function computeBlendedMean(inputs: BlendInputs): number | undefined {
  const { evidenceMean, forecastMean, completeness, nQuery, nBaseline } = inputs;
  
  // Guard: need valid forecast baseline
  if (nBaseline <= 0 || !Number.isFinite(forecastMean)) {
    return undefined;
  }
  
  // Guard: need valid inputs
  if (completeness === undefined || evidenceMean === undefined) {
    return undefined;
  }
  
  // With nQuery=0, wEvidence=0, returns pure forecast (correct for no-arrivals case)
  const nEff = completeness * nQuery;
  const m0 = FORECAST_BLEND_LAMBDA * nBaseline;
  const wEvidence = nEff / (m0 + nEff);
  
  return wEvidence * evidenceMean + (1 - wEvidence) * forecastMean;
}

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
    const factor = Math.pow(10, PRECISION_DECIMAL_PLACES);
    const finalMean = Math.round(simpleMean * factor) / factor;
    
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
  /** 
   * Anchor median lag in days for this cohort (optional).
   * For downstream edges, this is the observed median lag from anchor A
   * to the source of this edge (cumulative upstream lag).
   * Used for computing effective age for completeness calculation.
   */
  anchor_median_lag_days?: number;
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

  const cohortDetails: Array<{ date: string; age: number; n: number; F_age: number }> = [];

  for (const cohort of cohorts) {
    if (cohort.n === 0) continue;
    const F_age = logNormalCDF(cohort.age, mu, sigma);
    totalN += cohort.n;
    weightedSum += cohort.n * F_age;
    cohortDetails.push({ date: cohort.date, age: cohort.age, n: cohort.n, F_age });
  }

  const completeness = totalN > 0 ? weightedSum / totalN : 0;
  
  console.log('[LAG_DEBUG] COMPLETENESS calculation:', {
    mu: mu.toFixed(3),
    sigma: sigma.toFixed(3),
    totalN,
    completeness: completeness.toFixed(3),
    cohortCount: cohorts.length,
    ageRange: cohorts.length > 0 
      ? `${Math.min(...cohorts.map(c => c.age))}-${Math.max(...cohorts.map(c => c.age))} days`
      : 'no cohorts',
    sampleCohorts: cohortDetails.slice(0, 5).map(c => ({
      date: c.date,
      age: c.age,
      F_age: c.F_age.toFixed(3),
    })),
  });

  return completeness;
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
 * For completeness calculation, effective age is computed as:
 *   - First latency edge: effective_age = anchor_age (no adjustment)
 *   - Downstream edges: effective_age = max(0, anchor_age - anchor_median_lag)
 * 
 * The anchor_median_lag comes from OBSERVED data (per-cohort anchor_median_lag_days
 * or aggregate anchorMedianLag), NOT from summing t95s along the path.
 * 
 * @param cohorts - Per-cohort data array (may include anchor_median_lag_days)
 * @param aggregateMedianLag - Weighted aggregate median lag for this edge
 * @param aggregateMeanLag - Weighted aggregate mean lag (optional)
 * @param maturityDays - User-configured maturity threshold
 * @param anchorMedianLag - Observed median lag from anchor to this edge's source (for downstream edges).
 *                          Use 0 for first latency edge from anchor. This is the central tendency
 *                          of cumulative upstream lag, NOT path_t95.
 * @returns Full edge latency statistics
 */
export function computeEdgeLatencyStats(
  cohorts: CohortData[],
  aggregateMedianLag: number,
  aggregateMeanLag: number | undefined,
  maturityDays: number,
  anchorMedianLag: number = 0
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
    anchorMedianLag,
    totalK,
    totalN,
    sampleCohort: cohorts[0] ? {
      date: cohorts[0].date,
      n: cohorts[0].n,
      k: cohorts[0].k,
      age: cohorts[0].age,
      median_lag_days: cohorts[0].median_lag_days,
      mean_lag_days: cohorts[0].mean_lag_days,
      anchor_median_lag_days: cohorts[0].anchor_median_lag_days,
    } : 'no cohorts'
  });

  // For downstream edges, adjust cohort ages by subtracting anchor_median_lag.
  // This reflects the OBSERVED central tendency of how long users take to reach
  // this edge from the anchor, NOT the conservative 95th percentile (path_t95).
  //
  // Design (stats-convolution-schematic.md §4):
  //   effective_age[d] = max(0, anchor_age[d] - anchor_median_lag[d])
  //
  // We use per-cohort anchor_median_lag_days if available, otherwise the
  // aggregate anchorMedianLag passed as parameter.
  const adjustedCohorts: CohortData[] = anchorMedianLag > 0 || cohorts.some(c => c.anchor_median_lag_days)
    ? cohorts.map(c => {
        // Prefer per-cohort anchor_median_lag_days, fall back to aggregate
        const lagToSubtract = c.anchor_median_lag_days ?? anchorMedianLag;
        return {
          ...c,
          age: Math.max(0, c.age - lagToSubtract),
        };
      })
    : cohorts;
  
  if (anchorMedianLag > 0 || cohorts.some(c => c.anchor_median_lag_days)) {
    console.log('[LAG_DEBUG] Anchor-adjusted ages:', {
      anchorMedianLag,
      hasPerCohortAnchorLag: cohorts.some(c => c.anchor_median_lag_days),
      originalAges: cohorts.slice(0, 3).map(c => c.age),
      adjustedAges: adjustedCohorts.slice(0, 3).map(c => c.age),
      perCohortLags: cohorts.slice(0, 3).map(c => c.anchor_median_lag_days),
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
    /** Forecast population for this edge under the current DSL (inbound-n result). */
    n?: number;
    latency?: {
      maturity_days?: number;
      t95?: number;
      path_t95?: number;
      median_lag_days?: number;
      mean_lag_days?: number;
      completeness?: number;
    };
    mean?: number;
    evidence?: {
      mean?: number;
      n?: number;
      k?: number;
    };
    forecast?: {
      mean?: number;
    };
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
  uuid?: string;
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
  const debugInfo: Array<{ edgeId: string; baseMean: number; effectiveP: number; active: boolean; scenarioApplied: boolean }> = [];

  // Build whatIfOverrides from DSL string (if provided)
  const whatIfOverrides: WhatIfOverrides = whatIfDSL 
    ? { whatIfDSL } 
    : { caseOverrides: {}, conditionalOverrides: {} };

  for (const edge of graph.edges) {
    const edgeId = getEdgeId(edge);
    const baseMean = edge.p?.mean ?? 0;
    
    // Get effective probability under the current scenario
    // This respects:
    // - Case variant weights (e.g., case(treatment) = 100%)
    // - Conditional probability overrides (visited(X) conditions)
    // - What-if DSL overrides
    const effectiveP = whatIfDSL
      ? computeEffectiveEdgeProbability(graph, edgeId, whatIfOverrides)
      : baseMean;
    
    const isActive = effectiveP > epsilon;
    const scenarioApplied = whatIfDSL !== undefined && effectiveP !== baseMean;

    if (isActive) {
      activeEdges.add(edgeId);
    }
    
    debugInfo.push({ edgeId, baseMean, effectiveP, active: isActive, scenarioApplied });
  }

  console.log('[LAG_TOPO_001] getActiveEdges:', {
    totalEdges: graph.edges.length,
    activeCount: activeEdges.size,
    hasScenario: !!whatIfDSL,
    edges: debugInfo.filter(e => e.scenarioApplied || !e.active),  // Log scenario-affected and inactive edges
  });

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
  const addedEdges: string[] = [];
  const skippedEdges: string[] = [];

  // Build a map from node UUID to node ID for normalization
  const uuidToNodeId = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.uuid && node.uuid !== node.id) {
      uuidToNodeId.set(node.uuid, node.id);
    }
  }

  for (const edge of graph.edges) {
    const edgeId = getEdgeId(edge);
    if (!activeEdges.has(edgeId)) {
      skippedEdges.push(edgeId);
      continue;
    }

    // Normalize edge.from: if it's a UUID, map it to node.id
    const fromNodeId = uuidToNodeId.get(edge.from) || edge.from;
    
    const outgoing = adjacency.get(fromNodeId) || [];
    outgoing.push(edge);
    adjacency.set(fromNodeId, outgoing);
    addedEdges.push(`${fromNodeId}->[${edgeId}]->${edge.to}`);
  }

  console.log('[LAG_TOPO_002] buildAdjacencyList:', {
    activeEdgesInput: activeEdges.size,
    addedToAdjacency: addedEdges.length,
    skipped: skippedEdges.length,
    uuidMappings: uuidToNodeId.size,
    adjacencyKeys: Array.from(adjacency.keys()).join(', '),
  });

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

  // Build a map from node UUID to node ID for normalization
  const uuidToNodeId = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.uuid && node.uuid !== node.id) {
      uuidToNodeId.set(node.uuid, node.id);
    }
  }

  for (const edge of graph.edges) {
    const edgeId = getEdgeId(edge);
    if (!activeEdges.has(edgeId)) continue;

    // Normalize edge.to: if it's a UUID, map it to node.id
    const toNodeId = uuidToNodeId.get(edge.to) || edge.to;
    
    const incoming = reverseAdj.get(toNodeId) || [];
    incoming.push(edge);
    reverseAdj.set(toNodeId, incoming);
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
      // Fallback chain: t95 (accurate) → maturity_days (conservative) → 0
      // This handles different data sufficiency conditions:
      // - Full data: Uses actual t95 from fitted distribution
      // - Partial data: Uses user-configured maturity_days as approximation
      // - No data: Contributes 0 (edge has no latency tracking)
      const edgeT95 = edge.p?.latency?.t95 ?? edge.p?.latency?.maturity_days ?? 0;

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

// =============================================================================
// Graph-Level Latency Enhancement (Topo-Ordered)
// =============================================================================

/**
 * Parameter value structure (subset of fields needed for LAG).
 * Matches the structure from paramRegistryService.ParameterValue.
 */
export interface ParameterValueForLAG {
  mean: number;  // Required by ParameterValue, but not used in LAG
  n?: number;
  k?: number;
  dates?: string[];
  n_daily?: number[];
  k_daily?: number[];
  median_lag_days?: number[];
  mean_lag_days?: number[];
  cohort_from?: string;
  cohort_to?: string;
  data_source?: { retrieved_at?: string };
  // Optional fields carried through from full ParameterValue for scoping
  sliceDSL?: string;
  window_from?: string;
  window_to?: string;
  forecast?: number;
}

/**
 * Helpers passed to enhanceGraphLatencies to avoid circular imports.
 * These come from windowAggregationService.
 */
export interface LAGHelpers {
  /** Convert ParameterValue[] to CohortData[], optionally filtered to a cohort window */
  aggregateCohortData: (
    values: ParameterValueForLAG[], 
    queryDate: Date,
    cohortWindow?: { start: Date; end: Date }
  ) => CohortData[];
  /** Compute aggregate median/mean lag from cohorts */
  aggregateLatencyStats: (cohorts: CohortData[]) => { median_lag_days: number; mean_lag_days: number } | undefined;
}

/**
 * Computed values for a single edge from the LAG pass.
 * These should be applied to the graph via UpdateManager.
 */
export interface EdgeLAGValues {
  /** Edge UUID (for lookup) */
  edgeUuid: string;
  /** Latency values to write to edge.p.latency */
  latency: {
    median_lag_days?: number;
    mean_lag_days?: number;
    t95: number;
    completeness: number;
    path_t95: number;
  };
  /** Blended p.mean (if computed) */
  blendedMean?: number;
  /** Forecast data to preserve on edge.p.forecast */
  forecast?: {
    mean?: number;
  };
  /** Evidence data to preserve on edge.p.evidence */
  evidence?: {
    mean?: number;
    n?: number;
    k?: number;
  };
  /** Debug data for session log visibility */
  debug?: {
    /** Query date used for age calculations */
    queryDate: string;
    /** Cohort window used for filtering (if any) */
    cohortWindow?: string;
    /** Number of input param values by slice type */
    inputCohortSlices: number;
    inputWindowSlices: number;
    /** Number of cohorts used (after filtering to cohort slices and window) */
    cohortCount: number;
    /** Range of raw cohort ages (before path adjustment) */
    rawAgeRange: string;
    /** Range of adjusted ages (after subtracting pathT95) */
    adjustedAgeRange: string;
    /** Anchor lag used for age adjustment (0 = first edge, >0 = downstream edge) */
    anchorMedianLag: number;
    /** How many cohorts had anchor lag data */
    cohortsWithAnchorLag: number;
    /** Lognormal fit parameters */
    mu: number;
    sigma: number;
    /** Total n and k across cohorts */
    totalN: number;
    totalK: number;
    /** Sample of cohort data for debugging */
    sampleCohorts: Array<{
      date: string;
      rawAge: number;
      adjustedAge: number;
      n: number;
      k: number;
      cdf: number;
      anchorLag?: number;
    }>;
  };
}

/**
 * Result of graph-level latency enhancement.
 */
export interface GraphLatencyEnhancementResult {
  /** Number of edges processed */
  edgesProcessed: number;
  /** Number of edges that had LAG stats computed */
  edgesWithLAG: number;
  /** Per-edge computed values to apply to graph */
  edgeValues: EdgeLAGValues[];
}

/**
 * Enhance all latency-enabled edges in a graph with LAG statistics.
 * 
 * This is the primary entry point for latency computation. It runs a single
 * topological pass over the graph, computing for each edge:
 *   - Per-edge lag fit (median, mean, t95)
 *   - Path-adjusted completeness (using upstream path_t95)
 *   - Cumulative path_t95 for downstream edges
 * 
 * The pass ensures that upstream edges are processed before downstream ones,
 * so that path_t95 is available when computing downstream completeness.
 * 
 * @param graph - The graph to enhance (mutated in place)
 * @param paramLookup - Map from edge ID to its parameter values
 * @param queryDate - The "now" for computing cohort ages
 * @param helpers - Functions from windowAggregationService to avoid circular imports
 * @param cohortWindow - Optional cohort window to filter cohorts
 * @param whatIfDSL - Optional scenario DSL for scenario-aware active edge determination
 * @param pathT95Map - Pre-computed path_t95 map (from computePathT95). If not provided, computed internally.
 * @returns Summary of what was processed
 */
export function enhanceGraphLatencies(
  graph: GraphForPath,
  paramLookup: Map<string, ParameterValueForLAG[]>,
  queryDate: Date,
  helpers: LAGHelpers,
  cohortWindow?: { start: Date; end: Date },
  whatIfDSL?: string,
  pathT95Map?: Map<string, number>
): GraphLatencyEnhancementResult {
  const result: GraphLatencyEnhancementResult = {
    edgesProcessed: 0,
    edgesWithLAG: 0,
    edgeValues: [],
  };
  
  console.log('[LAG_TOPO] enhanceGraphLatencies called with cohortWindow:', cohortWindow ? {
    start: cohortWindow.start.toISOString().split('T')[0],
    end: cohortWindow.end.toISOString().split('T')[0],
  } : 'none');

  // Build a map from node UUID to node ID for normalization
  // This handles graphs where edge.from/to are UUIDs instead of node IDs
  const uuidToNodeId = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.uuid && node.uuid !== node.id) {
      uuidToNodeId.set(node.uuid, node.id);
    }
  }
  
  // Helper to normalize a node reference (UUID -> ID)
  const normalizeNodeRef = (ref: string): string => uuidToNodeId.get(ref) || ref;

  // Debug: Log input state
  console.log('[LAG_TOPO_003] enhanceGraphLatencies input:', {
    nodeCount: graph.nodes?.length,
    edgeCount: graph.edges?.length,
    paramLookupSize: paramLookup.size,
    paramLookupKeys: Array.from(paramLookup.keys()),
    graphEdgeIds: graph.edges?.map(e => e.uuid || e.id || `${e.from}->${e.to}`),
    uuidMappings: uuidToNodeId.size,
  });

  // Get active edges (those with latency config)
  // Pass whatIfDSL for scenario-aware active edge determination (B3 fix)
  const activeEdges = getActiveEdges(graph, whatIfDSL);
  if (activeEdges.size === 0) {
    console.log('[enhanceGraphLatencies] No active latency edges');
    return result;
  }

  console.log('[LAG_TOPO_004] activeEdges set:', {
    activeCount: activeEdges.size,
    activeIds: Array.from(activeEdges),
  });

  // Build adjacency structures for topo traversal
  const adjacency = buildAdjacencyList(graph, activeEdges);
  const reverseAdj = buildReverseAdjacency(graph, activeEdges);

  // Find start nodes
  const startNodes = findStartNodes(graph, activeEdges);
  
  console.log('[LAG_TOPO_005] topoSetup:', {
    startNodes,
    adjacencySize: adjacency.size,
    adjacencyKeys: Array.from(adjacency.keys()),
  });

  // Use provided path_t95 map or compute if not provided.
  // This allows the caller to pre-compute once and pass it in (single code path).
  const precomputedPathT95 = pathT95Map ?? computePathT95(
    graph as GraphForPath,
    activeEdges,
    startNodes[0] // Use first start node as anchor
  );
  
  console.log('[LAG_TOPO_005b] precomputedPathT95:', {
    wasProvided: !!pathT95Map,
    edgeCount: precomputedPathT95.size,
    sampleEntries: Array.from(precomputedPathT95.entries()).slice(0, 5),
  });

  // DP state: max path_t95 to reach each node
  const nodePathT95 = new Map<string, number>();
  for (const startId of startNodes) {
    nodePathT95.set(startId, 0);
  }

  // Compute in-degree for Kahn's algorithm
  const inDegree = new Map<string, number>();
  for (const node of graph.nodes) {
    const incoming = reverseAdj.get(node.id) || [];
    inDegree.set(node.id, incoming.length);
  }

  // Queue starts with nodes that have no incoming edges
  const queue: string[] = [];
  for (const [nodeId, degree] of inDegree) {
    if (degree === 0 || startNodes.includes(nodeId)) {
      queue.push(nodeId);
    }
  }

  console.log('[LAG_TOPO_006] initialQueue:', {
    queueLength: queue.length,
    queueNodes: queue,
  });

  // CRITICAL DEBUG: Summary of all keys for comparison
  console.log('[LAG_TOPO_SUMMARY] KEY COMPARISON:', {
    paramLookupKeys: Array.from(paramLookup.keys()),
    activeEdgeIds: Array.from(activeEdges),
    adjacencyFromNodes: Array.from(adjacency.keys()),
    startNodes,
    queueNodes: [...queue],
    MATCH_CHECK: {
      paramKeysInActive: Array.from(paramLookup.keys()).filter(k => activeEdges.has(k)),
      paramKeysNotInActive: Array.from(paramLookup.keys()).filter(k => !activeEdges.has(k)),
    },
  });

  // Process nodes in topological order
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    const pathT95ToNode = nodePathT95.get(nodeId) ?? 0;

    // Process all outgoing edges from this node
    const outgoing = adjacency.get(nodeId) || [];
    
    console.log('[LAG_TOPO_007] processingNode:', {
      nodeId,
      adjacencyHasKey: adjacency.has(nodeId),
      outgoingCount: outgoing.length,
    });
    
    for (const edge of outgoing) {
      const edgeId = getEdgeId(edge);
      result.edgesProcessed++;

      // Get maturity config and path_t95 for classification
      const maturityDays = edge.p?.latency?.maturity_days;
      const edgePrecomputedPathT95 = precomputedPathT95.get(edgeId) ?? 0;
      // Normalize edge.to for queue/inDegree operations
      const toNodeId = normalizeNodeRef(edge.to);
      
      // COHORT-VIEW: An edge needs LAG treatment if it has local latency OR
      // is downstream of latency edges (path_t95 > 0).
      const hasLocalLatency = maturityDays !== undefined && maturityDays > 0;
      const isBehindLaggedPath = edgePrecomputedPathT95 > 0;
      
      if (!hasLocalLatency && !isBehindLaggedPath) {
        console.log('[LAG_TOPO_SKIP] noLag:', { edgeId, maturityDays, edgePrecomputedPathT95 });
        // Truly simple edge: no latency config AND no upstream lag
        // Skip LAG computation but update topo state
        const newInDegree = (inDegree.get(toNodeId) ?? 1) - 1;
        inDegree.set(toNodeId, newInDegree);
        if (newInDegree === 0 && !queue.includes(toNodeId)) {
          queue.push(toNodeId);
        }
        continue;
      }
      
      // Effective maturity: local config if available, else use path_t95 as fallback
      // This handles edges downstream of latency edges that have no local config.
      const effectiveMaturity = hasLocalLatency ? maturityDays : edgePrecomputedPathT95;

      // Get parameter values for this edge
      const paramValues = paramLookup.get(edgeId);
      if (!paramValues || paramValues.length === 0) {
        console.log('[LAG_TOPO_SKIP] noParamValues:', { edgeId, hasInLookup: paramLookup.has(edgeId) });
        // No data for this edge, skip but update topo state
        const newInDegree = (inDegree.get(toNodeId) ?? 1) - 1;
        inDegree.set(toNodeId, newInDegree);
        if (newInDegree === 0 && !queue.includes(toNodeId)) {
          queue.push(toNodeId);
        }
        continue;
      }

      // Build cohorts from parameter values
      // Filter to cohort window if provided (so completeness reflects the query window)
      const cohorts = helpers.aggregateCohortData(paramValues, queryDate, cohortWindow);
      if (cohorts.length === 0) {
        console.log('[LAG_TOPO_SKIP] noCohorts:', { edgeId, paramValuesCount: paramValues.length });
        const newInDegree = (inDegree.get(toNodeId) ?? 1) - 1;
        inDegree.set(toNodeId, newInDegree);
        if (newInDegree === 0 && !queue.includes(toNodeId)) {
          queue.push(toNodeId);
        }
        continue;
      }
      
      console.log('[LAG_TOPO_PROCESS] edge:', { 
        edgeId, 
        hasLocalLatency, 
        maturityDays, 
        effectiveMaturity, 
        cohortsCount: cohorts.length 
      });

      // Get aggregate lag stats for this edge
      const lagStats = helpers.aggregateLatencyStats(cohorts);
      const aggregateMedianLag = lagStats?.median_lag_days ?? effectiveMaturity / 2;
      const aggregateMeanLag = lagStats?.mean_lag_days;

      // Get anchor median lag for downstream age adjustment.
      // This is the OBSERVED median lag from anchor (A) to this edge's source,
      // NOT the conservative path_t95 (sum of 95th percentiles).
      //
      // Design (stats-convolution-schematic.md §4):
      //   - First latency edge: anchorMedianLag = 0
      //   - Downstream edges: anchorMedianLag from anchor_median_lag_days in cohort data
      //
      // We compute a k-weighted average of per-cohort anchor_median_lag_days.
      // If cohorts don't have this field (legacy data), we use 0 (treat as first edge).
      let anchorMedianLag = 0;
      const cohortsWithAnchorLag = cohorts.filter(c => 
        c.anchor_median_lag_days !== undefined && 
        c.anchor_median_lag_days > 0 &&
        c.k > 0
      );
      if (cohortsWithAnchorLag.length > 0) {
        const totalK = cohortsWithAnchorLag.reduce((sum, c) => sum + c.k, 0);
        anchorMedianLag = cohortsWithAnchorLag.reduce(
          (sum, c) => sum + c.k * (c.anchor_median_lag_days ?? 0), 
          0
        ) / totalK;
        
        console.log('[LAG_TOPO_ANCHOR] computed anchorMedianLag:', {
          edgeId,
          anchorMedianLag: anchorMedianLag.toFixed(2),
          cohortsWithAnchorLag: cohortsWithAnchorLag.length,
          totalK,
          sampleValues: cohortsWithAnchorLag.slice(0, 3).map(c => c.anchor_median_lag_days),
        });
      }

      // Compute edge LAG stats with anchor-adjusted ages (NOT path_t95!)
      // Use effectiveMaturity for edges behind lagged paths that have no local config.
      const latencyStats = computeEdgeLatencyStats(
        cohorts,
        aggregateMedianLag,
        aggregateMeanLag,
        effectiveMaturity,
        anchorMedianLag  // Use observed anchor lag, NOT path_t95
      );

      // Compute path_t95 for this edge
      const edgePathT95 = pathT95ToNode + latencyStats.t95;
      
      console.log('[LAG_TOPO_COMPUTED] stats:', {
        edgeId,
        t95: latencyStats.t95,
        completeness: latencyStats.completeness,
        pathT95: edgePathT95,
      });
      
      // Build EdgeLAGValues (don't write to graph directly)
      const edgeUuid = edge.uuid || edgeId;
      
      // Compute debug data for session log visibility
      const rawAges = cohorts.map(c => c.age);
      // Use per-cohort anchor_median_lag_days when available, otherwise aggregate
      const adjustedAges = cohorts.map(c => {
        const lagToSubtract = c.anchor_median_lag_days ?? anchorMedianLag;
        return Math.max(0, c.age - lagToSubtract);
      });
      const { mu, sigma } = latencyStats.fit;
      
      // Count input value slice types for debugging
      const cohortSliceCount = paramValues.filter((v: any) => {
        const dsl = v.sliceDSL ?? '';
        return dsl.includes('cohort(') && !dsl.includes('window(');
      }).length;
      const windowSliceCount = paramValues.filter((v: any) => {
        const dsl = v.sliceDSL ?? '';
        return dsl.includes('window(') && !dsl.includes('cohort(');
      }).length;
      
      const edgeLAGValues: EdgeLAGValues = {
        edgeUuid,
        latency: {
          median_lag_days: aggregateMedianLag,
          mean_lag_days: aggregateMeanLag,
          t95: latencyStats.t95,
          completeness: latencyStats.completeness,
          path_t95: edgePathT95,
        },
        debug: {
          queryDate: queryDate.toISOString().split('T')[0],
          cohortWindow: cohortWindow 
            ? `${cohortWindow.start.toISOString().split('T')[0]} to ${cohortWindow.end.toISOString().split('T')[0]}`
            : undefined,
          inputCohortSlices: cohortSliceCount,
          inputWindowSlices: windowSliceCount,
          cohortCount: cohorts.length,
          rawAgeRange: rawAges.length > 0 
            ? `${Math.min(...rawAges)}-${Math.max(...rawAges)} days`
            : 'no cohorts',
          adjustedAgeRange: adjustedAges.length > 0
            ? `${Math.min(...adjustedAges)}-${Math.max(...adjustedAges)} days`
            : 'no cohorts',
          anchorMedianLag,
          cohortsWithAnchorLag: cohortsWithAnchorLag.length,
          mu,
          sigma,
          totalN: cohorts.reduce((sum, c) => sum + c.n, 0),
          totalK: cohorts.reduce((sum, c) => sum + c.k, 0),
          sampleCohorts: cohorts.slice(0, 5).map((c, i) => ({
            date: c.date,
            rawAge: c.age,
            adjustedAge: adjustedAges[i],
            n: c.n,
            k: c.k,
            cdf: logNormalCDF(adjustedAges[i], mu, sigma),
            anchorLag: c.anchor_median_lag_days,
          })),
        },
      };
      
      // Capture forecast and evidence from edge to pass through to UpdateManager
      // These MUST be preserved on the output graph for rendering
      if (edge.p?.forecast?.mean !== undefined) {
        edgeLAGValues.forecast = { mean: edge.p.forecast.mean };
      }
      if (edge.p?.evidence) {
        edgeLAGValues.evidence = {
          mean: edge.p.evidence.mean,
          n: edge.p.evidence.n,
          k: edge.p.evidence.k,
        };
      }

      // ═══════════════════════════════════════════════════════════════════
      // FORECAST BLEND: Compute blended p.mean from evidence + forecast
      // 
      // Formula (forecast-fix.md):
      //   w_evidence = (completeness * n) / (λ * n_baseline + completeness * n)
      //   p.mean = w_evidence * evidence.mean + (1 - w_evidence) * forecast.mean
      // 
      // IMPORTANT (design.md §3.2.1):
      //   - forecast comes from WINDOW slices (mature baseline p_∞)
      //   - evidence comes from COHORT slices (observed rates)
      // 
      const completeness = latencyStats.completeness;
      const evidenceMean = edge.p?.evidence?.mean;

      // Prefer forecast from WINDOW slices (design.md §3.2.1), but if no
      // window() baseline exists and LAG has estimated a reliable p_infinity,
      // use p_infinity as a cohort-based fallback forecast baseline.
      //
      // This ensures that edges with only cohort() data can still participate
      // in the blend, rather than collapsing to pure evidence.
      const baseForecastMean = edge.p?.forecast?.mean;
      const fallbackForecastMean =
        latencyStats.forecast_available ? latencyStats.p_infinity : undefined;
      const forecastMean = baseForecastMean ?? fallbackForecastMean;

      // nQuery: forecast population for this edge
      // Prefer p.n (computed by computeInboundN from upstream forecast_k),
      // then fall back to evidence.n (raw from Amplitude), then cohort sum.
      // This ensures downstream edges with n=0 from Amplitude still get
      // a proper population estimate from upstream forecasts.
      const nQuery = edge.p?.n ?? edge.p?.evidence?.n ?? cohorts.reduce((sum, c) => sum + c.n, 0);

      // n_baseline should reflect the SAMPLE SIZE behind the WINDOW() forecast,
      // not just the subset of cohorts that are currently "mature" under this query.
      //
      // Design: forecast comes from window() slices; those slices also carry n/k
      // for the mature baseline that produced p.forecast.mean.
      //
      // Implementation:
      //   1. Prefer n from window() ParameterValue entries for this edge:
      //        - sliceDSL includes 'window(' and NOT 'cohort('
      //        - has a scalar forecast value and n > 0
      //   2. If no such window slice exists (legacy files), fall back to the
      //      original behaviour: sum of n over "mature" cohorts in this query.
      //
      let nBaseline = 0;

      // Prefer true window() baseline sample size backing the forecast
      const windowCandidates = (paramValues as ParameterValueForLAG[]).filter(v => {
        const dsl = v.sliceDSL;
        if (!dsl) return false;
        const hasWindow = dsl.includes('window(');
        const hasCohort = dsl.includes('cohort(');
        if (!hasWindow || hasCohort) return false;
        return typeof v.forecast === 'number' && typeof v.n === 'number' && v.n > 0;
      });

      if (windowCandidates.length > 0) {
        const bestWindow = [...windowCandidates].sort((a, b) => {
          const aDate = a.data_source?.retrieved_at || a.window_to || '';
          const bDate = b.data_source?.retrieved_at || b.window_to || '';
          return bDate.localeCompare(aDate);
        })[0];
        nBaseline = typeof bestWindow.n === 'number' ? bestWindow.n : 0;
      }

      // Fallback: if no window baseline is available, approximate from mature cohorts
      if (nBaseline === 0) {
        const matureCohorts = cohorts.filter(c => c.age >= effectiveMaturity);
        nBaseline = matureCohorts.reduce((sum, c) => sum + c.n, 0);
      }
      
      // Debug: Log blend inputs
      console.log('[enhanceGraphLatencies] Blend check:', {
        edgeId,
        completeness,
        evidenceMean,
        forecastMean,
        nQuery,
        nBaseline,
        hasPN: edge.p?.n !== undefined,
      });
      
      // Use shared blend function (single source of truth)
      // Pass actual values - undefined means "not available, skip blend"
      const blendedMean = computeBlendedMean({
        evidenceMean,
        forecastMean: forecastMean ?? 0,
        completeness,
        nQuery,
        nBaseline,
      });
      
      if (blendedMean !== undefined) {
        edgeLAGValues.blendedMean = blendedMean;
        
        console.log('[enhanceGraphLatencies] Computed forecast blend:', {
          edgeId,
          edgeUuid,
          completeness: (completeness ?? 0).toFixed(3),
          nQuery,
          nBaseline,
          evidenceMean: (evidenceMean ?? 0).toFixed(3),
          forecastMean: (forecastMean ?? 0).toFixed(3),
          blendedMean: blendedMean.toFixed(3),
        });
      }

      // Update node path_t95 for target node (needed for downstream edges)
      const currentTargetT95 = nodePathT95.get(toNodeId) ?? 0;
      nodePathT95.set(toNodeId, Math.max(currentTargetT95, edgePathT95));

      // Add to results
      console.log('[LAG_TOPO_PUSHING] edgeValues:', {
        edgeUuid: edgeLAGValues.edgeUuid,
        t95: edgeLAGValues.latency.t95,
        completeness: edgeLAGValues.latency.completeness,
        blendedMean: edgeLAGValues.blendedMean,
      });
      result.edgeValues.push(edgeLAGValues);
      result.edgesWithLAG++;

      // Update in-degree and queue
      const newInDegree = (inDegree.get(toNodeId) ?? 1) - 1;
      inDegree.set(toNodeId, newInDegree);
      if (newInDegree === 0 && !queue.includes(toNodeId)) {
        queue.push(toNodeId);
      }
    }
  }

  console.log('[LAG_TOPO_FINAL] enhanceGraphLatencies returning:', {
    edgesProcessed: result.edgesProcessed,
    edgesWithLAG: result.edgesWithLAG,
    edgeValuesCount: result.edgeValues.length,
  });

  return result;
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

