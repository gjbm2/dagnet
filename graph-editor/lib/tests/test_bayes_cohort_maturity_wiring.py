"""
Integration test: Bayes posterior → cohort maturity chart curve params.

Asserts on the FINAL OUTPUT (curve params returned to the chart), not on
intermediate values. Catches any break in the chain from posterior on the
graph edge through to the rendered curve points.

Mocks: query_snapshots_for_sweep (external DB).
Real: _read_edge_model_params, _resolve_completeness_params, curve generation,
      per-source curve generation — the full handler pipeline.
"""
import math
import pytest
from unittest.mock import patch
from datetime import date

# ── Fixtures ──────────────────────────────────────────────────────────────────

# Known posterior values — deliberately different from the flat/analytic values
# so that reading from the wrong source produces a visibly wrong assertion.
EDGE_UUID = "test-edge-uuid-1234"
EDGE_ID = "test-from-to-test-to"

# Stale analytic (flat) values — must NOT appear in bayesian curve output
ANALYTIC_MU = 2.0
ANALYTIC_SIGMA = 0.4
ANALYTIC_ONSET = 8.0
ANALYTIC_PATH_MU = 2.5
ANALYTIC_PATH_SIGMA = 0.35
ANALYTIC_PATH_ONSET = 10.0

# Posterior edge-level (window) — from MCMC
POSTERIOR_MU = 1.3
POSTERIOR_SIGMA = 0.7
POSTERIOR_ONSET = 4.4

# Posterior path-level (cohort) — from MCMC
POSTERIOR_PATH_MU = -0.4
POSTERIOR_PATH_SIGMA = 3.0
POSTERIOR_PATH_ONSET = 17.0

# Probability posteriors
WINDOW_ALPHA = 12.0
WINDOW_BETA = 3.0
COHORT_ALPHA = 100.0
COHORT_BETA = 20.0
WINDOW_P = WINDOW_ALPHA / (WINDOW_ALPHA + WINDOW_BETA)   # 0.8
COHORT_P = COHORT_ALPHA / (COHORT_ALPHA + COHORT_BETA)   # 0.833


def _make_graph():
    """Build a graph with one edge carrying both flat and posterior latency."""
    return {
        "nodes": [
            {"id": "from-node", "uuid": "from-uuid"},
            {"id": "to-node", "uuid": "to-uuid"},
        ],
        "edges": [{
            "id": EDGE_ID,
            "uuid": EDGE_UUID,
            "from": "from-uuid",
            "to": "to-uuid",
            "p": {
                "mean": 0.75,
                "forecast": {"mean": 0.76},
                "model_vars": [
                    {
                        "source": "analytic",
                        "probability": {"mean": 0.76, "stdev": 0.02},
                        "latency": {
                            "mu": ANALYTIC_MU,
                            "sigma": ANALYTIC_SIGMA,
                            "t95": 20.0,
                            "onset_delta_days": ANALYTIC_ONSET,
                            "path_mu": ANALYTIC_PATH_MU,
                            "path_sigma": ANALYTIC_PATH_SIGMA,
                            "path_t95": 30.0,
                            "path_onset_delta_days": ANALYTIC_PATH_ONSET,
                        },
                    },
                    {
                        "source": "bayesian",
                        "probability": {"mean": WINDOW_P, "stdev": 0.05},
                        "quality": {"rhat": 1.001, "ess": 5000, "divergences": 0, "gate_passed": True},
                        "latency": {
                            "mu": POSTERIOR_MU,
                            "sigma": POSTERIOR_SIGMA,
                            "t95": 15.0,
                            "onset_delta_days": POSTERIOR_ONSET,
                            "path_mu": POSTERIOR_PATH_MU,
                            "path_sigma": POSTERIOR_PATH_SIGMA,
                            "path_t95": 40.0,
                            # path_onset_delta_days intentionally omitted —
                            # reproduces pre-fix state where bayesPatchService
                            # didn't write it. Handler must fall back to
                            # posterior.
                        },
                    },
                ],
                "latency": {
                    # Flat fields — stale analytic values
                    "mu": ANALYTIC_MU,
                    "sigma": ANALYTIC_SIGMA,
                    "onset_delta_days": ANALYTIC_ONSET,
                    "path_mu": ANALYTIC_PATH_MU,
                    "path_sigma": ANALYTIC_PATH_SIGMA,
                    "path_onset_delta_days": ANALYTIC_PATH_ONSET,
                    "t95": 20.0,
                    "path_t95": 30.0,
                    "latency_parameter": True,
                    # Posterior — authoritative MCMC output
                    "posterior": {
                        "distribution": "lognormal",
                        "mu_mean": POSTERIOR_MU,
                        "mu_sd": 0.05,
                        "sigma_mean": POSTERIOR_SIGMA,
                        "sigma_sd": 0.03,
                        "onset_delta_days": POSTERIOR_ONSET,
                        "onset_mean": POSTERIOR_ONSET,
                        "onset_sd": 0.2,
                        "onset_mu_corr": -0.88,
                        "path_mu_mean": POSTERIOR_PATH_MU,
                        "path_mu_sd": 0.15,
                        "path_sigma_mean": POSTERIOR_PATH_SIGMA,
                        "path_sigma_sd": 0.05,
                        "path_onset_delta_days": POSTERIOR_PATH_ONSET,
                        "path_onset_sd": 0.2,
                    },
                },
                "posterior": {
                    "distribution": "beta",
                    "alpha": WINDOW_ALPHA,
                    "beta": WINDOW_BETA,
                    "path_alpha": COHORT_ALPHA,
                    "path_beta": COHORT_BETA,
                },
            },
        }],
    }


