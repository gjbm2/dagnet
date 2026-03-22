#!/usr/bin/env python3
"""
Monte Carlo synthetic data generator for Bayes parameter recovery testing.

Simulates a population traversing a DAG with known ground-truth parameters,
producing snapshot-format trajectory data that feeds directly into the
evidence binding pipeline.

Usage:
    . graph-editor/venv/bin/activate
    cd bayes

    # Generate + write to snapshot DB (uses real core hashes, FE-visible)
    python synth_gen.py --graph branch

    # Dry run (print summary, don't write to DB)
    python synth_gen.py --graph branch --dry-run

    # Custom simulation size with noise controls
    python synth_gen.py --graph branch --people 10000 --days 200 --kappa 15

    # Enable random-walk drift on p
    python synth_gen.py --graph branch --drift 0.02

    # Clean up synthetic data (by core_hash)
    python synth_gen.py --clean --graph branch

Output format matches _query_snapshot_subjects return shape so
bind_snapshot_evidence can consume it directly.

See doc 17 for design rationale.
"""
from __future__ import annotations

import base64
import bisect
import hashlib
import os
import sys
import json
import math
import yaml
import argparse
import numpy as np
from datetime import datetime, timedelta
from collections import defaultdict
from typing import Any

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "bayes"))


# ---------------------------------------------------------------------------
# Graph + truth config loading
# ---------------------------------------------------------------------------

# Edge configs with real FE-computed core hashes (matching test_harness.py).
# Format: (param_id, edge_uuid, window_core_hash, cohort_core_hash)
GRAPH_CONFIGS: dict[str, dict[str, Any]] = {
    "simple": {
        "graph_file": "bayes-test-gm-rebuild.json",
        "graph_id": "graph-bayes-test-gm-rebuild",
        "edges": [
            ("bayes-test-create-to-delegated",      "c64ddc4d-c369-4ae8-a44a-398a63a46ab1", "UaWTiPJp1kTXTlkigKzBAQ", "1npRXxdOjD56XTgKnZKbsw"),
            ("bayes-test-delegated-to-registered",   "7bb83fbf-3ac6-4152-a395-a8b64a12506a", "ES2r-ClxqBl4VQQqYdfYYg", "YSX41CZhnZKsP49i80jjTg"),
            ("bayes-test-landing-to-created",        "b91c2820-7a1d-4498-9082-5967b5027d76", "SXVK13yfsOIpXc4RQSv2GA", "yHCQevqcdyITym82h-uwdQ"),
            ("bayes-test-registered-to-success",     "97b11265-1242-4fa8-a097-359f2384665a", "VTgXES1p_XdQoHMZ7VsEoA", "XiDhZpbnp535eBHiPu614w"),
        ],
        "base_date": "2025-11-19",
    },
    "branch": {
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
        "base_date": "2025-11-01",
    },
    "diamond": {
        "graph_file": "synth-diamond-test.json",
        "graph_id": "graph-synth-diamond-test",
        "edges": [
            ("synth-anchor-to-gate",   "a2bdb15c-a828-45e3-9af3-0ec414ab709d", "SYNTH-anchor-to-gate-w",   "SYNTH-anchor-to-gate-c"),
            ("synth-gate-to-path-a",   "273f7315-a626-4440-8ce4-89cd9225bf43", "SYNTH-gate-to-path-a-w",   "SYNTH-gate-to-path-a-c"),
            ("synth-gate-to-path-b",   "dbe5585c-7669-4cf8-ab33-8ed294db80ea", "SYNTH-gate-to-path-b-w",   "SYNTH-gate-to-path-b-c"),
            ("synth-path-a-to-join",   "c41a7e20-5f33-4d9a-b1c2-3e8f7a6d9b04", "SYNTH-path-a-to-join-w",   "SYNTH-path-a-to-join-c"),
            ("synth-path-b-to-join",   "2901e1fd-640b-4bd7-b028-af458e3b0cbe", "SYNTH-path-b-to-join-w",   "SYNTH-path-b-to-join-c"),
            ("synth-join-to-outcome",  "7abcdf0c-e6a5-4ccd-81db-4fb1116ebe2c", "SYNTH-join-to-outcome-w",  "SYNTH-join-to-outcome-c"),
        ],
        "base_date": "2025-12-12",
    },
}


def _resolve_data_repo() -> str:
    conf_path = os.path.join(REPO_ROOT, ".private-repos.conf")
    if not os.path.exists(conf_path):
        print("ERROR: .private-repos.conf not found")
        sys.exit(1)
    for line in open(conf_path):
        line = line.strip()
        if line.startswith("DATA_REPO_DIR="):
            return os.path.join(REPO_ROOT, line.split("=", 1)[1].strip().strip('"'))
    print("ERROR: DATA_REPO_DIR not found")
    sys.exit(1)


def _load_db_connection() -> str:
    env_path = os.path.join(REPO_ROOT, "graph-editor", ".env.local")
    if os.path.exists(env_path):
        for line in open(env_path):
            line = line.strip()
            if line.startswith("DB_CONNECTION="):
                return line.split("=", 1)[1].strip().strip('"')
    return ""


