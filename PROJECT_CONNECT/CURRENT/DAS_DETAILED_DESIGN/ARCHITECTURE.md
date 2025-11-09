# External Data System - Architecture

**Date:** 2025-11-09  
**Status:** 🔵 Architecture Approved  
**Type:** High-Level Design

---

## 1. System Overview

### 1.1 Purpose

Enable DagNet to fetch live data from external sources (Amplitude, Google Sheets, Statsig, SQL databases) and automatically update graph parameters, cases, and nodes with real-world evidence.

### Three-Layer Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER INTERFACE                           │
│  - Tab-level window/context selectors                          │
│  - Right-click edge → "Get from file..."                       │
│  - File > Credentials, File > Connections                      │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                    CONFIGURATION FILES                          │
│                                                                 │
│  credentials.yaml          connections.yaml                    │
│  (secrets, local)          (config + adapters, git-committed)  │
│                                                                 │
│  amplitude:                connections:                         │
│    apiKey: "***"             - name: amplitude-prod            │
│    secretKey: "***"            provider: amplitude             │
│                                credsRef: amplitude              │
│  git:                          defaults: {...}                 │
│    - token: "***"              adapter:                        │
│                                  request: {...}                │
│                                  response: {...}               │
│                                  transform: {...}              │
│                                  upsert: {...}                 │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                      DAS RUNNER                                 │
│  1. Resolve connection + credentials                            │
│  2. Parse query DSL from edge                                   │
│  3. Get window/context from tab selectors                       │
│  4. Execute request (HTTP/SQL)                                  │
│  5. Extract → Transform → Upsert to graph                       │
└─────────────────────────────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                   EXTERNAL DATA SOURCES                         │
│  Amplitude, PostgreSQL, Google Sheets, etc.                     │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 Key Components

```
┌─────────────────────────────────────────────────────────────┐
│                      DAGNET APPLICATION                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │  Graph       │    │  FormEditor  │    │  Window      │   │
│  │  Editor      │    │  (RJSF)      │    │  Selector    │   │
│  │              │    │              │    │  (DateRange) │   │
│  │  [Get from   │    │  Edit        │    │              │   │
│  │   source]───►│────┤  connections │    │  Last 7 days │   │
│  │              │    │  .yaml       │    │              │   │
│  └──────────────┘    └──────────────┘    └──────────────┘   │
│         │                    │                    │         │
│         └────────────────────┼────────────────────┘         │
│                              │                              │
│                              ▼                              │
│                    ┌──────────────────┐                     │
│                    │   DAS RUNNER     │                     │
│                    │   (Portable)     │                     │
│                    └──────────────────┘                     │
│                              │                              │
│              ┌───────────────┼───────────────┐              │
│              ▼               ▼               ▼              │
│    ┌────────────────┐ ┌─────────────┐ ┌──────────────┐      │
│    │ HttpExecutor   │ │ Credentials │ │ Connection   │      │
│    │ (Browser/Node) │ │ Manager     │ │ Provider     │      │
│    └────────────────┘ └─────────────┘ └──────────────┘      │
│              │               │               │              │
└──────────────┼───────────────┼───────────────┼──────────────┘
               │               │               │
               ▼               ▼               ▼
       ┌────────────┐  ┌──────────────┐ ┌──────────────┐
       │ Amplitude  │  │ credentials  │ │ connections  │
       │ API        │  │ .yaml        │ │ .yaml        │
       │            │  │ (IndexedDB / │ │ (IndexedDB)  │
       │            │  │  ENV_VAR)    │ │              │
       └────────────┘  └──────────────┘ └──────────────┘
```

### 1.3 Core Principles

1. **Separation of Concerns**
   - **connections.yaml**: Configuration + adapters (Git-committable, shareable)
   - **credentials.yaml**: Secrets only (local, never committed)

2. **Portable Architecture**
   - DAS Runner works in browser AND Node.js
   - Minimal abstractions: HttpExecutor, ConnectionProvider
   - Reuse existing: CredentialsManager, UpdateManager

3. **Declarative Adapters**
   - Most data fetching defined in YAML (no code changes needed)
   - Template-driven (Mustache) with JMESPath extraction
   - TypeScript escape hatch for complex cases (deferred to v2)

4. **Graceful Degradation**
   - Missing event_ids → clear error messages
   - API failures → user-friendly errors
   - Invalid schemas → validation feedback

---

## 2. Data Flow Architecture

### 2.1 End-to-End Flow

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

[3] TAB SELECTORS (Graph-level, UI state)
    tab.dataFetchContext:
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

┌────────────────────────────────────────────────────────────────────────┐
│                    EXECUTION FLOW (8 Steps)                            │
└────────────────────────────────────────────────────────────────────────┘

