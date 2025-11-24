"""
MSMDC: Minimal Set of Maximally Discriminating Constraints

Auto-generates optimal query strings for data retrieval from external sources (Amplitude, etc.)
by finding the minimal set of constraints that uniquely identify a target path.

Based on: query-algorithms-white-paper.md
Algorithm (witness-guided, no full enumeration):
- Anchored at from(edge.from)->to(edge.to)
- Discriminate satisfying vs violating journeys using constrained reachability
- Iteratively add visited()/exclude() until no violating journey exists
Complexity: Multiple DAG reachability checks (no 2^k explosion)

See also: lib/graph_select.py (topology filtering, different use case)
"""

from typing import List, Set, Dict, Any, Optional, Tuple, Iterable
from dataclasses import dataclass
import networkx as nx
from graph_types import Graph, Node, Edge
import re


@dataclass
class QueryConstraints:
    """Parsed constraints for a query."""
    from_node: str
    to_node: str
    visited: List[str]
    exclude: List[str]
    visited_any: List[List[str]]  # OR-groups
    cases: List[Tuple[str, str]]      # (case_id, variant) pairs
    contexts: List[Tuple[str, str]]   # (key, value) pairs
    
    def to_query_string(self) -> str:
        """Convert constraints to DSL query string."""
        parts = [f"from({self.from_node})", f"to({self.to_node})"]
        
        if self.visited:
            parts.append(f"visited({','.join(self.visited)})")
        
        if self.exclude:
            parts.append(f"exclude({','.join(self.exclude)})")
        
        for group in self.visited_any:
            if group:
                parts.append(f"visitedAny({','.join(group)})")
        
        for case_id, variant in self.cases:
            parts.append(f"case({case_id}:{variant})")
        
        for ctx_key, ctx_val in self.contexts:
            parts.append(f"context({ctx_key}:{ctx_val})")
        
        return ".".join(parts)


@dataclass
class MSMDCResult:
    """Result of MSMDC algorithm."""
    query_string: str
    constraints: QueryConstraints
    satisfying_found: bool
    coverage_stats: Dict[str, int]  # diagnostics (checks performed, literals count)


