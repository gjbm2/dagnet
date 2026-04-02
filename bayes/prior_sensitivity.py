#!/usr/bin/env python3
"""
Prior sensitivity probe — runs the same prod graph with varied priors
to distinguish "bad priors" from "bad geometry (over-sensitive to priors)".

Usage:
    cd dagnet
    . graph-editor/venv/bin/activate
    python bayes/prior_sensitivity.py --graph simple --edge-prefix 7bb83fbf

Builds a baseline payload via the normal harness path (stats pass, hash
computation, preflight), then runs fit_graph N times with different prior
configurations on the target edge.  Compares rhat, ESS, onset, mu, sigma
across runs.

Prior configurations tested:
  1. prod       — current analytics priors (stats pass output, as-is)
  2. neutral    — Beta(1,1) rate, mu=0, sigma=0.5, onset=0
  3. wide       — prod centre but 2× wider (halve alpha+beta, double onset_uncertainty)
  4. shifted    — prod rate but onset halved, mu shifted +0.5
  5. no_onset   — prod rate/mu/sigma but onset forced to 0
"""

import sys
import os
import json
import copy
import time
import argparse
import math
from datetime import datetime, date, timedelta

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "graph-editor", "lib"))
sys.path.insert(0, os.path.join(REPO_ROOT, "graph-editor"))
sys.path.insert(0, os.path.join(REPO_ROOT, "bayes"))

# Reuse harness utilities
from test_harness import (
    _read_private_repos_conf,
    _load_env,
    _compute_fe_hashes,
    _acquire_lock,
    _load_truth_file,
    DateEncoder,
)


# ---------------------------------------------------------------------------
# Cohort extraction (inlined from test_harness — nested fn, not importable)
# ---------------------------------------------------------------------------

def _parse_date_to_age(d_str: str) -> float:
    """Parse a date string and return age in days from now."""
    for fmt in ("%d-%b-%y", "%Y-%m-%d", "%d-%b-%Y"):
        try:
            dt = datetime.strptime(str(d_str), fmt)
            return float(max(0, (datetime.now() - dt).days))
        except (ValueError, TypeError):
            continue
    return 30.0


def _extract_cohorts_from_values(values: list) -> tuple:
    """Extract CohortData from values[], returning (cohort_slice_cohorts, window_slice_cohorts)."""
    from runner.stats_engine import CohortData
    cohort_cohorts = []
    window_cohorts = []
    for v in values:
        dsl = v.get("sliceDSL", "") or ""
        is_window = "window(" in dsl
        is_cohort = "cohort(" in dsl
        target = window_cohorts if is_window and not is_cohort else cohort_cohorts

        dates = v.get("dates", [])
        n_daily = v.get("n_daily", [])
        k_daily = v.get("k_daily", [])
        median_lag = v.get("median_lag_daily") or v.get("median_lag_days", [])
        mean_lag = v.get("mean_lag_daily") or v.get("mean_lag_days", [])
        anchor_median = v.get("anchor_median_lag_daily") or v.get("anchor_median_lag_days", [])
        anchor_mean = v.get("anchor_mean_lag_daily") or v.get("anchor_mean_lag_days", [])
        if not dates or not n_daily:
            continue
        for i, d in enumerate(dates):
            n = int(n_daily[i]) if i < len(n_daily) else 0
            k = int(k_daily[i]) if i < len(k_daily) else 0
            if n <= 0:
                continue
            age_days = _parse_date_to_age(d)
            ml = float(median_lag[i]) if isinstance(median_lag, list) and i < len(median_lag) and median_lag[i] else None
            mnl = float(mean_lag[i]) if isinstance(mean_lag, list) and i < len(mean_lag) and mean_lag[i] else None
            aml = float(anchor_median[i]) if isinstance(anchor_median, list) and i < len(anchor_median) and anchor_median[i] else None
            amnl = float(anchor_mean[i]) if isinstance(anchor_mean, list) and i < len(anchor_mean) and anchor_mean[i] else None
            target.append(CohortData(
                date=str(d), age=age_days, n=n, k=k,
                median_lag_days=ml, mean_lag_days=mnl,
                anchor_median_lag_days=aml, anchor_mean_lag_days=amnl,
            ))
    return cohort_cohorts, window_cohorts


