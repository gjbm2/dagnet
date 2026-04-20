"""
Conditioned forecast response contract — RED tests.

These tests enforce the response shape mandated by:

  docs/current/project-bayes/45-forecast-parity-design.md

Doc 45, lines 181-190 specify:

    Response: {
      success: true,
      scenarios: [{
        scenario_id,
        edges: [{
          edge_uuid, p_mean, p_sd,
          completeness, completeness_sd
        }]
      }]
    }

And line 153-154:
    "it produces per-edge scalars (p.mean, p_sd, completeness) that get
     written back to the graph"

Today the Python handler in `handle_conditioned_forecast` emits only
`p_mean` / `p_sd` (plus tau_max / n_rows / n_cohorts / _forensic), and
omits `completeness` / `completeness_sd` entirely. The BE codepath it
uses (`compute_cohort_maturity_rows_v3`) does not compute completeness.

These tests will FAIL until the Python handler is fixed to produce and
return completeness and completeness_sd per doc 45. They are source-
level contract tests because runtime testing requires a snapshot DB
fixture that does not yet exist for CF.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest


HANDLER_PATH = (
    Path(__file__).resolve().parent.parent / "api_handlers.py"
)


def _load_handler_source() -> str:
    """Return the source of api_handlers.py."""
    return HANDLER_PATH.read_text()


def _find_cf_handler(tree: ast.AST) -> ast.FunctionDef:
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "handle_conditioned_forecast":
            return node
    raise AssertionError(
        "handle_conditioned_forecast not found in api_handlers.py"
    )


def _iter_edge_result_appends(func: ast.FunctionDef) -> list[ast.Dict]:
    """
    Return every dict literal passed to `edge_results.append({...})`
    inside the CF handler. These are the per-edge response objects.
    """
    dicts: list[ast.Dict] = []
    for node in ast.walk(func):
        if not isinstance(node, ast.Call):
            continue
        fn = node.func
        # Match `edge_results.append(...)` or similar per-edge appends.
        if (
            isinstance(fn, ast.Attribute)
            and fn.attr == "append"
            and isinstance(fn.value, ast.Name)
            and fn.value.id in {"edge_results", "edges"}
        ):
            if node.args and isinstance(node.args[0], ast.Dict):
                dicts.append(node.args[0])
    return dicts


def _literal_keys(d: ast.Dict) -> set[str]:
    out: set[str] = set()
    for k in d.keys:
        if isinstance(k, ast.Constant) and isinstance(k.value, str):
            out.add(k.value)
    return out


class TestConditionedForecastResponseContract:
    """Doc 45 response contract for /api/forecast/conditioned."""

    def test_handler_exists(self):
        """Sanity: handle_conditioned_forecast is defined."""
        tree = ast.parse(_load_handler_source())
        _find_cf_handler(tree)

    def test_handler_emits_p_mean(self):
        """Doc 45: response edges carry p_mean."""
        tree = ast.parse(_load_handler_source())
        func = _find_cf_handler(tree)
        edge_dicts = _iter_edge_result_appends(func)
        assert edge_dicts, (
            "No `edge_results.append({...})` found inside "
            "handle_conditioned_forecast. The handler must build a "
            "per-edge response dict."
        )
        for d in edge_dicts:
            keys = _literal_keys(d)
            assert "p_mean" in keys, (
                f"Per-edge response dict missing 'p_mean'; keys={sorted(keys)}"
            )

    def test_handler_emits_p_sd(self):
        """Doc 45: response edges carry p_sd."""
        tree = ast.parse(_load_handler_source())
        func = _find_cf_handler(tree)
        for d in _iter_edge_result_appends(func):
            keys = _literal_keys(d)
            assert "p_sd" in keys, (
                f"Per-edge response dict missing 'p_sd'; keys={sorted(keys)}"
            )

    def test_handler_emits_completeness(self):
        """Doc 45 §Response contract: per-edge output MUST include
        `completeness`. Line 153: 'it produces per-edge scalars (p.mean,
        p_sd, completeness) that get written back to the graph'. Today
        the handler emits only p_mean/p_sd, so this RED test fails."""
        tree = ast.parse(_load_handler_source())
        func = _find_cf_handler(tree)
        for d in _iter_edge_result_appends(func):
            keys = _literal_keys(d)
            assert "completeness" in keys, (
                "handle_conditioned_forecast must emit 'completeness' per "
                f"doc 45 lines 181-190. Current per-edge keys: {sorted(keys)}. "
                "Fix: compute completeness_mean via compute_forecast_trajectory "
                "(as the topo pass handler does at api_handlers.py:5927) "
                "and include it in the edge_results dict."
            )

    def test_handler_emits_completeness_sd(self):
        """Doc 45 response contract: per-edge output MUST include
        `completeness_sd` (posterior uncertainty on completeness)."""
        tree = ast.parse(_load_handler_source())
        func = _find_cf_handler(tree)
        for d in _iter_edge_result_appends(func):
            keys = _literal_keys(d)
            assert "completeness_sd" in keys, (
                "handle_conditioned_forecast must emit 'completeness_sd' per "
                f"doc 45 lines 181-190. Current per-edge keys: {sorted(keys)}. "
                "Fix: read sweep.completeness_sd from compute_forecast_trajectory "
                "and include it in the edge_results dict."
            )


class TestForecastConditionedRouteRegistered:
    """The endpoint URL must exist — prior failure caught only this."""

    def test_route_registered_in_python_api(self):
        """
        `/api/forecast/conditioned` is the canonical URL (doc 45 §Endpoint
        contract). Existing test_api_route_parity checks the URL is
        registered; this test is a belt-and-braces reminder that URL
        registration is necessary but NOT sufficient — the response shape
        must also conform (see tests above).
        """
        src = (
            Path(__file__).resolve().parent.parent.parent / "api" / "python-api.py"
        ).read_text()
        assert "/api/forecast/conditioned" in src, (
            "Canonical CF endpoint /api/forecast/conditioned must be "
            "registered in api/python-api.py."
        )


class TestDesignSpecKnown:
    """
    Guardrail: the design spec file exists and specifies the response
    contract. If the spec moves or is deleted, this tree of tests loses
    its justification — fail loudly rather than silently drift.
    """

    def test_design_spec_exists(self):
        spec = (
            Path(__file__).resolve().parent.parent.parent.parent
            / "docs" / "current" / "project-bayes" / "45-forecast-parity-design.md"
        )
        assert spec.exists(), (
            f"Design spec missing: {spec}. These tests are justified only "
            "by doc 45; if you move the spec, update the test suite too."
        )

    def test_design_spec_specifies_completeness_in_response(self):
        spec_path = (
            Path(__file__).resolve().parent.parent.parent.parent
            / "docs" / "current" / "project-bayes" / "45-forecast-parity-design.md"
        )
        text = spec_path.read_text()
        # Response block shows: edge_uuid, p_mean, p_sd, completeness, completeness_sd
        m = re.search(
            r"Response:\s*\{[^}]*edges:\s*\[\s*\{([^}]+)\}",
            text,
            re.DOTALL,
        )
        assert m is not None, (
            "Could not locate the Response: {…} block in doc 45. "
            "If the spec has been restructured, update this test."
        )
        fields_block = m.group(1)
        assert "completeness" in fields_block, (
            "Doc 45 response block no longer mentions 'completeness' — "
            "either the spec changed or the match regex needs updating."
        )
        assert "completeness_sd" in fields_block, (
            "Doc 45 response block no longer mentions 'completeness_sd'."
        )


# ─── CF endpoint ↔ cohort maturity v3 parity ────────────────────────────
#
# Doc 45 §Relationship to doc 29f Phase G: "one computation, two reads."
# The conditioned forecast endpoint and the cohort maturity chart share
# the underlying engine. For a given edge + DSL they must produce
# identical scalars at the evaluation horizon — BOTH for `p_mean` AND
# for `completeness`. Today `p_mean` parity is tested via v2/v3 parity
# (test_v2_v3_parity.py) but there is NO cross-handler check that
# completeness agrees. This test closes that gap.
#
# Uses the same fixture scaffolding as test_v2_v3_parity.py. Skips when
# the snapshot DB / data repo / synth graph are not available. Fails
# today because:
#   - handle_conditioned_forecast does not emit `completeness`
#   - compute_cohort_maturity_rows_v3 maturity rows carry no `completeness`
# Will pass once both handlers expose the same completeness scalar at
# the evaluation horizon (sourced from the shared sweep/forecast engine).

try:
    from conftest import requires_db, requires_data_repo, requires_synth
    _CONFTEST_AVAILABLE = True
except ImportError:  # conftest not on sys.path when running in isolation
    _CONFTEST_AVAILABLE = False


if _CONFTEST_AVAILABLE:
    @requires_db
    @requires_data_repo
    @requires_synth("synth-simple-abc", enriched=True)
    class TestConditionedForecastMaturityParity:
        """
        Cross-handler parity (doc 45 §'one computation, two reads').

        Given identical inputs (graph, DSL, candidate regimes), the CF
        endpoint and the cohort maturity v3 handler must return the
        same `p_mean` AND the same `completeness` at the evaluation
        horizon — they share the underlying engine.
        """

        @staticmethod
        def _load_synth_graph():
            """Mirror of test_v2_v3_parity._load_synth_graph to avoid
            pulling it into a shared helper while the test tree is
            still red."""
            import json
            from conftest import _resolve_data_repo_dir
            data_repo = _resolve_data_repo_dir()
            path = data_repo / "graphs" / "synth-simple-abc.json"
            if not path.exists():
                pytest.skip(f"Graph not found at {path}")
            return json.loads(path.read_text())

        @staticmethod
        def _get_candidate_regimes(graph):
            """Mirror of test_v2_v3_parity._get_candidate_regimes."""
            from snapshot_service import _pooled_conn  # type: ignore
            regimes: dict = {}
            with _pooled_conn() as conn:
                cur = conn.cursor()
                for edge in graph.get("edges", []):
                    p_id = edge.get("p", {}).get("id", "")
                    if not p_id:
                        continue
                    cur.execute(
                        "SELECT DISTINCT core_hash, slice_key FROM snapshots "
                        "WHERE param_id LIKE %s AND core_hash != '' "
                        "AND core_hash NOT LIKE 'PLACEHOLDER%%' "
                        "AND slice_key NOT LIKE 'context%%' "
                        "ORDER BY core_hash",
                        (f"%{p_id}",),
                    )
                    rows = cur.fetchall()
                    if rows:
                        all_hashes = [r[0] for r in rows]
                        primary = all_hashes[0]
                        regimes[edge["uuid"]] = [
                            {
                                "core_hash": primary,
                                "equivalent_hashes": all_hashes[1:],
                            }
                        ]
            return regimes

        def test_p_mean_and_completeness_agree_at_horizon(self):
            """
            For the A→B edge under `window(-90d:)`, both handlers must
            emit `completeness` and it must match within tolerance
            (same engine — no sampling drift on completeness because
            completeness is an integral of the same CDF on both paths).
            """
            import os
            if not os.environ.get("DB_CONNECTION"):
                pytest.skip(
                    "DB_CONNECTION env var required for cross-handler "
                    "parity test. Set it to run this RED check."
                )
            from api_handlers import (
                _handle_cohort_maturity_v3,
                handle_conditioned_forecast,
            )

            graph = self._load_synth_graph()
            regimes = self._get_candidate_regimes(graph)
            analytics_dsl = "from(simple-a).to(simple-b)"
            query_dsl = "window(-90d:)"

            # ── Cohort maturity v3 (handler, last row) ──────────────
            cm_result = _handle_cohort_maturity_v3(
                {
                    "scenarios": [
                        {
                            "scenario_id": "parity",
                            "graph": graph,
                            "analytics_dsl": analytics_dsl,
                            "effective_query_dsl": query_dsl,
                            "candidate_regimes_by_edge": regimes,
                        }
                    ]
                }
            )
            cm_rows: list = []
            if "result" in cm_result and isinstance(cm_result["result"], dict):
                cm_rows = cm_result["result"].get("maturity_rows", []) or []
            else:
                for s in (
                    cm_result.get("subjects")
                    or cm_result.get("scenarios", [{}])[0].get("subjects", [])
                ):
                    r = s.get("result", {}).get("maturity_rows", [])
                    if r:
                        cm_rows = r
                        break
            assert cm_rows, "cohort_maturity_v3 returned no rows"
            cm_last = cm_rows[-1]

            # ── CF endpoint (handle_conditioned_forecast) ───────────
            cf_result = handle_conditioned_forecast(
                {
                    "scenarios": [
                        {
                            "scenario_id": "parity",
                            "graph": graph,
                            "analytics_dsl": analytics_dsl,
                            "effective_query_dsl": query_dsl,
                            "candidate_regimes_by_edge": regimes,
                        }
                    ],
                    "analytics_dsl": analytics_dsl,
                }
            )
            cf_edges = (
                cf_result.get("scenarios", [{}])[0].get("edges", []) or []
            )
            assert cf_edges, "CF endpoint returned no edges"
            # Match the edge whose to_node is simple-b (A→B).
            cf_edge = next(
                (e for e in cf_edges if e.get("to_node") == "simple-b"),
                cf_edges[0],
            )

            # ── p_mean parity (already implicitly tested elsewhere,
            # but asserted here as the floor of the parity contract) ─
            cm_mid = cm_last.get("midpoint")
            cf_pmean = cf_edge.get("p_mean")
            assert cm_mid is not None and cf_pmean is not None, (
                f"Missing p_mean scalars — cm_mid={cm_mid} cf_pmean={cf_pmean}"
            )
            assert abs(cm_mid - cf_pmean) < 0.10, (
                f"p_mean parity failed: cohort_maturity last row={cm_mid:.4f} "
                f"CF endpoint={cf_pmean:.4f}"
            )

            # ── Completeness parity (the missing-test gap) ──────────
            cm_completeness = cm_last.get("completeness")
            cf_completeness = cf_edge.get("completeness")
            assert cm_completeness is not None, (
                "cohort_maturity_v3 last row missing 'completeness' — "
                "the engine path used by _handle_cohort_maturity_v3 "
                "(compute_cohort_maturity_rows_v3) does not compute "
                "completeness today. Per doc 45 §'one computation, two "
                "reads' both handlers must expose it."
            )
            assert cf_completeness is not None, (
                "CF endpoint edge missing 'completeness' — "
                "handle_conditioned_forecast emits only p_mean/p_sd "
                "today. Doc 45 response contract mandates completeness."
            )
            # Both come from the same CDF — no MC sampling variance on
            # this quantity. Tolerance kept tight.
            assert abs(cm_completeness - cf_completeness) < 0.02, (
                f"completeness parity failed: cohort_maturity last row="
                f"{cm_completeness:.4f} CF endpoint={cf_completeness:.4f}"
            )
