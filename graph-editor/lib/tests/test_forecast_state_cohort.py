"""
Tests for forecast engine components (doc 29 Phase 3 + G.3).

Verifies:
- NodeArrivalState is built correctly for synth graphs
- Carrier convolution properties (_convolve_completeness_at_age)
- compute_forecast_trajectory blend semantics + runtime-bundle wiring
"""

import copy
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
import numpy as np

from conftest import load_graph_json, requires_data_repo, requires_db, requires_synth


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


def _phase1_expected_carrier_mode(
    *,
    mode: str,
    anchor_node_id: str | None,
    query_from_node: str,
    upstream_segment_is_latent: bool,
) -> str:
    """Disposable Phase-1 oracle for carrier identity classification.

    This deliberately tiny oracle exists to drive doc 66's witness tests.
    It answers only the Phase-1 question: should `carrier_to_x` be the
    identity, or a real upstream carrier?
    """
    if mode == 'window':
        return 'identity'
    if not anchor_node_id or anchor_node_id == query_from_node:
        return 'identity'
    return 'upstream' if upstream_segment_is_latent else 'identity'


def _node_id_map(graph):
    return {
        str(node.get('uuid') or node.get('id') or ''): str(node.get('id') or node.get('uuid') or '')
        for node in graph.get('nodes', [])
    }


def _find_unique_outgoing_edge(graph, from_node_id: str):
    nmap = _node_id_map(graph)
    matches = [
        edge
        for edge in graph.get('edges', [])
        if nmap.get(str(edge.get('from') or ''), str(edge.get('from') or '')) == from_node_id
        and bool((edge.get('p') or {}).get('id'))
    ]
    assert len(matches) == 1, (
        f"Expected exactly one outgoing edge from {from_node_id}, "
        f"found {len(matches)}."
    )
    return matches[0]


def _has_direct_edge(graph, from_node_id: str, to_node_id: str) -> bool:
    nmap = _node_id_map(graph)
    return any(
        nmap.get(str(edge.get('from') or ''), str(edge.get('from') or '')) == from_node_id
        and nmap.get(str(edge.get('to') or ''), str(edge.get('to') or '')) == to_node_id
        for edge in graph.get('edges', [])
    )


def _build_phase1_runtime_bundle_for_graph(
    *,
    graph_name: str,
    mode: str,
    anchor_node_id: str,
    query_from_node: str,
    query_to_node: str,
):
    from runner.forecast_runtime import (
        build_prepared_runtime_bundle,
        build_x_provider_from_graph,
        serialise_runtime_bundle,
    )

    graph = load_graph_json(graph_name)
    is_window = mode == 'window'
    x_provider = None
    if not is_window and anchor_node_id != query_from_node:
        carrier_edge = _find_unique_outgoing_edge(graph, query_from_node)
        x_provider = build_x_provider_from_graph(
            graph,
            carrier_edge,
            anchor_node_id,
            is_window=False,
        )

    runtime_bundle = build_prepared_runtime_bundle(
        mode=mode,
        query_from_node=query_from_node,
        query_to_node=query_to_node,
        anchor_node_id=anchor_node_id,
        is_multi_hop=not _has_direct_edge(graph, query_from_node, query_to_node),
        x_provider=x_provider,
        numerator_representation='factorised',
        p_conditioning_temporal_family='window' if is_window else 'cohort',
        p_conditioning_source='phase1_test',
    )
    return runtime_bundle, serialise_runtime_bundle(runtime_bundle), x_provider


