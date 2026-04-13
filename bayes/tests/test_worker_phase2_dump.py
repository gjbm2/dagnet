"""
E2E test for the Phase 2 debug artefact dump in worker._fit_graph_compiler.

Calls _fit_graph_compiler with a real diamond-context graph payload and
fabricated snapshot rows WITH context slices, mocking ONLY:
  - run_inference (skips MCMC, returns fake trace with correct variable names)
  - summarise_posteriors (returns minimal InferenceResult)
  - _query_snapshot_subjects (returns fabricated snapshot rows)
  - psycopg2.connect (DB connectivity check)

Everything else runs for real: topology analysis, bind_snapshot_evidence
(with contexted rows → has_slices=True), model build (with slice vectors),
Phase 1 posterior extraction (including per-slice vector indexing),
the debug artefact dump, Phase 2 model build.

This test exists because a NameError (graph_name) in the dump code crashed
the worker after 14 minutes of Phase 1 MCMC, destroying the debug artefacts
that were needed to investigate the Phase 2 init failure.

Run:
    . graph-editor/venv/bin/activate
    cd bayes && python -m pytest tests/test_worker_phase2_dump.py -v
"""

import json
import os
import pickle
import shutil
import sys
import unittest.mock as mock

import numpy as np
import pytest
import xarray as xr

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../graph-editor/lib"))

from compiler.types import (
    QualityMetrics,
    InferenceResult,
    PosteriorSummary,
    LatencyPosteriorSummary,
)


# ─────────────────────────────────────────────────────────────
# Snapshot row fabrication
# ─────────────────────────────────────────────────────────────

CTX_SLICES = ["organic", "paid"]
CTX_DIM = "synth-channel"
# Dates covering the DSL window: 12-Dec-25 to 21-Mar-26
ANCHOR_DAYS = ["2025-12-15", "2026-01-15", "2026-02-15", "2026-03-15"]
RETRIEVED_AT = "2026-03-20T00:00:00Z"


def _fabricate_snapshot_rows(edge_id, param_id):
    """Build snapshot rows for one edge: bare + 2 context slices, window + cohort.

    Produces rows that bind_snapshot_evidence will parse into:
      - Aggregate window/cohort observations (bare rows)
      - Per-slice observations via SliceGroups (context rows)
      - has_slices=True, has_cohort=True
    """
    rows = []
    rng = np.random.default_rng(hash(edge_id) % (2**31))

    for anchor_day in ANCHOR_DAYS:
        a = int(rng.integers(5000, 20000))  # anchor entrants

        # Bare aggregate rows (no context qualifier)
        for sk_type in ["window", "cohort"]:
            x = int(rng.integers(int(a * 0.3), int(a * 0.9)))
            y = int(rng.integers(int(x * 0.2), int(x * 0.8)))
            rows.append({
                "param_id": param_id,
                "core_hash": f"hash-{param_id[:16]}",
                "slice_key": f"{sk_type}(12-Dec-25:21-Mar-26)",
                "anchor_day": anchor_day,
                "retrieved_at": RETRIEVED_AT,
                "a": a,
                "x": x,
                "y": y,
                "median_lag_days": rng.uniform(5, 30),
                "mean_lag_days": rng.uniform(5, 30),
                "onset_delta_days": rng.uniform(0, 5),
            })

        # Context-qualified rows (one per slice per type)
        for ctx_val in CTX_SLICES:
            ctx_frac = 0.6 if ctx_val == "organic" else 0.4
            a_ctx = int(a * ctx_frac)
            for sk_type in ["window", "cohort"]:
                x = int(rng.integers(int(a_ctx * 0.3), int(a_ctx * 0.9)))
                y = int(rng.integers(int(x * 0.2), int(x * 0.8)))
                rows.append({
                    "param_id": param_id,
                    "core_hash": f"hash-{param_id[:16]}",
                    "slice_key": f"{sk_type}(12-Dec-25:21-Mar-26).context({CTX_DIM}:{ctx_val})",
                    "anchor_day": anchor_day,
                    "retrieved_at": RETRIEVED_AT,
                    "a": a_ctx,
                    "x": x,
                    "y": y,
                    "median_lag_days": rng.uniform(5, 30),
                    "mean_lag_days": rng.uniform(5, 30),
                    "onset_delta_days": rng.uniform(0, 5),
                })

    return rows


