# connections.yaml - Complete Specification

**Component:** Connections Configuration File  
**Status:** 🔵 Design Complete  
**Reference:** Original design Section 2.2 (lines 304-707)

---

## 1. File Overview

**Location:** IndexedDB + Git repo (safe to commit)  
**File Type:** `connections-connections` (FileState)  
**Access:** File > Connections  
**Format:** YAML  
**Purpose:** Non-secret configuration + DAS adapter specs

---

## 2. Full connections.yaml Structure

See `../../ARCHIVE/EXTERNAL_DATA_SYSTEM_DESIGN.md` lines 315-697 for complete examples including:

### 2.1 Amplitude Production
- Pre_request transformation (funnel building)
- Multi-step funnel extraction
- Segment filtering via connection_string
- Evidence tracking

### 2.2 PostgreSQL Warehouse
- Parameterized SQL queries
- Array parameter handling
- Context and visited/excluded node support

### 2.3 Google Sheets
- Spreadsheet range queries
- OAuth token authentication
- Service Account pattern (base64 encoded JSON)

### 2.4 Statsig Production
- Feature gate retrieval
- Variant allocation transformation
- Environment overrides

### 2.5 Amplitude Dev
- Duplicate provider with different project_id
- Shows multi-environment pattern

---

## 3. Connection Object Schema

```yaml
name: string                    # Unique identifier (lowercase, hyphens)
provider: enum                  # amplitude | postgres | google-sheets | statsig | custom
kind: enum                      # http | sql
credsRef?: string               # References credentials.yaml key
description?: string            # Human-readable description
enabled: boolean                # Can be disabled without deleting

# Non-secret defaults (applied to ALL queries from this connection)
defaults:
  base_url?: string            # API base URL
  project_id?: string          # Provider-specific IDs
  timeout_ms?: number          # Request timeout
  exclude_test_users?: boolean # Global filters
  [key: string]: any           # Provider-specific defaults

# JSON Schema for connection_string validation
connection_string_schema:
  type: object
  description: string
  properties:
    [key: string]:             # Provider-specific properties
      type: string | number | boolean | object | array
      description: string
      examples?: any[]
  required?: string[]
  additionalProperties?: boolean

# DAS Adapter specification (integrated, not separate file)
adapter:
  pre_request?: Array<{        # v2: JavaScript transformations
    name: string
    script: string             # JavaScript that returns value
  }>
  
  request:                     # How to build HTTP/SQL request
    method?: 'GET' | 'POST' | 'PUT'
    path_template: string      # Mustache template
    headers?: Record<string, string>  # Mustache templates
    query?: Record<string, string>
    body_template?: string     # Mustache template (for POST/PUT)
    timeout?: number
    retry?:
      max_attempts: number
      backoff_ms: number
  
  response:                    # What to extract from response
    ok_when?:                  # Response validation
      - jmes: string           # JMESPath condition
    extract:                   # Data extraction
      - name: string
        jmes: string           # JMESPath expression
  
  transform:                   # Data transformation
    - name: string
      jsonata: string          # JSONata expression
  
  upsert:                      # Where to write results
    mode: 'merge' | 'replace'
    writes:
      - target: string         # JSON Pointer (Mustache template)
        value: string          # Mustache template

tags?: string[]                # For filtering/organizing
metadata?:
  created_at: string (ISO)
  created_by: string
```

---

## 4. Connection String Schema Per Provider

### 4.1 Amplitude

```json
{
  "type": "object",
  "description": "Optional param-specific overrides",
  "properties": {
    "segment_filter": {
      "type": "string",
      "description": "Optional segment filter for this specific parameter",
      "examples": ["mobile_users", "premium_users"]
    }
  },
  "additionalProperties": false
}
```

**Usage:** Param-specific segment filtering (e.g., "mobile users only for this conversion")

### 4.2 PostgreSQL

```json
{
  "type": "object",
  "description": "Schema for SQL connection settings",
  "properties": {
    "table": {
      "type": "string",
      "description": "Table name"
    },
    "from_column": {
      "type": "string",
      "description": "Column for source node"
    },
    "to_column": {
      "type": "string",
      "description": "Column for target node"
    }
  },
  "required": ["table", "from_column", "to_column"],
  "examples": [{
    "table": "conversion_events",
    "from_column": "source_event",
    "to_column": "target_event"
  }]
}
```

**Usage:** Specify which table/columns to query for this parameter

