# Data Connections: Consolidated Implementation Plan

**Status:** Active Development  
**Last Updated:** 2025-11-04  
**Current Phase:** Phase 0 (in progress)

**Related Documents:**
- [DATA_CONNECTIONS.md](./DATA_CONNECTIONS.md) — Main specification
- [QUERY_EXPRESSION_SYSTEM.md](./QUERY_EXPRESSION_SYSTEM.md) — Query DSL & MSMDC algorithm
- [QUERY_SELECTOR_DESIGN.md](./QUERY_SELECTOR_DESIGN.md) — UI component design
- [DATA_CONNECTIONS_SCHEMA_VALIDATION.md](./DATA_CONNECTIONS_SCHEMA_VALIDATION.md) — Schema validation
- [DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md](./DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md) — Design decisions

---

## Executive Summary

This document provides a consolidated, actionable implementation plan for the Data Connections system. It tracks progress across all phases and provides clear next steps.

### **Implementation Strategy: Sync → Async → API**

1. **Phase 0:** Schemas & Foundation (2-3 days) — **IN PROGRESS**
2. **Phase 1:** Synchronous single-parameter operations (10-14 days)
3. **Phase 2:** Asynchronous batch operations (7-9 days)
4. **Phase 3:** API routes & automation (FUTURE — out of scope)

### **Total MVP Timeline:** ~20-26 days for Phases 0-2

**Breakdown:**
- **Phase 0:** 2-3 days (schemas, events registry, credentials)
- **Phase 1:** 10-14 days (core services, connectors, UI completion)
- **Phase 2:** 7-9 days (batch operations, optimization, progress UI)

---

## Current Status

### ✅ Completed

**Query Expression System:**
- [x] Query DSL syntax defined (`from().to().exclude().visited().case()`)
- [x] Query parser implemented (regex-based, basic)
- [x] MSMDC algorithm documented (Set Cover formulation)
- [x] Query factorization algorithm documented (batch optimization)
- [x] Monaco-based QueryExpressionEditor component **PROTOTYPED**
  - Dual-mode: Monaco (edit) ↔ Chips (view)
  - Context-aware autocomplete from graph + registries
  - Sans-serif font, theme colors
  - Hover delete affordances
  - Integrated into PropertiesPanel (edge probability section)
  - **Note:** Prototype only - needs validation, auto-population, polish

**Documentation:**
- [x] QUERY_EXPRESSION_SYSTEM.md (query DSL, algorithms)
- [x] QUERY_SELECTOR_DESIGN.md (UI component generalization)
- [x] DATA_CONNECTIONS_SCHEMA_VALIDATION.md (schema design, 20+ questions resolved)
- [x] DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md (design rationale)

### 🚧 In Progress (Phase 0)

**Schema Updates:**
- [ ] Update parameter-schema.yaml
  - Add `query` field (retrieval expression)
  - Add `n` and optionally `k` to values array
  - Add `window_to` alongside `window_from`
  - Add optional `condition` object (for conditional probabilities)
  - **Add `source` and `connection` fields (query machinery metadata)**
  - Add `query_auto_generated` flag (track if auto vs. manual)
- [ ] Update conversion-graph schema
  - Add `ParamValue` base type (shared by ProbabilityParam, MoneyParam, DurationParam)
  - Move `parameter_id` inside each param object (p, cost_gbp, cost_time)
  - Add `n` (sample size) to ParamValue
  - Add `event_id` to Node definition
  - Add `query_override` flag to edges (track manual query edits)
- [ ] Update node-schema.yaml
  - Add `event_id` field (reference to events registry)
- [ ] Update case-schema.yaml
  - **Add `source` and `connection` fields (for case-based data retrieval) to param and case **

**Events Registry:**
- [ ] Create event-schema.yaml (lightweight, like case-schema)
- [ ] Create events-index-schema.yaml
- [ ] Extend registryService to support 'event' type
- [ ] Add Events section to Navigator
- [ ] Add event type support to EnhancedSelector

