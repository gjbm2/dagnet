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
# Status + quality classification
# ---------------------------------------------------------------------------
#
# Regression runs are not tests — they are calibration/discovery probes.
# Binary PASS/FAIL is inadequate. We split outcomes into:
#
#   status:
#     fail       — infrastructure failure: harness crash, timeout, empty
#                  posterior. The run did not produce usable output.
#     completed  — the run reached the end and produced posteriors.
#                  Recovery quality is a separate concern, described
#                  by the `quality` block.
#
#   quality.convergence_global:
#     ok         — rhat ≤ threshold, ess ≥ threshold, converged ≥ threshold
#     degraded   — one metric marginally breached
#     failed     — multiple metrics breached or catastrophic single breach
#
#   quality.bias_systematic (per-parameter):
#     ok         — mean bias small or inconsistent across edges
#     biased     — non-trivial mean bias with high directional consistency
#
#   quality.verdict — one-line summary combining convergence + bias.

CONVERGENCE_THRESHOLDS = {
    "rhat_ok": 1.05,
    "rhat_degraded": 1.10,
    "ess_ok": 200,
    "ess_degraded": 50,
    "converged_pct_ok": 90.0,
    "converged_pct_degraded": 70.0,
}

# Bias thresholds used to flag systematic bias:
#   - abs(mean_bias) above floor AND
#   - >= consistency_min fraction of edges in the same direction AND
#   - n >= min_n edges/slices (avoid tiny samples)
BIAS_THRESHOLDS = {
    "p": {"bias_floor": 0.02, "min_n": 3, "consistency_min": 0.8},
    "mu": {"bias_floor": 0.15, "min_n": 3, "consistency_min": 0.8},
    "sigma": {"bias_floor": 0.05, "min_n": 3, "consistency_min": 0.8},
    "onset": {"bias_floor": 0.3, "min_n": 3, "consistency_min": 0.8},
    "p_slice": {"bias_floor": 0.02, "min_n": 3, "consistency_min": 0.8},
    "mu_slice": {"bias_floor": 0.15, "min_n": 3, "consistency_min": 0.8},
    "sigma_slice": {"bias_floor": 0.05, "min_n": 3, "consistency_min": 0.8},
    "onset_slice": {"bias_floor": 0.3, "min_n": 3, "consistency_min": 0.8},
}


def classify_convergence(quality: dict | None) -> dict:
    """Classify global convergence from quality metrics.

    Returns a dict with `verdict` (ok/degraded/failed/unknown) and the
    metrics that drove the verdict.
    """
    if not quality:
        return {"verdict": "unknown"}
    rhat = quality.get("rhat")
    ess = quality.get("ess")
    conv = quality.get("converged_pct")
    if rhat is None and ess is None and conv is None:
        return {"verdict": "unknown"}

    breaches = []
    severe = []
    t = CONVERGENCE_THRESHOLDS
    if rhat is not None:
        if rhat > t["rhat_degraded"]:
            severe.append(f"rhat={rhat:.3f}>{t['rhat_degraded']}")
        elif rhat > t["rhat_ok"]:
            breaches.append(f"rhat={rhat:.3f}>{t['rhat_ok']}")
    if ess is not None:
        if ess < t["ess_degraded"]:
            severe.append(f"ess={ess}<{t['ess_degraded']}")
        elif ess < t["ess_ok"]:
            breaches.append(f"ess={ess}<{t['ess_ok']}")
    if conv is not None:
        if conv < t["converged_pct_degraded"]:
            severe.append(f"conv={conv}%<{t['converged_pct_degraded']}%")
        elif conv < t["converged_pct_ok"]:
            breaches.append(f"conv={conv}%<{t['converged_pct_ok']}%")

    if severe:
        verdict = "failed"
    elif breaches:
        verdict = "degraded"
    else:
        verdict = "ok"
    return {
        "verdict": verdict,
        "rhat": round_val(rhat, "rhat"),
        "ess": round_val(ess, "ess"),
        "converged_pct": conv,
        "breaches": breaches + severe,
    }


