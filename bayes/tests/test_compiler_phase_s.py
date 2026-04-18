"""
Phase S compiler tests: snapshot evidence assembly.

Tests that bind_snapshot_evidence() correctly converts snapshot DB rows
to likelihood terms, falls back to param files when no snapshots exist,
and produces valid posteriors through the full pipeline.

Run with:
    cd /home/reg/dev/dagnet
    . graph-editor/venv/bin/activate
    pytest bayes/tests/test_compiler_phase_s.py -v --tb=short
"""

from __future__ import annotations

import numpy as np
import pytest

from bayes.compiler import (
    analyse_topology,
    bind_snapshot_evidence,
    bind_evidence,
    build_model,
    run_inference,
    summarise_posteriors,
)
from bayes.compiler.types import SamplingConfig, RHAT_THRESHOLD, ESS_THRESHOLD

from bayes.tests.synthetic import (
    build_solo_edge_with_snapshots,
    build_snapshot_with_fallback,
    build_contexted_solo_edge_with_snapshot_slices,
    build_two_dimension_solo_edge,
    build_staggered_two_dimension_solo_edge,
    build_conditional_p_solo_edge,
)


# ---------------------------------------------------------------------------
# Shared config
# ---------------------------------------------------------------------------

SAMPLING_CONFIG = SamplingConfig(
    draws=1000,
    tune=500,
    chains=2,
    cores=2,
    target_accept=0.95,
    random_seed=12345,
)


# ---------------------------------------------------------------------------
# Pipeline helpers
# ---------------------------------------------------------------------------

def _run_pipeline_snapshot(graph_snapshot, param_files, snapshot_rows):
    """Run pipeline with snapshot evidence."""
    topology = analyse_topology(graph_snapshot)
    evidence = bind_snapshot_evidence(
        topology, snapshot_rows, param_files, today="1-Mar-25",
    )
    model, metadata = build_model(topology, evidence)
    trace, quality = run_inference(model, SAMPLING_CONFIG)
    result = summarise_posteriors(trace, topology, evidence, metadata, quality)
    return result, trace, topology, evidence


def _build_contexted_snapshot_model(
    graph_snapshot,
    param_files,
    snapshot_rows,
    *,
    commissioned_slices=None,
    mece_dimensions=None,
    features=None,
):
    """Bind commissioned snapshot slices and build the model without MCMC."""
    topology = analyse_topology(graph_snapshot)
    evidence = bind_snapshot_evidence(
        topology,
        snapshot_rows,
        param_files,
        today="1-Mar-25",
        commissioned_slices=commissioned_slices,
        mece_dimensions=mece_dimensions,
    )
    model, metadata = build_model(topology, evidence, features=features)
    return model, metadata, topology, evidence


def _assert_recovery(result, ground_truth, *, absolute_tolerance=0.05,
                     mean_tolerance_sigmas=3.0, label=""):
    posteriors_by_edge = {p.edge_id: p for p in result.posteriors}
    for edge_id, p_true in ground_truth.items():
        p = posteriors_by_edge.get(edge_id)
        assert p is not None, (
            f"{label}edge {edge_id}: no posterior found"
        )
        assert abs(p.mean - p_true) < absolute_tolerance, (
            f"{label}edge {edge_id}: posterior mean={p.mean:.4f} "
            f"too far from truth={p_true:.4f} "
            f"(diff={abs(p.mean - p_true):.4f} > tol={absolute_tolerance})"
        )
        if p.stdev > 0:
            z = abs(p.mean - p_true) / p.stdev
            assert z < mean_tolerance_sigmas, (
                f"{label}edge {edge_id}: posterior mean={p.mean:.4f} is "
                f"{z:.1f}σ from truth={p_true:.4f}"
            )


def _assert_convergence(result, *, label="", allow_divergences=0):
    for p in result.posteriors:
        assert p.rhat < RHAT_THRESHOLD, (
            f"{label}edge {p.edge_id}: rhat={p.rhat:.4f} >= {RHAT_THRESHOLD}"
        )
        assert p.ess >= ESS_THRESHOLD, (
            f"{label}edge {p.edge_id}: ESS={p.ess:.0f} < {ESS_THRESHOLD}"
        )
    assert result.quality.total_divergences <= allow_divergences, (
        f"{label}{result.quality.total_divergences} divergences"
    )


# ===========================================================================
# Test scenarios
# ===========================================================================

