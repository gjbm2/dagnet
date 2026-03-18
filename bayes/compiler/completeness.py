"""
Completeness math: CDF evaluation, Fenton-Wilkinson composition,
moment-matched join collapse, and latency prior derivation.

All functions are pure Python + math — no PyMC dependency.
In Phase A, latency is fixed (point estimates), so completeness
is a pre-computed scalar per observation.
"""

from __future__ import annotations

import math
from typing import NamedTuple


class FWResult(NamedTuple):
    """Result of Fenton-Wilkinson composition."""
    mu: float
    sigma: float


# ---------------------------------------------------------------------------
# CDF
# ---------------------------------------------------------------------------

def lognormal_cdf(x: float, mu: float, sigma: float) -> float:
    """CDF of LN(mu, sigma) at x. Returns 0 for x <= 0."""
    if x <= 0 or sigma <= 0:
        return 0.0
    return 0.5 * (1.0 + math.erf((math.log(x) - mu) / (sigma * math.sqrt(2))))


def shifted_lognormal_cdf(
    age: float, onset: float, mu: float, sigma: float,
) -> float:
    """CDF of shifted lognormal: T = onset + LN(mu, sigma).

    completeness = CDF(max(0, age - onset), mu, sigma)
    """
    effective_age = age - onset
    if effective_age <= 0:
        return 0.0
    return lognormal_cdf(effective_age, mu, sigma)


# ---------------------------------------------------------------------------
# Fenton-Wilkinson composition
# ---------------------------------------------------------------------------

def fw_compose_pair(mu1: float, sigma1: float, mu2: float, sigma2: float) -> FWResult:
    """FW approximation for sum of two independent lognormals.

    Given X1 ~ LN(mu1, sigma1), X2 ~ LN(mu2, sigma2),
    approximate X1 + X2 ≈ LN(mu_fw, sigma_fw).
    """
    # Moments of each component
    e1 = math.exp(mu1 + sigma1 ** 2 / 2)
    e2 = math.exp(mu2 + sigma2 ** 2 / 2)

    v1 = (math.exp(sigma1 ** 2) - 1) * math.exp(2 * mu1 + sigma1 ** 2)
    v2 = (math.exp(sigma2 ** 2) - 1) * math.exp(2 * mu2 + sigma2 ** 2)

    e_sum = e1 + e2
    v_sum = v1 + v2

    if e_sum <= 0:
        return FWResult(mu=0.0, sigma=0.01)

    sigma_sq = math.log(1 + v_sum / e_sum ** 2)
    sigma_fw = math.sqrt(max(sigma_sq, 1e-6))
    mu_fw = math.log(e_sum) - sigma_sq / 2

    return FWResult(mu=mu_fw, sigma=sigma_fw)


def fw_chain(edges: list[tuple[float, float]]) -> FWResult:
    """Compose a chain of lognormals via iterated FW.

    edges: list of (mu, sigma) for each latency edge in the chain.
    """
    if not edges:
        return FWResult(mu=0.0, sigma=0.01)

    mu, sigma = edges[0]
    for mu_next, sigma_next in edges[1:]:
        result = fw_compose_pair(mu, sigma, mu_next, sigma_next)
        mu, sigma = result.mu, result.sigma

    return FWResult(mu=mu, sigma=sigma)


# ---------------------------------------------------------------------------
# Join-node moment-matched collapse (doc 6, §join latency handling)
# ---------------------------------------------------------------------------

def moment_matched_collapse(
    inbound: list[tuple[float, float, float, float]],
) -> tuple[float, float, float]:
    """Collapse multiple inbound path models at a join node.

    inbound: list of (path_delta, path_mu, path_sigma, weight) per path.
    Returns (delta_mix, mu_mix, sigma_mix).
    """
    if not inbound:
        return 0.0, 0.0, 0.01

    if len(inbound) == 1:
        d, m, s, _ = inbound[0]
        return d, m, s

    # Normalise weights
    total_w = sum(w for _, _, _, w in inbound)
    if total_w <= 0:
        total_w = len(inbound)
        weights = [1.0 / total_w] * len(inbound)
    else:
        weights = [w / total_w for _, _, _, w in inbound]

    # Step 1: moments of each shifted lognormal
    e_vals = []
    e2_vals = []
    for (delta, mu, sigma, _), w in zip(inbound, weights):
        e_ln = math.exp(mu + sigma ** 2 / 2)
        e_t = delta + e_ln
        e2_t = (delta ** 2
                + 2 * delta * e_ln
                + math.exp(2 * mu + 2 * sigma ** 2))
        e_vals.append(e_t)
        e2_vals.append(e2_t)

    # Step 2: mixture moments
    e_mix = sum(w * e for w, e in zip(weights, e_vals))
    e2_mix = sum(w * e2 for w, e2 in zip(weights, e2_vals))
    var_mix = e2_mix - e_mix ** 2

    # Step 3: collapse to shifted lognormal
    delta_mix = min(d for d, _, _, _ in inbound)
    e_shifted = e_mix - delta_mix

    if e_shifted <= 0:
        return delta_mix, 0.0, 0.01

    if var_mix <= 0:
        var_mix = 1e-6

    sigma_sq = math.log(1 + var_mix / e_shifted ** 2)
    sigma_mix = math.sqrt(max(sigma_sq, 1e-6))
    mu_mix = math.log(e_shifted) - sigma_sq / 2

    return delta_mix, mu_mix, sigma_mix


# ---------------------------------------------------------------------------
# Latency prior derivation (doc 1 §15.1, doc 6 Layer 4)
# ---------------------------------------------------------------------------

def derive_latency_prior(
    median_lag_days: float,
    mean_lag_days: float,
    onset_delta_days: float,
    eps: float = 0.01,
) -> tuple[float, float]:
    """Derive (mu, sigma) in model-space from lag summaries.

    mu = ln(max(ε, median_lag - onset))
    sigma = sqrt(2 * (ln(max(ε, mean_lag - onset)) - mu)), floor at ε
    """
    median_x = max(eps, median_lag_days - onset_delta_days)
    mean_x = max(eps, mean_lag_days - onset_delta_days)

    mu = math.log(median_x)

    diff = math.log(mean_x) - mu
    if diff <= 0:
        sigma = eps
    else:
        sigma = math.sqrt(2 * diff)

    return mu, max(sigma, eps)


def gamma_params_from_mode(mode: float, spread: float = 0.5) -> tuple[float, float]:
    """Derive Gamma(α, β) with given mode and prior spread.

    α = 1 + (mode / spread)²
    β = (α - 1) / mode

    Used for sigma_{edge} ~ Gamma(α, β) prior (mode at observed dispersion).
    """
    if mode <= 0:
        return 2.0, 2.0
    alpha = 1.0 + (mode / spread) ** 2
    beta = (alpha - 1.0) / mode
    return alpha, beta
