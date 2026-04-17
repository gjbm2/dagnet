"""Blind tests for the @requires_synth declarative fixture.

Written BEFORE implementation to define the contract.
All tests use mocks — never touch real data repo or DB.

Tests cover:
  - Skip behaviour when infrastructure is unavailable
  - Fresh graph: no regen triggered
  - Stale/missing graph: bootstrap triggered via subprocess
  - Enrichment commissioning
  - Session-scoped caching (regen only once per graph)
  - Shared fixture helpers (data_repo_dir, db_url)
"""

import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch, call

import pytest


# ---------------------------------------------------------------------------
# Test: shared fixtures (data_repo_dir, db_url)
# ---------------------------------------------------------------------------

class TestSharedFixtures:
    """Shared conftest fixtures replace copy-pasted boilerplate."""

    def test_data_repo_dir_resolves_from_conf(self, tmp_path, monkeypatch):
        """data_repo_dir fixture reads .private-repos.conf and resolves path."""
        # Build a mock repo structure
        conf = tmp_path / ".private-repos.conf"
        conf.write_text("DATA_REPO_DIR=my-data-repo\nMONOREPO_DIR=mono\n")
        (tmp_path / "my-data-repo" / "graphs").mkdir(parents=True)

        from conftest import _resolve_data_repo_dir
        result = _resolve_data_repo_dir(str(tmp_path))
        assert result is not None
        assert result.name == "my-data-repo"
        assert (result / "graphs").is_dir()

    def test_data_repo_dir_returns_none_when_missing(self, tmp_path):
        """Returns None when .private-repos.conf doesn't exist."""
        from conftest import _resolve_data_repo_dir
        result = _resolve_data_repo_dir(str(tmp_path))
        assert result is None

    def test_db_url_from_env(self, monkeypatch):
        """db_url reads DB_CONNECTION from environment."""
        monkeypatch.setenv("DB_CONNECTION", "postgresql://test:1234/db")
        from conftest import _resolve_db_url
        assert _resolve_db_url() == "postgresql://test:1234/db"

    def test_db_url_falls_back_to_env_local(self, monkeypatch):
        """db_url falls back to .env.local when env var is unset."""
        monkeypatch.delenv("DB_CONNECTION", raising=False)
        from conftest import _resolve_db_url
        # Should still find the URL from .env.local (if it exists)
        # or return '' if .env.local is also absent
        result = _resolve_db_url()
        assert isinstance(result, str)


# ---------------------------------------------------------------------------
# Test: requires_synth decorator
# ---------------------------------------------------------------------------

