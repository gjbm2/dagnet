#!/usr/bin/env python3
"""
Softplus sharpness sweep — runs the same graph with varying BAYES_SOFTPLUS_SHARPNESS
to find the sweet spot between "smooth enough for NUTS" and "sharp enough to prevent
degenerate modes".

Usage:
    cd dagnet
    . graph-editor/venv/bin/activate
    python bayes/softplus_sweep.py --graph simple --edge-prefix 7bb83fbf
"""

from __future__ import annotations

import sys
import os
import json
import time
import re
import argparse
import subprocess
import tempfile
from concurrent.futures import ProcessPoolExecutor, as_completed

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_THREAD_PIN_ENV = {
    "OMP_NUM_THREADS": "1",
    "MKL_NUM_THREADS": "1",
    "OPENBLAS_NUM_THREADS": "1",
    "NUMBA_NUM_THREADS": "1",
}


def _run_one(k_value: float, graph_name: str,
             draws: int, tune: int, chains: int, cores: int,
             timeout: int) -> dict:
    settings = {"BAYES_SOFTPLUS_SHARPNESS": k_value}
    fd, settings_file = tempfile.mkstemp(suffix=".json", prefix=f"softplus-k{k_value}-")
    with os.fdopen(fd, "w") as f:
        json.dump(settings, f)

    cmd = [
        sys.executable, os.path.join(REPO_ROOT, "bayes", "test_harness.py"),
        "--graph", graph_name, "--no-webhook",
        "--draws", str(draws), "--tune", str(tune),
        "--chains", str(chains), "--cores", str(cores),
        "--settings-json", settings_file,
    ]

    t0 = time.time()
    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                           timeout=timeout + 120, env={**os.environ, **_THREAD_PIN_ENV},
                           cwd=REPO_ROOT)
        return {"k": k_value, "exit_code": r.returncode,
                "elapsed_s": time.time() - t0, "output": r.stdout + r.stderr}
    except subprocess.TimeoutExpired:
        return {"k": k_value, "exit_code": -1, "elapsed_s": time.time() - t0,
                "output": "", "error": "timeout"}
    finally:
        os.unlink(settings_file)


def _parse(output: str, prefix: str) -> dict:
    result: dict = {}

    pat = re.compile(
        rf"latency {re.escape(prefix)}.*?"
        r"mu=([\d.]+)±([\d.]+).*?"
        r"sigma=([\d.]+)±([\d.]+).*?"
        r"rhat=([\d.]+),\s*ess=(\d+)"
    )
    m = pat.search(output)
    if m:
        result["mu"] = float(m.group(1))
        result["sigma"] = float(m.group(3))
        result["rhat"] = float(m.group(5))
        result["ess"] = int(m.group(6))

    pat_o = re.compile(
        rf"onset {re.escape(prefix)}.*?"
        r"([\d.]+)±([\d.]+)\s+\(prior=([\d.]+)\)"
    )
    m_o = pat_o.search(output)
    if m_o:
        result["onset"] = float(m_o.group(1))

    m_div = re.search(r"sampling:.*divergences=(\d+)", output)
    if m_div:
        result["divergences"] = int(m_div.group(1))

    return result


def main():
    parser = argparse.ArgumentParser(description="Softplus sharpness sweep")
    parser.add_argument("--graph", default="simple")
    parser.add_argument("--edge-prefix", required=True)
    parser.add_argument("--k-values", default="1.0,2.0,3.0,5.0,8.0",
                        help="Comma-separated k values (default: 1.0,2.0,3.0,5.0,8.0)")
    parser.add_argument("--draws", type=int, default=500)
    parser.add_argument("--tune", type=int, default=300)
    parser.add_argument("--chains", type=int, default=4)
    parser.add_argument("--cores", type=int, default=3)
    parser.add_argument("--max-parallel", type=int, default=5)
    parser.add_argument("--timeout", type=int, default=400)
    args = parser.parse_args()

    GRAPH_SHORTCUTS = {"simple": "bayes-test-gm-rebuild", "branch": "conversion-flow-v2-recs-collapsed"}
    graph_name = GRAPH_SHORTCUTS.get(args.graph, args.graph)
    k_values = [float(k.strip()) for k in args.k_values.split(",")]

    print(f"Softplus sharpness sweep: k={k_values}")
    print(f"Graph: {graph_name}, edge: {args.edge_prefix}")
    print(f"Sampling: {args.draws} draws, {args.tune} tune, {args.chains} chains")
    print(f"Parallel: {args.max_parallel}\n")

    t0 = time.time()
    results = {}
    with ProcessPoolExecutor(max_workers=args.max_parallel) as pool:
        futures = {
            pool.submit(_run_one, k, graph_name, args.draws, args.tune,
                        args.chains, args.cores, args.timeout): k
            for k in k_values
        }
        for f in as_completed(futures):
            k = futures[f]
            r = f.result()
            p = _parse(r.get("output", ""), args.edge_prefix)
            r["parsed"] = p
            results[k] = r
            rhat_s = f"rhat={p['rhat']:.3f} ess={p['ess']}" if "rhat" in p else "FAIL"
            print(f"  k={k:5.1f}  ({r['elapsed_s']:.0f}s)  {rhat_s}")

    print(f"\nDone in {time.time() - t0:.0f}s\n")

    def _fmt(v, f=".3f"):
        return f"{float(v):{f}}" if v is not None else "—"

    print(f"{'k':>6s} {'rhat':>7s} {'ESS':>6s} {'Div':>4s} {'mu':>8s} {'sigma':>8s} {'onset':>8s}")
    print(f"{'-'*6} {'-'*7} {'-'*6} {'-'*4} {'-'*8} {'-'*8} {'-'*8}")

    for k in sorted(results.keys()):
        p = results[k].get("parsed", {})
        print(f"{k:6.1f} {_fmt(p.get('rhat'), '.3f'):>7s} {_fmt(p.get('ess'), '.0f'):>6s} "
              f"{_fmt(p.get('divergences'), '.0f'):>4s} "
              f"{_fmt(p.get('mu'), '.3f'):>8s} {_fmt(p.get('sigma'), '.3f'):>8s} "
              f"{_fmt(p.get('onset'), '.2f'):>8s}")

    print(f"\nLower k = smoother gradients, easier NUTS adaptation, but more leakage below onset.")
    print(f"Look for: lowest k where onset posterior is still reasonable (not drifting high).")


if __name__ == "__main__":
    main()
