"""
Forecast application — completeness evaluation.

Pure functions: given fitted model params (mu, sigma, onset_delta_days),
computes per-age completeness.

No DB access, no file reads, no service dependencies.
"""

import math

from .lag_distribution_utils import log_normal_cdf, to_model_space_age_days


def compute_completeness(
    cohort_age_days: float,
    mu: float,
    sigma: float,
    onset_delta_days: float = 0.0,
) -> float:
    """
    Compute what fraction of conversions have been observed for a cohort of given age.

    Uses the lognormal CDF evaluated in model-space (post-onset).
    """
    model_age = to_model_space_age_days(onset_delta_days, cohort_age_days)
    if model_age <= 0:
        return 0.0
    if sigma <= 0:
        # Degenerate distribution: all conversions happen at exp(mu).
        return 1.0 if model_age >= math.exp(mu) else 0.0
    return log_normal_cdf(model_age, mu, sigma)