def _make_snapshot_rows(n_cohorts=5, n_retrievals=3):
    """Synthetic snapshot rows so derive_cohort_maturity returns frames."""
    rows = []
    for c in range(n_cohorts):
        anchor = f"2026-02-{1 + c:02d}"
        for r in range(n_retrievals):
            age = 7 * (r + 1)
            ret_date = f"2026-02-{1 + c + age:02d}" if (1 + c + age) <= 28 else f"2026-03-{1 + c + age - 28:02d}"
            y = int(80 * (1 - math.exp(-0.1 * age)))
            rows.append({
                "param_id": "test-param",
                "core_hash": "testhash",
                "slice_key": "cohort()",
                "anchor_day": anchor,
                "retrieved_at": f"{ret_date}T12:00:00+00:00",
                "a": 1000,
                "x": 100,
                "y": y,
                "median_lag_days": None,
                "mean_lag_days": None,
                "onset_delta_days": None,
            })
    return rows


def _make_request(graph, query_dsl="cohort(1-Feb-26:21-Feb-26)"):
    """Build a handler request with snapshot subjects."""
    return {
        "scenarios": [{
            "scenario_id": "current",
            "name": "Current",
            "graph": graph,
            "visibility_mode": "f+e",
            "snapshot_subjects": [{
                "subject_id": "test-subject",
                "param_id": "test-param",
                "core_hash": "testhash",
                "slice_keys": ["cohort()"] if "cohort" in query_dsl else ["window()"],
                "anchor_from": "2026-02-01",
                "anchor_to": "2026-02-21",
                "sweep_from": "2026-02-08",
                "sweep_to": "2026-03-29",
                "read_mode": "cohort_maturity",
                "target": {"targetId": EDGE_UUID},
                "from_node": "from-node",
                "to_node": "to-node",
            }],
        }],
        "query_dsl": query_dsl,
        "analysis_type": "cohort_maturity",
    }


def _call_handler(request):
    """Call the handler with mocked DB, return the per-subject result."""
    from api_handlers import handle_runner_analyze
    rows = _make_snapshot_rows()

    with patch("snapshot_service.query_snapshots_for_sweep", return_value=rows):
        raw = handle_runner_analyze(request)

    # Navigate to the per-subject result
    scenarios = raw.get("scenarios", [])
    if scenarios:
        subjects = scenarios[0].get("subjects", [])
        if subjects:
            return subjects[0].get("result", {})
    # Fallback: flattened response
    return raw.get("result") or raw


# ── Tests ─────────────────────────────────────────────────────────────────────

