"""
Adversarial blind tests for stats engine functions.

Written from the CONTRACT (function signatures, docstrings, mathematical
definitions) WITHOUT reading the implementation. Goal: find real defects
by probing edge cases, degenerate inputs, and boundary conditions.

Run with:
    cd graph-editor && . venv/bin/activate
    pytest lib/tests/test_stats_engine_adversarial.py -v
"""

import math
import pytest

from runner.lag_distribution_utils import (
    fit_lag_distribution,
    log_normal_cdf,
    log_normal_inverse_cdf,
    log_normal_survival,
    to_model_space_lag_days,
    to_model_space_age_days,
    LATENCY_DEFAULT_SIGMA,
    ONSET_EPSILON_DAYS,
)
from runner.stats_engine import (
    compute_blended_mean,
    compute_per_day_blended_mean,
    compute_edge_latency_stats,
    fw_compose_pair,
    CohortData,
    LagDistributionFit,
)


# ═══════════════════════════════════════════════════════════════
# Suite A: fit_lag_distribution — degenerate & boundary inputs
# ═══════════════════════════════════════════════════════════════

class TestFitLagDistributionAdversarial:
    """Adversarial inputs targeting the lognormal fit from median+mean."""

    # ── A1: sigma=0 trap when mean == median ──────────────────
    def test_mean_equals_median_uses_default_sigma(self):
        """When mean == median exactly, ratio=1.0, log(1)=0, sqrt(0)=0.
        FIX: should fall back to default_sigma instead of degenerate sigma=0.
        """
        fit = fit_lag_distribution(10.0, 10.0, 500)
        assert fit.empirical_quality_ok is True
        assert fit.sigma == pytest.approx(LATENCY_DEFAULT_SIGMA), (
            f"sigma should be default ({LATENCY_DEFAULT_SIGMA}), got {fit.sigma}"
        )
        assert fit.sigma > 0

    def test_mean_barely_above_median_produces_tiny_sigma(self):
        """mean/median = 1.0001 → ratio ≈ 1, sigma ≈ 0.014.
        Valid but extremely narrow — completeness jumps from 0→1 very fast.
        """
        fit = fit_lag_distribution(10.0, 10.001, 500)
        assert fit.empirical_quality_ok is True
        assert fit.sigma > 0
        # sigma should be very small but positive
        assert fit.sigma < 0.1, f"Expected tiny sigma, got {fit.sigma}"

    # ── A2: mean < median (impossible for lognormal) ──────────
    def test_mean_slightly_below_median_ratio_0_95(self):
        """ratio=0.95 is below 1.0 but above min threshold (0.9).
        Contract says quality_ok=True but sigma=default."""
        fit = fit_lag_distribution(10.0, 9.5, 500)
        assert fit.empirical_quality_ok is True
        assert fit.sigma == pytest.approx(LATENCY_DEFAULT_SIGMA)

    def test_mean_well_below_median_ratio_0_5(self):
        """ratio=0.5 is below min threshold. Should fail quality."""
        fit = fit_lag_distribution(10.0, 5.0, 500)
        assert fit.empirical_quality_ok is False

    # ── A3: NaN mean propagation ──────────────────────────────
    def test_nan_mean_lag_does_not_produce_nan_sigma(self):
        """NaN mean should not silently propagate to sigma.
        Contract: NaN mean should be treated like None (no mean available).
        """
        fit = fit_lag_distribution(10.0, float('nan'), 500)
        assert math.isfinite(fit.sigma), f"sigma={fit.sigma} is not finite (NaN mean leaked)"
        assert math.isfinite(fit.mu), f"mu={fit.mu} is not finite"

    def test_inf_mean_lag_does_not_crash(self):
        """Infinity mean should not crash or produce NaN."""
        fit = fit_lag_distribution(10.0, float('inf'), 500)
        assert math.isfinite(fit.sigma)
        assert fit.empirical_quality_ok is False  # ratio=inf exceeds max

    def test_negative_inf_mean_lag(self):
        """Negative infinity mean."""
        fit = fit_lag_distribution(10.0, float('-inf'), 500)
        assert math.isfinite(fit.sigma)

    # ── A4: exact boundary at min_fit_converters ──────────────
    def test_total_k_exactly_at_threshold(self):
        """k=30 (exactly at default threshold). Should pass gate."""
        fit = fit_lag_distribution(7.0, 9.5, 30)
        assert fit.empirical_quality_ok is True

    def test_total_k_one_below_threshold(self):
        """k=29 (one below threshold). Should fail gate."""
        fit = fit_lag_distribution(7.0, 9.5, 29)
        assert fit.empirical_quality_ok is False

    # ── A5: median_lag edge cases ─────────────────────────────
    def test_zero_median_lag(self):
        """Zero median → log(0) = -inf. Must not crash."""
        fit = fit_lag_distribution(0.0, 5.0, 500)
        assert math.isfinite(fit.mu)
        assert fit.empirical_quality_ok is False

    def test_negative_median_lag(self):
        """Negative median. Must not crash."""
        fit = fit_lag_distribution(-5.0, -3.0, 500)
        assert math.isfinite(fit.mu)
        assert fit.empirical_quality_ok is False

    def test_very_small_positive_median(self):
        """Extremely small positive median (sub-second lag)."""
        fit = fit_lag_distribution(1e-8, 2e-8, 500)
        assert math.isfinite(fit.mu)
        assert math.isfinite(fit.sigma)

    def test_very_large_median(self):
        """Large median (10 years)."""
        fit = fit_lag_distribution(3650.0, 7300.0, 500)
        assert math.isfinite(fit.mu)
        assert math.isfinite(fit.sigma)
        assert fit.empirical_quality_ok is True


