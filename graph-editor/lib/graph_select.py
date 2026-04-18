"""
Graph Query Operations - TOPOLOGY FILTERING ONLY

Apply DSL queries to graph structures to extract subgraphs based on path topology.

IMPORTANT: This module handles GRAPH STRUCTURE FILTERING, not data retrieval.

Three distinct uses of query DSL strings:
1. **Topology Filtering** (this module): Filter graph to return subgraph
   - Example: from(a).to(d).exclude(e) → returns nodes/edges on valid paths
   
2. **Conditional Metadata** (on edges): Semantic constraint for when edge applies  
   - Example: edge.conditional_p[0].condition = "visited(b)"
   - Meaning: "This probability applies when user came through B"
   
3. **Data Retrieval** (external systems like Amplitude): Full path context for n/k
   - Example: edge.conditional_p[0].query = "from(b).to(d).visited(c)"  
   - Meaning: "Count users who went B→C→D to get n/k for edge C→D"
   - Critical: Query includes upstream context but we're measuring a segment

This module implements #1 only. Data retrieval query construction is separate.

Uses schema-based Pydantic types from graph_types.py - NO manual dict parsing.
"""

from dataclasses import dataclass
from typing import List, Set, Union, Dict, Any
import networkx as nx
from query_dsl import ParsedQuery, parse_query_strict
from graph_types import Graph, Node, Edge


def apply_query_to_graph(graph_input: Union[Graph, Dict[str, Any]], query_string: str) -> Dict[str, Any]:
    """
    Apply a DSL query to a graph and return the filtered subgraph.
    
    Args:
        graph_input: Graph object or dict that will be validated against schema
        query_string: Query DSL string (e.g., "from(a).to(b).visited(c)")
    
    Returns:
        Filtered graph as dict with only relevant nodes and edges
    
    Example:
        >>> graph = Graph(nodes=[...], edges=[...], ...)
        >>> result = apply_query_to_graph(graph, "from(start).to(end)")
        >>> result["nodes"]  # Only nodes on paths from start to end
    """
    
    # Validate input against schema
    if isinstance(graph_input, dict):
        # For testing: accept minimal dict format without full schema validation
        # In production, use: graph = Graph.model_validate(graph_input)
        graph = _parse_minimal_graph(graph_input)
    else:
        graph = graph_input
    
    # Parse the query (strict - requires from/to for topology filtering)
    query = parse_query_strict(query_string)
    
    # Build NetworkX graph for traversal
    G = _build_networkx_graph(graph)
    
    # Find all valid paths
    valid_paths = _find_paths_matching_query(G, query)
    
    # Extract nodes and edges from valid paths
    relevant_node_ids = _extract_node_ids_from_paths(valid_paths)
    relevant_edges = _extract_edges_from_paths(valid_paths, graph)
    
    # Build filtered graph (return as dict for API compatibility)
    # MINIMAL PRUNING: Remove only nodes/edges not on valid paths, preserve everything else
    filtered_nodes = [n for n in graph.nodes if n.id in relevant_node_ids]
    
    result = {
        "nodes": [n.model_dump(by_alias=True) if hasattr(n, 'model_dump') else {"id": n.id} for n in filtered_nodes],
        "edges": [e.model_dump(by_alias=True) if hasattr(e, 'model_dump') else {"from": e.from_node, "to": e.to} for e in relevant_edges]
    }
    
    # Preserve original policies if present (full Graph schema)
    if hasattr(graph, 'policies') and graph.policies:
        result["policies"] = graph.policies.model_dump() if hasattr(graph.policies, 'model_dump') else graph.policies
    
    # Preserve original metadata and add query statistics
    if hasattr(graph, 'metadata') and graph.metadata:
        original_metadata = graph.metadata.model_dump() if hasattr(graph.metadata, 'model_dump') else graph.metadata
        result["metadata"] = {
            **original_metadata,
            "query_stats": {
                "query": query_string,
                "original_node_count": len(graph.nodes),
                "original_edge_count": len(graph.edges),
                "filtered_node_count": len(filtered_nodes),
                "filtered_edge_count": len(relevant_edges),
                "path_count": len(valid_paths)
            }
        }
    else:
        # Minimal graph (test format) - just query stats
        result["metadata"] = {
            "query_stats": {
                "query": query_string,
                "original_node_count": len(graph.nodes),
                "original_edge_count": len(graph.edges),
                "filtered_node_count": len(filtered_nodes),
                "filtered_edge_count": len(relevant_edges),
                "path_count": len(valid_paths)
            }
        }
    
    return result


