"""
Adversarial blind tests for evidence binding (snapshot rows → EdgeEvidence).

Written from the CONTRACT (field semantics docs, type signatures) without
reading the implementation. Goal: catch real defects in MECE aggregation,
trajectory monotonisation, regime partitioning, and completeness computation.

Run with:
    cd graph-editor && . venv/bin/activate
    pytest ../bayes/tests/test_evidence_binding_adversarial.py -v
"""

import os
import sys
import math
import pytest
from datetime import datetime, timedelta
from dataclasses import dataclass, field

# Ensure bayes/ is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../graph-editor/lib'))

from bayes.compiler.types import (
    TopologyAnalysis,
    EdgeTopology,
    PathLatency,
    BoundEvidence,
    EdgeEvidence,
    CohortDailyTrajectory,
    CohortDailyObs,
    CohortObservation,
    ProbabilityPrior,
    LatencyPrior,
    WindowObservation,
    MIN_N_THRESHOLD,
)
from bayes.compiler.evidence import (
    bind_snapshot_evidence,
    _bind_from_snapshot_rows,
    _build_trajectories_for_obs_type,
)


# ── Fixtures ──────────────────────────────────────────────────

def make_edge_topology(
    edge_id: str = "edge-1",
    param_id: str = "test-param-1",
    has_latency: bool = True,
    onset_delta_days: float = 2.0,
    mu_prior: float = 2.0,
    sigma_prior: float = 0.5,
    t95_days: float = 30.0,
) -> EdgeTopology:
    """Create a minimal EdgeTopology for testing."""
    return EdgeTopology(
        edge_id=edge_id,
        from_node="node-a",
        to_node="node-b",
        param_id=param_id,
        is_solo=True,
        has_latency=has_latency,
        onset_delta_days=onset_delta_days,
        mu_prior=mu_prior,
        sigma_prior=sigma_prior,
        t95_days=t95_days,
        path_edge_ids=[edge_id],
        path_latency=PathLatency(
            path_delta=onset_delta_days,
            path_mu=mu_prior,
            path_sigma=sigma_prior,
        ),
        path_alternatives=[],
    )


def make_topology(edges: list[EdgeTopology] = None) -> TopologyAnalysis:
    """Create a minimal TopologyAnalysis."""
    if edges is None:
        edges = [make_edge_topology()]
    return TopologyAnalysis(
        edges={e.edge_id: e for e in edges},
        branch_groups=[],
        paths=[],
    )


def make_edge_evidence(edge_id: str = "edge-1", param_id: str = "test-param-1") -> EdgeEvidence:
    """Create an empty EdgeEvidence for direct _bind_from_snapshot_rows testing."""
    return EdgeEvidence(
        edge_id=edge_id,
        param_id=param_id,
        file_path=f"parameters/{param_id}.yaml",
        prob_prior=ProbabilityPrior(alpha=1.0, beta=1.0, source="uninformative"),
        latency_prior=LatencyPrior(
            onset_delta_days=2.0, mu=2.0, sigma=0.5, onset_uncertainty=1.0,
        ),
    )


def snapshot_row(
    anchor_day: str,
    retrieved_at: str,
    x: int = 100,
    y: int = 50,
    a: int = 0,
    slice_key: str = "window(-90d:)",
    core_hash: str = "hash-1",
    median_lag_days: float = None,
    mean_lag_days: float = None,
    onset_delta_days: float = None,
    anchor_median_lag_days: float = None,
    anchor_mean_lag_days: float = None,
) -> dict:
    """Build a synthetic snapshot DB row."""
    r = {
        "anchor_day": anchor_day,
        "retrieved_at": retrieved_at,
        "x": x, "y": y, "a": a,
        "slice_key": slice_key,
        "core_hash": core_hash,
    }
    if median_lag_days is not None:
        r["median_lag_days"] = median_lag_days
    if mean_lag_days is not None:
        r["mean_lag_days"] = mean_lag_days
    if onset_delta_days is not None:
        r["onset_delta_days"] = onset_delta_days
    if anchor_median_lag_days is not None:
        r["anchor_median_lag_days"] = anchor_median_lag_days
    if anchor_mean_lag_days is not None:
        r["anchor_mean_lag_days"] = anchor_mean_lag_days
    return r


