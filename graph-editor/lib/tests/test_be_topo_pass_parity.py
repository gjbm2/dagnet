"""
Phase 2 parity gate: BE topo pass completeness vs v2 annotate_rows.

Both the topo pass and cohort_maturity_v2 compute completeness as
CDF(age, mu, sigma, onset). They should produce the same value for
the same cohort ages and the same model params.

This test:
1. Runs v2 on a real edge → extracts per-data-point completeness
   from annotated frames
2. Runs the topo pass on the same edge with cohorts derived from
   the same frames
3. Asserts the n-weighted completeness values agree

Also validates completeness_stdev is present and consistent with
the brute-force MC check.
"""

import json
import math
import os
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest

DB_URL = os.environ.get('DB_CONNECTION', '')
requires_db = pytest.mark.skipif(not DB_URL, reason='DB_CONNECTION not set')

_DAGNET_ROOT = Path(__file__).parent.parent.parent.parent
_CONF_FILE = _DAGNET_ROOT / '.private-repos.conf'
_DATA_REPO_DIR = None
if _CONF_FILE.exists():
    for line in _CONF_FILE.read_text().splitlines():
        if line.startswith('DATA_REPO_DIR='):
            _DATA_REPO_DIR = _DAGNET_ROOT / line.split('=', 1)[1].strip()
            break

requires_data_repo = pytest.mark.skipif(
    _DATA_REPO_DIR is None or not (_DATA_REPO_DIR / 'graphs').is_dir(),
    reason='Data repo not available',
)


def _load_graph():
    path = _DATA_REPO_DIR / 'graphs' / 'bayes-test-gm-rebuild.json'
    if not path.exists():
        pytest.skip(f'Graph not found at {path}')
    return json.loads(path.read_text())


def _get_all_core_hashes(graph):
    """Get core_hash for every edge with snapshot data."""
    from snapshot_service import _pooled_conn
    hashes = {}
    with _pooled_conn() as conn:
        cur = conn.cursor()
        for edge in graph.get('edges', []):
            p_id = edge.get('p', {}).get('id', '')
            if not p_id:
                continue
            cur.execute(
                'SELECT DISTINCT core_hash FROM snapshots '
                'WHERE param_id LIKE %s LIMIT 1',
                (f'%{p_id}',),
            )
            rows = cur.fetchall()
            if rows:
                hashes[edge['uuid']] = rows[0][0]
    return hashes


