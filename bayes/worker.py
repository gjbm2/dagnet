"""
DagNet Bayes worker — single fit_graph() implementation.

Called by both:
  - bayes/app.py (Modal transport)
  - graph-editor/lib/bayes_local.py (local thread transport)

Responsibilities:
  1. Connect to Neon (if db_connection provided)
  2. Run compiler pipeline: topology → evidence → model → inference
  3. Format webhook payload in the shape the webhook handler expects
  4. POST to webhook URL
  5. Return diagnostic result
"""

from __future__ import annotations

import math
import os
import time
from datetime import datetime


def _noop_progress(stage: str, pct: int, detail: str = "") -> None:
    pass


def fit_graph(payload: dict, report_progress=None) -> dict:
    """Fit posteriors for a single graph.

    This is the compute kernel — no Modal or transport dependencies.
    Fires webhook on completion. Returns a diagnostic result dict.

    Args:
        payload: FE submit payload containing graph_snapshot, parameter_files,
                 settings, webhook_url, callback_token, db_connection, etc.
        report_progress: optional callback(stage, pct, detail) for status updates.

    Settings flags:
        settings.placeholder: if true, skip MCMC and return shifted placeholder
            posteriors. Used by the E2E roundtrip test to exercise the full
            submit → webhook → git commit → FE pull pipeline without needing
            PyMC or real inference.
    """
    settings = payload.get("settings") or {}
    if settings.get("placeholder"):
        return _fit_graph_placeholder(payload, report_progress)

    return _fit_graph_compiler(payload, report_progress)


