"""Model-span spine — the durable algebraic sequence for request-level
model readout.

This module owns the algebra that takes a composed subject/carrier pair
and projects it onto the surfaces public row builders consume: model
rate draws (the unconditioned overlay quantity) and request-rooted CDF
draws (the conditioned forecast quantity). Pure functions, no defensive
perimeters, no mode branching — every degeneracy expressed as data on
the call.

Design spine — what the maintained algebra is.
================================================================

Two distinct clock ideas:

  T1        = primitive conditioning root; used to weight evidence rows
  span_root = composition / readout origin for a whole carrier or
              subject span

Query setup:

  window(X-Z):
    carrier_prims = empty
    subject_prims = edges along X -> Z
    for subject prim U->V:
        T1 = U                       # local primitive clock
        evidence is local U->V:
            n = arrivals at U
            k = arrivals at V
    subject_span_root = X            # compose local operators into X->Z

  cohort(A, X-E):
    carrier_prims = edges along A -> X
    subject_prims = edges along X -> E
    for carrier prim U->V:
        T1 = A                       # A-rooted carrier clock
        evidence weighted by arrival A -> U
    for subject prim U->V:
        T1 = X                       # X-rooted subject clock
        evidence weighted by arrival X -> U
    carrier_span_root = A            # compose A->X
    subject_span_root = X            # compose X->E

Conditioning layer (upstream — ``primitive_readout`` /
``primitive_conditioning``):
  for prim U->V in carrier_prims + subject_prims:
      arrival_map = build_arrival_map(root=T1[prim], target=U)
                    # arrival-day weights at U;
                    # root == U -> identity / delta at t=0;
                    # root != U -> propagated arrival weights from
                    #              composed root->U timing.
                    # Normalised conditioning support; reach is a
                    # separate surface (not in the map).
      rows  = evidence(U->V, weighted_by=arrival_map)
      prim.reach = fit_reach(rows)   # local U->V transition probability
      prim.cdf   = fit_timing(rows)  # local U->V transition timing

Composition layer (substrate ``compose_primitive_span``):
  composed_carrier = compose(carrier_prims, root=A)
                     # zero-edge identity span for window() and
                     # cohort(A=X) — algebraic identity of the
                     # operator-chain monoid, shape (S, T) ones
  composed_subject = compose(subject_prims, root=X)

Key point for window(X-Y-Z): only the displayed denominator / window
population is fixed at X. The Y->Z primitive still has local n=Y, k=Z;
composition propagates X-rooted mass through Y to Z. Local conditioning
at the primitive layer + X-rooted span at the composition layer — both
honest, no double-bookkeeping.

T1 is per-primitive; span_root is per-span. Window vs cohort differ
only in T1 (window: each primitive conditioned on its own local source;
cohort: each primitive in a span conditioned with reference to the
span's chain root). span_root is always the span's chain root,
regardless of mode.

Readout layer (this module):
  build_per_draw_chain      - per-draw operator chain from a composed
                              span; role-neutral and mode-neutral.
                              Identity span (zero-edge composition,
                              shape-(S, T) ones) yields S identity
                              operators — algebraic identity of the
                              operator-chain monoid replicated S times.
  evaluate_model_rate_draws - two streams on a root-mass impulse:
                                numerator   = evaluate(carrier + subject)
                                denominator = evaluate(carrier)
                                rate        = numerator / denominator
                              Identity carrier collapses both:
                              denominator = root cumulative = 1
                              => rate = numerator.
  evaluate_request_cdf_draws - same chain shape with reach = 1 per
                              operator (conditioned spans already carry
                              primitive probability). Identity carrier:
                              CDF = subject CDF unchanged.

Contract
================================================================
Inputs are assumed valid: ``subject`` and ``carrier`` are
``ComposedPrimitiveSpan`` objects with matching ``cdf_draws.shape[0] == S``
and matching ``span_p_draws.shape == (S,)``. The composer guarantees
this; ``ComposedPrimitiveSpan.identity(draw_count=S, ...)`` produces
the same shape for zero-edge identity. Callers feed already-eligible
runtime spans; ineligibility (early skip) is decided upstream and the
spine is not invoked.

No supply-boundary shape inspection, no None checks, no ``np.clip``,
no defensive division guard. Undefined cells (0/0 at small τ where
carrier mass has not yet arrived in active mode) propagate as NaN —
algebraic truth, visible degradation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Sequence, Tuple

import numpy as np

from .primitive_conditioning import (
    ConditioningPolicyOptions,
    make_unconditioned_primitive,
)
from .primitive_evidence import RequestPrimitiveRegistry
from .primitives import ConditionedTransitionPrimitive
from .span_operator_supply import (
    PrimitiveDrawSurface,
    draw_model_primitive_operators,
)
from .span_readout import PrefixSurface, SpanOperator, evaluate_span_readout
from .subject_span_composer import (
    ComposedPrimitiveSpan,
    ComposeOptions,
    compose_primitive_span,
)


__all__ = [
    "ResolvedSpans",
    "ComposedUnconditionedOverlay",
    "build_per_draw_chain",
    "evaluate_model_rate_draws",
    "evaluate_request_cdf_draws",
    "resolve_request_spans",
    # Engine readout helpers over the per-node / per-edge ledgers
    # retained by `ComposedPrimitiveSpan` (Phase 6 §5 / proposal §5).
    "read_node_mass_draws",
    "read_node_support_draws",
    "read_node_exposure_draws",
    "read_edge_contribution_draws",
    "read_edge_support_contribution_draws",
    "read_edge_exposure_contribution_draws",
    "project_coverage_draws",
    "project_cumulative_exposure_draws",
    "seed_subject_from_carrier",
]


# ─── Result types ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class ComposedUnconditionedOverlay:
    """Subject + carrier compositions for one unconditioned overlay basis.

    Mirrors the conditioned-side ``composed_subject``/``composed_carrier``
    pair so consumers' carrier⊛subject convolution applies to the overlay
    without a parallel code path. ``carrier`` is always composed; identity
    carrier is a zero-edge span (the algebraic identity of the
    operator-chain monoid), not ``None``.
    """
    subject: ComposedPrimitiveSpan
    carrier: ComposedPrimitiveSpan


@dataclass(frozen=True)
class ResolvedSpans:
    """Carrier + subject composed pair plus unconditioned overlays for
    one request. Carrier is always a real ``ComposedPrimitiveSpan`` — a
    zero-edge identity composition for window/cohort(A=X) — never None.
    """
    composed_carrier: ComposedPrimitiveSpan
    composed_subject: ComposedPrimitiveSpan
    overlays: Mapping[str, ComposedUnconditionedOverlay]
    registry: RequestPrimitiveRegistry
    conditioned_primitive_map: Mapping[
        str, ConditionedTransitionPrimitive
    ] = field(default_factory=dict)
    carrier_primitives: Tuple[ConditionedTransitionPrimitive, ...] = ()
    subject_primitives: Tuple[ConditionedTransitionPrimitive, ...] = ()


@dataclass(frozen=True)
class RuntimeRootMass:
    cohort_ids: tuple[str, ...]
    root_days: np.ndarray
    root_counts: np.ndarray
    root_support: np.ndarray


def evaluate_with_operators(
    *,
    root_mass: RuntimeRootMass,
    operators: Sequence[SpanOperator],
    days: int,
    max_tau: int,
) -> PrefixSurface:
    return evaluate_span_readout(
        cohort_ids=root_mass.cohort_ids,
        root_days=root_mass.root_days,
        root_counts=root_mass.root_counts,
        root_supports=root_mass.root_support,
        operators=tuple(operators),
        days=days,
        max_tau=max_tau,
    )


# ─── Composer-side spine: request → composed pair ─────────────


def resolve_request_spans(
    *,
    graph: Mapping[str, Any],
    population_root_node_id: str,
    x_node_id: str,
    end_node_id: str,
    carrier_resolutions: Sequence[Any],
    subject_resolutions: Sequence[Any],
    subject_arrival_map: Any,
    carrier_arrival_map: Optional[Any],
    scenario_seed: int,
    options: ConditioningPolicyOptions,
    compose_options: ComposeOptions,
    prior_source: Optional[str],
    request_evidence_candidates: Sequence[Any],
    unconditioned_overlay_bases: Sequence[str],
    is_window: bool,
) -> ResolvedSpans:
    """The bind+condition+compose procedure — one request → composed pair.

    Top-to-bottom imperative algebra: bind+condition each carrier primitive
    against the carrier arrival map; bind+condition each subject primitive
    against the subject arrival map; compose the carrier span A->X (a
    zero-edge identity composition for window/cohort(A=X)); compose the
    subject span X->end; build one unconditioned overlay pair per requested
    dispersion basis. Returns ``ResolvedSpans`` carrying the composed pair
    plus the primitive registry. Raises ``PrimitiveUnavailable`` or
    ``CompositionError`` on any engine refusal — the perimeter catches.
    """
    # Imported here to avoid module-level circular dependency with
    # primitive_readout (which imports ComposeOptions from the composer
    # transitively). Spine is the algebraic procedure; primitive_readout
    # owns the perimeter that wraps it.
    from .primitive_readout import _window_identity_arrival_weights, prepare_primitive

    registry = RequestPrimitiveRegistry(arrival_map=subject_arrival_map)
    conditioned_primitive_map: dict[str, ConditionedTransitionPrimitive] = {}

    # Bind + condition every carrier primitive against the carrier-rooted
    # arrival map. Each primitive's registry key is computed against the
    # carrier map's identity (a different prefix-arrival identity from
    # subject primitives, since they live on different conditioning clocks).
    carrier_edge_to_primitive: dict[
        Tuple[str, str], ConditionedTransitionPrimitive
    ] = {}
    carrier_edge_id_to_primitive: dict[str, ConditionedTransitionPrimitive] = {}
    carrier_primitives: list[ConditionedTransitionPrimitive] = []
    for c_res in carrier_resolutions:
        prepared = prepare_primitive(
            transition=c_res.transition,
            primitive_scope=c_res.primitive_scope,
            resolved_model=c_res.resolved_model,
            arrival_weights=carrier_arrival_map.nodes[c_res.transition.source_node],
            scenario_seed=scenario_seed,
            options=options,
            prior_source=prior_source,
            request_candidates=request_evidence_candidates,
        )
        registry_key = registry.register(
            prepared.resolution,
            prefix_identity=carrier_arrival_map.identity,
        )
        primitive = prepared.primitive
        conditioned_primitive_map[registry_key] = primitive
        carrier_edge_to_primitive[(
            c_res.transition.source_node, c_res.transition.destination_node,
        )] = primitive
        carrier_edge_id_to_primitive[c_res.transition.edge_id] = primitive
        carrier_primitives.append(primitive)

    # Bind + condition every subject primitive against the subject-rooted
    # arrival map. Window mode binds each primitive on its own local-clock
    # identity (per Appendix A of the semantics doc); cohort mode binds
    # propagated weights from the X root.
    subject_edge_to_primitive: dict[
        Tuple[str, str], ConditionedTransitionPrimitive
    ] = {}
    subject_edge_id_to_primitive: dict[str, ConditionedTransitionPrimitive] = {}
    subject_primitives: list[ConditionedTransitionPrimitive] = []
    for s_res in subject_resolutions:
        prepared = prepare_primitive(
            transition=s_res.transition,
            primitive_scope=s_res.primitive_scope,
            resolved_model=s_res.resolved_model,
            arrival_weights=(
                _window_identity_arrival_weights(s_res.primitive_scope)
                if is_window
                else subject_arrival_map.nodes[s_res.transition.source_node]
            ),
            scenario_seed=scenario_seed,
            options=options,
            prior_source=prior_source,
            request_candidates=request_evidence_candidates,
        )
        registry_key = registry.register(prepared.resolution)
        primitive = prepared.primitive
        conditioned_primitive_map[registry_key] = primitive
        subject_edge_to_primitive[(
            s_res.transition.source_node, s_res.transition.destination_node,
        )] = primitive
        subject_edge_id_to_primitive[s_res.transition.edge_id] = primitive
        subject_primitives.append(primitive)

    # Edge-to-primitive lookups. The composer walks the topology and asks
    # the lookup to resolve each edge to its primitive (edge_id preferred,
    # endpoint pair as fallback).
    def _carrier_lookup(from_id, to_id, edge_dict):
        eid = edge_dict.get('edge_id') or edge_dict.get('id')
        if eid and eid in carrier_edge_id_to_primitive:
            return carrier_edge_id_to_primitive[eid]
        return carrier_edge_to_primitive.get((from_id, to_id))

    def _subject_lookup(from_id, to_id, edge_dict):
        eid = edge_dict.get('edge_id') or edge_dict.get('id')
        if eid and eid in subject_edge_id_to_primitive:
            return subject_edge_id_to_primitive[eid]
        return subject_edge_to_primitive.get((from_id, to_id))

    # Compose the carrier span A->X. When ``population_root == x`` the
    # walk has zero edges and the composer returns
    # ``ComposedPrimitiveSpan.identity(S, T)`` — the algebraic identity of
    # the operator-chain monoid, shape-(S, T) ones. No perimeter branch.
    composed_carrier = compose_primitive_span(
        graph=graph,
        x_node_id=str(population_root_node_id),
        end_node_id=str(x_node_id),
        registry=registry,
        edge_to_primitive_lookup=_carrier_lookup,
        options=compose_options,
    )
    composed_subject = compose_primitive_span(
        graph=graph,
        x_node_id=str(x_node_id),
        end_node_id=str(end_node_id),
        registry=registry,
        edge_to_primitive_lookup=_subject_lookup,
        options=compose_options,
    )

    # One unconditioned overlay pair per requested dispersion basis. The
    # composer is the same; only the per-edge primitive's draw family
    # changes (prior particles instead of joint-conditioned posterior).
    overlays: dict[str, ComposedUnconditionedOverlay] = {}
    for basis in unconditioned_overlay_bases:
        c_map_id: dict[Tuple[str, str], ConditionedTransitionPrimitive] = {}
        c_map_eid: dict[str, ConditionedTransitionPrimitive] = {}
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
        s_map_id: dict[Tuple[str, str], ConditionedTransitionPrimitive] = {}
        s_map_eid: dict[str, ConditionedTransitionPrimitive] = {}
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

        def _carrier_overlay_lookup(
            from_id, to_id, edge_dict, _eid=c_map_eid, _idp=c_map_id,
        ):
            eid = edge_dict.get('edge_id') or edge_dict.get('id')
            if eid and eid in _eid:
                return _eid[eid]
            return _idp.get((from_id, to_id))

        def _subject_overlay_lookup(
            from_id, to_id, edge_dict, _eid=s_map_eid, _idp=s_map_id,
        ):
            eid = edge_dict.get('edge_id') or edge_dict.get('id')
            if eid and eid in _eid:
                return _eid[eid]
            return _idp.get((from_id, to_id))

        overlay_carrier = compose_primitive_span(
            graph=graph,
            x_node_id=str(population_root_node_id),
            end_node_id=str(x_node_id),
            registry=registry,
            edge_to_primitive_lookup=_carrier_overlay_lookup,
            options=compose_options,
        )
        overlay_subject = compose_primitive_span(
            graph=graph,
            x_node_id=str(x_node_id),
            end_node_id=str(end_node_id),
            registry=registry,
            edge_to_primitive_lookup=_subject_overlay_lookup,
            options=compose_options,
        )
        overlays[basis] = ComposedUnconditionedOverlay(
            subject=overlay_subject, carrier=overlay_carrier,
        )

    return ResolvedSpans(
        composed_carrier=composed_carrier,
        composed_subject=composed_subject,
        overlays=overlays,
        registry=registry,
        conditioned_primitive_map=conditioned_primitive_map,
        carrier_primitives=tuple(carrier_primitives),
        subject_primitives=tuple(subject_primitives),
    )



# ─── Readout-side projections: composed pair → public surfaces ───


_MODEL_CURVE_ROOT_MASS = RuntimeRootMass(
    cohort_ids=("model-curve",),
    root_days=np.asarray([0], dtype=int),
    root_counts=np.asarray([1.0], dtype=float),
    root_support=np.asarray([1.0], dtype=float),
)


_REQUEST_ROOT_MASS = RuntimeRootMass(
    cohort_ids=("request",),
    root_days=np.asarray([0], dtype=int),
    root_counts=np.asarray([1.0], dtype=float),
    root_support=np.asarray([1.0], dtype=float),
)


def _pad_draw_cdfs(draw_cdfs: np.ndarray, horizon_len: int) -> np.ndarray:
    """Pad per-draw CDFs to ``horizon_len`` columns by repeating the
    saturating tail value. Truncate when longer."""
    values = np.asarray(draw_cdfs, dtype=float)
    if values.shape[1] >= int(horizon_len):
        return values[:, : int(horizon_len)]
    last = values[:, -1:]
    return np.concatenate(
        [
            values,
            np.broadcast_to(last, (values.shape[0], int(horizon_len) - values.shape[1])),
        ],
        axis=1,
    )


def build_per_draw_chain(
    span: ComposedPrimitiveSpan,
    *,
    S: int,
    days: int,
    edge_id: str,
    reach_draws: Optional[np.ndarray] = None,
) -> tuple:
    """Per-draw operator chain for a composed span — role-neutral.

    Mode degenerates by data. An active span yields one collapsed
    operator per draw (the composed CDF as a single delay kernel scaled
    by per-draw reach). A zero-edge identity span (shape-``(S, T)`` ones
    via ``ComposedPrimitiveSpan.identity``) yields S identity operators —
    algebraic identity of the operator-chain monoid.

    ``reach_draws`` defaults to the span's natural reach
    (``span.span_p_draws``). Override with ``ones(S)`` only when emitting
    a conditioned CDF where conditioning has already absorbed primitive
    probability into the CDF shape (request-CDF emission).
    """
    if reach_draws is None:
        reach_draws = np.asarray(span.span_p_draws, dtype=float)
    cdf_padded = _pad_draw_cdfs(span.cdf_draws, days)
    ops = draw_model_primitive_operators(
        PrimitiveDrawSurface(
            edge_id=edge_id,
            p_draws=reach_draws,
            conditional_cdf_draws=cdf_padded,
            timing_family="latent",
        )
    )
    return tuple((op,) for op in ops)


def evaluate_model_rate_draws(
    subject: ComposedPrimitiveSpan,
    carrier: ComposedPrimitiveSpan,
    *,
    horizon: int,
) -> np.ndarray:
    """Model-only rate draws: ``carrier+subject / carrier`` per draw.

    Predictive F-mode and the opt-in epistemic model-curve overlay differ
    only by the unconditioned primitive surfaces composing into
    ``subject`` and ``carrier``. Both read through this same algebra.
    Identity carrier is a zero-edge identity span: its per-draw chain is
    S identity operators, the denominator collapses to the root impulse
    cumulative (1.0 for all τ), and rate = numerator / 1.0 = numerator.

    Returns shape ``(S, horizon+1)``. Cells where the carrier denominator
    is exactly zero — the genuine 0/0 indeterminate form at small τ
    before any carrier mass has arrived at X — emit 0.0. This is the
    one defensive guard the spine carries: 0/0 is not "rate = 0"
    algebraically, but 0.0 is the row-contract value at those τ.
    Anywhere the denominator is strictly positive, the division is
    unguarded.
    """
    horizon_len = int(horizon) + 1
    S = int(subject.cdf_draws.shape[0])
    subject_chain = build_per_draw_chain(
        subject, S=S, days=horizon_len, edge_id="strict-span-subject",
    )
    carrier_chain = build_per_draw_chain(
        carrier, S=S, days=horizon_len, edge_id="strict-span-carrier",
    )
    rate_draws = np.zeros((S, horizon_len), dtype=float)
    for s in range(S):
        numerator = evaluate_with_operators(
            root_mass=_MODEL_CURVE_ROOT_MASS,
            operators=carrier_chain[s] + subject_chain[s],
            days=horizon_len,
            max_tau=horizon,
        ).value_by_cohort_tau[0]
        denominator = evaluate_with_operators(
            root_mass=_MODEL_CURVE_ROOT_MASS,
            operators=carrier_chain[s],
            days=horizon_len,
            max_tau=horizon,
        ).value_by_cohort_tau[0]
        rate_draws[s, :] = np.divide(
            numerator, denominator,
            out=np.zeros_like(numerator),
            where=denominator > 0.0,
        )
    return rate_draws


def evaluate_request_cdf_draws(
    subject: ComposedPrimitiveSpan,
    carrier: ComposedPrimitiveSpan,
    *,
    horizon: int,
) -> np.ndarray:
    """Conditioned request-rooted CDF draws.

    Builds one operator chain per draw: carrier then subject, each as a
    latent operator with p=1 since the conditioned spans already
    incorporate primitive probability. Identity carrier (zero-edge
    identity span) contributes S identity operators that pass the root
    impulse through unchanged, so the result is the subject CDF.

    Returns shape ``(S, horizon+1)``. Cumulative request-rooted CDF.
    """
    horizon_len = int(horizon) + 1
    S = int(subject.cdf_draws.shape[0])
    unit_p = np.ones(S, dtype=float)
    subject_chain = build_per_draw_chain(
        subject, S=S, days=horizon_len,
        edge_id="strict-span-request-subject", reach_draws=unit_p,
    )
    carrier_chain = build_per_draw_chain(
        carrier, S=S, days=horizon_len,
        edge_id="strict-span-request-carrier", reach_draws=unit_p,
    )
    cdf_draws = np.zeros((S, horizon_len), dtype=float)
    for s in range(S):
        surface = evaluate_with_operators(
            root_mass=_REQUEST_ROOT_MASS,
            operators=carrier_chain[s] + subject_chain[s],
            days=horizon_len,
            max_tau=horizon,
        )
        cdf_draws[s, :] = surface.value_by_cohort_tau[0]
    return cdf_draws


# ─── Engine readout helpers (Phase 6 §5 / proposal §5) ────────────────


def read_node_mass_draws(
    span: ComposedPrimitiveSpan, node_id: str,
) -> np.ndarray:
    """Per-(draw, τ) arrival-mass density at the named node.

    δ at τ=0 at the topology root; sum-of-incoming-edge-contributions at
    every other on-path node. The legacy terminal `cdf_draws` is the
    per-draw cumulative of `read_node_mass_draws(end_node)` divided by
    the per-draw asymptotic reach.
    """
    return span.node_density_draws[node_id]


def read_node_support_draws(
    span: ComposedPrimitiveSpan, node_id: str,
) -> np.ndarray:
    """Per-(draw, τ) support density at the named node (value-weighted
    support stream of Phase 6 §4.8: ``cumulative_support /
    cumulative_value`` is the coverage projection)."""
    return span.node_support_draws[node_id]


def read_node_exposure_draws(
    span: ComposedPrimitiveSpan, node_id: str,
) -> np.ndarray:
    """Per-(draw, τ) exposure density at the named node (Phase 6 §4.8
    exposure stream — preserves the covered-zero / absent distinction at
    cumulative-zero cells where the value-weighted ratio is undefined)."""
    return span.node_exposure_draws[node_id]


def read_edge_contribution_draws(
    span: ComposedPrimitiveSpan, edge_key: str,
) -> np.ndarray:
    """Per-(draw, τ) value contribution flowing through the named
    concrete edge. Coincident sibling edges have distinct entries."""
    return span.edge_contribution_draws[edge_key]


def read_edge_support_contribution_draws(
    span: ComposedPrimitiveSpan, edge_key: str,
) -> np.ndarray:
    """Per-(draw, τ) support contribution through the named concrete edge."""
    return span.edge_support_contribution_draws[edge_key]


def read_edge_exposure_contribution_draws(
    span: ComposedPrimitiveSpan, edge_key: str,
) -> np.ndarray:
    """Per-(draw, τ) exposure contribution through the named concrete edge."""
    return span.edge_exposure_contribution_draws[edge_key]


def project_coverage_draws(
    value_draws: np.ndarray, support_draws: np.ndarray,
) -> np.ndarray:
    """Per-(draw, τ) coverage as Phase 6 §4.8's ratio:

        coverage(s, τ) = cumulative_support(s, τ) / cumulative_value(s, τ)

    The 0/0 cell — wavefront has not reached τ in this draw — emits 0
    per the Phase 6 0/0 policy. Anywhere cumulative value is strictly
    positive the division is unguarded.
    """
    cumulative_value = np.cumsum(value_draws, axis=-1)
    cumulative_support = np.cumsum(support_draws, axis=-1)
    return np.divide(
        cumulative_support, cumulative_value,
        out=np.zeros_like(cumulative_value),
        where=cumulative_value > 0.0,
    )


def project_cumulative_exposure_draws(
    exposure_draws: np.ndarray,
) -> np.ndarray:
    """Per-(draw, τ) cumulative exposure. Positive whenever the
    wavefront has reached any observed cell in this draw — even if the
    value-weighted support stream is zero (the covered-zero case)."""
    return np.cumsum(exposure_draws, axis=-1)


def seed_subject_from_carrier(
    *,
    carrier: ComposedPrimitiveSpan,
    x_node_id: str,
    anchor_days: Sequence[int],
    anchor_counts: Sequence[float],
    days: int,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Active-cohort handoff: carrier output at X becomes the subject's
    root seed.

    For each anchor day `c` with observed cohort count `N_c`, the
    carrier's per-(draw, day-since-A) arrival density at X is shifted by
    `c` and scaled by `N_c`. Contributions from multiple anchors are
    summed into the (draw, source-day-at-X) seed surface. Returns the
    three seed streams (value, support, exposure) the subject readout
    consumes alongside the per-(draw, day_at_X) surface as ``(S, days)``
    arrays.

    Anchor days outside ``[0, days)`` are out of horizon and silently
    contribute zero. This is a perimeter horizon check on caller input,
    not a case fork inside the algebra.
    """
    S = carrier.draw_count
    g_value = carrier.node_density_draws[x_node_id]
    g_support = carrier.node_support_draws[x_node_id]
    g_exposure = carrier.node_exposure_draws[x_node_id]
    T_carrier = g_value.shape[1]
    value_seed = np.zeros((S, days), dtype=np.float64)
    support_seed = np.zeros((S, days), dtype=np.float64)
    exposure_seed = np.zeros((S, days), dtype=np.float64)
    for c_raw, n_raw in zip(anchor_days, anchor_counts):
        c = int(c_raw)
        if c < 0 or c >= days:
            continue
        n_c = float(n_raw)
        src_end = min(T_carrier, days - c)
        if src_end <= 0:
            continue
        value_seed[:, c:c + src_end] += n_c * g_value[:, :src_end]
        support_seed[:, c:c + src_end] += n_c * g_support[:, :src_end]
        exposure_seed[:, c:c + src_end] += n_c * g_exposure[:, :src_end]
    return value_seed, support_seed, exposure_seed
