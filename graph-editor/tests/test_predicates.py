"""
Tests for selection predicates computation.

Tests the predicate extraction logic used for analysis type matching.
"""

import pytest
import networkx as nx
from lib.runner.predicates import (
    compute_selection_predicates,
    get_node_type,
    _check_all_siblings,
    _find_sibling_groups,
)


def build_test_graph():
    """
    Build a test graph for predicate tests.
    
    Structure:
        START → A → B1 → C → END1
                  ↘ B2 ↗
                  ↘ B3 → END2
    """
    G = nx.DiGraph()
    
    # Add nodes
    G.add_node('start', id='start', is_entry=True, absorbing=False)
    G.add_node('a', id='a', is_entry=False, absorbing=False)
    G.add_node('b1', id='b1', is_entry=False, absorbing=False)
    G.add_node('b2', id='b2', is_entry=False, absorbing=False)
    G.add_node('b3', id='b3', is_entry=False, absorbing=False)
    G.add_node('c', id='c', is_entry=False, absorbing=False)
    G.add_node('end1', id='end1', is_entry=False, absorbing=True)
    G.add_node('end2', id='end2', is_entry=False, absorbing=True)
    
    # Add edges
    G.add_edge('start', 'a', p=1.0)
    G.add_edge('a', 'b1', p=0.4)
    G.add_edge('a', 'b2', p=0.4)
    G.add_edge('a', 'b3', p=0.2)
    G.add_edge('b1', 'c', p=1.0)
    G.add_edge('b2', 'c', p=1.0)
    G.add_edge('b3', 'end2', p=1.0)
    G.add_edge('c', 'end1', p=1.0)
    
    return G


class TestBasicPredicates:
    """Test basic predicate computation."""
    
    def test_empty_selection(self):
        """Empty selection returns zero counts."""
        G = build_test_graph()
        predicates = compute_selection_predicates(G, [])
        
        assert predicates['node_count'] == 0
        assert predicates['all_absorbing'] == False
        assert predicates['has_unique_start'] == False
        assert predicates['has_unique_end'] == False
    
    def test_single_node_middle(self):
        """Single middle node selection."""
        G = build_test_graph()
        predicates = compute_selection_predicates(G, ['b1'])
        
        assert predicates['node_count'] == 1
        assert predicates['all_absorbing'] == False
        assert predicates['has_unique_start'] == True
        assert predicates['has_unique_end'] == True
        assert predicates['start_node'] == 'b1'
        assert predicates['end_node'] == 'b1'
    
    def test_single_node_entry(self):
        """Single entry node selection."""
        G = build_test_graph()
        predicates = compute_selection_predicates(G, ['start'])
        
        assert predicates['node_count'] == 1
        assert predicates['is_graph_entry'] == True
        assert predicates['is_graph_absorbing'] == False
    
    def test_single_node_absorbing(self):
        """Single absorbing node selection."""
        G = build_test_graph()
        predicates = compute_selection_predicates(G, ['end1'])
        
        assert predicates['node_count'] == 1
        assert predicates['all_absorbing'] == True
        assert predicates['is_graph_absorbing'] == True
    
    def test_two_node_sequential(self):
        """Two sequential nodes."""
        G = build_test_graph()
        predicates = compute_selection_predicates(G, ['a', 'b1'])
        
        assert predicates['node_count'] == 2
        assert predicates['has_unique_start'] == True
        assert predicates['has_unique_end'] == True
        assert predicates['start_node'] == 'a'
        assert predicates['end_node'] == 'b1'
        assert predicates['is_sequential'] == True


class TestAbsorbingPredicates:
    """Test all_absorbing predicate."""
    
    def test_all_absorbing_true(self):
        """All selected nodes are absorbing."""
        G = build_test_graph()
        predicates = compute_selection_predicates(G, ['end1', 'end2'])
        
        assert predicates['all_absorbing'] == True
        assert predicates['node_count'] == 2
    
    def test_all_absorbing_false(self):
        """Not all selected nodes are absorbing."""
        G = build_test_graph()
        predicates = compute_selection_predicates(G, ['end1', 'c'])
        
        assert predicates['all_absorbing'] == False


