from __future__ import annotations

import sys
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

_LIB = Path(__file__).resolve().parent.parent
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from api_handlers import _compute_surprise_gauge, handle_runner_analyze
from runner.cohort_forecast_v3 import compute_cohort_maturity_rows_v3
from runner.forecast_application import compute_completeness
from runner.forecast_runtime import build_closed_form_beta_rate_surface
from runner.model_resolver import ResolvedLatency, ResolvedModelParams


def _query_scoped_latency_resolved() -> ResolvedModelParams:
    return ResolvedModelParams(
        p_mean=0.2,
        p_sd=0.04,
        alpha=20.0,
        beta=80.0,
        alpha_pred=20.0,
        beta_pred=80.0,
        edge_latency=ResolvedLatency(
            mu=2.3,
            sigma=0.5,
            onset_delta_days=0.0,
            t95=23.0,
        ),
        source='analytic_be',
    )


def _latency_graph() -> dict:
    return {
        'edges': [
            {
                'uuid': 'edge-1',
                'from': 'uuid-a',
                'to': 'uuid-b',
                'p': {
                    'forecast': {
                        'mean': 0.2,
                    },
                    'latency': {
                        'latency_parameter': True,
                        'mu': 2.3,
                        'sigma': 0.5,
                        'onset_delta_days': 0.0,
                        't95': 23.0,
                    },
                },
            },
        ],
    }


def _frames() -> list[dict]:
    return [
        {
            'snapshot_date': '2026-04-01',
            'data_points': [
                {
                    'anchor_day': '2026-03-25',
                    'x': 100,
                    'y': 5,
                    'a': 100,
                },
            ],
        },
        {
            'snapshot_date': '2026-04-05',
            'data_points': [
                {
                    'anchor_day': '2026-03-25',
                    'x': 100,
                    'y': 20,
                    'a': 100,
                },
            ],
        },
    ]


def _window_frames_with_young_cohort() -> list[dict]:
    return [
        {
            'snapshot_date': '2026-04-04',
            'data_points': [
                {
                    'anchor_day': '2026-03-31',
                    'x': 100,
                    'y': 15,
                    'a': 100,
                },
                {
                    'anchor_day': '2026-04-03',
                    'x': 50,
                    'y': 2,
                    'a': 50,
                },
            ],
        },
        {
            'snapshot_date': '2026-04-05',
            'data_points': [
                {
                    'anchor_day': '2026-03-31',
                    'x': 100,
                    'y': 20,
                    'a': 100,
                },
                {
                    'anchor_day': '2026-04-03',
                    'x': 50,
                    'y': 3,
                    'a': 50,
                },
            ],
        },
    ]


def _daily_conversion_rows() -> list[dict]:
    return [
        {
            'param_id': 'pytest-param',
            'core_hash': 'hash',
            'slice_key': '',
            'anchor_day': '2026-04-04',
            'retrieved_at': '2026-04-05T12:00:00+00:00',
            'x': 100,
            'y': 5,
        },
    ]


def test_query_scoped_latency_rows_use_degraded_contract():
    # NOTE:
    # The provenance assertions below still describe the intended live
    # contract after doc-57-style "no re-conditioning" handling.
    #
    # The exact numeric expectations at the end of the test may now fail for
    # a structural reason: the dedicated degraded latency-row branch was
    # deleted, so these rows are now produced by the shared engine path with
    # rate conditioning skipped rather than by the old closed-form helper.
    # If this test stays red, the most likely seam is "old degraded numeric
    # oracle vs shared-path output", not missing degraded provenance.
    rows = compute_cohort_maturity_rows_v3(
        frames=_frames(),
        graph=_latency_graph(),
        target_edge_id='edge-1',
        query_from_node='node-a',
        query_to_node='node-b',
        anchor_from='2026-03-25',
        anchor_to='2026-03-25',
        sweep_to='2026-04-05',
        is_window=True,
        resolved_override=_query_scoped_latency_resolved(),
    )

    assert rows
    first = rows[0]
    last = rows[-1]

    assert first['_cf_mode'] == 'analytic_degraded'
    assert first['_cf_reason'] == 'query_scoped_posterior'
    assert first['_conditioning'] == {
        'r': None,
        'm_S': None,
        'm_G': None,
        'applied': False,
        'skip_reason': 'source_query_scoped',
    }
    assert first['_conditioned'] is True

    assert last['p_infinity_mean'] == pytest.approx(0.2)
    assert last['p_infinity_sd'] == pytest.approx(last['p_infinity_sd_epistemic'])

    expected_last_midpoint = 0.2 * compute_completeness(
        last['tau_days'], 2.3, 0.5, 0.0,
    )
    assert last['midpoint'] == pytest.approx(expected_last_midpoint)
    assert last['model_midpoint'] == pytest.approx(last['midpoint'])


