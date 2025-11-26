"""
Selection Predicates

Compute predicates from graph + selection to determine analysis type.

Design Reference: /docs/current/project-analysis/DSL_CONSTRUCTION_CASES.md
"""

from typing import Optional
import networkx as nx


def compute_selection_predicates(
    G: nx.DiGraph,
    selected_node_ids: list[str],
    scenario_count: int = 1
) -> dict:
    """
    Compute predicates about a node selection for analysis type matching.
    
    Args:
        G: NetworkX DiGraph with node/edge attributes
        selected_node_ids: List of selected node IDs (uuid or id)
        scenario_count: Number of visible scenarios (for scenario predicates)
    
    Returns:
        Dict of predicates for analysis type matching
    
    Predicates computed:
        - node_count: Number of selected nodes
        - all_absorbing: All selected nodes are absorbing (end nodes)
        - has_unique_start: Exactly one node has no selected predecessors
        - has_unique_end: Exactly one node has no selected successors
        - start_node: The unique start node (if has_unique_start)
        - end_node: The unique end node (if has_unique_end)
        - is_sequential: Direct edges exist between consecutive topo-sorted nodes
        - sorted_nodes: Topologically sorted selected nodes
        - intermediate_nodes: Nodes between start and end
        - all_are_siblings: All selected nodes share a common parent
        - scenario_count: Number of scenarios
        - multiple_scenarios: More than one scenario
    """
    n = len(selected_node_ids)
    selected_set = set(selected_node_ids)
    
    # Basic predicates
    predicates = {
        'node_count': n,
        'scenario_count': scenario_count,
        'multiple_scenarios': scenario_count > 1,
    }
    
    if n == 0:
        predicates.update({
            'all_absorbing': False,
            'has_unique_start': False,
            'has_unique_end': False,
            'start_node': None,
            'end_node': None,
            'is_sequential': False,
            'sorted_nodes': [],
            'intermediate_nodes': [],
            'all_are_siblings': False,
        })
        return predicates
    
    # Check node types
    absorbing_flags = []
    entry_flags = []
    for nid in selected_node_ids:
        if nid in G.nodes:
            node_data = G.nodes[nid]
            is_absorbing = node_data.get('absorbing', False) or G.out_degree(nid) == 0
            is_entry = node_data.get('is_entry', False) or G.in_degree(nid) == 0
            absorbing_flags.append(is_absorbing)
            entry_flags.append(is_entry)
        else:
            absorbing_flags.append(False)
            entry_flags.append(False)
    
    predicates['all_absorbing'] = all(absorbing_flags) if absorbing_flags else False
    predicates['all_entry'] = all(entry_flags) if entry_flags else False
    
    # Find starts (no selected predecessors) and ends (no selected successors)
    starts = []
    ends = []
    
    for nid in selected_node_ids:
        if nid not in G.nodes:
            continue
            
        # Check if any predecessor is in selection
        has_selected_pred = any(pred in selected_set for pred in G.predecessors(nid))
        if not has_selected_pred:
            starts.append(nid)
        
        # Check if any successor is in selection
        has_selected_succ = any(succ in selected_set for succ in G.successors(nid))
        if not has_selected_succ:
            ends.append(nid)
    
    predicates['has_unique_start'] = len(starts) == 1
    predicates['start_node'] = starts[0] if len(starts) == 1 else None
    predicates['has_unique_end'] = len(ends) == 1
    predicates['end_node'] = ends[0] if len(ends) == 1 else None
    predicates['start_nodes'] = starts
    predicates['end_nodes'] = ends
    
    # Topological sorting and sequentiality
    if predicates['has_unique_start'] and predicates['has_unique_end']:
        try:
            # Try to topo sort just the selected nodes
            subgraph = G.subgraph(selected_node_ids)
            sorted_ids = list(nx.topological_sort(subgraph))
            predicates['sorted_nodes'] = sorted_ids
            
            # Intermediate nodes are those between start and end
            if len(sorted_ids) > 2:
                predicates['intermediate_nodes'] = sorted_ids[1:-1]
            else:
                predicates['intermediate_nodes'] = []
            
            # Check if sequential (direct edges between consecutive)
            is_seq = True
            for i in range(len(sorted_ids) - 1):
                if not G.has_edge(sorted_ids[i], sorted_ids[i + 1]):
                    is_seq = False
                    break
            predicates['is_sequential'] = is_seq
            
        except nx.NetworkXError:
            # Graph has cycle or other issue
            predicates['is_sequential'] = False
            predicates['sorted_nodes'] = selected_node_ids
            predicates['intermediate_nodes'] = []
    else:
        predicates['is_sequential'] = False
        predicates['sorted_nodes'] = selected_node_ids
        predicates['intermediate_nodes'] = []
    
    # Check sibling relationships
    predicates['all_are_siblings'] = _check_all_siblings(G, selected_node_ids)
    predicates['sibling_groups'] = _find_sibling_groups(G, selected_node_ids)
    
    # Node type flags for single node
    if n == 1:
        nid = selected_node_ids[0]
        if nid in G.nodes:
            node_data = G.nodes[nid]
            predicates['is_graph_entry'] = node_data.get('is_entry', False) or G.in_degree(nid) == 0
            predicates['is_graph_absorbing'] = node_data.get('absorbing', False) or G.out_degree(nid) == 0
        else:
            predicates['is_graph_entry'] = False
            predicates['is_graph_absorbing'] = False
    
    return predicates


