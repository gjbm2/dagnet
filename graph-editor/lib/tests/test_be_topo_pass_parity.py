"""
BE topo pass bounded-analytic contract.

Uses the enriched synth graph (synth-simple-abc) with Bayesian
model_vars, not the prod graph. Requires DB_CONNECTION (synth data
in the snapshot DB from synth_gen.py).

Tests:
1. Window-mode: topo pass completeness matches v2 annotation
2. Response exposes analytic fallback fields without a forecast_state payload
3. Response does not expose conditioned-only completeness uncertainty
4. Summary stays on analytic counters only
5. Scoped cohorts still control query-authored completeness
"""

import json
import math
import os
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '../../.env.local'))

import pytest

# Shared fixtures from conftest
from conftest import (
    load_candidate_regimes_by_mode,
    load_graph_json,
    requires_db,
    requires_data_repo,
    requires_synth,
)


def _load_graph():
    return load_graph_json('synth-simple-abc')


def _get_all_core_hashes(graph):
    """Get core_hash for every edge with snapshot data."""
    return {
        edge_uuid: candidates[0]['core_hash']
        for edge_uuid, candidates in load_candidate_regimes_by_mode('synth-simple-abc').items()
        if candidates
    }


@requires_db
@requires_data_repo
@requires_synth("synth-simple-abc", enriched=True)
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

    def test_bounded_response_omits_completeness_stdev(self):
        """Bounded analytic topo pass does not emit CF-style completeness
        uncertainty. That scalar belongs to the conditioned forecast pass.
        """
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
                assert 'completeness_stdev' not in er, (
                    'Bounded topo pass should not emit completeness_stdev; '
                    'that conditioned uncertainty belongs to CF.'
                )
                break

    # NOTE: cohort-mode handler-level parity test removed.
    # The Phase 3 cohort parity is now covered by
    # TestPhase3ParityEnrichedSynth in test_forecast_state_cohort.py
    # (5 tests, exercises engine functions directly on enriched
    # synth-simple-abc, no handler/DB dependency).

    def test_analytic_fields_in_topo_pass_response(self):
        """Topo pass response writes analytic fallback fields only."""
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
                # Analytic fallback values written to existing flat fields
                assert 'completeness' in er
                assert er['completeness'] is not None
                assert 'blended_mean' in er
                assert 'p_sd' in er
                assert 'completeness_stdev' not in er
                # No separate forecast_state object or tail metadata.
                assert 'forecast_state' not in er, \
                    'forecast_state should not be in response — engine writes to existing fields'
                print(f"\nAnalytic fields: completeness={er['completeness']:.4f}, "
                      f"blended={er['blended_mean']}, p_sd={er['p_sd']}")
                break

    def test_summary_exposes_only_analytic_counters(self):
        """Response summary stays on analytic topo counters only."""
        graph = _load_graph()

        from api_handlers import handle_stats_topo_pass

        result = handle_stats_topo_pass({
            'graph': graph,
            'cohort_data': {},
            'edge_contexts': {},
            'forecasting_settings': None,
            'query_mode': 'none',
        })

        assert 'edges_processed' in result['summary']
        assert 'edges_with_lag' in result['summary']
        assert 'forecast_state_count' not in result['summary']
        assert 'forecast_state_ms' not in result['summary']

    def test_analytic_path_uses_scoped_cohorts_over_raw(self):
        """When edge_contexts provides scoped_cohorts, the analytic path uses
        them instead of raw cohort_data for query-authored completeness.

        Scenario: raw cohort_data has a young cohort (age=5, low
        completeness) and a mature cohort (age=200, high completeness).
        scoped_cohorts has only the mature cohort. If the analytic path uses
        scoped_cohorts, the n-weighted completeness will be high
        (mature only). If it uses raw, the young cohort drags it down.

        Uses the enriched synth graph so the stats engine produces
        EdgeLAGValues (required for the engine step to run).
        """
        graph = _load_graph()

        target = None
        for edge in graph['edges']:
            lat = edge.get('p', {}).get('latency', {})
            if lat.get('mu') and lat.get('sigma'):
                target = edge
                break
        assert target is not None, 'No latency edge found'
        uuid = target['uuid']

        # Raw cohort_data: young (age=5) + mature (age=200)
        # Both sets must produce a valid lag fit for the stats engine.
        raw_cohorts = [
            {'date': '2026-01-01', 'age': 5, 'n': 100, 'k': 10,
             'median_lag_days': 5, 'mean_lag_days': 5},
            {'date': '2025-09-01', 'age': 200, 'n': 100, 'k': 70,
             'median_lag_days': 20, 'mean_lag_days': 25},
        ]

        # Scoped: mature only (age=200)
        scoped_cohorts = [
            {'date': '2025-09-01', 'age': 200, 'n': 100, 'k': 70,
             'median_lag_days': 20, 'mean_lag_days': 25},
        ]

        from api_handlers import handle_stats_topo_pass

        # Run WITH scoped_cohorts
        result_scoped = handle_stats_topo_pass({
            'graph': graph,
            'cohort_data': {uuid: raw_cohorts},
            'edge_contexts': {uuid: {
                'scoped_cohorts': scoped_cohorts,
            }},
            'forecasting_settings': None,
            'query_mode': 'none',
        })

        # Run WITHOUT scoped_cohorts (falls back to raw)
        result_raw = handle_stats_topo_pass({
            'graph': graph,
            'cohort_data': {uuid: raw_cohorts},
            'edge_contexts': {},
            'forecasting_settings': None,
            'query_mode': 'none',
        })

        c_scoped = None
        c_raw = None
        for er in result_scoped['edges']:
            if er['edge_uuid'] == uuid:
                c_scoped = er.get('completeness')
                break
        for er in result_raw['edges']:
            if er['edge_uuid'] == uuid:
                c_raw = er.get('completeness')
                break

        assert c_scoped is not None, \
            f"No completeness from scoped run. Edges returned: " \
            f"{[e['edge_uuid'] for e in result_scoped['edges']]}"
        assert c_raw is not None, \
            f"No completeness from raw run. Edges returned: " \
            f"{[e['edge_uuid'] for e in result_raw['edges']]}"

        # Scoped (mature only) must have higher completeness than raw
        # (which includes the young cohort dragging the average down)
        print(f"\nScoped cohorts test:")
        print(f"  completeness (scoped, mature only): {c_scoped:.4f}")
        print(f"  completeness (raw, young+mature):   {c_raw:.4f}")
        assert c_scoped > c_raw, \
            f"Scoped completeness ({c_scoped:.4f}) should be > raw ({c_raw:.4f}). " \
            f"Analytic path may not be using scoped_cohorts."