def generate_query_for_edge(
    graph: Graph,
    edge: Edge,
    condition: Optional[str] = None,
    max_checks: int = 200,
    literal_weights: Optional[Dict[str, float]] = None,
    preserve_condition: bool = True,
    preserve_case_context: bool = True,
    connection_name: Optional[str] = None,
    provider: Optional[str] = None
) -> MSMDCResult:
    """
    Generate minimal discriminating query for a specific edge (DATA RETRIEVAL).
    
    Args:
        graph: Full graph structure
        edge: Target edge to generate query for
        condition: Optional constraint string (visited/exclude/case/context clauses only)
        max_checks: Safety cap on reachability checks
        connection_name: Optional connection name (e.g., "amplitude-prod") for capability lookup
        provider: Optional provider type (e.g., "amplitude") as fallback for capability lookup
    
    Returns:
        MSMDCResult with query string and diagnostics
    """
    G, id_by_uuid = _build_networkx_graph(graph)
    # Default literal costs (lower is preferred)
    lw = literal_weights or {}
    cost_visited = float(lw.get("visited", 1.0))
    cost_exclude = float(lw.get("exclude", 1.0))
    # case/context are carried through for fidelity; not optimized here
    # Resolve UUIDs to human-readable IDs for query strings
    from_node = id_by_uuid.get(edge.from_node, edge.from_node)
    to_node = id_by_uuid.get(edge.to, edge.to)
    stats_checks = 0
    
    # Edge must exist (anchor)
    if not G.has_edge(from_node, to_node):
        return MSMDCResult(
            query_string=f"from({from_node}).to({to_node})",
            constraints=QueryConstraints(from_node, to_node, [], [], [], [], []),
            satisfying_found=False,
            coverage_stats={"checks": 0, "literals": 0}
        )
    
    # Parse condition into all constraint types
    if condition:
        cond_visited, cond_exclude, cond_cases, cond_contexts, cond_visited_any = _parse_condition(condition)
    else:
        cond_visited, cond_exclude, cond_cases, cond_contexts, cond_visited_any = ([], [], [], [], [])
    
    # Candidate literal universe: ancestors of from_node (upstream only)
    ancestors = _ancestors(G, from_node)
    # Remove anchors themselves
    if from_node in ancestors:
        ancestors.remove(from_node)
    if to_node in ancestors:
        ancestors.remove(to_node)
    
    # Find a satisfying witness path once (used to propose excludes)
    satisfying_path = _find_satisfying_path(G, from_node, to_node, cond_visited, cond_exclude, cond_visited_any)
    stats_checks += 1
    satisfying_found = satisfying_path is not None
    
    # Start with literals
    # If preserve_condition is True, seed with condition's visited/exclude (fidelity-first).
    # If False, start empty and allow the solver to express the constraint more cheaply (rewrite).
    L_vis: List[str] = sorted(set(cond_visited)) if preserve_condition else []
    L_exc: List[str] = sorted(set(cond_exclude)) if preserve_condition else []
    L_vany: List[List[str]] = [list(g) for g in cond_visited_any] if preserve_condition else []
    
    # If no satisfying path exists, return anchor with condition's case/context
    if not satisfying_found:
        constraints = QueryConstraints(from_node, to_node, L_vis, L_exc, L_vany, cond_cases, cond_contexts)
        return MSMDCResult(
            query_string=constraints.to_query_string(),
            constraints=constraints,
            satisfying_found=False,
            coverage_stats={"checks": stats_checks, "literals": 0}
        )
    
    # Special case: For unconditional queries (no condition), detect alternate paths
    # FROM the edge's from_node and add exclusions to discriminate direct from indirect
    if not condition or (not cond_visited and not cond_exclude and not cond_visited_any):
        # Check if there are alternate paths FROM from_node TO to_node (not using direct edge)
        # Get immediate predecessors of to_node (excluding from_node itself)
        predecessors = set(G.predecessors(to_node)) - {from_node}
        
        if predecessors:
            # Check if any of these predecessors are reachable from from_node
            for pred in predecessors:
                # If we can reach this predecessor from from_node, it's an alternate route
                path_to_pred = _reachable_path(G, from_node, pred, set())
                stats_checks += 1
                if path_to_pred:
                    # This is an alternate path: from_node → ... → pred → to_node
                    # Add pred to exclusions to discriminate the direct edge
                    if pred not in L_exc:
                        L_exc.append(pred)
    
    # Iteratively block violating witnesses
    max_iters = 64
    iters = 0
    while iters < max_iters and stats_checks < max_checks:
        iters += 1
        # 1) Violations by missing a required visited node (AND)
        missing_v: Optional[str] = None
        witness_missing: Optional[List[str]] = None
        for v in cond_visited:
            # Skip nodes that are not upstream
            if v not in ancestors and v != from_node:
                continue
            witness_missing = _find_path_avoiding(G, from_node, to_node, avoid_nodes=set([v]) | set(L_exc) | set(cond_exclude),
                                                  require_nodes=L_vis, require_edge=(from_node, to_node))
            stats_checks += 1
            if witness_missing:
                missing_v = v
                break
        
        if witness_missing:
            # Two candidate families:
            # - visited(missing_v): if the violating witness avoided a required node
            # - exclude(divergence_node): first node on witness not in satisfying path
            exclude_candidate = _first_divergence(witness_missing, satisfying_path, ancestors)
            # Choose by weighted cost preference when both exist
            if exclude_candidate and missing_v:
                if cost_visited <= cost_exclude:
                    if missing_v not in L_vis:
                        L_vis.append(missing_v)
                else:
                    # Heuristic: prefer excluding sibling alternatives of from_node over arbitrary divergence
                    if not preserve_condition:
                        siblings = [n for n in G.predecessors(from_node) if n != missing_v]
                        siblings = [n for n in siblings if n in ancestors or n == from_node]
                        if siblings:
                            # Add all sibling excludes cheaply
                            for s in siblings:
                                if s not in L_exc:
                                    L_exc.append(s)
                        else:
                            if exclude_candidate not in L_exc:
                                L_exc.append(exclude_candidate)
                    else:
                        if exclude_candidate not in L_exc:
                            L_exc.append(exclude_candidate)
            elif exclude_candidate:
                if exclude_candidate not in L_exc:
                    L_exc.append(exclude_candidate)
            elif missing_v:
                if missing_v not in L_vis:
                    L_vis.append(missing_v)
            continue
        
        # 1b) Violations by missing all nodes from a visitedAny group (OR group)
        missing_group_idx: Optional[int] = None
        witness_missing_group: Optional[List[str]] = None
        for gi, group in enumerate(cond_visited_any):
            # Consider only upstream candidates for speed
            group_upstream = [n for n in group if (n in ancestors or n == from_node)]
            if not group_upstream:
                # If no member is upstream, this group can't constrain; skip
                continue
            # Find witness that avoids all nodes in the group
            witness_missing_group = _find_path_avoiding(G, from_node, to_node,
                                                        avoid_nodes=set(group_upstream) | set(L_exc) | set(cond_exclude),
                                                        require_nodes=L_vis,
                                                        require_edge=(from_node, to_node))
            stats_checks += 1
            if witness_missing_group:
                missing_group_idx = gi
                break
        
        if witness_missing_group is not None and missing_group_idx is not None:
            group = cond_visited_any[missing_group_idx]
            # Choose cheapest action: add visited(x) for some x in group, or exclude divergence
            # Heuristic: prefer visited if cost_visited <= cost_exclude
            if cost_visited <= cost_exclude:
                # Pick first upstream member not already in L_vis
                for n in group:
                    if (n in ancestors or n == from_node) and n not in L_vis:
                        L_vis.append(n)
                        break
            else:
                exclude_candidate = _first_divergence(witness_missing_group, satisfying_path, ancestors)
                if exclude_candidate and exclude_candidate not in L_exc:
                    L_exc.append(exclude_candidate)
                else:
                    # Fallback to add a visited member
                    for n in group:
                        if (n in ancestors or n == from_node) and n not in L_vis:
                            L_vis.append(n)
                            break
            continue
        
        # 2) Violations by including an excluded node from condition
        offending_e: Optional[str] = None
        for e_node in cond_exclude:
            if e_node not in ancestors and e_node != from_node:
                continue
            witness_inc = _find_path_including(G, from_node, to_node, include_node=e_node,
                                               avoid_nodes=set(L_exc), require_nodes=L_vis,
                                               require_edge=(from_node, to_node))
            stats_checks += 1
            if witness_inc:
                offending_e = e_node
                break
        
        if offending_e:
            # Option A (rewrite): prefer visitedAny over siblings when visited is cheaper than exclude
            if not preserve_condition and cost_visited <= cost_exclude:
                # Siblings = other immediate predecessors of from_node (upstream alternatives)
                siblings = [n for n in G.predecessors(from_node) if n != offending_e]
                # Filter to upstream candidates (ancestors) to avoid degenerate markers
                siblings = [n for n in siblings if n in ancestors or n == from_node]
                if siblings:
                    # Deduplicate groups: treat as set equality
                    group_set = set(siblings)
                    already = any(set(g) == group_set for g in L_vany)
                    if not already:
                        L_vany.append(siblings)
                    continue
            # Option B: default to exclude(offending_e)
            if offending_e not in L_exc:
                L_exc.append(offending_e)
            continue
        
        # No violating witness remains; done
        break
    
    # Build constraints anchored at edge
    L_vis_sorted = sorted(set(L_vis))
    L_exc_sorted = sorted(set(L_exc))
    # Preserve case/context unless explicitly disabled
    final_cases = cond_cases if preserve_case_context else []
    final_contexts = cond_contexts if preserve_case_context else []
    constraints = QueryConstraints(from_node, to_node, L_vis_sorted, L_exc_sorted, L_vany, final_cases, final_contexts)
    
    # PROVIDER CAPABILITY CHECK: If exclude() is needed but provider doesn't support it,
    # compile to inclusion-exclusion (minus/plus terms)
    query_string = constraints.to_query_string()
    
    if L_exc_sorted:  # Only check if we have excludes
        from connection_capabilities import supports_native_exclude as check_native_exclude
        
        if not check_native_exclude(connection_name, provider):
            # Provider doesn't support native exclude - compile to minus()/plus()
            print(f"[MSMDC] Provider doesn't support native exclude; compiling to inclusion-exclusion")
            print(f"[MSMDC] Excludes to compile: {L_exc_sorted}")
            
            try:
                # Import MSMDC inclusion-exclusion algorithm (now in lib/algorithms/)
                import sys
                from pathlib import Path
                algorithms_path = Path(__file__).parent / 'algorithms'
                sys.path.insert(0, str(algorithms_path))
                
                from optimized_inclusion_exclusion import compile_optimized_inclusion_exclusion
                
                # Call NEW algorithm
                compiled_query, terms = compile_optimized_inclusion_exclusion(
                    G, from_node, to_node, to_node, L_exc_sorted
                )
                
                query_string = compiled_query
                print(f"[MSMDC] Compiled query: {query_string}")
                
            except Exception as e:
                print(f"[MSMDC ERROR] Failed to compile inclusion-exclusion: {e}")
                print(f"[MSMDC] Falling back to exclude() query (will fail at runtime)")
                # Keep original query_string with exclude()
    
    return MSMDCResult(
        query_string=query_string,
        constraints=constraints,
        satisfying_found=True,
        coverage_stats={"checks": stats_checks, "literals": len(L_vis_sorted) + len(L_exc_sorted)}
    )