class TestRequiresSynth:
    """The @requires_synth decorator ensures synth graph readiness."""

    def test_skips_when_no_data_repo(self, monkeypatch):
        """Test is skipped cleanly when data repo is unavailable."""
        from conftest import requires_synth, _resolve_data_repo_dir

        with patch("conftest._resolve_data_repo_dir", return_value=None):
            marker = requires_synth("synth-test-graph")

            @marker
            def dummy_test():
                pass  # pragma: no cover

            with pytest.raises(pytest.skip.Exception):
                dummy_test()

    def test_skips_when_no_db(self, monkeypatch):
        """Test is skipped cleanly when DB_CONNECTION is not set."""
        from conftest import requires_synth

        with patch("conftest._resolve_data_repo_dir",
                   return_value=Path("/fake/repo")), \
             patch("conftest._resolve_db_url", return_value=""):
            marker = requires_synth("synth-test-graph")

            @marker
            def dummy_test():
                pass  # pragma: no cover

            with pytest.raises(pytest.skip.Exception):
                dummy_test()

    def test_no_regen_when_fresh(self, monkeypatch):
        """No subprocess call when graph is already fresh."""
        fresh_result = {
            "status": "fresh", "reason": "all good",
            "reasons": [], "row_count": 1000,
            "truth_sha256": "abc", "graph_sha256": "def",
            "enriched": False, "meta": {},
        }
        with patch("conftest._resolve_data_repo_dir",
                   return_value=Path("/fake/repo")), \
             patch("conftest._resolve_db_url", return_value="pg://db"), \
             patch("conftest._call_verify_synth_data",
                   return_value=fresh_result) as mock_verify, \
             patch("conftest.subprocess.run") as mock_run:

            from conftest import requires_synth
            marker = requires_synth("synth-test-graph")

            @marker
            def dummy_test():
                pass

            dummy_test()
            mock_run.assert_not_called()

    def test_triggers_bootstrap_when_stale(self):
        """Calls synth_gen.py --write-files when graph is stale."""
        stale_result = {
            "status": "stale", "reason": "truth changed",
            "reasons": ["truth changed"], "row_count": 0,
            "truth_sha256": "abc", "graph_sha256": "def",
            "enriched": False, "meta": {},
        }
        fresh_after = {
            "status": "fresh", "reason": "rebuilt",
            "reasons": [], "row_count": 1000,
            "truth_sha256": "abc", "graph_sha256": "def",
            "enriched": False, "meta": {},
        }
        with patch("conftest._resolve_data_repo_dir",
                   return_value=Path("/fake/repo")), \
             patch("conftest._resolve_db_url", return_value="pg://db"), \
             patch("conftest._call_verify_synth_data",
                   side_effect=[stale_result, fresh_after]), \
             patch("conftest.subprocess.run",
                   return_value=MagicMock(returncode=0)) as mock_run:

            from conftest import requires_synth, _synth_cache_clear
            _synth_cache_clear()
            marker = requires_synth("synth-test-graph")

            @marker
            def dummy_test():
                pass

            dummy_test()
            # Should have called synth_gen.py
            assert mock_run.called
            args = mock_run.call_args
            cmd = args[0][0] if args[0] else args.kwargs.get("args", [])
            assert any("synth_gen" in str(c) or "synth_gen.py" in str(c)
                       for c in cmd)
            assert "--write-files" in cmd

    def test_triggers_bootstrap_when_missing(self):
        """Calls synth_gen.py --write-files when graph data is missing."""
        missing_result = {
            "status": "missing", "reason": "no rows",
            "reasons": ["no rows"], "row_count": 0,
            "truth_sha256": "abc", "graph_sha256": "",
            "enriched": False, "meta": {},
        }
        fresh_after = {
            "status": "fresh", "reason": "rebuilt",
            "reasons": [], "row_count": 1000,
            "truth_sha256": "abc", "graph_sha256": "def",
            "enriched": False, "meta": {},
        }
        with patch("conftest._resolve_data_repo_dir",
                   return_value=Path("/fake/repo")), \
             patch("conftest._resolve_db_url", return_value="pg://db"), \
             patch("conftest._call_verify_synth_data",
                   side_effect=[missing_result, fresh_after]), \
             patch("conftest.subprocess.run",
                   return_value=MagicMock(returncode=0)):

            from conftest import requires_synth
            marker = requires_synth("synth-test-graph")

            @marker
            def dummy_test():
                pass

            dummy_test()  # Should not raise

    def test_triggers_enrichment_when_needed(self):
        """Calls synth_gen.py --enrich when enriched=True but graph unenriched."""
        unenriched_result = {
            "status": "needs_enrichment", "reason": "not enriched",
            "reasons": ["not enriched"], "row_count": 1000,
            "truth_sha256": "abc", "graph_sha256": "def",
            "enriched": False, "meta": {},
        }
        enriched_after = {
            "status": "fresh", "reason": "enriched",
            "reasons": [], "row_count": 1000,
            "truth_sha256": "abc", "graph_sha256": "def",
            "enriched": True, "meta": {},
        }
        with patch("conftest._resolve_data_repo_dir",
                   return_value=Path("/fake/repo")), \
             patch("conftest._resolve_db_url", return_value="pg://db"), \
             patch("conftest._call_verify_synth_data",
                   side_effect=[unenriched_result, enriched_after]), \
             patch("conftest.subprocess.run",
                   return_value=MagicMock(returncode=0)) as mock_run:

            from conftest import requires_synth
            marker = requires_synth("synth-test-graph", enriched=True)

            @marker
            def dummy_test():
                pass

            dummy_test()
            assert mock_run.called
            args = mock_run.call_args
            cmd = args[0][0] if args[0] else args.kwargs.get("args", [])
            assert "--enrich" in cmd

    def test_session_scoped_runs_once(self):
        """Regen only happens once per graph per session."""
        call_count = 0
        stale_result = {
            "status": "stale", "reason": "truth changed",
            "reasons": ["truth changed"], "row_count": 0,
            "truth_sha256": "abc", "graph_sha256": "def",
            "enriched": False, "meta": {},
        }
        fresh_result = {
            "status": "fresh", "reason": "ok",
            "reasons": [], "row_count": 1000,
            "truth_sha256": "abc", "graph_sha256": "def",
            "enriched": False, "meta": {},
        }

        def _mock_verify(name, repo, **kw):
            nonlocal call_count
            call_count += 1
            # First call stale, subsequent calls fresh
            return stale_result if call_count <= 1 else fresh_result

        with patch("conftest._resolve_data_repo_dir",
                   return_value=Path("/fake/repo")), \
             patch("conftest._resolve_db_url", return_value="pg://db"), \
             patch("conftest._call_verify_synth_data",
                   side_effect=_mock_verify), \
             patch("conftest.subprocess.run",
                   return_value=MagicMock(returncode=0)) as mock_run:

            from conftest import requires_synth, _synth_cache_clear
            _synth_cache_clear()  # reset session cache

            marker = requires_synth("synth-same-graph")

            @marker
            def test_a():
                pass

            @marker
            def test_b():
                pass

            test_a()  # triggers regen
            test_b()  # should NOT trigger regen again
            assert mock_run.call_count == 1
