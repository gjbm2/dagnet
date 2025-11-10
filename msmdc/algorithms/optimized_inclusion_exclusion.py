"""
Optimized Inclusion-Exclusion with Reachability Pruning and Dominance Elimination
"""

import networkx as nx
from itertools import combinations
from typing import List, Set, Tuple


def find_reachable_combinations(
    graph: nx.DiGraph,
    split_node: str,
    merge_node: str,
    competing_hops: List[str]
) -> Set[Tuple[str, ...]]:
    """
    Find all combinations of competing hops that are actually reachable
    (i.e., there exists at least one path from split to merge containing all nodes).
    
    This prunes impossible combinations to reduce inclusion-exclusion terms.
    """
    # Enumerate all paths
    try:
        all_paths = list(nx.all_simple_paths(graph, split_node, merge_node))
    except nx.NetworkXNoPath:
        return set()
    
    # Extract interior node sets from each path
    path_interiors = [set(p[1:-1]) for p in all_paths if len(p) > 2]
    
    # Test each possible combination
    reachable = set()
    for size in range(1, len(competing_hops) + 1):
        for combo in combinations(competing_hops, size):
            combo_set = set(combo)
            # Check if any path contains all nodes in this combo
            if any(combo_set.issubset(interior) for interior in path_interiors):
                reachable.add(tuple(sorted(combo)))
    
    return reachable


def find_dominated_hops(
    graph: nx.DiGraph,
    split_node: str,
    merge_node: str,
    competing_hops: List[str]
) -> Set[str]:
    """
    Find first hops that are dominated (all their paths pass through another hop).
    
    If h1 is dominated by h2 (every path through h1 also contains h2), we can
    eliminate h1 from the base set.
    """
    dominated = set()
    
    for h1 in competing_hops:
        for h2 in competing_hops:
            if h1 == h2:
                continue
            
            # Check: do all paths through h1 also contain h2?
            try:
                h1_paths = list(nx.all_simple_paths(graph, split_node, merge_node))
                h1_paths = [p for p in h1_paths if h1 in p[1:-1]]
                
                if not h1_paths:
                    continue
                
                # Check if all h1 paths also contain h2
                all_contain_h2 = all(h2 in p[1:-1] for p in h1_paths)
                
                if all_contain_h2:
                    dominated.add(h1)
                    break  # h1 is dominated; move to next
            except nx.NetworkXNoPath:
                continue
    
    return dominated


def compile_optimized_inclusion_exclusion(
    graph: nx.DiGraph,
    split_node: str,
    kept_target: str,
    merge_node: str,
    competing_hops: List[str]
) -> Tuple[str, List[Tuple[str, int]]]:
    """
    Build an optimized inclusion-exclusion query with:
    - Dominance elimination (remove dominated hops)
    - Reachability pruning (skip impossible combinations)
    
    Returns fewer terms while maintaining exactness.
    """
    # Step 1: Eliminate dominated hops
    dominated = find_dominated_hops(graph, split_node, merge_node, competing_hops)
    active_hops = [h for h in competing_hops if h not in dominated]
    
    print(f"\nDominance analysis:")
    if dominated:
        print(f"  Dominated hops (eliminated): {dominated}")
        print(f"  Active hops: {active_hops}")
    else:
        print(f"  No dominated hops found; using all {len(active_hops)} competing hops")
    
    # Step 2: Find reachable combinations
    reachable = find_reachable_combinations(graph, split_node, merge_node, active_hops)
    
    print(f"\nReachability analysis:")
    print(f"  Total possible combinations: {2**len(active_hops) - 1}")
    print(f"  Reachable combinations: {len(reachable)}")
    print(f"  Pruned: {2**len(active_hops) - 1 - len(reachable)}")
    
    # Step 3: Build terms using only reachable combinations
    terms = []
    
    # Base: +1
    base = f"from({split_node}).to({merge_node})"
    terms.append((base, +1))
    
    # Group reachable by size for inclusion-exclusion signs
    by_size = {}
    for combo in reachable:
        size = len(combo)
        if size not in by_size:
            by_size[size] = []
        by_size[size].append(combo)
    
    # Add terms with alternating signs
    for size in sorted(by_size.keys()):
        sign = (-1) ** size
        
        for combo in sorted(by_size[size]):
            # Build query term
            visited_list = '.'.join([f"visited({h})" for h in combo])
            term = f"from({split_node}).to({merge_node}).{visited_list}"
            
            if sign < 0:
                terms.append((f"minus({term})", sign))
            else:
                terms.append((f"plus({term})", sign))
    
    # Build query string
    query_parts = [base]
    for term, coeff in terms[1:]:
        query_parts.append(term)
    
    query = ".".join(query_parts)
    
    return query, terms


def validate_optimized_with_flow(
    graph: nx.DiGraph,
    split_node: str,
    kept_target: str,
    merge_node: str,
    competing_hops: List[str],
    n_start: float = 1000.0
) -> dict:
    """
    Validate the optimized inclusion-exclusion plan using flow distribution.
    """
    # Enumerate all simple paths
    all_paths = list(nx.all_simple_paths(graph, split_node, merge_node))
    
    # Compute flow per path (equal split at each branch)
    path_flows = {}
    for path in all_paths:
        flow = n_start
        for i in range(len(path) - 1):
            u = path[i]
            out_degree = graph.out_degree(u)
            if out_degree > 0:
                flow /= out_degree
        path_flows[tuple(path)] = flow
    
    # Direct edge flow
    direct_path = (split_node, merge_node)
    direct_flow = path_flows.get(direct_path, 0.0)
    
    # Non-direct flow
    non_direct_flow = sum(f for p, f in path_flows.items() if p != direct_path)
    
    # Generate optimized query
    query, terms = compile_optimized_inclusion_exclusion(
        graph, split_node, kept_target, merge_node, competing_hops
    )
    
    # Compute weighted sum
    computed_subtraction = 0.0
    
    print(f"\nTerm flow breakdown:")
    for term_str, coeff in terms[1:]:
        import re
        visited_matches = re.findall(r'visited\(([a-z0-9_-]+)\)', term_str)
        visited_set = set(visited_matches)
        
        # Sum flow of paths containing all visited nodes
        term_flow = 0.0
        for path, flow in path_flows.items():
            if path == direct_path:
                continue
            
            path_set = set(path[1:-1])
            if visited_set.issubset(path_set):
                term_flow += flow
        
        computed_subtraction += (-coeff) * term_flow
        
        operator = 'minus' if 'minus' in term_str else 'plus'
        print(f"  {operator}{visited_set}: coeff={coeff:+2d} | flow={term_flow:.2f} | contrib={-coeff*term_flow:+.2f}")
    
    matches = abs(computed_subtraction - non_direct_flow) < 1e-6
    
    return {
        'query': query,
        'terms': terms,
        'direct_flow': direct_flow,
        'non_direct_flow': non_direct_flow,
        'computed_subtraction': computed_subtraction,
        'matches': matches
    }

