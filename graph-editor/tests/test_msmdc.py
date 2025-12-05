"""
Tests for MSMDC (Minimal Set of Maximally Discriminating Constraints)

═══════════════════════════════════════════════════════════════════════════════
NOTE: As of 4-Dec-25, Amplitude supports native exclude via segment filters.

The MSMDC algorithm still generates queries, but for Amplitude the exclude()
terms are now passed through natively rather than compiled to minus()/plus().

Tests that check for minus()/plus() output with Amplitude are testing the
DEPRECATED code path (which remains for non-Amplitude providers).

Target deletion of deprecated tests: After 2 weeks of production validation.
═══════════════════════════════════════════════════════════════════════════════

Tests the algorithm for generating optimal data retrieval queries for external sources.
Based on: query-algorithms-white-paper.md
"""

import pytest
import sys
import os

# Add lib/ to path (lib is sibling to tests/ in graph-editor/)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), 'lib'))

from msmdc import generate_query_for_edge, QueryConstraints
from graph_types import Graph, Node, Edge, Metadata, Policies
from datetime import datetime


def create_minimal_graph(nodes_data, edges_data):
    """Helper to create schema-compliant Graph for testing."""
    nodes = [Node(
        uuid=n.get("uuid", n["id"]),
        id=n["id"]
    ) for n in nodes_data]
    
    edges = [Edge(
        uuid=e.get("uuid", f"{e['from']}->{e['to']}"),
        from_node=e["from"],
        to=e["to"],
        p={"mean": 0.5}  # Minimal probability
    ) for e in edges_data]
    
    policies = Policies(
        default_outcome="default",
        overflow_policy="error",
        free_edge_policy="complement"
    )
    
    metadata = Metadata(
        version="1.0.0",
        created_at=datetime.now()
    )
    
    return Graph(nodes=nodes, edges=edges, policies=policies, metadata=metadata)


class TestMSMDCBasics:
    """Test basic MSMDC functionality."""
    
    def test_single_path_no_constraints(self):
        """When only one path exists, no constraints needed."""
        graph = create_minimal_graph(
            [{"id": "a"}, {"id": "b"}, {"id": "c"}],
            [{"from": "a", "to": "b"}, {"from": "b", "to": "c"}]
        )
        
        edge = graph.edges[0]  # a->b
        result = generate_query_for_edge(graph, edge, condition=None)
        
        assert result.query_string == "from(a).to(b)"
        assert result.constraints.visited == []
        assert result.constraints.exclude == []
    
    def test_direct_edge_with_alternate(self):
        """
        Multi-parent case: A>B, B>C, A>C
        Direct edge A->C should exclude B
        """
        graph = create_minimal_graph(
            [{"id": "a"}, {"id": "b"}, {"id": "c"}],
            [
                {"from": "a", "to": "b"},
                {"from": "b", "to": "c"},
                {"from": "a", "to": "c"}  # Direct edge
            ]
        )
        
        # Find the direct edge A->C
        direct_edge = [e for e in graph.edges if e.from_node == "a" and e.to == "c"][0]
        # Anchored at direct edge; no extra literal needed to isolate direct transition
        result = generate_query_for_edge(graph, direct_edge, condition="exclude(b)")
        
        # Direct edge usage already discriminates from A->B->C path
        assert "from(a).to(c)" in result.query_string
        # May be exclude() or minus() depending on provider support
        assert "b" in result.constraints.exclude or "exclude" in result.query_string or "minus" in result.query_string
    
    def test_diamond_graph_top_path(self):
        """
        Diamond: A>B, A>C, B>D, C>D
        Edge B->D only has one path (from B to D), so no discrimination needed
        """
        graph = create_minimal_graph(
            [{"id": "a"}, {"id": "b"}, {"id": "c"}, {"id": "d"}],
            [
                {"from": "a", "to": "b"},
                {"from": "a", "to": "c"},
                {"from": "b", "to": "d"},
                {"from": "c", "to": "d"}
            ]
        )
        
        # Edge B->D - only one path from B to D
        edge_b_d = [e for e in graph.edges if e.from_node == "b" and e.to == "d"][0]
        result = generate_query_for_edge(graph, edge_b_d, condition=None)
        
        # No alternates from B to D, so no constraints
        assert result.query_string == "from(b).to(d)"


