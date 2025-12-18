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
 * the fitted distribution is marked low quality and the system should use
 * a conservative default horizon.
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
 * - This was incorrectly rejected, causing conservative fallback behaviour
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
 * Small epsilon for denominator safety in numerical probability calculations.
 */
export const LATENCY_EPSILON = 1e-9;

/**
 * Default maturity percentile for t95 calculation.
 * 
 * Percentile of the lag distribution used to define `t95` (naming kept for compatibility).
 * This is the time by which \(p\) of eventual converters have converted.
 */
export const LATENCY_T95_PERCENTILE = 0.95

/**
 * Percentile used when computing *path* latency horizons for cohort bounding (path_t95 / A→Y horizon).
 *
 * This can be set more conservatively than LATENCY_T95_PERCENTILE to reduce under-bounding
 * when upstream (A→X) has a fatter tail than edge (X→Y).
 *
 * Note: field names remain `t95` / `path_t95` in the UI; this constant governs the percentile
 * used for the *upper-bound estimation* that drives cohort fetch window bounding.
 */
export const LATENCY_PATH_T95_PERCENTILE = 0.95

/**
 * Decimal places to use when persisting latency horizon values (days).
 *
 * Applies to:
 * - `p.latency.t95`
 * - `p.latency.path_t95`
 * - `latency.t95` / `latency.path_t95` in parameter files (graph ↔ file sync)
 *
 * Rationale:
 * - Horizons are displayed in days; more than 2 d.p. is noise and makes diffs harder to read.
 */
export const LATENCY_HORIZON_DECIMAL_PLACES = 2;

// =============================================================================
// LAG Statistical Behaviour Constants (centralised)
// =============================================================================

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
export const FORECAST_BLEND_LAMBDA = 0.2;

/**
 * LATENCY_BLEND_COMPLETENESS_POWER (η)
 *
 * Short-term mitigation for "immature cohorts pull p.mean down too much".
 *
 * Problem:
 * - For cohort() queries, early-time completeness can be biased high (e.g. true start-delay δ>0,
 *   or thin-tail bias), which makes \(n_eff = completeness × n_query\) too large.
 * - That inflates \(w_evidence\) in the canonical blend, causing immature cohorts with low observed
 *   evidence.mean to drag p.mean down more than we intend.
 *
 * Mitigation:
 * - Use a *more conservative* completeness *only for weighting* in the forecast/evidence blend:
 *     completeness_for_blend_weight = completeness^η
 *     n_eff = completeness_for_blend_weight × n_query
 *
 * Key property:
 * - η = 1.0 preserves current behaviour exactly.
 * - η > 1.0 makes completeness smaller when completeness ∈ (0, 1), therefore reducing w_evidence
 *   for immature cohorts without changing:
 *     - the stored/displayed completeness
 *     - p.evidence.mean semantics (raw observed k/n)
 *     - the latency CDF itself
 *
 * This is intentionally a *tuning knob* while we pursue more principled fixes
 * (e.g. start-delay / shifted lognormal using histogram mass; see histogram-fitting.md).
 */
export const LATENCY_BLEND_COMPLETENESS_POWER = 2.5;

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
// Default should be conservative to avoid bloating session logs in normal operation.
// Runtime toggling is controlled via Session Log UI (SessionLogService).
export const DIAGNOSTIC_LOG = false;

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

/**
 * Decimal places to use for lag summary values (days).
 *
 * Applies to display-only lag summaries like:
 * - `p.latency.median_lag_days`
 * - `p.latency.mean_lag_days`
 *
 * Rationale:
 * - These can be sub-day values (minutes). 2 d.p. would collapse them to 0.00d.
 * - 4 d.p. keeps minute-level information while avoiding noisy 10+ d.p. churn.
 */
export const LATENCY_LAG_DECIMAL_PLACES = 4;

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
export const LATENCY_MIN_EFFECTIVE_SAMPLE_SIZE = 350;