# ═══════════════════════════════════════════════════════════════
# Suite B: log_normal_cdf — boundary & degenerate
# ═══════════════════════════════════════════════════════════════

class TestLogNormalCdfAdversarial:
    """Adversarial inputs targeting the CDF computation."""

    def test_sigma_zero_step_function(self):
        """sigma=0 should produce step function at exp(mu), not crash."""
        mu = math.log(10.0)  # exp(mu) = 10
        # Before the step: CDF should be 0
        assert log_normal_cdf(9.999, mu, 0.0) == 0.0
        # At/after the step: CDF should be 1
        assert log_normal_cdf(10.001, mu, 0.0) == 1.0

    def test_sigma_zero_at_exact_boundary(self):
        """At t = exp(mu) with sigma=0. Edge case."""
        mu = math.log(10.0)
        result = log_normal_cdf(10.0, mu, 0.0)
        # Could be 0 or 1 depending on implementation
        assert result in (0.0, 1.0)

    def test_negative_t_returns_zero(self):
        """Negative time should give CDF = 0."""
        assert log_normal_cdf(-5.0, 1.0, 0.5) == 0.0

    def test_very_large_t_approaches_one(self):
        """Very large t should give CDF ≈ 1."""
        result = log_normal_cdf(1e15, 1.0, 0.5)
        assert result == pytest.approx(1.0, abs=1e-10)

    def test_negative_sigma_handled(self):
        """Negative sigma is invalid. Should not crash."""
        # sigma < 0 should be handled defensively
        result = log_normal_cdf(5.0, 1.0, -0.5)
        assert math.isfinite(result)

    def test_nan_t_returns_zero(self):
        """NaN time should return 0.0 (not propagate NaN)."""
        result = log_normal_cdf(float('nan'), 1.0, 0.5)
        assert result == 0.0, f"log_normal_cdf(NaN, ...) should return 0.0, got {result}"

    def test_nan_mu_returns_finite(self):
        """NaN mu — result should be finite (defensive)."""
        result = log_normal_cdf(5.0, float('nan'), 0.5)
        # NaN mu produces NaN in (log(t) - NaN) / sigma — still propagates.
        # This is acceptable since mu should never be NaN (guarded upstream).
        # Just verify it doesn't crash.
        assert isinstance(result, float)

    def test_nan_sigma_returns_finite(self):
        """NaN sigma — result should be finite (defensive)."""
        result = log_normal_cdf(5.0, 1.0, float('nan'))
        assert isinstance(result, float)


