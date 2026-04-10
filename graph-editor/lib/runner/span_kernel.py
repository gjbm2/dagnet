"""
Subject-side span kernel for multi-hop cohort maturity.

Computes K_{x→y}(τ) — the conditional probability that mass arriving
at x at age 0 has reached y by age τ — using forward DP in topological
order across the x→y sub-DAG.

See doc 29c §Subject Span Kernel.

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
    """Result of compose_span_kernel."""
    density: np.ndarray     # f_{x→y}(τ) on integer grid [0..max_tau]
    K: np.ndarray           # CDF: cumulative sum of density
    span_p: float           # K[-1], asymptotic conditional probability
    max_tau: int

    def cdf_at(self, tau: int) -> float:
        if tau < 0:
            return 0.0
        if tau >= len(self.K):
            return float(self.K[-1])
        return float(self.K[tau])


@dataclass
class SpanTopology:
    """Precomputed DAG topology for the x→y span.

    Extracted once from the graph, reused for point-estimate kernel and
    for per-MC-draw reconvolution.
    """
    x_node_id: str
    y_node_id: str
    topo_order: List[str]           # nodes in topological order
    on_path: set                    # nodes on x→y paths
    reverse_adj: Dict[str, List[str]]  # node → list of predecessors
    path_adj: Dict[str, List[Tuple[str, Dict]]]  # from → [(to, edge_data)]
    edge_list: List[Tuple[str, str, Dict]]  # (from_id, to_id, edge_data) for all on-path edges


def _shifted_lognormal_pdf(tau_grid: np.ndarray, onset: float, mu: float, sigma: float) -> np.ndarray:
    """Evaluate shifted-lognormal PDF on integer tau grid."""
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

    sigma == 0: pure probability gate, delta at tau=0 (no timing delay).
    0 < sigma < 0.1: near-degenerate, delta at onset + exp(mu).
    sigma >= 0.1: full lognormal PDF.
    Normalises discrete PDF to sum to 1 before scaling by p.
    """
    if p <= 0:
        return np.zeros_like(tau_grid, dtype=float)

    if sigma <= 0:
        # Pure probability gate: delta at tau=0
        result = np.zeros_like(tau_grid, dtype=float)
        if len(result) > 0:
            result[0] = p
        return result

    if sigma < 0.1:
        # Near-degenerate lognormal: delta at onset + exp(mu)
        result = np.zeros_like(tau_grid, dtype=float)
        delta_tau = onset + math.exp(mu)
        idx = int(round(max(0, delta_tau)))
        if idx < len(result):
            result[idx] = p
        return result

    pdf = _shifted_lognormal_pdf(tau_grid, onset, mu, sigma)
    pdf_sum = np.sum(pdf)
    if pdf_sum > 0:
        pdf = pdf / pdf_sum
    return p * pdf


def _extract_edge_params(edge_data: Dict, is_window: bool) -> Tuple[float, float, float, float]:
    """Extract (p, mu, sigma, onset) from an edge dict.

    Returns (p, mu, sigma, onset).  When the edge has no latency model,
    returns sigma=0 to signal a pure probability gate (delta at tau=0).
    """
    p_data = edge_data.get('p', {})
    latency = p_data.get('latency', {})
    posterior = latency.get('posterior', {})
    prob_posterior = p_data.get('posterior', {})
    forecast = p_data.get('forecast', {})

    edge_p = (
        prob_posterior.get('alpha', 0) / (prob_posterior.get('alpha', 0) + prob_posterior.get('beta', 1))
        if prob_posterior.get('alpha', 0) > 0 and prob_posterior.get('beta', 0) > 0
        else forecast.get('mean', 0)
        or p_data.get('value', 0)
        or 0.0
    )

    # Check whether the edge actually has a latency model
    _raw_mu = posterior.get('mu_mean') or latency.get('mu')
    _raw_sigma = posterior.get('sigma_mean') or latency.get('sigma')
    _has_latency = (
        isinstance(_raw_mu, (int, float)) and _raw_mu != 0
        and isinstance(_raw_sigma, (int, float)) and _raw_sigma > 0
    )

    if _has_latency:
        mu = float(_raw_mu)
        sigma = float(_raw_sigma)
        onset = (posterior.get('onset_delta_days')
                 or latency.get('promoted_onset_delta_days')
                 or latency.get('onset_delta_days')
                 or 0.0)
        if not isinstance(onset, (int, float)):
            onset = 0.0
    else:
        # No latency model: pure probability gate, delta at tau=0
        mu = 0.0
        sigma = 0.0
        onset = 0.0

    if not isinstance(edge_p, (int, float)) or edge_p <= 0:
        edge_p = 0.0

    return (float(min(edge_p, 1.0)), float(mu), float(sigma), float(onset))


