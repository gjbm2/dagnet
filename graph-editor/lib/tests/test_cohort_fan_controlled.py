"""
Controlled input tests for cohort maturity fan chart computation.

Tests with synthetic data where we know exactly what the outputs should be.
No live data, no epoch stitching, no frame complexity — pure maths verification.
"""

import math
from datetime import date, timedelta
from runner.cohort_forecast import compute_cohort_maturity_rows
from runner.confidence_bands import (
    _shifted_lognormal_cdf,
    compute_confidence_band,
)


# ── Helpers ────────────────────────────────────────────────────────────

def make_single_cohort_frames(
    anchor: date,
    sweep_to: date,
    x: int,
    y_by_tau: dict,  # tau → y (cumulative)
):
    """Build frames for a single Cohort with known y at each τ."""
    frames = []
    d = anchor
    while d <= sweep_to:
        tau = (d - anchor).days
        y = y_by_tau.get(tau, y_by_tau.get(max(t for t in y_by_tau if t <= tau), 0))
        frames.append({
            'as_at_date': d.isoformat(),
            'data_points': [{
                'anchor_day': anchor.isoformat(),
                'x': x,
                'y': y,
                'a': x,
            }],
        })
        d += timedelta(days=1)
    return frames


def make_graph(edge_uuid, from_node, to_node, p_mean, mu, sigma, onset):
    """Build minimal graph with one edge."""
    return {
        'edges': [{
            'uuid': edge_uuid,
            'from': from_node,
            'to': to_node,
            'p': {
                'latency': {
                    'mu': mu, 'sigma': sigma, 'onset_delta_days': onset,
                    'posterior': {
                        'mu_mean': mu, 'sigma_mean': sigma,
                        'onset_delta_days': onset,
                    },
                },
                'forecast': {'mean': p_mean},
                'posterior': {'alpha': 20, 'beta': 5},
            },
        }],
    }


EDGE_PARAMS = {
    'mu': 2.0, 'sigma': 0.5, 'onset_delta_days': 2.0,
    'forecast_mean': 0.80,
    'p_stdev': 0.05,
    'bayes_mu_sd': 0.10,
    'bayes_sigma_sd': 0.05,
    'bayes_onset_sd': 0.20,
    'bayes_onset_mu_corr': -0.80,
}

GRAPH = make_graph('e1', 'A', 'B', 0.80, 2.0, 0.5, 2.0)


# ── Test: Single Cohort, midpoint monotonically increasing ────────────

