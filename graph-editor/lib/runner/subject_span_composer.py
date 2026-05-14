"""
Primitive-span composer.

Composes ``compose_primitive_span(root -> end)`` over conditioned
transition primitives along the topology, using the existing doc-29b /
``span_kernel`` DAG algebra (serial convolution, parallel sums, joins,
ordinary leakage). Used by both subject (``X -> end``) and active
carrier (``A -> X``) roles — role identity is data on the call, not a
separate composer.

Contract source of truth:
docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md
§"Multi-Hop Subject Span Composition" lines 684-698; with
algebra reuse from §"Mathematical Invariants" §429-431, §"Composition
pass" §358-370.

Critical invariants this module pins:

  - No fallback to a terminal-edge primitive when more than one primitive
    is on the span (plan §696). The DP runs over every edge in the span
    topology.
  - Draw indices ``s`` are stable across primitives. The
    ``RequestPrimitiveRegistry`` (``primitive_evidence.RequestPrimitiveRegistry``)
    is responsible for guaranteeing one primitive per
    ``(transition, scope, prefix-arrival identity)`` and for populating
    every primitive at the same draw count ``S``. The composer only
    enforces local checks.
  - Every constructed primitive is draw-bearing by contract (status
    refusals are made before primitive construction, not after). The
    composer always runs the per-draw DP and produces per-draw output;
    there is no draw/no-draw fork.
  - Probability and conditional timing are kept separate. Reach affects
    counts and denominator mass; it does NOT multiply displayed subject
    rates (plan §441).
  - DP algebra is delegated to ``timing_span`` for per-draw primitive
    composition, so prefix-arrival and runtime spans share one timing
    implementation.
  - Single-hop is the natural degeneracy: a one-edge span yields the
    same composed result as the underlying primitive (plan §364).

This module imports:

  - ``span_kernel`` for ``SpanTopology`` and ``_build_span_topology``
  - ``primitives`` (Stage 1) for the primitive contract types
  - ``primitive_evidence`` (Stage 2) for the request-scoped registry

It does NOT import ``forecast_runtime``, ``forecast_state``, or
``cohort_forecast_v3``. The composer is a pure runtime function over
Stage 1 contracts; callers own the integration glue.
"""

from __future__ import annotations

import sys as _sys
from dataclasses import dataclass, field
from pathlib import Path as _Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

import numpy as np

# result_cache lives in graph-editor/lib (not under runner/). Reach it
# without restructuring the package.
_lib_dir = str(_Path(__file__).resolve().parents[1])
if _lib_dir not in _sys.path:
    _sys.path.insert(0, _lib_dir)
import result_cache  # noqa: E402

from .primitive_evidence import RequestPrimitiveRegistry
from .primitives import (
    ConditionedTransitionPrimitive,
    TimingFamily,
)
from .span_kernel import ConcreteEdge, SpanTopology, _build_span_topology
from .timing_span import (
    SpanDPTrace,
    _run_dp_density_trace,
    _topological_reach,
)


# Process-memory cache for compose_primitive_span. Keyed by topology +
# the in-process identity (id()) of each consumed primitive. The
# primitive cache upstream guarantees stable identity across calls for
# the same scope; when it is flushed the new primitives get fresh ids
# and this cache misses correctly. Registered under the shared registry
# so snapshot-write bustcache and the no_cache:true ContextVar suppress
# us alongside every other cache.
_subject_span_cache = result_cache.make_cache(
    'composed_subject_span',
    ttl_s=15 * 60,
    max_entries=512,
)


def _subject_span_cache_key(
    *,
    x_node_id: str,
    end_node_id: str,
    topology: SpanTopology,
    edge_primitives: List[
        Tuple[ConcreteEdge, ConditionedTransitionPrimitive]
    ],
    options: 'ComposeOptions',
) -> str:
    """Cache key for ``compose_primitive_span``.

    Topology and per-edge primitive identities are keyed by the stable
    concrete edge key so coincident sibling edges receive distinct
    cache slots. Per-edge ``id(primitive)`` pins the primitive object
    identity in the live process; when the upstream primitive cache is
    flushed (via the snapshot-write bustcache) new primitive instances
    are minted with new ids and this cache misses correctly.
    """
    topo_edges = tuple(ce.edge_key for ce in topology.concrete_edges)
    primitives_signature = tuple(
        (ce.edge_key, id(prim)) for ce, prim in edge_primitives
    )
    return result_cache.make_key(
        'compose_primitive_span',
        x_node=x_node_id,
        end_node=end_node_id,
        topology_edges=topo_edges,
        primitives=primitives_signature,
        max_tau=int(options.max_tau),
        cdf_renorm_tolerance=float(options.cdf_renorm_tolerance),
    )


