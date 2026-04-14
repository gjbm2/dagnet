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

from recovery_slices import (
    build_slice_truth_baselines,
    compose_slice_truth,
    iter_expected_single_slice_specs,
    make_slice_label,
    match_truth_edge_key,
    parse_slice_label,
)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


_NUMBER_RE = r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?"
_SLICE_POSTERIOR_RE = re.compile(
    rf"p_slice (\w{{8}})… (.+?):\s+({_NUMBER_RE})±({_NUMBER_RE})\s+"
    rf"HDI=\[({_NUMBER_RE}),\s*({_NUMBER_RE})\]"
)


def _parse_slice_posteriors(output: str) -> dict[str, dict[str, dict]]:
    """Parse per-slice posterior lines from harness diagnostics."""
    slice_posteriors: dict[str, dict[str, dict]] = {}
    for line in output.split("\n"):
        sp_match = _SLICE_POSTERIOR_RE.search(line)
        if not sp_match:
            continue

        eid_prefix = sp_match.group(1)
        ctx_key = sp_match.group(2)
        entry = {
            "p_mean": float(sp_match.group(3)),
            "p_sd": float(sp_match.group(4)),
            "p_hdi_lower": float(sp_match.group(5)),
            "p_hdi_upper": float(sp_match.group(6)),
        }
        for var in ["kappa", "mu", "sigma", "onset"]:
            vm = re.search(rf"{var}=({_NUMBER_RE})±({_NUMBER_RE})", line)
            if vm:
                entry[f"{var}_mean"] = float(vm.group(1))
                entry[f"{var}_sd"] = float(vm.group(2))
        slice_posteriors.setdefault(eid_prefix, {})[ctx_key] = entry
    return slice_posteriors


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
                        help="Pass --clean to harness (clears __pycache__ bytecode)")
    parser.add_argument("--rebuild", action="store_true",
                        help="Pass --rebuild to harness (deletes synth-meta, forces DB re-insert)")
    parser.add_argument("--job-label", type=str, default=None,
                        help="Unique label for log files (forwarded to harness --job-label). "
                             "Prevents parallel runs from cross-contaminating logs.")
    parser.add_argument("--dsl-override", type=str, default=None,
                        help="Override pinnedDSL (forwarded to harness --dsl-override)")
    parser.add_argument("--diag", action="store_true",
                        help="Enable extra diagnostics (forwarded to harness --diag)")
    parser.add_argument("--phase2-from-dump", type=str, default=None, metavar="PATH",
                        help="Skip Phase 1: load artefacts from dump dir, run Phase 2 only "
                             "(forwarded to harness --phase2-from-dump)")
    parser.add_argument("--settings-json", type=str, default=None, metavar="PATH",
                        help="Path to extra settings JSON to merge into the payload "
                             "(e.g. target_accept, overprovision_chains)")
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
        slice_truth_baselines = build_slice_truth_baselines(truth)
        if slice_truth_baselines:
            import tempfile
            settings_json_path = tempfile.mktemp(suffix=".json", prefix="bayes_settings_")
            with open(settings_json_path, "w") as sf:
                json.dump({"slice_truth_baselines": slice_truth_baselines}, sf)

    # --- Build calibration truth for PPC (doc 38) ---
    # Pass ground-truth parameters so calibration can compute the true
    # PIT alongside the model PIT — validates both model AND machinery.
    #
    # The synth generator has TWO independent kappa sources (entry-day
    # and step-day), composed multiplicatively.  Endpoint observations
    # see the composed variation (effective κ ≈ κ/2).  Trajectory
    # intervals see step-day variation primarily (effective κ ≈ κ_step).
    if args.diag:
        _sim = truth.get("simulation", {})
        _kappa_entry = _sim.get("kappa_sim_default", _sim.get("user_kappa", 50.0))
        _kappa_step = _sim.get("kappa_step_default", _kappa_entry)
        # Effective endpoint kappa: two composed Beta draws.
        # Var(p_eff) ≈ Var(p_entry) + Var(p_step) for small variances.
        # κ_eff ≈ 1 / (1/κ_entry + 1/κ_step)  (harmonic mean).
        _kappa_endpoint = 1.0 / (1.0 / _kappa_entry + 1.0 / _kappa_step) if _kappa_step > 0 else _kappa_entry
        cal_truth: dict[str, dict] = {}
        for pid, t in truth_edges.items():
            cal_truth[pid] = {
                "p": t["p"],
                "kappa_endpoint": t.get("kappa", _kappa_endpoint),
                "kappa_trajectory": t.get("kappa", _kappa_step),
                "mu": t.get("mu", 0.0),
                "sigma": t.get("sigma", 0.01),
                "onset": t.get("onset", 0.0),
            }
        settings_payload = {}
        if settings_json_path and os.path.isfile(settings_json_path):
            with open(settings_json_path) as sf:
                settings_payload = json.load(sf)
        settings_payload["calibration_truth"] = cal_truth
        if not settings_json_path:
            import tempfile
            settings_json_path = tempfile.mktemp(suffix=".json", prefix="bayes_settings_")
        with open(settings_json_path, "w") as sf:
            json.dump(settings_payload, sf)

    # --- Merge external settings JSON (e.g. target_accept, overprovision_chains) ---
    if args.settings_json:
        with open(args.settings_json) as _ext_f:
            _ext_settings = json.load(_ext_f)
        if _ext_settings:
            # Merge into existing settings payload or create one
            if settings_json_path and os.path.isfile(settings_json_path):
                with open(settings_json_path) as _sf:
                    _existing = json.load(_sf)
                _existing.update(_ext_settings)
                with open(settings_json_path, "w") as _sf:
                    json.dump(_existing, _sf)
            else:
                import tempfile
                settings_json_path = tempfile.mktemp(suffix=".json", prefix="bayes_settings_")
                with open(settings_json_path, "w") as _sf:
                    json.dump(_ext_settings, _sf)

    # --- Run harness ---
    # When --phase2-from-dump is set, skip the expensive --fe-payload CLI call.
    # Build a minimal payload with just graph_id and settings, pass via --payload.
    _payload_path = None
    if args.phase2_from_dump:
        import tempfile, glob as _glob
        # Load graph JSON and param files for the payload
        with open(graph_path) as _gf:
            _graph_json = json.load(_gf)
        # Load param files (needed for analytic comparison in harness)
        _param_files = {}
        _params_index = {}
        _params_dir = os.path.join(data_repo, "parameters")
        for _pf_path in _glob.glob(os.path.join(_params_dir, "*.yaml")):
            _pf_name = os.path.basename(_pf_path).replace(".yaml", "")
            if "index" in _pf_name:
                continue
            with open(_pf_path) as _pff:
                _param_files[_pf_name] = yaml.safe_load(_pff) or {}
            _params_index[_pf_name] = {"file_path": f"parameters/{_pf_name}.yaml"}
        _minimal_payload = {
            "graph_id": f"graph-{args.graph}",
            "graph_snapshot": _graph_json,
            "parameter_files": _param_files,
            "parameters_index": _params_index,
            "settings": {
                "phase2_from_dump": args.phase2_from_dump,
            },
        }
        _payload_path = tempfile.mktemp(suffix=".json", prefix="bayes_p2dump_")
        with open(_payload_path, "w") as _pf:
            json.dump(_minimal_payload, _pf)
        print(f"  Phase 2 from dump: minimal payload at {_payload_path}")

    cmd = [
        sys.executable, os.path.join(REPO_ROOT, "bayes", "test_harness.py"),
        "--graph", args.graph,
        "--no-webhook",
        "--timeout", str(args.timeout),
    ]
    if _payload_path:
        cmd.extend(["--payload", _payload_path])
    else:
        cmd.append("--fe-payload")
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
    if args.rebuild:
        cmd.append("--rebuild")
    if args.job_label:
        cmd.extend(["--job-label", args.job_label])
    if args.dsl_override:
        cmd.extend(["--dsl-override", args.dsl_override])
    if args.diag:
        cmd.append("--diag")
    if args.phase2_from_dump:
        cmd.extend(["--phase2-from-dump", args.phase2_from_dump])

    print(f"Running: {' '.join(cmd[-6:])}")
    print()

    # Pin thread counts to prevent BLAS/OpenMP oversubscription during parallel runs.
    # PYTHONDONTWRITEBYTECODE: prevent stale .pyc from masking source edits.
    _jax = any(f.startswith("jax_backend=t") for f in args.feature)
    if _jax:
        # JAX's XLA thread pool benefits from all cores — don't pin to 1.
        # Explicitly enable multi-threaded Eigen and set intra-op threads.
        import os as _os
        _ncpu = str(_os.cpu_count() or 16)
        env = {**os.environ,
               "PYTHONDONTWRITEBYTECODE": "1",
               "XLA_FLAGS": "--xla_cpu_multi_thread_eigen=true",
               "OMP_NUM_THREADS": _ncpu,
               "MKL_NUM_THREADS": _ncpu,
               "OPENBLAS_NUM_THREADS": _ncpu,
               }
    else:
        # numba: pin threads to prevent BLAS/OpenMP oversubscription in parallel.
        env = {**os.environ, "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1",
               "OPENBLAS_NUM_THREADS": "1", "NUMBA_NUM_THREADS": "1",
               "PYTHONDONTWRITEBYTECODE": "1"}

    t0 = time.time()
    try:
        _sub_timeout = None if args.timeout == 0 else args.timeout + 60
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=_sub_timeout, env=env)
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
    _last_cohort_p_entry = None
    _slice_posteriors: dict[str, dict] = {}  # eid_prefix → {ctx_key → {p_mean, p_sd}}

    # When using --phase2-from-dump, seed posteriors with Phase 1 frozen values.
    # These are the Phase 1 MCMC results (p, mu, sigma, onset) that the dump captured.
    if args.phase2_from_dump:
        _frozen_path = os.path.join(args.phase2_from_dump, "phase2_frozen.json")
        if os.path.isfile(_frozen_path):
            with open(_frozen_path) as _ff:
                _frozen = json.load(_ff)
            # Map edge UUIDs to 8-char prefixes for posteriors dict
            with open(graph_path) as _gf2:
                _g2 = json.load(_gf2)
            for _e2 in _g2.get("edges", []):
                _uuid2 = _e2.get("uuid", "")
                if _uuid2 and _uuid2 in _frozen:
                    _fe = _frozen[_uuid2]
                    posteriors[_uuid2[:8]] = {
                        "p_mean": _fe.get("p"),
                        "p_sd": _fe.get("p_sd"),
                        "mu_mean": _fe.get("mu"),
                        "mu_sd": _fe.get("mu_sd"),
                        "sigma_mean": _fe.get("sigma"),
                        "sigma_sd": _fe.get("sigma_sd"),
                        "onset_mean": _fe.get("onset"),
                        "onset_sd": _fe.get("onset_sd"),
                        "_source": "phase1_frozen",
                    }

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

        # inference:   reparam 7008ad7a…: corr(m,a)=-0.305, corr(m,r)=-0.462, corr(a,r)=0.742
        reparam_match = re.search(
            r"inference:\s+reparam (\w{8})…:\s+"
            r"corr\(m,a\)=([-\d.]+),\s+"
            r"corr\(m,r\)=([-\d.]+),\s+"
            r"corr\(a,r\)=([-\d.]+)",
            line
        )
        if reparam_match:
            eid_prefix = reparam_match.group(1)
            posteriors.setdefault(eid_prefix, {}).update({
                "corr_m_a": float(reparam_match.group(2)),
                "corr_m_r": float(reparam_match.group(3)),
                "corr_a_r": float(reparam_match.group(4)),
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

        # Phase 2 cohort p from posterior summary:
        #     cohort(): p=0.5175 (α=86.4, β=80.6)  ess=3 rhat=1.828 [bayesian]
        cohort_p_match = re.search(
            r"cohort\(\):\s+p=([\d.]+)\s+\(α=([\d.]+),\s*β=([\d.]+)\)\s+ess=([\d.]+)\s+rhat=([\d.]+)",
            line
        )
        if cohort_p_match:
            _c_val = float(cohort_p_match.group(1))
            _c_alpha = float(cohort_p_match.group(2))
            _c_beta = float(cohort_p_match.group(3))
            _c_ab = _c_alpha + _c_beta
            _c_sd = float((_c_alpha * _c_beta / (_c_ab ** 2 * (_c_ab + 1))) ** 0.5) if _c_ab > 0 else 0.0
            _last_cohort_p_entry = {"cohort_p_mean": _c_val, "cohort_p_sd": _c_sd}

        # Phase 2 per-slice cohort p from worker log:
        #   Phase 2 slice 790a6277… context(synth-channel:direct): p=0.5196±0.0062
        slice_p_match = re.search(
            r"Phase 2 slice (\w{8})…\s+(context\([^)]+\)):\s+p=([\d.]+)±([\d.]+)",
            line
        )
        if slice_p_match:
            _sp_eid = slice_p_match.group(1)
            _sp_ctx = slice_p_match.group(2)
            _sp_p = float(slice_p_match.group(3))
            _sp_sd = float(slice_p_match.group(4))
            _slice_posteriors.setdefault(_sp_eid, {})[_sp_ctx] = {
                "p_mean": _sp_p, "p_sd": _sp_sd,
            }

        # Phase 2 path latency from worker log:
        #   Phase 2 path_latency 60daa859…: onset=3.0 mu=2.966 sigma=0.386
        path_lat_match = re.search(
            r"Phase 2 path_latency (\w{8})…:\s+onset=([\d.]+)\s+mu=([\d.]+)\s+sigma=([\d.]+)",
            line
        )
        if path_lat_match:
            _pl_eid = path_lat_match.group(1)
            posteriors.setdefault(_pl_eid, {}).update({
                "onset_mean": float(path_lat_match.group(2)),
                "mu_mean": float(path_lat_match.group(3)),
                "sigma_mean": float(path_lat_match.group(4)),
            })

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
        # Also parse cohort() p and store as cohort_p_mean
        cohort_p_match2 = re.search(
            r"cohort\(\):\s+p=([\d.]+)\s+\(α=([\d.]+),\s*β=([\d.]+)\)",
            line
        )
        if cohort_p_match2 and _last_edge_name:
            _c2_val = float(cohort_p_match2.group(1))
            _c2_alpha = float(cohort_p_match2.group(2))
            _c2_beta = float(cohort_p_match2.group(3))
            _c2_ab = _c2_alpha + _c2_beta
            _c2_sd = float((_c2_alpha * _c2_beta / (_c2_ab ** 2 * (_c2_ab + 1))) ** 0.5) if _c2_ab > 0 else 0.0
            for _upfx, _upid in uuid_to_pid.items():
                if _upid == _last_edge_name or _last_edge_name.endswith(_upid):
                    posteriors.setdefault(_upfx, {}).update({
                        "cohort_p_mean": _c2_val, "cohort_p_sd": _c2_sd,
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
        # Show window p and cohort p separately when both exist.
        _p_rows = [("p",     "p",     "p_mean",     "p_sd")]
        if "cohort_p_mean" in post:
            _p_rows.append(("p_coh", "p", "cohort_p_mean", "cohort_p_sd"))
        for param, truth_key, post_key, sd_key in _p_rows + [
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
            if param == "onset" and "corr_m_a" in post:
                corr_str += f"  corr(m,a)={post['corr_m_a']:.3f}"

            err_str = f"Δ={abs_err:.3f}" if abs_err < abs_tol and z_score >= 3.0 else f"z={z_score:5.2f}"
            print(f"    {param:<8s}  truth={truth_val:7.3f}  post={post_val:7.3f}±{post_sd:.3f}  "
                  f"{err_str:>10s}  [{status}]{prior_str}{corr_str}")

        if "kappa_mean" in post:
            print(f"    {'kappa':<8s}  sim={t.get('kappa', 50.0):7.1f}  post={post['kappa_mean']:7.1f}±{post['kappa_sd']:.1f}")
        if "rhat" in post:
            print(f"    {'rhat':<8s}  {post['rhat']:.4f}  ess={post.get('ess', '?')}")
        if "corr_m_a" in post:
            print(f"    {'reparam':<8s}  corr(m,a)={post['corr_m_a']:.3f}  "
                  f"corr(m,r)={post['corr_m_r']:.3f}  "
                  f"corr(a,r)={post['corr_a_r']:.3f}")
        print()

    # --- Phase C: per-slice posterior comparison ---
    slice_posteriors = _parse_slice_posteriors(output)
    # Merge Phase 2 per-slice posteriors (from --phase2-from-dump log lines)
    for _sp_eid, _sp_slices in _slice_posteriors.items():
        slice_posteriors.setdefault(_sp_eid, {}).update(_sp_slices)

    def _print_slice_recovery_block(
        label: str,
        slice_truth: dict,
        sp: dict,
        *,
        p_slice_z_threshold: float,
    ) -> bool:
        block_failed = False
        print(f"    {label}")

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
                block_failed = True

            err_str = f"Δ={abs_err:.3f}" if abs_err < abs_tol and z_score >= z_thresh else f"z={z_score:5.2f}"
            print(
                f"      {var:<8s}  truth={truth_val:7.3f}  post={post_val:7.3f}±{post_sd:.3f}  "
                f"{err_str:>10s}  [{status}]"
            )

        print()
        return block_failed

    if context_dims:
        print(f"  {'─' * 65}")
        print(f"  Per-slice recovery (Phase C)")
        print(f"  {'─' * 65}")
        print()

        # Get per-slice thresholds from truth file
        testing = truth.get("testing", {})
        per_slice_thresholds = testing.get("per_slice_thresholds", {})
        p_slice_z_threshold = per_slice_thresholds.get("p_slice_z", 3.0)

        if not slice_posteriors:
            print("    NO PER-SLICE POSTERIORS FOUND")
            print()
            any_fail = True
        else:
            parsed_by_label: dict[str, dict] = {}
            for prefix, slices in slice_posteriors.items():
                graph_pid = uuid_to_pid.get(prefix, "")
                if not graph_pid:
                    continue
                truth_edge_key = match_truth_edge_key(graph_pid, truth_edges)
                if not truth_edge_key:
                    continue
                for ctx_key, entry in slices.items():
                    parsed_by_label[make_slice_label(ctx_key, truth_edge_key)] = entry

            seen_labels: set[str] = set()
            for spec in iter_expected_single_slice_specs(truth):
                label = spec["label"]
                sp = parsed_by_label.get(label)
                if sp is None:
                    print(f"    {label}")
                    print("      posterior=???")
                    print()
                    any_fail = True
                    continue
                if _print_slice_recovery_block(
                    label,
                    spec["truth"],
                    sp,
                    p_slice_z_threshold=p_slice_z_threshold,
                ):
                    any_fail = True
                seen_labels.add(label)

            for label, sp in sorted(parsed_by_label.items()):
                if label in seen_labels:
                    continue
                parsed_label = parse_slice_label(label)
                if parsed_label is None:
                    continue
                ctx_key, edge_key = parsed_label
                slice_truth = compose_slice_truth(truth, edge_key, ctx_key)
                if slice_truth is None:
                    continue
                if _print_slice_recovery_block(
                    label,
                    slice_truth,
                    sp,
                    p_slice_z_threshold=p_slice_z_threshold,
                ):
                    any_fail = True

    print(f"{'=' * 70}")
    if any_fail:
        print("  RECOVERY: PARTIAL — some parameters not recovered")
        sys.exit(1)
    else:
        print("  RECOVERY: PASS — all parameters within threshold of truth")
    print(f"{'=' * 70}")


if __name__ == "__main__":
    main()
