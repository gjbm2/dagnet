"""
Stage 1 contract tests for ConditionedTransitionPrimitive (73n).

Plan: docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md
§"Stage 1 — Primitive Posterior Contract".

These tests must be able to construct and serialise primitive posterior
objects for each of the four states without invoking carrier or subject
composition (plan §595). They must also verify draw-family identity and
moments-only refusal, both enforced at the primitive contract level.

The module under test is graph-editor/lib/runner/primitives.py.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from runner.primitives import (
    CompatibilityBlendProvenance,
    ConditionedTransitionPrimitive,
    ConditioningStatus,
    DrawFamilyKey,
    DrawFamilyMode,
    DrawFamilyUnavailable,
    PrimitiveScope,
    ProbabilityPosterior,
    ResidualPolicyProvenance,
    SubsetPolicyProvenance,
    TimingFamily,
    TimingPosterior,
    TransitionIdentity,
    WeightedEvidenceRow,
    WeightedPrimitiveEvidenceView,
    make_rng,
)


# ─── Fixture helpers ───────────────────────────────────────────────────


def _scope(
    *,
    scenario_id: str = "scn-1",
    evidence_role: str = "window_subject_helper",
    date_from: str = "2026-01-01",
    date_to: str = "2026-01-31",
    as_at: str | None = "2026-02-01",
    context_key: str | None = None,
    regime_key: str | None = "default",
    model_source_preference: str = "best_available",
    resolved_source_identity: str | None = "bayesian",
    selected_anchor_days: tuple[str, ...] = (),
) -> PrimitiveScope:
    return PrimitiveScope(
        scenario_id=scenario_id,
        evidence_role=evidence_role,
        date_from=date_from,
        date_to=date_to,
        as_at=as_at,
        context_key=context_key,
        regime_key=regime_key,
        model_source_preference=model_source_preference,
        resolved_source_identity=resolved_source_identity,
        selected_anchor_days=selected_anchor_days,
    )


def _identity(
    source: str = "U", destination: str = "V", edge_id: str = "U->V"
) -> TransitionIdentity:
    return TransitionIdentity(
        source_node=source, destination_node=destination, edge_id=edge_id
    )


def _key(*, draw_count: int = 32, scenario_seed: int = 17, **scope_kw) -> DrawFamilyKey:
    return DrawFamilyKey(
        transition_identity=_identity(),
        scope=_scope(**scope_kw),
        draw_count=draw_count,
        scenario_seed=scenario_seed,
    )


def _weighted_view(
    *,
    n_total: float = 12.0,
    k_total: float = 4.5,
    rows: tuple[WeightedEvidenceRow, ...] | None = None,
) -> WeightedPrimitiveEvidenceView:
    if rows is None:
        rows = (
            WeightedEvidenceRow(
                observed_date="2026-01-15",
                retrieved_at="2026-02-01T00:00:00",
                n=10,
                k=4,
                arrival_weight=0.6,
                n_weighted=6.0,
                k_weighted=2.4,
            ),
            WeightedEvidenceRow(
                observed_date="2026-01-22",
                retrieved_at="2026-02-01T00:00:00",
                n=10,
                k=3,
                arrival_weight=0.6,
                n_weighted=6.0,
                k_weighted=2.1,
            ),
        )
    return WeightedPrimitiveEvidenceView(
        n_weighted_total=n_total,
        k_weighted_total=k_total,
        rows=rows,
        arrival_weight_summary={"normalised": True, "support_days": 2},
        binding_policy="weighted_day_binding",
        evidence_scope_key="ev-scope-1",
    )


# ─── Four-state construction sketches (plan §567-572) ──────────────────


def test_conditioned_parameterised_primitive_construct_and_serialise():
    """A conditioned parameterised primitive carries raw E (via scope key),
    a weighted view, effective e, posterior probability/timing, draw-family
    identity, unconditioned twins, and conditioning health."""
    key = _key()
    rng = make_rng(key, "primitive_p_draws")
    p_draws = rng.beta(8.0, 24.0, size=key.draw_count)

    primitive = ConditionedTransitionPrimitive(
        transition=key.transition_identity,
        scope=key.scope,
        draw_count=key.draw_count,
        status=ConditioningStatus.CONDITIONED,
        timing_family=TimingFamily.LATENT,
        raw_evidence_scope_key="ev-scope-1",
        weighted_evidence=_weighted_view(),
        effective_evidence_totals=(11.4, 4.4),
        subset_policy=SubsetPolicyProvenance(
            m_S=20.0, m_G=200.0, r=0.1, skip_reason=None,
            equality_explicit=False,
        ),
        compatibility_blend=None,
        residual_policy=None,
        probability_posterior=ProbabilityPosterior(
            mean=float(np.mean(p_draws)),
            sd=float(np.std(p_draws, ddof=1)),
            draws=p_draws,
        ),
        timing_posterior=TimingPosterior(
            family=TimingFamily.LATENT,
            cdf_mean=tuple(float(x) for x in np.linspace(0.0, 1.0, 11)),
            cdf_draws=None,
        ),
        probability_prior=ProbabilityPosterior(mean=0.30, sd=0.05, draws=None),
        timing_prior=None,
        draw_family_mode=DrawFamilyMode.KEYED_PRIOR,
        draw_family_key=key,
        prior_source="bayesian",
    )

    # Construct check: raw E and weighted view distinct from effective e.
    assert primitive.raw_evidence_scope_key == "ev-scope-1"
    assert primitive.weighted_evidence is not None
    assert primitive.weighted_evidence.n_weighted_total == 12.0
    assert primitive.effective_evidence_totals == (11.4, 4.4)
    assert primitive.weighted_evidence.n_weighted_total \
        != primitive.effective_evidence_totals[0]
    assert primitive.subset_policy is not None
    assert not primitive.subset_policy.equality_explicit

    # Serialise check: round-trip through JSON.
    prov = primitive.to_provenance_dict()
    assert prov["status"] == "conditioned"
    assert prov["draw_family_mode"] == "keyed_prior"
    assert prov["has_weighted_evidence"] is True
    assert prov["effective_evidence_totals"] == [11.4, 4.4]
    assert prov["subset_policy"]["r"] == pytest.approx(0.1)
    assert prov["draw_family_key_digest"] == key.digest
    json.dumps(prov)  # JSON-serialisable.


def test_prior_only_primitive_has_empty_evidence_and_is_not_misreported():
    """Prior-only: raw E empty, effective e empty, prior/source model
    remains usable. Conditioning status NOT misreported as conditioned
    (plan §95, §570)."""
    key = _key()
    primitive = ConditionedTransitionPrimitive(
        transition=key.transition_identity,
        scope=key.scope,
        draw_count=key.draw_count,
        status=ConditioningStatus.PRIOR_ONLY,
        timing_family=TimingFamily.LATENT,
        raw_evidence_scope_key="ev-scope-empty",
        weighted_evidence=None,
        effective_evidence_totals=(0.0, 0.0),
        subset_policy=SubsetPolicyProvenance(
            m_S=0.0, m_G=None, r=None, skip_reason="no_admitted_evidence",
            equality_explicit=False,
        ),
        compatibility_blend=None,
        residual_policy=None,
        probability_posterior=ProbabilityPosterior(
            mean=0.30, sd=0.05,
            draws=make_rng(key, "primitive_p_draws").beta(3.0, 7.0, size=key.draw_count),
        ),
        timing_posterior=TimingPosterior(
            family=TimingFamily.LATENT,
            cdf_mean=tuple(float(x) for x in np.linspace(0.0, 1.0, 11)),
        ),
        probability_prior=None,
        timing_prior=None,
        draw_family_mode=DrawFamilyMode.KEYED_PRIOR,
        draw_family_key=key,
        prior_source="bayesian",
    )

    assert primitive.status == ConditioningStatus.PRIOR_ONLY
    assert primitive.weighted_evidence is None
    assert primitive.effective_evidence_totals == (0.0, 0.0)
    # Status must not be misreported as conditioned.
    prov = primitive.to_provenance_dict()
    assert prov["status"] != "conditioned"
    # The primitive may still serve coherent draws (the prior is intact).
    assert primitive.is_draw_coherent
    draws = primitive.probability_draws()
    assert len(draws) == key.draw_count


def test_unsupported_residual_primitive_names_required_branch_and_does_not_serve_draws():
    """Unsupported residual/complement: names the branch complement or
    residual closure that would be required and states CF does not
    derive it (plan §97, §571). Refuses to act as a coherent draw family."""
    key = _key(scenario_id="scn-unsupported")
    primitive = ConditionedTransitionPrimitive(
        transition=key.transition_identity,
        scope=key.scope,
        draw_count=key.draw_count,
        status=ConditioningStatus.UNSUPPORTED_RESIDUAL,
        timing_family=TimingFamily.LATENT,
        raw_evidence_scope_key=None,
        weighted_evidence=None,
        effective_evidence_totals=None,
        subset_policy=None,
        compatibility_blend=None,
        residual_policy=ResidualPolicyProvenance(
            branch_complement_required="1 - p(U->V)",
            residual_closure_required=None,
            note="parameterised siblings cover only U->V, not the complement",
        ),
        probability_posterior=None,
        timing_posterior=None,
        probability_prior=None,
        timing_prior=None,
        draw_family_mode=DrawFamilyMode.MOMENTS_ONLY,
        draw_family_key=None,
        prior_source=None,
    )

    assert primitive.status == ConditioningStatus.UNSUPPORTED_RESIDUAL
    assert not primitive.is_draw_coherent
    with pytest.raises(DrawFamilyUnavailable):
        primitive.probability_draws()
    with pytest.raises(DrawFamilyUnavailable):
        primitive.timing_draws()

    prov = primitive.to_provenance_dict()
    assert prov["residual_policy"]["branch_complement_required"] == "1 - p(U->V)"
    assert prov["draw_family_mode"] == "moments_only"


def test_unavailable_or_degraded_primitive_records_missing_inputs_and_refuses_draws():
    """Unavailable/degraded: names the missing evidence, missing source,
    unsupported residual/complement requirement, or moments-only
    uncertainty that prevents draw-coherent composition (plan §572)."""
    key = _key(scenario_id="scn-degraded", model_source_preference="bayesian")
    # Moments-only on a parameterised primitive: the conditioning succeeded
    # numerically but the posterior is summary-only (e.g. legacy moments).
    primitive = ConditionedTransitionPrimitive(
        transition=key.transition_identity,
        scope=key.scope,
        draw_count=key.draw_count,
        status=ConditioningStatus.DEGRADED,
        timing_family=TimingFamily.LATENT,
        raw_evidence_scope_key="ev-scope-1",
        weighted_evidence=_weighted_view(),
        effective_evidence_totals=(11.4, 4.4),
        subset_policy=SubsetPolicyProvenance(
            m_S=20.0, m_G=200.0, r=0.1, skip_reason=None,
            equality_explicit=False,
        ),
        compatibility_blend=None,
        residual_policy=None,
        probability_posterior=ProbabilityPosterior(
            mean=0.255, sd=0.06, draws=None,
        ),
        timing_posterior=TimingPosterior(
            family=TimingFamily.LATENT,
            cdf_mean=tuple(float(x) for x in np.linspace(0.0, 1.0, 11)),
            cdf_draws=None,
        ),
        probability_prior=None,
        timing_prior=None,
        draw_family_mode=DrawFamilyMode.MOMENTS_ONLY,
        draw_family_key=None,
        prior_source="bayesian",
        notes=("moments_only_after_is_degeneracy",),
    )

    assert not primitive.is_draw_coherent
    with pytest.raises(DrawFamilyUnavailable):
        primitive.probability_draws()
    prov = primitive.to_provenance_dict()
    assert prov["status"] == "degraded"
    assert prov["probability_posterior"]["n_draws"] == 0
    assert "moments_only_after_is_degeneracy" in prov["notes"]


# ─── Structurally non-latency primitive (plan §83-87, §583) ────────────


def test_non_latency_primitive_keeps_p_separate_from_dirac_at_zero_timing():
    """Probability may be conditioned; timing remains a structural identity
    (Dirac-at-zero, including mass at tau=0). mu/sigma/onset/completeness
    fields are provenance only, not evidence-conditioned."""
    key = _key(scenario_id="scn-non-latent")
    rng = make_rng(key, "primitive_p_draws")
    p_draws = rng.beta(5.0, 5.0, size=key.draw_count)
    # Dirac-at-zero CDF: all-mass-at-tau=0 means CDF = 1 from index 0.
    cdf_mean = tuple([1.0] * 11)
    primitive = ConditionedTransitionPrimitive(
        transition=key.transition_identity,
        scope=key.scope,
        draw_count=key.draw_count,
        status=ConditioningStatus.CONDITIONED,
        timing_family=TimingFamily.NON_LATENT,
        raw_evidence_scope_key="ev-scope-1",
        weighted_evidence=_weighted_view(),
        effective_evidence_totals=(11.4, 4.4),
        subset_policy=SubsetPolicyProvenance(
            m_S=20.0, m_G=200.0, r=0.1, skip_reason=None,
            equality_explicit=False,
        ),
        compatibility_blend=None,
        residual_policy=None,
        probability_posterior=ProbabilityPosterior(
            mean=float(np.mean(p_draws)),
            sd=float(np.std(p_draws, ddof=1)),
            draws=p_draws,
        ),
        timing_posterior=TimingPosterior(
            family=TimingFamily.NON_LATENT,
            cdf_mean=cdf_mean,
            cdf_draws=None,
            structural_identity_compat={
                "mu": None, "sigma": None, "onset": 0,
                "compat_note": "structural_identity_provenance_only",
            },
        ),
        probability_prior=None,
        timing_prior=None,
        draw_family_mode=DrawFamilyMode.KEYED_PRIOR,
        draw_family_key=key,
        prior_source="analytic",
    )

    # tau=0 carries the full Dirac mass — runtime composition must not skip it.
    assert primitive.timing_posterior.cdf_mean[0] == 1.0
    # Probability draws are coherent.
    assert primitive.is_draw_coherent
    p_out = primitive.probability_draws()
    assert len(p_out) == key.draw_count
    # Timing draws are tiled structural-identity rows.
    t_out = primitive.timing_draws()
    assert t_out.shape == (key.draw_count, 11)
    # Compatibility fields are provenance, not evidence-conditioned.
    sic = primitive.timing_posterior.structural_identity_compat
    assert sic["mu"] is None
    assert sic["sigma"] is None
    assert sic["compat_note"] == "structural_identity_provenance_only"


# ─── Raw / weighted / effective explicit-distinction (plan §234) ───────


def test_raw_weighted_and_effective_evidence_are_explicitly_separate():
    """Tests can distinguish raw E (scope key), weighted view, and effective
    e even when they are numerically equal — the e == E case must be
    explicit, not implicit (plan §234, §595)."""
    key = _key()
    primitive = ConditionedTransitionPrimitive(
        transition=key.transition_identity,
        scope=key.scope,
        draw_count=key.draw_count,
        status=ConditioningStatus.CONDITIONED,
        timing_family=TimingFamily.LATENT,
        raw_evidence_scope_key="ev-scope-1",
        weighted_evidence=_weighted_view(n_total=20.0, k_total=7.0),
        effective_evidence_totals=(20.0, 7.0),
        subset_policy=SubsetPolicyProvenance(
            m_S=20.0, m_G=20.0, r=1.0, skip_reason=None,
            equality_explicit=True,  # the policy KNOWS e == E here
        ),
        compatibility_blend=CompatibilityBlendProvenance(
            applied=False, r=None, permutation_seed_derivation=None,
            notes="equality_via_full_subset_limit",
        ),
        residual_policy=None,
        probability_posterior=ProbabilityPosterior(
            mean=0.35, sd=0.04,
            draws=make_rng(key, "primitive_p_draws").beta(7.0, 13.0, size=key.draw_count),
        ),
        timing_posterior=None,
        probability_prior=None,
        timing_prior=None,
        draw_family_mode=DrawFamilyMode.KEYED_PRIOR,
        draw_family_key=key,
        prior_source="bayesian",
    )

    # Numerically equal …
    assert primitive.weighted_evidence.n_weighted_total \
        == primitive.effective_evidence_totals[0]
    assert primitive.weighted_evidence.k_weighted_total \
        == primitive.effective_evidence_totals[1]
    # … but the primitive distinguishes them: raw scope key, the weighted
    # view, the effective totals tuple, and the subset policy that flagged
    # the equality are all separate slots.
    assert primitive.raw_evidence_scope_key == "ev-scope-1"
    assert primitive.weighted_evidence is not None
    assert primitive.effective_evidence_totals is not None
    assert primitive.subset_policy is not None
    assert primitive.subset_policy.equality_explicit is True
    assert primitive.compatibility_blend is not None
    # The compatibility blend slot is named separately from effective e.
    assert primitive.compatibility_blend.applied is False


# ─── Draw-family identity (plan §587-591) ──────────────────────────────


def test_two_consumers_with_matching_draw_family_keys_receive_identical_draws():
    """Plan §589: 'Two consumers presenting the same key must receive the
    same posterior draws under matching draw indices.'"""
    key_a = _key(scenario_id="same", draw_count=64, scenario_seed=11)
    key_b = _key(scenario_id="same", draw_count=64, scenario_seed=11)
    assert key_a == key_b  # same fields → equal frozen dataclasses
    assert key_a.canonical_string() == key_b.canonical_string()
    assert key_a.digest == key_b.digest

    rng_a = make_rng(key_a, "primitive_p_draws")
    rng_b = make_rng(key_b, "primitive_p_draws")
    draws_a = rng_a.beta(2.0, 8.0, size=key_a.draw_count)
    draws_b = rng_b.beta(2.0, 8.0, size=key_b.draw_count)
    assert np.allclose(draws_a, draws_b)


