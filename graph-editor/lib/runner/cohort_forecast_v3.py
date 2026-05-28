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
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .model_resolver import resolve_model_params
from .prefix_arrival import PrefixArrivalMap
from .primitive_evidence import RequestPrimitiveRegistry
from .primitives import ConditionedTransitionPrimitive
from .subject_span_composer import ComposedPrimitiveSpan
from . import model_span_spine
from .primitive_readout import (
    ComposedUnconditionedOverlay,
    _resolved_to_timing_transition,
)
from .timing_span import TimingTransitionPrimitive


def _beta_sd(alpha: float, beta: float) -> float:
    s = alpha + beta
    return math.sqrt(alpha * beta / (s * s * (s + 1.0)))


def build_carrier_superset_candidates_by_edge(
    *,
    graph: Dict[str, Any],
    anchor_node_id: Optional[str],
    query_from_node: Optional[str],
    per_edge_results_by_uuid: Dict[str, Dict[str, Any]],
    anchor_from: str,
    sweep_to: str,
    as_at: Optional[str],
    scenario_id: str,
    context_key: Optional[str] = None,
    context_selector: Optional[str] = None,
    mece_dimensions: Sequence[str] = (),
) -> Dict[str, Tuple[Any, ...]]:
    """Translate fetched superset rows for active carrier primitives."""
    return build_superset_candidates_by_edge(
        graph=graph,
        from_node=anchor_node_id,
        to_node=query_from_node,
        per_edge_results_by_uuid=per_edge_results_by_uuid,
        anchor_from=anchor_from,
        sweep_to=sweep_to,
        as_at=as_at,
        scenario_id=scenario_id,
        context_key=context_key,
        context_selector=context_selector,
        mece_dimensions=mece_dimensions,
        is_carrier=True,
    )


def build_superset_candidates_by_edge(
    *,
    graph: Dict[str, Any],
    from_node: Optional[str],
    to_node: Optional[str],
    per_edge_results_by_uuid: Dict[str, Dict[str, Any]],
    anchor_from: str,
    sweep_to: str,
    as_at: Optional[str],
    scenario_id: str,
    context_key: Optional[str] = None,
    context_selector: Optional[str] = None,
    mece_dimensions: Sequence[str] = (),
    is_carrier: bool = False,
) -> Dict[str, Tuple[Any, ...]]:
    """Translate fetched evidence-superset rows into candidates by edge.

    Walks the topology between ``from_node`` and ``to_node`` and for every
    parameterised edge translates rows already returned by the evidence
    superset/envelope interface. This helper performs no evidence fetch,
    no source-family read, no deduplication, and no merge.

    The returned map is keyed by both ``edge_id`` and ``uuid`` so readout
    call sites resolve the entry under either identifier.

    Edges with no supplied superset rows are absent from the map; primitive
    preparation then binds empty candidates and naturally degenerates to
    PRIOR_ONLY.
    """
    from .edge_binding_descriptor import (
        build_candidates_for_descriptor,
        enumerate_per_edge_descriptors,
    )

    descriptors = enumerate_per_edge_descriptors(
        graph=graph,
        from_node=str(from_node) if from_node else '',
        to_node=str(to_node) if to_node else '',
        is_carrier=is_carrier,
        target_edge_uuid=None,
        anchor_from=anchor_from,
        sweep_to=sweep_to,
        as_at=as_at,
        scenario_id=scenario_id,
        anchor_node_id=None,
        context_key=context_key,
        context_selector=context_selector,
        mece_dimensions=tuple(mece_dimensions or ()),
    )
    if not descriptors:
        return {}

    candidates_by_edge: Dict[str, Tuple[Any, ...]] = {}
    for d in descriptors:
        entry = (
            per_edge_results_by_uuid.get(d.edge_uuid)
            or per_edge_results_by_uuid.get(d.edge_id)
        )
        superset_rows: Optional[List[Dict[str, Any]]] = None
        if entry:
            rows = entry.get('evidence_superset_rows') or []
            if rows:
                superset_rows = list(rows)

        candidates = build_candidates_for_descriptor(
            d,
            superset_rows=superset_rows,
        )
        if not candidates:
            continue
        raw = tuple(candidates)
        candidates_by_edge[d.edge_id] = raw
        candidates_by_edge[d.edge_uuid] = raw
    return candidates_by_edge


def _aggregate_request_candidates(
    *,
    target_candidates: Optional[Sequence[Any]],
    per_edge_subject_candidates: Optional[Dict[str, Sequence[Any]]] = None,
    per_edge_upstream_candidates: Optional[Dict[str, Sequence[Any]]] = None,
) -> List[Any]:
    """Union of every parameterised primitive's candidate material.

    Returns a flat list of ``EvidenceCandidate`` objects spanning the
    target subject, every non-target subject edge, and every carrier
    edge in the request topology. Per-primitive merge in the readout
    filters by ``(subject_from, subject_to)`` so each primitive only
    sees the rows that belong to its own edge.

    The per-edge candidate dicts arrive keyed by both ``edge_id`` and
    ``uuid`` (see ``build_superset_candidates_by_edge``); deduplication
    by object identity prevents the same tuple's rows from contributing
    twice to the pool.
    """
    pool: List[Any] = []
    seen_candidates: set = set()
    seen_sequences: set = set()

    def _candidate_key(candidate: Any) -> tuple:
        return (
            getattr(candidate, 'source', None),
            getattr(candidate, 'identity', None),
            getattr(candidate, 'coordinate', None),
            int(getattr(candidate, 'n', 0) or 0),
            int(getattr(candidate, 'k', 0) or 0),
        )

    def _extend(candidates: Optional[Sequence[Any]]) -> None:
        if not candidates:
            return
        for candidate in candidates:
            if candidate is None:
                continue
            key = _candidate_key(candidate)
            if key in seen_candidates:
                continue
            seen_candidates.add(key)
            pool.append(candidate)

    def _extend_candidate_map(candidate_map: Optional[Dict[str, Sequence[Any]]]) -> None:
        if not candidate_map:
            return
        for candidates in candidate_map.values():
            if candidates is None or id(candidates) in seen_sequences:
                continue
            seen_sequences.add(id(candidates))
            _extend(candidates)

    _extend(target_candidates)

    _extend_candidate_map(per_edge_subject_candidates)
    _extend_candidate_map(per_edge_upstream_candidates)
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
    graph: Optional[Mapping[str, Any]]
    population_root: Optional[str]
    denominator_node: Optional[str]
    subject_end: Optional[str]
    public_moments: _PrimitiveRuntimeResult
    runtime_provenance: Optional[Mapping[str, Any]]
    numerator_representation: str = 'factorised'
    admission_policy: Optional[Mapping[str, Any]] = None
    arrival_map: Optional[PrefixArrivalMap] = None
    carrier_arrival_map: Optional[PrefixArrivalMap] = None
    request_evidence_candidates: Optional[Sequence[Any]] = None
    evidence_resolution_registry: Optional[RequestPrimitiveRegistry] = None
    conditioned_primitive_map: Optional[Mapping[str, ConditionedTransitionPrimitive]] = None
    carrier_span: Optional[Mapping[str, Any]] = None
    subject_span: Optional[Mapping[str, Any]] = None
    projection_provenance: Optional[Mapping[str, Any]] = None
    composed_subject: Optional[ComposedPrimitiveSpan] = None
    composed_carrier: Optional[ComposedPrimitiveSpan] = None
    # FC plan §9.4 — predictive-basis conditioned spans built from the
    # same bound evidence as ``composed_subject`` / ``composed_carrier``
    # but with ``dispersion_basis='predictive'``. The FC shadow surface
    # reads these (NOT the epistemic conditioned pair, and NOT the
    # unconditioned-predictive overlay).
    composed_subject_predictive: Optional[ComposedPrimitiveSpan] = None
    composed_carrier_predictive: Optional[ComposedPrimitiveSpan] = None
    # Empirical evidence operator spans (Phase 6 §4.9). Composed sibling
    # of the conditioned spans above; row reducer reads both and routes
    # evidence-named row fields (strict / adjusted / rate) to the
    # empirical operator while model surfaces stay on the conditioned
    # operator (§5.6).
    composed_empirical_carrier: Optional[ComposedPrimitiveSpan] = None
    composed_empirical_subject: Optional[ComposedPrimitiveSpan] = None
    # Union of carrier + subject source-layer transitions, keyed by
    # (source_node, destination_node). Same primitives the carrier/
    # subject arrival maps consume — populated once at runtime build
    # time so the M_select construction can call the shared timing
    # composer rooted at A end-to-end without re-deriving source-layer
    # input from the conditioned posteriors. Per docs/current/cohort-
    # 1apr-falling-k-problem-statement.md A.1 §153: the same resolved
    # carrier/subject-span prefix machinery produces M_select for every
    # primitive source node U.
    source_layer_transitions: Optional[
        Mapping[Tuple[str, str], TimingTransitionPrimitive]
    ] = None
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
    evidence_date_from: Optional[str] = None,
    evidence_date_to: Optional[str] = None,
    context_key: Optional[str] = None,
    context_selector: Optional[str] = None,
    mece_dimensions: Sequence[str] = (),
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
            context_key=context_key,
            context_selector=context_selector,
            mece_dimensions=tuple(mece_dimensions or ()),
            regime_key=None,
            model_source_preference='best_available',
            resolved_source_identity=resolved_source,
            evidence_date_from=evidence_date_from,
            evidence_date_to=evidence_date_to,
        ),
    )


def _primitive_scope_dates_for_edge(
    *,
    envelope_plan: Optional[Any],
    edge_uuid: Optional[str],
    edge_id: str,
    fallback_from: str,
    fallback_to: str,
) -> Tuple[str, str]:
    """Return the evidence-admission date bounds for one primitive edge.

    Snapshot fetching already uses per-edge envelope bounds. Primitive
    binding must admit against the same bounds, otherwise the runtime can
    fetch subject-clock rows and then reject them as out-of-date at the
    merge layer.
    """
    if envelope_plan is None:
        return str(fallback_from or ''), str(fallback_to or fallback_from or '')

    env = None
    if edge_uuid:
        env = envelope_plan.by_edge_uuid.get(str(edge_uuid))
    if env is None and edge_id:
        env = envelope_plan.by_edge_id.get(str(edge_id))
    if env is None:
        return str(fallback_from or ''), str(fallback_to or fallback_from or '')
    return env.anchor_from.isoformat(), env.anchor_to.isoformat()