# ============================================================================
def _parse_condition(condition: Optional[str]) -> Tuple[List[str], List[str], List[Tuple[str, str]], List[Tuple[str, str]], List[List[str]]]:
    """
    Parse a constraint-only DSL into all constraint types.
    
    Examples:
      "visited(a,b).exclude(c).case(test:treatment).context(device:mobile)"
    
    Returns: (visited_list, exclude_list, cases_list, contexts_list)
    where cases = [(case_id, variant), ...]
    and contexts = [(key, value), ...]
    """
    if not condition or not isinstance(condition, str):
        return ([], [], [], [], [])
    
    visited = []
    exclude = []
    cases = []
    contexts = []
    visited_any_groups: List[List[str]] = []
    
    # Find visited(...)
    for match in re.findall(r"visited\(([a-z0-9_.,-]+)\)", condition):
        for n in match.split(","):
            n = n.strip()
            if n:
                visited.append(n)
    
    # Find exclude(...)
    for match in re.findall(r"exclude\(([a-z0-9_.,-]+)\)", condition):
        for n in match.split(","):
            n = n.strip()
            if n:
                exclude.append(n)
    
    # Find case(id:variant)
    for match in re.findall(r"case\(([a-z0-9_-]+):([a-z0-9_-]+)\)", condition):
        cases.append((match[0], match[1]))
    
    # Find context(key:value)
    for match in re.findall(r"context\(([a-z0-9_-]+):([a-z0-9_-]+)\)", condition):
        contexts.append((match[0], match[1]))
    
    # Find visitedAny(a,b)
    for match in re.findall(r"visitedAny\(([a-z0-9_.,-]+)\)", condition):
        group = []
        seen = set()
        for n in match.split(","):
            n = n.strip()
            if n and n not in seen:
                seen.add(n)
                group.append(n)
        if group:
            visited_any_groups.append(group)
    
    # Deduplicate visited/exclude preserving order
    seen = set()
    v_out = []
    for n in visited:
        if n not in seen:
            seen.add(n)
            v_out.append(n)
    
    seen = set()
    e_out = []
    for n in exclude:
        if n not in seen:
            seen.add(n)
            e_out.append(n)
    
    # Deduplicate case/context
    cases = list(dict.fromkeys(cases))
    contexts = list(dict.fromkeys(contexts))
    
    return (v_out, e_out, cases, contexts, visited_any_groups)


