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
from typing import Any, Dict, Mapping, Optional, Sequence, Tuple

import numpy as np

from .empirical_evidence_operator import (
    EmpiricalEvidencePrimitive,
    build_empirical_evidence_primitive,
    compose_empirical_span,
)
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
    "SelectedCohortRowProjection",
    "build_per_draw_chain",
    "evaluate_model_rate_draws",
    "evaluate_request_cdf_draws",
    "project_selected_cohort_rows",
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

    ``composed_empirical_carrier`` / ``composed_empirical_subject`` are
    sibling spans produced by the empirical evidence operator (Phase 6
    §4.9) — same admitted rows, same arrival-map weighting, same DAG
    DP/readout core as the conditioned spans above, differing only at
    the per-edge kernel supply boundary (``Δ(k_emp/n_emp)`` vs
    ``p × Δcdf``). ``resolve_request_spans`` populates them on every
    request; identity carrier degenerates to a zero-edge empirical
    composition just as the conditioned carrier does.
    """
    composed_carrier: ComposedPrimitiveSpan
    composed_subject: ComposedPrimitiveSpan
    overlays: Mapping[str, ComposedUnconditionedOverlay]
    registry: RequestPrimitiveRegistry
    composed_empirical_carrier: ComposedPrimitiveSpan
    composed_empirical_subject: ComposedPrimitiveSpan
    conditioned_primitive_map: Mapping[
        str, ConditionedTransitionPrimitive
    ] = field(default_factory=dict)
    carrier_primitives: Tuple[ConditionedTransitionPrimitive, ...] = ()
    subject_primitives: Tuple[ConditionedTransitionPrimitive, ...] = ()
    empirical_carrier_primitives: Tuple[EmpiricalEvidencePrimitive, ...] = ()
    empirical_subject_primitives: Tuple[EmpiricalEvidencePrimitive, ...] = ()


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
    registry = RequestPrimitiveRegistry(arrival_map=subject_arrival_map)
    empirical_horizon_len = int(options.timing_cdf_max_tau) + 1

    carrier_family = _prepare_carrier_operator_family(
        carrier_resolutions=carrier_resolutions,
        carrier_arrival_map=carrier_arrival_map,
        registry=registry,
        scenario_seed=scenario_seed,
        options=options,
        prior_source=prior_source,
        request_evidence_candidates=request_evidence_candidates,
        empirical_horizon_len=empirical_horizon_len,
    )
    subject_family = _prepare_subject_operator_family(
        subject_resolutions=subject_resolutions,
        subject_arrival_map=subject_arrival_map,
        registry=registry,
        is_window=is_window,
        scenario_seed=scenario_seed,
        options=options,
        prior_source=prior_source,
        request_evidence_candidates=request_evidence_candidates,
        empirical_horizon_len=empirical_horizon_len,
    )

    composed_carrier = _compose_conditioned_span(
        graph=graph,
        x_node_id=str(population_root_node_id),
        end_node_id=str(x_node_id),
        registry=registry,
        primitives_by_edge_id=carrier_family.conditioned_by_edge_id,
        options=compose_options,
    )
    composed_subject = _compose_conditioned_span(
        graph=graph,
        x_node_id=str(x_node_id),
        end_node_id=str(end_node_id),
        registry=registry,
        primitives_by_edge_id=subject_family.conditioned_by_edge_id,
        options=compose_options,
    )
    composed_empirical_carrier = _compose_empirical_span_for_family(
        graph=graph,
        x_node_id=str(population_root_node_id),
        end_node_id=str(x_node_id),
        primitives_by_edge_id=carrier_family.empirical_by_edge_id,
        draw_count=options.draw_count,
        horizon_len=empirical_horizon_len,
    )
    composed_empirical_subject = _compose_empirical_span_for_family(
        graph=graph,
        x_node_id=str(x_node_id),
        end_node_id=str(end_node_id),
        primitives_by_edge_id=subject_family.empirical_by_edge_id,
        draw_count=options.draw_count,
        horizon_len=empirical_horizon_len,
    )
    overlays = _compose_unconditioned_overlays(
        graph=graph,
        population_root_node_id=str(population_root_node_id),
        x_node_id=str(x_node_id),
        end_node_id=str(end_node_id),
        carrier_resolutions=carrier_resolutions,
        subject_resolutions=subject_resolutions,
        unconditioned_overlay_bases=unconditioned_overlay_bases,
        registry=registry,
        scenario_seed=scenario_seed,
        options=options,
        compose_options=compose_options,
        prior_source=prior_source,
    )

    conditioned_primitive_map = {
        **carrier_family.conditioned_by_registry_key,
        **subject_family.conditioned_by_registry_key,
    }

    return ResolvedSpans(
        composed_carrier=composed_carrier,
        composed_subject=composed_subject,
        overlays=overlays,
        registry=registry,
        conditioned_primitive_map=conditioned_primitive_map,
        carrier_primitives=carrier_family.conditioned_primitives,
        subject_primitives=subject_family.conditioned_primitives,
        composed_empirical_carrier=composed_empirical_carrier,
        composed_empirical_subject=composed_empirical_subject,
        empirical_carrier_primitives=carrier_family.empirical_primitives,
        empirical_subject_primitives=subject_family.empirical_primitives,
    )


@dataclass(frozen=True)
class _PreparedOperatorFamily:
    conditioned_by_edge_id: Mapping[str, ConditionedTransitionPrimitive]
    empirical_by_edge_id: Mapping[str, EmpiricalEvidencePrimitive]
    conditioned_by_registry_key: Mapping[str, ConditionedTransitionPrimitive]
    conditioned_primitives: Tuple[ConditionedTransitionPrimitive, ...]
    empirical_primitives: Tuple[EmpiricalEvidencePrimitive, ...]


def _prepare_carrier_operator_family(
    *,
    carrier_resolutions: Sequence[Any],
    carrier_arrival_map: Any,
    registry: RequestPrimitiveRegistry,
    scenario_seed: int,
    options: ConditioningPolicyOptions,
    prior_source: Optional[str],
    request_evidence_candidates: Sequence[Any],
    empirical_horizon_len: int,
) -> _PreparedOperatorFamily:
    from .primitive_readout import _per_primitive_evidence_scope, prepare_primitive

    conditioned_by_edge_id: dict[str, ConditionedTransitionPrimitive] = {}
    empirical_by_edge_id: dict[str, EmpiricalEvidencePrimitive] = {}
    conditioned_by_registry_key: dict[str, ConditionedTransitionPrimitive] = {}
    conditioned_primitives: list[ConditionedTransitionPrimitive] = []
    empirical_primitives: list[EmpiricalEvidencePrimitive] = []

    for c_res in carrier_resolutions:
        carrier_arrival = carrier_arrival_map.nodes[c_res.transition.source_node]
        prepared = prepare_primitive(
            transition=c_res.transition,
            primitive_scope=c_res.primitive_scope,
            resolved_model=c_res.resolved_model,
            arrival_weights=carrier_arrival,
            scenario_seed=scenario_seed,
            options=options,
            prior_source=prior_source,
            request_candidates=request_evidence_candidates,
        )
        registry_key = registry.register(
            prepared.resolution,
            prefix_identity=carrier_arrival_map.identity,
        )
        conditioned_by_registry_key[registry_key] = prepared.primitive
        _register_primitive_in_lookup(
            conditioned_by_edge_id, c_res.transition, prepared.primitive,
        )
        conditioned_primitives.append(prepared.primitive)

        empirical = build_empirical_evidence_primitive(
            transition=c_res.transition,
            primitive_scope=c_res.primitive_scope,
            arrival_weights=carrier_arrival,
            evidence_scope=_per_primitive_evidence_scope(
                transition=c_res.transition,
                primitive_scope=c_res.primitive_scope,
                arrival_weights=carrier_arrival,
            ),
            candidates=request_evidence_candidates,
            draw_count=options.draw_count,
            horizon_len=empirical_horizon_len,
        )
        _register_primitive_in_lookup(
            empirical_by_edge_id, c_res.transition, empirical,
        )
        empirical_primitives.append(empirical)

    return _PreparedOperatorFamily(
        conditioned_by_edge_id=conditioned_by_edge_id,
        empirical_by_edge_id=empirical_by_edge_id,
        conditioned_by_registry_key=conditioned_by_registry_key,
        conditioned_primitives=tuple(conditioned_primitives),
        empirical_primitives=tuple(empirical_primitives),
    )


def _prepare_subject_operator_family(
    *,
    subject_resolutions: Sequence[Any],
    subject_arrival_map: Any,
    registry: RequestPrimitiveRegistry,
    is_window: bool,
    scenario_seed: int,
    options: ConditioningPolicyOptions,
    prior_source: Optional[str],
    request_evidence_candidates: Sequence[Any],
    empirical_horizon_len: int,
) -> _PreparedOperatorFamily:
    from .primitive_readout import (
        _per_primitive_evidence_scope,
        _window_identity_arrival_weights,
        prepare_primitive,
    )

    conditioned_by_edge_id: dict[str, ConditionedTransitionPrimitive] = {}
    empirical_by_edge_id: dict[str, EmpiricalEvidencePrimitive] = {}
    conditioned_by_registry_key: dict[str, ConditionedTransitionPrimitive] = {}
    conditioned_primitives: list[ConditionedTransitionPrimitive] = []
    empirical_primitives: list[EmpiricalEvidencePrimitive] = []

    for s_res in subject_resolutions:
        subject_arrival = (
            _window_identity_arrival_weights(
                s_res.primitive_scope, draw_count=options.draw_count,
            )
            if is_window
            else subject_arrival_map.nodes[s_res.transition.source_node]
        )
        prepared = prepare_primitive(
            transition=s_res.transition,
            primitive_scope=s_res.primitive_scope,
            resolved_model=s_res.resolved_model,
            arrival_weights=subject_arrival,
            scenario_seed=scenario_seed,
            options=options,
            prior_source=prior_source,
            request_candidates=request_evidence_candidates,
        )
        registry_key = registry.register(prepared.resolution)
        conditioned_by_registry_key[registry_key] = prepared.primitive
        _register_primitive_in_lookup(
            conditioned_by_edge_id, s_res.transition, prepared.primitive,
        )
        conditioned_primitives.append(prepared.primitive)

        empirical = build_empirical_evidence_primitive(
            transition=s_res.transition,
            primitive_scope=s_res.primitive_scope,
            arrival_weights=subject_arrival,
            evidence_scope=_per_primitive_evidence_scope(
                transition=s_res.transition,
                primitive_scope=s_res.primitive_scope,
                arrival_weights=subject_arrival,
            ),
            candidates=request_evidence_candidates,
            draw_count=options.draw_count,
            horizon_len=empirical_horizon_len,
        )
        _register_primitive_in_lookup(
            empirical_by_edge_id, s_res.transition, empirical,
        )
        empirical_primitives.append(empirical)

    return _PreparedOperatorFamily(
        conditioned_by_edge_id=conditioned_by_edge_id,
        empirical_by_edge_id=empirical_by_edge_id,
        conditioned_by_registry_key=conditioned_by_registry_key,
        conditioned_primitives=tuple(conditioned_primitives),
        empirical_primitives=tuple(empirical_primitives),
    )


def _lookup_by_concrete_edge_id(primitives_by_edge_id: Mapping[Any, Any]):
    """Look up a primitive by the graph edge's identity.

    Tries, in order:
      1. ``edge_dict.get('edge_id') or edge_dict.get('id')`` —
         canonical id chosen by the topology resolver.
      2. ``edge_dict.get('uuid')`` — UUID alias used when the
         producer keyed primitives by the edge UUID.
      3. ``(from_id, to_id)`` endpoint pair — used by topologies
         whose edges carry no ``id`` field.

    The producer populates the dict with all three forms pointing
    at the same primitive (see ``_register_primitive_in_lookup``),
    so the lookup is uniform — no fallback chain in-engine, just
    one key try with multiple alias forms.
    """
    def _lookup(from_id, to_id, edge_dict):
        edge_id = edge_dict.get('edge_id') or edge_dict.get('id')
        if edge_id is not None and edge_id in primitives_by_edge_id:
            return primitives_by_edge_id[edge_id]
        edge_uuid = edge_dict.get('uuid')
        if edge_uuid is not None and edge_uuid in primitives_by_edge_id:
            return primitives_by_edge_id[edge_uuid]
        return primitives_by_edge_id.get((from_id, to_id))

    return _lookup


def _register_primitive_in_lookup(
    lookup: Dict[Any, Any],
    transition: Any,
    primitive: Any,
) -> None:
    """Populate the lookup with every key alias the composer might use.

    Two aliases are seeded: the producer's ``transition.edge_id``
    (which may be the canonical id OR the UUID, depending on the
    upstream resolver's choice) and the ``(source_node, destination_node)``
    endpoint pair. The composer's lookup tries them in turn — a
    single match wins regardless of which form was stored.
    """
    lookup[transition.edge_id] = primitive
    lookup[(transition.source_node, transition.destination_node)] = primitive


def _compose_conditioned_span(
    *,
    graph: Mapping[str, Any],
    x_node_id: str,
    end_node_id: str,
    registry: RequestPrimitiveRegistry,
    primitives_by_edge_id: Mapping[str, ConditionedTransitionPrimitive],
    options: ComposeOptions,
) -> ComposedPrimitiveSpan:
    return compose_primitive_span(
        graph=graph,
        x_node_id=x_node_id,
        end_node_id=end_node_id,
        registry=registry,
        edge_to_primitive_lookup=_lookup_by_concrete_edge_id(primitives_by_edge_id),
        options=options,
    )


def _compose_empirical_span_for_family(
    *,
    graph: Mapping[str, Any],
    x_node_id: str,
    end_node_id: str,
    primitives_by_edge_id: Mapping[str, EmpiricalEvidencePrimitive],
    draw_count: int,
    horizon_len: int,
) -> ComposedPrimitiveSpan:
    return compose_empirical_span(
        graph=graph,
        x_node_id=x_node_id,
        end_node_id=end_node_id,
        edge_to_empirical_primitive_lookup=_lookup_by_concrete_edge_id(
            primitives_by_edge_id,
        ),
        draw_count=draw_count,
        horizon_len=horizon_len,
    )


def _compose_unconditioned_overlays(
    *,
    graph: Mapping[str, Any],
    population_root_node_id: str,
    x_node_id: str,
    end_node_id: str,
    carrier_resolutions: Sequence[Any],
    subject_resolutions: Sequence[Any],
    unconditioned_overlay_bases: Sequence[str],
    registry: RequestPrimitiveRegistry,
    scenario_seed: int,
    options: ConditioningPolicyOptions,
    compose_options: ComposeOptions,
    prior_source: Optional[str],
) -> Mapping[str, ComposedUnconditionedOverlay]:
    overlays: dict[str, ComposedUnconditionedOverlay] = {}
    for basis in unconditioned_overlay_bases:
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
            _register_primitive_in_lookup(c_map_eid, c_res.transition, prim)
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
            _register_primitive_in_lookup(s_map_eid, s_res.transition, prim)

        overlay_carrier = _compose_conditioned_span(
            graph=graph,
            x_node_id=population_root_node_id,
            end_node_id=x_node_id,
            registry=registry,
            primitives_by_edge_id=c_map_eid,
            options=compose_options,
        )
        overlay_subject = _compose_conditioned_span(
            graph=graph,
            x_node_id=x_node_id,
            end_node_id=end_node_id,
            registry=registry,
            primitives_by_edge_id=s_map_eid,
            options=compose_options,
        )
        overlays[basis] = ComposedUnconditionedOverlay(
            subject=overlay_subject, carrier=overlay_carrier,
        )
    return overlays



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


@dataclass(frozen=True)
class SelectedCohortRowProjection:
    """Atom 2.3 output — per-request row reducer surfaces.

    The single reducer reads from BOTH operator families and routes row
    fields to the appropriate operator (Phase 6 §4.9 + §5.6):

    - Model surfaces (``rate_draws_model``, ``x_draws_model``,
      ``y_draws_model``) come from the conditioned operator on its
      value stream — these drive the row's ``midpoint``, ``fan_*``,
      ``forecast_x``, ``forecast_y``.
    - Coverage / exposure / frontier come from the conditioned
      operator's masked streams (§4.8); read per-anchor at both
      terminals (``X`` for ``coverage_x``, ``Z`` for ``coverage_y``).
      The empirical kernel's value collapses the support/value ratio
      to 1 (§4.9), so coverage MUST come from the parametric kernel.
    - Strict per-anchor evidence (``evidence_x_strict_by_anchor_tau``,
      ``evidence_y_strict_by_anchor_tau``) comes from the empirical
      operator's value stream. These are the unadjusted cumulatives.
    - Row-level strict / adjusted / rate fields are derived per
      Phase 6 §5.6: admissibility filter ``exposure_y_A(τ) > 0`` per
      (anchor, τ), then sum across admissible anchors. Adjusted
      applies the IPW divide by per-anchor coverage at the matching
      terminal (carrier coverage_x for the x stream, chain coverage_y
      for the y stream). Rate fields are y/x ratios with the 0/0
      row-contract guard.

    Per-anchor surfaces are ``Mapping[anchor_day, ndarray(T,)]`` —
    averaged across draws. Row-level surfaces are ``ndarray(T,)``.
    The aggregate model surfaces retain the draw axis so the row
    builder can quantile them for fan widths.
    """
    rate_draws_model: np.ndarray         # (S, T) — y_model / x_model
    x_draws_model: np.ndarray            # (S, T) — cumulative
    y_draws_model: np.ndarray            # (S, T) — cumulative
    coverage_x_by_anchor_tau: Mapping[Any, np.ndarray]   # (T,) per anchor
    coverage_y_by_anchor_tau: Mapping[Any, np.ndarray]
    exposure_x_by_anchor_tau: Mapping[Any, np.ndarray]
    exposure_y_by_anchor_tau: Mapping[Any, np.ndarray]
    frontier_by_anchor: Mapping[Any, int]                # max τ where exp_y > 0
    evidence_x_strict_by_anchor_tau: Mapping[Any, np.ndarray]   # (T,)
    evidence_y_strict_by_anchor_tau: Mapping[Any, np.ndarray]
    evidence_x_adjusted_numerator_by_anchor_tau: Mapping[Any, np.ndarray]
    evidence_y_adjusted_numerator_by_anchor_tau: Mapping[Any, np.ndarray]
    # Row-level fields per Phase 6 §5.6 — admissibility-filtered sums
    # across anchors. ``rate_*`` fields divide y by x with the
    # 0/0 row-contract guard. ``*_adjusted`` fields apply the IPW
    # divide; the §5.6 contract claim is unbiasedness under MCAR
    # (UNDER REVIEW — interaction with §4.9 forward-fill).
    evidence_x_strict: np.ndarray        # (T,) — Σ_admissible strict_x_A
    evidence_y_strict: np.ndarray        # (T,) — Σ_admissible strict_y_A
    rate_strict: np.ndarray              # (T,) — evidence_y_strict / evidence_x_strict
    evidence_x_adjusted: np.ndarray      # (T,) — Σ_admissible strict_x_A / coverage_x_A
    evidence_y_adjusted: np.ndarray      # (T,) — Σ_admissible strict_y_A / coverage_y_A
    rate_adjusted: np.ndarray            # (T,) — evidence_y_adjusted / evidence_x_adjusted


def _convolve_seed_with_terminal_density(
    seed: np.ndarray,
    terminal_density: np.ndarray,
    T: int,
) -> np.ndarray:
    """Per-draw convolution of a seed ``(S, T)`` at X with the per-draw
    terminal density ``(S, T)`` at the chain end (Z). Returns the
    per-(draw, τ) value at Z given the seed at X.

    The semantic: at draw ``s``, the seed array ``m[s, :]`` is the
    per-day arrival density at X (mass × per-day-shape), and the
    terminal density ``g_Z[s, :]`` is the per-day density at Z given
    a unit δ(0) at X. The mass at Z at age τ post-anchor is the
    discrete convolution ``Σ_d m[s, d] × g_Z[s, τ - d]``.

    No defensive padding — both inputs are expected to be (S, T) on
    the same horizon.
    """
    S = seed.shape[0]
    result = np.zeros((S, T), dtype=np.float64)
    for s in range(S):
        result[s, :] = np.convolve(seed[s, :], terminal_density[s, :])[:T]
    return result


def project_selected_cohort_rows(
    *,
    composed_carrier: ComposedPrimitiveSpan,
    composed_subject: ComposedPrimitiveSpan,
    composed_empirical_carrier: ComposedPrimitiveSpan,
    composed_empirical_subject: ComposedPrimitiveSpan,
    selected_cohorts: Sequence[Mapping[str, Any]],
    horizon: int,
) -> SelectedCohortRowProjection:
    """The single selected-cohort row reducer.

    Top-to-bottom, no branches, two operator passes (Phase 6 §5.6):

      1. For each cohort, build per-anchor seeds at X using
         ``seed_subject_from_carrier`` against the conditioned carrier
         (model seed) and the empirical carrier (evidence seed).
      2. At X (carrier terminal): the seed IS the X-mass surface —
         per-anchor coverage / exposure are read here against the
         conditioned operator's masked streams.
      3. At Z (chain terminal): convolve each seed with the matching
         operator's subject-terminal density. The conditioned-side
         result drives ``y_draws_model``; the empirical-side result
         drives ``evidence_y_strict_by_anchor_tau``.
      4. Aggregate model surfaces across cohorts (sum), then cumsum
         to produce cumulative ``x_draws_model`` / ``y_draws_model``;
         ``rate_draws_model = y / x`` with the standard 0/0 → 0 guard
         the spine carries elsewhere.
      5. Frontier per anchor = ``max τ`` where ``exposure_y_A[τ] > 0``.

    Mode-blind by construction: the function never reads
    ``population_root``, ``denominator_node``, ``is_window``, or any
    mode flag. Identity vs active produces different numerics solely
    because the carrier spans differ (zero-edge identity vs active
    composition). Re-introducing an ``if mode == ...`` branch here is
    AP58 and the cutover exists to remove it.
    """
    S = int(composed_carrier.draw_count)
    T = int(horizon) + 1

    # Subject-side per-(draw, age) terminal densities at Z. Same shape
    # for both operator families — that's the load-bearing parity
    # contract from Atom 2.2.
    subject_z_value = composed_subject.node_density_draws[
        composed_subject.end_node_id
    ]
    subject_z_support = composed_subject.node_support_draws[
        composed_subject.end_node_id
    ]
    subject_z_exposure = composed_subject.node_exposure_draws[
        composed_subject.end_node_id
    ]
    empirical_subject_z_value = composed_empirical_subject.node_density_draws[
        composed_empirical_subject.end_node_id
    ]

    x_value_aggregated = np.zeros((S, T), dtype=np.float64)
    y_value_aggregated = np.zeros((S, T), dtype=np.float64)

    coverage_x_by_anchor_tau: Dict[Any, np.ndarray] = {}
    coverage_y_by_anchor_tau: Dict[Any, np.ndarray] = {}
    exposure_x_by_anchor_tau: Dict[Any, np.ndarray] = {}
    exposure_y_by_anchor_tau: Dict[Any, np.ndarray] = {}
    frontier_by_anchor: Dict[Any, int] = {}
    evidence_x_strict_by_anchor_tau: Dict[Any, np.ndarray] = {}
    evidence_y_strict_by_anchor_tau: Dict[Any, np.ndarray] = {}
    evidence_x_adjusted_numerator_by_anchor_tau: Dict[Any, np.ndarray] = {}
    evidence_y_adjusted_numerator_by_anchor_tau: Dict[Any, np.ndarray] = {}

    empirical_subject_z_adjusted = composed_empirical_subject.node_exposure_draws[
        composed_empirical_subject.end_node_id
    ]

    for cohort in selected_cohorts:
        N_c = float(cohort['N_anchor'])
        anchor_day = cohort['anchor_day']

        # The row's τ axis is anchor-relative: τ=0 IS the cohort's
        # anchor day. Per-anchor seeds therefore use ``anchor_days=[0]``
        # so the carrier's per-day shape is placed at the start of the
        # τ grid. ``N_anchor`` is the cohort count; ``seed_subject_from_carrier``
        # scales the carrier's value/support/exposure streams by N_c.
        model_value_seed, model_support_seed, model_exposure_seed = (
            seed_subject_from_carrier(
                carrier=composed_carrier,
                x_node_id=composed_carrier.end_node_id,
                anchor_days=[0],
                anchor_counts=[N_c],
                days=T,
            )
        )
        emp_value_seed, _, emp_adjusted_seed = seed_subject_from_carrier(
            carrier=composed_empirical_carrier,
            x_node_id=composed_empirical_carrier.end_node_id,
            anchor_days=[0],
            anchor_counts=[N_c],
            days=T,
        )

        # At X (carrier terminal): the seed IS the per-(draw, τ) X-mass.
        x_value_c = model_value_seed
        x_support_c = model_support_seed
        x_exposure_c = model_exposure_seed

        # At Z (chain terminal): convolve the seed with the subject's
        # per-(draw, age) terminal density. The conditioned subject
        # carries the parametric Δcdf-shape × p; the empirical subject
        # carries Δ(k/n).
        y_value_c = _convolve_seed_with_terminal_density(
            model_value_seed, subject_z_value, T,
        )
        y_support_c = _convolve_seed_with_terminal_density(
            model_support_seed, subject_z_support, T,
        )
        y_exposure_c = _convolve_seed_with_terminal_density(
            model_exposure_seed, subject_z_exposure, T,
        )
        # Empirical: value stream only per §4.9.
        emp_y_value_c = _convolve_seed_with_terminal_density(
            emp_value_seed, empirical_subject_z_value, T,
        )
        emp_y_adjusted_c = _convolve_seed_with_terminal_density(
            emp_adjusted_seed, empirical_subject_z_adjusted, T,
        )

        # Model-side aggregation across cohorts (per-(draw, τ) sum).
        # Cumsum once at the end for the row's cumulative semantic.
        x_value_aggregated += x_value_c
        y_value_aggregated += y_value_c

        # Per-anchor coverage_x[τ], coverage_y[τ] from the §4.8 ratio
        # cumulative_support / cumulative_value, averaged across draws.
        x_cov = project_coverage_draws(x_value_c, x_support_c)
        y_cov = project_coverage_draws(y_value_c, y_support_c)
        coverage_x_by_anchor_tau[anchor_day] = x_cov.mean(axis=0)
        coverage_y_by_anchor_tau[anchor_day] = y_cov.mean(axis=0)

        # Per-anchor exposure cumulatives, draw-mean.
        x_exp = project_cumulative_exposure_draws(x_exposure_c)
        y_exp = project_cumulative_exposure_draws(y_exposure_c)
        exposure_x_by_anchor_tau[anchor_day] = x_exp.mean(axis=0)
        exposure_y_by_anchor_tau[anchor_day] = y_exp.mean(axis=0)

        # Frontier per anchor = max τ where draw-mean exposure_y > 0.
        # Reads from the chain-terminal exposure (Phase 6 §5.6). The
        # ``-1`` sentinel concat seeds the "no admissible τ" case as a
        # data degeneracy of the same `[-1]` lookup — no empty-array
        # branch.
        exp_y_mean = exposure_y_by_anchor_tau[anchor_day]
        positive_indices_with_sentinel = np.concatenate(
            ([-1], np.flatnonzero(exp_y_mean > 0.0))
        )
        frontier_by_anchor[anchor_day] = int(positive_indices_with_sentinel[-1])

        # Per-anchor strict evidence = cumsum of empirical value stream,
        # draw-mean. The empirical operator's saturation is per-edge
        # k_emp/n_emp, propagated through the chain — for single-hop
        # window with identity carrier this collapses to raw observed k.
        evidence_x_strict_by_anchor_tau[anchor_day] = (
            np.cumsum(emp_value_seed, axis=-1).mean(axis=0)
        )
        evidence_y_strict_by_anchor_tau[anchor_day] = (
            np.cumsum(emp_y_value_c, axis=-1).mean(axis=0)
        )
        evidence_x_adjusted_numerator_by_anchor_tau[anchor_day] = (
            np.cumsum(emp_adjusted_seed, axis=-1).mean(axis=0)
        )
        evidence_y_adjusted_numerator_by_anchor_tau[anchor_day] = (
            np.cumsum(emp_y_adjusted_c, axis=-1).mean(axis=0)
        )

    x_draws_model = np.cumsum(x_value_aggregated, axis=-1)
    y_draws_model = np.cumsum(y_value_aggregated, axis=-1)
    # 0/0 at small τ where carrier mass has not yet arrived emits 0.0
    # — same convention the spine's ``evaluate_model_rate_draws`` uses.
    rate_draws_model = np.divide(
        y_draws_model, x_draws_model,
        out=np.zeros_like(y_draws_model),
        where=x_draws_model > 0.0,
    )

    # ─── Row-level derivation per Phase 6 §5.6 ────────────────────────
    #
    # Admissibility filter per §5.6: cohort A is admissible at τ iff
    # ``exposure_y_A[τ] > 0`` (the chain-terminal cumulative exposure
    # is positive — observation reached the wavefront). The same
    # predicate gates both strict and adjusted aggregation.
    #
    # Strict row-level: ``Σ_admissible per-anchor strict``.
    # Adjusted row-level: ``Σ_admissible per-anchor strict / coverage``
    # with per-terminal coverage — ``coverage_x_A`` for the x stream
    # (carrier-terminal IPW factor) and ``coverage_y_A`` for the y
    # stream (chain-terminal IPW factor) per §5.6.
    # Rate fields are the y/x ratios with the standard 0/0 row-contract
    # guard; the cumsum/divide composes cleanly across the two streams.
    evidence_x_strict = np.zeros(T, dtype=np.float64)
    evidence_y_strict = np.zeros(T, dtype=np.float64)
    evidence_x_adjusted = np.zeros(T, dtype=np.float64)
    evidence_y_adjusted = np.zeros(T, dtype=np.float64)

    for anchor_day in evidence_y_strict_by_anchor_tau:
        strict_x_a = evidence_x_strict_by_anchor_tau[anchor_day]
        strict_y_a = evidence_y_strict_by_anchor_tau[anchor_day]
        coverage_x_a = coverage_x_by_anchor_tau[anchor_day]
        coverage_y_a = coverage_y_by_anchor_tau[anchor_day]
        adjusted_x_numer_a = evidence_x_adjusted_numerator_by_anchor_tau[
            anchor_day
        ]
        adjusted_y_numer_a = evidence_y_adjusted_numerator_by_anchor_tau[
            anchor_day
        ]
        admissible = (exposure_y_by_anchor_tau[anchor_day] > 0.0)
        evidence_x_strict += strict_x_a * admissible
        evidence_y_strict += strict_y_a * admissible
        evidence_x_adjusted += np.divide(
            adjusted_x_numer_a, coverage_x_a,
            out=np.zeros_like(adjusted_x_numer_a),
            where=admissible,
        )
        evidence_y_adjusted += np.divide(
            adjusted_y_numer_a, coverage_y_a,
            out=np.zeros_like(adjusted_y_numer_a),
            where=admissible,
        )

    rate_strict = np.divide(
        evidence_y_strict, evidence_x_strict,
        out=np.zeros_like(evidence_y_strict),
        where=evidence_x_strict > 0.0,
    )
    rate_adjusted = np.divide(
        evidence_y_adjusted, evidence_x_adjusted,
        out=np.zeros_like(evidence_y_adjusted),
        where=evidence_x_adjusted > 0.0,
    )

    return SelectedCohortRowProjection(
        rate_draws_model=rate_draws_model,
        x_draws_model=x_draws_model,
        y_draws_model=y_draws_model,
        coverage_x_by_anchor_tau=coverage_x_by_anchor_tau,
        coverage_y_by_anchor_tau=coverage_y_by_anchor_tau,
        exposure_x_by_anchor_tau=exposure_x_by_anchor_tau,
        exposure_y_by_anchor_tau=exposure_y_by_anchor_tau,
        frontier_by_anchor=frontier_by_anchor,
        evidence_x_strict_by_anchor_tau=evidence_x_strict_by_anchor_tau,
        evidence_y_strict_by_anchor_tau=evidence_y_strict_by_anchor_tau,
        evidence_x_adjusted_numerator_by_anchor_tau=(
            evidence_x_adjusted_numerator_by_anchor_tau
        ),
        evidence_y_adjusted_numerator_by_anchor_tau=(
            evidence_y_adjusted_numerator_by_anchor_tau
        ),
        evidence_x_strict=evidence_x_strict,
        evidence_y_strict=evidence_y_strict,
        rate_strict=rate_strict,
        evidence_x_adjusted=evidence_x_adjusted,
        evidence_y_adjusted=evidence_y_adjusted,
        rate_adjusted=rate_adjusted,
    )


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
