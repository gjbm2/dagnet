"""
Tests for cohort_maturity_derivation.

Tests the virtual-snapshot-at-each-retrieval-date algorithm using synthetic
snapshot rows (no DB required).
"""
import pytest
from datetime import date, datetime
from runner.cohort_maturity_derivation import derive_cohort_maturity


def _row(anchor_day: str, retrieved_at: str, y: int, x: int = 100, a: int = 1000,
         slice_key: str = "", median_lag_days=None, mean_lag_days=None):
    """Helper: build a snapshot row dict."""
    return {
        "param_id": "test-param",
        "core_hash": "testhash",
        "slice_key": slice_key,
        "anchor_day": anchor_day,
        "retrieved_at": retrieved_at,
        "a": a,
        "x": x,
        "y": y,
        "median_lag_days": median_lag_days,
        "mean_lag_days": mean_lag_days,
        "onset_delta_days": None,
    }


class TestEmpty:
    def test_empty_rows(self):
        result = derive_cohort_maturity([])
        assert result["analysis_type"] == "cohort_maturity"
        assert result["frames"] == []
        assert result["cohorts_analysed"] == 0


class TestSingleCohortSingleRetrieval:
    """One anchor_day, one retrieval → one frame with one data point."""

    def test_single_frame(self):
        rows = [
            _row("2025-10-01", "2025-10-15T12:00:00+00:00", y=42, x=100),
        ]
        result = derive_cohort_maturity(rows)

        assert len(result["frames"]) == 1
        frame = result["frames"][0]
        assert frame["as_at_date"] == "2025-10-15"
        assert len(frame["data_points"]) == 1

        dp = frame["data_points"][0]
        assert dp["anchor_day"] == "2025-10-01"
        assert dp["y"] == 42
        assert dp["x"] == 100
        assert dp["rate"] == pytest.approx(0.42)


class TestSingleCohortMultipleRetrievals:
    """One anchor_day, multiple retrievals → multiple frames showing Y accumulating."""

    def test_maturity_curve(self):
        rows = [
            _row("2025-10-01", "2025-10-10T12:00:00+00:00", y=10, x=100),
            _row("2025-10-01", "2025-10-20T12:00:00+00:00", y=30, x=100),
            _row("2025-10-01", "2025-10-30T12:00:00+00:00", y=45, x=100),
        ]
        result = derive_cohort_maturity(rows)

        assert len(result["frames"]) == 3
        ys = [f["data_points"][0]["y"] for f in result["frames"]]
        assert ys == [10, 30, 45]

        rates = [f["data_points"][0]["rate"] for f in result["frames"]]
        assert rates == [pytest.approx(0.10), pytest.approx(0.30), pytest.approx(0.45)]

    def test_frames_chronological(self):
        rows = [
            _row("2025-10-01", "2025-10-30T12:00:00+00:00", y=45, x=100),
            _row("2025-10-01", "2025-10-10T12:00:00+00:00", y=10, x=100),
        ]
        result = derive_cohort_maturity(rows)
        dates = [f["as_at_date"] for f in result["frames"]]
        assert dates == ["2025-10-10", "2025-10-30"]


class TestMultipleCohorts:
    """Multiple anchor_days, same retrieval schedule."""

    def test_multiple_anchor_days_in_frame(self):
        rows = [
            _row("2025-10-01", "2025-10-15T12:00:00+00:00", y=20, x=100),
            _row("2025-10-02", "2025-10-15T12:00:00+00:00", y=15, x=100),
            _row("2025-10-01", "2025-10-20T12:00:00+00:00", y=40, x=100),
            _row("2025-10-02", "2025-10-20T12:00:00+00:00", y=30, x=100),
        ]
        result = derive_cohort_maturity(rows)

        assert len(result["frames"]) == 2
        assert result["cohorts_analysed"] == 2

        # First frame (as_at 10-15): both cohorts
        frame1 = result["frames"][0]
        assert frame1["as_at_date"] == "2025-10-15"
        assert len(frame1["data_points"]) == 2
        assert frame1["total_y"] == 35  # 20 + 15

        # Second frame (as_at 10-20): both cohorts, higher Y
        frame2 = result["frames"][1]
        assert frame2["as_at_date"] == "2025-10-20"
        assert frame2["total_y"] == 70  # 40 + 30


class TestVirtualSnapshotLogic:
    """Verifies that each frame shows the LATEST row as-of that retrieval date."""

    def test_latest_row_per_anchor_as_of_cutoff(self):
        """Two retrievals on 10-15 and 10-20. Frame at 10-15 should only
        see the 10-15 retrieval, not the 10-20 one."""
        rows = [
            _row("2025-10-01", "2025-10-15T08:00:00+00:00", y=10, x=100),
            _row("2025-10-01", "2025-10-15T16:00:00+00:00", y=12, x=100),
            _row("2025-10-01", "2025-10-20T10:00:00+00:00", y=30, x=100),
        ]
        result = derive_cohort_maturity(rows)

        assert len(result["frames"]) == 2

        # Frame at 10-15: should see latest 10-15 retrieval (y=12)
        frame_15 = result["frames"][0]
        assert frame_15["as_at_date"] == "2025-10-15"
        assert frame_15["data_points"][0]["y"] == 12

        # Frame at 10-20: should see latest overall (y=30)
        frame_20 = result["frames"][1]
        assert frame_20["as_at_date"] == "2025-10-20"
        assert frame_20["data_points"][0]["y"] == 30


class TestSliceAggregation:
    """Multiple slice_keys should be aggregated (summed) per anchor_day in each frame."""

    def test_slices_summed(self):
        rows = [
            _row("2025-10-01", "2025-10-15T12:00:00+00:00", y=10, x=50, slice_key="context(channel:google)"),
            _row("2025-10-01", "2025-10-15T12:00:00+00:00", y=8, x=40, slice_key="context(channel:facebook)"),
        ]
        result = derive_cohort_maturity(rows)

        assert len(result["frames"]) == 1
        dp = result["frames"][0]["data_points"][0]
        assert dp["y"] == 18  # 10 + 8
        assert dp["x"] == 90  # 50 + 40
        assert dp["rate"] == pytest.approx(18 / 90, rel=1e-4)


class TestAnchorRange:
    def test_anchor_range_in_result(self):
        rows = [
            _row("2025-10-01", "2025-10-15T12:00:00+00:00", y=10, x=100),
            _row("2025-10-05", "2025-10-15T12:00:00+00:00", y=5, x=100),
        ]
        result = derive_cohort_maturity(rows)
        assert result["anchor_range"]["from"] == "2025-10-01"
        assert result["anchor_range"]["to"] == "2025-10-05"


class TestSweepRange:
    def test_sweep_range_from_args(self):
        rows = [
            _row("2025-10-01", "2025-10-15T12:00:00+00:00", y=10, x=100),
        ]
        result = derive_cohort_maturity(rows, sweep_from="2025-10-01", sweep_to="2025-11-01")
        assert result["sweep_range"]["from"] == "2025-10-01"
        assert result["sweep_range"]["to"] == "2025-11-01"

    def test_sweep_range_defaults_to_data_bounds(self):
        rows = [
            _row("2025-10-01", "2025-10-15T12:00:00+00:00", y=10, x=100),
            _row("2025-10-01", "2025-10-25T12:00:00+00:00", y=20, x=100),
        ]
        result = derive_cohort_maturity(rows)
        assert result["sweep_range"]["from"] == "2025-10-15"
        assert result["sweep_range"]["to"] == "2025-10-25"
