"""Integration tests for the conversion_funnel runner (doc 52).

Exercises run_conversion_funnel end-to-end on a synthetic linear
3-stage graph. Covers:

- e mode (raw evidence from CF response, Wilson CI)
- f mode (Beta draws from promoted-source posteriors — no CF needed)
- e+f mode (CF response drives both the e and e+f bars)
- Topology rejection (non-linear, visitedAny)
- Output schema (rows, metrics, hi/lo fields)

The CF handler is mocked by monkey-patching `_whole_graph_cf`
so these tests don't depend on snapshot DB or a running BE.
"""

from dataclasses import dataclass, field
from typing import Any, Optional

import pytest

from runner import runners
from runner.graph_builder import build_networkx_graph


# ── Fixtures ─────────────────────────────────────────────────────────


def _make_linear_graph(n_stages: int = 3) -> dict[str, Any]:
    """Build a linear 3-stage graph dict: A → B → C (2 edges, 3 nodes).

    Each edge carries:
      - p.posterior.{alpha, beta} (for f mode)
      - p.evidence.{n, k} (for e mode)
      - p.model_vars[source='bayesian'] (for promotion)
      - p.forecast.mean, p.mean (for run_path compatibility)

    Rates: edge_0 ≈ 0.6, edge_1 ≈ 0.5 so cumulative reach ≈ 0.3 at stage 2.
    """
    labels = ['A', 'B', 'C', 'D', 'E'][:n_stages]
    nodes = [
        {'uuid': lbl, 'id': lbl, 'label': lbl}
        for lbl in labels
    ]
    edges = []
    # Edge 0 (A→B): α=60, β=40, n=100, k=60
    # Edge 1 (B→C): α=30, β=30, n=60,  k=30
    edge_params = [
        {'alpha': 60, 'beta': 40, 'n': 100, 'k': 60},
        {'alpha': 30, 'beta': 30, 'n': 60, 'k': 30},
        {'alpha': 20, 'beta': 20, 'n': 30, 'k': 20},
    ]
    for i in range(n_stages - 1):
        ep = edge_params[i]
        mean = ep['alpha'] / (ep['alpha'] + ep['beta'])
        edges.append({
            'uuid': f'edge_{i}',
            'from': labels[i],
            'to': labels[i + 1],
            'p': {
                'mean': mean,
                'evidence': {'n': ep['n'], 'k': ep['k'], 'mean': ep['k'] / ep['n']},
                'forecast': {'mean': mean},
                'posterior': {
                    'alpha': ep['alpha'], 'beta': ep['beta'],
                    'alpha_pred': ep['alpha'], 'beta_pred': ep['beta'],
                },
                'model_vars': [{
                    'source': 'bayesian',
                    'probability': {
                        'alpha': ep['alpha'], 'beta': ep['beta'],
                        'alpha_pred': ep['alpha'], 'beta_pred': ep['beta'],
                        'mean': mean,
                    },
                    'latency': {'mu': 2.0, 'sigma': 0.5},
                    'quality': {'gate_passed': True},
                }],
                'latency': {'mu': 2.0, 'sigma': 0.5},
            },
        })
    return {'nodes': nodes, 'edges': edges}


@dataclass
class _FakeScenario:
    """Minimal stand-in for ScenarioData for tests."""
    scenario_id: str
    name: str
    colour: str = '#3b82f6'
    visibility_mode: str = 'f+e'
    graph: dict = field(default_factory=dict)
    effective_query_dsl: str = 'cohort(-30d:)'
    candidate_regimes_by_edge: Optional[dict] = None


