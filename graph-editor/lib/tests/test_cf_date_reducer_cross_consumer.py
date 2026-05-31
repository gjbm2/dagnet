"""73q Phase 3 — cross-reducer (tau ↔ date) agreement over one bundle.

The tau reducer (``cohort_maturity``) and the date reducer
(``daily_conversions``) read the SAME ``CFProjectionBundle``. 73q
§"Cross-reducer consistency" pins two agreements:

  - **Single-Cohort**: the cohort_maturity FC tau-row at the terminal
    horizon and the daily-conversions row for that Cohort agree on the
    projected ``Y / X`` rate — exactly, because for one admitted Cohort
    the aggregate ``ef_rate_draws`` IS that Cohort's per-Cohort terminal
    slice and both reducers reduce it with the same band quantiler.
  - **Multi-Cohort**: the cohort_maturity tau-row equals the across-Cohort
    mass-first ``Σ Y[i] / Σ X[i]`` of the per-Cohort arrays; the
    daily-conversions rows expose the un-summed per-Cohort view as counts
    on the displayed observed denominator (each row's ``projected_y / x``
    is that Cohort's terminal FC rate).

Built on the DB-free synth-frame bundle harness from
``test_cf_projection_bundle.py`` (which itself reuses the inline
cohort_maturity v3 fixtures). The date reducer is bundle-only: the
join key is the bundle's own cohort_list-aligned date axis.
"""

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from runner.cohort_forecast_v3 import (
    build_cf_projection_bundle,
    reduce_daily_conversions_rows,
    _project_runtime_rows,
    _date_key,
)

from test_cohort_maturity_v3_contract import (  # noqa: E402
    _build_single_edge_graph,
    _build_synth_frames,
)
from test_model_span_spine_selected_cohort import _candidate  # noqa: E402
from datetime import date


_LAT = dict(mu=3.0, sigma=0.8, onset=5.0)


def _candidates_for(anchors):
    return [
        _candidate(
            from_id='node-a', to_id='node-b',
            observed_date=a, retrieved_at='2026-03-31', n=300, k=60,
        )
        for a in anchors
    ]


def _build_bundle(admitted_anchors):
    graph = _build_single_edge_graph(latency_parameter=True, **_LAT)
    frames, anchor_from, sweep_to = _build_synth_frames(
        anchor_to=date(2026, 3, 10), sweep_days=36, n_cohorts=4,
    )
    bundle = build_cf_projection_bundle(
        frames=frames, graph=graph, target_edge_id='e1',
        query_from_node='node-a', query_to_node='node-b',
        anchor_from='2026-03-01', anchor_to=anchor_from, sweep_to=sweep_to,
        is_window=True,
        compute_extent=200,
        evidence_candidates=_candidates_for(admitted_anchors),
        scenario_id='cross-reducer-test',
    )
    return bundle, sweep_to


def _tau_rows(bundle, sweep_to):
    return _project_runtime_rows(
        runtime=bundle.runtime,
        selected_projection=bundle.selected_projection,
        cohort_eval_ages=bundle.cohort_eval_ages,
        cohort_weights=bundle.cohort_weights,
        max_tau=bundle.max_tau,
        tau_solid_max=bundle.row_tau_solid_max,
        tau_future_max=bundle.row_tau_future_max,
        sweep_to=sweep_to,
        band_level=0.90,
    )


def _date_row(result, date_str):
    return next(
        r for r in result['rate_by_cohort']
        if _date_key(r['date']) == _date_key(date_str)
    )


class TestSingleCohortDateTauAgreement:

    def test_single_cohort_rate_agrees_at_terminal_tau(self):
        # One admitted Cohort: the tau reducer's aggregate ef_rate_draws is
        # exactly that Cohort's per-Cohort slice, so the date row's terminal
        # forecast_bands and the cohort_maturity terminal row must be
        # identical (same draws, same band quantiler).
        bundle, sweep_to = _build_bundle(('2026-03-10',))
        date_result = reduce_daily_conversions_rows(bundle)
        tau_rows = _tau_rows(bundle, sweep_to)

        terminal_tau = int(bundle.max_tau)
        tau_row = next(r for r in tau_rows if int(r['tau_days']) == terminal_tau)
        drow = _date_row(date_result, '2026-03-10')

        # Non-vacuous: the admitted Cohort actually projected a rate fan.
        assert drow['forecast_bands'] is not None
        assert tau_row['fan_bands'] is not None
        # Exact agreement on the projected Y/X rate fan at the terminal horizon.
        assert drow['forecast_bands'] == tau_row['fan_bands']

    def test_single_cohort_projected_rate_agrees_at_terminal_tau(self):
        bundle, sweep_to = _build_bundle(('2026-03-10',))
        date_result = reduce_daily_conversions_rows(bundle)
        tau_rows = _tau_rows(bundle, sweep_to)
        terminal_tau = int(bundle.max_tau)
        tau_row = next(r for r in tau_rows if int(r['tau_days']) == terminal_tau)
        drow = _date_row(date_result, '2026-03-10')
        terminal_draws = bundle.selected_projection.ef_rate_draws_by_cohort[
            0, :, terminal_tau
        ]
        assert drow['projected_rate'] == pytest.approx(
            float(np.nanmedian(terminal_draws)),
        )


