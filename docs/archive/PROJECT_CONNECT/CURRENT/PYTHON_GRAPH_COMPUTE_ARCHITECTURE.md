# Python Graph Compute Architecture

## Overview

Implement graph computation functions (MSMDC, mutations, pruning, analytics) in Python rather than TypeScript for:
- Better mathematical/graph library ecosystem
- Easier inspection and debugging
- More familiar environment for graph algorithms
- Cleaner separation of concerns (UI in TS, compute in Python)

## Key Architectural Decisions

1. **Unified `/api` Directory**: Mix Python and TypeScript serverless functions in one directory
   - ✅ Standard Vercel pattern, zero custom routing
   - ✅ Simpler deployment and developer experience
   
2. **Region Co-location (CRITICAL)**: Deploy all functions to same region
   - ✅ TypeScript and Python functions in same datacenter
   - ✅ Minimizes latency: ~1-5ms same region vs ~50-400ms cross-region
   - ⚠️ Configured via `vercel.json` `regions` and `functions.*.regions`
   
3. **Local Development**: FastAPI dev server at `:9000`, frontend at `:5173`
   - ✅ Same API paths as production
   - ✅ Auto-reload and FastAPI docs
   - ✅ Full Python debugging capabilities

---

## Architecture: Unified `/api` Directory

**Structure:**
```
dagnet/
├── api/                      # Mixed TS + Python serverless functions
│   ├── health.ts            # TypeScript endpoint (existing)
│   ├── [...other TS].ts     # Other existing TS endpoints
│   │
│   ├── msmdc.py             # NEW: Python endpoint
│   ├── mutations.py         # NEW: Python endpoint
│   ├── pruning.py           # NEW: Python endpoint
│   └── analytics.py         # NEW: Python endpoint
│
├── lib/                      # NEW: Shared Python libraries
│   ├── __init__.py
│   ├── graph_core.py        # Core graph structures
│   ├── msmdc_algo.py        # MSMDC implementation
│   ├── mutations.py         # Mutation logic
│   └── analytics.py         # Analytics logic
│
├── tests/                    # NEW: Python tests
│   ├── test_msmdc.py
│   ├── test_mutations.py
│   └── fixtures/
│
├── graph-editor/             # Frontend (existing)
│   ├── src/
│   ├── package.json
│   └── vite.config.ts
│
├── requirements.txt          # NEW: Python dependencies (root level)
├── pytest.ini               # NEW: Python test config
├── dev-server.py            # NEW: Local dev server for Python
└── vercel.json              # Updated with region config
```

**Why This Approach:**
- ✅ Standard Vercel pattern - zero custom routing needed
- ✅ Automatic function detection - Vercel sees `.py` files and handles them
- ✅ Same origin - no CORS complexity
- ✅ Same region deployment - all functions co-located for minimal latency
- ✅ Simpler for developers - all API endpoints in one place

---

## Deployment Configuration

### 1. Directory Structure

**Tech Stack:**
- **FastAPI** (preferred) - Modern, async, auto-docs, type hints
  - Alternative: Flask (simpler but less features)
- **NetworkX** - Graph algorithms library
- **Pydantic** - Data validation & serialization
- **pytest** - Testing framework

**Local Development Server:**
```python
# dev-server.py (root level)
"""
Local development server to simulate Vercel Python functions.
Run: python dev-server.py
"""
from fastapi import FastAPI, Request
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
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def health():
    return {"status": "ok", "service": "dagnet-graph-compute", "env": "local"}

@app.post("/api/msmdc")
async def msmdc_endpoint(request: Request):
    data = await request.json()
    try:
        from msmdc_algo import generate_query
        query = generate_query(data['graph'], data['edge_id'], data['condition_index'])
        return {'query': query, 'explanation': f'Generated MSMDC query'}
    except Exception as e:
        return {'error': str(e)}, 500

@app.post("/api/mutations")
async def mutations_endpoint(request: Request):
    data = await request.json()
    try:
        from mutations import apply_mutation
        result = apply_mutation(data['graph'], data['mutation_type'], data.get('params', {}))
        return {'graph': result, 'success': True}
    except Exception as e:
        return {'error': str(e)}, 500

@app.post("/api/pruning")
async def pruning_endpoint(request: Request):
    data = await request.json()
    try:
        from pruning import prune_graph
        result = prune_graph(data['graph'], data.get('threshold', 0.01))
        return {'graph': result, 'pruned_edges': result.get('_metadata', {}).get('pruned', [])}
    except Exception as e:
        return {'error': str(e)}, 500

@app.post("/api/analytics")
async def analytics_endpoint(request: Request):
    data = await request.json()
    try:
        from analytics import compute_stats
        stats = compute_stats(data['graph'])
        return {'stats': stats}
    except Exception as e:
        return {'error': str(e)}, 500

if __name__ == "__main__":
    import uvicorn
    print("🚀 DagNet Python server: http://localhost:9000")
    print("📖 API docs: http://localhost:9000/docs")
    uvicorn.run(app, host="0.0.0.0", port=9000, reload=True)
```

