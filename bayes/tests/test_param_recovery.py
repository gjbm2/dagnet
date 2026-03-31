"""
Param recovery regression tests — pytest wrapper.

Runs the full regression suite via run_regression.py with parallel
execution, core-aware scheduling, and bayes-monitor visibility.
Reports results as individual pytest test cases.

Usage:
    . graph-editor/venv/bin/activate
    pytest bayes/tests/test_param_recovery.py -v -s --timeout=1800

    # Single graph:
    pytest bayes/tests/test_param_recovery.py -k "synth-simple-abc" -v -s

    # Prefer the orchestrator directly for interactive use:
    python bayes/run_regression.py

Execution path (shared with run_regression.py):
    run_regression.run_regression()
      -> synth_gen.py --write-files     (bootstrap, sequential)
      -> param_recovery.py --graph X    (parallel pool)
         -> test_harness.py --graph X   (writes /tmp/bayes_harness-{graph}.log)
      -> assert_recovery()
"""

from __future__ import annotations

import argparse
import os
import sys
import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO_ROOT, "bayes"))


# ---------------------------------------------------------------------------
# Skip conditions
# ---------------------------------------------------------------------------

def _has_db_connection() -> bool:
    env_path = os.path.join(REPO_ROOT, "graph-editor", ".env.local")
    if not os.path.exists(env_path):
        return False
    for line in open(env_path):
        if line.startswith("DB_CONNECTION=") and len(line.strip()) > 15:
            return True
    return False


def _has_data_repo() -> bool:
    conf_path = os.path.join(REPO_ROOT, ".private-repos.conf")
    if not os.path.exists(conf_path):
        return False
    for line in open(conf_path):
        if line.strip().startswith("DATA_REPO_DIR="):
            d = line.strip().split("=", 1)[1].strip().strip('"')
            return os.path.isdir(os.path.join(REPO_ROOT, d))
    return False


requires_db = pytest.mark.skipif(
    not _has_db_connection(),
    reason="No DB_CONNECTION in graph-editor/.env.local",
)
requires_data_repo = pytest.mark.skipif(
    not _has_data_repo(),
    reason="Data repo not found",
)


# ---------------------------------------------------------------------------
# Run the full suite once, report per-graph as parametrised subtests
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Slow-graph gating
# ---------------------------------------------------------------------------
# Graphs with expected_sample_seconds > SLOW_THRESHOLD are skipped by default.
# Set BAYES_RUN_SLOW=1 to include them.

SLOW_THRESHOLD_S = 300
_RUN_SLOW = os.environ.get("BAYES_RUN_SLOW", "").strip() in ("1", "true", "yes")


def _discover_graphs() -> list[dict]:
    """Discover graph metadata for parametrisation and filtering."""
    try:
        from synth_gen import discover_synth_graphs, _resolve_data_repo
        data_repo = _resolve_data_repo()
        results = []
        for g in discover_synth_graphs(data_repo):
            truth = g["truth"]
            sim = truth.get("simulation", {})
            testing = truth.get("testing", {})
            expected_s = testing.get("timeout") or sim.get("expected_sample_seconds", 300)
            results.append({
                "graph_name": g["graph_name"],
                "truth": truth,
                "expected_s": expected_s,
                "xfail_reason": testing.get("xfail_reason"),
                "is_slow": expected_s > SLOW_THRESHOLD_S,
            })
        return results
    except Exception:
        return []


_GRAPHS = _discover_graphs()

# Names of graphs that will actually run (used by _run_full_suite)
_RUNNABLE_NAMES: list[str] = []

# Build parametrize args with xfail/skip marks
_PARAM_ARGS = []
for _g in _GRAPHS:
    marks = []
    if _g["xfail_reason"]:
        marks.append(pytest.mark.xfail(reason=_g["xfail_reason"], strict=False))
    if _g["is_slow"] and not _RUN_SLOW:
        marks.append(pytest.mark.skip(
            reason=f"Slow graph ({_g['expected_s']}s) — set BAYES_RUN_SLOW=1 to include"
        ))
    else:
        _RUNNABLE_NAMES.append(_g["graph_name"])
    _PARAM_ARGS.append(pytest.param(_g["graph_name"], marks=marks, id=_g["graph_name"]))


# Cache for the single parallel run (session-scoped equivalent)
_SUITE_RESULTS: list[dict] | None = None


def _run_full_suite() -> list[dict]:
    """Run the regression suite for non-skipped graphs (parallel, core-aware).

    Results are cached so that parametrised test cases don't re-run MCMC.
    Only runs graphs in _RUNNABLE_NAMES — slow graphs excluded unless
    BAYES_RUN_SLOW=1.
    """
    global _SUITE_RESULTS
    if _SUITE_RESULTS is not None:
        return _SUITE_RESULTS

    from run_regression import run_regression

    # When all graphs are runnable, pass graph=None (run everything).
    # Otherwise pass each runnable graph individually.
    all_names = [g["graph_name"] for g in _GRAPHS]
    if set(_RUNNABLE_NAMES) == set(all_names):
        graph_filter = None
    else:
        graph_filter = _RUNNABLE_NAMES

    if graph_filter is not None and len(graph_filter) == 0:
        _SUITE_RESULTS = []
        return _SUITE_RESULTS

    # run_regression accepts args.graph as a string, list, or None.
    # Pass the runnable list so the pool only fits non-skipped graphs.
    args = argparse.Namespace(
        graph=graph_filter,
        preflight_only=False,
        chains=3, draws=1000, tune=500, max_parallel=None,
    )
    _SUITE_RESULTS = run_regression(args)
    return _SUITE_RESULTS


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@requires_db
@requires_data_repo
@pytest.mark.slow
class TestParamRecovery:
    """Param recovery regression — parallel execution, per-graph reporting.

    The full suite runs once (parallel, core-aware, bayes-monitor visible).
    Each parametrised test case reports the result for one graph.

    All graphs:
        pytest bayes/tests/test_param_recovery.py -v -s --timeout=1800
    Single:
        pytest bayes/tests/test_param_recovery.py -k "synth-simple-abc" -v -s
    Interactive (preferred):
        python bayes/run_regression.py
    """

    @pytest.mark.parametrize("graph_name", _PARAM_ARGS)
    def test_param_recovery(self, graph_name):
        results = _run_full_suite()

        # Find this graph's result
        result = None
        for r in results:
            if r["graph_name"] == graph_name:
                result = r
                break

        if result is None:
            pytest.fail(f"No result found for {graph_name} — graph may have been skipped during bootstrap")

        if not result["passed"]:
            failures_str = "\n".join(f"  {f}" for f in result["failures"])
            q = result.get("quality", {})
            quality_str = ""
            if q:
                quality_str = f"\n  Quality: rhat={q.get('rhat', 0):.4f} ess={q.get('ess', 0)} converged={q.get('converged_pct', 0)}%"
            pytest.fail(f"Recovery failed for {graph_name}:{quality_str}\n{failures_str}")
