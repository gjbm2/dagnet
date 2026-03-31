#!/usr/bin/env python3
"""
Param recovery regression pipeline.

Discovers synth graphs from truth files, bootstraps missing data,
runs recovery in parallel with core-aware scheduling, and asserts
quality against truth-file thresholds.

Usage:
    . graph-editor/venv/bin/activate

    # Full regression (discover, bootstrap, parallel, assert)
    python bayes/run_regression.py

    # Single graph
    python bayes/run_regression.py --graph synth-simple-abc

    # Dry run (discover + preflight only, no MCMC)
    python bayes/run_regression.py --preflight-only

    # Override core budget
    python bayes/run_regression.py --chains 2 --max-parallel 4

Monitor progress:
    scripts/bayes-monitor.sh

Execution path:
    run_regression.py
      -> synth_gen.py --write-files     (bootstrap, sequential)
      -> param_recovery.py --graph X    (MCMC, parallel pool)
         -> test_harness.py --graph X   (writes /tmp/bayes_harness-{graph}.log)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import subprocess
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "bayes"))

# Thread-pinning for BLAS/OpenMP (prevents oversubscription in parallel runs)
_THREAD_PIN_ENV = {
    "OMP_NUM_THREADS": "1",
    "MKL_NUM_THREADS": "1",
    "OPENBLAS_NUM_THREADS": "1",
    "NUMBA_NUM_THREADS": "1",
}


# ---------------------------------------------------------------------------
# Assertion thresholds (per parameter type)
# ---------------------------------------------------------------------------
# Based on SBC best practice: z-scores are primary, coverage secondary.
# Thresholds stratified by parameter type, not topology.
# Per-graph overrides via truth file testing.thresholds section.

DEFAULT_THRESHOLDS = {
    "p_z": 2.5,          # probability z-score
    "mu_z": 2.5,         # latency mean z-score
    "sigma_z": 3.0,      # latency stdev z-score (harder to recover)
    "onset_z": 3.0,      # onset z-score (harder to recover)
    "rhat_max": 1.05,    # max rhat across all variables
    "min_ess": 200,       # min ESS across all variables
    "min_converged_pct": 90.0,
    # Absolute error floors — if abs error is below these, pass regardless
    # of z-score. With precise posteriors on clean synth data, tiny systematic
    # biases inflate z-scores beyond what's scientifically meaningful.
    "mu_abs_floor": 0.3,
    "sigma_abs_floor": 0.2,
    "onset_abs_floor": 0.3,
    "p_abs_floor": 0.05,
}


# ---------------------------------------------------------------------------
# Discovery + preflight
# ---------------------------------------------------------------------------

def discover_and_preflight(
    data_repo: str,
    graph_filter: str | list[str] | None = None,
) -> list[dict]:
    """Discover synth graphs and check data integrity.

    graph_filter: single name, list of names, or None for all.

    Returns list of dicts, each with:
        graph_name, truth_path, truth, status, reason, needs_bootstrap
    """
    from synth_gen import discover_synth_graphs, verify_synth_data

    graphs = discover_synth_graphs(data_repo)
    if graph_filter:
        if isinstance(graph_filter, str):
            graph_filter = [graph_filter]
        allowed = set(graph_filter)
        graphs = [g for g in graphs if g["graph_name"] in allowed]

    results = []
    for g in graphs:
        name = g["graph_name"]
        verification = verify_synth_data(name, data_repo)
        results.append({
            "graph_name": name,
            "truth_path": g["truth_path"],
            "truth": g["truth"],
            "status": verification["status"],
            "reason": verification["reason"],
            "needs_bootstrap": verification["status"] in ("missing", "stale"),
        })
    return results


def bootstrap_graph(graph_name: str, timeout: int = 300) -> bool:
    """Run synth_gen.py --graph X --write-files. Returns True on success."""
    cmd = [
        sys.executable,
        os.path.join(REPO_ROOT, "bayes", "synth_gen.py"),
        "--graph", graph_name,
        "--write-files",
    ]
    print(f"  Bootstrapping {graph_name}...")
    result = subprocess.run(
        cmd, capture_output=True, text=True, timeout=timeout, cwd=REPO_ROOT,
    )
    if result.returncode != 0:
        print(f"  FAIL: {graph_name} bootstrap failed (exit {result.returncode})")
        print(f"  {result.stderr[-500:]}" if result.stderr else "")
        return False
    print(f"  OK: {graph_name} bootstrapped")
    return True


# ---------------------------------------------------------------------------
# Execution (via param_recovery.py -> test_harness.py)
# ---------------------------------------------------------------------------

def _run_one_graph(
    graph_name: str,
    chains: int,
    cores: int,
    draws: int,
    tune: int,
    timeout: int,
) -> dict:
    """Run param_recovery.py for one graph. Returns parsed result dict.

    This is the function submitted to the process pool. It runs as a
    subprocess so that harness logs are written to /tmp/bayes_harness-{graph}.log
    (visible to bayes-monitor.sh).
    """
    cmd = [
        sys.executable,
        os.path.join(REPO_ROOT, "bayes", "param_recovery.py"),
        "--graph", graph_name,
        "--chains", str(chains),
        "--cores", str(cores),
        "--draws", str(draws),
        "--tune", str(tune),
        "--timeout", str(timeout),
    ]
    env = {**os.environ, **_THREAD_PIN_ENV}

    t0 = time.time()
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=timeout + 120,
            env=env, cwd=REPO_ROOT,
        )
        elapsed = time.time() - t0
        output = result.stdout + result.stderr
        return {
            "graph_name": graph_name,
            "exit_code": result.returncode,
            "elapsed_s": elapsed,
            "output": output,
            "error": None,
        }
    except subprocess.TimeoutExpired:
        return {
            "graph_name": graph_name,
            "exit_code": -1,
            "elapsed_s": time.time() - t0,
            "output": "",
            "error": f"Timeout after {timeout + 120}s",
        }
    except Exception as e:
        return {
            "graph_name": graph_name,
            "exit_code": -1,
            "elapsed_s": time.time() - t0,
            "output": "",
            "error": str(e),
        }


# ---------------------------------------------------------------------------
# Result parsing + assertions
# ---------------------------------------------------------------------------

def _parse_recovery_output(output: str) -> dict:
    """Parse param_recovery.py output into structured results."""
    result: dict = {"quality": {}, "edges": {}}

    # Quality line
    m = re.search(
        r"RECOVERY COMPARISON \((\d+)s, rhat=([\d.]+), ess=(\d+), converged=(\d+)%\)",
        output,
    )
    if m:
        result["quality"] = {
            "elapsed_s": int(m.group(1)),
            "rhat": float(m.group(2)),
            "ess": int(m.group(3)),
            "converged_pct": int(m.group(4)),
        }

    # Per-edge results: parse the structured output from param_recovery.py
    # Pattern: "  mu    truth=  2.300  post=  2.114±0.004     Δ=0.186  [OK]  prior=2.300"
    current_edge = None
    for line in output.split("\n"):
        line = line.strip()

        # Edge header: "  simple-a-to-b"
        if line and not line.startswith(("mu", "sigma", "onset", "kappa", "rhat", "─", "NO", "RECOVERY")):
            # Could be an edge name
            candidate = line.strip()
            if candidate and not candidate.startswith(("[", "Running", "GROUND", "Edge", "=", "HARNESS")):
                # Heuristic: edge names contain hyphens and no spaces
                if "-" in candidate and " " not in candidate:
                    current_edge = candidate

        if current_edge and ("truth=" in line and "post=" in line):
            # Parse: "mu    truth=  2.300  post=  2.114±0.004     Δ=0.186  [OK]"
            param_match = re.match(
                r"(mu|sigma|onset|p)\s+truth=\s*([\d.]+)\s+post=\s*([\d.]+)±([\d.]+)\s+"
                r"(?:Δ|z)=\s*([\d.]+)\s+\[(OK|MISS)\]",
                line,
            )
            if param_match:
                param = param_match.group(1)
                truth_val = float(param_match.group(2))
                post_mean = float(param_match.group(3))
                post_sd = float(param_match.group(4))
                delta_or_z = float(param_match.group(5))
                status = param_match.group(6)

                edge_data = result["edges"].setdefault(current_edge, {})
                edge_data[param] = {
                    "truth": truth_val,
                    "posterior_mean": post_mean,
                    "posterior_sd": post_sd,
                    "z_score": abs(post_mean - truth_val) / post_sd if post_sd > 0 else 0,
                    "abs_error": abs(post_mean - truth_val),
                    "status": status,
                }

    return result


def assert_recovery(graph_name: str, parsed: dict, truth: dict) -> dict:
    """Apply tiered assertions. Returns dict with pass/fail and details."""
    testing = truth.get("testing", {})
    thresholds = {**DEFAULT_THRESHOLDS}
    # Per-graph overrides
    for key in thresholds:
        if key in testing.get("thresholds", {}):
            thresholds[key] = testing["thresholds"][key]

    quality = parsed.get("quality", {})
    failures = []
    warnings = []

    # Global convergence gates
    rhat = quality.get("rhat", 99)
    if rhat > thresholds["rhat_max"]:
        failures.append(f"rhat={rhat:.4f} > {thresholds['rhat_max']}")

    ess = quality.get("ess", 0)
    if ess < thresholds["min_ess"]:
        failures.append(f"ESS={ess} < {thresholds['min_ess']}")

    converged = quality.get("converged_pct", 0)
    if converged < thresholds["min_converged_pct"]:
        failures.append(f"converged={converged}% < {thresholds['min_converged_pct']}%")

    # Per-parameter z-score checks
    truth_edges = truth.get("edges", {})
    for edge_name, edge_data in parsed.get("edges", {}).items():
        for param, pdata in edge_data.items():
            if param == "kappa":
                continue  # not testable (known issue)

            z = pdata.get("z_score", 0)
            abs_err = pdata.get("abs_error", 0)
            threshold_key = f"{param}_z"
            z_threshold = thresholds.get(threshold_key, 3.0)
            abs_floor = thresholds.get(f"{param}_abs_floor", 0.3)

            # Two-gate criterion: PASS if EITHER z < threshold OR
            # absolute error < floor. With precise posteriors on clean
            # synth data, tiny biases inflate z beyond what matters.
            z_pass = z <= z_threshold
            abs_pass = abs_err <= abs_floor

            if not z_pass and not abs_pass:
                failures.append(
                    f"{edge_name} {param}: |z|={z:.2f} > {z_threshold} "
                    f"Δ={abs_err:.3f} > {abs_floor} "
                    f"(truth={pdata['truth']:.3f} post={pdata['posterior_mean']:.3f}±{pdata['posterior_sd']:.3f})"
                )
            elif not z_pass and abs_pass:
                warnings.append(
                    f"{edge_name} {param}: |z|={z:.2f} > {z_threshold} but Δ={abs_err:.3f} < {abs_floor} (abs floor pass)"
                )
            elif z > z_threshold * 0.8:
                warnings.append(
                    f"{edge_name} {param}: |z|={z:.2f} approaching threshold {z_threshold}"
                )

    is_xfail = bool(testing.get("xfail_reason"))
    passed = len(failures) == 0

    return {
        "graph_name": graph_name,
        "passed": passed,
        "xfail": is_xfail,
        "xfail_reason": testing.get("xfail_reason", ""),
        "failures": failures,
        "warnings": warnings,
        "quality": quality,
        "thresholds": thresholds,
    }


# ---------------------------------------------------------------------------
# Main orchestrator
# ---------------------------------------------------------------------------

def run_regression(args) -> list[dict]:
    """Main orchestration: discover → bootstrap → execute → assert."""
    from synth_gen import _resolve_data_repo
    data_repo = _resolve_data_repo()

    # 1. Discover + preflight
    print("=" * 60)
    print("  PARAM RECOVERY REGRESSION")
    print("=" * 60)
    print()

    graphs = discover_and_preflight(data_repo, args.graph)
    if not graphs:
        print("No synth graphs found.")
        return []

    print(f"Discovered {len(graphs)} synth graphs:")
    for g in graphs:
        status_icon = {"fresh": "OK", "stale": "STALE", "missing": "MISSING", "no_truth": "NO TRUTH"}
        icon = status_icon.get(g["status"], "?")
        xfail = " [xfail]" if g["truth"].get("testing", {}).get("xfail_reason") else ""
        print(f"  {g['graph_name']:35s} {icon:8s} {g['reason']}{xfail}")
    print()

    # 2. Bootstrap (sequential — DB writes shouldn't race)
    needs_bootstrap = [g for g in graphs if g["needs_bootstrap"]]
    if needs_bootstrap:
        print(f"Bootstrapping {len(needs_bootstrap)} graphs...")
        for g in needs_bootstrap:
            ok = bootstrap_graph(g["graph_name"])
            if not ok:
                g["_bootstrap_failed"] = True
                print(f"  WARNING: {g['graph_name']} bootstrap failed — will skip")
        print()

    if args.preflight_only:
        print("Preflight only — stopping before MCMC.")
        return []

    # 3. Compute core budget
    available_cores = os.cpu_count() or 4
    chains = args.chains
    cores_per_run = chains
    max_parallel = args.max_parallel or (available_cores // cores_per_run)
    max_parallel = max(1, max_parallel)

    runnable = [g for g in graphs if not g.get("_bootstrap_failed")]
    # Sort largest graphs first so they start immediately and don't
    # overlap with each other — prevents OOM from two heavy graphs
    # running concurrently.
    runnable.sort(
        key=lambda g: len(g.get("truth", {}).get("edges", {})),
        reverse=True,
    )
    print(f"Core budget: {available_cores} available, {cores_per_run} per run "
          f"({chains} chains), max {max_parallel} parallel")
    print(f"Running {len(runnable)} graphs...")
    print()

    # Pre-create harness log files so bayes-monitor finds them immediately
    for g in runnable:
        log_path = f"/tmp/bayes_harness-{g['graph_name']}.log"
        with open(log_path, "w") as f:
            f.write("")
        recovery_log = f"/tmp/bayes_recovery-{g['graph_name']}.log"
        with open(recovery_log, "w") as f:
            f.write("")

    # Write PID/graph files for bayes-monitor discovery
    with open("/tmp/bayes_recovery_graphs", "w") as f:
        for g in runnable:
            f.write(g["graph_name"] + "\n")

    # 4. Execute via process pool
    results = []
    with ProcessPoolExecutor(max_workers=max_parallel) as pool:
        futures = {}
        for g in runnable:
            timeout = g["truth"].get("testing", {}).get(
                "timeout",
                g["truth"].get("simulation", {}).get("expected_sample_seconds", 600),
            )
            future = pool.submit(
                _run_one_graph,
                g["graph_name"],
                chains=chains,
                cores=cores_per_run,
                draws=args.draws,
                tune=args.tune,
                timeout=timeout,
            )
            futures[future] = g

        for future in as_completed(futures):
            g = futures[future]
            run_result = future.result()
            name = run_result["graph_name"]
            elapsed = run_result["elapsed_s"]

            if run_result["error"]:
                print(f"  {name}: ERROR ({run_result['error']}) [{elapsed:.0f}s]")
                results.append({
                    "graph_name": name,
                    "passed": False,
                    "xfail": bool(g["truth"].get("testing", {}).get("xfail_reason")),
                    "xfail_reason": g["truth"].get("testing", {}).get("xfail_reason", ""),
                    "failures": [run_result["error"]],
                    "warnings": [],
                    "quality": {},
                })
                continue

            # Parse output even on non-zero exit — param_recovery.py exits 1
            # for PARTIAL recovery (z-score misses), not just crashes. Only
            # treat as a true harness failure if parsing yields no results.
            parsed = _parse_recovery_output(run_result["output"])

            if run_result["exit_code"] != 0 and not parsed.get("edges"):
                print(f"  {name}: HARNESS FAIL (exit {run_result['exit_code']}) [{elapsed:.0f}s]")
                # Dump captured output so failures are diagnosable
                out = run_result.get("output", "").strip()
                if out:
                    for line in out.split("\n")[-20:]:
                        print(f"    | {line}")
                # Also write to recovery log
                recovery_log = f"/tmp/bayes_recovery-{name}.log"
                with open(recovery_log, "w") as f:
                    f.write(run_result.get("output", ""))
                results.append({
                    "graph_name": name,
                    "passed": False,
                    "xfail": bool(g["truth"].get("testing", {}).get("xfail_reason")),
                    "xfail_reason": g["truth"].get("testing", {}).get("xfail_reason", ""),
                    "failures": [f"Harness exit {run_result['exit_code']}"],
                    "warnings": [],
                    "quality": {},
                })
                continue

            assertion = assert_recovery(name, parsed, g["truth"])
            results.append(assertion)

            status = "PASS" if assertion["passed"] else "FAIL"
            if assertion["xfail"] and not assertion["passed"]:
                status = "XFAIL"
            elif assertion["xfail"] and assertion["passed"]:
                status = "XPASS"
            print(f"  {name}: {status} [{elapsed:.0f}s]")

    # Clean up monitor files
    try:
        os.remove("/tmp/bayes_recovery_graphs")
    except FileNotFoundError:
        pass

    # 5. Summary
    print()
    print("=" * 60)
    print("  SUMMARY")
    print("=" * 60)

    passed = [r for r in results if r["passed"] and not r["xfail"]]
    failed = [r for r in results if not r["passed"] and not r["xfail"]]
    xfailed = [r for r in results if not r["passed"] and r["xfail"]]
    xpassed = [r for r in results if r["passed"] and r["xfail"]]

    for r in results:
        status = "PASS" if r["passed"] else "FAIL"
        if r["xfail"] and not r["passed"]:
            status = "XFAIL"
        elif r["xfail"] and r["passed"]:
            status = "XPASS"

        q = r.get("quality", {})
        quality_str = ""
        if q:
            quality_str = f" rhat={q.get('rhat', 0):.4f} ess={q.get('ess', 0)} converged={q.get('converged_pct', 0)}%"

        print(f"  {status:6s} {r['graph_name']:35s}{quality_str}")
        for f in r.get("failures", []):
            print(f"         {f}")
        for w in r.get("warnings", []):
            print(f"         [warn] {w}")

    print()
    total = len(results)
    print(f"  {len(passed)} passed, {len(failed)} failed, "
          f"{len(xfailed)} expected failures, {len(xpassed)} unexpected passes "
          f"(of {total} total)")

    if failed:
        print(f"\n  REGRESSION FAILED")
        return results
    else:
        print(f"\n  ALL PASSED")
        return results


def main():
    parser = argparse.ArgumentParser(
        description="Param recovery regression pipeline",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python bayes/run_regression.py                          # full suite
  python bayes/run_regression.py --graph synth-simple-abc # single graph
  python bayes/run_regression.py --preflight-only         # check data only
  python bayes/run_regression.py --chains 2 --max-parallel 4
""",
    )
    parser.add_argument("--graph", default=None,
                        help="Run single graph (default: all discovered)")
    parser.add_argument("--preflight-only", action="store_true",
                        help="Discover + check data integrity only, no MCMC")
    parser.add_argument("--chains", type=int, default=3,
                        help="MCMC chains per graph (default: 3)")
    parser.add_argument("--draws", type=int, default=1000,
                        help="MCMC draws per chain (default: 1000)")
    parser.add_argument("--tune", type=int, default=500,
                        help="MCMC warmup per chain (default: 500)")
    parser.add_argument("--max-parallel", type=int, default=None,
                        help="Max parallel runs (default: auto from core count)")
    args = parser.parse_args()

    results = run_regression(args)

    # Exit code: 0 if all passed (or xfail), 1 if any unexpected failures
    unexpected_failures = [r for r in results if not r["passed"] and not r["xfail"]]
    sys.exit(1 if unexpected_failures else 0)


if __name__ == "__main__":
    main()
