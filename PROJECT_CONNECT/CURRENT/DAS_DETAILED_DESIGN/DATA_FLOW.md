# Data Flow - Complete Specification

**Component:** End-to-End Data Flow & Node Resolution  
**Status:** 🔵 Design Complete  
**Reference:** Original design Section 1.2 (lines 64-244)

---

## 1. Complete Data Flow Diagram

### 1.1 The 7 Data Inputs

```
┌────────────────────────────────────────────────────────────────────────┐
│                    DATA INPUTS (7 Sources)                             │
└────────────────────────────────────────────────────────────────────────┘

[1] GRAPH NODES
    graph.nodes[i]:
      id: "node-checkout"        ← Query refs use THIS (not uuid!)
      uuid: "node-abc-123..."    ← Internal graph reference
      event_id: "checkout"       ← Maps to Amplitude event name
      label: "Checkout Page"

[2] EDGE QUERY
    edge.p.query:
      from: "node-checkout"      ← Node ID (human-readable)
      to: "node-purchase"
      visited: ["node-view"]

[3] GRAPH-LEVEL SELECTORS (Runtime state, UI-driven)
    GraphContext.dataFetchContext:
      window: {start: "2025-01-01", end: "2025-01-31"}
      context: {id: "mobile_users", label: "Mobile"}

[4] CONNECTION CONFIG (connections.yaml, git-committed)
    connection:
      name: "amplitude-prod"
      provider: "amplitude"
      credsRef: "amplitude"
      defaults: {project_id: "12345", exclude_test: true}
      adapter: {...}

[5] CONNECTION STRING (edge.p.connection_string, param-specific)
    {"segment_filter": "mobile_users"}

[6] CREDENTIALS (via CredentialsManager - multi-source)
    Precedence: URL → System (ENV_VAR) → IndexedDB → Public
    
    Browser: credentials.yaml in IndexedDB
      git: [{...}]
      amplitude: {api_key: "sk_live_..."}
    
    Server: System Secret from ENV_VAR
      VITE_CREDENTIALS_JSON: '{"git":[...], "amplitude":{...}}'
      VITE_CREDENTIALS_SECRET: "secret_key" (optional, for ?secret= validation)

[7] CONNECTION REFERENCE (edge.p.connection)
    "amplitude-prod"
```

### 1.2 The 8-Step Execution Pipeline

```
▼
┌────────────────────────────────────────────────────────────────────────┐
│             8-STEP DAS EXECUTION PIPELINE                              │
└────────────────────────────────────────────────────────────────────────┘

STEP 1: Load Connection
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Input:  edge.p.connection = "amplitude-prod"
Action: ConnectionProvider.getConnection("amplitude-prod")
Output: connection = {name, provider, credsRef, defaults, adapter, ...}

STEP 2: Resolve Node IDs → Event IDs
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Input:  edge.p.query = {from: "node-checkout", to: "node-purchase", visited: ["node-view"]}
Action: buildDslFromEdge(edge, graph)
Logic:
  1. Find node by id: graph.nodes.find(n => n.id === "node-checkout")
  2. Extract event_id: node.event_id
  3. Throw clear error if node not found or missing event_id
Output: dsl = {
  from_event_id: "checkout",
  to_event_id: "purchase",
  visited_event_ids: ["view_product"],
  excluded_event_ids: []
}

STEP 3: Load Credentials
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Input:  connection.credsRef = "amplitude"
Action: CredentialsManager.loadCredentials()
Logic:  Precedence: URL → System → IndexedDB → Public
Output: credentials = {api_key: "sk_live_...", secret_key: "..."}

STEP 4: Build Execution Context
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Combine all inputs:
execContext = {
  dsl: {from_event_id, to_event_id, visited_event_ids, excluded_event_ids},
  connection: {name, defaults: {project_id, exclude_test_users, ...}},
  credentials: {api_key, secret_key},
  window: {start, end, timezone},
  context: {id, label, filters},
  connection_string: {segment_filter, ...},
  edgeId: "edge-123"
}

STEP 5: Interpolate Templates (Mustache)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Template: "Bearer {{credentials.api_key}}"
Output:   "Bearer sk_live_abc123..."

Template: |
  {
    "project_id": "{{connection.defaults.project_id}}",
    "events": [
      {"event_type": "{{dsl.from_event_id}}"},
      {"event_type": "{{dsl.to_event_id}}"}
    ],
    "start": "{{window.start}}",
    "end": "{{window.end}}"
  }
Output: JSON body with resolved values

STEP 6: Execute HTTP Request
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Input:  HttpRequest {url, method, headers, body}
Action: HttpExecutor.execute(request)
Output: HttpResponse {status: 200, body: {...}}

STEP 7: Extract & Transform Data (JMESPath + JSONata)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Extract (JMESPath):
  from_count = jmespath("data.steps[0].count", response) → 10000
  to_count = jmespath("data.steps[1].count", response) → 8000

Transform (JSONata):
  p_mean = jsonata("to_count / from_count") → 0.8
  p_stdev = jsonata("$sqrt(p_mean * (1 - p_mean) / from_count)") → 0.004

STEP 8: Upsert to Graph (UpdateManager)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Input: updates = [
  {target: "/edges/edge-123/p/mean", value: 0.8},
  {target: "/edges/edge-123/p/evidence/n", value: 10000},
  {target: "/edges/edge-123/p/evidence/k", value: 8000},
  {target: "/edges/edge-123/p/evidence/source", value: "amplitude-prod"},
  ...
]
Action: UpdateManager.applyUpdates(updates, graph, 'UPDATE')
Output: Updated graph with new values + evidence

▼
┌────────────────────────────────────────────────────────────────────────┐
│                 UPDATED GRAPH + UI REFRESH                             │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. buildDslFromEdge() - Complete Implementation

**File:** `/graph-editor/src/lib/das/buildDslFromEdge.ts`

### 2.1 Core Function

```typescript
/**
 * Build DSL execution object from edge.p.query + graph nodes
 * 
 * CRITICAL: Query stores NODE references (node.id), must look up nodes to get event_ids
 * 
 * @param edge - The edge with p.query object
 * @param graph - The full graph (needed to resolve node IDs)
 * @returns DSL object with resolved event_ids
 * @throws Error if nodes not found or missing event_ids
 */
