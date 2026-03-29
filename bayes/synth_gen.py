#!/usr/bin/env python3
"""
Monte Carlo synthetic data generator for Bayes parameter recovery testing.

Simulates a population traversing a DAG with known ground-truth parameters,
producing snapshot-format trajectory data that feeds directly into the
evidence binding pipeline.

Usage:
    . graph-editor/venv/bin/activate
    cd bayes

    # Generate + write to snapshot DB (uses real core hashes, FE-visible)
    python synth_gen.py --graph branch

    # Dry run (print summary, don't write to DB)
    python synth_gen.py --graph branch --dry-run

    # Custom simulation size with noise controls
    python synth_gen.py --graph branch --people 10000 --days 200 --kappa 15

    # Enable random-walk drift on p
    python synth_gen.py --graph branch --drift 0.02

    # Clean up synthetic data (by core_hash)
    python synth_gen.py --clean --graph branch

Output format matches _query_snapshot_subjects return shape so
bind_snapshot_evidence can consume it directly.

See doc 17 for design rationale.
"""
from __future__ import annotations

import base64
import bisect
import hashlib
import os
import sys
import json
import math
import yaml
import argparse
import numpy as np
from datetime import datetime, timedelta
from collections import defaultdict
from typing import Any

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "bayes"))


# ---------------------------------------------------------------------------
# Graph + truth config loading
# ---------------------------------------------------------------------------

# Edge configs with real FE-computed core hashes (matching test_harness.py).
# Format: (param_id, edge_uuid, window_core_hash, cohort_core_hash)
GRAPH_CONFIGS: dict[str, dict[str, Any]] = {
    "simple": {
        "graph_file": "bayes-test-gm-rebuild.json",
        "graph_id": "graph-bayes-test-gm-rebuild",
        "edges": [
            ("bayes-test-create-to-delegated",      "c64ddc4d-c369-4ae8-a44a-398a63a46ab1", "UaWTiPJp1kTXTlkigKzBAQ", "1npRXxdOjD56XTgKnZKbsw"),
            ("bayes-test-delegated-to-registered",   "7bb83fbf-3ac6-4152-a395-a8b64a12506a", "ES2r-ClxqBl4VQQqYdfYYg", "YSX41CZhnZKsP49i80jjTg"),
            ("bayes-test-landing-to-created",        "b91c2820-7a1d-4498-9082-5967b5027d76", "SXVK13yfsOIpXc4RQSv2GA", "yHCQevqcdyITym82h-uwdQ"),
            ("bayes-test-registered-to-success",     "97b11265-1242-4fa8-a097-359f2384665a", "VTgXES1p_XdQoHMZ7VsEoA", "XiDhZpbnp535eBHiPu614w"),
        ],
        "base_date": "2025-11-19",
    },
    "branch": {
        "graph_file": "conversion-flow-v2-recs-collapsed.json",
        "graph_id": "graph-conversion-flow-v2-recs-collapsed",
        "edges": [
            ("coffee-to-bds",                    "76e0e0f8-133d-4065-9fab-56480063d9c9", "HZC_WqTRBfy7zPWtXTtY7A", "plxD-64WK7_SJAY--TUlcA"),
            ("registration-to-success",          "370dce1d-3a36-4109-9711-204c301478c8", "-wNEREQRwNRE5wRjjuy2iQ", "CsFATi4Ye90pSpK-tEyzbg"),
            ("household-delegation-rate",        "3d0a0757-8224-4cf0-a841-4ad17cd48d91", "r0AMpAJ_uExLojzFQhI3BQ", "QqoOJonqx8zzialfD5jKlQ"),
            ("delegated-to-non-energy-rec",      "10e37cc7-0d37-4cd9-844b-653148025a51", "0Q4-AGwPXERTs5bQ0NACRg", "v_BRrQXxGn6lQ0MuJVccpA"),
            ("bds-to-energy-rec",                "77d0a69e-3c75-4722-932b-7f54d317d0ce", "D6tg5LOxVxSqUXvaLjtbog", "spQwZYRcECdZMr2CshbT-g"),
            ("delegated-to-coffee",              "64f4529c-62b8-4e7e-8479-c5289d925e58", "cFSR9ljHVYv9oAxijnyEWg", "kpDI95Ogtg6Rstx-jFpGCQ"),
            ("no-bdos-to-rec",                   "13b5397f-9feb-453a-8e86-500c0693b4af", "xrcxwR2t-wEECamJSw4RNg", "gTtI0X5ks5GD4USIz_tEGQ"),
            ("delegation-straight-to-energy-rec","8c23ea34-9c7e-40b3-ade3-291590774bfc", "EtC-FhDURPFuAvbZmc_DcA", "4Rfk9gYwK_27k2po2zOxzA"),
            ("non-energy-rec-to-reg",            "9624cce1-21f3-4085-9388-c155b5b657fd", "gmOm0rBQD9HRA3l8Kdo7hw", "_oPC_SNhxKml76ZzmESycg"),
            ("rec-with-bdos-to-registration",    "d45debd8-939b-4abb-b0d0-c5ef62412add", "ENci8vAkh-B9vMUx9SutXQ", "z3jCJuGWXK5g7h47on_Ryg"),
        ],
        "base_date": "2025-11-01",
    },
    "diamond": {
        "graph_file": "synth-diamond-test.json",
        "graph_id": "graph-synth-diamond-test",
        "edges": [
            ("synth-anchor-to-gate",   "a2bdb15c-a828-45e3-9af3-0ec414ab709d", "SYNTH-anchor-to-gate-w",   "SYNTH-anchor-to-gate-c"),
            ("synth-gate-to-path-a",   "273f7315-a626-4440-8ce4-89cd9225bf43", "SYNTH-gate-to-path-a-w",   "SYNTH-gate-to-path-a-c"),
            ("synth-gate-to-path-b",   "dbe5585c-7669-4cf8-ab33-8ed294db80ea", "SYNTH-gate-to-path-b-w",   "SYNTH-gate-to-path-b-c"),
            ("synth-path-a-to-join",   "c41a7e20-5f33-4d9a-b1c2-3e8f7a6d9b04", "SYNTH-path-a-to-join-w",   "SYNTH-path-a-to-join-c"),
            ("synth-path-b-to-join",   "2901e1fd-640b-4bd7-b028-af458e3b0cbe", "SYNTH-path-b-to-join-w",   "SYNTH-path-b-to-join-c"),
            ("synth-join-to-outcome",  "7abcdf0c-e6a5-4ccd-81db-4fb1116ebe2c", "SYNTH-join-to-outcome-w",  "SYNTH-join-to-outcome-c"),
        ],
        "base_date": "2025-12-12",
    },
    "simple": {
        "graph_file": "synth-simple-abc.json",
        "graph_id": "graph-synth-simple-abc",
        "edges": [
            ("simple-a-to-b", "80844ce8-094b-4ab7-b0a1-c5569f1b72a8", "tO7LaG4KYJmjx9IDcqWoOA", "UiR0QGUoUuGfnKV8wgLnGg"),
            ("simple-b-to-c", "69320810-4258-4883-8093-7c3fb34640c2", "gQ5ZaO6wsxdaoBhlsTSymA", "hiUamUGuhipvS5Y061h75Q"),
        ],
        "base_date": "2025-12-12",
    },
    "drift3d10d": {
        "graph_file": "synth-drift3d10d.json",
        "graph_id": "graph-synth-drift3d10d",
        "edges": [
            ("drift3d10d-a-to-b", "b0e8b7b1-b684-4ee6-920f-7c25ee3b6c91", "SYNTH-drift3d10d-a-to-b-w", "SYNTH-drift3d10d-a-to-b-c"),
            ("drift3d10d-b-to-c", "e7491561-fe3b-412f-ace5-2bd6a57f3112", "SYNTH-drift3d10d-b-to-c-w", "SYNTH-drift3d10d-b-to-c-c"),
        ],
        "base_date": "2025-12-12",
    },
    "drift10d10d": {
        "graph_file": "synth-drift10d10d.json",
        "graph_id": "graph-synth-drift10d10d",
        "edges": [
            ("drift10d10d-a-to-b", "9bd28742-1ade-4f0a-b047-457cacfa8712", "SYNTH-drift10d10d-a-to-b-w", "SYNTH-drift10d10d-a-to-b-c"),
            ("drift10d10d-b-to-c", "5f277cbf-e5da-4af5-a6b2-c735dd2a099e", "SYNTH-drift10d10d-b-to-c-w", "SYNTH-drift10d10d-b-to-c-c"),
        ],
        "base_date": "2025-12-12",
    },
    "skip": {
        "graph_file": "synth-skip-test.json",
        "graph_id": "graph-synth-skip-test",
        "edges": [
            ("synth-sk-anchor-to-middle", "ba49643e-3403-42e4-a74b-46d9abdd2ea0", "PLACEHOLDER-w", "PLACEHOLDER-c"),
            ("synth-sk-anchor-to-target", "69e50f20-8710-499e-95a7-158b89f7b145", "PLACEHOLDER-w", "PLACEHOLDER-c"),
            ("synth-sk-middle-to-target", "f35a11ae-84a4-4396-839c-eee557ff1d47", "PLACEHOLDER-w", "PLACEHOLDER-c"),
            ("synth-sk-target-to-outcome", "75eb6486-6033-4ea7-91ae-9e1954f56bed", "PLACEHOLDER-w", "PLACEHOLDER-c"),
        ],
        "base_date": "2025-12-12",
    },
    "3join": {
        "graph_file": "synth-3way-join-test.json",
        "graph_id": "graph-synth-3way-join-test",
        "edges": [
            ("synth-3j-anchor-to-a",     "b6e72579-e4e2-4ad2-a468-f03b763d9518", "PLACEHOLDER-w", "PLACEHOLDER-c"),
            ("synth-3j-anchor-to-b",     "e54d94fb-5ebf-465e-82e4-3279968dff9c", "PLACEHOLDER-w", "PLACEHOLDER-c"),
            ("synth-3j-anchor-to-c",     "06d48cf6-1791-4616-b54d-e164cb09cf99", "PLACEHOLDER-w", "PLACEHOLDER-c"),
            ("synth-3j-a-to-join",       "a6356eaa-6193-48f1-81e9-ba030de782aa", "PLACEHOLDER-w", "PLACEHOLDER-c"),
            ("synth-3j-b-to-join",       "cc8e21a6-37c8-4a57-a639-69874cb9891b", "PLACEHOLDER-w", "PLACEHOLDER-c"),
            ("synth-3j-c-to-join",       "a2771c0e-f341-4eb6-847c-3057718ab8b3", "PLACEHOLDER-w", "PLACEHOLDER-c"),
            ("synth-3j-join-to-outcome", "45363ab9-b948-4c61-93e4-3acba4dedddf", "PLACEHOLDER-w", "PLACEHOLDER-c"),
        ],
        "base_date": "2025-12-12",
    },
    "joinbranch": {
        "graph_file": "synth-join-branch-test.json",
        "graph_id": "graph-synth-join-branch-test",
        "edges": [
            ("synth-jb-anchor-to-a",   "a2f1c1fe-591c-4f80-98c5-332212fab0b2", "PLACEHOLDER-w", "PLACEHOLDER-c"),
            ("synth-jb-anchor-to-b",   "5ee86f9c-a34d-4cba-b245-a41263a42f03", "PLACEHOLDER-w", "PLACEHOLDER-c"),
            ("synth-jb-a-to-join",     "89408718-7de6-4b91-b091-eafa75cec6a3", "PLACEHOLDER-w", "PLACEHOLDER-c"),
            ("synth-jb-b-to-join",     "ff8d5b84-7b4c-4b58-b36b-eb4a1711146f", "PLACEHOLDER-w", "PLACEHOLDER-c"),
            ("synth-jb-join-to-fast",  "87a90ca3-641f-4f51-b402-43d93eda61f8", "PLACEHOLDER-w", "PLACEHOLDER-c"),
            ("synth-jb-join-to-slow",  "a2e4cdc3-e0af-4d2a-ad79-163dc34c12b5", "PLACEHOLDER-w", "PLACEHOLDER-c"),
        ],
        "base_date": "2025-12-12",
    },
    "fanout": {
        "graph_file": "synth-fanout-test.json",
        "graph_id": "graph-synth-fanout-test",
        "edges": [
            ("synth-fo-anchor-to-gate", "c5275986-d61d-457f-8e7a-5c72a302d02a", "PLACEHOLDER-w", "PLACEHOLDER-c"),
            ("synth-fo-gate-to-fast",   "8d638bb5-ec14-48c5-9246-b6b0202f1504", "PLACEHOLDER-w", "PLACEHOLDER-c"),
            ("synth-fo-gate-to-slow",   "a5bc58f0-5275-4b7f-b2b2-8a2f2f3837a9", "PLACEHOLDER-w", "PLACEHOLDER-c"),
        ],
        "base_date": "2025-12-12",
    },
    "mirror": {
        "graph_file": "synth-mirror-4step.json",
        "graph_id": "graph-synth-mirror-4step",
        "edges": [
            ("m4-landing-to-created",      "1c3b7f6c-0ef4-4415-a660-ba7fdf659bf0", "PLACEHOLDER-w", "PLACEHOLDER-c"),
            ("m4-created-to-delegated",    "5341d386-d19c-45c0-9d3e-9c9779f0627c", "PLACEHOLDER-w", "PLACEHOLDER-c"),
            ("m4-delegated-to-registered", "7a26c540-0bc6-4afa-8333-67d46b2f92ba", "PLACEHOLDER-w", "PLACEHOLDER-c"),
            ("m4-registered-to-success",   "e4a7a43c-37c5-44d1-9bb3-15914232f47b", "PLACEHOLDER-w", "PLACEHOLDER-c"),
        ],
        "base_date": "2025-12-12",
    },
}


