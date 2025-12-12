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
    all_scenarios: Optional[list] = None,
) -> dict[str, Any]:
    """
    Analyze entry/start node.
    
    Returns probabilities of reaching all absorbing nodes from this entry.
    New declarative schema: scenario-first layout with outcomes nested.
    
    LAG support: includes visibility_mode per scenario for UI adaptors.
    """
    from .graph_builder import build_networkx_graph
    
    if node_id not in G:
        return {'error': f'Node {node_id} not found'}
    
    node_label = G.nodes[node_id].get('label') or node_id
    
    # Build scenario dimension values
    scenarios_to_process = all_scenarios if all_scenarios else [None]
    scenario_dimension_values = {}
    
    for scenario in scenarios_to_process:
        if scenario:
            scenario_id = scenario.scenario_id
            scenario_name = scenario.name or scenario.scenario_id
            scenario_colour = scenario.colour or '#3b82f6'
            visibility_mode = getattr(scenario, 'visibility_mode', 'f+e') or 'f+e'
        else:
            scenario_id = 'current'
            scenario_name = 'Current'
            scenario_colour = '#3b82f6'
            visibility_mode = 'f+e'
        
        scenario_dimension_values[scenario_id] = {
            'name': scenario_name,
            'colour': scenario_colour,
            'visibility_mode': visibility_mode,
        }
    
    # Get outcome dimension values (absorbing nodes)
    absorbing_nodes = find_absorbing_nodes(G)
    outcome_dimension_values = {}
    for i, absorbing in enumerate(absorbing_nodes):
        outcome_label = G.nodes[absorbing].get('label') if absorbing in G else None
        outcome_dimension_values[absorbing] = {
            'name': outcome_label or absorbing,  # Fallback to node ID if label is None
            'order': i
        }
    
    # Build flat data rows (scenario × outcome)
    data_rows = []
    for scenario in scenarios_to_process:
        if scenario:
            scenario_G = build_networkx_graph(scenario.graph)
            scenario_id = scenario.scenario_id
            visibility_mode = getattr(scenario, 'visibility_mode', 'f+e') or 'f+e'
        else:
            scenario_G = G
            scenario_id = 'current'
            visibility_mode = 'f+e'
        
        for absorbing in absorbing_nodes:
            result = calculate_path_probability(scenario_G, node_id, absorbing, pruning)
            data_rows.append({
                'scenario_id': scenario_id,
                'visibility_mode': visibility_mode,
                'outcome': absorbing,
                'probability': result.probability,
                'expected_cost_gbp': result.expected_cost_gbp,
                'expected_labour_cost': result.expected_labour_cost,
            })
    
    return {
        'metadata': {
            'node_id': node_id,
            'node_label': node_label,
        },
        'semantics': {
            'dimensions': [
                {'id': 'scenario_id', 'name': 'Scenario', 'type': 'scenario', 'role': 'primary'},
                {'id': 'outcome', 'name': 'Outcome', 'type': 'node', 'role': 'secondary'},
            ],
            'metrics': [
                {'id': 'probability', 'name': 'Probability', 'type': 'probability', 'format': 'percent', 'role': 'primary'},
                {'id': 'expected_cost_gbp', 'name': 'Expected Cost (£)', 'type': 'currency', 'format': 'currency_gbp'},
                {'id': 'expected_labour_cost', 'name': 'Expected Time', 'type': 'duration', 'format': 'number'},
            ],
            'chart': {
                'recommended': 'bar_grouped',
                'alternatives': ['table'],
                'hints': {
                    'sort': {'by': 'probability', 'order': 'desc'}  # Highest first
                }
            }
        },
        'dimension_values': {
            'scenario_id': scenario_dimension_values,
            'outcome': outcome_dimension_values,
        },
        'data': data_rows,
    }


