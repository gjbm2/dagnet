#!/usr/bin/env python3
"""
Generate truth YAML files for the sparsity sweep test plan.

Produces graphs across two axes:
  1. Random degradation: frame_drop_rate, toggle_rate, initial_absent_pct
  2. Structured lifecycle: per-value active_from_day / active_to_day

For 3 representative topologies × 6 sparsity configurations = 18 graphs.

Usage:
    python bayes/plans/generate_sparsity_sweep.py
    # Writes to bayes/plans/new-graph-drafts/

Each graph shares base truth parameters with its non-sparse counterpart
(same p, mu, sigma, onset) — only sparsity and lifecycle config differs.
"""
import os
import yaml

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "truth")

# ---------------------------------------------------------------------------
# Base topologies
# ---------------------------------------------------------------------------

TOPOS = {
    "solo": {
        "edges": {
            "anchor-to-target": {
                "from": "anchor", "to": "target",
                "p": 0.30, "onset": 1.0, "mu": 1.5, "sigma": 0.5,
            },
        },
        "nodes": {
            "anchor": {"start": True, "type": "entry", "label": "Anchor"},
            "target": {"absorbing": True, "type": "event", "label": "Target",
                       "outcome_type": "success"},
        },
    },
    "abc": {
        "edges": {
            "a-to-b": {"from": "a", "to": "b",
                        "p": 0.70, "onset": 1.0, "mu": 2.3, "sigma": 0.5},
            "b-to-c": {"from": "b", "to": "c",
                        "p": 0.60, "onset": 2.0, "mu": 2.5, "sigma": 0.6},
        },
        "nodes": {
            "a": {"start": True, "type": "entry", "label": "A"},
            "b": {"type": "event", "label": "B"},
            "c": {"absorbing": True, "type": "event", "label": "C",
                  "outcome_type": "success"},
        },
    },
    "diamond": {
        "edges": {
            "anchor-to-gate": {"from": "anchor", "to": "gate",
                                "p": 0.85, "onset": 1.0, "mu": 2.0, "sigma": 0.5},
            "gate-to-path-a": {"from": "gate", "to": "path-a",
                                "p": 0.40, "onset": 2.0, "mu": 2.3, "sigma": 0.5},
            "gate-to-path-b": {"from": "gate", "to": "path-b",
                                "p": 0.35, "onset": 3.0, "mu": 2.5, "sigma": 0.6},
            "path-a-to-join": {"from": "path-a", "to": "join",
                                "p": 0.70, "onset": 1.0, "mu": 2.0, "sigma": 0.4},
            "path-b-to-join": {"from": "path-b", "to": "join",
                                "p": 0.60, "onset": 2.0, "mu": 2.2, "sigma": 0.5},
            "join-to-outcome": {"from": "join", "to": "outcome",
                                 "p": 0.50, "onset": 1.0, "mu": 2.0, "sigma": 0.5},
        },
        "nodes": {
            "anchor": {"start": True, "type": "entry", "label": "Anchor"},
            "gate": {"type": "event", "label": "Gate"},
            "path-a": {"type": "event", "label": "Path A"},
            "path-b": {"type": "event", "label": "Path B"},
            "join": {"type": "event", "label": "Join"},
            "outcome": {"absorbing": True, "type": "event", "label": "Outcome",
                        "outcome_type": "success"},
        },
    },
}

# Context dimension (same for all graphs in the sweep)
CONTEXT_DIM_BASE = {
    "id": "synth-channel",
    "mece": True,
    "values": [
        {"id": "google", "label": "Google", "weight": 0.60,
         "sources": {"amplitude": {"field": "utm_medium", "filter": "utm_medium == 'google'"}}},
        {"id": "direct", "label": "Direct", "weight": 0.30,
         "sources": {"amplitude": {"field": "utm_medium", "filter": "utm_medium == 'direct'"}}},
        {"id": "email", "label": "Email", "weight": 0.10,
         "sources": {"amplitude": {"field": "utm_medium", "filter": "utm_medium == 'email'"}}},
    ],
}

# Per-edge context multipliers (applied uniformly)
def _add_context_mults(edges: dict, prefix: str) -> dict:
    """Add context multipliers to edge truth entries."""
    mults = {
        "google": {"p_mult": 1.20, "mu_offset": -0.2},
        "direct": {},  # neutral
        "email":  {"p_mult": 0.70, "mu_offset": 0.3},
    }
    for val in CONTEXT_DIM_BASE["values"]:
        val_id = val["id"]
        val_mults = mults.get(val_id, {})
        if val_mults:
            val.setdefault("edges", {})
            for eid in edges:
                val["edges"][f"{prefix}-{eid}"] = dict(val_mults)
    return CONTEXT_DIM_BASE


# ---------------------------------------------------------------------------
# Sparsity configurations
# ---------------------------------------------------------------------------

RANDOM_SPARSITY = [
    {"level": "sparse-1", "label": "mild random",
     "frame_drop_rate": 0.10, "toggle_rate": 0.01, "initial_absent_pct": 0.10,
     "mean_daily_traffic": 500},
    {"level": "sparse-2", "label": "moderate random",
     "frame_drop_rate": 0.20, "toggle_rate": 0.03, "initial_absent_pct": 0.25,
     "mean_daily_traffic": 500},
    {"level": "sparse-3", "label": "severe random",
     "frame_drop_rate": 0.35, "toggle_rate": 0.05, "initial_absent_pct": 0.40,
     "mean_daily_traffic": 200},
    {"level": "sparse-4", "label": "extreme random",
     "frame_drop_rate": 0.50, "toggle_rate": 0.08, "initial_absent_pct": 0.50,
     "mean_daily_traffic": 100},
]

