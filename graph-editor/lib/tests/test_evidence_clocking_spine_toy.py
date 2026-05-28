from __future__ import annotations

import copy
import os
import sys
from datetime import date, timedelta

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api_handlers import handle_runner_analyze
from runner.bucket_transition import cumulative_empirical_rate_to_transition
from runner.span_kernel import _edge_sub_probability_density


HORIZON = 40
C_D_SIGMA = 0.35
C_D_MU = float(np.log(3.0) - C_D_SIGMA * 1.6448536269514722)
C_D_CDF = np.cumsum(
    _edge_sub_probability_density(
        np.arange(HORIZON + 1, dtype=float),
        0.5,
        0.0,
        C_D_MU,
        C_D_SIGMA,
    )
)


def _date_plus(day: str, offset: int) -> str:
    return (date.fromisoformat(day) + timedelta(days=int(offset))).isoformat()


def _tau_from_anchor(anchor_day: str, day: str) -> int:
    return (date.fromisoformat(day) - date.fromisoformat(anchor_day)).days


def _bucket_k_from_rates(rates_by_age: dict[int, float], horizon: int) -> np.ndarray:
    """Bucket-K transition implied by cumulative empirical rates.

    The toy fixtures specify cumulative `y/x` rates at integer ages.
    Under the bucket-transition convention the expected strict evidence
    flow is the source-day mass convolved with this transition kernel,
    not a hand-written endpoint table.
    """
    cumulative = np.zeros(int(horizon) + 1, dtype=np.float64)
    for age, rate in rates_by_age.items():
        if 0 <= int(age) <= int(horizon):
            cumulative[int(age)] = float(rate)
    cumulative = np.maximum.accumulate(cumulative)
    return cumulative_empirical_rate_to_transition(
        "toy-expected",
        cumulative,
    ).value[0]


def _push_mass_by_source_day(
    mass_by_source_day: dict[str, float],
    rates_by_source_day: dict[str, dict[int, float]],
    *,
    horizon: int,
) -> dict[str, float]:
    """Push source-day mass through source-specific bucket-K rates."""
    out: dict[str, float] = {}
    for source_day, source_mass in mass_by_source_day.items():
        rates = rates_by_source_day.get(source_day)
        if not rates:
            continue
        kernel = _bucket_k_from_rates(rates, horizon)
        for lag, kernel_mass in enumerate(kernel):
            contribution = float(source_mass) * float(kernel_mass)
            if contribution == 0.0:
                continue
            dest_day = _date_plus(source_day, lag)
            out[dest_day] = out.get(dest_day, 0.0) + contribution
    return out


def _cumulative_by_anchor_tau(
    mass_by_day: dict[str, float],
    *,
    anchor_day: str,
    horizon: int,
) -> dict[int, float]:
    density = np.zeros(int(horizon) + 1, dtype=np.float64)
    for day, mass in mass_by_day.items():
        tau = _tau_from_anchor(anchor_day, day)
        if 0 <= tau <= int(horizon):
            density[tau] += float(mass)
    cumulative = np.cumsum(density)
    return {tau: float(value) for tau, value in enumerate(cumulative)}