def run_path_to_end(
    G: nx.DiGraph,
    node_id: str,
    pruning: Optional[PruningResult] = None,
    all_scenarios: Optional[list] = None,
) -> dict[str, Any]:
    """
    Analyze absorbing/outcome node.
    
    Returns probability of reaching this outcome from all entries.
    New declarative schema: scenario-first, simple metrics.
    
    LAG support: includes visibility_mode per scenario for UI adaptors.
    """
    from .graph_builder import build_networkx_graph
    
    node_label = G.nodes[node_id].get('label') or node_id if node_id in G else node_id
    
    # Build scenario dimension values and data rows
    scenarios_to_process = all_scenarios if all_scenarios else [None]
    scenario_dimension_values = {}
    data_rows = []
    
    for scenario in scenarios_to_process:
        if scenario:
            scenario_G = build_networkx_graph(scenario.graph)
            scenario_id = scenario.scenario_id
            scenario_name = scenario.name or scenario.scenario_id
            scenario_colour = scenario.colour or '#3b82f6'
            visibility_mode = getattr(scenario, 'visibility_mode', 'f+e') or 'f+e'
        else:
            scenario_G = G
            scenario_id = 'current'
            scenario_name = 'Current'
            scenario_colour = '#3b82f6'
            visibility_mode = 'f+e'
        
        scenario_dimension_values[scenario_id] = {
            'name': scenario_name,
            'colour': scenario_colour,
            'visibility_mode': visibility_mode,
        }
        
        result = calculate_path_to_absorbing(scenario_G, node_id, pruning)
        data_rows.append({
            'scenario_id': scenario_id,
            'visibility_mode': visibility_mode,
            'probability': result.probability,
            'expected_cost_gbp': result.expected_cost_gbp,
            'expected_labour_cost': result.expected_labour_cost,
        })
    
    return {
        'metadata': {
            'node_id': node_id,
            'node_label': node_label,
        },
        'semantics': {
            'dimensions': [
                {'id': 'scenario_id', 'name': 'Scenario', 'type': 'scenario', 'role': 'primary'},
            ],
            'metrics': [
                {'id': 'probability', 'name': 'Probability', 'type': 'probability', 'format': 'percent', 'role': 'primary'},
                {'id': 'expected_cost_gbp', 'name': 'Expected Cost (£)', 'type': 'currency', 'format': 'currency_gbp'},
                {'id': 'expected_labour_cost', 'name': 'Expected Time', 'type': 'duration', 'format': 'number'},
            ],
            'chart': {
                'recommended': 'bar',
                'alternatives': ['table'],
            }
        },
        'dimension_values': {
            'scenario_id': scenario_dimension_values,
        },
        'data': data_rows,
    }


def run_path_through(
    G: nx.DiGraph,
    node_id: str,
    pruning: Optional[PruningResult] = None,
    all_scenarios: Optional[list] = None,
) -> dict[str, Any]:
    """
    Analyze middle node - paths through it.
    New declarative schema: scenario-first with total probability.
    
    LAG support: includes visibility_mode per scenario for UI adaptors.
    """
    from .graph_builder import build_networkx_graph
    
    node_label = G.nodes[node_id].get('label') or node_id if node_id in G else node_id
    
    # Build scenario dimension values and data rows
    scenarios_to_process = all_scenarios if all_scenarios else [None]
    scenario_dimension_values = {}
    data_rows = []
    
    for scenario in scenarios_to_process:
        if scenario:
            scenario_G = build_networkx_graph(scenario.graph)
            scenario_id = scenario.scenario_id
            scenario_name = scenario.name or scenario.scenario_id
            scenario_colour = scenario.colour or '#3b82f6'
            visibility_mode = getattr(scenario, 'visibility_mode', 'f+e') or 'f+e'
        else:
            scenario_G = G
            scenario_id = 'current'
            scenario_name = 'Current'
            scenario_colour = '#3b82f6'
            visibility_mode = 'f+e'
        
        scenario_dimension_values[scenario_id] = {
            'name': scenario_name,
            'colour': scenario_colour,
            'visibility_mode': visibility_mode,
        }
        
        result = calculate_path_through_node(scenario_G, node_id, pruning)
        data_rows.append({
            'scenario_id': scenario_id,
            'visibility_mode': visibility_mode,
            'probability': result.probability,
            'expected_cost_gbp': result.expected_cost_gbp,
            'expected_labour_cost': result.expected_labour_cost,
        })
    
    return {
        'metadata': {
            'node_id': node_id,
            'node_label': node_label,
        },
        'semantics': {
            'dimensions': [
                {'id': 'scenario_id', 'name': 'Scenario', 'type': 'scenario', 'role': 'primary'},
            ],
            'metrics': [
                {'id': 'probability', 'name': 'Probability', 'type': 'probability', 'format': 'percent', 'role': 'primary'},
                {'id': 'expected_cost_gbp', 'name': 'Expected Cost (£)', 'type': 'currency', 'format': 'currency_gbp'},
                {'id': 'expected_labour_cost', 'name': 'Expected Time', 'type': 'duration', 'format': 'number'},
            ],
            'chart': {
                'recommended': 'bar',
                'alternatives': ['table'],
            }
        },
        'dimension_values': {
            'scenario_id': scenario_dimension_values,
        },
        'data': data_rows,
    }