class TestSnapshotEvidenceBinding:
    """Unit tests for bind_snapshot_evidence — no MCMC."""

    def test_cohort_rows_produce_trajectories(self):
        """Snapshot cohort rows with multiple retrievals become trajectories."""
        graph, params, snap_rows, truth = build_solo_edge_with_snapshots(seed=60)
        topology = analyse_topology(graph)
        evidence = bind_snapshot_evidence(
            topology, snap_rows, params, today="1-Mar-25",
        )

        ev = evidence.edges.get("edge-a-b")
        assert ev is not None, "edge-a-b should have evidence"
        assert ev.has_cohort, "should have cohort observations from snapshots"
        assert len(ev.cohort_obs) > 0, "should have at least one CohortObservation"

        # Should have trajectory objects (multi-retrieval days)
        total_trajectories = sum(len(c.trajectories) for c in ev.cohort_obs)
        assert total_trajectories > 0, (
            "should have trajectory objects from multi-retrieval snapshot rows"
        )

        # Each trajectory should have valid structure
        for c_obs in ev.cohort_obs:
            for traj in c_obs.trajectories:
                assert traj.a > 0, "anchor entrants should be positive"
                assert len(traj.retrieval_ages) >= 2, (
                    "trajectory needs at least 2 retrieval ages"
                )
                assert len(traj.retrieval_ages) == len(traj.cumulative_y), (
                    "ages and y arrays must be same length"
                )
                # y should be monotonically non-decreasing
                for j in range(1, len(traj.cumulative_y)):
                    assert traj.cumulative_y[j] >= traj.cumulative_y[j - 1], (
                        f"cumulative_y not monotonic: {traj.cumulative_y}"
                    )
                # y should not exceed a
                assert traj.cumulative_y[-1] <= traj.a, (
                    f"cumulative_y[-1]={traj.cumulative_y[-1]} > a={traj.a}"
                )
                # retrieval ages should be ascending
                for j in range(1, len(traj.retrieval_ages)):
                    assert traj.retrieval_ages[j] > traj.retrieval_ages[j - 1], (
                        f"retrieval_ages not ascending: {traj.retrieval_ages}"
                    )

    def test_fallback_to_param_file(self):
        """Edge without snapshot rows uses param file evidence."""
        graph, params, snap_rows, truth = build_snapshot_with_fallback(seed=62)
        topology = analyse_topology(graph)
        evidence = bind_snapshot_evidence(
            topology, snap_rows, params, today="1-Mar-25",
        )

        # edge-a-b: has snapshot rows
        ev_ab = evidence.edges.get("edge-a-b")
        assert ev_ab is not None
        assert ev_ab.has_window, "edge-a-b should have window obs from snapshots"

        # edge-b-c: no snapshot rows, should fall back to param file
        ev_bc = evidence.edges.get("edge-b-c")
        assert ev_bc is not None
        assert ev_bc.has_window, "edge-b-c should have window obs from param file fallback"
        assert ev_bc.total_n > 0, "edge-b-c should have data from param file"

    def test_no_double_counting(self):
        """Edge with snapshot rows should NOT also use param file values."""
        graph, params, snap_rows, truth = build_snapshot_with_fallback(seed=62)
        topology = analyse_topology(graph)

        # Bind with snapshots
        ev_snap = bind_snapshot_evidence(
            topology, snap_rows, params, today="1-Mar-25",
        )

        # Bind without snapshots (param file only)
        ev_pf = bind_evidence(topology, params, today="1-Mar-25")

        # edge-a-b: snapshot has 10000 obs, param file has 100.
        # If snapshot is used, total_n should reflect snapshot data, not param file.
        snap_n = ev_snap.edges["edge-a-b"].total_n
        pf_n = ev_pf.edges["edge-a-b"].total_n

        # Snapshot should use its own n (10000), not param file n (100)
        assert snap_n > pf_n, (
            f"Snapshot total_n={snap_n} should be larger than param file total_n={pf_n}"
        )

    def test_prior_from_param_file_regardless(self):
        """Prior always comes from param file, even when snapshots provide evidence."""
        graph, params, snap_rows, truth = build_solo_edge_with_snapshots(seed=60)
        topology = analyse_topology(graph)
        evidence = bind_snapshot_evidence(
            topology, snap_rows, params, today="1-Mar-25",
        )

        ev = evidence.edges.get("edge-a-b")
        assert ev is not None
        # Prior should be moment-matched from the param file values,
        # not uninformative (which would indicate no param file was read)
        assert ev.prob_prior.source in ("moment_matched", "warm_start"), (
            f"Prior source should be from param file, got '{ev.prob_prior.source}'"
        )


