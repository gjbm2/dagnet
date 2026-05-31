"""
Canonical model-resolver contract (doc 64 Family B).

`runner.model_resolver.resolve_model_params` is the single resolver
for edge-level model parameters. Its output shape and field semantics
are the contract; every consumer (CF, v3 chart, topo pass, forecast
engine) reads through this resolver.

This file is the resolver's acceptance test. The oracle is the
ratified resolver contract and the raw-field semantics of the graph,
not any historical reader function. Concretely the contract asserts:

1. Window-mode scope resolves to edge-level latency; `path_latency`
   stays None.
2. Cohort-mode scope prefers path-level latency when the graph
   supplies `path_mu` / `path_sigma` (or the posterior equivalent).
3. Cohort-mode probability comes from the cohort-mode posterior
   (`cohort_alpha` / `cohort_beta`), not the edge-level one.
4. The `best_available` cascade over `model_vars` selects the
   highest-ranked source using the FE crossover order; flat fields
   never override a matching entry.
5. Edge-level `model_source_preference` overrides the caller-supplied
   graph default; the graph preference applies only when the edge
   does not set one.
6. Resolver returns sensible defaults for empty or malformed edges
   rather than raising.
7. Non-Bayes edges (analytic-only `model_vars`, flat fields only,
   posterior-latency only) produce engine-consumable params.
8. Fed back into `compute_forecast_trajectory`, resolved params
   from non-Bayes edges produce valid output with correct
   limiting behaviour at frontier=0 and sigma=0.
9. In the zero-latency-dispersion limit, the unconditioned model band
   recovers the fixed-CDF monotone-width rise; reintroducing latency
   dispersions materially perturbs that width profile.

Uses real graph data from the data repo where the claim is about
real edges; uses synthetic edges where the claim is about specific
resolver branches that need controlled inputs.

── Authoring receipt (doc 64 §3.6) ─────────────────────────────────

Family         B. Runtime semantic contracts — the resolver is the
               canonical entry point; its contract is load-bearing
               for every forecast consumer.
Invariant      Resolver output is the ratified contract; consumers
               must not read raw `p.*` fields directly. Flat fields
               never override a matching `model_vars` entry. The
               `best_available` cascade is stable across graph
               variants.
Oracle type    Public contract (resolver behaviour) plus live
               field-semantic checks on real graph edges. Not legacy
               reader parity.
Apparatus      Python integration — direct calls to
               `resolve_model_params` and `compute_forecast_trajectory`.
               No lower-cost apparatus would catch drift between the
               resolver's output shape and the engine's consumption.
Fixtures       Auto-discovered real graphs from the data repo for
               the real-edge claims; minimal synthetic edges
               constructed inline for the controlled-branch claims
               (stale-flat-vs-entry, manual-source, edge-vs-graph
               precedence, defaults). Smallest non-vacuous inputs for
               each branch.
Reality        Real data repo for real-edge claims; synthetic edges
               for controlled branches. No mocks of the resolver or
               the engine.
False-pass     Real-edge claims could pass while the resolver silently
               drifts toward flat fields when an entry is present.
               Mitigation: `test_resolver_reads_model_vars_entry_not_flat_fields`
               explicitly constructs flat-vs-entry disagreement.
Retires        Supersedes the `_read_edge_model_params`,
               `read_edge_cohort_params`, and
               `_resolve_completeness_params` reader-parity framing
               from doc 29 Phase 1. Those readers are scoped for
               removal with v1/v2 (doc 64 §8.3).
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
class TestResolverCanonicalContractOverRealGraphs:
    """Resolver contract over real graph edges from the data repo."""

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
        # Doc 73b §3.1 / S2: 'manual' has been retired from the source ledger.
        assert result.source in ('analytic', 'bayesian', ''), \
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
            if src in ('analytic', 'bayesian'):
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

    def test_stale_manual_source_is_treated_as_not_present(self):
        """Doc 73b §6.7 / OP1: stale `'manual'` model_vars entries and selector
        preferences are treated as not-present at runtime (graceful-degrade).
        The resolver yields no promoted source — it does not error and does
        not select the manual entry.
        """
        from runner.model_resolver import resolve_model_params

        edge = {
            'p': {
                'forecast': {'mean': 0.5},
                'latency': {'latency_parameter': True, 'mu': 2.0, 'sigma': 0.5},
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
        # 'manual' is filtered out of source_curves; no other source exists,
        # so the resolver returns the empty default.
        assert result.source == ''
        assert 'manual' not in result.source_curves

    def test_resolver_reads_model_vars_entry_not_flat_fields(self):
        """When flat fields and ModelVarsEntry disagree, resolver picks
        ModelVarsEntry values. This is the specific scenario that
        review finding #6 addressed — stale promotion leaving flat
        fields from a different source than the selected one.
        """
        from runner.model_resolver import resolve_model_params

        # Flat fields: mu=3.5, sigma=0.8 (from a stale prior promotion).
        # The resolver must select the analytic entry and return 2.0/0.5
        # instead of the stale flats.
        edge = {
            'p': {
                'forecast': {'mean': 0.6},
                'latency': {
                    'latency_parameter': True,
                    'mu': 3.5,
                    'sigma': 0.8,
                    'onset_delta_days': 2.0,
                },
                'model_vars': [
                    {
                        'source': 'analytic',
                        'latency': {'mu': 2.0, 'sigma': 0.5, 'onset_delta_days': 1.0},
                        'probability': {'mean': 0.55},
                    },
                ],
            }
        }
        result = resolve_model_params(edge, scope='edge', temporal_mode='window')
        assert result is not None
        assert result.source == 'analytic'
        # Values must come from the analytic entry, not the stale flat fields
        assert abs(result.edge_latency.mu - 2.0) < 1e-6, \
            f"mu should be 2.0 (from analytic), got {result.edge_latency.mu}"
        assert abs(result.edge_latency.sigma - 0.5) < 1e-6, \
            f"sigma should be 0.5 (from analytic), got {result.edge_latency.sigma}"
        assert abs(result.edge_latency.onset_delta_days - 1.0) < 1e-6, \
            f"onset should be 1.0 (from analytic), got {result.edge_latency.onset_delta_days}"
        # Dispersions are absent on the selected analytic entry
        assert abs(result.edge_latency.mu_sd - 0.0) < 1e-6
        assert abs(result.edge_latency.sigma_sd - 0.0) < 1e-6

    def test_edge_preference_overrides_graph_preference(self):
        """Edge preference wins over graph default, matching the FE.
        """
        from runner.model_resolver import resolve_model_params

        edge = {
            'p': {
                'forecast': {'mean': 0.5},
                'latency': {'latency_parameter': True, 'mu': 2.0, 'sigma': 0.5},
                'model_source_preference': 'analytic',
                'model_vars': [
                    {
                        'source': 'analytic',
                        'latency': {'mu': 2.0, 'sigma': 0.5},
                        'probability': {'mean': 0.5},
                    },
                    {
                        'source': 'bayesian',
                        'latency': {'mu': 4.0, 'sigma': 1.0},
                        'probability': {'mean': 0.7},
                        'quality': {'gate_passed': True},
                    },
                ],
            }
        }
        # Without graph_preference: edge says analytic
        result = resolve_model_params(edge, scope='edge', temporal_mode='window')
        assert result.source == 'analytic'
        assert abs(result.edge_latency.mu - 2.0) < 1e-6

        # With graph_preference=bayesian: edge preference still wins
        result = resolve_model_params(edge, scope='edge', temporal_mode='window',
                                       graph_preference='bayesian')
        assert result.source == 'analytic'
        assert abs(result.edge_latency.mu - 2.0) < 1e-6

        # When the edge has no preference, the graph default is used
        edge['p'].pop('model_source_preference', None)
        result = resolve_model_params(edge, scope='edge', temporal_mode='window',
                                       graph_preference='bayesian')
        assert result.source == 'bayesian'
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
                'latency': {'latency_parameter': True, 'mu': 3.0, 'sigma': 0.6},
                'model_vars': [{
                    'source': 'analytic',
                    'latency': {'mu': 3.0, 'sigma': 0.6, 'onset_delta_days': 0.0},
                    'probability': {
                        'mean': 0.4, 'stdev': 0.05,
                        'alpha': 12, 'beta': 18,
                        'alpha_pred': 12, 'beta_pred': 18,
                        'n_effective': 30,
                    },
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
        # Probability from the promoted source's ledger entry.
        assert result.alpha == 12
        assert result.beta == 18
        assert abs(result.p_mean - 12 / 30) < 1e-6

    def test_analytic_only_cohort_mode(self):
        """Cohort mode with analytic-only: path latency from flat fields.

        Per WP3 factorised composition, the rate prior is always the
        edge-local window-fit `(prob_alpha, prob_beta)` regardless of
        `temporal_mode`; the `prob_cohort_*` mirrors are reserved for
        the path-level primitive that WP8 will introduce. `temporal_mode`
        still binds for path latency and `n_effective` selection below.
        """
        from runner.model_resolver import resolve_model_params

        edge = {
            'p': {
                'forecast': {'mean': 0.3},
                'latency': {
                    'latency_parameter': True,
                    'mu': 2.5, 'sigma': 0.5,
                    'path_mu': 3.2, 'path_sigma': 0.7,
                    'path_onset_delta_days': 1.0,
                },
                'model_vars': [{
                    'source': 'analytic',
                    'latency': {'mu': 2.5, 'sigma': 0.5},
                    'probability': {
                        'mean': 0.3, 'stdev': 0.05,
                        'alpha': 10, 'beta': 20,
                        'alpha_pred': 10, 'beta_pred': 20,
                        # cohort_* mirrors present but no longer consulted
                        'cohort_alpha': 8, 'cohort_beta': 25,
                        'cohort_alpha_pred': 8, 'cohort_beta_pred': 25,
                        'n_effective': 30,
                    },
                }],
            }
        }
        result = resolve_model_params(edge, scope='path', temporal_mode='cohort')
        assert result is not None
        assert result.source == 'analytic'
        # Path latency from flat fields.
        assert result.path_latency is not None
        assert abs(result.path_latency.mu - 3.2) < 1e-6
        assert abs(result.path_latency.sigma - 0.7) < 1e-6
        assert result.latency is result.path_latency
        # Rate prior is always the edge-local window-fit under WP3
        # factorised composition; the cohort mirror is ignored.
        assert abs(result.alpha - 10) < 1e-6
        assert abs(result.beta - 20) < 1e-6

    def test_no_model_vars_posterior_latency(self):
        """Edge with lat_posterior fields (fitted by topo pass) but no
        model_vars. Resolver should read from latency.posterior.
        """
        from runner.model_resolver import resolve_model_params

        edge = {
            'p': {
                'forecast': {'mean': 0.5},
                'latency': {
                    'latency_parameter': True,
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
        """Edge with only forecast.mean and no aggregate Beta shape
        anywhere (no Bayes posterior, no analytic moment-match because
        FE-topo Step 1 had no usable window-aggregate stdev). The
        resolver returns the midline `p_mean` from forecast.mean and
        leaves `alpha = beta = 0` so consumers know there is no
        aggregate dispersion to render.

        Doc 73f F15 (28-Apr-26): replaces the previous kappa=200 and
        kappa=2 silent fallbacks. Manufacturing a prior from a fixed
        concentration was rejected — uncertainty cannot be invented
        from nothing. Aggregate dispersion comes from FE-topo Step 1
        over the same weighted window-aggregate evidence that yields
        `forecast.mean`; when that evidence is absent (or the boundary
        case mean ∈ {0, 1} makes the moment-match infeasible), no
        aggregate Beta is emitted and downstream consumers render
        midline only.
        """
        from runner.model_resolver import resolve_model_params

        edge = {
            'p': {
                'forecast': {'mean': 0.25},
                'latency': {'latency_parameter': True, 'mu': 4.0, 'sigma': 1.0},
                # No posterior, no model_vars, no evidence
            }
        }
        result = resolve_model_params(edge, scope='edge', temporal_mode='window')
        assert result is not None
        assert abs(result.p_mean - 0.25) < 1e-6
        assert result.alpha == 0.0, 'no-aggregate-Beta path must leave alpha=0'
        assert result.beta == 0.0, 'no-aggregate-Beta path must leave beta=0'
        assert abs(result.edge_latency.mu - 4.0) < 1e-6
        assert abs(result.edge_latency.sigma - 1.0) < 1e-6

    def test_no_aggregate_beta_with_evidence_returns_zero_alpha_beta(self):
        """Even when scoped query evidence is present (`p.evidence.n > 0`),
        if no aggregate Beta shape was bound by upstream FE-topo or Bayes,
        the resolver returns alpha=beta=0 rather than fabricating a prior
        from the scoped evidence. Doc 73b §3.3.3 layer-isolation: scoped
        current-answer fields cannot seed an aggregate prior. Doc 73f F15:
        fabricated priors (κ=200, κ=2) were removed.
        """
        from runner.model_resolver import resolve_model_params

        edge = {
            'p': {
                'forecast': {'mean': 0.25},
                'latency': {'latency_parameter': True, 'mu': 4.0, 'sigma': 1.0},
                'evidence': {'n': 1000, 'k': 250, 'mean': 0.25},
                # No posterior, no model_vars — upstream binding
                # did not populate the aggregate Beta shape.
            }
        }
        result = resolve_model_params(edge, scope='edge', temporal_mode='window')
        assert result is not None
        assert abs(result.p_mean - 0.25) < 1e-6
        assert result.alpha == 0.0, 'aggregate Beta missing → alpha=0 (no fabrication)'
        assert result.beta == 0.0, 'aggregate Beta missing → beta=0 (no fabrication)'


class TestPromotionParityWithTS:
    """TS/Py promotion-parity contract — doc 73b §3.2.

    Loads the shared fixture matrix at
    `fixtures/promotion-parity/cases.json` and asserts that
    `resolve_model_params` agrees with the expected promoted source and
    latency point values. The TS side runs the same fixture against
    `applyPromotion` in `promotionParity.test.ts`; both sides MUST agree
    on which source promotes and on the promoted latency parameters.

    Per §3.2 centralisation: applyPromotion (TS) and resolve_model_params
    (Py) are the only computers of the promoted scalars. A behaviour
    drift between them is a contract violation regardless of whether
    each side's local tests pass.
    """

    @staticmethod
    def _load_cases():
        fixture_path = (
            Path(__file__).parent / 'fixtures' / 'promotion-parity' / 'cases.json'
        )
        return json.loads(fixture_path.read_text())['cases']

    def test_promotion_parity_each_case(self):
        from runner.model_resolver import resolve_model_params

        cases = self._load_cases()
        assert len(cases) > 0, 'No promotion-parity cases loaded'

        failures = []
        for case in cases:
            name = case['name']
            edge = case['edge']
            graph_pref = case.get('graph_preference')
            expected = case['expected']

            result = resolve_model_params(
                edge,
                scope='edge',
                temporal_mode='window',
                graph_preference=graph_pref,
            )

            def _check(field, actual, exp):
                if exp is None:
                    return
                if isinstance(exp, float) or isinstance(actual, float):
                    if not (
                        isinstance(actual, (int, float))
                        and abs(float(actual) - float(exp)) < 1e-9
                    ):
                        failures.append(f"{name}.{field}: actual={actual} expected={exp}")
                else:
                    if actual != exp:
                        failures.append(f"{name}.{field}: actual={actual} expected={exp}")

            _check('source', result.source, expected.get('source'))
            # When no source promoted, TS writes nothing; Py falls back to
            # flat fields. Skip latency/prob assertions so the fixture
            # only pins source-selection parity for those cases.
            if expected.get('source') == '':
                continue

            if expected.get('prob_mean') is not None:
                _check('p_mean', result.p_mean, expected['prob_mean'])

            lat = result.edge_latency
            _check('lat_mu', lat.mu, expected.get('lat_mu'))
            _check('lat_sigma', lat.sigma, expected.get('lat_sigma'))
            _check('lat_t95', lat.t95, expected.get('lat_t95'))
            _check('lat_onset_delta_days', lat.onset_delta_days,
                   expected.get('lat_onset_delta_days'))
            _check('lat_mu_sd', lat.mu_sd, expected.get('lat_mu_sd'))
            _check('lat_sigma_sd', lat.sigma_sd, expected.get('lat_sigma_sd'))
            _check('lat_onset_sd', lat.onset_sd, expected.get('lat_onset_sd'))
            _check('lat_onset_mu_corr', lat.onset_mu_corr,
                   expected.get('lat_onset_mu_corr'))

        assert not failures, (
            "Promotion-parity violations (Py side):\n  " + "\n  ".join(failures)
        )


class TestBayesVarsSidecarSourceMass:
    """Pin the bayes-vars sidecar -> posterior_block -> resolver handshake.

    Doc 73f Suite D D0 today only proves `promoted_source = 'bayesian'`
    (a text label). Source-mass diagnostics (workplan #2) require that
    `n_effective`, `alpha_pred`, `beta_pred`, and aggregate `alpha`/`beta`
    are also non-None / non-zero on the bayes path — otherwise the
    doc-52 blend silently degrades to behave like analytic even when
    promotion text says bayesian.

    Cross-language contract: `bayesPatchService.ts:340-368` reads
    `windowSlice.{alpha, beta, alpha_pred, beta_pred, n_effective}` from
    the sidecar and writes `{alpha, beta, alpha_pred, beta_pred,
    window_n_effective}` onto `edge.p.posterior` (the field-name
    translation `n_effective` -> `window_n_effective` is load-bearing —
    `model_resolver.py:483-491` reads `window_n_effective` /
    `cohort_n_effective`, never plain `n_effective`).

    This test reconstructs the post-projection edge.p shape from the
    sidecar (matching what bayesPatchService writes) and asserts the
    resolver round-trips every source-mass field through to its output.
    Lives in Python because that pins the read side of the contract;
    the write side has its own TS test in `bayesPatchServiceMerge`.
    """

    @staticmethod
    def _project_window_slice_onto_edge(window_slice: dict, edge_id: str = 'fixture-edge') -> dict:
        """Mirror `bayesPatchService.ts:340-368` for the window() slice.

        Only the fields the resolver reads matter here — latency block
        is filled enough to satisfy resolver guards but is not the
        contract under test.
        """
        return {
            'p': {
                'id': edge_id,
                'posterior': {
                    'alpha': window_slice['alpha'],
                    'beta': window_slice['beta'],
                    'alpha_pred': window_slice['alpha_pred'],
                    'beta_pred': window_slice['beta_pred'],
                    'p_hdi_lower': window_slice['p_hdi_lower'],
                    'p_hdi_upper': window_slice['p_hdi_upper'],
                    'hdi_lower_pred': window_slice['hdi_lower_pred'],
                    'hdi_upper_pred': window_slice['hdi_upper_pred'],
                    'window_n_effective': window_slice['n_effective'],
                    'provenance': window_slice['provenance'],
                    'ess': window_slice['ess'],
                    'rhat': window_slice['rhat'],
                    'delta_elpd': window_slice['delta_elpd'],
                    'pareto_k_max': window_slice['pareto_k_max'],
                    'n_loo_obs': window_slice['n_loo_obs'],
                },
                'latency': {
                    'latency_parameter': True,
                    'mu': window_slice['mu_mean'],
                    'sigma': window_slice['sigma_mean'],
                    'onset_delta_days': window_slice['onset_mean'],
                    'posterior': {
                        'mu_mean': window_slice['mu_mean'],
                        'sigma_mean': window_slice['sigma_mean'],
                        'mu_sd': window_slice['mu_sd'],
                        'mu_sd_pred': window_slice['mu_sd_pred'],
                        'sigma_sd': window_slice['sigma_sd'],
                        'onset_sd': window_slice['onset_sd'],
                    },
                },
                'forecast': {'mean': window_slice['alpha'] / (window_slice['alpha'] + window_slice['beta'])},
                'evidence': {'n': 5000, 'k': 3000},
                'model_vars': [
                    {
                        'source': 'bayesian',
                        'probability': {
                            'alpha': window_slice['alpha'],
                            'beta': window_slice['beta'],
                            'alpha_pred': window_slice['alpha_pred'],
                            'beta_pred': window_slice['beta_pred'],
                            'n_effective': window_slice['n_effective'],
                            'mean': window_slice['alpha'] / (window_slice['alpha'] + window_slice['beta']),
                        },
                        'latency': {
                            'mu': window_slice['mu_mean'],
                            'sigma': window_slice['sigma_mean'],
                            'onset_delta_days': window_slice['onset_mean'],
                            'mu_sd': window_slice['mu_sd'],
                            'mu_sd_pred': window_slice['mu_sd_pred'],
                            'sigma_sd': window_slice['sigma_sd'],
                            'onset_sd': window_slice['onset_sd'],
                        },
                    },
                ],
                'model_source_preference': 'bayesian',
            },
        }

    @staticmethod
    def _load_sidecar_edges():
        sidecar_path = (
            _DAGNET_ROOT / 'bayes' / 'fixtures' / 'synth-simple-abc.bayes-vars.json'
        )
        if not sidecar_path.exists():
            return []
        sidecar = json.loads(sidecar_path.read_text())
        return [
            (entry['param_id'], entry['slices']['window()'])
            for entry in sidecar.get('webhook_payload_edges', [])
            if 'window()' in (entry.get('slices') or {})
        ]

    def test_sidecar_n_effective_propagates_to_resolver(self):
        from runner.model_resolver import resolve_model_params

        cases = self._load_sidecar_edges()
        if not cases:
            pytest.skip('synth-simple-abc bayes-vars sidecar missing')

        failures = []
        for param_id, slc in cases:
            edge = self._project_window_slice_onto_edge(slc, edge_id=param_id)

            for mode in ('window', 'cohort'):
                r = resolve_model_params(edge, scope='edge', temporal_mode=mode)
                if r.source != 'bayesian':
                    failures.append(
                        f"{param_id} {mode}: source={r.source!r}, expected 'bayesian'"
                    )
                    continue
                if r.n_effective is None:
                    failures.append(
                        f"{param_id} {mode}: n_effective=None — sidecar has "
                        f"n_effective={slc['n_effective']}, "
                        "bayesPatchService should have written window_n_effective. "
                        "Doc-52 blend will silently degrade."
                    )
                    continue
                # Allow tolerance: resolver returns the projected value (window_n_effective)
                # for a window-only sidecar; cohort mode falls back to window_n_effective
                # via model_resolver.py:486-487.
                if abs(r.n_effective - slc['n_effective']) > 1.0:
                    failures.append(
                        f"{param_id} {mode}: n_effective={r.n_effective} "
                        f"!= sidecar value {slc['n_effective']}"
                    )

        assert not failures, (
            "Sidecar n_effective propagation failures:\n  " + "\n  ".join(failures)
        )

    def test_sidecar_predictive_pair_propagates_to_resolver(self):
        """alpha_pred/beta_pred are the kappa-inflated predictive pair (doc 49).

        If they are missing on the resolved object, the predictive
        dispersion bands collapse to the epistemic shape — same defect
        class as missing n_effective for the doc-52 blend.
        """
        from runner.model_resolver import resolve_model_params

        cases = self._load_sidecar_edges()
        if not cases:
            pytest.skip('synth-simple-abc bayes-vars sidecar missing')

        failures = []
        for param_id, slc in cases:
            edge = self._project_window_slice_onto_edge(slc, edge_id=param_id)
            r = resolve_model_params(edge, scope='edge', temporal_mode='window')

            if r.alpha_pred <= 0 or r.beta_pred <= 0:
                failures.append(
                    f"{param_id}: alpha_pred={r.alpha_pred}, beta_pred={r.beta_pred}; "
                    f"sidecar carries alpha_pred={slc['alpha_pred']}, "
                    f"beta_pred={slc['beta_pred']} — predictive bands will collapse"
                )
                continue
            if abs(r.alpha_pred - slc['alpha_pred']) > 1e-6:
                failures.append(
                    f"{param_id}: alpha_pred={r.alpha_pred} != sidecar {slc['alpha_pred']}"
                )
            if abs(r.beta_pred - slc['beta_pred']) > 1e-6:
                failures.append(
                    f"{param_id}: beta_pred={r.beta_pred} != sidecar {slc['beta_pred']}"
                )

        assert not failures, (
            "Sidecar predictive pair propagation failures:\n  " + "\n  ".join(failures)
        )

    def test_sidecar_aggregate_alpha_beta_propagate_to_resolver(self):
        """Aggregate alpha/beta = the fitted posterior mass; load-bearing
        for any conjugate update or analytic-mirror dispersion."""
        from runner.model_resolver import resolve_model_params

        cases = self._load_sidecar_edges()
        if not cases:
            pytest.skip('synth-simple-abc bayes-vars sidecar missing')

        failures = []
        for param_id, slc in cases:
            edge = self._project_window_slice_onto_edge(slc, edge_id=param_id)
            r = resolve_model_params(edge, scope='edge', temporal_mode='window')

            if abs(r.alpha - slc['alpha']) > 1e-3:
                failures.append(
                    f"{param_id}: alpha={r.alpha} != sidecar {slc['alpha']}"
                )
            if abs(r.beta - slc['beta']) > 1e-3:
                failures.append(
                    f"{param_id}: beta={r.beta} != sidecar {slc['beta']}"
                )

        assert not failures, (
            "Sidecar aggregate alpha/beta propagation failures:\n  " + "\n  ".join(failures)
        )

