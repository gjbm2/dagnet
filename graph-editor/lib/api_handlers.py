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
            - edge_id: Optional filter to single edge (returns base p, cost_gbp, labour_cost)
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
    
    # Compute anchor_node_id for all edges (furthest upstream START node)
    from msmdc import compute_all_anchor_nodes
    anchor_map = compute_all_anchor_nodes(graph)
    
    # Format response
    parameters = []
    stats_by_type = {}
    
    for param in all_params:
        parameters.append({
            "paramType": param.param_type,
            "paramId": param.param_id,
            "edgeUuid": getattr(param, "edge_uuid", None),
            "edgeKey": param.edge_key,
            "condition": param.condition,
            "query": param.query,
            "nQuery": getattr(param, "n_query", None),
            "stats": param.stats
        })
        
        # Count by type
        if param.param_type not in stats_by_type:
            stats_by_type[param.param_type] = 0
        stats_by_type[param.param_type] += 1
    
    return {
        "parameters": parameters,
        "anchors": anchor_map,  # Edge UUID → anchor_node_id (for cohort queries)
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
            visibility_mode=s.get('visibility_mode', 'f+e'),
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
    
    print(f"[compile_exclude] Received request with query: {query_str[:200] if query_str else 'None'}...")
    
    if not query_str:
        raise ValueError("Missing 'query' field")
    if not graph_data:
        raise ValueError("Missing 'graph' field")
    
    # Parse the query to extract from, to, and excludes
    from query_dsl import parse_query_strict
    from graph_types import Graph
    
    try:
        parsed = parse_query_strict(query_str)
        print(f"[compile_exclude] Parsed query: from={parsed.from_node}, to={parsed.to_node}, exclude={parsed.exclude}, visited={parsed.visited}")
    except Exception as e:
        print(f"[compile_exclude] Failed to parse query: {e}")
        return {
            "compiled_query": query_str,
            "was_compiled": False,
            "error": f"Query parse failed: {str(e)}",
            "success": False
        }
    
    if not parsed.exclude:
        # No excludes, return original query
        print(f"[compile_exclude] No excludes found in parsed query")
        return {
            "compiled_query": query_str,
            "was_compiled": False,
            "success": True
        }
    
    # Build graph for topology analysis
    try:
        graph = Graph.model_validate(graph_data)
        print(f"[compile_exclude] Graph validated: {len(graph.nodes)} nodes, {len(graph.edges)} edges")
    except Exception as e:
        print(f"[compile_exclude] Failed to validate graph: {e}")
        return {
            "compiled_query": query_str,
            "was_compiled": False,
            "error": f"Graph validation failed: {str(e)}",
            "success": False
        }
    
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
        from_node_match = next((n for n in graph.nodes if n.uuid == from_id or n.id == from_id), None)
        to_node_match = next((n for n in graph.nodes if n.uuid == to_id or n.id == to_id), None)
        if from_node_match and to_node_match:
            from_node_id = from_node_match.id or from_node_match.uuid
            to_node_id = to_node_match.id or to_node_match.uuid
            G.add_edge(from_node_id, to_node_id)
    
    print(f"[compile_exclude] Built networkx graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")
    
    # Get from/to nodes
    from_node = parsed.from_node
    to_node = parsed.to_node
    exclude_nodes = parsed.exclude
    
    print(f"[compile_exclude] Compiling: from={from_node}, to={to_node}, exclude={exclude_nodes}")
    
    # Check if nodes exist in graph
    missing_nodes = []
    for node_id in [from_node, to_node] + exclude_nodes:
        if node_id and node_id not in G.nodes():
            missing_nodes.append(node_id)
    
    if missing_nodes:
        print(f"[compile_exclude] WARNING: Nodes not found in graph: {missing_nodes}")
        print(f"[compile_exclude] Available nodes: {list(G.nodes())[:20]}...")  # First 20 nodes
    
    # Import the optimized inclusion-exclusion compiler
    from optimized_inclusion_exclusion import compile_optimized_inclusion_exclusion
    
    try:
        compiled_query, terms = compile_optimized_inclusion_exclusion(
            G, from_node, to_node, to_node, exclude_nodes
        )
        
        print(f"[compile_exclude] Successfully compiled: {len(terms)} terms")
        print(f"[compile_exclude] Compiled query: {compiled_query[:200]}...")
        
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
        import traceback
        print(f"[compile_exclude] Compilation failed: {e}")
        print(f"[compile_exclude] Traceback: {traceback.format_exc()}")
        return {
            "compiled_query": query_str,
            "was_compiled": False,
            "error": str(e),
            "success": False
        }


def handle_snapshots_append(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle append-snapshots endpoint.
    
    Shadow-writes time-series data to the snapshot database after successful fetches.
    
    Args:
        data: Request body containing:
            - param_id: Workspace-prefixed parameter ID (required)
            - core_hash: Query signature hash (required)
            - context_def_hashes: Dict of context def hashes (optional)
            - slice_key: Context slice DSL or '' (required)
            - retrieved_at: ISO timestamp string (required)
            - rows: List of daily data points (required)
            - diagnostic: bool (optional) - if true, return detailed diagnostic info
    
    Returns:
        Response dict with:
            - success: bool
            - inserted: int
            - diagnostic: dict (only if diagnostic=true in request)
    """
    from datetime import datetime
    import json
    from snapshot_service import append_snapshots
    
    param_id = data.get('param_id')
    core_hash = data.get('core_hash')
    context_def_hashes = data.get('context_def_hashes')
    slice_key = data.get('slice_key', '')
    retrieved_at_str = data.get('retrieved_at')
    rows = data.get('rows', [])
    diagnostic = data.get('diagnostic', False)
    
    if not param_id:
        raise ValueError("Missing 'param_id' field")
    if not core_hash:
        raise ValueError("Missing 'core_hash' field")
    if not retrieved_at_str:
        raise ValueError("Missing 'retrieved_at' field")
    
    # Parse ISO timestamp
    retrieved_at = datetime.fromisoformat(retrieved_at_str.replace('Z', '+00:00'))
    
    # Convert context_def_hashes dict to JSON string if provided
    context_def_hashes_json = json.dumps(context_def_hashes) if context_def_hashes else None
    
    result = append_snapshots(
        param_id=param_id,
        core_hash=core_hash,
        context_def_hashes=context_def_hashes_json,
        slice_key=slice_key,
        retrieved_at=retrieved_at,
        rows=rows,
        diagnostic=diagnostic
    )
    
    return result


def handle_snapshots_health(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle snapshots health check endpoint.
    
    Returns database connectivity status for feature flag decisions.
    """
    from snapshot_service import health_check
    return health_check()


def handle_snapshots_query(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle snapshots query endpoint.
    
    Query snapshots from the database for a given param_id.
    Used for integration testing verification.
    
    Args:
        data: Request body containing:
            - param_id: Parameter ID to query (required)
    
    Returns:
        Response dict with rows
    """
    from snapshot_service import get_db_connection
    
    param_id = data.get('param_id')
    if not param_id:
        raise ValueError("Missing 'param_id' field")
    
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT param_id, core_hash, slice_key, anchor_day, retrieved_at,
                   A as a, X as x, Y as y, 
                   median_lag_days, mean_lag_days,
                   anchor_median_lag_days, anchor_mean_lag_days,
                   onset_delta_days
            FROM snapshots
            WHERE param_id = %s
            ORDER BY anchor_day, slice_key
        """, (param_id,))
        columns = [desc[0] for desc in cur.description]
        rows = [dict(zip(columns, row)) for row in cur.fetchall()]
        return {
            'success': True,
            'rows': rows,
            'count': len(rows)
        }
    finally:
        conn.close()


def handle_snapshots_delete_test(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle delete-test-snapshots endpoint.
    
    Delete test data from the snapshot database by param_id prefix.
    ONLY for integration testing cleanup - requires prefix starting with 'pytest-'.
    
    Args:
        data: Request body containing:
            - param_id_prefix: Prefix to match for deletion (required, must start with 'pytest-')
    
    Returns:
        Response dict with deleted count
    """
    from snapshot_service import get_db_connection
    
    prefix = data.get('param_id_prefix')
    if not prefix:
        raise ValueError("Missing 'param_id_prefix' field")
    
    # Safety: only allow deletion of test data
    if not prefix.startswith('pytest-'):
        raise ValueError("param_id_prefix must start with 'pytest-' for safety")
    
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM snapshots WHERE param_id LIKE %s", (f'{prefix}%',))
        deleted = cur.rowcount
        conn.commit()
        return {
            'success': True,
            'deleted': deleted
        }
    finally:
        conn.close()
