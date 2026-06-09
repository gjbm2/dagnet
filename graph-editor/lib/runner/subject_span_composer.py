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
from datetime import date as _date, timedelta as _timedelta
from pathlib import Path as _Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

# result_cache lives in graph-editor/lib (not under runner/). Reach it
# without restructuring the package.
_lib_dir = str(_Path(__file__).resolve().parents[1])
if _lib_dir not in _sys.path:
    _sys.path.insert(0, _lib_dir)
import result_cache  # noqa: E402

from .bucket_transition import BucketSourceBasis, cdf_to_bucket_transition
from .primitive_evidence import RequestPrimitiveRegistry
from .primitives import (
    ConditionedTransitionPrimitive,
    TimingFamily,
)
from .span_kernel import ConcreteEdge, SpanTopology, _build_span_topology
from .timing_span import (
    DPExecutionPolicy,
    SpanDPTrace,
    _edge_default_out_basis,
    _run_dp_density_trace,
    _run_dp_density_trace_from_seed,
    _run_dp_density_trace_from_provenance_seed,
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
    # Per-request: keyed by in-process primitive id() (see _subject_span_cache_key
    # below), so it never hits across requests; its values are draw-scaled arrays.
    # Flushed by result_cache.clear_request_scoped() at the end of each analyze /
    # conditioned-forecast request so a warm worker does not accumulate them past
    # the 512-count cap (which for GB-sized values means OOM long before 512).
    request_scoped=True,
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
    evidence_readout_binding: EvidenceReadoutBinding,
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
        draw_count=int(options.draw_count),
        cdf_renorm_tolerance=float(options.cdf_renorm_tolerance),
        evidence_readout_binding=evidence_readout_binding.mode,
    )


# ─── Public dataclasses ────────────────────────────────────────────────


@dataclass(frozen=True)
class EvidenceLookup:
    source_offset: int
    age_offset: int

    def __call__(
        self,
        *,
        origin_day: _date,
        source_index: int,
        tau_out: int,
    ) -> tuple[str, int]:
        evidence_source_day = origin_day + _timedelta(
            days=self.source_offset * int(source_index),
        )
        evidence_age = int(tau_out) + self.age_offset * int(source_index)
        return evidence_source_day.isoformat(), evidence_age


@dataclass(frozen=True)
class EvidenceReadoutBinding:
    """Mode-specific evidence lookup carried as data.

    The selected-cohort readout asks one generic evaluator to resolve
    each edge/source/row lookup. Cohort mode preserves arrival-date
    cohort identity; window mode reads each primitive on its own local
    window clock. Keeping this as a data object prevents projection code
    from branching on mode.
    """
    mode: str
    lookup: EvidenceLookup
    empirical_subject_read_offset: float = 0.0

    @classmethod
    def cohort(cls) -> "EvidenceReadoutBinding":
        return cls(
            mode="cohort",
            lookup=EvidenceLookup(1, -1),
            empirical_subject_read_offset=0.5,
        )

    @classmethod
    def window(cls) -> "EvidenceReadoutBinding":
        return cls(
            mode="window",
            lookup=EvidenceLookup(0, 0),
            empirical_subject_read_offset=0.5,
        )


