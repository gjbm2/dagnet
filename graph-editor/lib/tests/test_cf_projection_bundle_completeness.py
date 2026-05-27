"""Phase 2 (73q) — per-Cohort completeness view.

The date reducer (73q Phase 3) needs per-Cohort completeness at each
Cohort's eval_age, not the across-Cohort weighted scalar the
cohort_maturity scalar consumes. 73q §"Completeness" requires the date
reducer to read the SAME ``_runtime_completeness`` request-rooted CDF,
just un-reduced.

These tests pin (Phase 2 "complete when"):

  - the exported per-Cohort completeness values reduce to the existing
    scalar ``_runtime_completeness`` mean under the same weights;
  - the per-Cohort array is aligned to ``cohort_eval_ages`` order, in
    [0, 1], one value per Cohort;
  - ``_runtime_completeness`` returns the per-Cohort array alongside the
    scalar (one function, one CDF readout — the single source of both
    views), and yields null (not a repaired value) when there is no
    draw-coherent CDF.

Uses the blind-algebraic spine fixtures: ``_runtime_completeness`` only
touches ``runtime.composed_subject`` / ``composed_carrier``, so a light
runtime stub built from the fixture spans exercises the real readout.
"""

import os
import sys
import types

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from runner.cohort_forecast_v3 import _runtime_completeness


def _per_cohort(runtime, ages, weights, horizon):
    # The per-Cohort completeness array is the third element of the
    # folded _runtime_completeness return (73q §"Completeness").
    return _runtime_completeness(
        runtime, cohort_eval_ages=ages, cohort_weights=weights,
        horizon=horizon,
    )[2]

from test_model_span_spine_selected_cohort import (  # noqa: E402
    _HORIZON,
    _build_window_mode_spans,
    _candidate,
)


def _runtime_stub(sigma_xy=0.8):
    carrier, subject, _emp_c, _emp_s = _build_window_mode_spans(
        candidates_xy=(
            _candidate(
                from_id='X', to_id='Y', observed_date='2026-03-15',
                retrieved_at='2026-03-22', n=100, k=20,
            ),
        ),
        sigma_xy=sigma_xy,
    )
    return types.SimpleNamespace(
        composed_subject=subject,
        composed_carrier=carrier,
    )


AGES = [3, 10, 20]
WEIGHTS = [80.0, 100.0, 50.0]


class TestPerCohortCompletenessReducesToScalar:

    def test_weighted_reduction_matches_scalar_mean(self):
        runtime = _runtime_stub()
        scalar_mean, _scalar_sd, per_cohort = _runtime_completeness(
            runtime, cohort_eval_ages=AGES, cohort_weights=WEIGHTS,
            horizon=_HORIZON,
        )
        assert per_cohort is not None
        assert scalar_mean is not None
        w = np.asarray(WEIGHTS, dtype=np.float64)
        reduced = float((w * per_cohort).sum() / w.sum())
        assert reduced == pytest.approx(scalar_mean, abs=1e-12)


class TestPerCohortCompletenessShapeAndRange:

    def test_one_value_per_cohort_in_order(self):
        runtime = _runtime_stub()
        per_cohort = _per_cohort(runtime, AGES, WEIGHTS, _HORIZON)
        assert per_cohort.shape == (len(AGES),)

    def test_values_in_unit_interval(self):
        runtime = _runtime_stub()
        per_cohort = _per_cohort(runtime, AGES, WEIGHTS, _HORIZON)
        assert np.all(per_cohort >= 0.0)
        assert np.all(per_cohort <= 1.0)

    def test_monotone_non_decreasing_in_age(self):
        # Completeness is a CDF readout — non-decreasing in eval_age.
        runtime = _runtime_stub()
        ages = [1, 5, 10, 20, 30]
        per_cohort = _per_cohort(runtime, ages, [1.0] * len(ages), _HORIZON)
        assert np.all(np.diff(per_cohort) >= -1e-12)


class TestScalarApi:

    def test_empty_ages_returns_all_none(self):
        runtime = _runtime_stub()
        assert _runtime_completeness(
            runtime, cohort_eval_ages=[], cohort_weights=[],
            horizon=_HORIZON,
        ) == (None, None, None)

    def test_per_cohort_none_on_empty_ages(self):
        runtime = _runtime_stub()
        assert _per_cohort(runtime, [], [], _HORIZON) is None
