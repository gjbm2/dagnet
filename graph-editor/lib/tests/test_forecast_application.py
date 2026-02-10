"""
Tests for forecast_application — completeness evaluation and evidence/forecast split.
"""

import math
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from runner.forecast_application import (
    compute_completeness,
    annotate_data_point,
    annotate_rows,
    compute_blended_mean,
    COMPLETENESS_EPSILON,
)
from runner.forecasting_settings import ForecastingSettings


# ─────────────────────────────────────────────────────────────
# Realistic model params (from a typical Amplitude edge)
# mu = ln(5) ≈ 1.609, sigma = 0.8, onset = 1 day
# t95 ≈ onset + inverseCDF(0.95, mu, sigma) ≈ 1 + 18.6 ≈ 19.6 days
# ─────────────────────────────────────────────────────────────

MU = math.log(5.0)  # ≈ 1.6094
SIGMA = 0.8
ONSET = 1.0


class TestComputeCompleteness:

    def test_zero_age(self):
        assert compute_completeness(0, MU, SIGMA) == 0.0

    def test_during_dead_time(self):
        """Age <= onset_delta → model_age = 0 → completeness = 0."""
        assert compute_completeness(0.5, MU, SIGMA, onset_delta_days=1.0) == 0.0
        assert compute_completeness(1.0, MU, SIGMA, onset_delta_days=1.0) == 0.0

    def test_mature_cohort(self):
        """Very old cohort → completeness near 1.0."""
        c = compute_completeness(100, MU, SIGMA, onset_delta_days=ONSET)
        assert c > 0.99

    def test_immature_cohort(self):
        """Young cohort (age 3 days, onset 1) → partial completeness."""
        c = compute_completeness(3, MU, SIGMA, onset_delta_days=ONSET)
        assert 0.0 < c < 0.5  # 2 days post-onset, median is 5 → well below median

    def test_at_median(self):
        """Age = onset + median → completeness ≈ 0.5."""
        c = compute_completeness(ONSET + 5.0, MU, SIGMA, onset_delta_days=ONSET)
        assert abs(c - 0.5) < 0.05  # Within 5% of 0.5

    def test_monotonically_increasing(self):
        """Completeness should increase with age."""
        ages = [2, 5, 10, 20, 50]
        completions = [compute_completeness(a, MU, SIGMA, ONSET) for a in ages]
        for i in range(1, len(completions)):
            assert completions[i] >= completions[i - 1]

    def test_no_onset(self):
        """Without onset, age = model_age directly."""
        c_no_onset = compute_completeness(5, MU, SIGMA, onset_delta_days=0)
        c_with_onset = compute_completeness(5, MU, SIGMA, onset_delta_days=2)
        # With onset, effective age is smaller → lower completeness.
        assert c_no_onset > c_with_onset

    def test_sigma_zero_degenerate(self):
        """sigma=0: all conversions at exp(mu). Step function."""
        assert compute_completeness(4.9, MU, 0.0) == 0.0
        assert compute_completeness(5.1, MU, 0.0) == 1.0


class TestAnnotateDataPoint:

    def test_mature_layer(self):
        ann = annotate_data_point(
            anchor_day='2026-01-01',
            retrieved_at_date='2026-03-01',  # 59 days → very mature
            y=50,
            mu=MU, sigma=SIGMA, onset_delta_days=ONSET,
        )
        assert ann.layer == 'mature'
        assert ann.completeness > 0.95
        assert ann.evidence_y == 50
        # Projected should be close to evidence (mature).
        assert ann.projected_y == pytest.approx(50 / ann.completeness, abs=0.1)
        assert ann.forecast_y < 5  # Small residual

    def test_immature_layer(self):
        ann = annotate_data_point(
            anchor_day='2026-01-01',
            retrieved_at_date='2026-01-04',  # 3 days → immature
            y=10,
            mu=MU, sigma=SIGMA, onset_delta_days=ONSET,
        )
        assert ann.layer == 'forecast'
        assert 0 < ann.completeness < 0.95
        assert ann.evidence_y == 10
        assert ann.projected_y > 10  # Projection should be higher than observed
        assert ann.forecast_y > 0

    def test_dead_time_layer(self):
        """During onset dead-time, completeness = 0, layer = evidence (no model info)."""
        ann = annotate_data_point(
            anchor_day='2026-01-01',
            retrieved_at_date='2026-01-01',  # 0 days
            y=0,
            mu=MU, sigma=SIGMA, onset_delta_days=ONSET,
        )
        assert ann.completeness == 0.0
        assert ann.layer == 'evidence'
        assert ann.projected_y == 0  # Can't project with zero completeness

    def test_projection_formula(self):
        """projected_y = y / completeness (when completeness > epsilon)."""
        ann = annotate_data_point(
            anchor_day='2026-01-01',
            retrieved_at_date='2026-01-10',  # 9 days
            y=40,
            mu=MU, sigma=SIGMA, onset_delta_days=ONSET,
        )
        if ann.completeness > COMPLETENESS_EPSILON:
            expected_proj = 40 / ann.completeness
            assert ann.projected_y == pytest.approx(expected_proj, rel=1e-9)
            assert ann.forecast_y == pytest.approx(expected_proj - 40, rel=1e-9)

    def test_bad_dates_produce_zero_completeness(self):
        ann = annotate_data_point(
            anchor_day='not-a-date',
            retrieved_at_date='also-bad',
            y=10,
            mu=MU, sigma=SIGMA,
        )
        assert ann.completeness == 0.0


