#!/usr/bin/env python3
"""
Phase B diagnostic: run mirror-4step synth through the REAL pipeline,
intercept what _estimate_cohort_kappa actually receives, and compare
to ground truth.

Approach: monkeypatch _estimate_cohort_kappa to dump its inputs, then
run the synth graph through param_recovery.py's normal flow.
"""
from __future__ import annotations

import sys
import os
import json
import numpy as np

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "bayes"))
sys.path.insert(0, os.path.join(REPO_ROOT, "graph-editor", "lib"))

# We need to intercept the real _estimate_cohort_kappa. Strategy:
# 1. Run synth_gen to produce data
# 2. Run the evidence binder
# 3. Monkeypatch to dump inputs
# 4. Run summarise_posteriors (which calls _estimate_cohort_kappa)

# But that requires running the full MCMC. Too slow for diagnostics.
# Instead: run synth_gen, bind evidence, then call _estimate_cohort_kappa
# directly on each edge with the bound evidence and a fake phase2_frozen.


def main():
    import yaml
    from datetime import datetime, timedelta

    # Step 1: Load the truth file
    truth_path = os.path.join(REPO_ROOT, "nous-conversion", "graphs", "synth-mirror-4step.truth.yaml")
    with open(truth_path) as f:
        truth = yaml.safe_load(f)

    sim_config = truth["simulation"]
    edge_truths = truth["edges"]

    print("=== Phase B: Pipeline data inspection ===")
    print(f"Truth: entry_kappa={sim_config['kappa_sim_default']}, "
          f"step_kappa={sim_config['kappa_step_default']}")
    print()

    # Step 2: Run synth gen to produce snapshot data
    print("--- Running synth gen ---")
    from synth_gen import generate_synth_data, load_graph_config

    graph_name = "mirror-4step"
    graph_config = load_graph_config(graph_name)
    if graph_config is None:
        print("ERROR: could not load graph config for mirror-4step")
        return

    synth_result = generate_synth_data(
        graph_config,
        truth,
        dry_run=True,  # don't write to DB
    )
    if synth_result is None:
        print("ERROR: synth gen returned None")
        return

    snapshot_rows = synth_result["rows"]
    print(f"  Generated {len(snapshot_rows)} snapshot rows")

    # Step 3: Bind evidence (the real pipeline)
    print("\n--- Binding evidence ---")
    from compiler.evidence import bind_snapshot_evidence
    from compiler.topology import analyse_topology

    graph_path = os.path.join(REPO_ROOT, "nous-conversion", "graphs", graph_config["graph_file"])
    with open(graph_path) as f:
        graph_json = json.load(f)

    topology = analyse_topology(graph_json)
    print(f"  Topology: {len(topology.edges)} edges")

    # Build param_id → edge_id mapping from graph
    param_to_edge = {}
    for eid, et in topology.edges.items():
        if et.param_id:
            param_to_edge[et.param_id] = eid

    # Build settings dict
    settings = {"RECENCY_HALF_LIFE_DAYS": 30}

    evidence = bind_snapshot_evidence(
        topology,
        snapshot_rows,
        settings=settings,
    )
    print(f"  Bound evidence for {len(evidence.edges)} edges")

    # Step 4: For each edge, call _estimate_cohort_kappa and dump inputs
    print("\n--- Inspecting MLE inputs per edge ---")
    from compiler.inference import _estimate_cohort_kappa, DISPERSION_F_THRESHOLD
    from compiler.completeness import shifted_lognormal_cdf

    # Build a fake phase2_frozen from truth (as if Phase 1 recovered perfectly)
    phase2_frozen = {}
    for eid, et in topology.edges.items():
        if not et.param_id:
            continue
        truth_key = et.param_id
        if truth_key not in edge_truths:
            continue
        t = edge_truths[truth_key]
        phase2_frozen[eid] = {
            "p": t["p"],
            "onset": t.get("onset", 0.0),
            "mu": t.get("mu", 0.0),
            "sigma": t.get("sigma", 0.01),
        }

    today_date = datetime.now()

    for eid, et in topology.edges.items():
        if not et.param_id:
            continue
        ev = evidence.edges.get(eid)
        if ev is None:
            print(f"\n  {et.param_id}: NO EVIDENCE")
            continue

        truth_key = et.param_id
        t = edge_truths.get(truth_key, {})

        print(f"\n  === {et.param_id} (truth p={t.get('p','?')}) ===")

        # Count what evidence types we have
        n_window_obs = len(ev.window_obs) if ev.window_obs else 0
        n_cohort_obs = len(ev.cohort_obs) if ev.cohort_obs else 0
        print(f"    window_obs: {n_window_obs}, cohort_obs slices: {n_cohort_obs}")

        for c_obs in (ev.cohort_obs or []):
            n_daily = len(c_obs.daily) if c_obs.daily else 0
            n_traj = len(c_obs.trajectories) if c_obs.trajectories else 0
            print(f"    slice '{c_obs.slice_dsl}': {n_daily} daily, {n_traj} trajectories")

            # Dump a few trajectory details
            for i, traj in enumerate(c_obs.trajectories[:3]):
                max_age = getattr(traj, 'max_retrieval_age', None) or (traj.retrieval_ages[-1] if traj.retrieval_ages else 0)
                print(f"      traj[{i}]: type={traj.obs_type}, n={traj.n}, "
                      f"ages={len(traj.retrieval_ages)}, "
                      f"max_age={max_age:.1f}, "
                      f"final_y={traj.cumulative_y[-1] if traj.cumulative_y else '?'}, "
                      f"date={getattr(traj, 'date', '?')}")

        # Now call the actual MLE for both cohort and window
        for obs_type in ["cohort", "window"]:
            diags = []
            kappa = _estimate_cohort_kappa(
                ev, et, topology,
                p_cohort_mean=t.get("p", 0.5),
                diagnostics=diags,
                obs_type_filter=obs_type,
                phase2_frozen=phase2_frozen,
                recency_half_life=30.0,
                today_date=today_date,
            )
            for d in diags:
                print(f"    [{obs_type}] {d}")
            if kappa is not None:
                print(f"    [{obs_type}] RESULT: kappa = {kappa:.1f}")
            else:
                print(f"    [{obs_type}] RESULT: None")

    # Step 5: Also dump what the MLE would see if we bypass all filtering
    # and just compute raw empirical variance from the snapshot rows directly
    print(f"\n\n--- Raw snapshot-level empirical check ---")
    print("(Grouping snapshot rows by edge and anchor day, computing variance of k/n)")

    # Group rows by edge param_id
    from collections import defaultdict
    edge_rows = defaultdict(list)
    for row in snapshot_rows:
        # snapshot rows have: param_id, slice_dsl, date, n, k, retrieval_age, ...
        pid = row.get("param_id") or row.get("parameter_id")
        if pid:
            edge_rows[pid].append(row)

    for pid in sorted(edge_rows.keys()):
        rows = edge_rows[pid]
        t = edge_truths.get(pid, {})
        print(f"\n  {pid} (truth p={t.get('p', '?')})")
        print(f"    Total rows: {len(rows)}")

        # Group by (slice_dsl, date)
        by_slice = defaultdict(lambda: defaultdict(list))
        for r in rows:
            dsl = r.get("slice_dsl", "?")
            date = r.get("date", "?")
            by_slice[dsl][date].append(r)

        for dsl in sorted(by_slice.keys()):
            dates = by_slice[dsl]
            # For each date, take the most mature observation
            n_vals = []
            k_vals = []
            rates = []
            for date, date_rows in sorted(dates.items()):
                # pick the row with highest retrieval_age
                best = max(date_rows, key=lambda r: r.get("retrieval_age", 0))
                n = best.get("n", 0)
                k = best.get("k", 0)
                if n >= 3:
                    n_vals.append(n)
                    k_vals.append(k)
                    rates.append(k / n)

            if len(rates) < 5:
                print(f"    [{dsl}]: only {len(rates)} days with n>=3")
                continue

            n_arr = np.array(n_vals)
            k_arr = np.array(k_vals)
            r_arr = np.array(rates)

            # Williams MoM
            p_bar = k_arr.sum() / n_arr.sum()
            K = len(n_arr)
            w = n_arr.astype(float)
            w_sum = w.sum()
            ssq = np.sum(w * (r_arr - p_bar) ** 2) / (K - 1)
            n_tilde = (w_sum - np.sum(w ** 2) / w_sum) / (K - 1)
            rho_num = ssq - p_bar * (1 - p_bar)
            rho_den = p_bar * (1 - p_bar) * (n_tilde - 1)
            if rho_den > 0 and rho_num > 0:
                rho = rho_num / rho_den
                kappa_mom = (1 - rho) / rho
            else:
                kappa_mom = None

            print(f"    [{dsl}]: {len(rates)} days, "
                  f"median_n={np.median(n_arr):.0f}, "
                  f"p_bar={p_bar:.4f}, "
                  f"rate_std={r_arr.std():.6f}, "
                  f"MoM_kappa={kappa_mom:.1f if kappa_mom else 'None'}")


if __name__ == "__main__":
    main()