class TestMultiCohortMassFirstAggregation:

    def test_per_cohort_projected_y_is_unsummed_view(self):
        bundle, sweep_to = _build_bundle(('2026-03-10', '2026-03-06'))
        date_result = reduce_daily_conversions_rows(bundle)
        sp = bundle.selected_projection

        # Each admitted Cohort's projected_y is its own terminal FC rate
        # expressed as a count on the observed x — the un-summed date view.
        for entry in bundle.cohort_projection_status:
            idx = entry['projection_index']
            if idx is None:
                continue
            drow = _date_row(date_result, entry['anchor_day'])
            terminal_tau = int(bundle.max_tau)
            expected = drow['x'] * float(np.mean(
                sp.ef_rate_draws_by_cohort[idx, :, terminal_tau],
            ))
            assert drow['projected_y'] == pytest.approx(expected)

    def test_mass_first_aggregate_matches_tau_row(self):
        # The cohort_maturity tau-row at saturation equals the across-Cohort
        # mass-first Σy / Σx of the per-Cohort arrays the date reducer
        # indexes — divided once at the end, then the same median.
        bundle, sweep_to = _build_bundle(('2026-03-10', '2026-03-06'))
        sp = bundle.selected_projection
        sat = bundle.max_tau
        tau_rows = _tau_rows(bundle, sweep_to)
        terminal = max(tau_rows, key=lambda r: r['tau_days'])

        sum_y = sp.ef_y_draws_by_cohort[:, :, sat].sum(axis=0)
        sum_x = sp.ef_x_draws_by_cohort[:, :, sat].sum(axis=0)
        with np.errstate(divide='ignore', invalid='ignore'):
            mass_first_rate = sum_y / sum_x
        expected_mid = float(np.nanmedian(mass_first_rate))

        assert terminal['midpoint'] is not None
        assert terminal['midpoint'] == pytest.approx(expected_mid)
        # Two admitted Cohorts contributed (non-vacuous mass-first sum).
        assert sp.ef_y_draws_by_cohort.shape[0] == 2

    def test_per_cohort_forecast_bands_are_diagonal_view(self):
        # Each date-row fan reads the same per-Cohort terminal FC surface as
        # the tau reducer.
        bundle, sweep_to = _build_bundle(('2026-03-10', '2026-03-06'))
        date_result = reduce_daily_conversions_rows(bundle)
        sp = bundle.selected_projection

        for entry in bundle.cohort_projection_status:
            idx = entry['projection_index']
            if idx is None:
                continue
            tau = int(bundle.max_tau)
            drow = _date_row(date_result, entry['anchor_day'])
            expected = {
                '80': [
                    float(np.nanquantile(sp.ef_rate_draws_by_cohort[idx, :, tau], 0.10)),
                    float(np.nanquantile(sp.ef_rate_draws_by_cohort[idx, :, tau], 0.90)),
                ],
                '90': [
                    float(np.nanquantile(sp.ef_rate_draws_by_cohort[idx, :, tau], 0.05)),
                    float(np.nanquantile(sp.ef_rate_draws_by_cohort[idx, :, tau], 0.95)),
                ],
                '95': [
                    float(np.nanquantile(sp.ef_rate_draws_by_cohort[idx, :, tau], 0.025)),
                    float(np.nanquantile(sp.ef_rate_draws_by_cohort[idx, :, tau], 0.975)),
                ],
                '99': [
                    float(np.nanquantile(sp.ef_rate_draws_by_cohort[idx, :, tau], 0.005)),
                    float(np.nanquantile(sp.ef_rate_draws_by_cohort[idx, :, tau], 0.995)),
                ],
            }
            for level, expected_pair in expected.items():
                assert drow['forecast_bands'][level] == pytest.approx(expected_pair)
