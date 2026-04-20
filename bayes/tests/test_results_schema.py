"""
Tests for bayes/results_schema.py — rounding, structured failures,
bias profiles, audit serialisation, and top-level result serialisation.

All tests are pure-unit: no DB, no data repo, no MCMC.
"""
from __future__ import annotations

import os
import sys

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO_ROOT, "bayes"))

from results_schema import (
    round_val,
    make_failure,
    serialise_design,
    compute_bias_profile,
    serialise_audit,
    serialise_result,
    classify_status,
    classify_convergence,
    classify_bias,
    classify_quality,
)


# ---------------------------------------------------------------------------
# round_val
# ---------------------------------------------------------------------------

class TestRoundVal:
    def test_none_passes_through(self):
        assert round_val(None) is None
        assert round_val(None, "z_score") is None

    def test_string_passes_through(self):
        assert round_val("OK") == "OK"

    def test_z_score_3dp(self):
        assert round_val(6.666666666, "z_score") == 6.667

    def test_abs_error_4dp(self):
        assert round_val(0.040000000036, "abs_error") == 0.04

    def test_posterior_mean_4dp(self):
        assert round_val(1.4760001, "posterior_mean") == 1.476

    def test_posterior_sd_4dp(self):
        assert round_val(0.005999999, "posterior_sd") == 0.006

    def test_truth_4dp(self):
        assert round_val(0.30000001, "truth") == 0.3

    def test_ess_rounded_to_int(self):
        assert round_val(5432.7, "ess") == 5433
        assert isinstance(round_val(5432.7, "ess"), int)

    def test_explicit_places_override(self):
        assert round_val(3.14159, places=2) == 3.14

    def test_unknown_field_passes_through(self):
        assert round_val(3.14159265, "unknown_field") == 3.14159265

    def test_rhat_4dp(self):
        assert round_val(1.014600001, "rhat") == 1.0146

    def test_delta_elpd_1dp(self):
        assert round_val(635.123, "delta_elpd") == 635.1

    def test_pareto_k_2dp(self):
        assert round_val(0.58432, "pareto_k") == 0.58


# ---------------------------------------------------------------------------
# make_failure
# ---------------------------------------------------------------------------

class TestMakeFailure:
    def test_z_score_failure_all_fields(self):
        f = make_failure(
            "z_score",
            "edge-a-b onset: |z|=3.42 > 3.0",
            edge="edge-a-b",
            param="onset",
            z_score=3.4166666,
            threshold=3.0,
            abs_error=0.41000003,
            abs_floor=0.3,
            truth=5.0,
            posterior_mean=5.41000003,
            posterior_sd=0.12000001,
        )

        assert f["type"] == "z_score"
        assert f["message"] == "edge-a-b onset: |z|=3.42 > 3.0"
        assert f["edge"] == "edge-a-b"
        assert f["param"] == "onset"
        assert f["z_score"] == 3.417  # rounded to 3dp
        assert f["threshold"] == 3.0
        assert f["abs_error"] == 0.41  # rounded to 4dp
        assert f["truth"] == 5.0
        assert f["posterior_mean"] == 5.41
        assert f["posterior_sd"] == 0.12

    def test_convergence_failure(self):
        f = make_failure(
            "convergence",
            "rhat=1.0600 > 1.05",
            metric="rhat",
            value=1.06,
            threshold=1.05,
        )

        assert f["type"] == "convergence"
        assert f["metric"] == "rhat"
        assert f["value"] == 1.06
        assert f["threshold"] == 1.05
        assert "edge" not in f
        assert "param" not in f

    def test_missing_edge_failure(self):
        f = make_failure(
            "missing_edge",
            "missing recovery rows for 2 truth edge(s): a, b",
            count=2,
            items=["a", "b"],
        )

        assert f["type"] == "missing_edge"
        assert f["count"] == 2
        assert f["items"] == ["a", "b"]

    def test_slice_z_score_failure(self):
        f = make_failure(
            "z_score",
            "SLICE ctx :: edge p: z=4.0",
            slice="ctx :: edge",
            param="p",
            z_score=4.0,
            threshold=3.0,
        )

        assert f["slice"] == "ctx :: edge"
        assert "edge" not in f

    def test_none_fields_omitted(self):
        f = make_failure("audit", "log missing")
        assert set(f.keys()) == {"type", "message"}

    def test_message_always_present(self):
        f = make_failure("audit", "something broke")
        assert "message" in f
        assert f["message"] == "something broke"


