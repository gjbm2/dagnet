"""Tests for span_evidence.compose_path_maturity_frames.

Verifies:
- Single-edge pass-through (parity with v1)
- Two-edge linear chain composition (x from first, y from last)
- Fan-in at y (sum y across edges)
- x = a uses anchor population
- x ≠ a uses x field from x-incident edges
"""

import pytest
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from runner.span_evidence import compose_path_maturity_frames


def _make_frame(snapshot_date: str, data_points: list) -> dict:
    total_y = sum(dp.get('y', 0) for dp in data_points)
    return {
        'snapshot_date': snapshot_date,
        'data_points': data_points,
        'total_y': total_y,
    }


def _make_dp(anchor_day: str, x: float, y: float, a: float = 100.0) -> dict:
    rate = y / x if x > 0 else 0.0
    return {
        'anchor_day': anchor_day,
        'x': x,
        'y': y,
        'a': a,
        'rate': round(rate, 6),
        'median_lag_days': None,
        'mean_lag_days': None,
        'onset_delta_days': None,
    }


def _make_derivation_result(frames: list) -> dict:
    anchor_days = set()
    snapshot_dates = set()
    for f in frames:
        snapshot_dates.add(f['snapshot_date'])
        for dp in f['data_points']:
            anchor_days.add(dp['anchor_day'])
    sorted_ad = sorted(anchor_days)
    sorted_sd = sorted(snapshot_dates)
    return {
        'analysis_type': 'cohort_maturity',
        'frames': frames,
        'anchor_range': {
            'from': sorted_ad[0] if sorted_ad else None,
            'to': sorted_ad[-1] if sorted_ad else None,
        },
        'sweep_range': {
            'from': sorted_sd[0] if sorted_sd else None,
            'to': sorted_sd[-1] if sorted_sd else None,
        },
        'cohorts_analysed': len(sorted_ad),
    }


class TestSingleEdgePassthrough:
    """Single-edge case must produce the same frames as v1."""

    def test_single_edge_returns_original_frames(self):
        frames = [
            _make_frame('2025-11-01', [_make_dp('2025-10-01', 100, 42)]),
            _make_frame('2025-11-02', [_make_dp('2025-10-01', 100, 45)]),
        ]
        result = compose_path_maturity_frames(
            per_edge_results=[{
                'path_role': 'only',
                'from_node': 'x',
                'to_node': 'y',
                'derivation_result': _make_derivation_result(frames),
            }],
            query_from_node='x',
            query_to_node='y',
        )
        assert result['analysis_type'] == 'cohort_maturity_v2'
        assert len(result['frames']) == 2
        assert result['frames'][0]['data_points'][0]['y'] == 42
        assert result['frames'][1]['data_points'][0]['y'] == 45
        assert result['frames'][0]['data_points'][0]['x'] == 100


class TestTwoEdgeLinearChain:
    """Two-edge chain: x→b→y. Denominator from first edge, numerator from last."""

    def test_composes_x_from_first_y_from_last(self):
        # Edge x→b: x=100, y=80 (arrivals at b)
        first_frames = [
            _make_frame('2025-11-01', [_make_dp('2025-10-01', 100, 80, a=100)]),
        ]
        # Edge b→y: x=80, y=30 (arrivals at y)
        last_frames = [
            _make_frame('2025-11-01', [_make_dp('2025-10-01', 80, 30, a=100)]),
        ]

        result = compose_path_maturity_frames(
            per_edge_results=[
                {
                    'path_role': 'first',
                    'from_node': 'x',
                    'to_node': 'b',
                    'derivation_result': _make_derivation_result(first_frames),
                },
                {
                    'path_role': 'last',
                    'from_node': 'b',
                    'to_node': 'y',
                    'derivation_result': _make_derivation_result(last_frames),
                },
            ],
            query_from_node='x',
            query_to_node='y',
            anchor_node='x',  # x = a
        )

        assert len(result['frames']) == 1
        dp = result['frames'][0]['data_points'][0]
        # Denominator: x = a_pop = 100 (because x = a)
        assert dp['x'] == 100
        # Numerator: y = 30 (from last edge)
        assert dp['y'] == 30
        # Rate: 30/100 = 0.3
        assert dp['rate'] == 0.3


class TestFanInAtY:
    """Fan-in: two edges feed into y. Numerator is summed."""

    def test_sums_y_across_y_incident_edges(self):
        # Edge b→y: y=20
        edge_b_frames = [
            _make_frame('2025-11-01', [_make_dp('2025-10-01', 50, 20, a=100)]),
        ]
        # Edge c→y: y=15
        edge_c_frames = [
            _make_frame('2025-11-01', [_make_dp('2025-10-01', 50, 15, a=100)]),
        ]
        # Edge x→b (first): x=100
        first_frames = [
            _make_frame('2025-11-01', [_make_dp('2025-10-01', 100, 50, a=100)]),
        ]

        result = compose_path_maturity_frames(
            per_edge_results=[
                {
                    'path_role': 'first',
                    'from_node': 'x',
                    'to_node': 'b',
                    'derivation_result': _make_derivation_result(first_frames),
                },
                {
                    'path_role': 'last',
                    'from_node': 'b',
                    'to_node': 'y',
                    'derivation_result': _make_derivation_result(edge_b_frames),
                },
                {
                    'path_role': 'last',
                    'from_node': 'c',
                    'to_node': 'y',
                    'derivation_result': _make_derivation_result(edge_c_frames),
                },
            ],
            query_from_node='x',
            query_to_node='y',
            anchor_node='x',
        )

        dp = result['frames'][0]['data_points'][0]
        assert dp['x'] == 100
        assert dp['y'] == 35  # 20 + 15
        assert dp['rate'] == 0.35


