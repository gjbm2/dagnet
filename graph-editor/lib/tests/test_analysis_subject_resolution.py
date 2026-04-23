"""
Tests for Doc 31 — Analysis Subject Resolution

Tests the BE's ability to resolve DSL queries into analysis subjects
with correct path structure, edge identification, and regime lookup.

Covers:
- PR-1 through PR-8: Path resolution scenarios
- RC-1 through RC-6: Regime map coverage scenarios
- Scope rule tests: funnel_path, children_of_selected_node, all_graph_parameters

See: docs/current/project-bayes/31-be-analysis-subject-resolution.md §8
"""

import os
import sys
from datetime import date, timedelta

# Ensure lib/ is on the path for imports.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from graph_select import resolve_ordered_path, resolve_children_edges, resolve_all_parameter_edges
from analysis_subject_resolution import (
    resolve_analysis_subjects,
    ResolvedAnalysisResult,
    ResolvedAnalysisSubject,
    ANALYSIS_TYPE_SCOPE_RULES,
)
from runner.forecast_preparation import resolve_forecast_subjects
from snapshot_regime_selection import CandidateRegime


# ============================================================
# Test graph builders
# ============================================================

def _make_graph(nodes, edges):
    """Build a minimal graph dict for testing.

    nodes: list of node ID strings
    edges: list of (from_id, to_id, uuid) tuples
    """
    return {
        'nodes': [{'id': n, 'uuid': n} for n in nodes],
        'edges': [
            {'from': e[0], 'to': e[1], 'uuid': e[2]}
            for e in edges
        ],
    }


def _make_regimes_map(edge_uuids, hashes_per_edge=None):
    """Build a candidate_regimes_by_edge map for testing.

    If hashes_per_edge is None, generates a single regime per edge
    with core_hash = 'hash-{uuid}'.
    """
    if hashes_per_edge is None:
        return {
            uuid: [{'core_hash': f'hash-{uuid}', 'equivalent_hashes': []}]
            for uuid in edge_uuids
        }
    return hashes_per_edge


# ============================================================
# PR: Path resolution tests
# ============================================================

class TestPR1_LinearChain:
    """PR-1: Linear chain A→B→C, from(A).to(C) — 2 edges, ordered."""

    def test_resolves_two_edges_in_order(self):
        graph = _make_graph(
            ['A', 'B', 'C'],
            [('A', 'B', 'e1'), ('B', 'C', 'e2')],
        )
        result = resolve_ordered_path(graph, 'from(A).to(C)')

        assert result.from_node == 'A'
        assert result.to_node == 'C'
        assert len(result.ordered_edges) == 2
        assert result.ordered_edges[0].edge_uuid == 'e1'
        assert result.ordered_edges[0].path_role == 'first'
        assert result.ordered_edges[1].edge_uuid == 'e2'
        assert result.ordered_edges[1].path_role == 'last'
        assert result.all_edge_uuids == {'e1', 'e2'}


class TestPR2_SingleEdge:
    """PR-2: Single edge A→B, from(A).to(B) — degenerate case, first=last."""

    def test_single_edge_has_role_only(self):
        graph = _make_graph(
            ['A', 'B'],
            [('A', 'B', 'e1')],
        )
        result = resolve_ordered_path(graph, 'from(A).to(B)')

        assert len(result.ordered_edges) == 1
        assert result.ordered_edges[0].edge_uuid == 'e1'
        assert result.ordered_edges[0].path_role == 'only'


class TestPR3_Diamond:
    """PR-3: Diamond A→B→D, A→C→D, from(A).to(D) — parallel paths."""

    def test_both_routes_included(self):
        graph = _make_graph(
            ['A', 'B', 'C', 'D'],
            [('A', 'B', 'e1'), ('B', 'D', 'e2'), ('A', 'C', 'e3'), ('C', 'D', 'e4')],
        )
        result = resolve_ordered_path(graph, 'from(A).to(D)')

        uuids = {e.edge_uuid for e in result.ordered_edges}
        assert uuids == {'e1', 'e2', 'e3', 'e4'}

    def test_first_and_last_roles_correct(self):
        graph = _make_graph(
            ['A', 'B', 'C', 'D'],
            [('A', 'B', 'e1'), ('B', 'D', 'e2'), ('A', 'C', 'e3'), ('C', 'D', 'e4')],
        )
        result = resolve_ordered_path(graph, 'from(A).to(D)')

        first_edges = [e for e in result.ordered_edges if e.path_role == 'first']
        last_edges = [e for e in result.ordered_edges if e.path_role == 'last']

        # Both A→B and A→C are 'first' (they start at from_node)
        assert len(first_edges) == 2
        assert all(e.from_node_id == 'A' for e in first_edges)

        # Both B→D and C→D are 'last' (they end at to_node)
        assert len(last_edges) == 2
        assert all(e.to_node_id == 'D' for e in last_edges)


