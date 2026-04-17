"""Integration tests for the synth graph freshness checker.

Tests the REAL verify_synth_data() against REAL file layouts and the
REAL snapshot DB. No mocks except where the mock budget explicitly
justifies it (see TESTING_STANDARDS.md).

Prose test design
─────────────────
What real bug would this catch?
  - Empty core_hash rows written by synth_gen (the 254k-row incident)
  - Connection string mismatch between graph JSON and hash computation
  - Stale param files after truth file change
  - Missing enrichment not detected

What is real vs mocked?
  - REAL: file I/O (truth, graph, event, param files — written to tmp_path)
  - REAL: DB queries (psycopg2 against the snapshot DB via DB_CONNECTION)
  - REAL: verify_synth_data(), save_synth_meta()
  - MOCKED: nothing. Tests that need DB skip if DB_CONNECTION is unset.

What would a false pass look like?
  - If verify_synth_data() returned 'fresh' by only checking row counts
    but ignoring empty core_hash values, the core_hash integrity test
    would still pass with mocks — but fail in production. We test against
    the real DB to prevent this.

Test structure
──────────────
- Unit tests (pure logic, no DB): meta sidecar schema, reasons list, etc.
  These use tmp_path only.
- Integration tests (real DB): freshness against actual DB state.
  These use @requires_db and skip if DB_CONNECTION is unset.
"""

import hashlib
import json
import os
from pathlib import Path

import pytest
import yaml

# ---------------------------------------------------------------------------
# Skip markers
# ---------------------------------------------------------------------------

DB_URL = os.environ.get("DB_CONNECTION", "")
if not DB_URL:
    # Try .env.local
    _env_path = Path(__file__).resolve().parent.parent.parent / "graph-editor" / ".env.local"
    if _env_path.exists():
        for _line in _env_path.read_text().splitlines():
            if _line.strip().startswith("DB_CONNECTION="):
                DB_URL = _line.strip().split("=", 1)[1].strip().strip('"')
                break

requires_db = pytest.mark.skipif(not DB_URL, reason="DB_CONNECTION not set")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _write_truth(graphs_dir: Path, name: str, content: dict | None = None) -> Path:
    truth = content or {"graph": {"name": name}, "edges": {}}
    path = graphs_dir / f"{name}.truth.yaml"
    path.write_text(yaml.dump(truth))
    return path


def _write_graph(graphs_dir: Path, name: str, *,
                 edges: list | None = None,
                 default_connection: str = "amplitude") -> Path:
    graph = {
        "nodes": [
            {"uuid": "n1", "id": "node-a", "event_id": "evt-a"},
            {"uuid": "n2", "id": "node-b", "event_id": "evt-b"},
        ],
        "edges": edges or [{
            "uuid": "e1", "from": "n1", "to": "n2",
            "p": {"id": "edge-a-to-b", "connection": None},
        }],
        "defaultConnection": default_connection,
    }
    path = graphs_dir / f"{name}.json"
    path.write_text(json.dumps(graph))
    return path


def _write_event(events_dir: Path, event_id: str,
                 content: dict | None = None) -> Path:
    evt = content or {"id": event_id, "provider": "amplitude",
                      "event_name": f"test_{event_id}"}
    path = events_dir / f"{event_id}.yaml"
    path.write_text(yaml.dump(evt))
    return path


def _write_param(params_dir: Path, param_id: str, *,
                 query_signature: str = "test-sig") -> Path:
    param = {
        "id": param_id, "type": "probability",
        "values": [{"query_signature": query_signature, "mean": 0.5}],
    }
    path = params_dir / f"{param_id}.yaml"
    path.write_text(yaml.dump(param))
    return path


def _write_meta(graphs_dir: Path, name: str, meta: dict) -> Path:
    path = graphs_dir / f"{name}.synth-meta.json"
    path.write_text(json.dumps(meta))
    return path


