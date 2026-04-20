#!/usr/bin/env python3
"""Stress matrix for branch-group + context degradation frontier.

Purpose
───────
Reproduce the native-kernel segfault observed on diamond sparsity graphs
by constructing the smallest possible branch-group + context truth YAML
and sweeping the parameters that control per-slice data density:

  * mean_daily_traffic   → volume per day
  * n_days               → observation horizon
  * n_ctx_values         → context dim cardinality (drives bg complexity)
  * initial_absent_pct   → fraction of (edge, slice_key) starting absent
  * toggle_rate          → chance of mid-run emit state flip
  * seed                 → RNG state

Each cell: (1) write truth YAML, (2) bootstrap via synth_gen subprocess,
(3) fit via test_harness subprocess with faulthandler armed, (4) record
exit code, empty-slice count, elapsed, fault-trace presence.

Why not an in-process test
──────────────────────────
The crash is in native compiled code (signal 11) during MCMC sampling.
We need a subprocess boundary so each cell's crash doesn't take out the
harness. run_regression already threads BAYES_FAULT_LOG so faulthandler
captures the stack trace before the process dies.

Usage
─────
  python bayes/stress_bg_degradation.py --matrix quick
  python bayes/stress_bg_degradation.py --matrix frontier

Outputs a JSON summary at /tmp/stress-bg-<timestamp>.json.
"""

import argparse
import json
import os
import subprocess
import sys
import time
import yaml

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRUTH_DIR = os.path.join(REPO_ROOT, "bayes", "truth")


# ── Minimum-diamond truth template ─────────────────────────────────────
# Two-sibling branch group + context dim. The smallest shape that
# exercises Section 6 branch-group Multinomial-per-slice emission.

def build_truth(
    name: str,
    *,
    traffic: int,
    n_days: int,
    n_ctx_values: int,
    initial_absent_pct: float,
    toggle_rate: float,
    seed: int,
) -> dict:
    """Build a diamond truth YAML for one stress cell.

    Topology:
        anchor → gate → {path-a, path-b} → join → outcome

    gate → path-a + gate → path-b is the 2-sibling branch group.
    Context dim `ctx` drives per-slice emission. Values labelled v0..v{k-1}.
    """
    ctx_values = []
    for i in range(n_ctx_values):
        entry = {
            "id": f"v{i}",
            "label": f"V{i}",
            "weight": 1.0 / n_ctx_values,
            "sources": {
                "amplitude": {
                    "field": "utm_medium",
                    "filter": f"utm_medium == 'v{i}'",
                }
            },
        }
        # Per-edge multiplier on branch-group edges to create real
        # cross-slice variation (otherwise pymc may pool them to a
        # degenerate posterior).
        if i == 0:
            entry["edges"] = {
                f"{name}-gate-to-path-a": {"p_mult": 1.2, "mu_offset": -0.1},
                f"{name}-gate-to-path-b": {"p_mult": 0.9, "mu_offset": 0.1},
            }
        ctx_values.append(entry)

    return {
        "simulation": {
            "mean_daily_traffic": traffic,
            "n_days": n_days,
            "user_kappa": 50,
            "failure_rate": 0.05,
            "drift_sigma": 0.0,
            "seed": seed,
            "expected_sample_seconds": 600,
            "initial_absent_pct": initial_absent_pct,
            "toggle_rate": toggle_rate,
        },
        "emit_context_slices": True,
        "context_dimensions": [
            {"id": f"{name}-ctx", "mece": True, "values": ctx_values}
        ],
        "edges": {
            f"{name}-anchor-to-gate":
                {"from": "anchor", "to": "gate",
                 "p": 0.9, "onset": 1.0, "mu": 2.0, "sigma": 0.4},
            f"{name}-gate-to-path-a":
                {"from": "gate", "to": "path-a",
                 "p": 0.5, "onset": 1.0, "mu": 2.0, "sigma": 0.4},
            f"{name}-gate-to-path-b":
                {"from": "gate", "to": "path-b",
                 "p": 0.4, "onset": 1.0, "mu": 2.0, "sigma": 0.4},
            f"{name}-path-a-to-outcome":
                {"from": "path-a", "to": "outcome",
                 "p": 0.8, "onset": 1.0, "mu": 2.0, "sigma": 0.4},
            f"{name}-path-b-to-outcome":
                {"from": "path-b", "to": "outcome",
                 "p": 0.7, "onset": 1.0, "mu": 2.0, "sigma": 0.4},
        },
        "nodes": {
            "anchor": {"start": True, "type": "entry", "label": "Anchor",
                       "event_id": f"{name}-anchor"},
            "gate":   {"type": "event", "label": "Gate",
                       "event_id": f"{name}-gate"},
            "path-a": {"type": "event", "label": "Path A",
                       "event_id": f"{name}-path-a"},
            "path-b": {"type": "event", "label": "Path B",
                       "event_id": f"{name}-path-b"},
            "outcome": {"absorbing": True, "type": "event",
                        "outcome_type": "success", "label": "Outcome",
                        "event_id": f"{name}-outcome"},
        },
        "graph": {"name": name,
                  "description": "Stress harness for branch-group segfault"},
        "testing": {
            "thresholds": {"p_z": 4.0, "mu_z": 4.0, "sigma_z": 5.0, "onset_z": 5.0},
            "per_slice_thresholds": {"p_slice_z": 5.0},
        },
    }