def _build_span_resolutions(
    *,
    graph: Dict[str, Any],
    from_node: str,
    to_node: str,
    target_edge_id: str,
    target_resolved: Any,
    temporal_mode: str,
    scenario_id: str,
    anchor_from: str,
    anchor_to: str,
    as_at: Optional[str],
    resolution_class: Any,
    mark_target: bool,
    envelope_plan: Optional[Any] = None,
    context_key: Optional[str] = None,
    context_selector: Optional[str] = None,
    mece_dimensions: Sequence[str] = (),
) -> tuple[Optional[list], Optional[str]]:
    from .span_kernel import _build_span_topology

    # Zero-length span (from == to): the A->X carrier when the population
    # root sits at X (window / cohort(A=X)). There are no edges to resolve,
    # so the leg degenerates to an empty family — not a skip. This is the
    # null-subgraph degeneration that dissolves the carrier without
    # consulting a mode flag at the call site.
    if str(from_node) == str(to_node):
        return [], None

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
        scope_date_from, scope_date_to = _primitive_scope_dates_for_edge(
            envelope_plan=envelope_plan,
            edge_uuid=str(edge_uuid) if edge_uuid else None,
            edge_id=str(edge_id),
            fallback_from=str(anchor_from or ''),
            fallback_to=str(anchor_to or anchor_from or ''),
        )
        transition, primitive_scope = _runtime_scope(
            scenario_id=scenario_id,
            from_node=str(edge_from),
            to_node=str(edge_to),
            edge_id=emit_edge_id,
            date_from=str(anchor_from or ''),
            date_to=str(anchor_to or anchor_from or ''),
            as_at=as_at,
            resolved_source=getattr(edge_resolved, 'source', None),
            evidence_date_from=scope_date_from,
            evidence_date_to=scope_date_to,
            context_key=context_key,
            context_selector=context_selector,
            mece_dimensions=tuple(mece_dimensions or ()),
        )
        kwargs = dict(
            transition=transition,
            primitive_scope=primitive_scope,
            resolved_model=edge_resolved,
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
    population_root: str,
    temporal_mode: str,
    is_multi_hop: bool,
    anchor_node_id: Optional[str],
    resolved: Any,
    max_tau: int,
    unconditioned_overlay_bases: Sequence[str] = ('predictive',),
    evidence_candidates: Optional[List[Any]] = None,
    envelope_plan: Optional[Any] = None,
    context_key: Optional[str] = None,
    context_selector: Optional[str] = None,
    mece_dimensions: Sequence[str] = (),
) -> Optional[ResolvedCFRuntime]:
    """Build the primitive-backed runtime object for row/scalar projection.

    `envelope_plan` carries the per-request `RequestEnvelopePlan` whose
    arrival maps the runtime consumes. In active mode (`A != X`) the
    plan's `carrier_arrival_map` is rooted on the cohort A-anchor range
    (per `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` invariant 5)
    and its `subject_arrival_map` is rooted on the carrier's X-arrival
    days.

    Note: the `target_subject_metadata` parameter that previously gated
    in-runtime widening was removed when fetch-envelope construction
    moved to the preparation layer. See
    docs/current/snapshot-fetch-envelope-design.md.
    """
    if not scenario_id:
        return None

    from .primitive_readout import (
        CarrierEdgeResolution,
        ComposeOptions,
        ConditioningPolicyOptions,
        SpanEdgeResolution,
        compute_resolved_runtime_readout,
    )

    # population_root and temporal_mode are resolved once at the engine's
    # public entry (build_cf_projection_bundle) and threaded in. The carrier
    # leg and active-carrier flag below read this root (an upstream root ⟺
    # there is an A→X leg); no mode flag is consulted here.
    subject_resolutions, subject_skip = _build_span_resolutions(
        graph=graph,
        from_node=str(query_from_node),
        to_node=str(query_to_node),
        target_edge_id=str(target_edge_id),
        target_resolved=resolved,
        temporal_mode=temporal_mode,
        scenario_id=str(scenario_id),
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        as_at=as_at,
        resolution_class=SpanEdgeResolution,
        mark_target=True,
        envelope_plan=envelope_plan,
        context_key=context_key,
        context_selector=context_selector,
        mece_dimensions=tuple(mece_dimensions or ()),
    )

    # Carrier (A→X) leg, rooted at the population root. When the root sits
    # at X (window / cohort(A=X)) the span is zero-length and resolves to
    # an empty family (see `_build_span_resolutions`) — the leg degenerates
    # to nothing without a mode flag.
    carrier_resolutions, carrier_skip = _build_span_resolutions(
        graph=graph,
        from_node=str(population_root),
        to_node=str(query_from_node),
        target_edge_id=str(target_edge_id),
        target_resolved=resolved,
        temporal_mode='cohort',
        scenario_id=str(scenario_id),
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        as_at=as_at,
        resolution_class=CarrierEdgeResolution,
        mark_target=False,
        envelope_plan=envelope_plan,
        context_key=context_key,
        context_selector=context_selector,
        mece_dimensions=tuple(mece_dimensions or ()),
    )

    # Two-clocks split (per `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`
    # invariant 5): the denominator clock is the carrier `A → X` clock; the
    # numerator clock is the subject-span `X → end` clock. They answer
    # different questions ("who has reached X" vs "given mass at X, when
    # does it reach end"), so they require independent arrival maps rooted
    # on different sets of source days.
    #
    # The carrier map's roots are the cohort A-anchor range; the subject
    # map's roots in active mode are the carrier's X-arrival days. The
    # `RequestEnvelopePlan` builds both maps with these roots (see
    # `runner.request_envelope.build_request_envelope_plan`); the runtime
    # consumes them rather than rebuilding.
    #
    # Pre-fix the runtime built its own carrier map with root day support
    # taken from the subject target's primitive scope, which excluded
    # cohort A-anchors that fell before the subject's evidence window —
    # silently dropping early anchors from chart evidence. The envelope
    # path is the canonical construction; consuming it here removes the
    # duplicate map and the divergence.
    conditioning_options = ConditioningPolicyOptions()

    # One builder for the timing curves: the request-envelope plan. Use the
    # prep step's plan when supplied; otherwise build it from the same builder
    # (degenerate / minimal unit callers). The builder already degenerates —
    # a zero-length A→X carrier yields a None carrier map (the spine composes
    # the empty carrier as a zero-edge identity) and an X-rooted identity
    # subject map. The runtime then reads both maps unconditionally: no
    # window/cohort branch and no second arrival-map builder.
    if envelope_plan is None:
        from .request_envelope import build_request_envelope_plan
        envelope_plan = build_request_envelope_plan(
            graph=graph,
            query_from_node=str(query_from_node),
            query_to_node=str(query_to_node),
            anchor_from=_date.fromisoformat(str(anchor_from)[:10]),
            anchor_to=_date.fromisoformat(str(anchor_to)[:10]),
            population_root=str(population_root),
            graph_preference=graph.get('model_source_preference'),
            as_at=as_at,
            scenario_id=scenario_id,
            context_key=context_key,
            context_selector=context_selector,
        )
    carrier_arrival_map = envelope_plan.carrier_arrival_map
    subject_arrival_map = envelope_plan.subject_arrival_map

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
        options=conditioning_options,
        compose_options=ComposeOptions(draw_count=conditioning_options.draw_count),
        prior_source=getattr(resolved, 'source', None),
        unconditioned_overlay_bases=unconditioned_overlay_bases,
        request_evidence_candidates=evidence_candidates,
        prebuilt_subject_arrival_map=subject_arrival_map,
        prebuilt_carrier_arrival_map=carrier_arrival_map,
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

    readout_substitutes = bool(
        result.eligible
        and result.composed_subject is not None
        and result.composed_carrier is not None
        and result.p_mean_primitive is not None
    )
    if not readout_substitutes:
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
    # Union of source-layer transitions over the request's full A->end
    # subgraph. Same `_resolved_to_timing_transition` conversion the
    # subject and carrier arrival maps already use, just collected on
    # the runtime so the M_select construction (which is rooted at A
    # and spans both spans) reuses the same timing input rather than
    # deriving downstream PMFs from per-edge conditioned posteriors.
    # Window mode has no carrier resolutions; `or ()` covers that.
    source_layer_transitions: Dict[
        Tuple[str, str], TimingTransitionPrimitive
    ] = {}
    for resolution in list(carrier_resolutions or ()) + list(subject_resolutions or ()):
        edge_key = (
            str(resolution.transition.source_node),
            str(resolution.transition.destination_node),
        )
        if edge_key in source_layer_transitions:
            continue
        source_layer_transitions[edge_key] = _resolved_to_timing_transition(
            transition=resolution.transition,
            resolved=resolution.resolved_model,
        )

    return ResolvedCFRuntime(
        graph=graph,
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
        carrier_arrival_map=carrier_arrival_map,
        request_evidence_candidates=tuple(evidence_candidates or ()),
        evidence_resolution_registry=result.primitive_registry,
        conditioned_primitive_map=dict(result.conditioned_primitive_map),
        carrier_span=result.carrier_span_role,
        subject_span=result.subject_span_role,
        projection_provenance=projection_provenance,
        composed_subject=result.composed_subject,
        composed_carrier=result.composed_carrier,
        composed_subject_predictive=result.composed_subject_predictive,
        composed_carrier_predictive=result.composed_carrier_predictive,
        composed_empirical_carrier=result.composed_empirical_carrier,
        composed_empirical_subject=result.composed_empirical_subject,
        eligible=readout_substitutes,
        skip_reason=result.skip_reason,
        unconditioned_overlays=dict(result.unconditioned_overlays),
        source_layer_transitions=source_layer_transitions,
    )


# =====================================================================
# Model-span algebra lives in ``model_span_spine``. See that module's
# docstring for the full design spine (clocks, conditioning roots, span
# composition, readout). The thin wrappers below preserve the
# Optional-returning call signature used by existing cf-v3 callers:
# spine inputs are guaranteed valid composed spans; the wrapper layer
# interprets absent spans into the legacy ``None`` signal.


def _strict_span_model_rate_draws(
    subject: Optional[ComposedPrimitiveSpan],
    carrier: Optional[ComposedPrimitiveSpan],
    *,
    horizon: int,
) -> Optional[np.ndarray]:
    """Wrapper — delegates to ``model_span_spine.evaluate_model_rate_draws``.

    Returns ``None`` when either span is absent (early-skip propagation)
    rather than raising, so existing callers keep their fallback shape.
    """
    if subject is None or carrier is None:
        return None
    return model_span_spine.evaluate_model_rate_draws(
        subject, carrier, horizon=horizon,
    )


def _strict_span_request_cdf_draws(
    subject: Optional[ComposedPrimitiveSpan],
    carrier: Optional[ComposedPrimitiveSpan],
    *,
    horizon: int,
) -> Optional[np.ndarray]:
    """Wrapper — delegates to ``model_span_spine.evaluate_request_cdf_draws``.

    Returns ``None`` when either span is absent (early-skip propagation).
    """
    if subject is None or carrier is None:
        return None
    return model_span_spine.evaluate_request_cdf_draws(
        subject, carrier, horizon=horizon,
    )


