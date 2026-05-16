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

Mended from `_attic/test_primitive_conditioning.py` per
docs/current/project-bayes/73-attic-mending-process.md. Migration:
`runner.carrier_composition.TransitionPrimitive` →
`runner.timing_span.TimingTransitionPrimitive` (identical fields).
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
    SubsetPolicyProvenance,
    TimingFamily,
    TransitionIdentity,
)
from runner.timing_span import TimingTransitionPrimitive
from runner.timing_particles import EdgeTimingParticles, build_per_draw_edge_cdf


# ─── Fixture helpers ───────────────────────────────────────────────────


def _make_graph(edges):
    nodes_by_uuid = {}
    edge_list = []
    for uuid, from_u, to_u, from_id, to_id in edges:
        nodes_by_uuid[from_u] = {'uuid': from_u, 'id': from_id}
        nodes_by_uuid[to_u] = {'uuid': to_u, 'id': to_id}
        edge_list.append({'uuid': uuid, 'from': from_u, 'to': to_u})
    return {'nodes': list(nodes_by_uuid.values()), 'edges': edge_list}


def _prim(p=0.7, *, mu=0.0, sigma=0.0, onset=0.0) -> TimingTransitionPrimitive:
    return TimingTransitionPrimitive(
        p=p, mu=mu, sigma=sigma, onset=onset,
        p_sd=0.0, mu_sd=0.0, sigma_sd=0.0, onset_sd=0.0,
        source='test_synthetic',
    )