def test_make_rng_separates_derivations_under_a_single_key():
    """Different derivations under the same key must produce independent
    streams so multiple uses of the same key don't collide."""
    key = _key()
    rng_p = make_rng(key, "primitive_p_draws")
    rng_t = make_rng(key, "primitive_timing_draws")
    a = rng_p.normal(size=64)
    b = rng_t.normal(size=64)
    assert not np.allclose(a, b)


def test_make_rng_rejects_unknown_derivations():
    key = _key()
    with pytest.raises(ValueError):
        make_rng(key, "not-a-real-derivation")


def test_draw_family_key_digest_is_stable_across_calls():
    key = _key()
    assert key.digest == key.digest
    assert key.canonical_string() == key.canonical_string()


# ─── Moments-only refusal (plan §591) ──────────────────────────────────


def test_moments_only_primitive_refuses_to_serve_a_coherent_draw_family():
    """Moments-only refusal is enforced at the primitive contract level,
    not in composition."""
    key = _key(scenario_id="scn-mo")
    primitive = ConditionedTransitionPrimitive(
        transition=key.transition_identity,
        scope=key.scope,
        draw_count=key.draw_count,
        status=ConditioningStatus.CONDITIONED,
        timing_family=TimingFamily.LATENT,
        raw_evidence_scope_key="ev-scope-mo",
        weighted_evidence=_weighted_view(),
        effective_evidence_totals=(12.0, 4.5),
        subset_policy=SubsetPolicyProvenance(
            m_S=12.0, m_G=120.0, r=0.1, skip_reason=None,
            equality_explicit=False,
        ),
        compatibility_blend=None,
        residual_policy=None,
        probability_posterior=ProbabilityPosterior(
            mean=0.31, sd=0.04, draws=None,
        ),
        timing_posterior=None,
        probability_prior=None,
        timing_prior=None,
        draw_family_mode=DrawFamilyMode.MOMENTS_ONLY,
        draw_family_key=None,
        prior_source="bayesian",
    )

    assert not primitive.is_draw_coherent
    with pytest.raises(DrawFamilyUnavailable):
        primitive.probability_draws()
    with pytest.raises(DrawFamilyUnavailable):
        primitive.timing_draws()
    # Provenance still names the moments-only mode for diagnostics.
    prov = primitive.to_provenance_dict()
    assert prov["draw_family_mode"] == "moments_only"
    assert prov["probability_posterior"]["mean"] == pytest.approx(0.31)
    assert prov["probability_posterior"]["n_draws"] == 0


