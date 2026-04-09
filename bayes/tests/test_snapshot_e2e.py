"""
Phase S E2E test: real graph + real snapshot DB.

Runs the full compiler pipeline against the bayes-test-gm-rebuild graph
with snapshot evidence from the production Neon DB. Verifies:

1. Worker can query snapshot DB per subject
2. Evidence binder produces observations from snapshot rows
3. Model converges with real data
4. Posteriors are within reasonable range

Requires:
  - DB_CONNECTION env var or .env.vercel with connection string
  - Graph snapshot file in debug/graph-snapshots/

Run with:
    cd /home/reg/dev/dagnet
    . graph-editor/venv/bin/activate
    DB_CONNECTION="postgresql://..." pytest bayes/tests/test_snapshot_e2e.py -v --tb=short

Skipped automatically if DB_CONNECTION is not available.
"""

from __future__ import annotations

import json
import os
from glob import glob
from pathlib import Path

import pytest

# Skip entire module if no DB connection
DB_URL = os.environ.get("DB_CONNECTION", "")
if not DB_URL:
    # Try loading from .env.vercel
    env_path = Path(__file__).resolve().parent.parent.parent / "graph-editor" / ".env.vercel"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line.startswith("DB_CONNECTION="):
                DB_URL = line.split("=", 1)[1].strip().strip('"')
                break

pytestmark = pytest.mark.skipif(
    not DB_URL,
    reason="DB_CONNECTION not available (set env var or pull .env.vercel)",
)


def _load_graph_snapshot() -> dict:
    """Load the graph from /tmp cache or fetch from git."""
    cache_path = Path("/tmp/bayes-test-graph.json")
    if cache_path.exists():
        with open(cache_path) as f:
            graph = json.load(f)
        if graph.get("nodes") and graph.get("edges"):
            return graph

    # Fetch from git
    env_path = Path(__file__).resolve().parent.parent.parent / "graph-editor" / ".env.vercel"
    env = {}
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env[k] = v.strip('"')

    creds = json.loads(env.get("VITE_CREDENTIALS_JSON", "{}"))
    git = creds.get("git", [{}])[0]
    token, owner, repo = git.get("token"), git.get("owner"), git.get("name")
    if not token:
        pytest.skip("No git credentials for graph fetch")

    import urllib.request, base64
    url = f"https://api.github.com/repos/{owner}/{repo}/contents/graphs/bayes-test-gm-rebuild.json?ref=feature/bayes-test-graph"
    req = urllib.request.Request(url, headers={
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "dagnet-test",
    })
    resp = urllib.request.urlopen(req)
    data = json.loads(resp.read())
    content = base64.b64decode(data["content"]).decode()
    graph = json.loads(content)

    # Cache for subsequent test methods
    with open(cache_path, "w") as f:
        json.dump(graph, f)

    return graph


def _load_param_files_from_snapshot(graph_snapshot: dict) -> dict[str, dict]:
    """Extract parameter file stubs from the graph edges for prior resolution."""
    param_files: dict[str, dict] = {}
    for edge in graph_snapshot.get("edges", []):
        p = edge.get("p", {})
        param_id = p.get("id", "")
        if param_id:
            # Build a minimal param file for prior resolution
            param_files[param_id] = {
                "id": param_id,
                "values": [{
                    "sliceDSL": "window(1-Jan-25:1-Mar-25)",
                    "n": 100,
                    "k": int(100 * (p.get("mean", 0.5) or 0.5)),
                    "mean": p.get("mean", 0.5),
                    "stdev": p.get("stdev", 0.05),
                }],
            }
    return param_files


