"""
Pytest configuration for tests under graph-editor/lib/tests.

Provides:
  - sys.path setup so `import lib.*` works
  - Shared fixtures: data_repo_dir, db_url
  - Shared markers: requires_db, requires_data_repo
  - Declarative synth fixture: requires_synth(graph_name, enriched=bool)
"""

from __future__ import annotations

import copy
import functools
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest


# ── sys.path setup ────���─────────────────────────────────────────────────────

GRAPH_EDITOR_DIR = Path(__file__).resolve().parents[2]  # .../graph-editor
DAGNET_ROOT = GRAPH_EDITOR_DIR.parent

if str(GRAPH_EDITOR_DIR) not in sys.path:
    sys.path.insert(0, str(GRAPH_EDITOR_DIR))


# ── Shared resolution helpers ──────���────────────────────────────────────────

def _resolve_data_repo_dir(root: str | None = None) -> Path | None:
    """Resolve data repo from .private-repos.conf. Returns None if unavailable."""
    dagnet = Path(root) if root else DAGNET_ROOT
    conf = dagnet / ".private-repos.conf"
    if not conf.exists():
        return None
    for line in conf.read_text().splitlines():
        if line.startswith("DATA_REPO_DIR="):
            repo_dir = dagnet / line.split("=", 1)[1].strip().strip('"')
            if (repo_dir / "graphs").is_dir():
                return repo_dir
    return None


def _resolve_db_url() -> str:
    """Load DB_CONNECTION from environment or .env.local."""
    url = os.environ.get("DB_CONNECTION", "")
    if url:
        return url
    env_path = GRAPH_EDITOR_DIR / ".env.local"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line.startswith("DB_CONNECTION="):
                return line.split("=", 1)[1].strip().strip('"')
    return ""


def _ensure_db_connection_env() -> str:
    """Populate DB_CONNECTION from .env.local when tests need the DB."""
    url = _resolve_db_url()
    if not url:
        pytest.skip("DB_CONNECTION not set")
    os.environ.setdefault("DB_CONNECTION", url)
    return url


@functools.lru_cache(maxsize=None)
def _load_graph_text(graph_name: str) -> str:
    """Read a graph JSON file once per session."""
    repo = _resolve_data_repo_dir()
    if repo is None:
        raise FileNotFoundError("Data repo not available")
    path = repo / "graphs" / f"{graph_name}.json"
    if not path.exists():
        raise FileNotFoundError(f"Graph not found at {path}")
    return path.read_text()


def load_graph_json(graph_name: str) -> dict[str, Any]:
    """Load a graph JSON as a fresh mutable dict."""
    try:
        return json.loads(_load_graph_text(graph_name))
    except FileNotFoundError as exc:
        pytest.skip(str(exc))


@functools.lru_cache(maxsize=None)
def _load_db_hashes_by_mode_cached(graph_name: str) -> dict[str, dict[str, list[str]]]:
    """Map each edge UUID to its window/cohort snapshot hashes."""
    _ensure_db_connection_env()
    graph = json.loads(_load_graph_text(graph_name))

    from snapshot_service import _pooled_conn

    result: dict[str, dict[str, list[str]]] = {}
    with _pooled_conn() as conn:
        cur = conn.cursor()
        for edge in graph.get("edges", []):
            p_id = edge.get("p", {}).get("id", "")
            if not p_id:
                continue
            cur.execute(
                "SELECT DISTINCT core_hash, slice_key FROM snapshots "
                "WHERE param_id LIKE %s AND core_hash != '' "
                "AND core_hash NOT LIKE 'PLACEHOLDER%%' "
                "AND slice_key NOT LIKE 'context%%' "
                "ORDER BY core_hash",
                (f"%{p_id}",),
            )
            rows = cur.fetchall()
            if not rows:
                continue
            by_mode = {"window": [], "cohort": []}
            for core_hash, slice_key in rows:
                slice_key = slice_key or ""
                if "window" in slice_key:
                    by_mode["window"].append(core_hash)
                elif "cohort" in slice_key:
                    by_mode["cohort"].append(core_hash)
            result[edge["uuid"]] = by_mode
    return result


def load_db_hashes_by_mode(graph_name: str) -> dict[str, dict[str, list[str]]]:
    """Return a fresh copy of the DB temporal-mode hash map."""
    return copy.deepcopy(_load_db_hashes_by_mode_cached(graph_name))


