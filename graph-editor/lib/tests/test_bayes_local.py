"""
Functional lifecycle tests for bayes_local.py — the local dev-server
Bayes job runner that mirrors Modal's async spawn/poll pattern.

Tests exercise submit(), get_status(), and cancel() directly with a
mocked worker.fit_graph to avoid DB/webhook/MCMC dependencies.
"""

import threading
import time
import sys
import os
from unittest.mock import patch, MagicMock

import pytest

# Ensure lib/ is on the path so we can import bayes_local
LIB_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if LIB_DIR not in sys.path:
    sys.path.insert(0, LIB_DIR)

import bayes_local


@pytest.fixture(autouse=True)
def _clean_job_store():
    """Reset the in-memory job store and progress store between tests."""
    bayes_local._jobs.clear()
    bayes_local._progress.clear()
    yield
    bayes_local._jobs.clear()
    bayes_local._progress.clear()


def _mock_fit_graph(payload, *, delay=0, result=None, raise_exc=None):
    """Factory for mock worker.fit_graph functions."""
    def fn(p, report_progress=None):
        if delay:
            time.sleep(delay)
        if raise_exc:
            raise raise_exc
        return result or {'fitted': True, 'job_id': p.get('_job_id')}
    return fn


class TestSubmitAndComplete:
    """Happy path: submit a job, poll until complete, verify result."""

    def test_submit_returns_job_id_with_local_prefix(self):
        with patch('worker.fit_graph', side_effect=_mock_fit_graph({})):
            job_id = bayes_local.submit({'graph_id': 'test'})
        assert job_id.startswith('local-')
        assert len(job_id) > len('local-')

    def test_submit_job_reaches_complete_status(self):
        mock_result = {'fitted': True, 'params': [1, 2, 3]}
        with patch('worker.fit_graph', return_value=mock_result):
            job_id = bayes_local.submit({'graph_id': 'test'})

        # Poll until complete (max 5s)
        deadline = time.time() + 5
        status = None
        while time.time() < deadline:
            status = bayes_local.get_status(job_id)
            if status['status'] != 'running':
                break
            time.sleep(0.05)

        assert status['status'] == 'complete'
        assert status['result'] == mock_result

    def test_submit_injects_job_id_into_payload(self):
        """The worker receives _job_id in the payload for webhook correlation."""
        captured = {}

        def capture_fn(payload, report_progress=None):
            captured.update(payload)
            return {'ok': True}

        with patch('worker.fit_graph', side_effect=capture_fn):
            job_id = bayes_local.submit({'graph_id': 'test'})
            # Wait for thread to run
            time.sleep(0.2)

        assert captured.get('_job_id') == job_id
        assert captured.get('graph_id') == 'test'


class TestSubmitAndFail:
    """Error path: worker raises an exception."""

    def test_failed_job_reports_error(self):
        def failing_fn(payload, report_progress=None):
            raise ValueError('DB connection refused')

        with patch('worker.fit_graph', side_effect=failing_fn):
            job_id = bayes_local.submit({'graph_id': 'test'})

        # Poll until done
        deadline = time.time() + 5
        status = None
        while time.time() < deadline:
            status = bayes_local.get_status(job_id)
            if status['status'] != 'running':
                break
            time.sleep(0.05)

        assert status['status'] == 'failed'
        assert 'DB connection refused' in status['error']