def _ancestors(G: nx.DiGraph, node: str) -> Set[str]:
    """Get all ancestors (upstream) of a node."""
    try:
        return nx.ancestors(G, node)
    except Exception:
        return set()


def _reachable_path(G: nx.DiGraph, src: str, dst: str, removed: Set[str]) -> Optional[List[str]]:
    """Find any path from src to dst avoiding nodes in removed."""
    if src in removed or dst in removed:
        return None
    # Create a view that skips removed nodes
    def node_ok(n): return n not in removed
    H = G.subgraph([n for n in G.nodes if node_ok(n)]).copy()
    try:
        return nx.shortest_path(H, src, dst)
    except Exception:
        return None


def _exists_path_through_sequence(G: nx.DiGraph, sequence: List[str], removed: Set[str]) -> Optional[List[str]]:
    """
    Check existence of a path going through sequence of nodes in order.
    Return the concatenated path if exists (merging overlaps).
    """
    if not sequence:
        return None
    full: List[str] = []
    for i in range(len(sequence) - 1):
        seg = _reachable_path(G, sequence[i], sequence[i + 1], removed)
        if seg is None:
            return None
        if not full:
            full.extend(seg)
        else:
            # Merge overlap (drop first element of seg)
            full.extend(seg[1:])
    return full


def _entry_nodes(G: nx.DiGraph) -> List[str]:
    """Nodes with indegree 0."""
    return [n for n in G.nodes if G.in_degree(n) == 0]


