"""
Test harness for cohort maturity fan chart using the fan_test_1 fixture.

Calls the SAME production compute_cohort_maturity_rows() with controlled
synthetic data.  Asserts mathematical invariants that must hold for
window-mode fan charts.

Fixture: 7-Cohort window(1-Jan:7-Jan), sweep to 13-Jan, p=0.83,
evidence accrues at 0.8× model rate.  tau_solid_max=6, tau_future_max=12.
"""

import sys
import os
import pytest

# Ensure runner package is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from runner.cohort_forecast import compute_cohort_maturity_rows, load_test_fixture


# ── Fixtures ─────────────────────────────────────────────────────────


@pytest.fixture
def rows():
    fixture = load_test_fixture('fan_test_1')
    return compute_cohort_maturity_rows(**fixture)


@pytest.fixture
def epoch_boundaries(rows):
    """Extract epoch boundaries from the first row."""
    r = rows[0]
    return r['tau_solid_max'], r['tau_future_max']


def _make_flexed_rows(overrides):
    """Helper: generate rows with overridden evidence distribution."""
    fixture = load_test_fixture('fan_test_1', overrides)
    return compute_cohort_maturity_rows(**fixture)


class TestFixtureLoads:

    def test_fixture_produces_rows(self, rows):
        assert len(rows) > 0, 'fixture should produce at least one row'

    def test_rows_cover_all_epochs(self, rows, epoch_boundaries):
        tau_solid_max, tau_future_max = epoch_boundaries
        taus = [r['tau_days'] for r in rows]
        # Epoch A
        assert any(t <= tau_solid_max for t in taus), 'should have epoch A rows'
        # Epoch B
        assert any(tau_solid_max < t <= tau_future_max for t in taus), 'should have epoch B rows'
        # Epoch C
        assert any(t > tau_future_max for t in taus), 'should have epoch C rows'

    def test_epoch_boundaries_correct(self, epoch_boundaries):
        tau_solid_max, tau_future_max = epoch_boundaries
        # 13-Jan - 7-Jan = 6,  13-Jan - 1-Jan = 12
        assert tau_solid_max == 6
        assert tau_future_max == 12


class TestMidpointInvariants:

    def test_midpoint_null_in_epoch_a(self, rows, epoch_boundaries):
        tau_solid_max, _ = epoch_boundaries
        for r in rows:
            if r['tau_days'] < tau_solid_max:
                assert r['midpoint'] is None, (
                    f"midpoint should be null in epoch A (tau={r['tau_days']})"
                )

    def test_midpoint_present_in_epoch_c(self, rows, epoch_boundaries):
        _, tau_future_max = epoch_boundaries
        c_rows = [r for r in rows if r['tau_days'] > tau_future_max]
        assert len(c_rows) > 0
        for r in c_rows:
            assert r['midpoint'] is not None, (
                f"midpoint should exist in epoch C (tau={r['tau_days']})"
            )

    def test_midpoint_ge_evidence_in_window_mode(self, rows):
        """In window mode, midpoint >= evidence (same x, larger y)."""
        for r in rows:
            if r['midpoint'] is not None and r['rate'] is not None:
                assert r['midpoint'] >= r['rate'] - 1e-9, (
                    f"midpoint ({r['midpoint']:.6f}) < evidence ({r['rate']:.6f}) "
                    f"at tau={r['tau_days']} — violates window-mode invariant"
                )

    def test_midpoint_monotonically_increasing(self, rows):
        """Midpoint should not decrease as tau increases."""
        midpoints = [(r['tau_days'], r['midpoint'])
                     for r in rows if r['midpoint'] is not None]
        for i in range(1, len(midpoints)):
            tau_prev, mp_prev = midpoints[i - 1]
            tau_curr, mp_curr = midpoints[i]
            assert mp_curr >= mp_prev - 1e-9, (
                f"midpoint decreased from {mp_prev:.6f} (tau={tau_prev}) "
                f"to {mp_curr:.6f} (tau={tau_curr})"
            )


