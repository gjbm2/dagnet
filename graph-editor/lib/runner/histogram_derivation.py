"""
Histogram Derivation from Snapshot Data

Computes conversion lag distribution from daily snapshot deltas.
"""

from collections import defaultdict
from typing import List, Dict, Any
from datetime import date, datetime


def derive_lag_histogram(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Derive lag histogram from snapshot rows.
    
    For each anchor_day, successive snapshots show Y accumulating.
    ΔY between snapshots = conversions at that lag.
    
    Args:
        rows: List of snapshot rows with anchor_day, retrieved_at, Y fields
    
    Returns:
        {
            'analysis_type': 'lag_histogram',
            'data': [{'lag_days': int, 'conversions': int, 'pct': float}, ...],
            'total_conversions': int,
            'cohorts_analysed': int
        }
    """
    # Group by (anchor_day, slice_key).
    #
    # CRITICAL:
    # - retrieved_at deltas must be computed within a single semantic series.
    # - If multiple slices are provided (e.g. MECE channel partition), compute deltas
    #   per slice then aggregate, rather than mixing slices (which corrupts deltas).
    by_series: Dict[tuple, List[Dict]] = defaultdict(list)
    for row in rows:
        anchor = row['anchor_day']
        if isinstance(anchor, str):
            anchor = date.fromisoformat(anchor)
        slice_key = row.get('slice_key') or ''
        by_series[(anchor, slice_key)].append(row)
    
    lag_bins: Dict[int, int] = defaultdict(int)
    
    for (anchor_day, _slice_key), snapshots in by_series.items():
        # Sort by retrieved_at
        snapshots_sorted = sorted(snapshots, key=lambda r: _parse_datetime(r['retrieved_at']))
        prev_Y = 0
        
        for snap in snapshots_sorted:
            retrieved = _parse_datetime(snap['retrieved_at'])
            
            lag = (retrieved.date() - anchor_day).days
            current_Y = snap.get('y') or snap.get('Y') or 0
            delta_Y = current_Y - prev_Y
            
            if delta_Y > 0:
                lag_bins[lag] += delta_Y
            
            prev_Y = current_Y
    
    total = sum(lag_bins.values())
    data = [
        {
            'lag_days': lag,
            'conversions': count,
            'pct': round(count / total, 4) if total > 0 else 0,
        }
        for lag, count in sorted(lag_bins.items())
    ]
    
    return {
        'analysis_type': 'lag_histogram',
        'data': data,
        'total_conversions': total,
        'cohorts_analysed': len(by_series),
    }


def _parse_datetime(val) -> datetime:
    """Parse datetime from string or return as-is if already datetime."""
    if isinstance(val, datetime):
        return val
    if isinstance(val, str):
        # Handle Z suffix and various ISO formats
        return datetime.fromisoformat(val.replace('Z', '+00:00'))
    raise ValueError(f"Cannot parse datetime from {type(val)}: {val}")
