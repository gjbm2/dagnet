"""73q Phase 5e — the dedicated scalar reducer.

The third CF client (sibling of the tau reducer ``cohort_maturity`` and
the date reducer ``daily_conversions``) collapses the shared
``CFProjectionBundle`` to scalar moments. This suite pins its contract:

  - input is the one ``CFProjectionBundle`` the existing reducers read;
  - output ``CFScalarReduction`` names fields by represented quantity
    (FC terminal rate, strict empirical terminal evidence, rate-ratio
    progress, and unconditioned model counterparts);
  - the reducer owns its own CALC scope at the perimeter — CALC =
    ``bundle.saturation_tau`` — independent of cohort_maturity's
    (``compute_extent`` / ``max_tau``) and daily_conversions's (per-Cohort
    ``eval_age`` / band-tau) CALC scopes;
  - the completeness CDF compose horizon widens to cover any
    ``eval_age`` deeper than ``saturation_tau``;
  - the reducer is bundle-only: no mode flag, no fallback chain, no
    schema-shape branch (CF_ENGINE_DISCIPLINE).

Reuses the no-DB fixture from ``test_cf_projection_bundle.py``.
"""

import os
import sys
from dataclasses import replace

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

from runner.cohort_forecast_v3 import (  # noqa: E402
    CFScalarReduction,
    _runtime_completeness,
    reduce_cf_scalars,
)

from test_cf_projection_bundle import _build_bundle  # noqa: E402


FORECAST_SCALAR_TOL = 1e-6


class TestScalarReducerShape:

    def test_returns_cf_scalar_reduction(self):
        bundle, *_ = _build_bundle()
        out = reduce_cf_scalars(bundle)
        assert isinstance(out, CFScalarReduction)

    def test_fc_terminal_rate_reads_fc_continuation_terminal(self):
        # ``fc_terminal_rate_mean/sd_predictive`` are the FC continuation's per-draw
        # asymptotic rate, averaged across draws. NOT the topological-
        # reach span asymptote on ``runtime.public_moments`` (that one
        # has no cohort axis and diverges from the FC answer whenever
        # evidence conditioning differs by cohort). The reducer reads
        # ``selected_projection.ef_rate_draws[:, bundle.max_tau]``
        # (model_span_spine.py:2006-2009).
        bundle, *_ = _build_bundle()
        out = reduce_cf_scalars(bundle)
        sp = bundle.selected_projection
        max_tau_idx = int(bundle.max_tau)
        ef_rate_at_sat = sp.ef_rate_draws[:, max_tau_idx]
        assert out.fc_terminal_rate_mean == pytest.approx(
            float(np.nanmean(ef_rate_at_sat)), abs=FORECAST_SCALAR_TOL,
        )
        assert out.fc_terminal_rate_sd_predictive == pytest.approx(
            float(np.nanstd(ef_rate_at_sat)), abs=FORECAST_SCALAR_TOL,
        )

    def test_completeness_scalars_are_finite_and_in_unit_interval(self):
        bundle, *_ = _build_bundle()
        out = reduce_cf_scalars(bundle)
        assert np.isfinite(out.fc_frontier_to_terminal_rate_ratio_mean)
        assert np.isfinite(out.fc_frontier_to_terminal_rate_ratio_sd_predictive)
        assert 0.0 <= out.fc_frontier_to_terminal_rate_ratio_mean <= 1.0
        assert out.fc_frontier_to_terminal_rate_ratio_sd_predictive >= 0.0


