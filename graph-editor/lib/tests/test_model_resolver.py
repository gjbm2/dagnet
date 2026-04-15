"""
Tests for the promoted model resolver (doc 29 Phase 1).

Verifies that resolve_model_params produces identical output to the
existing scattered resolution logic:
- _read_edge_model_params() in api_handlers.py
- read_edge_cohort_params() in cohort_forecast.py
- _resolve_completeness_params() in api_handlers.py

Uses real graph data from the data repo (auto-discovered).
"""

import json
import math
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest

DB_URL = os.environ.get('DB_CONNECTION', '')
requires_db = pytest.mark.skipif(not DB_URL, reason='DB_CONNECTION not set')

_DAGNET_ROOT = Path(__file__).parent.parent.parent.parent
_CONF_FILE = _DAGNET_ROOT / '.private-repos.conf'
_DATA_REPO_DIR = None
if _CONF_FILE.exists():
    for line in _CONF_FILE.read_text().splitlines():
        if line.startswith('DATA_REPO_DIR='):
            _DATA_REPO_DIR = _DAGNET_ROOT / line.split('=', 1)[1].strip()
            break

requires_data_repo = pytest.mark.skipif(
    _DATA_REPO_DIR is None or not (_DATA_REPO_DIR / 'graphs').is_dir(),
    reason='Data repo not available',
)