**Credentials:**
- [ ] Update credentials-schema.json
  - Add `googleSheets` section (with base64 serviceAccount JSON)
  - Add `amplitude` section (with apiKey and secretKey)

### 📋 Next Up (Phase 1)

**Core Services:**
- [ ] Implement query parser service
- [ ] Implement MSMDC algorithm  
- [ ] Implement graph validation service
- [ ] **Complete QueryExpressionEditor (generalise as a class, validation, auto-generation, polish; use in conditional probs)**
- [ ] Create DataConnectionService (pull/push/retrieve)
- [ ] Create FieldMapper utility
- [ ] Build GoogleSheetsConnector
- [ ] Build AmplitudeConnector (basic)

---

## Phase 0: Schemas & Foundation (2-3 days)

**Goal:** Complete all schema updates, events registry, and credential infrastructure.

### Task Breakdown

#### 1. Parameter Schema Updates (0.5 days)

**File:** `graph-editor/public/param-schemas/parameter-schema.yaml`

**Changes:**

```yaml
# Add to properties:
query:
  type: string
  pattern: ^from\([a-z0-9-]+\)\.to\([a-z0-9-]+\).*
  description: "Query constraints for data retrieval: from(node).to(node)[.exclude(nodes)][.visited(nodes)][.case(id:variant)]"
  examples:
    - "from(node-a).to(node-b)"
    - "from(node-a).to(node-c).exclude(node-b)"
    - "from(node-a).to(node-c).visited(node-b)"
    - "from(node-a).to(node-b).case(test-1:treatment)"

# Update values array item:
values:
  type: array
  items:
    type: object
    properties:
      mean: { type: number }
      stdev: { type: number, minimum: 0 }
      n:  # NEW: Sample size
        type: integer
        minimum: 0
        description: "Sample size for statistical analysis"
      k:  # OPTIONAL: Successes (can be derived from p and n)
        type: integer
        minimum: 0
        description: "Number of successes (for Bayesian analysis)"
      distribution: { type: string }
      window_from: { type: string, format: date-time }
      window_to:  # NEW: Explicit end date
        type: string
        format: date-time
        description: "End date for this data window (explicit range)"
      context_id: { type: string }

# NEW: Query machinery metadata (details TBD)
source:
  type: object
  description: "Metadata about data source for this parameter"
  properties:
    type: { type: string, enum: [google_sheets, amplitude, manual, computed] }
    # Additional fields to be specified

connection:
  type: object  
  description: "Connection configuration for data retrieval"
  properties:
    # Fields to be specified (sheet ID, range, query, etc.)

query_auto_generated:
  type: boolean
  description: "Whether query field was auto-generated from MSMDC algorithm"
  default: false
```

**Note:** `source` and `connection` field structure to be fully specified once we understand Google Sheets and Amplitude connector requirements.

**Validation:** Run against existing parameter files, ensure backward compatibility.

---

#### 2. Graph Schema Updates (1 day)

**File:** `graph-editor/public/schemas/schema/conversion-graph-1.0.0.json`

**Changes:**