# ─── Public dataclasses ────────────────────────────────────────────────


@dataclass(frozen=True)
class ComposedPrimitiveSpan:
    """Composed primitive span.

    Exposes the composed span probability (reach) and conditional timing
    CDF as moments and per-draw arrays. In addition, every per-node
    arrival density and per-concrete-edge contribution computed by the
    forward DAG DP is retained as `(S, T)` surfaces so downstream
    callers can read mass at intermediate nodes or through specific
    concrete edges without recomposing.

    Surfaces:

    - `span_p_*`, `cdf_*` — terminal asymptotic reach and conditional
      timing CDF (the legacy surfaces; unchanged by the per-node /
      per-edge extension).
    - `node_density_draws[node_id]` — per-day arrival density at the
      named node, per draw. δ at τ=0 at the topology root.
    - `edge_contribution_draws[edge_key]` — per-day mass flowing
      through the named concrete edge, per draw. Coincident sibling
      edges have separate entries.
    - `concrete_edges` — topology metadata describing every concrete
      edge in this span (including its `edge_key`).

    All retained surfaces are densities (NOT cumulative). Cumulative
    value, cumulative support, and coverage ratio are downstream
    projection helpers on `model_span_spine`.
    """
    x_node_id: str
    end_node_id: str
    primitive_count: int
    draw_count: int

    span_p_mean: float
    span_p_sd: float
    span_p_draws: np.ndarray

    cdf_mean: np.ndarray
    cdf_draws: np.ndarray

    max_tau: int

    node_density_draws: Mapping[str, np.ndarray] = field(default_factory=dict)
    edge_contribution_draws: Mapping[str, np.ndarray] = field(default_factory=dict)
    node_support_draws: Mapping[str, np.ndarray] = field(default_factory=dict)
    edge_support_contribution_draws: Mapping[str, np.ndarray] = field(default_factory=dict)
    node_exposure_draws: Mapping[str, np.ndarray] = field(default_factory=dict)
    edge_exposure_contribution_draws: Mapping[str, np.ndarray] = field(default_factory=dict)
    concrete_edges: Tuple[ConcreteEdge, ...] = field(default_factory=tuple)

    provenance: Mapping[str, Any] = field(default_factory=dict)

    @property
    def reach(self) -> float:
        """Role-neutral span reach/probability.

        Carrier callers can read this as A→X reach; subject callers read
        the same value as X→end span probability.
        """
        return float(self.span_p_mean)

    @property
    def deterministic_cdf(self) -> np.ndarray:
        """Role-neutral conditional timing CDF."""
        return self.cdf_mean

    @property
    def is_active(self) -> bool:
        """True when the composed span has positive reach."""
        return self.reach > 0.0

    @classmethod
    def identity(
        cls,
        *,
        x_node_id: str,
        end_node_id: str,
        max_tau: int,
        draw_count: int,
        provenance: Mapping[str, Any],
    ) -> "ComposedPrimitiveSpan":
        """Identity element of the operator-chain monoid: a zero-edge walk.

        Reach is the empty product (1.0); timing is "arrived at τ=0"
        (CDF of ones). Per-draw arrays are shape-``(draw_count, T)`` filled
        with ones — the algebraic identity replicated along the S axis so
        downstream composition with active spans sees a uniform shape and
        does not need supply-boundary shape inspections. The per-node
        ledger carries δ(0) at the root node across all draws; there are
        no concrete edges and no per-edge contributions.
        """
        T = int(max_tau) + 1
        S = int(draw_count)
        root_density = np.zeros((S, T), dtype=np.float64)
        root_density[:, 0] = 1.0
        # Support and exposure share the seed at the root per Phase 6
        # §4.8: the cohort itself IS the observation at the chain root.
        # The two streams diverge from value only where downstream
        # kernels mask cells out.
        root_support = root_density.copy()
        root_exposure = root_density.copy()
        return cls(
            x_node_id=x_node_id,
            end_node_id=end_node_id,
            primitive_count=0,
            draw_count=S,
            span_p_mean=1.0,
            span_p_sd=0.0,
            span_p_draws=np.ones(S, dtype=np.float64),
            cdf_mean=np.ones(T, dtype=np.float64),
            cdf_draws=np.ones((S, T), dtype=np.float64),
            max_tau=max_tau,
            node_density_draws={x_node_id: root_density},
            edge_contribution_draws={},
            node_support_draws={x_node_id: root_support},
            edge_support_contribution_draws={},
            node_exposure_draws={x_node_id: root_exposure},
            edge_exposure_contribution_draws={},
            concrete_edges=(),
            provenance=provenance,
        )