class TestCancel:
    """Cancel flow: cancel while running, cancel after complete, cancel unknown."""

    def test_cancel_running_job_marks_cancelled(self):
        """Cancelling a running job should set status to 'cancelled'."""
        # Use a slow worker so we can cancel while it's running
        barrier = threading.Event()

        def slow_fn(payload, report_progress=None):
            barrier.wait(timeout=5)
            return {'ok': True}

        with patch('worker.fit_graph', side_effect=slow_fn):
            job_id = bayes_local.submit({'graph_id': 'test'})

            # Verify it's running
            status = bayes_local.get_status(job_id)
            assert status['status'] == 'running'

            # Cancel it
            result = bayes_local.cancel(job_id)
            assert result['status'] == 'cancelled'
            assert result['call_id'] == job_id

            # Status should now be cancelled
            status = bayes_local.get_status(job_id)
            assert status['status'] == 'cancelled'
            assert status['error'] == 'Cancelled by user'

            # Release the worker thread so it doesn't hang
            barrier.set()

    def test_cancel_completed_job_returns_current_status(self):
        """Cancelling an already-complete job returns 'complete', not 'cancelled'."""
        with patch('worker.fit_graph', return_value={'fitted': True}):
            job_id = bayes_local.submit({'graph_id': 'test'})

        # Wait for completion
        deadline = time.time() + 5
        while time.time() < deadline:
            if bayes_local.get_status(job_id)['status'] != 'running':
                break
            time.sleep(0.05)

        result = bayes_local.cancel(job_id)
        assert result['status'] == 'complete'
        assert result['call_id'] == job_id

    def test_cancel_unknown_job_returns_error(self):
        result = bayes_local.cancel('nonexistent-job-id')
        assert result['status'] == 'error'
        assert 'Unknown job' in result['error']


class TestGetStatus:
    """Status polling edge cases."""

    def test_status_unknown_job_returns_error(self):
        status = bayes_local.get_status('nonexistent-job-id')
        assert status['status'] == 'error'
        assert 'Unknown job' in status['error']

    def test_status_running_job_has_no_result(self):
        barrier = threading.Event()

        def slow_fn(payload, report_progress=None):
            barrier.wait(timeout=5)
            return {'ok': True}

        with patch('worker.fit_graph', side_effect=slow_fn):
            job_id = bayes_local.submit({'graph_id': 'test'})

            status = bayes_local.get_status(job_id)
            assert status['status'] == 'running'
            assert 'result' not in status

            barrier.set()


class TestProgress:
    """Progress reporting: worker writes, status reads, cleaned up on completion."""

    def test_progress_visible_during_running_job(self):
        """Status endpoint includes progress when worker reports it."""
        barrier = threading.Event()

        def worker_with_progress(payload, report_progress=None):
            if report_progress:
                report_progress('fitting', 42, 'Edge 3/7')
            barrier.wait(timeout=5)
            return {'ok': True}

        with patch('worker.fit_graph', side_effect=worker_with_progress):
            job_id = bayes_local.submit({'graph_id': 'test'})
            time.sleep(0.1)  # Let the worker thread start and report

            status = bayes_local.get_status(job_id)
            assert status['status'] == 'running'
            assert 'progress' in status
            assert status['progress']['stage'] == 'fitting'
            assert status['progress']['pct'] == 42
            assert status['progress']['detail'] == 'Edge 3/7'

            barrier.set()

    def test_progress_cleaned_up_after_completion(self):
        """Progress entry is removed once the job completes."""
        def worker_with_progress(payload, report_progress=None):
            if report_progress:
                report_progress('fitting', 50, 'Halfway')
            return {'ok': True}

        with patch('worker.fit_graph', side_effect=worker_with_progress):
            job_id = bayes_local.submit({'graph_id': 'test'})

        # Wait for completion
        deadline = time.time() + 5
        while time.time() < deadline:
            if bayes_local.get_status(job_id)['status'] != 'running':
                break
            time.sleep(0.05)

        assert bayes_local.get_progress(job_id) is None
        status = bayes_local.get_status(job_id)
        assert 'progress' not in status

    def test_no_progress_when_worker_doesnt_report(self):
        """Status has no progress field when worker doesn't use the callback."""
        barrier = threading.Event()

        def silent_worker(payload, report_progress=None):
            barrier.wait(timeout=5)
            return {'ok': True}

        with patch('worker.fit_graph', side_effect=silent_worker):
            job_id = bayes_local.submit({'graph_id': 'test'})
            time.sleep(0.1)

            status = bayes_local.get_status(job_id)
            assert status['status'] == 'running'
            assert 'progress' not in status

            barrier.set()
