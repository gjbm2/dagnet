"""
Tests for graph builder.

Tests NetworkX graph conversion from DagNet format.
"""

import pytest
import networkx as nx
from lib.runner.graph_builder import (
    build_networkx_graph,
    get_graph_stats,
    find_entry_nodes,
    find_absorbing_nodes,
    _extract_probability,
    _extract_cost,
)


def build_simple_graph_data():
    """Simple linear graph: START → A → B → END"""
    return {
        'nodes': [
            {'uuid': 'start', 'id': 'start', 'entry': {'is_start': True}},
            {'uuid': 'a', 'id': 'a'},
            {'uuid': 'b', 'id': 'b'},
            {'uuid': 'end', 'id': 'end', 'absorbing': True},
        ],
        'edges': [
            {'uuid': 'e1', 'from': 'start', 'to': 'a', 'p': {'mean': 1.0}},
            {'uuid': 'e2', 'from': 'a', 'to': 'b', 'p': {'mean': 0.8}},
            {'uuid': 'e3', 'from': 'b', 'to': 'end', 'p': {'mean': 1.0}},
        ],
    }


def build_branching_graph_data():
    """
    Branching graph:
        START → A → B1 → C → END1
                  ↘ B2 ↗
                  ↘ B3 → END2
    """
    return {
        'nodes': [
            {'uuid': 'start', 'id': 'start', 'entry': {'is_start': True}},
            {'uuid': 'a', 'id': 'a'},
            {'uuid': 'b1', 'id': 'b1'},
            {'uuid': 'b2', 'id': 'b2'},
            {'uuid': 'b3', 'id': 'b3'},
            {'uuid': 'c', 'id': 'c'},
            {'uuid': 'end1', 'id': 'end1', 'absorbing': True},
            {'uuid': 'end2', 'id': 'end2', 'absorbing': True},
        ],
        'edges': [
            {'uuid': 'e1', 'from': 'start', 'to': 'a', 'p': {'mean': 1.0}},
            {'uuid': 'e2', 'from': 'a', 'to': 'b1', 'p': {'mean': 0.4}},
            {'uuid': 'e3', 'from': 'a', 'to': 'b2', 'p': {'mean': 0.4}},
            {'uuid': 'e4', 'from': 'a', 'to': 'b3', 'p': {'mean': 0.2}},
            {'uuid': 'e5', 'from': 'b1', 'to': 'c', 'p': {'mean': 1.0}},
            {'uuid': 'e6', 'from': 'b2', 'to': 'c', 'p': {'mean': 1.0}},
            {'uuid': 'e7', 'from': 'b3', 'to': 'end2', 'p': {'mean': 1.0}},
            {'uuid': 'e8', 'from': 'c', 'to': 'end1', 'p': {'mean': 1.0}},
        ],
    }


def build_graph_with_costs():
    """Graph with costs."""
    return {
        'nodes': [
            {'uuid': 'start', 'id': 'start', 'entry': {'is_start': True}},
            {'uuid': 'end', 'id': 'end', 'absorbing': True},
        ],
        'edges': [
            {
                'uuid': 'e1',
                'from': 'start',
                'to': 'end',
                'p': {'mean': 1.0},
                'cost_gbp': {'mean': 100.50},
                'labour_cost': {'mean': 5.0},
            },
        ],
    }


def build_case_graph_data():
    """Graph with case node and variants."""
    return {
        'nodes': [
            {'uuid': 'start', 'id': 'start', 'entry': {'is_start': True}},
            {
                'uuid': 'case1',
                'id': 'case1',
                'case': {
                    'id': 'experiment_a',
                    'variants': [
                        {'name': 'control', 'weight': 0.5},
                        {'name': 'variant_a', 'weight': 0.3},
                        {'name': 'variant_b', 'weight': 0.2},
                    ],
                },
            },
            {'uuid': 'v1_end', 'id': 'v1_end', 'absorbing': True},
            {'uuid': 'v2_end', 'id': 'v2_end', 'absorbing': True},
            {'uuid': 'v3_end', 'id': 'v3_end', 'absorbing': True},
        ],
        'edges': [
            {'uuid': 'e1', 'from': 'start', 'to': 'case1', 'p': {'mean': 1.0}},
            {'uuid': 'e2', 'from': 'case1', 'to': 'v1_end', 'case_id': 'experiment_a', 'case_variant': 'control'},
            {'uuid': 'e3', 'from': 'case1', 'to': 'v2_end', 'case_id': 'experiment_a', 'case_variant': 'variant_a'},
            {'uuid': 'e4', 'from': 'case1', 'to': 'v3_end', 'case_id': 'experiment_a', 'case_variant': 'variant_b'},
        ],
    }