def classify_bias(bias_profile: dict | None) -> dict:
    """Classify per-parameter systematic bias.

    Returns a dict keyed by parameter name with `verdict` (ok/biased)
    plus mean_bias/direction/consistency/max_z for at-a-glance review.
    """
    if not bias_profile:
        return {}
    out: dict[str, dict] = {}
    for param, rec in bias_profile.items():
        thresh = BIAS_THRESHOLDS.get(param)
        if thresh is None:
            continue
        n = rec.get("n", 0)
        mean_bias = rec.get("mean_bias", 0.0)
        direction = rec.get("direction", "~")
        consistency_str = rec.get("consistency", "0/0")
        try:
            major, total = consistency_str.split("/")
            consistency_frac = int(major) / int(total) if int(total) else 0.0
        except (ValueError, ZeroDivisionError):
            consistency_frac = 0.0

        if (
            n >= thresh["min_n"]
            and abs(mean_bias) >= thresh["bias_floor"]
            and direction in ("+", "-")
            and consistency_frac >= thresh["consistency_min"]
        ):
            verdict = "biased"
        else:
            verdict = "ok"
        out[param] = {
            "verdict": verdict,
            "mean_bias": rec.get("mean_bias"),
            "direction": direction,
            "consistency": consistency_str,
            "max_z": rec.get("max_z"),
            "n": n,
        }
    return out


def classify_quality(
    quality: dict | None,
    bias_profile: dict | None,
    failures: list,
) -> dict:
    """Produce a structured quality classification for a completed run.

    Distinct from `status`: status describes whether the run produced
    output at all; quality describes whether the output is trustworthy.
    """
    convergence = classify_convergence(quality)
    bias = classify_bias(bias_profile)

    # Point-level failures by category. Callers (run_regression) emit
    # structured failure dicts with a `type` field.
    convergence_points = [
        f for f in (failures or [])
        if isinstance(f, dict) and f.get("type") == "convergence"
    ]
    bias_points = [
        f for f in (failures or [])
        if isinstance(f, dict) and f.get("type") == "z_score"
    ]
    # Data-integrity issues: audit-layer flags (e.g. kappa_lat flag set
    # but zero variables, harness log missing, mu_prior lines absent).
    # Soft signal — the run still produced posteriors, but the model
    # state or audit trail shows inconsistency.
    data_integrity_points = [
        f for f in (failures or [])
        if isinstance(f, dict) and f.get("type") == "audit"
    ]

    # One-line verdict combining the axes.
    conv_v = convergence.get("verdict", "unknown")
    biased_params = [p for p, rec in bias.items() if rec.get("verdict") == "biased"]
    has_bias_issue = bool(biased_params) or bool(bias_points)
    has_conv_issue = conv_v in ("degraded", "failed") or bool(convergence_points)
    has_data_integrity_issue = bool(data_integrity_points)

    if not has_bias_issue and not has_conv_issue and not has_data_integrity_issue and conv_v == "ok":
        verdict = "clean"
    elif has_data_integrity_issue and not has_bias_issue and not has_conv_issue:
        verdict = "data_integrity_warning"
    elif has_bias_issue and has_conv_issue:
        verdict = "bias_and_convergence_issues"
    elif has_bias_issue:
        verdict = "systematic_bias"
    elif has_conv_issue:
        if conv_v == "failed":
            verdict = "convergence_global_failure"
        elif convergence_points and conv_v == "ok":
            verdict = "convergence_point_failure"
        else:
            verdict = "convergence_degraded"
    else:
        verdict = "clean"

    return {
        "verdict": verdict,
        "convergence": convergence,
        "convergence_points": convergence_points,
        "bias_params": bias,
        "bias_points": bias_points,
        "biased_params": biased_params,
        "data_integrity_points": data_integrity_points,
    }