```json
{
  "$defs": {
    "ParamValue": {
      "type": "object",
      "description": "Base type for all parameter values (probabilities, costs, durations)",
      "properties": {
        "mean": { "type": "number" },
        "stdev": { "type": "number", "minimum": 0 },
        "n": { 
          "type": "integer", 
          "minimum": 0,
          "description": "Sample size (for parameters without param files)"
        },
        "distribution": { 
          "type": "string",
          "enum": ["normal", "beta", "gamma", "lognormal", "uniform"]
        },
        "parameter_id": { 
          "type": "string",
          "description": "Reference to parameter file"
        },
        "locked": { "type": "boolean" },
        "data_source": {
          "type": "object",
          "description": "Metadata about direct data retrieval (no param file)",
          "properties": {
            "type": { "type": "string" },
            "timestamp": { "type": "string" },
            "query": { "type": "string" }
          }
        }
      }
    },
    
    "ProbabilityParam": {
      "allOf": [
        { "$ref": "#/$defs/ParamValue" },
        {
          "properties": {
            "mean": { "type": "number", "minimum": 0, "maximum": 1 }
          }
        }
      ]
    },
    
    "MoneyParam": {
      "allOf": [
        { "$ref": "#/$defs/ParamValue" },
        {
          "properties": {
            "currency": { "type": "string", "default": "GBP" }
          }
        }
      ],
      "description": "Monetary cost (can be negative for revenue)"
    },
    
    "DurationParam": {
      "allOf": [
        { "$ref": "#/$defs/ParamValue" },
        {
          "properties": {
            "units": { "type": "string", "description": "Flexible units: d, h, 2.5d, etc." }
          }
        }
      ]
    }
  },
  
  "definitions": {
    "Node": {
      "properties": {
        "event_id": {
          "type": "string",
          "pattern": "^[a-z0-9-]+$",
          "description": "Reference to event in events registry (for analytics integration)"
        }
      }
    },
    
    "Edge": {
      "properties": {
        "p": { "$ref": "#/$defs/ProbabilityParam" },
        "cost_gbp": { "$ref": "#/$defs/MoneyParam" },
        "cost_time": { "$ref": "#/$defs/DurationParam" },
        "query": {
          "type": "string",
          "description": "Query expression for direct data retrieval (when no parameter_id)"
        }
      }
    }
  }
}
```

**Migration Script:** Write a script to migrate existing graphs from old schema to new schema.

---

#### 3. Events Registry (1 day)

**Create Files:**

**a) `graph-editor/public/param-schemas/event-schema.yaml`**

```yaml
$schema: http://json-schema.org/draft-07/schema#
title: Event Schema
description: Schema for individual event definitions (analytics events, user actions)
type: object

required:
  - id
  - name

properties:
  id:
    type: string
    pattern: ^[a-z0-9-]+$
    description: "Canonical event ID (used throughout app, likely matches production)"
  
  name:
    type: string
    description: "Human-readable event name"
  
  description:
    type: string
    description: "Detailed description of what this event represents"
  
  category:
    type: string
    enum: [user_action, system_event, milestone, conversion]
    description: "Event category for organization"
  
  tags:
    type: array
    items: { type: string }
    description: "Tags for filtering and search"
  
  connectors:
    type: object
    description: "Platform-specific mappings (only if names differ)"
    properties:
      amplitude:
        type: object
        properties:
          event_name:
            type: string
            description: "Override if Amplitude uses different name"
      
      # Future: Google Analytics, Mixpanel, etc.
  
  properties:
    type: object
    description: "Expected event properties (for documentation)"
    additionalProperties:
      type: object
      properties:
        type: { type: string }
        description: { type: string }
```

**b) `graph-editor/public/param-schemas/events-index-schema.yaml`**

```yaml
$schema: http://json-schema.org/draft-07/schema#
title: Events Index Schema
description: Index of all events in the registry
type: object

required:
  - events

properties:
  events:
    type: array
    items:
      type: object
      required: [id, name]
      properties:
        id: { type: string }
        name: { type: string }
        description: { type: string }
        category: { type: string }
        file_path: { type: string }
```

**c) Extend `graph-editor/src/services/registryService.ts`**

Add support for `event` type (just like `node`, `case`, `parameter`).

**d) Update Navigator**

Add "Events" section (collapsed by default) below Cases.

---

#### 4. Credentials Schema Updates (0.5 days)

**File:** `graph-editor/public/schemas/credentials-schema.json`

**Changes:**

```json
{
  "googleSheets": {
    "type": "object",
    "properties": {
      "serviceAccount": {
        "type": "string",
        "description": "Base64-encoded service account JSON key"
      },
      "token": {
        "type": "string",
        "description": "Optional OAuth token"
      }
    }
  },
  
  "amplitude": {
    "type": "object",
    "properties": {
      "apiKey": {
        "type": "string",
        "description": "Amplitude API key"
      },
      "secretKey": {
        "type": "string",
        "description": "Amplitude secret key"
      }
    }
  }
}
```