# ── Matrices ───────────────────────────────────────────────────────────

def matrix_quick() -> list[dict]:
    """5 cells spanning zero-obs → full-obs on the frontier. Runs fast."""
    return [
        {"tag": "full",    "traffic": 500, "n_days": 50, "n_ctx_values": 2, "initial_absent_pct": 0.0, "toggle_rate": 0.0, "seed": 101},
        {"tag": "thin",    "traffic": 50,  "n_days": 30, "n_ctx_values": 2, "initial_absent_pct": 0.0, "toggle_rate": 0.0, "seed": 102},
        {"tag": "one_abs", "traffic": 500, "n_days": 50, "n_ctx_values": 3, "initial_absent_pct": 0.5, "toggle_rate": 0.0, "seed": 103},
        {"tag": "two_abs", "traffic": 500, "n_days": 50, "n_ctx_values": 3, "initial_absent_pct": 0.7, "toggle_rate": 0.02, "seed": 104},
        {"tag": "edge",    "traffic": 20,  "n_days": 20, "n_ctx_values": 3, "initial_absent_pct": 0.5, "toggle_rate": 0.02, "seed": 105},
    ]


def matrix_frontier() -> list[dict]:
    """Dense sweep across the degradation frontier."""
    cells = []
    seed = 200
    for ctx_n in (2, 3):
        for traffic in (500, 100, 20):
            for absent in (0.0, 0.2, 0.5, 0.8):
                for toggle in (0.0, 0.02):
                    cells.append({
                        "tag": f"c{ctx_n}_t{traffic}_a{int(absent*10)}_g{int(toggle*100)}",
                        "traffic": traffic, "n_days": 40, "n_ctx_values": ctx_n,
                        "initial_absent_pct": absent, "toggle_rate": toggle,
                        "seed": seed,
                    })
                    seed += 1
    return cells


MATRICES = {"quick": matrix_quick, "frontier": matrix_frontier}


# ── Cell runner ────────────────────────────────────────────────────────

