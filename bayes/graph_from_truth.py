"""
Generate a complete graph + entity files from a truth file.

The truth file is the single source of truth for a synthetic test graph.
This module generates:
  - Graph JSON (nodes, edges, UUIDs, layout, metadata)
  - Node YAML files (one per node)
  - Event YAML files (one per measurable node)
  - Dropout nodes + complement edges (mass conservation)

Usage:
    from graph_from_truth import generate_graph_artefacts
    generate_graph_artefacts(truth, data_repo)
"""

from __future__ import annotations

import json
import os
import uuid
import yaml
from datetime import datetime
from typing import Any


def generate_graph_artefacts(
    truth: dict,
    data_repo: str,
    graph_name: str | None = None,
) -> str:
    """Generate graph JSON + entity files from a truth file.

    Returns the path to the generated graph JSON.
    """
    graph_cfg = truth.get("graph", {})
    name = graph_name or graph_cfg.get("name", "synth-unnamed")
    description = graph_cfg.get("description", "")

    nodes_cfg = truth.get("nodes", {})
    edges_cfg = truth.get("edges", {})
    sim_cfg = truth.get("simulation", {})

    # Prefix for all IDs in this graph
    prefix = name.replace("synth-", "").replace("-test", "")
    if not prefix.startswith("synth"):
        prefix = f"synth-{prefix}"
    # Actually, use the node IDs as-is with a graph prefix
    def _node_id(short: str) -> str:
        return f"{prefix}-{short}" if not short.startswith(prefix) else short

    def _edge_id(short: str) -> str:
        return f"{prefix}-{short}" if not short.startswith(prefix) else short

    # --- Generate UUIDs ---
    # Deterministic from name + node/edge id for reproducibility
    def _uuid_for(kind: str, key: str) -> str:
        return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{name}.{kind}.{key}"))

    # --- Build nodes ---
    graph_nodes: list[dict] = []
    node_uuid_map: dict[str, str] = {}  # short_name → UUID

    # Layout: auto-arrange left-to-right
    # Simple heuristic: topological sort by edge dependencies
    node_x: dict[str, int] = {}
    node_deps: dict[str, set] = {n: set() for n in nodes_cfg}
    for eid, ecfg in edges_cfg.items():
        to_node = ecfg["to"]
        from_node = ecfg["from"]
        if to_node in node_deps:
            node_deps[to_node].add(from_node)

    # Assign x positions by dependency depth
    placed = set()
    depth = 0
    while len(placed) < len(nodes_cfg):
        layer = [n for n in nodes_cfg if n not in placed
                 and all(d in placed for d in node_deps.get(n, set()))]
        if not layer:
            # Break cycles (shouldn't happen in DAG)
            layer = [n for n in nodes_cfg if n not in placed][:1]
        for n in layer:
            node_x[n] = depth * 250
        placed.update(layer)
        depth += 1

    # Assign y positions: spread nodes at same x
    x_groups: dict[int, list[str]] = {}
    for n, x in node_x.items():
        x_groups.setdefault(x, []).append(n)
    node_y: dict[str, int] = {}
    for x, group in x_groups.items():
        total_height = (len(group) - 1) * 150
        start_y = 200 - total_height // 2
        for i, n in enumerate(group):
            node_y[n] = start_y + i * 150

    # Find start node
    start_node = None
    for nid, ncfg in nodes_cfg.items():
        if isinstance(ncfg, dict) and ncfg.get("start"):
            start_node = nid
            break

    for nid, ncfg in nodes_cfg.items():
        if not isinstance(ncfg, dict):
            ncfg = {}
        full_id = _node_id(nid)
        node_uuid = _uuid_for("node", nid)
        node_uuid_map[nid] = node_uuid

        is_absorbing = ncfg.get("absorbing", False)
        is_start = ncfg.get("start", False)

        node: dict[str, Any] = {
            "uuid": node_uuid,
            "id": full_id,
            "label": ncfg.get("label", nid.replace("-", " ").title()),
            "absorbing": is_absorbing,
            "layout": {"x": node_x.get(nid, 0), "y": node_y.get(nid, 200)},
            "images": [],
        }

        if not is_absorbing:
            event_id = f"{full_id}-event"
            node["event_id"] = event_id

        if is_start:
            node["entry"] = {"is_start": True}

        if is_absorbing:
            outcome = ncfg.get("outcome_type", "success")
            node["outcome_type"] = outcome
            node["outcome_type_overridden"] = True
            # Absorbing nodes with events (measurable outcomes)
            if ncfg.get("has_event", True) and is_absorbing:
                node["event_id"] = f"{full_id}-event"

        graph_nodes.append(node)

    # --- Infer dropout node + complement edges ---
    # For each non-absorbing node with outgoing data edges,
    # add a complement edge to a shared dropout node.
    dropout_id = f"{prefix}-dropout"
    dropout_uuid = _uuid_for("node", "dropout")
    node_uuid_map["_dropout"] = dropout_uuid

    # Check which nodes need complement edges
    nodes_with_data_edges: set[str] = set()
    for eid, ecfg in edges_cfg.items():
        nodes_with_data_edges.add(ecfg["from"])

    need_dropout = False
    for nid in nodes_with_data_edges:
        ncfg = nodes_cfg.get(nid, {})
        if not isinstance(ncfg, dict):
            ncfg = {}
        if not ncfg.get("absorbing", False):
            need_dropout = True
            break

    if need_dropout:
        # Find layout position for dropout (below everything)
        max_y = max(node_y.values()) if node_y else 200
        mid_x = sum(node_x.values()) // len(node_x) if node_x else 300
        graph_nodes.append({
            "uuid": dropout_uuid,
            "id": dropout_id,
            "label": "Dropout",
            "absorbing": True,
            "layout": {"x": mid_x, "y": max_y + 200},
            "outcome_type": "failure",
            "outcome_type_overridden": True,
        })

    # --- Build edges ---
    graph_edges: list[dict] = []
    anchor_node_id = _node_id(start_node) if start_node else ""
    anchor_event_id = f"{anchor_node_id}-event" if anchor_node_id else ""

    for eid, ecfg in edges_cfg.items():
        full_eid = _edge_id(eid)
        edge_uuid = _uuid_for("edge", eid)
        from_uuid = node_uuid_map[ecfg["from"]]
        to_uuid = node_uuid_map[ecfg["to"]]
        from_full = _node_id(ecfg["from"])
        to_full = _node_id(ecfg["to"])

        has_latency = ecfg.get("onset", 0) > 0.01 or ecfg.get("mu", 0) > 0.01

        edge: dict[str, Any] = {
            "uuid": edge_uuid,
            "id": full_eid,
            "from": from_uuid,
            "to": to_uuid,
            "fromHandle": "right-out",
            "toHandle": "left",
            "p": {
                "id": full_eid,
                "latency": {
                    "latency_parameter": has_latency,
                    "anchor_node_id": anchor_node_id,
                    **({"onset_delta_days": float(ecfg.get("onset", 0)),
                        "mu": float(ecfg.get("mu", 0)),
                        "sigma": float(ecfg.get("sigma", 0.5))}
                       if has_latency else {}),
                },
                "cohort_anchor_event_id": anchor_event_id,
            },
            "query": f"from({from_full}).to({to_full})",
        }
        graph_edges.append(edge)

    # --- Complement (dropout) edges ---
    if need_dropout:
        for nid in nodes_with_data_edges:
            ncfg = nodes_cfg.get(nid, {})
            if not isinstance(ncfg, dict):
                ncfg = {}
            if ncfg.get("absorbing", False):
                continue
            comp_uuid = _uuid_for("edge", f"{nid}-to-dropout")
            from_uuid = node_uuid_map[nid]
            graph_edges.append({
                "uuid": comp_uuid,
                "from": from_uuid,
                "to": dropout_uuid,
                "fromHandle": "bottom-out",
                "toHandle": "left",
                "p": {},
                "query": "",
            })

    # --- Assemble graph JSON ---
    base_date = sim_cfg.get("base_date", "2025-12-12")
    graph_json = {
        "nodes": graph_nodes,
        "edges": graph_edges,
        "defaultConnection": "amplitude",
        "simulation": True,
        "dailyFetch": False,
        "runBayes": False,
        "metadata": {
            "name": name,
            "description": description,
            "created_at": datetime.now().isoformat() + "Z",
            "updated_at": datetime.now().isoformat() + "Z",
            "version": "1.0.0",
            "author": "synth_gen",
        },
    }

    # --- Write graph JSON ---
    graph_path = os.path.join(data_repo, "graphs", f"{name}.json")
    with open(graph_path, "w") as f:
        json.dump(graph_json, f, indent=2, ensure_ascii=False)
        f.write("\n")

    # --- Write entity files ---
    for node in graph_nodes:
        nid = node["id"]
        node_path = os.path.join(data_repo, "nodes", f"{nid}.yaml")
        node_data: dict[str, Any] = {"id": nid}
        if "event_id" in node:
            node_data["event_id"] = node["event_id"]
        node_data["metadata"] = {
            "created_at": "2026-03-23T00:00:00Z",
            "version": "1.0.0",
            "status": "active",
            "author": "synth_gen",
        }
        with open(node_path, "w") as f:
            yaml.dump(node_data, f, default_flow_style=False, sort_keys=False)

        # Event file (if node has event_id)
        if "event_id" in node:
            eid = node["event_id"]
            event_path = os.path.join(data_repo, "events", f"{eid}.yaml")
            event_data = {
                "id": eid,
                "name": eid,
                "provider": "amplitude",
                "event_type": eid,
                "metadata": {
                    "created_at": "2026-03-23T00:00:00Z",
                    "version": "1.0.0",
                    "status": "active",
                    "author": "synth_gen",
                },
            }
            with open(event_path, "w") as f:
                yaml.dump(event_data, f, default_flow_style=False, sort_keys=False)

    # Generate context YAML files (doc 14 §12.5b)
    context_dims = truth.get("context_dimensions", [])
    contexts_dir = os.path.join(data_repo, "contexts")
    if context_dims:
        os.makedirs(contexts_dir, exist_ok=True)
    for dim in context_dims:
        ctx_id = dim["id"]
        ctx_path = os.path.join(contexts_dir, f"{ctx_id}.yaml")
        ctx_values = []
        for v in dim.get("values", []):
            ctx_val: dict[str, Any] = {
                "id": v["id"],
                "label": v.get("label", v["id"].replace("-", " ").title()),
            }
            if v.get("description"):
                ctx_val["description"] = v["description"]
            if v.get("aliases") is not None:
                ctx_val["aliases"] = v["aliases"]
            if v.get("sources"):
                ctx_val["sources"] = v["sources"]
            ctx_values.append(ctx_val)
        ctx_data = {
            "id": ctx_id,
            "name": dim.get("name", ctx_id.replace("-", " ").title()),
            "type": "categorical",
            "otherPolicy": dim.get("otherPolicy", "none"),
            "values": ctx_values,
            "metadata": {
                "status": "active",
                "author": "synth_gen",
                "version": "1.0.0",
            },
        }
        with open(ctx_path, "w") as f:
            yaml.dump(ctx_data, f, default_flow_style=False, sort_keys=False)
        print(f"  Context: {ctx_path}")

    print(f"  Generated: {graph_path}")
    print(f"    {len(graph_nodes)} nodes, {len(graph_edges)} edges "
          f"({len(edges_cfg)} data + {len(graph_edges) - len(edges_cfg)} complement)")

    return graph_path


def truth_has_graph_structure(truth: dict) -> bool:
    """Check if a truth file has the new graph structure format."""
    return "nodes" in truth and "edges" in truth and any(
        isinstance(v, dict) and "from" in v
        for v in truth.get("edges", {}).values()
    )


def build_edges_config(truth: dict) -> dict:
    """Extract the old-format edges config from new-format truth.

    Returns dict[param_id → {p, onset, mu, sigma}] compatible with
    the simulation loop.
    """
    result = {}
    prefix = truth.get("graph", {}).get("name", "synth").replace("synth-", "").replace("-test", "")
    if not prefix.startswith("synth"):
        prefix = f"synth-{prefix}"

    for eid, ecfg in truth.get("edges", {}).items():
        if not isinstance(ecfg, dict) or "from" not in ecfg:
            continue
        full_eid = f"{prefix}-{eid}" if not eid.startswith(prefix) else eid
        result[full_eid] = {
            "p": ecfg.get("p", 0.5),
            "onset": ecfg.get("onset", 0.0),
            "mu": ecfg.get("mu", 0.0),
            "sigma": ecfg.get("sigma", 0.0),
        }
    return result