class TestForecastRuntimeIngressOrdering:
    """WP6 guard: ingress preparation must ignore incidental edge order."""

    @staticmethod
    def _make_fan_in_graph():
        return _make_synth_graph([
            ('e-a-c', 'u-a', 'u-c', 'A', 'C', 0.35, 1.1, 0.25, 0.0),
            ('e-b-c', 'u-b', 'u-c', 'B', 'C', 0.65, 1.6, 0.35, 0.0),
            ('e-c-d', 'u-c', 'u-d', 'C', 'D', 0.5, 2.0, 0.45, 0.0),
        ])

    def test_get_incoming_edges_is_stable_under_edge_reorder(self):
        from runner.forecast_runtime import get_incoming_edges

        graph = self._make_fan_in_graph()
        reordered = copy.deepcopy(graph)
        reordered['edges'] = list(reversed(reordered['edges']))

        baseline = [edge['uuid'] for edge in get_incoming_edges(graph, 'C')]
        reversed_order = [edge['uuid'] for edge in get_incoming_edges(reordered, 'C')]

        assert baseline == ['e-a-c', 'e-b-c']
        assert reversed_order == baseline

    def test_x_provider_upstream_params_are_stable_under_edge_reorder(self):
        from runner.forecast_runtime import (
            build_x_provider_from_graph,
            find_edge_by_id,
        )

        graph = self._make_fan_in_graph()
        reordered = copy.deepcopy(graph)
        reordered['edges'] = list(reversed(reordered['edges']))

        baseline = build_x_provider_from_graph(
            graph,
            find_edge_by_id(graph, 'e-c-d'),
            anchor_node_id='A',
            is_window=False,
        )
        reversed_order = build_x_provider_from_graph(
            reordered,
            find_edge_by_id(reordered, 'e-c-d'),
            anchor_node_id='A',
            is_window=False,
        )

        def _project(provider):
            return [
                (params['p'], params['mu'], params['sigma'], params['onset'])
                for params in provider.upstream_params_list
            ]

        assert baseline.enabled is True
        assert reversed_order.enabled is True
        assert baseline.reach == pytest.approx(reversed_order.reach)
        assert _project(reversed_order) == _project(baseline)

    def test_prepare_runtime_inputs_uses_robust_x_provider_when_upstream_mean_is_zero(self):
        from runner.forecast_runtime import prepare_forecast_runtime_inputs

        graph = _make_synth_graph([
            ('e-a-b', 'u-a', 'u-b', 'A', 'B', 0.0, 1.1, 0.25, 0.0),
            ('e-b-c', 'u-b', 'u-c', 'B', 'C', 0.6, 2.0, 0.45, 0.0),
        ])
        graph['edges'][0]['p']['mean'] = 0.0
        graph['edges'][0]['p']['model_vars'][0]['probability']['mean'] = 0.8
        graph['model_source_preference'] = 'analytic'

        prepared = prepare_forecast_runtime_inputs(
            graph_data=graph,
            query_from_node='B',
            query_to_node='C',
            anchor_node_id='A',
            last_edge_id='e-b-c',
            is_window=False,
            is_multi_hop=False,
            composed_frames=[{
                'snapshot_date': '2026-01-01',
                'data_points': [],
            }],
        )

        assert prepared.x_provider is not None
        assert prepared.x_provider.enabled is True
        assert prepared.x_provider.reach == pytest.approx(0.8)


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


# ── Enriched synth graph loading ─────────────────────────────────────

from pathlib import Path

_DAGNET_ROOT = Path(__file__).parent.parent.parent.parent
_CONF_FILE = _DAGNET_ROOT / '.private-repos.conf'
_DATA_REPO_DIR = None
if _CONF_FILE.exists():
    for line in _CONF_FILE.read_text().splitlines():
        if line.startswith('DATA_REPO_DIR='):
            _DATA_REPO_DIR = _DAGNET_ROOT / line.split('=', 1)[1].strip()
            break


def _has_enriched_synth():
    """Check if synth-simple-abc has been enriched with model_vars."""
    if _DATA_REPO_DIR is None:
        return False
    gp = _DATA_REPO_DIR / 'graphs' / 'synth-simple-abc.json'
    if not gp.exists():
        return False
    import json
    g = json.loads(gp.read_text())
    for e in g.get('edges', []):
        mv = (e.get('p') or {}).get('model_vars', [])
        if any(m.get('source') == 'bayesian' for m in mv):
            return True
    return False