class TestPR4_FanOut_ChildrenScope:
    """PR-4: Fan-out A→B, A→C, children_of_selected_node on A."""

    def test_returns_both_child_edges(self):
        graph = _make_graph(
            ['A', 'B', 'C'],
            [('A', 'B', 'e1'), ('A', 'C', 'e2')],
        )
        edges = resolve_children_edges(graph, 'A')

        assert len(edges) == 2
        uuids = {e.edge_uuid for e in edges}
        assert uuids == {'e1', 'e2'}
        assert all(e.path_role == 'child' for e in edges)


class TestPR5_FanIn_ExcludesUnreachable:
    """PR-5: Fan-in B→D, C→D. from(B).to(D) must exclude C→D."""

    def test_excludes_edge_not_on_path(self):
        graph = _make_graph(
            ['A', 'B', 'C', 'D'],
            [('A', 'B', 'e1'), ('B', 'D', 'e2'), ('A', 'C', 'e3'), ('C', 'D', 'e4')],
        )
        result = resolve_ordered_path(graph, 'from(B).to(D)')

        assert len(result.ordered_edges) == 1
        assert result.ordered_edges[0].edge_uuid == 'e2'
        assert result.ordered_edges[0].path_role == 'only'


class TestPR6_DisconnectedGraph:
    """PR-6: from(A).to(Z) where Z is unreachable — empty result."""

    def test_returns_empty_path(self):
        graph = _make_graph(
            ['A', 'B', 'Z'],
            [('A', 'B', 'e1')],  # Z is disconnected
        )
        result = resolve_ordered_path(graph, 'from(A).to(Z)')

        assert result.from_node == 'A'
        assert result.to_node == 'Z'
        assert len(result.ordered_edges) == 0
        assert len(result.all_edge_uuids) == 0


class TestPR7_LongerChain:
    """PR-7: A→B→C→D→E, from(A).to(E) — 4 edges, correct ordering."""

    def test_four_edges_ordered_with_correct_roles(self):
        graph = _make_graph(
            ['A', 'B', 'C', 'D', 'E'],
            [('A', 'B', 'e1'), ('B', 'C', 'e2'), ('C', 'D', 'e3'), ('D', 'E', 'e4')],
        )
        result = resolve_ordered_path(graph, 'from(A).to(E)')

        assert len(result.ordered_edges) == 4
        assert result.ordered_edges[0].path_role == 'first'
        assert result.ordered_edges[0].edge_uuid == 'e1'
        assert result.ordered_edges[1].path_role == 'intermediate'
        assert result.ordered_edges[2].path_role == 'intermediate'
        assert result.ordered_edges[3].path_role == 'last'
        assert result.ordered_edges[3].edge_uuid == 'e4'


class TestPR8_AllGraphParameters:
    """PR-8: all_graph_parameters scope returns every edge."""

    def test_returns_all_edges(self):
        graph = _make_graph(
            ['A', 'B', 'C', 'D'],
            [('A', 'B', 'e1'), ('B', 'C', 'e2'), ('C', 'D', 'e3')],
        )
        edges = resolve_all_parameter_edges(graph)

        assert len(edges) == 3
        uuids = {e.edge_uuid for e in edges}
        assert uuids == {'e1', 'e2', 'e3'}


# ============================================================
# RC: Regime map coverage tests
# ============================================================