TODAY = datetime(2025, 6, 1)


# ═══════════════════════════════════════════════════════════════
# Suite A: MECE aggregation edge cases
# ══════════════════════════════════════���════════════════════════

class TestMeceAggregationAdversarial:
    """MECE context rows should be summed; non-MECE should be skipped."""

    def test_mece_context_rows_summed_correctly(self):
        """Three MECE context rows for same (anchor, retrieval).
        Their x and y should be summed into one aggregate row.
        """
        ev = make_edge_evidence()
        et = make_edge_topology()
        rows = [
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=60, y=30, slice_key="context(channel:google).window(-90d:)"),
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=25, y=12, slice_key="context(channel:meta).window(-90d:)"),
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=15, y=8, slice_key="context(channel:organic).window(-90d:)"),
        ]
        diag = []
        covered = _bind_from_snapshot_rows(
            ev, et, rows, TODAY, diag,
            mece_dimensions=["channel"],
        )

        # Aggregate should have x=100, y=50
        assert ev.total_n > 0, "No observations created"
        # Check the AGGREGATE trajectory/daily obs has the summed denominator.
        # Per-context obs will have smaller n (60, 25, 15) — that's expected.
        agg_obs = [o for o in ev.cohort_obs
                   if "window" in o.slice_dsl and "context" not in o.slice_dsl]
        assert len(agg_obs) > 0, "No aggregate window observation found"
        for obs in agg_obs:
            for t in obs.trajectories:
                assert t.n == 100, f"Expected summed n=100 in aggregate, got {t.n}"
            for d in obs.daily:
                assert d.n == 100, f"Expected summed n=100 in aggregate, got {d.n}"

    def test_bare_aggregate_takes_precedence_over_context(self):
        """If a bare aggregate row exists, context rows for same retrieval
        should be dropped (not summed).
        """
        ev = make_edge_evidence()
        et = make_edge_topology()
        rows = [
            # Bare aggregate (no context)
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=100, y=50, slice_key="window(-90d:)"),
            # Context rows (should be dropped because bare exists)
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=60, y=30, slice_key="context(channel:google).window(-90d:)"),
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=40, y=20, slice_key="context(channel:meta).window(-90d:)"),
        ]
        diag = []
        covered = _bind_from_snapshot_rows(
            ev, et, rows, TODAY, diag,
            mece_dimensions=["channel"],
        )

        # Aggregate should use the bare row (x=100), not sum bare+context (x=200)
        for obs in ev.cohort_obs:
            if "window" in obs.slice_dsl and "context" not in obs.slice_dsl:
                for t in obs.trajectories:
                    assert t.n == 100, f"Expected bare n=100, got {t.n} — context rows not dropped?"
                for d in obs.daily:
                    assert d.n == 100, f"Expected bare n=100, got {d.n}"

    def test_non_mece_dimension_rows_skipped(self):
        """Rows from a dimension NOT in mece_dimensions should be skipped
        from aggregation (cannot sum overlapping slices).
        """
        ev = make_edge_evidence()
        et = make_edge_topology()
        rows = [
            # channel is MECE
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=60, y=30, slice_key="context(channel:google).window(-90d:)"),
            # visited is NOT MECE (overlapping)
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=80, y=40, slice_key="context(visited:cart).window(-90d:)"),
        ]
        diag = []
        covered = _bind_from_snapshot_rows(
            ev, et, rows, TODAY, diag,
            mece_dimensions=["channel"],  # only channel is MECE
        )

        # Only channel row should contribute to aggregate (x=60)
        # visited row should be skipped
        for obs in ev.cohort_obs:
            if "window" in obs.slice_dsl and "context" not in obs.slice_dsl:
                for t in obs.trajectories:
                    assert t.n == 60, f"Expected n=60 (channel only), got {t.n}"
                for d in obs.daily:
                    assert d.n == 60, f"Expected n=60 (channel only), got {d.n}"

    def test_bare_row_replaces_context_aggregation(self):
        """Context rows arrive first, then bare aggregate arrives.
        The bare should REPLACE the context-aggregated value.
        """
        ev = make_edge_evidence()
        et = make_edge_topology()
        # Order matters: context rows first, bare second
        rows = [
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=60, y=30, slice_key="context(channel:google).window(-90d:)"),
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=40, y=20, slice_key="context(channel:meta).window(-90d:)"),
            # Bare arrives AFTER context — should replace the 60+40=100 aggregate
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=95, y=48, slice_key="window(-90d:)"),
        ]
        diag = []
        covered = _bind_from_snapshot_rows(
            ev, et, rows, TODAY, diag,
            mece_dimensions=["channel"],
        )

        # Final aggregate should use bare (x=95), not context sum (x=100)
        for obs in ev.cohort_obs:
            if "window" in obs.slice_dsl and "context" not in obs.slice_dsl:
                for t in obs.trajectories:
                    assert t.n == 95, f"Expected bare n=95, got {t.n}"
                for d in obs.daily:
                    assert d.n == 95, f"Expected bare n=95, got {d.n}"


