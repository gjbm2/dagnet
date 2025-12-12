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
 * For a true log-normal distribution, mean > median always (right-skewed),
 * and σ = sqrt(2 * ln(mean/median)) requires mean > median for real σ.
 * 
 * However, in practice:
 * - Real-world lag data often has mean ≈ median (low skew)
 * - Amplitude's per-day lag statistics have sampling noise
 * - A ratio of 0.99 doesn't indicate "broken data", just low variance
 * 
 * When ratio < 1.0, we cannot compute σ from the formula (would need ln of
 * a negative number), so we use LATENCY_DEFAULT_SIGMA instead. This is fine
 * for practical purposes—it just means the distribution has low spread.
 * 
 * Previous value (1.0) was too strict and rejected valid data where mean ≈ median.
 * 
 * CALIBRATION NOTE (Dec 2025):
 * - Observed Amplitude data with ratio = 0.9993 (mean=6.020d, median=6.024d)
 * - This was incorrectly rejected, causing fallback to maturity_days for t95
 * - Lowered to 0.9 to allow mean ≈ median cases while still catching bad data
 * 
 * When ratio is in [0.9, 1.0), we mark empirical_quality_ok = false but still
 * use the median-based μ with default σ, which is reasonable behaviour.
 */
export const LATENCY_MIN_MEAN_MEDIAN_RATIO = 0.9;

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
 * Percentile of the lag distribution used to define `t95` (naming kept for compatibility).
 * This is the time by which \(p\) of eventual converters have converted.
 */
export const LATENCY_T95_PERCENTILE = 0.979

/**
 * Percentile used when computing *path* latency horizons for cohort bounding (path_t95 / A→Y horizon).
 *
 * This can be set more conservatively than LATENCY_T95_PERCENTILE to reduce under-bounding
 * when upstream (A→X) has a fatter tail than edge (X→Y).
 *
 * Note: field names remain `t95` / `path_t95` in the UI; this constant governs the percentile
 * used for the *upper-bound estimation* that drives cohort fetch window bounding.
 */
export const LATENCY_PATH_T95_PERCENTILE = 0.99

/**
 * Cooldown for latency-aware refetching.
 *
 * When a slice was fetched very recently (based on `data_source.retrieved_at`),
 * we should not immediately refetch the “immature window” again. This is
 * particularly important for “Retrieve all slices”, which users may run
 * repeatedly while debugging failures: caches should prevent redundant calls.
 *
 * Behaviour:
 * - Missing cache gaps are still fetched (cache completeness wins).
 * - The maturity-driven “refresh last t95 days” (window) / “replace slice” (cohort)
 *   is suppressed during the cooldown window.
 */
export const LATENCY_REFETCH_COOLDOWN_MINUTES = 720;

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


