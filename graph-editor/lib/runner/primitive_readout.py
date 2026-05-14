"""
Unified primitive-backed CF runtime assembly (73n closure).

This module owns the request-local primitive preparation used by the
public CF row/scalar path:

  - enumerate subject primitives for the full ``X -> end`` span;
  - optionally enumerate carrier primitives for active ``A -> X``;
  - build one request-rooted ``PrefixArrivalMap``;
  - bind evidence through ``bind_primitive_evidence``;
  - condition every primitive through ``condition_primitive``;
  - compose carrier and subject roles through ``compose_primitive_span``;
  - emit one role-labelled runtime provenance block.

``window()`` and ``cohort(A = X)`` are identity-carrier data cases.
Single-hop subjects are one-edge subject spans. There are no live staged
single-hop / multi-hop / active-carrier readout functions in this module.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Sequence

from datetime import date as _date, timedelta as _timedelta
from typing import Dict, List

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
from .primitive_residual_guard import (
    EdgeRequirement,
    EdgeRequirementKind,
    classify_edge_requirement,
)
from .primitives import (
    ConditionedTransitionPrimitive,
    ConditioningStatus,
    PrimitiveScope,
    TransitionIdentity,
)
from .subject_span_composer import (
    ComposedPrimitiveSpan,
    ComposeOptions,
    CompositionError,
    compose_primitive_span,
)
# Re-export so cf-v3 (and any other consumer) can keep importing
# ``ComposedUnconditionedOverlay`` from this module. The class itself
# lives in the spine module; this module owns the request perimeter.
from .model_span_spine import ComposedUnconditionedOverlay
from .timing_span import (
    TimingTransitionPrimitive,
)
# Optional cache hit/miss snapshot in the substrate diag (plan §760).
# result_cache lives in graph-editor/lib (not under runner/).
import sys as _sys
from pathlib import Path as _Path
_lib_dir = str(_Path(__file__).resolve().parents[1])
if _lib_dir not in _sys.path:
    _sys.path.insert(0, _lib_dir)
import result_cache as _result_cache  # noqa: E402


def _cache_status_snapshot() -> Optional[List[Mapping[str, Any]]]:
    """Compact cache hit/miss snapshot (plan §760).

    Returns a list of per-cache stat dicts as exposed by
    ``result_cache.stats_all()`` so the response can describe the
    primitive / composed-carrier / composed-subject cache state at the
    time the runtime produced its diagnostics. Tiny (≤4 caches × ~7
    fields). Returns ``None`` if the registry cannot be read for any
    reason — observability is best-effort and never blocks runtime
    construction.
    """
    try:
        snap = _result_cache.stats_all()
    except Exception:  # pragma: no cover - registry is robust
        return None
    return list(snap.get('caches', ()))


# ─── Canonical primitive preparation ────────────────────────────────────
def _per_primitive_evidence_scope(
    *,
    transition: TransitionIdentity,
    primitive_scope: PrimitiveScope,
    arrival_weights: NodeArrivalWeights,
) -> EvidenceScope:
    """Construct the per-primitive ``EvidenceScope`` for primitive ``U → V``.

    The date bounds are taken from the support of ``arrival_weights`` —
    the U-arrival clock induced by the request root and the prefix
    topology. This is the load-bearing widening required by the 73n plan
    §"Evidence clock alignment" so that downstream cohort primitives bind
    ``window(U-V)`` evidence on the U-arrival clock rather than the
    public anchor bounds.

    For the query root (window mode or ``A == X``), ``arrival_weights``
    is identity over the source window, and the resulting bounds
    coincide with the public anchor bounds — the legacy behaviour, by
    natural degeneracy.
    """
    days = sorted(arrival_weights.weights.keys())
    if days:
        date_from = days[0]
        date_to = days[-1]
    else:
        date_from = primitive_scope.date_from
        date_to = primitive_scope.date_to
    return EvidenceScope(
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        subject_from=transition.source_node,
        subject_to=transition.destination_node,
        date_from=date_from,
        date_to=date_to,
        as_at=primitive_scope.as_at,
        scenario_id=primitive_scope.scenario_id,
    )


@dataclass(frozen=True)
class _PreparedPrimitive:
    resolution: PrimitiveEvidenceResolution
    primitive: ConditionedTransitionPrimitive


class PrimitiveUnavailable(Exception):
    """Engine-level refusal: a primitive cannot be prepared for this request.

    Raised by ``prepare_primitive`` when the residual guard refuses the
    edge requirement or the arrival map has no weights for the primitive's
    source node. The perimeter catches this to early-skip the request;
    the engine does not silently fall back.
    """

    def __init__(self, reason: str, info: Mapping[str, Any]):
        super().__init__(f"{reason}: {dict(info)}")
        self.reason = reason
        self.info = dict(info)


def prepare_primitive(
    *,
    transition: TransitionIdentity,
    primitive_scope: PrimitiveScope,
    resolved_model: ResolvedModelParams,
    arrival_map: PrefixArrivalMap,
    scenario_seed: int,
    options: ConditioningPolicyOptions,
    prior_source: Optional[str],
    request_candidates: Sequence[Any],
    window_identity: bool = False,
) -> _PreparedPrimitive:
    """Bind + condition one primitive. Raises ``PrimitiveUnavailable`` on
    residual-guard refusal or arrival-map miss; the engine does not return
    a None sentinel."""
    decision = classify_edge_requirement(
        EdgeRequirement(
            transition=transition,
            kind=EdgeRequirementKind.PARAMETERISED,
        )
    )
    if not decision.forward_to_conditioning:
        raise PrimitiveUnavailable(
            "residual_guard_refused",
            {
                "edge_id": transition.edge_id,
                "rejection_reason": decision.rejection_reason,
            },
        )
    arrival_weights = (
        _window_identity_arrival_weights(primitive_scope)
        if window_identity
        else arrival_map.get(transition.source_node)
    )
    if arrival_weights is None:
        raise PrimitiveUnavailable(
            "arrival_map_miss",
            {
                "source_node": transition.source_node,
                "edge_id": transition.edge_id,
            },
        )
    return _prepare_conditioned_primitive(
        transition=transition,
        primitive_scope=primitive_scope,
        resolved_model=resolved_model,
        arrival_weights=arrival_weights,
        scenario_seed=scenario_seed,
        options=options,
        prior_source=prior_source,
        request_candidates=request_candidates,
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
) -> _PreparedPrimitive:
    """Canonical bind → condition step for one request-local primitive.

    The EvidenceScope is built per-primitive from the support of
    ``arrival_weights`` (the U-arrival clock for this primitive), and
    the merge admits from the request-level raw candidate pool. Empty
    candidate pools still flow through the binder and condition naturally
    as prior-only primitives.
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
    )
    return _PreparedPrimitive(resolution=resolution, primitive=primitive)


