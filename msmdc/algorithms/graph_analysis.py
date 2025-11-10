"""
Graph Analysis Algorithms for MSMDC Query Planning

Implements separator detection and query compilation for subtractive funnels
when providers lack native exclude support.
"""

import networkx as nx
from typing import List, Set, Optional, Tuple


def get_competing_first_hops(
    graph: nx.DiGraph,
    split_node: str,
    kept_target: str,
    merge_node: str = None
) -> List[str]:
    """
    Return all first hops from split_node that lead to paths we need to exclude.
    
    If merge_node is provided and differs from kept_target, we need to find
    all first hops that have paths to merge_node, excluding the direct kept edge.
    
    Args:
        graph: Directed acyclic graph
        split_node: Source node with multiple outgoing edges
        kept_target: The direct target we want to isolate
        merge_node: The merge point (if different from kept_target)
        
    Returns:
        List of competing first-hop node IDs
    """
    if merge_node is None or merge_node == kept_target:
        # Simple case: just exclude the direct target
        return [t for t in graph.successors(split_node) if t != kept_target]
    
    # Complex case: find all first hops that can reach merge (excluding direct edge to kept_target)
    competing = []
    for first_hop in graph.successors(split_node):
        if first_hop == kept_target:
            # This is the direct edge we're trying to isolate; skip it
            continue
        
        # Check if this first hop can reach the merge
        if nx.has_path(graph, first_hop, merge_node):
            competing.append(first_hop)
    
    return competing


def find_minimal_merge(
    graph: nx.DiGraph,
    split_node: str,
    kept_target: str
) -> str:
    """
    Find the minimal post-merge node M that fully resolves the decision at split_node.
    
    This is the earliest node that:
    - All paths from split_node (through any first hop) must eventually reach
    - Is reachable from kept_target
    
    Args:
        graph: Directed acyclic graph
        split_node: Source node with multiple outgoing edges
        kept_target: The direct target edge we want to isolate
        
    Returns:
        Merge node ID (often the target itself if it's a common descendant)
    """
    first_hops = list(graph.successors(split_node))
    
    if len(first_hops) == 1:
        # No branching; merge is just the target itself
        return kept_target
    
    # Compute all descendants for each first hop
    descendant_sets = []
    for hop in first_hops:
        try:
            descendants = set(nx.descendants(graph, hop)) | {hop}
            descendant_sets.append(descendants)
        except nx.NetworkXError:
            # Node has no descendants (terminal)
            descendant_sets.append({hop})
    
    # Common descendants
    common = set.intersection(*descendant_sets) if descendant_sets else set()
    
    if not common:
        # No common merge; each branch goes to different terminal
        # Return the kept_target as the "merge" (it's the decision boundary)
        return kept_target
    
    # Find the earliest (closest to split_node in topological order)
    topo_order = list(nx.topological_sort(graph))
    for node in topo_order:
        if node in common:
            return node
    
    # Fallback
    return kept_target


def find_separator_for_branch(
    graph: nx.DiGraph,
    split_node: str,
    branch_first_hop: str,
    merge_node: str,
    kept_path: List[str]
) -> str:
    """
    Find the separator node S for an alternate branch.
    
    The separator is the earliest node that:
    - All paths from split_node through branch_first_hop to merge_node must cross
    - Is not on the kept_path (before reaching merge_node)
    
    Uses post-dominance analysis.
    
    Args:
        graph: Directed acyclic graph
        split_node: Source node
        branch_first_hop: The competing first hop we need to separate
        merge_node: Target merge point
        kept_path: The path through the kept edge (for exclusion)
        
    Returns:
        Separator node ID (defaults to merge_node if no better option)
    """
    # Compute all paths from branch_first_hop to merge_node
    try:
        all_paths = list(nx.all_simple_paths(graph, branch_first_hop, merge_node))
    except nx.NetworkXNoPath:
        # Branch doesn't reach merge; use the first hop itself as separator
        return branch_first_hop
    
    if not all_paths:
        return merge_node
    
    # Find nodes that appear in ALL paths (post-dominators relative to branch_first_hop)
    path_sets = [set(path) for path in all_paths]
    post_dominators = set.intersection(*path_sets)
    
    # Remove nodes on kept_path (up to merge, excluding merge itself)
    try:
        merge_idx = kept_path.index(merge_node)
        kept_before_merge = set(kept_path[:merge_idx])
    except ValueError:
        kept_before_merge = set()
    
    # Remove split node (it's the anchor)
    candidates = post_dominators - kept_before_merge - {split_node}
    
    if not candidates:
        # No valid separator found; default to merge_node
        return merge_node
    
    # Return the earliest candidate (closest to branch_first_hop)
    # Use topological order
    topo_order = list(nx.topological_sort(graph))
    for node in topo_order:
        if node in candidates:
            return node
    
    return merge_node


