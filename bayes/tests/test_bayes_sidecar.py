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
  - Sidecar save/load round-trip for the raw worker payload; load is
    schema- and fingerprint-guarded.
  - The sidecar wrapper owns only sidecar metadata
    (`schema_version`, `generated_at`, `sidecar_fingerprint`) and does
    not rewrite the worker payload.

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
    """save_sidecar writes JSON with schema_version +
    sidecar_fingerprint + generated_at plus the raw worker payload.
    load_sidecar re-reads it but returns None when the current
    fingerprint differs from the stored one."""

    def _fp(self, truth_sha="abc123", params=None):
        return {
            "truth_sha256": truth_sha,
            "param_file_hashes": params or {"simple-a-to-b": "p1hash"},
        }

    def _payload(self):
        return {
            "job_id": "sidecar-test-job",
            "fitted_at": "22-Apr-26 14:30:00",
            "fingerprint": "worker-fingerprint-123",
            "model_version": 1,
            "quality": {"max_rhat": 1.001, "min_ess": 1200, "converged_pct": 100},
            "skipped": [],
            "webhook_payload_edges": [
                {
                    "param_id": "simple-a-to-b",
                    "file_path": "parameters/simple-a-to-b.yaml",
                    "slices": {
                        "window()": {"alpha": 45.2, "beta": 5.1, "mu_mean": 2.3},
                        "cohort()": {"alpha": 44.8, "beta": 5.3, "mu_mean": 2.8},
                    },
                }
            ],
        }

    def test_round_trip_preserves_payload(self, tmp_path):
        from bayes.sidecar import save_sidecar, load_sidecar
        path = tmp_path / "s.json"
        fp = self._fp()
        payload = self._payload()
        save_sidecar(str(path), fp, payload)
        loaded = load_sidecar(str(path), expected_fingerprint=fp)
        assert loaded is not None
        assert loaded["job_id"] == payload["job_id"]
        assert loaded["fingerprint"] == payload["fingerprint"]
        assert loaded["webhook_payload_edges"] == payload["webhook_payload_edges"]

    def test_saved_file_is_valid_json_with_schema_fields(self, tmp_path):
        from bayes.sidecar import save_sidecar
        path = tmp_path / "s.json"
        save_sidecar(str(path), self._fp(), self._payload())
        data = json.loads(path.read_text())
        assert data.get("schema_version", 0) >= 2
        assert "sidecar_fingerprint" in data
        assert "generated_at" in data
        assert "webhook_payload_edges" in data

    def test_worker_fingerprint_is_not_overwritten_by_sidecar_fingerprint(self, tmp_path):
        from bayes.sidecar import save_sidecar
        path = tmp_path / "s.json"
        payload = self._payload()
        save_sidecar(str(path), self._fp(truth_sha="truth-hash"), payload)
        data = json.loads(path.read_text())
        assert data["sidecar_fingerprint"]["truth_sha256"] == "truth-hash"
        assert data["fingerprint"] == "worker-fingerprint-123"

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
        save_sidecar(str(path), self._fp(truth_sha="old"), self._payload())
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
                     self._payload())
        result = load_sidecar(
            str(path),
            expected_fingerprint=self._fp(params={"simple-a-to-b": "new_hash"}),
        )
        assert result is None

    def test_load_returns_none_when_schema_version_is_old(self, tmp_path):
        from bayes.sidecar import load_sidecar
        path = tmp_path / "old.json"
        path.write_text(json.dumps({
            "schema_version": 1,
            "generated_at": "22-Apr-26 15:00:00",
            "sidecar_fingerprint": self._fp(),
            "webhook_payload_edges": [],
        }))
        assert load_sidecar(str(path), expected_fingerprint=self._fp()) is None

    def test_load_raises_on_malformed_json(self, tmp_path):
        from bayes.sidecar import load_sidecar
        path = tmp_path / "bad.json"
        path.write_text("{ this is not json")
        with pytest.raises((ValueError, json.JSONDecodeError)):
            load_sidecar(str(path), expected_fingerprint=self._fp())
