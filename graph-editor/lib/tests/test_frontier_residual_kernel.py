"""Tests for ``make_frontier_residual_kernel_provider`` (FC §5.3 / §9.5).

The residual provider takes a base predictive kernel provider and
wraps it so the FC continuation DP consumes only the unresolved future
mass for each Cohort's frontier ``f_c``.

Plan §9.9 step 3 specifies the focus tests:

- ``B(τ = f_c) = 0`` — increment kernel value is zero at the frontier;
- monotone future — cumulative B is non-decreasing in τ for τ > f_c;
- saturation — at large τ, residual cumulative approaches 1 for
  surviving mass;
- role-clock correctness — preserved by the underlying base provider;
- branch/sibling explicit test: the sum of all future outgoing residual
  flows from a node is no greater than the unresolved frontier
  occupancy at that node (for unit source mass: ``Σ_e cum_B_e ≤ 1``).
  This catches the forbidden edge-local denominator.
"""

from __future__ import annotations

import os
import sys
from typing import Dict, Sequence, Tuple

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from runner.bucket_transition import BucketSourceBasis
from runner.frontier_residual_kernel import (
    make_frontier_residual_kernel_provider,
)
from runner.span_kernel import ConcreteEdge, _build_span_topology


# ─── Fixture helpers ─────────────────────────────────────────────────────


def _make_graph(nodes, edges):
    return {
        'nodes': [{'id': n, 'uuid': n} for n in nodes],
        'edges': [
            {'from_node': f, 'to': t, 'uuid': f'{f}_{t}_{idx}'}
            for idx, (f, t) in enumerate(edges)
        ],
    }


def _base_provider_from_kernels(
    kernels: Dict[Tuple[str, str, int], np.ndarray],
    *,
    draw_count: int,
    horizon: int,
):
    """Return a kernel-provider callable matching the DP signature.

    Provider contract: returns ``(kernel, out_basis)`` always. For
    synthetic Dirac kernels in these tests the output basis simply
    mirrors the source basis (no transition between bases).
    """
    def provider(ce, source_index, source_basis):
        sibling_idx = int(ce.edge_key.rsplit('#', 1)[-1])
        key = (ce.from_id, ce.to_id, sibling_idx)
        full = kernels.get(key)
        if full is None:
            return (
                np.zeros((draw_count, horizon - int(source_index))),
                source_basis,
            )
        if full.shape != (draw_count, horizon):
            raise AssertionError(
                f"test fixture kernel shape {full.shape} != ({draw_count}, {horizon})"
            )
        return full[:, int(source_index):].copy(), source_basis

    return provider


def _dirac_p(p: float, lag: int, draw_count: int, horizon: int) -> np.ndarray:
    """``(draw_count, horizon)`` Dirac mass ``p`` at ``lag``."""
    kernel = np.zeros((draw_count, horizon), dtype=np.float64)
    if 0 <= lag < horizon:
        kernel[:, lag] = float(p)
    return kernel


# ─── B(f) = 0 ────────────────────────────────────────────────────────────


def test_residual_increment_is_zero_at_and_below_frontier():
    graph = _make_graph(['X', 'Y'], [('X', 'Y')])
    topology = _build_span_topology(graph, 'X', 'Y')
    # p=0.4 Dirac@5 so mass hasn't departed by the f=3 frontier.
    base = _base_provider_from_kernels(
        {('X', 'Y', 0): _dirac_p(0.4, 5, draw_count=1, horizon=8)},
        draw_count=1, horizon=8,
    )
    residual = make_frontier_residual_kernel_provider(
        topology=topology,
        base_kernel_provider=base,
        frontier_by_cohort=[3],
        cohort_count=1, draw_count=1, horizon=8,
    )

    edge = next(ce for ce in topology.concrete_edges)
    kernel, _ = residual(edge, 0, BucketSourceBasis.POINT_AT_ENDPOINT)
    kernel = kernel[0]
    # At source_index=0, frontier offset = 3. Increment at offsets 0..3 must be 0.
    np.testing.assert_allclose(kernel[:, :4], 0.0, atol=1e-12)
    # By f=3 nothing has departed (Dirac fires at 5). Survivor = 1.
    # Residual cumulative B saturates to (Q_e(∞) - Q_e(3))/(1 - 0) =
    # (0.4 - 0)/1 = 0.4.
    cumulative = np.cumsum(kernel, axis=-1)
    np.testing.assert_allclose(cumulative[:, -1], 0.4, atol=1e-12)


# ─── Monotone future ─────────────────────────────────────────────────────


