"""73m Stage 4 — subject-span CDF ownership tests.

These tests pin the Stage 4 contract: when a prepared subject-span
deterministic CDF or MC CDF is supplied to ``compute_forecast_trajectory``,
the engine must use that prepared object for subject-side progression and
for IS likelihood completeness. It must not silently recompute completeness
from terminal-edge ``(mu, sigma, onset)`` — the 73h "computed and
discarded" pattern.

The trajectory return now exposes four diagnostic labels:

- ``subject_span_source``       — 'prepared_mc' / 'prepared_det' / 'edge_level'
- ``subject_probability_source``— 'span_level' / 'edge_level'
- ``is_completeness_source``    — 'prepared_cdf_arr' (Phase 1 contract)
- ``evidence_denominator``      — 'x_at_x' (Phase 1 contract)

The tests below are deliberately narrow: they exercise the
``compute_forecast_trajectory`` kernel with hand-built inputs so the
relationship between the prepared object and the diagnostic is direct.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import numpy as np
import pytest


def _resolved(*, mu=2.0, sigma=0.5, onset=0.0, p_mean=0.3,
              alpha=30.0, beta=70.0):
    from runner.model_resolver import ResolvedLatency, ResolvedModelParams

    return ResolvedModelParams(
        p_mean=p_mean, p_sd=0.05,
        alpha=alpha, beta=beta,
        alpha_pred=alpha, beta_pred=beta,
        n_effective=alpha + beta,
        edge_latency=ResolvedLatency(
            mu=mu, sigma=sigma, onset_delta_days=onset,
            mu_sd=0.0, sigma_sd=0.0,
        ),
        source='bayesian',
    )


def _single_cohort(*, n=100.0, k=50.0, frontier_age=10, eval_age=10):
    from runner.forecast_state import CohortEvidence

    return CohortEvidence(
        obs_x=[n] * (frontier_age + 1),
        obs_y=[k] * (frontier_age + 1),
        x_frozen=n, y_frozen=k,
        frontier_age=frontier_age,
        a_pop=n,
        evidence_n=n,
        evidence_k=k,
        eval_age=eval_age,
    )


def _condition_with_cohort(
    *,
    S: int,
    mu: float, sigma: float, mu_sd: float, sigma_sd: float,
    alpha: float, beta: float,
    n_obs: int, k_obs: int,
    observed_date: str = '2026-03-15',
    retrieved_at: str = '2026-03-25',
):
    """Build a single-cohort PrimitiveEvidenceResolution and run
    ``condition_primitive``.

    73n stage-9 moved IS conditioning out of the trajectory engine into
    ``runner.primitive_conditioning``; the trajectory engine is now a
    pure projector. ``TestIsLikelihoodConsumesPreparedCdf`` exercises
    the live IS path here — driving the conditioner with a fixture that
    can dial per-draw CDF dispersion via the resolved-latency
    ``mu_sd`` / ``sigma_sd`` knobs.
    """
    from evidence_merge import (
        EvidenceCandidate, EvidenceIdentity, EvidenceRole, EvidenceScope,
        ObservationCoordinate, SliceFamily, SourceKind, TemporalBasis,
    )
    from runner.model_resolver import ResolvedLatency, ResolvedModelParams
    from runner.prefix_arrival import (
        PrefixArrivalIdentity, build_prefix_arrival_map,
    )
    from runner.primitive_conditioning import (
        ConditioningPolicyOptions, condition_primitive,
    )
    from runner.primitive_evidence import (
        bind_primitive_evidence, make_primitive_scope_from_evidence_scope,
    )
    from runner.primitives import TransitionIdentity
    from runner.timing_span import TimingTransitionPrimitive

    src, dst = 'U', 'V'
    edge_id = 'e-u-v'
    graph = {
        'nodes': [
            {'uuid': 'u-u', 'id': src},
            {'uuid': 'u-v', 'id': dst},
        ],
        'edges': [{'uuid': edge_id, 'from': 'u-u', 'to': 'u-v'}],
    }
    transitions = {
        (src, dst): TimingTransitionPrimitive(
            p=alpha / (alpha + beta), mu=mu, sigma=max(sigma, 0.01),
            onset=0.0,
            p_sd=0.0, mu_sd=0.0, sigma_sd=0.0, onset_sd=0.0,
            source='test_synthetic',
        ),
    }
    arrival_map = build_prefix_arrival_map(
        graph=graph, root_node_id=src,
        root_day_weights={observed_date: 1.0},
        transitions=transitions,
        identity=PrefixArrivalIdentity(
            scenario_id='scn-1', request_root=src,
            context_key=None, regime_key='default',
            as_at='2026-04-01',
            model_source_preference='best_available',
            parameter_fingerprint='fp-1',
        ),
        max_tau=60,
        # Match the conditioning draw_count so the weighted view's
        # per-draw arrays line up with the IS proposal's particles.
        draw_count=S,
    )
    ev_scope = EvidenceScope(
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        subject_from=src, subject_to=dst,
        date_from='2026-03-01', date_to='2026-03-31',
        as_at='2026-04-01', scenario_id='scn-1',
        anchor=None, context_key=None, regime_key=None,
    )
    primitive_scope = make_primitive_scope_from_evidence_scope(
        evidence_scope=ev_scope,
        model_source_preference='best_available',
        resolved_source_identity='bayesian',
    )
    candidates = [EvidenceCandidate(
        source=SourceKind.SNAPSHOT,
        identity=EvidenceIdentity(
            role=EvidenceRole.WINDOW_SUBJECT_HELPER,
            subject_from=src, subject_to=dst,
            anchor=None, slice_family=SliceFamily.WINDOW,
            context_key=None, regime_key=None,
            population_identity=None,
        ),
        coordinate=ObservationCoordinate(
            observed_date=observed_date,
            retrieved_at=retrieved_at,
            temporal_basis=TemporalBasis.WINDOW_DAY,
            asat_materialised=False,
        ),
        n=int(n_obs), k=int(k_obs), provenance={},
    )]
    resolution = bind_primitive_evidence(
        transition=TransitionIdentity(src, dst, edge_id),
        primitive_scope=primitive_scope,
        evidence_scope=ev_scope,
        candidates=candidates,
        arrival_weights=arrival_map.get(src),
    )
    resolved = ResolvedModelParams(
        p_mean=alpha / (alpha + beta), p_sd=0.0,
        alpha=alpha, beta=beta,
        alpha_pred=alpha, beta_pred=beta,
        n_effective=None,
        edge_latency=ResolvedLatency(
            mu=mu, sigma=max(sigma, 0.01), onset_delta_days=0.0, t95=0.0,
            mu_sd=mu_sd, sigma_sd=sigma_sd, onset_sd=0.0,
            onset_mu_corr=0.0,
        ),
        path_latency=None,
        source='analytic',
    )
    return condition_primitive(
        resolution=resolution,
        resolved_model=resolved,
        scenario_seed=42,
        options=ConditioningPolicyOptions(
            draw_count=S, timing_cdf_max_tau=60,
        ),
    )


def _read_ess_from_notes(prim) -> float:
    """Parse the IS ESS from a conditioned primitive's ``notes``.

    ``primitive_conditioning`` records the IS step's ESS on a
    ``maturity_aware_mode=… ess=N.NN`` note line for the LATENT path.
    """
    import re
    for note in prim.notes:
        m = re.search(r'\bess=([\d.]+)', note)
        if m:
            return float(m.group(1))
    raise AssertionError(
        f"primitive notes carry no 'ess=' line: {list(prim.notes)}"
    )


class TestSubjectSpanSourceDiagnostic:
    """The trajectory return must expose which CDF object the engine used."""

    def test_subject_span_source_is_prepared_mc_when_mc_cdf_supplied(self):
        from runner.forecast_state import compute_forecast_trajectory

        S = 64
        T = 31
        mc_cdf_arr = np.tile(
            np.clip(np.linspace(0.0, 1.0, T), 0.0, 1.0), (S, 1)
        )
        mc_p_s = np.full(S, 0.3)

        sweep = compute_forecast_trajectory(
            resolved=_resolved(),
            cohorts=[_single_cohort()],
            max_tau=T - 1,
            mc_cdf_arr=mc_cdf_arr,
            mc_p_s=mc_p_s,
            num_draws=S,
        )

        assert sweep.subject_span_source == 'prepared_mc'
        assert sweep.subject_probability_source == 'span_level'
        assert sweep.is_completeness_source == 'prepared_cdf_arr'
        assert sweep.evidence_denominator == 'x_at_x'

    def test_subject_span_source_is_edge_level_when_no_prepared(self):
        from runner.forecast_state import compute_forecast_trajectory

        sweep = compute_forecast_trajectory(
            resolved=_resolved(),
            cohorts=[_single_cohort()],
            max_tau=30,
            num_draws=64,
        )

        assert sweep.subject_span_source == 'edge_level'
        assert sweep.subject_probability_source == 'edge_level'
        assert sweep.is_completeness_source == 'prepared_cdf_arr'
        assert sweep.evidence_denominator == 'x_at_x'

    def test_subject_span_source_is_prepared_det_when_only_det_cdf_supplied(self):
        from runner.forecast_state import compute_forecast_trajectory

        T = 31
        det_norm_cdf = list(np.clip(np.linspace(0.0, 1.0, T), 0.0, 1.0))

        sweep = compute_forecast_trajectory(
            resolved=_resolved(),
            cohorts=[_single_cohort()],
            max_tau=T - 1,
            det_norm_cdf=det_norm_cdf,
            num_draws=64,
        )

        # MC CDF was not supplied — per-draw object falls back to edge-level
        # construction, but the deterministic span CDF is honoured.
        assert sweep.subject_span_source == 'prepared_det'
        # No span-level p_XE supplied → fall back to edge-level subject p.
        assert sweep.subject_probability_source == 'edge_level'


class TestIsLikelihoodConsumesPreparedCdf:
    """The IS likelihood must read the prepared per-draw CDF, not
    recompute completeness from constant edge-level ``(mu, sigma,
    onset)`` — the 73h "computed and discarded" pattern.

    73n stage-9 moved IS conditioning out of the trajectory engine
    (now a pure projector) into ``runner.primitive_conditioning``. The
    same per-draw CDF wiring lives there: the IS log-likelihood loop
    reads ``proposal_cdf_draws[:, tau_idx]`` per particle (see
    ``primitive_conditioning._evaluate_likelihood_plan``). These tests
    drive that path via ``condition_primitive`` and read the IS ESS
    from the conditioned primitive's ``notes`` provenance.
    """

    def test_per_draw_cdf_variation_drives_is_separation(self):
        """Force per-draw CDF dispersion via ``mu_sd`` on the resolved
        latency: with ``mu ~ N(2.3, 2.0²)`` and ``sigma=0.5``, the
        sampled timing particles span CDF(τ=10) values from ≈0 (high-μ
        draws) to ≈1 (low-μ draws). The cohort observation k/n=0.5 at
        τ=10 is consistent only with the high-CDF particles; the IS
        step must collapse the floor particles' weight, dropping ESS
        far below S.

        With a tightly-concentrated p prior (α=β=500 → p_draws ≈ 0.5
        with negligible variance) the only source of log-likelihood
        separation across particles is the per-draw CDF. Under the
        legacy recompute path (one scalar CDF for every particle) the
        IS could not separate at all and ESS would sit at S.
        """
        S = 200
        prim = _condition_with_cohort(
            S=S,
            mu=2.3, sigma=0.5, mu_sd=2.0, sigma_sd=0.0,
            alpha=500.0, beta=500.0,
            n_obs=100, k_obs=50,
        )

        # Conditioning happened (and via the latent multinomial-IS path,
        # not the F≡1 conjugate fallback). Successor of the former
        # ``n_cohorts_conditioned == 1`` assertion under the new layer.
        from runner.primitives import ConditioningStatus
        assert prim.status == ConditioningStatus.CONDITIONED
        assert any(
            'maturity_aware_mode=maturity_aware_is_joint' in n
            for n in prim.notes
        ), f"expected latent IS path; notes={list(prim.notes)}"

        # Per-draw CDF separation collapses the IS weight. Same
        # threshold as the legacy trajectory-engine pin.
        ess = _read_ess_from_notes(prim)
        assert ess <= S * 0.55, (
            f"IS effective sample size {ess} not reduced as "
            f"expected; the per-draw CDF dispersion is not biting"
        )

    def test_uniform_cdf_no_is_separation(self):
        """Regression guard: with no per-draw CDF variation
        (``mu_sd=sigma_sd=onset_sd=0`` → identical CDF across particles)
        and a tightly-concentrated p prior, log-likelihood values
        across draws are near-identical and the IS step leaves ESS at
        S. Confirms the IS step does not invent separation that isn't
        present in the per-draw CDF.
        """
        S = 200
        prim = _condition_with_cohort(
            S=S,
            mu=2.3, sigma=0.5, mu_sd=0.0, sigma_sd=0.0,
            alpha=10000.0, beta=10000.0,
            n_obs=10, k_obs=5,
        )

        ess = _read_ess_from_notes(prim)
        assert ess > S * 0.5, (
            f"IS effective sample size {ess} unexpectedly reduced; "
            f"with constant per-draw CDF and a tight p prior the IS "
            f"step should leave the draws near-uniform"
        )


class TestSigmaZeroPreparedSubjectSpan:
    """The terminal-edge ``sigma <= 0`` early return is the 73h
    'computed and discarded' surface for non-latency targets. Stage 4
    must honour the prepared subject-span CDF when it is supplied — the
    early return only fires for genuinely degenerate inputs.
    """

    def test_sigma_zero_with_prepared_mc_cdf_does_not_early_return(self):
        from runner.forecast_state import compute_forecast_trajectory

        S = 64
        T = 31
        # Dirac-at-zero subject-span CDF: saturated from t=0 across all
        # draws — the natural shape for a non-latency span.
        mc_cdf_arr = np.ones((S, T))
        mc_p_s = np.full(S, 0.4)

        sweep = compute_forecast_trajectory(
            resolved=_resolved(mu=0.0, sigma=0.0, onset=0.0, p_mean=0.4),
            cohorts=[_single_cohort(n=100.0, k=40.0)],
            max_tau=T - 1,
            mc_cdf_arr=mc_cdf_arr,
            mc_p_s=mc_p_s,
            num_draws=S,
        )

        # Stage 4 forbids the empty trajectory in this case — the
        # prepared subject-span object encodes the right answer.
        assert sweep.rate_draws.shape == (S, T)
        assert not np.allclose(sweep.rate_draws, 0.0)
        assert sweep.subject_span_source == 'prepared_mc'

    def test_sigma_zero_without_prepared_still_early_returns(self):
        """Regression guard for the genuinely degenerate case: terminal
        edge non-latent and no prepared subject-span object available.
        The trajectory should be empty rather than fabricate a curve from
        edge-level ``(mu=0, sigma=0)``.
        """
        from runner.forecast_state import compute_forecast_trajectory

        S = 64
        T = 31
        sweep = compute_forecast_trajectory(
            resolved=_resolved(mu=0.0, sigma=0.0, onset=0.0, p_mean=0.4),
            cohorts=[_single_cohort()],
            max_tau=T - 1,
            num_draws=S,
        )

        assert sweep.rate_draws.shape == (S, T)
        assert np.allclose(sweep.rate_draws, 0.0)
        assert sweep.subject_span_source == 'edge_level'
        assert sweep.is_completeness_source is None


class TestDiracSubjectSpan:
    """The unified trajectory path owns non-latency degeneracies directly."""

    def test_trajectory_zero_evidence_returns_prior_for_dirac_subject_span(self):
        """Class C edge case: no cohort evidence in the window. Both
        surfaces should return the prior unchanged (modulo MC noise).
        """
        from runner.forecast_state import compute_forecast_trajectory

        S = 2000
        T = 31

        alpha_prior = 5.0
        beta_prior = 15.0
        prior_mean = alpha_prior / (alpha_prior + beta_prior)

        # No cohort evidence: empty list so IS never fires.
        cohorts = []

        mc_cdf_arr = np.ones((S, T))
        rng = np.random.default_rng(42)
        mc_p_s = rng.beta(alpha_prior, beta_prior, size=S)

        sweep = compute_forecast_trajectory(
            resolved=_resolved(
                mu=0.0, sigma=0.0, onset=0.0, p_mean=prior_mean,
                alpha=alpha_prior, beta=beta_prior,
            ),
            cohorts=cohorts,
            max_tau=T - 1,
            mc_cdf_arr=mc_cdf_arr,
            mc_p_s=mc_p_s,
            num_draws=S,
        )

        # No IS conditioning: p_draws (if populated) come straight from
        # the predictive Beta, so the median should sit at the prior
        # mean within MC noise.
        if sweep.p_draws is not None and sweep.p_draws.size:
            post_median = float(np.median(sweep.p_draws))
            assert abs(post_median - prior_mean) < 3e-2, (
                f"zero-evidence trajectory median {post_median:.4f} "
                f"diverged from prior mean {prior_mean:.4f}"
            )


class TestStage6ProjectionDiagnostics:
    """73m §"Stage 6" projection-and-field-audit diagnostics.

    The four 73h F14 forensic-trace questions must be answerable from the
    trajectory return alone:

    - Q1 — which router branch was taken or bypassed?
      ``legacy_non_latency_router_bypassed`` is True post-Stage-5 (router
      retired; trajectory engine always runs).
    - Q2 — does the non-latency answer agree with the σ_eff=0 trajectory
      limit?  Proven by the
      :class:`TestNonLatencyClosedFormEquivalence` tests above.
    - Q3 — which carrier source/tier supplied carrier_to_x?
      ``carrier_reach`` and ``carrier_cdf_source`` expose the carrier
      provenance.
    - Q4 — does projection read the resolved runtime object?
      ``subject_span_source`` / ``subject_probability_source`` /
      ``is_completeness_source`` answer this on the subject side; this
      class adds the carrier-side parallel.

    Plus the §"Mathematical invariants" rule: "in the all-non-latency
    carrier case where C_AX(t) is a Dirac-at-zero shape, reach changes
    denominator mass and absolute numerator mass by the same factor. It
    must cancel out of the displayed subject rate." The
    ``test_dirac_subject_rate_invariant_to_cohort_size_scaling`` case
    pins this directly at the kernel layer.
    """

    def test_stage_6_diagnostics_populated_when_no_runtime_bundle(self):
        """Trajectory called without a runtime_bundle (window-equivalent
        kernel call): carrier_reach is None, carrier_cdf_source is None,
        path_completeness_source falls back to 'subject_span_only',
        legacy_non_latency_router_bypassed is True.
        """
        from runner.forecast_state import compute_forecast_trajectory

        S = 64
        T = 31
        mc_cdf_arr = np.ones((S, T))
        mc_p_s = np.full(S, 0.3)

        sweep = compute_forecast_trajectory(
            resolved=_resolved(mu=0.0, sigma=0.0, p_mean=0.3),
            cohorts=[_single_cohort()],
            max_tau=T - 1,
            mc_cdf_arr=mc_cdf_arr,
            mc_p_s=mc_p_s,
            num_draws=S,
        )

        assert sweep.carrier_reach is None
        assert sweep.carrier_cdf_source is None
        assert sweep.path_completeness_source == 'subject_span_only'
        assert sweep.legacy_non_latency_router_bypassed is True

    def test_stage_6_diagnostics_populated_on_empty_trajectory_return(self):
        """The σ≤0 + no-prepared-CDF early return path also populates the
        Stage 6 diagnostic fields. Regression guard: a future stage that
        adds another return point must populate these fields too.
        """
        from runner.forecast_state import compute_forecast_trajectory

        # σ=0 AND no mc_cdf_arr / det_norm_cdf → empty-trajectory return.
        sweep = compute_forecast_trajectory(
            resolved=_resolved(mu=0.0, sigma=0.0, p_mean=0.3),
            cohorts=[_single_cohort()],
            max_tau=30,
            num_draws=64,
        )

        # Empty trajectory carries the same Stage 6 diagnostic shape so a
        # forensic trace can read the fields uniformly.
        assert sweep.legacy_non_latency_router_bypassed is True
        assert sweep.path_completeness_source == 'subject_span_only'
        assert sweep.carrier_reach is None
        assert sweep.carrier_cdf_source is None

    def test_stage_6_diagnostics_identity_carrier_via_runtime_bundle(self):
        """When a runtime_bundle is supplied with
        ``carrier_to_x.mode='identity'`` (window or A=X cohort), the
        diagnostic surface reports ``carrier_cdf_source='identity'`` and
        ``carrier_reach`` reflects the reach scalar (1.0 by convention).
        """
        from runner.forecast_state import compute_forecast_trajectory
        from runner.forecast_runtime import (
            PreparedCarrierToX, PreparedForecastRuntimeBundle,
        )

        S = 64
        T = 31
        mc_cdf_arr = np.ones((S, T))
        mc_p_s = np.full(S, 0.3)

        bundle = PreparedForecastRuntimeBundle(
            mode='window',
            population_root='X',
            carrier_to_x=PreparedCarrierToX(
                population_root='X',
                anchor_node_id=None,
                x_node_id='X',
                mode='identity',
                reach=1.0,
            ),
        )

        sweep = compute_forecast_trajectory(
            resolved=_resolved(mu=0.0, sigma=0.0, p_mean=0.3),
            cohorts=[_single_cohort()],
            max_tau=T - 1,
            mc_cdf_arr=mc_cdf_arr,
            mc_p_s=mc_p_s,
            num_draws=S,
            runtime_bundle=bundle,
        )

        assert sweep.carrier_cdf_source == 'identity'
        assert sweep.carrier_reach == 1.0
        assert sweep.path_completeness_source == 'subject_span_only'
        assert sweep.legacy_non_latency_router_bypassed is True

    def test_dirac_subject_rate_invariant_to_cohort_size_scaling(self):
        """73m §"Mathematical invariants" + §"Stage 6" stop condition.

        In the all-non-latency carrier case where C_AX(t) is Dirac-at-zero
        shape, "reach changes denominator mass and absolute numerator mass
        by the same factor. It must cancel out of the displayed subject
        rate."

        The kernel-level demonstration: doubling the cohort size (which
        is what carrier reach does to the X-mass that survives the
        anchor→X transition under a Dirac carrier CDF) leaves rate_draws
        and p_draws unchanged. We do NOT need to plumb an active carrier
        through compose_carrier_to_x for this invariant — the trajectory
        engine is given cohorts whose ``n`` already carries any reach
        scaling, and the rate it computes is Y/X regardless of the
        absolute scale of n.
        """
        from runner.forecast_state import compute_forecast_trajectory

        S = 200
        T = 21
        # Dirac saturation: subject CDF is 1 everywhere after τ=0.
        mc_cdf_arr = np.ones((S, T))
        # Span-level subject probability identical per draw — so the
        # rate is exactly p, no IS rate dispersion.
        mc_p_s = np.full(S, 0.7)
        resolved = _resolved(
            mu=0.0, sigma=0.0, onset=0.0, p_mean=0.7,
            alpha=70.0, beta=30.0,
        )

        # Case A: cohort size 100 with rate 70/100 = 0.7
        cohort_a = _single_cohort(n=100.0, k=70.0, frontier_age=10, eval_age=10)
        sweep_a = compute_forecast_trajectory(
            resolved=resolved,
            cohorts=[cohort_a],
            max_tau=T - 1,
            mc_cdf_arr=mc_cdf_arr,
            mc_p_s=mc_p_s,
            num_draws=S,
        )

        # Case B: cohort size 200 with same rate 140/200 = 0.7 (counts
        # doubled — emulates a doubled-reach scenario). Same underlying p.
        cohort_b = _single_cohort(n=200.0, k=140.0, frontier_age=10, eval_age=10)
        sweep_b = compute_forecast_trajectory(
            resolved=resolved,
            cohorts=[cohort_b],
            max_tau=T - 1,
            mc_cdf_arr=mc_cdf_arr,
            mc_p_s=mc_p_s,
            num_draws=S,
        )

        # Rate-axis assertion: median rate at saturation is invariant to
        # cohort-size scaling. Tolerance absorbs IS reweighting noise; the
        # underlying p is 0.7 in both cases.
        assert sweep_a.p_draws is not None and sweep_b.p_draws is not None
        median_a = float(np.median(sweep_a.p_draws))
        median_b = float(np.median(sweep_b.p_draws))
        assert abs(median_a - median_b) < 1e-2, (
            f"Stage 6 invariant violation: cohort-size scaling moved the "
            f"displayed rate. case_a median={median_a:.4f} vs "
            f"case_b median={median_b:.4f}; reach is leaking into rate."
        )
        # Both medians sit near the underlying p=0.7.
        assert abs(median_a - 0.7) < 5e-2, (
            f"case_a median {median_a:.4f} far from underlying p=0.7"
        )
        assert abs(median_b - 0.7) < 5e-2, (
            f"case_b median {median_b:.4f} far from underlying p=0.7"
        )

        # Count-axis assertion: det_x_total and det_y_total scale with
        # cohort size. A doubling on input must produce a doubling on the
        # deterministic count outputs, demonstrating that the count fields
        # carry the reach×population scaling that the rate fields do not.
        if sweep_a.det_x_total is not None and sweep_b.det_x_total is not None:
            tau_check = T - 1
            x_a = float(sweep_a.det_x_total[tau_check])
            x_b = float(sweep_b.det_x_total[tau_check])
            assert x_a > 0 and x_b > 0, (
                f"unexpected zero counts at saturation: x_a={x_a} x_b={x_b}"
            )
            ratio = x_b / x_a
            assert abs(ratio - 2.0) < 0.1, (
                f"count-axis scaling broken: doubled-cohort case produced "
                f"ratio={ratio:.3f} of det_x_total at τ={tau_check}; "
                f"expected ≈2.0 (counts scale with reach×a_pop)."
            )
