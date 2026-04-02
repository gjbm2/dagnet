#!/usr/bin/env python3
"""
Prior sensitivity probe — runs the same prod graph with varied priors
IN PARALLEL via test_harness.py subprocesses.

Usage:
    cd dagnet
    . graph-editor/venv/bin/activate
    python bayes/prior_sensitivity.py --graph simple --edge-prefix 7bb83fbf

Priors are injected via settings.prior_overrides (compiler-level), so the
graph, param files, hashes, and stats pass are all unchanged. Each config
runs as a subprocess calling test_harness.py, visible to bayes-monitor.sh.
"""

from __future__ import annotations

import sys
import os
import json
import copy
import time
import re
import argparse
import subprocess
import yaml
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_THREAD_PIN_ENV = {
    "OMP_NUM_THREADS": "1",
    "MKL_NUM_THREADS": "1",
    "OPENBLAS_NUM_THREADS": "1",
    "NUMBA_NUM_THREADS": "1",
}


# ---------------------------------------------------------------------------
# Prior configurations (as settings.prior_overrides dicts)
# ---------------------------------------------------------------------------

def _make_prior_configs(edge_lat: dict, edge_uuid: str) -> dict:
    prod_mu = edge_lat.get("mu", 0.0)
    prod_sigma = edge_lat.get("sigma", 0.5)
    prod_onset = edge_lat.get("onset_delta_days", 0.0)

    prefix = edge_uuid[:8]

    return {
        "prod": {
            "description": f"As-is (mu={prod_mu:.3f}, sigma={prod_sigma:.3f}, onset={prod_onset:.1f})",
            "prior_overrides": {},  # no override
        },
        "neutral": {
            "description": "Uninformative: mu=0, sigma=0.5, onset=0, Beta(1,1)",
            "prior_overrides": {prefix: {
                "mu": 0.0, "sigma": 0.5, "onset_delta_days": 0.0,
                "alpha": 1.0, "beta": 1.0,
            }},
        },
        "wide": {
            "description": "Prod centre, halved rate ESS",
            "prior_overrides": {},  # no latency override; just wider
            "extra_settings": {"BAYES_MU_PRIOR_SIGMA_FLOOR": 1.0},
        },
        "shifted": {
            "description": f"Onset halved ({prod_onset:.1f}->{prod_onset/2:.1f}), mu+0.5",
            "prior_overrides": {prefix: {
                "mu": prod_mu + 0.5,
                "onset_delta_days": max(0, prod_onset / 2),
            }},
        },
        "no_onset": {
            "description": f"Onset forced to 0 (was {prod_onset:.1f})",
            "prior_overrides": {prefix: {"onset_delta_days": 0.0}},
        },
        "posterior_seeded": {
            "description": "Seeded at last posterior (onset=0.5, mu=2.2, sigma=0.5)",
            "prior_overrides": {prefix: {
                "mu": 2.246, "sigma": 0.515, "onset_delta_days": 0.45,
            }},
        },
    }


# ---------------------------------------------------------------------------
# Subprocess runner
# ---------------------------------------------------------------------------

