"""
Regime Selection Consumer Integration Tests (Doc 30 §7.3.4)

For each consumer, feed regime-mixed rows (pre-select_regime_rows)
and verify the output is wrong (red test), then feed regime-selected
rows and verify correctness.

Every test MUST have rows from multiple regimes. A test with only one
regime's rows passes trivially and proves nothing.

Run with: pytest lib/tests/test_regime_consumer_integration.py -v
"""

import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from snapshot_regime_selection import (
    CandidateRegime,
    select_regime_rows,
)
from runner.cohort_maturity_derivation import derive_cohort_maturity
from runner.lag_model_fitter import select_latest_evidence
from runner.daily_conversions_derivation import derive_daily_conversions
from runner.histogram_derivation import derive_lag_histogram


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def row(anchor_day: str, retrieved_at: str, core_hash: str,
        slice_key: str, x: int, y: int, a: int = 0,
        **extra) -> dict:
    r = dict(
        anchor_day=anchor_day,
        retrieved_at=retrieved_at,
        core_hash=core_hash,
        slice_key=slice_key,
        x=x, y=y, a=a,
    )
    r.update(extra)
    return r


H_CHANNEL = 'hash-channel-001'
H_DEVICE = 'hash-device-002'
H_BARE = 'hash-bare-003'

CANDIDATES = [
    CandidateRegime(core_hash=H_CHANNEL),
    CandidateRegime(core_hash=H_DEVICE),
    CandidateRegime(core_hash=H_BARE),
]


# ===================================================================
# RC-001: derive_cohort_maturity with mixed regimes (Pattern A)
# ===================================================================

class TestRC001_CohortMaturityMixedRegimes:
    """Two MECE dimensions both have data for the same retrieval dates.
    Without regime selection, y values are doubled. With regime
    selection, only one regime's rows are used — correct values."""

    ROWS = [
        # Channel regime: x=60+40=100, y=12+8=20
        row('2025-12-01', '2026-01-15T06:00:00Z', H_CHANNEL,
            'context(channel:google).window(2025-12-01:2026-01-15)', x=60, y=12),
        row('2025-12-01', '2026-01-15T06:00:00Z', H_CHANNEL,
            'context(channel:meta).window(2025-12-01:2026-01-15)', x=40, y=8),
        # Device regime: x=55+45=100, y=11+9=20 (same aggregate)
        row('2025-12-01', '2026-01-15T06:00:00Z', H_DEVICE,
            'context(device:mobile).window(2025-12-01:2026-01-15)', x=55, y=11),
        row('2025-12-01', '2026-01-15T06:00:00Z', H_DEVICE,
            'context(device:desktop).window(2025-12-01:2026-01-15)', x=45, y=9),
    ]

    def test_without_regime_selection_y_is_doubled(self):
        """RED TEST: proves the double-counting bug exists in the
        current code path when fed multi-regime rows."""
        result = derive_cohort_maturity(
            self.ROWS,
            sweep_from='2026-01-15',
            sweep_to='2026-01-15',
        )

        frames = result.get('frames', [])
        assert len(frames) == 1
        dp = frames[0].get('data_points', [])
        assert len(dp) == 1

        # BUG: total_y is 40 (12+8+11+9) instead of correct 20
        assert dp[0]['y'] == 40, (
            f"Expected doubled y=40 (proving the bug), got {dp[0]['y']}"
        )

    def test_with_regime_selection_y_is_correct(self):
        """GREEN TEST: after regime selection, only one regime's rows
        reach the derivation function."""
        selected = select_regime_rows(self.ROWS, CANDIDATES)
        result = derive_cohort_maturity(
            selected.rows,
            sweep_from='2026-01-15',
            sweep_to='2026-01-15',
        )

        frames = result.get('frames', [])
        assert len(frames) == 1
        dp = frames[0].get('data_points', [])
        assert len(dp) == 1

        # Correct: y=20 (only channel regime: 12+8)
        assert dp[0]['y'] == 20
        assert dp[0]['x'] == 100



# ===================================================================
# RC-003: select_latest_evidence with mixed regimes (Pattern C)
# ===================================================================

