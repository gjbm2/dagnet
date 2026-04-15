#!/usr/bin/env python3
"""
Compare MCMC resilience strategies on a contexted synth graph.

Strategies:
  1. Baseline:       N chains, default target_accept (0.90). Run until 1 success.
  2. High accept:    N chains, target_accept=0.95. Run 3 times.
  3. Over-provision: N*1.5 chains launched, keep first N completions. Run 10 times.

All runs use the winning formula: latency_reparam + centred_latency_slices +
centred_p_slices.  Runs are sequential (JAX fans out across CPUs).

Usage:
    . graph-editor/venv/bin/activate
    python scripts/resilience-strategies.py --graph synth-diamond-context
    python scripts/resilience-strategies.py --graph synth-diamond-context --chains 2
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


def run_once(
    graph: str,
    chains: int,
    target_accept: float,
    overprovision_chains: int | None,
    tune: int,
    draws: int,
    run_label: str,
) -> dict:
    """Run param_recovery once and parse results."""

    # Build settings JSON for target_accept and overprovision_chains
    settings: dict = {}
    if target_accept != 0.90:
        settings["target_accept"] = target_accept
    if overprovision_chains is not None:
        settings["overprovision_chains"] = overprovision_chains

    settings_path = None
    if settings:
        fd, settings_path = tempfile.mkstemp(suffix=".json", prefix="resilience_")
        with os.fdopen(fd, "w") as f:
            json.dump(settings, f)

    # Unique job label with timestamp for persistent log retrieval
    unique_label = f"{run_label}-r{int(time.time())}"
    cmd = [
        sys.executable, os.path.join(REPO_ROOT, "bayes", "param_recovery.py"),
        "--graph", graph,
        "--tune", str(tune),
        "--draws", str(draws),
        "--chains", str(chains),
        "--timeout", "0",
        "--job-label", unique_label,
        *WINNING_FORMULA,
    ]
    if settings_path:
        cmd.extend(["--settings-json", settings_path])

    env = {
        **os.environ,
        "PYTHONDONTWRITEBYTECODE": "1",
        "XLA_FLAGS": "--xla_cpu_multi_thread_eigen=true",
        "OMP_NUM_THREADS": str(os.cpu_count() or 16),
        "MKL_NUM_THREADS": str(os.cpu_count() or 16),
        "OPENBLAS_NUM_THREADS": str(os.cpu_count() or 16),
    }

    print(f"\n{'─' * 70}")
    print(f"  {run_label}")
    print(f"  chains={chains}, target_accept={target_accept}, "
          f"overprovision={overprovision_chains or 'none'}")
    print(f"{'─' * 70}")

    # Hard timeout: 30 min safety net.  Normal runs take ~8 min.
    # If a run exceeds this, it's a total stall (all chains stuck).
    HARD_TIMEOUT_S = 1800

    t0 = time.time()
    timed_out = False
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, env=env,
            timeout=HARD_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        timed_out = True
    finally:
        if settings_path and os.path.isfile(settings_path):
            os.remove(settings_path)
    elapsed = time.time() - t0

    if timed_out:
        print(f"  → TIMEOUT after {elapsed:.0f}s (hard limit {HARD_TIMEOUT_S}s)")
        return {
            "label": run_label, "elapsed_s": round(elapsed, 1),
            "exit_code": -1, "success": False, "rhat": None,
            "ess": None, "converged_pct": None, "recovery": "TIMEOUT",
            "stall": True, "misses": 0,
        }

    output = result.stdout + "\n" + result.stderr

    # Parse key metrics from output
    parsed = {
        "label": run_label,
        "elapsed_s": round(elapsed, 1),
        "exit_code": result.returncode,
        "success": result.returncode == 0,
        "rhat": None,
        "ess": None,
        "converged_pct": None,
        "recovery": None,
        "stall": False,
    }

    # Parse summary line: RECOVERY COMPARISON (482s, rhat=1.0118, ess=311, converged=99%)
    m = re.search(
        r"RECOVERY COMPARISON \((\d+)s, rhat=([\d.]+), ess=(\d+), converged=(\d+)%\)",
        output,
    )
    if m:
        parsed["elapsed_s"] = int(m.group(1))
        parsed["rhat"] = float(m.group(2))
        parsed["ess"] = int(m.group(3))
        parsed["converged_pct"] = int(m.group(4))

    # Parse final recovery line
    m2 = re.search(r"RECOVERY: (\S+)", output)
    if m2:
        parsed["recovery"] = m2.group(1)

    # Detect stalls from nutpie progress lines (draw rate collapse)
    if "aborting stragglers" in output:
        parsed["stall"] = True

    # Count MISS lines
    parsed["misses"] = output.count("[MISS]")

    # Print condensed result
    status = "OK" if parsed["success"] else "FAIL"
    print(f"  → {status}  {parsed['elapsed_s']}s  rhat={parsed['rhat']}  "
          f"ess={parsed['ess']}  conv={parsed['converged_pct']}%  "
          f"misses={parsed['misses']}  recovery={parsed['recovery']}")

    return parsed


def main():
    parser = argparse.ArgumentParser(description="Compare MCMC resilience strategies")
    parser.add_argument("--graph", required=True, help="Synth graph name")
    parser.add_argument("--chains", type=int, default=2, help="Desired chains (default: 2)")
    parser.add_argument("--tune", type=int, default=1000, help="Warmup steps (default: 1000)")
    parser.add_argument("--draws", type=int, default=1000, help="Draws per chain (default: 1000)")
    parser.add_argument("--baseline-runs", type=int, default=None,
                        help="Max attempts for baseline until 1 success (default: 5)")
    parser.add_argument("--highaccept-runs", type=int, default=3,
                        help="Number of high-accept runs (default: 3)")
    parser.add_argument("--overprovision-runs", type=int, default=10,
                        help="Number of over-provision runs (default: 10)")
    args = parser.parse_args()

    chains = args.chains
    op_chains = int(chains * 1.5) if int(chains * 1.5) > chains else chains + 1
    max_baseline = args.baseline_runs or 5

    results: dict[str, list[dict]] = {
        "baseline": [],
        "high_accept": [],
        "overprovision": [],
    }

    print(f"{'=' * 70}")
    print(f"  RESILIENCE STRATEGY COMPARISON: {args.graph}")
    print(f"  chains={chains}, tune={args.tune}, draws={args.draws}")
    print(f"  over-provision: {op_chains} launched → keep {chains}")
    print(f"{'=' * 70}")

    # --- Strategy 1: Baseline (run until 1 success, max N attempts) ---
    print(f"\n{'=' * 70}")
    print(f"  STRATEGY 1: BASELINE (target_accept=0.90, {chains} chains)")
    print(f"  Run until 1 success (max {max_baseline} attempts)")
    print(f"{'=' * 70}")

    for i in range(max_baseline):
        r = run_once(
            graph=args.graph, chains=chains, target_accept=0.90,
            overprovision_chains=None, tune=args.tune, draws=args.draws,
            run_label=f"baseline-{i + 1}",
        )
        results["baseline"].append(r)
        if r["success"]:
            print(f"\n  Baseline success on attempt {i + 1}")
            break
    else:
        print(f"\n  WARNING: No baseline success in {max_baseline} attempts")

    # --- Strategy 2: High accept (3 runs) ---
    print(f"\n{'=' * 70}")
    print(f"  STRATEGY 2: HIGH ACCEPT (target_accept=0.95, {chains} chains)")
    print(f"  {args.highaccept_runs} runs")
    print(f"{'=' * 70}")

    for i in range(args.highaccept_runs):
        r = run_once(
            graph=args.graph, chains=chains, target_accept=0.95,
            overprovision_chains=None, tune=args.tune, draws=args.draws,
            run_label=f"highaccept-{i + 1}",
        )
        results["high_accept"].append(r)

    # --- Strategy 3: Over-provision (10 runs) ---
    print(f"\n{'=' * 70}")
    print(f"  STRATEGY 3: OVER-PROVISION ({op_chains}→{chains} chains)")
    print(f"  {args.overprovision_runs} runs")
    print(f"{'=' * 70}")

    for i in range(args.overprovision_runs):
        r = run_once(
            graph=args.graph, chains=chains, target_accept=0.90,
            overprovision_chains=op_chains, tune=args.tune, draws=args.draws,
            run_label=f"overprovision-{i + 1}",
        )
        results["overprovision"].append(r)

    # --- Summary table ---
    print(f"\n{'=' * 70}")
    print(f"  SUMMARY")
    print(f"{'=' * 70}")
    print()
    print(f"  {'Strategy':<20s} {'Runs':>5s} {'OK':>4s} {'Rate':>6s} "
          f"{'Med time':>9s} {'Med ESS':>8s} {'Med rhat':>9s} {'Med miss':>9s}")
    print(f"  {'─' * 20} {'─' * 5} {'─' * 4} {'─' * 6} "
          f"{'─' * 9} {'─' * 8} {'─' * 9} {'─' * 9}")

    for name, runs in results.items():
        n = len(runs)
        ok = sum(1 for r in runs if r["success"])
        rate = f"{100 * ok / n:.0f}%" if n > 0 else "—"
        completed = [r for r in runs if r["rhat"] is not None]
        if completed:
            times = sorted(r["elapsed_s"] for r in completed)
            esses = sorted(r["ess"] for r in completed)
            rhats = sorted(r["rhat"] for r in completed)
            misses = sorted(r["misses"] for r in completed)
            med_t = times[len(times) // 2]
            med_ess = esses[len(esses) // 2]
            med_rhat = rhats[len(rhats) // 2]
            med_miss = misses[len(misses) // 2]
            print(f"  {name:<20s} {n:>5d} {ok:>4d} {rate:>6s} "
                  f"{med_t:>8.0f}s {med_ess:>8d} {med_rhat:>9.4f} {med_miss:>9d}")
        else:
            print(f"  {name:<20s} {n:>5d} {ok:>4d} {rate:>6s} "
                  f"{'—':>9s} {'—':>8s} {'—':>9s} {'—':>9s}")

    # --- Per-run detail ---
    print(f"\n  Per-run detail:")
    print(f"  {'Label':<22s} {'Time':>6s} {'ESS':>6s} {'rhat':>7s} {'Conv':>5s} "
          f"{'Miss':>5s} {'Result':>8s}")
    print(f"  {'─' * 22} {'─' * 6} {'─' * 6} {'─' * 7} {'─' * 5} {'─' * 5} {'─' * 8}")
    for name, runs in results.items():
        for r in runs:
            t = f"{r['elapsed_s']}s" if r['elapsed_s'] else "—"
            ess = str(r['ess']) if r['ess'] is not None else "—"
            rhat = f"{r['rhat']:.4f}" if r['rhat'] is not None else "—"
            conv = f"{r['converged_pct']}%" if r['converged_pct'] is not None else "—"
            miss = str(r['misses'])
            res = r['recovery'] or ("FAIL" if not r['success'] else "?")
            print(f"  {r['label']:<22s} {t:>6s} {ess:>6s} {rhat:>7s} {conv:>5s} "
                  f"{miss:>5s} {res:>8s}")

    print()


if __name__ == "__main__":
    main()
