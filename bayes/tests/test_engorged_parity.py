"""Engorged graph parity tests.

Verifies that bind_snapshot_evidence produces identical EdgeEvidence
(measured by content_hash) whether priors come from param files
(legacy path) or from _bayes_priors on graph edges (engorged path).

All tests use snapshot rows — the normal production scenario. Bayes
always has snapshot data when it runs. The tests exercise the
combined path: snapshot trajectories + priors from file-based source.
"""

import copy
import sys
from pathlib import Path

import pytest

repo_root = str(Path(__file__).resolve().parent.parent.parent)
if repo_root not in sys.path:
    sys.path.insert(0, repo_root)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(repo_root) / "graph-editor" / "lib"))

from compiler.types import TopologyAnalysis, EdgeTopology, BranchGroup
from compiler.evidence import (
    bind_snapshot_evidence,
    engorge_graph_for_test,
)
from compiler.topology import analyse_topology


# ---------------------------------------------------------------------------
# Fixtures: graph + param files + snapshot rows
# ---------------------------------------------------------------------------

def _make_snapshot_rows(edge_id: str, core_hash: str, n_days: int = 10,
                        base_x: int = 100, base_y: int = 30,
                        obs_type: str = "window") -> list[dict]:
    """Generate realistic snapshot DB rows for one edge.

    Each row has one anchor_day and one retrieved_at (one retrieval
    per day, simulating daily fetch). Rows carry x, y, a counts.
    """
    rows = []
    for i in range(n_days):
        anchor = f"2025-01-{(i + 1):02d}"
        retrieved = f"2025-02-{(i + 1):02d}"
        slice_key = f"{obs_type}()" if obs_type else "window()"
        rows.append({
            "core_hash": core_hash,
            "param_id": f"test-param-{edge_id[:8]}",
            "slice_key": slice_key,
            "anchor_day": anchor,
            "retrieved_at": retrieved,
            "a": base_x + i * 5,
            "x": base_x + i * 5,
            "y": base_y + i * 2,
            "median_lag_days": 5.0,
            "mean_lag_days": 7.0,
            "anchor_median_lag_days": 5.0,
            "anchor_mean_lag_days": 7.0,
            "onset_delta_days": 2.0,
        })
    return rows


def _make_test_graph():
    """Graph with 3 edges, snapshot rows, and param files.

    Edge A→B: no latency, window snapshot rows, window param file obs
    Edge A→C: has latency, cohort snapshot rows, cohort param file obs
              + warm-start posterior (alpha/beta, mu/sigma, kappa, cohort latency)
    Edge A→D: no latency, no snapshot rows (tests supplementation fallback)
    """
    nodes = [
        {"id": "anchor", "uuid": "node-a"},
        {"id": "node-b", "uuid": "node-b"},
        {"id": "node-c", "uuid": "node-c"},
        {"id": "node-d", "uuid": "node-d"},
    ]

    edges = [
        {
            "uuid": "edge-ab",
            "from": "node-a",
            "to": "node-b",
            "p": {"id": "param-ab"},
        },
        {
            "uuid": "edge-ac",
            "from": "node-a",
            "to": "node-c",
            "p": {
                "id": "param-ac",
                "latency": {
                    "latency_parameter": True,
                    "onset_delta_days": 3.0,
                    "mu": 2.5,
                    "sigma": 0.6,
                    "t95": 30.0,
                    "path_t95": 30.0,
                    "path_mu": 2.5,
                    "path_sigma": 0.6,
                    "path_onset_delta_days": 3.0,
                },
            },
        },
        {
            "uuid": "edge-ad",
            "from": "node-a",
            "to": "node-d",
            "p": {"id": "param-ad"},
        },
    ]

    graph = {"nodes": nodes, "edges": edges}

    param_files = {
        "param-ab": {
            "values": [
                {"sliceDSL": "window(1-Jan-25:31-Jan-25)", "n": 500, "k": 150},
                {"sliceDSL": "window(1-Feb-25:28-Feb-25)", "n": 600, "k": 200},
            ],
        },
        "param-ac": {
            "values": [
                {
                    "sliceDSL": "cohort(1-Jan-25:31-Jan-25)",
                    "n": 400, "k": 80,
                    "n_daily": [100, 100, 100, 100],
                    "k_daily": [20, 18, 22, 20],
                    "dates": ["2025-01-07", "2025-01-14", "2025-01-21", "2025-01-28"],
                },
            ],
            "posterior": {
                "slices": {
                    "window()": {
                        "alpha": 25.0, "beta": 100.0,
                        "mu_mean": 2.3, "sigma_mean": 0.55,
                        "rhat": 1.01, "ess": 800.0,
                    },
                    "cohort()": {
                        "mu_mean": 3.1, "sigma_mean": 0.7,
                        "onset_mean": 2.8,
                        "rhat": 1.02, "ess": 600.0,
                    },
                },
                "_model_state": {
                    "kappa_edge_ac": 5.2,
                },
            },
        },
        "param-ad": {
            "values": [
                {"sliceDSL": "window(1-Jan-25:31-Jan-25)", "n": 200, "k": 60},
            ],
        },
    }

    # Snapshot rows for edges AB and AC (not AD — AD tests fallback)
    snapshot_rows = {
        "edge-ab": _make_snapshot_rows("edge-ab", "hash-ab", n_days=10,
                                       base_x=100, base_y=30, obs_type="window"),
        "edge-ac": _make_snapshot_rows("edge-ac", "hash-ac", n_days=8,
                                       base_x=80, base_y=20, obs_type="cohort"),
    }

    return graph, param_files, snapshot_rows