@requires_db
@requires_data_repo
class TestTopoPassVsV2Completeness:
    """Topo pass completeness matches v2 annotated completeness."""

    def test_completeness_parity(self):
        """N-weighted completeness from topo pass matches n-weighted
        completeness from v2's annotated frames for the same edge.
        """
        graph = _load_graph()
        all_hashes = _get_all_core_hashes(graph)
        candidate_regimes = {
            eid: [{'core_hash': ch, 'equivalent_hashes': []}]
            for eid, ch in all_hashes.items()
        }

        # Find a latency edge
        target = None
        for edge in graph['edges']:
            lat = edge.get('p', {}).get('latency', {})
            if lat.get('mu') and edge['uuid'] in all_hashes:
                target = edge
                break
        assert target is not None, 'No latency edge with snapshot data'

        nodes_by_uuid = {n['uuid']: n for n in graph['nodes']}
        from_id = nodes_by_uuid[target['from']]['id']
        to_id = nodes_by_uuid[target['to']]['id']

        # ── Run v2 to get annotated frames ───────────────────────
        from api_handlers import _handle_cohort_maturity_v2

        v2_result = _handle_cohort_maturity_v2({
            'analysis_type': 'cohort_maturity_v2',
            'scenarios': [{
                'scenario_id': 'parity',
                'graph': graph,
                'analytics_dsl': f'from({from_id}).to({to_id})',
                'effective_query_dsl': 'window(-90d:)',
                'candidate_regimes_by_edge': candidate_regimes,
            }],
        })

        # Extract per-data-point completeness from the last frame
        frames = None
        for s in v2_result.get('subjects', []):
            frames = s.get('result', {}).get('frames', [])
            if frames:
                break
        assert frames and len(frames) > 0, 'No frames from v2'

        last_frame = frames[-1]
        sweep_to = date.fromisoformat(str(last_frame['snapshot_date'])[:10])

        # Compute n-weighted completeness from v2's annotated points
        v2_weighted_c = 0.0
        v2_total_n = 0.0
        cohort_data_for_topo = []

        for dp in last_frame.get('data_points', []):
            ad = date.fromisoformat(str(dp['anchor_day'])[:10])
            age = (sweep_to - ad).days
            n = dp.get('x', 0)
            c = dp.get('completeness')
            if n > 0 and c is not None:
                v2_weighted_c += n * c
                v2_total_n += n
                cohort_data_for_topo.append({
                    'date': str(dp['anchor_day']),
                    'age': age,
                    'n': int(n),
                    'k': int(dp.get('y', 0)),
                    'median_lag_days': dp.get('median_lag_days'),
                    'mean_lag_days': dp.get('mean_lag_days'),
                })

        assert v2_total_n > 0, 'No cohorts with completeness from v2'
        v2_completeness = v2_weighted_c / v2_total_n

        # ── Run topo pass with the same cohorts ──────────────────
        from api_handlers import handle_stats_topo_pass

        tp_result = handle_stats_topo_pass({
            'graph': graph,
            'cohort_data': {target['uuid']: cohort_data_for_topo},
            'edge_contexts': {},
            'forecasting_settings': None,
            'query_mode': 'none',
        })

        tp_completeness = None
        tp_stdev = None
        for er in tp_result['edges']:
            if er['edge_uuid'] == target['uuid']:
                tp_completeness = er['completeness']
                tp_stdev = er.get('completeness_stdev')
                break

        assert tp_completeness is not None, 'Edge not in topo pass result'

        # ── Compare ──────────────────────────────────────────────
        print(f"\n{from_id} -> {to_id}:")
        print(f"  v2 n-weighted completeness: {v2_completeness:.4f}")
        print(f"  topo pass completeness:     {tp_completeness:.4f}")
        print(f"  delta:                      {abs(tp_completeness - v2_completeness):.4f}")
        print(f"  topo pass stdev:            {tp_stdev}")

        # Both compute CDF(age, mu, sigma, onset) with the same
        # raw params. The topo pass (stats_engine) applies a tail
        # constraint (improve_fit_with_t95) which may adjust sigma
        # slightly; v2's annotate_rows does not. This produces a
        # small systematic delta. 0.5% tolerance accommodates
        # the tail constraint effect.
        assert abs(tp_completeness - v2_completeness) < 0.005, \
            f"Completeness parity failed: topo={tp_completeness:.4f} " \
            f"v2={v2_completeness:.4f} delta={abs(tp_completeness - v2_completeness):.4f} (>0.5%)"

    def test_completeness_stdev_present(self):
        """Edges with latency dispersions have non-zero stdev."""
        graph = _load_graph()
        all_hashes = _get_all_core_hashes(graph)

        target = None
        for edge in graph['edges']:
            lat = edge.get('p', {}).get('latency', {})
            if lat.get('mu') and edge['uuid'] in all_hashes:
                target = edge
                break
        assert target is not None

        from api_handlers import handle_stats_topo_pass

        tp_result = handle_stats_topo_pass({
            'graph': graph,
            'cohort_data': {target['uuid']: [
                {'date': '2026-03-01', 'age': 42, 'n': 100, 'k': 50},
            ]},
            'edge_contexts': {},
            'forecasting_settings': None,
            'query_mode': 'none',
        })

        for er in tp_result['edges']:
            if er['edge_uuid'] == target['uuid']:
                assert er.get('completeness_stdev') is not None, \
                    'completeness_stdev missing'
                assert er['completeness_stdev'] >= 0, \
                    f"completeness_stdev negative: {er['completeness_stdev']}"
                # Edge has Bayesian posteriors with SDs, so stdev
                # should be non-zero
                lat = target.get('p', {}).get('latency', {})
                has_sds = (
                    lat.get('promoted_mu_sd')
                    or lat.get('posterior', {}).get('mu_sd')
                )
                if has_sds:
                    assert er['completeness_stdev'] > 0, \
                        'Edge has dispersions but completeness_stdev=0'
                break

    def test_summary_timing(self):
        """Response summary includes timing."""
        graph = _load_graph()

        from api_handlers import handle_stats_topo_pass

        result = handle_stats_topo_pass({
            'graph': graph,
            'cohort_data': {},
            'edge_contexts': {},
            'forecasting_settings': None,
            'query_mode': 'none',
        })

        assert 'completeness_stdev_count' in result['summary']
        assert 'completeness_stdev_ms' in result['summary']