def _fit_graph_placeholder(payload: dict, report_progress=None) -> dict:
    """Placeholder mode: shifted posteriors, no MCMC.

    Produces the same webhook payload shape as the real compiler but with
    fake values derived from the analytic params. Used by the E2E roundtrip
    test so it can validate the full async pipeline without importing PyMC.
    """
    import requests as http

    report = report_progress or _noop_progress
    log: list[str] = []
    t0 = time.time()
    error = None
    webhook_response = None

    try:
        report("startup", 5, "Placeholder mode…")

        # DB connectivity check (same as real path)
        db_url = payload.get("db_connection", "")
        if db_url:
            import psycopg2
            conn = psycopg2.connect(db_url)
            cur = conn.cursor()
            cur.execute("SELECT 1")
            cur.close()
            conn.close()
            log.append("connected to Neon (placeholder mode)")
        else:
            log.append("no db_connection — skipping DB check")

        report("fitting", 20, "Building placeholder posteriors…")

        param_files = payload.get("parameter_files", {})
        params_index = payload.get("parameters_index", {})
        param_id_to_path = _build_path_lookup(params_index)

        edges = []
        for param_id, pf_data in param_files.items():
            if not isinstance(pf_data, dict):
                pf_data = {}

            file_path = param_id_to_path.get(param_id, "")
            if not file_path:
                bare = param_id.replace("parameter-", "", 1) if param_id.startswith("parameter-") else param_id
                file_path = f"parameters/{bare}.yaml"

            # Read analytic p and shift toward 0.5 by 10%
            p_mean = 0.5
            vals = pf_data.get("values", [])
            if vals and isinstance(vals[0], dict):
                p_mean = vals[0].get("mean", 0.5) or 0.5
            bayes_mean = p_mean + (0.5 - p_mean) * 0.1
            bayes_mean = max(0.01, min(0.99, bayes_mean))
            pseudo_n = 200
            alpha = bayes_mean * pseudo_n
            beta_val = (1 - bayes_mean) * pseudo_n
            stdev = math.sqrt(alpha * beta_val / ((alpha + beta_val) ** 2 * (alpha + beta_val + 1)))

            edge_entry = {
                "param_id": param_id,
                "file_path": file_path,
                "probability": {
                    "alpha": round(alpha, 2),
                    "beta": round(beta_val, 2),
                    "mean": round(bayes_mean, 4),
                    "stdev": round(stdev, 4),
                    "hdi_lower": round(max(0, bayes_mean - 1.645 * stdev), 4),
                    "hdi_upper": round(min(1, bayes_mean + 1.645 * stdev), 4),
                    "hdi_level": 0.9,
                    "ess": pseudo_n,
                    "rhat": 1.002,
                    "provenance": "bayesian",
                },
            }

            lat = pf_data.get("latency") or {}
            analytic_mu = lat.get("mu")
            analytic_sigma = lat.get("sigma")
            if isinstance(analytic_mu, (int, float)) and isinstance(analytic_sigma, (int, float)):
                bayes_mu = analytic_mu * 1.05
                bayes_sigma = max(0.1, analytic_sigma * 0.95)
                onset = lat.get("onset_delta_days", 0) or 0
                edge_entry["latency"] = {
                    "mu_mean": round(bayes_mu, 4),
                    "mu_sd": round(abs(bayes_mu) * 0.03, 4),
                    "sigma_mean": round(bayes_sigma, 4),
                    "sigma_sd": round(bayes_sigma * 0.05, 4),
                    "hdi_t95_lower": round(math.exp(bayes_mu + 1.28 * bayes_sigma) + onset, 1),
                    "hdi_t95_upper": round(math.exp(bayes_mu + 2.0 * bayes_sigma) + onset, 1),
                    "hdi_level": 0.9,
                    "ess": 180,
                    "rhat": 1.005,
                    "provenance": "bayesian",
                }

            edges.append(edge_entry)

        log.append(f"placeholder posteriors for {len(edges)} edges")
        report("webhook", 85, "Firing webhook…")

        # Fire webhook (same as real path)
        webhook_url = payload.get("webhook_url", "")
        callback_token = payload.get("callback_token", "")
        if webhook_url:
            webhook_body = {
                "job_id": payload.get("_job_id", "unknown"),
                "graph_id": payload.get("graph_id", "unknown"),
                "repo": payload.get("repo", ""),
                "branch": payload.get("branch", ""),
                "graph_file_path": payload.get("graph_file_path", ""),
                "fingerprint": f"placeholder-{int(time.time())}",
                "fitted_at": datetime.utcnow().strftime("%-d-%b-%y"),
                "quality": {"max_rhat": 0.0, "min_ess": 0, "converged_pct": 0.0},
                "edges": edges,
                "skipped": [],
            }
            resp = http.post(
                webhook_url,
                headers={"x-bayes-callback": callback_token, "Content-Type": "application/json"},
                json=webhook_body,
                timeout=30,
            )
            webhook_response = {
                "status": resp.status_code,
                "body": (
                    resp.json()
                    if resp.headers.get("content-type", "").startswith("application/json")
                    else resp.text[:500]
                ),
            }
            log.append(f"webhook POST {resp.status_code}")
            if resp.status_code >= 400:
                error = f"webhook returned {resp.status_code}"
        else:
            log.append("no webhook_url — skipping webhook")

        report("complete", 100)

    except Exception as e:
        import traceback
        error = str(e)
        log.append(f"ERROR: {error}")
        log.append(traceback.format_exc())

    return _build_result(error, log, {}, t0, edges if not error else [], [], {"max_rhat": 0.0, "min_ess": 0, "converged_pct": 0.0}, webhook_response)


