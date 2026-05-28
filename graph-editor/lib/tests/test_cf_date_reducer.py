"""73q Phase 3 — date-reducer field-contract algebra over a mock bundle.

The date reducer (``daily_conversions``) is the sibling of the tau
reducer (``cohort_maturity``): both read the one shared
``CFProjectionBundle``. This suite pins the binding "Reducer field
contract" (73q §"Field-by-field contract for rate_by_cohort rows" +
§"Skipped-Cohort handling") **at the reducer boundary**, using a mock
bundle that carries only the fields the contract names. The bundle is a
plain namespace, not the real pipeline — these are algebra tests, so the
arrays are hand-built and the expected values are derivable blind.

Mode-blindness is load-bearing (CF_ROW_PIPELINE §4; AP58): the reducer
reads per-Cohort arrays the bundle already resolved and carries no
``window`` / ``cohort`` / ``hop`` / ``identity`` flag. So "window
immature", "active immature", and "multi-hop" are represented as
admitted Cohorts whose arrays differ only in value — the reducer reads
them identically. The 73q Phase 3 required cases are covered here:
identity/window immature, active immature, multi-hop subject, skipped
active Cohort, band tau above saturation, and all-NaN FC rate draws.

Saturation reconciliation (73q §"Saturation tau and latent extent" +
Phase 2 close-out): the per-Cohort FC arrays are projected to
``bundle.max_tau`` (the latent extent); "evaluated at saturation" reads
the TERMINAL index ``bundle.max_tau``, not a literal 400.
"""

import os
import sys
from types import SimpleNamespace

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from runner.cohort_forecast_v3 import reduce_daily_conversions_rows
from runner.cf_projection_bundle import (
    COMPLETENESS_EPSILON,
    MATURITY_THRESHOLD,
)

_S = 256  # draws


def _const_draws(value, T):
    """(S, T) draws all equal to ``value`` (deterministic mean/median)."""
    return np.full((_S, T), float(value), dtype=np.float64)


def _spread_draws(lo, hi, T):
    """(S, T) draws linearly spread in [lo, hi] at each tau, so band
    quantiles are non-degenerate and ordered."""
    col = np.linspace(lo, hi, _S, dtype=np.float64)
    return np.repeat(col[:, None], T, axis=1)


class _Cohort:
    """One mock cohort_list entry + (optionally) its admitted projection
    arrays. Admitted iff ``projection_index`` is not None."""

    def __init__(self, anchor, *, reason, projection_index,
                 eval_age, obs_y, x_frozen,
                 ef_x=None, ef_y=None, ef_forecast_x=None,
                 ef_forecast_y=None, ef_rate=None,
                 completeness=None, observed_x=None, observed_y=None):
        self.anchor = anchor
        self.reason = reason
        self.projection_index = projection_index
        self.eval_age = eval_age
        self.obs_y = obs_y
        self.x_frozen = x_frozen
        self.ef_x = ef_x
        self.ef_y = ef_y
        self.ef_forecast_x = ef_forecast_x
        self.ef_forecast_y = ef_forecast_y
        self.ef_rate = ef_rate
        self.completeness = completeness
        # Observed snapshot row values (owned by derive_daily_conversions).
        self.observed_x = x_frozen if observed_x is None else observed_x
        self.observed_y = obs_y[eval_age] if observed_y is None else observed_y