STEP 1: User Action
  Right-click edge → "Get from file"

STEP 2: Resolve Connection
  Input: edge.p.connection = "amplitude-prod"
  Lookup: connections.yaml[amplitude-prod]
  Merge: credentials.yaml[amplitude]
  Output: {adapter, credentials, defaults}

STEP 3: Resolve Node IDs → Event IDs
  buildDslFromEdge(edge, graph):
    Input:  query.from = "node-checkout"  ← Node ID
    Lookup: graph.nodes.find(n => n.id === "node-checkout")
    Extract: fromNode.event_id = "checkout"  ← Event name
    
    Output: dsl = {
      from_event_id: "checkout",        ← For Amplitude
      to_event_id: "purchase",
      visited_event_ids: ["view_product"]
    }

STEP 4: Build Execution Context
  ctx = {
    dsl: {...},              // From Step 3
    connection: {...},       // From Step 2
    window: {...},          // From tab selector
    context: {...},         // From tab selector
    connection_string: {}, // Param-specific
    edgeId: "..."
  }

STEP 5: Adapter pre_request (Transform)
  funnel_steps = [
    ...dsl.visited_event_ids,  // ["view_product"]
    dsl.from_event_id,         // "checkout"
    dsl.to_event_id            // "purchase"
  ]
  // Result: ["view_product", "checkout", "purchase"]
  
  from_step_index = funnel_steps.indexOf(dsl.from_event_id)
  // Result: 1

STEP 6: HTTP Request to Amplitude
  POST /api/2/funnels
  Body: {
    project_id: connection.defaults.project_id,
    events: [
      {event_type: "view_product"},
      {event_type: "checkout"},
      {event_type: "purchase"}
    ],
    start: window.start,
    end: window.end,
    filters: {segment: connection_string.segment_filter}
  }

STEP 7: Extract & Transform Response
  Response: {
    data: {
      steps: [
        {event: "view_product", count: 10000},
        {event: "checkout", count: 4500},     ← from_step_index=1
        {event: "purchase", count: 4050}      ← from_step_index+1=2
      ]
    }
  }
  
  Extract:
    from_count = response.steps[1].count = 4500
    to_count = response.steps[2].count = 4050
  
  Transform:
    p_mean = 4050 / 4500 = 0.9
    p_stdev = sqrt(0.9 * 0.1 / 4500) = 0.0045

STEP 8: Upsert to Graph (via UpdateManager)
  Updates = [
    {path: "/edges/.../p/mean", value: 0.9},
    {path: "/edges/.../p/stdev", value: 0.0045},
    {path: "/edges/.../p/evidence/n", value: 4500},
    {path: "/edges/.../p/evidence/k", value: 4050},
    ...
  ]
  
  UpdateManager.apply(graph, updates)
  → Graph updated atomically
  → UI re-renders
  → Edge shows new probability

┌────────────────────────────────────────────────────────────────────────┐
│                      DATA LINEAGE TRACKING                             │
└────────────────────────────────────────────────────────────────────────┘

Node ID → Event ID:
  query.from: "node-checkout"        (stored in edge.p.query)
  → graph.nodes.find(n => n.id === "node-checkout")
  → node.event_id: "checkout"        (extracted)
  → Amplitude API: event_type="checkout"

Window/Context:
  tab.dataFetchContext.window        (user sets once per graph)
  → ctx.window                       (execution context)
  → Amplitude API: start/end params  (request)
  → edge.p.evidence.window_from/to   (stored with result)

Connection Flow:
  edge.p.connection → connections.yaml lookup → credentials.yaml merge
  → ctx.connection → Amplitude API auth

Query Transformation:
  edge.p.query: {from, to, visited}  (node IDs)
  → buildDslFromEdge()               (resolve)
  → dsl: {*_event_id}                (event names)
  → pre_request: funnel_steps        (transform)
  → Amplitude API: events array      (final format)
```

**KEY POINTS:**
- Query stores **node.id** (human-readable), NOT node.uuid
- BuildDslFromEdge resolves: node IDs → nodes → event_ids
- All 7 data sources converge in execution context
- UpdateManager applies results atomically back to graph

---

### 2.2 Key Transformations

**Node ID Resolution:**
```
query.from: "node-checkout"        (stored in edge.p.query)
  → graph.nodes.find(n => n.id === "node-checkout")
  → node.event_id: "checkout"      (extracted)
  → Amplitude API: event_type="checkout"
```

**Credentials Resolution:**
```
edge.p.connection: "amplitude-prod"
  → connections.yaml["amplitude-prod"].credsRef: "amplitude"
  → credentials.yaml["amplitude"]: {api_key: "..."}
  → Template: "Bearer {{credentials.api_key}}"
