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

    def test_stale_when_context_definition_changes(self, tmp_path):
        """Detects the synth-channel overwrite failure: a sibling truth
        rewrote contexts/<id>.yaml with different labels, silently
        invalidating every DB row registered under the old dim hash.
        """
        graphs_dir, _, _, meta = _build_fresh_layout(tmp_path, "g12")
        contexts_dir = tmp_path / "contexts"
        contexts_dir.mkdir()
        ctx_path = contexts_dir / "my-dim.yaml"
        ctx_path.write_text(yaml.dump({"id": "my-dim", "values": [{"id": "a"}]}))
        # Pin the original ctx file hash into meta
        meta["context_file_hashes"] = {"my-dim": _sha256(ctx_path.read_bytes())}
        _write_meta(graphs_dir, "g12", meta)
        # Simulate a sibling truth overwriting the same dim file
        ctx_path.write_text(yaml.dump({"id": "my-dim", "values": [{"id": "b"}]}))

        from bayes.synth_gen import verify_synth_data
        with pytest.MonkeyPatch.context() as mp:
            mp.delenv("DB_CONNECTION", raising=False)
            result = verify_synth_data("g12", str(tmp_path))
        assert result["status"] == "stale"
        assert any("Context definition changed" in r for r in result["reasons"])


class TestContextSharingModel:
    """Context files in contexts/<dim_id>.yaml are shared across truths
    using the same dim id. Overwrite is legitimate; the assurance chain
    (context_file_hashes in meta + verify_synth_data) marks previously-
    bootstrapped graphs as stale when their pinned ctx hash drifts.

    These tests pin the contract: write_context_files never aborts on
    overwrite — it warns and records who just became stale.
    """

    def _dim(self, dim_id: str, labels: list[str]) -> dict:
        return {
            "id": dim_id,
            "mece": True,
            "values": [
                {"id": f"v{i}", "label": lbl,
                 "sources": {"amplitude": {"field": "utm_medium",
                                            "filter": f"utm_medium == 'v{i}'"}}}
                for i, lbl in enumerate(labels)
            ],
        }

    def test_allows_write_when_file_absent(self, tmp_path):
        from bayes.synth_gen import write_context_files
        truth = {"context_dimensions": [self._dim("dim-x", ["A", "B"])]}
        written = write_context_files(truth, str(tmp_path))
        assert written == ["dim-x"]
        assert (tmp_path / "contexts" / "dim-x.yaml").exists()

    def test_allows_write_when_content_matches(self, tmp_path):
        """Idempotent re-write is fine — same truth, same bytes."""
        from bayes.synth_gen import write_context_files
        truth = {"context_dimensions": [self._dim("dim-x", ["A", "B"])]}
        write_context_files(truth, str(tmp_path))
        written2 = write_context_files(truth, str(tmp_path))
        assert written2 == ["dim-x"]

    def test_overwrites_and_warns_on_content_change(self, tmp_path, capsys):
        """When a sibling truth changes the shared dim's content,
        write_context_files must proceed (not abort) so the workflow
        can continue — but surface a clear warning.
        """
        from bayes.synth_gen import write_context_files
        truth_a = {"context_dimensions": [self._dim("dim-x", ["Google", "Direct"])]}
        write_context_files(truth_a, str(tmp_path))
        truth_b = {"context_dimensions": [self._dim("dim-x", ["Baseline (A)", "Treatment B"])]}

        # Must NOT raise
        written = write_context_files(truth_b, str(tmp_path))
        assert written == ["dim-x"]

        # File now contains truth_b's content
        ctx_bytes = (tmp_path / "contexts" / "dim-x.yaml").read_bytes()
        assert b"Baseline (A)" in ctx_bytes
        assert b"Google" not in ctx_bytes

        # Warning was emitted
        out = capsys.readouterr().out
        assert "WARNING" in out
        assert "content is changing" in out

    def test_warning_lists_affected_graphs(self, tmp_path, capsys):
        """The warning must name every graph that had pinned the prior
        ctx hash via its synth-meta sidecar, so the user knows exactly
        which graphs need re-bootstrap.
        """
        from bayes.synth_gen import write_context_files
        truth_a = {"context_dimensions": [self._dim("dim-x", ["Google"])]}
        write_context_files(truth_a, str(tmp_path))

        # Simulate a graph that bootstrapped against truth_a (pinned old sha)
        graphs_dir = tmp_path / "graphs"
        graphs_dir.mkdir()
        old_sha = _sha256((tmp_path / "contexts" / "dim-x.yaml").read_bytes())
        meta = {"schema_version": 2, "context_file_hashes": {"dim-x": old_sha}}
        (graphs_dir / "graph-alpha.synth-meta.json").write_text(json.dumps(meta))
        (graphs_dir / "graph-beta.synth-meta.json").write_text(json.dumps(meta))

        # Sibling truth with different content
        truth_b = {"context_dimensions": [self._dim("dim-x", ["Changed"])]}
        write_context_files(truth_b, str(tmp_path))

        out = capsys.readouterr().out
        assert "graph-alpha" in out
        assert "graph-beta" in out
        assert "re-bootstrap" in out.lower()

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