def _build(cohorts, *, band_taus, max_tau, completeness_present=True,
           cf_mode='sweep', cf_reason=None, promoted_source='analytic'):
    """Assemble a mock CFProjectionBundle + the matching observed
    daily-conversions dict (one rate_by_cohort row per cohort)."""
    T = max_tau + 1
    admitted = [c for c in cohorts if c.projection_index is not None]
    admitted.sort(key=lambda c: c.projection_index)
    C_proj = len(admitted)
    ef_x = np.zeros((C_proj, _S, T))
    ef_y = np.zeros((C_proj, _S, T))
    ef_fx = np.zeros((C_proj, _S, T))
    ef_fy = np.zeros((C_proj, _S, T))
    ef_rate = np.full((C_proj, _S, T), np.nan)
    for c in admitted:
        ef_x[c.projection_index] = c.ef_x
        ef_y[c.projection_index] = c.ef_y
        ef_fx[c.projection_index] = c.ef_forecast_x
        ef_fy[c.projection_index] = c.ef_forecast_y
        ef_rate[c.projection_index] = c.ef_rate

    selected_projection = SimpleNamespace(
        ef_x_draws_by_cohort=ef_x,
        ef_y_draws_by_cohort=ef_y,
        ef_forecast_x_by_cohort=ef_fx,
        ef_forecast_y_by_cohort=ef_fy,
        ef_rate_draws_by_cohort=ef_rate,
    )
    engine_cohorts = [
        SimpleNamespace(obs_y=c.obs_y, x_frozen=c.x_frozen) for c in cohorts
    ]
    completeness_by_cohort = (
        np.array([c.completeness for c in cohorts], dtype=np.float64)
        if completeness_present else None
    )
    cohort_projection_status = [
        {'anchor_day': c.anchor, 'projection_index': c.projection_index,
         'reason': c.reason}
        for c in cohorts
    ]
    bundle = SimpleNamespace(
        selected_projection=selected_projection,
        completeness_by_cohort=completeness_by_cohort,
        cohort_projection_status=cohort_projection_status,
        cohort_eval_ages=[c.eval_age for c in cohorts],
        frame_evidence=SimpleNamespace(engine_cohorts=engine_cohorts),
        latency_band_taus=list(band_taus),
        max_tau=max_tau,
        cf_mode=cf_mode,
        cf_reason=cf_reason,
        promoted_source=promoted_source,
    )
    observed = {
        'analysis_type': 'daily_conversions',
        'data': [{'date': '2026-03-01', 'conversions': 7}],
        'cohort_y_at_age': {},
        'total_conversions': 7,
        'date_range': {'from': '2026-03-01', 'to': '2026-03-20'},
        'rate_by_cohort': [
            {
                'date': c.anchor,
                'x': c.observed_x,
                'y': c.observed_y,
                'rate': (c.observed_y / c.observed_x
                         if c.observed_x > 0 else None),
            }
            for c in cohorts
        ],
    }
    return bundle, observed


def _row_by_date(result, date):
    return next(r for r in result['rate_by_cohort'] if r['date'] == date)


# ── Fixtures: a representative mixed bundle ──────────────────────────────

# obs_y arrays are length saturation+1; here saturation index is well
# above max_tau so evidence-side band reads are always in range.
_OBS_LEN = 60


def _obs_y_ramp(final, frontier):
    """Monotone observed cumulative-Y: ramps to ``final`` by ``frontier``
    then frozen. Length _OBS_LEN (engine_cohort obs arrays span to the
    composition ceiling, not the latent extent)."""
    y = np.zeros(_OBS_LEN, dtype=np.float64)
    for t in range(_OBS_LEN):
        y[t] = final * min(1.0, (t + 1) / (frontier + 1))
    return list(y)


_MAX_TAU = 20
_T = _MAX_TAU + 1


def _immature(anchor, proj_idx, reason='root_window_carrier_n',
              completeness=0.5):
    """An admitted, immature Cohort: projected_y (≈30) > observed y (18),
    finite forecast residual and rate draws."""
    return _Cohort(
        anchor, reason=reason, projection_index=proj_idx,
        eval_age=6, obs_y=_obs_y_ramp(18.0, 6), x_frozen=100.0,
        observed_y=18.0,
        ef_x=_const_draws(100.0, _T),
        ef_y=_spread_draws(28.0, 32.0, _T),
        ef_forecast_x=_const_draws(0.0, _T),
        ef_forecast_y=_spread_draws(10.0, 14.0, _T),
        ef_rate=_spread_draws(0.28, 0.32, _T),
        completeness=completeness,
    )


class TestObservedAndScalarFields:

    def test_observed_fields_passthrough_and_evidence_y_equals_y(self):
        bundle, observed = _build(
            [_immature('2026-03-10', 0)], band_taus=[], max_tau=_MAX_TAU,
        )
        result = reduce_daily_conversions_rows(bundle, observed)
        row = _row_by_date(result, '2026-03-10')
        assert row['x'] == 100.0
        assert row['y'] == 18.0
        assert row['rate'] == pytest.approx(0.18)
        assert row['evidence_y'] == row['y']

    def test_response_level_fields_preserved_and_scalar_metadata_added(self):
        bundle, observed = _build(
            [_immature('2026-03-10', 0)], band_taus=[], max_tau=_MAX_TAU,
            cf_mode='sweep', cf_reason=None, promoted_source='analytic',
        )
        result = reduce_daily_conversions_rows(bundle, observed)
        # derive_daily_conversions-owned fields survive untouched.
        assert result['analysis_type'] == 'daily_conversions'
        assert result['data'] == observed['data']
        assert result['cohort_y_at_age'] == observed['cohort_y_at_age']
        assert result['total_conversions'] == 7
        assert result['date_range'] == observed['date_range']
        # Scalar metadata read straight from the bundle.
        assert result['cf_mode'] == 'sweep'
        assert result['cf_reason'] is None
        assert result['promoted_source'] == 'analytic'

    def test_row_count_matches_observed_selected_set(self):
        cohorts = [_immature('2026-03-10', 0), _immature('2026-03-08', 1)]
        bundle, observed = _build(cohorts, band_taus=[], max_tau=_MAX_TAU)
        result = reduce_daily_conversions_rows(bundle, observed)
        assert len(result['rate_by_cohort']) == 2


