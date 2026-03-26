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


def _log(log_list: list[str], msg: str) -> None:
    """Append to the result log AND print to stdout (visible in Modal logs)."""
    log_list.append(msg)
    print(msg, flush=True)


def _dump_evidence(evidence, topology, path: str, log: list[str]) -> None:
    """Serialise full bound evidence to JSON for forensic inspection."""
    import json
    dump = {}
    for edge_id, ev in evidence.edges.items():
        if ev.skipped:
            continue
        et = topology.edges.get(edge_id)
        edge_name = et.label if et and hasattr(et, 'label') else edge_id[:12]
        edge_dump = {
            "edge_id": edge_id,
            "edge_name": edge_name,
            "has_window": ev.has_window,
            "has_cohort": ev.has_cohort,
            "has_latency": ev.latency_prior is not None and (
                ev.latency_prior.sigma > 0.01 or
                (ev.latency_prior.onset_delta_days or 0) > 0
            ),
            "total_n": ev.total_n,
            "prior": {
                "alpha": ev.prob_prior.alpha,
                "beta": ev.prob_prior.beta,
                "source": ev.prob_prior.source,
            } if ev.prob_prior else None,
            "latency_prior": {
                "mu": ev.latency_prior.mu,
                "sigma": ev.latency_prior.sigma,
                "onset": ev.latency_prior.onset_delta_days,
            } if ev.latency_prior else None,
            "window_obs": [
                {"n": w.n, "k": w.k, "completeness": w.completeness}
                for w in ev.window_obs
            ],
            "cohort_obs": [],
        }
        for c_obs in ev.cohort_obs:
            co_dump = {
                "slice_dsl": c_obs.slice_dsl,
                "trajectories": [],
                "daily": [],
            }
            for traj in c_obs.trajectories:
                co_dump["trajectories"].append({
                    "date": traj.date,
                    "n": traj.n,
                    "obs_type": traj.obs_type,
                    "retrieval_ages": traj.retrieval_ages,
                    "cumulative_y": traj.cumulative_y,
                    "cumulative_x": getattr(traj, 'cumulative_x', None),
                    "recency_weight": getattr(traj, 'recency_weight', 1.0),
                })
            for d in c_obs.daily:
                co_dump["daily"].append({
                    "date": d.date,
                    "n": d.n,
                    "k": d.k,
                    "age_days": d.age_days,
                    "completeness": d.completeness,
                })
            edge_dump["cohort_obs"].append(co_dump)
        dump[edge_id] = edge_dump

    with open(path, "w") as f:
        json.dump(dump, f, indent=2, default=str)
    _log(log, f"  Evidence dump: {len(dump)} edges → {path} ({os.path.getsize(path)} bytes)")


