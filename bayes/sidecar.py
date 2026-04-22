"""
Bayesian model_vars sidecar for synth-graph test fixtures.

The synth graph JSON file is co-owned by several writers (synth_gen,
hydrate.sh, FE CLI apply-patch, MCMC via test_harness). Storing
expensive-to-produce bayesian model_vars inside that file means every
competing write is either forced to preserve them (fragile) or clobbers
them (the flip-flop we're fixing).

Bayesian model_vars are tiny (~1 KB per graph) and cheap to re-inject
at test-load time. They are cached in a sidecar file keyed by a
fingerprint of the real inputs MCMC consumes: the truth YAML and the
per-param YAMLs that carry daily observation counts. When either
changes, the sidecar invalidates and a new MCMC run is triggered.

Public API:
    compute_fingerprint(truth_path, param_paths) -> dict
    save_sidecar(path, fingerprint, edges) -> None
    load_sidecar(path, expected_fingerprint) -> dict | None
    inject_bayesian(graph, edges) -> None
"""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional


SCHEMA_VERSION = 1


# Mapping from bayesian model_var latency field → flat promoted key on
# the edge's `latency` dict. Matches applyPromotion in the FE and the
# promotion block in synth_gen.update_graph_edge_metadata.
_PROMOTED_FIELDS = {
    "mu_sd": "promoted_mu_sd",                  # epistemic (doc 61)
    "mu_sd_pred": "promoted_mu_sd_pred",        # predictive (doc 61; absent when no kappa_lat)
    "sigma_sd": "promoted_sigma_sd",
    "onset_sd": "promoted_onset_sd",
    "onset_mu_corr": "promoted_onset_mu_corr",
    "path_mu_sd": "promoted_path_mu_sd",        # epistemic (doc 61)
    "path_mu_sd_pred": "promoted_path_mu_sd_pred",
    "path_sigma_sd": "promoted_path_sigma_sd",
    "path_onset_sd": "promoted_path_onset_sd",
    "path_onset_mu_corr": "promoted_path_onset_mu_corr",
    "t95": "promoted_t95",
    "path_t95": "promoted_path_t95",
    "onset_delta_days": "promoted_onset_delta_days",
}


# ─── Fingerprint ───────────────────────────────────────────────────────

def _sha256_file(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def _param_id_from_path(path: str) -> str:
    return os.path.splitext(os.path.basename(path))[0]


def compute_fingerprint(truth_path: str, param_paths: Iterable[str]) -> Dict[str, Any]:
    """Return a fingerprint that flips whenever truth or any param file
    content changes. Order of param_paths is not significant.

    Raises FileNotFoundError / OSError when truth_path is absent — a
    missing truth file is a hard error, not a silent fresh verdict.
    """
    truth_sha = _sha256_file(truth_path)
    param_hashes: Dict[str, str] = {}
    for p in param_paths:
        param_hashes[_param_id_from_path(p)] = _sha256_file(p)
    return {
        "truth_sha256": truth_sha,
        "param_file_hashes": param_hashes,
    }


# ─── Save / load ───────────────────────────────────────────────────────

def save_sidecar(
    path: str,
    fingerprint: Dict[str, Any],
    edges: Dict[str, Dict[str, Any]],
) -> None:
    """Write the sidecar JSON. The generated_at field is informational
    only — fingerprint is the sole authority for staleness. Human-
    readable UK date format (d-MMM-yy HH:MM:SS) matches project
    conventions.
    """
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    payload = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now().strftime("%-d-%b-%y %H:%M:%S"),
        "fingerprint": fingerprint,
        "edges": edges,
    }
    with open(path, "w") as f:
        json.dump(payload, f, indent=2, sort_keys=False)
        f.write("\n")


def load_sidecar(
    path: str,
    expected_fingerprint: Dict[str, Any],
) -> Optional[Dict[str, Dict[str, Any]]]:
    """Return the edges dict iff the stored fingerprint matches
    expected_fingerprint. Returns None when the file is absent or
    fingerprint drifts. Raises on malformed JSON — silent corruption
    is worse than a loud failure.
    """
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        data = json.load(f)
    if data.get("fingerprint") != expected_fingerprint:
        return None
    return data.get("edges") or {}


# ─── Injection into a graph dict ───────────────────────────────────────

def _strip_existing_bayesian(model_vars: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [m for m in model_vars if m.get("source") != "bayesian"]


def _promote_sds(latency_block: Dict[str, Any], bayes_latency: Dict[str, Any]) -> None:
    """Copy SDs + t95 + onset_delta_days from the bayesian model_var's
    latency block into the edge's latency block under `promoted_*` keys.
    BE-only consumers (span_adapter, cohort_forecast_v2) read from these
    flat fields; without them the v2 handler's `has_uncertainty` gate
    stays false and midpoints flatten.
    """
    for src_key, promoted_key in _PROMOTED_FIELDS.items():
        val = bayes_latency.get(src_key)
        if isinstance(val, (int, float)):
            latency_block[promoted_key] = float(val)


def inject_bayesian(
    graph: Dict[str, Any],
    edges: Dict[str, Dict[str, Any]],
) -> None:
    """Mutate `graph` in place to carry bayesian model_vars from the
    sidecar's `edges` dict (keyed by edge UUID).

    Idempotent: any pre-existing `source=bayesian` entry on each edge is
    removed before the sidecar entry is appended, so repeated invocations
    do not accumulate duplicates.

    Edges not present in the sidecar are untouched. Sidecar entries
    whose edge UUID does not exist in the graph are silently ignored —
    the sidecar is allowed to be a superset while the graph evolves.
    """
    if not edges:
        return

    for edge in graph.get("edges", []):
        eid = edge.get("uuid")
        if not eid or eid not in edges:
            continue
        p = edge.setdefault("p", {})
        latency = p.setdefault("latency", {})
        model_vars = p.get("model_vars")
        if not isinstance(model_vars, list):
            model_vars = []
        model_vars = _strip_existing_bayesian(model_vars)

        bayes_entry = edges[eid]
        model_vars.append(bayes_entry)
        p["model_vars"] = model_vars

        bayes_latency = bayes_entry.get("latency") or {}
        _promote_sds(latency, bayes_latency)