def _fake_whole_graph_cf(
    n_edges: int,
    p_mean: float = 0.55,
    p_sd: float = 0.05,
    evidence_from_graph: bool = True,
):
    """Build a mocked replacement for runners._whole_graph_cf.

    The runner issues ONE whole-graph CF call per scenario (no
    analytics_dsl) and extracts its funnel path by (from_node, to_node).
    This mock returns a whole-graph-shape response: one edge entry per
    (X_i → X_{i+1}) pair in the first `n_edges` of chain A→B→C→D→E.

    When `evidence_from_graph` is True (the default), evidence_k/n are
    read from the scenario graph's edge.p.evidence so tests that assert
    "bar = k/n from graph" pass identically through the new path.
    """
    chain_labels = ['A', 'B', 'C', 'D', 'E']

    def _responder(scenarios_payload):
        scenarios_out = []
        for sc in scenarios_payload:
            graph_edges = (sc.get('graph') or {}).get('edges') or []
            edge_by_pair = {
                (e.get('from'), e.get('to')): e for e in graph_edges
            }
            edges: list[dict] = []
            for i in range(n_edges):
                fl, tl = chain_labels[i], chain_labels[i + 1]
                ev = {}
                if evidence_from_graph:
                    ge = edge_by_pair.get((fl, tl))
                    if ge is not None:
                        evg = (ge.get('p') or {}).get('evidence') or {}
                        ev = {'evidence_k': evg.get('k'), 'evidence_n': evg.get('n')}
                edges.append({
                    'edge_uuid': f'edge_{i}',
                    'from_node': fl,
                    'to_node': tl,
                    'p_mean': p_mean,
                    'p_sd': p_sd,
                    'p_sd_epistemic': p_sd,
                    'completeness': 0.9,
                    'completeness_sd': 0.02,
                    'tau_max': 100,
                    'n_rows': 30,
                    'n_cohorts': 15,
                    **ev,
                })
            scenarios_out.append({
                'scenario_id': sc['scenario_id'],
                'success': True,
                'edges': edges,
                'skipped_edges': [],
            })
        return {'success': True, 'scenarios': scenarios_out}
    return _responder


# ── Tests ────────────────────────────────────────────────────────────


@pytest.fixture
def cf_from_graph(monkeypatch):
    """Default-install a whole-graph CF mock that sources evidence from
    the scenario graph's edge.p.evidence. Tests that need different
    p_mean/p_sd values can call this fixture and then re-monkeypatch."""
    monkeypatch.setattr(
        runners, '_whole_graph_cf',
        _fake_whole_graph_cf(n_edges=4, p_mean=0.55, p_sd=0.05, evidence_from_graph=True),
    )


class TestLinearFunnelEMode:
    def test_e_mode_bars_match_evidence_ratios(self, cf_from_graph):
        graph_data = _make_linear_graph(3)
        G = build_networkx_graph(graph_data)
        scenario = _FakeScenario(
            scenario_id='current', name='Current',
            visibility_mode='e', graph=graph_data,
        )
        result = runners.run_conversion_funnel(
            G, 'A', 'C', intermediate_nodes=['B'],
            all_scenarios=[scenario],
            from_node='A', to_node='C',
        )
        assert 'error' not in result
        rows = result['data']
        # One row per stage for the single scenario
        assert len(rows) == 3
        # stage 0: bar = 1.0
        assert rows[0]['probability'] == pytest.approx(1.0)
        # stage 1: bar = k0/n0 = 60/100
        assert rows[1]['probability'] == pytest.approx(0.60, abs=1e-9)
        # stage 2: bar = k1/n0 = 30/100
        assert rows[2]['probability'] == pytest.approx(0.30, abs=1e-9)
        # Wilson bands present on stages 1, 2
        for r in rows[1:]:
            assert 'probability_lo' in r
            assert 'probability_hi' in r
            assert r['probability_lo'] < r['probability'] < r['probability_hi']

    def test_e_mode_metadata(self, cf_from_graph):
        graph_data = _make_linear_graph(3)
        G = build_networkx_graph(graph_data)
        scenario = _FakeScenario(
            scenario_id='current', name='Current',
            visibility_mode='e', graph=graph_data,
        )
        result = runners.run_conversion_funnel(
            G, 'A', 'C', intermediate_nodes=['B'],
            all_scenarios=[scenario], from_node='A', to_node='C',
        )
        md = result['metadata']
        assert md['is_conversion_funnel'] is True
        assert md['from_label'] == 'A'
        assert md['to_label'] == 'C'


