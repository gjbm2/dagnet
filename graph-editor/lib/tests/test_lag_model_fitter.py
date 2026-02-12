"""
Tests for lag_model_fitter — fitting lognormal models from snapshot evidence.

Tests use constructed row sets (no DB dependency). Row shape matches what
query_snapshots / query_snapshots_for_sweep return (dict with lowercase keys).
"""

import math
import json
import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from slice_key_normalisation import normalise_slice_key_for_matching
from runner.lag_model_fitter import (
    FitResult,
    select_latest_evidence,
    aggregate_evidence,
    fit_model_from_evidence,
)
from runner.forecasting_settings import ForecastingSettings


# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

def _row(anchor_day: str, x: int, y: int,
         median_lag: float = 5.0, mean_lag: float = 7.0,
         onset: float = 0.0, retrieved_at: str = '2026-01-15T12:00:00Z',
         slice_key: str = 'cohort()') -> dict:
    return {
        'anchor_day': anchor_day,
        'x': x,
        'y': y,
        'median_lag_days': median_lag,
        'mean_lag_days': mean_lag,
        'onset_delta_days': onset,
        'retrieved_at': retrieved_at,
        'slice_key': slice_key,
    }


DEFAULTS = ForecastingSettings()


class TestSliceKeyNormalisationVectors:
    def test_vectors_match_frontend_contract(self):
        """
        Shared test vectors used by BOTH FE and BE to pin the matching canonical form.
        """
        vectors_path = Path(__file__).parent.parent.parent / "test-vectors" / "slice-key-normalisation.v1.json"
        vectors = json.loads(vectors_path.read_text(encoding="utf-8"))
        assert isinstance(vectors, list) and len(vectors) > 0
        for v in vectors:
            canonical = str(v.get("canonical", ""))
            variants = v.get("variants") or []
            assert isinstance(variants, list) and len(variants) > 0
            for s in variants:
                assert normalise_slice_key_for_matching(str(s)) == canonical


# ─────────────────────────────────────────────────────────────
# Evidence selection
# ─────────────────────────────────────────────────────────────

class TestSelectLatestEvidence:

    def test_single_row_per_anchor(self):
        rows = [_row('2026-01-01', 100, 30)]
        ev = select_latest_evidence(rows)
        assert len(ev) == 1
        assert ev[0].x == 100
        assert ev[0].y == 30

    def test_latest_retrieved_at_wins(self):
        rows = [
            _row('2026-01-01', 100, 30, retrieved_at='2026-01-10T10:00:00Z'),
            _row('2026-01-01', 120, 40, retrieved_at='2026-01-15T10:00:00Z'),
        ]
        ev = select_latest_evidence(rows)
        assert len(ev) == 1
        assert ev[0].x == 120  # later retrieval wins

    def test_multiple_anchor_days(self):
        rows = [
            _row('2026-01-01', 100, 30),
            _row('2026-01-02', 110, 35),
            _row('2026-01-03', 120, 40),
        ]
        ev = select_latest_evidence(rows)
        assert len(ev) == 3
        assert [e.anchor_day for e in ev] == ['2026-01-01', '2026-01-02', '2026-01-03']

    def test_mece_slice_aggregation(self):
        """Multiple slice_keys for the same anchor_day are summed."""
        rows = [
            _row('2026-01-01', 40, 10, slice_key='context(ch:google).cohort()'),
            _row('2026-01-01', 60, 15, slice_key='context(ch:other).cohort()'),
        ]
        ev = select_latest_evidence(rows)
        assert len(ev) == 1
        assert ev[0].x == 100
        assert ev[0].y == 25

    def test_empty_rows(self):
        assert select_latest_evidence([]) == []

    def test_rows_with_missing_anchor_skipped(self):
        rows = [{'x': 100, 'y': 30, 'retrieved_at': '2026-01-15T12:00:00Z'}]
        assert select_latest_evidence(rows) == []