class TestProjectedAndForecast:

    def test_projected_counts_read_terminal_fc_x_and_y(self):
        c = _immature('2026-03-10', 0)
        c.ef_x = _spread_draws(98.0, 102.0, _T)
        c.ef_y = _spread_draws(28.0, 32.0, _T)
        c.ef_x[:, c.eval_age] = 999.0
        c.ef_y[:, c.eval_age] = 999.0
        c.ef_x[:, _MAX_TAU] = 120.0
        c.ef_y[:, _MAX_TAU] = 44.0
        bundle, observed = _build([c], band_taus=[], max_tau=_MAX_TAU)
        result = reduce_daily_conversions_rows(bundle, observed)
        row = _row_by_date(result, '2026-03-10')
        assert row['projected_x'] == pytest.approx(float(np.mean(c.ef_x[:, _MAX_TAU])))
        assert row['projected_y'] == pytest.approx(float(np.mean(c.ef_y[:, _MAX_TAU])))
        # Immature: projected_y strictly exceeds observed y because it is
        # evaluated at the terminal FC horizon, not the evidence frontier.
        assert row['projected_y'] > row['y']

    def test_forecast_residual_counts_read_terminal_fc_surfaces(self):
        c = _immature('2026-03-10', 0)
        c.ef_forecast_x = _spread_draws(3.0, 5.0, _T)
        c.ef_forecast_y = _spread_draws(6.0, 8.0, _T)
        c.ef_forecast_x[:, c.eval_age] = 99.0
        c.ef_forecast_y[:, c.eval_age] = 99.0
        c.ef_forecast_x[:, _MAX_TAU] = 11.0
        c.ef_forecast_y[:, _MAX_TAU] = 9.0
        bundle, observed = _build([c], band_taus=[], max_tau=_MAX_TAU)
        result = reduce_daily_conversions_rows(bundle, observed)
        row = _row_by_date(result, '2026-03-10')
        assert row['forecast_x'] == pytest.approx(float(np.mean(c.ef_forecast_x[:, _MAX_TAU])))
        assert row['forecast_y'] == pytest.approx(float(np.mean(c.ef_forecast_y[:, _MAX_TAU])))
        assert row['forecast_y'] >= 0.0

    def test_forecast_rate_reads_terminal_fc_surface(self):
        # Evidence fields are frontier-indexed. Forecast rate fields read the
        # terminal FC column, which describes the Cohort's ultimate landing.
        c = _immature('2026-03-10', 0)
        c.ef_rate = _spread_draws(0.28, 0.32, _T)
        c.ef_rate[:, c.eval_age] = 0.99
        c.ef_rate[:, _MAX_TAU] = 0.33  # terminal column is unmistakable
        bundle, observed = _build([c], band_taus=[], max_tau=_MAX_TAU)
        result = reduce_daily_conversions_rows(bundle, observed)
        row = _row_by_date(result, '2026-03-10')
        assert row['projected_rate'] == pytest.approx(0.33)
        bands = row['forecast_bands']
        assert bands['80'] == pytest.approx([0.33, 0.33])


class TestForecastBands:

    def test_bands_are_ordered_and_nested(self):
        c = _immature('2026-03-10', 0)
        c.ef_rate = _spread_draws(0.28, 0.32, _T)
        c.ef_rate[:, c.eval_age] = np.linspace(0.80, 0.90, _S)
        c.ef_rate[:, _MAX_TAU] = np.linspace(0.20, 0.60, _S)
        bundle, observed = _build([c], band_taus=[], max_tau=_MAX_TAU)
        result = reduce_daily_conversions_rows(bundle, observed)
        bands = _row_by_date(result, '2026-03-10')['forecast_bands']
        assert set(bands.keys()) == {'80', '90', '95', '99'}
        assert bands['80'][0] < 0.30
        assert bands['80'][1] > 0.50
        assert bands['80'][1] < 0.70
        for level, (lo, hi) in bands.items():
            assert lo <= hi, level
        # Higher confidence contains lower at every nested level pair.
        levels = ['80', '90', '95', '99']
        for inner, outer in zip(levels, levels[1:]):
            assert bands[outer][0] <= bands[inner][0]
            assert bands[outer][1] >= bands[inner][1]

    def test_bands_null_when_rate_draws_all_nan(self):
        c = _immature('2026-03-10', 0)
        c.ef_rate = np.full((_S, _T), np.nan)  # moments-only / undefined rate
        bundle, observed = _build([c], band_taus=[], max_tau=_MAX_TAU)
        result = reduce_daily_conversions_rows(bundle, observed)
        row = _row_by_date(result, '2026-03-10')
        assert row['forecast_bands'] is None
        # Count surfaces are independent from rate-band availability.
        assert row['projected_y'] is not None