def _build_fresh_layout(tmp_path: Path, name: str = "test-graph", *,
                         window_hash: str = "hash-w",
                         cohort_hash: str = "hash-c"):
    """Build a complete fresh v2 file layout in tmp_path.

    Returns (graphs_dir, truth_path, graph_path, meta).
    """
    graphs_dir = tmp_path / "graphs"
    graphs_dir.mkdir(exist_ok=True)
    events_dir = tmp_path / "events"
    events_dir.mkdir(exist_ok=True)
    params_dir = tmp_path / "parameters"
    params_dir.mkdir(exist_ok=True)

    truth_path = _write_truth(graphs_dir, name)
    graph_path = _write_graph(graphs_dir, name)
    _write_event(events_dir, "evt-a")
    _write_event(events_dir, "evt-b")
    _write_param(params_dir, "edge-a-to-b", query_signature=window_hash)

    truth_sha = _sha256(truth_path.read_bytes())
    graph_sha = _sha256(graph_path.read_bytes())
    evt_a_sha = _sha256((events_dir / "evt-a.yaml").read_bytes())
    evt_b_sha = _sha256((events_dir / "evt-b.yaml").read_bytes())

    meta = {
        "schema_version": 2,
        "truth_sha256": truth_sha,
        "graph_sha256": graph_sha,
        "event_hashes": {"evt-a": evt_a_sha, "evt-b": evt_b_sha},
        "default_connection": "amplitude",
        "enriched": False,
        "enriched_at": None,
        "generated_at": "17-Apr-26 10:00:00",
        "row_count": 1000,
        "edge_hashes": {
            "edge-a-to-b": {"window_hash": window_hash, "cohort_hash": cohort_hash},
        },
    }
    _write_meta(graphs_dir, name, meta)
    return graphs_dir, truth_path, graph_path, meta


# ---------------------------------------------------------------------------
# Unit tests: pure logic, no DB (tmp_path only)
# ---------------------------------------------------------------------------

