"""
Forecast application — evaluate completeness and produce evidence/forecast outputs.

Pure functions: given fitted model params (mu, sigma, onset_delta_days) and data points,
computes per-point completeness, layer classification, and projected values.

No DB access, no file reads, no service dependencies.

See analysis-forecasting.md §6 for the output contract.
"""

import math
from dataclasses import dataclass
from datetime import date
from typing import Any, Dict, List, Optional

from .lag_distribution_utils import log_normal_cdf, to_model_space_age_days
from .forecasting_settings import ForecastingSettings

# Epsilon to prevent division by zero when completeness is very small.
COMPLETENESS_EPSILON = 1e-9


@dataclass
class CompletenessAnnotation:
    """Per-data-point completeness and evidence/forecast split."""
    anchor_day: str
    completeness: float  # c ∈ [0, 1]
    layer: str  # 'evidence' | 'forecast' | 'mature'
    evidence_y: float  # observed Y
    forecast_y: float  # projected additional Y (projected_y - evidence_y)
    projected_y: float  # Y / max(c, eps)


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


def annotate_data_point(
    *,
    anchor_day: str,
    retrieved_at_date: str,
    y: float,
    mu: float,
    sigma: float,
    onset_delta_days: float = 0.0,
    maturity_threshold: float = 0.95,
) -> CompletenessAnnotation:
    """
    Annotate a single data point with completeness and evidence/forecast split.

    Args:
        anchor_day: ISO date string (YYYY-MM-DD) — the cohort date.
        retrieved_at_date: ISO date string (YYYY-MM-DD) — when the data was observed.
        y: Observed conversions (Y value).
        mu, sigma, onset_delta_days: Fitted model params.
        maturity_threshold: Completeness above this → 'mature' (default 0.95).
    """
    try:
        anchor = date.fromisoformat(anchor_day[:10])
        retrieved = date.fromisoformat(retrieved_at_date[:10])
        cohort_age_days = (retrieved - anchor).days
    except (ValueError, TypeError):
        cohort_age_days = 0

    c = compute_completeness(cohort_age_days, mu, sigma, onset_delta_days)

    # Clamp completeness to [0, 1].
    c = max(0.0, min(1.0, c))

    # Layer classification.
    if c >= maturity_threshold:
        layer = 'mature'
    elif c > COMPLETENESS_EPSILON:
        layer = 'forecast'
    else:
        layer = 'evidence'  # No model info (age 0 or during dead-time).

    # Evidence/forecast split.
    evidence_y = float(y)
    if c > COMPLETENESS_EPSILON:
        projected_y = evidence_y / c
    else:
        projected_y = evidence_y  # Can't project with zero completeness.
    forecast_y = max(0.0, projected_y - evidence_y)

    return CompletenessAnnotation(
        anchor_day=anchor_day,
        completeness=c,
        layer=layer,
        evidence_y=evidence_y,
        forecast_y=forecast_y,
        projected_y=projected_y,
    )


def annotate_rows(
    rows: List[Dict[str, Any]],
    mu: float,
    sigma: float,
    onset_delta_days: float = 0.0,
    *,
    maturity_threshold: float = 0.95,
    retrieved_at_override: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Annotate a list of data-point dicts with completeness fields.

    Each input row must have at least 'anchor_day' and 'y' (or 'Y').
    Optionally 'retrieved_at' (ISO datetime); if absent, uses retrieved_at_override.

    Returns the same rows with added fields:
    'completeness', 'layer', 'evidence_y', 'forecast_y', 'projected_y'.
    """
    results = []
    for row in rows:
        anchor_day = str(row.get('anchor_day', ''))
        y = row.get('y') or row.get('Y') or 0
        try:
            y = float(y)
        except (ValueError, TypeError):
            y = 0.0

        # Determine retrieved_at date for age calculation.
        ra = row.get('retrieved_at') or retrieved_at_override or ''
        ra_date = str(ra)[:10] if ra else ''

        ann = annotate_data_point(
            anchor_day=anchor_day,
            retrieved_at_date=ra_date,
            y=y,
            mu=mu,
            sigma=sigma,
            onset_delta_days=onset_delta_days,
            maturity_threshold=maturity_threshold,
        )

        # Merge annotation into the row (non-destructive copy).
        annotated = dict(row)
        annotated['completeness'] = ann.completeness
        annotated['layer'] = ann.layer
        annotated['evidence_y'] = ann.evidence_y
        annotated['forecast_y'] = ann.forecast_y
        annotated['projected_y'] = ann.projected_y
        results.append(annotated)

    return results


def compute_blended_mean(
    observed_pct: float,
    baseline_pct: float,
    completeness: float,
    n_query: float,
    n_baseline: float,
    settings: ForecastingSettings,
) -> float:
    """
    Compute the evidence/forecast blended probability.

    w_evidence = (c^η * n_q) / (λ * n_baseline + c^η * n_q)
    blended = w_evidence * observed_pct + (1 - w_evidence) * baseline_pct

    Where η = blend_completeness_power and λ = forecast_blend_lambda.
    """
    c_eff = completeness ** settings.blend_completeness_power
    lam = settings.forecast_blend_lambda

    denom = lam * n_baseline + c_eff * n_query
    if denom <= 0:
        return baseline_pct

    w_evidence = (c_eff * n_query) / denom
    return w_evidence * observed_pct + (1.0 - w_evidence) * baseline_pct
