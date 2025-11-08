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

app = FastAPI(
    title="DagNet Graph Compute (Local Dev)",
    version="1.0.0",
    description="Local development server for Python graph functions"
)

# CORS for local frontend (graph-editor on port 5173)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173"
    ],
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
                "cases": [{"case_id": c.case_id, "variant": c.variant} for c in parsed.cases]
            },
            "valid": True,
            "reconstructed": parsed.raw
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
    print("  GET  /           - Health check")
    print("  POST /api/parse-query - Parse DSL query (test endpoint)")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"💡 Port: {port} (set via PYTHON_API_PORT env var)")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print("")
    
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=port,
        reload=True,
        log_level="info"
    )