# ═══════════════════════════════════════════════════════════════
# Suite B: Trajectory monotonisation
# ═════════════════════════════════════════════════���═════════════

class TestTrajectoryMonotonisationAdversarial:
    """Trajectories must be monotonically non-decreasing in y."""

    def test_non_monotonic_y_corrected(self):
        """y drops between retrievals (data revision). Should be monotonised."""
        ev = make_edge_evidence()
        et = make_edge_topology()
        rows = [
            snapshot_row("2025-01-01", "2025-02-01T12:00:00Z", x=100, y=30),
            snapshot_row("2025-01-01", "2025-03-01T12:00:00Z", x=100, y=25),  # DROP
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z", x=100, y=40),
        ]
        diag = []
        _bind_from_snapshot_rows(ev, et, rows, TODAY, diag)

        for obs in ev.cohort_obs:
            for t in obs.trajectories:
                # Check monotonicity
                for i in range(1, len(t.cumulative_y)):
                    assert t.cumulative_y[i] >= t.cumulative_y[i - 1], (
                        f"Non-monotonic y at index {i}: "
                        f"{t.cumulative_y[i]} < {t.cumulative_y[i - 1]}. "
                        f"Full sequence: {t.cumulative_y}"
                    )

    def test_y_capped_at_denominator(self):
        """y > x (denominator). y should be capped at denom."""
        ev = make_edge_evidence()
        et = make_edge_topology()
        rows = [
            snapshot_row("2025-01-01", "2025-02-01T12:00:00Z", x=100, y=50),
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z", x=100, y=120),  # EXCEEDS denom
        ]
        diag = []
        _bind_from_snapshot_rows(ev, et, rows, TODAY, diag)

        for obs in ev.cohort_obs:
            for t in obs.trajectories:
                for y_val in t.cumulative_y:
                    assert y_val <= t.n, (
                        f"y={y_val} exceeds denom={t.n}. Should be capped."
                    )

    def test_zero_denominator_day_skipped(self):
        """If all x values for an anchor_day are 0, that day should be skipped."""
        ev = make_edge_evidence()
        et = make_edge_topology()
        rows = [
            snapshot_row("2025-01-01", "2025-02-01T12:00:00Z", x=0, y=0),
            snapshot_row("2025-01-01", "2025-03-01T12:00:00Z", x=0, y=0),
        ]
        diag = []
        _bind_from_snapshot_rows(ev, et, rows, TODAY, diag)

        # No observations should be created (denom=0 → skip)
        assert ev.total_n == 0

    def test_retrieval_before_anchor_skipped(self):
        """Retrieval date before anchor date → age < 0 → skip."""
        ev = make_edge_evidence()
        et = make_edge_topology()
        rows = [
            # retrieved_at (2025-01-01) BEFORE anchor_day (2025-06-01)
            snapshot_row("2025-06-01", "2025-01-01T12:00:00Z", x=100, y=50),
        ]
        diag = []
        _bind_from_snapshot_rows(ev, et, rows, TODAY, diag)

        # Negative age → should be skipped or produce age=0
        # Either way, observation should not have negative age
        for obs in ev.cohort_obs:
            for t in obs.trajectories:
                for age in t.retrieval_ages:
                    assert age > 0, f"Negative/zero age in trajectory: {age}"
            for d in obs.daily:
                assert d.age_days >= 0, f"Negative age in daily: {d.age_days}"


