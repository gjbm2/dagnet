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
import signal

# Prevent stale .pyc from masking source edits during development.
sys.dont_write_bytecode = True

# ── NATIVE-CRASH INSTRUMENTATION ───────────────────────────────────────
# Arm faulthandler before importing pymc/pytensor/numpy so any SIGSEGV
# inside compiled kernels prints a Python traceback to stderr instead
# of being silently killed. This is the only way to get a stack trace
# out of a native crash inside the sampler — without it the subprocess
# dies with exit code 1 and no diagnostic, which is exactly how the
# diamond HARNESS FAILs were surfacing.
import faulthandler
_FAULT_PATH = os.environ.get(
    "BAYES_FAULT_LOG",
    f"/tmp/bayes-fault-{os.getpid()}.log",
)
_fault_file = open(_FAULT_PATH, "w")
faulthandler.enable(file=_fault_file, all_threads=True)
# Register SIGSEGV (11), SIGABRT (6), SIGFPE (8), SIGBUS (7) — any of
# these from a native kernel gets dumped before the process dies.
if os.name == "posix":
    for _sig in (signal.SIGSEGV, signal.SIGABRT, signal.SIGFPE, signal.SIGBUS):
        try:
            faulthandler.register(_sig, file=_fault_file, chain=True)
        except (RuntimeError, ValueError):
            pass

import json
import time
import argparse
import atexit
import copy
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
# Pre-flight checks
# ---------------------------------------------------------------------------

def _build_preflight_payload(payload: dict) -> dict:
    """Clone payload for worker-backed preflight without MCMC or webhooks."""
    preflight_payload = copy.deepcopy(payload)
    preflight_payload["webhook_url"] = ""
    settings = preflight_payload.setdefault("settings", {})
    settings["binding_receipt"] = "gate"
    settings["model_inspect_only"] = True
    return preflight_payload


def _summarise_preflight_result(result: dict) -> dict:
    """Normalise worker preflight output into a harness decision summary."""
    receipt = result.get("binding_receipt") or {}
    edge_receipts = receipt.get("edge_receipts") or {}
    failed_edges = sorted(
        edge_id
        for edge_id, edge_receipt in edge_receipts.items()
        if edge_receipt.get("verdict") == "fail"
    )
    warned_edges = sorted(
        edge_id
        for edge_id, edge_receipt in edge_receipts.items()
        if edge_receipt.get("verdict") == "warn"
    )
    edges_failed = int(receipt.get("edges_failed", 0) or 0)
    edges_warned = int(receipt.get("edges_warned", 0) or 0)
    safe_to_sample = (
        result.get("status") == "complete"
        and not result.get("error")
        and edges_failed == 0
        and edges_warned == 0
    )
    return {
        "safe_to_sample": safe_to_sample,
        "error": result.get("error", ""),
        "edges_failed": edges_failed,
        "edges_warned": edges_warned,
        "edges_skipped": int(receipt.get("edges_skipped", 0) or 0),
        "edges_fallback": int(receipt.get("edges_fallback", 0) or 0),
        "edges_no_subjects": int(receipt.get("edges_no_subjects", 0) or 0),
        "failed_edges": failed_edges,
        "warned_edges": warned_edges,
        "binding_receipt": receipt,
    }


