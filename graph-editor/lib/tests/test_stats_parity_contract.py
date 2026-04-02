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
    compute_per_day_blended_mean,
    compute_edge_latency_stats,
    enhance_graph_latencies,
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


# ── Vector 4b: compute_per_day_blended_mean (D2 parity) ─────────────────────
class TestParityPerDayBlendedMean:
    """Per-day blending must match between FE and BE.
    Uses the same cohort vector as Vector 6 plus CDF params from its fit.
    """
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
    CDF_MU = 1.0986122886681098
    CDF_SIGMA = 1.0107676525947897

    def test_mixed_maturity_cohorts(self):
        """Per-day blend for mixed-maturity sweep must match FE."""
        result = compute_per_day_blended_mean(
            cohorts=self.COHORTS,
            forecast_mean=0.60,
            n_baseline=500,
            cdf_mu=self.CDF_MU,
            cdf_sigma=self.CDF_SIGMA,
            onset_delta_days=2.0,
        )
        assert result is not None
        blended_mean, completeness_agg = result
        assert blended_mean == pytest.approx(0.5903048161481801, abs=TOL)
        assert completeness_agg == pytest.approx(0.9864722632086734, abs=TOL_CDF)

    def test_zero_baseline(self):
        """n_baseline=0 → None."""
        result = compute_per_day_blended_mean(
            cohorts=self.COHORTS,
            forecast_mean=0.60,
            n_baseline=0,
            cdf_mu=self.CDF_MU,
            cdf_sigma=self.CDF_SIGMA,
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


# ── Vector 7: Graph-level parity — enhance_graph_latencies ──────────────────
# Same 3-edge linear graph A → B → C → D as FE Vector 7.
# Pins BE values and documents remaining delta against FE canonical values.
class TestParityGraphLevel:
    """Graph-level orchestration parity: 3-edge linear A→B→C→D."""

    @staticmethod
    def _make_cohorts(median, mean, k_ratio, n_base=100, n_days=10,
                      anchor_median=None, anchor_mean=None):
        cohorts = []
        for i in range(n_days):
            age = 30 - i * 2
            n = n_base + i * 5
            k = int(n * k_ratio)
            cohorts.append(CohortData(
                date=f"2026-03-{1+i:02d}", age=float(age), n=n, k=k,
                median_lag_days=median, mean_lag_days=mean,
                anchor_median_lag_days=anchor_median,
                anchor_mean_lag_days=anchor_mean,
            ))
        return cohorts

    # NOTE: onset_delta_days set to 0 on all edges to avoid the onset fallback
    # discrepancy (FE uses 0 when no window slices; BE reads graph value).
    GRAPH = {
        "nodes": [
            {"uuid": "a", "id": "a", "entry": {"is_start": True}, "event_id": "ev-a"},
            {"uuid": "b", "id": "b", "event_id": "ev-b"},
            {"uuid": "c", "id": "c", "event_id": "ev-c"},
            {"uuid": "d", "id": "d", "event_id": "ev-d"},
        ],
        "edges": [
            {"uuid": "e1", "from": "a", "to": "b", "p": {
                "id": "param-ab", "mean": 0.7,
                "latency": {"latency_parameter": True, "t95": 15.0, "onset_delta_days": 0.0},
                "forecast": {"mean": 0.68},
                "evidence": {"mean": 0.65, "n": 200, "k": 130},
            }},
            {"uuid": "e2", "from": "b", "to": "c", "p": {
                "id": "param-bc", "mean": 0.5,
                "latency": {"latency_parameter": True, "t95": 20.0, "onset_delta_days": 0.0},
                "forecast": {"mean": 0.48},
                "evidence": {"mean": 0.42, "n": 150, "k": 63},
            }},
            {"uuid": "e3", "from": "c", "to": "d", "p": {
                "id": "param-cd", "mean": 0.3,
                "latency": {"latency_parameter": True, "t95": 25.0, "onset_delta_days": 0.0},
            }},
        ],
    }

    def test_graph_level_parity(self):
        """BE graph-level values must match FE canonical values.

        FE canonical (from statsParity.contract.test.ts Vector 7):
          e1: mu=1.9459  sigma=0.7090  t95=22.47  c=0.9088
          e2: mu=2.3026  path_t95=46.56  path_mu=2.9131
          e3: mu=2.4849  path_t95=69.30

        KNOWN ONSET FALLBACK DISCREPANCY (flagged for discussion):
          FE derives edgeOnsetDeltaDays ONLY from window() slices, defaulting
          to 0 when none exist. BE falls back to graph-stored onset_delta_days.
          This means cohort-mode-only queries lose onset in FE but keep it in BE.
          For this test, we set graph onset to 0 so both sides agree.
        """
        param_lookup = {
            "e1": self._make_cohorts(median=7.0, mean=9.0, k_ratio=0.65),
            "e2": self._make_cohorts(median=10.0, mean=13.0, k_ratio=0.42,
                                     n_base=80, n_days=8,
                                     anchor_median=6.5, anchor_mean=8.5),
            "e3": self._make_cohorts(median=12.0, mean=15.0, k_ratio=0.28,
                                     n_base=50, n_days=6,
                                     anchor_median=14.0, anchor_mean=18.0),
        }

        result = enhance_graph_latencies(
            self.GRAPH, param_lookup,
            query_mode='cohort',
            active_edges={'e1', 'e2', 'e3'},
        )

        assert result.edges_processed == 3
        assert result.edges_with_lag == 3

        by_id = {ev.edge_uuid: ev for ev in result.edge_values}

        # BE values must match FE canonical values within rounding tolerance.
        # BE rounds: mu/sigma 4dp, t95 2dp, completeness 4dp.
        TOL_GRAPH = 0.01  # accommodates BE 2dp rounding on t95

        # e1: A → B (FE: mu=1.9459, sigma=0.7090, t95=22.47, c=0.9088)
        assert by_id["e1"].mu == pytest.approx(1.9459, abs=TOL_GRAPH)
        assert by_id["e1"].sigma == pytest.approx(0.709, abs=TOL_GRAPH)
        assert by_id["e1"].t95 == pytest.approx(22.47, abs=TOL_GRAPH)
        assert by_id["e1"].completeness == pytest.approx(0.9088, abs=TOL_GRAPH)

        # e2: B → C (FE: mu=2.3026, path_t95=46.56, path_mu=2.9131)
        assert by_id["e2"].mu == pytest.approx(2.3026, abs=TOL_GRAPH)
        assert by_id["e2"].path_t95 == pytest.approx(46.56, abs=TOL_GRAPH)
        assert by_id["e2"].path_mu == pytest.approx(2.9131, abs=TOL_GRAPH)

        # e3: C → D (FE: mu=2.4849, path_t95=69.30, c=0.3754)
        assert by_id["e3"].mu == pytest.approx(2.4849, abs=TOL_GRAPH)
        assert by_id["e3"].path_t95 == pytest.approx(69.30, abs=0.1)
        assert by_id["e3"].completeness == pytest.approx(0.3754, abs=TOL_GRAPH)
