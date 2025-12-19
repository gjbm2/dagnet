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
    run_conversion_funnel,
    run_partial_path,
    run_general_stats,
    run_graph_overview,
    get_runner,
)
from lib.query_dsl import parse_query, ParsedQuery


def analyze(request: AnalysisRequest) -> AnalysisResponse:
    """
    Main analysis entry point.
    
    Passes all scenarios to the analysis. Returns a single result.
    The runner decides how to structure the data based on analysis type.
    
    Args:
        request: AnalysisRequest with graph(s) and DSL query
    
    Returns:
        AnalysisResponse with single result
    """
    try:
        # Use first scenario for analysis (runner may use all scenarios internally)
        first_scenario = request.scenarios[0] if request.scenarios else None
        
        if not first_scenario:
            return AnalysisResponse(
                success=False,
                error={'error_type': 'ValueError', 'message': 'No scenarios provided'},
                query_dsl=request.query_dsl,
            )
        
        result = analyze_scenario(
            graph_data=first_scenario.graph,
            query_dsl=request.query_dsl,
            scenario_count=len(request.scenarios),
            all_scenarios=request.scenarios,
            analysis_type_override=request.analysis_type,
        )
        
        return AnalysisResponse(
            success=True,
            result=result,
            query_dsl=request.query_dsl,
        )
    
    except Exception as e:
        return AnalysisResponse(
            success=False,
            error={
                'error_type': type(e).__name__,
                'message': str(e),
            },
            query_dsl=request.query_dsl,
        )


def analyze_scenario(
    graph_data: dict[str, Any],
    query_dsl: Optional[str] = None,
    scenario_count: int = 1,
    all_scenarios: Optional[list] = None,
    analysis_type_override: Optional[str] = None,
) -> AnalysisResult:
    """
    Run analysis.
    
    Args:
        graph_data: Raw graph data dict (primary scenario)
        query_dsl: DSL query string (determines what to analyze)
        scenario_count: Total number of scenarios
        all_scenarios: All scenario data (for multi-scenario analysis)
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
        all_scenarios=all_scenarios,
    )
    
    # Translate UUIDs to human-readable IDs in the results
    # This ensures consistency: DSL uses human IDs, results return human IDs
    translated_result = translate_uuids_to_ids(G, runner_result)
    
    # Extract declarative schema fields if present (new schema)
    # Otherwise fall back to putting everything in data (legacy)
    if 'semantics' in translated_result:
        return AnalysisResult(
            analysis_type=analysis_def.id,
            analysis_name=analysis_def.name,
            analysis_description=analysis_def.description,
            metadata=translated_result.get('metadata', {}),
            semantics=translated_result.get('semantics'),
            dimension_values=translated_result.get('dimension_values', {}),
            data=translated_result.get('data', []),
        )
    else:
        # Legacy format - wrap in data field
        return AnalysisResult(
            analysis_type=analysis_def.id,
            analysis_name=analysis_def.name,
            analysis_description=analysis_def.description,
            data=[translated_result],  # Wrap as single-item array for consistency
        )


def dispatch_runner(
    runner_name: str,
    G: nx.DiGraph,
    predicates: dict,
    from_node: Optional[str],
    to_node: Optional[str],
    dsl_nodes: list[str],
    pruning: Optional[PruningResult],
    all_scenarios: Optional[list] = None,
) -> dict[str, Any]:
    """
    Dispatch to the appropriate runner based on runner name.
    
    All node information comes from DSL parsing, not UI selection.
    
    Args:
        runner_name: Name from analysis definition
        G: NetworkX graph
        predicates: Computed predicates from DSL
        from_node: From DSL from() clause (human-readable ID)
        to_node: From DSL to() clause (human-readable ID)
        all_scenarios: All scenario data for multi-scenario analysis
        dsl_nodes: All nodes mentioned in DSL (human-readable IDs)
        pruning: Computed pruning result
    
    Returns:
        Runner result dict
    """
    from .graph_builder import get_graph_key, resolve_node_ids
    
    # Resolve human-readable IDs to graph keys (UUIDs)
    # DSL uses human IDs but graph is keyed by UUIDs
    resolved_from = get_graph_key(G, from_node) if from_node else None
    resolved_to = get_graph_key(G, to_node) if to_node else None
    resolved_nodes = resolve_node_ids(G, dsl_nodes)
    
    # Single node runners - node comes from DSL
    if runner_name == 'from_node_runner':
        if resolved_from:
            return run_single_node_entry(G, resolved_from, pruning, all_scenarios)
        return {'error': f'from() node not found: {from_node}'}
    
    elif runner_name == 'to_node_runner':
        if resolved_to:
            return run_path_to_end(G, resolved_to, pruning, all_scenarios)
        return {'error': f'to() node not found: {to_node}'}

    elif runner_name == 'bridge_view_runner':
        if resolved_to:
            from .runners import run_bridge_view
            return run_bridge_view(G, resolved_to, pruning, all_scenarios)
        return {'error': f'to() node not found: {to_node}'}
    
    elif runner_name == 'path_through_runner':
        # Single visited() node
        node_key = resolved_nodes[0] if resolved_nodes else None
        if node_key:
            return run_path_through(G, node_key, pruning, all_scenarios)
        return {'error': 'visited() node required'}
    
    # Multi-node comparison runners - nodes from DSL
    elif runner_name == 'end_comparison_runner':
        return run_end_comparison(G, resolved_nodes, pruning, all_scenarios)
    
    elif runner_name == 'branch_comparison_runner':
        return run_branch_comparison(G, resolved_nodes, pruning, all_scenarios)
    
    # Path runners
    elif runner_name == 'path_runner':
        if resolved_from and resolved_to:
            # Get intermediates (nodes that aren't from/to)
            intermediates = [n for n in resolved_nodes if n != resolved_from and n != resolved_to]
            return run_path(G, resolved_from, resolved_to, intermediates, pruning, all_scenarios)
        return {'error': 'Path requires from() and to() nodes'}
    
    elif runner_name == 'conversion_funnel_runner':
        if resolved_from and resolved_to:
            intermediates = [n for n in resolved_nodes if n != resolved_from and n != resolved_to]
            return run_conversion_funnel(G, resolved_from, resolved_to, intermediates, all_scenarios)
        return {'error': 'Conversion funnel requires from() and to() nodes'}
    
    elif runner_name == 'constrained_path_runner':
        if resolved_from and resolved_to:
            intermediates = [n for n in resolved_nodes if n != resolved_from and n != resolved_to]
            return run_path(G, resolved_from, resolved_to, intermediates, pruning, all_scenarios)
        return {'error': 'Constrained path requires from() and to() nodes'}
    
    elif runner_name == 'branches_from_start_runner':
        if resolved_from:
            intermediates = [n for n in resolved_nodes if n != resolved_from]
            return run_partial_path(G, resolved_from, intermediates, pruning, all_scenarios)
        return {'error': 'Branches from start requires from() node'}
    
    elif runner_name == 'multi_waypoint_runner':
        # Multiple visited() without from/to
        return run_general_stats(G, resolved_nodes, pruning, all_scenarios)
    
    # Graph overview (empty DSL)
    elif runner_name == 'graph_overview_runner':
        return run_graph_overview(G, resolved_nodes, pruning, all_scenarios)
    
    # Fallback
    elif runner_name == 'general_stats_runner':
        return run_general_stats(G, resolved_nodes, pruning, all_scenarios)
    
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

