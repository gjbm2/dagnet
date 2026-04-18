"""
Rate-uncertainty band resolution for per-bin Bayesian/promoted display.

Per bin date, resolve the best-available Beta(alpha, beta) on the edge's
conversion rate and compute an HDI. Source priority matches the promoted-
model resolver:

  1. Bayesian fit_history — if the promoted model is bayesian AND fit_history
     has an entry on-or-before the bin date, use that entry's alpha/beta.
     If the requested slice (cohort() / window()) is missing from an entry
     but its sibling is present, the sibling is used — this is justified
     because absence of a distinct slice in the entry means the compiler's
     evidence layer never distinguished cohort vs window for this edge
     (top-of-graph case, or generally no latency ancestor).
  2. Current promoted alpha/beta — via resolve_model_params. This walks
     bayesian → analytic_be → analytic and ultimately falls back to an
     evidence-derived Beta if no fit exists. Always non-null for edges
     with any probability parameter.

Pure function, no I/O. The edge dict is passed in; no file reads.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date
from typing import Any, Dict, List, Optional

from .model_resolver import resolve_model_params


@dataclass
class RateBand:
    """Epistemic/promoted rate-uncertainty band for one bin date."""
    hdi_lower: float
    hdi_upper: float
    posterior_mean: float
    hdi_level: float
    evidence_grade: int
    fitted_at: str          # date string or empty
    source_slice: str       # 'window()' | 'cohort()' | '' (when from current resolver)
    source_model: str       # 'bayesian' | 'analytic_be' | 'analytic' | 'evidence' | 'prior'


# ── Date parsing ─────────────────────────────────────────────────────────

_UK_MONTH_TO_NUM = {
    'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
    'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12,
}


def _parse_uk_or_iso_date(s: str) -> Optional[date]:
    if not s:
        return None
    try:
        return date.fromisoformat(s[:10])
    except (ValueError, TypeError):
        pass
    parts = s.split('-')
    if len(parts) != 3:
        return None
    try:
        day = int(parts[0])
        month = _UK_MONTH_TO_NUM.get(parts[1][:3].lower())
        if month is None:
            return None
        year = int(parts[2])
        if year < 100:
            year += 2000
        return date(year, month, day)
    except (ValueError, TypeError):
        return None


# ── HDI computation ──────────────────────────────────────────────────────

def _hdi_from_beta(alpha: float, beta: float, hdi_level: float) -> tuple[float, float]:
    """Equal-tailed interval from Beta(alpha, beta). Good enough for display."""
    if alpha <= 0 or beta <= 0:
        return (0.0, 0.0)
    from scipy.stats import beta as _beta_dist
    tail = (1.0 - hdi_level) / 2.0
    lo = float(_beta_dist.ppf(tail, alpha, beta))
    hi = float(_beta_dist.ppf(1.0 - tail, alpha, beta))
    return (lo, hi)


# ── Slice matching with sibling fallback ─────────────────────────────────

def _canonicalise(k: str) -> str:
    return ''.join(k.split())


def _find_slice_with_fallback(
    slices: Dict[str, Any],
    target_key: str,
) -> tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Look up target slice; if absent and target is cohort(), fall back to
    window() in the same slices dict. Returns (slice_entry, resolved_key)."""
    target_canon = _canonicalise(target_key)
    for raw_key, entry in slices.items():
        if _canonicalise(raw_key) == target_canon:
            return entry, raw_key
    # Cohort→window fallback (see module docstring)
    if target_canon == 'cohort()':
        for raw_key, entry in slices.items():
            if _canonicalise(raw_key) == 'window()':
                return entry, raw_key
    return None, None


# ── Main resolver ────────────────────────────────────────────────────────

