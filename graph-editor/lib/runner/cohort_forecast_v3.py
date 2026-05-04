"""
cohort_forecast_v3 — request-scoped primitive runtime row builder.

The v3 row path builds one ``ResolvedCFRuntime`` per request and reads
every public field — per-tau rate draws, fan bands, ``p_infinity_*``,
``completeness_*`` — from that runtime's composed primitive objects.
There is no aggregate carrier timing path, no ``XProvider`` carrier
solve, no ``cdf_mean`` execution surface, no tiled timing fallback, and
no projection-time semantic decision.

``window()`` and ``cohort(A = X)`` are data cases of the same runtime
object: their carrier composition is identity. Active cohort
(A != X) carries a real composed carrier built from the same primitive
registry the subject span consumes. Conditioning is owned by
``primitive_conditioning.condition_primitive`` — never by row builders,
projection helpers, or trajectory engines (single-locus invariant).
"""

import math
import numpy as np
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date as _date, timedelta as _timedelta
from typing import Any, Dict, List, Mapping, Optional, Sequence

from .model_resolver import resolve_model_params
from .prefix_arrival import PrefixArrivalMap
from .primitive_evidence import RequestPrimitiveRegistry
from .primitives import ConditionedTransitionPrimitive
from .subject_span_composer import ComposedPrimitiveSpan
from .primitive_readout import ComposedUnconditionedOverlay


# ═══════════════════════════════════════════════════════════════════════
# Class B — non-latency edge (Beta-Binomial closed form)
# ═══════════════════════════════════════════════════════════════════════


@dataclass
class NonLatencyResult:
    """Return carrier for `_non_latency_rows` with doc 52 provenance.

    `rows` has the same shape as before. The blend fields carry
    engine-level subset-conditioning provenance (doc 52 §14.6) — a
    parallel to `ForecastTrajectory`'s fields. `conditioned` reports
    whether observed evidence was actually applied to the prior (True)
    or the result is just the prior unchanged because no evidence was
    present in scope (False).
    """
    rows: List[Dict[str, Any]] = field(default_factory=list)
    r: Optional[float] = None
    m_S: Optional[float] = None
    m_G: Optional[float] = None
    blend_applied: bool = False
    blend_skip_reason: Optional[str] = None
    conditioned: bool = False


def _beta_sd(alpha: float, beta: float) -> float:
    s = alpha + beta
    return math.sqrt(alpha * beta / (s * s * (s + 1.0)))


def _synthesise_evidence_set_from_frames(
    *,
    frames: List[Dict[str, Any]],
    edge_id: str,
    subject_from: str,
    subject_to: str,
    anchor_from: str,
    sweep_to: str,
    as_at: Optional[str],
    scenario_id: str,
) -> Optional[Any]:
    """Build a multi-row ``EvidenceSet`` from per-edge frames.

    Each `data_point` from the latest frame becomes one ``EvidencePoint``
    carrying ``(observed_date, retrieved_at, n=x, k=y)``. The canonical
    primitive binder/conditioner owns all later clock weighting and
    conditioning; this helper only turns an already-retrieved per-edge
    frame into candidate evidence.

    Returns None when the frames carry no usable rows.
    """
    if not frames:
        return None
    from evidence_merge import (
        PROVENANCE_SCHEMA_VERSION,
        EvidenceCandidate,
        EvidenceIdentity,
        EvidencePoint,
        EvidenceProvenance,
        EvidenceRole,
        EvidenceScope,
        EvidenceSet,
        EvidenceTotals,
        ObservationCoordinate,
        SliceFamily,
        SourceKind,
    )
    import hashlib as _hashlib

    # Use the latest frame; data_points carry "latest-wins" totals per
    # anchor_day at that snapshot date.
    latest = frames[-1]
    raw_data_points = latest.get('data_points') or []
    if not raw_data_points:
        return None

    identity = EvidenceIdentity(
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        subject_from=subject_from,
        subject_to=subject_to,
        anchor=None,
        slice_family=SliceFamily.WINDOW,
        context_key=None,
        regime_key=None,
        population_identity=None,
    )
    points: List[EvidencePoint] = []
    n_total = 0
    k_total = 0
    for dp in raw_data_points:
        n_i = int(dp.get('x') or 0)
        k_i = int(dp.get('y') or 0)
        if n_i <= 0:
            continue
        observed_date = str(dp.get('anchor_day') or '')
        retrieved_at = (
            dp.get('data_retrieved_at')
            or latest.get('snapshot_date')
            or as_at
        )
        candidate = EvidenceCandidate(
            source=SourceKind.SNAPSHOT,
            identity=identity,
            coordinate=ObservationCoordinate(
                observed_date=observed_date,
                retrieved_at=str(retrieved_at) if retrieved_at else None,
            ),
            n=n_i,
            k=k_i,
        )
        points.append(EvidencePoint(candidate=candidate))
        n_total += n_i
        k_total += k_i

    if not points:
        return None

    scope_key = _hashlib.sha256(
        '|'.join((
            'primitive_span.edge_evidence_from_frames.v1',
            scenario_id,
            edge_id,
            subject_from,
            subject_to,
            anchor_from,
            sweep_to,
            as_at or '',
            str(len(points)),
            str(n_total),
            str(k_total),
        )).encode('utf-8')
    ).hexdigest()[:24]
    prov = EvidenceProvenance(
        schema_version=PROVENANCE_SCHEMA_VERSION,
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        scope_key=scope_key,
        scenario_id=scenario_id,
        as_at=as_at,
        selected_slice_families=(SliceFamily.WINDOW,),
        selected_snapshot_families=(SliceFamily.WINDOW,),
        skipped_counts_by_reason={},
        included_counts_by_source={SourceKind.SNAPSHOT: len(points)},
        asat_materialised_present=False,
    )
    return EvidenceSet(
        scope=EvidenceScope(
            role=EvidenceRole.WINDOW_SUBJECT_HELPER,
            subject_from=subject_from,
            subject_to=subject_to,
            date_from=anchor_from,
            date_to=sweep_to,
            as_at=as_at,
            scenario_id=scenario_id,
        ),
        points=tuple(points),
        skipped=(),
        totals=EvidenceTotals(n=n_total, k=k_total),
        totals_by_source={
            SourceKind.SNAPSHOT: EvidenceTotals(n=n_total, k=k_total),
        },
        provenance=prov,
    )


def build_per_edge_upstream_evidence(
    *,
    graph: Dict[str, Any],
    anchor_node_id: Optional[str],
    query_from_node: Optional[str],
    per_edge_results_by_uuid: Dict[str, Dict[str, Any]],
    anchor_from: str,
    sweep_to: str,
    as_at: Optional[str],
    scenario_id: str,
) -> Dict[str, Any]:
    """Per-upstream-edge ``EvidenceSet`` map for active carrier primitives.

    Thin wrapper around ``build_per_edge_evidence`` for the carrier topology
    (anchor → X). See that helper for the full contract.
    """
    return build_per_edge_evidence(
        graph=graph,
        from_node=anchor_node_id,
        to_node=query_from_node,
        per_edge_results_by_uuid=per_edge_results_by_uuid,
        anchor_from=anchor_from,
        sweep_to=sweep_to,
        as_at=as_at,
        scenario_id=scenario_id,
    )


def build_per_edge_evidence(
    *,
    graph: Dict[str, Any],
    from_node: Optional[str],
    to_node: Optional[str],
    per_edge_results_by_uuid: Dict[str, Dict[str, Any]],
    anchor_from: str,
    sweep_to: str,
    as_at: Optional[str],
    scenario_id: str,
) -> Dict[str, Any]:
    """Build a per-edge ``EvidenceSet`` map across an arbitrary span.

    Walks the topology between ``from_node`` and ``to_node`` and for every
    edge whose derivation result is available in ``per_edge_results_by_uuid``
    synthesises an ``EvidenceSet`` from the edge's frames. Used to populate
    evidence on:

      - carrier edges (anchor → X),
      - subject edges (X → end),
      - multi-hop window edges (X → end in window mode).

    The returned map is keyed by both ``edge_id`` and ``uuid`` so
    readout call sites resolve the entry under either identifier.

    Edges whose frames are missing or empty are absent from the map; the
    primitive preparation path then binds empty candidates and naturally
    degenerates to PRIOR_ONLY.

    Caller responsibility: ``per_edge_results_by_uuid`` must contain the
    per-edge derivation_result dict (with `frames` list) for every edge
    in the span. In whole-graph mode the topological iteration in
    ``handle_conditioned_forecast`` populates it; in single-subject
    mode the caller drives an explicit fetch via
    ``prepare_forecast_subject_entry`` per edge.
    """
    if not from_node or not to_node:
        return {}
    if from_node == to_node:
        return {}
    from .span_kernel import _build_span_topology
    topo = _build_span_topology(
        graph,
        x_node_id=str(from_node),
        y_node_id=str(to_node),
    )
    if topo is None or not topo.edge_list:
        return {}

    evidence_by_edge: Dict[str, Any] = {}
    for from_id, to_id, edge_dict in topo.edge_list:
        edge_id = (
            edge_dict.get('edge_id')
            or edge_dict.get('id')
            or f"{from_id}->{to_id}"
        )
        edge_uuid = str(edge_dict.get('uuid') or edge_id)
        entry = (
            per_edge_results_by_uuid.get(edge_uuid)
            or per_edge_results_by_uuid.get(str(edge_id))
        )
        if not entry:
            continue
        frames = (entry.get('derivation_result') or {}).get('frames') or []
        if not frames:
            continue
        evidence_set = _synthesise_evidence_set_from_frames(
            frames=frames,
            edge_id=str(edge_id),
            subject_from=str(from_id),
            subject_to=str(to_id),
            anchor_from=anchor_from,
            sweep_to=sweep_to,
            as_at=as_at,
            scenario_id=scenario_id,
        )
        if evidence_set is None:
            continue
        evidence_by_edge[str(edge_id)] = evidence_set
        evidence_by_edge[edge_uuid] = evidence_set
    return evidence_by_edge


