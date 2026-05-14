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
from .span_kernel import SpanTopology, _build_span_topology
from .timing_span import _topological_reach, compose_timing_span_from_densities


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
        Tuple[Tuple[str, str], ConditionedTransitionPrimitive]
    ],
    options: 'ComposeOptions',
) -> str:
    """Cache key for ``compose_primitive_span``.

    Topology pins the edge layout. Per-edge ``id(primitive)`` pins the
    primitive object identity in the live process; when the upstream
    primitive cache is flushed (via the snapshot-write bustcache) new
    primitive instances are minted with new ids and this cache misses
    correctly.
    """
    topo_edges = tuple(
        (from_id, to_id)
        for from_id, to_id, _edge_data in topology.edge_list
    )
    primitives_signature = tuple(
        (key, id(prim)) for key, prim in edge_primitives
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

    The object exposes the composed span probability (reach) and
    conditional timing CDF, both as moments and as per-draw arrays.
    Every constructed primitive is draw-bearing by contract, so the
    composer always produces per-draw output; consumers select the
    surface they need. Projection MUST keep reach separate from
    displayed rates per plan §441.
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
        does not need supply-boundary shape inspections. Used by the
        composer when ``x == end`` (window mode, ``cohort(A = X)``).
        """
        T = int(max_tau) + 1
        S = int(draw_count)
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

    # Resolve every edge in the topology to its primitive. Missing → hard
    # error: the caller must populate the registry before composing
    # (plan §675). Refusal cases (unparameterised residuals, complement
    # requests) are caught upstream at the residual guard and never
    # reach the composer.
    edge_primitives: List[
        Tuple[Tuple[str, str], ConditionedTransitionPrimitive]
    ] = []
    for from_id, to_id, edge_dict in topo.edge_list:
        primitive = edge_to_primitive_lookup(from_id, to_id, edge_dict)
        if primitive is None:
            raise CompositionError(
                f"edge_to_primitive_lookup returned None for "
                f"{from_id} -> {to_id} (edge_id={edge_dict.get('edge_id')!r}); "
                f"every edge in the X→end topology must have a registry entry"
            )
        edge_primitives.append(((from_id, to_id), primitive))

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
        Tuple[Tuple[str, str], ConditionedTransitionPrimitive]
    ],
    S: int,
    max_tau: int,
    cdf_renorm_tolerance: float,
) -> ComposedPrimitiveSpan:
    """Per-draw DP composition.

    Each draw ``s`` runs the same forward DP that ``span_kernel._run_dp``
    runs in the parametric case, but over per-edge density arrays
    derived from each primitive's draw ``s``. The composed CDF for draw
    ``s`` is the cumulative sum of the resulting density at the end
    node; the composed reach is its terminal value.
    """
    T = max_tau + 1
    n_edges = len(edge_primitives)

    # Zero-edge span (x == end): dispatch to the identity element of the
    # operator-chain monoid. The general-case path below reduces draws
    # via ``np.mean`` / ``np.std``, which return NaN on empty input —
    # the identity element supplies the algebraic answers directly.
    if n_edges == 0:
        return ComposedPrimitiveSpan.identity(
            x_node_id=topo.x_node_id,
            end_node_id=topo.y_node_id,
            max_tau=max_tau,
            draw_count=S,
            provenance=_build_provenance(
                topo=topo, edge_primitives=[], mode="draws", S=S,
            ),
        )

    # Per-edge per-draw density arrays. Shape: (n_edges, S, T).
    # Per-edge per-draw probability arrays. Shape: (n_edges, S).
    # The probability arrays feed `_topological_reach` per draw to
    # supply `expected_reach` to the composer; this keeps the
    # asymptotic span probability independent of the finite horizon T.
    # Without this the multi-edge convolution truncates at T-1 and
    # `density_cdf[T-1]` falls below `Π_i p_i_draws[s]` for spans whose
    # composed timing has support beyond T-1 — which would break the
    # natural degeneration of single-hop into multi-hop (the single-hop
    # readout reads `mean(p_draws)` directly via the primitive's IS
    # posterior, with no horizon dependency).
    f_edge_draws = np.zeros((n_edges, S, T), dtype=np.float64)
    p_draws_by_edge: Dict[Tuple[str, str], np.ndarray] = {}
    for i, ((from_id, to_id), primitive) in enumerate(edge_primitives):
        p_draws = primitive.probability_draws()
        if p_draws.shape[0] != S:
            raise CompositionError(
                f"primitive {from_id}->{to_id} probability_draws has "
                f"shape {p_draws.shape}; expected ({S},)"
            )
        p_draws_by_edge[(from_id, to_id)] = p_draws

        if primitive.timing_family == TimingFamily.NON_LATENT:
            # Mass at tau=0; per-draw probability sets the mass.
            f_edge_draws[i, :, 0] = p_draws
            continue

        if primitive.timing_family == TimingFamily.DETERMINISTIC:
            shift = primitive.timing_posterior.deterministic_shift_days
            if shift is None or shift < 0:
                raise CompositionError(
                    f"primitive {from_id}->{to_id} is DETERMINISTIC but "
                    f"deterministic_shift_days is invalid: {shift!r}"
                )
            idx = min(int(shift), max_tau)
            f_edge_draws[i, :, idx] = p_draws
            continue

        # LATENT: per-draw conditional CDF → per-draw density on the
        # composed grid → scaled by p_s.
        cdf_draws = primitive.timing_draws()
        if cdf_draws.shape[0] != S:
            raise CompositionError(
                f"primitive {from_id}->{to_id} timing_draws has shape "
                f"{cdf_draws.shape}; expected ({S}, *)"
            )
        # Pad / truncate to (S, T).
        cdf_aligned = _align_cdf_grid(cdf_draws, T)
        # Differenced PMF (prepend 0 so τ=0 picks up CDF[0]).
        pmf = np.diff(cdf_aligned, axis=1, prepend=0.0)
        # Renormalise per-draw to absorb tiny numerical drift; non-finite
        # rows fall back to a delta at τ=0 (preserves probability mass).
        row_sums = pmf.sum(axis=1, keepdims=True)
        row_sums = np.where(row_sums > cdf_renorm_tolerance, row_sums, 1.0)
        pmf = pmf / row_sums
        # Scale by per-draw probability.
        f_edge_draws[i, :, :] = pmf * p_draws[:, None]

    # Run the per-draw DP. We process each draw independently using the
    # same forward DP shape as span_kernel._run_dp; the difference is
    # that f_edge is supplied directly per draw rather than recomputed
    # from (p, mu, sigma, onset).
    cdf_arr = np.zeros((S, T), dtype=np.float64)
    span_p_draws = np.zeros(S, dtype=np.float64)

    for s in range(S):
        densities: Dict[Tuple[str, str], np.ndarray] = {}
        edge_probs_s: Dict[Tuple[str, str], float] = {}
        for i, (key, _) in enumerate(edge_primitives):
            densities[key] = f_edge_draws[i, s, :]
            edge_probs_s[key] = float(p_draws_by_edge[key][s])
        expected_reach_s = _topological_reach(topo, edge_probs_s)
        timing = compose_timing_span_from_densities(
            graph={},
            root_node_id=topo.x_node_id,
            end_node_id=topo.y_node_id,
            densities=densities,
            max_tau=max_tau,
            topology=topo,
            expected_reach=expected_reach_s,
            cdf_renorm_tolerance=cdf_renorm_tolerance,
        )
        if timing.conditional_cdf is not None:
            cdf_arr[s, :] = timing.conditional_cdf
        span_p_draws[s] = float(timing.reach)

    # timing_span already returns conditional CDFs; reach stays separate
    # in span_p_draws.
    conditional_cdf_draws = cdf_arr

    span_p_mean = float(np.mean(span_p_draws))
    span_p_sd = float(np.std(span_p_draws))
    cdf_mean = conditional_cdf_draws.mean(axis=0)

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
        cdf_draws=conditional_cdf_draws,
        max_tau=max_tau,
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
        Tuple[Tuple[str, str], ConditionedTransitionPrimitive]
    ],
    mode: str,
    S: int,
) -> Mapping[str, Any]:
    """Provenance block for the composed span.

    Folded into the response provenance schema (plan §744-758). The
    shape is JSON-friendly for the test harness.
    """
    primitive_summaries: List[Mapping[str, Any]] = []
    for (from_id, to_id), primitive in edge_primitives:
        primitive_summaries.append({
            "from": from_id,
            "to": to_id,
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