requires_enriched_synth = pytest.mark.skipif(
    not _has_enriched_synth(),
    reason='synth-simple-abc not enriched (run test_harness.py --graph synth-simple-abc --enrich)',
)


def _load_synth_graph():
    import json
    gp = _DATA_REPO_DIR / 'graphs' / 'synth-simple-abc.json'
    return json.loads(gp.read_text())


class TestScopeAndCarrierConsistency:
    """Engine must use edge-level params with carrier convolution (review #8)."""

    def test_carrier_convolution_uses_edge_params_not_path(self):
        """When carrier is present, completeness from edge-level params
        should be higher than from path-level (path already includes
        upstream delay, carrier applies it again → double-apply → lower).
        """
        from runner.forecast_state import (
            CohortEvidence,
            build_node_arrival_cache,
            compute_forecast_trajectory,
        )
        from runner.model_resolver import resolve_model_params

        graph = _load_synth_graph()
        anchor = next(n for n in graph['nodes']
                      if n.get('entry', {}).get('is_start'))
        edge_bc = next(e for e in graph['edges']
                       if e.get('p', {}).get('id') == 'simple-b-to-c')

        cache = build_node_arrival_cache(graph, anchor_id=anchor['uuid'], max_tau=200)
        from_node = cache.get(edge_bc['from'])

        resolved_edge = resolve_model_params(edge_bc, scope='edge', temporal_mode='cohort')
        resolved_path = resolve_model_params(edge_bc, scope='path', temporal_mode='cohort')

        cohorts = [
            CohortEvidence(
                obs_x=[100.0] * 21, obs_y=[0.0] * 21,
                x_frozen=100.0, y_frozen=0.0,
                frontier_age=20, a_pop=100.0, eval_age=20,
            ),
            CohortEvidence(
                obs_x=[100.0] * 31, obs_y=[0.0] * 31,
                x_frozen=100.0, y_frozen=0.0,
                frontier_age=30, a_pop=100.0, eval_age=30,
            ),
        ]

        cf_edge = compute_forecast_trajectory(
            resolved=resolved_edge, cohorts=cohorts, max_tau=60,
            from_node_arrival=from_node,
        )
        cf_path = compute_forecast_trajectory(
            resolved=resolved_path, cohorts=cohorts, max_tau=60,
            from_node_arrival=from_node,
        )

        print(f"\nEdge mu={resolved_edge.latency.mu:.3f} "
              f"Path mu={resolved_path.latency.mu:.3f}")
        print(f"Edge+carrier: {cf_edge.completeness_mean:.4f}")
        print(f"Path+carrier: {cf_path.completeness_mean:.4f} (double-apply)")

        if resolved_path.latency.mu > resolved_edge.latency.mu:
            assert cf_path.completeness_mean < cf_edge.completeness_mean, \
                "Path+carrier gives lower completeness (double upstream lag)"