# ---------------------------------------------------------------------------
# compute_bias_profile
# ---------------------------------------------------------------------------

class TestComputeBiasProfile:
    def test_empty_inputs(self):
        assert compute_bias_profile({}, {}) == {}

    def test_single_edge_single_param(self):
        edges = {
            "e1": {
                "p": {"truth": 0.5, "posterior_mean": 0.52, "z_score": 1.0},
            },
        }
        profile = compute_bias_profile(edges, {})

        assert "p" in profile
        assert profile["p"]["n"] == 1
        assert profile["p"]["mean_bias"] == 0.02
        assert profile["p"]["max_z"] == 1.0
        assert profile["p"]["direction"] == "+"

    def test_multiple_edges_direction(self):
        edges = {
            "e1": {"mu": {"truth": 2.0, "posterior_mean": 1.9, "z_score": 1.0}},
            "e2": {"mu": {"truth": 3.0, "posterior_mean": 2.8, "z_score": 2.0}},
            "e3": {"mu": {"truth": 1.0, "posterior_mean": 0.9, "z_score": 0.5}},
        }
        profile = compute_bias_profile(edges, {})

        assert profile["mu"]["n"] == 3
        assert profile["mu"]["direction"] == "-"  # all negative
        assert profile["mu"]["consistency"] == "3/3"
        assert profile["mu"]["max_z"] == 2.0
        assert profile["mu"]["max_z_source"] == "e2"

    def test_slices_use_suffix(self):
        slices = {
            "ctx :: e1": {
                "p": {"truth": 0.5, "posterior_mean": 0.55, "z_score": 1.0},
            },
        }
        profile = compute_bias_profile({}, slices)

        assert "p_slice" in profile
        assert "p" not in profile

    def test_kappa_excluded(self):
        edges = {
            "e1": {
                "kappa": {"posterior_mean": 50.0, "posterior_sd": 5.0},
                "p": {"truth": 0.5, "posterior_mean": 0.5, "z_score": 0.0},
            },
        }
        profile = compute_bias_profile(edges, {})

        assert "kappa" not in profile
        assert "p" in profile

    def test_mixed_direction(self):
        edges = {
            "e1": {"p": {"truth": 0.5, "posterior_mean": 0.55, "z_score": 1.0}},
            "e2": {"p": {"truth": 0.5, "posterior_mean": 0.45, "z_score": 1.0}},
        }
        profile = compute_bias_profile(edges, {})

        assert profile["p"]["direction"] == "~"


# ---------------------------------------------------------------------------
# serialise_audit
# ---------------------------------------------------------------------------