# ---------------------------------------------------------------------------
# Parity tests
# ---------------------------------------------------------------------------

class TestEngorgedParity:
    """bind_snapshot_evidence with engorged graph must produce identical
    content hashes to bind_snapshot_evidence with param files."""

    def test_snapshot_plus_priors_parity(self):
        """Normal production case: snapshot rows + priors.

        Edge AB has snapshot rows + param file window obs.
        Edge AC has snapshot rows + warm-start priors + cohort daily.
        Both paths should produce identical EdgeEvidence.
        """
        graph, param_files, snapshot_rows = _make_test_graph()
        today = "1-Mar-25"
        topology = analyse_topology(graph)

        # Legacy path: param files for priors
        evidence_legacy = bind_snapshot_evidence(
            topology, snapshot_rows, param_files, today=today,
        )

        # Engorged path: priors from graph edges
        graph_engorged = copy.deepcopy(graph)
        engorge_graph_for_test(graph_engorged, param_files, None, topology)
        evidence_engorged = bind_snapshot_evidence(
            topology, snapshot_rows, param_files, today=today,
            graph_snapshot=graph_engorged,
        )

        for edge_id in topology.edges:
            leg = evidence_legacy.edges.get(edge_id)
            eng = evidence_engorged.edges.get(edge_id)
            if leg is None and eng is None:
                continue  # both skipped — fine
            assert leg is not None, f"Legacy missing edge {edge_id}"
            assert eng is not None, f"Engorged missing edge {edge_id}"
            assert leg.content_hash() == eng.content_hash(), (
                f"Parity failure for edge {edge_id}:\n"
                f"  legacy hash:   {leg.content_hash()}\n"
                f"  engorged hash: {eng.content_hash()}\n"
                f"  legacy prior:  alpha={leg.prob_prior.alpha}, beta={leg.prob_prior.beta}, src={leg.prob_prior.source}\n"
                f"  engorged prior: alpha={eng.prob_prior.alpha}, beta={eng.prob_prior.beta}, src={eng.prob_prior.source}\n"
                f"  legacy total_n={leg.total_n}, engorged total_n={eng.total_n}"
            )

    def test_warm_start_priors_match(self):
        """Warm-start alpha/beta, kappa, and cohort latency match between paths."""
        graph, param_files, snapshot_rows = _make_test_graph()
        today = "1-Mar-25"
        topology = analyse_topology(graph)

        evidence_legacy = bind_snapshot_evidence(
            topology, snapshot_rows, param_files, today=today,
        )

        graph_engorged = copy.deepcopy(graph)
        engorge_graph_for_test(graph_engorged, param_files, None, topology)
        evidence_engorged = bind_snapshot_evidence(
            topology, snapshot_rows, param_files, today=today,
            graph_snapshot=graph_engorged,
        )

        # Edge AC has warm-start
        leg = evidence_legacy.edges["edge-ac"]
        eng = evidence_engorged.edges["edge-ac"]

        # Probability prior
        assert leg.prob_prior.alpha == eng.prob_prior.alpha
        assert leg.prob_prior.beta == eng.prob_prior.beta
        assert leg.prob_prior.source == eng.prob_prior.source

        # Latency prior
        assert leg.latency_prior is not None
        assert eng.latency_prior is not None
        assert leg.latency_prior.mu == eng.latency_prior.mu
        assert leg.latency_prior.sigma == eng.latency_prior.sigma
        assert leg.latency_prior.source == eng.latency_prior.source

        # Kappa warm-start
        assert leg.kappa_warm == eng.kappa_warm

        # Cohort latency warm-start
        assert leg.cohort_latency_warm == eng.cohort_latency_warm

    def test_fallback_edge_parity(self):
        """Edge AD has no snapshot rows — falls back to file-based evidence.

        Legacy: falls back to param file values[].
        Engorged: falls back to _bayes_evidence on graph edge.
        Both should produce identical evidence.
        """
        graph, param_files, snapshot_rows = _make_test_graph()
        today = "1-Mar-25"
        topology = analyse_topology(graph)

        evidence_legacy = bind_snapshot_evidence(
            topology, snapshot_rows, param_files, today=today,
        )

        graph_engorged = copy.deepcopy(graph)
        engorge_graph_for_test(graph_engorged, param_files, None, topology)
        evidence_engorged = bind_snapshot_evidence(
            topology, snapshot_rows, param_files, today=today,
            graph_snapshot=graph_engorged,
        )

        leg = evidence_legacy.edges.get("edge-ad")
        eng = evidence_engorged.edges.get("edge-ad")
        assert leg is not None, "Legacy missing edge-ad"
        assert eng is not None, "Engorged missing edge-ad"
        assert leg.content_hash() == eng.content_hash(), (
            f"Fallback parity failure for edge-ad:\n"
            f"  legacy hash:   {leg.content_hash()}\n"
            f"  engorged hash: {eng.content_hash()}\n"
            f"  legacy total_n={leg.total_n}, engorged total_n={eng.total_n}\n"
            f"  legacy window_obs={len(leg.window_obs)}, engorged window_obs={len(eng.window_obs)}"
        )

    def test_observation_counts_match(self):
        """total_n and observation counts are identical between paths."""
        graph, param_files, snapshot_rows = _make_test_graph()
        today = "1-Mar-25"
        topology = analyse_topology(graph)

        evidence_legacy = bind_snapshot_evidence(
            topology, snapshot_rows, param_files, today=today,
        )

        graph_engorged = copy.deepcopy(graph)
        engorge_graph_for_test(graph_engorged, param_files, None, topology)
        evidence_engorged = bind_snapshot_evidence(
            topology, snapshot_rows, param_files, today=today,
            graph_snapshot=graph_engorged,
        )

        for edge_id in topology.edges:
            leg = evidence_legacy.edges.get(edge_id)
            eng = evidence_engorged.edges.get(edge_id)
            if leg is None or eng is None:
                continue
            assert leg.total_n == eng.total_n, (
                f"total_n mismatch for {edge_id}: legacy={leg.total_n}, engorged={eng.total_n}"
            )
            assert len(leg.window_obs) == len(eng.window_obs), (
                f"window_obs count mismatch for {edge_id}"
            )
            assert len(leg.cohort_obs) == len(eng.cohort_obs), (
                f"cohort_obs count mismatch for {edge_id}"
            )
            assert leg.skipped == eng.skipped

    def test_skip_state_parity(self):
        """Edges with no data are skipped identically in both paths."""
        graph, _, snapshot_rows = _make_test_graph()
        # Empty param files — no observations, no priors
        empty_params = {
            "param-ab": {"values": []},
            "param-ac": {"values": []},
            "param-ad": {"values": []},
        }
        # No snapshot rows either
        no_rows: dict = {}
        today = "1-Mar-25"
        topology = analyse_topology(graph)

        evidence_legacy = bind_snapshot_evidence(
            topology, no_rows, empty_params, today=today,
        )

        graph_engorged = copy.deepcopy(graph)
        engorge_graph_for_test(graph_engorged, empty_params, None, topology)
        evidence_engorged = bind_snapshot_evidence(
            topology, no_rows, empty_params, today=today,
            graph_snapshot=graph_engorged,
        )

        for edge_id in topology.edges:
            leg = evidence_legacy.edges.get(edge_id)
            eng = evidence_engorged.edges.get(edge_id)
            if leg is None and eng is None:
                continue
            assert leg is not None and eng is not None
            assert leg.skipped == eng.skipped
            assert leg.content_hash() == eng.content_hash()


class TestEngorgeHelper:
    """engorge_graph_for_test writes the expected structure onto edges."""

    def test_engorge_writes_all_fields(self):
        """Engorged edges have _bayes_priors and _bayes_evidence with correct structure."""
        graph, param_files, _ = _make_test_graph()
        topology = analyse_topology(graph)

        graph_copy = copy.deepcopy(graph)
        engorge_graph_for_test(graph_copy, param_files, None, topology)

        for ge in graph_copy["edges"]:
            pid = ge.get("p", {}).get("id", "")
            if not pid:
                continue
            assert "_bayes_priors" in ge, f"Edge {ge['uuid']} missing _bayes_priors"
            assert "_bayes_evidence" in ge, f"Edge {ge['uuid']} missing _bayes_evidence"

            priors = ge["_bayes_priors"]
            assert "prob_alpha" in priors
            assert "prob_beta" in priors
            assert "prob_source" in priors

            evidence = ge["_bayes_evidence"]
            assert "window" in evidence
            assert "cohort" in evidence