class TestFanInvariants:

    def test_fan_contains_midpoint(self, rows):
        for r in rows:
            if r['fan_upper'] is not None and r['midpoint'] is not None:
                assert r['fan_lower'] <= r['midpoint'] + 1e-9, (
                    f"fan_lower ({r['fan_lower']:.6f}) > midpoint ({r['midpoint']:.6f}) "
                    f"at tau={r['tau_days']}"
                )
                assert r['fan_upper'] >= r['midpoint'] - 1e-9, (
                    f"fan_upper ({r['fan_upper']:.6f}) < midpoint ({r['midpoint']:.6f}) "
                    f"at tau={r['tau_days']}"
                )

    def test_fan_zero_width_at_boundary(self, rows, epoch_boundaries):
        tau_solid_max, _ = epoch_boundaries
        boundary = [r for r in rows if r['tau_days'] == tau_solid_max]
        for r in boundary:
            if r['fan_upper'] is not None:
                width = r['fan_upper'] - r['fan_lower']
                assert width < 0.005, (
                    f"fan width at boundary tau={tau_solid_max} is {width:.4f}, "
                    f"expected near-zero"
                )

    def test_fan_opens_after_boundary(self, rows, epoch_boundaries):
        tau_solid_max, _ = epoch_boundaries
        fan_rows = [(r['tau_days'], r['fan_upper'] - r['fan_lower'])
                    for r in rows
                    if r['fan_upper'] is not None and r['fan_lower'] is not None
                    and r['tau_days'] > tau_solid_max + 2]
        assert len(fan_rows) > 0, 'should have fan rows after boundary'
        # Fan at tau=30 should be wider than at boundary+3
        early = [w for t, w in fan_rows if t <= tau_solid_max + 5]
        late = [w for t, w in fan_rows if t >= 30]
        if early and late:
            assert max(late) > min(early), (
                f"fan should be wider at tau>=30 ({max(late):.4f}) "
                f"than near boundary ({min(early):.4f})"
            )

    def test_fan_bounded_01(self, rows):
        for r in rows:
            if r['fan_upper'] is not None:
                assert r['fan_upper'] <= 1.0 + 1e-9, (
                    f"fan_upper ({r['fan_upper']:.6f}) > 1.0 at tau={r['tau_days']}"
                )
            if r['fan_lower'] is not None:
                assert r['fan_lower'] >= -1e-9, (
                    f"fan_lower ({r['fan_lower']:.6f}) < 0.0 at tau={r['tau_days']}"
                )


class TestEvidenceRate:

    def test_evidence_present_in_epoch_a(self, rows, epoch_boundaries):
        tau_solid_max, _ = epoch_boundaries
        a_rows = [r for r in rows if r['tau_days'] <= tau_solid_max]
        for r in a_rows:
            if r['tau_days'] > 0:  # tau=0 may have 0/0
                assert r['rate'] is not None, (
                    f"evidence rate should exist in epoch A (tau={r['tau_days']})"
                )

    def test_evidence_null_in_epoch_c(self, rows, epoch_boundaries):
        _, tau_future_max = epoch_boundaries
        c_rows = [r for r in rows if r['tau_days'] > tau_future_max]
        for r in c_rows:
            assert r['rate'] is None, (
                f"evidence rate should be null in epoch C (tau={r['tau_days']})"
            )

    def test_evidence_rate_increases_in_epoch_a(self, rows, epoch_boundaries):
        """Evidence rate should broadly increase in epoch A (CDF shape)."""
        tau_solid_max, _ = epoch_boundaries
        a_rates = [(r['tau_days'], r['rate'])
                   for r in rows
                   if r['tau_days'] <= tau_solid_max and r['rate'] is not None
                   and r['rate'] > 0]
        if len(a_rates) >= 3:
            # First non-zero rate should be less than last
            assert a_rates[-1][1] > a_rates[0][1], (
                f"evidence rate should increase across epoch A: "
                f"first={a_rates[0][1]:.4f} last={a_rates[-1][1]:.4f}"
            )


# ── Flexed evidence distribution tests ───────────────────────────────
#
# The model believes onset=4, mu=1.62, sigma=0.8.
# These tests generate evidence with DIFFERENT distribution params to
# stress the CDF ratio calibration and fan width behaviour.