class TestSerialiseAudit:
    def test_none_input(self):
        assert serialise_audit(None) is None

    def test_empty_dict(self):
        assert serialise_audit({}) is None

    def test_log_not_found(self):
        assert serialise_audit({"log_found": False}) is None

    def test_full_audit(self):
        audit = {
            "log_found": True,
            "completed": True,
            "dsl": "window(1-Jan-26:1-Mar-26)",
            "subjects": 6,
            "regimes": 3,
            "data_binding": {
                "snapshot_edges": 6,
                "fallback_edges": 0,
                "total_bound": 3,
                "total_failed": 0,
                "slice_details": [
                    {"uuid": "abc12345", "ctx_key": "context(ch:g)",
                     "total_n": 1000, "window_n": 500, "cohort_n": 500},
                ],
                "binding_details": [],
            },
            "model": {
                "latency_dispersion_flag": True,
                "phase1_sampled": True,
                "phase2_sampled": False,
                "kappa_lat_edges": 2,
            },
            "priors": {"edges_with_latency_prior": 2, "prior_details": []},
            "inference": {"edges_with_mu": 2, "mu_details": [], "slice_details": []},
            "convergence": {"rhat": 1.001, "ess": 5000, "converged_pct": 100},
            "loo": {
                "status": "scored",
                "edges_scored": 4,
                "total_delta_elpd": 635.123,
                "worst_pareto_k": 0.5843,
            },
        }

        s = serialise_audit(audit)
        assert s is not None
        assert s["dsl"] == "window(1-Jan-26:1-Mar-26)"
        assert s["subjects"] == 6
        assert s["completed"] is True
        assert s["binding"]["snapshot_edges"] == 6
        assert s["binding"]["failed"] == 0
        assert len(s["binding"]["slices"]) == 1
        assert s["binding"]["slices"][0]["total_n"] == 1000
        assert s["model"]["latency_dispersion"] is True
        assert s["model"]["kappa_lat_edges"] == 2
        assert s["loo"]["status"] == "scored"
        assert s["loo"]["total_delta_elpd"] == 635.1  # rounded
        assert s["loo"]["worst_pareto_k"] == 0.58  # rounded

    def test_loo_not_run(self):
        audit = {
            "log_found": True,
            "completed": True,
            "dsl": "",
            "subjects": 0,
            "regimes": 0,
            "data_binding": {
                "snapshot_edges": 0, "fallback_edges": 0,
                "total_bound": 0, "total_failed": 0,
                "slice_details": [],
            },
            "model": {
                "latency_dispersion_flag": False,
                "phase1_sampled": False, "phase2_sampled": False,
                "kappa_lat_edges": 0,
            },
            "priors": {"edges_with_latency_prior": 0, "prior_details": []},
            "inference": {"edges_with_mu": 0, "mu_details": []},
            "convergence": {},
            "loo": {"status": "not_run"},
        }

        s = serialise_audit(audit)
        assert "loo" not in s


# ---------------------------------------------------------------------------
# serialise_result
# ---------------------------------------------------------------------------

class TestSerialiseResult:
    def test_edge_values_rounded(self):
        r = {
            "graph_name": "g",
            "passed": True,
            "parsed_edges": {
                "e1": {
                    "p": {
                        "truth": 0.7000001,
                        "posterior_mean": 0.698000123,
                        "posterior_sd": 0.005000456,
                        "z_score": 0.399999888,
                        "abs_error": 0.002000333,
                        "status": "OK",
                    },
                },
            },
            "parsed_slices": {},
        }
        s = serialise_result(r)

        p = s["edges"]["e1"]["p"]
        assert p["truth"] == 0.7
        assert p["posterior_mean"] == 0.698
        assert p["posterior_sd"] == 0.005
        assert p["z_score"] == 0.4
        assert p["abs_error"] == 0.002

    def test_quality_rounded(self):
        r = {
            "graph_name": "g",
            "passed": True,
            "quality": {"rhat": 1.00146001, "ess": 5432.7, "converged_pct": 100, "elapsed_s": 95},
            "parsed_edges": {},
            "parsed_slices": {},
        }
        s = serialise_result(r)

        assert s["quality"]["rhat"] == 1.0015
        assert s["quality"]["ess"] == 5433
        assert isinstance(s["quality"]["ess"], int)

    def test_structured_failures_preserved(self):
        failure = {
            "type": "z_score",
            "message": "e1 onset: z=3.42",
            "edge": "e1",
            "param": "onset",
            "z_score": 3.42,
        }
        r = {
            "graph_name": "g",
            "passed": False,
            "failures": [failure],
            "warnings": [],
            "parsed_edges": {},
            "parsed_slices": {},
        }
        s = serialise_result(r)

        assert len(s["failures"]) == 1
        assert s["failures"][0]["type"] == "z_score"
        assert s["failures"][0]["edge"] == "e1"

    def test_bias_profile_included(self):
        r = {
            "graph_name": "g",
            "passed": True,
            "parsed_edges": {
                "e1": {"p": {"truth": 0.5, "posterior_mean": 0.52, "z_score": 1.0,
                             "posterior_sd": 0.02, "abs_error": 0.02, "status": "OK"}},
            },
            "parsed_slices": {},
        }
        s = serialise_result(r)

        assert "bias" in s
        assert "p" in s["bias"]

    def test_audit_included_when_present(self):
        r = {
            "graph_name": "g",
            "passed": True,
            "parsed_edges": {},
            "parsed_slices": {},
            "audit": {
                "log_found": True,
                "completed": True,
                "dsl": "window()",
                "subjects": 4,
                "regimes": 2,
                "data_binding": {
                    "snapshot_edges": 4, "fallback_edges": 0,
                    "total_bound": 2, "total_failed": 0,
                    "slice_details": [],
                },
                "model": {
                    "latency_dispersion_flag": False,
                    "phase1_sampled": True, "phase2_sampled": True,
                    "kappa_lat_edges": 0,
                },
                "priors": {"edges_with_latency_prior": 0, "prior_details": []},
                "inference": {"edges_with_mu": 0, "mu_details": []},
                "convergence": {},
                "loo": {"status": "not_run"},
            },
        }
        s = serialise_result(r)

        assert "audit" in s
        assert s["audit"]["dsl"] == "window()"
        assert s["audit"]["model"]["phase1_sampled"] is True

    def test_audit_omitted_when_absent(self):
        r = {
            "graph_name": "g",
            "passed": True,
            "parsed_edges": {},
            "parsed_slices": {},
        }
        s = serialise_result(r)

        assert "audit" not in s

    def test_slice_values_rounded(self):
        r = {
            "graph_name": "g",
            "passed": True,
            "parsed_edges": {},
            "parsed_slices": {
                "ctx :: e1": {
                    "p": {
                        "truth": 0.399,
                        "posterior_mean": 0.397000111,
                        "posterior_sd": 0.118000222,
                        "z_score": 0.016949152542,
                        "abs_error": 0.002000333,
                        "status": "OK",
                    },
                },
            },
        }
        s = serialise_result(r)

        p = s["slices"]["ctx :: e1"]["p"]
        assert p["z_score"] == 0.017
        assert p["posterior_sd"] == 0.118

    def test_empty_quality_produces_empty_dict(self):
        r = {
            "graph_name": "g",
            "passed": True,
            "quality": {},
            "parsed_edges": {},
            "parsed_slices": {},
        }
        s = serialise_result(r)
        assert s["quality"] == {}

    def test_kappa_entries_handled(self):
        """kappa entries have only posterior_mean/sd — no truth or z_score."""
        r = {
            "graph_name": "g",
            "passed": True,
            "parsed_edges": {
                "e1": {
                    "kappa": {"posterior_mean": 50.0, "posterior_sd": 5.0},
                },
            },
            "parsed_slices": {},
        }
        s = serialise_result(r)

        assert "kappa" in s["edges"]["e1"]
        assert s["edges"]["e1"]["kappa"]["truth"] is None
        assert s["edges"]["e1"]["kappa"]["posterior_mean"] == 50.0


