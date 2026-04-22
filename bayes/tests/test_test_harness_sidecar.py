"""
Blind contract tests for `bayes/test_harness.py --enrich --sidecar-out`.

The test harness currently writes MCMC posteriors into the graph file
via the FE CLI apply-patch path. The sidecar redesign adds a
`--sidecar-out <path>` flag that redirects the write target to a tiny
JSON sidecar (keyed by a truth+params fingerprint) and skips the graph
write entirely. This avoids the graph-file-clobber flip-flop that makes
every pytest session re-run MCMC.

Contract covered here:
  - The writer helper `_write_bayes_sidecar_from_result` transforms the
    webhook_payload_edges shape into the sidecar's edges dict and writes
    it via `bayes.sidecar.save_sidecar` using the supplied fingerprint.
  - CLI `--sidecar-out` parses cleanly.
  - When `--sidecar-out` is set, the FE CLI apply-patch subprocess is
    NOT invoked; graph file is NOT written.
  - When `--sidecar-out` is absent, existing apply-patch behaviour is
    unchanged.
  - Sidecar write failure (e.g. unwritable path) causes CLI to exit
    non-zero — silent-swallow is the failure mode that would let the
    conftest cache "fresh" on a broken run.

MCMC itself is not invoked here — the helper takes a pre-built `result`
dict shaped like the real harness output, so these tests run in
milliseconds.
"""
from __future__ import annotations

import json
import os
import sys

import pytest

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)


# ─── Helpers ──────────────────────────────────────────────────────────

def _sample_webhook_result():
    """Shape-match the `result` dict produced by test_harness.run_mcmc,
    enough to feed the sidecar writer."""
    return {
        "job_id": "harness-enrich-test",
        "fitted_at": "22-Apr-26 14:30:00",
        "fingerprint": "abc123",
        "model_version": 1,
        "quality": {"rhat_max": 1.001, "ess_min": 15000},
        "skipped": [],
        "webhook_payload_edges": [
            {
                "edge_uuid": "edge-1",
                "param_id": "simple-a-to-b",
                "probability": {"mean": 0.70, "stdev": 0.08},
                "latency": {
                    "mu": 2.3, "sigma": 0.52, "t95": 24.5,
                    "onset_delta_days": 1.03,
                    "mu_sd": 0.08, "sigma_sd": 0.01,
                    "onset_sd": 0.07, "onset_mu_corr": -0.8,
                },
                "quality": {"gate_passed": True, "rhat": 1.001},
            },
            {
                "edge_uuid": "edge-2",
                "param_id": "simple-b-to-c",
                "probability": {"mean": 0.60, "stdev": 0.09},
                "latency": {
                    "mu": 2.5, "sigma": 0.61, "t95": 28.0,
                    "onset_delta_days": 1.97,
                    "mu_sd": 0.09, "sigma_sd": 0.02,
                    "onset_sd": 0.10, "onset_mu_corr": -0.7,
                },
                "quality": {"gate_passed": True, "rhat": 1.002},
            },
        ],
    }


def _sample_fingerprint():
    return {
        "truth_sha256": "t" * 64,
        "param_file_hashes": {
            "simple-a-to-b": "p1hash",
            "simple-b-to-c": "p2hash",
        },
    }


# ─── Sidecar writer helper ────────────────────────────────────────────

class TestSidecarWriter:
    """_write_bayes_sidecar_from_result(result, sidecar_path, fingerprint)
    reshapes webhook_payload_edges into the sidecar's edges dict and
    persists it. Unit-level — no MCMC, no subprocess."""

    def test_writes_file_at_target_path(self, tmp_path):
        from bayes.test_harness import _write_bayes_sidecar_from_result
        out = tmp_path / "s.json"
        _write_bayes_sidecar_from_result(
            _sample_webhook_result(), str(out), _sample_fingerprint()
        )
        assert out.exists()

    def test_sidecar_keyed_by_edge_uuid(self, tmp_path):
        from bayes.test_harness import _write_bayes_sidecar_from_result
        out = tmp_path / "s.json"
        _write_bayes_sidecar_from_result(
            _sample_webhook_result(), str(out), _sample_fingerprint()
        )
        data = json.loads(out.read_text())
        assert set(data["edges"].keys()) == {"edge-1", "edge-2"}

    def test_each_edge_entry_has_bayesian_source(self, tmp_path):
        from bayes.test_harness import _write_bayes_sidecar_from_result
        out = tmp_path / "s.json"
        _write_bayes_sidecar_from_result(
            _sample_webhook_result(), str(out), _sample_fingerprint()
        )
        data = json.loads(out.read_text())
        for entry in data["edges"].values():
            assert entry["source"] == "bayesian"

    def test_latency_and_probability_copied_through(self, tmp_path):
        from bayes.test_harness import _write_bayes_sidecar_from_result
        out = tmp_path / "s.json"
        _write_bayes_sidecar_from_result(
            _sample_webhook_result(), str(out), _sample_fingerprint()
        )
        data = json.loads(out.read_text())
        e1 = data["edges"]["edge-1"]
        assert e1["latency"]["mu"] == pytest.approx(2.3)
        assert e1["latency"]["mu_sd"] == pytest.approx(0.08)
        assert e1["probability"]["mean"] == pytest.approx(0.70)

    def test_fingerprint_persisted(self, tmp_path):
        from bayes.test_harness import _write_bayes_sidecar_from_result
        out = tmp_path / "s.json"
        fp = _sample_fingerprint()
        _write_bayes_sidecar_from_result(
            _sample_webhook_result(), str(out), fp
        )
        data = json.loads(out.read_text())
        assert data["fingerprint"] == fp

    def test_sidecar_round_trips_through_load(self, tmp_path):
        """Writer output must be loadable via bayes.sidecar.load_sidecar —
        catches schema drift between writer and loader."""
        from bayes.test_harness import _write_bayes_sidecar_from_result
        from bayes.sidecar import load_sidecar
        out = tmp_path / "s.json"
        fp = _sample_fingerprint()
        _write_bayes_sidecar_from_result(
            _sample_webhook_result(), str(out), fp
        )
        edges = load_sidecar(str(out), expected_fingerprint=fp)
        assert edges is not None
        assert "edge-1" in edges

    def test_raises_when_webhook_payload_empty(self, tmp_path):
        """Empty webhook_payload_edges means MCMC produced no valid
        posteriors — caller must know, don't silently write an empty
        sidecar that later masquerades as 'fresh'."""
        from bayes.test_harness import _write_bayes_sidecar_from_result
        out = tmp_path / "s.json"
        with pytest.raises((ValueError, RuntimeError)):
            _write_bayes_sidecar_from_result(
                {"webhook_payload_edges": []}, str(out), _sample_fingerprint()
            )


