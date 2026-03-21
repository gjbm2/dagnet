"""
Diagnostic MCMC run: short fit on branch graph, dump per-variable
rhat/ESS, divergence locations, step sizes, and energy diagnostics.

Usage:
  . /home/reg/dev/dagnet/graph-editor/venv/bin/activate
  cd /home/reg/dev/dagnet/bayes && python diag_run.py

Output: /tmp/bayes_diagnostics.txt
"""
import os
import sys
import json
import time

sys.path.insert(0, os.path.dirname(__file__))

# Load DB_CONNECTION from graph-editor/.env.local (same as test_harness)
_env_path = os.path.join(os.path.dirname(__file__), "..", "graph-editor", ".env.local")
if os.path.exists(_env_path):
    for _line in open(_env_path):
        _line = _line.strip()
        if _line.startswith("DB_CONNECTION="):
            os.environ["DB_CONNECTION"] = _line.split("=", 1)[1].strip().strip('"')
            break
if not os.environ.get("DB_CONNECTION"):
    print("ERROR: DB_CONNECTION not found in graph-editor/.env.local")
    sys.exit(1)

DIAG_PATH = "/tmp/bayes_diagnostics.txt"
LOG_PATH = "/tmp/bayes_harness.log"
REPO_ROOT = os.path.join(os.path.dirname(__file__), "..")

# Dual stdout + log file output (same pattern as test_harness)
log_file = open(LOG_PATH, "w")

def _print(msg=""):
    print(msg, flush=True)
    log_file.write(msg + "\n")
    log_file.flush()


def _resolve_data_repo():
    conf_path = os.path.join(REPO_ROOT, ".private-repos.conf")
    if not os.path.exists(conf_path):
        print("ERROR: .private-repos.conf not found")
        sys.exit(1)
    for line in open(conf_path):
        line = line.strip()
        if line.startswith("DATA_REPO_DIR="):
            return os.path.join(REPO_ROOT, line.split("=", 1)[1].strip().strip('"'))
    print("ERROR: DATA_REPO_DIR not found in .private-repos.conf")
    sys.exit(1)


def _log(msg, f=None):
    print(msg)
    if f:
        f.write(msg + "\n")
        f.flush()


