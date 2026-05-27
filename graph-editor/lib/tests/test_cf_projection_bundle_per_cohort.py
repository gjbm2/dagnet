"""Phase 2 (73q) — per-Cohort un-aggregation on the selected-cohort spine.

The date reducer (73q Phase 3) needs per-Cohort `(N_cohorts, S, T)` FC
arrays it can index directly, rather than the across-Cohort `(S, T)`
aggregate the tau reducer consumes. 73q §"Per-Cohort un-aggregation"
makes the per-Cohort arrays the canonical product and the aggregate a
derived `.sum(axis=0)` view.

These tests pin (Phase 2 "complete when"):

  - the projection exposes per-Cohort `ef_*_by_cohort` and ordered
    strict-evidence arrays aligned to the selected-Cohort order;
  - the public aggregate `ef_*` is EXACTLY the sum of the per-Cohort
    arrays (mass-first reduction);
  - per-Cohort `ef_rate_draws_by_cohort = ef_y / ef_x` with the
    projection's NaN-on-0/0 policy;
  - shapes are coherent with `(C, S, T)` / `(C, T)`.

They reuse the blind-algebraic fixture apparatus already established in
``test_model_span_spine_selected_cohort.py``.
"""

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from runner.model_span_spine import project_selected_cohort_rows

# Reuse the stable blind-algebraic fixture builders.
from test_model_span_spine_selected_cohort import (  # noqa: E402
    _DRAW_COUNT,
    _HORIZON,
    _build_window_mode_spans,
    _candidate,
)


def _project_two_cohort_window(*, sigma_xy=0.8):
    """Two window-mode Cohorts over a shared single-hop span, each with
    its own observed evidence on its own anchor day."""
    carrier, subject, emp_carrier, emp_subject = _build_window_mode_spans(
        candidates_xy=(
            _candidate(
                from_id='X', to_id='Y', observed_date='2026-03-10',
                retrieved_at='2026-03-17', n=80, k=16,
            ),
            _candidate(
                from_id='X', to_id='Y', observed_date='2026-03-15',
                retrieved_at='2026-03-22', n=100, k=20,
            ),
        ),
        sigma_xy=sigma_xy,
    )
    selected_cohorts = [
        {'anchor_day': '2026-03-10', 'N_anchor': 80.0, 'N_pop': 80.0,
         'tau_max': 30, 'tau_observed': 7},
        {'anchor_day': '2026-03-15', 'N_anchor': 100.0, 'N_pop': 100.0,
         'tau_max': 30, 'tau_observed': 7},
    ]
    projection = project_selected_cohort_rows(
        composed_carrier=carrier,
        composed_subject=subject,
        composed_carrier_predictive=carrier,
        composed_subject_predictive=subject,
        composed_empirical_carrier=emp_carrier,
        composed_empirical_subject=emp_subject,
        selected_cohorts=selected_cohorts,
        horizon=_HORIZON,
    )
    return projection, selected_cohorts


class TestPerCohortArraysExposed:

    def test_per_cohort_ef_array_shapes(self):
        projection, cohorts = _project_two_cohort_window()
        C, S, T = len(cohorts), _DRAW_COUNT, _HORIZON + 1
        assert projection.ef_x_draws_by_cohort.shape == (C, S, T)
        assert projection.ef_y_draws_by_cohort.shape == (C, S, T)
        assert projection.ef_rate_draws_by_cohort.shape == (C, S, T)
        assert projection.ef_forecast_x_by_cohort.shape == (C, S, T)
        assert projection.ef_forecast_y_by_cohort.shape == (C, S, T)

    def test_per_cohort_strict_evidence_array_shapes(self):
        projection, cohorts = _project_two_cohort_window()
        C, T = len(cohorts), _HORIZON + 1
        assert projection.evidence_x_strict_by_cohort.shape == (C, T)
        assert projection.evidence_y_strict_by_cohort.shape == (C, T)


