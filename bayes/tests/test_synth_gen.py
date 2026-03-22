"""
Synthetic data generator round-trip tests.

Tests that simulate_graph() produces snapshot-format rows that
bind_snapshot_evidence() can consume, and that the resulting
evidence has the correct structure (trajectories, obs_type,
monotonicity, denominators).

Run with:
    cd /home/reg/dev/dagnet
    . graph-editor/venv/bin/activate
    pytest bayes/tests/test_synth_gen.py -v --tb=short
"""

from __future__ import annotations

import math
import numpy as np
import pytest

from bayes.compiler import analyse_topology, bind_snapshot_evidence
from bayes.compiler.types import CohortDailyTrajectory
from bayes.synth_gen import (
    simulate_graph,
    _build_hash_lookup,
    GRAPH_CONFIGS,
    DEFAULT_SIM_CONFIG,
    derive_truth_from_graph,
)
from bayes.tests.synthetic import _node, _edge


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_simple_graph():
    """Minimal 3-edge linear graph with latency on one edge."""
    graph = {
        "nodes": [
            _node("node-anchor", is_start=True),
            _node("node-a"),
            _node("node-b"),
            _node("node-c", absorbing=True),
        ],
        "edges": [
            _edge("edge-anchor-a", "node-anchor", "node-a", "param-anchor-a", p_mean=0.9),
            _edge("edge-a-b", "node-a", "node-b", "param-a-b", p_mean=0.4,
                  latency={"latency_parameter": True, "onset_delta_days": 2.0,
                           "mu": 2.0, "sigma": 0.5, "median_lag_days": 9.4,
                           "mean_lag_days": 10.3}),
            _edge("edge-b-c", "node-b", "node-c", "param-b-c", p_mean=0.6),
        ],
    }
    return graph


def _make_branch_graph():
    """A → {B, C} branch group + solo D."""
    graph = {
        "nodes": [
            _node("node-anchor", is_start=True),
            _node("node-a"),
            _node("node-b", absorbing=True, event_id="evt-b"),
            _node("node-c", absorbing=True, event_id="evt-c"),
            _node("node-d", absorbing=True),
        ],
        "edges": [
            _edge("edge-anchor-a", "node-anchor", "node-a", "param-anchor-a", p_mean=0.9),
            _edge("edge-a-b", "node-a", "node-b", "param-a-b", p_mean=0.3),
            _edge("edge-a-c", "node-a", "node-c", "param-a-c", p_mean=0.4),
            _edge("edge-a-d", "node-a", "node-d", "param-a-d", p_mean=0.2),
        ],
    }
    return graph


def _make_truth(topology, graph):
    """Derive truth config from graph metadata."""
    return derive_truth_from_graph(graph, topology)


def _make_hash_lookup(topology):
    """Build synthetic hash lookup for test edges."""
    lookup = {}
    for edge_id, et in topology.edges.items():
        pid = et.param_id
        lookup[pid] = {
            "window_hash": f"TEST-W-{pid}",
            "cohort_hash": f"TEST-C-{pid}",
        }
    return lookup


def _run_simulate(graph, *, n_days=30, mean_daily_traffic=200, seed=42,
                  kappa=50.0, drift_sigma=0.0, failure_rate=0.0):
    """Run simulate_graph with test-friendly defaults."""
    topology = analyse_topology(graph)
    truth = _make_truth(topology, graph)
    hash_lookup = _make_hash_lookup(topology)

    sim_config = {
        "n_days": n_days,
        "mean_daily_traffic": mean_daily_traffic,
        "kappa_sim_default": kappa,
        "drift_sigma": drift_sigma,
        "failure_rate": failure_rate,
        "seed": seed,
        "base_date": "2025-11-01",
    }

    snapshot_rows, sim_stats = simulate_graph(
        graph, topology, truth, sim_config, hash_lookup,
    )
    return topology, snapshot_rows, sim_stats


# ---------------------------------------------------------------------------
# Tests: basic simulation structure
# ---------------------------------------------------------------------------

