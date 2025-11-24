"""
Inclusion-Exclusion Algorithm for Minimal Subtractive Query Plans

Generates a smaller set of minus/plus terms by using first-hop bins
and adding back overlaps via inclusion-exclusion principle.
"""

import networkx as nx
from itertools import combinations
from typing import List, Set, Tuple


def compile_with_inclusion_exclusion(
    graph: nx.DiGraph,
    split_node: str,
    kept_target: str,
    merge_node: str,
    competing_hops: List[str]
) -> Tuple[str, List[Tuple[str, int]]]:
    """
    Build a minimal subtractive query using inclusion-exclusion.
    
    Instead of one minus per path, we use:
    - One minus per first-hop bin (over-subtracts due to overlaps)
    - Plus terms to add back the overlaps (pairs, triples, etc.)
    
    Formula (for sets A, B, C):
    |A ∪ B ∪ C| = |A| + |B| + |C| - |A∩B| - |A∩C| - |B∩C| + |A∩B∩C|
    
    So: total_excluded = Σ|single| - Σ|pairs| + Σ|triples| - ...
    
    Returns:
        (query_string, [(term, coefficient), ...])
        coefficient: +1 for base, -1 for minus, +1 for pair add-backs, etc.
    """
    # Build terms for all subset sizes using inclusion-exclusion
    terms = []
    
    # Base: +1 for from(a).to(m)
    base = f"from({split_node}).to({merge_node})"
    terms.append((base, +1))
    
    # For k competing hops, we need terms up to size k
    # Alternating signs: - for size 1, + for size 2, - for size 3, etc.
    for size in range(1, len(competing_hops) + 1):
        sign = (-1) ** size
        
        # Generate all combinations of this size
        for combo in combinations(competing_hops, size):
            # Build query term: from(a).to(m).visited(h1).visited(h2)...
            visited_list = '.'.join([f"visited({h})" for h in sorted(combo)])
            term = f"from({split_node}).to({merge_node}).{visited_list}"
            
            if sign < 0:
                # Minus term
                terms.append((f"minus({term})", sign))
            else:
                # Plus term (add-back)
                terms.append((f"plus({term})", sign))
    
    # Build query string
    query_parts = [base]
    for term, coeff in terms[1:]:
        query_parts.append(term)
    
    query = ".".join(query_parts)
    
    return query, terms


def validate_inclusion_exclusion_with_flow(
    graph: nx.DiGraph,
    split_node: str,
    kept_target: str,
    merge_node: str,
    competing_hops: List[str],
    n_start: float = 1000.0
) -> dict:
    """
    Validate the inclusion-exclusion plan using flow distribution.
    
    Returns:
        {
            'query': query_string,
            'terms': [(term, coefficient), ...],
            'direct_flow': flow on direct edge,
            'non_direct_flow': flow on all non-direct paths,
            'computed_subtraction': sum of weighted term flows,
            'matches': True if computed matches non_direct
        }
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
    
    # Generate inclusion-exclusion query
    query, terms = compile_with_inclusion_exclusion(
        graph, split_node, kept_target, merge_node, competing_hops
    )
    
    # Compute weighted sum of terms (excluding base)
    # We want: total_to_subtract = sum of (coeff * flow) for each term
    # The sum should equal non_direct_flow
    computed_subtraction = 0.0
    
    for term_str, coeff in terms[1:]:  # Skip base (index 0)
        # Extract visited nodes from term
        # Parse: minus(from(a).to(m).visited(b).visited(d))
        # or: plus(from(a).to(m).visited(b).visited(d))
        import re
        visited_matches = re.findall(r'visited\(([a-z0-9_-]+)\)', term_str)
        visited_set = set(visited_matches)
        
        # Sum flow of all paths that contain ALL nodes in visited_set
        term_flow = 0.0
        for path, flow in path_flows.items():
            if path == direct_path:
                continue  # Don't count direct in any minus/plus term
            
            path_set = set(path[1:-1])  # Interior nodes only
            if visited_set.issubset(path_set):
                term_flow += flow
        
        # Apply coefficient (note: coeff already has the sign from inclusion-exclusion)
        # For subtraction we want positive accumulated value
        # coeff is -1 for minus, +1 for plus, etc.
        # So we accumulate: -coeff * term_flow to get the amount subtracted
        computed_subtraction += (-coeff) * term_flow
        
        print(f"  Term: {term_str[:60]}... | coeff={coeff:+2d} | flow={term_flow:.2f} | contrib={-coeff*term_flow:+.2f}")
    
    matches = abs(computed_subtraction - non_direct_flow) < 1e-6
    
    return {
        'query': query,
        'terms': terms,
        'direct_flow': direct_flow,
        'non_direct_flow': non_direct_flow,
        'computed_subtraction': computed_subtraction,
        'matches': matches,
        'all_paths': all_paths,
        'path_flows': path_flows
    }

