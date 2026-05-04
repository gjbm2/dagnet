"""
Stage 3 tests for primitive conditioning (73n).

Plan: docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md
§"Stage 3 — Subset and Primitive Conditioning Policy".

These tests cover the Stage 3 conditioning module that takes a
``PrimitiveEvidenceResolution`` (Stage 2) plus a ``ResolvedModelParams``
(model_resolver) and emits a ``ConditionedTransitionPrimitive``
(Stage 1).

Test categories covered:

  - Beta-Binomial conjugate update on weighted totals (no subset)
  - doc-52 mass-ratio policy: full-subset limit, zero-subset limit, skip
  - effective evidence totals reflect (1−r) conditioned-portion pressure
  - SubsetPolicyProvenance.equality_explicit (e == E) flag semantics
  - PRIOR_ONLY status when raw E is empty
  - DEGRADED status when Stage 2 produces no weighted view
  - structurally non-latency primitive: probability conditioned, timing
    Dirac-at-zero, mu/sigma/onset/completeness as compatibility provenance
  - SubsetPolicyProvenance and CompatibilityBlendProvenance separately
    populated when blend applies
  - keyed-RNG seam: same DrawFamilyKey → identical draws; distinct keys
    → independent streams; no fixed-seed call site in module source
  - Composed consumers must not re-apply subset / blend (smoke test
    that subset_policy and compatibility_blend are exposed for
    diagnostics only)
  - Provenance dict serialises subset_policy and compatibility_blend on
    separate slots
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import numpy as np
import pytest

from evidence_merge import (
    EvidenceCandidate,
    EvidenceIdentity,
    EvidenceRole,
    EvidenceScope,
    ObservationCoordinate,
    SliceFamily,
    SourceKind,
    TemporalBasis,
)
from runner.carrier_composition import TransitionPrimitive
from runner.model_resolver import ResolvedLatency, ResolvedModelParams
from runner.prefix_arrival import PrefixArrivalIdentity, build_prefix_arrival_map
from runner.primitive_conditioning import (
    ConditioningPolicyOptions,
    condition_primitive,
)
from runner.primitive_evidence import (
    PrimitiveEvidenceResolution,
    bind_primitive_evidence,
    make_primitive_scope_from_evidence_scope,
)
from runner.primitives import (
    CompatibilityBlendProvenance,
    ConditioningStatus,
    DrawFamilyMode,
    DrawFamilyUnavailable,
    SubsetPolicyProvenance,
    TimingFamily,
    TransitionIdentity,
)


# ─── Fixture helpers ───────────────────────────────────────────────────


def _make_graph(edges):
    nodes_by_uuid = {}
    edge_list = []
    for uuid, from_u, to_u, from_id, to_id in edges:
        nodes_by_uuid[from_u] = {'uuid': from_u, 'id': from_id}
        nodes_by_uuid[to_u] = {'uuid': to_u, 'id': to_id}
        edge_list.append({'uuid': uuid, 'from': from_u, 'to': to_u})
    return {'nodes': list(nodes_by_uuid.values()), 'edges': edge_list}


def _prim(p=0.7, *, mu=0.0, sigma=0.0, onset=0.0) -> TransitionPrimitive:
    return TransitionPrimitive(
        p=p, mu=mu, sigma=sigma, onset=onset,
        p_sd=0.0, mu_sd=0.0, sigma_sd=0.0, onset_sd=0.0,
        source='test_synthetic',
    )


def _identity(
    *,
    scenario_id='scn-1',
    request_root='U',
    context_key=None,
    regime_key='default',
    as_at='2026-04-01',
    model_source_preference='best_available',
    parameter_fingerprint='fp-1',
) -> PrefixArrivalIdentity:
    return PrefixArrivalIdentity(
        scenario_id=scenario_id,
        request_root=request_root,
        context_key=context_key,
        regime_key=regime_key,
        as_at=as_at,
        model_source_preference=model_source_preference,
        parameter_fingerprint=parameter_fingerprint,
    )


def _evidence_scope(
    *,
    subject_from='U',
    subject_to='V',
    date_from='2026-03-01',
    date_to='2026-03-31',
    as_at='2026-04-01',
    role=EvidenceRole.WINDOW_SUBJECT_HELPER,
    scenario_id='scn-1',
) -> EvidenceScope:
    return EvidenceScope(
        role=role,
        subject_from=subject_from,
        subject_to=subject_to,
        date_from=date_from,
        date_to=date_to,
        as_at=as_at,
        scenario_id=scenario_id,
        anchor=None,
        context_key=None,
        regime_key=None,
    )


def _candidate(
    *,
    observed_date,
    n,
    k,
    subject_from='U',
    subject_to='V',
    retrieved_at='2026-04-01',
) -> EvidenceCandidate:
    return EvidenceCandidate(
        source=SourceKind.SNAPSHOT,
        identity=EvidenceIdentity(
            role=EvidenceRole.WINDOW_SUBJECT_HELPER,
            subject_from=subject_from,
            subject_to=subject_to,
            anchor=None,
            slice_family=SliceFamily.WINDOW,
            context_key=None,
            regime_key=None,
            population_identity=None,
        ),
        coordinate=ObservationCoordinate(
            observed_date=observed_date,
            retrieved_at=retrieved_at,
            temporal_basis=TemporalBasis.WINDOW_DAY,
            asat_materialised=False,
        ),
        n=n,
        k=k,
        provenance={},
    )


def _build_resolution(
    *,
    candidates,
    root='U',
    root_day_weights=None,
    transitions=None,
    edge_id='e-u-v',
    src='U', dst='V',
) -> PrimitiveEvidenceResolution:
    """Build a Stage 2 PrimitiveEvidenceResolution for U→V with single-day
    arrival weights so n_weighted_total == sum of raw n."""
    if root_day_weights is None:
        root_day_weights = {'2026-03-15': 1.0}
    if transitions is None:
        transitions = {(src, dst): _prim(p=0.7)}
    graph = _make_graph([(edge_id, f'u-{src.lower()}', f'u-{dst.lower()}',
                          src, dst)])
    arrival_map = build_prefix_arrival_map(
        graph=graph,
        root_node_id=root,
        root_day_weights=root_day_weights,
        transitions=transitions,
        identity=_identity(request_root=root),
        max_tau=60,
    )
    transition = TransitionIdentity(src, dst, edge_id)
    ev_scope = _evidence_scope(subject_from=src, subject_to=dst)
    primitive_scope = make_primitive_scope_from_evidence_scope(
        evidence_scope=ev_scope,
        model_source_preference='best_available',
        resolved_source_identity='bayesian',
    )
    return bind_primitive_evidence(
        transition=transition,
        primitive_scope=primitive_scope,
        evidence_scope=ev_scope,
        candidates=candidates,
        arrival_weights=arrival_map.get(src),
    )


def _resolved_model(
    *,
    alpha=1.0,
    beta=1.0,
    n_effective=None,
    mu=0.0,
    sigma=0.0,
    onset=0.0,
) -> ResolvedModelParams:
    """Minimal ResolvedModelParams stub for the conditioning tests."""
    edge_lat = ResolvedLatency(
        mu=mu, sigma=sigma, onset_delta_days=onset,
        t95=0.0, mu_sd=0.0, sigma_sd=0.0, onset_sd=0.0, onset_mu_corr=0.0,
    )
    return ResolvedModelParams(
        p_mean=alpha / max(alpha + beta, 1e-12),
        p_sd=0.0,
        alpha=alpha,
        beta=beta,
        alpha_pred=alpha,
        beta_pred=beta,
        n_effective=n_effective,
        edge_latency=edge_lat,
        path_latency=None,
        source='analytic',
    )


# ─── Beta-Binomial conjugate update without subset correction ──────────


def test_conjugate_update_when_n_effective_missing_skips_blend():
    """plan §239: when ``m_G`` (n_effective) is unavailable, doc-52
    skip_reason='n_effective_missing' is recorded, no blend is applied,
    and the posterior is the straight Beta(α + k, β + n − k) conjugate
    update.

    Rate prior = Beta(1, 1) with k=30, n=100 ⇒ posterior Beta(31, 71)
    with mean 31/102 ≈ 0.3039.
    """
    res = _build_resolution(
        candidates=[_candidate(observed_date='2026-03-15', n=100, k=30)],
    )
    rm = _resolved_model(alpha=1.0, beta=1.0, n_effective=None)
    prim = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=12345,
    )
    assert prim.status == ConditioningStatus.CONDITIONED
    assert prim.subset_policy is not None
    assert prim.subset_policy.skip_reason == 'n_effective_missing'
    assert prim.subset_policy.r is None
    assert prim.subset_policy.equality_explicit is True
    assert prim.compatibility_blend is not None
    assert prim.compatibility_blend.applied is False
    # Posterior mean from 2000 draws should be very close to 31/102.
    expected_mean = 31.0 / 102.0
    assert prim.probability_posterior is not None
    assert prim.probability_posterior.mean == pytest.approx(
        expected_mean, abs=0.01,
    )


# ─── doc-52 full-subset limit returns model-var ────────────────────────


def test_full_subset_limit_returns_prior_when_n_effective_equals_m_S():
    """plan §224, §240-244: when ``m_S/m_G → 1``, the conditioned
    primitive must be numerically equal to the model-var primitive.

    Construct n_w = 100, n_effective = 100 ⇒ r = 1.0 ⇒ n_cond = 0
    ⇒ all draws come from the prior Beta(50, 50) ⇒ mean ≈ 0.5.
    """
    res = _build_resolution(
        candidates=[_candidate(observed_date='2026-03-15', n=100, k=80)],
    )
    rm = _resolved_model(alpha=50.0, beta=50.0, n_effective=100.0)
    prim = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=12345,
    )
    assert prim.status == ConditioningStatus.CONDITIONED
    assert prim.subset_policy is not None
    assert prim.subset_policy.r == pytest.approx(1.0)
    assert prim.compatibility_blend is not None
    assert prim.compatibility_blend.applied is True
    # Posterior mean must track the prior mean (50/100 = 0.5), not the
    # raw conditioned-update mean (130/200 = 0.65). Stage 0c band 5a
    # acceptance abs ±0.002 is too tight for a 2000-draw MC; we use
    # ±0.02 here so this is a clean limit-of-policy assertion.
    expected_prior_mean = 0.5
    assert prim.probability_posterior is not None
    assert prim.probability_posterior.mean == pytest.approx(
        expected_prior_mean, abs=0.02,
    )
    # And the effective evidence pressure recorded is zero —
    # (1 - r) * (n_w, k_w) = 0.
    assert prim.effective_evidence_totals == (
        pytest.approx(0.0), pytest.approx(0.0),
    )


def test_doc52_subset_mass_uses_raw_admitted_rows_not_arrival_weighted_total():
    """Doc-52 compares raw selected mass against raw training mass.

    Arrival weights still control the conditioning likelihood. They must
    not shrink the doc-52 overlap numerator.
    """
    res = _build_resolution(
        root_day_weights={
            '2026-03-15': 1.0,
            '2026-03-16': 1.0,
        },
        candidates=[
            _candidate(observed_date='2026-03-15', n=100, k=80),
            _candidate(observed_date='2026-03-16', n=100, k=80),
        ],
    )
    assert res.weighted_view.n_weighted_total == pytest.approx(100.0)

    rm = _resolved_model(alpha=50.0, beta=50.0, n_effective=200.0)
    prim = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=12345,
    )

    assert prim.subset_policy is not None
    assert prim.subset_policy.m_S == pytest.approx(200.0)
    assert prim.subset_policy.r == pytest.approx(1.0)
    assert prim.compatibility_blend is not None
    assert prim.compatibility_blend.applied is True
    assert prim.probability_posterior is not None
    assert prim.probability_posterior.mean == pytest.approx(0.5, abs=0.02)


def test_zero_subset_limit_returns_full_conditioning_when_m_S_negligible():
    """plan §240: as ``m_S/m_G → 0``, the scoped evidence may apply full
    conditioning pressure. n_w = 100, n_effective = 1e6 ⇒ r ≈ 0 ⇒
    n_cond ≈ S ⇒ all draws are from the conjugate posterior."""
    res = _build_resolution(
        candidates=[_candidate(observed_date='2026-03-15', n=100, k=30)],
    )
    rm = _resolved_model(alpha=1.0, beta=1.0, n_effective=1e6)
    prim = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=12345,
    )
    assert prim.status == ConditioningStatus.CONDITIONED
    assert prim.subset_policy is not None
    assert prim.subset_policy.r is not None
    assert prim.subset_policy.r < 1e-3
    expected_post_mean = 31.0 / 102.0
    assert prim.probability_posterior is not None
    assert prim.probability_posterior.mean == pytest.approx(
        expected_post_mean, abs=0.02,
    )
    # Effective evidence ≈ raw weighted evidence (factor ≈ 1 - r ≈ 1).
    n_eff, k_eff = prim.effective_evidence_totals
    assert n_eff == pytest.approx(100.0, rel=0.01)
    assert k_eff == pytest.approx(30.0, rel=0.01)


# ─── e == E equality_explicit semantics ────────────────────────────────


def test_e_equals_E_explicit_when_n_effective_missing():
    """plan §234: ``equality_explicit=True`` flags the e == E case where
    no transformation is applied between raw and effective evidence
    (subset skipped because m_G is unknown)."""
    res = _build_resolution(
        candidates=[_candidate(observed_date='2026-03-15', n=20, k=8)],
    )
    rm = _resolved_model(alpha=1.0, beta=1.0, n_effective=None)
    prim = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=42,
    )
    assert prim.subset_policy is not None
    assert prim.subset_policy.equality_explicit is True
    n_eff, k_eff = prim.effective_evidence_totals
    assert n_eff == pytest.approx(20.0)
    assert k_eff == pytest.approx(8.0)


def test_equality_not_explicit_when_blend_applies():
    """When the doc-52 blend applies, e ≠ E by construction (effective
    evidence is reduced by (1−r)). ``equality_explicit`` MUST be False
    to prevent composers from mistaking blended for raw."""
    res = _build_resolution(
        candidates=[_candidate(observed_date='2026-03-15', n=100, k=30)],
    )
    rm = _resolved_model(alpha=1.0, beta=1.0, n_effective=400.0)
    prim = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=42,
    )
    assert prim.subset_policy is not None
    assert prim.subset_policy.r is not None
    assert prim.subset_policy.r < 1.0
    assert prim.subset_policy.equality_explicit is False


# ─── PRIOR_ONLY when E is empty ────────────────────────────────────────


def test_prior_only_when_no_evidence_admitted():
    """plan §242, §572: if a primitive has no admitted evidence, subset
    logic returns empty effective evidence and the primitive remains
    prior-only with ``status=PRIOR_ONLY``."""
    res = _build_resolution(
        candidates=[],  # No rows admitted by the merge.
    )
    rm = _resolved_model(alpha=2.0, beta=3.0, n_effective=50.0)
    prim = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=42,
    )
    assert prim.status == ConditioningStatus.PRIOR_ONLY
    assert prim.subset_policy is not None
    assert prim.subset_policy.skip_reason == 'no_evidence'
    assert prim.subset_policy.equality_explicit is True
    assert prim.effective_evidence_totals == (0.0, 0.0)
    assert prim.probability_posterior is not None
    expected_prior_mean = 2.0 / 5.0
    assert prim.probability_posterior.mean == pytest.approx(expected_prior_mean)


# ─── DEGRADED when Stage 2 produces no weighted view ───────────────────


def test_degraded_when_arrival_map_degraded():
    """When Stage 2's PrimitiveEvidenceResolution carries no weighted
    view (degraded arrival_weight[U]), the primitive is DEGRADED and
    refuses coherent draws.

    A no-path graph (root != source node id) makes the prefix-arrival
    map produce a degraded entry for the primitive's source.
    """
    # Build a graph where U has no path from root R, then ask the
    # arrival map for U — it returns a degraded entry.
    graph = _make_graph([
        ('e-r-x', 'u-r', 'u-x', 'R', 'X'),
        ('e-u-v', 'u-u', 'u-v', 'U', 'V'),
    ])
    transitions = {('R', 'X'): _prim(p=0.7), ('U', 'V'): _prim(p=0.7)}
    arrival_map = build_prefix_arrival_map(
        graph=graph,
        root_node_id='R',
        root_day_weights={'2026-03-15': 1.0},
        transitions=transitions,
        identity=_identity(request_root='R'),
        max_tau=60,
    )
    u_entry = arrival_map.get('U')
    assert u_entry is not None
    assert u_entry.is_degraded
    # Build a resolution with this degraded entry.
    transition = TransitionIdentity('U', 'V', 'e-u-v')
    ev_scope = _evidence_scope()
    primitive_scope = make_primitive_scope_from_evidence_scope(
        evidence_scope=ev_scope,
        model_source_preference='best_available',
        resolved_source_identity='bayesian',
    )
    res = bind_primitive_evidence(
        transition=transition,
        primitive_scope=primitive_scope,
        evidence_scope=ev_scope,
        candidates=[_candidate(observed_date='2026-03-15', n=100, k=30)],
        arrival_weights=u_entry,
    )
    # Degraded arrival weights produce a uniformly shaped weighted
    # view with zero rows (every raw point is rejected as off-clock);
    # the conditioner detects the topology_case='degraded' tag and
    # returns a DEGRADED primitive.
    assert res.weighted_view is not None
    assert res.weighted_view.n_weighted_total == 0.0
    assert res.weighted_view.rows == ()
    assert res.weighted_view.arrival_weight_summary['topology_case'] == 'degraded'
    rm = _resolved_model(alpha=1.0, beta=1.0)
    prim = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=42,
    )
    assert prim.status == ConditioningStatus.DEGRADED
    assert prim.is_draw_coherent is False
    with pytest.raises(DrawFamilyUnavailable):
        prim.probability_draws()


# ─── Structurally non-latency: probability conditioned, timing Dirac ───


def test_non_latency_probability_conditioned_with_dirac_timing():
    """plan §83-87, §583: a structurally non-latency primitive's
    probability ``p`` may be conditioned, but its ``TimingPosterior``
    carries ``family=NON_LATENT`` with cdf_mean Dirac-at-zero. The
    timing identity is fixed before and after probability conditioning.
    """
    res = _build_resolution(
        candidates=[_candidate(observed_date='2026-03-15', n=50, k=20)],
    )
    rm = _resolved_model(
        alpha=1.0, beta=1.0, n_effective=None,
        mu=0.0, sigma=0.0, onset=0.0,  # sigma == 0 ⇒ NON_LATENT.
    )
    prim = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=42,
    )
    assert prim.timing_family == TimingFamily.NON_LATENT
    assert prim.timing_posterior is not None
    # Dirac at zero: every τ saturates.
    assert prim.timing_posterior.cdf_mean[0] == 1.0
    assert prim.timing_posterior.cdf_mean[1] == 1.0
    assert prim.timing_posterior.cdf_mean[-1] == 1.0
    # Probability is still conditioned.
    assert prim.probability_posterior is not None
    expected_post_mean = (1.0 + 20.0) / (1.0 + 1.0 + 50.0)
    assert prim.probability_posterior.mean == pytest.approx(
        expected_post_mean, abs=0.02,
    )


def test_non_latency_compat_fields_are_provenance_only():
    """plan §87, §583: ``mu`` / ``sigma`` / ``onset`` /
    ``completeness`` compatibility fields are emitted with provenance
    saying they are structural identity fields, not evidence-conditioned
    timing parameters. Even when the resolved latency carries non-zero
    mu/onset values (e.g. inherited from a sibling slice), a
    structurally non-latency primitive's CDF must be Dirac-at-zero —
    the compat block carries the values for back-compat readers but
    the cdf_mean does not."""
    res = _build_resolution(
        candidates=[_candidate(observed_date='2026-03-15', n=50, k=20)],
    )
    # sigma = 0 forces NON_LATENT regardless of mu/onset.
    rm = _resolved_model(
        alpha=1.0, beta=1.0, n_effective=None,
        mu=2.5, sigma=0.0, onset=10.0,
    )
    prim = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=42,
    )
    assert prim.timing_family == TimingFamily.NON_LATENT
    assert prim.timing_posterior is not None
    compat = prim.timing_posterior.structural_identity_compat
    assert compat['mu'] == pytest.approx(2.5)
    assert compat['sigma'] == pytest.approx(0.0)
    assert compat['onset_delta_days'] == pytest.approx(10.0)
    # cdf_mean is still Dirac-at-zero, not influenced by mu/onset.
    assert prim.timing_posterior.cdf_mean[0] == 1.0


def test_latent_primitive_emits_lognormal_cdf_mean():
    """plan §583: latent primitives carry the differenced CDF mean.
    For sigma > 0, the cdf_mean must rise from 0 to ~1 across the
    horizon (not Dirac-at-zero)."""
    res = _build_resolution(
        candidates=[_candidate(observed_date='2026-03-15', n=50, k=20)],
    )
    rm = _resolved_model(
        alpha=1.0, beta=1.0, n_effective=None,
        mu=2.0, sigma=0.5, onset=0.0,  # sigma > 0 ⇒ LATENT.
    )
    prim = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=42,
        options=ConditioningPolicyOptions(draw_count=200, timing_cdf_max_tau=90),
    )
    assert prim.timing_family == TimingFamily.LATENT
    assert prim.timing_posterior is not None
    cdf = prim.timing_posterior.cdf_mean
    assert cdf[0] == pytest.approx(0.0)  # No mass at tau=0 for sigma>0.
    assert cdf[-1] > 0.99  # Saturates by tau=90 for mu=2, sigma=0.5.


# ─── Subset and compatibility blend named separately ───────────────────


def test_subset_policy_and_compatibility_blend_are_separate_slots():
    """plan §220, §234: effective-evidence policy (subset/mass-ratio)
    and compatibility blending (doc-52 row mix) must be named
    separately so diagnostics can distinguish them. Reading just one
    slot must not require the other."""
    res = _build_resolution(
        candidates=[_candidate(observed_date='2026-03-15', n=100, k=30)],
    )
    rm = _resolved_model(alpha=1.0, beta=1.0, n_effective=200.0)
    prim = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=42,
    )
    # Both slots populated, on separate fields, neither aliasing the other.
    assert isinstance(prim.subset_policy, SubsetPolicyProvenance)
    assert isinstance(prim.compatibility_blend, CompatibilityBlendProvenance)
    assert prim.subset_policy.r == pytest.approx(0.5)
    assert prim.compatibility_blend.r == pytest.approx(0.5)
    assert prim.compatibility_blend.applied is True
    assert prim.compatibility_blend.permutation_seed_derivation == \
        'doc52_blend_permutation'


# ─── Composed consumers must not re-apply subset / blend ───────────────


def test_subset_and_blend_diagnostics_exposed_via_provenance_dict():
    """plan §245: composed consumers read subset_policy / compatibility_
    blend for diagnostics only — never to re-apply the policy. The
    provenance dict serialises both slots with the values composers
    would read.
    """
    res = _build_resolution(
        candidates=[_candidate(observed_date='2026-03-15', n=100, k=30)],
    )
    rm = _resolved_model(alpha=1.0, beta=1.0, n_effective=200.0)
    prim = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=42,
    )
    pd = prim.to_provenance_dict()
    assert pd['subset_policy'] is not None
    assert pd['subset_policy']['r'] == pytest.approx(0.5)
    assert pd['subset_policy']['skip_reason'] is None
    assert pd['compatibility_blend'] is not None
    assert pd['compatibility_blend']['applied'] is True
    assert pd['compatibility_blend']['permutation_seed_derivation'] == \
        'doc52_blend_permutation'


# ─── Keyed-RNG seam ────────────────────────────────────────────────────


def test_two_consumers_with_matching_draw_family_keys_get_identical_draws():
    """plan §141, §585-589: two consumers presenting the same
    DrawFamilyKey under the same scope MUST receive identical
    posterior draws under matching draw indices. The conditioning
    module's internal state can not be a source of nondeterminism."""
    res_a = _build_resolution(
        candidates=[_candidate(observed_date='2026-03-15', n=80, k=24)],
    )
    res_b = _build_resolution(
        candidates=[_candidate(observed_date='2026-03-15', n=80, k=24)],
    )
    rm = _resolved_model(alpha=1.0, beta=1.0, n_effective=None)
    prim_a = condition_primitive(
        resolution=res_a, resolved_model=rm, scenario_seed=99,
    )
    prim_b = condition_primitive(
        resolution=res_b, resolved_model=rm, scenario_seed=99,
    )
    np.testing.assert_array_equal(
        prim_a.probability_draws(),
        prim_b.probability_draws(),
    )


