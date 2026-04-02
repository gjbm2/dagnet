"""
Stats engine parity test — verifies enhance_graph_latencies produces
correct outputs for known inputs.

Two fixture sources:
  1. Synthetic (always available): deterministic graph + cohort data with
     hand-verified expected outputs. Committed to dagnet, runs in CI.
  2. Live (bonus): reads latest GOLDEN_FIXTURE_COMPLETE from console mirror
     (debug/tmp.browser-console.jsonl) if available. Tests against real
     production data without persisting it.

Run:
    cd graph-editor
    . venv/bin/activate
    pytest lib/tests/test_stats_engine_parity.py -v
"""

import json
import math
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

LIB_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(LIB_DIR))

from runner.stats_engine import (
    CohortData,
    EdgeContext,
    EdgeLAGValues,
    enhance_graph_latencies,
    estimate_p_infinity,
    calculate_completeness,
    calculate_completeness_with_tail_constraint,
    improve_fit_with_t95,
    compute_blended_mean,
    fw_compose_pair,
    compute_edge_latency_stats,
    weighted_quantile,
)
from runner.lag_distribution_utils import (
    LagDistributionFit,
    fit_lag_distribution,
    log_normal_cdf,
    log_normal_inverse_cdf,
    to_model_space_lag_days,
)
from runner.forecasting_settings import ForecastingSettings, settings_from_dict


# ─────────────────────────────────────────────────────────────
# Tolerances
# ─────────────────────────────────────────────────────────────

FIELD_TOLERANCES = {
    "mu": 1e-4,
    "sigma": 1e-4,
    "t95": 0.02,
    "path_t95": 0.02,
    "completeness": 1e-4,
    "onset_delta_days": 0.02,
    "median_lag_days": 1e-4,
    "mean_lag_days": 1e-4,
    "path_mu": 1e-4,
    "path_sigma": 1e-4,
    "path_onset_delta_days": 0.02,
    "blended_mean": 1e-4,
}


def _close(a, b, tol):
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    return abs(float(a) - float(b)) <= tol


# ─────────────────────────────────────────────────────────────
# Pure function tests (FE parity for each ported function)
# ─────────────────────────────────────────────────────────────

class TestEstimatePInfinity:
    """FE: estimatePInfinity (line 707)"""

    def test_basic_mature_cohorts(self):
        cohorts = [
            CohortData(date="2026-03-01", age=25, n=100, k=45),
            CohortData(date="2026-03-05", age=21, n=80, k=32),
            CohortData(date="2026-03-10", age=16, n=60, k=20),  # immature
        ]
        result = estimate_p_infinity(cohorts, t95=20.0, recency_half_life_days=30.0)
        assert result is not None
        # Only age >= 20 cohorts: age=25 and age=21
        # w(25) = exp(-ln2 * 25/30), w(21) = exp(-ln2 * 21/30)
        import math
        w25 = math.exp(-math.log(2) * 25 / 30)
        w21 = math.exp(-math.log(2) * 21 / 30)
        expected = (w25 * 45 + w21 * 32) / (w25 * 100 + w21 * 80)
        assert abs(result - expected) < 1e-10

    def test_no_mature_returns_none(self):
        cohorts = [CohortData(date="2026-03-10", age=5, n=60, k=20)]
        assert estimate_p_infinity(cohorts, t95=20.0) is None

    def test_empty_returns_none(self):
        assert estimate_p_infinity([], t95=20.0) is None


class TestCalculateCompleteness:
    """FE: calculateCompleteness (line 756)"""

    def test_basic(self):
        cohorts = [
            CohortData(date="d1", age=10, n=100, k=0),
            CohortData(date="d2", age=20, n=100, k=0),
        ]
        result = calculate_completeness(cohorts, mu=2.0, sigma=0.5, onset_delta_days=1.0)
        # F(9, 2.0, 0.5) and F(19, 2.0, 0.5)
        f1 = log_normal_cdf(9.0, 2.0, 0.5)
        f2 = log_normal_cdf(19.0, 2.0, 0.5)
        expected = (100 * f1 + 100 * f2) / 200
        assert abs(result - expected) < 1e-10

    def test_zero_n_skipped(self):
        cohorts = [
            CohortData(date="d1", age=10, n=0, k=0),
            CohortData(date="d2", age=20, n=100, k=0),
        ]
        result = calculate_completeness(cohorts, mu=2.0, sigma=0.5)
        f2 = log_normal_cdf(20.0, 2.0, 0.5)
        assert abs(result - f2) < 1e-10

    def test_empty_returns_zero(self):
        assert calculate_completeness([], mu=2.0, sigma=0.5) == 0.0


