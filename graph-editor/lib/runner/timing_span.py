"""Role-neutral timing-span composition.

This module is the shared timing algebra under both prefix-arrival
evidence clocks and runtime carrier/subject spans. Callers choose the
semantic root/end pair and provide edge timing/probability data; this
module owns the DAG density DP and conditional-CDF construction.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, Mapping, Optional, Tuple

import numpy as np

from .bucket_transition import BucketSourceBasis
from .span_kernel import (
    ConcreteEdge,
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
    latency_parameter: Optional[bool] = None
    p_sd: float = 0.0
    mu_sd: float = 0.0
    sigma_sd: float = 0.0
    onset_sd: float = 0.0
    onset_mu_corr: float = 0.0
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


def _zero_latency_if_not_latent(
    mu: float,
    sigma: float,
    onset: float,
    latency_parameter: Optional[bool],
) -> Tuple[float, float, float]:
    """Zero out latency moments when the edge is explicitly non-latent.

    Branch-free: ``latency_parameter is not False`` is True for True and
    None (default-latent), False only for explicit False. The float
    mask leaves latent moments untouched and zeros non-latent ones.
    """
    mask = float(latency_parameter is not False)
    return mu * mask, sigma * mask, onset * mask


def compose_timing_span_from_densities(
    *,
    graph: Mapping[str, Any],
    root_node_id: str,
    end_node_id: str,
    densities: Mapping[Tuple[str, str], np.ndarray],
    max_tau: int,
    expected_reach: float,
    transition_source: str = 'unknown',
    topology: Optional[SpanTopology] = None,
    cdf_renorm_tolerance: float = 1e-6,
) -> TimingSpan:
    """Compose timing from supplied per-edge sub-probability densities.

    ``densities`` values already include edge reach/probability mass and
    must be 1-D arrays of length ``max_tau + 1``. The returned conditional
    CDF is normalised by the caller-supplied ``expected_reach`` (the
    horizon-independent reach probability).
    """
    topo = topology or _build_span_topology(
        dict(graph), str(root_node_id), str(end_node_id)
    )

    T = max_tau + 1
    aligned: Dict[Tuple[str, str], np.ndarray] = {
        key: np.asarray(density, dtype=np.float32) for key, density in densities.items()
    }

    density_cdf = _run_dp_density_grid(topo, aligned, T)
    finite_reach = float(density_cdf[-1]) if T > 0 else 0.0
    reach = float(expected_reach)

    horizon_ratio = float(finite_reach / reach) if reach > 0 else 0.0

    conditional_cdf = density_cdf / reach
    topology_case = 'identity' if not topo.edge_list else 'composed'
    resolved_transition_source = (
        'identity' if topology_case == 'identity' else transition_source
    )
    provenance = {
        'binding_policy': 'timing_span.density.v1',
        'topology_node_count': len(topo.on_path),
        'topology_edge_count': len(topo.edge_list),
    }

    return TimingSpan(
        root_node_id=topo.x_node_id,
        end_node_id=topo.y_node_id,
        reach=reach,
        conditional_cdf=conditional_cdf,
        density_cdf=density_cdf,
        mc_cdf=None,
        max_tau=max_tau,
        topology_case=topology_case,
        horizon_ratio=horizon_ratio,
        composed_edges=len(topo.edge_list),
        has_latency_edge=_has_latency_density(aligned),
        transition_source=resolved_transition_source,
        provenance=provenance,
    )


def _build_transition_primitive_edge_data(
    *,
    topo: SpanTopology,
    transitions: Mapping[Tuple[str, str], Any],
    max_tau: int,
) -> Tuple[
    Dict[Tuple[str, str], np.ndarray],  # densities
    Dict[Tuple[str, str], float],  # edge_probabilities
    Dict[Tuple[str, str], Tuple[float, float, float, float]],  # edge_params (p, mu, sigma, onset)
    Dict[Tuple[str, str], Tuple[float, float, float, float]],  # edge_sds
    str,  # transition_source
]:
    """Walk topology edges, build per-edge density + parameter dicts."""
    tau_grid = np.arange(max_tau + 1, dtype=np.float32)
    densities: Dict[Tuple[str, str], np.ndarray] = {}
    edge_probabilities: Dict[Tuple[str, str], float] = {}
    edge_params: Dict[Tuple[str, str], Tuple[float, float, float, float]] = {}
    edge_sds: Dict[Tuple[str, str], Tuple[float, float, float, float]] = {}
    sources = set()
    for from_id, to_id, _edge_data in topo.edge_list:
        primitive = transitions[(from_id, to_id)]
        p = float(primitive.p)
        mu, sigma, onset = _zero_latency_if_not_latent(
            float(primitive.mu),
            float(primitive.sigma),
            float(primitive.onset),
            primitive.latency_parameter,
        )
        densities[(from_id, to_id)] = _edge_sub_probability_density(
            tau_grid, p, onset, mu, sigma,
        )
        edge_probabilities[(from_id, to_id)] = p
        edge_params[(from_id, to_id)] = (p, mu, sigma, onset)
        edge_sds[(from_id, to_id)] = (
            float(primitive.p_sd),
            float(primitive.mu_sd),
            float(primitive.sigma_sd),
            float(primitive.onset_sd),
        )
        sources.add(str(primitive.source))
    transition_source = (
        next(iter(sources)) if len(sources) == 1
        else ','.join(sorted(sources)) if sources
        else 'unknown'
    )
    return densities, edge_probabilities, edge_params, edge_sds, transition_source


def compose_timing_span_from_transition_primitives(
    *,
    graph: Mapping[str, Any],
    root_node_id: str,
    end_node_id: str,
    transitions: Mapping[Tuple[str, str], Any],
    max_tau: int,
) -> TimingSpan:
    """Compose timing from resolved/source-layer transition primitives.

    The transition objects are expected to expose ``p``, ``mu``,
    ``sigma``, ``onset``, and ``source`` attributes. This keeps the
    timing algebra independent of the concrete carrier-composition
    dataclass while preserving the current pre-conditioning provider.
    """
    topo = _build_span_topology(dict(graph), str(root_node_id), str(end_node_id))
    densities, edge_probabilities, _, _, transition_source = (
        _build_transition_primitive_edge_data(
            topo=topo, transitions=transitions, max_tau=max_tau,
        )
    )
    return compose_timing_span_from_densities(
        graph=graph,
        root_node_id=root_node_id,
        end_node_id=end_node_id,
        densities=densities,
        max_tau=max_tau,
        expected_reach=_topological_reach(topo, edge_probabilities),
        transition_source=transition_source,
        topology=topo,
    )


def compose_timing_span_from_transition_primitives_with_mc(
    *,
    graph: Mapping[str, Any],
    root_node_id: str,
    end_node_id: str,
    transitions: Mapping[Tuple[str, str], Any],
    max_tau: int,
    num_draws: int,
    rng: np.random.Generator,
    min_horizon_ratio: float = 0.0,
) -> TimingSpan:
    """Same as ``compose_timing_span_from_transition_primitives`` with an
    MC overlay attached. Callers that want MC reconvolution call this
    variant directly; the base entry has no MC param shape.

    ``min_horizon_ratio`` lets the caller skip MC reconvolution when the
    timing won't pass their downstream horizon gate anyway. Default
    ``0.0`` always runs MC; callers iterating many nodes (e.g.
    ``forecast_state``) pass their own floor so per-draw work isn't
    spent on results that will be discarded.
    """
    topo = _build_span_topology(dict(graph), str(root_node_id), str(end_node_id))
    densities, edge_probabilities, edge_params, edge_sds, transition_source = (
        _build_transition_primitive_edge_data(
            topo=topo, transitions=transitions, max_tau=max_tau,
        )
    )
    timing = compose_timing_span_from_densities(
        graph=graph,
        root_node_id=root_node_id,
        end_node_id=end_node_id,
        densities=densities,
        max_tau=max_tau,
        expected_reach=_topological_reach(topo, edge_probabilities),
        transition_source=transition_source,
        topology=topo,
    )
    # MC overlay is only meaningful for composed (non-identity) paths
    # that pass the caller's horizon floor. Skipping the per-draw
    # reconvolution for identity / sub-floor cases avoids paying
    # ``mc_span_cdfs`` cost for results the caller will discard.
    if not timing.is_composed or timing.horizon_ratio < min_horizon_ratio:
        return timing
    mc_cdf, _p_draws = mc_span_cdfs(
        topo, edge_params, edge_sds, max_tau, int(num_draws), rng,
    )
    return TimingSpan(
        root_node_id=timing.root_node_id,
        end_node_id=timing.end_node_id,
        reach=timing.reach,
        conditional_cdf=timing.conditional_cdf,
        density_cdf=timing.density_cdf,
        mc_cdf=np.asarray(mc_cdf, dtype=np.float32),
        max_tau=timing.max_tau,
        topology_case=timing.topology_case,
        horizon_ratio=timing.horizon_ratio,
        composed_edges=timing.composed_edges,
        has_latency_edge=timing.has_latency_edge,
        transition_source=timing.transition_source,
        provenance=timing.provenance,
    )


def resolve_timing_transitions_from_graph(
    graph: Mapping[str, Any],
    topology: SpanTopology,
    *,
    graph_preference: Optional[str] = None,
) -> Dict[Tuple[str, str], TimingTransitionPrimitive]:
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
        p_mean = float(resolved.p_mean)
        lat = resolved.latency
        sigma = float(lat.sigma)
        mu, sigma, onset = _zero_latency_if_not_latent(
            float(lat.mu),
            sigma,
            float(lat.onset_delta_days),
            lat.latency_parameter,
        )
        transitions[(from_id, to_id)] = TimingTransitionPrimitive(
            p=p_mean,
            mu=mu,
            sigma=sigma,
            onset=onset,
            latency_parameter=lat.latency_parameter,
            p_sd=float(resolved.p_sd),
            mu_sd=float(lat.mu_sd),
            sigma_sd=float(lat.sigma_sd),
            onset_sd=float(lat.onset_sd),
            onset_mu_corr=float(getattr(lat, 'onset_mu_corr', 0.0) or 0.0),
            source=f'prior_{resolved.source}',
        )
    return transitions


def compose_timing_span_from_graph(
    *,
    graph: Mapping[str, Any],
    root_node_id: str,
    end_node_id: str,
    max_tau: int,
    graph_preference: Optional[str] = None,
) -> TimingSpan:
    """Resolve source-layer transitions and compose timing in one call."""
    topo = _build_span_topology(dict(graph), str(root_node_id), str(end_node_id))
    transitions = resolve_timing_transitions_from_graph(
        graph,
        topo,
        graph_preference=graph_preference,
    )
    return compose_timing_span_from_transition_primitives(
        graph=graph,
        root_node_id=root_node_id,
        end_node_id=end_node_id,
        transitions=transitions,
        max_tau=max_tau,
    )


def compose_timing_span_from_graph_with_mc(
    *,
    graph: Mapping[str, Any],
    root_node_id: str,
    end_node_id: str,
    max_tau: int,
    num_draws: int,
    rng: np.random.Generator,
    graph_preference: Optional[str] = None,
    min_horizon_ratio: float = 0.0,
) -> TimingSpan:
    """``compose_timing_span_from_graph`` + MC overlay reconvolution.

    Use when the caller needs per-draw MC bands attached to the
    deterministic timing surface. ``min_horizon_ratio`` lets the caller
    suppress MC for sub-floor timings — see the underlying entry's
    docstring.
    """
    topo = _build_span_topology(dict(graph), str(root_node_id), str(end_node_id))
    transitions = resolve_timing_transitions_from_graph(
        graph, topo, graph_preference=graph_preference,
    )
    return compose_timing_span_from_transition_primitives_with_mc(
        graph=graph,
        root_node_id=root_node_id,
        end_node_id=end_node_id,
        transitions=transitions,
        max_tau=max_tau,
        num_draws=num_draws,
        rng=rng,
        min_horizon_ratio=min_horizon_ratio,
    )


SEED_ORIGIN_KEY = '__seed__'


@dataclass(frozen=True)
class SpanDPTrace:
    """Per-node and per-edge ledger produced by the forward DAG DP.

    Source-bucket-aware: contributions and arrivals are stored keyed by
    bucket so frontier-occupancy work (Atom 4+) can derive
    ``L_f(node, source_bucket)`` from state rather than from terminal
    row totals. Basis provenance is preserved per contributing edge so
    merge points retain each incoming edge's ``BucketSourceBasis``
    rather than collapsing under last-write-wins.

    - ``node_density_by_node_bucket[node][arrival_bucket]`` — per-draw
      mass that arrived at ``node`` at row-age column ``arrival_bucket``.
      Each entry is a ``(S,)`` per-draw array (the value at column
      ``arrival_bucket``). For the topology root, the seed is split by
      non-zero column; the typical δ(0) seed materialises as a single
      bucket-0 entry.
    - ``edge_contribution_by_edge_source[edge_key][source_bucket]`` —
      per-(draw, τ) mass flowing through ``edge_key`` derived from the
      source-node bucket ``source_bucket``. Each entry is a smeared
      ``(S, T)`` array (the kernel output is distributed across columns
      starting at ``source_bucket``). Coincident sibling edges have
      separate entries.
    - ``node_basis_by_node_bucket[node][arrival_bucket][provenance_key]``
      — basis carried into ``node`` at column ``arrival_bucket`` by each
      contributing provenance. ``provenance_key`` is ``SEED_ORIGIN_KEY``
      for the root seed, or ``{edge_key}@{basis_int}`` for an edge
      contribution — the same composite shape regardless of whether the
      edge produced one or many output bases. A latent edge lands a
      single entry per destination column (one output basis); a
      non-latent edge consuming mixed source bases lands one entry per
      output basis at the same destination column. Each value is an
      ``int`` (``BucketSourceBasis``) equal to the basis encoded in the
      key, so downstream frontier-state construction (Atom 4) can either
      key off ``provenance_key`` or read ``[provenance_key]`` directly.
    - ``node_mass_by_provenance[node][arrival_bucket][provenance_key]``
      — per-draw ``(S,)`` mass delivered into ``node`` at column
      ``arrival_bucket`` by each contributing provenance. Mirrors
      ``node_basis_by_node_bucket`` exactly: every entry in either
      surface has a matching entry in the other. The collapsed mass
      view ``node_density(node)`` is the sum-over-provenance of these
      per-provenance entries. Required for chained DPs that need to
      preserve mixed basis across a span handoff: the next DP's seed
      reads this surface directly so each provenance continues to
      drive its own kernel call.
    - ``node_density(node)`` / ``edge_contribution(edge_key)`` /
      ``node_basis(node)`` — collapsed helpers. ``node_basis`` returns
      the legacy ``(T,)`` per-column basis view (per arrival bucket,
      picks the last-inserted edge_key — matches prior
      ``last-write-wins`` semantics for callers that still feed a flat
      ``root_basis`` into chained DPs). Provenance-aware consumers must
      read ``node_basis_by_node_bucket`` directly.

    Density and contribution surfaces are densities (NOT cumulative).
    The terminal CDF is ``cumsum(node_density(end))``; the cumulative
    is a projection, not part of the DP state.
    """
    node_density_by_node_bucket: Mapping[str, Mapping[int, np.ndarray]]
    edge_contribution_by_edge_source: Mapping[str, Mapping[int, np.ndarray]]
    node_basis_by_node_bucket: Mapping[str, Mapping[int, Mapping[str, int]]]
    node_mass_by_provenance: Mapping[str, Mapping[int, Mapping[str, np.ndarray]]]
    draw_count: int
    horizon_len: int

    def node_density(self, node: str) -> np.ndarray:
        """Collapsed per-(draw, τ) arrival density at ``node``.

        Sums the per-arrival-bucket entries onto their respective
        columns. Nodes off the topology raise ``KeyError``; on-path
        nodes with no arrivals degenerate to the empty sum.
        """
        out = np.zeros((self.draw_count, self.horizon_len), dtype=np.float32)
        for arrival_col, col_mass in self.node_density_by_node_bucket[node].items():
            out[:, int(arrival_col)] += col_mass
        return out

    def edge_contribution(self, edge_key: str) -> np.ndarray:
        """Collapsed per-(draw, τ) mass through ``edge_key``.

        Sums the per-source-bucket smears. Edges off the topology raise
        ``KeyError``; concrete edges with no flow degenerate to the
        empty sum.
        """
        out = np.zeros((self.draw_count, self.horizon_len), dtype=np.float32)
        for smear in self.edge_contribution_by_edge_source[edge_key].values():
            out += smear
        return out

    def node_basis(self, node: str) -> np.ndarray:
        """Collapsed per-column basis view for ``node``.

        Per arrival bucket, picks the basis of the last-inserted
        provenance entry — equivalent to the prior ``last-write-wins``
        semantics over edge iteration order. Columns with no
        provenance default to ``POINT_AT_ENDPOINT``. Exists so callers
        that still feed a flat ``root_basis=(T,)`` parameter into a
        chained DP have a shape-compatible view; the canonical surface
        is ``node_basis_by_node_bucket``.
        """
        out = np.full(
            self.horizon_len,
            int(BucketSourceBasis.POINT_AT_ENDPOINT),
            dtype=np.int8,
        )
        for arrival_bucket, provenance_map in self.node_basis_by_node_bucket[node].items():
            out[int(arrival_bucket)] = next(reversed(provenance_map.values()))
        return out


class DPExecutionPolicy(Enum):
    """Execution strategy for the canonical ledger DP, declared at the
    call site as data flowing into the DP core.

    The DP core has a single dispatch on this enum at its entry: it
    selects an applier function via ``_make_operator_applier`` and uses
    that applier uniformly for every (edge, basis) pair inside the
    topological loop. The DP body itself contains no capability
    branching, no fallback reasoning, no `if provider has X` checks —
    the strategy is data, picked at the call site by whoever knows
    what kind of kernel they built.

    Strategies are interchangeable implementations of one mathematical
    operator: applying an edge kernel to per-(node, basis) source mass
    to produce destination contribution. They must be numerically
    identical on their domain of compatibility (plan §1042-1044); the
    parity-matrix tests in
    ``test_dp_execution_policy_parity.py`` enforce this by execution.

    Compatibility constraints by policy:

    - ``SCALAR``: always works. The provider is callable as
      ``(ce, source_index, cohort_index, source_basis) -> kernel`` (or
      ``(kernel, out_basis)``). The mathematical floor every other
      policy must match. Used by the synthetic-lambda call in
      ``_run_dp_density_trace`` and as the SCALAR side of the parity
      matrix.

    - ``TOEPLITZ_APPLY``: provider exposes
      ``.batched_op(ce, source_basis, source_mass_3d) -> (out_3d, out_basis)``
      and applies the kernel to all source buckets at once via a
      shift-invariant Toeplitz contraction. Valid only when the kernel
      is shift-invariant in the per-source-bucket sense. Per-source-
      bucket smears for ``edge_contribution_by_edge_source`` are NOT
      extracted under this policy — consumers needing per-bucket edge
      contribution must use SCALAR or SOURCE_BANDED.

    - ``SOURCE_BANDED``: provider exposes
      ``.source_banded_op(ce, source_basis, source_mass_3d)
      -> (out_3d, out_basis, smear_map)`` and applies the kernel to
      all active source buckets at once via a source-indexed banded
      contraction ``out[c, d, v] = Σ_u mass[c, d, u] · K[c, d, u, v − u]``.
      Per FC plan §1093 / §1180 this is the source-day-specific fast
      path for empirical evidence kernels: ``K`` may vary in ``u``
      (each source bucket carries its own row), so TOEPLITZ_APPLY's
      shift-invariance assumption does not hold. Per §1107 per-source-
      bucket smears ARE extracted under this policy (unlike
      TOEPLITZ_APPLY) — frontier occupancy consumes the per-edge per-
      source smear. Memory budgeting (chunk-on-active-u per §1111) is
      the provider's responsibility.

    A provider that cannot honour the declared policy raises
    ``AttributeError`` at applier construction. There is no silent
    fallback to a different policy (semantics §12: failures degrade
    visibly).
    """
    SCALAR = 'scalar'
    TOEPLITZ_APPLY = 'toeplitz_apply'
    SOURCE_BANDED = 'source_banded'


# Applier callable signature: given an edge, the source-node basis, and
# the aggregated per-(node, basis) source mass ``(cohort, draw, T)``,
# return the destination contribution ``(cohort, draw, T)``, the output
# basis, and an optional per-source-bucket smear map for
# ``edge_contribution_by_edge_source`` (empty under TOEPLITZ_APPLY).
OperatorApplier = Callable[
    [ConcreteEdge, BucketSourceBasis, np.ndarray],
    Tuple[np.ndarray, BucketSourceBasis, Mapping[int, np.ndarray]],
]


def _edge_default_out_basis(ce: ConcreteEdge) -> BucketSourceBasis:
    """Output basis derived from an edge's documented latency metadata.

    Used to normalise bare-kernel provider returns (where the provider
    omits the ``(kernel, out_basis)`` tuple). Per the production graph
    schema convention (model_resolver.py:325; model_span_spine.py
    :1597-1602 docstring), absent ``latency_parameter`` means LATENT
    (BUCKET_DISTRIBUTED). Only an explicit ``False`` flips the edge
    to POINT_AT_ENDPOINT.

    Defence at ``ce.edge_data.get('p') or {}`` matches the legacy
    inline pattern this helper replaces (the pre-atom-4c.B body of
    ``_run_dp_density_trace_from_ledger``). Inherited debt — the
    schema perimeter should guarantee ``ce.edge_data['p']['latency']``
    is populated for parameterised edges; until then, test fixtures
    constructed without a ``p`` block degenerate to LATENT here. See
    ``cf-defensive-findings.md`` for the broader perimeter audit.
    """
    latency = (ce.edge_data.get('p') or {}).get('latency') or {}
    if latency.get('latency_parameter') is False:
        return BucketSourceBasis.POINT_AT_ENDPOINT
    return BucketSourceBasis.BUCKET_DISTRIBUTED


def _make_scalar_applier(
    provider: Callable,
    *,
    cohort_count: int,
    S_per_cohort: int,
    T: int,
) -> OperatorApplier:
    """SCALAR applier: one provider call per ``(source bucket, cohort)``.

    Provider is callable as
    ``provider(ce, source_index, cohort_index, source_basis)
    -> (kernel, out_basis)`` where the kernel has shape
    ``(S_per_cohort, T - source_index)``. The applier loops over active
    source buckets in the input ``source_mass_3d`` and, for each, over
    cohorts; per-cohort kernel result is multiplied into the destination
    smear.
    """
    S = cohort_count * S_per_cohort

    def apply(
        ce: ConcreteEdge,
        source_basis: BucketSourceBasis,
        source_mass_3d: np.ndarray,
    ) -> Tuple[np.ndarray, BucketSourceBasis, Mapping[int, np.ndarray]]:
        out_3d = np.zeros((cohort_count, S_per_cohort, T), dtype=np.float32)
        smear_map: Dict[int, np.ndarray] = {}
        active_buckets = np.flatnonzero(
            np.any(source_mass_3d != 0.0, axis=(0, 1))
        )
        out_basis_final = _edge_default_out_basis(ce)
        for u_int_np in active_buckets:
            u_int = int(u_int_np)
            remaining = T - u_int
            smear = np.zeros((S, T), dtype=np.float32)
            smear_3d = smear.reshape(cohort_count, S_per_cohort, T)
            for cohort_idx in range(cohort_count):
                kernel, out_basis = provider(
                    ce, u_int, cohort_idx, source_basis,
                )
                out_basis_final = BucketSourceBasis(int(out_basis))
                bucket_mass = source_mass_3d[cohort_idx, :, u_int]
                smear_3d[cohort_idx, :, u_int:] = (
                    bucket_mass[:, None] * np.asarray(kernel, dtype=np.float32)[:, :remaining]
                )
            out_3d += smear_3d
            smear_map[u_int] = smear
        return out_3d, out_basis_final, smear_map

    return apply


def _make_toeplitz_applier(
    provider: Callable,
    *,
    cohort_count: int,
    S_per_cohort: int,
    T: int,
) -> OperatorApplier:
    """TOEPLITZ_APPLY applier: one provider call per ``(edge, basis)``;
    the provider applies the kernel to all source buckets at once via
    a shift-invariant Toeplitz contraction.

    Provider MUST expose ``batched_op(ce, source_basis, source_mass_3d)
    -> (out_3d, out_basis)`` where ``source_mass_3d`` has shape
    ``(cohort_count, S_per_cohort, T)`` and ``out_3d`` has the same
    shape. Per-source-bucket smears are NOT extracted under this
    policy — consumers needing per-bucket edge contribution must use
    SCALAR or SOURCE_BANDED.

    Missing ``batched_op`` attribute raises ``AttributeError`` at
    applier construction (no silent fallback to a different policy).
    """
    batched_op = provider.batched_op

    def apply(
        ce: ConcreteEdge,
        source_basis: BucketSourceBasis,
        source_mass_3d: np.ndarray,
    ) -> Tuple[np.ndarray, BucketSourceBasis, Mapping[int, np.ndarray]]:
        out_3d, provided_basis = batched_op(
            ce, source_basis, source_mass_3d,
        )
        out_basis = BucketSourceBasis(int(provided_basis))
        out_arr = np.asarray(out_3d, dtype=np.float32).reshape(
            cohort_count, S_per_cohort, T,
        )
        return out_arr, out_basis, {}

    return apply


def _make_source_banded_applier(
    provider: Callable,
    *,
    cohort_count: int,
    S_per_cohort: int,
    T: int,
) -> OperatorApplier:
    """SOURCE_BANDED applier: one provider call per ``(edge, basis)``
    that applies the kernel to all active source buckets at once via a
    source-indexed banded contraction.

    Provider MUST expose ``source_banded_op(ce, source_basis,
    source_mass_3d) -> (out_3d, out_basis, smear_map)`` where:

      - ``source_mass_3d`` has shape ``(cohort_count, S_per_cohort, T)``
      - ``out_3d`` has the same shape — the contracted destination
        contribution ``Σ_u mass[c, d, u] · K[c, d, u, v − u]``
      - ``out_basis`` is a ``BucketSourceBasis``
      - ``smear_map`` is a ``Dict[int, ndarray]`` of ``(S, T)``
        per-source-bucket smears (``S = cohort_count × S_per_cohort``,
        flat row axis) — the per-edge per-source contribution the DP
        body lands into ``edge_contribution_by_edge_source[edge_key]``

    Per FC plan §1107, smear maps ARE extracted under this policy —
    frontier occupancy consumes the per-edge per-source smear.

    Missing ``source_banded_op`` attribute raises ``AttributeError`` at
    applier construction (no silent fallback to a different policy).
    """
    source_banded_op = provider.source_banded_op

    def apply(
        ce: ConcreteEdge,
        source_basis: BucketSourceBasis,
        source_mass_3d: np.ndarray,
    ) -> Tuple[np.ndarray, BucketSourceBasis, Mapping[int, np.ndarray]]:
        out_3d, provided_basis, smear_map = source_banded_op(
            ce, source_basis, source_mass_3d,
        )
        out_basis = BucketSourceBasis(int(provided_basis))
        out_arr = np.asarray(out_3d, dtype=np.float32).reshape(
            cohort_count, S_per_cohort, T,
        )
        return out_arr, out_basis, dict(smear_map)

    return apply


def _make_operator_applier(
    policy: DPExecutionPolicy,
    provider: Callable,
    *,
    cohort_count: int,
    S_per_cohort: int,
    T: int,
) -> OperatorApplier:
    """Factory: synthesise the policy-matched applier exactly once per
    DP invocation. The DP body calls the returned applier uniformly,
    with no policy-aware branching.
    """
    if policy is DPExecutionPolicy.SCALAR:
        return _make_scalar_applier(
            provider, cohort_count=cohort_count,
            S_per_cohort=S_per_cohort, T=T,
        )
    if policy is DPExecutionPolicy.TOEPLITZ_APPLY:
        return _make_toeplitz_applier(
            provider, cohort_count=cohort_count,
            S_per_cohort=S_per_cohort, T=T,
        )
    if policy is DPExecutionPolicy.SOURCE_BANDED:
        return _make_source_banded_applier(
            provider, cohort_count=cohort_count,
            S_per_cohort=S_per_cohort, T=T,
        )
    raise ValueError(f'Unknown DPExecutionPolicy: {policy!r}')


def _run_dp_density_trace(
    topo: SpanTopology,
    edge_kernel_provider: Callable[[ConcreteEdge, int], np.ndarray],
    S: int,
    T: int,
) -> SpanDPTrace:
    """Forward DAG DP that retains per-node arrival density and per-edge
    contribution. Kernels are provided per concrete edge and source-day
    index so coincident siblings and source-day-specific masks remain
    distinct.

    The DP shape is uniform: pre-initialise every on-path node's density
    to a zero ``(S, T)`` array, seed the root with δ(0) as part of
    initialisation, then iterate the topological order accumulating
    shifted edge-kernel contributions into the destination node's density
    for every incoming concrete edge.

    This wrapper synthesises a basis-/cohort-blind scalar provider
    lambda from the caller's ``(ce, source_index) -> kernel`` callable.
    The synthetic provider has no ``.batched`` or ``.batched_op``
    attribute, so ``DPExecutionPolicy.SCALAR`` is the only valid
    policy — hardcoded here as a self-contained translation, not
    delegated to the caller.
    """
    root_density = np.zeros((S, T), dtype=np.float32)
    root_density[:, 0] = 1.0
    root_basis = np.full(
        T,
        int(BucketSourceBasis.POINT_AT_ENDPOINT),
        dtype=np.int8,
    )
    return _run_dp_density_trace_from_seed(
        topo,
        lambda ce, source_index, _cohort_index, _source_basis: (
            edge_kernel_provider(ce, source_index),
            _edge_default_out_basis(ce),
        ),
        root_density,
        S,
        T,
        root_basis=root_basis,
        execution_policy=DPExecutionPolicy.SCALAR,
    )


def _run_dp_density_trace_from_seed(
    topo: SpanTopology,
    edge_kernel_provider: Callable[[ConcreteEdge, int, int, BucketSourceBasis], np.ndarray],
    root_density: np.ndarray,
    S: int,
    T: int,
    *,
    execution_policy: DPExecutionPolicy,
    cohort_count: int = 1,
    root_basis: Optional[np.ndarray] = None,
) -> SpanDPTrace:
    """Root-seeded adapter over the canonical ledger-input DP core.

    Same algebra as ``_run_dp_density_trace``; the topology root starts
    from ``root_density`` instead of δ(0).

    ``cohort_count`` lets multiple cohorts share one DP pass. The row
    axis of ``root_density`` is interpreted as ``(cohort, draw)``
    flattened — ``S`` is the flat row count, ``S // cohort_count`` is
    the per-cohort draw count. The provider is uniformly cohort-aware
    and returns a relative-coordinate kernel of shape
    ``(S_per_cohort, T)`` for ``(edge, source_index, cohort_index)``.

    Collapsed ``(root_density, root_basis)`` form only. When ``root_basis``
    is omitted the basis defaults to ``POINT_AT_ENDPOINT`` for every
    non-zero column. The seed is translated into a single
    ``SEED_ORIGIN_KEY`` provenance per non-zero column and the DP runs
    through the canonical ledger core. Callers that already hold a
    per-bucket per-provenance ledger (carrier → subject handoff,
    empirical seed) call ``_run_dp_density_trace_from_provenance_seed``
    instead.
    """
    root_density_arr = np.asarray(root_density, dtype=np.float32)
    root_basis_arr = np.asarray(
        root_basis if root_basis is not None
        else np.full(T, int(BucketSourceBasis.POINT_AT_ENDPOINT), dtype=np.int8),
        dtype=np.int8,
    )
    root_active_cols = np.flatnonzero(np.any(root_density_arr != 0.0, axis=0))
    bucket_mass: Dict[int, Dict[str, np.ndarray]] = {}
    bucket_basis: Dict[int, Dict[str, int]] = {}
    for col in root_active_cols:
        col_int = int(col)
        bucket_mass[col_int] = {
            SEED_ORIGIN_KEY: root_density_arr[:, col_int].copy(),
        }
        bucket_basis[col_int] = {
            SEED_ORIGIN_KEY: int(root_basis_arr[col_int]),
        }
    return _run_dp_density_trace_from_provenance_seed(
        topo,
        edge_kernel_provider,
        root_provenance_mass=bucket_mass,
        root_provenance_basis=bucket_basis,
        S=S,
        T=T,
        execution_policy=execution_policy,
        cohort_count=cohort_count,
    )


def _run_dp_density_trace_from_provenance_seed(
    topo: SpanTopology,
    edge_kernel_provider: Callable[[ConcreteEdge, int, int, BucketSourceBasis], np.ndarray],
    *,
    root_provenance_mass: Mapping[int, Mapping[str, np.ndarray]],
    root_provenance_basis: Mapping[int, Mapping[str, int]],
    S: int,
    T: int,
    execution_policy: DPExecutionPolicy,
    cohort_count: int = 1,
) -> SpanDPTrace:
    """Provenance-seeded adapter over the canonical ledger-input DP core.

    Each provenance entry at the root keeps its own ``(S,)`` mass and
    basis so chained DPs (carrier → subject across a span handoff,
    empirical-evidence seed) preserve mixed basis through the join.
    Callers with a collapsed ``(root_density, root_basis)`` seed call
    ``_run_dp_density_trace_from_seed`` instead.
    """
    return _run_dp_density_trace_from_ledger(
        topo,
        edge_kernel_provider,
        initial_node_provenance_mass={topo.x_node_id: root_provenance_mass},
        initial_node_provenance_basis={topo.x_node_id: root_provenance_basis},
        S=S,
        T=T,
        execution_policy=execution_policy,
        cohort_count=cohort_count,
    )


def _run_dp_density_trace_from_ledger(
    topo: SpanTopology,
    edge_kernel_provider: Callable[[ConcreteEdge, int, int, BucketSourceBasis], np.ndarray],
    *,
    initial_node_provenance_mass: Mapping[str, Mapping[int, Mapping[str, np.ndarray]]],
    initial_node_provenance_basis: Mapping[str, Mapping[int, Mapping[str, int]]],
    S: int,
    T: int,
    execution_policy: DPExecutionPolicy,
    cohort_count: int = 1,
) -> SpanDPTrace:
    """Canonical forward DAG DP with caller-supplied per-node initial ledgers.

    Input state is ``node → arrival_bucket → provenance_key → (S,) mass``
    plus the matching basis surface. There is no privileged root: the
    topology root is just one (possibly empty) entry in the input
    ledger. Empty entries do not contribute; populated entries seed
    their node's running ledger directly and propagate through the
    same topological edge loop the root-seeded path uses. This is the
    single algebra; root-seeded evaluation (subject / carrier span
    composition) and frontier-ledger continuation (FC §5.4) are
    adapters that present caller-natural inputs in this shape.

    The caller declares ``execution_policy`` — the operator-application
    strategy to use for every (edge, basis) pair. The factory
    ``_make_operator_applier`` is called ONCE at DP entry to synthesise
    the policy-matched applier; the DP body then calls that applier
    uniformly, with no capability-aware branching inside the loop.
    Strategies must be mathematically identical on their domain of
    compatibility (plan §1042-1044); the parity matrix in
    ``test_dp_execution_policy_parity.py`` enforces this by execution.

    The DP iterates ``topo.topo_order`` and, for each destination
    node, every incoming on-path concrete edge. Per edge it aggregates
    the source-node provenance ledger into per-(node, basis) source
    mass tensors of shape ``(cohort, draw, T)`` (one per basis present
    at the source node) and calls the applier once per basis. The
    applier returns the destination contribution as a full
    ``(cohort, draw, T)`` tensor plus an optional per-source-bucket
    smear map. Destination mass lands keyed by
    ``{edge_key}@{out_basis}`` so the next hop's group-by-basis
    iteration finds the right basis without a data-shape case fork at
    the storage seam.

    Output is the full ``SpanDPTrace`` (node density per arrival
    bucket, edge contribution per source bucket, node basis per
    provenance, node mass per provenance). Adapters that do not need
    the per-provenance lineage (e.g. the FC continuation, where
    ``frontier@{basis}`` is the only key) read the basis-keyed
    collapsed view and discard the rest. Under ``TOEPLITZ_APPLY``
    policy, per-source-bucket edge contribution is not extracted —
    ``edge_contribution_by_edge_source[edge_key]`` is empty for every
    edge processed under that policy.

    See ``_run_dp_density_trace_from_seed`` for the root-only adapter
    and the FC continuation DP for the basis-only adapter.
    """
    # Empty-cohort degenerate: when no cohorts are selected the caller
    # may pass ``cohort_count == 0`` (e.g. FC shadow on a request whose
    # selected-cohort set is empty). ``S`` is then also zero, so the
    # DP has no mass to propagate, but ``S // 0`` would crash. Bump to
    # 1 so the per-cohort axis has unit width; ``S_per_cohort = 0 // 1
    # = 0`` gives empty (cohort, draw) tensors that fall through every
    # downstream loop as zero-iteration. This is the single point of
    # normalisation — adapters do not pre-bump.
    cohort_count_int = max(int(cohort_count), 1)
    S_per_cohort = S // cohort_count_int
    # Per-provenance source mass: node -> arrival_bucket -> provenance_key
    # -> (S,) per-draw mass. This is the running DP state: each downstream
    # edge fires once per (source_node, basis) group present, aggregating
    # provenance mass under each basis before invoking the applier. The
    # collapsed ``node_density`` view is derived at the end by summing
    # the per-provenance entries.
    node_mass_by_provenance: Dict[str, Dict[int, Dict[str, np.ndarray]]] = {
        node: {} for node in topo.on_path
    }
    # Canonical per-edge basis provenance: node -> arrival_bucket ->
    # provenance_key -> int basis. Built up alongside the mass ledger so
    # the source-basis lookup at the kernel-provider boundary reads from
    # the same surface every consumer reads. ``provenance_key`` is the
    # contributing edge_key, or ``SEED_ORIGIN_KEY`` for the root seed
    # (or whatever provenance label the caller's adapter assigned).
    node_basis_by_node_bucket: Dict[str, Dict[int, Dict[str, int]]] = {
        node: {} for node in topo.on_path
    }
    # Seed: drop each per-(node, bucket, provenance) entry into the
    # corresponding node's running ledger. Mass and basis are copied so
    # subsequent in-place accumulation inside the DP loop does not
    # mutate the caller's input. Nodes absent from the input dict
    # start empty; on-path nodes not in the input are seeded only by
    # incoming edges as the DP proceeds.
    for node, bucket_map in initial_node_provenance_mass.items():
        node_basis_map = initial_node_provenance_basis[node]
        for col, prov_mass_map in bucket_map.items():
            col_int = int(col)
            node_mass_by_provenance[node][col_int] = {
                str(prov_key): np.asarray(mass, dtype=np.float32).copy()
                for prov_key, mass in prov_mass_map.items()
            }
            node_basis_by_node_bucket[node][col_int] = dict(
                node_basis_map[col]
            )
    edge_contribution_by_edge_source: Dict[str, Dict[int, np.ndarray]] = {}

    # Single policy-aware dispatch, called once at DP entry. The DP
    # body below sees only the uniform applier interface; the strategy
    # (scalar per-bucket per-cohort; per-bucket cohort-batched kernel;
    # operator-apply Toeplitz) is encoded inside the applier the
    # factory returned. Missing provider capability for the declared
    # policy raises ``AttributeError`` here.
    apply_operator = _make_operator_applier(
        execution_policy,
        edge_kernel_provider,
        cohort_count=cohort_count_int,
        S_per_cohort=S_per_cohort,
        T=T,
    )

    for node in topo.topo_order:
        for ce in topo.incoming_concrete_edges.get(node, ()):
            source_provenance_map = node_mass_by_provenance[ce.from_id]
            from_basis_map = node_basis_by_node_bucket[ce.from_id]
            # Aggregate per-(from-node, basis) source mass. For each
            # basis present anywhere at the source node, sum the
            # contributing provenance mass per source bucket into one
            # ``(S, T)`` tensor. Single-basis nodes (the common case)
            # produce one tensor; mixed-basis nodes produce one tensor
            # per basis, dispatched independently below.
            source_mass_by_basis: Dict[int, np.ndarray] = defaultdict(
                lambda: np.zeros((S, T), dtype=np.float32),
            )
            for col_int, prov_mass_map in source_provenance_map.items():
                col_basis_map = from_basis_map[col_int]
                for prov_key, prov_mass in prov_mass_map.items():
                    basis_int = int(col_basis_map[prov_key])
                    source_mass_by_basis[basis_int][:, int(col_int)] += prov_mass
            # Apply the operator per (edge, source-basis) and
            # accumulate the destination contribution per
            # ``out_basis``. Different source bases can yield the same
            # ``out_basis`` (e.g. non-latent passthrough of mixed
            # inputs into a latent edge); their destination mass is
            # summed under one provenance key. Per-source-bucket
            # smears are accumulated basis-collapsed for
            # ``edge_contribution_by_edge_source``; the smear map is
            # empty under TOEPLITZ_APPLY by design.
            edge_dest_mass_by_out_basis: Dict[int, np.ndarray] = defaultdict(
                lambda: np.zeros((S, T), dtype=np.float32),
            )
            edge_source_smear_map: Dict[int, np.ndarray] = defaultdict(
                lambda: np.zeros((S, T), dtype=np.float32),
            )
            for basis_int, source_mass in source_mass_by_basis.items():
                source_basis = BucketSourceBasis(int(basis_int))
                source_mass_3d = source_mass.reshape(
                    cohort_count_int, S_per_cohort, T,
                )
                # Zero-draw degenerate (S_per_cohort == 0): basis-keyed
                # ledger entries seeded by FC continuation may carry
                # empty per-cohort mass when no cohorts are selected for
                # this slice. SCALAR's active-bucket loop degenerates
                # naturally; TOEPLITZ_APPLY's einsum and SOURCE_BANDED's
                # reshape both treat the zero-D axis as a contract
                # violation. Skip — the zero contribution propagates
                # downstream as the natural empty sum.
                if source_mass_3d.size == 0:
                    continue
                out_3d, out_basis, basis_smear_map = apply_operator(
                    ce, source_basis, source_mass_3d,
                )
                out_flat = np.asarray(out_3d, dtype=np.float32).reshape(
                    S, T,
                )
                edge_dest_mass_by_out_basis[int(out_basis)] += out_flat
                for src_u, smear in basis_smear_map.items():
                    edge_source_smear_map[int(src_u)] += smear
            edge_contribution_by_edge_source[ce.edge_key] = edge_source_smear_map
            # Land per-(edge, output-basis) mass into the destination's
            # per-provenance ledger. The provenance key is uniformly
            # ``{edge_key}@{basis_int}`` for every edge contribution —
            # the same shape whether the edge produced one or many
            # output bases. The latent / single-basis case lands one
            # such key per destination column; the non-latent
            # passthrough fed mixed source bases lands one key per
            # output basis at each destination column. Each entry
            # carries the basis it propagates, so the next hop's
            # group-by-basis dispatch fires once per basis branch
            # without a data-shape case fork at the storage seam.
            dest_provenance_map = node_mass_by_provenance[node]
            dest_basis_map = node_basis_by_node_bucket[node]
            for out_basis_int, dest_mass_flat in edge_dest_mass_by_out_basis.items():
                prov_key = f'{ce.edge_key}@{out_basis_int}'
                out_active = np.flatnonzero(
                    np.any(dest_mass_flat != 0.0, axis=0),
                )
                for dest_col in out_active:
                    dest_col_int = int(dest_col)
                    dest_provenance_map.setdefault(dest_col_int, {})[
                        prov_key
                    ] = dest_mass_flat[:, dest_col_int].copy()
                    dest_basis_map.setdefault(dest_col_int, {})[
                        prov_key
                    ] = out_basis_int

    # Collapsed ``node_density_by_node_bucket``: sum-over-provenance at
    # each (node, arrival_bucket). Mass numerics are identical to the
    # legacy ``node_density[node][:, col]`` derivation — the
    # per-provenance ledger is just a finer-grained partition of the
    # same totals.
    node_density_by_node_bucket: Dict[str, Dict[int, np.ndarray]] = {
        node: {
            arrival_bucket: sum(prov_map.values())
            for arrival_bucket, prov_map in bucket_map.items()
        }
        for node, bucket_map in node_mass_by_provenance.items()
    }

    return SpanDPTrace(
        node_density_by_node_bucket=node_density_by_node_bucket,
        edge_contribution_by_edge_source=edge_contribution_by_edge_source,
        node_basis_by_node_bucket=node_basis_by_node_bucket,
        node_mass_by_provenance=node_mass_by_provenance,
        draw_count=S,
        horizon_len=T,
    )


def _run_dp_density_grid(
    topo: SpanTopology,
    densities: Mapping[Tuple[str, str], np.ndarray],
    T: int,
) -> np.ndarray:
    """Terminal-CDF wrapper around `_run_dp_density_trace`.

    Legacy callers supply densities keyed by `(from_id, to_id)`; this
    adapter rebases them onto concrete edge keys (replicating the same
    density across coincident sibling edges, matching pre-trace
    behaviour for callers that have not yet migrated to per-edge keys)
    and returns `cumsum(node_density[end])`.
    """
    zero = np.zeros(T, dtype=np.float32)
    densities_by_edge_key = {
        ce.edge_key: densities.get((ce.from_id, ce.to_id), zero)[None, :]
        for ce in topo.concrete_edges
    }
    trace = _run_dp_density_trace(
        topo,
        lambda ce, _source_index: densities_by_edge_key[ce.edge_key],
        1,
        T,
    )
    return np.cumsum(trace.node_density(topo.y_node_id)[0])


def compose_terminal_node_density_per_draw(
    *,
    graph: Mapping[str, Any],
    root_node_id: str,
    end_node_id: str,
    densities_by_from_to: Mapping[Tuple[str, str], np.ndarray],
    S: int,
    T: int,
    topology: Optional[SpanTopology] = None,
) -> np.ndarray:
    """Row-batched terminal node density at ``end_node_id``.

    Same DAG DP as ``compose_timing_span_from_densities`` but operates on
    the row axis: each value of ``densities_by_from_to`` is an ``(S, T)``
    per-draw sub-probability density (already scaled by the edge's
    probability ``p``), and the returned array is the ``(S, T)`` density
    at ``end_node_id`` for every draw. One DP pass replaces the per-draw
    Python loop callers previously paid.
    """
    topo = topology or _build_span_topology(
        dict(graph), str(root_node_id), str(end_node_id)
    )
    densities_by_edge_key = {
        ce.edge_key: densities_by_from_to[(ce.from_id, ce.to_id)]
        for ce in topo.concrete_edges
    }
    trace = _run_dp_density_trace(
        topo,
        lambda ce, _source_index: densities_by_edge_key[ce.edge_key],
        int(S),
        int(T),
    )
    return trace.node_density(topo.y_node_id)


def _topological_reach(
    topology: SpanTopology,
    edge_probabilities: Mapping[Tuple[str, str], float],
) -> float:
    reach_at: Dict[str, float] = {topology.x_node_id: 1.0}
    for node in topology.topo_order[1:]:
        node_reach = 0.0
        for from_id in topology.on_path_reverse_adj.get(node, []):
            node_reach += (
                reach_at.get(from_id, 0.0)
                * float(edge_probabilities.get((from_id, node), 0.0))
            )
        reach_at[node] = node_reach
    return float(reach_at.get(topology.y_node_id, 0.0))


def _has_latency_density(
    densities: Mapping[Tuple[str, str], np.ndarray],
) -> bool:
    return any(float(np.sum(d[1:])) > 0.0 for d in densities.values())


__all__ = [
    'TimingTransitionPrimitive',
    'TimingSpan',
    'compose_timing_span_from_graph',
    'compose_timing_span_from_densities',
    'compose_timing_span_from_transition_primitives',
    'compose_terminal_node_density_per_draw',
    'resolve_timing_transitions_from_graph',
]