class TestBuildNetworkxGraph:
    """Test graph building."""
    
    def test_simple_graph(self):
        """Build simple linear graph."""
        data = build_simple_graph_data()
        G = build_networkx_graph(data)
        
        assert G.number_of_nodes() == 4
        assert G.number_of_edges() == 3
    
    def test_node_attributes(self):
        """Nodes have correct attributes."""
        data = build_simple_graph_data()
        G = build_networkx_graph(data)
        
        # Entry node
        assert G.nodes['start']['is_entry'] == True
        assert G.nodes['start']['absorbing'] == False
        
        # Absorbing node
        assert G.nodes['end']['absorbing'] == True
        assert G.nodes['end']['is_entry'] == False
        
        # Middle node
        assert G.nodes['a']['absorbing'] == False
        assert G.nodes['a']['is_entry'] == False
    
    def test_edge_probabilities(self):
        """Edges have correct probabilities."""
        data = build_simple_graph_data()
        G = build_networkx_graph(data)
        
        assert G.edges['start', 'a']['p'] == 1.0
        assert G.edges['a', 'b']['p'] == 0.8
        assert G.edges['b', 'end']['p'] == 1.0
    
    def test_edge_costs(self):
        """Edges have correct costs."""
        data = build_graph_with_costs()
        G = build_networkx_graph(data)
        
        edge = G.edges['start', 'end']
        assert edge['cost_gbp'] == 100.50
        assert edge['labour_cost'] == 5.0
    
    def test_branching_graph(self):
        """Build branching graph."""
        data = build_branching_graph_data()
        G = build_networkx_graph(data)
        
        assert G.number_of_nodes() == 8
        assert G.number_of_edges() == 8
        
        # Check branching probabilities
        assert G.edges['a', 'b1']['p'] == 0.4
        assert G.edges['a', 'b2']['p'] == 0.4
        assert G.edges['a', 'b3']['p'] == 0.2
    
    def test_case_node(self):
        """Case nodes are marked correctly."""
        data = build_case_graph_data()
        G = build_networkx_graph(data)
        
        assert G.nodes['case1']['is_case'] == True
        assert G.nodes['case1']['case_data'] is not None
    
    def test_case_edge_probability(self):
        """Case edges get probability from variant weight."""
        data = build_case_graph_data()
        G = build_networkx_graph(data)
        
        # Case edges should use variant weights as probabilities
        assert G.edges['case1', 'v1_end']['p'] == 0.5  # control
        assert G.edges['case1', 'v2_end']['p'] == 0.3  # variant_a
        assert G.edges['case1', 'v3_end']['p'] == 0.2  # variant_b
    
    def test_is_dag(self):
        """Result is a DAG."""
        data = build_simple_graph_data()
        G = build_networkx_graph(data)
        
        assert nx.is_directed_acyclic_graph(G)


class TestGraphStats:
    """Test get_graph_stats."""
    
    def test_simple_stats(self):
        """Stats for simple graph."""
        data = build_simple_graph_data()
        G = build_networkx_graph(data)
        stats = get_graph_stats(G)
        
        assert stats['node_count'] == 4
        assert stats['edge_count'] == 3
        assert stats['entry_nodes'] == ['start']
        assert stats['absorbing_nodes'] == ['end']
        assert stats['is_dag'] == True
    
    def test_branching_stats(self):
        """Stats for branching graph."""
        data = build_branching_graph_data()
        G = build_networkx_graph(data)
        stats = get_graph_stats(G)
        
        assert stats['node_count'] == 8
        assert stats['edge_count'] == 8
        assert stats['entry_nodes'] == ['start']
        assert set(stats['absorbing_nodes']) == {'end1', 'end2'}
    
    def test_case_stats(self):
        """Stats include case nodes."""
        data = build_case_graph_data()
        G = build_networkx_graph(data)
        stats = get_graph_stats(G)
        
        assert stats['case_nodes'] == ['case1']


class TestFindNodes:
    """Test node finding functions."""
    
    def test_find_entry_nodes(self):
        """Find entry nodes by flag."""
        data = build_simple_graph_data()
        G = build_networkx_graph(data)
        
        entries = find_entry_nodes(G)
        assert entries == ['start']
    
    def test_find_absorbing_nodes(self):
        """Find absorbing nodes by flag."""
        data = build_simple_graph_data()
        G = build_networkx_graph(data)
        
        absorbing = find_absorbing_nodes(G)
        assert absorbing == ['end']
    
    def test_find_multiple_absorbing(self):
        """Find multiple absorbing nodes."""
        data = build_branching_graph_data()
        G = build_networkx_graph(data)
        
        absorbing = find_absorbing_nodes(G)
        assert set(absorbing) == {'end1', 'end2'}


class TestExtractProbability:
    """Test probability extraction."""
    
    def test_dict_format(self):
        """Extract from {mean: value} format."""
        edge = {'p': {'mean': 0.75}}
        assert _extract_probability(edge, {}) == 0.75
    
    def test_raw_float(self):
        """Extract from raw float."""
        edge = {'p': 0.5}
        assert _extract_probability(edge, {}) == 0.5
    
    def test_missing(self):
        """Missing probability returns None."""
        edge = {}
        assert _extract_probability(edge, {}) is None


class TestExtractCost:
    """Test cost extraction."""
    
    def test_dict_format(self):
        """Extract from {mean: value} format."""
        assert _extract_cost({'mean': 100.0}) == 100.0
    
    def test_raw_float(self):
        """Extract from raw float."""
        assert _extract_cost(50.0) == 50.0
    
    def test_missing(self):
        """Missing cost returns 0."""
        assert _extract_cost(None) == 0.0


class TestEmptyGraph:
    """Test edge cases."""
    
    def test_empty_data(self):
        """Handle empty graph data."""
        G = build_networkx_graph({})
        assert G.number_of_nodes() == 0
        assert G.number_of_edges() == 0
    
    def test_missing_keys(self):
        """Handle missing keys gracefully."""
        G = build_networkx_graph({'nodes': [], 'edges': []})
        assert G.number_of_nodes() == 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