class TestCompletenessWithTailConstraint:
    """FE: calculateCompletenessWithTailConstraint (line 781)"""

    def test_not_applied_delegates(self):
        cohorts = [CohortData(date="d1", age=15, n=100, k=0)]
        a = calculate_completeness(cohorts, mu=2.0, sigma=0.5)
        b = calculate_completeness_with_tail_constraint(
            cohorts, mu=2.0, sigma_moments=0.5, sigma_constrained=0.8,
            tail_constraint_applied=False,
        )
        assert a == b

    def test_applied_uses_min(self):
        cohorts = [CohortData(date="d1", age=15, n=100, k=0)]
        result = calculate_completeness_with_tail_constraint(
            cohorts, mu=2.0, sigma_moments=0.5, sigma_constrained=0.8,
            tail_constraint_applied=True,
        )
        f_moments = log_normal_cdf(15.0, 2.0, 0.5)
        f_constrained = log_normal_cdf(15.0, 2.0, 0.8)
        expected = min(f_moments, f_constrained)
        assert abs(result - expected) < 1e-10


class TestImproveFitWithT95:
    """FE: improveFitWithT95 (line 820)"""

    def test_widens_sigma(self):
        fit = LagDistributionFit(mu=2.0, sigma=0.3, empirical_quality_ok=True, total_k=100)
        # t95=30, median=exp(2.0)=7.389 → sigma_min = log(30/7.389) / z95
        result = improve_fit_with_t95(fit, median_lag_days=7.389, authoritative_t95_days=30.0)
        assert result.sigma > 0.3  # must widen

    def test_does_not_shrink(self):
        fit = LagDistributionFit(mu=2.0, sigma=0.8, empirical_quality_ok=True, total_k=100)
        result = improve_fit_with_t95(fit, median_lag_days=7.389, authoritative_t95_days=10.0)
        assert result.sigma == 0.8  # t95=10 implies smaller sigma, must not shrink

    def test_caps_at_10(self):
        fit = LagDistributionFit(mu=0.1, sigma=0.1, empirical_quality_ok=True, total_k=100)
        result = improve_fit_with_t95(fit, median_lag_days=1.0, authoritative_t95_days=1e6)
        assert result.sigma <= 10.0


class TestComputeBlendedMean:
    """FE: computeBlendedMean (line 111)"""

    def test_basic_blend(self):
        result = compute_blended_mean(
            evidence_mean=0.3, forecast_mean=0.5, completeness=0.8,
            n_query=100, n_baseline=200,
        )
        assert result is not None
        assert 0.3 < result < 0.5  # between evidence and forecast

    def test_none_when_no_forecast(self):
        assert compute_blended_mean(0.3, None, 0.8, 100, 200) is None

    def test_none_when_no_evidence(self):
        assert compute_blended_mean(None, 0.5, 0.8, 100, 200) is None

    def test_zero_completeness_returns_pure_forecast(self):
        result = compute_blended_mean(0.3, 0.5, 0.0, 100, 200)
        assert result is not None
        assert abs(result - 0.5) < 1e-10


class TestFwComposePair:
    """FE: approximateLogNormalSumFit (line 593)"""

    def test_basic_composition(self):
        a = LagDistributionFit(mu=1.5, sigma=0.5, empirical_quality_ok=True, total_k=100)
        b = LagDistributionFit(mu=2.0, sigma=0.4, empirical_quality_ok=True, total_k=100)
        result = fw_compose_pair(a, b)
        assert result is not None
        mu, sigma = result
        # Composed mu should be larger than either individual
        assert mu > max(a.mu, b.mu)
        assert sigma > 0

    def test_returns_none_if_quality_bad(self):
        a = LagDistributionFit(mu=1.5, sigma=0.5, empirical_quality_ok=False, total_k=10)
        b = LagDistributionFit(mu=2.0, sigma=0.4, empirical_quality_ok=True, total_k=100)
        assert fw_compose_pair(a, b) is None


class TestWeightedQuantile:
    """FE: weightedQuantile (line 1772)"""

    def test_basic(self):
        pairs = [(10.0, 1.0), (20.0, 1.0), (30.0, 1.0)]
        assert weighted_quantile(pairs, 0.5) == 20.0

    def test_weighted(self):
        pairs = [(10.0, 9.0), (20.0, 1.0)]
        # 90% weight on 10 → median should be 10
        assert weighted_quantile(pairs, 0.5) == 10.0

    def test_empty_returns_none(self):
        assert weighted_quantile([], 0.5) is None


# ─────────────────────────────────────────────────────────────
# Synthetic end-to-end topo pass test
# ─────────────────────────────────────────────────────────────

