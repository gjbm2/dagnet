"""Primitive-backed CF runtime readout."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Sequence

from datetime import date as _date, timedelta as _timedelta
from typing import Dict, Tuple

import numpy as np

from evidence_merge import (
    EvidenceCandidate,
    EvidenceRole,
    EvidenceScope,
)

from .model_resolver import ResolvedModelParams
from .prefix_arrival import (
    NodeArrivalProvenance,
    NodeArrivalWeights,
    PrefixArrivalIdentity,
    PrefixArrivalMap,
    build_prefix_arrival_map,
)
from .primitive_conditioning import (
    ConditioningPolicyOptions,
    condition_primitive,
    make_unconditioned_primitive,
)
from .primitive_evidence import (
    PrimitiveEvidenceResolution,
    RequestPrimitiveRegistry,
    bind_primitive_evidence,
)
from .primitives import (
    ConditionedTransitionPrimitive,
    ConditioningStatus,
    PrimitiveScope,
    TransitionIdentity,
)
from .timing_particles import build_request_timing_particles
from .subject_span_composer import (
    ComposedPrimitiveSpan,
    ComposeOptions,
    compose_primitive_span,
)
from .model_span_spine import ComposedUnconditionedOverlay
from .timing_span import (
    TimingTransitionPrimitive,
)


def _per_primitive_evidence_scope(
    *,
    transition: TransitionIdentity,
    primitive_scope: PrimitiveScope,
    arrival_weights: NodeArrivalWeights,
) -> EvidenceScope:
    """Evidence scope on the primitive source clock."""
    days = sorted(arrival_weights.weights.keys())
    date_from = primitive_scope.evidence_date_from or primitive_scope.date_from
    date_to = primitive_scope.evidence_date_to or primitive_scope.date_to
    if days:
        date_from = min(str(date_from or days[0]), days[0])
        date_to = max(str(date_to or days[-1]), days[-1])
    return EvidenceScope(
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        subject_from=transition.source_node,
        subject_to=transition.destination_node,
        date_from=date_from,
        date_to=date_to,
        as_at=primitive_scope.as_at,
        scenario_id=primitive_scope.scenario_id,
        context_key=primitive_scope.context_key,
        context_selector=primitive_scope.context_selector,
        mece_dimensions=primitive_scope.mece_dimensions,
        regime_key=primitive_scope.regime_key,
    )


@dataclass(frozen=True)
class _PreparedPrimitive:
    resolution: PrimitiveEvidenceResolution
    primitive: ConditionedTransitionPrimitive


def prepare_primitive(
    *,
    transition: TransitionIdentity,
    primitive_scope: PrimitiveScope,
    resolved_model: ResolvedModelParams,
    arrival_weights: NodeArrivalWeights,
    scenario_seed: int,
    options: ConditioningPolicyOptions,
    prior_source: Optional[str],
    request_candidates: Sequence[Any],
    dispersion_basis: str = 'epistemic',
) -> _PreparedPrimitive:
    return _prepare_conditioned_primitive(
        transition=transition,
        primitive_scope=primitive_scope,
        resolved_model=resolved_model,
        arrival_weights=arrival_weights,
        scenario_seed=scenario_seed,
        options=options,
        prior_source=prior_source,
        request_candidates=request_candidates,
        dispersion_basis=dispersion_basis,
    )


def _prepare_conditioned_primitive(
    *,
    transition: TransitionIdentity,
    primitive_scope: PrimitiveScope,
    resolved_model: ResolvedModelParams,
    arrival_weights: NodeArrivalWeights,
    scenario_seed: int,
    options: ConditioningPolicyOptions,
    prior_source: Optional[str],
    request_candidates: Sequence[EvidenceCandidate],
    dispersion_basis: str = 'epistemic',
) -> _PreparedPrimitive:
    """Bind request candidates and condition one primitive.

    ``dispersion_basis`` is forwarded to ``condition_primitive`` —
    'epistemic' for the model surface, 'predictive' for FC.
    """
    evidence_scope = _per_primitive_evidence_scope(
        transition=transition,
        primitive_scope=primitive_scope,
        arrival_weights=arrival_weights,
    )
    candidates = tuple(request_candidates)

    resolution = bind_primitive_evidence(
        transition=transition,
        primitive_scope=primitive_scope,
        evidence_scope=evidence_scope,
        candidates=candidates,
        arrival_weights=arrival_weights,
    )
    primitive = condition_primitive(
        resolution=resolution,
        resolved_model=resolved_model,
        scenario_seed=scenario_seed,
        options=options,
        prior_source=prior_source,
        dispersion_basis=dispersion_basis,
    )
    return _PreparedPrimitive(resolution=resolution, primitive=primitive)


@dataclass(frozen=True)
class SpanEdgeResolution:
    """Per-edge inputs for the X→end subject closure."""
    transition: TransitionIdentity
    primitive_scope: PrimitiveScope
    resolved_model: ResolvedModelParams
    is_target: bool


def _resolved_to_timing_transition(
    *,
    transition: TransitionIdentity,
    resolved: ResolvedModelParams,
) -> TimingTransitionPrimitive:
    """Convert resolved model params into timing input."""
    lat = resolved.latency
    return TimingTransitionPrimitive(
        p=float(resolved.p_mean),
        mu=float(lat.mu),
        sigma=float(lat.sigma),
        onset=float(lat.onset_delta_days),
        latency_parameter=lat.latency_parameter,
        p_sd=float(resolved.p_sd),
        mu_sd=float(lat.mu_sd),
        sigma_sd=float(lat.sigma_sd),
        onset_sd=float(lat.onset_sd),
        onset_mu_corr=float(getattr(lat, 'onset_mu_corr', 0.0) or 0.0),
        source=f'prior_{resolved.source}',
    )


def _window_identity_arrival_weights(
    primitive_scope: PrimitiveScope,
    *,
    draw_count: int,
) -> NodeArrivalWeights:
    """Identity arrival weights for window-mode local-clock binding.

    Identity weights at a primitive's source clock are the same under
    every draw — there is no latency to randomise. The per-draw axis
    is therefore a broadcast of the scalar identity surface
    (algebraic degeneracy of zero-latency arrival).
    """
    weights: Dict[str, float] = {}
    start = _date.fromisoformat(primitive_scope.date_from)
    end = _date.fromisoformat(primitive_scope.date_to)
    cur = start
    while cur <= end:
        weights[cur.isoformat()] = 1.0
        cur = cur + _timedelta(days=1)
    weights_draws: Dict[str, np.ndarray] = {
        day: np.full(int(draw_count), float(weight), dtype=np.float32)
        for day, weight in weights.items()
    }
    return NodeArrivalWeights(
        weights=weights,
        weights_draws=weights_draws,
        draw_count=int(draw_count),
        reach_from_root=1.0,
        provenance=NodeArrivalProvenance(
            topology_case='identity',
            composed_edges=0,
            has_latency_edge=False,
            transition_source='window_local_clock',
            horizon_ratio=1.0,
        ),
        root_day_contributions={
            day: {day: float(weight)}
            for day, weight in weights.items()
        },
    )


def _build_request_arrival_map(
    *,
    graph: Mapping[str, Any],
    root_node_id: str,
    primitive_scope_for_window: PrimitiveScope,
    edge_resolutions: Sequence[Tuple[TransitionIdentity, ResolvedModelParams]],
    identity: PrefixArrivalIdentity,
    max_tau: int,
    scenario_seed: int,
    draw_count: int,
    primitive_scopes: Optional[
        Mapping[Tuple[str, str], PrimitiveScope]
    ] = None,
) -> PrefixArrivalMap:
    """Build a request-scoped prefix-arrival map.

    ``primitive_scopes`` keys per-edge PrimitiveScope into the same
    ``DrawFamilyKey`` that primitive conditioning will use; this is
    how the shared timing-particle invariant (Phase 6 §3.2) is
    realised between prefix-arrival composition and conditioning.
    When the caller does not have per-edge scopes available (e.g.
    legacy paths that resolve scope downstream), the window-local
    scope is broadcast across all edges — an algebraic degeneracy
    that yields draw-coherent particles within this map while staying
    consistent across calls under the same request scope.
    """
    edge_resolution_by_key = {
        (transition.source_node, transition.destination_node): (transition, resolved)
        for transition, resolved in edge_resolutions
    }
    transitions: Dict[Tuple[str, str], TimingTransitionPrimitive] = {
        edge_key: _resolved_to_timing_transition(
            transition=transition, resolved=resolved,
        )
        for edge_key, (transition, resolved) in edge_resolution_by_key.items()
    }
    transition_identities: Dict[Tuple[str, str], TransitionIdentity] = {
        edge_key: transition
        for edge_key, (transition, _resolved) in edge_resolution_by_key.items()
    }
    if primitive_scopes is None:
        scopes_resolved: Dict[Tuple[str, str], PrimitiveScope] = {
            edge_key: primitive_scope_for_window
            for edge_key in edge_resolution_by_key.keys()
        }
    else:
        scopes_resolved = dict(primitive_scopes)
    target_node_ids = tuple(dict.fromkeys(
        node
        for transition, _resolved in edge_resolutions
        for node in (transition.source_node, transition.destination_node)
    ))

    root_day_weights = {}
    start = _date.fromisoformat(primitive_scope_for_window.date_from)
    end = _date.fromisoformat(primitive_scope_for_window.date_to)
    cur = start
    while cur <= end:
        root_day_weights[cur.isoformat()] = 1.0
        cur = cur + _timedelta(days=1)

    timing_particles = build_request_timing_particles(
        transitions=transitions,
        primitive_scopes=scopes_resolved,
        transition_identities=transition_identities,
        scenario_seed=scenario_seed,
        draw_count=draw_count,
    )

    return build_prefix_arrival_map(
        graph=dict(graph),
        root_node_id=root_node_id,
        root_day_weights=root_day_weights,
        transitions=transitions,
        timing_particles=timing_particles,
        identity=identity,
        max_tau=max_tau,
        target_node_ids=target_node_ids,
    )


@dataclass(frozen=True)
class CarrierEdgeResolution:
    """Per-edge inputs for the A→X carrier closure."""
    transition: TransitionIdentity
    primitive_scope: PrimitiveScope
    resolved_model: ResolvedModelParams


@dataclass(frozen=True)
class ResolvedRuntimeReadoutResult:
    """Role-labelled primitive runtime result."""

    eligible: bool
    skip_reason: Optional[str]
    composed_subject: Optional[ComposedPrimitiveSpan]
    composed_carrier: Optional[ComposedPrimitiveSpan]
    composed_subject_predictive: Optional[ComposedPrimitiveSpan]
    composed_carrier_predictive: Optional[ComposedPrimitiveSpan]
    p_mean_primitive: Optional[float]
    p_sd_primitive: Optional[float]
    p_sd_epistemic_primitive: Optional[float]
    diagnostics: Mapping[str, Any] = field(default_factory=dict)
    arrival_map: Optional[PrefixArrivalMap] = None
    primitive_registry: Optional[RequestPrimitiveRegistry] = None
    conditioned_primitive_map: Mapping[
        str, ConditionedTransitionPrimitive
    ] = field(default_factory=dict)
    carrier_span_role: Mapping[str, Any] = field(default_factory=dict)
    subject_span_role: Mapping[str, Any] = field(default_factory=dict)
    unconditioned_overlays: Mapping[
        str, ComposedUnconditionedOverlay
    ] = field(default_factory=dict)
    # Empirical evidence operator spans (Phase 6 §4.9). Composed sibling
    # of the conditioned spans above — same admitted rows, same arrival
    # weighting, same DAG DP — but the per-edge kernel is Δ(k_emp/n_emp)
    # rather than p × Δcdf. The row reducer reads from both operator
    # families and routes row fields to the appropriate one (§5.6).
    composed_empirical_carrier: Optional[ComposedPrimitiveSpan] = None
    composed_empirical_subject: Optional[ComposedPrimitiveSpan] = None

def _build_resolved_runtime_prefix_arrival_identity(
    *,
    primitive_scope: PrimitiveScope,
    request_root: str,
) -> PrefixArrivalIdentity:
    """Prefix-arrival identity."""
    fingerprint_parts = (
        primitive_scope.scenario_id,
        primitive_scope.evidence_role,
        primitive_scope.date_from,
        primitive_scope.date_to,
        primitive_scope.as_at or "",
        primitive_scope.context_key or "",
        primitive_scope.regime_key or "",
        primitive_scope.model_source_preference,
        primitive_scope.resolved_source_identity or "",
        ",".join(primitive_scope.selected_anchor_days),
        "resolved_cf_runtime.v1",
    )
    return PrefixArrivalIdentity(
        scenario_id=primitive_scope.scenario_id,
        request_root=request_root,
        context_key=primitive_scope.context_key,
        context_selector=primitive_scope.context_selector,
        regime_key=primitive_scope.regime_key,
        as_at=primitive_scope.as_at,
        model_source_preference=primitive_scope.model_source_preference,
        parameter_fingerprint="|".join(fingerprint_parts),
    )


def compute_resolved_runtime_readout(
    *,
    graph: Mapping[str, Any],
    population_root_node_id: str,
    x_node_id: str,
    end_node_id: str,
    subject_edge_resolutions: Sequence[SpanEdgeResolution],
    prebuilt_subject_arrival_map: PrefixArrivalMap,
    carrier_edge_resolutions: Sequence[CarrierEdgeResolution],
    scenario_seed: int,
    request_evidence_candidates: Sequence[Any],
    options: ConditioningPolicyOptions,
    compose_options: ComposeOptions,
    prior_source: Optional[str] = None,
    unconditioned_overlay_bases: Sequence[str] = ('predictive',),
    prebuilt_carrier_arrival_map: Optional[PrefixArrivalMap] = None,
) -> ResolvedRuntimeReadoutResult:
    """Assemble the primitive-backed CF runtime for one request."""
    from . import model_span_spine

    carrier_resolutions = list(carrier_edge_resolutions)
    subject_resolutions = list(subject_edge_resolutions)
    diagnostics: Dict[str, Any] = {
        "eligible": True,
        "skip_reason": None,
        "population_root": population_root_node_id,
        "x_node_id": x_node_id,
        "end_node_id": end_node_id,
    }

    subject_arrival_map = prebuilt_subject_arrival_map
    carrier_arrival_map = prebuilt_carrier_arrival_map

    spans = model_span_spine.resolve_request_spans(
        graph=graph,
        population_root_node_id=str(population_root_node_id),
        x_node_id=str(x_node_id),
        end_node_id=str(end_node_id),
        carrier_resolutions=carrier_resolutions,
        subject_resolutions=subject_resolutions,
        subject_arrival_map=subject_arrival_map,
        carrier_arrival_map=carrier_arrival_map,
        scenario_seed=scenario_seed,
        options=options,
        compose_options=compose_options,
        prior_source=prior_source,
        request_evidence_candidates=request_evidence_candidates,
        unconditioned_overlay_bases=unconditioned_overlay_bases,
    )

    p_mean = float(spans.composed_subject.span_p_mean)
    p_sd = float(spans.composed_subject.span_p_sd)
    p_sd_epi = float(spans.composed_subject.span_p_sd)

    carrier_diag = {
        "anchor_node_id": str(population_root_node_id),
        "x_node_id": str(x_node_id),
        "role": "carrier_to_x",
        "primitive_count": spans.composed_carrier.primitive_count,
        "draw_count": spans.composed_carrier.draw_count,
        "reach": spans.composed_carrier.span_p_mean,
        "span_p_sd": spans.composed_carrier.span_p_sd,
        "max_tau": spans.composed_carrier.max_tau,
    }
    subject_diag = {
        "x_node_id": spans.composed_subject.x_node_id,
        "end_node_id": spans.composed_subject.end_node_id,
        "role": "subject_span",
        "primitive_count": spans.composed_subject.primitive_count,
        "draw_count": spans.composed_subject.draw_count,
        "span_p_mean": spans.composed_subject.span_p_mean,
        "span_p_sd": spans.composed_subject.span_p_sd,
        "max_tau": spans.composed_subject.max_tau,
    }
    diagnostics["composed_carrier"] = carrier_diag
    diagnostics["composed_subject"] = subject_diag
    diagnostics["composed_public_moments"] = {
        "p_mean": p_mean,
        "p_sd": p_sd,
        "p_sd_epistemic": p_sd_epi,
    }
    diagnostics["subject_probability_source"] = "primitive_span.subject"

    provenance = {
        "carrier_span": carrier_diag,
        "subject_span": subject_diag,
        "projection": {
            "substituted": True,
            "subject_probability_source": "primitive_span.subject",
        },
        "diagnostics": dict(diagnostics),
    }

    return ResolvedRuntimeReadoutResult(
        eligible=True,
        skip_reason=None,
        composed_subject=spans.composed_subject,
        composed_carrier=spans.composed_carrier,
        composed_subject_predictive=spans.composed_subject_predictive,
        composed_carrier_predictive=spans.composed_carrier_predictive,
        p_mean_primitive=p_mean,
        p_sd_primitive=p_sd,
        p_sd_epistemic_primitive=p_sd_epi,
        diagnostics=provenance,
        arrival_map=subject_arrival_map,
        primitive_registry=spans.registry,
        conditioned_primitive_map=dict(spans.conditioned_primitive_map),
        carrier_span_role=dict(carrier_diag),
        subject_span_role=dict(subject_diag),
        unconditioned_overlays=spans.overlays,
        composed_empirical_carrier=spans.composed_empirical_carrier,
        composed_empirical_subject=spans.composed_empirical_subject,
    )


__all__ = [
    "CarrierEdgeResolution",
    "ResolvedRuntimeReadoutResult",
    "SpanEdgeResolution",
    "compute_resolved_runtime_readout",
]
