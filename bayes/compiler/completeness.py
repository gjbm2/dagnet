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
# PyTensor-native FW composition (Phase D: differentiable path latency)
# ---------------------------------------------------------------------------

def pt_fw_compose_pair(mu1, sigma1, mu2, sigma2):
    """FW approximation for sum of two lognormals — PyTensor version.

    Identical maths to fw_compose_pair but using pytensor.tensor ops,
    so the result is a differentiable PyTensor expression. Accepts any
    mix of PyTensor variables and Python floats.

    Returns (mu_fw, sigma_fw) as PyTensor expressions.
    """
    import pytensor.tensor as pt

    e1 = pt.exp(mu1 + sigma1 ** 2 / 2)
    e2 = pt.exp(mu2 + sigma2 ** 2 / 2)

    v1 = (pt.exp(sigma1 ** 2) - 1) * pt.exp(2 * mu1 + sigma1 ** 2)
    v2 = (pt.exp(sigma2 ** 2) - 1) * pt.exp(2 * mu2 + sigma2 ** 2)

    e_sum = e1 + e2
    v_sum = v1 + v2

    sigma_sq = pt.log(1 + v_sum / pt.maximum(e_sum ** 2, 1e-30))
    sigma_fw = pt.sqrt(pt.maximum(sigma_sq, 1e-6))
    mu_fw = pt.log(pt.maximum(e_sum, 1e-30)) - sigma_sq / 2

    return mu_fw, sigma_fw


def pt_fw_chain(components: list[tuple]) -> tuple:
    """Compose a chain of lognormals via iterated PyTensor FW.

    components: list of (mu, sigma) pairs. Each can be a PyTensor
    variable (latent edge) or a Python float (fixed edge). PyTensor
    promotes floats automatically.

    Returns (mu_composed, sigma_composed) as PyTensor expressions.
    """
    import pytensor.tensor as pt

    if not components:
        return pt.as_tensor_variable(0.0), pt.as_tensor_variable(0.01)

    mu, sigma = components[0]
    if len(components) == 1:
        return pt.as_tensor_variable(mu), pt.as_tensor_variable(sigma)

    for mu_next, sigma_next in components[1:]:
        mu, sigma = pt_fw_compose_pair(mu, sigma, mu_next, sigma_next)

    return mu, sigma


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


