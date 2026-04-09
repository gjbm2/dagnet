"""Tests for span_kernel.compose_span_kernel.

Verifies:
- Single-edge degeneration to p · CDF(τ)
- Two-edge linear chain (serial convolution)
- Diamond (branching + fan-in)
- Leakage inside edge p
- Asymptotic convergence to path probability
- No-path returns None
"""

import pytest
import sys
import os
import math

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from runner.span_kernel import compose_span_kernel, _shifted_lognormal_pdf, _edge_sub_probability_density
from runner.confidence_bands import _shifted_lognormal_cdf


def _make_edge(from_id: str, to_id: str, p: float, mu: float, sigma: float, onset: float = 0.0) -> dict:
    """Create a minimal edge dict with the params the kernel reads."""
    alpha = p * 20
    beta = (1 - p) * 20
    return {
        'from_node': from_id,
        'to': to_id,
        'uuid': f'{from_id}_{to_id}',
        'p': {
            'value': p,
            'forecast': {'mean': p},
            'posterior': {
                'alpha': alpha,
                'beta': beta,
            },
            'latency': {
                'mu': mu,
                'sigma': sigma,
                'onset_delta_days': onset,
                'posterior': {
                    'mu_mean': mu,
                    'sigma_mean': sigma,
                    'onset_delta_days': onset,
                },
            },
        },
    }


def _make_graph(nodes: list[str], edges: list[dict]) -> dict:
    return {
        'nodes': [{'id': n, 'uuid': n} for n in nodes],
        'edges': edges,
    }


class TestSingleEdge:
    """Single edge x→y must degenerate to p · CDF(τ)."""

    def test_single_edge_matches_existing_cdf(self):
        p, mu, sigma, onset = 0.6, 2.0, 0.8, 3.0
        graph = _make_graph(['x', 'y'], [_make_edge('x', 'y', p, mu, sigma, onset)])

        kernel = compose_span_kernel(graph, 'x', 'y', is_window=True, max_tau=200)

        assert kernel is not None
        assert kernel.max_tau == 200

        # Compare against existing _shifted_lognormal_cdf at several tau values.
        # Tolerance is wider at early tau (discretisation error near onset)
        # and tighter at late tau where the CDF is smooth.
        # Discrete grid convolution vs analytic CDF: expect ~2-3% error
        # near the onset where the PDF is steep.  Tighter at late tau.
        for tau, tol in [(0, 0.001), (5, 0.03), (10, 0.03), (20, 0.025),
                         (50, 0.015), (100, 0.01), (200, 0.01)]:
            expected = p * _shifted_lognormal_cdf(float(tau), onset, mu, sigma)
            actual = kernel.cdf_at(tau)
            assert abs(actual - expected) < tol, (
                f"tau={tau}: expected K={expected:.4f}, got {actual:.4f} (tol={tol})"
            )

    def test_asymptotic_equals_p(self):
        p, mu, sigma = 0.75, 1.5, 0.5
        graph = _make_graph(['x', 'y'], [_make_edge('x', 'y', p, mu, sigma)])

        kernel = compose_span_kernel(graph, 'x', 'y', is_window=True, max_tau=300)

        assert kernel is not None
        assert abs(kernel.span_p - p) < 0.02, f"span_p={kernel.span_p}, expected ~{p}"


class TestTwoEdgeChain:
    """Two-edge chain x→b→y: serial convolution."""

    def test_asymptotic_is_product_of_p(self):
        p1, p2 = 0.8, 0.7
        graph = _make_graph(
            ['x', 'b', 'y'],
            [
                _make_edge('x', 'b', p1, 1.5, 0.5, onset=2.0),
                _make_edge('b', 'y', p2, 2.0, 0.8, onset=1.0),
            ],
        )

        kernel = compose_span_kernel(graph, 'x', 'y', is_window=True, max_tau=400)

        assert kernel is not None
        expected_p = p1 * p2
        assert abs(kernel.span_p - expected_p) < 0.02, (
            f"span_p={kernel.span_p}, expected ~{expected_p}"
        )

    def test_cdf_starts_at_zero_and_increases(self):
        graph = _make_graph(
            ['x', 'b', 'y'],
            [
                _make_edge('x', 'b', 0.9, 1.0, 0.3, onset=1.0),
                _make_edge('b', 'y', 0.8, 1.5, 0.4, onset=2.0),
            ],
        )

        kernel = compose_span_kernel(graph, 'x', 'y', is_window=True, max_tau=200)

        assert kernel is not None
        assert kernel.cdf_at(0) == 0.0
        # CDF must be non-decreasing
        for tau in range(1, 200):
            assert kernel.cdf_at(tau) >= kernel.cdf_at(tau - 1) - 1e-10

    def test_two_edge_is_slower_than_single_edge(self):
        """Adding a second edge should delay the CDF (more latency)."""
        p, mu, sigma = 0.8, 1.5, 0.5

        single = _make_graph(['x', 'y'], [_make_edge('x', 'y', p, mu, sigma, onset=2.0)])
        chain = _make_graph(
            ['x', 'b', 'y'],
            [
                _make_edge('x', 'b', p, mu, sigma, onset=2.0),
                _make_edge('b', 'y', 0.9, 1.0, 0.3, onset=1.0),
            ],
        )

        k_single = compose_span_kernel(single, 'x', 'y', is_window=True, max_tau=200)
        k_chain = compose_span_kernel(chain, 'x', 'y', is_window=True, max_tau=200)

        # At early tau, chain should be below single (more latency)
        mid_tau = 20
        assert k_chain.cdf_at(mid_tau) < k_single.cdf_at(mid_tau)