def test_unavailable_status_refuses_draws_even_when_mode_is_keyed_prior():
    """Status takes precedence over mode for refusal: an UNAVAILABLE
    primitive must refuse draws regardless of the mode field."""
    key = _key(scenario_id="scn-unavail")
    primitive = ConditionedTransitionPrimitive(
        transition=key.transition_identity,
        scope=key.scope,
        draw_count=key.draw_count,
        status=ConditioningStatus.UNAVAILABLE,
        timing_family=TimingFamily.LATENT,
        raw_evidence_scope_key=None,
        weighted_evidence=None,
        effective_evidence_totals=None,
        subset_policy=None,
        compatibility_blend=None,
        residual_policy=None,
        probability_posterior=None,
        timing_posterior=None,
        probability_prior=None,
        timing_prior=None,
        draw_family_mode=DrawFamilyMode.KEYED_PRIOR,  # mode says draws are keyed …
        draw_family_key=key,                          # … but status overrides.
        prior_source=None,
    )

    assert not primitive.is_draw_coherent
    with pytest.raises(DrawFamilyUnavailable):
        primitive.probability_draws()


# ─── Weighted view contract (plan §565) ────────────────────────────────


def test_weighted_view_is_a_separate_object_from_canonical_evidence_set():
    """The weighted view is SEPARATE from evidence_merge.EvidenceSet:
    no shared identity, no shared row class. EvidenceSet semantics for
    non-primitive callers are not changed by this module."""
    # Importing both is fine; assert they don't share a class hierarchy.
    from evidence_merge import EvidenceSet  # canonical, integer totals
    view = _weighted_view()
    assert not isinstance(view, EvidenceSet)
    # Field shape: floating-point totals; rows carry n_weighted/k_weighted.
    assert isinstance(view.n_weighted_total, float)
    assert isinstance(view.k_weighted_total, float)
    for row in view.rows:
        assert isinstance(row.n_weighted, float)
        assert isinstance(row.k_weighted, float)
        assert isinstance(row.n, int)  # raw integer counts preserved
        assert isinstance(row.k, int)
    # The view records a binding policy and a back-pointer to the raw scope.
    assert view.binding_policy
    assert view.evidence_scope_key