class TestLinearFunnelFMode:
    def test_f_mode_bars_match_path_product_of_means(self):
        graph_data = _make_linear_graph(3)
        G = build_networkx_graph(graph_data)
        scenario = _FakeScenario(
            scenario_id='current', name='Current',
            visibility_mode='f', graph=graph_data,
        )
        result = runners.run_conversion_funnel(
            G, 'A', 'C', intermediate_nodes=['B'],
            all_scenarios=[scenario], from_node='A', to_node='C',
        )
        assert 'error' not in result
        rows = result['data']
        assert rows[0]['probability'] == pytest.approx(1.0)
        # Expected: 0.6 * 0.5 = 0.30 (α/(α+β) path product)
        assert rows[2]['probability'] == pytest.approx(0.30, rel=0.05)

    def test_f_mode_has_bands(self):
        graph_data = _make_linear_graph(3)
        G = build_networkx_graph(graph_data)
        scenario = _FakeScenario(
            scenario_id='current', name='Current',
            visibility_mode='f', graph=graph_data,
        )
        result = runners.run_conversion_funnel(
            G, 'A', 'C', intermediate_nodes=['B'],
            all_scenarios=[scenario], from_node='A', to_node='C',
        )
        rows = result['data']
        for r in rows[1:]:
            assert 'probability_lo' in r
            assert 'probability_hi' in r
            assert r['probability_lo'] < r['probability_hi']


class TestLinearFunnelEFMode:
    def test_ef_mode_calls_scoped_cf_and_uses_response(self, monkeypatch):
        graph_data = _make_linear_graph(3)
        G = build_networkx_graph(graph_data)
        scenario = _FakeScenario(
            scenario_id='current', name='Current',
            visibility_mode='f+e', graph=graph_data,
        )

        # Mock the scoped CF call
        responder = _fake_whole_graph_cf(n_edges=2, p_mean=0.7, p_sd=0.05)
        monkeypatch.setattr(runners, '_whole_graph_cf', responder)

        result = runners.run_conversion_funnel(
            G, 'A', 'C', intermediate_nodes=['B'],
            all_scenarios=[scenario], from_node='A', to_node='C',
        )
        assert 'error' not in result
        rows = result['data']
        # Bars: stage 0 = 1.0; stage 1 = 0.7; stage 2 = 0.49
        assert rows[0]['probability'] == pytest.approx(1.0)
        assert rows[1]['probability'] == pytest.approx(0.7, abs=1e-9)
        assert rows[2]['probability'] == pytest.approx(0.49, abs=1e-9)
        # Striation fields present
        for r in rows:
            assert 'bar_height_e' in r
            assert 'bar_height_f_residual' in r

    def test_ef_mode_falls_back_when_cf_returns_wrong_edge_count(self, monkeypatch):
        """CF returning wrong edge count: chart still renders, bands skipped."""
        graph_data = _make_linear_graph(3)
        G = build_networkx_graph(graph_data)
        scenario = _FakeScenario(
            scenario_id='current', name='Current',
            visibility_mode='f+e', graph=graph_data,
        )
        # CF returns only 1 edge but path has 2
        responder = _fake_whole_graph_cf(n_edges=1)
        monkeypatch.setattr(runners, '_whole_graph_cf', responder)
        result = runners.run_conversion_funnel(
            G, 'A', 'C', intermediate_nodes=['B'],
            all_scenarios=[scenario], from_node='A', to_node='C',
        )
        assert 'error' not in result
        # Baseline rows still present
        assert len(result['data']) == 3
        # Per-scenario band skip noted in metadata
        skips = result['metadata'].get('hi_lo_bands_skipped_per_scenario') or {}
        assert 'current' in skips
        assert 'returned no edge' in skips['current']
        # No band fields on the rows for this scenario
        for row in result['data']:
            assert 'probability_lo' not in row
            assert 'probability_hi' not in row

    def test_ef_mode_falls_back_when_cf_fails(self, monkeypatch):
        """CF endpoint failure: chart still renders from baseline."""
        graph_data = _make_linear_graph(3)
        G = build_networkx_graph(graph_data)
        scenario = _FakeScenario(
            scenario_id='current', name='Current',
            visibility_mode='f+e', graph=graph_data,
        )

        def _failing(payload):
            raise RuntimeError('CF down')

        monkeypatch.setattr(runners, '_whole_graph_cf', _failing)
        result = runners.run_conversion_funnel(
            G, 'A', 'C', intermediate_nodes=['B'],
            all_scenarios=[scenario], from_node='A', to_node='C',
        )
        assert 'error' not in result
        assert len(result['data']) == 3
        assert 'CF down' in (result['metadata'].get('cf_skip_reason') or '')


