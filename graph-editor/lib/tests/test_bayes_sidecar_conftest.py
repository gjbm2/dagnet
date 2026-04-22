"""
Blind contract tests for conftest-level bayesian sidecar support.

Covers:
  - `load_graph_json(name, bayesian=False)` default keeps current
    behaviour (no injection).
  - `load_graph_json(name, bayesian=True)` triggers
    `_ensure_bayes_sidecar` and injects.
  - `_ensure_bayes_sidecar` calls the MCMC subprocess only when the
    sidecar is missing or stale; session-cached within a pytest process.
  - Subprocess failures propagate cleanly (tests can skip, don't hang).
  - The old `_bayesian_enrich_synth_graph` (graph-write path) is no
    longer invoked from the bayesian-ready path.

No actual MCMC runs here — subprocess.run is patched. Tests use tmp_path
for sidecars and mock the data-repo/truth resolution.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


# Ensure lib/tests is importable as conftest AND the top-level `bayes`
# package is resolvable when run from any cwd.
_HERE = Path(__file__).resolve().parent
_LIB_DIR = _HERE.parent
_DAGNET_ROOT = _HERE.parents[2]  # lib/tests → lib → graph-editor → dagnet
for _p in (_LIB_DIR, _DAGNET_ROOT):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))


@pytest.fixture(autouse=True)
def _reset_session_caches():
    """Each test starts with empty session caches so cache hit/miss
    behaviour is deterministic."""
    import conftest as cf
    cf._SYNTH_CACHE.clear()
    if hasattr(cf, "_SIDECAR_CACHE"):
        cf._SIDECAR_CACHE.clear()
    if hasattr(cf, "_load_graph_text"):
        try:
            cf._load_graph_text.cache_clear()
        except AttributeError:
            pass
    yield
    cf._SYNTH_CACHE.clear()
    if hasattr(cf, "_SIDECAR_CACHE"):
        cf._SIDECAR_CACHE.clear()


# ─── Fixtures: minimal on-disk layout ──────────────────────────────────

@pytest.fixture
def fake_repo(tmp_path, monkeypatch):
    """A minimal data repo with a graph + truth + two param files.

    Returns a namespace carrying paths, the graph dict as written, and
    the sidecar path conftest will resolve to."""
    repo = tmp_path / "fake-data-repo"
    (repo / "graphs").mkdir(parents=True)
    (repo / "parameters").mkdir(parents=True)
    (repo / "events").mkdir()

    graph = {
        "nodes": [
            {"id": "a", "uuid": "node-a", "event_id": "ev-a",
             "entry": {"is_start": True}},
            {"id": "b", "uuid": "node-b", "event_id": "ev-b"},
        ],
        "edges": [
            {
                "uuid": "edge-1", "id": "simple-a-to-b",
                "from": "node-a", "to": "node-b",
                "query": "from(a).to(b)",
                "p": {
                    "id": "simple-a-to-b",
                    "latency": {
                        "mu": 2.3, "sigma": 0.5, "onset_delta_days": 1,
                        "latency_parameter": True,
                    },
                    "model_vars": [
                        {"source": "analytic",
                         "latency": {"mu": 2.3, "sigma": 0.5, "mu_sd": 0.02}},
                    ],
                },
            },
        ],
    }
    gpath = repo / "graphs" / "synth-simple-abc.json"
    gpath.write_text(json.dumps(graph))

    truth = repo / "graphs" / "synth-simple-abc.truth.yaml"
    truth.write_text("edges:\n  - param_id: simple-a-to-b\n    mu: 2.3\n")

    p1 = repo / "parameters" / "simple-a-to-b.yaml"
    p1.write_text("id: simple-a-to-b\nvalues: []\n")

    sidecar_dir = tmp_path / "dagnet" / "bayes" / "fixtures"
    sidecar_dir.mkdir(parents=True)
    sidecar_path = sidecar_dir / "synth-simple-abc.bayes-vars.json"

    # Patch conftest's data-repo, sidecar-dir, and fingerprint input
    # resolvers. The last two are critical: without patching
    # _resolve_truth_path, fingerprint computation would escape the
    # fake_repo and hash the real bayes/truth/<graph>.truth.yaml (which
    # exists for synth-simple-abc) — the test's fresh-sidecar would then
    # have a mismatching fingerprint and conftest would shell out to a
    # real MCMC instead of returning the fixture.
    import conftest as cf
    monkeypatch.setattr(cf, "_resolve_data_repo_dir", lambda root=None: repo,
                        raising=True)
    if hasattr(cf, "_resolve_bayes_fixtures_dir"):
        monkeypatch.setattr(cf, "_resolve_bayes_fixtures_dir",
                            lambda: sidecar_dir, raising=True)
    if hasattr(cf, "_resolve_truth_path"):
        monkeypatch.setattr(cf, "_resolve_truth_path",
                            lambda name: truth if name == "synth-simple-abc" else None,
                            raising=True)
    if hasattr(cf, "_resolve_param_paths"):
        monkeypatch.setattr(cf, "_resolve_param_paths",
                            lambda name: [p1] if name == "synth-simple-abc" else [],
                            raising=True)

    class _Ns:
        pass
    ns = _Ns()
    ns.repo = repo
    ns.graph_path = gpath
    ns.truth_path = truth
    ns.param_paths = [p1]
    ns.sidecar_path = sidecar_path
    ns.graph = graph
    return ns


def _bayes_entry():
    return {
        "source": "bayesian",
        "source_at": "22-Apr-26 14:30:00",
        "probability": {"mean": 0.70, "stdev": 0.08},
        "latency": {
            "mu": 2.3, "sigma": 0.52, "t95": 24.5,
            "onset_delta_days": 1.03,
            "mu_sd": 0.08, "sigma_sd": 0.01,
            "onset_sd": 0.07, "onset_mu_corr": -0.8,
        },
        "quality": {"rhat": 1.001, "gate_passed": True},
    }


# ─── load_graph_json(bayesian=...) contract ───────────────────────────

class TestLoadGraphJsonBayesianFalse:
    """Default bayesian=False: existing behaviour, no injection."""

    def test_returns_graph_without_bayesian_entry(self, fake_repo):
        from conftest import load_graph_json
        g = load_graph_json("synth-simple-abc")  # default False
        sources = [m.get("source")
                   for m in g["edges"][0]["p"]["model_vars"]]
        assert "bayesian" not in sources

    def test_does_not_touch_filesystem_sidecar(self, fake_repo):
        from conftest import load_graph_json
        load_graph_json("synth-simple-abc")
        # Sidecar must not have been created.
        assert not fake_repo.sidecar_path.exists()


class TestLoadGraphJsonBayesianTrue:
    """bayesian=True: ensures sidecar, injects, returns merged dict."""

    def _write_fresh_sidecar(self, fake_repo):
        """Helper — write a valid sidecar with current fingerprint."""
        from bayes.sidecar import save_sidecar, compute_fingerprint
        fp = compute_fingerprint(
            str(fake_repo.truth_path),
            [str(p) for p in fake_repo.param_paths],
        )
        save_sidecar(str(fake_repo.sidecar_path), fp,
                     {"edge-1": _bayes_entry()})

    def test_returns_graph_with_bayesian_injected(self, fake_repo):
        self._write_fresh_sidecar(fake_repo)
        from conftest import load_graph_json
        g = load_graph_json("synth-simple-abc", bayesian=True)
        sources = [m.get("source")
                   for m in g["edges"][0]["p"]["model_vars"]]
        assert "bayesian" in sources

    def test_promoted_fields_set_on_latency(self, fake_repo):
        self._write_fresh_sidecar(fake_repo)
        from conftest import load_graph_json
        g = load_graph_json("synth-simple-abc", bayesian=True)
        lat = g["edges"][0]["p"]["latency"]
        assert lat.get("promoted_mu_sd") == pytest.approx(0.08)

    def test_does_not_call_mcmc_when_sidecar_is_fresh(self, fake_repo):
        self._write_fresh_sidecar(fake_repo)
        with patch("conftest.subprocess.run") as mock_run:
            from conftest import load_graph_json
            load_graph_json("synth-simple-abc", bayesian=True)
            assert not mock_run.called, \
                "MCMC subprocess must not run when sidecar is fresh"

    def test_calls_mcmc_subprocess_when_sidecar_missing(self, fake_repo):
        """Absent sidecar → test_harness --enrich --sidecar-out <path>
        must be invoked once."""
        def fake_run(cmd, *a, **kw):
            # Simulate the subprocess writing the sidecar before exit.
            self._write_fresh_sidecar(fake_repo)
            return MagicMock(returncode=0, stdout="", stderr="")

        with patch("conftest.subprocess.run", side_effect=fake_run) as mock_run:
            from conftest import load_graph_json
            load_graph_json("synth-simple-abc", bayesian=True)
            assert mock_run.called
            # The invocation must pass --enrich --sidecar-out
            invocation_cmd = mock_run.call_args[0][0]
            assert "--enrich" in invocation_cmd
            assert "--sidecar-out" in invocation_cmd

    def test_calls_mcmc_when_fingerprint_is_stale(self, fake_repo):
        """Sidecar exists but fingerprint is old (truth/params changed)
        → MCMC must re-run."""
        from bayes.sidecar import save_sidecar
        stale_fp = {"truth_sha256": "stale", "param_file_hashes": {}}
        save_sidecar(str(fake_repo.sidecar_path), stale_fp,
                     {"edge-1": _bayes_entry()})

        def fake_run(cmd, *a, **kw):
            # Overwrite with a fresh sidecar.
            from bayes.sidecar import compute_fingerprint
            fp = compute_fingerprint(
                str(fake_repo.truth_path),
                [str(p) for p in fake_repo.param_paths],
            )
            save_sidecar(str(fake_repo.sidecar_path), fp,
                         {"edge-1": _bayes_entry()})
            return MagicMock(returncode=0, stdout="", stderr="")

        with patch("conftest.subprocess.run", side_effect=fake_run) as mock_run:
            from conftest import load_graph_json
            load_graph_json("synth-simple-abc", bayesian=True)
            assert mock_run.called

    def test_session_cached_mcmc_called_at_most_once(self, fake_repo):
        """Two consecutive load_graph_json(bayesian=True) in the same
        session must invoke MCMC once at most — the sidecar build is
        session-cached."""
        call_count = {"n": 0}

        def fake_run(cmd, *a, **kw):
            call_count["n"] += 1
            self._write_fresh_sidecar(fake_repo)
            return MagicMock(returncode=0, stdout="", stderr="")

        with patch("conftest.subprocess.run", side_effect=fake_run):
            from conftest import load_graph_json
            load_graph_json("synth-simple-abc", bayesian=True)
            load_graph_json("synth-simple-abc", bayesian=True)
            assert call_count["n"] <= 1

    def test_mcmc_failure_triggers_skip(self, fake_repo):
        """Subprocess non-zero exit → pytest.skip (not silent success)."""
        def fake_run(cmd, *a, **kw):
            return MagicMock(returncode=2, stdout="", stderr="mcmc boom")

        with patch("conftest.subprocess.run", side_effect=fake_run):
            from conftest import load_graph_json
            with pytest.raises((pytest.skip.Exception, RuntimeError)):
                load_graph_json("synth-simple-abc", bayesian=True)

    def test_never_writes_to_graph_file_on_disk(self, fake_repo):
        """Sidecar path must NEVER mutate the graph JSON file — that
        was the original bug."""
        self._write_fresh_sidecar(fake_repo)
        before = fake_repo.graph_path.read_bytes()
        from conftest import load_graph_json
        load_graph_json("synth-simple-abc", bayesian=True)
        after = fake_repo.graph_path.read_bytes()
        assert before == after


# ─── _ensure_synth_ready(bayesian=True) contract ──────────────────────

class TestEnsureSynthReadyBayesian:
    """_ensure_synth_ready(..., bayesian=True) must route bayesian
    freshness through the sidecar path, NOT through the old
    graph-writing _bayesian_enrich_synth_graph function."""

    def test_does_not_invoke_old_graph_write_helper(
        self, fake_repo, monkeypatch
    ):
        """_bayesian_enrich_synth_graph (if still present) must not be
        called — it writes to the graph file, which is precisely what
        we're eliminating."""
        import conftest as cf

        # If the old helper exists, replace it with a sentinel that fails
        # loudly if called.
        if hasattr(cf, "_bayesian_enrich_synth_graph"):
            def boom(*a, **kw):
                raise AssertionError(
                    "_bayesian_enrich_synth_graph must not be called under "
                    "the sidecar design"
                )
            monkeypatch.setattr(cf, "_bayesian_enrich_synth_graph", boom,
                                raising=True)

        # Also stub verify + data-repo so _ensure_synth_ready sees "fresh".
        monkeypatch.setattr(
            cf, "_call_verify_synth_data",
            lambda *a, **kw: {
                "status": "fresh", "reason": "ok", "reasons": [],
                "row_count": 100, "truth_sha256": "t", "graph_sha256": "g",
                "enriched": True, "bayesian_enriched": False, "meta": {},
            },
        )
        monkeypatch.setattr(cf, "_resolve_db_url", lambda: "pg://fake",
                            raising=True)

        # Stub the sidecar helper to avoid real MCMC.
        if hasattr(cf, "_ensure_bayes_sidecar"):
            monkeypatch.setattr(cf, "_ensure_bayes_sidecar",
                                lambda name: {"edge-1": _bayes_entry()},
                                raising=True)

        cf._ensure_synth_ready("synth-simple-abc", enriched=True,
                               bayesian=True)

    def test_calls_sidecar_ensure_when_bayesian_true(
        self, fake_repo, monkeypatch
    ):
        """When bayesian=True, _ensure_bayes_sidecar is invoked."""
        import conftest as cf

        called = {"sidecar": False}
        monkeypatch.setattr(
            cf, "_ensure_bayes_sidecar",
            lambda name: called.__setitem__("sidecar", True)
                         or {"edge-1": _bayes_entry()},
            raising=True,
        )
        monkeypatch.setattr(
            cf, "_call_verify_synth_data",
            lambda *a, **kw: {
                "status": "fresh", "reason": "ok", "reasons": [],
                "row_count": 100, "truth_sha256": "t", "graph_sha256": "g",
                "enriched": True, "bayesian_enriched": False, "meta": {},
            },
        )
        monkeypatch.setattr(cf, "_resolve_db_url", lambda: "pg://fake",
                            raising=True)

        cf._ensure_synth_ready("synth-simple-abc", enriched=True,
                               bayesian=True)
        assert called["sidecar"] is True

    def test_sidecar_not_called_when_bayesian_false(
        self, fake_repo, monkeypatch
    ):
        """Pure enriched=True tests must not pay the sidecar cost."""
        import conftest as cf

        called = {"sidecar": False}
        if hasattr(cf, "_ensure_bayes_sidecar"):
            monkeypatch.setattr(
                cf, "_ensure_bayes_sidecar",
                lambda name: called.__setitem__("sidecar", True)
                             or {"edge-1": _bayes_entry()},
                raising=True,
            )
        monkeypatch.setattr(
            cf, "_call_verify_synth_data",
            lambda *a, **kw: {
                "status": "fresh", "reason": "ok", "reasons": [],
                "row_count": 100, "truth_sha256": "t", "graph_sha256": "g",
                "enriched": True, "bayesian_enriched": False, "meta": {},
            },
        )
        monkeypatch.setattr(cf, "_resolve_db_url", lambda: "pg://fake",
                            raising=True)

        cf._ensure_synth_ready("synth-simple-abc", enriched=True,
                               bayesian=False)
        assert called["sidecar"] is False