class TestXNotAnchor:
    """When x ≠ a, denominator comes from x field, not a field."""

    def test_uses_x_field_when_not_anchor(self):
        # Edge x→y: x=60 (arrivals at x for the a-cohort), a=100
        frames = [
            _make_frame('2025-11-01', [_make_dp('2025-10-01', 60, 25, a=100)]),
        ]

        result = compose_path_maturity_frames(
            per_edge_results=[{
                'path_role': 'only',
                'from_node': 'x',
                'to_node': 'y',
                'derivation_result': _make_derivation_result(frames),
            }],
            query_from_node='x',
            query_to_node='y',
            anchor_node='a',  # x ≠ a
        )

        # Single-edge pass-through returns original frames
        dp = result['frames'][0]['data_points'][0]
        assert dp['x'] == 60
        assert dp['y'] == 25


class TestXEqualsAnchor:
    """When x = a, denominator uses anchor population."""

    def test_uses_a_pop_when_x_equals_a(self):
        first_frames = [
            _make_frame('2025-11-01', [_make_dp('2025-10-01', 100, 80, a=100)]),
        ]
        last_frames = [
            _make_frame('2025-11-01', [_make_dp('2025-10-01', 80, 30, a=100)]),
        ]

        result = compose_path_maturity_frames(
            per_edge_results=[
                {
                    'path_role': 'first',
                    'from_node': 'a',
                    'to_node': 'b',
                    'derivation_result': _make_derivation_result(first_frames),
                },
                {
                    'path_role': 'last',
                    'from_node': 'b',
                    'to_node': 'y',
                    'derivation_result': _make_derivation_result(last_frames),
                },
            ],
            query_from_node='a',
            query_to_node='y',
            anchor_node='a',
        )

        dp = result['frames'][0]['data_points'][0]
        # x = a_pop = 100
        assert dp['x'] == 100
        assert dp['a'] == 100
        assert dp['y'] == 30
        assert dp['rate'] == 0.3


class TestMultipleCohorts:
    """Multiple anchor_days compose correctly."""

    def test_multiple_cohorts_in_one_frame(self):
        first_frames = [
            _make_frame('2025-11-05', [
                _make_dp('2025-10-01', 100, 80, a=100),
                _make_dp('2025-10-02', 90, 70, a=90),
            ]),
        ]
        last_frames = [
            _make_frame('2025-11-05', [
                _make_dp('2025-10-01', 80, 30, a=100),
                _make_dp('2025-10-02', 70, 20, a=90),
            ]),
        ]

        result = compose_path_maturity_frames(
            per_edge_results=[
                {
                    'path_role': 'first',
                    'from_node': 'a',
                    'to_node': 'b',
                    'derivation_result': _make_derivation_result(first_frames),
                },
                {
                    'path_role': 'last',
                    'from_node': 'b',
                    'to_node': 'y',
                    'derivation_result': _make_derivation_result(last_frames),
                },
            ],
            query_from_node='a',
            query_to_node='y',
            anchor_node='a',
        )

        dps = result['frames'][0]['data_points']
        assert len(dps) == 2

        dp1 = next(d for d in dps if d['anchor_day'] == '2025-10-01')
        assert dp1['x'] == 100
        assert dp1['y'] == 30
        assert dp1['rate'] == 0.3

        dp2 = next(d for d in dps if d['anchor_day'] == '2025-10-02')
        assert dp2['x'] == 90
        assert dp2['y'] == 20
        assert dp2['rate'] == round(20 / 90, 6)