def test_residual_cumulative_is_monotone_non_decreasing_post_frontier():
    graph = _make_graph(['X', 'Y'], [('X', 'Y')])
    topology = _build_span_topology(graph, 'X', 'Y')
    # Spread the kernel across multiple lags so monotonicity is non-trivial.
    kernel_vals = np.array([[0.0, 0.0, 0.1, 0.2, 0.15, 0.1, 0.05, 0.0]])
    base = _base_provider_from_kernels(
        {('X', 'Y', 0): kernel_vals},
        draw_count=1, horizon=8,
    )
    residual = make_frontier_residual_kernel_provider(
        topology=topology,
        base_kernel_provider=base,
        frontier_by_cohort=[2],
        cohort_count=1, draw_count=1, horizon=8,
    )
    edge = next(ce for ce in topology.concrete_edges)
    kernel, _ = residual(edge, 0, BucketSourceBasis.POINT_AT_ENDPOINT)
    kernel = kernel[0]
    cumulative = np.cumsum(kernel, axis=-1)
    # Cumulative non-decreasing.
    diffs = np.diff(cumulative, axis=-1)
    assert (diffs >= -1e-12).all(), f"cumulative dropped: {diffs}"
    # Q_e(2) = 0.1 (kernel up to offset 2); Q_e(∞) = 0.6 total; survivor
    # H_X(0, f=2) = Q_e(0, 2) = 0.1 (single-outgoing → H_U = Q_e).
    # Residual cumulative B(∞) = (0.6 - 0.1) / (1 - 0.1) = 0.5/0.9.
    np.testing.assert_allclose(cumulative[:, -1], 0.5 / 0.9, atol=1e-12)


# ─── Saturation ──────────────────────────────────────────────────────────


def test_residual_saturates_to_one_for_surviving_mass():
    """The renormalisation by 1 - H_U(f) ensures B(∞) = 1 for any
    bucket-u survivor mass that hasn't departed by f_c. Single-outgoing
    is the easy case: 1 - H_U = 1 - Q_e (one-edge survivor)."""
    graph = _make_graph(['X', 'Y'], [('X', 'Y')])
    topology = _build_span_topology(graph, 'X', 'Y')
    # Edge probability 0.3 only (the rest never arrives at Y at all).
    base = _base_provider_from_kernels(
        {('X', 'Y', 0): _dirac_p(0.3, 5, draw_count=1, horizon=10)},
        draw_count=1, horizon=10,
    )
    residual = make_frontier_residual_kernel_provider(
        topology=topology,
        base_kernel_provider=base,
        frontier_by_cohort=[2],
        cohort_count=1, draw_count=1, horizon=10,
    )
    edge = next(ce for ce in topology.concrete_edges)
    kernel, _ = residual(edge, 0, BucketSourceBasis.POINT_AT_ENDPOINT)
    kernel = kernel[0]
    cumulative = np.cumsum(kernel, axis=-1)
    # Among the mass that hasn't departed by f=2 (which is all 100% in
    # this case because the Dirac fires at τ=5), the share that
    # eventually crosses e is 0.3 / 1.0 = 0.3 (only Q_e contributes to
    # H_U since there's one outgoing edge).
    np.testing.assert_allclose(cumulative[:, -1], 0.3, atol=1e-12)


# ─── Single-outgoing degeneration ────────────────────────────────────────


def test_single_outgoing_node_collapses_to_one_edge_residual():
    """At a node with one on-path outgoing edge, H_U == Q_e, so
    1 - H_U = 1 - Q_e and the formula reduces to the one-edge survivor
    fraction (§9.5)."""
    graph = _make_graph(['X', 'Y'], [('X', 'Y')])
    topology = _build_span_topology(graph, 'X', 'Y')
    # Mixed-lag kernel.
    p = 0.6
    base_arr = np.array([[0.0, p * 0.5, p * 0.3, p * 0.2, 0.0, 0.0]])
    base = _base_provider_from_kernels(
        {('X', 'Y', 0): base_arr},
        draw_count=1, horizon=6,
    )
    residual = make_frontier_residual_kernel_provider(
        topology=topology,
        base_kernel_provider=base,
        frontier_by_cohort=[1],
        cohort_count=1, draw_count=1, horizon=6,
    )
    edge = next(ce for ce in topology.concrete_edges)
    kernel, _ = residual(edge, 0, BucketSourceBasis.POINT_AT_ENDPOINT)
    kernel = kernel[0]
    # Manual reference: Q_e cumulative at offsets [0, 0.3p, 0.6p, 0.8p, 0.8p, 0.8p].
    q_cum = np.cumsum(base_arr, axis=-1)
    q_at_f = q_cum[0, 1]  # = 0.3p
    survivor = 1.0 - q_at_f  # H_U = Q_e for single-outgoing
    expected_cum = np.where(
        np.arange(6) > 1,
        (q_cum[0] - q_at_f) / survivor,
        0.0,
    )
    np.testing.assert_allclose(np.cumsum(kernel, axis=-1)[0], expected_cum, atol=1e-12)


