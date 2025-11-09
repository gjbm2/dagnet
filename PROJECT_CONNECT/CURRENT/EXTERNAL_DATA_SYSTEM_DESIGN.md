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
  - name: <private-repo>
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
    
    # Non-secret defaults
    defaults:
      base_url: https://api.amplitude.com
      project_id: "12345"
      timeout_ms: 30000
      rate_limit_rpm: 50
    
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
          # From parsed query DSL
          event_from: "{{ dsl.from }}"
          event_to: "{{ dsl.to }}"
          visited: "{{ json(dsl.visited) }}"
          excluded: "{{ json(dsl.excluded) }}"
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

## 3. Schema Design

### 3.1 connections-schema.json

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
      "required": ["name", "provider", "kind", "credsRef", "adapter"],
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
          "additionalProperties": true
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

### 4.1 Tab-Level State

Add window and context selectors to each graph tab:

```typescript
// In TabContext or GraphEditor
interface TabState {
  // Existing fields
  fileId: string;
  isDirty: boolean;
  // ... other state
  
  // NEW: Data fetch context
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
```

### 4.2 UI Component: DataFetchContextBar

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

### 4.3 Layout Position

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

### 4.4 Integration with "Get from file"

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
- ✅ Single file to manage (`connections.yaml`)
- ✅ Tab-level window/context selection
- ✅ No code required to add data sources
- ✅ Git-committable configurations

### For Developers
- ✅ Declarative data fetching
- ✅ Clear separation of concerns
- ✅ Testable and maintainable
- ✅ Extensible architecture

### For Teams
- ✅ Share connection configs via Git
- ✅ Consistent patterns across sources
- ✅ No accidental secret commits
- ✅ Easy onboarding

---

## Summary

This design provides:
1. **Single connections.yaml** - Configuration + adapters in one file
2. **Tab-level selectors** - Window and context set at tab level, not per-parameter
3. **Integrated adapters** - Part of connection, not scattered files
4. **Declarative** - No code needed to add data sources
5. **Secure** - Secrets separate, resolved at runtime

**Ready for implementation!** 🚀