---

### Phase 0 Acceptance Criteria

- [ ] All schemas validate against existing data
- [ ] Events registry working (can create/edit/view events)
- [ ] QueryExpressionEditor showing in edge properties when parameter connected
- [ ] Credentials UI allows entering Google Sheets + Amplitude credentials
- [ ] No breaking changes to existing functionality
- [ ] All tests pass

---

## Phase 1: Synchronous Single-Parameter Operations (10-14 days)

**Goal:** User can manually trigger data sync for individual parameters with immediate feedback.

**Note:** Timeline extended from original 5-7 days estimate to account for:
- Completing QueryExpressionEditor (validation, auto-generation, polish)
- MSMDC algorithm implementation (not just documentation)
- Google Sheets API integration research & implementation
- Amplitude API integration research & implementation

### Task Breakdown

#### 1. Query Parser Service (1 day)

**File:** `graph-editor/src/services/queryParser.ts`

```typescript
export interface ParsedQuery {
  from: string;
  to: string;
  exclude: string[];
  visited: string[];
  cases: Array<{ caseId: string; variant: string }>;
}

export function parseQuery(query: string): ParsedQuery;
export function validateQuery(query: ParsedQuery, graph: Graph): ValidationResult;
export function buildAmplitudeQuery(query: ParsedQuery): AmplitudeQueryObject;
```

**Tests:**
- Parse valid queries
- Reject invalid syntax
- Handle edge cases (empty, malformed)

---

#### 2. MSMDC Algorithm (2 days)

**File:** `graph-editor/src/services/msmdc.ts`

```typescript
export class MSMDCAlgorithm {
  generateConstraints(edge: Edge, graph: Graph): Promise<{ exclude: string[], visited: string[] }>;
  findAllPaths(from: string, to: string, graph: Graph): Path[];
  greedySetCover(literals: Literal[], alternatePaths: Path[]): Literal[];
}
```

**Tests:**
- Diamond graph (A→B→D vs A→C→D)
- Multiple paths (3+ alternatives)
- No discrimination needed (single path)
- Complex conditional paths

---

#### 3. Graph Validation Service (1 day)

**File:** `graph-editor/src/services/graphValidation.ts`

```typescript
export class GraphValidationService {
  validateGraph(graph: Graph): Promise<ValidationReport>;
  checkDiscrimination(edge: Edge, query: ParsedQuery, graph: Graph): DiscriminationCheck;
  checkRedundancy(query: ParsedQuery, graph: Graph): RedundancyCheck;
  validateQuery(query: string, graph: Graph): ValidationResult;  // For real-time editor validation
}
```

**Integration:** Run on graph save, show warnings in UI. Also used by QueryExpressionEditor for real-time validation.

---

#### 4. Data Connection Service (2 days)

**File:** `graph-editor/src/services/dataConnectionService.ts`

```typescript
export class DataConnectionService {
  // Operation A: Pull from parameter file into graph
  async pullFromParamFile(paramId: string, graph: Graph): Promise<Graph>;
  
  // Operation B: Push from graph into parameter file
  async pushToParamFile(paramId: string, graph: Graph): Promise<void>;
  
  // Operation C: Retrieve from external source → param → graph
  async retrieveLatestData(paramId: string, graph: Graph): Promise<Graph>;
}
```

---

#### 5. Field Mapper Utility (1 day)

**File:** `graph-editor/src/services/fieldMapper.ts`

```typescript
export class FieldMapper {
  // Map parameter values to graph edge
  paramToGraph(param: Parameter, edge: Edge): Partial<Edge>;
  
  // Map graph edge to parameter values
  graphToParam(edge: Edge): Partial<Parameter>;
  
  // Select appropriate value from windowed/context data
  selectValue(param: Parameter, context?: SelectionContext): ParameterValue;
}
```

