"""
Tests for bayes_reset flag in the evidence binder (doc 19 §4.5).

Verifies that:
  - When bayes_reset is set on a param file, the evidence binder skips
    warm-start from previous posteriors for both probability and latency.
  - When bayes_reset is NOT set and a previous posterior exists,
    warm-start is used (regression guard).
  - When bayes_reset is set but no posterior exists, nothing breaks.
"""

from __future__ import annotations

import pytest

from bayes.compiler import analyse_topology, bind_evidence
from bayes.tests.synthetic import _node, _edge, _window_param_file


def _build_solo_edge_graph():
    """Minimal graph with one solo edge and one param file."""
    nodes = [
        _node("anchor", is_start=True, event_id="ev_anchor"),
        _node("target", event_id="ev_target"),
    ]
    edges = [
        _edge("edge-a-b", "anchor", "target", "param-ab",
              latency={"latency_parameter": True, "mu": 2.0, "sigma": 0.4,
                        "onset_delta_days": 1.0, "t95": 30}),
    ]
    graph = {"nodes": nodes, "edges": edges}
    return graph


def _param_file_with_posterior(*, bayes_reset: bool = False):
    """Param file with a previous Bayesian posterior and optional bayes_reset."""
    pf = _window_param_file(500, 175, param_id="param-ab")
    # Add a previous posterior (warm-start source)
    pf["posterior"] = {
        "fitted_at": "1-Feb-25",
        "fingerprint": "abc123",
        "hdi_level": 0.9,
        "prior_tier": "direct_history",
        "slices": {
            "window()": {
                "alpha": 80.0,
                "beta": 200.0,
                "mu_mean": 2.5,
                "sigma_mean": 0.35,
                "ess": 500,
                "rhat": 1.001,
                "provenance": "bayesian",
            }
        },
        "fit_history": [
            {"fitted_at": "1-Jan-25", "fingerprint": "old",
             "slices": {"window()": {"alpha": 70, "beta": 190}}}
        ],
    }
    # Add latency block
    pf["latency"] = {
        "latency_parameter": True,
        "mu": 2.0,
        "sigma": 0.4,
        "onset_delta_days": 1.0,
        "t95": 30,
    }
    if bayes_reset:
        pf["latency"]["bayes_reset"] = True
    return pf


class TestBayesResetLatencyPrior:
    """Evidence binder should skip latency warm-start when bayes_reset is set."""

    def test_warm_start_used_when_no_reset(self):
        graph = _build_solo_edge_graph()
        param_files = {"param-ab": _param_file_with_posterior(bayes_reset=False)}
        topology = analyse_topology(graph)
        evidence = bind_evidence(topology, param_files, today="1-Mar-25")

        ev = evidence.edges["edge-a-b"]
        assert ev.latency_prior is not None
        assert ev.latency_prior.source == "warm_start"
        # Should use posterior values, not topology-derived
        assert abs(ev.latency_prior.mu - 2.5) < 0.01
        assert abs(ev.latency_prior.sigma - 0.35) < 0.01

    def test_warm_start_skipped_when_reset(self):
        graph = _build_solo_edge_graph()
        param_files = {"param-ab": _param_file_with_posterior(bayes_reset=True)}
        topology = analyse_topology(graph)
        evidence = bind_evidence(topology, param_files, today="1-Mar-25")

        ev = evidence.edges["edge-a-b"]
        assert ev.latency_prior is not None
        assert ev.latency_prior.source == "topology"
        # Should use topology-derived values (from graph edge mu/sigma)
        assert abs(ev.latency_prior.mu - 2.0) < 0.01
        assert abs(ev.latency_prior.sigma - 0.4) < 0.01

    def test_reset_with_no_posterior_is_harmless(self):
        graph = _build_solo_edge_graph()
        pf = _window_param_file(500, 175, param_id="param-ab")
        pf["latency"] = {
            "latency_parameter": True,
            "mu": 2.0,
            "sigma": 0.4,
            "onset_delta_days": 1.0,
            "t95": 30,
            "bayes_reset": True,
        }
        param_files = {"param-ab": pf}
        topology = analyse_topology(graph)
        evidence = bind_evidence(topology, param_files, today="1-Mar-25")

        ev = evidence.edges["edge-a-b"]
        assert ev.latency_prior is not None
        assert ev.latency_prior.source == "topology"


class TestBayesResetProbabilityPrior:
    """Evidence binder should skip probability warm-start when bayes_reset is set."""

    def test_warm_start_used_when_no_reset(self):
        graph = _build_solo_edge_graph()
        param_files = {"param-ab": _param_file_with_posterior(bayes_reset=False)}
        topology = analyse_topology(graph)
        evidence = bind_evidence(topology, param_files, today="1-Mar-25")

        ev = evidence.edges["edge-a-b"]
        assert ev.prob_prior is not None
        assert ev.prob_prior.source == "warm_start"
        # Should use posterior alpha/beta
        assert ev.prob_prior.alpha > 1.0  # not uninformative
        assert ev.prob_prior.beta > 1.0

    def test_warm_start_skipped_when_reset(self):
        graph = _build_solo_edge_graph()
        param_files = {"param-ab": _param_file_with_posterior(bayes_reset=True)}
        topology = analyse_topology(graph)
        evidence = bind_evidence(topology, param_files, today="1-Mar-25")

        ev = evidence.edges["edge-a-b"]
        assert ev.prob_prior is not None
        # Should NOT be warm_start — should fall through to moment-matched
        # or uninformative
        assert ev.prob_prior.source != "warm_start"