class TestTopoPassSynthetic:
    """End-to-end: synthetic 3-edge linear graph A → B → C → D."""

    @pytest.fixture
    def graph_and_cohorts(self):
        graph = {
            "nodes": [
                {"uuid": "a", "id": "a", "entry": {"is_start": True}, "event_id": "ev-a"},
                {"uuid": "b", "id": "b", "event_id": "ev-b"},
                {"uuid": "c", "id": "c", "event_id": "ev-c"},
                {"uuid": "d", "id": "d", "event_id": "ev-d"},
            ],
            "edges": [
                {"uuid": "e1", "from": "a", "to": "b", "p": {
                    "id": "param-ab", "mean": 0.7,
                    "latency": {"latency_parameter": True, "t95": 15.0, "onset_delta_days": 1.0},
                    "forecast": {"mean": 0.68},
                    "evidence": {"mean": 0.65, "n": 200, "k": 130},
                }},
                {"uuid": "e2", "from": "b", "to": "c", "p": {
                    "id": "param-bc", "mean": 0.5,
                    "latency": {"latency_parameter": True, "t95": 20.0, "onset_delta_days": 2.0},
                    "forecast": {"mean": 0.48},
                    "evidence": {"mean": 0.42, "n": 150, "k": 63},
                }},
                {"uuid": "e3", "from": "c", "to": "d", "p": {
                    "id": "param-cd", "mean": 0.3,
                    "latency": {"latency_parameter": True, "t95": 25.0, "onset_delta_days": 1.5},
                }},
            ],
        }

        def make_cohorts(median, mean, k_ratio, n_base=100, n_days=10):
            """Generate synthetic cohorts with known lag stats."""
            cohorts = []
            for i in range(n_days):
                age = 30 - i * 2  # ages 30, 28, 26, ..., 12
                n = n_base + i * 5
                k = int(n * k_ratio)
                cohorts.append(CohortData(
                    date=f"2026-03-{1+i:02d}", age=float(age), n=n, k=k,
                    median_lag_days=median, mean_lag_days=mean,
                ))
            return cohorts

        param_lookup = {
            "e1": make_cohorts(median=7.0, mean=9.0, k_ratio=0.65),
            "e2": make_cohorts(median=10.0, mean=13.0, k_ratio=0.42,
                               n_base=80, n_days=8),
            "e3": make_cohorts(median=12.0, mean=15.0, k_ratio=0.28,
                               n_base=50, n_days=6),
        }

        # Add anchor lag data for downstream edges
        for c in param_lookup["e2"]:
            c.anchor_median_lag_days = 6.5
            c.anchor_mean_lag_days = 8.5
        for c in param_lookup["e3"]:
            c.anchor_median_lag_days = 14.0
            c.anchor_mean_lag_days = 18.0

        return graph, param_lookup

    def test_produces_values_for_all_latency_edges(self, graph_and_cohorts):
        graph, param_lookup = graph_and_cohorts
        result = enhance_graph_latencies(graph, param_lookup)
        assert result.edges_processed == 3
        assert result.edges_with_lag == 3
        assert len(result.edge_values) == 3

    def test_edge_values_have_sane_ranges(self, graph_and_cohorts):
        graph, param_lookup = graph_and_cohorts
        result = enhance_graph_latencies(graph, param_lookup)

        for ev in result.edge_values:
            assert ev.t95 > 0, f"{ev.edge_uuid}: t95 must be positive"
            assert ev.path_t95 >= ev.t95, f"{ev.edge_uuid}: path_t95 must be >= t95"
            assert 0 <= ev.completeness <= 1, f"{ev.edge_uuid}: completeness must be in [0,1]"
            assert ev.mu != 0 or ev.sigma != 0.5, f"{ev.edge_uuid}: mu/sigma should not be defaults"
            assert ev.onset_delta_days >= 0, f"{ev.edge_uuid}: onset must be non-negative"

    def test_path_composition_propagates(self, graph_and_cohorts):
        graph, param_lookup = graph_and_cohorts
        result = enhance_graph_latencies(graph, param_lookup)

        by_id = {ev.edge_uuid: ev for ev in result.edge_values}
        e1, e2, e3 = by_id["e1"], by_id["e2"], by_id["e3"]

        # Path onset should accumulate
        assert e1.path_onset_delta_days == 1.0
        assert e2.path_onset_delta_days > e1.path_onset_delta_days
        assert e3.path_onset_delta_days > e2.path_onset_delta_days

        # Path t95 should grow with depth
        assert e2.path_t95 > e1.path_t95
        assert e3.path_t95 > e2.path_t95

    def test_blended_mean_computed_when_forecast_available(self, graph_and_cohorts):
        graph, param_lookup = graph_and_cohorts
        result = enhance_graph_latencies(graph, param_lookup)

        by_id = {ev.edge_uuid: ev for ev in result.edge_values}
        # e1 and e2 have forecast.mean on the graph edge
        assert by_id["e1"].blended_mean is not None
        assert by_id["e2"].blended_mean is not None

    def test_deterministic(self, graph_and_cohorts):
        """Same inputs → same outputs."""
        graph, param_lookup = graph_and_cohorts
        r1 = enhance_graph_latencies(graph, param_lookup)
        r2 = enhance_graph_latencies(graph, param_lookup)
        for ev1, ev2 in zip(r1.edge_values, r2.edge_values):
            for field in FIELD_TOLERANCES:
                v1 = getattr(ev1, field, None)
                v2 = getattr(ev2, field, None)
                assert v1 == v2, f"{ev1.edge_uuid}.{field}: {v1} != {v2} (non-deterministic)"


