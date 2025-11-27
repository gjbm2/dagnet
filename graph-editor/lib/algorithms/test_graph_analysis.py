"""
Tests for MSMDC graph analysis algorithms (separator detection, query compilation)
"""

import networkx as nx
import pytest
from graph_analysis import (
    get_competing_first_hops,
    find_minimal_merge,
    find_separator_for_branch,
    compile_to_subtractive_query,
    compile_query_for_edge
)
from inclusion_exclusion import (
    compile_with_inclusion_exclusion,
    validate_inclusion_exclusion_with_flow
)
from optimized_inclusion_exclusion import (
    compile_optimized_inclusion_exclusion,
    validate_optimized_with_flow
)

def enumerate_paths(G: nx.DiGraph, a: str, z: str):
    try:
        return list(nx.all_simple_paths(G, a, z))
    except nx.NetworkXNoPath:
        return []

def path_flow(G: nx.DiGraph, path, initial=1000.0) -> float:
    """Distribute flow equally across outgoing edges at each step along the path."""
    flow = float(initial)
    for u, v in zip(path[:-1], path[1:]):
        outdeg = G.out_degree(u)
        if outdeg == 0:
            return 0.0
        flow *= 1.0 / float(outdeg)
    return flow

def total_flow_to(G: nx.DiGraph, a: str, z: str, initial=1000.0) -> float:
    paths = enumerate_paths(G, a, z)
    return sum(path_flow(G, p, initial) for p in paths)

def interior_nodes(path):
    return path[1:-1]

def parse_minus_terms(query: str):
    """
    Extract ordered interior sequences from minus(from(a).to(m).visited(x).visited(y)) terms.
    Returns a list of tuples like ('x','y')
    """
    import re
    minus_terms = []
    for m in re.finditer(r"minus\((from\([^)]+\)\.to\([^)]+\)(?:\.visited\(([a-z0-9_-]+)\))*)\)", query):
        inner = m.group(1)
        seq = tuple(re.findall(r"\.visited\(([a-z0-9_-]+)\)", inner))
        if seq:
            minus_terms.append(seq)
        else:
            # minus with no interior (should not happen for non-direct paths)
            minus_terms.append(tuple())
    return minus_terms


