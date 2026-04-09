"""Tests for span_upstream: Policy B upstream evidence extraction.

Key invariant: on a→b→c, extract_upstream_observations for x=b should
return the y values on edge a→b at each (anchor_day, tau) — these are
the observed arrivals at b that condition the ingress carrier model.

Cross-query invariant: for a→b→c,
  observations at b = y on edge a→b at each snapshot
  observations at c = y on edge b→c (summed for fan-in)
"""

import pytest
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from runner.span_upstream import extract_upstream_observations


def _make_graph(edges):
    """Build a minimal graph dict for testing."""
    node_ids = set()
    for e in edges:
        node_ids.add(e['from_id'])
        node_ids.add(e['to_id'])
    nodes = [{'id': nid, 'uuid': nid} for nid in node_ids]
    graph_edges = []
    for e in edges:
        graph_edges.append({
            'uuid': e['uuid'],
            'id': e['uuid'],
            'from': e['from_id'],
            'from_node': e['from_id'],
            'to': e['to_id'],
            'to_node': e['to_id'],
            'p': {'mean': e.get('p', 0.5)},
        })
    return {'nodes': nodes, 'edges': graph_edges}


def _make_frames(snapshot_dates, anchor_days_data):
    """Build evidence frames.

    Args:
        snapshot_dates: list of snapshot date strings
        anchor_days_data: dict mapping anchor_day → dict mapping
            snapshot_date → (x, y, a)
    """
    frames = []
    for sd in snapshot_dates:
        dps = []
        for ad, sd_vals in anchor_days_data.items():
            if sd in sd_vals:
                x, y, a = sd_vals[sd]
                dps.append({
                    'anchor_day': ad,
                    'x': x, 'y': y, 'a': a,
                    'rate': y / x if x > 0 else 0,
                })
        if dps:
            frames.append({
                'snapshot_date': sd,
                'data_points': dps,
                'total_y': sum(dp['y'] for dp in dps),
            })
    return frames


class TestSingleEdgeObservations:
    """a→b: observations at b should be y values on edge a→b."""

    def test_observations_equal_y_on_ab(self):
        graph = _make_graph([
            {'uuid': 'ab', 'from_id': 'a', 'to_id': 'b'},
        ])

        ab_frames = _make_frames(
            ['2025-10-06', '2025-10-11', '2025-10-16'],
            {
                '2025-10-01': {
                    '2025-10-06': (100, 40, 100),   # tau=5: 40 at b
                    '2025-10-11': (100, 65, 100),   # tau=10: 65 at b
                    '2025-10-16': (100, 78, 100),   # tau=15: 78 at b
                },
            },
        )

        result = extract_upstream_observations(
            graph=graph,
            anchor_node_id='a',
            x_node_id='b',
            per_edge_frames={'ab': ab_frames},
        )

        assert result is not None
        obs = result['2025-10-01']
        assert len(obs) == 3
        assert obs[0] == (5, 40.0)
        assert obs[1] == (10, 65.0)
        assert obs[2] == (15, 78.0)


class TestMultipleCohorts:
    """Multiple anchor_days produce separate observation lists."""

    def test_per_cohort_observations(self):
        graph = _make_graph([
            {'uuid': 'ab', 'from_id': 'a', 'to_id': 'b'},
        ])

        ab_frames = _make_frames(
            ['2025-10-06', '2025-10-11'],
            {
                '2025-10-01': {
                    '2025-10-06': (100, 42, 100),
                    '2025-10-11': (100, 67, 100),
                },
                '2025-10-02': {
                    '2025-10-06': (90, 38, 90),   # tau=4 for this cohort
                    '2025-10-11': (90, 60, 90),   # tau=9
                },
            },
        )

        result = extract_upstream_observations(
            graph=graph,
            anchor_node_id='a',
            x_node_id='b',
            per_edge_frames={'ab': ab_frames},
        )

        assert result is not None
        assert len(result) == 2

        c1 = result['2025-10-01']
        assert c1[0] == (5, 42.0)
        assert c1[1] == (10, 67.0)

        c2 = result['2025-10-02']
        assert c2[0] == (4, 38.0)
        assert c2[1] == (9, 60.0)


class TestFanInSumsAcrossEdges:
    """a→b, a→c, b→d, c→d: observations at d = y_bd + y_cd."""

    def test_join_sums_y(self):
        graph = _make_graph([
            {'uuid': 'ab', 'from_id': 'a', 'to_id': 'b'},
            {'uuid': 'ac', 'from_id': 'a', 'to_id': 'c'},
            {'uuid': 'bd', 'from_id': 'b', 'to_id': 'd'},
            {'uuid': 'cd', 'from_id': 'c', 'to_id': 'd'},
        ])

        bd_frames = _make_frames(
            ['2025-10-11'],
            {'2025-10-01': {'2025-10-11': (50, 20, 100)}},
        )
        cd_frames = _make_frames(
            ['2025-10-11'],
            {'2025-10-01': {'2025-10-11': (30, 12, 100)}},
        )

        result = extract_upstream_observations(
            graph=graph,
            anchor_node_id='a',
            x_node_id='d',
            per_edge_frames={
                'ab': _make_frames(['2025-10-11'], {'2025-10-01': {'2025-10-11': (100, 50, 100)}}),
                'ac': _make_frames(['2025-10-11'], {'2025-10-01': {'2025-10-11': (100, 30, 100)}}),
                'bd': bd_frames,
                'cd': cd_frames,
            },
        )

        assert result is not None
        obs = result['2025-10-01']
        # Observations at d = y_bd + y_cd = 20 + 12 = 32
        assert len(obs) == 1
        assert obs[0] == (10, 32.0)


class TestXEqualsAReturnsNone:
    """When x = a, no upstream observations needed."""

    def test_returns_none(self):
        graph = _make_graph([
            {'uuid': 'ab', 'from_id': 'a', 'to_id': 'b'},
        ])
        result = extract_upstream_observations(
            graph=graph,
            anchor_node_id='a',
            x_node_id='a',
            per_edge_frames={},
        )
        assert result is None


class TestNoEvidenceReturnsNone:
    """No evidence for incident edges → None."""

    def test_empty_frames(self):
        graph = _make_graph([
            {'uuid': 'ab', 'from_id': 'a', 'to_id': 'b'},
        ])
        result = extract_upstream_observations(
            graph=graph,
            anchor_node_id='a',
            x_node_id='b',
            per_edge_frames={'ab': []},
        )
        assert result is None

    def test_missing_edge(self):
        graph = _make_graph([
            {'uuid': 'ab', 'from_id': 'a', 'to_id': 'b'},
        ])
        result = extract_upstream_observations(
            graph=graph,
            anchor_node_id='a',
            x_node_id='b',
            per_edge_frames={},
        )
        assert result is None


class TestSparseEvidenceStillReturns:
    """Even one observation is useful for conditioning."""

    def test_single_snapshot(self):
        graph = _make_graph([
            {'uuid': 'ab', 'from_id': 'a', 'to_id': 'b'},
        ])

        ab_frames = _make_frames(
            ['2025-11-01'],
            {'2025-10-01': {'2025-11-01': (100, 55, 100)}},
        )

        result = extract_upstream_observations(
            graph=graph,
            anchor_node_id='a',
            x_node_id='b',
            per_edge_frames={'ab': ab_frames},
        )

        assert result is not None
        obs = result['2025-10-01']
        assert len(obs) == 1
        assert obs[0] == (31, 55.0)