# ═══════════════════════════════════════════════════════════════
# Suite C: Regime per-date partitioning (§5.7)
# ════════════���══════════════════════════════════════════════════

class TestRegimePartitioningAdversarial:
    """When regime_per_date says 'mece_partition', aggregate rows for
    that date should be removed (data lives in per-context rows instead).
    """

    def test_mece_partition_removes_aggregate(self):
        """On a mece_partition date, aggregate rows should be deleted.
        Per-context rows carry the data for that date.
        """
        ev = make_edge_evidence()
        et = make_edge_topology()
        rows = [
            # Aggregate row (should be removed for this date)
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=100, y=50, slice_key="window(-90d:)"),
            # Per-context rows (should survive)
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=60, y=30, slice_key="context(channel:google).window(-90d:)"),
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=40, y=20, slice_key="context(channel:meta).window(-90d:)"),
        ]
        diag = []
        commissioned = {"context(channel:google)", "context(channel:meta)"}
        regime_per_date = {"2025-04-01": "mece_partition"}
        _bind_from_snapshot_rows(
            ev, et, rows, TODAY, diag,
            commissioned=commissioned,
            mece_dimensions=["channel"],
            regime_per_date=regime_per_date,
        )

        # The aggregate should not include the bare row (it was removed)
        # Only per-context obs should exist
        agg_obs = [o for o in ev.cohort_obs if "context" not in o.slice_dsl]
        ctx_obs = [o for o in ev.cohort_obs if "context" in o.slice_dsl]

        # Aggregate should be empty (bare row removed, context rows not aggregated)
        agg_n = sum(
            sum(t.n for t in o.trajectories) + sum(d.n for d in o.daily)
            for o in agg_obs
        )
        # Per-context obs should have data
        ctx_n = sum(
            sum(t.n for t in o.trajectories) + sum(d.n for d in o.daily)
            for o in ctx_obs
        )

        assert ctx_n > 0, "Per-context observations should have data"
        # The key invariant: aggregate should not double-count
        # If aggregate has data AND context has data, that's double-counting
        if agg_n > 0 and ctx_n > 0:
            pytest.fail(
                f"Double-counting! Aggregate has n={agg_n} and context has n={ctx_n}. "
                f"On mece_partition dates, aggregate should be empty."
            )

    def test_uncontexted_date_keeps_aggregate(self):
        """On an 'uncontexted' date, aggregate rows should be kept."""
        ev = make_edge_evidence()
        et = make_edge_topology()
        rows = [
            # Only aggregate row on this date
            snapshot_row("2025-01-01", "2025-02-01T12:00:00Z",
                         x=100, y=50, slice_key="window(-90d:)"),
            # This date has context data
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=100, y=50, slice_key="window(-90d:)"),
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=60, y=30, slice_key="context(channel:google).window(-90d:)"),
        ]
        diag = []
        regime_per_date = {
            "2025-02-01": "uncontexted",    # keep aggregate
            "2025-04-01": "mece_partition",  # remove aggregate
        }
        _bind_from_snapshot_rows(
            ev, et, rows, TODAY, diag,
            commissioned={"context(channel:google)"},
            mece_dimensions=["channel"],
            regime_per_date=regime_per_date,
        )

        # Should have some aggregate data (from 2025-02-01)
        assert ev.total_n > 0


# ══════════════════════���════════════════════════════���═══════════
# Suite D: Null/missing field handling
# ═══════════════════════════════════════════════════════════════

