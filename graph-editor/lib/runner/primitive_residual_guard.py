"""
Unparameterised edge guard.

Defines the front-gate for edge requirements that primitive
conditioning cannot serve. A refused decision propagates as an
absent primitive plus an explicit diagnostic; the engine never
constructs a posterior-less "refusal" primitive (plan §"Residual /
unparameterised edge guard" line 654-662):

  - The first implementation deliberately does NOT derive residual
    probabilities. It may pass through explicit deterministic graph
    semantics; every other unparameterised case is refused before
    primitive construction with ``forward_to_conditioning=False``.
  - The guard MUST NOT turn supported doc 29b split/join/leakage
    topology into a residual/complement problem. A split, join,
    fan-in, fan-out, or side-exit leakage edge that lies inside the
    carrier or subject closure and has parameterised primitives
    remains a normal DAG-composition case (plan §660).
  - Adjacency-only ``1 - p`` derivation is rejected by the guard.
    CF composition contains no ``1 - p``, residual-sibling, or
    branch-complement code today (baseline §1.9, §1.11); the guard
    refuses adjacency-complement requests rather than computing
    them.
  - No-evidence parameterised primitives remain ``PRIOR_ONLY``
    (Stage 3's `_make_prior_only_primitive`). They never reach the
    guard.
  - Graph-output sibling rebalancing remains owned by
    ``UpdateManager.applyBatchLAGValues`` after CF writeback. The
    guard does not move sibling rebalancing into CF (plan §55,
    §662; baseline §1.11).
  - A prepared span primitive that crosses the X boundary or mixes
    incompatible slice/context/regime/as-at metadata is already
    rejected by ``validate_span_primitive`` in
    ``runner.primitive_evidence`` (Stage 2). The guard consumes the
    rejection signal and refuses to forward to conditioning (plan
    §123, §431, §619).

This module imports only from ``runner.primitives``. It does NOT
import from ``forecast_runtime``, ``forecast_state``,
``cohort_forecast_v3``, ``span_kernel``, ``timing_span``,
or ``primitive_conditioning`` — the guard sits next to the
contract and forms the entry point composers call before invoking
Stage 3 conditioning.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional, Tuple

import numpy as np

from .primitives import (
    CompatibilityBlendProvenance,
    ConditionedTransitionPrimitive,
    ConditioningStatus,
    PrimitiveScope,
    ProbabilityPosterior,
    ResidualPolicyProvenance,
    SubsetPolicyProvenance,
    TimingFamily,
    TimingPosterior,
    TransitionIdentity,
)


# ─── Public API ────────────────────────────────────────────────────────


class EdgeRequirementKind(str, Enum):
    """How an edge participates in primitive composition.

    PARAMETERISED is the only kind that forwards to Stage 3
    conditioning. Every other kind is owned by Stage 4 because
    Stage 3 cannot construct a posterior for it.
    """
    PARAMETERISED = "parameterised"
    STRUCTURALLY_DETERMINISTIC = "structurally_deterministic"
    UNPARAMETERISED_RESIDUAL = "unparameterised_residual"
    UNPARAMETERISED_COMPLEMENT = "unparameterised_complement"
    PREPARED_SPAN_REJECTED = "prepared_span_rejected"


@dataclass(frozen=True)
class EdgeRequirement:
    """Composer-supplied description of one edge needed by composition.

    Stage 5+ composers walk the carrier or subject closure, classify
    each edge they need, and present an ``EdgeRequirement`` to the
    guard. The guard either forwards the requirement to Stage 3
    conditioning (PARAMETERISED) or emits a Stage-4-owned primitive
    in its place.

    ``deterministic_p`` is REQUIRED when ``kind`` is
    ``STRUCTURALLY_DETERMINISTIC`` and FORBIDDEN otherwise. The guard
    must not infer determinism from missing evidence (plan §99).

    ``requires_adjacency_one_minus_p`` is True when composition would
    need to derive this edge's probability from a sibling's
    ``1 - p``. The guard refuses such derivations regardless of
    ``kind`` (plan §55, §660).

    ``branch_complement_target`` and ``residual_closure_target`` name
    the structural element the composer would have needed; they are
    surfaced through the resulting ``ResidualPolicyProvenance`` so
    diagnostics can name the missing piece.

    ``prepared_span_rejection_reason`` is set when ``kind`` is
    ``PREPARED_SPAN_REJECTED`` and carries the
    ``SpanValidationResult.rejection_reason`` from Stage 2.
    """
    transition: TransitionIdentity
    kind: EdgeRequirementKind
    deterministic_p: Optional[float] = None
    requires_adjacency_one_minus_p: bool = False
    branch_complement_target: Optional[str] = None
    residual_closure_target: Optional[str] = None
    prepared_span_rejection_reason: Optional[str] = None
    note: Optional[str] = None


@dataclass(frozen=True)
class ResidualGuardDecision:
    """Outcome of classifying an ``EdgeRequirement``.

    ``forward_to_conditioning`` is True for the PARAMETERISED case;
    the composer then calls Stage 3's ``condition_primitive``.

    For every other case, the request is refused before primitive
    construction. ``rejection_reason`` describes why, and
    ``residual_policy`` names the structural element the request
    would have needed (for the residual / complement cases).
    ``deterministic_p`` is set for STRUCTURALLY_DETERMINISTIC edges
    that callers may wire directly to a deterministic-edge primitive
    builder. Refused decisions do not produce a primitive at all —
    they propagate as an absent primitive plus an explicit diagnostic.
    """
    forward_to_conditioning: bool
    rejection_reason: Optional[str]
    residual_policy: Optional[ResidualPolicyProvenance]
    deterministic_p: Optional[float]


def classify_edge_requirement(
    requirement: EdgeRequirement,
) -> ResidualGuardDecision:
    """Decide whether a composer can forward this requirement to Stage 3.

    Decision matrix:

      - PARAMETERISED + no adjacency-complement request →
        forward to conditioning. Stage 3 is the single owner of the
        posterior; if its evidence is empty, Stage 3 emits PRIOR_ONLY.
        The guard never refuses a PARAMETERISED edge that has no
        complement request.
      - PARAMETERISED + adjacency-complement requested → refuse
        (``forward_to_conditioning=False``); ``residual_policy``
        names the complement target (plan §55, §660).
      - STRUCTURALLY_DETERMINISTIC with explicit ``deterministic_p`` →
        ``deterministic_p`` set on the decision; caller wires it to
        ``make_structurally_deterministic_primitive``.
      - STRUCTURALLY_DETERMINISTIC without ``deterministic_p`` →
        ``ValueError``. Determinism is never inferred from missing
        evidence (plan §99).
      - UNPARAMETERISED_RESIDUAL → refuse; ``residual_policy``
        carries ``residual_closure_required``.
      - UNPARAMETERISED_COMPLEMENT → refuse; ``residual_policy``
        carries ``branch_complement_required``.
      - PREPARED_SPAN_REJECTED → refuse; ``rejection_reason``
        carries the Stage 2 ``validate_span_primitive`` reason.

    The ``deterministic_p`` argument-or-not check is enforced as a
    contract on the caller — STRUCTURALLY_DETERMINISTIC without an
    explicit value is an error, and a PARAMETERISED requirement
    arriving with one is a misuse and ignored (the value is dropped
    from the decision).
    """
    if requirement.kind == EdgeRequirementKind.PARAMETERISED:
        if requirement.requires_adjacency_one_minus_p:
            return ResidualGuardDecision(
                forward_to_conditioning=False,
                rejection_reason=(
                    'parameterised edge cannot be derived from a sibling '
                    'adjacency complement; CF composition does not perform '
                    '1 - p sibling derivation (plan §55, §660)'
                ),
                residual_policy=ResidualPolicyProvenance(
                    branch_complement_required=requirement.branch_complement_target,
                    residual_closure_required=None,
                    note=(
                        requirement.note
                        or 'adjacency complement requested for a parameterised edge'
                    ),
                ),
                deterministic_p=None,
            )
        return ResidualGuardDecision(
            forward_to_conditioning=True,
            rejection_reason=None,
            residual_policy=None,
            deterministic_p=None,
        )

    if requirement.kind == EdgeRequirementKind.STRUCTURALLY_DETERMINISTIC:
        if requirement.deterministic_p is None:
            raise ValueError(
                f'STRUCTURALLY_DETERMINISTIC requirement for '
                f'{requirement.transition.edge_id} arrived without an '
                f'explicit deterministic_p; the residual guard must not '
                f'infer determinism from missing evidence (plan §99)'
            )
        if not 0.0 <= float(requirement.deterministic_p) <= 1.0:
            raise ValueError(
                f'deterministic_p={requirement.deterministic_p!r} is out of '
                f'range [0, 1] for {requirement.transition.edge_id}'
            )
        return ResidualGuardDecision(
            forward_to_conditioning=False,
            rejection_reason=None,
            residual_policy=None,
            deterministic_p=float(requirement.deterministic_p),
        )

    if requirement.kind == EdgeRequirementKind.UNPARAMETERISED_RESIDUAL:
        return ResidualGuardDecision(
            forward_to_conditioning=False,
            rejection_reason=(
                f'unparameterised residual closure required for '
                f'{requirement.transition.edge_id}; CF does not derive '
                f'residual probabilities in 73n (plan §97, §662)'
            ),
            residual_policy=ResidualPolicyProvenance(
                branch_complement_required=None,
                residual_closure_required=requirement.residual_closure_target,
                note=requirement.note,
            ),
            deterministic_p=None,
        )

    if requirement.kind == EdgeRequirementKind.UNPARAMETERISED_COMPLEMENT:
        return ResidualGuardDecision(
            forward_to_conditioning=False,
            rejection_reason=(
                f'unparameterised branch complement required for '
                f'{requirement.transition.edge_id}; CF does not derive '
                f'sibling complements in 73n (plan §55, §97, §662)'
            ),
            residual_policy=ResidualPolicyProvenance(
                branch_complement_required=requirement.branch_complement_target,
                residual_closure_required=None,
                note=requirement.note,
            ),
            deterministic_p=None,
        )

    if requirement.kind == EdgeRequirementKind.PREPARED_SPAN_REJECTED:
        return ResidualGuardDecision(
            forward_to_conditioning=False,
            rejection_reason=(
                requirement.prepared_span_rejection_reason
                or 'prepared span primitive rejected by Stage 2 validator'
            ),
            residual_policy=ResidualPolicyProvenance(
                branch_complement_required=None,
                residual_closure_required=None,
                note=(
                    requirement.note
                    or requirement.prepared_span_rejection_reason
                ),
            ),
            deterministic_p=None,
        )

    raise ValueError(
        f'unknown EdgeRequirementKind {requirement.kind!r}'
    )


def make_structurally_deterministic_primitive(
    *,
    transition: TransitionIdentity,
    scope: PrimitiveScope,
    draw_count: int,
    deterministic_p: float,
    timing_family: TimingFamily = TimingFamily.DETERMINISTIC,
    deterministic_shift_days: int = 0,
    timing_cdf_max_tau: int = 90,
    structural_identity_compat: Optional[dict] = None,
    raw_evidence_scope_key: Optional[str] = None,
    prior_source: Optional[str] = None,
) -> ConditionedTransitionPrimitive:
    """Build a ``STRUCTURALLY_DETERMINISTIC`` primitive.

    The probability posterior is a constant draw family at
    ``deterministic_p``; SD is zero and every draw is ``deterministic_p``
    so consumers can compose with other primitives without special-
    casing this status. The timing object is a Dirac at
    ``deterministic_shift_days``: the CDF is 0.0 before the shift and
    1.0 from the shift onward.

    ``structural_identity_compat`` carries any ``mu``/``sigma``/
    ``onset``/``completeness`` compatibility fields the composer may
    need to expose to legacy migration consumers; they are provenance
    only and never evidence-conditioned timing parameters
    (plan §87, §583, mirroring Stage 3's NON_LATENT handling).

    The status is ``STRUCTURALLY_DETERMINISTIC`` not ``CONDITIONED``:
    no evidence shaped this posterior, and ``residual_policy`` is
    None because no residual was needed. ``subset_policy`` and
    ``compatibility_blend`` are also None for the same reason.
    """
    if not 0.0 <= float(deterministic_p) <= 1.0:
        raise ValueError(
            f'deterministic_p={deterministic_p!r} is out of range [0, 1] '
            f'for {transition.edge_id}'
        )
    p = float(deterministic_p)
    draws = np.full(draw_count, p, dtype=np.float32)
    probability_posterior = ProbabilityPosterior(
        mean=p,
        sd=0.0,
        draws=draws,
    )
    cdf_mean = _dirac_cdf(
        max_tau=timing_cdf_max_tau,
        shift_days=int(deterministic_shift_days),
    )
    timing_posterior = TimingPosterior(
        family=timing_family,
        cdf_mean=cdf_mean,
        cdf_draws=None,
        deterministic_shift_days=int(deterministic_shift_days),
        structural_identity_compat=dict(structural_identity_compat or {}),
    )
    return ConditionedTransitionPrimitive(
        transition=transition,
        scope=scope,
        draw_count=draw_count,
        status=ConditioningStatus.STRUCTURALLY_DETERMINISTIC,
        timing_family=timing_family,
        raw_evidence_scope_key=raw_evidence_scope_key,
        weighted_evidence=None,
        effective_evidence_totals=None,
        subset_policy=None,
        compatibility_blend=None,
        residual_policy=None,
        probability_posterior=probability_posterior,
        timing_posterior=timing_posterior,
        probability_prior=probability_posterior,
        timing_prior=timing_posterior,
        draw_family_key=None,
        prior_source=prior_source,
        skipped_evidence_summary={
            'deterministic_p': p,
            'deterministic_shift_days': int(deterministic_shift_days),
        },
        notes=(
            f'status=structurally_deterministic',
            f'deterministic_p={p}',
        ),
    )


# ─── Internal helpers ──────────────────────────────────────────────────


def _dirac_cdf(*, max_tau: int, shift_days: int) -> Tuple[float, ...]:
    """Step CDF: 0.0 for tau < shift_days, 1.0 for tau >= shift_days.

    For ``shift_days=0`` the result is the all-ones Dirac-at-zero CDF
    that Stage 3's NON_LATENT branch builds.
    """
    cdf = []
    for tau in range(max_tau + 1):
        cdf.append(1.0 if tau >= shift_days else 0.0)
    return tuple(cdf)


# Re-exports used by Stage 4 callers/tests for ergonomics.
_ = SubsetPolicyProvenance, CompatibilityBlendProvenance


__all__ = [
    'EdgeRequirement',
    'EdgeRequirementKind',
    'ResidualGuardDecision',
    'classify_edge_requirement',
    'make_structurally_deterministic_primitive',
]
