"""
Stage 5a integration tests — F14 single-hop primitive readout end-to-end (73n).

Plan: docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md
§"Stage 5a — Single-Hop Window and Subject Cutover (Parity Oracle)".

These tests exercise the wired path — `compute_cohort_maturity_rows_v3`
called from BOTH `_handle_cohort_maturity_v3` AND
`handle_conditioned_forecast`, against the synth-simple-abc graph
(F14 Q1 oracle: `p_infinity_mean = 0.6925`).

The key parity contract the relocation-to-row-builder fixed:

  - With the flag ON, the substituted scalar must appear on BOTH the
    cohort_maturity surface (`maturity_rows[-1].p_infinity_mean`) and
    the CF surface (`edge_results[i].p_mean`). They must match exactly
    (STATS_SUBSYSTEMS §3.3 "shared code → guaranteed parity"; AP58
    forking discipline).

The test patterns mirror `test_conditioned_forecast_response_contract.py`'s
in-process handler calls — no BE round-trip, env var monkeypatched per
test so the runtime sees the flag without restarting.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

GRAPH_EDITOR_DIR = Path(__file__).resolve().parent.parent.parent
if str(GRAPH_EDITOR_DIR) not in sys.path:
    sys.path.insert(0, str(GRAPH_EDITOR_DIR))
LIB_DIR = GRAPH_EDITOR_DIR / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

try:
    from conftest import (
        load_candidate_regimes_by_mode,
        load_graph_json,
        requires_data_repo,
        requires_synth,
    )
    _CONFTEST_AVAILABLE = True
except ImportError:
    _CONFTEST_AVAILABLE = False




def _f14_q1_request(graph, regimes):
    """The F14 Q1 fixture — single-hop window(-90d:) on synth-simple-abc."""
    return {
        "scenarios": [
            {
                "scenario_id": "f14-q1",
                "graph": graph,
                "analytics_dsl": "from(simple-a).to(simple-b)",
                "effective_query_dsl": "window(-90d:)",
                "candidate_regimes_by_edge": regimes,
            }
        ],
        "analytics_dsl": "from(simple-a).to(simple-b)",
    }


def _cm_p_infinity(cm_result) -> float:
    """Extract last-row p_infinity_mean from a cohort_maturity response."""
    rows = []
    if "result" in cm_result and isinstance(cm_result["result"], dict):
        rows = cm_result["result"].get("maturity_rows", []) or []
    else:
        for s in (
            cm_result.get("subjects")
            or cm_result.get("scenarios", [{}])[0].get("subjects", [])
        ):
            r = s.get("result", {}).get("maturity_rows", [])
            if r:
                rows = r
                break
    assert rows, "cohort_maturity_v3 returned no rows"
    return rows[-1]["p_infinity_mean"]


def _cm_primitive_readout(cm_result):
    """Extract primitive_readout from a cohort_maturity response."""
    if "result" in cm_result and isinstance(cm_result["result"], dict):
        # Single-scenario flat shape.
        return cm_result["result"].get("primitive_readout")
    for s in (
        cm_result.get("subjects")
        or cm_result.get("scenarios", [{}])[0].get("subjects", [])
    ):
        result = s.get("result", {})
        if "primitive_readout" in result:
            return result["primitive_readout"]
        # Fall back: look on the row sentinel if not popped.
        rows = result.get("maturity_rows", [])
        if rows and "_primitive_readout" in rows[0]:
            return rows[0]["_primitive_readout"]
    return None


def _cf_edge(cf_result, to_node="simple-b"):
    """Extract the matching edge from a CF response."""
    edges = cf_result.get("scenarios", [{}])[0].get("edges", []) or []
    assert edges, "CF endpoint returned no edges"
    return next(
        (e for e in edges if e.get("to_node") == to_node),
        edges[0],
    )


@pytest.mark.skipif(not _CONFTEST_AVAILABLE, reason="conftest helpers unavailable")
class TestStage5aSingleHopIntegration:
    """F14 Q1 single-hop window — both surfaces, all three flag modes."""

    @staticmethod
    def _load():
        graph = load_graph_json("synth-simple-abc")
        regimes = load_candidate_regimes_by_mode("synth-simple-abc")
        return graph, regimes

    @requires_data_repo
    @requires_synth("synth-simple-abc", enriched=True)
    def test_substitutes_identically_on_both_surfaces(self):
        """Substitution happens at the row-builder seam, so both surfaces
        produce the same primitive-derived p_mean (Stage 5a is the only
        live path post 73n stage 9 FF retirement).
        """
        from api_handlers import (
            _handle_cohort_maturity_v3,
            handle_conditioned_forecast,
        )

        graph, regimes = self._load()
        request = _f14_q1_request(graph, regimes)

        cm_result = _handle_cohort_maturity_v3(request)
        cf_result = handle_conditioned_forecast(request)
        cm_p = _cm_p_infinity(cm_result)
        cf_edge = _cf_edge(cf_result)
        cf_p = cf_edge["p_mean"]

        # The row builder substituted before populating rows, so
        # cohort_maturity's p_infinity_mean and CF's p_mean must be
        # identical.
        assert abs(cm_p - cf_p) < 1e-9, (
            f"shared row builder must produce identical substituted "
            f"p_mean on both surfaces. cohort_maturity={cm_p} CF={cf_p}. "
            f"AP58 / STATS_SUBSYSTEMS §3.3 violation."
        )

        cm_pr = _cm_primitive_readout(cm_result)
        cf_pr = cf_edge["primitive_readout"]
        assert cm_pr["substituted"] is True
        assert cf_pr["substituted"] is True
        assert cm_pr["subject_probability_source"] == "primitive_posterior"
        assert cf_pr["subject_probability_source"] == "primitive_posterior"
        # The substituted value equals the closed-form mean (no MC noise).
        assert abs(cm_p - cm_pr["closed_form_public_moments"]["p_mean"]) < 1e-9
