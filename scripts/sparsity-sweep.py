#!/usr/bin/env python3
"""
Sparsity sweep for centred vs non-centred parameterisation (doc 40).

Generates N truth YAML variants with random sparsity parameters,
bootstraps each via synth_gen, then runs param_recovery twice per
variant (centred vs non-centred).  Collates the nine-layer audit
output into a summary CSV for analysis.

Usage:
    . graph-editor/venv/bin/activate
    python3 -u scripts/sparsity-sweep.py --draws 20 --base-graph synth-skip-context-sparse

    # Fewer draws, quick exploration
    python3 -u scripts/sparsity-sweep.py --draws 5 --tune 500 --mcmc-draws 500

See BAYES_REGRESSION_TOOLING.md for the underlying pipeline.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import subprocess
import sys
import time
import yaml
import numpy as np
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BAYES_DIR = REPO_ROOT / "bayes"


def _resolve_data_repo() -> Path:
    """Resolve the data repo path from .private-repos.conf."""
    conf = REPO_ROOT / ".private-repos.conf"
    if not conf.exists():
        sys.exit(f"Missing {conf}")
    for line in conf.read_text().splitlines():
        if line.startswith("DATA_REPO_DIR="):
            return REPO_ROOT / line.split("=", 1)[1].strip()
    sys.exit("DATA_REPO_DIR not found in .private-repos.conf")


def _sample_sparsity(rng: np.random.Generator) -> dict:
    """Draw one set of sparsity parameters from the sweep distributions."""
    return {
        "frame_drop_rate": round(float(rng.uniform(0.0, 0.40)), 3),
        "toggle_rate": round(float(rng.uniform(0.0, 0.08)), 4),
        "initial_absent_pct": round(float(rng.uniform(0.0, 0.50)), 3),
    }


def _write_variant_truth(
    base_truth_path: Path,
    variant_name: str,
    sparsity: dict,
    output_dir: Path,
) -> Path:
    """Write a truth YAML variant with the given sparsity parameters."""
    with open(base_truth_path) as f:
        truth = yaml.safe_load(f)

    # Inject sparsity params into simulation block
    if "simulation" not in truth:
        truth["simulation"] = {}
    truth["simulation"]["frame_drop_rate"] = sparsity["frame_drop_rate"]
    truth["simulation"]["toggle_rate"] = sparsity["toggle_rate"]
    truth["simulation"]["initial_absent_pct"] = sparsity["initial_absent_pct"]

    # Update graph name to match variant
    if "graph" in truth:
        truth["graph"]["name"] = variant_name
        truth["graph"]["description"] = (
            f"Sparsity sweep variant: frame_drop={sparsity['frame_drop_rate']}, "
            f"toggle={sparsity['toggle_rate']}, absent={sparsity['initial_absent_pct']}"
        )

    # Use a unique seed per variant so each gets different sparsity patterns
    truth["simulation"]["seed"] = int(np.random.default_rng().integers(1, 2**31))

    variant_path = output_dir / f"{variant_name}.truth.yaml"
    with open(variant_path, "w") as f:
        f.write(f"# Auto-generated sparsity sweep variant (doc 40)\n")
        f.write(f"# Base: {base_truth_path.name}\n")
        f.write(f"# Sparsity: {json.dumps(sparsity)}\n\n")
        yaml.dump(truth, f, default_flow_style=False, sort_keys=False)

    return variant_path


def _run_param_recovery(
    graph_name: str,
    feature_flags: list[str],
    tune: int,
    draws: int,
    chains: int,
    timeout: int,
    label_suffix: str,
) -> dict:
    """Run param_recovery.py and return parsed results."""
    cmd = [
        sys.executable, "-u",
        str(BAYES_DIR / "param_recovery.py"),
        "--graph", graph_name,
        "--tune", str(tune),
        "--draws", str(draws),
        "--chains", str(chains),
        "--timeout", str(timeout),
        "--rebuild",  # force re-bootstrap since truth varies per variant
        "--clean",
        "--job-label", f"{graph_name}-{label_suffix}",
    ]
    for ff in feature_flags:
        cmd.extend(["--feature", ff])

    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"

    print(f"\n{'='*60}", flush=True)
    print(f"  Running: {graph_name} [{label_suffix}]", flush=True)
    print(f"  Features: {feature_flags or '(defaults)'}", flush=True)
    print(f"{'='*60}", flush=True)

    start = time.time()
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout + 120 if timeout > 0 else None,
            env=env,
            cwd=str(REPO_ROOT),
        )
        elapsed = time.time() - start
        stdout = result.stdout or ""
        stderr = result.stderr or ""
    except subprocess.TimeoutExpired:
        elapsed = time.time() - start
        stdout = ""
        stderr = f"TIMEOUT after {elapsed:.0f}s"

    # Parse key metrics from param_recovery output
    metrics = _parse_recovery_output(stdout + "\n" + stderr)
    metrics["elapsed_s"] = round(elapsed, 1)
    metrics["graph"] = graph_name
    metrics["config"] = label_suffix
    metrics["returncode"] = result.returncode if 'result' in dir() else -1

    # Print summary
    print(f"  → {label_suffix}: {elapsed:.0f}s, "
          f"rhat={metrics.get('rhat', '?')}, "
          f"ess={metrics.get('ess', '?')}, "
          f"conv={metrics.get('converged_pct', '?')}%, "
          f"diverg={metrics.get('divergences', '?')}", flush=True)

    return metrics


def _parse_recovery_output(text: str) -> dict:
    """Extract key metrics from param_recovery stdout."""
    metrics: dict = {}

    # rhat
    m = re.search(r"rhat[=:]?\s*([\d.]+)", text)
    if m:
        metrics["rhat"] = float(m.group(1))

    # ESS
    m = re.search(r"ess[=:]?\s*(\d+)", text, re.IGNORECASE)
    if m:
        metrics["ess"] = int(m.group(1))

    # converged %
    m = re.search(r"converged[=:]?\s*([\d.]+)%", text, re.IGNORECASE)
    if m:
        metrics["converged_pct"] = float(m.group(1))

    # divergences
    m = re.search(r"diverg\w*[=:]?\s*(\d+)", text, re.IGNORECASE)
    if m:
        metrics["divergences"] = int(m.group(1))

    # Recovery lines — count PASS/MISS/FAIL
    pass_count = len(re.findall(r"\bok\b", text))
    miss_count = len(re.findall(r"\bMISS\b", text))
    fail_count = len(re.findall(r"\bFAIL\b", text))
    metrics["recovery_pass"] = pass_count
    metrics["recovery_miss"] = miss_count
    metrics["recovery_fail"] = fail_count

    return metrics


def main():
    parser = argparse.ArgumentParser(
        description="Sparsity sweep: centred vs non-centred under varying data availability (doc 40)",
    )
    parser.add_argument("--draws", type=int, default=20,
                        help="Number of sparsity draws (truth variants) to generate")
    parser.add_argument("--base-graph", type=str, default="synth-skip-context-sparse",
                        help="Base truth YAML to derive variants from")
    parser.add_argument("--tune", type=int, default=1000,
                        help="MCMC warmup steps per chain")
    parser.add_argument("--mcmc-draws", type=int, default=1000,
                        help="MCMC draws per chain")
    parser.add_argument("--chains", type=int, default=2,
                        help="Number of MCMC chains")
    parser.add_argument("--timeout", type=int, default=0,
                        help="Per-graph MCMC timeout (0 = no timeout)")
    parser.add_argument("--seed", type=int, default=12345,
                        help="RNG seed for sparsity parameter sampling")
    parser.add_argument("--output", type=str, default=None,
                        help="Output CSV path (default: /tmp/sparsity-sweep-{timestamp}.csv)")
    args = parser.parse_args()

    data_repo = _resolve_data_repo()
    graphs_dir = data_repo / "graphs"

    base_truth = graphs_dir / f"{args.base_graph}.truth.yaml"
    if not base_truth.exists():
        sys.exit(f"Base truth file not found: {base_truth}")

    rng = np.random.default_rng(args.seed)
    timestamp = int(time.time())
    output_csv = args.output or f"/tmp/sparsity-sweep-{timestamp}.csv"

    print(f"Sparsity sweep (doc 40)", flush=True)
    print(f"  Base graph:  {args.base_graph}", flush=True)
    print(f"  Draws:       {args.draws}", flush=True)
    print(f"  MCMC:        {args.tune} tune, {args.mcmc_draws} draws, {args.chains} chains", flush=True)
    print(f"  Output:      {output_csv}", flush=True)
    print(flush=True)

    all_results = []

    for i in range(args.draws):
        sparsity = _sample_sparsity(rng)
        variant_name = f"{args.base_graph}-v{i:03d}"

        print(f"\n{'#'*60}", flush=True)
        print(f"  Draw {i+1}/{args.draws}: {variant_name}", flush=True)
        print(f"  Sparsity: frame_drop={sparsity['frame_drop_rate']}, "
              f"toggle={sparsity['toggle_rate']}, "
              f"absent={sparsity['initial_absent_pct']}", flush=True)
        print(f"{'#'*60}", flush=True)

        # Write variant truth YAML
        variant_path = _write_variant_truth(
            base_truth, variant_name, sparsity, graphs_dir,
        )

        try:
            # Run centred (default)
            centred = _run_param_recovery(
                variant_name,
                feature_flags=[],  # centred is default since 14-Apr-26
                tune=args.tune,
                draws=args.mcmc_draws,
                chains=args.chains,
                timeout=args.timeout,
                label_suffix="centred",
            )
            centred.update(sparsity)
            centred["draw"] = i
            centred["parameterisation"] = "centred"
            all_results.append(centred)

            # Run non-centred
            noncentred = _run_param_recovery(
                variant_name,
                feature_flags=[
                    "centred_p_slices=false",
                    "centred_latency_slices=false",
                ],
                tune=args.tune,
                draws=args.mcmc_draws,
                chains=args.chains,
                timeout=args.timeout,
                label_suffix="noncentred",
            )
            noncentred.update(sparsity)
            noncentred["draw"] = i
            noncentred["parameterisation"] = "noncentred"
            all_results.append(noncentred)

        finally:
            # Clean up variant truth file to avoid polluting data repo
            if variant_path.exists():
                variant_path.unlink()
            # Also clean up any generated .synth-meta.json
            meta_path = graphs_dir / f".{variant_name}.synth-meta.json"
            if meta_path.exists():
                meta_path.unlink()
            # Clean up generated graph JSON if truth-based graph generation created one
            graph_json = graphs_dir / f"{variant_name}.json"
            if graph_json.exists():
                graph_json.unlink()

        # Write incremental CSV after each draw
        _write_csv(output_csv, all_results)
        print(f"\n  Incremental results written to {output_csv}", flush=True)

    # Final summary
    print(f"\n{'='*60}", flush=True)
    print(f"  SWEEP COMPLETE: {args.draws} draws × 2 configs = {len(all_results)} runs", flush=True)
    print(f"  Results: {output_csv}", flush=True)
    print(f"{'='*60}", flush=True)

    _print_summary(all_results)


def _write_csv(path: str, results: list[dict]) -> None:
    """Write results to CSV."""
    if not results:
        return
    fieldnames = [
        "draw", "parameterisation", "graph",
        "frame_drop_rate", "toggle_rate", "initial_absent_pct",
        "elapsed_s", "rhat", "ess", "converged_pct", "divergences",
        "recovery_pass", "recovery_miss", "recovery_fail",
        "returncode",
    ]
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(results)


def _print_summary(results: list[dict]) -> None:
    """Print a comparative summary table."""
    print(f"\n  {'Config':<14} {'Runs':>5} {'Median ESS':>11} {'Mean diverg':>12} "
          f"{'Mean conv%':>11} {'Recoveries':>11}", flush=True)
    print(f"  {'-'*14} {'-'*5} {'-'*11} {'-'*12} {'-'*11} {'-'*11}", flush=True)

    for config in ["centred", "noncentred"]:
        runs = [r for r in results if r.get("parameterisation") == config]
        if not runs:
            continue
        ess_vals = [r["ess"] for r in runs if "ess" in r]
        div_vals = [r.get("divergences", 0) for r in runs]
        conv_vals = [r["converged_pct"] for r in runs if "converged_pct" in r]
        pass_vals = [r.get("recovery_pass", 0) for r in runs]
        miss_vals = [r.get("recovery_miss", 0) for r in runs]

        median_ess = int(np.median(ess_vals)) if ess_vals else "?"
        mean_div = f"{np.mean(div_vals):.1f}" if div_vals else "?"
        mean_conv = f"{np.mean(conv_vals):.1f}" if conv_vals else "?"
        total_pass = sum(pass_vals)
        total_miss = sum(miss_vals)

        print(f"  {config:<14} {len(runs):>5} {median_ess:>11} {mean_div:>12} "
              f"{mean_conv:>11} {total_pass:>5}P/{total_miss}M", flush=True)


if __name__ == "__main__":
    main()