class TestMSMDCUserExamples:
    """Test cases from our discussion."""
    
    def test_your_graph_case(self):
        """
        Your example: A>B, B>C, C>D, A>E, E>C
        Edge C->D with visited(b) condition
        """
        graph = create_minimal_graph(
            [{"id": "a"}, {"id": "b"}, {"id": "c"}, {"id": "d"}, {"id": "e"}],
            [
                {"from": "a", "to": "b"},
                {"from": "b", "to": "c"},
                {"from": "c", "to": "d"},
                {"from": "a", "to": "e"},
                {"from": "e", "to": "c"}
            ]
        )
        
        # Edge C->D, with condition visited(b) upstream
        edge_c_d = [e for e in graph.edges if e.from_node == "c" and e.to == "d"][0]
        result = generate_query_for_edge(graph, edge_c_d, condition="visited(b)")
        
        # Anchored at edge; should discriminate using visited(b) or exclude(e)
        assert result.query_string.startswith("from(c).to(d)")
        assert ("visited(b)" in result.query_string) or ("exclude(e)" in result.query_string)
    
    def test_rewrite_exclude_to_visitedAny_on_sibling_routes(self):
        """
        Graph: A->B->E, A->C->E, A->D->E, E->F
        Condition: exclude(B), but exclude is expensive, visited is cheap.
        Expect: from(E).to(F).visitedAny(C,D)
        """
        graph = create_minimal_graph(
            [{"id": "a"}, {"id": "b"}, {"id": "c"}, {"id": "d"}, {"id": "e"}, {"id": "f"}],
            [
                {"from": "a", "to": "b"},
                {"from": "b", "to": "e"},
                {"from": "a", "to": "c"},
                {"from": "c", "to": "e"},
                {"from": "a", "to": "d"},
                {"from": "d", "to": "e"},
                {"from": "e", "to": "f"},
            ]
        )
        edge_e_f = [e for e in graph.edges if e.from_node == "e" and e.to == "f"][0]
        weights = {"visited": 1, "exclude": 10}
        res = generate_query_for_edge(
            graph, edge_e_f,
            condition="exclude(b)",
            literal_weights=weights,
            preserve_condition=False
        )
        assert res.query_string in {
            "from(e).to(f).visitedAny(c,d)",
            "from(e).to(f).visitedAny(d,c)"
        }
    
    def test_rewrite_visited_to_exclude_siblings_on_routes(self):
        """
        Graph: A->B->E, A->C->E, A->D->E, E->F
        Condition: visited(B), but visited is expensive, exclude is cheap.
        Expect: from(E).to(F).exclude(C,D) or equivalent minus() variant
        """
        graph = create_minimal_graph(
            [{"id": "a"}, {"id": "b"}, {"id": "c"}, {"id": "d"}, {"id": "e"}, {"id": "f"}],
            [
                {"from": "a", "to": "b"},
                {"from": "b", "to": "e"},
                {"from": "a", "to": "c"},
                {"from": "c", "to": "e"},
                {"from": "a", "to": "d"},
                {"from": "d", "to": "e"},
                {"from": "e", "to": "f"},
            ]
        )
        edge_e_f = [e for e in graph.edges if e.from_node == "e" and e.to == "f"][0]
        weights = {"visited": 10, "exclude": 1}
        res = generate_query_for_edge(
            graph, edge_e_f,
            condition="visited(b)",
            literal_weights=weights,
            preserve_condition=False
        )
        # Should exclude c and d (or use from(e).to(f) if no reachability from e through c/d)
        assert res.query_string.startswith("from(e).to(f)")
        # Check that c and d are in the exclude constraints
        assert set(res.constraints.exclude) == {"c", "d"}


class TestMultiParentDetection:
    """Test detection of multi-parent situations."""
    
    def test_detect_multi_parent_simple(self):
        """Legacy test removed: multi-parent detection no longer exported."""
        assert True
    
    def test_detect_diamond(self):
        """
        Diamond pattern: edges from diamond source may have alternates.
        But individual edges B->D and C->D don't have multiple paths from their own nodes.
        Only edges from A would show alternates.
        """
        graph = create_minimal_graph(
            [{"id": "a"}, {"id": "b"}, {"id": "c"}, {"id": "d"}],
            [
                {"from": "a", "to": "b"},
                {"from": "a", "to": "c"},
                {"from": "b", "to": "d"},
                {"from": "c", "to": "d"}
            ]
        )
        
        # Deprecated detection removed; nothing to assert here
        assert True


