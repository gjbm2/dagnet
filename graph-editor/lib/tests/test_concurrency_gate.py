"""Unit tests for ``lib/concurrency_gate.py``.

The gate is the process-global admission primitive that bounds how many heavy
requests run at once (so co-located Fluid invocations cannot sum past the
memory ceiling) and runs per-request memory cleanup on exit. Tests cover the
concurrency cap (the safety property), single-flight serialisation, the busy
timeout, slot release on error, and the exit-time cache flush.
"""

from __future__ import annotations

import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import concurrency_gate as cg
import result_cache


# Capture the import-time defaults so each test restores them.
_DEFAULT_CAP = cg.MAX_CONCURRENCY
_DEFAULT_TIMEOUT = cg.ACQUIRE_TIMEOUT_S


@pytest.fixture(autouse=True)
def _restore_gate():
    """Restore the module-global gate to its import-time config after each test."""
    yield
    cg._reset_gate_for_tests(_DEFAULT_CAP, timeout_s=_DEFAULT_TIMEOUT)


def _run_workers(n: int):
    """Run n workers through the gate; return the max observed concurrency."""
    max_seen = [0]
    current = [0]
    lock = threading.Lock()

    def worker():
        with cg.concurrency_gate():
            with lock:
                current[0] += 1
                if current[0] > max_seen[0]:
                    max_seen[0] = current[0]
            time.sleep(0.05)
            with lock:
                current[0] -= 1

    threads = [threading.Thread(target=worker) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return max_seen[0]


class TestConcurrencyCap:
    def test_never_exceeds_capacity(self):
        # 8 workers, capacity 2 — without the gate max would be 8.
        cg._reset_gate_for_tests(2, timeout_s=5)
        assert _run_workers(8) <= 2

    def test_single_flight_serialises(self):
        # capacity 1 → strictly one at a time (the default production posture).
        cg._reset_gate_for_tests(1, timeout_s=5)
        assert _run_workers(8) == 1


class TestBusyTimeout:
    def test_raises_when_no_slot_frees(self):
        cg._reset_gate_for_tests(1, timeout_s=0.2)
        cg._gate.acquire()  # occupy the only slot
        try:
            with pytest.raises(cg.ConcurrencyLimitExceeded):
                with cg.concurrency_gate():
                    pass
        finally:
            cg._gate.release()

    def test_busy_message_is_informative(self):
        cg._reset_gate_for_tests(1, timeout_s=0.1)
        cg._gate.acquire()
        try:
            with pytest.raises(cg.ConcurrencyLimitExceeded) as exc:
                with cg.concurrency_gate():
                    pass
            assert 'busy' in str(exc.value).lower()
        finally:
            cg._gate.release()


class TestReleaseSafety:
    def test_slot_released_on_exception(self):
        cg._reset_gate_for_tests(1, timeout_s=1)
        with pytest.raises(RuntimeError):
            with cg.concurrency_gate():
                raise RuntimeError('boom')
        # The slot must be free again — this would block/raise if it leaked.
        with cg.concurrency_gate():
            pass

    def test_slot_released_on_normal_exit(self):
        cg._reset_gate_for_tests(1, timeout_s=1)
        for _ in range(3):
            with cg.concurrency_gate():
                pass  # each iteration must reacquire cleanly


class TestReentrancy:
    def test_nested_gate_does_not_self_deadlock(self):
        # A funnel analysis nests handle_conditioned_forecast inside
        # handle_runner_analyze; at capacity 1 a non-reentrant gate would block
        # the inner call on a permit the outer holds. The reentrant gate must
        # pass the nested entry straight through.
        cg._reset_gate_for_tests(1, timeout_s=0.3)
        with cg.concurrency_gate():
            with cg.concurrency_gate():  # would raise/hang if not reentrant
                pass
        # Outer exit released exactly once — slot is reusable.
        with cg.concurrency_gate():
            pass

    def test_nested_exit_defers_cleanup_to_outermost(self):
        # The inner exit must NOT flush request-scoped caches — only the
        # outermost frame owns cleanup.
        cg._reset_gate_for_tests(1, timeout_s=0.3)
        c = result_cache.make_cache('test_gate_nested_rs', request_scoped=True, log_prints=False)
        with cg.concurrency_gate():
            c.put('k', 1)
            with cg.concurrency_gate():
                pass
            assert len(c._store) == 1  # inner exit did not flush
        assert len(c._store) == 0      # outer exit flushed


class TestExitCleanup:
    def test_exit_flushes_request_scoped_caches(self):
        cg._reset_gate_for_tests(1, timeout_s=1)
        c = result_cache.make_cache('test_gate_rs', request_scoped=True, log_prints=False)
        c.put('k', 1)
        assert len(c._store) == 1
        with cg.concurrency_gate():
            pass
        assert len(c._store) == 0  # gate cleanup flushed the request-scoped cache

    def test_exit_does_not_flush_persistent_caches(self):
        cg._reset_gate_for_tests(1, timeout_s=1)
        persistent = result_cache.make_cache('test_gate_persistent', log_prints=False)
        persistent.put('k', 1)
        with cg.concurrency_gate():
            pass
        assert len(persistent._store) == 1  # untouched

    def test_trim_memory_never_raises(self):
        cg.trim_memory()  # best-effort; must be safe on any platform
