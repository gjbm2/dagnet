# External Data System - Complete Design

**Date:** 2025-11-09  
**Status:** 🔵 Design Phase  
**Scope:** credentials.yaml + connections.yaml + DAS adapters + DAS Runner + UI integration

---

## 1. Overview

### 1.1 Purpose
Enable users to fetch data from external sources (Amplitude, SQL databases, Google Sheets) and update graph parameters declaratively, without writing code.

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

### Key Design Decisions

1. **Single connections.yaml file** - Contains both connection config AND adapter specs (not separate files)
2. **Adapter = part of connection** - Each connection defines how to fetch data from that source
3. **Tab-level selectors** - Window and context are UI state, not per-parameter
4. **Credentials separate** - Keep secrets in credentials.yaml (existing pattern)

### 1.2 Complete Data Flow Schematic

**Shows ALL 7 data inputs and how they flow through the system:**

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

## 2. File Specifications

### 2.1 credentials.yaml (EXISTING - Already Implemented)

**Location:** IndexedDB only, never committed  
**Access:** File > Credentials  
**Purpose:** Store authentication secrets

```yaml
version: 1.0.0

# Amplitude credentials
amplitude:
  apiKey: "secret-api-key-xyz"
  secretKey: "secret-key-abc"

# Git credentials (existing)
git:
  - name: <private-repo>
    owner: regulus
    token: "github-pat-xyz"
    isDefault: true

# PostgreSQL credentials
warehouse:
  dsn: "postgresql://user:pass@host:5432/db"

# Google Sheets credentials
googleSheets:
  # OAuth token (for user-based access)
  token: "oauth-token"
  
  # Service Account (for server-to-server access)
  # Google provides a .json file - we store it base64-encoded
  serviceAccount: "eyJ0eXBlIjoic2VydmljZV9hY2NvdW50IiwicHJvamVjdF9pZCI6Im15LXByb2plY3QiLCJwcml2YXRlX2tleSI6Ii0tLS0tQkVHSU4gUFJJVkFURSBLRVktLS0tLVxuLi4uXG4tLS0tLUVORCBQUklWQVRFIEtFWS0tLS0tXG4iLC4uLn0="
  
  # Alternative: Store as JSON string (if not too large)
  # serviceAccountJson: '{"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}'
```

**Service Account Pattern:**
1. User gets `service-account.json` from Google Cloud Console
2. Base64 encode: `base64 service-account.json` → store in `serviceAccount` field
3. DAS adapter decodes at runtime:
   ```typescript
   // In browser:
   const decoded = atob(credentials.googleSheets.serviceAccount);
   const serviceAccount = JSON.parse(decoded);
   
   // In Node:
   const decoded = Buffer.from(credentials.googleSheets.serviceAccount, 'base64').toString();
   const serviceAccount = JSON.parse(decoded);
   ```
4. Use `serviceAccount` for Google API authentication

**No changes needed** - this already exists and works with the proposed pattern.

---

### 2.2 connections.yaml (NEW - Includes Adapters)

**Location:** IndexedDB + Git repo (safe to commit)  
**Access:** File > Connections  
**Purpose:** Non-secret configuration + fetch/transform logic

**Integrates with existing schema:**
- Graph/parameter schemas already have `source.connection_id` field
- This references `connections.yaml` by connection name
- `connection.connection_settings` is a JSON blob specific to each provider

```yaml
version: 1.0.0

connections:
  # Amplitude Production
  - name: amplitude-prod
    provider: amplitude
    kind: http
    credsRef: amplitude          # References credentials.yaml
    description: Amplitude production analytics
    enabled: true
    
    # Non-secret defaults (applied to ALL queries)
    defaults:
      base_url: https://api.amplitude.com
      project_id: "12345"
      timeout_ms: 30000
      rate_limit_rpm: 50
      # Global filters applied to ALL Amplitude queries
      exclude_test_users: true
      test_user_ids: ["test@company.com", "dev@company.com"]
    
    # Connection string schema - for param-specific overrides
    # NOTE: event_from/event_to come from parameter definition, NOT here
    connection_string_schema:
      type: object
      description: "Optional param-specific overrides"
      properties:
        segment_filter:
          type: string
          description: "Optional segment filter for this specific parameter"
          examples: ["mobile_users", "premium_users"]
      additionalProperties: false
    
    # Adapter spec (integrated, not separate file)
    adapter:
      # TRANSFORMATION STEP: Build funnel from resolved event_ids
      pre_request:
        # Construct full funnel path: visited → from → to
        - name: funnel_steps
          script: |
            const visited = dsl.visited_event_ids || [];  // Already resolved to event_ids!
            const steps = [...visited, dsl.from_event_id, dsl.to_event_id];
            return steps;
        
        # Find index of from_event_id (for extracting correct step later)
        - name: from_step_index
          script: |
            return funnel_steps.indexOf(dsl.from_event_id);
      
      # How to build request
      request:
        method: POST  # Funnel queries are usually POST
        path_template: /api/2/funnels
        headers:
          Authorization: Bearer {{ credentials.api_key }}
          Content-Type: application/json
        body_template: |
          {
            "project_id": "{{ connection.defaults.project_id }}",
            "events": {{ funnel_steps | map(e => {"event_type": e}) | json }},
            "start": "{{ window.start }}",
            "end": "{{ window.end }}",
            "filters": {
              "segment": "{{ connection_string.segment_filter }}",
              "exclude_test_users": {{ connection.defaults.exclude_test_users }}
            }
          }
        retry:
          max_attempts: 3
          backoff_ms: 1000
      
      # What to extract from response
      response:
        ok_when:
          - jmes: "status == 'success'"
        
        extract:
          # Extract the specific step we care about (from → to)
          - name: from_step
            jmes: "data.steps[{{ from_step_index }}]"
          - name: to_step
            jmes: "data.steps[{{ from_step_index + 1 }}]"
          
          # Extract counts
          - name: from_count
            jmes: "from_step.count"
          - name: to_count
            jmes: "to_step.count"
          
          # Sample size (users who entered the funnel)
          - name: sample_size
            jmes: "data.steps[0].count"
      
      # How to transform extracted data
      transform:
        - name: p_mean
          jsonata: "$number(to_count) / $max([$number(from_count), 1])"
        - name: p_stdev
          jsonata: "$sqrt(p_mean * (1 - p_mean) / $max([from_count, 1]))"
      
      # Where to write results in graph
      upsert:
        mode: merge
        writes:
          - target: /edges/{{ edgeId }}/p/mean
            value: "{{ p_mean }}"
          - target: /edges/{{ edgeId }}/p/stdev
            value: "{{ p_stdev }}"
          - target: /edges/{{ edgeId }}/p/distribution
            value: beta
          - target: /edges/{{ edgeId }}/p/evidence/n
            value: "{{ sample_size }}"
          - target: /edges/{{ edgeId }}/p/evidence/k
            value: "{{ total_conversions }}"
          - target: /edges/{{ edgeId }}/p/evidence/window_from
            value: "{{ window.start }}"
          - target: /edges/{{ edgeId }}/p/evidence/window_to
            value: "{{ window.end }}"
          - target: /edges/{{ edgeId }}/p/evidence/context_id
            value: "{{ context.id }}"
          - target: /edges/{{ edgeId }}/p/evidence/source
            value: "{{ connection.name }}"
          - target: /edges/{{ edgeId }}/p/evidence/fetched_at
            value: "{{ now() }}"
    
    tags:
      - production
      - read-only
    
    metadata:
      created_at: "2025-11-09T00:00:00Z"
      created_by: System Default

  # PostgreSQL Warehouse
  - name: warehouse-ro
    provider: postgres
    kind: sql
    credsRef: warehouse
    description: Analytics data warehouse (read-only)
    enabled: true
    
    defaults:
      dataset: analytics
      timeout_ms: 60000
    
    # Connection string schema for SQL
    connection_string_schema:
      type: object
      description: "Schema for SQL connection settings"
      properties:
        table:
          type: string
          description: "Table name"
        from_column:
          type: string
          description: "Column for source node"
        to_column:
          type: string
          description: "Column for target node"
      required: [table, from_column, to_column]
      examples:
        - table: "conversion_events"
          from_column: "source_event"
          to_column: "target_event"
    
    adapter:
      request:
        query: |
          SELECT
            $1::text AS from_node,
            $2::text AS to_node,
            COUNT(*) AS total_attempts,
            SUM(CASE WHEN success THEN 1 ELSE 0 END) AS total_conversions,
            COUNT(*) AS sample_size
          FROM events
          WHERE ts >= $3::timestamptz
            AND ts < $4::timestamptz
            AND from_node = $1::text
            AND to_node = $2::text
            AND ($5 IS NULL OR context_id = $5::text)
            AND ($6::int = 0 OR EXISTS (
                  SELECT 1 FROM path p
                  WHERE p.session_id = events.session_id
                    AND p.node = ANY($7::text[])
                ))
            AND NOT (node = ANY($8::text[]))
          GROUP BY from_node, to_node
        params:
          - "{{ dsl.from }}"
          - "{{ dsl.to }}"
          - "{{ window.start }}"
          - "{{ window.end }}"
          - "{{ context.id || null }}"
          - "{{ dsl.visited.length || 0 }}"
          - "{{ array(dsl.visited) }}"
          - "{{ array(dsl.excluded) }}"
      
      response:
        extract:
          - name: total_attempts
            jmes: "[0].total_attempts"
          - name: total_conversions
            jmes: "[0].total_conversions"
          - name: sample_size
            jmes: "[0].sample_size"
      
      transform:
        - name: p_mean
          jsonata: "$number(total_conversions) / $max([$number(total_attempts), 1])"
        - name: p_stdev
          jsonata: "$sqrt(p_mean * (1 - p_mean) / $max([sample_size, 1]))"
      
      upsert:
        mode: merge
        writes:
          - target: /edges/{{ edgeId }}/p/mean
            value: "{{ p_mean }}"
          - target: /edges/{{ edgeId }}/p/stdev
            value: "{{ p_stdev }}"
          - target: /edges/{{ edgeId }}/p/distribution
            value: beta
          - target: /edges/{{ edgeId }}/p/evidence/n
            value: "{{ sample_size }}"
          - target: /edges/{{ edgeId }}/p/evidence/k
            value: "{{ total_conversions }}"
          - target: /edges/{{ edgeId }}/p/evidence/window_from
            value: "{{ window.start }}"
          - target: /edges/{{ edgeId }}/p/evidence/window_to
            value: "{{ window.end }}"
          - target: /edges/{{ edgeId }}/p/evidence/context_id
            value: "{{ context.id }}"
          - target: /edges/{{ edgeId }}/p/evidence/source
            value: "{{ connection.name }}"
          - target: /edges/{{ edgeId }}/p/evidence/fetched_at
            value: "{{ now() }}"
    
    tags:
      - sql
      - production
      - read-only

  # Google Sheets
  - name: sheets-metrics
    provider: google-sheets
    kind: http
    credsRef: googleSheets
    description: Manual parameter overrides from spreadsheet
    enabled: true
    
    defaults:
      timeout_ms: 15000
    
    # Connection string schema for Google Sheets
    connection_string_schema:
      type: object
      description: "Schema for Google Sheets connection settings"
      properties:
        spreadsheet_id:
          type: string
          description: "Google Sheets ID from URL"
        sheet_name:
          type: string
          description: "Sheet tab name"
        range:
          type: string
          description: "Cell range (e.g., A1:B10)"
      required: [spreadsheet_id, range]
      examples:
        - spreadsheet_id: "1abc123xyz"
          sheet_name: "Parameters"
          range: "A2:E100"
    
    adapter:
      request:
        method: GET
        path_template: /v4/spreadsheets/{{ connection_settings.spreadsheet_id }}/values/{{ connection_settings.range }}
        headers:
          Authorization: Bearer {{ connection.token }}
      response:
        extract:
          - name: values
            jmes: "values"
      # ... transform and upsert logic for sheet data

  # Statsig (for case nodes / variant weights)
  - name: statsig-prod
    provider: statsig
    kind: http
    credsRef: statsig
    description: Statsig feature gates and experiments
    enabled: true
    
    defaults:
      base_url: https://api.statsig.com/v1
      environment: production  # Global default environment
      timeout_ms: 10000
    
    # Connection string schema - for case-specific overrides
    connection_string_schema:
      type: object
      description: "Optional case-specific overrides"
      properties:
        gate_id:
          type: string
          description: "Statsig gate/experiment ID (if different from case_id)"
        environment_override:
          type: string
          enum: [production, staging, development]
          description: "Override default environment for this specific case"
      additionalProperties: false
    
    adapter:
      request:
        method: POST
        path_template: /gates/{{ connection_string.gate_id || case.case_id }}
        headers:
          Authorization: "Bearer {{ credentials.api_key }}"
          STATSIG-API-KEY: "{{ credentials.api_key }}"
          Content-Type: application/json
        body_template: |
          {
            "environment": "{{ connection_string.environment_override || connection.defaults.environment }}"
          }
      
      response:
        extract:
          - name: variants
            jmes: "data.variants"
        
        transform:
          # Transform Statsig variant format to DagNet case variant format
          - input: variants
            output: case_variants
            script: |
              variants.map(v => ({
                variant_id: v.id,
                name: v.name,
                weight: v.allocation_percent / 100,
                description: v.description
              }))
        
        upsert:
          - target: /case/variants
            source: case_variants
            merge_strategy: replace
    
    tags:
      - experimentation
      - production

  # Amplitude Dev (same provider, different project)
  - name: amplitude-dev
    provider: amplitude
    kind: http
    credsRef: amplitude
    description: Amplitude dev environment
    enabled: true
    
    defaults:
      base_url: https://api.amplitude.com
      project_id: "67890"    # Different project ID
      timeout_ms: 30000
      exclude_test_users: false  # Don't exclude in dev
    
    # Same connection_string_schema as amplitude-prod
    connection_string_schema:
      type: object
      description: "Optional param-specific overrides"
      properties:
        segment_filter:
          type: string
          description: "Optional segment filter for this specific parameter"
      additionalProperties: false
    
    adapter:
      # Same adapter spec as amplitude-prod
      # (Could also reference a shared adapter template in future)
      request:
        method: GET
        path_template: /api/2/funnels
        # ... same as amplitude-prod
```

**Key Points:**
- ✅ Single file, not scattered across directories
- ✅ Adapter spec is part of connection (integrated)
- ✅ Safe to commit (no secrets)
- ✅ Can have multiple connections per provider (prod/dev)
- ✅ References credentials via `credsRef`

---

## 3. Integration with Existing Schemas

### 3.1 Existing Graph/Parameter Schema Fields

**Already in place** (from Phase 0 work):

#### Simplified Schema (Graph `edge.p` and Parameter)

**SIMPLIFIED - Just 2 fields:**

```typescript
edge.p = {
  mean: number;
  stdev: number;
  parameter_id?: string;           // ← Links to parameter file (optional)
  
  // For direct external data connection:
  connection?: string;              // ← Connection name from connections.yaml
  connection_string?: string;       // ← JSON blob (provider-specific settings)
  
  // Evidence from last fetch:
  evidence?: {
    n: number;                      // Sample size
    k: number;                      // Successes
    window_from: string;            // ISO date
    window_to: string;              // ISO date
    source: string;                 // Connection name
    fetched_at: string;             // ISO timestamp
  };
}
```

**Same for parameter files:**
```yaml
# In parameter file:
connection: amplitude-prod  # ← Connection name from connections.yaml
connection_string: |        # ← JSON blob validated by connection's schema
  {
    "event_from": "checkout",
    "event_to": "purchase",
    "visited": ["view_product"]
  }

values:
  - mean: 0.45
    stdev: 0.02
    # ...
```

### 3.2 How It Works

**Flow:**
1. User selects connection in UI dropdown (lists available connections)
2. UI looks up connection in `connections.yaml`
3. UI shows form based on `connection_string_schema`
4. User fills in: `event_from: "checkout"`, `event_to: "purchase"`
5. System stores as JSON blob in `connection_string`

**Example:**
```yaml
# In graph edge:
p:
  mean: 0.45
  stdev: 0.02
  connection: amplitude-prod           # ← Which connection
  connection_string: |                 # ← Provider-specific settings
    {"event_from": "checkout", "event_to": "purchase"}
  evidence:
    n: 10000
    k: 4500
    source: amplitude-prod
    fetched_at: "2025-11-09T10:00:00Z"
```

**UI Behavior:**
- `connection` is a dropdown/autocomplete from available connections
- `connection_string` shows a dynamic form based on the selected connection's `connection_string_schema`
- On save, form data is serialized to JSON blob

### 3.3 Schema Changes Required

**Update parameter-schema.yaml:**
```yaml
# REMOVE these (too verbose):
# source:
#   type: string
#   connection_id: string
#   notes: string
# connection:
#   source_type: string
#   connection_settings: string

# REPLACE with:
connection:
  type: string
  description: "Connection name from connections.yaml"

connection_string:
  type: string
  description: "JSON blob with provider-specific settings"

# ADD query definition (for Amplitude and similar providers)
query:
  type: object
  description: "Query definition for data retrieval - stores node references"
  properties:
    from:
      type: string
      description: "Source node ID or UUID"
    to:
      type: string
      description: "Target node ID or UUID"
    visited:
      type: array
      items: { type: string }
      description: "Node IDs/UUIDs that must have been visited (optional)"
    excluded:
      type: array
      items: { type: string }
      description: "Node IDs/UUIDs that must NOT have been visited (optional)"
```

**Example parameter file:**
```yaml
# parameters/checkout-to-purchase.yaml
name: Checkout to Purchase Conversion
connection: amplitude-prod
connection_string: |
  {"segment_filter": "mobile_users"}

query:
  from: "node-checkout"              # ← node ID/UUID, not event_id
  to: "node-purchase"                # ← node ID/UUID, not event_id
  visited: ["node-product-view"]     # ← node ID/UUID
  excluded: []

values:
  - mean: 0.45
    stdev: 0.02
    evidence:
      n: 10000
      k: 4500
      window_from: "2025-01-01"
      window_to: "2025-01-31"
      source: amplitude-prod
      fetched_at: "2025-01-31T12:00:00Z"
```

