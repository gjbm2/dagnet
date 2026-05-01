"""Shared carrier composition primitive (73m Stage 2).

Composes a factorised ``carrier_to_x`` from an anchor node, denominator
node, upstream topology, and a set of resolved transition primitives.

The primitive's contract is **composition**, not resolution. Inputs are
``TransitionPrimitive`` objects keyed by edge; the composer convolves
them along the A → X topology to produce reach + a conditional CDF +
horizon diagnostics. It does not reach back into the graph or the
resolver to fetch raw fields itself — that's the job of a separate
``resolve_transitions_from_graph`` helper that callers may use as the
default Phase-1 source of transitions.

This split is deliberate. 73n will replace the prior/source-layer
``TransitionPrimitive`` instances with posterior-conditioned ones
resolved from admitted ``window(U-V)`` evidence; the composer will
consume those without further change. Empirical Tier-2 carrier
replacement is not the intended Phase-2 abstraction either — evidence
binds to transition primitives, and carriers and subjects are composed
from those primitives rather than admitting separate raw evidence
families on either object.

Phase 1 scope (this file): prior/composition only. The composer must
NOT select empirical observations, admit carrier evidence, or replace
prior timing from observed arrivals — even when wired in via the
default resolver helper.

Reuse:
- ``span_kernel._build_span_topology`` for the A → X subgraph extraction.
- ``span_kernel.compose_span_kernel`` for deterministic kernel composition.
  Crucially, ``_edge_sub_probability_density`` already handles σ = 0 as
  a Dirac at τ = 0 (line 108-113 of ``span_kernel.py``), so a non-latency
  edge contributes the convolution identity. An all-non-latency A → X
  chain therefore yields a Dirac-at-zero CDF at X with reach equal to
  the topological product of edge probabilities — exactly what 73m
  §"Stage 1" bullet 3 requires.
- ``span_kernel.mc_span_cdfs`` for per-draw MC carrier CDFs.

The conditional CDF is derived as ``K(τ) / topological_reach`` so it
saturates to 1.0 at large τ. Reach is kept as a separate scalar.
Consumers must multiply by reach exactly once when they need joint
mass — see 73m §"Mathematical invariants".

Horizon adequacy compares K[max_tau] against the topological reach
(K[y][∞]). Below the 0.95 blocking floor the composer refuses by
returning a ``horizon_inadequate``-tagged carrier with
``deterministic_cdf = None``; consumers must surface this rather than
silently truncate.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Tuple

import numpy as np

from .model_resolver import resolve_model_params
from .span_kernel import (
    SpanKernel,
    SpanTopology,
    _build_span_topology,
    compose_span_kernel,
    mc_span_cdfs,
)


# 73m §"Mathematical invariants" — horizon adequacy thresholds for unit
# fixtures and live diagnostic paths.
HORIZON_NEAR_SATURATION = 0.99
HORIZON_BLOCKING_FLOOR = 0.95


@dataclass
class TransitionPrimitive:
    """Per-edge transition object the carrier composer consumes.

    Phase 1 instances come from the default resolver helper
    (prior/source-layer values via ``resolve_model_params``). Phase 2
    (73n) instances will be posterior-conditioned from admitted
    ``window(U-V)`` evidence and slot into the same composer call
    unchanged.

    Fields:
      - ``p, mu, sigma, onset``: point-estimate transition mean. ``sigma
        = 0`` is a structurally non-latency edge (Dirac at τ = 0).
      - ``p_sd, mu_sd, sigma_sd, onset_sd``: per-edge dispersion SDs for
        MC draws. Zero is acceptable (degenerate / point-estimate edge).
      - ``source``: short provenance label. Free-form, but the default
        helper writes one of ``'prior_analytic'`` / ``'prior_bayesian'``
        / ``'prior_unresolved'`` / ``'prior_synthetic'``. 73n will
        introduce a posterior label.
    """
    p: float
    mu: float
    sigma: float
    onset: float
    p_sd: float = 0.0
    mu_sd: float = 0.0
    sigma_sd: float = 0.0
    onset_sd: float = 0.0
    source: str = 'prior_synthetic'


@dataclass
class CarrierDiagnostics:
    """Horizon-adequacy and provenance diagnostics for a composed carrier.

    Held in a separate dataclass so the identity / no-path /
    horizon-inadequate cases each carry self-describing tier strings,
    and so consumers can read provenance without unpacking the carrier
    itself.
    """
    horizon_ratio: float
    horizon_status: str           # 'saturated' | 'warn' | 'inadequate'
    tier: str                     # 'composed' | 'identity' | 'horizon_inadequate' | 'no_path'
    composed_edges: int
    has_latency_edge: bool
    transition_source: str        # aggregate transition-source label across composed edges
    note: str = ''


@dataclass
class CarrierToX:
    """Factorised carrier from anchor A to denominator X.

    Field separation per 73m §"Stage 2" return-shape contract:
      - ``reach``: scalar topological probability A → X (sum-over-paths).
      - ``deterministic_cdf``: conditional CDF, saturates to 1.0 (NOT
        scaled by reach). ``None`` for identity / no-path /
        horizon-inadequate cases.
      - ``mc_cdf``: per-draw conditional CDFs, ``None`` when no
        ``rng``/``num_draws`` were provided.
      - ``diagnostics``: tier provenance, transition-source label,
        horizon adequacy.
      - ``max_tau``: grid horizon used for composition.

    The conditional CDF is the carrier's timing object; reach is its
    mass scalar. Consumers must multiply reach exactly once when they
    need joint mass. The plan forbids folding reach into the CDF —
    doing so re-introduces ``Y / A`` semantics where the displayed rate
    should be ``Y / X``.
    """
    reach: float
    deterministic_cdf: Optional[np.ndarray]
    mc_cdf: Optional[np.ndarray]
    diagnostics: CarrierDiagnostics
    max_tau: int

    @property
    def is_identity(self) -> bool:
        return self.diagnostics.tier == 'identity'

    @property
    def is_active(self) -> bool:
        return self.diagnostics.tier == 'composed'

    @property
    def is_horizon_inadequate(self) -> bool:
        return self.diagnostics.tier == 'horizon_inadequate'


def compose_carrier_to_x(
    *,
    graph: Dict[str, Any],
    anchor_node_id: Optional[str],
    denominator_node_id: Optional[str],
    is_window: bool,
    transitions: Optional[Dict[Tuple[str, str], TransitionPrimitive]] = None,
    max_tau: int = 400,
    num_draws: Optional[int] = None,
    rng: Optional[np.random.Generator] = None,
    graph_preference: Optional[str] = None,
) -> CarrierToX:
    """Compose the factorised A → X carrier per 73m §"Stage 2".

    Args:
        graph: Scenario graph dict (nodes/edges).
        anchor_node_id: Cohort anchor A. Either the node ``id`` or the
            ``uuid``; resolved against the graph's node table.
        denominator_node_id: Subject from-node X (target_edge.from_node
            for live cohort_maturity dispatches). Same id/uuid handling.
        is_window: True for window mode — short-circuits to the identity
            carrier regardless of upstream topology.
        transitions: Pre-resolved per-edge transition primitives keyed
            by ``(from_id, to_id)`` over the A → X topology. When
            ``None``, the default resolver helper
            (``resolve_transitions_from_graph``) is invoked. The split
            lets 73n inject posterior-conditioned primitives without
            changing the composer.
        max_tau: Horizon for the integer τ grid (days). Composition
            convolution truncates beyond this.
        num_draws: Optional MC sample count. When provided alongside
            ``rng``, the composer populates ``mc_cdf``.
        rng: Optional ``numpy.random.Generator`` for MC draws.
        graph_preference: Forwarded to the default resolver helper;
            ignored when ``transitions`` is supplied directly.

    Returns:
        ``CarrierToX``. The diagnostics tier classifies the result:
          - ``identity``: window mode or A == X (degenerate carrier).
          - ``composed``: active, horizon adequate.
          - ``horizon_inadequate``: refusal — composing on this horizon
            would silently truncate >5% of eventual mass.
          - ``no_path``: A → X has no resolvable path / probability.
    """
    if is_window:
        return _identity_carrier(max_tau, note='window mode')

    if not anchor_node_id or not denominator_node_id:
        return _identity_carrier(max_tau, note='missing anchor or denominator')

    anchor_canonical = _canonicalise_node_id(graph, anchor_node_id)
    x_canonical = _canonicalise_node_id(graph, denominator_node_id)
    if anchor_canonical == x_canonical:
        return _identity_carrier(max_tau, note='A = X (anchor equals denominator)')

    topo = _build_span_topology(graph, anchor_canonical, x_canonical)
    if topo is None:
        return _no_path_carrier(
            max_tau,
            note=f'no path {anchor_canonical} → {x_canonical}',
        )

    if transitions is None:
        transitions = resolve_transitions_from_graph(
            graph, topo, graph_preference=graph_preference,
        )
    if transitions is None:
        return _no_path_carrier(
            max_tau,
            note='one or more edges in A → X failed to resolve to a '
                 'positive-probability transition primitive',
        )

    # The span_kernel API consumes flat (p, mu, sigma, onset) tuples.
    # Translate the structured TransitionPrimitive inputs at the seam.
    edge_params: Dict[Tuple[str, str], Tuple[float, float, float, float]] = {}
    edge_sds: Dict[Tuple[str, str], Tuple[float, float, float, float]] = {}
    for edge_key, primitive in transitions.items():
        edge_params[edge_key] = (
            float(primitive.p),
            float(primitive.mu),
            float(primitive.sigma),
            float(primitive.onset),
        )
        edge_sds[edge_key] = (
            float(primitive.p_sd),
            float(primitive.mu_sd),
            float(primitive.sigma_sd),
            float(primitive.onset_sd),
        )

    # Topological reach: sum-over-paths product of edge probabilities,
    # independent of horizon truncation. K[y][∞] would equal this in the
    # limit; horizon adequacy is the ratio K[y][max_tau] / topological_reach.
    topological_reach = _topological_reach(topo, edge_params)
    if topological_reach <= 0:
        return _no_path_carrier(max_tau, note='topological reach is zero')

    kernel = compose_span_kernel(topo, edge_params, max_tau=max_tau)
    if kernel is None or kernel.span_p <= 0:
        return _no_path_carrier(max_tau, note='span kernel returned no mass')

    horizon_ratio = float(kernel.span_p / topological_reach)
    has_latency = any(
        primitive.sigma > 0 for primitive in transitions.values()
    )
    transition_source = _aggregate_transition_source(transitions)

    if horizon_ratio < HORIZON_BLOCKING_FLOOR:
        return CarrierToX(
            reach=0.0,
            deterministic_cdf=None,
            mc_cdf=None,
            diagnostics=CarrierDiagnostics(
                horizon_ratio=horizon_ratio,
                horizon_status='inadequate',
                tier='horizon_inadequate',
                composed_edges=len(transitions),
                has_latency_edge=has_latency,
                transition_source=transition_source,
                note=(
                    f'K[max_tau]/reach = {horizon_ratio:.4f} < '
                    f'{HORIZON_BLOCKING_FLOOR} blocking floor '
                    f'(max_tau={max_tau})'
                ),
            ),
            max_tau=max_tau,
        )

    conditional_cdf = np.clip(
        np.asarray(kernel.K, dtype=float) / topological_reach,
        0.0,
        1.0,
    )

    mc_cdf: Optional[np.ndarray] = None
    if rng is not None and num_draws is not None and num_draws > 0:
        mc_cdf_per_draw, _per_draw_p = mc_span_cdfs(
            topo, edge_params, edge_sds, max_tau, int(num_draws), rng,
        )
        # ``mc_span_cdfs`` already normalises each row by its per-draw
        # span_p so ``cdf_arr ∈ [0, 1]`` saturates to 1.0 — it is
        # already conditional. Reach stays as a separate scalar.
        mc_cdf = np.clip(np.asarray(mc_cdf_per_draw, dtype=float), 0.0, 1.0)

    horizon_status = (
        'saturated' if horizon_ratio >= HORIZON_NEAR_SATURATION else 'warn'
    )

    return CarrierToX(
        reach=topological_reach,
        deterministic_cdf=conditional_cdf,
        mc_cdf=mc_cdf,
        diagnostics=CarrierDiagnostics(
            horizon_ratio=horizon_ratio,
            horizon_status=horizon_status,
            tier='composed',
            composed_edges=len(transitions),
            has_latency_edge=has_latency,
            transition_source=transition_source,
            note='',
        ),
        max_tau=max_tau,
    )


def resolve_transitions_from_graph(
    graph: Dict[str, Any],
    topology: SpanTopology,
    *,
    graph_preference: Optional[str] = None,
) -> Optional[Dict[Tuple[str, str], TransitionPrimitive]]:
    """Default Phase-1 transition resolver.

    Walks ``topology.edge_list`` and converts each graph edge into a
    ``TransitionPrimitive`` via the central ``resolve_model_params``
    entry. The carrier composer calls this when the caller did not
    supply explicit ``transitions``; 73n will replace it (or supply
    ``transitions`` directly) with a posterior-conditioned variant.

    Returns ``None`` when ANY edge fails to resolve to a positive
    probability — a missing transition makes the chain non-composable,
    and silent skipping would yield a partial carrier with the wrong
    reach.

    Note: this helper deliberately does NOT route through
    ``read_edge_cohort_params``. That wrapper drops σ = 0 edges
    (model_resolver.py:657-658), which would preclude carrier
    composition through non-latency upstream segments. Routing through
    ``resolve_model_params`` directly preserves σ = 0 (the span-kernel
    primitive then handles it as a Dirac at τ = 0). The plan §"Stage 2"
    rule "may be given per-edge resolved parameters from the same
    resolver path used by subject-span construction" is satisfied:
    both subject-span and carrier composition route through the same
    ``resolve_model_params`` entry.
    """
    transitions: Dict[Tuple[str, str], TransitionPrimitive] = {}

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
        if not (math.isfinite(p_mean) and p_mean > 0):
            return None

        lat = resolved.latency
        mu = float(lat.mu) if math.isfinite(lat.mu) else 0.0
        sigma = (
            float(lat.sigma) if (math.isfinite(lat.sigma) and lat.sigma >= 0)
            else 0.0
        )
        onset = (
            float(lat.onset_delta_days)
            if math.isfinite(lat.onset_delta_days) else 0.0
        )

        source_label = (
            f'prior_{resolved.source}' if resolved.source else 'prior_unresolved'
        )

        transitions[(from_id, to_id)] = TransitionPrimitive(
            p=p_mean,
            mu=mu,
            sigma=sigma,
            onset=onset,
            p_sd=float(resolved.p_sd or 0.0),
            mu_sd=float(lat.mu_sd or 0.0),
            sigma_sd=float(lat.sigma_sd or 0.0),
            onset_sd=float(lat.onset_sd or 0.0),
            source=source_label,
        )

    if not transitions:
        return None

    return transitions


# ── Internals ──────────────────────────────────────────────────────────


def _identity_carrier(max_tau: int, *, note: str) -> CarrierToX:
    return CarrierToX(
        reach=1.0,
        deterministic_cdf=None,
        mc_cdf=None,
        diagnostics=CarrierDiagnostics(
            horizon_ratio=1.0,
            horizon_status='saturated',
            tier='identity',
            composed_edges=0,
            has_latency_edge=False,
            transition_source='identity',
            note=note,
        ),
        max_tau=max_tau,
    )


def _no_path_carrier(max_tau: int, *, note: str) -> CarrierToX:
    return CarrierToX(
        reach=0.0,
        deterministic_cdf=None,
        mc_cdf=None,
        diagnostics=CarrierDiagnostics(
            horizon_ratio=0.0,
            horizon_status='inadequate',
            tier='no_path',
            composed_edges=0,
            has_latency_edge=False,
            transition_source='none',
            note=note,
        ),
        max_tau=max_tau,
    )


def _canonicalise_node_id(graph: Dict[str, Any], node_id: str) -> str:
    """Resolve a node id-or-uuid to its canonical id, mirroring
    ``_build_span_topology``'s ``uuid_to_id`` table.
    """
    for node in graph.get('nodes', []):
        nid = str(node.get('id') or '')
        nuuid = str(node.get('uuid') or '')
        if node_id in (nid, nuuid):
            return nid or nuuid
    return str(node_id)


def _topological_reach(
    topology: SpanTopology,
    edge_params: Dict[Tuple[str, str], Tuple[float, float, float, float]],
) -> float:
    """Sum-over-paths topological reach from ``topology.x_node_id`` to
    ``topology.y_node_id``, computed by DP on the topology.

    Independent of the τ horizon — this is K[y][∞], the reach the
    span-kernel composition would converge to with infinite max_tau.
    """
    reach_at: Dict[str, float] = {topology.x_node_id: 1.0}
    for node in topology.topo_order:
        if node == topology.x_node_id:
            continue
        node_reach = 0.0
        for from_id in topology.reverse_adj.get(node, []):
            if from_id not in topology.on_path:
                continue
            key = (from_id, node)
            if key not in edge_params:
                continue
            p_edge = edge_params[key][0]
            node_reach += reach_at.get(from_id, 0.0) * p_edge
        reach_at[node] = node_reach
    return float(reach_at.get(topology.y_node_id, 0.0))


def _aggregate_transition_source(
    transitions: Dict[Tuple[str, str], TransitionPrimitive],
) -> str:
    """Collapse a heterogeneous mix of transition sources into one label.

    Returns the unique source when all transitions agree, otherwise a
    comma-separated breakdown — useful for diagnostics that need to
    distinguish "all prior_analytic" from "mixed prior + posterior" in
    a future Phase-2 world.
    """
    sources = sorted({t.source for t in transitions.values()})
    if not sources:
        return 'unknown'
    if len(sources) == 1:
        return sources[0]
    return ','.join(sources)