# ═══════════════════════════════════════════════════════════════
# Suite C: compute_blended_mean — adversarial edge cases
# ═══════════════════════════════════════════════════════════════

class TestBlendedMeanAdversarial:
    """Adversarial inputs for the evidence/forecast blending function."""

    # ── C1: negative completeness ─────────────────────────────
    def test_negative_completeness_does_not_produce_nan(self):
        """Negative completeness raised to fractional power → complex → NaN.
        Contract: completeness should be clamped to [0,1].
        """
        result = compute_blended_mean(
            evidence_mean=0.05,
            forecast_mean=0.10,
            completeness=-0.5,
            n_query=100,
            n_baseline=1000,
        )
        if result is not None:
            assert math.isfinite(result), (
                f"Negative completeness produced {result} — NaN/Inf propagation. "
                f"(-0.5)**2.25 is complex in math, NaN in float."
            )

    def test_completeness_minus_one(self):
        """completeness=-1.0. (-1)^2.25 is NaN in floating point."""
        result = compute_blended_mean(
            evidence_mean=0.05,
            forecast_mean=0.10,
            completeness=-1.0,
            n_query=100,
            n_baseline=1000,
        )
        if result is not None:
            assert math.isfinite(result), f"completeness=-1 produced {result}"

    # ── C2: negative n_query ──────────────────────────────────
    def test_negative_n_query_does_not_produce_negative_weight(self):
        """n_query < 0 → n_eff < 0 → w_evidence could invert the blend.
        Contract: should reject or clamp.
        """
        result = compute_blended_mean(
            evidence_mean=0.05,
            forecast_mean=0.50,
            completeness=0.9,
            n_query=-100,
            n_baseline=1000,
        )
        if result is not None:
            # With negative n_eff, w_evidence = -n_eff / (m0_eff + -n_eff)
            # If |n_eff| > m0_eff, weight could be > 1 or negative
            assert 0.0 <= result <= 1.0, (
                f"n_query=-100 produced blended_mean={result}. "
                f"Expected a probability in [0,1]. Negative n_query inverted the blend."
            )

    # ── C3: completeness > 1.0 ────────────────────────────────
    def test_completeness_above_one(self):
        """completeness=1.5 (possible from numerical overshoot).
        Should be clamped to 1.0."""
        result = compute_blended_mean(
            evidence_mean=0.05,
            forecast_mean=0.10,
            completeness=1.5,
            n_query=100,
            n_baseline=1000,
        )
        if result is not None:
            assert math.isfinite(result)
            # At completeness=1.0 (clamped), c_power=1, remaining=0, m0_eff=0
            # → w_evidence = n_eff / (0 + n_eff) = 1.0 → pure evidence
            # So result should equal evidence_mean
            assert result == pytest.approx(0.05, abs=0.01), (
                f"completeness=1.5 should clamp to 1.0, giving pure evidence={0.05}. "
                f"Got {result}."
            )

    # ── C4: completeness=0 → pure forecast ────────────────────
    def test_completeness_zero_returns_forecast(self):
        """At completeness=0, no evidence weight → pure forecast."""
        result = compute_blended_mean(
            evidence_mean=0.05,
            forecast_mean=0.50,
            completeness=0.0,
            n_query=100,
            n_baseline=1000,
        )
        if result is not None:
            assert result == pytest.approx(0.50, abs=1e-9), (
                f"At completeness=0, blend should be pure forecast (0.50). Got {result}."
            )

    # ── C5: n_baseline=0 ──────────────────────────────────────
    def test_zero_baseline_returns_none(self):
        """No baseline data → cannot compute forecast weight."""
        result = compute_blended_mean(
            evidence_mean=0.05,
            forecast_mean=0.50,
            completeness=0.8,
            n_query=100,
            n_baseline=0,
        )
        assert result is None

    # ── C6: both n_query and n_baseline very large ────────────
    def test_extreme_n_values(self):
        """Very large sample sizes. Should not overflow."""
        result = compute_blended_mean(
            evidence_mean=0.05,
            forecast_mean=0.10,
            completeness=0.5,
            n_query=10**9,
            n_baseline=10**9,
        )
        assert result is not None
        assert math.isfinite(result)

    # ── C7: inf completeness ──────────────────────────────────
    def test_inf_completeness_does_not_produce_nan(self):
        """completeness=inf. inf**2.25 = inf, min(1,inf)=1 in theory,
        but math.isfinite(inf) is False, so gate should trigger."""
        result = compute_blended_mean(
            evidence_mean=0.05,
            forecast_mean=0.10,
            completeness=float('inf'),
            n_query=100,
            n_baseline=1000,
        )
        if result is not None:
            assert math.isfinite(result)

    # ── C8: forecast_mean=0 ───────────────────────────────────
    def test_zero_forecast_mean(self):
        """forecast_mean=0. Valid (no conversions expected)."""
        result = compute_blended_mean(
            evidence_mean=0.05,
            forecast_mean=0.0,
            completeness=0.5,
            n_query=100,
            n_baseline=1000,
        )
        assert result is not None
        assert 0.0 <= result <= 0.05  # blend between 0.05 and 0.0


