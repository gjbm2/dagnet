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

from runner.cohort_forecast_v3 import reduce_daily_conversions_rows, _date_key

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
                 completeness=None, observed_x=None, observed_y=None,
                 strict_x=None, strict_y=None):
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
        self.strict_x = strict_x
        self.strict_y = strict_y
        # Legacy comparison values used only to seed default strict surfaces.
        self.observed_x = x_frozen if observed_x is None else observed_x
        self.observed_y = obs_y[eval_age] if observed_y is None else observed_y


def _build(cohorts, *, band_taus, max_tau, completeness_present=True,
           cf_mode='sweep', cf_reason=None, promoted_source='analytic'):
    """Assemble a mock CFProjectionBundle for the bundle-only date reducer."""
    T = max_tau + 1
    admitted = [c for c in cohorts if c.projection_index is not None]
    admitted.sort(key=lambda c: c.projection_index)
    C_proj = len(admitted)
    ef_x = np.zeros((C_proj, _S, T))
    ef_y = np.zeros((C_proj, _S, T))
    ef_fx = np.zeros((C_proj, _S, T))
    ef_fy = np.zeros((C_proj, _S, T))
    ef_rate = np.full((C_proj, _S, T), np.nan)
    strict_x = np.zeros((C_proj, T))
    strict_y = np.zeros((C_proj, T))
    date_ef_x = np.full((len(cohorts), _S, T), np.nan)
    date_ef_y = np.full((len(cohorts), _S, T), np.nan)
    date_ef_fx = np.full((len(cohorts), _S, T), np.nan)
    date_ef_fy = np.full((len(cohorts), _S, T), np.nan)
    date_ef_rate = np.full((len(cohorts), _S, T), np.nan)
    date_f_x = np.full((len(cohorts), _S, T), np.nan)
    date_f_y = np.full((len(cohorts), _S, T), np.nan)
    date_f_rate = np.full((len(cohorts), _S, T), np.nan)
    date_strict_x = np.full((len(cohorts), T), np.nan)
    date_strict_y = np.full((len(cohorts), T), np.nan)
    cohort_position = {id(c): idx for idx, c in enumerate(cohorts)}
    for c in admitted:
        ef_x[c.projection_index] = c.ef_x
        ef_y[c.projection_index] = c.ef_y
        ef_fx[c.projection_index] = c.ef_forecast_x
        ef_fy[c.projection_index] = c.ef_forecast_y
        ef_rate[c.projection_index] = c.ef_rate
        strict_x[c.projection_index] = (
            c.strict_x if c.strict_x is not None
            else np.full(T, float(c.observed_x), dtype=np.float64)
        )
        strict_y[c.projection_index] = (
            c.strict_y if c.strict_y is not None
            else np.full(T, float(c.observed_y), dtype=np.float64)
        )
        pos = cohort_position[id(c)]
        date_ef_x[pos] = c.ef_x
        date_ef_y[pos] = c.ef_y
        date_ef_fx[pos] = c.ef_forecast_x
        date_ef_fy[pos] = c.ef_forecast_y
        date_ef_rate[pos] = c.ef_rate
        date_f_x[pos] = c.ef_x * 1.2
        date_f_y[pos] = c.ef_y * 0.8
        date_f_rate[pos] = date_f_y[pos] / date_f_x[pos]
        date_strict_x[pos] = strict_x[c.projection_index]
        date_strict_y[pos] = strict_y[c.projection_index]

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
        date_axis_projection=SimpleNamespace(
            anchor_days=[c.anchor for c in cohorts],
            f_x_draws=date_f_x,
            f_y_draws=date_f_y,
            f_rate_draws=date_f_rate,
            ef_x_draws=date_ef_x,
            ef_y_draws=date_ef_y,
            ef_rate_draws=date_ef_rate,
            ef_forecast_x=date_ef_fx,
            ef_forecast_y=date_ef_fy,
            evidence_x_strict=date_strict_x,
            evidence_y_strict=date_strict_y,
            reason=[c.reason for c in cohorts],
        ),
        completeness_by_cohort=completeness_by_cohort,
        cohort_projection_status=cohort_projection_status,
        cohort_eval_ages=[c.eval_age for c in cohorts],
        frame_evidence=SimpleNamespace(engine_cohorts=engine_cohorts),
        latency_band_taus=list(band_taus),
        evidence_latency_band_taus=list(band_taus),
        model_latency_band_taus=list(band_taus),
        max_tau=max_tau,
        cf_mode=cf_mode,
        cf_reason=cf_reason,
        promoted_source=promoted_source,
    )
    return bundle


