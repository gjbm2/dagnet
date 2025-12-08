"""
Tests for path analysis runner.

Tests probability and cost calculations.
"""

import pytest
import networkx as nx
from lib.runner.path_runner import (
    calculate_path_probability,
    calculate_path_through_node,
    calculate_path_to_absorbing,
    compute_pruning,
    run_path_analysis,
)


def build_linear_graph():
    """Linear graph: START → A → B → END (all p=1)"""
    G = nx.DiGraph()
    G.add_node('start', is_entry=True, absorbing=False)
    G.add_node('a', is_entry=False, absorbing=False)
    G.add_node('b', is_entry=False, absorbing=False)
    G.add_node('end', is_entry=False, absorbing=True)
    
    G.add_edge('start', 'a', p=1.0, cost_gbp=10.0, labour_cost=1.0)
    G.add_edge('a', 'b', p=1.0, cost_gbp=20.0, labour_cost=2.0)
    G.add_edge('b', 'end', p=1.0, cost_gbp=30.0, labour_cost=3.0)
    
    return G


def build_branching_graph():
    """
    Branching graph with probabilities:
        START → A (p=1.0)
        A → B1 (p=0.4) → C (p=1.0)
        A → B2 (p=0.4) → C (p=1.0)
        A → B3 (p=0.2) → END2 (p=1.0)
        C → END1 (p=1.0)
    """
    G = nx.DiGraph()
    G.add_node('start', is_entry=True, absorbing=False)
    G.add_node('a', is_entry=False, absorbing=False)
    G.add_node('b1', is_entry=False, absorbing=False)
    G.add_node('b2', is_entry=False, absorbing=False)
    G.add_node('b3', is_entry=False, absorbing=False)
    G.add_node('c', is_entry=False, absorbing=False)
    G.add_node('end1', is_entry=False, absorbing=True)
    G.add_node('end2', is_entry=False, absorbing=True)
    
    G.add_edge('start', 'a', p=1.0, cost_gbp=0, labour_cost=0)
    G.add_edge('a', 'b1', p=0.4, cost_gbp=10, labour_cost=1)
    G.add_edge('a', 'b2', p=0.4, cost_gbp=10, labour_cost=1)
    G.add_edge('a', 'b3', p=0.2, cost_gbp=10, labour_cost=1)
    G.add_edge('b1', 'c', p=1.0, cost_gbp=0, labour_cost=0)
    G.add_edge('b2', 'c', p=1.0, cost_gbp=0, labour_cost=0)
    G.add_edge('b3', 'end2', p=1.0, cost_gbp=0, labour_cost=0)
    G.add_edge('c', 'end1', p=1.0, cost_gbp=0, labour_cost=0)
    
    return G


class TestCalculatePathProbability:
    """Test basic path probability calculation."""
    
    def test_linear_path(self):
        """Linear path has probability 1.0."""
        G = build_linear_graph()
        result = calculate_path_probability(G, 'start', 'end')
        
        assert result.probability == pytest.approx(1.0)
        assert result.path_exists == True
    
    def test_linear_path_costs(self):
        """Linear path accumulates all costs."""
        G = build_linear_graph()
        result = calculate_path_probability(G, 'start', 'end')
        
        # Total cost = 10 + 20 + 30 = 60 GBP
        assert result.expected_cost_gbp == pytest.approx(60.0)
        # Total time = 1 + 2 + 3 = 6
        assert result.expected_labour_cost == pytest.approx(6.0)
    
    def test_partial_path(self):
        """Partial path has correct probability."""
        G = build_linear_graph()
        result = calculate_path_probability(G, 'a', 'end')
        
        assert result.probability == pytest.approx(1.0)
        # Cost excludes start→a edge
        assert result.expected_cost_gbp == pytest.approx(50.0)
    
    def test_branching_to_end1(self):
        """Path to END1 through branches."""
        G = build_branching_graph()
        result = calculate_path_probability(G, 'start', 'end1')
        
        # P(END1) = P(B1) + P(B2) = 0.4 + 0.4 = 0.8
        assert result.probability == pytest.approx(0.8)
    
    def test_branching_to_end2(self):
        """Path to END2 through B3."""
        G = build_branching_graph()
        result = calculate_path_probability(G, 'start', 'end2')
        
        # P(END2) = P(B3) = 0.2
        assert result.probability == pytest.approx(0.2)
    
    def test_invalid_start(self):
        """Invalid start node returns no path."""
        G = build_linear_graph()
        result = calculate_path_probability(G, 'invalid', 'end')
        
        assert result.probability == 0.0
        assert result.path_exists == False
    
    def test_invalid_end(self):
        """Invalid end node returns no path."""
        G = build_linear_graph()
        result = calculate_path_probability(G, 'start', 'invalid')
        
        assert result.probability == 0.0
        assert result.path_exists == False