def _build_span_topology(
    graph: Dict[str, Any],
    x_node_id: str,
    y_node_id: str,
) -> Optional[SpanTopology]:
    """Build the reusable DAG topology for x→y.

    Returns None if no path exists from x to y.
    """
    from collections import deque

    if x_node_id == y_node_id:
        return None

    edges = graph.get('edges', [])
    nodes = graph.get('nodes', [])

    uuid_to_id: Dict[str, str] = {}
    for n in nodes:
        nid = n.get('id', '')
        uuid = n.get('uuid', nid)
        uuid_to_id[uuid] = nid
        uuid_to_id[nid] = nid

    adjacency: Dict[str, List[Tuple[str, Dict]]] = {}
    for e in edges:
        from_uuid = e.get('from_node', e.get('from', ''))
        to_uuid = e.get('to', e.get('to_node', ''))
        from_id = uuid_to_id.get(from_uuid, from_uuid)
        to_id = uuid_to_id.get(to_uuid, to_uuid)
        if from_id not in adjacency:
            adjacency[from_id] = []
        adjacency[from_id].append((to_id, e))

    # Forward BFS from x
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
        return None

    # Backward BFS from y
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

    on_path = forward_reachable & backward_reachable
    if x_node_id not in on_path or y_node_id not in on_path:
        return None

    # Topological sort
    in_degree: Dict[str, int] = {n: 0 for n in on_path}
    path_adj: Dict[str, List[Tuple[str, Dict]]] = {}
    edge_list: List[Tuple[str, str, Dict]] = []
    for from_id, targets in adjacency.items():
        if from_id not in on_path:
            continue
        for to_id, e in targets:
            if to_id not in on_path:
                continue
            if from_id not in path_adj:
                path_adj[from_id] = []
            path_adj[from_id].append((to_id, e))
            edge_list.append((from_id, to_id, e))
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
        return None

    return SpanTopology(
        x_node_id=x_node_id,
        y_node_id=y_node_id,
        topo_order=topo_order,
        on_path=on_path,
        reverse_adj=reverse_adj,
        path_adj=path_adj,
        edge_list=edge_list,
    )


def _run_dp(
    topo: SpanTopology,
    edge_params: Dict[Tuple[str, str], Tuple[float, float, float, float]],
    max_tau: int,
) -> np.ndarray:
    """Run the forward DP with given per-edge params.

    Args:
        topo: Precomputed topology.
        edge_params: (from_id, to_id) → (p, mu, sigma, onset)
        max_tau: Grid size.

    Returns:
        K array (CDF at y), shape (max_tau+1,).
    """
    tau_grid = np.arange(max_tau + 1, dtype=float)
    g: Dict[str, np.ndarray] = {}

    g[topo.x_node_id] = np.zeros(max_tau + 1, dtype=float)
    g[topo.x_node_id][0] = 1.0

    for node in topo.topo_order:
        if node == topo.x_node_id:
            continue

        node_density = np.zeros(max_tau + 1, dtype=float)

        for from_id in topo.reverse_adj.get(node, []):
            if from_id not in topo.on_path or from_id not in g:
                continue

            key = (from_id, node)
            if key not in edge_params:
                continue
            p, mu, sigma, onset = edge_params[key]
            if p <= 0:
                continue

            f_edge = _edge_sub_probability_density(tau_grid, p, onset, mu, sigma)
            convolved = np.convolve(g[from_id], f_edge)[:max_tau + 1]
            node_density += convolved

        g[node] = node_density

    if topo.y_node_id not in g:
        return np.zeros(max_tau + 1, dtype=float)

    return np.cumsum(g[topo.y_node_id])


def compose_span_kernel(
    graph: Dict[str, Any],
    x_node_id: str,
    y_node_id: str,
    is_window: bool,
    max_tau: int = 400,
) -> Optional[SpanKernel]:
    """Compose the x→y span kernel via forward DP in topological order."""
    topo = _build_span_topology(graph, x_node_id, y_node_id)
    if topo is None:
        return None

    # Extract point-estimate params per edge
    edge_params: Dict[Tuple[str, str], Tuple[float, float, float, float]] = {}
    for from_id, to_id, e in topo.edge_list:
        edge_params[(from_id, to_id)] = _extract_edge_params(e, is_window)

    K = _run_dp(topo, edge_params, max_tau)
    span_p = float(K[-1]) if len(K) > 0 else 0.0
    density = np.diff(K, prepend=0.0)

    return SpanKernel(
        density=density,
        K=K,
        span_p=span_p,
        max_tau=max_tau,
    )


