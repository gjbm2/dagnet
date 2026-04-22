"""
Blind contract tests for bayes/sidecar.py.

The sidecar is a tiny JSON file (committed to git under bayes/fixtures/)
that holds MCMC-derived bayesian model_vars for a synth graph, separate
from the graph file itself. It exists because the graph file has
competing writers (synth_gen, hydrate.sh, FE CLI, MCMC) — keeping the
expensive-to-produce bayesian output inside the graph file caused every
competing write to clobber it and re-trigger MCMC.

Contract covered here:
  - Fingerprint semantics (invalidates when truth or any param file
    changes; stable otherwise).
  - Sidecar save/load round-trip; load is fingerprint-guarded.
  - Injection into a graph dict is idempotent (replaces, never
    duplicates, existing bayesian entries) and re-promotes SDs into
    the latency block for BE-only consumers that read promoted fields.

Tests are written before `bayes/sidecar.py` exists; they must fail at
import until the module is implemented. Do not mock the module under
test — exercise the contract through the public API only.
"""
from __future__ import annotations

import json
import os
import sys

import pytest

# Import path: tests run from graph-editor/ but need to see the top-level
# `bayes` package as well.
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)


# ─── Fingerprint ────────────────────────────────────────────────────────

class TestFingerprint:
    """compute_fingerprint(truth_path, param_paths) → stable dict that
    flips whenever truth or any param file content changes."""

    def test_returns_dict_with_expected_keys(self, tmp_path):
        from bayes.sidecar import compute_fingerprint
        truth = tmp_path / "truth.yaml"
        truth.write_text("key: value\n")
        p_a = tmp_path / "simple-a-to-b.yaml"
        p_a.write_text("values: []\n")
        fp = compute_fingerprint(str(truth), [str(p_a)])
        assert isinstance(fp, dict)
        assert "truth_sha256" in fp
        assert "param_file_hashes" in fp
        assert isinstance(fp["truth_sha256"], str) and len(fp["truth_sha256"]) == 64
        assert isinstance(fp["param_file_hashes"], dict)
        assert "simple-a-to-b" in fp["param_file_hashes"]

    def test_stable_for_unchanged_inputs(self, tmp_path):
        from bayes.sidecar import compute_fingerprint
        truth = tmp_path / "truth.yaml"
        truth.write_text("content\n")
        p = tmp_path / "p.yaml"
        p.write_text("values: [1, 2, 3]\n")
        assert compute_fingerprint(str(truth), [str(p)]) == \
               compute_fingerprint(str(truth), [str(p)])

    def test_changes_when_truth_changes(self, tmp_path):
        from bayes.sidecar import compute_fingerprint
        truth = tmp_path / "truth.yaml"
        truth.write_text("v1\n")
        fp1 = compute_fingerprint(str(truth), [])
        truth.write_text("v2\n")
        fp2 = compute_fingerprint(str(truth), [])
        assert fp1 != fp2
        assert fp1["truth_sha256"] != fp2["truth_sha256"]

    def test_changes_when_a_param_file_changes(self, tmp_path):
        from bayes.sidecar import compute_fingerprint
        truth = tmp_path / "truth.yaml"
        truth.write_text("t\n")
        p_a = tmp_path / "simple-a-to-b.yaml"
        p_b = tmp_path / "simple-b-to-c.yaml"
        p_a.write_text("v1\n")
        p_b.write_text("b\n")
        fp1 = compute_fingerprint(str(truth), [str(p_a), str(p_b)])
        p_a.write_text("v2\n")
        fp2 = compute_fingerprint(str(truth), [str(p_a), str(p_b)])
        assert fp1 != fp2
        assert fp1["truth_sha256"] == fp2["truth_sha256"]
        assert fp1["param_file_hashes"]["simple-a-to-b"] != \
               fp2["param_file_hashes"]["simple-a-to-b"]
        assert fp1["param_file_hashes"]["simple-b-to-c"] == \
               fp2["param_file_hashes"]["simple-b-to-c"]

    def test_param_file_order_does_not_matter(self, tmp_path):
        from bayes.sidecar import compute_fingerprint
        truth = tmp_path / "t.yaml"
        truth.write_text("t\n")
        p_a = tmp_path / "a.yaml"
        p_b = tmp_path / "b.yaml"
        p_a.write_text("A\n")
        p_b.write_text("B\n")
        fp1 = compute_fingerprint(str(truth), [str(p_a), str(p_b)])
        fp2 = compute_fingerprint(str(truth), [str(p_b), str(p_a)])
        assert fp1 == fp2

    def test_raises_when_truth_missing(self, tmp_path):
        from bayes.sidecar import compute_fingerprint
        with pytest.raises((FileNotFoundError, OSError)):
            compute_fingerprint(str(tmp_path / "nonexistent.yaml"), [])


