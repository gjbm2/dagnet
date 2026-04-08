"""
Analysis Request Contract Tests

Tests the BE's handling of the analysis request contract:
1. Standard runner reads analytics_dsl from top level for subject resolution
2. Snapshot handler composes analytics_dsl + effective_query_dsl correctly
3. Per-scenario candidate_regimes_by_edge are used independently

These tests use handle_runner_analyze directly (no HTTP server needed).
"""
import pytest
from typing import Any, Dict


def _make_graph() -> Dict[str, Any]:
    """Minimal graph with entry → middle → absorbing."""
    return {
        'nodes': [
            {'uuid': 'n1', 'id': 'entry-node', 'label': 'Entry', 'entry': {'is_start': True}},
            {'uuid': 'n2', 'id': 'middle-node', 'label': 'Middle'},
            {'uuid': 'n3', 'id': 'switch-success', 'label': 'Switch success', 'absorbing': True},
            {'uuid': 'n4', 'id': 'other-end', 'label': 'Other end', 'absorbing': True},
        ],
        'edges': [
            {'uuid': 'e1', 'from': 'n1', 'to': 'n2', 'p': {'mean': 0.6}},
            {'uuid': 'e2', 'from': 'n2', 'to': 'n3', 'p': {'mean': 0.8}},
            {'uuid': 'e3', 'from': 'n1', 'to': 'n4', 'p': {'mean': 0.4}},
        ],
        'policies': {'default_outcome': 'end'},
        'metadata': {'version': '1.0.0'},
    }


class TestStandardRunnerWithAnalyticsDsl:
    """Standard runner (graph-only types) should accept top-level analytics_dsl."""

    def test_bridge_view_with_top_level_analytics_dsl(self):
        """bridge_view with analytics_dsl at top level, no query_dsl."""
        from api_handlers import handle_runner_analyze

        graph = _make_graph()
        data = {
            'analysis_type': 'bridge_view',
            'analytics_dsl': 'to(switch-success)',
            # No query_dsl — subject is in analytics_dsl
            'scenarios': [
                {
                    'scenario_id': 'scenario-a',
                    'name': 'Scenario A',
                    'colour': '#f59e0b',
                    'visibility_mode': 'f+e',
                    'graph': graph,
                    'effective_query_dsl': 'window(-90d:-30d)',
                },
                {
                    'scenario_id': 'current',
                    'name': 'Current',
                    'colour': '#3b82f6',
                    'visibility_mode': 'f+e',
                    'graph': graph,
                    'effective_query_dsl': 'window(-30d:)',
                },
            ],
        }
        result = handle_runner_analyze(data)
        assert result.get('success', result.get('result', {}).get('analysis_type')) is not None
        # Should not return an error about missing to_node
        assert 'error' not in result or result['error'] is None
        r = result.get('result', {})
        assert r.get('analysis_type') == 'bridge_view'
        # Both reach values should be non-zero (graph has paths)
        meta = r.get('metadata', {})
        assert meta.get('reach_a', 0) > 0, f"reach_a should be > 0, got {meta.get('reach_a')}"
        assert meta.get('reach_b', 0) > 0, f"reach_b should be > 0, got {meta.get('reach_b')}"

    def test_to_node_reach_with_top_level_analytics_dsl(self):
        """to_node_reach with analytics_dsl at top level."""
        from api_handlers import handle_runner_analyze

        graph = _make_graph()
        data = {
            'analysis_type': 'to_node_reach',
            'analytics_dsl': 'to(switch-success)',
            'scenarios': [
                {
                    'scenario_id': 'current',
                    'name': 'Current',
                    'visibility_mode': 'f+e',
                    'graph': graph,
                    'effective_query_dsl': 'window(-30d:)',
                },
            ],
        }
        result = handle_runner_analyze(data)
        r = result.get('result', {})
        assert r.get('analysis_type') == 'to_node_reach'
        data_rows = r.get('data', [])
        assert len(data_rows) > 0
        # Probability should be 0.6 * 0.8 = 0.48
        prob = data_rows[0].get('probability', 0)
        assert abs(prob - 0.48) < 0.01, f"Expected ~0.48, got {prob}"

    def test_graph_overview_with_empty_analytics_dsl(self):
        """graph_overview works with empty analytics_dsl."""
        from api_handlers import handle_runner_analyze

        graph = _make_graph()
        data = {
            'analysis_type': 'graph_overview',
            'analytics_dsl': '',
            'scenarios': [
                {
                    'scenario_id': 'current',
                    'name': 'Current',
                    'visibility_mode': 'f+e',
                    'graph': graph,
                    'effective_query_dsl': 'window(-30d:)',
                },
            ],
        }
        result = handle_runner_analyze(data)
        r = result.get('result', {})
        assert r.get('analysis_type') in ('graph_overview', 'graph_overview_empty')

    def test_backward_compat_query_dsl_still_works(self):
        """Old-style request with query_dsl (no analytics_dsl) still works."""
        from api_handlers import handle_runner_analyze

        graph = _make_graph()
        data = {
            'analysis_type': 'to_node_reach',
            'query_dsl': 'to(switch-success)',
            # No analytics_dsl — old format
            'scenarios': [
                {
                    'scenario_id': 'current',
                    'name': 'Current',
                    'visibility_mode': 'f+e',
                    'graph': graph,
                },
            ],
        }
        result = handle_runner_analyze(data)
        r = result.get('result', {})
        assert r.get('analysis_type') == 'to_node_reach'
        data_rows = r.get('data', [])
        assert len(data_rows) > 0