def mc_span_cdfs(
    topo: SpanTopology,
    graph: Dict[str, Any],
    is_window: bool,
    max_tau: int,
    num_draws: int,
    rng: np.random.Generator,
) -> Tuple[np.ndarray, np.ndarray]:
    """Generate per-MC-draw span CDFs by reconvolving with drawn per-edge params.

    For each draw:
    1. Draw (p, mu, sigma, onset) per edge from each edge's posterior
    2. Run the forward DP with those params
    3. Collect the span CDF and span_p

    Args:
        topo: Precomputed span topology.
        graph: Graph dict (for reading per-edge posteriors).
        is_window: Window vs cohort mode.
        max_tau: Grid size.
        num_draws: Number of MC samples (S).
        rng: Numpy random generator.

    Returns:
        (cdf_arr, p_s) where:
        - cdf_arr: (S, max_tau+1) array of normalised CDFs (0→1)
        - p_s: (S,) array of per-draw span_p values
    """
    T = max_tau + 1

    # ── Extract per-edge posterior means and SDs ──────────────────────
    edge_keys: List[Tuple[str, str]] = []
    edge_means: List[Tuple[float, float, float, float]] = []  # (p, mu, sigma, onset)
    edge_sds: List[Tuple[float, float, float, float]] = []    # (p_sd, mu_sd, sigma_sd, onset_sd)

    for from_id, to_id, e in topo.edge_list:
        p, mu, sigma, onset = _extract_edge_params(e, is_window)
        edge_keys.append((from_id, to_id))
        edge_means.append((p, mu, sigma, onset))

        # Extract SDs from posterior
        p_data = e.get('p', {})
        latency = p_data.get('latency', {})
        posterior = latency.get('posterior', {})
        prob_posterior = p_data.get('posterior', {})

        # p SD from alpha/beta
        alpha = prob_posterior.get('alpha', 0)
        beta = prob_posterior.get('beta', 0)
        if isinstance(alpha, (int, float)) and isinstance(beta, (int, float)) and alpha > 0 and beta > 0:
            s = float(alpha) + float(beta)
            p_sd = math.sqrt(float(alpha) * float(beta) / (s * s * (s + 1)))
        else:
            p_sd = 0.05  # weak default

        # Non-latency edge (sigma=0): zero latency SDs, no fake
        # timing uncertainty.  Only p varies across draws.
        if sigma <= 0:
            edge_sds.append((float(p_sd), 0.0, 0.0, 0.0))
        else:
            mu_sd = posterior.get('mu_sd') or 0.1
            sigma_sd = posterior.get('sigma_sd') or 0.05
            onset_sd = posterior.get('onset_sd') or 0.5
            if not isinstance(mu_sd, (int, float)):
                mu_sd = 0.1
            if not isinstance(sigma_sd, (int, float)):
                sigma_sd = 0.05
            if not isinstance(onset_sd, (int, float)):
                onset_sd = 0.5
            edge_sds.append((float(p_sd), float(mu_sd), float(sigma_sd), float(onset_sd)))

    n_edges = len(edge_keys)

    # ── Draw per-edge params for all S draws ──────────────────────────
    # Shape: (S, n_edges, 4) for [p, mu, sigma, onset]
    means_arr = np.array(edge_means)  # (n_edges, 4)
    sds_arr = np.array(edge_sds)      # (n_edges, 4)

    # Independent normal draws per edge per param
    draws = rng.normal(
        loc=means_arr[None, :, :],   # (1, n_edges, 4)
        scale=sds_arr[None, :, :],   # (1, n_edges, 4)
        size=(num_draws, n_edges, 4),
    )

    # Clip to valid ranges
    draws[:, :, 0] = np.clip(draws[:, :, 0], 1e-6, 1 - 1e-6)  # p ∈ (0, 1)
    # Clip sigma: non-latency edges (mean sigma=0) stay at 0;
    # latency edges get sigma ≥ 0.01
    _latency_mask = means_arr[None, :, 2] > 0  # (1, n_edges)
    draws[:, :, 2] = np.where(
        _latency_mask,
        np.clip(draws[:, :, 2], 0.01, 20.0),
        0.0,
    )

    # ── Run DP per draw ───────────────────────────────────────────────
    cdf_arr = np.zeros((num_draws, T), dtype=np.float64)
    p_s = np.zeros(num_draws, dtype=np.float64)

    for s in range(num_draws):
        params: Dict[Tuple[str, str], Tuple[float, float, float, float]] = {}
        for i, key in enumerate(edge_keys):
            params[key] = (
                float(draws[s, i, 0]),
                float(draws[s, i, 1]),
                float(draws[s, i, 2]),
                float(draws[s, i, 3]),
            )
        K = _run_dp(topo, params, max_tau)
        span_p_draw = float(K[-1]) if len(K) > 0 else 0.0
        p_s[s] = span_p_draw

        # Normalise to [0, 1] CDF for the row builder
        if span_p_draw > 0:
            cdf_arr[s, :] = K / span_p_draw
        else:
            cdf_arr[s, :] = 0.0

    return cdf_arr, p_s