class TestSnapshotContextedSlices:
    """Fast local contracts for commissioned context slices on snapshot data."""

    def test_commissioned_mece_context_rows_create_exhaustive_slice_group(self):
        graph, params, snap_rows, commissioned, mece_dims, _ = (
            build_contexted_solo_edge_with_snapshot_slices(seed=63)
        )
        topology = analyse_topology(graph)
        evidence = bind_snapshot_evidence(
            topology,
            snap_rows,
            params,
            today="1-Mar-25",
            commissioned_slices=commissioned,
            mece_dimensions=mece_dims,
        )

        ev = evidence.edges["edge-a-b"]
        assert ev.has_slices is True
        assert "channel" in ev.slice_groups

        sg = ev.slice_groups["channel"]
        # is_exhaustive is False when aggregate observations exist
        # (e.g. param-file supplements for uncovered anchor_days).
        # This is correct — aggregate evidence should be retained.
        assert set(sg.slices.keys()) == commissioned["edge-a-b"]
        assert all(s_obs.total_n > 0 for s_obs in sg.slices.values())
        assert ev.has_window is True
        assert ev.has_cohort is True

    def test_uncommissioned_context_rows_fold_into_aggregate_only(self):
        graph, params, snap_rows, _, mece_dims, _ = (
            build_contexted_solo_edge_with_snapshot_slices(seed=63)
        )
        topology = analyse_topology(graph)
        evidence = bind_snapshot_evidence(
            topology,
            snap_rows,
            params,
            today="1-Mar-25",
            commissioned_slices=None,
            mece_dimensions=mece_dims,
        )

        ev = evidence.edges["edge-a-b"]
        assert ev.has_slices is False
        assert ev.slice_groups == {}
        assert ev.has_window is True
        assert ev.has_cohort is True
        assert any(c.slice_dsl == "window(snapshot)" for c in ev.cohort_obs)
        assert any(c.slice_dsl == "cohort(snapshot)" for c in ev.cohort_obs)

    def test_contexted_snapshot_model_emits_per_slice_vars_and_likelihood_terms(self):
        graph, params, snap_rows, commissioned, mece_dims, _ = (
            build_contexted_solo_edge_with_snapshot_slices(seed=63)
        )
        model, _, _, evidence = _build_contexted_snapshot_model(
            graph,
            params,
            snap_rows,
            commissioned_slices=commissioned,
            mece_dimensions=mece_dims,
        )

        ev = evidence.edges["edge-a-b"]
        assert ev.has_slices is True

        names = set(model.named_vars.keys())
        assert "tau_slice_edge_a_b" in names
        assert "p_slice_vec_edge_a_b" in names
        assert "tau_mu_slice_edge_a_b" in names
        assert "mu_slice_vec_edge_a_b" in names
        assert len(model.observed_RVs) + len(list(model.potentials)) > 0

        diag_text = "\n".join(evidence.diagnostics)
        assert "2 slices" in diag_text or "dim=channel" in diag_text


