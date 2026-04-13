"""
ForecastState — generalised forecast engine output contract.

Produced per edge per subject. Consumers read from this rather than
independently computing completeness, rate, and dispersions.

See doc 29 §ForecastState Contract.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import numpy as np

from .model_resolver import ResolvedLatency, ResolvedModelParams


# ═══════════════════════════════════════════════════════════════════════
# Contract types
# ═══════════════════════════════════════════════════════════════════════

@dataclass
class Dispersions:
    """Raw component SDs for consumers that need them."""
    p_sd: float = 0.0
    mu_sd: float = 0.0
    sigma_sd: float = 0.0
    onset_sd: float = 0.0


@dataclass
class TrajectoryPoint:
    """Per-tau forecast state for trajectory consumers."""
    tau: int
    completeness: float
    completeness_sd: float
    rate_unconditioned: float
    rate_unconditioned_sd: float
    rate_conditioned: float
    rate_conditioned_sd: float


@dataclass
class ForecastState:
    """Per-edge forecast state — the engine's output contract."""

    # Identity
    edge_id: str = ''
    source: str = ''              # 'analytic' | 'analytic_be' | 'bayesian' | 'manual'
    fitted_at: Optional[str] = None
    tier: str = 'fe_instant'      # 'fe_instant' | 'be_forecast' | 'fe_only'

    # Query context
    evaluation_date: str = ''
    evidence_cutoff_date: str = ''
    posterior_cutoff_date: str = ''

    # Completeness
    completeness: float = 0.0
    completeness_sd: Optional[float] = None

    # Model (unconditioned)
    rate_unconditioned: Optional[float] = None
    rate_unconditioned_sd: Optional[float] = None

    # Evidence-conditioned
    rate_conditioned: float = 0.0
    rate_conditioned_sd: Optional[float] = None
    tau_observed: int = 0

    # Raw dispersions
    dispersions: Optional[Dispersions] = None

    # Mode metadata
    mode: str = 'window'          # 'window' | 'cohort'
    path_aware: bool = False

    # Trajectory (optional)
    trajectory: Optional[List[TrajectoryPoint]] = None

    # Resolved params (for MC consumers like v3)
    resolved_params: Optional[ResolvedModelParams] = None


# ═══════════════════════════════════════════════════════════════════════
# Completeness with uncertainty
# ═══════════════════════════════════════════════════════════════════════

_COMPLETENESS_SD_DRAWS = 200


def _compute_completeness_at_age(
    age_days: float,
    mu: float,
    sigma: float,
    onset: float,
) -> float:
    """Compute completeness = CDF(age - onset, mu, sigma).

    Same formula as forecast_application.compute_completeness but
    inlined to avoid circular imports.
    """
    model_age = age_days - onset
    if model_age <= 0 or sigma <= 0:
        return 1.0 if (sigma <= 0 and model_age >= math.exp(mu)) else 0.0
    z = (math.log(model_age) - mu) / sigma
    # Standard normal CDF via erfc
    return 0.5 * math.erfc(-z / math.sqrt(2))


def compute_completeness_with_sd(
    age_days: float,
    latency: ResolvedLatency,
) -> tuple:
    """Compute completeness point estimate and SD from latency dispersions.

    Uses 200 draws from (mu, sigma, onset) with onset_mu_corr.
    Returns (completeness, completeness_sd).

    When SDs are all zero, returns (point_estimate, 0.0).
    """
    mu = latency.mu
    sigma = latency.sigma
    onset = latency.onset_delta_days

    point = _compute_completeness_at_age(age_days, mu, sigma, onset)

    # If no dispersions, SD is zero
    if latency.mu_sd <= 0 and latency.sigma_sd <= 0 and latency.onset_sd <= 0:
        return (point, 0.0)

    rng = np.random.default_rng(seed=71)
    S = _COMPLETENESS_SD_DRAWS

    # Draw mu and onset jointly (correlated via onset_mu_corr)
    mu_draws = rng.normal(mu, max(latency.mu_sd, 1e-10), size=S)
    onset_mean = onset
    onset_sd = max(latency.onset_sd, 1e-10)

    if abs(latency.onset_mu_corr) > 1e-6 and latency.mu_sd > 0:
        # Conditional draw: onset | mu
        rho = latency.onset_mu_corr
        onset_draws = (
            onset_mean
            + rho * (onset_sd / max(latency.mu_sd, 1e-10)) * (mu_draws - mu)
            + rng.normal(0, onset_sd * math.sqrt(max(1 - rho * rho, 0)), size=S)
        )
    else:
        onset_draws = rng.normal(onset_mean, onset_sd, size=S)

    onset_draws = np.maximum(onset_draws, 0.0)

    # Draw sigma independently (no known correlation with mu/onset)
    sigma_draws = np.clip(
        rng.normal(sigma, max(latency.sigma_sd, 1e-10), size=S),
        0.01, 20.0,
    )

    # Evaluate CDF for each draw
    completeness_draws = np.array([
        _compute_completeness_at_age(age_days, float(mu_draws[i]),
                                      float(sigma_draws[i]),
                                      float(onset_draws[i]))
        for i in range(S)
    ])

    c_sd = float(np.std(completeness_draws))
    return (point, c_sd)


