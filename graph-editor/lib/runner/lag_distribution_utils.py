"""
Lag distribution utilities (pure maths).

Single source of truth for lognormal fitting and quantiles on the Python backend.
Intentionally free of service dependencies (no DB, no file reads, no imports outside stdlib).

Port of: graph-editor/src/services/lagDistributionUtils.ts
Behaviour locked by: lib/tests/test_lag_distribution_parity.py (golden fixture)

The algorithms (erf approximation, Acklam inverse normal, moment-based lognormal fitting)
are identical to the TypeScript implementation. Numerical parity is verified by cross-
language golden tests consuming the same fixture values.
"""

import math
from dataclasses import dataclass, field
from typing import Optional

# ─────────────────────────────────────────────────────────────
# Default constants (match graph-editor/src/constants/latency.ts)
# These are documentation/test defaults; at runtime the frontend
# sends authoritative values via forecasting_settings in the API
# request (see analysis-forecasting.md §4.5).
# ─────────────────────────────────────────────────────────────

LATENCY_DEFAULT_SIGMA = 0.5
LATENCY_MIN_FIT_CONVERTERS = 30
LATENCY_MIN_MEAN_MEDIAN_RATIO = 0.9
LATENCY_MAX_MEAN_MEDIAN_RATIO = 999999

# Small positive clamp for model-space lag values (prevent degenerate log ops).
ONSET_EPSILON_DAYS = 1e-6


# ─────────────────────────────────────────────────────────────
# Fitted model result
# ─────────────────────────────────────────────────────────────

@dataclass
class LagDistributionFit:
    """Fitted log-normal distribution parameters."""
    mu: float
    sigma: float
    empirical_quality_ok: bool
    total_k: float
    quality_failure_reason: Optional[str] = None


# ─────────────────────────────────────────────────────────────
# Error function
# ─────────────────────────────────────────────────────────────

def erf(x: float) -> float:
    """
    Error function approximation (Abramowitz & Stegun 1964, Horner form).
    Maximum error: 1.5e-7.
    """
    a1 = 0.254829592
    a2 = -0.284496736
    a3 = 1.421413741
    a4 = -1.453152027
    a5 = 1.061405429
    p = 0.3275911

    sign = -1.0 if x < 0 else 1.0
    x = abs(x)

    t = 1.0 / (1.0 + p * x)
    y = 1.0 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * math.exp(-x * x)

    return sign * y


# ─────────────────────────────────────────────────────────────
# Standard normal CDF and inverse
# ─────────────────────────────────────────────────────────────

def standard_normal_cdf(x: float) -> float:
    """Standard normal CDF: Φ(x) = 0.5 * (1 + erf(x / sqrt(2)))."""
    return 0.5 * (1.0 + erf(x / math.sqrt(2.0)))


def standard_normal_inverse_cdf(p: float) -> float:
    """
    Inverse standard normal CDF (Φ⁻¹) using the Acklam approximation.
    High accuracy across the full (0, 1) range.
    """
    if p <= 0:
        return float('-inf')
    if p >= 1:
        return float('inf')
    if p == 0.5:
        return 0.0

    a = [
        -3.969683028665376e1,
        2.209460984245205e2,
        -2.759285104469687e2,
        1.38357751867269e2,
        -3.066479806614716e1,
        2.506628277459239e0,
    ]
    b = [
        -5.447609879822406e1,
        1.615858368580409e2,
        -1.556989798598866e2,
        6.680131188771972e1,
        -1.328068155288572e1,
    ]
    c = [
        -7.784894002430293e-3,
        -3.223964580411365e-1,
        -2.400758277161838e0,
        -2.549732539343734e0,
        4.374664141464968e0,
        2.938163982698783e0,
    ]
    d = [
        7.784695709041462e-3,
        3.224671290700398e-1,
        2.445134137142996e0,
        3.754408661907416e0,
    ]

    p_low = 0.02425
    p_high = 1.0 - p_low

    if p < p_low:
        q = math.sqrt(-2.0 * math.log(p))
        return (
            (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
            / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0)
        )
    elif p <= p_high:
        q = p - 0.5
        r = q * q
        return (
            (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
            / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1.0)
        )
    else:
        q = math.sqrt(-2.0 * math.log(1.0 - p))
        return -(
            (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
            / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0)
        )


# ─────────────────────────────────────────────────────────────
# Log-normal CDF, survival, inverse CDF
# ─────────────────────────────────────────────────────────────

def log_normal_cdf(t: float, mu: float, sigma: float) -> float:
    """Log-normal CDF: F(t) = Φ((ln(t) - μ) / σ)."""
    if t <= 0:
        return 0.0
    if sigma <= 0:
        return 1.0 if t >= math.exp(mu) else 0.0
    return standard_normal_cdf((math.log(t) - mu) / sigma)


def log_normal_survival(t: float, mu: float, sigma: float) -> float:
    """Log-normal survival function: S(t) = 1 - F(t)."""
    return 1.0 - log_normal_cdf(t, mu, sigma)


def log_normal_inverse_cdf(p: float, mu: float, sigma: float) -> float:
    """Log-normal inverse CDF (quantile): returns t such that F(t) = p."""
    if p <= 0:
        return 0.0
    if p >= 1:
        return float('inf')
    return math.exp(mu + sigma * standard_normal_inverse_cdf(p))


# ─────────────────────────────────────────────────────────────
# Log-normal fitting from median/mean lag data
# ─────────────────────────────────────────────────────────────

