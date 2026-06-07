"""TEMPORARY diagnostic — per-phase peak-RSS (VmHWM) probe for the CF path.

Goal: localise *which phase* of a cohort_maturity / conditioned_forecast
compute owns the per-request memory peak, so the memory work targets the
dominant phase instead of guessing. (See the be-memory-budget reasoning:
the hypothesis is the cohort-scaled tail — projection + scatter + reducer —
dominates, and span resolution is small because the spans/kernels are
cohort-independent. This probe confirms or refutes that on a real query.)

Mechanism: wrap three module-level functions in place and print a
``[mem-phase]`` line carrying VmRSS / VmHWM at ENTER and EXIT of each:

  - ``cohort_forecast_v3.build_resolved_cf_runtime``  → span resolution
  - ``model_span_spine.project_selected_cohort_rows`` → selected-cohort projection
  - ``cohort_forecast_v3.reduce_cohort_maturity_rows``→ tau reducer

VmHWM is the process's monotonic peak RSS, so the *jump* in hwm between two
consecutive boundaries is the memory that phase added. The scatter
(``date_axis_projection``) runs inside ``build_cf_projection_bundle`` between
the projection's EXIT and the reducer's ENTER, so its contribution shows as
the hwm delta across that gap.

These three names are resolved at call time through their defining module
namespaces (bare-global / module-qualified inside ``build_cf_projection_bundle``),
so patching the module attribute is sufficient — no edit to the scoped CF
engine files is required.

Output lands in ``debug/tmp.python-server.jsonl`` via the dev-server LogTee
(stdout is tee'd). Read with ``grep mem-phase``.

Reversible: this whole file plus the ``install()`` call appended to
``api_handlers.py`` are the only footprint. Disable at runtime with
``DAGNET_MEM_PHASE_PROBE=0``. Remove both to fully revert.
"""

from __future__ import annotations

import functools
import os
import time
from pathlib import Path

_WRAP_FLAG = "_mem_phase_wrapped"

# Dedicated sink, independent of the dev-server stdout LogTee (which can be
# orphaned if its backing file is rotated/deleted under the open fd). Direct
# append means the lines land regardless of the stdout plumbing's health.
_SINK = os.environ.get("DAGNET_MEM_PHASE_LOG", "/tmp/dagnet-mem-phase.log")


def _mem_mb():
    """(VmRSS, VmHWM) in MB from /proc/self/status; (0,0) off Linux."""
    rss = hwm = 0.0
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                rss = float(line.split()[1]) / 1024.0
            elif line.startswith("VmHWM:"):
                hwm = float(line.split()[1]) / 1024.0
    except Exception:
        pass
    return rss, hwm


def _emit(phase: str, when: str, extra: str = "") -> None:
    rss, hwm = _mem_mb()
    line = (
        f"[mem-phase] pid={os.getpid()} t={time.time():.3f} phase={phase} "
        f"{when} rss_mb={rss:.0f} hwm_mb={hwm:.0f}{extra}"
    )
    print(line, flush=True)
    try:
        with open(_SINK, "a") as fh:
            fh.write(line + "\n")
    except Exception:
        pass


def _wrap(module, name: str, phase: str, describe=None) -> bool:
    fn = getattr(module, name, None)
    if fn is None:
        print(f"[mem-phase] WARN: {module.__name__}.{name} not found", flush=True)
        return False
    if getattr(fn, _WRAP_FLAG, False):
        return True  # already wrapped (idempotent across reloads)

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        extra = ""
        if describe is not None:
            try:
                extra = describe(args, kwargs)
            except Exception:
                extra = ""
        _emit(phase, "ENTER", extra)
        t0 = time.monotonic()
        try:
            return fn(*args, **kwargs)
        finally:
            _emit(phase, f"EXIT t_ms={int((time.monotonic() - t0) * 1000)}", extra)

    setattr(wrapper, _WRAP_FLAG, True)
    setattr(module, name, wrapper)
    return True


def _describe_projection(args, kwargs) -> str:
    cohorts = kwargs.get("selected_cohorts")
    horizon = kwargs.get("horizon")
    n = len(cohorts) if cohorts is not None else "?"
    return f" cohorts={n} horizon={horizon}"


def install() -> None:
    """Wrap the three CF phase functions. Idempotent; honours
    DAGNET_MEM_PHASE_PROBE=0 to no-op."""
    if os.environ.get("DAGNET_MEM_PHASE_PROBE", "1") == "0":
        return
    from runner import cohort_forecast_v3, model_span_spine

    ok = [
        _wrap(cohort_forecast_v3, "build_resolved_cf_runtime", "span_resolution"),
        _wrap(model_span_spine, "project_selected_cohort_rows", "projection",
              describe=_describe_projection),
        _wrap(cohort_forecast_v3, "reduce_cohort_maturity_rows", "tau_reduce"),
    ]
    _emit("install", f"DONE wrapped={sum(ok)}/3")