def test_distinct_scenario_seeds_give_independent_draws():
    """Different scenario_seed values change the DrawFamilyKey and
    therefore the keyed RNG stream; the resulting draw arrays must
    differ at most indices."""
    res = _build_resolution(
        candidates=[_candidate(observed_date='2026-03-15', n=80, k=24)],
    )
    rm = _resolved_model(alpha=1.0, beta=1.0, n_effective=None)
    prim_a = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=99,
    )
    prim_b = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=100,
    )
    draws_a = prim_a.probability_draws()
    draws_b = prim_b.probability_draws()
    # Sanity: very few indices coincide by chance with 2000 continuous draws.
    coincidences = int(np.sum(draws_a == draws_b))
    assert coincidences < 5


def test_doc52_blend_uses_keyed_rng_not_fixed_seed():
    """plan §"Stage 1" final paragraph: no primitive's draw construction
    may read a fixed-seed call site. Static inspection of the
    primitive_conditioning module source must not contain a
    ``np.random.default_rng(seed=<int>)`` literal."""
    src_path = Path(__file__).resolve().parent.parent / 'runner' / \
        'primitive_conditioning.py'
    src = src_path.read_text(encoding='utf-8')
    fixed = re.search(
        r'np\.random\.default_rng\(\s*seed\s*=\s*\d+',
        src,
    )
    bare = re.search(r'np\.random\.default_rng\(\s*\d+\s*\)', src)
    assert fixed is None and bare is None, (
        'primitive_conditioning.py contains a fixed-seed RNG call; '
        'all RNG construction must go through make_rng(key, derivation) '
        'from runner.primitives.'
    )