class TestSiblingPredicates:
    """Test sibling detection."""
    
    def test_all_siblings(self):
        """All selected nodes are siblings (share parent)."""
        G = build_test_graph()
        predicates = compute_selection_predicates(G, ['b1', 'b2', 'b3'])
        
        assert predicates['all_are_siblings'] == True
        assert predicates['node_count'] == 3
    
    def test_partial_siblings(self):
        """Two siblings selected, plus non-sibling."""
        G = build_test_graph()
        predicates = compute_selection_predicates(G, ['b1', 'b2'])
        
        # b1 and b2 share parent 'a'
        assert predicates['all_are_siblings'] == True
    
    def test_not_siblings(self):
        """Selected nodes don't share parent."""
        G = build_test_graph()
        predicates = compute_selection_predicates(G, ['a', 'end1'])
        
        assert predicates['all_are_siblings'] == False
    
    def test_sibling_groups(self):
        """Find sibling groups in selection."""
        G = build_test_graph()
        predicates = compute_selection_predicates(G, ['b1', 'b2', 'c'])
        
        groups = predicates['sibling_groups']
        # b1 and b2 should be in one group, c in another
        assert len(groups) >= 1


class TestPathPredicates:
    """Test path-related predicates."""
    
    def test_unique_start_end(self):
        """Selection with unique start and end."""
        G = build_test_graph()
        predicates = compute_selection_predicates(G, ['a', 'b1', 'c'])
        
        assert predicates['has_unique_start'] == True
        assert predicates['has_unique_end'] == True
        assert predicates['start_node'] == 'a'
        assert predicates['end_node'] == 'c'
    
    def test_multiple_starts(self):
        """Selection with multiple possible starts."""
        G = build_test_graph()
        # b1 and b2 both have 'a' as parent, but a not selected
        # So both b1 and b2 are "starts" within selection
        predicates = compute_selection_predicates(G, ['b1', 'b2', 'c'])
        
        # Both b1 and b2 have no selected predecessors
        assert predicates['has_unique_start'] == False
        assert len(predicates['start_nodes']) == 2
    
    def test_sequential_path(self):
        """Sequential path detection."""
        G = build_test_graph()
        predicates = compute_selection_predicates(G, ['a', 'b1', 'c'])
        
        # a→b1→c is sequential
        assert predicates['is_sequential'] == True
        assert predicates['sorted_nodes'] == ['a', 'b1', 'c']
        assert predicates['intermediate_nodes'] == ['b1']
    
    def test_non_sequential(self):
        """Non-sequential selection (no direct edges)."""
        G = build_test_graph()
        predicates = compute_selection_predicates(G, ['start', 'c'])
        
        # No direct edge start→c
        assert predicates['is_sequential'] == False


class TestScenarioPredicates:
    """Test scenario-related predicates."""
    
    def test_single_scenario(self):
        """Single scenario (default)."""
        G = build_test_graph()
        predicates = compute_selection_predicates(G, ['a'], scenario_count=1)
        
        assert predicates['scenario_count'] == 1
        assert predicates['multiple_scenarios'] == False
    
    def test_multiple_scenarios(self):
        """Multiple scenarios."""
        G = build_test_graph()
        predicates = compute_selection_predicates(G, ['a'], scenario_count=3)
        
        assert predicates['scenario_count'] == 3
        assert predicates['multiple_scenarios'] == True


class TestNodeType:
    """Test get_node_type helper."""
    
    def test_entry_node(self):
        """Entry node detection."""
        G = build_test_graph()
        assert get_node_type(G, 'start') == 'entry'
    
    def test_absorbing_node(self):
        """Absorbing node detection."""
        G = build_test_graph()
        assert get_node_type(G, 'end1') == 'absorbing'
    
    def test_middle_node(self):
        """Middle node detection."""
        G = build_test_graph()
        assert get_node_type(G, 'b1') == 'middle'
    
    def test_unknown_node(self):
        """Unknown node ID."""
        G = build_test_graph()
        assert get_node_type(G, 'nonexistent') == 'unknown'


class TestSiblingHelpers:
    """Test sibling helper functions."""
    
    def test_check_all_siblings_true(self):
        """All nodes share common parent."""
        G = build_test_graph()
        assert _check_all_siblings(G, ['b1', 'b2', 'b3']) == True
    
    def test_check_all_siblings_false(self):
        """Nodes don't share common parent."""
        G = build_test_graph()
        assert _check_all_siblings(G, ['a', 'c']) == False
    
    def test_check_all_siblings_single(self):
        """Single node is not siblings."""
        G = build_test_graph()
        assert _check_all_siblings(G, ['a']) == False
    
    def test_find_sibling_groups(self):
        """Group nodes by shared parent."""
        G = build_test_graph()
        groups = _find_sibling_groups(G, ['b1', 'b2', 'b3'])
        
        # All should be in one group (share parent 'a')
        assert len(groups) == 1
        assert set(groups[0]) == {'b1', 'b2', 'b3'}


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