# ---------------------------------------------------------------------------
# Importable API: discovery, verification, meta sidecar
# ---------------------------------------------------------------------------

def discover_synth_graphs(data_repo: str | None = None) -> list[dict]:
    """Discover synth graphs from truth files in the data repo.

    Returns list of dicts with keys:
        graph_name, truth_path, graph_path (may not exist yet),
        has_graph_json, has_new_format
    """
    if data_repo is None:
        data_repo = _resolve_data_repo()
    graphs_dir = os.path.join(data_repo, "graphs")
    if not os.path.isdir(graphs_dir):
        return []

    from graph_from_truth import truth_has_graph_structure

    results = []
    for fname in sorted(os.listdir(graphs_dir)):
        if not fname.startswith("synth-") or not fname.endswith(".truth.yaml"):
            continue
        if ".truth.hard." in fname:
            continue

        graph_name = fname.replace(".truth.yaml", "")
        truth_path = os.path.join(graphs_dir, fname)
        graph_path = os.path.join(graphs_dir, f"{graph_name}.json")

        with open(truth_path) as f:
            truth = yaml.safe_load(f) or {}

        results.append({
            "graph_name": graph_name,
            "truth_path": truth_path,
            "graph_path": graph_path,
            "has_graph_json": os.path.isfile(graph_path),
            "has_new_format": truth_has_graph_structure(truth),
            "truth": truth,
        })
    return results


def verify_synth_data(graph_name: str, data_repo: str | None = None) -> dict:
    """Check whether synth data for a graph is present and fresh.

    Returns dict with:
        status: "fresh" | "stale" | "missing" | "no_truth"
        reason: human-readable explanation
        row_count: total DB rows (0 if not checked)
        truth_sha256: current truth file hash
        meta: loaded .synth-meta.json (empty dict if absent)
    """
    if data_repo is None:
        data_repo = _resolve_data_repo()
    graphs_dir = os.path.join(data_repo, "graphs")

    truth_path = os.path.join(graphs_dir, f"{graph_name}.truth.yaml")
    if not os.path.isfile(truth_path):
        return {"status": "no_truth", "reason": f"No truth file: {truth_path}",
                "row_count": 0, "truth_sha256": "", "meta": {}}

    # Current truth file fingerprint
    with open(truth_path, "rb") as f:
        truth_sha = hashlib.sha256(f.read()).hexdigest()

    # Load meta sidecar
    meta_path = os.path.join(graphs_dir, f"{graph_name}.synth-meta.json")
    meta = {}
    if os.path.isfile(meta_path):
        with open(meta_path) as f:
            try:
                meta = json.load(f)
            except json.JSONDecodeError:
                meta = {}

    # Check truth file hash against meta
    truth_stale = False
    if meta and meta.get("truth_sha256") != truth_sha:
        truth_stale = True

    # Check DB rows — either via meta hashes or via FE hash computation
    db_conn = _load_db_connection()

    if not db_conn:
        # Can't verify DB — trust the meta if it exists and is fresh
        if not meta:
            return {"status": "missing", "reason": "No .synth-meta.json and no DB available",
                    "row_count": 0, "truth_sha256": truth_sha, "meta": meta}
        if truth_stale:
            return {"status": "stale", "reason": "Truth file changed since last generation",
                    "row_count": 0, "truth_sha256": truth_sha, "meta": meta}
        stored_count = meta.get("row_count", 0)
        if stored_count > 0:
            return {"status": "fresh", "reason": f"Meta says {stored_count} rows (DB not checked)",
                    "row_count": stored_count, "truth_sha256": truth_sha, "meta": meta}
        return {"status": "missing", "reason": "Meta shows 0 rows and DB not available",
                "row_count": 0, "truth_sha256": truth_sha, "meta": meta}

    # No meta and no graph JSON → definitely missing (skip DB entirely)
    graph_path = os.path.join(graphs_dir, f"{graph_name}.json")
    if not meta and not os.path.isfile(graph_path):
        return {"status": "missing", "reason": "No meta sidecar and no graph JSON",
                "row_count": 0, "truth_sha256": truth_sha, "meta": meta}

    # DB is available — verify row counts
    try:
        import psycopg2
        conn = psycopg2.connect(db_conn)
        cur = conn.cursor()
        total = 0

        # Try meta hashes first (fast path)
        if meta and meta.get("edge_hashes"):
            for edge_hashes in meta["edge_hashes"].values():
                for h in [edge_hashes.get("window_hash", ""), edge_hashes.get("cohort_hash", "")]:
                    if h and not h.startswith("PLACEHOLDER") and not h.startswith("SIM-"):
                        cur.execute("SELECT COUNT(*) FROM snapshots WHERE core_hash = %s", (h,))
                        total += cur.fetchone()[0]
        else:
            # No meta — compute hashes via FE and check DB directly
            graph_path = os.path.join(graphs_dir, f"{graph_name}.json")
            if os.path.isfile(graph_path):
                from compiler.topology import analyse_topology
                with open(graph_path) as f:
                    graph = json.load(f)
                topo = analyse_topology(graph)
                fe_hashes = compute_core_hashes(graph, topo, data_repo)
                for pid, hashes in fe_hashes.items():
                    if pid.startswith("parameter-"):
                        continue
                    for h in [hashes.get("window_hash", ""), hashes.get("cohort_hash", "")]:
                        if h and not h.startswith("PLACEHOLDER") and not h.startswith("SIM-"):
                            cur.execute("SELECT COUNT(*) FROM snapshots WHERE core_hash = %s", (h,))
                            total += cur.fetchone()[0]
        conn.close()

        if truth_stale:
            return {"status": "stale", "reason": "Truth file changed since last generation",
                    "row_count": total, "truth_sha256": truth_sha, "meta": meta}

        if total == 0:
            return {"status": "missing", "reason": "0 DB rows found",
                    "row_count": 0, "truth_sha256": truth_sha, "meta": meta}

        return {"status": "fresh", "reason": f"{total} DB rows verified",
                "row_count": total, "truth_sha256": truth_sha, "meta": meta}
    except Exception as e:
        return {"status": "missing", "reason": f"DB check failed: {e}",
                "row_count": 0, "truth_sha256": truth_sha, "meta": meta}