def _find_satisfying_path(G: nx.DiGraph, from_node: str, to_node: str,
                          cond_visited: List[str], cond_exclude: List[str],
                          cond_visited_any: List[List[str]]) -> Optional[List[str]]:
    """
    Find any path ENTRY -> ... -> from_node -> to_node satisfying condition.
    """
    removed = set(cond_exclude)
    if not G.has_edge(from_node, to_node):
        return None
    # Candidate include sequence: [entry, v1, v2, ..., from_node, to_node]
    # Try each entry and topologically ordered cond_visited that are ancestors of from_node
    ancestors = _ancestors(G, from_node)
    include_nodes = [v for v in cond_visited if v in ancestors or v == from_node]
    # Rough topological order: use shortest path distances from entries heuristic
    entries = _entry_nodes(G)
    for entry in entries:
        if entry in removed:
            continue
        seq = [entry] + include_nodes + [from_node, to_node]
        path = _exists_path_through_sequence(G, seq, removed)
        if not path:
            continue
        # Ensure visitedAny groups are satisfied; if not, try to enforce a member
        ok = True
        path_set = set(path)
        for group in cond_visited_any:
            if not any(n in path_set for n in group):
                # Try inserting one group member by rebuilding sequence with that member before from_node
                inserted = False
                for n in group:
                    if n in removed:
                        continue
                    # Rebuild: entry -> include_nodes -> n -> from -> to
                    seq2 = [entry] + include_nodes + [n, from_node, to_node]
                    path2 = _exists_path_through_sequence(G, seq2, removed)
                    if path2:
                        path = path2
                        path_set = set(path2)
                        inserted = True
                        break
                if not inserted:
                    ok = False
                    break
        if ok:
            return path
    return None


def _find_path_avoiding(G: nx.DiGraph, from_node: str, to_node: str,
                        avoid_nodes: Set[str],
                        require_nodes: List[str],
                        require_edge: Tuple[str, str]) -> Optional[List[str]]:
    """
    Find ENTRY -> ... -> from_node -> to_node path that avoids avoid_nodes and includes require_nodes in order.
    """
    if not G.has_edge(*require_edge):
        return None
    removed = set(avoid_nodes)
    ancestors = _ancestors(G, from_node)
    include_nodes = [v for v in require_nodes if v in ancestors or v == from_node]
    entries = _entry_nodes(G)
    for entry in entries:
        if entry in removed:
            continue
        seq = [entry] + include_nodes + [from_node, to_node]
        path = _exists_path_through_sequence(G, seq, removed)
        if path:
            return path
    return None


def _find_path_including(G: nx.DiGraph, from_node: str, to_node: str,
                         include_node: str,
                         avoid_nodes: Set[str],
                         require_nodes: List[str],
                         require_edge: Tuple[str, str]) -> Optional[List[str]]:
    """
    Find ENTRY -> ... -> include_node -> ... -> from_node -> to_node path honoring avoid/require.
    """
    if not G.has_edge(*require_edge):
        return None
    removed = set(avoid_nodes)
    ancestors = _ancestors(G, from_node)
    incs = [v for v in require_nodes if v in ancestors or v == from_node]
    entries = _entry_nodes(G)
    for entry in entries:
        if entry in removed or include_node in removed:
            continue
        seq = [entry, include_node] + incs + [from_node, to_node]
        path = _exists_path_through_sequence(G, seq, removed)
        if path:
            return path
    return None


def _find_path_to_dest_avoiding_node(G: nx.DiGraph, dest: str, avoid_node: str) -> Optional[List[str]]:
    """
    Find any path from an entry node to dest that avoids a specific node.
    Used to detect alternate paths for unconditional edge queries.
    """
    entries = _entry_nodes(G)
    removed = {avoid_node}
    
    for entry in entries:
        if entry == avoid_node:
            continue
        path = _reachable_path(G, entry, dest, removed)
        if path:
            return path
    return None


def _first_divergence(witness: List[str], satisfying: Optional[List[str]], upstream: Set[str]) -> Optional[str]:
    """
    Pick the first node in witness that is not in the satisfying path and is upstream candidate.
    """
    if not satisfying:
        return None
    sat_set = set(satisfying)
    for n in witness:
        if n not in sat_set and n in upstream:
            return n
    return None