# ---------------------------------------------------------------------------
# Prior configurations
# ---------------------------------------------------------------------------

def _make_prior_configs(prod_edge: dict) -> dict:
    """Generate prior configs from the prod edge's current latency block.

    Each config is a dict of fields to patch onto the graph edge's p.latency
    block before the run.  Fields not listed are left as-is from the stats pass.
    """
    lat = prod_edge.get("p", {}).get("latency", {})
    prod_mu = lat.get("mu", 0.0)
    prod_sigma = lat.get("sigma", 0.5)
    prod_onset = lat.get("onset_delta_days", 0.0)

    p_block = prod_edge.get("p", {})
    prod_mean = p_block.get("mean", 0.5)
    prod_stdev = p_block.get("stdev", 0.1)

    configs = {}

    # 1. prod — no changes
    configs["prod"] = {
        "description": f"Analytics priors as-is (mu={prod_mu:.3f}, sigma={prod_sigma:.3f}, onset={prod_onset:.1f})",
        "latency_patch": {},
        "rate_patch": {},
    }

    # 2. neutral — uninformative everything
    configs["neutral"] = {
        "description": "Uninformative: Beta(1,1), mu=0, sigma=0.5, onset=0",
        "latency_patch": {
            "mu": 0.0,
            "sigma": 0.5,
            "onset_delta_days": 0.0,
        },
        "rate_patch": {
            "_force_uninformative": True,
        },
    }

    # 3. wide — same centre, much wider
    configs["wide"] = {
        "description": f"Prod centre, 2× wider uncertainty",
        "latency_patch": {},  # mu/sigma stay the same; the model's own prior width
                              # is controlled by onset_uncertainty and mu_prior_sigma
                              # which we'll widen via settings
        "rate_patch": {
            "_halve_ess": True,
        },
        "settings_patch": {
            "BAYES_MU_PRIOR_SIGMA_FLOOR": 1.0,  # wider mu prior
        },
    }

    # 4. shifted — onset halved, mu shifted
    configs["shifted"] = {
        "description": f"Onset halved ({prod_onset:.1f}→{prod_onset/2:.1f}), mu+0.5 ({prod_mu:.3f}→{prod_mu+0.5:.3f})",
        "latency_patch": {
            "mu": prod_mu + 0.5,
            "onset_delta_days": max(0, prod_onset / 2),
        },
        "rate_patch": {},
    }

    # 5. no_onset — force onset=0
    configs["no_onset"] = {
        "description": f"Onset forced to 0 (was {prod_onset:.1f})",
        "latency_patch": {
            "onset_delta_days": 0.0,
        },
        "rate_patch": {},
    }

    # 6. posterior_seeded — use the (non-converged) posterior values as priors
    #    to see if the posterior mode is at least locally stable
    configs["posterior_seeded"] = {
        "description": "Seeded at Phase 1 posterior values (onset=0.5, mu=2.2, sigma=0.5)",
        "latency_patch": {
            "mu": 2.246,
            "sigma": 0.515,
            "onset_delta_days": 0.45,
        },
        "rate_patch": {},
    }

    return configs


