"""
Request-level telemetry for /api/runner/analyze (Phase A).

Purpose: explain why a light cohort_maturity query dies on Vercel (300s timeout
or OOM) when the same query runs in a few seconds locally. The decisive question
is whether Vercel Fluid Compute is co-locating several concurrent invocations on
one constrained Hobby instance (1 vCPU / 2 GB), so they starve each other for CPU
(-> 300s timeout) and pile up RAM (-> OOM).

Design (kill-survivable, emitted before the work, flushed per line):

- BOOT_ID: a per-PROCESS id generated once at import. Two requests logging the
  same BOOT_ID ran on the same warm instance. The join key is (BOOT_ID, pid):
  pid alone can repeat across cold starts, so neither is sufficient on its own.

- A process-global, SELF-HEALING in-flight registry. Each request registers on
  entry and deregisters on exit. Because an OOM SIGKILL or the 300s timeout kill
  bypasses Python's ``finally``, a killed request would otherwise leak its slot
  and manufacture a false ``inflight>=2`` for the next request. To prevent that
  false positive (the single most important robustness fix from review), every
  entry first TTL-sweeps slots older than the function ceiling, and ``inflight``
  is reported as the live registry size after the sweep.

- STARTED / FINISHED counters: any clean OR exception exit increments FINISHED; a
  SIGKILL increments neither. A gap (STARTED - FINISHED beyond the currently
  active set) on one BOOT_ID is itself evidence that invocations were killed.

- A single daemon watchdog thread samples current and peak RSS every 5s and emits
  one line per active request, so an opaque SIGKILL (which leaves no traceback)
  still leaves a memory-growth curve up to the death point.

INTERPRETATION: co-location is proven by two DISTINCT rids sharing the same
(BOOT_ID, pid) with INTERLEAVED timestamps and inflight>=2 -- not by an inflight
value alone (a leaked counter cannot fake interleaved live timestamps).

Output goes to stdout (Vercel maps stdout -> runtime logs), one flushed line per
event, at phase granularity only, so it stays well under Vercel's 256-lines /
256 KB-line / 1 MB per-request caps. RSS is read from /proc/self/status (the
zero-dependency idiom already used in lib/tests/_daemon_client.py); psutil is not
a dependency and tracemalloc misses NumPy's C buffers, so neither is used.

This module must NEVER raise into the request path: every public entry point
swallows its own errors.
"""
import os
import time
import threading
import uuid
import contextvars

# Per-process identity. Generated once when the module is first imported into a
# process; persists for the life of a (possibly warm-reused) Vercel instance.
BOOT_ID = uuid.uuid4().hex[:12]

_LOCK = threading.Lock()
_ACTIVE: dict = {}          # rid -> {"start": monotonic, "phase": str}
_SEQ = 0                    # monotonic request counter (for rid minting)
_STARTED = 0               # requests that began on this process
_FINISHED = 0             # requests that reached __exit__ (clean or exception)
_TTL_S = 330.0             # > the 300s function ceiling; sweeps SIGKILL-leaked slots

_WATCHDOG_LOCK = threading.Lock()
_WATCHDOG_ON = False
_WATCHDOG_PERIOD_S = 5.0

# Current request id for the running context (lets mark() work without threading
# an id through every call site; Phase B uses this). Set inside the context, so
# it is visible on the same thread for both the Vercel and dev (threadpool) paths.
_current_rid: "contextvars.ContextVar[str | None]" = contextvars.ContextVar(
    "telemetry_rid", default=None
)


def _read_mem_mb():
    """Return (rss_mb, hwm_mb) from /proc/self/status; (0.0, 0.0) off Linux.

    VmHWM is the monotonic peak RSS for the PROCESS -- under warm reuse and
    in-function concurrency it is shared across requests, so callers should read
    it as the instance ceiling, not a per-request figure.
    """
    rss = 0.0
    hwm = 0.0
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    rss = float(line.split()[1]) / 1024.0
                elif line.startswith("VmHWM:"):
                    hwm = float(line.split()[1]) / 1024.0
    except Exception:
        pass
    return rss, hwm