def test_query_scoped_latency_rows_keep_window_denominator_fixed():
    rows = compute_cohort_maturity_rows_v3(
        frames=_window_frames_with_young_cohort(),
        graph=_latency_graph(),
        target_edge_id='edge-1',
        query_from_node='node-a',
        query_to_node='node-b',
        anchor_from='2026-03-31',
        anchor_to='2026-04-03',
        sweep_to='2026-04-05',
        is_window=True,
        resolved_override=_query_scoped_latency_resolved(),
    )

    rows_by_tau = {row['tau_days']: row for row in rows}

    assert rows_by_tau[0]['evidence_x'] is None
    assert rows_by_tau[2]['evidence_x'] == pytest.approx(150.0)
    assert rows_by_tau[2]['evidence_y'] == pytest.approx(3.0)
    assert rows_by_tau[2]['rate'] == pytest.approx(3.0 / 150.0)
    assert rows_by_tau[4]['evidence_x'] == pytest.approx(150.0)
    assert rows_by_tau[4]['evidence_y'] == pytest.approx(18.0)
    assert rows_by_tau[4]['rate'] == pytest.approx(18.0 / 150.0)
    assert rows_by_tau[5]['evidence_x'] == pytest.approx(150.0)
    assert rows_by_tau[5]['evidence_y'] == pytest.approx(23.0)
    assert rows_by_tau[5]['rate'] == pytest.approx(23.0 / 150.0)


def test_surprise_gauge_unavailable_for_query_scoped_posterior(monkeypatch: pytest.MonkeyPatch):
    from runner import model_resolver

    monkeypatch.setattr(
        model_resolver,
        'resolve_model_params',
        lambda *args, **kwargs: _query_scoped_latency_resolved(),
    )

    result = _compute_surprise_gauge(
        graph_data=_latency_graph(),
        target_id='edge-1',
        subj={'slice_keys': []},
        data={'query_dsl': 'window(-30d:)'},
    )

    assert result['error'] == 'query_scoped_posterior'
    assert result['cf_mode'] == 'analytic_degraded'
    assert result['cf_reason'] == 'query_scoped_posterior'
    assert all(v['available'] is False for v in result['variables'])
    assert all(v['reason'] == 'query_scoped_posterior' for v in result['variables'])


def test_surprise_gauge_prefers_temporal_candidate_regime(monkeypatch: pytest.MonkeyPatch):
    # NOTE:
    # This is not expected to fail because of the deleted degraded branch.
    # If it goes red, the likely bug is that surprise-gauge regime selection
    # is still choosing the wrong temporal candidate for cohort queries and
    # therefore binding the broader window evidence family (`100/40`) instead
    # of the narrower cohort one (`40/4`).
    from runner import model_resolver
    from runner import cohort_maturity_derivation
    from runner import forecast_state
    import snapshot_service

    monkeypatch.setattr(
        model_resolver,
        'resolve_model_params',
        lambda *args, **kwargs: ResolvedModelParams(
            p_mean=0.5,
            p_sd=0.05,
            alpha=50.0,
            beta=50.0,
            alpha_pred=50.0,
            beta_pred=50.0,
            edge_latency=ResolvedLatency(
                mu=1.8,
                sigma=0.4,
                onset_delta_days=0.0,
                t95=12.0,
            ),
            path_latency=ResolvedLatency(
                mu=2.4,
                sigma=0.6,
                onset_delta_days=0.0,
                t95=18.0,
            ),
            source='bayesian',
        ),
    )

    broad_rows = [
        {
            'core_hash': 'hash-window',
            'retrieved_at': '2026-04-05T00:00:00+00:00',
            'anchor_day': '2026-04-01',
            'x': 100,
            'y': 40,
        },
        {
            'core_hash': 'hash-cohort',
            'retrieved_at': '2026-04-05T00:00:00+00:00',
            'anchor_day': '2026-04-01',
            'x': 40,
            'y': 4,
        },
    ]

    monkeypatch.setattr(
        snapshot_service,
        'query_snapshots_for_sweep',
        lambda **_kwargs: list(broad_rows),
    )

    def _fake_derive(rows, sweep_from=None, sweep_to=None):
        total_x = sum(float(r.get('x', 0.0)) for r in rows)
        total_y = sum(float(r.get('y', 0.0)) for r in rows)
        return {
            'frames': [{
                'snapshot_date': '2026-04-05',
                'data_points': [{
                    'anchor_day': '2026-04-01',
                    'x': total_x,
                    'y': total_y,
                    'a': total_x,
                }],
            }],
        }

    monkeypatch.setattr(cohort_maturity_derivation, 'derive_cohort_maturity', _fake_derive)

    monkeypatch.setattr(
        forecast_state,
        'compute_forecast_summary',
        lambda **_kwargs: SimpleNamespace(
            pp_rate_unconditioned=0.25,
            pp_rate_unconditioned_sd=0.05,
            completeness_unconditioned=0.6,
            completeness_unconditioned_sd=0.1,
            completeness=0.55,
            completeness_sd=0.02,
            is_ess=123.0,
        ),
    )

    window_result = _compute_surprise_gauge(
        graph_data=_latency_graph(),
        target_id='edge-1',
        subj={
            'param_id': 'pytest-param',
            'core_hash': 'hash-cohort',
            'anchor_from': '2026-04-01',
            'anchor_to': '2026-04-01',
            'slice_keys': [''],
            'candidate_regimes': [
                {'core_hash': 'hash-cohort', 'equivalent_hashes': [], 'temporal_mode': 'cohort'},
                {'core_hash': 'hash-window', 'equivalent_hashes': [], 'temporal_mode': 'window'},
            ],
        },
        data={'query_dsl': 'from(a).to(b).window(-7d:)'},
    )
    cohort_result = _compute_surprise_gauge(
        graph_data=_latency_graph(),
        target_id='edge-1',
        subj={
            'param_id': 'pytest-param',
            'core_hash': 'hash-cohort',
            'anchor_from': '2026-04-01',
            'anchor_to': '2026-04-01',
            'slice_keys': [''],
            'candidate_regimes': [
                {'core_hash': 'hash-cohort', 'equivalent_hashes': [], 'temporal_mode': 'cohort'},
                {'core_hash': 'hash-window', 'equivalent_hashes': [], 'temporal_mode': 'window'},
            ],
        },
        data={'query_dsl': 'from(a).to(b).cohort(-7d:)'},
    )

    window_p = next(v for v in window_result['variables'] if v['name'] == 'p')
    cohort_p = next(v for v in cohort_result['variables'] if v['name'] == 'p')

    assert window_p['evidence_n'] == 100
    assert window_p['evidence_k'] == 40
    assert window_p['observed'] == pytest.approx(0.4)

    assert cohort_p['evidence_n'] == 40
    assert cohort_p['evidence_k'] == 4
    assert cohort_p['observed'] == pytest.approx(0.1)
    assert cohort_p['observed'] != window_p['observed']