@dataclass(frozen=True)
class ComposeOptions:
    """Knobs for the composer.

    ``max_tau`` is the composed CDF grid horizon. It must be at least as
    long as any primitive's CDF grid; shorter primitive CDFs are padded
    with their saturation value (1.0 for the conditional CDF), longer
    primitive CDFs are truncated to ``max_tau``.
    """
    max_tau: int = 400
    cdf_renorm_tolerance: float = 1e-6
    draw_count: int = 0


class CompositionError(Exception):
    """Raised when composition cannot proceed because a hard invariant is
    violated (no path X→end, missing primitive for an edge that the
    topology requires, draw-count mismatch)."""


# ─── Public composer entry point ───────────────────────────────────────


def compose_primitive_span(
    *,
    graph: Mapping[str, Any],
    x_node_id: str,
    end_node_id: str,
    registry: RequestPrimitiveRegistry,
    edge_to_primitive_lookup,
    options: ComposeOptions = ComposeOptions(),
) -> ComposedPrimitiveSpan:
    """Compose a directed primitive span from primitives in ``registry``.

    Parameters
    ----------
    graph
        DagNet graph dict (must contain ``edges`` and ``nodes``). Used
        once to extract the X→end span topology. The composer does NOT
        read edge parameter fields directly — those have been resolved
        into the registry's primitives by Stage 2/3.
    x_node_id, end_node_id
        Span endpoints. ``x == end`` produces a zero-edge composition — the
        identity element of the operator-chain monoid — without raising.
    registry
        Request-scoped primitive registry populated with one primitive
        per edge in the span closure under one ``PrefixArrivalIdentity``
        (plan §143, §675, §626).
    edge_to_primitive_lookup
        Callable ``(from_id, to_id, edge_dict) -> ConditionedTransitionPrimitive``
        that resolves a topology edge to its primitive in the registry.
        The composer cannot synthesise primitive identity from raw edge
        fields without re-implementing Stage 2's resolution logic, so
        the caller supplies this glue.
    options
        See ``ComposeOptions``.

    Returns
    -------
    ComposedPrimitiveSpan
        Composed reach (``span_p_*``) and conditional CDF
        (``cdf_*``). Every constructed primitive is draw-bearing by
        contract, so the per-draw arrays are always populated.

    Raises
    ------
    CompositionError
        If the registry does not supply a primitive for an edge required
        by the topology.
    """
    topo = _build_span_topology(graph, x_node_id, end_node_id)

    # Resolve every concrete edge in the topology to its primitive.
    # Missing → hard error: the caller must populate the registry before
    # composing (plan §675). Refusal cases (unparameterised residuals,
    # complement requests) are caught upstream at the residual guard
    # and never reach the composer. Iterating `topo.concrete_edges`
    # rather than `topo.edge_list` preserves coincident sibling
    # identity in the resulting per-edge primitive list.
    edge_primitives: List[
        Tuple[ConcreteEdge, ConditionedTransitionPrimitive]
    ] = []
    for ce in topo.concrete_edges:
        primitive = edge_to_primitive_lookup(
            ce.from_id, ce.to_id, dict(ce.edge_data),
        )
        if primitive is None:
            raise CompositionError(
                f"edge_to_primitive_lookup returned None for "
                f"{ce.from_id} -> {ce.to_id} "
                f"(edge_key={ce.edge_key!r}); every concrete edge in "
                f"the X→end topology must have a registry entry"
            )
        edge_primitives.append((ce, primitive))

    # Composed-span cache: deterministic given topology + primitive
    # identities + options. The DP convolution over per-edge per-draw
    # density arrays is the costly bit; consult the cache before
    # paying it.
    cache_key = _subject_span_cache_key(
        x_node_id=x_node_id,
        end_node_id=end_node_id,
        topology=topo,
        edge_primitives=edge_primitives,
        options=options,
    )
    hit, cached = _subject_span_cache.get(cache_key)
    if hit:
        return cached

    draw_counts = {p.draw_count for _, p in edge_primitives}
    S = next(iter(draw_counts), options.draw_count)
    composed = _compose_draws(
        topo=topo,
        edge_primitives=edge_primitives,
        S=S,
        max_tau=options.max_tau,
        cdf_renorm_tolerance=options.cdf_renorm_tolerance,
    )

    _subject_span_cache.put(cache_key, composed)
    return composed