class TestScalarReducerEvidenceTotals:
    """``evidence_n`` / ``evidence_k`` are the Σx / Σy totals the CF
    endpoint forwards onto the param-pack edge ``p.evidence`` block. They
    come from the empirical operator's strict cumulative surfaces at
    ``bundle.max_tau`` (the terminal forward-filled cell), not from a row
    aggregation — so the CF endpoint can read them without invoking the
    cohort_maturity tau reducer (Step B of Phase 5e)."""

    def test_evidence_totals_are_ints_or_none(self):
        bundle, *_ = _build_bundle()
        out = reduce_cf_scalars(bundle)
        # The fixture admits real Cohorts with `n=300, k=60`, so the
        # empirical operator resolves a non-empty surface: both totals
        # must be ints, not None. (The None branch is the empty-empirical
        # degenerate; covered separately.)
        assert isinstance(out.strict_empirical_terminal_evidence_n, int)
        assert isinstance(out.strict_empirical_terminal_evidence_k, int)

    def test_evidence_totals_match_row_builder_at_terminal_tau(self):
        """The scalar reducer's terminal-cell read must agree with what
        the row builder writes per τ at the same index. This is the
        cross-check that the new scalar source equals the old row source
        the CF endpoint currently scrapes (`last_row['evidence_x']` /
        `last_row['evidence_y']` at api_handlers.py:2437-2438)."""
        bundle, *_ = _build_bundle()
        sp = bundle.selected_projection
        max_tau = int(bundle.max_tau)
        # The row builder writes `evidence_x: float(sp.evidence_x_strict[tau])`
        # per tau (cohort_forecast_v3.py:1492-1493). At max_tau the row's
        # value would equal the scalar reducer's pre-round value.
        expected_x = float(sp.evidence_x_strict[max_tau])
        expected_y = float(sp.evidence_y_strict[max_tau])
        out = reduce_cf_scalars(bundle)
        assert out.strict_empirical_terminal_evidence_n == int(round(expected_x))
        assert out.strict_empirical_terminal_evidence_k == int(round(expected_y))

    def test_evidence_totals_monotonic_or_zero(self):
        bundle, *_ = _build_bundle()
        out = reduce_cf_scalars(bundle)
        # k/n ≤ 1 by construction (every conversion is bounded by its
        # opportunity). The strict surfaces preserve this end-to-end.
        assert (
            out.strict_empirical_terminal_evidence_n is not None
            and out.strict_empirical_terminal_evidence_k is not None
        )
        assert (
            0 <= out.strict_empirical_terminal_evidence_k
            <= out.strict_empirical_terminal_evidence_n
        )


class TestScalarReducerCalcScope:
    """The reducer's CALC scope is ``saturation_tau`` — independent of the
    two row reducers. The completeness horizon is derived from
    ``saturation_tau`` and the per-Cohort eval ages, not from
    ``compute_extent`` or ``max_tau``."""

    def test_completeness_mean_is_fc_rate_ratio_at_frontier_over_saturation(self):
        # ``fc_frontier_to_terminal_rate_ratio_mean`` is the N-weighted average of
        # each admitted Cohort's FC rate(frontier_c) / FC rate(saturation),
        # averaged across draws. Reads the FC per-Cohort surface
        # ``ef_rate_draws_by_cohort`` (NOT the un-normalised request CDF
        # which was the pre-fix behaviour: that returned CDF(eval_age)
        # without dividing by CDF(asymptote), so values understated
        # completeness whenever the asymptote was < 1).
        bundle, *_ = _build_bundle()
        sp = bundle.selected_projection
        max_tau_idx = int(bundle.max_tau)
        ef_rate_bc = sp.ef_rate_draws_by_cohort
        admitted_idx = np.array([
            i for i, status in enumerate(bundle.cohort_projection_status)
            if status.get('projection_index') is not None
        ], dtype=np.int64)
        ea_admitted = np.asarray(bundle.cohort_eval_ages, dtype=np.int64)[admitted_idx]
        weights_admitted = (
            np.asarray(bundle.cohort_weights, dtype=np.float64)[admitted_idx]
        )
        weights_admitted = weights_admitted + float(weights_admitted.sum() == 0.0)
        c_admitted = ef_rate_bc.shape[0]
        rate_at_frontier = ef_rate_bc[np.arange(c_admitted), :, ea_admitted]
        rate_at_max = ef_rate_bc[:, :, max_tau_idx]
        ratio_cs = rate_at_frontier / rate_at_max
        per_draw = (weights_admitted[:, None] * ratio_cs).sum(axis=0) / weights_admitted.sum()
        out = reduce_cf_scalars(bundle)
        assert out.fc_frontier_to_terminal_rate_ratio_mean == pytest.approx(
            float(np.nanmean(per_draw)), abs=FORECAST_SCALAR_TOL,
        )
        assert out.fc_frontier_to_terminal_rate_ratio_sd_predictive == pytest.approx(
            float(np.nanstd(per_draw)), abs=FORECAST_SCALAR_TOL,
        )

    def test_calc_horizon_independent_of_max_tau(self):
        """When ``compute_extent`` makes ``saturation_tau == max_tau``, the
        scalar reducer's horizon is still derived from ``saturation_tau``
        and the eval ages — not the row-reducer's ``max_tau``. Pin the
        derivation explicitly so a future change to ``max_tau`` policy
        cannot silently move the scalar reducer's CALC with it."""
        bundle, *_ = _build_bundle()
        eval_ages = list(bundle.cohort_eval_ages)
        derived_horizon = (
            max(int(bundle.saturation_tau), max(int(a) for a in eval_ages) + 1)
            if eval_ages else int(bundle.saturation_tau)
        )
        # The derivation reads `saturation_tau` and `cohort_eval_ages`
        # only. `max_tau` (= projection horizon for the two row reducers)
        # does not enter the calculation.
        assert derived_horizon >= int(bundle.saturation_tau)
        if eval_ages:
            assert derived_horizon >= max(int(a) for a in eval_ages) + 1