def _parse_minimal_graph(graph_dict: Dict[str, Any]) -> Graph:
    """
    Parse minimal test graph format into Graph object.
    
    For testing only - accepts {"nodes": [{"id": "a"}], "edges": [{"source": "a", "target": "b"}]}
    """
    from pydantic import BaseModel, ConfigDict
    
    # Create minimal Node/Edge objects for testing
    class MinimalNode(BaseModel):
        id: str
        uuid: str = ""
        
    class MinimalEdge(BaseModel):
        model_config = ConfigDict(populate_by_name=True)
        from_node: str
        to: str
        uuid: str = ""
    
    nodes = []
    for n in graph_dict.get("nodes", []):
        nodes.append(MinimalNode(
            id=n.get("id", ""),
            uuid=n.get("uuid", n.get("id", ""))
        ))
    
    edges = []
    for e in graph_dict.get("edges", []):
        edges.append(MinimalEdge(
            from_node=e.get("from") or e.get("source", ""),
            to=e.get("to") or e.get("target", ""),
            uuid=e.get("uuid", "")
        ))
    
    # Return pseudo-graph with minimal schema compliance
    class MinimalGraph:
        def __init__(self, nodes, edges):
            self.nodes = nodes
            self.edges = edges
    
    return MinimalGraph(nodes, edges)


def _build_networkx_graph(graph: Graph) -> nx.DiGraph:
    """
    Convert Graph object to NetworkX directed graph.

    Uses node.id as the graph key (human-readable, matches DSL from()/to()).
    Edge from_node/to fields may be UUIDs — these are mapped to node.id
    via a UUID→id lookup.
    """
    G = nx.DiGraph()

    # Build UUID → id mapping for nodes.
    uuid_to_id: Dict[str, str] = {}
    for node in graph.nodes:
        G.add_node(node.id)
        node_uuid = getattr(node, 'uuid', None) or ''
        if node_uuid:
            uuid_to_id[node_uuid] = node.id
        # Also map id→id for graphs where edges use IDs directly.
        uuid_to_id[node.id] = node.id

    # Add edges, resolving from_node/to from UUID to node.id.
    for edge in graph.edges:
        source = uuid_to_id.get(edge.from_node, edge.from_node)
        target = uuid_to_id.get(edge.to, edge.to)
        G.add_edge(source, target)

    return G


def _find_paths_matching_query(G: nx.DiGraph, query: ParsedQuery) -> List[List[str]]:
    """
    Find all paths from source to target that satisfy query constraints.
    
    Constraints:
    - Must go from query.from_node to query.to_node
    - Must visit all nodes in query.visited
    - Must NOT visit any nodes in query.exclude
    - (context and case filters not implemented yet - future work)
    """
    
    # Check if source and target exist
    if query.from_node not in G.nodes():
        return []
    if query.to_node not in G.nodes():
        return []
    
    # Find all simple paths
    try:
        all_paths = list(nx.all_simple_paths(G, query.from_node, query.to_node))
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        return []
    
    # Filter paths by constraints
    valid_paths = []
    for path in all_paths:
        path_set = set(path)
        
        # Check exclude constraint
        if any(excluded in path_set for excluded in query.exclude):
            continue
        
        # Check visited constraint
        if not all(visited in path_set for visited in query.visited):
            continue
        
        valid_paths.append(path)
    
    return valid_paths