# ─── Sidecar save / load round-trip ────────────────────────────────────

class TestSidecarIO:
    """save_sidecar writes JSON with schema_version + fingerprint +
    generated_at + edges. load_sidecar re-reads it but returns None
    when the current fingerprint differs from the stored one."""

    def _fp(self, truth_sha="abc123", params=None):
        return {
            "truth_sha256": truth_sha,
            "param_file_hashes": params or {"simple-a-to-b": "p1hash"},
        }

    def test_round_trip_preserves_edges(self, tmp_path):
        from bayes.sidecar import save_sidecar, load_sidecar
        path = tmp_path / "s.json"
        fp = self._fp()
        edges = {
            "edge-1": {
                "source": "bayesian",
                "source_at": "22-Apr-26 14:30:00",
                "probability": {"mean": 0.7, "stdev": 0.08},
                "latency": {"mu": 2.3, "sigma": 0.52, "mu_sd": 0.08},
                "quality": {"rhat": 1.001, "gate_passed": True},
            }
        }
        save_sidecar(str(path), fp, edges)
        loaded = load_sidecar(str(path), expected_fingerprint=fp)
        assert loaded == edges

    def test_saved_file_is_valid_json_with_schema_fields(self, tmp_path):
        from bayes.sidecar import save_sidecar
        path = tmp_path / "s.json"
        save_sidecar(str(path), self._fp(), {"edge-1": {"source": "bayesian"}})
        data = json.loads(path.read_text())
        assert data.get("schema_version", 0) >= 1
        assert "fingerprint" in data
        assert "edges" in data
        assert "generated_at" in data

    def test_load_returns_none_when_file_missing(self, tmp_path):
        from bayes.sidecar import load_sidecar
        result = load_sidecar(
            str(tmp_path / "missing.json"),
            expected_fingerprint=self._fp(),
        )
        assert result is None

    def test_load_returns_none_when_fingerprint_mismatches(self, tmp_path):
        from bayes.sidecar import save_sidecar, load_sidecar
        path = tmp_path / "s.json"
        save_sidecar(str(path), self._fp(truth_sha="old"), {"edge-1": {}})
        result = load_sidecar(
            str(path),
            expected_fingerprint=self._fp(truth_sha="new"),
        )
        assert result is None

    def test_load_returns_none_when_a_param_hash_mismatches(self, tmp_path):
        from bayes.sidecar import save_sidecar, load_sidecar
        path = tmp_path / "s.json"
        save_sidecar(str(path),
                     self._fp(params={"simple-a-to-b": "old_hash"}),
                     {"edge-1": {}})
        result = load_sidecar(
            str(path),
            expected_fingerprint=self._fp(params={"simple-a-to-b": "new_hash"}),
        )
        assert result is None

    def test_load_raises_on_malformed_json(self, tmp_path):
        from bayes.sidecar import load_sidecar
        path = tmp_path / "bad.json"
        path.write_text("{ this is not json")
        with pytest.raises((ValueError, json.JSONDecodeError)):
            load_sidecar(str(path), expected_fingerprint=self._fp())


# ─── Injection into graph dict ─────────────────────────────────────────

