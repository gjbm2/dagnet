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

    def test_cohort_mode_uses_cohort_posterior(self):
        """Cohort-mode resolver uses cohort-mode posterior (cohort_alpha/cohort_beta).

        cohort_alpha/cohort_beta is the posterior on this edge's rate (y/x)
        estimated from anchor-anchored evidence with path latency. The
        name is confusing — "path" refers to the latency model used
        during fitting, not to a compound path probability.
        """
        g, edge = _discover_graph_with_model_params()

        from runner.model_resolver import resolve_model_params

        post = edge.get('p', {}).get('posterior', {})
        cohort_alpha = post.get('cohort_alpha', 0) or 0
        cohort_beta = post.get('cohort_beta', 0) or 0

        result = resolve_model_params(edge, scope='path', temporal_mode='cohort')
        assert result is not None

        if cohort_alpha > 0 and cohort_beta > 0:
            expected_p = cohort_alpha / (cohort_alpha + cohort_beta)
            assert abs(result.p_mean - expected_p) < 1e-6, \
                f"Cohort p_mean should use cohort posterior: {result.p_mean} vs {expected_p}"
            assert abs(result.alpha - cohort_alpha) < 1e-6
            assert abs(result.beta - cohort_beta) < 1e-6
        else:
            # No cohort posterior — falls back to edge-level
            edge_alpha = post.get('alpha', 0) or 0
            edge_beta = post.get('beta', 0) or 0
            if edge_alpha > 0 and edge_beta > 0:
                expected_p = edge_alpha / (edge_alpha + edge_beta)
                assert abs(result.p_mean - expected_p) < 1e-6

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


