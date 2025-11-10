#!/usr/bin/env python3
"""
dev-server.py - Local development server for Python graph functions.

This simulates Vercel's serverless Python functions for local development.
Run: python dev-server.py
"""
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import sys
import os

# Add lib/ to Python path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'lib'))

# Read configuration from environment
FRONTEND_PORT = os.environ.get("VITE_PORT", "5173")
ALLOWED_ORIGINS = os.environ.get(
    "ALLOWED_ORIGINS",
    f"http://localhost:{FRONTEND_PORT},http://127.0.0.1:{FRONTEND_PORT}"
).split(",")

app = FastAPI(
    title="DagNet Graph Compute (Local Dev)",
    version="1.0.0",
    description="Local development server for Python graph functions"
)

# CORS configuration from environment
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Health check
@app.get("/")
@app.get("/api")
def health():
    return {
        "status": "ok",
        "service": "dagnet-graph-compute",
        "env": "local"
    }


# Simple roundtrip test endpoint: Parse DSL query string
@app.post("/api/parse-query")
async def parse_query_endpoint(request: Request):
    """
    Parse a query DSL string and return structured result.
    
    Test endpoint to verify TS -> Python -> TS roundtrip works.
    
    Request: { "query": "from(a).to(b).visited(c)" }
    Response: { "parsed": {...}, "valid": true }
    """
    try:
        data = await request.json()
        query_str = data.get('query')
        
        if not query_str:
            raise HTTPException(status_code=400, detail="Missing 'query' field")
        
        # Import and parse
        from query_dsl import parse_query, validate_query
        
        # Validate
        is_valid, error = validate_query(query_str)
        if not is_valid:
            raise HTTPException(status_code=400, detail=f"Invalid query: {error}")
        
        # Parse
        parsed = parse_query(query_str)
        
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
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/query-graph")
async def query_graph_endpoint(request: Request):
    """
    Apply a DSL query to a graph and return the filtered subgraph.
    
    Request: { "graph": {...}, "query": "from(a).to(b)" }
    Response: { "graph": {...}, "metadata": {...} }
    """
    try:
        data = await request.json()
        graph = data.get('graph')
        query_str = data.get('query')
        
        if not graph:
            raise HTTPException(status_code=400, detail="Missing 'graph' field")
        if not query_str:
            raise HTTPException(status_code=400, detail="Missing 'query' field")
        
        # Import and apply query
        from graph_select import apply_query_to_graph
        
        result = apply_query_to_graph(graph, query_str)
        
        return {
            "graph": result,
            "success": True
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/generate-query")
async def generate_query_endpoint(request: Request):
    """
    Generate optimal data retrieval query for an edge using MSMDC.
    
    This is for DATA RETRIEVAL (Amplitude, etc.), not topology filtering.
    Returns minimal discriminating query string for external API calls.
    """
    try:
        body = await request.json()
        graph_data = body.get("graph")
        edge_data = body.get("edge")
        condition = body.get("condition")  # Optional constraint-only string
        max_checks = body.get("maxChecks", 200)
        literal_weights = body.get("literalWeights")  # Optional: {"visited":1, "exclude":10}
        preserve_condition = body.get("preserveCondition", True)
        preserve_case_context = body.get("preserveCaseContext", True)
        
        if not graph_data or not edge_data:
            raise HTTPException(status_code=400, detail="Missing 'graph' or 'edge' field")
        
        # Import and run MSMDC
        import sys
        sys.path.insert(0, "lib")
        from msmdc import generate_query_for_edge
        from graph_types import Graph, Edge
        
        # Parse graph and edge
        graph = Graph.model_validate(graph_data)
        edge = Edge.model_validate(edge_data)
        
        result = generate_query_for_edge(
            graph=graph,
            edge=edge,
            condition=condition,
            max_checks=max_checks,
            literal_weights=literal_weights,
            preserve_condition=preserve_condition,
            preserve_case_context=preserve_case_context
        )
        
        return {
            "query": result.query_string,
            "stats": result.coverage_stats,
            "satisfying": result.satisfying_found,
            "success": True
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/generate-all-queries")
async def generate_all_queries_endpoint(request: Request):
    """
    Generate queries for ALL edges in a graph (batch MSMDC).
    
    Performance optimization: Send graph once, get all queries back.
    """
    try:
        body = await request.json()
        graph_data = body.get("graph")
        max_checks = body.get("maxChecks", 200)
        literal_weights = body.get("literalWeights")
        preserve_condition = body.get("preserveCondition", True)
        preserve_case_context = body.get("preserveCaseContext", True)
        
        if not graph_data:
            raise HTTPException(status_code=400, detail="Missing 'graph' field")
        
        import sys
        sys.path.insert(0, "lib")
        from msmdc import generate_query_for_edge
        from graph_types import Graph
        
        graph = Graph.model_validate(graph_data)
        
        # Generate query for each edge and its conditional_p (if any)
        results = {}
        for edge in graph.edges:
            edge_key = f"{edge.from_node}->{edge.to}"
            results[edge_key] = {"base": None, "conditionals": []}
            # Base (no condition)
            try:
                base = generate_query_for_edge(graph=graph, edge=edge, condition=None, max_checks=max_checks, literal_weights=literal_weights, preserve_condition=preserve_condition, preserve_case_context=preserve_case_context)
                results[edge_key]["base"] = {
                    "query": base.query_string,
                    "stats": base.coverage_stats,
                    "satisfying": base.satisfying_found
                }
            except Exception as e:
                results[edge_key]["base"] = {"query": None, "error": str(e)}
            # Conditionals
            if getattr(edge, "conditional_p", None):
                for cond in (edge.conditional_p or []):
                    cond_str = getattr(cond, "condition", None)
                    try:
                        cond_res = generate_query_for_edge(graph=graph, edge=edge, condition=cond_str, max_checks=max_checks, literal_weights=literal_weights, preserve_condition=preserve_condition, preserve_case_context=preserve_case_context)
                        results[edge_key]["conditionals"].append({
                            "condition": cond_str,
                            "query": cond_res.query_string,
                            "stats": cond_res.coverage_stats,
                            "satisfying": cond_res.satisfying_found
                        })
                    except Exception as e:
                        results[edge_key]["conditionals"].append({
                            "condition": cond_str,
                            "query": None,
                            "error": str(e)
                        })
        
        return {
            "queries": results,
            "success": True
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/generate-all-parameters")
async def generate_all_parameters_endpoint(request: Request):
    """
    Generate queries for ALL parameters in a graph (comprehensive MSMDC).
    
    Covers:
    - Edge base probabilities (edge.p)
    - Edge conditional probabilities (edge.conditional_p[])
    - Edge costs (cost_gbp, cost_time)
    - Case node variants (node.case.variants[])
    
    Performance optimizations:
    - downstreamOf: Only regenerate params for edges downstream of specified node
    - paramTypes: Filter to specific parameter types only
    
    This is the complete "batch MSMDC for entire system" endpoint.
    """
    try:
        body = await request.json()
        graph_data = body.get("graph")
        param_types = body.get("paramTypes")  # Optional: filter by type
        downstream_of = body.get("downstreamOf")  # Optional: incremental updates
        max_checks = body.get("maxChecks", 200)
        literal_weights = body.get("literalWeights")
        preserve_condition = body.get("preserveCondition", True)
        preserve_case_context = body.get("preserveCaseContext", True)
        
        if not graph_data:
            raise HTTPException(status_code=400, detail="Missing 'graph' field")
        
        import sys
        sys.path.insert(0, "lib")
        from msmdc import generate_all_parameter_queries, generate_queries_by_type
        from graph_types import Graph
        
        graph = Graph.model_validate(graph_data)
        
        # Generate all parameters or filter by type/downstream
        if param_types:
            params_by_type = generate_queries_by_type(
                graph, param_types, max_checks, downstream_of, literal_weights, preserve_condition, preserve_case_context
            )
            all_params = []
            for ptype, params in params_by_type.items():
                all_params.extend(params)
        else:
            all_params = generate_all_parameter_queries(graph, max_checks, downstream_of, literal_weights, preserve_condition, preserve_case_context)
        
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
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/stats-enhance")
async def stats_enhance_endpoint(request: Request):
    """
    Enhance raw aggregation with statistical methods (MCMC, Bayesian, trend-aware, robust).
    
    Heavy computations that benefit from NumPy/SciPy are handled here.
    Lightweight operations (inverse-variance weighting) are handled in TypeScript.
    
    Request: {
        "raw": {
            "method": "naive",
            "n": 1000,
            "k": 600,
            "mean": 0.6,
            "stdev": 0.015,
            "raw_data": [{"date": "2025-11-03", "n": 100, "k": 60, "p": 0.6}, ...],
            "window": {"start": "2025-11-03", "end": "2025-11-10"},
            "days_included": 8,
            "days_missing": 0
        },
        "method": "mcmc" | "bayesian-complex" | "trend-aware" | "robust"
    }
    
    Response: EnhancedAggregation with enhanced mean, stdev, confidence_interval, trend
    """
    try:
        body = await request.json()
        raw_data = body.get("raw")
        method = body.get("method")
        
        if not raw_data:
            raise HTTPException(status_code=400, detail="Missing 'raw' field")
        if not method:
            raise HTTPException(status_code=400, detail="Missing 'method' field")
        
        # Import and enhance
        from stats_enhancement import enhance_aggregation
        
        enhanced = enhance_aggregation(raw_data, method)
        
        return {
            **enhanced,
            "success": True
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    import os
    
    # Read port from environment variable, default to 9000
    port = int(os.environ.get("PYTHON_API_PORT", "9000"))
    
    print("")
    print("🚀 DagNet Python Graph Compute Server")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"📍 Server:     http://localhost:{port}")
    print(f"📖 API Docs:   http://localhost:{port}/docs")
    print("🔄 Auto-reload enabled")
    print("")
    print("Available endpoints:")
    print("  GET  /                          - Health check")
    print("  POST /api/parse-query           - Parse DSL query string")
    print("  POST /api/query-graph           - Apply query to graph (topology filter)")
    print("  POST /api/generate-query        - Generate MSMDC query for single edge")
    print("  POST /api/generate-all-queries  - Batch MSMDC for all edges (base only)")
    print("  POST /api/generate-all-parameters - COMPREHENSIVE: All params (p, cond_p, costs, cases)")
    print("  POST /api/stats-enhance         - Statistical enhancement (MCMC, Bayesian, trend-aware, robust)")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"💡 Port: {port} (set via PYTHON_API_PORT env var)")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print("")
    
    uvicorn.run(
        "dev-server:app",
        host="0.0.0.0",
        port=port,
        reload=True,
        log_level="info"
    )