def _aggregate_request_candidates(
    *,
    target_candidates: Optional[Sequence[Any]],
    per_edge_subject_evidence: Optional[Dict[str, Any]],
    per_edge_upstream_evidence: Optional[Dict[str, Any]],
    target_evidence_set: Optional[Any],
) -> List[Any]:
    """Union of every parameterised primitive's candidate material.

    Returns a flat list of ``EvidenceCandidate`` objects spanning the
    target subject, every non-target subject edge, and every carrier
    edge in the request topology. Per-primitive merge in the readout
    filters by ``(subject_from, subject_to)`` so each primitive only
    sees the rows that belong to its own edge.

    The per-edge ``EvidenceSet`` dicts arrive keyed by both ``edge_id``
    and ``uuid`` (see ``build_per_edge_evidence``); deduplication by
    object identity prevents the same set's points from contributing
    twice to the pool.

    The target subject's pre-merged ``EvidenceSet`` is included as a
    fallback when ``target_candidates`` is None, so callers that have
    not yet been migrated to threading raw candidates still produce a
    non-empty pool.
    """
    pool: List[Any] = []
    if target_candidates:
        pool.extend(target_candidates)
    elif target_evidence_set is not None:
        pool.extend(point.candidate for point in target_evidence_set.points)

    seen_sets: set = set()
    for per_edge in (per_edge_subject_evidence, per_edge_upstream_evidence):
        if not per_edge:
            continue
        for ev_set in per_edge.values():
            if ev_set is None or id(ev_set) in seen_sets:
                continue
            seen_sets.add(id(ev_set))
            pool.extend(point.candidate for point in ev_set.points)
    return pool