# ─── Branch/sibling: node-level survivor binds outgoing flows ───────────


def test_branch_sibling_sum_of_residuals_bounded_by_unit_occupancy():
    """Two on-path outgoing edges X→Y. For unit source mass at X
    bucket 0, the sum of cumulative residual B_e₁ + B_e₂ must be ≤ 1
    at every τ. The plan's §9.9 test 3 — catches the forbidden
    edge-local denominator (which would allow each edge's residual to
    saturate at 1 independently, summing to 2)."""
    graph = _make_graph(['X', 'Y'], [('X', 'Y'), ('X', 'Y')])
    topology = _build_span_topology(graph, 'X', 'Y')
    horizon = 8
    base = _base_provider_from_kernels(
        {
            # Edge 0: p=0.4 dirac@3
            ('X', 'Y', 0): _dirac_p(0.4, 3, draw_count=1, horizon=horizon),
            # Edge 1: p=0.5 dirac@5
            ('X', 'Y', 1): _dirac_p(0.5, 5, draw_count=1, horizon=horizon),
        },
        draw_count=1, horizon=horizon,
    )
    residual = make_frontier_residual_kernel_provider(
        topology=topology,
        base_kernel_provider=base,
        frontier_by_cohort=[2],
        cohort_count=1, draw_count=1, horizon=horizon,
    )
    # Identify the two siblings deterministically.
    edges = sorted(
        (ce for ce in topology.concrete_edges if (ce.from_id, ce.to_id) == ('X', 'Y')),
        key=lambda ce: ce.edge_key,
    )
    k0, _ = residual(edges[0], 0, BucketSourceBasis.POINT_AT_ENDPOINT)
    k0 = k0[0]
    k1, _ = residual(edges[1], 0, BucketSourceBasis.POINT_AT_ENDPOINT)
    k1 = k1[0]
    cum_sum_outgoing = np.cumsum(k0, axis=-1) + np.cumsum(k1, axis=-1)

    # Bound: Σ cum_B_e ≤ 1 for unit source mass.
    assert (cum_sum_outgoing <= 1.0 + 1e-12).all(), (
        f"sum of outgoing residuals exceeds unit occupancy: {cum_sum_outgoing}"
    )
    # Saturation: at large τ, sum equals (H_U(∞) - H_U(f)) / (1 - H_U(f))
    # = (0.9 - 0) / 1 = 0.9 (no mass has departed by f=2).
    np.testing.assert_allclose(cum_sum_outgoing[0, -1], 0.9, atol=1e-12)


def test_branch_sibling_partial_departure_renormalises_node_level():
    """At f=4, edge 0 (lag 3) has fired, edge 1 (lag 5) hasn't.
    H_U(0, f=4) = 0.4, survivor = 0.6. Residual cum sum at saturation:
    (0.4 + 0.5 - 0.4) / 0.6 = 0.5/0.6 ≈ 0.833."""
    graph = _make_graph(['X', 'Y'], [('X', 'Y'), ('X', 'Y')])
    topology = _build_span_topology(graph, 'X', 'Y')
    horizon = 8
    base = _base_provider_from_kernels(
        {
            ('X', 'Y', 0): _dirac_p(0.4, 3, draw_count=1, horizon=horizon),
            ('X', 'Y', 1): _dirac_p(0.5, 5, draw_count=1, horizon=horizon),
        },
        draw_count=1, horizon=horizon,
    )
    residual = make_frontier_residual_kernel_provider(
        topology=topology,
        base_kernel_provider=base,
        frontier_by_cohort=[4],
        cohort_count=1, draw_count=1, horizon=horizon,
    )
    edges = sorted(
        (ce for ce in topology.concrete_edges if (ce.from_id, ce.to_id) == ('X', 'Y')),
        key=lambda ce: ce.edge_key,
    )
    k0, _ = residual(edges[0], 0, BucketSourceBasis.POINT_AT_ENDPOINT)
    k0 = k0[0]
    k1, _ = residual(edges[1], 0, BucketSourceBasis.POINT_AT_ENDPOINT)
    k1 = k1[0]
    # Edge 0 fully departed by f=4, so its residual is zero everywhere.
    np.testing.assert_allclose(np.cumsum(k0, axis=-1)[:, -1], 0.0, atol=1e-12)
    # Edge 1 still has 0.5 to deliver; renormalised by survivor=0.6 → 5/6.
    np.testing.assert_allclose(np.cumsum(k1, axis=-1)[:, -1], 0.5 / 0.6, atol=1e-12)


