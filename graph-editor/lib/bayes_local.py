"""
Local Bayes job runner — mirrors Modal's async spawn/poll pattern.

Used by dev-server.py to run fit_graph locally in a background thread,
with the same submit/status API shape as the Modal endpoints.
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


def _run_fit_graph(job_id: str, payload: dict) -> None:
    """Run fit_graph in a background thread, storing the result."""
    try:
        # Import the actual fit_graph function from bayes/app.py.
        # We can't import the decorated version (Modal decorators aren't
        # available locally), so we import the module and call the
        # underlying function's .local() or just re-implement the call.
        #
        # Since Modal decorators make the function uncallable without the
        # Modal runtime, we import the module source and extract the logic.
        # The simplest approach: just inline-import and run the same code.
        from bayes_worker import fit_graph_local
        result = fit_graph_local(payload)

        with _lock:
            _jobs[job_id]['status'] = 'complete'
            _jobs[job_id]['result'] = result

    except Exception as e:
        import traceback
        traceback.print_exc()
        with _lock:
            _jobs[job_id]['status'] = 'failed'
            _jobs[job_id]['error'] = str(e)


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


def get_status(job_id: str) -> dict:
    """Poll job status. Returns the same shape as Modal's status endpoint."""
    with _lock:
        job = _jobs.get(job_id)

    if not job:
        return {'status': 'error', 'error': f'Unknown job: {job_id}'}

    if job['status'] == 'running':
        return {'status': 'running'}
    elif job['status'] == 'complete':
        return {'status': 'complete', 'result': job['result']}
    else:
        return {'status': 'failed', 'error': job['error']}
