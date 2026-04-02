"""Tests for runner.cohort_forecast — generalised forecast utilities."""

import math
import pytest
from runner.cohort_forecast import (
    forecast_rate,
    read_edge_cohort_params,
    get_incoming_edges,
    find_edge_by_id,
    upstream_arrival_rate,
    compute_cohort_maturity_rows,
)


# ── forecast_rate ──────────────────────────────────────────────────────


class TestForecastRate:
    """forecast_rate(τ, p, mu, sigma, onset) = p × CDF(τ)."""

    def test_zero_at_tau_zero(self):
        assert forecast_rate(0, p=0.8, mu=2.5, sigma=0.5, onset=2.0) == 0.0

    def test_zero_before_onset(self):
        assert forecast_rate(1.5, p=0.8, mu=2.5, sigma=0.5, onset=2.0) == 0.0

    def test_approaches_p_at_large_tau(self):
        rate = forecast_rate(500, p=0.8, mu=2.5, sigma=0.5, onset=2.0)
        assert abs(rate - 0.8) < 0.01

    def test_monotonically_increasing(self):
        rates = [forecast_rate(t, p=0.8, mu=2.5, sigma=0.5, onset=2.0) for t in range(0, 100)]
        for i in range(1, len(rates)):
            assert rates[i] >= rates[i - 1]

    def test_zero_p_gives_zero(self):
        assert forecast_rate(50, p=0.0, mu=2.5, sigma=0.5) == 0.0

    def test_negative_tau_gives_zero(self):
        assert forecast_rate(-5, p=0.8, mu=2.5, sigma=0.5) == 0.0

    def test_zero_onset_works(self):
        rate = forecast_rate(50, p=0.8, mu=2.5, sigma=0.5, onset=0.0)
        assert 0 < rate <= 0.8

    def test_clamped_to_one(self):
        # p > 1 shouldn't happen but forecast_rate should still clamp
        rate = forecast_rate(500, p=1.5, mu=2.5, sigma=0.5, onset=0.0)
        assert rate <= 1.0

    def test_mid_range_value(self):
        # At the median of the lognormal (exp(mu) + onset), CDF ≈ 0.5
        mu, sigma, onset = 2.5, 0.5, 2.0
        median_tau = math.exp(mu) + onset
        rate = forecast_rate(median_tau, p=0.8, mu=mu, sigma=sigma, onset=onset)
        assert 0.35 < rate < 0.45  # p × 0.5 ≈ 0.4


# ── read_edge_cohort_params ────────────────────────────────────────────


class TestReadEdgeCohortParams:
    """Extract cohort-level Bayes params from graph edge dicts."""

    def test_extracts_from_posterior(self):
        edge = {
            'p': {
                'latency': {
                    'posterior': {
                        'path_mu_mean': 2.5,
                        'path_sigma_mean': 0.5,
                        'path_onset_delta_days': 3.0,
                    },
                },
                'posterior': {
                    'path_alpha': 10.0,
                    'path_beta': 2.0,
                },
            },
        }
        params = read_edge_cohort_params(edge)
        assert params is not None
        assert params['mu'] == 2.5
        assert params['sigma'] == 0.5
        assert params['onset'] == 3.0
        assert abs(params['p'] - 10.0 / 12.0) < 0.001

    def test_falls_back_to_flat_latency(self):
        edge = {
            'p': {
                'latency': {'mu': 2.0, 'sigma': 0.4, 'onset_delta_days': 1.0},
                'forecast': {'mean': 0.75},
            },
        }
        params = read_edge_cohort_params(edge)
        assert params is not None
        assert params['mu'] == 2.0
        assert params['sigma'] == 0.4
        assert params['p'] == 0.75

    def test_returns_none_without_mu(self):
        edge = {'p': {'latency': {'sigma': 0.5}, 'forecast': {'mean': 0.8}}}
        assert read_edge_cohort_params(edge) is None

    def test_returns_none_without_sigma(self):
        edge = {'p': {'latency': {'mu': 2.0}, 'forecast': {'mean': 0.8}}}
        assert read_edge_cohort_params(edge) is None

    def test_returns_none_without_probability(self):
        edge = {'p': {'latency': {'mu': 2.0, 'sigma': 0.5}}}
        assert read_edge_cohort_params(edge) is None

    def test_prefers_cohort_posterior_over_window(self):
        edge = {
            'p': {
                'latency': {'posterior': {'mu_mean': 2.0, 'sigma_mean': 0.5}},
                'posterior': {
                    'alpha': 5.0, 'beta': 5.0,           # window: 0.5
                    'path_alpha': 8.0, 'path_beta': 2.0,  # cohort: 0.8
                },
            },
        }
        params = read_edge_cohort_params(edge)
        assert params is not None
        assert abs(params['p'] - 0.8) < 0.001

    def test_empty_edge(self):
        assert read_edge_cohort_params({}) is None

    def test_zero_sigma_returns_none(self):
        edge = {'p': {'latency': {'mu': 2.0, 'sigma': 0.0}, 'forecast': {'mean': 0.8}}}
        assert read_edge_cohort_params(edge) is None