def test_timing_particles_use_row_aligned_cdf_with_same_day_mass():
    """Phase 6 Appendix A: continuous timing kernels use row buckets.

    Endpoint sampling would give G(0)=0 for a lognormal with onset 0,
    producing no age-0 mass. Row-aligned B(0)=∫_0^1 G(v)dv is positive
    and matches the empirical same-day row convention.
    """
    particles = EdgeTimingParticles(
        mu_draws=np.asarray([np.log(1.0)], dtype=np.float64),
        sigma_draws=np.asarray([0.5], dtype=np.float64),
        onset_draws=np.asarray([0.0], dtype=np.float64),
        draw_count=1,
    )

    cdf = build_per_draw_edge_cdf(particles, horizon_len=4)

    assert cdf.shape == (1, 4)
    assert cdf[0, 0] > 0.0
    assert cdf[0, 1] > cdf[0, 0]
    assert cdf[0, 3] < 1.0


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
    draw_count=2000,
) -> PrimitiveEvidenceResolution:
    """Build a Stage 2 PrimitiveEvidenceResolution for U→V with single-day
    arrival weights so n_weighted_total == sum of raw n. ``draw_count``
    must match the conditioning options' draw_count downstream (per
    Phase 6 §3.2 request-scoped draw-count invariant); tests overriding
    ``ConditioningPolicyOptions.draw_count`` pass the same value here."""
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
        draw_count=int(draw_count),
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

    Mend note (4-May-26): build_prefix_arrival_map's root entry is held
    AS-IS (not normalised) post-73n, so weights {1.0, 1.0} produce
    n_weighted_total = 200, not 100. Using {0.5, 0.5} keeps the
    raw-vs-weighted separation visible — n_weighted = 100, m_S = 200.
    """
    res = _build_resolution(
        root_day_weights={
            '2026-03-15': 0.5,
            '2026-03-16': 0.5,
        },
        candidates=[
            _candidate(observed_date='2026-03-15', n=100, k=80),
            _candidate(observed_date='2026-03-16', n=100, k=80),
        ],
    )
    # Weighted total reflects 0.5 * 100 + 0.5 * 100 = 100.
    assert res.weighted_view.n_weighted_total == pytest.approx(100.0)

    rm = _resolved_model(alpha=50.0, beta=50.0, n_effective=200.0)
    prim = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=12345,
    )

    # m_S is raw admitted (200), NOT arrival-weighted (100). r = m_S / n_eff = 1.0.
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
    view (degraded arrival_weight[U]), the primitive carries
    ``status=DEGRADED`` as provenance and its draws are sampled from
    the prior (the algebra treats it as any other primitive).

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
    # Post-refactor: DEGRADED is provenance only; the primitive is
    # draw-bearing, sampled from the prior via the keyed-RNG seam.
    draws = prim.probability_draws()
    assert draws is not None
    assert draws.shape == (prim.draw_count,)


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
    """plan §583 + Phase 6 Appendix A: latent primitives carry the
    row-aligned cumulative timing surface. For sigma > 0, cdf_mean
    carries positive same-day bucket mass at τ=0 and saturates across
    the horizon (not Dirac-at-zero)."""
    res = _build_resolution(
        candidates=[_candidate(observed_date='2026-03-15', n=50, k=20)],
        draw_count=200,
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
    assert cdf[0] > 0.0  # Same-day row-bucket mass under Appendix A.
    assert cdf[-1] > 0.99  # Saturates by tau=90 for mu=2, sigma=0.5.


# ─── §7 multinomial parity (m=1 reduces to per-row Binomial) ────────────


def test_multinomial_m1_reduces_to_per_row_binomial():
    """Proposal §7 / §3 reduction property: when each cohort has exactly
    one retrieval, the new multinomial cell decomposition is bit-
    identical to the legacy per-row Binomial form
    ``k·log(p·F(τ)) + (n-k)·log(1−p·F(τ))``.

    Asserts the plan structure is correct (one cell at τ with k
    arrivals; residual cell at the same τ) and that the §3 cell sum
    equals the per-row Binomial form for fixed p · F values.
    """
    from runner.primitive_conditioning import _build_cohort_likelihood_plan

    res = _build_resolution(
        candidates=[_candidate(
            observed_date='2026-03-15', n=50, k=20,
            retrieved_at='2026-03-25',
        )],
    )
    plan = _build_cohort_likelihood_plan(
        weighted_view=res.weighted_view,
        timing_family=TimingFamily.LATENT,
        timing_max_tau=30,
    )

    assert len(plan.cohort_buckets) == 1, (
        f"expected one cohort bucket for m=1 fixture, "
        f"got {len(plan.cohort_buckets)}"
    )
    bucket = plan.cohort_buckets[0]

    # Tau between observed and retrieved is 10 days.
    assert bucket.last_observed_tau_idx == 10
    assert len(bucket.increments) == 1
    tau_idx, inc = bucket.increments[0]
    assert tau_idx == 10
    assert inc == pytest.approx(20.0)
    assert bucket.last_k_weighted == pytest.approx(20.0)
    assert bucket.n_weighted == pytest.approx(50.0)

    # Algebraic parity: for arbitrary (p, F(τ)) the §3 cell sum equals
    # the per-row Binomial. Compute both for a sweep and assert
    # element-wise equality.
    p_grid = np.array([0.05, 0.2, 0.5, 0.8, 0.95])
    F_grid = np.array([0.1, 0.4, 0.7, 0.9, 0.99])
    for p, F in zip(p_grid, F_grid):
        # §3 multinomial form (single positive cell at τ, residual at τ):
        #   k · log(p·(F-0)) + (n-k) · log(1 − p·F)
        cell = inc * np.log(p * F)
        residual = (bucket.n_weighted - bucket.last_k_weighted) * np.log1p(-p * F)
        multinomial_logl = cell + residual

        # Per-row Binomial form (HEAD pre-rewrite):
        #   k · log(p·F(τ)) + (n−k) · log(1 − p·F(τ))
        binomial_logl = (
            20.0 * np.log(p * F)
            + 30.0 * np.log1p(-p * F)
        )
        assert multinomial_logl == pytest.approx(binomial_logl, rel=1e-12), (
            f"§3 multinomial m=1 reduction failed at p={p}, F={F}: "
            f"multinomial={multinomial_logl}, binomial={binomial_logl}"
        )


def test_multinomial_plateau_preserves_survival_pressure():
    """Proposal §3: when a cohort's trajectory ends on a plateau (kₘ = kₘ₋₁),
    the residual cell must evaluate at τₘ (trajectory's final
    retrieval), not at τₘ₋₁ (last positive cell). Zero-count cells must
    appear in ``increments`` so the multinomial loop advances ``prev_F``
    through the plateau.
    """
    from runner.primitive_conditioning import _build_cohort_likelihood_plan

    res = _build_resolution(
        candidates=[
            _candidate(
                observed_date='2026-03-15', n=50, k=20,
                retrieved_at='2026-03-20',
            ),
            _candidate(
                observed_date='2026-03-15', n=50, k=20,
                retrieved_at='2026-03-30',
            ),
        ],
    )
    plan = _build_cohort_likelihood_plan(
        weighted_view=res.weighted_view,
        timing_family=TimingFamily.LATENT,
        timing_max_tau=30,
    )

    assert len(plan.cohort_buckets) == 1
    bucket = plan.cohort_buckets[0]

    # Trajectory has retrievals at τ=5 and τ=15. Both at k=20 →
    # increment at τ=5 is 20, increment at τ=15 is 0 (plateau).
    assert len(bucket.increments) == 2, (
        f"expected 2 cells (positive + zero plateau), "
        f"got {len(bucket.increments)}: {bucket.increments}"
    )
    assert bucket.increments[0] == (5, pytest.approx(20.0))
    assert bucket.increments[1][0] == 15
    assert bucket.increments[1][1] == pytest.approx(0.0)
    # Residual reference is the trajectory's final τ, not the last
    # positive cell.
    assert bucket.last_observed_tau_idx == 15
    assert bucket.last_k_weighted == pytest.approx(20.0)


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


@pytest.mark.skip(
    reason=(
        "OBSOLETE under 73n DrawFamilyKey v2 (Atom 2): scenario_seed was "
        "deliberately dropped from canonical_string — see "
        "runner/primitives.py:146-149. By design, two primitives with "
        "identical math share a draw family regardless of scenario_seed. "
        "The retained intent (distinct draw families → independent streams) "
        "is pinned at the contract level by "
        "test_primitive_contract.py::test_different_draw_family_keys_produce_independent_draws. "
        "Audit row reclassified PARTIAL → OBSOLETE; tombstoned per "
        "73-attic-mending-process.md §6.2."
    )
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


# Removed: ``test_conditioned_primitive_uses_keyed_prior_draw_family_mode``.
# ``DrawFamilyMode`` had collapsed to a one-value enum after the
# refactor; the field has been removed entirely. Draw-family identity
# is carried by ``DrawFamilyKey`` alone — see
# ``test_two_consumers_with_matching_draw_family_keys_get_identical_draws``
# for the equivalent guarantee at the contract level.


# ─── Phase 6b: degenerate-prior-Beta warning ────────────────────────────


def _primitive_scope_for_unconditioned():
    """Minimal PrimitiveScope for `make_unconditioned_primitive` calls in
    the Phase 6b tests. Reuses the same evidence-scope shape as the
    conditioned-primitive tests."""
    ev_scope = _evidence_scope()
    return make_primitive_scope_from_evidence_scope(
        evidence_scope=ev_scope,
        model_source_preference='best_available',
        resolved_source_identity='analytic',
    )


def test_make_unconditioned_primitive_emits_degenerate_prior_warning_when_alpha_beta_floored():
    """asat-bayes-vars-fix plan §Phase 6b. When the resolver hands an
    effectively-zero (α, β) to `make_unconditioned_primitive`, the
    1e-12 floor silently produces a degenerate Beta(1e-12, 1e-12) whose
    draws are bimodal. The defence-in-depth warning must fire so the
    failure mode is observable instead of silently producing
    chart_curve = subject_cdf rather than p × CDF.

    Pre-fix this triggered when asat tier-1 wholesale-replaced file rows
    with one snapshot row, breaking momentMatchAnalyticBeta and leaving
    the graph edge with no Beta block. The same mathematical condition
    is reproduced here directly via ResolvedModelParams.
    """
    from runner.primitive_conditioning import make_unconditioned_primitive
    from runner.primitives import PrimitiveScope

    transition = TransitionIdentity('U', 'V', 'e-degenerate-prior')
    scope = _primitive_scope_for_unconditioned()
    rm = _resolved_model(
        alpha=0.0, beta=0.0, n_effective=None,
        mu=0.0, sigma=0.0, onset=0.0,  # NON_LATENT — exercises that return path
    )
    prim = make_unconditioned_primitive(
        transition=transition,
        primitive_scope=scope,
        resolved_model=rm,
        scenario_seed=42,
        dispersion_basis='predictive',
    )
    # The legacy "status=unconditioned_overlay" note must remain so
    # diagnostic consumers don't break.
    assert any('status=unconditioned_overlay' in n for n in prim.notes)
    # The new Phase 6b warning must be present too.
    warning = next(
        (n for n in prim.notes if 'WARNING degenerate_prior_beta' in n),
        None,
    )
    assert warning is not None, (
        f'expected degenerate_prior_beta warning in notes; got {prim.notes!r}'
    )
    # Source label and floored values surfaced in the warning text.
    assert 'source=analytic' in warning
    assert 'alpha=' in warning
    assert 'beta=' in warning


def test_make_unconditioned_primitive_does_not_warn_on_well_defined_prior():
    """Sanity counterpart to the previous test: a well-defined Beta(40,
    120) prior must NOT produce the degenerate warning. Catches a
    regression where the threshold is mis-tuned (e.g. 1e+6 instead of
    1e-6) and the warning fires for every primitive."""
    from runner.primitive_conditioning import make_unconditioned_primitive

    transition = TransitionIdentity('U', 'V', 'e-well-defined-prior')
    scope = _primitive_scope_for_unconditioned()
    rm = _resolved_model(alpha=40.0, beta=120.0, n_effective=None)
    prim = make_unconditioned_primitive(
        transition=transition,
        primitive_scope=scope,
        resolved_model=rm,
        scenario_seed=42,
        dispersion_basis='epistemic',
    )
    assert not any(
        'WARNING degenerate_prior_beta' in n for n in prim.notes
    ), (
        f'unexpected degenerate_prior_beta warning on Beta(40, 120); '
        f'notes={prim.notes!r}'
    )


def test_make_unconditioned_primitive_warning_fires_for_latent_path_too():
    """The warning must surface on the latent timing-family return path
    (line 1625) not just the non-latent path (line 1535). Both paths
    construct the primitive with the same `notes` filter; this test
    pins parity between them."""
    from runner.primitive_conditioning import make_unconditioned_primitive

    transition = TransitionIdentity('U', 'V', 'e-latent-degenerate')
    scope = _primitive_scope_for_unconditioned()
    rm = _resolved_model(
        alpha=0.0, beta=0.0, n_effective=None,
        mu=2.5, sigma=0.5, onset=3.0,  # sigma > 0 ⇒ LATENT path
    )
    prim = make_unconditioned_primitive(
        transition=transition,
        primitive_scope=scope,
        resolved_model=rm,
        scenario_seed=42,
        dispersion_basis='epistemic',
    )
    assert any(
        'WARNING degenerate_prior_beta' in n for n in prim.notes
    ), f'latent path missed degenerate warning; notes={prim.notes!r}'
    # And the legacy latent note must still be present.
    assert any('timing_family=latent' in n for n in prim.notes)