def run_end_comparison(
    G: nx.DiGraph,
    node_ids: list[str],
    pruning: Optional[PruningResult] = None,
    all_scenarios: Optional[list] = None,
) -> dict[str, Any]:
    """
    Compare probabilities of reaching multiple absorbing nodes.
    New declarative schema: node-first with scenario secondary.
    
    LAG support: includes visibility_mode per scenario for UI adaptors.
    """
    from .graph_builder import build_networkx_graph
    
    # Build node dimension values
    node_dimension_values = {}
    for i, node_id in enumerate(node_ids):
        node_label = G.nodes[node_id].get('label') or node_id if node_id in G else node_id
        node_dimension_values[node_id] = {
            'name': node_label,
            'order': i
        }
    
    # Build scenario dimension values and data rows
    scenarios_to_process = all_scenarios if all_scenarios else [None]
    scenario_dimension_values = {}
    data_rows = []
    
    for scenario in scenarios_to_process:
        if scenario:
            scenario_G = build_networkx_graph(scenario.graph)
            scenario_id = scenario.scenario_id
            scenario_name = scenario.name or scenario.scenario_id
            scenario_colour = scenario.colour or '#3b82f6'
            visibility_mode = getattr(scenario, 'visibility_mode', 'f+e') or 'f+e'
        else:
            scenario_G = G
            scenario_id = 'current'
            scenario_name = 'Current'
            scenario_colour = '#3b82f6'
            visibility_mode = 'f+e'
        
        scenario_dimension_values[scenario_id] = {
            'name': scenario_name,
            'colour': scenario_colour,
            'visibility_mode': visibility_mode,
        }
        
        for node_id in node_ids:
            result = calculate_path_to_absorbing(scenario_G, node_id, pruning)
            data_rows.append({
                'node': node_id,
                'scenario_id': scenario_id,
                'visibility_mode': visibility_mode,
                'probability': result.probability,
                'expected_cost_gbp': result.expected_cost_gbp,
                'expected_labour_cost': result.expected_labour_cost,
            })
    
    return {
        'metadata': {
            'node_ids': node_ids,
        },
        'semantics': {
            'dimensions': [
                {'id': 'node', 'name': 'Outcome', 'type': 'node', 'role': 'primary'},
                {'id': 'scenario_id', 'name': 'Scenario', 'type': 'scenario', 'role': 'secondary'},
            ],
            'metrics': [
                {'id': 'probability', 'name': 'Probability', 'type': 'probability', 'format': 'percent', 'role': 'primary'},
                {'id': 'expected_cost_gbp', 'name': 'Expected Cost (£)', 'type': 'currency', 'format': 'currency_gbp'},
                {'id': 'expected_labour_cost', 'name': 'Expected Time', 'type': 'duration', 'format': 'number'},
            ],
            'chart': {
                'recommended': 'bar_grouped',
                'alternatives': ['table'],
                'hints': {
                    'sort': {'by': 'probability', 'order': 'desc'}  # Highest first
                }
            }
        },
        'dimension_values': {
            'node': node_dimension_values,
            'scenario_id': scenario_dimension_values,
        },
        'data': data_rows,
    }


