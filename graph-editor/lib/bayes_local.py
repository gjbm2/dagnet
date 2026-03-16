"""
Local Bayes job runner — mirrors Modal's async spawn/poll pattern.

Used by dev-server.py to run fit_graph locally in a background thread,
with the same submit/status API shape as the Modal endpoints.

Progress reporting mirrors Modal's modal.Dict — a simple in-memory dict
keyed by job_id, written by the worker thread, read by the status endpoint.
"""

import threading
import time
import uuid
import sys
import os

# Add bayes/ to path so we can import fit_graph without Modal decorators
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'bayes'))

# In-memory job store: job_id -> { status, result, error, started_at }
_jobs: dict = {}
_lock = threading.Lock()

# Progress store — mirrors modal.Dict("dagnet-bayes-progress")
# job_id -> { "stage": str, "pct": int, "detail": str }
_progress: dict = {}


def report_progress(job_id: str, stage: str, pct: int, detail: str = "") -> None:
    """Write a progress update. Called by the worker (or test harness)."""
    _progress[job_id] = {"stage": stage, "pct": pct, "detail": detail}


def get_progress(job_id: str) -> dict | None:
    """Read progress for a job. Returns None if no progress reported."""
    return _progress.get(job_id)


def _run_fit_graph(job_id: str, payload: dict) -> None:
    """Run fit_graph in a background thread, storing the result."""
    try:
        # Make report_progress available to the worker via the payload
        # so bayes_worker can report progress without importing bayes_local.
        payload_with_progress = {
            **payload,
            '_report_progress': lambda stage, pct, detail="": report_progress(job_id, stage, pct, detail),
        }

        from bayes_worker import fit_graph_local
        result = fit_graph_local(payload_with_progress)

        with _lock:
            _jobs[job_id]['status'] = 'complete'
            _jobs[job_id]['result'] = result

    except Exception as e:
        import traceback
        traceback.print_exc()
        with _lock:
            _jobs[job_id]['status'] = 'failed'
            _jobs[job_id]['error'] = str(e)
    finally:
        # Clean up progress entry
        _progress.pop(job_id, None)


def submit(payload: dict) -> str:
    """Spawn fit_graph in a background thread. Returns job_id."""
    job_id = f"local-{uuid.uuid4().hex[:16]}"

    with _lock:
        _jobs[job_id] = {
            'status': 'running',
            'result': None,
            'error': None,
            'started_at': time.time(),
        }

    # Inject the job_id into the payload so the worker can include it
    # in the webhook callback (mirrors Modal's behaviour).
    payload_with_id = {**payload, '_job_id': job_id}

    thread = threading.Thread(
        target=_run_fit_graph,
        args=(job_id, payload_with_id),
        daemon=True,
    )
    thread.start()

    return job_id


def cancel(job_id: str) -> dict:
    """Cancel a running local job. Marks it cancelled in the store.

    The daemon thread cannot be forcibly killed in Python, but fit_graph
    is short-lived enough that this is acceptable. The status will read
    'cancelled' so the FE stops polling.
    """
    with _lock:
        job = _jobs.get(job_id)

    if not job:
        return {'status': 'error', 'error': f'Unknown job: {job_id}'}

    with _lock:
        if _jobs[job_id]['status'] == 'running':
            _jobs[job_id]['status'] = 'cancelled'
            _jobs[job_id]['error'] = 'Cancelled by user'
            return {'status': 'cancelled', 'call_id': job_id}
        else:
            return {'status': _jobs[job_id]['status'], 'call_id': job_id}


def get_status(job_id: str) -> dict:
    """Poll job status. Returns the same shape as Modal's status endpoint."""
    with _lock:
        job = _jobs.get(job_id)

    if not job:
        return {'status': 'error', 'error': f'Unknown job: {job_id}'}

    if job['status'] == 'running':
        resp = {'status': 'running'}
        progress = get_progress(job_id)
        if progress:
            resp['progress'] = progress
        return resp
    elif job['status'] == 'complete':
        return {'status': 'complete', 'result': job['result']}
    elif job['status'] == 'cancelled':
        return {'status': 'cancelled', 'error': job['error']}
    else:
        return {'status': 'failed', 'error': job['error']}
