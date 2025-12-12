"""
Tests for analysis runners.
"""

import pytest
import networkx as nx
from lib.runner.runners import (
    run_single_node_entry,
    run_path_to_end,
    run_path_through,
    run_end_comparison,
    run_branch_comparison,
    run_path,
    run_partial_path,
    run_general_stats,
    get_runner,
)


def build_test_graph():
    """
    Test graph:
        START → A (p=1.0)
        A → B1 (p=0.4) → C (p=1.0)
        A → B2 (p=0.4) → C (p=1.0)
        A → B3 (p=0.2) → END2 (p=1.0)
        C → END1 (p=1.0)
    """
    G = nx.DiGraph()
    G.add_node('start', is_entry=True, absorbing=False, label='Start')
    G.add_node('a', is_entry=False, absorbing=False, label='Step A')
    G.add_node('b1', is_entry=False, absorbing=False, label='Branch 1')
    G.add_node('b2', is_entry=False, absorbing=False, label='Branch 2')
    G.add_node('b3', is_entry=False, absorbing=False, label='Branch 3')
    G.add_node('c', is_entry=False, absorbing=False, label='Convergence')
    G.add_node('end1', is_entry=False, absorbing=True, label='Success')
    G.add_node('end2', is_entry=False, absorbing=True, label='Failure')
    
    G.add_edge('start', 'a', p=1.0, cost_gbp=0, labour_cost=0)
    G.add_edge('a', 'b1', p=0.4, cost_gbp=10, labour_cost=1)
    G.add_edge('a', 'b2', p=0.4, cost_gbp=10, labour_cost=1)
    G.add_edge('a', 'b3', p=0.2, cost_gbp=10, labour_cost=1)
    G.add_edge('b1', 'c', p=1.0, cost_gbp=0, labour_cost=0)
    G.add_edge('b2', 'c', p=1.0, cost_gbp=0, labour_cost=0)
    G.add_edge('b3', 'end2', p=1.0, cost_gbp=0, labour_cost=0)
    G.add_edge('c', 'end1', p=1.0, cost_gbp=0, labour_cost=0)
    
    return G


class TestSingleNodeEntry:
    """Test entry node analysis - new declarative schema."""
    
    def test_entry_analysis(self):
        """Analyze entry node shows all outcomes."""
        G = build_test_graph()
        result = run_single_node_entry(G, 'start')
        
        # New schema has semantics and data
        assert 'semantics' in result
        assert 'data' in result
        assert result['metadata']['node_id'] == 'start'
        
        # Data has rows for each outcome
        outcomes = [r for r in result['data'] if r['scenario_id'] == 'current']
        assert len(outcomes) == 2  # end1 and end2
    
    def test_outcome_probabilities(self):
        """Outcome probabilities are correct."""
        G = build_test_graph()
        result = run_single_node_entry(G, 'start')
        
        # Get outcomes from data for current scenario
        outcomes_by_id = {r['outcome']: r for r in result['data'] if r['scenario_id'] == 'current'}
        
        assert outcomes_by_id['end1']['probability'] == pytest.approx(0.8)
        assert outcomes_by_id['end2']['probability'] == pytest.approx(0.2)


