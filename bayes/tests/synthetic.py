"""
Synthetic graph and evidence generators for compiler parameter recovery tests.

Each builder produces:
  - graph_snapshot: dict matching the format analyse_topology() expects
  - param_files: dict of param_id → param file data with values[] entries
  - ground_truth: dict of edge_id → true probability (for recovery checks)

Evidence is generated from Multinomial draws with a fixed seed.
"""

from __future__ import annotations

import uuid
import numpy as np


# ---------------------------------------------------------------------------
# Node / edge helpers
# ---------------------------------------------------------------------------

def _node(
    node_id: str,
    *,
    is_start: bool = False,
    absorbing: bool = False,
    exhaustive: bool = False,
) -> dict:
    node = {
        "uuid": node_id,
        "id": node_id,
        "entry": {"is_start": is_start} if is_start else {},
        "absorbing": absorbing,
    }
    if exhaustive:
        node["exhaustive"] = True
    return node


def _edge(
    edge_id: str,
    from_node: str,
    to_node: str,
    param_id: str,
    *,
    p_mean: float = 0.5,
) -> dict:
    return {
        "uuid": edge_id,
        "from": from_node,
        "to": to_node,
        "p": {
            "id": param_id,
            "mean": p_mean,
        },
    }


def _window_param_file(
    n: int,
    k: int,
    *,
    param_id: str = "",
    mean: float | None = None,
) -> dict:
    """Build a minimal parameter file dict with a single window observation."""
    effective_mean = mean if mean is not None else (k / n if n > 0 else 0.5)
    return {
        "id": param_id,
        "values": [
            {
                "sliceDSL": "window(1-Jan-25:1-Mar-25)",
                "n": int(n),
                "k": int(k),
                "mean": effective_mean,
                "stdev": 0.01,
            },
        ],
    }


# ---------------------------------------------------------------------------
# Multinomial draw helper
# ---------------------------------------------------------------------------

def _multinomial_draw(
    rng: np.random.Generator,
    n: int,
    probs: list[float],
) -> list[int]:
    """Draw from Multinomial(n, probs). Last component is dropout if sum < 1."""
    p_total = sum(probs)
    if p_total < 1.0:
        full_probs = probs + [1.0 - p_total]
    else:
        full_probs = probs
    counts = rng.multinomial(n, full_probs)
    return list(counts)


# ---------------------------------------------------------------------------
# Scenario builders
# ---------------------------------------------------------------------------

def build_branch_group_3way(
    p_true: list[float],
    n_a: int = 10_000,
    *,
    exhaustive: bool = False,
    seed: int = 42,
) -> tuple[dict, dict[str, dict], dict[str, float]]:
    """Build A → {B, C, D} branch group with known Multinomial truth.

    Args:
        p_true: [p_B, p_C, p_D]. If sum < 1, residual is dropout.
        n_a: shared denominator (source node traffic).
        exhaustive: whether the branch group is exhaustive.
        seed: random seed for reproducible draws.

    Returns:
        (graph_snapshot, param_files, ground_truth)
    """
    rng = np.random.default_rng(seed)

    # Fixed UUIDs for determinism
    anchor_id = "node-anchor"
    node_a = "node-a"
    node_b = "node-b"
    node_c = "node-c"
    node_d = "node-d"

    edge_anchor_a = "edge-anchor-a"
    edge_a_b = "edge-a-b"
    edge_a_c = "edge-a-c"
    edge_a_d = "edge-a-d"

    # Draw observations
    if exhaustive:
        # Exhaustive: probabilities must sum to 1, no dropout
        normalised = [p / sum(p_true) for p in p_true]
        counts = _multinomial_draw(rng, n_a, normalised)
    else:
        counts = _multinomial_draw(rng, n_a, p_true)
    k_b, k_c, k_d = counts[0], counts[1], counts[2]

    graph_snapshot = {
        "nodes": [
            _node(anchor_id, is_start=True),
            _node(node_a, exhaustive=exhaustive),
            _node(node_b, absorbing=True),
            _node(node_c, absorbing=True),
            _node(node_d, absorbing=True),
        ],
        "edges": [
            _edge(edge_anchor_a, anchor_id, node_a, "param-anchor-a", p_mean=0.9),
            _edge(edge_a_b, node_a, node_b, "param-a-b", p_mean=p_true[0]),
            _edge(edge_a_c, node_a, node_c, "param-a-c", p_mean=p_true[1]),
            _edge(edge_a_d, node_a, node_d, "param-a-d", p_mean=p_true[2]),
        ],
    }

    param_files = {
        "param-anchor-a": _window_param_file(n_a * 2, int(n_a * 2 * 0.9), param_id="param-anchor-a"),
        "param-a-b": _window_param_file(n_a, k_b, param_id="param-a-b"),
        "param-a-c": _window_param_file(n_a, k_c, param_id="param-a-c"),
        "param-a-d": _window_param_file(n_a, k_d, param_id="param-a-d"),
    }

    ground_truth = {
        edge_a_b: p_true[0],
        edge_a_c: p_true[1],
        edge_a_d: p_true[2],
    }

    return graph_snapshot, param_files, ground_truth


