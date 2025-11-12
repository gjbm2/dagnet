# Schema Updates - Complete Specification

**Component:** Graph/Parameter/Case/Node Schema Updates  
**Status:** 🔵 Design Complete (Blocker for Phase 0)  
**Reference:** Original design Section 3 (lines 708-995)

---

## 1. Schema Changes Required

### 1.1 Remove Old Enum Constraints

**CRITICAL:** Must remove hard enum constraints on connection fields!

**Old (WRONG):**
```json
{
  "connection": {
    "enum": ["amplitude", "postgres", "google-sheets"]
  }
}
```

**New (CORRECT):**
```json
{
  "connection": {
    "type": "string",
    "description": "Connection name from connections.yaml (de facto foreign key)"
  }
}
```

---

## 2. Graph Schema Updates

**File:** `/graph-editor/public/schemas/graph-schema.json`

**Add fields:**

```json
{
  "type": "object",
  "properties": {
    "nodes": { "type": "array" },
    "edges": { "type": "array" },
    
    "connection": {
      "type": "string",
      "description": "Graph-level connection (optional, can be overridden by parameters)"
    },
    
    "connection_string": {
      "type": "string",
      "description": "Graph-level connection_string JSON (optional)"
    },
    
    "evidence": {
      "type": "object",
      "description": "Graph-level evidence from last fetch",
      "properties": {
        "source": {
          "type": "string",
          "description": "Connection name used"
        },
        "fetched_at": {
          "type": "string",
          "format": "date-time",
          "description": "ISO timestamp of last fetch"
        },
        "window_from": {
          "type": "string",
          "format": "date",
          "description": "Start date of data window"
        },
        "window_to": {
          "type": "string",
          "format": "date",
          "description": "End date of data window"
        },
        "context_id": {
          "type": "string",
          "description": "Context ID used (if any)"
        }
      }
    }
  }
}
```

**NOTE:** `window` and `context` are NOT stored in graph file - they are runtime state in GraphContext

---

## 3. Parameter Schema Updates (Edge.p)

**File:** `/graph-editor/public/schemas/parameter-schema.json`

**Add to edge.p object:**

```json
{
  "type": "object",
  "properties": {
    "mean": { "type": "number" },
    "stdev": { "type": "number" },
    "distribution": { "type": "string" },
    "_override": { "type": "object" },
    "parameter_id": { "type": "string" },
    
    "connection": {
      "type": "string",
      "description": "Connection name from connections.yaml (foreign key)"
    },
    
    "connection_string": {
      "type": "string",
      "description": "JSON blob of provider-specific settings (validated against connection_string_schema)"
    },
    
    "query": {
      "type": "object",
      "description": "Query definition using node IDs (resolved to event_ids at runtime)",
      "properties": {
        "from": {
          "type": "string",
          "description": "From node ID (NOT uuid, NOT event_id)"
        },
        "to": {
          "type": "string",
          "description": "To node ID"
        },
        "visited": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Array of node IDs that must be visited"
        },
        "excluded": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Array of node IDs that must NOT be visited"
        }
      },
      "required": ["from", "to"]
    },
    
    "evidence": {
      "type": "object",
      "description": "Evidence from last successful fetch",
      "properties": {
        "n": {
          "type": "number",
          "description": "Sample size (total attempts)"
        },
        "k": {
          "type": "number",
          "description": "Successes (conversions)"
        },
        "window_from": {
          "type": "string",
          "format": "date"
        },
        "window_to": {
          "type": "string",
          "format": "date"
        },
        "context_id": {
          "type": "string"
        },
        "source": {
          "type": "string",
          "description": "Connection name used for this fetch"
        },
        "fetched_at": {
          "type": "string",
          "format": "date-time"
        }
      }
    }
  }
}
```

---

## 4. Case Schema Updates

**File:** `/graph-editor/public/schemas/case-schema.json`

**Add to case object:**

```json
{
  "type": "object",
  "properties": {
    "case_id": { "type": "string" },
    "variants": { "type": "array" },
    
    "connection": {
      "type": "string",
      "description": "Connection name for fetching case variants (e.g., from Statsig)"
    },
    
    "connection_string": {
      "type": "string",
      "description": "JSON blob for case-specific settings"
    },
    
    "evidence": {
      "type": "object",
      "description": "Evidence from last variant fetch",
      "properties": {
        "source": {
          "type": "string"
        },
        "fetched_at": {
          "type": "string",
          "format": "date-time"
        },
        "variants": {
          "type": "array",
          "description": "Fetched variant allocations",
          "items": {
            "type": "object",
            "properties": {
              "variant_id": { "type": "string" },
              "name": { "type": "string" },
              "allocation": { "type": "number" }
            }
          }
        }
      }
    }
  }
}
```

---

## 5. Node Schema Updates

**File:** `/graph-editor/public/schemas/node-schema.json`

**Add field (optional, runtime-validated):**

```json
{
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "uuid": { "type": "string" },
    "label": { "type": "string" },
    "type": { "enum": ["chance", "decision", "utility"] },
    
    "event_id": {
      "type": "string",
      "description": "External system event identifier (e.g., Amplitude event_type, SQL table event name). Required when using external data connections. Runtime will fail gracefully if missing."
    }
  }
}
```