# ---------------------------------------------------------------------------
# serialise_design
# ---------------------------------------------------------------------------

class TestSerialiseDesign:
    def test_solo_bare(self):
        truth = {
            "simulation": {"n_days": 100, "mean_daily_traffic": 500},
            "edges": {"e1": {"from": "a", "to": "b", "p": 0.5}},
            "nodes": {"a": {"start": True}, "b": {"absorbing": True}},
        }
        d = serialise_design(truth)
        assert d["topology"] == "solo"
        assert d["n_edges"] == 1
        assert d["n_days"] == 100
        assert "sparsity" not in d
        assert "context_dimensions" not in d
        assert "epochs" not in d

    def test_chain_topology(self):
        truth = {
            "simulation": {},
            "edges": {
                "e1": {"from": "a", "to": "b", "p": 0.7},
                "e2": {"from": "b", "to": "c", "p": 0.6},
            },
            "nodes": {"a": {}, "b": {}, "c": {}},
        }
        d = serialise_design(truth)
        assert d["topology"] == "chain"
        assert d["n_edges"] == 2

    def test_diamond_topology(self):
        truth = {
            "simulation": {},
            "edges": {
                "e1": {"from": "a", "to": "b", "p": 0.4},
                "e2": {"from": "a", "to": "c", "p": 0.3},
                "e3": {"from": "b", "to": "d", "p": 0.7},
                "e4": {"from": "c", "to": "d", "p": 0.6},
            },
            "nodes": {"a": {}, "b": {}, "c": {}, "d": {}},
        }
        d = serialise_design(truth)
        assert d["topology"] == "diamond"

    def test_sparsity_included(self):
        truth = {
            "simulation": {
                "frame_drop_rate": 0.2,
                "toggle_rate": 0.03,
                "initial_absent_pct": 0.25,
            },
            "edges": {"e1": {"from": "a", "to": "b", "p": 0.5}},
            "nodes": {"a": {}, "b": {}},
        }
        d = serialise_design(truth)
        assert "sparsity" in d
        assert d["sparsity"]["frame_drop_rate"] == 0.2
        assert d["sparsity"]["toggle_rate"] == 0.03

    def test_no_sparsity_when_zero(self):
        truth = {
            "simulation": {"frame_drop_rate": 0, "toggle_rate": 0},
            "edges": {"e1": {"from": "a", "to": "b", "p": 0.5}},
            "nodes": {"a": {}, "b": {}},
        }
        d = serialise_design(truth)
        assert "sparsity" not in d

    def test_context_dimensions(self):
        truth = {
            "simulation": {},
            "edges": {"e1": {"from": "a", "to": "b", "p": 0.5}},
            "nodes": {"a": {}, "b": {}},
            "context_dimensions": [
                {"id": "channel", "mece": True,
                 "values": [{"id": "g"}, {"id": "d"}, {"id": "e"}]},
            ],
        }
        d = serialise_design(truth)
        assert len(d["context_dimensions"]) == 1
        assert d["context_dimensions"][0]["id"] == "channel"
        assert d["context_dimensions"][0]["n_values"] == 3
        assert d["context_dimensions"][0]["mece"] is True

    def test_lifecycle_values(self):
        truth = {
            "simulation": {},
            "edges": {"e1": {"from": "a", "to": "b", "p": 0.5}},
            "nodes": {"a": {}, "b": {}},
            "context_dimensions": [
                {"id": "treatment", "mece": True, "values": [
                    {"id": "baseline", "weight": 0.5},
                    {"id": "b", "weight": 0.3, "active_to_day": 65},
                    {"id": "c", "weight": 0.2, "active_from_day": 33},
                ]},
            ],
        }
        d = serialise_design(truth)
        lc = d["context_dimensions"][0]["lifecycles"]
        assert len(lc) == 2
        assert lc[0]["value"] == "b"
        assert lc[0]["active_to_day"] == 65
        assert lc[1]["value"] == "c"
        assert lc[1]["active_from_day"] == 33

    def test_epochs(self):
        truth = {
            "simulation": {},
            "edges": {"e1": {"from": "a", "to": "b", "p": 0.5}},
            "nodes": {"a": {}, "b": {}},
            "epochs": [
                {"label": "bare", "from_day": 0, "to_day": 44},
                {"label": "contexted", "from_day": 45, "to_day": 89},
            ],
        }
        d = serialise_design(truth)
        assert len(d["epochs"]) == 2
        assert d["epochs"][0]["label"] == "bare"

    def test_design_in_serialise_result(self):
        """design block appears when truth_config is present."""
        r = {
            "graph_name": "g",
            "passed": True,
            "parsed_edges": {},
            "parsed_slices": {},
            "truth_config": {
                "simulation": {"n_days": 90, "mean_daily_traffic": 300,
                                "frame_drop_rate": 0.15},
                "edges": {"e1": {"from": "a", "to": "b", "p": 0.5}},
                "nodes": {"a": {}, "b": {}},
                "context_dimensions": [
                    {"id": "ch", "mece": True, "values": [
                        {"id": "g"}, {"id": "d", "active_to_day": 60}]},
                ],
            },
        }
        s = serialise_result(r)
        assert "design" in s
        assert s["design"]["topology"] == "solo"
        assert s["design"]["sparsity"]["frame_drop_rate"] == 0.15
        assert s["design"]["context_dimensions"][0]["lifecycles"][0]["active_to_day"] == 60