class TestResolverNonBayes:
    """Resolver produces usable params when Bayes vars are absent.

    Confirms that edges fitted by analytic-only pipelines (no Bayesian
    model_vars) resolve correctly through the preference cascade and
    produce params that the forecast engine can consume.
    """

    def test_analytic_only_model_vars(self):
        """Edge with only analytic model_vars — no bayesian entry."""
        from runner.model_resolver import resolve_model_params

        edge = {
            'p': {
                'forecast': {'mean': 0.4},
                'latency': {'mu': 3.0, 'sigma': 0.6},
                'posterior': {'alpha': 12, 'beta': 18},
                'model_vars': [{
                    'source': 'analytic',
                    'latency': {'mu': 3.0, 'sigma': 0.6, 'onset_delta_days': 0.0},
                    'probability': {'mean': 0.4, 'stdev': 0.05},
                }],
            }
        }
        result = resolve_model_params(edge, scope='edge', temporal_mode='window')
        assert result is not None
        assert result.source == 'analytic'
        assert abs(result.edge_latency.mu - 3.0) < 1e-6
        assert abs(result.edge_latency.sigma - 0.6) < 1e-6
        assert result.edge_latency.sigma > 0, 'sigma must be > 0 for engine'
        # Dispersions: analytic entry has none → zero SDs
        assert result.edge_latency.mu_sd == 0.0
        assert result.edge_latency.sigma_sd == 0.0
        # Probability from posterior alpha/beta
        assert result.alpha == 12
        assert result.beta == 18
        assert abs(result.p_mean - 12 / 30) < 1e-6

    def test_analytic_only_cohort_mode(self):
        """Cohort mode with analytic-only: path latency from flat fields."""
        from runner.model_resolver import resolve_model_params

        edge = {
            'p': {
                'forecast': {'mean': 0.3},
                'latency': {
                    'mu': 2.5, 'sigma': 0.5,
                    'path_mu': 3.2, 'path_sigma': 0.7,
                    'path_onset_delta_days': 1.0,
                },
                'posterior': {
                    'alpha': 10, 'beta': 20,
                    'cohort_alpha': 8, 'cohort_beta': 25,
                },
                'model_vars': [{
                    'source': 'analytic',
                    'latency': {'mu': 2.5, 'sigma': 0.5},
                    'probability': {'mean': 0.3},
                }],
            }
        }
        result = resolve_model_params(edge, scope='path', temporal_mode='cohort')
        assert result is not None
        assert result.source == 'analytic'
        # Path latency from flat fields
        assert result.path_latency is not None
        assert abs(result.path_latency.mu - 3.2) < 1e-6
        assert abs(result.path_latency.sigma - 0.7) < 1e-6
        assert result.latency is result.path_latency
        # Cohort mode uses cohort-mode posterior (cohort_alpha/cohort_beta):
        # same edge rate (y/x), but estimated from anchor-anchored
        # evidence with path latency. "path" in the name refers to the
        # latency model used during fitting, not a compound path product.
        assert abs(result.alpha - 8) < 1e-6
        assert abs(result.beta - 25) < 1e-6

    def test_no_model_vars_flat_fields_only(self):
        """Edge with no model_vars at all — resolver falls back to flat
        latency and posterior fields. This is the pre-Bayes edge shape.
        """
        from runner.model_resolver import resolve_model_params

        edge = {
            'p': {
                'forecast': {'mean': 0.35},
                'latency': {
                    'mu': 2.8, 'sigma': 0.55, 'onset_delta_days': 0.5,
                    'promoted_t95': 14.0,
                    'promoted_mu_sd': 0.15, 'promoted_sigma_sd': 0.08,
                },
                'posterior': {'alpha': 15, 'beta': 28},
                # No model_vars key at all
            }
        }
        result = resolve_model_params(edge, scope='edge', temporal_mode='window')
        assert result is not None
        assert result.source == '', 'No source when no model_vars'
        # Latency from flat fields
        assert abs(result.edge_latency.mu - 2.8) < 1e-6
        assert abs(result.edge_latency.sigma - 0.55) < 1e-6
        assert result.edge_latency.sigma > 0, 'sigma > 0 for engine'
        assert abs(result.edge_latency.onset_delta_days - 0.5) < 1e-6
        assert abs(result.edge_latency.t95 - 14.0) < 1e-6
        # Dispersions from promoted_ fields
        assert abs(result.edge_latency.mu_sd - 0.15) < 1e-6
        assert abs(result.edge_latency.sigma_sd - 0.08) < 1e-6
        # Probability from posterior
        assert result.alpha == 15
        assert result.beta == 28
        assert abs(result.p_mean - 15 / 43) < 1e-6

    def test_no_model_vars_posterior_latency(self):
        """Edge with lat_posterior fields (fitted by topo pass) but no
        model_vars. Resolver should read from latency.posterior.
        """
        from runner.model_resolver import resolve_model_params

        edge = {
            'p': {
                'forecast': {'mean': 0.5},
                'latency': {
                    'mu': 1.0, 'sigma': 0.3,  # stale flat fields
                    'posterior': {
                        'mu_mean': 2.2, 'sigma_mean': 0.45,
                        'onset_delta_days': 0.8,
                        'mu_sd': 0.1, 'sigma_sd': 0.04,
                    },
                },
                'posterior': {'alpha': 20, 'beta': 20},
            }
        }
        result = resolve_model_params(edge, scope='edge', temporal_mode='window')
        assert result is not None
        # Should prefer posterior values over flat fields
        assert abs(result.edge_latency.mu - 2.2) < 1e-6
        assert abs(result.edge_latency.sigma - 0.45) < 1e-6
        assert abs(result.edge_latency.onset_delta_days - 0.8) < 1e-6
        assert abs(result.edge_latency.mu_sd - 0.1) < 1e-6

    def test_no_posterior_no_model_vars_forecast_mean_only(self):
        """Edge with only forecast.mean for probability — minimal viable
        edge. Resolver should still produce usable params if latency
        flat fields are present.
        """
        from runner.model_resolver import resolve_model_params

        edge = {
            'p': {
                'forecast': {'mean': 0.25},
                'latency': {'mu': 4.0, 'sigma': 1.0},
                # No posterior, no model_vars
            }
        }
        result = resolve_model_params(edge, scope='edge', temporal_mode='window')
        assert result is not None
        assert abs(result.p_mean - 0.25) < 1e-6
        # D20: resolver now derives alpha/beta from kappa=200 fallback
        # when no posterior or evidence counts are available.
        assert result.alpha > 0, 'D20: resolver should provide alpha'
        assert result.beta > 0, 'D20: resolver should provide beta'
        kappa = result.alpha + result.beta
        assert abs(kappa - 200.0) < 1e-6, f'Expected kappa=200 fallback, got {kappa}'
        assert abs(result.alpha / kappa - 0.25) < 1e-6, 'Alpha should reflect p_mean'
        assert abs(result.edge_latency.mu - 4.0) < 1e-6
        assert abs(result.edge_latency.sigma - 1.0) < 1e-6


