"""
Phase B compiler tests: Dirichlet branch groups.

Parameter recovery tests — run full pipeline (topology → evidence → model →
inference) on synthetic data with known ground truth, verify posteriors
recover the true simplex.

These tests run real MCMC (shorter chains than production). Each takes
~10–30s depending on model size. Run with:

    cd /home/reg/dev/dagnet
    . graph-editor/venv/bin/activate
    pytest bayes/tests/test_compiler_phase_b.py -v --tb=short

Sampling config: draws=1000, tune=500, chains=2 (enough for recovery on
clean synthetic data; marginal convergence = model bug, not test config).
"""

from __future__ import annotations

import numpy as np
import pytest

from bayes.compiler import (
    analyse_topology,
    bind_evidence,
    build_model,
    run_inference,
    summarise_posteriors,
)
from bayes.compiler.types import SamplingConfig, RHAT_THRESHOLD, ESS_THRESHOLD

from bayes.tests.synthetic import (
    build_branch_group_3way,
    build_branch_group_2way,
    build_mixed_solo_and_branch,
)


# ---------------------------------------------------------------------------
# Shared config — short chains for CI, fixed seed for determinism
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
# Recovery assertion helpers
# ---------------------------------------------------------------------------

def _run_pipeline(graph_snapshot, param_files):
    """Run the full compiler pipeline. Returns InferenceResult + trace."""
    topology = analyse_topology(graph_snapshot)
    evidence = bind_evidence(topology, param_files, today="1-Mar-25")
    model, metadata = build_model(topology, evidence)
    trace, quality = run_inference(model, SAMPLING_CONFIG)
    result = summarise_posteriors(trace, topology, evidence, metadata, quality)
    return result, trace, topology


def _assert_recovery(
    result,
    ground_truth: dict[str, float],
    *,
    mean_tolerance_sigmas: float = 3.0,
    absolute_tolerance: float = 0.05,
    label: str = "",
):
    """Assert posterior recovery of ground truth values.

    For each edge in ground_truth, checks:
      1. Posterior mean within mean_tolerance_sigmas × stdev of truth
      2. Posterior mean within absolute_tolerance of truth (catches cases
         where stdev is tiny but there's a real bias)

    Note: we do NOT assert HDI containment per-run. With large n the
    posterior is so tight that sampling variability in the synthetic data
    can push the true parameter outside the 90% HDI — that's correct
    model behaviour (the model recovered the data, not the generating
    parameter). HDI coverage is a statistical property verified over
    many runs, not a single-run assertion.
    """
    posteriors_by_edge = {p.edge_id: p for p in result.posteriors}

    for edge_id, p_true in ground_truth.items():
        p = posteriors_by_edge.get(edge_id)
        assert p is not None, (
            f"{label}edge {edge_id}: no posterior found. "
            f"Available: {list(posteriors_by_edge.keys())}"
        )

        # Absolute closeness
        assert abs(p.mean - p_true) < absolute_tolerance, (
            f"{label}edge {edge_id}: posterior mean={p.mean:.4f} "
            f"too far from truth={p_true:.4f} "
            f"(diff={abs(p.mean - p_true):.4f} > tol={absolute_tolerance})"
        )

        # Relative closeness (in posterior-σ units)
        if p.stdev > 0:
            z = abs(p.mean - p_true) / p.stdev
            assert z < mean_tolerance_sigmas, (
                f"{label}edge {edge_id}: posterior mean={p.mean:.4f} is "
                f"{z:.1f}σ from truth={p_true:.4f} (stdev={p.stdev:.4f})"
            )


def _assert_convergence(result, *, label: str = ""):
    """Assert MCMC convergence on clean synthetic data."""
    for p in result.posteriors:
        assert p.rhat < RHAT_THRESHOLD, (
            f"{label}edge {p.edge_id}: rhat={p.rhat:.4f} >= {RHAT_THRESHOLD}"
        )
        assert p.ess >= ESS_THRESHOLD, (
            f"{label}edge {p.edge_id}: ESS={p.ess:.0f} < {ESS_THRESHOLD}"
        )

    assert result.quality.total_divergences == 0, (
        f"{label}{result.quality.total_divergences} divergences on clean synthetic data"
    )


