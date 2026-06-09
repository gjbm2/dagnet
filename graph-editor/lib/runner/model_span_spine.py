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
from datetime import date
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from .empirical_evidence_operator import (
    EmpiricalEvidencePrimitive,
    build_empirical_evidence_primitive,
    compose_empirical_span,
    evaluate_empirical_span_from_seed_flat_origins,
    evaluate_empirical_span_from_seed_flat_origins_with_provenance,
)
from .primitive_conditioning import (
    ConditioningPolicyOptions,
    make_unconditioned_primitive,
)
from .primitive_evidence import RequestPrimitiveRegistry
from .primitives import ConditionedTransitionPrimitive, TimingFamily
from .bucket_transition import BucketSourceBasis
from .frontier_continuation_dp import run_dp_from_node_source_ledgers
from .frontier_residual_kernel import make_frontier_residual_kernel_provider
from .span_kernel import ConcreteEdge, SpanTopology
from .span_readout import PrefixSurface, SpanOperator, evaluate_span_readout
from .subject_span_composer import (
    ComposedPrimitiveSpan,
    ComposeOptions,
    EvidenceReadoutBinding,
    _conditioned_kernel_maps,
    compose_primitive_span,
    evaluate_conditioned_span_from_seed_flat_origins,
    evaluate_conditioned_span_from_seed_flat_origins_with_provenance,
)
from .timing_span import DPExecutionPolicy, SpanDPTrace