class TestNullFieldHandlingAdversarial:
    """Real snapshot rows can have None values in numeric fields."""

    def test_null_x_skips_day(self):
        """x=None (from-step count missing). Day should be skipped."""
        ev = make_edge_evidence()
        et = make_edge_topology()
        rows = [
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z", x=None, y=50),
        ]
        # Patch x to None (snapshot_row defaults to int)
        rows[0]["x"] = None
        diag = []
        _bind_from_snapshot_rows(ev, et, rows, TODAY, diag)

        assert ev.total_n == 0, "Day with x=None should be skipped"

    def test_null_y_treated_as_zero(self):
        """y=None (conversions missing). Should be treated as y=0."""
        ev = make_edge_evidence()
        et = make_edge_topology()
        rows = [
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z", x=100, y=None),
        ]
        rows[0]["y"] = None
        diag = []
        _bind_from_snapshot_rows(ev, et, rows, TODAY, diag)

        # Should create an observation with k=0 (no conversions)
        for obs in ev.cohort_obs:
            for d in obs.daily:
                assert d.k == 0, f"y=None should produce k=0, got {d.k}"

    def test_null_onset_delta_not_collected(self):
        """onset_delta_days=None. Should not appear in onset_observations."""
        ev = make_edge_evidence()
        et = make_edge_topology()
        rows = [
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=100, y=50, onset_delta_days=None),
        ]
        diag = []
        _bind_from_snapshot_rows(ev, et, rows, TODAY, diag)

        if ev.latency_prior and ev.latency_prior.onset_observations:
            assert len(ev.latency_prior.onset_observations) == 0, (
                "None onset_delta_days should not be collected"
            )

    def test_missing_retrieved_at_field(self):
        """Row with no retrieved_at key at all. Should not crash."""
        ev = make_edge_evidence()
        et = make_edge_topology()
        rows = [{"anchor_day": "2025-01-01", "x": 100, "y": 50,
                 "slice_key": "window(-90d:)", "core_hash": "hash-1"}]
        diag = []
        # Should not raise KeyError
        _bind_from_snapshot_rows(ev, et, rows, TODAY, diag)

    def test_missing_slice_key_field(self):
        """Row with no slice_key key. Should not crash."""
        ev = make_edge_evidence()
        et = make_edge_topology()
        rows = [{"anchor_day": "2025-01-01", "retrieved_at": "2025-04-01T12:00:00Z",
                 "x": 100, "y": 50, "core_hash": "hash-1"}]
        diag = []
        _bind_from_snapshot_rows(ev, et, rows, TODAY, diag)
        # Row without window/cohort in slice_key should be skipped
        assert ev.total_n == 0


# ═══════════════════════════════════════════════════════════════
# Suite E: Zero-count filter edge cases
# ═══════════════════════════════════════════════════════════════

class TestZeroCountFilterAdversarial:
    """The zero-count filter merges consecutive zero-change intervals.
    This can collapse trajectories to single points.
    """

    def test_all_same_y_collapses_to_daily(self):
        """All retrievals have y=50 (fully mature). Zero-count filter should
        collapse the trajectory. Should NOT crash — should fall back to daily obs.
        """
        ev = make_edge_evidence()
        et = make_edge_topology()
        rows = [
            snapshot_row("2025-01-01", "2025-02-01T12:00:00Z", x=100, y=50),
            snapshot_row("2025-01-01", "2025-03-01T12:00:00Z", x=100, y=50),
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z", x=100, y=50),
        ]
        diag = []
        _bind_from_snapshot_rows(ev, et, rows, TODAY, diag)

        # Should have SOME observation (either trajectory or daily fallback)
        assert ev.total_n > 0, "Collapsed trajectory should produce at least a daily obs"

    def test_single_y_change_preserves_two_points(self):
        """y changes once: 0→50→50→50. Filter should keep the point
        before the change and the change itself (minimum 2 points).
        """
        ev = make_edge_evidence()
        et = make_edge_topology()
        rows = [
            snapshot_row("2025-01-01", "2025-02-01T12:00:00Z", x=100, y=0),
            snapshot_row("2025-01-01", "2025-03-01T12:00:00Z", x=100, y=50),
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z", x=100, y=50),
            snapshot_row("2025-01-01", "2025-05-01T12:00:00Z", x=100, y=50),
        ]
        diag = []
        _bind_from_snapshot_rows(ev, et, rows, TODAY, diag)

        for obs in ev.cohort_obs:
            for t in obs.trajectories:
                # Should have ≥ 2 points (the change boundary)
                assert len(t.retrieval_ages) >= 2, (
                    f"Expected ≥2 trajectory points, got {len(t.retrieval_ages)}"
                )


# ═══════════════════════════════════════════════════════════════
# Suite F: Window vs Cohort classification
# ═══════════════════════════════════════════════════════════════

