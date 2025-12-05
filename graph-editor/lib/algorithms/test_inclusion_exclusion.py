"""
Pytest suite for MSMDC inclusion-exclusion algorithm validation

═══════════════════════════════════════════════════════════════════════════════
DEPRECATED: 4-Dec-25

These tests validate the inclusion-exclusion (minus/plus) algorithm which was
used when Amplitude didn't support native excludes.

As of 4-Dec-25, Amplitude supports native exclude via segment filters.
This compilation algorithm will NOT be triggered for Amplitude queries.

Tests remain valid for providers that don't support native excludes.
Target deletion: After 2 weeks of production validation.
═══════════════════════════════════════════════════════════════════════════════
"""

import pytest
import networkx as nx
import random
from graph_analysis import (
    get_competing_first_hops,
    find_minimal_merge,
    compile_query_for_edge
)
from optimized_inclusion_exclusion import validate_optimized_with_flow


# Generate 10 random seeds for stress testing
RANDOM_SEEDS = [random.randint(1, 1000000) for _ in range(10)]


def generate_random_dag(n_nodes: int, edge_probability: float = 0.15, seed: int = None) -> nx.DiGraph:
    """
    Generate a random DAG with controlled topology.
    
    Args:
        n_nodes: Number of nodes
        edge_probability: Probability of edge between any ordered pair
        seed: Random seed for reproducibility
        
    Returns:
        Random DAG with nodes labeled a, b, c, ...
    """
    if seed is not None:
        random.seed(seed)
    
    # Create nodes with alphabetic labels
    node_labels = [chr(97 + i) if i < 26 else f"n{i}" for i in range(n_nodes)]
    
    G = nx.DiGraph()
    G.add_nodes_from(node_labels)
    
    # Add edges only in topological order (i < j) to ensure DAG
    for i in range(n_nodes):
        for j in range(i + 1, n_nodes):
            if random.random() < edge_probability:
                G.add_edge(node_labels[i], node_labels[j])
    
    # Ensure there's at least one path from first to last node
    # Add a "spine" to guarantee connectivity
    for i in range(0, n_nodes - 1, max(1, n_nodes // 5)):
        next_i = min(i + max(1, n_nodes // 5), n_nodes - 1)
        if not nx.has_path(G, node_labels[i], node_labels[next_i]):
            G.add_edge(node_labels[i], node_labels[next_i])
    
    return G


def test_simple_no_branches():
    """Linear path requires no exclusion."""
    G = nx.DiGraph()
    G.add_edges_from([('a', 'b'), ('b', 'c')])
    
    query = compile_query_for_edge(
        G, ('a', 'b'), 'amplitude', supports_native_exclude=False
    )
    
    assert query == "from(a).to(b)"
    assert "minus" not in query
    assert "plus" not in query


def test_simple_diamond():
    """
    Diamond: a→b→c, a→d→c
    
    Edge a→b: Only one path from a to b (direct), so no exclusion needed.
    Edge a→c: Two paths from a to c (via b or d), so needs exclusion.
    """
    G = nx.DiGraph()
    G.add_edges_from([
        ('a', 'b'), ('b', 'c'),
        ('a', 'd'), ('d', 'c')
    ])
    
    # Test edge a→b (no competing paths to b)
    query_ab = compile_query_for_edge(
        G, ('a', 'b'), 'amplitude', supports_native_exclude=False
    )
    assert query_ab == "from(a).to(b)", "Edge a→b has no competing paths"
    
    # Test edge a→c (has competing paths via b and d)
    query_ac = compile_query_for_edge(
        G, ('a', 'c'), 'amplitude', supports_native_exclude=False
    )
    assert query_ac.startswith("from(a).to(c)")
    assert "minus" in query_ac
    # Compact format: minus(b) or minus(d), no visited() wrapper
    assert ("minus(b)" in query_ac or "minus(d)" in query_ac)
    # No add-backs needed for diamond (only 1 competing path per branch)
    assert "plus" not in query_ac


def test_complex_overlapping_paths():
    """
    Complex graph with overlapping paths requiring inclusion-exclusion.
    
    Graph:
    a→m (direct, to isolate)
    a→b→m
    a→f→b, a→f→g→m
    a→e→b, a→e→g
    a→d→m, a→d→g, a→d→e
    g→m
    
    4 competing first hops: {b, f, e, d}
    Requires inclusion-exclusion with add-backs due to overlaps.
    """
    G = nx.DiGraph()
    G.add_edges_from([
        ('a', 'm'),  # Direct edge we want to isolate
        ('a', 'b'), ('b', 'm'),
        ('a', 'f'), ('f', 'b'), ('f', 'g'),
        ('a', 'e'), ('e', 'b'), ('e', 'g'),
        ('a', 'd'), ('d', 'm'), ('d', 'g'), ('d', 'e'),
        ('g', 'm')
    ])
    
    # Flow-based validation
    competing = get_competing_first_hops(G, 'a', 'm')
    result = validate_optimized_with_flow(
        G, 'a', 'm', 'm', competing, n_start=1000.0
    )
    
    # Assertions
    assert result['matches'], "Flow validation must pass"
    assert abs(result['direct_flow'] - 200.0) < 1e-6, "Direct flow should be 200"
    assert abs(result['non_direct_flow'] - 800.0) < 1e-6, "Non-direct flow should be 800"
    assert abs(result['computed_subtraction'] - 800.0) < 1e-6, "Computed must equal non-direct"
    
    # Query should have both minus and plus terms
    query = result['query']
    assert "minus" in query
    assert "plus" in query
    
    # Should have optimized term count (reachability pruning)
    # Full would be 2^4 - 1 = 15; optimized should be ~9-10
    term_count = len(result['terms']) - 1  # Exclude base
    assert term_count < 12, f"Expected <12 terms with optimization, got {term_count}"
    assert term_count >= 5, f"Expected >=5 terms (4 first hops minimum), got {term_count}"
    
    print(f"\n✓ Complex graph test passed: {term_count} terms, exact flow match")


def test_native_exclude_provider():
    """When provider supports native exclude, use it (no minus/plus)."""
    G = nx.DiGraph()
    G.add_edges_from([
        ('a', 'b'), ('b', 'c'),
        ('a', 'd'), ('d', 'c')
    ])
    
    query = compile_query_for_edge(
        G, ('a', 'b'), 'custom_sql', supports_native_exclude=True
    )
    
    assert "exclude" in query
    assert "minus" not in query
    assert "plus" not in query
    assert "d" in query


@pytest.mark.parametrize("seed", RANDOM_SEEDS)
def test_random_dag_20_nodes(seed):
    """
    Stress test: Generate random 20-node DAG and validate algorithm.
    
    Tests that MSMDC handles arbitrary graph topologies without crashes,
    and that flow conservation holds for random graphs.
    """
    n_nodes = 20
    G = generate_random_dag(n_nodes, edge_probability=0.15, seed=seed)
    
    print(f"\n{'='*80}")
    print(f"Random DAG Test (seed={seed})")
    print(f"{'='*80}")
    print(f"Nodes: {n_nodes}")
    print(f"Edges: {G.number_of_edges()}")
    
    # Pick a random edge that has competing branches
    edges_with_competition = []
    for edge in G.edges():
        source, target = edge
        competing = get_competing_first_hops(G, source, target)
        if competing:  # Has at least one competing branch
            edges_with_competition.append(edge)
    
    if not edges_with_competition:
        pytest.skip("No edges with competing branches in this random graph")
    
    # Test on the first edge with competition
    test_edge = edges_with_competition[0]
    source, target = test_edge
    
    print(f"\nTesting edge: {source}→{target}")
    
    # For edge discrimination, merge is ALWAYS the target
    # We measure P(a→b) = users who go from event a to event b
    merge = target
    
    competing = get_competing_first_hops(G, source, target, merge)
    print(f"Competing first hops: {competing} ({len(competing)} branches)")
    print(f"Merge node: {merge} (= target for edge probability)")
    
    # Skip if no competition (simple edge)
    if not competing:
        pytest.skip("No competing paths to target (simple edge)")
    
    # Compile and validate
    try:
        result = validate_optimized_with_flow(
            G, source, target, merge, competing, n_start=1000.0
        )
        
        print(f"\nFlow validation:")
        print(f"  Direct flow: {result['direct_flow']:.2f}")
        print(f"  Non-direct flow: {result['non_direct_flow']:.2f}")
        print(f"  Computed: {result['computed_subtraction']:.2f}")
        print(f"  Match: {result['matches']}")
        print(f"  Terms: {len(result['terms']) - 1}")
        
        # Assertions
        assert result['matches'], f"Flow validation failed for seed {seed}"
        
        # Term count should be reasonable (not exponential blowup)
        max_expected_terms = 2 ** min(len(competing), 5)  # Cap at 32 for sanity
        assert len(result['terms']) - 1 <= max_expected_terms, \
            f"Too many terms: {len(result['terms'])-1} (expected <={max_expected_terms})"
        
        print(f"\n✓ Random DAG test passed (seed={seed})")
        
    except Exception as e:
        print(f"\n✗ Random DAG test failed (seed={seed}): {e}")
        raise


if __name__ == "__main__":
    pytest.main([__file__, '-v'])

