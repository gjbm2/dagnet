"""
Daily Conversions Derivation from Snapshot Data

Computes conversions attributed to each calendar date, and per-cohort
conversion rates (Y/X per anchor_day).
"""

from collections import defaultdict
from typing import List, Dict, Any
from datetime import date, datetime


def derive_daily_conversions(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Derive daily conversion counts and per-cohort conversion rates from snapshot rows.
    
    Two outputs:
      1. ``data`` – ΔY (new conversions) attributed to each retrieval date.
      2. ``rate_by_cohort`` – conversion rate (Y/X) per anchor_day, using the
         latest snapshot for each (anchor_day, slice_key).
    
    Args:
        rows: List of snapshot rows with anchor_day, retrieved_at, X, Y fields
    
    Returns:
        {
            'analysis_type': 'daily_conversions',
            'data': [{'date': str, 'conversions': int}, ...],
            'rate_by_cohort': [{'date': str, 'x': int, 'y': int, 'rate': float|None}, ...],
            'total_conversions': int,
            'date_range': {'from': str, 'to': str}
        }
    """
    daily_totals: Dict[date, int] = defaultdict(int)
    
    # Group by (anchor_day, slice_key).
    #
    # CRITICAL:
    # - retrieved_at deltas must be computed within a single semantic series.
    # - If multiple slices are provided (e.g. MECE channel partition), we must
    #   compute deltas per slice and then sum, rather than mixing slices together.
    by_series: Dict[tuple, List[Dict]] = defaultdict(list)
    for row in rows:
        anchor = row['anchor_day']
        if isinstance(anchor, str):
            anchor = date.fromisoformat(anchor)
        slice_key = row.get('slice_key') or ''
        by_series[(anchor, slice_key)].append(row)

    # --- Per-cohort rate: track latest snapshot per (anchor_day, slice_key) ---
    # Keyed by anchor_day → accumulated (x, y) across slices.
    cohort_xy: Dict[date, Dict[str, int]] = defaultdict(lambda: {'x': 0, 'y': 0})

    # Per-(anchor_day, age, slice_key) → latest Y at that age for that slice.
    # After the series loop, we sum across slices per (anchor_day, age).
    _y_per_series_age: Dict[tuple, int] = {}

    for (anchor_day, _slice_key), snapshots in by_series.items():
        snapshots_sorted = sorted(snapshots, key=lambda r: _parse_datetime(r['retrieved_at']))
        prev_Y = 0

        for snap in snapshots_sorted:
            retrieved = _parse_datetime(snap['retrieved_at'])

            current_Y = snap.get('y') or snap.get('Y') or 0
            delta_Y = current_Y - prev_Y

            if delta_Y > 0:
                daily_totals[retrieved.date()] += delta_Y

            prev_Y = current_Y

            # Track Y at each age for this slice (latency bands).
            age_days = (retrieved.date() - anchor_day).days
            if age_days >= 0 and isinstance(current_Y, (int, float)):
                # Last-write-wins per (anchor_day, age, slice)
                _y_per_series_age[(anchor_day, age_days, _slice_key)] = int(current_Y)

        # Latest snapshot in this series gives the most up-to-date X and Y
        latest = snapshots_sorted[-1]
        latest_x = latest.get('x') or latest.get('X') or 0
        latest_y = latest.get('y') or latest.get('Y') or 0
        cohort_xy[anchor_day]['x'] += latest_x
        cohort_xy[anchor_day]['y'] += latest_y

    # Build per-cohort cumulative Y trajectory across all slices.
    # For each (anchor_day, age), the total Y = sum of each slice's
    # latest-known Y at or before that age. This is naturally monotonic
    # because each slice's Y is cumulative and carry-forward preserves it.
    #
    # Step 1: collect all ages per cohort, and all slices per cohort.
    _cohort_slices: Dict[date, set] = defaultdict(set)
    _cohort_ages: Dict[date, set] = defaultdict(set)
    for (ad, age, sk) in _y_per_series_age:
        _cohort_slices[ad].add(sk)
        _cohort_ages[ad].add(age)

    # Step 2: for each cohort, walk ages in order. At each age, sum
    # each slice's latest Y (carry-forward from last observed age).
    cohort_y_at_age: Dict[tuple, int] = {}
    for ad in _cohort_ages:
        slices = sorted(_cohort_slices[ad])
        ages = sorted(_cohort_ages[ad])
        # Per-slice carry-forward state
        slice_latest_y: Dict[str, int] = {sk: 0 for sk in slices}
        for age in ages:
            for sk in slices:
                obs = _y_per_series_age.get((ad, age, sk))
                if obs is not None:
                    slice_latest_y[sk] = obs
            cohort_y_at_age[(ad, age)] = sum(slice_latest_y.values())
    
    total = sum(daily_totals.values())
    sorted_dates = sorted(daily_totals.keys())
    data = [
        {'date': d.isoformat(), 'conversions': count}
        for d, count in sorted(daily_totals.items())
    ]

    # Build rate_by_cohort sorted by anchor_day
    rate_by_cohort = []
    for anchor_day in sorted(cohort_xy.keys()):
        xy = cohort_xy[anchor_day]
        x_val = xy['x']
        y_val = xy['y']
        rate = y_val / x_val if x_val > 0 else None
        rate_by_cohort.append({
            'date': anchor_day.isoformat(),
            'x': x_val,
            'y': y_val,
            'rate': rate,
        })
    
    # Convert cohort_y_at_age to string-keyed for JSON serialisation
    y_at_age_out: Dict[str, Dict[str, int]] = {}
    for (ad, age), y_val in cohort_y_at_age.items():
        ad_str = ad.isoformat()
        if ad_str not in y_at_age_out:
            y_at_age_out[ad_str] = {}
        y_at_age_out[ad_str][str(age)] = y_val

    return {
        'analysis_type': 'daily_conversions',
        'data': data,
        'rate_by_cohort': rate_by_cohort,
        'cohort_y_at_age': y_at_age_out,
        'total_conversions': total,
        'date_range': {
            'from': sorted_dates[0].isoformat() if sorted_dates else None,
            'to': sorted_dates[-1].isoformat() if sorted_dates else None,
        }
    }


def _parse_datetime(val) -> datetime:
    """Parse datetime from string or return as-is if already datetime."""
    if isinstance(val, datetime):
        return val
    if isinstance(val, str):
        # Handle Z suffix and various ISO formats
        return datetime.fromisoformat(val.replace('Z', '+00:00'))
    raise ValueError(f"Cannot parse datetime from {type(val)}: {val}")