class TestPathToEnd:
    """Test path to absorbing analysis - new declarative schema."""
    
    def test_to_end1(self):
        """Path to end1."""
        G = build_test_graph()
        result = run_path_to_end(G, 'end1')
        
        assert 'semantics' in result
        assert result['metadata']['node_label'] == 'Success'
        # Get probability from data for current scenario
        current_row = [r for r in result['data'] if r['scenario_id'] == 'current'][0]
        assert current_row['probability'] == pytest.approx(0.8)

    def test_metric_label_respects_visibility_mode(self):
        """Metric label should reflect probability basis when modes are uniform."""
        G = build_test_graph()

        class Scenario:
            def __init__(self, scenario_id: str, name: str, visibility_mode: str, graph: dict):
                self.scenario_id = scenario_id
                self.name = name
                self.colour = '#EC4899'
                self.visibility_mode = visibility_mode
                self.graph = graph

        # Build a minimal graph payload with evidence mean differing from mean
        graph_payload = {
            'nodes': [
                {'id': 'start', 'uuid': 'start', 'entry': {'is_start': True}},
                {'id': 'a', 'uuid': 'a'},
                {'id': 'end1', 'uuid': 'end1', 'absorbing': True},
            ],
            'edges': [
                {'from': 'start', 'to': 'a', 'uuid': 'e1', 'p': {'mean': 1.0, 'evidence': {'mean': 1.0}}},
                {'from': 'a', 'to': 'end1', 'uuid': 'e2', 'p': {'mean': 0.8, 'evidence': {'mean': 0.2}}},
            ],
        }

        scenario = Scenario('s1', 'Scenario 1', 'e', graph_payload)
        result = run_path_to_end(build_test_graph(), 'end1', all_scenarios=[scenario])

        assert result['semantics']['metrics'][0]['name'] == 'Probability'
        assert result['dimension_values']['scenario_id']['s1']['probability_label'] == 'Evidence Probability'
    
    def test_to_end2(self):
        """Path to end2."""
        G = build_test_graph()
        result = run_path_to_end(G, 'end2')
        
        current_row = [r for r in result['data'] if r['scenario_id'] == 'current'][0]
        assert current_row['probability'] == pytest.approx(0.2)


class TestPathThrough:
    """Test path through node analysis - new declarative schema."""
    
    def test_through_branch(self):
        """Path through branch node."""
        G = build_test_graph()
        result = run_path_through(G, 'b1')
        
        assert 'semantics' in result
        assert result['metadata']['node_id'] == 'b1'
        # Get probability from data for current scenario
        current_row = [r for r in result['data'] if r['scenario_id'] == 'current'][0]
        assert current_row['probability'] == pytest.approx(0.4)


class TestEndComparison:
    """Test end node comparison - new declarative schema."""
    
    def test_compare_ends(self):
        """Compare two end nodes."""
        G = build_test_graph()
        result = run_end_comparison(G, ['end1', 'end2'])
        
        assert 'semantics' in result
        assert 'data' in result
        # Get data for current scenario
        current_rows = [r for r in result['data'] if r['scenario_id'] == 'current']
        assert len(current_rows) == 2
        total_prob = sum(r['probability'] for r in current_rows)
        assert total_prob == pytest.approx(1.0)
    
    def test_sorted_by_probability(self):
        """Results contain correct probabilities."""
        G = build_test_graph()
        result = run_end_comparison(G, ['end1', 'end2'])
        
        # Get data for current scenario
        probs = {r['node']: r['probability'] for r in result['data'] if r['scenario_id'] == 'current'}
        # end1 has higher probability than end2
        assert probs['end1'] > probs['end2']


class TestBranchComparison:
    """Test branch comparison - new declarative schema."""
    
    def test_compare_branches(self):
        """Compare sibling branches."""
        G = build_test_graph()
        result = run_branch_comparison(G, ['b1', 'b2', 'b3'])
        
        assert 'semantics' in result
        # Get data for current scenario
        current_rows = [r for r in result['data'] if r['scenario_id'] == 'current']
        assert len(current_rows) == 3
    
    def test_edge_probabilities(self):
        """Edge probabilities are included."""
        G = build_test_graph()
        result = run_branch_comparison(G, ['b1', 'b2', 'b3'])
        
        # Get data for current scenario
        probs = {r['branch']: r['edge_probability'] for r in result['data'] if r['scenario_id'] == 'current'}
        assert probs['b1'] == 0.4
        assert probs['b2'] == 0.4
        assert probs['b3'] == 0.2


class TestPath:
    """Test path analysis."""
    
    def test_full_path(self):
        """Full path between nodes - new declarative schema."""
        G = build_test_graph()
        result = run_path(G, 'start', 'end1')
        
        # Check new schema structure
        assert 'semantics' in result
        assert 'data' in result
        assert result['metadata']['from_node'] == 'start'
        assert result['metadata']['to_node'] == 'end1'
        
        # Check data rows exist (stage × scenario)
        assert len(result['data']) >= 2  # At least start and end stages
        
        # Find final stage probability (stage now uses node ID, not index)
        final_stage_row = [r for r in result['data'] if r['stage'] == 'end1'][0]
        assert final_stage_row['probability'] == pytest.approx(0.8)