def _check_all_siblings(G: nx.DiGraph, node_ids: list[str]) -> bool:
    """
    Check if all nodes share at least one common parent.
    
    Siblings = nodes that all have the same immediate predecessor.
    """
    if len(node_ids) < 2:
        return False
    
    # Get parent sets for each node
    parent_sets = []
    for nid in node_ids:
        if nid in G.nodes:
            parents = set(G.predecessors(nid))
            parent_sets.append(parents)
        else:
            parent_sets.append(set())
    
    if not parent_sets:
        return False
    
    # Check if there's a common parent across all
    common_parents = parent_sets[0]
    for ps in parent_sets[1:]:
        common_parents = common_parents.intersection(ps)
    
    return len(common_parents) > 0


def _find_sibling_groups(G: nx.DiGraph, node_ids: list[str]) -> list[list[str]]:
    """
    Group nodes by shared parent.
    
    Returns list of sibling groups (nodes sharing a parent).
    """
    if len(node_ids) < 2:
        return [[nid] for nid in node_ids]
    
    # Map each node to its parents
    node_to_parents = {}
    for nid in node_ids:
        if nid in G.nodes:
            node_to_parents[nid] = frozenset(G.predecessors(nid))
        else:
            node_to_parents[nid] = frozenset()
    
    # Group nodes that share parents
    groups = []
    processed = set()
    
    for nid in node_ids:
        if nid in processed:
            continue
            
        parents = node_to_parents[nid]
        if not parents:
            groups.append([nid])
            processed.add(nid)
            continue
        
        # Find all nodes that share at least one parent with this node
        group = [nid]
        processed.add(nid)
        
        for other_nid in node_ids:
            if other_nid in processed:
                continue
            other_parents = node_to_parents[other_nid]
            if parents.intersection(other_parents):
                group.append(other_nid)
                processed.add(other_nid)
        
        groups.append(group)
    
    return groups


def get_node_type(G: nx.DiGraph, node_id: str) -> str:
    """
    Determine node type: 'entry', 'absorbing', or 'middle'.
    """
    if node_id not in G.nodes:
        return 'unknown'
    
    node_data = G.nodes[node_id]
    
    if node_data.get('absorbing', False) or G.out_degree(node_id) == 0:
        return 'absorbing'
    
    if node_data.get('is_entry', False) or G.in_degree(node_id) == 0:
        return 'entry'
    
    return 'middle'