---

#### 6. Google Sheets Connector (1-2 days)

**File:** `graph-editor/src/services/connectors/googleSheetsConnector.ts`

```typescript
export class GoogleSheetsConnector implements DataSourceConnector {
  async authenticate(credentials: GoogleSheetsCredentials): Promise<void>;
  async retrieve(config: SheetsRetrievalConfig): Promise<ParameterValue[]>;
  async close(): Promise<void>;
}
```

**Research:**
- Google Sheets API authentication with service account
- Reading ranges
- Error handling

---

#### 7. Amplitude Connector (Basic) (1-2 days)

**File:** `graph-editor/src/services/connectors/amplitudeConnector.ts`

```typescript
export class AmplitudeConnector implements DataSourceConnector {
  async authenticate(credentials: AmplitudeCredentials): Promise<void>;
  async queryFunnel(from: string, to: string, constraints: QueryConstraints): Promise<FunnelResult>;
  async close(): Promise<void>;
}
```

**Scope (Phase 1):**
- Simple two-event funnels (from → to)
- Basic exclusions
- Return n, k, computed p and stdev

**Out of Scope:**
- Conditional probabilities (visited nodes)
- Case filtering
- Batching/optimization

---

#### 8. Complete QueryExpressionEditor (2 days)

**File:** `graph-editor/src/components/QueryExpressionEditor.tsx`

**Current Status:** Prototype working, needs completion

**Tasks:**

```typescript
// Add validation warnings
interface ValidationWarning {
  type: 'error' | 'warning' | 'info';
  message: string;
  suggestion?: string;
}

// Real-time validation
const [validationWarnings, setValidationWarnings] = useState<ValidationWarning[]>([]);

useEffect(() => {
  if (value && graph) {
    const result = graphValidationService.validateQuery(value, graph);
    setValidationWarnings(result.warnings);
  }
}, [value, graph]);

// Display warnings below editor
{validationWarnings.length > 0 && (
  <div className="query-validation-warnings">
    {validationWarnings.map(w => (
      <div className={`warning warning-${w.type}`}>
        {w.message}
        {w.suggestion && <button>Apply suggestion</button>}
      </div>
    ))}
  </div>
)}
```

**Auto-population machinery:**

```typescript
// Track whether query is auto-generated or manually overridden
interface QueryState {
  value: string;
  isAutoGenerated: boolean;
  lastAutoGenerated?: string;  // For comparison
  manuallyModified: boolean;
}

// Auto-generate on edge creation or graph structure change
useEffect(() => {
  const shouldAutoGenerate = 
    !localEdgeData.query_override &&  // Not manually overridden
    currentEdge &&
    (localEdgeData.parameter_id);  // Only if connected to parameter
  
  if (shouldAutoGenerate) {
    const generated = msmdc.generateConstraints(currentEdge, graph);
    const queryString = buildQueryString(generated);
    
    // Only update if different from current
    if (queryString !== localEdgeData.query) {
      onChange({
        ...localEdgeData,
        query: queryString,
        query_auto_generated: true
      });
    }
  }
}, [currentEdge, graph, localEdgeData.parameter_id, localEdgeData.query_override]);

// Mark as manual override when user edits
const handleUserEdit = (newValue: string) => {
  if (localEdgeData.query_auto_generated && newValue !== localEdgeData.query) {
    // User is overriding auto-generated query
    onChange({
      ...localEdgeData,
      query: newValue,
      query_override: true,
      query_auto_generated: false
    });
  } else {
    onChange({
      ...localEdgeData,
      query: newValue
    });
  }
};
```

**UI affordances:**

```typescript
// Show indicator if auto-generated with option to reset
{localEdgeData.query_override && (
  <div className="query-status">
    <span>⚠️ Manual override (auto-generation disabled)</span>
    <button onClick={handleResetToAuto}>
      Reset to auto-generated
    </button>
  </div>
)}

{localEdgeData.query_auto_generated && (
  <div className="query-status">
    <span>✓ Auto-generated from graph structure</span>
  </div>
)}
```