```

---

## 3. Architecture Decisions

### 3.1 Option C: Portable DAS Runner (SELECTED)

**Decision:** Build DAS Runner to work in both browser AND Node.js via dependency injection.

**Why:**
- Tests actual connection path that will scale to API mode
- No rewrite needed when moving to server-side (4-6 hrs to add server impls)
- Fast iteration in browser during development
- Can switch anytime by injecting different implementations

**What Changes by Environment:**
1. HTTP Requests: `fetch()` (browser) vs `node-fetch` (Node)
2. Connections: IndexedDB vs filesystem

**What's Already Portable:**
- ✅ CredentialsManager (IndexedDB + VITE_CREDENTIALS_JSON)
- ✅ UpdateManager (pure JS/TS, no Node dependencies)
- ✅ Template engine (Mustache)
- ✅ Data extraction (JMESPath, JSONata)

**Time Investment:**
- Abstraction layer: 3 hours (saves 1 hour - reusing CredentialsManager)
- Server migration: 3-4 hours (when needed)

---

## 4. File Architecture

### 4.1 Configuration Files

**credentials.yaml** (EXISTING - No changes)
- Location: IndexedDB only (never committed)
- Access: File > Credentials
- Purpose: Store authentication secrets
- Server-side: VITE_CREDENTIALS_JSON (full JSON as ENV_VAR)

**connections.yaml** (NEW)
- Location: IndexedDB + Git repo (safe to commit)
- Access: File > Connections
- Purpose: Non-secret configuration + DAS adapters
- Structure: Array of connection objects with embedded adapters

### 4.2 Schema Files

All in `/graph-editor/public/schemas/`:

- `connections-schema.json` - Validates connections.yaml
- `credentials-schema.json` - Validates credentials.yaml (existing)
- `graph-schema.json` - Updated with connection fields
- `parameter-schema.json` - Updated with connection/query/evidence
- `case-schema.json` - Updated with connection/evidence
- `node-schema.json` - Documents event_id field

### 4.3 Data Model Changes

**Graph:**
```typescript
graph.connection?: string;              // Graph-level connection
graph.connection_string?: string;       // Graph-level overrides
graph.evidence?: {...};                 // Graph-level evidence
```

**Parameter (edge.p):**
```typescript
connection?: string;                    // FK to connections.yaml
connection_string?: string;             // JSON blob (provider-specific)
query?: {                               // NEW: Query definition
  from: string;                         // Node ID
  to: string;
  visited?: string[];
  excluded?: string[];
};
evidence?: {                            // Fetch results
  n: number;
  k: number;
  window_from: string;
  window_to: string;
  source: string;
  fetched_at: string;
};
```

**Case:**
```typescript
connection?: string;
connection_string?: string;
evidence?: {
  source: string;
  fetched_at: string;
  variants: Array<{variant_id, allocation}>;
};
```

**Node:**
```typescript
event_id?: string;                      // Maps to external system event name
                                        // Optional in schema, validated at runtime
```

---

## 5. Security Architecture

### 5.1 Credentials Handling

**Browser Mode:**
1. User edits `credentials.yaml` via FormEditor
2. Stored in IndexedDB (never leaves browser)
3. DAS reads from IndexedDB at runtime
4. Never logged, masked in error messages

**Server Mode:**
1. Admin sets `VITE_CREDENTIALS_JSON` ENV variable
2. Full credentials object as JSON string
3. Optional: `VITE_CREDENTIALS_SECRET` for URL validation
4. CredentialsManager reads from `process.env`

**Precedence:**
```
1. URL credentials (?creds= or ?secret=)  ← Temporary
2. System Secret (VITE_CREDENTIALS_JSON)  ← Server-side
3. IndexedDB (credentials.yaml)           ← Browser-side
4. Public access (no credentials)
```

### 5.2 Secrets in Templates

**Allowed:**
```yaml
headers:
  Authorization: "Bearer {{credentials.api_key}}"  # ✅
```

**Forbidden:**
- Logging credential values
- Including credentials in evidence
- Exposing credentials in browser console (production)

**Masking Rules:**
- Error messages: Replace credential values with `***`
- Logs: Redact `{{credentials.*}}` interpolations
- Evidence: Store `source` (connection name), never credentials

---

## 6. UI Architecture

### 6.1 Graph-Level Selectors

**Window Selector** (NEW)
- Location: Floating at top-middle of graph canvas
- Widget: MUI DateRangePicker
- Default: Last 7 days
- State: GraphContext (runtime, NOT persisted in graph file)
- Synced across all tabs viewing same graph

**Context Selector** (STUBBED for v1)
- Shows "Context: None" with disabled dropdown
- Full integration deferred (contexts not yet systematic)

### 6.2 FormEditor for Connections

**Custom Widgets:**
- **TabbedArrayWidget**: Each connection in own sub-tab
- **MonacoWidget**: Code fields (JSON, YAML, JavaScript)
- **Connection Selector**: Dropdown in param/case editors

**Layout:**
```
[amplitude-prod] [sheets-metrics] [statsig-prod] [+ New]
───────────────
⚙️ Connection Defaults           [▼]
📋 Connection String Schema      [▶]
🔌 Adapter Configuration         [▶]
  1️⃣ Pre-Request Scripts         [▶]
  2️⃣ HTTP Request                [▼]
  3️⃣ Response Extraction         [▶]
  4️⃣ Transform Data              [▶]
  5️⃣ Upsert to Graph             [▶]