def test_surprise_gauge_uses_effective_query_dsl_for_temporal_mode(
    monkeypatch: pytest.MonkeyPatch,
):
    from runner import model_resolver

    captured: list[tuple[str, str]] = []

    def _fake_resolve(_edge, *, scope, temporal_mode, graph_preference=None):
        captured.append((scope, temporal_mode))
        return _query_scoped_latency_resolved()

    monkeypatch.setattr(model_resolver, 'resolve_model_params', _fake_resolve)

    base_request = {
        'analysis_type': 'surprise_gauge',
        'analytics_dsl': 'from(a).to(b)',
        'scenarios': [{
            'scenario_id': 'base',
            'name': 'Base',
            'colour': '#000000',
            'visibility_mode': 'f+e',
            'graph': _latency_graph(),
            'snapshot_subjects': [{
                'subject_id': 's1',
                'param_id': 'pytest-param',
                'core_hash': 'hash',
                'anchor_from': '2026-04-01',
                'anchor_to': '2026-04-01',
                'sweep_from': '2026-04-01',
                'sweep_to': '2026-04-05',
                'slice_keys': [''],
                'target': {'targetId': 'edge-1'},
            }],
        }],
    }

    cohort_request = {
        **base_request,
        'scenarios': [{**base_request['scenarios'][0], 'effective_query_dsl': 'cohort(-30d:)'}],
    }
    window_request = {
        **base_request,
        'scenarios': [{**base_request['scenarios'][0], 'effective_query_dsl': 'window(-30d:)'}],
    }

    handle_runner_analyze(cohort_request)
    handle_runner_analyze(window_request)

    assert captured == [('edge', 'cohort'), ('edge', 'window')]


def test_surprise_gauge_preparation_honours_sweep_bounds(
    monkeypatch: pytest.MonkeyPatch,
):
    from runner import cohort_maturity_derivation
    from runner import forecast_state
    from runner import model_resolver
    import snapshot_service

    monkeypatch.setattr(
        model_resolver,
        'resolve_model_params',
        lambda *args, **kwargs: ResolvedModelParams(
            p_mean=0.5,
            p_sd=0.05,
            alpha=50.0,
            beta=50.0,
            alpha_pred=50.0,
            beta_pred=50.0,
            edge_latency=ResolvedLatency(
                mu=1.8,
                sigma=0.4,
                onset_delta_days=0.0,
                t95=12.0,
            ),
            source='bayesian',
        ),
    )

    query_args: dict[str, object] = {}

    def _fake_query_snapshots_for_sweep(**kwargs):
        query_args.update(kwargs)
        return [{
            'core_hash': 'hash-window',
            'retrieved_at': '2026-04-05T00:00:00+00:00',
            'anchor_day': '2026-04-01',
            'x': 100,
            'y': 20,
        }]

    monkeypatch.setattr(
        snapshot_service,
        'query_snapshots_for_sweep',
        _fake_query_snapshots_for_sweep,
    )

    monkeypatch.setattr(
        cohort_maturity_derivation,
        'derive_cohort_maturity',
        lambda rows, sweep_from=None, sweep_to=None: {
            'frames': [{
                'snapshot_date': '2026-04-05',
                'data_points': [{
                    'anchor_day': '2026-04-01',
                    'x': 100,
                    'y': 20,
                    'a': 100,
                }],
            }],
        },
    )

    monkeypatch.setattr(
        forecast_state,
        'compute_forecast_summary',
        lambda **_kwargs: SimpleNamespace(
            pp_rate_unconditioned=0.25,
            pp_rate_unconditioned_sd=0.05,
            completeness_unconditioned=0.6,
            completeness_unconditioned_sd=0.1,
            completeness=0.55,
            completeness_sd=0.02,
            is_ess=123.0,
        ),
    )

    result = _compute_surprise_gauge(
        graph_data=_latency_graph(),
        target_id='edge-1',
        subj={
            'param_id': 'pytest-param',
            'core_hash': 'hash-window',
            'anchor_from': '2026-04-01',
            'anchor_to': '2026-04-01',
            'sweep_from': '2026-04-02',
            'sweep_to': '2026-04-05',
            'slice_keys': [''],
            'target': {'targetId': 'edge-1'},
        },
        data={'analytics_dsl': 'from(a).to(b)'},
        effective_query_dsl='window(-7d:)',
    )

    assert query_args['sweep_from'] == date(2026, 4, 2)
    assert query_args['sweep_to'] == date(2026, 4, 5)

    p_var = next(v for v in result['variables'] if v['name'] == 'p')
    assert p_var['available'] is True
    assert p_var['evidence_n'] == 100
    assert p_var['evidence_k'] == 20


