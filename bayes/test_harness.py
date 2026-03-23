#!/usr/bin/env python3
"""
Bayes test harness — runs fit_graph directly with full logging.

Usage:
    cd dagnet
    . graph-editor/venv/bin/activate
    python bayes/test_harness.py [--placeholder] [--no-webhook]

Reads the test graph from the data repo, builds snapshot subjects,
runs the compiler, and prints the full log. No browser needed.

IMPORTANT: This runs fit_graph in-process, NOT via the dev server.
Do NOT run this while the dev server is processing a Bayes job.
Only one instance at a time — the harness enforces this via a
lock file.
"""

import sys
import os
import json
import time
import argparse
import atexit
import signal
from datetime import datetime, date

LOCK_FILE = "/tmp/bayes-harness.lock"


def _acquire_lock():
    """Ensure only one harness runs at a time. Kills any existing run."""
    if os.path.exists(LOCK_FILE):
        try:
            with open(LOCK_FILE) as f:
                old_pid = int(f.read().strip())
            # Kill the old process and its children
            os.kill(old_pid, 0)  # check alive
            print(f"Killing previous harness (PID {old_pid})…")
            import subprocess
            subprocess.run(["pkill", "-P", str(old_pid)], capture_output=True)
            try:
                os.kill(old_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            import time
            time.sleep(0.5)
            print(f"  Previous run killed.")
        except (ProcessLookupError, ValueError):
            pass  # stale lock
        try:
            os.remove(LOCK_FILE)
        except FileNotFoundError:
            pass

    with open(LOCK_FILE, "w") as f:
        f.write(str(os.getpid()))

    def _release_lock(*_args):
        try:
            os.remove(LOCK_FILE)
        except FileNotFoundError:
            pass

    atexit.register(_release_lock)
    signal.signal(signal.SIGTERM, lambda *a: (_release_lock(), sys.exit(1)))
    signal.signal(signal.SIGINT, lambda *a: (_release_lock(), sys.exit(1)))

# Paths
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "graph-editor", "lib"))
sys.path.insert(0, os.path.join(REPO_ROOT, "graph-editor"))
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
    _acquire_lock()

    parser = argparse.ArgumentParser(description="Bayes test harness")
    parser.add_argument("--placeholder", action="store_true", help="Use placeholder mode (skip MCMC)")
    parser.add_argument("--no-webhook", action="store_true", help="Skip webhook call")
    parser.add_argument("--curl", action="store_true", help="Generate curl command instead of running directly")
    parser.add_argument("--timeout", type=int, default=600, help="Hard timeout in seconds (default: 600)")
    parser.add_argument("--graph", default="simple",
                        help="Graph name (without .json) or shortcut: "
                             "simple=bayes-test-gm-rebuild, branch=conversion-flow-v2-recs-collapsed. "
                             "Any graph file in the data repo's graphs/ dir works.")
    parser.add_argument("--warmstart", action="store_true",
                        help="Two-pass: run once, feed posteriors back as priors, run again")
    args = parser.parse_args()

    conf = _read_private_repos_conf()
    data_repo = conf.get("DATA_REPO_DIR", "")
    if not data_repo:
        print("ERROR: DATA_REPO_DIR not set in .private-repos.conf")
        sys.exit(1)
    data_repo_path = os.path.join(REPO_ROOT, data_repo)

    # Load env
    env = _load_env(os.path.join(REPO_ROOT, "graph-editor", ".env.local"))
    db_connection = env.get("DB_CONNECTION", "")
    if not db_connection:
        print("ERROR: No DB_CONNECTION in graph-editor/.env.local")
        sys.exit(1)

    # --- Resolve graph file ---
    # Shortcuts for common graphs; otherwise treat as a graph filename
    GRAPH_SHORTCUTS = {
        "simple": "bayes-test-gm-rebuild",
        "branch": "conversion-flow-v2-recs-collapsed",
    }
    graph_name = GRAPH_SHORTCUTS.get(args.graph, args.graph)
    graph_file = f"{graph_name}.json"
    graph_path = os.path.join(data_repo_path, "graphs", graph_file)
    if not os.path.isfile(graph_path):
        print(f"ERROR: Graph not found: {graph_path}")
        sys.exit(1)
    with open(graph_path) as f:
        graph = json.load(f)
    graph_id = f"graph-{graph_name}"
    print(f"Graph [{graph_name}]: {len(graph.get('edges', []))} edges")

    # --- Compute edge hashes and snapshot subjects via Node.js ---
    # Uses the real FE hash computation (compute_snapshot_subjects.mjs)
    # to guarantee hash parity with the FE runtime.
    import subprocess
    node_script = os.path.join(REPO_ROOT, "bayes", "compute_snapshot_subjects.mjs")
    nvm_prefix = (
        f'export NVM_DIR="$HOME/.nvm" && '
        f'. "$NVM_DIR/nvm.sh" 2>/dev/null && '
        f'cd {os.path.join(REPO_ROOT, "graph-editor")} && '
        f'nvm use "$(cat .nvmrc)" 2>/dev/null && '
    )
    node_cmd = f'{nvm_prefix}node {node_script} {graph_path}'
    node_result = subprocess.run(
        node_cmd, shell=True, capture_output=True, text=True, timeout=30,
    )
    if node_result.returncode != 0:
        print(f"ERROR: compute_snapshot_subjects.mjs failed:\n{node_result.stderr}")
        sys.exit(1)
    # Parse JSON output (skip any nvm/node version lines before the JSON)
    node_stdout = node_result.stdout
    json_start = node_stdout.index("{")
    fe_data = json.loads(node_stdout[json_start:])

    _edges = [(e["param_id"], e["edge_uuid"], e["window_hash"], e["cohort_hash"])
              for e in fe_data["edges"]]
    print(f"  Resolved {len(_edges)} edges with hashes (via FE)")

    # Derive anchor date range from pinnedDSL or dataInterestsDSL
    import re
    _dsl = graph.get("pinnedDSL", "") or graph.get("dataInterestsDSL", "")
    _date_match = re.search(r"(\d{1,2}-\w{3}-\d{2}):(\d{1,2}-\w{3}-\d{2})", _dsl)
    if _date_match:
        from datetime import datetime
        _from_dt = datetime.strptime(_date_match.group(1), "%d-%b-%y")
        _to_dt = datetime.strptime(_date_match.group(2), "%d-%b-%y")
        anchor_from = _from_dt.strftime("%Y-%m-%d")
        anchor_to = _to_dt.strftime("%Y-%m-%d")
    else:
        # Default: last 120 days
        anchor_to = date.today().isoformat()
        anchor_from = (date.today() - __import__("datetime").timedelta(days=120)).isoformat()
    print(f"  Anchor range: {anchor_from} → {anchor_to}")

    # Load param files
    import yaml
    param_files = {}
    params_dir = os.path.join(data_repo_path, "parameters")
    for fname in os.listdir(params_dir):
        if fname.endswith(".yaml") and "index" not in fname:
            with open(os.path.join(params_dir, fname)) as f:
                param_id = fname.replace(".yaml", "")
                param_files[f"parameter-{param_id}"] = yaml.safe_load(f)

    # --- Run stats pass: derive mu/sigma/onset/t95 from param file lag data ---
    sys.path.insert(0, os.path.join(REPO_ROOT, "graph-editor", "lib"))
    from stats_enhancement import compute_stats_pass
    graph = compute_stats_pass(graph, param_files)
    # Count how many edges got latency priors
    n_lat = sum(1 for e in graph.get("edges", [])
                if e.get("p", {}).get("latency", {}).get("mu") is not None)
    print(f"  Stats pass: {n_lat} edges with latency priors")

    # Use equivalent_hashes from the Node.js output (already resolved)
    equiv_map: dict[str, list[dict]] = {}
    for subj in fe_data.get("subjects", []):
        ch = subj.get("core_hash", "")
        eh = subj.get("equivalent_hashes", [])
        if ch and eh:
            equiv_map[ch] = eh

    # Build snapshot subjects matching the FE SnapshotSubjectPayload contract
    snapshot_subjects = []
    for param_id, edge_id, window_hash, cohort_hash in _edges:
        base = {
            "param_id": param_id,
            "subject_id": f"parameter:{param_id}:{edge_id}:p:",
            "canonical_signature": "",
            "read_mode": "sweep_simple",
            "target": {"targetId": edge_id},
            "edge_id": edge_id,
            "slice_keys": [""],
            "anchor_from": anchor_from,
            "anchor_to": anchor_to,
            "sweep_from": anchor_from,
            "sweep_to": anchor_to,
        }
        snapshot_subjects.append({
            **base,
            "core_hash": window_hash,
            "equivalent_hashes": equiv_map.get(window_hash, []),
        })
        snapshot_subjects.append({
            **base,
            "core_hash": cohort_hash,
            "equivalent_hashes": equiv_map.get(cohort_hash, []),
        })
    print(f"Snapshot subjects: {len(snapshot_subjects)} ({len(_edges)} edges × 2 slices)")

    payload = {
        "graph_id": graph_id,
        "graph_snapshot": graph,
        "parameter_files": param_files,
        "parameters_index": {},
        "snapshot_subjects": snapshot_subjects,
        "db_connection": db_connection,
        "webhook_url": "" if args.no_webhook else "http://localhost:5173/api/bayes-webhook",
        "callback_token": "test-harness",
        "settings": {
            **({"placeholder": True} if args.placeholder else {}),
        },
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

    # Run in a background thread with timeout and progress reporting.
    # All output goes to both stdout and a log file for tailing.
    import threading
    import signal

    LOG_PATH = "/tmp/bayes_harness.log"
    log_file = open(LOG_PATH, "w")

    def _print(msg="", **kwargs):
        """Print to both stdout and log file."""
        print(msg, flush=True, **kwargs)
        log_file.write(msg + "\n")
        log_file.flush()

    _print(f"Log file: {LOG_PATH}")
    _print(f"  tail -f {LOG_PATH}")

    TIMEOUT_S = args.timeout
    t_start = time.time()
    last_stage = ["idle"]
    result_box = [None]
    error_box = [None]

    def on_progress(stage, pct, detail=""):
        elapsed = time.time() - t_start
        last_stage[0] = stage
        _print(f"  [{pct:3d}%] {elapsed:6.1f}s  {stage}: {detail}")

    def _run_once(run_payload, label=""):
        """Run fit_graph in a background thread with timeout. Returns result or exits."""
        result_box[0] = None
        error_box[0] = None
        t_start_run = time.time()

        def _worker():
            from worker import fit_graph
            try:
                result_box[0] = fit_graph(run_payload, report_progress=on_progress)
            except Exception as e:
                import traceback
                error_box[0] = (e, traceback.format_exc())

        _print(f"\n{'='*60}")
        _print(f"Running fit_graph [{args.graph}]{' — ' + label if label else ''} "
               f"({'placeholder' if args.placeholder else 'compiler'})...")
        _print(f"Timeout: {TIMEOUT_S}s")
        _print(f"{'='*60}\n")

        thread = threading.Thread(target=_worker, daemon=True)
        thread.start()

        while thread.is_alive():
            thread.join(timeout=5.0)
            if thread.is_alive():
                elapsed = time.time() - t_start_run
                if elapsed > TIMEOUT_S:
                    _print(f"\n  TIMEOUT after {elapsed:.0f}s (last stage: {last_stage[0]})")
                    import subprocess
                    subprocess.run(["pkill", "-P", str(os.getpid())], capture_output=True)
                    log_file.close()
                    sys.exit(1)
                _print(f"  ... {elapsed:.0f}s elapsed, stage: {last_stage[0]}")

        if error_box[0]:
            e, tb = error_box[0]
            _print(f"\nCRASHED after {time.time() - t_start_run:.1f}s: {e}")
            _print(tb)
            log_file.close()
            sys.exit(1)

        if not result_box[0]:
            _print(f"\nNo result returned after {time.time() - t_start_run:.1f}s")
            log_file.close()
            sys.exit(1)

        return result_box[0]

    def _patch_graph_with_posteriors(graph_snapshot, result):
        """Write fitted latency posteriors back onto graph edges as priors for next run."""
        import copy
        patched = copy.deepcopy(graph_snapshot)
        edges_by_uuid = {e["uuid"]: e for e in patched.get("edges", [])}

        webhook_edges = result.get("webhook_payload_edges", [])
        patched_count = 0
        for we in webhook_edges:
            eid = we.get("edge_id", "")
            lat = we.get("latency")
            if not lat or not eid:
                continue
            edge = edges_by_uuid.get(eid)
            if not edge:
                continue
            p_block = edge.get("p") or {}
            latency_block = p_block.get("latency") or {}
            # Write fitted mu/sigma as the latency block's mu/sigma
            # (topology.py reads these in the second fallback)
            if lat.get("mu_mean") is not None:
                latency_block["mu"] = lat["mu_mean"]
            if lat.get("sigma_mean") is not None:
                latency_block["sigma"] = lat["sigma_mean"]
            if lat.get("onset_delta_days") is not None:
                latency_block["onset_delta_days"] = lat["onset_delta_days"]
            # Path-level too
            if lat.get("path_mu_mean") is not None:
                latency_block["path_mu"] = lat["path_mu_mean"]
            if lat.get("path_sigma_mean") is not None:
                latency_block["path_sigma"] = lat["path_sigma_mean"]
            p_block["latency"] = latency_block
            edge["p"] = p_block
            patched_count += 1

        _print(f"\n  Warm-start: patched {patched_count} edges with posteriors as priors")
        return patched

    # --- Run ---
    result = _run_once(payload, label="pass 1" if args.warmstart else "")

    if args.warmstart:
        quality = result.get("quality", {})
        _print(f"\n  Pass 1 quality: rhat={quality.get('max_rhat')}, "
               f"ess={quality.get('min_ess')}, div={quality.get('total_divergences')}")

        patched_graph = _patch_graph_with_posteriors(payload["graph_snapshot"], result)
        payload2 = {**payload, "graph_snapshot": patched_graph,
                    "_job_id": f"harness-warmstart-{int(time.time())}"}
        result = _run_once(payload2, label="pass 2 (warm-started)")

    # Print results
    _print(f"\n{'='*60}")
    _print("RESULT LOG")
    _print(f"{'='*60}")
    for line in result.get("log", []):
        _print(f"  {line}")

    _print(f"\nStatus:      {result.get('status')}")
    _print(f"Edges fitted: {result.get('edges_fitted')}")
    _print(f"Duration:    {result.get('duration_ms')}ms")

    quality = result.get("quality", {})
    _print(f"Quality:     rhat={quality.get('max_rhat')}, ess={quality.get('min_ess')}, converged={quality.get('converged_pct')}%")

    if result.get("error"):
        _print(f"Error:       {result['error']}")

    webhook_resp = result.get("webhook_response")
    if webhook_resp:
        _print(f"\nWebhook:     {webhook_resp.get('status')}")

    timings = result.get("timings", {})
    if timings:
        _print(f"\nTimings:")
        for k, v in timings.items():
            _print(f"  {k}: {v}ms")

    _print(f"\n{'='*60}")
    if result.get("status") == "complete" or result.get("edges_fitted", 0) > 0:
        _print("PASS")
    else:
        _print("FAIL")
    _print(f"{'='*60}")

    log_file.close()


if __name__ == "__main__":
    main()
