"""
Local-runnable version of the Bayes worker (bayes/app.py fit_graph).

This is a thin wrapper that calls the same logic as the Modal worker
but without requiring Modal decorators or runtime. When the actual
inference code in bayes/app.py changes, this file should be updated
to match — or ideally, bayes/app.py should import from a shared module.

For now, we duplicate the function body so local dev works without
any Modal dependency.
"""

import time


def fit_graph_local(payload: dict) -> dict:
    """Fit posteriors for a single graph. Fires webhook on completion.

    Identical logic to bayes/app.py fit_graph — runs locally without Modal.
    """
    import requests as http
    import psycopg2

    log = []
    t0 = time.time()
    error = None
    edges = []
    webhook_response = None

    try:
        # -- 1. Connect to Neon --
        db_url = payload.get("db_connection", "")
        if db_url:
            t_db = time.time()
            conn = psycopg2.connect(db_url)
            cur = conn.cursor()
            cur.execute("SELECT 1")
            cur.close()
            conn.close()
            log.append(f"connected to Neon ({int((time.time() - t_db) * 1000)}ms)")
        else:
            log.append("no db_connection in payload - skipping DB check")

        # -- 2. Build placeholder posterior payload --
        graph_id = payload.get("graph_id", "unknown")

        param_files = payload.get("parameter_files", {})
        for param_id in param_files:
            edges.append({
                "param_id": param_id,
                "posterior": {
                    "alpha": 1.0,
                    "beta": 1.0,
                    "hdi_lower": 0.0,
                    "hdi_upper": 1.0,
                    "hdi_level": 0.9,
                    "ess": 0,
                    "rhat": 0.0,
                    "provenance": "point-estimate",
                },
            })
        log.append(f"built placeholder posteriors for {len(edges)} edges")

        # -- 3. Fire webhook --
        webhook_url = payload.get("webhook_url", "")
        callback_token = payload.get("callback_token", "")

        if webhook_url:
            from datetime import datetime

            webhook_body = {
                "job_id": payload.get("_job_id", "unknown"),
                "graph_id": graph_id,
                "repo": payload.get("repo", ""),
                "branch": payload.get("branch", ""),
                "graph_file_path": payload.get("graph_file_path", ""),
                "fingerprint": f"local-{int(time.time())}",
                "fitted_at": datetime.utcnow().strftime("%-d-%b-%y"),
                "quality": {
                    "max_rhat": 0.0,
                    "min_ess": 0,
                    "converged_pct": 0.0,
                },
                "edges": edges,
                "skipped": [],
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
                "body": resp.json() if resp.headers.get("content-type", "").startswith("application/json") else resp.text[:500],
            }
            log.append(
                f"webhook POST {resp.status_code} ({int((time.time() - t_wh) * 1000)}ms)"
            )
            if resp.status_code >= 400:
                error = f"webhook returned {resp.status_code}"
        else:
            log.append("no webhook_url in payload - skipping webhook")

    except Exception as e:
        error = str(e)
        log.append(f"ERROR: {error}")

    duration_ms = int((time.time() - t0) * 1000)

    return {
        "status": "failed" if error else "complete",
        "duration_ms": duration_ms,
        "edges_fitted": len(edges) if not error else 0,
        "edges_skipped": 0,
        "quality": {"max_rhat": 0.0, "min_ess": 0},
        "warnings": [],
        "log": log,
        "webhook_response": webhook_response,
        "error": error,
    }