class TestRC003_LatestEvidenceMixedRegimes:
    """Two regimes have rows for the same anchor_day on the SAME
    retrieved_at date. Without regime selection, the latest-per-slice
    aggregation keeps all slices from both regimes and sums them."""

    ROWS = [
        # Channel regime: x=60+40=100, y=12+8=20
        row('2025-12-01', '2026-01-10T06:00:00Z', H_CHANNEL,
            'context(channel:google).window()', x=60, y=12),
        row('2025-12-01', '2026-01-10T06:00:00Z', H_CHANNEL,
            'context(channel:meta).window()', x=40, y=8),
        # Device regime, SAME retrieved_at: x=55+45=100, y=11+9=20
        row('2025-12-01', '2026-01-10T06:00:00Z', H_DEVICE,
            'context(device:mobile).window()', x=55, y=11),
        row('2025-12-01', '2026-01-10T06:00:00Z', H_DEVICE,
            'context(device:desktop).window()', x=45, y=9),
    ]

    def test_without_regime_selection_mixes_regimes(self):
        """RED TEST: select_latest_evidence picks latest per
        (anchor_day, slice_family). Since channel and device have
        different slice_keys, all four rows are kept and summed.
        Result: x=200, y=40 (double-counted)."""
        evidence = select_latest_evidence(self.ROWS)

        assert len(evidence) == 1  # one anchor_day
        e = evidence[0]
        # BUG: x and y are doubled because both regimes' slices are kept
        assert e.x == 200, f"Expected doubled x=200, got {e.x}"
        assert e.y == 40, f"Expected doubled y=40, got {e.y}"

    def test_with_regime_selection_correct(self):
        """GREEN TEST: after regime selection (channel preferred),
        only channel rows remain. Latest per slice is unambiguous."""
        selected = select_regime_rows(self.ROWS, CANDIDATES)
        evidence = select_latest_evidence(selected.rows)

        assert len(evidence) == 1
        e = evidence[0]
        # Correct: only channel regime, x=100, y=20
        assert e.x == 100
        assert e.y == 20


# ===================================================================
# RC-006: select_latest_evidence — weighted averages with mixed regimes
# ===================================================================

class TestRC006_LatestEvidenceWeightedAverages:
    """Two regimes with different median_lag_days values for the same
    anchor_day. Without regime selection, the weighted average mixes
    values from both regimes."""

    ROWS = [
        # Channel regime: median_lag=5.0, x=60+40=100 — same retrieved_at
        row('2025-12-01', '2026-01-10T06:00:00Z', H_CHANNEL,
            'context(channel:google).window()', x=60, y=12,
            median_lag_days=5.0),
        row('2025-12-01', '2026-01-10T06:00:00Z', H_CHANNEL,
            'context(channel:meta).window()', x=40, y=8,
            median_lag_days=5.0),
        # Device regime: median_lag=10.0, x=55+45=100 — SAME retrieved_at
        row('2025-12-01', '2026-01-10T06:00:00Z', H_DEVICE,
            'context(device:mobile).window()', x=55, y=11,
            median_lag_days=10.0),
        row('2025-12-01', '2026-01-10T06:00:00Z', H_DEVICE,
            'context(device:desktop).window()', x=45, y=9,
            median_lag_days=10.0),
    ]

    def test_with_regime_selection_lag_is_single_regime(self):
        """After regime selection (channel preferred), lag values
        come from one regime only."""
        selected = select_regime_rows(self.ROWS, CANDIDATES)
        evidence = select_latest_evidence(selected.rows)

        assert len(evidence) == 1
        e = evidence[0]
        # Only channel regime — median_lag should be 5.0
        assert e.median_lag_days == pytest.approx(5.0, abs=0.1)


# ===================================================================
# RC-004: derive_daily_conversions with mixed regimes (Pattern B)
# ===================================================================

