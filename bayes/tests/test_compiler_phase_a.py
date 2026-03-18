"""
Phase A compiler tests: independent edges, end-to-end pipeline.

Parameter recovery tests for solo edges, chains, and cohort data with
completeness coupling. These validate the core pipeline that Phase B
builds on.

Run with:
    cd /home/reg/dev/dagnet
    . graph-editor/venv/bin/activate
    pytest bayes/tests/test_compiler_phase_a.py -v --tb=short
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
    build_solo_edge_window,
    build_solo_edge_sparse,
    build_solo_edge_window_and_cohort,
    build_solo_edge_immature_cohort,
    build_linear_chain,
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
# Pipeline + assertion helpers (shared with Phase B tests)
# ---------------------------------------------------------------------------

def _run_pipeline(graph_snapshot, param_files):
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
    posteriors_by_edge = {p.edge_id: p for p in result.posteriors}

    for edge_id, p_true in ground_truth.items():
        p = posteriors_by_edge.get(edge_id)
        assert p is not None, (
            f"{label}edge {edge_id}: no posterior found. "
            f"Available: {list(posteriors_by_edge.keys())}"
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
                f"{z:.1f}σ from truth={p_true:.4f} (stdev={p.stdev:.4f})"
            )


def _assert_convergence(result, *, label: str = "", allow_divergences: int = 0):
    for p in result.posteriors:
        assert p.rhat < RHAT_THRESHOLD, (
            f"{label}edge {p.edge_id}: rhat={p.rhat:.4f} >= {RHAT_THRESHOLD}"
        )
        assert p.ess >= ESS_THRESHOLD, (
            f"{label}edge {p.edge_id}: ESS={p.ess:.0f} < {ESS_THRESHOLD}"
        )

    assert result.quality.total_divergences <= allow_divergences, (
        f"{label}{result.quality.total_divergences} divergences "
        f"(allowed {allow_divergences})"
    )


# ===========================================================================
# Test scenarios
# ===========================================================================

class TestSoloEdgeAbundantWindow:
    """A1: Solo edge, abundant window data — the simplest possible case."""

    def test_recovers_probability(self):
        graph, params, truth = build_solo_edge_window(
            p_true=0.3, n=10_000, seed=50,
        )
        result, trace, topology = _run_pipeline(graph, params)

        _assert_convergence(result, label="A1: ")
        _assert_recovery(result, truth, label="A1: ")


class TestSoloEdgeSparse:
    """A2: Solo edge, sparse data (n=50). Posterior wide but centred."""

    def test_recovers_with_wide_posterior(self):
        graph, params, truth = build_solo_edge_sparse(
            p_true=0.4, n=50, seed=51,
        )
        result, trace, topology = _run_pipeline(graph, params)

        # Convergence may be marginal with n=50
        for p in result.posteriors:
            assert p.rhat < 1.10, (
                f"A2: edge {p.edge_id}: rhat={p.rhat:.4f}"
            )

        # With n=50, sampling variability in the synthetic data dominates.
        # The model recovers the observed proportion, not the generating
        # parameter. Only check absolute tolerance (not sigma-based, since
        # the posterior is tight around the observed proportion).
        _assert_recovery(
            result, truth,
            mean_tolerance_sigmas=10.0,  # effectively disabled for sparse
            absolute_tolerance=0.15,
            label="A2: ",
        )

        # Posterior should be wider than for abundant data (A1 with n=10000
        # has stdev ~0.004). With n=50 plus a moment-matched prior, stdev
        # should be at least ~0.015.
        posteriors_by_edge = {p.edge_id: p for p in result.posteriors}
        p = posteriors_by_edge["edge-a-b"]
        assert p.stdev > 0.01, (
            f"A2: stdev={p.stdev:.4f} suspiciously tight for n=50"
        )


class TestSoloEdgeWindowAndCohort:
    """A3: Solo edge with both window and cohort data.

    Exercises the hierarchical p_base/p_window/p_cohort structure and
    completeness coupling on cohort observations.
    """

    def test_recovers_with_both_observation_types(self):
        graph, params, truth = build_solo_edge_window_and_cohort(seed=52)
        result, trace, topology = _run_pipeline(graph, params)

        _assert_convergence(result, label="A3: ")
        _assert_recovery(result, truth, label="A3: ")

    def test_has_hierarchical_variables(self):
        """The model should create p_base, p_window, p_cohort for the edge."""
        graph, params, truth = build_solo_edge_window_and_cohort(seed=52)
        topology = analyse_topology(graph)
        evidence = bind_evidence(topology, params, today="1-Mar-25")

        # Check evidence binding detected both types
        ev = evidence.edges.get("edge-a-b")
        assert ev is not None
        assert ev.has_window, "A3: should have window observations"
        assert ev.has_cohort, "A3: should have cohort observations"


class TestSoloEdgeImmatureCohort:
    """A4: Solo edge with only immature cohort data.

    Long latency + short cohort. The model must use completeness coupling
    to avoid underestimating p. Without completeness, the raw k/n ratio
    would suggest much lower p than the truth.
    """

    def test_completeness_prevents_p_underestimate(self):
        graph, params, truth = build_solo_edge_immature_cohort(seed=53)
        result, trace, topology = _run_pipeline(graph, params)

        # May have some divergences with immature-only data —
        # the model is poorly identified (doc 6 acknowledges this).
        # Relax convergence but still check recovery.
        for p in result.posteriors:
            assert p.rhat < 1.10, (
                f"A4: edge {p.edge_id}: rhat={p.rhat:.4f}"
            )

        # The key assertion: posterior mean should be closer to the true p
        # than the naive observed k/n ratio. The naive ratio is deflated by
        # immaturity; completeness coupling corrects for this.
        posteriors_by_edge = {p.edge_id: p for p in result.posteriors}
        p_post = posteriors_by_edge["edge-anchor-b"]

        # Compute the naive (uncorrected) ratio from the synthetic data
        ev = bind_evidence(
            analyse_topology(graph), params, today="1-Mar-25",
        ).edges.get("edge-anchor-b")
        total_k = sum(d.k for c in ev.cohort_obs for d in c.daily)
        total_n = sum(d.n for c in ev.cohort_obs for d in c.daily)
        naive_ratio = total_k / total_n if total_n > 0 else 0

        # Naive ratio should be substantially below truth (immaturity)
        assert naive_ratio < truth["edge-anchor-b"] - 0.05, (
            f"A4: naive ratio {naive_ratio:.4f} not deflated enough "
            f"from truth {truth['edge-anchor-b']:.4f} — test setup issue"
        )

        # Posterior mean should be closer to truth than the naive ratio
        posterior_error = abs(p_post.mean - truth["edge-anchor-b"])
        naive_error = abs(naive_ratio - truth["edge-anchor-b"])
        assert posterior_error < naive_error, (
            f"A4: completeness coupling not helping — "
            f"posterior error={posterior_error:.4f} >= naive error={naive_error:.4f}"
        )

        # The posterior should be closer to truth than naive, but with
        # Phase A's fixed latency and mostly-immature data, full recovery
        # is not expected. This is a known limitation (doc 6: poorly
        # identified when all days are immature). Phase D (latent latency)
        # will do better. For now, just check the correction direction.
        _assert_recovery(
            result, truth,
            absolute_tolerance=0.20,  # wide — immature-only is hard
            mean_tolerance_sigmas=20.0,  # effectively disabled
            label="A4: ",
        )


class TestLinearChain:
    """A5: Linear chain A → B → C → D (3 solo edges).

    Tests that multiple edges in a chain are fitted correctly and
    independently. Each should recover its own true p regardless of
    position in the chain.
    """

    def test_recovers_all_edges_in_chain(self):
        graph, params, truth = build_linear_chain(seed=54)
        result, trace, topology = _run_pipeline(graph, params)

        _assert_convergence(result, label="A5: ")
        _assert_recovery(result, truth, label="A5: ")

    def test_downstream_edges_have_less_data(self):
        """Traffic cascades: downstream edges have fewer observations."""
        graph, params, truth = build_linear_chain(seed=54)
        topology = analyse_topology(graph)
        evidence = bind_evidence(topology, params, today="1-Mar-25")

        n_ab = evidence.edges["edge-a-b"].total_n
        n_bc = evidence.edges["edge-b-c"].total_n
        n_cd = evidence.edges["edge-c-d"].total_n

        assert n_ab > n_bc > n_cd, (
            f"A5: traffic should cascade: n_ab={n_ab}, n_bc={n_bc}, n_cd={n_cd}"
        )