def _assert_simplex(
    trace,
    topology,
    *,
    exhaustive: bool = False,
    label: str = "",
):
    """Assert simplex constraint holds in all posterior samples.

    For each branch group, sum the sibling p variables across all samples.
    Non-exhaustive: Σp_i < 1 for all samples.
    Exhaustive: Σp_i ≈ 1 for all samples (within numerical tolerance).
    """
    from bayes.compiler.model import _safe_var_name

    for group_id, bg in topology.branch_groups.items():
        sibling_samples = []
        for sib_id in bg.sibling_edge_ids:
            safe_id = _safe_var_name(sib_id)
            # Try p_window, p_base, p in that order
            for prefix in ("p_window_", "p_base_", "p_"):
                var_name = f"{prefix}{safe_id}"
                if var_name in trace.posterior:
                    samples = trace.posterior[var_name].values.flatten()
                    sibling_samples.append(samples)
                    break

        if len(sibling_samples) < 2:
            continue

        sum_p = np.sum(sibling_samples, axis=0)

        if exhaustive:
            # Structural guarantee: sum should be very close to 1
            assert np.all(sum_p > 0.95), (
                f"{label}branch group {group_id}: min Σp_i = {sum_p.min():.4f} "
                f"(expected ≈ 1.0 for exhaustive)"
            )
            assert np.all(sum_p < 1.05), (
                f"{label}branch group {group_id}: max Σp_i = {sum_p.max():.4f} "
                f"(expected ≈ 1.0 for exhaustive)"
            )
        else:
            # Non-exhaustive: sum must be < 1 (dropout absorbs residual)
            assert np.all(sum_p < 1.0), (
                f"{label}branch group {group_id}: max Σp_i = {sum_p.max():.4f} >= 1.0 "
                f"(simplex violated — dropout not absorbing)"
            )


def _assert_dropout_recovery(
    trace,
    topology,
    ground_truth: dict[str, float],
    *,
    tolerance: float = 0.05,
    label: str = "",
):
    """Assert dropout component recovers the true residual.

    The dropout is implicit: 1 - Σ(sibling posterior means).
    Check it's close to the true 1 - Σ(p_true_i).
    """
    from bayes.compiler.model import _safe_var_name

    for group_id, bg in topology.branch_groups.items():
        true_sum = 0.0
        posterior_means = []

        for sib_id in bg.sibling_edge_ids:
            if sib_id not in ground_truth:
                continue
            true_sum += ground_truth[sib_id]

            safe_id = _safe_var_name(sib_id)
            for prefix in ("p_window_", "p_base_", "p_"):
                var_name = f"{prefix}{safe_id}"
                if var_name in trace.posterior:
                    samples = trace.posterior[var_name].values.flatten()
                    posterior_means.append(float(np.mean(samples)))
                    break

        if not posterior_means:
            continue

        true_dropout = 1.0 - true_sum
        posterior_dropout = 1.0 - sum(posterior_means)

        assert abs(posterior_dropout - true_dropout) < tolerance, (
            f"{label}branch group {group_id}: "
            f"dropout posterior={posterior_dropout:.4f} vs true={true_dropout:.4f} "
            f"(diff={abs(posterior_dropout - true_dropout):.4f} > tol={tolerance})"
        )


# ===========================================================================
# Test scenarios
# ===========================================================================

class TestBranchGroupSymmetric:
    """B1: Symmetric 3-way branch group, non-exhaustive."""

    def test_recovers_symmetric_simplex(self):
        graph, params, truth = build_branch_group_3way(
            p_true=[0.25, 0.25, 0.25],
            n_a=10_000,
            seed=42,
        )
        result, trace, topology = _run_pipeline(graph, params)

        _assert_convergence(result, label="B1: ")
        _assert_recovery(result, truth, label="B1: ")
        _assert_simplex(trace, topology, label="B1: ")
        _assert_dropout_recovery(trace, topology, truth, label="B1: ")