def _emit(rid, phase, start, inflight, extra=None):
    try:
        rss, hwm = _read_mem_mb()
        t_ms = (time.monotonic() - start) * 1000.0 if start else 0.0
        parts = [
            "[telemetry]",
            "rid=" + str(rid),
            "boot=" + BOOT_ID,
            "pid=" + str(os.getpid()),
            "phase=" + str(phase),
            "inflight=" + str(inflight),
            "started=" + str(_STARTED),
            "finished=" + str(_FINISHED),
            "t_ms=%.0f" % t_ms,
            "rss_mb=%.0f" % rss,
            "hwm_mb=%.0f" % hwm,
        ]
        if extra:
            for k, v in extra.items():
                parts.append("%s=%s" % (k, v))
        # flush=True is cheap insurance; the Vercel Python runtime line-buffers
        # stdout anyway, so the real win is emitting BEFORE the work, not after.
        print(" ".join(parts), flush=True)
    except Exception:
        pass


def _sweep_locked():
    now = time.monotonic()
    stale = [rid for rid, info in _ACTIVE.items() if now - info["start"] > _TTL_S]
    for rid in stale:
        _ACTIVE.pop(rid, None)


def _ensure_watchdog():
    global _WATCHDOG_ON
    try:
        with _WATCHDOG_LOCK:
            if _WATCHDOG_ON:
                return
            _WATCHDOG_ON = True
        threading.Thread(
            target=_watchdog_loop, name="telemetry-watchdog", daemon=True
        ).start()
    except Exception:
        pass


def _watchdog_loop():
    while True:
        try:
            time.sleep(_WATCHDOG_PERIOD_S)
            with _LOCK:
                snap = [(rid, info["start"], info["phase"]) for rid, info in _ACTIVE.items()]
                inflight = len(snap)
            for rid, start, phase in snap:
                _emit(rid, "WATCHDOG", start, inflight, {"last_phase": phase})
        except Exception:
            pass


def mark(phase, **extra):
    """Record a phase boundary for the current request.

    A no-op when called outside a request_telemetry context. Phase B wires this
    into the compute path; Phase A only needs ENTER/EXIT/WATCHDOG.
    """
    rid = _current_rid.get()
    if rid is None:
        return
    try:
        with _LOCK:
            info = _ACTIVE.get(rid)
            if info is not None:
                info["phase"] = phase
            start = info["start"] if info else None
            inflight = len(_ACTIVE)
        _emit(rid, phase, start, inflight, extra or None)
    except Exception:
        pass


class request_telemetry:
    """Context manager bracketing one /api/runner/analyze invocation.

    Use as ``with request_telemetry(label=..., **enter_dims): ...`` around the
    whole handler body. Logs ENTER on open and EXIT (or EXIT_ERR) on close; the
    watchdog covers the time in between.
    """

    def __init__(self, label="analyze", trace_id=None, **enter_dims):
        self.label = label
        self.trace_id = trace_id
        self.enter_dims = enter_dims
        self.rid = None
        self._token = None

    def __enter__(self):
        global _SEQ, _STARTED
        try:
            with _LOCK:
                _sweep_locked()
                _SEQ += 1
                self.rid = self.trace_id or ("%s-%d" % (BOOT_ID, _SEQ))
                start = time.monotonic()
                _ACTIVE[self.rid] = {"start": start, "phase": "ENTER"}
                _STARTED += 1
                inflight = len(_ACTIVE)
            self._token = _current_rid.set(self.rid)
            _ensure_watchdog()
            dims = dict(self.enter_dims)
            dims["label"] = self.label
            _emit(self.rid, "ENTER", start, inflight, dims)
        except Exception:
            pass
        return self

    def __exit__(self, exc_type, exc, tb):
        global _FINISHED
        try:
            with _LOCK:
                info = _ACTIVE.pop(self.rid, None)
                _FINISHED += 1
                inflight = len(_ACTIVE)
            start = info["start"] if info else None
            _emit(self.rid, "EXIT" if exc_type is None else "EXIT_ERR", start, inflight)
        except Exception:
            pass
        if self._token is not None:
            try:
                _current_rid.reset(self._token)
            except Exception:
                pass
        return False