def _attach_cf_row_metadata(
    rows: List[Dict[str, Any]],
    *,
    conditioning: Dict[str, Any],
    conditioned: bool,
    cf_mode: str,
    cf_reason: Optional[str],
    runtime_provenance: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """Stash per-call CF metadata on the first row sentinel.

    The runtime provenance block is role-labelled (`carrier_span`,
    `subject_span`, `primitives`, `projection`) so API projection does
    not preserve staged readout labels as public runtime semantics.
    """
    if rows:
        rows[0]['_conditioning'] = conditioning
        rows[0]['_conditioned'] = conditioned
        rows[0]['_cf_mode'] = cf_mode
        rows[0]['_cf_reason'] = cf_reason
        if runtime_provenance is not None:
            rows[0]['_runtime_provenance'] = runtime_provenance
    return rows


@dataclass
class _PrimitiveRuntimeResult:
    p_mean: Optional[float]
    p_sd: Optional[float]
    p_sd_epistemic: Optional[float]
    runtime_provenance: Optional[Dict[str, Any]]


@dataclass
class ResolvedCFRuntime:
    population_root: Optional[str]
    denominator_node: Optional[str]
    subject_end: Optional[str]
    public_moments: _PrimitiveRuntimeResult
    runtime_provenance: Optional[Mapping[str, Any]]
    numerator_representation: str = 'factorised'
    admission_policy: Optional[Mapping[str, Any]] = None
    arrival_map: Optional[PrefixArrivalMap] = None
    evidence_resolution_registry: Optional[RequestPrimitiveRegistry] = None
    conditioned_primitive_map: Optional[Mapping[str, ConditionedTransitionPrimitive]] = None
    carrier_span: Optional[Mapping[str, Any]] = None
    subject_span: Optional[Mapping[str, Any]] = None
    projection_provenance: Optional[Mapping[str, Any]] = None
    composed_subject: Optional[ComposedPrimitiveSpan] = None
    composed_carrier: Optional[ComposedPrimitiveSpan] = None
    eligible: bool = True
    skip_reason: Optional[str] = None
    # Unconditioned overlays keyed by dispersion basis (e.g.
    # 'predictive' for F-mode bands, 'epistemic' for the optional
    # model_curve_* bands). Bases not requested by the caller are absent.
    unconditioned_overlays: Mapping[
        str, ComposedUnconditionedOverlay
    ] = field(default_factory=dict)

    def project_public_moments(
        self,
        *,
        p_mean: Optional[float],
        p_sd: Optional[float],
        p_sd_epistemic: Optional[float],
    ) -> tuple[Optional[float], Optional[float], Optional[float]]:
        """Project public scalar moments from the resolved runtime object.

        Projection may use the trajectory values only when the runtime has
        no primitive-backed value for that moment. It must not inspect
        lower-level primitive helper internals.
        """
        return (
            self.public_moments.p_mean
            if self.public_moments.p_mean is not None else p_mean,
            self.public_moments.p_sd
            if self.public_moments.p_sd is not None else p_sd,
            self.public_moments.p_sd_epistemic
            if self.public_moments.p_sd_epistemic is not None
            else p_sd_epistemic,
        )

    def project_runtime_provenance(self) -> Optional[Dict[str, Any]]:
        """Projection-facing provenance for row/scalar consumers.

        Build the public block from the resolved runtime fields. The
        lower-level diagnostic blob remains available under
        ``diagnostics`` for forensics, but projection does not derive
        carrier/subject/projection roles by scraping it.
        """
        registry_provenance = None
        if self.evidence_resolution_registry is not None:
            to_prov = getattr(
                self.evidence_resolution_registry,
                'to_provenance_dict',
                None,
            )
            if callable(to_prov):
                registry_provenance = to_prov()
        projection = dict(self.projection_provenance or {})
        if 'substituted' not in projection:
            projection['substituted'] = self.public_moments.p_mean is not None
        return {
            'carrier_span': self.carrier_span,
            'subject_span': self.subject_span,
            'numerator_representation': self.numerator_representation,
            'admission_policy': self.admission_policy,
            'primitives': {
                'registry': registry_provenance,
                'conditioned_primitive_count': len(
                    self.conditioned_primitive_map or {}
                ),
            },
            'projection': projection,
            'diagnostics': (
                self.runtime_provenance.get('diagnostics')
                if isinstance(self.runtime_provenance, dict)
                else None
            ),
        }


def _runtime_seed(scenario_id: Optional[str], role: str) -> int:
    import hashlib as _hashlib
    return (
        int(_hashlib.sha256(
            (str(scenario_id) + f'|{role}').encode('utf-8')
        ).hexdigest()[:16], 16)
        if scenario_id else 0
    )


def _runtime_scope(
    *,
    scenario_id: str,
    from_node: str,
    to_node: str,
    edge_id: str,
    date_from: str,
    date_to: str,
    as_at: Optional[str],
    resolved_source: Optional[str],
):
    from .primitives import (
        PrimitiveScope as _PrimitiveScope,
        TransitionIdentity as _TransitionIdentity,
    )
    return (
        _TransitionIdentity(
            source_node=str(from_node),
            destination_node=str(to_node),
            edge_id=str(edge_id),
        ),
        _PrimitiveScope(
            scenario_id=str(scenario_id),
            evidence_role='window_subject_helper',
            date_from=str(date_from or ''),
            date_to=str(date_to or date_from or ''),
            as_at=as_at,
            context_key=None,
            regime_key=None,
            model_source_preference='best_available',
            resolved_source_identity=resolved_source,
        ),
    )


def _build_span_resolutions(
    *,
    graph: Dict[str, Any],
    from_node: str,
    to_node: str,
    target_edge_id: str,
    target_resolved: Any,
    target_evidence_set: Optional[Any],
    temporal_mode: str,
    scenario_id: str,
    anchor_from: str,
    anchor_to: str,
    as_at: Optional[str],
    per_edge_evidence: Optional[Dict[str, Any]],
    resolution_class: Any,
    mark_target: bool,
) -> tuple[Optional[list], Optional[str]]:
    from .span_kernel import _build_span_topology

    topo = _build_span_topology(
        graph,
        x_node_id=str(from_node),
        y_node_id=str(to_node),
    )
    if topo is None or not topo.edge_list:
        return None, 'no_span_topology'

    resolutions = []
    for edge_from, edge_to, edge_dict in topo.edge_list:
        edge_id = (
            edge_dict.get('edge_id')
            or edge_dict.get('id')
            or f"{edge_from}->{edge_to}"
        )
        edge_uuid = edge_dict.get('uuid')
        is_target = bool(
            mark_target and (
                str(edge_id) == str(target_edge_id)
                or str(edge_uuid or '') == str(target_edge_id)
            )
        )
        edge_resolved = (
            target_resolved
            if is_target else
            resolve_model_params(
                edge_dict,
                scope='edge',
                temporal_mode=temporal_mode,
            )
        )
        if not edge_resolved:
            return None, f'edge_resolve_failed:{edge_id}'
        emit_edge_id = str(target_edge_id) if is_target else str(edge_id)
        transition, primitive_scope = _runtime_scope(
            scenario_id=scenario_id,
            from_node=str(edge_from),
            to_node=str(edge_to),
            edge_id=emit_edge_id,
            date_from=str(anchor_from or ''),
            date_to=str(anchor_to or anchor_from or ''),
            as_at=as_at,
            resolved_source=getattr(edge_resolved, 'source', None),
        )
        evidence_set = (
            target_evidence_set
            if is_target else (
                (per_edge_evidence or {}).get(str(edge_id))
                or (per_edge_evidence or {}).get(str(edge_uuid or ''))
            )
        )
        kwargs = dict(
            transition=transition,
            primitive_scope=primitive_scope,
            resolved_model=edge_resolved,
            evidence_set=evidence_set,
        )
        if mark_target:
            kwargs['is_target'] = is_target
        resolutions.append(resolution_class(**kwargs))
    return resolutions, None


def build_resolved_cf_runtime(
    *,
    graph: Dict[str, Any],
    target_edge_id: str,
    query_from_node: str,
    query_to_node: str,
    anchor_from: str,
    anchor_to: str,
    sweep_to: str,
    as_at: Optional[str],
    scenario_id: Optional[str],
    is_window: bool,
    is_multi_hop: bool,
    anchor_node_id: Optional[str],
    resolved: Any,
    evidence_set: Optional[Any],
    per_edge_subject_evidence: Optional[Dict[str, Any]],
    per_edge_upstream_evidence: Optional[Dict[str, Any]],
    legacy_p_mean: Optional[float],
    legacy_p_sd: Optional[float],
    legacy_p_sd_epistemic: Optional[float],
    unconditioned_overlay_bases: Sequence[str] = ('predictive',),
    evidence_candidates: Optional[List[Any]] = None,
) -> Optional[ResolvedCFRuntime]:
    """Build the primitive-backed runtime object for row/scalar projection.

    Note: the `target_subject_metadata` parameter that previously gated
    in-runtime widening was removed when fetch-envelope construction
    moved to the preparation layer. See
    docs/current/snapshot-fetch-envelope-design.md.
    """
    if not scenario_id:
        return None

    from .primitive_readout import (
        CarrierEdgeResolution,
        SpanEdgeResolution,
        _build_request_arrival_map,
        _build_resolved_runtime_prefix_arrival_identity,
        compute_resolved_runtime_readout,
    )

    population_root = (
        str(anchor_node_id)
        if (anchor_node_id and not is_window)
        else str(query_from_node)
    )

    subject_resolutions, subject_skip = _build_span_resolutions(
        graph=graph,
        from_node=str(query_from_node),
        to_node=str(query_to_node),
        target_edge_id=str(target_edge_id),
        target_resolved=resolved,
        target_evidence_set=evidence_set,
        temporal_mode='window' if is_window else 'cohort',
        scenario_id=str(scenario_id),
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        as_at=as_at,
        per_edge_evidence=per_edge_subject_evidence,
        resolution_class=SpanEdgeResolution,
        mark_target=True,
    )

    carrier_resolutions = None
    carrier_skip = None
    if (not is_window) and anchor_node_id and str(anchor_node_id) != str(query_from_node):
        carrier_resolutions, carrier_skip = _build_span_resolutions(
            graph=graph,
            from_node=str(anchor_node_id),
            to_node=str(query_from_node),
            target_edge_id=str(target_edge_id),
            target_resolved=resolved,
            target_evidence_set=None,
            temporal_mode='cohort',
            scenario_id=str(scenario_id),
            anchor_from=anchor_from,
            anchor_to=anchor_to,
            as_at=as_at,
            per_edge_evidence=per_edge_upstream_evidence,
            resolution_class=CarrierEdgeResolution,
            mark_target=False,
        )

    # 73n evidence-clock alignment: build the request-rooted prefix-
    # arrival map at this layer (one above ``compute_resolved_runtime_readout``)
    # so the per-primitive evidence-clock envelope is available before
    # any retrieval widening happens. The readout receives the pre-built
    # map(s) and skips its own internal construction.
    #
    # Two-clocks split (per `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`
    # lines 482-514): the denominator clock is the carrier `A → X` clock;
    # the numerator clock is the subject-span `X → end` clock. They answer
    # different questions ("who has reached X" vs "given mass at X, when
    # does it reach end"), so they require independent arrival maps. The
    # subject map is rooted at X (so subject-edge evidence at the X-rooted
    # source nodes is bound on identity weights, not downweighted by the
    # upstream carrier's arrival distribution); the carrier map is rooted
    # at A and only built when a non-identity carrier is in scope. For
    # `window()` and `cohort(A = X)`, population_root == query_from_node
    # and there are no carrier resolutions, so only the subject map is
    # built — behaviour is identical to the previous single-map shape.
    subject_arrival_map = None
    carrier_arrival_map = None
    target_resolution = None
    if subject_resolutions:
        target_resolution = next(
            (r for r in subject_resolutions if getattr(r, 'is_target', False)),
            subject_resolutions[0],
        )
        subject_arrival_identity = _build_resolved_runtime_prefix_arrival_identity(
            primitive_scope=target_resolution.primitive_scope,
            request_root=str(query_from_node),
        )
        subject_arrival_map = _build_request_arrival_map(
            graph=graph,
            root_node_id=str(query_from_node),
            primitive_scope_for_window=target_resolution.primitive_scope,
            edge_resolutions=[
                (r.transition, r.resolved_model) for r in subject_resolutions
            ],
            identity=subject_arrival_identity,
            max_tau=400,
        )
        if carrier_resolutions:
            carrier_arrival_identity = (
                _build_resolved_runtime_prefix_arrival_identity(
                    primitive_scope=target_resolution.primitive_scope,
                    request_root=str(population_root),
                )
            )
            carrier_arrival_map = _build_request_arrival_map(
                graph=graph,
                root_node_id=str(population_root),
                primitive_scope_for_window=target_resolution.primitive_scope,
                edge_resolutions=[
                    (r.transition, r.resolved_model) for r in carrier_resolutions
                ],
                identity=carrier_arrival_identity,
                max_tau=400,
            )

    # 73n in-runtime widening REMOVED. The fetch envelope is now derived
    # at the preparation layer by `runner.request_envelope.build_request_
    # envelope_plan` and applied to the original snapshot fetch in
    # `forecast_preparation.prepare_forecast_subject_entry` (subject
    # side) and `_fetch_upstream_observations` (carrier side). The
    # runtime no longer issues a second DB call and no longer needs
    # `target_subject_metadata`. See
    # docs/current/snapshot-fetch-envelope-design.md.

    result = compute_resolved_runtime_readout(
        graph=graph,
        population_root_node_id=population_root,
        x_node_id=str(query_from_node),
        end_node_id=str(query_to_node),
        subject_edge_resolutions=subject_resolutions,
        carrier_edge_resolutions=carrier_resolutions,
        scenario_seed=_runtime_seed(scenario_id, 'resolved_cf_runtime'),
        legacy_p_mean=legacy_p_mean,
        legacy_p_sd=legacy_p_sd,
        legacy_p_sd_epistemic=legacy_p_sd_epistemic,
        prior_source=getattr(resolved, 'source', None),
        unconditioned_overlay_bases=unconditioned_overlay_bases,
        request_evidence_candidates=evidence_candidates,
        prebuilt_subject_arrival_map=subject_arrival_map,
        prebuilt_carrier_arrival_map=carrier_arrival_map,
        is_window=is_window,
    )

    if subject_skip or carrier_skip:
        diagnostics = dict(result.diagnostics or {})
        inner = dict(diagnostics.get('diagnostics') or {})
        if subject_skip:
            inner['subject_resolution_skip'] = subject_skip
        if carrier_skip:
            inner['carrier_resolution_skip'] = carrier_skip
        diagnostics['diagnostics'] = inner
        runtime_provenance = diagnostics
    else:
        runtime_provenance = result.diagnostics

    if not result.should_substitute:
        moments = _PrimitiveRuntimeResult(
            p_mean=None,
            p_sd=None,
            p_sd_epistemic=None,
            runtime_provenance=runtime_provenance,
        )
    else:
        moments = _PrimitiveRuntimeResult(
            p_mean=result.p_mean_primitive,
            p_sd=result.p_sd_primitive,
            p_sd_epistemic=result.p_sd_epistemic_primitive,
            runtime_provenance=runtime_provenance,
        )
    projection_provenance = (
        runtime_provenance.get('projection')
        if isinstance(runtime_provenance, dict)
        else None
    )
    return ResolvedCFRuntime(
        population_root=population_root,
        denominator_node=query_from_node,
        subject_end=query_to_node,
        public_moments=moments,
        runtime_provenance=moments.runtime_provenance,
        numerator_representation='factorised',
        admission_policy={
            'whole_query_numerator': 'not_admitted',
            'subject_side_helper': 'primitive_edge_composition',
            'rate_evidence_owner': 'primitive_conditioning',
        },
        arrival_map=result.arrival_map,
        evidence_resolution_registry=result.primitive_registry,
        conditioned_primitive_map=dict(result.conditioned_primitive_map),
        carrier_span=result.carrier_span_role,
        subject_span=result.subject_span_role,
        projection_provenance=projection_provenance,
        composed_subject=result.composed_subject,
        composed_carrier=result.composed_carrier,
        eligible=bool(result.eligible and result.should_substitute),
        skip_reason=result.skip_reason,
        unconditioned_overlays=dict(result.unconditioned_overlays),
    )


def _evidence_display_at_tau(
    *,
    evidence_by_tau: Dict[int, Dict],
    tau: int,
    tau_future_max: int,
) -> Optional[Dict[str, Any]]:
    """Observed chart evidence at tau from prepared FrameEvidence."""
    if tau > tau_future_max:
        return None
    ev = evidence_by_tau.get(int(tau))
    if not ev:
        return None
    ev_x = float(ev.get('sum_x') or 0.0)
    if ev_x <= 0:
        return None
    ev_y = float(ev.get('sum_y') or 0.0)
    n_cohorts = int(ev.get('n_cohorts') or 0)
    return {
        'sum_y': ev_y,
        'sum_x': ev_x,
        'sum_y_pure': ev_y,
        'sum_x_pure': ev_x,
        'n_cohorts': n_cohorts,
        'n_mature': n_cohorts,
    }


def _composed_pair_request_cdf_draws(
    subject: Optional[ComposedPrimitiveSpan],
    carrier: Optional[ComposedPrimitiveSpan],
    *,
    horizon: int,
) -> Optional[np.ndarray]:
    """Composed request-rooted CDF draws on the (S, horizon+1) grid for a
    given (subject, carrier) composition pair.

    For carrier=identity (None) the result is the subject CDF directly;
    for active cohort the carrier and subject CDFs are convolved per
    draw. Returns ``None`` when either object is moments-only.
    """
    if subject is None or not subject.is_draw_coherent:
        return None
    subject_cdf = subject.cdf_draws
    if subject_cdf is None:
        return None

    T = int(horizon) + 1
    if subject_cdf.shape[1] >= T:
        subj = subject_cdf[:, :T]
    else:
        last = subject_cdf[:, -1:]
        subj = np.concatenate(
            [
                subject_cdf,
                np.broadcast_to(last, (subject_cdf.shape[0], T - subject_cdf.shape[1])),
            ],
            axis=1,
        )

    if carrier is None:
        return subj
    if not carrier.is_draw_coherent or carrier.cdf_draws is None:
        return None
    car = carrier.cdf_draws
    if car.shape[1] >= T:
        car = car[:, :T]
    else:
        last = car[:, -1:]
        car = np.concatenate(
            [
                car,
                np.broadcast_to(last, (car.shape[0], T - car.shape[1])),
            ],
            axis=1,
        )

    if car.shape[0] != subj.shape[0]:
        return None

    carrier_pdf = np.diff(car, axis=1, prepend=0.0)
    subject_pdf = np.diff(subj, axis=1, prepend=0.0)
    convolved = np.zeros_like(subj)
    for s in range(subj.shape[0]):
        full = np.convolve(carrier_pdf[s], subject_pdf[s])[:T]
        convolved[s, :] = np.cumsum(full)
    return np.clip(convolved, 0.0, 1.0)


def _composed_pair_per_tau_rate_draws(
    subject: Optional[ComposedPrimitiveSpan],
    carrier: Optional[ComposedPrimitiveSpan],
    *,
    horizon: int,
) -> Optional[np.ndarray]:
    """Per-(s, t) rate draws for a (subject, carrier) pair.

    Displayed rate is ``Y_Y(τ) / X_X(τ)`` per
    COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS §"Rate semantics":
    numerator is arrivals at the subject end, denominator is arrivals at X.

    Window mode (``carrier=None``): ``rate = subject_cdf · subject_p``;
    carrier_cdf ≡ 1 collapses out.
    Cohort mode: ``rate = (end_to_end_cdf · subject_p) / carrier_cdf``.
    Where carrier_cdf is ~0 the rate is undefined; emit 0 there.
    """
    if subject is None or subject.span_p_draws is None:
        return None
    cdf = _composed_pair_request_cdf_draws(subject, carrier, horizon=horizon)
    if cdf is None:
        return None
    numer = cdf * subject.span_p_draws[:, None]
    if carrier is None:
        return numer
    if not carrier.is_draw_coherent or carrier.cdf_draws is None:
        return None
    T = int(horizon) + 1
    car = carrier.cdf_draws
    if car.shape[1] >= T:
        car = car[:, :T]
    else:
        last = car[:, -1:]
        car = np.concatenate(
            [
                car,
                np.broadcast_to(last, (car.shape[0], T - car.shape[1])),
            ],
            axis=1,
        )
    if car.shape[0] != numer.shape[0]:
        return None
    return np.where(car > 1e-9, numer / np.maximum(car, 1e-9), 0.0)


def _runtime_request_cdf_draws(
    runtime: ResolvedCFRuntime,
    *,
    horizon: int,
) -> Optional[np.ndarray]:
    """Convenience: request-rooted CDF for the conditioned posterior."""
    return _composed_pair_request_cdf_draws(
        runtime.composed_subject,
        runtime.composed_carrier,
        horizon=horizon,
    )


def _runtime_per_tau_rate_draws(
    runtime: ResolvedCFRuntime,
    *,
    horizon: int,
) -> Optional[np.ndarray]:
    """Convenience: per-tau rate draws for the conditioned posterior."""
    return _composed_pair_per_tau_rate_draws(
        runtime.composed_subject,
        runtime.composed_carrier,
        horizon=horizon,
    )


def _runtime_completeness(
    runtime: ResolvedCFRuntime,
    *,
    cohort_eval_ages: Sequence[int],
    cohort_weights: Sequence[float],
    horizon: int,
) -> tuple[Optional[float], Optional[float]]:
    """N-weighted mean and SD of the request-rooted CDF at each cohort's
    observed frontier.

    Pulls completeness from the same composed CDF the row builder uses
    so the public scalar and the rendered curves stay coherent. Returns
    ``(None, None)`` if the runtime has no draw-coherent CDF or every
    cohort has zero weight.
    """
    if not cohort_eval_ages or not cohort_weights:
        return None, None
    cdf = _runtime_request_cdf_draws(runtime, horizon=horizon)
    if cdf is None:
        cdf_mean = (
            runtime.composed_subject.cdf_mean
            if runtime.composed_subject is not None else None
        )
        if cdf_mean is None:
            return None, None
        weights = np.asarray(cohort_weights, dtype=np.float64)
        wsum = float(weights.sum())
        if wsum <= 0:
            return None, None
        ages = np.asarray(cohort_eval_ages, dtype=np.int64)
        ages = np.clip(ages, 0, len(cdf_mean) - 1)
        per_cohort = cdf_mean[ages]
        return float((weights * per_cohort).sum() / wsum), 0.0

    weights = np.asarray(cohort_weights, dtype=np.float64)
    wsum = float(weights.sum())
    if wsum <= 0:
        return None, None
    ages = np.asarray(cohort_eval_ages, dtype=np.int64)
    ages = np.clip(ages, 0, cdf.shape[1] - 1)
    per_cohort_per_draw = cdf[:, ages]
    weighted_per_draw = (weights * per_cohort_per_draw).sum(axis=1) / wsum
    return float(weighted_per_draw.mean()), float(weighted_per_draw.std())


def _project_runtime_rows(
    *,
    runtime: ResolvedCFRuntime,
    evidence_by_tau: Dict[int, Dict],
    cohort_eval_ages: Sequence[int],
    cohort_weights: Sequence[float],
    max_tau: int,
    tau_solid_max: int,
    tau_future_max: int,
    sweep_to: str,
    band_level: float,
) -> List[Dict[str, Any]]:
    """Build chart rows from the runtime's composed objects + observed
    evidence.

    Three composed surfaces feed the row schema:

      - ``midpoint`` / ``fan_*`` / ``fan_bands``: E+F mode — the
        joint-conditioned posterior. ``runtime.composed_subject`` and
        ``runtime.composed_carrier``.
      - ``model_midpoint`` / ``model_fan_*`` / ``model_bands``: F mode —
        the unconditioned ``predictive`` overlay (κ-inflated bands).
        ``runtime.unconditioned_overlays['predictive']``.
      - ``model_curve_midpoint`` / ``model_curve_*`` / ``model_curve_bands``:
        opt-in ``epistemic`` overlay (tight bands).
        ``runtime.unconditioned_overlays.get('epistemic')``. Absent when
        the caller did not request the model curve.

    No trajectory engine, no per-cohort IS splice — the request-scoped
    primitive registry has already conditioned everything that should
    move the rate."""
    band_levels = [0.80, 0.90, 0.95, 0.99]

    def _overlay_rate_draws(basis: str) -> Optional[np.ndarray]:
        overlay = runtime.unconditioned_overlays.get(basis)
        if overlay is None:
            return None
        return _composed_pair_per_tau_rate_draws(
            overlay.subject, overlay.carrier, horizon=max_tau,
        )

    rate_draws = _runtime_per_tau_rate_draws(runtime, horizon=max_tau)
    pred_rate_draws = _overlay_rate_draws('predictive')
    epi_rate_draws = _overlay_rate_draws('epistemic')

    # Request-clock arrival CDFs for the displayed evidence_x / evidence_y.
    # Identity carrier (window or cohort A=X) is data: composed_carrier is
    # None → F_X = 1 everywhere → evidence_x reduces to the raw frame sum.
    # Active cohort (A != X) → F_X = composed_carrier.cdf_mean (rises 0→1
    # as the A-cohort flows into X). The end-to-end (carrier ⊗ subject)
    # CDF gives the request-clock arrival at the subject end; subject_reach
    # converts the conditional CDF to the unconditional Y arrival fraction.
    F_X = np.ones(max_tau + 1, dtype=np.float64)
    if (
        runtime.composed_carrier is not None
        and runtime.composed_carrier.cdf_mean is not None
        and len(runtime.composed_carrier.cdf_mean) > 0
    ):
        cdf = np.asarray(runtime.composed_carrier.cdf_mean, dtype=np.float64)
        L = min(len(cdf), max_tau + 1)
        F_X[:L] = cdf[:L]
        if L < max_tau + 1:
            F_X[L:] = float(cdf[-1])
    F_Y = np.zeros(max_tau + 1, dtype=np.float64)
    if runtime.composed_subject is not None:
        if runtime.composed_carrier is None:
            sub_cdf = runtime.composed_subject.cdf_mean
            if sub_cdf is not None and len(sub_cdf) > 0:
                arr = np.asarray(sub_cdf, dtype=np.float64)
                L = min(len(arr), max_tau + 1)
                F_Y[:L] = arr[:L]
                if L < max_tau + 1:
                    F_Y[L:] = float(arr[-1])
        else:
            conv = _runtime_request_cdf_draws(runtime, horizon=max_tau)
            if conv is not None:
                F_Y = conv.mean(axis=0)
            else:
                sub_cdf = runtime.composed_subject.cdf_mean
                if sub_cdf is not None and len(sub_cdf) > 0:
                    arr = np.asarray(sub_cdf, dtype=np.float64)
                    L = min(len(arr), max_tau + 1)
                    F_Y[:L] = arr[:L]
                    if L < max_tau + 1:
                        F_Y[L:] = float(arr[-1])
    subject_reach = (
        float(runtime.composed_subject.span_p_mean)
        if runtime.composed_subject is not None else 0.0
    )

    completeness_mean, completeness_sd = _runtime_completeness(
        runtime,
        cohort_eval_ages=cohort_eval_ages,
        cohort_weights=cohort_weights,
        horizon=max_tau,
    )
    p_infinity_mean = (
        runtime.public_moments.p_mean if runtime.public_moments else None
    )
    p_infinity_sd = (
        runtime.public_moments.p_sd if runtime.public_moments else None
    )
    p_infinity_sd_epistemic = (
        runtime.public_moments.p_sd_epistemic
        if runtime.public_moments else None
    )

    def _quantiles(draws_2d: Optional[np.ndarray], tau: int):
        if draws_2d is None or tau >= draws_2d.shape[1]:
            return None, None, None, None, None
        d = draws_2d[:, tau]
        mid = float(np.median(d))
        upper = float(np.quantile(d, (1 + band_level) / 2))
        lower = float(np.quantile(d, (1 - band_level) / 2))
        bands = {
            str(int(bl * 100)): [
                float(np.quantile(d, (1 - bl) / 2)),
                float(np.quantile(d, (1 + bl) / 2)),
            ]
            for bl in band_levels
        }
        return mid, upper, lower, bands, float(np.mean(d))

    rows: List[Dict[str, Any]] = []
    for tau in range(max_tau + 1):
        ev = _evidence_display_at_tau(
            evidence_by_tau=evidence_by_tau,
            tau=tau,
            tau_future_max=tau_future_max,
        )
        # N(τ) = maturity-truncated effective request population (raw
        # sum_x is X-day-cohort observed mass; F_X[τ] re-bins it onto the
        # request's clock — identity in window/cohort A=X, carrier-driven
        # in cohort A≠X).
        f_x = float(F_X[tau]) if tau < len(F_X) else 1.0
        f_y = float(F_Y[tau]) if tau < len(F_Y) else (
            float(F_Y[-1]) if len(F_Y) else 0.0
        )
        n_eff = float(ev['sum_x']) if ev else 0.0
        evidence_x_tau = n_eff * f_x if ev else None
        evidence_y_tau = (
            n_eff * subject_reach * f_y if ev else None
        )
        rate = (
            evidence_y_tau / evidence_x_tau
            if evidence_x_tau and evidence_x_tau > 0 else None
        )
        rate_pure = (
            ev['sum_y_pure'] / ev['sum_x_pure']
            if ev and ev.get('sum_x_pure', 0) > 0
            else None
        )

        midpoint, fan_upper_val, fan_lower_val, fan_bands, projected_rate = (
            _quantiles(rate_draws, tau)
        )
        model_midpoint, model_fan_upper, model_fan_lower, model_bands, _ = (
            _quantiles(pred_rate_draws, tau)
        )
        (
            model_curve_midpoint,
            model_curve_fan_upper,
            model_curve_fan_lower,
            model_curve_bands,
            _,
        ) = _quantiles(epi_rate_draws, tau)

        if tau < tau_solid_max:
            midpoint = None
            fan_upper_val = None
            fan_lower_val = None
            fan_bands = None

        rows.append({
            'tau_days': tau,
            'rate': rate,
            'rate_pure': rate_pure,
            'evidence_y': evidence_y_tau,
            'evidence_x': evidence_x_tau,
            'projected_rate': projected_rate,
            'forecast_y': None,
            'forecast_x': None,
            'midpoint': midpoint,
            'fan_upper': fan_upper_val,
            'fan_lower': fan_lower_val,
            'fan_bands': fan_bands,
            'model_midpoint': model_midpoint,
            'model_fan_upper': model_fan_upper,
            'model_fan_lower': model_fan_lower,
            'model_bands': model_bands,
            'model_curve_midpoint': model_curve_midpoint,
            'model_curve_fan_upper': model_curve_fan_upper,
            'model_curve_fan_lower': model_curve_fan_lower,
            'model_curve_bands': model_curve_bands,
            'tau_solid_max': tau_solid_max,
            'tau_future_max': tau_future_max,
            'boundary_date': str(sweep_to)[:10],
            'cohorts_covered_base': ev['n_mature'] if ev else 0,
            'cohorts_covered_projected': ev['n_mature'] if ev else 0,
            'completeness': completeness_mean,
            'completeness_sd': completeness_sd,
            'p_infinity_mean': p_infinity_mean,
            'p_infinity_sd': p_infinity_sd,
            'p_infinity_sd_epistemic': p_infinity_sd_epistemic,
        })
    return rows


def _non_latency_rows(
    fe: Optional['FrameEvidence'],
    resolved: Any,
    sweep_to: str,
    axis_tau_max: Optional[int] = None,
    band_level: float = 0.90,
    extra_conditioning_evidence: Optional[List[tuple]] = None,
) -> NonLatencyResult:
    """Row builder for non-latency edges — doc 50 Class B, doc 52 blend.

    Routed by the authoritative `latency_parameter` flag on the edge
    (not by σ ≤ 0, which was an anti-pattern — see doc 49).

    Post doc 73b §3.9 / Decision 13, all sources (analytic, bayesian,
    manual) carry aggregate α, β. Conjugate Beta-Binomial update
    α' = α + Σk, β' = β + Σ(n − k); doc 52 engine-level blend then
    mixes the updated (α', β') with the unupdated aggregate (α, β) at
    ratio (1 − r) : r, where r = m_S / m_G.

    Class C (no evidence in the window) falls out naturally: Σn = 0 →
    update by zero = prior; blend trivially returns the aggregate.

    Returns a NonLatencyResult with ``rows=[]`` only for Class D (no
    usable α, β at all — the resolver failed to populate a prior and
    there's no evidence either).

    `extra_conditioning_evidence` carries `(age_days, n, k)` tuples
    derived from the typed merge's file-evidence points — already
    filtered against `snapshot_covered_observations` so they do not
    double-count rows present in `fe.cohort_list`. They are pooled
    into Σk/Σn for the conjugate update, matching the latency path
    which already feeds them to `compute_forecast_trajectory` via
    `extra_evidence`. Without this, the bundle reports merged totals
    that the row builder did not actually condition on.
    """
    from scipy.stats import beta as _beta_dist
    # Import the shared blend helper from the engine module.
    from runner.forecast_state import _compute_blend_params

    # ── Aggregate query-scoped evidence across cohorts ──────────────
    if fe is not None:
        sum_y = float(sum(c.get('y_frozen', 0.0) for c in fe.cohort_list))
        sum_x = float(sum(c.get('x_frozen', 0.0) for c in fe.cohort_list))
        sum_n_cohorts = len(fe.cohort_list)
        max_tau = fe.max_tau
        tau_solid_max = fe.tau_solid_max
        tau_future_max = fe.tau_future_max
    else:
        sum_y = 0.0
        sum_x = 0.0
        sum_n_cohorts = 0
        max_tau = axis_tau_max if axis_tau_max else 30
        tau_solid_max = 0
        tau_future_max = 0

    extra_x = 0.0
    extra_y = 0.0
    if extra_conditioning_evidence:
        for item in extra_conditioning_evidence:
            try:
                _age, n_val, k_val = item
            except (TypeError, ValueError):
                continue
            extra_x += float(n_val or 0.0)
            extra_y += float(k_val or 0.0)
    sum_x += extra_x
    sum_y += extra_y

    # ── Conjugate update with query evidence ───────────────────────
    # Post 73b §3.9 / Decision 13: α, β is uniformly an aggregate prior
    # across all sources. Conjugate update with query-scoped Σk, Σn.
    alpha_prior = max(float(getattr(resolved, 'alpha', 0.0) or 0.0), 0.0)
    beta_prior = max(float(getattr(resolved, 'beta', 0.0) or 0.0), 0.0)

    # Doc 52 §14.5: determine blend applicability. `m_S = sum_x` mirrors
    # the IS-path convention (sum of per-Cohort x_frozen).
    _blend_info = _compute_blend_params(resolved, sum_x)

    alpha_post_conditioned = alpha_prior + sum_y
    beta_post_conditioned = beta_prior + (sum_x - sum_y)

    if _blend_info['applied']:
        # Doc 52 §14.4.3: closed-form Beta blend at moment level.
        r_val = float(_blend_info['r'])
        s_cond = alpha_post_conditioned + beta_post_conditioned
        s_prior = alpha_prior + beta_prior
        if s_cond > 0 and s_prior > 0:
            mu_cond = alpha_post_conditioned / s_cond
            mu_prior = alpha_prior / s_prior
            var_cond = (alpha_post_conditioned * beta_post_conditioned
                        / (s_cond * s_cond * (s_cond + 1)))
            var_prior = (alpha_prior * beta_prior
                         / (s_prior * s_prior * (s_prior + 1)))
            mu_b = (1.0 - r_val) * mu_cond + r_val * mu_prior
            var_b = ((1.0 - r_val) * var_cond + r_val * var_prior
                     + (1.0 - r_val) * r_val * (mu_cond - mu_prior) ** 2)
            # Moment-match back to a display Beta.
            if 0.0 < mu_b < 1.0 and var_b > 0:
                common = mu_b * (1.0 - mu_b) / var_b - 1.0
                if common > 0:
                    alpha_post = mu_b * common
                    beta_post = (1.0 - mu_b) * common
                else:
                    # Variance too large to form a proper Beta — fall
                    # back to the conditioned update.
                    alpha_post = alpha_post_conditioned
                    beta_post = beta_post_conditioned
            else:
                alpha_post = alpha_post_conditioned
                beta_post = beta_post_conditioned
        else:
            alpha_post = alpha_post_conditioned
            beta_post = beta_post_conditioned
    else:
        alpha_post = alpha_post_conditioned
        beta_post = beta_post_conditioned

    # Class D guard: no usable prior and no evidence.
    if alpha_post <= 0 or beta_post <= 0:
        return NonLatencyResult(
            rows=[],
            r=_blend_info.get('r'),
            m_S=_blend_info.get('m_S'),
            m_G=_blend_info.get('m_G'),
            blend_applied=bool(_blend_info.get('applied')),
            blend_skip_reason=_blend_info.get('skip_reason'),
            conditioned=False,
        )

    # Whether the returned posterior incorporates observed evidence.
    # False when both `fe` and extras are empty (or all zero totals) —
    # the result then equals the prior (either α/β directly, or after
    # a trivial no-op conjugate update α+0, β+0). True when the
    # conjugate update saw any non-zero Σn from snapshot frames or
    # from the typed-merge file extras. Consumers that need to
    # distinguish real conditioned output from untouched-prior output
    # read this field from the edge response.
    conditioned = sum_x > 0

    # ── Posterior scalars (Beta closed form) ────────────────────────
    s = alpha_post + beta_post
    p_mean = alpha_post / s
    # Epistemic σ — Beta posterior after conjugate update with query
    # evidence. Tight when evidence is abundant.
    p_sd_epistemic = math.sqrt(alpha_post * beta_post / (s * s * (s + 1)))
    # Predictive σ — resolved.alpha_pred/beta_pred from doc 49 carry
    # kappa-inflated between-cohort dispersion. We do NOT conjugate-
    # update these with query Σk, Σn (that would collapse the kappa
    # spread to the epistemic width). Fall back to epistemic when the
    # resolver did not supply predictive params (e.g. kappa absent).
    _alpha_p = getattr(resolved, 'alpha_pred', 0.0) or 0.0
    _beta_p = getattr(resolved, 'beta_pred', 0.0) or 0.0
    if _alpha_p > 0 and _beta_p > 0 and (_alpha_p, _beta_p) != (alpha_prior, beta_prior):
        _sp = _alpha_p + _beta_p
        p_sd = math.sqrt(_alpha_p * _beta_p / (_sp * _sp * (_sp + 1)))
    else:
        p_sd = p_sd_epistemic

    # ── Quantile bands from Beta closed form ────────────────────────
    # Match the v3 chart's default band set: [band_level, 0.5].
    band_levels = [band_level, 0.5]
    fan_lower_val = float(_beta_dist.ppf((1 - band_level) / 2, alpha_post, beta_post))
    fan_upper_val = float(_beta_dist.ppf((1 + band_level) / 2, alpha_post, beta_post))
    fan_bands: Optional[Dict] = {
        str(int(bl * 100)): [
            float(_beta_dist.ppf((1 - bl) / 2, alpha_post, beta_post)),
            float(_beta_dist.ppf((1 + bl) / 2, alpha_post, beta_post)),
        ] for bl in band_levels
    }

    # ── Prior (unconditioned) bands for model_* fields ──────────────
    # The model_* bands show the pre-update prior distribution; the
    # main fan_* bands show the conjugate-updated posterior.
    if alpha_prior > 0 and beta_prior > 0:
        _sp = alpha_prior + beta_prior
        model_midpoint = alpha_prior / _sp
        model_fan_lower = float(_beta_dist.ppf((1 - band_level) / 2, alpha_prior, beta_prior))
        model_fan_upper = float(_beta_dist.ppf((1 + band_level) / 2, alpha_prior, beta_prior))
        model_bands: Optional[Dict] = {
            str(int(bl * 100)): [
                float(_beta_dist.ppf((1 - bl) / 2, alpha_prior, beta_prior)),
                float(_beta_dist.ppf((1 + bl) / 2, alpha_prior, beta_prior)),
            ] for bl in band_levels
        }
    else:
        model_midpoint = p_mean
        model_fan_lower = fan_lower_val
        model_fan_upper = fan_upper_val
        model_bands = fan_bands

    # Completeness for this fallback row set:
    #  - Non-latency edge (latency_parameter=false): everything materialises instantly
    #    once arriver count is known → completeness = 1.0.
    #  - Lagful edge (σ > 0) routed here because fe is None (cohort frames
    #    didn't compose for the per-scenario effective DSL): nothing has
    #    matured for this scope yet → completeness = 0.0. Drives the
    #    band-mixture variance to the predictive σ regime, which is the
    #    correct treatment for "no observed maturity yet".
    _lat_sigma = getattr(getattr(resolved, 'latency', None), 'sigma', 0.0) or 0.0
    _is_lagful_fallback = (fe is None and _lat_sigma > 0)
    _completeness_for_rows = 0.0 if _is_lagful_fallback else 1.0

    # ── Build rows (same schema as Class A, flat in τ) ──────────────
    rows: List[Dict[str, Any]] = []
    for tau in range(max_tau + 1):
        rows.append({
            'tau_days': tau,
            'rate': p_mean,
            'rate_pure': p_mean,
            'evidence_y': sum_y if (fe is not None or extra_x > 0) else None,
            'evidence_x': sum_x if (fe is not None or extra_x > 0) else None,
            'projected_rate': p_mean,
            'forecast_y': None,
            'forecast_x': None,
            'midpoint': p_mean,
            'fan_upper': fan_upper_val,
            'fan_lower': fan_lower_val,
            'fan_bands': fan_bands,
            'model_midpoint': model_midpoint,
            'model_fan_upper': model_fan_upper,
            'model_fan_lower': model_fan_lower,
            'model_bands': model_bands,
            'tau_solid_max': tau_solid_max,
            'tau_future_max': tau_future_max,
            'boundary_date': str(sweep_to)[:10],
            'cohorts_covered_base': sum_n_cohorts,
            'cohorts_covered_projected': sum_n_cohorts,
            'completeness': _completeness_for_rows,
            'completeness_sd': 0.0,
            'p_infinity_mean': p_mean,
            'p_infinity_sd': p_sd,
            'p_infinity_sd_epistemic': p_sd_epistemic,
        })

    return NonLatencyResult(
        rows=rows,
        r=_blend_info.get('r'),
        m_S=_blend_info.get('m_S'),
        m_G=_blend_info.get('m_G'),
        blend_applied=bool(_blend_info.get('applied')),
        blend_skip_reason=_blend_info.get('skip_reason'),
        conditioned=conditioned,
    )


# ═══════════════════════════════════════════════════════════════════════
# Shared evidence builder — used by both v3 chart and conditioned forecast
# ═══════════════════════════════════════════════════════════════════════

@dataclass
class FrameEvidence:
    """Intermediate evidence extracted from derived maturity frames.

    Produced by build_cohort_evidence_from_frames() and consumed by
    both the v3 chart builder (compute_cohort_maturity_rows_v3) and
    the conditioned forecast path.

    Design invariant: both consumers call compute_forecast_trajectory with
    the SAME engine_cohorts built from the SAME snapshot DB evidence.
    Public scalar moments are projected separately through ResolvedCFRuntime
    when primitive-backed moments are available; row trajectory fields do
    not force convergence to those scalar moments.
    """
    engine_cohorts: list           # List[CohortEvidence]
    cohort_list: List[Dict]        # sorted cohort_info dicts
    cohort_at_tau: Dict            # per-cohort tau observations
    evidence_by_tau: Dict          # aggregate evidence at each tau
    max_tau: int                   # display range (rows, chart x-axis)
    saturation_tau: int            # internal sweep horizon / fallback support
    tau_solid_max: int
    tau_future_max: int
    last_frame_date: Optional[_date] = None
    x_provider: Optional[Any] = None
    from_node_arrival: Optional[Any] = None
    carrier_tier: str = 'none'


def build_cohort_evidence_from_frames(
    frames: List[Dict[str, Any]],
    target_edge: Dict[str, Any],
    anchor_from: str,
    anchor_to: str,
    sweep_to: str,
    is_window: bool,
    resolved: Any,
    axis_tau_max: Optional[int] = None,
    *,
    x_provider_override: Optional[Any] = None,
) -> Optional[FrameEvidence]:
    """Build CohortEvidence from derived maturity frames.

    Shared between the v3 chart builder and the topo pass forecast
    sweep. Encapsulates: last-frame extraction, cohort_info, per-tau
    observation building, tau range computation, and materialisation of
    the observed prefix consumed by the shared sweep.

    Observed chart evidence remains the raw frame observations materialised
    onto engine cohorts. Carrier and subject-span semantics are resolved by
    the runtime substrate downstream; this builder must not rebuild an
    upstream carrier or patch row evidence to fit public scalar semantics.

    Returns None only when the request dates are malformed. If no
    observations bind to the selected semantic question, the builder still
    returns zero-observation cohorts so the general carrier/subject solve
    owns the no-evidence limit.
    """
    from .forecast_state import CohortEvidence

    try:
        anchor_from_d = _date.fromisoformat(str(anchor_from)[:10])
        anchor_to_d = _date.fromisoformat(str(anchor_to)[:10])
        sweep_to_d = _date.fromisoformat(str(sweep_to)[:10])
    except (ValueError, TypeError):
        return None

    lat = resolved.latency

    # ── Find last frame ────────────────────────────────────────────
    last_frame = None
    last_frame_date: Optional[_date] = None
    for f in frames:
        sd_str = str(f.get('snapshot_date', ''))[:10]
        if sd_str and sd_str <= str(sweep_to)[:10]:
            last_frame = f
            try:
                last_frame_date = _date.fromisoformat(sd_str)
            except (ValueError, TypeError):
                pass

    # ── Build per-cohort info from last frame ──────────────────────
    cohort_info: Dict[str, Dict[str, Any]] = {}
    if last_frame and last_frame.get('data_points'):
        for dp in last_frame['data_points']:
            ad_str = str(dp.get('anchor_day', ''))[:10]
            try:
                ad = _date.fromisoformat(ad_str)
            except (ValueError, TypeError):
                continue
            if ad < anchor_from_d or ad > anchor_to_d:
                continue
            x_val = dp.get('x', 0)
            y_val = dp.get('y', 0)
            a_val = dp.get('a', 0)
            if not isinstance(x_val, (int, float)):
                x_val = 0
            if not isinstance(a_val, (int, float)) or a_val <= 0:
                a_val = max(x_val, 1)
            # Per-cohort observation age: prefer the data_point's actual
            # `data_retrieved_at` (the timestamp of the latest snapshot
            # row that contributed (x, y) to this anchor), falling back
            # to the virtual frame's snapshot_date when the framer didn't
            # carry it through. Without this, sparse-snapshot scenarios
            # (e.g. fetcher hasn't run since some past date, or specific
            # anchors haven't been refreshed recently) inflate tau_max
            # to today's age and the IS likelihood treats stale
            # observations as fully mature, biasing the posterior toward
            # the empirical k/n of stale data. See doc 73f window_mature
            # analysis (29-Apr-26).
            _dp_retrieved = dp.get('data_retrieved_at')
            _obs_date: Optional[_date] = None
            if isinstance(_dp_retrieved, str) and _dp_retrieved:
                try:
                    _obs_date = _date.fromisoformat(_dp_retrieved[:10])
                except (ValueError, TypeError):
                    _obs_date = None
            _tau_anchor = _obs_date if _obs_date is not None else last_frame_date
            tau_max_c = (_tau_anchor - ad).days if _tau_anchor else 0
            cohort_info[ad_str] = {
                'x_frozen': float(x_val),
                'y_frozen': float(y_val) if isinstance(y_val, (int, float)) else 0.0,
                'a_frozen': float(a_val),
                'tau_max': max(tau_max_c, 0),
                'anchor_day': ad,
            }

    if not cohort_info:
        if anchor_from_d > anchor_to_d:
            return None
        ad = anchor_from_d
        while ad <= anchor_to_d:
            cohort_info[ad.isoformat()] = {
                'x_frozen': 0.0,
                'y_frozen': 0.0,
                'a_frozen': 1.0,
                'tau_max': 0,
                'anchor_day': ad,
            }
            ad += _timedelta(days=1)

    # ── Build per-(cohort, τ) observations from all frames ─────────
    cohort_at_tau: Dict[str, Dict[int, tuple]] = defaultdict(dict)

    for f in frames:
        sd_str = str(f.get('snapshot_date', ''))[:10]
        for dp in (f.get('data_points') or []):
            ad_str = str(dp.get('anchor_day', ''))[:10]
            ci = cohort_info.get(ad_str)
            if ci is None:
                continue
            try:
                sd_d = _date.fromisoformat(sd_str)
                ad_d = _date.fromisoformat(ad_str)
            except (ValueError, TypeError):
                continue
            tau = (sd_d - ad_d).days
            if tau < 0:
                continue
            x_val = dp.get('x')
            y_val = dp.get('y')
            if not isinstance(x_val, (int, float)) or x_val <= 0:
                continue
            if not isinstance(y_val, (int, float)) or y_val is None:
                continue
            cohort_at_tau[ad_str][tau] = (float(x_val), float(y_val))

    # evidence_by_tau is built after engine_cohorts so row projection reads
    # the same materialised observed series the trajectory consumes.

    # ── tau_observed per cohort ────────────────────────────────────
    for ad_str, ci in cohort_info.items():
        tau_obs = 0
        if last_frame_date:
            try:
                ad_d = _date.fromisoformat(ad_str)
                tau_obs = (last_frame_date - ad_d).days
            except (ValueError, TypeError):
                pass
        ci['tau_observed'] = min(tau_obs, ci['tau_max'])

    # ── Build cohort_list and epoch boundaries ─────────────────────
    cohort_list = sorted(cohort_info.values(), key=lambda c: c['anchor_day'])
    tau_solid_max = 0
    tau_future_max = max(0, (sweep_to_d - anchor_from_d).days)
    if cohort_list:
        youngest = cohort_list[-1]
        tau_solid_max = youngest.get('tau_observed', youngest['tau_max'])
        oldest = cohort_list[0]
        tau_future_max = oldest['tau_max']

    # ── Determine tau ranges ───────────────────────────────────────
    # max_tau         : display/row range — drives chart x-axis (unchanged).
    # saturation_tau  : internal sweep horizon — extends to 2*t95 (window)
    #                   or 2*path_t95 (cohort) so trajectory evaluation and
    #                   legacy scalar fallback have adequate support. It is
    #                   not a row-projection contract that midpoint equals
    #                   the public p_infinity scalar.
    #                   May exceed max_tau when path-level latency dominates
    #                   A→Y timing (cohort mode, multi-hop).
    max_tau = tau_future_max
    if axis_tau_max is not None and axis_tau_max > max_tau:
        max_tau = axis_tau_max
    if lat.sigma > 0:
        try:
            from .lag_distribution_utils import log_normal_inverse_cdf
            t95 = log_normal_inverse_cdf(
                0.95,
                lat.mu,
                lat.sigma,
            ) + lat.onset_delta_days
            max_tau = max(max_tau, int(math.ceil(t95)))
        except Exception:
            pass
    max_tau = min(max_tau, 400)

    saturation_tau = max_tau
    if lat.sigma > 0:
        try:
            from .lag_distribution_utils import log_normal_inverse_cdf
            mu_s, sigma_s, onset_s = lat.mu, lat.sigma, lat.onset_delta_days
            if not is_window:
                # Cohort mode: fallback scalar support needs the path-level
                # A→Y horizon, not the edge-local one. Re-resolve with
                # scope='path' because build_cohort_evidence receives
                # `resolved` from an earlier scope='edge' call (so
                # resolved.path_latency is None on this side).
                try:
                    path_resolved = resolve_model_params(
                        target_edge,
                        scope='path',
                        temporal_mode='cohort',
                    )
                    pl = (
                        getattr(path_resolved, 'path_latency', None)
                        if path_resolved
                        else None
                    )
                    if pl is not None and pl.sigma > 0:
                        mu_s, sigma_s, onset_s = (
                            pl.mu,
                            pl.sigma,
                            pl.onset_delta_days,
                        )
                except Exception:
                    pass
            t95_sat = log_normal_inverse_cdf(0.95, mu_s, sigma_s) + onset_s
            saturation_tau = max(saturation_tau, int(math.ceil(2.0 * t95_sat)))
        except Exception:
            pass
    saturation_tau = min(saturation_tau, 400)

    # Frame evidence is raw observed chart evidence only. Active A!=X
    # carrier semantics are owned by the primitive-backed runtime span;
    # this builder must not construct a carrier or alter public scalars.
    x_provider = x_provider_override
    from_node_arrival = None
    carrier_tier = 'none'

    engine_cohorts: list = []
    materialised_cohort_list: List[Dict[str, Any]] = []
    for ci in cohort_list:
        raw_n_i = float(ci.get('x_frozen', 0.0) or 0.0)
        a_i = int(ci.get('tau_observed', ci['tau_max']) or 0)
        a_i = min(max(a_i, 0), saturation_tau)
        a_pop = float(ci.get('a_frozen', raw_n_i) or raw_n_i or 1.0)
        ad_str = ci['anchor_day'].isoformat()
        tau_data = cohort_at_tau.get(ad_str, {})

        raw_obs_x = [0.0] * (saturation_tau + 1)
        raw_obs_y = [0.0] * (saturation_tau + 1)
        last_x = raw_n_i if is_window else 0.0
        last_y = 0.0
        for t in range(saturation_tau + 1):
            if t <= a_i:
                obs = tau_data.get(t)
                if obs:
                    last_x = float(obs[0])
                    last_y = float(obs[1])
                elif is_window:
                    last_x = raw_n_i
                raw_obs_x[t] = last_x
                raw_obs_y[t] = last_y
            else:
                raw_obs_x[t] = last_x if last_x > 0 else raw_n_i
                raw_obs_y[t] = last_y

        obs_x = raw_obs_x
        obs_y = raw_obs_y
        x_frozen = float(obs_x[a_i]) if a_i < len(obs_x) else raw_n_i
        y_frozen = float(obs_y[a_i]) if a_i < len(obs_y) else float(ci.get('y_frozen', 0.0) or 0.0)
        evidence_n = x_frozen
        evidence_k = y_frozen

        ci_materialised = dict(ci)
        ci_materialised['x_frozen'] = x_frozen
        ci_materialised['y_frozen'] = y_frozen
        ci_materialised['evidence_n'] = evidence_n
        ci_materialised['evidence_k'] = evidence_k
        materialised_cohort_list.append(ci_materialised)

        engine_cohorts.append(CohortEvidence(
            obs_x=obs_x,
            obs_y=obs_y,
            x_frozen=x_frozen,
            y_frozen=y_frozen,
            frontier_age=a_i,
            a_pop=a_pop,
            evidence_n=evidence_n,
            evidence_k=evidence_k,
            # Doc 45 §Response contract: the CF endpoint and the
            # cohort maturity chart share this engine. Setting
            # eval_age = frontier_age tells compute_forecast_trajectory to
            # populate `sweep.completeness_mean` / `completeness_sd`
            # (n-weighted CDF across cohorts at their own frontiers).
            # Without this, the sweep leaves those fields None and
            # downstream consumers (the CF endpoint, maturity rows)
            # have nothing to report — the exact gap that let
            # completeness go AWOL end-to-end.
            eval_age=a_i,
        ))

    if not engine_cohorts:
        return None

    # ── Aggregate evidence_by_tau from engine_cohorts ──────────────
    # Both sum_x and sum_y are observed values drawn from the engine
    # cohorts' obs_x / frame y at each recorded tau. n_cohorts counts
    # cohorts that reported a real observation at this tau.
    evidence_by_tau: Dict[int, Dict] = {}
    for ci, engine_cohort in zip(materialised_cohort_list, engine_cohorts):
        ad_str = ci['anchor_day'].isoformat()
        for tau in cohort_at_tau.get(ad_str, {}):
            if tau < 0 or tau > saturation_tau:
                continue
            bucket = evidence_by_tau.setdefault(
                int(tau),
                {'sum_y': 0.0, 'sum_x': 0.0, 'n_cohorts': 0},
            )
            if tau < len(engine_cohort.obs_x):
                bucket['sum_x'] += float(engine_cohort.obs_x[tau])
            else:
                bucket['sum_x'] += float(engine_cohort.x_frozen)
            if tau < len(engine_cohort.obs_y):
                bucket['sum_y'] += float(engine_cohort.obs_y[tau])
            else:
                bucket['sum_y'] += float(engine_cohort.y_frozen)
            bucket['n_cohorts'] += 1

    return FrameEvidence(
        engine_cohorts=engine_cohorts,
        cohort_list=materialised_cohort_list,
        cohort_at_tau=dict(cohort_at_tau),
        evidence_by_tau=evidence_by_tau,
        max_tau=max_tau,
        saturation_tau=saturation_tau,
        tau_solid_max=tau_solid_max,
        tau_future_max=tau_future_max,
        last_frame_date=last_frame_date,
        x_provider=x_provider,
        from_node_arrival=from_node_arrival,
        carrier_tier=carrier_tier,
    )


def compute_cohort_maturity_rows_v3(
    frames: List[Dict[str, Any]],
    graph: Dict[str, Any],
    target_edge_id: str,
    query_from_node: str,
    query_to_node: str,
    anchor_from: str,
    anchor_to: str,
    sweep_to: str,
    is_window: bool = True,
    axis_tau_max: Optional[int] = None,
    band_level: float = 0.90,
    anchor_node_id: Optional[str] = None,
    is_multi_hop: bool = False,
    resolved_override: Any = None,
    evidence_set: Any = None,
    evidence_candidates: Optional[List[Any]] = None,
    scenario_id: Optional[str] = None,
    as_at: Optional[str] = None,
    per_edge_upstream_evidence: Optional[Dict[str, Any]] = None,
    per_edge_subject_evidence: Optional[Dict[str, Any]] = None,
    extra_conditioning_evidence: Optional[List[tuple]] = None,
    show_model_curve: bool = False,
) -> List[Dict[str, Any]]:
    """Compute per-tau rows for the cohort_maturity v3 chart.

    The row builder is a thin readout of ``ResolvedCFRuntime`` — the one
    request-scoped object that owns conditioning, composition, and
    projection. There is no trajectory-engine call from this path: the
    primitive registry has already conditioned every parameterised edge
    and the span composers have already produced
    ``span_p_draws`` / ``cdf_draws`` for both the carrier (A→X) and the
    subject (X→end). Window and cohort(A=X) are identity-carrier data
    cases of the same object; active cohort uses a real composed
    carrier convolved with the subject CDF.

    When the runtime cannot build a draw-coherent composition the public
    fields are left ``None`` and the row marks itself as degraded; this
    function never substitutes legacy aggregate timing or runs an
    aggregate-IS conditioning step.
    """
    from .forecast_runtime import find_edge_by_id, get_cf_mode_and_reason

    target_edge = find_edge_by_id(graph, target_edge_id)
    if target_edge is None:
        return []

    # ── Resolve model params ────────────────────────────────────────
    # Default: edge-level. ``resolved_override`` carries collapsed
    # shortcuts (e.g. path latency + edge p for multi-hop subjects).
    if resolved_override is not None:
        resolved = resolved_override
    else:
        temporal = 'window' if is_window else 'cohort'
        resolved = resolve_model_params(
            target_edge,
            scope='edge',
            temporal_mode=temporal,
        )
    if not resolved:
        return []
    _cf_mode, _cf_reason = get_cf_mode_and_reason(resolved)

    # ── Observed evidence display (raw frame observation only) ──────
    # The frame evidence carries the chart's per-(τ) observed series and
    # the per-cohort eval ages used for completeness. Carrier reach,
    # subject span, and asymptotic rates come from the runtime, not from
    # this object.
    fe = build_cohort_evidence_from_frames(
        frames=frames,
        target_edge=target_edge,
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        sweep_to=sweep_to,
        is_window=is_window,
        resolved=resolved,
        axis_tau_max=axis_tau_max,
        x_provider_override=None,
    )
    if fe is None:
        return []

    # 73g §1: one general forecast machinery path. Build a single
    # request-level candidate pool from every parameterised primitive
    # in the request topology — target subject, non-target subject
    # edges, and carrier edges. Per-primitive merge in the readout
    # filters by ``(subject_from, subject_to)`` naturally, so a single
    # pool is correct: each primitive sees only its own rows by
    # subject identity, then admits or rejects them by its local
    # arrival-weight clock support. This avoids the
    # target-vs-carrier branch the readout would otherwise need.
    #
    # The per-edge ``EvidenceSet`` dicts arrive already merged at the
    # public anchor scope. Lifting candidates back out and re-merging
    # per-primitive is idempotent for already-deduped points; rows
    # that were clipped upstream are not recovered here. Widening the
    # upstream snapshot retrieval is a separate atom that follows.
    request_candidates = _aggregate_request_candidates(
        target_candidates=evidence_candidates,
        per_edge_subject_evidence=per_edge_subject_evidence,
        per_edge_upstream_evidence=per_edge_upstream_evidence,
        target_evidence_set=evidence_set,
    )

    runtime = build_resolved_cf_runtime(
        graph=graph,
        target_edge_id=str(target_edge_id),
        query_from_node=str(query_from_node),
        query_to_node=str(query_to_node),
        anchor_from=str(anchor_from or ''),
        anchor_to=str(anchor_to or anchor_from or ''),
        sweep_to=str(sweep_to or anchor_from or ''),
        as_at=as_at,
        scenario_id=scenario_id,
        is_window=is_window,
        is_multi_hop=is_multi_hop,
        anchor_node_id=anchor_node_id,
        resolved=resolved,
        evidence_set=evidence_set,
        evidence_candidates=request_candidates,
        per_edge_subject_evidence=per_edge_subject_evidence,
        per_edge_upstream_evidence=per_edge_upstream_evidence,
        legacy_p_mean=None,
        legacy_p_sd=None,
        legacy_p_sd_epistemic=None,
        unconditioned_overlay_bases=(
            ('predictive', 'epistemic') if show_model_curve else ('predictive',)
        ),
    )
    if runtime is None:
        return []

    cohort_eval_ages = [
        int(c.get('tau_observed', c.get('tau_max', 0)) or 0)
        for c in fe.cohort_list
    ]
    cohort_weights = [
        float(c.get('evidence_n', c.get('x_frozen', 0.0)) or 0.0)
        for c in fe.cohort_list
    ]

    rows = _project_runtime_rows(
        runtime=runtime,
        evidence_by_tau=fe.evidence_by_tau,
        cohort_eval_ages=cohort_eval_ages,
        cohort_weights=cohort_weights,
        max_tau=fe.max_tau,
        tau_solid_max=fe.tau_solid_max,
        tau_future_max=fe.tau_future_max,
        sweep_to=sweep_to,
        band_level=band_level,
    )

    return _attach_cf_row_metadata(
        rows,
        conditioning={'owner': 'primitive_conditioning'},
        conditioned=runtime.public_moments.p_mean is not None,
        cf_mode=_cf_mode,
        cf_reason=_cf_reason,
        runtime_provenance=runtime.project_runtime_provenance(),
    )