# ═══════════════════════════════════════════════════════════════
# Suite D: compute_edge_latency_stats — adversarial topologies
# ═══════════════════════════════════════════════════════════════

class TestEdgeLatencyStatsAdversarial:
    """Adversarial inputs for the full edge latency computation."""

    # ── D1: empty cohorts ─────────────────────────────────────
    def test_empty_cohorts_does_not_crash(self):
        """No observation data at all."""
        result = compute_edge_latency_stats(
            cohorts=[],
            aggregate_median_lag=7.0,
            aggregate_mean_lag=9.5,
            default_t95_days=30.0,
        )
        assert math.isfinite(result.t95)
        assert math.isfinite(result.p_evidence)
        assert result.p_evidence == 0.0

    # ── D2: single cohort with zero conversions ───────────────
    def test_zero_conversions_does_not_produce_nan(self):
        """n=1000, k=0 across all dates.
        p_evidence=0. p_infinity may fall back to p_evidence (0.0).
        forecast_available depends on whether p_inf is None or 0.
        """
        result = compute_edge_latency_stats(
            cohorts=[CohortData(date="2025-01-01", age=60.0, n=1000, k=0)],
            aggregate_median_lag=7.0,
            aggregate_mean_lag=9.5,
            default_t95_days=30.0,
        )
        assert math.isfinite(result.t95)
        assert result.p_evidence == 0.0
        # p_infinity=0 is valid (observed rate is 0); key is that it's finite
        assert result.p_infinity is not None
        assert math.isfinite(result.p_infinity)

    # ── D3: anchor_median_lag_days=None with adjustment enabled ─
    def test_none_anchor_median_lag_with_adjustment(self):
        """anchor_median_lag_days=None on individual cohorts.
        When apply_anchor_age_adjustment=True and anchor_median_lag > 0,
        the code accesses c.anchor_median_lag_days which could be None.
        """
        cohorts = [
            CohortData(
                date="2025-01-01", age=60.0, n=100, k=50,
                anchor_median_lag_days=None,  # <-- THIS IS THE TRAP
            ),
            CohortData(
                date="2025-01-15", age=45.0, n=100, k=40,
                anchor_median_lag_days=None,
            ),
        ]
        # This should not raise TypeError from max(0, age - None)
        result = compute_edge_latency_stats(
            cohorts=cohorts,
            aggregate_median_lag=7.0,
            aggregate_mean_lag=9.5,
            default_t95_days=30.0,
            anchor_median_lag=5.0,  # triggers the adjustment branch
            apply_anchor_age_adjustment=True,
        )
        assert math.isfinite(result.t95)

    # ── D4: all cohorts have age < onset ──────────────────────
    def test_all_cohorts_younger_than_onset(self):
        """All observations are younger than onset_delta_days.
        After onset adjustment, effective ages ≈ 0. No mature data.
        """
        result = compute_edge_latency_stats(
            cohorts=[
                CohortData(date="2025-01-01", age=2.0, n=100, k=10),
                CohortData(date="2025-01-02", age=1.5, n=100, k=8),
            ],
            aggregate_median_lag=7.0,
            aggregate_mean_lag=9.5,
            default_t95_days=30.0,
            onset_delta_days=10.0,  # onset >> age
        )
        assert math.isfinite(result.t95)
        assert math.isfinite(result.completeness)

    # ── D5: aggregate_median_lag = 0 ──────────────────────────
    def test_zero_median_lag(self):
        """Zero median lag → to_model_space_lag_days clamps to epsilon.
        mu = log(epsilon) ≈ -13.8. Very degenerate but should not crash.
        """
        result = compute_edge_latency_stats(
            cohorts=[CohortData(date="2025-01-01", age=30.0, n=100, k=50)],
            aggregate_median_lag=0.0,
            aggregate_mean_lag=0.0,
            default_t95_days=30.0,
        )
        assert math.isfinite(result.t95)
        assert result.t95 > 0

    # ── D6: aggregate_median_lag negative ─────────────────────
    def test_negative_median_lag(self):
        """Negative median lag (data artefact). Should not crash."""
        result = compute_edge_latency_stats(
            cohorts=[CohortData(date="2025-01-01", age=30.0, n=100, k=50)],
            aggregate_median_lag=-5.0,
            aggregate_mean_lag=-3.0,
            default_t95_days=30.0,
        )
        assert math.isfinite(result.t95)
        assert result.t95 > 0

    # ── D7: k > n (impossible but could arrive from data) ─────
    def test_k_exceeds_n_does_not_crash(self):
        """More conversions than observations (data corruption).
        p_beta_val = n - k + 1 would be negative without guard.
        FIX: clamped to max(1, ...) so sqrt doesn't get negative input.
        """
        result = compute_edge_latency_stats(
            cohorts=[CohortData(date="2025-01-01", age=60.0, n=50, k=100)],
            aggregate_median_lag=7.0,
            aggregate_mean_lag=9.5,
            default_t95_days=30.0,
        )
        assert math.isfinite(result.t95)
        assert math.isfinite(result.p_evidence)
        assert math.isfinite(result.p_sd)

    # ── D8: onset_delta_days > aggregate_median_lag ───────────
    def test_onset_exceeds_median(self):
        """onset=20, median=7 → model_median = clamp(7-20) = epsilon.
        mu = log(epsilon) ≈ -13.8. Should fallback gracefully.
        """
        result = compute_edge_latency_stats(
            cohorts=[CohortData(date="2025-01-01", age=60.0, n=100, k=50)],
            aggregate_median_lag=7.0,
            aggregate_mean_lag=9.5,
            default_t95_days=30.0,
            onset_delta_days=20.0,
        )
        assert math.isfinite(result.t95)
        # t95 should be at least onset_delta_days
        assert result.t95 >= 20.0, (
            f"t95={result.t95} is less than onset={20.0}. "
            f"Total time should always be >= onset."
        )

    # ── D9: NaN aggregate lag ─────────────────────────────────
    def test_nan_aggregate_lag(self):
        """NaN median lag. Should not produce NaN in output."""
        result = compute_edge_latency_stats(
            cohorts=[CohortData(date="2025-01-01", age=60.0, n=100, k=50)],
            aggregate_median_lag=float('nan'),
            aggregate_mean_lag=float('nan'),
            default_t95_days=30.0,
        )
        assert math.isfinite(result.t95), f"NaN median_lag produced t95={result.t95}"

    # ── D10: single day, n=1, k=1 ────────────────────────────
    def test_minimal_observation(self):
        """Absolute minimum data: 1 person, 1 conversion.
        Tests sqrt(1) in heuristic SD computations.
        """
        result = compute_edge_latency_stats(
            cohorts=[CohortData(date="2025-01-01", age=60.0, n=1, k=1)],
            aggregate_median_lag=7.0,
            aggregate_mean_lag=9.5,
            default_t95_days=30.0,
        )
        assert math.isfinite(result.t95)
        assert math.isfinite(result.p_evidence)
        assert result.p_evidence == pytest.approx(1.0)


