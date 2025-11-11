"""
Tests for graph query operations (apply DSL queries to graphs).
"""

import pytest
import sys
import os

# Add lib/ to path (lib is sibling to tests/ in graph-editor/)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), 'lib'))

from graph_select import apply_query_to_graph


class TestGraphQueryBasic:
    """Test basic graph query operations."""
    
    def test_simple_path_query(self):
        """Find simple path from A to B."""
        graph = {
            "nodes": [
                {"id": "a"},
                {"id": "b"},
                {"id": "c"}
            ],
            "edges": [
                {"from": "a", "to": "b"},
                {"from": "b", "to": "c"}
            ]
        }
        
        result = apply_query_to_graph(graph, "from(a).to(b)")
        
        # Should only include nodes a and b
        node_ids = [n["id"] for n in result["nodes"]]
        assert "a" in node_ids
        assert "b" in node_ids
        assert "c" not in node_ids
        
        # Should only include edge a->b
        assert len(result["edges"]) == 1
        assert result["edges"][0]["from_node"] == "a"
        assert result["edges"][0]["to"] == "b"
    
    def test_transitive_path(self):
        """Find path through multiple nodes."""
        graph = {
            "nodes": [
                {"id": "a"},
                {"id": "b"},
                {"id": "c"}
            ],
            "edges": [
                {"from": "a", "to": "b"},
                {"from": "b", "to": "c"}
            ]
        }
        
        result = apply_query_to_graph(graph, "from(a).to(c)")
        
        # Should include all nodes on path a->b->c
        node_ids = [n["id"] for n in result["nodes"]]
        assert "a" in node_ids
        assert "b" in node_ids
        assert "c" in node_ids
        
        # Should include both edges
        assert len(result["edges"]) == 2
    
    def test_multiple_paths(self):
        """Handle graph with multiple paths to target."""
        graph = {
            "nodes": [
                {"id": "start"},
                {"id": "path1"},
                {"id": "path2"},
                {"id": "end"}
            ],
            "edges": [
                {"from": "start", "to": "path1"},
                {"from": "start", "to": "path2"},
                {"from": "path1", "to": "end"},
                {"from": "path2", "to": "end"}
            ]
        }
        
        result = apply_query_to_graph(graph, "from(start).to(end)")
        
        # Should include all nodes (both paths)
        node_ids = [n["id"] for n in result["nodes"]]
        assert len(node_ids) == 4
        
        # Should include all edges
        assert len(result["edges"]) == 4


class TestGraphQueryConstraints:
    """Test query constraints (exclude, visited)."""
    
    def test_exclude_constraint(self):
        """Exclude specific nodes from paths."""
        graph = {
            "nodes": [
                {"id": "start"},
                {"id": "good"},
                {"id": "bad"},
                {"id": "end"}
            ],
            "edges": [
                {"from": "start", "to": "good"},
                {"from": "start", "to": "bad"},
                {"from": "good", "to": "end"},
                {"from": "bad", "to": "end"}
            ]
        }
        
        result = apply_query_to_graph(graph, "from(start).to(end).exclude(bad)")
        
        # Should NOT include 'bad' node
        node_ids = [n["id"] for n in result["nodes"]]
        assert "bad" not in node_ids
        assert "good" in node_ids
    
    def test_visited_constraint(self):
        """Require specific nodes to be visited."""
        graph = {
            "nodes": [
                {"id": "start"},
                {"id": "checkpoint"},
                {"id": "shortcut"},
                {"id": "end"}
            ],
            "edges": [
                {"from": "start", "to": "checkpoint"},
                {"from": "start", "to": "shortcut"},
                {"from": "checkpoint", "to": "end"},
                {"from": "shortcut", "to": "end"}
            ]
        }
        
        result = apply_query_to_graph(graph, "from(start).to(end).visited(checkpoint)")
        
        # Should only include path through checkpoint
        node_ids = [n["id"] for n in result["nodes"]]
        assert "checkpoint" in node_ids
        assert "shortcut" not in node_ids
    
    def test_combined_constraints(self):
        """Combine visited and exclude constraints."""
        graph = {
            "nodes": [
                {"id": "a"},
                {"id": "b"},
                {"id": "c"},
                {"id": "d"},
                {"id": "e"}
            ],
            "edges": [
                {"from": "a", "to": "b"},
                {"from": "a", "to": "c"},
                {"from": "b", "to": "d"},
                {"from": "c", "to": "d"},
                {"from": "d", "to": "e"}
            ]
        }
        
        result = apply_query_to_graph(graph, "from(a).to(e).visited(b).exclude(c)")
        
        node_ids = [n["id"] for n in result["nodes"]]
        assert "b" in node_ids
        assert "c" not in node_ids