@dataclass(frozen=True)
class SpanEdgeResolution:
    """Per-edge inputs for one edge of the X→end subject closure.

    The runtime builder resolves one of these per edge along the
    topological span. The target edge receives the request's prepared
    ``EvidenceSet``; non-target edges may receive per-edge evidence or
    empty candidates, both through the canonical binder/conditioner path.

    ``edge_id`` is required and must match the topology's edge dict
    ``edge_id`` field so the composer can resolve registry lookups
    deterministically.
    """
    transition: TransitionIdentity
    primitive_scope: PrimitiveScope
    resolved_model: ResolvedModelParams
    is_target: bool


def _resolved_to_timing_transition(
    *,
    transition: TransitionIdentity,
    resolved: ResolvedModelParams,
) -> TimingTransitionPrimitive:
    """Convert a per-edge ``ResolvedModelParams`` into timing input.

    The runtime already holds resolved models per edge and need not
    re-walk the graph. Falls back to ``alpha/(alpha+beta)`` when
    ``p_mean`` is unset, so callers that populate conjugate parameters
    but not the derived mean still produce composable timing."""
    lat = resolved.latency
    p_mean = float(resolved.p_mean or 0.0)
    if p_mean <= 0.0:
        a = float(resolved.alpha or 0.0)
        b = float(resolved.beta or 0.0)
        if (a + b) > 0.0:
            p_mean = a / (a + b)
    return TimingTransitionPrimitive(
        p=p_mean,
        mu=float(lat.mu) if lat.mu is not None else 0.0,
        sigma=float(lat.sigma) if (lat.sigma is not None and lat.sigma >= 0) else 0.0,
        onset=float(lat.onset_delta_days) if lat.onset_delta_days is not None else 0.0,
        latency_parameter=getattr(lat, 'latency_parameter', None),
        p_sd=float(resolved.p_sd or 0.0),
        mu_sd=float(lat.mu_sd or 0.0),
        sigma_sd=float(lat.sigma_sd or 0.0),
        onset_sd=float(lat.onset_sd or 0.0),
        source=(
            f'prior_{resolved.source}' if resolved.source else 'prior_unresolved'
        ),
    )


