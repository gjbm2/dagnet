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


class _ProgressMapper:
    """Maps per-stage progress into a single monotonic 0-100 overall percentage.

    Each pipeline step is assigned a band [lo, hi] of overall percentage.
    Sampling steps (which report their own 0-100) are linearly interpolated
    within their band. Non-sampling steps snap to the band's lo value.
    "complete" always maps to 100.

    Usage:
        pm = _ProgressMapper(raw_callback)
        pm.set_band(5, 15)          # next report() calls map to 5-15%
        report = pm                  # pm is callable
        report("compiling", 0, "…") # emits pct=5
        pm.set_band(15, 55)
        report("sampling", 50, "…") # emits pct=35  (midpoint of 15-55)
    """

    def __init__(self, raw_callback):
        self._raw = raw_callback
        self._lo = 0
        self._hi = 100

    def set_band(self, lo: int, hi: int) -> None:
        self._lo = lo
        self._hi = hi

    def __call__(self, stage: str, pct: int, detail: str = "") -> None:
        if stage == "complete":
            self._raw(stage, 100, detail)
            return
        # Map the raw pct (0-100 within this step) to the band
        overall = self._lo + (pct * (self._hi - self._lo)) // 100
        overall = max(self._lo, min(self._hi, overall))
        self._raw(stage, overall, detail)


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

    progress = _ProgressMapper(report_progress or _noop_progress)
    report = progress  # all report() calls go through the mapper

    log: list[str] = []
    timings: dict[str, int] = {}
    t0 = time.time()
    error = None
    webhook_response = None
    result_edges: list[dict] = []
    result_skipped: list[dict] = []
    quality_dict = {"max_rhat": 0.0, "min_ess": 0, "converged_pct": 0.0}
    binding_receipt = None

    try:
        # ── 0. Environment diagnostic ──
        _log_env_diagnostic(log)

        # ── 1. DB connection ──
        progress.set_band(0, 3)
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
        progress.set_band(3, 5)
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
                candidate_regimes_by_edge=payload.get("candidate_regimes_by_edge"),
            )
            snap_ms = int((time.time() - t_snap) * 1000)
            _log(log,
                f"snapshot DB: {len(snapshot_subjects)} subjects queried, "
                f"{sum(len(v) for v in snapshot_rows.values())} rows fetched "
                f"({snap_ms}ms)"
            )
        elif snapshot_subjects and not db_url:
            _log(log,"snapshot_subjects provided but no db_connection — falling back to param files")

        # Doc 30: apply regime selection per edge if candidate_regimes_by_edge provided.
        candidate_regimes_by_edge = payload.get("candidate_regimes_by_edge")
        # Capture pre-regime row counts and hashes for binding receipt
        rows_raw_per_edge: dict[str, int] = {eid: len(rows) for eid, rows in snapshot_rows.items()}
        hashes_seen_per_edge: dict[str, set] = {
            eid: {r.get('core_hash', '') for r in rows}
            for eid, rows in snapshot_rows.items()
        }
        regime_selections: dict = {}
        if snapshot_rows and candidate_regimes_by_edge and isinstance(candidate_regimes_by_edge, dict):
            try:
                import sys as _sys
                _sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'graph-editor', 'lib'))
                from snapshot_regime_selection import CandidateRegime, select_regime_rows
                for edge_id, edge_rows in list(snapshot_rows.items()):
                    cr_raw = candidate_regimes_by_edge.get(edge_id, [])
                    if not cr_raw:
                        continue
                    regimes = [
                        CandidateRegime(
                            core_hash=r.get('core_hash', ''),
                            equivalent_hashes=[
                                e.get('core_hash', '') if isinstance(e, dict) else str(e)
                                for e in (r.get('equivalent_hashes') or [])
                            ],
                        )
                        for r in cr_raw if isinstance(r, dict) and r.get('core_hash')
                    ]
                    if regimes:
                        selection = select_regime_rows(edge_rows, regimes)
                        regime_selections[edge_id] = selection
                        snapshot_rows[edge_id] = selection.rows
                        n_before = len(edge_rows)
                        n_after = len(selection.rows)
                        if n_before != n_after:
                            _log(log, f"  regime selection {edge_id[:8]}…: {n_before} → {n_after} rows")
            except Exception as e:
                _log(log, f"  regime selection failed (non-blocking): {e}")

        # Detect engorged graph (doc 14 §9A): edges carry _bayes_evidence dicts.
        # When engorged, pass graph_snapshot to bind_snapshot_evidence so it
        # reads priors and file-based evidence from graph edges instead of
        # param files. Snapshot row handling is unchanged.
        is_engorged = any(
            isinstance(e.get("_bayes_evidence"), dict)
            for e in graph_snapshot.get("edges", [])
        )
        if is_engorged:
            _log(log, "evidence: engorged graph detected (doc 14 §9A)")

        # R2-prereq-i: extract commissioned context slices from FE subjects.
        # The binder must only create SliceGroups for slices the FE explicitly
        # commissioned via pinnedDSL, not whatever happens to be in the DB rows.
        commissioned_slices: dict[str, set[str]] = {}
        if snapshot_subjects:
            import re as _re_cs
            for subj in snapshot_subjects:
                eid = subj.get("edge_id") or (subj.get("target", {}) or {}).get("targetId", "")
                if not eid:
                    continue
                for sk in (subj.get("slice_keys") or []):
                    ctx = _re_cs.sub(r'(window|cohort|asat)\([^)]*\)', '', sk).strip('.')
                    ctx = _re_cs.sub(r'\.{2,}', '.', ctx)
                    if ctx:  # non-empty = has context qualifier
                        commissioned_slices.setdefault(eid, set()).add(ctx)
            if commissioned_slices:
                _log(log, f"  commissioned slices: {sum(len(v) for v in commissioned_slices.values())} "
                     f"across {len(commissioned_slices)} edges")

        mece_dimensions: list[str] = payload.get("mece_dimensions") or []
        if mece_dimensions:
            _log(log, f"  MECE dimensions: {mece_dimensions}")

        if snapshot_rows:
            from compiler import bind_snapshot_evidence
            evidence = bind_snapshot_evidence(
                topology, snapshot_rows, param_files, params_index, settings,
                graph_snapshot=graph_snapshot if is_engorged else None,
                commissioned_slices=commissioned_slices or None,
                mece_dimensions=mece_dimensions or None,
                regime_selections=regime_selections or None,
            )
        elif is_engorged:
            from compiler import bind_evidence_from_graph
            evidence = bind_evidence_from_graph(
                topology, graph_snapshot, settings,
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

        # Build binding receipt — structured audit of what evidence was bound
        receipt_mode = settings.get("binding_receipt", "log")
        binding_receipt = _build_binding_receipt(
            topology=topology,
            evidence=evidence,
            snapshot_subjects=snapshot_subjects,
            candidate_regimes_by_edge=candidate_regimes_by_edge or {},
            rows_raw_per_edge=rows_raw_per_edge,
            hashes_seen_per_edge=hashes_seen_per_edge,
            regime_selections=regime_selections,
            mode=receipt_mode,
        )

        # Log receipt summary (replaces ad-hoc evidence detail block)
        _log(log,
            f"binding receipt: {binding_receipt.edges_bound} bound, "
            f"{binding_receipt.edges_fallback} fallback, "
            f"{binding_receipt.edges_skipped} skipped, "
            f"{binding_receipt.edges_no_subjects} no-subjects, "
            f"{binding_receipt.edges_warned} warned, "
            f"{binding_receipt.edges_failed} failed "
            f"(mode={binding_receipt.mode})"
        )
        # Log per-edge receipt summaries. Only log divergences for
        # warn/fail edges to avoid flooding the log on large graphs.
        for eid, er in binding_receipt.edge_receipts.items():
            if er.verdict == "pass" and not er.divergences:
                continue  # skip clean edges in log
            _log(log,
                f"  binding {eid[:8]}…: "
                f"verdict={er.verdict}, "
                f"source={er.evidence_source}, "
                f"rows={er.rows_raw}→{er.rows_post_regime}→{er.total_n}"
            )
            for div in er.divergences:
                # Truncate long divergence messages (e.g. 32-slice lists)
                _log(log, f"    {div[:120]}{'…' if len(div) > 120 else ''}")

        if binding_receipt.mode == "preflight":
            # Preflight mode: always return after receipt, never run MCMC.
            # Used by CLI --preflight for data binding assurance.
            _log(log, f"binding receipt preflight: {binding_receipt.edges_failed} failed, "
                 f"{binding_receipt.edges_warned} warned, {binding_receipt.edges_bound} bound")
            binding_receipt.halted = True
            report("complete", 100)
            return _build_result(
                None if binding_receipt.edges_failed == 0 else
                    f"binding receipt preflight: {binding_receipt.edges_failed} edges failed",
                log, timings, t0, result_edges, result_skipped,
                quality_dict, webhook_response,
                binding_receipt=binding_receipt,
            )

        if binding_receipt.mode == "gate" and binding_receipt.edges_failed > 0:
            error = f"binding receipt gate: {binding_receipt.edges_failed} edges failed"
            _log(log, error)
            binding_receipt.halted = True
            report("complete", 100)
            return _build_result(
                error, log, timings, t0, result_edges, result_skipped,
                quality_dict, webhook_response,
                binding_receipt=binding_receipt,
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
                binding_receipt=binding_receipt,
            )

        if n_with_data == 0:
            _log(log,"no edges with data — skipping inference")
            error = "no edges with data"
            report("complete", 100)
            return _build_result(
                error, log, timings, t0, result_edges, result_skipped,
                quality_dict, webhook_response,
                binding_receipt=binding_receipt,
            )

        # ── 4. Build model ──
        # Determine up front whether Phase 2 (cohort) will run, so progress
        # messages can show "Phase 1 of 2" vs "Phase 1 of 1" and so the
        # overall percentage can be mapped across the full pipeline.
        has_cohort_data = any(
            ev.has_cohort for ev in evidence.edges.values() if not ev.skipped
        )
        n_phases = 2 if has_cohort_data else 1
        phase1_label = f"Phase 1 of {n_phases}"

        # Overall % bands: compile and sample each get a chunk, scaled
        # by whether there are 1 or 2 MCMC phases.
        if n_phases == 2:
            P1_COMPILE = (5, 10)
            P1_SAMPLE  = (10, 48)
            P1_SUMMARISE = (48, 50)
            P2_COMPILE = (50, 55)
            P2_SAMPLE  = (55, 93)
            P2_SUMMARISE = (93, 95)
        else:
            P1_COMPILE = (5, 15)
            P1_SAMPLE  = (15, 90)
            P1_SUMMARISE = (90, 95)

        progress.set_band(*P1_COMPILE)
        report("compiling", 0, f"{phase1_label}: Building model…")
        features = settings.get("features") or {}

        # Log key settings so we can verify what the model actually used
        _bayes_keys = [
            "BAYES_SOFTPLUS_SHARPNESS", "bayes_softplus_sharpness",
            "BAYES_LOG_KAPPA_MU", "BAYES_LOG_KAPPA_SIGMA",
            "BAYES_FALLBACK_PRIOR_ESS", "BAYES_MU_PRIOR_SIGMA_FLOOR",
            "BAYES_DRAWS", "BAYES_TUNE", "BAYES_CHAINS", "BAYES_TARGET_ACCEPT",
        ]
        _found = {k: settings[k] for k in _bayes_keys if k in settings}
        if _found:
            _log(log, f"settings: {_found}")
        else:
            _log(log, "settings: no BAYES_* keys in payload — using module defaults")

        model, metadata = build_model(topology, evidence, features=features, settings=settings)
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
                binding_receipt=binding_receipt,
            )

        # ── 5. Run inference ──
        def _s_int(key_lower: str, key_camel: str, key_upper: str, default: int) -> int:
            return int(settings.get(key_lower, settings.get(key_camel, settings.get(key_upper, default))))

        def _s_float(key_lower: str, key_camel: str, key_upper: str, default: float) -> float:
            return float(settings.get(key_lower, settings.get(key_camel, settings.get(key_upper, default))))

        sampling_config = SamplingConfig(
            draws=_s_int("draws", "bayes_draws", "BAYES_DRAWS", 2000),
            tune=_s_int("tune", "bayes_tune", "BAYES_TUNE", 1000),
            chains=_s_int("chains", "bayes_chains", "BAYES_CHAINS", 4),
            cores=settings.get("cores"),
            target_accept=_s_float("target_accept", "bayes_target_accept", "BAYES_TARGET_ACCEPT", 0.90),
            random_seed=settings.get("random_seed"),
        )

        progress.set_band(*P1_SAMPLE)
        t_sample = time.time()
        trace, quality = run_inference(model, sampling_config, report, phase_label=phase1_label)
        timings["sampling_ms"] = int((time.time() - t_sample) * 1000)
        _log(log,
            f"sampling: {timings['sampling_ms']}ms, "
            f"rhat={quality.max_rhat:.3f}, ess={quality.min_ess:.0f}, "
            f"divergences={quality.total_divergences}"
        )

        # ── 6. LOO-ELPD scoring + Summarise Phase 1 posteriors ──
        progress.set_band(*P1_SUMMARISE)
        report("summarising", 100, f"{phase1_label}: Computing diagnostics…")
        from compiler.loo import compute_loo_scores, extract_analytic_baselines
        analytic_baselines = extract_analytic_baselines(graph_snapshot, topology)
        loo_diag = []
        try:
            loo_scores = compute_loo_scores(
                trace, evidence, topology,
                analytic_baselines=analytic_baselines,
                diagnostics=loo_diag,
            )
        except Exception as e:
            loo_scores = None
            loo_diag.append(f"LOO: failed: {e}")
        for d in loo_diag:
            _log(log, f"  {d}")
        inference_result = summarise_posteriors(trace, topology, evidence, metadata, quality,
                                                settings=settings, loo_scores=loo_scores)

        # ── 6b. Phase 2: cohort pass with frozen Phase 1 results ──
        # Extract Phase 1 posterior means and build Phase 2 model.
        phase2_label = "Phase 2 of 2"
        if has_cohort_data and not settings.get("model_inspect_only"):
            progress.set_band(*P2_COMPILE)
            report("compiling", 0, f"{phase2_label}: Building cohort model…")
            _log(log, "")
            _log(log, "── Phase 2: cohort pass ──")

            # Extract Phase 1 posterior distributions for Phase 2 priors.
            # Approach 3 (posterior-as-prior): carry forward full
            # posterior precision, not just point estimates.
            # See journal 28-Mar-26 "Phase 2 redesign".
            import numpy as _np
            phase2_frozen = {}
            for edge_id in topology.topo_order:
                et = topology.edges.get(edge_id)
                ev = evidence.edges.get(edge_id)
                if et is None or ev is None or ev.skipped:
                    continue
                safe_eid = edge_id.replace("-", "_")

                frozen_edge = {}

                # p: moment-match Phase 1 posterior to Beta(α, β)
                p_name = f"p_{safe_eid}"
                if p_name in trace.posterior:
                    p_samples = trace.posterior[p_name].values.flatten()
                    p_mean = float(p_samples.mean())
                    p_std = float(p_samples.std())
                    frozen_edge["p"] = p_mean
                    frozen_edge["p_sd"] = p_std
                    # Moment-match to Beta
                    if p_std > 1e-6 and 0 < p_mean < 1:
                        v = p_std ** 2
                        common = p_mean * (1 - p_mean) / v - 1
                        if common > 0:
                            frozen_edge["p_alpha"] = max(p_mean * common, 0.5)
                            frozen_edge["p_beta"] = max((1 - p_mean) * common, 0.5)
                elif ev.prob_prior:
                    frozen_edge["p"] = ev.prob_prior.alpha / (ev.prob_prior.alpha + ev.prob_prior.beta)

                # Latency: mean + sd from Phase 1 trace
                mu_name = f"mu_lat_{safe_eid}"
                sigma_name = f"sigma_lat_{safe_eid}"
                onset_name = f"onset_{safe_eid}"
                if mu_name in trace.posterior:
                    mu_s = trace.posterior[mu_name].values.flatten()
                    frozen_edge["mu"] = float(mu_s.mean())
                    frozen_edge["mu_sd"] = float(mu_s.std())
                if sigma_name in trace.posterior:
                    sig_s = trace.posterior[sigma_name].values.flatten()
                    frozen_edge["sigma"] = float(sig_s.mean())
                    frozen_edge["sigma_sd"] = float(sig_s.std())
                if onset_name in trace.posterior:
                    on_s = trace.posterior[onset_name].values.flatten()
                    frozen_edge["onset"] = float(on_s.mean())
                    frozen_edge["onset_sd"] = float(on_s.std())

                if frozen_edge:
                    phase2_frozen[edge_id] = frozen_edge
                    parts = [f"p={frozen_edge.get('p', 0):.4f}±{frozen_edge.get('p_sd', 0):.4f}"]
                    if 'mu' in frozen_edge:
                        parts.append(f"mu={frozen_edge['mu']:.3f}±{frozen_edge['mu_sd']:.3f}")
                    if 'sigma' in frozen_edge:
                        parts.append(f"sigma={frozen_edge['sigma']:.3f}±{frozen_edge['sigma_sd']:.3f}")
                    if 'onset' in frozen_edge:
                        parts.append(f"onset={frozen_edge['onset']:.2f}±{frozen_edge['onset_sd']:.2f}")
                    _log(log, f"  phase1_posterior {edge_id[:8]}…: {', '.join(parts)}")

            # Estimate per-edge drift rate via variogram on mature daily obs.
            #
            # Uses daily (n, k, completeness) observations — NOT trajectories.
            # No CDF division needed: mature daily obs (completeness ≥
            # MATURITY_FLOOR) give clean p = k/n directly.
            #
            # Computes variogram at two lags:
            #   γ(1)  — noise baseline (day-to-day variation)
            #   γ(T)  — noise + drift at the relevant timescale
            # where T = median upstream path latency (anchor → from-node)
            # from the pre-MCMC stats pass (avoids onset-mu circular dep).
            #
            # If γ(T) is not significantly > γ(1), σ²_drift = 0 (no drift).
            # Pairs weighted by min(n_t, n_{t+lag}) to downweight sparse days.
            # Effective sample size at lag T corrected for overlap: n_eff ≈ N/T.
            import math as _math
            from compiler.model import MATURITY_FLOOR as _MAT_FLOOR

            for edge_id, frozen_edge in phase2_frozen.items():
                ev = evidence.edges.get(edge_id)
                et = topology.edges.get(edge_id)
                if ev is None or et is None or not ev.cohort_obs:
                    frozen_edge["drift_sigma2"] = 0.0
                    continue

                # 1. Collect mature daily obs from ALL slice groups.
                #    Per anchor day, keep the highest-completeness entry.
                best_by_day: dict[str, tuple] = {}  # day → (p, n, completeness)
                for c_obs in ev.cohort_obs:
                    if not c_obs.daily:
                        continue
                    for d_obs in c_obs.daily:
                        if d_obs.completeness < _MAT_FLOOR:
                            continue
                        if d_obs.n <= 0:
                            continue
                        k = min(d_obs.k, d_obs.n)
                        p_val = k / d_obs.n
                        day_key = str(d_obs.date) if hasattr(d_obs, 'date') else str(id(d_obs))
                        prev = best_by_day.get(day_key)
                        if prev is None or d_obs.completeness > prev[2]:
                            best_by_day[day_key] = (p_val, d_obs.n, d_obs.completeness)

                sorted_days = sorted(best_by_day.keys())
                n_days = len(sorted_days)

                if n_days < 5:
                    frozen_edge["drift_sigma2"] = 0.0
                    _log(log, f"  drift {edge_id[:8]}…: {n_days} mature daily obs → σ²_drift=0")
                    continue

                p_arr = _np.array([best_by_day[d][0] for d in sorted_days])
                n_arr = _np.array([best_by_day[d][1] for d in sorted_days], dtype=_np.float64)

                # 2. Compute T = median upstream path latency (anchor → from-node).
                #    Uses pre-MCMC topology values (stats pass), not Phase 1
                #    posterior, to avoid onset-mu correlation circular dependency.
                #    Upstream = full path (anchor→target) minus this edge's own
                #    latency contribution.
                t_median = 0.0
                if hasattr(et, 'path_latency') and et.path_latency:
                    pl = et.path_latency
                    full_path_median = (pl.path_delta or 0) + _math.exp(pl.path_mu or 0)
                    if et.has_latency:
                        this_edge_median = (et.onset_delta_days or 0) + _math.exp(et.mu_prior or 0)
                    else:
                        this_edge_median = 0.0
                    t_median = max(full_path_median - this_edge_median, 0.0)
                t_lag = max(int(round(t_median)), 1)

                # 3. Compute γ(1) — noise baseline.
                if n_days >= 2:
                    diff1 = p_arr[1:] - p_arr[:-1]
                    w1 = _np.minimum(n_arr[1:], n_arr[:-1])
                    gamma1 = 0.5 * float(_np.average(diff1 ** 2, weights=w1))
                    n_pairs_1 = len(diff1)
                else:
                    gamma1 = 0.0
                    n_pairs_1 = 0

                # 4. Compute γ(T) — drift-scale variogram.
                if n_days > t_lag:
                    diff_t = p_arr[t_lag:] - p_arr[:-t_lag]
                    w_t = _np.minimum(n_arr[t_lag:], n_arr[:-t_lag])
                    gamma_t = 0.5 * float(_np.average(diff_t ** 2, weights=w_t))
                    n_pairs_t = len(diff_t)
                    n_eff_t = max(n_pairs_t / t_lag, 1.0)  # overlap correction
                else:
                    gamma_t = gamma1
                    n_pairs_t = 0
                    n_eff_t = 0

                # 5. Significance test: is γ(T) > γ(1)?
                significant = False
                drift_sigma2 = 0.0
                if n_eff_t >= 2 and n_pairs_1 >= 2 and gamma1 > 0:
                    se1 = gamma1 / _math.sqrt(max(n_pairs_1, 1))
                    se_t = gamma_t / _math.sqrt(max(n_eff_t, 1))
                    se = _math.sqrt(se1 ** 2 + se_t ** 2)
                    if se > 0:
                        z = (gamma_t - gamma1) / se
                        significant = z > 1.96
                        if significant and t_lag > 1:
                            drift_sigma2 = max(0.0, (gamma_t - gamma1) / (t_lag - 1))

                frozen_edge["drift_sigma2"] = drift_sigma2
                _log(log, f"  drift {edge_id[:8]}…: "
                          f"σ²_drift={drift_sigma2:.8f} "
                          f"({'SIG' if significant else 'ns'}) "
                          f"γ(1)={gamma1:.6f} (n={n_pairs_1}), "
                          f"γ({t_lag})={gamma_t:.6f} (n_eff={n_eff_t:.0f}), "
                          f"n_days={n_days}, "
                          f"F_range=[{min(best_by_day[d][2] for d in sorted_days):.2f}, "
                          f"{max(best_by_day[d][2] for d in sorted_days):.2f}])")

            # Build Phase 2 model
            model2, metadata2 = build_model(
                topology, evidence, features=features,
                phase2_frozen=phase2_frozen,
                settings=settings,
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
            progress.set_band(*P2_SAMPLE)
            t_sample2 = time.time()
            trace2, quality2 = run_inference(model2, sampling_config, report, phase_label=phase2_label)
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
                eps_drift_name = f"eps_drift_{safe_eid}"
                if p_cohort_name in trace2.posterior:
                    samples = trace2.posterior[p_cohort_name].values.flatten()
                    _log(log, f"  Phase 2 p_cohort {edge_id[:8]}…: "
                              f"mean={samples.mean():.4f} std={samples.std():.4f}")
                if eps_drift_name in trace2.posterior:
                    eps = trace2.posterior[eps_drift_name].values.flatten()
                    _log(log, f"  Phase 2 eps_drift {edge_id[:8]}…: "
                              f"mean={eps.mean():.3f} std={eps.std():.3f} "
                              f"range=[{eps.min():.3f}, {eps.max():.3f}]")

            # LOO-ELPD scoring + Summarise Phase 2 — cohort posteriors
            progress.set_band(*P2_SUMMARISE)
            report("summarising", 100, f"{phase2_label}: Computing diagnostics…")
            loo_diag2 = []
            try:
                loo_scores2 = compute_loo_scores(
                    trace2, evidence, topology,
                    analytic_baselines=analytic_baselines,
                    diagnostics=loo_diag2,
                )
            except Exception as e:
                loo_scores2 = None
                loo_diag2.append(f"LOO Phase 2: failed: {e}")
            for d in loo_diag2:
                _log(log, f"  {d}")
            inference_result2 = summarise_posteriors(
                trace2, topology, evidence, metadata2, quality2,
                settings=settings, loo_scores=loo_scores2,
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
            # Phase 2's path-level latency (onset, mu, sigma) overrides
            # Phase 1's cruder FW-composed values on the same attributes.
            for eid, lat2 in inference_result2.latency_posteriors.items():
                lat1 = inference_result.latency_posteriors.get(eid)
                if lat1:
                    for attr in (
                        'path_onset_delta_days', 'path_onset_sd',
                        'path_onset_hdi_lower', 'path_onset_hdi_upper',
                        'path_mu_mean', 'path_mu_sd',
                        'path_sigma_mean', 'path_sigma_sd',
                        'path_hdi_t95_lower', 'path_hdi_t95_upper',
                        'path_provenance',
                    ):
                        val = getattr(lat2, attr, None)
                        if val is not None:
                            setattr(lat1, attr, val)
                        if attr == 'path_hdi_t95_lower':
                            print(f"[DIAG merge] {eid[:20]}: path_hdi_t95_lower lat2={getattr(lat2, 'path_hdi_t95_lower', None)}, "
                                  f"lat1_after={getattr(lat1, 'path_hdi_t95_lower', None)}", flush=True)

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
            if lat_post:
                _log(log, f"  path_hdi_t95 diag {post.edge_id[:20]}: "
                     f"path_hdi_t95_lower={lat_post.path_hdi_t95_lower}, "
                     f"path_hdi_t95_upper={lat_post.path_hdi_t95_upper}, "
                     f"edge_hdi_t95_lower={lat_post.hdi_t95_lower}")
            slices = _build_unified_slices(post, lat_post)
            cohort_s = slices.get('cohort()')
            if cohort_s:
                _log(log, f"  cohort_slice diag {post.edge_id[:20]}: "
                     f"hdi_t95_lower={cohort_s.get('hdi_t95_lower', 'OMITTED')}, "
                     f"mu_mean={cohort_s.get('mu_mean')}")

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
        progress.set_band(95, 100)
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
        binding_receipt=binding_receipt,
    )


# ---------------------------------------------------------------------------
# Binding receipt construction
# ---------------------------------------------------------------------------

def _build_binding_receipt(
    topology,
    evidence,
    snapshot_subjects: list,
    candidate_regimes_by_edge: dict,
    rows_raw_per_edge: dict,
    hashes_seen_per_edge: dict,
    regime_selections: dict,
    mode: str = "log",
):
    """Build a structured binding receipt from evidence binding outcomes.

    Inspects the bound evidence alongside the raw inputs (snapshot subjects,
    regime selections, row counts) to produce a per-edge audit trail with
    verdicts and graph-level summary counts.
    """
    import re as _re
    from compiler.types import EdgeBindingReceipt, BindingReceipt

    def _extract_context_key(slice_dsl: str) -> str:
        """Extract context identity from a full slice_dsl string.

        Strips temporal qualifiers: window(...), cohort(...), asat(...).
        Leaves context(...), visited(...), case(...) etc.
        For uncontexted data, returns "" (matching FE convention).
        """
        stripped = _re.sub(r'(window|cohort|asat)\([^)]*\)', '', slice_dsl)
        stripped = stripped.strip('.')
        stripped = _re.sub(r'\.{2,}', '.', stripped)
        return stripped

    # Group snapshot subjects by edge_id
    subjects_by_edge: dict[str, list[dict]] = {}
    for subj in (snapshot_subjects or []):
        eid = subj.get("edge_id") or subj.get("target", {}).get("targetId", "")
        if eid:
            subjects_by_edge.setdefault(eid, []).append(subj)

    edge_receipts: dict[str, EdgeBindingReceipt] = {}
    n_bound = 0
    n_fallback = 0
    n_skipped = 0
    n_no_subjects = 0
    n_warned = 0
    n_failed = 0

    for edge_id, et in topology.edges.items():
        edge_ev = evidence.edges.get(edge_id)

        er = EdgeBindingReceipt(edge_id=edge_id, param_id=et.param_id or "")

        # Edge not processed by evidence binder at all (e.g. no param_id)
        if not edge_ev:
            edge_subjects = subjects_by_edge.get(edge_id, [])
            if not edge_subjects:
                n_no_subjects += 1
            else:
                n_skipped += 1
            er.evidence_source = "none"
            er.skipped = True
            er.skip_reason = "no evidence (edge not processed by binder)"
            er.verdict = "pass"
            edge_receipts[edge_id] = er
            continue

        # --- Subjects and hash coverage ---
        edge_subjects = subjects_by_edge.get(edge_id, [])
        if not edge_subjects:
            n_no_subjects += 1
            er.evidence_source = "param_file" if not edge_ev.skipped else "none"
            er.skipped = edge_ev.skipped
            er.skip_reason = edge_ev.skip_reason or ""
            if not edge_ev.skipped:
                n_fallback += 1
            else:
                n_skipped += 1
            er.verdict = "pass"
            edge_receipts[edge_id] = er
            continue

        # Collect expected hashes from candidate regimes
        cr_raw = candidate_regimes_by_edge.get(edge_id, [])
        expected_hashes = []
        for cr in cr_raw:
            if isinstance(cr, dict) and cr.get("core_hash"):
                expected_hashes.append(cr["core_hash"])
        er.expected_hashes = expected_hashes

        # Hashes actually seen in raw rows
        seen = hashes_seen_per_edge.get(edge_id, set())
        er.hashes_with_data = sorted(h for h in expected_hashes if h in seen)
        er.hashes_empty = sorted(h for h in expected_hashes if h not in seen)

        # Collect expected slices from subjects, normalised to context-only
        # keys (same treatment as observed slices — strip temporal qualifiers)
        expected_slices_raw = []
        for subj in edge_subjects:
            for sk in (subj.get("slice_keys") or []):
                if sk not in expected_slices_raw:
                    expected_slices_raw.append(sk)
        expected_slices = sorted(set(_extract_context_key(sk) for sk in expected_slices_raw))
        er.expected_slices = expected_slices

        # Anchor range from subjects
        anchor_froms = [s.get("anchor_from", "") for s in edge_subjects if s.get("anchor_from")]
        anchor_tos = [s.get("anchor_to", "") for s in edge_subjects if s.get("anchor_to")]
        if anchor_froms:
            er.expected_anchor_from = min(anchor_froms)
        if anchor_tos:
            er.expected_anchor_to = max(anchor_tos)

        # --- Row counts ---
        er.rows_raw = rows_raw_per_edge.get(edge_id, 0)

        # Regime selection details
        sel = regime_selections.get(edge_id)
        if sel:
            er.rows_post_regime = len(sel.rows)
            er.regimes_seen = len(sel.regime_per_date) if hasattr(sel, 'regime_per_date') else 0
            # Pick the most common regime as regime_selected
            if hasattr(sel, 'regime_per_date') and sel.regime_per_date:
                from collections import Counter
                hash_counts = Counter(
                    r.core_hash for r in sel.regime_per_date.values()
                )
                er.regime_selected = hash_counts.most_common(1)[0][0] if hash_counts else ""
        else:
            er.rows_post_regime = er.rows_raw

        # Suppression counts from EdgeEvidence
        er.rows_post_suppression = edge_ev.rows_post_aggregation
        er.rows_suppressed = edge_ev.rows_aggregated

        # --- Observation counts ---
        w_traj = 0
        w_daily = 0
        c_traj = 0
        c_daily = 0
        observed_slices_raw = set()  # full slice_dsl strings
        actual_anchors = set()

        for co in edge_ev.cohort_obs:
            observed_slices_raw.add(co.slice_dsl)
            for t in co.trajectories:
                if t.obs_type == "window":
                    w_traj += 1
                else:
                    c_traj += 1
                if t.date:
                    actual_anchors.add(t.date)
            for d in co.daily:
                if "window" in co.slice_dsl:
                    w_daily += 1
                else:
                    c_daily += 1
                if d.date:
                    actual_anchors.add(d.date)

        for wo in edge_ev.window_obs:
            observed_slices_raw.add(wo.slice_dsl)

        # Also scan slice_groups — after _route_slices, per-context
        # observations are moved from cohort_obs/window_obs into
        # SliceGroups. The context_key on each SliceObservations is
        # already normalised (no temporal qualifier).
        for dim_key, sg in edge_ev.slice_groups.items():
            for ctx_key in sg.slices:
                observed_slices_raw.add(ctx_key)

        er.window_trajectories = w_traj
        er.window_daily = w_daily
        er.cohort_trajectories = c_traj
        er.cohort_daily = c_daily
        er.total_n = edge_ev.total_n

        # --- Slice comparison ---
        # Both expected and observed slices are normalised to context-only
        # keys via _extract_context_key (strips window/cohort/asat).

        observed_context_keys = set()
        for raw_dsl in observed_slices_raw:
            observed_context_keys.add(_extract_context_key(raw_dsl))

        er.observed_slices = sorted(observed_context_keys)
        er.missing_slices = sorted(s for s in expected_slices if s not in observed_context_keys)
        # The aggregate slice ("") is always present alongside contexted
        # slices — the evidence binder produces both aggregate and
        # per-context observations. Don't flag it as unexpected.
        er.unexpected_slices = sorted(
            s for s in observed_context_keys
            if s not in expected_slices and s != ""
        )

        # --- Anchor coverage ---
        # Dates on trajectories/daily obs may be in ISO format ("2025-08-19")
        # from snapshot DB rows, or UK format ("1-Dec-25") from param file
        # supplementation. Normalise to date objects for correct sorting.
        if actual_anchors:
            from datetime import date as _date
            parsed_anchors = set()
            for d in actual_anchors:
                try:
                    parsed_anchors.add(_date.fromisoformat(d))
                except (ValueError, TypeError):
                    # Try UK format: d-MMM-yy
                    try:
                        from datetime import datetime as _dt
                        parsed_anchors.add(_dt.strptime(d, "%d-%b-%y").date())
                    except (ValueError, TypeError):
                        pass  # unparseable — skip
            if parsed_anchors:
                sorted_anchors = sorted(parsed_anchors)
                er.actual_anchor_from = sorted_anchors[0].isoformat()
                er.actual_anchor_to = sorted_anchors[-1].isoformat()
                er.anchor_days_covered = len(parsed_anchors)

        # Evidence source classification
        has_snapshot = (w_traj + c_traj + w_daily + c_daily) > 0
        has_param = any(
            "param" in co.slice_dsl or "file" in co.slice_dsl
            for co in edge_ev.cohort_obs
        ) or len(edge_ev.window_obs) > 0
        if has_snapshot and has_param:
            er.evidence_source = "mixed"
        elif has_snapshot:
            er.evidence_source = "snapshot"
        elif not edge_ev.skipped:
            er.evidence_source = "param_file"
        else:
            er.evidence_source = "none"

        # Skip state
        er.skipped = edge_ev.skipped
        er.skip_reason = edge_ev.skip_reason

        # Content hash — checksums the assembled model inputs for
        # parity comparison between payload contracts.
        er.evidence_hash = edge_ev.content_hash()

        # --- Verdict ---
        divergences = []

        if er.expected_hashes and all(h in er.hashes_empty for h in er.expected_hashes):
            divergences.append("all expected hashes returned no data")

        if er.rows_raw > 0 and er.total_n == 0:
            divergences.append(
                f"rows_raw={er.rows_raw} but total_n=0 — all data lost in pipeline"
            )

        if er.expected_hashes and er.hashes_empty and not all(h in er.hashes_empty for h in er.expected_hashes):
            divergences.append(
                f"{len(er.hashes_empty)} of {len(er.expected_hashes)} expected hashes empty"
            )

        if er.rows_raw > 0 and er.rows_raw > er.rows_post_regime:
            regime_pct = 1.0 - (er.rows_post_regime / er.rows_raw)
            if regime_pct > 0.5:
                divergences.append(
                    f"regime dedup removed {regime_pct:.0%} of rows "
                    f"({er.rows_raw} → {er.rows_post_regime})"
                )

        if er.evidence_source == "param_file" and er.expected_hashes:
            divergences.append("snapshot expected but fell back to param_file")

        if (er.expected_anchor_from and er.actual_anchor_from and
                er.expected_anchor_to and er.actual_anchor_to):
            try:
                from datetime import date as _date
                exp_days = (_date.fromisoformat(er.expected_anchor_to) -
                            _date.fromisoformat(er.expected_anchor_from)).days
                act_days = (_date.fromisoformat(er.actual_anchor_to) -
                            _date.fromisoformat(er.actual_anchor_from)).days
                if exp_days > 0 and act_days < (exp_days * 0.5):
                    divergences.append(
                        f"anchor range covers {act_days}d of {exp_days}d expected (<50%)"
                    )
            except (ValueError, TypeError):
                pass  # date parsing failed — skip this check

        # Slice coverage divergences (Phase C — populated when context routing active)
        if er.missing_slices:
            divergences.append(
                f"{len(er.missing_slices)} expected slices missing: "
                f"{', '.join(er.missing_slices)}"
            )

        if er.unexpected_slices:
            divergences.append(
                f"{len(er.unexpected_slices)} unexpected slices found: "
                f"{', '.join(er.unexpected_slices)}"
            )

        if er.orphan_rows > 0:
            divergences.append(f"{er.orphan_rows} rows could not be routed to any slice")

        er.divergences = divergences

        # Assign verdict
        # All expected hashes empty is only a fail if data didn't arrive
        # via equivalence (rows_raw == 0 or total_n == 0). If data was
        # found via equivalent hashes, the primary hash being absent is
        # a warn, not a fail.
        all_hashes_empty = er.expected_hashes and all(h in er.hashes_empty for h in er.expected_hashes)
        all_hashes_empty_and_no_data = all_hashes_empty and (er.rows_raw == 0 or er.total_n == 0)
        all_slices_missing = (er.expected_slices and er.missing_slices
                              and set(er.missing_slices) == set(er.expected_slices))
        has_fail = (
            all_hashes_empty_and_no_data or
            (er.rows_raw > 0 and er.total_n == 0) or
            all_slices_missing
        )
        has_warn = len(divergences) > 0 and not has_fail

        if edge_ev.skipped and not edge_subjects:
            # Skipped with no subjects = expected, not a problem
            er.verdict = "pass"
            n_skipped += 1
        elif has_fail:
            er.verdict = "fail"
            n_failed += 1
        elif has_warn:
            er.verdict = "warn"
            n_warned += 1
            n_bound += 1
        else:
            er.verdict = "pass"
            n_bound += 1

        edge_receipts[edge_id] = er

    receipt = BindingReceipt(
        edge_receipts=edge_receipts,
        edges_expected=len(topology.edges),
        edges_bound=n_bound,
        edges_fallback=n_fallback,
        edges_skipped=n_skipped,
        edges_no_subjects=n_no_subjects,
        edges_warned=n_warned,
        edges_failed=n_failed,
        mode=mode,
        halted=False,
    )
    return receipt


# ---------------------------------------------------------------------------
# Snapshot DB queries (Phase S)
# ---------------------------------------------------------------------------

def _query_snapshot_subjects(
    snapshot_subjects: list[dict],
    topology,
    log: list[str],
    candidate_regimes_by_edge: dict | None = None,
) -> dict[str, list[dict]]:
    """Query snapshot DB for all subjects in one batch, return rows grouped by edge_id.

    All subjects in a Bayes fit share the same pinnedDSL (same date ranges,
    same slice_keys). Only core_hash varies per subject. We collect the union
    of all core_hashes (primary + equivalents), issue one DB query, and
    distribute results back to edge_ids by core_hash lookup.

    See: docs/current/project-bayes/33-snapshot-query-batching.md
    """
    from datetime import date
    try:
        from snapshot_service import query_snapshots_for_sweep_batch
    except ImportError:
        import sys
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'graph-editor', 'lib'))
        from snapshot_service import query_snapshots_for_sweep_batch

    # ── 1. Parse subjects: resolve edge_id, collect hashes, extract shared dates ──
    # Map core_hash → list of edge_ids (a hash can appear in multiple subjects)
    hash_to_edges: dict[str, list[str]] = {}
    all_hashes: set[str] = set()
    all_slice_keys: set[str] = set()
    shared_anchor_from: date | None = None
    shared_anchor_to: date | None = None
    shared_sweep_from: date | None = None
    shared_sweep_to: date | None = None
    dates_parsed = False

    for subj in snapshot_subjects:
        edge_id = subj.get("edge_id", "")
        if not edge_id:
            target = subj.get("target")
            if isinstance(target, dict):
                edge_id = target.get("targetId", "")

        core_hash = subj.get("core_hash", "")
        if not core_hash or not edge_id:
            _log(log, f"  snapshot: skipping subject (no core_hash or edge_id)")
            continue

        # Collect primary hash
        all_hashes.add(core_hash)
        hash_to_edges.setdefault(core_hash, []).append(edge_id)

        # Collect equivalent hashes — map them to the same edge_id
        equivalent_hashes = subj.get("equivalent_hashes") or []
        for eh in equivalent_hashes:
            eh_hash = eh.get("core_hash", "") if isinstance(eh, dict) else ""
            if eh_hash:
                all_hashes.add(eh_hash)
                hash_to_edges.setdefault(eh_hash, []).append(edge_id)

        # Collect all slice_keys across subjects (union)
        for sk in (subj.get("slice_keys") or [""]):
            all_slice_keys.add(sk)

        # Extract shared dates from first valid subject
        if not dates_parsed:
            a_from = subj.get("anchor_from", "")
            a_to = subj.get("anchor_to", "")
            s_from = subj.get("sweep_from", "")
            s_to = subj.get("sweep_to", "")
            try:
                shared_anchor_from = date.fromisoformat(a_from) if a_from else None
                shared_anchor_to = date.fromisoformat(a_to) if a_to else None
                shared_sweep_from = date.fromisoformat(s_from) if s_from else None
                shared_sweep_to = date.fromisoformat(s_to) if s_to else None
                dates_parsed = True
            except (ValueError, TypeError) as e:
                _log(log, f"  snapshot: date parse failed: {e}")

    # Include ALL candidate regime hashes (not just subject hashes).
    # In mixed-epoch scenarios, subjects carry context hashes but the
    # DB also has bare (uncontexted) rows under different hashes from
    # earlier epochs. candidate_regimes_by_edge lists all hash families
    # per edge — include them all so the batch query fetches everything.
    if candidate_regimes_by_edge:
        for edge_id, regimes in candidate_regimes_by_edge.items():
            for cr in regimes:
                if not isinstance(cr, dict):
                    continue
                ch = cr.get("core_hash", "")
                if ch:
                    all_hashes.add(ch)
                    hash_to_edges.setdefault(ch, []).append(edge_id)
                for eh in (cr.get("equivalent_hashes") or []):
                    eh_hash = eh.get("core_hash", "") if isinstance(eh, dict) else ""
                    if eh_hash:
                        all_hashes.add(eh_hash)
                        hash_to_edges.setdefault(eh_hash, []).append(edge_id)

    if not all_hashes:
        _log(log, "  snapshot: no valid hashes to query")
        return {}

    # Always include "" (broad fetch) so bare aggregate rows from
    # uncontexted epochs are fetched alongside context-qualified rows.
    # Regime selection handles the per-date filtering downstream.
    all_slice_keys.add("")

    # ── 2. One batch query ──
    _log(log, f"  snapshot: batch query for {len(all_hashes)} unique hashes")
    try:
        rows_by_hash = query_snapshots_for_sweep_batch(
            core_hashes=list(all_hashes),
            slice_keys=list(all_slice_keys),
            anchor_from=shared_anchor_from,
            anchor_to=shared_anchor_to,
            sweep_from=shared_sweep_from,
            sweep_to=shared_sweep_to,
        )
    except Exception as e:
        _log(log, f"  snapshot: batch query failed: {e}")
        return {}

    # ── 3. Distribute rows to edge_ids ──
    # Deduplicate edge_ids per hash: multiple subjects may share the same
    # (core_hash, edge_id) pair when they differ only in slice_keys.
    result: dict[str, list[dict]] = {}
    for core_hash, rows in rows_by_hash.items():
        edge_ids = set(hash_to_edges.get(core_hash, []))
        for edge_id in edge_ids:
            if edge_id not in result:
                result[edge_id] = []
            result[edge_id].extend(rows)

    for edge_id, rows in result.items():
        _log(log, f"  snapshot: {edge_id[:8]}… → {len(rows)} rows")

    # Log edges with no data
    all_edge_ids = set()
    for edges in hash_to_edges.values():
        all_edge_ids.update(edges)
    for edge_id in all_edge_ids - set(result.keys()):
        _log(log, f"  snapshot: {edge_id[:8]}… → 0 rows (will fall back to param file)")

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
        # Latency dispersion (doc 34)
        if lat.tau_mu_mean is not None:
            window["tau_mu_mean"] = round(lat.tau_mu_mean, 4)
            window["tau_mu_sd"] = round(lat.tau_mu_sd, 4) if lat.tau_mu_sd is not None else None
        # Use worst-of for combined quality
        window["ess"] = round(min(prob.ess, lat.ess), 1)
        window["rhat"] = round(max(prob.rhat or 0, lat.rhat or 0), 4) or None

    # LOO-ELPD model adequacy (doc 32)
    if prob.delta_elpd is not None:
        window["delta_elpd"] = round(prob.delta_elpd, 3)
        window["pareto_k_max"] = round(prob.pareto_k_max, 3) if prob.pareto_k_max is not None else None
        window["n_loo_obs"] = prob.n_loo_obs

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
            **({"hdi_t95_lower": round(lat.path_hdi_t95_lower, 1), "hdi_t95_upper": round(lat.path_hdi_t95_upper, 1)}
               if lat.path_hdi_t95_lower is not None else {}),
        }
        if lat.path_onset_delta_days is not None:
            cohort["onset_mean"] = round(lat.path_onset_delta_days, 2)
        if lat.path_onset_sd is not None:
            cohort["onset_sd"] = round(lat.path_onset_sd, 2)
        # LOO-ELPD (doc 32) — cohort slice gets same edge-level scores
        if prob.delta_elpd is not None:
            cohort["delta_elpd"] = round(prob.delta_elpd, 3)
            cohort["pareto_k_max"] = round(prob.pareto_k_max, 3) if prob.pareto_k_max is not None else None
            cohort["n_loo_obs"] = prob.n_loo_obs
        slices["cohort()"] = cohort

    # Phase C: per-context-slice entries (doc 14 §5.2)
    # Each slice is denominated with temporal qualifier: context(...).window()
    # and optionally context(...).cohort() — mirroring the parent window()/cohort() pair.
    for ctx_key, sp in prob.slice_posteriors.items():
        ctx_part = f"context({ctx_key})" if not ctx_key.startswith("context(") else ctx_key

        # Build the per-slice entry with full vars
        entry: dict = {
            "alpha": round(sp["alpha"], 4),
            "beta": round(sp["beta"], 4),
            "p_hdi_lower": round(sp["hdi_lower"], 6),
            "p_hdi_upper": round(sp["hdi_upper"], 6),
            "ess": round(prob.ess, 1),
            "rhat": round(prob.rhat, 4) if prob.rhat else None,
            "provenance": "bayesian",
        }
        if "kappa_mean" in sp:
            entry["kappa_mean"] = round(sp["kappa_mean"], 2)
            entry["kappa_sd"] = round(sp["kappa_sd"], 2)
        if "mu_mean" in sp:
            entry["mu_mean"] = round(sp["mu_mean"], 4)
            entry["mu_sd"] = round(sp["mu_sd"], 4)
        if "sigma_mean" in sp:
            entry["sigma_mean"] = round(sp["sigma_mean"], 4)
            entry["sigma_sd"] = round(sp["sigma_sd"], 4)
        if "onset_mean" in sp:
            entry["onset_mean"] = round(sp["onset_mean"], 2)
            entry["onset_sd"] = round(sp.get("onset_sd", 0), 2)

        # window-denominated entry (always)
        slices[f"{ctx_part}.window()"] = entry

        # cohort-denominated entry (when parent has cohort)
        # Uses same p/kappa; path-level latency not yet per-slice,
        # so omit latency fields from cohort entry for now.
        if "cohort()" in slices:
            cohort_entry: dict = {
                "alpha": entry["alpha"],
                "beta": entry["beta"],
                "p_hdi_lower": entry["p_hdi_lower"],
                "p_hdi_upper": entry["p_hdi_upper"],
                "ess": entry["ess"],
                "rhat": entry["rhat"],
                "provenance": "bayesian",
            }
            if "kappa_mean" in entry:
                cohort_entry["kappa_mean"] = entry["kappa_mean"]
                cohort_entry["kappa_sd"] = entry["kappa_sd"]
            slices[f"{ctx_part}.cohort()"] = cohort_entry
    if prob.tau_slice_mean is not None:
        slices["_tau_slice"] = {
            "mean": round(prob.tau_slice_mean, 4),
            "sd": round(prob.tau_slice_sd, 4) if prob.tau_slice_sd else None,
        }

    return slices


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_result(
    error, log, timings, t0, edges, skipped, quality, webhook_response,
    binding_receipt=None,
) -> dict:
    duration_ms = int((time.time() - t0) * 1000)
    timings["total_ms"] = duration_ms
    result = {
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
    if binding_receipt is not None:
        result["binding_receipt"] = binding_receipt.to_dict()
    return result


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