class TestRC1_SimplePathInLargerGraph:
    """RC-1: 2-edge path in a 10-edge graph — all 10 in map, BE resolves 2."""

    def test_resolved_edges_found_in_map(self):
        # Build a larger graph; only A→B→C is the path from A to C.
        # Other edges go to D, E, F — no path back to C.
        nodes = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']
        edges = [
            ('A', 'B', 'e1'), ('B', 'C', 'e2'),    # on path A→C
            ('A', 'D', 'e3'), ('D', 'E', 'e4'),     # dead end
            ('E', 'F', 'e5'), ('F', 'G', 'e6'),     # dead end
            ('G', 'H', 'e7'), ('H', 'I', 'e8'),     # dead end
            ('I', 'J', 'e9'), ('D', 'F', 'e10'),    # dead end
        ]
        graph = _make_graph(nodes, edges)
        all_uuids = [e[2] for e in edges]
        regimes_map = _make_regimes_map(all_uuids)

        result = resolve_analysis_subjects(
            graph, 'from(A).to(C)', 'cohort_maturity', regimes_map,
        )

        # Path should have 2 edges (A→B, B→C only)
        assert len(result.subjects) == 2
        resolved_uuids = {s.edge_uuid for s in result.subjects}
        assert resolved_uuids == {'e1', 'e2'}
        # Every resolved edge must exist in the regimes map
        for subj in result.subjects:
            assert subj.edge_uuid in regimes_map
            assert len(subj.candidate_regimes) > 0


class TestRC2_DiamondWithDisconnected:
    """RC-2: Diamond path + disconnected component — all edges in map."""

    def test_disconnected_edges_dont_appear_in_subjects(self):
        graph = _make_graph(
            ['A', 'B', 'C', 'D', 'X', 'Y'],
            [
                ('A', 'B', 'e1'), ('B', 'D', 'e2'),
                ('A', 'C', 'e3'), ('C', 'D', 'e4'),
                ('X', 'Y', 'e5'),  # disconnected
            ],
        )
        regimes_map = _make_regimes_map(['e1', 'e2', 'e3', 'e4', 'e5'])

        result = resolve_analysis_subjects(
            graph, 'from(A).to(D)', 'cohort_maturity', regimes_map,
        )

        resolved_uuids = {s.edge_uuid for s in result.subjects}
        assert 'e5' not in resolved_uuids  # disconnected edge excluded
        assert resolved_uuids == {'e1', 'e2', 'e3', 'e4'}


class TestRC4_NoContext_SingleRegime:
    """RC-4: Graph with no context — each edge has exactly one candidate regime."""

    def test_single_uncontexted_regime_per_edge(self):
        graph = _make_graph(['A', 'B'], [('A', 'B', 'e1')])
        regimes_map = {
            'e1': [{'core_hash': 'hash-bare', 'equivalent_hashes': []}],
        }

        result = resolve_analysis_subjects(
            graph, 'from(A).to(B)', 'daily_conversions', regimes_map,
        )

        assert len(result.subjects) == 1
        assert len(result.subjects[0].candidate_regimes) == 1
        assert result.subjects[0].candidate_regimes[0].core_hash == 'hash-bare'


class TestRC5_MultipleContextDimensions:
    """RC-5: Each edge has 3+ candidate regimes (channel, device, bare)."""

    def test_multiple_regimes_looked_up_correctly(self):
        graph = _make_graph(['A', 'B'], [('A', 'B', 'e1')])
        regimes_map = {
            'e1': [
                {'core_hash': 'hash-channel', 'equivalent_hashes': []},
                {'core_hash': 'hash-device', 'equivalent_hashes': []},
                {'core_hash': 'hash-bare', 'equivalent_hashes': []},
            ],
        }

        result = resolve_analysis_subjects(
            graph, 'from(A).to(B)', 'lag_histogram', regimes_map,
        )

        assert len(result.subjects[0].candidate_regimes) == 3
        hashes = [r.core_hash for r in result.subjects[0].candidate_regimes]
        assert hashes == ['hash-channel', 'hash-device', 'hash-bare']


class TestRC6_HashMappingEquivalents:
    """RC-6: Edge with hash-mapping equivalents in candidate regime."""

    def test_equivalent_hashes_preserved(self):
        graph = _make_graph(['A', 'B'], [('A', 'B', 'e1')])
        regimes_map = {
            'e1': [
                {
                    'core_hash': 'hash-channel-v2',
                    'equivalent_hashes': ['hash-channel-v1', 'hash-channel-old'],
                },
            ],
        }

        result = resolve_analysis_subjects(
            graph, 'from(A).to(B)', 'surprise_gauge', regimes_map,
        )

        regime = result.subjects[0].candidate_regimes[0]
        assert regime.core_hash == 'hash-channel-v2'
        assert regime.equivalent_hashes == ['hash-channel-v1', 'hash-channel-old']


