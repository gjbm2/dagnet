"""
Stats engine parity contract — BE side.

Canonical test vectors with hardcoded expected values that MUST match
the FE (TypeScript) implementation. The same vectors appear in
src/services/__tests__/statsParity.contract.test.ts. If either side
drifts, its test breaks.
"""
import math
import pytest

from runner.lag_distribution_utils import (
    fit_lag_distribution,
    log_normal_cdf,
    log_normal_inverse_cdf,
    LATENCY_DEFAULT_SIGMA,
)
from runner.stats_engine import (
    compute_blended_mean,
    compute_edge_latency_stats,
    fw_compose_pair,
    CohortData,
    LagDistributionFit,
)

# ── Tolerances ───────────────────────────────────────────────────────────────
TOL = 1e-9        # mu, sigma, blended mean (pure arithmetic)
TOL_CDF = 1e-6    # CDF (FE Acklam approx vs BE scipy — ~7 decimal agreement)
TOL_T95 = 1e-4    # t95 (exp amplifies CDF approximation differences)


# ── Vector 1: fit_lag_distribution ───────────────────────────────────────────
class TestParityFitLagDistribution:
    def test_moments_fit(self):
        """median=7, mean=9.5, k=500 → mu/sigma from moments."""
        fit = fit_lag_distribution(7.0, 9.5, 500)
        assert fit.mu == pytest.approx(1.945910149055313, abs=TOL)
        assert fit.sigma == pytest.approx(0.781513467000002, abs=TOL)
        assert fit.empirical_quality_ok is True

    def test_default_sigma(self):
        """median=3, mean=None, k=500 → default sigma."""
        fit = fit_lag_distribution(3.0, None, 500)
        assert fit.mu == pytest.approx(1.098612288668110, abs=TOL)
        assert fit.sigma == pytest.approx(LATENCY_DEFAULT_SIGMA, abs=TOL)

    def test_low_k_quality_flag(self):
        """low k (k=10) → quality flag false, default sigma."""
        fit = fit_lag_distribution(7.0, 9.5, 10)
        assert fit.empirical_quality_ok is False
        assert fit.sigma == pytest.approx(LATENCY_DEFAULT_SIGMA, abs=TOL)


# ── Vector 2: log_normal_cdf ────────────────────────────────────────────────
class TestParityLogNormalCDF:
    MU = 1.945910149055313
    SIGMA = 0.781513467000002

    def test_mature_cohort(self):
        """CDF(18, mu, sigma) ≈ 0.8866."""
        assert log_normal_cdf(18, self.MU, self.SIGMA) == pytest.approx(0.886573137615063, abs=TOL_CDF)

    def test_immature_cohort(self):
        """CDF(3, mu, sigma) ≈ 0.1391."""
        assert log_normal_cdf(3, self.MU, self.SIGMA) == pytest.approx(0.139143465967953, abs=TOL_CDF)

    def test_zero(self):
        assert log_normal_cdf(0, self.MU, self.SIGMA) == 0

    def test_negative(self):
        assert log_normal_cdf(-1, self.MU, self.SIGMA) == 0


# ── Vector 3: log_normal_inverse_cdf (t95) ──────────────────────────────────
class TestParityLogNormalInverseCDF:
    def test_t95_fit1(self):
        """t95 for fit1 (median=7, mean=9.5)."""
        mu = 1.945910149055313
        sigma = 0.781513467000002
        assert log_normal_inverse_cdf(0.95, mu, sigma) == pytest.approx(25.314703926093792, abs=TOL_T95)

    def test_t95_fit2(self):
        """t95 for fit2 (median=3, default sigma)."""
        mu = 1.098612288668110
        sigma = 0.5
        assert log_normal_inverse_cdf(0.95, mu, sigma) == pytest.approx(6.828049825542952, abs=TOL_T95)

    def test_zero(self):
        assert log_normal_inverse_cdf(0, 1.0, 0.5) == 0

    def test_one(self):
        assert log_normal_inverse_cdf(1, 1.0, 0.5) == math.inf