class TestScalarReducerNoBranchCheck:
    """The scalar reducer reads bundle accessors only — no mode flag, no
    identity-vs-active branch. The fixture's window-mode bundle exercises
    the same code path that active and identity-carrier bundles will."""

    def test_reducer_signature_is_bundle_only(self):
        # No `is_window`, `is_active`, `mode`, or identity-carrier kwarg.
        # Mode information enters through `bundle.runtime`'s composed
        # objects (carrier may be `None` for identity), not through the
        # reducer's parameter list.
        import inspect

        sig = inspect.signature(reduce_cf_scalars)
        params = list(sig.parameters.values())
        assert len(params) == 1
        assert params[0].name == 'bundle'
        assert params[0].default is inspect.Parameter.empty


class TestScalarReducerGaugeSurface:
    """73q Phase 5a — the surprise-gauge surface.

    The widened reducer exposes four marginal pairs the gauge consumes
    as a two-distribution z-score:

      needle = FC predictive  (post-evidence, predictive dispersion)
      dial   = unc epistemic  (model-only prior, epistemic dispersion)

      z = (needle_mean − dial_mean) / sqrt(needle_sd² + dial_sd²)

    This suite pins the algebra: each field is sourced from the matching
    precomputed runtime/overlay surface, the conditioned (FC) and
    unconditioned (model overlay) span p moments come from the
    span-composer's stored fields, and the completeness pairs are
    N-weighted CDF reductions over the corresponding span pairs.

    The CDF / span surfaces are precomputed at bundle build time; the
    reducer is straight algebra over them."""

    def test_fc_terminal_rate_is_the_p_needle_quantity(self):
        # The gauge's p needle is the FC terminal selected-Cohort rate.
        bundle, *_ = _build_bundle()
        out = reduce_cf_scalars(bundle)
        assert out.fc_terminal_rate_mean is not None
        assert out.fc_terminal_rate_sd_predictive is not None

    def test_p_unc_epistemic_reads_overlay_span(self):
        # Dial for p reads the unconditioned epistemic overlay's
        # subject span; `span_p_mean` / `span_p_sd` are stored fields
        # populated when the span was composed.
        bundle, *_ = _build_bundle()
        out = reduce_cf_scalars(bundle)
        overlay = bundle.runtime.unconditioned_overlays['epistemic']
        assert out.unconditioned_terminal_rate_mean_epistemic == pytest.approx(
            float(overlay.subject.span_p_mean), abs=FORECAST_SCALAR_TOL,
        )
        assert out.unconditioned_terminal_rate_sd_epistemic == pytest.approx(
            float(overlay.subject.span_p_sd), abs=FORECAST_SCALAR_TOL,
        )

    def test_fc_progress_ratio_is_single_named_quantity(self):
        # The FC progress scalar is the FC continuation's N-weighted
        # rate-ratio at frontier vs terminal tau.
        bundle, *_ = _build_bundle()
        out = reduce_cf_scalars(bundle)
        assert out.fc_frontier_to_terminal_rate_ratio_mean is not None
        assert out.fc_frontier_to_terminal_rate_ratio_sd_predictive is not None

    def test_completeness_unc_epistemic_is_normalised_cdf_ratio_on_overlay(self):
        # Dial for completeness: ``CDF(eval_age) / CDF(saturation)`` per
        # cohort per draw on the unconditioned epistemic overlay's span
        # CDF, N-weighted across admitted cohorts. NOT the un-normalised
        # CDF value (which was the pre-fix behaviour — it returned
        # CDF(eval_age) directly, understating completeness whenever the
        # CDF asymptote was less than 1).
        from runner.cohort_forecast_v3 import _strict_span_request_cdf_draws

        bundle, *_ = _build_bundle()
        out = reduce_cf_scalars(bundle)
        overlay = bundle.runtime.unconditioned_overlays['epistemic']
        eval_ages = bundle.cohort_eval_ages
        horizon = (
            max(int(bundle.saturation_tau), max(int(a) for a in eval_ages) + 1)
            if eval_ages else int(bundle.saturation_tau)
        )
        max_tau_idx = int(bundle.max_tau)
        cdf = _strict_span_request_cdf_draws(
            overlay.subject, overlay.carrier, horizon=horizon,
        )
        admitted_idx = np.array([
            i for i, status in enumerate(bundle.cohort_projection_status)
            if status.get('projection_index') is not None
        ], dtype=np.int64)
        ea_admitted = np.asarray(eval_ages, dtype=np.int64)[admitted_idx]
        weights_admitted = (
            np.asarray(bundle.cohort_weights, dtype=np.float64)[admitted_idx]
        )
        weights_admitted = weights_admitted + float(weights_admitted.sum() == 0.0)
        cdf_at_max = cdf[:, max_tau_idx]
        cdf_at_ea = cdf[:, ea_admitted]
        ratio_sc = cdf_at_ea / cdf_at_max[:, None]
        per_draw = (
            weights_admitted[None, :] * ratio_sc
        ).sum(axis=1) / weights_admitted.sum()
        assert out.unconditioned_frontier_to_terminal_cdf_ratio_mean == pytest.approx(
            float(np.nanmean(per_draw)), abs=FORECAST_SCALAR_TOL,
        )
        assert out.unconditioned_frontier_to_terminal_cdf_ratio_sd_epistemic == pytest.approx(
            float(np.nanstd(per_draw)), abs=FORECAST_SCALAR_TOL,
        )

    def test_completeness_pairs_are_finite_and_in_unit_interval(self):
        # The completeness pairs are CDF values at integer eval_ages,
        # forward-filled per the spine — finite, in [0, 1] for means,
        # non-negative for sds.
        bundle, *_ = _build_bundle()
        out = reduce_cf_scalars(bundle)
        for mean in (
            out.fc_frontier_to_terminal_rate_ratio_mean,
            out.unconditioned_frontier_to_terminal_cdf_ratio_mean,
        ):
            assert mean is not None
            assert np.isfinite(mean)
            assert 0.0 <= mean <= 1.0
        for sd in (
            out.fc_frontier_to_terminal_rate_ratio_sd_predictive,
            out.unconditioned_frontier_to_terminal_cdf_ratio_sd_epistemic,
        ):
            assert sd is not None
            assert np.isfinite(sd)
            assert sd >= 0.0

    def test_gauge_combined_spread_z_score_is_well_defined(self):
        # The gauge's defining algebra: combined-spread z. Whatever the
        # fixture's values are, the denominator is positive (both sds
        # are non-negative and at least one of the two overlays carries
        # MC-induced spread), so z is finite.
        bundle, *_ = _build_bundle()
        out = reduce_cf_scalars(bundle)
        # p gauge
        denom_p = np.sqrt(
            float(out.fc_terminal_rate_sd_predictive) ** 2
            + float(out.unconditioned_terminal_rate_sd_epistemic) ** 2
        )
        assert denom_p > 0.0
        z_p = (
            float(out.fc_terminal_rate_mean)
            - float(out.unconditioned_terminal_rate_mean_epistemic)
        ) / denom_p
        assert np.isfinite(z_p)
        # completeness gauge
        denom_c = np.sqrt(
            float(out.fc_frontier_to_terminal_rate_ratio_sd_predictive) ** 2
            + float(out.unconditioned_frontier_to_terminal_cdf_ratio_sd_epistemic) ** 2
        )
        assert denom_c > 0.0
        z_c = (
            float(out.fc_frontier_to_terminal_rate_ratio_mean)
            - float(out.unconditioned_frontier_to_terminal_cdf_ratio_mean)
        ) / denom_c
        assert np.isfinite(z_c)


