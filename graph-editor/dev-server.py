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

# Load .env.local (same env vars Vite reads — DB_CONNECTION, BAYES_WEBHOOK_SECRET, etc.)
_env_local = os.path.join(os.path.dirname(__file__), '.env.local')
if os.path.isfile(_env_local):
    with open(_env_local) as _f:
        for _line in _f:
            _line = _line.strip()
            if not _line or _line.startswith('#'):
                continue
            _eq = _line.find('=')
            if _eq < 0:
                continue
            _key, _val = _line[:_eq], _line[_eq + 1:]
            if _key not in os.environ:  # don't override explicit env
                os.environ[_key] = _val

# Add lib/ to Python path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'lib'))

# Read configuration from environment
#
# NOTE (E2E + local dev):
# - Vite dev commonly runs on 5173.
# - Our Playwright E2E dev server runs on 4173 (`npm run dev:e2e`).
# If `ALLOWED_ORIGINS` is not explicitly set, include both ports to avoid
# spurious CORS failures when the frontend origin differs from VITE_PORT.
FRONTEND_PORT = os.environ.get("VITE_PORT", "5173")
allowed_origins_env = os.environ.get("ALLOWED_ORIGINS")
if allowed_origins_env:
    ALLOWED_ORIGINS = allowed_origins_env.split(",")
else:
    ports = {str(FRONTEND_PORT), "5173", "4173"}
    ALLOWED_ORIGINS = []
    for p in sorted(ports):
        ALLOWED_ORIGINS.append(f"http://localhost:{p}")
        ALLOWED_ORIGINS.append(f"http://127.0.0.1:{p}")

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


# Snapshot DB health check
@app.get("/api/snapshots/health")
def snapshots_health():
    """Test connection to snapshot DB using DB_CONNECTION env var."""
    from api_handlers import handle_snapshots_health
    return handle_snapshots_health({})