class TestNumeratorParityAcrossQueryStart:
    """On a→b→c, from(a).to(c) and from(b).to(c) must produce identical
    y values in composed evidence — the numerator is the same y-incident
    edge (b→c).  Only x (denominator) differs, subject to mass scaling.

    This is a structural invariant: the query start node affects the
    denominator but never the numerator.
    """

    def test_y_identical_x_differs(self):
        """from(a).to(c) and from(b).to(c) have same y, different x."""
        # Edge a→b: x=100 (anchor pop), y=80 (arrivals at b)
        ab_frames = [
            _make_frame('2025-11-01', [
                _make_dp('2025-10-01', 100, 80, a=100),
                _make_dp('2025-10-02', 90, 70, a=90),
            ]),
            _make_frame('2025-11-05', [
                _make_dp('2025-10-01', 100, 85, a=100),
                _make_dp('2025-10-02', 90, 75, a=90),
            ]),
        ]
        # Edge b→c: x=80, y=30 (conversions at c)
        bc_frames = [
            _make_frame('2025-11-01', [
                _make_dp('2025-10-01', 80, 30, a=100),
                _make_dp('2025-10-02', 70, 22, a=90),
            ]),
            _make_frame('2025-11-05', [
                _make_dp('2025-10-01', 85, 35, a=100),
                _make_dp('2025-10-02', 75, 28, a=90),
            ]),
        ]

        # ── from(a).to(c): two-edge span, x from a, y from b→c ──
        result_ac = compose_path_maturity_frames(
            per_edge_results=[
                {
                    'path_role': 'first',
                    'from_node': 'a',
                    'to_node': 'b',
                    'derivation_result': _make_derivation_result(ab_frames),
                },
                {
                    'path_role': 'last',
                    'from_node': 'b',
                    'to_node': 'c',
                    'derivation_result': _make_derivation_result(bc_frames),
                },
            ],
            query_from_node='a',
            query_to_node='c',
            anchor_node='a',
        )

        # ── from(b).to(c): single-edge, x from b→c, y from b→c ──
        result_bc = compose_path_maturity_frames(
            per_edge_results=[{
                'path_role': 'only',
                'from_node': 'b',
                'to_node': 'c',
                'derivation_result': _make_derivation_result(bc_frames),
            }],
            query_from_node='b',
            query_to_node='c',
            anchor_node='a',  # a is still the anchor
        )

        # Both should have the same number of frames
        assert len(result_ac['frames']) == len(result_bc['frames'])

        for f_ac, f_bc in zip(result_ac['frames'], result_bc['frames']):
            assert f_ac['snapshot_date'] == f_bc['snapshot_date']
            assert len(f_ac['data_points']) == len(f_bc['data_points'])

            for dp_ac, dp_bc in zip(f_ac['data_points'], f_bc['data_points']):
                assert dp_ac['anchor_day'] == dp_bc['anchor_day']

                # NUMERATOR PARITY: y values must be identical
                assert dp_ac['y'] == dp_bc['y'], \
                    f"y mismatch at {dp_ac['anchor_day']}: " \
                    f"from(a).to(c)={dp_ac['y']} vs from(b).to(c)={dp_bc['y']}"

                # DENOMINATOR DIFFERS: x values are different
                # from(a).to(c): x = a_pop (anchor population)
                # from(b).to(c): x = original b→c x field
                assert dp_ac['x'] != dp_bc['x'], \
                    f"x should differ at {dp_ac['anchor_day']}: both={dp_ac['x']}"

                # Mass scaling: rate × x ≈ y for both (within rounding)
                assert dp_ac['x'] > 0 and dp_bc['x'] > 0
                assert abs(dp_ac['rate'] * dp_ac['x'] - dp_bc['rate'] * dp_bc['x']) < 1e-3, \
                    f"y = rate × x should be equal: " \
                    f"ac={dp_ac['rate']}×{dp_ac['x']} vs bc={dp_bc['rate']}×{dp_bc['x']}"

    def test_y_identical_across_multiple_frames(self):
        """Verifies numerator parity holds across the full sweep range,
        not just a single frame snapshot."""
        # 3-frame sweep with growing y
        ab_frames = [
            _make_frame(f'2025-11-0{d}', [_make_dp('2025-10-01', 100, 60 + d * 5, a=100)])
            for d in range(1, 4)
        ]
        bc_frames = [
            _make_frame(f'2025-11-0{d}', [_make_dp('2025-10-01', 60 + d * 5, 10 + d * 3, a=100)])
            for d in range(1, 4)
        ]

        result_ac = compose_path_maturity_frames(
            per_edge_results=[
                {
                    'path_role': 'first',
                    'from_node': 'a',
                    'to_node': 'b',
                    'derivation_result': _make_derivation_result(ab_frames),
                },
                {
                    'path_role': 'last',
                    'from_node': 'b',
                    'to_node': 'c',
                    'derivation_result': _make_derivation_result(bc_frames),
                },
            ],
            query_from_node='a',
            query_to_node='c',
            anchor_node='a',
        )

        result_bc = compose_path_maturity_frames(
            per_edge_results=[{
                'path_role': 'only',
                'from_node': 'b',
                'to_node': 'c',
                'derivation_result': _make_derivation_result(bc_frames),
            }],
            query_from_node='b',
            query_to_node='c',
            anchor_node='a',
        )

        assert len(result_ac['frames']) == 3
        for f_ac, f_bc in zip(result_ac['frames'], result_bc['frames']):
            for dp_ac, dp_bc in zip(f_ac['data_points'], f_bc['data_points']):
                assert dp_ac['y'] == dp_bc['y']


class TestEmptyInput:
    """Empty inputs produce empty results."""

    def test_empty_per_edge_results(self):
        result = compose_path_maturity_frames(
            per_edge_results=[],
            query_from_node='x',
            query_to_node='y',
        )
        assert result['frames'] == []
        assert result['cohorts_analysed'] == 0