### 4.3 Google Sheets

```json
{
  "type": "object",
  "description": "Schema for Google Sheets connection settings",
  "properties": {
    "spreadsheet_id": {
      "type": "string",
      "description": "Google Sheets ID from URL"
    },
    "sheet_name": {
      "type": "string",
      "description": "Sheet tab name"
    },
    "range": {
      "type": "string",
      "description": "Cell range (e.g., A1:B10)"
    }
  },
  "required": ["spreadsheet_id", "range"],
  "examples": [{
    "spreadsheet_id": "1abc123xyz",
    "sheet_name": "Parameters",
    "range": "A2:E100"
  }]
}
```

**Usage:** Specify which spreadsheet, sheet, and range to read

### 4.4 Statsig

```json
{
  "type": "object",
  "description": "Optional case-specific overrides",
  "properties": {
    "gate_id": {
      "type": "string",
      "description": "Statsig gate/experiment ID (if different from case_id)"
    },
    "environment_override": {
      "type": "string",
      "enum": ["production", "staging", "development"],
      "description": "Override default environment for this specific case"
    }
  },
  "additionalProperties": false
}
```

**Usage:** Override gate ID or environment for specific case nodes

---

## 5. Adapter Patterns

### 5.1 Simple HTTP GET

```yaml
adapter:
  request:
    method: GET
    path_template: /api/data/{{param_id}}
    headers:
      Authorization: Bearer {{credentials.api_key}}
  response:
    extract:
      - name: value
        jmes: "data.value"
  transform: []
  upsert:
    mode: replace
    writes:
      - target: /edges/{{edgeId}}/p/mean
        value: "{{value}}"
```

### 5.2 POST with Body

```yaml
adapter:
  request:
    method: POST
    path_template: /api/query
    headers:
      Content-Type: application/json
    body_template: |
      {
        "from": "{{dsl.from_event_id}}",
        "to": "{{dsl.to_event_id}}",
        "window": {
          "start": "{{window.start}}",
          "end": "{{window.end}}"
        }
      }
  response:
    extract:
      - name: result
        jmes: "data.result"
  # ...
```

### 5.3 Pre-Request Transformation (Amplitude Funnel)

```yaml
adapter:
  pre_request:
    # Build full funnel: visited → from → to
    - name: funnel_steps
      script: |
        const visited = dsl.visited_event_ids || [];
        const steps = [...visited, dsl.from_event_id, dsl.to_event_id];
        return steps;
    
    # Find from_step index
    - name: from_step_index
      script: |
        return funnel_steps.indexOf(dsl.from_event_id);
  
  request:
    method: POST
    path_template: /api/2/funnels
    body_template: |
      {
        "events": {{funnel_steps | map(e => {"event_type": e}) | json}},
        "start": "{{window.start}}",
        "end": "{{window.end}}"
      }
  
  response:
    extract:
      # Extract ONLY the from → to step (not entire funnel)
      - name: from_step
        jmes: "data.steps[{{from_step_index}}]"
      - name: to_step
        jmes: "data.steps[{{from_step_index + 1}}]"
  # ...
```

### 5.4 SQL Parameterized Query

```yaml
adapter:
  request:
    query: |
      SELECT
        COUNT(*) AS total_attempts,
        SUM(CASE WHEN success THEN 1 ELSE 0 END) AS total_conversions
      FROM events
      WHERE ts >= $1::timestamptz
        AND ts < $2::timestamptz
        AND from_node = $3::text
        AND to_node = $4::text
    params:
      - "{{window.start}}"
      - "{{window.end}}"
      - "{{dsl.from_event_id}}"
      - "{{dsl.to_event_id}}"
  response:
    extract:
      - name: total_attempts
        jmes: "[0].total_attempts"
      - name: total_conversions
        jmes: "[0].total_conversions"
  # ...
```

---

## 6. Template Variables Available

All adapter templates have access to:

