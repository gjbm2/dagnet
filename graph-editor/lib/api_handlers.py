"""
Shared API handlers for Python endpoints.

Used by both:
- dev-server.py (FastAPI)
- python-api.py (Vercel serverless)

This ensures dev and prod use identical handler logic.
"""
from typing import Dict, Any, Optional, List


def handle_generate_all_parameters(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle generate-all-parameters endpoint.
    
    Args:
        data: Request body containing:
            - graph: Graph data (required)
            - paramTypes: Optional filter by type
            - downstream_of: Optional incremental updates
            - edge_id: Optional filter to single edge (returns base p, cost_gbp, cost_time)
            - conditional_index: Optional filter to specific conditional (requires edge_id)
            - maxChecks: Optional (default 200)
            - literal_weights: Optional
            - preserve_condition: Optional (default True)
            - preserveCaseContext: Optional (default True)
    
    Returns:
        Response dict with parameters and stats
    """
    graph_data = data.get('graph')
    param_types = data.get('paramTypes')  # Optional: filter by type
    downstream_of = data.get('downstream_of')  # Optional: incremental updates
    edge_id = data.get('edge_id')  # Optional: filter to single edge
    conditional_index = data.get('conditional_index')  # Optional: filter to specific conditional
    max_checks = data.get('maxChecks', 200)
    literal_weights = data.get('literal_weights')
    preserve_condition = data.get('preserve_condition', True)
    preserve_case_context = data.get('preserveCaseContext', True)
    
    if not graph_data:
        raise ValueError("Missing 'graph' field")
    
    from msmdc import generate_all_parameter_queries, generate_queries_by_type
    from graph_types import Graph
    
    graph = Graph.model_validate(graph_data)
    
    # Generate all parameters or filter by type/downstream/edge
    # Pass edge_id and conditional_index directly to MSMDC for efficiency
    if param_types:
        params_by_type = generate_queries_by_type(
            graph, param_types, max_checks, downstream_of, literal_weights, preserve_condition, preserve_case_context
        )
        all_params = []
        for ptype, params in params_by_type.items():
            all_params.extend(params)
    else:
        all_params = generate_all_parameter_queries(
            graph, max_checks, downstream_of, literal_weights, preserve_condition, preserve_case_context,
            edge_uuid=edge_id,  # Pass edge filter directly to MSMDC
            conditional_index=conditional_index  # Pass conditional filter directly to MSMDC
        )
    
    # Format response
    parameters = []
    stats_by_type = {}
    
    for param in all_params:
        parameters.append({
            "paramType": param.param_type,
            "paramId": param.param_id,
            "edgeKey": param.edge_key,
            "condition": param.condition,
            "query": param.query,
            "stats": param.stats
        })
        
        # Count by type
        if param.param_type not in stats_by_type:
            stats_by_type[param.param_type] = 0
        stats_by_type[param.param_type] += 1
    
    return {
        "parameters": parameters,
        "stats": {
            "total": len(parameters),
            "byType": stats_by_type
        },
        "success": True
    }


def handle_stats_enhance(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle stats-enhance endpoint.
    
    Args:
        data: Request body containing:
            - raw: Raw aggregation data (required)
            - method: Enhancement method (required)
    
    Returns:
        Enhanced aggregation response
    """
    raw_data = data.get('raw')
    method = data.get('method')
    
    if not raw_data:
        raise ValueError("Missing 'raw' field")
    if not method:
        raise ValueError("Missing 'method' field")
    
    from stats_enhancement import enhance_aggregation
    
    enhanced = enhance_aggregation(raw_data, method)
    
    return {
        **enhanced,
        "success": True
    }


def handle_parse_query(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle parse-query endpoint.
    
    Args:
        data: Request body containing:
            - query: Query DSL string (required)
    
    Returns:
        Parsed query structure
    """
    query_str = data.get('query')
    
    if not query_str:
        raise ValueError("Missing 'query' field")
    
    from query_dsl import parse_query_strict, validate_query
    
    # Validate (require endpoints for data retrieval)
    is_valid, error = validate_query(query_str, require_endpoints=True)
    if not is_valid:
        raise ValueError(f"Invalid query: {error}")
    
    # Parse (strict - requires from/to for data retrieval)
    parsed = parse_query_strict(query_str)
    
    # Return structured response
    return {
        "query": query_str,
        "parsed": {
            "from_node": parsed.from_node,
            "to_node": parsed.to_node,
            "exclude": parsed.exclude,
            "visited": parsed.visited,
            "visited_any": getattr(parsed, "visited_any", []),
            "context": [{"key": c.key, "value": c.value} for c in parsed.context],
            "cases": [{"key": c.key, "value": c.value} for c in parsed.cases]
        },
        "valid": True,
        "reconstructed": parsed.raw
    }


def handle_runner_analyze(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle runner/analyze endpoint.
    
    Args:
        data: Request body containing:
            - scenarios: List of scenario data (required)
            - query_dsl: DSL query string (optional)
            - analysis_type: Override analysis type (optional)
    
    Returns:
        Analysis results
    """
    from runner import analyze
    from runner.types import AnalysisRequest, ScenarioData
    
    if 'scenarios' not in data or not data['scenarios']:
        raise ValueError("Missing 'scenarios' field")
    
    # Build request
    scenarios = [
        ScenarioData(
            scenario_id=s.get('scenario_id', f'scenario_{i}'),
            name=s.get('name'),
            colour=s.get('colour'),
            graph=s.get('graph', {}),
        )
        for i, s in enumerate(data['scenarios'])
    ]
    
    request_obj = AnalysisRequest(
        scenarios=scenarios,
        query_dsl=data.get('query_dsl'),
        analysis_type=data.get('analysis_type'),
    )
    
    # Run analysis
    response = analyze(request_obj)
    
    # Return JSON-serializable response
    return response.model_dump()


def handle_runner_available_analyses(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle runner/available-analyses endpoint.
    
    Args:
        data: Request body containing:
            - graph: Graph data (optional)
            - query_dsl: DSL query string (optional)
            - scenario_count: Number of scenarios (optional, default 1)
    
    Returns:
        List of available analyses
    """
    from runner import get_available_analyses
    
    graph_data = data.get('graph', {})
    scenario_count = data.get('scenario_count', 1)
    query_dsl = data.get('query_dsl')
    
    available = get_available_analyses(
        graph_data=graph_data,
        query_dsl=query_dsl,
        scenario_count=scenario_count,
    )
    
    return {"analyses": available}


def handle_compile_exclude(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle compile-exclude endpoint.
    
    Compiles a query with excludes() terms to minus/plus form for providers
    that don't support native excludes (like Amplitude).
    
    Args:
        data: Request body containing:
            - query: Query DSL string with excludes() (required)
            - graph: Graph data for topology analysis (required)
    
    Returns:
        Response dict with compiled_query
    """
    import re
    query_str = data.get('query')
    graph_data = data.get('graph')
    
    if not query_str:
        raise ValueError("Missing 'query' field")
    if not graph_data:
        raise ValueError("Missing 'graph' field")
    
    # Parse the query to extract from, to, and excludes
    from query_dsl import parse_query_strict
    from graph_types import Graph
    
    parsed = parse_query_strict(query_str)
    
    if not parsed.exclude:
        # No excludes, return original query
        return {
            "compiled_query": query_str,
            "was_compiled": False,
            "success": True
        }
    
    # Build graph for topology analysis
    graph = Graph.model_validate(graph_data)
    
    # Import the inclusion-exclusion compiler
    import sys
    from pathlib import Path
    algorithms_path = Path(__file__).parent / 'algorithms'
    sys.path.insert(0, str(algorithms_path))
    
    from connection_capabilities import supports_native_exclude
    
    # Check if we need to compile (Amplitude doesn't support native excludes)
    # For this endpoint, we assume caller has already determined compilation is needed
    
    # Build networkx graph for the compiler
    import networkx as nx
    G = nx.DiGraph()
    
    # Add nodes
    for node in graph.nodes:
        node_id = node.id or node.uuid
        G.add_node(node_id)
    
    # Add edges
    for edge in graph.edges:
        from_id = edge.from_node
        to_id = edge.to
        # Resolve from/to to node IDs
        from_node = next((n for n in graph.nodes if n.uuid == from_id or n.id == from_id), None)
        to_node = next((n for n in graph.nodes if n.uuid == to_id or n.id == to_id), None)
        if from_node and to_node:
            from_node_id = from_node.id or from_node.uuid
            to_node_id = to_node.id or to_node.uuid
            G.add_edge(from_node_id, to_node_id)
    
    # Get from/to nodes
    from_node = parsed.from_node
    to_node = parsed.to_node
    exclude_nodes = parsed.exclude
    
    # Import the optimized inclusion-exclusion compiler
    from optimized_inclusion_exclusion import compile_optimized_inclusion_exclusion
    
    try:
        compiled_query, terms = compile_optimized_inclusion_exclusion(
            G, from_node, to_node, to_node, exclude_nodes
        )
        
        # Prepend any visited() terms from original query
        if parsed.visited:
            visited_str = f".visited({','.join(parsed.visited)})"
            # Insert visited after to() but before minus()
            if '.minus(' in compiled_query:
                parts = compiled_query.split('.minus(', 1)
                compiled_query = f"{parts[0]}{visited_str}.minus({parts[1]}"
            else:
                compiled_query = f"{compiled_query}{visited_str}"
        
        return {
            "compiled_query": compiled_query,
            "was_compiled": True,
            "terms_count": len(terms),
            "success": True
        }
    except Exception as e:
        print(f"[compile_exclude] Compilation failed: {e}")
        return {
            "compiled_query": query_str,
            "was_compiled": False,
            "error": str(e),
            "success": False
        }

