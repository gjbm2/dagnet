#!/usr/bin/env python3
"""
Four-way comparison for per-slice a feature flag (doc 41a §4.1).

Runs param_recovery on a synth graph with all four combinations of
per_slice_a × shared_sigma_slices, then produces a summary table
comparing onset/mu/sigma recovery across configs.

Configs:
  A (baseline):      per_slice_a=false, shared_sigma_slices=false
  B (shared σ only): per_slice_a=false, shared_sigma_slices=true
  C (per-slice a):   per_slice_a=true,  shared_sigma_slices=false
  D (a + shared σ):  per_slice_a=true,  shared_sigma_slices=true

Usage:
    . graph-editor/venv/bin/activate
    python scripts/compare-per-slice-a.py --graph synth-context-solo
    python scripts/compare-per-slice-a.py --graph synth-context-solo --runs 3
    python scripts/compare-per-slice-a.py --graph synth-diamond-context --configs C,D
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

WINNING_FORMULA = [
    "--feature", "latency_reparam=true",
    "--feature", "centred_latency_slices=true",
    "--feature", "centred_p_slices=true",
]

CONFIGS = {
    "A": {
        "label": "A (baseline)",
        "desc": "shared a, per-slice r (current default)",
        "per_slice_a": "false",
        "shared_sigma_slices": "false",
        "latency_reparam_slices": "2",
    },
    "B": {
        "label": "B (shared σ only)",
        "desc": "shared a, shared sigma (isolates sigma effect)",
        "per_slice_a": "false",
        "shared_sigma_slices": "true",
        "latency_reparam_slices": "2",
    },
    "C": {
        "label": "C (per-slice a, free σ)",
        "desc": "per-slice a, per-slice r (tests ridge risk)",
        "per_slice_a": "true",
        "shared_sigma_slices": "false",
        "latency_reparam_slices": "2",
    },
    "D": {
        "label": "D (a + shared σ)",
        "desc": "per-slice a, shared sigma (review recommendation)",
        "per_slice_a": "true",
        "shared_sigma_slices": "true",
        "latency_reparam_slices": "2",
    },
}


def run_once(
    graph: str,
    config_key: str,
    run_idx: int,
    chains: int,
    tune: int,
    draws: int,
) -> dict:
    """Run param_recovery once with a given config and parse results."""
    cfg = CONFIGS[config_key]
    run_id = int(time.time())
    run_label = f"{config_key}-{run_idx + 1}-r{run_id}"

    cmd = [
        sys.executable, os.path.join(REPO_ROOT, "bayes", "param_recovery.py"),
        "--graph", graph,
        "--tune", str(tune),
        "--draws", str(draws),
        "--chains", str(chains),
        "--timeout", "0",
        "--job-label", run_label,
        *WINNING_FORMULA,
        "--feature", f"per_slice_a={cfg['per_slice_a']}",
        "--feature", f"shared_sigma_slices={cfg['shared_sigma_slices']}",
        "--feature", f"latency_reparam_slices={cfg['latency_reparam_slices']}",
    ]

    env = {
        **os.environ,
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
        "XLA_FLAGS": "--xla_cpu_multi_thread_eigen=true",
        "OMP_NUM_THREADS": str(os.cpu_count() or 16),
        "MKL_NUM_THREADS": str(os.cpu_count() or 16),
        "OPENBLAS_NUM_THREADS": str(os.cpu_count() or 16),
    }

    print(f"\n{'─' * 70}")
    print(f"  {cfg['label']}  (run {run_idx + 1})")
    print(f"  per_slice_a={cfg['per_slice_a']}, "
          f"shared_sigma_slices={cfg['shared_sigma_slices']}")
    print(f"{'─' * 70}", flush=True)

    HARD_TIMEOUT_S = 3600

    t0 = time.time()
    timed_out = False
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, env=env,
            timeout=HARD_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        timed_out = True
        result = None
    elapsed = time.time() - t0

    if timed_out:
        print(f"  → TIMEOUT after {elapsed:.0f}s")
        return {
            "config": config_key, "run": run_idx + 1,
            "elapsed_s": round(elapsed, 1),
            "success": False, "rhat": None, "ess": None,
            "misses": 0, "recovery": "TIMEOUT",
            "onset_misses": [], "mu_misses": [], "sigma_misses": [],
        }

    output = result.stdout + "\n" + result.stderr

    parsed = {
        "config": config_key,
        "run": run_idx + 1,
        "elapsed_s": round(elapsed, 1),
        "success": result.returncode == 0,
        "rhat": None,
        "ess": None,
        "misses": 0,
        "recovery": None,
        "onset_misses": [],
        "mu_misses": [],
        "sigma_misses": [],
    }

    # Parse summary line
    m = re.search(
        r"RECOVERY COMPARISON \((\d+)s, rhat=([\d.]+), ess=(\d+), converged=(\d+)%\)",
        output,
    )
    if m:
        parsed["elapsed_s"] = int(m.group(1))
        parsed["rhat"] = float(m.group(2))
        parsed["ess"] = int(m.group(3))

    m2 = re.search(r"RECOVERY: (\S+)", output)
    if m2:
        parsed["recovery"] = m2.group(1)

    parsed["misses"] = output.count("[MISS]")

    # Parse per-param MISS lines for onset/mu/sigma
    for line in output.splitlines():
        if "[MISS]" not in line:
            continue
        line_lower = line.lower()
        if "onset" in line_lower:
            # Extract z-score if present
            zm = re.search(r"z=([\d.]+)", line)
            z = float(zm.group(1)) if zm else None
            parsed["onset_misses"].append({"line": line.strip(), "z": z})
        elif "mu" in line_lower and "sigma" not in line_lower:
            zm = re.search(r"z=([\d.]+)", line)
            z = float(zm.group(1)) if zm else None
            parsed["mu_misses"].append({"line": line.strip(), "z": z})
        elif "sigma" in line_lower:
            zm = re.search(r"z=([\d.]+)", line)
            z = float(zm.group(1)) if zm else None
            parsed["sigma_misses"].append({"line": line.strip(), "z": z})

    status = "OK" if parsed["success"] else "FAIL"
    print(f"  → {status}  {parsed['elapsed_s']}s  rhat={parsed['rhat']}  "
          f"ess={parsed['ess']}  "
          f"misses={parsed['misses']} "
          f"(onset={len(parsed['onset_misses'])}, "
          f"mu={len(parsed['mu_misses'])}, "
          f"sigma={len(parsed['sigma_misses'])})")
    print(f"  Persistent log: /tmp/bayes_recovery-{run_label}.log")

    # Print full output for diagnostics
    if output.strip():
        for line in output.splitlines():
            print(f"    {line}")

    return parsed


def main():
    parser = argparse.ArgumentParser(
        description="Four-way comparison for per-slice a (doc 41a)")
    parser.add_argument("--graph", required=True, help="Synth graph name")
    parser.add_argument("--chains", type=int, default=3)
    parser.add_argument("--tune", type=int, default=2000)
    parser.add_argument("--draws", type=int, default=2000)
    parser.add_argument("--runs", type=int, default=1,
                        help="Runs per config (default: 1)")
    parser.add_argument("--configs", default="A,B,C,D",
                        help="Comma-separated config keys (default: A,B,C,D)")
    args = parser.parse_args()

    config_keys = [c.strip() for c in args.configs.split(",")]
    for k in config_keys:
        if k not in CONFIGS:
            print(f"ERROR: unknown config '{k}'. Valid: A, B, C, D")
            sys.exit(1)

    print(f"{'=' * 70}")
    print(f"  PER-SLICE A COMPARISON: {args.graph}")
    print(f"  chains={args.chains}, tune={args.tune}, draws={args.draws}, "
          f"runs={args.runs}")
    print(f"  configs: {', '.join(CONFIGS[k]['label'] for k in config_keys)}")
    print(f"{'=' * 70}", flush=True)

    results: dict[str, list[dict]] = {k: [] for k in config_keys}

    for config_key in config_keys:
        cfg = CONFIGS[config_key]
        print(f"\n{'=' * 70}")
        print(f"  CONFIG {cfg['label']}")
        print(f"{'=' * 70}", flush=True)

        for i in range(args.runs):
            r = run_once(
                graph=args.graph, config_key=config_key,
                run_idx=i, chains=args.chains,
                tune=args.tune, draws=args.draws,
            )
            results[config_key].append(r)

    # ── Summary table ──
    print(f"\n{'=' * 70}")
    print(f"  SUMMARY: {args.graph}")
    print(f"{'=' * 70}")
    print()
    print(f"  {'Config':<22s} {'Runs':>4s} {'OK':>3s} "
          f"{'Time':>7s} {'ESS':>6s} {'rhat':>7s} "
          f"{'Miss':>5s} {'Onset':>6s} {'Mu':>4s} {'Sigma':>6s}")
    print(f"  {'─' * 22} {'─' * 4} {'─' * 3} "
          f"{'─' * 7} {'─' * 6} {'─' * 7} "
          f"{'─' * 5} {'─' * 6} {'─' * 4} {'─' * 6}")

    for config_key in config_keys:
        runs = results[config_key]
        cfg = CONFIGS[config_key]
        n = len(runs)
        ok = sum(1 for r in runs if r["success"])
        completed = [r for r in runs if r["rhat"] is not None]

        if completed:
            times = sorted(r["elapsed_s"] for r in completed)
            esses = sorted(r["ess"] for r in completed)
            rhats = sorted(r["rhat"] for r in completed)
            total_misses = sorted(r["misses"] for r in completed)
            onset_misses = sorted(len(r["onset_misses"]) for r in completed)
            mu_misses = sorted(len(r["mu_misses"]) for r in completed)
            sigma_misses = sorted(len(r["sigma_misses"]) for r in completed)
            mid = len(completed) // 2
            print(f"  {cfg['label']:<22s} {n:>4d} {ok:>3d} "
                  f"{times[mid]:>6.0f}s {esses[mid]:>6d} {rhats[mid]:>7.4f} "
                  f"{total_misses[mid]:>5d} {onset_misses[mid]:>6d} "
                  f"{mu_misses[mid]:>4d} {sigma_misses[mid]:>6d}")
        else:
            print(f"  {cfg['label']:<22s} {n:>4d} {ok:>3d} "
                  f"{'—':>7s} {'—':>6s} {'—':>7s} "
                  f"{'—':>5s} {'—':>6s} {'—':>4s} {'—':>6s}")

    # ── Comparison ──
    print()
    if "A" in results and "B" in results and results["A"] and results["B"]:
        a_miss = sum(r["misses"] for r in results["A"])
        b_miss = sum(r["misses"] for r in results["B"])
        print(f"  A→B (shared σ effect):    "
              f"misses {a_miss} → {b_miss}")
    if "A" in results and "C" in results and results["A"] and results["C"]:
        a_miss = sum(r["misses"] for r in results["A"])
        c_miss = sum(r["misses"] for r in results["C"])
        print(f"  A→C (per-slice a effect): "
              f"misses {a_miss} → {c_miss}")
    if "A" in results and "D" in results and results["A"] and results["D"]:
        a_miss = sum(r["misses"] for r in results["A"])
        d_miss = sum(r["misses"] for r in results["D"])
        print(f"  A→D (combined effect):    "
              f"misses {a_miss} → {d_miss}")
    if "C" in results and "D" in results and results["C"] and results["D"]:
        c_miss = sum(r["misses"] for r in results["C"])
        d_miss = sum(r["misses"] for r in results["D"])
        print(f"  C→D (ridge still active?): "
              f"misses {c_miss} → {d_miss}")

    print()


if __name__ == "__main__":
    main()