**Quick Start (Recommended):**
```bash
# One command to start both servers in split-pane tmux:
./dev-start.sh

# With clean install (clears cache, reinstalls deps):
./dev-start.sh --clean

# To stop both servers:
./dev-stop.sh
# Or: Ctrl+C in both panes, then Ctrl+B then d to detach
```

**What it does:**
- Installs/updates npm and Python dependencies
- Starts frontend at http://localhost:5173 (left pane)
- Starts Python API at http://localhost:9000 (right pane)
- Shows both side-by-side in tmux
- Both have hot-reload enabled

**Tmux Quick Reference:**
- `Ctrl+B` then `←/→` - Switch between panes
- `Ctrl+B` then `[` - Scroll mode (press `q` to exit)
- `Ctrl+B` then `d` - Detach (servers keep running)
- `tmux attach -t dagnet` - Reattach to session
- `Ctrl+C` in both panes - Stop servers

**Manual Setup (if not using dev-start.sh):**
```bash
# Terminal 1: Python backend
python -m venv venv
source venv/bin/activate  # or: venv\Scripts\activate on Windows
pip install fastapi uvicorn[standard] networkx pydantic pytest
python dev-server.py
# → http://localhost:9000 (with auto-reload)
# → http://localhost:9000/docs (FastAPI auto-generated docs)

# Terminal 2: TypeScript frontend
cd graph-editor
npm install
npm run dev
# → http://localhost:5173
```

**Region Co-location Note:**
- Local dev: Python on `:9000`, frontend on `:5173` (same machine, ~1ms latency)
- Production: Both in same Vercel region (same datacenter, ~1-2ms latency)
- **Critical:** Never split Python and TypeScript functions across regions in production

#### Development Workflow
```json
// Add to package.json scripts:
{
  "scripts": {
    "dev": "vite",
    "dev:full": "concurrently \"npm run dev\" \"npm run dev:python\"",
    "dev:python": "cd ../graph-compute && python server.py"
  }
}
```

---

### Vercel Configuration

**Minimal Config with Region Optimization:**

```json
// vercel.json
{
  "version": 2,
  "builds": [
    {
      "src": "graph-editor/package.json",
      "use": "@vercel/static-build",
      "config": { "distDir": "dist" }
    }
  ],
  "functions": {
    "api/**/*.py": {
      "runtime": "python3.9",
      "maxDuration": 10,
      "memory": 1024,
      "regions": ["iad1"]
    },
    "api/**/*.ts": {
      "runtime": "nodejs18.x",
      "maxDuration": 10,
      "memory": 1024,
      "regions": ["iad1"]
    }
  },
  "regions": ["iad1"]
}
```

**Region Configuration Explained:**

1. **`regions: ["iad1"]`** (Project-level)
   - Primary region for all functions and edge network
   - `iad1` = US East (Washington, D.C.) - good for US/Europe
   - Alternative regions:
     - `sfo1` = US West (San Francisco)
     - `lhr1` = Europe (London)
     - `hnd1` = Asia (Tokyo)

2. **Function-level region override**
   - Both Python and TypeScript functions deployed to same region
   - **Critical for latency**: TS → Python calls stay within same datacenter
   - Avoids cross-region roundtrips (~50-200ms saved per call)

3. **Memory and timeout**
   - `memory: 1024` = 1GB RAM (adequate for graph operations)
   - `maxDuration: 10` = 10 seconds max (adjust if MSMDC takes longer)
   - Can increase to `maxDuration: 60` on Pro plan if needed