# ============================================================
# Scope rule integration tests
# ============================================================

class TestFunnelPathScopeRule:
    """Verify funnel_path scope rule produces correct metadata."""

    def test_cohort_maturity_has_sweep_fields(self):
        graph = _make_graph(['A', 'B'], [('A', 'B', 'e1')])
        regimes_map = _make_regimes_map(['e1'])

        result = resolve_analysis_subjects(
            graph, 'from(A).to(B).window(-90d:)', 'cohort_maturity', regimes_map,
        )

        assert result.scope_rule == 'funnel_path'
        assert result.temporal_mode == 'window'
        assert result.from_node == 'A'
        assert result.to_node == 'B'
        assert result.ordered_edge_uuids == ['e1']
        assert result.sweep_from is not None  # derived from anchor
        assert result.sweep_to is not None    # defaults to today

    def test_daily_conversions_no_sweep_fields(self):
        graph = _make_graph(['A', 'B'], [('A', 'B', 'e1')])
        regimes_map = _make_regimes_map(['e1'])

        result = resolve_analysis_subjects(
            graph, 'from(A).to(B).window(-90d:)', 'daily_conversions', regimes_map,
        )

        assert result.scope_rule == 'funnel_path'
        assert result.sweep_from is None
        assert result.sweep_to is None

    def test_cohort_maturity_asat_caps_sweep_to(self):
        graph = _make_graph(['A', 'B'], [('A', 'B', 'e1')])
        regimes_map = _make_regimes_map(['e1'])

        result = resolve_analysis_subjects(
            graph,
            'from(A).to(B).cohort(1-Oct-25:31-Oct-25).asat(15-Dec-25)',
            'cohort_maturity',
            regimes_map,
        )

        assert result.sweep_from == '2025-10-01'
        assert result.sweep_to == '2025-12-15'

    def test_explicit_cohort_anchor_survives_subject_synthesis(self):
        graph = _make_graph(
            ['A', 'B', 'C'],
            [('A', 'B', 'e1'), ('B', 'C', 'e2')],
        )
        regimes_map = _make_regimes_map(['e2'])
        scenario = {
            'scenario_id': 'current',
            'analytics_dsl': '',
            'effective_query_dsl': 'cohort(B,1-Oct-25:31-Oct-25)',
            'candidate_regimes_by_edge': regimes_map,
        }

        subjects = resolve_forecast_subjects(
            graph_data=graph,
            scenario=scenario,
            top_analytics_dsl='from(B).to(C)',
            path_analysis_type='cohort_maturity',
            whole_graph_analysis_type=None,
            log_prefix='[test]',
        )

        assert subjects
        assert all(subj.get('anchor_node_id') == 'B' for subj in subjects)


class TestChildrenScopeRule:
    """Verify children_of_selected_node scope."""

    def test_outcome_comparison_resolves_from_parent(self):
        graph = _make_graph(
            ['A', 'B', 'C', 'D'],
            [('A', 'B', 'e1'), ('A', 'C', 'e2'), ('A', 'D', 'e3')],
        )
        regimes_map = _make_regimes_map(['e1', 'e2', 'e3'])

        result = resolve_analysis_subjects(
            graph, 'from(A).visitedAny(B,C,D).window(-30d:)',
            'outcome_comparison', regimes_map,
        )

        assert result.scope_rule == 'children_of_selected_node'
        assert result.from_node == 'A'
        assert result.to_node is None
        assert result.ordered_edge_uuids is None
        assert len(result.subjects) == 3