class TestRC004_DailyConversionsMixedRegimes:
    """Two regimes have rows for the same anchor_day on the same
    retrieved_at. Daily conversions computes ΔY between consecutive
    retrieval dates per (anchor_day, slice_key). With mixed regimes,
    all slice_keys are treated as independent series and their
    latest Y values are summed — doubling the rate."""

    ROWS = [
        # Channel regime: latest y per anchor_day = 12+8 = 20
        row('2025-12-01', '2026-01-10T06:00:00Z', H_CHANNEL,
            'context(channel:google).window(2025-12-01:2026-01-10)', x=60, y=12),
        row('2025-12-01', '2026-01-10T06:00:00Z', H_CHANNEL,
            'context(channel:meta).window(2025-12-01:2026-01-10)', x=40, y=8),
        # Device regime, SAME retrieved_at: latest y = 11+9 = 20
        row('2025-12-01', '2026-01-10T06:00:00Z', H_DEVICE,
            'context(device:mobile).window(2025-12-01:2026-01-10)', x=55, y=11),
        row('2025-12-01', '2026-01-10T06:00:00Z', H_DEVICE,
            'context(device:desktop).window(2025-12-01:2026-01-10)', x=45, y=9),
    ]

    def test_without_regime_selection_rate_is_doubled(self):
        """RED TEST: rate_by_cohort sums Y across all 4 slice_keys."""
        result = derive_daily_conversions(self.ROWS)
        cohorts = result.get('rate_by_cohort', [])
        assert len(cohorts) == 1
        c = cohorts[0]
        # BUG: y=40 (12+8+11+9), x=200 (60+40+55+45)
        assert c['y'] == 40
        assert c['x'] == 200

    def test_with_regime_selection_rate_is_correct(self):
        """GREEN TEST: only channel regime rows present."""
        selected = select_regime_rows(self.ROWS, CANDIDATES)
        result = derive_daily_conversions(selected.rows)
        cohorts = result.get('rate_by_cohort', [])
        assert len(cohorts) == 1
        c = cohorts[0]
        assert c['y'] == 20
        assert c['x'] == 100


# ===================================================================
# RC-005: derive_lag_histogram with mixed regimes (Pattern B)
# ===================================================================

class TestRC005_LagHistogramMixedRegimes:
    """Two regimes have rows for the same anchor_day across two
    retrieval dates. The histogram computes ΔY per lag bin. With
    mixed regimes, the histogram double-counts."""

    # Use consistent slice_keys (no date args) so the histogram
    # groups by (anchor_day, slice_key) correctly across retrievals.
    ROWS = [
        # Retrieval 1: channel y=10, device y=10
        row('2025-12-01', '2026-01-06T06:00:00Z', H_CHANNEL,
            'context(channel:google).window()', x=60, y=6),
        row('2025-12-01', '2026-01-06T06:00:00Z', H_CHANNEL,
            'context(channel:meta).window()', x=40, y=4),
        row('2025-12-01', '2026-01-06T06:00:00Z', H_DEVICE,
            'context(device:mobile).window()', x=55, y=6),
        row('2025-12-01', '2026-01-06T06:00:00Z', H_DEVICE,
            'context(device:desktop).window()', x=45, y=4),
        # Retrieval 2: channel y=20, device y=20
        row('2025-12-01', '2026-01-11T06:00:00Z', H_CHANNEL,
            'context(channel:google).window()', x=60, y=12),
        row('2025-12-01', '2026-01-11T06:00:00Z', H_CHANNEL,
            'context(channel:meta).window()', x=40, y=8),
        row('2025-12-01', '2026-01-11T06:00:00Z', H_DEVICE,
            'context(device:mobile).window()', x=55, y=11),
        row('2025-12-01', '2026-01-11T06:00:00Z', H_DEVICE,
            'context(device:desktop).window()', x=45, y=9),
    ]

    def test_without_regime_selection_histogram_is_doubled(self):
        """RED TEST: total_conversions should be doubled with mixed regimes."""
        result = derive_lag_histogram(self.ROWS)
        total = result.get('total_conversions', 0)
        # With both regimes: 4 series each accumulating to their final Y.
        # google=12, meta=8, mobile=11, desktop=9 → total=40
        # Correct (single regime) would be 20
        assert total == 40, f"Expected doubled total=40, got {total}"

    def test_with_regime_selection_histogram_is_correct(self):
        """GREEN TEST: only channel regime — total = 20."""
        selected = select_regime_rows(self.ROWS, CANDIDATES)
        result = derive_lag_histogram(selected.rows)
        total = result.get('total_conversions', 0)
        assert total == 20