**Multi-Region Strategy (Future):**

If users are global, consider:
```json
{
  "regions": ["iad1", "lhr1", "hnd1"],  // Multi-region edge cache
  "functions": {
    "api/**/*": {
      "regions": ["iad1"]  // Keep compute in one region for consistency
    }
  }
}
```

This gives:
- ✅ Global CDN for static assets
- ✅ Single compute region (no data consistency issues)
- ✅ Minimal latency for API calls within region

**Python Requirements:**
```txt
# requirements.txt (root level)
# Keep minimal for Vercel size limits (50MB uncompressed)
networkx>=3.2
pydantic>=2.0.0

# For local dev only (not needed on Vercel):
# fastapi>=0.104.0
# uvicorn[standard]>=0.24.0
```

**Python Function Format (Vercel Serverless):**
```python
# api/msmdc.py
from http.server import BaseHTTPRequestHandler
import json
from typing import Dict, Any

class handler(BaseHTTPRequestHandler):
    """
    Vercel Python serverless function for MSMDC query generation.
    """
    
    def do_POST(self):
        # Read request body
        content_length = int(self.headers['Content-Length'])
        body = self.rfile.read(content_length)
        data = json.loads(body)
        
        try:
            # Import here to reduce cold start time
            import sys
            sys.path.insert(0, '../lib')  # Add lib/ to path
            from msmdc_algo import generate_query
            
            # Extract params
            graph = data['graph']
            edge_id = data['edge_id']
            condition_index = data['condition_index']
            
            # Generate query
            query = generate_query(graph, edge_id, condition_index)
            
            # Return response
            response = {
                'query': query,
                'explanation': f'Generated MSMDC query for edge {edge_id}'
            }
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())
            
        except Exception as e:
            # Error response
            error_response = {'error': str(e)}
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(error_response).encode())
```

**Alternative: Using Pydantic for Validation:**
```python
# api/msmdc.py
from http.server import BaseHTTPRequestHandler
from pydantic import BaseModel, ValidationError
import json
import sys
sys.path.insert(0, '../lib')

class MSMDCRequest(BaseModel):
    graph: dict
    edge_id: str
    condition_index: int

class MSMDCResponse(BaseModel):
    query: str
    explanation: str

class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            # Parse and validate request
            content_length = int(self.headers['Content-Length'])
            body = self.rfile.read(content_length)
            request = MSMDCRequest(**json.loads(body))
            
            # Import and execute
            from msmdc_algo import generate_query
            query = generate_query(request.graph, request.edge_id, request.condition_index)
            
            # Validate and return response
            response = MSMDCResponse(
                query=query,
                explanation=f'Generated MSMDC query for edge {request.edge_id}'
            )
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(response.json().encode())
            
        except ValidationError as e:
            self._send_error(400, str(e))
        except Exception as e:
            self._send_error(500, str(e))
    
    def _send_error(self, code: int, message: str):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'error': message}).encode())
```

---

### 3. TypeScript → Python API Shim

**Type-Safe Client:**
```typescript
// graph-editor/src/lib/graphComputeClient.ts

/**
 * Client for Python graph compute API
 */

// Environment-aware base URL
const API_BASE_URL = import.meta.env.DEV 
  ? 'http://localhost:9000/api'  // Local Python server
  : '/api';                        // Vercel serverless functions

// Request/Response types (generated from Pydantic models)
export interface MSMDCRequest {
  graph: Graph;
  edge_id: string;
  condition_index: number;
}

export interface MSMDCResponse {
  query: string;
  explanation: string;
}

export interface MutationRequest {
  graph: Graph;
  mutation_type: 'rebalance' | 'propagate_color' | 'add_complementary';
  params: Record<string, any>;
}

export interface MutationResponse {
  graph: Graph;
  changes: Array<{ entity_id: string; field: string; old_value: any; new_value: any }>;
}

/**
 * Graph Compute API Client
 */
export class GraphComputeClient {
  private baseUrl: string;

  constructor(baseUrl: string = API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  /**
   * Generate MSMDC query for conditional probability
   */
  async generateMSMDCQuery(
    graph: Graph,
    edgeId: string,
    conditionIndex: number
  ): Promise<MSMDCResponse> {
    const response = await fetch(`${this.baseUrl}/msmdc/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        graph,
        edge_id: edgeId,
        condition_index: conditionIndex,
      } as MSMDCRequest),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`MSMDC generation failed: ${error.detail}`);
    }

    return response.json();
  }

  /**
   * Apply graph mutation (rebalancing, propagation, etc.)
   */
  async applyMutation(
    graph: Graph,
    mutationType: MutationRequest['mutation_type'],
    params: Record<string, any>
  ): Promise<MutationResponse> {
    const response = await fetch(`${this.baseUrl}/mutations/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        graph,
        mutation_type: mutationType,
        params,
      } as MutationRequest),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Mutation failed: ${error.detail}`);
    }

    return response.json();
  }

  /**
   * Get graph analytics/stats
   */
  async getAnalytics(graph: Graph): Promise<Record<string, any>> {
    const response = await fetch(`${this.baseUrl}/analytics/compute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graph }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Analytics failed: ${error.detail}`);
    }

    return response.json();
  }

  /**
   * Health check
   */
  async health(): Promise<{ status: string }> {
    const response = await fetch(`${this.baseUrl}/health`);
    return response.json();
  }
}