def run_branch_comparison(
    G: nx.DiGraph,
    node_ids: list[str],
    pruning: Optional[PruningResult] = None,
    all_scenarios: Optional[list] = None,
) -> dict[str, Any]:
    """
    Compare parallel branches (siblings).
    New declarative schema: branch-first with scenario secondary.
    
    LAG support: includes visibility_mode and forecast/evidence data per scenario.
    """
    from .graph_builder import build_networkx_graph
    
    # Build branch dimension values
    branch_dimension_values = {}
    for i, node_id in enumerate(node_ids):
        node_label = G.nodes[node_id].get('label') or node_id if node_id in G else node_id
        branch_dimension_values[node_id] = {
            'name': node_label,
            'order': i
        }
    
    # Build scenario dimension values and data rows
    scenarios_to_process = all_scenarios if all_scenarios else [None]
    scenario_dimension_values = {}
    data_rows = []
    
    for scenario in scenarios_to_process:
        if scenario:
            scenario_G = build_networkx_graph(scenario.graph)
            scenario_id = scenario.scenario_id
            scenario_name = scenario.name or scenario.scenario_id
            scenario_colour = scenario.colour or '#3b82f6'
            visibility_mode = getattr(scenario, 'visibility_mode', 'f+e') or 'f+e'
        else:
            scenario_G = G
            scenario_id = 'current'
            scenario_name = 'Current'
            scenario_colour = '#3b82f6'
            visibility_mode = 'f+e'
        
        scenario_dimension_values[scenario_id] = {
            'name': scenario_name,
            'colour': scenario_colour,
            'visibility_mode': visibility_mode,
        }
        
        for node_id in node_ids:
            result = calculate_path_through_node(scenario_G, node_id, pruning)
            # Get edge probability and LAG data from parent
            edge_prob = None
            forecast_mean = None
            evidence_mean = None
            completeness = None
            parents = list(scenario_G.predecessors(node_id)) if node_id in scenario_G else []
            if parents:
                parent = parents[0]
                edge_data = scenario_G.edges.get((parent, node_id), {})
                edge_prob = edge_data.get('p')
                
                # LAG fields
                forecast = edge_data.get('forecast') or {}
                forecast_mean = forecast.get('mean')
                evidence = edge_data.get('evidence') or {}
                evidence_mean = evidence.get('mean')
                latency = edge_data.get('latency') or {}
                completeness = latency.get('completeness')
            
            row = {
                'branch': node_id,
                'scenario_id': scenario_id,
                'visibility_mode': visibility_mode,
                'edge_probability': edge_prob,
                'path_through_probability': result.probability,
                'expected_cost_gbp': result.expected_cost_gbp,
                'expected_labour_cost': result.expected_labour_cost,
            }
            
            # LAG fields: always include if available
            if forecast_mean is not None:
                row['forecast_mean'] = forecast_mean
            if evidence_mean is not None:
                row['evidence_mean'] = evidence_mean
            if completeness is not None:
                row['completeness'] = completeness
            
            data_rows.append(row)
    
    return {
        'metadata': {
            'node_ids': node_ids,
        },
        'semantics': {
            'dimensions': [
                {'id': 'branch', 'name': 'Branch', 'type': 'node', 'role': 'primary'},
                {'id': 'scenario_id', 'name': 'Scenario', 'type': 'scenario', 'role': 'secondary'},
            ],
            'metrics': [
                {'id': 'edge_probability', 'name': 'Edge Probability', 'type': 'probability', 'format': 'percent', 'role': 'primary'},
                {'id': 'forecast_mean', 'name': 'Forecast', 'type': 'probability', 'format': 'percent'},
                {'id': 'evidence_mean', 'name': 'Evidence', 'type': 'probability', 'format': 'percent'},
                {'id': 'completeness', 'name': 'Completeness', 'type': 'ratio', 'format': 'percent'},
                {'id': 'path_through_probability', 'name': 'Path Through', 'type': 'probability', 'format': 'percent'},
                {'id': 'expected_cost_gbp', 'name': 'Expected Cost (£)', 'type': 'currency', 'format': 'currency_gbp'},
                {'id': 'expected_labour_cost', 'name': 'Expected Time', 'type': 'duration', 'format': 'number'},
            ],
            'chart': {
                'recommended': 'bar_grouped',
                'alternatives': ['table'],
            }
        },
        'dimension_values': {
            'branch': branch_dimension_values,
            'scenario_id': scenario_dimension_values,
        },
        'data': data_rows,
    }


def _sort_nodes_topologically(G: nx.DiGraph, start_id: str, nodes: list[str]) -> list[str]:
    """
    Sort nodes by their topological distance from start_id.
    Uses shortest path length to determine order.
    """
    if not nodes:
        return []
    
    # Get shortest path lengths from start
    try:
        distances = nx.single_source_shortest_path_length(G, start_id)
    except nx.NetworkXError:
        # If start not in graph, return original order
        return nodes
    
    # Sort by distance (nodes not reachable go to end)
    def get_distance(node):
        return distances.get(node, float('inf'))
    
    return sorted(nodes, key=get_distance)