def _sha256_hex(text: str) -> str:
    """SHA-256 of UTF-8 bytes, full hex digest. Matches FE hashText()."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _short_hash(canonical: str) -> str:
    """SHA-256 → first 16 bytes → base64url (no padding).

    Matches coreHashService.ts computeShortCoreHash() and
    snapshot_service.py short_core_hash_from_canonical_signature().
    """
    digest = hashlib.sha256(canonical.strip().encode("utf-8")).digest()[:16]
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def compute_core_hashes(
    graph_snapshot: dict,
    topology,
    data_repo: str,
) -> dict[str, dict[str, str]]:
    """Compute real FE-compatible core hashes for each edge.

    Replicates the FE's querySignature.ts → coreHashService.ts pipeline:
    1. Build coreCanonical JSON (connection, event_ids, event_def_hashes,
       query, latency_parameter, etc.)
    2. coreHash = sha256(coreCanonical).hex()
    3. structuredSig = JSON.stringify({c: coreHash, x: {}})
    4. core_hash = sha256(structuredSig)[:16] → base64url

    Two hashes per edge: window (cohort_mode=false) and cohort (cohort_mode=true).

    Returns dict[param_id → {window_hash, cohort_hash}].
    """
    # Build node lookups
    nodes_by_id = {n["id"]: n for n in graph_snapshot.get("nodes", [])}
    nodes_by_uuid = {n["uuid"]: n for n in graph_snapshot.get("nodes", [])}

    def find_node(ref: str) -> dict | None:
        return nodes_by_id.get(ref) or nodes_by_uuid.get(ref)

    # Load event definitions from data repo
    event_defs: dict[str, dict] = {}
    events_dir = os.path.join(data_repo, "events")
    if os.path.isdir(events_dir):
        for fname in os.listdir(events_dir):
            if fname.endswith(".yaml"):
                with open(os.path.join(events_dir, fname)) as f:
                    edef = yaml.safe_load(f) or {}
                    if edef.get("id"):
                        event_defs[edef["id"]] = edef

    result: dict[str, dict[str, str]] = {}

    for edge_id, et in topology.edges.items():
        pid = et.param_id
        if not pid:
            continue

        # Find the graph edge object
        edge = None
        for e in graph_snapshot.get("edges", []):
            if e["uuid"] == edge_id:
                edge = e
                break
        if not edge:
            continue

        query = edge.get("query", "")
        lat = edge.get("p", {}).get("latency", {})
        has_latency = lat.get("latency_parameter", False)

        # Resolve event_ids from from/to nodes via query
        from_node = find_node(et.from_node)
        to_node = find_node(et.to_node)
        from_event_id = from_node.get("event_id", "") if from_node else ""
        to_event_id = to_node.get("event_id", "") if to_node else ""

        # Latency anchor event_id
        anchor_node_id = lat.get("anchor_node_id", "")
        anchor_node = find_node(anchor_node_id) if anchor_node_id else None
        latency_anchor_event_id = anchor_node.get("event_id", "") if anchor_node else ""

        # Event definition hashes
        # The FE's buildDslFromEdge only loads event defs for from/to nodes.
        # The latency anchor event is NOT loaded by buildDslFromEdge, so
        # querySignature.ts falls back to "not_loaded" for it.
        # We must match this behaviour exactly.
        loaded_event_ids = {from_event_id, to_event_id}  # what buildDslFromEdge loads
        all_event_ids = [eid for eid in [from_event_id, to_event_id, latency_anchor_event_id] if eid]
        event_def_hashes: dict[str, str] = {}
        for eid in all_event_ids:
            if eid not in loaded_event_ids:
                event_def_hashes[eid] = "not_loaded"
                continue
            edef = event_defs.get(eid)
            if edef:
                normalized = {
                    "id": edef.get("id"),
                    "provider_event_names": edef.get("provider_event_names", {}),
                    "amplitude_filters": edef.get("amplitude_filters", []),
                }
                event_def_hashes[eid] = _sha256_hex(json.dumps(normalized, separators=(",", ":")))
            else:
                event_def_hashes[eid] = "not_loaded"

        # Normalise query: replace node IDs with event IDs
        normalized_query = query
        for node in graph_snapshot.get("nodes", []):
            nid = node.get("id", "")
            eid = node.get("event_id", "")
            if nid and eid:
                normalized_query = normalized_query.replace(nid, eid)

        # Compute window hash (cohort_mode=false) and cohort hash (cohort_mode=true)
        hashes: dict[str, str] = {}
        for mode_name, cohort_mode in [("window_hash", False), ("cohort_hash", True)]:
            # The FE's buildDslFromEdge only sets cohort_anchor_event_id when
            # the DSL explicitly names an anchor node (e.g. cohort(nodeId,...)).
            # Our dataInterestsDSL uses cohort(date:date) without a node ref,
            # so the FE leaves anchor_event_id as "".
            cohort_anchor = ""

            core_canonical = json.dumps({
                "connection": "amplitude",
                "from_event_id": from_event_id,
                "to_event_id": to_event_id,
                "visited_event_ids": [],
                "exclude_event_ids": [],
                "event_def_hashes": event_def_hashes,
                "event_filters": {},
                "case": [],
                "cohort_mode": cohort_mode,
                "cohort_anchor_event_id": cohort_anchor,
                "latency_parameter": has_latency,
                "latency_anchor_event_id": latency_anchor_event_id,
                "original_query": normalized_query,
            }, separators=(",", ":"))

            core_hash_hex = _sha256_hex(core_canonical)

            # Structured signature (no context keys for synthetic data)
            structured_sig = json.dumps({
                "c": core_hash_hex,
                "x": {},
            }, separators=(",", ":"))

            hashes[mode_name] = _short_hash(structured_sig)
            # Also store the structured sig for parameter file query_signature
            sig_key = mode_name.replace("_hash", "_sig")
            hashes[sig_key] = structured_sig

        result[pid] = hashes
        # Also store with parameter- prefix
        if not pid.startswith("parameter-"):
            result[f"parameter-{pid}"] = hashes

    return result


def _build_hash_lookup(gcfg: dict) -> dict[str, dict[str, str]]:
    """Build param_id → {window_hash, cohort_hash} from GRAPH_CONFIGS edges."""
    lookup: dict[str, dict[str, str]] = {}
    for param_id, _edge_uuid, window_hash, cohort_hash in gcfg.get("edges", []):
        lookup[param_id] = {"window_hash": window_hash, "cohort_hash": cohort_hash}
        # Also store with parameter- prefix for topology param_id matching
        if not param_id.startswith("parameter-"):
            lookup[f"parameter-{param_id}"] = lookup[param_id]
    return lookup


def load_truth_config(truth_path: str) -> dict:
    """Load ground-truth config from .truth.yaml sidecar."""
    with open(truth_path) as f:
        return yaml.safe_load(f)


def derive_truth_from_graph(graph_snapshot: dict, topology) -> dict:
    """Derive ground-truth parameters from graph edge metadata.

    Uses existing analytic estimates (probability, latency) as the
    ground truth. For edges without latency, uses defaults.
    """
    edges_by_uuid = {e["uuid"]: e for e in graph_snapshot.get("edges", [])}

    truth: dict[str, Any] = {"edges": {}}
    for edge_id, et in topology.edges.items():
        edge = edges_by_uuid.get(edge_id, {})
        p_block = edge.get("p", {})

        # Probability: from bayesParams (fitted), p.mean, or p.probability
        bayes = p_block.get("bayesParams", {})
        p_val = bayes.get("mean") or p_block.get("mean") or p_block.get("probability")
        if p_val is None or p_val <= 0:
            p_val = 0.5

        # Latency
        lat = p_block.get("latency", {})
        onset = lat.get("onset_delta_days", 0.0) or 0.0
        mu = lat.get("mu")
        sigma = lat.get("sigma")

        if mu is None or sigma is None:
            median_lag = lat.get("median_lag_days")
            if median_lag and median_lag > onset + 0.01:
                mu = math.log(max(median_lag - onset, 0.01))
                sigma = 0.7
            else:
                t95 = lat.get("t95")
                if t95 and t95 > onset:
                    mu = math.log(t95 - onset) - 1.645 * 0.7
                    sigma = 0.7
                else:
                    mu = 1.0
                    sigma = 0.5

        truth["edges"][et.param_id] = {
            "p": float(p_val),
            "onset": float(onset),
            "mu": float(mu),
            "sigma": float(max(sigma, 0.01)),
        }

    return truth


# ---------------------------------------------------------------------------
# Simulation config defaults
# ---------------------------------------------------------------------------

DEFAULT_SIM_CONFIG = {
    "mean_daily_traffic": 5000,
    "n_days": 100,
    "kappa_sim_default": 50.0,     # moderate overdispersion (Beta-Binomial)
    "failure_rate": 0.05,          # 5% of fetch nights fail
    "drift_sigma": 0.0,           # random-walk drift disabled by default
    "seed": 42,
}


def _get_sim_config(truth: dict, cli_overrides: dict) -> dict:
    """Merge simulation config from truth config + CLI overrides."""
    cfg = dict(DEFAULT_SIM_CONFIG)
    # Truth config overrides defaults
    if "simulation" in truth:
        for k, v in truth["simulation"].items():
            if k in cfg:
                cfg[k] = v
    # CLI overrides everything
    for k, v in cli_overrides.items():
        if v is not None and k in cfg:
            cfg[k] = v
    return cfg


# ---------------------------------------------------------------------------
# Core simulation
# ---------------------------------------------------------------------------

def simulate_graph(
    graph_snapshot: dict,
    topology,
    truth: dict,
    sim_config: dict,
    hash_lookup: dict[str, dict[str, str]],
) -> tuple[dict[str, list[dict]], dict]:
    """Simulate population traversal and return snapshot-format rows.

    Returns (snapshot_rows, sim_stats) where:
    - snapshot_rows: dict[edge_id → list[row_dict]] consumable by
      bind_snapshot_evidence
    - sim_stats: summary statistics for reporting
    """
    n_days = sim_config["n_days"]
    mean_daily_traffic = sim_config["mean_daily_traffic"]
    kappa_default = sim_config["kappa_sim_default"]
    drift_sigma = sim_config["drift_sigma"]
    failure_rate = sim_config["failure_rate"]
    seed = sim_config["seed"]
    base_date_str = sim_config.get("base_date", "2025-11-01")
    base_date = datetime.strptime(base_date_str, "%Y-%m-%d")

    rng = np.random.default_rng(seed)

    # --- Resolve edge params from truth config ---
    edge_params: dict[str, dict] = {}  # edge_id → {p, onset, mu, sigma, kappa_sim}
    for edge_id, et in topology.edges.items():
        pid = et.param_id
        found = truth.get("edges", {}).get(pid)
        if not found:
            bare = pid.replace("parameter-", "") if pid.startswith("parameter-") else pid
            found = truth.get("edges", {}).get(bare)
        if found:
            ep = dict(found)
        else:
            ep = {"p": 0.5, "onset": 0.0, "mu": 1.0, "sigma": 0.5}
        ep.setdefault("kappa_sim", kappa_default)
        edge_params[edge_id] = ep

    # --- Build adjacency ---
    adj_out: dict[str, list[str]] = defaultdict(list)
    for eid, et in topology.edges.items():
        adj_out[et.from_node].append(eid)

    # --- Branch groups ---
    edge_to_bg: dict[str, str] = {}
    for bg in topology.branch_groups.values():
        for sib_id in bg.sibling_edge_ids:
            edge_to_bg[sib_id] = bg.group_id

    # --- Random-walk drift (logit scale, per-edge) ---
    # drift_path[edge_id] = array of n_days logit offsets
    drift_paths: dict[str, np.ndarray] = {}
    if drift_sigma > 0:
        for edge_id in edge_params:
            increments = rng.normal(0.0, drift_sigma, size=n_days)
            drift_paths[edge_id] = np.cumsum(increments)
    else:
        zero_path = np.zeros(n_days)
        for edge_id in edge_params:
            drift_paths[edge_id] = zero_path

    # --- Person-level simulation ---
    # arrivals_by_day[day_idx] = list of {node_id: t_arrival}
    # actual_traffic[day_idx] = int (actual people that day)
    arrivals_by_day: list[list[dict[str, float]]] = []
    actual_traffic: list[int] = []

    for day_idx in range(n_days):
        n_people = int(rng.poisson(mean_daily_traffic))
        actual_traffic.append(n_people)

        # Draw day-specific effective probabilities per edge:
        # 1. Apply drift: p_drifted = logistic(logit(p_true) + drift)
        # 2. Apply overdispersion: p_eff ~ Beta(p_drifted * kappa, (1 - p_drifted) * kappa)
        day_probs: dict[str, float] = {}
        for eid, ep in edge_params.items():
            p_true = ep["p"]
            kappa = ep["kappa_sim"]

            # Drift
            drift_offset = drift_paths[eid][day_idx]
            if abs(drift_offset) > 1e-9:
                logit_p = math.log(p_true / (1 - p_true)) + drift_offset
                p_drifted = 1.0 / (1.0 + math.exp(-logit_p))
            else:
                p_drifted = p_true

            # Overdispersion: Beta draw
            alpha = p_drifted * kappa
            beta_param = (1.0 - p_drifted) * kappa
            # Guard against degenerate alpha/beta
            alpha = max(alpha, 0.001)
            beta_param = max(beta_param, 0.001)
            p_eff = float(rng.beta(alpha, beta_param))
            day_probs[eid] = p_eff

        # Simulate each person
        day_arrivals: list[dict[str, float]] = []
        for _ in range(n_people):
            person: dict[str, float] = {}
            _traverse(
                topology.anchor_node_id, 0.0, person,
                topology, adj_out, edge_params, day_probs,
                edge_to_bg, rng,
            )
            day_arrivals.append(person)

        arrivals_by_day.append(day_arrivals)

    # --- Pre-aggregate arrival times for fast observation generation ---
    # sorted_times[day_idx][node_id] = sorted list of arrival times
    # sorted_edge_times[day_idx][edge_id] = sorted arrival times for
    #   people who traversed that specific edge (needed for correct
    #   per-edge counts at join nodes)
    sorted_times: list[dict[str, list[float]]] = []
    sorted_edge_times: list[dict[str, list[float]]] = []
    all_nodes = set()
    for et in topology.edges.values():
        all_nodes.add(et.from_node)
        all_nodes.add(et.to_node)
    all_nodes.add(topology.anchor_node_id)

    all_edge_ids = [eid for eid in topology.edges if topology.edges[eid].param_id]

    for day_idx in range(n_days):
        day_sorted: dict[str, list[float]] = {}
        for nid in all_nodes:
            times = [p[nid] for p in arrivals_by_day[day_idx] if nid in p]
            times.sort()
            day_sorted[nid] = times
        sorted_times.append(day_sorted)

        day_edge_sorted: dict[str, list[float]] = {}
        for eid in all_edge_ids:
            key = f"edge:{eid}"
            times = [p[key] for p in arrivals_by_day[day_idx] if key in p]
            times.sort()
            day_edge_sorted[eid] = times
        sorted_edge_times.append(day_edge_sorted)

    # --- Per-edge daily aggregates (for parameter file values[]) ---
    # Computed before freeing arrivals_by_day.
    # For each edge: n_daily[d] = people reaching from_node on day d,
    #                k_daily[d] = people who traversed this edge on day d
    edge_daily: dict[str, dict] = {}  # edge_id → {n_daily, k_daily, dates}
    for edge_id, et in topology.edges.items():
        if not et.param_id:
            continue
        n_daily = []
        k_daily = []
        dates = []
        for day_idx in range(n_days):
            day_date = base_date + timedelta(days=day_idx)
            dates.append(day_date.strftime("%-d-%b-%y"))
            from_times = sorted_times[day_idx].get(et.from_node, [])
            edge_times = sorted_edge_times[day_idx].get(edge_id, [])
            n_daily.append(len(from_times))
            k_daily.append(len(edge_times))
        edge_daily[edge_id] = {
            "n_daily": n_daily,
            "k_daily": k_daily,
            "dates": dates,
        }

    # Free the raw person data now — we only need sorted_times
    del arrivals_by_day

    # --- Generate observations via nightly fetch model ---
    snapshot_rows = _generate_observations_nightly(
        topology, sorted_times, sorted_edge_times, actual_traffic,
        hash_lookup, n_days, base_date, failure_rate, rng,
    )

    # --- Simulation stats ---
    total_rows = sum(len(v) for v in snapshot_rows.values())
    sim_stats = {
        "n_days": n_days,
        "mean_daily_traffic": mean_daily_traffic,
        "actual_traffic_range": (min(actual_traffic), max(actual_traffic)),
        "kappa_default": kappa_default,
        "failure_rate": failure_rate,
        "drift_sigma": drift_sigma,
        "total_rows": total_rows,
        "base_date": base_date_str,
        "edge_daily": edge_daily,
    }

    return snapshot_rows, sim_stats


def _traverse(
    node_id: str,
    t_current: float,
    person: dict[str, float],
    topology,
    adj_out: dict[str, list[str]],
    edge_params: dict[str, dict],
    day_probs: dict[str, float],
    edge_to_bg: dict[str, str],
    rng: np.random.Generator,
) -> None:
    """Recursively traverse the DAG for one person.

    Uses day_probs (daily effective probabilities after drift +
    overdispersion) for conversion draws, and edge_params for latency.
    """
    person[node_id] = t_current

    outbound = adj_out.get(node_id, [])
    if not outbound:
        return

    # Group outbound edges by branch group
    bg_grouped: dict[str, list[str]] = defaultdict(list)
    solo_edges: list[str] = []
    for eid in outbound:
        bg_id = edge_to_bg.get(eid)
        if bg_id is not None:
            bg_grouped[bg_id].append(eid)
        else:
            solo_edges.append(eid)

    # Branch groups: Multinomial draw — one branch per person
    for _bg_id, siblings in bg_grouped.items():
        evented = [eid for eid in siblings if topology.edges[eid].param_id]
        unevented = [eid for eid in siblings if not topology.edges[eid].param_id]

        evented_probs = [day_probs[eid] for eid in evented]
        dropout = max(0.0, 1.0 - sum(evented_probs))

        all_probs = evented_probs + [dropout]
        s = sum(all_probs)
        if s > 0:
            all_probs = [p / s for p in all_probs]
        else:
            all_probs = [1.0 / len(all_probs)] * len(all_probs)

        choice = rng.choice(len(all_probs), p=all_probs)
        if choice < len(evented):
            chosen_eid = evented[choice]
            _take_edge(chosen_eid, t_current, person, topology,
                       adj_out, edge_params, day_probs, edge_to_bg, rng)
        elif unevented:
            chosen_eid = rng.choice(unevented)
            et = topology.edges[chosen_eid]
            person[et.to_node] = t_current

    # Solo edges: independent Bernoulli
    for eid in solo_edges:
        p = day_probs[eid]
        if rng.random() < p:
            _take_edge(eid, t_current, person, topology,
                       adj_out, edge_params, day_probs, edge_to_bg, rng)


def _take_edge(
    edge_id: str,
    t_current: float,
    person: dict[str, float],
    topology,
    adj_out, edge_params, day_probs, edge_to_bg, rng,
) -> None:
    """Person takes an edge: draw latency, record arrival, recurse.

    Records both node arrival (node_id → t) and edge traversal
    (edge:<edge_id> → t_arrival) so per-edge counts work at joins.
    """
    et = topology.edges[edge_id]
    params = edge_params[edge_id]

    mu = params.get("mu", 0.0)
    sigma = params.get("sigma", 0.0)
    onset = params.get("onset", 0.0)
    if sigma > 0.001:
        latency = onset + rng.lognormal(mu, sigma)
    else:
        latency = 0.0

    t_arrival = t_current + latency
    person[f"edge:{edge_id}"] = t_arrival
    _traverse(et.to_node, t_arrival, person, topology,
              adj_out, edge_params, day_probs, edge_to_bg, rng)


# ---------------------------------------------------------------------------
# Observation generation — nightly fetch model
# ---------------------------------------------------------------------------

def _count_by_age(sorted_arrivals: list[float], age: float) -> int:
    """Count arrivals at or before the given age using binary search."""
    return bisect.bisect_right(sorted_arrivals, age)


def _generate_observations_nightly(
    topology,
    sorted_times: list[dict[str, list[float]]],
    sorted_edge_times: list[dict[str, list[float]]],
    actual_traffic: list[int],
    hash_lookup: dict[str, dict[str, str]],
    n_days: int,
    base_date: datetime,
    failure_rate: float,
    rng: np.random.Generator,
) -> dict[str, list[dict]]:
    """Generate snapshot rows using nightly fetch simulation.

    For each fetch night t (1..n_days), observes all anchor_days d < t.
    Retrieval age = t - d. Fetch nights fail with probability failure_rate.

    Uses sorted_edge_times for per-edge y counts (correct at joins where
    multiple edges feed the same to_node).
    Uses real core hashes from hash_lookup for FE visibility.
    """
    result: dict[str, list[dict]] = defaultdict(list)

    # Pre-resolve hashes per edge
    edge_hashes: dict[str, tuple[str, str]] = {}  # edge_id → (window_hash, cohort_hash)
    for edge_id, et in topology.edges.items():
        pid = et.param_id
        hashes = hash_lookup.get(pid)
        if not hashes:
            bare = pid.replace("parameter-", "") if pid.startswith("parameter-") else pid
            hashes = hash_lookup.get(bare)
        if hashes:
            edge_hashes[edge_id] = (hashes["window_hash"], hashes["cohort_hash"])
        else:
            # Fallback: synthetic hash (won't be FE-visible but still
            # consumable by test harness with explicit hash config)
            edge_hashes[edge_id] = (f"SYNTH-{pid}-w", f"SYNTH-{pid}-c")

    # Nightly fetch loop
    for fetch_night in range(1, n_days + 1):
        # Fetch failure
        if failure_rate > 0 and rng.random() < failure_rate:
            continue

        retrieved_at = (base_date + timedelta(days=fetch_night)).strftime(
            "%Y-%m-%d 02:00:00"
        )

        for day_idx in range(fetch_night):
            age = fetch_night - day_idx  # retrieval age in days
            if age < 1:
                continue

            anchor_day = (base_date + timedelta(days=day_idx)).strftime("%Y-%m-%d")
            n_people = actual_traffic[day_idx]
            day_sorted = sorted_times[day_idx]

            day_edge_sorted = sorted_edge_times[day_idx]

            for edge_id, et in topology.edges.items():
                if not et.param_id:
                    continue  # unevented edge

                pid = et.param_id
                w_hash, c_hash = edge_hashes[edge_id]
                from_times = day_sorted.get(et.from_node, [])
                edge_times = day_edge_sorted.get(edge_id, [])

                # Window observation: denominator = arrivals at from_node by age,
                # numerator = per-edge conversions by age (correct at joins)
                x_count = _count_by_age(from_times, age)
                y_window = _count_by_age(edge_times, age)

                if x_count > 0:
                    result[edge_id].append({
                        "param_id": pid,
                        "core_hash": w_hash,
                        "slice_key": "window()",
                        "anchor_day": anchor_day,
                        "retrieved_at": retrieved_at,
                        "a": None,
                        "x": x_count,
                        "y": y_window,
                        "median_lag_days": None,
                        "mean_lag_days": None,
                        "onset_delta_days": None,
                    })

                # Cohort observation: denominator = total people entering that day,
                # numerator = per-edge conversions by age (correct at joins)
                y_cohort = _count_by_age(edge_times, age)

                result[edge_id].append({
                    "param_id": pid,
                    "core_hash": c_hash,
                    "slice_key": "cohort()",
                    "anchor_day": anchor_day,
                    "retrieved_at": retrieved_at,
                    "a": n_people,
                    "x": None,
                    "y": y_cohort,
                    "median_lag_days": None,
                    "mean_lag_days": None,
                    "onset_delta_days": None,
                })

    return dict(result)


# ---------------------------------------------------------------------------
# DB write
# ---------------------------------------------------------------------------

def write_to_snapshot_db(
    snapshot_rows: dict[str, list[dict]],
    db_connection: str,
    workspace_prefix: str = "",
    hash_lookup: dict[str, dict[str, str]] | None = None,
) -> dict[str, dict[str, str]]:
    """Write synthetic rows to snapshot DB using the existing snapshot_service.

    Cleans existing rows for the same core hashes first (idempotent).
    workspace_prefix: e.g. "nous-conversion-feature/bayes-test-graph" —
        prepended to param_ids as "${prefix}-${param_id}" to match the FE's
        buildDbParamId format.
    Returns dict[param_id → {window_hash, cohort_hash}] for test harness.
    """
    # Use the existing snapshot_service (same as FE fetch pipeline)
    lib_dir = os.path.join(REPO_ROOT, "graph-editor", "lib")
    ge_dir = os.path.join(REPO_ROOT, "graph-editor")
    if lib_dir not in sys.path:
        sys.path.insert(0, lib_dir)
    if ge_dir not in sys.path:
        sys.path.insert(0, ge_dir)
    os.environ["DB_CONNECTION"] = db_connection
    from lib.snapshot_service import append_snapshots, delete_snapshots

    # Group rows by (param_id, core_hash, slice_key, retrieved_at)
    # — each group becomes one append_snapshots call
    # Apply workspace prefix to param_ids (FE queries with prefixed IDs)
    from collections import defaultdict
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for edge_rows in snapshot_rows.values():
        for r in edge_rows:
            db_pid = f"{workspace_prefix}-{r['param_id']}" if workspace_prefix else r["param_id"]
            key = (db_pid, r["core_hash"], r["slice_key"], r["retrieved_at"])
            groups[key].append(r)

    # Clean existing data for all param_id + core_hash combos
    cleaned_combos: set[tuple[str, str]] = set()
    for (pid, ch, _sk, _ra) in groups:
        if (pid, ch) not in cleaned_combos:
            result = delete_snapshots(pid, core_hashes=[ch])
            if result["success"] and result["deleted"] > 0:
                print(f"  Cleaned {result['deleted']} existing rows for {pid}/{ch[:12]}…")
            cleaned_combos.add((pid, ch))

    # Insert via append_snapshots
    total_inserted = 0
    hash_map: dict[str, dict[str, str]] = {}

    for (pid, core_hash, slice_key, retrieved_at_str), rows in groups.items():
        # Parse retrieved_at regardless of separator (T or space)
        clean_ra = retrieved_at_str.replace("T", " ")
        retrieved_at = datetime.strptime(clean_ra, "%Y-%m-%d %H:%M:%S")

        # Build rows in append_snapshots format
        append_rows = []
        for r in rows:
            append_rows.append({
                "anchor_day": r["anchor_day"],
                "A": r.get("a"),
                "X": r.get("x"),
                "Y": r["y"],
                "median_lag_days": r.get("median_lag_days"),
                "mean_lag_days": r.get("mean_lag_days"),
                "onset_delta_days": r.get("onset_delta_days"),
            })

        # Resolve the real structured sig for registry parity.
        # The FE sends current_signatures from param file query_signature;
        # the registry canonical_signature must match for family grouping.
        bare_pid = pid.replace(f"{workspace_prefix}-", "") if workspace_prefix else pid
        sig_key = "window_sig" if "window" in slice_key else "cohort_sig"
        real_sig = (hash_lookup or {}).get(bare_pid, {}).get(sig_key)
        canonical = real_sig if real_sig else f"synthetic:{pid}:{slice_key}"

        result = append_snapshots(
            param_id=pid,
            canonical_signature=canonical,
            inputs_json={"synthetic": True, "generator": "synth_gen"},
            sig_algo="sig_v1_sha256_trunc128_b64url",
            slice_key=slice_key,
            retrieved_at=retrieved_at,
            rows=append_rows,
            core_hash=core_hash,
        )

        if result.get("success"):
            total_inserted += result.get("inserted", 0)
        else:
            print(f"  WARNING: append failed for {pid}/{slice_key}: {result}")

        # Build hash map
        if pid not in hash_map:
            hash_map[pid] = {}
        if "window" in slice_key:
            hash_map[pid]["window_hash"] = core_hash
        else:
            hash_map[pid]["cohort_hash"] = core_hash

    print(f"  Inserted {total_inserted} rows")
    return hash_map


def clean_synthetic_data(db_connection: str, gcfg: dict | None = None) -> None:
    """Remove synthetic data from snapshot DB using snapshot_service.

    If gcfg is provided, removes only rows matching that graph's core hashes.
    """
    lib_dir = os.path.join(REPO_ROOT, "graph-editor", "lib")
    ge_dir = os.path.join(REPO_ROOT, "graph-editor")
    if lib_dir not in sys.path:
        sys.path.insert(0, lib_dir)
    if ge_dir not in sys.path:
        sys.path.insert(0, ge_dir)
    os.environ["DB_CONNECTION"] = db_connection
    from lib.snapshot_service import delete_snapshots

    if not gcfg:
        print("No graph config — nothing to clean")
        return

    total_deleted = 0
    for pid, _eid, wh, ch in gcfg.get("edges", []):
        for core_hash in [wh, ch]:
            result = delete_snapshots(pid, core_hashes=[core_hash])
            if result["success"]:
                total_deleted += result["deleted"]

    print(f"Cleaned {total_deleted} rows for graph '{gcfg.get('graph_id', '?')}'")



# ---------------------------------------------------------------------------
# Data repo file generation
# ---------------------------------------------------------------------------

def _format_date_dmy(dt: datetime) -> str:
    """Format datetime as d-MMM-yy (e.g. 1-Nov-25)."""
    return dt.strftime("%-d-%b-%y")


def write_parameter_files(
    topology,
    truth: dict,
    sim_stats: dict,
    data_repo: str,
    graph_snapshot: dict,
    hash_lookup: dict[str, dict[str, str]] | None = None,
) -> list[str]:
    """Write/update parameter YAML files with simulated values[].

    For each evented edge, writes a parameter file containing:
    - Aggregate n, k, mean from the simulation
    - Per-day n_daily, k_daily, dates arrays
    - Latency block from ground truth
    - Query matching the edge's graph DSL
    - data_source marking this as synthetic

    Returns list of param_ids that were written.
    """
    edge_daily = sim_stats.get("edge_daily", {})
    base_date = datetime.strptime(sim_stats["base_date"], "%Y-%m-%d")
    n_days = sim_stats["n_days"]
    end_date = base_date + timedelta(days=n_days - 1)

    # Build node UUID → node id lookup from graph
    uuid_to_id: dict[str, str] = {}
    for n in graph_snapshot.get("nodes", []):
        uuid_to_id[n["uuid"]] = n.get("id", "")

    written = []
    for edge_id, et in topology.edges.items():
        pid = et.param_id
        if not pid:
            continue
        daily = edge_daily.get(edge_id)
        if not daily:
            continue

        # Get ground truth for this edge
        t = truth.get("edges", {}).get(pid, {})
        if not t:
            bare = pid.replace("parameter-", "") if pid.startswith("parameter-") else pid
            t = truth.get("edges", {}).get(bare, {})

        n_daily = daily["n_daily"]
        k_daily = daily["k_daily"]
        dates = daily["dates"]
        total_n = sum(n_daily)
        total_k = sum(k_daily)
        mean = total_k / total_n if total_n > 0 else 0.0

        # Build the query from node IDs (from(x).to(y))
        from_id = uuid_to_id.get(et.from_node, et.from_node)
        to_id = uuid_to_id.get(et.to_node, et.to_node)
        query = f"from({from_id}).to({to_id})"

        # Strip parameter- prefix for the file ID
        file_id = pid.replace("parameter-", "") if pid.startswith("parameter-") else pid

        # Compute median lag per day from the sorted arrival times
        # (not critical for snapshot path, but useful for FE display)
        onset = t.get("onset", 0.0)

        # Resolve anchor node ID for cohort DSL
        anchor_id = uuid_to_id.get(
            topology.anchor_node_id, topology.anchor_node_id
        )
        window_dsl = f"window({_format_date_dmy(base_date)}:{_format_date_dmy(end_date)})"
        cohort_dsl = f"cohort({anchor_id},{_format_date_dmy(base_date)}:{_format_date_dmy(end_date)})"
        now_str = datetime.now(tz=None).strftime("%Y-%m-%dT%H:%M:%SZ")

        # Window values[] entry
        window_entry: dict[str, Any] = {
            "mean": round(mean, 6),
            "n": total_n,
            "k": total_k,
            "n_daily": n_daily,
            "k_daily": k_daily,
            "dates": dates,
            "window_from": _format_date_dmy(base_date),
            "window_to": _format_date_dmy(end_date),
            "sliceDSL": window_dsl,
            "data_source": {
                "type": "synthetic",
                "retrieved_at": now_str,
                "full_query": query,
            },
            "forecast": round(mean, 6),
        }
        if hash_lookup and pid in hash_lookup and "window_sig" in hash_lookup[pid]:
            window_entry["query_signature"] = hash_lookup[pid]["window_sig"]

        # Cohort values[] entry (same daily data, different DSL + signature)
        cohort_entry: dict[str, Any] = {
            "mean": round(mean, 6),
            "n": total_n,
            "k": total_k,
            "n_daily": n_daily,
            "k_daily": k_daily,
            "dates": dates,
            "cohort_from": _format_date_dmy(base_date),
            "cohort_to": _format_date_dmy(end_date),
            "sliceDSL": cohort_dsl,
            "data_source": {
                "type": "synthetic",
                "retrieved_at": now_str,
                "full_query": query,
            },
            "forecast": round(mean, 6),
        }
        if hash_lookup and pid in hash_lookup and "cohort_sig" in hash_lookup[pid]:
            cohort_entry["query_signature"] = hash_lookup[pid]["cohort_sig"]

        param_data = {
            "id": file_id,
            "name": file_id,
            "type": "probability",
            "query": query,
            "query_overridden": False,
            "n_query_overridden": False,
            "values": [window_entry, cohort_entry],
            "latency": {
                "latency_parameter": et.has_latency,
                "anchor_node_id": uuid_to_id.get(
                    topology.anchor_node_id, topology.anchor_node_id
                ),
                "onset_delta_days": onset,
                "t95": round(onset + math.exp(t.get("mu", 1.0) + 1.645 * t.get("sigma", 0.5)), 1),
                "path_t95": round(onset + math.exp(t.get("mu", 1.0) + 1.645 * t.get("sigma", 0.5)), 1),
                "latency_parameter_overridden": False,
                "t95_overridden": False,
                "path_t95_overridden": False,
            },
            "metadata": {
                "description": f"Synthetic data (seed={sim_stats.get('seed', '?')}, "
                               f"n={sim_stats['mean_daily_traffic']}/day, "
                               f"days={n_days})",
                "created_at": datetime.now(tz=None).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "updated_at": datetime.now(tz=None).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "author": "synth_gen",
                "version": "1.0.0",
                "status": "active",
            },
        }

        param_path = os.path.join(data_repo, "parameters", f"{file_id}.yaml")
        with open(param_path, "w") as f:
            yaml.dump(param_data, f, default_flow_style=False, sort_keys=False,
                      allow_unicode=True)
        written.append(file_id)

    return written


def set_simulation_guard(
    graph_path: str,
    enable: bool = True,
    sim_stats: dict | None = None,
) -> None:
    """Set or clear the simulation flag on a graph JSON file.

    When simulation=true, the FE fetch planner returns empty fetch plans,
    preventing real Amplitude fetches from overwriting synthetic data.

    Also sets dataInterestsDSL and currentQueryDSL so the FE knows
    what date range the synthetic data covers.
    """
    with open(graph_path) as f:
        graph = json.load(f)

    if enable:
        graph["simulation"] = True
        graph["dailyFetch"] = False

        # Set the pinned DSL so the FE knows the data date range
        if sim_stats:
            base_date = datetime.strptime(sim_stats["base_date"], "%Y-%m-%d")
            n_days = sim_stats["n_days"]
            end_date = base_date + timedelta(days=n_days - 1)
            window_from = _format_date_dmy(base_date)
            window_to = _format_date_dmy(end_date)
            graph["dataInterestsDSL"] = f"window({window_from}:{window_to});cohort({window_from}:{window_to})"
            graph["currentQueryDSL"] = f"window({window_from}:{window_to})"
    else:
        graph.pop("simulation", None)
        graph.pop("dataInterestsDSL", None)
        graph.pop("currentQueryDSL", None)

    with open(graph_path, "w") as f:
        json.dump(graph, f, indent=2, ensure_ascii=False)
        f.write("\n")


def update_parameter_index(data_repo: str, param_ids: list[str]) -> None:
    """Ensure all param_ids have entries in parameters-index.yaml."""
    index_path = os.path.join(data_repo, "parameters-index.yaml")
    with open(index_path) as f:
        index_data = yaml.safe_load(f) or {}

    existing_ids = {p["id"] for p in index_data.get("parameters", [])}
    added = 0

    for pid in param_ids:
        if pid in existing_ids:
            continue
        index_data.setdefault("parameters", []).append({
            "id": pid,
            "file_path": f"parameters/{pid}.yaml",
            "name": pid,
            "status": "active",
            "type": "probability",
            "created_at": datetime.now(tz=None).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "updated_at": datetime.now(tz=None).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "author": "synth_gen",
            "version": "1.0.0",
        })
        added += 1

    if added > 0:
        with open(index_path, "w") as f:
            yaml.dump(index_data, f, default_flow_style=False, sort_keys=False,
                      allow_unicode=True)
        print(f"  Added {added} entries to parameters-index.yaml")
    else:
        print(f"  parameters-index.yaml already up to date")


def update_graph_edge_metadata(
    graph_path: str,
    topology,
    truth: dict,
    sim_stats: dict,
) -> None:
    """Update graph edge p blocks with simulated means and latency.

    Keeps the graph's inline data consistent with parameter files so the
    integrity checker's data-drift check passes.
    """
    edge_daily = sim_stats.get("edge_daily", {})

    with open(graph_path) as f:
        graph = json.load(f)

    # Build node UUID → node id lookup
    uuid_to_id: dict[str, str] = {}
    for n in graph.get("nodes", []):
        uuid_to_id[n["uuid"]] = n.get("id", "")

    edge_by_uuid = {e["uuid"]: e for e in graph.get("edges", [])}

    for edge_id, et in topology.edges.items():
        if not et.param_id:
            continue
        daily = edge_daily.get(edge_id)
        if not daily:
            continue

        total_n = sum(daily["n_daily"])
        total_k = sum(daily["k_daily"])
        mean = total_k / total_n if total_n > 0 else 0.0

        t = truth.get("edges", {}).get(et.param_id, {})
        if not t:
            bare = et.param_id.replace("parameter-", "") if et.param_id.startswith("parameter-") else et.param_id
            t = truth.get("edges", {}).get(bare, {})

        edge = edge_by_uuid.get(edge_id)
        if not edge:
            continue

        p = edge.setdefault("p", {})
        p["mean"] = round(mean, 6)
        p["n"] = total_n

        # Set query string at edge top level (FE reads edge.query, not edge.p.query)
        from_id = uuid_to_id.get(et.from_node, et.from_node)
        to_id = uuid_to_id.get(et.to_node, et.to_node)
        edge["query"] = f"from({from_id}).to({to_id})"

        # Update latency block if truth has it
        if t.get("mu") is not None:
            lat = p.setdefault("latency", {})
            lat["onset_delta_days"] = t.get("onset", 0.0)
            lat["path_t95"] = lat.get("t95", lat.get("path_t95"))
            onset = t.get("onset", 0.0)
            mu = t.get("mu", 1.0)
            sigma = t.get("sigma", 0.5)
            lat["t95"] = round(onset + math.exp(mu + 1.645 * sigma), 1)
            if "path_t95" not in lat or lat["path_t95"] is None:
                lat["path_t95"] = lat["t95"]

    with open(graph_path, "w") as f:
        json.dump(graph, f, indent=2, ensure_ascii=False)
        f.write("\n")


# ---------------------------------------------------------------------------
# Summary + recovery report
# ---------------------------------------------------------------------------

def print_summary(
    topology, truth: dict, snapshot_rows: dict[str, list[dict]],
    sim_stats: dict,
) -> None:
    """Print simulation summary."""
    print(f"\n{'='*70}")
    print("SYNTHETIC DATA SUMMARY")
    print(f"{'='*70}")

    # Simulation config
    print(f"  Days: {sim_stats['n_days']}  |  "
          f"Traffic: {sim_stats['mean_daily_traffic']}/day "
          f"(actual: {sim_stats['actual_traffic_range'][0]}–{sim_stats['actual_traffic_range'][1]})  |  "
          f"Base date: {sim_stats['base_date']}")
    print(f"  Kappa: {sim_stats['kappa_default']}  |  "
          f"Failure rate: {sim_stats['failure_rate']}  |  "
          f"Drift sigma: {sim_stats['drift_sigma']}")
    print()

    # Per-edge table
    print(f"{'Edge':<35} {'p':>6} {'onset':>6} {'mu':>6} {'sig':>5} {'kap':>5}  {'w_rows':>7} {'c_rows':>7}")
    print("-" * 90)

    for edge_id, et in topology.edges.items():
        pid = et.param_id
        if not pid:
            continue
        t = truth.get("edges", {}).get(pid, {})
        if not t:
            bare = pid.replace("parameter-", "") if pid.startswith("parameter-") else pid
            t = truth.get("edges", {}).get(bare, {})
        rows = snapshot_rows.get(edge_id, [])
        w_count = sum(1 for r in rows if r.get("slice_key") == "window()")
        c_count = sum(1 for r in rows if r.get("slice_key") == "cohort()")
        label = pid[:35] if pid else edge_id[:35]
        print(f"{label:<35} {t.get('p', 0):.4f} {t.get('onset', 0):6.1f} "
              f"{t.get('mu', 0):6.2f} {t.get('sigma', 0):5.2f} "
              f"{t.get('kappa_sim', sim_stats['kappa_default']):5.0f}  "
              f"{w_count:7d} {c_count:7d}")

    print(f"\nTotal rows: {sim_stats['total_rows']}")


def print_edge_config(
    topology, hash_map: dict[str, dict[str, str]],
) -> None:
    """Print edge config tuples for test harness."""
    print(f"\n{'='*70}")
    print("EDGE CONFIG FOR TEST HARNESS")
    print(f"{'='*70}")
    for edge_id, et in topology.edges.items():
        pid = et.param_id
        if not pid:
            continue
        hashes = hash_map.get(pid, {})
        wh = hashes.get("window_hash", "???")
        ch = hashes.get("cohort_hash", "???")
        print(f'    ("{pid}", "{edge_id}", "{wh}", "{ch}"),')


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Bayes synthetic data generator (doc 17)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python synth_gen.py --graph branch --dry-run
  python synth_gen.py --graph branch --kappa 15 --drift 0.02
  python synth_gen.py --graph branch --write-files
  python synth_gen.py --clean --graph branch
""",
    )
    parser.add_argument("--graph", choices=list(GRAPH_CONFIGS.keys()), default="branch",
                        help="Test graph (default: branch)")
    parser.add_argument("--people", type=int, default=None,
                        help="Mean people per cohort day (default: 5000)")
    parser.add_argument("--days", type=int, default=None,
                        help="Number of cohort days (default: 100)")
    parser.add_argument("--seed", type=int, default=None, help="RNG seed (default: 42)")
    parser.add_argument("--kappa", type=float, default=None,
                        help="Default kappa_sim for overdispersion (default: 50)")
    parser.add_argument("--failure-rate", type=float, default=None,
                        help="Fetch failure rate 0-1 (default: 0.05)")
    parser.add_argument("--drift", type=float, default=None,
                        help="Drift sigma for random-walk on p (default: 0 = off)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Generate and summarise but don't write to DB or files")
    parser.add_argument("--write-files", action="store_true",
                        help="Also update data repo: param YAMLs, graph JSON, indexes")
    parser.add_argument("--clean", action="store_true",
                        help="Remove synthetic data from DB and exit")
    parser.add_argument("--truth", type=str, default=None,
                        help="Path to .truth.yaml (default: derive from graph)")
    args = parser.parse_args()

    gcfg = GRAPH_CONFIGS[args.graph]
    db_conn = _load_db_connection()

    if args.clean:
        if not db_conn:
            print("ERROR: No DB_CONNECTION")
            sys.exit(1)
        clean_synthetic_data(db_conn, gcfg)
        return

    data_repo = _resolve_data_repo()

    # Load graph
    graph_path = os.path.join(data_repo, "graphs", gcfg["graph_file"])
    with open(graph_path) as f:
        graph = json.load(f)
    print(f"Graph [{args.graph}]: {len(graph.get('edges', []))} edges")

    # Topology
    from compiler.topology import analyse_topology
    topology = analyse_topology(graph)
    print(f"Topology: {len(topology.edges)} edges, "
          f"{len(topology.branch_groups)} branch groups, "
          f"{len(topology.join_nodes)} joins")

    # Ground truth
    if args.truth:
        truth = load_truth_config(args.truth)
        print(f"Truth: loaded from {args.truth}")
    else:
        truth_path = graph_path.replace(".json", ".truth.yaml")
        if os.path.exists(truth_path):
            truth = load_truth_config(truth_path)
            print(f"Truth: loaded from {truth_path}")
        else:
            truth = derive_truth_from_graph(graph, topology)
            print("Truth: derived from graph edge metadata")

    # Build hash lookup — compute real FE-compatible hashes, fall back to
    # GRAPH_CONFIGS static hashes (for graphs with known FE hashes)
    hash_lookup = _build_hash_lookup(gcfg)
    computed_hashes = compute_core_hashes(graph, topology, data_repo)
    # Computed hashes override static SYNTH-* fallbacks
    for pid, hashes in computed_hashes.items():
        existing = hash_lookup.get(pid, {})
        if existing.get("window_hash", "").startswith("SYNTH-") or pid not in hash_lookup:
            hash_lookup[pid] = hashes
    print(f"Hashes: computed {len(computed_hashes)} edge hashes from graph + event definitions")
    # Also merge any hashes from truth config edges
    for pid, edata in truth.get("edges", {}).items():
        if "window_hash" in edata and "cohort_hash" in edata:
            hash_lookup[pid] = {
                "window_hash": edata["window_hash"],
                "cohort_hash": edata["cohort_hash"],
            }

    # Simulation config: truth config → CLI overrides
    cli_overrides = {
        "mean_daily_traffic": args.people,
        "n_days": args.days,
        "seed": args.seed,
        "kappa_sim_default": args.kappa,
        "failure_rate": args.failure_rate,
        "drift_sigma": args.drift,
    }
    sim_config = _get_sim_config(truth, cli_overrides)
    sim_config["base_date"] = gcfg.get("base_date", "2025-11-01")

    print(f"\nSimulating ~{sim_config['mean_daily_traffic']} people/day "
          f"× {sim_config['n_days']} days "
          f"(seed={sim_config['seed']}, "
          f"κ={sim_config['kappa_sim_default']}, "
          f"drift={sim_config['drift_sigma']})...")

    import time as _time
    t0 = _time.time()

    snapshot_rows, sim_stats = simulate_graph(
        graph, topology, truth, sim_config, hash_lookup,
    )
    elapsed = _time.time() - t0
    print(f"Simulation complete in {elapsed:.1f}s")

    print_summary(topology, truth, snapshot_rows, sim_stats)

    if args.dry_run:
        print("\n(Dry run — not writing to DB or files)")
        return

    # Write to snapshot DB (optional — may not have local DB)
    hash_map = {}
    if db_conn:
        print(f"\nWriting to snapshot DB...")
        # Build workspace prefix: repo-branch (matches FE buildDbParamId)
        import subprocess
        repo_name = os.path.basename(data_repo)
        try:
            branch_name = subprocess.check_output(
                ["git", "-C", data_repo, "branch", "--show-current"],
                text=True,
            ).strip()
        except Exception:
            branch_name = "main"
        workspace_prefix = f"{repo_name}-{branch_name}"
        print(f"  Workspace prefix: {workspace_prefix}")
        try:
            hash_map = write_to_snapshot_db(snapshot_rows, db_conn, workspace_prefix, hash_lookup)
            print_edge_config(topology, hash_map)
        except Exception as e:
            print(f"\n  WARNING: DB write failed: {e}")
            print(f"  (Continuing with file generation if --write-files is set)")
    else:
        print("\nNo DB_CONNECTION — skipping snapshot DB write")
        print("  (Set DB_CONNECTION in graph-editor/.env.local for DB writes)")

    if args.write_files:
        print(f"\nWriting data repo files...")

        # 1. Parameter YAML files
        print("  Parameter files:")
        written_params = write_parameter_files(
            topology, truth, sim_stats, data_repo, graph, hash_lookup,
        )
        print(f"    Wrote {len(written_params)} parameter files")

        # 2. Update parameters-index.yaml
        update_parameter_index(data_repo, written_params)

        # 3. Update graph edge metadata (p.mean, latency)
        print("  Graph edge metadata:")
        update_graph_edge_metadata(graph_path, topology, truth, sim_stats)
        print("    Updated edge p blocks")

        # 4. Set simulation guard
        print("  Simulation guard:")
        set_simulation_guard(graph_path, enable=True, sim_stats=sim_stats)
        print("    Set simulation=true, dailyFetch=false, dataInterestsDSL set")

        print(f"\nData repo files written. Next steps:")
        print(f"  1. cd {data_repo}")
        print(f"  2. git diff  (review changes)")
        print(f"  3. bash ../graph-ops/scripts/validate-graph.sh graphs/{gcfg['graph_file']}")
        print(f"  4. Open graph in FE to inspect synthetic data")

    if not db_conn and not args.write_files:
        print("\nWARNING: No DB and --write-files not set — data generated but not persisted.")
        print("  Use --write-files to update data repo, or set DB_CONNECTION for DB writes.")

    print("\nDone.")


if __name__ == "__main__":
    main()