# ═══════════════════════════════════════════════════════════════════════
# Composed rate uncertainty
# ═══════════════════════════════════════════════════════════════════════

def _compose_rate_sd(
    p: float,
    p_sd: float,
    completeness: float,
    completeness_sd: float,
) -> float:
    """Compose rate SD from p and completeness uncertainties.

    Independence assumption (doc 29 §note): overestimates rate_sd
    because p and latency are anti-correlated in the posterior.
    Conservative (wider bands than warranted).
    """
    if completeness_sd <= 0 and p_sd <= 0:
        return 0.0
    term_p = completeness * p_sd
    term_c = p * completeness_sd
    return math.sqrt(term_p * term_p + term_c * term_c)


# ═══════════════════════════════════════════════════════════════════════
# Window-mode ForecastState computation
# ═══════════════════════════════════════════════════════════════════════

def compute_forecast_state_window(
    edge_id: str,
    resolved: ResolvedModelParams,
    cohort_ages_and_weights: List[tuple],
    evaluation_date: str = '',
    evidence_cutoff_date: str = '',
    posterior_cutoff_date: str = '',
    evidence_rate: Optional[float] = None,
) -> ForecastState:
    """Compute ForecastState for a window-mode edge.

    Args:
        edge_id: edge UUID.
        resolved: resolved model params from the promoted resolver.
        cohort_ages_and_weights: list of (age_days, n) tuples for
            the cohorts in the query window. Used to compute
            n-weighted completeness.
        evaluation_date: asat date or "now".
        evidence_cutoff_date: snapshot cutoff.
        posterior_cutoff_date: model cutoff.
        evidence_rate: observed k/n if available (for conditioning).

    Returns:
        ForecastState with all window-mode fields populated.
    """
    lat = resolved.latency
    p = resolved.p_mean

    # ── N-weighted completeness with SD ──────────────────────────
    total_n = 0.0
    weighted_c = 0.0
    weighted_c_sd_sq = 0.0  # variance, n-weighted

    for age_days, n in cohort_ages_and_weights:
        c, c_sd = compute_completeness_with_sd(float(age_days), lat)
        weighted_c += n * c
        weighted_c_sd_sq += n * n * c_sd * c_sd
        total_n += n

    if total_n > 0:
        completeness = weighted_c / total_n
        # SD of weighted mean: sqrt(Σ(n_i² × sd_i²)) / Σ(n_i)
        completeness_sd = math.sqrt(weighted_c_sd_sq) / total_n
    else:
        completeness = 0.0
        completeness_sd = 0.0

    # ── Rates ────────────────────────────────────────────────────
    rate_unconditioned = p * completeness
    rate_unconditioned_sd = _compose_rate_sd(p, resolved.p_sd,
                                             completeness, completeness_sd)

    # Evidence-conditioned: blend
    if evidence_rate is not None and completeness > 0:
        # Blend: c × evidence + (1-c) × model
        model_rate = p * completeness
        rate_conditioned = (
            completeness * evidence_rate
            + (1 - completeness) * model_rate
        )
        # Conditioned SD shrinks as completeness → 1
        # At c=1: pure evidence, SD = evidence sampling SD (not computed here)
        # At c=0: pure model, SD = rate_unconditioned_sd
        rate_conditioned_sd = (1 - completeness) * rate_unconditioned_sd
    else:
        rate_conditioned = rate_unconditioned
        rate_conditioned_sd = rate_unconditioned_sd

    # ── Tau observed (n-weighted age) ────────────────────────────
    tau_observed = 0
    if total_n > 0 and cohort_ages_and_weights:
        tau_observed = int(round(
            sum(age * n for age, n in cohort_ages_and_weights) / total_n
        ))

    dispersions = Dispersions(
        p_sd=resolved.p_sd,
        mu_sd=lat.mu_sd,
        sigma_sd=lat.sigma_sd,
        onset_sd=lat.onset_sd,
    )

    return ForecastState(
        edge_id=edge_id,
        source=resolved.source,
        fitted_at=resolved.fitted_at,
        tier='be_forecast',
        evaluation_date=evaluation_date,
        evidence_cutoff_date=evidence_cutoff_date,
        posterior_cutoff_date=posterior_cutoff_date,
        completeness=completeness,
        completeness_sd=completeness_sd,
        rate_unconditioned=rate_unconditioned,
        rate_unconditioned_sd=rate_unconditioned_sd,
        rate_conditioned=rate_conditioned,
        rate_conditioned_sd=rate_conditioned_sd,
        tau_observed=tau_observed,
        dispersions=dispersions,
        mode='window',
        path_aware=False,
        resolved_params=resolved,
    )