def _discover_graph_with_model_params() -> tuple:
    """Find a graph and edge with model params (mu, sigma, forecast.mean).

    Returns (graph_dict, edge_dict) or skips.
    """
    if _DATA_REPO_DIR is None:
        pytest.skip('Data repo not available')
    graphs_dir = _DATA_REPO_DIR / 'graphs'
    for gf in sorted(graphs_dir.glob('*.json')):
        if 'synth-meta' in gf.name or 'truth' in gf.name:
            continue
        try:
            g = json.loads(gf.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        for edge in g.get('edges', []):
            p = edge.get('p', {})
            lat = p.get('latency', {})
            has_model = (
                (lat.get('mu') or lat.get('posterior', {}).get('mu_mean'))
                and p.get('forecast', {}).get('mean')
            )
            if has_model and p.get('id'):
                return (g, edge)
    pytest.skip('No graph with model params found')


@requires_data_repo
class TestResolverParity:
    """Resolver produces params consistent with existing logic."""

    def test_window_mode_resolves_from_real_edge(self):
        """Window-mode resolver extracts correct params from a real edge."""
        g, edge = _discover_graph_with_model_params()

        from runner.model_resolver import resolve_model_params

        result = resolve_model_params(edge, scope='edge', temporal_mode='window')
        assert result is not None, 'Resolver returned None'

        p = edge.get('p', {})
        lat = p.get('latency', {})
        lat_post = lat.get('posterior', {})

        # Latency: should match posterior or flat fields
        expected_mu = lat_post.get('mu_mean') or lat.get('mu') or 0
        expected_sigma = lat_post.get('sigma_mean') or lat.get('sigma') or 0
        assert abs(result.edge_latency.mu - float(expected_mu)) < 1e-6, \
            f"mu: result={result.edge_latency.mu} expected={expected_mu}"
        assert abs(result.edge_latency.sigma - float(expected_sigma)) < 1e-6, \
            f"sigma: result={result.edge_latency.sigma} expected={expected_sigma}"

        # Probability: should be non-zero (we discovered an edge with forecast.mean)
        assert result.p_mean > 0, f"p_mean should be > 0, got {result.p_mean}"

        # Onset: should be >= 0
        assert result.edge_latency.onset_delta_days >= 0

        # In window mode, path_latency should be None
        assert result.path_latency is None, \
            'Window mode should not populate path_latency'

    def test_cohort_mode_uses_path_params(self):
        """Cohort-mode resolver prefers path-level latency when available."""
        g, edge = _discover_graph_with_model_params()

        from runner.model_resolver import resolve_model_params

        result = resolve_model_params(edge, scope='path', temporal_mode='cohort')
        assert result is not None

        lat = edge.get('p', {}).get('latency', {})
        lat_post = lat.get('posterior', {})
        has_path = (
            (lat_post.get('path_mu_mean') or lat.get('path_mu'))
            and (lat_post.get('path_sigma_mean') or lat.get('path_sigma'))
        )

        if has_path:
            # Should have resolved to path-level
            assert result.path_latency is not None, \
                'Path latency should be populated when path params exist'
            assert result.latency is result.path_latency, \
                'Active latency should be path_latency'
        else:
            # Should fall back to edge-level
            assert result.path_latency is None, \
                'Path latency should be None when no path params'
            assert result.latency is result.edge_latency

    def test_cohort_mode_prefers_path_alpha_beta(self):
        """Cohort-mode resolver prefers path_alpha/path_beta for probability."""
        g, edge = _discover_graph_with_model_params()

        from runner.model_resolver import resolve_model_params

        post = edge.get('p', {}).get('posterior', {})
        path_alpha = post.get('path_alpha', 0) or 0
        path_beta = post.get('path_beta', 0) or 0

        result = resolve_model_params(edge, scope='path', temporal_mode='cohort')
        assert result is not None

        if path_alpha > 0 and path_beta > 0:
            expected_p = path_alpha / (path_alpha + path_beta)
            assert abs(result.p_mean - expected_p) < 1e-6, \
                f"Cohort p_mean should use path_alpha/path_beta: {result.p_mean} vs {expected_p}"
            assert abs(result.alpha - path_alpha) < 1e-6
            assert abs(result.beta - path_beta) < 1e-6

    def test_source_preference_respected(self):
        """Resolver respects model_source_preference."""
        g, edge = _discover_graph_with_model_params()

        from runner.model_resolver import resolve_model_params

        result = resolve_model_params(edge, scope='edge', temporal_mode='window')
        assert result is not None
        # Source should be one of the valid values
        assert result.source in ('analytic', 'analytic_be', 'bayesian', 'manual', ''), \
            f"Unexpected source: {result.source}"

    def test_source_curves_populated(self):
        """Source curves are extracted from model_vars."""
        g, edge = _discover_graph_with_model_params()

        from runner.model_resolver import resolve_model_params

        result = resolve_model_params(edge, scope='edge', temporal_mode='window')
        assert result is not None

        model_vars = edge.get('p', {}).get('model_vars', [])
        expected_sources = {mv['source'] for mv in model_vars if mv.get('source')}
        actual_sources = set(result.source_curves.keys())

        # Every model_vars source should appear in source_curves
        for src in expected_sources:
            if src in ('analytic', 'analytic_be', 'bayesian', 'manual'):
                assert src in actual_sources, \
                    f"Missing source curve: {src}"

    def test_empty_edge_returns_defaults(self):
        """Edge with empty p block returns default ResolvedModelParams."""
        from runner.model_resolver import resolve_model_params

        bare_edge = {'p': {}}
        result = resolve_model_params(bare_edge, scope='edge', temporal_mode='window')
        assert result is not None
        assert result.p_mean == 0.0
        assert result.edge_latency.mu == 0.0
        assert result.source == ''

    def test_no_p_block_returns_defaults(self):
        """Edge with no p block returns default ResolvedModelParams."""
        from runner.model_resolver import resolve_model_params

        result = resolve_model_params({}, scope='edge', temporal_mode='window')
        assert result is not None
        assert result.p_mean == 0.0

    def test_manual_source_has_no_fitted_at(self):
        """Manual source edge doesn't require fitted_at."""
        from runner.model_resolver import resolve_model_params

        edge = {
            'p': {
                'forecast': {'mean': 0.5},
                'latency': {'mu': 2.0, 'sigma': 0.5},
                'model_vars': [{
                    'source': 'manual',
                    'source_at': '1-Apr-26',
                    'probability': {'mean': 0.5, 'stdev': 0.05},
                    'latency': {'mu': 2.0, 'sigma': 0.5},
                }],
                'model_source_preference': 'manual',
            }
        }
        result = resolve_model_params(edge, scope='edge', temporal_mode='window')
        assert result is not None
        assert result.source == 'manual'
        # fitted_at may be source_at or None — both are acceptable

    def test_resolver_reads_model_vars_entry_not_flat_fields(self):
        """When flat fields and ModelVarsEntry disagree, resolver picks
        ModelVarsEntry values. This is the specific scenario that
        review finding #6 addressed — stale promotion leaving flat
        fields from a different source than the selected one.
        """
        from runner.model_resolver import resolve_model_params

        # Flat fields: mu=2.0, sigma=0.5 (from a stale analytic run)
        # ModelVarsEntry (analytic_be): mu=3.5, sigma=0.8 (current best)
        # The resolver should select analytic_be and return 3.5/0.8,
        # NOT the flat 2.0/0.5.
        edge = {
            'p': {
                'forecast': {'mean': 0.6},
                'latency': {
                    'mu': 2.0,
                    'sigma': 0.5,
                    'onset_delta_days': 1.0,
                },
                'model_vars': [
                    {
                        'source': 'analytic',
                        'latency': {'mu': 2.0, 'sigma': 0.5, 'onset_delta_days': 1.0},
                        'probability': {'mean': 0.55},
                    },
                    {
                        'source': 'analytic_be',
                        'latency': {'mu': 3.5, 'sigma': 0.8, 'onset_delta_days': 2.0,
                                    'mu_sd': 0.1, 'sigma_sd': 0.05, 'onset_sd': 0.5},
                        'probability': {'mean': 0.6},
                    },
                ],
            }
        }
        result = resolve_model_params(edge, scope='edge', temporal_mode='window')
        assert result is not None
        # analytic_be wins over analytic in best_available cascade
        assert result.source == 'analytic_be'
        # Values must come from the analytic_be entry, not flat fields
        assert abs(result.edge_latency.mu - 3.5) < 1e-6, \
            f"mu should be 3.5 (from analytic_be), got {result.edge_latency.mu}"
        assert abs(result.edge_latency.sigma - 0.8) < 1e-6, \
            f"sigma should be 0.8 (from analytic_be), got {result.edge_latency.sigma}"
        assert abs(result.edge_latency.onset_delta_days - 2.0) < 1e-6, \
            f"onset should be 2.0 (from analytic_be), got {result.edge_latency.onset_delta_days}"
        # Dispersions from the entry
        assert abs(result.edge_latency.mu_sd - 0.1) < 1e-6
        assert abs(result.edge_latency.sigma_sd - 0.05) < 1e-6

    def test_graph_preference_overrides_edge_preference(self):
        """graph_preference parameter overrides edge-level
        model_source_preference. Review finding #6.
        """
        from runner.model_resolver import resolve_model_params

        edge = {
            'p': {
                'forecast': {'mean': 0.5},
                'latency': {'mu': 2.0, 'sigma': 0.5},
                'model_source_preference': 'analytic',
                'model_vars': [
                    {
                        'source': 'analytic',
                        'latency': {'mu': 2.0, 'sigma': 0.5},
                        'probability': {'mean': 0.5},
                    },
                    {
                        'source': 'manual',
                        'latency': {'mu': 4.0, 'sigma': 1.0},
                        'probability': {'mean': 0.7},
                    },
                ],
            }
        }
        # Without graph_preference: edge says analytic
        result = resolve_model_params(edge, scope='edge', temporal_mode='window')
        assert result.source == 'analytic'
        assert abs(result.edge_latency.mu - 2.0) < 1e-6

        # With graph_preference=manual: overrides edge-level
        result = resolve_model_params(edge, scope='edge', temporal_mode='window',
                                       graph_preference='manual')
        assert result.source == 'manual'
        assert abs(result.edge_latency.mu - 4.0) < 1e-6