class TestTopologyFallback:
    def test_non_linear_topology_falls_back_without_bands(self):
        """Non-linear funnel: chart still renders from run_path, bands skipped."""
        graph_data = _make_linear_graph(3)
        # Remove B→C and add A→C: now no direct B→C edge between consecutive
        # funnel stages, so the linear-band augmentation must skip.
        graph_data['edges'] = [
            e for e in graph_data['edges'] if not (e['from'] == 'B' and e['to'] == 'C')
        ]
        graph_data['edges'].append({
            'uuid': 'edge_AC',
            'from': 'A', 'to': 'C',
            'p': {'mean': 0.3, 'evidence': {'n': 100, 'k': 30}},
        })
        G = build_networkx_graph(graph_data)
        scenario = _FakeScenario(
            scenario_id='current', name='Current',
            visibility_mode='e', graph=graph_data,
        )
        result = runners.run_conversion_funnel(
            G, 'A', 'C', intermediate_nodes=['B'],
            all_scenarios=[scenario], from_node='A', to_node='C',
        )
        assert 'error' not in result
        assert len(result['data']) == 3  # baseline still emitted
        skip = result['metadata'].get('hi_lo_bands_skipped') or ''
        assert 'non-linear' in skip
        # Rows have no band fields
        for row in result['data']:
            assert 'probability_lo' not in row
            assert 'probability_hi' not in row

    def test_visited_any_groups_fall_back_without_bands(self):
        graph_data = _make_linear_graph(3)
        G = build_networkx_graph(graph_data)
        scenario = _FakeScenario(
            scenario_id='current', name='Current',
            visibility_mode='e', graph=graph_data,
        )
        result = runners.run_conversion_funnel(
            G, 'A', 'C', intermediate_nodes=['B'],
            all_scenarios=[scenario],
            visited_any_groups=[['B', 'D']],  # grouped stage
            from_node='A', to_node='C',
        )
        assert 'error' not in result
        skip = result['metadata'].get('hi_lo_bands_skipped') or ''
        assert 'visitedAny' in skip


