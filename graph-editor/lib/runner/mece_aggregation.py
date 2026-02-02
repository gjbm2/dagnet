"""
MECE Aggregation for Snapshot Data

Aggregates MECE (Mutually Exclusive, Collectively Exhaustive) slices
into a single uncontexted result.

Used by analytics to combine context-sliced snapshot data.
"""

from collections import defaultdict
from typing import List, Dict, Any


def aggregate_mece_slices(slices: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Aggregate MECE slices into uncontexted totals.
    
    For each anchor_day:
    - X and Y are summed across slices
    - A is summed if present
    - Latency is weighted by X (not simple mean)
    
    Args:
        slices: List of slice dicts, each with:
            - slice_key: The context slice identifier
            - rows: List of row dicts with anchor_day, X, Y, and optionally latency
    
    Returns:
        List of aggregated rows (one per anchor_day)
    """
    if not slices:
        return []
    
    # Group by anchor_day
    by_day: Dict[str, Dict[str, Any]] = defaultdict(lambda: {
        'X': 0,
        'Y': 0,
        'A': 0,
        'has_A': False,
        # For weighted latency
        'weighted_median_lag': 0.0,
        'weighted_mean_lag': 0.0,
        'weighted_anchor_median_lag': 0.0,
        'weighted_anchor_mean_lag': 0.0,
        'latency_weight': 0,  # Sum of X for rows with latency
    })
    
    for slice_data in slices:
        for row in slice_data.get('rows', []):
            anchor_day = row.get('anchor_day')
            if not anchor_day:
                continue
            
            day_data = by_day[anchor_day]
            
            # Sum X and Y
            x_val = row.get('X', 0) or 0
            y_val = row.get('Y', 0) or 0
            day_data['X'] += x_val
            day_data['Y'] += y_val
            
            # Sum A if present
            a_val = row.get('A')
            if a_val is not None:
                day_data['A'] += a_val
                day_data['has_A'] = True
            
            # Weighted latency contribution
            median_lag = row.get('median_lag_days')
            mean_lag = row.get('mean_lag_days')
            anchor_median = row.get('anchor_median_lag_days')
            anchor_mean = row.get('anchor_mean_lag_days')
            
            if median_lag is not None or mean_lag is not None:
                weight = x_val if x_val > 0 else 1
                day_data['latency_weight'] += weight
                
                if median_lag is not None:
                    day_data['weighted_median_lag'] += weight * median_lag
                if mean_lag is not None:
                    day_data['weighted_mean_lag'] += weight * mean_lag
                if anchor_median is not None:
                    day_data['weighted_anchor_median_lag'] += weight * anchor_median
                if anchor_mean is not None:
                    day_data['weighted_anchor_mean_lag'] += weight * anchor_mean
    
    # Build result
    result = []
    for anchor_day in sorted(by_day.keys()):
        day_data = by_day[anchor_day]
        
        row: Dict[str, Any] = {
            'anchor_day': anchor_day,
            'X': day_data['X'],
            'Y': day_data['Y'],
        }
        
        if day_data['has_A']:
            row['A'] = day_data['A']
        
        # Compute weighted average latency
        if day_data['latency_weight'] > 0:
            weight = day_data['latency_weight']
            
            if day_data['weighted_median_lag'] > 0:
                row['median_lag_days'] = day_data['weighted_median_lag'] / weight
            if day_data['weighted_mean_lag'] > 0:
                row['mean_lag_days'] = day_data['weighted_mean_lag'] / weight
            if day_data['weighted_anchor_median_lag'] > 0:
                row['anchor_median_lag_days'] = day_data['weighted_anchor_median_lag'] / weight
            if day_data['weighted_anchor_mean_lag'] > 0:
                row['anchor_mean_lag_days'] = day_data['weighted_anchor_mean_lag'] / weight
        
        result.append(row)
    
    return result