# ─── Draw-coherent composition ─────────────────────────────────────────


def _compose_draws(
    *,
    topo: SpanTopology,
    edge_primitives: List[
        Tuple[ConcreteEdge, ConditionedTransitionPrimitive]
    ],
    S: int,
    max_tau: int,
    cdf_renorm_tolerance: float,
) -> ComposedPrimitiveSpan:
    """Per-draw DP composition.

    Each draw ``s`` runs the forward DAG DP over per-edge per-draw
    density arrays keyed by concrete edge so coincident sibling edges
    contribute independently. The composer retains the full DP trace
    (per-node arrival density + per-edge contribution) as `(S, T)`
    surfaces alongside the terminal CDF and span probability.

    Identity (zero-edge) spans degenerate naturally: with no concrete
    edges the DP leaves the root's δ(0) at τ=0, terminal density is
    δ(0), terminal CDF is ones, and topological reach is the empty
    product 1.0 — the algebraic identity emerges from the same uniform
    path that handles non-trivial topologies.
    """
    T = max_tau + 1

    # Per-edge per-draw kernels keyed by concrete edge_key so sibling
    # edges remain distinguishable. Three streams per edge:
    #   value(s, τ)         = p_s × Δcdf_s(τ)         (mass-transfer)
    #   exposure_shape(s,τ) = Δcdf_s(τ)               (unit-reach PMF;
    #                                                  value without
    #                                                  the p factor)
    #   support(s, τ)       = value(s, τ) × mask(s, τ)
    #   exposure(s, τ)      = exposure_shape(s, τ) × mask(s, τ)
    # The mask defaults to all-ones here (the fully-observed primitive
    # case from Phase 6 §4.8 acceptance); real per-cell masks are
    # plumbed by Phase 7 evidence binding upstream of the composer.
    # Under the default mask, support kernels equal value kernels and
    # exposure kernels equal the unit-reach PMF.
    p_draws_by_edge: Dict[str, np.ndarray] = {}
    value_kernels_by_edge: Dict[str, np.ndarray] = {}
    support_kernels_by_edge: Dict[str, np.ndarray] = {}
    exposure_kernels_by_edge: Dict[str, np.ndarray] = {}

    for ce, primitive in edge_primitives:
        edge_key = ce.edge_key
        p_draws = primitive.probability_draws()
        if p_draws.shape[0] != S:
            raise CompositionError(
                f"primitive {edge_key!r} probability_draws has shape "
                f"{p_draws.shape}; expected ({S},)"
            )
        p_draws_by_edge[edge_key] = p_draws

        exposure_shape = np.zeros((S, T), dtype=np.float64)
        if primitive.timing_family == TimingFamily.NON_LATENT:
            exposure_shape[:, 0] = 1.0
        elif primitive.timing_family == TimingFamily.DETERMINISTIC:
            shift = primitive.timing_posterior.deterministic_shift_days
            if shift is None or shift < 0:
                raise CompositionError(
                    f"primitive {edge_key!r} is DETERMINISTIC but "
                    f"deterministic_shift_days is invalid: {shift!r}"
                )
            idx = min(int(shift), max_tau)
            exposure_shape[:, idx] = 1.0
        else:
            # LATENT: per-draw conditional CDF → per-draw PMF
            # (renormalised to absorb numerical drift; rows with
            # essentially zero mass remain zero so the composer's
            # downstream consumers see an algebraically degenerate
            # kernel rather than a fabricated delta).
            cdf_draws = primitive.timing_draws()
            if cdf_draws.shape[0] != S:
                raise CompositionError(
                    f"primitive {edge_key!r} timing_draws has shape "
                    f"{cdf_draws.shape}; expected ({S}, *)"
                )
            cdf_aligned = _align_cdf_grid(cdf_draws, T)
            pmf = np.diff(cdf_aligned, axis=1, prepend=0.0)
            row_sums = pmf.sum(axis=1, keepdims=True)
            safe_row_sums = np.where(
                row_sums > cdf_renorm_tolerance, row_sums, 1.0,
            )
            exposure_shape = pmf / safe_row_sums

        value_kernel = exposure_shape * p_draws[:, None]
        # Default mask is all-ones (fully observed); Phase 7 plumbs real
        # masks here. The two derived streams are uniform expressions of
        # mask-multiplied kernels; under unit mask they collapse to the
        # value and exposure_shape arrays directly.
        mask = np.ones((S, T), dtype=np.float64)
        support_kernel = value_kernel * mask
        exposure_kernel = exposure_shape * mask

        value_kernels_by_edge[edge_key] = value_kernel
        support_kernels_by_edge[edge_key] = support_kernel
        exposure_kernels_by_edge[edge_key] = exposure_kernel

    # Per-node and per-edge `(S, T)` stacks for each of the three
    # streams. Stacks are pre-initialised so the per-draw assignment
    # below is uniform across topology shape.
    def _new_node_stack() -> Dict[str, np.ndarray]:
        return {node: np.zeros((S, T), dtype=np.float64) for node in topo.on_path}

    def _new_edge_stack() -> Dict[str, np.ndarray]:
        return {ce.edge_key: np.zeros((S, T), dtype=np.float64) for ce in topo.concrete_edges}

    node_density_draws = _new_node_stack()
    node_support_draws = _new_node_stack()
    node_exposure_draws = _new_node_stack()
    edge_contribution_draws = _new_edge_stack()
    edge_support_contribution_draws = _new_edge_stack()
    edge_exposure_contribution_draws = _new_edge_stack()

    span_p_draws = np.zeros(S, dtype=np.float64)
    cdf_arr = np.zeros((S, T), dtype=np.float64)

    for s in range(S):
        value_densities_s = {
            edge_key: value_kernels_by_edge[edge_key][s, :]
            for edge_key in value_kernels_by_edge
        }
        support_densities_s = {
            edge_key: support_kernels_by_edge[edge_key][s, :]
            for edge_key in support_kernels_by_edge
        }
        exposure_densities_s = {
            edge_key: exposure_kernels_by_edge[edge_key][s, :]
            for edge_key in exposure_kernels_by_edge
        }

        # Per-draw expected reach decouples the asymptotic span
        # probability from the finite horizon T. Sibling edges with the
        # same endpoint pair contribute additively (the cohort's reach
        # at V is the sum of per-sibling probabilities).
        edge_probs_s_by_pair: Dict[Tuple[str, str], float] = {}
        for ce in topo.concrete_edges:
            pair = (ce.from_id, ce.to_id)
            edge_probs_s_by_pair[pair] = (
                edge_probs_s_by_pair.get(pair, 0.0)
                + float(p_draws_by_edge[ce.edge_key][s])
            )
        expected_reach_s = _topological_reach(topo, edge_probs_s_by_pair)

        # Run the same trace DP three times, one per stream. The
        # topology and convolution algebra are identical; only the
        # per-edge kernel changes.
        trace_value = _run_dp_density_trace(topo, value_densities_s, T)
        trace_support = _run_dp_density_trace(topo, support_densities_s, T)
        trace_exposure = _run_dp_density_trace(topo, exposure_densities_s, T)

        for node_id, density in trace_value.node_density_by_node.items():
            node_density_draws[node_id][s, :] = density
        for edge_key, contribution in trace_value.edge_contribution_by_edge.items():
            edge_contribution_draws[edge_key][s, :] = contribution
        for node_id, density in trace_support.node_density_by_node.items():
            node_support_draws[node_id][s, :] = density
        for edge_key, contribution in trace_support.edge_contribution_by_edge.items():
            edge_support_contribution_draws[edge_key][s, :] = contribution
        for node_id, density in trace_exposure.node_density_by_node.items():
            node_exposure_draws[node_id][s, :] = density
        for edge_key, contribution in trace_exposure.edge_contribution_by_edge.items():
            edge_exposure_contribution_draws[edge_key][s, :] = contribution

        terminal_density = trace_value.node_density_by_node[topo.y_node_id]
        density_cdf = np.cumsum(terminal_density)
        # 0/0 at expected_reach_s == 0 is genuine algebraic degeneracy
        # (no mass propagates); emit 0 there to match the upstream
        # degraded-timing contract. Anywhere reach is positive the
        # division is unguarded.
        cdf_arr[s, :] = np.divide(
            density_cdf,
            expected_reach_s,
            out=np.zeros_like(density_cdf),
            where=expected_reach_s > 0.0,
        )
        span_p_draws[s] = expected_reach_s

    span_p_mean = float(np.mean(span_p_draws))
    span_p_sd = float(np.std(span_p_draws))
    cdf_mean = cdf_arr.mean(axis=0)

    provenance = _build_provenance(
        topo=topo,
        edge_primitives=edge_primitives,
        mode="draws",
        S=S,
    )

    return ComposedPrimitiveSpan(
        x_node_id=topo.x_node_id,
        end_node_id=topo.y_node_id,
        primitive_count=len(edge_primitives),
        draw_count=S,
        span_p_mean=span_p_mean,
        span_p_sd=span_p_sd,
        span_p_draws=span_p_draws,
        cdf_mean=cdf_mean,
        cdf_draws=cdf_arr,
        max_tau=max_tau,
        node_density_draws=node_density_draws,
        edge_contribution_draws=edge_contribution_draws,
        node_support_draws=node_support_draws,
        edge_support_contribution_draws=edge_support_contribution_draws,
        node_exposure_draws=node_exposure_draws,
        edge_exposure_contribution_draws=edge_exposure_contribution_draws,
        concrete_edges=tuple(topo.concrete_edges),
        provenance=provenance,
    )