def pt_moment_matched_collapse(
    inbound: list[tuple],
) -> tuple:
    """Differentiable moment-matched collapse at a join node.

    inbound: list of (delta, mu, sigma, weight) per inbound path.
    delta is a float (onset sum); mu, sigma, weight may be PyTensor
    variables or floats.

    Returns (delta_mix, mu_mix, sigma_mix) where mu_mix/sigma_mix are
    PyTensor expressions. delta_mix is a float (min of deltas).

    Uses log-sum-exp formulation to avoid numerical overflow. The naive
    approach computes E[T] = exp(mu + sigma²/2) which explodes for
    large mu (e.g. mu=7 → E[T]=10,000). Log-sum-exp keeps everything
    in log-space: log(Σ w_i · exp(a_i)) = max(a_i) + log(Σ w_i · exp(a_i - max(a_i))).

    See doc 6 § "Join latency handling: moment-matched collapse".
    """
    import pytensor.tensor as pt

    if not inbound:
        return 0.0, pt.as_tensor_variable(0.0), pt.as_tensor_variable(0.01)

    if len(inbound) == 1:
        d, m, s, _ = inbound[0]
        return d, pt.as_tensor_variable(m), pt.as_tensor_variable(s)

    # Normalise weights
    raw_weights = [w for _, _, _, w in inbound]
    all_float = all(isinstance(w, (int, float)) for w in raw_weights)
    total_w = sum(raw_weights) if all_float else pt.sum(pt.stack(raw_weights))
    weights = [w / total_w for w in raw_weights]

    delta_mix = min(float(d) for d, _, _, _ in inbound)

    # Log-space moment computation.
    # For each inbound path i with shifted lognormal (delta_i, mu_i, sigma_i):
    #   log E[T_i - delta_mix] = log(delta_i - delta_mix + exp(mu_i + sigma_i²/2))
    # We need log(Σ w_i · E[T_i - delta_mix]) = log-sum-exp of (log(w_i) + log(E[T_i - delta_mix]))
    #
    # For the second moment:
    #   log E[(T_i - delta_mix)²] = log(Var_i + E_shifted_i²)

    # Build log(E_shifted_i) for each path using log-add-exp
    # E_shifted_i = (delta_i - delta_mix) + exp(mu_i + sigma_i²/2)
    log_e_shifted = []
    log_e2_shifted = []

    for (delta, mu, sigma, _), w in zip(inbound, weights):
        mu = pt.as_tensor_variable(mu)
        sigma = pt.as_tensor_variable(sigma)

        d_offset = float(delta) - delta_mix  # non-negative float
        log_lognormal_mean = mu + sigma ** 2 / 2  # log(exp(mu + sigma²/2))

        if d_offset > 0:
            # E_shifted = d_offset + exp(log_lognormal_mean)
            # log(E_shifted) = log(d_offset + exp(log_lognormal_mean))
            #                 = log_add_exp(log(d_offset), log_lognormal_mean)
            log_d = pt.log(pt.as_tensor_variable(d_offset))
            log_es = pt.logaddexp(log_d, log_lognormal_mean)
        else:
            # d_offset == 0 (this is the min-delta path)
            log_es = log_lognormal_mean

        log_e_shifted.append(log_es)

        # E[(T - delta_mix)²] = (delta - delta_mix)² + 2*(delta - delta_mix)*exp(mu + sigma²/2) + exp(2*mu + 2*sigma²)
        # In log-space: log(E2) = log(d²  + 2*d*exp(a) + exp(2a + sigma²))
        #   where a = mu + sigma²/2
        # = log-sum-exp of the three terms
        log_term3 = 2 * mu + 2 * sigma ** 2  # log(exp(2*mu + 2*sigma²))
        if d_offset > 0:
            log_term1 = pt.log(pt.as_tensor_variable(d_offset ** 2))
            log_term2 = pt.log(pt.as_tensor_variable(2 * d_offset)) + log_lognormal_mean
            log_e2 = pt.logaddexp(pt.logaddexp(log_term1, log_term2), log_term3)
        else:
            log_e2 = log_term3

        log_e2_shifted.append(log_e2)

    # Weighted log-sum-exp: log(Σ w_i · E_shifted_i) = log-sum-exp(log(w_i) + log(E_shifted_i))
    log_w = [pt.log(pt.maximum(pt.as_tensor_variable(w), 1e-30)) for w in weights]

    log_we = pt.stack([lw + les for lw, les in zip(log_w, log_e_shifted)])
    log_e_mix = pt.logsumexp(log_we)

    log_we2 = pt.stack([lw + le2 for lw, le2 in zip(log_w, log_e2_shifted)])
    log_e2_mix = pt.logsumexp(log_we2)

    # Var = E2 - E² → log(Var) = log(exp(log_E2) - exp(2*log_E))
    # Use: log(a - b) = log(a) + log(1 - exp(log(b) - log(a)))
    #                  = log_E2 + log(1 - exp(2*log_E - log_E2))
    # = log_E2 + log1mexp(log_E2 - 2*log_E)  [when log_E2 > 2*log_E]
    two_log_e = 2 * log_e_mix
    log_var_diff = log_e2_mix - two_log_e  # should be > 0 (variance > 0)
    # log(1 - exp(-|x|)) ≈ log(|x|) for small |x|, stable via log1mexp
    log_var = log_e2_mix + pt.log(pt.maximum(1.0 - pt.exp(two_log_e - log_e2_mix), 1e-10))

    # sigma_mix² = log(1 + Var/E²) = log(1 + exp(log_var - 2*log_e))
    sigma_sq = pt.log1p(pt.exp(log_var - two_log_e))
    sigma_mix = pt.sqrt(pt.maximum(sigma_sq, 1e-6))

    # mu_mix = log(E_shifted) - sigma² / 2
    mu_mix = log_e_mix - sigma_sq / 2

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