def _runtime_request_cdf_draws(
    runtime: ResolvedCFRuntime,
    *,
    horizon: int,
) -> Optional[np.ndarray]:
    """Convenience: request-rooted CDF for the conditioned posterior."""
    return _strict_span_request_cdf_draws(
        runtime.composed_subject,
        runtime.composed_carrier,
        horizon=horizon,
    )


def _latent_chart_extent(
    runtime: ResolvedCFRuntime,
    *,
    floor: int,
    cap: int,
    axis_tau_max: Optional[int],
) -> int:
    """Chart extent latent on the model's composed latency reach.

    The extent is the t95 reach of the unconditioned predictive request span
    (carrier∘subject, composed from the population root): window (X→Z) and
    cohort (A→Z) differ only in which root the composition began from, so no
    temporal mode is consulted — the reach is latent in the composed CDF.

    The predictive (model) basis is used rather than the rate-conditioned
    posterior because the chart extent is a latency-support property — how far
    conversions can land — not a rate quantity. Sparse or zero evidence
    collapses a conditioned CDF to no mass (asymptote → 0), which would clip
    the chart to nothing; the predictive span always carries the model's
    latency reach. This reproduces the former ``max(calendar, t95)`` display
    horizon (which read t95 off ``resolved.latency``, the same model latency)
    but sourced from the composed span, so the window/cohort distinction is
    latent in the composition rather than a ``resolve_model_params`` mode
    branch. Floored at the observed calendar reach so the evidence range is
    never clipped, capped at the composition ceiling, and fully overridden by
    an explicit FE ``axis_tau_max`` (chart-settings contract: nothing
    specified → auto/latent; user specified → use it).
    """
    # Model-latency reach (t95) from the unconditioned predictive composed
    # span. The predictive overlay is always built and the model CDF always
    # carries mass (asymptote > 0), so the reach reads straight through:
    # mean_cdf[-1] == asymptote, which always clears 0.95·asymptote, so the
    # last index qualifies and the nonzero set is non-empty.
    overlay = runtime.unconditioned_overlays['predictive']
    cdf = _strict_span_request_cdf_draws(overlay.subject, overlay.carrier, horizon=cap)
    mean_cdf = np.nanmean(cdf, axis=0)
    asymptote = float(mean_cdf[-1])
    t95 = int(np.nonzero(mean_cdf >= 0.95 * asymptote)[0][0])
    # axis_tau_max is an extend-only hint (former max_tau semantics): it raises
    # the floor when the FE wants a wider axis, never shrinks the reach. `or 0`
    # makes the absent case a no-op.
    extent = max(floor, t95, int(axis_tau_max or 0))
    return max(0, min(extent, cap))


def _root_window_carrier_n_by_anchor_day(
    candidates: Optional[Sequence[Any]],
    anchor_node_id: Optional[str],
) -> Dict[str, float]:
    """Per-anchor-day root-window n from the first carrier primitive
    rooted at A.

    Active `cohort(A, X-end)` selected base mass per Phase 3 of
    `docs/current/cohort-maturity-selected-cohort-projection-pattern.md`:
    the only admissible source for `a_pop` per selected A-anchor day is
    the root-window evidence on the first carrier primitive (the edge
    whose from-node is the anchor `A`). Its `n` per anchor day is the
    count that entered A on that day.

    Reads the canonical flat request candidate pool
    (`runtime.request_evidence_candidates`). Picks candidates whose
    primitive subject starts at the anchor and groups candidate `n` by
    `coordinate.observed_date` taking the maximum.

    Filters candidates by the semantic slice family only — root-window
    evidence — and does not inspect downstream source family. Evidence
    source/deduping complexity is owned by the superset interface;
    `_aggregate_request_candidates` has already deduped the pool by
    `(source, identity, coordinate, n, k)` before the runtime is built,
    so this function does no further dedup.

    Returns an empty dict when the inputs are missing or no candidate
    has a `subject_from` matching the anchor; callers must treat empty
    (or missing-keys) as "no admissible base mass" and exclude that
    cohort from active projection rather than fall back to frame-bundle
    `a`.
    """
    from evidence_merge import SliceFamily

    result: Dict[str, float] = {}
    if not candidates or not anchor_node_id:
        return result
    anchor_str = str(anchor_node_id)
    for cand in candidates:
        if cand is None:
            continue
        ident = getattr(cand, 'identity', None)
        if ident is None:
            continue
        if str(getattr(ident, 'subject_from', '')) != anchor_str:
            continue
        if getattr(ident, 'slice_family', None) is not SliceFamily.WINDOW:
            continue
        coord = getattr(cand, 'coordinate', None)
        if coord is None:
            continue
        obs_date = str(getattr(coord, 'observed_date', '') or '')[:10]
        if not obs_date:
            continue
        try:
            n_float = float(getattr(cand, 'n', 0))
        except (TypeError, ValueError):
            continue
        if n_float <= 0:
            continue
        if n_float > result.get(obs_date, 0.0):
            result[obs_date] = n_float
    return result


def _selected_anchor_day(
    anchor_day: str,
    anchor_from: str,
    anchor_to: str,
) -> bool:
    try:
        ad = _date.fromisoformat(str(anchor_day)[:10])
        af = _date.fromisoformat(str(anchor_from)[:10])
        at = _date.fromisoformat(str(anchor_to)[:10])
    except (TypeError, ValueError):
        return False
    return af <= ad <= at


def _runtime_role_edge_ids(
    runtime: ResolvedCFRuntime,
    role: str,
) -> Optional[set[str]]:
    provenance = runtime.runtime_provenance
    if not isinstance(provenance, Mapping):
        return None
    primitives = provenance.get('primitives')
    if not isinstance(primitives, Mapping):
        return None
    if role not in primitives:
        return None
    entries = primitives.get(role) or ()
    edge_ids: set[str] = set()
    for entry in entries:
        if not isinstance(entry, Mapping):
            continue
        edge_id = entry.get('edge_id')
        if edge_id:
            edge_ids.add(str(edge_id))
    return edge_ids


def _terminal_primitive_for_destination(
    primitives: Sequence[ConditionedTransitionPrimitive],
    destination_node: Optional[str],
) -> Optional[ConditionedTransitionPrimitive]:
    if destination_node is None:
        return None
    dest = str(destination_node)
    for primitive in primitives:
        transition = getattr(primitive, 'transition', None)
        if str(getattr(transition, 'destination_node', '')) == dest:
            return primitive
    return None


def _parse_date_prefix(value: Any) -> Optional[_date]:
    if value is None:
        return None
    raw = str(value)[:10]
    if not raw:
        return None
    try:
        return _date.fromisoformat(raw)
    except (TypeError, ValueError):
        return None


def _analysis_observation_frontier_date(
    *,
    per_edge_results_by_uuid: Optional[Mapping[str, Mapping[str, Any]]] = None,
    as_at: Optional[str],
) -> Optional[str]:
    """One query-wide frontier from admitted evidence-superset rows.

    Rule: first choose the latest real evidence date from the admitted
    evidence superset (`snapshot_date`, `data_retrieved_at`, `retrieved_at`);
    then cap by explicit `asat` or today. Virtual/carry-forward frames are
    intentionally ignored because their grid dates are display materialisation,
    not observation support. Multiple selected Cohorts spread only when this
    one date is converted to per-anchor τ downstream.
    """
    cap = _parse_date_prefix(as_at) or _date.today()
    latest_evidence_date: Optional[_date] = None

    def _record(value: Any) -> None:
        nonlocal latest_evidence_date
        day = _parse_date_prefix(value)
        if day is None:
            return
        if day > cap:
            day = cap
        if latest_evidence_date is None or day > latest_evidence_date:
            latest_evidence_date = day

    for entry in (per_edge_results_by_uuid or {}).values():
        if not isinstance(entry, Mapping):
            continue
        for row in entry.get('evidence_superset_rows') or ():
            if not isinstance(row, Mapping):
                continue
            _record(row.get('snapshot_date'))
            _record(row.get('data_retrieved_at'))
            _record(row.get('retrieved_at'))

    return latest_evidence_date.isoformat() if latest_evidence_date else None


def _cell_source_provenance(
    *,
    carrier_primitives: Sequence[ConditionedTransitionPrimitive],
    subject_primitives: Sequence[ConditionedTransitionPrimitive],
    diagnostics: Mapping[str, Any],
    pairing_decision: str,
    emit_diagnostics: bool = False,
) -> Mapping[str, Any]:
    def _edge_ids(primitives: Sequence[ConditionedTransitionPrimitive]) -> List[str]:
        return [
            str(getattr(getattr(primitive, 'transition', None), 'edge_id', ''))
            for primitive in primitives
            if getattr(getattr(primitive, 'transition', None), 'edge_id', None)
        ]

    def _binding_policies(
        primitives: Sequence[ConditionedTransitionPrimitive],
    ) -> List[Any]:
        policies: List[Any] = []
        for primitive in primitives:
            weighted = getattr(primitive, 'weighted_evidence', None)
            policies.append(
                getattr(weighted, 'binding_policy', None)
                if weighted is not None else None
            )
        return policies

    return {
        'clock_adapter': 'selected_a_clock.prefix_arrival_topology_composer.v1',
        'denominator_edge_ids': _edge_ids(carrier_primitives),
        'numerator_edge_ids': _edge_ids(subject_primitives),
        'denominator_binding_policies': _binding_policies(carrier_primitives),
        'numerator_binding_policies': _binding_policies(subject_primitives),
        'pairing_decision': pairing_decision,
        # Per-cell diagnostics replicate both surface provenances; large enough
        # to overflow V8's max string length on multi-hop. Emit only with --diag.
        **({'diagnostics': dict(diagnostics)} if emit_diagnostics else {}),
    }


def _runtime_completeness(
    runtime: ResolvedCFRuntime,
    *,
    cohort_eval_ages: Sequence[int],
    cohort_weights: Sequence[float],
    horizon: int,
) -> tuple[float, float, np.ndarray]:
    """N-weighted mean and SD of the request-rooted CDF at each Cohort's
    eval_age, plus the per-Cohort array the scalar reduces.

    The weighted scalar mean is ``Σ_i w_i · per_cohort[i] / Σ_i w_i``. A
    zero-population request (``Σ w_i == 0``, e.g. the query-scoped
    degradation fixture) degenerates to uniform weighting — the limit of the
    weighted mean as the weights flatten — so the scalar is the unweighted
    per-Cohort mean, not 0/0. ``+ float(Σw == 0)`` is bool-as-arithmetic: it
    adds nothing when there is population and a flat 1 per Cohort when there
    is none, so the reduction is always defined with no branch.
    """
    cdf = _runtime_request_cdf_draws(runtime, horizon=horizon)
    weights = np.asarray(cohort_weights, dtype=np.float64)
    weights = weights + float(weights.sum() == 0.0)
    per_cohort_per_draw = cdf[:, np.asarray(cohort_eval_ages, dtype=np.int64)]
    per_cohort = per_cohort_per_draw.mean(axis=0)
    weighted_per_draw = (weights * per_cohort_per_draw).sum(axis=1) / weights.sum()
    return (
        float(weighted_per_draw.mean()),
        float(weighted_per_draw.std()),
        per_cohort,
    )