def resolve_rate_bands(
    edge: Optional[Dict[str, Any]],
    dates: List[str],
    temporal_mode: str = 'window',
    hdi_level: Optional[float] = None,
) -> Dict[str, Optional[RateBand]]:
    """Per-bin resolution: Bayesian fit_history where available, else the
    edge's current promoted alpha/beta.

    Args:
        edge: graph edge dict (the full {uuid, from, to, p: {...}}).
        dates: bin date strings (ISO or UK).
        temporal_mode: 'window' | 'cohort' — selects which slice to prefer.
        hdi_level: HDI level override; defaults to posterior's or 0.90.

    Returns:
        Dict keyed by input date string → RateBand (or None if the edge has
        no usable probability parameter at all, which should be rare).
    """
    result: Dict[str, Optional[RateBand]] = {d: None for d in dates}
    if not edge:
        return result

    # ── Current promoted alpha/beta (always-available fallback) ──────
    resolved = resolve_model_params(edge, scope='edge', temporal_mode=temporal_mode)
    current_alpha = resolved.alpha if resolved else 0.0
    current_beta = resolved.beta if resolved else 0.0
    current_source = resolved.source if resolved else ''
    current_fitted = resolved.fitted_at if resolved else ''

    # ── fit_history timeline (only when promoted source is bayesian) ──
    p = (edge.get('p') or {})
    stashed = p.get('_posteriorSlices') or {}
    fit_history = stashed.get('fit_history') or []
    current_slices = stashed.get('slices') or {}
    current_fitted_at_stashed = stashed.get('fitted_at') or current_fitted
    level = float(
        hdi_level if hdi_level is not None
        else (stashed.get('hdi_level') or 0.90)
    )

    target_slice_key = f"{temporal_mode}()"

    # Only walk fit_history when we actually have a bayesian promoted model
    use_fit_history = (current_source == 'bayesian') and (fit_history or current_slices)

    # Build timeline: fit_history entries + current stashed posterior as latest
    timeline: List[tuple[date, Dict[str, Any]]] = []
    if use_fit_history:
        for entry in fit_history:
            fd = _parse_uk_or_iso_date(entry.get('fitted_at') or '')
            if fd is not None:
                timeline.append((fd, entry))
        if current_slices:
            cd = _parse_uk_or_iso_date(current_fitted_at_stashed)
            if cd is not None:
                timeline.append((cd, {
                    'fitted_at': current_fitted_at_stashed,
                    'slices': current_slices,
                    'hdi_level': level,
                }))
        timeline.sort(key=lambda t: t[0])

    # Parse and sort bin dates ascending, preserving original keys
    parsed_dates: List[tuple[date, str]] = []
    for d_str in dates:
        pd = _parse_uk_or_iso_date(d_str)
        if pd is not None:
            parsed_dates.append((pd, d_str))
    parsed_dates.sort(key=lambda t: t[0])

    def _band_from_alpha_beta(
        alpha: float,
        beta: float,
        fitted_at: str,
        source_slice: str,
        source_model: str,
        evidence_grade: int,
        band_level: float,
    ) -> Optional[RateBand]:
        if alpha is None or beta is None or alpha <= 0 or beta <= 0:
            return None
        hdi_lo, hdi_hi = _hdi_from_beta(float(alpha), float(beta), band_level)
        pmean = float(alpha) / (float(alpha) + float(beta))
        return RateBand(
            hdi_lower=float(hdi_lo),
            hdi_upper=float(hdi_hi),
            posterior_mean=pmean,
            hdi_level=band_level,
            evidence_grade=evidence_grade,
            fitted_at=fitted_at or '',
            source_slice=source_slice,
            source_model=source_model,
        )

    # ── Per-bin resolution ────────────────────────────────────────────
    ti = 0
    current_timeline_entry: Optional[Dict[str, Any]] = None
    for bin_date, orig_key in parsed_dates:
        # Advance through fit_history to the latest entry on or before bin_date
        if use_fit_history:
            while ti < len(timeline) and timeline[ti][0] <= bin_date:
                current_timeline_entry = timeline[ti][1]
                ti += 1

        band: Optional[RateBand] = None

        # Try fit_history entry first
        if current_timeline_entry is not None:
            slices = current_timeline_entry.get('slices') or {}
            entry_slice, resolved_key = _find_slice_with_fallback(slices, target_slice_key)
            if entry_slice is not None:
                alpha = entry_slice.get('alpha')
                beta = entry_slice.get('beta')
                if alpha is not None and beta is not None and alpha > 0 and beta > 0:
                    entry_level = float(current_timeline_entry.get('hdi_level', level) or level)
                    # Prefer pre-computed HDI if present in the slice
                    hdi_lo = entry_slice.get('p_hdi_lower')
                    hdi_hi = entry_slice.get('p_hdi_upper')
                    if hdi_lo is None or hdi_hi is None:
                        hdi_lo, hdi_hi = _hdi_from_beta(float(alpha), float(beta), entry_level)
                    band = RateBand(
                        hdi_lower=float(hdi_lo),
                        hdi_upper=float(hdi_hi),
                        posterior_mean=float(alpha) / (float(alpha) + float(beta)),
                        hdi_level=entry_level,
                        evidence_grade=int(entry_slice.get('evidence_grade', 0) or 0),
                        fitted_at=str(current_timeline_entry.get('fitted_at') or ''),
                        source_slice=resolved_key or target_slice_key,
                        source_model='bayesian',
                    )

        # Fall back to current promoted alpha/beta
        if band is None and current_alpha > 0 and current_beta > 0:
            band = _band_from_alpha_beta(
                alpha=current_alpha,
                beta=current_beta,
                fitted_at=current_fitted or '',
                source_slice='',
                source_model=current_source or 'unknown',
                evidence_grade=0,
                band_level=level,
            )

        result[orig_key] = band

    return result


def rate_band_to_dict(band: RateBand) -> Dict[str, Any]:
    """Serialise a RateBand for the BE response payload."""
    return {
        'hdi_lower': round(band.hdi_lower, 6),
        'hdi_upper': round(band.hdi_upper, 6),
        'posterior_mean': round(band.posterior_mean, 6),
        'hdi_level': band.hdi_level,
        'evidence_grade': band.evidence_grade,
        'fitted_at': band.fitted_at,
        'source_slice': band.source_slice,
        'source_model': band.source_model,
    }


# ── Back-compat aliases (doc 49 Part B §6) ──────────────────────────────

# The original API used EpistemicBand / resolve_epistemic_bands /
# epistemic_band_to_dict. Kept as aliases so existing imports keep working.
EpistemicBand = RateBand
resolve_epistemic_bands = resolve_rate_bands
epistemic_band_to_dict = rate_band_to_dict
