#!/usr/bin/env python3
"""
Bayes test harness — runs fit_graph directly with full logging.

Usage:
    cd dagnet
    . graph-editor/venv/bin/activate
    python bayes/test_harness.py --graph synth-mirror-4step --no-webhook

    # Pre-flight only (verify data, no MCMC — takes <10s):
    python bayes/test_harness.py --graph synth-mirror-4step --preflight-only

Reads the test graph from the data repo, computes FE-authoritative hashes,
runs a stats pass, verifies DB data, binds evidence, and optionally runs
the compiler. Fails fast if any stage is broken.

IMPORTANT: This runs fit_graph in-process, NOT via the dev server.
Do NOT run this while the dev server is processing a Bayes job.
Only one instance at a time — the harness enforces this via a lock file.
"""

import sys
import os

# Prevent stale .pyc from masking source edits during development.
sys.dont_write_bytecode = True

import json
import time
import argparse
import atexit
import signal
import subprocess
import re
import yaml
from datetime import datetime, date, timedelta
from typing import Any

LOCK_FILE_PREFIX = "/tmp/bayes-harness"
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Ensure lib paths are available
sys.path.insert(0, os.path.join(REPO_ROOT, "graph-editor", "lib"))
sys.path.insert(0, os.path.join(REPO_ROOT, "graph-editor"))
sys.path.insert(0, os.path.join(REPO_ROOT, "bayes"))


# ---------------------------------------------------------------------------
# Lock management
# ---------------------------------------------------------------------------

def _acquire_lock(graph_name: str = ""):
    """Ensure only one harness runs per graph. Kills any existing run for the same graph.

    Uses per-graph lock files so different graphs can run in parallel
    (e.g. for parallel param recovery tests).
    """
    suffix = f"-{graph_name}" if graph_name else ""
    lock_file = f"{LOCK_FILE_PREFIX}{suffix}.lock"

    if os.path.exists(lock_file):
        try:
            with open(lock_file) as f:
                old_pid = int(f.read().strip())
            os.kill(old_pid, 0)
            print(f"Killing previous harness for '{graph_name or 'default'}' (PID {old_pid})…")
            subprocess.run(["pkill", "-P", str(old_pid)], capture_output=True)
            try:
                os.kill(old_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            time.sleep(0.5)
        except (ProcessLookupError, ValueError):
            pass
        try:
            os.remove(lock_file)
        except FileNotFoundError:
            pass

    with open(lock_file, "w") as f:
        f.write(str(os.getpid()))

    def _release_lock(*_args):
        try:
            os.remove(lock_file)
        except FileNotFoundError:
            pass

    atexit.register(_release_lock)
    signal.signal(signal.SIGTERM, lambda *a: (_release_lock(), sys.exit(1)))
    signal.signal(signal.SIGINT, lambda *a: (_release_lock(), sys.exit(1)))


# ---------------------------------------------------------------------------
# Config loading
# ---------------------------------------------------------------------------

def _read_private_repos_conf() -> dict:
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


def _load_env(path: str) -> dict:
    env = {}
    if not os.path.isfile(path):
        return env
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            eq = line.find("=")
            if eq >= 0:
                env[line[:eq]] = line[eq + 1:]
    return env


def _build_payload_via_cli(graph_name: str, graph_dir: str | None = None) -> dict:
    """Call the FE CLI to build payload via the FE service layer.

    When graph_dir is None, uses bayes.sh which resolves the data repo
    automatically. When graph_dir is given (e.g. for synth graphs in
    nous-conversion/), calls the tsx CLI directly with --graph <dir>.
    Returns the parsed payload dict.
    """
    if graph_dir:
        # Direct tsx invocation for non-data-repo graphs (synth, etc.)
        nvm_prefix = (
            f'export NVM_DIR="${{NVM_DIR:-$HOME/.nvm}}" && '
            f'. "$NVM_DIR/nvm.sh" 2>/dev/null; '
            f'cd {os.path.join(REPO_ROOT, "graph-editor")} && '
            f'nvm use "$(cat .nvmrc)" 2>/dev/null; '
        )
        tsx_cmd = (
            f'{nvm_prefix}'
            f'npx tsx src/cli/bayes.ts '
            f'--graph {graph_dir} --name {graph_name} --format json --no-cache'
        )
        cmd = ["bash", "-c", tsx_cmd]
    else:
        script = os.path.join(REPO_ROOT, "graph-ops", "scripts", "bayes.sh")
        if not os.path.isfile(script):
            print(f"ERROR: bayes.sh not found: {script}")
            sys.exit(1)
        cmd = ["bash", script, graph_name, "--format", "json"]

    print(f"Building payload via CLI: {' '.join(cmd)}")
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=120,
            cwd=REPO_ROOT,
        )
    except subprocess.TimeoutExpired:
        print("ERROR: CLI payload construction timed out (120s)")
        sys.exit(1)

    if result.returncode != 0:
        print(f"ERROR: CLI failed (exit {result.returncode})")
        if result.stderr:
            print(result.stderr[-2000:])
        sys.exit(1)

    # The CLI writes payload JSON to stdout. Log lines may precede it
    # (from nvm, bootstrap, etc.) — find the JSON object.
    stdout = result.stdout
    json_start = stdout.find('{')
    if json_start < 0:
        print("ERROR: No JSON in CLI output")
        print(stdout[-2000:])
        sys.exit(1)

    try:
        payload = json.loads(stdout[json_start:])
    except json.JSONDecodeError as e:
        print(f"ERROR: Could not parse CLI output as JSON: {e}")
        print(stdout[-2000:])
        sys.exit(1)

    print(f"  CLI payload: {len(payload.get('snapshot_subjects', []))} subjects, "
          f"{len(payload.get('parameter_files', {}))} param files")
    return payload


def _load_settings_json(path: str) -> dict:
    """Load extra settings from a JSON file."""
    if not path or not os.path.isfile(path):
        return {}
    with open(path) as f:
        return json.load(f)



def _load_truth_file(graph_path: str) -> dict:
    """Load .truth.yaml sidecar if it exists."""
    truth_path = graph_path.replace(".json", ".truth.yaml")
    if os.path.isfile(truth_path):
        with open(truth_path) as f:
            return yaml.safe_load(f) or {}
    return {}


class DateEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, (datetime, date)):
            return obj.isoformat()
        return super().default(obj)


# ---------------------------------------------------------------------------
# Node.js hash computation
# ---------------------------------------------------------------------------

def _compute_fe_hashes(graph_path: str) -> dict:
    """Call compute_snapshot_subjects.mjs and return parsed JSON.

    Returns dict with 'edges' and 'subjects' lists.
    Exits with error if the Node.js script fails.
    """
    node_script = os.path.join(REPO_ROOT, "bayes", "compute_snapshot_subjects.mjs")
    ge_dir = os.path.join(REPO_ROOT, "graph-editor")
    nvm_prefix = (
        f'export NVM_DIR="$HOME/.nvm" && '
        f'. "$NVM_DIR/nvm.sh" 2>/dev/null && '
        f'cd {ge_dir} && '
        f'nvm use "$(cat .nvmrc)" 2>/dev/null && '
    )
    cmd = f'{nvm_prefix}node {node_script} {graph_path}'
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        print(f"ERROR: compute_snapshot_subjects.mjs failed:")
        print(f"  {result.stderr[:500]}")
        sys.exit(1)

    stdout = result.stdout
    try:
        json_start = stdout.index("{")
        return json.loads(stdout[json_start:])
    except (ValueError, json.JSONDecodeError) as e:
        print(f"ERROR: Failed to parse Node.js output: {e}")
        print(f"  stdout: {stdout[:500]}")
        sys.exit(1)


# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