def run_path(
    G: nx.DiGraph,
    start_id: str,
    end_id: str,
    intermediate_nodes: list[str] = None,
    pruning: Optional[PruningResult] = None,
    all_scenarios: Optional[list] = None,
) -> dict[str, Any]:
    """
    Calculate path between two nodes with optional intermediate constraints.
    
    Returns declarative schema with stage-first structure for funnel visualization.
    See: /docs/current/project-analysis/ANALYSIS_RETURN_SCHEMA.md
    
    LAG support: includes forecast_mean, evidence_mean, and completeness fields
    when available on edges, conditional upon scenario visibility_mode.
    """
    from .graph_builder import build_networkx_graph
    
    intermediate_nodes = intermediate_nodes or []
    
    # Get labels from primary graph
    from_label = G.nodes[start_id].get('label') or start_id if start_id in G else start_id
    to_label = G.nodes[end_id].get('label') or end_id if end_id in G else end_id
    
    # Sort intermediate nodes topologically by distance from start
    sorted_intermediates = _sort_nodes_topologically(G, start_id, intermediate_nodes)
    
    # Build stages: start -> sorted intermediates -> end
    stage_ids = [start_id] + sorted_intermediates + [end_id]
    
    # Build scenario list (always use array for consistency)
    scenarios_to_process = all_scenarios if all_scenarios else [None]
    
    # Build dimension_values for stages and scenarios
    stage_dimension_values = {}
    scenario_dimension_values = {}
    
    for i, stage_id in enumerate(stage_ids):
        stage_label = G.nodes[stage_id].get('label') if stage_id in G else None
        stage_dimension_values[stage_id] = {
            'name': stage_label or stage_id,  # Fallback to stage_id if label is None
            'order': i
        }
    
    for scenario in scenarios_to_process:
        if scenario:
            scenario_id = scenario.scenario_id
            scenario_name = scenario.name or scenario.scenario_id
            scenario_colour = scenario.colour
            visibility_mode = getattr(scenario, 'visibility_mode', 'f+e') or 'f+e'
        else:
            scenario_id = 'current'
            scenario_name = 'Current'
            scenario_colour = '#3b82f6'
            visibility_mode = 'f+e'
        
        # Ensure we have a colour - default to blue if not provided
        if not scenario_colour:
            scenario_colour = '#3b82f6'
        
        scenario_dimension_values[scenario_id] = {
            'name': scenario_name,
            'colour': scenario_colour,
            'visibility_mode': visibility_mode,
        }
    
    # Build flat data rows (stage × scenario)
    data_rows = []
    for i, stage_id in enumerate(stage_ids):
        for scenario in scenarios_to_process:
            if scenario:
                scenario_G = build_networkx_graph(scenario.graph)
                scenario_id = scenario.scenario_id
                visibility_mode = getattr(scenario, 'visibility_mode', 'f+e') or 'f+e'
            else:
                scenario_G = G
                scenario_id = 'current'
                visibility_mode = 'f+e'
            
            # Calculate probability to reach this stage from start
            if i == 0:
                prob = 1.0
                cost_gbp = 0.0
                labour_cost = 0.0
                stdev = None
                distribution = None
                n_total = None
                k_success = None
                forecast_mean = None
                evidence_mean = None
                completeness = None
                p_n = None
                forecast_k = None
            else:
                result = calculate_path_probability(scenario_G, start_id, stage_id, pruning)
                prob = result.probability
                cost_gbp = result.expected_cost_gbp
                labour_cost = result.expected_labour_cost
            
                # Get statistics from incoming edge to this stage
                prev_stage = stage_ids[i - 1]
                stdev = None
                distribution = None
                n_total = None
                k_success = None
                forecast_mean = None
                evidence_mean = None
                completeness = None
                p_n = None
                forecast_k = None
                
                if scenario_G.has_edge(prev_stage, stage_id):
                    edge_data = scenario_G.edges[prev_stage, stage_id]
                    stdev = edge_data.get('p_stdev')
                    distribution = edge_data.get('p_distribution')
                    
                    # Evidence data (observed rate and counts)
                    evidence = edge_data.get('evidence') or {}
                    n_total = evidence.get('n')
                    k_success = evidence.get('k')
                    evidence_mean = evidence.get('mean')
                    
                    # Forecast data (LAG projected probability)
                    forecast = edge_data.get('forecast') or {}
                    forecast_mean = forecast.get('mean')
                    forecast_k = forecast.get('k')
                    
                    # Latency/maturity data (LAG completeness)
                    latency = edge_data.get('latency') or {}
                    completeness = latency.get('completeness')
                    
                    # Inbound-n (forecast population)
                    p_n = edge_data.get('p_n')
            
            # Calculate dropoff from previous stage
            dropoff = None
            if i > 0 and len(data_rows) >= len(scenarios_to_process):
                # Find the previous stage row for this scenario
                prev_idx = len(data_rows) - len(scenarios_to_process)
                prev_row = data_rows[prev_idx]
                if prev_row['scenario_id'] == scenario_id and prev_row['probability'] > 0:
                    dropoff = prev_row['probability'] - prob
            
            row = {
                'stage': stage_id,
                'scenario_id': scenario_id,
                'visibility_mode': visibility_mode,
                'probability': prob,
                'expected_cost_gbp': cost_gbp,
                'expected_labour_cost': labour_cost,
            }
            
            # Include optional fields only if present
            if stdev is not None:
                row['stdev'] = stdev
            if distribution is not None:
                row['distribution'] = distribution
            if n_total is not None:
                row['n'] = n_total
            if k_success is not None:
                row['k'] = k_success
            if dropoff is not None:
                row['dropoff'] = dropoff
            
            # LAG fields: always include if available (invariant semantics)
            if forecast_mean is not None:
                row['forecast_mean'] = forecast_mean
            if evidence_mean is not None:
                row['evidence_mean'] = evidence_mean
            if completeness is not None:
                row['completeness'] = completeness
            if p_n is not None:
                row['p_n'] = p_n
            if forecast_k is not None:
                row['forecast_k'] = forecast_k
            
            data_rows.append(row)
    
    return {
        'metadata': {
            'from_node': start_id,
            'from_label': from_label,
            'to_node': end_id,
            'to_label': to_label,
            'intermediate_nodes': sorted_intermediates,  # Topologically sorted
        },
        'semantics': {
            'dimensions': [
                {'id': 'stage', 'name': 'Stage', 'type': 'stage', 'role': 'primary'},
                {'id': 'scenario_id', 'name': 'Scenario', 'type': 'scenario', 'role': 'secondary'},
            ],
            'metrics': [
                {'id': 'probability', 'name': 'Probability', 'type': 'probability', 'format': 'percent', 'role': 'primary'},
                {'id': 'forecast_mean', 'name': 'Forecast', 'type': 'probability', 'format': 'percent'},
                {'id': 'evidence_mean', 'name': 'Evidence', 'type': 'probability', 'format': 'percent'},
                {'id': 'completeness', 'name': 'Completeness', 'type': 'ratio', 'format': 'percent'},
                {'id': 'stdev', 'name': 'Std Dev', 'type': 'probability', 'format': 'percent'},
                {'id': 'distribution', 'name': 'Distribution', 'type': 'category', 'format': 'string'},
                {'id': 'n', 'name': 'Sample Size', 'type': 'count', 'format': 'integer'},
                {'id': 'k', 'name': 'Conversions', 'type': 'count', 'format': 'integer'},
                {'id': 'p_n', 'name': 'Forecast Population', 'type': 'count', 'format': 'integer'},
                {'id': 'forecast_k', 'name': 'Expected Conversions', 'type': 'count', 'format': 'integer'},
                {'id': 'dropoff', 'name': 'Dropoff', 'type': 'probability', 'format': 'percent'},
                {'id': 'expected_cost_gbp', 'name': 'Expected Cost (£)', 'type': 'currency', 'format': 'currency_gbp'},
                {'id': 'expected_labour_cost', 'name': 'Expected Time', 'type': 'duration', 'format': 'number'},
            ],
            'chart': {
                'recommended': 'funnel',
                'alternatives': ['bar_grouped', 'table'],
                'hints': {'show_dropoff': True}
            }
        },
        'dimension_values': {
            'stage': stage_dimension_values,
            'scenario_id': scenario_dimension_values,
        },
        'data': data_rows,
    }