def _fit_graph_compiler(payload: dict, report_progress=None) -> dict:
    """Real compiler mode: topology → evidence → PyMC model → MCMC → posteriors."""
    import requests as http

    report = report_progress or _noop_progress

    log: list[str] = []
    timings: dict[str, int] = {}
    t0 = time.time()
    error = None
    webhook_response = None
    result_edges: list[dict] = []
    result_skipped: list[dict] = []
    quality_dict = {"max_rhat": 0.0, "min_ess": 0, "converged_pct": 0.0}

    try:
        # ── 1. DB connection ──
        report("startup", 0, "Connecting to database…")
        db_url = payload.get("db_connection", "")
        db_conn = None
        if db_url:
            import psycopg2
            t_db = time.time()
            db_conn = psycopg2.connect(db_url)
            cur = db_conn.cursor()
            cur.execute("SELECT 1")
            cur.close()
            log.append(f"connected to Neon ({int((time.time() - t_db) * 1000)}ms)")
        else:
            log.append("no db_connection — skipping DB")
        timings["neon_ms"] = int((time.time() - t0) * 1000)

        # ── 2. Compile: topology analysis ──
        report("compiling", 0, "Analysing topology…")
        from compiler import analyse_topology, bind_evidence, build_model
        from compiler import run_inference, summarise_posteriors
        from compiler.types import SamplingConfig

        graph_snapshot = payload.get("graph_snapshot", {})
        param_files = payload.get("parameter_files", {})
        params_index = payload.get("parameters_index", {})
        settings = payload.get("settings", {})

        topology = analyse_topology(graph_snapshot)
        log.append(
            f"topology: {len(topology.edges)} edges, "
            f"{len(topology.branch_groups)} branch groups, "
            f"anchor={topology.anchor_node_id[:8]}…"
        )
        for d in topology.diagnostics:
            log.append(f"  topo: {d}")
        timings["topology_ms"] = int((time.time() - t0) * 1000) - timings.get("neon_ms", 0)

        # ── 3. Compile: evidence binding ──
        report("compiling", 0, "Binding evidence…")
        snapshot_subjects = payload.get("snapshot_subjects", [])
        snapshot_rows: dict[str, list[dict]] = {}

        if snapshot_subjects and db_url:
            # Phase S: query snapshot DB for rich maturation trajectories.
            # Set DB_CONNECTION so snapshot_service.get_db_connection() works
            # (same env var the BE analysis path uses).
            os.environ["DB_CONNECTION"] = db_url
            report("compiling", 0, "Querying snapshot DB…")
            t_snap = time.time()
            snapshot_rows = _query_snapshot_subjects(
                snapshot_subjects, topology, log,
            )
            snap_ms = int((time.time() - t_snap) * 1000)
            log.append(
                f"snapshot DB: {len(snapshot_subjects)} subjects queried, "
                f"{sum(len(v) for v in snapshot_rows.values())} rows fetched "
                f"({snap_ms}ms)"
            )
        elif snapshot_subjects and not db_url:
            log.append("snapshot_subjects provided but no db_connection — falling back to param files")

        if snapshot_rows:
            from compiler import bind_snapshot_evidence
            evidence = bind_snapshot_evidence(
                topology, snapshot_rows, param_files, params_index, settings,
            )
        else:
            evidence = bind_evidence(
                topology, param_files, params_index, settings,
            )

        n_with_data = sum(1 for e in evidence.edges.values() if not e.skipped)
        n_skipped = sum(1 for e in evidence.edges.values() if e.skipped)
        log.append(f"evidence: {n_with_data} edges with data, {n_skipped} skipped")
        for d in evidence.diagnostics:
            log.append(f"  evidence: {d}")

        # Intermediate evidence summary — what data is the model actually getting?
        for edge_id, edge_ev in evidence.edges.items():
            if edge_ev.skipped:
                continue
            n_cohort_obs = len(edge_ev.cohort_obs)
            n_window_traj = 0
            n_cohort_traj = 0
            n_window_daily = 0
            n_cohort_daily = 0
            for co in edge_ev.cohort_obs:
                for t in co.trajectories:
                    if t.obs_type == "window":
                        n_window_traj += 1
                    else:
                        n_cohort_traj += 1
                for d in co.daily:
                    # daily obs don't have obs_type yet; infer from slice_dsl
                    if "window" in co.slice_dsl:
                        n_window_daily += 1
                    else:
                        n_cohort_daily += 1
            has_snapshot = n_window_traj + n_cohort_traj + n_window_daily + n_cohort_daily > 0
            log.append(
                f"  evidence detail {edge_id[:8]}…: "
                f"source={'snapshot' if has_snapshot else 'param_file'}, "
                f"window_traj={n_window_traj}, cohort_traj={n_cohort_traj}, "
                f"window_daily={n_window_daily}, cohort_daily={n_cohort_daily}"
            )

        timings["evidence_ms"] = int((time.time() - t0) * 1000) - timings.get("neon_ms", 0) - timings.get("topology_ms", 0)

        if n_with_data == 0:
            log.append("no edges with data — skipping inference")
            error = "no edges with data"
            report("complete", 100)
            return _build_result(
                error, log, timings, t0, result_edges, result_skipped,
                quality_dict, webhook_response,
            )

        # ── 4. Build model ──
        report("compiling", 0, "Building model…")
        model, metadata = build_model(topology, evidence)
        log.append(f"model: {len(model.free_RVs)} free vars, {len(model.observed_RVs)} observed")
        for d in metadata.get("diagnostics", []):
            log.append(f"  model: {d}")

        # ── 5. Run inference ──
        sampling_config = SamplingConfig(
            draws=settings.get("draws", 2000),
            tune=settings.get("tune", 1000),
            chains=settings.get("chains", 4),
            cores=settings.get("cores", 4),
            target_accept=settings.get("target_accept", 0.90),
            random_seed=settings.get("random_seed"),
        )

        t_sample = time.time()
        trace, quality = run_inference(model, sampling_config, report)
        timings["sampling_ms"] = int((time.time() - t_sample) * 1000)
        log.append(
            f"sampling: {timings['sampling_ms']}ms, "
            f"rhat={quality.max_rhat:.3f}, ess={quality.min_ess:.0f}, "
            f"divergences={quality.total_divergences}"
        )

        # ── 6. Summarise posteriors ──
        report("summarising", 100, "Summarising posteriors…")
        inference_result = summarise_posteriors(trace, topology, evidence, metadata, quality)

        quality_dict = {
            "max_rhat": round(quality.max_rhat, 4),
            "min_ess": round(quality.min_ess, 1),
            "converged_pct": quality.converged_pct,
        }

        # ── 7. Format webhook edges ──
        # Build param_id → file_path lookup
        param_id_to_path = _build_path_lookup(params_index)

        for post in inference_result.posteriors:
            edge_entry: dict = {
                "param_id": post.param_id,
                "file_path": _resolve_file_path(post.param_id, evidence, param_id_to_path),
                "probability": post.to_webhook_dict(),
            }

            # Latency posterior (Phase A: point estimate echo)
            lat_post = inference_result.latency_posteriors.get(post.edge_id)
            if lat_post:
                edge_entry["latency"] = lat_post.to_webhook_dict()

            result_edges.append(edge_entry)

        result_skipped = inference_result.skipped
        for d in inference_result.diagnostics:
            log.append(f"  inference: {d}")

        log.append(f"posteriors: {len(result_edges)} edges, {len(result_skipped)} skipped")

        # ── 8. Fire webhook ──
        report("delivering", 100, "Delivering results…")
        webhook_url = payload.get("webhook_url", "")
        callback_token = payload.get("callback_token", "")

        if webhook_url:
            graph_id = payload.get("graph_id", "unknown")
            webhook_body = {
                "job_id": payload.get("_job_id", "unknown"),
                "graph_id": graph_id,
                "repo": payload.get("repo", ""),
                "branch": payload.get("branch", ""),
                "graph_file_path": payload.get("graph_file_path", ""),
                "fingerprint": topology.fingerprint,
                "fitted_at": datetime.utcnow().strftime("%-d-%b-%y"),
                "quality": quality_dict,
                "edges": result_edges,
                "skipped": result_skipped,
            }

            t_wh = time.time()
            resp = http.post(
                webhook_url,
                headers={
                    "x-bayes-callback": callback_token,
                    "Content-Type": "application/json",
                },
                json=webhook_body,
                timeout=30,
            )
            webhook_response = {
                "status": resp.status_code,
                "body": (
                    resp.json()
                    if resp.headers.get("content-type", "").startswith("application/json")
                    else resp.text[:500]
                ),
            }
            log.append(f"webhook POST {resp.status_code} ({int((time.time() - t_wh) * 1000)}ms)")
            if resp.status_code >= 400:
                error = f"webhook returned {resp.status_code}"
        else:
            log.append("no webhook_url — skipping webhook")

        report("complete", 100)

    except Exception as e:
        import traceback
        error = str(e)
        log.append(f"ERROR: {error}")
        log.append(traceback.format_exc())
    finally:
        if db_conn:
            try:
                db_conn.close()
            except Exception:
                pass

    return _build_result(
        error, log, timings, t0, result_edges, result_skipped,
        quality_dict, webhook_response,
    )