def test_surprise_gauge_cohort_carrier_uses_cache_keys(
    monkeypatch: pytest.MonkeyPatch,
):
    from runner import forecast_preparation
    from runner import forecast_runtime
    from runner import forecast_state
    from runner import model_resolver

    graph = {
        'nodes': [
            {'id': 'A', 'uuid': 'uuid-a', 'entry': {'is_start': True}},
            {'id': 'X', 'uuid': 'uuid-x'},
            {'id': 'Y', 'uuid': 'uuid-y'},
        ],
        'edges': [
            {
                'uuid': 'edge-ax',
                'from': 'uuid-a',
                'to': 'uuid-x',
                'p': {'latency': {'latency_parameter': True}},
            },
            {
                'uuid': 'edge-xy',
                'from': 'uuid-x',
                'to': 'uuid-y',
                'p': {'latency': {'latency_parameter': True}},
            },
        ],
    }

    monkeypatch.setattr(
        model_resolver,
        'resolve_model_params',
        lambda *args, **kwargs: ResolvedModelParams(
            p_mean=0.5,
            p_sd=0.05,
            alpha=50.0,
            beta=50.0,
            alpha_pred=50.0,
            beta_pred=50.0,
            edge_latency=ResolvedLatency(
                mu=1.8,
                sigma=0.4,
                onset_delta_days=0.0,
                t95=12.0,
            ),
            path_latency=ResolvedLatency(
                mu=2.4,
                sigma=0.6,
                onset_delta_days=0.0,
                t95=18.0,
            ),
            source='bayesian',
        ),
    )

    monkeypatch.setattr(
        forecast_preparation,
        'prepare_forecast_subject_group',
        lambda **_kwargs: SimpleNamespace(
            anchor_node='A',
            total_rows=1,
            per_edge_results=[{
                'derivation_result': {
                    'frames': [{
                        'snapshot_date': '2026-04-05',
                        'data_points': [{
                            'anchor_day': '2026-04-01',
                            'x': 100,
                            'y': 10,
                            'a': 100,
                        }],
                    }],
                },
            }],
        ),
    )

    monkeypatch.setattr(
        forecast_state,
        'build_node_arrival_cache',
        lambda _graph, anchor_id, max_tau=400: (
            {'uuid-x': SimpleNamespace(deterministic_cdf=[1.0], reach=1.0)}
            if anchor_id == 'uuid-a' else {}
        ),
    )

    captured = {}
    monkeypatch.setattr(
        forecast_runtime,
        'build_prepared_runtime_bundle',
        lambda **kwargs: SimpleNamespace(
            resolved_params=kwargs['resolved_params'],
            carrier_to_x=SimpleNamespace(from_node_arrival=kwargs.get('from_node_arrival')),
            p_conditioning_evidence=SimpleNamespace(
                source=captured.setdefault(
                    'p_conditioning_source',
                    kwargs.get('p_conditioning_source'),
                ),
            ),
        ),
    )

    def _fake_summary(**kwargs):
        assert kwargs['from_node_arrival'] is not None
        return SimpleNamespace(
            pp_rate_unconditioned=0.25,
            pp_rate_unconditioned_sd=0.05,
            completeness_unconditioned=0.6,
            completeness_unconditioned_sd=0.1,
            completeness=0.55,
            completeness_sd=0.02,
            is_ess=123.0,
        )

    monkeypatch.setattr(forecast_state, 'compute_forecast_summary', _fake_summary)

    result = _compute_surprise_gauge(
        graph_data=graph,
        target_id='edge-xy',
        subj={
            'param_id': 'pytest-param',
            'core_hash': 'hash-cohort',
            'anchor_from': '2026-04-01',
            'anchor_to': '2026-04-01',
            'slice_keys': [''],
            'target': {'targetId': 'edge-xy'},
        },
        data={'analytics_dsl': 'from(X).to(Y)'},
        effective_query_dsl='cohort(-7d:)',
    )

    p_var = next(v for v in result['variables'] if v['name'] == 'p')
    assert p_var['available'] is True
    assert p_var['observed'] == pytest.approx(0.1)
    assert captured['p_conditioning_source'] == 'aggregate_evidence'