def _window_identity_arrival_weights(
    primitive_scope: PrimitiveScope,
) -> NodeArrivalWeights:
    """Identity NodeArrivalWeights for window-mode local-clock binding.

    Each in-scope anchor day has weight 1.0; no propagation. Used when a
    subject primitive in a window query binds evidence on its own
    source-rooted local clock (Appendix A of
    docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md).
    """
    weights: Dict[str, float] = {}
    df = primitive_scope.date_from
    dt = primitive_scope.date_to
    if df and dt:
        try:
            start = _date.fromisoformat(df)
            end = _date.fromisoformat(dt)
        except ValueError:
            start = end = None  # type: ignore[assignment]
        if start is not None and end is not None and start <= end:
            cur = start
            while cur <= end:
                weights[cur.isoformat()] = 1.0
                cur = cur + _timedelta(days=1)
    return NodeArrivalWeights(
        weights=weights,
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
            if weight > 0.0
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
    override_root_day_weights: Optional[Mapping[str, float]] = None,
) -> PrefixArrivalMap:
    """Build the real request-scoped ``PrefixArrivalMap`` once per request.

    Constructs ``transitions`` from the per-edge resolved models the
    runtime already holds, then delegates to
    ``prefix_arrival.build_prefix_arrival_map``. The root entry holds
    an identity mask over ``[primitive_scope_for_window.date_from,
    date_to]`` (every in-window day weighted 1.0) so window-mode rows
    at the root keep their full evidence pressure; downstream nodes
    get composed normalised arrival distributions via shared timing
    composition.

    ``override_root_day_weights`` lets the caller supply explicit root
    weights instead of the identity mask. Used in active cohort mode
    (A != X) where the subject map's X-day root support must cover the
    calendar days the carrier latency actually reaches X on, not the
    A-anchor cohort range. Without this override, subject rows are bound
    against arrival weights that have no support outside the cohort
    range, every row is rejected, and selected-A-clock evidence
    collapses to empty.

    Consumers index ``arrival_map.nodes[transition.source_node]`` per
    edge. The map is constructed over every primitive source node, so a
    missing key is a request-construction bug rather than a runtime
    fallback case.
    """
    transitions: Dict[Tuple[str, str], TimingTransitionPrimitive] = {}
    target_node_ids: List[str] = []
    seen_targets: set[str] = set()
    for transition, resolved in edge_resolutions:
        edge_key = (transition.source_node, transition.destination_node)
        if edge_key not in transitions:
            transitions[edge_key] = _resolved_to_timing_transition(
                transition=transition, resolved=resolved,
            )
        for node in (transition.source_node, transition.destination_node):
            if node not in seen_targets:
                seen_targets.add(node)
                target_node_ids.append(node)

    root_day_weights: Dict[str, float] = {}
    if override_root_day_weights is not None:
        root_day_weights = {
            str(d): float(w)
            for d, w in override_root_day_weights.items()
            if float(w) > 0.0
        }
    else:
        df = primitive_scope_for_window.date_from
        dt = primitive_scope_for_window.date_to
        if df and dt:
            try:
                start = _date.fromisoformat(df)
                end = _date.fromisoformat(dt)
            except ValueError:
                start = end = None  # type: ignore[assignment]
            if start is not None and end is not None and start <= end:
                cur = start
                while cur <= end:
                    root_day_weights[cur.isoformat()] = 1.0
                    cur = cur + _timedelta(days=1)

    return build_prefix_arrival_map(
        graph=dict(graph),
        root_node_id=root_node_id,
        root_day_weights=root_day_weights,
        transitions=transitions,
        identity=identity,
        max_tau=max_tau,
        target_node_ids=tuple(target_node_ids) if target_node_ids else None,
    )


@dataclass(frozen=True)
class CarrierEdgeResolution:
    """Per-edge inputs for one edge of the A→X carrier closure.

    Active cohort requests enumerate these for A->X. Evidence enters via
    the request-level candidate pool, then primitive binding filters by
    edge identity and clock support.
    """
    transition: TransitionIdentity
    primitive_scope: PrimitiveScope
    resolved_model: ResolvedModelParams


@dataclass(frozen=True)
class ResolvedRuntimeReadoutResult:
    """Role-labelled primitive runtime result.

    This is the closure surface over the old staged surfaces: one request
    owns one arrival map, one primitive registry, a composed carrier span
    (A→X — zero-edge for window() and cohort(A=X), the algebraic identity
    of the operator-chain monoid), and a composed subject span (X→end).

    ``composed_carrier`` / ``composed_subject`` are Optional only because
    early-skip results carry ``None`` — they do NOT signal identity carrier.
    A successful resolution always has both spans populated; identity
    carrier is represented as ``composed_carrier`` with ``primitive_count=0``.
    """

    eligible: bool
    skip_reason: Optional[str]
    composed_subject: Optional[ComposedPrimitiveSpan]
    composed_carrier: Optional[ComposedPrimitiveSpan]
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
    # Unconditioned overlay compositions over the same A→end topology,
    # keyed by dispersion basis (e.g. 'predictive' powers F-mode bands;
    # 'epistemic' powers the optional model_curve_* row fields). Each
    # entry's ``carrier`` is a zero-edge composition for identity-carrier
    # cases (window / cohort(A=X)) — the algebraic identity of the
    # operator-chain monoid, not ``None``. Bases not requested by the
    # caller are absent.
    unconditioned_overlays: Mapping[
        str, ComposedUnconditionedOverlay
    ] = field(default_factory=dict)

    @property
    def should_substitute(self) -> bool:
        return bool(
            self.eligible
            and self.composed_subject is not None
            and self.composed_carrier is not None
            and self.p_mean_primitive is not None
        )