def _build_networkx_graph(graph: Graph) -> Tuple[nx.DiGraph, Dict[str, str]]:
    """
    Build NetworkX graph from schema-compliant Graph object.
    
    Returns:
        Tuple of (NetworkX graph, uuid_to_id mapping)
    """
    G = nx.DiGraph()
    # Map any identifier (uuid or id) to canonical node.id
    id_by_any: Dict[str, str] = {}
    for node in graph.nodes:
        id_by_any[node.id] = node.id
        if getattr(node, "uuid", None):
            id_by_any[node.uuid] = node.id
        G.add_node(node.id)
    # Add edges using canonical ids (resolve uuid or id)
    for edge in graph.edges:
        src_any = edge.from_node
        dst_any = edge.to
        src = id_by_any.get(src_any, src_any)
        dst = id_by_any.get(dst_any, dst_any)
        # Ensure nodes exist in graph with canonical ids
        if src not in G:
            G.add_node(src)
        if dst not in G:
            G.add_node(dst)
        G.add_edge(src, dst)
    # Ensure include/avoid checks can use node.id strings consistently
    return G, id_by_any


# ============================================================================
# Comprehensive Parameter Query Generation
# ============================================================================

def _extract_connection_info(edge: Edge) -> Tuple[Optional[str], Optional[str], bool]:
    """
    Extract connection info from ALL parameters on edge and determine if native exclude is supported.
    
    PESSIMISTIC POLICY: If ANY parameter uses a provider that doesn't support native exclude,
    we generate minus()/plus() queries for the entire edge.
    
    Rationale:
    - Single query string per edge (stored in edge.query)
    - Query must work for ALL parameters on that edge
    - User-visible query should reflect what actually executes
    
    Args:
        edge: Edge object
    
    Returns:
        Tuple of (connection_name, provider, supports_exclude)
        - connection_name: First non-None connection found (for logging)
        - provider: First non-None provider found (for capability lookup)
        - supports_exclude: True only if ALL data sources support native exclude
    """
    import json
    from connection_capabilities import supports_native_exclude as check_supports
    
    all_data_sources = []
    
    # Collect all data sources on this edge
    if hasattr(edge, 'p') and edge.p:
        ds = getattr(edge.p, 'data_source', None)
        if ds:
            all_data_sources.append(ds)
    
    # Conditional probabilities
    if hasattr(edge, 'conditional_p') and edge.conditional_p:
        for cond_p in edge.conditional_p:
            if hasattr(cond_p, 'p') and cond_p.p:
                ds = getattr(cond_p.p, 'data_source', None)
                if ds:
                    all_data_sources.append(ds)
    
    # Cost parameters
    if hasattr(edge, 'cost_gbp') and edge.cost_gbp:
        ds = getattr(edge.cost_gbp, 'data_source', None)
        if ds:
            all_data_sources.append(ds)
    
    if hasattr(edge, 'cost_time') and edge.cost_time:
        ds = getattr(edge.cost_time, 'data_source', None)
        if ds:
            all_data_sources.append(ds)
    
    # If no data sources, assume exclude is NOT supported (conservative)
    if not all_data_sources:
        return None, None, False
    
    # Check each data source's capability
    all_support_exclude = True
    first_connection_name = None
    first_provider = None
    
    for ds in all_data_sources:
        # Extract connection name
        connection_name = None
        if hasattr(ds, 'connection_settings') and ds.connection_settings:
            try:
                settings = json.loads(ds.connection_settings)
                connection_name = settings.get('connection_name')
            except:
                pass
        
        # Extract provider
        provider = getattr(ds, 'source_type', None)
        
        # Remember first non-None values for return
        if not first_connection_name and connection_name:
            first_connection_name = connection_name
        if not first_provider and provider:
            first_provider = provider
        
        # Check if this provider supports exclude
        if not check_supports(connection_name, provider):
            all_support_exclude = False
            # Don't break - we still want to collect connection info
    
    return first_connection_name, first_provider, all_support_exclude


@dataclass
class ParameterQuery:
    """A parameter requiring data retrieval with its generated query."""
    param_type: str  # "edge_base_p", "edge_conditional_p", "edge_cost_gbp", etc.
    param_id: str    # Unique identifier for this parameter
    edge_key: str    # "{from}->{to}"
    condition: Optional[str]  # Original condition string if applicable
    query: str       # Generated MSMDC query
    stats: Dict[str, Any]  # Generation statistics