# ─── Stage 8 closure-required substrate provenance (plan §745) ─────────


def test_to_provenance_dict_carries_stage_8_closure_required_items():
    """Plan §745 — the primitive provenance dict must surface every
    closure-required substrate item so a reviewer can explain a CF
    scalar without reading logs (plan §762):
      - primitive id (transition.edge_id);
      - evidence role per primitive (scope.evidence_role);
      - raw evidence reference (raw_evidence_scope_key);
      - weighted evidence totals AND arrival_weight summary
        (weighted_evidence.{n_weighted_total, k_weighted_total,
        arrival_weight_summary, binding_policy, evidence_scope_key});
      - effective evidence totals;
      - context/regime/source identity (scope.{context_key, regime_key,
        resolved_source_identity, model_source_preference});
      - prior source;
      - conditioning status;
      - draw-family identity (mode + key digest);
      - timing family + structural identity provenance;
      - subset / compatibility-blend / residual policy diagnostics.
    """
    key = _key(scenario_id="scn-stage8")
    rng = make_rng(key, "primitive_p_draws")
    p_draws = rng.beta(8.0, 24.0, size=key.draw_count)
    primitive = ConditionedTransitionPrimitive(
        transition=key.transition_identity,
        scope=key.scope,
        draw_count=key.draw_count,
        status=ConditioningStatus.CONDITIONED,
        timing_family=TimingFamily.LATENT,
        raw_evidence_scope_key="ev-scope-stage8",
        weighted_evidence=_weighted_view(),
        effective_evidence_totals=(11.4, 4.4),
        subset_policy=SubsetPolicyProvenance(
            m_S=20.0, m_G=200.0, r=0.1, skip_reason=None,
            equality_explicit=False,
        ),
        compatibility_blend=None,
        residual_policy=None,
        probability_posterior=ProbabilityPosterior(
            mean=float(np.mean(p_draws)),
            sd=float(np.std(p_draws, ddof=1)),
            draws=p_draws,
        ),
        timing_posterior=TimingPosterior(
            family=TimingFamily.LATENT,
            cdf_mean=tuple(float(x) for x in np.linspace(0.0, 1.0, 11)),
        ),
        probability_prior=ProbabilityPosterior(mean=0.30, sd=0.05, draws=None),
        timing_prior=None,
        draw_family_mode=DrawFamilyMode.KEYED_PRIOR,
        draw_family_key=key,
        prior_source="bayesian",
    )

    prov = primitive.to_provenance_dict()
    # Must JSON-serialise — diagnostics are wired into responses.
    json.dumps(prov)
    # primitive id
    assert prov["transition"]["edge_id"]
    # evidence role per primitive
    assert prov["scope"]["evidence_role"] == "window_subject_helper"
    # raw evidence reference
    assert prov["raw_evidence_scope_key"] == "ev-scope-stage8"
    # weighted evidence totals + arrival summary + binding policy
    we = prov["weighted_evidence"]
    assert we is not None
    assert we["n_weighted_total"] == pytest.approx(12.0)
    assert we["k_weighted_total"] == pytest.approx(4.5)
    assert we["row_count"] == 2
    assert we["binding_policy"]
    assert we["evidence_scope_key"]
    assert we["arrival_weight_summary"] == {
        "normalised": True, "support_days": 2,
    }
    # effective evidence totals
    assert prov["effective_evidence_totals"] == [11.4, 4.4]
    # context/regime/source identity
    assert "regime_key" in prov["scope"]
    assert "resolved_source_identity" in prov["scope"]
    assert "model_source_preference" in prov["scope"]
    # prior source
    assert prov["prior_source"] == "bayesian"
    # conditioning status
    assert prov["status"] == "conditioned"
    # draw-family identity
    assert prov["draw_family_mode"] == "keyed_prior"
    assert prov["draw_family_key_digest"]
    assert prov["is_draw_coherent"] is True
    # timing family
    assert prov["timing_family"] == "latent"
    # subset policy + residual_policy slot present (None when not applicable)
    assert prov["subset_policy"]["r"] == pytest.approx(0.1)
    assert prov["residual_policy"] is None


