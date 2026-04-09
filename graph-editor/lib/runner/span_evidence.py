"""
Span-level evidence composition for multi-hop cohort maturity.

Takes per-edge frame results from derive_cohort_maturity() and composes
them into a single span-level frame set.  The denominator comes from
x-incident edges, the numerator from y-incident edges.

This is Phase A, Step A.1.  See doc 29c §Evidence Composition.

Design rules:
- For x = a, denominator carrier is anchor population `a`
- For x ≠ a, denominator carrier is arrivals at x from x-incident edges
- Numerator is arrivals at y, summed across y-incident edges (fan-in)
- Composed frames align on (anchor_day, snapshot_date) after existing
  daily interpolation
- Evidence composition is exact for all topologies (branching at x,
  fan-in at y)
"""

from typing import List, Dict, Any, Optional


def compose_path_maturity_frames(
    per_edge_results: List[Dict[str, Any]],
    query_from_node: str,
    query_to_node: str,
    anchor_node: Optional[str] = None,
) -> Dict[str, Any]:
    """Compose per-edge cohort maturity frames into span-level frames.

    Args:
        per_edge_results: List of dicts, each containing:
            - 'path_role': 'first', 'last', 'intermediate', 'only'
            - 'from_node': edge's from-node ID
            - 'to_node': edge's to-node ID
            - 'frames': list of frame dicts from derive_cohort_maturity
        query_from_node: the x node (query start / denominator)
        query_to_node: the y node (query end / numerator)
        anchor_node: the a node (anchor / cohort definition).
            When x = a, denominator uses the `a` field.

    Returns:
        Result dict in the same schema as derive_cohort_maturity output:
        {
            "analysis_type": "cohort_maturity_v2",
            "frames": [...],
            "anchor_range": {...},
            "sweep_range": {...},
            "cohorts_analysed": int,
        }

    For single-edge (path_role='only'), returns the edge's own frames
    unchanged (parity with v1).
    """
    if not per_edge_results:
        return _empty_result()

    # ── Single-edge fast path (parity with v1) ────────────────────────
    if len(per_edge_results) == 1 and per_edge_results[0].get('path_role') == 'only':
        result = dict(per_edge_results[0].get('derivation_result', {}))
        result['analysis_type'] = 'cohort_maturity_v2'
        return result

    # ── Identify x-incident and y-incident edges ─────────────────────
    x_from_a = anchor_node is not None and query_from_node == anchor_node

    x_edges = []  # edges whose from_node is x (denominator source)
    y_edges = []  # edges whose to_node is y (numerator source)

    for entry in per_edge_results:
        role = entry.get('path_role', '')
        from_n = entry.get('from_node', '')
        to_n = entry.get('to_node', '')

        # x-incident: edges leaving x
        if from_n == query_from_node or role == 'first':
            x_edges.append(entry)
        # y-incident: edges entering y
        if to_n == query_to_node or role == 'last':
            y_edges.append(entry)

    if not x_edges or not y_edges:
        return _empty_result()

    # ── Build lookup: (anchor_day, snapshot_date) → {x, y, a} ────────
    # x from x-incident edges, y from y-incident edges
    composed: Dict[str, Dict[str, Dict[str, float]]] = {}
    # composed[snapshot_date][anchor_day] = {'x': ..., 'y': ..., 'a': ...}

    # Extract denominator (x) from x-incident edge frames
    for edge_entry in x_edges:
        frames = _get_frames(edge_entry)
        for frame in frames:
            sd = frame.get('snapshot_date', '')
            if sd not in composed:
                composed[sd] = {}
            for dp in frame.get('data_points', []):
                ad = dp.get('anchor_day', '')
                if ad not in composed[sd]:
                    composed[sd][ad] = {'x': 0.0, 'y': 0.0, 'a': 0.0}
                entry = composed[sd][ad]
                if x_from_a:
                    # When x = a, use anchor population as denominator
                    a_val = dp.get('a', 0)
                    if isinstance(a_val, (int, float)) and a_val > entry['a']:
                        entry['a'] = float(a_val)
                    # Also set x = a for consistency
                    if float(a_val) > entry['x']:
                        entry['x'] = float(a_val)
                else:
                    # When x ≠ a, use x field from x-incident edges.
                    # Take max across edges (most complete observation).
                    x_val = dp.get('x', 0)
                    if isinstance(x_val, (int, float)) and float(x_val) > entry['x']:
                        entry['x'] = float(x_val)
                    a_val = dp.get('a', 0)
                    if isinstance(a_val, (int, float)) and float(a_val) > entry['a']:
                        entry['a'] = float(a_val)

    # Extract numerator (y) from y-incident edge frames
    for edge_entry in y_edges:
        frames = _get_frames(edge_entry)
        for frame in frames:
            sd = frame.get('snapshot_date', '')
            for dp in frame.get('data_points', []):
                ad = dp.get('anchor_day', '')
                if sd in composed and ad in composed[sd]:
                    # Sum y across y-incident edges (fan-in at y)
                    y_val = dp.get('y', 0)
                    if isinstance(y_val, (int, float)):
                        composed[sd][ad]['y'] += float(y_val)

    # ── Build composed frames ─────────────────────────────────────────
    all_anchor_days = set()
    for sd_data in composed.values():
        all_anchor_days.update(sd_data.keys())
    sorted_anchor_days = sorted(all_anchor_days)
    sorted_snapshot_dates = sorted(composed.keys())

    frames: List[Dict[str, Any]] = []
    for sd in sorted_snapshot_dates:
        sd_data = composed[sd]
        data_points = []
        total_y = 0
        for ad in sorted_anchor_days:
            if ad in sd_data:
                vals = sd_data[ad]
                x_val = vals['x']
                y_val = vals['y']
                a_val = vals['a']
                rate = y_val / x_val if x_val > 0 else 0.0
                data_points.append({
                    'anchor_day': ad,
                    'y': y_val,
                    'x': x_val,
                    'a': a_val,
                    'rate': round(rate, 6),
                    'median_lag_days': None,
                    'mean_lag_days': None,
                    'onset_delta_days': None,
                })
                total_y += y_val
        frames.append({
            'snapshot_date': sd,
            'data_points': data_points,
            'total_y': total_y,
        })

    return {
        'analysis_type': 'cohort_maturity_v2',
        'frames': frames,
        'anchor_range': {
            'from': sorted_anchor_days[0] if sorted_anchor_days else None,
            'to': sorted_anchor_days[-1] if sorted_anchor_days else None,
        },
        'sweep_range': {
            'from': sorted_snapshot_dates[0] if sorted_snapshot_dates else None,
            'to': sorted_snapshot_dates[-1] if sorted_snapshot_dates else None,
        },
        'cohorts_analysed': len(sorted_anchor_days),
    }


def _get_frames(edge_entry: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Extract frames from an edge entry."""
    dr = edge_entry.get('derivation_result', {})
    return dr.get('frames', [])


def _empty_result() -> Dict[str, Any]:
    return {
        'analysis_type': 'cohort_maturity_v2',
        'frames': [],
        'anchor_range': {'from': None, 'to': None},
        'sweep_range': {'from': None, 'to': None},
        'cohorts_analysed': 0,
    }
