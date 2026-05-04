"""Role-neutral timing-span composition.

This module is the shared timing algebra under both prefix-arrival
evidence clocks and runtime carrier/subject spans. Callers choose the
semantic root/end pair and provide edge timing/probability data; this
module owns the DAG density DP and conditional-CDF construction.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Mapping, Optional, Tuple

import numpy as np

from .span_kernel import (
    SpanTopology,
    _build_span_topology,
    _edge_sub_probability_density,
    mc_span_cdfs,
)


@dataclass(frozen=True)
class TimingTransitionPrimitive:
    p: float
    mu: float
    sigma: float
    onset: float
    p_sd: float = 0.0
    mu_sd: float = 0.0
    sigma_sd: float = 0.0
    onset_sd: float = 0.0
    source: str = 'prior_synthetic'


@dataclass(frozen=True)
class TimingSpan:
    root_node_id: str
    end_node_id: str
    reach: float
    conditional_cdf: Optional[np.ndarray]
    density_cdf: Optional[np.ndarray]
    mc_cdf: Optional[np.ndarray]
    max_tau: int
    topology_case: str
    horizon_ratio: float
    composed_edges: int
    has_latency_edge: bool
    transition_source: str
    provenance: Mapping[str, Any] = field(default_factory=dict)

    @property
    def is_identity(self) -> bool:
        return self.topology_case == 'identity'

    @property
    def is_composed(self) -> bool:
        return self.topology_case == 'composed'

    @property
    def is_degraded(self) -> bool:
        return self.topology_case == 'degraded'


def compose_timing_span_from_densities(
    *,
    graph: Mapping[str, Any],
    root_node_id: str,
    end_node_id: str,
    densities: Mapping[Tuple[str, str], np.ndarray],
    max_tau: int,
    expected_reach: Optional[float] = None,
    transition_source: str = 'unknown',
    topology: Optional[SpanTopology] = None,
    horizon_blocking_floor: Optional[float] = None,
    cdf_renorm_tolerance: float = 1e-6,
) -> TimingSpan:
    """Compose timing from supplied per-edge sub-probability densities.

    ``densities`` values already include edge reach/probability mass.
    When ``expected_reach`` is supplied, the returned conditional CDF is
    normalised by that horizon-independent reach and horizon adequacy is
    checked against it. When omitted, the finite-grid terminal mass is
    the reach, matching conditioned subject-span behaviour.
    """
    if root_node_id == end_node_id:
        return TimingSpan(
            root_node_id=str(root_node_id),
            end_node_id=str(end_node_id),
            reach=1.0,
            conditional_cdf=None,
            density_cdf=None,
            mc_cdf=None,
            max_tau=max_tau,
            topology_case='identity',
            horizon_ratio=1.0,
            composed_edges=0,
            has_latency_edge=False,
            transition_source='identity',
            provenance={'note': 'root equals end'},
        )

    topo = topology or _build_span_topology(
        dict(graph), str(root_node_id), str(end_node_id)
    )
    if topo is None or not topo.edge_list:
        return _degraded_timing(
            root_node_id=root_node_id,
            end_node_id=end_node_id,
            max_tau=max_tau,
            transition_source=transition_source,
            note='no path',
        )

    T = max_tau + 1
    aligned: Dict[Tuple[str, str], np.ndarray] = {}
    for key, density in densities.items():
        arr = np.asarray(density, dtype=np.float64)
        if arr.ndim != 1:
            raise ValueError(
                f'edge density for {key!r} must be one-dimensional; '
                f'got shape {arr.shape}'
            )
        if arr.shape[0] < T:
            arr = np.concatenate([arr, np.zeros(T - arr.shape[0])])
        elif arr.shape[0] > T:
            arr = arr[:T]
        aligned[key] = arr

    density_cdf = _run_dp_density_grid(topo, aligned, T)
    finite_reach = float(density_cdf[-1]) if T > 0 else 0.0
    reach = (
        float(expected_reach)
        if expected_reach is not None
        else finite_reach
    )
    if reach <= 0.0:
        return _degraded_timing(
            root_node_id=root_node_id,
            end_node_id=end_node_id,
            max_tau=max_tau,
            transition_source=transition_source,
            note='zero reach',
            topology=topo,
        )

    horizon_ratio = float(finite_reach / reach) if reach > 0 else 0.0
    if (
        horizon_blocking_floor is not None
        and horizon_ratio < float(horizon_blocking_floor)
    ):
        return TimingSpan(
            root_node_id=topo.x_node_id,
            end_node_id=topo.y_node_id,
            reach=0.0,
            conditional_cdf=None,
            density_cdf=density_cdf,
            mc_cdf=None,
            max_tau=max_tau,
            topology_case='degraded',
            horizon_ratio=horizon_ratio,
            composed_edges=len(topo.edge_list),
            has_latency_edge=_has_latency_density(aligned),
            transition_source=transition_source,
            provenance={
                'note': (
                    f'horizon inadequate '
                    f'(ratio={horizon_ratio:.4f})'
                ),
                'binding_policy': 'timing_span.density.v1',
            },
        )

    conditional_cdf = np.clip(density_cdf / reach, 0.0, 1.0)
    if finite_reach > cdf_renorm_tolerance and expected_reach is None:
        conditional_cdf = np.clip(density_cdf / finite_reach, 0.0, 1.0)

    return TimingSpan(
        root_node_id=topo.x_node_id,
        end_node_id=topo.y_node_id,
        reach=reach,
        conditional_cdf=conditional_cdf,
        density_cdf=density_cdf,
        mc_cdf=None,
        max_tau=max_tau,
        topology_case='composed',
        horizon_ratio=horizon_ratio,
        composed_edges=len(topo.edge_list),
        has_latency_edge=_has_latency_density(aligned),
        transition_source=transition_source,
        provenance={
            'binding_policy': 'timing_span.density.v1',
            'topology_node_count': len(topo.on_path),
            'topology_edge_count': len(topo.edge_list),
        },
    )


def compose_timing_span_from_transition_primitives(
    *,
    graph: Mapping[str, Any],
    root_node_id: str,
    end_node_id: str,
    transitions: Mapping[Tuple[str, str], Any],
    max_tau: int,
    horizon_blocking_floor: Optional[float] = None,
    num_draws: Optional[int] = None,
    rng: Optional[np.random.Generator] = None,
) -> TimingSpan:
    """Compose timing from resolved/source-layer transition primitives.

    The transition objects are expected to expose ``p``, ``mu``,
    ``sigma``, ``onset``, and ``source`` attributes. This keeps the
    timing algebra independent of the concrete carrier-composition
    dataclass while preserving the current pre-conditioning provider.
    """
    if root_node_id == end_node_id:
        return compose_timing_span_from_densities(
            graph=graph,
            root_node_id=root_node_id,
            end_node_id=end_node_id,
            densities={},
            max_tau=max_tau,
            transition_source='identity',
        )

    topo = _build_span_topology(dict(graph), str(root_node_id), str(end_node_id))
    if topo is None or not topo.edge_list:
        return _degraded_timing(
            root_node_id=root_node_id,
            end_node_id=end_node_id,
            max_tau=max_tau,
            transition_source='none',
            note='no path',
        )

    tau_grid = np.arange(max_tau + 1, dtype=float)
    densities: Dict[Tuple[str, str], np.ndarray] = {}
    edge_probabilities: Dict[Tuple[str, str], float] = {}
    edge_params: Dict[Tuple[str, str], Tuple[float, float, float, float]] = {}
    edge_sds: Dict[Tuple[str, str], Tuple[float, float, float, float]] = {}
    sources = set()
    for from_id, to_id, _edge_data in topo.edge_list:
        primitive = transitions.get((from_id, to_id))
        if primitive is None:
            return _degraded_timing(
                root_node_id=root_node_id,
                end_node_id=end_node_id,
                max_tau=max_tau,
                transition_source='missing_transition',
                note=f'missing transition {from_id}->{to_id}',
                topology=topo,
            )
        p = float(getattr(primitive, 'p', 0.0) or 0.0)
        mu = float(getattr(primitive, 'mu', 0.0) or 0.0)
        sigma = float(getattr(primitive, 'sigma', 0.0) or 0.0)
        onset = float(getattr(primitive, 'onset', 0.0) or 0.0)
        densities[(from_id, to_id)] = _edge_sub_probability_density(
            tau_grid,
            p,
            onset,
            mu,
            sigma,
        )
        edge_probabilities[(from_id, to_id)] = p
        edge_params[(from_id, to_id)] = (p, mu, sigma, onset)
        edge_sds[(from_id, to_id)] = (
            float(getattr(primitive, 'p_sd', 0.0) or 0.0),
            float(getattr(primitive, 'mu_sd', 0.0) or 0.0),
            float(getattr(primitive, 'sigma_sd', 0.0) or 0.0),
            float(getattr(primitive, 'onset_sd', 0.0) or 0.0),
        )
        sources.add(str(getattr(primitive, 'source', 'unknown')))

    expected_reach = _topological_reach(topo, edge_probabilities)
    transition_source = (
        next(iter(sources)) if len(sources) == 1
        else ','.join(sorted(sources)) if sources
        else 'unknown'
    )
    timing = compose_timing_span_from_densities(
        graph=graph,
        root_node_id=root_node_id,
        end_node_id=end_node_id,
        densities=densities,
        max_tau=max_tau,
        expected_reach=expected_reach,
        transition_source=transition_source,
        topology=topo,
        horizon_blocking_floor=horizon_blocking_floor,
    )
    if (
        timing.is_composed
        and rng is not None
        and num_draws is not None
        and int(num_draws) > 0
    ):
        mc_cdf, _p_draws = mc_span_cdfs(
            topo,
            edge_params,
            edge_sds,
            max_tau,
            int(num_draws),
            rng,
        )
        return TimingSpan(
            root_node_id=timing.root_node_id,
            end_node_id=timing.end_node_id,
            reach=timing.reach,
            conditional_cdf=timing.conditional_cdf,
            density_cdf=timing.density_cdf,
            mc_cdf=np.clip(np.asarray(mc_cdf, dtype=float), 0.0, 1.0),
            max_tau=timing.max_tau,
            topology_case=timing.topology_case,
            horizon_ratio=timing.horizon_ratio,
            composed_edges=timing.composed_edges,
            has_latency_edge=timing.has_latency_edge,
            transition_source=timing.transition_source,
            provenance=timing.provenance,
        )
    return timing


def resolve_timing_transitions_from_graph(
    graph: Mapping[str, Any],
    topology: SpanTopology,
    *,
    graph_preference: Optional[str] = None,
) -> Optional[Dict[Tuple[str, str], TimingTransitionPrimitive]]:
    """Resolve graph edges into timing transition primitives."""
    from .model_resolver import resolve_model_params

    transitions: Dict[Tuple[str, str], TimingTransitionPrimitive] = {}
    for from_id, to_id, edge_data in topology.edge_list:
        resolved = resolve_model_params(
            edge_data,
            scope='path',
            temporal_mode='cohort',
            graph_preference=graph_preference,
        )
        if resolved is None:
            return None
        p_mean = float(resolved.p_mean) if resolved.p_mean else 0.0
        if p_mean <= 0.0:
            a = float(getattr(resolved, 'alpha', 0.0) or 0.0)
            b = float(getattr(resolved, 'beta', 0.0) or 0.0)
            if (a + b) > 0.0:
                p_mean = a / (a + b)
        if not np.isfinite(p_mean) or p_mean <= 0.0:
            return None
        lat = resolved.latency
        transitions[(from_id, to_id)] = TimingTransitionPrimitive(
            p=p_mean,
            mu=float(lat.mu) if lat.mu is not None else 0.0,
            sigma=(
                float(lat.sigma)
                if (lat.sigma is not None and lat.sigma >= 0)
                else 0.0
            ),
            onset=(
                float(lat.onset_delta_days)
                if lat.onset_delta_days is not None else 0.0
            ),
            p_sd=float(resolved.p_sd or 0.0),
            mu_sd=float(lat.mu_sd or 0.0),
            sigma_sd=float(lat.sigma_sd or 0.0),
            onset_sd=float(lat.onset_sd or 0.0),
            source=(
                f'prior_{resolved.source}'
                if resolved.source else 'prior_unresolved'
            ),
        )
    return transitions or None


def compose_timing_span_from_graph(
    *,
    graph: Mapping[str, Any],
    root_node_id: str,
    end_node_id: str,
    max_tau: int,
    graph_preference: Optional[str] = None,
    horizon_blocking_floor: Optional[float] = None,
    num_draws: Optional[int] = None,
    rng: Optional[np.random.Generator] = None,
) -> TimingSpan:
    """Resolve source-layer transitions and compose timing in one call."""
    if root_node_id == end_node_id:
        return compose_timing_span_from_densities(
            graph=graph,
            root_node_id=root_node_id,
            end_node_id=end_node_id,
            densities={},
            max_tau=max_tau,
            transition_source='identity',
        )
    topo = _build_span_topology(dict(graph), str(root_node_id), str(end_node_id))
    if topo is None or not topo.edge_list:
        return _degraded_timing(
            root_node_id=root_node_id,
            end_node_id=end_node_id,
            max_tau=max_tau,
            transition_source='none',
            note='no path',
        )
    transitions = resolve_timing_transitions_from_graph(
        graph,
        topo,
        graph_preference=graph_preference,
    )
    if transitions is None:
        return _degraded_timing(
            root_node_id=root_node_id,
            end_node_id=end_node_id,
            max_tau=max_tau,
            transition_source='missing_transition',
            note='one or more transitions failed to resolve',
            topology=topo,
        )
    return compose_timing_span_from_transition_primitives(
        graph=graph,
        root_node_id=root_node_id,
        end_node_id=end_node_id,
        transitions=transitions,
        max_tau=max_tau,
        horizon_blocking_floor=horizon_blocking_floor,
        num_draws=num_draws,
        rng=rng,
    )


def _run_dp_density_grid(
    topo: SpanTopology,
    densities: Mapping[Tuple[str, str], np.ndarray],
    T: int,
) -> np.ndarray:
    g: Dict[str, np.ndarray] = {}
    g[topo.x_node_id] = np.zeros(T, dtype=np.float64)
    g[topo.x_node_id][0] = 1.0

    for node in topo.topo_order:
        if node == topo.x_node_id:
            continue
        node_density = np.zeros(T, dtype=np.float64)
        for from_id in topo.reverse_adj.get(node, []):
            if from_id not in topo.on_path or from_id not in g:
                continue
            f_edge = densities.get((from_id, node))
            if f_edge is None or f_edge.shape[0] == 0:
                continue
            node_density += np.convolve(g[from_id], f_edge)[:T]
        g[node] = node_density

    if topo.y_node_id not in g:
        return np.zeros(T, dtype=np.float64)
    return np.cumsum(g[topo.y_node_id])


def _topological_reach(
    topology: SpanTopology,
    edge_probabilities: Mapping[Tuple[str, str], float],
) -> float:
    reach_at: Dict[str, float] = {topology.x_node_id: 1.0}
    for node in topology.topo_order:
        if node == topology.x_node_id:
            continue
        node_reach = 0.0
        for from_id in topology.reverse_adj.get(node, []):
            if from_id not in topology.on_path:
                continue
            node_reach += (
                reach_at.get(from_id, 0.0)
                * float(edge_probabilities.get((from_id, node), 0.0))
            )
        reach_at[node] = node_reach
    return float(reach_at.get(topology.y_node_id, 0.0))


def _has_latency_density(
    densities: Mapping[Tuple[str, str], np.ndarray],
) -> bool:
    for density in densities.values():
        if density.shape[0] > 1 and float(np.sum(density[1:])) > 0.0:
            return True
    return False


def _degraded_timing(
    *,
    root_node_id: str,
    end_node_id: str,
    max_tau: int,
    transition_source: str,
    note: str,
    topology: Optional[SpanTopology] = None,
) -> TimingSpan:
    return TimingSpan(
        root_node_id=str(root_node_id),
        end_node_id=str(end_node_id),
        reach=0.0,
        conditional_cdf=None,
        density_cdf=None,
        mc_cdf=None,
        max_tau=max_tau,
        topology_case='degraded',
        horizon_ratio=0.0,
        composed_edges=len(topology.edge_list) if topology is not None else 0,
        has_latency_edge=False,
        transition_source=transition_source,
        provenance={
            'binding_policy': 'timing_span.density.v1',
            'note': note,
        },
    )


__all__ = [
    'TimingTransitionPrimitive',
    'TimingSpan',
    'compose_timing_span_from_graph',
    'compose_timing_span_from_densities',
    'compose_timing_span_from_transition_primitives',
    'resolve_timing_transitions_from_graph',
]