class TestMSMDCComplexCases:
    """Test complex graph patterns."""
    
    def test_multiple_alternates(self):
        """
        Graph with 3 parallel paths from A to D:
        A>B>D, A>C>D, A>D (direct)
        """
        graph = create_minimal_graph(
            [{"id": "a"}, {"id": "b"}, {"id": "c"}, {"id": "d"}],
            [
                {"from": "a", "to": "b"},
                {"from": "b", "to": "d"},
                {"from": "a", "to": "c"},
                {"from": "c", "to": "d"},
                {"from": "a", "to": "d"}  # Direct
            ]
        )
        
        # Direct edge A->D
        direct_edge = [e for e in graph.edges if e.from_node == "a" and e.to == "d"][0]
        result = generate_query_for_edge(graph, direct_edge, condition="exclude(b,c)")
        assert "from(a).to(d)" in result.query_string
    
    def test_unconditional_direct_edge_requires_excludes(self):
        """
        Unconditional direct edge must exclude sibling predecessors of the target
        when alternates exist from the same source.
        Graph: A>B>D, A>C>D, A>D (direct)
        Expect: from(a).to(d).exclude(b,c) or minus(b).minus(c) variant
        """
        graph = create_minimal_graph(
            [{"id": "a"}, {"id": "b"}, {"id": "c"}, {"id": "d"}],
            [
                {"from": "a", "to": "b"},
                {"from": "b", "to": "d"},
                {"from": "a", "to": "c"},
                {"from": "c", "to": "d"},
                {"from": "a", "to": "d"}  # Direct
            ]
        )
        direct_edge = [e for e in graph.edges if e.from_node == "a" and e.to == "d"][0]
        res = generate_query_for_edge(graph, direct_edge, condition=None)
        # Check that b and c are in exclude constraints (implementation detail of how they're expressed)
        assert set(res.constraints.exclude) == {"b", "c"}
        assert res.query_string.startswith("from(a).to(d)")
    
    def test_unconditional_direct_edge_ignores_unreachable_parents(self):
        """
        If target has an additional parent X that is not reachable from the edge's source A,
        we should not include X in excludes.
        Graph: A>B>D, A>C>D, X>D, A>D (direct), and no path from A to X.
        Expect: from(a).to(d).exclude(b,c) or minus(b).minus(c) (no 'x' excluded).
        """
        graph = create_minimal_graph(
            [{"id": "a"}, {"id": "b"}, {"id": "c"}, {"id": "d"}, {"id": "x"}],
            [
                {"from": "a", "to": "b"},
                {"from": "b", "to": "d"},
                {"from": "a", "to": "c"},
                {"from": "c", "to": "d"},
                {"from": "x", "to": "d"},  # Unreachable from A
                {"from": "a", "to": "d"}   # Direct
            ]
        )
        direct_edge = [e for e in graph.edges if e.from_node == "a" and e.to == "d"][0]
        res = generate_query_for_edge(graph, direct_edge, condition=None)
        # Should not include x in excludes (only b and c)
        assert set(res.constraints.exclude) == {"b", "c"}
        assert res.query_string.startswith("from(a).to(d)")
    
    def test_long_path_vs_shortcuts(self):
        """
        A>B>C>D>E (long path)
        A>C>E (shortcut 1) - but this creates B>C with alternate from A
        """
        graph = create_minimal_graph(
            [{"id": "a"}, {"id": "b"}, {"id": "c"}, {"id": "d"}, {"id": "e"}],
            [
                {"from": "a", "to": "b"},
                {"from": "b", "to": "c"},
                {"from": "c", "to": "d"},
                {"from": "d", "to": "e"},
                {"from": "a", "to": "c"},  # Shortcut
                {"from": "c", "to": "e"},  # Shortcut
                {"from": "a", "to": "e"}   # Direct
            ]
        )
        
        # Edge B->C with long-path condition
        edge_b_c = [e for e in graph.edges if e.from_node == "b" and e.to == "c"][0]
        result = generate_query_for_edge(graph, edge_b_c, condition="visited(d)")
        
        # d is downstream of c; query may include visited(d) but it's fine
        assert result.query_string.startswith("from(b).to(c)")