// Singleton instance
export const graphComputeClient = new GraphComputeClient();
```

**Usage in UpdateManager:**
```typescript
// In UpdateManager.ts
import { graphComputeClient } from './graphComputeClient';

class UpdateManager {
  async generateConditionalQuery(
    edgeId: string,
    conditionIndex: number
  ): Promise<string> {
    const graph = this.getCurrentGraph();
    
    try {
      const result = await graphComputeClient.generateMSMDCQuery(
        graph,
        edgeId,
        conditionIndex
      );
      
      console.log(`[UpdateManager] MSMDC query generated: ${result.query}`);
      console.log(`[UpdateManager] Explanation: ${result.explanation}`);
      
      return result.query;
    } catch (error) {
      console.error('[UpdateManager] MSMDC generation failed:', error);
      // Fallback or user notification
      throw error;
    }
  }

  async rebalanceSiblings(
    nodeId: string,
    policy: 'proportional' | 'equal'
  ): Promise<Graph> {
    const graph = this.getCurrentGraph();
    
    try {
      const result = await graphComputeClient.applyMutation(
        graph,
        'rebalance',
        { node_id: nodeId, policy }
      );
      
      // Apply changes to graph
      this.applyChanges(result.changes);
      
      return result.graph;
    } catch (error) {
      console.error('[UpdateManager] Rebalancing failed:', error);
      throw error;
    }
  }
}
```

---

### 4. Query DSL Schema

**Problem:**
We have a query expression DSL (e.g., `"from(node).to(node).visited(node)"`) but no formal schema.

**Solution: JSON Schema + Pydantic**

```json
// graph-editor/public/schemas/query-dsl-1.0.0.json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "DagNet Query DSL",
  "description": "Schema for query expression strings and their parsed AST",
  
  "definitions": {
    "QueryExpression": {
      "type": "object",
      "properties": {
        "raw": {
          "type": "string",
          "description": "Raw query string",
          "pattern": "^(from|to|visited|exclude|context|case)\\([^)]+\\)(\\.(from|to|visited|exclude|context|case)\\([^)]+\\))*$"
        },
        "ast": {
          "$ref": "#/definitions/QueryAST"
        }
      },
      "required": ["raw"]
    },
    
    "QueryAST": {
      "type": "object",
      "properties": {
        "functions": {
          "type": "array",
          "items": {
            "$ref": "#/definitions/QueryFunction"
          }
        }
      }
    },
    
    "QueryFunction": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "enum": ["from", "to", "visited", "exclude", "context", "case"]
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": ["name", "args"]
    }
  }
}
```

**Python Pydantic Models:**
```python
# graph-compute/schemas/dsl.py
from pydantic import BaseModel, Field, validator
from typing import List, Literal
from enum import Enum

class QueryFunctionName(str, Enum):
    FROM = "from"
    TO = "to"
    VISITED = "visited"
    EXCLUDE = "exclude"
    CONTEXT = "context"
    CASE = "case"

class QueryFunction(BaseModel):
    """Single function in query expression."""
    name: QueryFunctionName
    args: List[str]
    
    class Config:
        frozen = True