def _load_diamond_context_payload():
    """Build a real payload from synth-diamond-context with fabricated snapshot rows.

    Returns (payload_dict, fabricated_snapshot_rows) or (None, None) if data
    repo unavailable.
    """
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    conf_path = os.path.join(repo_root, ".private-repos.conf")
    data_repo_dir = ""
    for line in open(conf_path):
        if line.strip().startswith("DATA_REPO_DIR="):
            data_repo_dir = line.strip().split("=", 1)[1].strip().strip('"')
    data_repo = os.path.join(repo_root, data_repo_dir)
    graph_path = os.path.join(data_repo, "graphs", "synth-diamond-context.json")
    if not os.path.isfile(graph_path):
        return None, None

    with open(graph_path) as f:
        graph = json.load(f)

    # Load param files (still needed for priors)
    import yaml
    from compiler import analyse_topology
    topo = analyse_topology(graph)
    params_dir = os.path.join(data_repo, "parameters")
    param_files = {}
    params_index = {}
    for edge_id, et in topo.edges.items():
        if not et.param_id:
            continue
        param_path = os.path.join(params_dir, f"{et.param_id}.yaml")
        if os.path.isfile(param_path):
            with open(param_path) as f:
                param_files[et.param_id] = yaml.safe_load(f) or {}
            params_index[et.param_id] = {
                "file_path": f"parameters/{et.param_id}.yaml",
            }

    # Fabricate snapshot rows per edge
    snapshot_rows_by_edge = {}
    for edge_id, et in topo.edges.items():
        if not et.param_id:
            continue
        snapshot_rows_by_edge[edge_id] = _fabricate_snapshot_rows(edge_id, et.param_id)

    # Build snapshot_subjects (triggers snapshot evidence path in worker)
    # and commissioned_slices (tells binder which context keys to create SliceGroups for)
    snapshot_subjects = []
    for edge_id, et in topo.edges.items():
        if not et.param_id:
            continue
        slice_keys = []
        for ctx_val in CTX_SLICES:
            slice_keys.append(f"window(12-Dec-25:21-Mar-26).context({CTX_DIM}:{ctx_val})")
            slice_keys.append(f"cohort(12-Dec-25:21-Mar-26).context({CTX_DIM}:{ctx_val})")
        snapshot_subjects.append({
            "edge_id": edge_id,
            "target": {"targetId": edge_id},
            "slice_keys": slice_keys,
        })

    payload = {
        "graph_id": "test-diamond-context",
        "graph_snapshot": graph,
        "parameter_files": param_files,
        "parameters_index": params_index,
        "settings": {},
        "db_connection": "postgresql://fake:fake@localhost:5432/fake",
        "snapshot_subjects": snapshot_subjects,
        "mece_dimensions": [CTX_DIM],
    }

    return payload, snapshot_rows_by_edge


# ─────────────────────────────────────────────────────────────
# Fake trace / quality / inference result
# ─────────────────────────────────────────────────────────────