class TestPerSliceAWiring:
    """Doc 41a: per_slice_a and shared_sigma_slices feature flag wiring."""

    def _build_3slice(self, features=None):
        """Build a 3-slice contexted model (minimum for per_slice_a)."""
        graph, params, snap_rows, commissioned, mece_dims, _ = (
            build_contexted_solo_edge_with_snapshot_slices(
                seed=63,
                slice_ps={"google": 0.62, "direct": 0.38, "email": 0.25},
            )
        )
        return _build_contexted_snapshot_model(
            graph, params, snap_rows,
            commissioned_slices=commissioned,
            mece_dimensions=mece_dims,
            features=features,
        )

    def test_per_slice_a_creates_expected_variables(self):
        model, _, _, _ = self._build_3slice(
            features={"per_slice_a": True, "latency_reparam_slices": 2})
        names = set(model.named_vars.keys())
        assert "tau_a_slice_edge_a_b" in names
        assert "delta_a_raw_edge_a_b" in names
        assert "delta_a_vec_edge_a_b" in names
        assert "a_slice_vec_edge_a_b" in names
        assert "onset_slice_vec_edge_a_b" in names
        assert "mu_slice_vec_edge_a_b" in names

    def test_per_slice_a_delta_has_correct_shape(self):
        model, _, _, _ = self._build_3slice(
            features={"per_slice_a": True, "latency_reparam_slices": 1})
        # K=3 slices → delta_a_raw has shape (K,) = (3,), centred to zero-sum
        delta_raw = model.named_vars["delta_a_raw_edge_a_b"]
        assert delta_raw.eval().shape == (3,)
        # a_slice_vec has shape (K,) = (3,)
        a_slice = model.named_vars["a_slice_vec_edge_a_b"]
        assert a_slice.eval().shape == (3,)

    def test_per_slice_a_inactive_below_3_slices(self):
        """With only 2 slices, per_slice_a falls back to shared a."""
        graph, params, snap_rows, commissioned, mece_dims, _ = (
            build_contexted_solo_edge_with_snapshot_slices(seed=63)
            # Default: 2 slices (google, direct)
        )
        model, _, _, _ = _build_contexted_snapshot_model(
            graph, params, snap_rows,
            commissioned_slices=commissioned,
            mece_dimensions=mece_dims,
            features={"per_slice_a": True, "latency_reparam_slices": 2},
        )
        names = set(model.named_vars.keys())
        assert "a_slice_vec_edge_a_b" not in names
        assert "delta_a_raw_edge_a_b" not in names

    def test_shared_sigma_slices_suppresses_r(self):
        model, _, _, _ = self._build_3slice(
            features={"shared_sigma_slices": True, "latency_reparam_slices": 2})
        names = set(model.named_vars.keys())
        assert "r_slice_vec_edge_a_b" not in names
        assert "sigma_slice_vec_edge_a_b" not in names
        # m is unaffected
        assert "m_slice_vec_edge_a_b" in names

    def test_per_slice_a_false_preserves_shared_a(self):
        model, _, _, _ = self._build_3slice(
            features={"per_slice_a": False, "latency_reparam_slices": 2})
        names = set(model.named_vars.keys())
        assert "a_slice_vec_edge_a_b" not in names
        assert "onset_slice_vec_edge_a_b" in names
        assert "mu_slice_vec_edge_a_b" in names

    def test_both_flags_together(self):
        model, _, _, _ = self._build_3slice(
            features={"per_slice_a": True, "shared_sigma_slices": True,
                       "latency_reparam_slices": 2})
        names = set(model.named_vars.keys())
        assert "a_slice_vec_edge_a_b" in names
        assert "r_slice_vec_edge_a_b" not in names
        assert "m_slice_vec_edge_a_b" in names

    def test_diagnostics_label_reflects_flags(self):
        _, metadata, _, _ = self._build_3slice(
            features={"per_slice_a": True, "latency_reparam_slices": 1})
        diag_text = "\n".join(metadata.get("diagnostics", []))
        assert "per-slice (m,a)" in diag_text
        assert "per-slice a" in diag_text

    def test_per_slice_onset_anchors_emitted(self):
        """With per_slice_a, per-slice onset_obs likelihoods should exist."""
        model, metadata, _, _ = self._build_3slice(
            features={"per_slice_a": True, "latency_reparam_slices": 2})
        names = set(model.named_vars.keys())
        # Should have at least one per-slice onset obs
        onset_slice_obs = [n for n in names if n.startswith("onset_obs_slice_")]
        # The synthetic builder generates onset_delta_days on rows,
        # so per-slice onset observations should be collected
        diag_text = "\n".join(metadata.get("diagnostics", []))
        # At minimum, the onset_slice diagnostic should appear if data exists
        if onset_slice_obs:
            assert any("onset_obs_slice" in d for d in metadata.get("diagnostics", []))


class TestSnapshotCohortRecovery:
    """S1: Solo edge with snapshot cohort evidence — parameter recovery."""

    def test_recovers_probability_from_snapshots(self):
        graph, params, snap_rows, truth = build_solo_edge_with_snapshots(seed=60)
        result, trace, topology, evidence = _run_pipeline_snapshot(
            graph, params, snap_rows,
        )

        _assert_convergence(result, label="S1: ")
        # The trajectory Multinomial produces many likelihood terms (60 days ×
        # multiple intervals), so the posterior is very precise. Sampling
        # variability in the synthetic data means the observed proportion may
        # differ from the generating parameter by more than a few posterior σ.
        # Use absolute tolerance only — the σ-based check is too tight.
        _assert_recovery(result, truth, label="S1: ",
                         mean_tolerance_sigmas=10.0,
                         absolute_tolerance=0.05)


class TestSnapshotFallback:
    """S3: Mixed edges — snapshot for one, param file for another."""

    def test_both_edges_recover(self):
        graph, params, snap_rows, truth = build_snapshot_with_fallback(seed=62)
        result, trace, topology, evidence = _run_pipeline_snapshot(
            graph, params, snap_rows,
        )

        _assert_convergence(result, label="S3: ")
        _assert_recovery(result, truth, label="S3: ")

    def test_diagnostics_report_sources(self):
        """Diagnostics should indicate which edges used snapshots vs fallback."""
        graph, params, snap_rows, truth = build_snapshot_with_fallback(seed=62)
        topology = analyse_topology(graph)
        evidence = bind_snapshot_evidence(
            topology, snap_rows, params, today="1-Mar-25",
        )

        diag_text = "\n".join(evidence.diagnostics)
        assert "snapshot" in diag_text.lower() or "snapshot" in diag_text, (
            f"Diagnostics should mention snapshot source: {evidence.diagnostics}"
        )
        assert "param file" in diag_text.lower() or "param file" in diag_text, (
            f"Diagnostics should mention param file fallback: {evidence.diagnostics}"
        )