# Derive workspace prefix from .private-repos.conf (never hard-code the
# private repo name — it must not appear in the public dagnet repo).
def _workspace_prefix() -> str:
    conf_path = os.path.join(os.path.dirname(__file__), '..', '..', '.private-repos.conf')
    repo_name = "data-repo"  # fallback that doesn't leak
    if os.path.isfile(conf_path):
        with open(conf_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("DATA_REPO_DIR="):
                    repo_name = line.split("=", 1)[1].strip()
    return f"{repo_name}-feature/bayes-test-graph"

WORKSPACE_PREFIX = _workspace_prefix()


def _query_all_snapshot_rows(graph_snapshot: dict) -> dict[str, list[dict]]:
    """Query snapshot DB for all edges in the graph.

    Uses direct psycopg2 queries (same as the worker does).
    Returns edge_id → list of snapshot rows.
    """
    import psycopg2

    conn = psycopg2.connect(DB_URL)

    result: dict[str, list[dict]] = {}

    for edge in graph_snapshot.get("edges", []):
        param_id = edge.get("p", {}).get("id", "")
        edge_id = edge["uuid"]
        if not param_id:
            continue

        db_param_id = f"{WORKSPACE_PREFIX}-{param_id}"

        cur = conn.cursor()
        cur.execute("""
            SELECT param_id, core_hash, slice_key, anchor_day,
                   retrieved_at, a, x, y,
                   median_lag_days, mean_lag_days,
                   onset_delta_days
            FROM snapshots
            WHERE param_id = %s
            ORDER BY anchor_day, retrieved_at
        """, (db_param_id,))

        columns = [desc[0] for desc in cur.description]
        rows = [dict(zip(columns, row)) for row in cur.fetchall()]
        cur.close()

        if rows:
            for row in rows:
                if row.get("anchor_day"):
                    row["anchor_day"] = str(row["anchor_day"])
                if row.get("retrieved_at"):
                    row["retrieved_at"] = str(row["retrieved_at"])
            result[edge_id] = rows

    conn.close()
    return result


class TestSnapshotE2ERealDB:
    """E2E: real graph + real snapshot DB → compiler pipeline."""

    def test_can_query_snapshot_rows(self):
        """Verify we can query snapshot rows for the test graph."""
        graph = _load_graph_snapshot()
        snapshot_rows = _query_all_snapshot_rows(graph)

        assert len(snapshot_rows) > 0, (
            "No snapshot rows found for any edge in bayes-test-gm-rebuild"
        )

        total_rows = sum(len(v) for v in snapshot_rows.values())
        print(f"\nSnapshot rows: {len(snapshot_rows)} edges, {total_rows} total rows")
        for edge_id, rows in sorted(snapshot_rows.items(), key=lambda x: -len(x[1])):
            print(f"  {edge_id[:12]}… → {len(rows)} rows")

    def test_evidence_binding_from_snapshots(self):
        """Verify evidence binder produces observations from real snapshot rows."""
        from bayes.compiler import analyse_topology, bind_snapshot_evidence

        graph = _load_graph_snapshot()
        param_files = _load_param_files_from_snapshot(graph)
        snapshot_rows = _query_all_snapshot_rows(graph)

        topology = analyse_topology(graph)
        evidence = bind_snapshot_evidence(
            topology, snapshot_rows, param_files, today="18-Mar-26",
        )

        n_with_data = sum(1 for e in evidence.edges.values() if not e.skipped)
        n_snapshot = sum(
            1 for e in evidence.edges.values()
            if not e.skipped and (
                any(c.trajectories for c in e.cohort_obs) or
                any(c.daily for c in e.cohort_obs) or
                e.window_obs
            )
        )

        print(f"\nEvidence: {n_with_data} edges with data, {n_snapshot} from snapshots")
        for d in evidence.diagnostics:
            print(f"  {d}")

        assert n_with_data > 0, "No edges with data after evidence binding"

    def test_full_pipeline_convergence(self):
        """Run the full compiler pipeline with real snapshot data."""
        from bayes.compiler import (
            analyse_topology,
            bind_snapshot_evidence,
            build_model,
            run_inference,
            summarise_posteriors,
        )
        from bayes.compiler.types import SamplingConfig

        graph = _load_graph_snapshot()
        param_files = _load_param_files_from_snapshot(graph)
        snapshot_rows = _query_all_snapshot_rows(graph)

        topology = analyse_topology(graph)
        evidence = bind_snapshot_evidence(
            topology, snapshot_rows, param_files, today="18-Mar-26",
        )

        n_with_data = sum(1 for e in evidence.edges.values() if not e.skipped)
        if n_with_data == 0:
            pytest.skip("No edges with data — can't test inference")

        model, metadata = build_model(topology, evidence)

        config = SamplingConfig(
            draws=1000,
            tune=500,
            chains=2,
            cores=2,
            target_accept=0.95,
            random_seed=42,
        )
        trace, quality = run_inference(model, config)
        result = summarise_posteriors(trace, topology, evidence, metadata, quality)

        print(f"\nInference complete:")
        print(f"  Edges fitted: {len(result.posteriors)}")
        print(f"  Edges skipped: {len(result.skipped)}")
        print(f"  Max rhat: {quality.max_rhat:.4f}")
        print(f"  Min ESS: {quality.min_ess:.0f}")
        print(f"  Divergences: {quality.total_divergences}")
        print(f"  Converged: {quality.converged_pct}%")

        for p in result.posteriors:
            print(f"  {p.param_id}: mean={p.mean:.4f} stdev={p.stdev:.4f} "
                  f"rhat={p.rhat:.3f} ess={p.ess:.0f}")

        # Basic convergence checks (real data may have marginal edges)
        assert len(result.posteriors) > 0, "No posteriors produced"
        assert quality.converged_pct > 50, (
            f"Less than half of edges converged: {quality.converged_pct}%"
        )

        # At least some edges should have reasonable posteriors
        good_edges = [p for p in result.posteriors if p.rhat < 1.05 and p.ess > 400]
        assert len(good_edges) > 0, "No edges with good convergence"

        # Posterior means should be in [0, 1] (basic sanity)
        for p in result.posteriors:
            assert 0 < p.mean < 1, f"Edge {p.param_id}: mean={p.mean} outside (0,1)"

    def test_query_snapshot_subjects_real_db(self):
        """Baseline: _query_snapshot_subjects with real DB and real subjects.

        Builds snapshot_subjects from the graph by discovering core_hashes
        from the DB for each edge's param_id. This closes the test gap where
        _query_snapshot_subjects was never tested directly.

        When query_snapshots_batch is implemented, this test becomes the
        parity baseline: call both paths, assert identical results.
        """
        import psycopg2
        from bayes.compiler import analyse_topology

        graph = _load_graph_snapshot()
        topology = analyse_topology(graph)

        # Discover core_hashes from DB for each parameterised edge
        conn = psycopg2.connect(DB_URL)
        cur = conn.cursor()

        snapshot_subjects = []
        for edge in graph.get("edges", []):
            param_id = edge.get("p", {}).get("id", "")
            edge_id = edge.get("uuid", "")
            if not param_id or not edge_id:
                continue

            db_param_id = f"{WORKSPACE_PREFIX}-{param_id}"

            # Find distinct core_hashes for this param_id
            cur.execute("""
                SELECT DISTINCT core_hash
                FROM snapshots
                WHERE param_id = %s
            """, (db_param_id,))

            for (core_hash,) in cur.fetchall():
                snapshot_subjects.append({
                    "param_id": db_param_id,
                    "core_hash": core_hash,
                    "edge_id": edge_id,
                    "slice_keys": [""],
                    "equivalent_hashes": None,
                })

        # Use a single shared date range across all subjects (mirrors FE
        # pinnedDSL behaviour — all subjects share the same dates).
        cur.execute("""
            SELECT MIN(anchor_day), MAX(anchor_day),
                   MIN(retrieved_at::date), MAX(retrieved_at::date)
            FROM snapshots
            WHERE param_id = ANY(%s)
        """, ([s["param_id"] for s in snapshot_subjects],))
        anchor_from, anchor_to, sweep_from, sweep_to = cur.fetchone()
        for subj in snapshot_subjects:
            subj["anchor_from"] = anchor_from.isoformat() if anchor_from else ""
            subj["anchor_to"] = anchor_to.isoformat() if anchor_to else ""
            subj["sweep_from"] = sweep_from.isoformat() if sweep_from else ""
            subj["sweep_to"] = sweep_to.isoformat() if sweep_to else ""

        cur.close()
        conn.close()

        assert len(snapshot_subjects) > 0, (
            "No snapshot subjects built — DB has no rows for this graph's param_ids"
        )

        # Call the actual worker function
        import sys, os
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'graph-editor', 'lib'))
        os.environ["DB_CONNECTION"] = DB_URL

        from bayes.worker import _query_snapshot_subjects

        log: list[str] = []
        result = _query_snapshot_subjects(snapshot_subjects, topology, log)

        # Verify we got rows back
        edges_with_rows = {eid for eid, rows in result.items() if rows}
        total_rows = sum(len(rows) for rows in result.values())

        print(f"\n_query_snapshot_subjects: {len(snapshot_subjects)} subjects → "
              f"{len(edges_with_rows)} edges with data, {total_rows} total rows")
        for eid, rows in sorted(result.items(), key=lambda x: -len(x[1])):
            print(f"  {eid[:12]}… → {len(rows)} rows")

        assert len(edges_with_rows) > 0, "No edges returned rows from _query_snapshot_subjects"
        assert total_rows > 0, "Zero total rows from _query_snapshot_subjects"

        # Verify row shape — each row should have the expected columns
        sample_row = next(iter(result.values()))[0]
        expected_keys = {"param_id", "core_hash", "slice_key", "anchor_day", "retrieved_at", "a", "x", "y"}
        assert expected_keys.issubset(sample_row.keys()), (
            f"Row missing expected keys. Got: {set(sample_row.keys())}"
        )

        # ── Parity: compare per-subject path vs batch path ──
        # The batch path is now the default in _query_snapshot_subjects.
        # Compare against individual query_snapshots_for_sweep calls to
        # verify the batch produces identical results.
        from datetime import date
        from snapshot_service import query_snapshots_for_sweep

        per_subject_result: dict[str, list[dict]] = {}
        for subj in snapshot_subjects:
            edge_id = subj["edge_id"]
            rows = query_snapshots_for_sweep(
                param_id=subj["param_id"],
                core_hash=subj["core_hash"],
                slice_keys=subj.get("slice_keys", [""]),
                anchor_from=date.fromisoformat(subj["anchor_from"]) if subj.get("anchor_from") else None,
                anchor_to=date.fromisoformat(subj["anchor_to"]) if subj.get("anchor_to") else None,
                sweep_from=date.fromisoformat(subj["sweep_from"]) if subj.get("sweep_from") else None,
                sweep_to=date.fromisoformat(subj["sweep_to"]) if subj.get("sweep_to") else None,
                equivalent_hashes=subj.get("equivalent_hashes"),
            )
            if rows:
                per_subject_result.setdefault(edge_id, []).extend(rows)

        def _row_sort_key(r):
            return (r.get("core_hash", ""), r.get("anchor_day", ""),
                    r.get("slice_key", ""), r.get("retrieved_at", ""))

        # Same edge_ids
        assert set(result.keys()) == set(per_subject_result.keys()), (
            f"Edge ID mismatch: batch={set(result.keys())}, "
            f"per-subject={set(per_subject_result.keys())}"
        )

        # Same rows per edge
        for edge_id in result:
            batch_rows = sorted(result[edge_id], key=_row_sort_key)
            indiv_rows = sorted(per_subject_result[edge_id], key=_row_sort_key)
            assert len(batch_rows) == len(indiv_rows), (
                f"Row count mismatch for {edge_id}: "
                f"batch={len(batch_rows)}, per-subject={len(indiv_rows)}"
            )
            for i, (b, p) in enumerate(zip(batch_rows, indiv_rows)):
                assert b == p, (
                    f"Row {i} mismatch for {edge_id}:\n"
                    f"  batch:      {b}\n"
                    f"  per-subject: {p}"
                )

        print(f"\nParity check passed: {len(result)} edges, all rows identical")