def _row_by_date(result, date):
    return next(
        r for r in result['rate_by_cohort']
        if _date_key(r['date']) == _date_key(date)
    )


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
              completeness=0.5, **overrides):
    """An admitted, immature Cohort: projected_y (≈30) > observed y (18),
    finite forecast residual and rate draws."""
    observed_y = overrides.pop('observed_y', 18.0)
    return _Cohort(
        anchor, reason=reason, projection_index=proj_idx,
        eval_age=6, obs_y=_obs_y_ramp(18.0, 6), x_frozen=100.0,
        observed_y=observed_y,
        ef_x=_const_draws(100.0, _T),
        ef_y=_spread_draws(28.0, 32.0, _T),
        ef_forecast_x=_const_draws(0.0, _T),
        ef_forecast_y=_spread_draws(10.0, 14.0, _T),
        ef_rate=_spread_draws(0.28, 0.32, _T),
        completeness=completeness,
        **overrides,
    )


class TestObservedAndScalarFields:

    def test_observed_fields_read_reclocked_strict_evidence_surface(self):
        strict_x = np.full(_T, 92.0, dtype=np.float64)
        strict_y = np.full(_T, 37.0, dtype=np.float64)
        c = _immature(
            '2026-03-10',
            0,
            observed_x=100.0,
            observed_y=18.0,
            strict_x=strict_x,
            strict_y=strict_y,
        )
        bundle = _build(
            [c], band_taus=[], max_tau=_MAX_TAU,
        )
        result = reduce_daily_conversions_rows(bundle)
        row = _row_by_date(result, '2026-03-10')
        assert row['x'] == 92.0
        assert row['y'] == 37.0
        assert row['rate'] == pytest.approx(37.0 / 92.0)
        assert row['evidence_y'] == row['y']

    def test_response_level_fields_preserved_and_scalar_metadata_added(self):
        bundle = _build(
            [_immature('2026-03-10', 0)], band_taus=[], max_tau=_MAX_TAU,
            cf_mode='sweep', cf_reason=None, promoted_source='analytic',
        )
        result = reduce_daily_conversions_rows(bundle)
        assert result['analysis_type'] == 'daily_conversions'
        assert result['date_range'] == {'from': '10-Mar-26', 'to': '10-Mar-26'}
        # Scalar metadata read straight from the bundle.
        assert result['cf_mode'] == 'sweep'
        assert result['cf_reason'] is None
        assert result['promoted_source'] == 'analytic'

    def test_row_count_matches_observed_selected_set(self):
        cohorts = [_immature('2026-03-10', 0), _immature('2026-03-08', 1)]
        bundle = _build(cohorts, band_taus=[], max_tau=_MAX_TAU)
        result = reduce_daily_conversions_rows(bundle)
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
        bundle = _build([c], band_taus=[], max_tau=_MAX_TAU)
        result = reduce_daily_conversions_rows(bundle)
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
        bundle = _build([c], band_taus=[], max_tau=_MAX_TAU)
        result = reduce_daily_conversions_rows(bundle)
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
        bundle = _build([c], band_taus=[], max_tau=_MAX_TAU)
        result = reduce_daily_conversions_rows(bundle)
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
        bundle = _build([c], band_taus=[], max_tau=_MAX_TAU)
        result = reduce_daily_conversions_rows(bundle)
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
        bundle = _build([c], band_taus=[], max_tau=_MAX_TAU)
        result = reduce_daily_conversions_rows(bundle)
        row = _row_by_date(result, '2026-03-10')
        assert row['forecast_bands'] is None
        # Count surfaces are independent from rate-band availability.
        assert row['projected_y'] is not None