# ─── CLI flag routing ─────────────────────────────────────────────────

class TestCliFlag:
    """--sidecar-out argument is parseable and routes writes away from
    the graph file. These tests avoid running MCMC by patching the
    harness's inference entry point."""

    def test_flag_is_registered(self):
        """Argparse accepts --sidecar-out without failing."""
        from bayes.test_harness import _build_arg_parser
        parser = _build_arg_parser()
        args = parser.parse_args([
            "--graph", "synth-simple-abc",
            "--enrich",
            "--no-webhook",
            "--sidecar-out", "/tmp/out.json",
        ])
        assert getattr(args, "sidecar_out", None) == "/tmp/out.json"

    def test_apply_patch_not_invoked_when_sidecar_out_set(
        self, tmp_path, monkeypatch
    ):
        """When --sidecar-out is passed, the FE CLI apply-patch subprocess
        (which writes the graph file) must NOT run. Uses the harness's
        post-MCMC dispatch with a fake `result` to avoid the MCMC cost."""
        import bayes.test_harness as th

        called = {"apply_patch": False, "sidecar_write": False}

        def fake_apply_patch(*a, **kw):
            called["apply_patch"] = True

        def fake_sidecar_write(result, path, fingerprint, graph_data=None):
            called["sidecar_write"] = True
            # Also create the file so downstream file-existence asserts pass.
            with open(path, "w") as f:
                json.dump({"edges": {}}, f)

        # Invoke the dispatch helper directly with `sidecar_out` set.
        # Contract: a helper exists that, given `args` and `result`, picks
        # either the apply-patch path or the sidecar-write path.
        monkeypatch.setattr(th, "_apply_patch_to_graph",
                            fake_apply_patch, raising=False)
        monkeypatch.setattr(th, "_write_bayes_sidecar_from_result",
                            fake_sidecar_write, raising=False)

        out = tmp_path / "s.json"

        class _Args:
            enrich = True
            sidecar_out = str(out)

        th._dispatch_enrichment_write(
            args=_Args(),
            result=_sample_webhook_result(),
            graph_path=str(tmp_path / "graph.json"),
            graph_name="synth-simple-abc",
            fingerprint=_sample_fingerprint(),
        )

        assert called["sidecar_write"] is True
        assert called["apply_patch"] is False

    def test_apply_patch_invoked_when_sidecar_out_absent(
        self, tmp_path, monkeypatch
    ):
        """When --sidecar-out is not supplied, the existing apply-patch
        path runs unchanged."""
        import bayes.test_harness as th

        called = {"apply_patch": False, "sidecar_write": False}

        monkeypatch.setattr(
            th, "_apply_patch_to_graph",
            lambda *a, **kw: called.__setitem__("apply_patch", True),
            raising=False,
        )
        monkeypatch.setattr(
            th, "_write_bayes_sidecar_from_result",
            lambda *a, **kw: called.__setitem__("sidecar_write", True),
            raising=False,
        )

        class _Args:
            enrich = True
            sidecar_out = None

        th._dispatch_enrichment_write(
            args=_Args(),
            result=_sample_webhook_result(),
            graph_path=str(tmp_path / "graph.json"),
            graph_name="synth-simple-abc",
            fingerprint=_sample_fingerprint(),
        )

        assert called["apply_patch"] is True
        assert called["sidecar_write"] is False

    def test_failure_propagates_non_zero_exit(self, tmp_path, monkeypatch):
        """If the sidecar write raises, _dispatch_enrichment_write must
        let the exception propagate (caller decides skip vs. fail). A
        silent-swallow would let the conftest cache 'fresh' on a broken
        run and cause downstream parity tests to run with wrong state."""
        import bayes.test_harness as th

        def boom(*a, **kw):
            raise RuntimeError("sidecar write failed")

        monkeypatch.setattr(th, "_write_bayes_sidecar_from_result", boom,
                            raising=False)

        class _Args:
            enrich = True
            sidecar_out = str(tmp_path / "s.json")

        with pytest.raises(RuntimeError):
            th._dispatch_enrichment_write(
                args=_Args(),
                result=_sample_webhook_result(),
                graph_path=str(tmp_path / "graph.json"),
                graph_name="synth-simple-abc",
                fingerprint=_sample_fingerprint(),
            )