# ---------------------------------------------------------------------------
# Snapshot DB queries (Phase S)
# ---------------------------------------------------------------------------

def _query_snapshot_subjects(
    snapshot_subjects: list[dict],
    topology,
    log: list[str],
) -> dict[str, list[dict]]:
    """Query snapshot DB for each subject, return rows grouped by edge_id.

    Uses the same snapshot_service.query_snapshots_for_sweep() that the
    BE analysis path uses. The FE sends identical SnapshotSubjectPayload
    shapes for both Bayes and analysis — same fields, same hash-mapping
    ClosureEntry objects.

    Subjects have: param_id, core_hash, slice_keys, anchor_from/to,
    sweep_from/to, equivalent_hashes (ClosureEntry[]), edge_id (or
    target.targetId).
    """
    from datetime import date
    try:
        # Modal: graph-editor/lib is on PYTHONPATH as /root/lib
        from snapshot_service import query_snapshots_for_sweep
    except ImportError:
        # Local dev: add graph-editor/lib to path
        import sys
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'graph-editor', 'lib'))
        from snapshot_service import query_snapshots_for_sweep

    result: dict[str, list[dict]] = {}

    for subj in snapshot_subjects:
        # edge_id: flat field or nested target.targetId (FE flattens it,
        # but handle both for robustness)
        edge_id = subj.get("edge_id", "")
        if not edge_id:
            target = subj.get("target")
            if isinstance(target, dict):
                edge_id = target.get("targetId", "")

        core_hash = subj.get("core_hash", "")
        if not core_hash or not edge_id:
            log.append(f"  snapshot: skipping subject (no core_hash or edge_id)")
            continue

        param_id = subj.get("param_id", "")
        slice_keys = subj.get("slice_keys", [""])
        anchor_from_str = subj.get("anchor_from", "")
        anchor_to_str = subj.get("anchor_to", "")
        sweep_from_str = subj.get("sweep_from", "")
        sweep_to_str = subj.get("sweep_to", "")
        equivalent_hashes = subj.get("equivalent_hashes") or None

        try:
            anchor_from = date.fromisoformat(anchor_from_str) if anchor_from_str else None
            anchor_to = date.fromisoformat(anchor_to_str) if anchor_to_str else None
            sweep_from = date.fromisoformat(sweep_from_str) if sweep_from_str else None
            sweep_to = date.fromisoformat(sweep_to_str) if sweep_to_str else None

            rows = query_snapshots_for_sweep(
                param_id=param_id,
                core_hash=core_hash,
                slice_keys=slice_keys,
                anchor_from=anchor_from,
                anchor_to=anchor_to,
                sweep_from=sweep_from,
                sweep_to=sweep_to,
                equivalent_hashes=equivalent_hashes,
            )

            if rows:
                if edge_id not in result:
                    result[edge_id] = []
                result[edge_id].extend(rows)
                log.append(f"  snapshot: {edge_id[:8]}… → {len(rows)} rows")
            else:
                log.append(f"  snapshot: {edge_id[:8]}… → 0 rows (will fall back to param file)")

        except Exception as e:
            log.append(f"  snapshot: {edge_id[:8]}… query failed: {e}")

    return result


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_result(
    error, log, timings, t0, edges, skipped, quality, webhook_response,
) -> dict:
    duration_ms = int((time.time() - t0) * 1000)
    timings["total_ms"] = duration_ms
    return {
        "status": "failed" if error else "complete",
        "duration_ms": duration_ms,
        "timings": timings,
        "edges_fitted": len(edges) if not error else 0,
        "edges_skipped": len(skipped),
        "quality": quality,
        "warnings": [],
        "log": log,
        "webhook_response": webhook_response,
        "error": error,
    }


def _build_path_lookup(params_index: dict | None) -> dict[str, str]:
    if not params_index:
        return {}
    result: dict[str, str] = {}
    for entry in params_index.get("parameters", []):
        pid = entry.get("id", "")
        fpath = entry.get("file", "")
        if pid and fpath:
            result[pid] = fpath
            result[f"parameter-{pid}"] = fpath
    return result


def _resolve_file_path(
    param_id: str,
    evidence: object,
    path_lookup: dict[str, str],
) -> str:
    """Resolve file_path for a param_id."""
    # Try from evidence binding
    if hasattr(evidence, 'edges'):
        for ev in evidence.edges.values():
            if ev.param_id == param_id and ev.file_path:
                return ev.file_path

    # Try from index lookup
    if param_id in path_lookup:
        return path_lookup[param_id]

    # Fallback
    bare = param_id
    if bare.startswith("parameter-"):
        bare = bare[len("parameter-"):]
    return f"parameters/{bare}.yaml"