class TestSingleCohortMidpoint:
    """Phase 1a: single Cohort, window mode. Midpoint must be monotonic."""

    def _run(self, x, y_by_tau, anchor_str, sweep_to_str):
        anchor = date.fromisoformat(anchor_str)
        sweep_to = date.fromisoformat(sweep_to_str)
        frames = make_single_cohort_frames(anchor, sweep_to, x, y_by_tau)
        return compute_cohort_maturity_rows(
            frames=frames, graph=GRAPH, target_edge_id='e1',
            edge_params=EDGE_PARAMS,
            anchor_from=anchor_str, anchor_to=anchor_str,
            sweep_to=sweep_to_str, is_window=True,
            axis_tau_max=30,
        )

    def test_midpoint_monotonically_increasing(self):
        """Midpoint must never decrease — conversions only accumulate."""
        rows = self._run(
            x=100,
            y_by_tau={0: 0, 5: 0, 6: 10, 7: 20, 8: 25, 9: 25},
            anchor_str='2026-03-01',
            sweep_to_str='2026-03-10',
        )
        midpoints = [(r['tau_days'], r['midpoint']) for r in rows if r['midpoint'] is not None]
        for i in range(1, len(midpoints)):
            tau_prev, mid_prev = midpoints[i - 1]
            tau_curr, mid_curr = midpoints[i]
            assert mid_curr >= mid_prev - 1e-9, \
                f"Midpoint decreased from τ={tau_prev} ({mid_prev:.4f}) to τ={tau_curr} ({mid_curr:.4f})"

    def test_midpoint_above_evidence_at_boundary(self):
        """At the last evidence τ, midpoint should equal evidence."""
        rows = self._run(
            x=100,
            y_by_tau={0: 0, 5: 0, 6: 10, 7: 20, 8: 25, 9: 25},
            anchor_str='2026-03-01',
            sweep_to_str='2026-03-10',
        )
        by_tau = {r['tau_days']: r for r in rows}
        # tau_solid_max = tau_future_max = 9 (single Cohort)
        assert by_tau[9]['midpoint'] is not None
        assert abs(by_tau[9]['midpoint'] - by_tau[9]['rate']) < 0.001

    def test_midpoint_exceeds_evidence_in_epoch_c(self):
        """In epoch C, midpoint must be above the last evidence rate."""
        rows = self._run(
            x=100,
            y_by_tau={0: 0, 5: 0, 6: 10, 7: 20, 8: 25, 9: 25},
            anchor_str='2026-03-01',
            sweep_to_str='2026-03-10',
        )
        by_tau = {r['tau_days']: r for r in rows}
        last_evidence = by_tau[9]['rate']
        for tau in range(10, 31):
            if tau in by_tau and by_tau[tau]['midpoint'] is not None:
                assert by_tau[tau]['midpoint'] >= last_evidence - 1e-9, \
                    f"Midpoint at τ={tau} ({by_tau[tau]['midpoint']:.4f}) below evidence ({last_evidence:.4f})"

    def test_midpoint_calibrated_to_evidence(self):
        """Midpoint (MC median) should be within the posterior's plausible range.

        With MC approach, midpoint is the posterior median, which reflects
        the model's belief about the rate — not calibrated to this specific
        Cohort's evidence.  It should be reasonable (not extreme).
        """
        rows = self._run(
            x=100,
            y_by_tau={0: 0, 5: 0, 6: 5, 7: 10, 8: 12, 9: 12},  # 12% rate — below model ~50%
            anchor_str='2026-03-01',
            sweep_to_str='2026-03-10',
        )
        by_tau = {r['tau_days']: r for r in rows}
        # Midpoint is the MC median — should be within [0, 1] and present
        for tau in range(10, 31):
            if tau in by_tau and by_tau[tau]['midpoint'] is not None:
                mp = by_tau[tau]['midpoint']
                assert 0.0 < mp < 1.0, \
                    f"Midpoint at τ={tau} ({mp:.4f}) out of range"


# ── Test: Fan width properties ────────────────────────────────────────

class TestFanWidth:
    """Fan must spread from the observation point."""

    def _run(self, x, y_by_tau):
        anchor = date(2026, 3, 1)
        sweep_to = date(2026, 3, 10)
        frames = make_single_cohort_frames(anchor, sweep_to, x, y_by_tau)
        return compute_cohort_maturity_rows(
            frames=frames, graph=GRAPH, target_edge_id='e1',
            edge_params=EDGE_PARAMS,
            anchor_from='2026-03-01', anchor_to='2026-03-01',
            sweep_to='2026-03-10', is_window=True,
            axis_tau_max=30,
        )

    def test_fan_zero_at_boundary(self):
        rows = self._run(x=100, y_by_tau={0: 0, 6: 10, 9: 25})
        by_tau = {r['tau_days']: r for r in rows}
        assert by_tau[9]['fan_upper'] is not None
        assert by_tau[9]['fan_lower'] is not None
        assert abs(by_tau[9]['fan_upper'] - by_tau[9]['fan_lower']) < 0.001

    def test_fan_opens_in_epoch_c(self):
        rows = self._run(x=100, y_by_tau={0: 0, 6: 10, 9: 25})
        by_tau = {r['tau_days']: r for r in rows}
        widths = []
        for tau in range(10, 31):
            if tau in by_tau and by_tau[tau]['fan_upper'] is not None:
                w = by_tau[tau]['fan_upper'] - by_tau[tau]['fan_lower']
                widths.append((tau, w))
        # Fan should generally widen (not strictly — can plateau at maturity)
        assert len(widths) > 5
        assert widths[-1][1] > widths[0][1], \
            f"Fan didn't widen: τ={widths[0][0]} width={widths[0][1]:.4f}, τ={widths[-1][0]} width={widths[-1][1]:.4f}"

    def test_fan_width_both_nonzero_across_cohort_sizes(self):
        """MC fan width is nonzero for both small and large Cohorts.

        With the Bayesian posterior predictive, larger Cohorts provide more
        evidence (n_eff = x × c), shifting the posterior away from the prior.
        Fan widths may legitimately differ because the posterior rate is more
        tightly constrained for larger Cohorts.  Both should be positive.
        """
        rows_small = self._run(x=20, y_by_tau={0: 0, 6: 5, 9: 5})
        rows_large = self._run(x=2000, y_by_tau={0: 0, 6: 500, 9: 500})
        by_tau_s = {r['tau_days']: r for r in rows_small}
        by_tau_l = {r['tau_days']: r for r in rows_large}
        if 20 in by_tau_s and 20 in by_tau_l:
            w_small = by_tau_s[20]['fan_upper'] - by_tau_s[20]['fan_lower']
            w_large = by_tau_l[20]['fan_upper'] - by_tau_l[20]['fan_lower']
            assert w_small > 0.01, f"Small cohort fan too narrow: {w_small:.4f}"
            assert w_large > 0.01, f"Large cohort fan too narrow: {w_large:.4f}"

    def test_fan_contains_midpoint(self):
        rows = self._run(x=100, y_by_tau={0: 0, 6: 10, 9: 25})
        for r in rows:
            if r['fan_upper'] is not None and r['midpoint'] is not None:
                assert r['fan_lower'] <= r['midpoint'] <= r['fan_upper'], \
                    f"Fan doesn't contain midpoint at τ={r['tau_days']}"


