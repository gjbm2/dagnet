"""Contract tests for conversion_funnel Level 2 (doc 52 §9.2).

Runs against the synth-mirror-4step graph fixture (linear 4-stage chain:
landing → created → delegated → registered → success).

Tests F1, F2, F4, F5, F6 from doc 52 §9.2. F3 (funnel-cohort_maturity
parity) is deferred — it requires live cohort_maturity execution against
enriched snapshot data; covered separately when enrichment is in place.

CF calls are mocked so these tests run without a DB.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest

from conftest import requires_data_repo, _resolve_data_repo_dir

from runner import runners
from runner.graph_builder import build_networkx_graph
from runner.funnel_engine import wilson_ci


_DATA_REPO_DIR = _resolve_data_repo_dir()

# Linear path through the success chain of synth-mirror-4step
PATH_NODE_IDS = ['m4-landing', 'm4-created', 'm4-delegated', 'm4-registered', 'm4-success']


def _load_synth_4step() -> dict[str, Any]:
    """Load the synth-mirror-4step graph dict. Skip if unavailable."""
    if _DATA_REPO_DIR is None:
        pytest.skip('Data repo not available')
    path = _DATA_REPO_DIR / 'graphs' / 'synth-mirror-4step.json'
    if not path.exists():
        pytest.skip(f'Graph fixture not found at {path}')
    return json.loads(path.read_text())


def _resolve_path_uuids(graph_data: dict[str, Any]) -> list[str]:
    """Map human IDs (m4-landing, etc.) to UUIDs."""
    by_id = {n['id']: n['uuid'] for n in graph_data['nodes']}
    return [by_id[human] for human in PATH_NODE_IDS]


@dataclass
class _Scenario:
    scenario_id: str
    name: str
    graph: dict
    visibility_mode: str = 'f+e'
    colour: str = '#3b82f6'
    effective_query_dsl: str = 'cohort(-90d:)'
    candidate_regimes_by_edge: Optional[dict] = None


def _mock_cf(runners_module, p_means: list[float], p_sds: list[float]):
    """Install a mocked scoped CF response on the runners module.

    Returns a cleanup function. The mock responds to any scenarios in the
    payload with the given per-edge (p_mean, p_sd) arrays.
    """
    n = len(p_means)
    assert len(p_sds) == n

    def _fake(scenarios_payload):
        return {
            'success': True,
            'scenarios': [
                {
                    'scenario_id': sc['scenario_id'],
                    'success': True,
                    'edges': [
                        {
                            'edge_uuid': f'edge_{i}',
                            'from_node': PATH_NODE_IDS[i],
                            'to_node': PATH_NODE_IDS[i + 1],
                            'p_mean': p_means[i],
                            'p_sd': p_sds[i],
                            'completeness': 0.95,
                            'completeness_sd': 0.01,
                        }
                        for i in range(n)
                    ],
                    'skipped_edges': [],
                }
                for sc in scenarios_payload
            ],
        }

    original = runners_module._scoped_conditioned_forecast
    runners_module._scoped_conditioned_forecast = _fake

    def _restore():
        runners_module._scoped_conditioned_forecast = original

    return _restore


def _run_funnel(graph_data: dict, visibility_mode: str) -> dict[str, Any]:
    """Run the funnel on synth-mirror-4step with the given visibility mode."""
    G = build_networkx_graph(graph_data)
    path_uuids = _resolve_path_uuids(graph_data)
    scenario = _Scenario(
        scenario_id='current', name='Current',
        graph=graph_data, visibility_mode=visibility_mode,
    )
    return runners.run_conversion_funnel(
        G,
        start_id=path_uuids[0],
        end_id=path_uuids[-1],
        intermediate_nodes=path_uuids[1:-1],
        all_scenarios=[scenario],
        from_node=PATH_NODE_IDS[0],
        to_node=PATH_NODE_IDS[-1],
    )


def _bar_by_stage(result: dict, stage_uuid: str, scenario_id: str = 'current') -> dict:
    for row in result['data']:
        if row['stage'] == stage_uuid and row['scenario_id'] == scenario_id:
            return row
    raise AssertionError(f'No row for stage={stage_uuid}, scenario={scenario_id}')


# ── Contract tests ───────────────────────────────────────────────────


@requires_data_repo
class TestF1Monotonicity:
    """F1: bar[i+1] <= bar[i] for every stage, every regime, every scenario."""

    def test_e_mode_monotone(self):
        graph_data = _load_synth_4step()
        result = _run_funnel(graph_data, visibility_mode='e')
        assert 'error' not in result, result.get('error')
        path_uuids = _resolve_path_uuids(graph_data)
        probs = [_bar_by_stage(result, u)['probability'] for u in path_uuids]
        for i in range(len(probs) - 1):
            assert probs[i + 1] <= probs[i] + 1e-9, (
                f'e mode not monotone at stage {i}→{i+1}: {probs[i]} → {probs[i+1]}'
            )

    def test_f_mode_monotone(self):
        graph_data = _load_synth_4step()
        result = _run_funnel(graph_data, visibility_mode='f')
        assert 'error' not in result, result.get('error')
        path_uuids = _resolve_path_uuids(graph_data)
        probs = [_bar_by_stage(result, u)['probability'] for u in path_uuids]
        for i in range(len(probs) - 1):
            # Monotone modulo MC noise from Beta draws
            assert probs[i + 1] <= probs[i] + 1e-6

    def test_ef_mode_monotone(self):
        graph_data = _load_synth_4step()
        # Mock CF with descending means — funnel-shaped
        restore = _mock_cf(runners, [0.9, 0.8, 0.7, 0.6], [0.03, 0.03, 0.03, 0.03])
        try:
            result = _run_funnel(graph_data, visibility_mode='f+e')
        finally:
            restore()
        assert 'error' not in result, result.get('error')
        path_uuids = _resolve_path_uuids(graph_data)
        probs = [_bar_by_stage(result, u)['probability'] for u in path_uuids]
        for i in range(len(probs) - 1):
            assert probs[i + 1] <= probs[i] + 1e-9


@requires_data_repo
class TestF2ELessThanOrEqualEF:
    """F2: e bar <= e+f bar at every stage (within 0.1 % tolerance).

    Uses a mock CF whose per-edge means are chosen to dominate per-edge
    observed rates — mimics a conditioned posterior that either matches
    evidence (mature case) or extends beyond it (immature tail
    projection). This is the regime where the invariant should hold
    without qualification.
    """

    def test_e_le_ef_stagewise(self):
        graph_data = _load_synth_4step()
        path_uuids = _resolve_path_uuids(graph_data)
        edge_by_uuids = {(e['from'], e['to']): e for e in graph_data['edges']}

        # Pick CF p_means that dominate observed per-edge means. Real CF
        # output does this naturally for immature cohorts (forecast tail
        # > raw observed rate). Here we inflate each by a factor so the
        # invariant holds by construction.
        n_0 = edge_by_uuids[(path_uuids[0], path_uuids[1])]['p']['evidence']['n']
        cum_k_over_n = []
        for i in range(1, len(path_uuids)):
            edge = edge_by_uuids[(path_uuids[i - 1], path_uuids[i])]
            k_i = edge['p']['evidence']['k']
            cum_k_over_n.append(k_i / n_0)

        # Derive per-edge p_means such that cumprod >= cumulative k/n at every stage
        # by setting p_means_j = cum_k_over_n[j] / cum_k_over_n[j-1] (conditional rate)
        # then inflating slightly.
        p_means: list[float] = []
        prev = 1.0
        for c in cum_k_over_n:
            cond = c / prev if prev > 0 else 0.0
            # Inflate by 10% (but clip to 1.0)
            p_means.append(min(1.0, cond * 1.10))
            prev = c

        restore = _mock_cf(runners, p_means, [0.005] * len(p_means))
        try:
            result_e = _run_funnel(graph_data, visibility_mode='e')
            result_ef = _run_funnel(graph_data, visibility_mode='f+e')
        finally:
            restore()
        assert 'error' not in result_e
        assert 'error' not in result_ef
        for u in path_uuids:
            bar_e = _bar_by_stage(result_e, u)['probability']
            bar_ef = _bar_by_stage(result_ef, u)['probability']
            assert bar_ef >= bar_e - 1e-3, (
                f'stage {u}: e={bar_e} > e+f={bar_ef} (should be e ≤ e+f within 0.1 %)'
            )


@requires_data_repo
class TestF4FModeMatchesPathProductOfPromotedMeans:
    """F4: f median ≈ Π (α/(α+β)) from promoted source, MC tolerance.

    Synth-mirror-4step has analytic-promoted source; resolve_model_params
    falls back to D20 (Beta prior from evidence n/k).
    """

    def test_f_median_matches_path_product_of_evidence_means(self):
        from runner.model_resolver import resolve_model_params

        graph_data = _load_synth_4step()
        path_uuids = _resolve_path_uuids(graph_data)

        # Compute expected path product using resolve_model_params per edge
        # (matches what the runner does internally). The result reflects
        # whatever the promotion hierarchy selects.
        edge_by_uuids = {(e['from'], e['to']): e for e in graph_data['edges']}
        expected_product = 1.0
        for i in range(len(path_uuids) - 1):
            edge = edge_by_uuids[(path_uuids[i], path_uuids[i + 1])]
            resolved = resolve_model_params(edge, scope='edge', temporal_mode='window')
            if resolved is None:
                continue
            a = resolved.alpha_pred or resolved.alpha
            b = resolved.beta_pred or resolved.beta
            if a > 0 and b > 0:
                expected_product *= a / (a + b)

        # Run funnel
        result = _run_funnel(graph_data, visibility_mode='f')
        assert 'error' not in result

        actual_final = _bar_by_stage(result, path_uuids[-1])['probability']
        assert actual_final == pytest.approx(expected_product, rel=0.05), (
            f'f-mode stage-N bar ({actual_final}) != Π promoted-source means ({expected_product})'
        )


@requires_data_repo
class TestF5EFBarEqualsPathProductOfCFMeans:
    """F5: e+f bar = Π edge.p_mean from CF response (deterministic, float-exact)."""

    def test_ef_bar_is_exact_cumprod_of_mocked_cf_means(self):
        graph_data = _load_synth_4step()
        p_means = [0.80, 0.60, 0.70, 0.50]
        restore = _mock_cf(runners, p_means, [0.02] * 4)
        try:
            result = _run_funnel(graph_data, visibility_mode='f+e')
        finally:
            restore()
        assert 'error' not in result
        path_uuids = _resolve_path_uuids(graph_data)

        # Stage 0 = 1.0
        assert _bar_by_stage(result, path_uuids[0])['probability'] == pytest.approx(1.0, abs=1e-12)
        # Stage 1 = p_means[0]
        assert _bar_by_stage(result, path_uuids[1])['probability'] == pytest.approx(p_means[0], abs=1e-12)
        # Stage 2 = p_means[0] * p_means[1]
        assert _bar_by_stage(result, path_uuids[2])['probability'] == pytest.approx(p_means[0] * p_means[1], abs=1e-12)
        # Stage 3, 4: cumulative
        cumulative = p_means[0] * p_means[1]
        for i in range(2, 4):
            cumulative *= p_means[i]
            assert _bar_by_stage(result, path_uuids[i + 1])['probability'] == pytest.approx(cumulative, abs=1e-12)


@requires_data_repo
class TestF6EModeUsesRawCounts:
    """F6: e bar = k/n, Wilson CI matches hand-computed reference."""

    def test_e_bars_equal_k_over_n(self):
        graph_data = _load_synth_4step()
        path_uuids = _resolve_path_uuids(graph_data)
        edge_by_uuids = {(e['from'], e['to']): e for e in graph_data['edges']}

        # n_0 = evidence.n on first edge
        edge_0 = edge_by_uuids[(path_uuids[0], path_uuids[1])]
        n_0 = edge_0['p']['evidence']['n']

        result = _run_funnel(graph_data, visibility_mode='e')
        assert 'error' not in result

        # stage 0 = 1.0
        assert _bar_by_stage(result, path_uuids[0])['probability'] == pytest.approx(1.0, abs=1e-12)

        # stages 1..N: k_i/n_0 where k_i = edges[i-1].evidence.k
        for i in range(1, len(path_uuids)):
            edge = edge_by_uuids[(path_uuids[i - 1], path_uuids[i])]
            k_i = edge['p']['evidence']['k']
            expected = k_i / n_0
            actual = _bar_by_stage(result, path_uuids[i])['probability']
            assert actual == pytest.approx(expected, abs=1e-12), (
                f'stage {i}: expected k/n = {expected}, got {actual}'
            )

    def test_wilson_ci_matches_engine_helper(self):
        graph_data = _load_synth_4step()
        path_uuids = _resolve_path_uuids(graph_data)
        edge_by_uuids = {(e['from'], e['to']): e for e in graph_data['edges']}

        edge_0 = edge_by_uuids[(path_uuids[0], path_uuids[1])]
        n_0 = int(edge_0['p']['evidence']['n'])

        result = _run_funnel(graph_data, visibility_mode='e')
        edge_1 = edge_by_uuids[(path_uuids[0], path_uuids[1])]
        k_1 = int(edge_1['p']['evidence']['k'])
        expected_lo, expected_hi = wilson_ci(k_1, n_0, alpha=0.10)
        stage_1_row = _bar_by_stage(result, path_uuids[1])
        assert stage_1_row['probability_lo'] == pytest.approx(expected_lo, abs=1e-12)
        assert stage_1_row['probability_hi'] == pytest.approx(expected_hi, abs=1e-12)
