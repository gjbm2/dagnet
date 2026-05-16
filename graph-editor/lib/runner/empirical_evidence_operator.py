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
model quadrature, no interpolation, no midpoint shift, no curvature
correction. Forward-fill of the cumulative across absent ages is the
only completion policy and emerges structurally from the increment
form (``Δ = 0`` at absent cells; the cumulative jump is absorbed at
the next observed age).

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

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Callable, Dict, Tuple

import numpy as np

from evidence_merge import EvidenceCandidate, EvidenceScope

from .prefix_arrival import NodeArrivalWeights
from .primitive_evidence import (
    PrimitiveEvidenceResolution,
    bind_primitive_evidence,
)
from .primitive_conditioning import _row_age_days
from .primitives import (
    PrimitiveScope,
    TransitionIdentity,
    WeightedPrimitiveEvidenceView,
)
from .span_kernel import ConcreteEdge, _build_span_topology
from .subject_span_composer import ComposedPrimitiveSpan
from .timing_span import SpanDPTrace


__all__ = [
    "EmpiricalEvidencePrimitive",
    "build_empirical_evidence_primitive",
    "compose_empirical_span",
]


# ─── Result type ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class EmpiricalEvidencePrimitive:
    """Per-edge empirical operator surface — Phase 6 §4.9.

    Exposes kernel data on the composer's ``(S, T_p)`` grid (``S`` =
    draw count, ``T_p`` = composer horizon length in days). All four
    streams share the same shape so downstream consumers can pick the
    one they need without branching.

    ``value_kernel_draws`` is per-draw ``Δ(k_emp / n_emp)``. ``support``
    is value × mask (equal to value under §4.9 because the empirical
    value kernel is already zero at absent cells; retained for
    interface symmetry with the conditioned operator). ``exposure``
    carries the mask itself — coverage/exposure are read exclusively
    from the conditioned operator's streams per §4.9, so the empirical
    exposure is placeholder rather than a load-bearing signal.
    ``observation_mask_draws`` is the row-presence mask: 1 iff an
    admitted row contributes at the cell, 0 elsewhere.

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
    support_kernel_draws: np.ndarray       # (S, T_p) — value × mask
    exposure_kernel_draws: np.ndarray      # (S, T_p) — mask × unit shape
    observation_mask_draws: np.ndarray     # (S, T_p) — row presence
    saturation_per_draw: np.ndarray        # (S,) — cumulative k_emp/n_emp at T_p-1
    value_kernel_draws_by_source_day: Mapping[str, np.ndarray]
    support_kernel_draws_by_source_day: Mapping[str, np.ndarray]
    exposure_kernel_draws_by_source_day: Mapping[str, np.ndarray]
    observation_mask_draws_by_source_day: Mapping[str, np.ndarray]
    saturation_per_draw_by_source_day: Mapping[str, np.ndarray]
    resolution: PrimitiveEvidenceResolution


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

    empirical_kernels = _build_empirical_delta_kernel_draws(
        resolution.weighted_view, horizon_len, draw_count,
    )
    value_kernel_draws = empirical_kernels.value_kernel_draws
    adjusted_kernel_draws = empirical_kernels.adjusted_kernel_draws
    mask_draws = empirical_kernels.mask_draws
    saturation_per_draw = empirical_kernels.saturation_per_draw

    # Under §4.9 the empirical value kernel is already zero at absent
    # cells (Δ = 0 there), so value × mask = value identically. The
    # explicit multiply makes the contract visible and the support
    # stream readable by symmetry with the conditioned operator.
    support_kernel_draws = value_kernel_draws * mask_draws
    # Empirical exposure is not used for coverage (coverage reads the
    # conditioned operator only). Reuse this third empirical stream for
    # the adjusted numerator: observed adjacent increments only, with no
    # latest-at-or-before forward-fill across absent ages. Strict
    # evidence reads value; adjusted reads this stream and applies IPW
    # at the row reducer.
    exposure_kernel_draws = adjusted_kernel_draws

    return EmpiricalEvidencePrimitive(
        transition=transition,
        primitive_scope=primitive_scope,
        draw_count=draw_count,
        horizon_len=horizon_len,
        value_kernel_draws=value_kernel_draws,
        support_kernel_draws=support_kernel_draws,
        exposure_kernel_draws=exposure_kernel_draws,
        observation_mask_draws=mask_draws,
        saturation_per_draw=saturation_per_draw,
        value_kernel_draws_by_source_day=empirical_kernels.value_by_source_day,
        support_kernel_draws_by_source_day={
            day: value * empirical_kernels.mask_by_source_day[day]
            for day, value in empirical_kernels.value_by_source_day.items()
        },
        exposure_kernel_draws_by_source_day=(
            empirical_kernels.adjusted_by_source_day
        ),
        observation_mask_draws_by_source_day=empirical_kernels.mask_by_source_day,
        saturation_per_draw_by_source_day=(
            empirical_kernels.saturation_by_source_day
        ),
        resolution=resolution,
    )


@dataclass(frozen=True)
class _EmpiricalKernelBuild:
    value_kernel_draws: np.ndarray
    adjusted_kernel_draws: np.ndarray
    mask_draws: np.ndarray
    saturation_per_draw: np.ndarray
    value_by_source_day: Mapping[str, np.ndarray]
    adjusted_by_source_day: Mapping[str, np.ndarray]
    mask_by_source_day: Mapping[str, np.ndarray]
    saturation_by_source_day: Mapping[str, np.ndarray]


def _build_empirical_delta_kernel_draws(
    weighted_view: WeightedPrimitiveEvidenceView,
    horizon_len: int,
    draw_count: int,
) -> _EmpiricalKernelBuild:
    """Build strict and adjusted empirical kernels + mask + saturation.

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
    6. Adjusted increment uses only adjacent observed rows: a row at
       age τ contributes ``k(τ) - k(τ-1)`` only when τ-1 is also
       observed (τ=0 uses ``k(0)``). Missing cells are not forward-
       filled into adjusted; IPW handles observation sparsity later.

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
        list[Tuple[int, np.ndarray, np.ndarray]],
    ] = {}
    for row in weighted_view.rows:
        rows_by_source_day.setdefault(row.observed_date, []).append((
            int(_row_age_days(row)),
            np.asarray(row.k_weighted_draws, dtype=np.float64),
            np.asarray(row.n_weighted_draws, dtype=np.float64),
        ))

    total_k_draws = np.zeros((S, T), dtype=np.float64)
    adjusted_k_draws = np.zeros((S, T), dtype=np.float64)
    total_n_pool_draws = np.zeros(S, dtype=np.float64)
    mask_1d = np.zeros(T, dtype=np.float64)
    tau_grid = np.arange(T)
    value_by_source_day: Dict[str, np.ndarray] = {}
    adjusted_by_source_day: Dict[str, np.ndarray] = {}
    mask_by_source_day: Dict[str, np.ndarray] = {}
    saturation_by_source_day: Dict[str, np.ndarray] = {}

    for source_day, entries in rows_by_source_day.items():
        sorted_entries = sorted(entries, key=lambda e: e[0])
        ages = np.array([e[0] for e in sorted_entries], dtype=int)
        # k_draws_per_retrieval: (n_rows, S) — one row per retrieval.
        ks_per_draw = np.stack([e[1] for e in sorted_entries], axis=0)
        ns_per_draw = np.stack([e[2] for e in sorted_entries], axis=0)
        # Per-draw n is the max across retrievals for THIS source day.
        # The per-source-day denominator is the load-bearing quantity
        # for Phase 6 §4.3's m_U(s) × Δk(s)/n(s) term.
        source_n_pool_draws = np.max(ns_per_draw, axis=0)
        total_n_pool_draws += source_n_pool_draws

        # Row-presence mask on the τ-grid: any age this source day
        # contributes at. Mask is per-cell, not per-draw — row presence
        # is a property of the admission, not of the per-draw weight.
        mask_1d[ages[ages < T]] = 1.0
        source_mask_1d = np.zeros(T, dtype=np.float64)
        source_mask_1d[ages[ages < T]] = 1.0

        # Latest-at-or-before cumulative per draw: same sentinel-
        # prepended ``searchsorted`` as the scalar version, indexed
        # along the retrieval axis. ``ks_per_draw`` is (n_rows, S);
        # the gather produces (T, S) which we transpose to (S, T).
        ages_with_sentinel = np.concatenate(([-1], ages))
        ks_with_sentinel = np.concatenate(
            (np.zeros((1, S), dtype=np.float64), ks_per_draw), axis=0,
        )
        insertions = np.searchsorted(ages_with_sentinel, tau_grid, side='right')
        gathered = ks_with_sentinel[insertions - 1, :]  # (T, S)
        total_k_draws += gathered.T
        source_k_draws = gathered.T

        age_to_index = {int(age): idx for idx, age in enumerate(ages)}
        source_adjusted_k_draws = np.zeros((S, T), dtype=np.float64)
        for age, idx in age_to_index.items():
            if age >= T:
                continue
            if age == 0:
                adjusted_k_draws[:, age] += ks_per_draw[idx, :]
                source_adjusted_k_draws[:, age] += ks_per_draw[idx, :]
                continue
            previous_idx = age_to_index.get(age - 1)
            if previous_idx is None:
                continue
            source_increment = (
                ks_per_draw[idx, :] - ks_per_draw[previous_idx, :]
            )
            adjusted_k_draws[:, age] += source_increment
            source_adjusted_k_draws[:, age] += source_increment

        source_n = source_n_pool_draws[:, None]
        source_cumulative_rate = np.divide(
            source_k_draws, source_n,
            out=np.zeros_like(source_k_draws),
            where=source_n > 0.0,
        )
        value_by_source_day[source_day] = np.diff(
            source_cumulative_rate, prepend=0.0, axis=1,
        )
        adjusted_by_source_day[source_day] = np.divide(
            source_adjusted_k_draws, source_n,
            out=np.zeros_like(source_adjusted_k_draws),
            where=source_n > 0.0,
        )
        mask_by_source_day[source_day] = (
            np.broadcast_to(source_mask_1d, (S, T)).copy()
        )
        saturation_by_source_day[source_day] = (
            source_cumulative_rate[:, -1].copy()
        )

    # Broadcast the row-presence mask across the S axis — presence is
    # not per-draw; the per-draw axis carries weighting, not admission.
    mask_draws = np.broadcast_to(mask_1d, (S, T)).copy()

    # Per-draw 0/0 row-contract: a draw whose total_n_pool_draws[s] is
    # zero (no admitted rows contributed under that draw) emits a zero
    # rate-kernel row. Same algebraic degeneracy as the scalar path.
    safe_n = total_n_pool_draws[:, None]
    cumulative_rate_draws = np.divide(
        total_k_draws, safe_n,
        out=np.zeros_like(total_k_draws),
        where=safe_n > 0.0,
    )

    value_kernel_draws = np.diff(cumulative_rate_draws, prepend=0.0, axis=1)
    adjusted_kernel_draws = np.divide(
        adjusted_k_draws, safe_n,
        out=np.zeros_like(adjusted_k_draws),
        where=safe_n > 0.0,
    )
    saturation_per_draw = cumulative_rate_draws[:, -1].copy()
    return _EmpiricalKernelBuild(
        value_kernel_draws=value_kernel_draws,
        adjusted_kernel_draws=adjusted_kernel_draws,
        mask_draws=mask_draws,
        saturation_per_draw=saturation_per_draw,
        value_by_source_day=value_by_source_day,
        adjusted_by_source_day=adjusted_by_source_day,
        mask_by_source_day=mask_by_source_day,
        saturation_by_source_day=saturation_by_source_day,
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
) -> ComposedPrimitiveSpan:
    """Compose empirical per-edge kernels into a ``ComposedPrimitiveSpan``.

    Runs the same forward DAG DP (``_run_dp_density_trace``) that
    ``compose_primitive_span`` uses, with per-edge value / support /
    exposure kernels supplied by the empirical operator instead of the
    conditioned operator. Returns a ``ComposedPrimitiveSpan`` so the
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
    edge_primitives = _resolve_edge_primitives(topo, edge_to_empirical_primitive_lookup)

    node_density_draws: Dict[str, np.ndarray] = {
        node: np.zeros((S, T), dtype=np.float64) for node in topo.on_path
    }
    node_support_draws: Dict[str, np.ndarray] = {
        node: np.zeros((S, T), dtype=np.float64) for node in topo.on_path
    }
    node_exposure_draws: Dict[str, np.ndarray] = {
        node: np.zeros((S, T), dtype=np.float64) for node in topo.on_path
    }
    edge_contribution_draws: Dict[str, np.ndarray] = {
        ce.edge_key: np.zeros((S, T), dtype=np.float64)
        for ce in topo.concrete_edges
    }
    edge_support_contribution_draws: Dict[str, np.ndarray] = {
        ce.edge_key: np.zeros((S, T), dtype=np.float64)
        for ce in topo.concrete_edges
    }
    edge_exposure_contribution_draws: Dict[str, np.ndarray] = {
        ce.edge_key: np.zeros((S, T), dtype=np.float64)
        for ce in topo.concrete_edges
    }

    span_p_draws = np.zeros(S, dtype=np.float64)
    cdf_arr = np.zeros((S, T), dtype=np.float64)
    origin_day = _infer_empirical_origin_day(edge_primitives)

    for s in range(S):
        trace_value = _run_empirical_source_day_dp_trace(
            topo=topo,
            edge_primitives=edge_primitives,
            stream_name="value",
            draw_index=s,
            T=T,
            origin_day=origin_day,
        )
        trace_support = _run_empirical_source_day_dp_trace(
            topo=topo,
            edge_primitives=edge_primitives,
            stream_name="support",
            draw_index=s,
            T=T,
            origin_day=origin_day,
        )
        trace_exposure = _run_empirical_source_day_dp_trace(
            topo=topo,
            edge_primitives=edge_primitives,
            stream_name="exposure",
            draw_index=s,
            T=T,
            origin_day=origin_day,
        )

        for node_id, density in trace_value.node_density_by_node.items():
            node_density_draws[node_id][s, :] = density
        for ek, contribution in trace_value.edge_contribution_by_edge.items():
            edge_contribution_draws[ek][s, :] = contribution
        for node_id, density in trace_support.node_density_by_node.items():
            node_support_draws[node_id][s, :] = density
        for ek, contribution in trace_support.edge_contribution_by_edge.items():
            edge_support_contribution_draws[ek][s, :] = contribution
        for node_id, density in trace_exposure.node_density_by_node.items():
            node_exposure_draws[node_id][s, :] = density
        for ek, contribution in trace_exposure.edge_contribution_by_edge.items():
            edge_exposure_contribution_draws[ek][s, :] = contribution

        terminal_density = trace_value.node_density_by_node[topo.y_node_id]
        density_cdf = np.cumsum(terminal_density)
        expected_reach_s = float(density_cdf[-1]) if T > 0 else 0.0
        # 0/0 at expected_reach_s == 0 is genuine algebraic degeneracy
        # (no empirical mass propagates); emit 0 to match the spine's
        # documented convention.
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
        node_density_draws=node_density_draws,
        edge_contribution_draws=edge_contribution_draws,
        node_support_draws=node_support_draws,
        edge_support_contribution_draws=edge_support_contribution_draws,
        node_exposure_draws=node_exposure_draws,
        edge_exposure_contribution_draws=edge_exposure_contribution_draws,
        concrete_edges=tuple(topo.concrete_edges),
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
    stream_name: str,
    draw_index: int,
    source_day: str,
) -> np.ndarray:
    if stream_name == "value":
        by_day = primitive.value_kernel_draws_by_source_day
        aggregate = primitive.value_kernel_draws
    elif stream_name == "support":
        by_day = primitive.support_kernel_draws_by_source_day
        aggregate = primitive.support_kernel_draws
    elif stream_name == "exposure":
        by_day = primitive.exposure_kernel_draws_by_source_day
        aggregate = primitive.exposure_kernel_draws
    else:
        raise ValueError(f"unknown empirical stream {stream_name!r}")
    kernel = by_day.get(source_day)
    if kernel is None:
        kernel = aggregate
    return kernel[draw_index, :]


def _run_empirical_source_day_dp_trace(
    *,
    topo,
    edge_primitives: Sequence[Tuple[ConcreteEdge, EmpiricalEvidencePrimitive]],
    stream_name: str,
    draw_index: int,
    T: int,
    origin_day: date,
) -> SpanDPTrace:
    node_density: Dict[str, np.ndarray] = {
        node: np.zeros(T, dtype=np.float64) for node in topo.on_path
    }
    node_density[topo.x_node_id][0] = 1.0
    edge_contribution: Dict[str, np.ndarray] = {}
    primitive_by_edge = {ce.edge_key: prim for ce, prim in edge_primitives}

    for node in topo.topo_order:
        for ce in topo.incoming_concrete_edges.get(node, ()):
            primitive = primitive_by_edge[ce.edge_key]
            source_density = node_density[ce.from_id]
            contribution = np.zeros(T, dtype=np.float64)
            for source_index in np.flatnonzero(source_density):
                source_mass = float(source_density[int(source_index)])
                source_day = _source_day_for_index(origin_day, int(source_index))
                kernel = _kernel_for_source_day(
                    primitive,
                    stream_name=stream_name,
                    draw_index=draw_index,
                    source_day=source_day,
                )
                remaining = T - int(source_index)
                contribution[int(source_index):] += (
                    source_mass * kernel[:remaining]
                )
            edge_contribution[ce.edge_key] = contribution
            node_density[node] += contribution

    return SpanDPTrace(
        node_density_by_node=node_density,
        edge_contribution_by_edge=edge_contribution,
    )
