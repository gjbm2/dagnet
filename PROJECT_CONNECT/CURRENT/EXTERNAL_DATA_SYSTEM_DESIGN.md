# External Data System - Complete Design

**Date:** 2025-11-09  
**Status:** 🔵 Design Phase  
**Scope:** credentials.yaml + connections.yaml + DAS adapters + DAS Runner + UI integration

---

## 1. Overview

### Purpose
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
  - name: nous-conversion
    owner: regulus
    token: "github-pat-xyz"
    isDefault: true

# PostgreSQL credentials
warehouse:
  dsn: "postgresql://user:pass@host:5432/db"

# Google Sheets credentials
googleSheets:
  token: "oauth-token"
  serviceAccount: "base64-encoded-service-account-json"
```

**No changes needed** - this already exists and works.

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
      # How to build request
      request:
        method: GET
        path_template: /api/2/funnels
        headers:
          Authorization: Bearer {{ connection.api_key }}
          Accept: application/json
        query:
          project: "{{ connection.project_id }}"
          start: "{{ window.start }}"
          end: "{{ window.end }}"
          context: "{{ context.id }}"
          # NOTE: event_from/event_to come from PARAMETER/EDGE definition (dsl.*)
          # NOT from connection_string (which is for param-specific overrides only)
          event_from: "{{ dsl.from }}"
          event_to: "{{ dsl.to }}"
          visited: "{{ json(dsl.visited) }}"
          excluded: "{{ json(dsl.excluded) }}"
          # Optional: param-specific segment filter from connection_string
          segment: "{{ connection_string.segment_filter }}"
          # Global filters from defaults
          exclude_test_users: "{{ connection.defaults.exclude_test_users }}"
        retry:
          max_attempts: 3
          backoff_ms: 1000
      
      # What to extract from response
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
      
      # How to transform extracted data
      transform:
        - name: p_mean
          jsonata: "$number(total_conversions) / $max([$number(total_attempts), 1])"
        - name: p_stdev
          jsonata: "$sqrt(p_mean * (1 - p_mean) / $max([sample_size, 1]))"
      
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

# REPLACE with just 2 fields:
connection:
  type: string
  description: "Connection name from connections.yaml"

connection_string:
  type: string
  description: "JSON blob with provider-specific settings"
```

**Update graph schema (conversion-graph-1.0.0.json):**
```json
{
  "ProbabilityParam": {
    "properties": {
      "mean": {"type": "number"},
      "stdev": {"type": "number"},
      "parameter_id": {"type": "string"},
      
      // ADD these 2 fields:
      "connection": {
        "type": "string",
        "description": "Connection name from connections.yaml"
      },
      "connection_string": {
        "type": "string", 
        "description": "JSON blob with provider-specific settings"
      },
      
      // REMOVE old data_source object (too complex)
      "evidence": { /* existing */ }
    }
  }
}
```

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

**Note:** When editing `connections.yaml` in FormEditor, we'll need a UI schema for better layout:

```yaml
# ui-schemas/connections-ui-schema.json
{
  "connections": {
    "ui:options": {
      "orderable": false
    },
    "items": {
      "ui:ObjectFieldTemplate": "TabbedObject",  # Each connection in its own tab
      "ui:order": ["name", "provider", "kind", "enabled", "description", "credsRef", "defaults", "connection_string_schema", "adapter"],
      "name": {
        "ui:help": "Unique identifier for this connection"
      },
      "defaults": {
        "ui:widget": "object",
        "ui:collapsed": false
      },
      "connection_string_schema": {
        "ui:widget": "textarea",
        "ui:options": {
          "rows": 10
        }
      },
      "adapter": {
        "ui:collapsed": true,
        "ui:help": "Adapter configuration for data fetching"
      }
    }
  }
}
```

**Why needed:**
- All connections in one YAML = potentially long/unwieldy
- Tabbed interface: Each connection gets its own tab
- Collapsible sections: Adapter details collapsed by default
- Better field ordering and help text

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

      const dsl = edge.query || this.buildDslFromEdge(edge, graph);

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

  private buildDslFromEdge(edge: any, graph: any): string {
    const fromNode = graph.nodes.find((n: any) => n.uuid === edge.from);
    const toNode = graph.nodes.find((n: any) => n.uuid === edge.to);
    
    if (!fromNode || !toNode) {
      throw new Error('Edge nodes not found');
    }

    return `from(${fromNode.id}).to(${toNode.id})`;
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

**Expected Endpoints** (based on common analytics API patterns):

**Dashboard REST API:**
```
GET https://api.amplitude.com/api/2/funnels
Authorization: Bearer {api_key}

Query params:
  - event_from: string
  - event_to: string
  - start: ISO date
  - end: ISO date
  - filters: JSON (for segmentation)
```

**Cohorts API:**
```
GET https://api.amplitude.com/api/2/cohorts/{cohort_id}
```

**TODO:**
- [ ] Verify actual Amplitude Dashboard REST API endpoints (may require paid tier)
- [ ] Check if Amplitude supports funnel queries via API or requires Export API
- [ ] Validate response format: What does funnel data look like?
- [ ] Determine: Do we need Amplitude's Data Taxonomy API for event validation?
- [ ] Test: Can we filter by user properties (for context segmentation)?
- [ ] Investigate: Rate limits, pagination, authentication method (API key vs OAuth)

**Alternative if no direct funnel API:**
- Use Amplitude Export API to download raw events
- Process funnel logic client-side (less ideal)
- Consider using Amplitude's Behavioral Cohorts as proxy

### 14.3 Statsig API - Validation Needed

**Expected Endpoints** (based on feature flag service patterns):

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

| Provider | Confidence | Notes |
|----------|-----------|-------|
| **Google Sheets** | 🟢 High | API v4 is well-documented, OAuth2 flows are standard |
| **Amplitude** | 🟡 Medium | Unsure if Dashboard API exposes funnels programmatically |
| **Statsig** | 🟡 Medium | Need to verify Console API vs Client API capabilities |

**Recommendation:** Start implementation with Google Sheets (highest confidence), then validate Amplitude and Statsig with actual API testing before coding their adapters.

---

## Summary

This design provides:
1. **Single connections.yaml** - Configuration + adapters in one file
2. **Simplified 2-field model** - `connection` + `connection_string` (not 5+ fields)
3. **connection_string_schema** - Drives dynamic UI forms per provider
4. **Graph-level window/context** - Set once, applies to all fetches (synced across tabs)
5. **Integrated adapters** - Part of connection, not scattered files
6. **Declarative** - No code needed to add data sources
7. **Secure** - Secrets separate, resolved at runtime

**Status:** Preliminary design complete, pending API validation (see Section 14)

**Next Steps:**
1. Validate APIs with actual testing (Section 14)
2. Update adapter specs based on real response formats
3. Implement DAS Runner core
4. Start with Google Sheets (highest confidence)

