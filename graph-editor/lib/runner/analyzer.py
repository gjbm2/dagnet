"""
Main Analyzer

Orchestrates analysis flow:
1. Parse DSL query
2. Build NetworkX graph  
3. Compute selection predicates
4. Match to analysis type
5. Run appropriate runner
6. Return results

Design Reference: /docs/current/project-analysis/PHASE_1_DESIGN.md
"""

from typing import Any, Optional
import networkx as nx

from .types import AnalysisRequest, AnalysisResponse, AnalysisResult
from .graph_builder import build_networkx_graph, translate_uuids_to_ids
# Note: predicates.py has selection-based predicates - not used
# Analysis type matching is solely based on DSL via compute_predicates_from_dsl
from .adaptor import match_analysis_type, get_adaptor
from .path_runner import compute_pruning, PruningResult
from .runners import (
    run_single_node_entry,
    run_path_to_end,
    run_path_through,
    run_end_comparison,
    run_branch_comparison,
    run_path,
    run_partial_path,
    run_general_stats,
    run_graph_overview,
    get_runner,
)
from lib.query_dsl import parse_query, ParsedQuery


def analyze(request: AnalysisRequest) -> AnalysisResponse:
    """
    Main analysis entry point.
    
    Args:
        request: AnalysisRequest with graph and DSL query
    
    Returns:
        AnalysisResponse with results for each scenario
    """
    try:
        results = []
        
        # Process each scenario
        for scenario in request.scenarios:
            result = analyze_scenario(
                graph_data=scenario.graph,
                query_dsl=request.query_dsl,
                scenario_id=scenario.scenario_id,
                scenario_count=len(request.scenarios),
                analysis_type_override=request.analysis_type,
            )
            results.append(result)
        
        return AnalysisResponse(
            success=True,
            results=results,
            query_dsl=request.query_dsl,
        )
    
    except Exception as e:
        return AnalysisResponse(
            success=False,
            error={
                'error_type': type(e).__name__,
                'message': str(e),
            },
            results=[],
            query_dsl=request.query_dsl,
        )


def analyze_scenario(
    graph_data: dict[str, Any],
    query_dsl: Optional[str] = None,
    scenario_id: str = 'default',
    scenario_count: int = 1,
    analysis_type_override: Optional[str] = None,
) -> AnalysisResult:
    """
    Analyze a single scenario.
    
    Args:
        graph_data: Raw graph data dict
        query_dsl: DSL query string (determines what to analyze)
        scenario_id: Scenario identifier
        scenario_count: Total number of scenarios (for predicates)
        analysis_type_override: Optional override for analysis type
    
    Returns:
        AnalysisResult with analysis data
    """
    # Build NetworkX graph
    G = build_networkx_graph(graph_data)
    
    # Compute predicates from DSL (DSL is authoritative for analysis type)
    predicates = compute_predicates_from_dsl(
        G=G,
        query_dsl=query_dsl,
        scenario_count=scenario_count,
    )
    
    # Parse DSL for runner data (from/to/visited)
    parsed_query = None
    visited_nodes = []
    visited_any_groups = []
    from_node = predicates.get('start_node')
    to_node = predicates.get('end_node')
    
    if query_dsl:
        parsed_query = parse_query(query_dsl)
        visited_nodes = parsed_query.visited or []
        visited_any_groups = parsed_query.visited_any or []
    
    # Match to analysis type (use override if provided)
    if analysis_type_override:
        adaptor = get_adaptor()
        analysis_def = None
        for defn in adaptor.definitions:
            if defn.id == analysis_type_override:
                analysis_def = defn
                break
        if not analysis_def:
            # Fall back to automatic matching if override not found
            analysis_def = match_analysis_type(predicates)
    else:
        analysis_def = match_analysis_type(predicates)
    
    # Compute pruning from DSL constraints
    pruning = None
    if visited_nodes or visited_any_groups:
        pruning = compute_pruning(G, visited_nodes, visited_any_groups)
    
    # Collect all DSL nodes for runners that need them
    dsl_nodes = []
    if from_node:
        dsl_nodes.append(from_node)
    dsl_nodes.extend(visited_nodes)
    for group in visited_any_groups:
        dsl_nodes.extend(group)
    if to_node:
        dsl_nodes.append(to_node)
    
    # Run the appropriate runner
    runner_result = dispatch_runner(
        runner_name=analysis_def.runner,
        G=G,
        predicates=predicates,
        from_node=from_node,
        to_node=to_node,
        dsl_nodes=dsl_nodes,
        pruning=pruning,
    )
    
    # Translate UUIDs to human-readable IDs in the results
    # This ensures consistency: DSL uses human IDs, results return human IDs
    translated_result = translate_uuids_to_ids(G, runner_result)
    
    return AnalysisResult(
        scenario_id=scenario_id,
        analysis_type=analysis_def.id,
        analysis_name=analysis_def.name,
        analysis_description=analysis_def.description,
        data=translated_result,
    )


