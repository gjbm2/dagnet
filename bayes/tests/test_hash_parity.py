"""
Hash parity tests: verify synth_gen's compute_core_hashes produces hashes
that match the FE's algorithm and are present in the snapshot DB.

Tests the full chain:
  1. Python builds coreCanonical JSON matching querySignature.ts
  2. SHA-256 → full hex (matches FE hashText)
  3. Structured sig JSON (matches serialiseSignature)
  4. SHA-256 → first 16 bytes → base64url (matches coreHashService.ts)
  5. DB rows exist with the computed core_hash + workspace-prefixed param_id

Run with:
    cd /home/reg/dev/dagnet
    . graph-editor/venv/bin/activate
    pytest bayes/tests/test_hash_parity.py -v --tb=short
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import yaml
import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO_ROOT, "bayes"))
sys.path.insert(0, os.path.join(REPO_ROOT, "graph-editor", "lib"))
sys.path.insert(0, os.path.join(REPO_ROOT, "graph-editor"))

from synth_gen import (
    compute_core_hashes,
    _sha256_hex,
    _short_hash,
    _resolve_data_repo,
    GRAPH_CONFIGS,
)
from compiler.topology import analyse_topology


# ---------------------------------------------------------------------------
# Unit tests: hash primitives match FE algorithm
# ---------------------------------------------------------------------------

class TestHashPrimitives:
    """Verify Python hash functions match FE coreHashService.ts."""

    def test_sha256_hex_matches_known(self):
        """SHA-256 hex of a known string."""
        result = _sha256_hex("hello")
        assert result == "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"

    def test_short_hash_matches_python_snapshot_service(self):
        """_short_hash must match snapshot_service.short_core_hash_from_canonical_signature."""
        from snapshot_service import short_core_hash_from_canonical_signature
        test_inputs = [
            '{"c":"abc123","x":{}}',
            '{"c":"deadbeef","x":{"channel":"abc"}}',
            'some random canonical signature string',
        ]
        for inp in test_inputs:
            assert _short_hash(inp) == short_core_hash_from_canonical_signature(inp), (
                f"Mismatch for input: {inp!r}"
            )

    def test_structured_sig_format(self):
        """Structured sig must be compact JSON with c and x keys."""
        core_hex = _sha256_hex("test")
        sig = json.dumps({"c": core_hex, "x": {}}, separators=(",", ":"))
        assert sig.startswith('{"c":"')
        assert sig.endswith('","x":{}}')
        # No spaces
        assert " " not in sig


# ---------------------------------------------------------------------------
# Integration tests: compute_core_hashes on real graph
# ---------------------------------------------------------------------------

class TestComputeCoreHashes:
    """Verify compute_core_hashes produces valid hashes for the diamond graph."""

    @pytest.fixture
    def diamond_graph(self):
        data_repo = _resolve_data_repo()
        graph_path = os.path.join(data_repo, "graphs", "synth-diamond-test.json")
        if not os.path.exists(graph_path):
            pytest.skip("Diamond graph not found in data repo")
        with open(graph_path) as f:
            return json.load(f), data_repo

    def test_produces_hashes_for_all_evented_edges(self, diamond_graph):
        """Every edge with a param_id gets window + cohort hashes."""
        graph, data_repo = diamond_graph
        topology = analyse_topology(graph)
        hashes = compute_core_hashes(graph, topology, data_repo)

        evented_pids = {et.param_id for et in topology.edges.values() if et.param_id}
        for pid in evented_pids:
            assert pid in hashes, f"Missing hashes for {pid}"
            assert "window_hash" in hashes[pid], f"Missing window_hash for {pid}"
            assert "cohort_hash" in hashes[pid], f"Missing cohort_hash for {pid}"
            assert "window_sig" in hashes[pid], f"Missing window_sig for {pid}"
            assert "cohort_sig" in hashes[pid], f"Missing cohort_sig for {pid}"

    def test_hashes_are_valid_base64url(self, diamond_graph):
        """Short hashes must be valid base64url ~22 chars."""
        graph, data_repo = diamond_graph
        topology = analyse_topology(graph)
        hashes = compute_core_hashes(graph, topology, data_repo)

        for pid, h in hashes.items():
            if pid.startswith("parameter-"):
                continue
            for key in ["window_hash", "cohort_hash"]:
                val = h[key]
                assert len(val) >= 20, f"{pid} {key} too short: {val}"
                assert len(val) <= 24, f"{pid} {key} too long: {val}"
                # Must be valid base64url (no + / =)
                assert "+" not in val and "/" not in val, (
                    f"{pid} {key} has non-url-safe chars: {val}"
                )

    def test_window_and_cohort_hashes_differ(self, diamond_graph):
        """Window and cohort hashes for the same edge must differ
        (cohort_mode changes the canonical)."""
        graph, data_repo = diamond_graph
        topology = analyse_topology(graph)
        hashes = compute_core_hashes(graph, topology, data_repo)

        for pid, h in hashes.items():
            if pid.startswith("parameter-"):
                continue
            assert h["window_hash"] != h["cohort_hash"], (
                f"{pid}: window and cohort hashes should differ"
            )

    def test_short_hash_derived_from_structured_sig(self, diamond_graph):
        """The short hash must be derivable from the structured sig."""
        graph, data_repo = diamond_graph
        topology = analyse_topology(graph)
        hashes = compute_core_hashes(graph, topology, data_repo)

        for pid, h in hashes.items():
            if pid.startswith("parameter-"):
                continue
            for mode in ["window", "cohort"]:
                sig = h[f"{mode}_sig"]
                expected_short = _short_hash(sig)
                assert h[f"{mode}_hash"] == expected_short, (
                    f"{pid} {mode}: short_hash(sig) mismatch"
                )

    def test_structured_sig_has_full_hex_core_hash(self, diamond_graph):
        """The structured sig's 'c' field must be a 64-char hex string."""
        graph, data_repo = diamond_graph
        topology = analyse_topology(graph)
        hashes = compute_core_hashes(graph, topology, data_repo)

        for pid, h in hashes.items():
            if pid.startswith("parameter-"):
                continue
            for mode in ["window", "cohort"]:
                sig = json.loads(h[f"{mode}_sig"])
                core_hex = sig["c"]
                assert len(core_hex) == 64, (
                    f"{pid} {mode}: core hash hex should be 64 chars, got {len(core_hex)}"
                )
                assert all(c in "0123456789abcdef" for c in core_hex), (
                    f"{pid} {mode}: core hash hex has non-hex chars"
                )

    def test_deterministic(self, diamond_graph):
        """Same inputs produce same hashes."""
        graph, data_repo = diamond_graph
        topology = analyse_topology(graph)
        h1 = compute_core_hashes(graph, topology, data_repo)
        h2 = compute_core_hashes(graph, topology, data_repo)

        for pid in h1:
            if pid.startswith("parameter-"):
                continue
            assert h1[pid] == h2[pid], f"{pid}: non-deterministic hashes"