class TestAllParametersScopeRule:
    """Verify all_graph_parameters scope."""

    def test_bayes_fit_returns_all_edges(self):
        graph = _make_graph(
            ['A', 'B', 'C'],
            [('A', 'B', 'e1'), ('B', 'C', 'e2')],
        )
        regimes_map = _make_regimes_map(['e1', 'e2'])

        result = resolve_analysis_subjects(
            graph, 'window(-90d:)', 'bayes_fit', regimes_map,
        )

        assert result.scope_rule == 'all_graph_parameters'
        assert result.from_node is None
        assert result.to_node is None
        assert len(result.subjects) == 2

    def test_conditioned_forecast_asat_caps_sweep_to(self):
        graph = _make_graph(
            ['A', 'B', 'C'],
            [('A', 'B', 'e1'), ('B', 'C', 'e2')],
        )
        regimes_map = _make_regimes_map(['e1', 'e2'])

        result = resolve_analysis_subjects(
            graph,
            'window(1-Oct-25:31-Oct-25).asat(15-Dec-25)',
            'conditioned_forecast',
            regimes_map,
        )

        assert result.scope_rule == 'all_graph_parameters'
        assert result.sweep_from == '2025-10-01'
        assert result.sweep_to == '2025-12-15'
        assert len(result.subjects) == 2

    def test_conditioned_forecast_relative_asat_resolves_from_today(self):
        graph = _make_graph(
            ['A', 'B', 'C'],
            [('A', 'B', 'e1'), ('B', 'C', 'e2')],
        )
        regimes_map = _make_regimes_map(['e1', 'e2'])

        result = resolve_analysis_subjects(
            graph,
            'window(1-Oct-25:31-Oct-25).asat(-7d)',
            'conditioned_forecast',
            regimes_map,
        )

        assert result.sweep_from == '2025-10-01'
        assert result.sweep_to == (date.today() - timedelta(days=7)).isoformat()


class TestMissingEdgeInRegimeMap:
    """Edge resolved by path but missing from regime map — gets empty regimes."""

    def test_missing_edge_gets_empty_regimes(self):
        graph = _make_graph(['A', 'B', 'C'], [('A', 'B', 'e1'), ('B', 'C', 'e2')])
        regimes_map = _make_regimes_map(['e1'])  # e2 intentionally missing

        result = resolve_analysis_subjects(
            graph, 'from(A).to(C)', 'cohort_maturity', regimes_map,
        )

        assert len(result.subjects) == 2
        e1_subj = [s for s in result.subjects if s.edge_uuid == 'e1'][0]
        e2_subj = [s for s in result.subjects if s.edge_uuid == 'e2'][0]
        assert len(e1_subj.candidate_regimes) == 1
        assert len(e2_subj.candidate_regimes) == 0  # missing from map


class TestUnknownAnalysisType:
    """Unknown analysis type raises ValueError."""

    def test_raises_for_unknown_type(self):
        graph = _make_graph(['A', 'B'], [('A', 'B', 'e1')])
        with pytest.raises(ValueError, match='Unknown analysis type'):
            resolve_analysis_subjects(graph, 'from(A).to(B)', 'nonexistent_type', {})


# ============================================================
# Complex DSL patterns: visited, exclude, visitedAny
# ============================================================

class TestVisitedConstraint:
    """from(A).visited(B).to(D) — only paths through B are valid."""

    def test_visited_filters_to_paths_through_waypoint(self):
        # A→B→D and A→C→D exist, but visited(B) excludes the A→C→D path.
        graph = _make_graph(
            ['A', 'B', 'C', 'D'],
            [('A', 'B', 'e1'), ('B', 'D', 'e2'), ('A', 'C', 'e3'), ('C', 'D', 'e4')],
        )
        regimes_map = _make_regimes_map(['e1', 'e2', 'e3', 'e4'])

        result = resolve_analysis_subjects(
            graph, 'from(A).visited(B).to(D)', 'cohort_maturity', regimes_map,
        )

        uuids = {s.edge_uuid for s in result.subjects}
        assert uuids == {'e1', 'e2'}, f"Expected only A→B→D path, got {uuids}"


class TestExcludeConstraint:
    """from(A).to(D).exclude(C) — paths through C are excluded."""

    def test_exclude_removes_paths_through_node(self):
        graph = _make_graph(
            ['A', 'B', 'C', 'D'],
            [('A', 'B', 'e1'), ('B', 'D', 'e2'), ('A', 'C', 'e3'), ('C', 'D', 'e4')],
        )
        regimes_map = _make_regimes_map(['e1', 'e2', 'e3', 'e4'])

        result = resolve_analysis_subjects(
            graph, 'from(A).to(D).exclude(C)', 'daily_conversions', regimes_map,
        )

        uuids = {s.edge_uuid for s in result.subjects}
        assert uuids == {'e1', 'e2'}, f"Expected only A→B→D path, got {uuids}"