@functools.lru_cache(maxsize=None)
def _load_candidate_regimes_by_mode_cached(
    graph_name: str,
) -> dict[str, list[dict[str, Any]]]:
    """Build FE-style candidate regimes with temporal_mode tags."""
    by_mode = _load_db_hashes_by_mode_cached(graph_name)
    regimes: dict[str, list[dict[str, Any]]] = {}
    for edge_uuid, mode_hashes in by_mode.items():
        edge_regimes: list[dict[str, Any]] = []
        window_hashes = mode_hashes.get("window", [])
        cohort_hashes = mode_hashes.get("cohort", [])
        if window_hashes:
            edge_regimes.append(
                {
                    "core_hash": window_hashes[0],
                    "equivalent_hashes": window_hashes[1:],
                    "temporal_mode": "window",
                }
            )
        if cohort_hashes:
            edge_regimes.append(
                {
                    "core_hash": cohort_hashes[0],
                    "equivalent_hashes": cohort_hashes[1:],
                    "temporal_mode": "cohort",
                }
            )
        if edge_regimes:
            regimes[edge_uuid] = edge_regimes
    return regimes


def load_candidate_regimes_by_mode(
    graph_name: str,
) -> dict[str, list[dict[str, Any]]]:
    """Return a fresh copy of cached candidate regimes."""
    return copy.deepcopy(_load_candidate_regimes_by_mode_cached(graph_name))


# ── Session fixtures ───────────────��────────────────────────────��───────────

@pytest.fixture(scope="session")
def data_repo_dir() -> Path | None:
    return _resolve_data_repo_dir()


@pytest.fixture(scope="session")
def db_url() -> str:
    return _resolve_db_url()


# ── Skip markers (single definitions — no more copy-paste) ─────────────────

_DATA_REPO = _resolve_data_repo_dir()
_DB_URL = _resolve_db_url()

requires_db = pytest.mark.skipif(not _DB_URL, reason="DB_CONNECTION not set")
requires_data_repo = pytest.mark.skipif(
    _DATA_REPO is None, reason="Data repo not available"
)


# ── Declarative synth fixture ──���───────────────────────────────────────────

# Session-scoped cache: graph_name → status after verification/bootstrap.
# Prevents redundant regen within a single pytest session.
_SYNTH_CACHE: dict[str, str] = {}


def _synth_cache_clear():
    """Clear the session cache (for testing the fixture itself)."""
    _SYNTH_CACHE.clear()


def _call_verify_synth_data(graph_name: str, data_repo: str, **kwargs) -> dict:
    """Call verify_synth_data from bayes.synth_gen.

    Isolated into a function so tests can patch it.
    """
    # Add dagnet root to sys.path so bayes.synth_gen is importable
    root = str(DAGNET_ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)
    from bayes.synth_gen import verify_synth_data
    return verify_synth_data(graph_name, data_repo, **kwargs)


def _bootstrap_synth_graph(graph_name: str, *, enrich: bool = False,
                            bust_cache: bool = False) -> bool:
    """Run synth_gen.py to regenerate a graph. Returns True on success."""
    cmd = [
        sys.executable, "-m", "bayes.synth_gen",
        "--graph", graph_name,
        "--write-files",
    ]
    if bust_cache:
        cmd.append("--bust-cache")
    if enrich:
        cmd.append("--enrich")

    result = subprocess.run(
        cmd, capture_output=True, text=True, timeout=600,
        cwd=str(DAGNET_ROOT),
        env={**os.environ, "DB_CONNECTION": _resolve_db_url()},
    )
    if result.returncode != 0:
        print(f"[requires_synth] Bootstrap failed for {graph_name}:\n{result.stderr[:500]}")
        return False
    return True


def _bayesian_enrich_synth_graph(graph_name: str) -> bool:
    """Run `bayes/test_harness.py --graph X --enrich` to write MCMC posteriors
    back to the on-disk graph via the FE CLI apply-patch path.

    Requires the bayes worker (MCMC backend) AND node/nvm/FE CLI to be
    reachable. Returns False on any subprocess failure; caller is
    expected to skip the test gracefully.

    Timeout is generous (15 min) — MCMC on a four-edge synth graph is
    typically a minute or two, but cold caches, worker warm-up, and
    chain retries can extend this. Cached in `_SYNTH_CACHE` after
    success so subsequent tests in the session don't re-invoke.
    """
    cmd = [
        sys.executable, "-m", "bayes.test_harness",
        "--graph", graph_name,
        "--enrich",
        "--no-webhook",
    ]
    result = subprocess.run(
        cmd, capture_output=True, text=True, timeout=900,
        cwd=str(DAGNET_ROOT),
        env={**os.environ, "DB_CONNECTION": _resolve_db_url()},
    )
    if result.returncode != 0:
        print(f"[requires_synth] Bayesian enrichment failed for {graph_name}:\n"
              f"{result.stderr[-2000:]}")
        return False
    return True


