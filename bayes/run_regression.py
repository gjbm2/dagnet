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

from recovery_slices import (
    iter_expected_single_slice_specs,
    make_slice_label,
    parse_slice_label,
)

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
    env = {**os.environ, "PYTHONPATH": REPO_ROOT}
    result = subprocess.run(
        cmd, capture_output=True, text=True, timeout=timeout, cwd=REPO_ROOT,
        env=env,
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
    rebuild: bool = False,
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
    if rebuild:
        cmd.append("--rebuild")
    if dsl_override:
        cmd.extend(["--dsl-override", dsl_override])
    _jax = any(f.startswith("jax_backend=t") for f in (feature_flags or []))
    if _jax:
        _ncpu = str(os.cpu_count() or 16)
        env = {**os.environ,
               "PYTHONDONTWRITEBYTECODE": "1",
               "XLA_FLAGS": "--xla_cpu_multi_thread_eigen=true",
               "OMP_NUM_THREADS": _ncpu,
               "MKL_NUM_THREADS": _ncpu,
               "OPENBLAS_NUM_THREADS": _ncpu,
               }
    else:
        env = {**os.environ, **_THREAD_PIN_ENV}

    t0 = time.time()
    try:
        _sub_timeout = None if timeout == 0 else timeout + 120
        result = subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=_sub_timeout,
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

def _describe_outcome(r: dict) -> tuple[str, str]:
    """Return (status, verdict) for stdout / summary display.

    Replaces the legacy PASS/FAIL binary — regression runs are calibration
    probes, not tests. See results_schema.classify_status and
    classify_quality for field definitions.

    Returns:
        status:  "FAIL" | "COMPLETED" | "XFAIL"
        verdict: quality verdict string when COMPLETED, empty when FAIL,
                 xfail reason when XFAIL
    """
    from results_schema import (
        classify_status,
        classify_quality,
        compute_bias_profile,
    )
    quality = r.get("quality", {}) or {}
    failures = r.get("failures", []) or []
    edges = r.get("parsed_edges", r.get("edges", {}))
    slices = r.get("parsed_slices", r.get("slices", {}))
    bias = compute_bias_profile(edges, slices)
    status = classify_status(r.get("passed", False), failures, quality)

    if status == "fail":
        if r.get("xfail"):
            return "XFAIL", r.get("xfail_reason", "")
        return "FAIL", ""

    # status == "completed"
    cls = classify_quality(quality, bias, failures)
    verdict = cls.get("verdict", "clean")
    if r.get("xfail"):
        return "XFAIL", f"expected — {r.get('xfail_reason', '')}"
    return "COMPLETED", verdict


def _extract_traceback(output: str) -> tuple[str, str]:
    """Extract a Python traceback block (if any) from subprocess output.

    Returns (block, summary):
      block: the full traceback text starting at "Traceback (most recent call last):"
             through the final exception line, or "" if none found.
      summary: a one-line summary like "ValueError: too many values to unpack"
               suitable for the plan output headline, or "" if none found.

    When multiple tracebacks exist, the LAST one is returned (usually the
    outermost/final failure).
    """
    if not output:
        return "", ""
    lines = output.splitlines()
    # Find the last "Traceback (most recent call last):" marker
    start_idx = -1
    for i in range(len(lines) - 1, -1, -1):
        if lines[i].lstrip().startswith("Traceback (most recent call last):"):
            start_idx = i
            break
    if start_idx < 0:
        return "", ""
    # Walk forward until we find a non-indented line that looks like an
    # exception class (e.g. "ValueError: ..."). Subprocess stderr and
    # indented traceback frames continue until that line.
    end_idx = start_idx
    import re as _re
    exc_re = _re.compile(r"^[A-Z][A-Za-z0-9_.]*(Error|Exception|Exit|Warning)[^:]*:")
    for j in range(start_idx + 1, len(lines)):
        if lines[j] and not lines[j].startswith(" ") and exc_re.match(lines[j]):
            end_idx = j
            break
        end_idx = j
    # Trim trailing blank lines
    block_lines = lines[start_idx : end_idx + 1]
    while block_lines and not block_lines[-1].strip():
        block_lines.pop()
    block = "\n".join(block_lines)
    # Summary: the last line is usually "ExceptionClass: message".
    summary = ""
    for line in reversed(block_lines):
        if exc_re.match(line.strip()):
            summary = line.strip()
            break
    return block, summary


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
            # Per-slice section headers use the full context key plus edge key.
            slice_header = re.match(r"^(.*?)\s+::\s+(.+?)\s*$", stripped)
            if slice_header:
                current_slice_label = make_slice_label(
                    slice_header.group(1),
                    slice_header.group(2),
                )
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


def assert_recovery(
    graph_name: str,
    parsed: dict,
    truth: dict,
    empty_slices: list[dict] | None = None,
) -> dict:
    """Apply tiered assertions. Returns dict with pass/fail and details.

    Failures and warnings are structured dicts (see results_schema.make_failure).
    Each has a `message` field for human-readable display.

    empty_slices: declared (edge_id, slice_key) combos that bootstrap
    recorded as zero-row (legitimate sparsity outcome). Recovery must
    skip them — absence of a posterior for a slice with no data is
    expected, not a missing_slice defect.
    """
    from results_schema import make_failure
    empty_slices = empty_slices or []

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
        failures.append(make_failure(
            "convergence",
            f"rhat={rhat:.4f} > {thresholds['rhat_max']}",
            metric="rhat", value=rhat, threshold=thresholds["rhat_max"],
        ))

    ess = quality.get("ess", 0)
    if ess < thresholds["min_ess"]:
        failures.append(make_failure(
            "convergence",
            f"ESS={ess} < {thresholds['min_ess']}",
            metric="ess", value=ess, threshold=thresholds["min_ess"],
        ))

    converged = quality.get("converged_pct", 0)
    if converged < thresholds["min_converged_pct"]:
        failures.append(make_failure(
            "convergence",
            f"converged={converged}% < {thresholds['min_converged_pct']}%",
            metric="converged_pct", value=converged,
            threshold=thresholds["min_converged_pct"],
        ))

    # Expected recovery surface from the truth file.
    # New-format truth files may carry structural entries without params.
    truth_edges = {
        edge_name: edge_truth
        for edge_name, edge_truth in truth.get("edges", {}).items()
        if isinstance(edge_truth, dict) and edge_truth.get("p") is not None
    }
    parsed_edges = parsed.get("edges", {})
    parsed_slices = parsed.get("slices", {})

    missing_edges = sorted(set(truth_edges) - set(parsed_edges))
    if missing_edges:
        failures.append(make_failure(
            "missing_edge",
            f"missing recovery rows for {len(missing_edges)} truth edge(s): "
            + ", ".join(missing_edges),
            count=len(missing_edges), items=missing_edges,
        ))

    unexpected_edges = sorted(set(parsed_edges) - set(truth_edges))
    if unexpected_edges:
        warnings.append(make_failure(
            "missing_edge",
            f"unexpected parsed recovery rows for edge(s): {', '.join(unexpected_edges)}",
            items=unexpected_edges,
        ))

    for edge_name, edge_truth in truth_edges.items():
        edge_data = parsed_edges.get(edge_name)
        if edge_data is None:
            continue

        # Zero-latency (instant) edges have mu=0, sigma=0, onset=0 — the model
        # doesn't create latency RVs for these, so don't expect them in recovery.
        _is_instant = (
            edge_truth.get("mu") == 0
            and edge_truth.get("sigma") == 0
            and edge_truth.get("onset") == 0
        )
        expected_params = [
            param for param in ("p", "mu", "sigma", "onset")
            if edge_truth.get(param) is not None
            and not (_is_instant and param in ("mu", "sigma", "onset"))
        ]
        missing_params = [param for param in expected_params if param not in edge_data]
        if missing_params:
            failures.append(make_failure(
                "missing_param",
                f"{edge_name}: missing parsed recovery param(s): {', '.join(missing_params)}",
                edge=edge_name, items=missing_params,
            ))

    # Per-parameter z-score checks
    for edge_name, edge_data in parsed_edges.items():
        if edge_name not in truth_edges:
            continue
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

            _common = dict(
                edge=edge_name, param=param,
                z_score=z, threshold=z_threshold,
                abs_error=abs_err, abs_floor=abs_floor,
                truth=pdata.get("truth"),
                posterior_mean=pdata.get("posterior_mean"),
                posterior_sd=pdata.get("posterior_sd"),
            )

            if not z_pass and not abs_pass:
                failures.append(make_failure(
                    "z_score",
                    f"{edge_name} {param}: |z|={z:.2f} > {z_threshold} "
                    f"Δ={abs_err:.3f} > {abs_floor} "
                    f"(truth={pdata['truth']:.3f} post={pdata['posterior_mean']:.3f}±{pdata['posterior_sd']:.3f})",
                    **_common,
                ))
            elif not z_pass and abs_pass:
                warnings.append(make_failure(
                    "z_score",
                    f"{edge_name} {param}: |z|={z:.2f} > {z_threshold} but Δ={abs_err:.3f} < {abs_floor} (abs floor pass)",
                    **_common,
                ))
            elif z > z_threshold * 0.8:
                warnings.append(make_failure(
                    "z_score",
                    f"{edge_name} {param}: |z|={z:.2f} approaching threshold {z_threshold}",
                    **_common,
                ))

    # Per-slice expected coverage from context truth.
    expected_slice_labels = {
        spec["label"]: spec["truth"]
        for spec in iter_expected_single_slice_specs(truth)
    }

    # Drop declared slices the sparsity model left at zero rows — a
    # legitimate no-data outcome where the model has nothing to fit.
    # Absence of a posterior for a zero-row slice is expected, not a
    # pipeline defect.
    #
    # empty_slices entries: {edge_id, param_id, slice_key}.
    # expected_slice_labels keys: "{ctx_key} :: {edge_key}".
    # Convert by stripping .window()/.cohort() from slice_key and
    # pairing with param_id (which matches edge_key in the truth).
    empty_slice_labels: set[str] = set()
    for es in empty_slices:
        sk = es.get("slice_key", "")
        pid = es.get("param_id", "")
        # slice_key is "context(dim:val).window()" or ...cohort()
        ctx_key = sk.rsplit(".", 1)[0] if "." in sk else sk
        # edge_key in truth strips any "parameter-" prefix on param_id
        edge_key = pid[len("parameter-"):] if pid.startswith("parameter-") else pid
        from recovery_slices import make_slice_label
        empty_slice_labels.add(make_slice_label(ctx_key, edge_key))

    if empty_slice_labels:
        warnings.append(make_failure(
            "audit",
            f"{len(empty_slice_labels)} declared slice(s) had zero emitted rows "
            f"(sparsity outcome; recovery skipped): "
            + ", ".join(sorted(empty_slice_labels)),
            count=len(empty_slice_labels), items=sorted(empty_slice_labels),
        ))

    # Remove empty slices from the expected set so they don't register
    # as missing.
    effective_expected = {
        label: t for label, t in expected_slice_labels.items()
        if label not in empty_slice_labels
    }

    if effective_expected and not parsed_slices:
        failures.append(make_failure(
            "missing_slice",
            "missing per-slice recovery rows for contexted truth",
        ))

    missing_slice_labels = sorted(set(effective_expected) - set(parsed_slices))
    if missing_slice_labels:
        failures.append(make_failure(
            "missing_slice",
            f"missing slice recovery rows for {len(missing_slice_labels)} expected slice(s): "
            + ", ".join(missing_slice_labels),
            count=len(missing_slice_labels), items=missing_slice_labels,
        ))

    for slice_label, edge_truth in expected_slice_labels.items():
        slice_data = parsed_slices.get(slice_label)
        if slice_data is None:
            continue
        _is_instant = (
            edge_truth.get("mu") == 0
            and edge_truth.get("sigma") == 0
            and edge_truth.get("onset") == 0
        )
        expected_params = [
            param for param in ("p", "mu", "sigma", "onset")
            if edge_truth.get(param) is not None
            and not (_is_instant and param in ("mu", "sigma", "onset"))
        ]
        missing_params = [param for param in expected_params if param not in slice_data]
        if missing_params:
            failures.append(make_failure(
                "missing_param",
                f"SLICE {slice_label}: missing parsed recovery param(s): "
                + ", ".join(missing_params),
                slice=slice_label, items=missing_params,
            ))

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

    for slice_label, slice_data in parsed_slices.items():
        for param, pdata in slice_data.items():
            if param == "kappa":
                continue  # informational only

            z = pdata.get("z_score", 0)
            abs_err = pdata.get("abs_error", 0)
            z_threshold, abs_floor = slice_z_defaults.get(param, (3.0, 0.3))

            z_pass = z <= z_threshold
            abs_pass = abs_err <= abs_floor

            _common = dict(
                slice=slice_label, param=param,
                z_score=z, threshold=z_threshold,
                abs_error=abs_err, abs_floor=abs_floor,
                truth=pdata.get("truth"),
                posterior_mean=pdata.get("posterior_mean"),
                posterior_sd=pdata.get("posterior_sd"),
            )

            if not z_pass and not abs_pass:
                failures.append(make_failure(
                    "z_score",
                    f"SLICE {slice_label} {param}: |z|={z:.2f} > {z_threshold} "
                    f"Δ={abs_err:.3f} > {abs_floor} "
                    f"(truth={pdata['truth']:.3f} post={pdata['posterior_mean']:.3f}"
                    f"±{pdata['posterior_sd']:.3f})",
                    **_common,
                ))
            elif not z_pass and abs_pass:
                warnings.append(make_failure(
                    "z_score",
                    f"SLICE {slice_label} {param}: |z|={z:.2f} > {z_threshold} "
                    f"but Δ={abs_err:.3f} < {abs_floor} (abs floor pass)",
                    **_common,
                ))
            elif z > z_threshold * 0.8:
                warnings.append(make_failure(
                    "z_score",
                    f"SLICE {slice_label} {param}: |z|={z:.2f} approaching threshold {z_threshold}",
                    **_common,
                ))

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
        "parsed_edges": parsed_edges,
        "parsed_slices": parsed_slices,
    }


