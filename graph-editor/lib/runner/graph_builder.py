"""
Graph Builder

Converts DagNet graph format to NetworkX DiGraph for analysis.

Schema Reference: /docs/current/project-analysis/SCHEMA_REFERENCE.md
"""

from typing import Any, Optional
import networkx as nx


def build_networkx_graph(graph_data: dict[str, Any]) -> nx.DiGraph:
    """
    Build NetworkX DiGraph from DagNet graph data.
    
    Args:
        graph_data: Dict with 'nodes', 'edges', 'policies', 'metadata'
    
    Returns:
        NetworkX DiGraph with node/edge attributes
    
    Node attributes:
        - id: Human-readable ID
        - uuid: UUID
        - absorbing: Is absorbing node
        - is_entry: Is entry node
        - is_case: Is case/experiment node
        - case_data: Case node data (if is_case)
        - (all original node data preserved)
    
    Edge attributes:
        - uuid: Edge UUID
        - id: Human-readable ID (if present)
        - p: Base probability (extracted from p.mean)
        - p_stdev: Probability standard deviation
        - p_distribution: Distribution type ('beta', 'normal', 'uniform')
        - evidence: Evidence dict with n, k (sample size, conversions)
        - conditional_p: List of conditional probabilities
        - cost_gbp: Monetary cost (extracted from cost_gbp.mean)
        - cost_gbp_stdev: Cost standard deviation
        - labour_cost: Time cost (extracted from labour_cost.mean)
        - labour_cost_stdev: Time cost standard deviation
        - case_id: Parent case ID (for case edges)
        - case_variant: Variant name (for case edges)
        - (all original edge data preserved)
    """
    G = nx.DiGraph()
    
    # Build node ID lookup (uuid -> node data)
    node_lookup = {}
    for node in graph_data.get('nodes', []):
        node_uuid = node.get('uuid')
        node_id = node.get('id')
        if node_uuid:
            node_lookup[node_uuid] = node
        if node_id:
            node_lookup[node_id] = node
    
    # Add nodes
    for node in graph_data.get('nodes', []):
        node_uuid = node.get('uuid') or node.get('id')
        if not node_uuid:
            continue
        
        # Extract key attributes
        is_entry = False
        entry_data = node.get('entry', {})
        if entry_data:
            is_entry = entry_data.get('is_start', False)
        
        is_absorbing = node.get('absorbing', False)
        is_case = node.get('case') is not None
        
        G.add_node(
            node_uuid,
            id=node.get('id', node_uuid),
            uuid=node.get('uuid', node_uuid),
            absorbing=is_absorbing,
            is_entry=is_entry,
            is_case=is_case,
            case_data=node.get('case'),
            label=node.get('label'),
            **{k: v for k, v in node.items() if k not in ['uuid', 'id', 'absorbing', 'entry', 'case', 'label']}
        )
    
    # Add edges
    for edge in graph_data.get('edges', []):
        source = edge.get('from')
        target = edge.get('to')
        
        if not source or not target:
            continue
        
        # Resolve source/target to node UUIDs
        source = _resolve_node_id(source, node_lookup)
        target = _resolve_node_id(target, node_lookup)
        
        if source not in G.nodes or target not in G.nodes:
            # Skip edges with invalid node references
            continue
        
        # Extract probability and uncertainty
        p_mean = _extract_probability(edge, graph_data)
        p_stdev = _extract_stdev(edge.get('p'))
        p_distribution = _extract_distribution(edge.get('p'))
        
        # Extract evidence (n/k for sample size and conversions)
        evidence = _extract_evidence(edge.get('p'))
        
        # Extract forecast (LAG projected probability)
        forecast = _extract_forecast(edge.get('p'))
        
        # Extract latency/maturity data (LAG completeness, t95)
        latency = _extract_latency(edge.get('p'))
        
        # Extract inbound-n (forecast population)
        p_n = None
        p_param = edge.get('p')
        if isinstance(p_param, dict):
            p_n = p_param.get('n')
        
        # Extract costs and uncertainty
        cost_gbp = _extract_cost(edge.get('cost_gbp'))
        cost_gbp_stdev = _extract_cost_stdev(edge.get('cost_gbp'))
        labour_cost = _extract_cost(edge.get('labour_cost'))
        labour_cost_stdev = _extract_cost_stdev(edge.get('labour_cost'))
        
        G.add_edge(
            source,
            target,
            uuid=edge.get('uuid'),
            id=edge.get('id'),
            p=p_mean,
            p_stdev=p_stdev,
            p_distribution=p_distribution,
            evidence=evidence,
            forecast=forecast,
            latency=latency,
            p_n=p_n,
            conditional_p=edge.get('conditional_p', []),
            cost_gbp=cost_gbp,
            cost_gbp_stdev=cost_gbp_stdev,
            labour_cost=labour_cost,
            labour_cost_stdev=labour_cost_stdev,
            case_id=edge.get('case_id'),
            case_variant=edge.get('case_variant'),
            **{k: v for k, v in edge.items() if k not in ['uuid', 'id', 'from', 'to', 'p', 'conditional_p', 'cost_gbp', 'labour_cost', 'case_id', 'case_variant']}
        )
    
    return G


