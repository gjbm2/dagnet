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
    """The IS likelihood must read per-draw completeness from ``cdf_arr``,
    not recompute from constant ``(mu, sigma, onset)``.
    """

    def test_per_draw_cdf_variation_drives_is_separation(self):
        """Construct a degenerate prepared subject span where the per-draw
        CDF splits sharply by particle index: half saturated, half not.

        With constant edge-level ``(mu, sigma, onset)``, the legacy
        recompute path produced a single per-draw completeness value,
        so every draw's IS-likelihood factor was identical and the
        binomial weights varied only in ``p``. Stage 4 wires the IS
        likelihood to read ``cdf_arr`` directly, so the per-draw split
        actually shows up in the IS effective sample size.

        Concretely: with the rigged half/half ``mc_cdf_arr``, evidence
        of ``k/n = 0.5`` matching ``p · 1.0`` (saturated half) and
        contradicting ``p · 0.01`` (floor half) collapses the floor
        half's weight to near zero, halving the effective sample size
        relative to the constant-CDF baseline below. With the legacy
        recompute path this collapse could not happen — completeness
        was the same scalar for every particle.
        """
        from runner.forecast_state import compute_forecast_trajectory

        S = 200
        T = 31
        # Half saturated (CDF=1), half floor (CDF=0.01) — the floor must
        # be > 0 to keep the binomial likelihood finite.
        mc_cdf_arr = np.zeros((S, T))
        mc_cdf_arr[:S // 2, :] = 1.0
        mc_cdf_arr[S // 2:, :] = 0.01
        # Subject probability identical per draw — forcing the IS split
        # to come from completeness, not from ``p``.
        mc_p_s = np.full(S, 0.5)

        cohort = _single_cohort(n=100.0, k=50.0, frontier_age=10, eval_age=10)

        sweep = compute_forecast_trajectory(
            resolved=_resolved(p_mean=0.5, alpha=500.0, beta=500.0),
            cohorts=[cohort],
            max_tau=T - 1,
            mc_cdf_arr=mc_cdf_arr,
            mc_p_s=mc_p_s,
            num_draws=S,
        )

        assert sweep.n_cohorts_conditioned == 1
        # The saturated-half/floor-half log-likelihood gap is enormous
        # (∼260 nats) so even with tempering the floor half's weight is
        # collapsed to near zero. The effective sample size therefore
        # tracks the saturated half — at most S/2 plus rounding.
        # Under the legacy recompute path, completeness was a single
        # scalar across draws and ESS sat at S (no IS separation).
        assert sweep.is_ess <= S * 0.55, (
            f"IS effective sample size {sweep.is_ess} not reduced as "
            f"expected; the per-draw cdf_arr split is not biting"
        )

    def test_uniform_cdf_no_is_separation(self):
        """Regression guard: when the prepared per-draw CDF is identical
        across draws and matches the evidence, IS should leave the rate
        draws essentially undisturbed.
        """
        from runner.forecast_state import compute_forecast_trajectory

        S = 100
        T = 31
        # All draws share the same ramp CDF.
        ramp = np.clip(np.linspace(0.0, 1.0, T), 0.0, 1.0)
        mc_cdf_arr = np.tile(ramp, (S, 1))
        mc_p_s = np.full(S, 0.3)

        sweep = compute_forecast_trajectory(
            resolved=_resolved(p_mean=0.3, alpha=300.0, beta=700.0),
            cohorts=[_single_cohort(n=100.0, k=30.0)],
            max_tau=T - 1,
            mc_cdf_arr=mc_cdf_arr,
            mc_p_s=mc_p_s,
            num_draws=S,
        )

        # Even with conditioning, the constant per-draw CDF means the
        # only IS variation comes from p_draws, so ESS stays high.
        assert sweep.is_ess > S * 0.5


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


class TestNonLatencyClosedFormEquivalence:
    """73m Stage 5 — the trajectory path must reproduce the same answer
    as the closed-form Beta-Binomial row builder (`_non_latency_rows`)
    when both are fed the same evidence with a Dirac-at-zero subject
    span, within an explicit MC tolerance.

    This guard is the prerequisite for retiring the v3 latency/non-
    latency router (plan §"Stage 5"). Without it, removing the closed-
    form shortcut could turn the multi-hop terminal-non-latency canaries
    green while regressing simple single-hop non-latency edges with no
    obvious coverage to catch the slippage.

    The two paths apply the same conjugate Beta-Binomial update and the
    same doc 52 §14.5 subset-conditioning blend, so the only sources of
    drift are (a) MC noise from S=2000 mc_p_s draws and (b) the
    `compute_forecast_trajectory` IS tempering (the bisection that
    enforces ESS ≥ `_IS_TARGET_ESS=20`, which holds the trajectory back
    from the fully-conditioned Beta posterior under abundant evidence).
    The test uses a moderate-evidence fixture so tempering does not
    dominate the comparison.
    """

    def test_trajectory_matches_non_latency_rows_for_dirac_subject_span(self):
        from runner.cohort_forecast_v3 import _non_latency_rows, FrameEvidence
        from runner.forecast_state import compute_forecast_trajectory

        S = 2000
        T = 31

        alpha_prior = 30.0
        beta_prior = 70.0
        # n_effective much larger than ΣN keeps the doc-52 blend ratio
        # `r = m_S / m_G` small (≈ 0.05), so the blend pulls only
        # gently toward the prior. With r close to 1, both paths land
        # at the prior and the test reduces to a tautology.
        n_effective = 20000.0

        # Three cohorts, all observed for ten days past their anchor.
        # IS conditioning uses `evidence_n`/`evidence_k` at
        # `frontier_age` (the `_tau_i > 0` guard in
        # `compute_forecast_trajectory` skips evidence at frontier_age=0).
        cohorts = [
            _single_cohort(n=200.0, k=110.0, frontier_age=10, eval_age=10),
            _single_cohort(n=300.0, k=170.0, frontier_age=10, eval_age=10),
            _single_cohort(n=500.0, k=270.0, frontier_age=10, eval_age=10),
        ]
        sum_n = sum(c.evidence_n for c in cohorts)
        sum_k = sum(c.evidence_k for c in cohorts)

        resolved_for_test = _resolved(
            mu=0.0, sigma=0.0, onset=0.0,
            p_mean=alpha_prior / (alpha_prior + beta_prior),
            alpha=alpha_prior, beta=beta_prior,
        )
        # Override n_effective on the resolved (the helper does not
        # take it as a kwarg).
        resolved_for_test.n_effective = n_effective

        # Closed-form oracle: feed the same cohort totals through
        # `_non_latency_rows` as a `FrameEvidence` and read its p_mean
        # from the last row. This is the exact closed-form Beta-Binomial
        # + doc 52 blend the trajectory path is meant to reproduce.
        cohort_dicts = [
            {
                'x_frozen': float(c.x_frozen),
                'y_frozen': float(c.y_frozen),
                'evidence_n': float(c.evidence_n),
                'evidence_k': float(c.evidence_k),
                'anchor_day': None,
                'tau_max': T - 1,
                'tau_observed': T - 1,
            }
            for c in cohorts
        ]
        fe = FrameEvidence(
            engine_cohorts=[],
            cohort_list=cohort_dicts,
            cohort_at_tau={},
            evidence_by_tau={},
            max_tau=T - 1,
            saturation_tau=T - 1,
            tau_solid_max=T - 1,
            tau_future_max=T - 1,
        )
        oracle = _non_latency_rows(
            fe=fe,
            resolved=resolved_for_test,
            sweep_to='2026-04-01',
            axis_tau_max=T - 1,
        )
        oracle_p_mean = float(oracle.rows[-1]['p_infinity_mean'])

        # Dirac-at-zero subject-span — what `mc_span_cdfs` produces for
        # a non-latency single-edge span. mc_p_s is drawn from the
        # predictive Beta to match that path.
        mc_cdf_arr = np.ones((S, T))
        rng = np.random.default_rng(42)
        mc_p_s = rng.beta(alpha_prior, beta_prior, size=S)

        sweep = compute_forecast_trajectory(
            resolved=resolved_for_test,
            cohorts=cohorts,
            max_tau=T - 1,
            mc_cdf_arr=mc_cdf_arr,
            mc_p_s=mc_p_s,
            num_draws=S,
        )

        assert sweep.subject_span_source == 'prepared_mc'
        assert sweep.subject_probability_source == 'span_level'
        assert sweep.is_completeness_source == 'prepared_cdf_arr'
        assert sweep.p_draws is not None
        trajectory_p_mean = float(np.median(sweep.p_draws))

        # Tolerance: 1e-1 absorbs MC noise (S=2000 Beta draws) plus the
        # IS tempering tax. The trajectory path enforces ESS ≥
        # `_IS_TARGET_ESS=20` via bisection on the tempering λ, which
        # under abundant evidence holds the trajectory short of the
        # fully-conditioned closed-form Beta posterior. The closed-form
        # row builder has no analogous stability gate, so the two paths
        # diverge by ~0.05–0.10 on this fixture (3 cohorts, ΣN=1000,
        # prior n_eff=20000). The plan §"Stage 5" allows this drift as
        # "explicit tolerance that accounts for MC approximation"; the
        # tighter alternative — an analytically equivalent draw
        # construction that bypasses tempering for the Dirac case — is
        # not in scope for Phase 1. The drift direction (trajectory
        # closer to prior than closed-form) is the conservative one
        # for non-latency edges.
        assert abs(trajectory_p_mean - oracle_p_mean) < 1e-1, (
            f"trajectory p_infinity median {trajectory_p_mean:.4f} "
            f"diverged from `_non_latency_rows` oracle "
            f"{oracle_p_mean:.4f} (ΣK/ΣN = {sum_k/sum_n:.4f}, "
            f"prior α/(α+β) = {alpha_prior/(alpha_prior+beta_prior):.4f})"
        )

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