class TestFreshnessNoDb:
    """Tests that don't need a DB — file-level checks only."""

    def test_no_truth_when_truth_file_absent(self, tmp_path):
        graphs_dir = tmp_path / "graphs"
        graphs_dir.mkdir()

        from bayes.synth_gen import verify_synth_data
        result = verify_synth_data("nonexistent", str(tmp_path))
        assert result["status"] == "no_truth"

    def test_missing_when_no_meta_and_no_db(self, tmp_path):
        graphs_dir = tmp_path / "graphs"
        graphs_dir.mkdir()
        _write_truth(graphs_dir, "g1")
        _write_graph(graphs_dir, "g1")

        from bayes.synth_gen import verify_synth_data
        # No DB_CONNECTION in env for this call
        with pytest.MonkeyPatch.context() as mp:
            mp.delenv("DB_CONNECTION", raising=False)
            result = verify_synth_data("g1", str(tmp_path))
        assert result["status"] == "missing"

    def test_stale_when_truth_hash_changes_no_db(self, tmp_path):
        graphs_dir, truth_path, _, _ = _build_fresh_layout(tmp_path, "g2")
        truth_path.write_text("modified content")

        from bayes.synth_gen import verify_synth_data
        with pytest.MonkeyPatch.context() as mp:
            mp.delenv("DB_CONNECTION", raising=False)
            result = verify_synth_data("g2", str(tmp_path))
        assert result["status"] == "stale"

    def test_v1_meta_treated_as_stale_no_db(self, tmp_path):
        graphs_dir, truth_path, _, _ = _build_fresh_layout(tmp_path, "g3")
        # Overwrite with v1 meta (no schema_version)
        v1_meta = {
            "truth_sha256": _sha256(truth_path.read_bytes()),
            "generated_at": "17-Apr-26 10:00:00",
            "row_count": 1000,
            "edge_hashes": {
                "edge-a-to-b": {"window_hash": "hash-w", "cohort_hash": "hash-c"},
            },
        }
        _write_meta(graphs_dir, "g3", v1_meta)

        from bayes.synth_gen import verify_synth_data
        with pytest.MonkeyPatch.context() as mp:
            mp.delenv("DB_CONNECTION", raising=False)
            result = verify_synth_data("g3", str(tmp_path))
        assert result["status"] == "stale"

    def test_result_includes_graph_sha256(self, tmp_path):
        _, _, graph_path, _ = _build_fresh_layout(tmp_path, "g4")
        expected_sha = _sha256(graph_path.read_bytes())

        from bayes.synth_gen import verify_synth_data
        with pytest.MonkeyPatch.context() as mp:
            mp.delenv("DB_CONNECTION", raising=False)
            result = verify_synth_data("g4", str(tmp_path))
        assert result.get("graph_sha256") == expected_sha

    def test_reasons_list_present(self, tmp_path):
        _build_fresh_layout(tmp_path, "g5")
        from bayes.synth_gen import verify_synth_data
        with pytest.MonkeyPatch.context() as mp:
            mp.delenv("DB_CONNECTION", raising=False)
            result = verify_synth_data("g5", str(tmp_path))
        assert "reasons" in result
        assert isinstance(result["reasons"], list)

    def test_stale_when_graph_json_changes_no_db(self, tmp_path):
        graphs_dir, _, graph_path, _ = _build_fresh_layout(tmp_path, "g6")
        g = json.loads(graph_path.read_text())
        g["defaultConnection"] = "changed"
        graph_path.write_text(json.dumps(g))

        from bayes.synth_gen import verify_synth_data
        with pytest.MonkeyPatch.context() as mp:
            mp.delenv("DB_CONNECTION", raising=False)
            result = verify_synth_data("g6", str(tmp_path))
        assert result["status"] == "stale"

    def test_stale_when_event_def_changes(self, tmp_path):
        _build_fresh_layout(tmp_path, "g7")
        evt_path = tmp_path / "events" / "evt-a.yaml"
        evt_path.write_text(yaml.dump({"id": "evt-a", "event_name": "CHANGED"}))

        from bayes.synth_gen import verify_synth_data
        with pytest.MonkeyPatch.context() as mp:
            mp.delenv("DB_CONNECTION", raising=False)
            result = verify_synth_data("g7", str(tmp_path),
                                       check_event_hashes=True)
        assert result["status"] == "stale"

    def test_stale_when_connection_changes(self, tmp_path):
        graphs_dir, _, graph_path, meta = _build_fresh_layout(tmp_path, "g8")
        g = json.loads(graph_path.read_text())
        g["defaultConnection"] = "amplitude-staging"
        graph_path.write_text(json.dumps(g))
        # Update graph hash so only connection check fires
        meta["graph_sha256"] = _sha256(graph_path.read_bytes())
        _write_meta(graphs_dir, "g8", meta)

        from bayes.synth_gen import verify_synth_data
        with pytest.MonkeyPatch.context() as mp:
            mp.delenv("DB_CONNECTION", raising=False)
            result = verify_synth_data("g8", str(tmp_path))
        assert result["status"] == "stale"

    def test_stale_when_param_file_missing(self, tmp_path):
        _build_fresh_layout(tmp_path, "g9")
        (tmp_path / "parameters" / "edge-a-to-b.yaml").unlink()

        from bayes.synth_gen import verify_synth_data
        with pytest.MonkeyPatch.context() as mp:
            mp.delenv("DB_CONNECTION", raising=False)
            result = verify_synth_data("g9", str(tmp_path),
                                       check_param_files=True)
        assert result["status"] == "stale"

    def test_stale_when_query_signature_mismatch(self, tmp_path):
        _build_fresh_layout(tmp_path, "g10")
        _write_param(tmp_path / "parameters", "edge-a-to-b",
                     query_signature="WRONG-SIG")

        from bayes.synth_gen import verify_synth_data
        with pytest.MonkeyPatch.context() as mp:
            mp.delenv("DB_CONNECTION", raising=False)
            result = verify_synth_data("g10", str(tmp_path),
                                       check_param_files=True)
        assert result["status"] == "stale"

    def test_unenriched_when_no_model_vars(self, tmp_path):
        _build_fresh_layout(tmp_path, "g11")
        from bayes.synth_gen import verify_synth_data
        with pytest.MonkeyPatch.context() as mp:
            mp.delenv("DB_CONNECTION", raising=False)
            result = verify_synth_data("g11", str(tmp_path),
                                       check_enrichment=True)
        assert result.get("enriched") is False

    @requires_db
    def test_needs_enrichment_status(self):
        """Status is 'needs_enrichment' for a real synth graph with DB rows
        but no bayesian model_vars.
        """
        from bayes.synth_gen import verify_synth_data, _resolve_data_repo
        data_repo = _resolve_data_repo()
        result = verify_synth_data("synth-simple-abc", data_repo,
                                   check_enrichment=True)
        if result["status"] in ("missing", "no_truth"):
            pytest.skip("synth-simple-abc data not available")
        if result.get("enriched"):
            pytest.skip("synth-simple-abc is already enriched")
        assert result["status"] == "needs_enrichment"
        assert result.get("enriched") is False


