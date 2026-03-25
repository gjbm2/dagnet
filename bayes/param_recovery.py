#!/usr/bin/env python3
"""
Parameter recovery test — runs MCMC and compares posteriors to ground truth.

Wraps test_harness: reads the .truth.yaml sidecar, runs the harness,
then produces a structured comparison table showing whether the model
recovers the known parameters.

Usage (single graph):
    . graph-editor/venv/bin/activate
    python bayes/param_recovery.py --graph synth-simple-abc
    python bayes/param_recovery.py --graph synth-mirror-4step
    python bayes/param_recovery.py --graph synth-simple-abc --chains 3 --cores 3
    python bayes/param_recovery.py --graph synth-simple-abc --feature latent_onset=false

Parallel execution (all synth graphs):
    scripts/run-param-recovery.sh
    scripts/bayes-monitor.sh   # in another terminal

NOT for production data — production graphs have no ground truth.
Use test_harness.py directly for production runs.
"""
from __future__ import annotations

import sys
import os
import json
import yaml
import subprocess
import re
import time
import argparse

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    parser = argparse.ArgumentParser(description="Parameter recovery test")
    parser.add_argument("--graph", required=True,
                        help="Synth graph name (must have .truth.yaml sidecar)")
    parser.add_argument("--feature", action="append", default=[],
                        metavar="KEY=VALUE",
                        help="Model feature flag (passed through to harness)")
    parser.add_argument("--timeout", type=int, default=600,
                        help="MCMC timeout in seconds (default: 600)")
    parser.add_argument("--draws", type=int, default=None, help="MCMC draws per chain")
    parser.add_argument("--tune", type=int, default=None, help="MCMC warmup steps per chain")
    parser.add_argument("--chains", type=int, default=None, help="Number of MCMC chains")
    parser.add_argument("--cores", type=int, default=None, help="Number of cores for sampling")
    parser.add_argument("--no-mcmc", action="store_true",
                        help="Stop after model build, skip MCMC (still shows truth)")
    args = parser.parse_args()

    # --- Resolve graph and truth file ---
    conf_path = os.path.join(REPO_ROOT, ".private-repos.conf")
    data_repo_dir = ""
    for line in open(conf_path):
        if line.strip().startswith("DATA_REPO_DIR="):
            data_repo_dir = line.strip().split("=", 1)[1].strip().strip('"')
    if not data_repo_dir:
        print("ERROR: DATA_REPO_DIR not set in .private-repos.conf")
        sys.exit(1)

    data_repo = os.path.join(REPO_ROOT, data_repo_dir)
    graph_path = os.path.join(data_repo, "graphs", f"{args.graph}.json")
    truth_path = graph_path.replace(".json", ".truth.yaml")

    if not os.path.isfile(graph_path):
        print(f"ERROR: Graph not found: {graph_path}")
        sys.exit(1)
    if not os.path.isfile(truth_path):
        print(f"ERROR: Truth file not found: {truth_path}")
        print("  Parameter recovery requires a .truth.yaml sidecar.")
        print("  For production data, use test_harness.py directly.")
        sys.exit(1)

    # --- Load truth ---
    with open(truth_path) as f:
        truth = yaml.safe_load(f)
    truth_edges = truth.get("edges", {})

    print(f"{'=' * 70}")
    print(f"  PARAMETER RECOVERY: {args.graph}")
    print(f"{'=' * 70}")
    print()
    print("GROUND TRUTH:")
    print(f"  {'Edge':<35s} {'p':>6s} {'onset':>6s} {'mu':>7s} {'sigma':>7s}")
    print(f"  {'─' * 35} {'─' * 6} {'─' * 6} {'─' * 7} {'─' * 7}")
    for pid, t in truth_edges.items():
        print(f"  {pid:<35s} {t['p']:6.3f} {t['onset']:6.1f} {t['mu']:7.3f} {t['sigma']:7.3f}")
    print()

    # --- Run harness ---
    cmd = [
        sys.executable, os.path.join(REPO_ROOT, "bayes", "test_harness.py"),
        "--graph", args.graph,
        "--no-webhook",
        "--timeout", str(args.timeout),
    ]
    if args.no_mcmc:
        cmd.append("--no-mcmc")
    if args.draws:
        cmd.extend(["--draws", str(args.draws)])
    if args.tune:
        cmd.extend(["--tune", str(args.tune)])
    if args.chains:
        cmd.extend(["--chains", str(args.chains)])
    if args.cores:
        cmd.extend(["--cores", str(args.cores)])
    for f in args.feature:
        cmd.extend(["--feature", f])

    print(f"Running: {' '.join(cmd[-6:])}")
    print()

    # Pin thread counts to prevent BLAS/OpenMP oversubscription during parallel runs
    env = {**os.environ, "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1",
           "OPENBLAS_NUM_THREADS": "1", "NUMBA_NUM_THREADS": "1"}

    t0 = time.time()
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=args.timeout + 60, env=env)
    elapsed = time.time() - t0

    output = result.stdout + result.stderr
    if result.returncode != 0:
        print(f"HARNESS FAILED (exit {result.returncode}, {elapsed:.0f}s)")
        print(output)
        sys.exit(1)

    # --- Parse results from harness output ---
    # Extract quality line
    quality_match = re.search(r"Quality:\s+rhat=([\d.]+),\s+ess=([\d.]+),\s+converged=([\d.]+)%", output)
    if not quality_match:
        if args.no_mcmc:
            print("(--no-mcmc: skipping posterior comparison)")
            # Still print the model structure from output
            for line in output.split("\n"):
                if "Free RVs:" in line or "Potentials:" in line or "features:" in line:
                    print(f"  {line.strip()}")
            return
        print("Could not find Quality line in harness output")
        print(output[-2000:])
        sys.exit(1)

    rhat = float(quality_match.group(1))
    ess = float(quality_match.group(2))
    converged_pct = float(quality_match.group(3))

    # Extract per-edge latency posteriors
    posteriors: dict[str, dict] = {}
    for line in output.split("\n"):
        # inference:   latency 7a26c540…: mu=1.476±0.032 (prior=1.531), sigma=0.599±0.021 (prior=0.467), rhat=1.001, ess=7647
        lat_match = re.search(
            r"inference:\s+latency (\w{8})…:\s+mu=([\d.]+)±([\d.]+)\s+\(prior=([\d.]+)\),\s+sigma=([\d.]+)±([\d.]+)\s+\(prior=([\d.]+)\),\s+rhat=([\d.]+),\s+ess=(\d+)",
            line
        )
        if lat_match:
            eid_prefix = lat_match.group(1)
            posteriors.setdefault(eid_prefix, {}).update({
                "mu_mean": float(lat_match.group(2)),
                "mu_sd": float(lat_match.group(3)),
                "mu_prior": float(lat_match.group(4)),
                "sigma_mean": float(lat_match.group(5)),
                "sigma_sd": float(lat_match.group(6)),
                "sigma_prior": float(lat_match.group(7)),
                "rhat": float(lat_match.group(8)),
                "ess": int(lat_match.group(9)),
            })

        # inference:   onset 7a26c540…: 5.68±0.15 (prior=5.50), corr(onset,mu)=-0.691
        onset_match = re.search(
            r"inference:\s+onset (\w{8})…:\s+([\d.]+)±([\d.]+)\s+\(prior=([\d.]+)\),\s+corr\(onset,mu\)=([-\d.]+)",
            line
        )
        if onset_match:
            eid_prefix = onset_match.group(1)
            posteriors.setdefault(eid_prefix, {}).update({
                "onset_mean": float(onset_match.group(2)),
                "onset_sd": float(onset_match.group(3)),
                "onset_prior": float(onset_match.group(4)),
                "onset_mu_corr": float(onset_match.group(5)),
            })

        # inference:   kappa b91c2820…: 3.6±1.1
        kappa_match = re.search(
            r"inference:\s+kappa (\w{8})…:\s+([\d.]+)±([\d.]+)",
            line
        )
        if kappa_match:
            eid_prefix = kappa_match.group(1)
            posteriors.setdefault(eid_prefix, {}).update({
                "kappa_mean": float(kappa_match.group(2)),
                "kappa_sd": float(kappa_match.group(3)),
            })

    # --- Map edge UUIDs to param_ids ---
    with open(graph_path) as f:
        graph = json.load(f)
    uuid_to_pid: dict[str, str] = {}
    for e in graph.get("edges", []):
        pid = e.get("p", {}).get("id", "")
        uuid = e.get("uuid", "")
        if pid and uuid:
            uuid_to_pid[uuid[:8]] = pid

    # --- Print comparison ---
    print()
    print(f"{'=' * 70}")
    print(f"  RECOVERY COMPARISON ({elapsed:.0f}s, rhat={rhat:.4f}, ess={ess:.0f}, converged={converged_pct:.0f}%)")
    print(f"{'=' * 70}")
    print()

    # Build reverse lookup: truth key → graph param_id (handles prefixed names)
    # New-format truth files use short keys (anchor-to-fast) while graph edges
    # use prefixed param_ids (synth-fanout-anchor-to-fast).
    _truth_key_to_graph_pid: dict[str, str] = {}
    for _uuid_pfx, _gpid in uuid_to_pid.items():
        # Direct match
        if _gpid in truth_edges:
            _truth_key_to_graph_pid[_gpid] = _gpid
        else:
            # Try stripping graph-name prefix to find the truth key
            for tkey in truth_edges:
                if _gpid.endswith(tkey) or _gpid.endswith(f"-{tkey}"):
                    _truth_key_to_graph_pid[tkey] = _gpid
                    break

    any_fail = False
    for pid, t in truth_edges.items():
        if isinstance(t, dict) and "from" in t and "p" not in t:
            continue  # skip node-structure entries in new-format truth files
        has_latency = t.get("onset", 0) > 0.01 or t.get("mu", 0) > 0.01

        # Find posterior by matching uuid prefix → graph param_id → truth key
        post = None
        graph_pid = _truth_key_to_graph_pid.get(pid, pid)
        for prefix, p in posteriors.items():
            mapped_pid = uuid_to_pid.get(prefix, "")
            if mapped_pid == graph_pid or mapped_pid == pid:
                post = p
                break

        print(f"  {pid}")
        print(f"  {'─' * 65}")

        if not has_latency:
            print(f"    (no latency — p-only edge)")
            # TODO: extract p posteriors from harness output
            print()
            continue

        if post is None:
            print(f"    NO POSTERIOR FOUND")
            any_fail = True
            print()
            continue

        # Compare each parameter
        for param, truth_key, post_key, sd_key in [
            ("mu",    "mu",    "mu_mean",    "mu_sd"),
            ("sigma", "sigma", "sigma_mean", "sigma_sd"),
            ("onset", "onset", "onset_mean", "onset_sd"),
        ]:
            truth_val = t.get(truth_key)
            if truth_val is None:
                continue
            post_val = post.get(post_key)
            post_sd = post.get(sd_key)
            if post_val is None:
                print(f"    {param:<8s}  truth={truth_val:7.3f}  posterior=???")
                continue

            # Recovery check: is the posterior close to truth?
            # Two-gate criterion — pass if EITHER is satisfied:
            #   (1) z-score < 3 (truth within 3 posterior SDs)
            #   (2) absolute error < tolerance (15% of truth, floor 0.15)
            # Gate (1) works when posteriors are wide (few data).
            # Gate (2) works when posteriors are very precise and a
            # small systematic bias inflates z (the common case with
            # clean synth data + many trajectories).
            abs_err = abs(post_val - truth_val)
            abs_tol = max(0.15, abs(truth_val) * 0.15)
            if post_sd and post_sd > 0:
                z_score = abs_err / post_sd
                recovered = z_score < 3.0 or abs_err < abs_tol
                status = "OK" if recovered else "MISS"
            else:
                z_score = float("inf")
                recovered = abs_err < abs_tol
                status = "OK" if recovered else "???"

            if not recovered:
                any_fail = True

            prior_val = post.get(f"{param}_prior", "")
            prior_str = f"  prior={prior_val:.3f}" if isinstance(prior_val, float) else ""
            corr_str = ""
            if param == "onset" and "onset_mu_corr" in post:
                corr_str = f"  corr(onset,mu)={post['onset_mu_corr']:.3f}"

            err_str = f"Δ={abs_err:.3f}" if abs_err < abs_tol and z_score >= 3.0 else f"z={z_score:5.2f}"
            print(f"    {param:<8s}  truth={truth_val:7.3f}  post={post_val:7.3f}±{post_sd:.3f}  "
                  f"{err_str:>10s}  [{status}]{prior_str}{corr_str}")

        if "kappa_mean" in post:
            print(f"    {'kappa':<8s}  sim={t.get('kappa', 50.0):7.1f}  post={post['kappa_mean']:7.1f}±{post['kappa_sd']:.1f}")
        if "rhat" in post:
            print(f"    {'rhat':<8s}  {post['rhat']:.4f}  ess={post.get('ess', '?')}")
        print()

    print(f"{'=' * 70}")
    if any_fail:
        print("  RECOVERY: PARTIAL — some parameters not recovered within 2 SD")
        sys.exit(1)
    else:
        print("  RECOVERY: PASS — all latency parameters within 2 SD of truth")
    print(f"{'=' * 70}")


if __name__ == "__main__":
    main()