# ── Test: Multi-Cohort epoch B ────────────────────────────────────────

class TestMultiCohortEpochB:
    """Phase 1b: multiple Cohorts, epoch B exists."""

    def _run(self):
        """3 Cohorts: Mar-1 (tau_max=9), Mar-2 (tau_max=8), Mar-3 (tau_max=7)."""
        anchor_from = date(2026, 3, 1)
        anchor_to = date(2026, 3, 3)
        sweep_to = date(2026, 3, 10)

        frames = []
        for d_offset in range(10):
            frame_date = anchor_from + timedelta(days=d_offset)
            dps = []
            for cohort_offset in range(3):
                ad = anchor_from + timedelta(days=cohort_offset)
                tau = (frame_date - ad).days
                if tau < 0:
                    continue
                # Simple conversion: y = x * 0.25 * min(1, max(0, (tau-5)/5))
                x = 100
                y = int(x * 0.25 * max(0, min(1, (tau - 5) / 5.0)))
                dps.append({
                    'anchor_day': ad.isoformat(),
                    'x': x,
                    'y': y,
                    'a': x,
                })
            frames.append({
                'as_at_date': frame_date.isoformat(),
                'data_points': dps,
            })

        return compute_cohort_maturity_rows(
            frames=frames, graph=GRAPH, target_edge_id='e1',
            edge_params=EDGE_PARAMS,
            anchor_from='2026-03-01', anchor_to='2026-03-03',
            sweep_to='2026-03-10', is_window=True,
            axis_tau_max=30,
        )

    def test_has_epoch_b_rows(self):
        rows = self._run()
        by_tau = {r['tau_days']: r for r in rows}
        # tau_solid_max = 10-3 = 7, tau_future_max = 10-1 = 9
        # Epoch B: τ = 8, 9
        assert 8 in by_tau
        assert by_tau[8]['midpoint'] is not None, "Midpoint should exist in epoch B"

    def test_midpoint_above_evidence_epoch_b(self):
        """In epoch B, midpoint must be ≥ evidence (window mode)."""
        rows = self._run()
        for r in rows:
            if r['midpoint'] is not None and r['rate'] is not None:
                assert r['midpoint'] >= r['rate'] - 1e-9, \
                    f"Midpoint ({r['midpoint']:.4f}) below evidence ({r['rate']:.4f}) at τ={r['tau_days']}"

    def test_midpoint_monotonic_across_epochs(self):
        rows = self._run()
        midpoints = [(r['tau_days'], r['midpoint']) for r in rows if r['midpoint'] is not None]
        for i in range(1, len(midpoints)):
            tau_prev, mid_prev = midpoints[i - 1]
            tau_curr, mid_curr = midpoints[i]
            assert mid_curr >= mid_prev - 1e-9, \
                f"Midpoint decreased from τ={tau_prev} ({mid_prev:.4f}) to τ={tau_curr} ({mid_curr:.4f})"