def _bias_profile(parsed_edges: dict, parsed_slices: dict) -> str:
    """Build a descriptive per-parameter bias profile from recovery data.

    Returns a multi-line string summarising systematic patterns:
    mean bias, max |z|, and whether bias direction is consistent.
    Covers both edge-level and slice-level parameters.
    """
    from collections import defaultdict
    # Collect signed errors per parameter across all edges + slices
    param_errors: dict[str, list[tuple[str, float, float, float, float]]] = defaultdict(list)
    # (label, signed_error, z_score, truth, posterior_mean)

    for edge_name, edge_data in parsed_edges.items():
        for param, pdata in edge_data.items():
            if param == "kappa":
                continue
            truth = pdata.get("truth")
            post = pdata.get("posterior_mean")
            sd = pdata.get("posterior_sd", 0)
            z = pdata.get("z_score", 0)
            if truth is not None and post is not None:
                param_errors[param].append(
                    (edge_name, post - truth, z, truth, post))

    for slice_label, slice_data in parsed_slices.items():
        for param, pdata in slice_data.items():
            if param == "kappa":
                continue
            truth = pdata.get("truth")
            post = pdata.get("posterior_mean")
            sd = pdata.get("posterior_sd", 0)
            z = pdata.get("z_score", 0)
            if truth is not None and post is not None:
                param_errors[f"{param}(slice)"].append(
                    (slice_label, post - truth, z, truth, post))

    if not param_errors:
        return ""

    lines = []
    for param in ["p", "mu", "sigma", "onset",
                   "p(slice)", "mu(slice)", "sigma(slice)", "onset(slice)"]:
        errs = param_errors.get(param)
        if not errs:
            continue
        signed = [e[1] for e in errs]
        zscores = [e[2] for e in errs]
        n = len(signed)
        mean_bias = sum(signed) / n
        n_pos = sum(1 for s in signed if s > 0)
        n_neg = n - n_pos
        max_z = max(zscores)
        max_z_entry = max(errs, key=lambda e: e[2])
        direction = "+" if n_pos > n_neg else "-" if n_neg > n_pos else "~"
        consistency = f"{max(n_pos, n_neg)}/{n}"

        lines.append(
            f"    {param:<14s} n={n:<3d} bias={mean_bias:+.3f} "
            f"dir={direction}({consistency})  max|z|={max_z:.1f} "
            f"({max_z_entry[0]})")

    if not lines:
        return ""
    return "  Bias profile:\n" + "\n".join(lines) + "\n"