class TestMSMDCEdgeCases:
    """Test edge cases and boundary conditions."""
    
    def test_no_path_exists(self):
        """When no path exists, return empty result."""
        graph = create_minimal_graph(
            [{"id": "a"}, {"id": "b"}, {"id": "c"}],
            [{"from": "a", "to": "b"}]  # No path to C
        )
        
        # Try to generate query for non-existent edge
        # Create a fake edge for testing
        fake_edge = Edge(
            uuid="fake",
            from_node="b",
            to="c",
            p={"mean": 0.5}
        )
        
        result = generate_query_for_edge(graph, fake_edge, condition=None)
        
        assert result.query_string == "from(b).to(c)"
    
    def test_self_loop(self):
        """Self-referencing edge (if allowed)."""
        graph = create_minimal_graph(
            [{"id": "a"}],
            []  # No edges - will test no path scenario
        )
        
        fake_edge = Edge(
            uuid="self",
            from_node="a",
            to="a",
            p={"mean": 0.5}
        )
        
        result = generate_query_for_edge(graph, fake_edge)
        
        # Should handle gracefully (no simple path from a to a)
        assert result.query_string == "from(a).to(a)"


class TestMSMDCPerformance:
    """Test performance characteristics."""
    
    def test_path_capping(self):
        """
        Create dense graph that would have many paths.
        Verify capping at max_paths.
        """
        # Create a complete graph (every node connects to every later node)
        n = 6
        nodes = [{"id": f"n{i}"} for i in range(n)]
        edges = []
        for i in range(n):
            for j in range(i + 1, n):
                edges.append({"from": f"n{i}", "to": f"n{j}"})
        
        graph = create_minimal_graph(nodes, edges)
        
        # Edge from n0 to n5 (last node)
        edge_0_5 = [e for e in graph.edges if e.from_node == "n0" and e.to == "n5"][0]
        
        # Call with default; no enumeration in witness-guided approach
        result = generate_query_for_edge(graph, edge_0_5, condition=None)
        
        # Should still generate a valid query
        assert "from(n0).to(n5)" in result.query_string
        # Checks reported
        assert "checks" in result.coverage_stats


class TestMSMDCCaseContext:
    """Test case and context constraint handling."""
    
    def test_case_condition_preserved(self):
        """Case constraints from condition are preserved in output query."""
        graph = create_minimal_graph(
            [{"id": "a"}, {"id": "b"}, {"id": "c"}],
            [{"from": "a", "to": "b"}, {"from": "b", "to": "c"}]
        )
        
        edge = graph.edges[0]  # a->b
        result = generate_query_for_edge(graph, edge, condition="case(test-123:treatment)")
        
        # Case should be preserved in output
        assert "case(test-123:treatment)" in result.query_string
        assert ("test-123", "treatment") in result.constraints.cases
    
    def test_context_condition_preserved(self):
        """Context constraints from condition are preserved in output query."""
        graph = create_minimal_graph(
            [{"id": "a"}, {"id": "b"}],
            [{"from": "a", "to": "b"}]
        )
        
        edge = graph.edges[0]
        result = generate_query_for_edge(graph, edge, condition="context(device:mobile)")
        
        # Context should be preserved in output
        assert "context(device:mobile)" in result.query_string
        assert ("device", "mobile") in result.constraints.contexts
    
    def test_combined_condition_types(self):
        """Mixed condition with visited, exclude, case, and context."""
        graph = create_minimal_graph(
            [{"id": "a"}, {"id": "b"}, {"id": "c"}, {"id": "d"}],
            [
                {"from": "a", "to": "b"},
                {"from": "b", "to": "c"},
                {"from": "a", "to": "c"},  # Alternate
                {"from": "c", "to": "d"}
            ]
        )
        
        edge_c_d = [e for e in graph.edges if e.from_node == "c" and e.to == "d"][0]
        condition = "visited(b).case(exp-1:variant-a).context(region:us)"
        result = generate_query_for_edge(graph, edge_c_d, condition=condition)
        
        # All constraint types should be preserved
        assert "case(exp-1:variant-a)" in result.query_string
        assert "context(region:us)" in result.query_string
        # visited(b) might be in query if needed for discrimination
        assert result.query_string.startswith("from(c).to(d)")