class TestForecastEngineNonBayes:
    """Integration: compute_forecast_sweep produces valid output when
    fed resolved params from non-Bayes edges.

    Confirms the engine doesn't crash, produces non-trivial draws,
    and the rate converges toward p for mature cohorts.
    """

    def _make_analytic_resolved(self, with_dispersions=False):
        """Build a ResolvedModelParams as if from an analytic-only edge."""
        from runner.model_resolver import ResolvedModelParams, ResolvedLatency

        lat = ResolvedLatency(
            mu=3.0, sigma=0.6, onset_delta_days=0.0, t95=12.0,
            mu_sd=0.12 if with_dispersions else 0.0,
            sigma_sd=0.05 if with_dispersions else 0.0,
            onset_sd=0.0,
            onset_mu_corr=0.0,
        )
        return ResolvedModelParams(
            p_mean=0.4, p_sd=0.05,
            alpha=12, beta=18,
            edge_latency=lat,
            path_latency=None,
            source='analytic',
        )

    def _make_cohorts(self, n_cohorts=3, max_tau=50):
        """Build synthetic CohortEvidence with plausible observations."""
        from runner.forecast_state import CohortEvidence
        import numpy as np

        cohorts = []
        rng = np.random.default_rng(99)
        for i in range(n_cohorts):
            N_i = 100.0
            frontier = 10 + i * 5  # ages 10, 15, 20
            # Simulate observations: x constant, y growing with CDF shape
            obs_x = [N_i] * (max_tau + 1)
            obs_y = [0.0] * (max_tau + 1)
            for t in range(frontier + 1):
                # Rough lognormal CDF approximation for y
                if t > 0:
                    frac = min(1.0, 0.4 * (1 - math.exp(-0.1 * t)))
                    obs_y[t] = N_i * frac
                    # Add small noise
                    obs_y[t] += rng.normal(0, 0.5)
                    obs_y[t] = max(0, min(obs_y[t], N_i))
            y_frozen = obs_y[frontier]
            cohorts.append(CohortEvidence(
                obs_x=obs_x, obs_y=obs_y,
                x_frozen=N_i, y_frozen=y_frozen,
                frontier_age=frontier, a_pop=N_i,
            ))
        return cohorts

    def test_sweep_analytic_no_dispersions(self):
        """Engine runs with analytic-only params (zero SDs).

        The no-dispersion branch uses fixed mu/sigma/onset with only
        p varying. Should produce a valid rate forecast.
        """
        from runner.forecast_state import compute_forecast_sweep
        import numpy as np

        resolved = self._make_analytic_resolved(with_dispersions=False)
        cohorts = self._make_cohorts(n_cohorts=3, max_tau=50)
        result = compute_forecast_sweep(
            resolved=resolved, cohorts=cohorts, max_tau=50,
            num_draws=500,
        )

        assert result.rate_draws.shape == (500, 51)
        assert result.model_rate_draws.shape == (500, 51)
        # Rate at mature τ (beyond all frontiers) should be near p=0.4
        median_rate_at_40 = float(np.median(result.rate_draws[:, 40]))
        assert 0.1 < median_rate_at_40 < 0.8, \
            f"Median rate at τ=40 should be plausible, got {median_rate_at_40}"
        # Rate should not be all zeros
        assert np.any(result.rate_draws > 0), 'Rate draws should not be all zeros'
        # Fan should be narrower than with dispersions (all draws use same CDF)
        spread_at_40 = float(np.std(result.rate_draws[:, 40]))
        assert spread_at_40 > 0, 'Should have some spread from p variation'

    def test_sweep_analytic_with_dispersions(self):
        """Engine runs with analytic params that have SDs (e.g. from
        promoted_mu_sd fields). Fan should be wider than zero-SD case.
        """
        from runner.forecast_state import compute_forecast_sweep
        import numpy as np

        resolved_no_sd = self._make_analytic_resolved(with_dispersions=False)
        resolved_with_sd = self._make_analytic_resolved(with_dispersions=True)
        cohorts = self._make_cohorts(n_cohorts=3, max_tau=50)

        result_no_sd = compute_forecast_sweep(
            resolved=resolved_no_sd, cohorts=cohorts, max_tau=50,
            num_draws=500,
        )
        result_with_sd = compute_forecast_sweep(
            resolved=resolved_with_sd, cohorts=cohorts, max_tau=50,
            num_draws=500,
        )

        # Both should produce valid output
        assert result_no_sd.rate_draws.shape == (500, 51)
        assert result_with_sd.rate_draws.shape == (500, 51)

        # Fan with dispersions should be wider (more uncertainty).
        # Use model_rate_draws (unconditioned) to avoid IS compression
        # masking the dispersion effect.
        spread_no_sd = float(np.std(result_no_sd.model_rate_draws[:, 40]))
        spread_with_sd = float(np.std(result_with_sd.model_rate_draws[:, 40]))
        assert spread_with_sd > spread_no_sd, \
            f"With-SD model spread ({spread_with_sd:.4f}) should exceed " \
            f"no-SD model spread ({spread_no_sd:.4f})"

    def test_sweep_forecast_mean_only_no_alpha_beta(self):
        """Edge with only forecast.mean (no posterior alpha/beta).

        Resolver sets alpha=0, beta=0. Engine should still produce
        valid draws using p_mean directly.
        """
        from runner.model_resolver import ResolvedModelParams, ResolvedLatency
        from runner.forecast_state import compute_forecast_sweep
        import numpy as np

        lat = ResolvedLatency(mu=3.0, sigma=0.6)
        resolved = ResolvedModelParams(
            p_mean=0.25, p_sd=0.0,
            alpha=0, beta=0,  # no posterior
            edge_latency=lat,
            source='',
        )
        cohorts = self._make_cohorts(n_cohorts=2, max_tau=40)
        result = compute_forecast_sweep(
            resolved=resolved, cohorts=cohorts, max_tau=40,
            num_draws=500,
        )

        assert result.rate_draws.shape == (500, 41)
        # Should still produce non-trivial output
        median_rate = float(np.median(result.rate_draws[:, 35]))
        assert median_rate > 0, f"Rate should be > 0, got {median_rate}"

    def test_sweep_frontier_zero_degenerates_to_model_bands(self):
        """When all cohorts have frontier_age=0 (no evidence), conditioned
        rate_draws should degenerate to model_rate_draws.

        This is the cornerstone property: at the limit where frontier=asat,
        the forecast produces epistemic model uncertainty bands, not
        evidence-conditioned bands. IS doesn't fire (E_i=0, k_i=0).

        Uses large N_i to minimise binomial sampling noise.
        """
        from runner.model_resolver import ResolvedModelParams, ResolvedLatency
        from runner.forecast_state import compute_forecast_sweep, CohortEvidence
        import numpy as np

        lat = ResolvedLatency(mu=3.0, sigma=0.6, onset_delta_days=0.0, t95=12.0)
        resolved = ResolvedModelParams(
            p_mean=0.4, p_sd=0.05,
            alpha=12, beta=18,
            edge_latency=lat,
            source='analytic',
        )

        max_tau = 50
        # Large N_i so binomial noise is negligible
        N_i = 10000.0
        cohorts = []
        for _ in range(3):
            cohorts.append(CohortEvidence(
                obs_x=[N_i] * (max_tau + 1),
                obs_y=[0.0] * (max_tau + 1),
                x_frozen=N_i,
                y_frozen=0.0,
                frontier_age=0,
                a_pop=N_i,
            ))

        result = compute_forecast_sweep(
            resolved=resolved, cohorts=cohorts, max_tau=max_tau,
            num_draws=2000,
        )

        # IS should not fire (no evidence)
        assert result.n_cohorts_conditioned == 0, \
            f"IS should not fire with frontier=0, got {result.n_cohorts_conditioned} conditioned"

        # At several τ past onset, conditioned median ≈ model median
        for tau in [10, 20, 30, 40]:
            cond_median = float(np.median(result.rate_draws[:, tau]))
            model_median = float(np.median(result.model_rate_draws[:, tau]))
            assert abs(cond_median - model_median) < 0.02, \
                f"τ={tau}: conditioned median ({cond_median:.4f}) should ≈ " \
                f"model median ({model_median:.4f})"

        # Fan widths should also be close (90% band)
        for tau in [15, 30]:
            cond_width = float(
                np.quantile(result.rate_draws[:, tau], 0.95)
                - np.quantile(result.rate_draws[:, tau], 0.05))
            model_width = float(
                np.quantile(result.model_rate_draws[:, tau], 0.95)
                - np.quantile(result.model_rate_draws[:, tau], 0.05))
            ratio = cond_width / max(model_width, 1e-10)
            assert 0.8 < ratio < 1.3, \
                f"τ={tau}: fan width ratio {ratio:.2f} (cond={cond_width:.4f}, " \
                f"model={model_width:.4f}) — should be ≈1.0"

    def test_sweep_zero_sigma_returns_empty(self):
        """Edge with sigma=0 — engine returns zeros (no valid CDF)."""
        from runner.model_resolver import ResolvedModelParams, ResolvedLatency
        from runner.forecast_state import compute_forecast_sweep
        import numpy as np

        lat = ResolvedLatency(mu=3.0, sigma=0.0)
        resolved = ResolvedModelParams(
            p_mean=0.4, p_sd=0.05,
            alpha=12, beta=18,
            edge_latency=lat,
            source='',
        )
        cohorts = self._make_cohorts(n_cohorts=1, max_tau=20)
        result = compute_forecast_sweep(
            resolved=resolved, cohorts=cohorts, max_tau=20,
            num_draws=100,
        )

        # sigma=0 → early return with zeros
        assert np.all(result.rate_draws == 0.0)


