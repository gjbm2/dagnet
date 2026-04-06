#!/usr/bin/env python3
"""
Convergence matrix — crosses prior scenarios x geometry settings x random seeds
to diagnose intermittent convergence failures.

All cells run IN PARALLEL via test_harness.py subprocesses.

Usage:
    cd dagnet
    . graph-editor/venv/bin/activate

    # Whole-graph diagnosis (auto-discovers latency edges, overrides all)
    python bayes/convergence_matrix.py --graph simple

    # Focus on a specific edge
    python bayes/convergence_matrix.py --graph simple --edge-prefix 7bb83fbf

    # Custom axes
    python bayes/convergence_matrix.py --graph simple \
        --priors prod,neutral,wide \
        --sharpness 5.0,8.0,12.0 \
        --seeds 42,123,456,789,1000 \
        --max-parallel 9

    # Full matrix with config file
    python bayes/convergence_matrix.py --graph simple \
        --matrix-config /tmp/matrix.yaml

matrix.yaml example:
    priors:
      prod: {}
      neutral: {mu: 0, sigma: 0.5, onset_delta_days: 0, alpha: 1, beta: 1}
      wide: {extra: {BAYES_MU_PRIOR_SIGMA_FLOOR: 1.0}}
    geometry:
      k5: {BAYES_SOFTPLUS_SHARPNESS: 5.0}
      k8: {BAYES_SOFTPLUS_SHARPNESS: 8.0}
      k12: {BAYES_SOFTPLUS_SHARPNESS: 12.0}
    seeds: [42, 123, 456, 789, 1000]
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
from datetime import datetime
from itertools import product as iterproduct

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_THREAD_PIN_ENV = {
    "OMP_NUM_THREADS": "1",
    "MKL_NUM_THREADS": "1",
    "OPENBLAS_NUM_THREADS": "1",
    "NUMBA_NUM_THREADS": "1",
}


# ---------------------------------------------------------------------------
# Graph introspection — find latency edges
# ---------------------------------------------------------------------------

def _find_latency_edges(graph: dict) -> list[dict]:
    """Return edges that have latency parameters (mu/onset)."""
    latency_edges = []
    for edge in graph.get("edges", []):
        lat = edge.get("p", {}).get("latency", {})
        if lat.get("mu") is not None or lat.get("onset_delta_days") is not None:
            latency_edges.append(edge)
    return latency_edges


# ---------------------------------------------------------------------------
# Prior scenario definitions
# ---------------------------------------------------------------------------

def _make_prior_scenarios(latency_edges: list[dict]) -> dict:
    """Built-in prior scenarios applied to ALL latency edges."""
    # Collect per-edge info for description
    edge_info = []
    for edge in latency_edges:
        lat = edge.get("p", {}).get("latency", {})
        pid = edge.get("p", {}).get("id", "?")
        edge_info.append({
            "uuid": edge["uuid"],
            "prefix": edge["uuid"][:8],
            "pid": pid,
            "mu": lat.get("mu", 0.0),
            "sigma": lat.get("sigma", 0.5),
            "onset": lat.get("onset_delta_days", 0.0),
        })

    desc_parts = ", ".join(f"{e['pid']}(mu={e['mu']:.2f})" for e in edge_info)

    # Build overrides for ALL latency edges simultaneously
    def _overrides_for_all(per_edge_fn):
        """Apply per_edge_fn to each latency edge and merge into one dict."""
        merged = {}
        for e in edge_info:
            ov = per_edge_fn(e)
            if ov:
                merged[e["prefix"]] = ov
        return merged

    return {
        "prod": {
            "description": f"As-is: {desc_parts}",
            "prior_overrides": {},
            "extra_settings": {},
        },
        "neutral": {
            "description": "Uninformative: mu=0, sig=0.5, onset=0, Beta(1,1) on all lat edges",
            "prior_overrides": _overrides_for_all(lambda e: {
                "mu": 0.0, "sigma": 0.5, "onset_delta_days": 0.0,
                "alpha": 1.0, "beta": 1.0,
            }),
            "extra_settings": {},
        },
        "wide": {
            "description": "Prod centre, wider mu floor (1.0)",
            "prior_overrides": {},
            "extra_settings": {"BAYES_MU_PRIOR_SIGMA_FLOOR": 1.0},
        },
        "shifted": {
            "description": "Onset halved, mu+0.5 on all lat edges",
            "prior_overrides": _overrides_for_all(lambda e: {
                "mu": e["mu"] + 0.5,
                "onset_delta_days": max(0, e["onset"] / 2),
            }),
            "extra_settings": {},
        },
        "no_onset": {
            "description": "Onset forced to 0 on all lat edges",
            "prior_overrides": _overrides_for_all(lambda e: {
                "onset_delta_days": 0.0,
            }),
            "extra_settings": {},
        },
    }


# ---------------------------------------------------------------------------
# Geometry presets
# ---------------------------------------------------------------------------

DEFAULT_GEOMETRY = {
    "k5":  {"BAYES_SOFTPLUS_SHARPNESS": 5.0},
    "k8":  {"BAYES_SOFTPLUS_SHARPNESS": 8.0},
    "k12": {"BAYES_SOFTPLUS_SHARPNESS": 12.0},
}

DEFAULT_SEEDS = [42, 123, 456]


# ---------------------------------------------------------------------------
# Subprocess runner (one cell of the matrix)
# ---------------------------------------------------------------------------

def _run_cell(
    cell_label: str,
    graph_name: str,
    prior_overrides: dict,
    extra_settings: dict,
    geometry_settings: dict,
    seed: int | None,
    draws: int, tune: int, chains: int, cores: int,
    timeout: int,
) -> dict:
    """Run test_harness.py for one cell."""
    settings_data = {}
    if prior_overrides:
        settings_data["prior_overrides"] = prior_overrides
    if extra_settings:
        settings_data.update(extra_settings)
    if geometry_settings:
        settings_data.update(geometry_settings)
    # random_seed is passed via settings (worker reads it from payload.settings)
    if seed is not None:
        settings_data["random_seed"] = seed

    # Always write settings file (at minimum contains random_seed)
    fd, settings_file = tempfile.mkstemp(
        suffix=".json", prefix=f"matrix-{cell_label[:20]}-"
    )
    with os.fdopen(fd, "w") as f:
        json.dump(settings_data, f)

    # Sanitise label for use as filename (replace | with -)
    safe_label = cell_label.replace("|", "-")

    cmd = [
        sys.executable,
        os.path.join(REPO_ROOT, "bayes", "test_harness.py"),
        "--graph", graph_name,
        "--no-webhook",
        "--draws", str(draws),
        "--tune", str(tune),
        "--chains", str(chains),
        "--cores", str(cores),
        "--settings-json", settings_file,
        "--job-label", f"matrix-{safe_label}",
    ]

    env = {**os.environ, **_THREAD_PIN_ENV}

    t0 = time.time()
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=timeout + 120,
            env=env, cwd=REPO_ROOT,
        )
        return {
            "cell": cell_label,
            "exit_code": result.returncode,
            "elapsed_s": time.time() - t0,
            "output": result.stdout + result.stderr,
            "error": None if result.returncode == 0 else f"exit {result.returncode}",
        }
    except subprocess.TimeoutExpired:
        return {
            "cell": cell_label, "exit_code": -1,
            "elapsed_s": time.time() - t0, "output": "",
            "error": f"Timeout after {timeout}s",
        }
    except Exception as e:
        return {
            "cell": cell_label, "exit_code": -1,
            "elapsed_s": time.time() - t0, "output": "",
            "error": str(e),
        }
    finally:
        if settings_file and os.path.isfile(settings_file):
            os.unlink(settings_file)


# ---------------------------------------------------------------------------
# Output parsing
# ---------------------------------------------------------------------------

def _parse_edge_latency(output: str, prefix: str) -> dict:
    """Parse latency + onset for one edge prefix from harness output."""
    result = {}
    pat = re.compile(
        rf"latency {re.escape(prefix)}.*?"
        r"mu=([\d.]+)±([\d.]+).*?"
        r"sigma=([\d.]+)±([\d.]+).*?"
        r"rhat=([\d.]+),\s*ess=(\d+)"
    )
    m = pat.search(output)
    if m:
        result["mu"] = float(m.group(1))
        result["mu_sd"] = float(m.group(2))
        result["sigma"] = float(m.group(3))
        result["sigma_sd"] = float(m.group(4))
        result["rhat"] = float(m.group(5))
        result["ess"] = int(m.group(6))

    pat_onset = re.compile(
        rf"onset {re.escape(prefix)}.*?"
        r"([\d.]+)±([\d.]+)\s+\(prior=([\d.]+)\)"
    )
    m_onset = pat_onset.search(output)
    if m_onset:
        result["onset"] = float(m_onset.group(1))
        result["onset_sd"] = float(m_onset.group(2))
        result["onset_prior"] = float(m_onset.group(3))

    return result


def _parse_output(output: str, edge_prefixes: list[str]) -> dict:
    """Parse harness output: global quality + per-edge latency details."""
    result: dict = {"quality": {}, "edges": {}}

    # Global quality (this is the max rhat / min ESS across ALL variables)
    m = re.search(r"rhat=([\d.]+),\s*ess=([\d.]+),\s*converged=([\d.]+)%", output)
    if m:
        result["quality"] = {
            "rhat": float(m.group(1)),
            "ess": float(m.group(2)),
            "converged_pct": float(m.group(3)),
        }

    m_div = re.search(r"divergences=(\d+)", output)
    if m_div:
        result["quality"]["divergences"] = int(m_div.group(1))

    # Per-edge latency details
    for prefix in edge_prefixes:
        edge_data = _parse_edge_latency(output, prefix)
        if edge_data:
            result["edges"][prefix] = edge_data

    return result


# ---------------------------------------------------------------------------
# Matrix construction
# ---------------------------------------------------------------------------

def _build_matrix(prior_scenarios, geometry_grid, seeds):
    """Build the full cross-product of (prior, geometry, seed)."""
    cells = []
    for (prior_name, prior_cfg), (geom_name, geom_settings), seed in iterproduct(
        prior_scenarios.items(), geometry_grid.items(), seeds
    ):
        label = f"{prior_name}|{geom_name}|s{seed}"
        cells.append({
            "label": label,
            "prior_name": prior_name,
            "geom_name": geom_name,
            "seed": seed,
            "prior_overrides": prior_cfg.get("prior_overrides", {}),
            "extra_settings": {**prior_cfg.get("extra_settings", {}), **geom_settings},
            "geometry_settings": {},  # already merged into extra_settings
        })
    return cells


# ---------------------------------------------------------------------------
# Summary tables
# ---------------------------------------------------------------------------

def _get_global_rhat(result: dict) -> float | None:
    """Extract global max rhat (worst across all variables) from parsed result."""
    return result.get("parsed", {}).get("quality", {}).get("rhat")


def _print_detail_table(results, prior_names, geom_names, seeds, edge_prefixes, edge_pids):
    """Full detail: one row per cell, showing global quality + per-edge latency."""
    def _f(v, fmt=".3f"):
        return f"{float(v):{fmt}}" if v is not None else "---"

    # Build header with per-edge columns
    edge_hdrs = ""
    for prefix in edge_prefixes:
        short_pid = edge_pids.get(prefix, prefix)[:12]
        edge_hdrs += f" | {short_pid:>12s} mu  sig onset rhat"

    hdr = (f"{'Prior':>12s} {'Geom':>4s} {'Seed':>5s} | "
           f"{'G_rhat':>6s} {'G_ESS':>5s} {'Div':>4s} {'Conv%':>5s}"
           f"{edge_hdrs}"
           f" | {'Time':>4s} {'St':>4s}")
    sep = "-" * len(hdr)
    print(f"\n{sep}")
    print("DETAIL TABLE (G_ = global worst-case across all variables)")
    print(sep)
    print(hdr)
    print(sep)

    for prior_name in prior_names:
        for geom_name in geom_names:
            for seed in seeds:
                label = f"{prior_name}|{geom_name}|s{seed}"
                r = results.get(label, {})
                p = r.get("parsed", {})
                q = p.get("quality", {})
                edges = p.get("edges", {})

                status = "OK" if r.get("exit_code") == 0 else "FAIL"
                if r.get("error") and "Timeout" in str(r["error"]):
                    status = "T/O"

                edge_cols = ""
                for prefix in edge_prefixes:
                    ed = edges.get(prefix, {})
                    edge_cols += (
                        f" | {' ':>12s} "
                        f"{_f(ed.get('mu'), '.2f'):>4s} "
                        f"{_f(ed.get('sigma'), '.2f'):>4s} "
                        f"{_f(ed.get('onset'), '.1f'):>5s} "
                        f"{_f(ed.get('rhat')):>5s}"
                    )

                print(
                    f"{prior_name:>12s} {geom_name:>4s} {seed:>5d} | "
                    f"{_f(q.get('rhat')):>6s} {_f(q.get('ess'), '.0f'):>5s} "
                    f"{_f(q.get('divergences'), '.0f'):>4s} {_f(q.get('converged_pct'), '.0f'):>5s}"
                    f"{edge_cols}"
                    f" | {_f(r.get('elapsed_s'), '.0f'):>4s} {status:>4s}"
                )
        # Blank line between prior groups
        if prior_name != prior_names[-1]:
            print()
    print(sep)


def _print_convergence_rate_matrix(results, prior_names, geom_names, seeds):
    """Summary: convergence rate (across seeds) for each prior x geometry cell.
    Uses GLOBAL rhat (worst across all variables) — the real convergence metric."""
    rhat_threshold = 1.05

    print(f"\n{'=' * 70}")
    print("CONVERGENCE RATE MATRIX (% of seeds with global max rhat < 1.05)")
    print(f"{'=' * 70}")

    header = f"{'Prior':>12s}"
    for gn in geom_names:
        header += f" | {gn:>12s}"
    print(header)
    print("-" * len(header))

    for prior_name in prior_names:
        row = f"{prior_name:>12s}"
        for geom_name in geom_names:
            n_ok = 0
            n_total = 0
            for seed in seeds:
                label = f"{prior_name}|{geom_name}|s{seed}"
                r = results.get(label, {})
                n_total += 1
                rhat = _get_global_rhat(r)
                if rhat is not None and rhat < rhat_threshold:
                    n_ok += 1
            pct = (n_ok / n_total * 100) if n_total > 0 else 0
            cell = f"{n_ok}/{n_total} ({pct:.0f}%)"
            row += f" | {cell:>12s}"
        print(row)

    print(f"\n{'─' * 70}")


def _print_median_rhat_matrix(results, prior_names, geom_names, seeds):
    """Summary: median global rhat across seeds for each prior x geometry cell."""
    import statistics

    print(f"\n{'=' * 70}")
    print("MEDIAN GLOBAL RHAT MATRIX (across seeds)")
    print(f"{'=' * 70}")

    header = f"{'Prior':>12s}"
    for gn in geom_names:
        header += f" | {gn:>10s}"
    print(header)
    print("-" * len(header))

    for prior_name in prior_names:
        row = f"{prior_name:>12s}"
        for geom_name in geom_names:
            rhats = []
            for seed in seeds:
                label = f"{prior_name}|{geom_name}|s{seed}"
                r = results.get(label, {})
                rhat = _get_global_rhat(r)
                if rhat is not None:
                    rhats.append(rhat)
            if rhats:
                med = statistics.median(rhats)
                cell = f"{med:.4f}"
            else:
                cell = "---"
            row += f" | {cell:>10s}"
        print(row)

    print()


def _print_per_edge_worst_rhat(results, prior_names, geom_names, seeds, edge_prefixes, edge_pids):
    """Show which edge has the worst rhat most often — identifies the problem edge."""
    print(f"\n{'=' * 70}")
    print("WORST EDGE FREQUENCY (which edge has highest rhat per run)")
    print(f"{'=' * 70}")

    edge_worst_count = {p: 0 for p in edge_prefixes}
    total_runs = 0
    for label, r in results.items():
        edges = r.get("parsed", {}).get("edges", {})
        if not edges:
            continue
        total_runs += 1
        worst_prefix = max(edges.keys(), key=lambda p: edges[p].get("rhat", 0))
        edge_worst_count[worst_prefix] += 1

    for prefix in edge_prefixes:
        pid = edge_pids.get(prefix, prefix)
        count = edge_worst_count.get(prefix, 0)
        pct = (count / total_runs * 100) if total_runs > 0 else 0
        print(f"  {prefix}  {pid:40s}  worst in {count}/{total_runs} runs ({pct:.0f}%)")

    print()


def _print_diagnosis(results, prior_names, geom_names, seeds):
    """Auto-diagnosis based on convergence patterns."""
    rhat_threshold = 1.05

    # Compute convergence rates per prior (marginalised over geometry)
    prior_rates = {}
    for pn in prior_names:
        ok, total = 0, 0
        for gn in geom_names:
            for s in seeds:
                label = f"{pn}|{gn}|s{s}"
                r = results.get(label, {})
                rhat = _get_global_rhat(r)
                total += 1
                if rhat is not None and rhat < rhat_threshold:
                    ok += 1
        prior_rates[pn] = ok / total if total > 0 else 0

    # Convergence rates per geometry (marginalised over prior)
    geom_rates = {}
    for gn in geom_names:
        ok, total = 0, 0
        for pn in prior_names:
            for s in seeds:
                label = f"{pn}|{gn}|s{s}"
                r = results.get(label, {})
                rhat = _get_global_rhat(r)
                total += 1
                if rhat is not None and rhat < rhat_threshold:
                    ok += 1
        geom_rates[gn] = ok / total if total > 0 else 0

    overall_rate = sum(prior_rates.values()) / len(prior_rates) if prior_rates else 0

    print(f"\n{'=' * 70}")
    print("DIAGNOSIS")
    print(f"{'=' * 70}")

    print(f"\nOverall convergence rate: {overall_rate * 100:.0f}%")
    print(f"\nPer-prior rates (marginalised over geometry):")
    for pn in prior_names:
        print(f"  {pn:>12s}: {prior_rates[pn] * 100:.0f}%")
    print(f"\nPer-geometry rates (marginalised over prior):")
    for gn in geom_names:
        print(f"  {gn:>6s}: {geom_rates[gn] * 100:.0f}%")

    # Pattern detection
    prior_spread = max(prior_rates.values()) - min(prior_rates.values())
    geom_spread = max(geom_rates.values()) - min(geom_rates.values())

    print(f"\nPrior sensitivity:   spread = {prior_spread * 100:.0f}pp")
    print(f"Geometry sensitivity: spread = {geom_spread * 100:.0f}pp")

    print(f"\nInterpretation:")
    if overall_rate > 0.9:
        print("  -> High overall convergence. Intermittent failures are likely seed-sensitive.")
        print("     Consider: more draws/tune, or target_accept -> 0.95")
    elif prior_spread > 0.3 and geom_spread < 0.15:
        print("  -> PRIOR-DRIVEN: convergence depends strongly on prior choice.")
        print("     The data is weakly informative for some edges; priors pull the sampler into bad regions.")
        print("     Next: examine which edge's prior is pathological (check neutral vs prod).")
    elif geom_spread > 0.3 and prior_spread < 0.15:
        print("  -> GEOMETRY-DRIVEN: convergence depends on softplus sharpness.")
        print("     There's an onset-mu ridge that higher k suppresses.")
        print("     Next: try k=15-20, or reparameterise onset.")
    elif prior_spread > 0.2 and geom_spread > 0.2:
        print("  -> INTERACTION: both prior and geometry matter.")
        print("     Specific priors place mass near a geometric pathology.")
        print("     Next: identify the failing cells and examine the (prior, geometry) combination.")
    else:
        print("  -> UNCLEAR PATTERN or MODEL MISSPECIFICATION.")
        print("     Consider: inspect per-edge diagnostics (diag_run.py), check topology.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Convergence matrix: prior x geometry x seed",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Whole-graph diagnosis (auto-discovers latency edges)
  python bayes/convergence_matrix.py --graph simple

  # Focus on one edge
  python bayes/convergence_matrix.py --graph simple --edge-prefix 7bb83fbf

  # Custom axes
  python bayes/convergence_matrix.py --graph simple \\
      --priors prod,neutral,wide --sharpness 5.0,8.0,12.0 \\
      --seeds 42,123,456,789,1000

  # Custom YAML matrix config
  python bayes/convergence_matrix.py --graph simple \\
      --matrix-config /tmp/matrix.yaml
"""
    )
    parser.add_argument("--graph", default="simple",
                        help="Graph shortcut or name (default: simple)")
    parser.add_argument("--edge-prefix", default=None,
                        help="UUID prefix of a specific edge to focus on "
                             "(default: auto-discover all latency edges)")
    parser.add_argument("--priors", default=None,
                        help="Comma-separated prior scenario names (default: all 5)")
    parser.add_argument("--sharpness", default="5.0,8.0,12.0",
                        help="Comma-separated softplus k values (default: 5.0,8.0,12.0)")
    parser.add_argument("--seeds", default="42,123,456",
                        help="Comma-separated random seeds (default: 42,123,456)")
    parser.add_argument("--matrix-config", default=None,
                        help="YAML file defining custom prior/geometry/seed axes")
    parser.add_argument("--draws", type=int, default=500)
    parser.add_argument("--tune", type=int, default=300)
    parser.add_argument("--chains", type=int, default=4)
    parser.add_argument("--cores", type=int, default=2,
                        help="Cores per subprocess (default: 2; keep low for parallelism)")
    parser.add_argument("--max-parallel", type=int, default=9,
                        help="Max concurrent subprocesses (default: 9)")
    parser.add_argument("--timeout", type=int, default=600,
                        help="Per-cell timeout in seconds (default: 600)")
    parser.add_argument("--output-json", default=None,
                        help="Write full results to JSON file")
    args = parser.parse_args()

    GRAPH_SHORTCUTS = {
        "simple": "bayes-test-gm-rebuild",
        "branch": "conversion-flow-v2-recs-collapsed",
    }
    graph_name = GRAPH_SHORTCUTS.get(args.graph, args.graph)

    # Load graph
    sys.path.insert(0, os.path.join(REPO_ROOT, "bayes"))
    from test_harness import _read_private_repos_conf
    conf = _read_private_repos_conf()
    data_repo_path = os.path.join(REPO_ROOT, conf.get("DATA_REPO_DIR", ""))
    graph_path = os.path.join(data_repo_path, "graphs", f"{graph_name}.json")
    with open(graph_path) as f:
        graph = json.load(f)

    # Discover latency edges
    if args.edge_prefix:
        # Single-edge focus mode
        target_edge = None
        for edge in graph.get("edges", []):
            if edge.get("uuid", "").startswith(args.edge_prefix):
                target_edge = edge
                break
        if not target_edge:
            print(f"ERROR: No edge starting with '{args.edge_prefix}' in {graph_name}")
            sys.exit(1)
        latency_edges = [target_edge]
    else:
        # Auto-discover all latency edges
        latency_edges = _find_latency_edges(graph)
        if not latency_edges:
            print(f"ERROR: No latency edges found in {graph_name}")
            sys.exit(1)

    # Build edge prefix list and pid map
    edge_prefixes = [e["uuid"][:8] for e in latency_edges]
    edge_pids = {e["uuid"][:8]: e.get("p", {}).get("id", "?") for e in latency_edges}

    print(f"Graph: {graph_name}")
    print(f"Latency edges ({len(latency_edges)}):")
    for edge in latency_edges:
        lat = edge.get("p", {}).get("latency", {})
        pid = edge.get("p", {}).get("id", "?")
        print(f"  {edge['uuid'][:12]}  {pid}")
        print(f"    mu={lat.get('mu', '-')}, sigma={lat.get('sigma', '-')}, "
              f"onset={lat.get('onset_delta_days', '-')}")

    # Build axes
    if args.matrix_config:
        import yaml as _yaml
        with open(args.matrix_config) as f:
            matrix_cfg = _yaml.safe_load(f)
        # Custom priors from YAML — apply to all latency edges
        prior_scenarios = {}
        for name, overrides in matrix_cfg.get("priors", {}).items():
            extra = overrides.pop("extra", {}) if isinstance(overrides, dict) else {}
            # Apply the same override to all latency edges
            merged_overrides = {}
            for prefix in edge_prefixes:
                if overrides:
                    merged_overrides[prefix] = dict(overrides)
            prior_scenarios[name] = {
                "description": name,
                "prior_overrides": merged_overrides,
                "extra_settings": extra,
            }
        geometry_grid = matrix_cfg.get("geometry", DEFAULT_GEOMETRY)
        seeds = matrix_cfg.get("seeds", DEFAULT_SEEDS)
    else:
        prior_scenarios = _make_prior_scenarios(latency_edges)
        if args.priors:
            selected = [p.strip() for p in args.priors.split(",")]
            prior_scenarios = {k: v for k, v in prior_scenarios.items() if k in selected}

        k_values = [float(k.strip()) for k in args.sharpness.split(",")]
        geometry_grid = {f"k{k:.0f}" if k == int(k) else f"k{k}": {"BAYES_SOFTPLUS_SHARPNESS": k}
                         for k in k_values}
        seeds = [int(s.strip()) for s in args.seeds.split(",")]

    prior_names = list(prior_scenarios.keys())
    geom_names = list(geometry_grid.keys())

    # Build matrix
    cells = _build_matrix(prior_scenarios, geometry_grid, seeds)
    n_cells = len(cells)

    print(f"\n{'=' * 70}")
    print(f"CONVERGENCE MATRIX: {len(prior_names)} priors x {len(geom_names)} geometries x {len(seeds)} seeds = {n_cells} runs")
    print(f"Sampling: {args.draws} draws, {args.tune} tune, {args.chains} chains, {args.cores} cores/run")
    print(f"Parallelism: {args.max_parallel} concurrent ({args.cores} cores each = {args.max_parallel * args.cores} cores total)")
    print(f"{'=' * 70}")
    print(f"\nPriors:    {', '.join(prior_names)}")
    print(f"Geometry:  {', '.join(geom_names)}")
    print(f"Seeds:     {', '.join(str(s) for s in seeds)}")

    for name, cfg in prior_scenarios.items():
        print(f"  {name:>12s}: {cfg.get('description', '')}")

    print(f"\nLaunching {n_cells} runs... (monitor: scripts/bayes-monitor.sh)")
    t_total = time.time()

    # Execute
    results = {}
    completed = 0
    with ProcessPoolExecutor(max_workers=args.max_parallel) as pool:
        futures = {}
        for cell in cells:
            future = pool.submit(
                _run_cell,
                cell["label"],
                graph_name,
                cell["prior_overrides"],
                cell["extra_settings"],
                cell["geometry_settings"],
                cell["seed"],
                args.draws, args.tune, args.chains, args.cores,
                args.timeout,
            )
            futures[future] = cell["label"]

        for future in as_completed(futures):
            label = futures[future]
            r = future.result()
            p = _parse_output(r.get("output", ""), edge_prefixes)
            r["parsed"] = p
            results[label] = r
            completed += 1

            q = p.get("quality", {})
            status = "OK" if r.get("exit_code") == 0 else "FAIL"
            rhat_s = f"rhat={q['rhat']:.3f}" if "rhat" in q else ""
            div_s = f"div={q['divergences']}" if q.get("divergences") else ""
            print(f"  [{completed:>3d}/{n_cells}] {status:4s} {label:40s} ({r['elapsed_s']:.0f}s)  {rhat_s} {div_s}")

    wall_time = time.time() - t_total
    print(f"\nAll {n_cells} runs complete in {wall_time:.0f}s (wall clock)")

    # Output tables
    _print_detail_table(results, prior_names, geom_names, seeds, edge_prefixes, edge_pids)
    _print_convergence_rate_matrix(results, prior_names, geom_names, seeds)
    _print_median_rhat_matrix(results, prior_names, geom_names, seeds)
    if len(edge_prefixes) > 1:
        _print_per_edge_worst_rhat(results, prior_names, geom_names, seeds, edge_prefixes, edge_pids)
    _print_diagnosis(results, prior_names, geom_names, seeds)

    # Optional JSON dump
    if args.output_json:
        # Strip raw output (huge) — keep parsed + metadata
        export = {}
        for label, r in results.items():
            export[label] = {
                "cell": r.get("cell"),
                "exit_code": r.get("exit_code"),
                "elapsed_s": r.get("elapsed_s"),
                "error": r.get("error"),
                "parsed": r.get("parsed"),
            }
        meta = {
            "graph": graph_name,
            "edge_prefixes": edge_prefixes,
            "edge_pids": edge_pids,
            "priors": prior_names,
            "geometry": geom_names,
            "seeds": seeds,
            "draws": args.draws,
            "tune": args.tune,
            "chains": args.chains,
            "timestamp": datetime.utcnow().isoformat(),
            "wall_time_s": wall_time,
        }
        with open(args.output_json, "w") as f:
            json.dump({"meta": meta, "results": export}, f, indent=2)
        print(f"\nResults written to {args.output_json}")


if __name__ == "__main__":
    main()