class TestSnapshotHandlerDslComposition:
    """Snapshot handler should compose analytics_dsl + effective_query_dsl cleanly."""

    def test_compose_subject_and_temporal(self):
        """Top-level analytics_dsl + per-scenario effective_query_dsl compose correctly."""
        from analysis_subject_resolution import resolve_analysis_subjects

        graph = _make_graph()
        # Simulate what the handler does: compose full_dsl from separate parts
        analytics_dsl = 'from(entry-node).to(switch-success)'
        temporal_dsl = 'window(-30d:)'
        full_dsl = f"{analytics_dsl}.{temporal_dsl}"

        # This should parse successfully
        result = resolve_analysis_subjects(
            graph=graph,
            query_dsl=full_dsl,
            analysis_type='cohort_maturity',
            candidate_regimes_by_edge={},
        )
        assert result.from_node == 'entry-node'
        assert result.to_node == 'switch-success'
        assert len(result.subjects) > 0

    def test_subject_never_has_temporal(self):
        """analytics_dsl should not contain temporal clauses."""
        good_subjects = [
            'from(a).to(b)',
            'to(switch-success)',
            'from(x).to(y).visited(z)',
            'visitedAny(a,b)',
            '',
        ]
        bad_subjects = [
            'from(a).to(b).window(-30d:)',
            'to(x).cohort(-90d:)',
            'from(a).context(channel:google)',
            'to(b).asat(1-Jan-26)',
        ]
        import re
        temporal_re = re.compile(r'\b(window|cohort|context|asat)\(')
        for s in good_subjects:
            assert not temporal_re.search(s), f"Good subject should not match: {s}"
        for s in bad_subjects:
            assert temporal_re.search(s), f"Bad subject should match: {s}"

    def test_temporal_never_has_subject(self):
        """effective_query_dsl should not contain from()/to()."""
        good_temporals = [
            'window(-30d:)',
            'cohort(-90d:)',
            'context(channel:google).window(-30d:)',
            'asat(1-Jan-26)',
            '',
        ]
        bad_temporals = [
            'from(a).window(-30d:)',
            'to(b).cohort(-90d:)',
            'from(x).to(y).window(-30d:)',
        ]
        import re
        subject_re = re.compile(r'\b(from|to)\(')
        for t in good_temporals:
            assert not subject_re.search(t), f"Good temporal should not match: {t}"
        for t in bad_temporals:
            assert subject_re.search(t), f"Bad temporal should match: {t}"


class TestPerScenarioRegimeSelection:
    """Each scenario's candidate_regimes_by_edge should be used independently."""

    def test_different_scenarios_get_different_regimes(self):
        """Two scenarios with different candidate_regimes produce different subject hashes."""
        from analysis_subject_resolution import synthesise_snapshot_subjects, ResolvedAnalysisResult, ResolvedAnalysisSubject, CandidateRegime

        # Scenario A has channel regime, scenario B has device regime
        subject = ResolvedAnalysisSubject(
            edge_uuid='e1',
            from_node_id='entry-node',
            to_node_id='switch-success',
            path_role='target',
            candidate_regimes=[
                CandidateRegime(core_hash='H_channel', equivalent_hashes=['H_channel_old']),
            ],
        )
        result_a = ResolvedAnalysisResult(
            from_node='entry-node',
            to_node='switch-success',
            ordered_edge_uuids=['e1'],
            subjects=[subject],
            scope_rule='funnel_path',
            temporal_mode='window',
            anchor_from='2026-01-01',
            anchor_to='2026-04-01',
        )
        subjects_a = synthesise_snapshot_subjects(result_a, 'cohort_maturity')
        assert subjects_a[0]['core_hash'] == 'H_channel'
        assert len(subjects_a[0]['equivalent_hashes']) == 1

        # Scenario B
        subject_b = ResolvedAnalysisSubject(
            edge_uuid='e1',
            from_node_id='entry-node',
            to_node_id='switch-success',
            path_role='target',
            candidate_regimes=[
                CandidateRegime(core_hash='H_device', equivalent_hashes=[]),
            ],
        )
        result_b = ResolvedAnalysisResult(
            from_node='entry-node',
            to_node='switch-success',
            ordered_edge_uuids=['e1'],
            subjects=[subject_b],
            scope_rule='funnel_path',
            temporal_mode='window',
            anchor_from='2026-01-01',
            anchor_to='2026-04-01',
        )
        subjects_b = synthesise_snapshot_subjects(result_b, 'cohort_maturity')
        assert subjects_b[0]['core_hash'] == 'H_device'

        # Different scenarios, different primary hashes
        assert subjects_a[0]['core_hash'] != subjects_b[0]['core_hash']