# ── Graph topology helpers ─────────────────────────────────────────────


SAMPLE_GRAPH = {
    'edges': [
        {'uuid': 'e1', 'from': 'A', 'to': 'B',
         'p': {'latency': {'mu': 2.0, 'sigma': 0.4, 'onset_delta_days': 1.0},
               'forecast': {'mean': 0.9}}},
        {'uuid': 'e2', 'from': 'B', 'to': 'C',
         'p': {'latency': {'mu': 2.5, 'sigma': 0.5, 'onset_delta_days': 2.0},
               'forecast': {'mean': 0.8}}},
        {'uuid': 'e3', 'from': 'A', 'to': 'C',
         'p': {'latency': {'mu': 3.0, 'sigma': 0.6, 'onset_delta_days': 0.0},
               'forecast': {'mean': 0.3}}},
    ],
}


class TestGetIncomingEdges:
    def test_single_incoming(self):
        edges = get_incoming_edges(SAMPLE_GRAPH, 'B')
        assert len(edges) == 1
        assert edges[0]['uuid'] == 'e1'

    def test_multiple_incoming(self):
        edges = get_incoming_edges(SAMPLE_GRAPH, 'C')
        assert len(edges) == 2
        uuids = {e['uuid'] for e in edges}
        assert uuids == {'e2', 'e3'}

    def test_no_incoming(self):
        edges = get_incoming_edges(SAMPLE_GRAPH, 'A')
        assert len(edges) == 0

    def test_nonexistent_node(self):
        edges = get_incoming_edges(SAMPLE_GRAPH, 'Z')
        assert len(edges) == 0


class TestFindEdgeById:
    def test_finds_by_uuid(self):
        edge = find_edge_by_id(SAMPLE_GRAPH, 'e2')
        assert edge is not None
        assert edge['from'] == 'B'

    def test_returns_none_for_missing(self):
        assert find_edge_by_id(SAMPLE_GRAPH, 'nonexistent') is None


# ── upstream_arrival_rate ──────────────────────────────────────────────


class TestUpstreamArrivalRate:
    def test_single_incoming_edge(self):
        # Node B has one incoming edge (e1: A→B, p=0.9, mu=2.0, sigma=0.4, onset=1.0)
        rate = upstream_arrival_rate(50, SAMPLE_GRAPH, 'B')
        assert rate is not None
        # At τ=50, CDF should be near 1.0, so rate ≈ 0.9
        assert 0.85 < rate < 0.95

    def test_multiple_incoming_edges_sum(self):
        # Node C has two incoming edges (e2 + e3)
        rate = upstream_arrival_rate(50, SAMPLE_GRAPH, 'C')
        assert rate is not None
        # Sum of e2 rate (~0.8) + e3 rate (~0.3) ≈ 1.1 — but each is independent
        # arrival, so summing is correct (total arrivals from both paths)
        assert rate > 0.5

    def test_zero_tau(self):
        rate = upstream_arrival_rate(0, SAMPLE_GRAPH, 'B')
        assert rate is not None
        assert rate == 0.0

    def test_no_incoming_returns_none(self):
        assert upstream_arrival_rate(50, SAMPLE_GRAPH, 'A') is None

    def test_monotonically_increasing(self):
        rates = [upstream_arrival_rate(t, SAMPLE_GRAPH, 'B') for t in range(0, 100)]
        for i in range(1, len(rates)):
            assert rates[i] >= rates[i - 1]

    def test_returns_none_for_edges_without_params(self):
        graph = {'edges': [{'uuid': 'e1', 'from': 'A', 'to': 'B', 'p': {}}]}
        assert upstream_arrival_rate(50, graph, 'B') is None