def run_conversion_funnel(
    G: nx.DiGraph,
    start_id: str,
    end_id: str,
    intermediate_nodes: list[str] = None,
    all_scenarios: Optional[list] = None,
) -> dict[str, Any]:
    """
    Conversion funnel analysis - shows probability at each stage WITHOUT pruning.
    
    Unlike constrained_path (which prunes to paths through waypoints), this shows
    the actual probability of reaching each stage from the start, regardless of path.
    
    This is the natural "funnel" view: what % of traffic reaches each stage?
    """
    # Just call run_path with pruning=None
    result = run_path(G, start_id, end_id, intermediate_nodes, pruning=None, all_scenarios=all_scenarios)
    
    # Update metadata to clarify this is a funnel (not constrained)
    result['metadata']['is_conversion_funnel'] = True
    result['metadata']['description'] = 'Probability at each stage (all paths)'
    
    return result


def run_partial_path(
    G: nx.DiGraph,
    start_id: str,
    intermediate_nodes: list[str],
    pruning: Optional[PruningResult] = None,
    all_scenarios: Optional[list] = None,
) -> dict[str, Any]:
    """
    Analyze partial path from start through intermediates.
    New declarative schema: scenario-first with outcome secondary.
    
    LAG support: includes visibility_mode per scenario for UI adaptors.
    """
    from .graph_builder import build_networkx_graph
    
    from_label = G.nodes[start_id].get('label') or start_id if start_id in G else start_id
    
    # Get absorbing nodes for outcome dimension
    absorbing_nodes = find_absorbing_nodes(G)
    outcome_dimension_values = {}
    for i, absorbing in enumerate(absorbing_nodes):
        outcome_label = G.nodes[absorbing].get('label') or absorbing if absorbing in G else absorbing
        outcome_dimension_values[absorbing] = {
            'name': outcome_label,
            'order': i
        }
    
    # Build scenario dimension values and data rows
    scenarios_to_process = all_scenarios if all_scenarios else [None]
    scenario_dimension_values = {}
    data_rows = []
    
    for scenario in scenarios_to_process:
        if scenario:
            scenario_G = build_networkx_graph(scenario.graph)
            scenario_id = scenario.scenario_id
            scenario_name = scenario.name or scenario.scenario_id
            scenario_colour = scenario.colour or '#3b82f6'
            visibility_mode = getattr(scenario, 'visibility_mode', 'f+e') or 'f+e'
        else:
            scenario_G = G
            scenario_id = 'current'
            scenario_name = 'Current'
            scenario_colour = '#3b82f6'
            visibility_mode = 'f+e'
        
        scenario_dimension_values[scenario_id] = {
            'name': scenario_name,
            'colour': scenario_colour,
            'visibility_mode': visibility_mode,
        }
        
        for absorbing in absorbing_nodes:
            result = calculate_path_probability(scenario_G, start_id, absorbing, pruning)
            if result.probability > 0:
                data_rows.append({
                    'scenario_id': scenario_id,
                    'visibility_mode': visibility_mode,
                    'outcome': absorbing,
                    'probability': result.probability,
                    'expected_cost_gbp': result.expected_cost_gbp,
                    'expected_labour_cost': result.expected_labour_cost,
                })
    
    return {
        'metadata': {
            'from_node': start_id,
            'from_label': from_label,
            'intermediate_nodes': intermediate_nodes,
        },
        'semantics': {
            'dimensions': [
                {'id': 'scenario_id', 'name': 'Scenario', 'type': 'scenario', 'role': 'primary'},
                {'id': 'outcome', 'name': 'Outcome', 'type': 'node', 'role': 'secondary'},
            ],
            'metrics': [
                {'id': 'probability', 'name': 'Probability', 'type': 'probability', 'format': 'percent', 'role': 'primary'},
                {'id': 'expected_cost_gbp', 'name': 'Expected Cost (£)', 'type': 'currency', 'format': 'currency_gbp'},
                {'id': 'expected_labour_cost', 'name': 'Expected Time', 'type': 'duration', 'format': 'number'},
            ],
            'chart': {
                'recommended': 'bar_grouped',
                'alternatives': ['table'],
            }
        },
        'dimension_values': {
            'scenario_id': scenario_dimension_values,
            'outcome': outcome_dimension_values,
        },
        'data': data_rows,
    }