**Features to add:**
- [ ] Real-time validation with inline warnings
- [ ] Auto-generation from MSMDC on edge creation
- [ ] Auto-regeneration on graph structure changes (if not overridden)
- [ ] Track auto vs. manual state
- [ ] Reset to auto-generated button
- [ ] Visual indicator of query status
- [ ] Suggested fixes for validation warnings
- [ ] Better error messages (node not found, ambiguous path, etc.)

---

#### 9. UI Integration (1 day)

**Updates to EnhancedSelector:**

Add lightning menu actions:
- Pull from parameter file
- Push to parameter file  
- Retrieve latest data

**Updates to PropertiesPanel:**

Show data source metadata, last updated timestamp.

---

### Phase 1 Acceptance Criteria

- [ ] User can pull parameter value from file into graph
- [ ] User can push graph value into parameter file
- [ ] User can retrieve data from Google Sheets (with service account)
- [ ] User can retrieve data from Amplitude (basic funnel)
- [ ] Query expression auto-generates from MSMDC algorithm
- [ ] Graph validation warns about invalid/incomplete queries
- [ ] All operations show success/error feedback
- [ ] Unit tests cover all services (80%+ coverage)

---

## Phase 2: Asynchronous Batch Operations (7-9 days)

**Goal:** Background processing for multiple parameters with progress tracking and log output.

### Task Breakdown

#### 1. Batch Data Connection Service (2 days)

**File:** `graph-editor/src/services/batchDataConnectionService.ts`

```typescript
export class BatchDataConnectionService {
  async updateAllFromParams(graph: Graph, progressCallback?: ProgressCallback): Promise<BatchResult>;
  async updateAllParamsFromGraph(graph: Graph, progressCallback?: ProgressCallback): Promise<BatchResult>;
  async retrieveLatestForAll(graph: Graph, progressCallback?: ProgressCallback): Promise<BatchResult>;
}
```

**Features:**
- Group parameters by data source
- Parallel processing (where safe)
- Cancel support
- Detailed error handling per parameter

---

#### 2. Query Factorization Implementation (2 days)

**File:** `graph-editor/src/services/queryFactorization.ts`

```typescript
export class QueryFactorization {
  factorize(parameters: Parameter[]): QueryPlan[];
  optimizeAmplitudeQueries(requests: Request[]): OptimizedPlan;
}
```

**Goal:** Reduce N separate Amplitude queries to M queries where M ≪ N.

---

#### 3. Batch Progress UI (2 days)

**File:** `graph-editor/src/components/BatchProgressModal.tsx`

```typescript
<BatchProgressModal
  isOpen={isOpen}
  onClose={onClose}
  operation="retrieve-latest"
  progress={progress}
  onCancel={handleCancel}
/>
```

**Features:**
- Progress bar (15 / 47 parameters)
- Status per parameter (pending, success, error)
- Real-time updates
- Cancel button
- View log file button

---

#### 4. Top Menu Integration (1 day)

**File:** `graph-editor/src/components/MenuBar/DataMenu.tsx`

Add new top-level "Data" menu:
- Update All from Parameter Files
- Update All Parameter Files from Graph
- Get Latest Live Data for All Parameters

---

#### 5. Log File Generation (1 day)

**File:** `graph-editor/src/services/batchLogger.ts`

```typescript
export class BatchLogger {
  log(message: string, level: LogLevel): void;
  generateReport(): string;
  saveToFile(): Promise<string>;
}
```

**Output Format:**

```
Batch Operation: Retrieve Latest Data
Started: 2025-11-04 14:30:00
Total Parameters: 47

[14:30:01] ✓ checkout-to-purchase (n=1250, p=0.68)
[14:30:02] ✓ cart-to-checkout (n=890, p=0.45)
[14:30:03] ✗ signup-to-activation (Error: Rate limit exceeded)
...

Completed: 2025-11-04 14:35:22
Success: 44 / 47 parameters
Errors: 3 parameters
```