def _log_env_diagnostic(log: list[str]) -> None:
    """Log CPU, BLAS, and sampler info for debugging performance."""
    import os
    cpu_count = os.cpu_count()
    try:
        cpu_process = os.process_cpu_count()
    except AttributeError:
        cpu_process = cpu_count

    # CPU flags (AVX2/AVX-512 availability)
    avx_flags = ""
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("flags"):
                    flags = line.split(":", 1)[1]
                    avx = []
                    for flag in ("avx", "avx2", "avx512f", "sse4_2", "fma"):
                        if f" {flag} " in f" {flags} ":
                            avx.append(flag)
                    avx_flags = " ".join(avx) if avx else "none"
                    break
    except Exception:
        avx_flags = "unknown"

    # CPU model
    cpu_model = "unknown"
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("model name"):
                    cpu_model = line.split(":", 1)[1].strip()
                    break
    except Exception:
        pass

    # BLAS backend
    blas_info = "unknown"
    try:
        import numpy as np
        cfg = np.show_config(mode="dicts")
        blas_lib = cfg.get("Build Dependencies", {}).get("blas", {})
        blas_info = f"{blas_lib.get('name', '?')} {blas_lib.get('version', '?')}"
    except Exception:
        try:
            import numpy as np
            blas_info = str(np.__config__.blas_opt_info)[:120]
        except Exception:
            pass

    # nutpie version
    nutpie_ver = "not installed"
    try:
        import nutpie
        nutpie_ver = getattr(nutpie, "__version__", "installed (no version)")
    except ImportError:
        pass

    _log(log, f"env: cpu={cpu_model}, cores={cpu_count} (process={cpu_process}), "
         f"flags=[{avx_flags}], blas={blas_info}, nutpie={nutpie_ver}")


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
            _log(log,"connected to Neon (placeholder mode)")
        else:
            _log(log,"no db_connection — skipping DB check")

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

            # Build unified window() slice (doc 21)
            window_slice = {
                "alpha": round(alpha, 2),
                "beta": round(beta_val, 2),
                "p_hdi_lower": round(max(0, bayes_mean - 1.645 * stdev), 4),
                "p_hdi_upper": round(min(1, bayes_mean + 1.645 * stdev), 4),
                "ess": pseudo_n,
                "rhat": 1.002,
                "divergences": 0,
                "evidence_grade": 0,
                "provenance": "bayesian",
            }

            lat = pf_data.get("latency") or {}
            analytic_mu = lat.get("mu")
            analytic_sigma = lat.get("sigma")
            if isinstance(analytic_mu, (int, float)) and isinstance(analytic_sigma, (int, float)):
                bayes_mu = analytic_mu * 1.05
                bayes_sigma = max(0.1, analytic_sigma * 0.95)
                onset = lat.get("onset_delta_days", 0) or 0
                window_slice.update({
                    "mu_mean": round(bayes_mu, 4),
                    "mu_sd": round(abs(bayes_mu) * 0.03, 4),
                    "sigma_mean": round(bayes_sigma, 4),
                    "sigma_sd": round(bayes_sigma * 0.05, 4),
                    "onset_mean": round(onset, 2),
                    "onset_sd": 0.5,
                    "hdi_t95_lower": round(math.exp(bayes_mu + 1.28 * bayes_sigma) + onset, 1),
                    "hdi_t95_upper": round(math.exp(bayes_mu + 2.0 * bayes_sigma) + onset, 1),
                })

            edge_entry = {
                "param_id": param_id,
                "file_path": file_path,
                "slices": {"window()": window_slice},
                "_model_state": {},
                "prior_tier": "uninformative",
                "evidence_grade": 0,
                "divergences": 0,
            }

            edges.append(edge_entry)

        _log(log,f"placeholder posteriors for {len(edges)} edges")
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
                "fitted_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
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
            _log(log,f"webhook POST {resp.status_code}")
            if resp.status_code >= 400:
                error = f"webhook returned {resp.status_code}"
        else:
            _log(log,"no webhook_url — skipping webhook")

        report("complete", 100)

    except Exception as e:
        import traceback
        error = str(e)
        _log(log,f"ERROR: {error}")
        _log(log,traceback.format_exc())

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
        # ── 0. Environment diagnostic ──
        _log_env_diagnostic(log)

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
            _log(log,f"connected to Neon ({int((time.time() - t_db) * 1000)}ms)")
        else:
            _log(log,"no db_connection — skipping DB")
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
        _log(log,
            f"topology: {len(topology.edges)} edges, "
            f"{len(topology.branch_groups)} branch groups, "
            f"anchor={topology.anchor_node_id[:8]}…"
        )
        for d in topology.diagnostics:
            _log(log,f"  topo: {d}")
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
            _log(log,
                f"snapshot DB: {len(snapshot_subjects)} subjects queried, "
                f"{sum(len(v) for v in snapshot_rows.values())} rows fetched "
                f"({snap_ms}ms)"
            )
        elif snapshot_subjects and not db_url:
            _log(log,"snapshot_subjects provided but no db_connection — falling back to param files")

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
        _log(log,f"evidence: {n_with_data} edges with data, {n_skipped} skipped")
        for d in evidence.diagnostics:
            _log(log,f"  evidence: {d}")

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
            _log(log,
                f"  evidence detail {edge_id[:8]}…: "
                f"source={'snapshot' if has_snapshot else 'param_file'}, "
                f"window_traj={n_window_traj}, cohort_traj={n_cohort_traj}, "
                f"window_daily={n_window_daily}, cohort_daily={n_cohort_daily}"
            )

        timings["evidence_ms"] = int((time.time() - t0) * 1000) - timings.get("neon_ms", 0) - timings.get("topology_ms", 0)

        # ── Dump evidence (forensic diagnostic) ──
        dump_path = settings.get("dump_evidence_path")
        if dump_path:
            _dump_evidence(evidence, topology, dump_path, log)
            _log(log, f"Evidence dumped to {dump_path} — stopping.")
            report("complete", 100, "Evidence dump complete")
            return _build_result(
                None, log, timings, t0, result_edges, result_skipped,
                quality_dict, webhook_response,
            )

        if n_with_data == 0:
            _log(log,"no edges with data — skipping inference")
            error = "no edges with data"
            report("complete", 100)
            return _build_result(
                error, log, timings, t0, result_edges, result_skipped,
                quality_dict, webhook_response,
            )

        # ── 4. Build model ──
        report("compiling", 0, "Building model…")
        features = settings.get("features") or {}
        model, metadata = build_model(topology, evidence, features=features)
        _log(log,f"model: {len(model.free_RVs)} free vars, {len(model.observed_RVs)} observed")
        for d in metadata.get("diagnostics", []):
            _log(log,f"  model: {d}")

        # ── 4b. Model inspection (always runs) ──
        from compiler import inspect_model
        inspection = inspect_model(model, metadata, topology, evidence)
        for line in inspection:
            _log(log,line)

        # Stop here if model_inspect_only — no MCMC
        if settings.get("model_inspect_only"):
            _log(log,"MODEL INSPECT ONLY — stopping before MCMC")
            report("complete", 100, "Model inspection complete")
            return _build_result(
                None, log, timings, t0, result_edges, result_skipped,
                quality_dict, webhook_response,
            )

        # ── 5. Run inference ──
        sampling_config = SamplingConfig(
            draws=settings.get("draws", 2000),
            tune=settings.get("tune", 1000),
            chains=settings.get("chains", 4),
            cores=settings.get("cores"),
            target_accept=settings.get("target_accept", 0.90),
            random_seed=settings.get("random_seed"),
        )

        t_sample = time.time()
        trace, quality = run_inference(model, sampling_config, report)
        timings["sampling_ms"] = int((time.time() - t_sample) * 1000)
        _log(log,
            f"sampling: {timings['sampling_ms']}ms, "
            f"rhat={quality.max_rhat:.3f}, ess={quality.min_ess:.0f}, "
            f"divergences={quality.total_divergences}"
        )

        # ── 6. Summarise Phase 1 posteriors ──
        report("summarising", 100, "Computing diagnostics…")
        inference_result = summarise_posteriors(trace, topology, evidence, metadata, quality)

        # ── 6b. Phase 2: cohort pass with frozen Phase 1 results ──
        # Extract Phase 1 posterior means and build Phase 2 model.
        has_cohort_data = any(
            ev.has_cohort for ev in evidence.edges.values() if not ev.skipped
        )
        if has_cohort_data and not settings.get("model_inspect_only"):
            report("compiling", 0, "Phase 2: building cohort model…")
            _log(log, "")
            _log(log, "── Phase 2: cohort pass ──")

            # Extract frozen values from Phase 1 trace
            phase2_frozen = {}
            for edge_id in topology.topo_order:
                et = topology.edges.get(edge_id)
                ev = evidence.edges.get(edge_id)
                if et is None or ev is None or ev.skipped:
                    continue
                safe_eid = edge_id.replace("-", "_")

                # p: from Phase 1 trace or edge_var_names
                frozen_edge = {}
                p_name = f"p_{safe_eid}"
                if p_name in trace.posterior:
                    frozen_edge["p"] = float(trace.posterior[p_name].values.mean())
                elif ev.prob_prior:
                    frozen_edge["p"] = ev.prob_prior.alpha / (ev.prob_prior.alpha + ev.prob_prior.beta)

                # Latency: mu, sigma, onset from Phase 1 trace
                mu_name = f"mu_lat_{safe_eid}"
                sigma_name = f"sigma_lat_{safe_eid}"
                onset_name = f"onset_{safe_eid}"
                if mu_name in trace.posterior:
                    frozen_edge["mu"] = float(trace.posterior[mu_name].values.mean())
                if sigma_name in trace.posterior:
                    frozen_edge["sigma"] = float(trace.posterior[sigma_name].values.mean())
                if onset_name in trace.posterior:
                    frozen_edge["onset"] = float(trace.posterior[onset_name].values.mean())

                if frozen_edge:
                    phase2_frozen[edge_id] = frozen_edge
                    _log(log, f"  frozen {edge_id[:8]}…: {frozen_edge}")

            # Build Phase 2 model
            model2, metadata2 = build_model(
                topology, evidence, features=features,
                phase2_frozen=phase2_frozen,
            )
            _log(log, f"  Phase 2 model: {len(model2.free_RVs)} free vars, "
                       f"{len(model2.observed_RVs)} observed, "
                       f"{len(model2.potentials)} potentials")
            for d in metadata2.get("diagnostics", []):
                _log(log, f"  model2: {d}")

            # Phase 2 model inspection
            inspection2 = inspect_model(model2, metadata2, topology, evidence)
            for line in inspection2:
                _log(log, line)

            # Run Phase 2 MCMC
            report("sampling", 0, "Phase 2: sampling cohort model…")
            t_sample2 = time.time()
            trace2, quality2 = run_inference(model2, sampling_config, report)
            timings["sampling_phase2_ms"] = int((time.time() - t_sample2) * 1000)
            _log(log,
                f"  Phase 2 sampling: {timings['sampling_phase2_ms']}ms, "
                f"rhat={quality2.max_rhat:.3f}, ess={quality2.min_ess:.0f}, "
                f"divergences={quality2.total_divergences}"
            )

            # Log Phase 2 p_cohort values directly from trace
            for edge_id in topology.topo_order:
                safe_eid = edge_id.replace("-", "_")
                p_cohort_name = f"p_cohort_{safe_eid}"
                if p_cohort_name in trace2.posterior:
                    samples = trace2.posterior[p_cohort_name].values.flatten()
                    _log(log, f"  Phase 2 p_cohort {edge_id[:8]}…: "
                              f"mean={samples.mean():.4f} std={samples.std():.4f}")

            # Summarise Phase 2 — cohort posteriors
            report("summarising", 100, "Summarising Phase 2…")
            inference_result2 = summarise_posteriors(
                trace2, topology, evidence, metadata2, quality2,
            )

            # Merge Phase 2 cohort results into Phase 1 results.
            # Phase 2 provides cohort slice posteriors and cohort latency.
            for post2 in inference_result2.posteriors:
                # Find matching Phase 1 posterior
                for post1 in inference_result.posteriors:
                    if post1.edge_id == post2.edge_id:
                        # Merge cohort alpha/beta from Phase 2
                        if post2.cohort_alpha is not None:
                            post1.cohort_alpha = post2.cohort_alpha
                            post1.cohort_beta = post2.cohort_beta
                            post1.cohort_hdi_lower = post2.cohort_hdi_lower
                            post1.cohort_hdi_upper = post2.cohort_hdi_upper
                        break

            # Merge cohort latency posteriors from Phase 2.
            # Copy any cohort-specific latency fields that exist.
            for eid, lat2 in inference_result2.latency_posteriors.items():
                lat1 = inference_result.latency_posteriors.get(eid)
                if lat1:
                    for attr in ('cohort_onset', 'cohort_mu', 'cohort_sigma',
                                 'cohort_onset_std', 'cohort_mu_std', 'cohort_sigma_std'):
                        val = getattr(lat2, attr, None)
                        if val is not None:
                            setattr(lat1, attr, val)

            for d in inference_result2.diagnostics:
                _log(log, f"  inference2: {d}")

        quality_dict = {
            "max_rhat": round(quality.max_rhat, 4),
            "min_ess": round(quality.min_ess, 1),
            "converged_pct": quality.converged_pct,
        }

        # ── 7. Format webhook edges ──
        # Build param_id → file_path lookup
        param_id_to_path = _build_path_lookup(params_index)

        for post in inference_result.posteriors:
            lat_post = inference_result.latency_posteriors.get(post.edge_id)
            slices = _build_unified_slices(post, lat_post)

            edge_entry: dict = {
                "param_id": post.param_id,
                "file_path": _resolve_file_path(post.param_id, evidence, param_id_to_path),
                "slices": slices,
                "_model_state": inference_result.model_state,
                "prior_tier": post.prior_tier,
                "evidence_grade": 3 if post.ess >= 400 and (not post.rhat or post.rhat < 1.05) else 0,
                "divergences": post.divergences,
            }

            result_edges.append(edge_entry)

        result_skipped = inference_result.skipped
        for d in inference_result.diagnostics:
            _log(log,f"  inference: {d}")

        _log(log,f"posteriors: {len(result_edges)} edges, {len(result_skipped)} skipped")

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
                "fitted_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
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
            _log(log,f"webhook POST {resp.status_code} ({int((time.time() - t_wh) * 1000)}ms)")
            if resp.status_code >= 400:
                error = f"webhook returned {resp.status_code}"
        else:
            _log(log,"no webhook_url — skipping webhook")

        report("complete", 100)

    except Exception as e:
        import traceback
        error = str(e)
        _log(log,f"ERROR: {error}")
        _log(log,traceback.format_exc())
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
            _log(log,f"  snapshot: skipping subject (no core_hash or edge_id)")
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
                _log(log,f"  snapshot: {edge_id[:8]}… → {len(rows)} rows")
            else:
                _log(log,f"  snapshot: {edge_id[:8]}… → 0 rows (will fall back to param file)")

        except Exception as e:
            # Debug: log the types of each param to trace 'can't adapt type' errors
            eh_types = f", equiv_hashes types={[type(h).__name__ for h in (equivalent_hashes or [])]}" if equivalent_hashes else ""
            _log(log,f"  snapshot: {edge_id[:8]}… query failed: {e} [slice_keys={slice_keys}{eh_types}]")

    return result


