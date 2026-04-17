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
    compute_bias_profile,
    serialise_audit,
    serialise_result,
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