def _resolve_node_id(node_ref: str, node_lookup: dict) -> str:
    """
    Resolve node reference to canonical ID.
    
    Args:
        node_ref: Node UUID or ID
        node_lookup: Lookup dict from build phase
    
    Returns:
        Canonical node ID (prefers UUID)
    """
    if node_ref in node_lookup:
        node = node_lookup[node_ref]
        return node.get('uuid') or node.get('id') or node_ref
    return node_ref


def _extract_probability(edge: dict, graph_data: dict) -> Optional[float]:
    """
    Extract effective probability from edge.
    
    Handles:
    - Regular edges: p.mean
    - Case edges: variant weight from parent case node
    
    Args:
        edge: Edge dict
        graph_data: Full graph data (for case node lookup)
    
    Returns:
        Probability value (0-1) or None if not set
    """
    # Check if case edge
    case_id = edge.get('case_id')
    variant_name = edge.get('case_variant')
    
    if case_id and variant_name:
        # Get probability from case node variant weight
        weight = _get_case_variant_weight(case_id, variant_name, graph_data)
        if weight is not None:
            return weight
    
    # Regular probability
    p = edge.get('p')
    if p is None:
        return None
    
    if isinstance(p, dict):
        return p.get('mean')
    elif isinstance(p, (int, float)):
        return float(p)
    
    return None


def _get_case_variant_weight(case_id: str, variant_name: str, graph_data: dict) -> Optional[float]:
    """
    Get variant weight from case node.
    
    Args:
        case_id: Case ID (from edge.case_id)
        variant_name: Variant name (from edge.case_variant)
        graph_data: Full graph data
    
    Returns:
        Variant weight or None
    """
    for node in graph_data.get('nodes', []):
        case_data = node.get('case')
        if not case_data:
            continue
        
        # Check if this is the right case node
        if case_data.get('id') == case_id:
            variants = case_data.get('variants', [])
            for v in variants:
                if v.get('name') == variant_name:
                    return v.get('weight')
    
    return None


def _extract_cost(cost_param: Optional[dict]) -> float:
    """
    Extract cost value from cost parameter.
    
    Args:
        cost_param: Cost parameter dict (cost_gbp or labour_cost)
    
    Returns:
        Cost mean value, or 0 if not set
    """
    if cost_param is None:
        return 0.0
    
    if isinstance(cost_param, dict):
        return cost_param.get('mean', 0.0)
    elif isinstance(cost_param, (int, float)):
        return float(cost_param)
    
    return 0.0