# ─────────────────────────────────────────────────────────────
# Evidence aggregation
# ─────────────────────────────────────────────────────────────

class TestAggregateEvidence:

    def test_single_anchor_day(self):
        rows = [_row('2026-01-01', 100, 30, median_lag=5.0, mean_lag=7.0)]
        ev = select_latest_evidence(rows)
        med, mean, k, onset, k_rw = aggregate_evidence(ev, DEFAULTS)
        assert med == pytest.approx(5.0)
        assert mean == pytest.approx(7.0)
        assert k == 30

    def test_recency_weighting_favours_recent(self):
        """More recent anchor days should have higher weight."""
        rows = [
            _row('2026-01-01', 100, 50, median_lag=3.0, mean_lag=4.0),
            _row('2026-02-01', 100, 50, median_lag=9.0, mean_lag=12.0),
        ]
        ev = select_latest_evidence(rows)
        # With reference_date = 2026-02-01, the Jan row is 31 days old (half-life 30d).
        med, mean, k, _, k_rw = aggregate_evidence(ev, DEFAULTS, reference_date=date(2026, 2, 1))
        # The Feb row has weight 1.0, Jan row has weight ~0.5.
        # Weighted median should be closer to 9.0 than to 3.0.
        assert med > 6.0, f"Expected recency-weighted median > 6.0, got {med}"
        assert k == 100

    def test_no_evidence(self):
        med, mean, k, onset, k_rw = aggregate_evidence([], DEFAULTS)
        assert med is None
        assert mean is None
        assert k == 0


# ─────────────────────────────────────────────────────────────
# Full model fitting
# ─────────────────────────────────────────────────────────────