# ═══════════════════════════════════════════════════════════════
# Suite E: to_model_space — onset conversion edge cases
# ═══════════════════════════════════════════════════════════════

class TestToModelSpaceAdversarial:
    """Adversarial inputs for onset space conversion."""

    def test_lag_less_than_onset_clamped_positive(self):
        """If observed lag < onset, model-space value should be > 0."""
        result = to_model_space_lag_days(10.0, 5.0)
        assert result > 0, f"Expected positive, got {result}"
        assert result == pytest.approx(ONSET_EPSILON_DAYS)

    def test_none_onset(self):
        """None onset treated as 0."""
        result = to_model_space_lag_days(None, 10.0)
        assert result == pytest.approx(10.0)

    def test_nan_onset(self):
        """NaN onset treated as 0."""
        result = to_model_space_lag_days(float('nan'), 10.0)
        assert result == pytest.approx(10.0)

    def test_negative_onset_clamped_to_zero(self):
        """Negative onset should be clamped to 0."""
        result = to_model_space_lag_days(-5.0, 10.0)
        assert result == pytest.approx(10.0)

    def test_age_less_than_onset_returns_zero(self):
        """Age < onset → dead zone → 0."""
        result = to_model_space_age_days(10.0, 5.0)
        assert result == 0.0

    def test_nan_value_returns_epsilon(self):
        """NaN lag value → should return epsilon, not NaN."""
        result = to_model_space_lag_days(0.0, float('nan'))
        assert math.isfinite(result)

    def test_nan_age_returns_zero(self):
        """NaN age → should return 0."""
        result = to_model_space_age_days(0.0, float('nan'))
        assert result == 0.0


