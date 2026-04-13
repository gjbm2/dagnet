"""
Tests for window-mode ForecastState computation (doc 29 Phase 2).

Verifies:
- Completeness matches existing aggregate-CDF computation
- completeness_sd > 0 when latency SDs > 0
- Rate uncertainty composes p_sd and completeness_sd correctly
- Conditioned rate shrinks uncertainty as completeness → 1
- Mature-limit: tau → ∞ produces completeness → 1
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest


class TestCompletenessWithSd:
    """Completeness point estimate and SD computation."""

    def test_basic_completeness_matches_existing(self):
        """Point estimate matches forecast_application.compute_completeness."""
        from runner.forecast_state import _compute_completeness_at_age
        from runner.forecast_application import compute_completeness

        # Typical edge: mu=2.0, sigma=0.8, onset=1.0, age=30 days
        age = 30.0
        mu, sigma, onset = 2.0, 0.8, 1.0

        new = _compute_completeness_at_age(age, mu, sigma, onset)
        old = compute_completeness(age, mu, sigma, onset)

        # erfc-based vs scipy lognorm CDF differ at ~1e-8 precision
        assert abs(new - old) < 1e-6, f"new={new} old={old}"

    def test_completeness_sd_nonzero_with_dispersions(self):
        """completeness_sd > 0 when latency SDs are nonzero."""
        from runner.model_resolver import ResolvedLatency
        from runner.forecast_state import compute_completeness_with_sd

        lat = ResolvedLatency(
            mu=2.0, sigma=0.8, onset_delta_days=1.0,
            mu_sd=0.3, sigma_sd=0.1, onset_sd=0.5, onset_mu_corr=-0.2,
        )
        c, c_sd = compute_completeness_with_sd(30.0, lat)

        assert 0 < c < 1, f"completeness should be in (0,1): {c}"
        assert c_sd > 0, f"completeness_sd should be > 0: {c_sd}"
        assert c_sd < 0.5, f"completeness_sd unreasonably large: {c_sd}"

    def test_completeness_sd_zero_without_dispersions(self):
        """completeness_sd = 0 when all SDs are zero."""
        from runner.model_resolver import ResolvedLatency
        from runner.forecast_state import compute_completeness_with_sd

        lat = ResolvedLatency(
            mu=2.0, sigma=0.8, onset_delta_days=1.0,
            mu_sd=0.0, sigma_sd=0.0, onset_sd=0.0,
        )
        c, c_sd = compute_completeness_with_sd(30.0, lat)

        assert c > 0
        assert c_sd == 0.0

    def test_mature_limit_completeness_approaches_one(self):
        """At very large age, completeness → 1 regardless of params."""
        from runner.model_resolver import ResolvedLatency
        from runner.forecast_state import compute_completeness_with_sd

        lat = ResolvedLatency(
            mu=3.0, sigma=1.5, onset_delta_days=5.0,
            mu_sd=0.5, sigma_sd=0.2, onset_sd=1.0,
        )
        c, c_sd = compute_completeness_with_sd(10000.0, lat)

        assert c > 0.999, f"At age=10000, completeness should be ~1: {c}"
        assert c_sd < 0.01, f"At age=10000, SD should be tiny: {c_sd}"

    def test_zero_age_completeness_is_zero(self):
        """At age=0, completeness = 0 (no time for conversions)."""
        from runner.model_resolver import ResolvedLatency
        from runner.forecast_state import compute_completeness_with_sd

        lat = ResolvedLatency(
            mu=2.0, sigma=0.8, onset_delta_days=1.0,
            mu_sd=0.3, sigma_sd=0.1, onset_sd=0.5,
        )
        c, c_sd = compute_completeness_with_sd(0.0, lat)
        assert c == 0.0

    def test_onset_mu_corr_affects_sd(self):
        """Nonzero onset_mu_corr changes completeness_sd."""
        from runner.model_resolver import ResolvedLatency
        from runner.forecast_state import compute_completeness_with_sd

        base = dict(mu=2.0, sigma=0.8, onset_delta_days=1.0,
                    mu_sd=0.3, sigma_sd=0.1, onset_sd=0.5)

        lat_nocorr = ResolvedLatency(**base, onset_mu_corr=0.0)
        lat_corr = ResolvedLatency(**base, onset_mu_corr=-0.5)

        _, sd_nocorr = compute_completeness_with_sd(30.0, lat_nocorr)
        _, sd_corr = compute_completeness_with_sd(30.0, lat_corr)

        # They should differ (correlation changes the joint distribution)
        assert sd_nocorr != sd_corr, \
            f"onset_mu_corr should affect SD: nocorr={sd_nocorr} corr={sd_corr}"


class TestWindowForecastState:
    """Window-mode ForecastState end-to-end."""

    def _make_resolved(self, p=0.5, p_sd=0.05, mu=2.0, sigma=0.8,
                        onset=1.0, mu_sd=0.3, sigma_sd=0.1, onset_sd=0.5):
        from runner.model_resolver import ResolvedModelParams, ResolvedLatency
        return ResolvedModelParams(
            p_mean=p, p_sd=p_sd,
            alpha=p * 20, beta=(1 - p) * 20,
            edge_latency=ResolvedLatency(
                mu=mu, sigma=sigma, onset_delta_days=onset,
                mu_sd=mu_sd, sigma_sd=sigma_sd, onset_sd=onset_sd,
            ),
            source='analytic',
        )

    def test_basic_window_forecast(self):
        """Window ForecastState has all expected fields."""
        from runner.forecast_state import compute_forecast_state_window

        resolved = self._make_resolved()
        cohorts = [(30.0, 100), (20.0, 150), (10.0, 200)]

        fs = compute_forecast_state_window(
            edge_id='test-edge',
            resolved=resolved,
            cohort_ages_and_weights=cohorts,
        )

        assert fs.mode == 'window'
        assert fs.path_aware is False
        assert fs.tier == 'be_forecast'
        assert 0 < fs.completeness < 1
        assert fs.completeness_sd > 0
        assert fs.rate_unconditioned > 0
        assert fs.rate_unconditioned_sd > 0
        assert fs.dispersions is not None
        assert fs.dispersions.p_sd == 0.05

    def test_conditioned_tighter_than_unconditioned(self):
        """Evidence conditioning should reduce uncertainty."""
        from runner.forecast_state import compute_forecast_state_window

        resolved = self._make_resolved()
        cohorts = [(30.0, 100), (20.0, 150)]

        fs = compute_forecast_state_window(
            edge_id='test-edge',
            resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence_rate=0.48,
        )

        assert fs.rate_conditioned_sd <= fs.rate_unconditioned_sd, \
            f"Conditioned SD ({fs.rate_conditioned_sd}) should be ≤ " \
            f"unconditioned SD ({fs.rate_unconditioned_sd})"

    def test_high_completeness_conditioned_near_evidence(self):
        """At high completeness, conditioned rate ≈ evidence rate."""
        from runner.forecast_state import compute_forecast_state_window

        # Use params that give very high completeness at age=500
        resolved = self._make_resolved(mu=1.0, sigma=0.3, onset=0.0)
        cohorts = [(500.0, 100)]

        fs = compute_forecast_state_window(
            edge_id='test-edge',
            resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence_rate=0.45,
        )

        assert fs.completeness > 0.99, f"Expected near-1 completeness: {fs.completeness}"
        assert abs(fs.rate_conditioned - 0.45) < 0.01, \
            f"At high completeness, conditioned ≈ evidence: {fs.rate_conditioned}"

    def test_no_cohorts_returns_zero(self):
        """Empty cohort list produces zero completeness."""
        from runner.forecast_state import compute_forecast_state_window

        resolved = self._make_resolved()
        fs = compute_forecast_state_window(
            edge_id='test-edge',
            resolved=resolved,
            cohort_ages_and_weights=[],
        )

        assert fs.completeness == 0.0
        assert fs.rate_unconditioned == 0.0

    def test_resolved_params_attached(self):
        """resolved_params is attached for MC consumers."""
        from runner.forecast_state import compute_forecast_state_window

        resolved = self._make_resolved()
        fs = compute_forecast_state_window(
            edge_id='test-edge',
            resolved=resolved,
            cohort_ages_and_weights=[(30.0, 100)],
        )

        assert fs.resolved_params is resolved

    def test_rate_unconditioned_sd_combines_both_sources(self):
        """rate_unconditioned_sd reflects both p_sd and completeness_sd."""
        from runner.forecast_state import compute_forecast_state_window

        # High p_sd, low completeness_sd
        resolved_high_p = self._make_resolved(p_sd=0.1, mu_sd=0.0, sigma_sd=0.0, onset_sd=0.0)
        fs_high_p = compute_forecast_state_window(
            edge_id='test', resolved=resolved_high_p,
            cohort_ages_and_weights=[(30.0, 100)],
        )

        # Low p_sd, high completeness_sd
        resolved_high_c = self._make_resolved(p_sd=0.0, mu_sd=0.5, sigma_sd=0.2, onset_sd=0.8)
        fs_high_c = compute_forecast_state_window(
            edge_id='test', resolved=resolved_high_c,
            cohort_ages_and_weights=[(30.0, 100)],
        )

        # Both should have nonzero rate_unconditioned_sd
        assert fs_high_p.rate_unconditioned_sd > 0, "p_sd should contribute to rate SD"
        assert fs_high_c.rate_unconditioned_sd > 0, "completeness_sd should contribute to rate SD"