def dispatch_runner(
    runner_name: str,
    G: nx.DiGraph,
    predicates: dict,
    from_node: Optional[str],
    to_node: Optional[str],
    dsl_nodes: list[str],
    pruning: Optional[PruningResult],
) -> dict[str, Any]:
    """
    Dispatch to the appropriate runner based on runner name.
    
    All node information comes from DSL parsing, not UI selection.
    
    Args:
        runner_name: Name from analysis definition
        G: NetworkX graph
        predicates: Computed predicates from DSL
        from_node: From DSL from() clause
        to_node: From DSL to() clause
        dsl_nodes: All nodes mentioned in DSL
        pruning: Computed pruning result
    
    Returns:
        Runner result dict
    """
    # Single node runners - node comes from DSL
    if runner_name == 'from_node_runner':
        if from_node:
            return run_single_node_entry(G, from_node, pruning)
        return {'error': 'from() node required'}
    
    elif runner_name == 'to_node_runner':
        if to_node:
            return run_path_to_end(G, to_node, pruning)
        return {'error': 'to() node required'}
    
    elif runner_name == 'path_through_runner':
        # Single visited() node
        node_id = dsl_nodes[0] if dsl_nodes else None
        if node_id:
            return run_path_through(G, node_id, pruning)
        return {'error': 'visited() node required'}
    
    # Multi-node comparison runners - nodes from DSL
    elif runner_name == 'end_comparison_runner':
        return run_end_comparison(G, dsl_nodes, pruning)
    
    elif runner_name == 'branch_comparison_runner':
        return run_branch_comparison(G, dsl_nodes, pruning)
    
    # Path runners
    elif runner_name == 'path_runner':
        if from_node and to_node:
            # Get intermediates (nodes that aren't from/to)
            intermediates = [n for n in dsl_nodes if n != from_node and n != to_node]
            return run_path(G, from_node, to_node, intermediates, pruning)
        return {'error': 'Path requires from() and to() nodes'}
    
    elif runner_name == 'constrained_path_runner':
        if from_node and to_node:
            intermediates = [n for n in dsl_nodes if n != from_node and n != to_node]
            return run_path(G, from_node, to_node, intermediates, pruning)
        return {'error': 'Constrained path requires from() and to() nodes'}
    
    elif runner_name == 'branches_from_start_runner':
        if from_node:
            intermediates = [n for n in dsl_nodes if n != from_node]
            return run_partial_path(G, from_node, intermediates, pruning)
        return {'error': 'Branches from start requires from() node'}
    
    elif runner_name == 'multi_waypoint_runner':
        # Multiple visited() without from/to
        return run_general_stats(G, dsl_nodes, pruning)
    
    # Graph overview (empty DSL)
    elif runner_name == 'graph_overview_runner':
        return run_graph_overview(G, dsl_nodes, pruning)
    
    # Fallback
    elif runner_name == 'general_stats_runner':
        return run_general_stats(G, dsl_nodes, pruning)
    
    else:
        return {'error': f'Unknown runner: {runner_name}'}


def get_available_analyses(
    graph_data: dict[str, Any],
    query_dsl: Optional[str] = None,
    scenario_count: int = 1,
) -> list[dict]:
    """
    Get all analysis types available for the given DSL query.
    
    Analysis type matching is based entirely on the DSL string.
    
    Args:
        graph_data: Raw graph data
        query_dsl: DSL query string (determines available analyses)
        scenario_count: Number of scenarios
    
    Returns:
        List of available analysis type dicts
    """
    G = build_networkx_graph(graph_data)
    
    # Compute predicates entirely from DSL
    predicates = compute_predicates_from_dsl(G, query_dsl, scenario_count)
    
    adaptor = get_adaptor()
    matching = adaptor.get_all_matching(predicates)
    
    return [
        {
            'id': d.id,
            'name': d.name,
            'description': d.description,
            'is_primary': i == 0,  # First match is primary
        }
        for i, d in enumerate(matching)
    ]