class TestDiamond:
    """Diamond: x→b→y and x→c→y. Parallel composition."""

    def test_asymptotic_is_sum_of_route_probabilities(self):
        p_xb, p_by = 0.6, 0.7
        p_xc, p_cy = 0.3, 0.8
        graph = _make_graph(
            ['x', 'b', 'c', 'y'],
            [
                _make_edge('x', 'b', p_xb, 1.5, 0.5),
                _make_edge('b', 'y', p_by, 2.0, 0.8),
                _make_edge('x', 'c', p_xc, 1.0, 0.3),
                _make_edge('c', 'y', p_cy, 1.5, 0.6),
            ],
        )

        kernel = compose_span_kernel(graph, 'x', 'y', is_window=True, max_tau=400)

        assert kernel is not None
        expected_p = p_xb * p_by + p_xc * p_cy
        assert abs(kernel.span_p - expected_p) < 0.03, (
            f"span_p={kernel.span_p}, expected ~{expected_p}"
        )

    def test_diamond_higher_than_single_route(self):
        """Two routes should have higher span_p than either route alone."""
        graph = _make_graph(
            ['x', 'b', 'c', 'y'],
            [
                _make_edge('x', 'b', 0.5, 1.5, 0.5),
                _make_edge('b', 'y', 0.6, 2.0, 0.8),
                _make_edge('x', 'c', 0.4, 1.0, 0.3),
                _make_edge('c', 'y', 0.7, 1.5, 0.6),
            ],
        )

        kernel = compose_span_kernel(graph, 'x', 'y', is_window=True, max_tau=300)
        route1_p = 0.5 * 0.6
        route2_p = 0.4 * 0.7

        assert kernel.span_p > route1_p
        assert kernel.span_p > route2_p


class TestDiamondPlusTail:
    """Diamond + tail: x→b→d, x→c→d, d→y."""

    def test_asymptotic_correct(self):
        p_xb, p_bd = 0.7, 0.8
        p_xc, p_cd = 0.2, 0.9
        p_dy = 0.6
        graph = _make_graph(
            ['x', 'b', 'c', 'd', 'y'],
            [
                _make_edge('x', 'b', p_xb, 1.0, 0.3),
                _make_edge('x', 'c', p_xc, 1.5, 0.5),
                _make_edge('b', 'd', p_bd, 1.0, 0.4),
                _make_edge('c', 'd', p_cd, 2.0, 0.6),
                _make_edge('d', 'y', p_dy, 1.5, 0.5),
            ],
        )

        kernel = compose_span_kernel(graph, 'x', 'y', is_window=True, max_tau=400)

        expected_p = (p_xb * p_bd + p_xc * p_cd) * p_dy
        assert abs(kernel.span_p - expected_p) < 0.03, (
            f"span_p={kernel.span_p}, expected ~{expected_p}"
        )


class TestLeakage:
    """Leakage: x→b→y with b→z (side exit). p_{b→y} < 1."""

    def test_leakage_reduces_span_p(self):
        # b has two outgoing: b→y (p=0.6) and b→z (p=0.3)
        graph = _make_graph(
            ['x', 'b', 'y', 'z'],
            [
                _make_edge('x', 'b', 0.9, 1.0, 0.3),
                _make_edge('b', 'y', 0.6, 1.5, 0.5),
                _make_edge('b', 'z', 0.3, 2.0, 0.8),
            ],
        )

        kernel = compose_span_kernel(graph, 'x', 'y', is_window=True, max_tau=300)

        # b→z is not on x→y path, but b→y's p=0.6 absorbs leakage
        expected_p = 0.9 * 0.6
        assert abs(kernel.span_p - expected_p) < 0.02


class TestNoPath:
    """No path from x to y returns None."""

    def test_disconnected_returns_none(self):
        graph = _make_graph(
            ['x', 'y', 'z'],
            [_make_edge('x', 'z', 0.8, 1.0, 0.3)],
        )

        kernel = compose_span_kernel(graph, 'x', 'y', is_window=True, max_tau=100)
        assert kernel is None

    def test_same_node_returns_none(self):
        graph = _make_graph(['x'], [])
        kernel = compose_span_kernel(graph, 'x', 'x', is_window=True, max_tau=100)
        assert kernel is None


class TestPdfConsistency:
    """The PDF helper must integrate to ~1 over the grid."""

    def test_pdf_integrates_to_one(self):
        tau_grid = np.arange(0, 500, dtype=float)
        pdf = _shifted_lognormal_pdf(tau_grid, onset=3.0, mu=2.0, sigma=0.8)
        integral = np.sum(pdf)
        assert abs(integral - 1.0) < 0.02, f"PDF integral={integral}, expected ~1.0"