def run_general_stats(
    G: nx.DiGraph,
    node_keys: list[str],
    pruning: Optional[PruningResult] = None,
    all_scenarios: Optional[list] = None,
) -> dict[str, Any]:
    """
    General statistics for arbitrary node selection.
    New declarative schema: node-first with scenario secondary.
    
    LAG support: includes visibility_mode per scenario for UI adaptors.
    
    Args:
        node_keys: Graph keys (UUIDs), already resolved by dispatcher
    """
    from .graph_builder import build_networkx_graph
    
    # Build node dimension values (using human IDs for output)
    node_dimension_values = {}
    for i, graph_key in enumerate(node_keys):
        if graph_key in G:
            node_data = G.nodes[graph_key]
            node_label = node_data.get('label') or node_data.get('id') or graph_key
            human_id = node_data.get('id') or graph_key  # Use human ID for output
            node_type = 'middle'
            if node_data.get('is_entry'):
                node_type = 'entry'
            elif node_data.get('absorbing'):
                node_type = 'absorbing'
        else:
            human_id = graph_key
            node_label = graph_key
            node_type = 'unknown'
        
        node_dimension_values[human_id] = {
            'name': node_label,
            'type': node_type,
            'order': i
        }
    
    # Build scenario dimension values and data rows
    scenarios_to_process = all_scenarios if all_scenarios else [None]
    scenario_dimension_values = {}
    data_rows = []
    
    for scenario in scenarios_to_process:
        if scenario:
            scenario_G = build_networkx_graph(scenario.graph)
            scenario_id = scenario.scenario_id
            scenario_name = scenario.name or scenario.scenario_id
            scenario_colour = scenario.colour or '#3b82f6'
            visibility_mode = getattr(scenario, 'visibility_mode', 'f+e') or 'f+e'
        else:
            scenario_G = G
            scenario_id = 'current'
            scenario_name = 'Current'
            scenario_colour = '#3b82f6'
            visibility_mode = 'f+e'
        
        scenario_dimension_values[scenario_id] = {
            'name': scenario_name,
            'colour': scenario_colour,
            'visibility_mode': visibility_mode,
        }
        
        for graph_key in node_keys:
            if graph_key not in scenario_G:
                continue
            node_data = scenario_G.nodes[graph_key]
            human_id = node_data.get('id') or graph_key
            result = calculate_path_through_node(scenario_G, graph_key, pruning)
            data_rows.append({
                'node': human_id,
                'scenario_id': scenario_id,
                'visibility_mode': visibility_mode,
                'path_through_probability': result.probability,
            })
    
    # Get human IDs for metadata
    human_ids = [G.nodes[k].get('id') or k for k in node_keys if k in G]
    
    return {
        'metadata': {
            'selected_nodes': human_ids,
        },
        'semantics': {
            'dimensions': [
                {'id': 'node', 'name': 'Node', 'type': 'node', 'role': 'primary'},
                {'id': 'scenario_id', 'name': 'Scenario', 'type': 'scenario', 'role': 'secondary'},
            ],
            'metrics': [
                {'id': 'path_through_probability', 'name': 'Path Through', 'type': 'probability', 'format': 'percent', 'role': 'primary'},
            ],
            'chart': {
                'recommended': 'bar_grouped',
                'alternatives': ['table'],
            }
        },
        'dimension_values': {
            'node': node_dimension_values,
            'scenario_id': scenario_dimension_values,
        },
        'data': data_rows,
    }