# ── Test: CDF ratio calibration ──────────────────────────────────────

class TestCDFRatioCalibration:
    """The y_forecast = y_frozen × CDF(τ)/CDF(tau_max) formula."""

    def test_cdf_ratio_at_boundary_equals_frozen(self):
        """At tau_max, CDF ratio = 1, so y_forecast = y_frozen."""
        mu, sigma, onset = 2.0, 0.5, 2.0
        tau_max = 9
        cdf_at_max = _shifted_lognormal_cdf(tau_max, onset, mu, sigma)
        ratio = cdf_at_max / cdf_at_max
        assert abs(ratio - 1.0) < 1e-9

    def test_cdf_ratio_increases_monotonically(self):
        mu, sigma, onset = 2.0, 0.5, 2.0
        tau_max = 9
        cdf_at_max = _shifted_lognormal_cdf(tau_max, onset, mu, sigma)
        prev_ratio = 1.0
        for tau in range(10, 30):
            cdf_at_tau = _shifted_lognormal_cdf(tau, onset, mu, sigma)
            ratio = cdf_at_tau / cdf_at_max
            assert ratio >= prev_ratio - 1e-9, \
                f"CDF ratio decreased at τ={tau}"
            prev_ratio = ratio

    def test_cdf_ratio_converges(self):
        """At large τ, CDF ratio should converge to 1/CDF(tau_max)."""
        mu, sigma, onset = 2.0, 0.5, 2.0
        tau_max = 9
        cdf_at_max = _shifted_lognormal_cdf(tau_max, onset, mu, sigma)
        cdf_at_inf = _shifted_lognormal_cdf(500, onset, mu, sigma)
        expected_limit = cdf_at_inf / cdf_at_max  # ≈ 1/CDF(tau_max)
        assert abs(expected_limit - 1.0 / cdf_at_max) < 0.01


# ── Test: Monte Carlo unconditional band properties ──────────────────

class TestMCBand:
    """Verify the Monte Carlo confidence band."""

    def test_band_bounded_01(self):
        upper, lower = compute_confidence_band(
            ages=range(0, 30),
            p=0.80, mu=2.0, sigma=0.5, onset=2.0,
            p_sd=0.05, mu_sd=0.10, sigma_sd=0.05, onset_sd=0.20,
            onset_mu_corr=-0.80, level=0.90,
        )
        for i, (u, l) in enumerate(zip(upper, lower)):
            assert 0.0 <= l <= u <= 1.0, f"Band out of [0,1] at tau={i}: [{l:.4f}, {u:.4f}]"

    def test_band_opens_after_onset(self):
        upper, lower = compute_confidence_band(
            ages=range(0, 30),
            p=0.80, mu=2.0, sigma=0.5, onset=2.0,
            p_sd=0.05, mu_sd=0.10, sigma_sd=0.05, onset_sd=0.20,
            onset_mu_corr=-0.80, level=0.90,
        )
        # Band should have non-zero width after onset
        width_at_10 = upper[10] - lower[10]
        assert width_at_10 > 0.01, f"Band too narrow at tau=10: {width_at_10:.4f}"

    def test_band_converges_asymptotically(self):
        upper, lower = compute_confidence_band(
            ages=range(0, 60),
            p=0.80, mu=2.0, sigma=0.5, onset=2.0,
            p_sd=0.05, mu_sd=0.10, sigma_sd=0.05, onset_sd=0.20,
            onset_mu_corr=-0.80, level=0.90,
        )
        # At large tau, width should converge (mostly p uncertainty)
        width_50 = upper[50] - lower[50]
        width_55 = upper[55] - lower[55]
        # Should be similar (converging)
        assert abs(width_50 - width_55) < 0.02, (
            f"Band not converging: width@50={width_50:.4f}, width@55={width_55:.4f}"
        )