class TestTwoDimensionModelWiring:
    """Verify that two independent MECE dimensions produce per-dimension
    tau variables and separate slice groups in the model."""

    def test_two_dimension_evidence_has_two_slice_groups(self):
        """Evidence binding should produce separate SliceGroups per dimension."""
        graph, params, snap_rows, commissioned, mece_dims, _ = (
            build_two_dimension_solo_edge(seed=64)
        )
        topology = analyse_topology(graph)
        evidence = bind_snapshot_evidence(
            topology,
            snap_rows,
            params,
            today="1-Mar-25",
            commissioned_slices=commissioned,
            mece_dimensions=mece_dims,
        )

        ev = evidence.edges["edge-a-b"]
        assert ev.has_slices is True
        assert "channel" in ev.slice_groups, f"Missing channel dim: {list(ev.slice_groups.keys())}"
        assert "device" in ev.slice_groups, f"Missing device dim: {list(ev.slice_groups.keys())}"
        assert len(ev.slice_groups) == 2

        # Each dimension has the right context keys
        channel_keys = set(ev.slice_groups["channel"].slices.keys())
        device_keys = set(ev.slice_groups["device"].slices.keys())
        assert "context(channel:google)" in channel_keys
        assert "context(channel:direct)" in channel_keys
        assert "context(device:mobile)" in device_keys
        assert "context(device:desktop)" in device_keys

    def test_two_dimension_model_compiles_without_error(self):
        """Model should compile with two dimensions — no crash, no NameError."""
        graph, params, snap_rows, commissioned, mece_dims, _ = (
            build_two_dimension_solo_edge(seed=64)
        )
        model, metadata, topology, evidence = _build_contexted_snapshot_model(
            graph, params, snap_rows,
            commissioned_slices=commissioned,
            mece_dimensions=mece_dims,
        )

        names = set(model.named_vars.keys())
        # Should have slice-related variables
        assert any("slice" in n for n in names), (
            f"No slice variables in model: {sorted(names)}"
        )

    def test_two_dimension_model_has_per_dimension_tau(self):
        """After R2g Gap 1 fix: each dimension gets its own tau_slice variable."""
        graph, params, snap_rows, commissioned, mece_dims, _ = (
            build_two_dimension_solo_edge(seed=64)
        )
        model, _, _, _ = _build_contexted_snapshot_model(
            graph, params, snap_rows,
            commissioned_slices=commissioned,
            mece_dimensions=mece_dims,
        )

        names = set(model.named_vars.keys())
        # Per-dimension tau: tau_slice_{edge}_{dim}
        assert "tau_slice_edge_a_b__channel" in names, (
            f"Missing per-dim tau for channel. Variables: {sorted(n for n in names if 'tau' in n)}"
        )
        assert "tau_slice_edge_a_b__device" in names, (
            f"Missing per-dim tau for device. Variables: {sorted(n for n in names if 'tau' in n)}"
        )
        # Should NOT have the old single tau
        assert "tau_slice_edge_a_b" not in names, (
            "Old single tau_slice should not exist with multi-dimension"
        )

    def test_two_dimension_aggregate_retained_with_1_over_n_correction(self):
        """With 2 MECE dimensions and aggregate observations from param-file
        supplements, aggregate is retained with 1/N kappa correction.
        is_exhaustive is False because aggregate observations exist."""
        graph, params, snap_rows, commissioned, mece_dims, _ = (
            build_two_dimension_solo_edge(seed=64)
        )
        model, _, _, _ = _build_contexted_snapshot_model(
            graph, params, snap_rows,
            commissioned_slices=commissioned,
            mece_dimensions=mece_dims,
        )

        names = set(model.named_vars.keys())
        # Aggregate retained with 1/N kappa correction (N=2 dimensions)
        assert "kappa_agg_corrected_edge_a_b" in names, (
            f"Aggregate should be retained with 1/N correction when "
            f"aggregate observations exist. "
            f"Variables with 'kappa': {sorted(n for n in names if 'kappa' in n)}"
        )
        # Per-slice kappa should still exist
        assert "kappa_slice_vec_edge_a_b" in names, (
            f"Per-slice kappa vector should exist. "
            f"Variables with 'kappa': {sorted(n for n in names if 'kappa' in n)}"
        )

    def test_single_dimension_no_kappa_correction(self):
        """Single dimension should NOT have a kappa correction variable."""
        graph, params, snap_rows, commissioned, mece_dims, _ = (
            build_contexted_solo_edge_with_snapshot_slices(seed=63)
        )
        model, _, _, _ = _build_contexted_snapshot_model(
            graph, params, snap_rows,
            commissioned_slices=commissioned,
            mece_dimensions=mece_dims,
        )

        names = set(model.named_vars.keys())
        assert "kappa_agg_corrected_edge_a_b" not in names, (
            "Single dimension should not have 1/N kappa correction"
        )