def _extract_evidence(p_param: Optional[dict]) -> Optional[dict]:
    """
    Extract evidence (n/k) from probability parameter.
    
    Args:
        p_param: Probability parameter dict (edge.p)
    
    Returns:
        Evidence dict with n, k, or None if not present
    """
    if p_param is None:
        return None
    
    if isinstance(p_param, dict):
        evidence = p_param.get('evidence')
        if evidence:
            return {
                'n': evidence.get('n'),
                'k': evidence.get('k'),
                'mean': evidence.get('mean'),  # evidence.mean (observed rate)
                'window_from': evidence.get('window_from'),
                'window_to': evidence.get('window_to'),
            }
    
    return None


def _extract_forecast(p_param: Optional[dict]) -> Optional[dict]:
    """
    Extract forecast data from probability parameter.
    
    Args:
        p_param: Probability parameter dict (edge.p)
    
    Returns:
        Forecast dict with mean, k, or None if not present
    """
    if p_param is None:
        return None
    
    if isinstance(p_param, dict):
        forecast = p_param.get('forecast')
        if forecast:
            return {
                'mean': forecast.get('mean'),  # forecast.mean (projected rate)
                'k': forecast.get('k'),        # forecast.k (expected converters)
                'stdev': forecast.get('stdev'),
            }
    
    return None


def _extract_latency(p_param: Optional[dict]) -> Optional[dict]:
    """
    Extract latency/maturity data from probability parameter.
    
    Args:
        p_param: Probability parameter dict (edge.p)
    
    Returns:
        Latency dict with completeness, t95, etc. or None if not present
    """
    if p_param is None:
        return None
    
    if isinstance(p_param, dict):
        latency = p_param.get('latency')
        if latency:
            return {
                # Enablement
                'latency_parameter': latency.get('latency_parameter'),
                'latency_parameter_overridden': latency.get('latency_parameter_overridden'),
                # Anchor
                'anchor_node_id': latency.get('anchor_node_id'),
                'anchor_node_id_overridden': latency.get('anchor_node_id_overridden'),
                # Horizons
                't95': latency.get('t95'),
                't95_overridden': latency.get('t95_overridden'),
                'path_t95': latency.get('path_t95'),
                'path_t95_overridden': latency.get('path_t95_overridden'),
                # Display-only stats
                'median_lag_days': latency.get('median_lag_days'),
                'mean_lag_days': latency.get('mean_lag_days'),
                'completeness': latency.get('completeness'),
            }
    
    return None


def _extract_stdev(p_param: Optional[dict]) -> Optional[float]:
    """
    Extract standard deviation from probability parameter.
    
    Args:
        p_param: Probability parameter dict (edge.p)
    
    Returns:
        Standard deviation or None if not present
    """
    if p_param is None:
        return None
    
    if isinstance(p_param, dict):
        return p_param.get('stdev')
    
    return None


def _extract_distribution(p_param: Optional[dict]) -> Optional[str]:
    """
    Extract distribution type from probability parameter.
    
    Args:
        p_param: Probability parameter dict (edge.p)
    
    Returns:
        Distribution type ('beta', 'normal', 'uniform') or None
    """
    if p_param is None:
        return None
    
    if isinstance(p_param, dict):
        return p_param.get('distribution')
    
    return None


def _extract_cost_stdev(cost_param: Optional[dict]) -> Optional[float]:
    """
    Extract standard deviation from cost parameter.
    
    Args:
        cost_param: Cost parameter dict (cost_gbp or labour_cost)
    
    Returns:
        Standard deviation or None if not present
    """
    if cost_param is None:
        return None
    
    if isinstance(cost_param, dict):
        return cost_param.get('stdev')
    
    return None


