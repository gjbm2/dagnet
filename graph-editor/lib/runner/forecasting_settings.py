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
