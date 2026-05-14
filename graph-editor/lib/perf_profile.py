"""Sentinel-gated cProfile harness for BE handlers.

When the sentinel file ``/tmp/dagnet-profile-on`` exists, the
``maybe_profile`` decorator wraps the decorated function in ``cProfile``
and dumps a ``.pstats`` file per call to ``/tmp/dagnet-profiles/``.

Toggle on:   touch /tmp/dagnet-profile-on
Toggle off:  rm /tmp/dagnet-profile-on

Read the report:
    python -c "import pstats; pstats.Stats('/tmp/dagnet-profiles/<file>.pstats').sort_stats('cumulative').print_stats(30)"

Or via the helper at ``graph-ops/scripts/read-pstats.sh``.
"""

from __future__ import annotations

import cProfile
import functools
import os
import pathlib
import time
from typing import Callable, TypeVar

SENTINEL = pathlib.Path("/tmp/dagnet-profile-on")
OUT_DIR = pathlib.Path("/tmp/dagnet-profiles")

F = TypeVar("F", bound=Callable[..., object])


def maybe_profile(label: str) -> Callable[[F], F]:
    def decorator(fn: F) -> F:
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            if not SENTINEL.exists():
                return fn(*args, **kwargs)
            OUT_DIR.mkdir(parents=True, exist_ok=True)
            profiler = cProfile.Profile()
            profiler.enable()
            try:
                return fn(*args, **kwargs)
            finally:
                profiler.disable()
                stamp = time.strftime("%Y%m%d-%H%M%S")
                path = OUT_DIR / f"{stamp}-{label}-{os.getpid()}-{int(time.time_ns())}.pstats"
                profiler.dump_stats(str(path))
        return wrapper  # type: ignore[return-value]
    return decorator