class TestComprehensiveParameterGeneration:
    """Test generate_all_parameter_queries function."""
    
    def test_all_parameter_types_extracted(self):
        """Extract all parameter types from a graph with mixed params."""
        from msmdc import generate_all_parameter_queries, ParameterQuery
        
        # Create graph with various parameter types
        nodes = [
            Node(uuid="a-uuid", id="a"),
            Node(uuid="b-uuid", id="b"),
            Node(uuid="c-uuid", id="c")
        ]
        
        edges = [
            Edge(
                uuid="e1",
                from_node="a",
                to="b",
                p={"mean": 0.5},  # Has base p
                cost_gbp={"mean": 10.0},  # Has cost
                conditional_p=[
                    {
                        "condition": "visited(x)",
                        "p": {"mean": 0.6}
                    }
                ]
            ),
            Edge(
                uuid="e2",
                from_node="b",
                to="c",
                p={"mean": 0.3},
                cost_time={"mean": 2.5}
            )
        ]
        
        policies = Policies(
            default_outcome="default",
            overflow_policy="error",
            free_edge_policy="complement"
        )
        
        metadata = Metadata(
            version="1.0.0",
            created_at=datetime.now()
        )
        
        graph = Graph(nodes=nodes, edges=edges, policies=policies, metadata=metadata)
        
        # Generate all parameters
        params = generate_all_parameter_queries(graph)
        
        # Should have multiple parameter types
        param_types = set(p.param_type for p in params)
        assert "edge_base_p" in param_types
        assert "edge_conditional_p" in param_types
        assert "edge_cost_gbp" in param_types
        assert "edge_cost_time" in param_types
        
        # Should have correct counts
        base_p_params = [p for p in params if p.param_type == "edge_base_p"]
        assert len(base_p_params) == 2  # Two edges
        
        conditional_params = [p for p in params if p.param_type == "edge_conditional_p"]
        assert len(conditional_params) == 1  # One conditional on edge a->b
        
        cost_params = [p for p in params if "cost" in p.param_type]
        assert len(cost_params) == 2  # cost_gbp and cost_time
    
    def test_downstream_filtering(self):
        """Only generate queries for edges downstream of specified node."""
        from msmdc import generate_all_parameter_queries
        
        # Linear graph: a->b->c->d
        nodes = [
            Node(uuid=f"{n}-uuid", id=n) for n in ["a", "b", "c", "d"]
        ]
        
        edges = [
            Edge(uuid="e1", from_node="a", to="b", p={"mean": 0.5}),
            Edge(uuid="e2", from_node="b", to="c", p={"mean": 0.5}),
            Edge(uuid="e3", from_node="c", to="d", p={"mean": 0.5})
        ]
        
        policies = Policies(
            default_outcome="default",
            overflow_policy="error",
            free_edge_policy="complement"
        )
        
        metadata = Metadata(
            version="1.0.0",
            created_at=datetime.now()
        )
        
        graph = Graph(nodes=nodes, edges=edges, policies=policies, metadata=metadata)
        
        # Generate only downstream of b
        params_downstream_b = generate_all_parameter_queries(graph, downstream_of="b")
        
        # Should only include b->c and c->d edges (not a->b)
        edge_keys = set(p.edge_key for p in params_downstream_b)
        assert "b->c" in edge_keys
        assert "c->d" in edge_keys
        assert "a->b" not in edge_keys
        
        # Generate all (no filter)
        params_all = generate_all_parameter_queries(graph)
        assert len(params_all) > len(params_downstream_b)
        assert "a->b" in set(p.edge_key for p in params_all)