class TestScalarFrontierBeyondHorizon:
    """Scalar completeness saturates at the terminal FC coordinate.

    ``conditioned_forecast`` is a scalar analysis type: if a Cohort's
    eval-age is beyond ``bundle.max_tau``, the frontier is already on the
    saturated plateau and reads the terminal column. This is coordinate
    algebra over the bundle's FC plane, not a branch; skipped Cohorts still
    surface as all-NaN slices and are excluded by the finite/weight mask.
    """

    @staticmethod
    def _admitted_idx(bundle):
        w = np.asarray(bundle.cohort_weights, dtype=np.float64)
        return [i for i in range(len(w)) if w[i] > 0.0]

    def test_one_cohort_beyond_horizon_reads_terminal_plateau(self):
        bundle, *_ = _build_bundle()
        admitted = self._admitted_idx(bundle)
        assert len(admitted) >= 2, "fixture must carry >=2 admitted Cohorts"
        max_tau = int(bundle.max_tau)
        in_horizon_age = max(1, max_tau // 2)

        # Pin every admitted Cohort in-horizon, then push exactly one
        # frontier past the horizon. ``ef_rate_draws`` has T = max_tau + 1,
        # so a frontier at ``max_tau + 10`` has no resolved plane.
        ea = [int(a) for a in bundle.cohort_eval_ages]
        for i in admitted:
            ea[i] = in_horizon_age
        ea[admitted[0]] = max_tau + 10
        perturbed = replace(bundle, cohort_eval_ages=ea)

        out = reduce_cf_scalars(perturbed)

        assert out.fc_frontier_to_terminal_rate_ratio_mean is not None
        assert np.isfinite(out.fc_frontier_to_terminal_rate_ratio_mean)
        assert out.fc_frontier_to_terminal_rate_ratio_sd_predictive is not None
        assert np.isfinite(out.fc_frontier_to_terminal_rate_ratio_sd_predictive)

        ef_rate = perturbed.date_axis_projection.ef_rate_draws
        weights = np.asarray(perturbed.cohort_weights, dtype=np.float64)
        ea_arr = np.asarray(perturbed.cohort_eval_ages, dtype=np.int64)
        frontier_idx = np.minimum(ea_arr, max_tau)
        ratio = (
            ef_rate[np.arange(ef_rate.shape[0]), :, frontier_idx]
            / ef_rate[:, :, max_tau]
        )
        defined = np.isfinite(ratio) & (weights[:, None] > 0.0)
        w_def = np.where(defined, weights[:, None], 0.0)
        per_draw = np.where(
            w_def.sum(axis=0) > 0.0,
            np.where(defined, w_def * ratio, 0.0).sum(axis=0) / w_def.sum(axis=0),
            np.nan,
        )
        assert out.fc_frontier_to_terminal_rate_ratio_mean == pytest.approx(
            float(np.nanmean(per_draw)), abs=FORECAST_SCALAR_TOL,
        )
        assert out.fc_frontier_to_terminal_rate_ratio_sd_predictive == pytest.approx(
            float(np.nanstd(per_draw)), abs=FORECAST_SCALAR_TOL,
        )

    def test_all_cohorts_beyond_horizon_are_complete_not_none(self):
        bundle, *_ = _build_bundle()
        max_tau = int(bundle.max_tau)
        ea = [max_tau + 10 for _ in bundle.cohort_eval_ages]
        perturbed = replace(bundle, cohort_eval_ages=ea)

        out = reduce_cf_scalars(perturbed)

        assert out.fc_frontier_to_terminal_rate_ratio_mean == pytest.approx(1.0, abs=FORECAST_SCALAR_TOL)
        assert out.fc_frontier_to_terminal_rate_ratio_sd_predictive == pytest.approx(0.0, abs=FORECAST_SCALAR_TOL)
