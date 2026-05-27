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
    is_window: bool,
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
        temporal_mode='window' if is_window else 'cohort',
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

    carrier_resolutions = []
    carrier_skip = None
    if (not is_window) and anchor_node_id and str(anchor_node_id) != str(query_from_node):
        carrier_resolutions, carrier_skip = _build_span_resolutions(
            graph=graph,
            from_node=str(anchor_node_id),
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
    subject_arrival_map = None
    carrier_arrival_map = None
    is_active = bool(
        carrier_resolutions
        and not is_window
        and anchor_node_id
        and str(anchor_node_id) != str(query_from_node)
    )
    conditioning_options = ConditioningPolicyOptions()

    if is_active:
        # Active cohort: maps come from the request envelope plan whose
        # carrier roots are the cohort A-anchor range and whose subject
        # roots are the carrier's X-arrival days.
        carrier_arrival_map = envelope_plan.carrier_arrival_map
        subject_arrival_map = envelope_plan.subject_arrival_map
    elif subject_resolutions:
        # Window mode and cohort(A = X): no carrier; subject map is
        # X-rooted identity over the public window. The envelope plan
        # leaves arrival maps unset for window mode (per Appendix A's
        # local-clock binding contract), so build the subject map here.
        target_resolution = next(
            (r for r in subject_resolutions if getattr(r, 'is_target', False)),
            subject_resolutions[0],
        )
        subject_arrival_identity = _build_resolved_runtime_prefix_arrival_identity(
            primitive_scope=target_resolution.primitive_scope,
            request_root=str(query_from_node),
        )
        _draw_count_for_arrival_map = conditioning_options.draw_count
        subject_arrival_map = _build_request_arrival_map(
            graph=graph,
            root_node_id=str(query_from_node),
            primitive_scope_for_window=target_resolution.primitive_scope,
            edge_resolutions=[
                (r.transition, r.resolved_model) for r in subject_resolutions
            ],
            identity=subject_arrival_identity,
            max_tau=400,
            scenario_seed=_runtime_seed(scenario_id, 'resolved_cf_runtime'),
            draw_count=_draw_count_for_arrival_map,
            primitive_scopes={
                (r.transition.source_node, r.transition.destination_node):
                    r.primitive_scope
                for r in subject_resolutions
            },
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
        options=conditioning_options,
        compose_options=ComposeOptions(draw_count=conditioning_options.draw_count),
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
) -> tuple[Optional[float], Optional[float]]:
    """N-weighted mean and SD of the request-rooted CDF at each cohort's
    observed frontier.

    Pulls completeness from the same composed CDF the row builder uses
    so the public scalar and the rendered curves stay aligned. Returns
    ``(None, None)`` if the runtime has no composed CDF or every cohort
    has zero weight.
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
        tau_obs = ci.get('tau_observed') if isinstance(ci, Mapping) else None
        if isinstance(tau_obs, (int, float)) and int(tau_obs) < 0:
            continue
        anchor_key = _anchor_day_key(
            ci.get('anchor_day') if isinstance(ci, Mapping) else None,
        )
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
        anchor_day_raw = (
            ci.get('anchor_day')
            if isinstance(ci, Mapping)
            else getattr(ec, 'anchor_day', None)
        )
        if anchor_day_raw is None:
            continue
        anchor_day_key = (
            anchor_day_raw.isoformat()
            if hasattr(anchor_day_raw, 'isoformat')
            else str(anchor_day_raw)[:10]
        )
        n_pop = float(getattr(ec, 'a_pop', 0.0) or 0.0)
        if n_pop <= 0.0:
            continue
        n_anchor = float(n_by_anchor.get(anchor_day_key, 0.0) or 0.0)
        tau_max_int = int(
            (ci.get('tau_max') if isinstance(ci, Mapping) else None)
            or 0,
        )
        # Per-Cohort frontier f_c. The selected retrieval frontier (one
        # query-wide analysis observation date mapped to this anchor's
        # age) is authoritative when present. The frame-derived
        # cohort_list['tau_observed'] is NOT used as the frontier here:
        # frame composition drops per-Cohort retrieval provenance and
        # collapses to 0 for multi-hop window(), which would prefix-pin
        # FC continuation to the wrong frontier. The empty-frames
        # sentinel (-1) carries no observation and is preserved so the
        # spine projects from the unit prior.
        frame_tau_obs = (
            ci.get('tau_observed') if isinstance(ci, Mapping) else None
        )
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


def _project_runtime_rows(
    *,
    runtime: ResolvedCFRuntime,
    engine_cohorts: Sequence[Any],
    cohort_eval_ages: Sequence[int],
    cohort_weights: Sequence[float],
    max_tau: int,
    tau_solid_max: int,
    tau_future_max: int,
    sweep_to: str,
    band_level: float,
    n_by_anchor: Optional[Mapping[str, float]] = None,
    selected_retrieval_frontier: Optional[SelectedRetrievalFrontier] = None,
    cohort_list: Optional[Sequence[Mapping[str, Any]]] = None,
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

    # E+F draws come from the spine's single mode-blind reducer — one
    # operator-supply pass per family (conditioned + empirical), one DP
    # core, one division (Phase 6 §4.9 + §5.6). The legacy selected-Cohort
    # group reducer and its Pop D / Pop C enumeration are gone; the spine
    # reducer projects ΣY/ΣX directly from the composed operator surfaces.
    selected_cohort_inputs = _build_selected_cohort_inputs(
        engine_cohorts,
        cohort_list or [],
        n_by_anchor or {},
        (
            selected_retrieval_frontier.paired_frontier_by_anchor
            if selected_retrieval_frontier is not None
            else {}
        ),
    )
    # FC plan §9.4 / §9.5: the FC shadow surface reads the
    # predictive-basis CONDITIONED spans
    # (``runtime.composed_*_predictive`` — built from the SAME bound
    # evidence as the epistemic ``composed_*`` pair, just with
    # ``dispersion_basis='predictive'``). The
    # unconditioned-predictive overlay carries no evidence binding and
    # is NOT a substitute for the conditioned-predictive surface.
    selected_projection = model_span_spine.project_selected_cohort_rows(
        composed_carrier=runtime.composed_carrier,
        composed_subject=runtime.composed_subject,
        composed_carrier_predictive=runtime.composed_carrier_predictive,
        composed_subject_predictive=runtime.composed_subject_predictive,
        composed_empirical_carrier=runtime.composed_empirical_carrier,
        composed_empirical_subject=runtime.composed_empirical_subject,
        selected_cohorts=selected_cohort_inputs,
        horizon=max_tau,
    )
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
        # NaN cells flag (s, τ) where the rate is undefined (X_total = 0).
        # If every particle is NaN, the row contributes None; otherwise
        # the valid particles drive the per-τ quantiles.
        if not np.isfinite(d).any():
            return None, None, None, None, None
        mid = float(np.nanmedian(d))
        upper = float(np.nanquantile(d, (1 + band_level) / 2))
        lower = float(np.nanquantile(d, (1 - band_level) / 2))
        bands = {
            str(int(bl * 100)): [
                float(np.nanquantile(d, (1 - bl) / 2)),
                float(np.nanquantile(d, (1 + bl) / 2)),
            ]
            for bl in band_levels
        }
        return mid, upper, lower, bands, float(np.nanmean(d))

    def _draw_mean(draws_2d: Optional[np.ndarray], tau: int):
        if draws_2d is None or tau >= draws_2d.shape[1]:
            return None
        d = draws_2d[:, tau]
        if not np.isfinite(d).any():
            return None
        return float(np.nanmean(d))

    # Active cohort A!=X: evidence-named fields are populated only from
    # actual selected A-clock observations supplied by
    # selected_a_clock_evidence. Target-window frame prefixes remain
    # forbidden as substitutes. The per-particle reducer's midpoint/fan
    # stay projection-derived from composed carrier + subject surfaces.
    pop_root = runtime.population_root
    denom_node = runtime.denominator_node
    roots_equal_at_X = (
        pop_root is not None
        and denom_node is not None
        and str(pop_root) == str(denom_node)
    )
    is_active_carrier = (
        runtime.composed_carrier is not None
        and not roots_equal_at_X
    )
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
        # surfaces them rather than clamping. `is_active_carrier` gates
        # whether the field is emitted at all (identity-carrier
        # contract unchanged); inside the active branch the value is
        # whatever the predictive continuation produced.
        forecast_y_tau = (
            _draw_mean(selected_projection.ef_forecast_y, tau)
            if is_active_carrier else None
        )
        forecast_x_tau = (
            _draw_mean(selected_projection.ef_forecast_x, tau)
            if is_active_carrier else None
        )

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
    target_edge: Dict[str, Any],
    anchor_from: str,
    anchor_to: str,
    sweep_to: str,
    is_window: bool,
    resolved: Any,
    axis_tau_max: Optional[int] = None,
    *,
    is_active_carrier: bool = False,
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

        # Active cohort A!=X: window-prepared target frames are X-clocked
        # and must not seed selected A-clock observed prefixes. Exact
        # A-clock observed-prefix pinning is separate future work; keep
        # observed prefixes empty so model projection cannot masquerade
        # as evidence.
        if is_active_carrier:
            raw_obs_x = [0.0] * (saturation_tau + 1)
            raw_obs_y = [0.0] * (saturation_tau + 1)
            a_i = 0

        obs_x = raw_obs_x
        obs_y = raw_obs_y
        x_frozen = float(obs_x[a_i]) if a_i < len(obs_x) else (
            0.0 if is_active_carrier else raw_n_i
        )
        y_frozen = float(obs_y[a_i]) if a_i < len(obs_y) else (
            0.0 if is_active_carrier else float(ci.get('y_frozen', 0.0) or 0.0)
        )
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
    _is_active_carrier = (
        not is_window
        and bool(anchor_node_id)
        and bool(query_from_node)
        and str(anchor_node_id) != str(query_from_node)
    )
    fe = build_cohort_evidence_from_frames(
        frames=frames,
        target_edge=target_edge,
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        sweep_to=sweep_to,
        is_window=is_window,
        resolved=resolved,
        axis_tau_max=axis_tau_max,
        is_active_carrier=_is_active_carrier,
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
    # The per-edge candidate dicts feed raw candidate material directly
    # into one request pool. Per-primitive merge in the readout is the
    # only authoritative merge/binding boundary.
    request_candidates = _aggregate_request_candidates(
        target_candidates=evidence_candidates,
        per_edge_subject_candidates=per_edge_subject_candidates,
        per_edge_upstream_candidates=per_edge_upstream_candidates,
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
        max_tau=fe.max_tau,
        evidence_candidates=request_candidates,
        unconditioned_overlay_bases=(
            ('predictive', 'epistemic') if show_model_curve else ('predictive',)
        ),
        envelope_plan=envelope_plan,
        context_key=context_key,
        context_selector=context_selector,
        mece_dimensions=tuple(mece_dimensions or ()),
    )
    if runtime is None:
        return []

    # Active-cohort base population (a_pop) per anchor day must be
    # available BEFORE the selected A-clock evidence builder runs —
    # the new dual-prefix builder (docs/current/cohort-1apr-falling-k-
    # problem-statement.md A.6 phase 1) consumes N_cohort(C) for both
    # the X_prefix amplitude and the M_select(X, C, u) mass surface.
    # The frame-bundle 'a' value is not consulted for active; anchors
    # without admissible root-window evidence get a_pop = 0 and are
    # excluded from the active projection.
    a_pop_provenance: Dict[str, str] = {}
    n_by_anchor: Dict[str, float] = {}
    # Source N_cohort per anchor day from any candidate whose
    # `subject_from` is the population root. For active `cohort(A!=X)`
    # the matching candidates are the carrier (A-rooted upstream) edges;
    # for identity carrier (`window()` or `cohort(A=X)`) the matching
    # candidate is the X-rooted subject primitive itself — A == X so
    # there is no separate upstream carrier. Same function, same filter,
    # different sub-object degenerates as a property of the data.
    #
    # The slice-family-WINDOW filter inside `_root_window_carrier_n_by_
    # anchor_day` is load-bearing: the candidate's raw `n` per
    # `observed_date` is the X-rooted count under window binding, which
    # is the correct N_cohort surface per anchor day. For multi-hop
    # window subjects routing N_cohort through `engine_cohort.a_pop`
    # instead would substitute a frame-derived per-cohort scalar for
    # the per-day candidate counts — different aggregation, different
    # amplitude downstream in M_select and X_prefix. Atom-3 plan stage 2
    # attempted that substitution on invariant-6 grounds; it broke
    # multi-hop window numerically and was reverted. AP59 reachability
    # on cohort-only-evidence fixtures is not a current production
    # defect (§6a baseline) and is guarded by the stage 1 provenance
    # test (`test_a_equals_x_provenance_uses_unified_path_not_rescue`).
    _pop_root_for_lookup = (
        str(runtime.population_root)
        if getattr(runtime, 'population_root', None)
        else anchor_node_id
    )
    # Single-pool read: every evidence consumer in the CF row pipeline
    # reads from `runtime.request_evidence_candidates`, the flat,
    # deduplicated pool built by `_aggregate_request_candidates` before
    # the runtime was constructed. The `per_edge_*_candidates` params
    # on the public entry are still accepted (production builds them
    # via `build_(carrier_)superset_candidates_by_edge` and passes them
    # at `api_handlers.py:1800-1801` / `:2235-2236`) — they feed
    # `_aggregate_request_candidates` only.
    if fe.engine_cohorts:
        n_by_anchor = _root_window_carrier_n_by_anchor_day(
            runtime.request_evidence_candidates,
            _pop_root_for_lookup,
        )
    if fe.engine_cohorts:
        # Per-cohort base mass population — uniform across carrier modes
        # per invariant 6 (COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS
        # §"Identity carrier is data, not a route"). The candidate's
        # root-window `n` per anchor day is the authoritative source for
        # ``a_pop`` whether the carrier route is non-trivial (active) or
        # collapses to identity (``population_root == X``). The frame-
        # bundle ``a_frozen`` is never an admissible fallback (Phase 3
        # plan); the only categorical alternative to real evidence is
        # the empty-frames unit prior (``tau_observed = -1`` sentinel).
        for ec, ci in zip(fe.engine_cohorts, fe.cohort_list):
            ad = ci.get('anchor_day')
            if ad is None:
                ec.a_pop = 0.0
                continue
            ad_str = (
                ad.isoformat() if hasattr(ad, 'isoformat') else str(ad)[:10]
            )
            n_root = n_by_anchor.get(ad_str)
            if n_root is not None and n_root > 0:
                ec.a_pop = float(n_root)
                a_pop_provenance[ad_str] = 'root_window_carrier_n'
            elif int(ci.get('tau_observed', 0) or 0) < 0:
                # Empty-frames synthesis: no frames at all, no expectation
                # of root-window carrier evidence either. Preserve the
                # synthesised ``a_pop = 1.0`` so the projection produces
                # the natural Bayesian degeneracy — unit cohort through
                # the predictive carrier × subject convolution.
                a_pop_provenance[ad_str] = 'empty_frames_prior'
            else:
                # Frames exist but no admissible root-window carrier
                # evidence for this anchor day. Zero the cohort's base
                # mass; the spine treats this as an algebraic no-op
                # (zero root seed, zero occupancy, zero contribution to
                # every aggregate).
                ec.a_pop = 0.0
                a_pop_provenance[ad_str] = 'no_root_window_evidence'


    # Selected retrieval frontier source: the one query-wide analysis
    # observation date (latest admitted evidence date, capped by asat /
    # today), computed directly from the admitted evidence_superset_rows.
    # Independent of any legacy selected-clock object.
    analysis_observation_frontier_date = _analysis_observation_frontier_date(
        per_edge_results_by_uuid=per_edge_results_by_uuid,
        as_at=as_at,
    )

    # Selected retrieval frontier: the one query-wide analysis observation
    # date mapped to per-anchor τ. Behaviour-preserving replacement for the
    # SelectedAClockEvidence frontier wrappers (frontier_tau_bounds /
    # prefixes_for_cohorts(use_retrieval_frontier=True)), which were thin
    # adapters over the same date. Independent of the legacy object.
    selected_retrieval_frontier = _build_selected_retrieval_frontier(
        analysis_observation_frontier_date=analysis_observation_frontier_date,
        cohort_list=fe.cohort_list,
    )
    row_tau_solid_max = int(fe.tau_solid_max)
    row_tau_future_max = int(fe.tau_future_max)
    if selected_retrieval_frontier.bounds is not None:
        row_tau_solid_max = int(selected_retrieval_frontier.bounds[0])
        row_tau_future_max = int(selected_retrieval_frontier.bounds[1])

    if _is_active_carrier:
        # Active completeness inputs read the selected retrieval frontier
        # per anchor (the one query-wide analysis observation date mapped
        # to each Cohort's age). Fall back to the engine_cohort `eval_age`
        # (always >= 0 by construction) when this anchor carries no
        # frontier — `frontier_age` carries the `-1` empty-frames sentinel
        # and completeness "at frontier" is undefined with no frontier, so
        # the consumer needs a >= 0 age.
        cohort_eval_ages = []
        cohort_weights = []
        for ec, ci in zip(fe.engine_cohorts, fe.cohort_list):
            anchor_key = _anchor_day_key(ci.get('anchor_day'))
            frontier_tau = (
                selected_retrieval_frontier.paired_frontier_by_anchor.get(
                    anchor_key,
                )
            )
            cohort_eval_ages.append(
                max(int(frontier_tau if frontier_tau is not None else (
                    getattr(ec, 'eval_age', getattr(ec, 'frontier_age', 0)) or 0
                )), 0),
            )
            cohort_weights.append(
                float(getattr(ec, 'a_pop', 0.0) or 0.0),
            )
    else:
        # Clamp to >= 0 — `tau_observed = -1` is the empty-frames "no
        # observations recorded" sentinel; completeness eval needs a
        # valid age. See engine_cohort `eval_age = max(a_i, 0)` above.
        cohort_eval_ages = [
            max(int(c.get('tau_observed', c.get('tau_max', 0)) or 0), 0)
            for c in fe.cohort_list
        ]
        cohort_weights = [
            float(c.get('evidence_n', c.get('x_frozen', 0.0)) or 0.0)
            for c in fe.cohort_list
        ]

    rows = _project_runtime_rows(
        runtime=runtime,
        engine_cohorts=fe.engine_cohorts,
        cohort_list=fe.cohort_list,
        cohort_eval_ages=cohort_eval_ages,
        cohort_weights=cohort_weights,
        max_tau=fe.max_tau,
        tau_solid_max=row_tau_solid_max,
        tau_future_max=row_tau_future_max,
        sweep_to=sweep_to,
        band_level=band_level,
        n_by_anchor=n_by_anchor,
        selected_retrieval_frontier=selected_retrieval_frontier,
        emit_diagnostics=emit_diagnostics,
    )

    rows = _attach_cf_row_metadata(
        rows,
        conditioning={'owner': 'primitive_conditioning'},
        conditioned=runtime.public_moments.p_mean is not None,
        cf_mode=_cf_mode,
        cf_reason=_cf_reason,
        runtime_provenance=runtime.project_runtime_provenance(),
    )
    if a_pop_provenance and rows:
        rows[0]['_a_pop_provenance'] = a_pop_provenance
    return rows