def _anchor_day_key(anchor_day: Any) -> str:
    """Canonical ``YYYY-MM-DD`` key for a selected-Cohort anchor day."""
    return (
        anchor_day.isoformat() if hasattr(anchor_day, 'isoformat')
        else str(anchor_day or '')[:10]
    )


@dataclass(frozen=True)
class SelectedRetrievalFrontier:
    """Per-anchor selected retrieval frontier τ for the selected Cohort set.

    Behaviour-preserving replacement for the frontier surface that used to
    be read off ``SelectedAClockEvidence`` via
    ``frontier_tau_bounds(use_retrieval_frontier=True)`` and
    ``prefixes_for_cohorts(...).frontier_age``. Those were thin wrappers
    that turned **one** query-wide ``analysis_observation_frontier_date``
    into per-anchor τ (``_observation_frontier`` preference 1). The
    frontier date itself (``_analysis_observation_frontier_date``) is
    computed directly from the admitted ``evidence_superset_rows`` and is
    independent of any deleted legacy authority, so this surface owns no
    new arithmetic — it is the same date mapped to each anchor's age.

    ``paired_frontier_by_anchor[anchor_key]`` = ``(frontier_date − anchor).days``
    for every selected Cohort that carries real frame observations (i.e.
    not the empty-frames ``tau_observed = -1`` sentinel — those have no
    observation support, matching the legacy "no cells → excluded" gate).
    ``bounds`` is ``(min, max)`` of those τ — the row epoch boundaries.
    Both are empty / ``None`` when no admitted-evidence frontier exists
    (``frontier_date`` is ``None``); callers then keep their frame-derived
    fallbacks. This is **not** a per-row ``retrieved_at`` support trace —
    that would change today's snapshot_date / data_retrieved_at /
    retrieved_at query-wide frontier semantics.
    """

    paired_frontier_by_anchor: Mapping[str, int]
    bounds: Optional[Tuple[int, int]]


def _build_selected_retrieval_frontier(
    *,
    analysis_observation_frontier_date: Optional[str],
    cohort_list: Sequence[Mapping[str, Any]],
) -> SelectedRetrievalFrontier:
    """Map the one query-wide frontier date to per-anchor τ.

    Reproduces ``SelectedAClockEvidence._observation_frontier`` preference
    1: ``(frontier_date − anchor).days``. Empty-frames sentinel cohorts
    (``tau_observed == -1``) carry no observation support and contribute
    no frontier — matching the legacy "anchor has no cells → excluded
    from frontier_tau_bounds" gate.
    """
    if not analysis_observation_frontier_date:
        return SelectedRetrievalFrontier(paired_frontier_by_anchor={}, bounds=None)
    try:
        frontier_d = _date.fromisoformat(
            str(analysis_observation_frontier_date)[:10],
        )
    except (TypeError, ValueError):
        return SelectedRetrievalFrontier(paired_frontier_by_anchor={}, bounds=None)
    per_anchor: Dict[str, int] = {}
    for ci in cohort_list:
        tau_obs = ci.get('tau_observed')
        if isinstance(tau_obs, (int, float)) and int(tau_obs) < 0:
            continue
        anchor_key = _anchor_day_key(ci['anchor_day'])
        try:
            anchor_d = _date.fromisoformat(anchor_key)
        except (TypeError, ValueError):
            continue
        per_anchor[anchor_key] = (frontier_d - anchor_d).days
    bounds = (
        (min(per_anchor.values()), max(per_anchor.values()))
        if per_anchor else None
    )
    return SelectedRetrievalFrontier(
        paired_frontier_by_anchor=per_anchor,
        bounds=bounds,
    )


def _build_selected_cohort_inputs(
    engine_cohorts: Sequence[Any],
    cohort_list: Sequence[Mapping[str, Any]],
    n_by_anchor: Mapping[str, float],
    retrieval_frontier_by_anchor: Mapping[str, int],
) -> Sequence[Mapping[str, Any]]:
    """Perimeter shape for the row reducer (Phase 6 §5.2).

    Two distinct base-mass fields per cohort, branchless in the engine:

      * ``N_anchor`` — **observed** root-window evidence mass for this
        anchor day. Sourced from ``n_by_anchor`` (the root-window carrier
        candidate count). Zero when no admissible root-window evidence
        exists. Feeds the empirical trace; the engine's contract is
        ``emp_x = N_anchor`` (see ``test_strict_evidence_x_window_mode_equals_cohort_size``).
      * ``N_pop`` — **population** mass for model and FC projection.
        Sourced from ``engine_cohort.a_pop`` — equal to ``N_anchor`` for
        observed cohorts, set to ``1.0`` for empty-frames cohorts
        (unit-prior Bayesian degeneracy), zero for cohorts with no
        admissible evidence and no empty-frames sentinel. Feeds the
        conditioned model trace AND the FC future-root injection.

    Different regimes enter as different numbers, not different routes:

      observed cohort:        N_anchor = n_root,  N_pop = n_root
      empty-frames cohort:    N_anchor = 0,       N_pop = 1
      excluded cohort:        N_anchor = 0,       N_pop = 0

    Admission gates on ``N_pop > 0`` (the population must have mass for
    the projection to do anything). Cohorts with ``N_pop = 0`` are
    excluded — both empirical and model surfaces would publish zero
    everywhere.
    """
    inputs: List[Mapping[str, Any]] = []
    for ec, ci in zip(engine_cohorts, cohort_list or ()):
        anchor_day_key = ci['anchor_day'].isoformat()
        n_pop = float(getattr(ec, 'a_pop', 0.0) or 0.0)
        if n_pop <= 0.0:
            continue
        n_anchor = float(n_by_anchor.get(anchor_day_key, 0.0) or 0.0)
        tau_max_int = int(ci.get('tau_max') or 0)
        # Per-Cohort frontier f_c. The selected retrieval frontier (one
        # query-wide analysis observation date mapped to this anchor's
        # age) is authoritative when present. The frame-derived
        # cohort_list['tau_observed'] is NOT used as the frontier here:
        # frame composition drops per-Cohort retrieval provenance and
        # collapses to 0 for multi-hop window(), which would prefix-pin
        # FC continuation to the wrong frontier. The empty-frames
        # sentinel (-1) carries no observation and is preserved so the
        # spine projects from the unit prior.
        frame_tau_obs = ci.get('tau_observed')
        if isinstance(frame_tau_obs, (int, float)) and int(frame_tau_obs) < 0:
            tau_obs_int = -1
        else:
            frontier_tau = retrieval_frontier_by_anchor.get(anchor_day_key)
            if frontier_tau is not None:
                tau_obs_int = min(max(int(frontier_tau), 0), tau_max_int)
            elif isinstance(frame_tau_obs, (int, float)):
                tau_obs_int = int(frame_tau_obs)
            else:
                tau_obs_int = tau_max_int
        inputs.append({
            'anchor_day': anchor_day_key,
            'N_anchor': n_anchor,
            'N_pop': n_pop,
            'tau_max': tau_max_int,
            'tau_observed': tau_obs_int,
        })
    return inputs


# ── Shared FC-draw quantilers (73q Phase 3) ─────────────────────────────
# The tau reducer's per-τ `_quantiles` (cohort_maturity) and the date
# reducer's `forecast_bands` / `latency_bands` (daily_conversions) must
# emit identical band geometry from the same FC rate draws. These small
# NaN-aware reductions over a 1-D draw slice are the one definition both
# read, so neither reducer reimplements the quantile math. They mirror the
# established all-NaN→None contract (a rate cell is undefined where
# X_total = 0); no clip, no `or 0.0` — undefined propagates as None.

#: Forecast-band confidence levels emitted on `forecast_bands` rows. This
#: is the set the tau reducer already produces (CF_ROW_PIPELINE §5); 73q
#: does not redefine it.
_FORECAST_BAND_LEVELS = (0.80, 0.90, 0.95, 0.99)

#: Confidence levels carried on a forecast-side `latency_bands` entry —
#: the legacy daily-conversions public shape (api_handlers.py).
_LATENCY_FORECAST_BAND_LEVELS = (0.80, 0.90)


def _forecast_rate_bands(rate_draws_1d, band_levels):
    """NaN-aware confidence bands for a 1-D rate-draw slice.

    Returns ``{'<pct>': [lo, hi]}`` keyed by band level, or ``None`` when
    every draw is NaN (the rate is undefined at this slice — X_total = 0).
    Quantiles are the same ``(1 ± bl) / 2`` pair the tau reducer uses.
    """
    d = np.asarray(rate_draws_1d, dtype=np.float64)
    if not np.isfinite(d).any():
        return None
    return {
        str(int(bl * 100)): [
            float(np.nanquantile(d, (1 - bl) / 2)),
            float(np.nanquantile(d, (1 + bl) / 2)),
        ]
        for bl in band_levels
    }


def _nan_mean_or_none(draws_1d):
    """Mean of a 1-D draw slice, or ``None`` when every draw is NaN."""
    d = np.asarray(draws_1d, dtype=np.float64)
    return float(np.nanmean(d)) if np.isfinite(d).any() else None


def _nan_median_or_none(draws_1d):
    """Median of a 1-D draw slice, or ``None`` when every draw is NaN."""
    d = np.asarray(draws_1d, dtype=np.float64)
    return float(np.nanmedian(d)) if np.isfinite(d).any() else None


