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
from typing import Any, Mapping, Optional, Sequence, Tuple

from evidence_merge import EvidenceSet

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
def _candidates_from_evidence_set(
    evidence_set: Optional[EvidenceSet],
) -> Tuple[EvidenceCandidate, ...]:
    """Lift the candidates back out of a pre-merged ``EvidenceSet``.

    The upstream feed (frames synthesis, retrieval) builds an
    ``EvidenceSet`` whose ``points`` each carry the originating
    ``EvidenceCandidate``. The canonical binder takes candidates and
    re-runs the merge layer; for already-distinct candidates the merge
    is idempotent and the result is shape-equivalent to the upstream
    ``EvidenceSet`` modulo the binder's day-weighting.
    """
    if evidence_set is None or not evidence_set.points:
        return ()
    return tuple(point.candidate for point in evidence_set.points)


def _empty_evidence_scope_for_window(
    *,
    transition: TransitionIdentity,
    primitive_scope: PrimitiveScope,
) -> EvidenceScope:
    """Construct a window-subject-helper ``EvidenceScope`` for a primitive
    that has no admitted evidence under the request scope.

    The binder runs the merge layer with empty candidates, producing an
    empty raw ``EvidenceSet`` and an empty weighted view. The conditioner
    reads ``has_live_evidence`` as False and falls through to its
    PRIOR_ONLY path, so the result is identical to the legacy explicit
    prior-only constructor without a separate code path."""
    return EvidenceScope(
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        subject_from=transition.source_node,
        subject_to=transition.destination_node,
        date_from=primitive_scope.date_from,
        date_to=primitive_scope.date_to,
        as_at=primitive_scope.as_at,
        scenario_id=primitive_scope.scenario_id,
    )


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


def _prepare_conditioned_primitive(
    *,
    transition: TransitionIdentity,
    primitive_scope: PrimitiveScope,
    resolved_model: ResolvedModelParams,
    evidence_set: Optional[EvidenceSet],
    arrival_weights: NodeArrivalWeights,
    scenario_seed: int,
    options: ConditioningPolicyOptions,
    prior_source: Optional[str],
    request_candidates: Optional[Sequence[EvidenceCandidate]] = None,
) -> _PreparedPrimitive:
    """Canonical bind → condition step for one request-local primitive.

    73n evidence-clock alignment: when ``request_candidates`` is supplied,
    the EvidenceScope is built per-primitive from the support of
    ``arrival_weights`` (the U-arrival clock for this primitive), and
    the merge admits from the request-level raw candidate pool. The
    pre-merged ``evidence_set`` is then provenance-only — the request-
    level merge cannot be authoritative because its date bounds are the
    public anchor clock, which only coincides with the primitive-local
    clock for the query root (window mode or A=X cohort).

    When ``request_candidates`` is ``None``, the legacy behaviour is
    preserved: candidates are lifted from the pre-merged ``evidence_set``
    and the merge re-runs against that set's stored scope.
    """
    if request_candidates is not None and not arrival_weights.is_degraded:
        evidence_scope = _per_primitive_evidence_scope(
            transition=transition,
            primitive_scope=primitive_scope,
            arrival_weights=arrival_weights,
        )
        candidates = tuple(request_candidates)
    elif evidence_set is not None:
        evidence_scope = evidence_set.scope
        candidates = _candidates_from_evidence_set(evidence_set)
    else:
        evidence_scope = _empty_evidence_scope_for_window(
            transition=transition,
            primitive_scope=primitive_scope,
        )
        candidates = ()

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


# Stage 0c §3.3 shadow band on displayed rate.
SHADOW_ABS_BAND = 0.005
SHADOW_REL_BAND = 0.01

# Stage 0c §3.3 acceptance band on displayed rate.
ACCEPTANCE_ABS_BAND = 0.002
ACCEPTANCE_REL_BAND = 0.004