def run_graph_overview(
    G: nx.DiGraph,
    node_ids: list[str] = None,
    pruning: Optional[PruningResult] = None,
    all_scenarios: Optional[list] = None,
) -> dict[str, Any]:
    """
    Analyze entire graph without selection.
    
    Returns overall graph statistics and structure analysis.
    New declarative schema: outcome-first with scenario secondary.
    
    LAG support: includes visibility_mode per scenario for UI adaptors.
    """
    from .graph_builder import build_networkx_graph
    
    # Get outcome dimension values (absorbing nodes)
    absorbing_nodes = find_absorbing_nodes(G)
    outcome_dimension_values = {}
    for i, absorbing in enumerate(absorbing_nodes):
        outcome_label = G.nodes[absorbing].get('label') or absorbing if absorbing in G else absorbing
        outcome_dimension_values[absorbing] = {
            'name': outcome_label,
            'order': i
        }
    
    # Build scenario dimension values and data rows
    scenarios_to_process = all_scenarios if all_scenarios else [None]
    scenario_dimension_values = {}
    data_rows = []
    
    for scenario in scenarios_to_process:
        if scenario:
            scenario_G = build_networkx_graph(scenario.graph)
            scenario_id = scenario.scenario_id
            scenario_name = scenario.name or scenario.scenario_id
            scenario_colour = scenario.colour or '#3b82f6'
            visibility_mode = getattr(scenario, 'visibility_mode', 'f+e') or 'f+e'
        else:
            scenario_G = G
            scenario_id = 'current'
            scenario_name = 'Current'
            scenario_colour = '#3b82f6'
            visibility_mode = 'f+e'
        
        scenario_dimension_values[scenario_id] = {
            'name': scenario_name,
            'colour': scenario_colour,
            'visibility_mode': visibility_mode,
        }
        
        entry_nodes = find_entry_nodes(scenario_G)
        
        for absorbing in absorbing_nodes:
            total_prob = 0.0
            total_cost_gbp = 0.0
            total_labour_cost = 0.0
            
            for entry in entry_nodes:
                entry_weight = scenario_G.nodes[entry].get('entry_weight', 1.0 / len(entry_nodes)) if entry_nodes else 0
                result = calculate_path_probability(scenario_G, entry, absorbing, pruning)
                total_prob += entry_weight * result.probability
                total_cost_gbp += entry_weight * result.expected_cost_gbp
                total_labour_cost += entry_weight * result.expected_labour_cost
            
            data_rows.append({
                'outcome': absorbing,
                'scenario_id': scenario_id,
                'visibility_mode': visibility_mode,
                'probability': total_prob,
                'expected_cost_gbp': total_cost_gbp,
                'expected_labour_cost': total_labour_cost,
            })
    
    # Get graph stats from primary graph
    stats = get_graph_stats(G)
    entry_nodes = find_entry_nodes(G)
    
    return {
        'metadata': {
            'node_count': stats.get('node_count', 0),
            'edge_count': stats.get('edge_count', 0),
            'entry_nodes': [{'id': n, 'label': G.nodes[n].get('label') or n} for n in entry_nodes],
        },
        'semantics': {
            'dimensions': [
                {'id': 'outcome', 'name': 'Outcome', 'type': 'node', 'role': 'primary'},
                {'id': 'scenario_id', 'name': 'Scenario', 'type': 'scenario', 'role': 'secondary'},
            ],
            'metrics': [
                {'id': 'probability', 'name': 'Probability', 'type': 'probability', 'format': 'percent', 'role': 'primary'},
                {'id': 'expected_cost_gbp', 'name': 'Expected Cost (£)', 'type': 'currency', 'format': 'currency_gbp'},
                {'id': 'expected_labour_cost', 'name': 'Expected Time', 'type': 'duration', 'format': 'number'},
            ],
            'chart': {
                'recommended': 'bar_grouped',
                'alternatives': ['pie', 'table'],
                'hints': {
                    'sort': {'by': 'probability', 'order': 'desc'}  # Highest first
                }
            }
        },
        'dimension_values': {
            'outcome': outcome_dimension_values,
            'scenario_id': scenario_dimension_values,
        },
        'data': data_rows,
    }


# Runner dispatch table
RUNNERS = {
    'single_node_runner': run_single_node_entry,
    'path_to_end_runner': run_path_to_end,
    'path_through_runner': run_path_through,
    'end_comparison_runner': run_end_comparison,
    'branch_comparison_runner': run_branch_comparison,
    'path_runner': run_path,
    'conversion_funnel_runner': run_conversion_funnel,
    'partial_path_runner': run_partial_path,
    'general_stats_runner': run_general_stats,
    'graph_overview_runner': run_graph_overview,
}


def get_runner(runner_name: str):
    """Get runner function by name."""
    return RUNNERS.get(runner_name)

