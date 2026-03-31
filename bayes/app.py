"""
DagNet Bayes – Modal app
Deployed via: modal deploy bayes/app.py

Components:
  1. /submit   – web endpoint, receives FE payload, spawns worker
  2. fit_graph – worker function, runs compiler pipeline (topology → evidence
                 → model → MCMC inference), fires webhook, reports progress
  3. /cancel   – web endpoint, terminates a running job
  4. /status   – web endpoint, polls FunctionCall status + progress for FE

The compute logic lives in worker.py (shared with local dev server).
"""

import modal
import os
import time
import uuid

APP_VERSION = "1.9.3-beta"

app = modal.App("dagnet-bayes")

# Shared progress store — worker writes, status endpoint reads.
# Keys: job_id → { "stage": str, "pct": int, ... }
# Entries auto-expire after 7 days of inactivity (Modal default).
progress_dict = modal.Dict.from_name("dagnet-bayes-progress", create_if_missing=True)

_repo_root = os.path.dirname(os.path.dirname(__file__))

_requirements_path = os.path.join(os.path.dirname(__file__), "requirements.txt")

worker_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("libopenblas-dev")  # BLAS for PyTensor — without this, sampling is ~10× slower
    .pip_install_from_requirements(_requirements_path)
    .env({"PYTHONPATH": "/root/bayes:/root/lib"})
    .add_local_dir(
        os.path.dirname(__file__),
        remote_path="/root/bayes",
        ignore=["__pycache__", "*.pyc"],
    )
    .add_local_dir(
        os.path.join(_repo_root, "graph-editor", "lib"),
        remote_path="/root/lib",
        ignore=["__pycache__", "*.pyc", "tests"],
    )
)

minimal_image = modal.Image.debian_slim(python_version="3.12").pip_install(
    "fastapi[standard]",
    "requests",
)


# ---------------------------------------------------------------------------
# 0. Version endpoint – quick sanity check, no auth
# ---------------------------------------------------------------------------
@app.function(image=minimal_image)
@modal.fastapi_endpoint(method="GET")
def version():
    """Return the deployed app version. Use to verify which code is running."""
    return {"version": APP_VERSION}


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
    # Generate a progress key and inject it into the payload so the worker
    # can write progress keyed by it.  We can't use call.object_id because
    # it's only known AFTER fn.spawn().
    progress_key = str(uuid.uuid4())
    request["_job_id"] = progress_key

    fn = modal.Function.from_name("dagnet-bayes", "fit_graph")
    call = fn.spawn(request)

    # Store mapping so the status endpoint can resolve call_id → progress_key
    progress_dict[f"_map:{call.object_id}"] = progress_key

    return {"job_id": call.object_id}


# ---------------------------------------------------------------------------
# 2. Worker function – no secrets, no config, pure function
# ---------------------------------------------------------------------------
def _report_progress(job_id: str, stage: str, pct: int, detail: str = ""):
    """Write a progress update to the shared Dict. Safe to call from worker."""
    try:
        progress_dict[job_id] = {"stage": stage, "pct": pct, "detail": detail}
    except Exception:
        pass  # Best-effort — don't let progress reporting kill the job


@app.function(image=worker_image, timeout=600, cpu=4)
def fit_graph(payload: dict) -> dict:
    """Fit posteriors for a single graph via the compiler pipeline.

    Delegates to worker.fit_graph() which runs:
      topology analysis → evidence binding → PyMC model → MCMC → webhook.

    Reports progress via modal.Dict so the FE can show real-time updates.
    Returns a rich diagnostic object consumed by the status endpoint.
    """
    job_id = payload.get("_job_id", "unknown")

    def modal_progress(stage: str, pct: int, detail: str = ""):
        _report_progress(job_id, stage, pct, detail)

    try:
        from worker import fit_graph as _fit_graph
        result = _fit_graph(payload, report_progress=modal_progress)
        result["version"] = APP_VERSION
        return result
    except Exception as e:
        import traceback
        return {
            "status": "failed",
            "version": APP_VERSION,
            "error": str(e),
            "log": [f"ERROR: {e}", traceback.format_exc()],
        }
    finally:
        try:
            progress_dict.pop(job_id, None)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# 3. Cancel web endpoint – called by FE to abort a running job
# ---------------------------------------------------------------------------
@app.function(image=minimal_image)
@modal.fastapi_endpoint(method="POST")
def cancel(call_id: str = ""):
    """Cancel a running job. Terminates the Modal container immediately.

    The worker is killed before it can fire the webhook, so no commit
    lands on the repo. If the webhook POST has already left the worker,
    the commit may still land (small race window).
    """
    if not call_id:
        return {"status": "error", "error": "call_id parameter required"}

    from modal.functions import FunctionCall

    try:
        fc = FunctionCall.from_id(call_id)
        fc.cancel(terminate_containers=True)
        return {"status": "cancelled", "call_id": call_id}
    except Exception as e:
        return {"status": "error", "error": str(e)}


# ---------------------------------------------------------------------------
# 4. Status web endpoint – called directly by FE
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
        # Still running — attach progress if available.
        # The worker writes progress keyed by _job_id (a UUID), not by
        # call_id.  The submit endpoint stores the mapping call_id → _job_id
        # under the key "_map:{call_id}".
        progress = None
        try:
            progress_key = progress_dict.get(f"_map:{call_id}")
            if progress_key:
                progress = progress_dict.get(progress_key)
        except Exception:
            pass
        resp = {"status": "running", "version": APP_VERSION}
        if progress:
            resp["progress"] = progress
        return resp
    except Exception as e:
        return {"status": "failed", "error": str(e)}
