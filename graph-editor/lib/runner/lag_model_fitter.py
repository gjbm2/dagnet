"""
Lag model fitter — fits a lognormal lag distribution from snapshot DB evidence.

Pure function: takes pre-queried snapshot rows + settings, returns a fit result.
No DB access, no file reads, no service dependencies.

The caller (API handler) queries the DB and passes rows; this module only
does evidence selection, aggregation, and fitting.

See analysis-forecasting.md §4.6 for what data the fitter needs.
"""

import math
from dataclasses import dataclass
from datetime import date, datetime, time
from typing import Any, Dict, List, Optional

from .lag_distribution_utils import (
    fit_lag_distribution,
    log_normal_inverse_cdf,
    to_model_space_lag_days,
    LagDistributionFit,
)
from .forecasting_settings import ForecastingSettings


# ─────────────────────────────────────────────────────────────
# Result type
# ─────────────────────────────────────────────────────────────

@dataclass
class FitResult:
    """Result of fitting a lag model from snapshot evidence."""

    # Persisted on graph edge (flat scalars)
    mu: float
    sigma: float
    model_trained_at: str  # UK date string (d-MMM-yy), set by caller

    # Derived (useful for callers, not persisted)
    t95_days: float
    onset_delta_days: float

    # Transient provenance (returned by API, not persisted on graph)
    quality_ok: bool
    total_k: float
    quality_failure_reason: Optional[str] = None
    training_window: Optional[Dict[str, str]] = None  # {anchor_from, anchor_to} ISO dates
    settings_signature: Optional[str] = None
    evidence_anchor_days: int = 0  # how many distinct anchor days contributed


# ─────────────────────────────────────────────────────────────
# Evidence selection: latest retrieved_at per anchor_day
# ─────────────────────────────────────────────────────────────

def _int_or_zero(v: Any) -> int:
    try:
        return int(v) if v is not None else 0
    except (ValueError, TypeError):
        return 0