class TestAnnotateRows:

    def test_annotates_multiple_rows(self):
        rows = [
            {'anchor_day': '2026-01-01', 'y': 30, 'retrieved_at': '2026-02-01T12:00:00Z'},
            {'anchor_day': '2026-01-10', 'y': 25, 'retrieved_at': '2026-02-01T12:00:00Z'},
            {'anchor_day': '2026-01-20', 'y': 15, 'retrieved_at': '2026-02-01T12:00:00Z'},
        ]
        annotated = annotate_rows(rows, MU, SIGMA, ONSET)
        assert len(annotated) == 3
        for r in annotated:
            assert 'completeness' in r
            assert 'layer' in r
            assert 'evidence_y' in r
            assert 'forecast_y' in r
            assert 'projected_y' in r

        # Older cohorts (Jan 1) should be more complete than newer ones (Jan 20).
        assert annotated[0]['completeness'] > annotated[2]['completeness']

    def test_preserves_original_fields(self):
        rows = [{'anchor_day': '2026-01-01', 'y': 30, 'retrieved_at': '2026-02-01', 'custom': 'keep'}]
        annotated = annotate_rows(rows, MU, SIGMA)
        assert annotated[0]['custom'] == 'keep'

    def test_uppercase_Y_accepted(self):
        rows = [{'anchor_day': '2026-01-01', 'Y': 30, 'retrieved_at': '2026-02-01'}]
        annotated = annotate_rows(rows, MU, SIGMA)
        assert annotated[0]['evidence_y'] == 30

    def test_retrieved_at_override(self):
        rows = [{'anchor_day': '2026-01-01', 'y': 30}]  # No retrieved_at on row
        annotated = annotate_rows(rows, MU, SIGMA, retrieved_at_override='2026-02-01T00:00:00Z')
        assert annotated[0]['completeness'] > 0  # Would be 0 without override


class TestComputeBlendedMean:

    def test_full_completeness_equals_observed(self):
        """When c=1.0, blend should be close to observed."""
        result = compute_blended_mean(
            observed_pct=0.5, baseline_pct=0.8,
            completeness=1.0, n_query=100, n_baseline=400,
            settings=ForecastingSettings(),
        )
        # With c=1.0, c^η = 1.0, w = n_q / (λ*n_b + n_q) ≈ 100/(60+100) ≈ 0.625
        assert 0.4 < result < 0.7  # Between observed and baseline, closer to observed

    def test_zero_completeness_equals_baseline(self):
        """When c=0, c^η=0, w=0 → blend = baseline."""
        result = compute_blended_mean(
            observed_pct=0.5, baseline_pct=0.8,
            completeness=0.0, n_query=100, n_baseline=400,
            settings=ForecastingSettings(),
        )
        assert result == 0.8

    def test_partial_completeness_between_observed_and_baseline(self):
        result = compute_blended_mean(
            observed_pct=0.3, baseline_pct=0.7,
            completeness=0.5, n_query=100, n_baseline=400,
            settings=ForecastingSettings(),
        )
        assert 0.3 < result < 0.7

    def test_higher_lambda_favours_baseline(self):
        """Higher λ → forecast prior is stronger → result closer to baseline."""
        low_lambda = ForecastingSettings(forecast_blend_lambda=0.05)
        high_lambda = ForecastingSettings(forecast_blend_lambda=0.5)
        r_low = compute_blended_mean(0.3, 0.7, 0.5, 100, 400, low_lambda)
        r_high = compute_blended_mean(0.3, 0.7, 0.5, 100, 400, high_lambda)
        # Higher lambda → closer to baseline (0.7).
        assert r_high > r_low

    def test_completeness_power_effect(self):
        """Higher η → c^η is smaller → less evidence weight → closer to baseline."""
        low_power = ForecastingSettings(blend_completeness_power=1.0)
        high_power = ForecastingSettings(blend_completeness_power=3.0)
        r_low = compute_blended_mean(0.3, 0.7, 0.5, 100, 400, low_power)
        r_high = compute_blended_mean(0.3, 0.7, 0.5, 100, 400, high_power)
        assert r_high > r_low  # Higher power → closer to baseline