class TestCompletenessAndLayer:

    def test_completeness_reads_bundle_aligned_scalar(self):
        c = _immature('2026-03-10', 0, completeness=0.42)
        c.ef_rate[:, c.eval_age] = np.linspace(0.20, 0.40, _S)
        c.ef_rate[:, _MAX_TAU] = np.linspace(0.50, 0.80, _S)
        bundle = _build([c], band_taus=[], max_tau=_MAX_TAU)
        result = reduce_daily_conversions_rows(bundle)
        # The date reducer is a projection-boundary readout. It consumes
        # the bundle's cohort_list-aligned completeness scalar; the bundle
        # builder / scalar reducer own the frontier-terminal ratio maths.
        assert _row_by_date(result, '2026-03-10')['completeness'] == pytest.approx(0.42)

    def test_backend_does_not_emit_display_layer(self):
        cohorts = [
            _immature('2026-03-10', 0, completeness=0.0),
            _immature('2026-03-08', 1, completeness=0.5),
            _immature('2026-03-06', 2, completeness=1.0),
        ]
        bundle = _build(cohorts, band_taus=[], max_tau=_MAX_TAU)
        result = reduce_daily_conversions_rows(bundle)
        for row in result['rate_by_cohort']:
            assert 'layer' not in row

    def test_completeness_null_when_bundle_value_is_nan(self):
        c = _immature('2026-03-10', 0, completeness=np.nan)
        bundle = _build([c], band_taus=[], max_tau=_MAX_TAU)
        result = reduce_daily_conversions_rows(bundle)
        row = _row_by_date(result, '2026-03-10')
        assert row['completeness'] is None
        assert 'layer' not in row


class TestLatencyBands:

    def test_latency_band_is_uniform_fc_plane_readout_past_frontier(self):
        c = _immature('2026-03-10', 0, completeness=0.97)
        c.eval_age = 10
        c.ef_rate[:, 4] = 0.35
        c.strict_x = np.full(_T, 100.0, dtype=np.float64)
        c.strict_y = np.full(_T, 20.0, dtype=np.float64)
        c.strict_y[4] = 28.0
        bundle = _build(
            [c], band_taus=[(4, '4d')], max_tau=_MAX_TAU,
        )
        result = reduce_daily_conversions_rows(bundle)
        band = _row_by_date(result, '2026-03-10')['latency_bands']['4d']
        evidence_band = _row_by_date(result, '2026-03-10')['evidence_latency_bands']['4d']
        assert 'source' not in band
        assert band['rate'] == pytest.approx(0.35)
        assert set(band['bands'].keys()) == {'80', '90'}
        assert evidence_band['rate'] == pytest.approx(0.28)

    def test_latency_band_is_uniform_fc_plane_readout_before_frontier(self):
        c = _immature('2026-03-10', 0)
        c.eval_age = 6
        bundle = _build(
            [c], band_taus=[(12, '12d')], max_tau=_MAX_TAU,
        )
        result = reduce_daily_conversions_rows(bundle)
        band = _row_by_date(result, '2026-03-10')['latency_bands']['12d']
        assert 'source' not in band
        expected_median = float(np.nanmedian(c.ef_rate[:, 12]))
        assert band['rate'] == pytest.approx(expected_median)
        assert set(band['bands'].keys()) == {'80', '90'}
        assert band['bands']['90'][0] <= band['bands']['80'][0]

    def test_latency_band_carries_fc_and_strict_evidence_contour_values(self):
        c = _immature('2026-03-10', 0)
        c.ef_rate[:, 8] = 0.35
        c.strict_x = np.full(_T, 100.0, dtype=np.float64)
        c.strict_y = np.full(_T, 20.0, dtype=np.float64)
        c.strict_y[8] = 28.0
        bundle = _build(
            [c], band_taus=[(8, '8d')], max_tau=_MAX_TAU,
        )
        result = reduce_daily_conversions_rows(bundle)
        fc_band = _row_by_date(result, '2026-03-10')['latency_bands']['8d']
        evidence_band = _row_by_date(result, '2026-03-10')['evidence_latency_bands']['8d']

        assert fc_band['rate'] == pytest.approx(0.35)
        assert evidence_band['rate'] == pytest.approx(0.28)

    def test_band_tau_above_array_horizon_is_null_with_provenance(self):
        # band_tau beyond bundle.max_tau (the FC array horizon): the band
        # is genuinely unavailable — null, with a recorded reason. The
        # reducer does not clamp or substitute.
        c = _immature('2026-03-10', 0)
        c.eval_age = 0  # forces forecast side were it in range
        above = _MAX_TAU + 5
        bundle = _build(
            [c], band_taus=[(above, f'{above}d')], max_tau=_MAX_TAU,
        )
        result = reduce_daily_conversions_rows(bundle)
        row = _row_by_date(result, '2026-03-10')
        assert row['latency_bands'][f'{above}d'] is None
        assert (row['_projection_provenance']['latency_bands'][f'{above}d']
                == 'band_tau_above_saturation')


