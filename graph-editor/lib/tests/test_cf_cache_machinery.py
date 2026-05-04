"""CF cache machinery coverage — written BLIND (3-May-26).

This file pins cache invariants for the carrier-factorised analyse path
without inspecting cache implementation details. The aim is to catch
defects that internal-knowledge tests would miss: assertions are derived
from intended cache semantics, not from the current code.

Coverage:
  Group A — Equivalence: turning the cache off MUST NOT change numerical
    results. The hit path and the uncached path are required to agree.
  Group B — Idempotence: two consecutive cached calls must produce
    identical numbers (the hit path must be deterministic).
  Group C — Key sensitivity: different inputs must produce different
    outputs (cache key cannot be too coarse).
  Group D — Bypass propagation: --no-cache and --no-snapshot-cache must
    each, individually and combined, agree with the fully-uncached path.
  Group E — Stability under toggling: cached → bypassed → cached must
    return to the original numbers (bypass call must not corrupt cache
    state).

The tests drive the analyse CLI via the daemon. Each test calls the
daemon directly with parameterised cache flags — NO test-side
memoization, so every call is a fresh daemon hit and exercises the
process-memory cache.
"""

from __future__ import annotations

import math
import os
from pathlib import Path
from typing import Any, Optional

import pytest

from conftest import requires_data_repo, requires_db, requires_synth
from _daemon_client import DaemonError, get_default_client


_REPO_ROOT = Path(__file__).resolve().parents[3]
_PYTHON_BE_URL = os.environ.get("PYTHON_API_URL", "http://localhost:9000")


def _resolve_data_repo_path() -> Optional[str]:
    conf = _REPO_ROOT / ".private-repos.conf"
    if not conf.exists():
        return None
    for line in conf.read_text().splitlines():
        if line.startswith("DATA_REPO_DIR="):
            return str(_REPO_ROOT / line.split("=", 1)[1].strip())
    return None


_DATA_REPO_PATH = _resolve_data_repo_path()


def _python_be_reachable() -> bool:
    try:
        import urllib.request
        with urllib.request.urlopen(
            f"{_PYTHON_BE_URL}/__dagnet/server-info",
            timeout=2,
        ) as response:
            return response.status == 200
    except Exception:
        return False


requires_python_be = pytest.mark.skipif(
    not _python_be_reachable(),
    reason=f"Python BE not reachable at {_PYTHON_BE_URL}",
)


def _run_analyse(
    graph_name: str,
    dsl: str,
    *,
    cache: bool,
    snapshot_cache: bool,
    analysis_type: str = "cohort_maturity",
) -> dict[str, Any]:
    """Drive the analyse CLI via the daemon with parameterised cache
    flags. Intentionally NOT memoized — every call hits the daemon and
    exercises the in-process cache layer."""
    if _DATA_REPO_PATH is None:
        pytest.skip("data repo not configured")

    client = get_default_client()
    args = [
        "--graph", _DATA_REPO_PATH,
        "--name", graph_name,
        "--query", dsl,
        "--type", analysis_type,
        "--format", "json",
    ]
    if not cache:
        args.append("--no-cache")
    if not snapshot_cache:
        args.append("--no-snapshot-cache")

    try:
        return client.call_json("analyse", args)
    except DaemonError as exc:
        raise AssertionError(
            f"daemon analyse failed for {graph_name} / {dsl!r} "
            f"(exit {exc.exit_code}); flags cache={cache} "
            f"snapshot_cache={snapshot_cache}\n"
            f"stderr:\n{exc.stderr[-2000:]}"
        )


def _scalar_signature(payload: dict) -> list[float]:
    """Walk the payload deterministically and pull out every numeric
    scalar. Returns a stable list of floats suitable for equality
    comparison across calls. Booleans and NaN/inf are skipped (booleans
    are not coerced to floats; NaN/inf would make equality unreliable)."""
    out: list[float] = []

    def _walk(obj: Any) -> None:
        if isinstance(obj, dict):
            for k in sorted(obj.keys()):
                _walk(obj[k])
        elif isinstance(obj, (list, tuple)):
            for item in obj:
                _walk(item)
        elif isinstance(obj, bool):
            return
        elif isinstance(obj, (int, float)):
            f = float(obj)
            if math.isnan(f) or math.isinf(f):
                return
            out.append(f)

    _walk(payload)
    return out


def _approx_equal(a: list[float], b: list[float], *, tol: float) -> tuple[bool, str]:
    if len(a) != len(b):
        return False, f"length mismatch: {len(a)} vs {len(b)}"
    for i, (x, y) in enumerate(zip(a, b)):
        if abs(x - y) > tol:
            return False, (
                f"first diff at index {i}: {x!r} vs {y!r} "
                f"(|delta|={abs(x - y):.3e}, tol={tol:.3e})"
            )
    return True, ""