class TestWindowCohortClassificationAdversarial:
    """Rows must be correctly classified as window or cohort based on slice_key."""

    def test_window_slice_key(self):
        """Rows with 'window(' in slice_key → window observations."""
        ev = make_edge_evidence()
        et = make_edge_topology()
        rows = [
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=100, y=50, slice_key="window(-90d:)"),
        ]
        diag = []
        _bind_from_snapshot_rows(ev, et, rows, TODAY, diag)
        assert ev.has_window is True

    def test_cohort_slice_key(self):
        """Rows with 'cohort(' in slice_key → cohort observations."""
        ev = make_edge_evidence()
        et = make_edge_topology()
        rows = [
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=100, y=50, slice_key="cohort(-90d:)"),
        ]
        diag = []
        _bind_from_snapshot_rows(ev, et, rows, TODAY, diag)
        assert ev.has_cohort is True

    def test_bare_slice_key_skipped(self):
        """Rows with bare slice_key (no window/cohort prefix) → skipped."""
        ev = make_edge_evidence()
        et = make_edge_topology()
        rows = [
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=100, y=50, slice_key="bare"),
        ]
        diag = []
        _bind_from_snapshot_rows(ev, et, rows, TODAY, diag)
        assert ev.total_n == 0, "Bare slice_key rows should be skipped"

    def test_mixed_window_and_cohort(self):
        """Both window and cohort rows for same anchor_day.
        Should produce both window_obs and cohort_obs.
        """
        ev = make_edge_evidence()
        et = make_edge_topology()
        rows = [
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=100, y=50, slice_key="window(-90d:)"),
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=80, y=40, a=200, slice_key="cohort(-90d:)"),
        ]
        diag = []
        _bind_from_snapshot_rows(ev, et, rows, TODAY, diag)
        assert ev.has_window is True
        assert ev.has_cohort is True

    def test_context_prefixed_window_classified_as_window(self):
        """slice_key='context(channel:google).window(-90d:)' → window."""
        ev = make_edge_evidence()
        et = make_edge_topology()
        rows = [
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=100, y=50, slice_key="context(channel:google).window(-90d:)"),
        ]
        diag = []
        _bind_from_snapshot_rows(ev, et, rows, TODAY, diag,
                                 mece_dimensions=["channel"])
        # Should be classified as window (has 'window(' in slice_key)
        assert ev.has_window is True or ev.total_n > 0


# ═══════════════════════════════════════════════════════════════
# Suite G: Onset observation collection
# ═════════════════════════════════════════════��═════════════════

class TestOnsetCollectionAdversarial:
    """onset_delta_days should be deduplicated by retrieval date."""

    def test_onset_deduped_by_retrieval_date(self):
        """Multiple rows on same retrieval date with same onset.
        Only one onset observation should be collected.
        """
        ev = make_edge_evidence()
        et = make_edge_topology()
        rows = [
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=60, y=30, onset_delta_days=2.5,
                         slice_key="context(channel:google).window(-90d:)"),
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=40, y=20, onset_delta_days=2.5,
                         slice_key="context(channel:meta).window(-90d:)"),
        ]
        diag = []
        _bind_from_snapshot_rows(ev, et, rows, TODAY, diag,
                                 mece_dimensions=["channel"])

        if ev.latency_prior and ev.latency_prior.onset_observations:
            # Should be exactly 1 observation (deduped by retrieval date)
            assert len(ev.latency_prior.onset_observations) == 1, (
                f"Expected 1 onset obs (deduped), got {len(ev.latency_prior.onset_observations)}"
            )

    def test_different_retrieval_dates_both_collected(self):
        """Two retrieval dates with different onset values.
        Both should be collected.
        """
        ev = make_edge_evidence()
        et = make_edge_topology()
        rows = [
            snapshot_row("2025-01-01", "2025-03-01T12:00:00Z",
                         x=100, y=40, onset_delta_days=2.0),
            snapshot_row("2025-01-01", "2025-04-01T12:00:00Z",
                         x=100, y=50, onset_delta_days=2.5),
        ]
        diag = []
        _bind_from_snapshot_rows(ev, et, rows, TODAY, diag)

        if ev.latency_prior and ev.latency_prior.onset_observations:
            assert len(ev.latency_prior.onset_observations) == 2, (
                f"Expected 2 onset obs (different dates), got {len(ev.latency_prior.onset_observations)}"
            )