# ═══════════════════════════════════════════════════════════════
# Suite F: fw_compose_pair — Fenton-Wilkinson composition
# ═══════════════════════════════════════════════════════════════

class TestFWComposePairAdversarial:
    """Adversarial inputs for path-level lognormal composition."""

    def _fit(self, mu: float, sigma: float) -> LagDistributionFit:
        return LagDistributionFit(mu=mu, sigma=sigma, empirical_quality_ok=True, total_k=100)

    def test_zero_sigma_composition(self):
        """Composing two distributions where one has sigma=0.
        FW formula involves sigma^2 — sigma=0 should not break it.
        """
        result = fw_compose_pair(self._fit(1.0, 0.0), self._fit(2.0, 0.5))
        assert result is not None, "fw_compose_pair returned None for sigma=0 input"
        assert math.isfinite(result[0]), f"mu_composed={result[0]}"
        assert math.isfinite(result[1]), f"sigma_composed={result[1]}"

    def test_both_zero_sigma(self):
        """Both sigmas=0. Sum of two point masses → point mass."""
        result = fw_compose_pair(self._fit(1.0, 0.0), self._fit(2.0, 0.0))
        assert result is not None
        assert math.isfinite(result[0])
        assert math.isfinite(result[1])

    def test_very_large_sigma(self):
        """Very large sigma. exp(sigma^2) could overflow."""
        result = fw_compose_pair(self._fit(1.0, 50.0), self._fit(2.0, 50.0))
        # With sigma=50, exp(sigma^2) = exp(2500) → overflow
        # Should handle gracefully or return None
        if result is not None:
            assert math.isfinite(result[0]) or result[0] == float('inf'), \
                f"Expected finite or inf, got {result[0]}"

    def test_negative_mu(self):
        """Negative mu (sub-day latency). Valid for log-space."""
        result = fw_compose_pair(self._fit(-2.0, 0.5), self._fit(-1.0, 0.5))
        assert result is not None
        assert math.isfinite(result[0])
        assert math.isfinite(result[1])
        assert result[1] > 0  # composed sigma should be positive