# ---------------------------------------------------------------------------
# classify_status — status = "fail" | "completed"
# ---------------------------------------------------------------------------

class TestClassifyStatus:
    """Status classification separates infrastructure failures from
    completed runs. Completed runs may still have quality issues, but
    those are a separate concern — the binary PASS/FAIL construct is
    retired."""

    def test_harness_failure_is_fail(self):
        failures = [{"type": "harness", "message": "crashed"}]
        assert classify_status(False, failures, {"rhat": 1.0}) == "fail"

    def test_timeout_is_fail(self):
        failures = [{"type": "timeout", "message": "out of time"}]
        assert classify_status(False, failures, {"rhat": 1.0}) == "fail"

    def test_empty_quality_is_fail(self):
        assert classify_status(True, [], {}) == "fail"
        assert classify_status(True, [], None) == "fail"

    def test_quality_with_none_metrics_is_fail(self):
        q = {"rhat": None, "ess": None, "converged_pct": None}
        assert classify_status(True, [], q) == "fail"

    def test_quality_present_is_completed(self):
        q = {"rhat": 1.001, "ess": 5000, "converged_pct": 100}
        assert classify_status(True, [], q) == "completed"

    def test_zscore_failure_still_completed(self):
        """z-score misses are quality issues, not infrastructure failures —
        the run produced a posterior."""
        failures = [{"type": "z_score", "message": "big miss"}]
        q = {"rhat": 1.001, "ess": 5000, "converged_pct": 100}
        assert classify_status(False, failures, q) == "completed"

    def test_convergence_failure_still_completed(self):
        """Convergence thresholds missed does not mean no posterior —
        graph completed but quality is poor."""
        failures = [{"type": "convergence", "message": "rhat high"}]
        q = {"rhat": 1.5, "ess": 10, "converged_pct": 0}
        assert classify_status(False, failures, q) == "completed"

    def test_binding_failure_is_fail(self):
        """Zero edges bound → posteriors from priors only, not the data.
        Must not be confused with a clean completion."""
        failures = [{"type": "binding", "message": "0 bound"}]
        q = {"rhat": 1.001, "ess": 5000, "converged_pct": 100}
        assert classify_status(False, failures, q) == "fail"

    def test_missing_edge_is_fail(self):
        """Truth edge has no posterior — model didn't emit variables
        for the edges the truth expected. This is an infrastructure
        problem, not a quality issue."""
        failures = [{"type": "missing_edge", "edge": "e1", "message": "gone"}]
        q = {"rhat": 1.001, "ess": 5000, "converged_pct": 100}
        assert classify_status(False, failures, q) == "fail"

    def test_missing_slice_is_fail(self):
        failures = [{"type": "missing_slice", "slice": "ctx-a", "message": "gone"}]
        q = {"rhat": 1.001, "ess": 5000, "converged_pct": 100}
        assert classify_status(False, failures, q) == "fail"

    def test_audit_alone_is_completed(self):
        """Audit-layer warnings are soft signals — the run produced
        posteriors, so the status stays completed. The verdict is
        downgraded in classify_quality."""
        failures = [{"type": "audit", "message": "kappa_lat mismatch"}]
        q = {"rhat": 1.001, "ess": 5000, "converged_pct": 100}
        assert classify_status(False, failures, q) == "completed"