class TestVisitedMultiHop:
    """from(A).visited(C).to(E) — multi-hop with waypoint."""

    def test_multihop_visited_resolves_full_path(self):
        # A→B→C→D→E: visited(C) means the path must go through C.
        # A→X→E: this path doesn't visit C, so excluded.
        graph = _make_graph(
            ['A', 'B', 'C', 'D', 'E', 'X'],
            [
                ('A', 'B', 'e1'), ('B', 'C', 'e2'), ('C', 'D', 'e3'), ('D', 'E', 'e4'),
                ('A', 'X', 'e5'), ('X', 'E', 'e6'),
            ],
        )
        regimes_map = _make_regimes_map(['e1', 'e2', 'e3', 'e4', 'e5', 'e6'])

        result = resolve_analysis_subjects(
            graph, 'from(A).visited(C).to(E)', 'lag_histogram', regimes_map,
        )

        uuids = {s.edge_uuid for s in result.subjects}
        assert uuids == {'e1', 'e2', 'e3', 'e4'}, f"Expected A→B→C→D→E path, got {uuids}"
        # Verify path roles
        roles = {s.edge_uuid: s.path_role for s in result.subjects}
        assert roles['e1'] == 'first'
        assert roles['e4'] == 'last'
        assert roles['e2'] == 'intermediate'
        assert roles['e3'] == 'intermediate'


class TestAllFunnelPathAnalysisTypes:
    """Every funnel_path analysis type resolves the same edges for the same DSL."""

    FUNNEL_TYPES = ['cohort_maturity', 'daily_conversions', 'lag_histogram', 'lag_fit', 'surprise_gauge']

    def test_all_types_resolve_same_edges(self):
        graph = _make_graph(
            ['A', 'B', 'C'],
            [('A', 'B', 'e1'), ('B', 'C', 'e2'), ('A', 'C', 'e3')],
        )
        regimes_map = _make_regimes_map(['e1', 'e2', 'e3'])
        dsl = 'from(A).visited(B).to(C).window(-90d:)'

        # All funnel_path types should resolve the same set of edges.
        edge_sets = {}
        for at in self.FUNNEL_TYPES:
            result = resolve_analysis_subjects(graph, dsl, at, regimes_map)
            edge_sets[at] = {s.edge_uuid for s in result.subjects}

        # All should be identical (A→B + B→C, not A→C because visited(B))
        expected = {'e1', 'e2'}
        for at, edges in edge_sets.items():
            assert edges == expected, f"{at} resolved {edges}, expected {expected}"


class TestUuidBasedGraph:
    """Real graphs use UUIDs in edge from/to fields, not node IDs.
    The DSL uses human-readable node IDs. Resolution must map between them."""

    def _make_uuid_graph(self):
        """Graph where edge from/to are UUIDs, not node IDs."""
        return {
            'nodes': [
                {'id': 'registration', 'uuid': 'node-uuid-1'},
                {'id': 'success', 'uuid': 'node-uuid-2'},
                {'id': 'failure', 'uuid': 'node-uuid-3'},
            ],
            'edges': [
                {'from': 'node-uuid-1', 'to': 'node-uuid-2', 'uuid': 'edge-uuid-1'},
                {'from': 'node-uuid-1', 'to': 'node-uuid-3', 'uuid': 'edge-uuid-2'},
            ],
        }

    def test_funnel_path_resolves_with_uuid_edges(self):
        graph = self._make_uuid_graph()
        regimes_map = _make_regimes_map(['edge-uuid-1', 'edge-uuid-2'])

        result = resolve_analysis_subjects(
            graph, 'from(registration).to(success).window(-90d:)',
            'cohort_maturity', regimes_map,
        )

        assert len(result.subjects) == 1
        assert result.subjects[0].edge_uuid == 'edge-uuid-1'
        assert result.subjects[0].path_role == 'only'

    def test_children_scope_resolves_with_uuid_edges(self):
        graph = self._make_uuid_graph()
        regimes_map = _make_regimes_map(['edge-uuid-1', 'edge-uuid-2'])

        result = resolve_analysis_subjects(
            graph, 'from(registration).visitedAny(success,failure).window(-30d:)',
            'outcome_comparison', regimes_map,
        )

        assert len(result.subjects) == 2
        uuids = {s.edge_uuid for s in result.subjects}
        assert uuids == {'edge-uuid-1', 'edge-uuid-2'}

    def test_multihop_with_uuid_edges(self):
        graph = {
            'nodes': [
                {'id': 'A', 'uuid': 'n1'},
                {'id': 'B', 'uuid': 'n2'},
                {'id': 'C', 'uuid': 'n3'},
            ],
            'edges': [
                {'from': 'n1', 'to': 'n2', 'uuid': 'e1'},
                {'from': 'n2', 'to': 'n3', 'uuid': 'e2'},
            ],
        }
        regimes_map = _make_regimes_map(['e1', 'e2'])

        result = resolve_analysis_subjects(
            graph, 'from(A).to(C).window(-90d:)', 'cohort_maturity', regimes_map,
        )

        assert len(result.subjects) == 2
        assert result.subjects[0].edge_uuid == 'e1'
        assert result.subjects[0].path_role == 'first'
        assert result.subjects[1].edge_uuid == 'e2'
        assert result.subjects[1].path_role == 'last'