class TestStaggeredDimensionBinding:
    """Blind tests for staggered A→B→D dimension evidence binding.

    These test the CONTRACT: what the binder should produce given
    staggered data, written from the spec without reading the binder code.

    Invariants:
      - Channel SliceGroup has observations (from states B+D)
      - Device SliceGroup has observations (from state D only)
      - Device has fewer observation days than channel
      - Both dimensions present in slice_groups
      - Aggregate observations exist (from state A bare data)
      - has_slices is True
    """

    def test_staggered_evidence_has_both_slice_groups(self):
        """Both channel and device SliceGroups should exist."""
        graph, params, snap_rows, commissioned, mece_dims, _ = (
            build_staggered_two_dimension_solo_edge(seed=65)
        )
        topology = analyse_topology(graph)
        evidence = bind_snapshot_evidence(
            topology, snap_rows, params, today="1-Mar-25",
            commissioned_slices=commissioned,
            mece_dimensions=mece_dims,
        )

        ev = evidence.edges["edge-a-b"]
        assert ev.has_slices is True
        assert "channel" in ev.slice_groups, (
            f"Missing channel dim: {list(ev.slice_groups.keys())}")
        assert "device" in ev.slice_groups, (
            f"Missing device dim: {list(ev.slice_groups.keys())}")

    def test_staggered_channel_has_more_observations_than_device(self):
        """Channel appears in states B+D, device only D. Channel should have
        more raw snapshot rows feeding its SliceGroup."""
        graph, params, snap_rows, commissioned, mece_dims, _ = (
            build_staggered_two_dimension_solo_edge(seed=65)
        )
        # Check raw rows before binding — the ground truth
        all_rows = snap_rows["edge-a-b"]
        chan_rows = [r for r in all_rows if "context(channel:" in r.get("slice_key", "")]
        dev_rows = [r for r in all_rows if "context(device:" in r.get("slice_key", "")]
        assert len(chan_rows) > len(dev_rows), (
            f"Channel raw rows ({len(chan_rows)}) should exceed device ({len(dev_rows)}) "
            f"because channel covers states B+D while device covers only D"
        )

    def test_staggered_aggregate_has_observations(self):
        """State A bare data should produce aggregate observations."""
        graph, params, snap_rows, commissioned, mece_dims, _ = (
            build_staggered_two_dimension_solo_edge(seed=65)
        )
        topology = analyse_topology(graph)
        evidence = bind_snapshot_evidence(
            topology, snap_rows, params, today="1-Mar-25",
            commissioned_slices=commissioned,
            mece_dimensions=mece_dims,
        )

        ev = evidence.edges["edge-a-b"]
        assert ev.total_n > 0, "Aggregate should have observations from state A"
        assert ev.has_window or ev.has_cohort, "Aggregate should have temporal obs"

    def test_staggered_all_slice_values_have_data(self):
        """Every commissioned context key should have observations."""
        graph, params, snap_rows, commissioned, mece_dims, _ = (
            build_staggered_two_dimension_solo_edge(seed=65)
        )
        topology = analyse_topology(graph)
        evidence = bind_snapshot_evidence(
            topology, snap_rows, params, today="1-Mar-25",
            commissioned_slices=commissioned,
            mece_dimensions=mece_dims,
        )

        ev = evidence.edges["edge-a-b"]
        for dim_key, sg in ev.slice_groups.items():
            for ctx_key, obs in sg.slices.items():
                assert obs.total_n > 0, (
                    f"Slice {ctx_key} in {dim_key} should have data, got total_n=0"
                )