def main():
    import argparse
    import numpy as np
    import yaml

    parser = argparse.ArgumentParser(description="Bayes diagnostic run")
    parser.add_argument("--no-latency", action="store_true", help="Disable latent latency (Phase S mode)")
    parser.add_argument("--no-cohort-latency", action="store_true", help="Disable cohort latency hierarchy")
    parser.add_argument("--no-overdispersion", action="store_true", help="Disable BetaBinomial/DM (use Binomial)")
    parser.add_argument("--draws", type=int, default=500, help="MCMC draws (default: 500)")
    parser.add_argument("--tune", type=int, default=500, help="MCMC tune (default: 500)")
    parser.add_argument("--exclude", type=str, nargs="*", default=[],
                        help="Exclude edges by param_id prefix (e.g. delegation-straight)")
    parser.add_argument("--synth", action="store_true",
                        help="Use synthetic data (bypasses snapshot DB)")
    parser.add_argument("--synth-people", type=int, default=5000,
                        help="People per day for synthetic data (default: 5000)")
    parser.add_argument("--synth-days", type=int, default=100,
                        help="Cohort days for synthetic data (default: 100)")
    args = parser.parse_args()

    features = {
        "latent_latency": not args.no_latency,
        "cohort_latency": not args.no_cohort_latency,
        "overdispersion": not args.no_overdispersion,
    }

    data_repo = _resolve_data_repo()

    # --- Graph config (branch) ---
    gcfg = {
        "graph_file": "conversion-flow-v2-recs-collapsed.json",
        "graph_id": "graph-conversion-flow-v2-recs-collapsed",
        "edges": [
            ("coffee-to-bds",                    "76e0e0f8-133d-4065-9fab-56480063d9c9", "HZC_WqTRBfy7zPWtXTtY7A", "plxD-64WK7_SJAY--TUlcA"),
            ("registration-to-success",          "370dce1d-3a36-4109-9711-204c301478c8", "-wNEREQRwNRE5wRjjuy2iQ", "CsFATi4Ye90pSpK-tEyzbg"),
            ("household-delegation-rate",        "3d0a0757-8224-4cf0-a841-4ad17cd48d91", "r0AMpAJ_uExLojzFQhI3BQ", "QqoOJonqx8zzialfD5jKlQ"),
            ("delegated-to-non-energy-rec",      "10e37cc7-0d37-4cd9-844b-653148025a51", "0Q4-AGwPXERTs5bQ0NACRg", "v_BRrQXxGn6lQ0MuJVccpA"),
            ("bds-to-energy-rec",                "77d0a69e-3c75-4722-932b-7f54d317d0ce", "D6tg5LOxVxSqUXvaLjtbog", "spQwZYRcECdZMr2CshbT-g"),
            ("delegated-to-coffee",              "64f4529c-62b8-4e7e-8479-c5289d925e58", "cFSR9ljHVYv9oAxijnyEWg", "kpDI95Ogtg6Rstx-jFpGCQ"),
            ("no-bdos-to-rec",                   "13b5397f-9feb-453a-8e86-500c0693b4af", "xrcxwR2t-wEECamJSw4RNg", "gTtI0X5ks5GD4USIz_tEGQ"),
            ("delegation-straight-to-energy-rec","8c23ea34-9c7e-40b3-ade3-291590774bfc", "EtC-FhDURPFuAvbZmc_DcA", "4Rfk9gYwK_27k2po2zOxzA"),
            ("non-energy-rec-to-reg",            "9624cce1-21f3-4085-9388-c155b5b657fd", "gmOm0rBQD9HRA3l8Kdo7hw", "_oPC_SNhxKml76ZzmESycg"),
            ("rec-with-bdos-to-registration",    "d45debd8-939b-4abb-b0d0-c5ef62412add", "ENci8vAkh-B9vMUx9SutXQ", "z3jCJuGWXK5g7h47on_Ryg"),
        ],
        "anchor_from": "2025-11-01",
        "anchor_to": "2026-03-20",
    }

    # --- Apply edge exclusions ---
    if args.exclude:
        original_count = len(gcfg["edges"])
        gcfg["edges"] = [
            e for e in gcfg["edges"]
            if not any(ex.lower() in e[0].lower() for ex in args.exclude)
        ]
        excluded = original_count - len(gcfg["edges"])
        _print(f"Excluded {excluded} edge(s) matching: {args.exclude}")

    # --- Load graph ---
    graph_path = os.path.join(data_repo, "graphs", gcfg["graph_file"])
    with open(graph_path) as gf:
        graph = json.load(gf)
    _print(f"Graph: {len(graph.get('edges', []))} edges")

    # --- Load param files ---
    param_files = {}
    params_dir = os.path.join(data_repo, "parameters")
    for fname in os.listdir(params_dir):
        if fname.endswith(".yaml") and "index" not in fname:
            with open(os.path.join(params_dir, fname)) as pf:
                param_id = fname.replace(".yaml", "")
                param_files[f"parameter-{param_id}"] = yaml.safe_load(pf)

    # --- Load hash mappings ---
    equiv_map = {}
    mappings_path = os.path.join(data_repo, "hash-mappings.json")
    if os.path.exists(mappings_path):
        with open(mappings_path) as hf:
            _raw = json.load(hf)
        _mappings = _raw if isinstance(_raw, list) else _raw.get("hash_mappings", [])
        for m in _mappings:
            if m.get("operation") != "equivalent":
                continue
            src, dst = m.get("core_hash", ""), m.get("equivalent_to", "")
            if not src or not dst or src == dst:
                continue
            for a, b in [(src, dst), (dst, src)]:
                equiv_map.setdefault(a, [])
                entry = {"core_hash": b, "operation": m["operation"], "weight": m.get("weight", 1.0)}
                if entry not in equiv_map[a]:
                    equiv_map[a].append(entry)

    # --- Build snapshot subjects ---
    snapshot_subjects = []
    for param_id, edge_id, window_hash, cohort_hash in gcfg["edges"]:
        base = {
            "param_id": param_id,
            "subject_id": f"parameter:{param_id}:{edge_id}:p:",
            "canonical_signature": "",
            "read_mode": "sweep_simple",
            "target": {"targetId": edge_id},
            "edge_id": edge_id,
            "slice_keys": [""],
            "anchor_from": gcfg["anchor_from"],
            "anchor_to": gcfg["anchor_to"],
            "sweep_from": gcfg["anchor_from"],
            "sweep_to": gcfg["anchor_to"],
        }
        snapshot_subjects.append({**base, "core_hash": window_hash,
                                  "equivalent_hashes": equiv_map.get(window_hash, [])})
        snapshot_subjects.append({**base, "core_hash": cohort_hash,
                                  "equivalent_hashes": equiv_map.get(cohort_hash, [])})
    _print(f"Snapshot subjects: {len(snapshot_subjects)}")

    # --- Compiler pipeline ---
    _print("Building model...")
    from compiler.topology import analyse_topology
    from compiler import bind_snapshot_evidence
    from compiler.model import build_model
    from worker import _query_snapshot_subjects

    topology = analyse_topology(graph)
    _print(f"  Topology: {len(topology.edges)} edges, "
           f"{len(topology.join_nodes)} joins")
    for jid, jn in topology.join_nodes.items():
        node_label = jid[:12]
        for n in graph.get("nodes", []):
            if n.get("uuid") == jid:
                node_label = n.get("label", jid[:12])
                break
        _print(f"  Join: {node_label} — {len(jn.inbound_edge_ids)} inbound edges")

    if args.synth:
        # Synthetic data — bypass snapshot DB entirely
        from synth_gen import simulate_graph, derive_truth_from_graph, print_summary
        truth = derive_truth_from_graph(graph, topology)
        _print(f"\n  Generating synthetic data ({args.synth_people} people/day × {args.synth_days} days)...")
        snapshot_data = simulate_graph(
            graph, topology, truth,
            n_people_per_day=args.synth_people,
            n_days=args.synth_days,
            seed=42,
        )
        total_rows = sum(len(v) for v in snapshot_data.values())
        _print(f"  Synthetic data: {len(snapshot_data)} edges, {total_rows} total rows")
        synth_truth = truth  # save for recovery report later
    else:
        log_lines = []
        snapshot_data = _query_snapshot_subjects(
            snapshot_subjects, topology, log_lines,
        )
        total_rows = sum(len(v) for v in snapshot_data.values())
        _print(f"  Snapshot data: {len(snapshot_data)} edges, {total_rows} total rows")
        synth_truth = None

    evidence = bind_snapshot_evidence(
        topology, snapshot_data, param_files, {}, {},
    )
    model, metadata = build_model(topology, evidence, features=features)

    _print(f"  Model: {len(model.free_RVs)} free, "
           f"{len(model.potentials)} potentials, "
           f"{len(model.observed_RVs)} observed")
    _print(f"  Free vars: {[v.name for v in model.free_RVs]}")

    # --- Short MCMC with progress reporting ---
    _print(f"\nFeatures: {features}")
    _print(f"Running MCMC ({args.draws} draws, {args.tune} tune, 4 chains)...")
    _print(f"Log file: {LOG_PATH}")
    _print(f"  tail -f {LOG_PATH}")
    t0 = time.time()

    def on_progress(stage, pct, detail=""):
        elapsed = time.time() - t0
        _print(f"  [{pct:3d}%] {elapsed:6.1f}s  {stage}: {detail}")

    from compiler.types import SamplingConfig
    from compiler.inference import run_inference
    config = SamplingConfig(draws=args.draws, tune=args.tune, chains=4, target_accept=0.90)
    trace, quality = run_inference(model, config, report_progress=on_progress)
    elapsed = time.time() - t0
    _print(f"  Done in {elapsed:.1f}s")

    # --- Dump diagnostics ---
    import arviz as az

    with open(DIAG_PATH, "w") as f:
        _log(f"{'='*70}", f)
        _log(f"BAYES DIAGNOSTIC — branch graph (reverted, no mixture DP)", f)
        _log(f"{'='*70}", f)
        _log(f"Time: {elapsed:.1f}s  |  500 draws, 500 tune, 4 chains", f)
        _log(f"Divergences: {quality.total_divergences}", f)
        _log(f"Max rhat: {quality.max_rhat:.4f}", f)
        _log(f"Min ESS: {quality.min_ess:.1f}", f)
        _log(f"Converged: {quality.converged_pct}%", f)

        rhat_ds = az.rhat(trace)
        ess_ds = az.ess(trace)

        # Per-variable table
        _log(f"\n{'='*70}", f)
        _log("PER-VARIABLE (sorted by rhat, worst first)", f)
        _log(f"{'='*70}", f)
        _log(f"{'Variable':<45} {'rhat':>8} {'ESS':>8} {'mean':>10} {'sd':>10}", f)
        _log("-" * 85, f)

        var_diags = []
        for var_name in sorted(trace.posterior.data_vars):
            samples = trace.posterior[var_name].values
            rhat_val = float(rhat_ds[var_name].values.flat[0]) if var_name in rhat_ds else float('nan')
            ess_val = float(ess_ds[var_name].values.flat[0]) if var_name in ess_ds else float('nan')
            mean_val = float(np.mean(samples))
            sd_val = float(np.std(samples))
            var_diags.append((var_name, rhat_val, ess_val, mean_val, sd_val))

        var_diags.sort(key=lambda x: -x[1] if not np.isnan(x[1]) else 0)
        for vname, rhat_v, ess_v, mean_v, sd_v in var_diags:
            flag = " ***" if rhat_v > 1.05 or ess_v < 400 else ""
            _log(f"{vname:<45} {rhat_v:>8.4f} {ess_v:>8.1f} {mean_v:>10.4f} {sd_v:>10.4f}{flag}", f)

        # Per-chain step sizes
        _log(f"\n{'='*70}", f)
        _log("PER-CHAIN STEP SIZE", f)
        _log(f"{'='*70}", f)
        if "step_size" in trace.sample_stats:
            step_sizes = trace.sample_stats["step_size"].values
            for ci in range(step_sizes.shape[0]):
                _log(f"  Chain {ci}: mean={np.mean(step_sizes[ci]):.6f}, "
                     f"final={step_sizes[ci][-1]:.6f}", f)

        # Per-chain divergences
        _log(f"\n{'='*70}", f)
        _log("PER-CHAIN DIVERGENCES", f)
        _log(f"{'='*70}", f)
        if "diverging" in trace.sample_stats:
            div_vals = trace.sample_stats["diverging"].values
            for ci in range(div_vals.shape[0]):
                _log(f"  Chain {ci}: {int(div_vals[ci].sum())} divergences", f)

        # Energy
        _log(f"\n{'='*70}", f)
        _log("ENERGY (per chain)", f)
        _log(f"{'='*70}", f)
        if "energy" in trace.sample_stats:
            energy = trace.sample_stats["energy"].values
            for ci in range(energy.shape[0]):
                e = energy[ci]
                _log(f"  Chain {ci}: mean={np.mean(e):.1f}, sd={np.std(e):.1f}, "
                     f"range=[{np.min(e):.1f}, {np.max(e):.1f}]", f)

        # Tree depth
        _log(f"\n{'='*70}", f)
        _log("TREE DEPTH (per chain)", f)
        _log(f"{'='*70}", f)
        for key in ["tree_depth", "depth", "n_steps"]:
            if key in trace.sample_stats:
                td = trace.sample_stats[key].values
                for ci in range(td.shape[0]):
                    _log(f"  Chain {ci}: mean={np.mean(td[ci]):.1f}, "
                         f"max={int(np.max(td[ci]))}, "
                         f"pct_at_max={100*np.mean(td[ci] >= np.max(td[ci])):.0f}%", f)
                break

        # Per-chain means for worst variables
        _log(f"\n{'='*70}", f)
        _log("PER-CHAIN MEANS FOR WORST VARS (rhat > 1.02)", f)
        _log(f"{'='*70}", f)
        worst_vars = [(v, r) for v, r, _, _, _ in var_diags if r > 1.02]
        for vname, rhat_v in worst_vars[:20]:
            samples = trace.posterior[vname].values
            chain_means = [f"{float(np.mean(samples[c])):.4f}" for c in range(samples.shape[0])]
            _log(f"  {vname} (rhat={rhat_v:.3f}): chains={chain_means}", f)

        # sample_stats keys
        _log(f"\n{'='*70}", f)
        _log("SAMPLE_STATS KEYS", f)
        _log(f"{'='*70}", f)
        if hasattr(trace, "sample_stats"):
            for k in sorted(trace.sample_stats.data_vars):
                _log(f"  {k}: {trace.sample_stats[k].values.shape}", f)

        _log(f"\nDiagnostics: {DIAG_PATH}", f)

    _print(f"\nDiagnostics written to {DIAG_PATH}")
    log_file.close()


if __name__ == "__main__":
    main()