def test_to_provenance_dict_unsupported_residual_carries_residual_diagnostics():
    """Plan §745 — unsupported residual / complement transition
    diagnostics must round-trip through to_provenance_dict so Stage 8
    consumers can describe why CF refuses to derive the primitive
    (plan §97, §214)."""
    key = _key(scenario_id="scn-stage8-residual")
    primitive = ConditionedTransitionPrimitive(
        transition=key.transition_identity,
        scope=key.scope,
        draw_count=key.draw_count,
        status=ConditioningStatus.UNSUPPORTED_RESIDUAL,
        timing_family=TimingFamily.LATENT,
        raw_evidence_scope_key=None,
        weighted_evidence=None,
        effective_evidence_totals=None,
        subset_policy=None,
        compatibility_blend=None,
        residual_policy=ResidualPolicyProvenance(
            branch_complement_required="1 - p(U->V)",
            residual_closure_required=None,
            note="parameterised siblings cover only U->V",
        ),
        probability_posterior=None,
        timing_posterior=None,
        probability_prior=None,
        timing_prior=None,
        draw_family_mode=DrawFamilyMode.MOMENTS_ONLY,
        draw_family_key=None,
        prior_source=None,
    )
    prov = primitive.to_provenance_dict()
    assert prov["status"] == "unsupported_residual"
    assert prov["is_draw_coherent"] is False
    assert prov["residual_policy"]["branch_complement_required"] == "1 - p(U->V)"
    assert prov["residual_policy"]["note"]
    # Weighted evidence is None for unsupported residual; substrate diag must
    # not pretend otherwise.
    assert prov["weighted_evidence"] is None
    assert prov["effective_evidence_totals"] is None