class TestSimulateGraphStructure:
    """simulate_graph produces rows with correct fields and structure."""

    def test_produces_rows_for_all_evented_edges(self):
        """Every edge with a param_id should have snapshot rows."""
        graph = _make_simple_graph()
        topology, rows, stats = _run_simulate(graph)

        evented_edges = {eid for eid, et in topology.edges.items() if et.param_id}
        assert set(rows.keys()) == evented_edges

    def test_row_has_required_fields(self):
        """Each row must have the fields bind_snapshot_evidence expects."""
        required = {"param_id", "core_hash", "slice_key", "anchor_day",
                    "retrieved_at", "a", "x", "y"}
        graph = _make_simple_graph()
        _, rows, _ = _run_simulate(graph)

        for edge_id, edge_rows in rows.items():
            for row in edge_rows[:5]:  # spot-check first 5
                assert required.issubset(row.keys()), (
                    f"Row for {edge_id} missing fields: {required - row.keys()}"
                )

    def test_window_rows_have_x_denominator_and_null_a(self):
        """Window rows use x as denominator, a should be None."""
        graph = _make_simple_graph()
        _, rows, _ = _run_simulate(graph)

        for edge_rows in rows.values():
            window_rows = [r for r in edge_rows if "window" in r["slice_key"]]
            for r in window_rows[:10]:
                assert r["x"] is not None and r["x"] > 0
                assert r["a"] is None

    def test_cohort_rows_have_a_denominator(self):
        """Cohort rows use a (anchor entrants) as denominator."""
        graph = _make_simple_graph()
        _, rows, _ = _run_simulate(graph)

        for edge_rows in rows.values():
            cohort_rows = [r for r in edge_rows if "cohort" in r["slice_key"]]
            for r in cohort_rows[:10]:
                assert r["a"] is not None and r["a"] > 0

    def test_y_never_exceeds_denominator(self):
        """Y count must not exceed the relevant denominator."""
        graph = _make_simple_graph()
        _, rows, _ = _run_simulate(graph)

        for edge_rows in rows.values():
            for r in edge_rows:
                if "window" in r["slice_key"]:
                    assert r["y"] <= r["x"], (
                        f"Window y={r['y']} > x={r['x']} on {r['anchor_day']}"
                    )
                else:
                    assert r["y"] <= r["a"], (
                        f"Cohort y={r['y']} > a={r['a']} on {r['anchor_day']}"
                    )

    def test_nightly_fetch_model_produces_multiple_retrieval_ages(self):
        """Each anchor_day should be observed at multiple retrieval ages
        (once per successful fetch night after the anchor day)."""
        graph = _make_simple_graph()
        _, rows, _ = _run_simulate(graph, n_days=30, failure_rate=0.0)

        # Pick the first edge and earliest anchor_day
        first_edge = list(rows.keys())[0]
        edge_rows = rows[first_edge]
        window_rows = [r for r in edge_rows if "window" in r["slice_key"]]

        anchor_days = set(r["anchor_day"] for r in window_rows)
        # The earliest anchor_day should have ~29 retrieval ages (day 0
        # observed on days 1..29)
        earliest = min(anchor_days)
        retrievals = [r for r in window_rows if r["anchor_day"] == earliest]
        assert len(retrievals) >= 10, (
            f"Expected many retrievals for earliest day, got {len(retrievals)}"
        )

    def test_fetch_failures_reduce_row_count(self):
        """With failure_rate > 0, some fetch nights are skipped,
        resulting in fewer total rows."""
        graph = _make_simple_graph()
        _, rows_no_fail, _ = _run_simulate(graph, n_days=50, failure_rate=0.0, seed=99)
        _, rows_with_fail, _ = _run_simulate(graph, n_days=50, failure_rate=0.3, seed=99)

        total_no_fail = sum(len(v) for v in rows_no_fail.values())
        total_with_fail = sum(len(v) for v in rows_with_fail.values())
        assert total_with_fail < total_no_fail

    def test_deterministic_with_same_seed(self):
        """Same seed produces identical rows."""
        graph = _make_simple_graph()
        _, rows1, _ = _run_simulate(graph, seed=123)
        _, rows2, _ = _run_simulate(graph, seed=123)

        for eid in rows1:
            assert len(rows1[eid]) == len(rows2[eid])
            for r1, r2 in zip(rows1[eid], rows2[eid]):
                assert r1["y"] == r2["y"]
                assert r1["anchor_day"] == r2["anchor_day"]


