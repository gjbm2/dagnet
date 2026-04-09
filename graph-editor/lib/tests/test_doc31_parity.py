"""
Doc 31 Parity Test — Old Path vs New Path

Calls _handle_snapshot_analyze_subjects with both:
  (A) Old path: pre-resolved snapshot_subjects (as the FE currently sends)
  (B) New path: analytics_dsl + candidate_regimes_by_edge (doc 31)

Asserts identical analysis output.

Requires: DB_CONNECTION environment variable (real snapshot DB).
Uses: real graph from data repo, real hashes, real DB rows.

Run with:
  DB_CONNECTION="postgresql://..." pytest lib/tests/test_doc31_parity.py -v
"""

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest

DB_URL = os.environ.get('DB_CONNECTION', '')
requires_db = pytest.mark.skipif(not DB_URL, reason='DB_CONNECTION not set')

# Resolve data repo path from .private-repos.conf
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


def _load_graph(name: str) -> dict:
    """Load a real graph JSON from the data repo."""
    path = _DATA_REPO_DIR / 'graphs' / f'{name}.json'
    if not path.exists():
        pytest.skip(f'Graph {name} not found at {path}')
    with open(path) as f:
        return json.load(f)


def _find_adjacent_edge(graph: dict) -> tuple:
    """Find the first edge with a parameter ID and return (from_node_id, to_node_id, edge)."""
    nodes_by_uuid = {n['uuid']: n for n in graph['nodes']}
    for edge in graph['edges']:
        p_id = edge.get('p', {}).get('id')
        if not p_id:
            continue
        from_node = nodes_by_uuid.get(edge['from'])
        to_node = nodes_by_uuid.get(edge['to'])
        if from_node and to_node:
            return (from_node['id'], to_node['id'], edge)
    pytest.skip('No edge with parameter ID found in graph')


