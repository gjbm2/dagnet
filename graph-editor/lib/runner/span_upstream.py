"""
Phase B upstream evidence conditioning (doc 29d §Policy B).

Extracts observed arrivals at x from upstream edge evidence, for use
as conditioning data on the ingress carrier model.  The evidence
conditions the model — it does not replace it.

Contract:
- For each upstream edge u→x, y on that edge's evidence = observed
  arrivals at x via that edge
- At joins (multiple edges into x), sum the contributions
- Output: per-cohort (tau, x_obs) observation pairs that condition
  the ingress carrier's IS draws
- Any non-empty evidence is useful (it tightens the posterior)

See doc 29d §Reconstruction Mechanics and §Evidence Compatibility.
"""

from __future__ import annotations

from typing import Dict, List, Any, Optional, Tuple


def extract_upstream_observations(
    graph: Dict[str, Any],
    anchor_node_id: str,
    x_node_id: str,
    per_edge_frames: Dict[str, List[Dict[str, Any]]],
) -> Optional[Dict[str, List[Tuple[int, float]]]]:
    """Extract observed arrivals at x from upstream edge evidence.

    For each (anchor_day, snapshot_date) pair, sums y across all edges
    entering x to get total observed arrivals at x at that tau.

    Args:
        graph: graph dict with edges and nodes.
        anchor_node_id: anchor node (a).
        x_node_id: query start node (x).
        per_edge_frames: mapping from edge UUID to derived cohort
            maturity frames.

    Returns:
        Dict mapping anchor_day (str) to a sorted list of (tau, x_obs)
        tuples.  None if x = a or no path exists or no evidence.
    """
    if anchor_node_id == x_node_id:
        return None

    from .span_kernel import _build_span_topology

    topo = _build_span_topology(graph, anchor_node_id, x_node_id)
    if topo is None:
        return None

    def _edge_uuid(e_dict: Dict) -> str:
        return str(e_dict.get('uuid', e_dict.get('id', '')))

    # Find edges entering x on the a→x path
    x_incident_edges: List[str] = []
    for from_id, to_id, e_data in topo.edge_list:
        if to_id == x_node_id:
            x_incident_edges.append(_edge_uuid(e_data))

    if not x_incident_edges:
        return None

    # Check at least one incident edge has evidence
    has_any = any(
        per_edge_frames.get(eid) and any(
            f.get('data_points') and len(f['data_points']) > 0
            for f in per_edge_frames[eid]
        )
        for eid in x_incident_edges
    )
    if not has_any:
        return None

    # Extract (anchor_day, snapshot_date) → sum of y across incident edges
    from datetime import date as _date

    # Index: anchor_day → { snapshot_date → total_y }
    obs_by_cohort: Dict[str, Dict[str, float]] = {}

    for eid in x_incident_edges:
        frames = per_edge_frames.get(eid, [])
        for frame in frames:
            sd = str(frame.get('snapshot_date', ''))[:10]
            if not sd:
                continue
            for dp in frame.get('data_points', []):
                ad = str(dp.get('anchor_day', ''))[:10]
                if not ad:
                    continue
                y_val = dp.get('y', 0)
                if not isinstance(y_val, (int, float)):
                    continue
                if ad not in obs_by_cohort:
                    obs_by_cohort[ad] = {}
                # Sum across incident edges for fan-in
                obs_by_cohort[ad][sd] = obs_by_cohort[ad].get(sd, 0.0) + float(y_val)

    if not obs_by_cohort:
        return None

    # Convert to (tau, x_obs) pairs per anchor_day
    result: Dict[str, List[Tuple[int, float]]] = {}
    for ad, sd_map in obs_by_cohort.items():
        try:
            ad_date = _date.fromisoformat(ad)
        except (ValueError, TypeError):
            continue
        pairs: List[Tuple[int, float]] = []
        for sd, x_obs in sorted(sd_map.items()):
            try:
                sd_date = _date.fromisoformat(sd)
            except (ValueError, TypeError):
                continue
            tau = (sd_date - ad_date).days
            if tau >= 0 and x_obs >= 0:
                pairs.append((tau, x_obs))
        if pairs:
            result[ad] = sorted(pairs, key=lambda p: p[0])

    return result if result else None
