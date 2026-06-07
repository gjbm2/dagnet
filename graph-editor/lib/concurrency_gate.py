"""Process-global concurrency gate + per-request memory cleanup.

Why this exists
---------------
Vercel Fluid Compute co-locates multiple invocations inside ONE process that
shares ONE memory pool, and Vercel exposes no concurrency knob. When the
combined working set of co-resident requests exceeds the instance limit the
kernel OOM-kills the whole process — taking every sibling invocation down with
it (Vercel's error isolation covers Node exceptions, not OS OOM). So bounding
how many heavy requests run at once in the process is the only way to make a
memory ceiling a guarantee rather than a hope.

This module is the **enforcement** primitive: a process-global bounded
semaphore. The count of held permits IS the active concurrency, exact and
race-free by construction (``acquire`` atomically admits or blocks — there is
no read-then-decide window). The *observational* in-flight count lives in
``request_telemetry`` (a self-healing registry); that is advisory, this is the
gate. With the default capacity of 1 (single-flight) only one heavy working set
is ever live, so co-located requests cannot sum past the ceiling.

On exit the gate also runs per-request memory cleanup: flush the request-scoped
runner caches (the draw-scaled composed-span / primitive caches) and return
freed-but-retained glibc arenas to the OS via ``malloc_trim``, so a co-located
sibling sees a lower resident baseline at its own peak.

Configuration (read once at import, matching the DAGNET_* env idiom):
  DAGNET_MAX_CONCURRENCY  — capacity k_max (default 1, single-flight)
  DAGNET_GATE_TIMEOUT_S   — max wait for a slot before refusing (default 290s,
                            just under the platform 300s cap)
"""

import ctypes
import os
import threading
from contextlib import contextmanager


# ── Configuration ──────────────────────────────────────────────────────

def _read_positive_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


MAX_CONCURRENCY = _read_positive_int('DAGNET_MAX_CONCURRENCY', 1)
ACQUIRE_TIMEOUT_S = _read_positive_int('DAGNET_GATE_TIMEOUT_S', 290)

# Module-global so all co-located invocations in the one shared process contend
# on the same permits. Reassigned only by the test helper below.
_gate = threading.BoundedSemaphore(MAX_CONCURRENCY)
_capacity = MAX_CONCURRENCY

# Per-thread re-entrancy flag. A single request can nest gated handlers — a
# funnel analysis runs through handle_runner_analyze and then internally invokes
# handle_conditioned_forecast (runners._whole_graph_cf). The semaphore is NOT
# reentrant, so a nested acquire on the same thread would block on a permit the
# outer call already holds (self-deadlock). Only the OUTERMOST entry per thread
# acquires, runs cleanup, and releases; nested entries pass straight through.
_local = threading.local()


class ConcurrencyLimitExceeded(RuntimeError):
    """No compute slot became free within the timeout.

    Transports map this to HTTP 503 (server busy; retry shortly). It is a
    deliberate, recoverable backpressure signal, not a server fault.
    """


# ── malloc_trim: best-effort return of freed glibc arenas to the OS ─────

def _resolve_malloc_trim():
    """Bind glibc malloc_trim if available; return None off glibc (musl/macOS)."""
    try:
        libc = ctypes.CDLL('libc.so.6', use_errno=True)
        fn = libc.malloc_trim
        fn.argtypes = [ctypes.c_size_t]
        fn.restype = ctypes.c_int
        return fn
    except Exception:  # noqa: BLE001 — non-glibc platform; trim is best-effort
        return None


_malloc_trim = _resolve_malloc_trim()


def trim_memory() -> None:
    """Return freed-but-retained allocator arenas to the OS. No-op off glibc.

    glibc holds freed arenas rather than unmapping them; under co-location that
    residue is still resident while a sibling peaks. Trimming between requests
    lowers the baseline a co-located request sees. Measured to reclaim ~845 MB
    after a single cohort-maturity request on the dev box.
    """
    if _malloc_trim is None:
        return
    try:
        _malloc_trim(0)
    except Exception:  # noqa: BLE001 — hygiene call; never fail the request on it
        pass


def _cleanup_request_memory() -> None:
    """Flush request-scoped runner caches, then return freed arenas to the OS."""
    from result_cache import clear_request_scoped
    try:
        clear_request_scoped()
    finally:
        trim_memory()


# ── The gate ───────────────────────────────────────────────────────────

@contextmanager
def concurrency_gate():
    """Admit at most ``MAX_CONCURRENCY`` concurrent heavy requests per process.

    Blocks up to ``ACQUIRE_TIMEOUT_S`` for a free slot; raises
    ``ConcurrencyLimitExceeded`` if none frees in time. On exit (normal or
    error) runs per-request memory cleanup and releases the slot. Cleanup runs
    *before* release so the next admitted request sees the lower baseline.

    Re-entrant per thread: a nested gated call within the same request passes
    straight through without re-acquiring (the semaphore is not reentrant);
    only the outermost entry acquires, cleans up, and releases.
    """
    if getattr(_local, 'held', False):
        # Nested call on a thread that already holds the slot — pass through.
        # Cleanup/release belong to the outermost frame, not here.
        yield
        return
    if not _gate.acquire(timeout=ACQUIRE_TIMEOUT_S):
        raise ConcurrencyLimitExceeded(
            f"server busy: all {_capacity} compute slot(s) in use after "
            f"{ACQUIRE_TIMEOUT_S}s; retry shortly"
        )
    _local.held = True
    try:
        yield
    finally:
        try:
            _cleanup_request_memory()
        finally:
            _local.held = False
            _gate.release()


def _reset_gate_for_tests(capacity: int, timeout_s: int = None) -> None:
    """Test-only: rebuild the gate with a given capacity (and optional timeout).

    Production code must NOT call this. Mirrors result_cache's test helper.
    """
    global _gate, _capacity, ACQUIRE_TIMEOUT_S
    _gate = threading.BoundedSemaphore(capacity)
    _capacity = capacity
    if timeout_s is not None:
        ACQUIRE_TIMEOUT_S = timeout_s