API_REQUEST = {
    "analysis_type": "cohort_maturity",
    "query_dsl": "cohort(a,1-Apr:1-Apr).from(b).to(d)",
    "scenarios": [
        {
            "scenario_id": "step-clock-toy",
            "name": "Step clock toy",
            "colour": "#000000",
            "visibility_mode": "e",
            "effective_query_dsl": "cohort(a,1-Apr:1-Apr)",
            "graph": {
                "nodes": [
                    {"id": "a", "uuid": "a"},
                    {"id": "b", "uuid": "b"},
                    {"id": "c", "uuid": "c"},
                    {"id": "d", "uuid": "d"},
                    {"id": "e", "uuid": "e"},
                ],
                "edges": [
                    {
                        "id": "a-b",
                        "edge_id": "a-b",
                        "uuid": "a-b",
                        "from": "a",
                        "to": "b",
                        "p": {
                            "id": "param-a-b",
                            "forecast": {"mean": 0.5},
                            "latency": {
                                "latency_parameter": True,
                                "mu": 1.6094379124341003,
                                "sigma": 0.0000000000000001,
                                "onset_delta_days": 0.0,
                                "t95": 5.0,
                            },
                        },
                    },
                    {
                        "id": "a-e",
                        "edge_id": "a-e",
                        "uuid": "a-e",
                        "from": "a",
                        "to": "e",
                        "p": {
                            "id": "param-a-e",
                            "forecast": {"mean": 0.995},
                            "latency": {"latency_parameter": False},
                        },
                    },
                    {
                        "id": "b-c",
                        "edge_id": "b-c",
                        "uuid": "b-c",
                        "from": "b",
                        "to": "c",
                        "p": {
                            "id": "param-b-c",
                            "forecast": {"mean": 0.4},
                            "latency": {
                                "latency_parameter": True,
                                "mu": 2.302585092994046,
                                "sigma": 0.0000000000000001,
                                "onset_delta_days": 0.0,
                                "t95": 10.0,
                            },
                        },
                    },
                    {
                        "id": "b-e",
                        "edge_id": "b-e",
                        "uuid": "b-e",
                        "from": "b",
                        "to": "e",
                        "p": {
                            "id": "param-b-e",
                            "forecast": {"mean": 0.6},
                            "latency": {"latency_parameter": False},
                        },
                    },
                    {
                        "id": "c-d",
                        "edge_id": "c-d",
                        "uuid": "c-d",
                        "from": "c",
                        "to": "d",
                        "p": {
                            "id": "param-c-d",
                            "forecast": {"mean": 0.5},
                            "latency": {
                                "latency_parameter": True,
                                "mu": C_D_MU,
                                "sigma": C_D_SIGMA,
                                "onset_delta_days": 0.0,
                                "t95": 3.0,
                            },
                        },
                    },
                    {
                        "id": "c-e",
                        "edge_id": "c-e",
                        "uuid": "c-e",
                        "from": "c",
                        "to": "e",
                        "p": {
                            "id": "param-c-e",
                            "forecast": {"mean": 0.5},
                            "latency": {"latency_parameter": False},
                        },
                    },
                    {
                        "id": "d-e",
                        "edge_id": "d-e",
                        "uuid": "d-e",
                        "from": "d",
                        "to": "e",
                        "p": {
                            "id": "param-d-e",
                            "forecast": {"mean": 1.0},
                            "latency": {"latency_parameter": False},
                        },
                    },
                ],
            },
            "snapshot_subjects": [
                {
                    "subject_id": "b-c",
                    "param_id": "param-b-c",
                    "core_hash": "hash-b-c",
                    "read_mode": "cohort_maturity",
                    "anchor_from": "2026-04-01",
                    "anchor_to": "2026-04-01",
                    "sweep_from": "2026-04-01",
                    "sweep_to": "2026-05-11",
                    "slice_keys": [""],
                    "from_node": "b",
                    "to_node": "c",
                    "anchor_node_id": "a",
                    "path_role": "first",
                    "target": {"targetId": "b-c"},
                },
                {
                    "subject_id": "c-d",
                    "param_id": "param-c-d",
                    "core_hash": "hash-c-d",
                    "read_mode": "cohort_maturity",
                    "anchor_from": "2026-04-01",
                    "anchor_to": "2026-04-01",
                    "sweep_from": "2026-04-01",
                    "sweep_to": "2026-05-11",
                    "slice_keys": [""],
                    "from_node": "c",
                    "to_node": "d",
                    "anchor_node_id": "a",
                    "path_role": "last",
                    "target": {"targetId": "c-d"},
                }
            ],
            "candidate_regimes_by_edge": {
                "a-b": [{"core_hash": "hash-a-b", "temporal_mode": "window"}],
                "b-c": [{"core_hash": "hash-b-c", "temporal_mode": "window"}],
            },
        }
    ],
    "display_settings": {"tau_extent": HORIZON},
}


SNAPSHOT_ROWS = {
    "param-a-b": [
        {
            "param_id": "param-a-b",
            "core_hash": "hash-a-b",
            "slice_key": "window()",
            "anchor_day": "2026-04-01",
            "retrieved_at": "2026-04-06",
            "x": 1000,
            "y": 500,
        }
    ],
    "param-b-c": [
        {
            "param_id": "param-b-c",
            "core_hash": "hash-b-c",
            "slice_key": "window()",
            "anchor_day": "2026-04-06",
            "retrieved_at": "2026-04-16",
            "x": 500,
            "y": 200,
        }
    ],
    "param-c-d": [
        {
            "param_id": "param-c-d",
            "core_hash": "hash-c-d",
            "slice_key": "window()",
            "anchor_day": "2026-04-16",
            "retrieved_at": f"2026-04-{16 + age:02d}" if 16 + age <= 30 else f"2026-05-{16 + age - 30:02d}",
            "x": 200,
            "y": int(round(200 * float(C_D_CDF[age]))),
        }
        for age in range(HORIZON + 1)
    ],
}