export function buildDslFromEdge(edge: any, graph: any): DslObject {
  // Edge.p.query has: { from: "node-checkout", to: "node-purchase", visited: [...] }
  // We need to look up those nodes to get their event_ids
  
  const query = edge.p?.query;
  if (!query) {
    throw new Error(
      `Edge missing query object: ${edge.from} → ${edge.to}\n\n` +
      `To fix:\n` +
      `1. Ensure edge.p.query is defined\n` +
      `2. Query should specify: {from: "node-id", to: "node-id"}`
    );
  }
  
  // Helper to find node by ID or UUID
  // NOTE: Queries primarily use node.id (human-readable), not node.uuid
  const findNode = (ref: string): any | undefined => {
    // Try by id first (most common)
    let node = graph.nodes.find((n: any) => n.id === ref);
    
    // Fallback to uuid (edge case)
    if (!node) {
      node = graph.nodes.find((n: any) => n.uuid === ref);
    }
    
    return node;
  };
  
  // Look up from/to nodes using query references
  const fromNode = findNode(query.from);
  const toNode = findNode(query.to);
  
  // Validate nodes exist
  if (!fromNode || !toNode) {
    const availableNodes = graph.nodes.map((n: any) => n.id).join(', ');
    throw new Error(
      `Query nodes not found:\n` +
      `  from: "${query.from}" → ${fromNode ? '✓ found' : '✗ NOT FOUND'}\n` +
      `  to: "${query.to}" → ${toNode ? '✓ found' : '✗ NOT FOUND'}\n\n` +
      `Available nodes: ${availableNodes}\n\n` +
      `To fix:\n` +
      `1. Check that query.from and query.to reference valid node IDs\n` +
      `2. Node IDs are case-sensitive`
    );
  }

  // Extract event_ids from nodes
  const from_event_id = fromNode.event_id;
  const to_event_id = toNode.event_id;
  
  // Validate event_ids exist (graceful failure with clear guidance)
  if (!from_event_id || !to_event_id) {
    throw new Error(
      `Nodes must have event_id field to fetch external data:\n` +
      `  "${fromNode.label || fromNode.id}": event_id = ${from_event_id || 'MISSING'}\n` +
      `  "${toNode.label || toNode.id}": event_id = ${to_event_id || 'MISSING'}\n\n` +
      `To fix:\n` +
      `1. Open node properties in the graph editor\n` +
      `2. Set event_id to the external system event name\n` +
      `   - For Amplitude: the event_type (e.g., "checkout_page_viewed")\n` +
      `   - For SQL: the event name in your events table\n` +
      `3. Try "Get from source" again`
    );
  }
  
  // Look up visited nodes and extract their event_ids
  const visited_event_ids: string[] = [];
  if (query.visited && Array.isArray(query.visited)) {
    for (const ref of query.visited) {
      const node = findNode(ref);
      if (!node) {
        throw new Error(
          `Visited node not found: "${ref}"\n\n` +
          `Available nodes: ${graph.nodes.map((n: any) => n.id).join(', ')}`
        );
      }
      if (!node.event_id) {
        throw new Error(
          `Visited node "${node.label || node.id}" missing event_id field`
        );
      }
      visited_event_ids.push(node.event_id);
    }
  }
  
  // Look up excluded nodes and extract their event_ids
  const excluded_event_ids: string[] = [];
  if (query.excluded && Array.isArray(query.excluded)) {
    for (const ref of query.excluded) {
      const node = findNode(ref);
      if (!node) {
        throw new Error(
          `Excluded node not found: "${ref}"\n\n` +
          `Available nodes: ${graph.nodes.map((n: any) => n.id).join(', ')}`
        );
      }
      if (!node.event_id) {
        throw new Error(
          `Excluded node "${node.label || node.id}" missing event_id field`
        );
      }
      excluded_event_ids.push(node.event_id);
    }
  }

  // Build execution DSL with resolved event_ids
  return {
    from_event_id,           // "checkout"
    to_event_id,             // "purchase"
    visited_event_ids,       // ["view_product"]
    excluded_event_ids       // ["abandoned_cart"]
  };
}
```

### 2.2 Type Definitions

```typescript
export interface DslObject {
  from_event_id: string;
  to_event_id: string;
  visited_event_ids: string[];
  excluded_event_ids: string[];
}
```

### 2.3 Test Cases

```typescript
// graph-editor/src/lib/das/buildDslFromEdge.test.ts
import { describe, it, expect } from 'vitest';
import { buildDslFromEdge } from './buildDslFromEdge';