**Update graph schema (conversion-graph-1.0.0.json):**
```json
{
  "ProbabilityParam": {
    "properties": {
      "mean": {"type": "number"},
      "stdev": {"type": "number"},
      "parameter_id": {"type": "string"},
      
      // ADD these fields:
      "connection": {
        "type": "string",
        "description": "Connection name from connections.yaml"
      },
      "connection_string": {
        "type": "string", 
        "description": "JSON blob with provider-specific settings"
      },
      "query": {
        "type": "object",
        "description": "Query definition for data retrieval - stores node references",
        "properties": {
          "from": {"type": "string", "description": "Source node ID/UUID"},
          "to": {"type": "string", "description": "Target node ID/UUID"},
          "visited": {"type": "array", "items": {"type": "string"}, "description": "Visited node IDs/UUIDs"},
          "excluded": {"type": "array", "items": {"type": "string"}, "description": "Excluded node IDs/UUIDs"}
        }
      },
      
      // REMOVE old data_source object (too complex)
      "evidence": { /* existing */ }
    }
  }
}
```

**Graph edge example:**
```json
{
  "from": "node-checkout-uuid",
  "to": "node-purchase-uuid",
  "p": {
    "mean": 0.45,
    "stdev": 0.02,
    "connection": "amplitude-prod",
    "connection_string": "{\"segment_filter\": \"mobile_users\"}",
    "query": {
      "from": "node-checkout-uuid",        // ← Node reference (can be same as edge.from)
      "to": "node-purchase-uuid",          // ← Node reference (can be same as edge.to)
      "visited": ["node-product-view-uuid"]  // ← Node references
    },
    "evidence": {
      "n": 10000,
      "k": 4500,
      "source": "amplitude-prod",
      "fetched_at": "2025-01-31T12:00:00Z"
    }
  }
}
```

**CRITICAL:** The query stores NODE references, not event_ids directly!

```json
// Node definitions
{
  "uuid": "node-checkout-uuid",
  "id": "node-checkout",           // Human-readable ID
  "event_id": "checkout",          // ← What Amplitude uses
  "label": "Checkout Page"
}
{
  "uuid": "node-product-view-uuid",
  "id": "node-product-view",
  "event_id": "view_product",      // ← What Amplitude uses
  "label": "Product Page"
}

// Edge with query
{
  "from": "node-checkout-uuid",
  "to": "node-purchase-uuid",
  "p": {
    "query": {
      "from": "node-checkout-uuid",        // ← Node ref, NOT event_id!
      "to": "node-purchase-uuid",          // ← Node ref, NOT event_id!
      "visited": ["node-product-view-uuid"] // ← Node ref, NOT event_id!
    }
  }
}
```

**Data Flow: Query → Node Lookup → Event IDs → Adapter**

```
1. User: Right-click edge, "Get from file"
   
2. System: Read query from edge.p.query
   query = {
     from: "node-checkout-uuid",
     to: "node-purchase-uuid",
     visited: ["node-product-view-uuid"]
   }
   
3. System: Look up nodes by their IDs/UUIDs
   fromNode = graph.nodes.find(n => n.uuid === query.from || n.id === query.from)
   toNode = graph.nodes.find(n => n.uuid === query.to || n.id === query.to)
   visitedNodes = query.visited.map(ref => graph.nodes.find(n => n.uuid === ref || n.id === ref))
   
4. System: Extract event_ids from nodes
   from_event_id = fromNode.event_id        // "checkout"
   to_event_id = toNode.event_id            // "purchase"
   visited_event_ids = visitedNodes.map(n => n.event_id)  // ["view_product"]
   
5. System: Build execution DSL with event_ids
   dsl = {
     from_event_id: "checkout",
     to_event_id: "purchase",
     visited_event_ids: ["view_product"]
   }
   
6. Adapter: Use event_ids in Amplitude funnel
   funnel_steps = [...dsl.visited_event_ids, dsl.from_event_id, dsl.to_event_id]
   // Result: ["view_product", "checkout", "purchase"]
   // These are Amplitude event names, not node IDs!
```

**Why this indirection?**
- **Query stores**: Node references (graph-level identifiers)
- **Nodes have**: `event_id` field (maps to external system events)
- **Amplitude needs**: Event names (e.g., "checkout"), not node UUIDs
- **`buildDslFromEdge()`**: Resolves node refs → looks up nodes → extracts event_ids

**Same pattern applies to:**
- `edge.cost_gbp` (cost parameters)
- `edge.cost_time` (time parameters)  
- `node.case` (case node parameters)

---

## 4. Schema Design

### 4.1 Connection String Schema - UI Form Generation

**Key Concept:** Each connection defines `connection_string_schema`, which drives dynamic form generation in the UI.

**Example 1: Amplitude Connection**

```yaml
# In connections.yaml
connections:
  - name: amplitude-prod
    provider: amplitude
    kind: http
    credsRef: amplitude
    description: Amplitude production analytics
    enabled: true
    
    defaults:
      base_url: https://api.amplitude.com
      project_id: "12345"
      environment: production
      # Global filters applied to ALL queries from this connection
      exclude_test_users: true
      test_user_ids: ["test@company.com", "dev@company.com"]
    
    # connection_string_schema: For param-specific overrides
    # (Amplitude usually doesn't need param-specific settings)
    connection_string_schema:
      type: object
      properties:
        segment_filter:
          type: string
          description: "Optional segment filter for this specific parameter"
          examples: ["mobile_users", "premium_users"]
      additionalProperties: false
    
    adapter:
      # ... (adapter spec - see section 6)
```

**Key Point:** `event_from` and `event_to` are NOT in connection_string!
- They come from the **parameter/edge definition** (the query)
- `connection_string` is for param-specific specializations only

**UI Implementation: Modal with FormEditor**

```typescript
// In PropertiesPanel for edge
<div>
  <label>Connection</label>
  <select value={connection} onChange={handleConnectionChange}>
    {connections.map(c => <option value={c.name}>{c.name}</option>)}
  </select>
  
  <button onClick={() => setShowConnectionDialog(true)}>
    Configure Connection...
  </button>
  
  {/* Show summary of current connection_string */}
  {connection_string && (
    <div className="connection-summary">
      event_from: "checkout" → event_to: "purchase"
    </div>
  )}
</div>

{/* Modal Dialog */}
<Dialog open={showConnectionDialog} onClose={() => setShowConnectionDialog(false)}>
  <DialogTitle>Configure {connection}</DialogTitle>
  <DialogContent>
    {/* FormEditor unpacks JSON, provides form, re-encodes on save */}
    <FormEditor 
      schema={selectedConnection.connection_string_schema}
      data={JSON.parse(connection_string || '{}')}
      onChange={(data) => setConnectionString(JSON.stringify(data))}
    />
  </DialogContent>
  <DialogActions>
    <Button onClick={() => setShowConnectionDialog(false)}>Cancel</Button>
    <Button onClick={handleSave} variant="primary">Save</Button>
  </DialogActions>
</Dialog>
```

**Flow:**
1. User selects connection from dropdown
2. User clicks "Configure Connection..." button
3. Modal opens with FormEditor
4. FormEditor unpacks `connection_string` JSON
5. User edits via form fields
6. On save, FormEditor re-encodes to JSON string
7. Modal closes, summary shown in properties panel

**Result stored as:**
```json
{
  "connection": "amplitude-prod",
  "connection_string": "{\"event_from\":\"checkout\",\"event_to\":\"purchase\"}"
}
```

**Example 2: Google Sheets Connection**

```yaml
# In connections.yaml
connections:
  - name: sheets-metrics
    provider: google-sheets
    kind: http
    credsRef: googleSheets
    description: Manual parameter overrides from spreadsheet
    enabled: true
    
    defaults:
      timeout_ms: 15000
    
    # connection_string_schema: PARAM-SPECIFIC (which sheet, which range)
    connection_string_schema:
      type: object
      properties:
        spreadsheet_id:
          type: string
          description: "Spreadsheet ID from URL"
          pattern: "^[a-zA-Z0-9_-]+$"
        sheet_name:
          type: string
          description: "Sheet tab name (optional)"
        range:
          type: string
          description: "Cell range"
          examples: ["A1:B10", "Sheet1!A2:E100"]
      required: [spreadsheet_id, range]
      additionalProperties: false
    
    adapter:
      # ... (adapter spec)
```

**UI renders:**
```
┌─────────────────────────────────────┐
│ Connection: [sheets-metrics ▼]     │
│                                     │
│ Spreadsheet ID: [1abc123xyz  ]     │  ← Param-specific
│ Sheet Name:     [Parameters  ]     │  ← Param-specific
│ Range:          [A2:E100     ]     │  ← Param-specific
└─────────────────────────────────────┘
```

**Why connection_string here?**
- Each parameter might come from a different sheet/range
- This is param-specific configuration, not global defaults

**Example 3: Statsig Connection (for Case Nodes)**

```yaml
# In connections.yaml
connections:
  - name: statsig-prod
    provider: statsig
    kind: http
    credsRef: statsig
    description: Statsig feature gates and experiments
    enabled: true
    
    defaults:
      base_url: https://api.statsig.com/v1
      environment: production  # or staging, development
      timeout_ms: 10000
    
    # connection_string_schema: For case-specific overrides
    connection_string_schema:
      type: object
      properties:
        gate_id:
          type: string
          description: "Statsig gate/experiment ID (if different from case_id)"
        environment_override:
          type: string
          enum: [production, staging, development]
          description: "Override default environment for this specific case"
      additionalProperties: false
    
    adapter:
      request:
        method: POST
        path_template: /gates/{{ connection_string.gate_id || case.case_id }}
        headers:
          Authorization: "Bearer {{ credentials.api_key }}"
          STATSIG-API-KEY: "{{ credentials.api_key }}"
        body_template: |
          {
            "environment": "{{ connection_string.environment_override || connection.defaults.environment }}"
          }
      
      response:
        extract:
          - name: variants
            jmes: "data.variants"
        
        transform:
          # Transform Statsig variant format to DagNet case variant format
          - input: variants
            output: case_variants
            script: |
              variants.map(v => ({
                variant_id: v.id,
                name: v.name,
                weight: v.allocation_percent / 100,
                description: v.description
              }))
        
        upsert:
          - target: /case/variants
            source: case_variants
            merge_strategy: replace
```

**Usage for Case Node:**

```yaml
# In case file or graph node
case:
  case_id: "checkout_flow_experiment"
  connection: statsig-prod
  connection_string: |
    {
      "gate_id": "checkout_flow_experiment"
    }
  
  variants:
    - variant_id: control
      name: "Control"
      weight: 0.5
    - variant_id: treatment_a
      name: "Treatment A"
      weight: 0.3
    - variant_id: treatment_b
      name: "Treatment B"
      weight: 0.2
```

**Flow when user clicks "Get from source" on case node:**
1. System reads `case.connection` → "statsig-prod"
2. Looks up connection in connections.yaml
3. Parses `connection_string` → gate_id
4. Builds request using adapter:
   - URL: `https://api.statsig.com/v1/gates/checkout_flow_experiment`
   - Auth: From credentials.yaml (via credsRef)
   - Body: `{"environment": "production"}`
5. Fetches variant weights from Statsig
6. Upserts into `case.variants`

### 4.2 Architecture Summary: What Goes Where?

**3 Levels of Configuration:**

| Level | Purpose | Example (Amplitude) | Example (Statsig) |
|-------|---------|---------------------|-------------------|
| **Connection Defaults** | Global settings for ALL queries | `environment: production`<br>`exclude_test_users: true` | `environment: production`<br>`base_url: ...` |
| **Connection String** | Param/case-specific config | `segment_filter: "mobile_users"` (optional) | `gate_id: "my_experiment"`<br>`environment_override: "staging"` |
| **Parameter/Case Definition** | The actual query/data | `event_from: "checkout"`<br>`event_to: "purchase"` | `case_id: "checkout_experiment"` |

**Key Insight:**
- Connection string is **NOT** the query itself
- It's for param-specific **configuration/overrides**
- The query comes from the parameter/edge/case definition

**Examples:**
- **Amplitude**: Usually doesn't need connection_string (query is in parameter)
- **Google Sheets**: NEEDS connection_string (which sheet? which range?)
- **Statsig**: MAY use connection_string (gate_id override, environment override)

### 4.3 UI Schema for connections.yaml

**Challenge:** connections.yaml is complex with nested adapter specs - needs excellent UI schema for FormEditor navigation.

**Library:** Uses @rjsf/mui (React JSON Schema Form) with custom widgets  
**Code Editor:** Monaco Editor via @monaco-editor/react (already used in RawView)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Connections UI Schema",
  
  "ui:rootFieldset": "vertical",
  
  "connections": {
    "ui:widget": "TabbedArrayWidget",
    "ui:options": {
      "orderable": true,
      "removable": true,
      "addable": true,
      "tabField": "name",
      "addButtonText": "+ New Connection"
    },
    "ui:help": "Each connection appears in its own sub-tab within FormEditor",
    
    "items": {
      "ui:layout": "accordion",
      "ui:order": [
        "name",
        "provider", 
        "kind",
        "enabled",
        "description",
        "credsRef",
        "defaults",
        "connection_string_schema",
        "adapter",
        "tags",
        "metadata"
      ],
      
      "name": {
        "ui:widget": "text",
        "ui:autofocus": true,
        "ui:placeholder": "e.g., amplitude-prod",
        "ui:help": "Unique identifier for this connection (lowercase, hyphens)",
        "ui:validation": {
          "pattern": "^[a-z0-9][a-z0-9-]*[a-z0-9]$"
        }
      },
      
      "provider": {
        "ui:widget": "select",
        "ui:help": "Data source type",
        "ui:enumLabels": {
          "amplitude": "Amplitude Analytics",
          "postgres": "PostgreSQL",
          "mysql": "MySQL",
          "snowflake": "Snowflake",
          "google-sheets": "Google Sheets",
          "statsig": "Statsig",
          "custom": "Custom HTTP API"
        }
      },
      
      "kind": {
        "ui:widget": "radio",
        "ui:help": "Connection protocol",
        "ui:inline": true
      },
      
      "enabled": {
        "ui:widget": "checkbox",
        "ui:help": "Disable to temporarily stop using this connection"
      },
      
      "description": {
        "ui:widget": "textarea",
        "ui:options": {
          "rows": 2
        },
        "ui:help": "Brief description of what this connection is for"
      },
      
      "credsRef": {
        "ui:widget": "CredentialsSelector",
        "ui:help": "References credentials.yaml - secrets stored separately",
        "ui:options": {
          "showPreview": false
        }
      },
      
      "defaults": {
        "ui:widget": "object",
        "ui:collapsed": false,
        "ui:title": "⚙️ Connection Defaults",
        "ui:help": "Non-secret defaults applied to all queries (project IDs, base URLs, global filters)",
        "ui:ObjectFieldTemplate": "KeyValuePairs",
        "ui:options": {
          "expandable": true,
          "addButtonText": "+ Add Default"
        }
      },
      
      "connection_string_schema": {
        "ui:title": "📋 Connection String Schema",
        "ui:collapsed": true,
        "ui:help": "Defines param-specific settings users can configure per-parameter",
        "ui:widget": "MonacoWidget",
        "ui:options": {
          "language": "json",
          "height": "300px",
          "minimap": false,
          "lineNumbers": "on",
          "formatOnBlur": true,
          "validateJSON": true
        }
      },
      
      "adapter": {
        "ui:title": "🔌 Adapter Configuration",
        "ui:collapsed": true,
        "ui:help": "Defines how to fetch and transform data from this source",
        "ui:layout": "sections",
        
        "pre_request": {
          "ui:title": "1️⃣ Pre-Request Scripts",
          "ui:collapsed": true,
          "ui:help": "Transform query before making request (e.g., build funnel steps)",
          "items": {
            "name": {
              "ui:help": "Variable name available in later phases",
              "ui:placeholder": "e.g., funnel_steps"
            },
            "script": {
              "ui:widget": "MonacoWidget",
              "ui:options": {
                "language": "javascript",
                "height": "150px",
                "minimap": false,
                "lineNumbers": "on",
                "theme": "vs-light"
              }
            }
          }
        },
        
        "request": {
          "ui:title": "2️⃣ HTTP Request",
          "ui:collapsed": false,
          "ui:help": "How to build the API request",
          
          "method": {
            "ui:widget": "radio",
            "ui:inline": true,
            "ui:enumLabels": {
              "GET": "GET",
              "POST": "POST",
              "PUT": "PUT"
            }
          },
          
          "path_template": {
            "ui:widget": "TemplateEditor",
            "ui:help": "URL path with template variables: {{variable}}",
            "ui:placeholder": "/api/2/funnels",
            "ui:options": {
              "syntaxHighlight": true,
              "showVariables": true
            }
          },
          
          "headers": {
            "ui:widget": "object",
            "ui:ObjectFieldTemplate": "KeyValuePairs",
            "ui:help": "HTTP headers - use {{credentials.api_key}} for secrets",
            "ui:options": {
              "addButtonText": "+ Add Header"
            }
          },
          
          "query": {
            "ui:widget": "object",
            "ui:ObjectFieldTemplate": "KeyValuePairs",
            "ui:help": "Query string parameters",
            "ui:options": {
              "addButtonText": "+ Add Query Param"
            }
          },
          
          "body_template": {
            "ui:widget": "MonacoWidget",
            "ui:help": "Request body (for POST/PUT) with template variables",
            "ui:options": {
              "language": "json",
              "height": "200px",
              "minimap": false,
              "lineNumbers": "on",
              "formatOnBlur": true,
              "validateJSON": false
            }
          },
          
          "retry": {
            "ui:collapsed": true,
            "max_attempts": {
              "ui:widget": "updown",
              "ui:help": "Number of retry attempts on failure"
            },
            "backoff_ms": {
              "ui:widget": "updown",
              "ui:help": "Milliseconds between retries"
            }
          }
        },
        
        "response": {
          "ui:title": "3️⃣ Response Extraction",
          "ui:collapsed": true,
          "ui:help": "Extract data from API response using JMESPath",
          
          "ok_when": {
            "ui:help": "Conditions for successful response",
            "items": {
              "jmes": {
                "ui:widget": "MonacoWidget",
                "ui:help": "JMESPath expression that should evaluate to true",
                "ui:placeholder": "status == 'success'",
                "ui:options": {
                  "language": "plaintext",
                  "height": "40px",
                  "minimap": false,
                  "lineNumbers": "off",
                  "scrollBeyondLastLine": false,
                  "wordWrap": "on"
                }
              }
            }
          },
          
          "extract": {
            "ui:help": "Extract values from response",
            "items": {
              "name": {
                "ui:help": "Variable name for extracted value",
                "ui:placeholder": "e.g., from_count"
              },
              "jmes": {
                "ui:widget": "MonacoWidget",
                "ui:help": "JMESPath to extract value",
                "ui:placeholder": "data.steps[0].count",
                "ui:options": {
                  "language": "plaintext",
                  "height": "40px",
                  "minimap": false,
                  "lineNumbers": "off",
                  "scrollBeyondLastLine": false,
                  "wordWrap": "on"
                }
              }
            }
          }
        },
        
        "transform": {
          "ui:title": "4️⃣ Transform Data",
          "ui:collapsed": true,
          "ui:help": "Calculate derived values using JSONata",
          "items": {
            "name": {
              "ui:help": "Variable name for calculated value",
              "ui:placeholder": "e.g., p_mean"
            },
            "jsonata": {
              "ui:widget": "MonacoWidget",
              "ui:help": "JSONata expression",
              "ui:placeholder": "$number(to_count) / $max([$number(from_count), 1])",
              "ui:options": {
                "language": "plaintext",
                "height": "60px",
                "minimap": false,
                "lineNumbers": "off",
                "scrollBeyondLastLine": false,
                "wordWrap": "on"
              }
            }
          }
        },
        
        "upsert": {
          "ui:title": "5️⃣ Upsert to Graph",
          "ui:collapsed": true,
          "ui:help": "Write results back to graph using JSON Pointer",
          
          "mode": {
            "ui:widget": "radio",
            "ui:inline": true
          },
          
          "writes": {
            "ui:help": "Target paths and values to write",
            "items": {
              "target": {
                "ui:widget": "JSONPointerEditor",
                "ui:help": "JSON Pointer path in graph",
                "ui:placeholder": "/edges/{{edgeId}}/p/mean"
              },
              "value": {
                "ui:widget": "TemplateEditor",
                "ui:help": "Value to write (can use variables)"
              }
            }
          }
        }
      },
      
      "tags": {
        "ui:widget": "TagsInput",
        "ui:help": "Tags for filtering/organizing connections",
        "ui:options": {
          "suggestions": ["production", "staging", "read-only", "deprecated"]
        }
      },
      
      "metadata": {
        "ui:collapsed": true,
        "ui:readonly": true,
        "ui:help": "Automatic metadata (created_at, created_by)"
      }
    }
  }
}
```

**Visual Layout:**

```
┌─────────────────────────────────────────────────────────────────┐
│ FormEditor: connections.yaml                             [×][□] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  SUB-TABS (each connection):                                    │
│  [amplitude-prod] [sheets-metrics] [statsig-prod] [+ New]       │
│  ───────────────                                                │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ Name:  [amplitude-prod                              ]    │ │
│  │ Provider: [Amplitude Analytics ▼]                        │ │
│  │ Enabled: [✓]                                             │ │
│  ├───────────────────────────────────────────────────────────┤ │
│  │ ⚙️ Connection Defaults                              [▼] │ │
│  │   project_id: [12345                              ]      │ │
│  │   exclude_test_users: [✓]                               │ │
│  │   [+ Add Default]                                        │ │
│  ├───────────────────────────────────────────────────────────┤ │
│  │ 📋 Connection String Schema                         [▶] │ │
│  ├───────────────────────────────────────────────────────────┤ │
│  │ 🔌 Adapter Configuration                            [▶] │ │
│  │   ┌─────────────────────────────────────────────────┐   │ │
│  │   │ 1️⃣ Pre-Request Scripts                   [▶]  │   │ │
│  │   │ 2️⃣ HTTP Request                          [▼]  │   │ │
│  │   │   POST /api/2/funnels                           │   │ │
│  │   │   ┌─────────────────────────────────────────┐   │   │ │
│  │   │   │  Monaco Editor (JSON)                   │   │   │ │
│  │   │   │  body_template:                         │   │   │ │
│  │   │   │  {                                      │   │   │ │
│  │   │   │    "project_id": "{{defaults.id}}"    │   │   │ │
│  │   │   │  }                                      │   │   │ │
│  │   │   └─────────────────────────────────────────┘   │   │ │
│  │   │ 3️⃣ Response Extraction                   [▶]  │   │ │
│  │   │ 4️⃣ Transform Data                        [▶]  │   │ │
│  │   │ 5️⃣ Upsert to Graph                       [▶]  │   │ │
│  │   └─────────────────────────────────────────────────┘   │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  [Cancel] [Save]                                                │
└─────────────────────────────────────────────────────────────────┘
```

**Key UI Features:**

1. **Sub-Tabbed Array** - Each connection in its own sub-tab within FormEditor:
   - Uses `TabbedArrayWidget` custom widget for @rjsf/mui
   - Tab label from connection `name` field
   - Add/remove connections via tab controls

2. **Accordion Sections** - Collapsible major sections:
   - **⚙️ Connection Defaults** - Expanded by default
   - **📋 Connection String Schema** - Collapsed (Monaco JSON)
   - **🔌 Adapter Configuration** - Collapsed with 5 numbered sub-sections

3. **Monaco Editor Integration:**
   - **All code/JSON/YAML fields use Monaco** via `MonacoWidget`
   - Already have @monaco-editor/react installed
   - Reuse Monaco instance from RawView
   - Options per field:
     - `body_template`, `connection_string_schema`: JSON, 200-300px height, line numbers
     - `script` (pre_request): JavaScript, 150px, line numbers
     - `jmes`, `jsonata`: Plaintext, 40-60px, no line numbers (single-line expressions)

4. **Custom Widgets to Implement:**
   - `TabbedArrayWidget` - Array items as sub-tabs
   - `MonacoWidget` - Wrapper around Monaco Editor for RJSF
   - `CredentialsSelector` - Dropdown from credentials.yaml
   - `TagsInput` - Chip input for tags

5. **Smart Defaults:**
   - Collapsed: adapter sections, connection_string_schema, metadata
   - Expanded: name, provider, enabled, defaults
   - Read-only: metadata (auto-generated timestamps)

**Implementation Notes:**

```typescript
// graph-editor/src/components/widgets/MonacoWidget.tsx
import Editor from '@monaco-editor/react';
import { WidgetProps } from '@rjsf/utils';

