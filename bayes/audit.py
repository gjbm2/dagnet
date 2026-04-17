"""
Multi-layered audit of Bayes fit diagnostics.

Parses the structured log output from fit_graph() to extract per-layer
status: completion, feature flags, data binding, priors, model structure,
inference posteriors, convergence, and LOO-ELPD.

Used by:
  - run_regression.py: parses harness log files for regression reporting
  - worker.py: inline audit of the log list for production trace logging

The audit dict is the contract between the log producer (worker.py) and
all consumers (regression report, FE trace display, monitoring).
"""

from __future__ import annotations

import re


def audit_log(log_content: str) -> dict:
    """Extract multi-layered audit from fit_graph log content.

    Accepts the raw log content as a string (newline-separated lines).
    Returns a structured dict with per-layer status. See
    BAYES_REGRESSION_TOOLING.md for the full layer reference.
    """
    audit: dict = {
        "log_found": True,
        "completed": False,
        "features": {},
        "dsl": "",
        "subjects": 0,
        "regimes": 0,
        "data_binding": {"snapshot_edges": 0, "fallback_edges": 0,
                         "total_bound": 0, "total_failed": 0,
                         "binding_details": [],
                         "slice_details": []},
        "priors": {"edges_with_latency_prior": 0, "prior_details": []},
        "model": {"kappa_lat_edges": 0, "latency_dispersion_flag": False,
                  "phase1_sampled": False, "phase2_sampled": False},
        "inference": {"edges_with_mu": 0, "mu_details": []},
        "convergence": {"rhat": 0.0, "ess": 0, "converged_pct": 0.0},
        "loo": {"status": "not_run", "edges_scored": 0, "total_delta_elpd": 0.0,
                "worst_pareto_k": 0.0, "diagnostics": []},
    }

    if not log_content or not log_content.strip():
        audit["log_found"] = False
        return audit

    for line in log_content.split("\n"):
        # DSL and subjects
        if line.strip().startswith("DSL: ") and not audit["dsl"]:
            audit["dsl"] = line.strip()[5:]
        sm = re.search(r"subjects: (\d+) snapshot subjects, (\d+) candidate regimes", line)
        if sm:
            audit["subjects"] = int(sm.group(1))
            audit["regimes"] = int(sm.group(2))

        # Completion
        if "Status:      complete" in line:
            audit["completed"] = True

        # Features
        if "latency_dispersion=True" in line:
            audit["model"]["latency_dispersion_flag"] = True
        if "latency_dispersion=False" in line and not audit["model"]["latency_dispersion_flag"]:
            audit["model"]["latency_dispersion_flag"] = False

        # Data binding
        if "snapshot rows →" in line:
            audit["data_binding"]["snapshot_edges"] += 1
        elif "no snapshot data, using engorged" in line:
            audit["data_binding"]["fallback_edges"] += 1
        if "binding receipt:" in line:
            m = re.search(r"(\d+) bound.*?(\d+) failed", line)
            if m:
                audit["data_binding"]["total_bound"] = int(m.group(1))
                audit["data_binding"]["total_failed"] = int(m.group(2))
        # Per-edge binding detail
        bm = re.search(
            r"binding (\w{8})…: verdict=(\w+), source=(\w+), rows=(\d+)→(\d+)→(\d+)",
            line,
        )
        if bm:
            audit["data_binding"]["binding_details"].append({
                "uuid": bm.group(1),
                "verdict": bm.group(2),
                "source": bm.group(3),
                "rows_raw": int(bm.group(4)),
                "rows_post_regime": int(bm.group(5)),
                "rows_final": int(bm.group(6)),
            })

        # Per-slice binding detail (doc 35)
        sm_slice = re.search(
            r"slice (\w{8})… (context\([^)]+\)): "
            r"total_n=(\d+) window=(\d+) cohort=(\d+)",
            line,
        )
        if sm_slice:
            audit["data_binding"]["slice_details"].append({
                "uuid": sm_slice.group(1),
                "ctx_key": sm_slice.group(2),
                "total_n": int(sm_slice.group(3)),
                "window_n": int(sm_slice.group(4)),
                "cohort_n": int(sm_slice.group(5)),
            })

        # Priors
        if "mu_prior=" in line and "latency" in line:
            audit["priors"]["edges_with_latency_prior"] += 1
            pm = re.search(r"latency: (\w{8})…\s+mu_prior=([\d.]+)", line)
            if pm:
                audit["priors"]["prior_details"].append({
                    "uuid": pm.group(1), "mu_prior": float(pm.group(2)),
                })
            else:
                audit["priors"]["prior_details"].append(line.strip())

        # Model structure — count unique kappa_lat edges (deduplicate across phases)
        klm = re.search(r"latency_dispersion (\w{8}_\w{4}_\w{4}_\w{4}_\w{12}).*kappa_lat ~ LogNormal", line)
        if klm:
            kl_set = audit["model"].setdefault("_kl_uuids", set())
            kl_set.add(klm.group(1))
            audit["model"]["kappa_lat_edges"] = len(kl_set)
        elif "kappa_lat ~ LogNormal, BetaBinomial" in line and not klm:
            audit["model"]["kappa_lat_edges"] += 1
        # Batched kappa_lat_slice_vec (per-slice latency dispersion)
        klm_batched = re.search(
            r"latency_dispersion (\S+) \((batched|perslice_traj)\).*kappa_lat_slice_vec", line)
        if klm_batched:
            kl_set = audit["model"].setdefault("_kl_uuids", set())
            kl_set.add(klm_batched.group(1))
            audit["model"]["kappa_lat_edges"] = len(kl_set)
        if "Potential traj_window_" in line and "_batched:" in line:
            audit["model"]["has_batched_trajectories"] = True
        if "sampling_ms:" in line:
            audit["model"]["phase1_sampled"] = True
        if "sampling_phase2_ms:" in line:
            audit["model"]["phase2_sampled"] = True

        # Inference posteriors
        m = re.search(
            r"inference:\s+latency (\w{8})…:\s+mu=([\d.]+)±([\d.]+)\s+"
            r"\(prior=([\d.]+)\).*?ess=(\d+)"
            r"(?:.*?kappa_lat=([\d.]+)(?:±([\d.]+))?)?",
            line,
        )
        if m:
            audit["inference"]["edges_with_mu"] += 1
            entry = {
                "uuid": m.group(1),
                "mu": float(m.group(2)),
                "mu_sd": float(m.group(3)),
                "prior": float(m.group(4)),
                "ess": int(m.group(5)),
            }
            if m.group(6):
                entry["kappa_lat"] = float(m.group(6))
            if m.group(7):
                entry["kappa_lat_sd"] = float(m.group(7))
            audit["inference"]["mu_details"].append(entry)

        # Per-slice inference posteriors (doc 35)
        sp_m = re.search(
            r"p_slice (\w{8})… (.+?):\s+([\d.]+)±([\d.]+)\s+"
            r"HDI=\[([\d.]+),\s*([\d.]+)\]",
            line,
        )
        if sp_m:
            sp_entry = {
                "uuid": sp_m.group(1),
                "ctx_key": sp_m.group(2),
                "p_mean": float(sp_m.group(3)),
                "p_sd": float(sp_m.group(4)),
                "p_hdi_lower": float(sp_m.group(5)),
                "p_hdi_upper": float(sp_m.group(6)),
            }
            for var in ["kappa", "mu", "sigma", "onset", "kappa_lat"]:
                vm = re.search(rf"{var}=([\d.]+)±([\d.]+)", line)
                if vm:
                    sp_entry[f"{var}_mean"] = float(vm.group(1))
                    sp_entry[f"{var}_sd"] = float(vm.group(2))
            audit["inference"].setdefault("slice_details", []).append(sp_entry)

        # Convergence
        m = re.search(r"Quality:.*rhat=([\d.]+).*ess=([\d.]+).*converged=([\d.]+)%", line)
        if m:
            audit["convergence"]["rhat"] = float(m.group(1))
            audit["convergence"]["ess"] = float(m.group(2))
            audit["convergence"]["converged_pct"] = float(m.group(3))

        # LOO-ELPD
        if "LOO:" in line:
            audit["loo"]["diagnostics"].append(line.strip())
            lm = re.search(
                r"LOO: (\d+) edges scored.*?ΔELPD=([-\d.]+).*?pareto_k=([\d.]+)", line,
            )
            if lm:
                audit["loo"]["status"] = "scored"
                audit["loo"]["edges_scored"] = int(lm.group(1))
                audit["loo"]["total_delta_elpd"] = float(lm.group(2))
                audit["loo"]["worst_pareto_k"] = float(lm.group(3))
            elif "failed" in line.lower() or "skipping" in line.lower():
                audit["loo"]["status"] = "failed"

        # Per-slice LOO (doc 35)
        slm = re.search(
            r"LOO: slice (\S+): (\d+) edges, ΔELPD=([-\d.]+), worst_pareto_k=([\d.]+)",
            line,
        )
        if slm:
            audit["loo"].setdefault("slice_details", []).append({
                "ctx_safe": slm.group(1),
                "edges": int(slm.group(2)),
                "delta_elpd": float(slm.group(3)),
                "worst_pareto_k": float(slm.group(4)),
            })

    return audit