def get_graph_stats(G: nx.DiGraph) -> dict:
    """
    Get basic statistics about the graph.
    
    Args:
        G: NetworkX DiGraph
    
    Returns:
        Dict with node_count, edge_count, entry_nodes, absorbing_nodes
    """
    entry_nodes = [n for n, d in G.nodes(data=True) if d.get('is_entry', False)]
    absorbing_nodes = [n for n, d in G.nodes(data=True) if d.get('absorbing', False)]
    case_nodes = [n for n, d in G.nodes(data=True) if d.get('is_case', False)]
    
    return {
        'node_count': G.number_of_nodes(),
        'edge_count': G.number_of_edges(),
        'entry_nodes': entry_nodes,
        'absorbing_nodes': absorbing_nodes,
        'case_nodes': case_nodes,
        'is_dag': nx.is_directed_acyclic_graph(G),
    }


def find_entry_nodes(G: nx.DiGraph) -> list[str]:
    """Find all entry/start nodes in the graph."""
    # First check explicit is_entry flag
    explicit_entries = [n for n, d in G.nodes(data=True) if d.get('is_entry', False)]
    if explicit_entries:
        return explicit_entries
    
    # Fall back to nodes with no predecessors
    return [n for n in G.nodes() if G.in_degree(n) == 0]


def find_absorbing_nodes(G: nx.DiGraph) -> list[str]:
    """Find all absorbing/end nodes in the graph."""
    # First check explicit absorbing flag
    explicit_absorbing = [n for n, d in G.nodes(data=True) if d.get('absorbing', False)]
    if explicit_absorbing:
        return explicit_absorbing
    
    # Fall back to nodes with no successors
    return [n for n in G.nodes() if G.out_degree(n) == 0]


def resolve_node_id(G: nx.DiGraph, node_ref: str) -> str | None:
    """
    Resolve a node reference (UUID or human-readable ID) to the graph's node key.
    
    The NetworkX graph uses UUIDs as node keys, but DSL queries use human-readable IDs.
    This function resolves either format to the actual graph key.
    
    Args:
        G: NetworkX DiGraph
        node_ref: Node UUID or human-readable ID
    
    Returns:
        Graph node key (UUID), or None if not found
    """
    # First check if it's already a valid graph key
    if node_ref in G.nodes:
        return node_ref
    
    # Otherwise, search by human-readable ID attribute
    for node_key, data in G.nodes(data=True):
        if data.get('id') == node_ref:
            return node_key
    
    return None


def build_id_lookup(G: nx.DiGraph) -> dict[str, str]:
    """
    Build a lookup dict mapping human-readable IDs to graph node keys (UUIDs).
    
    Args:
        G: NetworkX DiGraph
    
    Returns:
        Dict mapping human-readable ID -> graph node key
    """
    lookup = {}
    for node_key, data in G.nodes(data=True):
        # Add UUID key
        lookup[node_key] = node_key
        # Add human-readable ID key
        node_id = data.get('id')
        if node_id and node_id != node_key:
            lookup[node_id] = node_key
    return lookup


def get_human_id(G: nx.DiGraph, node_key: str) -> str:
    """
    Get human-readable ID for a node, given its graph key (UUID).
    
    Args:
        G: NetworkX DiGraph
        node_key: Graph node key (usually UUID)
    
    Returns:
        Human-readable ID, or the key itself if not found
    """
    if node_key in G.nodes:
        return G.nodes[node_key].get('id', node_key)
    return node_key


def get_graph_key(G: nx.DiGraph, human_id: str) -> Optional[str]:
    """
    Get graph key (UUID) for a node, given its human-readable ID.
    
    DSL queries use human-readable IDs, but the graph uses UUIDs as keys.
    This function resolves human IDs to graph keys for lookups.
    
    Args:
        G: NetworkX DiGraph
        human_id: Human-readable ID (from DSL)
    
    Returns:
        Graph key (UUID), or None if not found
    """
    # Direct lookup - human_id might already be a graph key
    if human_id in G.nodes:
        return human_id
    
    # Reverse lookup - search for node with matching 'id' attribute
    for node_key, attrs in G.nodes(data=True):
        if attrs.get('id') == human_id:
            return node_key
    
    return None