class TestInjection:
    """inject_bayesian(graph, edges) mutates graph in place. Appends the
    sidecar's bayesian entry to each matching edge's model_vars array,
    replacing any pre-existing bayesian entries; re-promotes SDs into
    edge.p.latency.promoted_* fields (mirrors FE applyPromotion so BE-only
    consumers — span_adapter, v2 handler — find the SDs they expect)."""

    def _graph(self):
        return {
            "edges": [
                {
                    "uuid": "edge-1",
                    "p": {
                        "latency": {"mu": 2.3, "sigma": 0.5, "onset_delta_days": 1},
                        "model_vars": [
                            {"source": "analytic",
                             "latency": {"mu": 2.3, "sigma": 0.5, "mu_sd": 0.02}}
                        ],
                    },
                },
                {
                    "uuid": "edge-2",
                    "p": {
                        "latency": {"mu": 2.5, "sigma": 0.6, "onset_delta_days": 2},
                        "model_vars": [],
                    },
                },
            ],
        }

    def _bayes_entry(self, **over):
        base = {
            "source": "bayesian",
            "source_at": "22-Apr-26 14:30:00",
            "probability": {"mean": 0.70, "stdev": 0.08},
            "latency": {
                "mu": 2.3, "sigma": 0.52, "t95": 24.5, "onset_delta_days": 1.03,
                "mu_sd": 0.08, "sigma_sd": 0.01, "onset_sd": 0.07,
                "onset_mu_corr": -0.8,
            },
            "quality": {"rhat": 1.001, "gate_passed": True},
        }
        base.update(over)
        return base

    def test_appends_bayesian_entry_to_model_vars(self):
        from bayes.sidecar import inject_bayesian
        graph = self._graph()
        inject_bayesian(graph, {"edge-1": self._bayes_entry()})
        sources = [m.get("source") for m in graph["edges"][0]["p"]["model_vars"]]
        assert sources.count("analytic") == 1
        assert sources.count("bayesian") == 1

    def test_replaces_preexisting_bayesian_entry(self):
        from bayes.sidecar import inject_bayesian
        graph = self._graph()
        # Seed a stale bayesian entry directly on the graph.
        graph["edges"][0]["p"]["model_vars"].append({
            "source": "bayesian",
            "latency": {"mu_sd": 0.99},  # distinctive stale value
        })
        inject_bayesian(graph, {"edge-1": self._bayes_entry()})
        bayes = [m for m in graph["edges"][0]["p"]["model_vars"]
                 if m.get("source") == "bayesian"]
        assert len(bayes) == 1
        assert bayes[0]["latency"]["mu_sd"] == 0.08

    def test_promotes_sds_into_latency_block(self):
        from bayes.sidecar import inject_bayesian
        graph = self._graph()
        inject_bayesian(graph, {"edge-1": self._bayes_entry()})
        lat = graph["edges"][0]["p"]["latency"]
        assert lat.get("promoted_mu_sd") == pytest.approx(0.08)
        assert lat.get("promoted_sigma_sd") == pytest.approx(0.01)
        assert lat.get("promoted_onset_sd") == pytest.approx(0.07)
        assert lat.get("promoted_onset_mu_corr") == pytest.approx(-0.8)
        assert lat.get("promoted_t95") == pytest.approx(24.5)

    def test_promotes_path_sds_when_present(self):
        from bayes.sidecar import inject_bayesian
        graph = self._graph()
        entry = self._bayes_entry()
        entry["latency"].update({
            "path_mu_sd": 0.09, "path_sigma_sd": 0.02,
            "path_onset_sd": 0.10,
        })
        inject_bayesian(graph, {"edge-1": entry})
        lat = graph["edges"][0]["p"]["latency"]
        assert lat.get("promoted_path_mu_sd") == pytest.approx(0.09)
        assert lat.get("promoted_path_sigma_sd") == pytest.approx(0.02)
        assert lat.get("promoted_path_onset_sd") == pytest.approx(0.10)

    def test_leaves_edges_not_in_sidecar_untouched(self):
        from bayes.sidecar import inject_bayesian
        graph = self._graph()
        before = json.dumps(graph["edges"][1], sort_keys=True)
        inject_bayesian(graph, {"edge-1": self._bayes_entry()})
        after = json.dumps(graph["edges"][1], sort_keys=True)
        assert before == after

    def test_tolerates_sidecar_entries_for_missing_edges(self):
        from bayes.sidecar import inject_bayesian
        graph = self._graph()
        # Should not raise when sidecar contains an edge not in graph.
        inject_bayesian(graph, {"unknown-edge": self._bayes_entry()})

    def test_tolerates_edges_without_model_vars_list(self):
        """An edge that has `p` but no `model_vars` list should get one
        initialised to `[bayesian_entry]`."""
        from bayes.sidecar import inject_bayesian
        graph = {"edges": [{"uuid": "edge-x", "p": {"latency": {"mu": 1}}}]}
        inject_bayesian(graph, {"edge-x": self._bayes_entry()})
        assert graph["edges"][0]["p"]["model_vars"][0]["source"] == "bayesian"

    def test_multiple_edges_injected_independently(self):
        from bayes.sidecar import inject_bayesian
        graph = self._graph()
        sidecar = {
            "edge-1": self._bayes_entry(),
            "edge-2": self._bayes_entry(),
        }
        inject_bayesian(graph, sidecar)
        for e in graph["edges"]:
            sources = [m.get("source") for m in e["p"]["model_vars"]]
            assert "bayesian" in sources