# ---------------------------------------------------------------------------
# Tests: round-trip through evidence binder
# ---------------------------------------------------------------------------

class TestRoundTripEvidence:
    """simulate_graph → bind_snapshot_evidence produces valid evidence."""

    def test_evidence_binds_without_error(self):
        """The binder accepts synth_gen rows without crashing."""
        graph = _make_simple_graph()
        topology, rows, stats = _run_simulate(graph, n_days=30)

        param_files = {
            et.param_id: {"id": et.param_id, "values": []}
            for et in topology.edges.values() if et.param_id
        }

        evidence = bind_snapshot_evidence(
            topology, rows, param_files, today="1-Dec-25",
        )
        assert evidence is not None
        assert len(evidence.edges) == len(topology.edges)

    def test_all_edges_have_observations(self):
        """Every evented edge should have bound observations (not skipped)."""
        graph = _make_simple_graph()
        topology, rows, stats = _run_simulate(graph, n_days=30)

        param_files = {
            et.param_id: {"id": et.param_id, "values": []}
            for et in topology.edges.values() if et.param_id
        }

        evidence = bind_snapshot_evidence(
            topology, rows, param_files, today="1-Dec-25",
        )

        for edge_id, ev in evidence.edges.items():
            assert not ev.skipped, (
                f"Edge {edge_id} was skipped: {ev.skip_reason}"
            )
            assert ev.total_n > 0, f"Edge {edge_id} has total_n=0"

    def test_window_and_cohort_observations_present(self):
        """Both window and cohort obs_types should be produced since
        simulate_graph emits both for every edge."""
        graph = _make_simple_graph()
        topology, rows, stats = _run_simulate(graph, n_days=30)

        param_files = {
            et.param_id: {"id": et.param_id, "values": []}
            for et in topology.edges.values() if et.param_id
        }

        evidence = bind_snapshot_evidence(
            topology, rows, param_files, today="1-Dec-25",
        )

        for edge_id, ev in evidence.edges.items():
            assert ev.has_window, f"Edge {edge_id} missing window observations"
            assert ev.has_cohort, f"Edge {edge_id} missing cohort observations"

    def test_trajectories_have_monotonic_y(self):
        """Cumulative Y in each trajectory must be non-decreasing."""
        graph = _make_simple_graph()
        topology, rows, stats = _run_simulate(graph, n_days=40)

        param_files = {
            et.param_id: {"id": et.param_id, "values": []}
            for et in topology.edges.values() if et.param_id
        }

        evidence = bind_snapshot_evidence(
            topology, rows, param_files, today="1-Dec-25",
        )

        for edge_id, ev in evidence.edges.items():
            for co in ev.cohort_obs:
                for traj in co.trajectories:
                    for i in range(1, len(traj.cumulative_y)):
                        assert traj.cumulative_y[i] >= traj.cumulative_y[i - 1], (
                            f"Non-monotonic Y on {edge_id}, date={traj.date}: "
                            f"{traj.cumulative_y}"
                        )

    def test_trajectories_have_ascending_retrieval_ages(self):
        """Retrieval ages within each trajectory must be sorted ascending."""
        graph = _make_simple_graph()
        topology, rows, stats = _run_simulate(graph, n_days=40)

        param_files = {
            et.param_id: {"id": et.param_id, "values": []}
            for et in topology.edges.values() if et.param_id
        }

        evidence = bind_snapshot_evidence(
            topology, rows, param_files, today="1-Dec-25",
        )

        for edge_id, ev in evidence.edges.items():
            for co in ev.cohort_obs:
                for traj in co.trajectories:
                    for i in range(1, len(traj.retrieval_ages)):
                        assert traj.retrieval_ages[i] > traj.retrieval_ages[i - 1], (
                            f"Non-ascending ages on {edge_id}, date={traj.date}: "
                            f"{traj.retrieval_ages}"
                        )

    def test_trajectory_y_never_exceeds_n(self):
        """No cumulative_y value should exceed the trajectory denominator n."""
        graph = _make_simple_graph()
        topology, rows, stats = _run_simulate(graph, n_days=40)

        param_files = {
            et.param_id: {"id": et.param_id, "values": []}
            for et in topology.edges.values() if et.param_id
        }

        evidence = bind_snapshot_evidence(
            topology, rows, param_files, today="1-Dec-25",
        )

        for edge_id, ev in evidence.edges.items():
            for co in ev.cohort_obs:
                for traj in co.trajectories:
                    for y in traj.cumulative_y:
                        assert y <= traj.n, (
                            f"Y={y} > n={traj.n} on {edge_id}, date={traj.date}"
                        )

    def test_trajectory_obs_type_matches_slice_key(self):
        """Window rows produce obs_type='window', cohort rows produce 'cohort'."""
        graph = _make_simple_graph()
        topology, rows, stats = _run_simulate(graph, n_days=30)

        param_files = {
            et.param_id: {"id": et.param_id, "values": []}
            for et in topology.edges.values() if et.param_id
        }

        evidence = bind_snapshot_evidence(
            topology, rows, param_files, today="1-Dec-25",
        )

        for ev in evidence.edges.values():
            for co in ev.cohort_obs:
                if "window" in co.slice_dsl:
                    for traj in co.trajectories:
                        assert traj.obs_type == "window", (
                            f"Expected obs_type='window' for {co.slice_dsl}, "
                            f"got '{traj.obs_type}'"
                        )
                elif "cohort" in co.slice_dsl:
                    for traj in co.trajectories:
                        assert traj.obs_type == "cohort", (
                            f"Expected obs_type='cohort' for {co.slice_dsl}, "
                            f"got '{traj.obs_type}'"
                        )


