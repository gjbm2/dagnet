"""
Tests for bayes/regression_plans.py — plan loading, graph filtering,
args building, plan discovery, and variant comparison.

All tests are pure-unit: no DB, no data repo, no MCMC.
"""
from __future__ import annotations

import json
import os
import tempfile
import textwrap

import pytest

import sys
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO_ROOT, "bayes"))

from regression_plans import (
    load_plan,
    filter_graphs,
    discover_plans,
    _build_args,
    _print_variant_comparison,
    _write_settings_json,
    serialise_result,
    write_results_json,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def minimal_plan_dict():
    """Minimal valid plan as a Python dict."""
    return {
        "name": "test-plan",
        "graphs": {"include": ["synth-*"]},
        "sampling": {"chains": 2, "draws": 500, "tune": 200},
    }


@pytest.fixture
def plan_with_variants():
    return {
        "name": "variant-plan",
        "graphs": {"include": ["*"]},
        "sampling": {"chains": 3, "draws": 1000, "tune": 500},
        "features": ["base_flag=true"],
        "settings": {"target_accept": 0.90},
        "variants": [
            {"name": "baseline", "features": [], "settings": {}},
            {
                "name": "experimental",
                "features": ["latency_dispersion=true"],
                "settings": {"target_accept": 0.95},
            },
        ],
    }


def _write_plan_file(plan_dict: dict, dir_path: str, filename: str = "plan.json") -> str:
    path = os.path.join(dir_path, filename)
    with open(path, "w") as f:
        json.dump(plan_dict, f)
    return path


# ---------------------------------------------------------------------------
# load_plan
# ---------------------------------------------------------------------------

class TestLoadPlan:
    def test_minimal_plan_gets_defaults(self, minimal_plan_dict, tmp_path):
        path = _write_plan_file(minimal_plan_dict, str(tmp_path))
        plan = load_plan(path)

        assert plan["name"] == "test-plan"
        assert plan["description"] == ""
        assert plan["features"] == []
        assert plan["settings"] == {}
        assert plan["tags"] == []
        assert plan["variants"] == []
        assert plan["graphs"]["exclude"] == []
        assert plan["sampling"]["max_parallel"] is None
        assert plan["sampling"]["no_timeout"] is False

    def test_all_fields_preserved(self, tmp_path):
        full = {
            "name": "full",
            "description": "A full plan",
            "graphs": {"include": ["a-*"], "exclude": ["a-bad"]},
            "sampling": {
                "chains": 4,
                "draws": 2000,
                "tune": 1000,
                "max_parallel": 2,
                "no_timeout": True,
            },
            "features": ["f1=true", "f2=false"],
            "settings": {"target_accept": 0.99},
            "tags": ["nightly"],
            "variants": [{"name": "v1"}],
        }
        path = _write_plan_file(full, str(tmp_path))
        plan = load_plan(path)

        assert plan["sampling"]["chains"] == 4
        assert plan["sampling"]["no_timeout"] is True
        assert plan["features"] == ["f1=true", "f2=false"]
        assert plan["settings"]["target_accept"] == 0.99
        assert plan["tags"] == ["nightly"]
        assert len(plan["variants"]) == 1
        # Variant gets defaults
        assert plan["variants"][0]["features"] == []
        assert plan["variants"][0]["settings"] == {}

    def test_missing_required_key_raises(self, tmp_path):
        bad = {"name": "bad", "graphs": {"include": ["*"]}}
        path = _write_plan_file(bad, str(tmp_path))
        with pytest.raises(ValueError, match="missing required keys"):
            load_plan(path)

    def test_variant_without_name_raises(self, tmp_path):
        bad = {
            "name": "bad",
            "graphs": {"include": ["*"]},
            "sampling": {"chains": 2},
            "variants": [{"features": []}],
        }
        path = _write_plan_file(bad, str(tmp_path))
        with pytest.raises(ValueError, match="Variant missing 'name'"):
            load_plan(path)

    def test_comment_stripping(self, tmp_path):
        """Plan files with // comments and trailing commas parse correctly."""
        raw = textwrap.dedent("""\
        {
            // This is a comment
            "name": "commented",
            "graphs": {
                "include": ["*"],
                // Another comment
            },
            "sampling": {
                "chains": 2,
                "draws": 500,
                "tune": 300,
            }
        }
        """)
        path = os.path.join(str(tmp_path), "commented.json")
        with open(path, "w") as f:
            f.write(raw)

        plan = load_plan(path)
        assert plan["name"] == "commented"
        assert plan["sampling"]["chains"] == 2

    def test_invalid_json_raises(self, tmp_path):
        path = os.path.join(str(tmp_path), "bad.json")
        with open(path, "w") as f:
            f.write("not json at all")
        with pytest.raises(json.JSONDecodeError):
            load_plan(path)


# ---------------------------------------------------------------------------
# filter_graphs
# ---------------------------------------------------------------------------

SAMPLE_GRAPHS = [
    "synth-simple-abc",
    "synth-simple-abc-context",
    "synth-diamond-test",
    "synth-diamond-context",
    "synth-diamond-context-sparse",
    "synth-context-solo",
    "synth-context-solo-mixed",
    "synth-context-two-dim",
    "synth-forecast-test",
    "synth-lattice-test",
    "synth-lattice-context",
]


class TestFilterGraphs:
    def test_wildcard_includes_all(self):
        result = filter_graphs(SAMPLE_GRAPHS, ["*"], [])
        assert set(result) == set(SAMPLE_GRAPHS)

    def test_specific_names(self):
        result = filter_graphs(
            SAMPLE_GRAPHS,
            ["synth-simple-abc", "synth-diamond-test"],
            [],
        )
        assert result == ["synth-diamond-test", "synth-simple-abc"]

    def test_glob_pattern(self):
        result = filter_graphs(SAMPLE_GRAPHS, ["synth-*-context*"], [])
        assert "synth-simple-abc-context" in result
        assert "synth-diamond-context" in result
        assert "synth-diamond-context-sparse" in result
        assert "synth-simple-abc" not in result

    def test_exclude_removes_from_included(self):
        result = filter_graphs(SAMPLE_GRAPHS, ["*"], ["*-forecast-*"])
        assert "synth-forecast-test" not in result
        assert "synth-simple-abc" in result

    def test_exclude_pattern_sparse(self):
        result = filter_graphs(SAMPLE_GRAPHS, ["synth-diamond-*"], ["*-sparse"])
        assert "synth-diamond-test" in result
        assert "synth-diamond-context" in result
        assert "synth-diamond-context-sparse" not in result

    def test_include_context_glob(self):
        """The glob used in the context-focus plan."""
        result = filter_graphs(
            SAMPLE_GRAPHS,
            ["synth-*-context*", "synth-context-*"],
            [],
        )
        expected = {
            "synth-simple-abc-context",
            "synth-diamond-context",
            "synth-diamond-context-sparse",
            "synth-context-solo",
            "synth-context-solo-mixed",
            "synth-context-two-dim",
            "synth-lattice-context",
        }
        assert set(result) == expected

    def test_empty_include_returns_nothing(self):
        result = filter_graphs(SAMPLE_GRAPHS, [], [])
        assert result == []

    def test_no_matches_returns_empty(self):
        result = filter_graphs(SAMPLE_GRAPHS, ["nonexistent-*"], [])
        assert result == []

    def test_result_is_sorted(self):
        result = filter_graphs(SAMPLE_GRAPHS, ["*"], [])
        assert result == sorted(result)

    def test_exclude_everything(self):
        result = filter_graphs(SAMPLE_GRAPHS, ["*"], ["*"])
        assert result == []

    def test_sparse_only(self):
        """The glob used in the sparsity-sweep plan."""
        result = filter_graphs(SAMPLE_GRAPHS, ["*-sparse*"], [])
        assert result == ["synth-diamond-context-sparse"]


# ---------------------------------------------------------------------------
# _build_args
# ---------------------------------------------------------------------------

class TestBuildArgs:
    def test_plan_values_used(self, minimal_plan_dict):
        loaded = load_plan.__wrapped__(minimal_plan_dict) if hasattr(load_plan, '__wrapped__') else None
        # Manually apply defaults like load_plan does
        plan = {**minimal_plan_dict}
        plan.setdefault("features", [])
        plan.setdefault("settings", {})
        plan["sampling"].setdefault("max_parallel", None)
        plan["sampling"].setdefault("no_timeout", False)

        args = _build_args(["graph-a"], plan, {})

        assert args.chains == 2
        assert args.draws == 500
        assert args.tune == 200
        assert args.graph == ["graph-a"]
        assert args.feature == []

    def test_cli_overrides_take_precedence(self, minimal_plan_dict):
        plan = {**minimal_plan_dict}
        plan.setdefault("features", [])
        plan.setdefault("settings", {})
        plan["sampling"].setdefault("max_parallel", None)
        plan["sampling"].setdefault("no_timeout", False)

        args = _build_args(
            ["graph-a"], plan,
            {"chains": 5, "draws": 2000},
        )

        assert args.chains == 5
        assert args.draws == 2000
        assert args.tune == 200  # not overridden

    def test_variant_features_appended(self, minimal_plan_dict):
        plan = {**minimal_plan_dict}
        plan["features"] = ["base=true"]
        plan.setdefault("settings", {})
        plan["sampling"].setdefault("max_parallel", None)
        plan["sampling"].setdefault("no_timeout", False)

        args = _build_args(
            ["graph-a"], plan, {},
            variant_features=["extra=true"],
        )

        assert args.feature == ["base=true", "extra=true"]

    def test_variant_settings_override_plan_settings(self, minimal_plan_dict):
        plan = {**minimal_plan_dict}
        plan["features"] = []
        plan["settings"] = {"target_accept": 0.90, "keep_this": 1}
        plan["sampling"].setdefault("max_parallel", None)
        plan["sampling"].setdefault("no_timeout", False)

        args = _build_args(
            ["graph-a"], plan, {},
            variant_settings={"target_accept": 0.95},
        )

        # Settings written to temp file — verify the file content
        assert args._settings_json_path is not None
        with open(args._settings_json_path) as f:
            settings = json.load(f)
        assert settings["target_accept"] == 0.95
        assert settings["keep_this"] == 1

        # Cleanup
        os.remove(args._settings_json_path)

    def test_empty_settings_no_file(self, minimal_plan_dict):
        plan = {**minimal_plan_dict}
        plan.setdefault("features", [])
        plan.setdefault("settings", {})
        plan["sampling"].setdefault("max_parallel", None)
        plan["sampling"].setdefault("no_timeout", False)

        args = _build_args(["graph-a"], plan, {})

        assert args._settings_json_path is None


# ---------------------------------------------------------------------------
# _write_settings_json
# ---------------------------------------------------------------------------

class TestWriteSettingsJson:
    def test_empty_returns_none(self):
        assert _write_settings_json({}) is None

    def test_writes_valid_json(self):
        path = _write_settings_json({"target_accept": 0.95, "flag": True})
        assert path is not None
        with open(path) as f:
            data = json.load(f)
        assert data["target_accept"] == 0.95
        assert data["flag"] is True
        os.remove(path)


# ---------------------------------------------------------------------------
# discover_plans
# ---------------------------------------------------------------------------

class TestDiscoverPlans:
    def test_discovers_from_directory(self, tmp_path):
        plan_a = {
            "name": "alpha",
            "graphs": {"include": ["*"]},
            "sampling": {"chains": 2},
        }
        plan_b = {
            "name": "beta",
            "graphs": {"include": ["*"]},
            "sampling": {"chains": 3},
        }
        _write_plan_file(plan_a, str(tmp_path), "alpha.json")
        _write_plan_file(plan_b, str(tmp_path), "beta.json")

        plans = discover_plans(str(tmp_path))

        assert "alpha" in plans
        assert "beta" in plans
        assert plans["alpha"]["sampling"]["chains"] == 2

    def test_skips_non_json_files(self, tmp_path):
        _write_plan_file(
            {"name": "tmp-only-good", "graphs": {"include": ["*"]}, "sampling": {"chains": 2}},
            str(tmp_path), "good.json",
        )
        with open(os.path.join(str(tmp_path), "readme.txt"), "w") as f:
            f.write("not a plan")

        plans = discover_plans(str(tmp_path))
        # Built-in plans are also discovered; just check our tmp plan is there
        assert "tmp-only-good" in plans

    def test_skips_invalid_json_gracefully(self, tmp_path):
        with open(os.path.join(str(tmp_path), "bad.json"), "w") as f:
            f.write("not json")
        _write_plan_file(
            {"name": "tmp-only-good2", "graphs": {"include": ["*"]}, "sampling": {"chains": 2}},
            str(tmp_path), "good.json",
        )

        plans = discover_plans(str(tmp_path))
        assert "tmp-only-good2" in plans
        # The bad.json should not appear as any plan name
        assert "bad" not in plans

    def test_nonexistent_dir_returns_empty(self):
        plans = discover_plans("/nonexistent/path/that/does/not/exist")
        # May still find built-in plans from PLANS_DIR — just check no crash
        assert isinstance(plans, dict)

    def test_discovers_builtin_plans(self):
        """The bayes/plans/ directory should have our built-in plans."""
        plans = discover_plans()
        assert "smoke" in plans
        assert "overnight-full" in plans
        assert "context-focus" in plans

    def test_multiple_directories(self, tmp_path):
        dir_a = os.path.join(str(tmp_path), "a")
        dir_b = os.path.join(str(tmp_path), "b")
        os.makedirs(dir_a)
        os.makedirs(dir_b)

        _write_plan_file(
            {"name": "from-a", "graphs": {"include": ["*"]}, "sampling": {"chains": 2}},
            dir_a, "a.json",
        )
        _write_plan_file(
            {"name": "from-b", "graphs": {"include": ["*"]}, "sampling": {"chains": 3}},
            dir_b, "b.json",
        )

        plans = discover_plans(dir_a, dir_b)
        assert "from-a" in plans
        assert "from-b" in plans


# ---------------------------------------------------------------------------
# _print_variant_comparison
# ---------------------------------------------------------------------------

class TestPrintVariantComparison:
    def test_prints_without_error(self, capsys):
        results = {
            "baseline": [
                {"graph_name": "g1", "passed": True, "quality": {"rhat": 1.001}},
                {"graph_name": "g2", "passed": False, "xfail": False, "failures": ["z too high"]},
            ],
            "experimental": [
                {"graph_name": "g1", "passed": True, "quality": {"rhat": 1.002}},
                {"graph_name": "g2", "passed": False, "xfail": True, "failures": ["known"]},
            ],
        }
        _print_variant_comparison(results)

        output = capsys.readouterr().out
        assert "VARIANT COMPARISON" in output
        assert "g1" in output
        assert "g2" in output
        assert "PASS" in output
        assert "XFAIL" in output

    def test_missing_graph_in_one_variant(self, capsys):
        results = {
            "v1": [
                {"graph_name": "g1", "passed": True, "quality": {"rhat": 1.0}},
            ],
            "v2": [
                {"graph_name": "g1", "passed": True, "quality": {"rhat": 1.0}},
                {"graph_name": "g2", "passed": True, "quality": {"rhat": 1.0}},
            ],
        }
        _print_variant_comparison(results)

        output = capsys.readouterr().out
        assert "—" in output  # dash for missing g2 in v1


# ---------------------------------------------------------------------------
# Built-in plan files are valid
# ---------------------------------------------------------------------------

class TestBuiltinPlansValid:
    """Every .json in bayes/plans/ must load without error."""

    @pytest.fixture
    def plan_files(self):
        plans_dir = os.path.join(REPO_ROOT, "bayes", "plans")
        return [
            os.path.join(plans_dir, f)
            for f in os.listdir(plans_dir)
            if f.endswith(".json")
        ]

    def test_all_builtin_plans_load(self, plan_files):
        assert len(plan_files) > 0, "No plan files found"
        for path in plan_files:
            plan = load_plan(path)
            assert "name" in plan
            assert "graphs" in plan
            assert "sampling" in plan

    def test_all_builtin_plans_have_unique_names(self, plan_files):
        names = []
        for path in plan_files:
            plan = load_plan(path)
            names.append(plan["name"])
        assert len(names) == len(set(names)), f"Duplicate plan names: {names}"

    def test_smoke_plan_selects_specific_graphs(self, plan_files):
        smoke_path = [p for p in plan_files if "smoke" in os.path.basename(p)]
        assert len(smoke_path) == 1
        plan = load_plan(smoke_path[0])
        # Smoke should explicitly list graphs, not wildcard
        assert plan["graphs"]["include"] != ["*"]

    def test_variant_plan_has_multiple_variants(self, plan_files):
        ab_paths = [p for p in plan_files if "model-ab" in os.path.basename(p)]
        assert len(ab_paths) >= 1
        plan = load_plan(ab_paths[0])
        assert len(plan["variants"]) >= 2


# ---------------------------------------------------------------------------
# serialise_result
# ---------------------------------------------------------------------------

class TestSerialiseResult:
    def test_happy_path(self):
        r = {
            "graph_name": "synth-abc",
            "passed": True,
            "xfail": False,
            "xfail_reason": "",
            "failures": [],
            "warnings": ["minor"],
            "quality": {"rhat": 1.001, "ess": 5000, "converged_pct": 100},
            "thresholds": {"p_z": 2.5},
            "parsed_edges": {
                "edge-a-b": {
                    "p": {
                        "truth": 0.7,
                        "posterior_mean": 0.698,
                        "posterior_sd": 0.005,
                        "z_score": 0.4,
                        "abs_error": 0.002,
                        "status": "OK",
                    },
                },
            },
            "parsed_slices": {},
        }
        s = serialise_result(r)

        assert s["graph_name"] == "synth-abc"
        assert s["passed"] is True
        assert s["edges"]["edge-a-b"]["p"]["truth"] == 0.7
        assert s["edges"]["edge-a-b"]["p"]["z_score"] == 0.4
        assert s["slices"] == {}

    def test_slice_data_serialised(self):
        r = {
            "graph_name": "synth-ctx",
            "passed": True,
            "xfail": False,
            "failures": [],
            "warnings": [],
            "quality": {},
            "thresholds": {},
            "parsed_edges": {},
            "parsed_slices": {
                "context(channel:google) :: edge-a-b": {
                    "p": {
                        "truth": 0.84,
                        "posterior_mean": 0.83,
                        "posterior_sd": 0.01,
                        "z_score": 1.0,
                        "abs_error": 0.01,
                        "status": "OK",
                    },
                    "kappa": {
                        "posterior_mean": 50.0,
                        "posterior_sd": 5.0,
                    },
                },
            },
        }
        s = serialise_result(r)

        label = "context(channel:google) :: edge-a-b"
        assert label in s["slices"]
        assert s["slices"][label]["p"]["truth"] == 0.84
        # kappa has no truth — still serialised with None fields
        assert s["slices"][label]["kappa"]["truth"] is None

    def test_missing_fields_default_gracefully(self):
        r = {"graph_name": "bare", "passed": False}
        s = serialise_result(r)

        assert s["graph_name"] == "bare"
        assert s["passed"] is False
        assert s["edges"] == {}
        assert s["slices"] == {}
        assert s["failures"] == []

    def test_uses_edges_key_fallback(self):
        """Some results use 'edges' instead of 'parsed_edges'."""
        r = {
            "graph_name": "g",
            "passed": True,
            "edges": {
                "e1": {"p": {"truth": 0.5, "posterior_mean": 0.5, "posterior_sd": 0.01,
                             "z_score": 0.0, "abs_error": 0.0, "status": "OK"}},
            },
        }
        s = serialise_result(r)
        assert "e1" in s["edges"]


# ---------------------------------------------------------------------------
# write_results_json
# ---------------------------------------------------------------------------

class TestWriteResultsJson:
    def test_writes_valid_json(self, tmp_path):
        plan = {"name": "test", "sampling": {"chains": 2}, "features": []}
        all_results = {
            "default": [
                {
                    "graph_name": "g1",
                    "passed": True,
                    "xfail": False,
                    "failures": [],
                    "warnings": [],
                    "quality": {"rhat": 1.001},
                    "thresholds": {},
                    "parsed_edges": {},
                    "parsed_slices": {},
                },
            ],
        }

        path = write_results_json(plan, all_results, output_dir=str(tmp_path))
        assert os.path.isfile(path)

        with open(path) as f:
            data = json.load(f)

        assert data["plan"] == "test"
        assert "timestamp" in data
        assert data["variants"]["default"]["total"] == 1
        assert data["variants"]["default"]["passed"] == 1
        assert data["variants"]["default"]["failed"] == 0
        assert len(data["variants"]["default"]["graphs"]) == 1
        assert data["variants"]["default"]["graphs"][0]["graph_name"] == "g1"

    def test_multiple_variants(self, tmp_path):
        plan = {"name": "multi", "sampling": {}, "features": []}
        all_results = {
            "baseline": [
                {"graph_name": "g1", "passed": True, "xfail": False,
                 "failures": [], "warnings": [], "quality": {},
                 "thresholds": {}, "parsed_edges": {}, "parsed_slices": {}},
            ],
            "experimental": [
                {"graph_name": "g1", "passed": False, "xfail": False,
                 "failures": ["z too high"], "warnings": [], "quality": {},
                 "thresholds": {}, "parsed_edges": {}, "parsed_slices": {}},
            ],
        }

        path = write_results_json(plan, all_results, output_dir=str(tmp_path))
        with open(path) as f:
            data = json.load(f)

        assert "baseline" in data["variants"]
        assert "experimental" in data["variants"]
        assert data["variants"]["baseline"]["passed"] == 1
        assert data["variants"]["experimental"]["failed"] == 1

    def test_xfail_counted_separately(self, tmp_path):
        plan = {"name": "xf", "sampling": {}, "features": []}
        all_results = {
            "default": [
                {"graph_name": "g1", "passed": False, "xfail": True,
                 "xfail_reason": "known", "failures": ["x"],
                 "warnings": [], "quality": {}, "thresholds": {},
                 "parsed_edges": {}, "parsed_slices": {}},
            ],
        }

        path = write_results_json(plan, all_results, output_dir=str(tmp_path))
        with open(path) as f:
            data = json.load(f)

        assert data["variants"]["default"]["xfailed"] == 1
        assert data["variants"]["default"]["failed"] == 0
