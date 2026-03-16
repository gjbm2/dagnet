"""
DagNet Bayes – Modal app
Deployed via: modal deploy bayes/app.py

Three components:
  1. /submit  – web endpoint, receives FE payload, spawns worker
  2. fit_graph – worker function, connects to Neon, computes posteriors,
                 fires webhook
  3. /status  – web endpoint, polls FunctionCall status for FE
"""

import modal
import time

app = modal.App("dagnet-bayes")

# Scientific Python image – used by the worker only.
# Submit and status endpoints use a minimal image (fast cold start).
science_image = modal.Image.debian_slim(python_version="3.12").pip_install(
    "numpy",
    "scipy",
    "pymc",
    "arviz",
    "requests",
    "pyyaml",
    "psycopg2-binary",
)

minimal_image = modal.Image.debian_slim(python_version="3.12").pip_install(
    "fastapi[standard]",
    "requests",
)


# ---------------------------------------------------------------------------
# 1. Submit web endpoint – called directly by FE
# ---------------------------------------------------------------------------
@app.function(image=minimal_image)
@modal.fastapi_endpoint(method="POST")
async def submit(request: dict):
    """Receive submission from FE, spawn worker, return job_id.

    Expects JSON body with at minimum:
      graph_id, repo, branch, graph_file_path,
      graph_snapshot, parameters_index, parameter_files, settings,
      callback_token, db_connection, webhook_url
    """
    fn = modal.Function.from_name("dagnet-bayes", "fit_graph")
    call = fn.spawn(request)
    return {"job_id": call.object_id}


# ---------------------------------------------------------------------------
# 2. Worker function – no secrets, no config, pure function
# ---------------------------------------------------------------------------
@app.function(image=science_image, timeout=600)
def fit_graph(payload: dict) -> dict:
    """Fit posteriors for a single graph. Fires webhook on completion.

    For the skeleton/spike phase this does minimal work:
    - Connects to Neon (proves DB access)
    - Reads evidence inventory (proves query works)
    - Builds placeholder posterior payload
    - POSTs to webhook (proves callback chain works)

    Returns a rich diagnostic object consumed by the status endpoint.
    """
    import requests as http
    import psycopg2

    log = []
    t0 = time.time()
    error = None
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
            log.append("no neon_database_url in payload – skipping DB check")

        # -- 2. Build placeholder posterior payload --
        graph_id = payload.get("graph_id", "unknown")
        edges = []

        # For the skeleton, we produce one placeholder edge per parameter
        # file in the submission. Real inference replaces this.
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
            import json
            from datetime import datetime

            webhook_body = {
                "job_id": payload.get("_job_id", "unknown"),
                "graph_id": graph_id,
                "repo": payload.get("repo", ""),
                "branch": payload.get("branch", ""),
                "graph_file_path": payload.get("graph_file_path", ""),
                "fingerprint": f"skeleton-{int(time.time())}",
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
            log.append("no webhook_url in payload – skipping webhook")

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


# ---------------------------------------------------------------------------
# 3. Status web endpoint – called directly by FE
# ---------------------------------------------------------------------------
@app.function(image=minimal_image)
@modal.fastapi_endpoint(method="GET")
def status(call_id: str = ""):
    """Poll job status. No auth – call_id is an unguessable capability token.

    Returns the full worker result when available (diagnostics, quality,
    log, webhook response). See 'Progress visibility and worker diagnostics'
    in the design doc.
    """
    if not call_id:
        return {"status": "error", "error": "call_id parameter required"}

    from modal.functions import FunctionCall

    try:
        fc = FunctionCall.from_id(call_id)
        result = fc.get(timeout=0)
        return {"status": "complete", "result": result}
    except TimeoutError:
        return {"status": "running"}
    except Exception as e:
        return {"status": "failed", "error": str(e)}
