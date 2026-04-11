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
    parser.add_argument("--clean", action="store_true",
                        help="Pass --clean to harness (clears bytecode + synth meta caches)")
    parser.add_argument("--job-label", type=str, default=None,
                        help="Unique label for log files (forwarded to harness --job-label). "
                             "Prevents parallel runs from cross-contaminating logs.")
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

    # --- Build per-slice truth baselines for LOO null model (doc 35) ---
    # When context_dimensions exist, compute per-slice truth values
    # and pass them to the worker via --settings-json so LOO uses the
    # correct per-slice null (p × p_mult, mu + mu_offset, etc.).
    settings_json_path = None
    context_dims = truth.get("context_dimensions", [])
    if context_dims:
        slice_truth_baselines: dict[str, dict[str, dict]] = {}  # edge_key → ctx_key → {p, mu, sigma, onset}
        for dim in context_dims:
            dim_id = dim["id"]
            for val in dim.get("values", []):
                val_id = val["id"]
                ctx_key = f"context({dim_id}:{val_id})"
                for edge_key, overrides in val.get("edges", {}).items():
                    base = truth_edges.get(edge_key, {})
                    if "p" not in base:
                        continue
                    slice_truth_baselines.setdefault(edge_key, {})[ctx_key] = {
                        "p": base["p"] * overrides.get("p_mult", 1.0),
                        "mu": base.get("mu", 0.0) + overrides.get("mu_offset", 0.0),
                        "sigma": base.get("sigma", 0.5) * overrides.get("sigma_mult", 1.0),
                        "onset": base.get("onset", 0.0) + overrides.get("onset_offset", 0.0),
                    }
        if slice_truth_baselines:
            import tempfile
            settings_json_path = tempfile.mktemp(suffix=".json", prefix="bayes_settings_")
            with open(settings_json_path, "w") as sf:
                json.dump({"slice_truth_baselines": slice_truth_baselines}, sf)

    # --- Run harness ---
    cmd = [
        sys.executable, os.path.join(REPO_ROOT, "bayes", "test_harness.py"),
        "--graph", args.graph,
        "--fe-payload",
        "--no-webhook",
        "--timeout", str(args.timeout),
    ]
    if settings_json_path:
        cmd.extend(["--settings-json", settings_json_path])
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
    if args.clean:
        cmd.append("--clean")
    if args.job_label:
        cmd.extend(["--job-label", args.job_label])

    print(f"Running: {' '.join(cmd[-6:])}")
    print()

    # Pin thread counts to prevent BLAS/OpenMP oversubscription during parallel runs.
    # PYTHONDONTWRITEBYTECODE: prevent stale .pyc from masking source edits.
    env = {**os.environ, "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1",
           "OPENBLAS_NUM_THREADS": "1", "NUMBA_NUM_THREADS": "1",
           "PYTHONDONTWRITEBYTECODE": "1"}

    t0 = time.time()
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=args.timeout + 60, env=env)
    finally:
        # Clean up temp settings file
        if settings_json_path and os.path.isfile(settings_json_path):
            os.remove(settings_json_path)
    elapsed = time.time() - t0

    output = result.stdout + result.stderr
    if result.returncode != 0:
        print(f"HARNESS FAILED (exit {result.returncode}, {elapsed:.0f}s)")
        print(output)
        sys.exit(1)

    # Supplement with harness log — inference diagnostics (mu/sigma
    # posteriors, kappa_lat) are written to the log file only, not stdout.
    # The --fe-payload path uses graph_id = "graph-{name}" as log name.
    # When --job-label is set, the harness uses that as the log file name.
    _log_label = args.job_label or args.graph
    for _log_path in [f"/tmp/bayes_harness-{_log_label}.log",
                      f"/tmp/bayes_harness-graph-{_log_label}.log",
                      f"/tmp/bayes_harness-graph-{args.graph}.log",
                      f"/tmp/bayes_harness-{args.graph}.log"]:
        if os.path.isfile(_log_path) and os.path.getsize(_log_path) > 0:
            with open(_log_path) as _lf:
                output += "\n" + _lf.read()
            break

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
            r"inference:\s+latency (\w{8})…:\s+mu=([\d.]+)±([\d.]+)\s+\(prior=([\d.]+)\),\s+sigma=([\d.]+)±([\d.]+)\s+\(prior=([\d.]+)\),\s+rhat=([\d.]+),\s+ess=(\d+)(?:,\s+kappa_lat=([\d.]+)±([\d.]+))?",
            line
        )
        if lat_match:
            eid_prefix = lat_match.group(1)
            entry = {
                "mu_mean": float(lat_match.group(2)),
                "mu_sd": float(lat_match.group(3)),
                "mu_prior": float(lat_match.group(4)),
                "sigma_mean": float(lat_match.group(5)),
                "sigma_sd": float(lat_match.group(6)),
                "sigma_prior": float(lat_match.group(7)),
                "rhat": float(lat_match.group(8)),
                "ess": int(lat_match.group(9)),
            }
            if lat_match.group(10) is not None:
                entry["kappa_lat_mean"] = float(lat_match.group(10))
                entry["kappa_lat_sd"] = float(lat_match.group(11))
            posteriors.setdefault(eid_prefix, {}).update(entry)

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

        # Extract parent p from posterior summary:
        #   synth-context-solo-synth-ctx1-anchor-to-target
        #     window(): p=0.3033 (α=3.9, β=9.0)  ess=602 rhat=1.007 [bayesian]
        p_match = re.search(
            r"window\(\):\s+p=([\d.]+)\s+\(α=([\d.]+),\s*β=([\d.]+)\)\s+ess=([\d.]+)\s+rhat=([\d.]+)",
            line
        )
        if p_match:
            # Associate with the most recently seen edge prefix
            # (the edge name line precedes the window() line)
            p_val = float(p_match.group(1))
            p_alpha = float(p_match.group(2))
            p_beta = float(p_match.group(3))
            # Derive SD from alpha/beta: sd = sqrt(ab / ((a+b)^2 * (a+b+1)))
            _ab = p_alpha + p_beta
            p_sd = float((p_alpha * p_beta / (_ab ** 2 * (_ab + 1))) ** 0.5) if _ab > 0 else 0.0
            _last_p_entry = {"p_mean": p_val, "p_sd": p_sd, "p_alpha": p_alpha, "p_beta": p_beta}

        # Match edge name lines to associate p with the right edge
        #   synth-context-solo-synth-ctx1-anchor-to-target
        eid_line_match = re.search(r"^\s{2}(\S+)$", line)
        if eid_line_match:
            _last_edge_name = eid_line_match.group(1)

    # --- Map edge UUIDs to param_ids ---
    with open(graph_path) as f:
        graph = json.load(f)
    uuid_to_pid: dict[str, str] = {}
    for e in graph.get("edges", []):
        pid = e.get("p", {}).get("id", "")
        uuid = e.get("uuid", "")
        if pid and uuid:
            uuid_to_pid[uuid[:8]] = pid

    # Extract parent p from posterior summary block:
    #   synth-context-solo-synth-ctx1-anchor-to-target
    #     window(): p=0.3033 (α=3.9, β=9.0)  ess=602 rhat=1.007 [bayesian]
    _last_edge_name = None
    for line in output.split("\n"):
        eid_line_match = re.search(r"^\s{2}([\w-]+)$", line.rstrip())
        if eid_line_match:
            _last_edge_name = eid_line_match.group(1)
        p_match = re.search(
            r"window\(\):\s+p=([\d.]+)\s+\(α=([\d.]+),\s*β=([\d.]+)\)",
            line
        )
        if p_match and _last_edge_name:
            p_val = float(p_match.group(1))
            p_alpha = float(p_match.group(2))
            p_beta = float(p_match.group(3))
            _ab = p_alpha + p_beta
            p_sd = float((p_alpha * p_beta / (_ab ** 2 * (_ab + 1))) ** 0.5) if _ab > 0 else 0.0
            for _upfx, _upid in uuid_to_pid.items():
                if _upid == _last_edge_name or _last_edge_name.endswith(_upid):
                    posteriors.setdefault(_upfx, {}).update({
                        "p_mean": p_val, "p_sd": p_sd,
                    })
                    break

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

        print(f"  {pid} (uncontexted parent)")
        print(f"  {'─' * 65}")

        if post is None:
            print(f"    NO POSTERIOR FOUND")
            any_fail = True
            print()
            continue

        # Compare all parent parameters (p + latency + kappa)
        for param, truth_key, post_key, sd_key in [
            ("p",     "p",     "p_mean",     "p_sd"),
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

    # --- Phase C: per-slice posterior comparison ---
    # Parse p_slice lines from inference diagnostics. Full format:
    #   p_slice 1d62f264… context(synth-channel:google): 0.4013±0.1175 HDI=[...] kappa=17.2±2.8 mu=1.100±0.005 sigma=0.574±0.004 onset=1.00±0.01
    slice_posteriors: dict[str, dict[str, dict]] = {}  # uuid_prefix → ctx_key → {vars}
    for line in output.split("\n"):
        sp_match = re.search(
            r"p_slice (\w{8})… (context\([^)]+\)):\s+([\d.]+)±([\d.]+)\s+HDI=\[([\d.]+),\s*([\d.]+)\]",
            line
        )
        if sp_match:
            eid_prefix = sp_match.group(1)
            ctx_key = sp_match.group(2)
            entry = {
                "p_mean": float(sp_match.group(3)),
                "p_sd": float(sp_match.group(4)),
                "p_hdi_lower": float(sp_match.group(5)),
                "p_hdi_upper": float(sp_match.group(6)),
            }
            # Extract kappa, mu, sigma, onset from the same line
            for var in ["kappa", "mu", "sigma", "onset"]:
                vm = re.search(rf"{var}=([\d.]+)±([\d.]+)", line)
                if vm:
                    entry[f"{var}_mean"] = float(vm.group(1))
                    entry[f"{var}_sd"] = float(vm.group(2))
            slice_posteriors.setdefault(eid_prefix, {})[ctx_key] = entry

    # Build ground truth per-slice values from context_dimensions
    context_dims = truth.get("context_dimensions", [])
    if context_dims and slice_posteriors:
        print(f"  {'─' * 65}")
        print(f"  Per-slice recovery (Phase C)")
        print(f"  {'─' * 65}")
        print()

        # Get per-slice thresholds from truth file
        testing = truth.get("testing", {})
        per_slice_thresholds = testing.get("per_slice_thresholds", {})
        p_slice_z_threshold = per_slice_thresholds.get("p_slice_z", 3.0)

        for dim in context_dims:
            dim_id = dim["id"]
            for val in dim.get("values", []):
                val_id = val["id"]
                ctx_key = f"context({dim_id}:{val_id})"
                edges_overrides = val.get("edges", {})

                for edge_key, overrides in edges_overrides.items():
                    # Find base edge params from truth
                    base_edge = truth_edges.get(edge_key, {})
                    base_p = base_edge.get("p")
                    if base_p is None:
                        continue

                    # Compute per-slice ground truth for all vars
                    slice_truth = {
                        "p": base_p * overrides.get("p_mult", 1.0),
                        "mu": base_edge.get("mu", 0.0) + overrides.get("mu_offset", 0.0),
                        "sigma": base_edge.get("sigma", 0.0) * overrides.get("sigma_mult", 1.0),
                        "onset": base_edge.get("onset", 0.0) + overrides.get("onset_offset", 0.0),
                    }

                    # Find the posterior for this slice
                    sp = None
                    for prefix, slices in slice_posteriors.items():
                        mapped_pid = uuid_to_pid.get(prefix, "")
                        graph_pid = _truth_key_to_graph_pid.get(edge_key, edge_key)
                        if mapped_pid == graph_pid or mapped_pid == edge_key:
                            sp = slices.get(ctx_key)
                            break

                    label = f"{val_id} ({edge_key})"
                    if sp is None:
                        print(f"    {label:<35s}  posterior=???")
                        continue

                    print(f"    {label}")

                    # Compare each per-slice variable
                    for var, truth_val, post_key, sd_key, z_thresh in [
                        ("p",     slice_truth["p"],     "p_mean",     "p_sd",     p_slice_z_threshold),
                        ("mu",    slice_truth["mu"],    "mu_mean",    "mu_sd",    3.0),
                        ("sigma", slice_truth["sigma"], "sigma_mean", "sigma_sd", 3.0),
                        ("onset", slice_truth["onset"], "onset_mean", "onset_sd", 3.0),
                        ("kappa", None,                 "kappa_mean", "kappa_sd", None),
                    ]:
                        post_val = sp.get(post_key)
                        post_sd = sp.get(sd_key)
                        if post_val is None:
                            continue

                        if var == "kappa":
                            # Kappa: informational only (no ground truth per-slice)
                            print(f"      {var:<8s}  post={post_val:7.1f}±{post_sd:.1f}")
                            continue

                        if truth_val is None or truth_val == 0:
                            continue

                        abs_err = abs(post_val - truth_val)
                        abs_tol = max(0.15, abs(truth_val) * 0.15)
                        if post_sd and post_sd > 0:
                            z_score = abs_err / post_sd
                            recovered = z_score < z_thresh or abs_err < abs_tol
                            status = "OK" if recovered else "MISS"
                        else:
                            z_score = float("inf")
                            recovered = abs_err < abs_tol
                            status = "OK" if recovered else "???"

                        if not recovered:
                            any_fail = True

                        err_str = f"Δ={abs_err:.3f}" if abs_err < abs_tol and z_score >= z_thresh else f"z={z_score:5.2f}"
                        print(f"      {var:<8s}  truth={truth_val:7.3f}  post={post_val:7.3f}±{post_sd:.3f}  "
                              f"{err_str:>10s}  [{status}]")

                    print()

    print(f"{'=' * 70}")
    if any_fail:
        print("  RECOVERY: PARTIAL — some parameters not recovered")
        sys.exit(1)
    else:
        print("  RECOVERY: PASS — all parameters within threshold of truth")
    print(f"{'=' * 70}")


if __name__ == "__main__":
    main()