class TestSubsetConditioningBlend:
    """Doc 52 §14 — engine-level subset-conditioning blend.

    Covers blend provenance and row-mix behaviour on
    `compute_forecast_trajectory` (the inner kernel that owns
    conditioned + unconditioned cohort evals).
    """

    def test_trajectory_blend_cohort_evals_populated_unconditioned(self):
        """Regression for doc 52 §14.4.1: the unconditioned cohort-loop
        pass must populate `cohort_evals` for the row-wise blend to work.

        Without this, `cohort_evals_unc` is empty, the length-mismatch
        branch takes over, and `sweep.cohort_evals` reverts to the
        conditioned-only draws — which means the BE topo pass, daily-
        conversions annotation, and latency band sweep (all of which
        read `cohort_evals[i].y_draws/x_draws`) remain uncorrected.
        """
        from runner.forecast_state import (
            compute_forecast_trajectory, CohortEvidence,
        )
        from runner.model_resolver import ResolvedModelParams, ResolvedLatency
        import numpy as np

        resolved = ResolvedModelParams(
            p_mean=0.3, p_sd=0.05,
            alpha=30.0, beta=70.0,
            alpha_pred=30.0, beta_pred=70.0,
            n_effective=100.0,
            edge_latency=ResolvedLatency(
                mu=2.0, sigma=0.5, onset_delta_days=0.0,
                mu_sd=0.1, sigma_sd=0.05,
            ),
            source='bayesian',
        )
        cohorts = [
            CohortEvidence(
                obs_x=[10.0] * 30,
                obs_y=[3.0] * 30,
                x_frozen=10.0,
                y_frozen=3.0,
                frontier_age=20,
                a_pop=10.0,
                eval_age=20,
            )
            for _ in range(6)
        ]

        sweep = compute_forecast_trajectory(
            resolved=resolved,
            cohorts=cohorts,
            max_tau=30,
        )

        # Provenance: r = 60/100 = 0.6, blend applied.
        assert sweep.blend_applied is True
        assert sweep.r == pytest.approx(0.6)
        # cohort_evals must be populated with one entry per cohort
        # (not empty — which is the failure mode we're guarding).
        assert sweep.cohort_evals is not None
        assert len(sweep.cohort_evals) == 6
        # Each entry's draws are the blended row-mix across the
        # conditioned and unconditioned passes. Draws array length = S.
        for ce in sweep.cohort_evals:
            assert ce.y_draws.shape == (sweep.rate_draws.shape[0],)
            assert ce.x_draws.shape == (sweep.rate_draws.shape[0],)
            assert np.all(np.isfinite(ce.y_draws))
            assert np.all(np.isfinite(ce.x_draws))
            assert np.all(ce.x_draws > 0)