describe('buildDslFromEdge', () => {
  const graph = {
    nodes: [
      {id: 'node-checkout', uuid: 'uuid-1', event_id: 'checkout', label: 'Checkout'},
      {id: 'node-purchase', uuid: 'uuid-2', event_id: 'purchase', label: 'Purchase'},
      {id: 'node-view', uuid: 'uuid-3', event_id: 'view_product', label: 'View Product'},
      {id: 'node-abandoned', uuid: 'uuid-4', event_id: 'abandoned_cart', label: 'Abandoned'}
    ]
  };
  
  it('should resolve node IDs to event IDs', () => {
    const edge = {
      from: 'uuid-1',
      to: 'uuid-2',
      p: {
        query: {
          from: 'node-checkout',
          to: 'node-purchase',
          visited: ['node-view']
        }
      }
    };
    
    const dsl = buildDslFromEdge(edge, graph);
    
    expect(dsl.from_event_id).toBe('checkout');
    expect(dsl.to_event_id).toBe('purchase');
    expect(dsl.visited_event_ids).toEqual(['view_product']);
    expect(dsl.excluded_event_ids).toEqual([]);
  });
  
  it('should handle visited and excluded nodes', () => {
    const edge = {
      p: {
        query: {
          from: 'node-checkout',
          to: 'node-purchase',
          visited: ['node-view'],
          excluded: ['node-abandoned']
        }
      }
    };
    
    const dsl = buildDslFromEdge(edge, graph);
    
    expect(dsl.visited_event_ids).toEqual(['view_product']);
    expect(dsl.excluded_event_ids).toEqual(['abandoned_cart']);
  });
  
  it('should throw on missing query object', () => {
    const edge = { p: {} };
    
    expect(() => buildDslFromEdge(edge, graph))
      .toThrow('Edge missing query object');
  });
  
  it('should throw on missing node', () => {
    const edge = {
      p: {
        query: {
          from: 'node-missing',
          to: 'node-purchase'
        }
      }
    };
    
    expect(() => buildDslFromEdge(edge, graph))
      .toThrow('Query nodes not found');
  });
  
  it('should throw on missing event_id with helpful message', () => {
    const graphNoEventId = {
      nodes: [
        {id: 'node-checkout', uuid: 'uuid-1' /* no event_id */},
        {id: 'node-purchase', uuid: 'uuid-2', event_id: 'purchase'}
      ]
    };
    
    const edge = {
      p: {
        query: {
          from: 'node-checkout',
          to: 'node-purchase'
        }
      }
    };
    
    expect(() => buildDslFromEdge(edge, graphNoEventId))
      .toThrow('Nodes must have event_id field');
  });
  
  it('should find node by uuid as fallback', () => {
    const edge = {
      p: {
        query: {
          from: 'uuid-1',  // Using UUID instead of node.id
          to: 'node-purchase'
        }
      }
    };
    
    const dsl = buildDslFromEdge(edge, graph);
    
    expect(dsl.from_event_id).toBe('checkout');
  });
});
```

---

## 3. Node ID vs UUID vs event_id

### 3.1 Three Types of Node Identifiers

| Field | Purpose | Example | Used Where |
|-------|---------|---------|------------|
| `node.id` | Human-readable identifier | `"node-checkout"` | **Query refs**, UI labels, user input |
| `node.uuid` | Internal graph identifier | `"abc-123-def-456"` | Edge refs (`edge.from`, `edge.to`), internal tracking |
| `node.event_id` | External system event name | `"checkout_page_viewed"` | **API requests**, external data systems |

### 3.2 Resolution Chain

```
User creates query:
  query.from = "node-checkout"  (uses node.id)
         ↓
