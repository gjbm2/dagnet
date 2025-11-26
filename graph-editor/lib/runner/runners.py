"""
Analysis Runners

Specialized runners for different analysis types.

Design Reference: /docs/current/project-analysis/PHASE_1_DESIGN.md
"""

from typing import Any, Optional
import networkx as nx

from .path_runner import (
    calculate_path_probability,
    calculate_path_to_absorbing,
    calculate_path_through_node,
    compute_pruning,
    PruningResult,
)
from .graph_builder import find_entry_nodes, find_absorbing_nodes, get_graph_stats


def run_single_node_entry(
    G: nx.DiGraph,
    node_id: str,
    pruning: Optional[PruningResult] = None,
) -> dict[str, Any]:
    """
    Analyze entry/start node.
    
    Returns probabilities of reaching all absorbing nodes from this entry.
    """
    if node_id not in G:
        return {'error': f'Node {node_id} not found'}
    
    absorbing_nodes = find_absorbing_nodes(G)
    
    outcomes = []
    for absorbing in absorbing_nodes:
        result = calculate_path_probability(G, node_id, absorbing, pruning)
        outcomes.append({
            'node_id': absorbing,
            'label': G.nodes[absorbing].get('label', absorbing),
            'probability': result.probability,
            'expected_cost_gbp': result.expected_cost_gbp,
            'expected_cost_time': result.expected_cost_time,
        })
    
    # Sort by probability descending
    outcomes.sort(key=lambda x: x['probability'], reverse=True)
    
    return {
        'analysis_type': 'entry_node',
        'node_id': node_id,
        'node_label': G.nodes[node_id].get('label', node_id),
        'outcomes': outcomes,
        'total_probability': sum(o['probability'] for o in outcomes),
    }


def run_path_to_end(
    G: nx.DiGraph,
    node_id: str,
    pruning: Optional[PruningResult] = None,
) -> dict[str, Any]:
    """
    Analyze absorbing/outcome node.
    
    Returns probability of reaching this outcome from all entries.
    """
    result = calculate_path_to_absorbing(G, node_id, pruning)
    
    return {
        'analysis_type': 'outcome_probability',
        'node_id': node_id,
        'node_label': G.nodes[node_id].get('label', node_id) if node_id in G else node_id,
        'probability': result.probability,
        'expected_cost_gbp': result.expected_cost_gbp,
        'expected_cost_time': result.expected_cost_time,
        'path_exists': result.path_exists,
    }


def run_path_through(
    G: nx.DiGraph,
    node_id: str,
    pruning: Optional[PruningResult] = None,
) -> dict[str, Any]:
    """
    Analyze middle node - paths through it.
    """
    result = calculate_path_through_node(G, node_id, pruning)
    
    # Also get breakdown by absorbing node
    absorbing_nodes = find_absorbing_nodes(G)
    path_breakdown = []
    
    for absorbing in absorbing_nodes:
        path_result = calculate_path_probability(G, node_id, absorbing, pruning)
        if path_result.probability > 0:
            path_breakdown.append({
                'to_node': absorbing,
                'label': G.nodes[absorbing].get('label', absorbing),
                'probability': path_result.probability,
                'expected_cost_gbp': path_result.expected_cost_gbp,
                'expected_cost_time': path_result.expected_cost_time,
            })
    
    path_breakdown.sort(key=lambda x: x['probability'], reverse=True)
    
    return {
        'analysis_type': 'path_through',
        'node_id': node_id,
        'node_label': G.nodes[node_id].get('label', node_id) if node_id in G else node_id,
        'probability': result.probability,
        'expected_cost_gbp': result.expected_cost_gbp,
        'expected_cost_time': result.expected_cost_time,
        'path_breakdown': path_breakdown,
    }


def run_end_comparison(
    G: nx.DiGraph,
    node_ids: list[str],
    pruning: Optional[PruningResult] = None,
) -> dict[str, Any]:
    """
    Compare probabilities of reaching multiple absorbing nodes.
    """
    comparisons = []
    
    for node_id in node_ids:
        result = calculate_path_to_absorbing(G, node_id, pruning)
        comparisons.append({
            'node_id': node_id,
            'label': G.nodes[node_id].get('label', node_id) if node_id in G else node_id,
            'probability': result.probability,
            'expected_cost_gbp': result.expected_cost_gbp,
            'expected_cost_time': result.expected_cost_time,
        })
    
    # Sort by probability descending
    comparisons.sort(key=lambda x: x['probability'], reverse=True)
    
    total_prob = sum(c['probability'] for c in comparisons)
    
    return {
        'analysis_type': 'end_comparison',
        'node_ids': node_ids,
        'comparisons': comparisons,
        'total_probability': total_prob,
        'is_exhaustive': abs(total_prob - 1.0) < 0.001,  # Check if these cover all outcomes
    }


def run_branch_comparison(
    G: nx.DiGraph,
    node_ids: list[str],
    pruning: Optional[PruningResult] = None,
) -> dict[str, Any]:
    """
    Compare parallel branches (siblings).
    """
    comparisons = []
    
    for node_id in node_ids:
        result = calculate_path_through_node(G, node_id, pruning)
        
        # Get the direct edge probability from parent
        edge_prob = None
        parents = list(G.predecessors(node_id)) if node_id in G else []
        if parents:
            parent = parents[0]  # Take first parent for display
            edge_data = G.edges.get((parent, node_id), {})
            edge_prob = edge_data.get('p')
        
        comparisons.append({
            'node_id': node_id,
            'label': G.nodes[node_id].get('label', node_id) if node_id in G else node_id,
            'edge_probability': edge_prob,
            'path_through_probability': result.probability,
            'expected_cost_gbp': result.expected_cost_gbp,
            'expected_cost_time': result.expected_cost_time,
        })
    
    # Sort by edge probability descending
    comparisons.sort(key=lambda x: x['edge_probability'] or 0, reverse=True)
    
    return {
        'analysis_type': 'branch_comparison',
        'node_ids': node_ids,
        'comparisons': comparisons,
    }