def test_handler_boundary_step_clock_reads_only_supplied_evidence_dates(monkeypatch):
    def query_snapshots_for_sweep(**kwargs):
        return SNAPSHOT_ROWS.get(kwargs["param_id"], [])

    monkeypatch.setattr(
        "snapshot_service.query_snapshots_for_sweep",
        query_snapshots_for_sweep,
    )

    result = handle_runner_analyze(API_REQUEST)
    rows_by_tau = {
        row["tau_days"]: row
        for row in result["result"]["maturity_rows"]
    }

    expected_c_mass = _push_mass_by_source_day(
        {"2026-04-06": 500.0},
        {"2026-04-06": {10: 200.0 / 500.0}},
        horizon=HORIZON,
    )
    expected_d_mass = _push_mass_by_source_day(
        expected_c_mass,
        {
            "2026-04-16": {
                age: int(round(200 * float(C_D_CDF[age]))) / 200.0
                for age in range(HORIZON + 1)
            },
        },
        horizon=HORIZON,
    )
    expected_y_by_tau = _cumulative_by_anchor_tau(
        expected_d_mass,
        anchor_day="2026-04-01",
        horizon=HORIZON,
    )

    # Engine emits rows only through ``min(compute_extent, saturation_τ)``
    # per ``docs/current/cohort-maturity-render-calc-policy.md``; E-mode
    # scenarios are not padded past that. The clock-reading contract this
    # test pins is per-row, so iterate over the rows the engine actually
    # returned. The engine must still reach past the carrier delay
    # (τ ≥ 5) so the "supplied evidence dates only" assertion is
    # non-vacuous on a c-d snapshot near the carrier arrival.
    assert max(rows_by_tau) >= 5, (
        f"engine emitted only {len(rows_by_tau)} rows; expected the "
        "natural projection to reach at least the carrier delay (τ ≥ 5)"
    )
    for tau in sorted(rows_by_tau):
        if tau > HORIZON:
            break
        expected_x = 0 if tau < 5 else 500
        expected_y = expected_y_by_tau[tau]
        actual_x = rows_by_tau[tau]["evidence_x"]
        actual_y = rows_by_tau[tau]["evidence_y"]
        assert (0.0 if actual_x is None else actual_x) == pytest.approx(
            expected_x,
            abs=1e-9,
        )
        assert (0.0 if actual_y is None else actual_y) == pytest.approx(
            expected_y,
            abs=1e-9,
        )


def test_nonlatent_carrier_retrieval_delay_does_not_delay_observed_denominator(monkeypatch):
    request = copy.deepcopy(API_REQUEST)
    for edge in request["scenarios"][0]["graph"]["edges"]:
        if edge["id"] == "a-b":
            edge["p"]["latency"] = {"latency_parameter": False}

    rows = copy.deepcopy(SNAPSHOT_ROWS)
    rows["param-b-c"][0]["anchor_day"] = "2026-04-01"

    def query_snapshots_for_sweep(**kwargs):
        return rows.get(kwargs["param_id"], [])

    monkeypatch.setattr(
        "snapshot_service.query_snapshots_for_sweep",
        query_snapshots_for_sweep,
    )

    result = handle_runner_analyze(request)
    rows_by_tau = {
        row["tau_days"]: row
        for row in result["result"]["maturity_rows"]
    }

    assert rows_by_tau[0]["evidence_x"] == pytest.approx(500, abs=1e-9)
    assert rows_by_tau[1]["evidence_x"] == pytest.approx(500, abs=1e-9)