def resolve_node_ids(G: nx.DiGraph, human_ids: list[str]) -> list[str]:
    """
    Resolve a list of human-readable IDs to graph keys (UUIDs).
    
    Args:
        G: NetworkX DiGraph
        human_ids: List of human-readable IDs from DSL
    
    Returns:
        List of graph keys (UUIDs) for nodes that were found
    """
    resolved = []
    for human_id in human_ids:
        graph_key = get_graph_key(G, human_id)
        if graph_key:
            resolved.append(graph_key)
    return resolved


def apply_visibility_mode(G: nx.DiGraph, mode: str) -> None:
    """
    Mutate graph edge probabilities based on visibility mode.
    
    This controls which probability source is used for path calculations:
    - 'f+e': Keep p (mean) - the LAG-blended probability
    - 'f': Replace p with forecast.mean if available (forecast only)
    - 'e': Replace p with evidence.mean if available (evidence only)
    
    If the requested source is unavailable for an edge, falls back to p.mean.
    
    Args:
        G: NetworkX DiGraph to mutate
        mode: Visibility mode ('f+e', 'f', or 'e')
    """
    if mode == 'f+e':
        # Keep p (mean) as-is - no changes needed
        return
    
    for u, v, data in G.edges(data=True):
        if mode == 'f':
            forecast = data.get('forecast') or {}
            forecast_mean = forecast.get('mean')
            if forecast_mean is not None:
                data['p'] = forecast_mean
            # else: keep p.mean as fallback (no forecast data)
        elif mode == 'e':
            evidence = data.get('evidence') or {}
            evidence_mean = evidence.get('mean')
            if evidence_mean is not None:
                data['p'] = evidence_mean
            # else: keep p.mean as fallback (no evidence data)


def get_probability_label(mode: str) -> str:
    """
    Get human-readable label for the probability basis used.
    
    Args:
        mode: Visibility mode ('f+e', 'f', or 'e')
    
    Returns:
        Label describing the probability source
    """
    labels = {
        'f+e': 'Probability',
        'f': 'Forecast Probability',
        'e': 'Evidence Probability',
    }
    return labels.get(mode, 'Probability')


def translate_uuids_to_ids(G: nx.DiGraph, data: any) -> any:
    """
    Recursively translate UUIDs to human-readable IDs in analysis results.
    
    This ensures the API returns human-readable IDs that match the DSL input format,
    making results immediately usable for display without frontend translation.
    
    Args:
        G: NetworkX DiGraph (for UUID -> ID lookup)
        data: Analysis result data (dict, list, or primitive)
    
    Returns:
        Data with UUIDs replaced by human-readable IDs
    """
    if data is None:
        return None
    
    if isinstance(data, dict):
        result = {}
        for key, value in data.items():
            # Translate values in node ID fields (both uuid and human-readable name conventions)
            if key in ('node_id', 'from_node', 'to_node', 'start_node', 'end_node', 
                       'source', 'target', 'id', 'node'):
                if isinstance(value, str):
                    result[key] = get_human_id(G, value)
                else:
                    result[key] = translate_uuids_to_ids(G, value)
            # Translate lists of node IDs (string lists)
            elif key in ('node_ids', 'entry_nodes', 'absorbing_nodes', 'case_nodes', 
                         'intermediate_nodes', 'visited_nodes', 'excluded_nodes', 'path', 'nodes'):
                if isinstance(value, list):
                    result[key] = [get_human_id(G, v) if isinstance(v, str) else translate_uuids_to_ids(G, v) for v in value]
                else:
                    result[key] = translate_uuids_to_ids(G, value)
            # Recurse into nested structures
            else:
                result[key] = translate_uuids_to_ids(G, value)
        return result
    
    elif isinstance(data, list):
        return [translate_uuids_to_ids(G, item) for item in data]
    
    # Primitives pass through
    return data