def test_surprise_gauge_mixed_ids_match_same_semantic_graph(
    monkeypatch: pytest.MonkeyPatch,
):
    """Mixed id/uuid graphs must behave like the same graph with ids==uuids.

    There is not yet a committed mixed-identity synth fixture, so this test
    keeps the live carrier-cache and summary-engine code real while replacing
    only the upstream preparation/model-resolution boundaries with a minimal
    synthetic setup. The semantic graph is identical in both runs; only the
    human-facing node ids change.
    """

    from runner import forecast_preparation
    from runner import model_resolver

    resolved = ResolvedModelParams(
        p_mean=0.4,
        p_sd=0.05,
        alpha=40.0,
        beta=60.0,
        alpha_pred=40.0,
        beta_pred=60.0,
        edge_latency=ResolvedLatency(
            mu=2.0,
            sigma=0.4,
            onset_delta_days=0.0,
            t95=10.0,
        ),
        path_latency=ResolvedLatency(
            mu=3.0,
            sigma=0.5,
            onset_delta_days=0.0,
            t95=16.0,
        ),
        source='bayesian',
    )
    monkeypatch.setattr(
        model_resolver,
        'resolve_model_params',
        lambda *args, **kwargs: resolved,
    )

    prep_holder: dict[str, SimpleNamespace] = {}
    monkeypatch.setattr(
        forecast_preparation,
        'prepare_forecast_subject_group',
        lambda **_kwargs: prep_holder['value'],
    )

    def _graph(mixed_ids: bool) -> tuple[dict, str, str, str]:
        anchor_id = 'A' if mixed_ids else 'uuid-a'
        from_id = 'X' if mixed_ids else 'uuid-x'
        to_id = 'Y' if mixed_ids else 'uuid-y'
        return (
            {
                'nodes': [
                    {'id': anchor_id, 'uuid': 'uuid-a', 'entry': {'is_start': True}},
                    {'id': from_id, 'uuid': 'uuid-x'},
                    {'id': to_id, 'uuid': 'uuid-y'},
                ],
                'edges': [
                    {
                        'uuid': 'edge-ax',
                        'from': 'uuid-a',
                        'to': 'uuid-x',
                        'p': {
                            'mean': 0.8,
                            'latency': {
                                'latency_parameter': True,
                                'mu': 1.0,
                                'sigma': 0.3,
                                'onset_delta_days': 0.0,
                                't95': 6.0,
                            },
                        },
                    },
                    {
                        'uuid': 'edge-xy',
                        'from': 'uuid-x',
                        'to': 'uuid-y',
                        'p': {
                            'mean': 0.5,
                            'latency': {
                                'latency_parameter': True,
                                'mu': 2.0,
                                'sigma': 0.4,
                                'onset_delta_days': 0.0,
                                't95': 10.0,
                            },
                        },
                    },
                ],
            },
            anchor_id,
            from_id,
            to_id,
        )

    def _prep(anchor_node: str) -> SimpleNamespace:
        return SimpleNamespace(
            anchor_node=anchor_node,
            total_rows=1,
            per_edge_results=[{
                'derivation_result': {
                    'frames': [
                        {
                            'snapshot_date': '2026-04-05',
                            'data_points': [{
                                'anchor_day': '2026-04-01',
                                'x': 100,
                                'y': 10,
                                'a': 100,
                            }],
                        },
                        {
                            'snapshot_date': '2026-04-06',
                            'data_points': [{
                                'anchor_day': '2026-04-01',
                                'x': 100,
                                'y': 20,
                                'a': 100,
                            }],
                        },
                    ],
                },
            }],
        )

    def _run(mixed_ids: bool) -> dict:
        graph, anchor_id, from_id, to_id = _graph(mixed_ids)
        prep_holder['value'] = _prep(anchor_id)
        return _compute_surprise_gauge(
            graph_data=graph,
            target_id='edge-xy',
            subj={
                'param_id': 'pytest-param',
                'core_hash': 'hash-cohort',
                'anchor_from': '2026-04-01',
                'anchor_to': '2026-04-01',
                'slice_keys': [''],
                'target': {'targetId': 'edge-xy'},
            },
            data={'analytics_dsl': f'from({from_id}).to({to_id})'},
            effective_query_dsl='cohort(-7d:)',
        )

    same_identity = _run(mixed_ids=False)
    mixed_identity = _run(mixed_ids=True)

    assert same_identity['reference_source'] == 'bayesian'
    assert mixed_identity['reference_source'] == 'bayesian'
    assert same_identity['cf_mode'] == 'sweep'
    assert mixed_identity['cf_mode'] == 'sweep'
    assert same_identity['is_ess'] == pytest.approx(mixed_identity['is_ess'])

    def _var(result: dict, name: str) -> dict:
        return next(v for v in result['variables'] if v['name'] == name)

    same_p = _var(same_identity, 'p')
    mixed_p = _var(mixed_identity, 'p')
    assert same_p['available'] is True
    assert mixed_p['available'] is True
    for field in (
        'quantile',
        'sigma',
        'observed',
        'expected',
        'posterior_sd',
        'combined_sd',
        'completeness',
    ):
        assert same_p[field] == pytest.approx(mixed_p[field])
    for field in ('evidence_n', 'evidence_k', 'zone', 'evidence_retrieved_at'):
        assert same_p[field] == mixed_p[field]

    same_c = _var(same_identity, 'completeness')
    mixed_c = _var(mixed_identity, 'completeness')
    assert same_c['available'] == mixed_c['available']
    assert same_c.get('reason') == mixed_c.get('reason')