# ---------------------------------------------------------------------------
# Tests: branch group simulation
# ---------------------------------------------------------------------------

class TestBranchGroupSimulation:
    """Branch groups produce consistent multinomial-style evidence."""

    def test_branch_group_edges_have_rows(self):
        """All edges in a branch group produce snapshot rows."""
        graph = _make_branch_graph()
        topology, rows, stats = _run_simulate(graph, n_days=20)

        for eid in ["edge-a-b", "edge-a-c", "edge-a-d"]:
            assert eid in rows, f"Branch edge {eid} missing from rows"
            assert len(rows[eid]) > 0, f"Branch edge {eid} has 0 rows"

    def test_branch_sibling_k_sums_do_not_exceed_source_n(self):
        """For a given anchor_day and retrieval, the sum of sibling Y values
        (window) should not exceed the source node's count (x)."""
        graph = _make_branch_graph()
        topology, rows, stats = _run_simulate(graph, n_days=20, seed=77)

        sibling_edges = ["edge-a-b", "edge-a-c", "edge-a-d"]

        # Group window rows by (anchor_day, retrieved_at)
        from collections import defaultdict
        by_key: dict[tuple, dict[str, dict]] = defaultdict(dict)
        for eid in sibling_edges:
            for r in rows.get(eid, []):
                if "window" in r["slice_key"]:
                    key = (r["anchor_day"], r["retrieved_at"])
                    by_key[key][eid] = r

        # Check: sum(y) <= max(x) across siblings
        for key, edge_rows in list(by_key.items())[:50]:
            y_sum = sum(r["y"] for r in edge_rows.values())
            # All siblings share the same source node, so x should be
            # consistent across them (same from_node count)
            x_vals = [r["x"] for r in edge_rows.values()]
            max_x = max(x_vals)
            assert y_sum <= max_x, (
                f"Sibling y sum {y_sum} exceeds source x {max_x} "
                f"at {key}"
            )

    def test_branch_evidence_binds_correctly(self):
        """Branch graph evidence binds with correct obs_types."""
        graph = _make_branch_graph()
        topology, rows, stats = _run_simulate(graph, n_days=20)

        param_files = {
            et.param_id: {"id": et.param_id, "values": []}
            for et in topology.edges.values() if et.param_id
        }

        evidence = bind_snapshot_evidence(
            topology, rows, param_files, today="1-Dec-25",
        )

        for eid in ["edge-a-b", "edge-a-c", "edge-a-d"]:
            ev = evidence.edges[eid]
            assert not ev.skipped, f"Branch edge {eid} was skipped"
            assert ev.has_window, f"Branch edge {eid} missing window obs"
            assert ev.total_n > 0


# ---------------------------------------------------------------------------
# Tests: drift
# ---------------------------------------------------------------------------

