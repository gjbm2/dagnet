"""
Confidence bands for shifted-lognormal CDF model curves.

Computes pointwise uncertainty bands around rate(t) = p × CDF(t; onset, μ, σ)
using the multivariate delta method with full covariance structure.

The four parameters (p, μ, σ, onset) may be correlated — particularly onset
and μ, which trade off on short-onset edges (corr ≈ -0.9). Ignoring this
covariance overestimates the band width because the opposing movements
partially cancel.

Usage:
    from runner.confidence_bands import compute_confidence_band

    upper, lower = compute_confidence_band(
        ages=range(0, 100),
        p=0.83, mu=-0.35, sigma=2.98, onset=16.8,
        p_sd=0.033, mu_sd=0.146, sigma_sd=0.048, onset_sd=0.22,
        onset_mu_corr=-0.88,
        level=0.90,
    )
"""
from __future__ import annotations

import math
from typing import Sequence

# Standard normal PDF constant
_SQRT_2PI = math.sqrt(2.0 * math.pi)

# z-multipliers for common confidence levels
_LEVEL_Z = {
    0.80: 1.282,
    0.90: 1.645,
    0.95: 1.960,
    0.99: 2.576,
}


def _shifted_lognormal_cdf(t: float, onset: float, mu: float, sigma: float) -> float:
    """Shifted lognormal CDF: P(delay ≤ t) where delay = onset + LN(μ, σ)."""
    age = t - onset
    if age <= 0 or sigma <= 0:
        return 0.0
    z = (math.log(age) - mu) / sigma
    return 0.5 * math.erfc(-z / math.sqrt(2.0))


def compute_confidence_band(
    ages: Sequence[float],
    p: float,
    mu: float,
    sigma: float,
    onset: float,
    p_sd: float = 0.0,
    mu_sd: float = 0.0,
    sigma_sd: float = 0.0,
    onset_sd: float = 0.0,
    onset_mu_corr: float = 0.0,
    level: float = 0.90,
) -> tuple[list[float], list[float]]:
    """Compute upper and lower confidence bands for rate(t) = p × CDF(t).

    Uses the multivariate delta method:
        Var(rate) = J × Σ × Jᵀ
    where J is the Jacobian [∂rate/∂p, ∂rate/∂μ, ∂rate/∂σ, ∂rate/∂onset]
    and Σ is the 4×4 covariance matrix.

    Currently models one off-diagonal covariance: Cov(onset, μ) from the
    supplied correlation. Other cross-terms (e.g. μ-σ) are assumed zero.
    Additional correlations can be added when posterior data provides them.

    Args:
        ages: sequence of age values (days) at which to evaluate.
        p, mu, sigma, onset: model parameters.
        p_sd, mu_sd, sigma_sd, onset_sd: posterior standard deviations.
        onset_mu_corr: correlation between onset and mu posteriors.
        level: confidence level (0.80, 0.90, 0.95, 0.99).

    Returns:
        (upper, lower): lists of rate values at each age.
    """
    k = _LEVEL_Z.get(level, 1.645)

    upper: list[float] = []
    lower: list[float] = []

    for t in ages:
        cdf = _shifted_lognormal_cdf(float(t), onset, mu, sigma)
        rate = p * cdf

        age = float(t) - onset

        if age > 0 and sigma > 0:
            z = (math.log(age) - mu) / sigma
            phi = math.exp(-0.5 * z * z) / _SQRT_2PI

            # Partial derivatives of CDF w.r.t. each parameter
            dcdf_dmu = -phi / sigma
            dcdf_dsigma = -phi * z / sigma
            dcdf_donset = -phi / (sigma * age)

            # Jacobian: ∂rate/∂θ for each parameter
            dr_dp = cdf
            dr_dmu = p * dcdf_dmu
            dr_dsigma = p * dcdf_dsigma
            dr_donset = p * dcdf_donset

            # Diagonal variance terms
            var_rate = 0.0
            if p_sd > 0:
                var_rate += dr_dp ** 2 * p_sd ** 2
            if mu_sd > 0:
                var_rate += dr_dmu ** 2 * mu_sd ** 2
            if sigma_sd > 0:
                var_rate += dr_dsigma ** 2 * sigma_sd ** 2
            if onset_sd > 0:
                var_rate += dr_donset ** 2 * onset_sd ** 2

            # Off-diagonal: Cov(onset, mu) = corr × onset_sd × mu_sd
            if onset_mu_corr != 0.0 and onset_sd > 0 and mu_sd > 0:
                cov_onset_mu = onset_mu_corr * onset_sd * mu_sd
                var_rate += 2.0 * dr_donset * dr_dmu * cov_onset_mu

            # Guard against numerical noise producing negative variance
            var_rate = max(var_rate, 0.0)
            sd_rate = math.sqrt(var_rate)
            upper.append(min(1.0, rate + k * sd_rate))
            lower.append(max(0.0, rate - k * sd_rate))
        else:
            # Before onset or degenerate sigma: only p uncertainty
            if p_sd > 0 and cdf > 0:
                sd_rate = cdf * p_sd
                upper.append(min(1.0, rate + k * sd_rate))
                lower.append(max(0.0, rate - k * sd_rate))
            else:
                upper.append(rate)
                lower.append(rate)

    return upper, lower
