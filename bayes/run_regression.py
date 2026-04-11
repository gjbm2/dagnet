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

# Thread-pinning for BLAS/OpenMP (prevents oversubscription in parallel runs).
# PYTHONDONTWRITEBYTECODE: prevent stale .pyc from masking source edits.
_THREAD_PIN_ENV = {
    "OMP_NUM_THREADS": "1",
    "MKL_NUM_THREADS": "1",
    "OPENBLAS_NUM_THREADS": "1",
    "NUMBA_NUM_THREADS": "1",
    "PYTHONDONTWRITEBYTECODE": "1",
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
    feature_flags: list[str] | None = None,
    clean: bool = False,
    run_id: str = "",
    dsl_override: str | None = None,
) -> dict:
    """Run param_recovery.py for one graph. Returns parsed result dict.

    This is the function submitted to the process pool. It runs as a
    subprocess so that harness logs are written to /tmp/bayes_harness-{graph}.log
    (visible to bayes-monitor.sh).

    run_id binds this execution to a unique log file so parallel
    regression runs on the same machine don't cross-contaminate.
    """
    # Job label ties log file → audit. Without run_id, parallel
    # regressions overwrite each other's logs.
    job_label = f"{graph_name}-{run_id}" if run_id else graph_name

    cmd = [
        sys.executable,
        os.path.join(REPO_ROOT, "bayes", "param_recovery.py"),
        "--graph", graph_name,
        "--job-label", job_label,
        "--chains", str(chains),
        "--cores", str(cores),
        "--draws", str(draws),
        "--tune", str(tune),
        "--timeout", str(timeout),
    ]
    for ff in (feature_flags or []):
        cmd.extend(["--feature", ff])
    if clean:
        cmd.append("--clean")
    if dsl_override:
        cmd.extend(["--dsl-override", dsl_override])
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
    """Parse param_recovery.py output into structured results.

    Returns dict with:
        quality: {elapsed_s, rhat, ess, converged_pct}
        edges: {edge_name: {param: {truth, posterior_mean, posterior_sd, z_score, abs_error, status}}}
        slices: {ctx_label: {param: {truth, posterior_mean, posterior_sd, z_score, abs_error, status}}}
    """
    result: dict = {"quality": {}, "edges": {}, "slices": {}}

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
    in_slice_section = False
    current_slice_label = None
    for line in output.split("\n"):
        stripped = line.strip()

        # Detect entry into per-slice recovery section
        if "Per-slice recovery" in stripped:
            in_slice_section = True
            current_edge = None
            current_slice_label = None
            continue

        # Detect exit from per-slice section (the closing "===…" line)
        if in_slice_section and stripped.startswith("==="):
            in_slice_section = False
            continue

        if in_slice_section:
            # Per-slice section: headers are like "google (simple-a-to-b)"
            # i.e. "{val_id} ({edge_key})"
            slice_header = re.match(r"^(\S+)\s+\(([^)]+)\)\s*$", stripped)
            if slice_header:
                val_id = slice_header.group(1)
                edge_key = slice_header.group(2)
                current_slice_label = f"{val_id} ({edge_key})"
                continue

            if current_slice_label and "truth=" in stripped and "post=" in stripped:
                param_match = re.match(
                    r"(mu|sigma|onset|p)\s+truth=\s*([\d.]+)\s+post=\s*([\d.]+)±([\d.]+)\s+"
                    r"(?:Δ|z)=\s*([\d.]+)\s+\[(OK|MISS)\]",
                    stripped,
                )
                if param_match:
                    param = param_match.group(1)
                    truth_val = float(param_match.group(2))
                    post_mean = float(param_match.group(3))
                    post_sd = float(param_match.group(4))
                    delta_or_z = float(param_match.group(5))
                    status = param_match.group(6)

                    slice_data = result["slices"].setdefault(current_slice_label, {})
                    slice_data[param] = {
                        "truth": truth_val,
                        "posterior_mean": post_mean,
                        "posterior_sd": post_sd,
                        "z_score": abs(post_mean - truth_val) / post_sd if post_sd > 0 else 0,
                        "abs_error": abs(post_mean - truth_val),
                        "status": status,
                    }
                # Kappa line (informational, no truth)
                kappa_match = re.match(
                    r"kappa\s+post=\s*([\d.]+)±([\d.]+)", stripped,
                )
                if kappa_match:
                    slice_data = result["slices"].setdefault(current_slice_label, {})
                    slice_data["kappa"] = {
                        "posterior_mean": float(kappa_match.group(1)),
                        "posterior_sd": float(kappa_match.group(2)),
                    }
            continue

        # --- Edge-level recovery (original logic) ---
        # Edge header: "  simple-a-to-b" or "  simple-a-to-b (uncontexted parent)"
        if stripped and not stripped.startswith(("mu", "sigma", "onset", "kappa", "rhat", "─", "NO", "RECOVERY", "p ")):
            # Could be an edge name — possibly with suffix like "(uncontexted parent)"
            candidate = stripped
            if candidate and not candidate.startswith(("[", "Running", "GROUND", "Edge", "=", "HARNESS", "Per-slice")):
                # Extract the first token (edge name) — may have parenthetical suffix
                first_token = candidate.split()[0] if candidate.split() else ""
                if "-" in first_token and first_token[0].isalpha():
                    current_edge = first_token

        if current_edge and ("truth=" in stripped and "post=" in stripped):
            # Parse: "mu    truth=  2.300  post=  2.114±0.004     Δ=0.186  [OK]"
            param_match = re.match(
                r"(mu|sigma|onset|p)\s+truth=\s*([\d.]+)\s+post=\s*([\d.]+)±([\d.]+)\s+"
                r"(?:Δ|z)=\s*([\d.]+)\s+\[(OK|MISS)\]",
                stripped,
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


def _audit_harness_log(graph_name: str, job_label: str | None = None) -> dict:
    """Extract multi-layered audit from the harness log file.

    Locates the harness log file by job_label/graph_name, then delegates
    to audit.audit_log() for the actual parsing. See bayes/audit.py for
    the structured dict schema.
    """
    from audit import audit_log

    # Find log file — try job_label first (run-id-bound), then graph_name
    log_content = ""
    _labels = [job_label, graph_name] if job_label else [graph_name]
    _candidates = []
    for _lbl in _labels:
        _candidates.append(f"/tmp/bayes_harness-{_lbl}.log")
        _candidates.append(f"/tmp/bayes_harness-graph-{_lbl}.log")
    for log_path in _candidates:
        if os.path.isfile(log_path) and os.path.getsize(log_path) > 0:
            with open(log_path) as f:
                log_content = f.read()
            break

    return audit_log(log_content)


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

    # Per-slice z-score checks (doc 35 Phase 5)
    per_slice_thresholds = testing.get("per_slice_thresholds", {})
    p_slice_z = per_slice_thresholds.get("p_slice_z", 3.0)
    p_slice_abs_floor = per_slice_thresholds.get("p_slice_abs_floor", 0.10)
    slice_z_defaults = {
        "p": (p_slice_z, p_slice_abs_floor),
        "mu": (per_slice_thresholds.get("mu_slice_z", 3.0),
               per_slice_thresholds.get("mu_slice_abs_floor", 0.3)),
        "sigma": (per_slice_thresholds.get("sigma_slice_z", 3.5),
                  per_slice_thresholds.get("sigma_slice_abs_floor", 0.25)),
        "onset": (per_slice_thresholds.get("onset_slice_z", 3.5),
                  per_slice_thresholds.get("onset_slice_abs_floor", 0.3)),
    }

    for slice_label, slice_data in parsed.get("slices", {}).items():
        for param, pdata in slice_data.items():
            if param == "kappa":
                continue  # informational only

            z = pdata.get("z_score", 0)
            abs_err = pdata.get("abs_error", 0)
            z_threshold, abs_floor = slice_z_defaults.get(param, (3.0, 0.3))

            z_pass = z <= z_threshold
            abs_pass = abs_err <= abs_floor

            if not z_pass and not abs_pass:
                failures.append(
                    f"SLICE {slice_label} {param}: |z|={z:.2f} > {z_threshold} "
                    f"Δ={abs_err:.3f} > {abs_floor} "
                    f"(truth={pdata['truth']:.3f} post={pdata['posterior_mean']:.3f}"
                    f"±{pdata['posterior_sd']:.3f})"
                )
            elif not z_pass and abs_pass:
                warnings.append(
                    f"SLICE {slice_label} {param}: |z|={z:.2f} > {z_threshold} "
                    f"but Δ={abs_err:.3f} < {abs_floor} (abs floor pass)"
                )
            elif z > z_threshold * 0.8:
                warnings.append(
                    f"SLICE {slice_label} {param}: |z|={z:.2f} approaching threshold {z_threshold}"
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

    # Unique run ID — binds log files to this regression instance
    # so parallel runs don't cross-contaminate.
    run_id = f"r{int(time.time())}"

    # 1. Discover + preflight
    print("=" * 60)
    print("  PARAM RECOVERY REGRESSION")
    print("=" * 60)
    print()

    graphs = discover_and_preflight(data_repo, args.graph)
    if args.include:
        before = len(graphs)
        graphs = [g for g in graphs if args.include in g["graph_name"]]
        print(f"Included {len(graphs)} of {before} graphs matching '{args.include}'")
    if args.exclude:
        before = len(graphs)
        graphs = [g for g in graphs if args.exclude not in g["graph_name"]]
        print(f"Excluded {before - len(graphs)} graphs matching '{args.exclude}'")
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

    # Pre-create harness log files so bayes-monitor finds them immediately.
    # Use run_id-labelled paths to prevent cross-contamination.
    for g in runnable:
        job_label = f"{g['graph_name']}-{run_id}"
        for _prefix in [job_label, f"graph-{job_label}"]:
            log_path = f"/tmp/bayes_harness-{_prefix}.log"
            with open(log_path, "w") as f:
                f.write("")
        recovery_log = f"/tmp/bayes_recovery-{g['graph_name']}-{run_id}.log"
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
                feature_flags=getattr(args, 'feature', None) or None,
                clean=getattr(args, 'clean', False),
                run_id=run_id,
                dsl_override=getattr(args, 'dsl_override', None),
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
                recovery_log = f"/tmp/bayes_recovery-{name}-{run_id}.log"
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

            # Multi-layered audit from harness log (doc 34 §9.6)
            _job_label = f"{name}-{run_id}"
            audit = _audit_harness_log(name, job_label=_job_label)
            assertion = assert_recovery(name, parsed, g["truth"])
            assertion["audit"] = audit
            assertion["edges"] = parsed.get("edges", {})
            assertion["slices"] = parsed.get("slices", {})

            # Layer: log found
            if not audit["log_found"]:
                assertion["passed"] = False
                assertion["failures"].append("AUDIT: harness log not found or empty")

            # Layer: completion
            if audit["log_found"] and not audit["completed"]:
                assertion["warnings"].append("AUDIT: run did not reach completion status")

            # Layer: data binding
            db = audit["data_binding"]
            if db["fallback_edges"] > 0:
                assertion["passed"] = False
                assertion["failures"].append(
                    f"DATA BINDING: {db['fallback_edges']} edges used param file "
                    f"fallback (no snapshot data). Hash alignment broken.")
            if db["total_failed"] > 0:
                assertion["passed"] = False
                assertion["failures"].append(
                    f"DATA BINDING: {db['total_failed']} edges failed binding")

            # Layer: feature flags
            md = audit["model"]
            if md["latency_dispersion_flag"] and md["kappa_lat_edges"] == 0:
                assertion["passed"] = False
                assertion["failures"].append(
                    f"KAPPA_LAT: latency_dispersion=True but 0 kappa_lat variables. "
                    f"Check mixture path / stale cache.")

            # Layer: priors
            if audit["priors"]["edges_with_latency_prior"] == 0 and \
               audit["inference"]["edges_with_mu"] > 0:
                assertion["warnings"].append(
                    "PRIORS: no mu_prior lines found — priors may be uninformative")

            # Layer: LOO-ELPD
            loo = audit.get("loo", {})
            if loo.get("status") == "failed":
                assertion["warnings"].append(
                    f"LOO-ELPD: computation failed — "
                    f"{'; '.join(loo.get('diagnostics', []))}")
            elif loo.get("status") == "scored":
                pk = loo.get("worst_pareto_k", 0)
                if pk > 0.7:
                    assertion["warnings"].append(
                        f"LOO-ELPD: worst pareto_k={pk:.2f} > 0.7 — "
                        f"estimates unreliable for some data points")

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

    # 5. Verbose per-graph audit report
    print()
    print("=" * 60)
    print("  REGRESSION REPORT")
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

        audit = r.get("audit", {})
        q = r.get("quality", {})

        print()
        print(f"  ── {r['graph_name']} ── {status} ──")

        # Layer 0: DSL and subjects
        dsl = audit.get("dsl", "")
        if dsl:
            print(f"    0. DSL:            {dsl}")
            print(f"       Subjects:       {audit.get('subjects', '?')} snapshot, "
                  f"{audit.get('regimes', '?')} candidate regimes")

        # Layer 1: Completion
        if audit.get("log_found"):
            comp = "complete" if audit.get("completed") else "INCOMPLETE"
            print(f"    1. Completion:     {comp}")
        else:
            print(f"    1. Completion:     NO LOG FOUND")

        # Layer 2: Feature flags
        md = audit.get("model", {})
        flags = []
        if md.get("latency_dispersion_flag"):
            flags.append("latency_dispersion=True")
        if md.get("phase1_sampled"):
            flags.append("phase1_sampled")
        if md.get("phase2_sampled"):
            flags.append("phase2_sampled")
        print(f"    2. Feature flags:  {', '.join(flags) if flags else 'none detected'}")

        # --- Build reporting units: aggregate + per-slice ---
        # Discover context slices from audit data (binding + inference)
        db = audit.get("data_binding", {})
        inf = audit.get("inference", {})
        slice_ctx_keys: list[str] = []
        _seen_ctx = set()
        for sd in db.get("slice_details", []):
            ck = sd["ctx_key"]
            if ck not in _seen_ctx:
                _seen_ctx.add(ck)
                slice_ctx_keys.append(ck)
        for sp in inf.get("slice_details", []):
            ck = sp["ctx_key"]
            if ck not in _seen_ctx:
                _seen_ctx.add(ck)
                slice_ctx_keys.append(ck)

        reporting_units = ["__aggregate__"] + slice_ctx_keys

        for unit in reporting_units:
            is_aggregate = unit == "__aggregate__"
            indent = "    "

            if is_aggregate:
                if slice_ctx_keys:
                    print(f"\n    ── aggregate (edge-level) ──")
                # else: no slices, don't print a sub-header
            else:
                print(f"\n    ── {unit} ──")

            # Layer 3: Data binding
            if is_aggregate:
                snap = db.get("snapshot_edges", 0)
                fb = db.get("fallback_edges", 0)
                bound = db.get("total_bound", 0)
                bind_status = "OK" if fb == 0 and db.get("total_failed", 0) == 0 else "FAIL"
                print(f"{indent}3. Data binding:   {bind_status} — "
                      f"{snap} snapshot, {fb} fallback, {bound} bound, "
                      f"{db.get('total_failed', 0)} failed")
                for bd in db.get("binding_details", []):
                    v = bd["verdict"].upper()
                    tag = "ok" if v == "PASS" else ("!!" if v == "FAIL" else "~~")
                    print(f"{indent}   {tag} {bd['uuid']}… {v:4s} "
                          f"source={bd['source']:8s} "
                          f"rows: raw={bd['rows_raw']} regime={bd['rows_post_regime']} "
                          f"final={bd['rows_final']}")
            else:
                # Per-slice binding: filter slice_details to this ctx_key
                unit_slices = [sd for sd in db.get("slice_details", [])
                               if sd["ctx_key"] == unit]
                if unit_slices:
                    n_edges = len(unit_slices)
                    total_n = sum(sd["total_n"] for sd in unit_slices)
                    status_tag = "OK" if total_n > 0 else "WARN (no data)"
                    print(f"{indent}3. Data binding:   {status_tag} — {n_edges} edges with slice data")
                    for sd in unit_slices:
                        print(f"{indent}     {sd['uuid']}…: "
                              f"total_n={sd['total_n']} "
                              f"window={sd['window_n']} cohort={sd['cohort_n']}")
                else:
                    print(f"{indent}3. Data binding:   no slice binding data")

            # Layer 4: Priors
            if is_aggregate:
                priors = audit.get("priors", {})
                prior_details = priors.get("prior_details", [])
                seen_uuids: set = set()
                unique_priors = []
                for pd in prior_details:
                    if isinstance(pd, dict):
                        if pd["uuid"] not in seen_uuids:
                            seen_uuids.add(pd["uuid"])
                            unique_priors.append(pd)
                n_unique = len(unique_priors)
                prior_status = "OK" if n_unique > 0 else "WARN (none found)"
                print(f"{indent}4. Priors:         {prior_status} — {n_unique} edges with mu_prior")
                for pd in unique_priors:
                    print(f"{indent}     {pd['uuid']}… mu_prior={pd['mu_prior']:.3f}")
            else:
                # Per-slice: show hierarchical prior info from inference slice_details
                unit_sp = [sp for sp in inf.get("slice_details", [])
                           if sp["ctx_key"] == unit]
                if unit_sp:
                    print(f"{indent}4. Priors:         hierarchical — {len(unit_sp)} edges (per-slice)")
                else:
                    print(f"{indent}4. Priors:         (shared with aggregate)")

            # Layer 5: kappa_lat
            if is_aggregate:
                kl = md.get("kappa_lat_edges", 0)
                if md.get("latency_dispersion_flag"):
                    kl_status = "OK" if kl > 0 else "FAIL (flag on, 0 variables)"
                else:
                    kl_status = f"N/A (flag off)" if kl == 0 else f"OK ({kl} edges)"
                print(f"{indent}5. kappa_lat:      {kl_status} — {kl} edges")
            else:
                # Per-slice kappa_lat from inference slice_details
                unit_sp = [sp for sp in inf.get("slice_details", [])
                           if sp["ctx_key"] == unit]
                kl_count = sum(1 for sp in unit_sp if "kappa_lat_mean" in sp)
                if kl_count > 0:
                    print(f"{indent}5. kappa_lat:      {kl_count} edges (per-slice)")
                else:
                    print(f"{indent}5. kappa_lat:      (shared with aggregate)")

            # Layer 6: Convergence (always shared — single MCMC run)
            rhat = q.get("rhat", 0)
            ess = q.get("ess", 0)
            conv = q.get("converged_pct", 0)
            if is_aggregate:
                print(f"{indent}6. Convergence:    rhat={rhat:.4f} ess={ess} converged={conv}%")
            else:
                print(f"{indent}6. Convergence:    (shared) rhat={rhat:.4f} ess={ess} converged={conv}%")

            # Layer 7: Parameter recovery
            if is_aggregate:
                recovery_edges = r.get("edges", {})
                if recovery_edges:
                    print(f"{indent}7. Recovery:       {len(recovery_edges)} edges")
                    kl_by_uuid = {}
                    for md_entry in inf.get("mu_details", []):
                        if "kappa_lat" in md_entry:
                            kl_by_uuid[md_entry["uuid"]] = md_entry
                    for edge_name, params in recovery_edges.items():
                        print(f"{indent}     {edge_name}:")
                        for param, pdata in params.items():
                            truth_val = pdata.get("truth", 0)
                            post_mean = pdata.get("posterior_mean", 0)
                            post_sd = pdata.get("posterior_sd", 0)
                            abs_err = pdata.get("abs_error", 0)
                            z = pdata.get("z_score", 0)
                            tag = "ok" if pdata.get("status") == "OK" else "!!"
                            print(f"{indent}       {tag} {param:6s} "
                                  f"truth={truth_val:7.3f}  "
                                  f"post={post_mean:7.3f}±{post_sd:.3f}  "
                                  f"Δ={abs_err:.3f}  z={z:.1f}")
                        for uuid_prefix, kl_data in kl_by_uuid.items():
                            if uuid_prefix in edge_name or edge_name in str(kl_data):
                                kl_sd = f"±{kl_data['kappa_lat_sd']:.0f}" if "kappa_lat_sd" in kl_data else ""
                                print(f"{indent}          kappa_lat={kl_data['kappa_lat']:.0f}{kl_sd}  "
                                      f"ess={kl_data['ess']}")
                                break
                else:
                    print(f"{indent}7. Recovery:       no parsed results")
            else:
                # Per-slice recovery from parsed slices
                recovery_slices = r.get("slices", {})
                # Match slice labels: format is "val_id (edge_key)" — filter by ctx_key
                # The ctx_key is like "context(dim:val)" — extract val_id from it
                # e.g. "context(synth-channel:google)" → "google"
                import re as _re
                ctx_val_match = _re.search(r":([^)]+)\)$", unit)
                ctx_val = ctx_val_match.group(1) if ctx_val_match else ""
                unit_recovery = {k: v for k, v in recovery_slices.items()
                                 if k.startswith(f"{ctx_val} (")}
                if unit_recovery:
                    print(f"{indent}7. Recovery:       {len(unit_recovery)} slice entries")
                    for label, params in unit_recovery.items():
                        print(f"{indent}     {label}:")
                        for param, pdata in params.items():
                            if param == "kappa":
                                print(f"{indent}       .. kappa   "
                                      f"post={pdata.get('posterior_mean', 0):7.1f}"
                                      f"±{pdata.get('posterior_sd', 0):.1f}")
                                continue
                            truth_val = pdata.get("truth", 0)
                            post_mean = pdata.get("posterior_mean", 0)
                            post_sd = pdata.get("posterior_sd", 0)
                            abs_err = pdata.get("abs_error", 0)
                            z = pdata.get("z_score", 0)
                            tag = "ok" if pdata.get("status") == "OK" else "!!"
                            print(f"{indent}       {tag} {param:6s} "
                                  f"truth={truth_val:7.3f}  "
                                  f"post={post_mean:7.3f}±{post_sd:.3f}  "
                                  f"Δ={abs_err:.3f}  z={z:.1f}")
                else:
                    # Show inference posteriors if recovery isn't available
                    unit_sp = [sp for sp in inf.get("slice_details", [])
                               if sp["ctx_key"] == unit]
                    if unit_sp:
                        print(f"{indent}7. Recovery:       {len(unit_sp)} edges (inference only)")
                        for sp in unit_sp:
                            lat_str = ""
                            if "mu_mean" in sp:
                                lat_str = (f" mu={sp['mu_mean']:.3f}±{sp['mu_sd']:.3f}"
                                           f" sigma={sp.get('sigma_mean', 0):.3f}")
                            kl_str = ""
                            if "kappa_lat_mean" in sp:
                                kl_str = f" kappa_lat={sp['kappa_lat_mean']:.0f}±{sp['kappa_lat_sd']:.0f}"
                            print(f"{indent}     {sp['uuid']}…: "
                                  f"p={sp['p_mean']:.3f}±{sp['p_sd']:.3f} "
                                  f"HDI=[{sp['p_hdi_lower']:.3f}, {sp['p_hdi_upper']:.3f}]"
                                  f"{lat_str}{kl_str}")
                    else:
                        print(f"{indent}7. Recovery:       no per-slice data")

            # Layer 8: LOO-ELPD
            if is_aggregate:
                loo = audit.get("loo", {})
                loo_status = loo.get("status", "not_run")
                if loo_status == "scored":
                    pk = loo["worst_pareto_k"]
                    pk_warn = " UNRELIABLE" if pk > 0.7 else ""
                    print(f"{indent}8. LOO-ELPD:       {loo['edges_scored']} edges scored, "
                          f"ΔELPD={loo['total_delta_elpd']:.1f}, "
                          f"worst_pareto_k={pk:.2f}{pk_warn}")
                elif loo_status == "failed":
                    print(f"{indent}8. LOO-ELPD:       FAILED")
                    for d in loo.get("diagnostics", []):
                        print(f"{indent}     {d}")
                else:
                    print(f"{indent}8. LOO-ELPD:       not run")
            else:
                # Per-slice LOO (doc 35 Phase 3)
                loo = audit.get("loo", {})
                slice_loo_details = loo.get("slice_details", [])
                # Match: unit="context(dim:val)" → ctx_safe contains the safe version
                # The ctx_safe in LOO uses _safe_var_name which replaces non-alphanum with _
                unit_safe = re.sub(r'[^a-zA-Z0-9]', '_', unit).strip('_')
                matched_loo = [sd for sd in slice_loo_details
                               if sd["ctx_safe"] == unit_safe
                               or unit_safe.startswith(sd["ctx_safe"].rstrip('_'))]
                if matched_loo:
                    sd = matched_loo[0]
                    pk = sd["worst_pareto_k"]
                    pk_warn = " UNRELIABLE" if pk > 0.7 else ""
                    print(f"{indent}8. LOO-ELPD:       {sd['edges']} edges (per-slice), "
                          f"ΔELPD={sd['delta_elpd']:.1f}, "
                          f"worst_pareto_k={pk:.2f}{pk_warn}")
                else:
                    print(f"{indent}8. LOO-ELPD:       (no per-slice LOO data)")

        # Parameter recovery failures/warnings
        for f in r.get("failures", []):
            print(f"    ** FAIL: {f}")
        for w in r.get("warnings", []):
            print(f"    ** WARN: {w}")

    # Totals
    print()
    print("-" * 60)
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
    parser.add_argument("--include", default=None,
                        help="Include only graphs matching this substring (e.g. --include context)")
    parser.add_argument("--exclude", default=None,
                        help="Exclude graphs matching this substring (e.g. --exclude context)")
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
    parser.add_argument("--feature", action="append", default=[],
                        help="Model feature flag KEY=VALUE, forwarded to param_recovery.py "
                             "(e.g. --feature latency_dispersion=true)")
    parser.add_argument("--clean", action="store_true",
                        help="Clear bytecode + synth meta caches before each graph run")
    parser.add_argument("--dsl-override", type=str, default=None,
                        help="Override pinnedDSL for all graphs (forwarded to param_recovery.py)")
    args = parser.parse_args()

    results = run_regression(args)

    # Exit code: 0 if all passed (or xfail), 1 if any unexpected failures
    unexpected_failures = [r for r in results if not r["passed"] and not r["xfail"]]
    sys.exit(1 if unexpected_failures else 0)


if __name__ == "__main__":
    main()