def _ensure_synth_ready(graph_name: str, enriched: bool,
                        bayesian: bool = False) -> None:
    """Check freshness and bootstrap if needed. Calls pytest.skip on failure.

    `bayesian=True` implies `enriched=True`: you cannot have a bayesian
    model_var without the model_vars structure. When set, triggers
    `bayes/test_harness.py --enrich` after hydrate to apply real MCMC
    posteriors to the graph.
    """
    repo = _resolve_data_repo_dir()
    if repo is None:
        pytest.skip("Data repo not available")
    db = _resolve_db_url()
    if not db:
        pytest.skip("DB_CONNECTION not set")

    cache_key = f"{graph_name}:enriched={enriched}:bayesian={bayesian}"
    if cache_key in _SYNTH_CACHE:
        return

    # Bayesian implies hydrate enrichment.
    need_enrich = enriched or bayesian

    result = _call_verify_synth_data(
        graph_name, str(repo),
        check_enrichment=need_enrich,
        check_bayesian=bayesian,
        check_param_files=True,
        check_event_hashes=True,
    )
    status = result["status"]

    if status in ("stale", "missing"):
        print(f"[requires_synth] {graph_name}: {status} — bootstrapping...")
        ok = _bootstrap_synth_graph(graph_name)
        if not ok:
            pytest.skip(f"Synth bootstrap failed for {graph_name}")
        # Bootstrap without --enrich clears model_vars. Advance the
        # state machine to the earliest outstanding step so the
        # following if-blocks pick it up.
        if need_enrich:
            status = "needs_enrichment"
        else:
            status = "fresh"

    if status == "needs_enrichment" and need_enrich:
        print(f"[requires_synth] {graph_name}: enriching (hydrate)...")
        ok = _bootstrap_synth_graph(graph_name, enrich=True)
        if not ok:
            pytest.skip(f"Synth enrichment failed for {graph_name}")
        status = "needs_bayesian_enrichment" if bayesian else "fresh"

    if status == "needs_bayesian_enrichment" and bayesian:
        print(f"[requires_synth] {graph_name}: bayesian-enriching (MCMC) — "
              f"this may take minutes...")
        ok = _bayesian_enrich_synth_graph(graph_name)
        if not ok:
            pytest.skip(
                f"Bayesian enrichment failed for {graph_name} "
                f"(bayes worker and/or FE CLI unavailable?)"
            )
        status = "fresh"

    if status == "no_truth":
        pytest.skip(f"No truth file for {graph_name}")

    _SYNTH_CACHE[cache_key] = status


def requires_synth(graph_name: str, *, enriched: bool = False,
                   bayesian: bool = False):
    """Decorator that ensures a synth graph is ready before the test runs.

    Works on both functions and classes. When applied to a class, wraps
    every test method.

    Checks freshness via verify_synth_data. If stale or missing, triggers
    bootstrap via synth_gen.py --write-files. If enriched=True (or
    bayesian=True, which implies it) and graph is not hydrate-enriched,
    triggers synth_gen.py --enrich. If bayesian=True and graph lacks
    bayesian model_vars, additionally triggers bayes/test_harness.py
    --enrich (MCMC + apply-patch).

    Skips cleanly if infrastructure (data repo, DB, bayes worker) is
    unavailable. Session-scoped: regen/enrichment happens at most once
    per (graph, enriched, bayesian) tuple per session.
    """
    def decorator(fn_or_cls):
        import inspect
        if inspect.isclass(fn_or_cls):
            # Class decorator: wrap every test_ method
            for name in list(vars(fn_or_cls)):
                if name.startswith("test_") and callable(getattr(fn_or_cls, name)):
                    original = getattr(fn_or_cls, name)
                    @functools.wraps(original)
                    def wrapped(*args, _orig=original, **kwargs):
                        _ensure_synth_ready(graph_name, enriched, bayesian)
                        return _orig(*args, **kwargs)
                    setattr(fn_or_cls, name, wrapped)
            return fn_or_cls
        else:
            @functools.wraps(fn_or_cls)
            def wrapper(*args, **kwargs):
                _ensure_synth_ready(graph_name, enriched, bayesian)
                return fn_or_cls(*args, **kwargs)
            return wrapper
    return decorator
