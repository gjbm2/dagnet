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
        assert frame["snapshot_date"] == "2025-10-15"
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
        dates = [f["snapshot_date"] for f in result["frames"]]
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
        assert frame1["snapshot_date"] == "2025-10-15"
        assert len(frame1["data_points"]) == 2
        assert frame1["total_y"] == 35  # 20 + 15

        # Second frame (as_at 10-20): both cohorts, higher Y
        frame2 = result["frames"][1]
        assert frame2["snapshot_date"] == "2025-10-20"
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
        assert frame_15["snapshot_date"] == "2025-10-15"
        assert frame_15["data_points"][0]["y"] == 12

        # Frame at 10-20: should see latest overall (y=30)
        frame_20 = result["frames"][1]
        assert frame_20["snapshot_date"] == "2025-10-20"
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

    def test_mece_partition_matches_single_slice_aggregate(self):
        """
        BE CF MECE parity (per 73b §6.5 / FETCH_PLANNING_PRINCIPLES §6.2).

        Spec invariant being pinned:

          When the user issues an uncontexted query and snapshot rows
          arrive as a MECE partition across one context dimension (one
          row per context value), the frames produced by
          `derive_cohort_maturity` MUST be equivalent to the frames
          produced from a single uncontexted row carrying the summed
          totals (X, Y) and the matching lag moments. Equivalence here
          means: same number of frames, same snapshot_dates, same
          number of data_points per frame, same set of fields per
          data_point, same value on every field.

          This is what allows downstream
          `build_cohort_evidence_from_frames` (and the v3 forecast
          chain) to produce identical output regardless of whether
          evidence was admitted as a MECE partition or as a single
          uncontexted slice. Without this parity, the user-visible
          forecast diverges between equivalent evidence shapes.

        `test_slices_summed` asserts absolute totals on a single MECE
        case. This test asserts byte-level parity vs the reference
        single-slice equivalent, written from the spec invariant rather
        than from the implementation's emitted shape.
        """
        # Two retrieval dates exercising per-frame aggregation across
        # both time (multiple snapshot dates) and context (MECE union).
        # Lag moments are constant per slice — the spec parity must
        # hold regardless of how the moments are rolled up across
        # MECE families, so making them constant here keeps the parity
        # assertion exact (no mixture-quantile noise to bias the test).
        median_lag = 2.0
        mean_lag = 3.0

        # `a` (anchor population) is also a sum-aggregated field across
        # MECE: each context value contributes its share of the anchor
        # population. The single-slice reference must carry the SUM
        # (a=2000) for true parity. Per-MECE-row a=1000 (helper default).
        mece_rows = [
            # 2025-10-15: google y=10 x=50 a=1000, facebook y=8 x=40 a=1000
            #             → totals y=18 x=90 a=2000
            _row("2025-10-01", "2025-10-15T12:00:00+00:00", y=10, x=50, a=1000,
                 slice_key="context(channel:google)",
                 median_lag_days=median_lag, mean_lag_days=mean_lag),
            _row("2025-10-01", "2025-10-15T12:00:00+00:00", y=8, x=40, a=1000,
                 slice_key="context(channel:facebook)",
                 median_lag_days=median_lag, mean_lag_days=mean_lag),
            # 2025-10-16: google y=15 x=60 a=1000, facebook y=12 x=50 a=1000
            #             → totals y=27 x=110 a=2000
            _row("2025-10-01", "2025-10-16T12:00:00+00:00", y=15, x=60, a=1000,
                 slice_key="context(channel:google)",
                 median_lag_days=median_lag, mean_lag_days=mean_lag),
            _row("2025-10-01", "2025-10-16T12:00:00+00:00", y=12, x=50, a=1000,
                 slice_key="context(channel:facebook)",
                 median_lag_days=median_lag, mean_lag_days=mean_lag),
        ]

        # Reference: same MECE-summed totals as a single uncontexted slice.
        single_rows = [
            _row("2025-10-01", "2025-10-15T12:00:00+00:00", y=18, x=90, a=2000,
                 slice_key="",
                 median_lag_days=median_lag, mean_lag_days=mean_lag),
            _row("2025-10-01", "2025-10-16T12:00:00+00:00", y=27, x=110, a=2000,
                 slice_key="",
                 median_lag_days=median_lag, mean_lag_days=mean_lag),
        ]

        mece_result = derive_cohort_maturity(mece_rows)
        single_result = derive_cohort_maturity(single_rows)

        # Same number of frames, same snapshot dates, same order.
        assert len(mece_result["frames"]) == len(single_result["frames"]), (
            f"frame count differs: MECE={len(mece_result['frames'])} single={len(single_result['frames'])}"
        )
        mece_dates = [f["snapshot_date"] for f in mece_result["frames"]]
        single_dates = [f["snapshot_date"] for f in single_result["frames"]]
        assert mece_dates == single_dates

        # Per-frame: same number of data_points, same key set, same
        # values on every key. Strict byte-level parity per spec.
        # Floats compared with tight tolerance; everything else with ==.
        for mf, sf in zip(mece_result["frames"], single_result["frames"]):
            label = mf["snapshot_date"]
            assert len(mf["data_points"]) == len(sf["data_points"]), (
                f"frame {label}: data_points count differs "
                f"(MECE={len(mf['data_points'])} single={len(sf['data_points'])})"
            )
            for mdp, sdp in zip(mf["data_points"], sf["data_points"]):
                m_keys = set(mdp.keys())
                s_keys = set(sdp.keys())
                assert m_keys == s_keys, (
                    f"frame {label} data_point key sets differ: "
                    f"MECE-only={m_keys - s_keys} single-only={s_keys - m_keys}"
                )
                for key in m_keys:
                    mv = mdp[key]
                    sv = sdp[key]
                    if isinstance(mv, float) or isinstance(sv, float):
                        # None vs number is a divergence — assert numericness explicitly.
                        assert mv is not None and sv is not None, (
                            f"frame {label} data_point.{key}: nullness differs (MECE={mv} single={sv})"
                        )
                        assert mv == pytest.approx(sv, rel=1e-9, abs=1e-9), (
                            f"frame {label} data_point.{key}: MECE={mv} single={sv}"
                        )
                    else:
                        assert mv == sv, (
                            f"frame {label} data_point.{key}: MECE={mv!r} single={sv!r}"
                        )

    def test_temporal_arg_variants_do_not_double_count(self):
        """
        Different stored slice_key strings can represent the same logical slice family
        when they only differ in the arguments to cohort()/window().

        Cohort maturity must apply "latest wins" across the *normalised* slice family,
        otherwise it will accidentally sum variants and create non-sensical drops/rises.
        """
        rows = [
            # Same anchor_day, same logical cohort() slice family, but stored under two
            # different cohort(...) argument variants across retrieval days.
            _row("2025-10-01", "2025-10-10T12:00:00+00:00", y=10, x=100, slice_key="cohort(1-Oct-25:5-Oct-25)"),
            _row("2025-10-01", "2025-10-11T12:00:00+00:00", y=20, x=100, slice_key="cohort(-120d:)"),
        ]

        result = derive_cohort_maturity(rows)
        assert [f["snapshot_date"] for f in result["frames"]] == ["2025-10-10", "2025-10-11"]

        # Day 1: only the first retrieval exists.
        dp_10 = result["frames"][0]["data_points"][0]
        assert dp_10["x"] == 100
        assert dp_10["y"] == 10
        assert dp_10["rate"] == pytest.approx(0.10)

        # Day 2: latest wins across the logical cohort() family; must NOT sum both variants.
        dp_11 = result["frames"][1]["data_points"][0]
        assert dp_11["x"] == 100
        assert dp_11["y"] == 20
        assert dp_11["rate"] == pytest.approx(0.20)


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

    def test_single_retrieval_with_sweep_grid(self):
        """With an explicit sweep range and a single retrieval, empty frames are
        generated for days before the retrieval (no data existed yet).  The
        frontend normalisation skips these.  This test documents the expected
        derivation output shape."""
        rows = [
            _row("2025-10-01", "2025-10-04T12:00:00+00:00", y=42, x=100),
        ]
        result = derive_cohort_maturity(rows, sweep_from="2025-10-01", sweep_to="2025-10-05")

        # 5 days: Oct 1–5
        assert len(result["frames"]) == 5

        # Days before retrieval (Oct 1–3): empty data_points
        for f in result["frames"][:3]:
            assert f["data_points"] == []
            assert f["total_y"] == 0

        # Days from retrieval onward (Oct 4–5): carry-forward data
        for f in result["frames"][3:]:
            assert len(f["data_points"]) == 1
            assert f["data_points"][0]["y"] == 42
            assert f["data_points"][0]["rate"] == pytest.approx(0.42)

    def test_empty_rows_with_sweep_grid_emits_empty_frames(self):
        """Even when there are no rows, an explicit sweep range must yield a full grid."""
        result = derive_cohort_maturity([], sweep_from="2025-10-01", sweep_to="2025-10-05")
        assert len(result["frames"]) == 5
        for f in result["frames"]:
            assert isinstance(f.get("snapshot_date"), str)
            assert f.get("data_points") == []
            assert f.get("total_y") == 0