class TestFlexedDistribution:
    """Invariants that must hold regardless of evidence distribution shape."""

    COMBOS = [
        # (label, overrides)
        ('early-fast', {'tf_onset': 2.0, 'tf_mu': 1.2, 'tf_sigma': 0.8, 'tf_factor': 0.8}),
        ('late-slow', {'tf_onset': 6.0, 'tf_mu': 2.0, 'tf_sigma': 1.2, 'tf_factor': 0.7}),
        ('narrow-high', {'tf_onset': 3.0, 'tf_mu': 1.62, 'tf_sigma': 0.4, 'tf_factor': 1.0}),
        ('wide-low', {'tf_onset': 4.0, 'tf_mu': 1.62, 'tf_sigma': 1.5, 'tf_factor': 0.6}),
        ('combo-shift', {'tf_onset': 2.0, 'tf_mu': 1.2, 'tf_sigma': 1.2, 'tf_factor': 0.7}),
    ]

    @pytest.mark.parametrize('label,overrides', COMBOS, ids=[c[0] for c in COMBOS])
    def test_produces_rows(self, label, overrides):
        rows = _make_flexed_rows(overrides)
        assert len(rows) > 0, f'{label}: should produce rows'

    @pytest.mark.parametrize('label,overrides', COMBOS, ids=[c[0] for c in COMBOS])
    def test_midpoint_monotonically_increasing(self, label, overrides):
        rows = _make_flexed_rows(overrides)
        midpoints = [(r['tau_days'], r['midpoint'])
                     for r in rows if r['midpoint'] is not None]
        for i in range(1, len(midpoints)):
            assert midpoints[i][1] >= midpoints[i - 1][1] - 1e-9, (
                f"{label}: midpoint decreased from {midpoints[i-1][1]:.6f} "
                f"(tau={midpoints[i-1][0]}) to {midpoints[i][1]:.6f} "
                f"(tau={midpoints[i][0]})"
            )

    @pytest.mark.parametrize('label,overrides', COMBOS, ids=[c[0] for c in COMBOS])
    def test_fan_contains_midpoint(self, label, overrides):
        rows = _make_flexed_rows(overrides)
        for r in rows:
            if r['fan_upper'] is not None and r['midpoint'] is not None:
                assert r['fan_lower'] <= r['midpoint'] + 1e-9, (
                    f"{label}: fan_lower > midpoint at tau={r['tau_days']}"
                )
                assert r['fan_upper'] >= r['midpoint'] - 1e-9, (
                    f"{label}: fan_upper < midpoint at tau={r['tau_days']}"
                )

    @pytest.mark.parametrize('label,overrides', COMBOS, ids=[c[0] for c in COMBOS])
    def test_fan_bounded_01(self, label, overrides):
        rows = _make_flexed_rows(overrides)
        for r in rows:
            if r['fan_upper'] is not None:
                assert r['fan_upper'] <= 1.0 + 1e-9, (
                    f"{label}: fan_upper > 1.0 at tau={r['tau_days']}"
                )
            if r['fan_lower'] is not None:
                assert r['fan_lower'] >= -1e-9, (
                    f"{label}: fan_lower < 0.0 at tau={r['tau_days']}"
                )

    @pytest.mark.parametrize('label,overrides', COMBOS, ids=[c[0] for c in COMBOS])
    def test_midpoint_ge_evidence_window_mode(self, label, overrides):
        """In window mode, midpoint >= evidence — tests whether Bug #1 manifests."""
        rows = _make_flexed_rows(overrides)
        violations = []
        for r in rows:
            if r['midpoint'] is not None and r['rate'] is not None:
                if r['midpoint'] < r['rate'] - 1e-9:
                    violations.append(
                        f"tau={r['tau_days']}: mid={r['midpoint']:.6f} < ev={r['rate']:.6f}"
                    )
        assert not violations, (
            f"{label}: midpoint < evidence in {len(violations)} rows:\n"
            + '\n'.join(violations[:5])
        )
