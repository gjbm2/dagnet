"""
Conditioned forecast response contract (doc 64 Family F).

The `/api/forecast/conditioned` endpoint must emit a per-edge response
shape conforming to doc 45 lines 181-190:

    Response: {
      success: true,
      scenarios: [{
        scenario_id,
        edges: [{
          edge_uuid, p_mean, p_sd,
          completeness, completeness_sd,
          cf_mode, cf_reason
        }]
      }]
    }

Doc 45 line 153-154: "it produces per-edge scalars (p.mean, p_sd,
completeness) that get written back to the graph".

Two apparatuses enforce this contract on the live handler:

1. Static AST checks on `api_handlers.handle_conditioned_forecast` —
   every per-edge response dict literal must carry the mandated keys.
   These are cheap drift guards that catch handler-shape regressions
   before a real call is issued.

2. Runtime integration against the shared engine — the response must
   actually contain live values for the mandated fields on real synth
   graphs, and the CF endpoint must agree with `cohort_maturity_v3`
   on `p_mean` and `completeness` at the evaluation horizon (doc 45
   §"one computation, two reads").

── Authoring receipt (doc 64 §3.6) ─────────────────────────────────

Family         F. Projection and authority — the CF handler owns a
               response shape with specific fields; a sibling Family C
               runtime-backed slice asserts that CF and the v3 chart
               agree on the shared scalars at the evaluation horizon.
Invariant      The CF handler must emit the mandated per-edge fields
               and the values must agree with `cohort_maturity_v3` at
               the evaluation horizon because both are projections of
               one solve.
Oracle type    Public contract (static handler-shape assertions) plus
               live cross-consumer agreement (runtime-backed slices on
               synth-simple-abc and synth-mirror-4step).
Apparatus      Static (AST) plus Python integration. Static alone is
               insufficient — dict literals with the right keys can
               still carry `None` or stale values. Runtime alone would
               miss structural regressions where the handler is
               rearranged in ways a single fixture does not cover.
Fixtures       `synth-simple-abc` (single-hop window) and
               `synth-mirror-4step` (multi-hop cohort). Smallest named
               graphs that exercise the shared engine without extra
               topology risk.
Reality        Real snapshot DB and real data repo for runtime slices;
               no mocks of forecast logic or handler shape. Static
               checks operate directly on `api_handlers.py` source.
False-pass     Static checks could pass while the runtime response
               omits the fields (e.g., a conditional branch skips the
               per-edge append). Runtime checks mitigate. Runtime
               could pass while values drift in tandem on a shared
               bug; the cross-consumer agreement claim at the
               evaluation horizon mitigates this.
Retires        Supersedes the "RED tests" framing from when
               `completeness` / `completeness_sd` were missing from
               the handler. The handler now emits the mandated fields;
               these tests are live drift guards.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

from api_handlers import _cf_supplement_evidence_counts_from_file


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


def _iter_calls(func: ast.FunctionDef, name: str) -> list[ast.Call]:
    """Return every call to `name(...)` inside `func`."""
    calls: list[ast.Call] = []
    for node in ast.walk(func):
        if not isinstance(node, ast.Call):
            continue
        if isinstance(node.func, ast.Name) and node.func.id == name:
            calls.append(node)
    return calls


def _find_function(tree: ast.AST, name: str) -> ast.FunctionDef:
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"{name} not found in api_handlers.py")


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
        p_sd, completeness) that get written back to the graph'. Drift
        guard: if the CF handler's per-edge response dict drops
        `completeness`, downstream consumers (graph projection, chart
        normaliser) silently lose the field."""
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

    def test_handler_emits_cf_mode(self):
        """Doc 57: per-edge output carries CF provenance mode."""
        tree = ast.parse(_load_handler_source())
        func = _find_cf_handler(tree)
        for d in _iter_edge_result_appends(func):
            keys = _literal_keys(d)
            assert "cf_mode" in keys, (
                f"Per-edge response dict missing 'cf_mode'; keys={sorted(keys)}"
            )

    def test_handler_emits_cf_reason(self):
        """Doc 57: per-edge output carries CF degradation reason."""
        tree = ast.parse(_load_handler_source())
        func = _find_cf_handler(tree)
        for d in _iter_edge_result_appends(func):
            keys = _literal_keys(d)
            assert "cf_reason" in keys, (
                f"Per-edge response dict missing 'cf_reason'; keys={sorted(keys)}"
            )

    def test_handler_passes_axis_tau_max_to_upstream_fetch(self):
        """WP6: whole-graph CF must carry the same donor-lookback bound that v3
        uses when calling `_fetch_upstream_observations`.
        """
        tree = ast.parse(_load_handler_source())
        func = _find_cf_handler(tree)
        calls = _iter_calls(func, "_fetch_upstream_observations")
        assert calls, (
            "handle_conditioned_forecast no longer calls "
            "_fetch_upstream_observations; update this contract test."
        )
        assert any(
            any(keyword.arg == "axis_tau_max" for keyword in call.keywords)
            for call in calls
        ), (
            "handle_conditioned_forecast must pass axis_tau_max into "
            "_fetch_upstream_observations so whole-graph donor lookback uses "
            "the same horizon bound as the v3 path."
        )

    def test_upstream_fetch_uses_shared_forecast_preparation_helper(self):
        """WP6: donor-routing must reuse the shared forecast preparation path,
        not keep an ad hoc query/regime/derive branch inside the upstream fetch.
        """
        tree = ast.parse(_load_handler_source())
        func = _find_function(tree, "_fetch_upstream_observations")
        shared_helper_calls = _iter_calls(func, "prepare_forecast_subject_entry")
        assert shared_helper_calls, (
            "_fetch_upstream_observations must prepare missing donor edges via "
            "the shared forecast-preparation helper so donor routing obeys the "
            "same regime/evidence policy as the main subject path."
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


class TestConditionedForecastFileEvidenceSupplement:
    """Bayes-style uncovered-day supplement for CF evidence counts."""

    def test_supplements_only_uncovered_days_from_bare_cohort_daily_arrays(self):
        graph = {
            "edges": [
                {
                    "uuid": "edge-1",
                    "_bayes_evidence": {
                        "cohort": [
                            {
                                "sliceDSL": "cohort(1-Apr-26:4-Apr-26)",
                                "dates": [
                                    "2026-04-01",
                                    "2026-04-02",
                                    "2026-04-03",
                                    "2026-04-04",
                                ],
                                "n_daily": [10, 20, 30, 40],
                                "k_daily": [1, 2, 3, 4],
                            },
                            {
                                "sliceDSL": "cohort(1-Apr-26:4-Apr-26).context(channel:paid)",
                                "dates": ["2026-04-01", "2026-04-03"],
                                "n_daily": [999, 999],
                                "k_daily": [999, 999],
                            },
                        ]
                    },
                }
            ]
        }

        result = _cf_supplement_evidence_counts_from_file(
            graph_data=graph,
            edge_uuid="edge-1",
            anchor_from="2026-04-01",
            anchor_to="2026-04-04",
            snapshot_covered_days={"2026-04-02", "2026-04-04"},
        )

        assert result == {"n": 40, "k": 4, "supplemented_days": 2}

    def test_returns_zero_without_engorged_file_evidence(self):
        result = _cf_supplement_evidence_counts_from_file(
            graph_data={"edges": [{"uuid": "edge-1"}]},
            edge_uuid="edge-1",
            anchor_from="2026-04-01",
            anchor_to="2026-04-04",
            snapshot_covered_days={"2026-04-02"},
        )

        assert result == {"n": 0, "k": 0, "supplemented_days": 0}


# ─── CF endpoint ↔ cohort_maturity_v3 runtime agreement ─────────────
#
# Doc 45 §"one computation, two reads": the CF endpoint and the v3
# chart share the underlying engine. For a given edge + DSL they must
# produce identical scalars at the evaluation horizon — BOTH for
# `p_mean` AND `completeness`. This is the runtime-backed slice of the
# handler contract: the static AST checks above prove the fields are
# emitted; these tests prove the values agree.
#
# Skips when the snapshot DB / data repo / synth graph are not
# available.

try:
    from conftest import (
        load_candidate_regimes_by_mode,
        load_graph_json,
        requires_db,
        requires_data_repo,
        requires_synth,
    )
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
            return load_graph_json("synth-simple-abc")

        @staticmethod
        def _get_candidate_regimes(graph):
            return load_candidate_regimes_by_mode("synth-simple-abc")

        def test_p_mean_and_completeness_agree_at_horizon(self):
            """
            For the A→B edge under `window(-90d:)`, both handlers must
            emit `completeness` and it must match within tolerance
            (same engine — no sampling drift on completeness because
            completeness is an integral of the same CDF on both paths).
            """
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
                "cohort_maturity_v3 last row missing 'completeness'. "
                "Doc 45 §'one computation, two reads' mandates "
                "completeness on both the CF and v3 paths at the "
                "evaluation horizon."
            )
            assert cf_completeness is not None, (
                "CF endpoint edge missing 'completeness'. "
                "Doc 45 response contract mandates completeness on "
                "the CF endpoint."
            )
            # Both come from the same CDF — no MC sampling variance on
            # this quantity. Tolerance kept tight.
            assert abs(cm_completeness - cf_completeness) < 0.02, (
                f"completeness parity failed: cohort_maturity last row="
                f"{cm_completeness:.4f} CF endpoint={cf_completeness:.4f}"
            )


    @requires_db
    @requires_data_repo
    @requires_synth("synth-mirror-4step", enriched=True)
    class TestConditionedForecastMultiHopCohortParity:
        """
        Doc 47 / doc 60 WP1 regression guard for scoped multi-hop cohort
        queries.

        The v3 chart and scoped conditioned-forecast endpoint must prepare
        the same subject frames before calling the shared engine. If the CF
        path drifts back to cohort-family subject reads here, its horizon
        scalar diverges from the chart on this fixture.
        """

        @staticmethod
        def _load_synth_graph():
            return load_graph_json("synth-mirror-4step")

        @staticmethod
        def _get_candidate_regimes(graph):
            return load_candidate_regimes_by_mode("synth-mirror-4step")

        def test_scoped_multi_hop_cohort_matches_v3_horizon(self):
            from api_handlers import (
                _handle_cohort_maturity_v3,
                handle_conditioned_forecast,
            )

            graph = self._load_synth_graph()
            regimes = self._get_candidate_regimes(graph)
            analytics_dsl = "from(m4-delegated).to(m4-success)"
            query_dsl = "cohort(-14d:)"

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
            cm_rows = []
            if "result" in cm_result and isinstance(cm_result["result"], dict):
                cm_rows = cm_result["result"].get("maturity_rows", []) or []
            else:
                for subject in (
                    cm_result.get("subjects")
                    or cm_result.get("scenarios", [{}])[0].get("subjects", [])
                ):
                    rows = subject.get("result", {}).get("maturity_rows", [])
                    if rows:
                        cm_rows = rows
                        break
            assert cm_rows, "cohort_maturity_v3 returned no rows for multi-hop cohort parity"
            cm_last = cm_rows[-1]

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
            cf_edges = cf_result.get("scenarios", [{}])[0].get("edges", []) or []
            assert cf_edges, "CF endpoint returned no edges for multi-hop cohort parity"
            cf_edge = next(
                (edge for edge in cf_edges if edge.get("to_node") == "m4-success"),
                cf_edges[0],
            )

            cm_p_mean = cm_last.get("p_infinity_mean")
            if cm_p_mean is None:
                cm_p_mean = cm_last.get("midpoint")
            cf_p_mean = cf_edge.get("p_mean")
            assert cm_p_mean is not None and cf_p_mean is not None, (
                f"Missing p_mean scalars — cm_p_mean={cm_p_mean} cf_p_mean={cf_p_mean}"
            )
            assert abs(cm_p_mean - cf_p_mean) < 5e-3, (
                "Scoped multi-hop cohort p_mean parity failed: "
                f"cohort_maturity={cm_p_mean:.4f} CF={cf_p_mean:.4f}"
            )

            cm_completeness = cm_last.get("completeness")
            cf_completeness = cf_edge.get("completeness")
            assert cm_completeness is not None and cf_completeness is not None, (
                "Missing completeness scalars for scoped multi-hop cohort parity"
            )
            assert abs(cm_completeness - cf_completeness) < 5e-3, (
                "Scoped multi-hop cohort completeness parity failed: "
                f"cohort_maturity={cm_completeness:.4f} "
                f"CF={cf_completeness:.4f}"
            )