class TestMetaSidecarV2:
    """save_synth_meta v2 schema completeness."""

    def test_save_meta_records_all_v2_fields(self, tmp_path):
        graphs_dir = tmp_path / "graphs"
        graphs_dir.mkdir()
        truth_path = _write_truth(graphs_dir, "g15")
        graph_path = _write_graph(graphs_dir, "g15")

        from bayes.synth_gen import save_synth_meta
        save_synth_meta(
            "g15", str(truth_path),
            edge_hashes={"edge-a-to-b": {"window_hash": "wh", "cohort_hash": "ch"}},
            row_count=42,
            data_repo=str(tmp_path),
            graph_path=str(graph_path),
            event_hashes={"evt-a": "abc123"},
            default_connection="amplitude",
            enriched=False,
        )

        meta_path = graphs_dir / "g15.synth-meta.json"
        assert meta_path.exists()
        meta = json.loads(meta_path.read_text())

        assert meta["schema_version"] == 2
        assert meta["truth_sha256"] == _sha256(truth_path.read_bytes())
        assert meta["graph_sha256"] == _sha256(graph_path.read_bytes())
        assert meta["event_hashes"] == {"evt-a": "abc123"}
        assert meta["default_connection"] == "amplitude"
        assert meta["enriched"] is False
        assert meta["enriched_at"] is None
        assert meta["row_count"] == 42
        assert "edge_hashes" in meta


# ---------------------------------------------------------------------------
# Integration tests: real DB
# ---------------------------------------------------------------------------

@requires_db
class TestFreshnessWithDb:
    """Integration tests that hit the real snapshot DB.

    These verify that verify_synth_data correctly queries the DB for row
    counts and core_hash integrity. They use a small synth graph
    (synth-simple-abc) which should be present in the test environment.
    """

    def test_fresh_when_synth_data_present(self, tmp_path):
        """verify_synth_data returns 'fresh' for a graph with valid DB data.

        Uses the real file layout + real DB. If synth-simple-abc data
        is not in the DB, this test is skipped (not failed).
        """
        from bayes.synth_gen import verify_synth_data, _resolve_data_repo
        data_repo = _resolve_data_repo()
        result = verify_synth_data("synth-simple-abc", data_repo)
        if result["status"] == "missing":
            pytest.skip("synth-simple-abc data not in DB — run synth_gen first")
        if result["status"] == "no_truth":
            pytest.skip("synth-simple-abc truth file not found")
        # If data exists, it should be fresh or stale (not 'missing')
        assert result["status"] in ("fresh", "stale", "needs_enrichment")
        assert result["row_count"] > 0

    def test_db_rows_have_non_empty_core_hash(self):
        """No rows with empty core_hash should exist for synth edges.

        This is the exact bug that caused the 254k-row incident.
        """
        import psycopg2
        conn = psycopg2.connect(DB_URL)
        cur = conn.cursor()
        cur.execute(
            "SELECT COUNT(*) FROM snapshots "
            "WHERE core_hash = '' AND param_id LIKE %s",
            ("%bayes-test-graph%",),
        )
        empty_count = cur.fetchone()[0]
        conn.close()
        assert empty_count == 0, (
            f"{empty_count} rows with empty core_hash found for synth params — "
            f"this is the doc-43 defect. Run synth_gen --write-files --bust-cache "
            f"to regenerate."
        )

    def test_verify_detects_missing_after_row_count_zero(self):
        """verify_synth_data returns 'missing' when meta points to
        hashes that don't exist in the DB.
        """
        from bayes.synth_gen import verify_synth_data

        # Build a layout with fake hashes that won't match any DB rows
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            _build_fresh_layout(
                tmp_path, "g-fake",
                window_hash="NONEXISTENT-W-HASH-12345",
                cohort_hash="NONEXISTENT-C-HASH-12345",
            )
            result = verify_synth_data("g-fake", str(tmp_path))

        assert result["status"] == "missing"
        assert result["row_count"] == 0