```

---

## 7. Scalability & Future Architecture

### 7.1 Browser → Server Migration (Phase 5+)

**Current (v1):**
```
User clicks "Get from source"
  → createDASRunner() (detects browser)
  → Uses BrowserHttpExecutor
  → Uses IndexedDB credentials
  → Executes in main thread
```

**Future (API Mode):**
```
User clicks "Get from source"
  → Client calls /api/das/execute
  → Server: createDASRunner() (detects Node)
  → Uses ServerHttpExecutor
  → Uses VITE_CREDENTIALS_JSON
  → Returns results to client
```

**Migration Effort: 3-4 hours** (no DAS Runner rewrite!)

### 7.2 Deferred to v2

- Pre_request JavaScript execution (sandbox)
- TypeScript adapter escape hatch
- Retries with exponential backoff
- Rate limiting
- Pagination support
- Advanced caching
- OAuth proxy for Google Sheets
- CLI validator for connections

---

## 8. Technology Stack

**Frontend:**
- React + TypeScript
- @rjsf/mui (FormEditor)
- @monaco-editor/react (code editing)
- MUI (UI components)
- Vitest (testing)

**Libraries:**
- Mustache (template engine)
- jmespath (data extraction)
- jsonata (data transformation)
- js-yaml (YAML parsing)

**Storage:**
- IndexedDB (Dexie.js)
- FileState (existing abstraction)

**API Integrations:**
- Amplitude Dashboard REST API
- Google Sheets API v4
- Statsig Console API
- SQL databases (Postgres, MySQL, Snowflake)

---

## 9. Quality Assurance

### 9.1 Testing Strategy

**Unit Tests (4-6 hours):**
- Template engine
- HttpExecutor
- ConnectionProvider
- Node resolution
- DAS Runner core

**Integration Tests (3-4 hours):**
- End-to-end flow
- Multi-connection scenarios
- Window/context handling
- Error handling

**Contract Tests (3-4 hours):**
- Amplitude adapter (golden fixtures)
- Google Sheets adapter
- Statsig adapter

**Coverage Goals:**
- Unit: 80% code coverage
- Integration: All critical paths
- Contract: All production adapters

### 9.2 Validation

**Schema Validation:**
- JSON Schema for connections.yaml
- JSON Schema for connection_string (per provider)
- Runtime validation before DAS execution

**Error Handling:**
- Missing event_id → Clear error with node name
- Missing credentials → List available credentials
- API failures → User-friendly messages with retry guidance

---

## 10. Deployment Architecture

### 10.1 v1: Browser-Side Execution

```
dagnet.vercel.app
├── /graph-editor/           (React SPA)
│   ├── IndexedDB
│   │   ├── credentials.yaml (local storage)
│   │   └── connections.yaml (synced with Git)
│   └── DAS Runner (runs in browser)
```

**Pros:**
- Fast iteration
- No server costs
- Simple deployment

**Cons:**
- CORS limitations (may need proxy)
- Client-side API keys (not ideal for production)
- Limited by browser resources

### 10.2 Future: Hybrid Deployment

```
dagnet.vercel.app
├── /graph-editor/           (React SPA)
└── /api/
    └── /das/
        └── /execute         (Vercel serverless function)
            └── DAS Runner (runs in Node)
                ├── VITE_CREDENTIALS_JSON (env var)
                └── connections.yaml (from filesystem)
```

**Pros:**
- No CORS issues
- Server-side credentials
- Better security
- Supports long-running queries

**Cons:**
- Serverless function costs
- Additional latency
- More complex debugging

---

## Summary

This architecture provides:
- ✅ Portable DAS Runner (browser + Node compatible)
- ✅ Secure credentials handling (existing CredentialsManager)
- ✅ Declarative adapters (YAML-based, no code changes)
- ✅ Reusable infrastructure (UpdateManager, FormEditor)
- ✅ Clear migration path to server-side
- ✅ Comprehensive testing strategy

**Estimated Timeline:** 59-77 hours for v1 with full test coverage

See: `IMPLEMENTATION_PLAN.md` for detailed phases and `DETAILED_DESIGN/` for component specs.