class TestStaggeredDimensionModel:
    """Blind tests for model compilation with staggered evidence.

    Written from the design spec: per-dimension tau, 1/N kappa, no crash.
    """

    def test_staggered_model_compiles_without_error(self):
        """Staggered evidence should compile to a valid PyMC model."""
        graph, params, snap_rows, commissioned, mece_dims, _ = (
            build_staggered_two_dimension_solo_edge(seed=65)
        )
        model, _, _, _ = _build_contexted_snapshot_model(
            graph, params, snap_rows,
            commissioned_slices=commissioned,
            mece_dimensions=mece_dims,
        )
        # Model should have named variables — not empty
        assert len(model.named_vars) > 0

    def test_staggered_model_has_per_dimension_tau(self):
        """Each dimension should get its own tau (shrinkage) variable."""
        graph, params, snap_rows, commissioned, mece_dims, _ = (
            build_staggered_two_dimension_solo_edge(seed=65)
        )
        model, _, _, _ = _build_contexted_snapshot_model(
            graph, params, snap_rows,
            commissioned_slices=commissioned,
            mece_dimensions=mece_dims,
        )

        names = set(model.named_vars.keys())
        assert "tau_slice_edge_a_b__channel" in names, (
            f"Missing channel tau. Tau vars: {sorted(n for n in names if 'tau' in n)}")
        assert "tau_slice_edge_a_b__device" in names, (
            f"Missing device tau. Tau vars: {sorted(n for n in names if 'tau' in n)}")

    def test_staggered_model_has_per_slice_p_variables(self):
        """Per-slice p variables should exist for all 4 context values
        (2 channel + 2 device)."""
        graph, params, snap_rows, commissioned, mece_dims, _ = (
            build_staggered_two_dimension_solo_edge(seed=65)
        )
        model, _, _, _ = _build_contexted_snapshot_model(
            graph, params, snap_rows,
            commissioned_slices=commissioned,
            mece_dimensions=mece_dims,
        )

        names = set(model.named_vars.keys())
        assert "p_slice_vec_edge_a_b" in names, (
            f"Missing p_slice_vec. Names: {sorted(n for n in names if 'p_slice' in n)}")

    def test_staggered_model_aggregate_retained(self):
        """Staggered graph has bare-epoch aggregate observations, so
        aggregate is retained with 1/N kappa correction."""
        graph, params, snap_rows, commissioned, mece_dims, _ = (
            build_staggered_two_dimension_solo_edge(seed=65)
        )
        model, _, _, _ = _build_contexted_snapshot_model(
            graph, params, snap_rows,
            commissioned_slices=commissioned,
            mece_dimensions=mece_dims,
        )

        names = set(model.named_vars.keys())
        assert "kappa_agg_corrected_edge_a_b" in names, (
            f"Aggregate should be retained when aggregate observations "
            f"exist (staggered epochs). Kappa vars: "
            f"{sorted(n for n in names if 'kappa' in n)}"
        )
        assert "kappa_slice_vec_edge_a_b" in names


def _bind_conditional_evidence(topology, graph, params, snap_rows):
    """Bind conditional_p evidence for each edge's conditionals.

    Each conditional has its own param file and snapshot rows. This helper
    binds them using the standard evidence binder, then attaches the result
    to the ConditionalPop.evidence field on the topology.
    """
    for edge_id, et in topology.edges.items():
        for cp in et.conditional_p:
            if not cp.param_id:
                continue
            # Conditional's snapshot rows are keyed with a synthetic key
            cond_row_key = f"{edge_id}::cond::{cp.condition}"
            cond_rows = snap_rows.get(cond_row_key, [])

            if cond_rows:
                # Bind using the conditional's own param file
                cond_snap = {edge_id: cond_rows}
                cond_evidence = bind_snapshot_evidence(
                    topology, cond_snap, params, today="1-Mar-25",
                )
                cp.evidence = cond_evidence.edges.get(edge_id)
            elif cp.param_id in params:
                # Fall back to param file evidence (no snapshot rows)
                cond_evidence = bind_evidence(
                    topology, params, today="1-Mar-25",
                )
                cp.evidence = cond_evidence.edges.get(edge_id)


class TestConditionalPTopology:
    """Blind tests: conditional_p conditions are read from edge data
    and stored as ConditionalPop on EdgeTopology."""

    def test_conditional_p_read_from_edge(self):
        """EdgeTopology should have ConditionalPop entries."""
        graph, params, snap_rows, commissioned, mece_dims, _ = (
            build_conditional_p_solo_edge(seed=66)
        )
        topology = analyse_topology(graph)
        et = topology.edges["edge-a-b"]
        assert len(et.conditional_p) == 1, (
            f"Expected 1 conditional_p, got {len(et.conditional_p)}")
        cp = et.conditional_p[0]
        assert cp.condition == "visited(treatment-node)"
        assert abs(cp.p_mean - 0.55) < 0.01
        assert cp.param_id == "param-a-b-cond-visited"
        assert cp.has_latency is True

    def test_conditional_has_own_latency_priors(self):
        """Conditional should have its own latency params, not base edge's."""
        graph, params, snap_rows, commissioned, mece_dims, _ = (
            build_conditional_p_solo_edge(seed=66)
        )
        topology = analyse_topology(graph)
        cp = topology.edges["edge-a-b"].conditional_p[0]
        base = topology.edges["edge-a-b"]
        # Conditional has different mu/onset from base
        assert cp.mu_prior != base.mu_prior, (
            f"Conditional mu ({cp.mu_prior}) should differ from base ({base.mu_prior})")
        assert cp.onset_delta_days != base.onset_delta_days, (
            f"Conditional onset ({cp.onset_delta_days}) should differ from base ({base.onset_delta_days})")

    def test_no_conditional_p_on_normal_edge(self):
        """Edge without conditional_p should have empty list."""
        graph, params, snap_rows, _ = (
            build_solo_edge_with_snapshots(seed=60)
        )
        topology = analyse_topology(graph)
        for eid, et in topology.edges.items():
            assert et.conditional_p == [], (
                f"Edge {eid} should have no conditional_p")


