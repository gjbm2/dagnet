"""Empirical evidence operator — Phase 6 §4.9.

The second operator family alongside the conditioned (model) operator
in [`primitives.py`](primitives.py) / [`primitive_conditioning.py`]
(primitive_conditioning.py) / [`subject_span_composer.py`]
(subject_span_composer.py). The two share:

  - the same admitted candidate rows (this module calls
    ``bind_primitive_evidence`` directly to ensure parity),
  - the same arrival-map weighting,
  - the same DAG topology + DP/readout core (``_build_span_topology`` /
    ``_run_dp_density_trace`` / ``_topological_reach`` from
    ``timing_span.py`` and ``span_kernel.py``),
  - the same ``ComposedPrimitiveSpan`` output shape so the spine and
    downstream readout treat the two operators interchangeably.

They differ ONLY at the per-edge kernel supply boundary:

  - conditioned operator: kernel = ``p × Δcdf`` (fitted parametric
    posterior),
  - empirical operator:   kernel = ``Δ(k_emp / n_emp)`` (observed
    snapshot rows on the selected clock, arrival-weighted across source
    days, forward-filled across absent ages).

Per §4.9, the empirical kernel reads observed cumulative rates which
already integrate same-day conversions by construction; no continuous-
model quadrature, no curvature correction at the kernel-value level.
Forward-fill of the cumulative across absent ages is the only completion
policy and emerges structurally from the increment form (``Δ = 0`` at
absent cells; the cumulative jump is absorbed at the next observed age).

The kernel is APPLIED inside convolutions whose source mass placement
varies. A root δ-seed places mass at column 0 as a point in continuous
time; any mass propagated from an upstream empirical edge arrives during
a continuous-time bucket ``(s-1, s]``. The kernel read is therefore
placement-aware: native point mass (``source_index == 0``) reads
``R(age)`` directly; propagated bucket mass (``source_index > 0``) reads
the bucket-centred ``R(age + 0.5)`` via linear interpolation between
``R(age)`` and ``R(age + 1)``. Placement is determined algebraically
from ``source_index`` — root seeds only occupy column 0, so the
provenance falls out of the index without a mode branch. One arithmetic
path serves carrier (δ-seeded) and subject (propagated) spans uniformly;
identity-carrier and active-carrier degenerate naturally because the
distinction is encoded in where the source mass sits.

What this module is NOT:

  - it is not a model primitive. ``probability_draws`` / ``timing_draws``
    style adapters that route ``k(∞)/n`` and ``k(τ)/n`` through the
    parametric composer are explicitly forbidden by the contract — they
    rely on accidental normalisation to avoid double-scaling.
  - it is not a fetch engine. Candidate rows arrive via
    ``request_evidence_candidates``; this module translates and binds,
    never widens.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Callable, Dict, Tuple

import numpy as np

from evidence_merge import EvidenceCandidate, EvidenceScope

from .bucket_transition import (
    BucketSourceBasis,
    cumulative_empirical_rate_to_transition,
    empirical_read_offset_for_basis,
)
from .prefix_arrival import NodeArrivalWeights
from .primitive_evidence import (
    PrimitiveEvidenceResolution,
    bind_primitive_evidence,
)
from .primitive_conditioning import _row_age_days
from .primitives import (
    PrimitiveScope,
    TimingFamily,
    TransitionIdentity,
    WeightedEvidenceRow,
    WeightedPrimitiveEvidenceView,
)
from .span_kernel import ConcreteEdge, _build_span_topology
from .subject_span_composer import ComposedPrimitiveSpan, EvidenceReadoutBinding
from .timing_span import DPExecutionPolicy, SpanDPTrace
from .timing_span import (
    _run_dp_density_trace,
    _run_dp_density_trace_from_seed,
    _run_dp_density_trace_from_provenance_seed,
)


__all__ = [
    "EmpiricalEvidencePrimitive",
    "build_empirical_evidence_primitive",
    "compose_empirical_span",
    "evaluate_empirical_span_from_seed",
    "evaluate_empirical_span_from_seed_flat_origins",
]


# ─── Result type ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class EmpiricalEvidencePrimitive:
    """Per-edge empirical operator surface — Phase 6 §4.9.

    Exposes value-kernel data on the composer's ``(S, T_p)`` grid
    (``S`` = draw count, ``T_p`` = composer horizon length in days).
    ``value_kernel_draws`` is per-draw ``Δ(k_emp / n_emp)``.

    Per Phase 6 §3.2 / §4.9, the per-draw axis is load-bearing. The
    same keyed timing particles that drive primitive conditioning's
    proposal also drive the per-draw arrival map in ``prefix_arrival``;
    ``bind_primitive_evidence`` carries per-draw ``n_weighted_draws`` /
    ``k_weighted_draws`` on each admitted row. ``value_kernel_draws``
    is built directly from those per-draw row weights — no broadcast.
    Under the data degeneracy where every draw receives the same
    arrival weight, the per-draw kernel rows coincide; that is a
    property of the input, not a code path.
    """
    transition: TransitionIdentity
    primitive_scope: PrimitiveScope
    draw_count: int
    horizon_len: int
    value_kernel_draws: np.ndarray         # (S, T_p) — Δ(k_emp/n_emp)
    saturation_per_draw: np.ndarray        # (S,) — cumulative k_emp/n_emp at T_p-1
    value_kernel_draws_by_source_day: Mapping[str, np.ndarray]
    resolution: PrimitiveEvidenceResolution
    value_cumulative_by_source_day: Mapping[str, np.ndarray]
    bucket_read_offset: float
    timing_family: TimingFamily
    use_source_basis: bool
    # Per-primitive lookup tables, computed once at construction by the
    # builder. Indexed by ``int(source_basis)``. The decisions they
    # encode are primitive-identity constants — they do not vary call
    # to call — so the dispatch is collapsed into a one-time table
    # build and the per-call path is a pure array read.
    _out_basis_by_source_basis: Tuple[BucketSourceBasis, ...]
    _cubic_read_offset_by_source_basis: Tuple[float, ...]

    def output_source_basis(self, source_basis: BucketSourceBasis) -> BucketSourceBasis:
        return self._out_basis_by_source_basis[int(source_basis)]

    def cubic_read_offset_for(self, source_basis: BucketSourceBasis) -> float:
        return self._cubic_read_offset_by_source_basis[int(source_basis)]


# ─── Per-edge primitive builder ───────────────────────────────────────


def build_empirical_evidence_primitive(
    *,
    transition: TransitionIdentity,
    primitive_scope: PrimitiveScope,
    arrival_weights: NodeArrivalWeights,
    evidence_scope: EvidenceScope,
    candidates: Sequence[EvidenceCandidate],
    draw_count: int,
    horizon_len: int,
    timing_family: TimingFamily = TimingFamily.LATENT,
    bucket_read_offset: float = 0.5,
    evidence_basis: str = "weighted",
    use_source_basis: bool = False,
) -> EmpiricalEvidencePrimitive:
    """Build the empirical operator for one edge ``U → V``.

    Reads the same admitted rows that ``bind_primitive_evidence``
    produces for the parametric conditioning pathway (no duplicate
    admission logic). Aggregates per-source-day observed cumulative
    counts via arrival weighting, forward-fills across absent ages,
    differentiates once to produce the per-τ rate kernel.

    Parameters
    ----------
    transition, primitive_scope, arrival_weights, evidence_scope,
    candidates
        Passed straight to ``bind_primitive_evidence`` so both
        operator families admit the same rows. ``evidence_scope``
        retains the WP8 default-off role check
        (``WINDOW_SUBJECT_HELPER`` only).
    draw_count
        Composer ``S``. Broadcast axis for the kernel arrays.
    horizon_len
        Composer ``T_p`` (= ``timing_cdf_max_tau + 1`` in
        ``ConditioningPolicyOptions``).
    """
    resolution = bind_primitive_evidence(
        transition=transition,
        primitive_scope=primitive_scope,
        evidence_scope=evidence_scope,
        candidates=candidates,
        arrival_weights=arrival_weights,
    )

    empirical_view = (
        _raw_evidence_as_unit_weight_view(resolution, draw_count)
        if evidence_basis == "raw_local"
        else resolution.weighted_view
    )
    empirical_kernels = _build_empirical_delta_kernel_draws(
        empirical_view,
        horizon_len,
        draw_count,
        timing_family,
        bucket_read_offset,
    )
    value_kernel_draws = empirical_kernels.value_kernel_draws
    saturation_per_draw = empirical_kernels.saturation_per_draw

    # Precompute the per-primitive (out_basis, cubic_read_offset)
    # lookup tables once. Ordered by ``int(BucketSourceBasis)`` so the
    # per-call path is a pure indexed read at runtime. The two
    # decisions are primitive-identity constants (depend on
    # ``timing_family`` and ``use_source_basis`` only); collapsing them
    # at construction removes the per-call dispatch from the engine
    # while preserving algebraic identity.
    bases = sorted(BucketSourceBasis, key=int)
    if timing_family == TimingFamily.NON_LATENT:
        out_basis_table = tuple(b for b in bases)
    else:
        out_basis_table = tuple(BucketSourceBasis.BUCKET_DISTRIBUTED for _ in bases)
    if use_source_basis:
        read_offset_table = tuple(
            float(empirical_read_offset_for_basis(b)) for b in bases
        )
    else:
        read_offset_table = tuple(float(bucket_read_offset) for _ in bases)

    return EmpiricalEvidencePrimitive(
        transition=transition,
        primitive_scope=primitive_scope,
        draw_count=draw_count,
        horizon_len=horizon_len,
        value_kernel_draws=value_kernel_draws,
        saturation_per_draw=saturation_per_draw,
        value_kernel_draws_by_source_day=empirical_kernels.value_by_source_day,
        resolution=resolution,
        value_cumulative_by_source_day=empirical_kernels.cumulative_by_source_day,
        bucket_read_offset=float(bucket_read_offset),
        timing_family=timing_family,
        use_source_basis=bool(use_source_basis),
        _out_basis_by_source_basis=out_basis_table,
        _cubic_read_offset_by_source_basis=read_offset_table,
    )


def _raw_evidence_as_unit_weight_view(
    resolution: PrimitiveEvidenceResolution,
    draw_count: int,
) -> WeightedPrimitiveEvidenceView:
    """Expose merge-admitted raw rows as an empirical local-rate view.

    Conditioning still consumes `resolution.weighted_view`. Strict
    empirical subject operators need local k/n kernels; A-clock placement
    is supplied by span composition, not by primitive evidence binding.
    """
    S = int(draw_count)
    rows = []
    n_total = 0.0
    k_total = 0.0
    for point in resolution.raw_evidence_set.points:
        observed = point.candidate.coordinate.observed_date
        retrieved = point.candidate.coordinate.retrieved_at
        n_val = float(point.n)
        k_val = float(point.k)
        n_total += n_val
        k_total += k_val
        rows.append(WeightedEvidenceRow(
            observed_date=observed,
            retrieved_at=retrieved,
            n=int(point.n),
            k=int(point.k),
            arrival_weight=1.0,
            n_weighted=n_val,
            k_weighted=k_val,
            arrival_weight_draws=np.ones(S, dtype=np.float32),
            n_weighted_draws=np.full(S, n_val, dtype=np.float32),
            k_weighted_draws=np.full(S, k_val, dtype=np.float32),
            root_day_shares={observed: 1.0},
        ))
    return WeightedPrimitiveEvidenceView(
        n_weighted_total=n_total,
        k_weighted_total=k_total,
        n_weighted_total_draws=np.full(S, n_total, dtype=np.float32),
        k_weighted_total_draws=np.full(S, k_total, dtype=np.float32),
        draw_count=S,
        rows=tuple(rows),
        arrival_weight_summary={
            'topology_case': 'raw_local_empirical',
            'support_days': len({row.observed_date for row in rows}),
        },
        binding_policy='raw_local_empirical_rate.v1',
        evidence_scope_key=resolution.raw_evidence_set.provenance.scope_key,
        evidence_scope_date_from=resolution.weighted_view.evidence_scope_date_from,
        evidence_scope_date_to=resolution.weighted_view.evidence_scope_date_to,
        skipped_counts_by_reason=dict(
            resolution.weighted_view.skipped_counts_by_reason
        ),
    )


@dataclass(frozen=True)
class _EmpiricalKernelBuild:
    value_kernel_draws: np.ndarray
    saturation_per_draw: np.ndarray
    value_by_source_day: Mapping[str, np.ndarray]
    cumulative_by_source_day: Mapping[str, np.ndarray]


def _build_empirical_delta_kernel_draws(
    weighted_view: WeightedPrimitiveEvidenceView,
    horizon_len: int,
    draw_count: int,
    timing_family: TimingFamily,
    bucket_read_offset: float,
) -> _EmpiricalKernelBuild:
    """Build strict empirical kernels + saturation.

    Per-draw algorithm (Phase 6 §3.2 / §4.9, no broadcast):

    1. Group admitted rows by source day.
    2. For each source day: latest-at-or-before per-draw ``k_emp``
       (sentinel-prepended ``searchsorted``); per-source-day per-draw
       ``n_emp`` taken as the per-draw max across the source day's
       retrievals (cohort size at U does not change between snapshots;
       per-draw max absorbs minor numerical drift in the same way the
       scalar path used to).
    3. Per-draw pool: ``total_k_draws[s, τ] = Σ_s k_emp(s, τ)``;
       ``total_n_pool_draws[s] = Σ_s max-n_emp(s)``.
    4. Per-draw cumulative rate ``B[s, τ] = total_k_draws[s, τ] /
       total_n_pool_draws[s]`` (0/0 → 0).
    5. Strict increment ``Δ[s, τ] = B[s, τ] − B[s, τ−1]`` with
       ``B[s, −1] = 0`` via ``np.diff(..., prepend=0.0, axis=1)``.
       This preserves the strict latest-at-or-before convention.
    Returns aggregate stationarity-fallback kernels plus per-source-day
    kernels. The aggregate fields preserve the previous age-only
    degeneracy for unsupported source days; ``*_by_source_day`` is the
    load-bearing Phase 6 §4.9 surface consumed when propagated mass
    lands on an observed source day.
    """
    S = int(draw_count)
    T = int(horizon_len)
    rows_by_source_day: Dict[
        str,
        list[Tuple[int, str, np.ndarray, np.ndarray]],
    ] = {}
    for row in weighted_view.rows:
        age = 0 if timing_family == TimingFamily.NON_LATENT else _row_age_days(row)
        if age is None:
            continue
        rows_by_source_day.setdefault(row.observed_date, []).append((
            int(age),
            str(row.retrieved_at or ''),
            np.asarray(row.k_weighted_draws, dtype=np.float32),
            np.asarray(row.n_weighted_draws, dtype=np.float32),
        ))

    total_k_draws = np.zeros((S, T), dtype=np.float32)
    total_n_pool_draws = np.zeros(S, dtype=np.float32)
    tau_grid = np.arange(T)
    value_by_source_day: Dict[str, np.ndarray] = {}
    cumulative_by_source_day: Dict[str, np.ndarray] = {}

    for source_day, entries in rows_by_source_day.items():
        sorted_entries = sorted(entries, key=lambda e: e[0])
        if timing_family == TimingFamily.NON_LATENT:
            sorted_entries = [max(entries, key=lambda e: e[1])]
        ages = np.array([e[0] for e in sorted_entries], dtype=int)
        # k_draws_per_retrieval: (n_rows, S) — one row per retrieval.
        ks_per_draw = np.stack([e[2] for e in sorted_entries], axis=0)
        ns_per_draw = np.stack([e[3] for e in sorted_entries], axis=0)
        # Per-draw n is the max across retrievals for THIS source day.
        # The per-source-day denominator is the load-bearing quantity
        # for Phase 6 §4.3's m_U(s) × Δk(s)/n(s) term.
        source_n_pool_draws = np.max(ns_per_draw, axis=0)
        total_n_pool_draws += source_n_pool_draws

        # Latest-at-or-before cumulative per draw: same sentinel-
        # prepended ``searchsorted`` as the scalar version, indexed
        # along the retrieval axis. ``ks_per_draw`` is (n_rows, S);
        # the gather produces (T, S) which we transpose to (S, T).
        ages_with_sentinel = np.concatenate(([-1], ages))
        ks_with_sentinel = np.concatenate(
            (np.zeros((1, S), dtype=np.float32), ks_per_draw), axis=0,
        )
        insertions = np.searchsorted(ages_with_sentinel, tau_grid, side='right')
        gathered = ks_with_sentinel[insertions - 1, :]  # (T, S)
        total_k_draws += gathered.T
        source_k_draws = gathered.T

        source_n = source_n_pool_draws[:, None]
        source_cumulative_rate = np.divide(
            source_k_draws, source_n,
            out=np.zeros_like(source_k_draws),
            where=source_n > 0.0,
        )
        source_value_kernel = cumulative_empirical_rate_to_transition(
            f"empirical::{source_day}",
            source_cumulative_rate,
            read_offset=float(bucket_read_offset),
        ).value
        value_by_source_day[source_day] = source_value_kernel
        cumulative_by_source_day[source_day] = source_cumulative_rate

    # Per-draw 0/0 row-contract: a draw whose total_n_pool_draws[s] is
    # zero (no admitted rows contributed under that draw) emits a zero
    # rate-kernel row. Same algebraic degeneracy as the scalar path.
    safe_n = total_n_pool_draws[:, None]
    cumulative_rate_draws = np.divide(
        total_k_draws, safe_n,
        out=np.zeros_like(total_k_draws),
        where=safe_n > 0.0,
    )

    value_kernel_draws = cumulative_empirical_rate_to_transition(
        "empirical::aggregate",
        cumulative_rate_draws,
        read_offset=float(bucket_read_offset),
    ).value
    saturation_per_draw = cumulative_rate_draws[:, -1].copy()
    return _EmpiricalKernelBuild(
        value_kernel_draws=value_kernel_draws,
        saturation_per_draw=saturation_per_draw,
        value_by_source_day=value_by_source_day,
        cumulative_by_source_day=cumulative_by_source_day,
    )


# ─── Per-edge primitive composer ──────────────────────────────────────


def compose_empirical_span(
    *,
    graph: Mapping[str, Any],
    x_node_id: str,
    end_node_id: str,
    edge_to_empirical_primitive_lookup: Callable[
        [str, str, Mapping[str, Any]],
        EmpiricalEvidencePrimitive,
    ],
    draw_count: int,
    horizon_len: int,
    evidence_readout_binding: EvidenceReadoutBinding | None = None,
) -> ComposedPrimitiveSpan:
    """Compose empirical per-edge kernels into a ``ComposedPrimitiveSpan``.

    Runs the same forward DAG DP (``_run_dp_density_trace``) that
    ``compose_primitive_span`` uses, with per-edge value kernels supplied
    by the empirical operator instead of the conditioned operator.
    Returns a ``ComposedPrimitiveSpan`` so the
    spine and downstream consumers treat it interchangeably with the
    conditioned composition (Phase 6 §5: "same DP/readout core and
    same node-id-keyed surfaces").

    Identity span (``x_node_id == end_node_id``) degenerates to a
    zero-edge composition: δ(0) at the root, asymptotic reach = 1.0
    (empty product), terminal cumulative = 1.0 — the algebraic identity
    of the operator-chain monoid. The DAG DP and ``_topological_reach``
    handle zero-edge topology natively: the root carries δ(0) by DP
    initialisation, the reach accumulator returns its empty-product
    seed of 1.0, and the per-stream `for s in range(S)` body produces
    the identity output without any case fork.
    """
    topo = _build_span_topology(dict(graph), x_node_id, end_node_id)
    S = int(draw_count)
    T = int(horizon_len)
    readout_binding = evidence_readout_binding or EvidenceReadoutBinding.cohort()
    edge_primitives = _resolve_edge_primitives(topo, edge_to_empirical_primitive_lookup)

    origin_day = _infer_empirical_origin_day(edge_primitives)

    trace_value = _run_empirical_source_day_dp_trace(
        topo=topo,
        edge_primitives=edge_primitives,
        S=S,
        T=T,
        origin_day=origin_day,
    )

    terminal_density = trace_value.node_density(topo.y_node_id)
    density_cdf = np.cumsum(terminal_density, axis=1)
    span_p_draws = density_cdf[:, -1].copy()
    # 0/0 at expected reach == 0 is genuine algebraic degeneracy (no
    # empirical mass propagates); emit 0 to match the spine's documented
    # convention.
    cdf_arr = np.divide(
        density_cdf,
        span_p_draws[:, None],
        out=np.zeros_like(density_cdf),
        where=span_p_draws[:, None] > 0.0,
    )

    span_p_mean = float(np.mean(span_p_draws))
    span_p_sd = float(np.std(span_p_draws))
    cdf_mean = cdf_arr.mean(axis=0)

    provenance = {
        "composition": "empirical_evidence_operator.compose_empirical_span",
        "shape": "draws",
        "S": S,
        "T": T,
        "primitive_count": len(edge_primitives),
        "concrete_edge_count": len(topo.concrete_edges),
    }

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
        max_tau=T - 1,
        node_density_by_node_bucket=trace_value.node_density_by_node_bucket,
        edge_contribution_by_edge_source=trace_value.edge_contribution_by_edge_source,
        node_basis_by_node_bucket=trace_value.node_basis_by_node_bucket,
        node_mass_by_provenance=trace_value.node_mass_by_provenance,
        concrete_edges=tuple(topo.concrete_edges),
        topology=topo,
        empirical_edge_primitives=tuple(edge_primitives),
        evidence_readout_binding=readout_binding,
        provenance=provenance,
    )


def _resolve_edge_primitives(
    topo,
    edge_to_empirical_primitive_lookup: Callable[
        [str, str, Mapping[str, Any]],
        EmpiricalEvidencePrimitive,
    ],
) -> list[Tuple[ConcreteEdge, EmpiricalEvidencePrimitive]]:
    """Map every concrete edge on the topology to its empirical
    primitive. Missing edges, draw-count mismatches, or horizon
    mismatches surface as natural failures (AttributeError or
    numpy shape errors) in the downstream DP — the lookup contract
    is a perimeter invariant, not an in-engine guard."""
    return [
        (ce, edge_to_empirical_primitive_lookup(ce.from_id, ce.to_id, ce.edge_data))
        for ce in topo.concrete_edges
    ]


def _infer_empirical_origin_day(
    edge_primitives: Sequence[Tuple[ConcreteEdge, EmpiricalEvidencePrimitive]],
) -> date:
    source_days = [
        date.fromisoformat(source_day)
        for _ce, primitive in edge_primitives
        for source_day in primitive.value_kernel_draws_by_source_day
    ]
    return min(source_days) if source_days else date(1970, 1, 1)


def _source_day_for_index(origin_day: date, day_index: int) -> str:
    return (origin_day + timedelta(days=int(day_index))).isoformat()


def _kernel_for_source_day(
    primitive: EmpiricalEvidencePrimitive,
    *,
    source_day: str,
) -> np.ndarray:
    return primitive.value_kernel_draws_by_source_day.get(
        source_day, primitive.value_kernel_draws,
    )


def _run_empirical_source_day_dp_trace(
    *,
    topo,
    edge_primitives: Sequence[Tuple[ConcreteEdge, EmpiricalEvidencePrimitive]],
    S: int,
    T: int,
    origin_day: date,
) -> Any:
    primitive_by_edge = {ce.edge_key: prim for ce, prim in edge_primitives}
    return _run_dp_density_trace(
        topo,
        lambda ce, source_index: _kernel_for_source_day(
            primitive_by_edge[ce.edge_key],
            source_day=_source_day_for_index(origin_day, source_index),
        ),
        S,
        T,
    )


def evaluate_empirical_span_from_seed(
    span: ComposedPrimitiveSpan,
    *,
    root_seed: np.ndarray,
    origin_day: date,
    evidence_readout_binding: EvidenceReadoutBinding,
) -> Any:
    """Evaluate empirical kernels from caller-supplied source-day mass.

    ``compose_empirical_span`` is the operator identity readout. Selected
    cohorts need a lookup-bound cumulative transition evaluator:

      * cohort binding reads ``R(origin+i, τ-i)`` and preserves the
        current source-day / remaining-age composition;
      * window binding reads ``R(origin, τ)`` for every source bucket,
        so the rate term factors out and yields the local lookup identity.

    The same binding object is used for every strict evidence value
    lookup so window/cohort clocks stay aligned with the conditioned
    model surfaces.
    """
    primitive_by_edge = {
        ce.edge_key: prim for ce, prim in span.empirical_edge_primitives
    }
    S, T = root_seed.shape
    return _run_empirical_lookup_bound_trace(
        span=span,
        primitive_by_edge=primitive_by_edge,
        root_seed=root_seed,
        origin_day=origin_day,
        evidence_readout_binding=evidence_readout_binding,
        S=S,
        T=T,
    )


def evaluate_empirical_span_from_seed_flat_origins(
    span: ComposedPrimitiveSpan,
    *,
    root_seed: np.ndarray,
    origin_days: Sequence[date],
    evidence_readout_binding: EvidenceReadoutBinding,
    root_basis: np.ndarray | None = None,
) -> Any:
    """Evaluate empirical kernels with selected cohorts flattened into axis 0.

    Collapsed ``(root_seed, root_basis)`` form. Callers carrying a
    per-bucket per-provenance seed (carrier → subject handoff) call
    ``evaluate_empirical_span_from_seed_flat_origins_with_provenance``
    instead.
    """
    _, T = root_seed.shape
    provider = _build_empirical_provider_for_span(
        span=span,
        origin_days=origin_days,
        evidence_readout_binding=evidence_readout_binding,
        T=T,
    )
    return _run_dp_density_trace_from_seed(
        span.topology,
        provider,
        root_seed,
        root_seed.shape[0],
        T,
        execution_policy=DPExecutionPolicy.SOURCE_BANDED,
        cohort_count=len(origin_days),
        root_basis=root_basis,
    )


def evaluate_empirical_span_from_seed_flat_origins_with_provenance(
    span: ComposedPrimitiveSpan,
    *,
    S_flat: int,
    T: int,
    origin_days: Sequence[date],
    evidence_readout_binding: EvidenceReadoutBinding,
    root_provenance_mass: Mapping[int, Mapping[str, np.ndarray]],
    root_provenance_basis: Mapping[int, Mapping[str, int]],
) -> Any:
    """Provenance-seeded variant of the empirical flat-origins evaluator.

    Each provenance entry at the carrier terminal keeps its own ``(S,)``
    mass and basis so mixed basis survives the carrier → subject join.
    ``S_flat`` / ``T`` are the seed-shape metadata the DP needs even
    though the mass content lives in the provenance map.
    """
    provider = _build_empirical_provider_for_span(
        span=span,
        origin_days=origin_days,
        evidence_readout_binding=evidence_readout_binding,
        T=T,
    )
    return _run_dp_density_trace_from_provenance_seed(
        span.topology,
        provider,
        root_provenance_mass=root_provenance_mass,
        root_provenance_basis=root_provenance_basis,
        S=S_flat,
        T=T,
        execution_policy=DPExecutionPolicy.SOURCE_BANDED,
        cohort_count=len(origin_days),
    )


def _build_empirical_provider_for_span(
    *,
    span: ComposedPrimitiveSpan,
    origin_days: Sequence[date],
    evidence_readout_binding: EvidenceReadoutBinding,
    T: int,
) -> Callable:
    primitive_by_edge = {
        ce.edge_key: prim for ce, prim in span.empirical_edge_primitives
    }
    return _build_empirical_flat_kernel_provider(
        primitive_by_edge=primitive_by_edge,
        origin_days=origin_days,
        evidence_readout_binding=evidence_readout_binding,
        S=int(span.draw_count),
        T=T,
    )


def _empirical_kernel_for_source_bucket(
    *,
    primitive: EmpiricalEvidencePrimitive,
    origin_day: date,
    source_index: int,
    cohort_index: int,
    evidence_readout_binding: EvidenceReadoutBinding,
    source_basis: BucketSourceBasis,
    S: int,
    T: int,
) -> np.ndarray:
    cumulative = np.zeros((S, T), dtype=np.float32)
    for relative_offset in range(T):
        tau_out = min(int(source_index) + int(relative_offset), T - 1)
        source_day, age = evidence_readout_binding.lookup(
            origin_day=origin_day,
            source_index=int(source_index),
            tau_out=tau_out,
        )
        cumulative[:, relative_offset] = _bound_age_cumulative_rate(
            primitive,
            source_day=source_day,
            age=age,
            S=S,
        )
    name = (
        f"empirical::{primitive.transition.edge_id}"
        f"::source:{source_index}:cohort:{cohort_index}"
    )
    return cumulative_empirical_rate_to_transition(
        name,
        cumulative,
        read_offset=primitive.cubic_read_offset_for(source_basis),
    ).value


# Source-banded fast path chunking budget (Atom 4d).
#
# Per FC plan §1111 chunk size must come from a working-set estimate
# over ``(C, D, active_u, T)`` rather than a guessed scalar. The budget
# bounds peak transient working memory for the per-(edge, basis)
# cumulative + transition tensors built inside one source-banded
# provider call.
#
# Working-set estimate per chunk (bytes):
#
#     2 * chunk_u * C * s_eff * T * 8
#
# The leading ``2 *`` accounts for both the cumulative input tensor and
# the cubic-spline output transition tensor held concurrently across the
# cubic-spline call. Solving for ``chunk_u`` against the budget gives
#
#     chunk_u ≈ budget_bytes / (2 * C * s_eff * T * 8)
#
# At ``1 GiB`` and synth-lat4 (``C=49, s_eff=1000, T=115``):
#
#     chunk_u ≈ 1024**3 / (2 * 49 * 1000 * 115 * 8) ≈ 11
#
# At ``s_eff = 1`` (raw-local empirical) the same budget admits chunks
# well above any realistic ``active_u`` count, so the loop runs as a
# single chunk for that data regime — degenerate by data, not by case
# fork.
_SOURCE_BANDED_CHUNK_MEMORY_BUDGET_BYTES = 1024 * 1024 * 1024
# Minimum chunk size — guards the tiny-T degenerate where the budget
# divides to zero. Always at least one source bucket per chunk.
_SOURCE_BANDED_MIN_CHUNK_SIZE_U = 1


# Data-driven dispatch threshold for the SOURCE_BANDED applier. After
# precomputed-kernel cache hits, the remaining ``pending_groups`` each
# cost one cubic-spline call. If those pending groups serve too few
# consumers each (``pending_consumers / pending_groups < threshold``)
# the per-group machinery's allocation + dispatch overhead exceeds the
# work it saves — falling through to a per-consumer scalar build is
# strictly cheaper on the same algebra. The threshold is the
# break-even reuse ratio; ``2.0`` matches the empirical break-even at
# synth-lat4 dimensions (window-binding pending ratio ≈ 1.0, scalar
# wins; cohort-binding leaves no pending after cache hits).
_SOURCE_BANDED_BUILD_REUSE_THRESHOLD = 2.0


def _source_banded_chunk_size(*, C: int, s_eff: int, T: int) -> int:
    """Pick ``chunk_size_u`` from the configured working-memory budget.

    Working set per chunk is dominated by the ``(chunk_u, C, s_eff, T)``
    cumulative tensor used to feed the cubic-spline reduction; the
    output transition tensor is the same shape held concurrently. Both
    cost ``8 × chunk_u × C × s_eff × T`` bytes, hence the ``2 ×``
    factor below.

    Returned value is clamped to ``[_SOURCE_BANDED_MIN_CHUNK_SIZE_U, T]``
    — there is no point chunking past ``T`` since at most ``T`` source
    buckets can be active in a horizon-``T`` ledger.
    """
    per_u_bytes = 8 * int(C) * int(s_eff) * int(T)
    derived = max(
        _SOURCE_BANDED_MIN_CHUNK_SIZE_U,
        _SOURCE_BANDED_CHUNK_MEMORY_BUDGET_BYTES // (2 * per_u_bytes),
    )
    return min(int(derived), int(T))


def _empirical_cumulative_s_axis_width(
    primitive: EmpiricalEvidencePrimitive,
) -> int:
    """Effective S width of the primitive's per-source-day cumulative.

    The empirical operator's per-source-day cumulative matrices are
    nominally (S, T), but for binding policies where per-draw arrival
    weights are uniform (``raw_local_empirical_rate.v1`` — `arrival_weight_draws
    = np.ones(S)`, `n/k_weighted_draws = np.full(S, scalar)`) every row
    of the (S, T) cumulative is bit-identical. Running the cubic-spline
    reduction on S=1000 identical copies of the same row is pure waste.

    This helper returns ``1`` when the cumulative is S-degenerate across
    every source_day stored on the primitive, and ``S`` otherwise. The
    batched kernel builder uses the result to shape its cubic-spline
    input as ``(chunk_n × s_eff, T)`` instead of ``(chunk_n × S, T)``.
    The DP-loop broadcast `kernel[:, :, :remaining] *
    source_density[:, :, idx, None]` consumes either shape correctly
    because numpy broadcasts ``(cohort, 1, T)`` against
    ``(cohort, S_per_cohort, T)`` identically to ``(cohort, S, T)``.

    The degeneracy is data, not a case fork: returning ``1`` versus ``S``
    is a single integer surface fed through one code path.
    """
    by_day = primitive.value_cumulative_by_source_day
    if not by_day:
        return 1
    first_matrix = next(iter(by_day.values()))
    s_dim = int(first_matrix.shape[0])
    if s_dim <= 1:
        return s_dim
    for matrix in by_day.values():
        first_row = matrix[0:1]
        if not np.array_equal(first_row, matrix):
            return s_dim
    return 1


def _build_empirical_flat_kernel_provider(
    *,
    primitive_by_edge: Mapping[str, EmpiricalEvidencePrimitive],
    origin_days: Sequence[date],
    evidence_readout_binding: EvidenceReadoutBinding,
    S: int,
    T: int,
):
    # Precompute the effective S-axis width per primitive once. For
    # binding policies where the (S, T) cumulative has uniform rows
    # (raw_local_empirical_rate.v1 — every draw shares the same observed
    # k/n), the cubic-spline reduction collapses to one row per cohort
    # with broadcasting in the DP multiply. Read-only data captured by
    # the batched closure.
    s_eff_by_edge: Dict[str, int] = {
        edge_key: _empirical_cumulative_s_axis_width(primitive)
        for edge_key, primitive in primitive_by_edge.items()
    }

    def provider(
        ce: ConcreteEdge,
        source_index: int,
        cohort_index: int,
        source_basis: BucketSourceBasis,
    ) -> np.ndarray:
        kernel = _empirical_kernel_for_source_bucket(
            primitive=primitive_by_edge[ce.edge_key],
            origin_day=origin_days[int(cohort_index)],
            source_index=int(source_index),
            cohort_index=int(cohort_index),
            evidence_readout_binding=evidence_readout_binding,
            source_basis=source_basis,
            S=S,
            T=T,
        )
        return kernel, primitive_by_edge[ce.edge_key].output_source_basis(source_basis)

    def source_banded_op(
        ce: ConcreteEdge,
        source_basis: BucketSourceBasis,
        source_mass_3d: np.ndarray,
    ):
        # FC plan §1093 / §1096 / §1107: source-indexed banded fast path
        # for the general empirical equation
        # ``out[c, d, v] = Σ_u mass[c, d, u] · K[c, d, u, v − u]``.
        #
        # Architecture — three data-shape dispatches, none of them mode-
        # branches:
        #
        #   1. Kernel identity dedup. ``(u, c)`` pairs collapse to a
        #      semantic key ``(source_day, age_start)``. Data with high
        #      ``reuse_ratio = consumers / unique_groups`` (typical
        #      cohort-anchored evidence) drops kernel-build cost by that
        #      factor; data with low reuse pays exactly the per-consumer
        #      cost the SCALAR provider pays.
        #
        #   2. Precomputed-kernel cache hit. The primitive carries a
        #      pre-built per-source-day kernel ``value_kernel_draws_by_
        #      source_day[source_day]`` constructed at primitive build
        #      time with ``primitive.bucket_read_offset``. For groups
        #      with ``age_start == 0`` and matching read_offset the
        #      cubic-spline call is replaced by a slice. Cache miss
        #      falls through to (3).
        #
        #   3. Width-bucketed cubic-spline streaming. Remaining groups
        #      are bucketed by ``group_max_width`` so each cubic-spline
        #      call's ``output_width`` matches the group's true width
        #      (no chunk-global overproduction). Within a width bucket,
        #      groups are processed in memory-budgeted chunks; each
        #      chunk's kernel tensor is built, applied to all consumers
        #      of those groups, and released before the next chunk
        #      allocates — peak transient memory stays bounded.
        #
        # Output algebra is identical to SCALAR per (u, c); parity is
        # enforced by ``test_empirical_source_banded_parity.py``.
        # ``provider._source_banded_dispatch_log`` records per-call
        # shape and dispatch decisions so production tests can assert
        # the expected sub-path on representative request shapes.
        primitive = primitive_by_edge[ce.edge_key]
        out_basis = primitive.output_source_basis(source_basis)
        cohort_count, S_per_cohort, _ = source_mass_3d.shape
        out_3d = np.zeros(
            (cohort_count, S_per_cohort, T), dtype=np.float32,
        )
        # defaultdict factory removes the per-write ``if smear is None``
        # init check; first read of an unseen ``u`` produces the zero
        # (S, T) buffer in one expression.
        smear_map: Dict[int, np.ndarray] = defaultdict(
            lambda: np.zeros(
                (cohort_count * S_per_cohort, T), dtype=np.float32,
            ),
        )
        active = np.flatnonzero(
            np.any(source_mass_3d != 0.0, axis=(0, 1))
        )

        s_eff = s_eff_by_edge[ce.edge_key]
        edge_id = primitive.transition.edge_id
        cumulative_by_day = primitive.value_cumulative_by_source_day
        precomputed_by_day = primitive.value_kernel_draws_by_source_day
        origin_days_for_chunk = origin_days[:cohort_count]
        # Zero-cumulative fallback for source-days the primitive has no
        # evidence for. ``(s_eff, 1)`` is the minimum width that supports
        # the forward-fill slice algebra below without a None check.
        _zero_cum = np.zeros((s_eff, 1), dtype=np.float32)
        # Cubic-spline read_offset is determined by the primitive +
        # source_basis combination ONCE per (edge, basis) call. The
        # precomputed kernel cache is consultable only when the cubic
        # call would have used the same read_offset as the primitive
        # used at construction.
        cubic_read_offset = primitive.cubic_read_offset_for(source_basis)
        precomputed_cache_compatible = (
            cubic_read_offset == float(primitive.bucket_read_offset)
        )

        # ── Phase 1: enumerate consumers, dedupe to semantic groups.
        group_keys: list = []
        group_idx_by_key: Dict = {}
        group_max_width: list = []
        consumers_by_group: Dict[int, list] = {}
        for u_np in active:
            u_int = int(u_np)
            kernel_width = T - u_int
            for c_idx in range(cohort_count):
                source_day, age_start = evidence_readout_binding.lookup(
                    origin_day=origin_days_for_chunk[c_idx],
                    source_index=u_int,
                    tau_out=u_int,  # relative_offset = 0
                )
                key = (source_day, int(age_start))
                g = group_idx_by_key.get(key)
                if g is None:
                    g = len(group_keys)
                    group_idx_by_key[key] = g
                    group_keys.append(key)
                    group_max_width.append(kernel_width)
                    consumers_by_group[g] = []
                else:
                    if group_max_width[g] < kernel_width:
                        group_max_width[g] = kernel_width
                consumers_by_group[g].append((u_int, c_idx, kernel_width))

        n_groups = len(group_keys)
        n_consumers = sum(
            len(consumers) for consumers in consumers_by_group.values()
        )

        # Dispatch one kernel to all its consumers + populate trace
        # surfaces. Closure captures out_3d / smear_map / source_mass_3d.
        def _apply_kernel_to_consumers(g: int, kernel_full: np.ndarray) -> None:
            for u_int, c_idx, kernel_width in consumers_by_group[g]:
                kernel = kernel_full[:, :kernel_width]
                bucket_mass = source_mass_3d[c_idx, :, u_int]
                contribution = bucket_mass[:, None] * kernel
                out_3d[
                    c_idx, :, u_int:u_int + kernel_width,
                ] += contribution
                smear_map[u_int].reshape(cohort_count, S_per_cohort, T)[
                    c_idx, :, u_int:u_int + kernel_width,
                ] += contribution

        # ── Phase 2: precomputed-kernel cache hits. Pure slice + apply,
        # no cubic-spline call. Cache key is the semantic identity
        # ``(source_day, age_start=0)`` matched against the primitive's
        # pre-built per-source-day kernel surface. The precomputed
        # kernel is at the primitive's ``horizon_len`` which may be
        # narrower than the DP's ``T``; pad with zeros (the saturated
        # cumulative's transition tail) to the required group width.
        pending_groups: list = []
        n_cache_hits = 0
        for g, (source_day, age_start) in enumerate(group_keys):
            if (
                age_start == 0
                and precomputed_cache_compatible
                and source_day in precomputed_by_day
            ):
                precomputed = precomputed_by_day[source_day]
                required = group_max_width[g]
                # Unconditional pad: covers both narrower and wider
                # precomputed kernels with the same arithmetic. ``copy``
                # holds the kernel; tail past ``actual`` stays zero
                # (algebraically the saturated transition's zero tail).
                copy_width = min(int(precomputed.shape[1]), required)
                kernel_full = np.zeros((s_eff, required), dtype=np.float32)
                kernel_full[:, :copy_width] = precomputed[:s_eff, :copy_width]
                _apply_kernel_to_consumers(g, kernel_full)
                n_cache_hits += 1
            else:
                pending_groups.append(g)

        # ── Phase 3: build cache-miss kernels. Data-driven dispatch
        # between two builders on the same algebra:
        #
        #   (3a) Group cubic-spline (width-bucketed, streamed). Each
        #        unique kernel identity gets ONE cubic-spline call;
        #        consumers share it. Wins when ``pending_consumers /
        #        pending_groups >= _SOURCE_BANDED_BUILD_REUSE_THRESHOLD``
        #        — high reuse amortises group-machinery overhead.
        #
        #   (3b) Per-consumer scalar build. Each consumer builds its
        #        own kernel via ``_empirical_kernel_for_source_bucket``
        #        (the SCALAR provider's per-call path) and applies it.
        #        Wins when reuse is too low for the group machinery to
        #        pay its dispatch / allocation overhead.
        #
        # The decision reads only data-shape facts
        # (``pending_consumers``, ``pending_groups``); there is no
        # mode / window / cohort branch. Both sub-paths produce the
        # same algebraic output; parity is enforced by
        # ``test_empirical_source_banded_parity.py``.
        n_built = 0
        n_chunks = 0
        build_sub_path = 'none'
        # Unconditional stats: empty ``pending_groups`` gives an empty
        # sum (== 0). ``build_reuse_ratio`` collapses to 0.0 when there
        # are no pending groups; the dispatch ``if pending_groups and
        # build_reuse_ratio < THRESHOLD`` below gates the actual use.
        pending_consumers = sum(
            len(consumers_by_group[g]) for g in pending_groups
        )
        build_reuse_ratio = (
            pending_consumers / len(pending_groups)
            if pending_groups else 0.0
        )
        if pending_groups and (
            build_reuse_ratio < _SOURCE_BANDED_BUILD_REUSE_THRESHOLD
        ):
            # (3b) Per-consumer scalar build.
            build_sub_path = 'per_consumer_scalar'
            for g in pending_groups:
                for u_int, c_idx, kernel_width in consumers_by_group[g]:
                    kernel = _empirical_kernel_for_source_bucket(
                        primitive=primitive,
                        origin_day=origin_days_for_chunk[c_idx],
                        source_index=u_int,
                        cohort_index=c_idx,
                        evidence_readout_binding=evidence_readout_binding,
                        source_basis=source_basis,
                        S=S,
                        T=T,
                    )
                    # kernel is (S, kernel_width); slice rows to s_eff
                    # (the per-draw degenerate path the group builder
                    # already exploits via primitive cumulative slicing).
                    _apply_kernel_to_consumers(g, kernel[:s_eff])
                    n_built += 1
        elif pending_groups:
            # (3a) Group cubic-spline, width-bucketed + streamed.
            build_sub_path = 'group_cubic_spline'
            groups_by_width: Dict[int, list] = {}
            for g in pending_groups:
                w = group_max_width[g]
                groups_by_width.setdefault(w, []).append(g)
            for width in sorted(groups_by_width.keys(), reverse=True):
                width_groups = groups_by_width[width]
                cum_W = width + 1
                chunk_size_g = _source_banded_chunk_size(
                    C=1, s_eff=s_eff, T=cum_W,
                )
                for chunk_start in range(
                    0, len(width_groups), int(chunk_size_g),
                ):
                    chunk_end = min(
                        chunk_start + int(chunk_size_g),
                        len(width_groups),
                    )
                    chunk_groups = width_groups[chunk_start:chunk_end]
                    chunk_count = len(chunk_groups)
                    chunk_cum = np.zeros(
                        (chunk_count, s_eff, cum_W), dtype=np.float32,
                    )
                    for local_idx, g in enumerate(chunk_groups):
                        source_day, age_start = group_keys[g]
                        # ``.get(source_day, _ZERO_CUM)`` produces a
                        # ``(s_eff, 1)`` zero fallback when the binding
                        # selects a source day the primitive has no
                        # evidence for. Slicing + forward-fill produce
                        # an all-zero chunk_cum row in that case; the
                        # cubic-spline emits a zero kernel; smear_map
                        # is populated with zeros — same algebra as
                        # SCALAR with no engine branch.
                        stored = cumulative_by_day.get(
                            source_day, _zero_cum,
                        )
                        max_age = int(stored.shape[1])
                        avail_end = min(
                            int(age_start) + cum_W, max_age,
                        )
                        avail_count = max(0, avail_end - int(age_start))
                        chunk_cum[local_idx, :, :avail_count] = stored[
                            :s_eff,
                            int(age_start):int(age_start) + avail_count,
                        ]
                        chunk_cum[local_idx, :, avail_count:] = stored[
                            :s_eff,
                            max(0, avail_end - 1):max(1, avail_end),
                        ]
                    flat_in = chunk_cum.reshape(
                        chunk_count * s_eff, cum_W,
                    )
                    name = (
                        f"empirical::{edge_id}::source_banded::"
                        f"w{width}[{chunk_start}:{chunk_end}]"
                    )
                    chunk_kernel_flat = (
                        cumulative_empirical_rate_to_transition(
                            name, flat_in,
                            read_offset=cubic_read_offset,
                            output_width=width,
                        ).value
                    )
                    chunk_kernels = chunk_kernel_flat.reshape(
                        chunk_count, s_eff, width,
                    )
                    for local_idx, g in enumerate(chunk_groups):
                        _apply_kernel_to_consumers(
                            g, chunk_kernels[local_idx],
                        )
                    n_built += chunk_count
                    n_chunks += 1
                    # chunk_cum, chunk_kernel_flat, chunk_kernels become
                    # unreferenced after this iteration — GC can release.

        provider._source_banded_dispatch_log.append({
            'edge_key': ce.edge_key,
            'source_basis': int(source_basis),
            'n_consumers': n_consumers,
            'n_groups': n_groups,
            'reuse_ratio': float(n_consumers) / float(max(n_groups, 1)),
            'n_cache_hits': n_cache_hits,
            'pending_consumers': pending_consumers,
            'pending_groups': len(pending_groups),
            'build_reuse_ratio': build_reuse_ratio,
            'build_sub_path': build_sub_path,
            'n_built': n_built,
            'n_chunks': n_chunks,
        })
        return out_3d, out_basis, smear_map

    provider.source_banded_op = source_banded_op
    # Per-call diagnostic surface (plan §1195 — "selected policy
    # recorded noisily"). Each ``source_banded_op`` invocation appends
    # a dict describing the (edge, basis) request's shape and dispatch
    # decisions; production tests assert the expected sub-path
    # selection on representative shapes.
    provider._source_banded_dispatch_log = []
    # Plan §1200-1203 — production provider families declare their
    # expected fast-path dispatch. The empirical provider's only
    # production-grade fast path is SOURCE_BANDED; an unexpected
    # SCALAR dispatch on a production-scale request is the regression
    # the dispatch-assertion test (§1195 / §1208) is designed to catch.
    provider.expected_production_policy = DPExecutionPolicy.SOURCE_BANDED
    return provider


def _run_empirical_lookup_bound_trace(
    *,
    span: ComposedPrimitiveSpan,
    primitive_by_edge: Mapping[str, EmpiricalEvidencePrimitive],
    root_seed: np.ndarray,
    origin_day: date,
    evidence_readout_binding: EvidenceReadoutBinding,
    S: int,
    T: int,
) -> SpanDPTrace:
    from .timing_span import SEED_ORIGIN_KEY

    topo = span.topology
    node_density: Dict[str, np.ndarray] = {
        node: np.zeros((S, T), dtype=np.float32) for node in topo.on_path
    }
    node_density[topo.x_node_id] = np.asarray(root_seed, dtype=np.float32).copy()
    edge_contribution_by_edge_source: Dict[str, Dict[int, np.ndarray]] = {}
    # Canonical per-edge basis provenance + per-provenance mass. The
    # lookup-bound trace fixes ``source_basis = POINT_AT_ENDPOINT`` at
    # every source bucket so every contributing provenance carries that
    # basis under its own edge_key (or ``SEED_ORIGIN_KEY`` for the root
    # seed). The two surfaces are kept in lockstep so chained DPs that
    # consume this trace see a coherent per-provenance seed.
    node_basis_by_node_bucket: Dict[str, Dict[int, Dict[str, int]]] = {
        node: {} for node in topo.on_path
    }
    node_mass_by_provenance: Dict[str, Dict[int, Dict[str, np.ndarray]]] = {
        node: {} for node in topo.on_path
    }
    root_seed_arr = node_density[topo.x_node_id]
    root_active_cols = np.flatnonzero(np.any(root_seed_arr != 0.0, axis=0))
    for col in root_active_cols:
        col_int = int(col)
        node_basis_by_node_bucket[topo.x_node_id][col_int] = {
            SEED_ORIGIN_KEY: int(BucketSourceBasis.POINT_AT_ENDPOINT),
        }
        node_mass_by_provenance[topo.x_node_id][col_int] = {
            SEED_ORIGIN_KEY: root_seed_arr[:, col_int].copy(),
        }

    for node in topo.topo_order:
        for ce in topo.incoming_concrete_edges.get(node, ()):
            source_density = node_density[ce.from_id]
            cumulative_contribution = np.zeros((S, T), dtype=np.float32)
            edge_source_map: Dict[int, np.ndarray] = {}
            source_indices = np.flatnonzero(np.any(source_density != 0.0, axis=0))
            for source_index_raw in source_indices:
                source_index = int(source_index_raw)
                source_mass = source_density[:, source_index]
                kernel = _empirical_kernel_for_source_bucket(
                    primitive=primitive_by_edge[ce.edge_key],
                    origin_day=origin_day,
                    source_index=source_index,
                    cohort_index=0,
                    evidence_readout_binding=evidence_readout_binding,
                    source_basis=BucketSourceBasis.POINT_AT_ENDPOINT,
                    S=S,
                    T=T,
                )
                remaining = T - source_index
                source_chunk = np.zeros((S, T), dtype=np.float32)
                source_chunk[:, source_index:] = (
                    source_mass[:, None] * kernel[:, :remaining]
                )
                edge_source_map[source_index] = source_chunk
                cumulative_contribution += source_chunk
            edge_contribution_by_edge_source[ce.edge_key] = edge_source_map
            node_density[node] += cumulative_contribution
            active_cols = np.flatnonzero(
                np.any(cumulative_contribution != 0.0, axis=0),
            )
            edge_basis_int = int(BucketSourceBasis.POINT_AT_ENDPOINT)
            edge_prov_key = f'{ce.edge_key}@{edge_basis_int}'
            for col in active_cols:
                col_int = int(col)
                bucket_map = node_basis_by_node_bucket[node].setdefault(col_int, {})
                bucket_map[edge_prov_key] = edge_basis_int
                mass_map = node_mass_by_provenance[node].setdefault(col_int, {})
                mass_map[edge_prov_key] = cumulative_contribution[:, col_int].copy()

    # Post-DP node-density decomposition: each on-path node's final
    # ``node_density[node]`` is decomposed into per-arrival-bucket
    # entries. The root carries the seed; intermediates carry
    # accumulated arrivals; both reduce through one comprehension.
    node_density_by_node_bucket = {
        node: {
            int(col): dense[:, int(col)].copy()
            for col in np.flatnonzero(np.any(dense != 0.0, axis=0))
        }
        for node, dense in node_density.items()
    }

    return SpanDPTrace(
        node_density_by_node_bucket=node_density_by_node_bucket,
        edge_contribution_by_edge_source=edge_contribution_by_edge_source,
        node_basis_by_node_bucket=node_basis_by_node_bucket,
        node_mass_by_provenance=node_mass_by_provenance,
        draw_count=S,
        horizon_len=T,
    )


def _bound_age_cumulative_rate(
    primitive: EmpiricalEvidencePrimitive,
    *,
    source_day: str,
    age: float,
    S: int,
) -> np.ndarray:
    """Cumulative empirical rate at the age supplied by the binding.

    ``EvidenceReadoutBinding`` owns the source-day and integer age
    convention for empirical readout. This function returns endpoint
    cumulative values; the shared bucket-K helper owns any bucket-centred
    placement when those cumulatives are converted to transition mass.

    Algebraic-degenerate cases — negative ``age`` (cohort-binding can
    produce one when ``origin_day > tau_out``) and missing source-day
    (binding hits a day with no admitted evidence) — are absorbed into
    one branch-free expression: ``.get`` supplies a (S, 1) zero
    fallback; the age is clipped into a valid index; and the
    ``float(age >= 0)`` mask zeroes the result when age is negative.
    Real data, missing source-day, and out-of-range age all reduce
    through the same arithmetic.
    """
    cumulative = primitive.value_cumulative_by_source_day.get(
        source_day, np.zeros((S, 1), dtype=np.float32),
    )
    age_idx = min(max(int(age), 0), cumulative.shape[1] - 1)
    return cumulative[:, age_idx] * float(age >= 0)