export function MonacoWidget(props: WidgetProps) {
  const { value, onChange, options, disabled, readonly } = props;
  
  return (
    <Editor
      height={options.height || '200px'}
      language={options.language || 'json'}
      value={value || ''}
      onChange={(v) => onChange(v)}
      options={{
        minimap: { enabled: options.minimap !== false },
        lineNumbers: options.lineNumbers || 'on',
        readOnly: disabled || readonly,
        wordWrap: options.wordWrap || 'off',
        scrollBeyondLastLine: options.scrollBeyondLastLine !== false,
        formatOnBlur: options.formatOnBlur || false
      }}
    />
  );
}

// graph-editor/src/components/widgets/TabbedArrayWidget.tsx
import { ArrayFieldTemplateProps } from '@rjsf/utils';
import { Tabs, Tab } from '@mui/material';

export function TabbedArrayWidget(props: ArrayFieldTemplateProps) {
  const [activeTab, setActiveTab] = useState(0);
  const { items, onAddClick, title, schema } = props;
  const tabField = schema['ui:options']?.tabField || 'name';
  
  return (
    <div>
      <Tabs value={activeTab} onChange={(e, v) => setActiveTab(v)}>
        {items.map((item, i) => (
          <Tab 
            key={i} 
            label={item.children.props.formData?.[tabField] || `Item ${i+1}`}
          />
        ))}
        <Tab label="+" onClick={onAddClick} />
      </Tabs>
      {items.map((item, i) => (
        <div key={i} hidden={activeTab !== i}>
          {item.children}
        </div>
      ))}
    </div>
  );
}

// Register widgets in FormEditor
import { MonacoWidget } from './widgets/MonacoWidget';
import { TabbedArrayWidget } from './widgets/TabbedArrayWidget';

const widgets = {
  MonacoWidget,
  TabbedArrayWidget,
  // ... other custom widgets
};

<Form
  schema={schema}
  uiSchema={uiSchema}
  widgets={widgets}
  formData={formData}
  onChange={handleChange}
/>
```

**Files:**
- UI Schema: `graph-editor/public/ui-schemas/connections-ui-schema.json`
- Widgets: `graph-editor/src/components/widgets/`
- FormEditor loads UI schema automatically based on file type

### 4.4 connections-schema.json

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Data Source Connections",
  "description": "External data source configurations with integrated adapters",
  "type": "object",
  "required": ["version", "connections"],
  "properties": {
    "version": {
      "type": "string",
      "default": "1.0.0"
    },
    "connections": {
      "type": "array",
      "items": { "$ref": "#/$defs/connection" }
    }
  },
  "$defs": {
    "connection": {
      "type": "object",
      "required": ["name", "provider", "kind", "credsRef", "connection_string_schema", "adapter"],
      "properties": {
        "name": {
          "type": "string",
          "pattern": "^[a-z0-9][a-z0-9-]*[a-z0-9]$"
        },
        "provider": {
          "type": "string",
          "enum": ["amplitude", "ga4", "postgres", "mysql", "bigquery", "snowflake", "google-sheets", "custom"]
        },
        "kind": {
          "type": "string",
          "enum": ["http", "sql"]
        },
        "credsRef": {
          "type": "string",
          "description": "Reference to credentials.yaml field"
        },
        "description": {
          "type": "string"
        },
        "enabled": {
          "type": "boolean",
          "default": true
        },
        "defaults": {
          "type": "object",
          "description": "Non-secret default values (project IDs, base URLs, etc.)",
          "additionalProperties": true
        },
        "connection_string_schema": {
          "type": "object",
          "description": "JSON Schema defining the structure of connection_string for this provider",
          "properties": {
            "type": { "const": "object" },
            "properties": { "type": "object" },
            "required": {
              "type": "array",
              "items": { "type": "string" }
            },
            "examples": {
              "type": "array",
              "description": "Example connection_string objects"
            }
          },
          "required": ["type", "properties"]
        },
        "adapter": {
          "$ref": "#/$defs/adapter"
        },
        "tags": {
          "type": "array",
          "items": { "type": "string" }
        },
        "metadata": {
          "type": "object"
        }
      }
    },
    "adapter": {
      "type": "object",
      "required": ["request", "response", "upsert"],
      "properties": {
        "request": {
          "oneOf": [
            { "$ref": "#/$defs/httpRequest" },
            { "$ref": "#/$defs/sqlRequest" }
          ]
        },
        "response": {
          "$ref": "#/$defs/response"
        },
        "transform": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["name", "jsonata"],
            "properties": {
              "name": { "type": "string" },
              "jsonata": { "type": "string" }
            }
          }
        },
        "upsert": {
          "type": "object",
          "required": ["writes"],
          "properties": {
            "mode": {
              "type": "string",
              "enum": ["merge", "replace"],
              "default": "merge"
            },
            "writes": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["target", "value"],
                "properties": {
                  "target": { "type": "string" },
                  "value": {}
                }
              }
            }
          }
        }
      }
    },
    "httpRequest": {
      "type": "object",
      "required": ["method", "path_template"],
      "properties": {
        "method": {
          "type": "string",
          "enum": ["GET", "POST", "PUT", "PATCH"]
        },
        "path_template": { "type": "string" },
        "headers": {
          "type": "object",
          "additionalProperties": { "type": "string" }
        },
        "query": { "type": "object" },
        "body": {},
        "retry": {
          "type": "object",
          "properties": {
            "max_attempts": { "type": "integer" },
            "backoff_ms": { "type": "integer" }
          }
        },
        "timeout_ms": { "type": "integer" }
      }
    },
    "sqlRequest": {
      "type": "object",
      "required": ["query"],
      "properties": {
        "query": { "type": "string" },
        "params": {
          "type": "array",
          "items": { "type": "string" }
        },
        "timeout_ms": { "type": "integer" }
      }
    },
    "response": {
      "type": "object",
      "required": ["extract"],
      "properties": {
        "ok_when": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["jmes"],
            "properties": {
              "jmes": { "type": "string" }
            }
          }
        },
        "extract": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["name", "jmes"],
            "properties": {
              "name": { "type": "string" },
              "jmes": { "type": "string" }
            }
          }
        }
      }
    }
  }
}
```

---

## 4. UI Integration: Window & Context Selectors

### 4.1 What is "Graph-Level Window/Context"?

**The Problem:**
When fetching data from external sources, you need to specify:
- **Window**: What time range? (e.g., "Last 30 days", "Jan 2025")
- **Context**: What user segment? (e.g., "mobile users", "all users")

**Old Approach (Bad):**
Set these per-parameter → lots of repetition, hard to keep consistent

**New Approach (Good):**
Set these once at the **graph level** → applies to ALL "Get from file" operations

**Storage Location: GRAPH-level (synced across tabs)**
- Stored in graph metadata (or companion state file)
- UI shown at tab level, but changes sync across ALL tabs viewing that graph
- If you open same graph in 2 tabs, changing window in one tab updates both

**Why not per-tab?**
- If truly per-tab, you can't view same graph with different contexts side-by-side
- Future: Per-tab data overlays will be handled by extending WhatIf system (see TODO)

**Example User Flow:**

```
1. User opens graph "checkout-funnel.json" in Tab 1
   
2. User sets filters in Tab 1 UI:
   ┌─────────────────────────────────────────┐
   │ Time Window: [Last 30 days ▼]          │
   │ Context:     [Mobile users  ▼]         │
   └─────────────────────────────────────────┘
   → Saved to graph metadata

3. User right-clicks edge A→B, "Get from file"
   → Uses: window="last 30 days", context="mobile users"
   
4. User opens SAME graph in Tab 2
   → Shows: window="last 30 days", context="mobile users" (synced!)
   
5. User changes context to "Desktop users" in Tab 2
   → Both Tab 1 and Tab 2 now show "Desktop users" (synced!)
```

**Benefits:**
- ✅ Set once, applies to all fetches for this graph
- ✅ Synced across tabs viewing same graph
- ✅ Easy to batch refresh all parameters
- ✅ Stored with graph (can commit to Git)

**Future (TODO):**
- Per-tab data overlays will be part of WhatIf system extension
- Will allow viewing same graph with different contexts side-by-side
- Requires overlay state management (separate from base graph)

### 4.2 Graph-Level State Implementation

Store window/context in graph metadata (or companion state):

```typescript
// In graph metadata or separate state file
interface GraphMetadata {
  version: string;
  created_at: string;
  // ... existing fields
  
  // NEW: Data fetch context (stored with graph)
  dataFetchContext?: {
    window: {
      start: string;    // ISO date
      end: string;      // ISO date
      preset?: 'last-7d' | 'last-30d' | 'last-90d' | 'custom';
    };
    context?: {
      id: string;       // Context ID or null for "all"
      label: string;    // Display label
    };
  };
}

// UI in tab reads/writes to graph metadata
// All tabs viewing same graph see the same values
```

### 4.3 UI Component: DataFetchContextBar

```typescript
// components/DataFetchContextBar.tsx

interface DataFetchContextBarProps {
  window: { start: string; end: string; preset?: string };
  context?: { id: string; label: string };
  onWindowChange: (window: { start: string; end: string; preset?: string }) => void;
  onContextChange: (context?: { id: string; label: string }) => void;
}

export const DataFetchContextBar: React.FC<DataFetchContextBarProps> = ({
  window,
  context,
  onWindowChange,
  onContextChange
}) => {
  return (
    <div className="data-fetch-context-bar">
      {/* Window Selector */}
      <div className="window-selector">
        <label>Time Window:</label>
        <select 
          value={window.preset || 'custom'}
          onChange={(e) => {
            if (e.target.value === 'last-7d') {
              onWindowChange({
                start: dayjs().subtract(7, 'days').toISOString(),
                end: dayjs().toISOString(),
                preset: 'last-7d'
              });
            }
            // ... other presets
          }}
        >
          <option value="last-7d">Last 7 days</option>
          <option value="last-30d">Last 30 days</option>
          <option value="last-90d">Last 90 days</option>
          <option value="custom">Custom range...</option>
        </select>
        
        {window.preset === 'custom' && (
          <>
            <input
              type="date"
              value={dayjs(window.start).format('YYYY-MM-DD')}
              onChange={(e) => onWindowChange({
                ...window,
                start: dayjs(e.target.value).toISOString()
              })}
            />
            <span>to</span>
            <input
              type="date"
              value={dayjs(window.end).format('YYYY-MM-DD')}
              onChange={(e) => onWindowChange({
                ...window,
                end: dayjs(e.target.value).toISOString()
              })}
            />
          </>
        )}
      </div>
      
      {/* Context Selector */}
      <div className="context-selector">
        <label>Context:</label>
        <select
          value={context?.id || 'all'}
          onChange={(e) => {
            if (e.target.value === 'all') {
              onContextChange(undefined);
            } else {
              const ctx = contexts.find(c => c.id === e.target.value);
              onContextChange(ctx ? {
                id: ctx.id,
                label: ctx.label
              } : undefined);
            }
          }}
        >
          <option value="all">All contexts</option>
          {contexts.map(ctx => (
            <option key={ctx.id} value={ctx.id}>
              {ctx.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
};
```

### 4.4 Layout Position

```
┌────────────────────────────────────────────────────────────┐
│  Graph Editor Tab                                          │
├────────────────────────────────────────────────────────────┤
│  [Data Fetch Context Bar]                                  │
│  Time Window: [Last 30 days ▼]  Context: [All contexts ▼] │
├────────────────────────────────────────────────────────────┤
│                                                            │
│                    Graph Canvas                            │
│                                                            │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

Place below the tab bar, above the graph canvas.

### 4.5 Integration with "Get from file"

```typescript
// In EdgeContextMenu or DataOperationsService

async function handleGetFromFile() {
  // Get tab's data fetch context
  const tabState = getCurrentTabState();
  const window = tabState.dataFetchContext?.window || {
    start: dayjs().subtract(30, 'days').toISOString(),
    end: dayjs().toISOString(),
    preset: 'last-30d'
  };
  const context = tabState.dataFetchContext?.context;

  // Execute DAS Runner with this context
  await dasRunner.execute({
    dsl: buildDslFromEdge(edge),
    connection,
    inputs: {
      window,           // From tab selector
      context,          // From tab selector
      edgeId
    },
    paramDoc: graph
  });
}
```

---

## 5. DAS Runner Implementation

### 5.1 Core Services

```typescript
// services/connectionResolver.ts

export class ConnectionResolver {
  constructor(
    private connections: any,  // connections.yaml content
    private credentials: any   // credentials.yaml content
  ) {}

  resolve(connectionName: string): ResolvedConnection {
    const conn = this.connections.connections.find(
      c => c.name === connectionName
    );
    
    if (!conn) {
      throw new Error(`Connection not found: ${connectionName}`);
    }
    
    if (!conn.enabled) {
      throw new Error(`Connection disabled: ${connectionName}`);
    }
    
    // Resolve credentials reference
    const creds = this.resolveCredsRef(conn.credsRef);
    
    // Merge defaults with normalized credentials
    return {
      ...conn,
      context: {
        ...conn.defaults,
        ...this.normalizeCredentials(conn.provider, creds)
      }
    };
  }

