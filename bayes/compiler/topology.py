"""
Topology analyser: graph_snapshot → TopologyAnalysis.

Walks the graph, identifies:
  - Anchor (start) node
  - Solo edges vs branch groups
  - Paths from anchor to each edge (for completeness)
  - Path latency composition via FW (fixed point estimates in Phase A)
  - Join-node moment-matched collapse
  - Topology fingerprint
"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict

from .types import (
    TopologyAnalysis,
    EdgeTopology,
    BranchGroup,
    ConditionalPop,
    PathLatency,
)
from .completeness import (
    fw_chain,
    derive_latency_prior,
    moment_matched_collapse,
)


def analyse_topology(graph_snapshot: dict) -> TopologyAnalysis:
    """Analyse graph structure and produce the topology IR.

    The graph_snapshot is the raw graph JSON as sent by the FE:
      - nodes[]: array of {uuid, id, entry?, absorbing?, ...}
      - edges[]: array of {uuid, from, to, p?, ...}
    """
    diagnostics: list[str] = []

    nodes = graph_snapshot.get("nodes", [])
    edges_raw = graph_snapshot.get("edges", [])

    # 1. Find anchor node
    anchor_node_id = _find_anchor(nodes, diagnostics)

    # 2. Build adjacency
    node_by_uuid = {n["uuid"]: n for n in nodes}
    outgoing: dict[str, list[dict]] = defaultdict(list)
    incoming: dict[str, list[dict]] = defaultdict(list)

    for e in edges_raw:
        outgoing[e["from"]].append(e)
        incoming[e["to"]].append(e)

    # 3. Classify edges: solo vs branch group
    branch_groups: dict[str, BranchGroup] = {}
    edge_to_group: dict[str, str] = {}

    for source_uuid, out_edges in outgoing.items():
        if len(out_edges) > 1:
            group_id = f"bg_{source_uuid[:12]}"
            source_node_data = node_by_uuid.get(source_uuid, {})

            # Infer exhaustiveness from graph structure.
            #
            # Case nodes (A/B test splits): always exhaustive — every user
            # is assigned to exactly one variant by construction.
            #
            # Normal nodes: exhaustive iff every sibling's target node has
            # an event_id (all outcomes are measurable). If any target lacks
            # an event, that path is unmeasurable (abandonment, leakage) and
            # the Dirichlet needs a dropout component to absorb the residual.
            if source_node_data.get("type") == "case":
                is_exhaustive = True
            else:
                is_exhaustive = all(
                    bool(node_by_uuid.get(e["to"], {}).get("event_id"))
                    for e in out_edges
                )

            branch_groups[group_id] = BranchGroup(
                group_id=group_id,
                source_node=source_uuid,
                sibling_edge_ids=[e["uuid"] for e in out_edges],
                is_exhaustive=is_exhaustive,
            )
            for e in out_edges:
                edge_to_group[e["uuid"]] = group_id

    # 4. Build edge topology objects
    edges: dict[str, EdgeTopology] = {}

    for e in edges_raw:
        edge_id = e["uuid"]
        p_block = e.get("p") or {}
        latency = p_block.get("latency") or {}

        has_latency = bool(
            latency.get("latency_parameter")
            or (latency.get("mu") is not None and latency.get("sigma") is not None)
        )

        onset = float(latency.get("onset_delta_days") or 0)

        # Derive latency prior from available data.
        # Default: mu=0 (median 1 day), sigma=0.5 (moderate).
        # The t95 fallback below handles most cases where lag data
        # is missing; this default is the last resort.
        mu_prior = 0.0
        sigma_prior = 0.5
        if has_latency:
            mu_from_param = latency.get("mu")
            sigma_from_param = latency.get("sigma")
            median_lag = latency.get("median_lag_days")
            mean_lag = latency.get("mean_lag_days")

            # Priority: (1) mu/sigma from graph edge (stats pass output),
            # (2) derive from median/mean, (3) t95 fallback.
            # Doc 19: crude derive_latency_prior was preferred over graph
            # mu/sigma, causing three-way prior discrepancy. Fixed to
            # prefer the stats pass output which includes t95 improvement.
            if mu_from_param is not None and sigma_from_param is not None:
                mu_prior = float(mu_from_param)
                sigma_prior = float(sigma_from_param)
            elif (median_lag is not None and mean_lag is not None
                    and float(median_lag) > 0 and float(mean_lag) > 0):
                mu_prior, sigma_prior = derive_latency_prior(
                    float(median_lag), float(mean_lag), onset,
                )
            else:
                # Fallback: derive from t95 if available.
                t95 = latency.get("t95")
                if t95 is not None and float(t95) > onset:
                    import math
                    assumed_sigma = 0.7
                    t95_shifted = max(float(t95) - onset, 0.5)
                    mu_prior = math.log(t95_shifted) - 1.645 * assumed_sigma
                    sigma_prior = assumed_sigma

        group_id = edge_to_group.get(edge_id)

        # t95 from stats pass (onset + exp(mu + 1.645*sigma)).
        # User horizon override on graph edge takes priority via computeT95.
        t95_raw = latency.get("t95")
        t95_days = float(t95_raw) if t95_raw is not None and float(t95_raw) > 0 else None
        path_t95_raw = latency.get("path_t95")
        path_t95_days = float(path_t95_raw) if path_t95_raw is not None and float(path_t95_raw) > 0 else None

        # conditional_p: independent probability populations (doc 14 §6)
        _cond_p_raw = e.get("conditional_p", [])
        _cond_p: list[ConditionalPop] = []
        if isinstance(_cond_p_raw, list):
            for cp in _cond_p_raw:
                if isinstance(cp, dict) and cp.get("condition"):
                    _cp_p = cp.get("p", {}) if isinstance(cp.get("p"), dict) else {}
                    _cp_lat = _cp_p.get("latency", {}) if isinstance(_cp_p.get("latency"), dict) else {}
                    _cp_has_lat = bool(_cp_lat.get("latency_parameter"))
                    _cond_p.append(ConditionalPop(
                        condition=cp["condition"],
                        param_id=_cp_p.get("id", ""),
                        p_mean=float(_cp_p.get("mean", 0.5)),
                        has_latency=_cp_has_lat,
                        onset_delta_days=float(_cp_lat.get("onset_delta_days", 0.0)),
                        mu_prior=float(_cp_lat.get("mu", 0.0)),
                        sigma_prior=float(_cp_lat.get("sigma", 0.5)),
                    ))

        edges[edge_id] = EdgeTopology(
            edge_id=edge_id,
            from_node=e["from"],
            to_node=e["to"],
            param_id=p_block.get("id", ""),
            is_solo=(group_id is None),
            branch_group_id=group_id,
            has_latency=has_latency,
            onset_delta_days=onset,
            mu_prior=mu_prior,
            sigma_prior=sigma_prior,
            t95_days=t95_days,
            path_t95_days=path_t95_days,
            conditional_p=_cond_p,
        )

    # 5. Topological sort (BFS from anchor)
    topo_order = _topo_sort(edges_raw, anchor_node_id)

    # 6. Compute paths from anchor to each edge and path latency
    _compute_paths(
        anchor_node_id, edges, topo_order, incoming, outgoing,
        graph_snapshot, diagnostics,
    )

    # 7. Join nodes (in-degree > 1)
    from .types import JoinNode
    join_nodes: dict[str, JoinNode] = {}
    for node_uuid, in_edges in incoming.items():
        if len(in_edges) >= 2:
            in_edge_ids = [ie["uuid"] for ie in in_edges if ie["uuid"] in edges]
            if len(in_edge_ids) >= 2:
                join_nodes[node_uuid] = JoinNode(
                    node_id=node_uuid,
                    inbound_edge_ids=in_edge_ids,
                )

    # 8. Fingerprint
    fingerprint = _compute_fingerprint(anchor_node_id, edges, branch_groups)

    return TopologyAnalysis(
        anchor_node_id=anchor_node_id,
        edges=edges,
        branch_groups=branch_groups,
        topo_order=topo_order,
        join_nodes=join_nodes,
        fingerprint=fingerprint,
        diagnostics=diagnostics,
    )


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------

def _find_anchor(nodes: list[dict], diagnostics: list[str]) -> str:
    """Find the anchor (start) node. Returns its UUID."""
    anchors = [n for n in nodes if (n.get("entry") or {}).get("is_start")]
    if len(anchors) == 1:
        return anchors[0]["uuid"]
    if not anchors:
        diagnostics.append("WARN: no anchor node (entry.is_start) found, using first node")
        return nodes[0]["uuid"] if nodes else ""
    diagnostics.append(f"WARN: {len(anchors)} anchor nodes found, using first")
    return anchors[0]["uuid"]


def _topo_sort(edges_raw: list[dict], anchor_node_id: str) -> list[str]:
    """BFS topological sort of edges starting from anchor."""
    outgoing: dict[str, list[dict]] = defaultdict(list)
    for e in edges_raw:
        outgoing[e["from"]].append(e)

    visited_edges: list[str] = []
    visited_nodes: set[str] = {anchor_node_id}
    queue = [anchor_node_id]

    while queue:
        node = queue.pop(0)
        for e in outgoing.get(node, []):
            visited_edges.append(e["uuid"])
            if e["to"] not in visited_nodes:
                visited_nodes.add(e["to"])
                queue.append(e["to"])

    return visited_edges


def _compute_paths(
    anchor_node_id: str,
    edges: dict[str, EdgeTopology],
    topo_order: list[str],
    incoming: dict[str, list[dict]],
    outgoing: dict[str, list[dict]],
    graph_snapshot: dict,
    diagnostics: list[str],
) -> None:
    """Compute path from anchor to each edge's target and path latency via FW.

    Uses DP over topological order. At join nodes (in-degree > 1),
    performs moment-matched collapse of inbound path latencies.
    """
    # node → (PathLatency, list[edge_ids])
    node_path: dict[str, PathLatency] = {
        anchor_node_id: PathLatency(),
    }
    node_path_edges: dict[str, list[str]] = {
        anchor_node_id: [],
    }
    # node → list of alternative paths (each a list of edge_ids).
    # For non-join nodes: single alternative = [path_edge_ids].
    # For join nodes: one alternative per inbound path.
    node_path_alts: dict[str, list[list[str]]] = {
        anchor_node_id: [[]],
    }

    # Traffic weights for join-node collapse (use p.mean from graph if available)
    edge_p_mean: dict[str, float] = {}
    for e in graph_snapshot.get("edges", []):
        p_block = e.get("p") or {}
        p_mean = p_block.get("mean")
        if p_mean is not None and isinstance(p_mean, (int, float)):
            edge_p_mean[e["uuid"]] = float(p_mean)

    for edge_id in topo_order:
        et = edges.get(edge_id)
        if et is None:
            continue

        from_node = et.from_node
        to_node = et.to_node

        # Ensure source node has a path (may not if unreachable)
        if from_node not in node_path:
            node_path[from_node] = PathLatency()
            node_path_edges[from_node] = []
            diagnostics.append(
                f"WARN: node {from_node[:8]}… not reachable from anchor"
            )

        source_path = node_path[from_node]
        source_edges = node_path_edges[from_node]
        source_alts = node_path_alts.get(from_node, [source_edges])

        # Store path from anchor to this edge's target
        et.path_edge_ids = source_edges + [edge_id]

        # Propagate path alternatives (for join-downstream mixture CDFs)
        et.path_alternatives = [alt + [edge_id] for alt in source_alts]

        # path_sigma_ax = sigma of A→X path (for τ_cohort)
        et.path_sigma_ax = source_path.path_sigma

        # Compute path latency from anchor to this edge's target (A→...→X→Y)
        if et.has_latency:
            # Collect (mu, sigma) for each latency edge on the full path
            chain_components = []
            for pid in et.path_edge_ids:
                pe = edges.get(pid)
                if pe and pe.has_latency:
                    chain_components.append((pe.mu_prior, pe.sigma_prior))

            if chain_components:
                composed = fw_chain(chain_components)
                total_onset = sum(
                    edges[pid].onset_delta_days
                    for pid in et.path_edge_ids
                    if pid in edges and edges[pid].has_latency
                )
                et.path_latency = PathLatency(
                    path_delta=total_onset,
                    path_mu=composed.mu,
                    path_sigma=composed.sigma,
                )
            else:
                et.path_latency = PathLatency(
                    path_delta=et.onset_delta_days,
                    path_mu=et.mu_prior,
                    path_sigma=et.sigma_prior,
                )
        else:
            # Non-latency edge: inherit source node's path latency
            et.path_latency = PathLatency(
                path_delta=source_path.path_delta,
                path_mu=source_path.path_mu,
                path_sigma=source_path.path_sigma,
            )

        # Update target node's path (DP step)
        if to_node not in node_path:
            # First path to this node — store directly
            node_path[to_node] = et.path_latency
            node_path_edges[to_node] = et.path_edge_ids
            # Propagate alternatives from upstream (handles nested joins)
            node_path_alts[to_node] = et.path_alternatives if et.path_alternatives else [et.path_edge_ids]
        else:
            # Join node — moment-matched collapse of all inbound paths
            # Collect all inbound edges that have reached this node
            inbound_edges = incoming.get(to_node, [])
            inbound_data = []
            all_inbound_paths: list[list[str]] = []
            for ie in inbound_edges:
                ie_id = ie["uuid"]
                ie_topo = edges.get(ie_id)
                if ie_topo is None or not ie_topo.path_edge_ids:
                    continue  # not yet processed
                pl = ie_topo.path_latency
                weight = edge_p_mean.get(ie_id, 1.0)
                inbound_data.append((pl.path_delta, pl.path_mu, pl.path_sigma, weight))
                # Collect ALL alternatives from this inbound edge
                # (handles nested joins — each inbound may itself have
                # multiple alternatives from an upstream join)
                if ie_topo.path_alternatives:
                    all_inbound_paths.extend(ie_topo.path_alternatives)
                else:
                    all_inbound_paths.append(ie_topo.path_edge_ids)

            if len(inbound_data) >= 2:
                d_mix, mu_mix, sigma_mix = moment_matched_collapse(inbound_data)
                node_path[to_node] = PathLatency(
                    path_delta=d_mix,
                    path_mu=mu_mix,
                    path_sigma=sigma_mix,
                )
                # Use the path edges from the highest-weight inbound
                # (for backward-compat with code that reads path_edge_ids)
                best_ie = max(
                    [(ie["uuid"], edge_p_mean.get(ie["uuid"], 1.0))
                     for ie in inbound_edges if ie["uuid"] in edges],
                    key=lambda x: x[1],
                    default=None,
                )
                if best_ie:
                    ie_topo = edges.get(best_ie[0])
                    if ie_topo:
                        node_path_edges[to_node] = ie_topo.path_edge_ids
                # Store ALL inbound paths as alternatives for mixture CDF
                node_path_alts[to_node] = all_inbound_paths
                diagnostics.append(
                    f"INFO: join at node {to_node[:8]}…, "
                    f"{len(inbound_data)} inbound paths → "
                    f"{len(all_inbound_paths)} alternatives"
                )
            else:
                # Only one inbound processed so far — update if this path is better
                node_path[to_node] = et.path_latency
                node_path_edges[to_node] = et.path_edge_ids
                node_path_alts[to_node] = [et.path_edge_ids]


def _compute_fingerprint(
    anchor_node_id: str,
    edges: dict[str, EdgeTopology],
    branch_groups: dict[str, BranchGroup],
) -> str:
    """Structural fingerprint — changes when topology changes, not when evidence changes."""
    data = {
        "anchor": anchor_node_id,
        "edges": sorted([
            {
                "id": e.edge_id,
                "from": e.from_node,
                "to": e.to_node,
                "solo": e.is_solo,
                "group": e.branch_group_id,
            }
            for e in edges.values()
        ], key=lambda x: x["id"]),
        "groups": sorted([
            {
                "id": g.group_id,
                "source": g.source_node,
                "siblings": sorted(g.sibling_edge_ids),
                "exhaustive": g.is_exhaustive,
            }
            for g in branch_groups.values()
        ], key=lambda x: x["id"]),
    }
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()[:16]
