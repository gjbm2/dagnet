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
    
    G.add_edge('start', 'a', p=1.0, cost_gbp=0, cost_time=0)
    G.add_edge('a', 'b1', p=0.4, cost_gbp=10, cost_time=1)
    G.add_edge('a', 'b2', p=0.4, cost_gbp=10, cost_time=1)
    G.add_edge('a', 'b3', p=0.2, cost_gbp=10, cost_time=1)
    G.add_edge('b1', 'c', p=1.0, cost_gbp=0, cost_time=0)
    G.add_edge('b2', 'c', p=1.0, cost_gbp=0, cost_time=0)
    G.add_edge('b3', 'end2', p=1.0, cost_gbp=0, cost_time=0)
    G.add_edge('c', 'end1', p=1.0, cost_gbp=0, cost_time=0)
    
    return G


class TestSingleNodeEntry:
    """Test entry node analysis."""
    
    def test_entry_analysis(self):
        """Analyze entry node shows all outcomes."""
        G = build_test_graph()
        result = run_single_node_entry(G, 'start')
        
        assert result['analysis_type'] == 'entry_node'
        assert result['node_id'] == 'start'
        assert len(result['outcomes']) == 2  # end1 and end2
        assert result['total_probability'] == pytest.approx(1.0)
    
    def test_outcome_probabilities(self):
        """Outcome probabilities are correct."""
        G = build_test_graph()
        result = run_single_node_entry(G, 'start')
        
        outcomes_by_id = {o['node_id']: o for o in result['outcomes']}
        
        assert outcomes_by_id['end1']['probability'] == pytest.approx(0.8)
        assert outcomes_by_id['end2']['probability'] == pytest.approx(0.2)


class TestPathToEnd:
    """Test path to absorbing analysis."""
    
    def test_to_end1(self):
        """Path to end1."""
        G = build_test_graph()
        result = run_path_to_end(G, 'end1')
        
        assert result['analysis_type'] == 'outcome_probability'
        assert result['probability'] == pytest.approx(0.8)
        assert result['node_label'] == 'Success'
    
    def test_to_end2(self):
        """Path to end2."""
        G = build_test_graph()
        result = run_path_to_end(G, 'end2')
        
        assert result['probability'] == pytest.approx(0.2)


class TestPathThrough:
    """Test path through node analysis."""
    
    def test_through_branch(self):
        """Path through branch node."""
        G = build_test_graph()
        result = run_path_through(G, 'b1')
        
        assert result['analysis_type'] == 'path_through'
        assert result['probability'] == pytest.approx(0.4)
        assert len(result['path_breakdown']) > 0


class TestEndComparison:
    """Test end node comparison."""
    
    def test_compare_ends(self):
        """Compare two end nodes."""
        G = build_test_graph()
        result = run_end_comparison(G, ['end1', 'end2'])
        
        assert result['analysis_type'] == 'end_comparison'
        assert len(result['comparisons']) == 2
        assert result['total_probability'] == pytest.approx(1.0)
        assert result['is_exhaustive'] == True
    
    def test_sorted_by_probability(self):
        """Results are sorted by probability."""
        G = build_test_graph()
        result = run_end_comparison(G, ['end1', 'end2'])
        
        # end1 has higher probability, should be first
        assert result['comparisons'][0]['node_id'] == 'end1'


class TestBranchComparison:
    """Test branch comparison."""
    
    def test_compare_branches(self):
        """Compare sibling branches."""
        G = build_test_graph()
        result = run_branch_comparison(G, ['b1', 'b2', 'b3'])
        
        assert result['analysis_type'] == 'branch_comparison'
        assert len(result['comparisons']) == 3
    
    def test_edge_probabilities(self):
        """Edge probabilities are included."""
        G = build_test_graph()
        result = run_branch_comparison(G, ['b1', 'b2', 'b3'])
        
        probs = {c['node_id']: c['edge_probability'] for c in result['comparisons']}
        assert probs['b1'] == 0.4
        assert probs['b2'] == 0.4
        assert probs['b3'] == 0.2


class TestPath:
    """Test path analysis."""
    
    def test_full_path(self):
        """Full path between nodes."""
        G = build_test_graph()
        result = run_path(G, 'start', 'end1')
        
        assert result['analysis_type'] == 'path'
        assert result['probability'] == pytest.approx(0.8)
        assert result['from_node'] == 'start'
        assert result['to_node'] == 'end1'


class TestPartialPath:
    """Test partial path analysis."""
    
    def test_partial_with_intermediates(self):
        """Partial path with intermediates."""
        G = build_test_graph()
        result = run_partial_path(G, 'start', ['a'])
        
        assert result['analysis_type'] == 'partial_path'
        assert result['from_node'] == 'start'
        assert result['total_probability'] == pytest.approx(1.0)


class TestGeneralStats:
    """Test general statistics."""
    
    def test_general_for_selection(self):
        """General stats for arbitrary selection."""
        G = build_test_graph()
        result = run_general_stats(G, ['a', 'b1', 'c'])
        
        assert result['analysis_type'] == 'general_stats'
        assert len(result['node_breakdown']) == 3
        assert 'graph_stats' in result


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


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