class TestGraphQueryMetadata:
    """Test metadata returned with query results."""
    
    def test_metadata_present(self):
        """Check that metadata is included."""
        graph = {
            "nodes": [{"id": "a"}, {"id": "b"}],
            "edges": [{"from": "a", "to": "b"}]
        }
        
        result = apply_query_to_graph(graph, "from(a).to(b)")
        
        assert "metadata" in result
        assert result["metadata"]["query_stats"]["query"] == "from(a).to(b)"
        assert result["metadata"]["query_stats"]["original_node_count"] == 2
        assert result["metadata"]["query_stats"]["filtered_node_count"] == 2
    
    def test_metadata_counts_filtering(self):
        """Check that metadata reflects filtering."""
        graph = {
            "nodes": [
                {"id": "a"},
                {"id": "b"},
                {"id": "c"},
                {"id": "isolated"}
            ],
            "edges": [
                {"from": "a", "to": "b"},
                {"from": "b", "to": "c"}
            ]
        }
        
        result = apply_query_to_graph(graph, "from(a).to(b)")
        
        # Original has 4 nodes, filtered should have 2
        assert result["metadata"]["query_stats"]["original_node_count"] == 4
        assert result["metadata"]["query_stats"]["filtered_node_count"] == 2


class TestGraphQueryEquivalence:
    """Test query equivalence cases."""
    
    def test_exclude_vs_visited_equivalence(self):
        """Verify exclude(e) ≡ visited(b) when they produce same topology."""
        # Graph: A>B, B>C, C>D, A>E, E>C
        # Two paths: A>B>C>D and A>E>C>D
        graph = {
            "nodes": [
                {"id": "a"}, {"id": "b"}, {"id": "c"}, {"id": "d"}, {"id": "e"}
            ],
            "edges": [
                {"from": "a", "to": "b"},
                {"from": "b", "to": "c"},
                {"from": "c", "to": "d"},
                {"from": "a", "to": "e"},
                {"from": "e", "to": "c"}
            ]
        }
        
        # Query 1: Exclude E (forces A>B>C>D path)
        result1 = apply_query_to_graph(graph, "from(a).to(d).exclude(e)")
        
        # Query 2: Must visit B (forces A>B>C>D path)
        result2 = apply_query_to_graph(graph, "from(a).to(d).visited(b)")
        
        # Should be equivalent
        nodes1 = set(n["id"] for n in result1["nodes"])
        nodes2 = set(n["id"] for n in result2["nodes"])
        assert nodes1 == nodes2
        assert nodes1 == {"a", "b", "c", "d"}
        
        edges1 = set((e["from_node"], e["to"]) for e in result1["edges"])
        edges2 = set((e["from_node"], e["to"]) for e in result2["edges"])
        assert edges1 == edges2
        
        assert result1["metadata"]["query_stats"]["path_count"] == 1
        assert result2["metadata"]["query_stats"]["path_count"] == 1


class TestGraphQueryEdgeCases:
    """Test edge cases and error handling."""
    
    def test_no_path_exists(self):
        """Handle case where no path exists."""
        graph = {
            "nodes": [
                {"id": "a"},
                {"id": "b"}
            ],
            "edges": []
        }
        
        result = apply_query_to_graph(graph, "from(a).to(b)")
        
        # Should return empty result
        assert len(result["nodes"]) == 0
        assert len(result["edges"]) == 0
        assert result["metadata"]["query_stats"]["path_count"] == 0
    
    def test_source_not_in_graph(self):
        """Handle missing source node."""
        graph = {
            "nodes": [{"id": "b"}],
            "edges": []
        }
        
        result = apply_query_to_graph(graph, "from(a).to(b)")
        
        assert len(result["nodes"]) == 0
    
    def test_target_not_in_graph(self):
        """Handle missing target node."""
        graph = {
            "nodes": [{"id": "a"}],
            "edges": []
        }
        
        result = apply_query_to_graph(graph, "from(a).to(b)")
        
        assert len(result["nodes"]) == 0

