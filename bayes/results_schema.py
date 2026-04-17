"""
Structured results schema for Bayes regression output.

Single source of truth for serialising regression results into
machine-readable JSON. Used by both run_regression.py and
regression_plans.py.

Design goals:
  - Every field is queryable with jq / Python dict access
  - Failures and warnings are structured, not opaque strings
  - Floats are rounded to useful precision
  - Audit, LOO, and bias data are preserved (not thrown away)
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any


# ---------------------------------------------------------------------------
# Rounding
# ---------------------------------------------------------------------------

# Precision table — each field type gets a fixed number of decimal places.
_PRECISION = {
    "z_score": 3,
    "abs_error": 4,
    "posterior_mean": 4,
    "posterior_sd": 4,
    "truth": 4,
    "mean_bias": 4,
    "max_z": 2,
    "rhat": 4,
    "ess": 0,           # integer
    "delta_elpd": 1,
    "pareto_k": 2,
}


def round_val(value: Any, field: str | None = None, places: int | None = None) -> Any:
    """Round a numeric value to the precision for its field type.

    If `places` is given, uses that directly. Otherwise looks up
    `field` in the precision table. Non-numeric values pass through.
    """
    if value is None:
        return None
    if not isinstance(value, (int, float)):
        return value
    if places is not None:
        p = places
    elif field and field in _PRECISION:
        p = _PRECISION[field]
    else:
        return value
    if p == 0:
        return int(round(value))
    return round(value, p)


def _round_param_dict(d: dict) -> dict:
    """Round all numeric fields in a parameter dict using field-name lookup."""
    return {k: round_val(v, field=k) for k, v in d.items()}


# ---------------------------------------------------------------------------
# Structured failures / warnings
# ---------------------------------------------------------------------------

def make_failure(
    type: str,
    message: str,
    *,
    edge: str | None = None,
    slice: str | None = None,
    param: str | None = None,
    z_score: float | None = None,
    threshold: float | None = None,
    abs_error: float | None = None,
    abs_floor: float | None = None,
    truth: float | None = None,
    posterior_mean: float | None = None,
    posterior_sd: float | None = None,
    metric: str | None = None,
    value: float | None = None,
    count: int | None = None,
    items: list[str] | None = None,
) -> dict:
    """Build a structured failure or warning dict.

    Every failure has `type` and `message`. Additional fields are
    included only when non-None, keeping the output compact.

    Types:
        z_score         — parameter recovery miss
        convergence     — rhat/ess/converged below threshold
        missing_edge    — truth edge not found in posteriors
        missing_param   — expected param missing from edge posteriors
        missing_slice   — expected slice missing from posteriors
        binding         — data binding failure (fallback/failed edges)
        audit           — audit-layer failure (log missing, kappa_lat)
    """
    d: dict[str, Any] = {"type": type, "message": message}
    for key, val in [
        ("edge", edge),
        ("slice", slice),
        ("param", param),
        ("z_score", round_val(z_score, "z_score")),
        ("threshold", round_val(threshold, places=2)),
        ("abs_error", round_val(abs_error, "abs_error")),
        ("abs_floor", round_val(abs_floor, places=2)),
        ("truth", round_val(truth, "truth")),
        ("posterior_mean", round_val(posterior_mean, "posterior_mean")),
        ("posterior_sd", round_val(posterior_sd, "posterior_sd")),
        ("metric", metric),
        ("value", round_val(value, places=4)),
        ("count", count),
        ("items", items),
    ]:
        if val is not None:
            d[key] = val
    return d


# ---------------------------------------------------------------------------
# Bias profile
# ---------------------------------------------------------------------------

def compute_bias_profile(
    parsed_edges: dict,
    parsed_slices: dict,
) -> dict:
    """Compute structured bias profile from recovery data.

    Returns a dict keyed by parameter name (p, mu, sigma, onset,
    p_slice, mu_slice, ...) with bias statistics:
        n, mean_bias, direction, consistency, max_z, max_z_source
    """
    param_errors: dict[str, list[tuple[str, float, float]]] = defaultdict(list)
    # (label, signed_error, z_score)

    for edge_name, edge_data in parsed_edges.items():
        for param, pdata in edge_data.items():
            if param == "kappa" or not isinstance(pdata, dict):
                continue
            truth = pdata.get("truth")
            post = pdata.get("posterior_mean")
            z = pdata.get("z_score", 0)
            if truth is not None and post is not None:
                param_errors[param].append((edge_name, post - truth, z))

    for label, slice_data in parsed_slices.items():
        for param, pdata in slice_data.items():
            if param == "kappa" or not isinstance(pdata, dict):
                continue
            truth = pdata.get("truth")
            post = pdata.get("posterior_mean")
            z = pdata.get("z_score", 0)
            if truth is not None and post is not None:
                param_errors[f"{param}_slice"].append((label, post - truth, z))

    profile: dict = {}
    for param in ["p", "mu", "sigma", "onset",
                   "p_slice", "mu_slice", "sigma_slice", "onset_slice"]:
        errs = param_errors.get(param)
        if not errs:
            continue
        signed = [e[1] for e in errs]
        zscores = [e[2] for e in errs]
        n = len(signed)
        mean_bias = sum(signed) / n
        n_pos = sum(1 for s in signed if s > 0)
        n_neg = n - n_pos
        max_z = max(zscores)
        max_z_entry = max(errs, key=lambda e: e[2])
        direction = "+" if n_pos > n_neg else "-" if n_neg > n_pos else "~"

        profile[param] = {
            "n": n,
            "mean_bias": round_val(mean_bias, "mean_bias"),
            "direction": direction,
            "consistency": f"{max(n_pos, n_neg)}/{n}",
            "max_z": round_val(max_z, "max_z"),
            "max_z_source": max_z_entry[0],
        }

    return profile


# ---------------------------------------------------------------------------
# Audit serialisation
# ---------------------------------------------------------------------------

def serialise_audit(audit: dict | None) -> dict | None:
    """Extract the JSON-safe, compact subset of an audit dict.

    Returns None if audit is empty or missing.
    """
    if not audit or not audit.get("log_found"):
        return None

    db = audit.get("data_binding", {})
    md = audit.get("model", {})
    loo = audit.get("loo", {})

    result: dict[str, Any] = {
        "dsl": audit.get("dsl", ""),
        "subjects": audit.get("subjects", 0),
        "regimes": audit.get("regimes", 0),
        "completed": audit.get("completed", False),
        "binding": {
            "snapshot_edges": db.get("snapshot_edges", 0),
            "fallback_edges": db.get("fallback_edges", 0),
            "bound": db.get("total_bound", 0),
            "failed": db.get("total_failed", 0),
        },
        "model": {
            "latency_dispersion": md.get("latency_dispersion_flag", False),
            "phase1_sampled": md.get("phase1_sampled", False),
            "phase2_sampled": md.get("phase2_sampled", False),
            "kappa_lat_edges": md.get("kappa_lat_edges", 0),
        },
    }

    # LOO — only include if it ran
    if loo.get("status") in ("scored", "failed"):
        result["loo"] = {
            "status": loo["status"],
            "edges_scored": loo.get("edges_scored", 0),
            "total_delta_elpd": round_val(loo.get("total_delta_elpd", 0), "delta_elpd"),
            "worst_pareto_k": round_val(loo.get("worst_pareto_k", 0), "pareto_k"),
        }

    # Binding slice details — compact per-edge-per-slice data counts
    slice_details = db.get("slice_details", [])
    if slice_details:
        result["binding"]["slices"] = [
            {
                "edge": sd["uuid"],
                "context": sd["ctx_key"],
                "total_n": sd["total_n"],
                "window_n": sd["window_n"],
                "cohort_n": sd["cohort_n"],
            }
            for sd in slice_details
        ]

    return result


# ---------------------------------------------------------------------------
# Top-level result serialisation
# ---------------------------------------------------------------------------

def serialise_result(r: dict) -> dict:
    """Serialise a single graph regression result to JSON-safe dict.

    Handles both the `parsed_edges`/`parsed_slices` keys (from
    assert_recovery) and the `edges`/`slices` keys (from the
    augmented result in run_regression's main loop).
    """
    edges_raw = r.get("parsed_edges", r.get("edges", {}))
    slices_raw = r.get("parsed_slices", r.get("slices", {}))

    edges = {}
    for edge_name, edge_params in edges_raw.items():
        edges[edge_name] = {
            param: _round_param_dict({
                "truth": pdata.get("truth"),
                "posterior_mean": pdata.get("posterior_mean"),
                "posterior_sd": pdata.get("posterior_sd"),
                "z_score": pdata.get("z_score"),
                "abs_error": pdata.get("abs_error"),
                "status": pdata.get("status"),
            })
            for param, pdata in edge_params.items()
            if isinstance(pdata, dict)
        }

    slices = {}
    for label, slice_params in slices_raw.items():
        slices[label] = {
            param: _round_param_dict({
                "truth": pdata.get("truth"),
                "posterior_mean": pdata.get("posterior_mean"),
                "posterior_sd": pdata.get("posterior_sd"),
                "z_score": pdata.get("z_score"),
                "abs_error": pdata.get("abs_error"),
                "status": pdata.get("status"),
            })
            for param, pdata in slice_params.items()
            if isinstance(pdata, dict)
        }

    quality = r.get("quality", {})
    rounded_quality = {
        "elapsed_s": quality.get("elapsed_s"),
        "rhat": round_val(quality.get("rhat"), "rhat"),
        "ess": round_val(quality.get("ess"), "ess"),
        "converged_pct": quality.get("converged_pct"),
    }
    # Drop None values from quality
    rounded_quality = {k: v for k, v in rounded_quality.items() if v is not None}

    result: dict[str, Any] = {
        "graph_name": r.get("graph_name", ""),
        "passed": r.get("passed", False),
        "xfail": r.get("xfail", False),
        "xfail_reason": r.get("xfail_reason", ""),
        "failures": r.get("failures", []),
        "warnings": r.get("warnings", []),
        "quality": rounded_quality,
        "thresholds": r.get("thresholds", {}),
        "edges": edges,
        "slices": slices,
    }

    # Bias profile — computed from the edge/slice data
    bias = compute_bias_profile(edges_raw, slices_raw)
    if bias:
        result["bias"] = bias

    # Audit — if present in the result
    audit = serialise_audit(r.get("audit"))
    if audit:
        result["audit"] = audit

    return result