# Structured lifecycle: treatment B stops 2/3, treatment C starts 1/3
LIFECYCLE_CONFIG = {
    "level": "lifecycle",
    "label": "structured temporal coverage (A throughout, B stops day 65, C starts day 33)",
    "mean_daily_traffic": 500,
    "values_override": [
        {"id": "google", "label": "Baseline (A)", "weight": 0.50},
        {"id": "direct", "label": "Treatment B", "weight": 0.30,
         "active_to_day": 65},
        {"id": "email", "label": "Treatment C", "weight": 0.20,
         "active_from_day": 33},
    ],
}

# Structured + random combined
LIFECYCLE_SPARSE_CONFIG = {
    "level": "lifecycle-sparse",
    "label": "structured lifecycle + moderate random sparsity",
    "mean_daily_traffic": 300,
    "frame_drop_rate": 0.15, "toggle_rate": 0.02, "initial_absent_pct": 0.15,
    "values_override": [
        {"id": "google", "label": "Baseline (A)", "weight": 0.50},
        {"id": "direct", "label": "Treatment B", "weight": 0.30,
         "active_to_day": 65},
        {"id": "email", "label": "Treatment C", "weight": 0.20,
         "active_from_day": 33},
    ],
}


# ---------------------------------------------------------------------------
# Generator
# ---------------------------------------------------------------------------

def _widen_thresholds(level: str) -> dict:
    """Wider recovery thresholds for sparser graphs."""
    base = {"p_z": 2.5, "mu_z": 2.5, "sigma_z": 3.0, "onset_z": 3.0}
    per_slice = {"p_slice_z": 3.0}
    if "2" in level:
        base = {"p_z": 3.0, "mu_z": 3.0, "sigma_z": 3.5, "onset_z": 3.5}
        per_slice = {"p_slice_z": 3.5}
    elif "3" in level:
        base = {"p_z": 3.5, "mu_z": 3.5, "sigma_z": 4.0, "onset_z": 4.0}
        per_slice = {"p_slice_z": 4.0}
    elif "4" in level:
        base = {"p_z": 4.0, "mu_z": 4.0, "sigma_z": 4.5, "onset_z": 4.5}
        per_slice = {"p_slice_z": 4.5}
    elif "lifecycle" in level:
        base = {"p_z": 3.0, "mu_z": 3.0, "sigma_z": 3.5, "onset_z": 3.5}
        per_slice = {"p_slice_z": 3.5}
    return base, per_slice


def generate_graph(topo_name: str, topo: dict, sparsity: dict, seed: int) -> dict:
    """Generate a truth YAML dict for one graph."""
    level = sparsity["level"]
    prefix = f"synth-{topo_name}-{level}"
    n_days = 100

    # Build context dim (may have lifecycle overrides)
    import copy
    ctx_dim = copy.deepcopy(CONTEXT_DIM_BASE)
    if "values_override" in sparsity:
        for i, vo in enumerate(sparsity["values_override"]):
            for k, v in vo.items():
                ctx_dim["values"][i][k] = v

    # Add per-edge context multipliers
    mults = {
        "google": {"p_mult": 1.20, "mu_offset": -0.2},
        "direct": {},
        "email": {"p_mult": 0.70, "mu_offset": 0.3},
    }
    for val in ctx_dim["values"]:
        val_mults = mults.get(val["id"], {})
        if val_mults:
            val["edges"] = {}
            for eid in topo["edges"]:
                val["edges"][f"{prefix}-{eid}"] = dict(val_mults)

    # Prefix edge keys
    edges = {}
    for eid, edef in topo["edges"].items():
        edges[f"{prefix}-{eid}"] = dict(edef)

    # Prefix node event_ids
    nodes = {}
    for nid, ndef in topo["nodes"].items():
        nd = dict(ndef)
        nd["event_id"] = f"{prefix}-{nid}"
        nodes[nid] = nd

    thresholds, per_slice = _widen_thresholds(level)

    truth = {
        "simulation": {
            "mean_daily_traffic": sparsity.get("mean_daily_traffic", 500),
            "n_days": n_days,
            "user_kappa": 50,
            "failure_rate": 0.05,
            "drift_sigma": 0.0,
            "seed": seed,
            "expected_sample_seconds": 2400 if topo_name == "diamond" else 1200,
        },
        "emit_context_slices": True,
        "context_dimensions": [ctx_dim],
        "edges": edges,
        "nodes": nodes,
        "graph": {
            "name": prefix,
            "description": f"Sparsity sweep: {topo_name} topology, {sparsity['label']}",
        },
        "testing": {
            "thresholds": thresholds,
            "per_slice_thresholds": per_slice,
        },
    }

    # Add random sparsity params to simulation block
    for key in ("frame_drop_rate", "toggle_rate", "initial_absent_pct"):
        if key in sparsity:
            truth["simulation"][key] = sparsity[key]

    return truth


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    seed = 100
    generated = []

    all_configs = RANDOM_SPARSITY + [LIFECYCLE_CONFIG, LIFECYCLE_SPARSE_CONFIG]

    for topo_name, topo in TOPOS.items():
        for sparsity in all_configs:
            truth = generate_graph(topo_name, topo, sparsity, seed)
            name = truth["graph"]["name"]
            path = os.path.join(OUT_DIR, f"{name}.truth.yaml")
            with open(path, "w") as f:
                # Header comment
                f.write(f"# {truth['graph']['description']}\n")
                f.write(f"# Generated by generate_sparsity_sweep.py\n\n")
                yaml.dump(truth, f, default_flow_style=False, sort_keys=False,
                          allow_unicode=True)
            generated.append(name)
            seed += 1

    print(f"Generated {len(generated)} truth YAMLs in {OUT_DIR}:")
    for name in generated:
        print(f"  {name}")


if __name__ == "__main__":
    main()