def _run_preflight(payload: dict) -> dict:
    """Run the worker's real binding/model-inspect path without MCMC."""
    from worker import fit_graph

    print("\n── Pre-flight: worker-backed binding gate ──")
    try:
        result = fit_graph(
            _build_preflight_payload(payload),
            report_progress=lambda *_args, **_kwargs: None,
        )
    except Exception as e:
        print(f"  FAIL: worker preflight crashed: {e}")
        sys.exit(1)

    interesting_markers = (
        "connected to Neon",
        "subjects:",
        "topology:",
        "snapshot DB:",
        "evidence:",
        "binding receipt",
        "  binding ",
        "  slice ",
    )
    for line in result.get("log", []):
        if any(marker in line for marker in interesting_markers):
            print(f"  {line}")

    summary = _summarise_preflight_result(result)
    if summary["error"]:
        print(f"  FAIL: {summary['error']}")
    if summary["failed_edges"]:
        print("  FAIL edges: " + ", ".join(summary["failed_edges"]))
    if summary["warned_edges"]:
        print("  WARN edges: " + ", ".join(summary["warned_edges"]))

    return summary


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
    parser.add_argument("--diag", action="store_true",
                        help="Enable extra diagnostics: PPC calibration (doc 36).")
    parser.add_argument("--phase2-from-dump", type=str, default=None, metavar="PATH",
                        help="Skip Phase 1 entirely: load topology, evidence, and "
                             "phase2_frozen from a debug dump directory (created by "
                             "a previous run). Runs Phase 2 model build + MCMC directly. "
                             "e.g. --phase2-from-dump /tmp/bayes_debug-graph-synth-diamond-context")
    parser.add_argument("--clean", action="store_true",
                        help="Clear __pycache__ dirs under bayes/ and graph-editor/lib/ "
                             "so no stale bytecode masks source edits.")
    parser.add_argument("--rebuild", action="store_true",
                        help="Delete .synth-meta.json for the target graph, forcing "
                             "verify_synth_data to re-check DB with fresh hashes. "
                             "Heavy — re-inserts all synth rows. Only needed after "
                             "truth file or synth_gen changes.")
    parser.add_argument("--enrich", action="store_true",
                        help="After fit completes, apply Bayes results back to the "
                             "graph on disk via the FE CLI --apply-patch. Writes "
                             "model_vars, posteriors, and promoted latency values "
                             "to the graph and parameter files (production code path).")
    parser.add_argument("--fresh-priors", action="store_true",
                        help="Ignore persisted Bayesian posteriors on parameter files. "
                             "Sets bayes_reset on all param files and clears posterior "
                             "blocks before submission, so the compiler uses topology-"
                             "derived priors instead of warm-starting from previous fit.")
    # Keep --clean-pyc as hidden alias for backwards compat
    parser.add_argument("--clean-pyc", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.clean_pyc:
        args.clean = True

    # Clean bytecode if requested
    if args.clean:
        import shutil
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
        print(f"Cleaned {_pyc_cleaned} __pycache__ dirs")

    # Rebuild synth meta if requested (forces DB re-insert)
    if args.rebuild:
        _meta_cleaned = 0
        if args.graph and args.graph.startswith("synth-"):
            _conf = _read_private_repos_conf()
            _dr = _conf.get("DATA_REPO_DIR", "")
            if _dr:
                _meta = os.path.join(REPO_ROOT, _dr, "graphs", f"{args.graph}.synth-meta.json")
                if os.path.isfile(_meta):
                    os.remove(_meta)
                    _meta_cleaned = 1
        print(f"Rebuild: deleted {_meta_cleaned} synth-meta files")

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
        v_stripped = v.strip()
        v_lower = v_stripped.lower()
        if v_lower in ("true", "yes"):
            feature_flags[k] = True
        elif v_lower in ("false", "no"):
            feature_flags[k] = False
        else:
            # Try integer (e.g. latency_reparam_slices=2)
            try:
                feature_flags[k] = int(v_stripped)
            except ValueError:
                # Try float
                try:
                    feature_flags[k] = float(v_stripped)
                except ValueError:
                    # Pass as string
                    feature_flags[k] = v_stripped
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
        if args.diag:
            settings["run_calibration"] = True
        if args.settings_json:
            settings.update(_load_settings_json(args.settings_json))

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

        if args.timeout is not None and args.timeout > 0:
            expected_sample_s = args.timeout
            timeout_s = args.timeout
        elif args.timeout == 0:
            expected_sample_s = 0
            timeout_s = 0
        else:
            expected_sample_s = truth.get("simulation", {}).get("expected_sample_seconds", 600)
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

        # --- Phase 2 from dump: skip payload construction entirely ---
        _skip_payload_construction = False
        if args.phase2_from_dump:
            print(f"\n  PHASE 2 FROM DUMP: {args.phase2_from_dump}")
            print(f"  Skipping hash computation, synth gate, pre-flight.")
            payload = {
                "graph_id": graph_id,
                "graph_snapshot": graph,
                "parameter_files": {},
                "parameters_index": {},
                "settings": {},
            }
            # Merge CLI settings
            settings = payload.setdefault("settings", {})
            if feature_flags:
                settings.setdefault("features", {}).update(feature_flags)
            settings["phase2_from_dump"] = args.phase2_from_dump
            if args.draws:
                settings["draws"] = args.draws
            if args.tune:
                settings["tune"] = args.tune
            if args.chains:
                settings["chains"] = args.chains
            if args.cores:
                settings["cores"] = args.cores
            if args.settings_json:
                settings.update(_load_settings_json(args.settings_json))
            _skip_payload_construction = True

        # --- Synth data gate: verify DB has rows, bootstrap if needed ---
        if graph_name.startswith("synth-") and not _skip_payload_construction:
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

        # --- Build payload via FE CLI (single canonical code path) ---
        # The FE CLI handles hash computation, subject generation,
        # candidateRegimesByEdge (incl. supplementary hash discovery),
        # MECE dimensions, stats pass, and engorged graph edges.
        # No duplicate logic here.
        print("\n── Build payload via FE CLI ──")

        # --dsl-override: temporarily patch the graph JSON's pinnedDSL
        # before CLI construction so subjects are computed from the
        # overridden DSL. Restored after the CLI call.
        _dsl_backup = None
        _graph_json_path = graph_path
        if getattr(args, 'dsl_override', None) and os.path.isfile(graph_path):
            with open(graph_path) as _gf:
                _gj = json.load(_gf)
            _dsl_backup = (_gj.get('pinnedDSL'), _gj.get('dataInterestsDSL'))
            _gj['pinnedDSL'] = args.dsl_override
            _gj['dataInterestsDSL'] = args.dsl_override
            with open(graph_path, 'w') as _gf:
                json.dump(_gj, _gf, indent=2)
            print(f"  DSL override applied: {args.dsl_override}")

        try:
            # Derive graph_dir from graph_path: parent of "graphs/"
            graphs_parent = os.path.dirname(graph_path)  # .../graphs
            cli_graph_dir = os.path.dirname(graphs_parent)  # .../nous-conversion
            payload = _build_payload_via_cli(graph_name, cli_graph_dir)
        finally:
            # Restore original DSL
            if _dsl_backup is not None and _graph_json_path and os.path.isfile(_graph_json_path):
                with open(_graph_json_path) as _gf:
                    _gj = json.load(_gf)
                _gj['pinnedDSL'] = _dsl_backup[0]
                _gj['dataInterestsDSL'] = _dsl_backup[1]
                with open(_graph_json_path, 'w') as _gf:
                    json.dump(_gj, _gf, indent=2)
                print("  DSL override restored")

        # Extract fields from CLI payload for downstream use
        graph = payload.get("graph_snapshot", graph)
        param_files = payload.get("parameter_files", {})
        snapshot_subjects = payload.get("snapshot_subjects", [])

        n_subjects = len(snapshot_subjects)
        n_params = len(param_files)
        n_regimes = sum(len(v) for v in payload.get("candidate_regimes_by_edge", {}).values())
        mece_dims = payload.get("mece_dimensions", [])
        print(f"  {n_subjects} subjects, {n_params} param files, "
              f"{n_regimes} candidate regimes, MECE: {mece_dims}")

        # Ensure DB_CONNECTION is in the payload
        if not payload.get("db_connection"):
            payload["db_connection"] = db_connection

        # Ensure webhook settings
        if args.no_webhook:
            payload["webhook_url"] = ""
        elif not payload.get("webhook_url"):
            payload["webhook_url"] = "http://localhost:5173/api/bayes-webhook"

        # Merge CLI overrides into payload settings
        settings = payload.setdefault("settings", {})
        if feature_flags:
            settings.setdefault("features", {}).update(feature_flags)
        if args.no_mcmc:
            settings["model_inspect_only"] = True
        if args.dump_evidence:
            settings["dump_evidence_path"] = args.dump_evidence
        if args.draws:
            settings["draws"] = args.draws
        if args.tune:
            settings["tune"] = args.tune
        if args.chains:
            settings["chains"] = args.chains
        if args.cores:
            settings["cores"] = args.cores
        if args.diag:
            settings["run_calibration"] = True
        if args.phase2_from_dump:
            settings["phase2_from_dump"] = args.phase2_from_dump
        if args.settings_json:
            settings.update(_load_settings_json(args.settings_json))

        # --- Pre-flight checks (MANDATORY before MCMC) ---
        preflight = _run_preflight(payload)
        if preflight["edges_failed"] > 0 or preflight["error"]:
            print("\n  ABORT: pre-flight found blocking issues.")
            sys.exit(1)

        if args.preflight_only:
            print("\n" + "=" * 60)
            print("PRE-FLIGHT COMPLETE")
            if preflight["safe_to_sample"]:
                print("  All checks passed. Safe to run MCMC.")
                print("=" * 60)
                return
            print("  Pre-flight found warnings — review above before MCMC.")
            print("=" * 60)
            sys.exit(1)

        if not preflight["safe_to_sample"] and not args.placeholder:
            print("\n  NOTE: pre-flight found warnings — continuing because no blocking failures were raised.")

        payload["_job_id"] = f"harness-{int(time.time())}"

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

    _label = job_label or graph_name
    LOG_PATH = f"/tmp/bayes_harness-{_label}.log"
    # Timestamped archive copy — never overwritten.
    _ts = time.strftime("%Y%m%d-%H%M%S")
    LOG_ARCHIVE = f"/tmp/bayes_harness-{_label}-{_ts}.log"
    log_file = open(LOG_PATH, "w")
    archive_file = open(LOG_ARCHIVE, "w")

    # Tee stdout to the harness log so worker print() calls
    # (model diagnostics, Phase 2 info) are captured even if
    # the run is killed before the result log is written.
    class _TeeStdout:
        def __init__(self, original, log_f, archive_f):
            self._orig = original
            self._log = log_f
            self._archive = archive_f
        def write(self, msg):
            self._orig.write(msg)
            self._orig.flush()
            self._log.write(msg)
            self._log.flush()
            self._archive.write(msg)
            self._archive.flush()
        def flush(self):
            self._orig.flush()
            self._log.flush()
            self._archive.flush()
        def __getattr__(self, name):
            return getattr(self._orig, name)
    _original_stdout = sys.stdout
    sys.stdout = _TeeStdout(_original_stdout, log_file, archive_file)

    def _restore_stdout():
        sys.stdout = _original_stdout

    def _print(msg="", **kwargs):
        print(msg, flush=True, **kwargs)

    _print(f"Log file: {LOG_PATH}")
    _print(f"  tail -f {LOG_PATH}")
    _print(f"Archive:  {LOG_ARCHIVE}")

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
        # Skip when timeout_s == 0 (--no-timeout / --timeout 0).
        if stage == "sampling" and "minutes remaining" in detail and timeout_s > 0:
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
                    _restore_stdout()
                    log_file.close()
                    archive_file.close()
                    sys.exit(1)
                if timeout_s > 0 and elapsed > timeout_s:
                    _print(f"\n  TIMEOUT after {elapsed:.0f}s (last stage: {last_stage[0]})")
                    # SIGTERM workers, wait briefly, then SIGKILL stragglers.
                    # Without the grace period, native sampler threads die
                    # mid-matrix-op and produce a collateral SIGSEGV that
                    # faulthandler captures — which misleadingly looks like
                    # a compiler crash in downstream classification.
                    subprocess.run(["pkill", "-P", str(os.getpid())], capture_output=True)
                    time.sleep(1.0)
                    subprocess.run(["pkill", "-9", "-P", str(os.getpid())], capture_output=True)
                    _restore_stdout()
                    log_file.close()
                    archive_file.close()
                    # Exit 124 = standard timeout. run_regression.py maps
                    # this to a "timed_out" completion verdict, not HARNESS
                    # FAIL. The graph has a completion outcome (albeit a
                    # pessimistic one) and feeds into quality analysis.
                    sys.exit(124)
                # Only print heartbeat if no progress callback is firing
                # (i.e. during compilation or pre-sampling setup).
                # Once nutpie's template_callback is active, it provides
                # richer progress — this line is just noise alongside it.
                if last_stage[0] not in ("sampling",):
                    _print(f"  ... {elapsed:.0f}s elapsed, stage: {last_stage[0]}")

        if error_box[0]:
            e, tb = error_box[0]
            _print(f"\nCRASHED after {time.time() - t_start_run:.1f}s: {e}")
            _print(tb)
            _restore_stdout()
            log_file.close()
            archive_file.close()
            sys.exit(1)

        if not result_box[0]:
            _print(f"\nNo result returned after {time.time() - t_start_run:.1f}s")
            _restore_stdout()
            log_file.close()
            archive_file.close()
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

    # --- Fresh priors: strip persisted posteriors from parameter files ---
    if args.fresh_priors:
        pf = payload.get("parameter_files", {})
        n_reset = 0
        for pf_id, pf_data in pf.items():
            if not isinstance(pf_data, dict):
                continue
            # Set bayes_reset so compiler skips warm-start
            lat = pf_data.get("latency")
            if lat is None:
                pf_data["latency"] = {"bayes_reset": True}
            else:
                lat["bayes_reset"] = True
            # Also clear the posterior block so there's nothing to warm-start from
            if "posterior" in pf_data:
                del pf_data["posterior"]
            n_reset += 1
        _print(f"  --fresh-priors: cleared posteriors and set bayes_reset on {n_reset} parameter files")

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

    # --- Enrich graph on disk (--enrich) ---
    if args.enrich:
        webhook_edges = result.get("webhook_payload_edges", [])
        if not webhook_edges:
            _print("\n  --enrich: no webhook_payload_edges in result — skipping")
        else:
            _print(f"\n  --enrich: applying {len(webhook_edges)} edge posteriors to graph on disk...")
            import tempfile
            patch_file_data = {
                "webhook_payload_edges": webhook_edges,
                "job_id": result.get("job_id", f"harness-enrich-{int(time.time())}"),
                "fitted_at": result.get("fitted_at", ""),
                "fingerprint": result.get("fingerprint", ""),
                "model_version": result.get("model_version", 1),
                "quality": result.get("quality", {}),
                "skipped": result.get("skipped", []),
            }
            with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
                json.dump(patch_file_data, f)
                enrich_patch_path = f.name

            # Derive graph_dir from graph_path: parent of "graphs/"
            enrich_graph_dir = os.path.dirname(os.path.dirname(graph_path))

            # Shell out to FE CLI --apply-patch
            nvm_prefix = (
                f'export NVM_DIR="${{NVM_DIR:-$HOME/.nvm}}" && '
                f'. "$NVM_DIR/nvm.sh" 2>/dev/null; '
                f'cd {os.path.join(REPO_ROOT, "graph-editor")} && '
                f'nvm use "$(cat .nvmrc)" 2>/dev/null; '
            )
            tsx_cmd = (
                f'{nvm_prefix}'
                f'npx tsx src/cli/bayes.ts '
                f'--graph {enrich_graph_dir} --name {graph_name} '
                f'--apply-patch {enrich_patch_path} --no-cache'
            )
            try:
                enrich_result = subprocess.run(
                    ["bash", "-c", tsx_cmd],
                    capture_output=True, text=True, timeout=60,
                    cwd=REPO_ROOT,
                )
                if enrich_result.returncode == 0:
                    # Parse summary from stdout
                    stdout = enrich_result.stdout
                    json_start = stdout.find('{')
                    if json_start >= 0:
                        summary = json.loads(stdout[json_start:])
                        _print(f"  --enrich: {summary.get('edges_updated', '?')} edges enriched on disk")
                        for e in summary.get("edges", []):
                            _print(f"    {e['param_id']}: mu={e.get('promoted_mu')}, "
                                   f"sigma={e.get('promoted_sigma')}, t95={e.get('promoted_t95')}")
                    else:
                        _print(f"  --enrich: CLI completed (no JSON summary)")
                else:
                    _print(f"  --enrich: CLI failed (exit {enrich_result.returncode})")
                    if enrich_result.stderr:
                        _print(f"  stderr: {enrich_result.stderr[-1000:]}")
            except subprocess.TimeoutExpired:
                _print("  --enrich: CLI timed out (60s)")
            finally:
                os.unlink(enrich_patch_path)

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
                if sk.startswith("_"):
                    continue  # internal metadata (e.g. _tau_slice), not a real slice
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
                    prov = ws.get("provenance", "?")
                    _print(f"  {pid}: analytic={analytic_mean} (k/n={analytic_k}/{analytic_n}) "
                           f"→ bayes={bayes_p:.4f} [{prov}]{ratio_str}")
                else:
                    _print(f"  {pid}: analytic={analytic_mean} (k/n={analytic_k}/{analytic_n}) → no bayes window()")
            else:
                _print(f"  {pid}: no analytic values")

    # --- Ground truth recovery comparison (synth graphs only) ---
    if truth and truth.get("edges"):
        _print(f"\n{'─' * 60}")
        _print("  GROUND TRUTH RECOVERY")
        _print(f"{'─' * 60}")
        truth_edges = truth["edges"]
        ctx_dims = truth.get("context_dimensions", [])

        def _z(truth_val, post_mean, post_sd):
            if post_sd and post_sd > 1e-6:
                return abs(truth_val - post_mean) / post_sd
            return float("inf") if abs(truth_val - post_mean) > 0.01 else 0.0

        def _fmt(name, truth_val, post_mean, post_sd=None):
            z = _z(truth_val, post_mean, post_sd) if post_sd else None
            z_str = f" z={z:.1f}" if z is not None else ""
            err = post_mean - truth_val
            flag = " MISS" if z is not None and z > 3.0 else ""
            return f"    {name:>12}: truth={truth_val:.4f} post={post_mean:.4f} Δ={err:+.4f}{z_str}{flag}"

        for edge in webhook_edges:
            pid = edge.get("param_id", "?")
            # Match truth edge by param_id suffix (e.g. "synth-simple-abc-context-simple-a-to-b" → "simple-a-to-b")
            truth_edge = None
            truth_edge_key = ""
            for tk, tv in truth_edges.items():
                if pid.endswith(tk):
                    truth_edge = tv
                    truth_edge_key = tk
                    break
            if not truth_edge:
                continue

            truth_p = truth_edge.get("p", 0)
            truth_mu = truth_edge.get("mu", 0)
            truth_sigma = truth_edge.get("sigma", 0)
            truth_onset = truth_edge.get("onset", 0)
            truth_kappa = truth.get("simulation", {}).get("user_kappa", 50)

            slices = edge.get("slices", {})
            ws = slices.get("window()", {})

            _print(f"\n  {pid} (truth: p={truth_p}, mu={truth_mu}, σ={truth_sigma}, onset={truth_onset})")

            # Aggregate
            if ws:
                _wa, _wb = ws.get("alpha", 0), ws.get("beta", 0)
                bayes_p = _wa / (_wa + _wb) if (_wa + _wb) > 0 else 0
                _print(_fmt("p", truth_p, bayes_p))
                if "mu_mean" in ws:
                    _print(_fmt("mu", truth_mu, ws["mu_mean"], ws.get("mu_sd")))
                if "sigma_mean" in ws:
                    _print(_fmt("sigma", truth_sigma, ws["sigma_mean"], ws.get("sigma_sd")))
                if "onset_mean" in ws:
                    _print(_fmt("onset", truth_onset, ws["onset_mean"], ws.get("onset_sd")))
                if "kappa_mean" in ws:
                    _print(_fmt("kappa", truth_kappa, ws["kappa_mean"], ws.get("kappa_sd")))

            # Per-slice
            for dim in ctx_dims:
                dim_id = dim["id"]
                for cv in dim.get("values", []):
                    cv_id = cv["id"]
                    ctx_key_w = f"context({dim_id}:{cv_id}).window()"
                    ctx_key_c = f"context({dim_id}:{cv_id}).cohort()"
                    edge_overrides = cv.get("edges", {}).get(truth_edge_key, {})
                    slice_truth_p = truth_p * edge_overrides.get("p_mult", 1.0)
                    slice_truth_mu = truth_mu + edge_overrides.get("mu_offset", 0.0)
                    slice_truth_onset = truth_onset + edge_overrides.get("onset_offset", 0.0)

                    sw = slices.get(ctx_key_w, {})
                    if sw:
                        _sa, _sb = sw.get("alpha", 0), sw.get("beta", 0)
                        sp = _sa / (_sa + _sb) if (_sa + _sb) > 0 else 0
                        _print(f"    {ctx_key_w}:")
                        _print(_fmt("p", slice_truth_p, sp))
                        if "mu_mean" in sw:
                            _print(_fmt("mu", slice_truth_mu, sw["mu_mean"], sw.get("mu_sd")))
                        if "sigma_mean" in sw and sw["sigma_mean"] > 0:
                            _print(_fmt("sigma", truth_sigma, sw["sigma_mean"], sw.get("sigma_sd")))
                        if "onset_mean" in sw and sw["onset_mean"] > 0:
                            _print(_fmt("onset", slice_truth_onset, sw["onset_mean"], sw.get("onset_sd")))

                    sc = slices.get(ctx_key_c, {})
                    if sc:
                        _ca, _cb = sc.get("alpha", 0), sc.get("beta", 0)
                        scp = _ca / (_ca + _cb) if (_ca + _cb) > 0 else 0
                        prov = sc.get("provenance", "?")
                        _print(f"    {ctx_key_c} [{prov}]:")
                        _print(_fmt("p", slice_truth_p, scp))

    # --- Summary line: timing, quality, recovery ---
    _print(f"\n{'=' * 60}")
    status = result.get("status", "error")
    dur_s = (result.get("duration_ms") or 0) / 1000
    t = result.get("timings", {})
    p1_s = (t.get("sampling_ms", 0) - t.get("sampling_phase2_ms", 0)) / 1000
    p2_s = t.get("sampling_phase2_ms", 0) / 1000

    # Quality metrics
    q = result.get("quality", {})
    rhat = q.get("max_rhat")
    ess = q.get("min_ess")
    conv = q.get("converged_pct")

    # Worst recovery ratio (analytic comparison)
    worst_ratio = None
    worst_ratio_edge = None
    for edge in webhook_edges:
        pid = edge.get("param_id", "?")
        pf_key = f"parameter-{pid}" if not pid.startswith("parameter-") else pid
        pf = param_files.get(pf_key) or param_files.get(pid, {})
        vals = pf.get("values", []) if pf else []
        if vals and isinstance(vals[0], dict):
            analytic_mean = vals[0].get("mean")
            if not isinstance(analytic_mean, (int, float)) or analytic_mean <= 0:
                continue
            ws = edge.get("slices", {}).get("window()", {})
            if ws:
                ba, bb = ws.get("alpha", 0), ws.get("beta", 0)
                if (ba + bb) > 0:
                    ratio = (ba / (ba + bb)) / analytic_mean
                    deviation = abs(ratio - 1.0)
                    if worst_ratio is None or deviation > abs(worst_ratio - 1.0):
                        worst_ratio = ratio
                        worst_ratio_edge = pid.split("-")[-3] + "→" + pid.split("-")[-1] if pid.count("-") >= 3 else pid

    # Worst truth z-score (synth graphs)
    worst_z = None
    worst_z_param = None
    if truth and truth.get("edges"):
        for edge in webhook_edges:
            pid = edge.get("param_id", "?")
            te = None
            for tk, tv in truth["edges"].items():
                if pid.endswith(tk):
                    te = tv
                    break
            if not te:
                continue
            ws = edge.get("slices", {}).get("window()", {})
            if not ws:
                continue
            short = pid.split("-")[-3] + "→" + pid.split("-")[-1] if pid.count("-") >= 3 else pid
            # Check p recovery
            tp = te.get("p", 0)
            wa, wb = ws.get("alpha", 0), ws.get("beta", 0)
            if (wa + wb) > 0:
                bp = wa / (wa + wb)
                # z for beta-distributed mean: use posterior sd ≈ sqrt(ab/((a+b)^2(a+b+1)))
                import math
                psd = math.sqrt(wa * wb / ((wa + wb) ** 2 * (wa + wb + 1))) if (wa + wb) > 1 else 0.1
                zp = abs(tp - bp) / psd if psd > 1e-6 else 0
                if worst_z is None or zp > worst_z:
                    worst_z = zp
                    worst_z_param = f"p({short})"
            # Check mu, onset
            for param, tkey in [("mu", "mu"), ("onset", "onset")]:
                tv = te.get(tkey)
                if tv is None:
                    continue
                pm = ws.get(f"{param}_mean")
                psd = ws.get(f"{param}_sd")
                if pm is not None and psd and psd > 1e-6:
                    z = abs(tv - pm) / psd
                    if worst_z is None or z > worst_z:
                        worst_z = z
                        worst_z_param = f"{param}({short})"

    # Build summary
    parts = [status.upper()]
    parts.append(f"total={dur_s:.0f}s")
    if p2_s > 0:
        parts.append(f"p1={p1_s:.0f}s")
        parts.append(f"p2={p2_s:.0f}s")
    if rhat is not None:
        parts.append(f"rhat={rhat:.3f}")
    if ess is not None:
        parts.append(f"ess={ess:.0f}")
    if conv is not None:
        parts.append(f"conv={conv:.0f}%")
    if worst_ratio is not None:
        parts.append(f"worst_ratio={worst_ratio:.2f}x({worst_ratio_edge})")
    if worst_z is not None:
        parts.append(f"worst_z={worst_z:.1f}({worst_z_param})")
    _print("  ".join(parts))
    _print(f"{'=' * 60}")

    _restore_stdout()
    log_file.close()
    archive_file.close()


if __name__ == "__main__":
    main()
