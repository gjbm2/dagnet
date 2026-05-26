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

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from runner.span_kernel import (
    ConcreteEdge,
    _build_span_topology,
    compose_span_kernel,
    _shifted_lognormal_pdf,
    _edge_sub_probability_density,
)
from runner.timing_span import (
    SpanDPTrace,
    _run_dp_density_trace,
)
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


def _build_prepared_edge_params(graph: dict) -> dict[tuple[str, str], tuple[float, float, float, float]]:
    params: dict[tuple[str, str], tuple[float, float, float, float]] = {}
    for edge in graph.get('edges', []):
        from_id = edge.get('from_node', edge.get('from', ''))
        to_id = edge.get('to', edge.get('to_node', ''))
        p_data = edge.get('p', {})
        latency = p_data.get('latency', {})
        posterior = latency.get('posterior', {})
        params[(from_id, to_id)] = (
            float(p_data.get('forecast', {}).get('mean', p_data.get('value', 0.0)) or 0.0),
            float(posterior.get('mu_mean', latency.get('mu', 0.0)) or 0.0),
            float(posterior.get('sigma_mean', latency.get('sigma', 0.0)) or 0.0),
            float(posterior.get('onset_delta_days', latency.get('onset_delta_days', 0.0)) or 0.0),
        )
    return params


def _compose(
    graph: dict,
    x_node_id: str,
    y_node_id: str,
    *,
    max_tau: int,
    edge_params: dict[tuple[str, str], tuple[float, float, float, float]] | None = None,
):
    topo = _build_span_topology(graph, x_node_id, y_node_id)
    if topo is None:
        return None
    return compose_span_kernel(
        topo=topo,
        edge_params=edge_params or _build_prepared_edge_params(graph),
        max_tau=max_tau,
    )


class TestSingleEdge:
    """Single edge x→y must degenerate to p · CDF(τ)."""

    def test_single_edge_matches_existing_cdf(self):
        p, mu, sigma, onset = 0.6, 2.0, 0.8, 3.0
        graph = _make_graph(['x', 'y'], [_make_edge('x', 'y', p, mu, sigma, onset)])

        kernel = _compose(graph, 'x', 'y', max_tau=200)

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

        kernel = _compose(graph, 'x', 'y', max_tau=300)

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

        kernel = _compose(graph, 'x', 'y', max_tau=400)

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

        kernel = _compose(graph, 'x', 'y', max_tau=200)

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

        k_single = _compose(single, 'x', 'y', max_tau=200)
        k_chain = _compose(chain, 'x', 'y', max_tau=200)

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

        kernel = _compose(graph, 'x', 'y', max_tau=400)

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

        kernel = _compose(graph, 'x', 'y', max_tau=300)
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

        kernel = _compose(graph, 'x', 'y', max_tau=400)

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

        kernel = _compose(graph, 'x', 'y', max_tau=300)

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

        kernel = _compose(graph, 'x', 'y', max_tau=100)
        assert kernel is None

    def test_same_node_is_identity_kernel(self):
        """x == y is the identity element of operator-chain composition:
        mass concentrated at tau=0, K(τ) = 1 for all τ ≥ 0.
        """
        graph = _make_graph(['x'], [])
        kernel = _compose(graph, 'x', 'x', max_tau=100)
        assert kernel is not None
        assert kernel.density[0] == 1.0
        assert all(d == 0.0 for d in kernel.density[1:])
        assert all(k == 1.0 for k in kernel.K)
        assert kernel.span_p == 1.0


class TestPreparedInputs:
    """Kernel execution must follow prepared inputs, not raw edge fields."""

    def test_kernel_uses_prepared_edge_params_only(self):
        graph = _make_graph(['x', 'y'], [_make_edge('x', 'y', 0.85, 2.0, 0.6)])
        override_params = {('x', 'y'): (0.2, 1.0, 0.3, 0.0)}

        kernel = _compose(
            graph,
            'x',
            'y',
            max_tau=200,
            edge_params=override_params,
        )

        assert kernel is not None
        assert kernel.span_p == pytest.approx(0.2, abs=0.02)

    def test_runtime_preparation_uses_window_rate_prior_under_factorised_composition(self):
        """Under WP3 factorised composition every per-edge primitive
        consumes the edge-local window rate prior, regardless of the
        query's `temporal_mode`. The `cohort_*` mirrors on the source
        ledger are reserved for the path-level primitive that WP8 will
        introduce; they are not read by the factorised consumer (doc 60
        decisions 4 & 7, doc 47, doc 66 §4).

        `temporal_mode` is still load-bearing for `n_effective` and
        latency selection in the resolver — this test pins only the
        rate prior under the WP3 invariant.
        """
        from runner.forecast_runtime import build_prepared_span_execution

        graph = _make_graph(['x', 'y'], [_make_edge('x', 'y', 0.4, 2.0, 0.6)])
        # Populate the cohort mirror on the source ledger so the assertion
        # is "the engine ignored it", not "the engine had nothing to read".
        graph['edges'][0]['p']['model_vars'] = [{
            'source': 'analytic',
            'latency': {'mu': 2.0, 'sigma': 0.6, 'onset_delta_days': 0.0},
            'probability': {
                'mean': 0.4, 'stdev': 0.05,
                'alpha': 8.0, 'beta': 12.0,
                'alpha_pred': 8.0, 'beta_pred': 12.0,
                'cohort_alpha': 80.0, 'cohort_beta': 20.0,
                'cohort_alpha_pred': 80.0, 'cohort_beta_pred': 20.0,
                'n_effective': 20.0,
            },
        }]

        window_execution = build_prepared_span_execution(
            graph,
            'x',
            'y',
            temporal_mode='window',
        )
        cohort_execution = build_prepared_span_execution(
            graph,
            'x',
            'y',
            temporal_mode='cohort',
        )

        assert window_execution is not None
        assert cohort_execution is not None
        # Both modes resolve the edge rate from the window slice — the
        # cohort mirror on the source ledger is not consulted.
        assert window_execution.edge_params[('x', 'y')][0] == pytest.approx(0.4)
        assert cohort_execution.edge_params[('x', 'y')][0] == pytest.approx(0.4)


class TestPdfConsistency:
    """The PDF helper must integrate to ~1 over the grid."""

    def test_pdf_integrates_to_one(self):
        tau_grid = np.arange(0, 500, dtype=float)
        pdf = _shifted_lognormal_pdf(tau_grid, onset=3.0, mu=2.0, sigma=0.8)
        integral = np.sum(pdf)
        assert abs(integral - 1.0) < 0.02, f"PDF integral={integral}, expected ~1.0"


# ─── Stage A — concrete-edge topology + trace-returning DP ────────────