**IMPORTANT:** `event_id` is optional in schema, but runtime will fail with clear error if missing when needed:

```
Error: Cannot fetch data from Amplitude: node "Checkout Page" is missing event_id field.

To fix:
1. Open node properties for "Checkout Page"
2. Set event_id to the Amplitude event name (e.g., "checkout_page_viewed")
3. Try "Get from source" again
```

---

## 6. Field Semantics

### 6.1 connection (de facto foreign key)

**Type:** `string`  
**Purpose:** References a connection name in connections.yaml  
**Validation:** 
- Must match an enabled connection in connections.yaml
- If not found, show error listing available connections

**UI:**
- Dropdown populated from connections.yaml
- Filter by enabled: true
- Show provider type in parentheses: "amplitude-prod (amplitude)"

### 6.2 connection_string (JSON blob)

**Type:** `string` (JSON serialized)  
**Purpose:** Provider-specific param/case overrides  
**Validation:**
- Must be valid JSON
- Must conform to connection.connection_string_schema
- Validated when user edits in FormEditor

**UI:**
- FormEditor modal (dynamic form generated from connection_string_schema)
- "Edit Settings" button → opens modal → user edits → saves back as JSON string

### 6.3 query (node references)

**Type:** `object`  
**Purpose:** Define what data to fetch (which events, which paths)  
**Resolution:**
- Stores node IDs (human-readable, e.g., "node-checkout")
- Runtime resolves to node.event_id via buildDslFromEdge()

**UI:**
- Future: Visual query builder
- v1: Manual entry (or derived from graph topology)

### 6.4 evidence (read-only, system-generated)

**Type:** `object`  
**Purpose:** Track provenance of fetched data  
**Updates:** Only via UpdateManager after successful DAS execution

**UI:**
- Display in parameter panel (read-only)
- Show: n, k, window, source, fetched_at
- "Refresh" button → re-fetch from source

---

## 7. Schema Validation Levels

### 7.1 At Edit Time (FormEditor)

- JSON Schema validation
- Type checking
- Required fields
- Pattern matching

### 7.2 At Runtime (DAS Execution)

- Connection exists and enabled
- Credentials available for credsRef
- Node IDs resolve to valid nodes
- Nodes have event_id when required
- connection_string conforms to connection_string_schema

---

## 8. Backward Compatibility

### 8.1 Old Graphs Without New Fields

**Safe:** All new fields are optional  
**Behavior:** Parameters without connection won't have "Get from source" button

### 8.2 Migration Path

**Option A: Lazy migration**
- Old graphs continue to work
- New features available when user adds connection

**Option B: Explicit migration** (future)
- Tool to convert old `source` → new `connection` + `connection_string`

---

## 9. Examples

### 9.1 Edge with Amplitude Connection

```json
{
  "from": "node-1",
  "to": "node-2",
  "p": {
    "mean": 0.8,
    "stdev": 0.05,
    "distribution": "beta",
    "connection": "amplitude-prod",
    "connection_string": "{\"segment_filter\": \"mobile_users\"}",
    "query": {
      "from": "node-checkout",
      "to": "node-purchase",
      "visited": ["node-view-product"]
    },
    "evidence": {
      "n": 10000,
      "k": 8000,
      "window_from": "2025-01-01",
      "window_to": "2025-01-31",
      "source": "amplitude-prod",
      "fetched_at": "2025-02-01T10:30:00Z"
    }
  }
}
```

### 9.2 Case with Statsig Connection

```json
{
  "case_id": "checkout_flow_test",
  "variants": [
    {"variant_id": "control", "weight": 0.5},
    {"variant_id": "treatment", "weight": 0.5}
  ],
  "connection": "statsig-prod",
  "connection_string": "{\"gate_id\": \"checkout_flow_gate\"}",
  "evidence": {
    "source": "statsig-prod",
    "fetched_at": "2025-02-01T10:30:00Z",
    "variants": [
      {"variant_id": "control", "name": "Control", "allocation": 0.5},
      {"variant_id": "treatment", "name": "Treatment A", "allocation": 0.5}
    ]
  }
}
```

### 9.3 Node with event_id

```json
{
  "id": "node-checkout",
  "uuid": "abc-123-def-456",
  "label": "Checkout Page",
  "type": "chance",
  "event_id": "checkout_page_viewed",
  "metadata": {
    "amplitude_event": "checkout_page_viewed",
    "description": "User lands on checkout page"
  }
}
```

---

## 10. Implementation Checklist (Phase 0)

- [ ] Update graph-schema.json (add connection, connection_string, evidence)
- [ ] Update parameter-schema.json (add connection, connection_string, query, evidence)
- [ ] Update case-schema.json (add connection, connection_string, evidence)
- [ ] Update node-schema.json (document event_id field)
- [ ] Remove old enum constraints on connection fields
- [ ] Write validation tests for each schema
- [ ] Test with example graph files

---

**Reference:** See `../../ARCHIVE/EXTERNAL_DATA_SYSTEM_DESIGN.md` lines 708-995 for original schema design and migration discussion