class TestBranchGroupAsymmetric:
    """B2: Asymmetric 3-way branch group — one dominant sibling."""

    def test_recovers_asymmetric_simplex(self):
        graph, params, truth = build_branch_group_3way(
            p_true=[0.6, 0.1, 0.1],
            n_a=5_000,
            seed=43,
        )
        result, trace, topology = _run_pipeline(graph, params)

        _assert_convergence(result, label="B2: ")
        _assert_recovery(result, truth, label="B2: ")
        _assert_simplex(trace, topology, label="B2: ")
        _assert_dropout_recovery(trace, topology, truth, label="B2: ")


class TestBranchGroupNearExhaustive:
    """B3: Near-exhaustive — small dropout (0.05)."""

    def test_recovers_small_dropout(self):
        graph, params, truth = build_branch_group_3way(
            p_true=[0.5, 0.3, 0.15],
            n_a=10_000,
            seed=44,
        )
        result, trace, topology = _run_pipeline(graph, params)

        _assert_convergence(result, label="B3: ")
        _assert_recovery(result, truth, label="B3: ")
        _assert_simplex(trace, topology, label="B3: ")
        _assert_dropout_recovery(
            trace, topology, truth,
            tolerance=0.03,  # tighter for small dropout
            label="B3: ",
        )


class TestBranchGroupExhaustive:
    """B4: Exhaustive branch group — all targets have events, no dropout."""

    def test_recovers_exhaustive_simplex(self):
        graph, params, truth = build_branch_group_3way(
            p_true=[0.5, 0.3, 0.2],
            n_a=8_000,
            all_targets_have_events=True,
            seed=45,
        )
        result, trace, topology = _run_pipeline(graph, params)

        _assert_convergence(result, label="B4: ")
        _assert_recovery(result, truth, label="B4: ")
        _assert_simplex(trace, topology, exhaustive=True, label="B4: ")


class TestBranchGroupLargeDropout:
    """B5: Large dropout (0.75) — most traffic drops out."""

    def test_recovers_with_large_dropout(self):
        graph, params, truth = build_branch_group_2way(
            p_true=[0.15, 0.10],
            n_a=20_000,
            seed=46,
        )
        result, trace, topology = _run_pipeline(graph, params)

        _assert_convergence(result, label="B5: ")
        _assert_recovery(result, truth, label="B5: ")
        _assert_simplex(trace, topology, label="B5: ")
        _assert_dropout_recovery(trace, topology, truth, label="B5: ")


class TestSoloEdgeRegression:
    """B6: Solo edges must be unaffected by Dirichlet on branch groups."""

    def test_solo_edges_unaffected(self):
        graph, params, truth = build_mixed_solo_and_branch(seed=47)
        result, trace, topology = _run_pipeline(graph, params)

        _assert_convergence(result, label="B6: ")

        # The graph has two branch groups:
        #   bg_node-anchor: {edge-anchor-a, edge-anchor-x}
        #   bg_node-a: {edge-a-b, edge-a-c}
        # And one solo edge: edge-x-y
        #
        # The solo edge must recover independently.
        solo_truth = {"edge-x-y": truth["edge-x-y"]}
        _assert_recovery(result, solo_truth, label="B6-solo: ")

        # Both branch groups should also recover
        branch_truth = {
            eid: p for eid, p in truth.items()
            if eid != "edge-x-y"
        }
        _assert_recovery(result, branch_truth, label="B6-branch: ")

        # Simplex must hold for both branch groups
        _assert_simplex(trace, topology, label="B6: ")


class TestBranchGroupSparse:
    """B7: Sparse data (n=50) — posteriors wide but centred on truth."""

    def test_sparse_data_recovers(self):
        graph, params, truth = build_branch_group_3way(
            p_true=[0.3, 0.2, 0.1],
            n_a=50,
            seed=48,
        )
        result, trace, topology = _run_pipeline(graph, params)

        # Convergence may be marginal with n=50 — relax ESS but not rhat
        for p in result.posteriors:
            assert p.rhat < 1.10, (
                f"B7: edge {p.edge_id}: rhat={p.rhat:.4f} (too high even for sparse)"
            )

        # Recovery with wider tolerance (sparse data = wide posteriors)
        _assert_recovery(
            result, truth,
            mean_tolerance_sigmas=2.5,
            label="B7: ",
        )

        _assert_simplex(trace, topology, label="B7: ")