class TestConcreteEdgeTopology:
    """The topology must expose every graph edge as a distinct ConcreteEdge
    with a stable, structural edge_key, so coincident sibling edges no
    longer collapse into a single endpoint-pair entry.
    """

    def test_linear_chain_has_one_concrete_edge_per_graph_edge(self):
        graph = _make_graph(
            ['x', 'y', 'z'],
            [
                _make_edge('x', 'y', 0.7, mu=1.0, sigma=0.6),
                _make_edge('y', 'z', 0.6, mu=1.2, sigma=0.5),
            ],
        )
        topo = _build_span_topology(graph, 'x', 'z')
        assert topo is not None
        assert len(topo.concrete_edges) == 2
        keys = [ce.edge_key for ce in topo.concrete_edges]
        assert keys == ['x->y#0', 'y->z#0']

    def test_coincident_siblings_yield_two_distinct_concrete_edges(self):
        graph = _make_graph(
            ['u', 'v'],
            [
                _make_edge('u', 'v', 0.5, mu=1.0, sigma=0.4),
                _make_edge('u', 'v', 0.3, mu=2.5, sigma=0.6),
            ],
        )
        topo = _build_span_topology(graph, 'u', 'v')
        assert topo is not None
        assert len(topo.concrete_edges) == 2
        keys = [ce.edge_key for ce in topo.concrete_edges]
        assert keys == ['u->v#0', 'u->v#1']
        # Both siblings appear at the destination's incoming edges, not
        # collapsed into a single predecessor entry.
        incoming = topo.incoming_concrete_edges['v']
        assert len(incoming) == 2
        assert {ce.edge_key for ce in incoming} == {'u->v#0', 'u->v#1'}

    def test_branch_join_exposes_every_incoming_concrete_edge(self):
        graph = _make_graph(
            ['x', 'y1', 'y2', 'z'],
            [
                _make_edge('x', 'y1', 0.6, mu=1.0, sigma=0.5),
                _make_edge('x', 'y2', 0.4, mu=1.2, sigma=0.5),
                _make_edge('y1', 'z', 0.7, mu=1.0, sigma=0.5),
                _make_edge('y2', 'z', 0.8, mu=1.0, sigma=0.5),
            ],
        )
        topo = _build_span_topology(graph, 'x', 'z')
        assert topo is not None
        incoming_z = topo.incoming_concrete_edges['z']
        assert len(incoming_z) == 2
        from_ids_at_z = {ce.from_id for ce in incoming_z}
        assert from_ids_at_z == {'y1', 'y2'}


class TestRunDpDensityTrace:
    """The trace-returning DP must retain per-node arrival density and
    per-edge contribution, keyed by concrete edge so sibling edges remain
    distinguishable. Identity that downstream readers depend on:
    `cumsum(node_density[end])` equals the terminal CDF that
    `_run_dp_density_grid` historically returned.
    """

    @staticmethod
    def _density(p, mu, sigma, T):
        tau_grid = np.arange(T, dtype=float)
        return _edge_sub_probability_density(tau_grid, p, 0.0, mu, sigma)

    @staticmethod
    def _trace(topo, densities, T):
        batched = {
            edge_key: density[None, :]
            for edge_key, density in densities.items()
        }
        return _run_dp_density_trace(
            topo,
            lambda ce, _source_index: batched[ce.edge_key],
            1,
            T,
        )

    def test_root_node_density_is_delta_at_tau_zero(self):
        T = 200
        graph = _make_graph(
            ['x', 'y', 'z'],
            [
                _make_edge('x', 'y', 0.5, mu=1.0, sigma=0.5),
                _make_edge('y', 'z', 0.5, mu=1.0, sigma=0.5),
            ],
        )
        topo = _build_span_topology(graph, 'x', 'z')
        densities = {
            'x->y#0': self._density(0.5, 1.0, 0.5, T),
            'y->z#0': self._density(0.5, 1.0, 0.5, T),
        }
        trace = self._trace(topo, densities, T)
        root_density = trace.node_density('x')[0]
        assert root_density[0] == pytest.approx(1.0)
        assert np.sum(root_density[1:]) == pytest.approx(0.0, abs=1e-12)

    def test_intermediate_node_density_equals_sum_of_incoming_contributions(self):
        T = 200
        graph = _make_graph(
            ['x', 'y1', 'y2', 'z'],
            [
                _make_edge('x', 'y1', 0.6, mu=1.0, sigma=0.5),
                _make_edge('x', 'y2', 0.4, mu=1.5, sigma=0.5),
                _make_edge('y1', 'z', 0.7, mu=1.0, sigma=0.5),
                _make_edge('y2', 'z', 0.8, mu=1.0, sigma=0.5),
            ],
        )
        topo = _build_span_topology(graph, 'x', 'z')
        densities = {
            'x->y1#0': self._density(0.6, 1.0, 0.5, T),
            'x->y2#0': self._density(0.4, 1.5, 0.5, T),
            'y1->z#0': self._density(0.7, 1.0, 0.5, T),
            'y2->z#0': self._density(0.8, 1.0, 0.5, T),
        }
        trace = self._trace(topo, densities, T)
        z_from_edges = (
            trace.edge_contribution('y1->z#0')[0]
            + trace.edge_contribution('y2->z#0')[0]
        )
        np.testing.assert_allclose(
            trace.node_density('z')[0], z_from_edges, atol=1e-12,
        )

    def test_coincident_siblings_have_separate_per_edge_contributions(self):
        T = 200
        graph = _make_graph(
            ['u', 'v'],
            [
                _make_edge('u', 'v', 0.5, mu=1.0, sigma=0.4),
                _make_edge('u', 'v', 0.3, mu=2.5, sigma=0.6),
            ],
        )
        topo = _build_span_topology(graph, 'u', 'v')
        kernel_a = self._density(0.5, 1.0, 0.4, T)
        kernel_b = self._density(0.3, 2.5, 0.6, T)
        densities = {
            'u->v#0': kernel_a,
            'u->v#1': kernel_b,
        }
        trace = self._trace(topo, densities, T)
        contrib_a = trace.edge_contribution('u->v#0')[0]
        contrib_b = trace.edge_contribution('u->v#1')[0]
        # Each sibling's contribution is its kernel convolved with δ(0),
        # which equals the kernel itself.
        np.testing.assert_allclose(contrib_a, kernel_a, atol=1e-12)
        np.testing.assert_allclose(contrib_b, kernel_b, atol=1e-12)
        np.testing.assert_allclose(
            trace.node_density('v')[0],
            kernel_a + kernel_b,
            atol=1e-12,
        )

    def test_terminal_cumsum_matches_legacy_run_dp_density_grid(self):
        from runner.timing_span import _run_dp_density_grid

        T = 200
        graph = _make_graph(
            ['x', 'y', 'z'],
            [
                _make_edge('x', 'y', 0.6, mu=1.0, sigma=0.5),
                _make_edge('y', 'z', 0.7, mu=1.2, sigma=0.5),
            ],
        )
        topo = _build_span_topology(graph, 'x', 'z')
        kernel_xy = self._density(0.6, 1.0, 0.5, T)
        kernel_yz = self._density(0.7, 1.2, 0.5, T)
        densities_by_edge_key = {
            'x->y#0': kernel_xy,
            'y->z#0': kernel_yz,
        }
        densities_by_pair = {
            ('x', 'y'): kernel_xy,
            ('y', 'z'): kernel_yz,
        }
        trace = self._trace(topo, densities_by_edge_key, T)
        cdf_from_trace = np.cumsum(trace.node_density('z')[0])
        cdf_from_grid = _run_dp_density_grid(topo, densities_by_pair, T)
        np.testing.assert_allclose(cdf_from_trace, cdf_from_grid, atol=1e-12)

    def test_batched_dp_matches_per_draw_source_index_selection(self):
        """The batched DP is a rank lift of the scalar draw loop. Kernel
        providers may depend on the source-day index; for every draw, the
        batched output must match the same shifted update done manually."""
        T = 8
        S = 3
        graph = _make_graph(
            ['x', 'y', 'z'],
            [
                _make_edge('x', 'y', 0.6, mu=1.0, sigma=0.5),
                _make_edge('y', 'z', 0.7, mu=1.2, sigma=0.5),
            ],
        )
        topo = _build_span_topology(graph, 'x', 'z')

        xy_kernel = np.zeros((S, T), dtype=np.float64)
        xy_kernel[:, 0] = np.array([0.2, 0.3, 0.4])
        xy_kernel[:, 2] = np.array([0.1, 0.2, 0.3])

        yz_by_source = {}
        for source_index in range(T):
            kernel = np.zeros((S, T), dtype=np.float64)
            kernel[:, 1] = np.array([0.5, 0.4, 0.3]) + (0.01 * source_index)
            kernel[:, 3] = np.array([0.2, 0.1, 0.05])
            yz_by_source[source_index] = kernel

        def _provider(ce, source_index):
            if ce.edge_key == 'x->y#0':
                return xy_kernel
            return yz_by_source[int(source_index)]

        trace = _run_dp_density_trace(topo, _provider, S, T)

        expected_y = xy_kernel
        expected_z = np.zeros((S, T), dtype=np.float64)
        for source_index in np.flatnonzero(np.any(expected_y != 0.0, axis=0)):
            remaining = T - int(source_index)
            expected_z[:, int(source_index):] += (
                expected_y[:, int(source_index), None]
                * yz_by_source[int(source_index)][:, :remaining]
            )

        np.testing.assert_allclose(
            trace.node_density('y'), expected_y, atol=1e-12,
        )
        np.testing.assert_allclose(
            trace.node_density('z'), expected_z, atol=1e-12,
        )


