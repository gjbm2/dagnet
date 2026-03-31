"""
Forecasting settings — configuration for model fitting and completeness application.

Settings are per-repo, edited in the frontend (graph-editor/src/constants/latency.ts).
The frontend sends them explicitly in API requests. Python defines defaults here for
tests and documentation, but the frontend-supplied values are authoritative at runtime.

See analysis-forecasting.md §4.5 for the architectural decision.
"""

import hashlib
import json
import math
from dataclasses import dataclass, asdict
from typing import Any, Dict, Optional


@dataclass
class ForecastingSettings:
    """
    All tuning constants needed by the Python backend for fitting and application.

    Field names match the wire format sent by the frontend's buildForecastingSettings().
    Default values match graph-editor/src/constants/latency.ts.
    """

    # ── Fitting (quality gates + estimation) ──────────────────

    min_fit_converters: float = 30
    """Minimum converters for quality gate."""

    min_mean_median_ratio: float = 0.9
    """Lower quality gate on mean/median ratio."""

    max_mean_median_ratio: float = 999999
    """Upper quality gate on mean/median ratio."""

    default_sigma: float = 0.5
    """Fallback sigma when mean is missing."""

    recency_half_life_days: float = 30
    """Half-life (days) for recency weighting."""

    onset_mass_fraction_alpha: float = 0.01
    """Onset estimation: mass fraction threshold."""

    onset_aggregation_beta: float = 0.5
    """Onset aggregation: weighted quantile parameter."""

    # ── Application (completeness + blending) ─────────────────

    t95_percentile: float = 0.95
    """Which percentile defines t95."""

    forecast_blend_lambda: float = 0.15
    """Evidence/forecast blend weight (λ)."""

    blend_completeness_power: float = 2.25
    """Blend curve shape (η): completeness^η for blend weighting."""

    # ── Evidence scope control ─────────────────────────────────

    fit_left_censor_days: float = 0
    """Left-censor fitting evidence to the most recent N days. 0 = no censor."""

    # ── Bayesian fit_history retention ─────────────────────────

    bayes_fit_history_interval_days: float = 0
    """Minimum days between retained fit_history entries. 0 = store every fit (doc 27 §4)."""

    bayes_fit_history_max_days: float = 100
    """Maximum age in days of the oldest retained fit_history entry (doc 27 §4)."""

    # ── Bayesian model priors ─────────────────────────────────

    bayes_log_kappa_mu: float = 3.4012
    """Centre of LogNormal prior on κ (overdispersion). log(30) ≈ 3.4. Higher = less overdispersion expected."""

    bayes_log_kappa_sigma: float = 1.5
    """Width of LogNormal prior on κ. 1.5 gives 95% CI ≈ [2, 500]."""

    bayes_fallback_prior_ess: float = 20.0
    """Effective sample size for fallback Beta prior when no Phase 1 posterior is available."""

    bayes_dirichlet_conc_floor: float = 0.5
    """Minimum concentration for Beta/Dirichlet priors. 0.5 = weakly informative (Jeffreys)."""

    bayes_sigma_floor: float = 0.01
    """Minimum latency σ (log-scale spread). Below this the edge is treated as no-latency."""

    bayes_mu_prior_sigma_floor: float = 0.5
    """Minimum uncertainty on latency μ prior. Ensures sampler has room to explore."""

    bayes_maturity_floor: float = 0.9
    """Minimum CDF completeness (F) for observations to enter dispersion/drift estimation."""

    bayes_softplus_sharpness: float = 5.0
    """Sharpness of softplus onset boundary. Higher = sharper cutoff below onset."""

    # ── Bayesian convergence thresholds ───────────────────────

    bayes_rhat_threshold: float = 1.05
    """Maximum Gelman-Rubin statistic for a parameter to be considered converged."""

    bayes_ess_threshold: float = 400.0
    """Minimum effective sample size for a parameter to be considered converged."""

    bayes_warm_start_rhat_max: float = 1.10
    """Maximum rhat to accept a previous posterior as warm-start prior."""

    bayes_warm_start_ess_min: float = 100.0
    """Minimum ESS to accept a previous posterior as warm-start prior."""

    bayes_hdi_prob: float = 0.90
    """Credible interval probability for posterior summaries (0.90 = 90% HDI)."""

    # ── Bayesian sampling configuration ───────────────────────

    bayes_draws: float = 2000.0
    """MCMC post-warmup samples per chain."""

    bayes_tune: float = 1000.0
    """MCMC warmup/tuning iterations per chain."""

    bayes_chains: float = 4.0
    """Number of independent MCMC chains."""

    bayes_target_accept: float = 0.90
    """NUTS target acceptance rate. Higher = more conservative but slower."""


def settings_from_dict(d: Optional[Dict[str, Any]]) -> ForecastingSettings:
    """
    Construct ForecastingSettings from a dict (e.g. from an API request body).

    Missing fields use Python defaults. Extra fields are ignored.
    """
    if not d:
        return ForecastingSettings()

    kwargs = {}
    for field_name in ForecastingSettings.__dataclass_fields__:
        if field_name in d:
            val = d[field_name]
            if isinstance(val, (int, float)) and math.isfinite(val):
                kwargs[field_name] = float(val)
    return ForecastingSettings(**kwargs)


def compute_settings_signature(settings: ForecastingSettings) -> str:
    """
    Compute a deterministic hash of the settings for model provenance.

    The signature is a hex SHA-256 truncated to 16 characters. It changes
    when any setting value changes, enabling stale-model detection.
    """
    # Canonical JSON: sorted keys, no whitespace, full float precision.
    d = asdict(settings)
    canonical = json.dumps(d, sort_keys=True, separators=(',', ':'))
    digest = hashlib.sha256(canonical.encode('utf-8')).hexdigest()
    return digest[:16]