# ---------------------------------------------------------------------------
# Unified slice construction (doc 21)
# ---------------------------------------------------------------------------

def _build_unified_slices(
    prob: object,
    lat: object | None,
) -> dict[str, dict]:
    """Combine PosteriorSummary + LatencyPosteriorSummary into unified slices.

    Produces:
      "window()" — probability + edge-level latency
      "cohort()" — probability + path-level latency (only if path fields exist)
    """
    # Window slice: probability (from p_window if available, else p_base) + edge-level latency
    w_alpha = prob.window_alpha if prob.window_alpha is not None else prob.alpha
    w_beta = prob.window_beta if prob.window_beta is not None else prob.beta
    w_hdi_lo = prob.window_hdi_lower if prob.window_hdi_lower is not None else prob.hdi_lower
    w_hdi_hi = prob.window_hdi_upper if prob.window_hdi_upper is not None else prob.hdi_upper

    window: dict = {
        "alpha": round(w_alpha, 4),
        "beta": round(w_beta, 4),
        "p_hdi_lower": round(w_hdi_lo, 6),
        "p_hdi_upper": round(w_hdi_hi, 6),
        "ess": round(prob.ess, 1),
        "rhat": round(prob.rhat, 4) if prob.rhat else None,
        "divergences": prob.divergences,
        "evidence_grade": 3 if prob.ess >= 400 and (not prob.rhat or prob.rhat < 1.05) else 0,
        "provenance": prob.provenance,
    }

    if lat:
        window["mu_mean"] = round(lat.mu_mean, 4)
        window["mu_sd"] = round(lat.mu_sd, 4)
        window["sigma_mean"] = round(lat.sigma_mean, 4)
        window["sigma_sd"] = round(lat.sigma_sd, 4)
        window["onset_mean"] = round(lat.onset_delta_days, 2)
        if lat.onset_sd is not None:
            window["onset_sd"] = round(lat.onset_sd, 2)
        window["hdi_t95_lower"] = round(lat.hdi_t95_lower, 1)
        window["hdi_t95_upper"] = round(lat.hdi_t95_upper, 1)
        if lat.onset_mu_corr is not None:
            window["onset_mu_corr"] = round(lat.onset_mu_corr, 3)
        # Use worst-of for combined quality
        window["ess"] = round(min(prob.ess, lat.ess), 1)
        window["rhat"] = round(max(prob.rhat or 0, lat.rhat or 0), 4) or None

    slices = {"window()": window}

    # Cohort slice: probability (from p_cohort if available, else p_base) + path-level latency
    if lat and lat.path_mu_mean is not None:
        c_alpha = prob.cohort_alpha if prob.cohort_alpha is not None else prob.alpha
        c_beta = prob.cohort_beta if prob.cohort_beta is not None else prob.beta
        c_hdi_lo = prob.cohort_hdi_lower if prob.cohort_hdi_lower is not None else prob.hdi_lower
        c_hdi_hi = prob.cohort_hdi_upper if prob.cohort_hdi_upper is not None else prob.hdi_upper

        cohort: dict = {
            "alpha": round(c_alpha, 4),
            "beta": round(c_beta, 4),
            "p_hdi_lower": round(c_hdi_lo, 6),
            "p_hdi_upper": round(c_hdi_hi, 6),
            "ess": round(prob.ess, 1),
            "rhat": round(prob.rhat, 4) if prob.rhat else None,
            "divergences": prob.divergences,
            "evidence_grade": 3 if prob.ess >= 400 and (not prob.rhat or prob.rhat < 1.05) else 0,
            "provenance": lat.path_provenance or lat.provenance,
            "mu_mean": round(lat.path_mu_mean, 4),
            "mu_sd": round(lat.path_mu_sd, 4) if lat.path_mu_sd is not None else None,
            "sigma_mean": round(lat.path_sigma_mean, 4) if lat.path_sigma_mean is not None else None,
            "sigma_sd": round(lat.path_sigma_sd, 4) if lat.path_sigma_sd is not None else None,
            "hdi_t95_lower": round(lat.hdi_t95_lower, 1),  # TODO: path-level t95 HDI
            "hdi_t95_upper": round(lat.hdi_t95_upper, 1),
        }
        if lat.path_onset_delta_days is not None:
            cohort["onset_mean"] = round(lat.path_onset_delta_days, 2)
        if lat.path_onset_sd is not None:
            cohort["onset_sd"] = round(lat.path_onset_sd, 2)
        slices["cohort()"] = cohort

    return slices


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
        "webhook_payload_edges": edges,  # for warm-start / harness re-run
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