class TestNarrowCohortRegression:
    """Regression for cohort(20-Apr-26:20-Apr-26) — narrow cohort with no
    matured observations.

    Expected behaviour (doc 52 §3.5 endpoints):
      - evidence_k = 0, evidence_n = 0 (or tiny, zero maturity)
      - e bars → 0 (no conversions observed yet)
      - f+e bars → small but non-zero (forecast dominates; completeness≈0)
      - hi/lo bands wide for f+e (predictive dispersion)
    """

    def test_empty_scope_produces_zero_e_bars_and_wide_ef_bands(self, monkeypatch):
        graph_data = _make_linear_graph(3)
        G = build_networkx_graph(graph_data)

        # Mock the whole-graph CF to simulate a narrow cohort: evidence
        # counts are zero, completeness is zero, forecast p_mean small.
        def _narrow_cf(scenarios_payload):
            scenarios_out = []
            for sc in scenarios_payload:
                edges = [
                    {
                        'edge_uuid': f'edge_{i}',
                        'from_node': from_lbl,
                        'to_node': to_lbl,
                        'p_mean': 0.5,
                        'p_sd': 0.15,
                        'p_sd_epistemic': 0.02,
                        'completeness': 0.0,
                        'completeness_sd': 0.01,
                        'evidence_k': 0,
                        'evidence_n': 0,
                    }
                    for i, (from_lbl, to_lbl) in enumerate([('A', 'B'), ('B', 'C')])
                ]
                scenarios_out.append({
                    'scenario_id': sc['scenario_id'], 'success': True,
                    'edges': edges, 'skipped_edges': [],
                })
            return {'success': True, 'scenarios': scenarios_out}

        monkeypatch.setattr(runners, '_whole_graph_cf', _narrow_cf)

        scenario_ef = _FakeScenario(
            scenario_id='current', name='Current',
            visibility_mode='f+e', graph=graph_data,
            effective_query_dsl='cohort(20-Apr-26:20-Apr-26)',
        )
        result = runners.run_conversion_funnel(
            G, 'A', 'C', intermediate_nodes=['B'],
            all_scenarios=[scenario_ef], from_node='A', to_node='C',
        )
        assert 'error' not in result
        rows = result['data']

        # e portion must be zero at every stage past stage 0 — no conversions
        # observed. Stage 0 is 1.0 by convention (funnel start).
        assert rows[0].get('bar_height_e') == pytest.approx(1.0, abs=1e-12)
        for r in rows[1:]:
            assert r.get('bar_height_e') == pytest.approx(0.0, abs=1e-12), (
                f'bar_height_e should be 0 for narrow cohort (stage={r.get("stage")}): {r}'
            )

        # Bars (total f+e): stage 0 = 1.0; stage 1 = 0.5; stage 2 = 0.25.
        assert rows[0]['probability'] == pytest.approx(1.0, abs=1e-12)
        assert rows[1]['probability'] == pytest.approx(0.5, abs=1e-9)
        assert rows[2]['probability'] == pytest.approx(0.25, abs=1e-9)

        # Bands must widen at completeness=0: width driven by predictive
        # dispersion (p_sd=0.15). Check that the final-stage band width is
        # meaningfully greater than the epistemic-only width (p_sd_epi=0.02
        # would give < 5% band; predictive should give > 10%).
        s2 = rows[2]
        assert 'probability_lo' in s2 and 'probability_hi' in s2
        band_width = s2['probability_hi'] - s2['probability_lo']
        assert band_width > 0.05, (
            f'Expected wide predictive band at c=0, got width={band_width}'
        )

        # n at stage 0 = CF evidence_n of first edge = 0 (scope-correct).
        assert rows[0].get('n') == 0
        # Completeness at every stage should reflect CF value (0 for narrow cohort).
        for r in rows[1:]:
            assert r.get('completeness') == pytest.approx(0.0, abs=1e-12)


class TestOutputSchema:
    def test_semantics_advertises_hi_lo_metrics(self, cf_from_graph):
        graph_data = _make_linear_graph(3)
        G = build_networkx_graph(graph_data)
        scenario = _FakeScenario(
            scenario_id='current', name='Current',
            visibility_mode='e', graph=graph_data,
        )
        result = runners.run_conversion_funnel(
            G, 'A', 'C', intermediate_nodes=['B'],
            all_scenarios=[scenario], from_node='A', to_node='C',
        )
        metric_ids = {m['id'] for m in result['semantics']['metrics']}
        assert 'probability' in metric_ids
        assert 'probability_lo' in metric_ids
        assert 'probability_hi' in metric_ids
        assert 'bar_height_e' in metric_ids
        assert 'bar_height_f_residual' in metric_ids
        hints = result['semantics']['chart']['hints']
        assert hints.get('show_hi_lo') is True
        assert hints.get('stacked_striation') is True

    def test_dimension_values_stage_and_scenario(self, cf_from_graph):
        graph_data = _make_linear_graph(3)
        G = build_networkx_graph(graph_data)
        scenario = _FakeScenario(
            scenario_id='sc1', name='Scenario 1',
            visibility_mode='e', graph=graph_data,
        )
        result = runners.run_conversion_funnel(
            G, 'A', 'C', intermediate_nodes=['B'],
            all_scenarios=[scenario], from_node='A', to_node='C',
        )
        dv = result['dimension_values']
        assert set(dv['stage'].keys()) == {'A', 'B', 'C'}
        assert 'sc1' in dv['scenario_id']