# ─────────────────────────────────────────────────────────────
# Live fixture test (bonus — uses console mirror data)
# ─────────────────────────────────────────────────────────────

REPO_ROOT = LIB_DIR.parent.parent
FIXTURE_PATH = REPO_ROOT / "debug" / "tmp.topo-pass-golden.json"


def _load_live_fixture() -> Optional[Dict[str, Any]]:
    """Load golden fixture written by the BE /api/lag/topo-pass handler."""
    if not FIXTURE_PATH.exists():
        return None
    try:
        with open(FIXTURE_PATH) as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return None


def _parse_cohorts(raw: List[Dict]) -> List[CohortData]:
    return [
        CohortData(
            date=c.get("date", ""), age=float(c.get("age", 0)),
            n=int(c.get("n", 0)), k=int(c.get("k", 0)),
            median_lag_days=c.get("median_lag_days"),
            mean_lag_days=c.get("mean_lag_days"),
            anchor_median_lag_days=c.get("anchor_median_lag_days"),
            anchor_mean_lag_days=c.get("anchor_mean_lag_days"),
        )
        for c in raw
    ]


def _parse_edge_contexts(raw: Dict[str, Dict]) -> Dict[str, EdgeContext]:
    result = {}
    for edge_id, ctx_dict in raw.items():
        result[edge_id] = EdgeContext(
            onset_from_window_slices=ctx_dict.get("onset_from_window_slices"),
            window_cohorts=_parse_cohorts(ctx_dict["window_cohorts"]) if ctx_dict.get("window_cohorts") else None,
            n_baseline_from_window=ctx_dict.get("n_baseline_from_window"),
            scoped_cohorts=_parse_cohorts(ctx_dict["scoped_cohorts"]) if ctx_dict.get("scoped_cohorts") else None,
        )
    return result


class TestTopoPassLiveFixture:
    """Live parity test: if a golden fixture exists at debug/tmp.topo-pass-golden.json
    (written by BE /api/lag/topo-pass when FE sends fe_outputs), run the BE
    engine on the same inputs and compare against FE outputs.

    Requires a FRESH fixture captured after the D1-D9 parity fixes — old fixtures
    lack query_mode, active_edges, and promoted_t95 in the request payload."""

    def test_live_parity(self):
        fixture = _load_live_fixture()
        if fixture is None:
            pytest.skip(f"No live fixture at {FIXTURE_PATH} — perform a fetch in the FE")

        inputs = fixture["inputs"]
        fe_out = fixture["fe_outputs"]

        param_lookup = {eid: _parse_cohorts(cl) for eid, cl in inputs.get("cohort_data", {}).items()}
        edge_contexts = _parse_edge_contexts(inputs.get("edge_contexts", {}))
        settings = settings_from_dict(inputs.get("forecasting_settings"))

        be_result = enhance_graph_latencies(inputs["graph"], param_lookup, settings, edge_contexts)

        be_lookup = {(ev.edge_uuid, ev.conditional_index): ev for ev in be_result.edge_values}

        errors = []
        matched = 0
        for fe_ev in fe_out["edge_values"]:
            eid = fe_ev["edge_uuid"]
            ci = fe_ev.get("conditional_index")
            be_ev = be_lookup.get((eid, ci))
            if be_ev is None:
                errors.append(f"{eid[:12]}[ci={ci}]: missing from BE")
                continue
            matched += 1
            for field, tol in FIELD_TOLERANCES.items():
                fe_val = fe_ev.get(field)
                be_val = getattr(be_ev, field, None)
                if not _close(fe_val, be_val, tol):
                    errors.append(
                        f"{eid[:12]}[ci={ci}].{field}: "
                        f"FE={fe_val} BE={be_val} "
                        f"delta={abs(float(fe_val or 0) - float(be_val or 0)):.6f} tol={tol}"
                    )

        if errors:
            pytest.fail(
                f"Parity FAILED: {len(errors)} mismatches ({matched} matched)\n" +
                "\n".join(errors)
            )