# ─── Health diagnostic exposed (ESS-equivalent) ────────────────────────


def test_n_eff_posterior_health_diagnostic_recorded_in_notes():
    """plan §648: ESS or equivalent health diagnostic must be exposed.
    For a Beta-Binomial conjugate posterior there is no IS resampling
    surface; the equivalent is the posterior mass ``α + β``. The
    primitive's ``notes`` carries a 'n_eff_posterior=...' line so
    consumers can read the diagnostic without rebuilding it."""
    res = _build_resolution(
        candidates=[_candidate(observed_date='2026-03-15', n=100, k=30)],
    )
    rm = _resolved_model(alpha=1.0, beta=1.0, n_effective=None)
    prim = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=42,
    )
    n_eff_lines = [n for n in prim.notes if n.startswith('n_eff_posterior=')]
    assert len(n_eff_lines) == 1
    # n_eff_posterior = α_post + β_post = (1+30) + (1+70) = 102.
    assert '102.0' in n_eff_lines[0]


# ─── Stop-condition smoke test: window output via primitive ────────────


def test_window_output_can_be_read_from_conditioned_primitive():
    """plan §"Stage 3" stop condition (line 652): simple ``window(U-V)``
    output can be produced by reading the conditioned primitive rather
    than by a separate conditioning path.

    Smoke test: a window-mode primitive (root == source U, single anchor
    day) with weighted (n=50, k=20), prior Beta(2, 3), n_effective=None
    produces a ProbabilityPosterior whose mean equals the conjugate
    update. This is the parity oracle precondition for Stage 5a's
    cutover.
    """
    res = _build_resolution(
        candidates=[_candidate(observed_date='2026-03-15', n=50, k=20)],
    )
    rm = _resolved_model(alpha=2.0, beta=3.0, n_effective=None)
    prim = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=12345,
    )
    expected = (2.0 + 20.0) / (2.0 + 3.0 + 50.0)
    assert prim.probability_posterior is not None
    assert prim.probability_posterior.mean == pytest.approx(
        expected, abs=0.015,  # 2000 MC draws ⇒ ~0.01 noise.
    )
    # The diagnostic surface mirrors what window() consumers in Stage 5a
    # will read.
    pd = prim.to_provenance_dict()
    assert pd['status'] == 'conditioned'
    assert pd['probability_posterior']['mean'] == pytest.approx(
        expected, abs=0.015,
    )
    assert pd['probability_posterior']['n_draws'] == 2000


# ─── Draw-family mode: KEYED_PRIOR for conditioned primitives ──────────


def test_conditioned_primitive_uses_keyed_prior_draw_family_mode():
    """plan §590(a): a primitive must construct its draw family in
    exactly one of three modes; for closed-form Beta-Binomial conjugate
    + doc-52 mix, KEYED_PRIOR is the correct mode (draws sampled at
    indices s from the canonical scenario RNG stream derived from the
    draw-family key)."""
    res = _build_resolution(
        candidates=[_candidate(observed_date='2026-03-15', n=100, k=30)],
    )
    rm = _resolved_model(alpha=1.0, beta=1.0, n_effective=None)
    prim = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=42,
    )
    assert prim.draw_family_mode == DrawFamilyMode.KEYED_PRIOR
    assert prim.is_draw_coherent is True