# ---------------------------------------------------------------------------
# classify_convergence
# ---------------------------------------------------------------------------

class TestClassifyConvergence:
    def test_unknown_when_empty(self):
        assert classify_convergence(None)["verdict"] == "unknown"
        assert classify_convergence({})["verdict"] == "unknown"

    def test_all_within_thresholds_is_ok(self):
        q = {"rhat": 1.001, "ess": 5000, "converged_pct": 100}
        c = classify_convergence(q)
        assert c["verdict"] == "ok"
        assert c["breaches"] == []

    def test_marginal_rhat_is_degraded(self):
        q = {"rhat": 1.08, "ess": 5000, "converged_pct": 100}
        assert classify_convergence(q)["verdict"] == "degraded"

    def test_severe_rhat_is_failed(self):
        q = {"rhat": 1.5, "ess": 5000, "converged_pct": 100}
        assert classify_convergence(q)["verdict"] == "failed"

    def test_low_ess_is_degraded_or_failed(self):
        q = {"rhat": 1.001, "ess": 100, "converged_pct": 100}
        assert classify_convergence(q)["verdict"] == "degraded"
        q = {"rhat": 1.001, "ess": 10, "converged_pct": 100}
        assert classify_convergence(q)["verdict"] == "failed"

    def test_multiple_breaches_reported(self):
        q = {"rhat": 1.08, "ess": 100, "converged_pct": 80}
        c = classify_convergence(q)
        # degraded on all three axes
        assert c["verdict"] == "degraded"
        assert len(c["breaches"]) == 3