# ---------------------------------------------------------------------------
# Fixtures.
# ---------------------------------------------------------------------------


_SIMPLE = "synth-simple-abc"
_SIMPLE_AB = "from(simple-a).to(simple-b)"
_DSL_WINDOW = f"{_SIMPLE_AB}.window(29-Jan-26:29-Apr-26)"
_DSL_COHORT = f"{_SIMPLE_AB}.cohort(29-Jan-26:29-Apr-26)"
_DSL_WINDOW_NARROW = f"{_SIMPLE_AB}.window(1-Mar-26:29-Apr-26)"


# Equivalence tolerance: the cached path and the uncached path do
# IDENTICAL math at the primitive layer, so we expect bit-equality on a
# deterministic synth fixture. We allow a generous floor because some
# downstream paths (IS resampling) can be cache-state-sensitive.
_EQUIVALENCE_TOL = 1e-9
# Numerical-distinctness tolerance for key-sensitivity assertions.
# Two different DSLs on the same fixture should differ by far more than
# floating-point drift.
_DISTINCT_TOL = 1e-6


# ===========================================================================
# Group A: Equivalence — cache enabled vs --no-cache --no-snapshot-cache
# ===========================================================================


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_cached_equals_uncached_window():
    """Window-mode analyse with cache fully on must produce the same
    numbers as with both cache flags off. If they differ, the cache is
    silently corrupting outputs (or the uncached path is broken)."""
    cached = _run_analyse(_SIMPLE, _DSL_WINDOW, cache=True, snapshot_cache=True)
    uncached = _run_analyse(_SIMPLE, _DSL_WINDOW, cache=False, snapshot_cache=False)
    ok, why = _approx_equal(
        _scalar_signature(cached), _scalar_signature(uncached), tol=_EQUIVALENCE_TOL,
    )
    assert ok, f"window-mode cached != uncached: {why}"


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_cached_equals_uncached_cohort():
    """Same equivalence invariant for cohort mode."""
    cached = _run_analyse(_SIMPLE, _DSL_COHORT, cache=True, snapshot_cache=True)
    uncached = _run_analyse(_SIMPLE, _DSL_COHORT, cache=False, snapshot_cache=False)
    ok, why = _approx_equal(
        _scalar_signature(cached), _scalar_signature(uncached), tol=_EQUIVALENCE_TOL,
    )
    assert ok, f"cohort-mode cached != uncached: {why}"


