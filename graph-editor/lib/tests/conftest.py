"""
Pytest configuration for tests under graph-editor/lib/tests.

Provides:
  - sys.path setup so `import lib.*` works
  - Shared fixtures: data_repo_dir, db_url
  - Shared markers: requires_db, requires_data_repo
  - Declarative synth fixture: requires_synth(graph_name, enriched=bool)
"""

from __future__ import annotations

import functools
import json
import os
import subprocess
import sys
from pathlib import Path

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


def _ensure_synth_ready(graph_name: str, enriched: bool) -> None:
    """Check freshness and bootstrap if needed. Calls pytest.skip on failure."""
    repo = _resolve_data_repo_dir()
    if repo is None:
        pytest.skip("Data repo not available")
    db = _resolve_db_url()
    if not db:
        pytest.skip("DB_CONNECTION not set")

    cache_key = f"{graph_name}:enriched={enriched}"
    if cache_key in _SYNTH_CACHE:
        return

    result = _call_verify_synth_data(
        graph_name, str(repo),
        check_enrichment=enriched,
        check_param_files=True,
        check_event_hashes=True,
    )
    status = result["status"]

    if status in ("stale", "missing"):
        print(f"[requires_synth] {graph_name}: {status} — bootstrapping...")
        ok = _bootstrap_synth_graph(graph_name)
        if not ok:
            pytest.skip(f"Synth bootstrap failed for {graph_name}")
        status = "fresh"

    if status == "needs_enrichment" and enriched:
        print(f"[requires_synth] {graph_name}: enriching...")
        ok = _bootstrap_synth_graph(graph_name, enrich=True)
        if not ok:
            pytest.skip(f"Synth enrichment failed for {graph_name}")
        status = "fresh"

    if status == "no_truth":
        pytest.skip(f"No truth file for {graph_name}")

    _SYNTH_CACHE[cache_key] = status


def requires_synth(graph_name: str, *, enriched: bool = False):
    """Decorator that ensures a synth graph is ready before the test runs.

    Works on both functions and classes. When applied to a class, wraps
    every test method.

    Checks freshness via verify_synth_data. If stale or missing, triggers
    bootstrap via synth_gen.py --write-files. If enriched=True and graph
    is not enriched, triggers synth_gen.py --enrich.

    Skips cleanly if infrastructure (data repo, DB) is unavailable.
    Session-scoped: regen happens at most once per graph per session.
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
                        _ensure_synth_ready(graph_name, enriched)
                        return _orig(*args, **kwargs)
                    setattr(fn_or_cls, name, wrapped)
            return fn_or_cls
        else:
            @functools.wraps(fn_or_cls)
            def wrapper(*args, **kwargs):
                _ensure_synth_ready(graph_name, enriched)
                return fn_or_cls(*args, **kwargs)
            return wrapper
    return decorator