class QueryAST(BaseModel):
    """Parsed abstract syntax tree of query expression."""
    functions: List[QueryFunction]

class QueryExpression(BaseModel):
    """Query expression with optional parsed AST."""
    raw: str = Field(..., description="Raw query string")
    ast: QueryAST | None = Field(None, description="Parsed AST")
    
    @validator('raw')
    def validate_syntax(cls, v):
        """Basic syntax validation."""
        if not v:
            return v
        # Add regex validation here
        return v
    
    def parse(self) -> 'QueryExpression':
        """Parse raw string into AST."""
        functions = []
        # Parse logic here
        self.ast = QueryAST(functions=functions)
        return self
    
    def get_visited_nodes(self) -> List[str]:
        """Extract all visited node references."""
        if not self.ast:
            self.parse()
        return [
            arg 
            for func in self.ast.functions 
            if func.name == QueryFunctionName.VISITED
            for arg in func.args
        ]
    
    def get_cases(self) -> List[str]:
        """Extract all case references."""
        if not self.ast:
            self.parse()
        return [
            arg 
            for func in self.ast.functions 
            if func.name == QueryFunctionName.CASE
            for arg in func.args
        ]
```

**TypeScript Types (Generated):**
```typescript
// graph-editor/src/types/queryDSL.ts
// Generated from Pydantic models via pydantic-to-typescript

export enum QueryFunctionName {
  FROM = 'from',
  TO = 'to',
  VISITED = 'visited',
  EXCLUDE = 'exclude',
  CONTEXT = 'context',
  CASE = 'case',
}

export interface QueryFunction {
  name: QueryFunctionName;
  args: string[];
}

export interface QueryAST {
  functions: QueryFunction[];
}

export interface QueryExpression {
  raw: string;
  ast?: QueryAST;
}
```

---

### 5. Testing Strategy

#### Python Tests (pytest)
```python
# graph-compute/tests/test_msmdc.py
import pytest
from lib.msmdc_algo import generate_query
from tests.fixtures.graphs import simple_graph, complex_graph

def test_simple_msmdc_generation():
    """Test MSMDC query generation for simple graph."""
    graph = simple_graph()
    
    query = generate_query(
        graph=graph,
        edge_id="a->b",
        condition_index=0
    )
    
    assert query == "from(a).to(b).visited(promo)"

def test_complex_msmdc_with_exclusions():
    """Test MSMDC with exclusions for disambiguation."""
    graph = complex_graph()
    
    query = generate_query(
        graph=graph,
        edge_id="checkout->purchase",
        condition_index=0
    )
    
    # Should include exclusions to disambiguate
    assert "exclude(" in query
    assert query.startswith("from(checkout).to(purchase)")

@pytest.fixture
def simple_graph():
    """Fixture: simple test graph."""
    return {
        "nodes": [
            {"id": "a", "type": "event"},
            {"id": "b", "type": "event"},
            {"id": "promo", "type": "event"}
        ],
        "edges": [
            {
                "id": "a->b",
                "from": "a",
                "to": "b",
                "conditional_p": [
                    {"condition": "visited(promo)", "p": {"mean": 0.8}}
                ]
            }
        ]
    }
```

```bash
# Run Python tests
cd graph-compute
pytest tests/ -v
pytest tests/ --cov=lib --cov-report=html
```

#### TypeScript Integration Tests (vitest)
```typescript
// graph-editor/src/lib/__tests__/graphComputeClient.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { graphComputeClient } from '../graphComputeClient';
import { createTestGraph } from './fixtures/graphs';