# Snapshot DB query endpoint (for integration tests)
@app.post("/api/snapshots/query")
async def snapshots_query(request: Request):
    """Query snapshots from DB for verification."""
    try:
        data = await request.json()
        from api_handlers import handle_snapshots_query
        return handle_snapshots_query(data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        print(f"[snapshots/query] Error: {e}")
        print(f"[snapshots/query] Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


# Snapshot DB delete-test endpoint (for integration test cleanup)
@app.post("/api/snapshots/delete-test")
async def snapshots_delete_test(request: Request):
    """Delete test data from DB (only pytest-* prefixed param_ids)."""
    try:
        data = await request.json()
        from api_handlers import handle_snapshots_delete_test
        return handle_snapshots_delete_test(data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        print(f"[snapshots/delete-test] Error: {e}")
        print(f"[snapshots/delete-test] Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


# Snapshot inventory endpoint (batch query for UI)
@app.post("/api/snapshots/inventory")
async def snapshots_inventory(request: Request):
    """Get snapshot inventory for multiple parameters."""
    try:
        data = await request.json()
        from api_handlers import handle_snapshots_inventory
        return handle_snapshots_inventory(data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        print(f"[snapshots/inventory] Error: {e}")
        print(f"[snapshots/inventory] Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


# Snapshot batch retrieval days (aggregate as-at calendar)
@app.post("/api/snapshots/batch-retrieval-days")
async def snapshots_batch_retrieval_days(request: Request):
    """Get distinct retrieved_day per param_id in a single query."""
    try:
        data = await request.json()
        from api_handlers import handle_snapshots_batch_retrieval_days
        return handle_snapshots_batch_retrieval_days(data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        print(f"[snapshots/batch-retrieval-days] Error: {e}")
        print(f"[snapshots/batch-retrieval-days] Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


# Snapshot batch anchor coverage (Retrieve All DB preflight)
@app.post("/api/snapshots/batch-anchor-coverage")
async def snapshots_batch_anchor_coverage(request: Request):
    """Compute missing anchor-day ranges per subject for Retrieve All preflight."""
    try:
        data = await request.json()
        from api_handlers import handle_snapshots_batch_anchor_coverage
        return handle_snapshots_batch_anchor_coverage(data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        print(f"[snapshots/batch-anchor-coverage] Error: {e}")
        print(f"[snapshots/batch-anchor-coverage] Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


# Snapshot retrievals endpoint (Phase 2 @ UI)
@app.post("/api/snapshots/retrievals")
async def snapshots_retrievals(request: Request):
    """Get distinct snapshot retrieval timestamps for a parameter."""
    try:
        data = await request.json()
        from api_handlers import handle_snapshots_retrievals
        return handle_snapshots_retrievals(data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        print(f"[snapshots/retrievals] Error: {e}")
        print(f"[snapshots/retrievals] Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


# Snapshot delete endpoint (for "Delete snapshots (X)" UI)
@app.post("/api/snapshots/delete")
async def snapshots_delete(request: Request):
    """Delete all snapshots for a specific parameter."""
    try:
        data = await request.json()
        from api_handlers import handle_snapshots_delete
        return handle_snapshots_delete(data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        print(f"[snapshots/delete] Error: {e}")
        print(f"[snapshots/delete] Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


# Snapshot full query endpoint (for analytics)
@app.post("/api/snapshots/query-full")
async def snapshots_query_full(request: Request):
    """Query snapshots with full filtering support."""
    try:
        data = await request.json()
        from api_handlers import handle_snapshots_query_full
        return handle_snapshots_query_full(data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        print(f"[snapshots/query-full] Error: {e}")
        print(f"[snapshots/query-full] Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


# Virtual snapshot query endpoint (for asat() DSL)
@app.post("/api/snapshots/query-virtual")
async def snapshots_query_virtual(request: Request):
    """Query virtual snapshot: latest-per-anchor_day as-of a timestamp."""
    try:
        data = await request.json()
        from api_handlers import handle_snapshots_query_virtual
        return handle_snapshots_query_virtual(data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        print(f"[snapshots/query-virtual] Error: {e}")
        print(f"[snapshots/query-virtual] Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


# Snapshot DB append endpoint
@app.post("/api/snapshots/append")
async def snapshots_append(request: Request):
    """
    Append snapshot rows to the database.
    
    Shadow-writes time-series data after successful fetches.
    
    Request: {
        "param_id": "repo-branch-param-id",
        "core_hash": "abc123",
        "context_def_hashes": {"channel": "def456"},  // optional
        "slice_key": "context(channel:google)",       // or '' for uncontexted
        "retrieved_at": "2025-12-10T12:00:00Z",
        "rows": [
            {"anchor_day": "2025-12-01", "X": 100, "Y": 15, "median_lag_days": 5.2},
            ...
        ]
    }
    
    Response: {"success": true, "inserted": 14}
    """
    try:
        data = await request.json()
        from api_handlers import handle_snapshots_append
        return handle_snapshots_append(data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        print(f"[snapshots/append] Error: {e}")
        print(f"[snapshots/append] Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# Flexible signatures: Signature Links UI routes
# =============================================================================


@app.post("/api/sigs/list")
async def sigs_list(request: Request):
    try:
        data = await request.json()
        from api_handlers import handle_sigs_list
        return handle_sigs_list(data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        print(f"[sigs/list] Error: {e}")
        print(f"[sigs/list] Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/sigs/get")
async def sigs_get(request: Request):
    try:
        data = await request.json()
        from api_handlers import handle_sigs_get
        return handle_sigs_get(data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        print(f"[sigs/get] Error: {e}")
        print(f"[sigs/get] Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))



# REMOVED: /api/sigs/links/list, /api/sigs/links/create,
# /api/sigs/links/deactivate, /api/sigs/resolve
# Equivalence is now FE-owned via hash-mappings.json.

@app.post("/api/lag/recompute-models")
async def lag_recompute_models(request: Request):
    try:
        data = await request.json()
        from api_handlers import handle_lag_recompute_models
        return handle_lag_recompute_models(data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        print(f"[lag/recompute-models] Error: {e}")
        print(f"[lag/recompute-models] Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


# Back-compat alias: older route used hyphen (no /lag prefix).
@app.post("/api/lag-recompute-models")
async def lag_recompute_models_alias(request: Request):
    try:
        data = await request.json()
        from api_handlers import handle_lag_recompute_models
        return handle_lag_recompute_models(data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        print(f"[lag-recompute-models] Error: {e}")
        print(f"[lag-recompute-models] Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/lag/topo-pass")
async def lag_topo_pass(request: Request):
    try:
        data = await request.json()
        from api_handlers import handle_stats_topo_pass
        return handle_stats_topo_pass(data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        print(f"[lag/topo-pass] Error: {e}")
        print(f"[lag/topo-pass] Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


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
        from query_dsl import parse_query_strict, validate_query
        
        # Validate (require endpoints for data retrieval)
        is_valid, error = validate_query(query_str, require_endpoints=True)
        if not is_valid:
            raise HTTPException(status_code=400, detail=f"Invalid query: {error}")
        
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


# Import shared handlers (used by both dev-server and python-api.py)
from api_handlers import handle_generate_all_parameters, handle_stats_enhance, handle_compile_exclude


# Consolidated Python API endpoint (matches production python-api.py structure)
# Routes both /api/python-api and the original paths for consistency
@app.post("/api/python-api")
@app.post("/api/generate-all-parameters")
@app.post("/api/stats-enhance")
async def python_api_endpoint(request: Request):
    """
    Consolidated Python API router (matches production structure).
    
    Routes to:
    - /api/generate-all-parameters -> handle_generate_all_parameters
    - /api/stats-enhance -> handle_stats_enhance
    """
    try:
        body = await request.json()
        path = request.url.path.split('?')[0]  # Remove query params
        
        if path == '/api/generate-all-parameters':
            return handle_generate_all_parameters(body)
        elif path == '/api/stats-enhance':
            return handle_stats_enhance(body)
        else:
            raise HTTPException(status_code=404, detail=f"Unknown endpoint: {path}")
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Compile exclude query to minus/plus form for providers that don't support native excludes
@app.post("/api/compile-exclude")
async def compile_exclude_endpoint(request: Request):
    """
    Compile a query with excludes() to minus/plus form.
    
    For providers like Amplitude that don't support native excludes, this endpoint
    compiles the query into inclusion-exclusion form (minus/plus terms).
    
    Request:
    {
        "query": "from(A).to(B).excludes(C)",
        "graph": { nodes: [], edges: [] }
    }
    
    Response:
    {
        "compiled_query": "from(A).to(B).minus(C)",
        "was_compiled": true,
        "success": true
    }
    """
    try:
        body = await request.json()
        return handle_compile_exclude(body)
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        print(f"[compile-exclude] Error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# Analytics runner endpoint
@app.post("/api/runner/analyze")
async def runner_analyze_endpoint(request: Request):
    """
    Run analytics on a graph selection.
    
    Request:
    {
        "scenarios": [
            {
                "scenario_id": "base",
                "graph": { nodes: [], edges: [], ... }
            }
        ],
        "query_dsl": "from(node1).to(node2)"  // determines what to analyze
    }
    
    Response:
    {
        "success": true,
        "results": [
            {
                "scenario_id": "base",
                "analysis_type": "path",
                "analysis_name": "Path Between Nodes",
                "data": { probability: 0.8, ... }
            }
        ]
    }
    """
    try:
        data = await request.json()
        
        # Delegate to the centralised handler (api_handlers.py) which correctly
        # routes snapshot-based analysis vs standard analysis.
        # DO NOT duplicate the routing logic here — see .cursorrules §2.
        from api_handlers import handle_runner_analyze
        response = handle_runner_analyze(data)
        return response
        
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Get available analysis types for a DSL query
@app.post("/api/runner/available-analyses")
async def runner_available_analyses_endpoint(request: Request):
    """
    Get available analysis types for a DSL query.
    
    Request:
    {
        "graph": { nodes: [], edges: [], ... },
        "query_dsl": "from(node1).to(node2)",
        "scenario_count": 1
    }
    
    Response:
    {
        "analyses": [
            { "id": "path", "name": "Path Between Nodes", "is_primary": true }
        ]
    }
    """
    try:
        data = await request.json()
        
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
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# Bayes local dev routes — mirrors Modal's submit/status endpoints
# =============================================================================


@app.post("/api/bayes/submit")
async def bayes_submit_endpoint(request: Request):
    """Local equivalent of Modal's /submit endpoint.
    Spawns fit_graph in a background thread, returns job_id immediately.

    Set BAYES_PLACEHOLDER=1 to skip MCMC and return shifted placeholder
    posteriors (used by E2E roundtrip tests).
    """
    try:
        data = await request.json()

        # Inject placeholder mode when env var is set (E2E testing)
        if os.environ.get("BAYES_PLACEHOLDER") == "1":
            settings = data.get("settings") or {}
            settings["placeholder"] = True
            data["settings"] = settings

        from bayes_local import submit
        job_id = submit(data)
        mode = "placeholder" if (data.get("settings") or {}).get("placeholder") else "compiler"
        print(f"[bayes/submit] Spawned local job {job_id} ({mode}) for graph={data.get('graph_id', '?')}")
        return {"job_id": job_id}
    except Exception as e:
        import traceback
        print(f"[bayes/submit] Error: {e}")
        print(f"[bayes/submit] Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/bayes/cancel")
async def bayes_cancel_endpoint(call_id: str = ""):
    """Local equivalent of Modal's /cancel endpoint.
    Marks the local job as cancelled so the FE stops polling."""
    if not call_id:
        return {"status": "error", "error": "call_id parameter required"}
    from bayes_local import cancel
    result = cancel(call_id)
    print(f"[bayes/cancel] Job {call_id}: {result['status']}")
    return result


@app.get("/api/bayes/config")
async def bayes_config_endpoint():
    """Equivalent of the Vercel /api/bayes/config endpoint.
    Reads from same env vars as Vercel. Falls back to local URLs only
    when Modal env vars aren't set."""
    webhook_secret = os.environ.get("BAYES_WEBHOOK_SECRET", "")
    db_connection = os.environ.get("DB_CONNECTION", "")
    if not webhook_secret:
        raise HTTPException(status_code=500, detail="BAYES_WEBHOOK_SECRET not set in env")

    # Modal URLs from env (same vars as Vercel). If not set, fall back to local.
    port = os.environ.get("PYTHON_API_PORT", "9000")
    vite_port = os.environ.get("VITE_PORT", "5173")

    # Webhook URL: in local dev, ALWAYS use localhost (the Vite dev server serves
    # the webhook endpoint). The .env.local BAYES_WEBHOOK_URL points to production
    # Vercel which is wrong for local dev. Only use the env var in production.
    webhook_url = f"http://localhost:{vite_port}/api/bayes-webhook"

    return {
        "modal_submit_url": os.environ.get("BAYES_MODAL_SUBMIT_URL", f"http://localhost:{port}/api/bayes/submit"),
        "modal_status_url": os.environ.get("BAYES_MODAL_STATUS_URL", f"http://localhost:{port}/api/bayes/status"),
        "modal_cancel_url": os.environ.get("BAYES_MODAL_CANCEL_URL", f"http://localhost:{port}/api/bayes/cancel"),
        "webhook_url": webhook_url,
        "webhook_secret": webhook_secret,
        "db_connection": db_connection,
    }


@app.get("/api/bayes/version")
async def bayes_version_endpoint():
    """Local equivalent of Modal's /version endpoint."""
    return {"version": "local-dev"}


@app.get("/api/bayes/status")
async def bayes_status_endpoint(call_id: str = ""):
    """Local equivalent of Modal's /status endpoint.
    Polls job result from in-memory store."""
    if not call_id:
        return {"status": "error", "error": "call_id parameter required"}
    from bayes_local import get_status
    result = get_status(call_id)
    if result['status'] == 'complete':
        print(f"[bayes/status] Job {call_id} complete")
    elif result['status'] == 'failed':
        print(f"[bayes/status] Job {call_id} failed: {result.get('error')}")
    return result


# =============================================================================
# Cloudflared tunnel management — allows Modal to call back to local webhook
# =============================================================================

import subprocess
import threading
import re

_tunnel_process: subprocess.Popen | None = None
_tunnel_url: str | None = None
_tunnel_lock = threading.Lock()


def _read_tunnel_url(proc: subprocess.Popen) -> None:
    """Background thread: read cloudflared stderr until we find the tunnel URL."""
    global _tunnel_url
    assert proc.stderr is not None
    for raw_line in proc.stderr:
        line = raw_line.decode("utf-8", errors="replace")
        # cloudflared prints the URL in a table row like:
        #   INF |  https://xxx.trycloudflare.com  |
        match = re.search(r"(https://[^\s|]+\.trycloudflare\.com)", line)
        if match:
            with _tunnel_lock:
                _tunnel_url = match.group(1)
            print(f"[tunnel] URL ready: {_tunnel_url}")
            break
    # Keep draining stderr so the subprocess doesn't block
    for _ in proc.stderr:
        pass


@app.post("/api/bayes/tunnel/start")
async def tunnel_start():
    """Spawn a cloudflared quick-tunnel proxying to the Vite dev server."""
    global _tunnel_process, _tunnel_url

    with _tunnel_lock:
        if _tunnel_process is not None and _tunnel_process.poll() is None:
            # Already running
            return {"tunnel_url": _tunnel_url, "already_running": True}

    target = f"http://localhost:{FRONTEND_PORT}"
    print(f"[tunnel] Starting cloudflared tunnel --url {target}")

    proc = subprocess.Popen(
        ["cloudflared", "tunnel", "--url", target],
        stderr=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
    )

    with _tunnel_lock:
        _tunnel_process = proc
        _tunnel_url = None

    reader = threading.Thread(target=_read_tunnel_url, args=(proc,), daemon=True)
    reader.start()

    # Wait up to 15 s for the URL to appear
    import time
    for _ in range(150):
        time.sleep(0.1)
        with _tunnel_lock:
            if _tunnel_url is not None:
                return {"tunnel_url": _tunnel_url}

    return {"tunnel_url": None, "error": "Timed out waiting for cloudflared URL"}


@app.post("/api/bayes/tunnel/stop")
async def tunnel_stop():
    """Kill the running cloudflared subprocess."""
    global _tunnel_process, _tunnel_url

    with _tunnel_lock:
        proc = _tunnel_process
        _tunnel_process = None
        _tunnel_url = None

    if proc is None:
        return {"stopped": True, "was_running": False}

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=2)

    print("[tunnel] Stopped cloudflared tunnel")
    return {"stopped": True, "was_running": True}


@app.get("/api/bayes/tunnel/status")
async def tunnel_status():
    """Return current tunnel URL (or null if not running)."""
    with _tunnel_lock:
        url = _tunnel_url
        running = _tunnel_process is not None and _tunnel_process.poll() is None
    return {"tunnel_url": url, "running": running}


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
    print("  GET  /                            - Health check")
    print("  POST /api/parse-query             - Parse DSL query string")
    print("  POST /api/query-graph             - Apply query to graph (topology filter)")
    print("  POST /api/generate-query          - Generate MSMDC query for single edge")
    print("  POST /api/generate-all-queries    - Batch MSMDC for all edges (base only)")
    print("  POST /api/generate-all-parameters - All params (p, cond_p, costs, cases)")
    print("  POST /api/stats-enhance           - Statistical enhancement")
    print("  POST /api/runner/analyze          - Run analytics on selection")
    print("  POST /api/runner/available-analyses - Get available analyses")
    print("  POST /api/bayes/submit            - Local Bayes submit (async)")
    print("  POST /api/bayes/cancel            - Cancel a running Bayes job")
    print("  GET  /api/bayes/status             - Local Bayes poll")
    print("  POST /api/bayes/tunnel/start       - Start cloudflared tunnel")
    print("  POST /api/bayes/tunnel/stop        - Stop cloudflared tunnel")
    print("  GET  /api/bayes/tunnel/status      - Tunnel URL status")
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