def _float_or_none(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (ValueError, TypeError):
        return None


def _get_x(row: Dict) -> int:
    return _int_or_zero(row.get('x') or row.get('X'))


def _get_y(row: Dict) -> int:
    return _int_or_zero(row.get('y') or row.get('Y'))


@dataclass
class _EvidenceRow:
    """One row of evidence after selection (latest per anchor_day, aggregated across slices)."""
    anchor_day: str  # ISO date
    x: int
    y: int
    median_lag_days: Optional[float]
    mean_lag_days: Optional[float]
    onset_delta_days: Optional[float]
    retrieved_at: str  # ISO datetime


def select_latest_evidence(
    rows: List[Dict[str, Any]],
    slice_keys: Optional[List[str]] = None,
) -> List[_EvidenceRow]:
    """
    Evidence selection policy P1: latest retrieved_at per anchor_day.

    If slice_keys has multiple entries (MECE union), rows for each slice_key
    are selected independently (latest per anchor_day per slice_key), then
    aggregated per anchor_day (sum X/Y, weighted-average lag moments).

    Rows with missing anchor_day or retrieved_at are skipped.
    """
    # Group rows by (anchor_day, slice_key), keep latest retrieved_at per group.
    best: Dict[tuple, Dict] = {}  # (anchor_day, slice_key) -> row

    for row in rows:
        anchor = str(row.get('anchor_day', ''))
        if not anchor:
            continue
        sk = str(row.get('slice_key', ''))
        ra = str(row.get('retrieved_at', ''))
        if not ra:
            continue

        key = (anchor, sk)
        if key not in best or ra > best[key].get('retrieved_at', ''):
            best[key] = row

    # Now aggregate across slice_keys per anchor_day.
    by_anchor: Dict[str, List[Dict]] = {}
    for (anchor, _sk), row in best.items():
        by_anchor.setdefault(anchor, []).append(row)

    result: List[_EvidenceRow] = []
    for anchor in sorted(by_anchor.keys()):
        slice_rows = by_anchor[anchor]
        total_x = sum(_get_x(r) for r in slice_rows)
        total_y = sum(_get_y(r) for r in slice_rows)

        # Weighted-average lag moments (weighted by Y, the converters).
        w_median_num = 0.0
        w_median_denom = 0.0
        w_mean_num = 0.0
        w_mean_denom = 0.0
        w_onset_num = 0.0
        w_onset_denom = 0.0
        for r in slice_rows:
            y = _get_y(r)
            if y <= 0:
                continue
            med = _float_or_none(r.get('median_lag_days'))
            mn = _float_or_none(r.get('mean_lag_days'))
            onset = _float_or_none(r.get('onset_delta_days'))
            if med is not None:
                w_median_num += med * y
                w_median_denom += y
            if mn is not None:
                w_mean_num += mn * y
                w_mean_denom += y
            if onset is not None:
                w_onset_num += onset * y
                w_onset_denom += y

        agg_median = (w_median_num / w_median_denom) if w_median_denom > 0 else None
        agg_mean = (w_mean_num / w_mean_denom) if w_mean_denom > 0 else None
        agg_onset = (w_onset_num / w_onset_denom) if w_onset_denom > 0 else None
        latest_ra = max(str(r.get('retrieved_at', '')) for r in slice_rows)

        result.append(_EvidenceRow(
            anchor_day=anchor,
            x=total_x,
            y=total_y,
            median_lag_days=agg_median,
            mean_lag_days=agg_mean,
            onset_delta_days=agg_onset,
            retrieved_at=latest_ra,
        ))

    return result


# ─────────────────────────────────────────────────────────────
# Recency-weighted aggregation across anchor days
# ─────────────────────────────────────────────────────────────

def _recency_weight(age_days: float, half_life_days: float) -> float:
    """Exponential decay weight: w = exp(-ln(2) * age / half_life)."""
    if half_life_days <= 0 or not math.isfinite(half_life_days):
        return 1.0
    if not math.isfinite(age_days) or age_days < 0:
        return 1.0
    return math.exp(-math.log(2) * age_days / half_life_days)


def _parse_date(s: str) -> Optional[date]:
    """Parse an ISO date string (YYYY-MM-DD) to a date object."""
    try:
        return date.fromisoformat(s[:10])
    except (ValueError, TypeError):
        return None


def aggregate_evidence(
    evidence: List[_EvidenceRow],
    settings: ForecastingSettings,
    reference_date: Optional[date] = None,
    reference_datetime: Optional[datetime] = None,
) -> tuple:
    """
    Aggregate evidence rows into a single (median_lag, mean_lag, total_k, onset_delta).

    Uses recency weighting: recent anchor days contribute more.
    Weights are based on Y (converters) * recency_weight.

    Returns: (aggregate_median_lag, aggregate_mean_lag, total_k, aggregate_onset_delta)
    """
    if reference_datetime is None and reference_date is None:
        # Default reference: latest anchor_day at midnight.
        dates = [_parse_date(e.anchor_day) for e in evidence]
        valid_dates = [d for d in dates if d is not None]
        d = max(valid_dates) if valid_dates else date.today()
        reference_datetime = datetime.combine(d, time.min)
    elif reference_datetime is None and reference_date is not None:
        reference_datetime = datetime.combine(reference_date, time.min)

    w_median_num = 0.0
    w_median_denom = 0.0
    w_mean_num = 0.0
    w_mean_denom = 0.0
    w_onset_num = 0.0
    w_onset_denom = 0.0
    total_k = 0.0

    for ev in evidence:
        if ev.y <= 0:
            continue

        anchor_date = _parse_date(ev.anchor_day)
        anchor_dt = datetime.combine(anchor_date, time.min) if anchor_date else None
        if anchor_dt is not None and reference_datetime is not None and reference_datetime.tzinfo is not None:
            # Align naive anchor midnight with the reference timezone to avoid naive/aware subtraction.
            anchor_dt = anchor_dt.replace(tzinfo=reference_datetime.tzinfo)
        age_days = ((reference_datetime - anchor_dt).total_seconds() / 86400.0) if (reference_datetime and anchor_dt) else 0.0
        recency_w = _recency_weight(age_days, settings.recency_half_life_days)
        w = ev.y * recency_w

        if ev.median_lag_days is not None:
            w_median_num += ev.median_lag_days * w
            w_median_denom += w
        if ev.mean_lag_days is not None:
            w_mean_num += ev.mean_lag_days * w
            w_mean_denom += w
        if ev.onset_delta_days is not None:
            w_onset_num += ev.onset_delta_days * w
            w_onset_denom += w
        total_k += ev.y

    agg_median = (w_median_num / w_median_denom) if w_median_denom > 0 else None
    agg_mean = (w_mean_num / w_mean_denom) if w_mean_denom > 0 else None
    agg_onset = (w_onset_num / w_onset_denom) if w_onset_denom > 0 else 0.0

    return agg_median, agg_mean, total_k, agg_onset


# ─────────────────────────────────────────────────────────────
# Top-level fit function
# ─────────────────────────────────────────────────────────────

def fit_model_from_evidence(
    rows: List[Dict[str, Any]],
    settings: ForecastingSettings,
    *,
    t95_constraint: Optional[float] = None,
    onset_override: Optional[float] = None,
    model_trained_at: str = '',
    training_window: Optional[Dict[str, str]] = None,
    settings_signature: Optional[str] = None,
    reference_date: Optional[date] = None,
    reference_datetime: Optional[datetime] = None,
) -> FitResult:
    """
    Fit a lognormal lag model from snapshot evidence rows.

    Args:
        rows: Raw snapshot rows (from query_snapshots / query_snapshots_for_sweep).
        settings: Forecasting settings from the frontend.
        t95_constraint: Authoritative t95 from graph edge (one-way sigma constraint).
        model_trained_at: UK date string for provenance (set by caller).
        training_window: {anchor_from, anchor_to} ISO dates for provenance.
        settings_signature: Hash of settings for provenance.
        reference_date: Reference date for recency weighting (default: latest anchor_day).
        reference_datetime: Reference datetime for recency weighting (allows fractional days; overrides reference_date).
        onset_override: Authoritative onset_delta_days (graph-mastered). If provided, overrides evidence onset.

    Returns:
        FitResult with mu, sigma, provenance, and quality metadata.
    """
    # Step 1: Select evidence (latest per anchor_day, aggregate across slices).
    evidence = select_latest_evidence(rows)

    if not evidence:
        return FitResult(
            mu=0.0,
            sigma=settings.default_sigma,
            model_trained_at=model_trained_at,
            t95_days=0.0,
            onset_delta_days=0.0,
            quality_ok=False,
            total_k=0,
            quality_failure_reason='No evidence rows',
            training_window=training_window,
            settings_signature=settings_signature,
            evidence_anchor_days=0,
        )

    # Step 2: Aggregate with recency weighting.
    agg_median, agg_mean, total_k, agg_onset = aggregate_evidence(
        evidence, settings, reference_date, reference_datetime
    )
    if onset_override is not None:
        try:
            o = float(onset_override)
            if math.isfinite(o) and o >= 0:
                agg_onset = o
        except (ValueError, TypeError):
            pass

    if agg_median is None or agg_median <= 0:
        return FitResult(
            mu=0.0,
            sigma=settings.default_sigma,
            model_trained_at=model_trained_at,
            t95_days=0.0,
            onset_delta_days=agg_onset or 0.0,
            quality_ok=False,
            total_k=total_k,
            quality_failure_reason=f'No valid median lag (aggregated median={agg_median})',
            training_window=training_window,
            settings_signature=settings_signature,
            evidence_anchor_days=len(evidence),
        )

    # Step 3: Convert to model space (subtract onset).
    median_x = to_model_space_lag_days(agg_onset, agg_median)
    mean_x = to_model_space_lag_days(agg_onset, agg_mean) if agg_mean is not None else None

    # Step 4: Fit initial distribution.
    initial_fit = fit_lag_distribution(
        median_lag=median_x,
        mean_lag=mean_x,
        total_k=total_k,
        min_fit_converters=settings.min_fit_converters,
        default_sigma=settings.default_sigma,
        min_mean_median_ratio=settings.min_mean_median_ratio,
        max_mean_median_ratio=settings.max_mean_median_ratio,
    )

    mu = initial_fit.mu
    sigma = initial_fit.sigma

    # Step 5: Apply t95 constraint (one-way: can only widen sigma).
    if (
        t95_constraint is not None
        and math.isfinite(t95_constraint)
        and t95_constraint > 0
    ):
        t95_x = to_model_space_lag_days(agg_onset, t95_constraint)
        if t95_x > 0 and median_x > 0:
            z = 1.6448536269514729  # standardNormalInverseCDF(0.95) ≈ 1.6449
            sigma_from_constraint = math.log(t95_x / median_x) / z if t95_x > median_x else 0.0
            if sigma_from_constraint > sigma:
                sigma = sigma_from_constraint

    # Step 6: Derive t95 from final fit.
    t95_x = log_normal_inverse_cdf(settings.t95_percentile, mu, sigma) if sigma > 0 else 0.0
    t95_days = (agg_onset or 0.0) + t95_x

    return FitResult(
        mu=mu,
        sigma=sigma,
        model_trained_at=model_trained_at,
        t95_days=t95_days,
        onset_delta_days=agg_onset or 0.0,
        quality_ok=initial_fit.empirical_quality_ok,
        total_k=total_k,
        quality_failure_reason=initial_fit.quality_failure_reason,
        training_window=training_window,
        settings_signature=settings_signature,
        evidence_anchor_days=len(evidence),
    )
