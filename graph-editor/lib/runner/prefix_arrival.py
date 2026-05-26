"""
Request-scoped prefix-arrival map.

Builds the ``arrival_weight[node_id][calendar_day]`` map that primitive
evidence resolution consumes. The map records, for each primitive source
node ``U`` reachable in the request topology, a normalised distribution
over calendar days representing ``of the units that ever arrive at U,
what fraction arrived on each day``.

This request-scoped abstraction builds calendar-day keyed arrival
weights from the same role-neutral timing algebra used by runtime
carrier and subject spans. It is keyed by request identity (scenario id,
request root, context/case scope, regime or hash family, as-at boundary,
model-source preference, and parameter fingerprint).

Critical invariants this module pins:

  - No second timing implementation. Every prefix delay PMF the map
    consumes comes from ``timing_span``'s role-neutral timing algebra.
    Identity / structurally non-latency / deterministic-onset / latent
    prefixes are all natural degeneracies of the same composer call,
    NOT a separate timing path (plan §605, baseline §3.2).
  - The map is built once per request and reused across primitives
    (plan §195). Two primitives sharing a source node ``U`` MUST see
    the same ``NodeArrivalWeights`` object (object identity); the
    builder MUST NOT recompute root → U for each primitive.
  - Cases recorded as degraded or unsupported in Stage 0c (today: only
    ``no_path`` / ``horizon_inadequate``) produce a degraded entry with
    explicit provenance, never a silently approximate weight.
  - The map is calendar-day keyed (ISO ``YYYY-MM-DD``), so the
    primitive evidence binding layer can multiply admitted rows by the
    weight on the row's ``observed_date``.

This module imports only source-layer transition shapes, the shared
timing algebra, and stdlib + numpy. It does NOT import from
``forecast_runtime``, ``forecast_state``, ``cohort_forecast_v3``,
``evidence_merge``, or ``primitive_evidence`` — construction can be
tested without invoking conditioning consumers (plan §609).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Dict, Mapping, Optional, Tuple

import numpy as np

from .bucket_transition import cdf_to_bucket_transition
from .primitives import DEFAULT_DRAW_COUNT
from .timing_span import (
    TimingTransitionPrimitive,
    compose_terminal_node_density_per_draw,
    compose_timing_span_from_densities,
    compose_timing_span_from_transition_primitives,
)
from .timing_particles import (
    EdgeTimingParticles,
    RequestTimingParticles,
    build_per_draw_edge_cdf,
)


# ─── Identity ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PrefixArrivalIdentity:
    """Request-scoped key for one prefix-arrival map.

    Two requests sharing this identity can share a map. The fields are
    the union of the primitive registry key (plan §145) and the items
    Stage 0c §3.2 names as load-bearing for prefix-arrival construction.
    """
    scenario_id: str
    request_root: str
    context_key: Optional[str]
    regime_key: Optional[str]
    as_at: Optional[str]
    model_source_preference: str
    parameter_fingerprint: str
    context_selector: Optional[str] = None

    def canonical_string(self) -> str:
        # v2 (Atom 2): scenario_id dropped — caller-context label, not
        # part of the prefix-arrival map's mathematical identity.
        return "|".join((
            "73n.prefix_arrival_identity.v3.bucket_transition",
            f"root={self.request_root}",
            f"context={self.context_key or ''}",
            f"context_selector={self.context_selector or ''}",
            f"regime={self.regime_key or ''}",
            f"as_at={self.as_at or ''}",
            f"source_pref={self.model_source_preference}",
            f"fingerprint={self.parameter_fingerprint}",
        ))

    @property
    def cache_key(self) -> str:
        return hashlib.sha256(
            self.canonical_string().encode("utf-8")
        ).hexdigest()[:16]


# ─── Per-node payload ──────────────────────────────────────────────────


@dataclass(frozen=True)
class NodeArrivalProvenance:
    """Provenance for one node's arrival_weight entry.

    ``topology_case`` is one of:

      - ``identity``: the node is the request root.
      - ``composed``: shared timing composition returned an active span.
      - ``degraded``: ``no_path`` or ``horizon_inadequate``; the entry
        carries no usable weights and primitives consuming it MUST NOT
        live-condition.

    ``transition_source`` is the aggregate per-prefix transition source
    label (e.g. ``prior_analytic`` / ``prior_bayesian`` / mixed) for
    diagnostic correlation with the timing-span composer.
    """
    topology_case: str
    composed_edges: int
    has_latency_edge: bool
    transition_source: str
    horizon_ratio: float
    note: str = ''


@dataclass(frozen=True)
class NodeArrivalWeights:
    """One node's normalised calendar-day arrival distribution.

    ``weights`` is the scalar (marginal-mean) calendar-day distribution.
    ``weights_draws`` is the per-draw sibling — a calendar-day-keyed
    mapping whose values are ``(S,)`` arrays of per-draw arrival weights
    at that day, where ``S = draw_count``. The two surfaces describe
    the same physical quantity at different levels of marginalisation:
    ``weights[day] = mean(weights_draws[day])`` (up to numerical
    rounding).

    Per Phase 6 §3.2 / §4.9, primitive admission and evidence display
    consume ``weights_draws`` so that the latency map used to weight
    evidence at U is per-draw consistent with the latency kernel that
    propagates mass to U. The scalar ``weights`` surface is retained
    for diagnostics and legacy consumers (envelope construction, etc.).

    ``weights`` sums to 1.0 for non-degraded entries. Degraded entries
    carry empty mappings on both surfaces; the provenance
    ``topology_case`` distinguishes "no path from root" from "horizon
    inadequate".
    """
    weights: Mapping[str, float]
    weights_draws: Mapping[str, np.ndarray]
    draw_count: int
    reach_from_root: float
    provenance: NodeArrivalProvenance
    root_day_contributions: Mapping[str, Mapping[str, float]] = field(default_factory=dict)

    @property
    def is_degraded(self) -> bool:
        return self.provenance.topology_case == 'degraded'

    def weight_on(self, calendar_day: str) -> float:
        return float(self.weights.get(calendar_day, 0.0))

    def weight_draws_on(self, calendar_day: str) -> np.ndarray:
        """Per-draw weight at ``calendar_day``; shape ``(S,)``.

        Returns zeros for days outside the support. Same lookup
        semantics as ``weight_on`` (which returns scalar 0.0 for absent
        days) — algebraic degeneracy of the "no mass arrived here on
        this day under any draw" data state.
        """
        result = self.weights_draws.get(calendar_day)
        if result is None:
            return np.zeros(self.draw_count, dtype=np.float64)
        return result

    def root_day_shares_on(self, calendar_day: str) -> Mapping[str, float]:
        total = self.weight_on(calendar_day)
        if total <= 0.0:
            return {}
        contributions = self.root_day_contributions.get(calendar_day, {})
        if not contributions:
            return {}
        return {
            str(root_day): float(weight) / total
            for root_day, weight in contributions.items()
            if float(weight) > 0.0
        }


# ─── The map ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PrefixArrivalMap:
    """Request-scoped ``arrival_weight[node_id][calendar_day]`` map.

    Keys are canonical node ids. The root entry is always present and
    carries ``reach_from_root=1.0``. ``draw_count`` is the per-draw
    axis size shared by every node's ``weights_draws`` surface.

    Consumers MUST query through ``get`` (which returns ``None`` for
    unknown nodes) so that misspelled or absent node ids fail loudly
    rather than silently returning empty weights.
    """
    identity: PrefixArrivalIdentity
    nodes: Mapping[str, NodeArrivalWeights]
    max_tau: int
    draw_count: int
    root_day_weights: Mapping[str, float]
    construction_diagnostics: Mapping[str, Any] = field(default_factory=dict)

    def get(self, node_id: str) -> Optional[NodeArrivalWeights]:
        return self.nodes.get(node_id)

    def __contains__(self, node_id: str) -> bool:
        return node_id in self.nodes

    @property
    def degraded_nodes(self) -> Tuple[str, ...]:
        return tuple(
            sorted(
                node_id
                for node_id, weights in self.nodes.items()
                if weights.is_degraded
            )
        )


# ─── Builder ───────────────────────────────────────────────────────────


def _normalise(weights: Mapping[str, float]) -> Dict[str, float]:
    total = float(sum(weights.values()))
    if total <= 0:
        return {}
    return {k: float(v) / total for k, v in weights.items() if v != 0}


def _shift_pmf_to_calendar(
    *,
    root_day_weights: Mapping[str, float],
    pmf: np.ndarray,
) -> Tuple[Dict[str, float], Dict[str, Dict[str, float]]]:
    """Convolve a normalised root day distribution with a delay PMF.

    For each root day ``d_root`` with weight ``w`` and each tau ``t``
    with PMF mass ``pmf[t]``, contribute ``w * pmf[t]`` to arrival at
    calendar day ``d_root + t`` (integer days).
    """
    result: Dict[str, float] = {}
    contributions: Dict[str, Dict[str, float]] = {}
    for d_root, w_root in root_day_weights.items():
        if w_root <= 0:
            continue
        try:
            base = date.fromisoformat(d_root)
        except ValueError:
            # Malformed root day — skip rather than corrupt the map. The
            # caller's provenance will surface this via construction
            # diagnostics.
            continue
        for t, mass in enumerate(pmf):
            if mass <= 0:
                continue
            day = (base + timedelta(days=int(t))).isoformat()
            contribution = float(w_root) * float(mass)
            result[day] = result.get(day, 0.0) + contribution
            by_root = contributions.setdefault(day, {})
            by_root[d_root] = by_root.get(d_root, 0.0) + contribution
    return result, contributions


def _shift_pmf_draws_to_calendar(
    *,
    root_day_weights: Mapping[str, float],
    pmf_draws: np.ndarray,
) -> Dict[str, np.ndarray]:
    """Per-draw analog of ``_shift_pmf_to_calendar``.

    ``pmf_draws`` is ``(S, T_p)``. For each root day ``d_root`` with
    weight ``w_root`` (scalar — root-day weights are deterministic at
    the request perimeter), accumulate ``w_root * pmf_draws[:, t]``
    into the ``(S,)`` array at calendar day ``d_root + t``. The
    per-draw axis is preserved end-to-end.
    """
    S = int(pmf_draws.shape[0])
    T = int(pmf_draws.shape[1])
    result: Dict[str, np.ndarray] = {}
    for d_root, w_root in root_day_weights.items():
        if w_root <= 0:
            continue
        try:
            base = date.fromisoformat(d_root)
        except ValueError:
            continue
        w = float(w_root)
        for t in range(T):
            day = (base + timedelta(days=int(t))).isoformat()
            contribution = w * pmf_draws[:, t]
            existing = result.get(day)
            if existing is None:
                result[day] = contribution.astype(np.float64, copy=True)
            else:
                existing += contribution
    return result


def _normalise_per_draw(
    weights_draws: Mapping[str, np.ndarray],
    draw_count: int,
) -> Dict[str, np.ndarray]:
    """Normalise per-draw calendar weights so each draw sums to 1.

    Divides each ``(S,)`` entry pointwise by the per-draw total. Draws
    with zero total stay zero (algebraic degeneracy: a draw whose
    composed latency PMF was zero everywhere has no mass to normalise).
    """
    if not weights_draws:
        return {}
    totals = np.zeros(draw_count, dtype=np.float64)
    for arr in weights_draws.values():
        totals += arr
    safe_totals = np.where(totals > 0.0, totals, 1.0)
    result: Dict[str, np.ndarray] = {}
    for day, arr in weights_draws.items():
        normalised = arr / safe_totals
        if np.any(normalised > 0.0):
            result[day] = normalised
    return result


def build_prefix_arrival_map(
    *,
    graph: Mapping[str, Any],
    root_node_id: str,
    root_day_weights: Mapping[str, float],
    transitions: Mapping[Tuple[str, str], TimingTransitionPrimitive],
    timing_particles: Optional[RequestTimingParticles] = None,
    draw_count: int = DEFAULT_DRAW_COUNT,
    identity: PrefixArrivalIdentity,
    max_tau: int = 400,
    target_node_ids: Optional[Tuple[str, ...]] = None,
) -> PrefixArrivalMap:
    """Build the request-scoped prefix-arrival map.

    Args:
        graph: The contexted scenario graph (nodes/edges).
        root_node_id: The request root. For ``window()`` the subject's
            from-node; for ``cohort()`` the anchor node ``A``.
        root_day_weights: Calendar-day-keyed map of root-day weights.
            Selected source-window denominator mass for ``window()``;
            selected anchor population mass for ``cohort()``. Need not
            be normalised — the builder normalises within each entry's
            own scope.
        transitions: The contexted/source-selected source-layer
            transition primitives the carrier composer consumes. The
            same primitive registry that Stage 1 pinned is used; the
            mapping is keyed by ``(from_canonical_id, to_canonical_id)``.
        identity: Request-scoped key.
        max_tau: Day-grid horizon for prefix delay PMFs.
        target_node_ids: Optional restriction to a subset of nodes
            (e.g., only the source nodes of primitives the request
            actually needs). When ``None``, the map covers every node
            in the graph.

    Returns:
        ``PrefixArrivalMap``. The root entry is always populated with
        the normalised ``root_day_weights``. Each non-root node's entry
        is either composed (active carrier from root) or degraded
        (``no_path`` / ``horizon_inadequate``).

    Construction order is graph topological order in the sense that the
    underlying ``timing_span`` invocations for each non-root node use the
    same DAG algebra. The result is keyed by canonical node id; consumers
    query through ``PrefixArrivalMap.get``.
    """
    # The root's own entry holds ``root_day_weights`` AS-IS. Callers
    # supply per-day mass on the root's clock — for window(X-Y) the
    # natural input is the identity mask ``{d: 1.0 for d in window}``,
    # which the binder then applies as a row-membership multiplier
    # (weight 1.0 → row's full evidence pressure preserved). For
    # cohort(A=X) the input is the anchor cohort's per-day population.
    # The builder does NOT normalise the root entry: identity-mask
    # input must produce identity-mask output, otherwise window-mode
    # rows would be deflated by 1/N. Downstream convolution still uses
    # an internally normalised copy so the composed PMFs stay
    # probability distributions over arrival days.
    normalised_root = _normalise(root_day_weights)
    root_canonical = _canonicalise(graph, root_node_id)
    # Perimeter normalisation: callers that don't yet plumb per-draw
    # particles (e.g. preparation-layer envelope construction, unit
    # tests with deterministic priors) get an algebraic-degenerate
    # per-draw map built from each edge's mean parameters with zero
    # dispersion, broadcast across ``draw_count``. The engine flow
    # downstream is uniform — particles are always present after this
    # entry-point check.
    using_degenerate_particles = timing_particles is None
    if timing_particles is None:
        S_degenerate = int(draw_count)
        degenerate_particles: Dict[Tuple[str, str], EdgeTimingParticles] = {}
        for edge_key, primitive in transitions.items():
            degenerate_particles[edge_key] = EdgeTimingParticles(
                mu_draws=np.full(
                    S_degenerate, float(primitive.mu), dtype=np.float64,
                ),
                sigma_draws=np.clip(
                    np.full(
                        S_degenerate, float(primitive.sigma), dtype=np.float64,
                    ),
                    0.01, 20.0,
                ),
                onset_draws=np.maximum(
                    np.full(
                        S_degenerate, float(primitive.onset), dtype=np.float64,
                    ),
                    0.0,
                ),
                draw_count=S_degenerate,
            )
        timing_particles = RequestTimingParticles(
            particles_by_edge=degenerate_particles,
            draw_count=S_degenerate,
        )
    S = int(timing_particles.draw_count)
    # Root's per-draw weights are the identity broadcast — under every
    # draw, the root arrival distribution on its own clock is the same
    # root-day mass function. Algebraic degeneracy: root → root latency
    # is a Dirac at τ=0, independent of any latency-parameter sample.
    root_scalar_weights = {
        k: float(v) for k, v in root_day_weights.items() if v > 0
    }
    root_draws_weights: Dict[str, np.ndarray] = {
        k: np.full(S, float(v), dtype=np.float64)
        for k, v in root_day_weights.items()
        if v > 0
    }
    nodes: Dict[str, NodeArrivalWeights] = {
        root_canonical: NodeArrivalWeights(
            weights=root_scalar_weights,
            weights_draws=root_draws_weights,
            draw_count=S,
            reach_from_root=1.0,
            provenance=NodeArrivalProvenance(
                topology_case='identity',
                composed_edges=0,
                has_latency_edge=False,
                transition_source='identity',
                horizon_ratio=1.0,
                note='root node (raw root_day_weights)',
            ),
            root_day_contributions={
                k: {k: float(v)}
                for k, v in root_day_weights.items()
                if v > 0
            },
        ),
    }

    diagnostics: Dict[str, Any] = {
        'composed_count': 0,
        'degraded_count': 0,
        'no_path_count': 0,
        'horizon_inadequate_count': 0,
    }

    candidate_node_ids = _enumerate_node_ids(graph, target_node_ids)
    transitions_dict = dict(transitions)

    for raw_node_id in candidate_node_ids:
        canonical = _canonicalise(graph, raw_node_id)
        if canonical == root_canonical or canonical in nodes:
            continue

        timing = compose_timing_span_from_transition_primitives(
            graph=dict(graph),
            root_node_id=root_canonical,
            end_node_id=canonical,
            transitions=transitions_dict,
            max_tau=max_tau,
        )

        if timing.is_composed and timing.horizon_ratio >= 0.95:
            cdf = timing.conditional_cdf
            if cdf is None:
                # Active carrier with no deterministic CDF should not
                # occur post-Stage-2 of 73m, but guard against it.
                nodes[canonical] = _degraded(
                    note='active timing without conditional_cdf',
                    horizon_ratio=timing.horizon_ratio,
                    transition_source=timing.transition_source,
                    draw_count=S,
                )
                diagnostics['degraded_count'] += 1
                continue
            pmf = cdf_to_bucket_transition(
                f"prefix_arrival::{root_canonical}->{canonical}",
                np.asarray(cdf, dtype=float),
                family="prefix_arrival",
            ).value[0]
            # Numerical clean-up: clip tiny negatives from floating
            # point and drop entries that sum to zero (would happen
            # for a saturated CDF whose differences vanish past
            # max_tau).
            pmf = np.clip(pmf, 0.0, None)
            if float(pmf.sum()) <= 0:
                nodes[canonical] = _degraded(
                    note=(
                        'composed timing produced zero-mass PMF '
                        '(unexpected)'
                    ),
                    horizon_ratio=timing.horizon_ratio,
                    transition_source=timing.transition_source,
                    draw_count=S,
                )
                diagnostics['degraded_count'] += 1
                continue
            calendar, calendar_contributions = _shift_pmf_to_calendar(
                root_day_weights=normalised_root,
                pmf=pmf,
            )
            calendar_total = float(sum(calendar.values()))
            calendar_norm = _normalise(calendar)
            if not calendar_norm:
                nodes[canonical] = _degraded(
                    note='convolution produced empty calendar weights',
                    horizon_ratio=timing.horizon_ratio,
                    transition_source=timing.transition_source,
                    draw_count=S,
                )
                diagnostics['degraded_count'] += 1
                continue
            if using_degenerate_particles:
                # No caller-supplied timing particles means the request
                # perimeter asked for a deterministic diagnostic surface:
                # broadcast the scalar bucket-K PMF so weights and
                # weights_draws remain the same distribution at different
                # marginalisation levels.
                per_draw_pmf = np.repeat(pmf[None, :], S, axis=0)
            else:
                # Per-draw composition over the same topology: for every
                # draw s, compose the per-draw edge densities through the
                # shared DAG DP. The same keyed timing particles drive
                # both this composition and the primitive-conditioning
                # proposal (Phase 6 §3.2 single-source-of-truth invariant).
                per_draw_pmf = _compose_per_draw_pmf_at_end(
                    graph=dict(graph),
                    root_canonical=root_canonical,
                    end_canonical=canonical,
                    transitions=transitions_dict,
                    timing_particles=timing_particles,
                    max_tau=max_tau,
                )
            calendar_draws_raw = _shift_pmf_draws_to_calendar(
                root_day_weights=normalised_root,
                pmf_draws=per_draw_pmf,
            )
            calendar_draws_norm = _normalise_per_draw(
                calendar_draws_raw, draw_count=S,
            )
            nodes[canonical] = NodeArrivalWeights(
                weights=calendar_norm,
                weights_draws=calendar_draws_norm,
                draw_count=S,
                reach_from_root=float(timing.reach),
                provenance=NodeArrivalProvenance(
                    topology_case='composed',
                    composed_edges=timing.composed_edges,
                    has_latency_edge=timing.has_latency_edge,
                    transition_source=timing.transition_source,
                    horizon_ratio=timing.horizon_ratio,
                    note='',
                ),
                root_day_contributions={
                    day: {
                        root_day: (
                            float(weight) / calendar_total
                            if calendar_total > 0.0 else 0.0
                        )
                        for root_day, weight in by_root.items()
                        if weight > 0.0
                    }
                    for day, by_root in calendar_contributions.items()
                    if day in calendar_norm and calendar_total > 0.0
                },
            )
            diagnostics['composed_count'] += 1
            continue

        # Non-composed timings: no_path, horizon_inadequate, identity
        # (handled above). Degraded with reason.
        note = str(timing.provenance.get('note', 'unavailable timing'))
        if note == 'no path':
            diagnostics['no_path_count'] += 1
            nodes[canonical] = _degraded(
                note='no path from root',
                horizon_ratio=timing.horizon_ratio,
                transition_source=timing.transition_source,
                draw_count=S,
            )
            diagnostics['degraded_count'] += 1
        elif timing.horizon_ratio < 0.95 and timing.composed_edges > 0:
            diagnostics['horizon_inadequate_count'] += 1
            nodes[canonical] = _degraded(
                note=(
                    f'horizon inadequate '
                    f'(ratio={timing.horizon_ratio:.4f})'
                ),
                horizon_ratio=timing.horizon_ratio,
                transition_source=timing.transition_source,
                draw_count=S,
            )
            diagnostics['degraded_count'] += 1
        else:
            # Identity from a non-root node should not happen — the
            # composer only returns identity for window mode (we pass
            # is_window=False) or A==X (we skip the root). Belt and
            # braces.
            nodes[canonical] = _degraded(
                note=(
                    f'unexpected non-active tier '
                    f'{timing.topology_case!r}: {note}'
                ),
                horizon_ratio=timing.horizon_ratio,
                transition_source=timing.transition_source,
                draw_count=S,
            )
            diagnostics['degraded_count'] += 1

    return PrefixArrivalMap(
        identity=identity,
        nodes=nodes,
        max_tau=max_tau,
        draw_count=S,
        root_day_weights=dict(normalised_root),
        construction_diagnostics=diagnostics,
    )


def _compose_per_draw_pmf_at_end(
    *,
    graph: Mapping[str, Any],
    root_canonical: str,
    end_canonical: str,
    transitions: Mapping[Tuple[str, str], TimingTransitionPrimitive],
    timing_particles: RequestTimingParticles,
    max_tau: int,
) -> np.ndarray:
    """Compose per-draw root → end conditional latency PMF on ``(S, T)``.

    For every draw ``s``, every edge ``U → V`` contributes a per-draw
    sub-probability density ``p_edge · diff(cdf_draws[s, :], prepend=0)``
    built from the same edge-keyed particles primitive conditioning uses.
    One batched DAG DP composes these into the per-draw end-node density,
    and the per-draw conditional PMF is that density renormalised by its
    own row sum (the per-draw reach within the grid).
    """
    S = int(timing_particles.draw_count)
    T = int(max_tau) + 1

    per_edge_densities: Dict[Tuple[str, str], np.ndarray] = {}
    for edge_key, primitive in transitions.items():
        particles = timing_particles.particles_by_edge[edge_key]
        cdf_draws = build_per_draw_edge_cdf(particles, T)
        pmf_draws = np.diff(cdf_draws, prepend=0.0, axis=1)
        per_edge_densities[edge_key] = float(primitive.p) * pmf_draws

    end_density = compose_terminal_node_density_per_draw(
        graph=graph,
        root_node_id=root_canonical,
        end_node_id=end_canonical,
        densities_by_from_to=per_edge_densities,
        S=S,
        T=T,
    )
    return end_density / end_density.sum(axis=1, keepdims=True)


def _degraded(
    *,
    note: str,
    horizon_ratio: float,
    transition_source: str,
    draw_count: int,
) -> NodeArrivalWeights:
    return NodeArrivalWeights(
        weights={},
        weights_draws={},
        draw_count=int(draw_count),
        reach_from_root=0.0,
        provenance=NodeArrivalProvenance(
            topology_case='degraded',
            composed_edges=0,
            has_latency_edge=False,
            transition_source=transition_source,
            horizon_ratio=horizon_ratio,
            note=note,
        ),
    )


def _canonicalise(graph: Mapping[str, Any], node_id: str) -> str:
    """Resolve a node id-or-uuid to its canonical id.

    Mirrors the graph topology canonicalisation so map keys align with
    the ids returned by the shared timing topology walk.
    """
    for node in graph.get('nodes', []):
        nid = str(node.get('id') or '')
        nuuid = str(node.get('uuid') or '')
        if node_id in (nid, nuuid):
            return nid or nuuid
    return str(node_id)


def _enumerate_node_ids(
    graph: Mapping[str, Any],
    target_node_ids: Optional[Tuple[str, ...]],
) -> Tuple[str, ...]:
    if target_node_ids is not None:
        return tuple(target_node_ids)
    ids: list[str] = []
    seen: set[str] = set()
    for node in graph.get('nodes', []):
        nid = str(node.get('uuid') or node.get('id') or '')
        if not nid or nid in seen:
            continue
        ids.append(nid)
        seen.add(nid)
    return tuple(ids)
