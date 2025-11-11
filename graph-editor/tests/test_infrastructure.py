"""
Infrastructure validation tests.

These tests verify that the Python environment is set up correctly
and core types/fixtures are working. They do NOT test algorithms.
"""

import pytest
from lib.graph_types import Graph, Node, Edge, ProbabilityParam
from tests.fixtures.graphs import minimal_graph, simple_funnel, graph_with_conditionals


class TestGraphTypes:
    """Test that Pydantic models validate correctly."""
    
    def test_minimal_graph_valid(self):
        """Minimal graph should be valid."""
        graph = minimal_graph()
        assert isinstance(graph, Graph)
        assert len(graph.nodes) == 2
        assert len(graph.edges) == 1
    
    def test_graph_node_lookup(self):
        """Graph should provide node lookup by ID."""
        graph = minimal_graph()
        node = graph.get_node_by_id("a")
        assert node is not None
        assert node.id == "a"
    
    def test_graph_edge_lookup(self):
        """Graph should provide edge lookup by ID."""
        graph = minimal_graph()
        edge = graph.get_edge_by_id("a-to-b")
        assert edge is not None
        assert edge.from_node == "a"
        assert edge.to == "b"
    
    def test_outgoing_edges(self):
        """Graph should return outgoing edges for a node."""
        graph = simple_funnel()
        outgoing = graph.get_outgoing_edges("homepage")
        assert len(outgoing) == 1
        assert outgoing[0].to == "product"
    
    def test_incoming_edges(self):
        """Graph should return incoming edges for a node."""
        graph = simple_funnel()
        incoming = graph.get_incoming_edges("checkout")
        assert len(incoming) == 1
        assert incoming[0].from_node == "product"


class TestFixtures:
    """Test that fixtures are valid and usable."""
    
    def test_minimal_graph_fixture(self):
        """minimal_graph fixture should create valid graph."""
        graph = minimal_graph()
        assert graph.nodes[0].id == "a"
        assert graph.nodes[1].id == "b"
        assert graph.edges[0].p.mean == 1.0
    
    def test_simple_funnel_fixture(self):
        """simple_funnel fixture should create 3-node funnel."""
        graph = simple_funnel()
        assert len(graph.nodes) == 3
        assert len(graph.edges) == 2
        assert graph.nodes[-1].absorbing is True
    
    def test_conditionals_fixture(self):
        """graph_with_conditionals should have conditional probabilities."""
        graph = graph_with_conditionals()
        # Find edge with conditionals
        conditional_edge = None
        for edge in graph.edges:
            if edge.conditional_p:
                conditional_edge = edge
                break
        
        assert conditional_edge is not None
        assert len(conditional_edge.conditional_p) > 0
        assert conditional_edge.conditional_p[0].condition == "visited(promo)"


class TestPydanticValidation:
    """Test that Pydantic validation works correctly."""
    
    def test_probability_range_validation(self):
        """Probability should be between 0 and 1."""
        with pytest.raises(Exception):  # Pydantic ValidationError
            ProbabilityParam(mean=1.5)  # Invalid: > 1
    
    def test_required_fields(self):
        """Required fields should be enforced."""
        with pytest.raises(Exception):  # Pydantic ValidationError
            Graph(nodes=[], edges=[])  # Missing policies and metadata
    
    def test_field_aliases(self):
        """'from' field alias should work."""
        edge = Edge(
            uuid="test-uuid",
            **{'from': "node-a"},
            to="node-b",
            p=ProbabilityParam(mean=0.5)
        )
        assert edge.from_node == "node-a"


if __name__ == "__main__":
    # Run with: python -m pytest tests/test_infrastructure.py -v
    pytest.main([__file__, "-v"])