class TestSkippedCohort:

    def test_skipped_active_cohort_emits_row_with_null_projection(self):
        # An active Cohort with no admissible root-window carrier evidence:
        # strict evidence and projection fields are all null, provenance
        # reason recorded. Not dropped.
        skipped = _Cohort(
            '2026-03-04', reason='no_root_window_evidence',
            projection_index=None, eval_age=3,
            obs_y=_obs_y_ramp(5.0, 3), x_frozen=40.0,
            observed_x=40.0, observed_y=5.0, completeness=np.nan,
        )
        admitted = _immature('2026-03-10', 0)
        bundle = _build(
            [admitted, skipped], band_taus=[(4, '4d')], max_tau=_MAX_TAU,
        )
        result = reduce_daily_conversions_rows(bundle)
        row = _row_by_date(result, '2026-03-04')
        assert row['x'] is None
        assert row['y'] is None
        assert row['rate'] is None
        assert row['evidence_y'] is None
        # Projection fields all null.
        for f in ('projected_y', 'forecast_y', 'forecast_bands',
                  'projected_x', 'forecast_x'):
            assert row[f] is None, f
        assert row['latency_bands'] == {'4d': {'rate': None, 'bands': None}}
        assert row['completeness'] is None
        assert 'layer' not in row
        assert row['_projection_provenance']['reason'] == 'no_root_window_evidence'

    def test_admitted_cohort_carries_its_provenance_reason(self):
        c = _immature('2026-03-10', 0)
        bundle = _build([c], band_taus=[], max_tau=_MAX_TAU)
        result = reduce_daily_conversions_rows(bundle)
        row = _row_by_date(result, '2026-03-10')
        assert row['_projection_provenance']['reason'] == 'root_window_carrier_n'


class TestModeBlindReadout:
    """The reducer carries no window/cohort/hop flag — "active",
    "window", and "multi-hop" Cohorts with identical per-Cohort arrays
    produce identical rows (CF_ROW_PIPELINE §4 mode-blindness)."""

    def test_window_and_active_immature_identical_when_arrays_equal(self):
        window = _immature('2026-03-10', 0, reason='root_window_carrier_n')
        active = _immature('2026-03-10', 0, reason='root_window_carrier_n')
        b1 = _build([window], band_taus=[(12, '12d')], max_tau=_MAX_TAU)
        b2 = _build([active], band_taus=[(12, '12d')], max_tau=_MAX_TAU)
        r1 = _row_by_date(reduce_daily_conversions_rows(b1), '2026-03-10')
        r2 = _row_by_date(reduce_daily_conversions_rows(b2), '2026-03-10')
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
        bundle = _build([c], band_taus=[], max_tau=_MAX_TAU)
        result = reduce_daily_conversions_rows(bundle)
        row = _row_by_date(result, '2026-03-10')
        assert row['projected_x'] == pytest.approx(
            float(np.mean(c.ef_x[:, _MAX_TAU])))
        assert row['projected_y'] == pytest.approx(
            float(np.mean(c.ef_y[:, _MAX_TAU])))