def _make_fake_trace(model):
    """Build a fake arviz-like InferenceData from a PyMC model.

    Creates an xarray Dataset with the same variable names as the model's
    free_RVs AND deterministics, filled with plausible random values.
    Deterministics (e.g. p_slice_vec, mu_slice_vec, kappa_slice_vec) must
    be included because the Phase 1 posterior extraction loop reads them
    from trace.posterior — arviz stores both free RVs and deterministics there.
    """
    n_chains = 2
    n_draws = 50
    posterior_vars = {}

    # Free RVs
    for rv in model.free_RVs:
        name = rv.name
        shape = tuple(rv.type.shape)
        if shape and all(s > 0 for s in shape):
            data = np.random.beta(5, 5, size=(n_chains, n_draws, *shape))
        else:
            data = np.random.beta(5, 5, size=(n_chains, n_draws))
        posterior_vars[name] = xr.DataArray(
            data,
            dims=["chain", "draw"] + [f"dim_{name}_{i}" for i in range(len(shape))],
        )

    # Deterministics (p_slice_vec, mu_slice_vec, kappa_slice_vec, etc.)
    # These appear in trace.posterior in real arviz InferenceData.
    for det in model.deterministics:
        name = det.name
        shape = tuple(det.type.shape)
        if shape and all(s > 0 for s in shape):
            data = np.random.beta(5, 5, size=(n_chains, n_draws, *shape))
        else:
            data = np.random.beta(5, 5, size=(n_chains, n_draws))
        posterior_vars[name] = xr.DataArray(
            data,
            dims=["chain", "draw"] + [f"dim_{name}_{i}" for i in range(len(shape))],
        )

    posterior_ds = xr.Dataset(posterior_vars)

    class FakeInferenceData:
        def __init__(self, posterior_ds):
            self.posterior = posterior_ds
            self.sample_stats = xr.Dataset({
                "diverging": xr.DataArray(
                    np.zeros((n_chains, n_draws), dtype=bool),
                    dims=["chain", "draw"],
                ),
            })
            self.log_likelihood = None

        def add_groups(self, groups):
            for name, data in groups.items():
                setattr(self, name, xr.Dataset(data))

    return FakeInferenceData(posterior_ds)


def _make_fake_quality():
    return QualityMetrics(
        max_rhat=1.01,
        min_ess=500.0,
        converged=True,
        total_divergences=0,
        converged_pct=100.0,
    )


def _make_fake_inference_result(topology, evidence):
    posteriors = []
    latency_posteriors = {}
    for edge_id, ev_edge in evidence.edges.items():
        if ev_edge.skipped:
            continue
        et = topology.edges.get(edge_id)
        posteriors.append(PosteriorSummary(
            edge_id=edge_id,
            param_id=et.param_id or edge_id,
            alpha=5.0,
            beta=5.0,
            mean=0.5,
            stdev=0.05,
            hdi_lower=0.4,
            hdi_upper=0.6,
            ess=500.0,
            rhat=1.01,
        ))
        if et.has_latency:
            latency_posteriors[edge_id] = LatencyPosteriorSummary(
                mu_mean=2.0,
                mu_sd=0.1,
                sigma_mean=0.5,
                sigma_sd=0.05,
                onset_delta_days=1.0,
                hdi_t95_lower=5.0,
                hdi_t95_upper=30.0,
            )
    return InferenceResult(
        posteriors=posteriors,
        latency_posteriors=latency_posteriors,
        quality=_make_fake_quality(),
    )


# ─────────────────────────────────────────────────────────────
# Test
# ─────────────────────────────────────────────────────────────

DUMP_DIR = "/tmp/bayes_debug-test-diamond-context"