def fit_lag_distribution(
    median_lag: float,
    mean_lag: Optional[float],
    total_k: float,
    *,
    min_fit_converters: float = LATENCY_MIN_FIT_CONVERTERS,
    default_sigma: float = LATENCY_DEFAULT_SIGMA,
    min_mean_median_ratio: float = LATENCY_MIN_MEAN_MEDIAN_RATIO,
    max_mean_median_ratio: float = LATENCY_MAX_MEAN_MEDIAN_RATIO,
) -> LagDistributionFit:
    """
    Fit log-normal distribution from median and mean lag data.

    Formula: μ = ln(median), σ = sqrt(2 * ln(mean/median)).

    Quality gates and settings are keyword arguments so the frontend can pass
    them via forecasting_settings (see analysis-forecasting.md §4.5).
    """
    if not math.isfinite(median_lag):
        return LagDistributionFit(
            mu=0.0,
            sigma=default_sigma,
            empirical_quality_ok=False,
            total_k=total_k,
            quality_failure_reason=f"Invalid median lag (non-finite): {median_lag}",
        )

    if total_k < min_fit_converters:
        return LagDistributionFit(
            mu=math.log(median_lag) if median_lag > 0 else 0.0,
            sigma=default_sigma,
            empirical_quality_ok=False,
            total_k=total_k,
            quality_failure_reason=f"Insufficient converters: {total_k} < {min_fit_converters}",
        )

    if median_lag <= 0:
        return LagDistributionFit(
            mu=0.0,
            sigma=default_sigma,
            empirical_quality_ok=False,
            total_k=total_k,
            quality_failure_reason=f"Invalid median lag: {median_lag}",
        )

    mu = math.log(median_lag)

    if mean_lag is None or mean_lag <= 0:
        return LagDistributionFit(
            mu=mu,
            sigma=default_sigma,
            empirical_quality_ok=True,
            total_k=total_k,
            quality_failure_reason="Mean lag not available, using default σ",
        )

    ratio = mean_lag / median_lag

    if ratio < 1.0:
        is_close_to_one = ratio >= min_mean_median_ratio
        return LagDistributionFit(
            mu=mu,
            sigma=default_sigma,
            empirical_quality_ok=is_close_to_one,
            total_k=total_k,
            quality_failure_reason=(
                f"Mean/median ratio {ratio:.3f} < 1.0 (using default σ)"
                if is_close_to_one
                else f"Mean/median ratio too low: {ratio:.3f} < {min_mean_median_ratio}"
            ),
        )

    if ratio > max_mean_median_ratio:
        return LagDistributionFit(
            mu=mu,
            sigma=default_sigma,
            empirical_quality_ok=False,
            total_k=total_k,
            quality_failure_reason=f"Mean/median ratio too high: {ratio:.3f} > {max_mean_median_ratio}",
        )

    sigma = math.sqrt(2.0 * math.log(ratio))
    if not math.isfinite(sigma) or sigma < 0:
        return LagDistributionFit(
            mu=mu,
            sigma=default_sigma,
            empirical_quality_ok=False,
            total_k=total_k,
            quality_failure_reason=f"Invalid sigma computed from ratio {ratio:.3f}",
        )

    return LagDistributionFit(
        mu=mu,
        sigma=sigma,
        empirical_quality_ok=True,
        total_k=total_k,
    )


# ─────────────────────────────────────────────────────────────
# Onset conversion helper (user-space ↔ model-space)
# ─────────────────────────────────────────────────────────────

@dataclass
class ToModelSpaceResult:
    onset_delta_days: float
    median_x_days: float
    mean_x_days: Optional[float] = None
    t95_x_days: Optional[float] = None
    age_x_days: Optional[float] = None


def _normalise_onset_delta_days(onset_delta_days: Optional[float]) -> float:
    if onset_delta_days is None or not math.isfinite(onset_delta_days):
        return 0.0
    return max(0.0, onset_delta_days)


def _clamp_positive_days(value_days: float) -> float:
    if not math.isfinite(value_days):
        return ONSET_EPSILON_DAYS
    return value_days if value_days > ONSET_EPSILON_DAYS else ONSET_EPSILON_DAYS


def to_model_space_lag_days(onset_delta_days: Optional[float], value_t_days: float) -> float:
    """Convert user-space lag (T) to model-space (X). Clamped to small positive epsilon."""
    delta = _normalise_onset_delta_days(onset_delta_days)
    return _clamp_positive_days(value_t_days - delta)


def to_model_space_age_days(onset_delta_days: Optional[float], age_t_days: float) -> float:
    """Convert user-space cohort age to model-space age. Clamped at 0 (dead-time)."""
    delta = _normalise_onset_delta_days(onset_delta_days)
    if not math.isfinite(age_t_days):
        return 0.0
    return max(0.0, age_t_days - delta)


def to_model_space(
    onset_delta_days: Optional[float],
    median_t_days: float,
    mean_t_days: Optional[float] = None,
    t95_t_days: Optional[float] = None,
    age_t_days: Optional[float] = None,
) -> ToModelSpaceResult:
    """
    Convert user-space (T-space) latency values into model-space (X-space).

    T = δ + X where δ = onset_delta_days (dead-time).
    Lag values are clamped to a small positive epsilon; age is clamped at 0.
    """
    delta = _normalise_onset_delta_days(onset_delta_days)

    return ToModelSpaceResult(
        onset_delta_days=delta,
        median_x_days=to_model_space_lag_days(delta, median_t_days),
        mean_x_days=to_model_space_lag_days(delta, mean_t_days) if mean_t_days is not None else None,
        t95_x_days=to_model_space_lag_days(delta, t95_t_days) if t95_t_days is not None else None,
        age_x_days=to_model_space_age_days(delta, age_t_days) if age_t_days is not None else None,
    )
