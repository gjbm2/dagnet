"""
Request-scoped fetch envelope derivation.

Computes per-edge `anchor_day` fetch envelopes for the snapshot DB calls
that feed evidence into the cohort/window forecast pipeline. This is
the structural replacement for two pre-existing pieces of fetch
machinery:

  1. The 73n second-fetch widening inside
     `cohort_forecast_v3.build_resolved_cf_runtime`, which fired a
     supplementary `query_snapshots_for_sweep` for the subject edge
     when the prefix-arrival envelope reached past the public
     `anchor_to`. Subject-side, forward extension.

  2. The heuristic backward extension
     `lookback_days = max(axis_tau_max * 2, 60)` inside
     `_fetch_upstream_observations` (and a duplicated copy in
     `api_handlers.py`). Carrier-side, backward donor extension per
     `doc 29d §donor-fetch`.

Under the unified design (see
`docs/current/snapshot-fetch-envelope-design.md`), both extensions
fall out of the same primitive arrival-map mechanism. The branch on
`is_window` only selects the binding descriptor for each parameterised
edge; everything else is uniform.

Window mode (Appendix A pin in
`docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`):
each parameterised subject edge is local-clock-bound at its own source
node with identity weights over the public window. The fetch envelope
is exactly `[anchor_from, anchor_to]` for every parameterised subject
edge — single-hop, multi-hop, first edge, intermediate edge, last
edge — all identical. No propagation. No extension. The local-clock
binding admits every U-cohort with anchor_day in the public window
regardless of which X-cohort it descended from.

Cohort mode: two arrival maps. Subject sub-tree rooted at X with
identity root weights over the public window; carrier sub-tree rooted
at A with identity root weights over the public window extended
backward by the carrier-path latency tail for donor cohorts. Per-edge
envelope is `[min, max]` over `arrival_weight[source].keys()` from the
relevant map.

Per-primitive binding (`primitive_evidence.bind_primitive_evidence`)
filters fetched rows onto each primitive's local clock at admission,
so over-fetch is harmless: superset rows that don't bind to a given
primitive are rejected at binding with `off_clock_rejection_count`
recorded in diagnostics. The merge / binding / weighting layers are
unchanged by this module.

`as_at` is a retrieval-time admissibility gate, not an envelope clip:
the envelope is computed in full from primitive-local arrival weights;
`as_at` is preserved through `query_snapshots_for_sweep(... as_at=...)`
and admits rows by `retrieved_at <= as_at` at the merge layer. Do not
clip envelope dates by `as_at` here.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date as _date, timedelta as _timedelta
from typing import Any, Dict, List, Mapping, Optional, Tuple

from .lag_distribution_utils import log_normal_inverse_cdf
from .model_resolver import ResolvedModelParams, resolve_model_params
from .prefix_arrival import PrefixArrivalIdentity, PrefixArrivalMap, build_prefix_arrival_map
from .primitive_readout import _resolved_to_timing_transition
from .primitives import TransitionIdentity
from .span_kernel import _build_span_topology
from .timing_span import TimingTransitionPrimitive


# ─── Per-edge envelope ─────────────────────────────────────────────────


@dataclass(frozen=True)
class EdgeFetchEnvelope:
    """Per-edge `anchor_day` fetch bounds derived from binding descriptors."""

    edge_uuid: str
    edge_id: str
    role: str  # 'subject' or 'carrier'
    anchor_from: _date
    anchor_to: _date


@dataclass(frozen=True)
class RequestEnvelopePlan:
    """Per-request envelope plan covering every parameterised edge.

    `by_edge_uuid` and `by_edge_id` are alternative lookups for the
    same `EdgeFetchEnvelope`s — callers that hold either identifier can
    resolve their fetch bounds without re-walking the topology.

    Window mode populates `subject_arrival_map = None` and
    `carrier_arrival_map = None`: the per-edge envelopes are the public
    window for every parameterised subject edge under local-clock
    binding (Appendix A). Cohort mode populates `subject_arrival_map`
    (rooted at X) and, when `A != X`, `carrier_arrival_map` (rooted at
    A with backward donor extension).
    """

    is_window: bool
    public_anchor_from: _date
    public_anchor_to: _date
    subject_envelopes: Tuple[EdgeFetchEnvelope, ...]
    carrier_envelopes: Tuple[EdgeFetchEnvelope, ...]
    subject_arrival_map: Optional[PrefixArrivalMap] = None
    carrier_arrival_map: Optional[PrefixArrivalMap] = None
    diagnostics: Mapping[str, Any] = field(default_factory=dict)

    @property
    def by_edge_uuid(self) -> Mapping[str, EdgeFetchEnvelope]:
        out: Dict[str, EdgeFetchEnvelope] = {}
        for env in self.subject_envelopes:
            out[env.edge_uuid] = env
        for env in self.carrier_envelopes:
            out[env.edge_uuid] = env
        return out

    @property
    def by_edge_id(self) -> Mapping[str, EdgeFetchEnvelope]:
        out: Dict[str, EdgeFetchEnvelope] = {}
        for env in self.subject_envelopes:
            out[env.edge_id] = env
        for env in self.carrier_envelopes:
            out[env.edge_id] = env
        return out


# ─── Date helpers ──────────────────────────────────────────────────────


def _parse_iso(value: Any) -> Optional[_date]:
    if value is None:
        return None
    s = str(value)[:10]
    if not s:
        return None
    try:
        return _date.fromisoformat(s)
    except ValueError:
        return None


def _identity_root_weights(
    *, anchor_from: _date, anchor_to: _date,
) -> Dict[str, float]:
    weights: Dict[str, float] = {}
    if anchor_from > anchor_to:
        return weights
    cur = anchor_from
    while cur <= anchor_to:
        weights[cur.isoformat()] = 1.0
        cur = cur + _timedelta(days=1)
    return weights


def _resolved_path_tail_days(
    resolutions: List[Tuple[TransitionIdentity, ResolvedModelParams]],
) -> int:
    """Return `max(t95 + onset)` over the given resolved primitives.

    Used as the principled donor-fetch backward extension on the
    carrier root: A-cohorts older than this tail produce no in-window
    observations on any carrier primitive's local clock.

    Returns 0 when no resolution carries usable lognormal latency
    parameters (no donor extension applies).
    """
    longest = 0.0
    for _transition, resolved in resolutions:
        lat = getattr(resolved, "latency", None)
        if lat is None:
            continue
        sigma = float(getattr(lat, "sigma", 0.0) or 0.0)
        mu = float(getattr(lat, "mu", 0.0) or 0.0)
        onset = float(getattr(lat, "onset_delta_days", 0.0) or 0.0)
        if sigma <= 0:
            continue
        try:
            t95 = log_normal_inverse_cdf(0.95, mu, sigma)
        except Exception:
            continue
        longest = max(longest, onset + t95)
    return int(math.ceil(longest))


def _edge_uuid_id(edge_dict: Mapping[str, Any], from_id: str, to_id: str) -> Tuple[str, str]:
    edge_id = str(
        edge_dict.get("edge_id")
        or edge_dict.get("id")
        or f"{from_id}->{to_id}"
    )
    edge_uuid = str(edge_dict.get("uuid") or edge_id)
    return edge_uuid, edge_id


def _build_resolutions_for_subtree(
    *,
    graph: Mapping[str, Any],
    from_node: str,
    to_node: str,
    temporal_mode: str,
    graph_preference: Optional[str],
) -> Tuple[List[Tuple[TransitionIdentity, ResolvedModelParams]], List[Tuple[str, str, Mapping[str, Any]]]]:
    """Resolve every parameterised edge on the `from_node → to_node` path.

    Returns:
        (resolutions, edges) where:
          - `resolutions` is the per-edge `(TransitionIdentity, ResolvedModelParams)`
            pairs the prefix-arrival builder consumes;
          - `edges` is the matching list of `(from_id, to_id, edge_dict)` triples
            for envelope derivation.

    Edges whose `resolve_model_params` returns `None` are skipped — they
    contribute nothing to arrival propagation. The caller decides
    whether their fetch still needs to fire (it does not, in the
    structural fix: missing resolutions mean an unparameterised edge,
    which has no snapshot rows to fetch).
    """
    topo = _build_span_topology(dict(graph), str(from_node), str(to_node))
    if topo is None:
        return [], []

    resolutions: List[Tuple[TransitionIdentity, ResolvedModelParams]] = []
    edges: List[Tuple[str, str, Mapping[str, Any]]] = []
    for from_id, to_id, edge_dict in topo.edge_list:
        edge_uuid, edge_id = _edge_uuid_id(edge_dict, from_id, to_id)
        resolved = resolve_model_params(
            edge_dict,
            scope="edge",
            temporal_mode=temporal_mode,
            graph_preference=graph_preference,
        )
        if not resolved:
            continue
        ti = TransitionIdentity(
            source_node=str(from_id),
            destination_node=str(to_id),
            edge_id=edge_id,
        )
        resolutions.append((ti, resolved))
        edges.append((str(from_id), str(to_id), edge_dict))
    return resolutions, edges


def _envelope_from_arrival_map(
    *,
    arrival_map: PrefixArrivalMap,
    source_node: str,
    fallback_anchor_from: _date,
    fallback_anchor_to: _date,
) -> Tuple[_date, _date]:
    """Per-edge envelope = `[min, max]` of `arrival_weight[source].keys()`.

    Falls back to the public anchor window when the source node is
    absent or degraded — the per-primitive binder will still admit
    in-window rows under fallback identity binding.
    """
    entry = arrival_map.get(source_node)
    if entry is None or entry.is_degraded or not entry.weights:
        return fallback_anchor_from, fallback_anchor_to
    days = sorted(entry.weights.keys())
    earliest = _parse_iso(days[0]) or fallback_anchor_from
    latest = _parse_iso(days[-1]) or fallback_anchor_to
    if earliest > latest:
        earliest, latest = latest, earliest
    return earliest, latest


def _fingerprint(
    *,
    is_window: bool,
    query_from_node: str,
    query_to_node: str,
    anchor_node_id: Optional[str],
    anchor_from: _date,
    anchor_to: _date,
    graph_preference: Optional[str],
) -> str:
    return "|".join(
        (
            "request_envelope.v1",
            "window" if is_window else "cohort",
            str(query_from_node),
            str(query_to_node),
            str(anchor_node_id or ""),
            anchor_from.isoformat(),
            anchor_to.isoformat(),
            str(graph_preference or "best_available"),
        )
    )


# ─── Public API ────────────────────────────────────────────────────────


def build_request_envelope_plan(
    *,
    graph: Mapping[str, Any],
    query_from_node: str,
    query_to_node: str,
    anchor_node_id: Optional[str],
    anchor_from: _date,
    anchor_to: _date,
    is_window: bool,
    graph_preference: Optional[str] = None,
    as_at: Optional[str] = None,
    scenario_id: Optional[str] = None,
    max_tau: int = 400,
) -> RequestEnvelopePlan:
    """Build the per-request envelope plan for every parameterised edge.

    See module docstring for the binding rules. The returned plan
    contains `EdgeFetchEnvelope`s keyed by edge identity for every
    parameterised subject and carrier edge in the request topology.

    Window mode produces public-window envelopes for every subject edge
    and no arrival maps (per-primitive local-clock binding has no
    shared map).

    Cohort mode produces:
      - subject envelopes from the X-rooted arrival map (forward
        extension only — subject root weights are identity over the
        public window with no backward extension);
      - carrier envelopes from the A-rooted arrival map with root
        weights extended backward by `max(t95 + onset)` over the
        carrier sub-tree's resolved primitives (donor extension per
        `doc 29d §donor-fetch`).
    """
    fallback = RequestEnvelopePlan(
        is_window=bool(is_window),
        public_anchor_from=anchor_from,
        public_anchor_to=anchor_to,
        subject_envelopes=(),
        carrier_envelopes=(),
        diagnostics={"reason": "empty_subject_topology"},
    )

    subject_topo = _build_span_topology(
        dict(graph), str(query_from_node), str(query_to_node)
    )
    if subject_topo is None or not subject_topo.edge_list:
        return fallback

    # Window mode: public window for every parameterised subject edge.
    if is_window:
        envs: List[EdgeFetchEnvelope] = []
        for from_id, to_id, edge_dict in subject_topo.edge_list:
            edge_uuid, edge_id = _edge_uuid_id(edge_dict, from_id, to_id)
            envs.append(
                EdgeFetchEnvelope(
                    edge_uuid=edge_uuid,
                    edge_id=edge_id,
                    role="subject",
                    anchor_from=anchor_from,
                    anchor_to=anchor_to,
                )
            )
        return RequestEnvelopePlan(
            is_window=True,
            public_anchor_from=anchor_from,
            public_anchor_to=anchor_to,
            subject_envelopes=tuple(envs),
            carrier_envelopes=(),
            diagnostics={
                "binding": "window_local_clock",
                "subject_edge_count": len(envs),
            },
        )

    # Cohort mode: subject map rooted at X, carrier map rooted at A.
    subject_resolutions, subject_edges = _build_resolutions_for_subtree(
        graph=graph,
        from_node=str(query_from_node),
        to_node=str(query_to_node),
        temporal_mode="cohort",
        graph_preference=graph_preference,
    )

    has_carrier = bool(
        anchor_node_id
        and str(anchor_node_id) != str(query_from_node)
    )
    carrier_resolutions: List[Tuple[TransitionIdentity, ResolvedModelParams]] = []
    carrier_edges: List[Tuple[str, str, Mapping[str, Any]]] = []
    if has_carrier:
        carrier_resolutions, carrier_edges = _build_resolutions_for_subtree(
            graph=graph,
            from_node=str(anchor_node_id),
            to_node=str(query_from_node),
            temporal_mode="cohort",
            graph_preference=graph_preference,
        )

    diagnostics: Dict[str, Any] = {
        "binding": "cohort_anchored_clock",
        "subject_resolutions": len(subject_resolutions),
        "carrier_resolutions": len(carrier_resolutions),
    }

    fingerprint = _fingerprint(
        is_window=is_window,
        query_from_node=str(query_from_node),
        query_to_node=str(query_to_node),
        anchor_node_id=str(anchor_node_id or ""),
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        graph_preference=graph_preference,
    )

    # Subject arrival map rooted at X.
    subject_arrival_map: Optional[PrefixArrivalMap] = None
    if subject_resolutions:
        subject_root_weights = _identity_root_weights(
            anchor_from=anchor_from, anchor_to=anchor_to,
        )
        subject_identity = PrefixArrivalIdentity(
            scenario_id=str(scenario_id or ""),
            request_root=str(query_from_node),
            context_key=None,
            regime_key=None,
            as_at=as_at,
            model_source_preference=str(graph_preference or "best_available"),
            parameter_fingerprint=fingerprint + "|subject",
        )
        subject_transitions: Dict[Tuple[str, str], TimingTransitionPrimitive] = {}
        for transition, resolved in subject_resolutions:
            subject_transitions[
                (transition.source_node, transition.destination_node)
            ] = _resolved_to_timing_transition(
                transition=transition, resolved=resolved
            )
        subject_target_nodes: List[str] = []
        seen: set[str] = set()
        for transition, _ in subject_resolutions:
            for n in (transition.source_node, transition.destination_node):
                if n not in seen:
                    seen.add(n)
                    subject_target_nodes.append(n)
        subject_arrival_map = build_prefix_arrival_map(
            graph=dict(graph),
            root_node_id=str(query_from_node),
            root_day_weights=subject_root_weights,
            transitions=subject_transitions,
            identity=subject_identity,
            max_tau=max_tau,
            target_node_ids=tuple(subject_target_nodes) if subject_target_nodes else None,
        )

    # Carrier arrival map rooted at A with backward donor extension.
    carrier_arrival_map: Optional[PrefixArrivalMap] = None
    donor_lookback_days = 0
    if has_carrier and carrier_resolutions:
        donor_lookback_days = _resolved_path_tail_days(carrier_resolutions)
        diagnostics["donor_lookback_days"] = donor_lookback_days
        donor_anchor_from = anchor_from - _timedelta(days=donor_lookback_days)
        carrier_root_weights = _identity_root_weights(
            anchor_from=donor_anchor_from, anchor_to=anchor_to,
        )
        carrier_identity = PrefixArrivalIdentity(
            scenario_id=str(scenario_id or ""),
            request_root=str(anchor_node_id),
            context_key=None,
            regime_key=None,
            as_at=as_at,
            model_source_preference=str(graph_preference or "best_available"),
            parameter_fingerprint=fingerprint + f"|carrier|donor={donor_lookback_days}",
        )
        carrier_transitions: Dict[Tuple[str, str], TimingTransitionPrimitive] = {}
        for transition, resolved in carrier_resolutions:
            carrier_transitions[
                (transition.source_node, transition.destination_node)
            ] = _resolved_to_timing_transition(
                transition=transition, resolved=resolved
            )
        carrier_target_nodes: List[str] = []
        seen = set()
        for transition, _ in carrier_resolutions:
            for n in (transition.source_node, transition.destination_node):
                if n not in seen:
                    seen.add(n)
                    carrier_target_nodes.append(n)
        carrier_arrival_map = build_prefix_arrival_map(
            graph=dict(graph),
            root_node_id=str(anchor_node_id),
            root_day_weights=carrier_root_weights,
            transitions=carrier_transitions,
            identity=carrier_identity,
            max_tau=max_tau,
            target_node_ids=tuple(carrier_target_nodes) if carrier_target_nodes else None,
        )

    # Per-edge envelopes.
    subject_envs: List[EdgeFetchEnvelope] = []
    for from_id, to_id, edge_dict in subject_edges:
        edge_uuid, edge_id = _edge_uuid_id(edge_dict, from_id, to_id)
        if subject_arrival_map is None:
            af, at = anchor_from, anchor_to
        else:
            af, at = _envelope_from_arrival_map(
                arrival_map=subject_arrival_map,
                source_node=str(from_id),
                fallback_anchor_from=anchor_from,
                fallback_anchor_to=anchor_to,
            )
        subject_envs.append(
            EdgeFetchEnvelope(
                edge_uuid=edge_uuid,
                edge_id=edge_id,
                role="subject",
                anchor_from=af,
                anchor_to=at,
            )
        )

    carrier_envs: List[EdgeFetchEnvelope] = []
    if carrier_arrival_map is not None:
        for from_id, to_id, edge_dict in carrier_edges:
            edge_uuid, edge_id = _edge_uuid_id(edge_dict, from_id, to_id)
            af, at = _envelope_from_arrival_map(
                arrival_map=carrier_arrival_map,
                source_node=str(from_id),
                fallback_anchor_from=anchor_from - _timedelta(days=donor_lookback_days),
                fallback_anchor_to=anchor_to,
            )
            carrier_envs.append(
                EdgeFetchEnvelope(
                    edge_uuid=edge_uuid,
                    edge_id=edge_id,
                    role="carrier",
                    anchor_from=af,
                    anchor_to=at,
                )
            )

    return RequestEnvelopePlan(
        is_window=False,
        public_anchor_from=anchor_from,
        public_anchor_to=anchor_to,
        subject_envelopes=tuple(subject_envs),
        carrier_envelopes=tuple(carrier_envs),
        subject_arrival_map=subject_arrival_map,
        carrier_arrival_map=carrier_arrival_map,
        diagnostics=diagnostics,
    )


def envelope_for_edge(
    plan: RequestEnvelopePlan,
    *,
    edge_uuid: Optional[str] = None,
    edge_id: Optional[str] = None,
) -> Optional[EdgeFetchEnvelope]:
    """Resolve an edge's envelope from a plan by uuid or edge_id."""
    if edge_uuid:
        env = plan.by_edge_uuid.get(str(edge_uuid))
        if env is not None:
            return env
    if edge_id:
        return plan.by_edge_id.get(str(edge_id))
    return None
