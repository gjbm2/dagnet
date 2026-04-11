"""
Stats Engine — Python port of the FE analytic stats pass.

Port of: graph-editor/src/services/statisticalEnhancementService.ts

Functions ported:
  - estimate_p_infinity          (estimatePInfinity)
  - calculate_completeness       (calculateCompleteness)
  - calculate_completeness_with_tail_constraint
  - improve_fit_with_t95         (improveFitWithT95)
  - compute_blended_mean         (computeBlendedMean)
  - weighted_quantile            (weightedQuantile)
  - fw_compose_pair              (approximateLogNormalSumFit)
  - compute_edge_latency_stats   (computeEdgeLatencyStats)
  - enhance_graph_latencies      (enhanceGraphLatencies — full topo pass)

All functions are pure Python + math. No DB, no file I/O.
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from .lag_distribution_utils import (
    LagDistributionFit,
    fit_lag_distribution,
    log_normal_cdf,
    log_normal_inverse_cdf,
    standard_normal_inverse_cdf,
    to_model_space_age_days,
    to_model_space_lag_days,
    LATENCY_DEFAULT_SIGMA,
)
from .forecasting_settings import ForecastingSettings


# ─────────────────────────────────────────────────────────────
# Constants (match graph-editor/src/constants/latency.ts)
# ─────────────────────────────────────────────────────────────

T95_PERCENTILE = 0.95
PATH_T95_PERCENTILE = 0.95
DEFAULT_T95_DAYS = 30
SIGMA_CAP = 10.0  # prevent catastrophic blow-ups
ANCHOR_DELAY_BLEND_K_CONVERSIONS = 50
LATENCY_MIN_EFFECTIVE_SAMPLE_SIZE = 150
LATENCY_EPSILON = 1e-9


# ─────────────────────────────────────────────────────────────
# Recency weighting
# ─────────────────────────────────────────────────────────────

def _recency_weight(age_days: float, half_life_days: float) -> float:
    if half_life_days <= 0 or not math.isfinite(half_life_days):
        return 1.0
    if not math.isfinite(age_days) or age_days < 0:
        return 1.0
    return math.exp(-math.log(2) * age_days / half_life_days)


# ─────────────────────────────────────────────────────────────
# Weighted quantile
# ─────────────────────────────────────────────────────────────

def weighted_quantile(
    pairs: List[Tuple[float, float]],
    q: float = 0.95,
) -> Optional[float]:
    """Weighted quantile over (value, weight) pairs.

    Used for join-aware path_t95 (flow-mass-weighted 95th percentile).
    """
    cleaned = [
        (v, w if math.isfinite(w) and w > 0 else 0.0)
        for v, w in pairs
        if math.isfinite(v) and v > 0
    ]
    if not cleaned:
        return None

    total_w = sum(w for _, w in cleaned)
    if total_w <= 0:
        weighted = [(v, 1.0 / len(cleaned)) for v, _ in cleaned]
    else:
        weighted = [(v, w / total_w) for v, w in cleaned]

    weighted.sort(key=lambda x: x[0])
    cum = 0.0
    for v, w in weighted:
        cum += w
        if cum + 1e-12 >= q:
            return v
    return weighted[-1][0] if weighted else None


# ─────────────────────────────────────────────────────────────
# p∞ estimation
# ─────────────────────────────────────────────────────────────

@dataclass
class CohortData:
    """Minimal cohort data for stats pass computation."""
    date: str
    age: float
    n: int
    k: int
    anchor_median_lag_days: Optional[float] = None
    anchor_mean_lag_days: Optional[float] = None
    median_lag_days: Optional[float] = None
    mean_lag_days: Optional[float] = None


@dataclass
class EdgeContext:
    """Per-edge context sent alongside cohort data for full FE parity.

    These fields carry information the FE topo pass derives from raw
    ParameterValue slices that cannot be reconstructed from aggregated
    CohortData alone.
    """
    # Onset derived from window() slice histogram data (weighted quantile).
    # When provided, overrides the graph-stored onset_delta_days.
    onset_from_window_slices: Optional[float] = None
    # Window-mode cohorts for deriving forecast.mean when edge.p.forecast.mean
    # is not pre-populated. Same shape as CohortData.
    window_cohorts: Optional[List[CohortData]] = None
    # n from window() slices backing the forecast (nBaseline).
    n_baseline_from_window: Optional[int] = None
    # Cohorts scoped to the active cohort window (used for evidence/completeness/blend).
    # When absent, all cohorts are used (equivalent to no cohort window).
    scoped_cohorts: Optional[List[CohortData]] = None


def estimate_p_infinity(
    cohorts: List[CohortData],
    t95: float,
    recency_half_life_days: float = 30.0,
) -> Optional[float]:
    """Estimate asymptotic conversion probability from mature cohorts.

    p∞ = Σ(w_i × k_i) / Σ(w_i × n_i)
    where w_i = exp(-ln(2) × age_i / H), only for cohorts with age >= t95.
    """
    mature = [c for c in cohorts if c.age >= t95]
    if not mature:
        return None

    weighted_n = 0.0
    weighted_k = 0.0
    for c in mature:
        w = _recency_weight(c.age, recency_half_life_days)
        weighted_n += w * c.n
        weighted_k += w * c.k

    if weighted_n == 0:
        return None
    return weighted_k / weighted_n


# ─────────────────────────────────────────────────────────────
# Completeness
# ─────────────────────────────────────────────────────────────

def calculate_completeness(
    cohorts: List[CohortData],
    mu: float,
    sigma: float,
    onset_delta_days: float = 0.0,
) -> float:
    """completeness = Σ(n_i × F(age_i - onset)) / Σn_i"""
    total_n = 0
    weighted_sum = 0.0
    for c in cohorts:
        if c.n == 0:
            continue
        age_x = to_model_space_age_days(onset_delta_days, c.age)
        f_age = log_normal_cdf(age_x, mu, sigma)
        total_n += c.n
        weighted_sum += c.n * f_age
    return weighted_sum / total_n if total_n > 0 else 0.0


def calculate_completeness_with_tail_constraint(
    cohorts: List[CohortData],
    mu: float,
    sigma_moments: float,
    sigma_constrained: float,
    tail_constraint_applied: bool,
    onset_delta_days: float = 0.0,
) -> float:
    """Completeness with one-way tail safety.

    When the tail constraint widened sigma, use min(F_moments, F_constrained)
    per cohort to prevent the constraint from INCREASING completeness.
    """
    if not tail_constraint_applied:
        return calculate_completeness(cohorts, mu, sigma_moments, onset_delta_days)

    total_n = 0
    weighted_sum = 0.0
    for c in cohorts:
        if c.n == 0:
            continue
        age_x = to_model_space_age_days(onset_delta_days, c.age)
        f_moments = log_normal_cdf(age_x, mu, sigma_moments)
        f_constrained = log_normal_cdf(age_x, mu, sigma_constrained)
        f_age = min(f_moments, f_constrained)
        total_n += c.n
        weighted_sum += c.n * f_age
    return weighted_sum / total_n if total_n > 0 else 0.0


# ─────────────────────────────────────────────────────────────
# Tail constraint (improve fit with authoritative t95)
# ─────────────────────────────────────────────────────────────

def improve_fit_with_t95(
    fit: LagDistributionFit,
    median_lag_days: float,
    authoritative_t95_days: float,
) -> LagDistributionFit:
    """One-way sigma widening: if authoritative t95 implies a larger sigma, use it."""
    sigma_safe = fit.sigma if (math.isfinite(fit.sigma) and fit.sigma > 0) else LATENCY_DEFAULT_SIGMA

    z = standard_normal_inverse_cdf(T95_PERCENTILE)
    can_compute = (
        math.isfinite(z) and z > 0
        and math.isfinite(median_lag_days) and median_lag_days > 0
        and math.isfinite(authoritative_t95_days) and authoritative_t95_days > 0
    )

    sigma_min = None
    if can_compute and authoritative_t95_days > median_lag_days:
        sigma_min = math.log(authoritative_t95_days / median_lag_days) / z

    applied = (
        sigma_min is not None
        and math.isfinite(sigma_min)
        and sigma_min > sigma_safe
    )

    sigma_raw = sigma_min if applied else sigma_safe
    sigma_final = min(sigma_raw, SIGMA_CAP) if (math.isfinite(sigma_raw) and sigma_raw > 0) else sigma_safe

    return LagDistributionFit(
        mu=fit.mu,
        sigma=sigma_final,
        empirical_quality_ok=fit.empirical_quality_ok,
        total_k=fit.total_k,
        quality_failure_reason=fit.quality_failure_reason,
    )


# ─────────────────────────────────────────────────────────────
# Completeness CDF params (getCompletenessCdfParams)
# ─────────────────────────────────────────────────────────────

@dataclass
class CompletenessCdfParams:
    mu: float
    sigma: float
    sigma_moments: float
    sigma_min_from_t95: Optional[float]
    tail_constraint_applied: bool


def get_completeness_cdf_params(
    fit: LagDistributionFit,
    median_lag_days: float,
    authoritative_t95_days: float,
    onset_delta_days: float = 0.0,
) -> CompletenessCdfParams:
    """Derive CDF params for completeness, including tail constraint detection."""
    mu = fit.mu
    sigma_moments = fit.sigma if (math.isfinite(fit.sigma) and fit.sigma > 0) else LATENCY_DEFAULT_SIGMA

    auth_t95_model = to_model_space_lag_days(onset_delta_days, authoritative_t95_days) if onset_delta_days > 0 else authoritative_t95_days

    z = standard_normal_inverse_cdf(T95_PERCENTILE)
    can_compute = (
        math.isfinite(z) and z > 0
        and math.isfinite(median_lag_days) and median_lag_days > 0
        and math.isfinite(auth_t95_model) and auth_t95_model > 0
    )

    sigma_min = None
    if can_compute and auth_t95_model > median_lag_days:
        sigma_min = math.log(auth_t95_model / median_lag_days) / z

    applied = (
        sigma_min is not None
        and math.isfinite(sigma_min)
        and sigma_min > sigma_moments + 1e-12
    )

    sigma_raw = sigma_min if applied else sigma_moments
    sigma_final = min(sigma_raw, SIGMA_CAP) if (math.isfinite(sigma_raw) and sigma_raw > 0) else sigma_moments

    return CompletenessCdfParams(
        mu=mu,
        sigma=sigma_final,
        sigma_moments=sigma_moments,
        sigma_min_from_t95=sigma_min,
        tail_constraint_applied=applied,
    )


# ─────────────────────────────────────────────────────────────
# Blended mean
# ─────────────────────────────────────────────────────────────

def compute_blended_mean(
    evidence_mean: Optional[float],
    forecast_mean: Optional[float],
    completeness: Optional[float],
    n_query: int,
    n_baseline: int,
    forecast_blend_lambda: float = 0.15,
    blend_completeness_power: float = 2.25,
) -> Optional[float]:
    """Compute blended p.mean from evidence + forecast.

    w_evidence = n_eff / (m0_eff + n_eff)
    where n_eff = completeness^η × n_query
    and   m0_eff = λ × n_baseline × (1 - completeness^η)
    """
    if n_baseline <= 0 or forecast_mean is None or not math.isfinite(forecast_mean):
        return None
    if completeness is None or evidence_mean is None:
        return None

    c_power = max(0.0, min(1.0, completeness ** blend_completeness_power)) if (
        math.isfinite(completeness) and completeness > 0
    ) else 0.0

    n_eff = c_power * n_query
    remaining = max(0.0, 1.0 - c_power)
    m0 = forecast_blend_lambda * n_baseline
    m0_eff = m0 * remaining
    w_evidence = n_eff / (m0_eff + n_eff) if (m0_eff + n_eff) > 0 else 0.0

    return w_evidence * evidence_mean + (1.0 - w_evidence) * forecast_mean


# ─────────────────────────────────────────────────────────────
# D2 FIX: Per-day blended mean (mirrors FE computePerDayBlendedMean)
# ─────────────────────────────────────────────────────────────

def compute_per_day_blended_mean(
    cohorts: List[CohortData],
    forecast_mean: float,
    n_baseline: int,
    cdf_mu: float,
    cdf_sigma: float,
    onset_delta_days: float = 0.0,
    cdf_sigma_moments: Optional[float] = None,
    tail_constraint_applied: bool = False,
    forecast_blend_lambda: float = 0.15,
    blend_completeness_power: float = 2.25,
) -> Optional[Tuple[float, float]]:
    """Per-day blended p.mean — each date gets its own blend weight from its
    own completeness, so mature cohorts contribute nearly pure evidence while
    immature cohorts lean on the forecast.

    Returns (blended_mean, completeness_agg) or None if inputs are insufficient.

    Port of FE computePerDayBlendedMean (statisticalEnhancementService.ts).
    """
    if n_baseline <= 0 or not math.isfinite(forecast_mean) or len(cohorts) == 0:
        return None

    use_tail_constraint = tail_constraint_applied and cdf_sigma_moments is not None

    total_n = 0
    total_k = 0
    effective_n = 0.0  # sum(n_i * c_i)
    weighted_completeness = 0.0
    weighted_blended_rate = 0.0

    # Pass 1: compute per-day completeness and accumulate totals for pooled rate
    day_data: List[Tuple[int, int, float, float]] = []  # (n, k, c_i, w_i)
    for c in cohorts:
        if c.n <= 0:
            continue

        age_x = to_model_space_age_days(onset_delta_days, c.age)
        if use_tail_constraint:
            f_moments = log_normal_cdf(age_x, cdf_mu, cdf_sigma_moments)
            f_constrained = log_normal_cdf(age_x, cdf_mu, cdf_sigma)
            c_i = min(f_moments, f_constrained)
        else:
            c_i = log_normal_cdf(age_x, cdf_mu, cdf_sigma)
        c_i = max(0.0, min(1.0, c_i))

        # Per-day blend weight (same formula as compute_blended_mean)
        c_eff = min(1.0, max(0.0, c_i ** blend_completeness_power)) if c_i > 0 else 0.0
        n_eff = c_eff * c.n
        remaining = max(0.0, 1.0 - c_eff)
        m0_eff = forecast_blend_lambda * n_baseline * remaining
        w_i = (n_eff / (m0_eff + n_eff)) if (m0_eff + n_eff) > 0 else 0.0

        total_n += c.n
        total_k += c.k
        effective_n += c.n * c_i
        weighted_completeness += c.n * c_i

        day_data.append((c.n, c.k, c_i, w_i))

    if total_n <= 0:
        return None

    # Pooled de-biased rate: p̂ = sum(k) / sum(n * c)
    pooled_rate = min(1.0, total_k / effective_n) if effective_n > 0 else 0.0

    # Pass 2: apply per-day weights to pooled rate
    for n_i, _k_i, _c_i, w_i in day_data:
        blended_rate_i = w_i * pooled_rate + (1.0 - w_i) * forecast_mean
        weighted_blended_rate += n_i * blended_rate_i

    blended_mean = weighted_blended_rate / total_n
    completeness_agg = weighted_completeness / total_n
    return (blended_mean, completeness_agg)


# ─────────────────────────────────────────────────────────────
# FW composition (approximateLogNormalSumFit)
# ─────────────────────────────────────────────────────────────

def fw_compose_pair(
    a: LagDistributionFit,
    b: LagDistributionFit,
) -> Optional[Tuple[float, float]]:
    """FW moment-matched sum of two lognormals. Returns (mu, sigma) or None."""
    if not a.empirical_quality_ok or not b.empirical_quality_ok:
        return None
    for x in (a.mu, a.sigma, b.mu, b.sigma):
        if not math.isfinite(x):
            return None
    if a.sigma < 0 or b.sigma < 0:
        return None

    def mean_of(mu: float, sigma: float) -> float:
        try:
            return math.exp(mu + sigma * sigma / 2)
        except OverflowError:
            return float('inf')

    def var_of(mu: float, sigma: float) -> float:
        s2 = sigma * sigma
        try:
            return (math.exp(s2) - 1) * math.exp(2 * mu + s2)
        except OverflowError:
            return float('inf')

    m = mean_of(a.mu, a.sigma) + mean_of(b.mu, b.sigma)
    v = var_of(a.mu, a.sigma) + var_of(b.mu, b.sigma)

    if not math.isfinite(m) or not math.isfinite(v) or m <= 0 or v < 0:
        return None

    sigma2 = math.log(1 + v / (m * m))
    sigma = math.sqrt(sigma2)
    mu = math.log(m) - sigma2 / 2

    if not math.isfinite(mu) or not math.isfinite(sigma) or sigma < 0:
        return None
    return (mu, sigma)


def fw_compose_percentile(
    a: LagDistributionFit,
    b: LagDistributionFit,
    percentile: float,
) -> Optional[float]:
    """Percentile of FW-composed sum."""
    result = fw_compose_pair(a, b)
    if result is None:
        return None
    mu, sigma = result
    return log_normal_inverse_cdf(percentile, mu, sigma)


# ─────────────────────────────────────────────────────────────
# Edge latency stats (computeEdgeLatencyStats)
# ─────────────────────────────────────────────────────────────

@dataclass
class EdgeLatencyStats:
    fit: LagDistributionFit
    t95: float
    p_infinity: float
    completeness: float
    p_evidence: float
    forecast_available: bool
    completeness_cdf: CompletenessCdfParams
    # Heuristic dispersion (see heuristic-dispersion-design.md §3)
    p_sd: float = 0.0
    mu_sd: float = 0.0
    sigma_sd: float = 0.0
    onset_sd: float = 0.0
    onset_mu_corr: float = 0.0


def compute_edge_latency_stats(
    cohorts: List[CohortData],
    aggregate_median_lag: float,
    aggregate_mean_lag: Optional[float],
    default_t95_days: float,
    anchor_median_lag: float = 0.0,
    fit_total_k_override: Optional[float] = None,
    p_infinity_cohorts_override: Optional[List[CohortData]] = None,
    edge_t95: Optional[float] = None,
    recency_half_life_days: float = 30.0,
    onset_delta_days: float = 0.0,
    max_mean_median_ratio: float = 999999,
    apply_anchor_age_adjustment: bool = True,
    settings: Optional[ForecastingSettings] = None,
) -> EdgeLatencyStats:
    """Port of FE computeEdgeLatencyStats."""
    total_k = sum(c.k for c in cohorts)
    total_n = sum(c.n for c in cohorts)
    fit_total_k = fit_total_k_override if fit_total_k_override is not None else total_k

    # Adjust cohort ages by anchor median lag
    if apply_anchor_age_adjustment and anchor_median_lag > 0:
        adjusted = [
            CohortData(
                date=c.date,
                age=max(0, c.age - (c.anchor_median_lag_days if c.anchor_median_lag_days is not None else anchor_median_lag)),
                n=c.n, k=c.k,
                anchor_median_lag_days=c.anchor_median_lag_days,
                anchor_mean_lag_days=c.anchor_mean_lag_days,
                median_lag_days=c.median_lag_days,
                mean_lag_days=c.mean_lag_days,
            )
            for c in cohorts
        ]
    else:
        adjusted = cohorts

    # Step 1: Fit lag distribution
    model_median = to_model_space_lag_days(onset_delta_days, aggregate_median_lag)
    model_mean = to_model_space_lag_days(onset_delta_days, aggregate_mean_lag) if aggregate_mean_lag is not None else None

    fit_initial = fit_lag_distribution(
        model_median, model_mean, fit_total_k,
        max_mean_median_ratio=max_mean_median_ratio,
    )

    # Step 2: Derive t95
    t95_from_fit_x = log_normal_inverse_cdf(T95_PERCENTILE, fit_initial.mu, fit_initial.sigma) if fit_initial.empirical_quality_ok else to_model_space_lag_days(onset_delta_days, default_t95_days)
    t95_from_fit_t = onset_delta_days + t95_from_fit_x

    # Step 3: Authoritative t95
    if edge_t95 is not None and math.isfinite(edge_t95) and edge_t95 > 0:
        auth_t95 = edge_t95
    elif math.isfinite(t95_from_fit_t) and t95_from_fit_t > 0:
        auth_t95 = t95_from_fit_t
    else:
        auth_t95 = default_t95_days
    auth_t95_x = to_model_space_lag_days(onset_delta_days, auth_t95)

    # Step 4: Improve fit with t95 constraint
    fit = improve_fit_with_t95(fit_initial, model_median, auth_t95_x)

    # Step 5: Final t95
    if fit.empirical_quality_ok:
        t95_x = log_normal_inverse_cdf(T95_PERCENTILE, fit.mu, fit.sigma)
        t95 = onset_delta_days + t95_x
    else:
        t95 = auth_t95

    # Completeness CDF params
    sigma_moments_safe = fit_initial.sigma if (math.isfinite(fit_initial.sigma) and fit_initial.sigma > 0) else LATENCY_DEFAULT_SIGMA
    sigma_constrained = fit.sigma if (math.isfinite(fit.sigma) and fit.sigma > 0) else sigma_moments_safe
    tail_applied = sigma_constrained > sigma_moments_safe + 1e-12

    z_val = standard_normal_inverse_cdf(T95_PERCENTILE)
    sigma_min_from_t95 = None
    if (math.isfinite(z_val) and z_val > 0
            and math.isfinite(model_median) and model_median > 0
            and math.isfinite(auth_t95_x) and auth_t95_x > 0
            and auth_t95_x > model_median):
        sigma_min_from_t95 = math.log(auth_t95_x / model_median) / z_val

    cdf_params = CompletenessCdfParams(
        mu=fit.mu,
        sigma=sigma_constrained,
        sigma_moments=sigma_moments_safe,
        sigma_min_from_t95=sigma_min_from_t95,
        tail_constraint_applied=tail_applied,
    )

    # p_infinity from mature cohorts (use ORIGINAL ages for maturity)
    p_inf_cohorts = p_infinity_cohorts_override if p_infinity_cohorts_override is not None else cohorts
    p_inf = estimate_p_infinity(p_inf_cohorts, t95, recency_half_life_days)

    p_evidence = total_k / total_n if total_n > 0 else 0.0

    # Completeness from ADJUSTED cohorts
    completeness = calculate_completeness_with_tail_constraint(
        adjusted,
        cdf_params.mu,
        cdf_params.sigma_moments,
        cdf_params.sigma,
        cdf_params.tail_constraint_applied,
        onset_delta_days,
    )

    # ── Heuristic dispersion estimates (design doc §3) ────────────────
    quality_inflation = 1.0 if fit.empirical_quality_ok else 2.0
    sigma_for_sd = sigma_moments_safe if sigma_moments_safe > 0 else fit.sigma

    # §3.1 Rate uncertainty: Beta-binomial posterior SD
    p_alpha = total_k + 1
    p_beta_val = max(1, total_n - total_k + 1)  # guard against k > n (data corruption)
    p_sd_raw = math.sqrt(p_alpha * p_beta_val / ((p_alpha + p_beta_val) ** 2 * (p_alpha + p_beta_val + 1)))
    p_sd = max(p_sd_raw, 0.10) if total_k < 30 else p_sd_raw

    # §3.2 Latency location uncertainty: ~1.25 × σ / √totalK
    n_lag = max(total_k, 1)
    mu_sd = max(1.25 * sigma_for_sd / math.sqrt(n_lag) * quality_inflation, 0.02)

    # §3.3 Latency scale uncertainty: ~0.87 × σ / √totalK
    sigma_is_default = (not fit.empirical_quality_ok) or abs(sigma_for_sd - LATENCY_DEFAULT_SIGMA) < 1e-9
    sigma_sd_raw = 0.10 if sigma_is_default else 0.87 * sigma_for_sd / math.sqrt(n_lag)
    sigma_sd = max(sigma_sd_raw * quality_inflation, 0.02)

    # §3.4 Onset uncertainty: max(0.2, 0.10 × onset), capped at 1.0
    # Onset has outsized influence on band width near the CDF inflection point.
    # Bayesian posteriors give onset_sd ≈ 0.1–0.3.
    onset_sd = min(1.0, max(0.2, 0.10 * onset_delta_days))

    # §3.5 Onset-mu correlation: structural prior
    onset_mu_corr = -0.3 if onset_delta_days > 0 else 0.0

    if p_inf is None:
        return EdgeLatencyStats(
            fit=fit, t95=t95, p_infinity=p_evidence, completeness=completeness,
            p_evidence=p_evidence, forecast_available=False,
            completeness_cdf=cdf_params,
            p_sd=p_sd, mu_sd=mu_sd, sigma_sd=sigma_sd,
            onset_sd=onset_sd, onset_mu_corr=onset_mu_corr,
        )

    return EdgeLatencyStats(
        fit=fit, t95=t95, p_infinity=p_inf, completeness=completeness,
        p_evidence=p_evidence, forecast_available=True,
        completeness_cdf=cdf_params,
        p_sd=p_sd, mu_sd=mu_sd, sigma_sd=sigma_sd,
        onset_sd=onset_sd, onset_mu_corr=onset_mu_corr,
    )


# ─────────────────────────────────────────────────────────────
# Full topo pass (enhanceGraphLatencies)
# ─────────────────────────────────────────────────────────────

@dataclass
class EdgeLAGValues:
    """Output per edge from the topo pass."""
    edge_uuid: str
    conditional_index: Optional[int] = None  # None = base edge, int = conditional_p[i]
    t95: float = 0.0
    path_t95: float = 0.0
    completeness: float = 1.0
    mu: float = 0.0
    sigma: float = LATENCY_DEFAULT_SIGMA
    onset_delta_days: float = 0.0
    median_lag_days: Optional[float] = None
    mean_lag_days: Optional[float] = None
    path_mu: Optional[float] = None
    path_sigma: Optional[float] = None
    path_onset_delta_days: float = 0.0
    p_infinity: Optional[float] = None
    p_evidence: float = 0.0
    forecast_available: bool = False
    blended_mean: Optional[float] = None
    # Heuristic dispersion (see heuristic-dispersion-design.md §3)
    p_sd: float = 0.0
    mu_sd: float = 0.0
    sigma_sd: float = 0.0
    onset_sd: float = 0.0
    onset_mu_corr: float = 0.0
    path_mu_sd: float = 0.0
    path_sigma_sd: float = 0.0
    path_onset_sd: float = 0.0


@dataclass
class TopoPassResult:
    edges_processed: int = 0
    edges_with_lag: int = 0
    edge_values: List[EdgeLAGValues] = field(default_factory=list)


def enhance_graph_latencies(
    graph: Dict[str, Any],
    param_lookup: Dict[str, List[CohortData]],
    settings: Optional[ForecastingSettings] = None,
    edge_contexts: Optional[Dict[str, EdgeContext]] = None,
    query_mode: str = 'cohort',
    active_edges: Optional[set] = None,
) -> TopoPassResult:
    """Full topo pass: walk graph edges in topological order, compute latency stats.

    Args:
        graph: Graph dict with 'nodes' and 'edges'.
        param_lookup: edge_id → list of CohortData (pre-aggregated cohort data per edge).
        settings: Forecasting settings (constants).
        query_mode: 'cohort' | 'window' | 'none' — matches FE lagSliceSource (D1 FIX).
        active_edges: Optional FE-computed active edge set (D5 FIX). When provided,
            used instead of the latency_parameter-only check.

    Returns:
        TopoPassResult with per-edge EdgeLAGValues.
    """
    s = settings or ForecastingSettings()
    result = TopoPassResult()

    # D1 FIX: window mode flag — mirrors FE's isWindowMode
    is_window_mode = query_mode == 'window'

    nodes = graph.get("nodes", [])
    edges_raw = graph.get("edges", [])

    # Build adjacency
    node_by_id: Dict[str, Dict] = {}
    for n in nodes:
        node_by_id[n.get("uuid", n.get("id", ""))] = n
        if n.get("id") and n["id"] != n.get("uuid"):
            node_by_id[n["id"]] = n

    outgoing: Dict[str, List[Dict]] = defaultdict(list)
    incoming: Dict[str, List[Dict]] = defaultdict(list)
    for e in edges_raw:
        outgoing[e["from"]].append(e)
        incoming[e["to"]].append(e)

    # Find anchor node
    anchor_id = None
    for n in nodes:
        if (n.get("entry") or {}).get("is_start"):
            anchor_id = n.get("uuid") or n.get("id")
            break
    if anchor_id is None and nodes:
        anchor_id = nodes[0].get("uuid") or nodes[0].get("id")

    # D5 FIX: Use FE-provided active edge set when available (probability-gated,
    # scenario-aware). Fall back to latency_parameter-only check for backward compat.
    if active_edges is not None:
        _active_edges = active_edges
    else:
        _active_edges = set()
        for e in edges_raw:
            lat = (e.get("p") or {}).get("latency") or {}
            if lat.get("latency_parameter"):
                eid = e.get("uuid") or e.get("id", "")
                _active_edges.add(eid)

    # DP state
    node_path_t95: Dict[str, float] = {anchor_id: 0.0}
    edge_path_t95: Dict[str, float] = {}
    edge_flow_mass: Dict[str, float] = {}
    node_arriving_mass: Dict[str, float] = {anchor_id: 1.0}
    node_path_mu: Dict[str, Optional[float]] = {anchor_id: None}
    node_path_sigma: Dict[str, Optional[float]] = {anchor_id: None}
    node_path_onset: Dict[str, float] = {anchor_id: 0.0}
    # Heuristic dispersion DP state (quadrature sum through topo pass)
    node_path_mu_sd: Dict[str, float] = {anchor_id: 0.0}
    node_path_sigma_sd: Dict[str, float] = {anchor_id: 0.0}
    node_path_onset_sd: Dict[str, float] = {anchor_id: 0.0}
    node_median_lag_prior: Dict[str, float] = {anchor_id: 0.0}
    node_dominant_edge: Dict[str, str] = {}  # D9 FIX: track winning edge for tie-breaking

    # D9 FIX: Kahn's topo sort — use list (insertion order) instead of set for
    # deterministic traversal. Sort initial queue by node ID for stable tie-breaking.
    in_degree: Dict[str, int] = {}
    all_node_ids: List[str] = []
    _seen_node_ids: set = set()
    for n in nodes:
        nid = n.get("uuid") or n.get("id", "")
        if nid not in _seen_node_ids:
            all_node_ids.append(nid)
            _seen_node_ids.add(nid)
        in_degree[nid] = 0
    for e in edges_raw:
        to_id = e["to"]
        in_degree[to_id] = in_degree.get(to_id, 0) + 1

    queue: List[str] = sorted(
        [nid for nid in all_node_ids if in_degree.get(nid, 0) == 0],
        key=str,
    )
    if anchor_id and anchor_id not in queue:
        queue.append(anchor_id)

    def _get_edge_id(e: Dict) -> str:
        return e.get("uuid") or e.get("id", "")

    visited_edges: set = set()

    while queue:
        node_id = queue.pop(0)
        path_t95_to_node = node_path_t95.get(node_id, 0.0)

        # Join-aware path horizon
        inc_edges = incoming.get(node_id, [])
        if inc_edges and node_id != anchor_id:
            pairs = []
            for ie in inc_edges:
                ie_id = _get_edge_id(ie)
                v = edge_path_t95.get(ie_id, 0.0)
                w = edge_flow_mass.get(ie_id, 0.0)
                if v > 0:
                    pairs.append((v, w))
            q_val = weighted_quantile(pairs, PATH_T95_PERCENTILE)
            if q_val is not None:
                path_t95_to_node = q_val

        for edge in outgoing.get(node_id, []):
            edge_id = _get_edge_id(edge)
            if edge_id in visited_edges:
                continue
            visited_edges.add(edge_id)
            result.edges_processed += 1

            to_node = edge["to"]
            p_block = edge.get("p") or {}
            lat_block = p_block.get("latency") or {}
            has_latency = edge_id in _active_edges

            # Propagate flow mass
            from_mass = node_arriving_mass.get(node_id, 0.0)
            edge_prob = p_block.get("mean", 0.0)
            if not isinstance(edge_prob, (int, float)) or not math.isfinite(edge_prob):
                edge_prob = 0.0
            edge_mass = from_mass * max(0, edge_prob)
            edge_flow_mass[edge_id] = edge_mass
            if edge_mass > 0:
                node_arriving_mass[to_node] = node_arriving_mass.get(to_node, 0.0) + edge_mass

            # No latency and no upstream lag → skip
            if not has_latency and path_t95_to_node <= 0:
                _propagate_path_state(
                    edge_id, node_id, to_node,
                    node_path_mu, node_path_sigma, node_path_onset,
                    edge_path_t95, node_path_t95, 0.0,
                    node_dominant_edge,
                    node_path_mu_sd, node_path_sigma_sd, node_path_onset_sd,
                )
                _decrement_and_enqueue(to_node, in_degree, queue)
                continue

            # D4 FIX (revised): Two distinct t95 values serve different purposes.
            #
            # user_t95: raw edge.p.latency.t95 — user's authoritative tail constraint.
            #   Used as fit input (improveFitWithT95 drags sigma to match this).
            #   Reading promoted_t95 here would create a feedback loop.
            #
            # effective_t95: promoted_t95 ?? t95 — best available horizon estimate.
            #   Used for path accumulation, completeness, window planning.
            #   Matches FE's computePathT95 which reads promoted_t95 first.
            raw_t95 = lat_block.get("t95")
            user_t95 = raw_t95 if (isinstance(raw_t95, (int, float)) and math.isfinite(raw_t95) and raw_t95 > 0) else None

            promoted_t95 = lat_block.get("promoted_t95")
            effective_t95 = promoted_t95 if (isinstance(promoted_t95, (int, float)) and math.isfinite(promoted_t95) and promoted_t95 > 0) else user_t95

            effective_horizon = effective_t95 if (has_latency and effective_t95) else (effective_t95 or DEFAULT_T95_DAYS if has_latency else path_t95_to_node)

            # Get cohort data for this edge
            cohorts = param_lookup.get(edge_id, [])
            if not cohorts:
                _propagate_path_state(
                    edge_id, node_id, to_node,
                    node_path_mu, node_path_sigma, node_path_onset,
                    edge_path_t95, node_path_t95, path_t95_to_node + (effective_t95 or DEFAULT_T95_DAYS if has_latency else 0),
                    node_dominant_edge,
                    node_path_mu_sd, node_path_sigma_sd, node_path_onset_sd,
                )
                _decrement_and_enqueue(to_node, in_degree, queue)
                continue

            # Resolve scoped cohorts (cohort-window-filtered) vs all cohorts.
            # FE distinguishes cohortsScoped (for evidence/completeness) from
            # cohortsAll (for fitting/p∞). The BE receives both via EdgeContext.
            ctx = (edge_contexts or {}).get(edge_id)
            cohorts_scoped = (ctx.scoped_cohorts if ctx and ctx.scoped_cohorts else cohorts)

            # D3+D8 FIX: Left-censor fitting evidence to most recent N days (FE parity)
            # FE uses date-based: anchor_day >= (asOf - (N-1) days), i.e. inclusive last N days.
            # With age-based approximation: age < N (strict less-than matches FE's N-1 semantics).
            censor_n = int(s.fit_left_censor_days) if s.fit_left_censor_days > 0 else 0
            if censor_n > 0 and cohorts:
                cohorts_for_fit = [c for c in cohorts if c.age < censor_n]
                if not cohorts_for_fit:
                    cohorts_for_fit = cohorts  # fallback if all censored
            else:
                cohorts_for_fit = cohorts

            # Aggregate lag stats
            agg_median, agg_mean, total_k_weighted = _aggregate_lag_stats(cohorts_for_fit, s.recency_half_life_days)
            if agg_median is None:
                agg_median = effective_horizon / 2.0

            # D2 FIX: Onset — prefer window-slice-derived onset over graph-stored value
            if ctx and ctx.onset_from_window_slices is not None and math.isfinite(ctx.onset_from_window_slices):
                onset = ctx.onset_from_window_slices
            else:
                onset = lat_block.get("onset_delta_days", 0.0)
                if not isinstance(onset, (int, float)) or not math.isfinite(onset):
                    onset = 0.0

            # D1 FIX: Anchor delay — exponential credibility blend (FE lines 2194-2256)
            # Window mode: FE skips anchor delay blend entirely (window cohorts are not
            # anchored at the entry node A, so the prior/blend mechanism is meaningless).
            if is_window_mode:
                anchor_median_lag = 0.0
            else:
                anchor_cohorts = [c for c in cohorts if c.anchor_median_lag_days is not None and c.anchor_median_lag_days > 0 and c.n > 0]
                if anchor_cohorts:
                    total_n_anchor = sum(c.n for c in anchor_cohorts)
                    observed_anchor = sum(c.n * c.anchor_median_lag_days for c in anchor_cohorts) / (total_n_anchor or 1)
                else:
                    observed_anchor = 0.0

                prior_anchor = node_median_lag_prior.get(node_id, 0.0)

                # Anchor lag coverage: fraction of cohort-days with valid anchor data
                total_cohorts_in_scope = sum(1 for c in cohorts if c.n > 0)
                anchor_lag_coverage = len(anchor_cohorts) / total_cohorts_in_scope if total_cohorts_in_scope > 0 else 0.0

                # D7 FIX: Use scoped cohorts for startersAtX (FE uses cohortsScoped)
                starters_at_x = sum(c.n for c in cohorts_scoped)
                rate_for_credibility = (p_block.get("forecast") or {}).get("mean") or p_block.get("mean", 0.0) or 0.0
                forecast_conversions = starters_at_x * rate_for_credibility
                effective_forecast_conversions = anchor_lag_coverage * forecast_conversions
                blend_weight = 1.0 - math.exp(-effective_forecast_conversions / ANCHOR_DELAY_BLEND_K_CONVERSIONS) if ANCHOR_DELAY_BLEND_K_CONVERSIONS > 0 else 1.0

                anchor_median_lag = blend_weight * observed_anchor + (1.0 - blend_weight) * prior_anchor

            # Compute edge latency stats (cohorts_for_fit for p∞ — FE parity)
            # D1 FIX: Window mode cohorts are not anchored at A, so do NOT apply
            # anchor travel-time adjustment (mirrors FE line 2516: !isWindowMode).
            latency_stats = compute_edge_latency_stats(
                cohorts_scoped,
                agg_median,
                agg_mean,
                DEFAULT_T95_DAYS,
                anchor_median_lag=anchor_median_lag,
                fit_total_k_override=total_k_weighted,
                p_infinity_cohorts_override=cohorts_for_fit,
                edge_t95=user_t95,
                recency_half_life_days=s.recency_half_life_days,
                onset_delta_days=onset,
                max_mean_median_ratio=s.max_mean_median_ratio,
                apply_anchor_age_adjustment=not is_window_mode,
                settings=s,
            )

            # Path t95: anchor+edge FW convolution if anchor data available
            edge_path_t95_val = path_t95_to_node + latency_stats.t95
            from_node_id = edge["from"]
            if anchor_cohorts:
                total_wn = sum(
                    c.n * _recency_weight(c.age, s.recency_half_life_days)
                    for c in anchor_cohorts
                )
                if total_wn > 0:
                    a_median = sum(
                        c.n * _recency_weight(c.age, s.recency_half_life_days) * c.anchor_median_lag_days
                        for c in anchor_cohorts
                    ) / total_wn
                    a_mean = sum(
                        c.n * _recency_weight(c.age, s.recency_half_life_days) * (c.anchor_mean_lag_days if c.anchor_mean_lag_days else c.anchor_median_lag_days)
                        for c in anchor_cohorts
                    ) / total_wn

                    anchor_fit_initial = fit_lag_distribution(a_median, a_mean, total_wn)

                    # D13 FIX: Apply upstream join-weighted t95 constraint to anchor fit
                    # (FE lines 2367-2379: improveFitWithT95 on anchor fit before FW composition)
                    inbound_to_from = incoming.get(from_node_id, [])
                    inbound_pairs = [
                        (edge_path_t95.get(_get_edge_id(ie), 0.0),
                         edge_flow_mass.get(_get_edge_id(ie), 0.0))
                        for ie in inbound_to_from
                    ]
                    inbound_pairs = [(v, w) for v, w in inbound_pairs if v > 0]
                    ax_topo_p95 = weighted_quantile(inbound_pairs, PATH_T95_PERCENTILE)
                    if ax_topo_p95 is not None and ax_topo_p95 > 0:
                        anchor_fit = improve_fit_with_t95(anchor_fit_initial, a_median, ax_topo_p95)
                    else:
                        anchor_fit = anchor_fit_initial

                    combined_t95 = fw_compose_percentile(anchor_fit, latency_stats.fit, PATH_T95_PERCENTILE)
                    if combined_t95 is not None and math.isfinite(combined_t95) and combined_t95 > 0:
                        combined_t95_t = combined_t95 + onset
                        edge_path_t95_val = max(latency_stats.t95, combined_t95_t)

            edge_path_t95[edge_id] = edge_path_t95_val

            # Path-level A→Y mu/sigma via FW
            path_mu: Optional[float] = None
            path_sigma: Optional[float] = None
            path_onset = (node_path_onset.get(node_id, 0.0)) + onset

            # Option (a): anchor data → A→Y FW composition
            if anchor_cohorts:
                total_n_a = sum(c.n for c in anchor_cohorts)
                upstream_onset = node_path_onset.get(node_id, 0.0)
                a_med_raw = sum(c.n * c.anchor_median_lag_days for c in anchor_cohorts) / (total_n_a or 1)
                a_mean_raw = sum(
                    c.n * (c.anchor_mean_lag_days if c.anchor_mean_lag_days else c.anchor_median_lag_days)
                    for c in anchor_cohorts
                ) / (total_n_a or 1)
                a_med = max(0.01, a_med_raw - upstream_onset)
                a_mean2 = max(a_med, a_mean_raw - upstream_onset)
                anchor_fit2 = fit_lag_distribution(a_med, a_mean2, total_n_a)
                ay_fit = fw_compose_pair(anchor_fit2, latency_stats.fit)
                if ay_fit is not None:
                    path_mu, path_sigma = ay_fit

            # Fallback (b): upstream path params + edge fit via FW
            if path_mu is None:
                up_mu = node_path_mu.get(node_id)
                up_sigma = node_path_sigma.get(node_id)
                if up_mu is not None and up_sigma is not None:
                    upstream_fit = LagDistributionFit(mu=up_mu, sigma=up_sigma, empirical_quality_ok=True, total_k=1)
                    combined = fw_compose_pair(upstream_fit, latency_stats.fit)
                    if combined is not None:
                        path_mu, path_sigma = combined

            # Fallback (c): pass-through
            if path_mu is None:
                path_mu = node_path_mu.get(node_id)
                path_sigma = node_path_sigma.get(node_id)

            # Path-level SDs: quadrature sum of edge SD + upstream path SD
            up_mu_sd = node_path_mu_sd.get(node_id, 0.0)
            up_sigma_sd = node_path_sigma_sd.get(node_id, 0.0)
            up_onset_sd = node_path_onset_sd.get(node_id, 0.0)
            path_mu_sd = math.sqrt(latency_stats.mu_sd ** 2 + up_mu_sd ** 2)
            path_sigma_sd = math.sqrt(latency_stats.sigma_sd ** 2 + up_sigma_sd ** 2)
            path_onset_sd = math.sqrt(latency_stats.onset_sd ** 2 + up_onset_sd ** 2)

            # Cohort-mode completeness: A→Y path-anchored
            completeness_used = latency_stats.completeness
            if path_mu is not None and path_sigma is not None:
                # D4 FIX: prefer promoted_path_t95 over path_t95
                auth_path_t95 = max(
                    edge_path_t95_val,
                    lat_block.get("promoted_path_t95", 0) or lat_block.get("path_t95", 0) or 0,
                )
                if auth_path_t95 > 0:
                    ay_median = math.exp(path_mu)
                    ay_cdf = get_completeness_cdf_params(
                        LagDistributionFit(mu=path_mu, sigma=path_sigma, empirical_quality_ok=True, total_k=total_k_weighted or 1),
                        ay_median,
                        auth_path_t95,
                        onset,
                    )
                    ay_completeness = calculate_completeness_with_tail_constraint(
                        cohorts_scoped, ay_cdf.mu, ay_cdf.sigma_moments, ay_cdf.sigma,
                        ay_cdf.tail_constraint_applied, onset,
                    )
                    if math.isfinite(ay_completeness):
                        completeness_used = ay_completeness

            # D2 FIX: Set up blend inputs (mirrors FE lines 2632-2653)
            # Default to edge-level CDF params for per-day blend.
            blend_cdf_mu = latency_stats.completeness_cdf.mu
            blend_cdf_sigma = latency_stats.completeness_cdf.sigma
            blend_cdf_sigma_moments = latency_stats.completeness_cdf.sigma_moments
            blend_tail_applied = latency_stats.completeness_cdf.tail_constraint_applied
            blend_onset = onset

            # If A→Y path completeness was computed, use path-level CDF params for blend.
            if completeness_used != latency_stats.completeness:
                # ay_cdf was set in the A→Y completeness block above
                try:
                    blend_cdf_mu = ay_cdf.mu  # type: ignore[possibly-undefined]
                    blend_cdf_sigma = ay_cdf.sigma
                    blend_cdf_sigma_moments = ay_cdf.sigma_moments
                    blend_tail_applied = ay_cdf.tail_constraint_applied
                except NameError:
                    pass  # keep edge-level defaults

            # Blend cohorts: anchor-adjusted in cohort mode (mirrors FE line 2640).
            # Window mode: use raw cohortsScoped (no anchor adjustment).
            if not is_window_mode and (anchor_median_lag > 0 or any(
                c.anchor_median_lag_days is not None and c.anchor_median_lag_days > 0
                for c in cohorts_scoped
            )):
                blend_cohorts = [
                    CohortData(
                        date=c.date, age=max(0.0, c.age - (c.anchor_median_lag_days if c.anchor_median_lag_days is not None else anchor_median_lag)),
                        n=c.n, k=c.k, median_lag_days=c.median_lag_days, mean_lag_days=c.mean_lag_days,
                        anchor_median_lag_days=c.anchor_median_lag_days, anchor_mean_lag_days=c.anchor_mean_lag_days,
                    )
                    for c in cohorts_scoped
                ]
            else:
                blend_cohorts = cohorts_scoped

            # ── Forecast mean resolution (D4 FIX: window-derived forecast) ──
            base_forecast_mean = (p_block.get("forecast") or {}).get("mean")
            window_derived_forecast = None
            if base_forecast_mean is None and ctx and ctx.window_cohorts:
                window_derived_forecast = estimate_p_infinity(
                    ctx.window_cohorts, effective_horizon, s.recency_half_life_days,
                )
            fallback_forecast = latency_stats.p_infinity if latency_stats.forecast_available else None
            forecast_mean = base_forecast_mean if base_forecast_mean is not None else (
                window_derived_forecast if window_derived_forecast is not None else fallback_forecast
            )

            # ── Evidence and nBaseline (D6 FIX: prefer window-slice n) ──
            evidence_block = p_block.get("evidence") or {}
            evidence_n_raw = evidence_block.get("n", 0) or 0
            evidence_k_raw = evidence_block.get("k", 0) or 0
            evidence_mean_observed = (evidence_k_raw / evidence_n_raw) if evidence_n_raw > 0 else evidence_block.get("mean")

            # D7 FIX: nQuery uses scoped cohorts (FE uses cohortsScoped)
            n_query = p_block.get("n") or evidence_n_raw or sum(c.n for c in cohorts_scoped)
            # D10 FIX: maturity threshold uses effective_horizon (input t95), not fitted t95
            if ctx and ctx.n_baseline_from_window is not None and ctx.n_baseline_from_window > 0:
                n_baseline = ctx.n_baseline_from_window
            else:
                mature_n = sum(c.n for c in cohorts_scoped if c.age >= effective_horizon)
                n_baseline = mature_n if mature_n > 0 else n_query

            # ── Bayesian evidence adjustment (D5 FIX: FE lines 2790-2862) ──
            evidence_mean_for_blend = evidence_mean_observed
            is_cohort_path_anchored = (completeness_used != latency_stats.completeness)  # A→Y was computed
            if (is_cohort_path_anchored
                    and isinstance(evidence_n_raw, (int, float)) and evidence_n_raw > 0
                    and isinstance(evidence_k_raw, (int, float)) and evidence_k_raw >= 0
                    and isinstance(completeness_used, (int, float)) and completeness_used > 0
                    and forecast_mean is not None and math.isfinite(forecast_mean)):
                n_obs = max(0, evidence_n_raw)
                k_obs = max(0, evidence_k_raw)
                c_raw = max(LATENCY_EPSILON, min(1.0, completeness_used))
                c_eff = max(LATENCY_EPSILON, min(1.0, c_raw ** 0.7))
                n_eff_raw = n_obs * c_eff
                n_eff = max(n_eff_raw, k_obs)
                p0 = max(0.0, min(1.0, forecast_mean))
                prior_s = LATENCY_MIN_EFFECTIVE_SAMPLE_SIZE / c_raw
                alpha = p0 * prior_s
                beta_val = (1.0 - p0) * prior_s
                evidence_mean_for_blend = max(0.0, min(1.0, (k_obs + alpha) / (n_eff + alpha + beta_val)))

            # R1/R2 FIX: Detect sampled cohorts (edge evidence.n ≥ 2× cohort sum)
            # and substitute edge evidence n for nQuery in the blend (FE lines 2971-2988).
            sum_cohort_n = sum(c.n for c in cohorts_scoped)
            edge_evidence_n = evidence_n_raw
            cohorts_look_sampled = (
                isinstance(edge_evidence_n, (int, float)) and edge_evidence_n > 0
                and sum_cohort_n > 0
                and edge_evidence_n >= sum_cohort_n * 2
            )
            n_query_for_blend = int(edge_evidence_n) if cohorts_look_sampled else n_query

            # D12 FIX: FE passes forecastMean ?? 0 (zero fallback), not None
            forecast_mean_for_blend = forecast_mean if forecast_mean is not None else 0.0
            # D7 FIX: nBaseline fallback to nQueryForBlend (FE: nBaseline > 0 ? nBaseline : nQueryForBlend)
            n_baseline_for_blend = n_baseline if n_baseline > 0 else n_query_for_blend

            # D2 FIX: Try per-day blend first (preferred — correct for mixed-maturity sweeps).
            # Falls back to aggregate blend when cohorts look sampled or are empty.
            # Mirrors FE lines 3226-3246 in statisticalEnhancementService.ts.
            per_day_result = None
            if not cohorts_look_sampled and len(blend_cohorts) > 0:
                per_day_result = compute_per_day_blended_mean(
                    cohorts=blend_cohorts,
                    forecast_mean=forecast_mean_for_blend,
                    n_baseline=max(n_baseline_for_blend, 1),
                    cdf_mu=blend_cdf_mu,
                    cdf_sigma=blend_cdf_sigma,
                    onset_delta_days=blend_onset,
                    cdf_sigma_moments=blend_cdf_sigma_moments,
                    tail_constraint_applied=blend_tail_applied,
                    forecast_blend_lambda=s.forecast_blend_lambda,
                    blend_completeness_power=s.blend_completeness_power,
                )

            blended_from_blend = (
                per_day_result[0] if per_day_result is not None
                else compute_blended_mean(
                    evidence_mean=evidence_mean_for_blend,
                    forecast_mean=forecast_mean_for_blend,
                    completeness=completeness_used,
                    n_query=n_query_for_blend,
                    n_baseline=max(n_baseline_for_blend, 1),
                    forecast_blend_lambda=s.forecast_blend_lambda,
                    blend_completeness_power=s.blend_completeness_power,
                )
            )

            # D11 FIX: FE falls back to raw evidence mean (edge.p.evidence.mean), not computed k/n
            evidence_mean_raw = evidence_block.get("mean")
            blended = blended_from_blend if blended_from_blend is not None else evidence_mean_raw

            # D9 FIX: Update DP state for target node — deterministic tie-breaking.
            # Use strict > plus secondary sort by edge_id for equal horizons.
            current_t95 = node_path_t95.get(to_node, 0.0)
            _dominant_edge = node_dominant_edge.get(to_node)
            if (edge_path_t95_val > current_t95
                    or (edge_path_t95_val == current_t95 and (_dominant_edge is None or edge_id < _dominant_edge))):
                node_path_t95[to_node] = edge_path_t95_val
                node_dominant_edge[to_node] = edge_id
                node_path_mu[to_node] = path_mu if has_latency else (path_mu or node_path_mu.get(node_id))
                node_path_sigma[to_node] = path_sigma if has_latency else (path_sigma or node_path_sigma.get(node_id))
                node_path_onset[to_node] = max(node_path_onset.get(to_node, 0.0), path_onset)
                node_path_mu_sd[to_node] = path_mu_sd
                node_path_sigma_sd[to_node] = path_sigma_sd
                node_path_onset_sd[to_node] = path_onset_sd

            # R3 FIX: Median lag prior propagation — prefer window-slice baseline
            # (FE lines 3071-3090: uses windowAggregateFn for the prior, not agg_median)
            edge_baseline_median_lag = agg_median or 0.0
            if ctx and ctx.window_cohorts:
                # Derive median lag from window cohorts (same as FE windowLagStatsForPrior)
                w_med_num = 0.0
                w_med_den = 0.0
                for wc in ctx.window_cohorts:
                    if wc.k <= 0 or wc.median_lag_days is None or wc.median_lag_days <= 0:
                        continue
                    wt = _recency_weight(wc.age, s.recency_half_life_days) * wc.k
                    w_med_num += wc.median_lag_days * wt
                    w_med_den += wt
                if w_med_den > 0:
                    edge_baseline_median_lag = w_med_num / w_med_den

            from_node_id_for_prior = edge["from"]
            if edge_baseline_median_lag > 0:
                current_prior = node_median_lag_prior.get(from_node_id_for_prior, 0.0)
                new_prior = current_prior + edge_baseline_median_lag
                node_median_lag_prior[to_node] = max(node_median_lag_prior.get(to_node, 0.0), new_prior)

            result.edges_with_lag += 1
            result.edge_values.append(EdgeLAGValues(
                edge_uuid=edge_id,
                t95=round(latency_stats.t95, 2),
                path_t95=round(edge_path_t95_val, 2),
                completeness=round(completeness_used, 4),
                mu=round(latency_stats.completeness_cdf.mu, 4),
                sigma=round(latency_stats.completeness_cdf.sigma, 4),
                onset_delta_days=round(onset, 2),
                median_lag_days=round(agg_median, 4) if agg_median else None,
                mean_lag_days=round(agg_mean, 4) if agg_mean else None,
                path_mu=round(path_mu, 4) if path_mu is not None else None,
                path_sigma=round(path_sigma, 4) if path_sigma is not None else None,
                path_onset_delta_days=round(path_onset, 2),
                p_infinity=round(forecast_mean, 6) if forecast_mean is not None else None,
                p_evidence=round(latency_stats.p_evidence, 6),
                forecast_available=latency_stats.forecast_available,
                blended_mean=round(blended, 6) if blended is not None else None,
                # Heuristic dispersion
                p_sd=round(latency_stats.p_sd, 6),
                mu_sd=round(latency_stats.mu_sd, 6),
                sigma_sd=round(latency_stats.sigma_sd, 6),
                onset_sd=round(latency_stats.onset_sd, 4),
                onset_mu_corr=round(latency_stats.onset_mu_corr, 4),
                path_mu_sd=round(path_mu_sd, 6),
                path_sigma_sd=round(path_sigma_sd, 6),
                path_onset_sd=round(path_onset_sd, 4),
            ))

            # R4 FIX: Process conditional_p probabilities (FE lines 3102-3210)
            # Conditional probabilities share the same physical edge (same path_t95,
            # anchor, path onset) but have their own parameter values and LAG stats.
            conditional_ps = edge.get("conditional_p") or []
            for cp_idx, cp in enumerate(conditional_ps):
                cp_p = cp.get("p") or {} if isinstance(cp, dict) else {}
                cp_lat = cp_p.get("latency") or {}
                if not cp_lat.get("latency_parameter"):
                    continue

                cp_key = f"{edge_id}:conditional[{cp_idx}]"
                cp_cohorts = param_lookup.get(cp_key, [])
                if not cp_cohorts:
                    continue

                cp_ctx = (edge_contexts or {}).get(cp_key)
                cp_cohorts_scoped = (cp_ctx.scoped_cohorts if cp_ctx and cp_ctx.scoped_cohorts else cp_cohorts)

                # Aggregate lag stats (from all cohorts, like FE cpCohortsAll)
                cp_agg_median, cp_agg_mean, _ = _aggregate_lag_stats(cp_cohorts, s.recency_half_life_days)
                if cp_agg_median is None:
                    cp_agg_median = effective_horizon / 2.0

                # Onset from context or graph
                cp_onset = 0.0
                if cp_ctx and cp_ctx.onset_from_window_slices is not None and math.isfinite(cp_ctx.onset_from_window_slices):
                    cp_onset = cp_ctx.onset_from_window_slices
                else:
                    cp_onset_val = cp_lat.get("onset_delta_days", 0.0)
                    if isinstance(cp_onset_val, (int, float)) and math.isfinite(cp_onset_val):
                        cp_onset = cp_onset_val

                cp_edge_t95 = cp_lat.get("t95")
                if not (isinstance(cp_edge_t95, (int, float)) and math.isfinite(cp_edge_t95) and cp_edge_t95 > 0):
                    cp_edge_t95 = None

                cp_stats = compute_edge_latency_stats(
                    cp_cohorts_scoped,
                    cp_agg_median,
                    cp_agg_mean,
                    DEFAULT_T95_DAYS,
                    anchor_median_lag=anchor_median_lag,
                    p_infinity_cohorts_override=cp_cohorts,
                    edge_t95=cp_edge_t95,
                    recency_half_life_days=s.recency_half_life_days,
                    onset_delta_days=cp_onset,
                    max_mean_median_ratio=s.max_mean_median_ratio,
                    apply_anchor_age_adjustment=True,
                    settings=s,
                )

                result.edges_with_lag += 1
                result.edge_values.append(EdgeLAGValues(
                    edge_uuid=edge_id,
                    conditional_index=cp_idx,
                    t95=round(cp_stats.t95, 2),
                    path_t95=round(edge_path_t95_val, 2),  # shared with base edge
                    completeness=round(cp_stats.completeness, 4),
                    mu=round(cp_stats.completeness_cdf.mu, 4),
                    sigma=round(cp_stats.completeness_cdf.sigma, 4),
                    onset_delta_days=round(cp_onset, 2),
                    median_lag_days=round(cp_agg_median, 4) if cp_agg_median else None,
                    mean_lag_days=round(cp_agg_mean, 4) if cp_agg_mean else None,
                    path_onset_delta_days=round(path_onset, 2),  # shared with base edge
                    p_infinity=round(cp_stats.p_infinity, 6) if cp_stats.forecast_available else None,
                    p_evidence=round(cp_stats.p_evidence, 6),
                    forecast_available=cp_stats.forecast_available,
                ))

            _decrement_and_enqueue(to_node, in_degree, queue)

    return result


# ─────────────────────────────────────────────────────────────
# Topo pass helpers
# ─────────────────────────────────────────────────────────────

def _propagate_path_state(
    edge_id: str, from_node: str, to_node: str,
    node_path_mu: Dict, node_path_sigma: Dict, node_path_onset: Dict,
    edge_path_t95: Dict, node_path_t95: Dict, t95_val: float,
    node_dominant_edge: Optional[Dict[str, str]] = None,
    node_path_mu_sd: Optional[Dict[str, float]] = None,
    node_path_sigma_sd: Optional[Dict[str, float]] = None,
    node_path_onset_sd: Optional[Dict[str, float]] = None,
) -> None:
    """Propagate path DP state through a skipped/no-data edge."""
    edge_path_t95[edge_id] = t95_val
    # D9 FIX: deterministic tie-breaking (same as main DP update)
    current = node_path_t95.get(to_node, 0.0)
    _dom = node_dominant_edge.get(to_node) if node_dominant_edge else None
    if (t95_val > current or (t95_val == current and (_dom is None or edge_id < _dom))):
        node_path_t95[to_node] = t95_val
        if node_dominant_edge is not None:
            node_dominant_edge[to_node] = edge_id
        node_path_mu[to_node] = node_path_mu.get(from_node)
        node_path_sigma[to_node] = node_path_sigma.get(from_node)
        node_path_onset[to_node] = max(
            node_path_onset.get(to_node, 0.0),
            node_path_onset.get(from_node, 0.0),
        )
        if node_path_mu_sd is not None:
            node_path_mu_sd[to_node] = node_path_mu_sd.get(from_node, 0.0)
        if node_path_sigma_sd is not None:
            node_path_sigma_sd[to_node] = node_path_sigma_sd.get(from_node, 0.0)
        if node_path_onset_sd is not None:
            node_path_onset_sd[to_node] = node_path_onset_sd.get(from_node, 0.0)


def _decrement_and_enqueue(
    to_node: str,
    in_degree: Dict[str, int],
    queue: List[str],
) -> None:
    """Decrement in-degree and enqueue if zero."""
    new_deg = in_degree.get(to_node, 1) - 1
    in_degree[to_node] = new_deg
    if new_deg <= 0 and to_node not in queue:
        queue.append(to_node)


def _aggregate_lag_stats(
    cohorts: List[CohortData],
    recency_half_life_days: float,
) -> Tuple[Optional[float], Optional[float], float]:
    """Aggregate median/mean lag from cohort data with recency weighting.

    Returns (median, mean, total_k_weighted).
    """
    w_median_num = 0.0
    w_median_den = 0.0
    w_mean_num = 0.0
    w_mean_den = 0.0
    total_k_w = 0.0

    for c in cohorts:
        if c.k <= 0:
            continue
        w = _recency_weight(c.age, recency_half_life_days) * c.k
        if c.median_lag_days is not None and c.median_lag_days > 0:
            w_median_num += c.median_lag_days * w
            w_median_den += w
        effective_mean = (
            c.mean_lag_days if (c.mean_lag_days is not None and c.mean_lag_days > 0)
            else (c.median_lag_days if (c.median_lag_days is not None and c.median_lag_days > 0) else None)
        )
        if effective_mean is not None:
            w_mean_num += effective_mean * w
            w_mean_den += w
        total_k_w += c.k * _recency_weight(c.age, recency_half_life_days)

    median = (w_median_num / w_median_den) if w_median_den > 0 else None
    mean = (w_mean_num / w_mean_den) if w_mean_den > 0 else None
    return median, mean, total_k_w