def run_path(
    G: nx.DiGraph,
    start_id: str,
    end_id: str,
    intermediate_nodes: list[str] = None,
    pruning: Optional[PruningResult] = None,
) -> dict[str, Any]:
    """
    Calculate path between two nodes with optional intermediate constraints.
    """
    intermediate_nodes = intermediate_nodes or []
    
    result = calculate_path_probability(G, start_id, end_id, pruning)
    
    return {
        'analysis_type': 'path',
        'from_node': start_id,
        'from_label': G.nodes[start_id].get('label', start_id) if start_id in G else start_id,
        'to_node': end_id,
        'to_label': G.nodes[end_id].get('label', end_id) if end_id in G else end_id,
        'intermediate_nodes': intermediate_nodes,
        'probability': result.probability,
        'expected_cost_gbp': result.expected_cost_gbp,
        'expected_cost_time': result.expected_cost_time,
        'path_exists': result.path_exists,
    }


def run_partial_path(
    G: nx.DiGraph,
    start_id: str,
    intermediate_nodes: list[str],
    pruning: Optional[PruningResult] = None,
) -> dict[str, Any]:
    """
    Analyze partial path from start through intermediates.
    """
    absorbing_nodes = find_absorbing_nodes(G)
    
    # Get probability breakdown by outcome
    outcomes = []
    for absorbing in absorbing_nodes:
        result = calculate_path_probability(G, start_id, absorbing, pruning)
        if result.probability > 0:
            outcomes.append({
                'to_node': absorbing,
                'label': G.nodes[absorbing].get('label', absorbing),
                'probability': result.probability,
                'expected_cost_gbp': result.expected_cost_gbp,
                'expected_cost_time': result.expected_cost_time,
            })
    
    outcomes.sort(key=lambda x: x['probability'], reverse=True)
    
    return {
        'analysis_type': 'partial_path',
        'from_node': start_id,
        'from_label': G.nodes[start_id].get('label', start_id) if start_id in G else start_id,
        'intermediate_nodes': intermediate_nodes,
        'outcomes': outcomes,
        'total_probability': sum(o['probability'] for o in outcomes),
    }


def run_general_stats(
    G: nx.DiGraph,
    node_ids: list[str],
    pruning: Optional[PruningResult] = None,
) -> dict[str, Any]:
    """
    General statistics for arbitrary node selection.
    """
    stats = get_graph_stats(G)
    
    # Node breakdown
    node_breakdown = []
    for node_id in node_ids:
        if node_id not in G:
            continue
        
        node_data = G.nodes[node_id]
        node_type = 'middle'
        if node_data.get('is_entry'):
            node_type = 'entry'
        elif node_data.get('absorbing'):
            node_type = 'absorbing'
        
        result = calculate_path_through_node(G, node_id, pruning)
        
        node_breakdown.append({
            'node_id': node_id,
            'label': node_data.get('label', node_id),
            'type': node_type,
            'path_through_probability': result.probability,
        })
    
    return {
        'analysis_type': 'general_stats',
        'selected_nodes': node_ids,
        'node_breakdown': node_breakdown,
        'graph_stats': stats,
    }


def run_graph_overview(
    G: nx.DiGraph,
    node_ids: list[str] = None,
    pruning: Optional[PruningResult] = None,
) -> dict[str, Any]:
    """
    Analyze entire graph without selection.
    
    Returns overall graph statistics and structure analysis.
    """
    stats = get_graph_stats(G)
    entry_nodes = find_entry_nodes(G)
    absorbing_nodes = find_absorbing_nodes(G)
    
    # Calculate total probability to each absorbing node from all entries
    outcomes = []
    for absorbing in absorbing_nodes:
        total_prob = 0.0
        total_cost_gbp = 0.0
        total_cost_time = 0.0
        
        for entry in entry_nodes:
            entry_weight = G.nodes[entry].get('entry_weight', 1.0 / len(entry_nodes))
            result = calculate_path_probability(G, entry, absorbing, pruning)
            total_prob += entry_weight * result.probability
            total_cost_gbp += entry_weight * result.expected_cost_gbp
            total_cost_time += entry_weight * result.expected_cost_time
        
        outcomes.append({
            'node_id': absorbing,
            'label': G.nodes[absorbing].get('label', absorbing),
            'probability': total_prob,
            'expected_cost_gbp': total_cost_gbp,
            'expected_cost_time': total_cost_time,
        })
    
    # Sort by probability descending
    outcomes.sort(key=lambda x: x['probability'], reverse=True)
    
    return {
        'analysis_type': 'graph_overview',
        'graph_stats': stats,
        'entry_nodes': [{'id': n, 'label': G.nodes[n].get('label', n)} for n in entry_nodes],
        'outcomes': outcomes,
    }


# Runner dispatch table
RUNNERS = {
    'single_node_runner': run_single_node_entry,
    'path_to_end_runner': run_path_to_end,
    'path_through_runner': run_path_through,
    'end_comparison_runner': run_end_comparison,
    'branch_comparison_runner': run_branch_comparison,
    'path_runner': run_path,
    'partial_path_runner': run_partial_path,
    'general_stats_runner': run_general_stats,
    'graph_overview_runner': run_graph_overview,
}


def get_runner(runner_name: str):
    """Get runner function by name."""
    return RUNNERS.get(runner_name)

