/**
 * Statistical Constants for LAG (Latency-Adjusted Graphs)
 * 
 * These constants control the statistical behaviour of latency-aware probability
 * calculations. See docs/current/project-lag/forecast-fix.md for full design rationale.
 */

/**
 * FORECAST_BLEND_LAMBDA (λ)
 * 
 * Controls how quickly evidence overrides forecast baselines in immature windows.
 * 
 * The blended p.mean is computed as:
 *   p.mean = w_evidence * p.evidence + (1 - w_evidence) * p.forecast
 * 
 * where:
 *   w_evidence = (c * n_q) / (λ * n_baseline + c * n_q)
 * 
 *   c          = completeness (0–1) from LAG
 *   n_q        = sample size in the query window
 *   n_baseline = sample size behind the forecast (from the window slice)
 *   λ          = this constant
 * 
 * Interpretation:
 *   - λ scales how "strong" the forecast prior is relative to its backing data.
 *   - λ = 0.25 means the forecast is treated as worth 25% of n_baseline pseudo-observations.
 *   - Lower λ → evidence dominates faster; higher λ → forecast dominates longer.
 * 
 * Calibrated against shipped-to-delivered sample data:
 *   With c = 0.6, n_q = 97, n_baseline = 412, λ = 0.25:
 *     w_evidence ≈ 0.36, yielding p.mean ≈ 88% (between evidence 71% and forecast 98%)
 * 
 * Future: This could be exposed as a user-configurable setting if needed.
 * See TODO.md "Analytics / Model Fitting (Future)" for tracking.
 */
export const FORECAST_BLEND_LAMBDA = 0.75;

/**
 * RECENCY_HALF_LIFE_DAYS (H)
 * 
 * Controls how much recent mature cohorts are favoured over older ones when
 * estimating the baseline forecast probability (p∞).
 * 
 * The recency-weighted estimator is:
 *   p∞ = (Σ w_i * k_i) / (Σ w_i * n_i)
 * 
 * where:
 *   w_i = exp(-age_i / H)
 * 
 *   age_i = age of cohort i in days
 *   H     = this constant (half-life in days)
 * 
 * Interpretation:
 *   - A cohort H days old has half the weight of a brand-new cohort.
 *   - Lower H → more aggressive recency bias (favours recent data heavily).
 *   - Higher H → more stable (older data contributes more).
 *   - H = Infinity → equal weights (unweighted average).
 * 
 * Recommended values per design.md Appendix C.1:
 *   - 7–14 days: aggressive, for fast-changing conversion rates
 *   - 30 days: balanced (default)
 *   - 60–90 days: conservative, for stable long-term baselines
 * 
 * Future: This could be exposed as a user-configurable slider if needed.
 * See TODO.md "Analytics / Model Fitting (Future)" for tracking.
 */
export const RECENCY_HALF_LIFE_DAYS = 30;

/**
 * COHORT_HORIZON_MIN_DAYS
 * 
 * Minimum horizon for cohort retrieval bounding, in days.
 * Prevents overly aggressive trimming when t95 is very small.
 * 
 * Even if a latency edge has t95 = 1 day, we still fetch at least this many
 * days of cohort data to avoid edge cases where converters arrive late.
 * 
 * See: retrieval-date-logic-implementation-plan.md §6
 */
export const COHORT_HORIZON_MIN_DAYS = 7;

/**
 * COHORT_HORIZON_BUFFER_DAYS
 * 
 * Buffer added to effective t95 when computing cohort retrieval horizons.
 * Provides safety margin because t95 is a statistical estimate (95th percentile),
 * meaning ~5% of converters arrive after t95.
 * 
 * Example: If path_t95 = 20 days, horizon = 20 + 2 = 22 days
 * 
 * See: retrieval-date-logic-implementation-plan.md §6
 */
export const COHORT_HORIZON_BUFFER_DAYS = 2;

/**
 * DEFAULT_T95_DAYS
 * 
 * Default t95 (95th percentile lag) value when no computed or user-supplied t95 is available.
 * Used as the fallback horizon for:
 * - Cohort retrieval bounding (when path_t95 and t95 are both missing)
 * - Default injection when user enables latency on an edge without historical data
 * 
 * This is the single source of truth for the default horizon fallback.
 * 
 * See: t95-fix.md §2.2, retrieval-date-logic-implementation-plan.md §9.1
 */
export const DEFAULT_T95_DAYS = 30;

/**
 * COHORT_HORIZON_DEFAULT_DAYS
 * 
 * @deprecated Use DEFAULT_T95_DAYS instead.
 * Retained as alias for backward compatibility during migration.
 */
export const COHORT_HORIZON_DEFAULT_DAYS = DEFAULT_T95_DAYS;

/**
 * DIAGNOSTIC_LOG
 * 
 * Controls whether verbose diagnostic data is included in session logs.
 * When true, DAS execution details (including full Amplitude response data)
 * are captured in session logs for debugging purposes.
 * 
 * Set to false for normal operation to avoid bloating session log exports.
 * Set to true temporarily when debugging query execution issues.
 */
export const DIAGNOSTIC_LOG = true;

/**
 * PRECISION_DECIMAL_PLACES
 * 
 * Standard decimal precision for probability and statistical values stored
 * on graph edges and in parameter files.
 * 
 * Used by:
 *   - UpdateManager: rounding LAG-computed values (p.mean, completeness, etc.)
 *   - Statistical services: rounding computed probabilities
 *   - Data operations: rounding fetched/aggregated values
 * 
 * Rationale:
 *   - 4 d.p. provides sufficient precision for probability values (0.0001 = 0.01%)
 *   - Avoids floating-point noise that adds no meaningful information
 *   - Balances precision against readability in logs and UI
 *   - More than 4 d.p. is generally noise for conversion probabilities
 * 
 * See: UpdateManager.roundToDP() which uses this constant.
 */
export const PRECISION_DECIMAL_PLACES = 4;

/**
 * ANCHOR_DELAY_BLEND_K_CONVERSIONS
 * 
 * Controls the rate at which observed anchor lag data overrides the prior
 * (baseline-derived) anchor delay in cohort mode completeness calculations.
 * 
 * The effective anchor delay is blended:
 *   effective_anchor_median = w * observed + (1-w) * prior
 * 
 * where:
 *   forecast_conversions = p.n * p.mean
 *   anchor_lag_coverage = fraction of cohort-days with valid anchor_median_lag_days
 *   effective_forecast_conversions = anchor_lag_coverage * forecast_conversions
 *   w = 1 - exp(-effective_forecast_conversions / ANCHOR_DELAY_BLEND_K_CONVERSIONS)
 * 
 * Interpretation:
 *   - At 50 effective forecast conversions, w ≈ 63% (observed data dominates)
 *   - At 100 effective forecast conversions, w ≈ 86%
 *   - At 150 effective forecast conversions, w ≈ 95%
 *   - When coverage is low or sample size is small, prior dominates
 * 
 * Rationale:
 *   - Prevents completeness from being incorrectly high for fresh cohorts
 *     on downstream edges when anchor lag evidence is sparse
 *   - Allows stable prior from baseline window to guide early estimates
 *   - Smoothly transitions to observed as cohort evidence accumulates
 * 
 * See: window-cohort-lag-correction-plan.md §5 Phase B
 */
export const ANCHOR_DELAY_BLEND_K_CONVERSIONS = 50;