class TestCompletenessAndLayer:

    def test_completeness_read_from_bundle_per_cohort(self):
        c = _immature('2026-03-10', 0, completeness=0.42)
        bundle, observed = _build([c], band_taus=[], max_tau=_MAX_TAU)
        result = reduce_daily_conversions_rows(bundle, observed)
        assert _row_by_date(result, '2026-03-10')['completeness'] == pytest.approx(0.42)

    def test_layer_transitions_from_shared_helper(self):
        # Three admitted Cohorts spanning the three layer bands; thresholds
        # come from the shared helper's constants, not hardcoded here.
        below = COMPLETENESS_EPSILON / 2.0
        between = (COMPLETENESS_EPSILON + MATURITY_THRESHOLD) / 2.0
        at_mature = MATURITY_THRESHOLD
        cohorts = [
            _immature('2026-03-10', 0, completeness=below),
            _immature('2026-03-08', 1, completeness=between),
            _immature('2026-03-06', 2, completeness=at_mature),
        ]
        bundle, observed = _build(cohorts, band_taus=[], max_tau=_MAX_TAU)
        result = reduce_daily_conversions_rows(bundle, observed)
        assert _row_by_date(result, '2026-03-10')['layer'] == 'evidence'
        assert _row_by_date(result, '2026-03-08')['layer'] == 'forecast'
        assert _row_by_date(result, '2026-03-06')['layer'] == 'mature'

    def test_layer_is_evidence_when_completeness_unavailable(self):
        # Admitted Cohort but the runtime produced no CDF readout
        # (completeness_by_cohort is None): completeness null, layer
        # degenerates to 'evidence' (the c<=eps branch at c=0).
        c = _immature('2026-03-10', 0)
        bundle, observed = _build(
            [c], band_taus=[], max_tau=_MAX_TAU, completeness_present=False,
        )
        result = reduce_daily_conversions_rows(bundle, observed)
        row = _row_by_date(result, '2026-03-10')
        assert row['completeness'] is None
        assert row['layer'] == 'evidence'


class TestLatencyBands:

    def test_evidence_side_when_eval_age_at_or_past_band_tau(self):
        # Cohort matured past band_tau=4: evidence side reads obs_y[4] /
        # x_frozen as a single rate value.
        c = _immature('2026-03-10', 0, completeness=0.97)
        c.eval_age = 10
        bundle, observed = _build(
            [c], band_taus=[(4, '4d')], max_tau=_MAX_TAU,
        )
        result = reduce_daily_conversions_rows(bundle, observed)
        band = _row_by_date(result, '2026-03-10')['latency_bands']['4d']
        assert band['source'] == 'evidence'
        assert band['rate'] == pytest.approx(c.obs_y[4] / c.x_frozen)
        assert 'bands' not in band

    def test_forecast_side_when_eval_age_before_band_tau(self):
        # band_tau=12 > eval_age=6: forecast side reads per-Cohort FC rate
        # draws at band_tau, with a median + nested bands.
        c = _immature('2026-03-10', 0)
        c.eval_age = 6
        bundle, observed = _build(
            [c], band_taus=[(12, '12d')], max_tau=_MAX_TAU,
        )
        result = reduce_daily_conversions_rows(bundle, observed)
        band = _row_by_date(result, '2026-03-10')['latency_bands']['12d']
        assert band['source'] == 'forecast'
        expected_median = float(np.nanmedian(c.ef_rate[:, 12]))
        assert band['rate'] == pytest.approx(expected_median)
        assert set(band['bands'].keys()) == {'80', '90'}
        assert band['bands']['90'][0] <= band['bands']['80'][0]

    def test_band_tau_above_array_horizon_is_null_with_provenance(self):
        # band_tau beyond bundle.max_tau (the FC array horizon): the band
        # is genuinely unavailable — null, with a recorded reason. The
        # reducer does not clamp or substitute.
        c = _immature('2026-03-10', 0)
        c.eval_age = 0  # forces forecast side were it in range
        above = _MAX_TAU + 5
        bundle, observed = _build(
            [c], band_taus=[(above, f'{above}d')], max_tau=_MAX_TAU,
        )
        result = reduce_daily_conversions_rows(bundle, observed)
        row = _row_by_date(result, '2026-03-10')
        assert row['latency_bands'][f'{above}d'] is None
        assert (row['_projection_provenance']['latency_bands'][f'{above}d']
                == 'band_tau_above_saturation')


