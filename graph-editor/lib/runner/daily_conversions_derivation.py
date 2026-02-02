"""
Daily Conversions Derivation from Snapshot Data

Computes conversions attributed to each calendar date.
"""

from collections import defaultdict
from typing import List, Dict, Any
from datetime import date, datetime


def derive_daily_conversions(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Derive daily conversion counts from snapshot rows.
    
    For each cohort, ΔY between snapshots = conversions attributed to that snapshot date.
    
    Args:
        rows: List of snapshot rows with anchor_day, retrieved_at, Y fields
    
    Returns:
        {
            'analysis_type': 'daily_conversions',
            'data': [{'date': str, 'conversions': int}, ...],
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
    
    total = sum(daily_totals.values())
    sorted_dates = sorted(daily_totals.keys())
    data = [
        {'date': d.isoformat(), 'conversions': count}
        for d, count in sorted(daily_totals.items())
    ]
    
    return {
        'analysis_type': 'daily_conversions',
        'data': data,
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