class TestSpanDPTraceSourceBucketLedger:
    """The source-bucket-aware ledgers on ``SpanDPTrace`` are the canonical
    storage; the collapsed ``node_density`` / ``edge_contribution`` views
    are sum-over-bucket helpers. The DP must preserve the identity
    ``collapsed == Σ_buckets bucket_entry`` so frontier-occupancy work
    (Atom 4) can derive state from the bucket structure without
    reconstructing it from terminal row totals.
    """

    @staticmethod
    def _density(p, mu, sigma, T):
        tau_grid = np.arange(T, dtype=float)
        return _edge_sub_probability_density(tau_grid, p, 0.0, mu, sigma)

    @staticmethod
    def _trace(topo, densities, T):
        batched = {
            edge_key: density[None, :]
            for edge_key, density in densities.items()
        }
        return _run_dp_density_trace(
            topo,
            lambda ce, _source_index: batched[ce.edge_key],
            1,
            T,
        )

    def test_root_node_source_bucket_holds_seed_at_bucket_zero(self):
        """δ(0) seed materialises as a single bucket-0 entry on the
        topology root; no other buckets are populated at the root.
        """
        T = 50
        graph = _make_graph(
            ['x', 'y'],
            [_make_edge('x', 'y', 0.5, mu=1.0, sigma=0.5)],
        )
        topo = _build_span_topology(graph, 'x', 'y')
        densities = {'x->y#0': self._density(0.5, 1.0, 0.5, T)}
        trace = self._trace(topo, densities, T)
        root_buckets = trace.node_density_by_node_bucket['x']
        assert set(root_buckets.keys()) == {0}
        # Bucket 0 carries the δ(0) seed value per draw.
        np.testing.assert_array_equal(root_buckets[0], np.ones(1))

    def test_collapsed_node_density_equals_sum_over_arrival_buckets(self):
        """For every on-path node the collapsed ``node_density`` view
        must equal the per-arrival-bucket entries summed into the right
        columns. Mismatch implies the bucketed ledger drifted from the
        DP's actual destination column writes.
        """
        T = 80
        graph = _make_graph(
            ['x', 'y', 'z'],
            [
                _make_edge('x', 'y', 0.6, mu=1.0, sigma=0.5),
                _make_edge('y', 'z', 0.7, mu=1.2, sigma=0.5),
            ],
        )
        topo = _build_span_topology(graph, 'x', 'z')
        densities = {
            'x->y#0': self._density(0.6, 1.0, 0.5, T),
            'y->z#0': self._density(0.7, 1.2, 0.5, T),
        }
        trace = self._trace(topo, densities, T)
        for node, buckets in trace.node_density_by_node_bucket.items():
            expected = np.zeros((1, T), dtype=np.float64)
            for arrival_col, col_mass in buckets.items():
                expected[:, int(arrival_col)] += col_mass
            np.testing.assert_allclose(
                trace.node_density(node), expected, atol=1e-12,
            )

    def test_collapsed_edge_contribution_equals_sum_over_source_buckets(self):
        """For every concrete edge the collapsed ``edge_contribution``
        view must equal the per-source-bucket smears summed elementwise.
        Holds at branch/sibling and chain edges alike.
        """
        T = 80
        graph = _make_graph(
            ['x', 'y1', 'y2', 'z'],
            [
                _make_edge('x', 'y1', 0.6, mu=1.0, sigma=0.5),
                _make_edge('x', 'y2', 0.4, mu=1.5, sigma=0.5),
                _make_edge('y1', 'z', 0.7, mu=1.0, sigma=0.5),
                _make_edge('y2', 'z', 0.8, mu=1.0, sigma=0.5),
            ],
        )
        topo = _build_span_topology(graph, 'x', 'z')
        densities = {
            'x->y1#0': self._density(0.6, 1.0, 0.5, T),
            'x->y2#0': self._density(0.4, 1.5, 0.5, T),
            'y1->z#0': self._density(0.7, 1.0, 0.5, T),
            'y2->z#0': self._density(0.8, 1.0, 0.5, T),
        }
        trace = self._trace(topo, densities, T)
        for edge_key, source_buckets in trace.edge_contribution_by_edge_source.items():
            expected = np.zeros((1, T), dtype=np.float64)
            for smear in source_buckets.values():
                expected += smear
            np.testing.assert_allclose(
                trace.edge_contribution(edge_key), expected, atol=1e-12,
            )

    def test_branch_sibling_per_edge_source_bucket_sum_matches_legacy_collapsed(self):
        """At a branch/sibling source node, each outgoing concrete edge
        must own an independent source-bucket dict. Their per-edge
        collapsed contributions remain distinct, and each per-edge
        source-bucket sum equals the kernel applied to the source node's
        density (the value the legacy collapsed read would have
        returned).
        """
        T = 60
        graph = _make_graph(
            ['x', 'y1', 'y2', 'z'],
            [
                _make_edge('x', 'y1', 0.6, mu=1.0, sigma=0.5),
                _make_edge('x', 'y2', 0.4, mu=1.5, sigma=0.5),
                _make_edge('y1', 'z', 0.7, mu=1.0, sigma=0.5),
                _make_edge('y2', 'z', 0.8, mu=1.0, sigma=0.5),
            ],
        )
        topo = _build_span_topology(graph, 'x', 'z')
        kernel_xy1 = self._density(0.6, 1.0, 0.5, T)
        kernel_xy2 = self._density(0.4, 1.5, 0.5, T)
        densities = {
            'x->y1#0': kernel_xy1,
            'x->y2#0': kernel_xy2,
            'y1->z#0': self._density(0.7, 1.0, 0.5, T),
            'y2->z#0': self._density(0.8, 1.0, 0.5, T),
        }
        trace = self._trace(topo, densities, T)
        # Each sibling has its own source-bucket dict (no collapsing of
        # siblings into one entry).
        assert 'x->y1#0' in trace.edge_contribution_by_edge_source
        assert 'x->y2#0' in trace.edge_contribution_by_edge_source
        assert (
            trace.edge_contribution_by_edge_source['x->y1#0']
            is not trace.edge_contribution_by_edge_source['x->y2#0']
        )
        # The per-edge source-bucket sum still equals the kernel itself
        # (δ(0) at the root → bucket 0 is the only source bucket).
        np.testing.assert_allclose(
            trace.edge_contribution('x->y1#0')[0],
            kernel_xy1,
            atol=1e-12,
        )
        np.testing.assert_allclose(
            trace.edge_contribution('x->y2#0')[0],
            kernel_xy2,
            atol=1e-12,
        )