def _build_resolved_runtime_prefix_arrival_identity(
    *,
    primitive_scope: PrimitiveScope,
    request_root: str,
) -> PrefixArrivalIdentity:
    """Prefix-arrival identity for the unified runtime owner."""
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
    options: Optional[ConditioningPolicyOptions] = None,
    compose_options: Optional[ComposeOptions] = None,
    prior_source: Optional[str] = None,
    unconditioned_overlay_bases: Sequence[str] = ('predictive',),
    prebuilt_carrier_arrival_map: Optional[PrefixArrivalMap] = None,
    is_window: bool = False,
) -> ResolvedRuntimeReadoutResult:
    """Assemble the primitive-backed CF runtime for one request.

    The public row/scalar path calls this helper instead of choosing by
    single-hop / multi-hop / active-cohort route. The cases differ only
    by data: an empty carrier list means identity carrier; the subject
    span is always X->end.

    This function is the perimeter wrapper around
    ``model_span_spine.resolve_request_spans``: call the spine, catch
    engine refusals (``PrimitiveUnavailable`` / ``CompositionError``)
    and translate to early-skip. The algebra lives in the spine.
    """
    from . import model_span_spine

    options = options or ConditioningPolicyOptions()
    compose_options = compose_options or ComposeOptions()
    # Thread the request's S into the composer so zero-edge identity spans
    # are shape-(S, T) and downstream readout sees a uniform per-draw
    # shape (no perimeter inspection of cdf_draws.shape[0]).
    if compose_options.draw_count == 0:
        from dataclasses import replace
        compose_options = replace(compose_options, draw_count=options.draw_count)
    carrier_resolutions = list(carrier_edge_resolutions)
    subject_resolutions = list(subject_edge_resolutions)
    diagnostics: Dict[str, Any] = {
        "eligible": True,
        "skip_reason": None,
        "population_root": population_root_node_id,
        "x_node_id": x_node_id,
        "end_node_id": end_node_id,
    }

    def _early_skip(
        reason: str, note: str, extra: Mapping[str, Any],
    ) -> ResolvedRuntimeReadoutResult:
        diagnostics["eligible"] = False
        diagnostics["skip_reason"] = reason
        diagnostics["note"] = note
        diagnostics.update(extra)
        provenance = {
            "carrier_span": None,
            "subject_span": None,
            "projection": {
                "substituted": False,
                "subject_probability_source": None,
            },
            "diagnostics": dict(diagnostics),
        }
        return ResolvedRuntimeReadoutResult(
            eligible=False,
            skip_reason=reason,
            composed_subject=None,
            composed_carrier=None,
            p_mean_primitive=None,
            p_sd_primitive=None,
            p_sd_epistemic_primitive=None,
            diagnostics=provenance,
        )

    # Exactly one target subject edge is a request-construction invariant.
    # Tuple unpacking keeps this sharp: zero or many targets raises.
    (_,) = (r for r in subject_resolutions if r.is_target)

    # Two-clocks split: the caller owns arrival-map construction. The
    # readout consumes the already-resolved subject (X-rooted) and carrier
    # (A-rooted) maps.
    subject_arrival_map = prebuilt_subject_arrival_map
    carrier_arrival_map = prebuilt_carrier_arrival_map

    # Call the spine. Engine refusals (PrimitiveUnavailable from residual
    # guard / arrival map miss; CompositionError from no-path topology)
    # are caught here and translated to early-skip.
    try:
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
            is_window=is_window,
        )
    except PrimitiveUnavailable as exc:
        return _early_skip(
            f"primitive_unavailable.{exc.reason}",
            f"primitive preparation refused ({exc.reason})",
            {"primitive_failure": dict(exc.info)},
        )
    except CompositionError as exc:
        return _early_skip(
            "composition_error",
            f"span composition refused: {exc}",
            {"composition_error": str(exc)},
        )

    # Success: spine returned composed pair + overlays. Build the public
    # result + a minimal provenance block. The shadow wrapper (Phase 9)
    # passes the provenance through opaquely.
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
    diagnostics["cache_status"] = _cache_status_snapshot()

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
    )


__all__ = [
    "CarrierEdgeResolution",
    "ResolvedRuntimeReadoutResult",
    "SpanEdgeResolution",
    "compute_resolved_runtime_readout",
]