---

### Phase 2 Acceptance Criteria

- [ ] User can trigger batch operations from top menu
- [ ] Progress modal shows real-time updates
- [ ] Query factorization reduces Amplitude API calls by >50%
- [ ] Batch operations handle errors gracefully
- [ ] Log file generated with detailed results
- [ ] User can cancel long-running batch operations
- [ ] Performance tested with 100+ parameters

---

## Phase 3: API Routes & Automation (FUTURE)

**Status:** OUT OF SCOPE for MVP

**Why Deferred:**
- Need to validate schemas first (Phase 1)
- Need to validate batch processing first (Phase 2)
- Requires infrastructure setup (API server, auth, monitoring)
- Requires production-grade error handling and alerting

**Will revisit after Phases 1-2 are stable.**

---

## Testing Strategy

### Unit Tests

**Coverage Target:** 80%+

**Key Areas:**
- Query parser (all syntax variants)
- MSMDC algorithm (various graph topologies)
- Graph validation (edge cases)
- Field mapper (all parameter types)
- Connectors (mocked API responses)

### Integration Tests

**Scenarios:**
- Pull from parameter file → graph updated correctly
- Push to parameter file → file updated correctly
- Retrieve from Sheets → parameter file + graph updated
- Retrieve from Amplitude → parameter file + graph updated
- Batch operations → all parameters processed

### Manual Testing

**Test Cases:**
1. Connect parameter with query expression
2. Auto-generate query from MSMDC
3. Edit query manually
4. Trigger single parameter retrieval
5. Trigger batch retrieval
6. Cancel batch operation mid-flight
7. Review log file

---

## Risk Mitigation

### High-Risk Areas

1. **Amplitude API Rate Limits**
   - **Mitigation:** Query factorization, exponential backoff, rate limit headers
   
2. **Google Sheets Authentication**
   - **Mitigation:** Clear docs, test with multiple service accounts, error messages
   
3. **Schema Migration**
   - **Mitigation:** Write migration scripts, test with existing data, backward compatibility

4. **Query Ambiguity**
   - **Mitigation:** MSMDC algorithm, graph validation warnings, user override

### Medium-Risk Areas

1. **Performance (large graphs)**
   - **Mitigation:** Batch optimization, async processing, progress feedback
   
2. **Data consistency (concurrent edits)**
   - **Mitigation:** Optimistic locking, conflict detection, user review before save

3. **Error handling (network failures)**
   - **Mitigation:** Retry logic, graceful degradation, clear error messages

---

## Success Metrics

### Phase 0
- All schemas validated ✓
- Events registry functional ✓
- Zero breaking changes ✓

### Phase 1
- User can retrieve data from 2+ sources
- Query generation works for 90%+ of edges
- <5% user-reported issues

### Phase 2
- Batch operations 3x+ faster than individual
- Query factorization reduces API calls by 50%+
- User satisfaction >4/5 on usability

---

## Next Actions

### Immediate (This Week)

1. **Complete Phase 0 Schemas**
   - [ ] Update parameter-schema.yaml
   - [ ] Update conversion-graph schema  
   - [ ] Update node-schema.yaml
   - [ ] Write migration scripts

2. **Complete Events Registry**
   - [ ] Create event-schema.yaml
   - [ ] Create events-index-schema.yaml
   - [ ] Extend registryService
   - [ ] Add to Navigator

3. **Update Credentials UI**
   - [ ] Add Google Sheets fields
   - [ ] Add Amplitude fields
   - [ ] Test credential storage/retrieval

### Next Week

4. **Start Phase 1 Implementation**
   - [ ] Query parser service
   - [ ] MSMDC algorithm
   - [ ] Data connection service skeleton

---

## Document History

| Date | Version | Changes |
|------|---------|---------|
| 2025-11-04 | 1.0 | Initial consolidated plan |

---

**End of Document**