# ── compute_cohort_maturity_rows ────────────────────────────────────────


# Graph: A --e_up--> B --e_target--> C
# e_up: upstream edge (A→B), provides x forecast at B
# e_target: target edge (B→C), provides y forecast
FAN_GRAPH = {
    'edges': [
        {'uuid': 'e_up', 'from': 'A', 'to': 'B',
         'p': {
             'latency': {'mu': 1.5, 'sigma': 0.4, 'onset_delta_days': 0.0},
             'forecast': {'mean': 0.95},
         }},
        {'uuid': 'e_target', 'from': 'B', 'to': 'C',
         'p': {
             'latency': {'mu': 2.5, 'sigma': 0.5, 'onset_delta_days': 2.0},
             'forecast': {'mean': 0.15},
         }},
    ],
}

# 5 cohorts, anchored 1-Mar to 5-Mar, sweep_to = 15-Mar
# tau_solid_max = 15 - 5 = 10, tau_future_max = 15 - 1 = 14
FAN_FRAMES = [
    {
        'snapshot_date': '2026-03-15',
        'data_points': [
            {'anchor_day': '2026-03-01', 'x': 100, 'y': 10, 'a': 200},
            {'anchor_day': '2026-03-02', 'x': 90, 'y': 8, 'a': 180},
            {'anchor_day': '2026-03-03', 'x': 80, 'y': 6, 'a': 160},
            {'anchor_day': '2026-03-04', 'x': 70, 'y': 4, 'a': 140},
            {'anchor_day': '2026-03-05', 'x': 60, 'y': 2, 'a': 120},
        ],
    },
]

FAN_EDGE_PARAMS = {
    'mu': 2.5, 'sigma': 0.5, 'onset_delta_days': 2.0, 'forecast_mean': 0.15,
    'bayes_mu_sd': 0.3, 'bayes_sigma_sd': 0.1,
    'bayes_onset_sd': 0.5, 'p_stdev': 0.03,
    'bayes_onset_mu_corr': 0.0,
}


def _call_rows(**overrides):
    """Helper to call compute_cohort_maturity_rows with test defaults."""
    kwargs = dict(
        frames=FAN_FRAMES, graph=FAN_GRAPH, target_edge_id='e_target',
        edge_params=FAN_EDGE_PARAMS,
        anchor_from='2026-03-01', anchor_to='2026-03-05', sweep_to='2026-03-15',
    )
    kwargs.update(overrides)
    return compute_cohort_maturity_rows(**kwargs)


def _by_tau(rows):
    """Index rows by tau_days for easy lookup."""
    return {r['tau_days']: r for r in rows}