class TestSpanDPTraceBasisProvenance:
    """``SpanDPTrace.node_basis_by_node_bucket`` is the canonical basis
    provenance surface: ``node -> arrival_bucket -> provenance_key ->
    BucketSourceBasis``. ``provenance_key`` is the contributing edge_key
    (or ``SEED_ORIGIN_KEY`` for the root seed). The surface must preserve
    each contributing edge's own basis at merge points — no last-write-
    wins collapse — so frontier-state construction (Atom 4) can select
    the basis tied to the contribution it is continuing.
    """

    @staticmethod
    def _diamond_topology_with_distinct_bases(bases):
        """Build a 4-node diamond ``x -> {m1, m2} -> z`` and run the
        DP with a δ(0) kernel on every edge, returning ``out_basis``
        per edge from ``bases``. The δ(0) kernels make every edge land
        at column 0 of its destination so both ``m1->z`` and ``m2->z``
        converge on the same arrival bucket of ``z``, exercising the
        merge case the user identified.
        """
        from runner.bucket_transition import BucketSourceBasis
        from runner.span_kernel import _build_span_topology
        from runner.timing_span import _run_dp_density_trace_from_seed

        T = 8
        S = 1
        graph = _make_graph(
            ['x', 'm1', 'm2', 'z'],
            [
                _make_edge('x', 'm1', 1.0, mu=0.0, sigma=0.001),
                _make_edge('x', 'm2', 1.0, mu=0.0, sigma=0.001),
                _make_edge('m1', 'z', 1.0, mu=0.0, sigma=0.001),
                _make_edge('m2', 'z', 1.0, mu=0.0, sigma=0.001),
            ],
        )
        topo = _build_span_topology(graph, 'x', 'z')

        def provider(ce, source_index, cohort_index, source_basis):
            kernel = np.zeros((S, T), dtype=np.float64)
            kernel[:, 0] = 1.0  # δ(0) — destination column = source column.
            return kernel, bases[ce.edge_key]

        root_density = np.zeros((S, T), dtype=np.float64)
        root_density[:, 0] = 1.0
        from runner.timing_span import DPExecutionPolicy
        trace = _run_dp_density_trace_from_seed(
            topo,
            provider,
            root_density,
            S,
            T,
            execution_policy=DPExecutionPolicy.SCALAR,
        )
        return trace, T, S

    def test_merge_does_not_collapse_to_single_last_write_wins_basis(self):
        """Two edges into the same arrival bucket of the same node with
        *different* ``BucketSourceBasis`` values must each keep their
        own entry. A surface that retained only one int per
        ``(node, bucket)`` (the prior shape) would lose the loser of
        the iteration race.
        """
        from runner.bucket_transition import BucketSourceBasis

        trace, _T, _S = self._diamond_topology_with_distinct_bases({
            'x->m1#0': BucketSourceBasis.POINT_AT_ENDPOINT,
            'x->m2#0': BucketSourceBasis.POINT_AT_ENDPOINT,
            'm1->z#0': BucketSourceBasis.POINT_AT_ENDPOINT,
            'm2->z#0': BucketSourceBasis.BUCKET_DISTRIBUTED,
        })
        z_provenance_at_zero = trace.node_basis_by_node_bucket['z'][0]
        m1z_key = f'm1->z#0@{int(BucketSourceBasis.POINT_AT_ENDPOINT)}'
        m2z_key = f'm2->z#0@{int(BucketSourceBasis.BUCKET_DISTRIBUTED)}'
        # Both incoming edges must be present at the merge bucket.
        assert m1z_key in z_provenance_at_zero
        assert m2z_key in z_provenance_at_zero
        # Their bases must be the distinct values supplied by the
        # provider — NOT a single collapsed/last-write-wins int.
        assert (
            z_provenance_at_zero[m1z_key]
            == int(BucketSourceBasis.POINT_AT_ENDPOINT)
        )
        assert (
            z_provenance_at_zero[m2z_key]
            == int(BucketSourceBasis.BUCKET_DISTRIBUTED)
        )
        # And the two values are not the same.
        assert (
            z_provenance_at_zero[m1z_key]
            != z_provenance_at_zero[m2z_key]
        )

    def test_each_contributing_edge_keyed_under_its_own_edge_key(self):
        """Provenance is keyed strictly by ``edge_key``: looking up
        ``[edge_key_A]`` returns A's basis even when edge B wrote the
        same column with a different basis. The structure separates
        the merging contributions; it does not blend or alias them.
        """
        from runner.bucket_transition import BucketSourceBasis
        from runner.timing_span import SEED_ORIGIN_KEY

        trace, _T, _S = self._diamond_topology_with_distinct_bases({
            'x->m1#0': BucketSourceBasis.POINT_AT_ENDPOINT,
            'x->m2#0': BucketSourceBasis.BUCKET_DISTRIBUTED,
            'm1->z#0': BucketSourceBasis.POINT_AT_ENDPOINT,
            'm2->z#0': BucketSourceBasis.BUCKET_DISTRIBUTED,
        })
        xm1_key = f'x->m1#0@{int(BucketSourceBasis.POINT_AT_ENDPOINT)}'
        xm2_key = f'x->m2#0@{int(BucketSourceBasis.BUCKET_DISTRIBUTED)}'
        # Each intermediate node's bucket-0 provenance is keyed under
        # exactly its incoming edge — not the sibling edge.
        assert (
            trace.node_basis_by_node_bucket['m1'][0][xm1_key]
            == int(BucketSourceBasis.POINT_AT_ENDPOINT)
        )
        assert xm2_key not in trace.node_basis_by_node_bucket['m1'][0]
        assert (
            trace.node_basis_by_node_bucket['m2'][0][xm2_key]
            == int(BucketSourceBasis.BUCKET_DISTRIBUTED)
        )
        assert xm1_key not in trace.node_basis_by_node_bucket['m2'][0]
        # The root seed is keyed by the seed-origin marker, not by an
        # edge_key, so the consumer can distinguish a seed contribution
        # from an edge contribution.
        assert (
            list(trace.node_basis_by_node_bucket['x'][0].keys())
            == [SEED_ORIGIN_KEY]
        )

    def test_consumer_can_select_basis_tied_to_a_specific_contribution(self):
        """Frontier-state construction (Atom 4) needs to continue from
        a specific contribution and read the basis that contribution
        carried in. The per-bucket provenance map is that lookup
        surface — given a node, an arrival bucket, and a contribution
        identifier (edge_key or seed marker), the consumer reads the
        basis it should propagate without scanning sibling
        contributions.
        """
        from runner.bucket_transition import BucketSourceBasis
        from runner.timing_span import SEED_ORIGIN_KEY

        trace, _T, _S = self._diamond_topology_with_distinct_bases({
            'x->m1#0': BucketSourceBasis.POINT_AT_ENDPOINT,
            'x->m2#0': BucketSourceBasis.BUCKET_DISTRIBUTED,
            'm1->z#0': BucketSourceBasis.POINT_AT_ENDPOINT,
            'm2->z#0': BucketSourceBasis.BUCKET_DISTRIBUTED,
        })

        # Selecting the basis tied to a specific edge contribution.
        def select_basis_for(node, bucket, provenance_key):
            return trace.node_basis_by_node_bucket[node][bucket][provenance_key]

        # The two contributions into z's merge bucket are selectable
        # independently — selection by composite provenance key returns
        # *that* edge's basis, not a collapsed or shared value.
        m1z_key = f'm1->z#0@{int(BucketSourceBasis.POINT_AT_ENDPOINT)}'
        m2z_key = f'm2->z#0@{int(BucketSourceBasis.BUCKET_DISTRIBUTED)}'
        assert select_basis_for('z', 0, m1z_key) == int(
            BucketSourceBasis.POINT_AT_ENDPOINT,
        )
        assert select_basis_for('z', 0, m2z_key) == int(
            BucketSourceBasis.BUCKET_DISTRIBUTED,
        )
        # The seed contribution at the root is selectable under the
        # seed-origin marker. A frontier-state continuation from the
        # seed reads this surface, not the column-collapsed view.
        assert select_basis_for('x', 0, SEED_ORIGIN_KEY) == int(
            BucketSourceBasis.POINT_AT_ENDPOINT,
        )

    def test_collapsed_helper_views_still_match_legacy_mass(self):
        """The basis refactor must not perturb mass numerics. With two
        contributions converging at the same arrival bucket carrying
        *different* ``BucketSourceBasis`` values, the collapsed
        ``node_density(z)`` and ``edge_contribution(...)`` helpers must
        still equal the per-bucket sums — the legacy view used by every
        downstream consumer that has not yet migrated to the canonical
        per-bucket surface.
        """
        from runner.bucket_transition import BucketSourceBasis

        trace, T, S = self._diamond_topology_with_distinct_bases({
            'x->m1#0': BucketSourceBasis.POINT_AT_ENDPOINT,
            'x->m2#0': BucketSourceBasis.POINT_AT_ENDPOINT,
            'm1->z#0': BucketSourceBasis.POINT_AT_ENDPOINT,
            'm2->z#0': BucketSourceBasis.BUCKET_DISTRIBUTED,
        })
        # Collapsed node_density == per-arrival-bucket sum on every node.
        for node, buckets in trace.node_density_by_node_bucket.items():
            expected = np.zeros((S, T), dtype=np.float64)
            for arrival_col, col_mass in buckets.items():
                expected[:, int(arrival_col)] += col_mass
            np.testing.assert_allclose(
                trace.node_density(node), expected, atol=1e-12,
            )
        # Collapsed edge_contribution == per-source-bucket sum on every
        # concrete edge.
        for edge_key, source_buckets in trace.edge_contribution_by_edge_source.items():
            expected = np.zeros((S, T), dtype=np.float64)
            for smear in source_buckets.values():
                expected += smear
            np.testing.assert_allclose(
                trace.edge_contribution(edge_key), expected, atol=1e-12,
            )
        # And the diamond's z-density at the merge column equals the
        # algebraic identity: mass arrived twice (one from each
        # branch), each branch passing 1.0 through.
        z_density = trace.node_density('z')
        assert float(z_density[0, 0]) == pytest.approx(2.0)

    def test_downstream_propagation_invokes_kernel_per_source_provenance_basis(self):
        """When two contributions converge into the same source bucket
        with different bases, the downstream kernel must be invoked
        *once per source provenance* with that provenance's basis — not
        once for the whole bucket with a selected basis. This is the
        algebraic completion of the merge case: provenance survives in
        storage AND continues to drive its own kernel call.
        """
        from runner.bucket_transition import BucketSourceBasis
        from runner.span_kernel import _build_span_topology
        from runner.timing_span import _run_dp_density_trace_from_seed

        T = 8
        S = 1
        # Extend the diamond with a tail z → w so the merge bucket at
        # z[0] has a downstream edge whose kernel-provider calls we can
        # inspect.
        graph = _make_graph(
            ['x', 'm1', 'm2', 'z', 'w'],
            [
                _make_edge('x', 'm1', 1.0, mu=0.0, sigma=0.001),
                _make_edge('x', 'm2', 1.0, mu=0.0, sigma=0.001),
                _make_edge('m1', 'z', 1.0, mu=0.0, sigma=0.001),
                _make_edge('m2', 'z', 1.0, mu=0.0, sigma=0.001),
                _make_edge('z', 'w', 1.0, mu=0.0, sigma=0.001),
            ],
        )
        topo = _build_span_topology(graph, 'x', 'w')

        # m1→z deposits basis POINT_AT_ENDPOINT at z[0]; m2→z deposits
        # basis BUCKET_DISTRIBUTED at z[0]. The downstream z→w edge
        # should fire twice from z[0] — once per source provenance —
        # with each provenance's basis.
        out_basis_by_edge = {
            'x->m1#0': BucketSourceBasis.POINT_AT_ENDPOINT,
            'x->m2#0': BucketSourceBasis.POINT_AT_ENDPOINT,
            'm1->z#0': BucketSourceBasis.POINT_AT_ENDPOINT,
            'm2->z#0': BucketSourceBasis.BUCKET_DISTRIBUTED,
            'z->w#0': BucketSourceBasis.POINT_AT_ENDPOINT,
        }
        # Call log: (edge_key, source_index, source_basis_int).
        call_log: list[tuple[str, int, int]] = []

        def provider(ce, source_index, cohort_index, source_basis):
            call_log.append((ce.edge_key, int(source_index), int(source_basis)))
            kernel = np.zeros((S, T), dtype=np.float64)
            kernel[:, 0] = 1.0
            return kernel, out_basis_by_edge[ce.edge_key]

        root_density = np.zeros((S, T), dtype=np.float64)
        root_density[:, 0] = 1.0
        from runner.timing_span import DPExecutionPolicy
        _trace = _run_dp_density_trace_from_seed(
            topo,
            provider,
            root_density,
            S,
            T,
            execution_policy=DPExecutionPolicy.SCALAR,
        )

        # The downstream z→w edge must have been called from source
        # column 0 once per *source provenance* at z[0]. Both source
        # bases must appear in the call set — no collapse to a single
        # selected basis.
        zw_calls = {
            (src_index, src_basis)
            for (edge_key, src_index, src_basis) in call_log
            if edge_key == 'z->w#0'
        }
        assert (0, int(BucketSourceBasis.POINT_AT_ENDPOINT)) in zw_calls
        assert (0, int(BucketSourceBasis.BUCKET_DISTRIBUTED)) in zw_calls

    def test_single_edge_consuming_mixed_basis_lands_distinct_destination_provenances(self):
        """When ONE edge consumes a source column carrying provenances
        with multiple bases AND the edge passes source basis through
        (non-latent), the edge must produce multiple destination
        provenances — one per output basis — so the next hop continues
        each contribution under its own basis. Storing all of the edge's
        destination mass under a single ``ce.edge_key`` with a single
        ``out_basis`` would collapse the mixed-basis state after the
        first downstream step (last-write-wins on ``out_basis``) and
        defeat the per-provenance algebra for any continuation.
        """
        from runner.bucket_transition import BucketSourceBasis
        from runner.span_kernel import _build_span_topology
        from runner.timing_span import _run_dp_density_trace_from_seed

        T = 6
        S = 1
        # Two-hop chain: a → b → c. The seed at ``a`` is split into two
        # synthetic provenances at column 0 with distinct bases (mocking
        # the state a carrier→subject handoff could deliver). Edge a→b
        # is the non-latent passthrough — its provider returns
        # ``out_basis = source_basis``. Edge b→c is then asked to
        # continue from b[0]; each source provenance at b[0] should drive
        # its own kernel call.
        graph = _make_graph(
            ['a', 'b', 'c'],
            [
                _make_edge('a', 'b', 1.0, mu=0.0, sigma=0.001),
                _make_edge('b', 'c', 1.0, mu=0.0, sigma=0.001),
            ],
        )
        topo = _build_span_topology(graph, 'a', 'c')

        call_log: list[tuple[str, int, int]] = []

        def provider(ce, source_index, cohort_index, source_basis):
            call_log.append((ce.edge_key, int(source_index), int(source_basis)))
            kernel = np.zeros((S, T), dtype=np.float64)
            kernel[:, 0] = 1.0
            # a→b is the passthrough; b→c writes a fixed basis so we can
            # tell the test result depends on continuation, not just on
            # ``out_basis`` selection.
            if ce.edge_key == 'a->b#0':
                return kernel, source_basis
            return kernel, BucketSourceBasis.BUCKET_DISTRIBUTED

        # Seed at ``a`` col 0 with two distinct-basis provenances.
        mass = np.array([0.4], dtype=np.float64)
        root_provenance_mass = {
            0: {
                'origin_alpha': mass.copy(),
                'origin_beta': mass.copy(),
            },
        }
        root_provenance_basis = {
            0: {
                'origin_alpha': int(BucketSourceBasis.POINT_AT_ENDPOINT),
                'origin_beta': int(BucketSourceBasis.BUCKET_DISTRIBUTED),
            },
        }
        root_density = np.zeros((S, T), dtype=np.float64)
        root_density[:, 0] = float(mass[0]) * 2

        from runner.timing_span import (
            DPExecutionPolicy,
            _run_dp_density_trace_from_provenance_seed,
        )
        trace = _run_dp_density_trace_from_provenance_seed(
            topo,
            provider,
            root_provenance_mass=root_provenance_mass,
            root_provenance_basis=root_provenance_basis,
            S=S,
            T=T,
            execution_policy=DPExecutionPolicy.SCALAR,
        )

        # Edge a→b consumed mixed basis at a[0]. Its destination b[0]
        # must hold TWO distinct provenance entries — one per output
        # basis — not a single ``a->b#0`` entry collapsed to a single
        # last-wins ``out_basis``.
        b_provenance = trace.node_basis_by_node_bucket['b'][0]
        b_mass = trace.node_mass_by_provenance['b'][0]
        assert len(b_provenance) == 2, (
            f"expected two destination provenances at b[0] (one per "
            f"output basis); got {list(b_provenance.keys())}"
        )
        assert set(b_provenance.values()) == {
            int(BucketSourceBasis.POINT_AT_ENDPOINT),
            int(BucketSourceBasis.BUCKET_DISTRIBUTED),
        }, (
            f"both source bases must survive to b[0] as distinct output "
            f"bases; got {dict(b_provenance)}"
        )
        # Mass must be partitioned, not duplicated.
        np.testing.assert_allclose(
            sum(b_mass.values()), 2 * mass, atol=1e-12,
        )

        # The continuation: edge b→c must fire from b[0] under BOTH
        # bases — each destination provenance drives its own kernel
        # call.
        bc_calls = {
            (src_index, src_basis)
            for (edge_key, src_index, src_basis) in call_log
            if edge_key == 'b->c#0'
        }
        assert (0, int(BucketSourceBasis.POINT_AT_ENDPOINT)) in bc_calls, (
            f"b→c must be called with POINT_AT_ENDPOINT (the basis the "
            f"non-latent a→b passed through from origin_alpha); got {bc_calls}"
        )
        assert (0, int(BucketSourceBasis.BUCKET_DISTRIBUTED)) in bc_calls, (
            f"b→c must be called with BUCKET_DISTRIBUTED (the basis the "
            f"non-latent a→b passed through from origin_beta); got {bc_calls}"
        )

    def test_carrier_to_subject_handoff_preserves_mixed_basis_via_per_bucket_seed(self):
        """The carrier → subject handoff in the model spine must preserve
        mixed basis across the join. The downstream DP accepts a per-
        bucket per-provenance seed (``root_provenance_mass`` +
        ``root_provenance_basis``) rather than a collapsed ``(T,)`` basis
        array; each provenance the carrier delivered at the join must
        drive its own kernel call in the subject DP's first hop. A
        collapsed flat-basis seed would force last-write-wins at the
        handoff — the historical bug the user identified at
        model_span_spine.
        """
        from runner.bucket_transition import BucketSourceBasis
        from runner.span_kernel import _build_span_topology
        from runner.timing_span import _run_dp_density_trace_from_seed

        T = 8
        S = 1
        # Subject span: a → b. The carrier delivered TWO provenances at
        # ``a`` (the subject's root) at column 0 with different bases.
        # The subject's first edge a→b must fire once per source
        # provenance — proof that the per-bucket seed handoff replaces
        # the legacy ``root_basis=(T,)`` flat collapse.
        graph = _make_graph(
            ['a', 'b'],
            [_make_edge('a', 'b', 1.0, mu=0.0, sigma=0.001)],
        )
        topo = _build_span_topology(graph, 'a', 'b')

        call_log: list[tuple[str, int, int]] = []

        def provider(ce, source_index, cohort_index, source_basis):
            call_log.append((ce.edge_key, int(source_index), int(source_basis)))
            kernel = np.zeros((S, T), dtype=np.float64)
            kernel[:, 0] = 1.0
            return kernel, BucketSourceBasis.BUCKET_DISTRIBUTED

        # Synthetic carrier-terminal state: two provenances at column 0
        # with distinct bases. The legacy flat-basis seed could only
        # carry ONE basis at column 0; the per-bucket seed carries both
        # as separate entries and the DP iterates each with its own
        # basis.
        carrier_mass = np.array([0.4], dtype=np.float64)
        root_provenance_mass = {
            0: {
                'carrier_edge_alpha': carrier_mass.copy(),
                'carrier_edge_beta': carrier_mass.copy(),
            },
        }
        root_provenance_basis = {
            0: {
                'carrier_edge_alpha': int(BucketSourceBasis.POINT_AT_ENDPOINT),
                'carrier_edge_beta': int(BucketSourceBasis.BUCKET_DISTRIBUTED),
            },
        }
        # ``root_density`` is supplied for shape compatibility; the DP
        # uses the per-bucket maps as canonical when both are present.
        root_density = np.zeros((S, T), dtype=np.float64)
        root_density[:, 0] = carrier_mass[0] * 2  # sum across provenances

        from runner.timing_span import (
            DPExecutionPolicy,
            _run_dp_density_trace_from_provenance_seed,
        )
        _trace = _run_dp_density_trace_from_provenance_seed(
            topo,
            provider,
            root_provenance_mass=root_provenance_mass,
            root_provenance_basis=root_provenance_basis,
            S=S,
            T=T,
            execution_policy=DPExecutionPolicy.SCALAR,
        )

        # The subject's first hop a→b was called from source col 0
        # under BOTH source bases the carrier delivered — proof that
        # mixed basis survived the handoff and each provenance drove
        # its own kernel call.
        ab_calls = {
            (src_index, src_basis)
            for (edge_key, src_index, src_basis) in call_log
            if edge_key == 'a->b#0'
        }
        assert (0, int(BucketSourceBasis.POINT_AT_ENDPOINT)) in ab_calls
        assert (0, int(BucketSourceBasis.BUCKET_DISTRIBUTED)) in ab_calls
        # The subject root's provenance ledger reflects the carrier's
        # provenance keys — not a synthesised seed marker. The handoff
        # is contribution-preserving.
        a_provenance = _trace.node_basis_by_node_bucket['a'][0]
        assert a_provenance['carrier_edge_alpha'] == int(
            BucketSourceBasis.POINT_AT_ENDPOINT,
        )
        assert a_provenance['carrier_edge_beta'] == int(
            BucketSourceBasis.BUCKET_DISTRIBUTED,
        )


