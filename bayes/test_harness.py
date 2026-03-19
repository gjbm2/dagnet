#!/usr/bin/env python3
"""
Bayes test harness — runs fit_graph directly with full logging.

Usage:
    cd dagnet
    . graph-editor/venv/bin/activate
    python bayes/test_harness.py [--placeholder] [--no-webhook]

Reads the test graph from the data repo, builds snapshot subjects,
runs the compiler, and prints the full log. No browser needed.
"""

import sys
import os
import json
import time
import argparse
from datetime import datetime, date

# Paths
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "graph-editor", "lib"))
sys.path.insert(0, os.path.join(REPO_ROOT, "bayes"))

# Read .private-repos.conf
def _read_private_repos_conf():
    conf = {}
    conf_path = os.path.join(REPO_ROOT, ".private-repos.conf")
    if os.path.isfile(conf_path):
        with open(conf_path) as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    conf[k.strip()] = v.strip()
    return conf


def _load_env(path):
    """Load key=value pairs from a file into a dict."""
    env = {}
    if not os.path.isfile(path):
        return env
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            eq = line.find("=")
            if eq < 0:
                continue
            env[line[:eq]] = line[eq + 1:]
    return env


class DateEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, (datetime, date)):
            return obj.isoformat()
        return super().default(obj)