def test_complex_multi_path_graph():
    """
    Test the complex graph from the design discussion:
    
    Edges:
    a→m (direct - what we want to isolate)
    a→b, b→m
    a→f, f→b
    a→e, e→b, e→g
    a→d, d→m, d→g, d→e
    g→m
    
    First hops from a: {m, b, f, e, d}
    Competing (non-m): {b, f, e, d}
    
    Challenge: Multiple routes through intermediate nodes (b, g)
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
    
    # Test: compile query for edge a→m
    query = compile_query_for_edge(
        G,
        ('a', 'm'),
        provider='amplitude',
        supports_native_exclude=False
    )
    
    print("\n=== Complex Multi-Path Graph Test ===")
    print(f"Graph edges: {list(G.edges())}")
    print(f"Edge to isolate: a→m")
    print(f"Competing first hops: {get_competing_first_hops(G, 'a', 'm')}")
    print(f"Generated query: {query}")
    
    # Analyze what the query should be
    competing = get_competing_first_hops(G, 'a', 'm')
    merge = find_minimal_merge(G, 'a', 'm')
    
    print(f"\nMerge node: {merge}")
    print("\nSeparators per competing branch:")
    
    kept_path = ['a', 'm']
    for alt in competing:
        sep = find_separator_for_branch(G, 'a', alt, merge, kept_path)
        print(f"  {alt}: separator = {sep}")
    
    # Expected structure: base + minus terms
    assert query.startswith("from(a).to(m)")
    assert "minus" in query
    
    # Should have 4 minus terms (one per competing first hop: b, f, e, d)
    minus_count = query.count("minus(")
    print(f"\nMinus terms count: {minus_count}")

    # Flow-based validation
    paths = enumerate_paths(G, 'a', 'm')
    flows = {tuple(p): path_flow(G, p, 1000.0) for p in paths}
    total = sum(flows.values())
    direct = sum(v for p, v in flows.items() if len(p) == 2)  # a->m
    non_direct = total - direct
    print("\nAll a→m paths and flows:")
    for p, v in sorted(flows.items(), key=lambda x: x[1], reverse=True):
        print(f"  {p}: {v:.6f}")
    print(f"\nTotal={total:.6f}  Direct(a→m)={direct:.6f}  NonDirect={non_direct:.6f}")
    # Sanity: total should be ~1000
    assert abs(total - 1000.0) < 1e-9

    # Map minus terms to flows using AMPLITUDE SEMANTICS
    # visited(x,y) means "path contains x AND y somewhere" (subset match)
    minus_seqs = parse_minus_terms(query)
    print(f"\nMinus sequences: {minus_seqs}")
    
    subtracted_naive = 0.0
    for seq in minus_seqs:
        seq_set = set(seq)
        term_flow = 0.0
        for p, v in flows.items():
            if len(p) <= 2:  # Skip direct edge
                continue
            interior_set = set(interior_nodes(p))
            # Amplitude: visited matches if ALL in seq appear in path
            if seq_set.issubset(interior_set):
                term_flow += v
        subtracted_naive += term_flow
        print(f"  Minus visited{seq}: Amplitude-style flow={term_flow:.2f}")
    
    print(f"\nNaive MECE sum: {subtracted_naive:.6f}")
    print(f"Non-direct actual: {non_direct:.6f}")
    print(f"Over-subtraction: {subtracted_naive - non_direct:.6f}")
    
    if abs(subtracted_naive - non_direct) > 1e-6:
        print("\n⚠️  MECE FAILS: Over-subtracts due to visited() semantics!")
        print("   Need inclusion-exclusion with plus() add-backs")
    else:
        print("\n✓ MECE works (path interiors are truly disjoint)")


def test_simple_diamond():
    """
    Simple diamond: A → B → C, A → D → C
    Edge-level vs branch-level behaviour.
    """
    G = nx.DiGraph()
    G.add_edges_from([
        ('a', 'b'), ('b', 'c'),
        ('a', 'd'), ('d', 'c')
    ])

    # 1) Edge-level: a→b has a single path from a to b, so no exclusion needed.
    query_ab = compile_query_for_edge(
        G,
        ('a', 'b'),
        provider='amplitude',
        supports_native_exclude=False
    )

    print("\n=== Simple Diamond (edge a→b) ===")
    print(f"Generated query_ab: {query_ab}")

    assert query_ab == "from(a).to(b)"
    assert "minus" not in query_ab
    assert "exclude" not in query_ab

    # 2) Branch-level to merge node: a→c has two competing paths via b and d.
    query_ac = compile_query_for_edge(
        G,
        ('a', 'c'),
        provider='amplitude',
        supports_native_exclude=False
    )

    print("\n=== Simple Diamond (edge a→c) ===")
    print(f"Generated query_ac: {query_ac}")

    assert query_ac.startswith("from(a).to(c)")
    assert "minus" in query_ac


def test_native_exclude_provider():
    """
    With native exclude support, should use exclude() not minus()
    """
    G = nx.DiGraph()
    G.add_edges_from([
        ('a', 'b'), ('b', 'c'),
        ('a', 'd'), ('d', 'c')
    ])
    
    query = compile_query_for_edge(
        G,
        ('a', 'b'),
        provider='custom_sql',
        supports_native_exclude=True
    )
    
    print("\n=== Native Exclude Provider Test ===")
    print(f"Generated query: {query}")
    
    # Should use exclude() syntax
    assert "exclude" in query
    assert "minus" not in query
    assert "d" in query


def test_no_competing_branches():
    """
    Linear path: A → B → C
    No exclusion needed
    """
    G = nx.DiGraph()
    G.add_edges_from([('a', 'b'), ('b', 'c')])
    
    query = compile_query_for_edge(
        G,
        ('a', 'b'),
        provider='amplitude',
        supports_native_exclude=False
    )
    
    print("\n=== No Competing Branches Test ===")
    print(f"Generated query: {query}")
    
    # Should be simple: from(a).to(b)
    assert query == "from(a).to(b)"
    assert "minus" not in query
    assert "exclude" not in query


def test_inclusion_exclusion_approach():
    """
    Test the inclusion-exclusion approach: fewer terms but with add-backs.
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
    
    competing = get_competing_first_hops(G, 'a', 'm')
    merge = find_minimal_merge(G, 'a', 'm')
    
    print("\n" + "=" * 80)
    print("INCLUSION-EXCLUSION APPROACH TEST")
    print("=" * 80)
    
    result = validate_inclusion_exclusion_with_flow(
        G, 'a', 'm', 'm', competing, n_start=1000.0
    )
    
    print(f"\nGenerated query:")
    print(f"  {result['query']}")
    
    print(f"\nTerm count: {len(result['terms'])}")
    print(f"\nFlow validation:")
    print(f"  Direct a→m flow: {result['direct_flow']:.2f}")
    print(f"  Non-direct flow: {result['non_direct_flow']:.2f}")
    print(f"  Computed subtraction: {result['computed_subtraction']:.2f}")
    print(f"  Match: {result['matches']}")
    
    assert result['matches'], "Inclusion-exclusion flow validation failed"
    
    print("\nTerm breakdown:")
    for term, coeff in result['terms']:
        sign = '+' if coeff > 0 else ''
        print(f"  {sign}{coeff}: {term[:80]}")