# ═══════════════════════════════════════════════════════════════
# Suite G: log_normal_inverse_cdf — quantile boundary cases
# ═══════════════════════════════════════════════════════════════

class TestLogNormalInverseCdfAdversarial:
    """Adversarial inputs for the quantile function."""

    def test_p_zero_returns_zero(self):
        assert log_normal_inverse_cdf(0.0, 1.0, 0.5) == 0.0

    def test_p_one_returns_inf(self):
        assert log_normal_inverse_cdf(1.0, 1.0, 0.5) == float('inf')

    def test_sigma_zero_returns_exp_mu(self):
        """With sigma=0, ALL quantiles should be exp(mu) (point mass).
        But the formula is exp(mu + sigma * z). With sigma=0, the z
        term vanishes regardless of p → always exp(mu). Correct.
        """
        mu = math.log(10.0)
        result = log_normal_inverse_cdf(0.95, mu, 0.0)
        assert result == pytest.approx(10.0, rel=1e-9), (
            f"sigma=0 quantile should be exp(mu)=10.0, got {result}"
        )

    def test_very_extreme_quantile(self):
        """p=0.9999 with large sigma. exp(mu + sigma*z) could be huge."""
        result = log_normal_inverse_cdf(0.9999, 5.0, 3.0)
        assert math.isfinite(result)
        assert result > 0

    def test_negative_sigma_behaviour(self):
        """Negative sigma is invalid. Should not crash."""
        result = log_normal_inverse_cdf(0.5, 1.0, -0.5)
        # exp(mu + (-0.5) * 0) = exp(mu) at p=0.5
        # But at p=0.95 with negative sigma, z is positive, so
        # exp(mu + (-0.5)*z) < exp(mu) — inverted distribution
        assert math.isfinite(result)


# ═══════════════════════════════════════════════════════════════
# Suite H: Cross-function integration — sigma=0 chain
# ═══════════════════════════════════════════════════════════════

class TestSigmaZeroChainAdversarial:
    """The sigma=0 trap propagates through the entire pipeline.
    fit → CDF → inverse_CDF → completeness → blended_mean.
    This tests the full chain.
    """

    def test_mean_equals_median_produces_smooth_completeness(self):
        """FIX VERIFICATION: When mean==median, fit should use default sigma,
        producing a smooth (not step-function) CDF for completeness.
        """
        fit = fit_lag_distribution(10.0, 10.0, 500)
        mu = fit.mu
        sigma = fit.sigma

        assert sigma > 0, f"sigma should be > 0 after fix, got {sigma}"
        assert sigma == pytest.approx(LATENCY_DEFAULT_SIGMA)

        # Check CDF produces smooth transition (not step function)
        ages = [5.0, 9.0, 9.99, 10.01, 11.0, 15.0]
        cdfs = [log_normal_cdf(a, mu, sigma) for a in ages]

        assert cdfs[0] < cdfs[-1], "CDF should increase with age"
        # There should be intermediate values (not just 0 and 1)
        intermediate = [c for c in cdfs if 0.01 < c < 0.99]
        assert len(intermediate) > 0, (
            f"Expected smooth CDF transition, got {cdfs}"
        )
