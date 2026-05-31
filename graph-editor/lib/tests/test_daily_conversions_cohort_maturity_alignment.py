"""Outside-in alignment between daily_conversions and cohort_maturity.

These tests call the public runner handler for both analysis types. They do
not call the date reducer or tau reducer directly: the point is to prove that
the handlers route through the same CF projection machinery and differ only by
which axis they reduce.
"""

import math
import os
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


ANCHOR_DAY = "2026-01-01"
ANCHOR_DAY_UK = "1-Jan-26"
AS_AT_DAY = "2026-01-11"
EVAL_TAU = 10
SLICE_KEY = "window(1-Jan-26:1-Jan-26)"


def _single_cohort_graph():
    # The model is shifted-lognormal in log-space. A median lag of 9.5 days
    # with tiny sigma is effectively saturated by the integer tau=10 row.
    median_lag_days = 9.5
    mu = math.log(median_lag_days)
    sigma = 1e-7
    return {
        "nodes": [
            {"uuid": "A", "id": "A", "entry": {"is_start": True}},
            {"uuid": "B", "id": "B"},
        ],
        "edges": [{
            "uuid": "e1",
            "id": "e1",
            "edge_id": "e1",
            "from": "A",
            "to": "B",
            "p": {
                "id": "pytest-align-param",
                "forecast": {"mean": 0.5},
                "latency": {
                    "latency_parameter": True,
                    "mu": mu,
                    "sigma": sigma,
                    "onset_delta_days": 0.0,
                    "t95": 10.0,
                    "promoted_t95": 10.0,
                    "mu_sd": 0.0,
                    "sigma_sd": 0.0,
                    "onset_sd": 0.0,
                    "onset_mu_corr": 0.0,
                },
                "model_vars": [{
                    "source": "analytic",
                    "probability": {
                        "mean": 0.5,
                        "alpha": 50.0,
                        "beta": 50.0,
                        "alpha_pred": 50.0,
                        "beta_pred": 50.0,
                    },
                    "latency": {
                        "mu": mu,
                        "sigma": sigma,
                        "onset_delta_days": 0.0,
                        "t95": 10.0,
                        "mu_sd": 0.0,
                        "sigma_sd": 0.0,
                        "onset_sd": 0.0,
                        "onset_mu_corr": 0.0,
                    },
                }],
            },
        }],
    }


def _single_cohort_snapshot_row():
    return {
        "param_id": "pytest-align-param",
        "core_hash": "align-hash",
        "slice_key": SLICE_KEY,
        "anchor_day": ANCHOR_DAY,
        "retrieved_at": f"{AS_AT_DAY}T12:00:00+00:00",
        "a": 100,
        "x": 100,
        "y": 50,
        "median_lag_days": 9.5,
        "mean_lag_days": 9.5,
        "onset_delta_days": 0.0,
    }


def _request(analysis_type):
    temporal_dsl = f"window(1-Jan-26:1-Jan-26).asat(11-Jan-26)"
    return {
        "analysis_type": analysis_type,
        "query_dsl": f"from(A).to(B).{temporal_dsl}",
        "display_settings": {"tau_extent": str(EVAL_TAU)},
        "scenarios": [{
            "scenario_id": "base",
            "name": "Base",
            "colour": "#000000",
            "visibility_mode": "f+e",
            "effective_query_dsl": temporal_dsl,
            "graph": _single_cohort_graph(),
            "snapshot_subjects": [{
                "subject_id": "align-subject",
                "param_id": "pytest-align-param",
                "canonical_signature": '{"c":"align","x":{}}',
                "core_hash": "align-hash",
                "read_mode": "cohort_maturity",
                "anchor_from": ANCHOR_DAY,
                "anchor_to": ANCHOR_DAY,
                "sweep_from": ANCHOR_DAY,
                "sweep_to": AS_AT_DAY,
                "slice_keys": [SLICE_KEY],
                "target": {"targetId": "e1"},
                "from_node": "A",
                "to_node": "B",
            }],
        }],
    }


def _run_pair():
    from api_handlers import handle_runner_analyze

    row = _single_cohort_snapshot_row()
    with (
        patch("snapshot_service.query_snapshots_for_sweep", return_value=[row]),
        patch("snapshot_service.query_snapshots", return_value=[row]),
    ):
        daily = handle_runner_analyze(_request("daily_conversions"))
        maturity = handle_runner_analyze(_request("cohort_maturity"))
    assert daily["success"] is True
    assert maturity["success"] is True
    return daily["result"], maturity["result"]


def test_single_cohort_date_row_aligns_with_tau_row_when_latency_saturates_at_eval_tau():
    """For one Cohort, date and tau reducers are two views of one cell.

    This fixture makes the date reducer's terminal read and the tau reducer's
    eval-age read coincide: the selected Cohort is observed at age 10, and the
    near-deterministic latency has median 9.5 days, so the integer tau=10 row is
    effectively saturated. Under that condition, the daily row for the Cohort
    date and the cohort-maturity row at tau=10 must align.
    """
    daily, maturity = _run_pair()

    daily_rows = daily.get("rate_by_cohort") or []
    assert len(daily_rows) == 1
    daily_row = daily_rows[0]
    assert daily_row["date"] == ANCHOR_DAY_UK
    assert daily_row["x"] == 100
    assert daily_row["y"] == 50

    maturity_rows = maturity.get("maturity_rows") or []
    by_tau = {
        int(row["tau_days"]): row
        for row in maturity_rows
        if row.get("tau_days") is not None
    }
    assert EVAL_TAU in by_tau
    tau_row = by_tau[EVAL_TAU]

    # 73q Phase 5e Step C: cohort_maturity rows no longer carry a
    # query-level `completeness` scalar (the scalar reducer is the
    # source of truth — see plan §5e). Daily-conversions rows still
    # carry per-Cohort completeness from `bundle.completeness_by_cohort`.
    # For this single-Cohort, saturating fixture the per-Cohort value
    # and the tau-row's N-weighted scalar were strictly equal by
    # construction; the architectural unification of the bundle
    # preserves that — the cross-reducer parity is now structural
    # rather than a runtime cross-check, so the saturating assertion
    # lives on the daily side only.
    assert daily_row["completeness"] is not None
    assert daily_row["completeness"] > 0.999
    assert "completeness" not in tau_row, (
        "cohort_maturity rows no longer expose `completeness` post-Phase-5e;"
        " param-pack and CF endpoint consume the scalar reducer's output"
        " (`p.latency.completeness`) directly."
    )
    assert daily_row["forecast_bands"] == tau_row["fan_bands"]
    assert daily_row["forecast_y"] == pytest.approx(
        tau_row["forecast_y"], abs=1e-12,
    )
    assert daily_row["projected_y"] / daily_row["x"] == pytest.approx(
        tau_row["midpoint"], abs=1e-12,
    )
