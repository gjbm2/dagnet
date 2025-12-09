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
export const FORECAST_BLEND_LAMBDA = 0.25;

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
 * COHORT_HORIZON_DEFAULT_DAYS
 * 
 * Default maturity horizon when no t95, path_t95, or maturity_days is available.
 * Used as a conservative fallback to prevent fetching excessive historical data.
 * 
 * See: retrieval-date-logic-implementation-plan.md §9.1
 */
export const COHORT_HORIZON_DEFAULT_DAYS = 30;

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
export const DIAGNOSTIC_LOG = false;

