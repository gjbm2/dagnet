"""
Tests for forecast engine components (doc 29 Phase 3 + G.3).

Verifies:
- NodeArrivalState is built correctly for synth graphs
- Carrier convolution properties (_convolve_completeness_at_age)
- compute_conditioned_forecast graceful degradation (used by surprise gauge)

G.3 cleanup: removed TestCohortModeForecastState and
TestPhase3ParityEnrichedSynth — these tested compute_forecast_state_cohort
and compute_forecast_state_window which are retired. Parity is now
tested via v2-v3-parity-test.sh (CLI) and test_v2_v3_parity.py.
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
            compute_conditioned_forecast,
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

        cf_edge = compute_conditioned_forecast(
            edge_id='bc', resolved=resolved_edge,
            cohort_ages_and_weights=cohorts, evidence=[],
            from_node_arrival=from_node,
        )
        cf_path = compute_conditioned_forecast(
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


class TestConditionedForecastGracefulDegradation:
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
        from runner.forecast_state import compute_conditioned_forecast
        _, resolved = self._make_edge_and_resolve()
        cohorts = [(10.0, 100), (20.0, 100), (30.0, 100)]

        cf = compute_conditioned_forecast(
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
        from runner.forecast_state import compute_conditioned_forecast
        _, resolved = self._make_edge_and_resolve()
        cohorts = [(10.0, 100), (20.0, 100)]
        evidence = [(10.0, 100, 0), (20.0, 100, 0)]

        cf = compute_conditioned_forecast(
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
        from runner.forecast_state import compute_conditioned_forecast
        _, resolved = self._make_edge_and_resolve()
        cohorts = [(0.5, 50)]
        evidence = [(0.5, 50, 2)]

        cf = compute_conditioned_forecast(
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
        from runner.forecast_state import compute_conditioned_forecast
        _, resolved = self._make_edge_and_resolve()
        cohorts = [(20.0, 50)]
        evidence = [(20.0, 50, 20)]

        cf = compute_conditioned_forecast(
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
        from runner.forecast_state import compute_conditioned_forecast
        _, resolved = self._make_edge_and_resolve()
        cohorts = [(50.0, 500)]
        evidence = [(50.0, 500, 200)]

        cf_uncond = compute_conditioned_forecast(
            edge_id='e1', resolved=resolved,
            cohort_ages_and_weights=cohorts,
            evidence=[],
        )
        cf_cond = compute_conditioned_forecast(
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
        from runner.forecast_state import compute_conditioned_forecast

        _, resolved = self._make_edge_and_resolve()
        cohorts = [(80.0, 1000)] * 18
        evidence = [(80.0, 1000, 400)] * 18

        cf = compute_conditioned_forecast(
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
        from runner.forecast_state import compute_conditioned_forecast
        import numpy as np
        _, resolved = self._make_edge_and_resolve()
        cohorts = [(15.0, 100), (25.0, 80)]
        evidence = [(15.0, 100, 35), (25.0, 80, 30)]

        cf = compute_conditioned_forecast(
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