def build_branch_group_2way(
    p_true: list[float],
    n_a: int = 20_000,
    *,
    seed: int = 42,
) -> tuple[dict, dict[str, dict], dict[str, float]]:
    """Build A → {B, C} branch group (2 siblings + dropout).

    Args:
        p_true: [p_B, p_C]. Residual is dropout.
        n_a: shared denominator.
        seed: random seed.

    Returns:
        (graph_snapshot, param_files, ground_truth)
    """
    rng = np.random.default_rng(seed)

    anchor_id = "node-anchor"
    node_a = "node-a"
    node_b = "node-b"
    node_c = "node-c"

    edge_anchor_a = "edge-anchor-a"
    edge_a_b = "edge-a-b"
    edge_a_c = "edge-a-c"

    counts = _multinomial_draw(rng, n_a, p_true)
    k_b, k_c = counts[0], counts[1]

    graph_snapshot = {
        "nodes": [
            _node(anchor_id, is_start=True),
            _node(node_a),
            _node(node_b, absorbing=True),
            _node(node_c, absorbing=True),
        ],
        "edges": [
            _edge(edge_anchor_a, anchor_id, node_a, "param-anchor-a", p_mean=0.9),
            _edge(edge_a_b, node_a, node_b, "param-a-b", p_mean=p_true[0]),
            _edge(edge_a_c, node_a, node_c, "param-a-c", p_mean=p_true[1]),
        ],
    }

    param_files = {
        "param-anchor-a": _window_param_file(n_a * 2, int(n_a * 2 * 0.9), param_id="param-anchor-a"),
        "param-a-b": _window_param_file(n_a, k_b, param_id="param-a-b"),
        "param-a-c": _window_param_file(n_a, k_c, param_id="param-a-c"),
    }

    ground_truth = {
        edge_a_b: p_true[0],
        edge_a_c: p_true[1],
    }

    return graph_snapshot, param_files, ground_truth


def build_mixed_solo_and_branch(
    *,
    branch_p: list[float] = [0.4, 0.3],
    anchor_p: list[float] = [0.5, 0.2],
    solo_p_xy: float = 0.7,
    n_branch: int = 10_000,
    n_anchor: int = 10_000,
    seed: int = 42,
) -> tuple[dict, dict[str, dict], dict[str, float]]:
    """Build a graph with both branch groups and an independent solo edge.

    Topology:
      anchor → {A, X} (branch group, p=anchor_p — must sum < 1)
      A → {B, C} (branch group, p=branch_p — must sum < 1)
      X → Y (solo edge, p=solo_p_xy)

    For regression testing: solo edge X→Y must be unaffected by the Dirichlets.
    """
    rng = np.random.default_rng(seed)

    anchor_id = "node-anchor"
    node_a = "node-a"
    node_b = "node-b"
    node_c = "node-c"
    node_x = "node-x"
    node_y = "node-y"

    edge_anchor_a = "edge-anchor-a"
    edge_a_b = "edge-a-b"
    edge_a_c = "edge-a-c"
    edge_anchor_x = "edge-anchor-x"
    edge_x_y = "edge-x-y"

    # Anchor branch group: anchor → {A, X} with shared denominator
    anchor_counts = _multinomial_draw(rng, n_anchor, anchor_p)
    k_anchor_a = anchor_counts[0]
    k_anchor_x = anchor_counts[1]

    # Node A branch group: A → {B, C} with shared denominator
    branch_counts = _multinomial_draw(rng, n_branch, branch_p)
    k_b, k_c = branch_counts[0], branch_counts[1]

    # Solo edge: X → Y (independent Binomial)
    k_x_y = rng.binomial(k_anchor_x, solo_p_xy)

    graph_snapshot = {
        "nodes": [
            _node(anchor_id, is_start=True),
            _node(node_a),
            _node(node_b, absorbing=True),
            _node(node_c, absorbing=True),
            _node(node_x),
            _node(node_y, absorbing=True),
        ],
        "edges": [
            _edge(edge_anchor_a, anchor_id, node_a, "param-anchor-a", p_mean=anchor_p[0]),
            _edge(edge_a_b, node_a, node_b, "param-a-b", p_mean=branch_p[0]),
            _edge(edge_a_c, node_a, node_c, "param-a-c", p_mean=branch_p[1]),
            _edge(edge_anchor_x, anchor_id, node_x, "param-anchor-x", p_mean=anchor_p[1]),
            _edge(edge_x_y, node_x, node_y, "param-x-y", p_mean=solo_p_xy),
        ],
    }

    # n for X→Y is the count of users reaching X (= k_anchor_x)
    n_x_y = max(k_anchor_x, 1)

    param_files = {
        "param-anchor-a": _window_param_file(n_anchor, k_anchor_a, param_id="param-anchor-a"),
        "param-a-b": _window_param_file(n_branch, k_b, param_id="param-a-b"),
        "param-a-c": _window_param_file(n_branch, k_c, param_id="param-a-c"),
        "param-anchor-x": _window_param_file(n_anchor, k_anchor_x, param_id="param-anchor-x"),
        "param-x-y": _window_param_file(n_x_y, k_x_y, param_id="param-x-y"),
    }

    ground_truth = {
        edge_anchor_a: anchor_p[0],
        edge_a_b: branch_p[0],
        edge_a_c: branch_p[1],
        edge_anchor_x: anchor_p[1],
        edge_x_y: solo_p_xy,
    }

    return graph_snapshot, param_files, ground_truth