class TestCohortModeCurveParams:
    """Cohort mode: all curves must use posterior PATH-level values."""

    def _get_result(self):
        graph = _make_graph()
        request = _make_request(graph, query_dsl="cohort(1-Feb-26:21-Feb-26)")
        return _call_handler(request)

    def test_promoted_curve_uses_posterior_path_onset(self):
        """Promoted model curve onset must be posterior path onset (17.0), not analytic (8.0) or edge (4.4)."""
        result = self._get_result()
        params = result.get("model_curve_params", {})
        assert params.get("onset_delta_days") == pytest.approx(POSTERIOR_PATH_ONSET, abs=0.01), \
            f"Expected posterior path onset {POSTERIOR_PATH_ONSET}, got {params.get('onset_delta_days')}"

    def test_promoted_curve_uses_posterior_path_mu(self):
        """Promoted model curve mu must be posterior path mu (-0.4), not analytic (2.5)."""
        result = self._get_result()
        params = result.get("model_curve_params", {})
        assert params.get("mu") == pytest.approx(POSTERIOR_PATH_MU, abs=0.01), \
            f"Expected posterior path mu {POSTERIOR_PATH_MU}, got {params.get('mu')}"

    def test_promoted_curve_uses_posterior_path_sigma(self):
        """Promoted model curve sigma must be posterior path sigma (3.0), not analytic (0.35)."""
        result = self._get_result()
        params = result.get("model_curve_params", {})
        assert params.get("sigma") == pytest.approx(POSTERIOR_PATH_SIGMA, abs=0.01), \
            f"Expected posterior path sigma {POSTERIOR_PATH_SIGMA}, got {params.get('sigma')}"

    def test_promoted_curve_uses_cohort_p(self):
        """Promoted model curve forecast_mean must be cohort p (0.833), not window p (0.8)."""
        result = self._get_result()
        params = result.get("model_curve_params", {})
        assert params.get("forecast_mean") == pytest.approx(COHORT_P, abs=0.01), \
            f"Expected cohort p {COHORT_P}, got {params.get('forecast_mean')}"

    def test_promoted_curve_is_zero_before_path_onset(self):
        """Model curve must be zero before onset (17d) — catches wrong onset source."""
        result = self._get_result()
        curve = result.get("model_curve", [])
        assert len(curve) > 0, "No model curve points"
        points_before_onset = [p for p in curve if p["tau_days"] <= 15]
        for p in points_before_onset:
            assert p["model_rate"] == pytest.approx(0.0, abs=0.001), \
                f"Expected rate=0 at tau={p['tau_days']} (before onset {POSTERIOR_PATH_ONSET}), got {p['model_rate']}"

    def test_promoted_curve_rises_after_path_onset(self):
        """Model curve must be positive after onset — catches missing curve generation."""
        result = self._get_result()
        curve = result.get("model_curve", [])
        points_after_onset = [p for p in curve if p["tau_days"] >= 20]
        assert any(p["model_rate"] > 0.01 for p in points_after_onset), \
            f"Expected rising curve after onset {POSTERIOR_PATH_ONSET}, but all points near zero"

    def test_bayesian_source_curve_uses_posterior_path_onset(self):
        """Bayesian per-source curve onset must be posterior path onset (17.0), not edge (4.4)."""
        result = self._get_result()
        src_curves = result.get("source_model_curves", {})
        bayes = src_curves.get("bayesian", {})
        params = bayes.get("params", {})
        assert params.get("onset_delta_days") == pytest.approx(POSTERIOR_PATH_ONSET, abs=0.01), \
            f"Expected bayesian source onset {POSTERIOR_PATH_ONSET}, got {params.get('onset_delta_days')}"

    def test_bayesian_source_curve_uses_posterior_path_mu(self):
        """Bayesian per-source curve mu must be posterior path mu (-0.4), not edge (1.3)."""
        result = self._get_result()
        src_curves = result.get("source_model_curves", {})
        bayes = src_curves.get("bayesian", {})
        params = bayes.get("params", {})
        assert params.get("mu") == pytest.approx(POSTERIOR_PATH_MU, abs=0.01), \
            f"Expected bayesian source mu {POSTERIOR_PATH_MU}, got {params.get('mu')}"

    def test_bayesian_source_curve_uses_cohort_p(self):
        """Bayesian per-source curve p must be cohort p (0.833), not window p (0.8)."""
        result = self._get_result()
        src_curves = result.get("source_model_curves", {})
        bayes = src_curves.get("bayesian", {})
        params = bayes.get("params", {})
        assert params.get("forecast_mean") == pytest.approx(COHORT_P, abs=0.01), \
            f"Expected bayesian source cohort p {COHORT_P}, got {params.get('forecast_mean')}"

    def test_analytic_source_curve_uses_analytic_path_values(self):
        """Analytic per-source curve must use analytic path values, not posterior."""
        result = self._get_result()
        src_curves = result.get("source_model_curves", {})
        analytic = src_curves.get("analytic", {})
        params = analytic.get("params", {})
        assert params.get("onset_delta_days") == pytest.approx(ANALYTIC_PATH_ONSET, abs=0.01), \
            f"Expected analytic path onset {ANALYTIC_PATH_ONSET}, got {params.get('onset_delta_days')}"

    def test_mode_is_cohort_path(self):
        """Promoted curve mode must be 'cohort_path' when query is cohort."""
        result = self._get_result()
        params = result.get("model_curve_params", {})
        assert params.get("mode") == "cohort_path"