def _aggregate_bias_profile(all_results: list[dict]) -> str:
    """Cross-graph aggregate bias profile from all regression results."""
    from collections import defaultdict
    param_all: dict[str, list[float]] = defaultdict(list)
    param_z: dict[str, list[float]] = defaultdict(list)

    for r in all_results:
        for edge_data in r.get("parsed_edges", {}).values():
            for param, pdata in edge_data.items():
                if param == "kappa":
                    continue
                truth = pdata.get("truth")
                post = pdata.get("posterior_mean")
                if truth is not None and post is not None:
                    param_all[param].append(post - truth)
                    param_z[param].append(pdata.get("z_score", 0))
        for slice_data in r.get("parsed_slices", {}).values():
            for param, pdata in slice_data.items():
                if param == "kappa":
                    continue
                truth = pdata.get("truth")
                post = pdata.get("posterior_mean")
                if truth is not None and post is not None:
                    param_all[f"{param}(slice)"].append(post - truth)
                    param_z[f"{param}(slice)"].append(pdata.get("z_score", 0))

    if not param_all:
        return ""

    lines = []
    lines.append("=" * 70)
    lines.append("  AGGREGATE BIAS PROFILE (across all graphs)")
    lines.append("=" * 70)
    for param in ["p", "mu", "sigma", "onset",
                   "p(slice)", "mu(slice)", "sigma(slice)", "onset(slice)"]:
        errs = param_all.get(param)
        if not errs:
            continue
        zs = param_z[param]
        n = len(errs)
        mean_bias = sum(errs) / n
        median_bias = sorted(errs)[n // 2]
        n_pos = sum(1 for e in errs if e > 0)
        max_z = max(zs)
        mean_z = sum(zs) / n
        direction = "+" if n_pos > n // 2 + 1 else "-" if n_pos < n // 2 - 1 else "~"

        lines.append(
            f"  {param:<14s} n={n:<4d} mean_bias={mean_bias:+.4f} "
            f"median={median_bias:+.4f}  dir={direction}({n_pos}/{n} +ve)  "
            f"mean|z|={mean_z:.2f}  max|z|={max_z:.1f}")

    return "\n".join(lines) + "\n"


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

    # Incremental summary file — written after each graph completes.
    # Survives kill/crash, unlike the in-memory results list.
    summary_path = f"/tmp/bayes_regression-{run_id}.summary"
    with open(summary_path, "w") as f:
        f.write(f"# Regression {run_id}\n")
        f.write(f"# Started: {time.strftime('%d-%b-%y %H:%M')}\n")
        f.write(f"# Features: {getattr(args, 'feature', [])}\n")
        f.write(f"# Sampling: {args.chains} chains, {args.draws} draws, "
                f"{args.tune} tune\n\n")

    # 1. Discover + preflight
    print("=" * 60)
    print("  PARAM RECOVERY REGRESSION")
    print("=" * 60)
    print(f"  Run ID:  {run_id}")
    print(f"  Summary: {summary_path}")
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
            if getattr(args, 'no_timeout', False):
                timeout = 0
            else:
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
                rebuild=getattr(args, 'rebuild', False),
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
                with open(summary_path, "a") as _sf:
                    _sf.write(f"{name:<45s} ERROR  {elapsed:6.0f}s  "
                              f"{run_result['error']}\n")
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
                # Extract Python traceback from stdout/stderr if present so
                # the root cause surfaces in the plan summary instead of
                # being buried in 40KB per-graph harness logs.
                out = run_result.get("output", "")
                tb_block, tb_summary = _extract_traceback(out)

                headline = (
                    f"HARNESS FAIL (exit {run_result['exit_code']})"
                    + (f": {tb_summary}" if tb_summary else "")
                )
                print(f"  {name}: {headline} [{elapsed:.0f}s]")
                with open(summary_path, "a") as _sf:
                    _sf.write(f"{name:<45s} FAIL   {elapsed:6.0f}s  "
                              f"{headline}\n")
                # Print the traceback block directly (root cause is surfaced,
                # not buried). Fall back to last 20 lines if none.
                if tb_block:
                    for line in tb_block.splitlines():
                        print(f"    | {line}")
                elif out.strip():
                    for line in out.strip().split("\n")[-20:]:
                        print(f"    | {line}")
                # Also write full output to recovery log
                recovery_log = f"/tmp/bayes_recovery-{name}-{run_id}.log"
                with open(recovery_log, "w") as f:
                    f.write(out)

                from results_schema import make_failure as _mf
                _fail = _mf(
                    "harness",
                    tb_summary or f"Harness exit {run_result['exit_code']}",
                )
                if tb_block:
                    _fail["traceback"] = tb_block
                _fail["exit_code"] = run_result["exit_code"]
                _fail["harness_log"] = recovery_log

                results.append({
                    "graph_name": name,
                    "passed": False,
                    "xfail": bool(g["truth"].get("testing", {}).get("xfail_reason")),
                    "xfail_reason": g["truth"].get("testing", {}).get("xfail_reason", ""),
                    "failures": [_fail],
                    "warnings": [],
                    "quality": {},
                })
                continue

            # Multi-layered audit from harness log (doc 34 §9.6)
            _job_label = f"{name}-{run_id}"
            audit = _audit_harness_log(name, job_label=_job_label)
            # Load empty_slices from meta so assert_recovery can skip
            # declared slices the sparsity model left at zero rows
            # (legitimate no-data outcome, not a pipeline defect).
            _empty_slices = []
            try:
                _meta_path = os.path.join(
                    data_repo, "graphs", f"{name}.synth-meta.json"
                )
                if os.path.isfile(_meta_path):
                    with open(_meta_path) as _mf:
                        _empty_slices = json.load(_mf).get("empty_slices", [])
            except (OSError, json.JSONDecodeError):
                pass
            assertion = assert_recovery(name, parsed, g["truth"],
                                        empty_slices=_empty_slices)
            assertion["audit"] = audit
            assertion["edges"] = parsed.get("edges", {})
            assertion["slices"] = parsed.get("slices", {})
            assertion["truth_config"] = g["truth"]

            from results_schema import make_failure as _mf

            # Layer: log found
            if not audit["log_found"]:
                assertion["passed"] = False
                assertion["failures"].append(_mf(
                    "audit", "AUDIT: harness log not found or empty"))

            # Layer: completion
            if audit["log_found"] and not audit["completed"]:
                assertion["warnings"].append(_mf(
                    "audit", "AUDIT: run did not reach completion status"))

            # Layer: data binding
            db = audit["data_binding"]
            if db["fallback_edges"] > 0:
                assertion["passed"] = False
                assertion["failures"].append(_mf(
                    "binding",
                    f"DATA BINDING: {db['fallback_edges']} edges used param file "
                    f"fallback (no snapshot data). Hash alignment broken.",
                    count=db["fallback_edges"],
                ))
            if db["total_failed"] > 0:
                assertion["passed"] = False
                assertion["failures"].append(_mf(
                    "binding",
                    f"DATA BINDING: {db['total_failed']} edges failed binding",
                    count=db["total_failed"],
                ))

            # Layer: feature flags
            md = audit["model"]
            if md["latency_dispersion_flag"] and md["kappa_lat_edges"] == 0:
                assertion["passed"] = False
                assertion["failures"].append(_mf(
                    "audit",
                    "KAPPA_LAT: latency_dispersion=True but 0 kappa_lat variables. "
                    "Check mixture path / stale cache.",
                ))

            # Layer: priors
            if audit["priors"]["edges_with_latency_prior"] == 0 and \
               audit["inference"]["edges_with_mu"] > 0:
                assertion["warnings"].append(_mf(
                    "audit",
                    "PRIORS: no mu_prior lines found — priors may be uninformative",
                ))

            # Layer: LOO-ELPD
            loo = audit.get("loo", {})
            if loo.get("status") == "failed":
                assertion["warnings"].append(_mf(
                    "audit",
                    f"LOO-ELPD: computation failed — "
                    f"{'; '.join(loo.get('diagnostics', []))}",
                ))
            elif loo.get("status") == "scored":
                pk = loo.get("worst_pareto_k", 0)
                if pk > 0.7:
                    assertion["warnings"].append(_mf(
                        "audit",
                        f"LOO-ELPD: worst pareto_k={pk:.2f} > 0.7 — "
                        f"estimates unreliable for some data points",
                        value=pk, threshold=0.7,
                    ))

            results.append(assertion)

            _status, _verdict = _describe_outcome(assertion)
            _headline = f"{_status}" + (f" — {_verdict}" if _verdict else "")
            print(f"  {name}: {_headline} [{elapsed:.0f}s]")
            _bp = _bias_profile(
                assertion.get("parsed_edges", {}),
                assertion.get("parsed_slices", {}))
            if _bp:
                print(_bp, end="")

            # Incremental summary — survives kill/crash
            _q = assertion.get("quality", {})
            with open(summary_path, "a") as _sf:
                _sf.write(f"{name:<45s} {_status:<10s} {elapsed:6.0f}s  "
                          f"rhat={str(_q.get('rhat', '?')):<8s} "
                          f"ess={str(_q.get('ess', '?')):<8s} "
                          f"conv={str(_q.get('converged', '?'))}")
                if _verdict:
                    _sf.write(f"  {_verdict}")
                _sf.write("\n")
                for _fail in assertion.get("failures", []):
                    _msg = _fail["message"] if isinstance(_fail, dict) else str(_fail)
                    _sf.write(f"  ** {_msg}\n")
                if _bp:
                    _sf.write(_bp)

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

    # Classify each result by (status, verdict) — see _describe_outcome.
    # Lists for the totals banner:
    #   failed    — infrastructure fail (FAIL, non-xfail)
    #   completed — ran to end; may have quality issues
    #   xfailed   — expected fail (xfail marker present)
    from results_schema import classify_status as _cs
    failed = [
        r for r in results
        if _cs(r.get("passed", False), r.get("failures", []), r.get("quality", {})) == "fail"
        and not r.get("xfail")
    ]
    completed = [
        r for r in results
        if _cs(r.get("passed", False), r.get("failures", []), r.get("quality", {})) == "completed"
        and not r.get("xfail")
    ]
    xfailed = [r for r in results if r.get("xfail")]

    for r in results:
        status, verdict = _describe_outcome(r)

        audit = r.get("audit", {})
        q = r.get("quality", {})

        print()
        _hdr = f"{status}" + (f" — {verdict}" if verdict else "")
        print(f"  ── {r['graph_name']} ── {_hdr} ──")

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
                unit_recovery = {}
                for label, params in recovery_slices.items():
                    parsed_label = parse_slice_label(label)
                    if parsed_label is None:
                        continue
                    ctx_key, _edge_key = parsed_label
                    if ctx_key == unit:
                        unit_recovery[label] = params
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
            _msg = f["message"] if isinstance(f, dict) else str(f)
            print(f"    ** FAIL: {_msg}")
        for w in r.get("warnings", []):
            _msg = w["message"] if isinstance(w, dict) else str(w)
            print(f"    ** WARN: {_msg}")

    # Totals — completed runs broken down by quality verdict, infra
    # failures counted separately.
    print()
    print("-" * 60)
    total = len(results)
    from results_schema import classify_quality as _cq, compute_bias_profile as _cbp
    verdict_counts: dict[str, int] = {}
    for r in completed:
        _b = _cbp(r.get("parsed_edges", {}), r.get("parsed_slices", {}))
        _v = _cq(r.get("quality", {}), _b, r.get("failures", [])).get("verdict", "clean")
        verdict_counts[_v] = verdict_counts.get(_v, 0) + 1
    breakdown = ", ".join(f"{v}={n}" for v, n in sorted(verdict_counts.items())) or "none"
    print(
        f"  completed={len(completed)} ({breakdown}); "
        f"failed={len(failed)}; xfailed={len(xfailed)} "
        f"(of {total} total)"
    )

    # Aggregate bias profile across all graphs
    agg = _aggregate_bias_profile(results)
    if agg:
        print()
        print(agg)
        # Also append to summary file
        with open(summary_path, "a") as _sf:
            _sf.write("\n" + agg)

    # Write structured JSON results alongside the text summary
    results_json_path = summary_path.replace(".summary", ".json")
    _write_structured_results(results, results_json_path, run_id)
    print(f"\n  Structured results: {results_json_path}")

    # Exit-status intent: infrastructure failures are the only hard
    # fail. Quality-issue completions are reported but not a hard fail.
    if failed:
        print(f"\n  INFRASTRUCTURE FAILURE in {len(failed)} graph(s)")
    else:
        print(f"\n  ALL GRAPHS COMPLETED")
    return results


def _write_structured_results(
    results: list[dict],
    path: str,
    run_id: str,
) -> None:
    """Write machine-readable JSON results for programmatic analysis."""
    from results_schema import serialise_result, classify_status, classify_quality, compute_bias_profile

    serialised = [serialise_result(r) for r in results]

    # Envelope uses the new status taxonomy. Counters:
    #   failed    — infrastructure fail (excluding xfail)
    #   completed — ran to end (excluding xfail); further broken down
    #               by classification.verdict
    #   xfailed   — expected-fail (xfail marker set)
    failed_count = 0
    completed_count = 0
    xfailed_count = 0
    verdict_counts: dict[str, int] = {}
    for r, s in zip(results, serialised):
        if r.get("xfail"):
            xfailed_count += 1
            continue
        if s.get("status") == "fail":
            failed_count += 1
        else:
            completed_count += 1
            v = (s.get("classification") or {}).get("verdict", "unknown")
            verdict_counts[v] = verdict_counts.get(v, 0) + 1

    envelope = {
        "run_id": run_id,
        "timestamp": datetime.now().strftime("%d-%b-%y %H:%M"),
        "total": len(results),
        "failed": failed_count,
        "completed": completed_count,
        "completed_by_verdict": verdict_counts,
        "xfailed": xfailed_count,
        "graphs": serialised,
    }

    with open(path, "w") as f:
        json.dump(envelope, f, indent=2)


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
    parser.add_argument("--graph", nargs="+", default=None,
                        help="Run specific graph(s) (default: all discovered)")
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
    parser.add_argument("--no-timeout", action="store_true",
                        help="Disable all timeouts (pass --timeout 0 to harness)")
    parser.add_argument("--clean", action="store_true",
                        help="Clear __pycache__ bytecode before each graph run")
    parser.add_argument("--rebuild", action="store_true",
                        help="Delete synth-meta, forcing DB re-insert (heavy)")
    parser.add_argument("--dsl-override", type=str, default=None,
                        help="Override pinnedDSL for all graphs (forwarded to param_recovery.py)")
    args = parser.parse_args()

    results = run_regression(args)

    # Exit code: 0 if all passed (or xfail), 1 if any unexpected failures
    # Exit code: 0 if all graphs completed (infrastructure-wise) or were
    # xfail-marked. Quality issues (bias/convergence) do NOT cause non-zero
    # exit — regression runs are calibration probes, not pass/fail tests.
    from results_schema import classify_status as _cs
    infra_failures = [
        r for r in results
        if _cs(r.get("passed", False), r.get("failures", []), r.get("quality", {})) == "fail"
        and not r.get("xfail")
    ]
    sys.exit(1 if infra_failures else 0)


if __name__ == "__main__":
    main()