class TestComputeCohortMaturityRows:
    def test_returns_rows_covering_epochs_b_and_c(self):
        rows = _call_rows()
        taus = _by_tau(rows)
        assert len(rows) > 0
        # Epoch B: 10 ≤ τ ≤ 14 (tau_solid_max..tau_future_max)
        assert 10 in taus
        assert 14 in taus
        # Epoch C: τ > 14 (from model/band extent)
        assert 20 in taus

    def test_each_row_has_required_fields(self):
        rows = _call_rows()
        required = {'tau_days', 'rate', 'projected_rate', 'midpoint',
                     'fan_upper', 'fan_lower', 'tau_solid_max', 'tau_future_max'}
        for r in rows:
            assert required.issubset(r.keys()), f"missing fields at τ={r.get('tau_days')}: {required - r.keys()}"

    def test_evidence_rate_null_in_epoch_c(self):
        rows = _call_rows()
        for r in rows:
            if r['tau_days'] > 14:  # tau_future_max
                assert r['rate'] is None, f"rate should be null in epoch C at τ={r['tau_days']}"

    def test_midpoint_null_in_epoch_a(self):
        rows = _call_rows()
        for r in rows:
            if r['tau_days'] < 10:  # strictly before tau_solid_max
                assert r['midpoint'] is None, f"midpoint should be null in epoch A at τ={r['tau_days']}"

    def test_midpoint_in_range(self):
        rows = _call_rows()
        for r in rows:
            if r['midpoint'] is not None:
                assert 0 <= r['midpoint'] <= 1, f"midpoint out of range at τ={r['tau_days']}"

    def test_fan_ordering(self):
        rows = _call_rows()
        for r in rows:
            if r['fan_upper'] is not None and r['fan_lower'] is not None and r['midpoint'] is not None:
                assert r['fan_upper'] >= r['midpoint'] >= r['fan_lower'], \
                    f"fan ordering violated at τ={r['tau_days']}: upper={r['fan_upper']}, mid={r['midpoint']}, lower={r['fan_lower']}"

    def test_epoch_c_midpoint_nonzero(self):
        taus = _by_tau(_call_rows())
        assert taus[20]['midpoint'] is not None
        assert taus[20]['midpoint'] > 0

    def test_epoch_c_projected_rate_and_midpoint_both_positive(self):
        """In epoch C, both projected_rate and midpoint should be present and positive."""
        taus = _by_tau(_call_rows())
        assert taus[20]['projected_rate'] is not None
        assert taus[20]['projected_rate'] > 0
        assert taus[20]['midpoint'] is not None
        assert taus[20]['midpoint'] > 0

    def test_returns_empty_for_missing_edge(self):
        assert _call_rows(target_edge_id='nonexistent') == []

    def test_returns_empty_for_no_frames(self):
        assert _call_rows(frames=[]) == []

    def test_rows_sorted_by_tau(self):
        rows = _call_rows()
        taus = [r['tau_days'] for r in rows]
        assert taus == sorted(taus)


# ── Zero-maturity degeneration invariant ──────────────────────────────