@dataclass(frozen=True)
class ComposedPrimitiveSpan:
    """Composed primitive span.

    Exposes the composed span probability (reach) and conditional timing
    CDF as moments and per-draw arrays. In addition, every per-node
    arrival density and per-concrete-edge contribution computed by the
    forward DAG DP is retained as a **source-bucket-aware** ledger so
    downstream callers can read mass at intermediate nodes or through
    specific concrete edges, broken down by the bucket structure the DP
    actually used.

    Surfaces:

    - `span_p_*`, `cdf_*` — terminal asymptotic reach and conditional
      timing CDF (the legacy surfaces; unchanged by the per-node /
      per-edge extension).
    - ``node_density_by_node_bucket[node_id][arrival_bucket]`` — per-draw
      mass that arrived at ``node_id`` at row-age column
      ``arrival_bucket``. Each entry is a ``(S,)`` array. The collapsed
      ``(S, T)`` density at ``node_id`` is ``node_density(node_id)``.
    - ``edge_contribution_by_edge_source[edge_key][source_bucket]`` —
      per-(draw, τ) mass flowing through ``edge_key`` derived from the
      source-node bucket ``source_bucket``. Each entry is a smeared
      ``(S, T)`` array. The collapsed view is
      ``edge_contribution(edge_key)``. Coincident sibling edges have
      separate entries.
    - ``node_basis_by_node_bucket[node_id][arrival_bucket][provenance_key]``
      — basis (``BucketSourceBasis`` as int) carried into ``node_id`` at
      column ``arrival_bucket`` by each contributing provenance.
      ``provenance_key`` is the contributing edge_key or the seed-origin
      marker. Carried through composition so frontier-state construction
      (Atom 4) can read per-edge provenance off the composed span
      without re-running the DP.
    - ``concrete_edges`` — topology metadata describing every concrete
      edge in this span (including its ``edge_key``).

    All retained surfaces are densities (NOT cumulative). Downstream
    projection helpers decide how to cumulate them for row output.
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

    node_density_by_node_bucket: Mapping[str, Mapping[int, np.ndarray]]
    edge_contribution_by_edge_source: Mapping[str, Mapping[int, np.ndarray]]
    node_basis_by_node_bucket: Mapping[str, Mapping[int, Mapping[str, int]]]
    node_mass_by_provenance: Mapping[str, Mapping[int, Mapping[str, np.ndarray]]]

    concrete_edges: Tuple[ConcreteEdge, ...] = field(default_factory=tuple)
    topology: Optional[SpanTopology] = None
    conditioned_edge_primitives: Tuple[
        Tuple[ConcreteEdge, ConditionedTransitionPrimitive], ...
    ] = field(default_factory=tuple)
    empirical_edge_primitives: Tuple[Tuple[ConcreteEdge, Any], ...] = field(
        default_factory=tuple,
    )
    evidence_readout_binding: EvidenceReadoutBinding = field(
        default_factory=EvidenceReadoutBinding.cohort,
    )

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

    def node_density(self, node_id: str) -> np.ndarray:
        """Collapsed per-(draw, τ) arrival density at ``node_id``.

        Sums the per-arrival-bucket entries onto their respective
        columns. Nodes off the span topology raise ``KeyError``;
        on-path nodes with no arrivals degenerate to the empty sum.
        """
        T = int(self.max_tau) + 1
        out = np.zeros((int(self.draw_count), T), dtype=np.float32)
        for arrival_col, col_mass in self.node_density_by_node_bucket[node_id].items():
            out[:, int(arrival_col)] += col_mass
        return out

    def edge_contribution(self, edge_key: str) -> np.ndarray:
        """Collapsed per-(draw, τ) mass through the named concrete edge.

        Sums the per-source-bucket smears. Edges off the span topology
        raise ``KeyError``; concrete edges with no flow degenerate to
        the empty sum.
        """
        T = int(self.max_tau) + 1
        out = np.zeros((int(self.draw_count), T), dtype=np.float32)
        for smear in self.edge_contribution_by_edge_source[edge_key].values():
            out += smear
        return out

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
    evidence_readout_binding: EvidenceReadoutBinding | None = None,
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
    readout_binding = evidence_readout_binding or EvidenceReadoutBinding.cohort()

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
        evidence_readout_binding=readout_binding,
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
        evidence_readout_binding=readout_binding,
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
    evidence_readout_binding: EvidenceReadoutBinding,
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

    # Per-edge per-draw value kernels keyed by concrete edge_key so
    # sibling edges remain distinguishable:
    #   value(s, τ) = p_s × Δcdf_s(τ)
    p_draws_by_edge: Dict[str, np.ndarray] = {}
    value_kernels_by_edge: Dict[str, np.ndarray] = {}

    for ce, primitive in edge_primitives:
        edge_key = ce.edge_key
        p_draws = primitive.probability_draws()
        p_draws_by_edge[edge_key] = p_draws

        timing_kernel = np.zeros((S, T), dtype=np.float32)
        if primitive.timing_family == TimingFamily.NON_LATENT:
            timing_kernel[:, 0] = 1.0
        elif primitive.timing_family == TimingFamily.DETERMINISTIC:
            shift = primitive.timing_posterior.deterministic_shift_days
            idx = min(int(shift), max_tau)
            timing_kernel[:, idx] = 1.0
        else:
            # LATENT: per-draw endpoint CDF -> per-draw endpoint PMF.
            # The composer consumes primitive timing surfaces in the same
            # endpoint convention as the likelihood and outside-in snapshot
            # rows; bucket placement belongs at explicit bucket-K boundaries,
            # not on an already endpoint-labelled composed model surface.
            cdf_draws = primitive.timing_draws()
            cdf_aligned = _align_cdf_grid(cdf_draws, T)
            pmf = np.diff(cdf_aligned, prepend=0.0, axis=1)
            row_sums = pmf.sum(axis=1, keepdims=True)
            safe_row_sums = np.where(
                row_sums > cdf_renorm_tolerance, row_sums, 1.0,
            )
            timing_kernel = pmf / safe_row_sums

        value_kernels_by_edge[edge_key] = timing_kernel * p_draws[:, None]

    span_p_draws = np.zeros(S, dtype=np.float32)
    # Per-draw expected reach decouples the asymptotic span probability
    # from the finite horizon T. Sibling edges with the same endpoint pair
    # contribute additively (the cohort's reach at V is the sum of
    # per-sibling probabilities).
    for s in range(S):
        edge_probs_s_by_pair: Dict[Tuple[str, str], float] = {}
        for ce in topo.concrete_edges:
            pair = (ce.from_id, ce.to_id)
            edge_probs_s_by_pair[pair] = (
                edge_probs_s_by_pair.get(pair, 0.0)
                + float(p_draws_by_edge[ce.edge_key][s])
            )
        span_p_draws[s] = _topological_reach(topo, edge_probs_s_by_pair)

    trace_value = _run_dp_density_trace(
        topo,
        lambda ce, _source_index: value_kernels_by_edge[ce.edge_key],
        S,
        T,
    )

    terminal_density = trace_value.node_density(topo.y_node_id)
    density_cdf = np.cumsum(terminal_density, axis=1)
    # 0/0 at expected reach == 0 is genuine algebraic degeneracy (no mass
    # propagates); emit 0 there to match the upstream degraded-timing
    # contract. Anywhere reach is positive the division is unguarded.
    cdf_arr = np.divide(
        density_cdf,
        span_p_draws[:, None],
        out=np.zeros_like(density_cdf),
        where=span_p_draws[:, None] > 0.0,
    )

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
        node_density_by_node_bucket=trace_value.node_density_by_node_bucket,
        edge_contribution_by_edge_source=trace_value.edge_contribution_by_edge_source,
        node_basis_by_node_bucket=trace_value.node_basis_by_node_bucket,
        node_mass_by_provenance=trace_value.node_mass_by_provenance,
        concrete_edges=tuple(topo.concrete_edges),
        topology=topo,
        conditioned_edge_primitives=tuple(edge_primitives),
        evidence_readout_binding=evidence_readout_binding,
        provenance=provenance,
    )


# ─── Helpers ───────────────────────────────────────────────────────────


def evaluate_conditioned_span_from_seed(
    span: ComposedPrimitiveSpan,
    *,
    root_seed: np.ndarray,
    origin_day: Optional[_date] = None,
    cdf_renorm_tolerance: float = ComposeOptions.cdf_renorm_tolerance,
) -> SpanDPTrace:
    """Evaluate a composed conditioned span from an arbitrary root seed.

    ``compose_primitive_span`` builds the operator identity readout
    (δ(0) at the root). Selected-cohort projection needs the same
    topology and kernels fed by source-day mass already produced by a
    carrier. This helper keeps the algebra in the span layer: one DP,
    caller-supplied root density.
    """
    topo = span.topology
    edge_primitives = span.conditioned_edge_primitives
    S, T = root_seed.shape
    kernel_provider = _build_stream_kernel_provider(
        edge_primitives=edge_primitives,
        S=S,
        T=T,
        cdf_renorm_tolerance=cdf_renorm_tolerance,
    )
    # SCALAR policy: per-(source bucket, cohort) kernel calls.
    # ``evaluate_conditioned_span_from_seed_flat_origins`` is the
    # batched-via-Toeplitz entry point; this scalar entry exists for
    # the single-cohort / non-flat caller surface.
    return _run_dp_density_trace_from_seed(
        topo,
        lambda ce, source_index, _cohort_index, source_basis: kernel_provider(
            ce,
            source_index,
            source_basis,
        ),
        root_seed,
        S,
        T,
        execution_policy=DPExecutionPolicy.SCALAR,
    )


def evaluate_conditioned_span_from_seed_flat_origins(
    span: ComposedPrimitiveSpan,
    *,
    root_seed: np.ndarray,
    cohort_count: int,
    origin_days: Sequence[_date],
    evidence_readout_binding: EvidenceReadoutBinding,
    cdf_renorm_tolerance: float = ComposeOptions.cdf_renorm_tolerance,
    root_basis: np.ndarray | None = None,
) -> SpanDPTrace:
    """Evaluate a conditioned span with cohort and draw axes flattened.

    Collapsed ``(root_seed, root_basis)`` form. Callers carrying a
    per-bucket per-provenance seed (carrier → subject handoff) call
    ``evaluate_conditioned_span_from_seed_flat_origins_with_provenance``
    instead.
    """
    S_flat, T = root_seed.shape
    provider = _build_flat_provider_for_span(
        span=span,
        T=T,
        cdf_renorm_tolerance=cdf_renorm_tolerance,
        origin_days=origin_days,
        evidence_readout_binding=evidence_readout_binding,
    )
    return _run_dp_density_trace_from_seed(
        span.topology,
        provider,
        root_seed,
        S_flat,
        T,
        execution_policy=DPExecutionPolicy.TOEPLITZ_APPLY,
        cohort_count=int(cohort_count),
        root_basis=root_basis,
    )


def evaluate_conditioned_span_from_seed_flat_origins_with_provenance(
    span: ComposedPrimitiveSpan,
    *,
    S_flat: int,
    T: int,
    cohort_count: int,
    origin_days: Sequence[_date],
    evidence_readout_binding: EvidenceReadoutBinding,
    root_provenance_mass: Mapping[int, Mapping[str, np.ndarray]],
    root_provenance_basis: Mapping[int, Mapping[str, int]],
    cdf_renorm_tolerance: float = ComposeOptions.cdf_renorm_tolerance,
) -> SpanDPTrace:
    """Provenance-seeded variant of the conditioned flat-origins evaluator.

    Each provenance entry at the carrier terminal keeps its own ``(S,)``
    mass and basis so mixed basis survives the carrier → subject join.
    ``S_flat`` / ``T`` are the seed-shape metadata the DP needs even
    though the mass content lives in the provenance map.
    """
    provider = _build_flat_provider_for_span(
        span=span,
        T=T,
        cdf_renorm_tolerance=cdf_renorm_tolerance,
        origin_days=origin_days,
        evidence_readout_binding=evidence_readout_binding,
    )
    return _run_dp_density_trace_from_provenance_seed(
        span.topology,
        provider,
        root_provenance_mass=root_provenance_mass,
        root_provenance_basis=root_provenance_basis,
        S=S_flat,
        T=T,
        execution_policy=DPExecutionPolicy.TOEPLITZ_APPLY,
        cohort_count=int(cohort_count),
    )


def _build_flat_provider_for_span(
    *,
    span: ComposedPrimitiveSpan,
    T: int,
    cdf_renorm_tolerance: float,
    origin_days: Sequence[_date],
    evidence_readout_binding: EvidenceReadoutBinding,
) -> Callable:
    return _build_flat_stream_kernel_provider(
        edge_primitives=span.conditioned_edge_primitives,
        S=int(span.draw_count),
        T=T,
        cdf_renorm_tolerance=cdf_renorm_tolerance,
        origin_days=origin_days,
        evidence_readout_binding=evidence_readout_binding,
    )


def _build_flat_stream_kernel_provider(
    *,
    edge_primitives: Tuple[
        Tuple[ConcreteEdge, ConditionedTransitionPrimitive], ...
    ],
    S: int,
    T: int,
    cdf_renorm_tolerance: float,
    origin_days: Sequence[_date],
    evidence_readout_binding: EvidenceReadoutBinding,
) -> Callable[[ConcreteEdge, int, int, BucketSourceBasis], np.ndarray]:
    endpoint_kernels, bucket_kernels = _conditioned_kernel_maps(
        edge_primitives=edge_primitives,
        S=S,
        T=T,
        cdf_renorm_tolerance=cdf_renorm_tolerance,
    )
    # Table-driven kernel selection by source basis. One lookup table
    # consumed identically by every provider entry point — replaces the
    # ``if source_basis == BUCKET_DISTRIBUTED ... else ...`` triplet
    # that previously lived in ``provider``, ``batched``, and
    # ``batched_op``.
    kernels_by_basis: Dict[int, Mapping[str, np.ndarray]] = {
        int(BucketSourceBasis.BUCKET_DISTRIBUTED): bucket_kernels,
        int(BucketSourceBasis.POINT_AT_ENDPOINT): endpoint_kernels,
    }
    # Per-edge output basis pre-computed once from edge metadata via the
    # canonical helper in ``timing_span.py``.
    out_basis_by_edge: Dict[str, BucketSourceBasis] = {
        ce.edge_key: _edge_default_out_basis(ce)
        for ce, _primitive in edge_primitives
    }

    def provider(
        ce: ConcreteEdge,
        source_index: int,
        _cohort_index: int,
        source_basis: BucketSourceBasis,
    ) -> Tuple[np.ndarray, BucketSourceBasis]:
        return (
            kernels_by_basis[int(source_basis)][ce.edge_key],
            out_basis_by_edge[ce.edge_key],
        )

    # Toeplitz cache: per (edge_key, source_basis) the lower-triangular
    # convolution matrix ``T_mat[d, v, u] = K[d, v − u]`` is built once
    # per DP call and reused across every (edge, basis) dispatch.
    toeplitz_cache: Dict[Tuple[str, int], np.ndarray] = {}

    def batched_op(
        ce: ConcreteEdge,
        source_basis: BucketSourceBasis,
        source_mass_3d: np.ndarray,
    ) -> Tuple[np.ndarray, BucketSourceBasis]:
        """Apply the edge's kernel to ``(C, D, T)`` source mass via one
        Toeplitz contraction.

        Conditioned kernels are cohort-invariant AND source-bucket-
        invariant in ``u``, so the kernel is shift-invariant in ``u``
        and the contraction
        ``out[c, d, v] = Σ_u M[c, d, u] · K[d, v − u]`` is exact. One
        BLAS-backed ``einsum`` per (edge, basis).
        """
        K = kernels_by_basis[int(source_basis)][ce.edge_key]
        T_actual = int(K.shape[1])
        cache_key = (ce.edge_key, int(source_basis))
        T_mat = toeplitz_cache.get(cache_key)
        if T_mat is None:
            v_idx = np.arange(T_actual)
            u_idx = np.arange(T_actual)
            offset = v_idx[:, None] - u_idx[None, :]
            valid = offset >= 0
            T_mat = np.where(
                valid[None, :, :],
                K[:, np.clip(offset, 0, T_actual - 1)],
                0.0,
            )
            toeplitz_cache[cache_key] = T_mat
        out = np.einsum(
            'cdu,dvu->cdv', source_mass_3d, T_mat, optimize=True,
        )
        return out, out_basis_by_edge[ce.edge_key]

    provider.batched_op = batched_op
    return provider


def _build_stream_kernel_provider(
    *,
    edge_primitives: Tuple[
        Tuple[ConcreteEdge, ConditionedTransitionPrimitive], ...
    ],
    S: int,
    T: int,
    cdf_renorm_tolerance: float,
) -> Callable[[ConcreteEdge, int, BucketSourceBasis], np.ndarray]:
    """Per-(edge, source_index) value-kernel provider."""
    endpoint_kernels, bucket_kernels = _conditioned_kernel_maps(
        edge_primitives=edge_primitives,
        S=S,
        T=T,
        cdf_renorm_tolerance=cdf_renorm_tolerance,
    )
    # Table-driven basis selection — same shape as the flat provider's
    # ``kernels_by_basis``: the per-call path is a pure indexed lookup,
    # no branch.
    kernels_by_basis: Dict[int, Mapping[str, np.ndarray]] = {
        int(BucketSourceBasis.BUCKET_DISTRIBUTED): bucket_kernels,
        int(BucketSourceBasis.POINT_AT_ENDPOINT): endpoint_kernels,
    }
    out_basis_by_edge: Dict[str, BucketSourceBasis] = {
        ce.edge_key: _edge_default_out_basis(ce)
        for ce, _primitive in edge_primitives
    }

    def provider(
        ce: ConcreteEdge,
        _source_index: int,
        source_basis: BucketSourceBasis,
    ) -> Tuple[np.ndarray, BucketSourceBasis]:
        return (
            kernels_by_basis[int(source_basis)][ce.edge_key],
            out_basis_by_edge[ce.edge_key],
        )

    return provider


def _conditioned_kernel_maps(
    *,
    edge_primitives: Tuple[
        Tuple[ConcreteEdge, ConditionedTransitionPrimitive], ...
    ],
    S: int,
    T: int,
    cdf_renorm_tolerance: float,
) -> Tuple[Dict[str, np.ndarray], Dict[str, np.ndarray]]:
    """Per-edge value kernels in canonical endpoint bucket form.

    Returns ``(native_kernels, propagated_kernels)``, both keyed by
    ``edge_key`` with shape ``(S, T)``. Both surfaces share the same
    endpoint-labelled transition values; source-index placement is not a
    separate midpoint convention.

    Dirac timing families (``NON_LATENT``, ``DETERMINISTIC``) are
    exact degenerate transitions under the same bucket contract.
    """
    endpoint_kernels_by_edge: Dict[str, np.ndarray] = {}
    bucket_kernels_by_edge: Dict[str, np.ndarray] = {}
    max_tau = T - 1

    for ce, primitive in edge_primitives:
        edge_key = ce.edge_key
        p_draws = primitive.probability_draws()

        if primitive.timing_family == TimingFamily.NON_LATENT:
            endpoint_timing_kernel = np.zeros((S, T), dtype=np.float32)
            endpoint_timing_kernel[:, 0] = 1.0
            bucket_timing_kernel = endpoint_timing_kernel
        elif primitive.timing_family == TimingFamily.DETERMINISTIC:
            shift = primitive.timing_posterior.deterministic_shift_days
            endpoint_timing_kernel = np.zeros((S, T), dtype=np.float32)
            endpoint_timing_kernel[:, min(int(shift), max_tau)] = 1.0
            bucket_timing_kernel = endpoint_timing_kernel
        else:
            cdf_draws = primitive.timing_draws()
            cdf_aligned = _align_cdf_grid(cdf_draws, T)
            endpoint_timing_kernel = np.diff(cdf_aligned, prepend=0.0, axis=1)
            bucket_timing_kernel = cdf_to_bucket_transition(
                edge_key,
                cdf_aligned,
                family="conditioned_model",
            ).value

        endpoint_kernels_by_edge[edge_key] = (
            endpoint_timing_kernel * p_draws[:, None]
        )
        bucket_kernels_by_edge[edge_key] = (
            bucket_timing_kernel * p_draws[:, None]
        )

    return endpoint_kernels_by_edge, bucket_kernels_by_edge


def _align_cdf_grid(cdf_arr: np.ndarray, T: int) -> np.ndarray:
    """Pad with the saturation value (last column) or truncate to length T.

    Conditional CDFs saturate at 1.0 by construction; padding with the
    final column preserves that semantic if the primitive's grid is
    shorter than the composer's grid.
    """
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
    "EvidenceReadoutBinding",
    "CompositionError",
    "compose_primitive_span",
]