def generate_all_parameter_queries(
    graph: Graph,
    max_checks: int = 200,
    downstream_of: Optional[str] = None,
    literal_weights: Optional[Dict[str, float]] = None,
    preserve_condition: bool = True,
    preserve_case_context: bool = True,
    edge_uuid: Optional[str] = None,  # Filter to specific edge (uuid)
    conditional_index: Optional[int] = None  # Filter to specific conditional (requires edge_uuid)
) -> List[ParameterQuery]:
    """
    Generate MSMDC queries for ALL parameters in a graph.
    
    Covers:
    - Edge base probabilities (edge.p)
    - Edge conditional probabilities (edge.conditional_p[])
    - Edge costs (edge.cost_gbp, edge.cost_time)
    - Case node variants (node.case.variants[])
    - Context parameters (inferred from conditions)
    
    Args:
        graph: Full graph structure
        max_checks: Safety cap on reachability checks per parameter
        downstream_of: Optional node ID - only regenerate params for edges downstream of this node
                      (Performance: trigger only on affected subgraph after edit)
    
    Returns:
        List of ParameterQuery objects with generated queries
    
    Performance: 
    - Full graph: All parameters in single roundtrip
    - Downstream filter: Only affected edges (incremental updates)
    """
    parameters = []
    
    # Build UUID->ID mapping for query generation
    id_by_uuid = {node.uuid: node.id for node in graph.nodes}
    
    # Build graph for downstream filtering if needed
    if downstream_of:
        G, _ = _build_networkx_graph(graph)
        try:
            # Resolve downstream_of to ID if it's a UUID
            downstream_id = id_by_uuid.get(downstream_of, downstream_of)
            # Get all descendants (downstream nodes) from the edited node
            downstream_nodes = nx.descendants(G, downstream_id)
            downstream_nodes.add(downstream_id)  # Include the node itself
        except:
            downstream_nodes = set()  # If node doesn't exist, process all
    else:
        downstream_nodes = None  # Process all edges
    
    # Process each edge
    for edge in graph.edges:
        # Skip if filtering by edge_uuid and this isn't the target edge
        if edge_uuid is not None and edge.uuid != edge_uuid:
            continue
        
        # Resolve edge nodes to IDs for query generation
        from_id = id_by_uuid.get(edge.from_node, edge.from_node)
        to_id = id_by_uuid.get(edge.to, edge.to)
        edge_key = f"{from_id}->{to_id}"
        
        # Skip if filtering by downstream and this edge isn't affected
        if downstream_nodes is not None:
            # Edge is affected if source (from_node) is in the downstream set
            # This includes edges starting at edited node + all further downstream
            # Excludes edges ending at edited node from upstream (not affected by downstream changes)
            if from_id not in downstream_nodes:
                continue
        
        # Extract connection info ONCE per edge (pessimistic: checks ALL params)
        connection_name, provider, _ = _extract_connection_info(edge)
        
        # 1. Base probability (edge.p) - unconditional
        # Skip if filtering by conditional_index (only want conditional, not base)
        if edge.p and conditional_index is None:
            # Use real param_id if exists, otherwise generate synthetic ID
            param_id = getattr(edge.p, 'id', None) or f"synthetic:{edge.uuid}:p"
            result = generate_query_for_edge(graph, edge, condition=None, max_checks=max_checks, literal_weights=literal_weights, preserve_condition=preserve_condition, preserve_case_context=preserve_case_context, connection_name=connection_name, provider=provider)
            parameters.append(ParameterQuery(
                param_type="edge_base_p",
                param_id=param_id,
                edge_key=edge_key,
                condition=None,
                query=result.query_string,
                stats=result.coverage_stats
            ))
        
        # 2. Conditional probabilities (edge.conditional_p[])
        if edge.conditional_p:
            for idx, cond_p in enumerate(edge.conditional_p):
                # Skip if filtering by conditional_index and this isn't the target
                if conditional_index is not None and idx != conditional_index:
                    continue
                
                # Use real param_id if exists, otherwise generate synthetic ID
                param_id = getattr(cond_p.p, 'id', None) or f"synthetic:{edge.uuid}:conditional_p[{idx}]"
                condition_str = cond_p.condition
                result = generate_query_for_edge(graph, edge, condition=condition_str, max_checks=max_checks, literal_weights=literal_weights, preserve_condition=preserve_condition, preserve_case_context=preserve_case_context, connection_name=connection_name, provider=provider)
                parameters.append(ParameterQuery(
                    param_type="edge_conditional_p",
                    param_id=param_id,
                    edge_key=edge_key,
                    condition=condition_str,
                    query=result.query_string,
                    stats=result.coverage_stats
                ))
        
        # 3. Cost parameters (edge.cost_gbp, edge.cost_time)
        # These use same query as base probability (unconditional)
        # Note: connection_name/provider already extracted above (pessimistic check)
        # Skip if filtering by conditional_index (only want conditional, not costs)
        if edge.cost_gbp and conditional_index is None:
            # Use real param_id if exists, otherwise generate synthetic ID
            param_id = getattr(edge.cost_gbp, 'id', None) or f"synthetic:{edge.uuid}:cost_gbp"
            result = generate_query_for_edge(graph, edge, condition=None, max_checks=max_checks, literal_weights=literal_weights, preserve_condition=preserve_condition, preserve_case_context=preserve_case_context, connection_name=connection_name, provider=provider)
            parameters.append(ParameterQuery(
                param_type="edge_cost_gbp",
                param_id=param_id,
                edge_key=edge_key,
                condition=None,
                query=result.query_string,
                stats=result.coverage_stats
            ))
        
        if edge.cost_time and conditional_index is None:
            # Use real param_id if exists, otherwise generate synthetic ID
            param_id = getattr(edge.cost_time, 'id', None) or f"synthetic:{edge.uuid}:cost_time"
            result = generate_query_for_edge(graph, edge, condition=None, max_checks=max_checks, literal_weights=literal_weights, preserve_condition=preserve_condition, preserve_case_context=preserve_case_context, connection_name=connection_name, provider=provider)
            parameters.append(ParameterQuery(
                param_type="edge_cost_time",
                param_id=param_id,
                edge_key=edge_key,
                condition=None,
                query=result.query_string,
                stats=result.coverage_stats
            ))
    
    # 4. Case node variants
    for node in graph.nodes:
        if node.case and node.case.variants:
            # For each variant, generate queries for downstream edges
            # Use real case_id if exists, otherwise generate synthetic ID
            case_id = node.case.id or f"synthetic:{node.uuid}:case"
            
            for variant in node.case.variants:
                variant_name = variant.name
                
                # Find all edges leaving this case node
                outgoing_edges = [e for e in graph.edges if e.from_node == node.id]
                
                for edge in outgoing_edges:
                    edge_key = f"{edge.from_node}->{edge.to}"
                    # Each case edge needs case(case_id:variant) in query
                    condition_str = f"case({case_id}:{variant_name})"
                    connection_name, provider, _ = _extract_connection_info(edge)
                    result = generate_query_for_edge(graph, edge, condition=condition_str, max_checks=max_checks, literal_weights=literal_weights, preserve_condition=preserve_condition, preserve_case_context=preserve_case_context, connection_name=connection_name, provider=provider)
                    
                    parameters.append(ParameterQuery(
                        param_type="case_variant_edge",
                        param_id=case_id,  # Real case file ID or synthetic
                        edge_key=edge_key,
                        condition=condition_str,
                        query=result.query_string,
                        stats=result.coverage_stats
                    ))
    
    return parameters


def generate_queries_by_type(
    graph: Graph,
    param_types: Optional[List[str]] = None,
    max_checks: int = 200,
    downstream_of: Optional[str] = None,
    literal_weights: Optional[Dict[str, float]] = None,
    preserve_condition: bool = True,
    preserve_case_context: bool = True
) -> Dict[str, List[ParameterQuery]]:
    """
    Generate queries for specific parameter types only.
    
    Args:
        graph: Full graph structure
        param_types: List of types to include (default: all)
                    Options: "edge_base_p", "edge_conditional_p", "edge_cost_gbp",
                            "edge_cost_time", "case_variant_edge"
        max_checks: Safety cap per parameter
        downstream_of: Optional node ID - only process downstream edges
    
    Returns:
        Dict mapping param_type -> List[ParameterQuery]
    """
    all_params = generate_all_parameter_queries(graph, max_checks, downstream_of, literal_weights, preserve_condition, preserve_case_context)
    
    if param_types is None:
        param_types = ["edge_base_p", "edge_conditional_p", "edge_cost_gbp", 
                      "edge_cost_time", "case_variant_edge"]
    
    result = {ptype: [] for ptype in param_types}
    for param in all_params:
        if param.param_type in param_types:
            result[param.param_type].append(param)
    
    return result