# ─── Helpers ───────────────────────────────────────────────────────────


def _align_cdf_grid(cdf_arr: np.ndarray, T: int) -> np.ndarray:
    """Pad with the saturation value (last column) or truncate to length T.

    Conditional CDFs saturate at 1.0 by construction; padding with the
    final column preserves that semantic if the primitive's grid is
    shorter than the composer's grid.
    """
    if cdf_arr.ndim != 2:
        raise ValueError(
            f"_align_cdf_grid expects 2-D input; got shape {cdf_arr.shape}"
        )
    n_rows, T_p = cdf_arr.shape
    if T_p == T:
        return cdf_arr
    if T_p > T:
        return cdf_arr[:, :T]
    saturation = cdf_arr[:, -1:] if T_p > 0 else np.zeros((n_rows, 1))
    pad_width = T - T_p
    pad = np.repeat(saturation, pad_width, axis=1)
    return np.concatenate([cdf_arr, pad], axis=1)


def _build_provenance(
    *,
    topo: SpanTopology,
    edge_primitives: List[
        Tuple[ConcreteEdge, ConditionedTransitionPrimitive]
    ],
    mode: str,
    S: int,
) -> Mapping[str, Any]:
    """Provenance block for the composed span.

    Folded into the response provenance schema (plan §744-758). The
    shape is JSON-friendly for the test harness.
    """
    primitive_summaries: List[Mapping[str, Any]] = []
    for ce, primitive in edge_primitives:
        primitive_summaries.append({
            "from": ce.from_id,
            "to": ce.to_id,
            "edge_key": ce.edge_key,
            "edge_id": primitive.transition.edge_id,
            "status": primitive.status.value,
            "timing_family": primitive.timing_family.value,
            "p_mean": (
                primitive.probability_posterior.mean
                if primitive.probability_posterior is not None
                else None
            ),
        })
    return {
        "binding_policy": "primitive_span.composer.v1",
        "x_node_id": topo.x_node_id,
        "end_node_id": topo.y_node_id,
        "primitive_count": len(edge_primitives),
        "topology_node_count": len(topo.on_path),
        "topology_edge_count": len(topo.edge_list),
        "composition_mode": mode,
        "draw_count": S,
        "primitives": tuple(primitive_summaries),
    }


__all__ = [
    "ComposedPrimitiveSpan",
    "ComposeOptions",
    "CompositionError",
    "compose_primitive_span",
]
