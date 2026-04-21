from __future__ import annotations

import sys
from pathlib import Path

import pytest

_LIB = Path(__file__).resolve().parent.parent
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from api_handlers import _compute_surprise_gauge
from runner.cohort_forecast_v3 import compute_cohort_maturity_rows_v3
from runner.forecast_application import compute_completeness
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
                    'latency': {
                        'latency_parameter': True,
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


def test_query_scoped_latency_rows_use_degraded_contract():
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