describe('GraphComputeClient', () => {
  it('should generate MSMDC query', async () => {
    const graph = createTestGraph();
    
    const result = await graphComputeClient.generateMSMDCQuery(
      graph,
      'a->b',
      0
    );
    
    expect(result.query).toBeTruthy();
    expect(result.query).toMatch(/^from\(/);
  });

  it('should handle Python backend errors gracefully', async () => {
    const invalidGraph = { nodes: [], edges: [] };
    
    await expect(
      graphComputeClient.generateMSMDCQuery(invalidGraph, 'invalid', 0)
    ).rejects.toThrow();
  });
});
```

#### Mock Strategy for Development
```typescript
// graph-editor/src/lib/graphComputeClient.ts
export const USE_MOCK = import.meta.env.VITE_USE_MOCK_COMPUTE === 'true';

class GraphComputeClient {
  async generateMSMDCQuery(...args): Promise<MSMDCResponse> {
    if (USE_MOCK) {
      // Mock response for development without Python backend
      return {
        query: 'from(a).to(b).visited(promo)',
        explanation: '[MOCK] Query generated'
      };
    }
    
    // Real API call
    return this.callAPI(...);
  }
}
```

---

## Implementation Plan

### Phase 1: Setup Infrastructure (2-3 hours)
1. Create `lib/`, `tests/`, `api/` directory structure
2. Set up Python virtual environment
3. Create `requirements.txt` with NetworkX, Pydantic, pytest
4. Create `dev-server.py` with FastAPI for local dev
5. Test local server runs on `:9000`
6. Create TypeScript client shim with health check
7. Test TS → Python communication

### Phase 2: Query DSL Schema (1-2 hours)
1. Create JSON Schema for query DSL
2. Create Pydantic models in Python
3. Generate TypeScript types (or write manually)
4. Add validation on both sides
5. Write tests for parsing/validation

### Phase 3: MSMDC Implementation (4-6 hours)
1. Design MSMDC algorithm in Python
2. Implement core logic with NetworkX
3. Write comprehensive pytest tests
4. Create Python API endpoint
5. Add TypeScript client method
6. Integration testing
7. Add to UpdateManager

### Phase 4: Graph Mutations (3-4 hours)
1. Implement rebalancing algorithms
2. Implement complementary conditional creation
3. Implement color propagation
4. API endpoints for each
5. TypeScript client methods
6. Tests

### Phase 5: Vercel Deployment (2-3 hours)
1. Configure `vercel.json` with region settings
2. Test Python serverless functions
3. Environment variable configuration
4. Deploy to preview
5. Test production endpoints
6. **Verify region co-location** (critical for latency)

### Phase 6: Documentation & Polish (1-2 hours)
1. API documentation (FastAPI auto-docs)
2. Update README with Python setup instructions
3. Add development workflow docs
4. Performance testing
5. Error handling improvements

**Total Estimate: 13-20 hours**

---

## Performance & Latency Considerations

### Region Co-location (Critical)

**Same Region Deployment:**
```json
// vercel.json - ensure all functions in same region
{
  "regions": ["iad1"],  // Project default
  "functions": {
    "api/**/*": {
      "regions": ["iad1"]  // All functions co-located
    }
  }
}
```

**Latency Comparison:**
- Same region (TS → Python): ~1-5ms
- Cross-region (US East → US West): ~50-100ms
- Cross-region (US → Europe): ~100-200ms
- Cross-region (US → Asia): ~200-400ms

**Why This Matters:**
- MSMDC generation: Frontend → Python → Frontend
- Mutations: Frontend → Python (modifies graph) → Frontend
- Multiple graph operations in sequence = latency multiplied
- **50-200ms added latency per operation** if regions differ

**Best Practice:**
1. Choose primary user region (e.g., `iad1` for US/Europe users)
2. Deploy **ALL** functions to that region
3. Only use multi-region for static assets (CDN)
4. Keep compute single-region for data consistency

### Cold Start Mitigation

**Python Function Cold Starts:**
- First invocation: ~500-2000ms (load Python runtime + deps)
- Warm invocations: ~50-200ms
- Vercel keeps functions warm for ~5 minutes after last use

**Optimization Strategies:**
```python
# Lazy imports to reduce cold start time
def handler(request):
    import networkx as nx  # Import only when needed
    from lib.msmdc_algo import generate_query  # Not at module level
    
    # Process request
    ...
```

**Production Monitoring:**
- Track cold start frequency
- Consider "warming" functions with periodic health checks
- NetworkX is ~5MB - acceptable for Vercel (50MB limit)

### Caching Strategy

**Client-Side Cache (TypeScript):**
```typescript
// Cache MSMDC queries for repeated requests
const msmDCCache = new Map<string, string>();

function getCachedQuery(graphHash: string, edgeId: string, condIndex: number): string | null {
  const key = `${graphHash}:${edgeId}:${condIndex}`;
  return msmDCCache.get(key) ?? null;
}
```

**Benefits:**
- Avoid redundant Python calls
- Sub-millisecond response for cached queries
- Clear cache on graph structure changes

---

## Benefits

1. **Better Math Libraries**: NetworkX, NumPy, SciPy for graph algorithms
2. **Easier Debugging**: Python REPL, Jupyter notebooks for algorithm development
3. **Type Safety**: Pydantic validation on both ends
4. **Separation of Concerns**: UI logic (TS) vs compute logic (Python)
5. **Scalability**: Can offload heavy compute to Python backend
6. **Testing**: pytest ecosystem for graph algorithms
7. **Performance**: Python often faster for graph algorithms than JS

## Trade-offs

1. **Complexity**: Two languages, two test suites, API layer
2. **Latency**: Network round-trip for graph operations (~1-5ms same region)
3. **Cold Starts**: Python serverless ~500-2000ms initial invocation
4. **Deployment**: More moving parts (but Vercel handles Python well)
5. **Dependencies**: Need to manage Python environment alongside Node
6. **Size Limits**: Vercel 50MB function size limit (NetworkX is ~5MB, OK)

---

## Current Status (Updated: November 2025)

### ✅ Completed

#### Phase 1: Infrastructure Setup (COMPLETE)

**Python Environment:**
- ✅ Created `/lib/` directory with shared Python libraries
- ✅ Created `/tests/` directory with pytest infrastructure
- ✅ Set up `requirements.txt` with NetworkX (3.2), Pydantic (2.0)
- ✅ Created `dev-server.py` with FastAPI for local dev (port 9000)
- ✅ Created `dev-start.sh` and `dev-stop.sh` for tmux-based dev workflow
- ✅ Tested local server runs on `:9000` with hot-reload

**TypeScript Integration:**
- ✅ Created `graphComputeClient.ts` - TypeScript → Python API shim
- ✅ Environment detection (dev vs. production)
- ✅ Mock mode support (`VITE_USE_MOCK_COMPUTE=true`)
- ✅ Health check endpoint working

**Testing Infrastructure:**
- ✅ **Python Tests:** 6 passing (pytest)
  - `/tests/test_infrastructure.py` - Graph types validation
  - `/tests/test_query_dsl.py` - DSL parser unit tests
- ✅ **TypeScript Integration Tests:** 12 passing, 11 skipped (vitest)
  - `/graph-editor/src/lib/__tests__/graphComputeClient.test.ts`
  - Tests mock mode, error handling, schema compliance
  - Real backend tests skip if Python server not running
- ✅ **Component Tests:** 26 passing (vitest)
  - `/graph-editor/src/lib/__tests__/queryDSL.test.ts` - 18 tests
  - `/graph-editor/src/components/__tests__/QueryExpressionEditor.test.tsx` - 26 tests
  - Tests parsing, validation, schema authority

**Total Test Coverage:**
```
✅ 199 tests passing | 11 skipped (210 total)
✅ 11 test files passing
✅ TypeScript tests: 193 passing
✅ Python tests: 6 passing
```

#### Phase 2: Query DSL Schema (COMPLETE)

- ✅ Created JSON Schema at `/graph-editor/public/schemas/query-dsl-1.0.0.json`
- ✅ Created Pydantic models in `/lib/query_dsl.py`
- ✅ Created TypeScript constants in `/graph-editor/src/lib/queryDSL.ts`
- ✅ Schema authority established and tested
- ✅ All 6 functions validated: `from`, `to`, `visited`, `exclude`, `context`, `case`

**Working Endpoints (Local Dev):**
- ✅ `GET /` - Health check
- ✅ `POST /api/parse-query` - Query DSL parser (roundtrip tested)

### 🚧 In Progress

None - infrastructure ready for algorithmic work.

### 📋 Pending (Ready to Start)

#### Phase 3: MSMDC Implementation (4-6 hours)
1. Design MSMDC algorithm in Python
2. Implement core logic with NetworkX
3. Write comprehensive pytest tests
4. Create Python API endpoint at `/api/msmdc`
5. Add TypeScript client method
6. Integration testing
7. Add to UpdateManager

#### Phase 4: Graph Mutations (3-4 hours)
1. Implement rebalancing algorithms
2. Implement complementary conditional creation
3. Implement color propagation
4. API endpoints for each
5. TypeScript client methods
6. Tests

#### Phase 5: Vercel Deployment (2-3 hours)
1. Configure `vercel.json` with region settings
2. Test Python serverless functions
3. Environment variable configuration
4. Deploy to preview
5. Test production endpoints
6. **Verify region co-location** (critical for latency)

#### Phase 6: Documentation & Polish (1-2 hours)
1. API documentation (FastAPI auto-docs)
2. Update README with Python setup instructions
3. Add development workflow docs
4. Performance testing
5. Error handling improvements

---

## Development Workflow

### Quick Start

```bash
# Start both servers (frontend + Python backend):
./dev-start.sh

# With clean install:
./dev-start.sh --clean

# Stop both servers:
./dev-stop.sh
```

**What runs:**
- Frontend: http://localhost:5173 (Vite)
- Python API: http://localhost:9000 (FastAPI)
- API Docs: http://localhost:9000/docs (auto-generated)

### Running Tests

```bash
# All tests (TypeScript + Python)
npm test                     # TypeScript (vitest)
pytest tests/ -v             # Python (pytest)

# Specific test suites
npm test -- src/lib/__tests__/queryDSL.test.ts
npm test -- src/lib/__tests__/graphComputeClient.test.ts
pytest tests/test_query_dsl.py -v

# With coverage
npm test -- --coverage
pytest tests/ --cov=lib --cov-report=html
```

### API Testing

```bash
# Health check
curl http://localhost:9000/

# Parse query (Python roundtrip)
curl -X POST http://localhost:9000/api/parse-query \
  -H "Content-Type: application/json" \
  -d '{"query_string": "from(a).to(b).visited(c)"}'
```

---

## Readiness Assessment

### ✅ Ready for MSMDC Implementation

**Infrastructure:**
- ✅ Python environment set up and tested
- ✅ NetworkX installed and available
- ✅ FastAPI server running with hot-reload
- ✅ TypeScript client ready to consume endpoints
- ✅ Mock mode available for frontend development without backend

**Testing:**
- ✅ pytest infrastructure in place
- ✅ vitest integration tests working
- ✅ Test fixtures available (`tests/fixtures/graphs.py`)
- ✅ Query DSL parser tested and validated

**Schema:**
- ✅ Graph types defined in Python (Pydantic)
- ✅ Graph types defined in TypeScript
- ✅ Query DSL schema validated
- ✅ Schema authority flow established

**Blockers:**
- ❌ None - ready to proceed

### Next Immediate Step

**Begin Phase 3: MSMDC Implementation**

1. Design MSMDC algorithm:
   - Input: Graph, edge ID, condition index
   - Output: Query DSL string (minimal discriminating constraints)
   - Strategy: Path analysis, disambiguation logic

2. Create test cases in `tests/test_msmdc.py`

3. Implement algorithm in `lib/msmdc_algo.py`

4. Create endpoint in `api/msmdc.py` (Vercel serverless format)

5. Add client method to `graphComputeClient.ts`

6. Wire into UpdateManager for automatic query generation

**Estimated Time:** 4-6 hours for complete MSMDC implementation

---

## Architecture Health

### Strengths
- ✅ Clean separation: UI (TS) vs. Compute (Python)
- ✅ Schema-first approach prevents drift
- ✅ Comprehensive test coverage before algorithmic work
- ✅ Local dev environment matches production
- ✅ Mock mode enables frontend work without backend

### Areas for Improvement
- ⚠️ Cold start mitigation strategy needed for production
- ⚠️ Need performance benchmarks for MSMDC
- ⚠️ Should add caching strategy for repeated queries
- ⚠️ Consider warming functions with Vercel Cron Jobs

### Critical for Production
- 🔴 **Must verify region co-location** when deploying
- 🔴 Monitor cold start frequency
- 🔴 Set up error tracking for Python functions
- 🔴 Add rate limiting if needed

---

## Next Steps

1. ✅ ~~Review this architecture~~ (COMPLETE)
2. ✅ ~~Approve approach~~ (COMPLETE)
3. ✅ ~~Begin Phase 1: Infrastructure setup~~ (COMPLETE)
4. ⏭️ **BEGIN Phase 3: Implement MSMDC as first real function**
5. Extend to other graph operations as needed

