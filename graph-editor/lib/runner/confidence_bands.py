"""
Confidence bands for shifted-lognormal CDF model curves.

Two band types:

1. **Unconditional** (model overlay): Monte Carlo over posterior samples.
   Draws θ ~ MVN(posterior_mean, Σ), computes rate(τ) = p × CDF(τ; θ),
   extracts quantiles.

2. **Conditional** (fan chart): Same Monte Carlo approach, but each draw's
   forecast is conditioned on observed evidence per Cohort.  Implemented
   in cohort_forecast.py, not here.

The Monte Carlo approach replaces the delta method, which breaks down
near the onset where rate(τ) is highly nonlinear w.r.t. θ.
"""
from __future__ import annotations

import math
from typing import Sequence

import numpy as np


def _ndtr(z):
    """Normal CDF, vectorised. Drop-in replacement for scipy.special.ndtr.

    Uses the Abramowitz & Stegun 5-term erf approximation (7.1.28),
    max |error| < 7e-8 vs scipy.  ~30ms for a 2000×365 array on CPython.
    """
    x = z / np.sqrt(2.0)
    a1, a2, a3, a4, a5 = (0.254829592, -0.284496736, 1.421413741,
                           -1.453152027, 1.061405429)
    p = 0.3275911
    x_abs = np.abs(x)
    t = 1.0 / (1.0 + p * x_abs)
    erf_approx = 1.0 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1) * t * np.exp(-x_abs**2)
    return 0.5 * (1.0 + np.sign(x) * erf_approx)

# z-multipliers for common confidence levels
_LEVEL_Z = {
    0.80: 1.282,
    0.90: 1.645,
    0.95: 1.960,
    0.99: 2.576,
}

MC_SAMPLES = 2000


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

    Uses Monte Carlo: draws θ from the posterior approximation (MVN),
    computes rate(τ) for each draw, extracts quantiles.  This correctly
    handles nonlinearity near the onset and naturally respects [0, 1].

    Args:
        ages: sequence of age values (days) at which to evaluate.
        p, mu, sigma, onset: model parameters (posterior means).
        p_sd, mu_sd, sigma_sd, onset_sd: posterior standard deviations.
        onset_mu_corr: correlation between onset and mu posteriors.
        level: confidence level (0.80, 0.90, 0.95, 0.99).

    Returns:
        (upper, lower): lists of rate values at each age, within [0, 1].
    """
    ages_arr = np.asarray(ages, dtype=float)
    T = len(ages_arr)

    # If no uncertainty, return the point estimate
    if p_sd <= 0 and mu_sd <= 0 and sigma_sd <= 0 and onset_sd <= 0:
        rates = []
        for t in ages:
            cdf = _shifted_lognormal_cdf(float(t), onset, mu, sigma)
            rates.append(max(0.0, min(1.0, p * cdf)))
        return rates[:], rates[:]

    # Build posterior covariance: [p, mu, sigma, onset]
    sds = np.array([p_sd, mu_sd, sigma_sd, onset_sd])
    cov = np.diag(sds ** 2)
    cov[3, 1] = cov[1, 3] = onset_mu_corr * onset_sd * mu_sd

    theta_mean = np.array([p, mu, sigma, onset])
    rng = np.random.default_rng(42)
    samples = rng.multivariate_normal(theta_mean, cov, size=MC_SAMPLES)

    # Clip to valid ranges
    samples[:, 0] = np.clip(samples[:, 0], 1e-6, 1 - 1e-6)  # p
    samples[:, 2] = np.clip(samples[:, 2], 0.01, 20.0)       # sigma > 0

    # Compute rate(τ) = p × CDF(τ; onset, mu, sigma) for each draw
    # Shape: (S, T)
    p_s = samples[:, 0][:, None]       # (S, 1)
    mu_s = samples[:, 1][:, None]      # (S, 1)
    sigma_s = samples[:, 2][:, None]   # (S, 1)
    onset_s = samples[:, 3][:, None]   # (S, 1)

    t_shifted = ages_arr[None, :] - onset_s  # (S, T)
    t_shifted = np.maximum(t_shifted, 1e-12)
    z = (np.log(t_shifted) - mu_s) / sigma_s  # (S, T)
    cdf_arr = _ndtr(z)
    # Zero out pre-onset
    cdf_arr = np.where(ages_arr[None, :] > onset_s, cdf_arr, 0.0)
    rate_arr = p_s * cdf_arr
    rate_arr = np.clip(rate_arr, 0.0, 1.0)

    # Extract quantiles
    alpha = (1.0 - level) / 2.0  # e.g. 0.05 for 90%
    lo_pct = alpha * 100
    hi_pct = (1.0 - alpha) * 100

    lower = np.percentile(rate_arr, lo_pct, axis=0).tolist()
    upper = np.percentile(rate_arr, hi_pct, axis=0).tolist()

    return upper, lower