def main():
    parser = argparse.ArgumentParser(description="Bayes test harness")
    parser.add_argument("--placeholder", action="store_true", help="Use placeholder mode (skip MCMC)")
    parser.add_argument("--no-webhook", action="store_true", help="Skip webhook call")
    parser.add_argument("--curl", action="store_true", help="Generate curl command instead of running directly")
    args = parser.parse_args()

    conf = _read_private_repos_conf()
    data_repo = conf.get("DATA_REPO_DIR", "nous-conversion")
    data_repo_path = os.path.join(REPO_ROOT, data_repo)

    # Load env
    env = _load_env(os.path.join(REPO_ROOT, "graph-editor", ".env.local"))
    db_connection = env.get("DB_CONNECTION", "")
    if not db_connection:
        print("ERROR: No DB_CONNECTION in graph-editor/.env.local")
        sys.exit(1)

    # Load graph
    graph_path = os.path.join(data_repo_path, "graphs", "bayes-test-gm-rebuild.json")
    if not os.path.isfile(graph_path):
        print(f"ERROR: Graph not found: {graph_path}")
        sys.exit(1)
    with open(graph_path) as f:
        graph = json.load(f)
    print(f"Graph: {len(graph.get('edges', []))} edges")

    # Load param files
    import yaml
    param_files = {}
    params_dir = os.path.join(data_repo_path, "parameters")
    for fname in os.listdir(params_dir):
        if fname.endswith(".yaml") and "index" not in fname:
            with open(os.path.join(params_dir, fname)) as f:
                param_id = fname.replace(".yaml", "")
                param_files[f"parameter-{param_id}"] = yaml.safe_load(f)
    print(f"Param files: {list(param_files.keys())}")

    # Build snapshot subjects: 4 edges × 2 slices (window + cohort) = 8 subjects.
    # Each slice type has a different core_hash because the FE computes
    # core_hash from the canonical_signature which includes the DSL.
    _edges = [
        ("bayes-test-create-to-delegated",      "c64ddc4d-c369-4ae8-a44a-398a63a46ab1", "UaWTiPJp1kTXTlkigKzBAQ", "1npRXxdOjD56XTgKnZKbsw"),
        ("bayes-test-delegated-to-registered",   "7bb83fbf-3ac6-4152-a395-a8b64a12506a", "ES2r-ClxqBl4VQQqYdfYYg", "YSX41CZhnZKsP49i80jjTg"),
        ("bayes-test-landing-to-created",        "b91c2820-7a1d-4498-9082-5967b5027d76", "SXVK13yfsOIpXc4RQSv2GA", "yHCQevqcdyITym82h-uwdQ"),
        ("bayes-test-registered-to-success",     "97b11265-1242-4fa8-a097-359f2384665a", "VTgXES1p_XdQoHMZ7VsEoA", "XiDhZpbnp535eBHiPu614w"),
    ]
    snapshot_subjects = []
    for param_id, edge_id, window_hash, cohort_hash in _edges:
        base = {
            "param_id": param_id,
            "edge_id": edge_id,
            "equivalent_hashes": [],
            "slice_keys": [""],
            "anchor_from": "2025-11-19",
            "anchor_to": "2026-03-19",
            "sweep_from": "2025-11-19",
            "sweep_to": "2026-03-19",
        }
        snapshot_subjects.append({**base, "core_hash": window_hash})
        snapshot_subjects.append({**base, "core_hash": cohort_hash})
    print(f"Snapshot subjects: {len(snapshot_subjects)} (4 edges × 2 slices)")

    payload = {
        "graph_id": "graph-bayes-test-gm-rebuild",
        "graph_snapshot": graph,
        "parameter_files": param_files,
        "parameters_index": {},
        "snapshot_subjects": snapshot_subjects,
        "db_connection": db_connection,
        "webhook_url": "" if args.no_webhook else "http://localhost:5173/api/bayes-webhook",
        "callback_token": "test-harness",
        "settings": {"placeholder": True} if args.placeholder else {},
        "_job_id": f"harness-{int(time.time())}",
    }

    if args.curl:
        payload_path = "/tmp/bayes-test-payload.json"
        with open(payload_path, "w") as f:
            json.dump(payload, f, cls=DateEncoder)
        print(f"\nPayload written to {payload_path} ({os.path.getsize(payload_path)} bytes)")
        print(f"\nSubmit:")
        print(f'  curl -s -X POST http://localhost:9000/api/bayes/submit -H "Content-Type: application/json" -d @{payload_path}')
        print(f"\nPoll:")
        print(f'  curl -s "http://localhost:9000/api/bayes/status?call_id=JOB_ID" | python3 -m json.tool')
        return

    # Run in a background thread with timeout and progress reporting
    import threading
    import signal

    TIMEOUT_S = 180  # 3 minutes hard cap
    t_start = time.time()
    last_stage = ["idle"]
    result_box = [None]
    error_box = [None]

    def on_progress(stage, pct, detail=""):
        elapsed = time.time() - t_start
        last_stage[0] = stage
        print(f"  [{pct:3d}%] {elapsed:6.1f}s  {stage}: {detail}", flush=True)

    def run_worker():
        from worker import fit_graph
        try:
            result_box[0] = fit_graph(payload, report_progress=on_progress)
        except Exception as e:
            import traceback
            error_box[0] = (e, traceback.format_exc())

    print(f"\n{'='*60}")
    print(f"Running fit_graph ({'placeholder' if args.placeholder else 'compiler'})...")
    print(f"Timeout: {TIMEOUT_S}s")
    print(f"{'='*60}\n")

    thread = threading.Thread(target=run_worker, daemon=True)
    thread.start()

    # Poll until done or timeout
    while thread.is_alive():
        thread.join(timeout=5.0)
        if thread.is_alive():
            elapsed = time.time() - t_start
            if elapsed > TIMEOUT_S:
                print(f"\n  TIMEOUT after {elapsed:.0f}s (last stage: {last_stage[0]})")
                sys.exit(1)
            # Heartbeat — show we're alive
            print(f"  ... {elapsed:.0f}s elapsed, stage: {last_stage[0]}", flush=True)

    if error_box[0]:
        e, tb = error_box[0]
        print(f"\nCRASHED after {time.time() - t_start:.1f}s: {e}")
        print(tb)
        sys.exit(1)

    result = result_box[0]
    if not result:
        print(f"\nNo result returned after {time.time() - t_start:.1f}s")
        sys.exit(1)

    # Print results
    print(f"\n{'='*60}")
    print("RESULT LOG")
    print(f"{'='*60}")
    for line in result.get("log", []):
        print(f"  {line}")

    print(f"\nStatus:      {result.get('status')}")
    print(f"Edges fitted: {result.get('edges_fitted')}")
    print(f"Duration:    {result.get('duration_ms')}ms")

    quality = result.get("quality", {})
    print(f"Quality:     rhat={quality.get('max_rhat')}, ess={quality.get('min_ess')}, converged={quality.get('converged_pct')}%")

    if result.get("error"):
        print(f"Error:       {result['error']}")

    # Print posterior summaries
    webhook_resp = result.get("webhook_response")
    if webhook_resp:
        print(f"\nWebhook:     {webhook_resp.get('status')}")

    timings = result.get("timings", {})
    if timings:
        print(f"\nTimings:")
        for k, v in timings.items():
            print(f"  {k}: {v}ms")

    print(f"\n{'='*60}")
    if result.get("status") == "complete" or result.get("edges_fitted", 0) > 0:
        print("PASS")
    else:
        print("FAIL")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