def _project_runtime_rows(
    *,
    runtime: ResolvedCFRuntime,
    selected_projection: 'model_span_spine.SelectedCohortRowProjection',
    cohort_eval_ages: Sequence[int],
    cohort_weights: Sequence[float],
    max_tau: int,
    tau_solid_max: int,
    tau_future_max: int,
    sweep_to: str,
    band_level: float,
    emit_diagnostics: bool = False,
) -> List[Dict[str, Any]]:
    """Build chart rows from the runtime's composed objects + observed
    evidence.

    Three composed surfaces feed the row schema. Terminology follows the
    frontier-conditioned chart surface proposal, Appendix B (E, F, and
    E+F name display modes only; ``ef_*`` / ``f_*`` / overlay name
    internal surfaces):

      - ``midpoint`` / ``fan_*`` / ``fan_bands`` (forecast layer in E+F
        mode): the FC (frontier-conditioned) continuation surface
        ``ef_*`` produced by the spine. Prefix-pinned to strict evidence
        through each Cohort's frontier; predictive fan opens only after
        the frontier.
      - ``model_midpoint`` / ``model_fan_*`` / ``model_bands`` (F mode):
        the unspliced query-conditioned model surface ``f_*`` produced
        by the spine on the epistemic operator basis. F mode renders
        this surface.
      - ``model_curve_midpoint`` / ``model_curve_*`` / ``model_curve_bands``:
        the **optional model overlay** — the existing unconditioned
        model curve with epistemic bands, sourced from
        ``runtime.unconditioned_overlays.get('epistemic')``. Not a
        display mode (per Appendix B); rendered as an explicit overlay
        when the caller opts in via the display setting. Absent when
        the caller did not request the overlay.

    No trajectory engine, no per-cohort IS splice — the request-scoped
    primitive registry has already conditioned everything that should
    move the rate."""
    band_levels = [0.80, 0.90, 0.95, 0.99]

    def _overlay_rate_draws(basis: str) -> Optional[np.ndarray]:
        overlay = runtime.unconditioned_overlays.get(basis)
        if overlay is None:
            return None
        return _strict_span_model_rate_draws(
            overlay.subject, overlay.carrier, horizon=max_tau,
        )

    # 73q Phase 2: ``selected_projection`` is pre-built by
    # ``build_cf_projection_bundle`` at ``fe.saturation_tau`` (the spine's
    # single mode-blind reducer — one operator-supply pass per family,
    # one DP core, one division). This row builder reads it through
    # ``fe.max_tau`` only: the loop below runs ``range(max_tau + 1)``, and
    # the spine pads/forward-fills beyond the grid, so projecting at the
    # larger saturation horizon leaves every τ ≤ max_tau value unchanged —
    # public cohort-maturity rows are identical to projecting at max_tau.
    # Atom 6: midpoint / fan_* / fan_bands / projected_rate read the
    # FC (frontier-conditioned) continuation surface `ef_rate_draws`,
    # not the legacy spliced surface. `ef_*` is prefix-pinned to strict
    # evidence through each Cohort's frontier and continues only the
    # unresolved future on the predictive operator basis, so at
    # τ ≤ frontier the per-draw rate equals the strict empirical rate
    # (fan width = 0); after the frontier the fan opens from the
    # residual continuation. F mode keeps `f_*` (unspliced
    # query-conditioned model) — that is a different surface and is
    # mapped to `model_*` row fields below.
    rate_draws = selected_projection.ef_rate_draws
    _selected_cohort_diag = None
    epi_rate_draws = _overlay_rate_draws('epistemic')

    completeness_mean, completeness_sd, _ = _runtime_completeness(
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
        # NaN cells flag (s, τ) where the rate is undefined (X_total = 0).
        # If every particle is NaN, the row contributes None; otherwise
        # the valid particles drive the per-τ quantiles.
        if not np.isfinite(d).any():
            return None, None, None, None, None
        mid = float(np.nanmedian(d))
        upper = float(np.nanquantile(d, (1 + band_level) / 2))
        lower = float(np.nanquantile(d, (1 - band_level) / 2))
        # Shared with the date reducer's forecast_bands (73q Phase 3) so
        # both consumers emit identical band geometry from one definition.
        bands = _forecast_rate_bands(d, band_levels)
        return mid, upper, lower, bands, float(np.nanmean(d))

    def _draw_mean(draws_2d: Optional[np.ndarray], tau: int):
        if draws_2d is None or tau >= draws_2d.shape[1]:
            return None
        d = draws_2d[:, tau]
        if not np.isfinite(d).any():
            return None
        return float(np.nanmean(d))

    rows: List[Dict[str, Any]] = []
    for tau in range(max_tau + 1):
        # Evidence-named row fields come from the empirical operator's
        # strict value stream. Model surfaces come from the conditioned
        # operator's value stream. Coverage is now simple Cohort
        # applicability for display alpha, not a DP mask/support ratio.
        evidence_x_tau: Optional[float] = float(selected_projection.evidence_x_strict[tau])
        evidence_y_tau: Optional[float] = float(selected_projection.evidence_y_strict[tau])
        rate: Optional[float] = float(selected_projection.rate_strict[tau])
        rate_pure: Optional[float] = rate
        n_mature = int(selected_projection.applicable_cohort_count[tau])

        coverage_tau: Optional[float] = float(
            selected_projection.applicability_row[tau],
        )

        midpoint, fan_upper_val, fan_lower_val, fan_bands, projected_rate = (
            _quantiles(rate_draws, tau)
        )
        # FC plan Atom 1: `model_midpoint` / `model_fan_*` / `model_bands`
        # carry the **unspliced conditioned model surface** (F mode) —
        # `selected_projection.f_rate_draws` on the epistemic operator
        # basis. The unconditioned predictive overlay that previously
        # occupied these fields is no longer surfaced. The optional
        # model overlay (Appendix B: unconditioned model curve with
        # epistemic bands; not a display mode) lives on under
        # `model_curve_*` and is gated by the caller's display setting.
        model_midpoint, model_fan_upper, model_fan_lower, model_bands, _ = (
            _quantiles(selected_projection.f_rate_draws, tau)
        )
        (
            model_curve_midpoint,
            model_curve_fan_upper,
            model_curve_fan_lower,
            model_curve_bands,
            _,
        ) = _quantiles(epi_rate_draws, tau)

        # forecast_y / forecast_x are future-only residuals per the
        # canonical chart contract (cohort-maturity-forecast-design.md,
        # project-db/2-time-series-charting.md, selected-a-clock-evidence-
        # clock-adapter-plan.md): the FE stacks `forecast_y` above
        # `evidence_y` as the "crown" component, and the tooltip surfaces
        # `forecast n=${forecast_x}, k=${forecast_y} (${rate})` where the
        # forecast rate is meaningful only when both are future-only.
        #
        # Atom 6: these come directly from the FC continuation's future
        # residual surfaces `ef_forecast_x` / `ef_forecast_y` (defined
        # as `ef_x − strict_x` / `ef_y − strict_y` by the spine). The
        # legacy post-hoc subtraction
        # `max(0, projected − evidence_strict)` is gone — the residual
        # is now produced by the frontier-continuation DP, not
        # reconstructed at row-projection time. Negative residuals
        # would be a frontier-ledger conservation defect; the engine
        # surfaces them rather than clamping. The spine builds these
        # continuation residuals mode-blind (model_span_spine.py:2017 —
        # `future_*_cont.sum(axis=0)`, no mode fork), so the reducer reads
        # them directly: window / A=X / active-carrier are degeneracies of
        # one surface. `_draw_mean` returns None only when the continuation
        # is genuinely undefined (all-NaN draws), not as a mode signal.
        forecast_y_tau = _draw_mean(selected_projection.ef_forecast_y, tau)
        forecast_x_tau = _draw_mean(selected_projection.ef_forecast_x, tau)

        # Midpoint and fan emit across all epochs (A/B/C) so consumers
        # asserting the per-cohort calibrated E+F surface have values at
        # every τ. Display is owned by the chart layer: the FE filters
        # midpoint+fan draws to τ ≥ tau_solid_max so they only render in
        # epochs B/C where they actually add information (in A they
        # coincide with the solid E line and would double-draw).
        # Reducer emits everything it can compute; the chart picks.

        rows.append({
            'tau_days': tau,
            'rate': rate,
            'rate_pure': rate_pure,
            'evidence_y': evidence_y_tau,
            'evidence_x': evidence_x_tau,
            'coverage': coverage_tau,
            'projected_rate': projected_rate,
            'forecast_y': forecast_y_tau,
            'forecast_x': forecast_x_tau,
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
            'cohorts_covered_base': n_mature,
            'cohorts_covered_projected': n_mature,
            'completeness': completeness_mean,
            'completeness_sd': completeness_sd,
            'p_infinity_mean': p_infinity_mean,
            'p_infinity_sd': p_infinity_sd,
            'p_infinity_sd_epistemic': p_infinity_sd_epistemic,
        })
    if rows and _selected_cohort_diag is not None:
        rows[0]['_selected_cohort_projection'] = _selected_cohort_diag
    if emit_diagnostics and rows:
        rows[0]['_row_evidence_source'] = {
            'evidence_x': (
                'model_span_spine.project_selected_cohort_rows.'
                'evidence_x_strict'
            ),
            'evidence_y': (
                'model_span_spine.project_selected_cohort_rows.'
                'evidence_y_strict'
            ),
            'rate': 'model_span_spine.project_selected_cohort_rows.rate_strict',
            'note': (
                'Production row evidence fields are emitted from the '
                'empirical spine selected_projection, not from '
                'SelectedAClockEvidence.'
            ),
        }
        rows[0]['_empirical_spine_diagnostics'] = dict(
            selected_projection.diagnostics or {},
        )
    return rows


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
    max_tau: int                   # display range (rows, chart x-axis)
    saturation_tau: int            # internal sweep horizon / fallback support
    tau_solid_max: int
    tau_future_max: int
    last_frame_date: Optional[_date] = None


def build_cohort_evidence_from_frames(
    frames: List[Dict[str, Any]],
    anchor_from: str,
    anchor_to: str,
    sweep_to: str,
    axis_tau_max: Optional[int] = None,
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
            tau_max_c = (last_frame_date - ad).days if last_frame_date else 0
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
            # Synthesised default: no frame data at all. tau_max is the
            # cohort's calendar age at sweep_to (the question the chart is
            # asking the model to answer). Setting tau_max=0 here would
            # collapse the "applicable at τ" set to zero for every τ>0 in
            # downstream consumers — making the no-evidence chart
            # degenerate to nothing. The right shape is: applicable
            # everywhere up to the cohort's calendar age, observations
            # nowhere (`tau_observed = -1` sentinel; engine_cohort build
            # propagates this as `frontier_age = -1`, which makes the
            # selected-cohort projection's observed-prefix loop iterate
            # zero times and the future arm cover the entire τ range
            # from τ=0 against the prior — natural Bayesian degeneracy).
            cohort_info[ad.isoformat()] = {
                'x_frozen': 0.0,
                'y_frozen': 0.0,
                'a_frozen': 1.0,
                'tau_max': max((sweep_to_d - ad).days, 0),
                'tau_observed': -1,
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
            cohort_at_tau[ad_str][tau] = (
                float(x_val),
                float(y_val),
                dp.get('data_retrieved_at'),
            )

    # ── tau_observed per cohort ────────────────────────────────────
    # Canonical formula (DATE_MODEL_COHORT_MATURITY.md §2.3):
    #   tau_observed = min(
    #       max((data_retrieved_at − anchor_day).days
    #           for cells with non-null provenance),
    #       tau_max,
    #   )
    # The per-cell `data_retrieved_at` is the min-across-contributing-
    # slices timestamp produced by cohort_maturity_derivation.py:185-193
    # (conservative least-recent contributor). Per-cohort reduction is
    # the max over that cohort's cells. Forbidden: `last_frame_date −
    # anchor_day` is an alias for `(sweep_to − anchor_to)`, which §2.2
    # of the canonical doc explicitly forbids as a frontier proxy. The
    # no-provenance fallback below is a documented LOSSY lower-bound
    # (see cohort-maturity-frontier-from-data-retrieved-at.md §6).
    for ad_str, ci in cohort_info.items():
        ad_d = ci['anchor_day']
        cells = cohort_at_tau.get(ad_str, {})
        tau_obs = 0
        provenance_seen = False
        for cell in cells.values():
            ret_str = cell[2] if len(cell) >= 3 else None
            if not ret_str:
                continue
            try:
                ret_d = _date.fromisoformat(str(ret_str)[:10])
            except (ValueError, TypeError):
                continue
            provenance_seen = True
            delta = (ret_d - ad_d).days
            if delta > tau_obs:
                tau_obs = delta
        if not provenance_seen and cells:
            # Lossy lower-bound: largest τ where y strictly exceeds the
            # previous y in τ order (treating the implicit pre-first-
            # cell baseline as 0). Documented failure modes:
            #   - all-zero-y cohorts return 0 (frontier under-stated)
            #   - post-conversion plateaus return τ of last conversion,
            #     not τ of last retrieval
            # Both bite covered-zero cohorts. Audit B confirms
            # data_retrieved_at is preserved end-to-end in production;
            # this branch is defensive cover for malformed inputs only.
            prev_y = 0.0
            for tau_c in sorted(cells.keys()):
                y_c = float(cells[tau_c][1])
                if y_c > prev_y and tau_c > tau_obs:
                    tau_obs = tau_c
                prev_y = y_c
        # Empty-frames synthesis sets `tau_observed: -1` upstream as a
        # "no observations recorded" sentinel; with no cells to derive
        # from, preserve that sentinel so the engine_cohort build keeps
        # `frontier_age = -1`. Only overwrite when there is observation
        # signal (cells present) to update from.
        if cells or 'tau_observed' not in ci:
            ci['tau_observed'] = min(tau_obs, ci['tau_max'])

    # ── Build cohort_list and epoch boundaries ─────────────────────
    # tau_solid_max  : right edge of epoch A — the largest τ where every
    #                  selected Cohort is still observed. By definition this
    #                  is min(frontier_age) across cohorts (the shallowest
    #                  observed depth among the selected set). Using the
    #                  youngest cohort's frontier is wrong under per-cohort
    #                  staleness: an older cohort whose data hasn't been
    #                  refreshed lately can have a shallower real frontier
    #                  than the youngest, and the seam-collapse property of
    #                  the projection only holds at min(frontier).
    # tau_future_max : right edge of epoch B — calendar age of the oldest
    #                  cohort up to sweep_to. Owns the chart's epoch
    #                  boundary; must NOT be coupled to per-cohort
    #                  data_retrieved_at
    #                  (which can lag for individual anchors and would
    #                  invert the tau_solid_max ≤ tau_future_max invariant
    #                  the row builder and chart both rely on).
    cohort_list = sorted(cohort_info.values(), key=lambda c: c['anchor_day'])
    tau_solid_max = 0
    tau_future_max = max(0, (sweep_to_d - anchor_from_d).days)
    if cohort_list:
        tau_solid_max = min(
            int(c.get('tau_observed', c['tau_max']) or 0)
            for c in cohort_list
        )
    tau_future_max = max(tau_future_max, tau_solid_max)

    # ── Determine tau ranges ───────────────────────────────────────
    # max_tau         : display/row range — drives chart x-axis (unchanged).
    # saturation_tau  : internal sweep horizon — extends to 2*t95 (window)
    #                   or 2*path_t95 (cohort) so trajectory evaluation and
    #                   legacy scalar fallback have adequate support. It is
    #                   not a row-projection contract that midpoint equals
    #                   the public p_infinity scalar.
    #                   May exceed max_tau when path-level latency dominates
    #                   A→Y timing (cohort mode, multi-hop).
    # Display floor: the observed calendar reach (oldest cohort → sweep_to),
    # optionally raised by the FE override. The true chart extent is latent
    # on the conditioned span CDF and is resolved by build_cf_projection_
    # bundle after composition (_latent_chart_extent); this is only the floor
    # below which the evidence range is never clipped.
    max_tau = tau_future_max
    if axis_tau_max is not None and axis_tau_max > max_tau:
        max_tau = axis_tau_max
    max_tau = min(max_tau, 400)

    # Composition ceiling: a safe upper bound on reach so the conditioned,
    # population-root-rooted span CDF (read by the bundle to derive the latent
    # extent) is never truncated. No latency lookup and no temporal mode here
    # — the per-primitive composition is the cheap pass; the expensive
    # per-cohort projection is sized down to the latent extent by the bundle.
    saturation_tau = 400

    # Frame evidence is raw observed chart evidence only. Active A!=X
    # carrier semantics are owned by the primitive-backed runtime span;
    # this builder must not construct a carrier or alter public scalars.
    engine_cohorts: list = []
    materialised_cohort_list: List[Dict[str, Any]] = []
    for ci in cohort_list:
        raw_n_i = float(ci.get('x_frozen', 0.0) or 0.0)
        a_i = int(ci.get('tau_observed', ci['tau_max']) or 0)
        # Upper-bound clamp only — preserve the `tau_observed = -1`
        # sentinel (set by build_cohort_evidence_from_frames's empty-
        # frames synthesis) which encodes "no observations recorded".
        # Under that sentinel, `frontier_age = -1` propagates into the
        # selected-cohort projection: the observed-prefix loop iterates
        # zero times and the future arm covers τ=0..T-1 against the
        # prior, producing the natural Bayesian degeneracy. Loops below
        # gated on `t <= a_i` skip cleanly when a_i is -1.
        a_i = min(a_i, saturation_tau)
        a_pop = float(ci.get('a_frozen', raw_n_i) or raw_n_i or 1.0)
        ad_str = ci['anchor_day'].isoformat()
        tau_data = cohort_at_tau.get(ad_str, {})

        raw_obs_x = [0.0] * (saturation_tau + 1)
        raw_obs_y = [0.0] * (saturation_tau + 1)
        last_x = 0.0
        last_y = 0.0
        for t in range(saturation_tau + 1):
            if t <= a_i:
                obs = tau_data.get(t)
                if obs:
                    last_x = float(obs[0])
                    last_y = float(obs[1])
                raw_obs_x[t] = last_x
                raw_obs_y[t] = last_y
            else:
                raw_obs_x[t] = last_x if last_x > 0 else raw_n_i
                raw_obs_y[t] = last_y

        obs_x = raw_obs_x
        obs_y = raw_obs_y
        x_frozen = float(obs_x[a_i])
        y_frozen = float(obs_y[a_i])
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
            #
            # `eval_age` is clamped to >= 0 because completeness "at
            # frontier" is undefined when there is no frontier
            # (`frontier_age == -1` under empty-frames synthesis).
            # Splitting `frontier_age` (may be -1) from `eval_age`
            # (always >= 0) lets the projection's observed-prefix
            # logic see the no-observations sentinel while the
            # completeness consumer still gets a valid age to
            # evaluate against.
            eval_age=max(a_i, 0),
        ))

    if not engine_cohorts:
        return None

    return FrameEvidence(
        engine_cohorts=engine_cohorts,
        cohort_list=materialised_cohort_list,
        cohort_at_tau=dict(cohort_at_tau),
        max_tau=max_tau,
        saturation_tau=saturation_tau,
        tau_solid_max=tau_solid_max,
        tau_future_max=tau_future_max,
        last_frame_date=last_frame_date,
    )


def build_cf_projection_bundle(
    frames: List[Dict[str, Any]],
    graph: Dict[str, Any],
    target_edge_id: str,
    query_from_node: str,
    query_to_node: str,
    anchor_from: str,
    anchor_to: str,
    sweep_to: str,
    *,
    is_window: bool = True,
    axis_tau_max: Optional[int] = None,
    anchor_node_id: Optional[str] = None,
    is_multi_hop: bool = False,
    resolved_override: Any = None,
    evidence_candidates: Optional[List[Any]] = None,
    scenario_id: Optional[str] = None,
    as_at: Optional[str] = None,
    per_edge_upstream_candidates: Optional[Dict[str, Sequence[Any]]] = None,
    per_edge_subject_candidates: Optional[Dict[str, Sequence[Any]]] = None,
    per_edge_results_by_uuid: Optional[Dict[str, Dict[str, Any]]] = None,
    show_model_curve: bool = False,
    envelope_plan: Optional[Any] = None,
    context_key: Optional[str] = None,
    context_selector: Optional[str] = None,
    mece_dimensions: Sequence[str] = (),
):
    """Build the one shared CF projection bundle (73q Phase 2).

    Extracts the preparation/projection sequence that ``cohort_maturity``
    and ``daily_conversions`` both need: resolve model params, materialise
    frame evidence, build the ``ResolvedCFRuntime``, resolve base mass and
    the retrieval frontier, and project the selected-Cohort surfaces.

    The projection is built at ``fe.saturation_tau`` (not ``fe.max_tau``)
    so the date reducer can index per-Cohort FC draws at saturation; the
    tau reducer still emits public rows only through ``fe.max_tau`` (73q
    §"Saturation tau"). Scalar metadata (``cf_mode`` / ``cf_reason`` /
    ``promoted_source``) is read from the resolved model object, not from
    ``runtime_provenance``. Always returns a bundle: a missing edge,
    unresolvable model, malformed dates, or unbuildable runtime are
    upstream defects that fail visibly (I-12), not early-out refusals.
    """
    from .forecast_runtime import find_edge_by_id, get_cf_mode_and_reason
    from .cf_projection_bundle import CFProjectionBundle, latency_band_taus

    # No perimeter refusals. A missing edge, an unresolvable model, or
    # malformed/inverted request dates are upstream defects, not user
    # requests, and per I-12 must fail visibly rather than be masked as
    # empty rows: find_edge_by_id only misses on a graph/edge-id desync
    # (the maturity call is gated on an analysed-path edge id);
    # resolve_model_params returns a populated model even for an edge with
    # no `p` block (model_resolver.py:230-231); build_cohort_evidence_from_
    # frames returns None ONLY for malformed dates (its docstring), and a
    # genuine no-data request yields synthesised zero-observation cohorts.
    target_edge = find_edge_by_id(graph, target_edge_id)

    # Translate the mode flag to topology once, here at the engine's public
    # entry: the population root (the upstream anchor A for cohort, the
    # subject start X for window) and the model-resolution clock label.
    # Everything below — the runtime, the span resolver, the readout —
    # consumes these, never is_window.
    temporal_mode = 'window' if is_window else 'cohort'
    population_root = (
        str(anchor_node_id)
        if (anchor_node_id and not is_window)
        else str(query_from_node)
    )

    resolved = resolved_override if resolved_override is not None else (
        resolve_model_params(
            target_edge,
            scope='edge',
            temporal_mode=temporal_mode,
        )
    )
    _cf_mode, _cf_reason = get_cf_mode_and_reason(resolved)
    # Preserve the resolved model's source verbatim, including absence
    # (None / ''). The bundle field is Optional[str]; substituting a real
    # value like 'best_available' would assert a promoted source that did
    # not actually resolve (73q scalar-metadata contract: sourced from the
    # resolved object, never invented).
    _promoted_source = resolved.source

    fe = build_cohort_evidence_from_frames(
        frames=frames,
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        sweep_to=sweep_to,
        axis_tau_max=axis_tau_max,
    )

    request_candidates = _aggregate_request_candidates(
        target_candidates=evidence_candidates,
        per_edge_subject_candidates=per_edge_subject_candidates,
        per_edge_upstream_candidates=per_edge_upstream_candidates,
    )

    # Build the runtime at the SATURATION horizon. The composed spans
    # extend to fe.saturation_tau so the per-Cohort FC arrays cover it;
    # the tau reducer reads the same projection but emits only through
    # fe.max_tau (values at τ ≤ max_tau are unchanged by the larger grid).
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
        population_root=population_root,
        temporal_mode=temporal_mode,
        is_multi_hop=is_multi_hop,
        anchor_node_id=anchor_node_id,
        resolved=resolved,
        max_tau=fe.saturation_tau,
        evidence_candidates=request_candidates,
        unconditioned_overlay_bases=(
            ('predictive', 'epistemic') if show_model_curve else ('predictive',)
        ),
        envelope_plan=envelope_plan,
        context_key=context_key,
        context_selector=context_selector,
        mece_dimensions=tuple(mece_dimensions or ()),
    )

    # Per-anchor base mass + skip-reason provenance. ``_root_window_...``
    # returns {} for an empty candidate pool and the loop is a no-op when
    # there are no Cohorts, so neither needs a guard.
    # population_root is a ResolvedCFRuntime field set unconditionally to
    # query_from_node (or anchor_node_id in active mode) when the runtime
    # is built (forecast_runtime.py:243-245), so it always exists and is
    # the correct lookup root — no attribute-default or anchor_node_id
    # fallback is reachable. An empty root degrades to an empty n_by_anchor
    # (the lookup refuses), not a crash.
    n_by_anchor: Dict[str, float] = _root_window_carrier_n_by_anchor_day(
        runtime.request_evidence_candidates,
        str(runtime.population_root),
    )
    # Per-anchor base mass + skip reason, as arithmetic over two disjoint
    # 0/1 masks rather than a case fork. anchor_day is always a date
    # (build_cohort_evidence_from_frames calls ci['anchor_day'].isoformat()
    # on every entry, line 1893). n_by_anchor only stores strictly-positive
    # counts (_root_window_carrier_n_by_anchor_day, line 931), so a missing
    # anchor reads 0.0 and `present` is exactly "has root-window evidence".
    #   present  → a_pop = n_root (carrier mass)
    #   empty    → a_pop = its synthesised prior mass (empty-frames cohort)
    #   neither  → a_pop = 0 (frames exist, no root evidence)
    # a_pop = present·n_root + empty·prior; the two terms are exclusive.
    # The reason label is the same selection ranked into a tuple.
    ad_strs = [ci['anchor_day'].isoformat() for ci in fe.cohort_list]
    n_roots = np.array(
        [n_by_anchor.get(s, 0.0) for s in ad_strs], dtype=np.float64,
    )
    tau_obs = np.array(
        [int(ci.get('tau_observed', 0)) for ci in fe.cohort_list], dtype=np.int64,
    )
    a_pop_prior = np.array(
        [float(ec.a_pop) for ec in fe.engine_cohorts], dtype=np.float64,
    )
    present = n_roots > 0.0
    empty = ~present & (tau_obs < 0)
    a_pop_final = present * n_roots + empty * a_pop_prior
    for ec, value in zip(fe.engine_cohorts, a_pop_final):
        ec.a_pop = float(value)
    _A_POP_REASON = (
        'no_root_window_evidence', 'empty_frames_prior', 'root_window_carrier_n',
    )
    rank = present.astype(np.int64) * 2 + empty.astype(np.int64)
    a_pop_provenance: Dict[str, str] = {
        s: _A_POP_REASON[r] for s, r in zip(ad_strs, rank)
    }

    analysis_observation_frontier_date = _analysis_observation_frontier_date(
        per_edge_results_by_uuid=per_edge_results_by_uuid,
        as_at=as_at,
    )
    selected_retrieval_frontier = _build_selected_retrieval_frontier(
        analysis_observation_frontier_date=analysis_observation_frontier_date,
        cohort_list=fe.cohort_list,
    )
    # Strictly required: the selected retrieval frontier, when an admitted
    # evidence date resolved it, is authoritative for the row epoch
    # bounds; absent, the frame-derived bounds stand. Two genuine sources.
    # Two genuine sources: the frontier bounds when an admitted evidence date
    # resolved them, else the frame-derived bounds. A resolved frontier is
    # always a 2-tuple (truthy), so `or` coalesces — a value default, not a
    # control-flow branch.
    _solid, _future = (
        selected_retrieval_frontier.bounds
        or (fe.tau_solid_max, fe.tau_future_max)
    )
    row_tau_solid_max = int(_solid)
    row_tau_future_max = int(_future)

    # Completeness inputs on one clock, rooted at population_root (A in
    # cohort mode, X in window). Per COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_
    # SEMANTICS.md invariants 1 and 6, window/cohort/A=X are degeneracies of
    # one path, never a mode branch here — a `if window … else …` in this
    # projection layer is the leaking-abstraction smell the doc names.
    #   eval age = steps from the root to the observation frontier
    #     (the frontier τ per anchor; ec.eval_age is the per-cohort fallback
    #     when no query-wide frontier date resolved, and equals the former
    #     window arm's max(tau_observed, 0) by construction);
    #   weight   = population at the root (a_pop, set for every cohort by the
    #     loop above).
    # The removed _is_active_carrier window arm read (tau_observed,
    # evidence_n) — the pre-cutover proxy of exactly these two quantities.
    cohort_eval_ages = [
        max(int(selected_retrieval_frontier.paired_frontier_by_anchor.get(
            _anchor_day_key(ci['anchor_day']), ec.eval_age,
        )), 0)
        for ec, ci in zip(fe.engine_cohorts, fe.cohort_list)
    ]
    cohort_weights = [float(ec.a_pop) for ec in fe.engine_cohorts]

    # Chart extent latent on the conditioned span (composed at the
    # saturation ceiling above): the smallest τ at which the request CDF has
    # saturated, floored at the calendar reach, FE-overridable. The
    # expensive per-Cohort (C,S,T) projection is built at this latent extent,
    # not the ceiling, so window/cohort horizons emerge from the conditioned
    # data rather than a mode/latency lookup.
    latent_extent = _latent_chart_extent(
        runtime,
        floor=int(fe.max_tau),
        cap=int(fe.saturation_tau),
        axis_tau_max=axis_tau_max,
    )
    selected_cohort_inputs = _build_selected_cohort_inputs(
        fe.engine_cohorts,
        fe.cohort_list,
        n_by_anchor,
        selected_retrieval_frontier.paired_frontier_by_anchor,
    )
    selected_projection = model_span_spine.project_selected_cohort_rows(
        composed_carrier=runtime.composed_carrier,
        composed_subject=runtime.composed_subject,
        composed_carrier_predictive=runtime.composed_carrier_predictive,
        composed_subject_predictive=runtime.composed_subject_predictive,
        composed_empirical_carrier=runtime.composed_empirical_carrier,
        composed_empirical_subject=runtime.composed_empirical_subject,
        selected_cohorts=selected_cohort_inputs,
        horizon=latent_extent,
    )

    # Ordered per-Cohort projection status, aligned 1:1 with
    # fe.cohort_list. The projection's per-Cohort arrays are in ADMITTED
    # order (Cohorts with N_pop <= 0 are excluded by
    # _build_selected_cohort_inputs), so the date reducer needs an
    # explicit index map from each cohort_list row to its projection row
    # (or to a null projection with the skip reason). Built from the
    # admitted inputs in order — no second admission gate.
    admitted_index_by_anchor = {
        _anchor_day_key(inp['anchor_day']): idx
        for idx, inp in enumerate(selected_cohort_inputs)
    }
    cohort_projection_status = []
    for ci in fe.cohort_list:
        anchor_key = _anchor_day_key(ci['anchor_day'])
        cohort_projection_status.append({
            'anchor_day': anchor_key,
            'projection_index': admitted_index_by_anchor.get(anchor_key),
            'reason': a_pop_provenance.get(anchor_key),
        })

    # Per-Cohort completeness (the un-reduced view _runtime_completeness
    # returns alongside the scalar) at the same saturation horizon, and
    # the shared latency-band tau set.
    _, _, completeness_by_cohort = _runtime_completeness(
        runtime,
        cohort_eval_ages=cohort_eval_ages,
        cohort_weights=cohort_weights,
        horizon=fe.saturation_tau,
    )
    _lat = resolved.latency
    band_taus = latency_band_taus(_lat.mu, _lat.sigma, _lat.onset_delta_days)

    return CFProjectionBundle(
        frame_evidence=fe,
        runtime=runtime,
        selected_projection=selected_projection,
        selected_retrieval_frontier=selected_retrieval_frontier,
        n_by_anchor=n_by_anchor,
        a_pop_provenance=a_pop_provenance,
        cohort_eval_ages=cohort_eval_ages,
        cohort_weights=cohort_weights,
        cohort_projection_status=cohort_projection_status,
        completeness_by_cohort=completeness_by_cohort,
        latency_band_taus=band_taus,
        row_tau_solid_max=row_tau_solid_max,
        row_tau_future_max=row_tau_future_max,
        cf_mode=_cf_mode,
        cf_reason=_cf_reason,
        promoted_source=_promoted_source,
        saturation_tau=int(fe.saturation_tau),
        max_tau=int(latent_extent),
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
    evidence_candidates: Optional[List[Any]] = None,
    scenario_id: Optional[str] = None,
    as_at: Optional[str] = None,
    per_edge_upstream_candidates: Optional[Dict[str, Sequence[Any]]] = None,
    per_edge_subject_candidates: Optional[Dict[str, Sequence[Any]]] = None,
    per_edge_results_by_uuid: Optional[Dict[str, Dict[str, Any]]] = None,
    show_model_curve: bool = False,
    emit_diagnostics: bool = False,
    envelope_plan: Optional[Any] = None,
    context_key: Optional[str] = None,
    context_selector: Optional[str] = None,
    mece_dimensions: Sequence[str] = (),
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

    When the runtime cannot build a composition (missing primitives,
    refused edges) the public fields are left ``None`` and the row
    marks itself as degraded; this function never substitutes legacy
    aggregate timing or runs an aggregate-IS conditioning step.
    """
    # 73q Phase 2: the public row function is "build bundle → tau
    # reducer". The bundle owns the prep/projection sequence (resolve,
    # frame evidence, runtime, base mass, frontier) and builds the
    # selected-Cohort projection at fe.saturation_tau. The tau reducer
    # below emits public rows only through fe.max_tau.
    bundle = build_cf_projection_bundle(
        frames=frames,
        graph=graph,
        target_edge_id=target_edge_id,
        query_from_node=query_from_node,
        query_to_node=query_to_node,
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        sweep_to=sweep_to,
        is_window=is_window,
        axis_tau_max=axis_tau_max,
        anchor_node_id=anchor_node_id,
        is_multi_hop=is_multi_hop,
        resolved_override=resolved_override,
        evidence_candidates=evidence_candidates,
        scenario_id=scenario_id,
        as_at=as_at,
        per_edge_upstream_candidates=per_edge_upstream_candidates,
        per_edge_subject_candidates=per_edge_subject_candidates,
        per_edge_results_by_uuid=per_edge_results_by_uuid,
        show_model_curve=show_model_curve,
        envelope_plan=envelope_plan,
        context_key=context_key,
        context_selector=context_selector,
        mece_dimensions=mece_dimensions,
    )
    return reduce_cohort_maturity_rows(
        bundle,
        band_level=band_level,
        sweep_to=sweep_to,
        emit_diagnostics=emit_diagnostics,
    )


def reduce_cohort_maturity_rows(
    bundle: 'CFProjectionBundle',
    *,
    band_level: float,
    sweep_to: str,
    emit_diagnostics: bool,
) -> List[Dict[str, Any]]:
    """Tau reducer (cohort_maturity): reduce the shared CF projection
    bundle to per-tau rows.

    The sibling of the date reducer (``reduce_daily_conversions_rows``):
    both read the one ``CFProjectionBundle`` built by
    ``build_cf_projection_bundle``. This reducer keeps the tau axis and
    collapses Cohorts — one row per relative age through ``bundle.max_tau``
    — via ``_project_runtime_rows`` over the runtime/projection surfaces,
    then attaches public conditioning/provenance metadata. It owns no
    runtime semantics (COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS §9):
    every value is a readout of the already-resolved runtime object.
    """
    runtime = bundle.runtime

    rows = _project_runtime_rows(
        runtime=runtime,
        selected_projection=bundle.selected_projection,
        cohort_eval_ages=bundle.cohort_eval_ages,
        cohort_weights=bundle.cohort_weights,
        max_tau=bundle.max_tau,
        tau_solid_max=bundle.row_tau_solid_max,
        tau_future_max=bundle.row_tau_future_max,
        sweep_to=sweep_to,
        band_level=band_level,
        emit_diagnostics=emit_diagnostics,
    )

    rows = _attach_cf_row_metadata(
        rows,
        conditioning={'owner': 'primitive_conditioning'},
        conditioned=runtime.public_moments.p_mean is not None,
        cf_mode=bundle.cf_mode,
        cf_reason=bundle.cf_reason,
        runtime_provenance=runtime.project_runtime_provenance(),
    )
    if bundle.a_pop_provenance and rows:
        rows[0]['_a_pop_provenance'] = bundle.a_pop_provenance
    return rows


def reduce_daily_conversions_rows(
    bundle: 'CFProjectionBundle',
    observed: Dict[str, Any],
) -> Dict[str, Any]:
    """Date reducer (73q Phase 3): enrich ``derive_daily_conversions``
    output with per-Cohort FC projection fields from the shared bundle.

    The sibling of the tau reducer (``compute_cohort_maturity_rows_v3``):
    both read the one ``CFProjectionBundle``. This reducer keeps the
    Cohort axis and collapses tau — one ``rate_by_cohort`` row per Cohort,
    each field read at the contract-named bundle accessor and tau index
    (73q §"Reducer field contract"). It is a strict readout: no
    conditioning, no carrier/subject/completeness/latency-tau/FC-residual
    recomputation, no per-Cohort posterior (COHORT_…_SEMANTICS I-9).

    Observed ``date`` / ``x`` / ``y`` / ``rate`` and the response-level
    ``data`` / ``cohort_y_at_age`` / ``total_conversions`` / ``date_range``
    stay owned by ``derive_daily_conversions`` (``observed``); this reducer
    joins each observed row to its Cohort by ``anchor_day`` and adds the
    projection fields plus the bundle's scalar metadata.

    Per the saturation reconciliation (73q §"Saturation tau and latent
    extent" + Phase 2 close-out), "evaluated at saturation" reads the
    per-Cohort FC arrays at their terminal index ``bundle.max_tau`` (the
    latent extent): the predictive CDF has plateaued by its t95, so the
    terminal value is the saturation value, and the arrays carry no wider
    grid to index.

    Allowed conditionals (Phase 3 no-branch check pre-approves exactly
    these categories): projection status (admitted vs skipped Cohort),
    field availability (all-NaN draws → ``None``; ``band_tau`` beyond the
    FC array horizon → ``None`` with reason), and the evidence-vs-forecast
    latency-band display split (``eval_age ≥ band_tau``). There is no
    window/cohort/hop/identity mode fork — the reducer reads whatever the
    bundle resolved.
    """
    from .cf_projection_bundle import completeness_to_layer

    sp = bundle.selected_projection
    sat = int(bundle.max_tau)            # terminal FC-array index
    completeness_by_cohort = bundle.completeness_by_cohort
    eval_ages = bundle.cohort_eval_ages
    engine_cohorts = bundle.frame_evidence.engine_cohorts
    band_taus = bundle.latency_band_taus

    # cohort_list-order index + status per anchor_day. status's
    # projection_index points into the ADMITTED-order per-Cohort arrays;
    # the enumerate index `i` aligns with completeness_by_cohort /
    # cohort_eval_ages / engine_cohorts (all cohort_list order).
    status_by_date: Dict[str, tuple] = {
        entry['anchor_day']: (i, entry)
        for i, entry in enumerate(bundle.cohort_projection_status)
    }

    def _latency_bands(proj_idx: int, eval_age: int, ec: Any):
        bands_map: Dict[str, Any] = {}
        above_reasons: Dict[str, str] = {}
        for band_tau, label in band_taus:
            if band_tau > sat:
                # Beyond the FC array horizon: genuinely unavailable. No
                # clamp, no substitution — null with a recorded reason.
                bands_map[label] = None
                above_reasons[label] = 'band_tau_above_saturation'
            elif eval_age >= band_tau:
                # Evidence side: observed cumulative Y at band_tau over the
                # Cohort's frozen denominator. Single rate value.
                obs_rate = np.float64(ec.obs_y[band_tau]) / np.float64(ec.x_frozen)
                bands_map[label] = (
                    {'rate': float(obs_rate), 'source': 'evidence'}
                    if np.isfinite(obs_rate) else None
                )
            else:
                # Forecast side: per-Cohort FC rate draws at band_tau.
                d = sp.ef_rate_draws_by_cohort[proj_idx, :, band_tau]
                med = _nan_median_or_none(d)
                bands_map[label] = (
                    {
                        'rate': med,
                        'source': 'forecast',
                        'bands': _forecast_rate_bands(
                            d, _LATENCY_FORECAST_BAND_LEVELS,
                        ),
                    }
                    if med is not None else None
                )
        return bands_map, above_reasons

    enriched: List[Dict[str, Any]] = []
    for row in observed['rate_by_cohort']:
        out = dict(row)
        out['evidence_y'] = row.get('y')

        entry = status_by_date.get(row['date'])
        proj_idx = entry[1]['projection_index'] if entry is not None else None
        reason = entry[1]['reason'] if entry is not None else None
        provenance: Dict[str, Any] = {'reason': reason}

        if proj_idx is None:
            # Skipped Cohort (no admissible root-window carrier evidence)
            # or a date the bundle did not project: emit the observed row
            # with all projection fields null. The Cohort stays visible.
            out['projected_y'] = None
            out['projected_x'] = None
            out['forecast_y'] = None
            out['forecast_x'] = None
            out['projected_rate'] = None
            out['forecast_bands'] = None
            out['completeness'] = None
            out['layer'] = None
            out['latency_bands'] = None
        else:
            i = entry[0]
            # Forecast enrichment is terminal: evidence stays at the latest
            # frontier; FC count/rate fields read the terminal FC surfaces.
            rate_draws = sp.ef_rate_draws_by_cohort[proj_idx, :, sat]
            out['projected_x'] = _nan_mean_or_none(
                sp.ef_x_draws_by_cohort[proj_idx, :, sat],
            )
            out['projected_y'] = _nan_mean_or_none(
                sp.ef_y_draws_by_cohort[proj_idx, :, sat],
            )
            out['forecast_x'] = _nan_mean_or_none(
                sp.ef_forecast_x_by_cohort[proj_idx, :, sat],
            )
            out['forecast_y'] = _nan_mean_or_none(
                sp.ef_forecast_y_by_cohort[proj_idx, :, sat],
            )
            out['projected_rate'] = _nan_median_or_none(rate_draws)
            out['forecast_bands'] = _forecast_rate_bands(
                rate_draws, _FORECAST_BAND_LEVELS,
            )
            completeness = (
                None if completeness_by_cohort is None
                else float(completeness_by_cohort[i])
            )
            out['completeness'] = completeness
            out['layer'] = completeness_to_layer(
                completeness if completeness is not None else 0.0,
            )
            bands_map, above_reasons = _latency_bands(
                proj_idx, int(eval_ages[i]), engine_cohorts[i],
            )
            out['latency_bands'] = bands_map
            if above_reasons:
                provenance['latency_bands'] = above_reasons

        out['_projection_provenance'] = provenance
        enriched.append(out)

    return {
        **observed,
        'rate_by_cohort': enriched,
        'cf_mode': bundle.cf_mode,
        'cf_reason': bundle.cf_reason,
        'promoted_source': bundle.promoted_source,
    }
