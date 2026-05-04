"""
Primitive-local evidence resolution.

For every parameterised primitive ``U → V``, build the existing
``EvidenceScope`` for ``window(U-V)`` under the request scope, run the
shared merge layer, and bind the resulting raw ``EvidenceSet`` to the
primitive-local arrival clock from the prefix-arrival map. Stage 2's
deliverable is the per-primitive binding plus a request-scoped
registry that downstream stages will consume.

Key design constraints (plan §597-629, baseline §3.2):

  - ``merge_evidence_candidates`` is called UNCHANGED. The weighted
    primitive evidence view is built AFTER merge by multiplying each
    admitted ``EvidencePoint`` by the normalised
    ``arrival_weight[U][observed_date]`` from the prefix-arrival map.
    This is the plan §565 separation: ``EvidenceSet`` keeps its
    integer ``n``/``k`` totals for non-primitive callers; the weighted
    view's floating-point ``n_weighted``/``k_weighted`` are confined to
    primitive evidence resolution.
  - The ``EvidenceScope.role`` for live CF before WP8 is always
    ``WINDOW_SUBJECT_HELPER``. This module refuses cohort-family roles
    (plan §"Stop condition" line 629; baseline §1.13 WP8 default-off
    record). A test pins this so the WP8 non-goal cannot drift in.
  - The retrieval-superset planner returns the date span the BE evidence
    fetch must cover so all primitive-local clocks are admissible. The
    per-primitive binding layer then admits rows on each primitive's
    local arrival support and rejects others — the superset rows must
    not leak between primitives.
  - The request-scoped registry is keyed by ``(transition identity,
    primitive scope, prefix-arrival identity)``. Two scenarios with the
    same edge but different induced local clocks therefore cannot
    accidentally share a posterior (plan §626).
  - Prepared span primitives crossing the ``X`` boundary or mixing
    incompatible metadata are rejected by ``validate_span_primitive``,
    which forces the caller to fall back to edge primitives. The first
    implementation prefers edge primitives; the validator exists so the
    rejection path is testable without wiring spans into the live
    registry.

This module imports:

  - ``runner.prefix_arrival`` for the arrival map
  - ``runner.primitives`` for the WeightedPrimitiveEvidenceView contract
  - ``evidence_merge`` for the existing merge layer (UNCHANGED)

It does NOT import from ``forecast_runtime``, ``forecast_state``, or
``cohort_forecast_v3`` — Stage 2 builds primitive resolution as a
testable foundation under shadow; Stage 3+ wire it in.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Dict, Optional, Tuple

from evidence_merge import (
    EvidenceCandidate,
    EvidenceRole,
    EvidenceScope,
    EvidenceSet,
    SourceKind,
    merge_evidence_candidates,
)

from .prefix_arrival import NodeArrivalWeights, PrefixArrivalIdentity, PrefixArrivalMap
from .primitives import (
    PrimitiveScope,
    TransitionIdentity,
    WeightedEvidenceRow,
    WeightedPrimitiveEvidenceView,
)


# ─── Roles permitted by Stage 2 (WP8 default-off) ──────────────────────


_WP8_DEFAULT_OFF_PERMITTED_ROLES = frozenset({
    EvidenceRole.WINDOW_SUBJECT_HELPER,
})


# ─── Retrieval superset ────────────────────────────────────────────────


@dataclass(frozen=True)
class RetrievalSupersetSpec:
    """Date envelope and metadata for one BE evidence retrieval pass.

    The date envelope is the union of every primitive-local clock the
    request needs. Per-primitive binding then admits rows on each
    primitive's local arrival support; the superset itself is broader
    by design (plan §621).
    """
    date_from: str
    date_to: str
    as_at: Optional[str]
    context_keys: Tuple[Optional[str], ...]
    regime_keys: Tuple[Optional[str], ...]
    primitive_clock_extents: Mapping[str, Tuple[str, str]]


def derive_retrieval_superset(
    *,
    arrival_map: PrefixArrivalMap,
    primitive_source_nodes: Sequence[str],
    context_keys: Sequence[Optional[str]] = (),
    regime_keys: Sequence[Optional[str]] = (),
    as_at: Optional[str] = None,
) -> RetrievalSupersetSpec:
    """Compute the BE evidence retrieval envelope for one request.

    ``primitive_source_nodes`` are the canonical ids of every ``U`` such
    that some primitive ``U → V`` is in the request. The envelope is
    the union of every ``arrival_weight[U]`` calendar-day span. Source
    nodes whose entry is degraded contribute nothing to the envelope —
    primitives bound to them will be skipped, and the retrieval
    envelope must not be widened to chase rows for a clock the
    primitive cannot actually live-use.
    """
    extents: Dict[str, Tuple[str, str]] = {}
    earliest: Optional[str] = None
    latest: Optional[str] = None

    for node_id in primitive_source_nodes:
        entry = arrival_map.get(node_id)
        if entry is None or entry.is_degraded:
            continue
        days = sorted(entry.weights.keys())
        if not days:
            continue
        node_from, node_to = days[0], days[-1]
        extents[node_id] = (node_from, node_to)
        if earliest is None or node_from < earliest:
            earliest = node_from
        if latest is None or node_to > latest:
            latest = node_to

    # Fall back to the root clock when no primitive contributes — the
    # caller still gets a valid retrieval envelope (the root day set).
    if earliest is None or latest is None:
        root_days = sorted(arrival_map.root_day_weights.keys())
        if not root_days:
            raise ValueError(
                'derive_retrieval_superset requires at least one '
                'non-degraded primitive source node OR a non-empty '
                'root_day_weights'
            )
        earliest, latest = root_days[0], root_days[-1]

    return RetrievalSupersetSpec(
        date_from=earliest,
        date_to=latest,
        as_at=as_at,
        context_keys=tuple(context_keys),
        regime_keys=tuple(regime_keys),
        primitive_clock_extents=extents,
    )


# ─── Per-primitive binding ─────────────────────────────────────────────


@dataclass(frozen=True)
class PrimitiveBindingDiagnostics:
    """Diagnostics for one primitive's evidence binding.

    Surfaces the topology case from the prefix-arrival map, the count of
    raw ``EvidenceSet`` points the merge layer admitted, the count of
    points the binding admitted onto the primitive-local clock, and the
    count it rejected (off-clock rows produced by the retrieval
    superset that don't apply to this primitive)."""
    topology_case: str
    raw_point_count: int
    bound_point_count: int
    off_clock_rejection_count: int
    arrival_weight_summary: Mapping[str, Any]
    note: str = ''


@dataclass(frozen=True)
class PrimitiveEvidenceResolution:
    """Full evidence resolution for one primitive ``U → V``.

    ``raw_evidence_set`` is the canonical merge output; non-primitive
    callers must continue to read it without seeing the weighted view
    (plan §565). ``weighted_view`` is the floating-point primitive-local
    object the conditioning layer (Stage 3) consumes.

    ``weighted_view`` is always populated. When no candidates were
    admitted, when arrival weights are degraded, or when every observed
    date falls outside the primitive's local support, the view simply
    contains zero rows (``n_weighted_total = 0.0``). Downstream
    consumers branch on ``has_live_evidence`` rather than on a
    ``None`` view — the binder's shape is uniform across cases."""
    transition: TransitionIdentity
    primitive_scope: PrimitiveScope
    raw_evidence_set: EvidenceSet
    weighted_view: WeightedPrimitiveEvidenceView
    diagnostics: PrimitiveBindingDiagnostics

    @property
    def has_live_evidence(self) -> bool:
        return self.weighted_view.n_weighted_total > 0.0


class PrimitiveBindingError(ValueError):
    """Raised when bind_primitive_evidence is called with a role the
    Stage 2 default-off policy rejects."""


def bind_primitive_evidence(
    *,
    transition: TransitionIdentity,
    primitive_scope: PrimitiveScope,
    evidence_scope: EvidenceScope,
    candidates: Sequence[EvidenceCandidate],
    arrival_weights: NodeArrivalWeights,
) -> PrimitiveEvidenceResolution:
    """Resolve evidence for one primitive ``U → V``.

    Single canonical pathway: calls ``merge_evidence_candidates``
    (UNCHANGED) to produce the raw ``EvidenceSet``, then weights each
    admitted point by ``arrival_weights.weight_on(observed_date)`` to
    produce the primitive-local weighted view.

    There is no branching on "trivial" vs "composed" arrival weights or
    on "live" vs "degraded" topology. Identity arrival weights (root
    case) and composed arrival weights (multi-hop) take exactly the
    same code path. Empty candidates produce an empty raw EvidenceSet
    which produces an empty weighted view; degraded weights produce
    zero-weighted rows that are all rejected as off-clock. In every
    case the result is one ``PrimitiveEvidenceResolution`` of identical
    shape — the conditioner branches on ``has_live_evidence`` if it
    needs to, but the binder does not (plan §605, 73g spirit).

    WP8 default-off enforcement: ``evidence_scope.role`` must be a
    ``WINDOW_SUBJECT_HELPER`` (plan §"Stop condition" line 629). Any
    other role raises ``PrimitiveBindingError``.
    """
    if evidence_scope.role not in _WP8_DEFAULT_OFF_PERMITTED_ROLES:
        raise PrimitiveBindingError(
            f'evidence role {evidence_scope.role!r} is not permitted '
            f'while WP8 is default-off; primitive evidence binding '
            f'admits only WINDOW_SUBJECT_HELPER rows'
        )

    raw = merge_evidence_candidates(evidence_scope, list(candidates))

    rows: list[WeightedEvidenceRow] = []
    rejected = 0
    for point in raw.points:
        observed = point.candidate.coordinate.observed_date
        weight = arrival_weights.weight_on(observed)
        if weight <= 0.0:
            rejected += 1
            continue
        rows.append(WeightedEvidenceRow(
            observed_date=observed,
            retrieved_at=point.candidate.coordinate.retrieved_at,
            n=int(point.n),
            k=int(point.k),
            arrival_weight=float(weight),
            n_weighted=float(point.n) * float(weight),
            k_weighted=float(point.k) * float(weight),
        ))

    n_total = float(sum(r.n_weighted for r in rows))
    k_total = float(sum(r.k_weighted for r in rows))
    weighted = WeightedPrimitiveEvidenceView(
        n_weighted_total=n_total,
        k_weighted_total=k_total,
        rows=tuple(rows),
        arrival_weight_summary={
            'topology_case': arrival_weights.provenance.topology_case,
            'composed_edges': arrival_weights.provenance.composed_edges,
            'has_latency_edge': arrival_weights.provenance.has_latency_edge,
            'transition_source': arrival_weights.provenance.transition_source,
            'horizon_ratio': arrival_weights.provenance.horizon_ratio,
            'support_days': len(arrival_weights.weights),
        },
        binding_policy='weighted_day_binding.v1',
        evidence_scope_key=raw.provenance.scope_key,
        evidence_scope_date_from=evidence_scope.date_from,
        evidence_scope_date_to=evidence_scope.date_to,
        skipped_counts_by_reason=dict(raw.provenance.skipped_counts_by_reason),
    )

    diag = PrimitiveBindingDiagnostics(
        topology_case=arrival_weights.provenance.topology_case,
        raw_point_count=len(raw.points),
        bound_point_count=len(rows),
        off_clock_rejection_count=rejected,
        arrival_weight_summary=dict(weighted.arrival_weight_summary),
    )
    return PrimitiveEvidenceResolution(
        transition=transition,
        primitive_scope=primitive_scope,
        raw_evidence_set=raw,
        weighted_view=weighted,
        diagnostics=diag,
    )


# ─── Request-scoped primitive registry ─────────────────────────────────


def _registry_key(
    transition: TransitionIdentity,
    primitive_scope: PrimitiveScope,
    prefix_identity: PrefixArrivalIdentity,
) -> str:
    """Stable hex digest covering primitive identity + scope + clock
    alignment identity (plan §145, §626). Two requests with identical
    primitive identity but different prefix-arrival identities produce
    different keys."""
    parts = (
        '73n.primitive_registry_key.v1',
        f'src={transition.source_node}',
        f'dst={transition.destination_node}',
        f'edge={transition.edge_id}',
        f'scenario={primitive_scope.scenario_id}',
        f'role={primitive_scope.evidence_role}',
        f'date_from={primitive_scope.date_from}',
        f'date_to={primitive_scope.date_to}',
        f'as_at={primitive_scope.as_at or ""}',
        f'context={primitive_scope.context_key or ""}',
        f'regime={primitive_scope.regime_key or ""}',
        f'source_pref={primitive_scope.model_source_preference}',
        f'resolved_source={primitive_scope.resolved_source_identity or ""}',
        f'anchor_days={",".join(primitive_scope.selected_anchor_days)}',
        f'clock_id={prefix_identity.cache_key}',
    )
    return hashlib.sha256('|'.join(parts).encode('utf-8')).hexdigest()[:24]


@dataclass
class RequestPrimitiveRegistry:
    """Pass-local owner of primitive resolution within one request.

    The registry binds a single ``PrefixArrivalMap`` (one identity).
    Primitives register themselves by ``(transition, primitive_scope)``
    and the registry computes a key that includes the prefix-arrival
    identity, so cross-request collisions are impossible architecturally
    (plan §139-145, §626).

    The registry is the single owner of primitive resolution within a
    request. Window, subject_span, and carrier_to_x consumers (Stages
    5/6) MUST read from the registry rather than re-resolving primitives
    independently (plan §143).
    """
    arrival_map: PrefixArrivalMap
    _entries: Dict[str, PrimitiveEvidenceResolution] = field(default_factory=dict)

    @property
    def identity(self) -> PrefixArrivalIdentity:
        return self.arrival_map.identity

    def register(
        self,
        resolution: PrimitiveEvidenceResolution,
        *,
        prefix_identity: Optional[PrefixArrivalIdentity] = None,
    ) -> str:
        """Store one primitive's resolution and return its registry key.

        ``prefix_identity`` overrides the registry's bound identity for
        primitives bound under a different clock — e.g. carrier primitives
        bound under the carrier (`A`-rooted) map while the registry is
        keyed by the subject (`X`-rooted) map. Defaults to the registry's
        bound identity for ordinary same-clock registrations.
        """
        identity = prefix_identity or self.arrival_map.identity
        key = _registry_key(
            resolution.transition,
            resolution.primitive_scope,
            identity,
        )
        if key in self._entries:
            raise ValueError(
                f'primitive registry key collision for '
                f'{resolution.transition.edge_id} under scope '
                f'{resolution.primitive_scope.scenario_id}; '
                f'attempted to register a duplicate'
            )
        self._entries[key] = resolution
        return key

    def get(
        self,
        transition: TransitionIdentity,
        primitive_scope: PrimitiveScope,
    ) -> Optional[PrimitiveEvidenceResolution]:
        key = _registry_key(transition, primitive_scope, self.arrival_map.identity)
        return self._entries.get(key)

    def keys(self) -> Tuple[str, ...]:
        return tuple(self._entries.keys())

    def __len__(self) -> int:
        return len(self._entries)

    def to_provenance_dict(self) -> Dict[str, Any]:
        """JSON-friendly dump for the shadow primitive inventory.

        Per plan §"Stop condition" line 629: ``the shadow primitive
        inventory is reviewable``. The dump records each primitive's
        binding decision, raw and weighted totals, and the topology
        case it was bound under. Reused by the response provenance
        block (plan §745)."""
        return {
            'identity_cache_key': self.arrival_map.identity.cache_key,
            'arrival_map_diagnostics': dict(
                self.arrival_map.construction_diagnostics
            ),
            'primitive_count': len(self._entries),
            'primitives': [
                {
                    'registry_key': key,
                    'transition': {
                        'source_node': res.transition.source_node,
                        'destination_node': res.transition.destination_node,
                        'edge_id': res.transition.edge_id,
                    },
                    'role': res.primitive_scope.evidence_role,
                    'date_from': res.primitive_scope.date_from,
                    'date_to': res.primitive_scope.date_to,
                    'as_at': res.primitive_scope.as_at,
                    'topology_case': res.diagnostics.topology_case,
                    'raw_total_n': res.raw_evidence_set.totals.n,
                    'raw_total_k': res.raw_evidence_set.totals.k,
                    'weighted_total_n': res.weighted_view.n_weighted_total,
                    'weighted_total_k': res.weighted_view.k_weighted_total,
                    'raw_point_count': res.diagnostics.raw_point_count,
                    'bound_point_count': res.diagnostics.bound_point_count,
                    'off_clock_rejection_count':
                        res.diagnostics.off_clock_rejection_count,
                }
                for key, res in self._entries.items()
            ],
        }


# ─── Span primitive metadata validator ─────────────────────────────────


@dataclass(frozen=True)
class SpanPrimitiveMetadata:
    """Metadata describing a prepared span primitive's identity.

    Used by ``validate_span_primitive`` to refuse spans that cross the
    ``X`` boundary or mix incompatible slice/context/regime/as-at
    metadata. The first implementation prefers edge primitives; the
    validator exists so the fallback path is testable."""
    span_node_ids: Tuple[str, ...]  # nodes the span covers, in topo order
    slice_metadata: str
    context_key: Optional[str]
    regime_key: Optional[str]
    as_at: Optional[str]


@dataclass(frozen=True)
class SpanValidationResult:
    accepted: bool
    rejection_reason: Optional[str]
    suggested_fallback: Optional[str]


def validate_span_primitive(
    *,
    span: SpanPrimitiveMetadata,
    carrier_closure: Tuple[str, ...],
    subject_closure: Tuple[str, ...],
    request_slice_metadata: str,
    request_context_key: Optional[str],
    request_regime_key: Optional[str],
    request_as_at: Optional[str],
) -> SpanValidationResult:
    """Reject a prepared span primitive if it crosses the ``X`` boundary
    or mixes incompatible metadata (plan §123, §619, §431).

    A span fits wholly inside one closure when all its nodes are in
    that closure's id set. Otherwise the composer must fall back to
    edge primitives.
    """
    in_carrier = set(span.span_node_ids).issubset(set(carrier_closure))
    in_subject = set(span.span_node_ids).issubset(set(subject_closure))
    if not (in_carrier or in_subject):
        return SpanValidationResult(
            accepted=False,
            rejection_reason=(
                'span crosses the X boundary; nodes are split between '
                'carrier closure and subject closure'
            ),
            suggested_fallback='edge_primitives',
        )
    metadata_pairs = (
        ('slice_metadata', span.slice_metadata, request_slice_metadata),
        ('context_key', span.context_key, request_context_key),
        ('regime_key', span.regime_key, request_regime_key),
        ('as_at', span.as_at, request_as_at),
    )
    for label, span_value, request_value in metadata_pairs:
        if span_value != request_value:
            return SpanValidationResult(
                accepted=False,
                rejection_reason=(
                    f'span {label}={span_value!r} does not match request '
                    f'{label}={request_value!r}'
                ),
                suggested_fallback='edge_primitives',
            )
    return SpanValidationResult(
        accepted=True,
        rejection_reason=None,
        suggested_fallback=None,
    )


# ─── Convenience helpers ───────────────────────────────────────────────


def make_primitive_scope_from_evidence_scope(
    *,
    evidence_scope: EvidenceScope,
    model_source_preference: str,
    resolved_source_identity: Optional[str],
) -> PrimitiveScope:
    """Project an EvidenceScope onto a PrimitiveScope.

    The PrimitiveScope is the registry's lookup identity; this helper
    derives one from the merge layer's scope so callers don't have to
    duplicate field-by-field plumbing."""
    return PrimitiveScope(
        scenario_id=evidence_scope.scenario_id or '',
        evidence_role=evidence_scope.role.value,
        date_from=evidence_scope.date_from,
        date_to=evidence_scope.date_to,
        as_at=evidence_scope.as_at,
        context_key=evidence_scope.context_key,
        regime_key=evidence_scope.regime_key,
        model_source_preference=model_source_preference,
        resolved_source_identity=resolved_source_identity,
        selected_anchor_days=tuple(evidence_scope.selected_anchor_days or ()),
    )


# Imports retained for re-export / type-checking convenience.
__all__ = [
    'PrimitiveBindingDiagnostics',
    'PrimitiveBindingError',
    'PrimitiveEvidenceResolution',
    'RequestPrimitiveRegistry',
    'RetrievalSupersetSpec',
    'SourceKind',
    'SpanPrimitiveMetadata',
    'SpanValidationResult',
    'bind_primitive_evidence',
    'derive_retrieval_superset',
    'make_primitive_scope_from_evidence_scope',
    'validate_span_primitive',
    'date',  # re-export for tests building EvidenceScope date strings
]