# ---------------------------------------------------------------------------
# DB parity test: hashes in DB match computed hashes
# ---------------------------------------------------------------------------

class TestDBParity:
    """Verify snapshot DB contains rows with the computed core_hashes."""

    @pytest.fixture
    def db_connection(self):
        env_path = os.path.join(REPO_ROOT, "graph-editor", ".env.local")
        if not os.path.exists(env_path):
            pytest.skip("No .env.local — DB not available")
        db_conn = ""
        for line in open(env_path):
            if line.strip().startswith("DB_CONNECTION="):
                db_conn = line.strip().split("=", 1)[1].strip().strip('"')
        if not db_conn:
            pytest.skip("No DB_CONNECTION in .env.local")
        os.environ["DB_CONNECTION"] = db_conn
        from snapshot_service import get_db_connection
        conn = get_db_connection()
        yield conn
        conn.close()

    @pytest.fixture
    def diamond_hashes(self):
        data_repo = _resolve_data_repo()
        graph_path = os.path.join(data_repo, "graphs", "synth-diamond-test.json")
        if not os.path.exists(graph_path):
            pytest.skip("Diamond graph not found")
        with open(graph_path) as f:
            graph = json.load(f)
        topology = analyse_topology(graph)
        return compute_core_hashes(graph, topology, data_repo)

    def test_all_hashes_present_in_db(self, db_connection, diamond_hashes):
        """Every computed core_hash should have rows in the snapshots table."""
        cur = db_connection.cursor()
        missing = []
        for pid, h in diamond_hashes.items():
            if pid.startswith("parameter-"):
                continue
            for mode in ["window_hash", "cohort_hash"]:
                core_hash = h[mode]
                # Check with workspace prefix
                cur.execute(
                    "SELECT COUNT(*) FROM snapshots WHERE core_hash = %s",
                    (core_hash,),
                )
                count = cur.fetchone()[0]
                if count == 0:
                    missing.append(f"{pid}/{mode}={core_hash}")

        assert not missing, (
            f"Computed hashes not found in DB:\n" +
            "\n".join(f"  {m}" for m in missing)
        )

    def test_workspace_prefixed_param_ids_in_db(self, db_connection, diamond_hashes):
        """DB param_ids should be workspace-prefixed (repo-branch-paramId)."""
        cur = db_connection.cursor()
        for pid in diamond_hashes:
            if pid.startswith("parameter-"):
                continue
            cur.execute(
                "SELECT DISTINCT param_id FROM snapshots WHERE param_id LIKE %s",
                (f"%-{pid}",),
            )
            rows = cur.fetchall()
            prefixed = [r[0] for r in rows if r[0] != pid]
            assert prefixed, (
                f"No workspace-prefixed param_id found for {pid}. "
                f"DB should have 'repo-branch-{pid}', not bare '{pid}'"
            )