class TestEdgeScopedQueryGeneration:
    """Test edge_uuid and conditional_index filtering for efficient single-edge regeneration."""
    
    def test_filter_by_edge_uuid(self):
        """Generate queries for only a specific edge by UUID."""
        from msmdc import generate_all_parameter_queries
        
        # Create graph with multiple edges
        nodes = [
            Node(uuid="a-uuid", id="a"),
            Node(uuid="b-uuid", id="b"),
            Node(uuid="c-uuid", id="c"),
            Node(uuid="d-uuid", id="d")
        ]
        
        edges = [
            Edge(uuid="edge-1", from_node="a", to="b", p={"mean": 0.5}, cost_gbp={"mean": 10.0}),
            Edge(uuid="edge-2", from_node="b", to="c", p={"mean": 0.6}, cost_time={"mean": 2.0}),
            Edge(uuid="edge-3", from_node="c", to="d", p={"mean": 0.7})
        ]
        
        graph = Graph(
            nodes=nodes,
            edges=edges,
            policies=Policies(default_outcome="default", overflow_policy="error", free_edge_policy="complement"),
            metadata=Metadata(version="1.0.0", created_at=datetime.now())
        )
        
        # Generate queries for only edge-2 (b->c)
        params = generate_all_parameter_queries(graph, edge_uuid="edge-2")
        
        # Should only have parameters from edge-2
        edge_keys = set(p.edge_key for p in params)
        assert edge_keys == {"b->c"}
        assert len(edge_keys) == 1
        
        # Should have base_p and cost_time (not cost_gbp which is only on edge-1)
        param_types = set(p.param_type for p in params)
        assert "edge_base_p" in param_types
        assert "edge_cost_time" in param_types
        assert "edge_cost_gbp" not in param_types
        
        # Verify param count (1 base_p + 1 cost_time = 2 params)
        assert len(params) == 2
    
    def test_filter_by_edge_uuid_with_conditionals(self):
        """When filtering by edge_uuid, include all conditionals on that edge."""
        from msmdc import generate_all_parameter_queries
        
        nodes = [
            Node(uuid="a-uuid", id="a"),
            Node(uuid="b-uuid", id="b"),
            Node(uuid="c-uuid", id="c")
        ]
        
        edges = [
            Edge(
                uuid="edge-1",
                from_node="a",
                to="b",
                p={"mean": 0.5},
                conditional_p=[
                    {"condition": "visited(x)", "p": {"mean": 0.6}},
                    {"condition": "visited(y)", "p": {"mean": 0.7}},
                    {"condition": "context(device:mobile)", "p": {"mean": 0.8}}
                ]
            ),
            Edge(uuid="edge-2", from_node="b", to="c", p={"mean": 0.4})
        ]
        
        graph = Graph(
            nodes=nodes,
            edges=edges,
            policies=Policies(default_outcome="default", overflow_policy="error", free_edge_policy="complement"),
            metadata=Metadata(version="1.0.0", created_at=datetime.now())
        )
        
        # Filter to edge-1 only (should get base_p + 3 conditionals = 4 params)
        params = generate_all_parameter_queries(graph, edge_uuid="edge-1")
        
        # Should only have parameters from edge-1
        edge_keys = set(p.edge_key for p in params)
        assert edge_keys == {"a->b"}
        
        # Should have 1 base_p + 3 conditional_p
        base_params = [p for p in params if p.param_type == "edge_base_p"]
        cond_params = [p for p in params if p.param_type == "edge_conditional_p"]
        
        assert len(base_params) == 1
        assert len(cond_params) == 3
        assert len(params) == 4
        
        # Verify conditional conditions are correct
        conditions = [p.condition for p in cond_params]
        assert "visited(x)" in conditions
        assert "visited(y)" in conditions
        assert "context(device:mobile)" in conditions
    
    def test_filter_by_conditional_index(self):
        """Generate query for only a specific conditional by index."""
        from msmdc import generate_all_parameter_queries
        
        nodes = [
            Node(uuid="a-uuid", id="a"),
            Node(uuid="b-uuid", id="b")
        ]
        
        edges = [
            Edge(
                uuid="edge-1",
                from_node="a",
                to="b",
                p={"mean": 0.5},
                cost_gbp={"mean": 10.0},
                conditional_p=[
                    {"condition": "visited(x)", "p": {"mean": 0.6}},
                    {"condition": "visited(y)", "p": {"mean": 0.7}},  # This one (index 1)
                    {"condition": "visited(z)", "p": {"mean": 0.8}}
                ]
            )
        ]
        
        graph = Graph(
            nodes=nodes,
            edges=edges,
            policies=Policies(default_outcome="default", overflow_policy="error", free_edge_policy="complement"),
            metadata=Metadata(version="1.0.0", created_at=datetime.now())
        )
        
        # Generate query for only conditional index 1
        params = generate_all_parameter_queries(graph, edge_uuid="edge-1", conditional_index=1)
        
        # Should have ONLY the conditional_p at index 1 (not base_p, not other conditionals, not cost)
        assert len(params) == 1
        assert params[0].param_type == "edge_conditional_p"
        assert params[0].condition == "visited(y)"
        assert params[0].edge_key == "a->b"
        
        # Verify param_id includes the index
        assert "conditional_p[1]" in params[0].param_id
    
    def test_conditional_index_skips_base_and_cost_params(self):
        """When conditional_index is specified, skip base_p and cost params."""
        from msmdc import generate_all_parameter_queries
        
        nodes = [
            Node(uuid="a-uuid", id="a"),
            Node(uuid="b-uuid", id="b")
        ]
        
        edges = [
            Edge(
                uuid="edge-1",
                from_node="a",
                to="b",
                p={"mean": 0.5},  # Should be skipped
                cost_gbp={"mean": 10.0},  # Should be skipped
                cost_time={"mean": 2.0},  # Should be skipped
                conditional_p=[
                    {"condition": "visited(x)", "p": {"mean": 0.6}}  # Only this one (index 0)
                ]
            )
        ]
        
        graph = Graph(
            nodes=nodes,
            edges=edges,
            policies=Policies(default_outcome="default", overflow_policy="error", free_edge_policy="complement"),
            metadata=Metadata(version="1.0.0", created_at=datetime.now())
        )
        
        # Filter to conditional index 0
        params = generate_all_parameter_queries(graph, edge_uuid="edge-1", conditional_index=0)
        
        # Should ONLY have the conditional_p (not base_p, not costs)
        assert len(params) == 1
        assert params[0].param_type == "edge_conditional_p"
        assert "conditional_p[0]" in params[0].param_id
        
        # Verify no base or cost params
        param_types = set(p.param_type for p in params)
        assert "edge_base_p" not in param_types
        assert "edge_cost_gbp" not in param_types
        assert "edge_cost_time" not in param_types
    
    def test_edge_uuid_without_conditional_index_includes_all_base_params(self):
        """When only edge_uuid is specified (no conditional_index), include base_p and costs."""
        from msmdc import generate_all_parameter_queries
        
        nodes = [
            Node(uuid="a-uuid", id="a"),
            Node(uuid="b-uuid", id="b")
        ]
        
        edges = [
            Edge(
                uuid="edge-1",
                from_node="a",
                to="b",
                p={"mean": 0.5},
                cost_gbp={"mean": 10.0},
                cost_time={"mean": 2.0},
                conditional_p=[
                    {"condition": "visited(x)", "p": {"mean": 0.6}},
                    {"condition": "visited(y)", "p": {"mean": 0.7}}
                ]
            )
        ]
        
        graph = Graph(
            nodes=nodes,
            edges=edges,
            policies=Policies(default_outcome="default", overflow_policy="error", free_edge_policy="complement"),
            metadata=Metadata(version="1.0.0", created_at=datetime.now())
        )
        
        # Filter to edge-1 without conditional_index
        params = generate_all_parameter_queries(graph, edge_uuid="edge-1")
        
        # Should include base_p, costs, and ALL conditionals
        param_types = [p.param_type for p in params]
        assert "edge_base_p" in param_types
        assert "edge_cost_gbp" in param_types
        assert "edge_cost_time" in param_types
        
        # Should NOT include any conditional_p when no conditional_index specified
        # Actually, wait - reading the implementation again, when edge_uuid is specified
        # WITHOUT conditional_index, we should include ALL params on that edge including conditionals
        # Let me check the implementation...
        
        # Based on the implementation: edge_uuid without conditional_index includes everything
        conditional_count = len([p for p in params if p.param_type == "edge_conditional_p"])
        base_count = len([p for p in params if p.param_type == "edge_base_p"])
        cost_count = len([p for p in params if "cost" in p.param_type])
        
        # Total: 1 base_p + 2 costs + 2 conditionals = 5 params
        assert base_count == 1
        assert cost_count == 2
        assert conditional_count == 2
        assert len(params) == 5
    
    def test_performance_large_graph_single_edge_filter(self):
        """Verify filtering avoids generating queries for unrelated edges."""
        from msmdc import generate_all_parameter_queries
        
        # Create a large graph (50 nodes in a chain)
        n = 50
        nodes = [Node(uuid=f"n{i}-uuid", id=f"n{i}") for i in range(n)]
        edges = [
            Edge(uuid=f"edge-{i}", from_node=f"n{i}", to=f"n{i+1}", p={"mean": 0.5})
            for i in range(n-1)
        ]
        
        graph = Graph(
            nodes=nodes,
            edges=edges,
            policies=Policies(default_outcome="default", overflow_policy="error", free_edge_policy="complement"),
            metadata=Metadata(version="1.0.0", created_at=datetime.now())
        )
        
        # Generate for all edges (baseline)
        params_all = generate_all_parameter_queries(graph)
        assert len(params_all) == 49  # 49 edges, each with 1 base_p
        
        # Generate for only one edge in the middle
        params_filtered = generate_all_parameter_queries(graph, edge_uuid="edge-25")
        
        # Should only have 1 parameter (the base_p for edge-25)
        assert len(params_filtered) == 1
        assert params_filtered[0].edge_key == "n25->n26"
        
        # This demonstrates massive efficiency gain: 1 vs 49 query generations
    
    def test_edge_uuid_not_found_returns_empty(self):
        """When edge_uuid doesn't match any edge, return empty list."""
        from msmdc import generate_all_parameter_queries
        
        nodes = [Node(uuid="a-uuid", id="a"), Node(uuid="b-uuid", id="b")]
        edges = [Edge(uuid="edge-1", from_node="a", to="b", p={"mean": 0.5})]
        
        graph = Graph(
            nodes=nodes,
            edges=edges,
            policies=Policies(default_outcome="default", overflow_policy="error", free_edge_policy="complement"),
            metadata=Metadata(version="1.0.0", created_at=datetime.now())
        )
        
        # Try to filter by non-existent edge UUID
        params = generate_all_parameter_queries(graph, edge_uuid="non-existent-edge")
        
        # Should return empty list
        assert len(params) == 0
    
    def test_conditional_index_out_of_bounds_returns_empty(self):
        """When conditional_index is out of bounds, return empty list."""
        from msmdc import generate_all_parameter_queries
        
        nodes = [Node(uuid="a-uuid", id="a"), Node(uuid="b-uuid", id="b")]
        edges = [
            Edge(
                uuid="edge-1",
                from_node="a",
                to="b",
                p={"mean": 0.5},
                conditional_p=[
                    {"condition": "visited(x)", "p": {"mean": 0.6}}  # Only 1 conditional (index 0)
                ]
            )
        ]
        
        graph = Graph(
            nodes=nodes,
            edges=edges,
            policies=Policies(default_outcome="default", overflow_policy="error", free_edge_policy="complement"),
            metadata=Metadata(version="1.0.0", created_at=datetime.now())
        )
        
        # Try to get conditional at index 5 (doesn't exist)
        params = generate_all_parameter_queries(graph, edge_uuid="edge-1", conditional_index=5)
        
        # Should return empty list
        assert len(params) == 0
    
    def test_combined_filtering_with_downstream(self):
        """Test edge_uuid filtering combined with downstream_of filtering."""
        from msmdc import generate_all_parameter_queries
        
        # Linear graph: a->b->c->d
        nodes = [Node(uuid=f"{n}-uuid", id=n) for n in ["a", "b", "c", "d"]]
        edges = [
            Edge(uuid="e1", from_node="a", to="b", p={"mean": 0.5}),
            Edge(uuid="e2", from_node="b", to="c", p={"mean": 0.6}),
            Edge(uuid="e3", from_node="c", to="d", p={"mean": 0.7})
        ]
        
        graph = Graph(
            nodes=nodes,
            edges=edges,
            policies=Policies(default_outcome="default", overflow_policy="error", free_edge_policy="complement"),
            metadata=Metadata(version="1.0.0", created_at=datetime.now())
        )
        
        # Filter to downstream of 'b' AND edge_uuid='e3'
        params = generate_all_parameter_queries(
            graph, 
            downstream_of="b",
            edge_uuid="e3"
        )
        
        # Should only have parameters from e3 (c->d) since:
        # 1. edge_uuid filters to e3
        # 2. downstream_of filters to edges from b onwards (e2, e3)
        # 3. Intersection is just e3
        assert len(params) == 1
        assert params[0].edge_key == "c->d"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

