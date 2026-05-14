"""
Conditioned transition primitive contract.

Runtime types for the primitive substrate consumed by ``window()``,
``subject_span``, and the active-cohort ``A -> X`` carrier role. This
module owns the contract: ``ConditionedTransitionPrimitive`` and its
posterior shapes, the raw / weighted / effective evidence views, the
draw-family identity (``DrawFamilyKey``), and the keyed-RNG seam
(``make_rng``). Evidence resolution lives in ``primitive_evidence``,
conditioning policy in ``primitive_conditioning``, and composition in
``subject_span_composer.compose_primitive_span``.

Contract source of truth:
docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md
§"Primitive Posterior Contract".

Critical invariants this module pins:
  - WeightedPrimitiveEvidenceView is SEPARATE from evidence_merge.EvidenceSet.
    EvidenceSet keeps integer n/k totals; the weighted view carries
    floating-point n_weighted/k_weighted. Non-primitive merge consumers must
    not see the weighted view (plan §565).
  - Raw E, weighted view, and effective e are stored separately on the
    primitive even when numerically equal. The e == E case must be made
    explicit by SubsetPolicyProvenance.equality_explicit (plan §234).
  - Draw-family identity is correctness, not performance. Two consumers
    presenting the same DrawFamilyKey under the same scope must receive
    identical draws under matching draw indices (plan §141, §585-589).
  - Every constructed primitive is draw-bearing. probability_posterior.draws
    and timing_posterior must be populated; a primitive that cannot supply
    draws is a construction bug, not a runtime mode. Refusal cases stop
    upstream at the residual guard, not inside the primitive.
  - Structurally non-latency timing is a Dirac-at-zero structural identity;
    p may be conditioned but mu/sigma/onset/completeness are provenance only
    (plan §83-87, §583).

This module deliberately imports nothing from forecast_runtime, forecast_state,
span_kernel, timing_span, or cohort_forecast_v3. It must remain
construct-and-serialise testable without invoking composition (plan §595).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping, Optional, Tuple

import numpy as np


# ─── Status / family enums ─────────────────────────────────────────────


class ConditioningStatus(str, Enum):
    CONDITIONED = "conditioned"
    PRIOR_ONLY = "prior_only"
    STRUCTURALLY_DETERMINISTIC = "structurally_deterministic"
    DEGRADED = "degraded"


class TimingFamily(str, Enum):
    LATENT = "latent"
    NON_LATENT = "non_latent"
    DETERMINISTIC = "deterministic"


# ─── Identity and scope ────────────────────────────────────────────────


@dataclass(frozen=True)
class TransitionIdentity:
    source_node: str
    destination_node: str
    edge_id: str


@dataclass(frozen=True)
class PrimitiveScope:
    """Scenario scope under which a primitive is conditioned.

    Mirrors the identity portion of evidence_merge.EvidenceScope so the two
    can be cross-keyed. evidence_role is kept as a plain string (the
    EvidenceRole enum's .value) to avoid a hard import dependency.
    """
    scenario_id: str
    evidence_role: str
    date_from: str
    date_to: str
    as_at: Optional[str]
    context_key: Optional[str]
    regime_key: Optional[str]
    model_source_preference: str
    resolved_source_identity: Optional[str]
    selected_anchor_days: Tuple[str, ...] = ()


# ─── Draw-family key + keyed RNG seam ──────────────────────────────────


# Allowed derivations for make_rng. Each entry corresponds to a primitive-draw
# call site recorded in 73n-stage-0-baseline.md §1.12. Listing them here so
# typos at call sites raise ValueError rather than silently desynchronising
# consumers from each other.
_DERIVATIONS = {
    "primitive_p_draws": "73n.derivation.primitive_p_draws.v1",
    "primitive_timing_draws": "73n.derivation.primitive_timing_draws.v1",
    "primitive_is_resampling": "73n.derivation.primitive_is_resampling.v1",
    "primitive_drift": "73n.derivation.primitive_drift.v1",
    "primitive_completeness_sd": "73n.derivation.primitive_completeness_sd.v1",
    "doc52_blend_permutation": "73n.derivation.doc52_blend_permutation.v1",
    "node_arrival_cache": "73n.derivation.node_arrival_cache.v1",
    "subject_span_full_path_mc": "73n.derivation.subject_span_full_path_mc.v1",
    "subject_span_epistemic_overlay":
        "73n.derivation.subject_span_epistemic_overlay.v1",
    "anchor_relative_edge_p_mc":
        "73n.derivation.anchor_relative_edge_p_mc.v1",
    "anchor_relative_edge_epistemic":
        "73n.derivation.anchor_relative_edge_epistemic.v1",
    "last_edge_frontier_cdf": "73n.derivation.last_edge_frontier_cdf.v1",
    "legacy_upstream_carrier_v3":
        "73n.derivation.legacy_upstream_carrier_v3.v1",
}


@dataclass(frozen=True)
class DrawFamilyKey:
    """Deterministic key controlling primitive draw coherence.

    Two consumers presenting the same DrawFamilyKey under the same scope
    MUST receive identical posterior draws under matching draw indices.
    The canonical_string serialisation is stable across runs.
    """
    transition_identity: TransitionIdentity
    scope: PrimitiveScope
    draw_count: int
    scenario_seed: int

    def canonical_string(self) -> str:
        # v2 (Atom 2): scenario_id and scenario_seed dropped — they are
        # caller-context labels, not part of the conditioned-posterior
        # identity. The result-cache key already binds priors and bound
        # evidence; identical math across scenarios should share draws.
        ti = self.transition_identity
        sc = self.scope
        return "|".join((
            "73n.draw_family_key.v2",
            f"src={ti.source_node}",
            f"dst={ti.destination_node}",
            f"edge={ti.edge_id}",
            f"role={sc.evidence_role}",
            f"date_from={sc.date_from}",
            f"date_to={sc.date_to}",
            f"as_at={sc.as_at or ''}",
            f"context={sc.context_key or ''}",
            f"regime={sc.regime_key or ''}",
            f"source_pref={sc.model_source_preference}",
            f"resolved_source={sc.resolved_source_identity or ''}",
            f"anchor_days={','.join(sc.selected_anchor_days)}",
            f"S={self.draw_count}",
        ))

    @property
    def digest(self) -> str:
        return hashlib.sha256(
            self.canonical_string().encode("utf-8")
        ).hexdigest()

    def as_seed_int(self) -> int:
        return int(self.digest[:16], 16)


def make_rng(key: DrawFamilyKey, derivation: str) -> np.random.Generator:
    """Stage 1 keyed-RNG seam.

    Replaces np.random.default_rng(seed=42|43|71) at the primitive-draw call
    sites recorded in 73n-stage-0-baseline.md §1.12. `derivation` selects an
    independent secondary stream so multiple uses of the same key don't
    collide. Unknown derivations raise ValueError.
    """
    if derivation not in _DERIVATIONS:
        raise ValueError(
            f"unknown derivation {derivation!r}; allowed values: "
            f"{sorted(_DERIVATIONS)}"
        )
    payload = key.canonical_string() + "||" + _DERIVATIONS[derivation]
    digest = hashlib.sha256(payload.encode("utf-8")).digest()
    seed_int = int.from_bytes(digest[:8], "big")
    return np.random.default_rng(seed=seed_int)


# ─── Weighted primitive evidence view ──────────────────────────────────


@dataclass(frozen=True)
class WeightedEvidenceRow:
    """A single primitive-local row after arrival_weight[U] binding.

    n / k are the integer counts admitted (equivalent to a row from
    evidence_merge.EvidenceSet.points). arrival_weight is the normalised
    arrival_weight[U][observed_date] entry. n_weighted = n * arrival_weight;
    same for k_weighted.
    """
    observed_date: str
    retrieved_at: Optional[str]
    n: int
    k: int
    arrival_weight: float
    n_weighted: float
    k_weighted: float
    root_day_shares: Mapping[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class WeightedPrimitiveEvidenceView:
    """Floating-point primitive-local clock-aligned evidence view.

    SEPARATE from evidence_merge.EvidenceSet (plan §565). EvidenceSet keeps
    integer totals for non-primitive callers; this view carries floating-
    point n_weighted/k_weighted produced by multiplying admitted rows by
    their normalised arrival_weight[U] entry. Stage 2 may not change merge
    callers until this contract is recorded.
    """
    n_weighted_total: float
    k_weighted_total: float
    rows: Tuple[WeightedEvidenceRow, ...]
    arrival_weight_summary: Mapping[str, Any]
    binding_policy: str
    evidence_scope_key: str
    evidence_scope_date_from: Optional[str] = None
    evidence_scope_date_to: Optional[str] = None
    skipped_counts_by_reason: Mapping[str, int] = field(default_factory=dict)


# ─── Subset / compatibility / residual policy provenance ───────────────


@dataclass(frozen=True)
class SubsetPolicyProvenance:
    """Doc-52 mass-ratio policy: m_S, m_G, r = min(m_S/m_G, 1).

    equality_explicit: True iff the policy explicitly established e == E
    (not just numerically equal incidentally). Composed consumers MUST
    NOT re-apply subset logic; they read this provenance for diagnostics
    only (plan §245).
    """
    m_S: float
    m_G: Optional[float]
    r: Optional[float]
    skip_reason: Optional[str]
    equality_explicit: bool


@dataclass(frozen=True)
class CompatibilityBlendProvenance:
    """Doc-52 row/draw blend that may remain during migration outside
    effective-evidence selection (plan §226, §234)."""
    applied: bool
    r: Optional[float]
    permutation_seed_derivation: Optional[str]
    notes: Optional[str] = None


@dataclass(frozen=True)
class ResidualPolicyProvenance:
    """Why the residual guard refused to forward an edge to conditioning.

    Names the structural element a parameterised primitive would have
    needed — a branch complement (``1 - p`` of a sibling) or a residual
    closure — that CF composition does not derive in 73n's first
    implementation (plan §97, §214). Carried on the
    ``ResidualGuardDecision`` rather than on a primitive: refused
    decisions do not produce a primitive at all."""
    branch_complement_required: Optional[str]
    residual_closure_required: Optional[str]
    note: Optional[str] = None


# ─── Posterior summaries ───────────────────────────────────────────────


@dataclass(frozen=True)
class ProbabilityPosterior:
    """Posterior p (or prior p when prior_only).

    A constructed primitive's probability posterior carries
    ``draws`` (``len(draws) == parent primitive draw_count``).
    ``draws`` is ``Optional`` only because intermediate prior
    summaries are also represented by this dataclass before the
    primitive is materialised.
    """
    mean: float
    sd: float
    draws: Optional[np.ndarray]


@dataclass(frozen=True)
class TimingPosterior:
    """Conditional timing object.

    For NON_LATENT primitives the cdf_mean is all-mass-at-tau=0 (Dirac).
    For DETERMINISTIC primitives, mass at deterministic_shift_days. For
    LATENT, the differenced/composed CDF mean. structural_identity_compat
    holds mu/sigma/onset/completeness fields that exist for migration
    consumers but are provenance-only (plan §87, §583).
    """
    family: TimingFamily
    cdf_mean: Tuple[float, ...]
    cdf_draws: Optional[np.ndarray] = None
    deterministic_shift_days: Optional[int] = None
    structural_identity_compat: Mapping[str, Any] = field(default_factory=dict)


# ─── Primitive itself ──────────────────────────────────────────────────


class DrawFamilyUnavailable(Exception):
    """Raised when a primitive's draw arrays are missing in a way that
    violates the construction invariant. A constructed primitive is
    draw-bearing by definition: ``probability_posterior.draws`` and
    ``timing_posterior`` must be populated. This exception signals a
    construction bug; refusal cases stop upstream at the residual
    guard, never as a primitive variant."""


@dataclass(frozen=True)
class ConditionedTransitionPrimitive:
    """The runtime object 73n's primitive registry stores. Composers in
    window(), subject_span, and carrier_to_x consume primitives via this
    contract; composition does not refetch evidence, does not regenerate
    draws, and does not re-apply subset logic (plan §245)."""
    transition: TransitionIdentity
    scope: PrimitiveScope
    draw_count: int
    status: ConditioningStatus
    timing_family: TimingFamily

    raw_evidence_scope_key: Optional[str]
    weighted_evidence: Optional[WeightedPrimitiveEvidenceView]
    effective_evidence_totals: Optional[Tuple[float, float]]
    subset_policy: Optional[SubsetPolicyProvenance]
    compatibility_blend: Optional[CompatibilityBlendProvenance]
    residual_policy: Optional[ResidualPolicyProvenance]

    probability_posterior: Optional[ProbabilityPosterior]
    timing_posterior: Optional[TimingPosterior]

    probability_prior: Optional[ProbabilityPosterior]
    timing_prior: Optional[TimingPosterior]

    draw_family_key: Optional[DrawFamilyKey]

    prior_source: Optional[str]
    skipped_evidence_summary: Mapping[str, Any] = field(default_factory=dict)
    notes: Tuple[str, ...] = ()

    def probability_draws(self) -> np.ndarray:
        if self.probability_posterior is None or \
                self.probability_posterior.draws is None:
            raise DrawFamilyUnavailable(
                f"primitive {self.transition.edge_id} has no probability "
                f"draws — construction invariant violated"
            )
        return self.probability_posterior.draws

    def timing_draws(self) -> np.ndarray:
        if self.timing_posterior is None:
            raise DrawFamilyUnavailable(
                f"primitive {self.transition.edge_id} has no timing "
                f"posterior — construction invariant violated"
            )
        if self.timing_posterior.cdf_draws is not None:
            return self.timing_posterior.cdf_draws
        # No per-draw timing variation available — tile the deterministic
        # CDF mean across S draws so consumers asking for draws receive a
        # well-formed array. Applies to structural identities (NON_LATENT,
        # DETERMINISTIC) and also to latent primitives whose conditioning
        # produced a deterministic CDF only (mu/sigma posterior not yet
        # sampled per draw).
        if self.timing_posterior.cdf_mean is not None:
            mean = np.asarray(self.timing_posterior.cdf_mean, dtype=float)
            return np.tile(mean, (self.draw_count, 1))
        raise DrawFamilyUnavailable(
            f"primitive {self.transition.edge_id} timing has no draws and "
            f"no cdf_mean to tile"
        )

    def to_provenance_dict(self) -> dict:
        """Serialise to a JSON-friendly dict for response provenance.

        The response per-primitive substrate block (plan §745) reads
        this. Every closure-required item is reachable from here:
        primitive id (via ``transition.edge_id``), evidence role
        (``scope.evidence_role``), raw + weighted + effective evidence
        totals, evidence-clock provenance (``weighted_evidence``
        ``arrival_weight_summary``), context/regime/source identity
        (``scope``), prior source, conditioning status, and
        unsupported-residual diagnostics (``residual_policy``).
        """
        ti = self.transition
        sc = self.scope
        we = self.weighted_evidence
        weighted_evidence_block: Optional[dict] = None
        if we is not None:
            weighted_evidence_block = {
                "n_weighted_total": float(we.n_weighted_total),
                "k_weighted_total": float(we.k_weighted_total),
                "row_count": int(len(we.rows)),
                "binding_policy": we.binding_policy,
                "evidence_scope_key": we.evidence_scope_key,
                "evidence_scope_date_from": we.evidence_scope_date_from,
                "evidence_scope_date_to": we.evidence_scope_date_to,
                "skipped_counts_by_reason": dict(we.skipped_counts_by_reason),
                "arrival_weight_summary": dict(we.arrival_weight_summary),
                "rows": [
                    {
                        "observed_date": r.observed_date,
                        "retrieved_at": r.retrieved_at,
                        "n": int(r.n),
                        "k": int(r.k),
                        "arrival_weight": float(r.arrival_weight),
                        "n_weighted": float(r.n_weighted),
                        "k_weighted": float(r.k_weighted),
                    }
                    for r in we.rows
                ],
            }
        return {
            "transition": {
                "source_node": ti.source_node,
                "destination_node": ti.destination_node,
                "edge_id": ti.edge_id,
            },
            "scope": {
                "scenario_id": sc.scenario_id,
                "evidence_role": sc.evidence_role,
                "date_from": sc.date_from,
                "date_to": sc.date_to,
                "as_at": sc.as_at,
                "context_key": sc.context_key,
                "regime_key": sc.regime_key,
                "model_source_preference": sc.model_source_preference,
                "resolved_source_identity": sc.resolved_source_identity,
                "selected_anchor_days": list(sc.selected_anchor_days),
            },
            "draw_count": self.draw_count,
            "status": self.status.value,
            "timing_family": self.timing_family.value,
            "raw_evidence_scope_key": self.raw_evidence_scope_key,
            "has_weighted_evidence": self.weighted_evidence is not None,
            "weighted_evidence": weighted_evidence_block,
            "effective_evidence_totals":
                list(self.effective_evidence_totals)
                if self.effective_evidence_totals is not None else None,
            "subset_policy": (
                {
                    "m_S": self.subset_policy.m_S,
                    "m_G": self.subset_policy.m_G,
                    "r": self.subset_policy.r,
                    "skip_reason": self.subset_policy.skip_reason,
                    "equality_explicit": self.subset_policy.equality_explicit,
                }
                if self.subset_policy is not None else None
            ),
            "compatibility_blend": (
                {
                    "applied": self.compatibility_blend.applied,
                    "r": self.compatibility_blend.r,
                    "permutation_seed_derivation":
                        self.compatibility_blend.permutation_seed_derivation,
                    "notes": self.compatibility_blend.notes,
                }
                if self.compatibility_blend is not None else None
            ),
            "residual_policy": (
                {
                    "branch_complement_required":
                        self.residual_policy.branch_complement_required,
                    "residual_closure_required":
                        self.residual_policy.residual_closure_required,
                    "note": self.residual_policy.note,
                }
                if self.residual_policy is not None else None
            ),
            "probability_posterior": (
                {
                    "mean": self.probability_posterior.mean,
                    "sd": self.probability_posterior.sd,
                    "n_draws": (
                        int(len(self.probability_posterior.draws))
                        if self.probability_posterior.draws is not None
                        else 0
                    ),
                }
                if self.probability_posterior is not None else None
            ),
            "timing_posterior": (
                {
                    "family": self.timing_posterior.family.value,
                    "cdf_mean_len": len(self.timing_posterior.cdf_mean),
                    "deterministic_shift_days":
                        self.timing_posterior.deterministic_shift_days,
                    "has_draws": self.timing_posterior.cdf_draws is not None,
                    "structural_identity_compat":
                        dict(self.timing_posterior.structural_identity_compat),
                }
                if self.timing_posterior is not None else None
            ),
            "has_probability_prior": self.probability_prior is not None,
            "probability_prior": (
                {
                    "mean": self.probability_prior.mean,
                    "sd": self.probability_prior.sd,
                }
                if self.probability_prior is not None else None
            ),
            "has_timing_prior": self.timing_prior is not None,
            "draw_family_key_digest": (
                self.draw_family_key.digest
                if self.draw_family_key is not None else None
            ),
            "prior_source": self.prior_source,
            "skipped_evidence_summary": dict(self.skipped_evidence_summary),
            "notes": list(self.notes),
        }