def compute_predicates_from_dsl(
    G: nx.DiGraph,
    query_dsl: Optional[str],
    scenario_count: int = 1,
) -> dict:
    """
    Compute predicates for analysis type matching from DSL string.
    
    The DSL string is the sole determinant of which analysis types are available.
    
    DSL Pattern → Analysis mapping:
    - "" (empty)                    → graph_overview
    - from(A)                       → outcomes from A (entry analysis)
    - to(B)                         → probability to reach B
    - visited(A)                    → path through A
    - from(A).to(B)                 → path A→B
    - from(A).to(B).visited(C)      → constrained path
    - visitedAny(A,B)               → branch comparison
    - from(A).visitedAny(B,C)       → branches from start
    
    Args:
        G: NetworkX graph (for resolving node properties)
        query_dsl: DSL query string
        scenario_count: Number of scenarios
    
    Returns:
        Predicates dict for analysis type matching
    """
    from .graph_builder import resolve_node_id
    
    # Initialize with defaults
    predicates = {
        # DSL structure predicates
        'node_count': 0,
        'has_from': False,
        'has_to': False,
        'visited_count': 0,
        'visited_any_count': 0,
        
        # Legacy predicates for backwards compatibility
        'has_unique_start': False,
        'has_unique_end': False,
        'start_node': None,
        'end_node': None,
        
        # Node type predicates (for single node)
        'is_graph_entry': False,
        'is_graph_absorbing': False,
        
        # Multi-node predicates
        'all_absorbing': False,
        'all_are_siblings': False,
        'is_sequential': False,
        
        # Scenario predicates
        'scenario_count': scenario_count,
        'multiple_scenarios': scenario_count > 1,
    }
    
    if not query_dsl or not query_dsl.strip():
        return predicates
    
    # Parse DSL
    parsed_query = parse_query(query_dsl)
    from_node = parsed_query.from_node
    to_node = parsed_query.to_node
    visited_nodes = parsed_query.visited or []
    visited_any_groups = parsed_query.visited_any or []
    
    # DSL structure predicates
    predicates['has_from'] = from_node is not None
    predicates['has_to'] = to_node is not None
    predicates['visited_count'] = len(visited_nodes)
    predicates['visited_any_count'] = len(visited_any_groups)
    
    # Legacy predicates
    predicates['has_unique_start'] = predicates['has_from']
    predicates['has_unique_end'] = predicates['has_to']
    predicates['start_node'] = from_node
    predicates['end_node'] = to_node
    
    # Collect all unique nodes from DSL
    all_nodes = set()
    if from_node:
        all_nodes.add(from_node)
    if to_node:
        all_nodes.add(to_node)
    for v in visited_nodes:
        all_nodes.add(v)
    for group in visited_any_groups:
        for v in group:
            all_nodes.add(v)
    
    predicates['node_count'] = len(all_nodes)
    
    # Resolve nodes to graph keys for property checks
    resolved_nodes = []
    for node_id in all_nodes:
        resolved = resolve_node_id(G, node_id)
        if resolved and resolved in G.nodes:
            resolved_nodes.append(resolved)
    
    # Single node predicates
    if len(resolved_nodes) == 1:
        node_key = resolved_nodes[0]
        node_data = G.nodes[node_key]
        is_entry = node_data.get('is_entry', False) or G.in_degree(node_key) == 0
        is_absorbing = node_data.get('absorbing', False) or G.out_degree(node_key) == 0
        predicates['is_graph_entry'] = is_entry
        predicates['is_graph_absorbing'] = is_absorbing
    
    # All absorbing check (for outcome comparison)
    if resolved_nodes:
        predicates['all_absorbing'] = all(
            G.nodes[n].get('absorbing', False) or G.out_degree(n) == 0
            for n in resolved_nodes
        )
    
    # Siblings check - do constraint nodes share a common parent?
    # Constraint nodes = visited + visitedAny nodes (not from/to)
    constraint_node_ids = set()
    for v in visited_nodes:
        constraint_node_ids.add(v)
    for group in visited_any_groups:
        for v in group:
            constraint_node_ids.add(v)
    
    constraint_resolved = []
    for node_id in constraint_node_ids:
        resolved = resolve_node_id(G, node_id)
        if resolved and resolved in G.nodes:
            constraint_resolved.append(resolved)
    
    if len(constraint_resolved) >= 2:
        parent_sets = [set(G.predecessors(n)) for n in constraint_resolved]
        common_parents = parent_sets[0]
        for ps in parent_sets[1:]:
            common_parents = common_parents.intersection(ps)
        predicates['all_are_siblings'] = len(common_parents) > 0
    elif len(resolved_nodes) >= 2 and not from_node and not to_node:
        # No from/to, all nodes are constraints - check if siblings
        parent_sets = [set(G.predecessors(n)) for n in resolved_nodes]
        if parent_sets:
            common_parents = parent_sets[0]
            for ps in parent_sets[1:]:
                common_parents = common_parents.intersection(ps)
            predicates['all_are_siblings'] = len(common_parents) > 0
    
    # Sequential check - direct path from→to
    if from_node and to_node and len(resolved_nodes) == 2:
        from_resolved = resolve_node_id(G, from_node)
        to_resolved = resolve_node_id(G, to_node)
        if from_resolved and to_resolved:
            predicates['is_sequential'] = G.has_edge(from_resolved, to_resolved)
    
    return predicates