@requires_db
@requires_data_repo
@requires_synth("synth-simple-abc", enriched=True, bayesian=True)
class TestConditionedForecastSingleHopCohortParity:
    """
    Doc 60 factorised single-hop guard for downstream cohort queries.

    Exact single-hop cohort queries may keep cohort query frames, but the
    chart and CF endpoint must still agree at the horizon because both now
    ride the same X-rooted subject helper path.
    """

    @staticmethod
    def _load_synth_graph():
        return load_graph_json("synth-simple-abc", bayesian=True)

    @staticmethod
    def _get_candidate_regimes(graph):
        return load_candidate_regimes_by_mode("synth-simple-abc")

    def test_scoped_single_hop_cohort_matches_v3_horizon(self):
        from api_handlers import (
            _handle_cohort_maturity_v3,
            handle_conditioned_forecast,
        )

        graph = self._load_synth_graph()
        regimes = self._get_candidate_regimes(graph)
        analytics_dsl = "from(simple-b).to(simple-c)"
        query_dsl = "cohort(-90d:)"

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
        cm_rows = []
        if "result" in cm_result and isinstance(cm_result["result"], dict):
            cm_rows = cm_result["result"].get("maturity_rows", []) or []
        else:
            for subject in (
                cm_result.get("subjects")
                or cm_result.get("scenarios", [{}])[0].get("subjects", [])
            ):
                rows = subject.get("result", {}).get("maturity_rows", [])
                if rows:
                    cm_rows = rows
                    break
        assert cm_rows, "cohort_maturity_v3 returned no rows for single-hop cohort parity"
        cm_last = cm_rows[-1]

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
        cf_edges = cf_result.get("scenarios", [{}])[0].get("edges", []) or []
        assert cf_edges, "CF endpoint returned no edges for single-hop cohort parity"
        cf_edge = next(
            (edge for edge in cf_edges if edge.get("to_node") == "simple-c"),
            cf_edges[0],
        )

        cm_p_mean = cm_last.get("p_infinity_mean")
        if cm_p_mean is None:
            cm_p_mean = cm_last.get("midpoint")
        cf_p_mean = cf_edge.get("p_mean")
        assert cm_p_mean is not None and cf_p_mean is not None, (
            f"Missing p_mean scalars — cm_p_mean={cm_p_mean} cf_p_mean={cf_p_mean}"
        )
        assert abs(cm_p_mean - cf_p_mean) < 5e-3, (
            "Scoped single-hop cohort p_mean parity failed: "
            f"cohort_maturity={cm_p_mean:.4f} CF={cf_p_mean:.4f}"
        )

        cm_completeness = cm_last.get("completeness")
        cf_completeness = cf_edge.get("completeness")
        assert cm_completeness is not None and cf_completeness is not None, (
            "Missing completeness scalars for single-hop cohort parity"
        )
        assert abs(cm_completeness - cf_completeness) < 5e-3, (
            "Scoped single-hop cohort completeness parity failed: "
            f"cohort_maturity={cm_completeness:.4f} "
            f"CF={cf_completeness:.4f}"
        )