# ===========================================================================
# Group B: Idempotence — two consecutive cached calls return identical
# numbers. The hit path must be deterministic.
# ===========================================================================


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_two_cached_calls_bit_identical_window():
    a = _run_analyse(_SIMPLE, _DSL_WINDOW, cache=True, snapshot_cache=True)
    b = _run_analyse(_SIMPLE, _DSL_WINDOW, cache=True, snapshot_cache=True)
    a_sig = _scalar_signature(a)
    b_sig = _scalar_signature(b)
    assert a_sig == b_sig, (
        "two consecutive cached analyse calls produced different numbers. "
        "Either the cache hit path is non-deterministic, or the cache "
        "isn't actually caching (each call recomputes with stochastic "
        "drift)."
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_two_uncached_calls_bit_identical_window():
    """Sanity: two --no-cache calls must also be identical, since the
    underlying compute is deterministic on a fixed fixture. This test
    also pins the assumption behind the equivalence tests: if uncached
    is non-deterministic, equivalence tests would falsely pass."""
    a = _run_analyse(_SIMPLE, _DSL_WINDOW, cache=False, snapshot_cache=False)
    b = _run_analyse(_SIMPLE, _DSL_WINDOW, cache=False, snapshot_cache=False)
    ok, why = _approx_equal(
        _scalar_signature(a), _scalar_signature(b), tol=_EQUIVALENCE_TOL,
    )
    assert ok, (
        f"two consecutive --no-cache analyse calls produced different "
        f"numbers: {why}. The uncached compute path is non-deterministic; "
        f"this invalidates the equivalence tests above."
    )


# ===========================================================================
# Group C: Key sensitivity — different inputs must produce different
# results. If the cache key is too coarse, two different queries could
# collide and the second would return the first's cached value.
# ===========================================================================


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_different_window_range_different_result():
    """Same edge, two different window ranges. Must produce different
    numbers — different evidence range → different posterior."""
    wide = _run_analyse(_SIMPLE, _DSL_WINDOW, cache=True, snapshot_cache=True)
    narrow = _run_analyse(_SIMPLE, _DSL_WINDOW_NARROW, cache=True, snapshot_cache=True)
    wide_sig = _scalar_signature(wide)
    narrow_sig = _scalar_signature(narrow)
    if len(wide_sig) != len(narrow_sig):
        return  # different output shape; sensitivity already guaranteed
    ok, _ = _approx_equal(wide_sig, narrow_sig, tol=_DISTINCT_TOL)
    assert not ok, (
        "two distinct window ranges produced numerically identical "
        "payloads. The cache key may be window-range-blind, OR the "
        "underlying compute is range-blind (also a bug). Compare with "
        "the --no-cache version of this assertion to disambiguate."
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_different_window_range_different_uncached():
    """Sensitivity sanity check via the uncached path. If the underlying
    compute really IS range-blind, this will also pass; that would mean
    the prior test's failure (if any) is a compute bug, not a cache bug."""
    wide = _run_analyse(_SIMPLE, _DSL_WINDOW, cache=False, snapshot_cache=False)
    narrow = _run_analyse(_SIMPLE, _DSL_WINDOW_NARROW, cache=False, snapshot_cache=False)
    wide_sig = _scalar_signature(wide)
    narrow_sig = _scalar_signature(narrow)
    if len(wide_sig) != len(narrow_sig):
        return
    ok, _ = _approx_equal(wide_sig, narrow_sig, tol=_DISTINCT_TOL)
    assert not ok, (
        "uncached: two distinct window ranges produced numerically "
        "identical payloads. The underlying compute is range-blind."
    )


# ===========================================================================
# Group D: Bypass propagation — each cache flag, individually and
# combined, must agree with the fully-uncached baseline.
# ===========================================================================


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_no_cache_alone_matches_fully_off():
    """--no-cache (primitive) without --no-snapshot-cache must still
    match the fully-off baseline. If only one of the two layers actually
    bypasses, results may diverge."""
    primitive_off = _run_analyse(
        _SIMPLE, _DSL_WINDOW, cache=False, snapshot_cache=True,
    )
    fully_off = _run_analyse(
        _SIMPLE, _DSL_WINDOW, cache=False, snapshot_cache=False,
    )
    ok, why = _approx_equal(
        _scalar_signature(primitive_off),
        _scalar_signature(fully_off),
        tol=_EQUIVALENCE_TOL,
    )
    assert ok, (
        f"--no-cache alone differs from --no-cache --no-snapshot-cache: "
        f"{why}. The snapshot cache is influencing results even when "
        f"the primitive cache is bypassed."
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_no_snapshot_cache_alone_matches_fully_off():
    """--no-snapshot-cache without --no-cache must still match the
    fully-off baseline."""
    snapshot_off = _run_analyse(
        _SIMPLE, _DSL_WINDOW, cache=True, snapshot_cache=False,
    )
    fully_off = _run_analyse(
        _SIMPLE, _DSL_WINDOW, cache=False, snapshot_cache=False,
    )
    ok, why = _approx_equal(
        _scalar_signature(snapshot_off),
        _scalar_signature(fully_off),
        tol=_EQUIVALENCE_TOL,
    )
    assert ok, (
        f"--no-snapshot-cache alone differs from --no-cache "
        f"--no-snapshot-cache: {why}."
    )


# ===========================================================================
# Group E: Stability under toggling — bypass call must not corrupt the
# cache state of subsequent cached calls.
# ===========================================================================


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_cache_then_bypass_then_cache_consistent():
    """Sequence: cached → bypassed → cached. The first and third calls
    must agree (the bypass call must not have written stale entries).
    All three must agree with each other (equivalence)."""
    first = _run_analyse(_SIMPLE, _DSL_WINDOW, cache=True, snapshot_cache=True)
    bypassed = _run_analyse(_SIMPLE, _DSL_WINDOW, cache=False, snapshot_cache=False)
    third = _run_analyse(_SIMPLE, _DSL_WINDOW, cache=True, snapshot_cache=True)

    first_sig = _scalar_signature(first)
    bypassed_sig = _scalar_signature(bypassed)
    third_sig = _scalar_signature(third)

    ok1, why1 = _approx_equal(first_sig, bypassed_sig, tol=_EQUIVALENCE_TOL)
    assert ok1, f"cache-on != --no-cache (first vs bypassed): {why1}"

    assert first_sig == third_sig, (
        "third cache-on call diverged bit-for-bit from first cache-on "
        "call. The intervening --no-cache call may have polluted cache "
        "state, OR the cache is non-deterministic on the hit path."
    )
