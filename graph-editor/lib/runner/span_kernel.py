"""
Subject-side span kernel for multi-hop cohort maturity.

Computes K_{x→y}(τ) — the conditional probability that mass arriving
at x at age 0 has reached y by age τ — using forward DP in topological
order across the x→y sub-DAG.

This is Phase A, Step A.2.  See doc 29c §Subject Span Kernel.

Algebra:
- Per-edge sub-probability density: f_i(τ) = p_i · pdf_i(τ)
- Serial composition: convolution of densities
- Parallel composition: summation of densities
- K_{x→y}(τ) = accumulation of the combined density at y

The DP:
1. Topological sort nodes reachable from x that can reach y
2. Initialise g_x(τ) = δ(τ=0)
3. For each node v after x: g_v(τ) = Σ_{u→v} (g_u * f_{u→v})(τ)
4. K_{x→y}(τ) = Σ_{t≤τ} g_y(t)

Complexity: O(|E| · max_tau²).

The numerator convolution uses K (the CDF), not f (the density):
    Y_y(s, τ) = Σ_u ΔX_x(s, u) · K_{x→y}(τ − u)
Using f instead of K would give instantaneous arrival rate, not
cumulative arrivals.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any, Tuple
import math

import numpy as np


@dataclass
class SpanKernel:
    """Result of compose_span_kernel.

    K[tau] is the sub-probability CDF: P(reach y by age tau | arrived at x).
    span_p = K[max_tau] ≈ K(∞), the total conditional probability.
    density[tau] is the sub-probability density (used to build K).
    """
    density: np.ndarray     # f_{x→y}(τ) on integer grid [0..max_tau]
    K: np.ndarray           # CDF: cumulative sum of density
    span_p: float           # K[-1], asymptotic conditional probability
    max_tau: int

    def cdf_at(self, tau: int) -> float:
        """K_{x→y}(tau) — clamped to grid bounds."""
        if tau < 0:
            return 0.0
        if tau >= len(self.K):
            return float(self.K[-1])
        return float(self.K[tau])


def _shifted_lognormal_pdf(tau_grid: np.ndarray, onset: float, mu: float, sigma: float) -> np.ndarray:
    """Evaluate shifted-lognormal PDF on integer tau grid.

    pdf(t) = (1 / ((t - onset) · σ · √(2π))) · exp(-(ln(t - onset) - μ)² / (2σ²))
    for t > onset, 0 otherwise.
    """
    age = tau_grid - onset
    result = np.zeros_like(tau_grid, dtype=float)
    mask = age > 0
    if not np.any(mask) or sigma <= 0:
        return result
    log_age = np.log(age[mask])
    z = (log_age - mu) / sigma
    result[mask] = np.exp(-0.5 * z * z) / (age[mask] * sigma * math.sqrt(2.0 * math.pi))
    return result


def _edge_sub_probability_density(
    tau_grid: np.ndarray,
    p: float,
    onset: float,
    mu: float,
    sigma: float,
) -> np.ndarray:
    """Sub-probability density for one edge: f(τ) = p · pdf(τ).

    f(∞) integrates to p (not 1).  This is the correct object for
    serial convolution — leakage (1 - p) is already encoded.
    """
    if p <= 0 or sigma <= 0:
        return np.zeros_like(tau_grid, dtype=float)
    pdf = _shifted_lognormal_pdf(tau_grid, onset, mu, sigma)
    return p * pdf


def compose_span_kernel(
    graph: Dict[str, Any],
    x_node_id: str,
    y_node_id: str,
    is_window: bool,
    max_tau: int = 400,
) -> Optional[SpanKernel]:
    """Compose the x→y span kernel via forward DP in topological order.

    Args:
        graph: Graph dict with 'nodes' and 'edges' lists.
        x_node_id: Query start node (human-readable ID).
        y_node_id: Query end node (human-readable ID).
        is_window: True for window() mode (edge-level params), False
            for cohort() mode (path-level params).
        max_tau: Maximum tau on the integer grid.

    Returns:
        SpanKernel, or None if x = y or no path exists.
    """
    if x_node_id == y_node_id:
        return None

    # ── Build adjacency from graph edges ──────────────────────────────
    edges = graph.get('edges', [])
    nodes = graph.get('nodes', [])

    # Map node UUIDs to human IDs
    uuid_to_id: Dict[str, str] = {}
    for n in nodes:
        nid = n.get('id', '')
        uuid = n.get('uuid', nid)
        uuid_to_id[uuid] = nid
        uuid_to_id[nid] = nid

    # Build adjacency: from_id → [(to_id, edge_data)]
    adjacency: Dict[str, List[Tuple[str, Dict]]] = {}
    for e in edges:
        from_uuid = e.get('from_node', e.get('from', ''))
        to_uuid = e.get('to', e.get('to_node', ''))
        from_id = uuid_to_id.get(from_uuid, from_uuid)
        to_id = uuid_to_id.get(to_uuid, to_uuid)
        if from_id not in adjacency:
            adjacency[from_id] = []
        adjacency[from_id].append((to_id, e))

    # ── Find reachable nodes from x that can reach y ─────────────────
    # Forward BFS from x
    from collections import deque
    forward_reachable = set()
    queue = deque([x_node_id])
    forward_reachable.add(x_node_id)
    while queue:
        node = queue.popleft()
        for to_id, _ in adjacency.get(node, []):
            if to_id not in forward_reachable:
                forward_reachable.add(to_id)
                queue.append(to_id)

    if y_node_id not in forward_reachable:
        return None  # No path from x to y

    # Backward BFS from y (reverse graph)
    reverse_adj: Dict[str, List[str]] = {}
    for from_id, targets in adjacency.items():
        for to_id, _ in targets:
            if to_id not in reverse_adj:
                reverse_adj[to_id] = []
            reverse_adj[to_id].append(from_id)

    backward_reachable = set()
    queue = deque([y_node_id])
    backward_reachable.add(y_node_id)
    while queue:
        node = queue.popleft()
        for from_id in reverse_adj.get(node, []):
            if from_id not in backward_reachable:
                backward_reachable.add(from_id)
                queue.append(from_id)

    # Nodes on x→y paths = intersection
    on_path = forward_reachable & backward_reachable

    if x_node_id not in on_path or y_node_id not in on_path:
        return None

    # ── Topological sort of on-path nodes ────────────────────────────
    in_degree: Dict[str, int] = {n: 0 for n in on_path}
    path_adj: Dict[str, List[Tuple[str, Dict]]] = {}
    for from_id, targets in adjacency.items():
        if from_id not in on_path:
            continue
        for to_id, e in targets:
            if to_id not in on_path:
                continue
            if from_id not in path_adj:
                path_adj[from_id] = []
            path_adj[from_id].append((to_id, e))
            in_degree[to_id] = in_degree.get(to_id, 0) + 1

    topo_order: List[str] = []
    queue = deque([n for n in on_path if in_degree.get(n, 0) == 0])
    while queue:
        node = queue.popleft()
        topo_order.append(node)
        for to_id, _ in path_adj.get(node, []):
            in_degree[to_id] -= 1
            if in_degree[to_id] == 0:
                queue.append(to_id)

    if len(topo_order) != len(on_path):
        # Cycle detected — shouldn't happen in a DAG
        return None

    # ── Forward DP ────────────────────────────────────────────────────
    tau_grid = np.arange(max_tau + 1, dtype=float)
    g: Dict[str, np.ndarray] = {}

    # Initialise: unit impulse at x
    g[x_node_id] = np.zeros(max_tau + 1, dtype=float)
    g[x_node_id][0] = 1.0

    for node in topo_order:
        if node == x_node_id:
            continue  # already initialised

        node_density = np.zeros(max_tau + 1, dtype=float)

        # Sum contributions from all incoming on-path edges
        for from_id in reverse_adj.get(node, []):
            if from_id not in on_path:
                continue
            if from_id not in g:
                continue

            # Find the edge data
            edge_data = None
            for to_id, e in path_adj.get(from_id, []):
                if to_id == node:
                    edge_data = e
                    break
            if edge_data is None:
                continue

            # Extract per-edge params
            p_data = edge_data.get('p', {})
            latency = p_data.get('latency', {})
            posterior = latency.get('posterior', {})

            # Resolve p
            prob_posterior = p_data.get('posterior', {})
            forecast = p_data.get('forecast', {})
            edge_p = (
                prob_posterior.get('alpha', 0) / (prob_posterior.get('alpha', 0) + prob_posterior.get('beta', 1))
                if prob_posterior.get('alpha', 0) > 0 and prob_posterior.get('beta', 0) > 0
                else forecast.get('mean', 0)
                or p_data.get('value', 0)
                or 0.0
            )

            # Resolve latency (edge-level for window, path-level for cohort)
            if is_window:
                mu = posterior.get('mu_mean') or latency.get('mu') or 0.0
                sigma = posterior.get('sigma_mean') or latency.get('sigma') or 0.0
                onset = (posterior.get('onset_delta_days')
                         or latency.get('promoted_onset_delta_days')
                         or latency.get('onset_delta_days')
                         or 0.0)
            else:
                # Cohort mode: still use edge-level for per-edge kernel
                # (path-level is for the full anchor→target path)
                mu = posterior.get('mu_mean') or latency.get('mu') or 0.0
                sigma = posterior.get('sigma_mean') or latency.get('sigma') or 0.0
                onset = (posterior.get('onset_delta_days')
                         or latency.get('promoted_onset_delta_days')
                         or latency.get('onset_delta_days')
                         or 0.0)

            if not isinstance(mu, (int, float)):
                mu = 0.0
            if not isinstance(sigma, (int, float)) or sigma <= 0:
                sigma = 0.01  # avoid zero
            if not isinstance(onset, (int, float)):
                onset = 0.0
            if not isinstance(edge_p, (int, float)) or edge_p <= 0:
                continue  # skip dead edges

            edge_p = float(min(edge_p, 1.0))

            print(f"[span_kernel] Edge {from_id}→{node}: p={edge_p:.4f} mu={mu:.4f} sigma={sigma:.4f} onset={onset:.2f}")

            # Build per-edge sub-probability density
            f_edge = _edge_sub_probability_density(tau_grid, edge_p, onset, mu, sigma)

            # Serial composition: convolve g[from] with f_edge
            convolved = np.convolve(g[from_id], f_edge)[:max_tau + 1]

            # Parallel composition: sum into node_density
            node_density += convolved

        g[node] = node_density

    # ── Extract kernel at y ───────────────────────────────────────────
    if y_node_id not in g:
        return None

    density = g[y_node_id]
    K = np.cumsum(density)
    span_p = float(K[-1]) if len(K) > 0 else 0.0

    return SpanKernel(
        density=density,
        K=K,
        span_p=span_p,
        max_tau=max_tau,
    )