class TestPruning:
    """Test pruning and renormalization."""
    
    def test_prune_single_sibling(self):
        """Pruning single sibling removes other branches."""
        G = build_branching_graph()
        
        # visited(b1) should prune b2 and b3
        pruning = compute_pruning(G, visited_nodes=['b1'])
        
        assert ('a', 'b2') in pruning.excluded_edges
        assert ('a', 'b3') in pruning.excluded_edges
        assert ('a', 'b1') not in pruning.excluded_edges
    
    def test_renormalization(self):
        """Remaining edges are renormalized to sum to 1."""
        G = build_branching_graph()
        
        # visited(b1) has p=0.4, so renorm factor = 1/0.4 = 2.5
        pruning = compute_pruning(G, visited_nodes=['b1'])
        
        # Check renorm factor
        assert ('a', 'b1') in pruning.renorm_factors
        assert pruning.renorm_factors[('a', 'b1')] == pytest.approx(2.5)
    
    def test_path_with_pruning(self):
        """Path calculation applies pruning."""
        G = build_branching_graph()
        
        # With visited(b1), path to END1 should be 1.0 (renormalized)
        pruning = compute_pruning(G, visited_nodes=['b1'])
        result = calculate_path_probability(G, 'start', 'end1', pruning)
        
        assert result.probability == pytest.approx(1.0)
    
    def test_visited_any(self):
        """visitedAny keeps multiple siblings."""
        G = build_branching_graph()
        
        # visitedAny(b1, b2) should keep both, prune b3
        pruning = compute_pruning(G, visited_nodes=[], visited_any_groups=[['b1', 'b2']])
        
        assert ('a', 'b3') in pruning.excluded_edges
        assert ('a', 'b1') not in pruning.excluded_edges
        assert ('a', 'b2') not in pruning.excluded_edges
    
    def test_visited_any_renormalization(self):
        """visitedAny renormalizes proportionally."""
        G = build_branching_graph()
        
        # visitedAny(b1, b2) keeps p=0.4+0.4=0.8
        # Renorm factor = 1/0.8 = 1.25
        pruning = compute_pruning(G, visited_nodes=[], visited_any_groups=[['b1', 'b2']])
        
        # b1 and b2 should have same renorm factor
        assert pruning.renorm_factors.get(('a', 'b1')) == pytest.approx(1.25)
        assert pruning.renorm_factors.get(('a', 'b2')) == pytest.approx(1.25)
    
    def test_path_with_visited_any(self):
        """Path calculation with visitedAny."""
        G = build_branching_graph()
        
        pruning = compute_pruning(G, visited_nodes=[], visited_any_groups=[['b1', 'b2']])
        result = calculate_path_probability(G, 'start', 'end1', pruning)
        
        # Both b1 and b2 lead to end1, renormalized to sum to 1.0
        assert result.probability == pytest.approx(1.0)


class TestPathThroughNode:
    """Test path through node analysis."""
    
    def test_through_middle_node(self):
        """Calculate paths through middle node."""
        G = build_linear_graph()
        result = calculate_path_through_node(G, 'a')
        
        # Linear graph: everything goes through A
        assert result.probability == pytest.approx(1.0)
    
    def test_through_branch_node(self):
        """Calculate paths through branch node."""
        G = build_branching_graph()
        result = calculate_path_through_node(G, 'b1')
        
        # P(through b1) = P(reach b1) * P(reach end from b1)
        # = 0.4 * 1.0 = 0.4
        assert result.probability == pytest.approx(0.4)


class TestPathToAbsorbing:
    """Test path to absorbing node analysis."""
    
    def test_to_single_end(self):
        """Path to single absorbing node."""
        G = build_linear_graph()
        result = calculate_path_to_absorbing(G, 'end')
        
        assert result.probability == pytest.approx(1.0)
    
    def test_to_branching_end(self):
        """Path to one of multiple absorbing nodes."""
        G = build_branching_graph()
        result = calculate_path_to_absorbing(G, 'end1')
        
        # P(END1) = 0.8
        assert result.probability == pytest.approx(0.8)


class TestRunPathAnalysis:
    """Test high-level run_path_analysis function."""
    
    def test_full_path(self):
        """Full path analysis with from and to."""
        G = build_linear_graph()
        result = run_path_analysis(G, 'start', 'end')
        
        assert result['analysis_type'] == 'path'
        assert result['probability'] == pytest.approx(1.0)
        assert result['from_node'] == 'start'
        assert result['to_node'] == 'end'
    
    def test_path_to_end(self):
        """Path to end without from."""
        G = build_branching_graph()
        result = run_path_analysis(G, None, 'end1')
        
        assert result['analysis_type'] == 'path_to_end'
        assert result['probability'] == pytest.approx(0.8)
    
    def test_path_through(self):
        """Path through node without to."""
        G = build_branching_graph()
        result = run_path_analysis(G, 'b1', None)
        
        assert result['analysis_type'] == 'path_through'
    
    def test_with_visited_constraint(self):
        """Path analysis with visited constraint."""
        G = build_branching_graph()
        result = run_path_analysis(
            G, 'start', 'end1',
            visited_nodes=['b1']
        )
        
        assert result['analysis_type'] == 'path'
        assert result['probability'] == pytest.approx(1.0)
        assert result['visited_constraints'] == ['b1']
    
    def test_general_analysis(self):
        """General analysis without from/to."""
        G = build_branching_graph()
        result = run_path_analysis(G, None, None)
        
        assert result['analysis_type'] == 'general'
        assert 'graph_stats' in result


class TestEdgeCases:
    """Test edge cases and error handling."""
    
    def test_empty_graph(self):
        """Handle empty graph."""
        G = nx.DiGraph()
        result = calculate_path_probability(G, 'a', 'b')
        
        assert result.probability == 0.0
        assert result.path_exists == False
    
    def test_disconnected_nodes(self):
        """Handle disconnected nodes."""
        G = nx.DiGraph()
        G.add_node('a', is_entry=True)
        G.add_node('b', absorbing=True)
        # No edge between them
        
        result = calculate_path_probability(G, 'a', 'b')
        assert result.probability == 0.0
    
    def test_missing_probability(self):
        """Handle edges with missing probability."""
        G = nx.DiGraph()
        G.add_node('a', is_entry=True)
        G.add_node('b', absorbing=True)
        G.add_edge('a', 'b')  # No p attribute
        
        result = calculate_path_probability(G, 'a', 'b')
        # Should treat missing p as 0
        assert result.probability == 0.0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