def _run_one_config(
    config_name: str,
    graph_name: str,
    prior_overrides: dict,
    extra_settings: dict | None,
    draws: int, tune: int, chains: int, cores: int,
    timeout: int,
) -> dict:
    """Run test_harness.py as a subprocess with prior_overrides via env."""
    # Pass prior_overrides and extra settings via a temp settings JSON file
    import tempfile
    settings_data = {}
    if prior_overrides:
        settings_data["prior_overrides"] = prior_overrides
    if extra_settings:
        settings_data.update(extra_settings)

    # Write settings to a temp file, pass via --settings-file
    # (We'll use env var instead since harness doesn't have --settings-file)
    # Actually, the harness passes settings into payload directly.
    # We need a way to inject. Simplest: add --prior-overrides to harness.
    # But let's use a temp JSON file and a new --settings-json flag.

    settings_file = None
    if settings_data:
        fd, settings_file = tempfile.mkstemp(suffix=".json", prefix=f"bayes-sens-{config_name}-")
        with os.fdopen(fd, "w") as f:
            json.dump(settings_data, f)

    cmd = [
        sys.executable,
        os.path.join(REPO_ROOT, "bayes", "test_harness.py"),
        "--graph", graph_name,
        "--no-webhook",
        "--draws", str(draws),
        "--tune", str(tune),
        "--chains", str(chains),
        "--cores", str(cores),
    ]
    if settings_file:
        cmd.extend(["--settings-json", settings_file])

    env = {**os.environ, **_THREAD_PIN_ENV}

    t0 = time.time()
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=timeout + 120,
            env=env, cwd=REPO_ROOT,
        )
        elapsed = time.time() - t0
        return {
            "config": config_name,
            "exit_code": result.returncode,
            "elapsed_s": elapsed,
            "output": result.stdout + result.stderr,
            "error": None if result.returncode == 0 else f"exit {result.returncode}",
        }
    except subprocess.TimeoutExpired:
        return {
            "config": config_name, "exit_code": -1,
            "elapsed_s": time.time() - t0, "output": "",
            "error": f"Timeout after {timeout}s",
        }
    except Exception as e:
        return {
            "config": config_name, "exit_code": -1,
            "elapsed_s": time.time() - t0, "output": "",
            "error": str(e),
        }
    finally:
        if settings_file and os.path.isfile(settings_file):
            os.unlink(settings_file)


# ---------------------------------------------------------------------------
# Result parsing
# ---------------------------------------------------------------------------