class TestCanonicalLedgerInputCore:
    """Atom 4c.A — the canonical ledger-input DP core.

    ``_run_dp_density_trace_from_ledger`` is the single DP algebra. The
    root-seeded adapter (``_run_dp_density_trace_from_seed``) and the
    FC continuation are both adapters that present caller-natural
    inputs in this shape. These tests pin the canonical core's
    properties directly, decoupled from the adapters that wrap it.
    """

    def test_root_seed_adapter_matches_canonical_call_at_topology_root(self):
        """The root-seeded adapter must be equivalent to building a
        topology-root ledger and calling the canonical core directly.
        Proves the refactor is purely structural: the adapter is the
        seed-to-ledger translation, not a separate DP.
        """
        from runner.bucket_transition import BucketSourceBasis
        from runner.span_kernel import _build_span_topology
        from runner.timing_span import (
            DPExecutionPolicy,
            _run_dp_density_trace_from_ledger,
            _run_dp_density_trace_from_seed,
            SEED_ORIGIN_KEY,
        )

        T = 6
        S = 1
        graph = _make_graph(
            ['a', 'b', 'c'],
            [
                _make_edge('a', 'b', 1.0, mu=0.0, sigma=0.001),
                _make_edge('b', 'c', 1.0, mu=0.0, sigma=0.001),
            ],
        )
        topo = _build_span_topology(graph, 'a', 'c')

        def provider(ce, source_index, cohort_index, source_basis):
            kernel = np.zeros((S, T), dtype=np.float64)
            kernel[:, 0] = 1.0
            return kernel, BucketSourceBasis.BUCKET_DISTRIBUTED

        root_density = np.zeros((S, T), dtype=np.float64)
        root_density[:, 0] = 1.0

        # Path 1: the root-seeded adapter.
        trace_adapter = _run_dp_density_trace_from_seed(
            topo, provider, root_density, S, T,
            execution_policy=DPExecutionPolicy.SCALAR,
        )
        # Path 2: build the equivalent topology-root ledger and call
        # the canonical core directly. The adapter does exactly this
        # translation internally; this asserts the translation is the
        # only thing it does.
        ledger_mass = {
            topo.x_node_id: {
                0: {SEED_ORIGIN_KEY: np.array([1.0], dtype=np.float64)},
            },
        }
        ledger_basis = {
            topo.x_node_id: {
                0: {SEED_ORIGIN_KEY: int(BucketSourceBasis.POINT_AT_ENDPOINT)},
            },
        }
        trace_canonical = _run_dp_density_trace_from_ledger(
            topo, provider,
            initial_node_provenance_mass=ledger_mass,
            initial_node_provenance_basis=ledger_basis,
            S=S, T=T,
            execution_policy=DPExecutionPolicy.SCALAR,
        )

        for node in topo.on_path:
            np.testing.assert_array_equal(
                trace_adapter.node_density(node),
                trace_canonical.node_density(node),
                err_msg=f'node_density disagreement at {node}',
            )

    def test_non_root_seed_propagates_only_from_seeded_node(self):
        """The canonical core must accept a seed at any on-path node,
        not just the topology root. Seeding only an intermediate node
        and leaving the root empty must produce zero density at the
        root (no upstream contribution) and the seeded mass propagated
        from the intermediate to the terminal. This is the new
        capability atom 4c.A introduces — the FC continuation feeds
        frontier occupancy at non-root nodes.
        """
        from runner.bucket_transition import BucketSourceBasis
        from runner.span_kernel import _build_span_topology
        from runner.timing_span import (
            DPExecutionPolicy,
            _run_dp_density_trace_from_ledger,
            SEED_ORIGIN_KEY,
        )

        T = 6
        S = 1
        graph = _make_graph(
            ['a', 'b', 'c'],
            [
                _make_edge('a', 'b', 1.0, mu=0.0, sigma=0.001),
                _make_edge('b', 'c', 1.0, mu=0.0, sigma=0.001),
            ],
        )
        topo = _build_span_topology(graph, 'a', 'c')

        def provider(ce, source_index, cohort_index, source_basis):
            kernel = np.zeros((S, T), dtype=np.float64)
            kernel[:, 0] = 1.0
            return kernel, BucketSourceBasis.BUCKET_DISTRIBUTED

        # Seed at ``b`` col 2 only; ``a`` is intentionally absent from
        # the ledger. The DP should fire b→c (from b's source bucket)
        # and NOT fire a→b (a has no mass).
        seed_mass = np.array([0.7], dtype=np.float64)
        ledger_mass = {
            'b': {
                2: {SEED_ORIGIN_KEY: seed_mass.copy()},
            },
        }
        ledger_basis = {
            'b': {
                2: {SEED_ORIGIN_KEY: int(BucketSourceBasis.POINT_AT_ENDPOINT)},
            },
        }
        trace = _run_dp_density_trace_from_ledger(
            topo, provider,
            initial_node_provenance_mass=ledger_mass,
            initial_node_provenance_basis=ledger_basis,
            S=S, T=T,
            execution_policy=DPExecutionPolicy.SCALAR,
        )

        # Root ``a`` has no seed and no incoming edges on-path — its
        # density must be all zero.
        np.testing.assert_array_equal(
            trace.node_density('a'),
            np.zeros((S, T), dtype=np.float64),
        )
        # ``b`` carries the seeded mass at bucket 2 only; no upstream
        # arrival is visible because ``a`` had no mass to deliver.
        np.testing.assert_allclose(
            trace.node_density('b')[:, 2], seed_mass, atol=1e-12,
        )
        b_density = trace.node_density('b')
        b_other = np.delete(b_density, 2, axis=1)
        np.testing.assert_array_equal(
            b_other, np.zeros_like(b_other),
            err_msg='b must carry mass only at the seeded bucket',
        )
        # Terminal ``c`` receives the seeded mass through b→c. The
        # synthetic Dirac kernel writes ``kernel[:, 0] = 1`` (relative
        # offset 0), so the mass lands at destination column
        # ``source_index + 0 = 2``.
        np.testing.assert_allclose(
            trace.node_density('c')[:, 2], seed_mass, atol=1e-12,
        )

    def test_multi_node_seed_superposes_linearly(self):
        """The DP is linear in the input ledger. Seeding two nodes
        simultaneously must produce output equal to the sum of two
        single-node-seed runs. This is the structural property the FC
        continuation relies on: carrier-side and subject-side
        frontier-occupancy seeds at distinct nodes superpose into
        independent continuation surfaces inside one DP pass.
        """
        from runner.bucket_transition import BucketSourceBasis
        from runner.span_kernel import _build_span_topology
        from runner.timing_span import (
            DPExecutionPolicy,
            _run_dp_density_trace_from_ledger,
            SEED_ORIGIN_KEY,
        )

        T = 6
        S = 1
        graph = _make_graph(
            ['a', 'b', 'c'],
            [
                _make_edge('a', 'b', 1.0, mu=0.0, sigma=0.001),
                _make_edge('b', 'c', 1.0, mu=0.0, sigma=0.001),
            ],
        )
        topo = _build_span_topology(graph, 'a', 'c')

        def provider(ce, source_index, cohort_index, source_basis):
            kernel = np.zeros((S, T), dtype=np.float64)
            kernel[:, 0] = 1.0
            return kernel, BucketSourceBasis.BUCKET_DISTRIBUTED

        basis_int = int(BucketSourceBasis.POINT_AT_ENDPOINT)
        mass_a = np.array([0.5], dtype=np.float64)
        mass_b = np.array([0.3], dtype=np.float64)

        def _seed(node_mass_map):
            return (
                {
                    n: {
                        col: {SEED_ORIGIN_KEY: m.copy()}
                        for col, m in cols.items()
                    }
                    for n, cols in node_mass_map.items()
                },
                {
                    n: {col: {SEED_ORIGIN_KEY: basis_int} for col in cols}
                    for n, cols in node_mass_map.items()
                },
            )

        # Seed at ``a`` col 0 only.
        a_mass_map, a_basis_map = _seed({'a': {0: mass_a}})
        trace_a = _run_dp_density_trace_from_ledger(
            topo, provider,
            initial_node_provenance_mass=a_mass_map,
            initial_node_provenance_basis=a_basis_map,
            S=S, T=T,
            execution_policy=DPExecutionPolicy.SCALAR,
        )
        # Seed at ``b`` col 1 only.
        b_mass_map, b_basis_map = _seed({'b': {1: mass_b}})
        trace_b = _run_dp_density_trace_from_ledger(
            topo, provider,
            initial_node_provenance_mass=b_mass_map,
            initial_node_provenance_basis=b_basis_map,
            S=S, T=T,
            execution_policy=DPExecutionPolicy.SCALAR,
        )
        # Combined seed at both nodes.
        combined_mass_map, combined_basis_map = _seed(
            {'a': {0: mass_a}, 'b': {1: mass_b}},
        )
        trace_combined = _run_dp_density_trace_from_ledger(
            topo, provider,
            initial_node_provenance_mass=combined_mass_map,
            initial_node_provenance_basis=combined_basis_map,
            S=S, T=T,
            execution_policy=DPExecutionPolicy.SCALAR,
        )

        for node in topo.on_path:
            np.testing.assert_allclose(
                trace_combined.node_density(node),
                trace_a.node_density(node) + trace_b.node_density(node),
                atol=1e-12,
                err_msg=f'linearity violated at {node}',
            )