# ---------------------------------------------------------------------------
# classify_bias
# ---------------------------------------------------------------------------

class TestClassifyBias:
    def test_empty_profile_returns_empty(self):
        assert classify_bias(None) == {}
        assert classify_bias({}) == {}

    def test_small_bias_is_ok(self):
        profile = {
            "p": {
                "n": 10, "mean_bias": 0.005, "direction": "+",
                "consistency": "6/10", "max_z": 1.0,
            },
        }
        assert classify_bias(profile)["p"]["verdict"] == "ok"

    def test_large_consistent_bias_is_biased(self):
        profile = {
            "p": {
                "n": 10, "mean_bias": 0.08, "direction": "+",
                "consistency": "9/10", "max_z": 10.0,
            },
        }
        assert classify_bias(profile)["p"]["verdict"] == "biased"

    def test_large_inconsistent_bias_is_ok(self):
        """Large mean bias but direction split ~50/50 → not systematic."""
        profile = {
            "p": {
                "n": 10, "mean_bias": 0.08, "direction": "~",
                "consistency": "5/10", "max_z": 10.0,
            },
        }
        assert classify_bias(profile)["p"]["verdict"] == "ok"

    def test_small_sample_never_biased(self):
        """n=2 below min_n=3 — never flagged as systematic."""
        profile = {
            "p": {
                "n": 2, "mean_bias": 0.5, "direction": "+",
                "consistency": "2/2", "max_z": 20.0,
            },
        }
        assert classify_bias(profile)["p"]["verdict"] == "ok"


# ---------------------------------------------------------------------------
# classify_quality — combined verdict
# ---------------------------------------------------------------------------

class TestClassifyQuality:
    def test_clean_when_all_ok(self):
        q = {"rhat": 1.001, "ess": 5000, "converged_pct": 100}
        result = classify_quality(q, {}, [])
        assert result["verdict"] == "clean"

    def test_systematic_bias_verdict(self):
        q = {"rhat": 1.001, "ess": 5000, "converged_pct": 100}
        bias = {
            "p": {
                "n": 10, "mean_bias": 0.08, "direction": "+",
                "consistency": "9/10", "max_z": 10.0,
            },
        }
        result = classify_quality(q, bias, [])
        assert result["verdict"] == "systematic_bias"
        assert "p" in result["biased_params"]

    def test_convergence_global_failure(self):
        q = {"rhat": 1.5, "ess": 10, "converged_pct": 0}
        result = classify_quality(q, {}, [])
        assert result["verdict"] == "convergence_global_failure"

    def test_bias_and_convergence_issues(self):
        q = {"rhat": 1.5, "ess": 10, "converged_pct": 0}
        bias = {
            "p": {
                "n": 10, "mean_bias": 0.08, "direction": "+",
                "consistency": "9/10", "max_z": 10.0,
            },
        }
        result = classify_quality(q, bias, [])
        assert result["verdict"] == "bias_and_convergence_issues"

    def test_point_convergence_failure(self):
        """Global convergence ok but point-level convergence failure
        flagged by the assertion layer."""
        q = {"rhat": 1.001, "ess": 5000, "converged_pct": 100}
        failures = [{"type": "convergence", "edge": "e1", "message": "point"}]
        result = classify_quality(q, {}, failures)
        assert result["verdict"] == "convergence_point_failure"

    def test_z_score_miss_is_bias_issue(self):
        q = {"rhat": 1.001, "ess": 5000, "converged_pct": 100}
        failures = [{"type": "z_score", "edge": "e1", "param": "p",
                     "message": "big z"}]
        result = classify_quality(q, {}, failures)
        # z-score points count as bias_points → systematic_bias verdict
        assert result["verdict"] == "systematic_bias"
        assert len(result["bias_points"]) == 1

    def test_data_integrity_warning_verdict(self):
        """An audit flag alone (e.g. kappa_lat mismatch) surfaces as a
        softer verdict than a bias or convergence issue."""
        q = {"rhat": 1.001, "ess": 5000, "converged_pct": 100}
        failures = [{"type": "audit", "message": "KAPPA_LAT: 0 variables"}]
        result = classify_quality(q, {}, failures)
        assert result["verdict"] == "data_integrity_warning"
        assert len(result["data_integrity_points"]) == 1