def _parse_output(output: str, edge_prefix: str) -> dict:
    result: dict = {"quality": {}, "target": {}}

    # Global quality
    m = re.search(r"rhat=([\d.]+),\s*ess=([\d.]+),\s*converged=([\d.]+)%", output)
    if m:
        result["quality"] = {"rhat": float(m.group(1)), "ess": float(m.group(2)),
                             "converged_pct": float(m.group(3))}

    m_div = re.search(r"divergences=(\d+)", output)
    if m_div:
        result["quality"]["divergences"] = int(m_div.group(1))

    # Target edge latency line:
    # "inference:   latency 7bb83fbf…: mu=2.233±0.029 (prior=1.607), sigma=0.403±0.018 (prior=0.527), rhat=1.002, ess=1255"
    pat = re.compile(
        rf"latency {re.escape(edge_prefix)}.*?"
        r"mu=([\d.]+)±([\d.]+).*?"
        r"sigma=([\d.]+)±([\d.]+).*?"
        r"rhat=([\d.]+),\s*ess=(\d+)"
    )
    m_lat = pat.search(output)
    if m_lat:
        result["target"]["mu"] = float(m_lat.group(1))
        result["target"]["sigma"] = float(m_lat.group(3))
        result["target"]["rhat"] = float(m_lat.group(5))
        result["target"]["ess"] = int(m_lat.group(6))

    # Onset line: "inference:   onset 7bb83fbf…: 0.60±0.21 (prior=5.50)"
    pat_onset = re.compile(
        rf"onset {re.escape(edge_prefix)}.*?"
        r"([\d.]+)±([\d.]+)\s+\(prior=([\d.]+)\)"
    )
    m_onset = pat_onset.search(output)
    if m_onset:
        result["target"]["onset"] = float(m_onset.group(1))
        result["target"]["onset_prior"] = float(m_onset.group(3))

    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Prior sensitivity probe")
    parser.add_argument("--graph", default="simple")
    parser.add_argument("--edge-prefix", required=True)
    parser.add_argument("--configs", default=None)
    parser.add_argument("--draws", type=int, default=500)
    parser.add_argument("--tune", type=int, default=300)
    parser.add_argument("--chains", type=int, default=4)
    parser.add_argument("--cores", type=int, default=3)
    parser.add_argument("--max-parallel", type=int, default=6)
    parser.add_argument("--timeout", type=int, default=400)
    args = parser.parse_args()

    GRAPH_SHORTCUTS = {"simple": "bayes-test-gm-rebuild", "branch": "conversion-flow-v2-recs-collapsed"}
    graph_name = GRAPH_SHORTCUTS.get(args.graph, args.graph)

    # Load graph to find target edge
    sys.path.insert(0, os.path.join(REPO_ROOT, "bayes"))
    from test_harness import _read_private_repos_conf
    conf = _read_private_repos_conf()
    data_repo_path = os.path.join(REPO_ROOT, conf.get("DATA_REPO_DIR", ""))
    graph_path = os.path.join(data_repo_path, "graphs", f"{graph_name}.json")
    with open(graph_path) as f:
        graph = json.load(f)

    target_edge = None
    for edge in graph.get("edges", []):
        if edge.get("uuid", "").startswith(args.edge_prefix):
            target_edge = edge
            break
    if not target_edge:
        print(f"ERROR: No edge starting with '{args.edge_prefix}'")
        sys.exit(1)

    target_uuid = target_edge["uuid"]
    target_pid = target_edge.get("p", {}).get("id", "?")
    t_lat = target_edge.get("p", {}).get("latency", {})
    print(f"Target: {target_uuid[:12]}… ({target_pid})")
    print(f"  mu={t_lat.get('mu', '?')}, sigma={t_lat.get('sigma', '?')}, onset={t_lat.get('onset_delta_days', '?')}")

    configs = _make_prior_configs(t_lat, target_uuid)
    if args.configs:
        selected = [c.strip() for c in args.configs.split(",")]
        configs = {k: v for k, v in configs.items() if k in selected}

    print(f"\n{'=' * 70}")
    print(f"SENSITIVITY: {len(configs)} configs × {args.max_parallel} parallel")
    print(f"Sampling: {args.draws} draws, {args.tune} tune, {args.chains} chains, {args.cores} cores/config")
    print(f"{'=' * 70}")
    for name, cfg in configs.items():
        print(f"  {name:20s}  {cfg['description']}")

    # Build run args
    run_args = [
        (name, graph_name, cfg.get("prior_overrides", {}), cfg.get("extra_settings"),
         args.draws, args.tune, args.chains, args.cores, args.timeout)
        for name, cfg in configs.items()
    ]

    print(f"\nLaunching... (monitor: scripts/bayes-monitor.sh)")
    t_total = time.time()

    results = {}
    with ProcessPoolExecutor(max_workers=args.max_parallel) as pool:
        futures = {pool.submit(_run_one_config, *ra): ra[0] for ra in run_args}
        for future in as_completed(futures):
            name = futures[future]
            r = future.result()
            p = _parse_output(r.get("output", ""), args.edge_prefix)
            r["parsed"] = p
            results[name] = r
            t = p.get("target", {})
            rhat_s = f"rhat={t['rhat']:.3f} ess={t['ess']}" if "rhat" in t else ""
            status = "OK" if r["exit_code"] == 0 else "FAIL"
            print(f"  {status:4s} {name:20s} ({r['elapsed_s']:.0f}s)  {rhat_s}")

    print(f"\nDone in {time.time() - t_total:.0f}s")

    # Summary
    def _fmt(v, f=".3f"):
        return f"{float(v):{f}}" if v is not None else "—"

    print(f"\n{'=' * 95}")
    print(f"{'Config':20s} {'rhat':>7s} {'ESS':>6s} {'Div':>4s} {'mu':>8s} {'sigma':>8s} {'onset':>8s} {'o_prior':>8s}")
    print(f"{'-'*20} {'-'*7} {'-'*6} {'-'*4} {'-'*8} {'-'*8} {'-'*8} {'-'*8}")

    for name in configs:
        r = results.get(name, {})
        p = r.get("parsed", {})
        q = p.get("quality", {})
        t = p.get("target", {})
        print(f"{name:20s} {_fmt(t.get('rhat'), '.3f'):>7s} {_fmt(t.get('ess'), '.0f'):>6s} "
              f"{_fmt(q.get('divergences'), '.0f'):>4s} "
              f"{_fmt(t.get('mu'), '.3f'):>8s} {_fmt(t.get('sigma'), '.3f'):>8s} "
              f"{_fmt(t.get('onset'), '.2f'):>8s} {_fmt(t.get('onset_prior'), '.1f'):>8s}")

    print(f"\n{'─' * 95}")
    print("ALL converge similarly → priors were wrong, geometry fine.")
    print("SOME fail              → prior-sensitive geometry (ridge).")
    print("NONE converge          → model misspecification.")


if __name__ == "__main__":
    main()