def classify_status(
    passed_legacy: bool,
    failures: list,
    quality: dict | None,
) -> str:
    """Classify top-level outcome as `fail` or `completed`.

    `fail` — infrastructure / data-integrity failure: the run did not
    produce usable posteriors. Either the subprocess crashed, the
    sampler produced no output, or the data pipeline failed so the
    posteriors bear no relationship to the data (binding failure).

    `completed` — ran to end, produced posteriors, evidence bound.
    Recovery quality (bias, convergence) is a separate concern —
    see `classify_quality`.

    Binding is treated as infrastructure because a "clean" convergence
    verdict on a run where zero edges bound is a silent void: the
    sampler drew from priors only, so there is nothing to compare
    against truth. Such a result must not be confused with a genuine
    clean completion.
    """
    infra_types = {
        "harness",            # subprocess crash / non-zero exit
        "timeout",            # subprocess timed out
        "bootstrap",          # bootstrap failed
        "error",              # any other exception
        "empty_posterior",    # sampler ran but produced no posterior
        "binding",            # data binding failed — posteriors detached from data
        "missing_edge",       # truth edge has no posterior — model didn't emit it
        "missing_param",      # expected parameter missing from edge posteriors
        "missing_slice",      # truth slice has no posterior
    }
    for f in failures or []:
        if isinstance(f, dict) and f.get("type") in infra_types:
            return "fail"
    # No quality metrics at all → inference never produced a posterior.
    if quality is None or not quality:
        return "fail"
    if (
        quality.get("rhat") is None
        and quality.get("ess") is None
        and quality.get("converged_pct") is None
    ):
        return "fail"
    return "completed"


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

    # Binding details — per-edge row counts (data volume)
    binding_details = db.get("binding_details", [])
    if binding_details:
        result["binding"]["edges"] = [
            {
                "edge": bd["uuid"],
                "source": bd["source"],
                "verdict": bd["verdict"],
                "rows_raw": bd["rows_raw"],
                "rows_post_regime": bd["rows_post_regime"],
                "rows_final": bd["rows_final"],
            }
            for bd in binding_details
        ]

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

    # Bias profile — computed from the edge/slice data
    bias = compute_bias_profile(edges_raw, slices_raw)

    failures = r.get("failures", [])
    status = classify_status(
        r.get("passed", False), failures, rounded_quality,
    )
    classification = (
        classify_quality(rounded_quality, bias, failures)
        if status == "completed" else None
    )

    result: dict[str, Any] = {
        "graph_name": r.get("graph_name", ""),
        "status": status,
        "xfail": r.get("xfail", False),
        "xfail_reason": r.get("xfail_reason", ""),
        "failures": failures,
        "warnings": r.get("warnings", []),
        "quality": rounded_quality,
        "thresholds": r.get("thresholds", {}),
        "edges": edges,
        "slices": slices,
    }
    if classification:
        result["classification"] = classification
    if bias:
        result["bias"] = bias

    # Audit — if present in the result
    audit = serialise_audit(r.get("audit"))
    if audit:
        result["audit"] = audit

    # Experimental design metadata — extracted from truth config so
    # downstream analysis can group/slice results by sparsity level,
    # topology, lifecycle config, etc. without parsing graph names.
    truth_config = r.get("truth_config")
    if truth_config:
        result["design"] = serialise_design(truth_config)

    return result


def serialise_design(truth: dict) -> dict:
    """Extract experimental design metadata from a truth config.

    Produces a flat, jq-friendly dict describing the graph's position
    in the cartesian test space: topology shape, sparsity parameters,
    context dimensions, epoch structure, and data volume settings.
    """
    sim = truth.get("simulation", {})
    edges = truth.get("edges", {})
    nodes = truth.get("nodes", {})
    ctx_dims = truth.get("context_dimensions", [])
    epochs = truth.get("epochs", [])

    # Topology classification
    n_edges = len([e for e in edges.values()
                   if isinstance(e, dict) and e.get("p") is not None])
    n_nodes = len(nodes)
    has_join = any(
        sum(1 for e in edges.values()
            if isinstance(e, dict) and e.get("to") == nid) > 1
        for nid in nodes
    )
    has_branch = any(
        sum(1 for e in edges.values()
            if isinstance(e, dict) and e.get("from") == nid) > 1
        for nid in nodes
    )
    if n_edges == 1:
        topo = "solo"
    elif has_join and has_branch:
        topo = "diamond"
    elif has_join:
        topo = "join"
    elif has_branch:
        topo = "branch"
    else:
        topo = "chain"

    design: dict[str, Any] = {
        "topology": topo,
        "n_edges": n_edges,
        "n_nodes": n_nodes,
        "n_days": sim.get("n_days", 0),
        "mean_daily_traffic": sim.get("mean_daily_traffic", 0),
    }

    # Sparsity parameters
    _fd = sim.get("frame_drop_rate", 0)
    _tr = sim.get("toggle_rate", 0)
    _ia = sim.get("initial_absent_pct", 0)
    if _fd > 0 or _tr > 0 or _ia > 0:
        design["sparsity"] = {
            "frame_drop_rate": _fd,
            "toggle_rate": _tr,
            "initial_absent_pct": _ia,
        }

    # Context dimensions
    if ctx_dims:
        dim_summaries = []
        for dim in ctx_dims:
            values = dim.get("values", [])
            dim_summary: dict[str, Any] = {
                "id": dim.get("id", ""),
                "n_values": len(values),
                "mece": dim.get("mece", False),
            }
            # Lifecycle: any values with active windows?
            lifecycles = []
            for v in values:
                _af = v.get("active_from_day")
                _at = v.get("active_to_day")
                if _af is not None or _at is not None:
                    lifecycles.append({
                        "value": v.get("id", ""),
                        "active_from_day": _af or 0,
                        "active_to_day": _at or 999999,
                    })
            if lifecycles:
                dim_summary["lifecycles"] = lifecycles
            dim_summaries.append(dim_summary)
        design["context_dimensions"] = dim_summaries

    # Epoch structure
    if epochs:
        design["epochs"] = [
            {
                "label": ep.get("label", ""),
                "from_day": ep.get("from_day", 0),
                "to_day": ep.get("to_day", 0),
            }
            for ep in epochs
        ]

    return design