  private resolveCredsRef(ref: string): any {
    // Parse ref: "amplitude" | "git[0]" | "warehouse"
    const parts = ref.match(/^([a-zA-Z_]+)(\[(\d+)\])?$/);
    if (!parts) {
      throw new Error(`Invalid credsRef: ${ref}`);
    }
    
    const [, key, , index] = parts;
    const cred = this.credentials[key];
    
    if (!cred) {
      throw new Error(`Credentials not found: ${ref}`);
    }
    
    return index !== undefined ? cred[parseInt(index)] : cred;
  }

  private normalizeCredentials(provider: string, creds: any): Record<string, any> {
    switch (provider) {
      case 'amplitude':
        return {
          api_key: creds.apiKey,
          secret_key: creds.secretKey
        };
      case 'postgres':
      case 'mysql':
        return { dsn: creds.dsn };
      case 'google-sheets':
        return {
          token: creds.token,
          service_account: creds.serviceAccount
        };
      default:
        return creds;
    }
  }
}
```

```typescript
// services/dasRunner.ts

import jmespath from 'jmespath';
import jsonata from 'jsonata';
import jsonpointer from 'jsonpointer';

export interface RunnerInputs {
  dsl: string;                    // Parsed from edge query
  connection: any;                // Resolved connection
  inputs: {
    window: { start: string; end: string };
    context?: { id: string; label: string };
    edgeId: string;
  };
  paramDoc: any;                  // Graph to update
}

export class DasRunner {
  async execute(inputs: RunnerInputs): Promise<RunnerResult> {
    try {
      // 1. Parse DSL
      const dslObj = this.parseDsl(inputs.dsl);

      // 2. Build template context
      const ctx = {
        dsl: dslObj,
        connection: inputs.connection.context,
        window: inputs.inputs.window,
        context: inputs.inputs.context || { id: null },
        edgeId: inputs.inputs.edgeId,
        helpers: {
          json: (v: any) => JSON.stringify(v),
          array: (v: any) => Array.isArray(v) ? v : [v],
          now: () => new Date().toISOString()
        }
      };

      // 3. Execute request
      const responseData = await this.executeRequest(
        inputs.connection.adapter.request,
        ctx
      );

      // 4. Validate response
      if (inputs.connection.adapter.response.ok_when) {
        this.validateResponse(
          inputs.connection.adapter.response.ok_when,
          responseData
        );
      }

      // 5. Extract data
      const extracted = this.extractData(
        inputs.connection.adapter.response.extract,
        responseData
      );

      // 6. Transform data
      const transformed = inputs.connection.adapter.transform
        ? this.transformData(
            inputs.connection.adapter.transform,
            extracted,
            ctx
          )
        : {};

      // 7. Upsert to document
      const updatedDoc = this.upsertData(
        inputs.connection.adapter.upsert,
        inputs.paramDoc,
        { ...extracted, ...transformed, connection: inputs.connection },
        ctx
      );

      return {
        success: true,
        updatedParamDoc: updatedDoc,
        extracted,
        transformed,
        provenance: {
          connection: inputs.connection.name,
          executed_at: new Date().toISOString(),
          window: inputs.inputs.window,
          context: inputs.inputs.context
        }
      };
    } catch (error) {
      return {
        success: false,
        updatedParamDoc: inputs.paramDoc,
        extracted: {},
        transformed: {},
        provenance: {
          connection: inputs.connection.name,
          executed_at: new Date().toISOString(),
          window: inputs.inputs.window,
          context: inputs.inputs.context
        },
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private parseDsl(dsl: string): any {
    // Use existing parseDsl from query system
    // Returns: { from: 'a', to: 'b', visited: ['c'], excluded: ['d'] }
    return parseDsl(dsl);
  }

  private async executeRequest(request: any, ctx: any): Promise<any> {
    if (request.method) {
      // HTTP request
      return this.executeHttpRequest(request, ctx);
    } else {
      // SQL request
      return this.executeSqlRequest(request, ctx);
    }
  }

  private async executeHttpRequest(request: any, ctx: any): Promise<any> {
    const url = this.renderUrl(request, ctx);
    const headers = this.renderObject(request.headers || {}, ctx);
    const query = this.renderObject(request.query || {}, ctx);
    const body = request.body ? this.renderObject(request.body, ctx) : undefined;

    const queryString = new URLSearchParams(query).toString();
    const fullUrl = queryString ? `${url}?${queryString}` : url;

    const maxAttempts = request.retry?.max_attempts || 1;
    const backoff = request.retry?.backoff_ms || 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(fullUrl, {
          method: request.method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(request.timeout_ms || 30000)
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        return await response.json();
      } catch (error) {
        if (attempt === maxAttempts) throw error;
        await new Promise(resolve => setTimeout(resolve, backoff * attempt));
      }
    }
  }

  private async executeSqlRequest(request: any, ctx: any): Promise<any> {
    const params = request.params.map((p: string) => this.renderTemplate(p, ctx));
    
    // Use pg driver (would need to be imported)
    // This is a placeholder - actual implementation depends on provider
    throw new Error('SQL execution requires server-side implementation');
  }

  private validateResponse(checks: any[], data: any): void {
    for (const check of checks) {
      const result = jmespath.search(data, check.jmes);
      if (!result) {
        throw new Error(`Validation failed: ${check.jmes}`);
      }
    }
  }

  private extractData(extracts: any[], data: any): Record<string, any> {
    const result: Record<string, any> = {};
    for (const ext of extracts) {
      result[ext.name] = jmespath.search(data, ext.jmes);
    }
    return result;
  }

  private transformData(
    transforms: any[],
    data: Record<string, any>,
    ctx: any
  ): Record<string, any> {
    const result: Record<string, any> = {};
    for (const t of transforms) {
      try {
        const expression = jsonata(t.jsonata);
        result[t.name] = expression.evaluate({ ...data, ...ctx });
      } catch (error) {
        console.warn(`Transform failed: ${t.name}`, error);
        result[t.name] = null;
      }
    }
    return result;
  }

  private upsertData(
    spec: any,
    doc: any,
    data: Record<string, any>,
    ctx: any
  ): any {
    const updated = spec.mode === 'replace' ? {} : structuredClone(doc);

    for (const write of spec.writes) {
      const targetPath = this.renderTemplate(write.target, { ...ctx, ...data });
      const value = typeof write.value === 'string'
        ? this.renderTemplate(write.value, { ...ctx, ...data })
        : write.value;
      
      jsonpointer.set(updated, targetPath, value);
    }

    return updated;
  }

  private renderUrl(request: any, ctx: any): string {
    const baseUrl = ctx.connection.base_url || '';
    const path = this.renderTemplate(request.path_template, ctx);
    return `${baseUrl}${path}`;
  }

  private renderObject(obj: any, ctx: any): any {
    if (typeof obj === 'string') {
      return this.renderTemplate(obj, ctx);
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this.renderObject(item, ctx));
    }
    if (typeof obj === 'object' && obj !== null) {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.renderObject(value, ctx);
      }
      return result;
    }
    return obj;
  }

  private renderTemplate(template: string, ctx: any): any {
    return template.replace(/\{\{([^}]+)\}\}/g, (match, expr) => {
      const trimmed = expr.trim();
      
      // Handle helper functions
      if (trimmed.startsWith('json(')) {
        const arg = trimmed.slice(5, -1).trim();
        return JSON.stringify(this.resolvePath(arg, ctx));
      }
      if (trimmed.startsWith('array(')) {
        const arg = trimmed.slice(6, -1).trim();
        const val = this.resolvePath(arg, ctx);
        return Array.isArray(val) ? val : [val];
      }
      if (trimmed === 'now()') {
        return new Date().toISOString();
      }

      // Regular path resolution
      const value = this.resolvePath(trimmed, ctx);
      return value !== undefined ? String(value) : match;
    });
  }

  private resolvePath(path: string, ctx: any): any {
    const parts = path.split('.');
    let current = ctx;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      current = current[part];
    }
    return current;
  }
}
```

```typescript
// services/dataOperationsService.ts (updated)

export class DataOperationsService {
  private dasRunner: DasRunner | null = null;

  async getParameterFromFile({
    paramId,
    edgeId,
    graph,
    setGraph
  }): Promise<void> {
    try {
      // 1. Load configurations
      const connectionsFile = await db.files
        .where('path').equals('connections.yaml')
        .first();
      const credentialsFile = await db.files
        .where('path').equals('credentials.yaml')
        .first();
      
      if (!connectionsFile || !credentialsFile) {
        throw new Error('Missing configuration files');
      }

      // 2. Find appropriate connection
      // (For now, use first enabled connection - later add UI selector)
      const connection = connectionsFile.content.connections.find(
        (c: any) => c.enabled
      );
      
      if (!connection) {
        throw new Error('No enabled connections found');
      }

      // 3. Resolve connection
      const resolver = new ConnectionResolver(
        connectionsFile.content,
        credentialsFile.content
      );
      const resolved = resolver.resolve(connection.name);

      // 4. Get window/context from tab state
      const tabState = getCurrentTabState();
      const window = tabState.dataFetchContext?.window || {
        start: dayjs().subtract(30, 'days').toISOString(),
        end: dayjs().toISOString()
      };
      const context = tabState.dataFetchContext?.context;

      // 5. Build DSL from edge
      const edge = graph.edges.find((e: any) => e.uuid === edgeId);
      if (!edge) {
        throw new Error('Edge not found');
      }

      // Build query from edge + nodes
      const dsl = edge.p?.query || this.buildDslFromEdge(edge, graph);

      // 6. Initialize DAS Runner
      if (!this.dasRunner) {
        this.dasRunner = new DasRunner();
      }

      // 7. Execute
      const result = await this.dasRunner.execute({
        dsl,
        connection: resolved,
        inputs: { window, context, edgeId },
        paramDoc: graph
      });

      if (!result.success) {
        throw new Error(result.error);
      }

      // 8. Update graph
      setGraph(
        result.updatedParamDoc,
        `Get parameter from ${connection.name}`,
        edgeId
      );

      toast.success(`✓ Updated from ${connection.name}`);
    } catch (error) {
      console.error('[DataOps] getParameterFromFile failed:', error);
      toast.error(`Failed: ${error.message}`);
    }
  }

  /**
   * Build DSL execution object from edge.p.query + graph nodes
   * CRITICAL: Query stores NODE references, must look up nodes to get event_ids
   */
  private buildDslFromEdge(edge: any, graph: any): any {
    // Edge.p.query has: { from: "node-checkout", to: "node-purchase", visited: [...] }
    // We need to look up those nodes to get their event_ids
    
    const query = edge.p?.query;
    if (!query) {
      throw new Error(`Edge missing query object: ${edge.from} → ${edge.to}`);
    }
    
    // Helper to find node by ID or UUID
    // NOTE: Queries primarily use node.id (human-readable), not node.uuid
    const findNode = (ref: string) => {
      return graph.nodes.find((n: any) => n.id === ref || n.uuid === ref);
    };
    
    // Look up from/to nodes using query references
    const fromNode = findNode(query.from);
    const toNode = findNode(query.to);
    
    if (!fromNode || !toNode) {
      throw new Error(
        `Query nodes not found:\n` +
        `  from: ${query.from} → ${fromNode ? 'found' : 'NOT FOUND'}\n` +
        `  to: ${query.to} → ${toNode ? 'found' : 'NOT FOUND'}`
      );
    }

    // Extract event_ids from nodes
    const from_event_id = fromNode.event_id;
    const to_event_id = toNode.event_id;
    
    if (!from_event_id || !to_event_id) {
      throw new Error(
        `Nodes must have event_id field:\n` +
        `  "${fromNode.label}": event_id = ${from_event_id || 'MISSING'}\n` +
        `  "${toNode.label}": event_id = ${to_event_id || 'MISSING'}`
      );
    }
    
    // Look up visited nodes and extract their event_ids
    const visited_event_ids = (query.visited || []).map((ref: string) => {
      const node = findNode(ref);
      if (!node) throw new Error(`Visited node not found: ${ref}`);
      if (!node.event_id) throw new Error(`Node "${node.label}" missing event_id`);
      return node.event_id;
    });
    
    // Look up excluded nodes and extract their event_ids
    const excluded_event_ids = (query.excluded || []).map((ref: string) => {
      const node = findNode(ref);
      if (!node) throw new Error(`Excluded node not found: ${ref}`);
      if (!node.event_id) throw new Error(`Node "${node.label}" missing event_id`);
      return node.event_id;
    });

    // Build execution DSL with resolved event_ids
    return {
      from_event_id,           // "checkout"
      to_event_id,             // "purchase"
      visited_event_ids,       // ["view_product"]
      excluded_event_ids       // ["abandoned_cart"]
    };
  }
}
```

---

## 6. File Type Registration

```typescript
// fileTypeRegistry.ts

{
  type: 'connections',
  extension: '.yaml',
  icon: '🔌',
  label: 'Connections',
  schema: '/schemas/connections-schema.json',
  editor: 'FormEditor',
  category: 'config',
  description: 'Data source connections with integrated adapters',
  createNew: () => loadDefaultConnections()
}
```

---

## 7. Default connections.yaml

```yaml
# graph-editor/src/defaults/connections.default.yaml
version: 1.0.0

connections:
  # Amplitude (disabled by default - user must add credentials first)
  - name: amplitude-prod
    provider: amplitude
    kind: http
    credsRef: amplitude
    description: Amplitude production analytics (configure credentials first)
    enabled: false
    
    defaults:
      base_url: https://api.amplitude.com
      timeout_ms: 30000
      rate_limit_rpm: 50
    
    adapter:
      request:
        method: GET
        path_template: /api/2/funnels
        headers:
          Authorization: Bearer {{ connection.api_key }}
        query:
          project: "{{ connection.project_id }}"
          start: "{{ window.start }}"
          end: "{{ window.end }}"
          context: "{{ context.id }}"
          event_from: "{{ dsl.from }}"
          event_to: "{{ dsl.to }}"
        retry:
          max_attempts: 3
          backoff_ms: 1000
      
      response:
        ok_when:
          - jmes: "status == 'success'"
        extract:
          - name: total_attempts
            jmes: data.funnel.total_conversions
          - name: total_conversions
            jmes: data.funnel.completed_conversions
          - name: sample_size
            jmes: data.funnel.sample_size
      
      transform:
        - name: p_mean
          jsonata: "$number(total_conversions) / $max([$number(total_attempts), 1])"
        - name: p_stdev
          jsonata: "$sqrt(p_mean * (1 - p_mean) / $max([sample_size, 1]))"
      
      upsert:
        mode: merge
        writes:
          - target: /edges/{{ edgeId }}/p/mean
            value: "{{ p_mean }}"
          - target: /edges/{{ edgeId }}/p/stdev
            value: "{{ p_stdev }}"
          - target: /edges/{{ edgeId }}/p/evidence/source
            value: "{{ connection.name }}"
          - target: /edges/{{ edgeId }}/p/evidence/fetched_at
            value: "{{ now() }}"
    
    tags:
      - external-api
```

---

## 8. Implementation Plan

### Phase 1: Core Infrastructure (4-5 hrs)
- [ ] Create connections-schema.json
- [ ] Add 'connections' file type to registry
- [ ] Create default connections.yaml
- [ ] Implement initialization logic

### Phase 2: Tab UI Integration (2-3 hrs)
- [ ] Add dataFetchContext to tab state
- [ ] Create DataFetchContextBar component
- [ ] Wire to GraphEditor layout
- [ ] Persist selections in tab state

### Phase 3: DAS Runner (8-10 hrs)
- [ ] Implement ConnectionResolver class
- [ ] Implement DasRunner class
- [ ] Add HTTP request execution
- [ ] Add SQL request execution (server-side)
- [ ] Template engine ({{ }} rendering)
- [ ] JMESPath/JSONata integration

### Phase 4: Integration (3-4 hrs)
- [ ] Wire DAS Runner to DataOperationsService
- [ ] Update EdgeContextMenu "Get from file"
- [ ] Add connection selection UI (if multiple)
- [ ] Toast notifications
- [ ] Error handling

### Phase 5: Testing (2-3 hrs)
- [ ] Schema validation tests
- [ ] ConnectionResolver tests
- [ ] DasRunner unit tests
- [ ] End-to-end integration test

**Total: 19-25 hours**

---

## 9. NPM Dependencies

```json
{
  "dependencies": {
    "jmespath": "^0.16.0",
    "jsonata": "^2.0.3",
    "jsonpointer": "^5.0.1",
    "dayjs": "^1.11.10"  // For date handling in UI
  }
}
```

---

## 10. User Workflow

### Setup (One-Time)
```
1. File > Credentials
   → Add Amplitude credentials
   → Save

2. File > Connections
   → Find "amplitude-prod" connection
   → Update project_id: "12345"
   → Set enabled: true
   → Save (commits to Git)
```

### Use (Ongoing)
```
1. Open graph tab
   → Set Time Window: "Last 30 days"
   → Set Context: "mobile-users"

2. Right-click edge parameter
   → "Get from file..."
   → System uses tab's window/context
   → Fetches from Amplitude
   → Updates graph
   → Toast: "✓ Updated from amplitude-prod"
```

---

## 11. Security Model

### Credentials (Secret)
- ✅ IndexedDB only, never committed
- ✅ Resolved server-side in DAS Runner
- ✅ Never exposed to logs

### Connections (Shareable)
- ✅ Safe to commit (no secrets)
- ✅ References credentials via credsRef
- ✅ Team can share configurations

### Runtime
- ✅ ConnectionResolver merges at runtime
- ✅ Only in DAS Runner execution context
- ✅ Never sent to client logs

---

## 12. Benefits

### For Users
- ✅ **Simple 2-field model**: Just `connection` + `connection_string`
- ✅ **Dynamic forms**: UI generates form from `connection_string_schema`
- ✅ **Tab-level window/context**: Set once per graph, not per parameter
- ✅ **No code required**: Add data sources by editing YAML
- ✅ **Git-committable**: Share configurations across team

### For Developers
- ✅ **Declarative data fetching**: No imperative glue code
- ✅ **Clear separation**: Config vs secrets vs logic
- ✅ **Testable**: Mock connections, validate schemas
- ✅ **Extensible**: Add providers without code changes

### For Teams
- ✅ **Share configs via Git**: connections.yaml is safe to commit
- ✅ **Consistent patterns**: Same approach for all data sources
- ✅ **No accidental secrets**: Only references, never actual credentials
- ✅ **Easy onboarding**: Clear conventions, minimal concepts

---

## 13. Simplification Summary

### Before (Old Verbose Design):
```yaml
# Too many fields, confusing hierarchy
source:
  type: amplitude
  connection_id: amplitude-prod
  notes: "Some notes"