def _within_band(
    delta: Optional[float],
    legacy: Optional[float],
    abs_band: float,
    rel_band: float,
) -> Optional[bool]:
    if delta is None or legacy is None:
        return None
    abs_ok = abs(delta) <= abs_band
    if abs(legacy) >= 1e-12:
        rel_ok = abs(delta) / abs(legacy) <= rel_band
    else:
        rel_ok = True
    return bool(abs_ok and rel_ok)


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
    evidence_set: Optional[Any]
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
    )


def _build_request_arrival_map(
    *,
    graph: Mapping[str, Any],
    root_node_id: str,
    primitive_scope_for_window: PrimitiveScope,
    edge_resolutions: Sequence[Tuple[TransitionIdentity, ResolvedModelParams]],
    identity: PrefixArrivalIdentity,
    max_tau: int,
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

    Active cohort requests enumerate these for A->X. Missing evidence is
    represented by ``evidence_set=None`` and still flows through the same
    canonical binder/conditioner path as evidence-bearing primitives.
    """
    transition: TransitionIdentity
    primitive_scope: PrimitiveScope
    resolved_model: ResolvedModelParams
    evidence_set: Optional[Any]


@dataclass(frozen=True)
class ResolvedRuntimeReadoutResult:
    """Role-labelled primitive runtime result.

    This is the closure surface over the old staged surfaces: one request
    owns one arrival map, one primitive registry, optional carrier
    primitives, and subject primitives for the full X->end span. Window
    and cohort(A=X) represent the carrier as identity data.
    """

    eligible: bool
    skip_reason: Optional[str]
    composed_subject: Optional[ComposedPrimitiveSpan]
    composed_carrier: Optional[ComposedPrimitiveSpan]
    carrier_is_identity: bool
    p_mean_primitive: Optional[float]
    p_sd_primitive: Optional[float]
    p_sd_epistemic_primitive: Optional[float]
    legacy_p_mean: Optional[float]
    legacy_p_sd: Optional[float]
    legacy_p_sd_epistemic: Optional[float]
    delta_p_mean: Optional[float]
    delta_p_sd: Optional[float]
    deltas_within_shadow_band: Optional[bool]
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
    # entry's ``carrier`` is ``None`` for identity-carrier cases (window
    # / cohort(A=X)). Bases not requested by the caller are absent.
    unconditioned_overlays: Mapping[
        str, 'ComposedUnconditionedOverlay'
    ] = field(default_factory=dict)

    @property
    def should_substitute(self) -> bool:
        if not self.eligible:
            return False
        if self.composed_subject is None:
            return False
        if not self.carrier_is_identity and self.composed_carrier is None:
            return False
        if not self.composed_subject.is_draw_coherent:
            return False
        if self.p_mean_primitive is None:
            return False
        return True


@dataclass(frozen=True)
class ComposedUnconditionedOverlay:
    """Subject + carrier compositions for one unconditioned overlay basis.

    Mirrors the conditioned-side ``composed_subject``/``composed_carrier``
    pair so the row projector's existing carrier⊛subject convolution
    applies to the overlay without a parallel code path.
    """
    subject: ComposedPrimitiveSpan
    carrier: Optional[ComposedPrimitiveSpan]


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
    graph: Optional[Mapping[str, Any]],
    population_root_node_id: Optional[str],
    x_node_id: Optional[str],
    end_node_id: Optional[str],
    subject_edge_resolutions: Optional[List[SpanEdgeResolution]],
    carrier_edge_resolutions: Optional[List[CarrierEdgeResolution]] = None,
    scenario_seed: int,
    options: Optional[ConditioningPolicyOptions] = None,
    compose_options: Optional[ComposeOptions] = None,
    legacy_p_mean: Optional[float] = None,
    legacy_p_sd: Optional[float] = None,
    legacy_p_sd_epistemic: Optional[float] = None,
    prior_source: Optional[str] = None,
    unconditioned_overlay_bases: Sequence[str] = ('predictive',),
    request_evidence_candidates: Optional[Sequence[Any]] = None,
    prebuilt_arrival_map: Optional[PrefixArrivalMap] = None,
    prebuilt_subject_arrival_map: Optional[PrefixArrivalMap] = None,
    prebuilt_carrier_arrival_map: Optional[PrefixArrivalMap] = None,
    is_window: bool = False,
) -> ResolvedRuntimeReadoutResult:
    """Assemble the primitive-backed CF runtime for one request.

    The public row/scalar path calls this helper instead of choosing by
    single-hop / multi-hop / active-cohort route. The cases differ only
    by data: an empty carrier list means identity
    carrier; the subject span is always X->end.
    """
    options = options or ConditioningPolicyOptions()
    compose_options = compose_options or ComposeOptions()
    carrier_resolutions = list(carrier_edge_resolutions or ())
    subject_resolutions = list(subject_edge_resolutions or ())
    carrier_is_identity = not carrier_resolutions
    diag: Dict[str, Any] = {
        "eligible": True,
        "skip_reason": None,
        "population_root": population_root_node_id,
        "x_node_id": x_node_id,
        "end_node_id": end_node_id,
        "carrier_mode": "identity" if carrier_is_identity else "composed",
        "request_candidates_count": (
            len(request_evidence_candidates)
            if request_evidence_candidates is not None
            else None
        ),
    }

    def _runtime_provenance(
        *,
        note: Optional[str] = None,
        substituted: bool = False,
        subject_source: Optional[str] = None,
    ) -> Mapping[str, Any]:
        if note:
            diag["note"] = note
        carrier_span = (
            {"role": "identity", "x_node_id": x_node_id}
            if carrier_is_identity else diag.get("composed_carrier")
        )
        return {
            "carrier_span": carrier_span,
            "subject_span": diag.get("composed_subject"),
            "primitives": {
                "carrier": tuple(diag.get("carrier_primitives", ())),
                "subject": tuple(diag.get("subject_primitives", ())),
            },
            "projection": {
                "substituted": substituted,
                "subject_probability_source": subject_source,
                "delta_p_mean": diag.get("delta_p_mean"),
                "within_shadow_band": diag.get("within_shadow_band"),
            },
            "diagnostics": dict(diag),
        }

    def _early_skip(reason: str, note: str) -> ResolvedRuntimeReadoutResult:
        diag["eligible"] = False
        diag["skip_reason"] = reason
        provenance = _runtime_provenance(note=note)
        return ResolvedRuntimeReadoutResult(
            eligible=False,
            skip_reason=reason,
            composed_subject=None,
            composed_carrier=None,
            carrier_is_identity=carrier_is_identity,
            p_mean_primitive=None,
            p_sd_primitive=None,
            p_sd_epistemic_primitive=None,
            legacy_p_mean=legacy_p_mean,
            legacy_p_sd=legacy_p_sd,
            legacy_p_sd_epistemic=legacy_p_sd_epistemic,
            delta_p_mean=None,
            delta_p_sd=None,
            deltas_within_shadow_band=None,
            diagnostics=provenance,
        )

    missing = [
        name for name, value in (
            ("graph", graph),
            ("population_root_node_id", population_root_node_id),
            ("x_node_id", x_node_id),
            ("end_node_id", end_node_id),
            ("subject_edge_resolutions", subject_edge_resolutions),
        ) if value is None
    ]
    if missing or not subject_resolutions:
        diag["missing_inputs"] = missing
        return _early_skip(
            "incomplete_inputs",
            "resolved runtime inputs incomplete; falling back to legacy",
        )

    target_count = sum(1 for r in subject_resolutions if r.is_target)
    if target_count != 1:
        diag["target_count"] = target_count
        return _early_skip(
            "target_count_invalid",
            f"expected exactly one target subject edge; got {target_count}",
        )

    target_resolution = next(r for r in subject_resolutions if r.is_target)
    # Two-clocks split: the subject map is rooted at X (the subject's own
    # root) and binds subject primitives. The carrier map is rooted at A
    # (the population root) and only binds carrier primitives. When the
    # caller has not pre-built them (legacy callers passing only
    # ``prebuilt_arrival_map`` or no map at all), reconstruct them here.
    # ``prebuilt_arrival_map`` is treated as the subject map for backward
    # compatibility — for window() and cohort(A=X) requests the carrier
    # role is identity-only (no carrier_resolutions) and the legacy single
    # map was already X-rooted in those cases.
    subject_arrival_map = (
        prebuilt_subject_arrival_map
        or prebuilt_arrival_map
    )
    carrier_arrival_map = prebuilt_carrier_arrival_map
    if subject_arrival_map is None:
        subject_arrival_identity = _build_resolved_runtime_prefix_arrival_identity(
            primitive_scope=target_resolution.primitive_scope,
            request_root=str(x_node_id),
        )
        subject_arrival_map = _build_request_arrival_map(
            graph=graph,
            root_node_id=str(x_node_id),
            primitive_scope_for_window=target_resolution.primitive_scope,
            edge_resolutions=[
                (r.transition, r.resolved_model) for r in subject_resolutions
            ],
            identity=subject_arrival_identity,
            max_tau=compose_options.max_tau,
        )
    if carrier_resolutions and carrier_arrival_map is None:
        carrier_arrival_identity = (
            _build_resolved_runtime_prefix_arrival_identity(
                primitive_scope=target_resolution.primitive_scope,
                request_root=str(population_root_node_id),
            )
        )
        carrier_arrival_map = _build_request_arrival_map(
            graph=graph,
            root_node_id=str(population_root_node_id),
            primitive_scope_for_window=target_resolution.primitive_scope,
            edge_resolutions=[
                (r.transition, r.resolved_model) for r in carrier_resolutions
            ],
            identity=carrier_arrival_identity,
            max_tau=compose_options.max_tau,
        )
    # The registry's identity-cache key is part of every primitive's
    # registry key. The subject map is always present, so use it for the
    # registry. Carrier primitives' registry keys are computed against
    # the carrier map's identity directly at register-time (see
    # ``RequestPrimitiveRegistry.register(..., prefix_identity=...)``).
    registry = RequestPrimitiveRegistry(arrival_map=subject_arrival_map)

    carrier_edge_to_primitive: Dict[
        Tuple[str, str], ConditionedTransitionPrimitive
    ] = {}
    carrier_edge_id_to_primitive: Dict[str, ConditionedTransitionPrimitive] = {}
    carrier_summaries: List[Mapping[str, Any]] = []
    conditioned_primitive_map: Dict[str, ConditionedTransitionPrimitive] = {}

    def _prepare_one(
        *,
        transition: TransitionIdentity,
        primitive_scope: PrimitiveScope,
        resolved_model: ResolvedModelParams,
        evidence_set: Optional[Any],
        guard_kind: str,
        arrival_map: PrefixArrivalMap,
        window_identity: bool = False,
    ) -> Optional[_PreparedPrimitive]:
        decision = classify_edge_requirement(
            EdgeRequirement(
                transition=transition,
                kind=EdgeRequirementKind.PARAMETERISED,
            )
        )
        if not decision.forward_to_conditioning:
            diag[f"{guard_kind}_residual_guard_refused"] = {
                "edge_id": transition.edge_id,
                "reason": decision.rejection_reason,
            }
            return None
        arrival_weights = (
            _window_identity_arrival_weights(primitive_scope)
            if window_identity
            else arrival_map.get(transition.source_node)
        )
        if arrival_weights is None:
            diag[f"{guard_kind}_arrival_map_miss"] = {
                "source_node": transition.source_node,
                "edge_id": transition.edge_id,
            }
            return None
        return _prepare_conditioned_primitive(
            transition=transition,
            primitive_scope=primitive_scope,
            resolved_model=resolved_model,
            evidence_set=evidence_set,
            arrival_weights=arrival_weights,
            scenario_seed=scenario_seed,
            options=options,
            prior_source=prior_source,
            request_candidates=request_evidence_candidates,
        )

    for carrier_res in carrier_resolutions:
        prepared = _prepare_one(
            transition=carrier_res.transition,
            primitive_scope=carrier_res.primitive_scope,
            resolved_model=carrier_res.resolved_model,
            evidence_set=carrier_res.evidence_set,
            guard_kind="carrier",
            arrival_map=carrier_arrival_map,
        )
        if prepared is None:
            return _early_skip(
                "carrier_primitive_unavailable",
                "carrier primitive preparation failed; see diagnostics",
            )
        # Carrier primitives belong to the carrier-rooted clock, so their
        # registry key must encode the carrier identity (not the
        # subject-map identity the registry was initialised with).
        registry_key = registry.register(
            prepared.resolution,
            prefix_identity=carrier_arrival_map.identity,
        )
        primitive = prepared.primitive
        conditioned_primitive_map[registry_key] = primitive
        carrier_edge_to_primitive[(
            carrier_res.transition.source_node,
            carrier_res.transition.destination_node,
        )] = primitive
        carrier_edge_id_to_primitive[carrier_res.transition.edge_id] = primitive
        carrier_summaries.append({
            "edge_id": carrier_res.transition.edge_id,
            "from": carrier_res.transition.source_node,
            "to": carrier_res.transition.destination_node,
            "status": primitive.status.value,
            "is_draw_coherent": primitive.is_draw_coherent,
            "p_mean": (
                float(primitive.probability_posterior.mean)
                if primitive.probability_posterior is not None else None
            ),
            "p_sd": (
                float(primitive.probability_posterior.sd)
                if (
                    primitive.probability_posterior is not None
                    and primitive.probability_posterior.sd is not None
                ) else None
            ),
            "provenance": primitive.to_provenance_dict(),
        })
    diag["carrier_primitives"] = tuple(carrier_summaries)

    subject_edge_to_primitive: Dict[
        Tuple[str, str], ConditionedTransitionPrimitive
    ] = {}
    subject_edge_id_to_primitive: Dict[str, ConditionedTransitionPrimitive] = {}
    subject_summaries: List[Mapping[str, Any]] = []
    subject_primitives: List[ConditionedTransitionPrimitive] = []
    for subj_res in subject_resolutions:
        guard_kind = "subject_target" if subj_res.is_target else "subject"
        if not subj_res.is_target:
            # Non-target subject edges are ordinary parameterised siblings.
            arrival_weights = (
                _window_identity_arrival_weights(subj_res.primitive_scope)
                if is_window
                else subject_arrival_map.get(subj_res.transition.source_node)
            )
            if arrival_weights is None:
                diag["subject_arrival_map_miss"] = {
                    "source_node": subj_res.transition.source_node,
                    "edge_id": subj_res.transition.edge_id,
                }
                return _early_skip(
                    "subject_primitive_unavailable",
                    "subject primitive preparation failed; see diagnostics",
                )
            prepared = _prepare_conditioned_primitive(
                transition=subj_res.transition,
                primitive_scope=subj_res.primitive_scope,
                resolved_model=subj_res.resolved_model,
                evidence_set=subj_res.evidence_set,
                arrival_weights=arrival_weights,
                scenario_seed=scenario_seed,
                options=options,
                prior_source=prior_source,
            )
        else:
            prepared = _prepare_one(
                transition=subj_res.transition,
                primitive_scope=subj_res.primitive_scope,
                resolved_model=subj_res.resolved_model,
                evidence_set=subj_res.evidence_set,
                guard_kind=guard_kind,
                arrival_map=subject_arrival_map,
                window_identity=is_window,
            )
            if prepared is None:
                return _early_skip(
                    "subject_primitive_unavailable",
                    "subject primitive preparation failed; see diagnostics",
                )
        registry_key = registry.register(prepared.resolution)
        primitive = prepared.primitive
        conditioned_primitive_map[registry_key] = primitive
        subject_primitives.append(primitive)
        subject_edge_to_primitive[(
            subj_res.transition.source_node,
            subj_res.transition.destination_node,
        )] = primitive
        subject_edge_id_to_primitive[subj_res.transition.edge_id] = primitive
        subject_summaries.append({
            "edge_id": subj_res.transition.edge_id,
            "from": subj_res.transition.source_node,
            "to": subj_res.transition.destination_node,
            "is_target": subj_res.is_target,
            "status": primitive.status.value,
            "is_draw_coherent": primitive.is_draw_coherent,
            "provenance": primitive.to_provenance_dict(),
        })
    diag["subject_primitives"] = tuple(subject_summaries)

    def _subject_lookup(
        from_id: str, to_id: str, edge_dict: Mapping[str, Any]
    ):
        edge_id = edge_dict.get('edge_id') or edge_dict.get('id')
        if edge_id and edge_id in subject_edge_id_to_primitive:
            return subject_edge_id_to_primitive[edge_id]
        return subject_edge_to_primitive.get((from_id, to_id))

    def _carrier_lookup(
        from_id: str, to_id: str, edge_dict: Mapping[str, Any]
    ):
        edge_id = edge_dict.get('edge_id') or edge_dict.get('id')
        if edge_id and edge_id in carrier_edge_id_to_primitive:
            return carrier_edge_id_to_primitive[edge_id]
        return carrier_edge_to_primitive.get((from_id, to_id))

    composed_carrier: Optional[ComposedPrimitiveSpan] = None
    if carrier_resolutions:
        try:
            composed_carrier = compose_primitive_span(
                graph=graph,
                x_node_id=str(population_root_node_id),
                end_node_id=str(x_node_id),
                registry=registry,
                edge_to_primitive_lookup=_carrier_lookup,
                options=compose_options,
            )
        except CompositionError as exc:
            diag["carrier_composition_error"] = str(exc)
            return _early_skip(
                "carrier_composition_error",
                f"compose_primitive_span(A->X carrier) raised: {exc}",
            )
        diag["composed_carrier"] = {
            "anchor_node_id": str(population_root_node_id),
            "x_node_id": str(x_node_id),
            "role": "carrier_to_x",
            "primitive_count": composed_carrier.primitive_count,
            "draw_count": composed_carrier.draw_count,
            "is_draw_coherent": composed_carrier.is_draw_coherent,
            "reach": composed_carrier.span_p_mean,
            "span_p_sd": composed_carrier.span_p_sd,
            "max_tau": composed_carrier.max_tau,
            "binding_policy": composed_carrier.provenance.get("binding_policy"),
            "composition_mode": composed_carrier.provenance.get("composition_mode"),
        }
    else:
        diag["composed_carrier"] = {"role": "identity", "x_node_id": str(x_node_id)}
    carrier_span_role = dict(diag["composed_carrier"])

    try:
        composed_subject = compose_primitive_span(
            graph=graph,
            x_node_id=str(x_node_id),
            end_node_id=str(end_node_id),
            registry=registry,
            edge_to_primitive_lookup=_subject_lookup,
            options=compose_options,
        )
    except CompositionError as exc:
        diag["subject_composition_error"] = str(exc)
        return _early_skip(
            "subject_composition_error",
            f"compose_primitive_span(X->end subject) raised: {exc}",
        )

    diag["composed_subject"] = {
        "x_node_id": composed_subject.x_node_id,
        "end_node_id": composed_subject.end_node_id,
        "role": "subject_span",
        "primitive_count": composed_subject.primitive_count,
        "draw_count": composed_subject.draw_count,
        "is_draw_coherent": composed_subject.is_draw_coherent,
        "span_p_mean": composed_subject.span_p_mean,
        "span_p_sd": composed_subject.span_p_sd,
        "max_tau": composed_subject.max_tau,
        "binding_policy": composed_subject.provenance.get("binding_policy"),
        "composition_mode": composed_subject.provenance.get("composition_mode"),
    }
    subject_span_role = dict(diag["composed_subject"])

    # 73g invariant 1: one general machinery path. Single-hop is the
    # one-edge degeneration of multi-hop, not a separate readout.
    # `_compose_draws` supplies `expected_reach` from `_topological_reach`
    # per draw, so `composed_subject.span_p_mean` is the asymptotic
    # span probability — which collapses to `mean(p_draws)` for a
    # one-edge span, matching the primitive's IS posterior mean to MC
    # tolerance.
    if (
        composed_subject.is_draw_coherent
        and composed_subject.span_p_draws is not None
    ):
        p_mean_pri = float(composed_subject.span_p_mean)
        p_sd_pri = float(composed_subject.span_p_sd)
        p_sd_epi_pri = float(composed_subject.span_p_sd)
    else:
        p_mean_pri = None
        p_sd_pri = None
        p_sd_epi_pri = None
    subject_source = "primitive_span.subject"

    delta_p_mean = (
        p_mean_pri - legacy_p_mean
        if (p_mean_pri is not None and legacy_p_mean is not None) else None
    )
    delta_p_sd = (
        p_sd_pri - legacy_p_sd
        if (p_sd_pri is not None and legacy_p_sd is not None) else None
    )
    within_shadow = _within_band(
        delta_p_mean,
        legacy_p_mean,
        SHADOW_ABS_BAND,
        SHADOW_REL_BAND,
    )
    diag["composed_public_moments"] = {
        "p_mean": p_mean_pri,
        "p_sd": p_sd_pri,
        "p_sd_epistemic": p_sd_epi_pri,
    }
    diag["legacy_public_moments"] = {
        "p_mean": legacy_p_mean,
        "p_sd": legacy_p_sd,
        "p_sd_epistemic": legacy_p_sd_epistemic,
    }
    diag["delta_p_mean"] = delta_p_mean
    diag["delta_p_sd"] = delta_p_sd
    diag["within_shadow_band"] = within_shadow
    diag["acceptance_abs_band"] = ACCEPTANCE_ABS_BAND
    diag["acceptance_rel_band"] = ACCEPTANCE_REL_BAND
    diag["shadow_abs_band"] = SHADOW_ABS_BAND
    diag["shadow_rel_band"] = SHADOW_REL_BAND
    diag["subject_probability_source"] = (
        subject_source
        if composed_subject.is_draw_coherent
        else f"{subject_source}_moments_only"
    )
    diag["cache_status"] = _cache_status_snapshot()

    # ── Unconditioned overlay compositions ─────────────────────────
    # The composer is the same; only the per-edge primitive's draw
    # family changes (prior particles instead of joint-conditioned
    # posterior). Built per requested basis so requests that don't
    # render a given band pay no MC cost for it.
    unconditioned_overlays: Dict[str, ComposedUnconditionedOverlay] = {}
    for basis in unconditioned_overlay_bases:
        # Build per-edge primitive maps for this basis. Mirrors the
        # conditioned-side closures above (id-pair fallback when edge_id
        # not present) — same lookup shape, prior-only primitives.
        c_map_id: Dict[Tuple[str, str], ConditionedTransitionPrimitive] = {}
        c_map_eid: Dict[str, ConditionedTransitionPrimitive] = {}
        for c_res in carrier_resolutions:
            prim = make_unconditioned_primitive(
                transition=c_res.transition,
                primitive_scope=c_res.primitive_scope,
                resolved_model=c_res.resolved_model,
                scenario_seed=scenario_seed,
                options=options,
                dispersion_basis=basis,
                prior_source=prior_source,
            )
            c_map_id[(
                c_res.transition.source_node,
                c_res.transition.destination_node,
            )] = prim
            c_map_eid[c_res.transition.edge_id] = prim
        s_map_id: Dict[Tuple[str, str], ConditionedTransitionPrimitive] = {}
        s_map_eid: Dict[str, ConditionedTransitionPrimitive] = {}
        for s_res in subject_resolutions:
            prim = make_unconditioned_primitive(
                transition=s_res.transition,
                primitive_scope=s_res.primitive_scope,
                resolved_model=s_res.resolved_model,
                scenario_seed=scenario_seed,
                options=options,
                dispersion_basis=basis,
                prior_source=prior_source,
            )
            s_map_id[(
                s_res.transition.source_node,
                s_res.transition.destination_node,
            )] = prim
            s_map_eid[s_res.transition.edge_id] = prim

        def carrier_overlay_lookup(
            from_id, to_id, edge_dict,
            _eid=c_map_eid, _idp=c_map_id,
        ):
            edge_id = edge_dict.get('edge_id') or edge_dict.get('id')
            if edge_id and edge_id in _eid:
                return _eid[edge_id]
            return _idp.get((from_id, to_id))

        def subject_overlay_lookup(
            from_id, to_id, edge_dict,
            _eid=s_map_eid, _idp=s_map_id,
        ):
            edge_id = edge_dict.get('edge_id') or edge_dict.get('id')
            if edge_id and edge_id in _eid:
                return _eid[edge_id]
            return _idp.get((from_id, to_id))

        try:
            if carrier_resolutions:
                overlay_carrier = compose_primitive_span(
                    graph=graph,
                    x_node_id=str(population_root_node_id),
                    end_node_id=str(x_node_id),
                    registry=registry,
                    edge_to_primitive_lookup=carrier_overlay_lookup,
                    options=compose_options,
                )
            else:
                overlay_carrier = None
            overlay_subject = compose_primitive_span(
                graph=graph,
                x_node_id=str(x_node_id),
                end_node_id=str(end_node_id),
                registry=registry,
                edge_to_primitive_lookup=subject_overlay_lookup,
                options=compose_options,
            )
        except CompositionError as exc:
            diag[f'unconditioned_{basis}_composition_error'] = str(exc)
            continue
        unconditioned_overlays[basis] = ComposedUnconditionedOverlay(
            subject=overlay_subject,
            carrier=overlay_carrier,
        )
        diag[f'unconditioned_overlay_{basis}'] = {
            'subject_span_p_mean': overlay_subject.span_p_mean,
            'subject_span_p_sd': overlay_subject.span_p_sd,
            'subject_is_draw_coherent': overlay_subject.is_draw_coherent,
            'subject_primitive_count': overlay_subject.primitive_count,
            'subject_draw_count': overlay_subject.draw_count,
            'carrier_present': overlay_carrier is not None,
            'carrier_span_p_mean': (
                overlay_carrier.span_p_mean if overlay_carrier is not None else None
            ),
        }

    substituted = bool(
        composed_subject.is_draw_coherent
        and p_mean_pri is not None
        and (carrier_is_identity or composed_carrier is not None)
    )
    provenance = _runtime_provenance(
        substituted=substituted,
        subject_source=diag["subject_probability_source"],
    )
    return ResolvedRuntimeReadoutResult(
        eligible=True,
        skip_reason=None,
        composed_subject=composed_subject,
        composed_carrier=composed_carrier,
        carrier_is_identity=carrier_is_identity,
        p_mean_primitive=p_mean_pri,
        p_sd_primitive=p_sd_pri,
        p_sd_epistemic_primitive=p_sd_epi_pri,
        legacy_p_mean=legacy_p_mean,
        legacy_p_sd=legacy_p_sd,
        legacy_p_sd_epistemic=legacy_p_sd_epistemic,
        delta_p_mean=delta_p_mean,
        delta_p_sd=delta_p_sd,
        deltas_within_shadow_band=within_shadow,
        diagnostics=provenance,
        arrival_map=subject_arrival_map,
        primitive_registry=registry,
        conditioned_primitive_map=dict(conditioned_primitive_map),
        carrier_span_role=carrier_span_role,
        subject_span_role=subject_span_role,
        unconditioned_overlays=unconditioned_overlays,
    )


__all__ = [
    "ACCEPTANCE_ABS_BAND",
    "ACCEPTANCE_REL_BAND",
    "SHADOW_ABS_BAND",
    "SHADOW_REL_BAND",
    "CarrierEdgeResolution",
    "ResolvedRuntimeReadoutResult",
    "SpanEdgeResolution",
    "compute_resolved_runtime_readout",
]
