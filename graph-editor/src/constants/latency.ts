/**
 * Latency Constants
 * 
 * Shared constants for LAG (Latency-Aware Graph Analytics) functionality.
 * Used by statisticalEnhancementService, dataOperationsService, and tests.
 * 
 * See design.md §5.3-5.6 for the statistical foundations.
 */

// =============================================================================
// Quality Gates for Lag Distribution Fitting
// =============================================================================

/**
 * Minimum number of converters required for reliable lag distribution fitting.
 * Below this threshold, empirical lag stats are considered unreliable and
 * we fall back to maturity_days for t95.
 * 
 * Rationale: With fewer than 30 converters, median/mean lag estimates
 * have high variance and the log-normal fit may be unstable.
 */
export const LATENCY_MIN_FIT_CONVERTERS = 30;

/**
 * Minimum acceptable mean/median ratio for log-normal fitting.
 * 
 * For a log-normal distribution, mean > median always (right-skewed).
 * A ratio < 1.0 indicates data issues (e.g., outliers, bimodal distribution).
 * 
 * Rationale: σ = sqrt(2 * ln(mean/median)) requires mean > median.
 * Ratio of 1.0 means σ = 0 (degenerate case, all lags identical).
 */
export const LATENCY_MIN_MEAN_MEDIAN_RATIO = 1.0;

/**
 * Maximum acceptable mean/median ratio for log-normal fitting.
 * 
 * Very high ratios indicate extreme right-skew (heavy tails) which may
 * make the log-normal model inappropriate.
 * 
 * Rationale: Ratio of 3.0 corresponds to σ ≈ 1.48, which is already
 * quite heavy-tailed. Beyond this, consider investigating the data.
 */
export const LATENCY_MAX_MEAN_MEDIAN_RATIO = 3.0;

// =============================================================================
// Implicit Baseline Window Clamps
// =============================================================================

/**
 * Lower clamp for implicit baseline window (days).
 * 
 * When a cohort-only DSL is used and no explicit window() slice exists,
 * we construct an implicit baseline window to derive p.forecast and t95.
 * This is the minimum window size.
 * 
 * See design.md §5.2.1 for baseline window computation.
 */
export const LATENCY_BASELINE_MIN_WINDOW_DAYS = 30;

/**
 * Upper clamp for implicit baseline window (days).
 * 
 * Maximum window size for implicit baseline. Larger windows provide more
 * stable estimates but may include stale data.
 */
export const LATENCY_BASELINE_MAX_WINDOW_DAYS = 60;

// =============================================================================
// Default Values
// =============================================================================

/**
 * Default σ (sigma) for log-normal distribution when only median is available.
 * 
 * Used as fallback when mean lag data is missing. Represents moderate spread.
 * See design.md §5.4.2.
 */
export const LATENCY_DEFAULT_SIGMA = 0.5;

/**
 * Small epsilon for denominator safety in Formula A.
 * 
 * Used to prevent division by zero when (1 - p_∞ × F(a_i)) approaches 0.
 */
export const LATENCY_EPSILON = 1e-9;

/**
 * Default maturity percentile for t95 calculation.
 * 
 * The 95th percentile of the lag distribution - time by which 95% of
 * eventual converters have converted.
 */
export const LATENCY_T95_PERCENTILE = 0.95;

// =============================================================================
// Effective Sample Size
// =============================================================================

/**
 * Minimum effective sample size for recency-weighted p_infinity.
 * 
 * When using recency weighting, if N_eff < this threshold, widen the
 * window or fall back to unweighted estimate.
 * 
 * See design.md §5.6.
 */
export const LATENCY_MIN_EFFECTIVE_SAMPLE_SIZE = 100;