connection:
  source_type: amplitude
  connection_settings: |
    {"event_from": "checkout", ...}
```

### After (Simplified Design):
```yaml
# Just 2 fields - clean and clear
connection: amplitude-prod
connection_string: |
  {"event_from": "checkout", "event_to": "purchase"}
```

**Benefits of simplification:**
- 🎯 **50% fewer fields** - Removed `source.type`, `source.connection_id`, `source.notes`, `connection.source_type`
- 🎯 **Single source of truth** - Connection name appears once, not duplicated
- 🎯 **Clearer intent** - `connection` = which one, `connection_string` = settings for it
- 🎯 **Easier UI** - Dropdown for connection, dynamic form for connection_string

---

---

## 14. API Research & Validation (TODO)

### Current Status: PRELIMINARY DESIGN

The adapter specifications in this document are **preliminary designs** based on expected API patterns. Before implementation, we need to validate against actual API documentation:

### 14.1 Google Sheets API - Validation Needed

**Two Approaches Identified:**

**Option A: Google Sheets API v4 (OAuth2, structured)**
```
GET https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}
Authorization: Bearer {access_token}
```
- ✅ Official REST API
- ✅ OAuth2 authentication
- ✅ Returns JSON: `{"values": [["A1", "B1"], ["A2", "B2"]]}`
- ✅ Clean, structured approach

**Option B: Google Visualization API Query Language (SQL-like queries)**
```
GET https://docs.google.com/spreadsheets/d/{spreadsheetId}/gviz/tq?tq=SELECT%20A%2C%20B%20WHERE%20C%20%3E%20100
```
- ✅ SQL-like query language
- ✅ Filter/transform data server-side
- ✅ Returns JSON
- ⚠️  Less documented, more "hack-y"

**Design Implications:**
- **For simple range reads**: Use Sheets API v4 (Option A)
- **For labeled parameter extraction**: Could use Query Language (Option B) to filter by label column
- **Future enhancement**: Support both approaches, let user choose in connection config

**Labeled Parameter Extraction (Smart Feature):**

User noted we could get clever with Google Sheets to extract labeled parameters:

```
Spreadsheet:
| Parameter Name    | Mean  | StdDev | Notes          |
|-------------------|-------|--------|----------------|
| checkout_to_buy   | 0.45  | 0.02   | Q4 2024 data   |
| homepage_bounce   | 0.23  | 0.01   | Mobile only    |
```

**Query approach:**
```
SELECT B, C WHERE A = 'checkout_to_buy'
```

This would allow:
- User specifies `connection_string: {spreadsheet_id, sheet_name, parameter_label_column: "A"}`
- DAS Runner builds query: `SELECT * WHERE ${label_column} = '${parameter_name}'`
- Extracts mean/stdev from returned row

**Benefits:**
- Single spreadsheet can hold multiple parameters
- Parameters are labeled (human-readable)
- Can add metadata columns (notes, last_updated, etc.)

**TODO:**
- [ ] Test Google Sheets API v4 with OAuth2 service account
- [ ] Test Visualization API Query Language for labeled parameter extraction
- [ ] Design adapter variant that supports labeled parameter lookup
- [ ] Determine if we need both approaches or can standardize on one
- [ ] Document query syntax for parameter label matching (e.g., `WHERE A = 'param_name'`)
- [ ] Consider: Should `connection_string` specify label column + label value, or just range?

### 14.2 Amplitude Analytics API - Validation Needed

**CRITICAL DESIGN ISSUE: Query Transformation**

**The Problem:**

DagNet query semantics don't map 1:1 to Amplitude funnels:

```
DagNet edge query:
  from: node_b (event_id: "checkout")
  to: node_c (event_id: "purchase")
  visited: [node_a (event_id: "view_product")]
  
Meaning: "Conversion from checkout to purchase, given that view_product was visited"
```

**Amplitude requires:**
- A 3-step funnel: `view_product → checkout → purchase`
- Extract the step 2→3 conversion rate from the result

**Transformation Required:**

```typescript
// Input (from parameter definition)
const query = {
  from_event_id: "checkout",      // NOT node_id, but node.event_id
  to_event_id: "purchase",
  visited_event_ids: ["view_product"]
};

// Transform to Amplitude funnel
const amplitudeFunnel = {
  steps: [
    ...query.visited_event_ids,   // ["view_product"]
    query.from_event_id,           // "checkout"
    query.to_event_id              // "purchase"
  ]
};
// Result: ["view_product", "checkout", "purchase"]

// Amplitude API call
POST https://api.amplitude.com/api/2/funnels
{
  "events": [
    {"event_type": "view_product"},
    {"event_type": "checkout"},
    {"event_type": "purchase"}
  ],
  "start": "2025-01-01",
  "end": "2025-01-31"
}

// Response (expected)
{
  "data": {
    "steps": [
      {"event": "view_product", "count": 10000, "conversion": 1.0},
      {"event": "checkout", "count": 4500, "conversion": 0.45},
      {"event": "purchase", "count": 4050, "conversion": 0.9}  // ← THIS is B→C
    ]
  }
}

// Extract B→C conversion
const stepIndex = amplitudeFunnel.steps.indexOf(query.from_event_id);
const fromCount = response.data.steps[stepIndex].count;
const toCount = response.data.steps[stepIndex + 1].count;
const conversion = toCount / fromCount;
```

**Key Points:**
1. **Use event_id, not node_id**: Parameters must reference `node.event_id` (Amplitude event names)
2. **Funnel construction**: Adapter builds full funnel path (visited → from → to)
3. **Extract specific step**: From full funnel result, extract only the from→to portion
4. **Multiple visited events**: If `visited: ["a", "b"]`, funnel is `[a, b, from, to]`

**Updated Parameter Schema:**

```yaml
# In parameter file
query:
  from_event_id: "checkout"        # Maps to node.event_id
  to_event_id: "purchase"
  visited_event_ids: ["view_product"]  # Optional
  excluded_event_ids: []           # Optional (users who did NOT do these)

# NOT this:
# from_node_id: "node-b"  ❌
```

**Expected Endpoints:**

**Dashboard REST API:**
```
POST https://api.amplitude.com/api/2/funnels
Authorization: Bearer {api_key}
Content-Type: application/json

Body:
{
  "events": [
    {"event_type": "view_product"},
    {"event_type": "checkout"},
    {"event_type": "purchase"}
  ],
  "start": "2025-01-01",
  "end": "2025-01-31",
  "filters": {...}  // for segmentation/context
}
```

**TODO:**
- [ ] Verify actual Amplitude Dashboard REST API endpoints (may require paid tier)
- [ ] Validate: Does Amplitude return per-step counts or just overall funnel conversion?
- [ ] Test: How to handle `excluded` events? (users who did NOT visit certain events)
- [ ] Determine: Do we need Amplitude's Data Taxonomy API for event validation?
- [ ] Test: Can we filter by user properties (for context segmentation)?
- [ ] Investigate: Rate limits, pagination, authentication method (API key vs OAuth)
- [ ] **CRITICAL:** Test transformation logic with real Amplitude funnel responses

**Excluded Events Challenge:**

If query has `excluded: ["abandoned_cart"]`, meaning "users who did NOT abandon cart", this needs validation:

**TODO - Research Amplitude Exclusion:**
- [ ] Does Amplitude funnel API support exclusion/holdout steps?
- [ ] Can filters specify "user did NOT perform event X"?
- [ ] Alternative: Use Cohorts API to define exclusion criteria?
- [ ] Can we query by user property filters for exclusion?

**Potential approaches:**
1. **Native exclusion** (if supported): Amplitude may have exclusion criteria in funnel definition
2. **Cohort-based**: Define cohort excluding users who did event X, then run funnel on cohort
3. **Dual-query**: Run funnel with/without users, compute difference client-side
4. **User property filter**: If excluded events set user properties, filter by those

**Alternative if no direct funnel API:**
- Use Amplitude Export API to download raw events
- Process funnel logic client-side (less ideal)
- Consider using Amplitude's Behavioral Cohorts as proxy

### 14.2.1 Can DAS Handle This Transformation Complexity?

**Question:** Can a declarative adapter system handle the Amplitude transformation without specialized code?

**Required Capabilities:**

1. **Array construction from multiple sources**
   ```javascript
   funnel_steps = [...visited_event_ids, from_event_id, to_event_id]
   ```
   ✅ **Yes** - If DAS supports JavaScript/JSONata in `pre_request` scripts

2. **Index tracking for later extraction**
   ```javascript
   from_step_index = funnel_steps.indexOf(from_event_id)
   ```
   ✅ **Yes** - If variables persist across request/response phases

3. **Dynamic array indexing in extraction**
   ```javascript
   from_count = response.data.steps[from_step_index].count
   ```
   ✅ **Yes** - If JMES/JSONPath supports template variable interpolation

4. **Template rendering with array transformations**
   ```javascript
   "events": {{ funnel_steps | map(e => {"event_type": e}) | json }}
   ```
   ✅ **Yes** - If template engine supports filters/transformations

**Assessment: FEASIBLE with the right DAS engine features**

**Required DAS Engine Features:**

| Feature | Required For | Complexity |
|---------|--------------|------------|
| **JavaScript execution** | Array manipulation, index calculation | Medium |
| **Variable scoping** | Pass values from pre_request → extract | Low |
| **Template interpolation** | Dynamic JMES paths with computed indices | Medium |
| **Array/object filters** | Map, filter, reduce operations | Low |
| **JSONata or equivalent** | Complex transformations | Medium |

**Alternative: Provider-Specific Adapters**

If DAS becomes too complex, we could have provider-specific TypeScript adapters:

```typescript
// src/adapters/AmplitudeAdapter.ts
export class AmplitudeAdapter extends BaseAdapter {
  async buildRequest(query: Query, context: Context): Promise<Request> {
    const funnelSteps = [
      ...query.visited_event_ids,
      query.from_event_id,
      query.to_event_id
    ];
    
    return {
      url: `${this.connection.defaults.base_url}/api/2/funnels`,
      method: 'POST',
      body: {
        events: funnelSteps.map(e => ({event_type: e})),
        start: context.window.start,
        end: context.window.end
      }
    };
  }
  
  async extractData(response: Response, query: Query): Promise<Data> {
    const fromIndex = this.funnelSteps.indexOf(query.from_event_id);
    const fromCount = response.data.steps[fromIndex].count;
    const toCount = response.data.steps[fromIndex + 1].count;
    
    return {
      p_mean: toCount / fromCount,
      sample_size: fromCount
    };
  }
}
```

**Recommendation:**

1. **Start with declarative DAS** - Most transformations should be possible
2. **Add TypeScript escape hatch** - For truly complex cases, allow provider-specific adapters
3. **Validate with Amplitude** - Test actual API to confirm transformation approach
4. **Iterate** - If DAS proves too limiting, fall back to TypeScript adapters

**The key insight:** We need a DAS engine powerful enough for 80% of cases, with an escape hatch for the 20%.

### 14.2.2 SQL Complexity Stress Test

**Question:** What's the maximum SQL complexity we can handle declaratively?

**Scenario:** Connect to Snowflake/Postgres to retrieve conversion metrics with complex joins.

**Complexity Levels:**

**Level 1: Simple Query (✅ Fully Declarative)**

```yaml
adapter:
  request:
    query_template: |
      SELECT 
        COUNT(DISTINCT user_id) as total_attempts,
        COUNT(DISTINCT CASE WHEN event_type = '{{ query.to_event_id }}' THEN user_id END) as conversions
      FROM events
      WHERE event_type IN ('{{ query.from_event_id }}', '{{ query.to_event_id }}')
        AND timestamp BETWEEN '{{ window.start }}' AND '{{ window.end }}'
        AND {{ context.id ? "cohort_id = '" + context.id + "'" : "1=1" }}