class TestWindowZeroMaturityDegeneration:
    """When all Cohorts have tau_max=0 (zero maturity), the cohort_maturity
    fan chart should degenerate to the unconditional confidence band.

    Both outputs come from the same codebase, same fixture, same params.
    The test loads the JSON fixture, calls both code paths, and compares.
    """

    @staticmethod
    def _load_fixture():
        from runner.cohort_forecast import load_test_fixture
        return load_test_fixture('fan_test_1')

    def test_fan_equals_confidence_band_at_zero_maturity(self):
        """With zero maturity (no evidence), the MC fan must be precisely
        the same as the analytic confidence band — same midpoint, same
        upper, same lower.  They are computing the same thing: the
        unconditional model uncertainty envelope.

        Tolerance is MC noise only (~0.02 with 2000 draws)."""
        from runner.confidence_bands import compute_confidence_band

        fix = self._load_fixture()
        ep = fix['edge_params']

        # Zero maturity: sweep_to = anchor_to = anchor_from.
        zero_frames = [{
            'snapshot_date': fix['anchor_from'],
            'data_points': [
                fix['frames'][0]['data_points'][0],  # first Cohort, day 0
            ],
        }]
        rows = compute_cohort_maturity_rows(
            frames=zero_frames,
            graph=fix['graph'],
            target_edge_id=fix['target_edge_id'],
            edge_params=ep,
            anchor_from=fix['anchor_from'],
            anchor_to=fix['anchor_from'],
            sweep_to=fix['anchor_from'],
            is_window=True,
        )
        assert len(rows) > 0, "No rows returned for zero-maturity window"
        fan_by_tau = {r['tau_days']: r for r in rows}

        # Analytic confidence band with same params.
        tau_points = sorted(fan_by_tau.keys())
        band_upper, band_lower, band_median = compute_confidence_band(
            ages=[float(t) for t in tau_points],
            p=ep['forecast_mean'],
            mu=ep['mu'],
            sigma=ep['sigma'],
            onset=ep['onset_delta_days'],
            p_sd=ep.get('p_stdev', 0.0),
            mu_sd=ep.get('bayes_mu_sd', 0.0),
            sigma_sd=ep.get('bayes_sigma_sd', 0.0),
            onset_sd=ep.get('bayes_onset_sd', 0.0),
            onset_mu_corr=ep.get('bayes_onset_mu_corr', 0.0),
            level=0.90,
        )
        band = {tau_points[i]: (band_upper[i], band_lower[i], band_median[i])
                for i in range(len(tau_points))}

        # MC noise tolerance — 2000 draws gives ~0.02 on percentiles.
        TOL = 0.03

        onset = ep['onset_delta_days']
        checked = 0
        for tau in tau_points:
            if tau <= onset + 2:
                continue  # near-onset: both ~0, skip
            row = fan_by_tau[tau]
            if row['fan_upper'] is None or row['fan_lower'] is None:
                continue
            cb_upper, cb_lower, cb_median = band[tau]
            if cb_upper < 0.01:
                continue

            # Midpoint must match (both medians — not interval centroid,
            # which diverges from the median near onset due to skew).
            fan_mid = row['midpoint']
            cb_mid = cb_median
            assert fan_mid is not None
            assert abs(fan_mid - cb_mid) < TOL, (
                f"tau={tau}: fan midpoint={fan_mid:.4f} vs "
                f"band midpoint={cb_mid:.4f} "
                f"(delta={fan_mid - cb_mid:.4f})"
            )

            # Upper must match.
            assert abs(row['fan_upper'] - cb_upper) < TOL, (
                f"tau={tau}: fan upper={row['fan_upper']:.4f} vs "
                f"band upper={cb_upper:.4f} "
                f"(delta={row['fan_upper'] - cb_upper:.4f})"
            )

            # Lower must match.
            assert abs(row['fan_lower'] - cb_lower) < TOL, (
                f"tau={tau}: fan lower={row['fan_lower']:.4f} vs "
                f"band lower={cb_lower:.4f} "
                f"(delta={row['fan_lower'] - cb_lower:.4f})"
            )

            checked += 1

        assert checked >= 5, f"Only checked {checked} tau points — need at least 5"

    def test_fan_narrows_with_evidence(self):
        """Fan with non-zero maturity must be narrower than (or equal to)
        the confidence band.  Evidence can only reduce uncertainty.

        Uses the full fixture (7 Cohorts, sweep_to=13-Jan) so all Cohorts
        have real data.  Compares fan width to confidence band width at
        each tau beyond onset."""
        from runner.confidence_bands import compute_confidence_band

        fix = self._load_fixture()
        ep = fix['edge_params']

        # Full maturity: use all fixture dates as-is.
        rows = compute_cohort_maturity_rows(
            frames=fix['frames'],
            graph=fix['graph'],
            target_edge_id=fix['target_edge_id'],
            edge_params=ep,
            anchor_from=fix['anchor_from'],
            anchor_to=fix['anchor_to'],
            sweep_to=fix['sweep_to'],
            is_window=True,
        )
        assert len(rows) > 0, "No rows returned"
        fan_by_tau = {r['tau_days']: r for r in rows}

        tau_points = sorted(fan_by_tau.keys())
        band_upper, band_lower, band_median = compute_confidence_band(
            ages=[float(t) for t in tau_points],
            p=ep['forecast_mean'],
            mu=ep['mu'],
            sigma=ep['sigma'],
            onset=ep['onset_delta_days'],
            p_sd=ep.get('p_stdev', 0.0),
            mu_sd=ep.get('bayes_mu_sd', 0.0),
            sigma_sd=ep.get('bayes_sigma_sd', 0.0),
            onset_sd=ep.get('bayes_onset_sd', 0.0),
            onset_mu_corr=ep.get('bayes_onset_mu_corr', 0.0),
            level=0.90,
        )
        band = {tau_points[i]: (band_upper[i], band_lower[i])
                for i in range(len(tau_points))}

        onset = ep['onset_delta_days']
        checked = 0
        for tau in tau_points:
            if tau <= onset + 2:
                continue
            row = fan_by_tau[tau]
            if row['fan_upper'] is None or row['fan_lower'] is None:
                continue
            cb_upper, cb_lower = band[tau]
            cb_width = cb_upper - cb_lower
            if cb_width < 0.01:
                continue

            fan_width = row['fan_upper'] - row['fan_lower']

            # MC noise tolerance: fan width may slightly exceed band width
            # due to sampling noise, but not by more than TOL.
            TOL = 0.02
            assert fan_width <= cb_width + TOL, (
                f"tau={tau}: fan width={fan_width:.4f} > "
                f"band width={cb_width:.4f} + TOL={TOL} "
                f"(fan=[{row['fan_lower']:.4f},{row['fan_upper']:.4f}] "
                f"band=[{cb_lower:.4f},{cb_upper:.4f}])"
            )
            checked += 1

        assert checked >= 5, f"Only checked {checked} tau points — need at least 5"
