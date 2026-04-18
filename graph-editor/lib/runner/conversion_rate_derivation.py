"""
Conversion rate derivation — doc 49 Part B.

Aggregates per-cohort k/n across time bins (day/week/month) and resolves
epistemic uncertainty bands from fit_history using as-at semantics.

Scoped to non-latency edges only (doc 49 §B.2). For latency edges the
raw k/n is incomplete for immature cohorts — the reverse trumpet story
requires separate design (doc 49 Phase 3).
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

from .epistemic_bands import resolve_rate_bands, rate_band_to_dict


def _parse_datetime(val) -> datetime:
    """Parse datetime from string or return as-is if already datetime."""
    if isinstance(val, datetime):
        return val
    if isinstance(val, str):
        return datetime.fromisoformat(val.replace('Z', '+00:00'))
    raise ValueError(f"Cannot parse datetime from {type(val)}: {val}")


def _bin_start(d: date, bin_size: str) -> date:
    """Compute the bin start date for a given cohort anchor_day.

    bin_size: 'day' | 'week' | 'month'
    - week: Monday-anchored (ISO)
    - month: first of month
    - day: the day itself
    """
    if bin_size == 'week':
        # Monday = 0
        return d - timedelta(days=d.weekday())
    if bin_size == 'month':
        return date(d.year, d.month, 1)
    return d


def derive_conversion_rate(
    rows: List[Dict[str, Any]],
    bin_size: str = 'day',
    edge: Optional[Dict[str, Any]] = None,
    temporal_mode: str = 'window',
    hdi_level: Optional[float] = None,
) -> Dict[str, Any]:
    """Derive per-bin conversion rate with rate-uncertainty bands.

    Args:
        rows: snapshot rows with anchor_day, retrieved_at, X, Y, slice_key.
        bin_size: 'day' | 'week' | 'month'. Default 'day'.
        edge: full graph edge dict. Used to resolve the promoted model
            (bayesian → analytic_be → analytic → evidence-derived Beta).
            When None, bands are omitted.
        temporal_mode: 'window' | 'cohort'. Selects which Bayes slice is
            preferred when fit_history entries are available.
        hdi_level: HDI level override; defaults to posterior.hdi_level or 0.90.

    Returns:
        {
            'analysis_type': 'conversion_rate',
            'bin_size': bin_size,
            'data': [{bin_start, bin_end, x, y, rate, epistemic?}, ...],
            'date_range': {from, to},
        }
    """
    if bin_size not in ('day', 'week', 'month'):
        raise ValueError(f"bin_size must be day|week|month, got: {bin_size}")

    # Step 1: for each (anchor_day, slice_key), take the latest snapshot
    # for that cohort — that is the final k/n for the cohort (non-latency
    # assumption: completeness = 1 by the time we look).
    by_series: Dict[tuple, List[Dict]] = defaultdict(list)
    for row in rows:
        anchor = row.get('anchor_day')
        if isinstance(anchor, str):
            anchor = date.fromisoformat(anchor)
        if anchor is None:
            continue
        sk = row.get('slice_key') or ''
        by_series[(anchor, sk)].append(row)

    # Step 2: aggregate cohort k/n by bin. Sum X and Y across all cohorts
    # and slices whose anchor_day falls in the bin. Weighted rate = Y/X.
    bin_xy: Dict[date, Dict[str, int]] = defaultdict(lambda: {'x': 0, 'y': 0})
    anchor_days_seen: set = set()
    for (anchor_day, _sk), snapshots in by_series.items():
        snapshots_sorted = sorted(snapshots, key=lambda r: _parse_datetime(r['retrieved_at']))
        latest = snapshots_sorted[-1]
        x_val = int(latest.get('x') or latest.get('X') or 0)
        y_val = int(latest.get('y') or latest.get('Y') or 0)
        bin_key = _bin_start(anchor_day, bin_size)
        bin_xy[bin_key]['x'] += x_val
        bin_xy[bin_key]['y'] += y_val
        anchor_days_seen.add(anchor_day)

    # Step 3: resolve uncertainty bands for each bin's representative date.
    # The bin_start is the reference — the fit_history entry current at or
    # before bin_start represents "what the model believed going into this
    # bin." Using bin_start (not bin_end) is the conservative choice: for
    # a week bin, we show the posterior that was available on Monday, not
    # the posterior that landed later in the week.
    sorted_bins = sorted(bin_xy.keys())
    bin_date_strs = [b.isoformat() for b in sorted_bins]
    bands = resolve_rate_bands(
        edge=edge,
        dates=bin_date_strs,
        temporal_mode=temporal_mode,
        hdi_level=hdi_level,
    )

    # Step 4: assemble per-bin response
    data: List[Dict[str, Any]] = []
    for bin_start_d in sorted_bins:
        bin_key_iso = bin_start_d.isoformat()
        xy = bin_xy[bin_start_d]
        x_val = xy['x']
        y_val = xy['y']
        rate = y_val / x_val if x_val > 0 else None

        # Compute bin_end (last day in the bin)
        if bin_size == 'day':
            bin_end_d = bin_start_d
        elif bin_size == 'week':
            bin_end_d = bin_start_d + timedelta(days=6)
        else:  # month
            # Last day of the month
            if bin_start_d.month == 12:
                next_month = date(bin_start_d.year + 1, 1, 1)
            else:
                next_month = date(bin_start_d.year, bin_start_d.month + 1, 1)
            bin_end_d = next_month - timedelta(days=1)

        entry: Dict[str, Any] = {
            'bin_start': bin_key_iso,
            'bin_end': bin_end_d.isoformat(),
            'x': x_val,
            'y': y_val,
            'rate': rate,
        }
        band = bands.get(bin_key_iso)
        if band is not None:
            entry['epistemic'] = rate_band_to_dict(band)
        data.append(entry)

    return {
        'analysis_type': 'conversion_rate',
        'bin_size': bin_size,
        'slice_key': f'{temporal_mode}()',
        'data': data,
        'date_range': {
            'from': sorted_bins[0].isoformat() if sorted_bins else None,
            'to': sorted_bins[-1].isoformat() if sorted_bins else None,
        },
        'cohort_count': len(anchor_days_seen),
    }