buildDslFromEdge():
  1. Find node: graph.nodes.find(n => n.id === "node-checkout")
  2. Extract event_id: node.event_id
         ↓
  dsl.from_event_id = "checkout_page_viewed"
         ↓
Template interpolation:
  "{{dsl.from_event_id}}" → "checkout_page_viewed"
         ↓
Amplitude API request:
  {"event_type": "checkout_page_viewed"}
```

### 3.3 Why Not Use UUIDs?

**Problem:** UUIDs are opaque and brittle
```json
{
  "query": {
    "from": "abc-123-def-456",  // ✗ What node is this?
    "to": "xyz-789-ghi-012"     // ✗ Impossible to read
  }
}
```

**Solution:** Use node.id (human-readable)
```json
{
  "query": {
    "from": "node-checkout",    // ✓ Clear what this is
    "to": "node-purchase"       // ✓ Human-readable
  }
}
```

**Benefit:** Queries are readable in graph files, portable across graphs with same node IDs

---

## 4. Error Handling & User Guidance

### 4.1 Missing Query Object

```typescript
Error: Edge missing query object: node-1 → node-2

To fix:
1. Ensure edge.p.query is defined
2. Query should specify: {from: "node-id", to: "node-id"}
```

### 4.2 Node Not Found

```typescript
Error: Query nodes not found:
  from: "node-checkout-page" → ✗ NOT FOUND
  to: "node-purchase" → ✓ found

Available nodes: node-home, node-product, node-checkout, node-purchase, node-thank-you

To fix:
1. Check that query.from and query.to reference valid node IDs
2. Node IDs are case-sensitive
```

### 4.3 Missing event_id

```typescript
Error: Nodes must have event_id field to fetch external data:
  "Checkout Page": event_id = MISSING
  "Purchase Confirmation": event_id = purchase

To fix:
1. Open node properties in the graph editor
2. Set event_id to the external system event name
   - For Amplitude: the event_type (e.g., "checkout_page_viewed")
   - For SQL: the event name in your events table
3. Try "Get from source" again
```

---

## 5. Integration Points

### 5.1 When buildDslFromEdge() is Called

```typescript
// In DAS Runner
async function executeForEdge(edge: any, graph: any, context: any) {
  // 1. Build DSL from edge query
  const dsl = buildDslFromEdge(edge, graph);
  
  // 2. Execute DAS with resolved event_ids
  const result = await dasRunner.execute(
    edge.p.connection,
    dsl,
    {
      window: context.window,
      connection_string: edge.p.connection_string
    }
  );
  
  // 3. Apply updates
  await updateManager.applyUpdates(result.updates, graph);
}
```

### 5.2 In "Get from source" Button Handler

```typescript
// In EdgePropertiesPanel
async function handleGetFromSource() {
  try {
    const dsl = buildDslFromEdge(selectedEdge, graph);
    const runner = createDASRunner();
    
    const result = await runner.execute(
      selectedEdge.p.connection,
      dsl,
      {
        window: graphContext.window,
        connection_string: selectedEdge.p.connection_string
      }
    );
    
    if (result.success) {
      await updateManager.applyUpdates(result.updates, graph);
      showSuccess('Data fetched successfully');
    }
  } catch (error) {
    // Error has helpful user guidance (from buildDslFromEdge)
    showError(error.message);
  }
}
```

---

## 6. Implementation Checklist

Phase 2b (part of DAS Runner Core):
- [ ] Implement buildDslFromEdge() function (1 hr)
- [ ] Add type definitions (DslObject) (15 min)
- [ ] Write comprehensive tests (1.5 hrs)
- [ ] Add error messages with user guidance (30 min)
- [ ] Document node ID resolution chain (30 min)

Phase 3 (UI Integration):
- [ ] Call buildDslFromEdge in "Get from source" handler (30 min)
- [ ] Display errors in UI (toast/modal) (1 hr)
- [ ] Test with real graph data (1 hr)

---

**Reference:** See `../../ARCHIVE/EXTERNAL_DATA_SYSTEM_DESIGN.md` lines 64-244 for complete data flow schematic and lines 160-220 for buildDslFromEdge context