class TestWorkerPhase2DebugDump:
    """E2E: _fit_graph_compiler with contexted snapshot evidence → Phase 2 dump."""

    @pytest.fixture(autouse=True)
    def cleanup_dump_dir(self):
        if os.path.isdir(DUMP_DIR):
            shutil.rmtree(DUMP_DIR)
        yield
        if os.path.isdir(DUMP_DIR):
            shutil.rmtree(DUMP_DIR)

    def test_phase2_dump_with_contexted_snapshot_evidence(self):
        """Full e2e with sliced evidence: the exact production code path.

        Mocks: run_inference, summarise_posteriors, _query_snapshot_subjects,
               psycopg2.connect.
        Real: topology analysis, bind_snapshot_evidence (with context rows →
              has_slices=True), model build (with p_slice_vec variables),
              Phase 1 posterior extraction (including per-slice vector indexing
              at worker.py:931-957), debug artefact dump, Phase 2 model build.
        """
        payload, snapshot_rows_by_edge = _load_diamond_context_payload()
        if payload is None:
            pytest.skip("diamond-context graph not available")

        call_count = [0]

        def mock_run_inference(model, config, report=None, phase_label=""):
            call_count[0] += 1
            trace = _make_fake_trace(model)
            return trace, _make_fake_quality()

        def mock_summarise(trace, topology, evidence, metadata, quality, **kwargs):
            return _make_fake_inference_result(topology, evidence)

        def mock_query_subjects(subjects, topology, log, **kwargs):
            return snapshot_rows_by_edge

        # Mock DB connectivity check (psycopg2.connect)
        mock_conn = mock.MagicMock()
        mock_cursor = mock.MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        from worker import _fit_graph_compiler
        with mock.patch("compiler.run_inference", side_effect=mock_run_inference), \
             mock.patch("compiler.summarise_posteriors", side_effect=mock_summarise), \
             mock.patch("worker._query_snapshot_subjects", side_effect=mock_query_subjects), \
             mock.patch("psycopg2.connect", return_value=mock_conn):
            result = _fit_graph_compiler(payload)

        # ── Assertions ──
        assert result is not None, "Worker returned None"
        log_text = "\n".join(result.get("log", []))

        # Worker completed without error
        assert result.get("error") is None, (
            f"Worker returned error: {result.get('error')}\n"
            f"Last 20 log lines:\n" +
            "\n".join(result.get("log", [])[-20:])
        )

        # Dump directory and all 4 files exist
        assert os.path.isdir(DUMP_DIR), (
            f"Dump directory not created.\n"
            f"Last 20 log lines:\n" +
            "\n".join(result.get("log", [])[-20:])
        )
        expected_files = [
            "phase2_frozen.json",
            "evidence.pkl",
            "topology.pkl",
            "settings.json",
        ]
        for fname in expected_files:
            fpath = os.path.join(DUMP_DIR, fname)
            assert os.path.isfile(fpath), (
                f"Missing dump file: {fname}. Dir contents: {os.listdir(DUMP_DIR)}"
            )

        # Dump files are loadable and non-empty
        with open(os.path.join(DUMP_DIR, "phase2_frozen.json")) as f:
            frozen = json.load(f)
        assert isinstance(frozen, dict)
        assert len(frozen) > 0

        with open(os.path.join(DUMP_DIR, "evidence.pkl"), "rb") as f:
            ev_loaded = pickle.load(f)
        assert hasattr(ev_loaded, "edges")

        with open(os.path.join(DUMP_DIR, "topology.pkl"), "rb") as f:
            topo_loaded = pickle.load(f)
        assert hasattr(topo_loaded, "topo_order")

        with open(os.path.join(DUMP_DIR, "settings.json")) as f:
            settings_loaded = json.load(f)
        assert "features" in settings_loaded
        assert "settings" in settings_loaded

        # run_inference called twice (Phase 1 + Phase 2)
        assert call_count[0] == 2, (
            f"Expected 2 run_inference calls, got {call_count[0]}"
        )

        # Frozen priors have plausible structure with per-slice entries
        has_any_slices = False
        total_slice_entries = 0
        for edge_id, edge_frozen in frozen.items():
            assert "p" in edge_frozen, f"Edge {edge_id} missing 'p'"
            assert 0 < edge_frozen["p"] < 1, f"Edge {edge_id} p={edge_frozen['p']} out of range"
            if "slices" in edge_frozen:
                has_any_slices = True
                for ctx_key, sf in edge_frozen["slices"].items():
                    total_slice_entries += 1
                    # Each slice should have at least one of p, mu, kappa
                    assert sf, f"Slice {ctx_key} on {edge_id[:12]} is empty"
                    # If p is present, it should be in range
                    if "p" in sf:
                        assert 0 < sf["p"] < 1, f"Slice {ctx_key} p={sf['p']} out of range"

        assert has_any_slices, (
            "No per-slice entries in phase2_frozen — the slice extraction loop "
            "(worker.py:919-957) was not exercised. Evidence may not have "
            f"has_slices=True. Frozen keys: {list(frozen.keys())}"
        )
        assert total_slice_entries >= 2, (
            f"Expected at least 2 slice entries (organic + paid), got {total_slice_entries}"
        )

        # Evidence was bound via snapshot path (not param file fallback)
        assert "snapshot DB" in log_text or "snapshot_subjects" in log_text.lower(), (
            "Log doesn't mention snapshot DB — evidence may have been bound via "
            "param files instead of snapshot rows"
        )

        # Log mentions the dump
        assert "Phase 2 debug artefacts" in log_text