def _run_preflight(
    snapshot_subjects: list[dict],
    db_connection: str,
    graph: dict,
    param_files: dict,
    _edges: list[tuple],
) -> dict:
    """Verify DB data, bind evidence, and summarise model structure.

    Returns dict with preflight results. Exits with error if critical
    checks fail.
    """
    import psycopg2
    from compiler.topology import analyse_topology
    from compiler.evidence import bind_snapshot_evidence
    from worker import _query_snapshot_subjects

    results = {"db_ok": True, "evidence_ok": True, "warnings": []}

    # 1. DB connectivity
    print("\n── Pre-flight: DB connectivity ──")
    try:
        conn = psycopg2.connect(db_connection)
        conn.cursor().execute("SELECT 1")
        conn.close()
        print("  PASS: DB connected")
    except Exception as e:
        print(f"  FAIL: DB connection failed: {e}")
        sys.exit(1)

    # 2. Snapshot row counts per subject
    print("\n── Pre-flight: Snapshot DB row counts ──")
    conn = psycopg2.connect(db_connection)
    cur = conn.cursor()
    total_db_rows = 0
    for subj in snapshot_subjects:
        ch = subj.get("core_hash", "")
        pid = subj.get("param_id", "")
        eid = subj.get("edge_id", "")[:8]
        cur.execute("SELECT COUNT(*) FROM snapshots WHERE core_hash = %s", (ch,))
        count = cur.fetchone()[0]
        total_db_rows += count
        status = "PASS" if count > 0 else "FAIL"
        if count == 0:
            results["db_ok"] = False
        print(f"  {status} {pid} ({eid}…) hash={ch[:16]}…: {count} rows")
    conn.close()

    if not results["db_ok"]:
        print("\n  ABORT: Some subjects have 0 rows in DB.")
        print("  The harness will fall back to param files, not snapshot trajectories.")
        print("  Run synth_gen.py --write-files to populate DB, or check hash parity.")
        sys.exit(1)
    print(f"  Total: {total_db_rows} DB rows across {len(snapshot_subjects)} subjects")

    # 3. Evidence binding
    print("\n── Pre-flight: Evidence binding ──")
    topology = analyse_topology(graph)

    # Query DB via the same path the worker uses
    log = []
    snapshot_rows = _query_snapshot_subjects(snapshot_subjects, topology, log)
    for line in log:
        print(f"  {line}")

    total_rows_fetched = sum(len(v) for v in snapshot_rows.values())
    if total_rows_fetched == 0:
        print(f"\n  ABORT: Worker query returned 0 rows despite DB having data.")
        print(f"  This means the worker's query path is broken (param_id / hash mismatch).")
        results["evidence_ok"] = False
        sys.exit(1)

    evidence = bind_snapshot_evidence(topology, snapshot_rows, param_files, today=date.today().strftime("%-d-%b-%y"))

    print("\n── Pre-flight: Evidence summary ──")
    for eid, ev in evidence.edges.items():
        if ev.skipped:
            continue
        n_trajs = sum(len(c.trajectories) for c in ev.cohort_obs)
        n_daily = 0
        for c in ev.cohort_obs:
            if isinstance(c.daily, list):
                n_daily += len(c.daily)
        max_ages = 0
        for c in ev.cohort_obs:
            for t in c.trajectories:
                ages = len(t.retrieval_ages) if hasattr(t.retrieval_ages, '__len__') else 0
                if ages > max_ages:
                    max_ages = ages
        source = "trajectories" if n_trajs > 0 else "daily"
        print(f"  {eid[:12]}… {ev.param_id}: {n_trajs} trajs (max {max_ages} ages), {n_daily} daily, total_n={ev.total_n}")
        if n_trajs == 0 and n_daily > 0:
            results["warnings"].append(f"{ev.param_id}: using daily fallback, not trajectories")

    if results["warnings"]:
        print("\n  WARNINGS:")
        for w in results["warnings"]:
            print(f"    ⚠ {w}")

    return results


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Bayes test harness")
    parser.add_argument("--placeholder", action="store_true", help="Use placeholder mode (skip MCMC)")
    parser.add_argument("--no-webhook", action="store_true", help="Skip webhook call")
    parser.add_argument("--curl", action="store_true", help="Generate curl command instead of running directly")
    parser.add_argument("--timeout", type=int, default=None,
                        help="Hard timeout in seconds (default: from truth file or 600)")
    parser.add_argument("--graph", default="simple",
                        help="Graph name (without .json) or shortcut: "
                             "simple=bayes-test-gm-rebuild, branch=conversion-flow-v2-recs-collapsed. "
                             "Any graph file in the data repo's graphs/ dir works.")
    parser.add_argument("--graph-path", default=None,
                        help="Absolute path to a graph JSON file (overrides --graph). "
                             "Param files still loaded from the data repo unless --params-dir is given.")
    parser.add_argument("--hash-source", default=None,
                        help="Absolute path to graph file used for hash computation (default: same as --graph-path). "
                             "Use this when running a patched graph whose structural hashes must match the original.")
    parser.add_argument("--params-dir", default=None,
                        help="Absolute path to a directory of parameter YAML files (overrides data repo).")
    parser.add_argument("--warmstart", action="store_true",
                        help="Two-pass: run once, feed posteriors back as priors, run again")
    parser.add_argument("--preflight-only", action="store_true",
                        help="Run pre-flight checks only (DB, evidence, model) — no MCMC")
    parser.add_argument("--no-mcmc", action="store_true",
                        help="Stop after model build (inspection always prints). "
                             "Skips MCMC sampling.")
    parser.add_argument("--feature", action="append", default=[],
                        metavar="KEY=VALUE",
                        help="Model feature flag (repeatable). "
                             "e.g. --feature latent_onset=false --feature overdispersion=true. "
                             "Available: latent_latency, cohort_latency, overdispersion, latent_onset")
    parser.add_argument("--draws", type=int, default=None, help="MCMC draws per chain (default: 2000)")
    parser.add_argument("--tune", type=int, default=None, help="MCMC warmup steps per chain (default: 1000)")
    parser.add_argument("--chains", type=int, default=None, help="Number of MCMC chains (default: 4)")
    parser.add_argument("--cores", type=int, default=None, help="Number of cores for sampling (default: chains)")
    parser.add_argument("--asat", type=str, default=None,
                        help="Reproduce a historical run: use graph/params from git as of this date "
                             "(ISO: YYYY-MM-DD) and filter snapshot DB to retrieved_at <= this date")
    parser.add_argument("--settings-json", type=str, default=None, metavar="PATH",
                        help="Path to a JSON file of extra settings to merge into the payload "
                             "(e.g. prior_overrides for sensitivity testing).")
    parser.add_argument("--dump-evidence", type=str, default=None, metavar="PATH",
                        help="Dump full bound evidence to JSON file after evidence binding, then stop. "
                             "Includes every trajectory (n, ages, cumulative_y), daily obs (n, k, completeness), "
                             "priors, and raw snapshot row counts per edge.")
    parser.add_argument("--job-label", type=str, default=None, metavar="LABEL",
                        help="Override the graph name for lock file and log file. "
                             "Enables parallel runs of the same graph (e.g. convergence matrix). "
                             "Lock: /tmp/bayes-harness-{LABEL}.lock, Log: /tmp/bayes_harness-{LABEL}.log")
    parser.add_argument("--payload", type=str, default=None, metavar="PATH",
                        help="Path to a pre-built payload JSON (from CLI --output). "
                             "Skips graph loading, hash computation, and subject construction. "
                             "Uses the real FE service layer codepath for slice commissioning.")
    parser.add_argument("--fe-payload", action="store_true",
                        help="Build payload via CLI on demand (calls dagnet-cli bayes --output). "
                             "Same as --payload but constructs it automatically for --graph. "
                             "Ensures slice commissioning follows the FE codepath.")
    parser.add_argument("--dsl-override", type=str, default=None, metavar="DSL",
                        help="Override the graph's pinnedDSL before payload construction. "
                             "Use to force uncontexted runs on contexted graphs, e.g. "
                             "'window(12-Dec-25:21-Mar-26);cohort(12-Dec-25:21-Mar-26)'")
    parser.add_argument("--clean", action="store_true",
                        help="Clear stale caches before running: (1) delete __pycache__ "
                             "dirs under bayes/ and graph-editor/lib/ so no stale bytecode "
                             "masks source edits, (2) delete .synth-meta.json for the target "
                             "graph so verify_synth_data re-checks DB with fresh hashes.")
    # Keep --clean-pyc as hidden alias for backwards compat
    parser.add_argument("--clean-pyc", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.clean_pyc:
        args.clean = True

    # Clean caches if requested
    if args.clean:
        import shutil
        # 1. Python bytecode
        _pyc_cleaned = 0
        for _root in [os.path.join(REPO_ROOT, "bayes"),
                      os.path.join(REPO_ROOT, "graph-editor", "lib")]:
            for _dp, _dn, _ in os.walk(_root):
                if "__pycache__" in _dn:
                    try:
                        shutil.rmtree(os.path.join(_dp, "__pycache__"))
                        _pyc_cleaned += 1
                    except OSError:
                        pass  # parallel run already deleted it
        # 2. Synth meta sidecar (forces re-check against DB with fresh hashes)
        _meta_cleaned = 0
        if args.graph and args.graph.startswith("synth-"):
            _conf = _read_private_repos_conf()
            _dr = _conf.get("DATA_REPO_DIR", "")
            if _dr:
                _meta = os.path.join(REPO_ROOT, _dr, "graphs", f"{args.graph}.synth-meta.json")
                if os.path.isfile(_meta):
                    os.remove(_meta)
                    _meta_cleaned = 1
        print(f"Cleaned {_pyc_cleaned} __pycache__ dirs, {_meta_cleaned} synth-meta files")

    # NOTE: lock acquisition moved after graph name resolution (below)
    job_label = args.job_label  # If set, overrides graph_name for lock + log file

    # Parse --feature flags into a dict
    feature_flags: dict[str, bool] = {}
    for fstr in args.feature:
        if "=" not in fstr:
            print(f"ERROR: --feature requires KEY=VALUE format, got: {fstr}")
            sys.exit(1)
        k, v = fstr.split("=", 1)
        k = k.strip()
        v_lower = v.strip().lower()
        if v_lower in ("true", "1", "yes"):
            feature_flags[k] = True
        elif v_lower in ("false", "0", "no"):
            feature_flags[k] = False
        else:
            print(f"ERROR: --feature value must be true/false, got: {v}")
            sys.exit(1)
    if feature_flags:
        print(f"Feature flags: {feature_flags}")

    # --- FE payload mode (R2-prereq-ii) ---
    # Use the CLI to construct the payload via the real FE service layer.
    # This ensures slice commissioning (pinnedDSL → explodeDSL → subjects)
    # follows the production codepath. Accepts either:
    #   --payload /path/to/file.json  (pre-built)
    #   --fe-payload                  (call CLI on demand)
    if args.payload or getattr(args, 'fe_payload', False):
        if args.payload:
            payload_path = os.path.abspath(args.payload)
            if not os.path.isfile(payload_path):
                print(f"ERROR: Payload file not found: {payload_path}")
                sys.exit(1)
            with open(payload_path) as f:
                payload = json.load(f)
        else:
            # Call CLI to build payload on demand.
            # If --graph-path was given, derive graph name and directory
            # from the path (e.g. nous-conversion/graphs/synth-foo.json
            # → name="synth-foo", dir="nous-conversion").

            # --dsl-override: temporarily patch the graph JSON's pinnedDSL
            # before CLI construction so subjects are computed from the
            # overridden DSL. Restored after the CLI call.
            _dsl_backup = None
            _graph_json_path = None
            if getattr(args, 'dsl_override', None):
                # Find graph JSON: check nous-conversion/graphs/ first,
                # then fall back to --graph-path.
                _candidates = [
                    os.path.join(REPO_ROOT, "nous-conversion", "graphs", f"{args.graph}.json"),
                ]
                if args.graph_path:
                    _candidates.append(os.path.abspath(args.graph_path))
                for _cp in _candidates:
                    if os.path.isfile(_cp):
                        _graph_json_path = _cp
                        break
                if _graph_json_path and os.path.isfile(_graph_json_path):
                    with open(_graph_json_path) as _gf:
                        _gj = json.load(_gf)
                    _dsl_backup = (_gj.get('pinnedDSL'), _gj.get('dataInterestsDSL'))
                    _gj['pinnedDSL'] = args.dsl_override
                    _gj['dataInterestsDSL'] = args.dsl_override
                    with open(_graph_json_path, 'w') as _gf:
                        json.dump(_gj, _gf, indent=2)
                    print(f"DSL override applied: {args.dsl_override}")

            try:
                if args.graph_path:
                    gp = os.path.abspath(args.graph_path)
                    cli_graph_name = os.path.basename(gp).replace(".json", "")
                    # graph_dir is the parent of "graphs/" — e.g. nous-conversion/
                    graphs_parent = os.path.dirname(gp)  # .../graphs
                    cli_graph_dir = os.path.dirname(graphs_parent)  # .../nous-conversion
                    payload = _build_payload_via_cli(cli_graph_name, cli_graph_dir)
                else:
                    payload = _build_payload_via_cli(args.graph)
            finally:
                # Restore original DSL
                if _dsl_backup is not None and _graph_json_path:
                    with open(_graph_json_path) as _gf:
                        _gj = json.load(_gf)
                    _gj['pinnedDSL'] = _dsl_backup[0]
                    _gj['dataInterestsDSL'] = _dsl_backup[1]
                    with open(_graph_json_path, 'w') as _gf:
                        json.dump(_gj, _gf, indent=2)
                    print("DSL override restored")

        graph_name = payload.get("graph_id", "unknown")
        graph = payload.get("graph_snapshot", {})
        job_label = args.job_label or graph_name
        _acquire_lock(job_label)

        # Merge CLI overrides into payload settings
        settings = payload.setdefault("settings", {})
        if feature_flags:
            settings.setdefault("features", {}).update(feature_flags)
        if args.no_mcmc:
            settings["model_inspect_only"] = True
        if args.dump_evidence:
            settings["dump_evidence_path"] = args.dump_evidence
        if args.no_webhook:
            payload["webhook_url"] = ""
        if args.draws:
            settings["draws"] = args.draws
        if args.tune:
            settings["tune"] = args.tune
        if args.chains:
            settings["chains"] = args.chains
        if args.cores:
            settings["cores"] = args.cores

        # Ensure DB_CONNECTION is set
        db_connection = payload.get("db_connection", "")
        if not db_connection:
            env = _load_env(os.path.join(REPO_ROOT, "graph-editor", ".env.local"))
            db_connection = env.get("DB_CONNECTION", "")
            payload["db_connection"] = db_connection
        if db_connection:
            os.environ["DB_CONNECTION"] = db_connection

        param_files = payload.get("parameter_files", {})
        n_subjects = len(payload.get("snapshot_subjects", []))
        n_params = len(param_files)
        print(f"\n{'=' * 60}")
        print(f"  FE PAYLOAD MODE: {graph_name}")
        print(f"  {n_subjects} snapshot subjects, {n_params} param files")
        print(f"{'=' * 60}\n")

        # Resolve graph_path for truth file loading + param recovery
        if args.graph_path:
            graph_path = os.path.abspath(args.graph_path)
        else:
            # Derive from data repo
            conf = _read_private_repos_conf()
            data_repo_dir = conf.get("DATA_REPO_DIR", "")
            graph_path = os.path.join(REPO_ROOT, data_repo_dir, "graphs", f"{graph_name}.json")
        truth = _load_truth_file(graph_path)

        expected_sample_s = args.timeout or truth.get("simulation", {}).get("expected_sample_seconds", 600)
        if args.timeout:
            timeout_s = args.timeout
        else:
            timeout_s = max(expected_sample_s * 3, 120)
    else:
        conf = _read_private_repos_conf()
        data_repo_dir = conf.get("DATA_REPO_DIR", "")
        if not data_repo_dir:
            print("ERROR: DATA_REPO_DIR not set in .private-repos.conf")
            sys.exit(1)
        data_repo_path = os.path.join(REPO_ROOT, data_repo_dir)

        env = _load_env(os.path.join(REPO_ROOT, "graph-editor", ".env.local"))
        db_connection = env.get("DB_CONNECTION", "")
        if not db_connection:
            print("ERROR: No DB_CONNECTION in graph-editor/.env.local")
            sys.exit(1)
        # Set in environment so snapshot_service and worker can find it
        os.environ["DB_CONNECTION"] = db_connection

        # --- Resolve asat date ---
        asat_date = None
        if args.asat:
            asat_date = datetime.strptime(args.asat, "%Y-%m-%d").date()
            print(f"ASAT mode: reproducing run as of {asat_date}")

        # --- Resolve graph file ---
        GRAPH_SHORTCUTS = {
            "simple": "bayes-test-gm-rebuild",
            "branch": "conversion-flow-v2-recs-collapsed",
        }

        if args.graph_path:
            # Absolute path mode — bypass data repo lookup
            graph_path = os.path.abspath(args.graph_path)
            if not os.path.isfile(graph_path):
                print(f"ERROR: Graph not found: {graph_path}")
                sys.exit(1)
            graph_name = os.path.basename(graph_path).replace(".json", "")
            _acquire_lock(job_label or graph_name)
            with open(graph_path) as f:
                graph = json.load(f)
            graph_file = os.path.basename(graph_path)
            if asat_date:
                print("WARNING: --asat is ignored when --graph-path is used")
                asat_date = None
        elif asat_date:
            graph_name = GRAPH_SHORTCUTS.get(args.graph, args.graph)
            _acquire_lock(job_label or graph_name)
            graph_file = f"{graph_name}.json"
            # Load graph from git at the asat date
            import subprocess as _sp
            asat_iso = asat_date.isoformat()
            # Find the last commit on or before asat_date in the data repo
            git_rev = _sp.run(
                ["git", "log", "--before", f"{asat_iso}T23:59:59", "--format=%H", "-1"],
                capture_output=True, text=True, cwd=data_repo_path,
            ).stdout.strip()
            if not git_rev:
                print(f"ERROR: No git commit found before {asat_iso} in data repo")
                sys.exit(1)
            print(f"  Git rev: {git_rev[:12]}… (data repo at {asat_iso})")

            # Load graph JSON from that commit
            graph_json_str = _sp.run(
                ["git", "show", f"{git_rev}:graphs/{graph_file}"],
                capture_output=True, text=True, cwd=data_repo_path,
            ).stdout
            if not graph_json_str:
                print(f"ERROR: graphs/{graph_file} not found at {git_rev[:12]}")
                sys.exit(1)
            graph = json.loads(graph_json_str)

            # Load param files from that commit
            param_files_asat = {}
            params_dir_listing = _sp.run(
                ["git", "ls-tree", "--name-only", f"{git_rev}:parameters/"],
                capture_output=True, text=True, cwd=data_repo_path,
            ).stdout.strip().split("\n")
            for fname in params_dir_listing:
                if fname.endswith(".yaml") and "index" not in fname:
                    content = _sp.run(
                        ["git", "show", f"{git_rev}:parameters/{fname}"],
                        capture_output=True, text=True, cwd=data_repo_path,
                    ).stdout
                    if content:
                        param_id = fname.replace(".yaml", "")
                        param_files_asat[f"parameter-{param_id}"] = yaml.safe_load(content)
            print(f"  Loaded {len(param_files_asat)} param files from git at {asat_iso}")
            graph_path = os.path.join(data_repo_path, "graphs", graph_file)  # still needed for hash computation
        else:
            graph_name = GRAPH_SHORTCUTS.get(args.graph, args.graph)
            _acquire_lock(job_label or graph_name)
            graph_file = f"{graph_name}.json"
            graph_path = os.path.join(data_repo_path, "graphs", graph_file)
            if not os.path.isfile(graph_path):
                print(f"ERROR: Graph not found: {graph_path}")
                sys.exit(1)
            with open(graph_path) as f:
                graph = json.load(f)
        graph_id = f"graph-{graph_name}"
        print(f"Graph [{graph_name}]: {len(graph.get('edges', []))} edges")

        # --- Load truth file (for expected_sample_seconds) ---
        truth = _load_truth_file(graph_path)
        expected_sample_s = truth.get("simulation", {}).get("expected_sample_seconds", 300)

        # --- Timeout: from CLI, truth file, or default ---
        if args.timeout is not None:
            timeout_s = args.timeout
        else:
            timeout_s = max(expected_sample_s * 3, 120)  # 3x expected or at least 2 min
        print(f"  Timeout: {timeout_s}s (expected sampling: {expected_sample_s}s)")

        # --- Synth data gate: verify DB has rows, bootstrap if needed ---
        if graph_name.startswith("synth-"):
            from synth_gen import verify_synth_data
            _vsd = verify_synth_data(graph_name, data_repo_path)
            if _vsd["status"] in ("missing", "stale"):
                print(f"\n── Synth data gate: {_vsd['status']} ({_vsd['reason']}) ──")
                print(f"  Bootstrapping {graph_name} via synth_gen.py --write-files...")
                import subprocess as _sp
                _boot = _sp.run(
                    [sys.executable, os.path.join(REPO_ROOT, "bayes", "synth_gen.py"),
                     "--graph", graph_name, "--write-files"],
                    capture_output=False, text=True, timeout=600, cwd=REPO_ROOT,
                )
                if _boot.returncode != 0:
                    print(f"  ABORT: Bootstrap failed (exit {_boot.returncode})")
                    sys.exit(1)
                # Re-verify after bootstrap
                _vsd2 = verify_synth_data(graph_name, data_repo_path)
                if _vsd2["status"] != "fresh":
                    print(f"  ABORT: Still {_vsd2['status']} after bootstrap ({_vsd2['reason']})")
                    sys.exit(1)
                print(f"  Bootstrap OK: {_vsd2['row_count']} rows verified")
                # Reload graph JSON — bootstrap may have regenerated it
                with open(graph_path) as f:
                    graph = json.load(f)
            else:
                print(f"\n── Synth data gate: {_vsd['status']} ({_vsd['reason']}) ──")

        # --- Compute FE-authoritative hashes via Node.js ---
        print("\n── Compute hashes (Node.js) ──")
        hash_source_path = args.hash_source or graph_path
        fe_data = _compute_fe_hashes(hash_source_path)
        _edges = [(e["param_id"], e["edge_uuid"], e["window_hash"], e["cohort_hash"])
                  for e in fe_data["edges"]]
        print(f"  {len(_edges)} edges resolved")
        for e in fe_data["edges"]:
            print(f"    {e['param_id']}: w={e['window_hash'][:16]}… c={e['cohort_hash'][:16]}…")

        # --- Derive anchor date range ---
        _dsl = graph.get("pinnedDSL", "") or graph.get("dataInterestsDSL", "")
        _date_match = re.search(r"(\d{1,2}-\w{3}-\d{2}):(\d{1,2}-\w{3}-\d{2})", _dsl)
        if _date_match:
            _from_dt = datetime.strptime(_date_match.group(1), "%d-%b-%y")
            _to_dt = datetime.strptime(_date_match.group(2), "%d-%b-%y")
            anchor_from = _from_dt.strftime("%Y-%m-%d")
            anchor_to = _to_dt.strftime("%Y-%m-%d")
        else:
            ref_date = asat_date if asat_date else date.today()
            anchor_to = ref_date.isoformat()
            anchor_from = (ref_date - timedelta(days=120)).isoformat()
        print(f"  Anchor range: {anchor_from} → {anchor_to}")

        # --- Load param files ---
        if args.params_dir:
            param_files = {}
            params_dir = os.path.abspath(args.params_dir)
            for fname in os.listdir(params_dir):
                if fname.endswith(".yaml") and "index" not in fname:
                    with open(os.path.join(params_dir, fname)) as f:
                        param_id = fname.replace(".yaml", "")
                        param_files[f"parameter-{param_id}"] = yaml.safe_load(f)
            print(f"  Using {len(param_files)} param files from: {params_dir}")
        elif asat_date and param_files_asat:
            param_files = param_files_asat
            print(f"  Using {len(param_files)} param files from git (asat {asat_date})")
            params_dir = None
        else:
            param_files = {}
            params_dir = os.path.join(data_repo_path, "parameters")
            for fname in os.listdir(params_dir):
                if fname.endswith(".yaml") and "index" not in fname:
                    with open(os.path.join(params_dir, fname)) as f:
                        param_id = fname.replace(".yaml", "")
                        param_files[f"parameter-{param_id}"] = yaml.safe_load(f)

        # --- Run BE stats/topo pass (full port of FE enhanceGraphLatencies) ---
        print("\n── Stats pass (BE analytics engine) ──")
        from runner.stats_engine import CohortData, enhance_graph_latencies
        import copy

        # Build CohortData per edge from param file values[].
        # Separate cohort and window slices (FE parity: they're aggregated independently).
        from runner.stats_engine import EdgeContext
        cohort_lookup: dict[str, list] = {}
        edge_contexts: dict[str, EdgeContext] = {}

        def _parse_date_to_age(d_str: str) -> float:
            """Parse a date string and return age in days from now."""
            for fmt in ("%d-%b-%y", "%Y-%m-%d", "%d-%b-%Y"):
                try:
                    dt = datetime.strptime(str(d_str), fmt)
                    return float(max(0, (datetime.now() - dt).days))
                except (ValueError, TypeError):
                    continue
            return 30.0  # conservative fallback

        def _extract_cohorts_from_values(values: list) -> tuple:
            """Extract CohortData from values[], returning (cohort_slice_cohorts, window_slice_cohorts)."""
            cohort_cohorts = []
            window_cohorts = []
            for v in values:
                dsl = v.get("sliceDSL", "") or ""
                is_window = "window(" in dsl
                is_cohort = "cohort(" in dsl
                # If no DSL, treat as cohort (default)
                target = window_cohorts if is_window and not is_cohort else cohort_cohorts

                dates = v.get("dates", [])
                n_daily = v.get("n_daily", [])
                k_daily = v.get("k_daily", [])
                # Try both field name conventions
                median_lag = v.get("median_lag_daily") or v.get("median_lag_days", [])
                mean_lag = v.get("mean_lag_daily") or v.get("mean_lag_days", [])
                anchor_median = v.get("anchor_median_lag_daily") or v.get("anchor_median_lag_days", [])
                anchor_mean = v.get("anchor_mean_lag_daily") or v.get("anchor_mean_lag_days", [])
                if not dates or not n_daily:
                    continue
                for i, d in enumerate(dates):
                    n = int(n_daily[i]) if i < len(n_daily) else 0
                    k = int(k_daily[i]) if i < len(k_daily) else 0
                    if n <= 0:
                        continue
                    age_days = _parse_date_to_age(d)
                    ml = float(median_lag[i]) if isinstance(median_lag, list) and i < len(median_lag) and median_lag[i] else None
                    mnl = float(mean_lag[i]) if isinstance(mean_lag, list) and i < len(mean_lag) and mean_lag[i] else None
                    aml = float(anchor_median[i]) if isinstance(anchor_median, list) and i < len(anchor_median) and anchor_median[i] else None
                    amnl = float(anchor_mean[i]) if isinstance(anchor_mean, list) and i < len(anchor_mean) and anchor_mean[i] else None
                    target.append(CohortData(
                        date=str(d), age=age_days, n=n, k=k,
                        median_lag_days=ml, mean_lag_days=mnl,
                        anchor_median_lag_days=aml, anchor_mean_lag_days=amnl,
                    ))
            return cohort_cohorts, window_cohorts

        for edge in graph.get("edges", []):
            pid = edge.get("p", {}).get("id")
            if not pid:
                continue
            pf = param_files.get(f"parameter-{pid}") or param_files.get(pid)
            if not pf:
                continue

            cohort_cohorts, window_cohorts = _extract_cohorts_from_values(pf.get("values", []))

            # Use all cohorts (both slices) as the main cohort data — FE does this
            # via aggregateCohortData which processes both slice types into CohortData[].
            all_cohorts = cohort_cohorts + window_cohorts
            eid = edge.get("uuid", "")
            if all_cohorts:
                cohort_lookup[eid] = all_cohorts

            # Build EdgeContext: onset from window slices, window cohorts for forecast, nBaseline
            ctx = EdgeContext()
            # Onset from window slice latency blocks
            lat_v = edge.get("p", {}).get("latency") or {}
            window_vals = [v for v in pf.get("values", []) if "window(" in (v.get("sliceDSL", "") or "")]
            onset_vals = [v.get("latency", {}).get("onset_delta_days") for v in window_vals
                          if isinstance(v.get("latency", {}).get("onset_delta_days"), (int, float))]
            if onset_vals:
                ctx.onset_from_window_slices = sorted(onset_vals)[len(onset_vals) // 2]  # median
            if window_cohorts:
                ctx.window_cohorts = window_cohorts
            window_n = sum(v.get("n", 0) or 0 for v in window_vals if isinstance(v.get("n"), (int, float)) and v["n"] > 0)
            if window_n > 0:
                ctx.n_baseline_from_window = window_n
            edge_contexts[eid] = ctx

        topo_result = enhance_graph_latencies(graph, cohort_lookup, edge_contexts=edge_contexts)

        # Apply results to graph in memory
        graph = copy.deepcopy(graph)
        edges_by_uuid = {e["uuid"]: e for e in graph.get("edges", [])}
        n_lat = 0
        for ev in topo_result.edge_values:
            edge = edges_by_uuid.get(ev.edge_uuid)
            if not edge:
                continue
            lat = edge.setdefault("p", {}).setdefault("latency", {})
            if ev.mu is not None:
                lat["mu"] = ev.mu
                lat["sigma"] = ev.sigma
                lat["onset_delta_days"] = ev.onset_delta_days
                lat["t95"] = ev.t95
                lat["path_t95"] = ev.path_t95
                lat["path_mu"] = ev.path_mu
                lat["path_sigma"] = ev.path_sigma
                lat["path_onset_delta_days"] = ev.path_onset_delta_days
                n_lat += 1
                pid = edge.get("p", {}).get("id", "?")
                print(f"    {pid}: mu={ev.mu:.3f}, sigma={ev.sigma:.3f}, "
                      f"onset={ev.onset_delta_days:.1f}, t95={ev.t95:.1f}, "
                      f"path_t95={ev.path_t95:.1f}")
            if ev.blended_mean is not None:
                edge["p"]["mean"] = ev.blended_mean
            if ev.p_infinity is not None and ev.forecast_available:
                edge["p"].setdefault("forecast", {})["mean"] = ev.p_infinity
        print(f"  {n_lat} edges with latency priors")

        # --- Build snapshot subjects ---
        equiv_map: dict[str, list[dict]] = {}
        for subj in fe_data.get("subjects", []):
            ch = subj.get("core_hash", "")
            eh = subj.get("equivalent_hashes", [])
            if ch and eh:
                equiv_map[ch] = eh

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
                "sweep_to": asat_date.isoformat() if asat_date else anchor_to,
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
        print(f"\nSnapshot subjects: {len(snapshot_subjects)} ({len(_edges)} edges × 2 slices)")

        # --- Pre-flight checks (MANDATORY before MCMC) ---
        preflight = _run_preflight(snapshot_subjects, db_connection, graph, param_files, _edges)

        if args.preflight_only:
            print("\n" + "=" * 60)
            print("PRE-FLIGHT COMPLETE")
            if preflight["warnings"]:
                print(f"  {len(preflight['warnings'])} warnings — review above")
            else:
                print("  All checks passed. Safe to run MCMC.")
            print("=" * 60)
            return

        if args.placeholder:
            pass  # Skip pre-flight warnings for placeholder mode

        # --- Build payload ---
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
                **({"features": feature_flags} if feature_flags else {}),
                **({"model_inspect_only": True} if args.no_mcmc else {}),
                **({"draws": args.draws} if args.draws else {}),
                **({"tune": args.tune} if args.tune else {}),
                **({"chains": args.chains} if args.chains else {}),
                **({"cores": args.cores} if args.cores else {}),
                **({"dump_evidence_path": args.dump_evidence} if args.dump_evidence else {}),
                **(_load_settings_json(args.settings_json) if args.settings_json else {}),
            },
            "_job_id": f"harness-{int(time.time())}",
        }

        if args.curl:
            payload_path = "/tmp/bayes-test-payload.json"
            with open(payload_path, "w") as f:
                json.dump(payload, f, cls=DateEncoder)
            print(f"\nPayload written to {payload_path} ({os.path.getsize(payload_path)} bytes)")
            print(f"\nSubmit:")
            print(f'  curl -s -X POST http://localhost:9000/api/bayes/submit '
                  f'-H "Content-Type: application/json" -d @{payload_path}')
            return

    # --- Run MCMC ---
    import threading

    LOG_PATH = f"/tmp/bayes_harness-{job_label or graph_name}.log"
    log_file = open(LOG_PATH, "w")

    def _print(msg="", **kwargs):
        print(msg, flush=True, **kwargs)
        log_file.write(msg + "\n")
        log_file.flush()

    _print(f"Log file: {LOG_PATH}")
    _print(f"  tail -f {LOG_PATH}")

    t_start = time.time()
    last_stage = ["idle"]
    last_pct = [0]
    last_detail = [""]
    result_box: list[Any] = [None]
    error_box: list[Any] = [None]
    sampling_abort = [False]

    def on_progress(stage, pct, detail=""):
        elapsed = time.time() - t_start
        last_stage[0] = stage
        last_pct[0] = pct
        last_detail[0] = detail
        _print(f"  [{pct:3d}%] {elapsed:6.1f}s  {stage}: {detail}")

        # Early abort: if sampling estimate exceeds 3x expected
        if stage == "sampling" and "minutes remaining" in detail:
            try:
                mins = int(detail.split("—")[1].strip().split()[0])
                if mins * 60 > expected_sample_s * 3 and pct < 10:
                    _print(f"\n  EARLY ABORT: Estimated {mins} min exceeds "
                           f"3x expected ({expected_sample_s}s).")
                    _print(f"  This indicates a geometry problem. Investigate before retrying.")
                    sampling_abort[0] = True
            except (ValueError, IndexError):
                pass

    def _run_once(run_payload, label=""):
        result_box[0] = None
        error_box[0] = None
        sampling_abort[0] = False
        t_start_run = time.time()

        def _worker():
            from worker import fit_graph
            try:
                result_box[0] = fit_graph(run_payload, report_progress=on_progress)
            except Exception as e:
                import traceback
                error_box[0] = (e, traceback.format_exc())

        _print(f"\n{'=' * 60}")
        _print(f"Running fit_graph [{args.graph} → {graph_name}]{' — ' + label if label else ''} "
               f"({'placeholder' if args.placeholder else 'compiler'})...")
        _print(f"Timeout: {timeout_s}s | Expected sampling: {expected_sample_s}s")
        _print(f"{'=' * 60}\n")

        thread = threading.Thread(target=_worker, daemon=True)
        thread.start()

        while thread.is_alive():
            thread.join(timeout=5.0)
            if thread.is_alive():
                elapsed = time.time() - t_start_run
                if sampling_abort[0]:
                    _print(f"\n  Killing sampler...")
                    subprocess.run(["pkill", "-P", str(os.getpid())], capture_output=True)
                    log_file.close()
                    sys.exit(1)
                if elapsed > timeout_s:
                    _print(f"\n  TIMEOUT after {elapsed:.0f}s (last stage: {last_stage[0]})")
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
            if lat.get("mu_mean") is not None:
                latency_block["mu"] = lat["mu_mean"]
            if lat.get("sigma_mean") is not None:
                latency_block["sigma"] = lat["sigma_mean"]
            if lat.get("onset_delta_days") is not None:
                latency_block["onset_delta_days"] = lat["onset_delta_days"]
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

    # --- Print results ---
    _print(f"\n{'=' * 60}")
    _print("RESULT LOG")
    _print(f"{'=' * 60}")
    for line in result.get("log", []):
        _print(f"  {line}")

    _print(f"\nStatus:      {result.get('status')}")
    _print(f"Edges fitted: {result.get('edges_fitted')}")
    _print(f"Duration:    {result.get('duration_ms')}ms")

    quality = result.get("quality", {})
    _print(f"Quality:     rhat={quality.get('max_rhat')}, "
           f"ess={quality.get('min_ess')}, "
           f"converged={quality.get('converged_pct')}%")

    if result.get("error"):
        _print(f"Error:       {result['error']}")

    timings = result.get("timings", {})
    if timings:
        _print(f"\nTimings:")
        for k, v in timings.items():
            _print(f"  {k}: {v}ms")

    # --- Posterior summary (doc 21 unified slices) ---
    webhook_edges = result.get("webhook_payload_edges", [])
    if webhook_edges:
        _print(f"\n{'─' * 60}")
        _print("  POSTERIOR SUMMARY")
        _print(f"{'─' * 60}")
        for edge in webhook_edges:
            pid = edge.get("param_id", "?")
            slices = edge.get("slices", {})
            # Also check legacy format (probability/latency blocks)
            legacy_prob = edge.get("probability")
            if not slices and legacy_prob:
                # Legacy format — convert for display
                alpha = legacy_prob.get("alpha", 0)
                beta_v = legacy_prob.get("beta", 0)
                p_mean = alpha / (alpha + beta_v) if (alpha + beta_v) > 0 else 0
                _print(f"\n  {pid} (legacy format)")
                _print(f"    p={p_mean:.4f} (α={alpha:.1f}, β={beta_v:.1f})")
                lat = edge.get("latency", {})
                if lat.get("mu_mean"):
                    onset = lat.get("onset_mean") or lat.get("onset_delta_days", 0)
                    import math
                    t95 = math.exp(lat["mu_mean"] + 1.645 * lat.get("sigma_mean", 0)) + onset
                    _print(f"    latency: mu={lat['mu_mean']:.3f} sigma={lat.get('sigma_mean', 0):.3f} "
                           f"onset={onset:.1f} t95≈{t95:.0f}d")
                continue

            _print(f"\n  {pid}")
            for sk, sv in slices.items():
                alpha = sv.get("alpha", 0)
                beta_v = sv.get("beta", 0)
                p_mean = alpha / (alpha + beta_v) if (alpha + beta_v) > 0 else 0
                ess = sv.get("ess", 0)
                rhat = sv.get("rhat", 0)
                prov = sv.get("provenance", "?")
                _print(f"    {sk}: p={p_mean:.4f} (α={alpha:.1f}, β={beta_v:.1f})  "
                       f"ess={ess:.0f} rhat={rhat:.3f} [{prov}]")
                if sv.get("mu_mean") is not None:
                    onset = sv.get("onset_mean", 0) or 0
                    import math
                    t95 = math.exp(sv["mu_mean"] + 1.645 * sv.get("sigma_mean", 0)) + onset
                    corr = sv.get("onset_mu_corr")
                    corr_str = f" corr(onset,mu)={corr:.2f}" if corr is not None else ""
                    _print(f"      latency: mu={sv['mu_mean']:.3f}±{sv.get('mu_sd', 0):.3f} "
                           f"sigma={sv.get('sigma_mean', 0):.3f}±{sv.get('sigma_sd', 0):.3f} "
                           f"onset={onset:.1f}±{sv.get('onset_sd', 0):.1f} "
                           f"t95≈{t95:.0f}d{corr_str}")

        # Compare against analytic values from param files
        _print(f"\n{'─' * 60}")
        _print("  ANALYTIC COMPARISON")
        _print(f"{'─' * 60}")
        for edge in webhook_edges:
            pid = edge.get("param_id", "?")
            pf_key = f"parameter-{pid}" if not pid.startswith("parameter-") else pid
            pf = param_files.get(pf_key) or param_files.get(pid, {})
            vals = pf.get("values", []) if pf else []
            if vals and isinstance(vals[0], dict):
                v = vals[0]
                analytic_mean = v.get("mean", "?")
                analytic_n = v.get("n", "?")
                analytic_k = v.get("k", "?")
                dsl = v.get("sliceDSL", "")
                # Get Bayes p from window() slice
                slices = edge.get("slices", {})
                ws = slices.get("window()", {})
                if ws:
                    bayes_alpha = ws.get("alpha", 0)
                    bayes_beta = ws.get("beta", 0)
                    bayes_p = bayes_alpha / (bayes_alpha + bayes_beta) if (bayes_alpha + bayes_beta) > 0 else 0
                    ratio = bayes_p / analytic_mean if isinstance(analytic_mean, (int, float)) and analytic_mean > 0 else None
                    ratio_str = f" (ratio={ratio:.2f}x)" if ratio is not None else ""
                    _print(f"  {pid}: analytic={analytic_mean} (k/n={analytic_k}/{analytic_n}) "
                           f"→ bayes={bayes_p:.4f}{ratio_str}")
                else:
                    _print(f"  {pid}: analytic={analytic_mean} (k/n={analytic_k}/{analytic_n}) → no bayes window()")
            else:
                _print(f"  {pid}: no analytic values")

    _print(f"\n{'=' * 60}")
    if result.get("status") == "complete" or result.get("edges_fitted", 0) > 0:
        _print("PASS")
    else:
        _print("FAIL")
    _print(f"{'=' * 60}")

    log_file.close()


if __name__ == "__main__":
    main()