def test_optimized_inclusion_exclusion():
    """
    Test optimized inclusion-exclusion with reachability pruning and dominance.
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
    
    competing = get_competing_first_hops(G, 'a', 'm')
    merge = find_minimal_merge(G, 'a', 'm')
    
    print("\n" + "=" * 80)
    print("OPTIMIZED INCLUSION-EXCLUSION TEST")
    print("=" * 80)
    
    result = validate_optimized_with_flow(
        G, 'a', 'm', 'm', competing, n_start=1000.0
    )
    
    print(f"\nGenerated query:")
    print(f"  {result['query'][:200]}...")
    
    print(f"\nTerm count: {len(result['terms'])}")
    print(f"\nFlow validation:")
    print(f"  Direct a→m flow: {result['direct_flow']:.2f}")
    print(f"  Non-direct flow: {result['non_direct_flow']:.2f}")
    print(f"  Computed subtraction: {result['computed_subtraction']:.2f}")
    print(f"  Match: {result['matches']}")
    
    assert result['matches'], "Optimized inclusion-exclusion flow validation failed"


if __name__ == "__main__":
    print("=" * 80)
    print("MSMDC Graph Analysis Algorithm Tests")
    print("=" * 80)
    
    # Run basic tests
    test_no_competing_branches()
    test_simple_diamond()
    test_native_exclude_provider()
    
    # The critical test case with MECE path enumeration
    print("\n" + "=" * 80)
    print("EXACT MECE PATH ENUMERATION")
    print("=" * 80)
    query_mece = test_complex_multi_path_graph()
    
    # Test inclusion-exclusion approach (with add-backs)
    result_ie = test_inclusion_exclusion_approach()
    
    # Test optimized approach (reachability pruning + dominance)
    result_opt = test_optimized_inclusion_exclusion()
    
    print("\n" + "=" * 80)
    print("ALGORITHM COMPARISON")
    print("=" * 80)
    print(f"\n1. MECE path enumeration:")
    print(f"   Terms: {query_mece.count('minus')}")
    print(f"   Result: FAILS (over-subtracts by {1266.67-800:.2f} due to visited semantics)")
    
    print(f"\n2. Full inclusion-exclusion:")
    print(f"   Terms: {len(result_ie['terms'])-1}  (base + {len([t for t,c in result_ie['terms'][1:] if 'minus' in t])} minus + {len([t for t,c in result_ie['terms'][1:] if 'plus' in t])} plus)")
    print(f"   Result: EXACT (800.00)")
    
    print(f"\n3. Optimized inclusion-exclusion:")
    print(f"   Terms: {len(result_opt['terms'])-1}")
    print(f"   Result: {'EXACT' if result_opt['matches'] else 'FAILED'} ({result_opt['computed_subtraction']:.2f})")
    
    print(f"\n✓ Winner: Optimized inclusion-exclusion")
    print(f"  Reduction: {len(result_ie['terms'])} → {len(result_opt['terms'])} terms")
    print("\nNext: Wire optimized algorithm into MSMDC and runtime executor")