class TestFitModelFromEvidence:

    def test_typical_fit(self):
        """Sufficient data with good median/mean ratio produces quality_ok fit."""
        rows = [
            _row(f'2026-01-{d:02d}', 100, 40, median_lag=5.0, mean_lag=7.0)
            for d in range(1, 11)  # 10 anchor days, 400 total converters
        ]
        result = fit_model_from_evidence(rows, DEFAULTS, model_trained_at='10-Feb-26')
        assert result.quality_ok
        # FE parity: FitResult.total_k reflects the recency-weighted converter count
        # used for the quality gate (not raw ΣY).
        assert result.total_k == pytest.approx(361.2945514930412, rel=1e-9)
        assert result.mu > 0
        assert result.sigma > 0
        assert result.t95_days > 0
        assert result.model_trained_at == '10-Feb-26'
        assert result.evidence_anchor_days == 10

    def test_insufficient_converters(self):
        """Below min_fit_converters quality gate → quality_ok=False."""
        rows = [_row('2026-01-01', 100, 5, median_lag=5.0, mean_lag=7.0)]
        result = fit_model_from_evidence(rows, DEFAULTS)
        assert not result.quality_ok
        assert result.total_k == 5
        assert 'Insufficient' in (result.quality_failure_reason or '')

    def test_no_evidence(self):
        result = fit_model_from_evidence([], DEFAULTS)
        assert not result.quality_ok
        assert 'No evidence' in (result.quality_failure_reason or '')

    def test_missing_mean_uses_default_sigma(self):
        """When mean_lag is None, FE aggregation falls back mean to median, yielding σ=0 (degenerate lognormal)."""
        rows = [
            _row(f'2026-01-{d:02d}', 100, 40, median_lag=5.0, mean_lag=None)
            for d in range(1, 11)
        ]
        # Set mean_lag to None explicitly
        for r in rows:
            r['mean_lag_days'] = None
        result = fit_model_from_evidence(rows, DEFAULTS)
        assert result.quality_ok
        assert result.sigma == pytest.approx(0.0)

    def test_t95_constraint_widens_sigma(self):
        """Authoritative t95 > moment-fit t95 should widen sigma."""
        rows = [
            _row(f'2026-01-{d:02d}', 100, 40, median_lag=5.0, mean_lag=5.5)
            for d in range(1, 11)
        ]
        result_unconstrained = fit_model_from_evidence(rows, DEFAULTS)
        result_constrained = fit_model_from_evidence(rows, DEFAULTS, t95_constraint=60.0)
        # Constrained sigma should be >= unconstrained (one-way).
        assert result_constrained.sigma >= result_unconstrained.sigma
        assert result_constrained.t95_days >= result_unconstrained.t95_days

    def test_t95_constraint_does_not_narrow_sigma(self):
        """Authoritative t95 < moment-fit t95 should NOT narrow sigma."""
        rows = [
            _row(f'2026-01-{d:02d}', 100, 40, median_lag=5.0, mean_lag=10.0)
            for d in range(1, 11)
        ]
        result_unconstrained = fit_model_from_evidence(rows, DEFAULTS)
        result_constrained = fit_model_from_evidence(rows, DEFAULTS, t95_constraint=1.0)
        # Sigma should be unchanged (constraint is smaller than moment-fit).
        assert abs(result_constrained.sigma - result_unconstrained.sigma) < 1e-12

    def test_onset_delta_shifts_fit(self):
        """Non-zero onset_delta should be reflected in the result."""
        rows = [
            _row(f'2026-01-{d:02d}', 100, 40, median_lag=10.0, mean_lag=14.0, onset=3.0)
            for d in range(1, 11)
        ]
        result = fit_model_from_evidence(rows, DEFAULTS)
        assert result.onset_delta_days == pytest.approx(3.0)
        # mu should be ln(median - onset) = ln(7), not ln(10).
        assert result.mu == pytest.approx(math.log(7.0), abs=1e-4)

    def test_onset_override_is_authoritative(self):
        """Graph-mastered onset_override must override evidence onset."""
        rows = [
            _row(f'2026-01-{d:02d}', 100, 40, median_lag=10.0, mean_lag=14.0, onset=0.0)
            for d in range(1, 11)
        ]
        result = fit_model_from_evidence(rows, DEFAULTS, onset_override=3.0)
        assert result.onset_delta_days == pytest.approx(3.0)
        assert result.mu == pytest.approx(math.log(7.0), abs=1e-4)

    def test_settings_override_quality_gate(self):
        """Custom min_fit_converters from settings should be respected."""
        rows = [_row('2026-01-01', 100, 15, median_lag=5.0, mean_lag=7.0)]
        strict = ForecastingSettings(min_fit_converters=30)
        lenient = ForecastingSettings(min_fit_converters=10)
        assert not fit_model_from_evidence(rows, strict).quality_ok
        assert fit_model_from_evidence(rows, lenient).quality_ok

    def test_provenance_fields_passed_through(self):
        rows = [_row('2026-01-01', 100, 40, median_lag=5.0, mean_lag=7.0)]
        result = fit_model_from_evidence(
            rows, DEFAULTS,
            model_trained_at='10-Feb-26',
            training_window={'anchor_from': '2026-01-01', 'anchor_to': '2026-01-10'},
            settings_signature='abc123',
        )
        assert result.model_trained_at == '10-Feb-26'
        assert result.training_window == {'anchor_from': '2026-01-01', 'anchor_to': '2026-01-10'}
        assert result.settings_signature == 'abc123'

    def test_uppercase_x_y_accepted(self):
        """Rows with uppercase X/Y (from some query paths) should also work."""
        rows = [{
            'anchor_day': '2026-01-01',
            'X': 100, 'Y': 40,
            'median_lag_days': 5.0, 'mean_lag_days': 7.0,
            'onset_delta_days': 0,
            'retrieved_at': '2026-01-15T12:00:00Z',
            'slice_key': 'cohort()',
        }]
        result = fit_model_from_evidence(rows, DEFAULTS)
        assert result.total_k == 40