__all__ = [
    "ResolvedSpans",
    "ComposedUnconditionedOverlay",
    "SelectedCohortRowProjection",
    "FrontierOccupancyLedger",
    "build_frontier_occupancy",
    "build_per_draw_chain",
    "evaluate_model_rate_draws",
    "evaluate_request_cdf_draws",
    "project_selected_cohort_rows",
    "resolve_request_spans",
    # Engine readout helpers over the per-node / per-edge ledgers
    # retained by ``ComposedPrimitiveSpan``.
    "read_node_mass_draws",
    "read_edge_contribution_draws",
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
    sibling spans produced by the empirical evidence operator: same
    admitted rows, same arrival-map weighting, same DAG DP/readout core
    as the conditioned spans above, differing only at the per-edge
    kernel supply boundary (``Δ(k_emp/n_emp)`` vs ``p × Δcdf``).
    ``resolve_request_spans`` populates them on every request; identity
    carrier degenerates to a zero-edge empirical composition just as the
    conditioned carrier does.
    """
    composed_carrier: ComposedPrimitiveSpan
    composed_subject: ComposedPrimitiveSpan
    composed_carrier_predictive: ComposedPrimitiveSpan
    composed_subject_predictive: ComposedPrimitiveSpan
    overlays: Mapping[str, ComposedUnconditionedOverlay]
    registry: RequestPrimitiveRegistry
    composed_empirical_carrier: ComposedPrimitiveSpan
    composed_empirical_subject: ComposedPrimitiveSpan
    conditioned_primitive_map: Mapping[
        str, ConditionedTransitionPrimitive
    ] = field(default_factory=dict)
    carrier_primitives: Tuple[ConditionedTransitionPrimitive, ...] = ()
    subject_primitives: Tuple[ConditionedTransitionPrimitive, ...] = ()
    carrier_primitives_predictive: Tuple[ConditionedTransitionPrimitive, ...] = ()
    subject_primitives_predictive: Tuple[ConditionedTransitionPrimitive, ...] = ()
    empirical_carrier_primitives: Tuple[EmpiricalEvidencePrimitive, ...] = ()
    empirical_subject_primitives: Tuple[EmpiricalEvidencePrimitive, ...] = ()


@dataclass(frozen=True)
class RuntimeRootMass:
    cohort_ids: tuple[str, ...]
    root_days: np.ndarray
    root_counts: np.ndarray
    root_weights: np.ndarray


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
        root_supports=root_mass.root_weights,
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
    # Mode is latent in the topology: the population root sitting at X means
    # there is no carrier leg — the window / cohort(A=X) identity case. Every
    # binding below reads this fact, not an is_window flag threaded from the
    # perimeter.
    rooted_at_x = str(population_root_node_id) == str(x_node_id)
    evidence_readout_binding = {
        True: EvidenceReadoutBinding.window(),
        False: EvidenceReadoutBinding.cohort(),
    }[rooted_at_x]

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
        x_node_id=str(x_node_id),
        subject_resolutions=subject_resolutions,
        subject_arrival_map=subject_arrival_map,
        registry=registry,
        rooted_at_x=rooted_at_x,
        evidence_readout_binding=evidence_readout_binding,
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
        evidence_readout_binding=evidence_readout_binding,
    )
    composed_subject = _compose_conditioned_span(
        graph=graph,
        x_node_id=str(x_node_id),
        end_node_id=str(end_node_id),
        registry=registry,
        primitives_by_edge_id=subject_family.conditioned_by_edge_id,
        options=compose_options,
        evidence_readout_binding=evidence_readout_binding,
    )
    # FC plan §9.4: build a SECOND conditioned family per role with
    # ``dispersion_basis='predictive'`` from the same bound evidence
    # the epistemic family used. These are the spans the FC shadow
    # surface consumes (§9.5 — predictive-basis residual kernels). The
    # unconditioned-predictive overlay is NOT a substitute: it carries
    # no evidence binding.
    carrier_predictive_by_edge_id, carrier_predictive_primitives = (
        _prepare_conditioned_only_family(
            resolutions=carrier_resolutions,
            arrival_map=carrier_arrival_map,
            rooted_at_x=rooted_at_x,
            evidence_readout_binding=evidence_readout_binding,
            scenario_seed=scenario_seed,
            options=options,
            prior_source=prior_source,
            request_evidence_candidates=request_evidence_candidates,
            dispersion_basis='predictive',
            carrier_mode=True,
        )
    )
    subject_predictive_by_edge_id, subject_predictive_primitives = (
        _prepare_conditioned_only_family(
            resolutions=subject_resolutions,
            arrival_map=subject_arrival_map,
            rooted_at_x=rooted_at_x,
            evidence_readout_binding=evidence_readout_binding,
            scenario_seed=scenario_seed,
            options=options,
            prior_source=prior_source,
            request_evidence_candidates=request_evidence_candidates,
            dispersion_basis='predictive',
            carrier_mode=False,
        )
    )
    composed_carrier_predictive = _compose_conditioned_span(
        graph=graph,
        x_node_id=str(population_root_node_id),
        end_node_id=str(x_node_id),
        registry=registry,
        primitives_by_edge_id=carrier_predictive_by_edge_id,
        options=compose_options,
        evidence_readout_binding=evidence_readout_binding,
    )
    composed_subject_predictive = _compose_conditioned_span(
        graph=graph,
        x_node_id=str(x_node_id),
        end_node_id=str(end_node_id),
        registry=registry,
        primitives_by_edge_id=subject_predictive_by_edge_id,
        options=compose_options,
        evidence_readout_binding=evidence_readout_binding,
    )
    composed_empirical_carrier = _compose_empirical_span_for_family(
        graph=graph,
        x_node_id=str(population_root_node_id),
        end_node_id=str(x_node_id),
        primitives_by_edge_id=carrier_family.empirical_by_edge_id,
        draw_count=options.draw_count,
        horizon_len=empirical_horizon_len,
        evidence_readout_binding=evidence_readout_binding,
    )
    composed_empirical_subject = _compose_empirical_span_for_family(
        graph=graph,
        x_node_id=str(x_node_id),
        end_node_id=str(end_node_id),
        primitives_by_edge_id=subject_family.empirical_by_edge_id,
        draw_count=options.draw_count,
        horizon_len=empirical_horizon_len,
        evidence_readout_binding=evidence_readout_binding,
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
        evidence_readout_binding=evidence_readout_binding,
    )

    conditioned_primitive_map = {
        **carrier_family.conditioned_by_registry_key,
        **subject_family.conditioned_by_registry_key,
    }

    return ResolvedSpans(
        composed_carrier=composed_carrier,
        composed_subject=composed_subject,
        composed_carrier_predictive=composed_carrier_predictive,
        composed_subject_predictive=composed_subject_predictive,
        overlays=overlays,
        registry=registry,
        conditioned_primitive_map=conditioned_primitive_map,
        carrier_primitives=carrier_family.conditioned_primitives,
        subject_primitives=subject_family.conditioned_primitives,
        carrier_primitives_predictive=carrier_predictive_primitives,
        subject_primitives_predictive=subject_predictive_primitives,
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
            bucket_read_offset=0.0,
            use_source_basis=False,
            timing_family=_empirical_timing_family(
                c_res.resolved_model,
                prepared.primitive,
            ),
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
    x_node_id: str,
    subject_resolutions: Sequence[Any],
    subject_arrival_map: Any,
    registry: RequestPrimitiveRegistry,
    rooted_at_x: bool,
    evidence_readout_binding: EvidenceReadoutBinding,
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
    node_phase: dict[str, float] = {
        str(x_node_id): -float(evidence_readout_binding.empirical_subject_read_offset),
    }

    for s_res in subject_resolutions:
        subject_arrival = (
            _window_identity_arrival_weights(
                s_res.primitive_scope, draw_count=options.draw_count,
            )
            if rooted_at_x
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
        empirical_family = _empirical_timing_family(
            s_res.resolved_model,
            prepared.primitive,
        )
        source_phase = node_phase.get(
            str(s_res.transition.source_node),
            -float(evidence_readout_binding.empirical_subject_read_offset),
        )
        empirical_read_offset = -float(source_phase)

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
            bucket_read_offset=empirical_read_offset,
            evidence_basis="raw_local",
            use_source_basis=True,
            timing_family=empirical_family,
        )
        _register_primitive_in_lookup(
            empirical_by_edge_id, s_res.transition, empirical,
        )
        empirical_primitives.append(empirical)
        output_phase = (
            source_phase
            if empirical_family in (TimingFamily.NON_LATENT, TimingFamily.DETERMINISTIC)
            else -float(evidence_readout_binding.empirical_subject_read_offset)
        )
        node_phase[str(s_res.transition.destination_node)] = output_phase

    return _PreparedOperatorFamily(
        conditioned_by_edge_id=conditioned_by_edge_id,
        empirical_by_edge_id=empirical_by_edge_id,
        conditioned_by_registry_key=conditioned_by_registry_key,
        conditioned_primitives=tuple(conditioned_primitives),
        empirical_primitives=tuple(empirical_primitives),
    )


def _prepare_conditioned_only_family(
    *,
    resolutions: Sequence[Any],
    arrival_map: Any,
    rooted_at_x: bool,
    evidence_readout_binding: EvidenceReadoutBinding,
    scenario_seed: int,
    options: ConditioningPolicyOptions,
    prior_source: Optional[str],
    request_evidence_candidates: Sequence[Any],
    dispersion_basis: str,
    carrier_mode: bool,
) -> Tuple[
    Dict[str, ConditionedTransitionPrimitive],
    Tuple[ConditionedTransitionPrimitive, ...],
]:
    """Build a single conditioned-primitive family at the given basis.

    Mirrors the conditioned half of ``_prepare_carrier_operator_family``
    / ``_prepare_subject_operator_family`` but skips the empirical-side
    construction (empirical primitives are basis-invariant — they are
    raw ``k/n`` evidence — so they are built once by the epistemic
    pass and reused across both bases). Used by ``resolve_request_spans``
    to add a second predictive-basis conditioned family for the FC
    shadow surface (FC plan §9.4: FC consumes predictive-basis
    conditioned primitives, NOT the unconditioned-predictive overlay).
    """
    from .primitive_readout import (
        _window_identity_arrival_weights,
        prepare_primitive,
    )

    conditioned_by_edge_id: Dict[str, ConditionedTransitionPrimitive] = {}
    conditioned_primitives: List[ConditionedTransitionPrimitive] = []
    for res in resolutions:
        if carrier_mode:
            arrival = arrival_map.nodes[res.transition.source_node]
        else:
            arrival = (
                _window_identity_arrival_weights(
                    res.primitive_scope, draw_count=options.draw_count,
                )
                if rooted_at_x
                else arrival_map.nodes[res.transition.source_node]
            )
        prepared = prepare_primitive(
            transition=res.transition,
            primitive_scope=res.primitive_scope,
            resolved_model=res.resolved_model,
            arrival_weights=arrival,
            scenario_seed=scenario_seed,
            options=options,
            prior_source=prior_source,
            request_candidates=request_evidence_candidates,
            dispersion_basis=dispersion_basis,
        )
        _register_primitive_in_lookup(
            conditioned_by_edge_id, res.transition, prepared.primitive,
        )
        conditioned_primitives.append(prepared.primitive)
    return conditioned_by_edge_id, tuple(conditioned_primitives)


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


def _empirical_timing_family(
    resolved_model: Any,
    primitive: ConditionedTransitionPrimitive,
) -> TimingFamily:
    if resolved_model.latency.latency_parameter is False:
        return TimingFamily.NON_LATENT
    return primitive.timing_family


def _compose_conditioned_span(
    *,
    graph: Mapping[str, Any],
    x_node_id: str,
    end_node_id: str,
    registry: RequestPrimitiveRegistry,
    primitives_by_edge_id: Mapping[str, ConditionedTransitionPrimitive],
    options: ComposeOptions,
    evidence_readout_binding: EvidenceReadoutBinding | None = None,
) -> ComposedPrimitiveSpan:
    return compose_primitive_span(
        graph=graph,
        x_node_id=x_node_id,
        end_node_id=end_node_id,
        registry=registry,
        edge_to_primitive_lookup=_lookup_by_concrete_edge_id(primitives_by_edge_id),
        options=options,
        evidence_readout_binding=evidence_readout_binding,
    )


def _compose_empirical_span_for_family(
    *,
    graph: Mapping[str, Any],
    x_node_id: str,
    end_node_id: str,
    primitives_by_edge_id: Mapping[str, EmpiricalEvidencePrimitive],
    draw_count: int,
    horizon_len: int,
    evidence_readout_binding: EvidenceReadoutBinding | None = None,
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
        evidence_readout_binding=evidence_readout_binding,
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
    evidence_readout_binding: EvidenceReadoutBinding | None = None,
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
            evidence_readout_binding=evidence_readout_binding,
        )
        overlay_subject = _compose_conditioned_span(
            graph=graph,
            x_node_id=x_node_id,
            end_node_id=end_node_id,
            registry=registry,
            primitives_by_edge_id=s_map_eid,
            options=compose_options,
            evidence_readout_binding=evidence_readout_binding,
        )
        overlays[basis] = ComposedUnconditionedOverlay(
            subject=overlay_subject, carrier=overlay_carrier,
        )
    return overlays



# ─── Readout-side projections: composed pair → public surfaces ───


_MODEL_CURVE_ROOT_MASS = RuntimeRootMass(
    cohort_ids=("model-curve",),
    root_days=np.asarray([0], dtype=int),
    root_counts=np.asarray([1.0], dtype=np.float32),
    root_weights=np.asarray([1.0], dtype=np.float32),
)


_REQUEST_ROOT_MASS = RuntimeRootMass(
    cohort_ids=("request",),
    root_days=np.asarray([0], dtype=int),
    root_counts=np.asarray([1.0], dtype=np.float32),
    root_weights=np.asarray([1.0], dtype=np.float32),
)


def _pad_draw_cdfs(draw_cdfs: np.ndarray, horizon_len: int) -> np.ndarray:
    """Pad per-draw CDFs to ``horizon_len`` columns by repeating the
    saturating tail value. Truncate when longer."""
    values = np.asarray(draw_cdfs, dtype=np.float32)
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
        reach_draws = np.asarray(span.span_p_draws, dtype=np.float32)
    cdf_padded = _pad_draw_cdfs(span.cdf_draws, days)
    value = np.diff(cdf_padded, prepend=0.0, axis=1) * reach_draws[:, None]
    return tuple(
        (
            SpanOperator(
                name=f"{edge_id}::draw:{draw_index}",
                value=value[draw_index : draw_index + 1],
                family="composed_model_draw",
            ),
        )
        for draw_index in range(S)
    )


def _stack_per_draw_chain_kernels(
    chain: tuple, S: int, days: int,
) -> Tuple[np.ndarray, ...]:
    """Stack a per-draw operator chain into a tuple of ``(S, kernel_length)``
    batched kernels — one batched array per chain element.

    ``chain`` is what ``build_per_draw_chain`` returns: a tuple of length
    ``S``, each element a 1-tuple of one ``SpanOperator``. Within one
    chain *element* every draw's operator has the same kernel length
    (data degeneracy of the same primitive family), so the per-draw
    values stack cleanly. Different chain elements may have different
    kernel lengths; the caller applies them in sequence.
    """
    if not chain:
        return ()
    chain_length = len(chain[0])
    stacked = []
    for chain_idx in range(chain_length):
        kernels = np.stack([chain[s][chain_idx].value[0] for s in range(S)])
        stacked.append(kernels)
    return tuple(stacked)


def _evaluate_chain_at_root_zero_per_draw(
    root_mass: float,
    kernels: Tuple[np.ndarray, ...],
    days: int,
    max_tau: int,
    S: int,
) -> np.ndarray:
    """Vectorised cumulative arrival for a one-cohort, root-day-0 chain.

    Single-cohort row-batched degeneracy of ``evaluate_span_readout``:
    each chain element's batched kernel ``(S, kernel_length)`` advances
    the ``(S, days)`` ledger via the same strided convolve the scalar
    ``_apply_kernel`` runs, broadcasting the per-draw kernel scalar
    against the cohort-singleton row axis. Returns ``(S, max_tau + 1)``
    cumulative arrival values picked at ``τ ∈ [0, max_tau]``.
    """
    ledger = np.zeros((S, days), dtype=np.float32)
    ledger[:, 0] = root_mass
    for kernel in kernels:
        kernel_length = kernel.shape[1]
        new_ledger = np.zeros_like(ledger)
        for offset in range(kernel_length):
            new_ledger[:, offset:] += (
                ledger[:, : days - offset] * kernel[:, offset : offset + 1]
            )
        ledger = new_ledger
    return np.cumsum(ledger, axis=1)[:, : max_tau + 1]


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
    carrier_kernels = _stack_per_draw_chain_kernels(carrier_chain, S, horizon_len)
    subject_kernels = _stack_per_draw_chain_kernels(subject_chain, S, horizon_len)

    root_mass = float(_MODEL_CURVE_ROOT_MASS.root_counts[0])
    numerator = _evaluate_chain_at_root_zero_per_draw(
        root_mass=root_mass,
        kernels=carrier_kernels + subject_kernels,
        days=horizon_len,
        max_tau=horizon,
        S=S,
    )
    denominator = _evaluate_chain_at_root_zero_per_draw(
        root_mass=root_mass,
        kernels=carrier_kernels,
        days=horizon_len,
        max_tau=horizon,
        S=S,
    )
    return np.divide(
        numerator, denominator,
        out=np.zeros_like(numerator),
        where=denominator > 0.0,
    )


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
    unit_p = np.ones(S, dtype=np.float32)
    subject_chain = build_per_draw_chain(
        subject, S=S, days=horizon_len,
        edge_id="strict-span-request-subject", reach_draws=unit_p,
    )
    carrier_chain = build_per_draw_chain(
        carrier, S=S, days=horizon_len,
        edge_id="strict-span-request-carrier", reach_draws=unit_p,
    )
    carrier_kernels = _stack_per_draw_chain_kernels(carrier_chain, S, horizon_len)
    subject_kernels = _stack_per_draw_chain_kernels(subject_chain, S, horizon_len)

    return _evaluate_chain_at_root_zero_per_draw(
        root_mass=float(_REQUEST_ROOT_MASS.root_counts[0]),
        kernels=carrier_kernels + subject_kernels,
        days=horizon_len,
        max_tau=horizon,
        S=S,
    )


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
    return span.node_density(node_id)


def read_edge_contribution_draws(
    span: ComposedPrimitiveSpan, edge_key: str,
) -> np.ndarray:
    """Per-(draw, τ) value contribution flowing through the named
    concrete edge. Coincident sibling edges have distinct entries."""
    return span.edge_contribution(edge_key)


@dataclass(frozen=True)
class SelectedCohortRowProjection:
    """Per-request row reducer surfaces.

    Per FC proposal §9.7 the projection exposes four explicit surfaces:

    - **Strict empirical** (``evidence_x_strict``, ``evidence_y_strict``,
      ``rate_strict``) — Σ_applicable strict empirical cumulatives on
      the selected clock; supplies E mode and the evidence layer in
      E+F mode.
    - **Conditioned model** (``f_x_draws``, ``f_y_draws``,
      ``f_rate_draws``) — unspliced full-root, query-conditioned model
      surface under the epistemic basis. F mode renders this surface.
    - **Frontier-conditioned (FC)** (``ef_x_draws``, ``ef_y_draws``,
      ``ef_rate_draws``) — prefix-pinned to strict evidence through
      each Cohort's ``tau_observed`` then continued from the frontier
      ledger via the predictive residual operator. Atom 6 remapped the
      public E+F forecast-layer chart fields (``midpoint`` / ``fan_*`` /
      ``forecast_*``) to read this surface.
    - **FC future residuals** (``ef_forecast_x``, ``ef_forecast_y``) —
      direct future-only deltas (``ef_x - strict_x``, ``ef_y - strict_y``)
      emitted by the frontier continuation, not subtracted post-hoc.

    DP-derived coverage and adjusted evidence outputs are intentionally
    absent. ``applicability_row`` is a simple Cohort applicability
    scalar for display alpha.
    """
    f_rate_draws: np.ndarray             # (S, T) — unspliced; f_y / f_x
    f_x_draws: np.ndarray                # (S, T) — unspliced; cumulative
    f_y_draws: np.ndarray                # (S, T) — unspliced; cumulative
    f_x_draws_by_cohort: np.ndarray      # (C, S, T)
    f_y_draws_by_cohort: np.ndarray      # (C, S, T)
    f_rate_draws_by_cohort: np.ndarray   # (C, S, T) — NaN on 0/0
    applicability_row: np.ndarray         # (T,) — applicable cohorts / selected cohorts
    applicable_cohort_count: np.ndarray   # (T,)
    evidence_x_strict_by_anchor_tau: Mapping[Any, np.ndarray]   # (T,)
    evidence_y_strict_by_anchor_tau: Mapping[Any, np.ndarray]
    evidence_x_strict: np.ndarray         # (T,) — Σ_applicable strict_x_A
    evidence_y_strict: np.ndarray         # (T,) — Σ_applicable strict_y_A
    rate_strict: np.ndarray               # (T,) — evidence_y_strict / evidence_x_strict
    # Frontier-conditioned (FC) surface — required, no default. Built
    # by the FC continuation pass per FC proposal §5.4 / §9.6:
    # fixed empirical prefix through each Cohort's frontier f_c plus
    # predictive continuation from the frontier ledger. Pre-Atom-6 the
    # public forecast-layer chart fields still read `*_spliced`; Atom 6
    # remaps them to read `ef_*`.
    ef_x_draws: np.ndarray               # (S, T) — cumulative, summed across cohorts
    ef_y_draws: np.ndarray               # (S, T)
    ef_rate_draws: np.ndarray            # (S, T) — ef_y / ef_x with NaN on 0/0
    ef_forecast_x: np.ndarray            # (S, T) — future residual: ef_x - strict_x
    ef_forecast_y: np.ndarray            # (S, T) — future residual: ef_y - strict_y
    # Per-Cohort views (73q Phase 2, §"Per-Cohort un-aggregation"). These
    # are the canonical product of the FC continuation; the aggregate
    # ``ef_*`` above is exactly their ``.sum(axis=0)`` reduction. The tau
    # reducer reads the aggregate; the date reducer (73q Phase 3) indexes
    # these per-Cohort directly. ``ef_rate_draws_by_cohort`` is per-Cohort
    # ``ef_y / ef_x`` under the same NaN-on-0/0 policy as the aggregate.
    # The ordered strict-evidence arrays carry the same per-Cohort data as
    # the anchor-keyed maps above, in selected-Cohort order.
    ef_x_draws_by_cohort: np.ndarray         # (C, S, T)
    ef_y_draws_by_cohort: np.ndarray         # (C, S, T)
    ef_rate_draws_by_cohort: np.ndarray      # (C, S, T) — NaN on 0/0
    ef_forecast_x_by_cohort: np.ndarray      # (C, S, T)
    ef_forecast_y_by_cohort: np.ndarray      # (C, S, T)
    evidence_x_strict_by_cohort: np.ndarray  # (C, T)
    evidence_y_strict_by_cohort: np.ndarray  # (C, T)
    diagnostics: Mapping[str, Any] = field(default_factory=dict)


def _summarise_empirical_span(span: ComposedPrimitiveSpan) -> Mapping[str, Any]:
    primitives = []
    for ce, primitive in span.empirical_edge_primitives:
        source_days = sorted(primitive.value_kernel_draws_by_source_day.keys())
        saturation = np.asarray(primitive.saturation_per_draw, dtype=np.float32)
        raw_by_day: Dict[str, Dict[str, float]] = {}
        for point in primitive.resolution.raw_evidence_set.points:
            day = str(point.candidate.coordinate.observed_date)[:10]
            bucket = raw_by_day.setdefault(day, {'n': 0.0, 'k': 0.0, 'rows': 0.0})
            bucket['n'] += float(point.n)
            bucket['k'] += float(point.k)
            bucket['rows'] += 1.0
        bound_by_day: Dict[str, Dict[str, float]] = {}
        for row in primitive.resolution.weighted_view.rows:
            day = str(row.observed_date)[:10]
            bucket = bound_by_day.setdefault(day, {
                'n_weighted': 0.0,
                'k_weighted': 0.0,
                'rows': 0.0,
            })
            bucket['n_weighted'] += float(row.n_weighted)
            bucket['k_weighted'] += float(row.k_weighted)
            bucket['rows'] += 1.0
        raw_days = sorted(raw_by_day)
        bound_days = sorted(bound_by_day)
        zero_clock_weight_days = sorted(set(raw_days) - set(bound_days))

        def _rate_bucket(bucket: Mapping[str, float], n_key: str, k_key: str):
            n = float(bucket.get(n_key, 0.0))
            k = float(bucket.get(k_key, 0.0))
            return {
                **dict(bucket),
                'rate': (k / n) if n > 0.0 else None,
            }

        primitives.append({
            'edge_key': ce.edge_key,
            'from_node': ce.from_id,
            'to_node': ce.to_id,
            'source_day_count': len(source_days),
            'first_source_day': source_days[0] if source_days else None,
            'last_source_day': source_days[-1] if source_days else None,
            'weighted_row_count': len(primitive.resolution.weighted_view.rows),
            'zero_clock_weight_row_count': (
                primitive.resolution.diagnostics.zero_clock_weight_row_count
            ),
            'raw_candidate_date_count': len(raw_days),
            'first_raw_candidate_date': raw_days[0] if raw_days else None,
            'last_raw_candidate_date': raw_days[-1] if raw_days else None,
            'bound_date_count': len(bound_days),
            'first_bound_date': bound_days[0] if bound_days else None,
            'last_bound_date': bound_days[-1] if bound_days else None,
            'zero_clock_weight_date_count': len(zero_clock_weight_days),
            'first_zero_clock_weight_date': (
                zero_clock_weight_days[0] if zero_clock_weight_days else None
            ),
            'last_zero_clock_weight_date': (
                zero_clock_weight_days[-1] if zero_clock_weight_days else None
            ),
            'raw_by_day_sample': {
                day: _rate_bucket(raw_by_day[day], 'n', 'k')
                for day in (raw_days[:5] + raw_days[-5:])
            },
            'bound_by_day_sample': {
                day: _rate_bucket(bound_by_day[day], 'n_weighted', 'k_weighted')
                for day in (bound_days[:5] + bound_days[-5:])
            },
            'zero_clock_weight_days_sample': (
                zero_clock_weight_days[:10] + zero_clock_weight_days[-10:]
            ),
            'saturation_mean': (
                float(np.mean(saturation)) if saturation.size else None
            ),
            'saturation_min': (
                float(np.min(saturation)) if saturation.size else None
            ),
            'saturation_max': (
                float(np.max(saturation)) if saturation.size else None
            ),
        })
    return {
        'x_node_id': span.x_node_id,
        'end_node_id': span.end_node_id,
        'evidence_readout_binding': span.evidence_readout_binding.mode,
        'primitive_count': len(span.empirical_edge_primitives),
        'primitives': primitives,
    }


def _summarise_density_trace(trace: Any) -> Mapping[str, Any]:
    def _surface_summary(surface: np.ndarray) -> Mapping[str, Any]:
        arr = np.asarray(surface, dtype=np.float32)
        cumulative = np.cumsum(arr, axis=1) if arr.size else arr
        final = cumulative[:, -1] if cumulative.size else np.asarray([], dtype=np.float32)
        active_columns = (
            np.flatnonzero(np.any(np.abs(arr) > 0.0, axis=0)).astype(int).tolist()
            if arr.ndim == 2 else []
        )
        return {
            'shape': list(arr.shape),
            'active_column_count': len(active_columns),
            'first_active_column': active_columns[0] if active_columns else None,
            'last_active_column': active_columns[-1] if active_columns else None,
            'final_cumulative_mean': float(np.mean(final)) if final.size else 0.0,
            'final_cumulative_min': float(np.min(final)) if final.size else 0.0,
            'final_cumulative_max': float(np.max(final)) if final.size else 0.0,
        }

    return {
        'nodes': {
            str(node): _surface_summary(trace.node_density(node))
            for node in trace.node_density_by_node_bucket
        },
        'edges': {
            str(edge): _surface_summary(trace.edge_contribution(edge))
            for edge in trace.edge_contribution_by_edge_source
        },
    }


# ─── Frontier occupancy (FC proposal §5.2 / §9.3) ─────────────────────


@dataclass(frozen=True)
class FrontierOccupancyLedger:
    """Per-cohort frontier-occupancy state derived from a source-aware DP trace.

    Built per role (carrier or subject) at each selected Cohort's
    observation frontier ``f_c``. The terminal node for the role is
    EXCLUDED from unresolved occupancy: terminal mass already lives in
    the fixed terminal prefix and would otherwise be double-counted.

    Surfaces:

    - ``occupancy_by_node_bucket[node][source_bucket][basis_int]`` —
      ``(cohort, draw)`` per-cohort per-draw unresolved mass at
      ``node`` from arrival bucket ``source_bucket`` carrying basis
      ``basis_int`` at that Cohort's frontier ``f_c``. Computed as
      ``arrivals[U, u] − departures[U, u, ≤ f_c]`` straight from the
      empirical trace and stored under the bucket's single basis key
      (perimeter contract — mixed-basis frontier buckets raise). No
      per-provenance apportionment: same (role, node, bucket, basis)
      merges. Basis lives as the inner dict key because it's a
      kernel-dispatch property (POINT_AT_ENDPOINT vs
      BUCKET_DISTRIBUTED select different conditioned kernels), so
      the continuation DP can iterate per basis and fire one kernel
      call per basis branch at each source bucket. Empty buckets and
      off-path nodes are absent from the mapping.
    - ``terminal_arrivals_cumulative`` — ``(cohort, draw, T)`` per-draw
      cumulative arrivals at the role's terminal node by each row age.
      Drives the fixed terminal prefix for ``τ <= f_c`` and seeds the
      future-X-arrival ledger when the carrier role's continuation hands
      off to ordinary predictive subject kernels.
    - ``terminal_at_f`` — ``(cohort, draw)`` value of the terminal
      cumulative at each Cohort's own frontier ``f_c``.
    - ``root_total`` — ``(cohort, draw)`` per-cohort per-draw root mass
      injected at the topology's seed bucket. Used by the conservation
      check; equals ``N_anchor`` per Cohort in the typical request shape.

    Conservation: ``terminal_at_f[c, s] + Σ occupancy[c, s] == root_total[c, s]``
    holds algebraically by construction (arrivals − departures + terminal
    = seed). The contract is exercised by unit tests, not asserted at
    runtime.

    Per-Cohort frontiers are independent: every helper here uses the
    Cohort's own ``f_c``, never a group-level ``tau_solid_max``.
    """
    occupancy_by_node_bucket: Mapping[
        str, Mapping[int, Mapping[int, np.ndarray]]
    ]
    terminal_arrivals_cumulative: np.ndarray
    terminal_at_f: np.ndarray
    root_total: np.ndarray
    terminal_node_id: str
    cohort_count: int
    draw_count: int
    horizon_len: int

    @property
    def is_empty_occupancy(self) -> bool:
        """True when no non-terminal node carries unresolved mass.

        Holds for an identity span where the topology root equals the
        terminal — every grain of mass arrives at the terminal at the
        seed bucket and there is no in-transit residue to continue.
        """
        return not self.occupancy_by_node_bucket


def _on_path_outgoing(
    topology: SpanTopology, node: str
) -> Tuple[ConcreteEdge, ...]:
    """Concrete edges leaving ``node`` whose destinations are on-path.

    Mirrors ``SpanTopology.incoming_concrete_edges`` but for the
    outgoing direction. The DP only fires on-path outgoing edges, so
    departures via on-path outgoing edges are exactly the mass that
    leaves ``node`` through the DP.
    """
    return tuple(
        ce for ce in topology.concrete_edges
        if ce.from_id == node and ce.to_id in topology.on_path
    )


def _cumulative_at_frontier(
    cum_cdT: np.ndarray, f_by_cohort_arr: np.ndarray,
) -> np.ndarray:
    """Per-cohort cumulative-through-frontier with safe ``f_c = -1`` handling.

    Inputs:
      - ``cum_cdT``: ``(C, D, T)`` cumulative along the τ axis.
      - ``f_by_cohort_arr``: ``(C,)`` int64 frontier indices in
        ``[-1, T-1]``. The value ``-1`` is the off-the-left-edge
        sentinel for cohorts with no observations: algebraically the
        cumulative-through-frontier is zero (empty closed sum), but a
        naive ``np.take_along_axis(cum_cdT, -1, axis=-1)`` follows
        Python negative-indexing and returns ``cum_cdT[..., T-1]``
        instead — the full τ-tail mass, not zero. The pad-leading-zero
        idiom prepends a zero column and looks up ``f_c + 1``, mapping
        ``-1 → padded[0] = 0`` and ``k ≥ 0 → padded[k+1] = cum[k]``
        uniformly. No mode branch, no ``np.where`` on the sentinel.

    Returned shape is ``(C, D, 1)`` — squeeze the trailing axis at the
    call site if a 2-D result is wanted.
    """
    C = cum_cdT.shape[0]
    D = cum_cdT.shape[1]
    pad = np.zeros((C, D, 1), dtype=cum_cdT.dtype)
    padded = np.concatenate([pad, cum_cdT], axis=-1)  # (C, D, T+1)
    shifted = (f_by_cohort_arr + 1)[:, None, None]    # (C, 1, 1) ∈ [0, T]
    return np.take_along_axis(padded, shifted, axis=-1)


def build_frontier_occupancy(
    *,
    trace: SpanDPTrace,
    topology: SpanTopology,
    terminal_node_id: str,
    frontier_by_cohort: Sequence[int],
    cohort_count: int,
    draw_count: int,
) -> FrontierOccupancyLedger:
    """Build a frontier-occupancy ledger from a source-aware DP trace.

    Per FC plan §9.3 the helper consumes **only** the empirical trace.
    For each on-path non-terminal node ``U`` and each arrival bucket
    ``u`` populated in the trace, occupancy at Cohort frontier ``f_c`` is

        occupancy[U][u][c, s] =
            arrivals[U, u, c, s] − Σ_{e on-path outgoing from U}
                                   Σ_{τ ≤ f_c} edge_contribution[e][u][c, s, τ]

    Arrivals come from ``trace.node_density_by_node_bucket[U][u]``
    (sum-over-provenance per (node, bucket)); departures from
    ``trace.edge_contribution_by_edge_source[e][u]`` summed over the
    trace's own per-edge per-source-bucket smear up to each cohort's
    own frontier. This is the spec equation literally — no per-
    provenance apportionment, no proportional allocation, no model
    kernel: §9.3 is explicit that frontier occupancy is empirical
    state.

    Buckets with ``u > f_c`` contribute zero occupancy at that Cohort
    by construction — the trace places no mass at any downstream
    column before ``u``, so the departure cumulative is zero and the
    bucket-visibility factor ``(u ≤ f_c)`` further zeros the result so
    "arrived after the frontier" mass does not leak into occupancy.

    Per-(node, bucket) basis is read from the trace's
    ``node_basis_by_node_bucket`` map. The continuation DP fires one
    kernel per (node, bucket); buckets that received mass from multiple
    upstream bases (a rare regime — basis at a bucket is normally
    determined by the incoming edge's deposit convention) are a
    perimeter violation and raise ``ValueError``.

    The terminal node is excluded — its mass is carried by the fixed
    terminal prefix instead. Per-Cohort frontiers are independent; per
    §5.2 the helper never uses a group-level cap.
    """
    S_total = int(cohort_count) * int(draw_count)
    T = int(trace.horizon_len)
    # ``f_c = -1`` is the off-the-left-edge sentinel for empty-frames
    # cohorts. Never used as a ``take_along_axis`` index directly —
    # ``_cumulative_at_frontier`` applies the ``+1`` shift internally.
    # Comparison sites (``u <= f_c``, ``col_idx <= f_c``) handle ``-1``
    # correctly under Python ``<=``.
    f_by_cohort_arr = np.asarray(frontier_by_cohort, dtype=np.int64)

    nonterminal_nodes = topology.on_path - {terminal_node_id}
    occupancy_by_node_bucket: Dict[
        str, Dict[int, Dict[int, np.ndarray]]
    ] = {}

    # Trace contract (Atom 3): ``node_density_by_node_bucket`` and
    # ``node_basis_by_node_bucket`` are pre-allocated for every node
    # in ``topo.on_path`` — nodes with no arrivals carry an empty
    # inner mapping, but the outer key is present. Direct indexing
    # here is the engine's enforcement of that contract: a missing
    # on-path node, or a basis-map that does not mirror the density
    # map at every bucket, surfaces as ``KeyError`` immediately.
    for U in nonterminal_nodes:
        outgoing_edges = _on_path_outgoing(topology, U)
        node_density_by_bucket = trace.node_density_by_node_bucket[U]
        node_basis_by_bucket = trace.node_basis_by_node_bucket[U]
        node_occ: Dict[int, Dict[int, np.ndarray]] = {}
        for bucket, arrivals_flat in node_density_by_bucket.items():
            u = int(bucket)
            arrivals_cd = np.asarray(
                arrivals_flat, dtype=np.float32,
            ).reshape(cohort_count, draw_count)

            # Empirical departures from (U, u) by each Cohort's
            # frontier ``f_c``, summed over on-path outgoing edges.
            # ``edge_contribution_by_edge_source[e][u]`` is the
            # trace's per-(draw, τ) smear of mass leaving ``U`` via
            # ``e`` from source bucket ``u``. The cumulative
            # ``Σ_{τ ≤ f_c}`` of that smear is the empirical
            # departures to-date through that edge. Sum across all
            # on-path outgoing edges to get total departures.
            total_dep_cd = np.zeros(
                (cohort_count, draw_count), dtype=np.float32,
            )
            for ce in outgoing_edges:
                edge_src_map = trace.edge_contribution_by_edge_source[ce.edge_key]
                if u not in edge_src_map:
                    # Edge carries no flow from this bucket → adds
                    # zero. Iteration with an absent key adds the
                    # additive identity, no defensive fallback
                    # invoked.
                    continue
                edge_smear = np.asarray(
                    edge_src_map[u], dtype=np.float32,
                ).reshape(cohort_count, draw_count, T)
                cum_dep_cdT = np.cumsum(edge_smear, axis=-1)
                total_dep_cd = total_dep_cd + _cumulative_at_frontier(
                    cum_dep_cdT, f_by_cohort_arr,
                ).squeeze(-1)

            # Bucket-visibility gate. Mass at ``(U, u)`` is only
            # "visible" at frontier ``f_c`` for cohorts whose
            # frontier is at or after ``u`` — at earlier frontiers
            # the cohort has not yet reached the row age where this
            # bucket's arrivals show up, so occupancy must be zero.
            # Multiplicative gate, no branch.
            bucket_visible_c = (u <= f_by_cohort_arr).astype(np.float32)
            unresolved_cd = (
                (arrivals_cd - total_dep_cd) * bucket_visible_c[:, None]
            )

            # Single basis per (node, bucket) at the frontier —
            # perimeter contract enforced by the trace's
            # construction. The trace's per-prov basis map at this
            # bucket must contain exactly one distinct basis;
            # mixed-basis frontier buckets indicate an upstream
            # construction error.
            bucket_basis_map = node_basis_by_bucket[bucket]
            distinct_bases = {int(b) for b in bucket_basis_map.values()}
            if len(distinct_bases) > 1:
                raise ValueError(
                    f"mixed BucketSourceBasis at frontier "
                    f"({U}, bucket={u}): {distinct_bases} — frontier "
                    f"occupancy requires a single basis per (node, "
                    f"bucket); upstream trace violates the perimeter "
                    f"contract.",
                )
            the_basis = next(iter(distinct_bases))
            node_occ[u] = {the_basis: unresolved_cd}
        occupancy_by_node_bucket[U] = node_occ

    # Terminal cumulative arrivals — the fixed prefix the FC
    # continuation rides on.
    terminal_density_cdT = trace.node_density(terminal_node_id).reshape(
        cohort_count, draw_count, T
    )
    terminal_arrivals_cumulative = np.cumsum(terminal_density_cdT, axis=-1)

    # Per-cohort terminal cumulative at f_c via vectorised indexing —
    # no per-cohort Python loop. ``_cumulative_at_frontier`` handles
    # the ``f_c = -1`` sentinel (off-the-left-edge → 0).
    terminal_at_f = _cumulative_at_frontier(
        terminal_arrivals_cumulative, f_by_cohort_arr,
    ).squeeze(-1)

    # Root total per (cohort, draw): the mass injected at the
    # topology's root, summed over arrival buckets. Direct indexing
    # on the root node — the topology root is always on-path, so the
    # trace contract guarantees the entry exists. Empty inner maps
    # sum to the zero accumulator by the additive identity of an
    # empty for-loop.
    root_arrivals = trace.node_density_by_node_bucket[topology.x_node_id]
    root_total_flat = np.zeros(S_total, dtype=np.float32)
    for bucket_mass in root_arrivals.values():
        root_total_flat = root_total_flat + np.asarray(
            bucket_mass, dtype=np.float32,
        )
    root_total = root_total_flat.reshape(cohort_count, draw_count)

    return FrontierOccupancyLedger(
        occupancy_by_node_bucket=occupancy_by_node_bucket,
        terminal_arrivals_cumulative=terminal_arrivals_cumulative,
        terminal_at_f=terminal_at_f,
        root_total=root_total,
        terminal_node_id=terminal_node_id,
        cohort_count=int(cohort_count),
        draw_count=int(draw_count),
        horizon_len=T,
    )


def _build_kernel_toeplitz(K: np.ndarray, T: int) -> np.ndarray:
    """Lower-triangular Toeplitz matrix from a per-draw kernel.

    Given ``K`` of shape ``(D, T)`` returns a tensor ``T_mat`` of
    shape ``(D, T, T)`` with ``T_mat[d, v, u] = K[d, v - u]`` for
    ``v >= u`` and zero elsewhere. The batched DP convolution
    ``out[c, d, v] = sum_u M[c, d, u] × K[d, v - u]`` then reduces
    to a single ``einsum('cdu,dvu->cdv', M, T_mat)`` — one BLAS-
    backed matmul per (edge, basis) instead of a per-source-bucket
    Python loop.
    """
    v_idx = np.arange(T)
    u_idx = np.arange(T)
    offset = v_idx[:, None] - u_idx[None, :]  # (T, T)
    valid = offset >= 0
    # ``K[:, np.clip(offset, 0, T-1)]`` gathers along the kernel
    # axis; the ``np.where`` zeros the upper-triangular wrap-around.
    return np.where(
        valid[None, :, :],
        K[:, np.clip(offset, 0, T - 1)],
        0.0,
    )


def _make_predictive_kernel_provider(
    span: ComposedPrimitiveSpan,
    *,
    horizon: int,
    cdf_renorm_tolerance: float = ComposeOptions.cdf_renorm_tolerance,
) -> Any:
    """Return a per-edge predictive kernel provider for the FC continuation DP.

    Builds the conditioned endpoint / bucket kernel maps at the span's
    native ``max_tau`` and exposes them sliced to the caller's
    ``horizon`` so the returned kernels have shape ``(draw_count,
    horizon - source_index)`` — matching the FC continuation DP's
    expected signature when the analyse-level horizon is smaller than
    the span's native max_tau.

    Returns ``(kernel, out_basis)`` tuples uniformly so consumers do
    not need a contract-shape ``isinstance`` branch. ``out_basis`` is
    derived from the edge's latency metadata exactly as the Atom-3 DP
    derives the default — non-latent edges propagate as
    ``POINT_AT_ENDPOINT`` (Dirac landing), latent edges smear as
    ``BUCKET_DISTRIBUTED``. The basis lives on the edge data, never
    on a runtime conditional.
    """
    S = int(span.draw_count)
    T_span = int(span.max_tau) + 1
    T_outer = int(horizon)
    endpoint_kernels, bucket_kernels = _conditioned_kernel_maps(
        edge_primitives=span.conditioned_edge_primitives,
        S=S,
        T=T_span,
        cdf_renorm_tolerance=cdf_renorm_tolerance,
    )
    # Basis → per-edge-key kernel map. Dict lookup replaces a basis
    # if/else dispatch; an unknown basis raises naturally as KeyError.
    kernels_by_basis: Mapping[BucketSourceBasis, Mapping[str, np.ndarray]] = {
        BucketSourceBasis.BUCKET_DISTRIBUTED: bucket_kernels,
        BucketSourceBasis.POINT_AT_ENDPOINT: endpoint_kernels,
    }
    # Per-edge output basis lookup, materialised once from the edge
    # metadata so the provider's hot path is a pure dict get with no
    # per-call edge_data introspection. ``p`` and ``p.latency`` are
    # required by the parameterised-edge perimeter contract — these
    # spans went through ``compose_primitive_span`` which only admits
    # parameterised edges. Missing ``p`` or ``p.latency`` is a
    # perimeter violation, surfaced via direct indexing.
    # ``latency_parameter`` itself is intentionally read with
    # ``.get(...)``: per the production graph schema convention
    # (see ``model_resolver.py:325`` and ``timing_span.py:766``),
    # absent ``latency_parameter`` means LATENT (BUCKET_DISTRIBUTED).
    # Only an explicit ``False`` flips the edge to POINT_AT_ENDPOINT.
    # This is the documented schema semantic, not a defensive default.
    out_basis_by_edge: Dict[str, BucketSourceBasis] = {}
    for ce, _primitive in span.conditioned_edge_primitives:
        latency = ce.edge_data['p']['latency']
        if latency.get('latency_parameter') is False:
            out_basis_by_edge[ce.edge_key] = BucketSourceBasis.POINT_AT_ENDPOINT
        else:
            out_basis_by_edge[ce.edge_key] = BucketSourceBasis.BUCKET_DISTRIBUTED

    def provider(
        ce: ConcreteEdge,
        source_index: int,
        source_basis: BucketSourceBasis,
    ) -> Tuple[np.ndarray, BucketSourceBasis]:
        # Cohort-invariant kernel: shape ``(D, T_outer - source_index)``.
        # The DP broadcasts against ``bucket_mass_3d[:, :, None]`` of
        # shape ``(C, D, 1)`` so the cohort axis materialises at
        # multiplication without any per-cohort kernel call.
        kernel = kernels_by_basis[source_basis][ce.edge_key][
            :, : T_outer - int(source_index)
        ]
        return kernel, out_basis_by_edge[ce.edge_key]

    # Batched code path: one matmul per (edge, basis) instead of per
    # (source bucket). Cached per (edge_key, basis_int) so the
    # Toeplitz construction runs once per shadow surface assembly.
    toeplitz_cache: Dict[Tuple[str, int], np.ndarray] = {}

    def batched_op(
        ce: ConcreteEdge,
        source_basis: BucketSourceBasis,
        source_mass_3d: np.ndarray,
    ) -> Tuple[np.ndarray, BucketSourceBasis]:
        """Apply the edge's kernel to a full per-(node, basis) source
        mass tensor ``(C, D, T)`` in one BLAS-backed contraction.

        Returns the destination contribution ``(C, D, T)`` and the
        edge's output basis. The DP detects this method on the
        provider and uses it in place of the per-source-bucket loop.
        """
        cache_key = (ce.edge_key, int(source_basis))
        T_mat = toeplitz_cache.get(cache_key)
        if T_mat is None:
            K = kernels_by_basis[source_basis][ce.edge_key][:, :T_outer]
            T_mat = _build_kernel_toeplitz(K, T_outer)
            toeplitz_cache[cache_key] = T_mat
        # ``M`` shape (C, D, T), ``T_mat`` shape (D, T, T) → out (C, D, T).
        out = np.einsum('cdu,dvu->cdv', source_mass_3d, T_mat, optimize=True)
        return out, out_basis_by_edge[ce.edge_key]

    provider.batched_op = batched_op  # type: ignore[attr-defined]
    return provider


def _project_frontier_continuation_surfaces(
    *,
    composed_carrier_predictive: ComposedPrimitiveSpan,
    composed_subject_predictive: ComposedPrimitiveSpan,
    emp_x_trace: SpanDPTrace,
    emp_y_trace: SpanDPTrace,
    cohort_count: int,
    draw_count: int,
    horizon: int,
    tau_observed_by_anchor: Sequence[int],
    population_seed: np.ndarray,
) -> Mapping[str, np.ndarray]:
    """Build the shadow FC surfaces (ef_x_draws, ef_y_draws, ef_rate_draws,
    ef_forecast_x, ef_forecast_y) via the §5.4 / §9.6 continuation pass.

    FC is a predictive-basis surface: the spans passed in MUST be the
    predictive-basis CONDITIONED spans (``composed_*_predictive`` —
    built by ``resolve_request_spans`` from the predictive-basis
    conditioned primitives, NOT the prior-only
    ``unconditioned_overlays['predictive']`` pair which carries
    ``status=PRIOR_ONLY`` and no evidence). Passing epistemic spans
    here produces an algebraically incorrect FC surface — it would
    mix the f_* model surface's epistemic moment family into a
    forecast role that demands κ-inflated predictive dispersion;
    passing unconditioned-predictive spans drops the bound evidence
    and projects from the prior.

    Steps:

    1. Derive per-cohort frontier-occupancy ledgers ``L_carrier_f`` and
       ``L_subject_f`` from the empirical traces alone (§9.3). The
       occupancy helper consumes no model kernel — survivor is
       ``arrivals − empirical departures`` straight from the trace.
    2. Form the FC carrier seed by adding the future-of-frontier slice
       of the selected-cohort root mass to the empirical carrier
       occupancy at the carrier root. The mask ``u > f_c`` makes the
       injection branchless: empty-frames cohorts with ``f_c = -1``
       receive the whole root seed at ``u = 0`` (``0 > -1``), while
       observed cohorts with ``f_c ≥ 0`` receive nothing at ``u = 0``
       (already accounted for by the empirical prefix). This is the
       algebraic representation of "the selected cohort exists at the
       carrier root on its anchor day" — a fact the empirical trace
       only encodes when an observation captures it, so it must be
       injected explicitly for cohorts without observations.
    3. Wrap the predictive model kernels for carrier and subject with
       node-level residual operators (§9.5). The residual algebra
       degenerates correctly at ``u > f_c`` (``H = 0``, survivor = 1,
       post-mask passes through), so the same DP machinery handles
       both physical frontier residuals and post-frontier root-seed
       mass with no branching.
    4. Run the FC continuation DP three times (§9.6):
       - carrier seed × carrier-residual → future X arrivals;
       - subject ledger × subject-residual → future Y from frontier
         survivors;
       - future X arrivals × ORDINARY subject kernels → future Y from
         Pop C (NOT residual — Pop C members are fresh at X on
         arrival, subject clock starts at zero).
    5. Aggregate per-cohort fixed empirical prefix (τ ≤ f_c) + future
       continuation (τ > f_c), sum across cohorts, divide.
    """
    carrier_topology = composed_carrier_predictive.topology
    subject_topology = composed_subject_predictive.topology

    T = int(horizon) + 1
    S_total = int(cohort_count) * int(draw_count)
    carrier_terminal = composed_carrier_predictive.end_node_id
    subject_terminal = composed_subject_predictive.end_node_id
    subject_root = subject_topology.x_node_id

    # Per §5.2 each Cohort uses its own ``f_c`` = ``tau_observed``.
    f_by_cohort_arr = np.asarray(tau_observed_by_anchor, dtype=np.int64)

    # Occupancy ledgers are derived from the empirical traces ONLY —
    # the predictive kernels are not involved here (§9.3). The
    # predictive kernels DO feed the residual provider (§9.5) and the
    # Pop-C handoff DP below, where they continue unresolved
    # frontier mass into the future.
    carrier_frontier = build_frontier_occupancy(
        trace=emp_x_trace,
        topology=carrier_topology,
        terminal_node_id=carrier_terminal,
        frontier_by_cohort=f_by_cohort_arr,
        cohort_count=cohort_count,
        draw_count=draw_count,
    )
    subject_frontier = build_frontier_occupancy(
        trace=emp_y_trace,
        topology=subject_topology,
        terminal_node_id=subject_terminal,
        frontier_by_cohort=f_by_cohort_arr,
        cohort_count=cohort_count,
        draw_count=draw_count,
    )

    # Predictive base kernels for the residual provider (§9.5) and
    # the Pop-C handoff DP. Built once and reused.
    carrier_base = _make_predictive_kernel_provider(
        composed_carrier_predictive, horizon=T,
    )
    subject_base = _make_predictive_kernel_provider(
        composed_subject_predictive, horizon=T,
    )

    def _occupancy_to_dp_seed(
        ledger: FrontierOccupancyLedger,
    ) -> Mapping[str, Mapping[int, Mapping[int, np.ndarray]]]:
        """Reshape per-(cohort, draw) occupancy entries to the flat
        ``(C * D,)`` row layout the DP consumes. Shape is preserved:
        ``[node][bucket][basis] -> flat mass``.
        """
        return {
            node: {
                bucket: {
                    int(basis): occ.reshape(S_total).copy()
                    for basis, occ in basis_map.items()
                }
                for bucket, basis_map in bucket_map.items()
            }
            for node, bucket_map in ledger.occupancy_by_node_bucket.items()
        }

    # Three continuation passes (§9.6), uniform shape:
    #   carrier-residual:   L_carrier_f × residual carrier kernels  → future X arrivals
    #   subject-residual:   L_subject_f × residual subject kernels  → future Y from frontier
    #   future-X handoff:   future X arrivals × ORDINARY subject kernels → Pop-C future Y
    # The Pop-C handoff is NOT residual: Pop-C members arrive fresh at
    # X after the frontier, with subject clocks starting at zero (§5.4).
    carrier_residual = make_frontier_residual_kernel_provider(
        topology=carrier_topology,
        base_kernel_provider=carrier_base,
        frontier_by_cohort=f_by_cohort_arr,
        cohort_count=cohort_count,
        draw_count=draw_count,
        horizon=T,
    )
    subject_residual = make_frontier_residual_kernel_provider(
        topology=subject_topology,
        base_kernel_provider=subject_base,
        frontier_by_cohort=f_by_cohort_arr,
        cohort_count=cohort_count,
        draw_count=draw_count,
        horizon=T,
    )
    carrier_mass = _occupancy_to_dp_seed(carrier_frontier)
    subject_mass = _occupancy_to_dp_seed(subject_frontier)

    # Future-of-frontier population-mass injection at the carrier root
    # (§9.4 — branchless empty-cohort algebraic degeneracy). Mass source
    # is ``population_seed`` (= ``N_pop`` at τ=0 per cohort): for empty-
    # frames cohorts the synthetic unit prior enters here, while their
    # empirical-trace seed remains zero so strict evidence is unaffected.
    # Mask is ``u > f_c``: for ``f_c = -1`` every bucket survives (full
    # population seed enters at ``u = 0``); for ``f_c ≥ 0`` the seed
    # bucket at ``u = 0`` is masked out (empirical prefix already
    # accounts for the cohort's evidence-side arrival). Basis is
    # BUCKET_DISTRIBUTED — matches the empirical root-deposit convention.
    carrier_root = carrier_topology.x_node_id
    population_seed_cdT = np.asarray(
        population_seed, dtype=np.float32,
    ).reshape(cohort_count, draw_count, T)
    col_idx_T = np.arange(T)
    post_frontier_mask_cT = col_idx_T[None, :] > f_by_cohort_arr[:, None]
    future_population_seed_cdT = (
        population_seed_cdT * post_frontier_mask_cT[:, None, :]
    )
    bucket_distributed_int = int(BucketSourceBasis.BUCKET_DISTRIBUTED)
    carrier_root_buckets = carrier_mass.setdefault(carrier_root, {})  # type: ignore[attr-defined]
    for bucket_u in range(T):
        bucket_mass_flat = future_population_seed_cdT[
            :, :, bucket_u,
        ].reshape(S_total)
        if not np.any(bucket_mass_flat):
            continue
        basis_map = carrier_root_buckets.setdefault(bucket_u, {})
        existing = basis_map.get(bucket_distributed_int)
        basis_map[bucket_distributed_int] = (
            bucket_mass_flat if existing is None else existing + bucket_mass_flat
        )
    # TOEPLITZ_APPLY policy: carrier_residual and subject_residual
    # providers (from `make_frontier_residual_kernel_provider`) expose
    # `.batched_op` — operator-apply via per-(edge, basis) Toeplitz
    # contraction. This is the production-perf path Atom 4b landed;
    # declaring it explicitly here lets the canonical DP core dispatch
    # without any capability inspection inside the loop.
    carrier_continuation = run_dp_from_node_source_ledgers(
        topology=carrier_topology,
        initial_ledger_mass=carrier_mass,
        kernel_provider=carrier_residual,
        cohort_count=cohort_count,
        draw_count=draw_count,
        horizon=horizon,
        execution_policy=DPExecutionPolicy.TOEPLITZ_APPLY,
    )
    subject_continuation = run_dp_from_node_source_ledgers(
        topology=subject_topology,
        initial_ledger_mass=subject_mass,
        kernel_provider=subject_residual,
        cohort_count=cohort_count,
        draw_count=draw_count,
        horizon=horizon,
        execution_policy=DPExecutionPolicy.TOEPLITZ_APPLY,
    )

    future_x_at_terminal = carrier_continuation.node_density(carrier_terminal)
    # Pop-C ledger: every column of the carrier continuation's terminal
    # density is a potential future-X arrival bucket. Future-X arrivals
    # land at the subject root carrying ``POINT_AT_ENDPOINT`` basis
    # (the exact-column arrival convention) so the next hop's kernel
    # dispatch fires with ordinary predictive subject kernels (§5.4 —
    # Pop-C members arrive fresh at X, subject clock starts at zero).
    point_basis_int = int(BucketSourceBasis.POINT_AT_ENDPOINT)
    pop_c_mass: Dict[str, Dict[int, Dict[int, np.ndarray]]] = {
        subject_root: {
            int(b): {
                point_basis_int: future_x_at_terminal[:, int(b)].copy(),
            }
            for b in range(future_x_at_terminal.shape[1])
        }
    }
    # TOEPLITZ_APPLY policy: `subject_base` from
    # `_make_predictive_kernel_provider` exposes `.batched_op` for the
    # ordinary (non-residual) predictive kernel — Pop-C members are
    # fresh at X with subject clock starting at zero, so the
    # production handoff uses operator-apply on the future-X arrival
    # ledger.
    pop_c_continuation = run_dp_from_node_source_ledgers(
        topology=subject_topology,
        initial_ledger_mass=pop_c_mass,
        kernel_provider=subject_base,
        cohort_count=cohort_count,
        draw_count=draw_count,
        horizon=horizon,
        execution_policy=DPExecutionPolicy.TOEPLITZ_APPLY,
    )

    future_x_cdT = future_x_at_terminal.reshape(cohort_count, draw_count, T)
    future_y_frontier_cdT = subject_continuation.node_density(
        subject_terminal,
    ).reshape(cohort_count, draw_count, T)
    future_y_pop_c_cdT = pop_c_continuation.node_density(
        subject_terminal,
    ).reshape(cohort_count, draw_count, T)

    # ── Vectorised pre/post-frontier assembly ─────────────────────
    # Per §5.4: ef_x[c, s, τ] = strict_x_cum[c, s, τ]                 for τ ≤ f_c
    #         = strict_x_cum[c, s, f_c] + future_x_cum_post[c, s, τ]  for τ > f_c
    # where future_x_cum_post[c, s, τ] = Σ_{u=f_c+1}^{τ} future_x[c, s, u]
    # = cumsum(future_x)[c, s, τ] − cumsum(future_x)[c, s, f_c].
    strict_x_cum_cdT = carrier_frontier.terminal_arrivals_cumulative
    strict_y_cum_cdT = subject_frontier.terminal_arrivals_cumulative

    col_idx = np.arange(T)
    pre_mask = col_idx[None, :] <= f_by_cohort_arr[:, None]  # (cohort, T)
    pre_mask_cdT = pre_mask[:, None, :]                       # (cohort, 1, T)

    # Cumulative-at-frontier lookups via the shared helper. The helper
    # implements the pad-leading-zero / ``f_c + 1`` shift so the
    # off-the-left-edge sentinel (``f_c = -1`` for empty-frames cohorts)
    # maps to 0 rather than to the τ-tail of the cumulative — the
    # boundary condition the §1.1 risk-control premise depends on for
    # FC to degenerate to the model curve in zero-evidence mode (see
    # AP58, I-46, ``_cumulative_at_frontier`` docstring).
    strict_x_at_f = _cumulative_at_frontier(strict_x_cum_cdT, f_by_cohort_arr)
    strict_y_at_f = _cumulative_at_frontier(strict_y_cum_cdT, f_by_cohort_arr)

    future_x_cum = np.cumsum(future_x_cdT, axis=-1)
    future_y_frontier_cum = np.cumsum(future_y_frontier_cdT, axis=-1)
    future_y_pop_c_cum = np.cumsum(future_y_pop_c_cdT, axis=-1)
    future_x_cum_at_f = _cumulative_at_frontier(
        future_x_cum, f_by_cohort_arr,
    )
    future_y_frontier_cum_at_f = _cumulative_at_frontier(
        future_y_frontier_cum, f_by_cohort_arr,
    )
    future_y_pop_c_cum_at_f = _cumulative_at_frontier(
        future_y_pop_c_cum, f_by_cohort_arr,
    )

    # Future continuation per cohort × draw × τ — the FC residual past
    # each cohort's own frontier f_c. Zero for τ ≤ f_c by construction
    # (post_mask), non-zero for τ > f_c, sourced directly from the
    # continuation DP cumulants (NOT by subtracting a later evidence
    # curve, which would conflate the cohort's fixed frontier prefix
    # with strict-evidence increments that continue past tau_observed).
    post_mask_cdT = ~pre_mask_cdT
    future_x_cont_cdT = np.where(
        post_mask_cdT, future_x_cum - future_x_cum_at_f, 0.0,
    )
    future_y_cont_cdT = np.where(
        post_mask_cdT,
        (future_y_frontier_cum - future_y_frontier_cum_at_f)
        + (future_y_pop_c_cum - future_y_pop_c_cum_at_f),
        0.0,
    )

    # Total ef surface = fixed frontier prefix (strict evidence up to
    # f_c, then frozen at strict_*_at_f) + future continuation. Both
    # components sum across cohorts naturally; no cross-cohort
    # subtraction needed.
    strict_carried_x_cdT = np.where(
        pre_mask_cdT, strict_x_cum_cdT, strict_x_at_f,
    )
    strict_carried_y_cdT = np.where(
        pre_mask_cdT, strict_y_cum_cdT, strict_y_at_f,
    )
    ef_x_cdT = strict_carried_x_cdT + future_x_cont_cdT
    ef_y_cdT = strict_carried_y_cdT + future_y_cont_cdT

    ef_x_draws = ef_x_cdT.sum(axis=0, dtype=np.float32)
    ef_y_draws = ef_y_cdT.sum(axis=0, dtype=np.float32)
    with np.errstate(divide='ignore', invalid='ignore'):
        ef_rate_draws = ef_y_draws / ef_x_draws  # 0/0 → NaN visibly
        # Per-Cohort rate (73q Phase 2): same NaN-on-0/0 policy, not
        # reduced across cohorts. Rates don't sum, so this is NOT a
        # cohort-axis sum of the aggregate — it is the per-Cohort
        # division the date reducer indexes directly.
        ef_rate_by_cohort = ef_y_cdT / ef_x_cdT  # (C, S, T), 0/0 → NaN

    # FC future residual: sum the per-cohort future continuation across
    # cohorts. Each cohort contributes zero for τ ≤ f_c and its DP
    # cumulant for τ > f_c. This is the algebraic future-only piece
    # carried out of the continuation DP from the per-cohort frontier
    # boundary, not a difference against a moving strict-evidence curve.
    ef_forecast_x = future_x_cont_cdT.sum(axis=0, dtype=np.float32)
    ef_forecast_y = future_y_cont_cdT.sum(axis=0, dtype=np.float32)

    return {
        'ef_x_draws': ef_x_draws,
        'ef_y_draws': ef_y_draws,
        'ef_rate_draws': ef_rate_draws,
        'ef_forecast_x': ef_forecast_x,
        'ef_forecast_y': ef_forecast_y,
        # Per-Cohort views — the canonical product; the aggregates above
        # are exactly their cohort-axis sum (73q Phase 2).
        'ef_x_draws_by_cohort': ef_x_cdT,
        'ef_y_draws_by_cohort': ef_y_cdT,
        'ef_rate_draws_by_cohort': ef_rate_by_cohort,
        'ef_forecast_x_by_cohort': future_x_cont_cdT,
        'ef_forecast_y_by_cohort': future_y_cont_cdT,
    }


def _origin_day_for_anchor(anchor_day: Any) -> date:
    """Calendar origin for source-day-indexed selected-cohort ledgers.

    ``anchor_day`` is a ``date`` or ISO-prefixed string by construction
    (the cohort-list builder), so it parses directly; a malformed value is
    an upstream contract breach and must crash, not be substituted.
    """
    if hasattr(anchor_day, 'isoformat'):
        return date.fromisoformat(str(anchor_day.isoformat())[:10])
    return date.fromisoformat(str(anchor_day)[:10])


# AP58 / engine-discipline violation — commented out 2026-05-19.
# See rationale at the call site inside ``project_selected_cohort_rows``.
# def _span_terminal_is_instant(span: ComposedPrimitiveSpan) -> bool:
#     terminal_density = span.node_density_draws[span.end_node_id]
#     return bool(np.all(np.abs(terminal_density[:, 1:]) <= 1e-12))
#
#
# def _subject_root_n_seed_flat(
#     *,
#     composed_subject: ComposedPrimitiveSpan,
#     selected_cohorts: Sequence[Mapping[str, Any]],
#     S: int,
#     T: int,
# ) -> np.ndarray:
#     n_by_source_day: Dict[str, float] = {}
#     for ce, primitive in composed_subject.empirical_edge_primitives:
#         if ce.from_id != composed_subject.x_node_id:
#             continue
#         for row in primitive.resolution.weighted_view.rows:
#             observed_date = str(row.observed_date)[:10]
#             n_by_source_day[observed_date] = max(
#                 n_by_source_day.get(observed_date, 0.0),
#                 float(row.n),
#             )
#
#     seed = np.zeros((len(selected_cohorts) * S, T), dtype=np.float32)
#     for cohort_idx, cohort in enumerate(selected_cohorts):
#         anchor_day = str(cohort['anchor_day'])[:10]
#         seed[cohort_idx * S:(cohort_idx + 1) * S, 0] = (
#             n_by_source_day.get(anchor_day, 0.0)
#         )
#     return seed


def project_selected_cohort_rows(
    *,
    composed_carrier: ComposedPrimitiveSpan,
    composed_subject: ComposedPrimitiveSpan,
    composed_carrier_predictive: ComposedPrimitiveSpan,
    composed_subject_predictive: ComposedPrimitiveSpan,
    composed_empirical_carrier: ComposedPrimitiveSpan,
    composed_empirical_subject: ComposedPrimitiveSpan,
    selected_cohorts: Sequence[Mapping[str, Any]],
    horizon: int,
) -> SelectedCohortRowProjection:
    """The selected-cohort row reducer.

    The model path reads conditioned value kernels. The observed path
    reads empirical value kernels, preserving strict ``k/n`` evidence on
    the selected clock. Coverage is deliberately reduced to simple
    Cohort applicability; adjusted evidence is not part of this reducer.

    The FC shadow surface (Atom 4) reads ``composed_*_predictive`` —
    the predictive-basis CONDITIONED composed spans that
    ``resolve_request_spans`` builds alongside the epistemic
    ``composed_carrier`` / ``composed_subject`` pair (same bound
    evidence, ``dispersion_basis='predictive'``). The runtime's
    ``unconditioned_overlays['predictive']`` pair carries no admitted
    evidence (status PRIOR_ONLY) and is NOT a substitute. The
    epistemic-basis spans continue to drive the f_* model surface;
    they are NOT a substitute either — passing them on the FC path
    mixes the wrong moment family.
    """
    S = int(composed_carrier.draw_count)
    T = int(horizon) + 1
    evidence_readout_binding = composed_subject.evidence_readout_binding

    cohort_count = len(selected_cohorts)
    anchor_days = [cohort['anchor_day'] for cohort in selected_cohorts]
    origin_days = [
        _origin_day_for_anchor(anchor_day)
        for anchor_day in anchor_days
    ]
    # Two distinct seed surfaces — branchless engine, semantics carried
    # by data values (see ``_build_selected_cohort_inputs`` docstring):
    #
    #   empirical_seed_flat (= N_anchor at τ=0) feeds the EMPIRICAL
    #     carrier trace. Honours the ``emp_x = N_anchor`` test contract
    #     (``test_strict_evidence_x_window_mode_equals_cohort_size``).
    #     Zero for empty-frames cohorts so strict-evidence row fields
    #     publish ``None`` rather than the synthetic unit prior.
    #
    #   population_seed_flat (= N_pop at τ=0) feeds the CONDITIONED
    #     MODEL trace AND the FC future-root injection
    #     (``_project_frontier_continuation_surfaces``). Carries the empty-
    #     frames unit prior so ``f_*`` and ``ef_*`` surfaces produce the
    #     model curve for cohorts without observed evidence.
    #
    # For observed cohorts ``N_anchor = N_pop = n_root`` so the two
    # seeds are numerically identical and behaviour is unchanged.
    empirical_seed_flat = np.zeros((cohort_count * S, T), dtype=np.float32)
    population_seed_flat = np.zeros((cohort_count * S, T), dtype=np.float32)
    tau_max_by_anchor: list[int] = []
    tau_observed_by_anchor: list[int] = []
    for cohort_idx, cohort in enumerate(selected_cohorts):
        # Engine contract: every selected cohort dict carries explicit
        # ``N_anchor``, ``N_pop``, ``tau_max``, ``tau_observed``
        # (perimeter construction is the caller's responsibility — see
        # ``_build_selected_cohort_inputs`` in ``cohort_forecast_v3``).
        # No defaults, clamps, fallbacks, or range checks: malformed
        # inputs surface naturally — a missing key raises ``KeyError``
        # on the dict access; a negative or oversized ``tau_observed``
        # surfaces wherever the downstream algebra first depends on
        # the invariant (e.g. ``np.take_along_axis`` on the frontier
        # index, or the ``prefix_len`` slice in the survivor sum).
        empirical_seed_flat[cohort_idx * S:(cohort_idx + 1) * S, 0] = float(
            cohort['N_anchor'],
        )
        population_seed_flat[cohort_idx * S:(cohort_idx + 1) * S, 0] = float(
            cohort['N_pop'],
        )
        tau_max_by_anchor.append(int(cohort['tau_max']))
        tau_observed_by_anchor.append(int(cohort['tau_observed']))

    x_value_trace = evaluate_conditioned_span_from_seed_flat_origins(
        composed_carrier,
        root_seed=population_seed_flat,
        cohort_count=cohort_count,
        origin_days=origin_days,
        evidence_readout_binding=evidence_readout_binding,
    )
    x_value_flat = x_value_trace.node_density(composed_carrier.end_node_id)
    # Conditioned carrier → subject handoff: thread per-bucket per-
    # provenance state forward so mixed basis at the carrier terminal
    # survives into the subject DP seed. Mirrors the empirical
    # handoff below — same seam shape on both sides so a frontier-state
    # continuation (Atom 4) reads the same provenance surface whether
    # it lives on the conditioned model branch or the empirical
    # branch.
    x_value_provenance_mass = x_value_trace.node_mass_by_provenance[
        composed_carrier.end_node_id
    ]
    x_value_provenance_basis = x_value_trace.node_basis_by_node_bucket[
        composed_carrier.end_node_id
    ]
    y_value_trace = evaluate_conditioned_span_from_seed_flat_origins_with_provenance(
        composed_subject,
        S_flat=x_value_flat.shape[0],
        T=x_value_flat.shape[1],
        cohort_count=cohort_count,
        origin_days=origin_days,
        evidence_readout_binding=evidence_readout_binding,
        root_provenance_mass=x_value_provenance_mass,
        root_provenance_basis=x_value_provenance_basis,
    )
    y_value_flat = y_value_trace.node_density(composed_subject.end_node_id)
    emp_x_trace = evaluate_empirical_span_from_seed_flat_origins(
        composed_empirical_carrier,
        root_seed=empirical_seed_flat,
        origin_days=origin_days,
        evidence_readout_binding=evidence_readout_binding,
        root_basis=np.full(
            T,
            int(BucketSourceBasis.BUCKET_DISTRIBUTED),
            dtype=np.int8,
        ),
    )
    emp_x_value_flat = emp_x_trace.node_density(
        composed_empirical_carrier.end_node_id,
    )
    # Carrier → subject handoff: thread per-provenance state forward so
    # mixed basis at the carrier terminal survives into the subject DP
    # seed. The subject's root node IS the carrier's end node by
    # construction; each provenance there carries its own basis and
    # the subject's first hop fires once per source provenance with
    # the correct basis instead of collapsing to a single per-column
    # selection.
    emp_x_provenance_mass = emp_x_trace.node_mass_by_provenance[
        composed_empirical_carrier.end_node_id
    ]
    emp_x_provenance_basis = emp_x_trace.node_basis_by_node_bucket[
        composed_empirical_carrier.end_node_id
    ]
    # AP58 / engine-discipline violation — commented out 2026-05-19.
    # This branch silently rewrote ``emp_x_value_flat`` with the
    # subject's first-edge ``max(n_observed_on_anchor_day)`` whenever
    # the empirical carrier's terminal was instant (identity carrier,
    # non-latent active carrier, deterministic shift=0). It is:
    #   - an ``if mode == …`` branch around three structurally distinct
    #     cases (CF_ENGINE_DISCIPLINE);
    #   - silent ``.get(anchor_day, 0.0)`` fallback inside the engine
    #     (CF_ENGINE_DISCIPLINE I-47);
    #   - violates the documented test contract ``emp_x = N_anchor``
    #     (`test_strict_evidence_x_window_mode_equals_cohort_size`,
    #     `test_phase6_w1` where N=100, n=25, expected y_sat = N × k/n
    #     = 40 not k = 10).
    # The empirical-carrier propagation immediately above already
    # produces the correct surface for every degeneracy: identity
    # passes ``N_anchor δ(0)`` through; non-latent / deterministic
    # active carriers produce ``N_anchor × ∏ rates at column 0``. The
    # ``saturation = Σ k_observed`` invariant is the perimeter's job
    # (``_build_selected_cohort_inputs`` sources N_anchor from
    # ``_root_window_carrier_n_by_anchor_day``), not the reducer's.
    # if _span_terminal_is_instant(composed_empirical_carrier):
    #     emp_x_value_flat = _subject_root_n_seed_flat(
    #         composed_subject=composed_empirical_subject,
    #         selected_cohorts=selected_cohorts,
    #         S=S,
    #         T=T,
    #     )
    emp_y_trace = evaluate_empirical_span_from_seed_flat_origins_with_provenance(
        composed_empirical_subject,
        S_flat=emp_x_value_flat.shape[0],
        T=emp_x_value_flat.shape[1],
        origin_days=origin_days,
        evidence_readout_binding=evidence_readout_binding,
        root_provenance_mass=emp_x_provenance_mass,
        root_provenance_basis=emp_x_provenance_basis,
    )
    emp_y_value_flat = emp_y_trace.node_density(
        composed_empirical_subject.end_node_id,
    )

    x_value_by_anchor = x_value_flat.reshape(cohort_count, S, T)
    y_value_by_anchor = y_value_flat.reshape(cohort_count, S, T)
    emp_x_value_by_anchor = emp_x_value_flat.reshape(cohort_count, S, T)
    emp_y_value_by_anchor = emp_y_value_flat.reshape(cohort_count, S, T)

    x_model_by_anchor = np.cumsum(x_value_by_anchor, axis=-1)
    y_model_by_anchor = np.cumsum(y_value_by_anchor, axis=-1)

    # Snapshot the unspliced conditioned model surface (F mode) before
    # the per-Cohort strict-prefix splice that produces the spliced E+F
    # surfaces. F mode answers "what does the conditioned model predict
    # for this selected Cohort set, end-to-end" — without inheriting
    # each Cohort's observed prefix.
    # Public aggregate surfaces are small (S,T) relative to the retained
    # per-cohort tensors. Keep the final reductions in float64 so chunking and
    # full projection differ only by intentional summation order, not storage
    # precision.
    f_x_draws = x_model_by_anchor.sum(axis=0, dtype=np.float32)
    f_y_draws = y_model_by_anchor.sum(axis=0, dtype=np.float32)
    f_rate_draws = np.divide(
        f_y_draws, f_x_draws,
        out=np.zeros_like(f_y_draws),
        where=f_x_draws > 0.0,
    )
    with np.errstate(divide='ignore', invalid='ignore'):
        f_rate_by_cohort = y_model_by_anchor / x_model_by_anchor

    evidence_x_strict_by_anchor_tau: Dict[Any, np.ndarray] = {}
    evidence_y_strict_by_anchor_tau: Dict[Any, np.ndarray] = {}
    evidence_x_strict = np.zeros(T, dtype=np.float32)
    evidence_y_strict = np.zeros(T, dtype=np.float32)
    applicable = np.zeros((cohort_count, T), dtype=np.float32)
    # Ordered strict-evidence arrays aligned to selected-Cohort order
    # (73q Phase 2) — same per-Cohort data as the anchor-keyed maps, in
    # the order the date reducer iterates Cohorts.
    strict_x_by_cohort_list: list[np.ndarray] = []
    strict_y_by_cohort_list: list[np.ndarray] = []

    for cohort_idx, anchor_day in enumerate(anchor_days):
        strict_x_a = np.cumsum(
            emp_x_value_by_anchor[cohort_idx], axis=-1,
        ).mean(axis=0)
        strict_y_a = np.cumsum(
            emp_y_value_by_anchor[cohort_idx], axis=-1,
        ).mean(axis=0)
        evidence_x_strict_by_anchor_tau[anchor_day] = strict_x_a
        evidence_y_strict_by_anchor_tau[anchor_day] = strict_y_a
        strict_x_by_cohort_list.append(strict_x_a)
        strict_y_by_cohort_list.append(strict_y_a)

        # Two separate horizons drive two separate signals:
        #
        #   `applicable` (coverage): the cohort is "applicable" at τ
        #   if τ ≤ tau_observed (last fresh observation). Fades
        #   through epoch B as cohorts age past their last retrieval.
        #
        #   evidence τ-clamp: the empirical chain propagation surface
        #   is valid out to tau_max (data extent). Past tau_max the
        #   cohort contributes its frozen value, preserving evidence
        #   monotonicity ("stuff that has converted has converted")
        #   without erasing real data past a possibly-short
        #   tau_observed. Restores the legacy
        #   `SelectedAClockEvidence.aggregate_by_tau` semantic
        #   (`_cell_at_or_before(τ)`) before the spine cutover.
        last_tau_max = min(tau_max_by_anchor[cohort_idx], T - 1)
        last_tau_obs = min(tau_observed_by_anchor[cohort_idx], T - 1)
        applicable[cohort_idx, :last_tau_obs + 1] = 1.0
        tau_indices = np.arange(T)
        clamped = np.minimum(tau_indices, last_tau_max)
        evidence_x_strict += strict_x_a[clamped]
        evidence_y_strict += strict_y_a[clamped]

    applicable_cohort_count = applicable.sum(axis=0, dtype=np.float32)
    applicability_row = (
        applicable_cohort_count / float(cohort_count)
        if cohort_count > 0 else np.zeros(T, dtype=np.float32)
    )

    rate_strict = np.divide(
        evidence_y_strict, evidence_x_strict,
        out=np.zeros_like(evidence_y_strict),
        where=evidence_x_strict > 0.0,
    )

    # ─── FC CONTINUATION SURFACE (production E+F forecast layer) ────
    # The ef_* surfaces are the production E+F forecast layer (Atom 6):
    # per-Cohort frontier-occupancy ledgers (§9.3) propagated through
    # residual predictive operators (§9.5) under the source-ledger DP
    # (§9.6), with future-X arrivals fed into ordinary subject kernels
    # (§5.4 Pop-C handoff). `_project_runtime_rows` reads `ef_rate_draws`
    # for midpoint/fan and `ef_forecast_*` for the residual fields.
    fc = _project_frontier_continuation_surfaces(
        composed_carrier_predictive=composed_carrier_predictive,
        composed_subject_predictive=composed_subject_predictive,
        emp_x_trace=emp_x_trace,
        emp_y_trace=emp_y_trace,
        cohort_count=cohort_count,
        draw_count=S,
        horizon=int(horizon),
        tau_observed_by_anchor=tau_observed_by_anchor,
        population_seed=population_seed_flat,
    )

    return SelectedCohortRowProjection(
        f_rate_draws=f_rate_draws,
        f_x_draws=f_x_draws,
        f_y_draws=f_y_draws,
        f_x_draws_by_cohort=x_model_by_anchor,
        f_y_draws_by_cohort=y_model_by_anchor,
        f_rate_draws_by_cohort=f_rate_by_cohort,
        applicability_row=applicability_row,
        applicable_cohort_count=applicable_cohort_count,
        evidence_x_strict_by_anchor_tau=evidence_x_strict_by_anchor_tau,
        evidence_y_strict_by_anchor_tau=evidence_y_strict_by_anchor_tau,
        evidence_x_strict=evidence_x_strict,
        evidence_y_strict=evidence_y_strict,
        rate_strict=rate_strict,
        ef_x_draws=fc['ef_x_draws'],
        ef_y_draws=fc['ef_y_draws'],
        ef_rate_draws=fc['ef_rate_draws'],
        ef_forecast_x=fc['ef_forecast_x'],
        ef_forecast_y=fc['ef_forecast_y'],
        ef_x_draws_by_cohort=fc['ef_x_draws_by_cohort'],
        ef_y_draws_by_cohort=fc['ef_y_draws_by_cohort'],
        ef_rate_draws_by_cohort=fc['ef_rate_draws_by_cohort'],
        ef_forecast_x_by_cohort=fc['ef_forecast_x_by_cohort'],
        ef_forecast_y_by_cohort=fc['ef_forecast_y_by_cohort'],
        # Branchless (C, T) stack: a list of (T,) arrays → (C, T); the
        # empty selected-cohort case → (0, T) via reshape, no guard.
        evidence_x_strict_by_cohort=np.asarray(
            strict_x_by_cohort_list, dtype=np.float32,
        ).reshape(len(strict_x_by_cohort_list), T),
        evidence_y_strict_by_cohort=np.asarray(
            strict_y_by_cohort_list, dtype=np.float32,
        ).reshape(len(strict_y_by_cohort_list), T),
        diagnostics={
            'cohort_count': cohort_count,
            'horizon': int(horizon),
            'anchor_days_first': str(anchor_days[0]) if anchor_days else None,
            'anchor_days_last': str(anchor_days[-1]) if anchor_days else None,
            'evidence_readout_binding': evidence_readout_binding.mode,
            'empirical_carrier': _summarise_empirical_span(
                composed_empirical_carrier,
            ),
            'empirical_subject': _summarise_empirical_span(
                composed_empirical_subject,
            ),
            'empirical_x_trace': _summarise_density_trace(emp_x_trace),
            'empirical_y_trace': _summarise_density_trace(emp_y_trace),
        },
    )