class TestChildrenAnalysisTypes:
    """outcome_comparison and branch_comparison resolve children correctly."""

    def test_outcome_comparison_with_visitedAny_dsl(self):
        graph = _make_graph(
            ['start', 'buy', 'leave', 'defer'],
            [('start', 'buy', 'e1'), ('start', 'leave', 'e2'), ('start', 'defer', 'e3')],
        )
        regimes_map = _make_regimes_map(['e1', 'e2', 'e3'])

        result = resolve_analysis_subjects(
            graph, 'from(start).visitedAny(buy,leave,defer).window(-30d:)',
            'outcome_comparison', regimes_map,
        )

        assert result.scope_rule == 'children_of_selected_node'
        uuids = {s.edge_uuid for s in result.subjects}
        assert uuids == {'e1', 'e2', 'e3'}

    def test_branch_comparison_resolves_same(self):
        graph = _make_graph(
            ['hub', 'path-a', 'path-b'],
            [('hub', 'path-a', 'e1'), ('hub', 'path-b', 'e2')],
        )
        regimes_map = _make_regimes_map(['e1', 'e2'])

        result = resolve_analysis_subjects(
            graph, 'from(hub).visitedAny(path-a,path-b).window(-30d:)',
            'branch_comparison', regimes_map,
        )

        assert result.scope_rule == 'children_of_selected_node'
        assert len(result.subjects) == 2


# ============================================================
# Handler integration: synthesise_snapshot_subjects format
# ============================================================

from analysis_subject_resolution import synthesise_snapshot_subjects, ANALYSIS_TYPE_READ_MODES