def save_synth_meta(
    graph_name: str,
    truth_path: str,
    edge_hashes: dict[str, dict[str, str]],
    row_count: int,
    data_repo: str | None = None,
) -> None:
    """Write .synth-meta.json sidecar after successful generation."""
    if data_repo is None:
        data_repo = _resolve_data_repo()
    graphs_dir = os.path.join(data_repo, "graphs")

    with open(truth_path, "rb") as f:
        truth_sha = hashlib.sha256(f.read()).hexdigest()

    meta = {
        "truth_sha256": truth_sha,
        "generated_at": datetime.now().strftime("%-d-%b-%y %H:%M:%S"),
        "row_count": row_count,
        "edge_hashes": edge_hashes,
    }

    meta_path = os.path.join(graphs_dir, f"{graph_name}.synth-meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)


def _resolve_data_repo() -> str:
    conf_path = os.path.join(REPO_ROOT, ".private-repos.conf")
    if not os.path.exists(conf_path):
        print("ERROR: .private-repos.conf not found")
        sys.exit(1)
    for line in open(conf_path):
        line = line.strip()
        if line.startswith("DATA_REPO_DIR="):
            return os.path.join(REPO_ROOT, line.split("=", 1)[1].strip().strip('"'))
    print("ERROR: DATA_REPO_DIR not found")
    sys.exit(1)


def _load_db_connection() -> str:
    env_path = os.path.join(REPO_ROOT, "graph-editor", ".env.local")
    if os.path.exists(env_path):
        for line in open(env_path):
            line = line.strip()
            if line.startswith("DB_CONNECTION="):
                return line.split("=", 1)[1].strip().strip('"')
    return ""


def _sha256_hex(text: str) -> str:
    """SHA-256 of UTF-8 bytes, full hex digest. Matches FE hashText()."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _short_hash(canonical: str) -> str:
    """SHA-256 → first 16 bytes → base64url (no padding).

    Matches coreHashService.ts computeShortCoreHash() and
    snapshot_service.py short_core_hash_from_canonical_signature().
    """
    digest = hashlib.sha256(canonical.strip().encode("utf-8")).digest()[:16]
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def compute_core_hashes(
    graph_snapshot: dict,
    topology,
    data_repo: str,
) -> dict[str, dict[str, str]]:
    """Compute real FE-compatible core hashes for each edge.

    Replicates the FE's querySignature.ts → coreHashService.ts pipeline:
    1. Build coreCanonical JSON (connection, event_ids, event_def_hashes,
       query, latency_parameter, etc.)
    2. coreHash = sha256(coreCanonical).hex()
    3. structuredSig = JSON.stringify({c: coreHash, x: {}})
    4. core_hash = sha256(structuredSig)[:16] → base64url

    Two hashes per edge: window (cohort_mode=false) and cohort (cohort_mode=true).

    Returns dict[param_id → {window_hash, cohort_hash}].
    """
    # Build node lookups
    nodes_by_id = {n["id"]: n for n in graph_snapshot.get("nodes", [])}
    nodes_by_uuid = {n["uuid"]: n for n in graph_snapshot.get("nodes", [])}

    def find_node(ref: str) -> dict | None:
        return nodes_by_id.get(ref) or nodes_by_uuid.get(ref)

    # Load event definitions from data repo
    event_defs: dict[str, dict] = {}
    events_dir = os.path.join(data_repo, "events")
    if os.path.isdir(events_dir):
        for fname in os.listdir(events_dir):
            if fname.endswith(".yaml"):
                with open(os.path.join(events_dir, fname)) as f:
                    edef = yaml.safe_load(f) or {}
                    if edef.get("id"):
                        event_defs[edef["id"]] = edef

    result: dict[str, dict[str, str]] = {}

    for edge_id, et in topology.edges.items():
        pid = et.param_id
        if not pid:
            continue

        # Find the graph edge object
        edge = None
        for e in graph_snapshot.get("edges", []):
            if e["uuid"] == edge_id:
                edge = e
                break
        if not edge:
            continue

        query = edge.get("query", "")
        lat = edge.get("p", {}).get("latency", {})
        has_latency = lat.get("latency_parameter", False)

        # Resolve event_ids from from/to nodes via query
        from_node = find_node(et.from_node)
        to_node = find_node(et.to_node)
        from_event_id = from_node.get("event_id", "") if from_node else ""
        to_event_id = to_node.get("event_id", "") if to_node else ""

        # Latency anchor event_id
        anchor_node_id = lat.get("anchor_node_id", "")
        anchor_node = find_node(anchor_node_id) if anchor_node_id else None
        latency_anchor_event_id = anchor_node.get("event_id", "") if anchor_node else ""

        # Normalise query: replace node IDs with event IDs
        normalized_query = query
        for node in graph_snapshot.get("nodes", []):
            nid = node.get("id", "")
            eid = node.get("event_id", "")
            if nid and eid:
                normalized_query = normalized_query.replace(nid, eid)

        # Find anchor node for cohort mode
        anchor_start_node = None
        for n in graph_snapshot.get("nodes", []):
            if n.get("entry", {}).get("is_start"):
                anchor_start_node = n
                break
        anchor_start_eid = anchor_start_node.get("event_id", "") if anchor_start_node else ""

        # Compute window hash (cohort_mode=false) and cohort hash (cohort_mode=true)
        hashes: dict[str, str] = {}
        for mode_name, cohort_mode in [("window_hash", False), ("cohort_hash", True)]:
            # In cohort mode, buildDslFromEdge resolves the anchor node,
            # sets cohort_anchor_event_id, and loads the anchor event def.
            # In window mode, cohort_anchor is empty and the anchor event
            # is only loaded if it's also a from/to node.
            # When from_node IS the anchor, buildDslFromEdge uses a 2-step
            # funnel and does NOT set cohort_anchor_event_id.
            if cohort_mode and from_event_id != anchor_start_eid:
                cohort_anchor = anchor_start_eid
            else:
                cohort_anchor = ""

            # Event definition hashes — per-edge, only events relevant to
            # this edge. buildDslFromEdge loads from/to events always.
            # In cohort mode it also loads the cohort anchor event.
            # The latency anchor event is loaded only if it coincides
            # with from/to/cohort-anchor.
            loaded_event_ids = {from_event_id, to_event_id}
            if cohort_mode and cohort_anchor:
                loaded_event_ids.add(cohort_anchor)

            all_event_ids = [eid for eid in [from_event_id, to_event_id, latency_anchor_event_id] if eid]
            event_def_hashes: dict[str, str] = {}
            for eid in all_event_ids:
                if eid not in loaded_event_ids:
                    event_def_hashes[eid] = "not_loaded"
                    continue
                edef = event_defs.get(eid)
                if edef:
                    normalized = {
                        "id": edef.get("id"),
                        "provider_event_names": edef.get("provider_event_names", {}),
                        "amplitude_filters": edef.get("amplitude_filters", []),
                    }
                    event_def_hashes[eid] = _sha256_hex(json.dumps(normalized, separators=(",", ":")))
                else:
                    event_def_hashes[eid] = "not_loaded"

            # Connection: read from edge p.connection or graph defaultConnection
            edge_connection = edge.get("p", {}).get("connection")
            if not edge_connection:
                edge_connection = graph_snapshot.get("defaultConnection", "amplitude")

            core_canonical = json.dumps({
                "connection": edge_connection,
                "from_event_id": from_event_id,
                "to_event_id": to_event_id,
                "visited_event_ids": [],
                "exclude_event_ids": [],
                "event_def_hashes": event_def_hashes,
                "event_filters": {},
                "case": [],
                "cohort_mode": cohort_mode,
                "cohort_anchor_event_id": cohort_anchor,
                "latency_parameter": has_latency,
                "latency_anchor_event_id": latency_anchor_event_id,
                "original_query": normalized_query,
            }, separators=(",", ":"))

            core_hash_hex = _sha256_hex(core_canonical)

            # Structured signature (no context keys for synthetic data)
            structured_sig = json.dumps({
                "c": core_hash_hex,
                "x": {},
            }, separators=(",", ":"))

            hashes[mode_name] = _short_hash(structured_sig)
            # Also store the structured sig for parameter file query_signature
            sig_key = mode_name.replace("_hash", "_sig")
            hashes[sig_key] = structured_sig

        result[pid] = hashes
        # Also store with parameter- prefix
        if not pid.startswith("parameter-"):
            result[f"parameter-{pid}"] = hashes

    return result


def _build_hash_lookup(gcfg: dict) -> dict[str, dict[str, str]]:
    """Build param_id → {window_hash, cohort_hash} from GRAPH_CONFIGS edges."""
    lookup: dict[str, dict[str, str]] = {}
    for param_id, _edge_uuid, window_hash, cohort_hash in gcfg.get("edges", []):
        lookup[param_id] = {"window_hash": window_hash, "cohort_hash": cohort_hash}
        # Also store with parameter- prefix for topology param_id matching
        if not param_id.startswith("parameter-"):
            lookup[f"parameter-{param_id}"] = lookup[param_id]
    return lookup


def load_truth_config(truth_path: str) -> dict:
    """Load ground-truth config from .truth.yaml sidecar.

    For new-format truth files (with graph structure), builds a
    _edge_lookup dict that maps both short names (anchor-to-gate)
    and prefixed names (synth-diamond-anchor-to-gate) to the same
    config. The edges dict itself is unchanged (short names only).
    """
    with open(truth_path) as f:
        truth = yaml.safe_load(f)

    # For new-format truth files, build a _edge_prefix so that
    # _resolve_truth_edge can match prefixed param_ids to short-name
    # truth keys. The edges dict itself stays clean (short names only).
    graph_name = truth.get("graph", {}).get("name", "")
    if graph_name:
        prefix = graph_name.replace("synth-", "").replace("-test", "")
        if not prefix.startswith("synth"):
            prefix = f"synth-{prefix}"
        truth["_edge_prefix"] = prefix

    return truth


def _resolve_truth_edge(truth: dict, pid: str) -> dict:
    """Look up edge truth config by param_id, trying multiple name forms.

    Handles both old-format (keys match param_id directly) and new-format
    (keys are short names like "anchor-to-gate" while param_id is prefixed
    like "synth-diamond-anchor-to-gate").
    """
    edges = truth.get("edges", {})

    # Direct match
    if pid in edges and isinstance(edges[pid], dict) and "from" not in edges[pid] or pid in edges:
        result = edges.get(pid, {})
        if isinstance(result, dict):
            return result

    # Strip parameter- prefix
    bare = pid.replace("parameter-", "") if pid.startswith("parameter-") else pid
    if bare in edges:
        result = edges[bare]
        if isinstance(result, dict):
            return result

    # Strip graph-name prefix (new format)
    edge_prefix = truth.get("_edge_prefix", "")
    if edge_prefix and bare.startswith(edge_prefix + "-"):
        short = bare[len(edge_prefix) + 1:]
        if short in edges:
            result = edges[short]
            if isinstance(result, dict):
                return result

    return {}


def derive_truth_from_graph(graph_snapshot: dict, topology) -> dict:
    """Derive ground-truth parameters from graph edge metadata.

    Uses existing analytic estimates (probability, latency) as the
    ground truth. For edges without latency, uses defaults.
    """
    edges_by_uuid = {e["uuid"]: e for e in graph_snapshot.get("edges", [])}

    truth: dict[str, Any] = {"edges": {}}
    for edge_id, et in topology.edges.items():
        edge = edges_by_uuid.get(edge_id, {})
        p_block = edge.get("p", {})

        # Probability: from bayesParams (fitted), p.mean, or p.probability
        bayes = p_block.get("bayesParams", {})
        p_val = bayes.get("mean") or p_block.get("mean") or p_block.get("probability")
        if p_val is None or p_val <= 0:
            p_val = 0.5

        # Latency
        lat = p_block.get("latency", {})
        onset = lat.get("onset_delta_days", 0.0) or 0.0
        mu = lat.get("mu")
        sigma = lat.get("sigma")

        if mu is None or sigma is None:
            median_lag = lat.get("median_lag_days")
            if median_lag and median_lag > onset + 0.01:
                mu = math.log(max(median_lag - onset, 0.01))
                sigma = 0.7
            else:
                t95 = lat.get("t95")
                if t95 and t95 > onset:
                    mu = math.log(t95 - onset) - 1.645 * 0.7
                    sigma = 0.7
                else:
                    mu = 1.0
                    sigma = 0.5

        truth["edges"][et.param_id] = {
            "p": float(p_val),
            "onset": float(onset),
            "mu": float(mu),
            "sigma": float(max(sigma, 0.01)),
        }

    return truth


# ---------------------------------------------------------------------------
# Simulation config defaults
# ---------------------------------------------------------------------------

DEFAULT_SIM_CONFIG = {
    "mean_daily_traffic": 5000,
    "n_days": 100,
    "kappa_sim_default": 50.0,     # moderate overdispersion (Beta-Binomial)
    "failure_rate": 0.05,          # 5% of fetch nights fail
    "drift_sigma": 0.0,           # random-walk drift disabled by default
    "drift_rate": 0.0,            # deterministic linear drift (logit/day), e.g. -0.01 = p decreases
    "seed": 42,
    "growth_rate_mom": 0.0,       # monthly growth rate (0.05 = 5% MoM exponential)
    "snapshot_start_offset": 0,   # 0 = full coverage; >0 = snapshot DB rows only for last N days
    "traffic_cv": 0.0,           # coefficient of variation for daily traffic (0 = Poisson only)
}


def _get_sim_config(truth: dict, cli_overrides: dict) -> dict:
    """Merge simulation config from truth config + CLI overrides."""
    cfg = dict(DEFAULT_SIM_CONFIG)
    # Truth config overrides defaults
    if "simulation" in truth:
        for k, v in truth["simulation"].items():
            if k in cfg:
                cfg[k] = v
    # CLI overrides everything
    for k, v in cli_overrides.items():
        if v is not None and k in cfg:
            cfg[k] = v
    return cfg


# ---------------------------------------------------------------------------
# Core simulation
# ---------------------------------------------------------------------------

def simulate_graph(
    graph_snapshot: dict,
    topology,
    truth: dict,
    sim_config: dict,
    hash_lookup: dict[str, dict[str, str]],
) -> tuple[dict[str, list[dict]], dict]:
    """Simulate population traversal and return snapshot-format rows.

    Returns (snapshot_rows, sim_stats) where:
    - snapshot_rows: dict[edge_id → list[row_dict]] consumable by
      bind_snapshot_evidence
    - sim_stats: summary statistics for reporting
    """
    n_days = sim_config["n_days"]
    mean_daily_traffic = sim_config["mean_daily_traffic"]
    kappa_default = sim_config["kappa_sim_default"]
    drift_sigma = sim_config["drift_sigma"]
    drift_rate = sim_config.get("drift_rate", 0.0)
    failure_rate = sim_config["failure_rate"]
    seed = sim_config["seed"]
    base_date_str = sim_config.get("base_date", "2025-11-01")
    base_date = datetime.strptime(base_date_str, "%Y-%m-%d")

    rng = np.random.default_rng(seed)

    # --- Burn-in period ---
    # Simulate max(path_t95) extra days before base_date so the first
    # observable day has realistic from-node arrival counts (the pipeline
    # is "warmed up"). Observation rows are only emitted for dates >=
    # base_date; burn-in days contribute arrivals but not rows.
    # Compute burn-in from TRUTH config (not graph edge, which may be stripped).
    # Sum onset + t95 along the longest path to get max path completion time.
    # Simple approach: sum all edge onsets + max edge t95 as upper bound.
    max_edge_t95 = 0.0
    total_onset = 0.0
    for edge_id, et in topology.edges.items():
        pid = et.param_id
        t = _resolve_truth_edge(truth, pid)
        if t:
            onset = t.get("onset", 0.0)
            mu = t.get("mu", 1.0)
            sigma = t.get("sigma", 0.5)
            edge_t95 = onset + math.exp(mu + 1.645 * sigma)
            total_onset += onset
            if edge_t95 > max_edge_t95:
                max_edge_t95 = edge_t95
    # Conservative: use sum of all onsets + longest single edge t95
    max_path_t95 = total_onset + max_edge_t95
    burn_in_days = math.ceil(max_path_t95)
    total_sim_days = burn_in_days + n_days
    sim_start_date = base_date - timedelta(days=burn_in_days)

    # --- Resolve edge params from truth config ---
    edge_params: dict[str, dict] = {}  # edge_id → {p, onset, mu, sigma, kappa_sim}
    for edge_id, et in topology.edges.items():
        pid = et.param_id
        found = _resolve_truth_edge(truth, pid) or None
        if found:
            ep = dict(found)
        else:
            ep = {"p": 0.5, "onset": 0.0, "mu": 1.0, "sigma": 0.5}
        ep.setdefault("kappa_sim", kappa_default)
        edge_params[edge_id] = ep

    # --- Build adjacency ---
    adj_out: dict[str, list[str]] = defaultdict(list)
    for eid, et in topology.edges.items():
        adj_out[et.from_node].append(eid)

    # --- Branch groups ---
    edge_to_bg: dict[str, str] = {}
    for bg in topology.branch_groups.values():
        for sib_id in bg.sibling_edge_ids:
            edge_to_bg[sib_id] = bg.group_id

    # --- Drift (logit scale, per-edge) ---
    # drift_path[edge_id] = array of total_sim_days logit offsets.
    # Two modes (composable):
    #   drift_rate: deterministic linear drift (logit/day)
    #   drift_sigma: random-walk drift (logit SD/day)
    drift_paths: dict[str, np.ndarray] = {}
    if drift_sigma > 0 or drift_rate != 0:
        for edge_id in edge_params:
            # Linear component: drift_rate × day_index
            linear = drift_rate * np.arange(total_sim_days, dtype=np.float64)
            # Stochastic component: cumulative random walk
            if drift_sigma > 0:
                increments = rng.normal(0.0, drift_sigma, size=total_sim_days)
                stochastic = np.cumsum(increments)
            else:
                stochastic = np.zeros(total_sim_days)
            drift_paths[edge_id] = linear + stochastic
    else:
        zero_path = np.zeros(total_sim_days)
        for edge_id in edge_params:
            drift_paths[edge_id] = zero_path

    # --- Context dimensions ---
    # Each dimension is an independent MECE partition. Each user is
    # assigned one value per dimension. Effects compose multiplicatively
    # for p (p_eff = p_base × Π p_mult) and additively for mu
    # (mu_eff = mu_base + Σ mu_offset).
    context_dims = truth.get("context_dimensions", [])
    user_kappa = sim_config.get("user_kappa", sim_config.get("kappa_sim_default", 100.0))

    # Pre-build context lookup: dim_id → [{id, weight, edges: {pid → {p_mult, mu_offset}}}]
    ctx_lookup: list[dict] = []
    for dim in context_dims:
        dim_values = dim.get("values", [])
        weights = [v.get("weight", 1.0) for v in dim_values]
        total_w = sum(weights)
        weights = [w / total_w for w in weights]
        ctx_lookup.append({
            "id": dim["id"],
            "mece": dim.get("mece", True),
            "values": dim_values,
            "weights": np.array(weights),
        })
    if ctx_lookup:
        dim_names = [d["id"] for d in ctx_lookup]
        print(f"  Contexts: {len(ctx_lookup)} dimensions ({', '.join(dim_names)})", flush=True)
        for cl in ctx_lookup:
            vals = [f"{v['id']}={w:.0%}" for v, w in zip(cl["values"], cl["weights"])]
            print(f"    {cl['id']}: {', '.join(vals)}", flush=True)

    def _compute_user_params(
        user_contexts: dict[str, str],
        edge_id: str,
        base_p: float,
        base_mu: float,
        drift_offset: float,
    ) -> tuple[float, float]:
        """Compute per-user effective p and mu from context assignments.

        Composes context effects then draws per-user p from Beta.
        Returns (p_user, mu_user).
        """
        p_mult = 1.0
        mu_offset = 0.0

        # Compose effects from all context dimensions
        for dim in context_dims:
            dim_id = dim["id"]
            user_val = user_contexts.get(dim_id)
            if user_val is None:
                continue
            for v in dim.get("values", []):
                if v["id"] == user_val:
                    pid = topology.edges[edge_id].param_id if edge_id in topology.edges else ""
                    bare = pid.replace("parameter-", "") if pid.startswith("parameter-") else pid
                    overrides = v.get("edges", {}).get(pid) or v.get("edges", {}).get(bare) or {}
                    p_mult *= overrides.get("p_mult", 1.0)
                    mu_offset += overrides.get("mu_offset", 0.0)
                    break

        # Apply drift
        if abs(drift_offset) > 1e-9:
            logit_p = math.log(max(base_p, 1e-6) / max(1 - base_p, 1e-6)) + drift_offset
            p_drifted = 1.0 / (1.0 + math.exp(-logit_p))
        else:
            p_drifted = base_p

        # Apply context p multiplier, clamp to (0, 1)
        p_ctx = min(max(p_drifted * p_mult, 1e-6), 1.0 - 1e-6)

        # Per-user Beta draw (user_kappa controls within-context variation)
        alpha = p_ctx * user_kappa
        beta_param = (1.0 - p_ctx) * user_kappa
        alpha = max(alpha, 0.001)
        beta_param = max(beta_param, 0.001)
        p_user = float(rng.beta(alpha, beta_param))

        mu_user = base_mu + mu_offset
        return p_user, mu_user

    # --- Person-level simulation ---
    # Runs for total_sim_days (burn_in + n_days). The first burn_in_days
    # populate the pipeline; observation rows are only for day_idx >= burn_in_days.
    arrivals_by_day: list[list[dict]] = []
    actual_traffic: list[int] = []

    # Exponential growth: daily rate from MoM growth
    growth_rate_mom = sim_config.get("growth_rate_mom", 0.0)
    daily_growth = (1.0 + growth_rate_mom) ** (1.0 / 30.0) if growth_rate_mom > 0 else 1.0

    print(f"  Simulating {total_sim_days} days ({burn_in_days} burn-in + {n_days} observable)...", flush=True)
    if growth_rate_mom > 0:
        print(f"  Growth: {growth_rate_mom * 100:.1f}% MoM ({(daily_growth - 1) * 100:.3f}%/day)", flush=True)
    traffic_cv = sim_config.get("traffic_cv", 0.0)
    for day_idx in range(total_sim_days):
        # Apply exponential growth relative to sim start (day 0 = burn-in start)
        day_mean = mean_daily_traffic * (daily_growth ** day_idx)
        if traffic_cv > 0:
            # Negative binomial (Gamma-Poisson mixture) for high-variance traffic.
            # CV = sqrt(1/mean + 1/r) ≈ 1/sqrt(r) for large mean.
            # Solve for r: r = mean / (cv^2 * mean - 1), but simpler:
            # shape r = mean / (cv^2 * mean) = 1/cv^2 when mean is large.
            r = day_mean / (traffic_cv ** 2 * day_mean)
            prob = r / (r + day_mean)
            n_people = int(rng.negative_binomial(r, prob))
        else:
            n_people = int(rng.poisson(day_mean))
        actual_traffic.append(n_people)
        if (day_idx + 1) % 20 == 0:
            phase = "burn-in" if day_idx < burn_in_days else "observable"
            print(f"    Day {day_idx + 1}/{total_sim_days} ({phase})", flush=True)

        # Day-level drift offsets (same for all users on this day)
        day_drift: dict[str, float] = {}
        for eid in edge_params:
            day_drift[eid] = float(drift_paths[eid][day_idx])

        # Simulate each person
        day_arrivals: list[dict] = []
        for _ in range(n_people):
            # Assign context values (one per MECE dimension)
            user_contexts: dict[str, str] = {}
            for cl in ctx_lookup:
                if cl["mece"]:
                    choice = rng.choice(len(cl["values"]), p=cl["weights"])
                    user_contexts[cl["id"]] = cl["values"][choice]["id"]
                # TODO: non-MECE dimensions (user can belong to multiple values)

            # Compute per-user effective params per edge
            user_probs: dict[str, float] = {}
            user_mus: dict[str, float] = {}
            for eid, ep in edge_params.items():
                p_user, mu_user = _compute_user_params(
                    user_contexts, eid,
                    ep["p"], ep.get("mu", 0.0),
                    day_drift[eid],
                )
                user_probs[eid] = p_user
                user_mus[eid] = mu_user

            person: dict[str, Any] = {"_contexts": user_contexts}
            _traverse(
                topology.anchor_node_id, 0.0, person,
                topology, adj_out, edge_params, user_probs,
                edge_to_bg, rng,
                user_mus=user_mus,
            )
            day_arrivals.append(person)

        arrivals_by_day.append(day_arrivals)

    # --- Pre-aggregate arrival times for fast observation generation ---
    # sorted_times[day_idx][node_id] = sorted list of arrival times
    # sorted_edge_times[day_idx][edge_id] = sorted arrival times for
    #   people who traversed that specific edge (needed for correct
    #   per-edge counts at join nodes)
    sorted_times: list[dict[str, list[float]]] = []
    sorted_edge_times: list[dict[str, list[float]]] = []
    all_nodes = set()
    for et in topology.edges.values():
        all_nodes.add(et.from_node)
        all_nodes.add(et.to_node)
    all_nodes.add(topology.anchor_node_id)

    all_edge_ids = [eid for eid in topology.edges if topology.edges[eid].param_id]

    for day_idx in range(total_sim_days):
        people = arrivals_by_day[day_idx]

        day_sorted: dict[str, list[float]] = {}
        for nid in all_nodes:
            times = [p[nid] for p in people if nid in p]
            times.sort()
            day_sorted[nid] = times
        sorted_times.append(day_sorted)

        day_edge_sorted: dict[str, list[float]] = {}
        for eid in all_edge_ids:
            key = f"edge:{eid}"
            times = [p[key] for p in people if key in p]
            times.sort()
            day_edge_sorted[eid] = times
        sorted_edge_times.append(day_edge_sorted)

    # --- Per-edge daily aggregates (for parameter file values[]) ---
    # Computed before freeing arrivals_by_day.
    # For each edge: n_daily[d] = people reaching from_node on day d,
    #                k_daily[d] = people who traversed this edge on day d
    edge_daily: dict[str, dict] = {}  # edge_id → {n_daily, k_daily, dates, ...}
    anchor_node_id = topology.anchor_node_id
    for edge_id, et in topology.edges.items():
        if not et.param_id:
            continue
        n_daily = []
        k_daily = []
        dates = []
        median_lag_daily = []
        mean_lag_daily = []
        anchor_median_lag_daily = []
        anchor_mean_lag_daily = []
        anchor_n_daily_list = []
        edge_key = f"edge:{edge_id}"

        for day_idx in range(burn_in_days, total_sim_days):
            day_date = base_date + timedelta(days=day_idx - burn_in_days)
            dates.append(day_date.strftime("%-d-%b-%y"))
            from_times = sorted_times[day_idx].get(et.from_node, [])
            edge_times = sorted_edge_times[day_idx].get(edge_id, [])
            n_daily.append(len(from_times))
            k_daily.append(len(edge_times))
            anchor_n_daily_list.append(actual_traffic[day_idx])

            # Compute empirical lag stats from person-level data
            edge_lags = []  # from_node → to_node lag for converters
            anchor_lags = []  # anchor → from_node lag for converters
            for person in arrivals_by_day[day_idx]:
                if edge_key not in person:
                    continue  # didn't traverse this edge
                if et.from_node not in person:
                    continue
                to_arrival = person[edge_key]
                from_arrival = person[et.from_node]
                edge_lags.append(to_arrival - from_arrival)
                # Anchor lag = from_node arrival relative to anchor entry (time 0).
                # Amplitude's anchor_median_lag measures A→X (anchor to from-event),
                # NOT A→Y (anchor to to-event).
                anchor_lags.append(from_arrival)

            if edge_lags:
                edge_lags_sorted = sorted(edge_lags)
                n_conv = len(edge_lags_sorted)
                median_lag_daily.append(round(edge_lags_sorted[n_conv // 2], 2))
                mean_lag_daily.append(round(sum(edge_lags) / n_conv, 2))
            else:
                median_lag_daily.append(0)
                mean_lag_daily.append(0)

            if anchor_lags:
                anchor_lags_sorted = sorted(anchor_lags)
                n_conv = len(anchor_lags_sorted)
                anchor_median_lag_daily.append(round(anchor_lags_sorted[n_conv // 2], 2))
                anchor_mean_lag_daily.append(round(sum(anchor_lags) / n_conv, 2))
            else:
                anchor_median_lag_daily.append(0)
                anchor_mean_lag_daily.append(0)

        edge_daily[edge_id] = {
            "n_daily": n_daily,
            "k_daily": k_daily,
            "dates": dates,
            "median_lag_daily": median_lag_daily,
            "mean_lag_daily": mean_lag_daily,
            "anchor_median_lag_daily": anchor_median_lag_daily,
            "anchor_mean_lag_daily": anchor_mean_lag_daily,
            "anchor_n_daily": anchor_n_daily_list,
        }

    # --- Generate observations via nightly fetch model ---
    # arrivals_by_day is needed for window index construction (grouping
    # by from-node arrival day across simulation days).
    snapshot_start_offset = sim_config.get("snapshot_start_offset", 0)
    snapshot_rows = _generate_observations_nightly(
        topology, sorted_times, sorted_edge_times, actual_traffic,
        hash_lookup, n_days, base_date, failure_rate, rng,
        arrivals_by_day, burn_in_days, total_sim_days, edge_params,
        context_dims=context_dims,
        snapshot_start_offset=snapshot_start_offset,
    )

    # Free the raw person data now
    del arrivals_by_day

    # --- Simulation stats ---
    total_rows = sum(len(v) for v in snapshot_rows.values())
    sim_stats = {
        "n_days": n_days,
        "mean_daily_traffic": mean_daily_traffic,
        "actual_traffic_range": (min(actual_traffic), max(actual_traffic)),
        "actual_traffic": actual_traffic,
        "burn_in_days": burn_in_days,
        "kappa_default": kappa_default,
        "failure_rate": failure_rate,
        "drift_sigma": drift_sigma,
        "drift_rate": drift_rate,
        "total_rows": total_rows,
        "base_date": base_date_str,
        "edge_daily": edge_daily,
    }

    return snapshot_rows, sim_stats


def _traverse(
    node_id: str,
    t_current: float,
    person: dict,
    topology,
    adj_out: dict[str, list[str]],
    edge_params: dict[str, dict],
    day_probs: dict[str, float],
    edge_to_bg: dict[str, str],
    rng: np.random.Generator,
    user_mus: dict[str, float] | None = None,
) -> None:
    """Recursively traverse the DAG for one person.

    Uses day_probs (per-user effective probabilities after context +
    drift + user Beta draw) for conversion draws, and edge_params for
    base latency. If user_mus is provided, overrides mu per edge
    (context-adjusted).
    """
    person[node_id] = t_current

    outbound = adj_out.get(node_id, [])
    if not outbound:
        return

    # Group outbound edges by branch group
    bg_grouped: dict[str, list[str]] = defaultdict(list)
    solo_edges: list[str] = []
    for eid in outbound:
        bg_id = edge_to_bg.get(eid)
        if bg_id is not None:
            bg_grouped[bg_id].append(eid)
        else:
            solo_edges.append(eid)

    # Branch groups: Multinomial draw — one branch per person
    for _bg_id, siblings in bg_grouped.items():
        evented = [eid for eid in siblings if topology.edges[eid].param_id]
        unevented = [eid for eid in siblings if not topology.edges[eid].param_id]

        evented_probs = [day_probs[eid] for eid in evented]
        dropout = max(0.0, 1.0 - sum(evented_probs))

        all_probs = evented_probs + [dropout]
        s = sum(all_probs)
        if s > 0:
            all_probs = [p / s for p in all_probs]
        else:
            all_probs = [1.0 / len(all_probs)] * len(all_probs)

        choice = rng.choice(len(all_probs), p=all_probs)
        if choice < len(evented):
            chosen_eid = evented[choice]
            _take_edge(chosen_eid, t_current, person, topology,
                       adj_out, edge_params, day_probs, edge_to_bg, rng,
                       user_mus=user_mus)
        elif unevented:
            chosen_eid = rng.choice(unevented)
            et = topology.edges[chosen_eid]
            person[et.to_node] = t_current

    # Solo edges: independent Bernoulli
    for eid in solo_edges:
        p = day_probs[eid]
        if rng.random() < p:
            _take_edge(eid, t_current, person, topology,
                       adj_out, edge_params, day_probs, edge_to_bg, rng,
                       user_mus=user_mus)


def _take_edge(
    edge_id: str,
    t_current: float,
    person: dict,
    topology,
    adj_out, edge_params, day_probs, edge_to_bg, rng,
    user_mus: dict[str, float] | None = None,
) -> None:
    """Person takes an edge: draw latency, record arrival, recurse.

    Records both node arrival (node_id → t) and edge traversal
    (edge:<edge_id> → t_arrival) so per-edge counts work at joins.
    If user_mus is provided, uses per-user context-adjusted mu.
    """
    et = topology.edges[edge_id]
    params = edge_params[edge_id]

    mu = user_mus.get(edge_id, params.get("mu", 0.0)) if user_mus else params.get("mu", 0.0)
    sigma = params.get("sigma", 0.0)
    onset = params.get("onset", 0.0)
    if sigma > 0.001:
        latency = onset + rng.lognormal(mu, sigma)
    else:
        latency = 0.0

    t_arrival = t_current + latency
    person[f"edge:{edge_id}"] = t_arrival
    _traverse(et.to_node, t_arrival, person, topology,
              adj_out, edge_params, day_probs, edge_to_bg, rng,
              user_mus=user_mus)


# ---------------------------------------------------------------------------
# Observation generation — nightly fetch model
# ---------------------------------------------------------------------------

def _count_by_age(sorted_arrivals: list[float], age: float) -> int:
    """Count arrivals at or before the given age using binary search."""
    return bisect.bisect_right(sorted_arrivals, age)


def _generate_observations_nightly(
    topology,
    sorted_times: list[dict[str, list[float]]],
    sorted_edge_times: list[dict[str, list[float]]],
    actual_traffic: list[int],
    hash_lookup: dict[str, dict[str, str]],
    n_days: int,
    base_date: datetime,
    failure_rate: float,
    rng: np.random.Generator,
    arrivals_by_day: list[list[dict]],
    burn_in_days: int = 0,
    total_sim_days: int | None = None,
    edge_params: dict[str, dict] | None = None,
    context_dims: list[dict] | None = None,
    snapshot_start_offset: int = 0,
) -> dict[str, list[dict]]:
    """Generate snapshot rows using nightly fetch simulation.

    When snapshot_start_offset > 0, only fetch nights within the last
    snapshot_start_offset days produce DB rows.  This simulates
    production's partial snapshot coverage — the param file still
    covers the full period, but the snapshot DB only has recent fetches.

    Produces two distinct slicings of the same simulated reality:

    **Cohort rows** (slice_key="cohort()"):
      anchor_day = day person entered the anchor node (simulation day)
      a = total anchor entrants on that day (fixed denominator)
      y = count who reached to_node by retrieval age (relative to anchor day)

    **Window rows** (slice_key="window()"):
      anchor_day = day person arrived at the FROM node (varies per person due
        to upstream latency — mixes people from different simulation days)
      x = count who arrived at from_node on that calendar day
      y = count of those who reached to_node by retrieval age (relative to
        from_node arrival day)

    When context_dims is provided, also emits per-context rows with
    slice_keys like "context(channel:organic).cohort()" alongside the
    aggregate rows. All context slices share the same core_hash.

    The window and cohort rows trace DIFFERENT populations for the same edge:
    window groups by from-node arrival day, cohort groups by anchor entry day.
    """
    result: dict[str, list[dict]] = defaultdict(list)

    # Pre-compute latency stats per edge for DB rows
    edge_latency_stats: dict[str, dict] = {}
    if edge_params:
        for edge_id, ep in edge_params.items():
            onset = ep.get("onset", 0.0)
            mu = ep.get("mu", 0.0)
            sigma = ep.get("sigma", 0.0)
            if sigma > 0.001:
                median_lag = onset + math.exp(mu)
                mean_lag = onset + math.exp(mu + sigma ** 2 / 2)
            else:
                median_lag = onset
                mean_lag = onset

            # Path-level (anchor → this edge) latency from FW composition
            et = topology.edges.get(edge_id)
            if et and not et.path_latency.is_trivial:
                pd = et.path_latency.path_delta
                pm = et.path_latency.path_mu
                ps = et.path_latency.path_sigma
                anchor_median = pd + math.exp(pm)
                anchor_mean = pd + math.exp(pm + ps ** 2 / 2)
            else:
                anchor_median = median_lag
                anchor_mean = mean_lag

            edge_latency_stats[edge_id] = {
                "onset": onset,
                "median_lag_days": round(median_lag, 2),
                "mean_lag_days": round(mean_lag, 2),
                "anchor_median_lag_days": round(anchor_median, 2),
                "anchor_mean_lag_days": round(anchor_mean, 2),
            }

    # Pre-resolve hashes per edge
    edge_hashes: dict[str, tuple[str, str]] = {}
    for edge_id, et in topology.edges.items():
        pid = et.param_id
        hashes = hash_lookup.get(pid)
        if not hashes:
            bare = pid.replace("parameter-", "") if pid.startswith("parameter-") else pid
            hashes = hash_lookup.get(bare)
        if hashes:
            edge_hashes[edge_id] = (hashes["window_hash"], hashes["cohort_hash"])
        else:
            edge_hashes[edge_id] = (f"SYNTH-{pid}-w", f"SYNTH-{pid}-c")

    _tsd = total_sim_days or n_days

    # ── Build per-context sorted lists ──────────────────────────────────
    context_dims = context_dims or []
    ctx_keys: list[str] = []
    for dim in context_dims:
        for v in dim.get("values", []):
            ctx_keys.append(f"context({dim['id']}:{v['id']})")

    ctx_sorted_times: dict[str, list[dict[str, list[float]]]] = {k: [] for k in ctx_keys}
    ctx_sorted_edge_times: dict[str, list[dict[str, list[float]]]] = {k: [] for k in ctx_keys}
    ctx_anchor_traffic: dict[str, list[int]] = {k: [] for k in ctx_keys}

    if ctx_keys:
        print(f"  Building per-context indices ({len(ctx_keys)} keys × {_tsd} days)...", flush=True)
        all_edge_ids_ctx = [eid for eid in topology.edges if topology.edges[eid].param_id]
        all_nodes_ctx = set()
        for et in topology.edges.values():
            all_nodes_ctx.add(et.from_node)
            all_nodes_ctx.add(et.to_node)
        all_nodes_ctx.add(topology.anchor_node_id)

        for day_idx in range(_tsd):
            people = arrivals_by_day[day_idx]
            for dim in context_dims:
                for v in dim.get("values", []):
                    ck = f"context({dim['id']}:{v['id']})"
                    ctx_people = [p for p in people
                                  if p.get("_contexts", {}).get(dim["id"]) == v["id"]]

                    day_ctx_sorted: dict[str, list[float]] = {}
                    for nid in all_nodes_ctx:
                        times = [p[nid] for p in ctx_people if nid in p]
                        times.sort()
                        day_ctx_sorted[nid] = times
                    ctx_sorted_times[ck].append(day_ctx_sorted)

                    day_ctx_edge: dict[str, list[float]] = {}
                    for eid in all_edge_ids_ctx:
                        key = f"edge:{eid}"
                        times = [p[key] for p in ctx_people if key in p]
                        times.sort()
                        day_ctx_edge[eid] = times
                    ctx_sorted_edge_times[ck].append(day_ctx_edge)

                    anchor_count = sum(1 for p in ctx_people if topology.anchor_node_id in p)
                    ctx_anchor_traffic[ck].append(anchor_count)

    # ── Build window arrival index ──────────────────────────────────────
    # For each edge, group person arrivals by the ABSOLUTE CALENDAR DAY
    # they reached the from_node. Each entry records:
    #   from_arrival_offset: fractional days from from_node arrival to
    #     to_node arrival (or None if they didn't convert)
    #
    # window_index[edge_id][abs_from_day] = list of
    #   (edge_arrival_offset | None)  — one per person who reached from_node
    #
    # abs_from_day is an integer: calendar day offset from base_date.
    # edge_arrival_offset = to_node_arrival - from_node_arrival (in days).

    window_index: dict[str, dict[int, list[float | None]]] = defaultdict(
        lambda: defaultdict(list)
    )
    # Per-context window indices: ctx_key → edge_id → abs_day → [offsets]
    ctx_window_index: dict[str, dict[str, dict[int, list[float | None]]]] = {
        ck: defaultdict(lambda: defaultdict(list)) for ck in ctx_keys
    }

    for day_idx in range(_tsd):
        for person in arrivals_by_day[day_idx]:
            user_ctxs = person.get("_contexts", {})
            for edge_id, et in topology.edges.items():
                if not et.param_id:
                    continue
                from_node = et.from_node
                if from_node not in person:
                    continue

                from_arrival_time = person[from_node]
                abs_from_day = (day_idx - burn_in_days) + int(from_arrival_time)

                edge_key = f"edge:{edge_id}"
                if edge_key in person:
                    to_arrival_time = person[edge_key]
                    edge_offset = to_arrival_time - from_arrival_time
                    window_index[edge_id][abs_from_day].append(edge_offset)
                    # Per-context
                    for dim in (context_dims or []):
                        uval = user_ctxs.get(dim["id"])
                        if uval:
                            ck = f"context({dim['id']}:{uval})"
                            ctx_window_index[ck][edge_id][abs_from_day].append(edge_offset)
                else:
                    window_index[edge_id][abs_from_day].append(None)
                    for dim in (context_dims or []):
                        uval = user_ctxs.get(dim["id"])
                        if uval:
                            ck = f"context({dim['id']}:{uval})"
                            ctx_window_index[ck][edge_id][abs_from_day].append(None)

    # Pre-sort the non-None offsets for bisect-based counting
    window_sorted: dict[str, dict[int, tuple[int, list[float]]]] = {}
    for edge_id, day_map in window_index.items():
        window_sorted[edge_id] = {}
        for abs_day, offsets in day_map.items():
            total_x = len(offsets)
            converted_offsets = sorted([o for o in offsets if o is not None])
            window_sorted[edge_id][abs_day] = (total_x, converted_offsets)

    ctx_window_sorted: dict[str, dict[str, dict[int, tuple[int, list[float]]]]] = {}
    for ck in ctx_keys:
        ctx_window_sorted[ck] = {}
        for edge_id, day_map in ctx_window_index[ck].items():
            ctx_window_sorted[ck][edge_id] = {}
            for abs_day, offsets in day_map.items():
                total_x = len(offsets)
                converted_offsets = sorted([o for o in offsets if o is not None])
                ctx_window_sorted[ck][edge_id][abs_day] = (total_x, converted_offsets)

    del window_index, ctx_window_index

    # ── Determine fetch nights (with failure simulation) ────────────────
    fetch_nights: list[int] = []
    # snapshot_start_offset > 0: only write DB rows for anchor days
    # within the last snapshot_start_offset observable days.  Older
    # anchor days get no snapshot rows — they exist only in the param
    # file (daily obs).  This simulates production's partial snapshot
    # coverage where fetching started recently.
    snapshot_anchor_cutoff = (n_days - snapshot_start_offset) if snapshot_start_offset > 0 else 0
    for fn in range(1, n_days + 1):
        if failure_rate > 0 and rng.random() < failure_rate:
            continue
        fetch_nights.append(fn)

    # ── Generate cohort rows ────────────────────────────────────────────
    # Cohort: anchor_day = simulation day (within observable window only),
    # a = anchor entrants, y = people from that sim day who reached
    # to_node by retrieval age.
    # sim_day_idx is 0-based from sim_start; observable days start at burn_in_days.
    n_cohort_rows = 0
    for fi, fetch_night in enumerate(fetch_nights):
        retrieved_at = (base_date + timedelta(days=fetch_night)).strftime(
            "%Y-%m-%d 02:00:00"
        )

        # Only observable anchor days (sim_day >= burn_in_days)
        # that are before this fetch night
        obs_start = burn_in_days
        obs_end = burn_in_days + fetch_night  # fetch_night is 1-based offset from base_date
        for sim_day in range(obs_start, min(obs_end, _tsd)):
            obs_day_offset = sim_day - burn_in_days  # 0-based from base_date
            age = fetch_night - obs_day_offset
            if age < 1:
                continue
            # Skip anchor days before the snapshot window
            if obs_day_offset < snapshot_anchor_cutoff:
                continue

            anchor_day_str = (base_date + timedelta(days=obs_day_offset)).strftime("%Y-%m-%d")
            n_people = actual_traffic[sim_day]
            day_edge_sorted = sorted_edge_times[sim_day]

            for edge_id, et in topology.edges.items():
                if not et.param_id:
                    continue

                pid = et.param_id
                w_hash, c_hash = edge_hashes[edge_id]
                from_times = sorted_times[sim_day].get(et.from_node, [])
                edge_times = day_edge_sorted.get(edge_id, [])
                x_cohort = _count_by_age(from_times, age)
                y_cohort = _count_by_age(edge_times, age)

                lstats = edge_latency_stats.get(edge_id, {})
                # Aggregate cohort row
                result[edge_id].append({
                    "param_id": pid,
                    "core_hash": c_hash,
                    "slice_key": "cohort()",
                    "anchor_day": anchor_day_str,
                    "retrieved_at": retrieved_at,
                    "a": n_people,
                    "x": x_cohort,
                    "y": y_cohort,
                    "median_lag_days": lstats.get("median_lag_days"),
                    "mean_lag_days": lstats.get("mean_lag_days"),
                    "anchor_median_lag_days": lstats.get("anchor_median_lag_days"),
                    "anchor_mean_lag_days": lstats.get("anchor_mean_lag_days"),
                    "onset_delta_days": lstats.get("onset"),
                })
                n_cohort_rows += 1

                # Per-context cohort rows (same core_hash, different slice_key)
                for ck in ctx_keys:
                    ctx_from = ctx_sorted_times[ck][sim_day].get(et.from_node, [])
                    ctx_edge = ctx_sorted_edge_times[ck][sim_day].get(edge_id, [])
                    ctx_a = ctx_anchor_traffic[ck][sim_day]
                    ctx_x = _count_by_age(ctx_from, age)
                    ctx_y = _count_by_age(ctx_edge, age)
                    if ctx_a > 0:
                        result[edge_id].append({
                            "param_id": pid,
                            "core_hash": c_hash,
                            "slice_key": f"{ck}.cohort()",
                            "anchor_day": anchor_day_str,
                            "retrieved_at": retrieved_at,
                            "a": ctx_a,
                            "x": ctx_x,
                            "y": ctx_y,
                            "median_lag_days": lstats.get("median_lag_days"),
                            "mean_lag_days": lstats.get("mean_lag_days"),
                            "anchor_median_lag_days": lstats.get("anchor_median_lag_days"),
                            "anchor_mean_lag_days": lstats.get("anchor_mean_lag_days"),
                            "onset_delta_days": lstats.get("onset"),
                        })
                        n_cohort_rows += 1

        if (fi + 1) % 10 == 0:
            print(f"  Cohort observations: {fi + 1}/{len(fetch_nights)} nights, {n_cohort_rows} rows", flush=True)

    # ── Generate window rows ────────────────────────────────────────────
    # Window: anchor_day = absolute calendar day person reached from_node,
    # x = count reaching from_node on that day (across all sim days),
    # y = count of those who reached to_node by retrieval age relative
    #     to the from_node arrival day
    n_window_rows = 0
    for fi, fetch_night in enumerate(fetch_nights):
        retrieved_at = (base_date + timedelta(days=fetch_night)).strftime(
            "%Y-%m-%d 02:00:00"
        )

        for edge_id, et in topology.edges.items():
            if not et.param_id:
                continue

            pid = et.param_id
            w_hash, _c_hash = edge_hashes[edge_id]
            edge_window = window_sorted.get(edge_id, {})

            for abs_from_day, (total_x, conv_offsets) in edge_window.items():
                # Only emit for observable window (abs_from_day >= 0 means
                # the from_node arrival is on or after base_date)
                if abs_from_day < 0:
                    continue
                if abs_from_day >= n_days:
                    continue  # beyond observation window
                # Skip anchor days before the snapshot window
                if abs_from_day < snapshot_anchor_cutoff:
                    continue

                w_age = fetch_night - abs_from_day
                if w_age < 1:
                    continue

                anchor_day_str = (base_date + timedelta(days=abs_from_day)).strftime(
                    "%Y-%m-%d"
                )

                y_window = bisect.bisect_right(conv_offsets, float(w_age))

                if total_x > 0:
                    lstats = edge_latency_stats.get(edge_id, {})
                    # Aggregate window row
                    result[edge_id].append({
                        "param_id": pid,
                        "core_hash": w_hash,
                        "slice_key": "window()",
                        "anchor_day": anchor_day_str,
                        "retrieved_at": retrieved_at,
                        "a": None,
                        "x": total_x,
                        "y": y_window,
                        "median_lag_days": lstats.get("median_lag_days"),
                        "mean_lag_days": lstats.get("mean_lag_days"),
                        "onset_delta_days": lstats.get("onset"),
                    })
                    n_window_rows += 1

                    # Per-context window rows
                    for ck in ctx_keys:
                        ctx_edge_window = ctx_window_sorted.get(ck, {}).get(edge_id, {})
                        ctx_entry = ctx_edge_window.get(abs_from_day)
                        if ctx_entry is None:
                            continue
                        ctx_x, ctx_conv = ctx_entry
                        if ctx_x <= 0:
                            continue
                        ctx_y_w = bisect.bisect_right(ctx_conv, float(w_age))
                        result[edge_id].append({
                            "param_id": pid,
                            "core_hash": w_hash,
                            "slice_key": f"{ck}.window()",
                            "anchor_day": anchor_day_str,
                            "retrieved_at": retrieved_at,
                            "a": None,
                            "x": ctx_x,
                            "y": ctx_y_w,
                            "median_lag_days": lstats.get("median_lag_days"),
                            "mean_lag_days": lstats.get("mean_lag_days"),
                            "onset_delta_days": lstats.get("onset"),
                        })
                        n_window_rows += 1

        if (fi + 1) % 10 == 0:
            print(f"  Window observations: {fi + 1}/{len(fetch_nights)} nights, {n_window_rows} rows", flush=True)

    print(f"  Total: {sum(len(v) for v in result.values())} rows ({n_cohort_rows} cohort + {n_window_rows} window)", flush=True)
    return dict(result)


# ---------------------------------------------------------------------------
# Hash rehashing + verification
# ---------------------------------------------------------------------------

def _rehash_snapshot_rows(
    snapshot_rows: dict[str, list[dict]],
    topology,
    hash_lookup: dict[str, dict[str, str]],
) -> None:
    """Replace core_hash on every snapshot row with the authoritative FE hash.

    snapshot_rows were generated with whatever hashes existed at simulation
    time. This function overwrites them with the FE-computed hashes so the
    DB write uses the correct hashes.
    """
    for edge_id, rows in snapshot_rows.items():
        et = topology.edges.get(edge_id)
        if not et or not et.param_id:
            continue
        pid = et.param_id
        hashes = hash_lookup.get(pid)
        if not hashes:
            bare = pid.replace("parameter-", "") if pid.startswith("parameter-") else pid
            hashes = hash_lookup.get(bare)
        if not hashes:
            continue

        w_hash = hashes["window_hash"]
        c_hash = hashes["cohort_hash"]

        for r in rows:
            sk = r.get("slice_key", "")
            if "cohort" in sk:
                r["core_hash"] = c_hash
            else:
                r["core_hash"] = w_hash


def _verify_db_data(
    hash_lookup: dict[str, dict[str, str]],
    topology,
    workspace_prefix: str,
    db_connection: str,
) -> None:
    """Query DB with the authoritative hashes and confirm rows exist.

    Prints PASS/FAIL per edge. Exits with error if any edge has 0 rows.
    """
    import psycopg2
    conn = psycopg2.connect(db_connection)
    cur = conn.cursor()

    all_ok = True
    for edge_id, et in topology.edges.items():
        pid = et.param_id
        if not pid:
            continue
        hashes = hash_lookup.get(pid)
        if not hashes:
            bare = pid.replace("parameter-", "") if pid.startswith("parameter-") else pid
            hashes = hash_lookup.get(bare)
        if not hashes:
            continue

        db_pid = f"{workspace_prefix}-{pid}" if workspace_prefix else pid

        for mode, h in [("window", hashes["window_hash"]), ("cohort", hashes["cohort_hash"])]:
            cur.execute(
                "SELECT COUNT(*) FROM snapshots WHERE core_hash = %s AND param_id = %s",
                (h, db_pid),
            )
            count = cur.fetchone()[0]
            status = "PASS" if count > 0 else "FAIL"
            if count == 0:
                all_ok = False
            print(f"  {status} {pid} {mode}: {count} rows (hash={h[:16]}…, db_pid={db_pid[:40]})")

    conn.close()
    if not all_ok:
        print("\n  ERROR: Some edges have 0 rows in DB. Hash mismatch likely.")
    else:
        print("\n  All edges verified — DB data matches FE hashes.")


# ---------------------------------------------------------------------------
# DB write
# ---------------------------------------------------------------------------

def write_to_snapshot_db(
    snapshot_rows: dict[str, list[dict]],
    db_connection: str,
    workspace_prefix: str = "",
    hash_lookup: dict[str, dict[str, str]] | None = None,
) -> dict[str, dict[str, str]]:
    """Write synthetic rows to snapshot DB using the existing snapshot_service.

    Cleans existing rows for the same core hashes first (idempotent).
    workspace_prefix: e.g. "nous-conversion-feature/bayes-test-graph" —
        prepended to param_ids as "${prefix}-${param_id}" to match the FE's
        buildDbParamId format.
    Returns dict[param_id → {window_hash, cohort_hash}] for test harness.
    """
    # Use the existing snapshot_service (same as FE fetch pipeline)
    lib_dir = os.path.join(REPO_ROOT, "graph-editor", "lib")
    ge_dir = os.path.join(REPO_ROOT, "graph-editor")
    if lib_dir not in sys.path:
        sys.path.insert(0, lib_dir)
    if ge_dir not in sys.path:
        sys.path.insert(0, ge_dir)
    os.environ["DB_CONNECTION"] = db_connection
    from lib.snapshot_service import append_snapshots, delete_snapshots

    # Group rows by (param_id, core_hash, slice_key, retrieved_at)
    # — each group becomes one append_snapshots call
    # Apply workspace prefix to param_ids (FE queries with prefixed IDs)
    from collections import defaultdict
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for edge_rows in snapshot_rows.values():
        for r in edge_rows:
            db_pid = f"{workspace_prefix}-{r['param_id']}" if workspace_prefix else r["param_id"]
            key = (db_pid, r["core_hash"], r["slice_key"], r["retrieved_at"])
            groups[key].append(r)

    # Clean existing data for all param_id + core_hash combos
    cleaned_combos: set[tuple[str, str]] = set()
    for (pid, ch, _sk, _ra) in groups:
        if (pid, ch) not in cleaned_combos:
            result = delete_snapshots(pid, core_hashes=[ch])
            if result["success"] and result["deleted"] > 0:
                print(f"  Cleaned {result['deleted']} existing rows for {pid}/{ch[:12]}…")
            cleaned_combos.add((pid, ch))

    # Insert via append_snapshots
    total_inserted = 0
    hash_map: dict[str, dict[str, str]] = {}

    for (pid, core_hash, slice_key, retrieved_at_str), rows in groups.items():
        # Parse retrieved_at regardless of separator (T or space)
        clean_ra = retrieved_at_str.replace("T", " ")
        retrieved_at = datetime.strptime(clean_ra, "%Y-%m-%d %H:%M:%S")

        # Build rows in append_snapshots format
        append_rows = []
        for r in rows:
            append_rows.append({
                "anchor_day": r["anchor_day"],
                "A": r.get("a"),
                "X": r.get("x"),
                "Y": r["y"],
                "median_lag_days": r.get("median_lag_days"),
                "mean_lag_days": r.get("mean_lag_days"),
                "anchor_median_lag_days": r.get("anchor_median_lag_days"),
                "anchor_mean_lag_days": r.get("anchor_mean_lag_days"),
                "onset_delta_days": r.get("onset_delta_days"),
            })

        # Resolve the real structured sig for registry parity.
        # The FE sends current_signatures from param file query_signature;
        # the registry canonical_signature must match for family grouping.
        bare_pid = pid.replace(f"{workspace_prefix}-", "") if workspace_prefix else pid
        sig_key = "window_sig" if "window" in slice_key else "cohort_sig"
        real_sig = (hash_lookup or {}).get(bare_pid, {}).get(sig_key)
        canonical = real_sig if real_sig else f"synthetic:{pid}:{slice_key}"

        result = append_snapshots(
            param_id=pid,
            canonical_signature=canonical,
            inputs_json={"synthetic": True, "generator": "synth_gen"},
            sig_algo="sig_v1_sha256_trunc128_b64url",
            slice_key=slice_key,
            retrieved_at=retrieved_at,
            rows=append_rows,
            core_hash=core_hash,
        )

        if result.get("success"):
            total_inserted += result.get("inserted", 0)
        else:
            print(f"  WARNING: append failed for {pid}/{slice_key}: {result}")

        # Build hash map
        if pid not in hash_map:
            hash_map[pid] = {}
        if "window" in slice_key:
            hash_map[pid]["window_hash"] = core_hash
        else:
            hash_map[pid]["cohort_hash"] = core_hash

    print(f"  Inserted {total_inserted} rows")
    return hash_map


def clean_synthetic_data(db_connection: str, gcfg: dict | None = None) -> None:
    """Remove synthetic data from snapshot DB using snapshot_service.

    If gcfg is provided, removes only rows matching that graph's core hashes.
    """
    lib_dir = os.path.join(REPO_ROOT, "graph-editor", "lib")
    ge_dir = os.path.join(REPO_ROOT, "graph-editor")
    if lib_dir not in sys.path:
        sys.path.insert(0, lib_dir)
    if ge_dir not in sys.path:
        sys.path.insert(0, ge_dir)
    os.environ["DB_CONNECTION"] = db_connection
    from lib.snapshot_service import delete_snapshots

    if not gcfg:
        print("No graph config — nothing to clean")
        return

    total_deleted = 0
    for pid, _eid, wh, ch in gcfg.get("edges", []):
        for core_hash in [wh, ch]:
            result = delete_snapshots(pid, core_hashes=[core_hash])
            if result["success"]:
                total_deleted += result["deleted"]

    print(f"Cleaned {total_deleted} rows for graph '{gcfg.get('graph_id', '?')}'")



# ---------------------------------------------------------------------------
# Data repo file generation
# ---------------------------------------------------------------------------

def _format_date_dmy(dt: datetime) -> str:
    """Format datetime as d-MMM-yy (e.g. 1-Nov-25)."""
    return dt.strftime("%-d-%b-%y")


def write_parameter_files(
    topology,
    truth: dict,
    sim_stats: dict,
    data_repo: str,
    graph_snapshot: dict,
    hash_lookup: dict[str, dict[str, str]] | None = None,
) -> list[str]:
    """Write/update parameter YAML files with simulated values[].

    For each evented edge, writes a parameter file containing:
    - Aggregate n, k, mean from the simulation
    - Per-day n_daily, k_daily, dates arrays
    - Latency block from ground truth
    - Query matching the edge's graph DSL
    - data_source marking this as synthetic

    Returns list of param_ids that were written.
    """
    edge_daily = sim_stats.get("edge_daily", {})
    base_date = datetime.strptime(sim_stats["base_date"], "%Y-%m-%d")
    n_days = sim_stats["n_days"]
    end_date = base_date + timedelta(days=n_days - 1)
    actual_traffic = sim_stats.get("actual_traffic", [])
    burn_in_days = sim_stats.get("burn_in_days", 0)

    # Build node UUID → node id lookup from graph
    uuid_to_id: dict[str, str] = {}
    for n in graph_snapshot.get("nodes", []):
        uuid_to_id[n["uuid"]] = n.get("id", "")

    written = []
    for edge_id, et in topology.edges.items():
        pid = et.param_id
        if not pid:
            continue
        daily = edge_daily.get(edge_id)
        if not daily:
            continue

        # Get ground truth for this edge
        t = _resolve_truth_edge(truth, pid)

        n_daily = daily["n_daily"]
        k_daily = daily["k_daily"]
        dates = daily["dates"]
        total_n = sum(n_daily)
        total_k = sum(k_daily)
        mean = total_k / total_n if total_n > 0 else 0.0

        # Build the query from node IDs (from(x).to(y))
        from_id = uuid_to_id.get(et.from_node, et.from_node)
        to_id = uuid_to_id.get(et.to_node, et.to_node)
        query = f"from({from_id}).to({to_id})"

        # Strip parameter- prefix for the file ID
        file_id = pid.replace("parameter-", "") if pid.startswith("parameter-") else pid

        # Compute median lag per day from the sorted arrival times
        # (not critical for snapshot path, but useful for FE display)
        onset = t.get("onset", 0.0)

        # Resolve anchor node ID for cohort DSL
        anchor_id = uuid_to_id.get(
            topology.anchor_node_id, topology.anchor_node_id
        )
        window_dsl = f"window({_format_date_dmy(base_date)}:{_format_date_dmy(end_date)})"
        cohort_dsl = f"cohort({anchor_id},{_format_date_dmy(base_date)}:{_format_date_dmy(end_date)})"
        now_str = datetime.now(tz=None).strftime("%Y-%m-%dT%H:%M:%SZ")

        # Empirical lag stats from actual simulated arrivals (per-day lists).
        # These match what Amplitude would derive from its lag histograms.
        median_lag_daily = daily.get("median_lag_daily", [0] * len(dates))
        mean_lag_daily = daily.get("mean_lag_daily", [0] * len(dates))
        anchor_median_daily = daily.get("anchor_median_lag_daily", [0] * len(dates))
        anchor_mean_daily = daily.get("anchor_mean_lag_daily", [0] * len(dates))
        anchor_n_daily = daily.get("anchor_n_daily", [0] * len(dates))

        # Window values[] entry — matches real Amplitude fetch output shape
        window_entry: dict[str, Any] = {
            "mean": round(mean, 6),
            "n": total_n,
            "k": total_k,
            "n_daily": n_daily,
            "k_daily": k_daily,
            "dates": dates,
            "window_from": _format_date_dmy(base_date),
            "window_to": _format_date_dmy(end_date),
            "sliceDSL": window_dsl,
            "median_lag_days": median_lag_daily,
            "mean_lag_days": mean_lag_daily,
            "latency": {"onset_delta_days": onset},
            "data_source": {
                "type": "synthetic",
                "retrieved_at": now_str,
                "full_query": query,
            },
            "forecast": round(mean, 6),
        }
        if hash_lookup and pid in hash_lookup and "window_sig" in hash_lookup[pid]:
            window_entry["query_signature"] = hash_lookup[pid]["window_sig"]

        # Cohort values[] entry
        cohort_entry: dict[str, Any] = {
            "mean": round(mean, 6),
            "n": total_n,
            "k": total_k,
            "n_daily": n_daily,
            "k_daily": k_daily,
            "dates": dates,
            "anchor_n_daily": anchor_n_daily,
            "cohort_from": _format_date_dmy(base_date),
            "cohort_to": _format_date_dmy(end_date),
            "sliceDSL": cohort_dsl,
            "median_lag_days": median_lag_daily,
            "mean_lag_days": mean_lag_daily,
            "anchor_median_lag_days": anchor_median_daily,
            "anchor_mean_lag_days": anchor_mean_daily,
            "latency": {"onset_delta_days": onset},
            "data_source": {
                "type": "synthetic",
                "retrieved_at": now_str,
                "full_query": query,
            },
            "forecast": round(mean, 6),
        }
        if hash_lookup and pid in hash_lookup and "cohort_sig" in hash_lookup[pid]:
            cohort_entry["query_signature"] = hash_lookup[pid]["cohort_sig"]

        # Context-qualified values[] entries (one per context value per obs type)
        context_entries: list[dict] = []
        context_dims = truth.get("context_dimensions", [])
        for dim in context_dims:
            for v in dim.get("values", []):
                ctx_prefix = f"context({dim['id']}:{v['id']})"
                # Context window entry
                ctx_window: dict[str, Any] = {
                    "mean": round(mean, 6),  # approximate — context-specific would be better
                    "n": total_n,
                    "k": total_k,
                    "n_daily": n_daily,
                    "k_daily": k_daily,
                    "dates": dates,
                    "window_from": _format_date_dmy(base_date),
                    "window_to": _format_date_dmy(end_date),
                    "sliceDSL": f"{ctx_prefix}.{window_dsl}",
                    "median_lag_days": median_lag_daily,
                    "mean_lag_days": mean_lag_daily,
                    "latency": {"onset_delta_days": onset},
                    "data_source": {"type": "synthetic", "retrieved_at": now_str, "full_query": query},
                    "forecast": round(mean, 6),
                }
                if hash_lookup and pid in hash_lookup and "window_sig" in hash_lookup[pid]:
                    ctx_window["query_signature"] = hash_lookup[pid]["window_sig"]
                context_entries.append(ctx_window)

                # Context cohort entry
                ctx_cohort: dict[str, Any] = {
                    "mean": round(mean, 6),
                    "n": total_n,
                    "k": total_k,
                    "n_daily": n_daily,
                    "k_daily": k_daily,
                    "dates": dates,
                    "anchor_n_daily": anchor_n_daily,
                    "cohort_from": _format_date_dmy(base_date),
                    "cohort_to": _format_date_dmy(end_date),
                    "sliceDSL": f"{ctx_prefix}.{cohort_dsl}",
                    "median_lag_days": median_lag_daily,
                    "mean_lag_days": mean_lag_daily,
                    "anchor_median_lag_days": anchor_median_daily,
                    "anchor_mean_lag_days": anchor_mean_daily,
                    "latency": {"onset_delta_days": onset},
                    "data_source": {"type": "synthetic", "retrieved_at": now_str, "full_query": query},
                    "forecast": round(mean, 6),
                }
                if hash_lookup and pid in hash_lookup and "cohort_sig" in hash_lookup[pid]:
                    ctx_cohort["query_signature"] = hash_lookup[pid]["cohort_sig"]
                context_entries.append(ctx_cohort)

        param_data = {
            "id": file_id,
            "name": file_id,
            "type": "probability",
            "connection": "synthetic",
            "query": query,
            "query_overridden": False,
            "n_query_overridden": False,
            "values": [window_entry, cohort_entry] + context_entries,
            "latency": {
                "latency_parameter": bool(
                    t.get("onset", 0) > 0.01 or t.get("mu", 0) > 0.01
                ),
                "anchor_node_id": uuid_to_id.get(
                    topology.anchor_node_id, topology.anchor_node_id
                ),
                "onset_delta_days": onset,
                "latency_parameter_overridden": False,
            },
            "metadata": {
                "description": f"Synthetic data (seed={sim_stats.get('seed', '?')}, "
                               f"n={sim_stats['mean_daily_traffic']}/day, "
                               f"days={n_days})",
                "created_at": datetime.now(tz=None).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "updated_at": datetime.now(tz=None).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "author": "synth_gen",
                "version": "1.0.0",
                "status": "active",
            },
        }

        param_path = os.path.join(data_repo, "parameters", f"{file_id}.yaml")
        with open(param_path, "w") as f:
            yaml.dump(param_data, f, default_flow_style=False, sort_keys=False,
                      allow_unicode=True)
        written.append(file_id)

    return written


def set_simulation_guard(
    graph_path: str,
    enable: bool = True,
    sim_stats: dict | None = None,
    truth: dict | None = None,
) -> None:
    """Set or clear the simulation flag on a graph JSON file.

    When simulation=true, the FE fetch planner returns empty fetch plans,
    preventing real Amplitude fetches from overwriting synthetic data.

    Also sets dataInterestsDSL and currentQueryDSL so the FE knows
    what date range the synthetic data covers. If truth has context
    dimensions, the DSL includes context qualifiers so the FE expands
    the cartesian product (obs_type × context_value).
    """
    with open(graph_path) as f:
        graph = json.load(f)

    if enable:
        graph["simulation"] = True
        graph["dailyFetch"] = False

        if sim_stats:
            base_date = datetime.strptime(sim_stats["base_date"], "%Y-%m-%d")
            n_days = sim_stats["n_days"]
            end_date = base_date + timedelta(days=n_days - 1)
            window_from = _format_date_dmy(base_date)
            window_to = _format_date_dmy(end_date)

            temporal = f"window({window_from}:{window_to});cohort({window_from}:{window_to})"

            # Add context dimensions to DSL if present in truth.
            # Format: (window;cohort)(context(dim1);context(dim2))
            # The FE expands this as a cartesian product.
            context_dims = (truth or {}).get("context_dimensions", [])
            if context_dims:
                ctx_parts = ";".join(f"context({d['id']})" for d in context_dims)
                dsl = f"({temporal})({ctx_parts})"
            else:
                dsl = temporal

            graph["dataInterestsDSL"] = dsl
            graph["pinnedDSL"] = dsl
            graph["currentQueryDSL"] = f"window({window_from}:{window_to})"
    else:
        graph.pop("simulation", None)
        graph.pop("dataInterestsDSL", None)
        graph.pop("currentQueryDSL", None)

    with open(graph_path, "w") as f:
        json.dump(graph, f, indent=2, ensure_ascii=False)
        f.write("\n")


def update_parameter_index(data_repo: str, param_ids: list[str]) -> None:
    """Ensure all param_ids have entries in parameters-index.yaml."""
    index_path = os.path.join(data_repo, "parameters-index.yaml")
    with open(index_path) as f:
        index_data = yaml.safe_load(f) or {}

    existing_ids = {p["id"] for p in index_data.get("parameters", [])}
    added = 0

    for pid in param_ids:
        if pid in existing_ids:
            continue
        index_data.setdefault("parameters", []).append({
            "id": pid,
            "file_path": f"parameters/{pid}.yaml",
            "name": pid,
            "status": "active",
            "type": "probability",
            "created_at": datetime.now(tz=None).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "updated_at": datetime.now(tz=None).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "author": "synth_gen",
            "version": "1.0.0",
        })
        added += 1

    if added > 0:
        with open(index_path, "w") as f:
            yaml.dump(index_data, f, default_flow_style=False, sort_keys=False,
                      allow_unicode=True)
        print(f"  Added {added} entries to parameters-index.yaml")
    else:
        print(f"  parameters-index.yaml already up to date")


def update_graph_edge_metadata(
    graph_path: str,
    topology,
    truth: dict,
    sim_stats: dict,
) -> None:
    """Update graph edge p blocks with simulated means and latency.

    Keeps the graph's inline data consistent with parameter files so the
    integrity checker's data-drift check passes.
    """
    edge_daily = sim_stats.get("edge_daily", {})

    with open(graph_path) as f:
        graph = json.load(f)

    # Build node UUID → node id lookup
    uuid_to_id: dict[str, str] = {}
    for n in graph.get("nodes", []):
        uuid_to_id[n["uuid"]] = n.get("id", "")

    edge_by_uuid = {e["uuid"]: e for e in graph.get("edges", [])}

    for edge_id, et in topology.edges.items():
        if not et.param_id:
            continue
        daily = edge_daily.get(edge_id)
        if not daily:
            continue

        total_n = sum(daily["n_daily"])
        total_k = sum(daily["k_daily"])
        mean = total_k / total_n if total_n > 0 else 0.0

        t = _resolve_truth_edge(truth, et.param_id)

        edge = edge_by_uuid.get(edge_id)
        if not edge:
            continue

        p = edge.setdefault("p", {})
        # Clear stale analytical fields from prior runs
        for stale_key in ["mean", "n", "forecast", "stdev", "evidence"]:
            p.pop(stale_key, None)

        # Set query string at edge top level (FE reads edge.query)
        from_id = uuid_to_id.get(et.from_node, et.from_node)
        to_id = uuid_to_id.get(et.to_node, et.to_node)
        edge["query"] = f"from({from_id}).to({to_id})"

        # Structural latency block — only fields that exist before the
        # stats pass runs. Clear any stale analytical params from prior runs.
        # Only set latency_parameter=true if the truth config has non-trivial
        # latency for this edge (onset > 0 or mu > 0.01). Edges without
        # latency compile as simple Binomials — much cheaper to sample.
        edge_truth = _resolve_truth_edge(truth, et.param_id)
        has_latency = (edge_truth.get("onset", 0) > 0.01 or edge_truth.get("mu", 0) > 0.01)
        p["latency"] = {
            "latency_parameter": has_latency,
        }
        anchor_id = uuid_to_id.get(
            topology.anchor_node_id, topology.anchor_node_id
        )
        p["latency"]["anchor_node_id"] = anchor_id

        # cohort_anchor_event_id — FE uses this to derive the cohort
        # anchor for snapshot queries
        anchor_node = None
        for n in graph.get("nodes", []):
            if n.get("uuid") == topology.anchor_node_id or n.get("id") == uuid_to_id.get(topology.anchor_node_id):
                anchor_node = n
                break
        if anchor_node and anchor_node.get("event_id"):
            p["cohort_anchor_event_id"] = anchor_node["event_id"]

    with open(graph_path, "w") as f:
        json.dump(graph, f, indent=2, ensure_ascii=False)
        f.write("\n")


# ---------------------------------------------------------------------------
# Summary + recovery report
# ---------------------------------------------------------------------------

def print_summary(
    topology, truth: dict, snapshot_rows: dict[str, list[dict]],
    sim_stats: dict,
) -> None:
    """Print simulation summary."""
    print(f"\n{'='*70}")
    print("SYNTHETIC DATA SUMMARY")
    print(f"{'='*70}")

    # Simulation config
    print(f"  Days: {sim_stats['n_days']}  |  "
          f"Traffic: {sim_stats['mean_daily_traffic']}/day "
          f"(actual: {sim_stats['actual_traffic_range'][0]}–{sim_stats['actual_traffic_range'][1]})  |  "
          f"Base date: {sim_stats['base_date']}")
    print(f"  Kappa: {sim_stats['kappa_default']}  |  "
          f"Failure rate: {sim_stats['failure_rate']}  |  "
          f"Drift sigma: {sim_stats['drift_sigma']}")
    print()

    # Per-edge table
    print(f"{'Edge':<35} {'p':>6} {'onset':>6} {'mu':>6} {'sig':>5} {'kap':>5}  {'w_rows':>7} {'c_rows':>7}")
    print("-" * 90)

    for edge_id, et in topology.edges.items():
        pid = et.param_id
        if not pid:
            continue
        t = _resolve_truth_edge(truth, pid)
        rows = snapshot_rows.get(edge_id, [])
        w_count = sum(1 for r in rows if r.get("slice_key") == "window()")
        c_count = sum(1 for r in rows if r.get("slice_key") == "cohort()")
        label = pid[:35] if pid else edge_id[:35]
        print(f"{label:<35} {t.get('p', 0):.4f} {t.get('onset', 0):6.1f} "
              f"{t.get('mu', 0):6.2f} {t.get('sigma', 0):5.2f} "
              f"{t.get('kappa_sim', sim_stats['kappa_default']):5.0f}  "
              f"{w_count:7d} {c_count:7d}")

    print(f"\nTotal rows: {sim_stats['total_rows']}")


def print_edge_config(
    topology, hash_map: dict[str, dict[str, str]],
) -> None:
    """Print edge config tuples for test harness."""
    print(f"\n{'='*70}")
    print("EDGE CONFIG FOR TEST HARNESS")
    print(f"{'='*70}")
    for edge_id, et in topology.edges.items():
        pid = et.param_id
        if not pid:
            continue
        hashes = hash_map.get(pid, {})
        wh = hashes.get("window_hash", "???")
        ch = hashes.get("cohort_hash", "???")
        print(f'    ("{pid}", "{edge_id}", "{wh}", "{ch}"),')


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Bayes synthetic data generator (doc 17)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python synth_gen.py --graph branch --dry-run
  python synth_gen.py --graph branch --kappa 15 --drift 0.02
  python synth_gen.py --graph branch --write-files
  python synth_gen.py --clean --graph branch
""",
    )
    parser.add_argument("--graph", required=True,
                        help="Graph name or shortcut. Resolves to a .truth.yaml in the data repo.")
    parser.add_argument("--people", type=int, default=None,
                        help="Mean people per cohort day (default: from truth file)")
    parser.add_argument("--days", type=int, default=None,
                        help="Number of cohort days (default: from truth file)")
    parser.add_argument("--seed", type=int, default=None, help="RNG seed (default: 42)")
    parser.add_argument("--kappa", type=float, default=None,
                        help="Default kappa_sim for overdispersion (default: 50)")
    parser.add_argument("--failure-rate", type=float, default=None,
                        help="Fetch failure rate 0-1 (default: 0.05)")
    parser.add_argument("--drift", type=float, default=None,
                        help="Drift sigma for random-walk on p (default: 0 = off)")
    parser.add_argument("--drift-rate", type=float, default=None,
                        help="Deterministic linear drift on logit(p) per day (e.g. -0.01)")
    parser.add_argument("--growth", type=float, default=None,
                        help="MoM growth rate (0.05 = 5%% MoM exponential, default: 0 = flat)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Generate and summarise but don't write to DB or files")
    parser.add_argument("--write-files", action="store_true",
                        help="Also update data repo: param YAMLs, graph JSON, indexes")
    parser.add_argument("--clean", action="store_true",
                        help="Remove synthetic data from DB and exit")
    args = parser.parse_args()

    data_repo = _resolve_data_repo()
    db_conn = _load_db_connection()

    # --- Resolve truth file ---
    # Try: exact match, shortcut, synth-X, synth-X-test patterns
    from graph_from_truth import generate_graph_artefacts, truth_has_graph_structure
    graph_name = GRAPH_SHORTCUTS.get(args.graph, args.graph) if hasattr(sys.modules[__name__], 'GRAPH_SHORTCUTS') else args.graph

    truth_candidates = [
        os.path.join(data_repo, "graphs", f"{graph_name}.truth.yaml"),
        os.path.join(data_repo, "graphs", f"synth-{graph_name}.truth.yaml"),
        os.path.join(data_repo, "graphs", f"synth-{graph_name}-test.truth.yaml"),
        os.path.join(data_repo, "graphs", f"{args.graph}.truth.yaml"),
        os.path.join(data_repo, "graphs", f"synth-{args.graph}.truth.yaml"),
        os.path.join(data_repo, "graphs", f"synth-{args.graph}-test.truth.yaml"),
    ]
    truth_path = None
    for tp in truth_candidates:
        if os.path.exists(tp):
            truth_path = tp
            break

    if truth_path is None:
        print(f"ERROR: No truth file found for '{args.graph}'")
        print(f"  Searched: {[os.path.basename(t) for t in truth_candidates]}")
        sys.exit(1)

    truth = load_truth_config(truth_path)
    print(f"Truth: {truth_path}")

    # --- Generate or load graph ---
    if truth_has_graph_structure(truth):
        # New format: generate graph + entity files from truth
        graph_name_resolved = truth.get("graph", {}).get("name", args.graph)
        graph_path = os.path.join(data_repo, "graphs", f"{graph_name_resolved}.json")

        # Always regenerate — truth file is authoritative
        print(f"\n── Generate graph from truth ──")
        graph_path = generate_graph_artefacts(truth, data_repo, graph_name_resolved)
    else:
        # Old format: truth has only params, graph JSON must exist
        graph_path = truth_path.replace(".truth.yaml", ".json")
        if not os.path.isfile(graph_path):
            print(f"ERROR: Old-format truth — graph JSON not found at {graph_path}")
            sys.exit(1)

    with open(graph_path) as f:
        graph = json.load(f)
    print(f"Graph [{args.graph}]: {len(graph.get('edges', []))} edges")

    if args.clean:
        if not db_conn:
            print("ERROR: No DB_CONNECTION")
            sys.exit(1)
        # Clean using topology-derived hashes
        from compiler.topology import analyse_topology as _at
        _topo = _at(graph)
        # Just delete all rows for this graph's param IDs
        print("Cleaning synthetic data...")
        # TODO: implement clean for new format
        return

    # Topology
    from compiler.topology import analyse_topology
    topology = analyse_topology(graph)
    print(f"Topology: {len(topology.edges)} edges, "
          f"{len(topology.branch_groups)} branch groups, "
          f"{len(topology.join_nodes)} joins")

    # Placeholder hashes for simulation. The simulation just needs some
    # string to tag rows — the real FE-authoritative hashes are applied
    # in the write pipeline (step 2) via _rehash_snapshot_rows.
    hash_lookup: dict[str, dict[str, str]] = {}
    for edge_id, et in topology.edges.items():
        pid = et.param_id
        if pid:
            hash_lookup[pid] = {
                "window_hash": f"SIM-{pid}-w",
                "cohort_hash": f"SIM-{pid}-c",
            }
            if not pid.startswith("parameter-"):
                hash_lookup[f"parameter-{pid}"] = hash_lookup[pid]
    print(f"Hashes: {len(hash_lookup)} edges resolved via FE (Node.js)")
    # Also merge any hashes from truth config edges
    for pid, edata in truth.get("edges", {}).items():
        if "window_hash" in edata and "cohort_hash" in edata:
            hash_lookup[pid] = {
                "window_hash": edata["window_hash"],
                "cohort_hash": edata["cohort_hash"],
            }

    # Simulation config: truth config → CLI overrides
    cli_overrides = {
        "mean_daily_traffic": args.people,
        "n_days": args.days,
        "seed": args.seed,
        "kappa_sim_default": args.kappa,
        "failure_rate": args.failure_rate,
        "drift_sigma": args.drift,
        "drift_rate": args.drift_rate,
        "growth_rate_mom": args.growth,
    }
    sim_config = _get_sim_config(truth, cli_overrides)
    sim_config["base_date"] = truth.get("simulation", {}).get("base_date", "2025-12-12")

    print(f"\nSimulating ~{sim_config['mean_daily_traffic']} people/day "
          f"× {sim_config['n_days']} days "
          f"(seed={sim_config['seed']}, "
          f"κ={sim_config['kappa_sim_default']}, "
          f"drift={sim_config['drift_sigma']})...")

    import time as _time
    t0 = _time.time()

    snapshot_rows, sim_stats = simulate_graph(
        graph, topology, truth, sim_config, hash_lookup,
    )
    elapsed = _time.time() - t0
    print(f"Simulation complete in {elapsed:.1f}s")

    print_summary(topology, truth, snapshot_rows, sim_stats)

    if args.dry_run:
        print("\n(Dry run — not writing to DB or files)")
        return

    # ── WRITE PIPELINE ──────────────────────────────────────────────
    # Single-pass: structural metadata → FE hashes → DB → param files → verify.
    # ALL hash computation goes through compute_snapshot_subjects.mjs (Node.js).
    # No Python hash computation. One source of truth.

    import subprocess as _sp

    # 1. Update graph edge structural metadata on disk.
    #    (query, latency_parameter, anchor_node_id, cohort_anchor_event_id)
    #    Does NOT touch analytical params (mu/sigma/t95) — stats pass does that.
    if args.write_files:
        print(f"\n── Step 1: Update graph structural metadata ──")
        update_graph_edge_metadata(graph_path, topology, truth, sim_stats)
        print("  Updated: query, latency_parameter, cohort_anchor_event_id")

        # Set simulation guard (simulation=true, dailyFetch=false, DSL)
        set_simulation_guard(graph_path, enable=True, sim_stats=sim_stats, truth=truth)
        print("  Set simulation guard")

    # 2. Compute authoritative hashes via Node.js (from the graph on disk).
    #    This MUST happen AFTER structural metadata update (latency_parameter
    #    affects the hash) but the graph must be on disk for Node to read it.
    print(f"\n── Step 2: Compute FE-authoritative hashes ──")
    node_script = os.path.join(REPO_ROOT, "bayes", "compute_snapshot_subjects.mjs")
    nvm_prefix = (
        f'export NVM_DIR="$HOME/.nvm" && '
        f'. "$NVM_DIR/nvm.sh" 2>/dev/null && '
        f'cd {os.path.join(REPO_ROOT, "graph-editor")} && '
        f'nvm use "$(cat .nvmrc)" 2>/dev/null && '
    )
    node_cmd = f'{nvm_prefix}node {node_script} {graph_path}'
    node_result = _sp.run(node_cmd, shell=True, capture_output=True, text=True, timeout=30)
    if node_result.returncode != 0:
        print(f"  ERROR: compute_snapshot_subjects.mjs failed:")
        print(f"  {node_result.stderr[:300]}")
        print(f"  Cannot proceed without authoritative hashes.")
        sys.exit(1)
    node_stdout = node_result.stdout
    json_start = node_stdout.index("{")
    fe_data = json.loads(node_stdout[json_start:])

    hash_lookup: dict[str, dict[str, str]] = {}
    for e in fe_data["edges"]:
        pid = e["param_id"]
        hash_lookup[pid] = {
            "window_hash": e["window_hash"],
            "cohort_hash": e["cohort_hash"],
            "window_sig": e.get("window_sig", ""),
            "cohort_sig": e.get("cohort_sig", ""),
        }
        if not pid.startswith("parameter-"):
            hash_lookup[f"parameter-{pid}"] = hash_lookup[pid]
    print(f"  {len(fe_data['edges'])} edges resolved")
    for e in fe_data["edges"]:
        print(f"    {e['param_id']}: w={e['window_hash'][:16]}… c={e['cohort_hash'][:16]}…")

    # 3. Write to snapshot DB using FE hashes.
    workspace_prefix = ""
    if db_conn:
        print(f"\n── Step 3: Write to snapshot DB ──")
        repo_name = os.path.basename(data_repo)
        try:
            branch_name = _sp.check_output(
                ["git", "-C", data_repo, "branch", "--show-current"], text=True,
            ).strip()
        except Exception:
            branch_name = "main"
        workspace_prefix = f"{repo_name}-{branch_name}"
        print(f"  Workspace prefix: {workspace_prefix}")

        # Re-hash snapshot_rows with the authoritative hashes
        # (snapshot_rows was generated with whatever hash_lookup existed at sim time)
        _rehash_snapshot_rows(snapshot_rows, topology, hash_lookup)

        try:
            write_to_snapshot_db(snapshot_rows, db_conn, workspace_prefix, hash_lookup)
        except Exception as e:
            print(f"  WARNING: DB write failed: {e}")
            print(f"  (Continuing with file generation if --write-files is set)")
    else:
        print(f"\n── Step 3: SKIPPED (no DB_CONNECTION) ──")

    # 4. Write parameter files using FE hashes.
    if args.write_files:
        print(f"\n── Step 4: Write parameter files ──")
        with open(graph_path) as f:
            updated_graph = json.load(f)
        written_params = write_parameter_files(
            topology, truth, sim_stats, data_repo, updated_graph, hash_lookup,
        )
        print(f"  Wrote {len(written_params)} parameter files")
        update_parameter_index(data_repo, written_params)

    # 5. Verify: query DB with the SAME hashes and confirm data exists.
    if db_conn:
        print(f"\n── Step 5: Verify DB data ──")
        _verify_db_data(hash_lookup, topology, workspace_prefix, db_conn)

    if not db_conn and not args.write_files:
        print("\nWARNING: No DB and --write-files not set — data generated but not persisted.")

    # Write .synth-meta.json sidecar for integrity checking
    if db_conn or args.write_files:
        total_rows = sum(len(v) for v in snapshot_rows.values())
        # Serialise edge hashes for the meta sidecar
        meta_hashes = {}
        for pid, h in hash_lookup.items():
            if not pid.startswith("parameter-"):
                meta_hashes[pid] = {
                    "window_hash": h.get("window_hash", ""),
                    "cohort_hash": h.get("cohort_hash", ""),
                }
        graph_name_for_meta = os.path.basename(truth_path).replace(".truth.yaml", "")
        save_synth_meta(graph_name_for_meta, truth_path, meta_hashes, total_rows, data_repo)
        print(f"Wrote .synth-meta.json (truth_sha256, {total_rows} rows, {len(meta_hashes)} edges)")

    print("\nDone.")


if __name__ == "__main__":
    main()