@dataclass
class ResolvedEdge:
    """An edge on a resolved path with its structural role."""
    edge_uuid: str
    from_node_id: str
    to_node_id: str
    path_role: str  # 'first', 'last', 'intermediate', or 'only' (single-edge path)


@dataclass
class ResolvedPath:
    """Ordered edges on the resolved path(s) from source to target."""
    from_node: str
    to_node: str
    ordered_edges: List[ResolvedEdge]
    all_edge_uuids: Set[str]


def resolve_ordered_path(
    graph_input: Union[Graph, Dict[str, Any]],
    query_string: str,
) -> ResolvedPath:
    """Resolve a DSL query to an ordered list of edges on valid paths.

    Uses the same path-finding logic as apply_query_to_graph but returns
    structured edge information with first/last/intermediate annotations
    rather than a filtered graph.

    Args:
        graph_input: Graph object or dict
        query_string: DSL string with from()/to() endpoints

    Returns:
        ResolvedPath with ordered edges and path roles.
        If no valid path exists, returns a ResolvedPath with empty edges.
    """
    if isinstance(graph_input, dict):
        graph = _parse_minimal_graph(graph_input)
    else:
        graph = graph_input

    query = parse_query_strict(query_string)
    G = _build_networkx_graph(graph)
    valid_paths = _find_paths_matching_query(G, query)

    if not valid_paths:
        return ResolvedPath(
            from_node=query.from_node,
            to_node=query.to_node,
            ordered_edges=[],
            all_edge_uuids=set(),
        )

    # Build UUID → node.id mapping for resolving edge endpoints.
    uuid_to_id: Dict[str, str] = {}
    for node in graph.nodes:
        node_uuid = getattr(node, 'uuid', None) or ''
        if node_uuid:
            uuid_to_id[node_uuid] = node.id
        uuid_to_id[node.id] = node.id

    # Build a lookup from (from_node_id, to_node_id) → edge objects.
    # Edge from_node/to may be UUIDs — resolve to node.id.
    edge_lookup: Dict[tuple, list] = {}
    for edge in graph.edges:
        src_id = uuid_to_id.get(edge.from_node, edge.from_node)
        tgt_id = uuid_to_id.get(edge.to, edge.to)
        key = (src_id, tgt_id)
        edge_lookup.setdefault(key, []).append(edge)

    # Collect all (from, to) pairs across all valid paths, preserving
    # topological order from the longest path for edge ordering.
    # Use the union of all paths to get the full edge set.
    all_pairs_ordered: List[tuple] = []
    seen_pairs: Set[tuple] = set()

    # Sort paths longest-first so the ordering reflects the full chain.
    for path in sorted(valid_paths, key=len, reverse=True):
        for i in range(len(path) - 1):
            pair = (path[i], path[i + 1])
            if pair not in seen_pairs:
                seen_pairs.add(pair)
                all_pairs_ordered.append(pair)

    # Identify which node IDs are the from-node and to-node of the query.
    from_id = query.from_node
    to_id = query.to_node

    # Build resolved edges with path roles.
    resolved: List[ResolvedEdge] = []
    all_uuids: Set[str] = set()

    for pair in all_pairs_ordered:
        edges_for_pair = edge_lookup.get(pair, [])
        for edge in edges_for_pair:
            is_first = (pair[0] == from_id)
            is_last = (pair[1] == to_id)

            if is_first and is_last:
                role = 'only'
            elif is_first:
                role = 'first'
            elif is_last:
                role = 'last'
            else:
                role = 'intermediate'

            edge_uuid = getattr(edge, 'uuid', '') or ''
            resolved.append(ResolvedEdge(
                edge_uuid=edge_uuid,
                from_node_id=pair[0],
                to_node_id=pair[1],
                path_role=role,
            ))
            if edge_uuid:
                all_uuids.add(edge_uuid)

    return ResolvedPath(
        from_node=from_id,
        to_node=to_id,
        ordered_edges=resolved,
        all_edge_uuids=all_uuids,
    )