# ── Vector 4: compute_blended_mean ───────────────────────────────────────────
class TestParityBlendedMean:
    LAMBDA = 0.15
    ETA = 2.25

    def test_moderate_completeness(self):
        """completeness=0.6."""
        result = compute_blended_mean(
            evidence_mean=0.05,
            forecast_mean=0.08,
            completeness=0.6,
            n_query=200,
            n_baseline=1000,
            forecast_blend_lambda=self.LAMBDA,
            blend_completeness_power=self.ETA,
        )
        assert result == pytest.approx(0.068537033909537, abs=TOL)

    def test_high_completeness(self):
        """completeness=0.95 → mostly evidence."""
        result = compute_blended_mean(
            evidence_mean=0.05,
            forecast_mean=0.08,
            completeness=0.95,
            n_query=200,
            n_baseline=1000,
            forecast_blend_lambda=self.LAMBDA,
            blend_completeness_power=self.ETA,
        )
        assert result == pytest.approx(0.052521182878623, abs=TOL)

    def test_zero_completeness(self):
        """completeness=0 → pure forecast."""
        result = compute_blended_mean(
            evidence_mean=0.05,
            forecast_mean=0.08,
            completeness=0.0,
            n_query=200,
            n_baseline=1000,
            forecast_blend_lambda=self.LAMBDA,
            blend_completeness_power=self.ETA,
        )
        assert result == pytest.approx(0.08, abs=TOL)

    def test_zero_baseline(self):
        """n_baseline=0 → None."""
        result = compute_blended_mean(
            evidence_mean=0.05,
            forecast_mean=0.08,
            completeness=0.6,
            n_query=200,
            n_baseline=0,
            forecast_blend_lambda=self.LAMBDA,
            blend_completeness_power=self.ETA,
        )
        assert result is None


# ── Vector 5: fw_compose_pair ────────────────────────────────────────────────
class TestParityFWCompose:
    def test_compose_two_edges(self):
        """compose(mu=1.5,sigma=0.6) + (mu=2.0,sigma=0.4) → path mu/sigma."""
        a = LagDistributionFit(mu=1.5, sigma=0.6, empirical_quality_ok=True, total_k=100)
        b = LagDistributionFit(mu=2.0, sigma=0.4, empirical_quality_ok=True, total_k=100)

        result = fw_compose_pair(a, b)
        assert result is not None

        mu_fw, sigma_fw = result
        assert mu_fw == pytest.approx(2.531031379595798, abs=TOL)
        assert sigma_fw == pytest.approx(0.352090536095916, abs=TOL)

        # path_t95 from composed distribution
        path_t95 = log_normal_inverse_cdf(0.95, mu_fw, sigma_fw)
        assert path_t95 == pytest.approx(22.424828829811858, abs=TOL_T95)


# ── Vector 6: Full pipeline — compute_edge_latency_stats ─────────────────────
# Same cohorts + params through the full edge-level pipeline must produce
# the same outputs on FE and BE.
class TestParityEdgeLatencyStats:
    COHORTS = [
        CohortData(date=f"2025-11-{d:02d}", age=float(age), n=n, k=k,
                   median_lag_days=5.0, mean_lag_days=7.0)
        for d, age, n, k in [
            (1, 60, 100, 85),
            (5, 56, 120, 98),
            (10, 51, 90, 72),
            (15, 46, 110, 82),
            (20, 41, 95, 65),
            (25, 36, 105, 60),
            (1, 31, 80, 38),
            (5, 27, 115, 42),
            (10, 22, 100, 28),
            (15, 17, 90, 15),
        ]
    ]

    def test_full_pipeline_matches_fe(self):
        """mu/sigma/t95/completeness/p_evidence/p_infinity must match FE."""
        result = compute_edge_latency_stats(
            cohorts=self.COHORTS,
            aggregate_median_lag=5.0,
            aggregate_mean_lag=7.0,
            default_t95_days=30.0,
            onset_delta_days=2.0,
            recency_half_life_days=30.0,
            apply_anchor_age_adjustment=False,
        )

        TOL_PIPELINE = 1e-4  # CDF approximation differences propagate through pipeline
        assert result.fit.mu == pytest.approx(1.0986122886681098, abs=TOL)
        assert result.fit.sigma == pytest.approx(1.0107676525947897, abs=TOL)
        assert result.fit.empirical_quality_ok is True
        assert result.t95 == pytest.approx(17.8184523080876, abs=TOL_PIPELINE)
        assert result.completeness == pytest.approx(0.9864722632086734, abs=TOL_PIPELINE)
        assert result.p_evidence == pytest.approx(0.582089552238806, abs=TOL)
        assert result.p_infinity == pytest.approx(0.5663243456570916, abs=TOL_PIPELINE)
        assert result.forecast_available is True