def _apply_config(graph: dict, target_uuid: str, config: dict) -> dict:
    """Apply a prior config to a deep copy of the graph, returning the modified copy."""
    g = copy.deepcopy(graph)
    for edge in g.get("edges", []):
        if edge.get("uuid", "").startswith(target_uuid):
            lat = edge.setdefault("p", {}).setdefault("latency", {})
            for k, v in config.get("latency_patch", {}).items():
                lat[k] = v

            if config.get("rate_patch", {}).get("_force_uninformative"):
                # Clear posterior and values so _resolve_prior falls to Beta(1,1)
                pf_key = f"parameter-{edge['p'].get('id', '')}"
                # We handle this in the param_files copy instead
                pass

            break
    return g


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Prior sensitivity probe")
    parser.add_argument("--graph", default="simple",
                        help="Graph name (same shortcuts as test_harness.py)")
    parser.add_argument("--edge-prefix", required=True,
                        help="UUID prefix of the target edge (e.g. 7bb83fbf)")
    parser.add_argument("--configs", default=None,
                        help="Comma-separated config names to run (default: all)")
    parser.add_argument("--draws", type=int, default=1000,
                        help="MCMC draws per chain (default: 1000 — reduced for speed)")
    parser.add_argument("--tune", type=int, default=500,
                        help="MCMC warmup steps (default: 500)")
    parser.add_argument("--chains", type=int, default=4,
                        help="Number of chains (default: 4)")
    parser.add_argument("--cores", type=int, default=4,
                        help="Cores for sampling (default: 4)")
    parser.add_argument("--timeout", type=int, default=300,
                        help="Per-run timeout in seconds (default: 300)")
    args = parser.parse_args()

    # --- Resolve paths ---
    GRAPH_SHORTCUTS = {"simple": "bayes-test-gm-rebuild", "branch": "conversion-flow-v2-recs-collapsed"}
    graph_name = GRAPH_SHORTCUTS.get(args.graph, args.graph)
    _acquire_lock(f"sensitivity-{graph_name}")

    import re
    import yaml

    conf = _read_private_repos_conf()
    data_repo_dir = conf.get("DATA_REPO_DIR", "")
    if not data_repo_dir:
        print("ERROR: DATA_REPO_DIR not set in .private-repos.conf")
        sys.exit(1)
    data_repo_path = os.path.join(REPO_ROOT, data_repo_dir)

    env = _load_env(os.path.join(REPO_ROOT, "graph-editor", ".env.local"))
    db_connection = env.get("DB_CONNECTION", "")
    if not db_connection:
        print("ERROR: No DB_CONNECTION in graph-editor/.env.local")
        sys.exit(1)
    os.environ["DB_CONNECTION"] = db_connection

    # --- Load graph ---
    graph_file = f"{graph_name}.json"
    graph_path = os.path.join(data_repo_path, "graphs", graph_file)
    if not os.path.isfile(graph_path):
        print(f"ERROR: Graph not found: {graph_path}")
        sys.exit(1)
    with open(graph_path) as f:
        graph = json.load(f)
    print(f"Graph [{graph_name}]: {len(graph.get('edges', []))} edges")

    # --- Find target edge ---
    target_edge = None
    target_uuid = None
    for edge in graph.get("edges", []):
        if edge.get("uuid", "").startswith(args.edge_prefix):
            target_edge = edge
            target_uuid = edge["uuid"]
            break
    if not target_edge:
        print(f"ERROR: No edge with UUID starting '{args.edge_prefix}'")
        print("Available edges:")
        for e in graph.get("edges", []):
            print(f"  {e.get('uuid', '?')[:12]}  {e.get('p', {}).get('id', '?')}")
        sys.exit(1)
    target_pid = target_edge.get("p", {}).get("id", "?")
    print(f"Target edge: {target_uuid[:12]}… ({target_pid})")

    # --- Compute hashes ---
    print("\n── Compute hashes (Node.js) ──")
    fe_data = _compute_fe_hashes(graph_path)
    _edges = [(e["param_id"], e["edge_uuid"], e["window_hash"], e["cohort_hash"])
              for e in fe_data["edges"]]

    # --- Anchor dates ---
    _dsl = graph.get("pinnedDSL", "") or graph.get("dataInterestsDSL", "")
    _date_match = re.search(r"(\d{1,2}-\w{3}-\d{2}):(\d{1,2}-\w{3}-\d{2})", _dsl)
    if _date_match:
        _from_dt = datetime.strptime(_date_match.group(1), "%d-%b-%y")
        _to_dt = datetime.strptime(_date_match.group(2), "%d-%b-%y")
        anchor_from = _from_dt.strftime("%Y-%m-%d")
        anchor_to = _to_dt.strftime("%Y-%m-%d")
    else:
        anchor_to = date.today().isoformat()
        anchor_from = (date.today() - timedelta(days=120)).isoformat()

    # --- Load param files ---
    param_files = {}
    params_dir = os.path.join(data_repo_path, "parameters")
    for fname in os.listdir(params_dir):
        if fname.endswith(".yaml") and "index" not in fname:
            with open(os.path.join(params_dir, fname)) as f:
                param_id = fname.replace(".yaml", "")
                param_files[f"parameter-{param_id}"] = yaml.safe_load(f)

    # --- Run BE stats pass ---
    print("\n── Stats pass (BE analytics engine) ──")
    from runner.stats_engine import CohortData, enhance_graph_latencies, EdgeContext

    cohort_lookup: dict = {}
    edge_contexts: dict = {}

    for edge in graph.get("edges", []):
        pid = edge.get("p", {}).get("id")
        if not pid:
            continue
        pf = param_files.get(f"parameter-{pid}") or param_files.get(pid)
        if not pf:
            continue
        cohort_cohorts, window_cohorts = _extract_cohorts_from_values(pf.get("values", []))
        all_cohorts = cohort_cohorts + window_cohorts
        eid = edge.get("uuid", "")
        if all_cohorts:
            cohort_lookup[eid] = all_cohorts
        ctx = EdgeContext()
        lat_v = edge.get("p", {}).get("latency") or {}
        window_vals = [v for v in pf.get("values", []) if "window(" in (v.get("sliceDSL", "") or "")]
        onset_vals = [v.get("latency", {}).get("onset_delta_days") for v in window_vals
                      if isinstance(v.get("latency", {}).get("onset_delta_days"), (int, float))]
        if onset_vals:
            ctx.onset_from_window_slices = sorted(onset_vals)[len(onset_vals) // 2]
        if window_cohorts:
            ctx.window_cohorts = window_cohorts
        window_n = sum(v.get("n", 0) or 0 for v in window_vals
                       if isinstance(v.get("n"), (int, float)) and v["n"] > 0)
        if window_n > 0:
            ctx.n_baseline_from_window = window_n
        edge_contexts[eid] = ctx

    topo_result = enhance_graph_latencies(graph, cohort_lookup, edge_contexts=edge_contexts)

    # Apply stats pass to graph
    graph = copy.deepcopy(graph)
    edges_by_uuid = {e["uuid"]: e for e in graph.get("edges", [])}
    for ev in topo_result.edge_values:
        edge = edges_by_uuid.get(ev.edge_uuid)
        if not edge:
            continue
        lat = edge.setdefault("p", {}).setdefault("latency", {})
        if ev.mu is not None:
            lat["mu"] = ev.mu
            lat["sigma"] = ev.sigma
            lat["onset_delta_days"] = ev.onset_delta_days
            lat["t95"] = ev.t95
            lat["path_t95"] = ev.path_t95
            lat["path_mu"] = ev.path_mu
            lat["path_sigma"] = ev.path_sigma
            lat["path_onset_delta_days"] = ev.path_onset_delta_days
        if ev.blended_mean is not None:
            edge["p"]["mean"] = ev.blended_mean
        if ev.p_infinity is not None and ev.forecast_available:
            edge["p"].setdefault("forecast", {})["mean"] = ev.p_infinity

    # Show the target edge's prod priors after stats pass
    target_edge_updated = edges_by_uuid[target_uuid]
    t_lat = target_edge_updated.get("p", {}).get("latency", {})
    print(f"\n  Target edge after stats pass:")
    print(f"    mu={t_lat.get('mu', '?')}, sigma={t_lat.get('sigma', '?')}, "
          f"onset={t_lat.get('onset_delta_days', '?')}, t95={t_lat.get('t95', '?')}")

    # --- Build snapshot subjects ---
    equiv_map: dict = {}
    for subj in fe_data.get("subjects", []):
        ch = subj.get("core_hash", "")
        eh = subj.get("equivalent_hashes", [])
        if ch and eh:
            equiv_map[ch] = eh

    snapshot_subjects = []
    for param_id, edge_id, window_hash, cohort_hash in _edges:
        base = {
            "param_id": param_id,
            "subject_id": f"parameter:{param_id}:{edge_id}:p:",
            "canonical_signature": "",
            "read_mode": "sweep_simple",
            "target": {"targetId": edge_id},
            "edge_id": edge_id,
            "slice_keys": [""],
            "anchor_from": anchor_from,
            "anchor_to": anchor_to,
            "sweep_from": anchor_from,
            "sweep_to": anchor_to,
        }
        snapshot_subjects.append({**base, "core_hash": window_hash,
                                  "equivalent_hashes": equiv_map.get(window_hash, [])})
        snapshot_subjects.append({**base, "core_hash": cohort_hash,
                                  "equivalent_hashes": equiv_map.get(cohort_hash, [])})

    # --- Generate prior configs ---
    configs = _make_prior_configs(target_edge_updated)
    if args.configs:
        selected = [c.strip() for c in args.configs.split(",")]
        configs = {k: v for k, v in configs.items() if k in selected}
        missing = [c for c in selected if c not in configs]
        if missing:
            print(f"WARNING: Unknown configs: {missing}")
            print(f"Available: {list(_make_prior_configs(target_edge_updated).keys())}")

    print(f"\n{'=' * 70}")
    print(f"PRIOR SENSITIVITY PROBE: {len(configs)} configurations")
    print(f"Target: {target_uuid[:12]}… ({target_pid})")
    print(f"Sampling: {args.draws} draws, {args.tune} tune, {args.chains} chains")
    print(f"{'=' * 70}")
    for name, cfg in configs.items():
        print(f"  {name:20s}  {cfg['description']}")

    # --- Run each config ---
    from worker import fit_graph

    results_summary = []
    LOG_PATH = f"/tmp/bayes_sensitivity-{graph_name}.log"
    log_file = open(LOG_PATH, "w")

    def _log(msg=""):
        print(msg, flush=True)
        log_file.write(msg + "\n")
        log_file.flush()

    _log(f"\nLog: {LOG_PATH}")

    for i, (config_name, config) in enumerate(configs.items()):
        _log(f"\n{'─' * 70}")
        _log(f"[{i+1}/{len(configs)}] Config: {config_name}")
        _log(f"  {config['description']}")
        _log(f"{'─' * 70}")

        # Apply prior config to graph
        patched_graph = _apply_config(graph, target_uuid, config)

        # For uninformative rate: modify param files to clear posterior/values
        patched_param_files = copy.deepcopy(param_files)
        if config.get("rate_patch", {}).get("_force_uninformative"):
            pf_key = f"parameter-{target_pid}"
            if pf_key in patched_param_files:
                pf = patched_param_files[pf_key]
                # Remove posterior so _resolve_prior falls to uninformative
                pf.pop("posterior", None)
                # Clear values so kn_derived doesn't kick in
                pf["values"] = []

        if config.get("rate_patch", {}).get("_halve_ess"):
            pf_key = f"parameter-{target_pid}"
            if pf_key in patched_param_files:
                pf = patched_param_files[pf_key]
                post = pf.get("posterior", {})
                if isinstance(post, dict):
                    for sk, sv in post.get("slices", {}).items():
                        if "alpha" in sv and "beta" in sv:
                            sv["alpha"] = sv["alpha"] / 2
                            sv["beta"] = sv["beta"] / 2

        # Build settings with any patches
        settings = {
            "draws": args.draws,
            "tune": args.tune,
            "chains": args.chains,
            "cores": args.cores,
        }
        if "settings_patch" in config:
            settings.update(config["settings_patch"])

        payload = {
            "graph_id": f"graph-{graph_name}",
            "graph_snapshot": patched_graph,
            "parameter_files": patched_param_files,
            "parameters_index": {},
            "snapshot_subjects": snapshot_subjects,
            "db_connection": db_connection,
            "webhook_url": "",
            "callback_token": f"sensitivity-{config_name}",
            "settings": settings,
            "_job_id": f"sensitivity-{config_name}-{int(time.time())}",
        }

        t0 = time.time()
        last_stage = ["idle"]

        def on_progress(stage, pct, detail=""):
            last_stage[0] = stage

        import threading
        result_box = [None]
        error_box = [None]

        def _worker():
            try:
                result_box[0] = fit_graph(payload, report_progress=on_progress)
            except Exception as e:
                import traceback
                error_box[0] = (e, traceback.format_exc())

        thread = threading.Thread(target=_worker, daemon=True)
        thread.start()

        while thread.is_alive():
            thread.join(timeout=5.0)
            if thread.is_alive():
                elapsed = time.time() - t0
                if elapsed > args.timeout:
                    _log(f"  TIMEOUT after {elapsed:.0f}s (stage: {last_stage[0]})")
                    import subprocess
                    subprocess.run(["pkill", "-P", str(os.getpid())], capture_output=True)
                    results_summary.append({
                        "config": config_name,
                        "status": "TIMEOUT",
                        "duration_s": elapsed,
                    })
                    break
        else:
            # Thread finished
            elapsed = time.time() - t0

            if error_box[0]:
                e, tb = error_box[0]
                _log(f"  CRASHED after {elapsed:.1f}s: {e}")
                _log(tb)
                results_summary.append({
                    "config": config_name,
                    "status": "CRASHED",
                    "duration_s": elapsed,
                    "error": str(e),
                })
                continue

            result = result_box[0]
            if not result:
                _log(f"  No result after {elapsed:.1f}s")
                results_summary.append({
                    "config": config_name,
                    "status": "NO_RESULT",
                    "duration_s": elapsed,
                })
                continue

            quality = result.get("quality", {})
            _log(f"  Completed in {elapsed:.1f}s")
            _log(f"  rhat={quality.get('max_rhat')}, ess={quality.get('min_ess')}, "
                 f"div={quality.get('total_divergences')}")

            # Extract target edge posterior
            target_posterior = {}
            for we in result.get("webhook_payload_edges", []):
                if we.get("edge_id", "").startswith(args.edge_prefix):
                    for sk, sv in we.get("slices", {}).items():
                        if "window" in sk:
                            target_posterior = sv
                            break
                    # Also check legacy format
                    if not target_posterior and we.get("latency", {}).get("mu_mean") is not None:
                        target_posterior = we.get("latency", {})
                    break

            if target_posterior:
                mu_mean = target_posterior.get("mu_mean", "?")
                sigma_mean = target_posterior.get("sigma_mean", "?")
                onset_mean = target_posterior.get("onset_mean", target_posterior.get("onset_delta_days", "?"))
                p_alpha = target_posterior.get("alpha", 0)
                p_beta = target_posterior.get("beta", 0)
                p_mean = p_alpha / (p_alpha + p_beta) if (p_alpha + p_beta) > 0 else "?"
                rhat = target_posterior.get("rhat", quality.get("max_rhat", "?"))
                ess = target_posterior.get("ess", quality.get("min_ess", "?"))

                _log(f"  Target edge posterior:")
                _log(f"    p={p_mean if isinstance(p_mean, str) else f'{p_mean:.4f}'}")
                _log(f"    mu={mu_mean if isinstance(mu_mean, str) else f'{mu_mean:.3f}'}, "
                     f"sigma={sigma_mean if isinstance(sigma_mean, str) else f'{sigma_mean:.3f}'}, "
                     f"onset={onset_mean if isinstance(onset_mean, str) else f'{onset_mean:.2f}'}")
                _log(f"    rhat={rhat}, ess={ess}")

                results_summary.append({
                    "config": config_name,
                    "status": "OK",
                    "duration_s": elapsed,
                    "max_rhat": quality.get("max_rhat"),
                    "min_ess": quality.get("min_ess"),
                    "divergences": quality.get("total_divergences"),
                    "target_p": p_mean,
                    "target_mu": mu_mean,
                    "target_sigma": sigma_mean,
                    "target_onset": onset_mean,
                    "target_rhat": rhat,
                    "target_ess": ess,
                })
            else:
                _log(f"  (target edge posterior not found in result)")
                results_summary.append({
                    "config": config_name,
                    "status": "OK_NO_TARGET",
                    "duration_s": elapsed,
                    "max_rhat": quality.get("max_rhat"),
                    "min_ess": quality.get("min_ess"),
                    "divergences": quality.get("total_divergences"),
                })

    # --- Summary table ---
    _log(f"\n{'=' * 90}")
    _log("SENSITIVITY SUMMARY")
    _log(f"{'=' * 90}")
    _log(f"{'Config':20s} {'Status':10s} {'Time':>6s} {'rhat':>7s} {'ESS':>6s} {'Div':>4s} "
         f"{'p':>7s} {'mu':>7s} {'sigma':>7s} {'onset':>7s}")
    _log(f"{'-'*20} {'-'*10} {'-'*6} {'-'*7} {'-'*6} {'-'*4} "
         f"{'-'*7} {'-'*7} {'-'*7} {'-'*7}")

    for r in results_summary:
        def _fmt(v, fmt=".3f"):
            if v is None or v == "?":
                return "?"
            try:
                return f"{float(v):{fmt}}"
            except (ValueError, TypeError):
                return str(v)

        _log(f"{r['config']:20s} {r.get('status', '?'):10s} "
             f"{r.get('duration_s', 0):6.0f}s "
             f"{_fmt(r.get('target_rhat', r.get('max_rhat')), '.3f'):>7s} "
             f"{_fmt(r.get('target_ess', r.get('min_ess')), '.0f'):>6s} "
             f"{_fmt(r.get('divergences'), '.0f'):>4s} "
             f"{_fmt(r.get('target_p'), '.4f'):>7s} "
             f"{_fmt(r.get('target_mu'), '.3f'):>7s} "
             f"{_fmt(r.get('target_sigma'), '.3f'):>7s} "
             f"{_fmt(r.get('target_onset'), '.2f'):>7s}")

    # --- Interpretation ---
    _log(f"\n{'─' * 90}")
    _log("INTERPRETATION GUIDE")
    _log(f"{'─' * 90}")
    _log("If ALL configs converge to similar posteriors → priors were wrong, geometry is fine.")
    _log("If ONLY some configs converge → geometry is sensitive to priors (ridge problem).")
    _log("If NO configs converge → fundamental geometry problem (model misspecification).")
    _log("")
    _log("Key comparisons:")
    _log("  prod vs neutral: Does removing informative priors help or hurt?")
    _log("  prod vs no_onset: Is the onset prior the problem?")
    _log("  prod vs posterior_seeded: Is there a stable mode the sampler can't find?")
    _log("  prod vs wide: Does widening priors help the sampler explore?")

    log_file.close()
    _log(f"\nFull log: {LOG_PATH}")


if __name__ == "__main__":
    main()