def test_cohort_maturity_rows_v3_identity_drift():
    """Atom 8 — `id` vs `uuid` drift check on the v3 row builder.

    Construct the same semantic graph twice. In variant A every
    node's `id` field equals its `uuid`. In variant B the `id` is
    human-readable and differs from the `uuid`. Run
    `compute_cohort_maturity_rows_v3` on both without mocking
    anything, and assert the maturity rows are identical.

    No mocks of subject resolution, forecast logic, or snapshot
    selection — this is the Family B identity-drift contract that
    the existing surprise_gauge mixed-id test cannot assert because
    it monkeypatches `resolve_model_params` and
    `prepare_forecast_subject_group`.
    """
    frames = _frames()
    resolved = _query_scoped_latency_resolved()

    common_edge = {
        'uuid': 'edge-1',
        'from': 'uuid-a',
        'to': 'uuid-b',
        'p': {
            'forecast': {'mean': 0.2},
            'latency': {
                'latency_parameter': True,
                'mu': 2.3,
                'sigma': 0.5,
                'onset_delta_days': 0.0,
                't95': 23.0,
            },
        },
    }

    graph_same_identity = {
        'nodes': [
            {'id': 'uuid-a', 'uuid': 'uuid-a', 'entry': {'is_start': True}},
            {'id': 'uuid-b', 'uuid': 'uuid-b'},
        ],
        'edges': [dict(common_edge)],
    }

    graph_mixed_identity = {
        'nodes': [
            {'id': 'human-a', 'uuid': 'uuid-a', 'entry': {'is_start': True}},
            {'id': 'human-b', 'uuid': 'uuid-b'},
        ],
        'edges': [dict(common_edge)],
    }

    rows_same = compute_cohort_maturity_rows_v3(
        frames=frames,
        graph=graph_same_identity,
        target_edge_id='edge-1',
        query_from_node='uuid-a',
        query_to_node='uuid-b',
        anchor_from='2026-03-25',
        anchor_to='2026-03-25',
        sweep_to='2026-04-05',
        is_window=True,
        resolved_override=resolved,
    )

    rows_mixed = compute_cohort_maturity_rows_v3(
        frames=frames,
        graph=graph_mixed_identity,
        target_edge_id='edge-1',
        query_from_node='human-a',
        query_to_node='human-b',
        anchor_from='2026-03-25',
        anchor_to='2026-03-25',
        sweep_to='2026-04-05',
        is_window=True,
        resolved_override=resolved,
    )

    assert len(rows_same) == len(rows_mixed), (
        f"Row count differs between identifier variants: "
        f"same={len(rows_same)} mixed={len(rows_mixed)}"
    )
    assert rows_same, "v3 returned no rows for same-identity variant"

    compared_fields = (
        'tau_days',
        'evidence_x',
        'evidence_y',
        'midpoint',
        'rate',
        'p_infinity_mean',
        'completeness',
    )
    for idx, (rs, rm) in enumerate(zip(rows_same, rows_mixed)):
        for key in compared_fields:
            vs = rs.get(key)
            vm = rm.get(key)
            if vs is None and vm is None:
                continue
            assert vs == pytest.approx(vm), (
                f"Identity drift at row {idx} "
                f"(tau={rs.get('tau_days')}), field '{key}': "
                f"same-identity={vs} mixed-identity={vm}"
            )