class TestWindowModeCurveParams:
    """Window mode: all curves must use posterior EDGE-level values."""

    def _get_result(self):
        graph = _make_graph()
        request = _make_request(graph, query_dsl="window(1-Feb-26:21-Feb-26)")
        return _call_handler(request)

    def test_promoted_curve_uses_posterior_edge_onset(self):
        """Window mode: promoted curve onset must be posterior edge onset (4.4), not analytic (8.0)."""
        result = self._get_result()
        params = result.get("model_curve_params", {})
        assert params.get("onset_delta_days") == pytest.approx(POSTERIOR_ONSET, abs=0.01), \
            f"Expected posterior edge onset {POSTERIOR_ONSET}, got {params.get('onset_delta_days')}"

    def test_promoted_curve_uses_posterior_edge_mu(self):
        """Window mode: promoted curve mu must be posterior edge mu (1.3), not analytic (2.0)."""
        result = self._get_result()
        params = result.get("model_curve_params", {})
        assert params.get("mu") == pytest.approx(POSTERIOR_MU, abs=0.01), \
            f"Expected posterior edge mu {POSTERIOR_MU}, got {params.get('mu')}"

    def test_promoted_curve_uses_window_p(self):
        """Window mode: promoted curve p must be window p (0.8), not cohort p (0.833)."""
        result = self._get_result()
        params = result.get("model_curve_params", {})
        assert params.get("forecast_mean") == pytest.approx(WINDOW_P, abs=0.01), \
            f"Expected window p {WINDOW_P}, got {params.get('forecast_mean')}"

    def test_bayesian_source_curve_uses_posterior_edge_onset(self):
        """Window mode: bayesian source curve onset must be posterior edge onset (4.4)."""
        result = self._get_result()
        src_curves = result.get("source_model_curves", {})
        bayes = src_curves.get("bayesian", {})
        params = bayes.get("params", {})
        assert params.get("onset_delta_days") == pytest.approx(POSTERIOR_ONSET, abs=0.01), \
            f"Expected bayesian source edge onset {POSTERIOR_ONSET}, got {params.get('onset_delta_days')}"

    def test_bayesian_source_curve_uses_posterior_edge_mu(self):
        """Window mode: bayesian source curve mu must be posterior edge mu (1.3)."""
        result = self._get_result()
        src_curves = result.get("source_model_curves", {})
        bayes = src_curves.get("bayesian", {})
        params = bayes.get("params", {})
        assert params.get("mu") == pytest.approx(POSTERIOR_MU, abs=0.01), \
            f"Expected bayesian source edge mu {POSTERIOR_MU}, got {params.get('mu')}"

    def test_mode_is_window(self):
        """Promoted curve mode must be 'window' when query is window."""
        result = self._get_result()
        params = result.get("model_curve_params", {})
        assert params.get("mode") == "window"


class TestNoPosteriorFallback:
    """When no posterior exists, curves must fall back to flat latency fields."""

    def _get_result(self):
        graph = _make_graph()
        # Remove posterior from the edge
        edge = graph["edges"][0]
        del edge["p"]["latency"]["posterior"]
        del edge["p"]["posterior"]
        request = _make_request(graph, query_dsl="cohort(1-Feb-26:21-Feb-26)")
        return _call_handler(request)

    def test_falls_back_to_flat_path_onset(self):
        """Without posterior, promoted curve uses flat path_onset (10.0)."""
        result = self._get_result()
        params = result.get("model_curve_params", {})
        assert params.get("onset_delta_days") == pytest.approx(ANALYTIC_PATH_ONSET, abs=0.01), \
            f"Expected flat path onset {ANALYTIC_PATH_ONSET}, got {params.get('onset_delta_days')}"

    def test_falls_back_to_flat_path_mu(self):
        """Without posterior, promoted curve uses flat path_mu (2.5)."""
        result = self._get_result()
        params = result.get("model_curve_params", {})
        assert params.get("mu") == pytest.approx(ANALYTIC_PATH_MU, abs=0.01), \
            f"Expected flat path mu {ANALYTIC_PATH_MU}, got {params.get('mu')}"