def test_uniform_latency_cohort_multihop_preserves_mass_conservation(monkeypatch):
    """Cohort multi-hop evidence must conserve mass through re-clocking.

    This is a deliberately tiny hand-computable case for
    ``cohort(a).from(b).to(d)``:

      * A→B arrival density: 1/2 at τ=2 and 1/2 at τ=3.
      * B→C empirical probability: 1/5, uniformly over delays 4, 5, 6.
      * C→D empirical probability: 1/7, uniformly over delays 1, 2.

    With 420 selected A users, the expected strict evidence densities are:

      * B: 210 at τ=2, 210 at τ=3.
      * C: 14, 28, 28, 14 at τ=6..9.
      * D: 1, 3, 4, 3, 1 at τ=7..11.

    The prime factors 5 and 7 make it easy to see whether each hop's
    denominator cancels correctly. A midpoint-only rate shift breaks this
    exact integer mass flow.
    """
    horizon = 20
    n_a = 420
    expected_b_density = {2: 210.0, 3: 210.0}
    expected_d_density = {7: 1.0, 8: 3.0, 9: 4.0, 10: 3.0, 11: 1.0}

    def uniform_density(tau_grid, p, onset, mu, sigma):
        result = np.zeros_like(tau_grid, dtype=float)
        mu_marker = round(float(mu), 1)
        if mu_marker == 2.0:
            result[2] = 0.5 * float(p)
            result[3] = 0.5 * float(p)
        elif mu_marker == 4.0:
            result[4] = (1.0 / 3.0) * float(p)
            result[5] = (1.0 / 3.0) * float(p)
            result[6] = (1.0 / 3.0) * float(p)
        elif mu_marker == 6.0:
            result[1] = 0.5 * float(p)
            result[2] = 0.5 * float(p)
        else:
            raise AssertionError(f"unexpected test mu={mu}")
        return result

    monkeypatch.setattr(
        "runner.timing_span._edge_sub_probability_density",
        uniform_density,
    )
    monkeypatch.setattr(
        "runner.span_kernel._edge_sub_probability_density",
        uniform_density,
    )

    request = {
        "analysis_type": "cohort_maturity",
        "query_dsl": "cohort(a,1-Apr:1-Apr).from(b).to(d)",
        "scenarios": [
            {
                "scenario_id": "uniform-clock-toy",
                "name": "Uniform clock toy",
                "colour": "#000000",
                "visibility_mode": "e",
                "effective_query_dsl": "cohort(a,1-Apr:1-Apr)",
                "graph": {
                    "nodes": [
                        {"id": "a", "uuid": "a"},
                        {"id": "b", "uuid": "b"},
                        {"id": "c", "uuid": "c"},
                        {"id": "d", "uuid": "d"},
                    ],
                    "edges": [
                        {
                            "id": "a-b",
                            "edge_id": "a-b",
                            "uuid": "a-b",
                            "from": "a",
                            "to": "b",
                            "p": {
                                "id": "param-a-b",
                                "forecast": {"mean": 0.5},
                                "latency": {
                                    "latency_parameter": True,
                                    "mu": 2.0,
                                    "sigma": 1.0,
                                    "onset_delta_days": 0.0,
                                    "t95": 3.0,
                                },
                            },
                        },
                        {
                            "id": "b-c",
                            "edge_id": "b-c",
                            "uuid": "b-c",
                            "from": "b",
                            "to": "c",
                            "p": {
                                "id": "param-b-c",
                                "forecast": {"mean": 0.2},
                                "latency": {
                                    "latency_parameter": True,
                                    "mu": 4.0,
                                    "sigma": 1.0,
                                    "onset_delta_days": 0.0,
                                    "t95": 6.0,
                                },
                            },
                        },
                        {
                            "id": "c-d",
                            "edge_id": "c-d",
                            "uuid": "c-d",
                            "from": "c",
                            "to": "d",
                            "p": {
                                "id": "param-c-d",
                                "forecast": {"mean": 1.0 / 7.0},
                                "latency": {
                                    "latency_parameter": True,
                                    "mu": 6.0,
                                    "sigma": 1.0,
                                    "onset_delta_days": 0.0,
                                    "t95": 2.0,
                                },
                            },
                        },
                    ],
                },
                "snapshot_subjects": [
                    {
                        "subject_id": "b-c",
                        "param_id": "param-b-c",
                        "core_hash": "hash-b-c",
                        "read_mode": "cohort_maturity",
                        "anchor_from": "2026-04-01",
                        "anchor_to": "2026-04-01",
                        "sweep_from": "2026-04-01",
                        "sweep_to": "2026-04-21",
                        "slice_keys": [""],
                        "from_node": "b",
                        "to_node": "c",
                        "anchor_node_id": "a",
                        "path_role": "first",
                        "target": {"targetId": "b-c"},
                    },
                    {
                        "subject_id": "c-d",
                        "param_id": "param-c-d",
                        "core_hash": "hash-c-d",
                        "read_mode": "cohort_maturity",
                        "anchor_from": "2026-04-01",
                        "anchor_to": "2026-04-01",
                        "sweep_from": "2026-04-01",
                        "sweep_to": "2026-04-21",
                        "slice_keys": [""],
                        "from_node": "c",
                        "to_node": "d",
                        "anchor_node_id": "a",
                        "path_role": "last",
                        "target": {"targetId": "c-d"},
                    },
                ],
                "candidate_regimes_by_edge": {
                    "a-b": [{"core_hash": "hash-a-b", "temporal_mode": "window"}],
                    "b-c": [{"core_hash": "hash-b-c", "temporal_mode": "window"}],
                    "c-d": [{"core_hash": "hash-c-d", "temporal_mode": "window"}],
                },
            }
        ],
        "display_settings": {"tau_extent": horizon},
    }

    rows = {
        "param-a-b": [
            {
                "param_id": "param-a-b",
                "core_hash": "hash-a-b",
                "slice_key": "window()",
                "anchor_day": "2026-04-01",
                "retrieved_at": "2026-04-03",
                "x": n_a,
                "y": expected_b_density[2],
            },
            {
                "param_id": "param-a-b",
                "core_hash": "hash-a-b",
                "slice_key": "window()",
                "anchor_day": "2026-04-01",
                "retrieved_at": "2026-04-04",
                "x": n_a,
                "y": n_a,
            },
        ],
        "param-b-c": [],
        "param-c-d": [],
    }
    for b_day in ("2026-04-03", "2026-04-04"):
        for age, y in ((4, 14), (5, 28), (6, 42)):
            rows["param-b-c"].append({
                "param_id": "param-b-c",
                "core_hash": "hash-b-c",
                "slice_key": "window()",
                "anchor_day": b_day,
                "retrieved_at": f"2026-04-{int(b_day[-2:]) + age:02d}",
                "x": 210,
                "y": y,
            })
    for c_day, n_c in (
        ("2026-04-07", 14),
        ("2026-04-08", 28),
        ("2026-04-09", 28),
        ("2026-04-10", 14),
    ):
        for age, y in ((1, n_c // 14), (2, n_c // 7)):
            rows["param-c-d"].append({
                "param_id": "param-c-d",
                "core_hash": "hash-c-d",
                "slice_key": "window()",
                "anchor_day": c_day,
                "retrieved_at": f"2026-04-{int(c_day[-2:]) + age:02d}",
                "x": n_c,
                "y": y,
            })

    def query_snapshots_for_sweep(**kwargs):
        return rows.get(kwargs["param_id"], [])

    monkeypatch.setattr(
        "snapshot_service.query_snapshots_for_sweep",
        query_snapshots_for_sweep,
    )

    result = handle_runner_analyze(request)
    rows_by_tau = {
        row["tau_days"]: row
        for row in result["result"]["maturity_rows"]
    }

    expected_b_cumulative = {}
    running_b = 0.0
    for tau in range(horizon + 1):
        running_b += expected_b_density.get(tau, 0.0)
        expected_b_cumulative[tau] = running_b

    expected_c_mass = _push_mass_by_source_day(
        {
            "2026-04-03": expected_b_density[2],
            "2026-04-04": expected_b_density[3],
        },
        {
            "2026-04-03": {4: 14.0 / 210.0, 5: 28.0 / 210.0, 6: 42.0 / 210.0},
            "2026-04-04": {4: 14.0 / 210.0, 5: 28.0 / 210.0, 6: 42.0 / 210.0},
        },
        horizon=horizon,
    )
    expected_d_mass = _push_mass_by_source_day(
        expected_c_mass,
        {
            day: {1: 1.0 / 14.0, 2: 1.0 / 7.0}
            for day in (
                "2026-04-07",
                "2026-04-08",
                "2026-04-09",
                "2026-04-10",
            )
        },
        horizon=horizon,
    )
    expected_d_cumulative = _cumulative_by_anchor_tau(
        expected_d_mass,
        anchor_day="2026-04-01",
        horizon=horizon,
    )

    for tau in range(horizon + 1):
        actual_x = rows_by_tau[tau]["evidence_x"]
        actual_y = rows_by_tau[tau]["evidence_y"]
        assert (0.0 if actual_x is None else actual_x) == pytest.approx(
            expected_b_cumulative[tau],
            abs=1e-9,
        ), (
            f"tau={tau}: evidence_x={actual_x!r}, "
            f"expected B cumulative={expected_b_cumulative[tau]:.6f}"
        )
        assert (0.0 if actual_y is None else actual_y) == pytest.approx(
            expected_d_cumulative[tau],
            abs=1e-9,
        ), (
            f"tau={tau}: evidence_y={actual_y!r}, "
            f"expected D cumulative={expected_d_cumulative[tau]:.6f}"
        )

    assert rows_by_tau[horizon]["evidence_x"] == pytest.approx(n_a, abs=1e-9)
    assert rows_by_tau[horizon]["evidence_y"] == pytest.approx(
        expected_d_cumulative[horizon],
        abs=1e-9,
    )