```

**Assessment:** ✅ Easy - Basic templating with conditionals

---

**Level 2: Multi-Table Join (✅ Declarative with Config)**

```yaml
adapter:
  request:
    query_template: |
      SELECT 
        COUNT(DISTINCT e1.user_id) as from_count,
        COUNT(DISTINCT e2.user_id) as to_count
      FROM events e1
      LEFT JOIN events e2 
        ON e1.user_id = e2.user_id 
        AND e2.event_type = '{{ query.to_event_id }}'
        AND e2.timestamp > e1.timestamp
        AND e2.timestamp <= e1.timestamp + INTERVAL '{{ connection.defaults.conversion_window_hours }} hours'
      WHERE e1.event_type = '{{ query.from_event_id }}'
        AND e1.timestamp BETWEEN '{{ window.start }}' AND '{{ window.end }}'
      {{#if query.visited_event_ids}}
      AND EXISTS (
        SELECT 1 FROM events e_visited
        WHERE e_visited.user_id = e1.user_id
          AND e_visited.event_type IN ({{ query.visited_event_ids | map(quote) | join(', ') }})
          AND e_visited.timestamp < e1.timestamp
      )
      {{/if}}
```

**Assessment:** ✅ Doable - Template engine with conditionals and array filters (Handlebars-style)

**Required DAS features:**
- Conditional blocks (`{{#if}}`)
- Array filters (`map`, `join`)
- Helper functions (`quote` for SQL escaping)

---

**Level 3: Dynamic Schema (⚠️ Complex but Possible)**

**Scenario:** User configures table/column names in connection defaults

```yaml
# In connections.yaml
defaults:
  events_table: "analytics.events"
  user_table: "analytics.users"
  event_type_column: "event_name"
  user_id_column: "user_id"
  timestamp_column: "event_timestamp"

adapter:
  request:
    query_template: |
      SELECT 
        COUNT(DISTINCT e1.{{ connection.defaults.user_id_column }}) as from_count,
        COUNT(DISTINCT e2.{{ connection.defaults.user_id_column }}) as to_count
      FROM {{ connection.defaults.events_table }} e1
      LEFT JOIN {{ connection.defaults.events_table }} e2 
        ON e1.{{ connection.defaults.user_id_column }} = e2.{{ connection.defaults.user_id_column }}
        AND e2.{{ connection.defaults.event_type_column }} = '{{ query.to_event_id }}'
        AND e2.{{ connection.defaults.timestamp_column }} > e1.{{ connection.defaults.timestamp_column }}
      WHERE e1.{{ connection.defaults.event_type_column }} = '{{ query.from_event_id }}'
        AND e1.{{ connection.defaults.timestamp_column }} BETWEEN '{{ window.start }}' AND '{{ window.end }}'
```

**Assessment:** ⚠️ Verbose but declarative - Template substitution for table/column names

**Challenges:**
- Very verbose
- Hard to read/maintain
- Schema validation is tricky

---

**Level 4: Complex CTEs & Window Functions (🔴 Declarative Breaking Point)**

**Scenario:** Need to calculate step-by-step funnel with time windows and exclusions

```sql
WITH user_journey AS (
  SELECT 
    user_id,
    event_type,
    timestamp,
    LAG(event_type) OVER (PARTITION BY user_id ORDER BY timestamp) as prev_event,
    LAG(timestamp) OVER (PARTITION BY user_id ORDER BY timestamp) as prev_timestamp,
    LEAD(event_type) OVER (PARTITION BY user_id ORDER BY timestamp) as next_event
  FROM events
  WHERE timestamp BETWEEN '2025-01-01' AND '2025-01-31'
    AND cohort_id = 'mobile_users'
),
visited_filter AS (
  SELECT DISTINCT user_id
  FROM user_journey
  WHERE event_type IN ('view_product', 'add_to_cart')
),
excluded_users AS (
  SELECT DISTINCT user_id
  FROM events
  WHERE event_type IN ('abandoned_cart')
    AND timestamp BETWEEN '2025-01-01' AND '2025-01-31'
),
funnel AS (
  SELECT 
    uj.user_id,
    COUNT(CASE WHEN uj.event_type = 'checkout' THEN 1 END) as reached_checkout,
    COUNT(CASE WHEN uj.event_type = 'purchase' AND uj.prev_event = 'checkout' THEN 1 END) as completed_purchase
  FROM user_journey uj
  INNER JOIN visited_filter vf ON uj.user_id = vf.user_id
  LEFT JOIN excluded_users eu ON uj.user_id = eu.user_id
  WHERE eu.user_id IS NULL
  GROUP BY uj.user_id
)
SELECT 
  SUM(reached_checkout) as from_count,
  SUM(completed_purchase) as to_count,
  CAST(SUM(completed_purchase) AS FLOAT) / NULLIF(SUM(reached_checkout), 0) as conversion_rate
FROM funnel;
```

**Can this be templated declaratively?** 

🔴 **Technically yes, but becomes unmaintainable:**

```yaml
query_template: |
  WITH user_journey AS (
    SELECT 
      {{ connection.defaults.user_id_column }},
      {{ connection.defaults.event_type_column }},
      {{ connection.defaults.timestamp_column }},
      LAG({{ connection.defaults.event_type_column }}) OVER (
        PARTITION BY {{ connection.defaults.user_id_column }} 
        ORDER BY {{ connection.defaults.timestamp_column }}
      ) as prev_event
    FROM {{ connection.defaults.events_table }}
    WHERE {{ connection.defaults.timestamp_column }} BETWEEN '{{ window.start }}' AND '{{ window.end }}'
      {{#if context.id}}AND cohort_id = '{{ context.id }}'{{/if}}
  ),
  {{#if query.visited_event_ids}}
  visited_filter AS (
    SELECT DISTINCT {{ connection.defaults.user_id_column }}
    FROM user_journey
    WHERE {{ connection.defaults.event_type_column }} IN ({{ query.visited_event_ids | map(quote) | join(', ') }})
  ),
  {{/if}}
  {{#if query.excluded_event_ids}}
  excluded_users AS (
    SELECT DISTINCT {{ connection.defaults.user_id_column }}
    FROM {{ connection.defaults.events_table }}
    WHERE {{ connection.defaults.event_type_column }} IN ({{ query.excluded_event_ids | map(quote) | join(', ') }})
      AND {{ connection.defaults.timestamp_column }} BETWEEN '{{ window.start }}' AND '{{ window.end }}'
  ),
  {{/if}}
  -- ... etc (hundreds more lines)
```

**Assessment:** 🔴 **Unmaintainable** - Need TypeScript adapter

---

**Level 5: Query Builder Pattern (🔴 Requires TypeScript)**

**Scenario:** Dynamically construct query based on available data model

```typescript
// src/adapters/SnowflakeAdapter.ts
export class SnowflakeAdapter extends BaseAdapter {
  async buildQuery(query: Query, context: Context): Promise<string> {
    const qb = new QueryBuilder(this.connection.defaults.schema);
    
    // Detect available tables/columns
    const hasUserJourney = await this.hasTable('user_journey');
    const hasEventProperties = await this.hasColumn('events', 'properties');
    
    // Build funnel query
    if (hasUserJourney) {
      return this.buildFromUserJourney(query, context);
    } else {
      return this.buildFromRawEvents(query, context);
    }
  }
  
  private buildFromUserJourney(query: Query, context: Context): string {
    const qb = new QueryBuilder();
    
    qb.with('funnel_users', (sub) => {
      sub.select('user_id')
         .from('user_journey')
         .where('timestamp', 'between', [context.window.start, context.window.end]);
      
      if (query.visited_event_ids?.length) {
        sub.where('event_type', 'in', query.visited_event_ids);
      }
    });
    
    qb.select(['COUNT(DISTINCT user_id) as from_count'])
      .from('user_journey')
      .join('funnel_users', 'user_id')
      .where('event_type', '=', query.from_event_id);
      
    return qb.toSQL();
  }
}
```

**Assessment:** 🔴 **TypeScript required** - Complex logic, schema introspection, conditional structure

---

### SQL Complexity Decision Matrix

| Feature | Declarative? | Notes |
|---------|-------------|-------|
| **Template variables** | ✅ Yes | Basic substitution |
| **Simple WHERE clauses** | ✅ Yes | With SQL escaping |
| **Fixed JOINs** | ✅ Yes | If schema is known |
| **Array parameters** (`IN` clause) | ✅ Yes | With `map` + `join` filters |
| **Conditional blocks** | ✅ Yes | Handlebars `{{#if}}` |
| **Dynamic table/column names** | ⚠️ Yes but verbose | Lots of template vars |
| **Multiple CTEs** | ⚠️ Yes but hard | Nested conditionals |
| **Window functions** | ⚠️ Yes but rigid | No dynamic structure |
| **Query structure variation** | 🔴 No | Need TypeScript |
| **Schema introspection** | 🔴 No | Need TypeScript |
| **Query optimization** | 🔴 No | Need TypeScript |

### Recommended Approach for SQL

**Tier 1: Simple queries (✅ Pure declarative)**
- Single table or simple join
- Fixed schema
- Template variables only
- Example: Google Sheets-style parameter lookup

**Tier 2: Moderate complexity (⚠️ Declarative with helpers)**
- Multiple tables with known schema
- Conditional CTEs based on query params
- Dynamic column selection from config
- Requires: Good template engine, SQL helpers
- Example: Funnel query with visited/excluded events

**Tier 3: Complex queries (🔴 TypeScript adapter)**
- Schema introspection
- Query structure varies by data model
- Performance optimization
- Complex business logic
- Example: Auto-detect best funnel strategy

### Design Decision: SQL Connection Pattern

**For connections.yaml SQL adapters:**

```yaml
connections:
  - name: snowflake-prod
    provider: snowflake
    kind: sql
    
    # Option A: Simple declarative (fixed query)
    adapter:
      request:
        query_template: "SELECT ..."  # Simple template
    
    # Option B: Declarative with schema config
    adapter:
      schema_config:
        events_table: "analytics.events"
        user_id_column: "user_id"
      request:
        query_template: "SELECT {{ schema.user_id_column }} FROM {{ schema.events_table }}"
    
    # Option C: TypeScript adapter reference
    adapter:
      type: typescript
      class: SnowflakeAdapter
      path: "src/adapters/SnowflakeAdapter.ts"
```

**Recommendation:**
- Start with Option A (simple declarative) for MVP
- Add Option B (schema config) for flexibility
- Support Option C (TypeScript) for complex cases
- Most users will be fine with A or B

### 14.3 Statsig API - Validation Needed

**Two Integration Paths:**

**Path A: Direct Console API (for variant allocations)**
- Fetch experiment config directly from Statsig
- Get variant allocation percentages
- Update case node weights

**Path B: Via Amplitude (for actual variant traffic)**
- Statsig sends exposure events to Amplitude (via integration)
- Query Amplitude for actual variant distribution
- More accurate (reflects real traffic vs configured allocation)

**User Note:** "case(case_id:variant) also should be ok as activegates go into Amplitude from Statsig"
- This means: Statsig gate exposures fire events into Amplitude
- We can query Amplitude for variant distribution: `SELECT variant FROM statsig_exposure WHERE gate_id = 'checkout_experiment'`
- Advantage: Real traffic data, not just configured allocations
- Challenge: Need to map Statsig gate exposures to Amplitude events

**Expected Endpoints (Console API):**

**Console API (Read-only):**
```
GET https://api.statsig.com/v1/gates/{gate_id}
Authorization: statsig-api-key: {console_api_key}

Response (expected):
{
  "data": {
    "id": "checkout_experiment",
    "name": "Checkout Flow Experiment",
    "isEnabled": true,
    "variants": [
      {
        "id": "control",
        "name": "Control",
        "allocation_percent": 50,
        "description": "Original checkout"
      },
      {
        "id": "treatment_a",
        "name": "Treatment A",
        "allocation_percent": 30
      }
    ]
  }
}
```

**Experiments API:**
```
GET https://console.statsig.com/v1/experiments/{experiment_id}/config
```

**TODO:**
- [ ] Verify Statsig Console API vs Client API (we need Console API for reading config)
- [ ] Check authentication: API key types (Console API key != Client SDK key)
- [ ] Validate response format: How are variant allocations represented?
- [ ] Test: Can we read both Gates and Experiments with same endpoint?
- [ ] Determine: Do we need to read layer configs separately?
- [ ] Check: Rate limits, required permissions

**Key Question:**
- Statsig has Client SDKs (for evaluating gates) vs Console API (for reading configs)
- We need Console API to read variant **allocations**, not evaluate gates
- Verify: Does Console API expose allocation percentages?

### 14.4 Research Action Items

**Priority 1: Before Implementation**
1. Create test accounts for all three services
2. Test actual API endpoints with curl/Postman
3. Document exact request/response formats
4. Update adapter specs with real data structures
5. Validate authentication flows (OAuth2 vs API keys)

**Priority 2: During Implementation**
1. Build adapter test harness to validate against live APIs
2. Create mock responses for unit tests
3. Document error codes and handling
4. Test rate limiting and retry logic

**Priority 3: Post-MVP**
1. Explore additional providers (Optimizely, Mixpanel, Segment)
2. Document provider-specific quirks and best practices
3. Create adapter templates for common patterns

### 14.5 Design Confidence Levels

| Provider | Confidence | Complexity | Notes |
|----------|-----------|------------|-------|
| **Google Sheets** | 🟢 High | 🟢 Low | API v4 is well-documented, OAuth2 flows are standard, transformations are simple |
| **Amplitude** | 🟡 Medium | 🔴 High | Complex funnel transformation required, exclusion steps need validation |
| **Statsig** | 🟢 High | 🟢 Low | Two paths available (Console API or via Amplitude), both straightforward |

### 14.6 DAS Complexity Assessment

**Can DAS handle these transformations declaratively?**

| Transformation | DAS Feasible? | Fallback |
|----------------|---------------|----------|
| **Array construction** (`[...visited, from, to]`) | ✅ Yes | With JavaScript support in `pre_request` |
| **Index tracking** (`indexOf`) | ✅ Yes | With variable scoping across phases |
| **Dynamic extraction** (`steps[computed_index]`) | ✅ Yes | With template interpolation in JMES paths |
| **Array mapping** (`map(e => {event_type: e})`) | ✅ Yes | With filters/transformations in templates |
| **Conditional logic** (exclusion handling) | ⚠️ Complex | May need TypeScript adapter |

**Verdict:** 
- ✅ **Core DAS can handle Amplitude transformation** - IF we include JavaScript execution in `pre_request`
- ⚠️ **TypeScript escape hatch recommended** - For edge cases or performance-critical paths
- 🎯 **Hybrid approach**: Start declarative, allow TypeScript override for specific providers

### 14.7 Research Priority & Next Steps

**Priority 1: Validate Amplitude (CRITICAL)**
1. [ ] Create Amplitude account, test Dashboard API access
2. [ ] Test funnel query API - confirm response format
3. [ ] Test exclusion step capabilities
4. [ ] Validate transformation logic with real data
5. [ ] Measure query latency/rate limits

**Priority 2: Implement DAS Engine Core**
1. [ ] Design DAS Runner architecture (see Section 5)
2. [ ] Implement JavaScript execution for `pre_request` scripts
3. [ ] Implement variable scoping (pre_request → request → response)
4. [ ] Implement template engine with filters (Handlebars/Liquid + custom filters)
5. [ ] Implement JMES/JSONPath extraction with interpolation

**Priority 3: Provider Validation**
1. [ ] Google Sheets: Test both API v4 and Query Language
2. [ ] Statsig: Test Console API and Amplitude integration path
3. [ ] Document actual request/response formats

**Priority 4: TypeScript Adapter Escape Hatch**
1. [ ] Design BaseAdapter interface
2. [ ] Implement adapter registry (declarative vs TypeScript)
3. [ ] Create AmplitudeAdapter as reference implementation

**Recommendation:** 

1. **Start with Google Sheets** (simple, high confidence)
2. **Build DAS engine** with JavaScript support
3. **Test Amplitude transformation** declaratively
4. **Add TypeScript fallback** if needed
5. **Iterate based on real API behavior**

---

## Summary

This design provides:
1. **Single connections.yaml** - Configuration + adapters in one file
2. **Simplified 2-field model** - `connection` + `connection_string` (not 5+ fields)  
3. **Query object** - For Amplitude-like providers: `from_event_id`, `to_event_id`, `visited`
4. **connection_string_schema** - Drives dynamic UI forms per provider
5. **Graph-level window/context** - Set once, applies to all fetches (synced across tabs)
6. **Integrated adapters** - Part of connection, not scattered files
7. **Declarative + TypeScript hybrid** - DAS for 80% of cases, TypeScript escape hatch for complex transformations
8. **Secure** - Secrets separate, resolved at runtime

**Key Design Decisions:**

✅ **DAS CAN handle Amplitude complexity** - With JavaScript execution in `pre_request` phase  
✅ **TypeScript escape hatch included** - For truly complex or performance-critical cases  
✅ **event_id not node_id** - Queries reference `node.event_id` (Amplitude event names)  
⚠️ **Amplitude exclusions** - Need to validate API support for "did NOT perform event X"  
✅ **Statsig via Amplitude** - Can query actual variant traffic from Amplitude exposure events

**Status:** Preliminary design complete, pending API validation (see Section 14)

**Complexity Assessment:**
- 🟢 **Google Sheets**: Low complexity, high confidence
- 🔴 **Amplitude**: High complexity (funnel transformation), medium confidence
- 🟢 **Statsig**: Low complexity, high confidence

**Next Steps:**
1. **Validate Amplitude API** - CRITICAL: Test funnel queries, exclusion steps (Section 14.7)
2. **Build DAS engine core** - With JavaScript execution, variable scoping, template interpolation
3. **Start with Google Sheets** - Simplest provider, validate DAS architecture
4. **Implement Amplitude adapter** - Test declarative approach, add TypeScript fallback if needed
5. **Iterate based on real API behavior**

**Implementation Estimate:** 46-58 hours (revised - see Section 15)

---

## 15. Pre-Implementation Review: Blockers vs Deferrables

### 15.1 TRUE BLOCKERS (Must Complete Before v1)

**A. Schema Definitions** 🚨 REQUIRED

1. **connections-schema.json** - Machine-readable JSON Schema:
   - Discriminated union by `provider` field
   - `$schema` and `version` fields
   - Required fields per provider type
   - Validation for `credsRef`, `connection_string_schema`, adapter sections

2. **Graph schema updates** - Add to existing graph schema:
   ```typescript
   // Graph-level connection (for fetching all params at once)
   graph.connection?: string;              // Connection name from connections.yaml
   graph.connection_string?: string;       // JSON blob (provider-specific)
   graph.evidence?: { source, fetched_at, ... };
   
   // NOTE: window/context are NOT persisted in graph file
   // They are runtime state in GraphContext when graph is loaded
   ```

3. **Parameter schema updates** - Update edge.p:
   ```typescript
   connection?: string;              // String (FK to connections.yaml), NOT enum
   connection_string?: string;       // JSON blob (validated against connection_string_schema)
   query?: {
     from: string;                   // node.id reference
     to: string;
     visited?: string[];
     excluded?: string[];
   };
   evidence?: { n, k, window_from, window_to, source, fetched_at };
   ```
   **ACTION**: Remove hard enum constraint on `connection` field (was: `enum: ['amplitude', 'sheets', ...]`)

4. **Case schema updates**:
   ```typescript
   connection?: string;              // String (FK to connections.yaml), NOT enum
   connection_string?: string;       // JSON blob
   evidence?: { source, fetched_at, variants: [...] };
   ```
   **ACTION**: Remove hard enum constraint on `connection` field

5. **Node schema** - Do NOT enforce `event_id`:
   - `event_id` is optional in schema
   - If missing at runtime when needed for external query → fail gracefully with clear error:
     ```
     "Node 'checkout' is missing required 'event_id' field for external data queries.
     Add event_id to node definition or remove connection from parameter."
     ```

**B. Minimal Templating Spec** 🚨 REQUIRED
- **Syntax**: Mustache `{{variable}}` (simple, no logic)
- **Scope**: `{connection, credentials, dsl, window, context, connection_string, ...extracted_vars}`
- **Filters**: `| json`, `| url_encode` for v1
- **Error handling**: Undefined variable → throw (fail fast)

**C. Basic Secrets Interpolation** 🚨 REQUIRED
- Resolve `{{credentials.api_key}}` at runtime
- Never log credential values
- Basic masking in error messages

**Verdict: 3 items (A, B, C) must be locked before starting implementation.**

---

### 15.2 CAN DEFER / IMPLEMENT ALONGSIDE (Not Blocking)

**D. Advanced HTTP Features** ⏸️ PARTIAL DEFER

- ⚠️ **CORS/Proxy & Sync vs Async Architecture** - DECISION NEEDED:
  ```
  CONTEXT: User notes they're planning future "API mode" where fetches happen server-side
  
  Current plan: Synchronous mode (browser → external APIs)
  Future plan: Async mode (browser → dagnet API → external APIs)
  
  QUESTION: Should we architect for server-side from the start?
  
  ─────────────────────────────────────────────────────────────────
  
  OPTION A: Client-Side First (current plan)
  ─────────────────────────────────────────────────────────────────
  v1: DAS Runner runs in browser
    - User clicks "Get from source"
    - Browser fetch() → Amplitude/Sheets directly
    - CORS issues handled ad-hoc (proxy if needed)
    - Results written to graph immediately
  
  v2: Add server-side API mode
    - Refactor DAS Runner to run in Node
    - Browser → /api/fetch → external APIs
    - Async job queue, webhooks on completion
  
  PROS: Ship faster, iterate on UX
  CONS: Rewrite DAS Runner later, CORS workarounds may be hacky
  
  ─────────────────────────────────────────────────────────────────
  
  OPTION B: Server-Side from Start
  ─────────────────────────────────────────────────────────────────
  v1: DAS Runner runs in Vercel serverless functions
    - User clicks "Get from source"
    - Browser → /api/das/execute → external APIs
    - No CORS issues (server-to-server)
    - Return results to browser, browser updates graph
  
  Later: Add async mode
    - /api/das/execute?async=true
    - Job queue, polling/webhooks
  
  PROS: No CORS issues, portable DAS Runner, cleaner architecture
  CONS: ~8-12 extra hours for serverless setup, harder to debug
  
  ─────────────────────────────────────────────────────────────────
  
  OPTION C: Hybrid - Portable DAS Runner ⭐ SELECTED
  ─────────────────────────────────────────────────────────────────
  v1: Write DAS Runner to be portable (browser OR Node)
    - Abstract HTTP layer: BrowserHttpExecutor vs ServerHttpExecutor
    - Abstract secrets: IndexedDB vs server-side vault
    - Runtime detection: if (typeof window !== 'undefined')
  
  Phase 4: Run in browser (faster iteration, test connections path)
    - Try direct fetch() first
    - If CORS fails → add /api/proxy passthrough
  
  Phase 5+: Move to serverless when ready
    - Deploy same DAS Runner code to /api/das/execute
    - Switch client to call API instead of running locally
    - No code rewrite needed!
  
  PROS: 
    - Portable, no rewrite, can switch easily
    - Tests actual connection code path that will scale to API mode
    - Browser mode for fast iteration, then seamless transition
  
  CONS: 
    - Slightly more complex abstraction layer (~4 hours)
  
  ═════════════════════════════════════════════════════════════════
  WHAT'S INVOLVED: Abstraction Layer Details
  ═════════════════════════════════════════════════════════════════
  
  1. HTTP Executor Interface (~1.5 hours)
     ────────────────────────────────────────────────────────────
     Define common interface, swap implementation at runtime
     
     ```typescript
     // graph-editor/src/lib/das/HttpExecutor.ts
     export interface HttpExecutor {
       execute(request: HttpRequest): Promise<HttpResponse>;
     }
     
     export class BrowserHttpExecutor implements HttpExecutor {
       async execute(req: HttpRequest): Promise<HttpResponse> {
         const response = await fetch(req.url, {
           method: req.method,
           headers: req.headers,
           body: req.body ? JSON.stringify(req.body) : undefined,
         });
         return {
           status: response.status,
           headers: Object.fromEntries(response.headers.entries()),
           body: await response.json(),
         };
       }
     }
     
     export class ServerHttpExecutor implements HttpExecutor {
       async execute(req: HttpRequest): Promise<HttpResponse> {
         // Node.js implementation (uses 'node-fetch' or native fetch in Node 18+)
         const fetch = globalThis.fetch || (await import('node-fetch')).default;
         // ... same logic as browser
       }
     }
     ```
  
  2. Secrets Provider - REUSE EXISTING (~30 min)
     ────────────────────────────────────────────────────────────
     ✅ ALREADY IMPLEMENTED: `lib/credentials.ts`
     
     ```typescript
     // EXISTING: graph-editor/src/lib/credentials.ts
     export class CredentialsManager {
       async loadCredentials(): Promise<CredentialLoadResult> {
         // Strict precedence logic ALREADY handles both environments:
         // 1. URL credentials (temporary, not persisted)
         // 2. System secret (serverless ENV_VAR) - temporary, not persisted
         // 3. IndexedDB credentials (user saved) - persistent
         // 4. Public access (no credentials)
       }
     }
     
     // DAS Runner can use this directly!
     // graph-editor/src/lib/das/DASRunner.ts
     export class DASRunner {
       constructor(
         private httpExecutor: HttpExecutor,
         private credentialsManager: CredentialsManager  // ← Use existing!
       ) {}
       
       async execute(adapter: Adapter, dsl: any): Promise<any> {
         // Load credentials using existing unified system
         const credResult = await this.credentialsManager.loadCredentials();
         const credentials = credResult.data[adapter.connection.credsRef] || {};
         
         // ... rest of execution
       }
     }
     ```
     
     **NO NEW CODE NEEDED** - Just wire up existing `CredentialsManager`
     
     **Notes:**
     - Browser: Reads from IndexedDB via FileState (credentials.yaml)
     - Server: Reads from VITE_CREDENTIALS_JSON (already supported!)
     - Optional: VITE_CREDENTIALS_SECRET for URL secret validation
     - Precedence logic already handles both environments
     - Generic library design already works in both browser and Node
  
  3. DAS Runner Factory (~15 min)
     ────────────────────────────────────────────────────────────
     Detect environment and create appropriate runner
     
     ```typescript
     // graph-editor/src/lib/das/DASRunnerFactory.ts
     import { CredentialsManager } from '../credentials';
     
     export function createDASRunner(): DASRunner {
       const isBrowser = typeof window !== 'undefined';
       
       const httpExecutor = isBrowser 
         ? new BrowserHttpExecutor()
         : new ServerHttpExecutor();
       
       // REUSE existing CredentialsManager (already handles both environments!)
       const credentialsManager = new CredentialsManager();
       
       return new DASRunner(httpExecutor, credentialsManager);
     }
     ```
  
  4. DAS Runner Core (uses existing credentials)
     ────────────────────────────────────────────────────────────
     Uses injected dependencies, doesn't care about environment
     
     ```typescript
     // graph-editor/src/lib/das/DASRunner.ts
     import { CredentialsManager } from '../credentials';
     
     export class DASRunner {
       constructor(
         private httpExecutor: HttpExecutor,
         private credentialsManager: CredentialsManager  // ← Existing system!
       ) {}
       
       async execute(adapter: Adapter, dsl: any): Promise<any> {
         // 1. Resolve credentials using EXISTING system
         //    Handles URL → System → IndexedDB → Public precedence automatically
         const credResult = await this.credentialsManager.loadCredentials();
         const credentials = credResult.data[adapter.connection.credsRef] || {};
         
         // 2. Interpolate templates (Mustache)
         const request = this.buildRequest(adapter, dsl, credentials);
         
         // 3. Execute HTTP request (uses injected executor)
         const response = await this.httpExecutor.execute(request);
         
         // 4. Extract data (JMESPath)
         const extracted = this.extractData(response, adapter.response.extract);
         
         // 5. Transform (JSONata)
         const transformed = this.transformData(extracted, adapter.transform);
         
         // 6. Return results (caller handles upsert)
         return transformed;
       }
     }
     ```
  
  5. Connection Provider Interface (~1 hour)
     ────────────────────────────────────────────────────────────
     Abstract where connections.yaml comes from
     
     ```typescript
     // graph-editor/src/lib/das/ConnectionProvider.ts
     export interface ConnectionProvider {
       getConnection(name: string): Promise<Connection>;
       getAllConnections(): Promise<Connection[]>;
     }
     
     export class IndexedDBConnectionProvider implements ConnectionProvider {
       async getConnection(name: string): Promise<Connection> {
         const connections = await fileRegistry.getFile('connections');
         return connections.connections.find(c => c.name === name);
       }
     }
     
     export class ServerConnectionProvider implements ConnectionProvider {
       async getConnection(name: string): Promise<Connection> {
         // Read from file system or database
         const yaml = await import('js-yaml');
         const fs = await import('fs/promises');
         const content = await fs.readFile('./config/connections.yaml', 'utf8');
         const parsed = yaml.load(content);
         return parsed.connections.find(c => c.name === name);
       }
     }
     ```
  
  ═════════════════════════════════════════════════════════════════
  IMPLEMENTATION TIMELINE (Option C) - UPDATED with existing infra
  ═════════════════════════════════════════════════════════════════
  
  Phase 2a: DAS Abstraction Layer (3 hours) - NEW
    1. Define HttpExecutor interface + BrowserHttpExecutor (~1.5 hrs)
    2. Define ConnectionProvider interface + IndexedDBConnectionProvider (~1 hr)
    3. DASRunnerFactory with environment detection (~30 min)
    ✅ SKIP: SecretsProvider - REUSE existing CredentialsManager! (-1 hr)
  
  Phase 2b: DAS Runner Core (10-12 hours) - UNCHANGED
    1. Wire up existing CredentialsManager (already handles browser + server!)
    2. Mustache interpolation
    3. JMESPath extraction
    4. JSONata transformation
    5. Request building, response handling
    6. UpdateManager integration
  
  Phase 4: Test in Browser (8-10 hours)
    1. Wire up DASRunnerFactory in client
    2. Test with real APIs
    3. If CORS fails → add /api/proxy passthrough (temp workaround)
  
  Phase 5+ (FUTURE): Move to Serverless (3-4 hours when needed)
    1. Implement ServerHttpExecutor (trivial, same as browser)
    2. Implement ServerConnectionProvider (read from file system)
    3. Create /api/das/execute endpoint
    4. Import DASRunner, call with server implementations
    5. Client switches from local execution to API call
    
    ✅ Credentials already work server-side via VITE_CREDENTIALS_JSON!
    ✅ UpdateManager already works server-side (pure JS/TS, no Node deps)!
    NO REWRITE of DAS Runner core needed!
  
  ═════════════════════════════════════════════════════════════════
  DEPLOYMENT PATHS
  ═════════════════════════════════════════════════════════════════
  
  Browser Mode (Phase 4):
    User clicks "Get from source"
      → createDASRunner() detects browser
      → Uses BrowserHttpExecutor (fetch)
      → Uses existing CredentialsManager (IndexedDB or URL)
      → Executes in main thread
      → Returns results to UI
      → UI calls UpdateManager
  
  Server Mode (Phase 5+):
    User clicks "Get from source"
      → Client calls /api/das/execute
      → Server: createDASRunner() detects Node
      → Uses ServerHttpExecutor (node-fetch)
      → Uses existing CredentialsManager (VITE_CREDENTIALS_JSON)
      → Executes in serverless function
      → Returns results to client
      → UI calls UpdateManager
  
  Same DAS Runner code, different implementations injected!
  ✅ Credentials work in BOTH modes via existing CredentialsManager!
  
  ═════════════════════════════════════════════════════════════════
  
  ═════════════════════════════════════════════════════════════════
  WHY THIS WORKS
  ═════════════════════════════════════════════════════════════════
  
  Key insight: DAS Runner core logic is the SAME regardless of environment
    - Template interpolation (Mustache) - same in browser & Node
    - Data extraction (JMESPath) - same in browser & Node
    - Transformation (JSONata) - same in browser & Node
  
  Only 2 things change by environment (credentials & UpdateManager already portable!):
    1. How to make HTTP requests (fetch vs node-fetch)
    2. Where to read connections (IndexedDB vs filesystem)
  
  ✅ Credentials: ALREADY portable via existing CredentialsManager!
    - Browser: Reads from IndexedDB (credentials.yaml file)
    - Server: Reads from VITE_CREDENTIALS_JSON (full credentials as JSON string)
    - Optional: VITE_CREDENTIALS_SECRET for ?secret= URL validation
    - Works in both environments without any changes!
  
  ✅ UpdateManager: ALREADY portable!
    - Pure TypeScript/JavaScript (no Node.js dependencies)
    - EventEmitter removed for browser compatibility
    - Uses standard: Map, Array, console, async/await
    - Works in both browser and Node without any changes!
  
  Solution: Inject 2 dependencies + reuse CredentialsManager + UpdateManager → DAS Runner is portable!
  
  This is standard dependency injection / strategy pattern.
  Testing benefit: Can also inject MockHttpExecutor for tests!
  
  Time saved: ~1 hour (no need to build SecretsProvider abstraction)
  ```

- ❌ **OAuth flows** (Google Sheets) - Defer; use API key auth for v1
- ❌ **Rate limiting** - Add when hitting actual limits  
- ❌ **Retry with backoff** - Start with simple timeout, add retries incrementally
- ❌ **Pagination** - V1 assumes single-page responses; add when needed

**E. Advanced DAS Features** ⏸️ DEFER
- ❌ **Pre_request sandbox** - Start declarative-only; add JS execution when transformation complexity demands it
- ❌ **TypeScript escape hatch** - Add when declarative fails for a real adapter
- ❌ **Advanced filters** - Start with `json` and `url_encode`; add more as needed

**F. UI Widgets** ⚠️ USABILITY-CRITICAL (Re-evaluate)

**CONCERN**: If UI isn't usable, people won't use it. Reconsider what's required for v1:

- ✅ **TabbedArrayWidget** - INCLUDE IN V1:
  ```
  WHY: Default RJSF array shows all connections in one long scrollable list.
  With 3+ connections (Amplitude, Sheets, Statsig, SQL...), this becomes unwieldy.
  
  EFFORT: ~3-4 hours
  - Wrap MUI <Tabs> around array items
  - Use connection.name as tab label
  - Show/hide item based on active tab
  - Reuse existing RJSF item rendering
  
  DECISION: Include in Phase 1 (Foundation), not Polish
  ```

- ✅ **MonacoWidget** - INCLUDE IN V1:
  ```
  WHY: body_template, connection_string_schema are JSON/YAML code blocks.
  Default textarea is painful for multi-line code.
  
  EFFORT: ~2-3 hours
  - Wrap @monaco-editor/react (already installed)
  - Pass through RJSF widget props
  - Handle onChange
  
  DECISION: Already planned for Phase 1
  ```

- ✅ **Connection Selector Dropdown** - INCLUDE IN V1:
  ```
  WHY: Users editing param/case/graph need to choose from available connections.
  Typing connection names manually is error-prone.
  
  EFFORT: ~2 hours
  - Read connections.yaml from IndexedDB
  - Populate dropdown with connection.name values
  - Filter by enabled=true
  
  DECISION: Include in Phase 3 (UI Integration) - critical for usability
  ```

- ⚠️ **CredentialsSelector** - EVALUATE:
  ```
  QUESTION: How often do users edit connections.yaml?
  - If rarely (admin task) → text input OK for v1
  - If frequently → dropdown needed
  
  TENTATIVE: Defer to v2 (users can type credential names)
  ```

- ❌ **Specialized Monaco language modes** (JMESPath, JSONata syntax highlighting) - DEFER
- ❌ **JSON Pointer autocomplete** - DEFER (nice-to-have)

**G. Caching & Performance** ⏸️ DEFER
- ❌ **Cache keying** - Skip caching in v1; add simple in-memory cache later
- ❌ **Conflict resolution** - Start with simple replace; add ETags/versioning later
- ❌ **Batch writes** - Start single-write; optimize later

**H. Tooling** ⏸️ DEFER
- ❌ **CLI validator** - Nice-to-have; not required for v1
- ❌ **Contract tests** - Write alongside implementation, not before
- ❌ **Migration system** - Seed basic defaults; add migrations when schema evolves

**Verdict: 5 categories (D, E, F, G, H) can be deferred or built incrementally.**

---

### 15.3 Minimum Viable v1 Scope

**Phase 0: Schema Lock (2-4 hours)** 🚨
1. Write `connections-schema.json` with Amplitude + Sheets variants
2. Update graph/parameter/case schemas with connection fields
3. Write 2 complete example connections in design doc
4. Document Mustache templating syntax

**Phase 1: Foundation (10-14 hours)**
1. Seed empty `connections.yaml` in IndexedDB
2. Add "Connections" to File menu
3. Implement MonacoWidget for code fields (body_template, connection_string_schema)
4. Implement TabbedArrayWidget for connections array (each connection in own tab)
5. Basic FormEditor for connections with custom widgets integrated

**Phase 2a: DAS Abstraction Layer (3 hours)** ⭐ NEW - Portable Architecture
1. Define HttpExecutor interface + BrowserHttpExecutor (fetch wrapper)
2. Define ConnectionProvider interface + IndexedDBConnectionProvider
3. DASRunnerFactory with environment detection (`typeof window`)
✅ SKIP: SecretsProvider - Reuse existing CredentialsManager! (saves ~1 hr)

**Phase 2b: DAS Runner Core (10-12 hours)**
1. Mustache interpolation (`{{variable}}` resolution with filters)
2. Request building (interpolate templates, construct HTTP request object)
3. JMESPath extraction (use `jmespath` npm lib)
4. JSONata transformation (use `jsonata` npm lib)
5. Response handling and error surfacing
6. UpdateManager integration (simple replace mode)
   ✅ UpdateManager is ALREADY portable (no Node.js dependencies - uses pure JS/TS)

**Phase 3: UI Integration (10-12 hours)**
1. **Window selector** - Date range picker:
   ```
   Location: Floating at top-middle of graph canvas
   Widget: MUI DateRangePicker (from-to date picker)
   Default: Last 7 days
   State: Stored in GraphContext (runtime, not persisted in graph file)
   Validation: Warn if range too large (affects API rate limits)
   
   Implementation:
   - Position: absolute, top: 16px, left: 50%, transform: translateX(-50%)
   - Z-index above canvas, below modals
   - Show when graph has any connections configured
   - Format: YYYY-MM-DD (ISO 8601)
   - Timezone: User's local timezone (stored in window object for DAS)
   ```

2. **Context selector** - STUB for v1:
   ```
   Placeholder:
   - UI shows "Context: None" with disabled dropdown
   - DAS Runner accepts context object but doesn't use it yet
   - Future: User can select segments (e.g., "Mobile users", "US only")
   - Context system integration deferred to future work
   ```

3. Connection selector dropdown in param/case/graph editors:
   - Read available connections from connections.yaml
   - Populate dropdown with connection.name (filtered by enabled=true)
   - Show provider icon/label in dropdown

4. Connection_string editor modal (FormEditor with dynamic schema from connection.connection_string_schema)

5. "Get from source" button on parameters/cases/graphs

6. Evidence display (show last fetch timestamp, n/k, source)

7. Error surfacing (show DAS errors in UI with actionable messages)

**Phase 4: First Working Adapter (8-10 hours)**
1. **INVESTIGATE CORS**: Test browser fetch() to Amplitude Dashboard REST API
   - If CORS allowed → use real API directly
   - If CORS blocked → implement minimal Vercel serverless proxy
2. Write Amplitude adapter in connections.yaml (simplified - declarative only, no pre_request)
3. Test end-to-end: Graph → Query → Amplitude API → Evidence → UpdateManager
4. Debug/iterate with real data

**Phase 5: Polish (4-6 hours)**
1. Better error messages
2. Loading states
3. Success feedback
4. Basic in-memory cache (optional)

**Phase 6: Testing (10-14 hours)** 🧪
See detailed testing strategy in Section 15.5 below

**Total v1 with Usable UI & Portable Architecture: 59-77 hours**

**Breakdown:**
- Phase 0 (Schema Lock): 2-4 hours
- Phase 1 (Foundation + UI widgets): 10-14 hours
- Phase 2a (Abstraction Layer): 3 hours ⭐ (saved 1hr - reusing CredentialsManager!)
- Phase 2b (DAS Core): 10-12 hours
- Phase 3 (UI Integration + Window selector): 10-12 hours
- Phase 4 (First Adapter + CORS testing): 8-10 hours
- Phase 5 (Polish): 4-6 hours
- Phase 6 (Testing): 10-14 hours

**Difference from original estimate:**
- Original: 19-25 hours (too optimistic, no testing)
- Realistic v1 with portable architecture + tests: 59-77 hours
- Includes: 
  - TabbedArrayWidget, MonacoWidget (usability-critical)
  - Connection dropdown, Window selector (usability-critical)
  - Portable DAS Runner (browser & Node compatible)
  - Reuses existing CredentialsManager (saves time!)
  - Comprehensive test suite (unit, integration, contract tests)

**Future: Move to Server-Side (3-4 hours when needed):**
- Implement ServerHttpExecutor (trivial)
- Implement ServerConnectionProvider (filesystem)
- Create /api/das/execute endpoint
✅ Credentials already work server-side via VITE_CREDENTIALS_JSON!
- No DAS Runner rewrite needed!

**DECISION: Option C (Portable Architecture) SELECTED ✅**

**Deferred to v2:**
- Pre_request JavaScript execution
- TypeScript adapter escape hatch
- Retries/rate limiting
- Pagination
- OAuth proxy
- Advanced UI widgets
- Migrations
- CLI tooling

---

### 15.4 Schema Lock Action Items (DO FIRST)

**1. connections-schema.json**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://dagnet.dev/schemas/connections/v1.json",
  "version": "1.0.0",
  "type": "object",
  "properties": {
    "connections": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "provider", "kind"],
        "properties": {
          "name": { "type": "string", "pattern": "^[a-z0-9-]+$" },
          "provider": { "type": "string", "enum": ["amplitude", "google-sheets", "statsig", "postgres", "mysql", "snowflake"] },
          "kind": { "type": "string", "enum": ["http", "sql"] },
          "enabled": { "type": "boolean", "default": true },
          "description": { "type": "string" },
          "credsRef": { "type": "string" },
          "defaults": { "type": "object" },
          "connection_string_schema": { "type": "object" },
          "adapter": { /* DAS adapter spec */ }
        },
        "allOf": [
          {
            "if": { "properties": { "provider": { "const": "amplitude" } } },
            "then": {
              "properties": {
                "adapter": {
                  "required": ["request", "response", "transform", "upsert"]
                }
              }
            }
          }
          /* ... more provider-specific validation ... */
        ]
      }
    }
  }
}
```

**2. Update graph-schema.json**
- Add `connection`, `connection_string`, `evidence` fields (same as params/cases)
- **Do NOT add** `metadata.data_fetch_context` (window/context are runtime app state, not persisted)

**3. Update parameter-schema.json**
- Add `connection`, `connection_string`, `query`, `evidence` fields to edge.p
- **REMOVE** hard enum constraint on `connection` field (change from `enum: [...]` to `type: "string"`)
  ```json
  "connection": {
    "type": "string",
    "description": "Connection name (foreign key to connections.yaml)"
  }
  ```

**4. Update case-schema.json**
- Add `connection`, `connection_string`, `evidence` fields
- **REMOVE** hard enum constraint on `connection` field (same as parameter schema)

**5. Node schema**
- `event_id` remains optional
- Runtime validation: If `event_id` missing when needed → fail gracefully with error message

**6. Document templating**
- Mustache syntax: `{{variable}}`, `{{object.field}}`
- Filters: `{{variable | json}}`, `{{variable | url_encode}}`
- Available vars: connection, credentials, dsl, window, context, connection_string

**7. SCOPE: UI Integration**
- Connection selector dropdown in param/case/graph editors
- Reads available connections from `connections.yaml` in IndexedDB
- Filters by `enabled: true`
- Validates against `connection_string_schema` when user edits connection_string

**ACTION:** Write these schemas in `/graph-editor/public/schemas/` before starting any DAS code.

---

### 15.5 Testing Strategy (Phase 6: 10-14 hours)

Comprehensive test suite to ensure reliability and maintainability of the external data system.

#### **Testing Framework**

**Tool:** Vitest (already in use - see `UpdateManager.test.ts`)
- Fast, modern, compatible with Vite
- Good TypeScript support
- Built-in mocking capabilities

**Structure:**
```
graph-editor/src/
├── lib/
│   ├── das/
│   │   ├── DASRunner.ts
│   │   ├── DASRunner.test.ts          ← Unit tests
│   │   ├── HttpExecutor.ts
│   │   ├── HttpExecutor.test.ts       ← Unit tests
│   │   ├── ConnectionProvider.ts
│   │   ├── ConnectionProvider.test.ts ← Unit tests
│   │   └── __mocks__/                 ← Mock data
│   │       ├── amplitude-responses.ts
│   │       ├── sheets-responses.ts
│   │       └── connections-fixtures.ts
│   └── templates/
│       ├── MustacheEngine.ts
│       └── MustacheEngine.test.ts     ← Unit tests
└── integration-tests/
    ├── das-end-to-end.test.ts         ← Integration tests
    └── adapter-contracts.test.ts      ← Contract tests