def _build_old_path_request(graph: dict, from_id: str, to_id: str, edge: dict,
                             analysis_type: str, query_dsl: str) -> dict:
    """Build a request using the old path (pre-resolved snapshot_subjects).

    This mimics what the FE currently sends: a snapshot_subjects array
    with param_id, core_hash, read_mode, time bounds, etc.
    """
    p_id = edge['p']['id']
    edge_uuid = edge['uuid']

    # Query the DB directly for rows matching this parameter's object ID.
    # The real param_id format is "${owner}/${repo}-${branch}-${objectId}".
    from snapshot_service import _pooled_conn
    with _pooled_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT DISTINCT core_hash, param_id
            FROM snapshots
            WHERE param_id LIKE %s
            LIMIT 5
        """, (f'%{p_id}',))
        rows = cur.fetchall()

    if not rows:
        pytest.skip(f'No snapshot data found for parameter {p_id}')

    real_core_hash = rows[0][0]
    real_param_id = rows[0][1]

    # Determine read_mode and time bounds from analysis type
    read_mode_map = {
        'cohort_maturity': 'cohort_maturity',
        'daily_conversions': 'raw_snapshots',
        'lag_histogram': 'raw_snapshots',
        'lag_fit': 'sweep_simple',
        'surprise_gauge': 'sweep_simple',
    }
    read_mode = read_mode_map.get(analysis_type, 'raw_snapshots')

    # Parse time bounds from the query DSL
    import re
    anchor_from = '2026-01-08'
    anchor_to = '2026-04-08'
    m = re.search(r'(?:window|cohort)\(([^:]*):([^)]*)\)', query_dsl)
    if m:
        from analysis_subject_resolution import _resolve_date
        anchor_from = _resolve_date(m.group(1))
        anchor_to = _resolve_date(m.group(2))

    subject = {
        'subject_id': f'parity-old:{edge_uuid}:0',
        'param_id': real_param_id,
        'core_hash': real_core_hash,
        'canonical_signature': '',
        'read_mode': read_mode,
        'anchor_from': anchor_from,
        'anchor_to': anchor_to,
        'slice_keys': [''],
        'equivalent_hashes': [],
        'target': {'targetId': edge_uuid},
    }
    if read_mode in ('cohort_maturity', 'sweep_simple'):
        subject['sweep_from'] = anchor_from
        subject['sweep_to'] = anchor_to

    return {
        'scenarios': [{
            'scenario_id': 'parity-test',
            'name': 'Parity Test',
            'colour': '#3b82f6',
            'visibility_mode': 'f+e',
            'graph': graph,
            'snapshot_subjects': [subject],
        }],
        'query_dsl': query_dsl,
        'analysis_type': analysis_type,
    }


def _build_new_path_request(graph: dict, from_id: str, to_id: str, edge: dict,
                             analysis_type: str, query_dsl: str,
                             old_request: dict) -> dict:
    """Build a request using the new path (analytics_dsl + candidate_regimes_by_edge).

    Uses the same core_hash from the old request's snapshot_subjects to build
    candidate regimes, ensuring both paths query the same DB data.
    """
    old_subj = old_request['scenarios'][0]['snapshot_subjects'][0]
    real_core_hash = old_subj['core_hash']

    # Build candidate_regimes_by_edge with the real hash for the test edge
    candidate_regimes_by_edge = {
        edge['uuid']: [
            {'core_hash': real_core_hash, 'equivalent_hashes': []},
        ],
    }

    analytics_dsl = f'from({from_id}).to({to_id})'

    # Extract temporal clause (window(...) or cohort(...)) from the full
    # query_dsl so the handler receives it as effective_query_dsl — this
    # mirrors what the FE sends on the new path.
    import re
    temporal_match = re.search(r'((?:window|cohort)\([^)]*\))', query_dsl)
    effective_query_dsl = temporal_match.group(1) if temporal_match else ''

    return {
        'scenarios': [{
            'scenario_id': 'parity-test',
            'name': 'Parity Test',
            'colour': '#3b82f6',
            'visibility_mode': 'f+e',
            'graph': graph,
            'analytics_dsl': analytics_dsl,
            'effective_query_dsl': effective_query_dsl,
            'candidate_regimes_by_edge': candidate_regimes_by_edge,
        }],
        'query_dsl': query_dsl,
        'analysis_type': analysis_type,
    }


def _compare_results(old_result: dict, new_result: dict, analysis_type: str):
    """Assert that old and new path results are equivalent.

    Compares: success flag, number of scenario results, per-subject
    result keys, row counts, and numeric values (within tolerance).

    CRITICAL: asserts that the new path result has the SAME KEYS as the
    old path result. This catches structural mismatches that would cause
    the FE normalisation to fail (e.g. missing maturity_rows).
    """
    assert old_result.get('success') == new_result.get('success'), \
        f"success mismatch: old={old_result.get('success')} new={new_result.get('success')}"

    old_scenarios = old_result.get('scenarios', [])
    new_scenarios = new_result.get('scenarios', [])
    assert len(old_scenarios) == len(new_scenarios), \
        f"scenario count mismatch: old={len(old_scenarios)} new={len(new_scenarios)}"

    for i, (old_sc, new_sc) in enumerate(zip(old_scenarios, new_scenarios)):
        old_subjects = old_sc.get('subjects', [])
        new_subjects = new_sc.get('subjects', [])
        assert len(old_subjects) == len(new_subjects), \
            f"scenario {i}: subject count mismatch: old={len(old_subjects)} new={len(new_subjects)}"

        for j, (old_s, new_s) in enumerate(zip(old_subjects, new_subjects)):
            old_ok = old_s.get('success', False)
            new_ok = new_s.get('success', False)
            assert old_ok == new_ok, \
                f"scenario {i} subject {j}: success mismatch: old={old_ok} new={new_ok}"

            if not old_ok:
                continue

            old_r = old_s.get('result', {})
            new_r = new_s.get('result', {})

            # STRUCTURAL PARITY: every key in the old result must exist in
            # the new result. This catches missing maturity_rows, model_curve,
            # etc. that would break FE normalisation.
            old_keys = set(old_r.keys())
            new_keys = set(new_r.keys())
            missing = old_keys - new_keys
            assert not missing, \
                f"scenario {i} subject {j}: new result missing keys: {missing}. " \
                f"Old keys: {sorted(old_keys)}. New keys: {sorted(new_keys)}"

            # Compare frames for cohort_maturity
            if analysis_type == 'cohort_maturity':
                old_frames = old_r.get('frames', [])
                new_frames = new_r.get('frames', [])
                assert len(old_frames) == len(new_frames), \
                    f"scenario {i} subject {j}: frame count mismatch: old={len(old_frames)} new={len(new_frames)}"
                for k, (of, nf) in enumerate(zip(old_frames, new_frames)):
                    assert of.get('snapshot_date') == nf.get('snapshot_date'), \
                        f"frame {k}: snapshot_date mismatch"
                    old_pts = of.get('data_points', [])
                    new_pts = nf.get('data_points', [])
                    assert len(old_pts) == len(new_pts), \
                        f"frame {k}: data_points count mismatch: old={len(old_pts)} new={len(new_pts)}"
                    for m, (op, np_) in enumerate(zip(old_pts, new_pts)):
                        assert op.get('anchor_day') == np_.get('anchor_day'), \
                            f"frame {k} point {m}: anchor_day mismatch"
                        for field in ('x', 'y', 'a', 'rate'):
                            ov = op.get(field, 0)
                            nv = np_.get(field, 0)
                            if isinstance(ov, (int, float)) and isinstance(nv, (int, float)):
                                assert abs(ov - nv) < 1e-6, \
                                    f"frame {k} point {m}: {field} mismatch: old={ov} new={nv}"

            # Compare maturity_rows if present
            old_rows = old_r.get('maturity_rows', [])
            new_rows = new_r.get('maturity_rows', [])
            if old_rows or new_rows:
                assert len(old_rows) == len(new_rows), \
                    f"scenario {i} subject {j}: maturity_rows count mismatch: old={len(old_rows)} new={len(new_rows)}"
                for k, (orow, nrow) in enumerate(zip(old_rows, new_rows)):
                    assert orow.get('tau_days') == nrow.get('tau_days'), \
                        f"maturity_row {k}: tau_days mismatch"
                    for field in ('rate', 'midpoint', 'fan_upper', 'fan_lower'):
                        ov = orow.get(field)
                        nv = nrow.get(field)
                        if ov is not None and nv is not None:
                            assert abs(float(ov) - float(nv)) < 1e-6, \
                                f"maturity_row {k}: {field} mismatch: old={ov} new={nv}"

            # Compare rate_by_cohort for daily_conversions
            if analysis_type == 'daily_conversions':
                old_rates = old_r.get('rate_by_cohort', [])
                new_rates = new_r.get('rate_by_cohort', [])
                assert len(old_rates) == len(new_rates), \
                    f"scenario {i} subject {j}: rate_by_cohort count mismatch: old={len(old_rates)} new={len(new_rates)}"


# ============================================================
# Test cases — one per analysis type
# ============================================================

GRAPH_NAME = 'high-intent-flow-v2'


@requires_db
@requires_data_repo
class TestCohortMaturityParity:
    """Old path and new path produce identical cohort maturity output."""

    def test_single_edge_cohort_maturity(self):
        graph = _load_graph(GRAPH_NAME)
        from_id, to_id, edge = _find_adjacent_edge(graph)
        query_dsl = f'from({from_id}).to({to_id}).cohort(-90d:)'

        from api_handlers import _handle_snapshot_analyze_subjects

        old_req = _build_old_path_request(graph, from_id, to_id, edge, 'cohort_maturity', query_dsl)
        old_result = _handle_snapshot_analyze_subjects(old_req)

        new_req = _build_new_path_request(graph, from_id, to_id, edge, 'cohort_maturity', query_dsl, old_req)
        new_result = _handle_snapshot_analyze_subjects(new_req)

        # Assert maturity_rows present in BOTH paths
        for label, res in [('OLD', old_result), ('NEW', new_result)]:
            for sc in res.get('scenarios', []):
                for subj in sc.get('subjects', []):
                    r = subj.get('result', {})
                    if subj.get('success') and r.get('frames'):
                        assert 'maturity_rows' in r, \
                            f"[{label}] maturity_rows MISSING. " \
                            f"sid={subj.get('subject_id', '?')[:50]} keys={sorted(r.keys())}"
                        assert len(r['maturity_rows']) > 0, \
                            f"[{label}] maturity_rows EMPTY. sid={subj.get('subject_id', '?')[:50]}"

        # Save both responses as JSON fixtures for the TS normalisation test
        import json
        fixtures_dir = Path(__file__).parent / 'fixtures'
        fixtures_dir.mkdir(exist_ok=True)
        with open(fixtures_dir / 'doc31_parity_old_response.json', 'w') as f:
            json.dump(old_result, f, default=str)
        with open(fixtures_dir / 'doc31_parity_new_response.json', 'w') as f:
            json.dump(new_result, f, default=str)

        _compare_results(old_result, new_result, 'cohort_maturity')


@requires_db
@requires_data_repo
class TestCohortMaturityV1V2Parity:
    """v1 (cohort_maturity) and v2 (cohort_maturity_v2) produce identical
    single-edge output — the Phase A acceptance gate.

    Sends the same single-edge from(x).to(y) query to both analysis types
    via handle_runner_analyze and compares maturity_rows field-by-field.
    For single-edge spans, v2's span kernel degenerates to the single-edge
    parametric case, so output must be identical within float tolerance.
    """

    def _run_analysis(self, graph, from_id, to_id, edge, analysis_type, query_dsl):
        """Build a new-path request and run it through the top-level dispatcher."""
        from api_handlers import handle_runner_analyze

        # Build the new-path request (analytics_dsl + candidate_regimes_by_edge)
        # so both v1 and v2 take the same code path for subject resolution.
        old_req = _build_old_path_request(graph, from_id, to_id, edge, analysis_type, query_dsl)
        req = _build_new_path_request(graph, from_id, to_id, edge, analysis_type, query_dsl, old_req)
        return handle_runner_analyze(req)

    def _extract_maturity_rows(self, result, label):
        """Extract maturity_rows from a handler result, asserting non-empty."""
        # Result may be wrapped in scenarios or flat (single-scenario unwrap)
        scenarios = result.get('scenarios', [result] if 'subjects' in result else [])
        assert len(scenarios) > 0, f"[{label}] no scenarios in result"
        for sc in scenarios:
            for subj in sc.get('subjects', []):
                if subj.get('success'):
                    r = subj.get('result', {})
                    rows = r.get('maturity_rows', [])
                    assert len(rows) > 0, \
                        f"[{label}] maturity_rows empty. keys={sorted(r.keys())}"
                    return rows
        pytest.fail(f"[{label}] no successful subject with maturity_rows")

    def test_single_edge_cohort_mode_parity(self):
        """Cohort mode: v1 and v2 produce identical maturity_rows."""
        graph = _load_graph(GRAPH_NAME)
        from_id, to_id, edge = _find_adjacent_edge(graph)
        query_dsl = f'from({from_id}).to({to_id}).cohort(-90d:)'

        v1_result = self._run_analysis(graph, from_id, to_id, edge, 'cohort_maturity', query_dsl)
        v2_result = self._run_analysis(graph, from_id, to_id, edge, 'cohort_maturity_v2', query_dsl)

        v1_rows = self._extract_maturity_rows(v1_result, 'v1')
        v2_rows = self._extract_maturity_rows(v2_result, 'v2')

        assert len(v1_rows) == len(v2_rows), \
            f"maturity_rows count: v1={len(v1_rows)} v2={len(v2_rows)}"

        for i, (r1, r2) in enumerate(zip(v1_rows, v2_rows)):
            assert r1.get('tau_days') == r2.get('tau_days'), \
                f"row {i}: tau_days v1={r1.get('tau_days')} v2={r2.get('tau_days')}"
            for field in ('rate', 'midpoint', 'fan_upper', 'fan_lower',
                          'projected_rate', 'projected_fan_upper', 'projected_fan_lower'):
                ov = r1.get(field)
                nv = r2.get(field)
                if ov is None and nv is None:
                    continue
                if ov is None or nv is None:
                    # Allow v2 to have projected_rate when v1 doesn't
                    # (v2 reads stats-pass model vars even without posteriors)
                    if field.startswith('projected_') and ov is None:
                        continue
                    assert False, \
                        f"row {i}: {field} presence mismatch v1={ov} v2={nv}"
                assert abs(float(ov) - float(nv)) < 1e-6, \
                    f"row {i}: {field} v1={ov} v2={nv} diff={abs(float(ov)-float(nv))}"

    def test_single_edge_window_mode_parity(self):
        """Window mode: v1 and v2 produce identical maturity_rows."""
        graph = _load_graph(GRAPH_NAME)
        from_id, to_id, edge = _find_adjacent_edge(graph)
        query_dsl = f'from({from_id}).to({to_id}).window(-90d:)'

        v1_result = self._run_analysis(graph, from_id, to_id, edge, 'cohort_maturity', query_dsl)
        v2_result = self._run_analysis(graph, from_id, to_id, edge, 'cohort_maturity_v2', query_dsl)

        v1_rows = self._extract_maturity_rows(v1_result, 'v1')
        v2_rows = self._extract_maturity_rows(v2_result, 'v2')

        assert len(v1_rows) == len(v2_rows), \
            f"maturity_rows count: v1={len(v1_rows)} v2={len(v2_rows)}"

        for i, (r1, r2) in enumerate(zip(v1_rows, v2_rows)):
            assert r1.get('tau_days') == r2.get('tau_days'), \
                f"row {i}: tau_days v1={r1.get('tau_days')} v2={r2.get('tau_days')}"
            for field in ('rate', 'midpoint', 'fan_upper', 'fan_lower',
                          'projected_rate', 'projected_fan_upper', 'projected_fan_lower'):
                ov = r1.get(field)
                nv = r2.get(field)
                if ov is None and nv is None:
                    continue
                if ov is None or nv is None:
                    if field.startswith('projected_') and ov is None:
                        continue
                    assert False, \
                        f"row {i}: {field} presence mismatch v1={ov} v2={nv}"
                assert abs(float(ov) - float(nv)) < 1e-6, \
                    f"row {i}: {field} v1={ov} v2={nv} diff={abs(float(ov)-float(nv))}"


@requires_db
@requires_data_repo
class TestDailyConversionsParity:
    """Old path and new path produce identical daily conversions output."""

    def test_single_edge_daily_conversions(self):
        graph = _load_graph(GRAPH_NAME)
        from_id, to_id, edge = _find_adjacent_edge(graph)
        query_dsl = f'from({from_id}).to({to_id}).window(-90d:)'

        from api_handlers import _handle_snapshot_analyze_subjects

        old_req = _build_old_path_request(graph, from_id, to_id, edge, 'daily_conversions', query_dsl)
        old_result = _handle_snapshot_analyze_subjects(old_req)

        new_req = _build_new_path_request(graph, from_id, to_id, edge, 'daily_conversions', query_dsl, old_req)
        new_result = _handle_snapshot_analyze_subjects(new_req)

        _compare_results(old_result, new_result, 'daily_conversions')


@requires_db
@requires_data_repo
class TestLagHistogramParity:
    """Old path and new path produce identical lag histogram output."""

    def test_single_edge_lag_histogram(self):
        graph = _load_graph(GRAPH_NAME)
        from_id, to_id, edge = _find_adjacent_edge(graph)
        query_dsl = f'from({from_id}).to({to_id}).window(-90d:)'

        from api_handlers import _handle_snapshot_analyze_subjects

        old_req = _build_old_path_request(graph, from_id, to_id, edge, 'lag_histogram', query_dsl)
        old_result = _handle_snapshot_analyze_subjects(old_req)

        new_req = _build_new_path_request(graph, from_id, to_id, edge, 'lag_histogram', query_dsl, old_req)
        new_result = _handle_snapshot_analyze_subjects(new_req)

        _compare_results(old_result, new_result, 'lag_histogram')