def run_cell(cell: dict, *, chains: int, draws: int, tune: int) -> dict:
    """Bootstrap + fit one cell, return result dict."""
    name = f"stress-bg-{cell['tag']}-s{cell['seed']}"
    truth = build_truth(name, **{k: cell[k] for k in
        ("traffic", "n_days", "n_ctx_values",
         "initial_absent_pct", "toggle_rate", "seed")})

    truth_path = os.path.join(TRUTH_DIR, f"{name}.truth.yaml")
    with open(truth_path, "w") as f:
        f.write(f"# STRESS CELL: {cell['tag']} (auto-generated, safe to delete)\n")
        yaml.dump(truth, f, default_flow_style=False, sort_keys=False)

    result = {"cell": cell, "name": name, "truth_path": truth_path,
              "bootstrap_ok": False, "empty_slices": 0,
              "fit_exit_code": None, "fit_elapsed_s": None,
              "crashed": False, "fault_trace_bytes": 0,
              "fault_trace_excerpt": ""}

    # ── Bootstrap ──
    env = {**os.environ, "PYTHONPATH": REPO_ROOT}
    boot = subprocess.run(
        [sys.executable, os.path.join(REPO_ROOT, "bayes", "synth_gen.py"),
         "--graph", name, "--write-files", "--bust-cache"],
        capture_output=True, text=True, timeout=300, cwd=REPO_ROOT, env=env,
    )
    if boot.returncode != 0:
        result["bootstrap_error"] = boot.stderr[-500:] or boot.stdout[-500:]
        return result
    result["bootstrap_ok"] = True

    # Pull empty_slices from freshly-written meta
    from bayes.synth_gen import _resolve_data_repo
    data_repo = _resolve_data_repo()
    meta_path = os.path.join(data_repo, "graphs", f"{name}.synth-meta.json")
    if os.path.isfile(meta_path):
        with open(meta_path) as f:
            m = json.load(f)
        result["empty_slices"] = len(m.get("empty_slices", []))
        result["row_count"] = m.get("row_count", 0)

    # ── Fit ──
    fault_log = f"/tmp/stress-bg-fault-{name}.log"
    try:
        os.remove(fault_log)
    except OSError:
        pass

    env_fit = {**os.environ, "PYTHONPATH": REPO_ROOT,
               "BAYES_FAULT_LOG": fault_log}
    t0 = time.time()
    fit = subprocess.run(
        [sys.executable, os.path.join(REPO_ROOT, "bayes", "test_harness.py"),
         "--graph", name,
         "--chains", str(chains), "--draws", str(draws), "--tune", str(tune),
         "--cores", str(chains), "--no-webhook"],
        capture_output=True, text=True,
        timeout=900, cwd=REPO_ROOT, env=env_fit,
    )
    result["fit_elapsed_s"] = time.time() - t0
    result["fit_exit_code"] = fit.returncode
    result["crashed"] = fit.returncode != 0

    if os.path.isfile(fault_log):
        with open(fault_log) as f:
            trace = f.read()
        result["fault_trace_bytes"] = len(trace)
        result["fault_trace_excerpt"] = trace[-2000:]

    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--matrix", choices=list(MATRICES.keys()), default="quick")
    ap.add_argument("--chains", type=int, default=2)
    ap.add_argument("--draws", type=int, default=300)
    ap.add_argument("--tune", type=int, default=300)
    ap.add_argument("--output", default=None)
    args = ap.parse_args()

    cells = MATRICES[args.matrix]()
    print(f"Running {len(cells)} cells with chains={args.chains} "
          f"draws={args.draws} tune={args.tune}")
    results = []
    for i, cell in enumerate(cells, 1):
        print(f"\n[{i}/{len(cells)}] cell={cell['tag']} "
              f"ctx={cell['n_ctx_values']} traffic={cell['traffic']} "
              f"absent={cell['initial_absent_pct']} "
              f"toggle={cell['toggle_rate']}")
        r = run_cell(cell, chains=args.chains, draws=args.draws, tune=args.tune)
        results.append(r)
        print(f"  → boot={r['bootstrap_ok']} empty_slices={r['empty_slices']} "
              f"exit={r['fit_exit_code']} "
              f"elapsed={r['fit_elapsed_s']:.0f}s "
              f"fault_bytes={r['fault_trace_bytes']}")

    out_path = args.output or f"/tmp/stress-bg-{int(time.time())}.json"
    with open(out_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nResults written to {out_path}")

    n_crashed = sum(1 for r in results if r["crashed"])
    n_total = len(results)
    print(f"Summary: {n_crashed}/{n_total} cells crashed")


if __name__ == "__main__":
    main()
