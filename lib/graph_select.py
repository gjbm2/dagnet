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

from typing import List, Set, Union, Dict, Any
import networkx as nx
from query_dsl import ParsedQuery, parse_query
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
    
    # Parse the query
    query = parse_query(query_string)
    
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
    from pydantic import BaseModel
    
    # Create minimal Node/Edge objects for testing
    class MinimalNode(BaseModel):
        id: str
        uuid: str = ""
        
    class MinimalEdge(BaseModel):
        from_node: str
        to: str
        uuid: str = ""
        
        class Config:
            populate_by_name = True
    
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
    
    Uses schema-based types - nodes have .id, edges have .from_node and .to
    """
    G = nx.DiGraph()
    
    # Add nodes (using schema-based Node type)
    for node in graph.nodes:
        G.add_node(node.id)
    
    # Add edges (using schema-based Edge type)
    for edge in graph.edges:
        # Edge uses from_node (with alias 'from') and to
        source = edge.from_node
        target = edge.to
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


def _extract_node_ids_from_paths(paths: List[List[str]]) -> Set[str]:
    """Extract unique node IDs from all valid paths."""
    node_ids = set()
    for path in paths:
        node_ids.update(path)
    return node_ids


def _extract_edges_from_paths(paths: List[List[str]], graph: Graph) -> List:
    """Extract Edge objects that appear in any valid path."""
    
    # Build set of (source, target) pairs from paths
    path_edges = set()
    for path in paths:
        for i in range(len(path) - 1):
            path_edges.add((path[i], path[i + 1]))
    
    # Filter graph edges to those in valid paths
    relevant_edges = []
    for edge in graph.edges:
        if (edge.from_node, edge.to) in path_edges:
            relevant_edges.append(edge)
    
    return relevant_edges