```typescript
{
  // DSL (resolved from edge.p.query + graph.nodes)
  dsl: {
    from_event_id: string,      // Resolved from node.event_id
    to_event_id: string,
    visited_event_ids: string[],
    excluded_event_ids: string[]
  },
  
  // Connection defaults
  connection: {
    name: string,
    defaults: Record<string, any>
  },
  
  // Resolved credentials
  credentials: Record<string, any>,
  
  // Window selector state
  window: {
    start: string,              // ISO date
    end: string,
    timezone?: string
  },
  
  // Context selector state (v2)
  context: {
    id?: string,
    label?: string,
    filters?: Record<string, any>
  },
  
  // Connection string (parsed JSON)
  connection_string: Record<string, any>,
  
  // Current entity IDs
  edgeId?: string,              // For edge parameters
  caseId?: string,              // For case nodes
  parameterId?: string,         // For parameter files
  
  // Extracted variables from previous phases
  [key: string]: any            // From response.extract
}
```

---

## 7. Defaults vs Connection String

**Connection defaults:**
- Applied to ALL queries from this connection
- Non-secret configuration
- Examples: project_id, base_url, exclude_test_users

**Connection string:**
- Param/case-specific overrides
- Validated against connection_string_schema
- Examples: segment_filter (Amplitude), range (Google Sheets), table (SQL)

**Query object (edge.p.query):**
- NOT in connection_string
- Defines the query structure (from/to/visited/excluded)
- Resolved to event_ids via node lookup

---

## 8. Multi-Environment Pattern

**Same provider, different configurations:**

```yaml
connections:
  - name: amplitude-prod
    provider: amplitude
    defaults:
      project_id: "12345"
      exclude_test_users: true
  
  - name: amplitude-dev
    provider: amplitude
    defaults:
      project_id: "67890"
      exclude_test_users: false
  
  - name: amplitude-staging
    provider: amplitude
    defaults:
      project_id: "11111"
      exclude_test_users: true
```

**User selects environment in UI dropdown:**
- edge.p.connection = "amplitude-prod"  (production data)
- edge.p.connection = "amplitude-dev"   (dev data)

---

## 9. Validation Rules

**Name:**
- Pattern: `^[a-z0-9-]+$`
- Must be unique within connections.yaml

**Provider:**
- Enum: amplitude, postgres, mysql, snowflake, google-sheets, statsig, custom

**Kind:**
- Enum: http, sql
- Determines which executor to use

**CredsRef:**
- Must reference existing key in credentials.yaml
- Optional (for public APIs)

**connection_string_schema:**
- Must be valid JSON Schema (Draft 7)
- Used to generate FormEditor UI

**adapter.request.path_template:**
- Must be valid Mustache template
- All {{variables}} must be available in context

**adapter.response.extract[].jmes:**
- Must be valid JMESPath expression

**adapter.transform[].jsonata:**
- Must be valid JSONata expression

**adapter.upsert.writes[].target:**
- Must be valid JSON Pointer
- Can include Mustache templates for dynamic paths

---

## 10. Default connections.yaml (Seed)

When user first opens File > Connections, seed with:

```yaml
version: 1.0.0
connections: []  # Empty, user adds their own
```

**Future:** Could include example connections (disabled by default) for learning

---

## 11. Migration from Old Schema

**v0 (old):**
```typescript
edge.p.source = {
  connection_id: "amplitude-prod",
  connection_settings: '{"segment_filter": "mobile_users"}'
}
```

**v1 (new):**
```typescript
edge.p.connection = "amplitude-prod"
edge.p.connection_string = '{"segment_filter": "mobile_users"}'
edge.p.query = {
  from: "node-checkout",
  to: "node-purchase",
  visited: ["node-view"]
}
```

**Migration script:** Convert `source` → `connection` + `connection_string` + `query`

---

## 12. File Type Registration

```typescript
// In FileState
export const FILE_TYPES = {
  // ... existing types
  connections: {
    id: 'connections',
    label: 'Connections',
    icon: SettingsIcon,
    schemaUrl: '/schemas/connections-schema.json',
    uiSchemaUrl: '/ui-schemas/connections-ui-schema.json',
    defaultData: {
      version: '1.0.0',
      connections: []
    }
  }
};
```

---

## 13. Implementation Checklist

Phase 0 (Schema Lock):
- [ ] Write connections-schema.json (see Section 4.4 in original)
- [ ] Write connections-ui-schema.json (see Section 4.3 in original)
- [ ] Create example connections (Amplitude, Sheets)
- [ ] Validate examples against schema

Phase 1 (Seeding):
- [ ] Implement seedConnectionsFile()
- [ ] Register connections file type
- [ ] Add to File menu

---

**Reference:** See `../../ARCHIVE/EXTERNAL_DATA_SYSTEM_DESIGN.md` lines 304-707 for complete examples with all adapters