```

---

#### **15.5.1 Unit Tests (4-6 hours)**

**A. Mustache Template Engine Tests** (~1 hour)
```typescript
// graph-editor/src/lib/templates/MustacheEngine.test.ts
describe('MustacheEngine', () => {
  it('should interpolate simple variables', () => {
    const result = interpolate('Hello {{name}}', {name: 'World'});
    expect(result).toBe('Hello World');
  });
  
  it('should apply json filter', () => {
    const result = interpolate('{{data | json}}', {data: {foo: 'bar'}});
    expect(result).toBe('{"foo":"bar"}');
  });
  
  it('should apply url_encode filter', () => {
    const result = interpolate('{{text | url_encode}}', {text: 'hello world'});
    expect(result).toBe('hello%20world');
  });
  
  it('should handle nested object access', () => {
    const result = interpolate('{{credentials.api_key}}', {
      credentials: {api_key: 'secret'}
    });
    expect(result).toBe('secret');
  });
  
  it('should throw on undefined variable', () => {
    expect(() => interpolate('{{missing}}', {})).toThrow('Undefined variable: missing');
  });
  
  it('should handle array access', () => {
    const result = interpolate('{{items[0]}}', {items: ['first', 'second']});
    expect(result).toBe('first');
  });
});
```

**B. HttpExecutor Tests** (~1 hour)
```typescript
// graph-editor/src/lib/das/HttpExecutor.test.ts
describe('BrowserHttpExecutor', () => {
  it('should make GET request', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({'content-type': 'application/json'}),
      json: async () => ({data: 'test'})
    });
    
    const executor = new BrowserHttpExecutor();
    const response = await executor.execute({
      url: 'https://api.example.com/test',
      method: 'GET',
      headers: {}
    });
    
    expect(response.status).toBe(200);
    expect(response.body).toEqual({data: 'test'});
  });
  
  it('should handle timeout', async () => {
    global.fetch = vi.fn().mockImplementation(() => 
      new Promise((resolve) => setTimeout(resolve, 10000))
    );
    
    const executor = new BrowserHttpExecutor({timeout: 100});
    await expect(executor.execute({url: '...', method: 'GET'}))
      .rejects.toThrow('Request timeout');
  });
  
  it('should include request headers', async () => {
    // ... test header forwarding
  });
});
```

**C. ConnectionProvider Tests** (~30 min)
```typescript
// graph-editor/src/lib/das/ConnectionProvider.test.ts
describe('IndexedDBConnectionProvider', () => {
  it('should load connection by name', async () => {
    // Mock IndexedDB
    const mockDB = {
      files: {
        get: vi.fn().mockResolvedValue({
          data: {
            connections: [
              {name: 'amplitude-prod', provider: 'amplitude', ...}
            ]
          }
        })
      }
    };
    
    const provider = new IndexedDBConnectionProvider();
    const conn = await provider.getConnection('amplitude-prod');
    
    expect(conn.name).toBe('amplitude-prod');
    expect(conn.provider).toBe('amplitude');
  });
  
  it('should throw on missing connection', async () => {
    // ... test error handling
  });
});
```

**D. DAS Runner Core Tests** (~1.5-2 hours)
```typescript
// graph-editor/src/lib/das/DASRunner.test.ts
describe('DASRunner', () => {
  let runner: DASRunner;
  let mockHttpExecutor: MockHttpExecutor;
  let mockCredentialsManager: CredentialsManager;
  
  beforeEach(() => {
    mockHttpExecutor = new MockHttpExecutor();
    mockCredentialsManager = new MockCredentialsManager({
      amplitude: {api_key: 'test-key'}
    });
    runner = new DASRunner(mockHttpExecutor, mockCredentialsManager);
  });
  
  it('should resolve credentials and interpolate request', async () => {
    const adapter = {
      connection: {credsRef: 'amplitude'},
      request: {
        method: 'POST',
        path_template: '/api/2/events',
        headers: {
          'Authorization': 'Bearer {{credentials.api_key}}'
        }
      },
      response: {extract: []},
      transform: [],
      upsert: {mode: 'replace', writes: []}
    };
    
    await runner.execute(adapter, {from_event_id: 'test'});
    
    expect(mockHttpExecutor.lastRequest.headers.Authorization)
      .toBe('Bearer test-key');
  });
  
  it('should extract data with JMESPath', async () => {
    mockHttpExecutor.setResponse({
      data: {steps: [{count: 100}, {count: 80}]}
    });
    
    const adapter = {
      response: {
        extract: [
          {name: 'from_count', jmes: 'data.steps[0].count'},
          {name: 'to_count', jmes: 'data.steps[1].count'}
        ]
      },
      // ... minimal adapter
    };
    
    const result = await runner.execute(adapter, {});
    
    expect(result.from_count).toBe(100);
    expect(result.to_count).toBe(80);
  });
  
  it('should transform data with JSONata', async () => {
    const extracted = {from_count: 100, to_count: 80};
    
    const adapter = {
      transform: [
        {name: 'p_mean', jsonata: 'to_count / from_count'}
      ],
      // ... minimal adapter
    };
    
    const result = await runner.execute(adapter, {});
    
    expect(result.p_mean).toBeCloseTo(0.8);
  });
  
  it('should handle missing credentials gracefully', async () => {
    mockCredentialsManager = new MockCredentialsManager({});
    runner = new DASRunner(mockHttpExecutor, mockCredentialsManager);
    
    const adapter = {connection: {credsRef: 'missing'}, /* ... */};
    
    await expect(runner.execute(adapter, {}))
      .rejects.toThrow('Missing credentials for "missing"');
  });
});
```

**E. Node Reso lution Tests** (~30 min)
```typescript
// graph-editor/src/lib/das/buildDslFromEdge.test.ts
describe('buildDslFromEdge', () => {
  const graph = {
    nodes: [
      {id: 'node-checkout', uuid: 'uuid-1', event_id: 'checkout'},
      {id: 'node-purchase', uuid: 'uuid-2', event_id: 'purchase'},
      {id: 'node-view', uuid: 'uuid-3', event_id: 'view_product'}
    ]
  };
  
  it('should resolve node IDs to event IDs', () => {
    const edge = {
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
  });
  
  it('should throw on missing node', () => {
    const edge = {p: {query: {from: 'missing', to: 'node-purchase'}}};
    
    expect(() => buildDslFromEdge(edge, graph))
      .toThrow('Query nodes not found');
  });
  
  it('should throw on missing event_id', () => {
    const graphNoEventId = {
      nodes: [{id: 'node-checkout', uuid: 'uuid-1' /* no event_id */}]
    };
    const edge = {p: {query: {from: 'node-checkout', to: 'node-purchase'}}};
    
    expect(() => buildDslFromEdge(edge, graphNoEventId))
      .toThrow('missing event_id');
  });
});
```

---

#### **15.5.2 Integration Tests (3-4 hours)**

**A. End-to-End DAS Execution** (~2 hours)
```typescript
// graph-editor/src/integration-tests/das-end-to-end.test.ts
describe('DAS End-to-End', () => {
  it('should execute full flow: graph → API → UpdateManager', async () => {
    // 1. Setup: Load fixtures
    const graph = loadFixture('test-graph.json');
    const connections = loadFixture('test-connections.yaml');
    const credentials = loadFixture('test-credentials.yaml');
    
    // 2. Mock HTTP responses
    mockFetch.mockAmplitudeResponse({
      data: {
        steps: [
          {event_type: 'checkout', count: 1000},
          {event_type: 'purchase', count: 800}
        ]
      }
    });
    
    // 3. Execute DAS
    const edge = graph.edges.find(e => e.from === 'node-checkout');
    const result = await dasRunner.executeForEdge(edge, graph, {
      window: {start: '2025-01-01', end: '2025-01-31'},
      context: {}
    });
    
    // 4. Verify results
    expect(result.updates).toHaveLength(3);
    expect(result.updates[0]).toMatchObject({
      target: '/edges/edge-123/p/mean',
      value: 0.8
    });
    
    // 5. Apply to graph via UpdateManager
    const updateResult = await updateManager.handleExternalToGraph(
      result.updates,
      graph,
      'UPDATE'
    );
    
    expect(updateResult.success).toBe(true);
    expect(graph.edges[0].p.mean).toBeCloseTo(0.8);
    expect(graph.edges[0].p.evidence.n).toBe(1000);
    expect(graph.edges[0].p.evidence.k).toBe(800);
  });
  
  it('should handle API errors gracefully', async () => {
    mockFetch.mockRejectedValue(new Error('API rate limit exceeded'));
    
    const result = await dasRunner.executeForEdge(edge, graph, {});
    
    expect(result.success).toBe(false);
    expect(result.error).toContain('rate limit');
  });
  
  it('should respect override flags', async () => {
    edge.p._override = {mean: true}; // User manually set mean
    
    const result = await dasRunner.executeForEdge(edge, graph, {});
    
    // Should NOT update mean (but should update evidence)
    expect(result.updates.find(u => u.target.includes('/mean'))).toBeUndefined();
    expect(result.updates.find(u => u.target.includes('/evidence'))).toBeDefined();
  });
});
```

**B. Multi-Connection Tests** (~1 hour)
```typescript
describe('Multiple Connections', () => {
  it('should handle graph with multiple connection types', async () => {
    const graph = {
      edges: [
        {id: 'e1', p: {connection: 'amplitude-prod', ...}},
        {id: 'e2', p: {connection: 'sheets-metrics', ...}}
      ]
    };
    
    // Execute all edges
    const results = await Promise.all(
      graph.edges.map(e => dasRunner.executeForEdge(e, graph, {}))
    );
    
    expect(results[0].success).toBe(true); // Amplitude
    expect(results[1].success).toBe(true); // Sheets
  });
});
```

**C. Window/Context Tests** (~1 hour)
```typescript
describe('Window & Context', () => {
  it('should pass window to API request', async () => {
    const window = {start: '2025-01-01', end: '2025-01-31'};
    
    await dasRunner.executeForEdge(edge, graph, {window});
    
    const request = mockHttpExecutor.lastRequest;
    expect(request.body).toContain('2025-01-01');
    expect(request.body).toContain('2025-01-31');
  });
  
  it('should store window in evidence', async () => {
    const window = {start: '2025-01-01', end: '2025-01-31'};
    
    const result = await dasRunner.executeForEdge(edge, graph, {window});
    
    const evidenceUpdate = result.updates.find(u => 
      u.target.includes('/evidence/window_from')
    );
    expect(evidenceUpdate.value).toBe('2025-01-01');
  });
});
```

---

#### **15.5.3 Adapter Contract Tests (3-4 hours)**

**Purpose:** Ensure adapters conform to expected behavior with real API structures

**A. Amplitude Adapter Contract** (~1.5 hours)
```typescript
// graph-editor/src/integration-tests/adapter-contracts.test.ts
describe('Amplitude Adapter Contract', () => {
  it('should match golden response format', async () => {
    // Load actual Amplitude API response (sanitized)
    const amplitudeResponse = loadFixture('amplitude-funnel-response.json');
    
    mockFetch.mockResolvedValue({
      status: 200,
      json: async () => amplitudeResponse
    });
    
    const result = await dasRunner.execute(amplitudeAdapter, testDsl);
    
    // Verify extracted fields match expectations
    expect(result.from_count).toBeGreaterThan(0);
    expect(result.to_count).toBeGreaterThan(0);
    expect(result.p_mean).toBeGreaterThanOrEqual(0);
    expect(result.p_mean).toBeLessThanOrEqual(1);
  });
  
  it('should handle Amplitude error responses', async () => {
    mockFetch.mockResolvedValue({
      status: 429,
      json: async () => ({error: 'Rate limit exceeded'})
    });
    
    await expect(dasRunner.execute(amplitudeAdapter, testDsl))
      .rejects.toThrow('Rate limit');
  });
  
  it('should correctly build funnel query', async () => {
    const dsl = {
      from_event_id: 'checkout',
      to_event_id: 'purchase',
      visited_event_ids: ['view_product']
    };
    
    await dasRunner.execute(amplitudeAdapter, dsl);
    
    const request = mockHttpExecutor.lastRequest;
    const body = JSON.parse(request.body);
    
    // Verify funnel construction: [visited, from, to]
    expect(body.events).toHaveLength(3);
    expect(body.events[0].event_type).toBe('view_product');
    expect(body.events[1].event_type).toBe('checkout');
    expect(body.events[2].event_type).toBe('purchase');
  });
});
```

**B. Google Sheets Adapter Contract** (~1 hour)
```typescript
describe('Google Sheets Adapter Contract', () => {
  it('should extract labeled parameters from range', async () => {
    const sheetsResponse = loadFixture('sheets-query-response.json');
    // Response format:
    // {table: {rows: [
    //   {c: [{v: 'param_name'}, {v: 0.8}, {v: 0.1}]},
    //   ...
    // ]}}
    
    mockFetch.mockResolvedValue({json: async () => sheetsResponse});
    
    const result = await dasRunner.execute(sheetsAdapter, testDsl);
    
    expect(result.param_name).toBeDefined();
    expect(result.param_name.mean).toBeCloseTo(0.8);
    expect(result.param_name.stdev).toBeCloseTo(0.1);
  });
  
  it('should handle service account authentication', async () => {
    const credentials = {
      googleSheets: {
        serviceAccount: btoa(JSON.stringify({
          type: 'service_account',
          private_key: 'test-key',
          client_email: 'test@example.com'
        }))
      }
    };
    
    // ... verify auth headers are correctly constructed
  });
});
```

**C. Statsig Adapter Contract** (~1 hour)
```typescript
describe('Statsig Adapter Contract', () => {
  it('should extract variant allocations', async () => {
    const statsigResponse = loadFixture('statsig-gate-response.json');
    // Response format:
    // {data: {
    //   gate_id: 'checkout_flow',
    //   variants: [
    //     {name: 'control', allocation: 0.5},
    //     {name: 'treatment', allocation: 0.5}
    //   ]
    // }}
    
    mockFetch.mockResolvedValue({json: async () => statsigResponse});
    
    const result = await dasRunner.execute(statsigAdapter, testDsl);
    
    expect(result.variants).toHaveLength(2);
    expect(result.variants[0].allocation).toBeCloseTo(0.5);
  });
});
```

---

#### **15.5.4 Mock Strategies**

**A. Mock HTTP Responses**
```typescript
// graph-editor/src/lib/das/__mocks__/MockHttpExecutor.ts
export class MockHttpExecutor implements HttpExecutor {
  private responses: Map<string, any> = new Map();
  public lastRequest: HttpRequest | null = null;
  
  mockResponse(url: string, response: any) {
    this.responses.set(url, response);
  }
  
  async execute(request: HttpRequest): Promise<HttpResponse> {
    this.lastRequest = request;
    const response = this.responses.get(request.url);
    if (!response) throw new Error(`No mock for ${request.url}`);
    return response;
  }
}
```

**B. Mock Credentials**
```typescript
// graph-editor/src/lib/__mocks__/MockCredentialsManager.ts
export class MockCredentialsManager extends CredentialsManager {
  constructor(private mockData: any) {
    super();
  }
  
  async loadCredentials(): Promise<CredentialLoadResult> {
    return {
      success: true,
      credentials: this.mockData,
      source: 'test'
    };
  }
}
```

**C. Golden Fixtures**
```typescript
// graph-editor/src/__fixtures__/amplitude-responses.ts
export const amplitudeFunnelResponse = {
  data: {
    steps: [
      {event_type: 'checkout', count: 10000, avg_time_to_convert: 120},
      {event_type: 'purchase', count: 8000, avg_time_to_convert: 0}
    ],
    metadata: {
      start_date: '2025-01-01',
      end_date: '2025-01-31'
    }
  }
};

// Use in tests:
import { amplitudeFunnelResponse } from '../__fixtures__/amplitude-responses';
```

---

#### **15.5.5 Test Coverage Goals**

**Minimum Coverage:**
- **Unit tests:** 80% code coverage
- **Integration tests:** All critical paths (happy path + error cases)
- **Contract tests:** All production adapters (Amplitude, Sheets, Statsig)

**CI/CD Integration:**
```yaml
# .github/workflows/test.yml
- name: Run DAS Tests
  run: |
    npm test -- --coverage --run
    npm test -- integration-tests/ --run

- name: Coverage Report
  run: npx vitest coverage --reporter=lcov
```

---

#### **15.5.6 Test Execution Order**

**Phase 6A: Unit Tests (4-6 hours)**
1. Mustache template engine
2. HttpExecutor (browser & Node mocks)
3. ConnectionProvider
4. Node resolution (buildDslFromEdge)
5. DAS Runner core

**Phase 6B: Integration Tests (3-4 hours)**
6. End-to-end flow with mocked APIs
7. Multi-connection scenarios
8. Window/context handling
9. Error handling and retries

**Phase 6C: Contract Tests (3-4 hours)**
10. Amplitude adapter with golden fixtures
11. Google Sheets adapter
12. Statsig adapter
13. Document expected API formats

**Total: 10-14 hours**

---