class TestAggregateIsSumOfPerCohort:
    """The public `(S, T)` aggregate must be exactly the cohort-axis sum
    of the per-Cohort arrays — the aggregate is a derived view."""

    def test_ef_x_aggregate_equals_sum(self):
        projection, _ = _project_two_cohort_window()
        np.testing.assert_allclose(
            projection.ef_x_draws,
            projection.ef_x_draws_by_cohort.sum(axis=0),
            rtol=0, atol=0,
        )

    def test_ef_y_aggregate_equals_sum(self):
        projection, _ = _project_two_cohort_window()
        np.testing.assert_allclose(
            projection.ef_y_draws,
            projection.ef_y_draws_by_cohort.sum(axis=0),
            rtol=0, atol=0,
        )

    def test_ef_forecast_x_aggregate_equals_sum(self):
        projection, _ = _project_two_cohort_window()
        np.testing.assert_allclose(
            projection.ef_forecast_x,
            projection.ef_forecast_x_by_cohort.sum(axis=0),
            rtol=0, atol=0,
        )

    def test_ef_forecast_y_aggregate_equals_sum(self):
        projection, _ = _project_two_cohort_window()
        np.testing.assert_allclose(
            projection.ef_forecast_y,
            projection.ef_forecast_y_by_cohort.sum(axis=0),
            rtol=0, atol=0,
        )

    def test_strict_evidence_aggregate_consistent_with_per_cohort(self):
        # The aggregate strict surface clamps each Cohort to its own
        # tau_max before summing, so it is not a naive cohort-axis sum of
        # the unclamped per-Cohort arrays. But each per-Cohort row must
        # equal that Cohort's entry in the anchor-keyed map (same data,
        # ordered view).
        projection, cohorts = _project_two_cohort_window()
        for i, c in enumerate(cohorts):
            anchor = c['anchor_day']
            np.testing.assert_allclose(
                projection.evidence_x_strict_by_cohort[i],
                projection.evidence_x_strict_by_anchor_tau[anchor],
                rtol=0, atol=0,
            )
            np.testing.assert_allclose(
                projection.evidence_y_strict_by_cohort[i],
                projection.evidence_y_strict_by_anchor_tau[anchor],
                rtol=0, atol=0,
            )


class TestPerCohortRatePolicy:

    def test_rate_equals_y_over_x_with_nan_on_zero(self):
        projection, _ = _project_two_cohort_window()
        x = projection.ef_x_draws_by_cohort
        y = projection.ef_y_draws_by_cohort
        rate = projection.ef_rate_draws_by_cohort
        # Where x > 0, rate == y / x.
        pos = x > 0.0
        np.testing.assert_allclose(rate[pos], y[pos] / x[pos], rtol=0, atol=0)
        # Where x == 0, rate is NaN (visible undefined, not zero).
        assert np.all(np.isnan(rate[~pos])) if np.any(~pos) else True

    def test_non_vacuous_some_mass_projected(self):
        # Guard against a vacuous all-zero fixture: the FC arrays must
        # carry real mass for the invariants above to mean anything.
        projection, _ = _project_two_cohort_window()
        assert np.any(projection.ef_x_draws_by_cohort > 0.0)
        assert np.any(projection.ef_y_draws_by_cohort > 0.0)


class TestProjectionHorizonSliceInvariance:
    """Projecting at a larger horizon leaves the τ ≤ smaller-horizon
    values unchanged. This is the invariance the saturation-horizon
    bundle depends on: the tau reducer reads the first ``max_tau + 1``
    columns of a projection built at ``saturation_tau``, so those columns
    must equal a projection built at ``max_tau`` directly. (Finding:
    public cohort-maturity row parity under the longer runtime horizon —
    asserted here at spine granularity; the outside-in oracle proves it
    end-to-end through the full runtime.)"""

    def _project_at(self, horizon):
        carrier, subject, emp_carrier, emp_subject = _build_window_mode_spans(
            candidates_xy=(
                _candidate(
                    from_id='X', to_id='Y', observed_date='2026-03-15',
                    retrieved_at='2026-03-22', n=100, k=20,
                ),
            ),
            sigma_xy=0.8,
        )
        return project_selected_cohort_rows(
            composed_carrier=carrier,
            composed_subject=subject,
            composed_carrier_predictive=carrier,
            composed_subject_predictive=subject,
            composed_empirical_carrier=emp_carrier,
            composed_empirical_subject=emp_subject,
            selected_cohorts=[
                {'anchor_day': '2026-03-15', 'N_anchor': 100.0,
                 'N_pop': 100.0, 'tau_max': 30, 'tau_observed': 7},
            ],
            horizon=horizon,
        )

    def test_smaller_horizon_equals_prefix_of_larger(self):
        h1, h2 = 15, 30
        p1 = self._project_at(h1)
        p2 = self._project_at(h2)
        n = h1 + 1
        for field in (
            'ef_x_draws', 'ef_y_draws', 'ef_rate_draws',
            'ef_forecast_x', 'ef_forecast_y', 'f_rate_draws',
            'rate_strict', 'evidence_x_strict', 'evidence_y_strict',
        ):
            a = getattr(p1, field)
            b = getattr(p2, field)
            np.testing.assert_allclose(
                b[..., :n], a, rtol=0, atol=0, equal_nan=True,
                err_msg=f'{field} differs on τ ≤ {h1} when horizon grows',
            )
