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
    "fanout": {
        "edges": {
            "anchor-to-gate": {"from": "anchor", "to": "gate",
                                "p": 0.80, "onset": 1.0, "mu": 1.5, "sigma": 0.4},
            "gate-to-fast": {"from": "gate", "to": "fast",
                              "p": 0.45, "onset": 1.0, "mu": 1.0, "sigma": 0.3},
            "gate-to-slow": {"from": "gate", "to": "slow",
                              "p": 0.35, "onset": 5.0, "mu": 2.0, "sigma": 0.5},
        },
        "nodes": {
            "anchor": {"start": True, "type": "entry", "label": "Anchor"},
            "gate": {"type": "event", "label": "Gate"},
            "fast": {"absorbing": True, "type": "event", "label": "Fast",
                     "outcome_type": "success"},
            "slow": {"absorbing": True, "type": "event", "label": "Slow",
                     "outcome_type": "success"},
        },
    },
    "mirror4": {
        "edges": {
            "landing-to-created": {"from": "landing", "to": "created",
                                    "p": 0.60, "onset": 1.0, "mu": 1.0, "sigma": 0.3},
            "created-to-delegated": {"from": "created", "to": "delegated",
                                      "p": 0.55, "onset": 1.0, "mu": 1.5, "sigma": 0.4},
            "delegated-to-registered": {"from": "delegated", "to": "registered",
                                         "p": 0.45, "onset": 2.0, "mu": 2.0, "sigma": 0.5},
            "registered-to-success": {"from": "registered", "to": "success",
                                       "p": 0.70, "onset": 1.0, "mu": 1.5, "sigma": 0.4},
        },
        "nodes": {
            "landing": {"start": True, "type": "entry", "label": "Landing"},
            "created": {"type": "event", "label": "Created"},
            "delegated": {"type": "event", "label": "Delegated"},
            "registered": {"type": "event", "label": "Registered"},
            "success": {"absorbing": True, "type": "event", "label": "Success",
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

# Secondary dim used in multi-dim sparsity tier (paired with synth-channel)
SECONDARY_DIM_BASE = {
    "id": "synth-device",
    "mece": True,
    "values": [
        {"id": "mobile", "label": "Mobile", "weight": 0.55,
         "sources": {"amplitude": {"field": "device_type", "filter": "device_type == 'mobile'"}}},
        {"id": "desktop", "label": "Desktop", "weight": 0.35,
         "sources": {"amplitude": {"field": "device_type", "filter": "device_type == 'desktop'"}}},
        {"id": "tablet", "label": "Tablet", "weight": 0.10,
         "sources": {"amplitude": {"field": "device_type", "filter": "device_type == 'tablet'"}}},
    ],
}

# High-cardinality dim (5 values) for scaling tier
HIGH_CARD_DIM_BASE = {
    "id": "synth-segment",
    "mece": True,
    "values": [
        {"id": "seg-a", "label": "Segment A", "weight": 0.30,
         "sources": {"amplitude": {"field": "segment", "filter": "segment == 'a'"}}},
        {"id": "seg-b", "label": "Segment B", "weight": 0.25,
         "sources": {"amplitude": {"field": "segment", "filter": "segment == 'b'"}}},
        {"id": "seg-c", "label": "Segment C", "weight": 0.20,
         "sources": {"amplitude": {"field": "segment", "filter": "segment == 'c'"}}},
        {"id": "seg-d", "label": "Segment D", "weight": 0.15,
         "sources": {"amplitude": {"field": "segment", "filter": "segment == 'd'"}}},
        {"id": "seg-e", "label": "Segment E", "weight": 0.10,
         "sources": {"amplitude": {"field": "segment", "filter": "segment == 'e'"}}},
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


CHANNEL_MULTS = {
    "google": {"p_mult": 1.20, "mu_offset": -0.2},
    "direct": {},
    "email":  {"p_mult": 0.70, "mu_offset": 0.3},
}

DEVICE_MULTS = {
    "mobile":  {"p_mult": 0.90, "mu_offset": 0.1},
    "desktop": {},
    "tablet":  {"p_mult": 0.75, "mu_offset": 0.2},
}

SEGMENT_MULTS = {
    "seg-a": {"p_mult": 1.30, "mu_offset": -0.3},
    "seg-b": {"p_mult": 1.10, "mu_offset": -0.1},
    "seg-c": {},
    "seg-d": {"p_mult": 0.85, "mu_offset": 0.2},
    "seg-e": {"p_mult": 0.65, "mu_offset": 0.4},
}


def _apply_mults(dim: dict, mults: dict, edge_ids: list, prefix: str) -> None:
    """Add per-edge multipliers to a context dim's values in-place."""
    for val in dim["values"]:
        val_mults = mults.get(val["id"], {})
        if val_mults:
            val["edges"] = {}
            for eid in edge_ids:
                val["edges"][f"{prefix}-{eid}"] = dict(val_mults)


def _expected_sample_seconds(topo_name: str, n_dims: int, n_values_total: int) -> int:
    """Heuristic timeout — diamond/multi-dim/high-card need more time."""
    base = 2400 if topo_name in ("diamond", "mirror4") else 1500
    if n_dims > 1:
        base = int(base * 1.5)
    if n_values_total > 5:
        base = int(base * 1.3)
    return base


def generate_graph(topo_name: str, topo: dict, sparsity: dict, seed: int,
                   *, name_suffix: str = "",
                   primary_dim_override: dict | None = None,
                   extra_dims: list | None = None) -> dict:
    """Generate a truth YAML dict for one graph.

    name_suffix: appended to default level-based prefix to disambiguate
                 variants sharing a base topology + sparsity (e.g. multi-dim).
    primary_dim_override: replaces the default synth-channel dim entirely.
    extra_dims: additional context_dimensions appended after the primary.
    """
    level = sparsity["level"]
    full_level = f"{level}-{name_suffix}" if name_suffix else level
    prefix = f"synth-{topo_name}-{full_level}"
    n_days = 100

    import copy
    edge_ids = list(topo["edges"].keys())

    # Build primary context dim. Lifecycle variants use a distinct dim id
    # because their labels differ from random-sparsity variants — sharing
    # the same id would corrupt DB rows across truths.
    if primary_dim_override is not None:
        ctx_dim = copy.deepcopy(primary_dim_override)
        primary_mults = {
            "synth-segment": SEGMENT_MULTS,
            "synth-device": DEVICE_MULTS,
        }.get(ctx_dim["id"], {})
    else:
        ctx_dim = copy.deepcopy(CONTEXT_DIM_BASE)
        if "values_override" in sparsity:
            ctx_dim["id"] = "synth-channel-lifecycle"
            for i, vo in enumerate(sparsity["values_override"]):
                for k, v in vo.items():
                    ctx_dim["values"][i][k] = v
        primary_mults = CHANNEL_MULTS
    _apply_mults(ctx_dim, primary_mults, edge_ids, prefix)

    dims = [ctx_dim]
    if extra_dims:
        for ed in extra_dims:
            ed_copy = copy.deepcopy(ed)
            secondary_mults = {
                "synth-device": DEVICE_MULTS,
                "synth-segment": SEGMENT_MULTS,
            }.get(ed_copy["id"], {})
            _apply_mults(ed_copy, secondary_mults, edge_ids, prefix)
            dims.append(ed_copy)

    # Prefix edge keys
    edges = {f"{prefix}-{eid}": dict(edef) for eid, edef in topo["edges"].items()}

    # Prefix node event_ids
    nodes = {}
    for nid, ndef in topo["nodes"].items():
        nd = dict(ndef)
        nd["event_id"] = f"{prefix}-{nid}"
        nodes[nid] = nd

    thresholds, per_slice = _widen_thresholds(level)
    n_values_total = sum(len(d["values"]) for d in dims)

    truth = {
        "simulation": {
            "mean_daily_traffic": sparsity.get("mean_daily_traffic", 500),
            "n_days": n_days,
            "user_kappa": 50,
            "failure_rate": 0.05,
            "drift_sigma": 0.0,
            "seed": seed,
            "expected_sample_seconds": _expected_sample_seconds(
                topo_name, len(dims), n_values_total),
        },
        "emit_context_slices": True,
        "context_dimensions": dims,
        "edges": edges,
        "nodes": nodes,
        "graph": {
            "name": prefix,
            "description": f"Sparsity sweep: {topo_name} topology, {sparsity['label']}"
                           + (f" [{name_suffix}]" if name_suffix else ""),
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


def _write_truth(truth: dict, generated: list) -> None:
    name = truth["graph"]["name"]
    path = os.path.join(OUT_DIR, f"{name}.truth.yaml")
    with open(path, "w") as f:
        f.write(f"# {truth['graph']['description']}\n")
        f.write(f"# Generated by generate_sparsity_sweep.py\n\n")
        yaml.dump(truth, f, default_flow_style=False, sort_keys=False,
                  allow_unicode=True)
    generated.append(name)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    seed = 100
    generated = []

    # ── Tier 0: original sweep ── solo / abc / diamond × 6 configs (18 graphs)
    base_configs = RANDOM_SPARSITY + [LIFECYCLE_CONFIG, LIFECYCLE_SPARSE_CONFIG]
    for topo_name in ("solo", "abc", "diamond"):
        topo = TOPOS[topo_name]
        for sparsity in base_configs:
            _write_truth(generate_graph(topo_name, topo, sparsity, seed), generated)
            seed += 1

    # ── Tier 1: multi-dim contexted × graded sparsity ── 8 graphs
    # synth-channel × synth-device, applied to abc + diamond at all 4 levels.
    # Stresses orthogonal-slice paths (defects 1-4 territory): aggregate
    # exhaustiveness, per-slice Multinomial union, upstream latency reuse.
    for topo_name in ("abc", "diamond"):
        topo = TOPOS[topo_name]
        for sparsity in RANDOM_SPARSITY:
            _write_truth(
                generate_graph(topo_name, topo, sparsity, seed,
                               name_suffix="2dim",
                               extra_dims=[SECONDARY_DIM_BASE]),
                generated)
            seed += 1

    # ── Tier 2: high-cardinality contexted × moderate/extreme sparsity ── 4 graphs
    # 5-value synth-segment dim, at sparse-2 and sparse-4. Tests Multinomial
    # scaling and aggregate suppression with more cells per edge.
    high_card_levels = [s for s in RANDOM_SPARSITY if s["level"] in ("sparse-2", "sparse-4")]
    for topo_name in ("abc", "diamond"):
        topo = TOPOS[topo_name]
        for sparsity in high_card_levels:
            _write_truth(
                generate_graph(topo_name, topo, sparsity, seed,
                               name_suffix="hicard",
                               primary_dim_override=HIGH_CARD_DIM_BASE),
                generated)
            seed += 1

    # ── Tier 3: extra topologies × graded sparsity ── 8 graphs
    # fanout (siblings into siblings) + mirror4 (4-step linear chain), each
    # at all 4 sparsity levels. Tests orthogonal-slice fixes on shapes
    # other than diamond.
    for topo_name in ("fanout", "mirror4"):
        topo = TOPOS[topo_name]
        for sparsity in RANDOM_SPARSITY:
            _write_truth(generate_graph(topo_name, topo, sparsity, seed), generated)
            seed += 1

    # ── Tier 4: orth-context × lifecycle ── 4 graphs
    # Multi-dim (synth-channel-lifecycle × synth-device) where the channel
    # dim has the early-stop / late-start lifecycle pattern (A throughout,
    # B stops day 65, C starts day 33), and synth-device runs throughout.
    # Covers the user's "two candidate experiments alongside a control"
    # scenario in an orth-context setting. Both pure-lifecycle and
    # lifecycle+random-sparsity, applied to abc + diamond.
    for topo_name in ("abc", "diamond"):
        topo = TOPOS[topo_name]
        for sparsity in (LIFECYCLE_CONFIG, LIFECYCLE_SPARSE_CONFIG):
            _write_truth(
                generate_graph(topo_name, topo, sparsity, seed,
                               name_suffix="2dim",
                               extra_dims=[SECONDARY_DIM_BASE]),
                generated)
            seed += 1

    print(f"Generated {len(generated)} truth YAMLs in {OUT_DIR}:")
    for name in generated:
        print(f"  {name}")


if __name__ == "__main__":
    main()