class TestDrift:
    """Random-walk drift produces time-varying effective probabilities."""

    def test_drift_produces_autocorrelated_rates(self):
        """With drift enabled, daily conversion rates should be
        autocorrelated (random walk), unlike the i.i.d. overdispersion
        case. We measure lag-1 autocorrelation."""
        graph = _make_simple_graph()

        _, rows_drift, _ = _run_simulate(
            graph, n_days=100, drift_sigma=0.15, kappa=500.0, seed=77,
        )

        # Compute per-day conversion rates for edge-a-b from edge_daily
        # (more direct than aggregating rows)
        from collections import defaultdict
        by_day = defaultdict(lambda: {"x": 0, "y": 0})
        for r in rows_drift["edge-a-b"]:
            if "window" not in r["slice_key"]:
                continue
            d = r["anchor_day"]
            by_day[d]["x"] = max(by_day[d]["x"], r["x"])
            by_day[d]["y"] = max(by_day[d]["y"], r["y"])

        # Sort by day
        sorted_days = sorted(by_day.keys())
        rates = [by_day[d]["y"] / by_day[d]["x"]
                 for d in sorted_days if by_day[d]["x"] > 0]

        assert len(rates) >= 50, f"Expected >=50 daily rates, got {len(rates)}"

        # Lag-1 autocorrelation: a random walk should show positive autocorrelation
        rates_arr = np.array(rates)
        mean_r = rates_arr.mean()
        denom = np.sum((rates_arr - mean_r) ** 2)
        if denom > 0:
            numer = np.sum((rates_arr[1:] - mean_r) * (rates_arr[:-1] - mean_r))
            autocorr = numer / denom
        else:
            autocorr = 0.0

        assert autocorr > 0.1, (
            f"Expected positive autocorrelation from drift, got {autocorr:.3f}"
        )


# ---------------------------------------------------------------------------
# Tests: core hash consistency
# ---------------------------------------------------------------------------

class TestCoreHashes:
    """Rows use correct core hashes from the hash lookup."""

    def test_window_rows_use_window_hash(self):
        graph = _make_simple_graph()
        topology, rows, _ = _run_simulate(graph)

        hash_lookup = _make_hash_lookup(topology)
        for edge_id, edge_rows in rows.items():
            et = topology.edges[edge_id]
            expected_w = hash_lookup[et.param_id]["window_hash"]
            expected_c = hash_lookup[et.param_id]["cohort_hash"]
            for r in edge_rows:
                if "window" in r["slice_key"]:
                    assert r["core_hash"] == expected_w, (
                        f"Window row hash {r['core_hash']} != {expected_w}"
                    )
                elif "cohort" in r["slice_key"]:
                    assert r["core_hash"] == expected_c, (
                        f"Cohort row hash {r['core_hash']} != {expected_c}"
                    )


# ---------------------------------------------------------------------------
# Tests: sim_stats / edge_daily
# ---------------------------------------------------------------------------

class TestSimStats:
    """sim_stats contains expected metadata."""

    def test_edge_daily_arrays_match_n_days(self):
        """edge_daily n_daily/k_daily/dates arrays should have n_days entries."""
        graph = _make_simple_graph()
        _, _, stats = _run_simulate(graph, n_days=25)

        for edge_id, daily in stats["edge_daily"].items():
            assert len(daily["n_daily"]) == 25
            assert len(daily["k_daily"]) == 25
            assert len(daily["dates"]) == 25

    def test_edge_daily_k_never_exceeds_n(self):
        """Per-day k (to_node arrivals) should not exceed n (from_node arrivals)."""
        graph = _make_simple_graph()
        _, _, stats = _run_simulate(graph, n_days=30)

        for edge_id, daily in stats["edge_daily"].items():
            for d_idx in range(len(daily["n_daily"])):
                assert daily["k_daily"][d_idx] <= daily["n_daily"][d_idx], (
                    f"Day {d_idx} of {edge_id}: k={daily['k_daily'][d_idx]} "
                    f"> n={daily['n_daily'][d_idx]}"
                )

    def test_total_rows_matches_sum(self):
        graph = _make_simple_graph()
        _, rows, stats = _run_simulate(graph, n_days=20)

        expected = sum(len(v) for v in rows.values())
        assert stats["total_rows"] == expected