def compile_to_subtractive_query(
    graph: nx.DiGraph,
    split_node: str,
    kept_target: str,
    merge_node: str,
    competing_hops: List[str]
) -> str:
    """
    Build a subtractive plan by enumerating all simple A→M paths and
    emitting a minus term per non-direct path (MECE over simple paths).
    Each minus term specifies the interior nodes in order via visited(...).
    
    Args:
        graph: Directed acyclic graph
        split_node: Source node with multiple outgoing edges
        kept_target: The direct target we want to isolate
        merge_node: Post-merge node that resolves the decision
        competing_hops: List of competing first-hop nodes
        
    Returns:
        Complete DSL query string with minus() terms
    """
    base = f"from({split_node}).to({merge_node})"
    minus_terms: List[str] = []
    # Enumerate all simple paths A→M and emit a minus per non-direct path (MECE over paths)
    try:
        all_paths = list(nx.all_simple_paths(graph, split_node, merge_node))
    except nx.NetworkXNoPath:
        all_paths = []
    for path in all_paths:
        if len(path) <= 2:
            continue  # skip direct a->m
        interior = path[1:-1]
        visited_chain = "".join([f".visited({node})" for node in interior])
        minus_terms.append(f"minus(from({split_node}).to({merge_node}){visited_chain})")
    # Combine
    return f"{base}.{'.'.join(minus_terms)}" if minus_terms else base


def compile_query_for_edge(
    graph: nx.DiGraph,
    edge: Tuple[str, str],
    provider: str,
    supports_native_exclude: bool,
    use_optimized: bool = True
) -> str:
    """
    Generate the optimal query DSL string for an edge, given provider capabilities.
    
    Policy:
    - If provider supports native excludes: use exclude() (single query)
    - If provider lacks native support: compile to inclusion-exclusion (minus/plus terms)
    
    Args:
        graph: Directed acyclic graph
        edge: (source, target) tuple
        provider: Provider name (for logging)
        supports_native_exclude: Whether provider supports native exclude
        use_optimized: If True, use optimized inclusion-exclusion with reachability pruning
        
    Returns:
        Complete DSL query string (or tuple of (query, terms) if returning coefficients)
    """
    source, target = edge
    
    # For edge discrimination, merge is ALWAYS the target
    # We're measuring P(a→b) = users who go from event a to event b
    merge_node = target
    
    # Determine if this edge needs exclusion logic
    # (i.e., are there competing branches from source that can reach target?)
    competing = get_competing_first_hops(graph, source, target, merge_node)
    
    if not competing:
        # Simple edge; no exclusion needed
        return f"from({source}).to({target})"
    
    # Check if provider supports native excludes
    if supports_native_exclude:
        # Use exclude() syntax (provider will handle it natively)
        excludes_list = ",".join(competing)
        return f"from({source}).to({merge_node}).exclude({excludes_list})"
    
    # Provider doesn't support native excludes
    # Use optimized inclusion-exclusion
    from optimized_inclusion_exclusion import compile_optimized_inclusion_exclusion
    
    query, terms = compile_optimized_inclusion_exclusion(
        graph, source, target, merge_node, competing
    )
    
    return query