class TestPartialPath:
    """Test partial path analysis - new declarative schema."""
    
    def test_partial_with_intermediates(self):
        """Partial path with intermediates."""
        G = build_test_graph()
        result = run_partial_path(G, 'start', ['a'])
        
        assert 'semantics' in result
        assert result['metadata']['from_node'] == 'start'
        # Total probability of all outcomes should sum to 1
        current_rows = [r for r in result['data'] if r['scenario_id'] == 'current']
        total_prob = sum(r['probability'] for r in current_rows)
        assert total_prob == pytest.approx(1.0)


class TestGeneralStats:
    """Test general statistics - new declarative schema."""
    
    def test_general_for_selection(self):
        """General stats for arbitrary selection."""
        G = build_test_graph()
        result = run_general_stats(G, ['a', 'b1', 'c'])
        
        assert 'semantics' in result
        assert result['metadata']['selected_nodes'] == ['a', 'b1', 'c']
        # Data should have one row per node per scenario
        current_rows = [r for r in result['data'] if r['scenario_id'] == 'current']
        assert len(current_rows) == 3


class TestGetRunner:
    """Test runner dispatch."""
    
    def test_get_valid_runner(self):
        """Get valid runner by name."""
        runner = get_runner('path_runner')
        assert runner is not None
        assert callable(runner)
    
    def test_get_invalid_runner(self):
        """Invalid runner returns None."""
        runner = get_runner('nonexistent_runner')
        assert runner is None


class TestVisibilityMode:
    """Test visibility mode (F/E/F+E) probability source selection."""
    
    def test_apply_visibility_mode_mean(self):
        """f+e mode keeps p.mean unchanged."""
        from lib.runner.graph_builder import apply_visibility_mode
        
        G = nx.DiGraph()
        G.add_node('a')
        G.add_node('b')
        G.add_edge('a', 'b', p=0.5, evidence={'mean': 0.3}, forecast={'mean': 0.7})
        
        apply_visibility_mode(G, 'f+e')
        
        assert G.edges['a', 'b']['p'] == 0.5  # Unchanged
    
    def test_apply_visibility_mode_forecast(self):
        """f mode uses p.forecast.mean."""
        from lib.runner.graph_builder import apply_visibility_mode
        
        G = nx.DiGraph()
        G.add_node('a')
        G.add_node('b')
        G.add_edge('a', 'b', p=0.5, evidence={'mean': 0.3}, forecast={'mean': 0.7})
        
        apply_visibility_mode(G, 'f')
        
        assert G.edges['a', 'b']['p'] == 0.7  # Replaced with forecast
    
    def test_apply_visibility_mode_evidence(self):
        """e mode uses p.evidence.mean."""
        from lib.runner.graph_builder import apply_visibility_mode
        
        G = nx.DiGraph()
        G.add_node('a')
        G.add_node('b')
        G.add_edge('a', 'b', p=0.5, evidence={'mean': 0.3}, forecast={'mean': 0.7})
        
        apply_visibility_mode(G, 'e')
        
        assert G.edges['a', 'b']['p'] == 0.3  # Replaced with evidence
    
    def test_apply_visibility_mode_fallback(self):
        """Falls back to p.mean if requested source unavailable."""
        from lib.runner.graph_builder import apply_visibility_mode
        
        G = nx.DiGraph()
        G.add_node('a')
        G.add_node('b')
        G.add_edge('a', 'b', p=0.5)  # No evidence or forecast
        
        apply_visibility_mode(G, 'f')  # Request forecast but none exists
        
        assert G.edges['a', 'b']['p'] == 0.5  # Falls back to p.mean
    
    def test_get_probability_label(self):
        """Probability label matches visibility mode."""
        from lib.runner.graph_builder import get_probability_label
        
        assert get_probability_label('f+e') == 'Probability'
        assert get_probability_label('f') == 'Forecast Probability'
        assert get_probability_label('e') == 'Evidence Probability'
    
    def test_scenario_dimension_has_probability_label(self):
        """Scenario dimension values include probability_label."""
        G = build_test_graph()
        result = run_path_to_end(G, 'end1')
        
        # Check current scenario has probability_label
        scenario_values = result['dimension_values']['scenario_id']
        assert 'current' in scenario_values
        assert 'probability_label' in scenario_values['current']
        assert scenario_values['current']['probability_label'] == 'Probability'


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