def test_daily_conversions_degraded_branch_reuses_closed_form_beta_surface(
    monkeypatch: pytest.MonkeyPatch,
):
    # NOTE:
    # This test is intentionally coupled to the old daily-conversions
    # degraded branch: its exact projected_y / forecast_y / band
    # expectations come from the deleted closed-form surface path.
    #
    # After the structural refactor, daily conversions now reads the shared
    # forecast engine with query-scoped rate conditioning disabled. If this
    # test stays red, the likely cause is that it is still asserting the
    # deleted branch's numeric contract rather than the surviving provenance
    # contract (`analytic_degraded`, `query_scoped_posterior`).
    from runner import model_resolver

    monkeypatch.setattr(
        model_resolver,
        'resolve_model_params',
        lambda *args, **kwargs: _query_scoped_latency_resolved(),
    )

    req = {
        'analysis_type': 'daily_conversions',
        'scenarios': [{
            'scenario_id': 'base',
            'name': 'Base',
            'colour': '#000000',
            'visibility_mode': 'f+e',
            'graph': _latency_graph(),
            'effective_query_dsl': 'window(-30d:).asat(5-Apr-26)',
            'snapshot_subjects': [{
                'subject_id': 's1',
                'param_id': 'pytest-param',
                'canonical_signature': '{"c":"gd","x":{}}',
                'core_hash': 'hash',
                'anchor_from': '2026-04-04',
                'anchor_to': '2026-04-04',
                'slice_keys': [''],
                'target': {'targetId': 'edge-1'},
            }],
        }],
        'display_settings': {
            'show_latency_bands': True,
        },
    }

    with patch('snapshot_service.query_snapshots') as mock_query:
        mock_query.return_value = _daily_conversion_rows()
        result = handle_runner_analyze(req)

    assert result['success'] is True
    analysis = result['result']
    assert analysis['analysis_type'] == 'daily_conversions'
    assert analysis['cf_mode'] == 'analytic_degraded'
    assert analysis['cf_reason'] == 'query_scoped_posterior'

    cohort_row = analysis['rate_by_cohort'][0]
    surface = build_closed_form_beta_rate_surface(
        alpha=20.0,
        beta=80.0,
        band_level=0.90,
        band_levels=[0.80, 0.90, 0.95, 0.99],
    )
    assert surface is not None

    expected_completeness = compute_completeness(1, 2.3, 0.5, 0.0)
    assert cohort_row['completeness'] == pytest.approx(expected_completeness)
    assert cohort_row['projected_y'] == pytest.approx(20.0)
    assert cohort_row['forecast_y'] == pytest.approx(15.0)

    for level, bounds in surface.band_lookup.items():
        assert cohort_row['forecast_bands'][level][0] == pytest.approx(bounds[0])
        assert cohort_row['forecast_bands'][level][1] == pytest.approx(bounds[1])

    assert cohort_row['latency_bands']
    for tau_label, payload in cohort_row['latency_bands'].items():
        assert payload['source'] == 'forecast'
        tau_days = int(tau_label[:-1])
        c_tau = compute_completeness(tau_days, 2.3, 0.5, 0.0)
        assert payload['rate'] == pytest.approx(surface.p_mean * c_tau)
        for level in ('80', '90'):
            assert payload['bands'][level][0] == pytest.approx(
                surface.band_lookup[level][0] * c_tau
            )
            assert payload['bands'][level][1] == pytest.approx(
                surface.band_lookup[level][1] * c_tau
            )


# ─────────────────────────────────────────────────────────────────────
# Surprise gauge: no-data is not a failure condition
#
# Empty cohorts/evidence is a legitimate degenerate state, not an
# error. The gauge must render with `available: True`, observed=0,
# evidence_n=0, evidence_k=0, against the unconditioned prior — needle
# naturally lands in the `expected` zone. Regression guard: do not
# reintroduce early-return `_unavailable` branches for no-data cases.
# ─────────────────────────────────────────────────────────────────────


def _ok_resolved() -> ResolvedModelParams:
    return ResolvedModelParams(
        p_mean=0.5,
        p_sd=0.05,
        alpha=50.0,
        beta=50.0,
        alpha_pred=50.0,
        beta_pred=50.0,
        edge_latency=ResolvedLatency(
            mu=1.8,
            sigma=0.4,
            onset_delta_days=0.0,
            t95=12.0,
        ),
        source='bayesian',
    )


def _empty_preparation(
    *,
    per_edge_results=None,
    total_rows=0,
):
    from runner.forecast_preparation import ForecastPreparation

    return ForecastPreparation(
        query_from_node='uuid-a',
        query_to_node='uuid-b',
        anchor_node=None,
        last_edge_id='edge-1',
        is_multi_hop=False,
        anchor_from='2026-04-01',
        anchor_to='2026-04-01',
        sweep_to='2026-04-05',
        total_rows=total_rows,
        cohorts_analysed=0,
        per_edge_results=per_edge_results or [],
        composed_frames=[],
        regime_diagnostics=[],
    )


def _zero_unconditioned_summary(**_kwargs):
    # Mirrors compute_forecast_summary's natural output for empty
    # cohort_ages_and_weights + empty evidence: zeros all the way down.
    return SimpleNamespace(
        pp_rate_unconditioned=0.0,
        pp_rate_unconditioned_sd=0.0,
        completeness_unconditioned=0.0,
        completeness_unconditioned_sd=0.0,
        completeness=0.0,
        completeness_sd=0.0,
        is_ess=2000.0,
    )


def _assert_no_data_gauge_render(result: dict) -> None:
    """All no-data conditions must render the gauge, not degrade to cards."""
    assert 'error' not in result, (
        f"no-data is not a failure — gauge must render. Got error: {result.get('error')!r}"
    )
    assert result['analysis_type'] == 'surprise_gauge'
    for v in result['variables']:
        assert v['available'] is True, (
            f"{v['name']} must be available in no-data case — got "
            f"available={v['available']!r}, reason={v.get('reason')!r}"
        )
        assert v['observed'] == 0
        assert v['sigma'] == 0
        assert v['quantile'] == pytest.approx(0.5)
        assert v['zone'] == 'expected'
    p = next(v for v in result['variables'] if v['name'] == 'p')
    assert p['evidence_n'] == 0
    assert p['evidence_k'] == 0


