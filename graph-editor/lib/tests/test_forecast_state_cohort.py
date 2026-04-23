"""
Tests for forecast engine components (doc 29 Phase 3 + G.3).

Verifies:
- NodeArrivalState is built correctly for synth graphs
- Carrier convolution properties (_convolve_completeness_at_age)
- compute_forecast_summary graceful degradation (used by surprise gauge)

G.3 cleanup: removed TestCohortModeForecastState and
TestPhase3ParityEnrichedSynth — these tested compute_forecast_state_cohort
and compute_forecast_state_window which are retired. Parity is now
tested via v2-v3-parity-test.sh (CLI) and test_v2_v3_parity.py.
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
            build_node_arrival_cache,
            compute_forecast_summary,
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

        cohorts = [(20.0, 100), (30.0, 100)]

        cf_edge = compute_forecast_summary(
            edge_id='bc', resolved=resolved_edge,
            cohort_ages_and_weights=cohorts, evidence=[],
            from_node_arrival=from_node,
        )
        cf_path = compute_forecast_summary(
            edge_id='bc', resolved=resolved_path,
            cohort_ages_and_weights=cohorts, evidence=[],
            from_node_arrival=from_node,
        )

        print(f"\nEdge mu={resolved_edge.latency.mu:.3f} "
              f"Path mu={resolved_path.latency.mu:.3f}")
        print(f"Edge+carrier: {cf_edge.completeness:.4f}")
        print(f"Path+carrier: {cf_path.completeness:.4f} (double-apply)")

        if resolved_path.latency.mu > resolved_edge.latency.mu:
            assert cf_path.completeness < cf_edge.completeness, \
                "Path+carrier gives lower completeness (double upstream lag)"


class TestForecastSummaryGracefulDegradation:
    """Engine degrades gracefully with little or no evidence."""

    def _make_edge_and_resolve(self):
        from runner.model_resolver import resolve_model_params
        graph = _make_synth_graph([
            ('e1', 'n1', 'n2', 'A', 'B', 0.7, 2.3, 0.5, 1.0),
        ])
        edge = graph['edges'][0]
        resolved = resolve_model_params(edge, scope='edge', temporal_mode='window')
        resolved.alpha = 70.0
        resolved.beta = 30.0
        resolved.p_mean = resolved.alpha / (resolved.alpha + resolved.beta)
        resolved.p_sd = math.sqrt(
            resolved.alpha * resolved.beta
            / (((resolved.alpha + resolved.beta) ** 2) * (resolved.alpha + resolved.beta + 1))
        )
        return edge, resolved

    def test_no_evidence_returns_unconditioned(self):
        """Empty evidence list → unconditioned draws, IS skipped."""
        from runner.forecast_state import compute_forecast_summary
        _, resolved = self._make_edge_and_resolve()
        cohorts = [(10.0, 100), (20.0, 100), (30.0, 100)]

        cf = compute_forecast_summary(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=[],
        )
        assert cf.is_ess == 2000, f"ESS should equal draw count (no IS), got {cf.is_ess}"
        assert cf.is_tempering_lambda == 1.0
        assert cf.rate_conditioned == pytest.approx(cf.rate_unconditioned)
        assert cf.rate_conditioned_sd == pytest.approx(cf.rate_unconditioned_sd)
        assert cf.completeness > 0
        assert cf.rate_conditioned > 0
        print(f"No evidence: completeness={cf.completeness:.3f} "
              f"rate={cf.rate_conditioned:.3f} ESS={cf.is_ess:.0f}")

    def test_all_zero_k_skips_conditioning(self):
        """All cohorts have k=0 → IS skipped (no conversions observed)."""
        from runner.forecast_state import compute_forecast_summary
        _, resolved = self._make_edge_and_resolve()
        cohorts = [(10.0, 100), (20.0, 100)]
        evidence = [(10.0, 100, 0), (20.0, 100, 0)]

        cf = compute_forecast_summary(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=evidence,
        )
        assert cf.is_ess == 2000, f"ESS should equal draw count (k=0 skips IS), got {cf.is_ess}"
        assert cf.is_tempering_lambda == 1.0
        assert cf.rate_conditioned == pytest.approx(cf.rate_unconditioned)
        print(f"All k=0: completeness={cf.completeness:.3f} "
              f"rate={cf.rate_conditioned:.3f} ESS={cf.is_ess:.0f}")

    def test_very_young_cohorts_skip_conditioning(self):
        """Cohorts with age < onset → CDF≈0, E≈0 → IS skipped."""
        from runner.forecast_state import compute_forecast_summary
        _, resolved = self._make_edge_and_resolve()
        cohorts = [(0.5, 50)]
        evidence = [(0.5, 50, 2)]

        cf = compute_forecast_summary(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=evidence,
        )
        assert cf.is_ess == 2000, f"ESS should be unconditioned for young cohorts, got {cf.is_ess}"
        assert cf.is_tempering_lambda == 1.0
        assert cf.rate_conditioned == pytest.approx(cf.rate_unconditioned)
        print(f"Young cohorts: completeness={cf.completeness:.3f} ESS={cf.is_ess:.0f}")

    def test_single_cohort_moderate_evidence(self):
        """One cohort with moderate evidence → mild conditioning, healthy ESS."""
        from runner.forecast_state import compute_forecast_summary
        _, resolved = self._make_edge_and_resolve()
        cohorts = [(20.0, 50)]
        evidence = [(20.0, 50, 20)]

        cf = compute_forecast_summary(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=evidence,
        )
        assert cf.is_ess > 10, f"ESS too low for moderate evidence: {cf.is_ess}"
        assert cf.completeness > 0
        print(f"Moderate evidence: completeness={cf.completeness:.3f} "
              f"rate={cf.rate_conditioned:.3f} ESS={cf.is_ess:.0f}")

    def test_strong_evidence_conditions_p_toward_observed(self):
        """Strong evidence (high n, mature cohorts) should pull p toward
        observed rate, not leave it at prior."""
        from runner.forecast_state import compute_forecast_summary
        _, resolved = self._make_edge_and_resolve()
        cohorts = [(50.0, 500)]
        evidence = [(50.0, 500, 200)]

        cf_uncond = compute_forecast_summary(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=[],
        )
        cf_cond = compute_forecast_summary(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=evidence,
        )
        assert cf_cond.rate_unconditioned == pytest.approx(cf_uncond.rate_unconditioned)
        assert cf_cond.rate_conditioned < cf_cond.rate_unconditioned, \
            f"Conditioned rate ({cf_cond.rate_conditioned:.3f}) should be " \
            f"< unconditioned ({cf_cond.rate_unconditioned:.3f})"
        observed_rate = 200 / 500
        assert abs(cf_cond.rate_conditioned - observed_rate) < abs(
            cf_cond.rate_unconditioned - observed_rate
        ), (
            f"Conditioned rate ({cf_cond.rate_conditioned:.3f}) should be closer to "
            f"observed ({observed_rate:.3f}) than unconditioned "
            f"({cf_cond.rate_unconditioned:.3f})"
        )
        assert cf_cond.is_ess > 5, f"ESS too low: {cf_cond.is_ess}"
        print(f"Strong evidence: uncond={cf_cond.rate_unconditioned:.3f} "
              f"cond={cf_cond.rate_conditioned:.3f} "
              f"lambda={cf_cond.is_tempering_lambda:.3f} ESS={cf_cond.is_ess:.0f}")

    def test_extreme_aggregate_evidence_uses_tempering_floor(self):
        """Extreme aggregate evidence should temper the likelihood rather
        than collapsing to ESS≈1, while still moving toward the evidence.
        """
        from runner.forecast_state import compute_forecast_summary

        _, resolved = self._make_edge_and_resolve()
        cohorts = [(80.0, 1000)] * 18
        evidence = [(80.0, 1000, 400)] * 18

        cf = compute_forecast_summary(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=evidence,
        )

        observed_rate = 400 / 1000
        conditioned_p_mean = float(np.mean(cf.p_draws))
        unconditioned_p_mean = resolved.alpha / (resolved.alpha + resolved.beta)

        assert cf.is_tempering_lambda < 1.0, (
            f"Extreme evidence should trigger tempering, got λ={cf.is_tempering_lambda:.3f}"
        )
        assert cf.is_ess >= 19.5, f"ESS floor not preserved: {cf.is_ess:.2f}"
        assert conditioned_p_mean < unconditioned_p_mean
        assert abs(conditioned_p_mean - observed_rate) < abs(
            unconditioned_p_mean - observed_rate
        ), (
            f"Conditioned p ({conditioned_p_mean:.3f}) should move toward observed "
            f"rate ({observed_rate:.3f}) from prior ({unconditioned_p_mean:.3f})"
        )
        print(
            f"Extreme evidence: prior_p={unconditioned_p_mean:.3f} "
            f"cond_p={conditioned_p_mean:.3f} observed={observed_rate:.3f} "
            f"lambda={cf.is_tempering_lambda:.3f} ESS={cf.is_ess:.1f}"
        )

    def test_draws_valid_after_conditioning(self):
        """Conditioned draws should be finite and in valid ranges."""
        from runner.forecast_state import compute_forecast_summary
        import numpy as np
        _, resolved = self._make_edge_and_resolve()
        cohorts = [(15.0, 100), (25.0, 80)]
        evidence = [(15.0, 100, 35), (25.0, 80, 30)]

        cf = compute_forecast_summary(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=evidence,
        )
        assert len(cf.p_draws) == 2000
        assert np.all(np.isfinite(cf.p_draws))
        assert np.all(cf.p_draws > 0) and np.all(cf.p_draws < 1)
        assert np.all(np.isfinite(cf.mu_draws))
        assert np.all(np.isfinite(cf.sigma_draws))
        assert np.all(cf.sigma_draws > 0)
        assert np.all(np.isfinite(cf.onset_draws))
        assert np.all(cf.onset_draws >= 0)
        print(f"Draws valid: p=[{cf.p_draws.min():.3f}, {cf.p_draws.max():.3f}] "
              f"mu=[{cf.mu_draws.min():.3f}, {cf.mu_draws.max():.3f}] "
              f"ESS={cf.is_ess:.0f}")

    def test_surprise_gauge_scalars_populated(self):
        """Doc 55: ForecastSummary exposes unconditioned completeness moments
        and the unconditioned posterior-predictive rate for the surprise gauge.
        Verifies the four scalars are present, finite, and internally
        consistent with the draw arrays they summarise."""
        from runner.forecast_state import compute_forecast_summary
        _, resolved = self._make_edge_and_resolve()
        cohorts = [(20.0, 100), (40.0, 100), (60.0, 100)]
        evidence = [(20.0, 100, 30), (40.0, 100, 50), (60.0, 100, 60)]

        cf = compute_forecast_summary(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=evidence,
        )

        # All four new scalars are finite and in valid ranges
        assert math.isfinite(cf.completeness_unconditioned)
        assert math.isfinite(cf.completeness_unconditioned_sd)
        assert math.isfinite(cf.pp_rate_unconditioned)
        assert math.isfinite(cf.pp_rate_unconditioned_sd)
        assert 0.0 <= cf.completeness_unconditioned <= 1.0
        assert cf.completeness_unconditioned_sd >= 0.0
        assert 0.0 <= cf.pp_rate_unconditioned <= 1.0
        assert cf.pp_rate_unconditioned_sd >= 0.0

        # pp_rate_unconditioned is NOT the same as rate_unconditioned:
        # rate_unconditioned = mean(p_draws_unc)              (long-run p)
        # pp_rate_unconditioned = mean(p_draws_unc × c_unc)   (rate at maturity)
        # Since 0 < completeness < 1 for non-mature cohorts, pp < rate.
        assert cf.pp_rate_unconditioned < cf.rate_unconditioned, (
            f"pp_rate_unconditioned ({cf.pp_rate_unconditioned:.4f}) must be < "
            f"rate_unconditioned ({cf.rate_unconditioned:.4f}) when completeness < 1"
        )

        # Unconditioned completeness should match the point-estimate
        # interpretation of the unconditioned posterior
        # (approximately; we only check order of magnitude sensibility)
        assert 0.1 < cf.completeness_unconditioned < 0.99, (
            f"completeness_unconditioned={cf.completeness_unconditioned:.4f} "
            f"outside plausible range for these cohort ages"
        )

        # Conditioned completeness usually differs from unconditioned when
        # evidence is present (the surprise signal the gauge reports)
        print(
            f"Gauge scalars: pp_unc={cf.pp_rate_unconditioned:.4f}±"
            f"{cf.pp_rate_unconditioned_sd:.4f} "
            f"c_unc={cf.completeness_unconditioned:.4f}±"
            f"{cf.completeness_unconditioned_sd:.4f} "
            f"c_cond={cf.completeness:.4f}±{cf.completeness_sd:.4f}"
        )

    def test_surprise_gauge_scalars_no_evidence(self):
        """With no evidence, conditioned == unconditioned for all four
        surprise-gauge scalars. IS is skipped; resampled and raw draws
        coincide."""
        from runner.forecast_state import compute_forecast_summary
        _, resolved = self._make_edge_and_resolve()
        cohorts = [(20.0, 100), (40.0, 100)]

        cf = compute_forecast_summary(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=[],
        )

        assert cf.completeness == pytest.approx(cf.completeness_unconditioned)
        assert cf.completeness_sd == pytest.approx(cf.completeness_unconditioned_sd)
        # rate_unconditioned is just p; pp_rate_unconditioned is p × c.
        assert cf.pp_rate_unconditioned < cf.rate_unconditioned
        print(
            f"No-evidence gauge scalars: c_cond={cf.completeness:.4f} "
            f"c_unc={cf.completeness_unconditioned:.4f} (should match)"
        )


class TestSubsetConditioningBlend:
    """Doc 52 §14 — engine-level subset-conditioning blend.

    Covers:
    - `compute_forecast_summary` provenance + blended conditioned scalars.
    - Blend skip on analytic_be source (`source_query_scoped`).
    - Blend skip when n_effective is absent (`n_effective_missing`).
    - Boundary behaviour: r→0 ≈ fully conditioned; r=1 ≈ aggregate.
    """

    def _make_edge_and_resolve(self, n_effective=None):
        """Baseline: α=70, β=30, n_effective configurable, source='bayesian'."""
        from runner.model_resolver import resolve_model_params
        graph = _make_synth_graph([
            ('e1', 'n1', 'n2', 'A', 'B', 0.7, 2.3, 0.5, 1.0),
        ])
        edge = graph['edges'][0]
        resolved = resolve_model_params(edge, scope='edge', temporal_mode='window')
        resolved.alpha = 70.0
        resolved.beta = 30.0
        resolved.alpha_pred = 70.0
        resolved.beta_pred = 30.0
        resolved.n_effective = n_effective
        resolved.source = 'bayesian'
        resolved.p_mean = resolved.alpha / (resolved.alpha + resolved.beta)
        resolved.p_sd = math.sqrt(
            resolved.alpha * resolved.beta
            / (((resolved.alpha + resolved.beta) ** 2) * (resolved.alpha + resolved.beta + 1))
        )
        return edge, resolved

    def test_summary_blend_provenance_r06(self):
        """m_S=60, m_G=100 → r=0.6. Summary carries blend provenance."""
        from runner.forecast_state import compute_forecast_summary
        _, resolved = self._make_edge_and_resolve(n_effective=100.0)
        cohorts = [(30.0, 10)] * 6  # weights used for completeness only
        evidence = [(30.0, 10, 4)] * 6  # m_S = sum(n) = 60

        cf = compute_forecast_summary(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=evidence,
        )

        assert cf.blend_applied is True
        assert cf.r == pytest.approx(0.6)
        assert cf.m_S == pytest.approx(60.0)
        assert cf.m_G == pytest.approx(100.0)
        assert cf.blend_skip_reason is None

    def test_summary_blend_skip_query_scoped(self):
        """analytic_be source → blend skipped with source_query_scoped."""
        from runner.forecast_state import compute_forecast_summary
        _, resolved = self._make_edge_and_resolve(n_effective=100.0)
        resolved.source = 'analytic_be'  # toggles alpha_beta_query_scoped=True
        cohorts = [(20.0, 50)]
        evidence = [(20.0, 50, 15)]

        cf = compute_forecast_summary(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=evidence,
        )

        assert cf.blend_applied is False
        assert cf.blend_skip_reason == 'source_query_scoped'

    def test_summary_blend_skip_missing_n_effective(self):
        """n_effective=None → blend skipped with n_effective_missing."""
        from runner.forecast_state import compute_forecast_summary
        _, resolved = self._make_edge_and_resolve(n_effective=None)
        cohorts = [(20.0, 50)]
        evidence = [(20.0, 50, 15)]

        cf = compute_forecast_summary(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=evidence,
        )

        assert cf.blend_applied is False
        assert cf.blend_skip_reason == 'n_effective_missing'

    def test_summary_blend_full_r_collapses_to_unconditioned(self):
        """r=1 → blended completeness == completeness_unconditioned (±tol).

        At r=1 the blended draws are entirely from the unconditioned
        set, so the "conditioned" scalar collapses to the unconditioned
        one and the surprise-gauge shift goes to zero.
        """
        from runner.forecast_state import compute_forecast_summary
        _, resolved = self._make_edge_and_resolve(n_effective=60.0)
        cohorts = [(30.0, 10)] * 6
        evidence = [(30.0, 10, 9)] * 6  # m_S = 60 = m_G

        cf = compute_forecast_summary(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=evidence,
        )

        assert cf.blend_applied is True
        assert cf.r == pytest.approx(1.0)
        # At r=1 the mix is entirely the unconditioned draws, so
        # completeness equals completeness_unconditioned exactly.
        assert cf.completeness == pytest.approx(cf.completeness_unconditioned, abs=1e-10)
        assert cf.rate_conditioned == pytest.approx(cf.rate_unconditioned, abs=1e-10)

    def test_summary_blend_small_r_near_fully_conditioned(self):
        """r≈0.05 → blended output ≈ fully-conditioned."""
        from runner.forecast_state import compute_forecast_summary
        _, resolved = self._make_edge_and_resolve(n_effective=1000.0)
        cohorts = [(30.0, 10)] * 5
        evidence = [(30.0, 10, 7)] * 5  # m_S = 50, r = 0.05

        # Compute blend-off reference by passing n_effective=None
        _, resolved_ref = self._make_edge_and_resolve(n_effective=None)
        cf_ref = compute_forecast_summary(
            edge_id='e1', resolved=resolved_ref,
            cohort_ages_and_weights=cohorts,
            evidence=evidence,
        )
        # Now blend with r≈0.05
        cf = compute_forecast_summary(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=evidence,
        )

        assert cf.blend_applied is True
        assert cf.r == pytest.approx(0.05, abs=1e-3)
        # 5% of the mix is unconditioned; rate should stay close to
        # the fully-conditioned reference (within a few percent).
        assert abs(cf.rate_conditioned - cf_ref.rate_conditioned) < 0.05, (
            f"r=0.05 blend diverged too much: "
            f"blended={cf.rate_conditioned:.4f} ref={cf_ref.rate_conditioned:.4f}"
        )

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

    def test_summary_reads_carrier_from_runtime_bundle(self):
        from runner.forecast_runtime import build_prepared_runtime_bundle
        from runner.forecast_state import (
            NodeArrivalState,
            compute_forecast_summary,
        )
        from runner.model_resolver import ResolvedLatency, ResolvedModelParams

        resolved = ResolvedModelParams(
            p_mean=0.4,
            p_sd=0.05,
            alpha=12.0,
            beta=18.0,
            alpha_pred=12.0,
            beta_pred=18.0,
            edge_latency=ResolvedLatency(mu=2.5, sigma=0.5, onset_delta_days=0.0),
            source='bayesian',
        )
        from_node_arrival = NodeArrivalState(
            deterministic_cdf=[0.0, 0.2, 0.5, 0.8, 1.0] + [1.0] * 40,
            reach=0.8,
            tier='parametric',
        )
        cohorts = [(10.0, 100.0), (20.0, 100.0)]
        evidence = [(10.0, 100.0, 30.0)]

        explicit = compute_forecast_summary(
            edge_id='bc',
            resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=evidence,
            from_node_arrival=from_node_arrival,
        )
        runtime_bundle = build_prepared_runtime_bundle(
            mode='cohort',
            query_from_node='B',
            query_to_node='C',
            anchor_node_id='A',
            from_node_arrival=from_node_arrival,
            resolved_params=resolved,
            p_conditioning_temporal_family='cohort',
            p_conditioning_source='aggregate_evidence',
            p_conditioning_evidence_points=len(evidence),
            p_conditioning_total_x=100.0,
            p_conditioning_total_y=30.0,
        )
        bundled = compute_forecast_summary(
            edge_id='bc',
            resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=evidence,
            runtime_bundle=runtime_bundle,
        )

        assert bundled.completeness == pytest.approx(explicit.completeness)
        assert bundled.rate_conditioned == pytest.approx(explicit.rate_conditioned)
        assert bundled.runtime_bundle_diag is not None
        assert bundled.runtime_bundle_diag['population_root'] == 'A'
        assert bundled.runtime_bundle_diag['carrier_to_x']['mode'] == 'upstream'
        assert bundled.runtime_bundle_diag['subject_span']['start_node_id'] == 'B'

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