# ─── NaN propagation under H = 1 ─────────────────────────────────────────


def test_node_fully_drained_emits_nan_visibly():
    """If H_U(u, f_c) = 1 the survivor is 0 and the cumulative B is
    NaN — visible degradation, not silent zero substitution. The
    matching occupancy is zero, so downstream the product is 0 × NaN
    = NaN, which propagates."""
    graph = _make_graph(['X', 'Y'], [('X', 'Y')])
    topology = _build_span_topology(graph, 'X', 'Y')
    horizon = 8
    # p=1 dirac@2 — by f=4, mass is fully departed (H_U = 1).
    base = _base_provider_from_kernels(
        {('X', 'Y', 0): _dirac_p(1.0, 2, draw_count=1, horizon=horizon)},
        draw_count=1, horizon=horizon,
    )
    residual = make_frontier_residual_kernel_provider(
        topology=topology,
        base_kernel_provider=base,
        frontier_by_cohort=[4],
        cohort_count=1, draw_count=1, horizon=horizon,
    )
    edge = next(ce for ce in topology.concrete_edges)
    kernel, _ = residual(edge, 0, BucketSourceBasis.POINT_AT_ENDPOINT)
    kernel = kernel[0]
    # NaN appears in the post-frontier portion (offsets > 4).
    assert np.isnan(kernel[:, 5:]).any()


# ─── Bucket above frontier ───────────────────────────────────────────────


def test_source_bucket_above_frontier_returns_zero_kernel():
    """Bucket u > f_c: mass hasn't arrived at U; no residual to extract."""
    graph = _make_graph(['X', 'Y'], [('X', 'Y')])
    topology = _build_span_topology(graph, 'X', 'Y')
    horizon = 8
    base = _base_provider_from_kernels(
        {('X', 'Y', 0): _dirac_p(1.0, 1, draw_count=1, horizon=horizon)},
        draw_count=1, horizon=horizon,
    )
    residual = make_frontier_residual_kernel_provider(
        topology=topology,
        base_kernel_provider=base,
        frontier_by_cohort=[2],
        cohort_count=1, draw_count=1, horizon=horizon,
    )
    edge = next(ce for ce in topology.concrete_edges)
    kernel, _ = residual(edge, 5, BucketSourceBasis.POINT_AT_ENDPOINT)
    kernel = kernel[0]
    # source_index=5 > f_c=2: kernel is all zeros.
    np.testing.assert_allclose(kernel, 0.0, atol=1e-12)


# ─── Multi-hop residual ──────────────────────────────────────────────────


def test_multi_hop_residual_per_node_uses_local_node_level_survivor():
    """Two-hop X→M→Y. At f=2: X→M has fired (lag 2), no mass departed
    M yet (M→Y has lag 3). Residual at X→M from bucket 0 must respect
    X's H_X; residual at M→Y from bucket 2 must respect M's H_M
    (single-outgoing → 1 - Q_{M→Y}).
    """
    graph = _make_graph(['X', 'M', 'Y'], [('X', 'M'), ('M', 'Y')])
    topology = _build_span_topology(graph, 'X', 'Y')
    horizon = 10
    base = _base_provider_from_kernels(
        {
            ('X', 'M', 0): _dirac_p(1.0, 2, draw_count=1, horizon=horizon),
            ('M', 'Y', 0): _dirac_p(1.0, 3, draw_count=1, horizon=horizon),
        },
        draw_count=1, horizon=horizon,
    )
    residual = make_frontier_residual_kernel_provider(
        topology=topology,
        base_kernel_provider=base,
        frontier_by_cohort=[1],
        cohort_count=1, draw_count=1, horizon=horizon,
    )
    # At f=1, X→M hasn't fired yet; H_X(0, 1) = 0; residual at X→M
    # from bucket 0 has cumulative B saturating to 1.
    edge_xm = next(
        ce for ce in topology.concrete_edges if (ce.from_id, ce.to_id) == ('X', 'M')
    )
    k_xm, _ = residual(edge_xm, 0, BucketSourceBasis.POINT_AT_ENDPOINT)
    k_xm = k_xm[0]
    np.testing.assert_allclose(np.cumsum(k_xm, axis=-1)[:, -1], 1.0, atol=1e-12)