def test_surprise_gauge_renders_when_preparation_has_no_rows(
    monkeypatch: pytest.MonkeyPatch,
):
    """`total_rows == 0` must NOT early-return _unavailable."""
    from runner import model_resolver
    from runner import forecast_preparation
    from runner import forecast_state

    monkeypatch.setattr(
        model_resolver, 'resolve_model_params',
        lambda *a, **k: _ok_resolved(),
    )
    monkeypatch.setattr(
        forecast_preparation, 'prepare_forecast_subject_group',
        lambda **_: _empty_preparation(total_rows=0),
    )
    monkeypatch.setattr(
        forecast_state, 'compute_forecast_summary',
        _zero_unconditioned_summary,
    )

    result = _compute_surprise_gauge(
        graph_data=_latency_graph(),
        target_id='edge-1',
        subj={
            'param_id': 'p', 'core_hash': 'h',
            'anchor_from': '2026-04-01', 'anchor_to': '2026-04-01',
            'slice_keys': [''], 'target': {'targetId': 'edge-1'},
        },
        data={'analytics_dsl': 'from(a).to(b)'},
        effective_query_dsl='window(-7d:)',
    )

    _assert_no_data_gauge_render(result)


def test_surprise_gauge_renders_when_no_frames(
    monkeypatch: pytest.MonkeyPatch,
):
    """Derivation returning `{'frames': []}` must NOT early-return."""
    from runner import model_resolver
    from runner import forecast_preparation
    from runner import forecast_state

    monkeypatch.setattr(
        model_resolver, 'resolve_model_params',
        lambda *a, **k: _ok_resolved(),
    )
    monkeypatch.setattr(
        forecast_preparation, 'prepare_forecast_subject_group',
        lambda **_: _empty_preparation(
            total_rows=3,
            per_edge_results=[{'derivation_result': {'frames': []}}],
        ),
    )
    monkeypatch.setattr(
        forecast_state, 'compute_forecast_summary',
        _zero_unconditioned_summary,
    )

    result = _compute_surprise_gauge(
        graph_data=_latency_graph(),
        target_id='edge-1',
        subj={
            'param_id': 'p', 'core_hash': 'h',
            'anchor_from': '2026-04-01', 'anchor_to': '2026-04-01',
            'slice_keys': [''], 'target': {'targetId': 'edge-1'},
        },
        data={'analytics_dsl': 'from(a).to(b)'},
        effective_query_dsl='window(-7d:)',
    )

    _assert_no_data_gauge_render(result)


def test_surprise_gauge_renders_when_last_frame_has_no_data_points(
    monkeypatch: pytest.MonkeyPatch,
):
    """Last frame with empty `data_points` must NOT early-return."""
    from runner import model_resolver
    from runner import forecast_preparation
    from runner import forecast_state

    monkeypatch.setattr(
        model_resolver, 'resolve_model_params',
        lambda *a, **k: _ok_resolved(),
    )
    monkeypatch.setattr(
        forecast_preparation, 'prepare_forecast_subject_group',
        lambda **_: _empty_preparation(
            total_rows=1,
            per_edge_results=[{'derivation_result': {'frames': [{
                'snapshot_date': '2026-04-05',
                'data_points': [],
            }]}}],
        ),
    )
    monkeypatch.setattr(
        forecast_state, 'compute_forecast_summary',
        _zero_unconditioned_summary,
    )

    result = _compute_surprise_gauge(
        graph_data=_latency_graph(),
        target_id='edge-1',
        subj={
            'param_id': 'p', 'core_hash': 'h',
            'anchor_from': '2026-04-01', 'anchor_to': '2026-04-01',
            'slice_keys': [''], 'target': {'targetId': 'edge-1'},
        },
        data={'analytics_dsl': 'from(a).to(b)'},
        effective_query_dsl='window(-7d:)',
    )

    _assert_no_data_gauge_render(result)


def test_surprise_gauge_renders_when_no_cohorts_match_anchor_window(
    monkeypatch: pytest.MonkeyPatch,
):
    """data_points exist but anchor_from/to filter drops them all — this
    is the scenario reported from the UI: cohort(23-Apr:23-Apr) against
    a graph whose only anchor_days are elsewhere."""
    from runner import model_resolver
    from runner import forecast_preparation
    from runner import forecast_state

    monkeypatch.setattr(
        model_resolver, 'resolve_model_params',
        lambda *a, **k: _ok_resolved(),
    )
    monkeypatch.setattr(
        forecast_preparation, 'prepare_forecast_subject_group',
        lambda **_: _empty_preparation(
            total_rows=1,
            per_edge_results=[{'derivation_result': {'frames': [{
                'snapshot_date': '2026-04-23',
                'data_points': [
                    # Cohort on 2026-03-20 — outside the 2026-04-23:23 window
                    {'anchor_day': '2026-03-20', 'x': 100, 'y': 10, 'a': 100},
                ],
            }]}}],
        ),
    )
    monkeypatch.setattr(
        forecast_state, 'compute_forecast_summary',
        _zero_unconditioned_summary,
    )

    result = _compute_surprise_gauge(
        graph_data=_latency_graph(),
        target_id='edge-1',
        subj={
            'param_id': 'p', 'core_hash': 'h',
            'anchor_from': '2026-04-23', 'anchor_to': '2026-04-23',
            'slice_keys': [''], 'target': {'targetId': 'edge-1'},
        },
        data={'analytics_dsl': 'from(a).to(b)'},
        effective_query_dsl='cohort(23-Apr-26:23-Apr-26)',
    )

    _assert_no_data_gauge_render(result)