class TestSynthesiseFormat_CohortMaturity:
    """Synthesised subjects have all fields the handler reads."""

    def test_has_required_fields(self):
        graph = _make_graph(['A', 'B', 'C'], [('A', 'B', 'e1'), ('B', 'C', 'e2')])
        regimes_map = {
            'e1': [
                {'core_hash': 'h-channel-e1', 'equivalent_hashes': ['h-old-e1']},
                {'core_hash': 'h-bare-e1', 'equivalent_hashes': []},
            ],
            'e2': [
                {'core_hash': 'h-channel-e2', 'equivalent_hashes': []},
            ],
        }
        result = resolve_analysis_subjects(
            graph, 'from(A).to(C).window(-90d:)', 'cohort_maturity', regimes_map,
        )
        subjects = synthesise_snapshot_subjects(result, 'cohort_maturity')

        assert len(subjects) == 2
        for subj in subjects:
            # Fields the handler validates as required
            assert 'param_id' in subj
            assert 'core_hash' in subj
            assert subj['core_hash']  # non-empty
            assert 'anchor_from' in subj
            assert 'anchor_to' in subj
            # Fields the handler reads for dispatch
            assert subj['read_mode'] == 'cohort_maturity'
            assert 'sweep_from' in subj
            assert 'sweep_to' in subj
            assert 'subject_id' in subj
            assert 'slice_keys' in subj
            assert 'equivalent_hashes' in subj
            assert 'candidate_regimes' in subj
            assert 'target' in subj
            assert 'targetId' in subj['target']

    def test_core_hash_is_first_regime(self):
        graph = _make_graph(['A', 'B'], [('A', 'B', 'e1')])
        regimes_map = {
            'e1': [
                {'core_hash': 'preferred', 'equivalent_hashes': []},
                {'core_hash': 'fallback', 'equivalent_hashes': []},
            ],
        }
        result = resolve_analysis_subjects(
            graph, 'from(A).to(B).window(-90d:)', 'cohort_maturity', regimes_map,
        )
        subjects = synthesise_snapshot_subjects(result, 'cohort_maturity')

        assert subjects[0]['core_hash'] == 'preferred'

    def test_equivalent_hashes_contains_all_regime_hashes(self):
        graph = _make_graph(['A', 'B'], [('A', 'B', 'e1')])
        regimes_map = {
            'e1': [
                {'core_hash': 'h1', 'equivalent_hashes': ['h1-old']},
                {'core_hash': 'h2', 'equivalent_hashes': ['h2-old']},
            ],
        }
        result = resolve_analysis_subjects(
            graph, 'from(A).to(B).window(-90d:)', 'cohort_maturity', regimes_map,
        )
        subjects = synthesise_snapshot_subjects(result, 'cohort_maturity')

        eq_hashes = {e['core_hash'] for e in subjects[0]['equivalent_hashes']}
        # All hashes except the primary should be in equivalent_hashes
        assert 'h1-old' in eq_hashes
        assert 'h2' in eq_hashes
        assert 'h2-old' in eq_hashes
        # Primary hash should NOT be in equivalent_hashes
        assert 'h1' not in eq_hashes

    def test_path_role_preserved(self):
        graph = _make_graph(['A', 'B', 'C'], [('A', 'B', 'e1'), ('B', 'C', 'e2')])
        regimes_map = _make_regimes_map(['e1', 'e2'])
        result = resolve_analysis_subjects(
            graph, 'from(A).to(C).window(-90d:)', 'cohort_maturity', regimes_map,
        )
        subjects = synthesise_snapshot_subjects(result, 'cohort_maturity')

        roles = {s['target']['targetId']: s['path_role'] for s in subjects}
        assert roles['e1'] == 'first'
        assert roles['e2'] == 'last'


class TestSynthesiseFormat_RawSnapshots:
    """Synthesised subjects for raw_snapshots types (no sweep fields)."""

    def test_no_sweep_fields_for_daily_conversions(self):
        graph = _make_graph(['A', 'B'], [('A', 'B', 'e1')])
        regimes_map = _make_regimes_map(['e1'])
        result = resolve_analysis_subjects(
            graph, 'from(A).to(B).window(-90d:)', 'daily_conversions', regimes_map,
        )
        subjects = synthesise_snapshot_subjects(result, 'daily_conversions')

        assert subjects[0]['read_mode'] == 'raw_snapshots'
        assert 'sweep_from' not in subjects[0]
        assert 'sweep_to' not in subjects[0]


class TestSynthesiseFormat_SweepSimple:
    """Synthesised subjects for sweep_simple types."""

    def test_sweep_fields_present_for_lag_fit(self):
        graph = _make_graph(['A', 'B'], [('A', 'B', 'e1')])
        regimes_map = _make_regimes_map(['e1'])
        result = resolve_analysis_subjects(
            graph, 'from(A).to(B).window(-90d:)', 'lag_fit', regimes_map,
        )
        subjects = synthesise_snapshot_subjects(result, 'lag_fit')

        assert subjects[0]['read_mode'] == 'sweep_simple'
        assert 'sweep_from' in subjects[0]
        assert 'sweep_to' in subjects[0]


class TestSynthesiseFormat_EmptyRegimes:
    """Edge with no regimes gets empty core_hash — handler will skip."""

    def test_empty_regimes_produce_empty_hash(self):
        graph = _make_graph(['A', 'B'], [('A', 'B', 'e1')])
        regimes_map = {}  # no regimes for e1
        result = resolve_analysis_subjects(
            graph, 'from(A).to(B).window(-90d:)', 'daily_conversions', regimes_map,
        )
        subjects = synthesise_snapshot_subjects(result, 'daily_conversions')

        assert subjects[0]['core_hash'] == ''
        assert subjects[0]['equivalent_hashes'] == []