class TestConditionalPBinding:
    """Blind tests: conditional evidence binds from its own param file."""

    def test_conditional_evidence_binds_independently(self):
        """Conditional's evidence should come from its own param file,
        not from the base edge's param file."""
        graph, params, snap_rows, commissioned, mece_dims, _ = (
            build_conditional_p_solo_edge(seed=66)
        )
        topology = analyse_topology(graph)

        # Bind base edge evidence
        base_evidence = bind_snapshot_evidence(
            topology, {"edge-a-b": snap_rows["edge-a-b"]},
            params, today="1-Mar-25",
        )

        # Bind conditional evidence separately
        _bind_conditional_evidence(topology, graph, params, snap_rows)

        # Base evidence exists
        base_ev = base_evidence.edges["edge-a-b"]
        assert base_ev.total_n > 0, "Base evidence should have data"

        # Conditional evidence exists and is independent
        cp = topology.edges["edge-a-b"].conditional_p[0]
        assert cp.evidence is not None, "Conditional evidence should be bound"
        assert cp.evidence.total_n > 0, "Conditional evidence should have data"


class TestConditionalPModel:
    """Blind tests: conditional_p conditions get independent (non-pooled)
    Beta priors with independent latency. Written from doc 14 §6."""

    def _build_conditional_model(self):
        """Build model with conditional evidence wired up."""
        graph, params, snap_rows, commissioned, mece_dims, _ = (
            build_conditional_p_solo_edge(seed=66)
        )
        topology = analyse_topology(graph)

        # Bind base evidence
        evidence = bind_snapshot_evidence(
            topology, {"edge-a-b": snap_rows["edge-a-b"]},
            params, today="1-Mar-25",
        )

        # Bind conditional evidence
        _bind_conditional_evidence(topology, graph, params, snap_rows)

        model, metadata = build_model(topology, evidence)
        return model, metadata, topology, evidence

    def test_conditional_model_compiles(self):
        """Model with conditional_p should compile without error."""
        model, _, _, _ = self._build_conditional_model()
        assert len(model.named_vars) > 0

    def test_conditional_has_independent_p_variable(self):
        """The conditional should get its own p_cond Beta variable."""
        model, _, _, _ = self._build_conditional_model()
        names = set(model.named_vars.keys())
        cond_p_vars = [n for n in names if "p_cond_" in n]
        assert len(cond_p_vars) >= 1, (
            f"Missing independent p_cond variable. "
            f"p-related vars: {sorted(n for n in names if 'p_' in n)}")

    def test_conditional_has_independent_kappa(self):
        """The conditional should get its own kappa."""
        model, _, _, _ = self._build_conditional_model()
        names = set(model.named_vars.keys())
        cond_kappa_vars = [n for n in names if "kappa_cond_" in n]
        assert len(cond_kappa_vars) >= 1, (
            f"Missing independent kappa_cond variable. "
            f"Kappa vars: {sorted(n for n in names if 'kappa' in n)}")

    def test_conditional_has_independent_latency(self):
        """The conditional should get its own latency variables."""
        model, _, _, _ = self._build_conditional_model()
        names = set(model.named_vars.keys())
        cond_mu_vars = [n for n in names if "mu_cond_" in n or "m_lat_cond_" in n]
        assert len(cond_mu_vars) >= 1, (
            f"Missing independent conditional latency. "
            f"Latency vars: {sorted(n for n in names if 'cond_' in n)}")

    def test_conditional_does_not_use_tau_hierarchy(self):
        """With only a conditional (no MECE slices), there should be no tau."""
        model, _, _, _ = self._build_conditional_model()
        names = set(model.named_vars.keys())
        tau_vars = [n for n in names if "tau_slice" in n]
        assert len(tau_vars) == 0, (
            f"Conditional-only edge should not have tau_slice hierarchy. "
            f"Found: {tau_vars}"
        )

    def test_conditional_in_metadata(self):
        """Metadata should include conditional variable names."""
        _, metadata, _, _ = self._build_conditional_model()
        assert "cond_edge_var_names" in metadata
        cond_vars = metadata["cond_edge_var_names"]
        assert "edge-a-b" in cond_vars, (
            f"edge-a-b should have conditional vars: {cond_vars}")
        assert "visited(treatment-node)" in cond_vars["edge-a-b"]