def resolve_children_edges(
    graph_input: Union[Graph, Dict[str, Any]],
    parent_node_id: str,
) -> List[ResolvedEdge]:
    """Resolve all outgoing edges from a node (children_of_selected_node scope).

    Args:
        graph_input: Graph object or dict
        parent_node_id: The node ID whose outgoing edges to return

    Returns:
        List of ResolvedEdge with path_role=None (no path ordering).
    """
    if isinstance(graph_input, dict):
        graph = _parse_minimal_graph(graph_input)
    else:
        graph = graph_input

    # Build UUID → node.id mapping.
    uuid_to_id: Dict[str, str] = {}
    for node in graph.nodes:
        node_uuid = getattr(node, 'uuid', None) or ''
        if node_uuid:
            uuid_to_id[node_uuid] = node.id
        uuid_to_id[node.id] = node.id

    result: List[ResolvedEdge] = []
    for edge in graph.edges:
        src_id = uuid_to_id.get(edge.from_node, edge.from_node)
        if src_id == parent_node_id:
            tgt_id = uuid_to_id.get(edge.to, edge.to)
            result.append(ResolvedEdge(
                edge_uuid=getattr(edge, 'uuid', '') or '',
                from_node_id=src_id,
                to_node_id=tgt_id,
                path_role='child',
            ))
    return result


def resolve_all_parameter_edges(
    graph_input: Union[Graph, Dict[str, Any]],
) -> List[ResolvedEdge]:
    """Return all edges in the graph (all_graph_parameters scope).

    Args:
        graph_input: Graph object or dict

    Returns:
        List of ResolvedEdge with path_role='all'.
    """
    if isinstance(graph_input, dict):
        graph = _parse_minimal_graph(graph_input)
    else:
        graph = graph_input

    # Map UUID → node.id (same convention as resolve_ordered_path).
    # Edge from_node/to may be UUIDs — callers expect node IDs.
    uuid_to_id: Dict[str, str] = {}
    for node in graph.nodes:
        node_uuid = getattr(node, 'uuid', None) or ''
        if node_uuid:
            uuid_to_id[node_uuid] = node.id
        uuid_to_id[node.id] = node.id

    return [
        ResolvedEdge(
            edge_uuid=getattr(edge, 'uuid', '') or '',
            from_node_id=uuid_to_id.get(edge.from_node, edge.from_node),
            to_node_id=uuid_to_id.get(edge.to, edge.to),
            path_role='all',
        )
        for edge in graph.edges
    ]


def _extract_node_ids_from_paths(paths: List[List[str]]) -> Set[str]:
    """Extract unique node IDs from all valid paths."""
    node_ids = set()
    for path in paths:
        node_ids.update(path)
    return node_ids


def _extract_edges_from_paths(paths: List[List[str]], graph: Graph) -> List:
    """Extract Edge objects that appear in any valid path."""

    # Build set of (source, target) pairs from paths (node IDs).
    path_edges = set()
    for path in paths:
        for i in range(len(path) - 1):
            path_edges.add((path[i], path[i + 1]))

    # Build UUID → node.id mapping.
    uuid_to_id: Dict[str, str] = {}
    for node in graph.nodes:
        node_uuid = getattr(node, 'uuid', None) or ''
        if node_uuid:
            uuid_to_id[node_uuid] = node.id
        uuid_to_id[node.id] = node.id

    # Filter graph edges to those in valid paths (resolve UUIDs to IDs).
    relevant_edges = []
    for edge in graph.edges:
        src_id = uuid_to_id.get(edge.from_node, edge.from_node)
        tgt_id = uuid_to_id.get(edge.to, edge.to)
        if (src_id, tgt_id) in path_edges:
            relevant_edges.append(edge)

    return relevant_edges