class TestPreparedRuntimeBundle:
    """WP2 runtime-bundle plumbing for summary and trajectory kernels."""

    def test_runtime_bundle_serialises_general_conditioning_seam(self):
        from runner.forecast_runtime import (
            build_prepared_runtime_bundle,
            resolve_subject_cdf_start_node,
            serialise_runtime_bundle,
            should_use_anchor_relative_subject_cdf,
        )

        assert should_use_anchor_relative_subject_cdf(
            is_window=False,
            is_multi_hop=False,
            anchor_node_id='A',
            query_from_node='X',
        ) is False
        assert should_use_anchor_relative_subject_cdf(
            is_window=False,
            is_multi_hop=True,
            anchor_node_id='A',
            query_from_node='X',
        ) is False
        assert should_use_anchor_relative_subject_cdf(
            is_window=True,
            is_multi_hop=False,
            anchor_node_id='A',
            query_from_node='X',
        ) is False
        assert resolve_subject_cdf_start_node(
            is_window=False,
            is_multi_hop=False,
            anchor_node_id='A',
            query_from_node='X',
        ) == 'X'
        assert resolve_subject_cdf_start_node(
            is_window=False,
            is_multi_hop=True,
            anchor_node_id='A',
            query_from_node='X',
        ) == 'X'

        bundle = build_prepared_runtime_bundle(
            mode='cohort',
            query_from_node='X',
            query_to_node='Y',
            anchor_node_id='A',
            is_multi_hop=False,
            numerator_representation='factorised',
            p_conditioning_source='frame_evidence',
            p_conditioning_evidence_points=3,
            p_conditioning_total_x=120.0,
            p_conditioning_total_y=36.0,
        )
        diag = serialise_runtime_bundle(bundle)

        assert diag is not None
        assert diag['p_conditioning_evidence']['temporal_family'] == 'window'
        assert diag['p_conditioning_evidence']['source'] == 'frame_evidence'
        assert 'direct_cohort_enabled' not in diag['p_conditioning_evidence']
        assert diag['rate_evidence_provenance'] == {
            'selected_family': 'window',
            'selected_anchor_node': None,
            'admission_decision': 'denied',
            'decision_reason': 'cohort_rate_evidence_not_admitted',
        }

    def test_runtime_bundle_serialises_identity_collapse_provenance(self):
        from runner.forecast_runtime import (
            build_prepared_runtime_bundle,
            serialise_runtime_bundle,
        )

        bundle = build_prepared_runtime_bundle(
            mode='cohort',
            query_from_node='X',
            query_to_node='Y',
            anchor_node_id='X',
            is_multi_hop=False,
            numerator_representation='factorised',
            p_conditioning_temporal_family='window',
            p_conditioning_source='frame_evidence',
        )
        diag = serialise_runtime_bundle(bundle)

        assert diag is not None
        assert diag['rate_evidence_provenance'] == {
            'selected_family': 'window',
            'selected_anchor_node': None,
            'admission_decision': 'identity_collapse',
            'decision_reason': 'anchor_equals_subject_start',
        }

    def test_runtime_bundle_serialises_admitted_single_hop_provenance(self):
        from runner.forecast_runtime import (
            build_prepared_runtime_bundle,
            serialise_runtime_bundle,
        )

        bundle = build_prepared_runtime_bundle(
            mode='cohort',
            query_from_node='X',
            query_to_node='Y',
            anchor_node_id='A',
            is_multi_hop=False,
            numerator_representation='factorised',
            p_conditioning_temporal_family='cohort',
            p_conditioning_source='snapshot_frames',
        )
        diag = serialise_runtime_bundle(bundle)

        assert diag is not None
        assert diag['rate_evidence_provenance'] == {
            'selected_family': 'cohort',
            'selected_anchor_node': 'A',
            'admission_decision': 'admitted',
            'decision_reason': 'single_hop_anchor_override',
        }

    @requires_db
    @requires_data_repo
    @requires_synth("synth-simple-abc", enriched=True)
    def test_phase1_window_queries_use_identity_carrier(self):
        """Phase 1 witness: `window()` is always the identity carrier."""
        _, diag, x_provider = _build_phase1_runtime_bundle_for_graph(
            graph_name='synth-simple-abc',
            mode='window',
            anchor_node_id='simple-a',
            query_from_node='simple-a',
            query_to_node='simple-b',
        )

        assert x_provider is None
        assert diag['carrier_to_x']['mode'] == _phase1_expected_carrier_mode(
            mode='window',
            anchor_node_id='simple-a',
            query_from_node='simple-a',
            upstream_segment_is_latent=False,
        )
        assert diag['carrier_to_x']['has_x_provider'] is False
        assert diag['carrier_to_x']['reach'] == pytest.approx(1.0)

    @requires_db
    @requires_data_repo
    @requires_synth("synth-simple-abc", enriched=True)
    def test_phase1_cohort_leading_edge_uses_identity_carrier(self):
        """Phase 1 witness: `cohort()` with `A = X` must collapse."""
        _, diag, x_provider = _build_phase1_runtime_bundle_for_graph(
            graph_name='synth-simple-abc',
            mode='cohort',
            anchor_node_id='simple-a',
            query_from_node='simple-a',
            query_to_node='simple-b',
        )

        assert x_provider is None
        assert diag['carrier_to_x']['mode'] == _phase1_expected_carrier_mode(
            mode='cohort',
            anchor_node_id='simple-a',
            query_from_node='simple-a',
            upstream_segment_is_latent=False,
        )
        assert diag['carrier_to_x']['has_x_provider'] is False
        assert diag['carrier_to_x']['reach'] == pytest.approx(1.0)

    @requires_db
    @requires_data_repo
    @requires_synth("synth-mirror-4step", enriched=True)
    def test_phase1_non_latent_upstream_collapses_to_identity(self):
        """Phase 1 witness: semantically instant upstream must collapse."""
        _, diag, x_provider = _build_phase1_runtime_bundle_for_graph(
            graph_name='synth-mirror-4step',
            mode='cohort',
            anchor_node_id='m4-landing',
            query_from_node='m4-delegated',
            query_to_node='m4-success',
        )

        assert x_provider is not None
        assert x_provider.reach > 0
        assert x_provider.enabled is False
        assert x_provider.upstream_params_list == []
        assert diag['population_root'] == 'm4-landing'
        assert diag['carrier_to_x']['mode'] == _phase1_expected_carrier_mode(
            mode='cohort',
            anchor_node_id='m4-landing',
            query_from_node='m4-delegated',
            upstream_segment_is_latent=False,
        )
        assert diag['carrier_to_x']['has_x_provider'] is False

    @requires_db
    @requires_data_repo
    @requires_synth("synth-mirror-4step", enriched=True)
    def test_phase1_latent_upstream_retains_real_carrier(self):
        """Phase 1 witness: genuine upstream latency must stay real."""
        _, diag, x_provider = _build_phase1_runtime_bundle_for_graph(
            graph_name='synth-mirror-4step',
            mode='cohort',
            anchor_node_id='m4-landing',
            query_from_node='m4-registered',
            query_to_node='m4-success',
        )

        assert x_provider is not None
        assert x_provider.enabled is True
        assert x_provider.upstream_params_list
        assert diag['population_root'] == 'm4-landing'
        assert diag['carrier_to_x']['mode'] == _phase1_expected_carrier_mode(
            mode='cohort',
            anchor_node_id='m4-landing',
            query_from_node='m4-registered',
            upstream_segment_is_latent=True,
        )
        assert diag['carrier_to_x']['has_x_provider'] is True

    def test_trajectory_reads_operator_inputs_from_runtime_bundle(self):
        from runner.forecast_runtime import build_prepared_runtime_bundle
        from runner.forecast_state import CohortEvidence, compute_forecast_trajectory
        from runner.model_resolver import ResolvedLatency, ResolvedModelParams

        resolved = ResolvedModelParams(
            p_mean=0.4,
            p_sd=0.05,
            alpha=40.0,
            beta=60.0,
            alpha_pred=40.0,
            beta_pred=60.0,
            edge_latency=ResolvedLatency(mu=3.0, sigma=0.6, onset_delta_days=0.0),
            source='bayesian',
        )
        cohorts = [
            CohortEvidence(
                obs_x=[100.0] * 41,
                obs_y=[40.0] * 41,
                x_frozen=100.0,
                y_frozen=40.0,
                frontier_age=20,
                a_pop=100.0,
            ),
            CohortEvidence(
                obs_x=[80.0] * 41,
                obs_y=[28.0] * 41,
                x_frozen=80.0,
                y_frozen=28.0,
                frontier_age=15,
                a_pop=80.0,
            ),
        ]
        det_norm_cdf = [min(t / 20.0, 1.0) for t in range(41)]

        explicit = compute_forecast_trajectory(
            resolved=resolved,
            cohorts=cohorts,
            max_tau=40,
            num_draws=256,
            span_alpha=55.0,
            span_beta=45.0,
            det_norm_cdf=det_norm_cdf,
        )
        runtime_bundle = build_prepared_runtime_bundle(
            mode='window',
            query_from_node='A',
            query_to_node='B',
            resolved_params=resolved,
            p_conditioning_temporal_family='window',
            p_conditioning_source='frame_evidence',
            p_conditioning_evidence_points=len(cohorts),
            span_alpha=55.0,
            span_beta=45.0,
            det_norm_cdf=det_norm_cdf,
        )
        bundled = compute_forecast_trajectory(
            resolved=resolved,
            cohorts=cohorts,
            max_tau=40,
            num_draws=256,
            runtime_bundle=runtime_bundle,
        )

        assert np.allclose(bundled.rate_draws, explicit.rate_draws)
        assert bundled.runtime_bundle_diag is not None
        assert bundled.runtime_bundle_diag['operator_inputs']['span_alpha'] == 55.0
        assert bundled.runtime_bundle_diag['subject_span']['end_node_id'] == 'B'