class TestSkippedCohort:

    def test_skipped_active_cohort_emits_row_with_null_projection(self):
        # An active Cohort with no admissible root-window carrier evidence:
        # observed fields populated from snapshot output, all projection
        # fields null, provenance reason recorded. Not dropped.
        skipped = _Cohort(
            '2026-03-04', reason='no_root_window_evidence',
            projection_index=None, eval_age=3,
            obs_y=_obs_y_ramp(5.0, 3), x_frozen=40.0,
            observed_x=40.0, observed_y=5.0, completeness=0.3,
        )
        admitted = _immature('2026-03-10', 0)
        bundle, observed = _build(
            [admitted, skipped], band_taus=[(4, '4d')], max_tau=_MAX_TAU,
        )
        result = reduce_daily_conversions_rows(bundle, observed)
        row = _row_by_date(result, '2026-03-04')
        # Observed fields present.
        assert row['x'] == 40.0
        assert row['y'] == 5.0
        assert row['evidence_y'] == 5.0
        # Projection fields all null.
        for f in ('projected_y', 'forecast_y', 'forecast_bands',
                  'projected_x', 'forecast_x', 'completeness', 'layer', 'latency_bands'):
            assert row[f] is None, f
        assert row['_projection_provenance']['reason'] == 'no_root_window_evidence'

    def test_admitted_cohort_carries_its_provenance_reason(self):
        c = _immature('2026-03-10', 0)
        bundle, observed = _build([c], band_taus=[], max_tau=_MAX_TAU)
        result = reduce_daily_conversions_rows(bundle, observed)
        row = _row_by_date(result, '2026-03-10')
        assert row['_projection_provenance']['reason'] == 'root_window_carrier_n'


class TestModeBlindReadout:
    """The reducer carries no window/cohort/hop flag — "active",
    "window", and "multi-hop" Cohorts with identical per-Cohort arrays
    produce identical rows (CF_ROW_PIPELINE §4 mode-blindness)."""

    def test_window_and_active_immature_identical_when_arrays_equal(self):
        window = _immature('2026-03-10', 0, reason='root_window_carrier_n')
        active = _immature('2026-03-10', 0, reason='root_window_carrier_n')
        b1, o1 = _build([window], band_taus=[(12, '12d')], max_tau=_MAX_TAU)
        b2, o2 = _build([active], band_taus=[(12, '12d')], max_tau=_MAX_TAU)
        r1 = _row_by_date(reduce_daily_conversions_rows(b1, o1), '2026-03-10')
        r2 = _row_by_date(reduce_daily_conversions_rows(b2, o2), '2026-03-10')
        assert r1['projected_y'] == pytest.approx(r2['projected_y'])
        assert r1['forecast_y'] == pytest.approx(r2['forecast_y'])
        assert r1['forecast_bands'] == r2['forecast_bands']
        assert r1['latency_bands'] == r2['latency_bands']

    def test_multi_hop_shaped_arrays_are_read_verbatim(self):
        # A multi-hop subject differs from a terminal-edge-only projection
        # only in its array values; the reducer reads whatever ef_y the
        # bundle resolved, with no hop branch.
        c = _immature('2026-03-10', 0)
        c.ef_x = _spread_draws(90.0, 94.0, _T)
        c.ef_y = _spread_draws(40.0, 44.0, _T)  # a distinct multi-hop value
        c.ef_rate = _spread_draws(0.40, 0.44, _T)
        bundle, observed = _build([c], band_taus=[], max_tau=_MAX_TAU)
        result = reduce_daily_conversions_rows(bundle, observed)
        row = _row_by_date(result, '2026-03-10')
        assert row['projected_x'] == pytest.approx(
            float(np.mean(c.ef_x[:, _MAX_TAU])))
        assert row['projected_y'] == pytest.approx(
            float(np.mean(c.ef_y[:, _MAX_TAU])))