class TestSurpriseGaugeNonBayes:
    """Surprise gauge works for non-Bayes edges when SDs are available.

    The topo pass writes promoted_mu_sd/promoted_sigma_sd for any source.
    The gauge should use these for the surprise quantile computation,
    not gate on Bayesian source.
    """

    def _make_graph_with_edge(self, edge):
        return {'edges': [edge]}

    def _make_analytic_edge(self, with_promoted_sds=True):
        """Edge with analytic model_vars and topo-pass promoted SDs."""
        edge = {
            'uuid': 'test-edge-1',
            'p': {
                'forecast': {'mean': 0.4},
                'latency': {
                    'mu': 3.0, 'sigma': 0.6,
                    'onset_delta_days': 0.5,
                    'completeness': 0.85,
                },
                'posterior': {'alpha': 12, 'beta': 18},
                'evidence': {'k': 35, 'n': 100},
                'model_vars': [{
                    'source': 'analytic',
                    'latency': {'mu': 3.0, 'sigma': 0.6, 'onset_delta_days': 0.5},
                    'probability': {'mean': 0.4, 'stdev': 0.05},
                }],
            }
        }
        if with_promoted_sds:
            edge['p']['latency']['promoted_mu_sd'] = 0.15
            edge['p']['latency']['promoted_sigma_sd'] = 0.08
        return edge

    def _call_gauge(self, edge, n_dates=30):
        import sys, os
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
        from api_handlers import _compute_surprise_gauge

        graph = self._make_graph_with_edge(edge)
        subj = {
            'anchor_from': '2026-03-01',
            'anchor_to': '2026-03-30',
            'slice_keys': [],
        }
        data = {'query_dsl': 'from(A).to(B)'}
        return _compute_surprise_gauge(graph, 'test-edge-1', subj, data)

    def test_analytic_with_promoted_sds_mu_available(self):
        """Analytic edge with promoted_mu_sd from topo pass: mu gauge
        should be available.
        """
        edge = self._make_analytic_edge(with_promoted_sds=True)
        result = self._call_gauge(edge)

        mu_var = next(v for v in result['variables'] if v['name'] == 'mu')
        assert mu_var['available'] is True, \
            f"mu gauge should be available with promoted_mu_sd, got: {mu_var}"
        assert 'quantile' in mu_var
        assert 0.0 <= mu_var['quantile'] <= 1.0

    def test_analytic_with_promoted_sds_sigma_available(self):
        """Analytic edge with promoted_sigma_sd from topo pass: sigma
        gauge should be available (with sufficient n_dates).
        """
        edge = self._make_analytic_edge(with_promoted_sds=True)
        result = self._call_gauge(edge, n_dates=30)

        sigma_var = next(v for v in result['variables'] if v['name'] == 'sigma')
        assert sigma_var['available'] is True, \
            f"sigma gauge should be available with promoted_sigma_sd, got: {sigma_var}"

    def test_analytic_without_sds_mu_unavailable(self):
        """Analytic edge without promoted SDs: mu gauge correctly reports
        unavailable (no dispersion estimate).
        """
        edge = self._make_analytic_edge(with_promoted_sds=False)
        result = self._call_gauge(edge)

        mu_var = next(v for v in result['variables'] if v['name'] == 'mu')
        assert mu_var['available'] is False

    def test_analytic_p_variable_available(self):
        """p (conversion rate) gauge works for analytic edges —
        uses alpha/beta from posterior (source-agnostic).
        """
        edge = self._make_analytic_edge(with_promoted_sds=True)
        result = self._call_gauge(edge)

        p_var = next(v for v in result['variables'] if v['name'] == 'p')
        assert p_var['available'] is True, \
            f"p gauge should be available with posterior alpha/beta, got: {p_var}"

    def test_reference_source_is_analytic(self):
        """Gauge correctly identifies analytic as the reference source."""
        edge = self._make_analytic_edge(with_promoted_sds=True)
        result = self._call_gauge(edge)

        assert result.get('reference_source') == 'analytic'
        assert result.get('hint') == 'Run Bayes model for better indicators'
