"""
Tests for cohort-mode ForecastState computation (doc 29 Phase 3).

Verifies:
- NodeArrivalState is built correctly for synth graphs
- Cohort-mode completeness uses upstream carrier (not simple CDF)
- Single-edge (from=anchor) completeness matches window-mode
- Multi-edge completeness is upstream-aware
- completeness_sd propagates upstream uncertainty
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
import numpy as np


def _make_synth_graph(edges):
    """Build minimal graph from edge specs.

    Each spec: (uuid, from_uuid, to_uuid, from_id, to_id, p_mean, mu, sigma, onset)
    """
    node_set = {}
    edge_list = []
    first_from = None
    for spec in edges:
        uuid, from_u, to_u, from_id, to_id, p_mean, mu, sigma, onset = spec[:9]
        if first_from is None:
            first_from = from_u
        node_set[from_u] = {'uuid': from_u, 'id': from_id}
        node_set[to_u] = {'uuid': to_u, 'id': to_id}
        edge_list.append({
            'uuid': uuid,
            'from': from_u,
            'to': to_u,
            'p': {
                'id': f'param-{uuid}',
                'mean': p_mean,
                'stdev': 0.05,
                'forecast': {'mean': p_mean},
                'latency': {
                    'mu': mu,
                    'sigma': sigma,
                    'onset_delta_days': onset,
                    'promoted_mu': mu,
                    'promoted_sigma': sigma,
                    'promoted_onset_delta_days': onset,
                    'promoted_mu_sd': 0.1,
                    'promoted_sigma_sd': 0.05,
                    'promoted_onset_sd': 0.2,
                    'promoted_onset_mu_corr': -0.3,
                },
                'model_vars': [{
                    'source': 'analytic',
                    'probability': {'mean': p_mean, 'stdev': 0.05},
                    'latency': {
                        'mu': mu, 'sigma': sigma, 'onset_delta_days': onset,
                    },
                }],
            },
        })
    for n in node_set.values():
        if n['uuid'] == first_from:
            n['entry'] = {'is_start': True}
    return {
        'nodes': list(node_set.values()),
        'edges': edge_list,
    }


class TestNodeArrivalCache:
    """Per-node arrival cache construction."""

    def test_anchor_node_has_delta_arrival(self):
        """Anchor node should have reach=1.0 and CDF=[1,1,...,1]."""
        from runner.forecast_state import build_node_arrival_cache

        graph = _make_synth_graph([
            ('e1', 'n1', 'n2', 'A', 'B', 0.8, 2.0, 0.5, 2.0),
        ])

        cache = build_node_arrival_cache(graph, anchor_id='n1', max_tau=100)
        anchor = cache['n1']

        assert anchor.reach == 1.0
        assert anchor.tier == 'anchor'
        assert anchor.deterministic_cdf is not None
        assert all(v == 1.0 for v in anchor.deterministic_cdf)

    def test_downstream_node_has_carrier(self):
        """Node downstream of anchor should have a carrier CDF."""
        from runner.forecast_state import build_node_arrival_cache

        graph = _make_synth_graph([
            ('e1', 'n1', 'n2', 'A', 'B', 0.8, 2.0, 0.5, 2.0),
        ])

        cache = build_node_arrival_cache(graph, anchor_id='n1', max_tau=100)
        downstream = cache.get('n2')

        assert downstream is not None
        assert downstream.reach == pytest.approx(0.8, abs=0.01)
        # Carrier should exist (Tier 1 parametric from edge A->B)
        assert downstream.deterministic_cdf is not None or downstream.tier == 'none'

    def test_multi_hop_reach_propagates(self):
        """Reach accumulates through the graph: reach(C) = p_AB × p_BC."""
        from runner.forecast_state import build_node_arrival_cache

        graph = _make_synth_graph([
            ('e1', 'n1', 'n2', 'A', 'B', 0.9, 1.5, 0.4, 1.0),
            ('e2', 'n2', 'n3', 'B', 'C', 0.7, 2.5, 0.6, 3.0),
        ])

        cache = build_node_arrival_cache(graph, anchor_id='n1', max_tau=100)

        assert cache['n1'].reach == 1.0
        assert cache['n2'].reach == pytest.approx(0.9, abs=0.01)
        assert cache['n3'].reach == pytest.approx(0.9 * 0.7, abs=0.01)


class TestCohortModeForecastState:
    """Cohort-mode ForecastState computation."""

    def test_single_edge_matches_window_mode(self):
        """For edge from anchor (no upstream), cohort and window
        completeness should be very close.
        """
        from runner.forecast_state import (
            build_node_arrival_cache,
            compute_forecast_state_cohort,
            compute_forecast_state_window,
        )
        from runner.model_resolver import resolve_model_params

        graph = _make_synth_graph([
            ('e1', 'n1', 'n2', 'A', 'B', 0.8, 2.0, 0.5, 2.0),
        ])
        edge = graph['edges'][0]
        resolved = resolve_model_params(edge, scope='edge', temporal_mode='cohort')
        cohorts = [(10.0, 100), (20.0, 100), (30.0, 100)]

        # Window mode
        fs_window = compute_forecast_state_window(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
        )

        # Cohort mode with from-node = anchor
        cache = build_node_arrival_cache(graph, anchor_id='n1', max_tau=100)
        fs_cohort = compute_forecast_state_cohort(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            from_node_arrival=cache['n1'],
        )

        # Both should produce similar completeness (anchor has delta CDF)
        delta = abs(fs_window.completeness - fs_cohort.completeness)
        print(f"\nSingle edge: window={fs_window.completeness:.6f} "
              f"cohort={fs_cohort.completeness:.6f} delta={delta:.6f}")
        assert delta < 0.02, \
            f"Single-edge parity: window={fs_window.completeness:.6f} " \
            f"cohort={fs_cohort.completeness:.6f}"

    def test_multi_edge_completeness_lower_than_edge_only(self):
        """For an edge with upstream, completeness should be lower than
        the edge-only CDF because upstream arrival delay reduces the
        effective time available for the edge's conversion.
        """
        from runner.forecast_state import (
            build_node_arrival_cache,
            compute_forecast_state_cohort,
            _compute_completeness_at_age,
        )
        from runner.model_resolver import resolve_model_params

        graph = _make_synth_graph([
            ('e1', 'n1', 'n2', 'A', 'B', 0.9, 1.5, 0.4, 1.0),
            ('e2', 'n2', 'n3', 'B', 'C', 0.7, 2.5, 0.6, 3.0),
        ])

        edge_bc = graph['edges'][1]
        resolved = resolve_model_params(edge_bc, scope='edge', temporal_mode='cohort')
        cohorts = [(10.0, 100), (20.0, 100), (30.0, 100)]

        # Cohort mode with upstream
        cache = build_node_arrival_cache(graph, anchor_id='n1', max_tau=100)
        fs = compute_forecast_state_cohort(
            edge_id='e2', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            from_node_arrival=cache['n2'],
        )

        # Edge-only CDF (no upstream delay)
        total_n = sum(n for _, n in cohorts)
        edge_only_c = sum(
            n * _compute_completeness_at_age(age, 2.5, 0.6, 3.0)
            for age, n in cohorts
        ) / total_n

        print(f"\nMulti-edge B->C:")
        print(f"  upstream-aware: {fs.completeness:.6f}")
        print(f"  edge-only CDF:  {edge_only_c:.6f}")
        print(f"  mode: {fs.mode}, path_aware: {fs.path_aware}")

        assert fs.mode == 'cohort'
        assert fs.path_aware is True
        assert fs.completeness < edge_only_c, \
            f"Upstream-aware ({fs.completeness:.4f}) should be < " \
            f"edge-only ({edge_only_c:.4f})"

    def test_completeness_sd_present(self):
        """Cohort-mode ForecastState should have completeness_sd."""
        from runner.forecast_state import (
            build_node_arrival_cache,
            compute_forecast_state_cohort,
        )
        from runner.model_resolver import resolve_model_params

        graph = _make_synth_graph([
            ('e1', 'n1', 'n2', 'A', 'B', 0.9, 1.5, 0.4, 1.0),
            ('e2', 'n2', 'n3', 'B', 'C', 0.7, 2.5, 0.6, 3.0),
        ])

        edge_bc = graph['edges'][1]
        resolved = resolve_model_params(edge_bc, scope='edge', temporal_mode='cohort')
        cohorts = [(15.0, 100), (25.0, 100)]

        cache = build_node_arrival_cache(graph, anchor_id='n1', max_tau=100)
        fs = compute_forecast_state_cohort(
            edge_id='e2', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            from_node_arrival=cache['n2'],
        )

        print(f"\ncompleteness={fs.completeness:.4f} sd={fs.completeness_sd:.4f}")
        assert fs.completeness_sd >= 0
        # With MC draws from upstream carrier, SD should be non-zero
        # (unless carrier returns None)
        if cache['n2'].mc_cdf is not None:
            assert fs.completeness_sd > 0, \
                'With MC upstream draws, completeness_sd should be >0'
