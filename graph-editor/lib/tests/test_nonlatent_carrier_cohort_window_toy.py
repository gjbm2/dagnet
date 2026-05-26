"""Toy demonstrating cohort == window collapse under non-latent carrier.

Topology: a → b → c → d
  a-b: non-latent
  b-c: non-latent
  c-d: latent

Query: from(c).to(d)
  Window mode: anchor = c (subject's from-node)
  Cohort mode: anchor = a (full upstream carrier a-b-c)

Snapshot rows are constructed with **flow conservation**:
  n on edge UV at anchor_day = d  ==  upstream y on edge TU at anchor_day = d
  (because non-latent transit means same-day arrival at the from-node)

Under correct algebra and these properly-accounted snapshots, the cohort
chain product `N_a × (k_ab/n_ab) × (k_bc/n_bc)` must telescope to
`n_cd = n_at_c`, and so cohort.evidence_x and window.evidence_x must be
equal at every shared tau.

This test fails if the carrier composition does not naturally degenerate
under non-latent A→X — i.e. if cohort mode runs a different algebraic
path from window mode for the same observed-prefix evidence.
"""
from __future__ import annotations

import copy
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api_handlers import handle_runner_analyze
from runner.span_kernel import _edge_sub_probability_density


HORIZON = 40
# c-d latency: lognormal with sigma=0.35, median ~ 3 days.
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

# Mass plan with flow conservation per anchor day = 2026-04-01:
#   1000 enter a       — k_ab = 500 (p_ab = 0.5)
#   500 arrive at b    — k_bc = 200 (p_bc = 0.4); equals upstream k_ab
#   200 arrive at c    — c-d evolves via latency PMF
N_A = 1000
K_AB = 500
N_B = K_AB     # flow conservation: n at b-c = k from a-b
K_BC = 200
N_C = K_BC     # flow conservation: n at c-d = k from b-c


def _graph_definition():
    return {
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
        ],
    }


# Per-anchor mass-conserving snapshot rows for anchor=2026-04-01.
# Window family rows: anchor_day = day at from-node (= 04-01 for all
# edges, because non-latent carrier yields same-day arrival).
SNAPSHOT_ROWS = {
    "param-a-b": [
        {
            "param_id": "param-a-b",
            "core_hash": "hash-a-b",
            "slice_key": "window()",
            "anchor_day": "2026-04-01",
            "retrieved_at": "2026-04-02",
            "x": N_A,
            "y": K_AB,
        }
    ],
    "param-b-c": [
        {
            "param_id": "param-b-c",
            "core_hash": "hash-b-c",
            "slice_key": "window()",
            "anchor_day": "2026-04-01",
            "retrieved_at": "2026-04-02",
            "x": N_B,        # flow conservation: x at b-c = y at a-b
            "y": K_BC,
        }
    ],
    "param-c-d": [
        {
            "param_id": "param-c-d",
            "core_hash": "hash-c-d",
            "slice_key": "window()",
            "anchor_day": "2026-04-01",
            "retrieved_at": (
                f"2026-04-{1 + age:02d}" if 1 + age <= 30
                else f"2026-05-{1 + age - 30:02d}"
            ),
            "x": N_C,        # flow conservation: x at c-d = y at b-c
            "y": int(round(N_C * float(C_D_CDF[age]))),
        }
        for age in range(HORIZON + 1)
    ],
}


def _api_request(query_dsl: str, anchor_node_id: str):
    """Build a runner_analyze request for a given query.

    `anchor_node_id` is "a" for cohort mode and "c" for window mode
    (window's denominator IS its anchor).
    """
    return {
        "analysis_type": "cohort_maturity",
        "query_dsl": query_dsl,
        "scenarios": [
            {
                "scenario_id": "toy",
                "name": "Mass-conserving toy",
                "colour": "#000000",
                "visibility_mode": "e",
                "effective_query_dsl": query_dsl,
                "graph": _graph_definition(),
                "snapshot_subjects": [
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
                        "anchor_node_id": anchor_node_id,
                        "path_role": "only",
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


def _run(query_dsl: str, anchor_node_id: str, monkeypatch):
    def query_snapshots_for_sweep(**kwargs):
        return SNAPSHOT_ROWS.get(kwargs["param_id"], [])

    monkeypatch.setattr(
        "snapshot_service.query_snapshots_for_sweep",
        query_snapshots_for_sweep,
    )

    result = handle_runner_analyze(_api_request(query_dsl, anchor_node_id))
    rows_by_tau = {
        row["tau_days"]: row
        for row in result["result"]["maturity_rows"]
    }
    return rows_by_tau


def test_window_mode_observes_n_at_c(monkeypatch):
    """Sanity: window mode reads evidence_x = n at c = 200 at every tau."""
    rows = _run("from(c).to(d).window(1-Apr:1-Apr)", "c", monkeypatch)
    for tau in range(HORIZON + 1):
        assert rows[tau]["evidence_x"] == pytest.approx(N_C, abs=1e-9), (
            f"window evidence_x at tau={tau} = "
            f"{rows[tau]['evidence_x']}, expected {N_C}"
        )


def test_chain_product_telescopes_under_mass_conservation():
    """Algebraic check, no engine: under mass conservation
    (n_downstream = k_upstream per anchor day), the cohort chain
    product N_A × Π(k/n) telescopes to n at X."""
    # Per anchor day:
    chain_product = N_A * (K_AB / N_A) * (K_BC / N_B)
    assert chain_product == pytest.approx(N_C, abs=1e-9), (
        f"chain product = {chain_product}, expected n at X = {N_C}"
    )
    # Algebra: N_A × (K_AB/N_A) × (K_BC/N_B) = K_AB × K_BC/N_B
    # With N_B = K_AB (mass conservation), = K_BC = N_C. QED.


def test_cohort_mode_reproduces_window_under_nonlatent_carrier(monkeypatch):
    """The core invariant: under non-latent a-b-c carrier and
    flow-conserving snapshots, cohort.evidence_x must equal
    window.evidence_x at every shared tau.

    With:
      - all carrier edges declared `latency_parameter: False`
      - single-hop subject declared `path_role: "only"` (not "last", which
        leaves query_from_node empty in `prepare_forecast_subject_group`
        and blocks envelope-plan construction)
      - per-anchor mass-conserving snapshot rows (`n_downstream = k_upstream`)

    the engine produces identical evidence_x for both modes — the
    carrier composition naturally degenerates and the chain product
    telescopes.
    """
    window_rows = _run("from(c).to(d).window(1-Apr:1-Apr)", "c", monkeypatch)
    cohort_rows = _run(
        "cohort(a,1-Apr:1-Apr).from(c).to(d)", "a", monkeypatch,
    )

    shared = sorted(set(window_rows) & set(cohort_rows))
    assert shared, "no shared tau between window and cohort runs"

    failures = []
    for tau in shared:
        w_x = window_rows[tau].get("evidence_x")
        c_x = cohort_rows[tau].get("evidence_x")
        if w_x is None or c_x is None:
            failures.append((tau, w_x, c_x, "absent"))
            continue
        if abs(float(w_x) - float(c_x)) > 0.5:
            failures.append((tau, float(w_x), float(c_x), abs(float(w_x) - float(c_x))))

    if failures:
        lines = ["evidence_x diverges between window and cohort:"]
        for tau, w, c, diff in failures[:10]:
            lines.append(f"  tau={tau:3d}  window={w}  cohort={c}  diff={diff}")
        pytest.fail("\n".join(lines))
