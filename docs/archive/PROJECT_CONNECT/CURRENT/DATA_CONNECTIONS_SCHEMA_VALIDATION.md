# Data Connections Schema Validation

**Purpose:** Validate that schemas fit together before building implementation  
**Status:** Pre-Implementation Analysis  
**Date:** 2025-11-04 (Updated)

**Related Documents:**
- [DATA_CONNECTIONS.md](./DATA_CONNECTIONS.md) — Main data connections specification
- [QUERY_EXPRESSION_SYSTEM.md](./QUERY_EXPRESSION_SYSTEM.md) — Query DSL, MSMDC algorithm, batch optimization, and UI design
- [DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md](./DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md) — Design decisions

**Note:** For detailed information on query expression language, MSMDC algorithm, query factorization for batch optimization, and the Query Constructor UI component, see [QUERY_EXPRESSION_SYSTEM.md](./QUERY_EXPRESSION_SYSTEM.md).

---

## Core Design Decisions

### 1. Events Registry: Generic, Not Platform-Specific
- **Event IDs are canonical** (not Amplitude-specific)
- Likely mirrors production app event names (Amplitude echoes these)
- If platform uses different names, add connector-specific mapping in event file
- **Default:** Index-only entries (id + name), no files required
- **Optional:** Create file for rich metadata or platform-specific mappings
- **No aggressive file creation prompts** for events (index is sufficient)

### 2. Dual-Pathway Data Retrieval
- **Pathway A (Default):** External Source → Param File → Graph (versioned, history)
- **Pathway B (Override/Fallback):** External Source → Graph (direct, not versioned)
- **Decision logic:** If param exists → default to A, allow override to B; else only B
- **User oversight:** Always interactive, user reviews before committing
- **UI affordance:** Lightning menu shows both options, default highlighted

### 3. Unified Parameter Type System
- **Shared base:** `ParamValue` with mean, stdev, n, distribution, parameter_id, locked, data_source
- **Type-specific extensions:** ProbabilityParam, MoneyParam, DurationParam
- **parameter_id location:** INSIDE param objects (not at edge level) - cleaner, self-contained
- **n on graph, NOT k:** Sample size preserved, k derivable (k = p × n)
- **Money can be negative:** Revenue events supported
- **Duration units flexible:** Freeform strings ("d", "h", "2.5d") - human-readable

### 4. Icon/State System
- Consistent visual language for entities, states, actions, and pathways
- Key icons: `TrendingUpDown` (graphs), `Folders` (params), `DatabaseZap` (external), `Zap` (live data)
- **Full details:** See `DATA_CONNECTIONS.md` Section 2.4

---

## Design Principles

### 1. **Graph as View, Not Data Store**
- Graph displays current state but doesn't own historical data
- Param files are the canonical source of truth with history
- Graph needs only: current p, stdev, distribution for rendering/basic analysis
- n, k, time windows live in params; retrieved when needed for deep analysis

### 2. **Immutability & Versioning**
- Parameter updates append new time windows (non-destructive)
- All changes tracked in Git history
- Can always roll back to previous state
- No data is ever deleted, only deprecated/archived

### 3. **Unambiguous Referenceability**
- Every entity has unique ID
- References are validated (graph → param, node → event, etc.)
- Cascade resolution is deterministic (node.slug → node.event_id → event.amplitude.event_type)

### 4. **Fail Gracefully**
- Missing parameter → use graph default or warn, don't crash
- Missing event → log warning, continue without Amplitude integration
- API failure → use last known good value, mark as stale
- Partial data → accept what succeeded, report what failed

### 5. **Inclusive Not Exclusive Schemas**
- Schemas allow optional fields for extensibility
- New fields don't break old data
- Backward compatible by default

### 6. **Everything in Repo (Rollback Safe)**
- All param files, events, nodes, cases in Git
- Credentials never in repo (IndexedDB only)
- System can be reconstructed from repo at any commit

### 7. **Human Oversight by Design**
- Interactive operations show feedback immediately
- Batch operations produce review logs
- User decides when to commit changes to Git
- No automated commits without explicit user action

### 8. **Flexible Data Location (Graph ↔ Param Files)**
- Data can be managed in graph OR param files (user's choice)
- Both schemas support same fields (symmetry principle)
- Frontend gently manages synchronization during CRUD operations
- No forced location - system adapts to where user works
- Query expressions, overrides, and metadata maintained in both locations
- Pull/push operations keep them in sync when needed

---

## Use Case 1: Analyst Maintains Values in Google Sheets

### Data Flow

```
Google Sheets (Analyst) → Parameter File → Graph Edge
     ↓ (manual update)         ↓ (time window)    ↓ (display)
   mean: 0.25              values[0].mean: 0.25   edge.p.mean: 0.25
   stdev: 0.05            values[0].stdev: 0.05  edge.p.stdev: 0.05
```

### Concrete Example

**Google Sheet:** `Marketing Parameters Dashboard`
Range `B2:D2` contains: `[0.25, 0.05, "beta"]`

**Parameter File:** `parameters/probability/email-open-rate.yaml`
```yaml
id: email-open-rate
name: "Email Open Rate"
type: probability
values:
  # Manually updated by analyst 2025-01-15
  - mean: 0.22
    stdev: 0.04
    distribution: beta
    window_from: "2025-01-01T00:00:00Z"
    window_to: "2025-01-31T23:59:59Z"
    data_source:
      type: manual
      notes: "Q1 2025 baseline"
  
  # Retrieved from Sheets 2025-02-01
  - mean: 0.25
    stdev: 0.05
    distribution: beta
    window_from: "2025-02-01T00:00:00Z"
    # No window_to = current value
    data_source:
      type: sheets
      url: "https://docs.google.com/spreadsheets/d/ABC123"
      range: "Parameters!B2:D2"
      retrieved_at: "2025-02-01T10:30:00Z"

metadata:
  description: "Email marketing campaign open rates"
  data_source:
    type: sheets
    url: "https://docs.google.com/spreadsheets/d/ABC123"
    refresh_frequency: "1d"
  # ... standard metadata
```

**Graph Edge:**
```json
{
  "id": "edge-email-to-click",
  "from": "email-sent",
  "to": "email-clicked",
  "p": {
    "mean": 0.25,           // ← Latest value from param
    "stdev": 0.05,          // ← Latest value from param
    "distribution": "beta", // ← Latest value from param
    "parameter_id": "email-open-rate",  // ← Reference
    "locked": false
  }
}
```

### Mapping Logic

```typescript
// Param → Graph
function mapParamToGraph(param: Parameter, edge: Edge): void {
  // 1. Find latest applicable value
  const latestValue = param.values
    .filter(v => !v.window_to || new Date(v.window_to) > new Date())
    .sort((a, b) => new Date(b.window_from) - new Date(a.window_from))[0];
  
  // 2. Map to graph
  edge.p.mean = latestValue.mean;
  edge.p.stdev = latestValue.stdev;
  edge.p.distribution = latestValue.distribution;
  
  // Note: n, k stay in param file, not copied to graph
}

// Sheets → Param
async function retrieveFromSheets(param: Parameter): Promise<ParameterValue> {
  const creds = await getCredentials();
  const sheets = new GoogleSheetsConnector(creds.googleSheets);
  
  const data = await sheets.retrieve({
    url: param.metadata.data_source.url,
    range: "Parameters!B2:D2"
  });
  
  // data = [[0.25, 0.05, "beta"]]
  return {
    mean: data[0][0],
    stdev: data[0][1],
    distribution: data[0][2],
    window_from: new Date().toISOString(),
    data_source: {
      type: "sheets",
      url: param.metadata.data_source.url,
      retrieved_at: new Date().toISOString()
    }
  };
}
```

### Schema Requirements

**✅ WORKS:**
- Graph edge has p.mean, p.stdev, p.distribution
- Param has values[] with mean, stdev, distribution
- Reference via parameter_id

**✅ DECISIONS:**

**1. Naming Convention for Param Packs (from Sheets)**

Use canonical parameter IDs with optional qualifiers:

**Format:** `PARAM_ID.WINDOW(DATE).CONTEXT(CONTEXT_ID).FIELD`

**Examples:**
- `checkout-conversion.mean` → base value
- `checkout-conversion.n` → sample size (optional)
- `checkout-conversion.window(2025-11-03).mean` → windowed value
- `checkout-conversion.context(device-mobile).mean` → context-specific
- `checkout-conversion.window(2025-11-03).context(device-mobile).n` → fully qualified

**Parsing:** Order-agnostic (both `.window().context()` and `.context().window()` are valid)

**Sheet Layout (Recommended):**
```
| checkout-conversion.mean | checkout-conversion.stdev | checkout-conversion.n |
|--------------------------|---------------------------|------------------------|
| 0.27                     | 0.0044                    | 10000                  |
```

**Alternative Layouts:**
- Vertical: Element/Value pairs (good for small datasets)
- Alternating columns: Element | Value | Element | Value

**Implementation:** Parser handles various layouts; transformation can happen client-side (in Sheet)

**Note:** n and k are optional (analyst may not have sample size for manual data)

**See:** `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #8 for full details

---

**2. Stale Data Detection**

Add `status` object to param metadata (Phase 2):
- Track `last_successful_retrieve` timestamp
- UI shows amber lightning if elapsed time > `refresh_frequency`
- Implement in Phase 2 (batch operations)

**3. n/k for Sheet-sourced params**

Optional - analyst's choice. If present, include; if absent, leave null.

---

## Use Case 2: External Data Retrieval (Dual Pathways)

### Pathway A: Via Parameter File (Default, Versioned)

```
External Source → Parameter File → Graph Edge
     ↓                ↓ (append)         ↓ (display)
  n: 10000        values[].n: 10000   edge.p.mean: 0.27
  k: 2700         values[].k: 2700    edge.p.stdev: 0.0044
                  values[].mean: 0.27
  (Amplitude,     (History preserved)  (Current value)
   Sheets, etc.)
```

### Pathway B: Direct to Graph (Override/Fallback, Not Versioned)

```
External Source → Graph Edge
     ↓                ↓ (overwrite)
  n: 10000        edge.p.mean: 0.27
  k: 2700         edge.p.stdev: 0.0044
                  edge.p.data_source: { type: "amplitude", direct: true }
  (Amplitude,     (No history, not versioned)
   Sheets, etc.)
```

### Concrete Example

**Graph Nodes:**
```json
{
  "nodes": [
    {
      "id": "node-uuid-1",
      "slug": "checkout-started",
      "label": "Checkout Started",
      "event_id": "checkout_started"  // ✅ ALLOWED on graph (nodes ≠ events always)
      // Decision: event_id optional on graph nodes
      // Rationale: Nodes are graph-contextual, events are canonical
      // Often brought through from node registry when created, but not required

    },
    {
      "id": "node-uuid-2",
      "slug": "purchase-completed",
      "label": "Purchase Completed"
    }
  ]
}
```

**Node Registry Entry:** `nodes/checkout-started.yaml`
```yaml
id: checkout-started
name: "Checkout Started"
description: "User begins checkout process"
event_id: checkout_started  # ← Reference to events registry (canonical event ID)

metadata:
  created_at: "2025-01-01T00:00:00Z"
  version: "1.0.0"
```

**Event Registry Entry:** `events-index.yaml` (inline, no file needed)
```yaml
events:
  - id: checkout_started        # ← Canonical event ID (likely matches production app)
    name: "Checkout Started"
    description: "User begins checkout process"
    status: active
  
  - id: purchase_completed
    name: "Purchase Completed"
    status: active
```

**Notes:**
- Event ID is **generic** (not Amplitude-specific)
- Likely matches production app event instrumentation
- Amplitude (probably) uses same event names → no mapping needed
- If Amplitude differs, create file: `events/checkout_started.yaml` with connector overrides

**Graph Edge (New Unified Schema):**
```json
{
  "id": "edge-checkout-to-purchase",
  "from": "node-uuid-1",  // checkout-started
  "to": "node-uuid-2",    // purchase-completed
  "p": {
    "mean": 0.27,
    "stdev": 0.0044,
    "n": 10000,  // ✅ Sample size for provenance (k derivable as k = p × n = 2700)
    "distribution": "beta",
    "parameter_id": "checkout-conversion-rate"  // ✅ Inside p object now!
    // NOT on graph: k (derivable from p.mean × p.n)
  }
}
```

**Parameter File:** `parameters/probability/checkout-conversion-rate.yaml`
```yaml
id: checkout-conversion-rate
name: "Checkout to Purchase Conversion"
type: probability
values:
  # Historical baseline (manual)
  - mean: 0.25
    stdev: 0.045
    n: 8000
    k: 2000
    distribution: beta
    window_from: "2025-01-01T00:00:00Z"
    window_to: "2025-02-28T23:59:59Z"
    data_source:
      type: manual
  
  # Latest from Amplitude (retrieved today)
  - mean: 0.27
    stdev: 0.0044   # Calculated from binomial: sqrt(p*(1-p)/n) = sqrt(0.27*0.73/10000)
    n: 10000        # ← Full fidelity in param file
    k: 2700         # ← Full fidelity in param file
    distribution: beta
    window_from: "2025-11-03T14:30:00Z"
    data_source:
      type: amplitude
      query:
        from_event: "checkout_started"
        to_event: "purchase_completed"
        time_range: "30d"
      retrieved_at: "2025-11-03T14:30:00Z"

metadata:
  description: "Conversion rate from checkout to purchase completion"
  data_source:
    type: amplitude
    refresh_frequency: "1d"
  # ...
```

### Cascade Resolution for Data Connector Query

```typescript
async function getEventsForEdge(edge: Edge, graph: Graph): Promise<{from: string, to: string}> {
  // 1. Find nodes
  const fromNode = graph.nodes.find(n => n.id === edge.from);
  const toNode = graph.nodes.find(n => n.id === edge.to);
  
  // 2. Load node details from registry (cascade #1)
  const fromNodeDetail = await loadNodeDetail(fromNode.slug);
  const toNodeDetail = await loadNodeDetail(toNode.slug);
  
  // 3. Get event IDs (cascade #2)
  const fromEventId = fromNodeDetail.event_id;  // "checkout_started"
  const toEventId = toNodeDetail.event_id;      // "purchase_completed"
  
  // 4. Return event IDs (connector will handle mapping if needed)
  return {
    from: fromEventId,
    to: toEventId
  };
}

async function retrieveFromDataSource(edge: Edge, param: Parameter): Promise<ParameterValue> {
  const creds = await getCredentials();
  const connector = new AmplitudeConnector(creds.amplitude);  // Or SheetsConnector, etc.
  
  // Get events via cascade
  const events = await getEventsForEdge(edge, currentGraph);
  
  // Connector uses event IDs (applies mapping if needed)
  const funnelData = await connector.queryFunnel({
    steps: [
      { event_type: events.from },   // Uses event_id directly (or maps if needed)
      { event_type: events.to }
    ],
    start_date: "2025-10-04",
    end_date: "2025-11-03"
  });
  
  // Transform response
  const n = funnelData.data.series[0].events;  // 10000
  const k = funnelData.data.series[1].events;  // 2700
  const mean = k / n;                          // 0.27
  const stdev = Math.sqrt(mean * (1 - mean) / n);  // 0.0044
  
  return {
    mean,
    stdev,
    n,        // ← Stored in param, not graph
    k,        // ← Stored in param, not graph
    distribution: "beta",
    window_from: new Date().toISOString(),
    data_source: {
      type: "amplitude",  // Or "sheets", "snowflake", etc.
      query: {
        from_event: events.from,
        to_event: events.to,
        time_range: "30d"
      },
      retrieved_at: new Date().toISOString()
    }
  };
}
```

### Schema Requirements

**✅ WORKS:**
- Graph edge has p.mean, p.stdev (sufficient for display)
- Param has n, k (for Bayesian analysis later)
- Node → Event cascade works (two-step lookup)

**✅ RESOLVED:**

1. **Cascade Performance:** ✅ **NOT AN ISSUE**
   - All registry files cloned via Git on init (local, in-memory)
   - Back-of-packet calculation for year 1:
     - 100 nodes × ~500 bytes = 50 KB
     - 200 params × ~1 KB = 200 KB
     - 200 params × 365 days × 200 bytes/value = 14.6 MB (windowed data)
     - Events index: ~10 KB
     - **Total: ~15 MB uncompressed YAML** (trivial for modern systems)
   - Lookups are fast (already in memory, indexed by ID)
   - Git compression reduces storage significantly
   - Conclusion: Cascade lookups are non-issue

2. **Event ID Location:** ✅ **DECISION: event_id ALLOWED on graph nodes**
   - Pro: Faster lookup, nodes are contextual to graphs
   - Pro: Nodes ≠ Events (not 1:1 relationship)
   - Pro: Events can be graph-specific (not always canonical)
   - Implementation: Optional field, often populated from node registry but not required
   - Note: node_id primarily for visited() conditions; most data lives on edges 

3. **Parameter States:** ✅ **DECISION: All states are valid, no auto-creation**
   
   **Valid Parameter States:**
   
   | State | Edge Config | Param File | Data Retrieval | UI Indicator |
   |-------|-------------|------------|----------------|--------------|
   | **A** | `parameter_id` + values | ✅ Exists | ✅ Possible | 🟢 Green (connected) |
   | **B** | `parameter_id` + values | ❌ Missing | ❌ Not possible | 🔴 Red (broken reference) |
   | **C** | No `parameter_id`, values only | N/A | ⚠️ Direct only* | ⭕ Grey (manual/direct) |
   
   *Direct retrieval possible if nodes have `event_id` (Pathway B)
   
   **No Auto-Creation:** Graph editor handles parameter creation (user-initiated only)
   
   **State B Handling:**
   - UI warning: "Parameter 'foo' not found - create to enable data retrieval"
   - Values still work (graph displays them)
   - Can't retrieve latest data (no file with data_source config)
   - User can create param file when ready
   
   **Precedence (when multiple sources):**
   1. Graph values (if direct retrieval or manual edit)
   2. Param file (if exists and referenced)
   3. Index (for listing/autocomplete)
   
   **See:** `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #13 for full details 

---

## Use Case 3: Experiment with Cases (Variant Weights Over Time)

### Data Flow

```
Statsig API → Case File → Graph Case Node
     ↓           ↓ (window)      ↓ (display)
  weights    schedules[]      case.variants[]
```

### Concrete Example

**Graph Case Node:**
```json
{
  "id": "node-checkout-case",
  "slug": "checkout-redesign-test",
  "type": "case",  // ← Special node type
  "case": {
    "id": "case-checkout-redesign",  // ← References case registry
    "variants": [
      {
        "name": "control",
        "edges": ["edge-control-1", "edge-control-2"]
      },
      {
        "name": "treatment",
        "edges": ["edge-treatment-1", "edge-treatment-2"]
      }
    ]
  }
}
```

**Case File:** `cases/checkout-redesign.yaml`
```yaml
parameter_id: case-checkout-redesign
parameter_type: case
name: "Checkout Redesign Experiment"

case:
  id: case-checkout-redesign
  status: active
  
  platform:
    type: statsig
    experiment_id: "exp_checkout_redesign_2025"
    project_id: "dagnet-prod"
  
  variants:
    - name: control
      weight: 0.5
      description: "Current checkout flow"
    - name: treatment
      weight: 0.5
      description: "New streamlined checkout"
  
  # ⚠️ CRITICAL: Windowed variant weights over time
  schedules:
    - start_date: "2025-01-01T00:00:00Z"
      end_date: "2025-01-31T23:59:59Z"
      variants:
        control: 0.8    # Start conservative
        treatment: 0.2
      note: "Initial rollout"
    
    - start_date: "2025-02-01T00:00:00Z"
      end_date: "2025-02-28T23:59:59Z"
      variants:
        control: 0.5    # Increase treatment
        treatment: 0.5
      note: "Full 50/50 test"
    
    - start_date: "2025-03-01T00:00:00Z"
      # No end_date = current
      variants:
        control: 0.1    # Treatment winning, ramp up
        treatment: 0.9
      note: "Treatment rollout"

metadata:
  created_at: "2025-01-01T00:00:00Z"
  version: "1.2.0"
```

### Mapping Logic for Time-Based Weights

```typescript
function getCaseWeightsAtTime(caseData: CaseData, timestamp: Date): Record<string, number> {
  // Find schedule that applies at given timestamp
  const applicableSchedule = caseData.case.schedules
    .filter(s => {
      const start = new Date(s.start_date);
      const end = s.end_date ? new Date(s.end_date) : new Date('2099-12-31');
      return timestamp >= start && timestamp <= end;
    })
    .sort((a, b) => new Date(b.start_date) - new Date(a.start_date))[0];
  
  if (applicableSchedule) {
    return applicableSchedule.variants;
  }
  
  // Fallback to base variants
  return caseData.case.variants.reduce((acc, v) => {
    acc[v.name] = v.weight;
    return acc;
  }, {});
}

// For "snapshot" feature
interface Snapshot {
  timestamp: Date;
  parameters: Record<string, ParameterValue>;  // edge_id → param value at that time
  caseWeights: Record<string, Record<string, number>>;  // case_id → variant weights
}

async function createSnapshot(graph: Graph): Promise<Snapshot> {
  const timestamp = new Date();
  const snapshot: Snapshot = {
    timestamp,
    parameters: {},
    caseWeights: {}
  };
  
  // Snapshot all edge parameters
  for (const edge of graph.edges) {
    if (edge.p?.parameter_id) {
      const param = await loadParameter(edge.p.parameter_id);
      const valueAtTime = getParameterValueAtTime(param, timestamp);
      snapshot.parameters[edge.id] = valueAtTime;
    }
  }
  
  // Snapshot all case weights
  for (const node of graph.nodes.filter(n => n.type === 'case')) {
    const caseData = await loadCase(node.case.id);
    snapshot.caseWeights[node.case.id] = getCaseWeightsAtTime(caseData, timestamp);
  }
  
  return snapshot;
}
```

### Visualization: Before/After Comparison

```typescript
interface EdgeVisualization {
  edgeId: string;
  snapshotValue: number;   // p.mean from snapshot
  currentValue: number;    // p.mean from current
  delta: number;           // currentValue - snapshotValue
  visualStyle: {
    width: number;         // Based on current value
    colour: string;         // Blended colour showing delta
    blur: number;          // Based on stdev (optional)
  };
}

function visualizeEdgeDelta(snapshot: ParameterValue, current: ParameterValue): EdgeVisualization {
  const delta = current.mean - snapshot.mean;
  
  return {
    snapshotValue: snapshot.mean,
    currentValue: current.mean,
    delta,
    visualStyle: {
      width: current.mean * 10,  // Edge thickness
      colour: delta > 0 
        ? `rgba(0, 100, 255, ${Math.abs(delta) * 10})`  // Blue fringe = increased
        : `rgba(255, 0, 100, ${Math.abs(delta) * 10})`, // Pink fringe = decreased
      blur: current.stdev * 20  // Optional: uncertainty visualization
    }
  };
}
```

### Schema Requirements

**✅ WORKS:**
- Case schedules support time-windowed variant weights
- Snapshot can capture point-in-time state
- Visualization doesn't need n/k on graph

**✅ DECISIONS:**

**4. Snapshots: Ephemeral (Phase 1), Optional Persistence (Later)**

**Phase 1 Implementation:**
- In-memory only (not saved to files)
- User creates snapshot to capture current state
- Compare snapshot vs. current for visual diff
- Snapshots discarded when graph closes

**Snapshot Format:** Parameter packs (JSON)
```json
{
  "timestamp": "2025-11-03T14:30:00Z",
  "parameters": {
    "edge-uuid-1": { "mean": 0.27, "stdev": 0.0044, "n": 10000 },
    "edge-uuid-2": { "mean": 0.31, "stdev": 0.008, "n": 3000 }
  },
  "caseWeights": {
    "case-uuid-1": { "control": 0.5, "treatment": 0.5 }
  }
}
```

**Future Enhancement:**
- User can manually save snapshot to file (e.g., `.snapshot.json`)
- Not committed to Git by default (too much churn)
- Use for historical comparisons or audit trail

**See:** `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #15 for full details 

**5. Statsig Integration: Same Pattern as Amplitude (Phase 2+)**

**Decision:** YES - Same connector pattern as Amplitude

**Data Flow:**
1. Statsig API → Case File (updates `schedules[]` with time-windowed weights)
2. Case File → Graph Case Node (displays variant weights)
3. User can what-if from there

**Implementation:**
- `StatsigConnector` class (similar to `AmplitudeConnector`)
- Authenticate with Statsig API
- Retrieve experiment configurations and variant weights
- Support time-windowed weight schedules
- Update case files with latest distributions

**Timeline:** Phase 2+ (after Amplitude pattern proven and stable)

**See:** `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #23 for full details

**6. Case Weights Storage: Lives on Graph (What-If Friendly)**

**Decision:** Case weights stored on graph nodes (same pattern as parameters)

**Rationale:**
- **Graph as Working Space:** User needs to manipulate and what-if with variant weights
- **Case File as History:** Stores time-windowed schedules and configuration
- **Data Flow:** Statsig/API → Case File → Graph → User experiments

**Pattern Consistency:**
```
Parameters:  External → Param File → Graph Edge   → User what-ifs with p values
Case Weights: Statsig → Case File   → Graph Node  → User what-ifs with weights
```

**Implementation:**
```json
{
  "id": "node-checkout-case",
  "type": "case",
  "case": {
    "id": "case-checkout-redesign",
    "variants": [
      { "name": "control", "weight": 0.5 },     // ← Lives on graph
      { "name": "treatment", "weight": 0.5 }    // ← User can edit
    ]
  }
}
```

**Workflow:**
1. User clicks "Retrieve Latest" on case node
2. System queries Statsig API
3. Updates case file with time-windowed schedule
4. Pulls current weights into graph node
5. User can now adjust weights for what-if scenarios

**See:** `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #23 for full details


**7. Latency Analysis & Windowed Params (Future Use Case)**

**Requirement:** Support latency/maturity analysis for long-running graphs (e.g., 45-day completion times)

**Questions to Answer:**
- "How nearly mature is this cohort?"
- "What will it look like when it matures?"
- "If we had X of these today, was that what we expected?"

**Data Architecture Requirements:**
- **Windowed params with explicit ranges** (`window_from` + `window_to`)
- **Historical param values** preserved in param files
- **Time-based convolution** of `cost_time` distributions

**Example Scenario:**
```
User journey started: 2025-01-15
Graph completion time: 45 days (distributed)
Analysis date: 2025-02-01 (16 days in)

Question: "How mature is this cohort?"
Process:
1. For each edge, retrieve param values as they were on days 1-16
2. Convolve time_cost distributions across those params
3. Calculate probability mass function (PMF) for completion
4. Compare expected vs. actual progress
```

**Schema Support:** ✅ Current design supports this:
- `window_from` + `window_to` define explicit date ranges
- Parameter files preserve historical values
- Python runner can retrieve time-series data and convolve

**Implementation:** Phase 3+ (after basic data connections working)

**See:** `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #11 and #16 for details on windowing and time resolution

---

## Use Case 4: Context/Segment Filtering (Future)

### Data Flow

```
Amplitude (Segmented) → Parameter File (per context) → Graph Edge (context-aware)
     ↓                        ↓                              ↓
  mobile: n=5000         context_id: device-mobile    Displayed based on
  desktop: n=3000        mean: 0.23                   active context
```

### Concrete Example

**Parameter File with Contexts:**
```yaml
id: checkout-conversion-by-device
name: "Checkout Conversion by Device"
type: probability
values:
  # Mobile segment
  - mean: 0.23
    stdev: 0.006
    n: 5000
    k: 1150
    context_id: "device-mobile"  # ← References context registry
    window_from: "2025-11-01T00:00:00Z"
    data_source:
      type: amplitude
      query:
        from_event: "checkout_started"
        to_event: "purchase_completed"
        segment:
          property: "device_type"
          value: "mobile"
  
  # Desktop segment
  - mean: 0.31
    stdev: 0.008
    n: 3000
    k: 930
    context_id: "device-desktop"
    window_from: "2025-11-01T00:00:00Z"
    data_source:
      type: amplitude
      query:
        from_event: "checkout_started"
        to_event: "purchase_completed"
        segment:
          property: "device_type"
          value: "desktop"
```

**Context Registry Entry:** `contexts.yaml`
```yaml
contexts:
  - id: device-mobile
    name: "Mobile Device"
    type: categorical
    category: device
    
  - id: device-desktop
    name: "Desktop Device"
    type: categorical
    category: device
```

### Mapping Logic with Context Selection

```typescript
function getParameterValueForContext(
  param: Parameter, 
  activeContexts: Record<string, string>  // { device: "mobile" }
): ParameterValue {
  // Find values matching active contexts
  const matchingValues = param.values.filter(v => {
    if (!v.context_id) return false;
    
    // Load context to get category
    const context = loadContext(v.context_id);
    return activeContexts[context.category] === context.id;
  });
  
  if (matchingValues.length > 0) {
    // Return latest matching value
    return matchingValues.sort((a, b) => 
      new Date(b.window_from) - new Date(a.window_from)
    )[0];
  }
  
  // Fallback to base value (no context_id)
  return param.values.find(v => !v.context_id);
}
```

### Schema Requirements

**✅ WORKS:**
- Parameter values have optional context_id
- Graph doesn't need context awareness (pulled dynamically)
- Context registry provides validation

**✅ DECISIONS:**

**7. Context Selection in UI (Future)**

**Current State:** Contexts schema exists, but not yet integrated into graph editor

**Future Implementation:**
- Use `contexts.yaml` registry (existing schema)
- Add `SET_CONTEXT` action on nodes
- Support edge-level context overrides: `edge.context(context_id).p.mean`
- Context selection panel in graph editor
- Active contexts apply to param value selection

**Timeline:** Phase 2+ (after basic data connections working)

**See:** `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #21 for details

---

**8. Multiple Context Dimensions: YES (Optional)**

**Decision:** Support multi-dimensional contexts (Cartesian product)

**Examples:**
```yaml
# Single dimension
context_id: "device-mobile"

# Multi-dimensional (future)
context_filters:
  device: mobile
  utm_source: google
  user_segment: premium
```

**Matching:** All specified dimensions must match active contexts

**Priority:** More specific (more dimensions) wins over less specific

**See:** `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #12 for details

---

**9. Last Used Context Storage**

**Clarification:** Misunderstood question. Contexts are defined in `contexts.yaml` registry (canonical definitions).

**No need to store "last used"** - Active contexts are part of analysis session state (ephemeral or part of scenario definition).

---

## Critical Schema Questions & Ambiguities

### Q1: **Event ID Duplication (Graph vs Registry)**

**Current State:**
- Node registry has `event_id`
- Graph node schema does NOT have `event_id`

**Issue:**
- Amplitude connector needs event IDs for all edges in batch operation
- Cascade requires: edge → node → node_detail → event → amplitude.event_type
- For 50 edges, that's 50 node lookups + 50 event lookups = 100 registry operations

**Options:**
- **A) Keep event_id only in registry** (DRY, but slow for batch operations)
- **B) Add event_id to graph node schema** (duplicate, but fast)
- **C) Cache node→event mapping in memory** (hybrid)

**✅ DECISION: Option B - Add event_id to graph node schema**

**Rationale:**
- **Performance:** Faster for batch operations (no cascade lookups needed)
- **Convenience:** Direct access to event ID when needed
- **Not true duplication:** Nodes ≠ Events (relationship is contextual)
- **Optional field:** Can cascade through registry when not present
- **Graph-specific events:** Some events are graph-context specific

**Implementation:**
- Add optional `event_id` field to Node schema
- Often populated from node registry when node created
- Not mandatory (can still cascade through node registry)
- UI can offer to populate from registry

**See:** `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #4 for full discussion

### Q2: **n and k on Graph Edges**

**Current State:**
- Graph edge has: p.mean, p.stdev, p.distribution
- Param values have: mean, stdev, distribution, n, k

**User's position:** "I don't think graphs need n & k... p & stdev suffice"

**Use cases that might need n/k on graph:**
- ❌ Snapshot visualization (NO - just need mean for fringe colours)
- ❌ Stdev visualization (NO - already have stdev)
- ❌ Revenue/day calculations (NO - do in dagCalc or separate tool)
- ❌ MCMC analysis (NO - pull from params before sending to Py runner)
- ❓ Anything else?

**✅ DECISION: n on graph (NOT k), k derivable**

**Updated Decision (from Core Design #3):**
- **n (sample size)** → Include on graph (provenance/confidence metadata)
- **k (successes)** → NOT on graph (derivable: k = p.mean × n)
- Avoid redundancy while preserving sample size information

**Rationale:**
- n provides useful provenance (how much data behind this estimate?)
- k is redundant given p and n
- Keeps graph schema lighter
- Full n/k fidelity preserved in param files for rigorous Bayesian analysis

**Future Enhancement: "Inspect" Feature**
- Click on parameter → view full param file details
- See complete n/k history, all windows, all contexts
- Deep-link from graph to param file
- No need to clutter graph with all historical data

**See:** Core Design Decision #3 for unified ParamValue schema

### Q3: **Parameter Auto-Creation**

**Scenario:** Edge references `parameter_id: "foo"` but parameter file doesn't exist.

**Options:**
- **A) Error:** "Parameter 'foo' not found"
- **B) Auto-create:** Create stub param file with default values
- **C) Soft warning:** Allow graph to work, show warning indicator

**✅ DECISION: Option C - Graph editor responsibility, no auto-creation in data layer**

**Rationale:**
- **User control:** User explicitly decides when to create parameter files
- **No magic:** Data layer doesn't create files automatically
- **Valid states:** Edge can reference non-existent param (see Use Case 2, Parameter States)
- **Clear feedback:** UI shows warning, offers to create file

**Implementation:**
- Data layer accepts any parameter_id (no validation)
- Graph editor shows indicator for broken references
- User can create param file when ready (via UI action)
- User commits file to Git (explicit, reviewed)

**See:** Use Case 2, comment #3 for parameter states matrix 

### Q4: **Time Window Semantics (window_to)**

**Current State:** Parameter schema has `window_from`, we're adding `window_to`

**Semantics:**
- If only `window_from`: Applies forward (until next window or present)
- If both `window_from` and `window_to`: Applies only within range
- Convention: Use latest value when multiple windows match

**Issue:** What if time windows overlap?

**Example:**
```yaml
values:
  - mean: 0.25
    window_from: "2025-01-01"
    window_to: "2025-02-01"  # Ends Feb 1
  
  - mean: 0.27
    window_from: "2025-01-15"  # Starts Jan 15 (overlaps!)
    window_to: "2025-03-01"
```

**On Jan 20, which value applies?**
- Latest by window_from? (0.27) ← **YES**
- Most specific (shortest range)? (0.25)
- Error?

**✅ DECISION: YES - Include window_to (optional)**

**Rationale (from discussion doc #11):**

**Use Cases Requiring window_to:**

1. **Historical Archiving**
   ```yaml
   - mean: 0.25
     window_from: "2025-01-01"
     window_to: "2025-01-31"  # Jan only
   - mean: 0.27
     window_from: "2025-02-01"  # Feb onward
   ```

2. **Latency Analysis (Critical!)**
   - Graphs taking ~45 days to complete
   - Need to know "what params applied when" for cohort analysis
   - Convolve time_cost distributions over historical ranges
   - Questions: "How mature is this?", "Was this expected?"

3. **Explicit Date Ranges**
   - External data source provides time-bound data
   - Clear semantics for "this value valid in this period"

**Semantics:**
- **No window_to:** Applies from window_from onward (until superseded)
- **With window_to:** Applies only in [window_from, window_to] range
- **Selection:** Latest by window_from that matches query time
- **Overlaps:** Latest wins (by window_from)

**See:** `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #11 for full analysis

### Q5: **Snapshot Persistence**

**✅ DECISION: Already addressed in Use Case 3, comment #4**

**Summary:**
- **Storage:** In-memory (Phase 1), optional file save later
- **Format:** JSON parameter packs
- **Quantity:** User creates as needed (ephemeral)
- **Git:** NOT included by default (too much churn)

**See Use Case 3, comment #4 for full specification**

### Q6: **Case Weights Time Resolution**

**Scenario:** User retrieves live data on 2025-02-15, but case has different weights on 2025-02-01 vs 2025-02-15.

**Question:** When calculating "is experiment working?", which weights apply to which data?

**Options:**
- **A) Use weights at time of data retrieval** (simple, but might be wrong)
- **B) Store weight history with data** (complex, but accurate)
- **C) User specifies analysis date range** (flexible)

**✅ DECISION: Three modes - Naive (Phase 1), As-At-Time (Phase 2), Latency Convolution (Phase 3)**

**Mode 1: Get Latest (Phase 1 - Default)**
- Retrieve current case weights (as they are now)
- Retrieve current param values (as they are now)
- Simple, fast, good enough for most use cases

**Mode 2: As-At-Time (Phase 2 - Sophisticated)**
- User specifies analysis date (e.g., "2025-02-15")
- System retrieves case weights as they were on that date
- System retrieves param values as they were on that date
- Enables historical "what actually happened" analysis
- Answers: "Given the weights and data at that time, what was expected?"

**Mode 3: Latency Convolution (Phase 3 - Complex)**
- For long-running experiments (e.g., 45-day graphs)
- User started journey on day T, journey takes D days (distributed)
- For each day T+d in the journey, use params/weights as they were on that day
- Convolve distributions across time
- Answers: "How mature is this cohort?", "What will it look like when complete?"

**Note:** Option B misunderstood - we're not storing weight history WITH each data point, we're storing weight history in case schedules (time windows) and retrieving appropriate weights based on analysis mode.

**See:** `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #16 for full details

### Q7: **Amplitude Batch Optimization**

**Scenario:** User clicks "Update All from Amplitude" with 50 edges.

**Naive approach:**
- 50 separate Amplitude API calls
- 100 registry lookups (nodes + events)
- 5+ minutes with rate limiting

**Optimized approach:**
- Load all node details upfront (1 batch)
- Load all event details upfront (1 batch)
- Group Amplitude queries by uniqueness (might be only 20 unique node pairs)
- 20 Amplitude calls instead of 50

**Question:** Do we need caching layer for node→event mapping?

**✅ DECISION: Note for Phase 2+, not urgent now**

**Phase 1 Approach:**
- Sequential operations (acceptable for small graphs)
- No optimization needed initially
- Focus on correct implementation first

**Phase 2+ Optimizations:**
- Cache node→event mapping during batch operations
- Load all node details upfront (1 batch)
- Load all event details upfront (1 batch)
- Group Amplitude queries by uniqueness
  - 50 edges might be only 20 unique node pairs
  - Deduplicate queries, share results
- Respect rate limits with queuing
- Batch optimizations per connector

**Considerations:**
- Amplitude rate limits (paid tier more permissive)
- All registry data already in memory (Git clone)
- Lookups are fast, batching is optimization not necessity

**See:** `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #18 for batch optimization notes

### Q8: **Parameter Type Coercion**

**Scenario:** Param is type `probability` but has values outside [0, 1].

**Options:**
- **A) Validation error:** Reject invalid data
- **B) Coerce:** Clamp to [0, 1]
- **C) Warning:** Allow but show warning

**Also:** What about `cost_gbp` with negative values? `cost_time` with negative values?

**✅ DECISION: Graceful validation - Warn but don't enforce**

**Strategy:**
- **Monaco Editor:** Show schema validation warnings (yellow squiggles)
- **Data Loader:** Accept invalid data (fail gracefully)
- **Graph Display:** Render with warning indicator
- **Analytics Runner:** Validate strictly, error on invalid data (rigorous analysis phase)
- **UI:** Show validation warnings, but don't block user

**Rationale:**
- Users can edit YAML files directly (can't enforce schema in file system)
- GIGO principle: User's responsibility for data quality
- Better to warn than crash
- Strict validation only at analysis/computation time

**Specific Cases:**
- Probability > 1 or < 0: Warn (invalid probability)
- Negative cost_gbp: Allow (revenue events!) - See Core Design #2
- Negative cost_time: Warn (likely error, but don't block)

**See:** `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #14 for validation strategy

### Q9: **Graph Field Mapping Conflicts**

**Scenario:** Edge has both:
- Direct values: `p.mean = 0.25`
- Parameter reference: `p.parameter_id = "checkout-conversion"`

**Which takes precedence when pushing to param file?**

**✅ CLARIFICATION: Question was incoherent - misunderstood data flow**

**Correct Understanding:**
- Edges **always** have direct values (mean, stdev, distribution, etc.)
- Edges **optionally** have parameter_id (reference to param file)
- These are NOT conflicting - they work together by design

**Data Flow Operations:**
- **Pull (param → graph):** Read param file, update graph values
- **Push (graph → param):** Read graph values, update param file referenced by parameter_id
- **No conflict:** The operation itself defines the direction of data flow

**Example:**
```json
{
  "p": {
    "mean": 0.25,              // ← Direct value (always present)
    "stdev": 0.04,
    "distribution": "beta",
    "parameter_id": "checkout"  // ← Reference (optional)
  }
}
```

**Push Operation:**
- Reads `mean: 0.25` from graph
- Updates file `parameters/probability/checkout.yaml`
- Appends new time window with `mean: 0.25`

**No precedence needed** - graph values ARE the source for push operations.

**See:** `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #20 for clarification 

### Q10: **Data Source Priority (Multiple Sources)**

**Scenario:** Parameter has:
- Manual baseline value
- Sheets-sourced value
- Amplitude-sourced value

**Which is "current"?**
- Latest by `window_from`? (YES - user's stated convention)
- Highest priority source type? (NO)
- User-selected "active" value? (TOO COMPLEX) 

**✅ DECISION: Latest by window_from (confirmed), multiple data sources per param supported**

**Data Source Priority:**
- Latest by `window_from` (most recent applicable window)
- Source type irrelevant to selection
- Each `values[]` entry has its own `data_source`

**Schema Clarification:**
- Current param schema DOES support per-value data sources (already built!)
- `metadata.data_source` indicates "primary" source for ongoing updates
- Each value can come from different source (manual → Sheets → Amplitude)

**Example:**
```yaml
values:
  - mean: 0.25
    window_from: "2025-01-01"
    data_source: { type: manual }
  - mean: 0.27
    window_from: "2025-02-01"
    data_source: { type: sheets, url: "..." }
  - mean: 0.30
    window_from: "2025-03-01"
    data_source: { type: amplitude, query: {...} }
```

**Connections Registry (Important for Phase 1!):**

**Problem:** Need to define connection configs beyond credentials:
- Base URLs, API versions
- Standard query parameters
- Rate limits
- Field mappings

**✅ DECISION: Hybrid approach (from discussion doc #10)**

**Phase 1:** Hard-code connection configs in connector classes
```typescript
// src/connectors/amplitude/config.ts
export const AMPLITUDE_CONFIG = {
  baseUrl: "https://amplitude.com/api/2",
  apiVersion: "2",
  // ... sensible defaults
};
```

**Phase 2+:** Optional connections registry (if needed)
- File type: `connection` (like parameter, case, event)
- Location: `param-registry/connections/`
- Schema: `connection-schema.yaml`
- Allows user customization when needed

**Rationale:** Start simple (code defaults), add registry only if customization becomes necessary

**See:** `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #10 and #22

### Q11: **Context Dimension Conflicts**

**Scenario:** Parameter has values for:
- `context_id: device-mobile`
- `context_id: utm-google`

**User has active contexts: `{ device: "mobile", utm_source: "google" }`**

**Question:** Do we need values that match BOTH contexts simultaneously?

**Example:**
```yaml
values:
  # Mobile only
  - mean: 0.23
    context_id: device-mobile
  
  # Google only
  - mean: 0.26
    context_id: utm-google
  
  # Mobile + Google (more specific)
  - mean: 0.28
    context_ids: [device-mobile, utm-google]  # ← Need this?
```

**Or:** Keep it simple with single context_id for now?

**✅ DECISION: YES - Multi-dimensional contexts (Cartesian product) absolutely supported**

**Schema Enhancement:**
```yaml
# Current (single dimension)
values:
  - mean: 0.23
    context_id: "device-mobile"

# Enhanced (multi-dimensional - Phase 2+)
values:
  - mean: 0.28
    context_ids: ["device-mobile", "utm-google", "segment-premium"]
    # OR
    context_filters:
      device: mobile
      utm_source: google
      user_segment: premium
```

**Matching Logic:**
- All specified context dimensions must match active contexts
- More specific (more dimensions) wins over less specific
- Enables analysis by device × source × segment combinations

**Implementation:**
- Include in schema now (schema is permissive)
- Implement matching logic in Phase 2 (when contexts system integrated)

**See:** `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #12 and Use Case 4, comment #8

### Q12: **Conditional Probability Mapping**

**Graph has:**
```json
{
  "conditional_p": [
    {
      "condition": { "visited": ["node-a", "node-b"] },
      "p": {
        "mean": 0.35,
        "parameter_id": "conversion-after-visit-a-b"
      }
    }
  ]
}
```

**Parameter file for conditional probability:**
```yaml
id: conversion-after-visit-a-b
type: probability
# ⚠️ How do we encode the "visited" condition in param file?
# Option A: In metadata?
# Option B: In data_source.query?
# Option C: Separate field?

values:
  - mean: 0.35
    stdev: 0.06
    n: 1200
    k: 420
    # WHERE DOES visited: [node-a, node-b] GO?
```

**✅ DECISION: Add `condition` field to parameter schema + Graph editor integration**

**Problem Confirmed:** Major issue - Amplitude queries for conditional probabilities need to know the condition (visited nodes), but param file doesn't currently store this.

**Solution: Option B from discussion doc #9**

**Add to Parameter Schema:**
```yaml
# parameter-schema.yaml
properties:
  condition:
    type: object
    description: "Conditional context for this parameter"
    properties:
      visited:
        type: array
        items: { type: string }
        description: "Node IDs that must be visited"
      # Future: all_of, any_of, none_of for complex conditions
```

**Example Parameter File:**
```yaml
id: conversion-after-visit-a-b
type: probability
condition:
  visited: [node-a, node-b]  # ← NEW: Stores the condition
values:
  - mean: 0.35
    stdev: 0.06
    n: 1200
    k: 420
    data_source:
      type: amplitude
      query:
        from_event: checkout_started
        to_event: purchase_completed
        # Amplitude connector uses condition.visited to construct query
```

**Graph Editor Integration:**
- When creating `conditional_p`, prompt user to create/link parameter
- Pre-populate `condition` field from graph's conditional_p structure
- Show condition in conditional probabilities panel
- Warn if graph condition ≠ param condition (data inconsistency)

**Amplitude Query Construction:**
- Read `param.condition.visited` to determine required event sequence
- Query Amplitude for funnel with those preconditions
- More complex Markov chain order n queries

**Trade-offs:**
- ✅ Parameter is self-contained (can query data without graph context)
- ✅ Clear semantics for data retrieval
- ⚠️ Some duplication between graph and param (manageable with UI sync)
- ⚠️ Need to keep them in sync (graph editor's responsibility)

**See:** `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #9 for full options analysis

### Q13: **Stdev Calculation vs Storage**

**Scenario:** Amplitude returns n and k, we calculate stdev.

**Questions:**
- Store calculated stdev in param file? (YES - for consistency)
- Recalculate stdev on every load? (NO - expensive)
- What if user manually edits stdev? (Warn that it's inconsistent with n/k?)

**✅ DECISION: Store calculated stdev, accept potential divergence (GIGO principle)**

**Approach:**
- Calculate stdev from n and k when retrieving from Amplitude
- Formula: `stdev = sqrt(p * (1-p) / n)` where `p = k/n`
- Store calculated value in param file
- Don't recalculate on every load (expensive, unnecessary)

**Manual Edit Handling:**
- If user manually edits stdev, it may diverge from n/k
- That's acceptable - user's responsibility (GIGO: Garbage In, Garbage Out)
- Monaco can show warning if divergence detected
- Most users will leave calculated values alone

**See:** `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #5 for calculation details

### Q14: **Distribution Type Inference**

**Scenario:** Retrieve data from Amplitude (binomial data: n, k)

**What distribution should we assign?**

**✅ DECISION: Don't assign - parameter already specifies distribution**

**Correct Approach:**
- Parameter file already has `distribution` field (pre-defined)
- Data retrieval populates: mean, stdev, n, k
- Distribution field is NOT set by data retrieval
- Use existing distribution value from parameter

**Rationale:**
- Distribution is a modeling choice, not data property
- User/analyst decides distribution when creating parameter
- Data retrieval updates parameter values, not parameter definition

**Future Enhancement (Analytics Runner):**
- May do distributional fitting to suggest best-fit distribution
- Could compare data to various distributions (beta, normal, etc.)
- Suggest changes, but don't automatically apply

**Phase 1:** Use distribution as specified in parameter, don't infer

**See:** `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #6 for clarification

### Q15: **Edge Without Parameter (Direct Values)**

**Scenario:** Edge has direct values but no parameter_id:
```json
{
  "p": {
    "mean": 0.5,
    "stdev": 0.05,
    // NO parameter_id
  }
}
```

**Questions:**
- Can we retrieve latest data? (NO - no source defined)*
- Should we auto-create parameter? (Maybe?)
- Is this a valid state? (YES - for quick prototyping)

**✅ DECISION: 100% valid, definitely NO auto-creation**

**State Validity:**
- Edge without parameter_id is **completely valid**
- Common for quick prototyping and what-if scenarios
- User manually sets values, no external data source
- No automatic parameter file creation

***Exception:** If nodes have `event_id`, can do direct retrieval (Pathway B) without parameter file
- Retrieve from Amplitude directly to graph
- Not versioned, casual analysis
- See Dual Pathways (Use Case 2) for details

**UI Behavior:**
- No warnings (this is intentional, not an error)
- Lightning icon shows appropriate state (manual/direct)
- User can add parameter_id later if desired

**See:** Use Case 2 for parameter states and Dual Pathway discussion

### Q16: **Registry Index Staleness**

**Scenario:**
- User creates new parameter file: `parameters/probability/new-param.yaml`
- But doesn't update `registry.yaml`

**Result:** Parameter exists but not in registry index

**Options:**
- **A) Scan directory:** Find all param files, ignore index (slow but works)
- **B) Require index:** Error if not in index (strict but fragile)
- **C) Auto-update index:** On create, update index automatically (best?)

**✅ DECISION: Option C (app updates index) + Precedence rules + Future reindex**

**Primary Approach (Phase 1):**
- User updates through app (graph editor, FormEditor)
- App has robust CRUD pathways that update index automatically
- Index stays in sync under normal operations

**Precedence Rules (when conflict occurs):**

**Scenario A: User retrieving FROM param file TO graph**
1. Param file (authoritative source)
2. Index (for listing/autocomplete)

**Scenario B: User retrieving directly TO graph (no param file)**
1. Graph values (user's working data)
2. Param file (if created later)
3. Index (for references)

**Future Enhancement: Reindex Function (Phase 2+)**
- Scan all param files, rebuild index
- Useful after manual file editing, Git operations
- Not urgent for Phase 1 (app manages index)

**See:** `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #13 for precedence details

### Q17: **Credentials Per Data Source**

**Scenario:** Different Google Sheets need different service accounts

**Current schema:**
```json
{
  "googleSheets": {
    "serviceAccount": "..." // ONE service account
  }
}
```

**Do we need:**
```json
{
  "googleSheets": {
    "default": "...",
    "serviceAccounts": {
      "marketing": "...",
      "finance": "..."
    }
  }
}
```

**✅ DECISION: Single service account per connector (Phase 1), connections registry addressed in Q10**

**Phase 1 Approach:**
- One Google service account (stored in credentials.yaml)
- One Amplitude API key/secret (stored in credentials.yaml)
- Sufficient for most use cases

**Future (if needed):**
- Could add multiple service accounts with naming
- Could add per-connection credential overrides

**Connections Registry:**
- Already addressed in Q10 above
- Phase 1: Hard-code connection configs in connector classes
- Phase 2+: Optional connections registry if customization needed

**Not a blocker for Phase 1** - single credential per connector type works fine

**See:** Q10 for full connections registry discussion and `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #10

### Q18: **Amplitude Query Caching**

**Scenario:** User retrieves data from Amplitude for edge A. 5 minutes later, retrieves for edge B (same node pair).

**Should we:**
- Cache result for X minutes? (Faster, but might be stale)
- Always fetch fresh? (Slow, but accurate)
- User-configurable TTL? (Complex)

**✅ DECISION: Not yet - Phase 2+ optimization**

**Phase 1 Approach:**
- No caching (always fetch fresh)
- User-triggered operations (not automated)
- Acceptable for small-scale usage

**Phase 2+ Considerations:**
- Could add short-lived cache (5-10 minutes)
- Useful during batch operations
- Respect that user is on paid Amplitude tier (rate limits less restrictive)
- Could add `refresh_frequency` hint from parameter metadata

**Not urgent** - Premature optimization. Focus on correct implementation first.

**See:** Q7 and `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #18 for batch optimization notes

### Q19: **Error State Persistence**

**Scenario:** Amplitude API fails, last successful retrieve was 2 days ago.

**Should parameter indicate:**
- Last successful retrieve timestamp? (YES - already in data_source.retrieved_at)
- Current status (stale/fresh/error)? (Useful for UI)
- Error message? (For debugging)

**Add to param schema:**
```yaml
status:
  state: stale  # fresh | stale | error
  last_successful: "2025-11-01T10:00:00Z"
  last_error: "Amplitude rate limit exceeded"
  last_attempt: "2025-11-03T14:30:00Z"
```

**✅ DECISION: YES - Add status field to param schema, implement in Phase 2**

**Schema Addition:**
```yaml
# parameter-schema.yaml
status:
  type: object
  properties:
    state:
      type: string
      enum: [fresh, stale, error]
    last_successful_retrieve:
      type: string
      format: date-time
    last_error:
      type: string
    last_attempt:
      type: string
      format: date-time
```

**Phase 1:**
- Schema supports status field
- Basic retrieval, minimal error handling
- Focus on correct implementation

**Phase 2:**
- Full logging and status tracking
- UI indicators for stale/error states
- Retry logic for failed retrievals
- Batch operation result logs

**See:** `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #19 for error persistence strategy

### Q20: **Graph Metadata for Data Provenance**

**Scenario:** User wants to know "when was this graph last updated from live data?"

**Should graph metadata include:**
```json
{
  "metadata": {
    "last_data_update": "2025-11-03T14:30:00Z",
    "data_sources_used": ["amplitude", "sheets"],
    "parameters_updated": 47
  }
}
```

**Or:** Calculate on-demand from parameter timestamps?

**✅ DECISION: YES - Add to both graph metadata AND per-param on graph**

**Graph-Level Metadata:**
```json
{
  "metadata": {
    "version": "1.0.0",
    "created_at": "2025-01-01T00:00:00Z",
    "updated_at": "2025-11-03T14:30:00Z",
    "last_data_retrieval": "2025-11-03T14:30:00Z",  // NEW
    "data_sources_used": ["amplitude", "sheets"],   // NEW
    "parameters_updated": 47                         // NEW
  }
}
```

**Per-Parameter Metadata (on graph):**
```json
{
  "p": {
    "mean": 0.27,
    "stdev": 0.0044,
    "n": 10000,
    "parameter_id": "checkout-conversion",
    "retrieved_at": "2025-11-03T14:30:00Z",  // NEW - optional, not shown in UI
    "data_source": {
      "type": "amplitude",
      "direct": false
    }
  }
}
```

**Benefits:**
- Know when graph was last refreshed (graph-level)
- Track per-parameter retrieval times (even if not exposed in UI)
- Provenance tracking for data quality
- Enable "stale data" indicators
- Support audit trail

**Implementation:**
- Update timestamps when pulling data from any source
- Both levels updated atomically
- Optional fields (backward compatible)

**Add to Phase 0/1 schema updates**

**See:** `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` #17 for provenance strategy

---

## Schema Enhancement Proposals

Based on above analysis, here are proposed schema changes:

### 1. Parameter Schema Updates

```yaml
# ADD: window_to (optional)
values:
  - window_to:
      type: string
      format: date-time
      description: "End of time window (optional, omit for open-ended)"

# ADD: n and k for Bayesian analysis
  - n:
      type: integer
      minimum: 0
      description: "Sample size (total observations)"
  
  - k:
      type: integer
      minimum: 0
      description: "Success count (for probability parameters)"

# Optional: Status tracking (for future monitoring)
status:
  type: object
  properties:
    state:
      type: string
      enum: [fresh, stale, error]
    last_successful_retrieve:
      type: string
      format: date-time
    last_error:
      type: string
    last_attempt:
      type: string
      format: date-time
```

**Note:** In param files, store both n and k for full fidelity. In graph, only n is stored (k is derivable).

### 2. Node Schema Updates

```yaml
# ADD: event_id (optional, references events registry)
event_id:
  type: string
  pattern: ^[a-z0-9-]+$
  description: "Reference to event in events registry (for analytics integration)"
```

### 3. Event Schema (NEW)

**Events Index (Minimal, Inline Definitions):**
```yaml
# events-index-schema.yaml
type: object
required: [version, events]

properties:
  version:
    type: string
    pattern: '^\d+\.\d+\.\d+$'
  
  events:
    type: array
    items:
      oneOf:
        # Simple: inline definition (95% of events)
        - type: object
          required: [id, name]
          properties:
            id:
              type: string
              pattern: ^[a-z0-9_]+$
              description: "Canonical event ID (likely matches production app)"
            name:
              type: string
            description:
              type: string
            status:
              type: string
              enum: [active, deprecated]
              default: active
        
        # Complex: reference to file (5% of events)
        - type: object
          required: [id, file_path]
          properties:
            id: { type: string }
            file_path: { type: string }
            status: { type: string }
```

**Individual Event File (Optional, for rich metadata):**
```yaml
# event-schema.yaml (only create file if needed)
type: object
required: [id, name, metadata]

properties:
  id:
    type: string
    pattern: ^[a-z0-9_]+$
    description: "Canonical event ID"
  
  name:
    type: string
  
  description:
    type: string
  
  # Connector-specific overrides (only if platform differs)
  connectors:
    type: object
    properties:
      amplitude:
        type: object
        properties:
          event_name: { type: string }  # Override if differs from id
          event_properties: { type: array }
      mixpanel:
        type: object
        properties:
          event_name: { type: string }
      # ... other connectors
  
  metadata:
    # Standard metadata block
```

### 4. Graph Schema Updates - UNIFIED PARAM TYPE SYSTEM

**Shared Base Type:**
```json
{
  "$defs": {
    "ParamValue": {
      "type": "object",
      "additionalProperties": false,
      "description": "Base structure for all parameter values",
      "properties": {
        "mean": { "type": "number" },
        "stdev": { "type": "number", "minimum": 0 },
        "n": { 
          "type": "integer", 
          "minimum": 0,
          "description": "Sample size (provenance/confidence). k derivable as k = mean × n"
        },
        "distribution": { "type": "string" },
        "parameter_id": { 
          "type": "string",
          "description": "Reference to parameter registry - INSIDE param object!"
        },
        "locked": { "type": "boolean", "default": false },
        "data_source": {
          "type": "object",
          "description": "For direct retrieval (not versioned)",
          "properties": {
            "type": { "type": "string" },
            "direct": { "type": "boolean" },
            "retrieved_at": { "type": "string", "format": "date-time" },
            "query": { "type": "object" }
          }
        }
      }
    },
    
    "ProbabilityParam": {
      "allOf": [
        { "$ref": "#/$defs/ParamValue" },
        {
          "type": "object",
          "properties": {
            "mean": { "minimum": 0, "maximum": 1 },
            "distribution": { 
              "enum": ["beta", "normal", "uniform"],
              "default": "beta"
            }
          }
        }
      ],
      "description": "Probability parameter: P(to|from), range [0,1]"
    },
    
    "MoneyParam": {
      "allOf": [
        { "$ref": "#/$defs/ParamValue" },
        {
          "type": "object",
          "properties": {
            "mean": { "type": "number" },  // CAN BE NEGATIVE (revenue!)
            "distribution": { 
              "enum": ["lognormal", "normal", "gamma", "uniform"],
              "default": "lognormal"
            },
            "currency": {
              "type": "string",
              "default": "GBP",
              "description": "Currency code (optional)"
            }
          },
          "required": ["mean"]
        }
      ],
      "description": "Monetary parameter (positive=cost, negative=revenue)"
    },
    
    "DurationParam": {
      "allOf": [
        { "$ref": "#/$defs/ParamValue" },
        {
          "type": "object",
          "properties": {
            "mean": { "type": "number", "minimum": 0 },
            "distribution": { 
              "enum": ["normal", "lognormal", "gamma", "uniform"],
              "default": "normal"
            },
            "units": {
              "type": "string",
              "description": "Freeform: 'd', 'h', '2.5d', 'days', etc."
            }
          },
          "required": ["mean"]
        }
      ],
      "description": "Time duration parameter"
    }
  }
}
```

**Node Schema:**
```yaml
Node:
  properties:
    event_id:
      type: string
      description: "Event reference (canonical event ID)"
```

**Edge Schema:**
```json
{
  "Edge": {
    "properties": {
      "p": { "$ref": "#/$defs/ProbabilityParam" },
      "cost_gbp": { "$ref": "#/$defs/MoneyParam" },
      "cost_time": { "$ref": "#/$defs/DurationParam" }
      // REMOVED: parameter_id, cost_gbp_parameter_id, cost_time_parameter_id
      // Now inside each param object!
    }
  }
}
```

**Key Changes:**
- ✅ Unified base type (ParamValue) with shared fields
- ✅ parameter_id INSIDE param objects (cleaner, self-contained)
- ✅ n on graph (NOT k) - k = p × n (derivable)
- ✅ Money can be negative (revenue events)
- ✅ Duration units freeform (human-readable)
- ✅ Type-specific constraints (bounds, distribution enums)
- ❌ BREAKING: Removes edge-level parameter_id fields (OK - system not in use)

### 5. Credentials Schema Updates

```yaml
# ADD: amplitude section (generic data connector)
amplitude:
  type: object
  properties:
    apiKey:
      type: string
      format: password
    secretKey:
      type: string
      format: password

# ADD: googleSheets section (generic data connector)
googleSheets:
  type: object
  properties:
    serviceAccount:
      type: string
      description: "Base64-encoded service account JSON"
    token:
      type: string
      format: password
      description: "Optional OAuth token"

# Future: Add other connectors (snowflake, statsig, etc.)
```

---

**NOTE:** Icon system and visual language details have been moved to `DATA_CONNECTIONS.md` Section 2.4.

---

## Phase 0 Implementation Stages

### Stage 0.1: Schema Updates (1-2 days)
**Goal:** Prepare all schemas for data connections with unified param type system

**Tasks:**

**Parameter Schema:**
- [ ] Update `parameter-schema.yaml`:
  - Add `n` (sample size) and `k` (successes) fields to values[]
  - Add `window_to` field (optional, explicit end date)
  - Add `status` object (optional, for future monitoring)

**Event Schemas:**
- [ ] Create `event-schema.yaml`:
  - Minimal schema (id, name, description, status)
  - Optional connectors section for platform-specific overrides
  - Convention over configuration: event_id = platform event name by default
- [ ] Create `events-index-schema.yaml`:
  - Support inline definitions (no file required by default)
  - Support file references (optional for rich metadata)

**Node Schema:**
- [ ] Update `node-schema.yaml`:
  - Add `event_id` field (optional, canonical event reference)

**Graph Schema (MAJOR REFACTOR):**
- [ ] Update `conversion-graph-1.0.0.json`:
  - **CREATE unified base type:** `ParamValue` with shared fields:
    - mean, stdev, n (NOT k - derivable), distribution
    - parameter_id (MOVED inside param objects!)
    - locked, data_source
  - **CREATE type-specific extensions:**
    - `ProbabilityParam` (extends ParamValue): mean [0,1], beta/normal/uniform
    - `MoneyParam` (extends ParamValue): mean can be negative, currency field, lognormal/normal/gamma
    - `DurationParam` (extends ParamValue): mean >= 0, freeform units, normal/lognormal/gamma
  - **UPDATE Edge schema:**
    - `p`: { $ref: "#/$defs/ProbabilityParam" }
    - `cost_gbp`: { $ref: "#/$defs/MoneyParam" }
    - `cost_time`: { $ref: "#/$defs/DurationParam" }
  - **REMOVE from Edge:** parameter_id, cost_gbp_parameter_id, cost_time_parameter_id
  - **ADD to Node:** event_id (optional)

**Credentials Schema:**
- [ ] Update `credentials-schema.json`:
  - Add `amplitude` section (apiKey, secretKey)
  - Add `googleSheets` section (serviceAccount base64)

**Validation:**
- [ ] Validate all schemas with JSON Schema validator
- [ ] Create migration guide for existing graphs (breaking change)
- [ ] Update any existing test graphs to new schema

**Success Criteria:** 
- All schemas validate
- Unified param type system in place
- parameter_id inside param objects
- n on graph, k derivable
- Type-specific constraints enforced

---

### Stage 0.2: Events Registry Implementation (1 day)
**Goal:** Add events as first-class registry objects (following cases pattern)

**Tasks:**
- [ ] Create `events-index.yaml` template in param-registry
- [ ] Add event type to `fileRegistry.ts`:
  ```typescript
  {
    type: 'event',
    extension: '.yaml',
    schema: 'event-schema.yaml',
    indexFile: 'events-index.yaml',
    icon: FileExclamation
  }
  ```
- [ ] Extend `registryService.ts`:
  - `loadEventRegistry()` - Load from index
  - `getEventById()` - Get event by ID
  - `getEventFromIndex()` - Get inline event (no file)
  - `validateEventReference()` - Check event exists
- [ ] Add Events section to Navigator:
  - Show events from index
  - Click to view/edit (if file exists)
  - Create file button (optional upgrade)
- [ ] Add event type to `EnhancedSelector`:
  ```typescript
  <EnhancedSelector
    type="event"
    value={node.event_id}
    onChange={handleEventChange}
  />
  ```
- [ ] Type-aware file creation:
  - Events: Don't nag about creating files (index is enough)
  - Show "Create detailed file" as optional action

**Success Criteria:** Events registry works like cases, index-only entries supported

---

### Stage 0.3: Field Mapping Documentation (0.5 day)
**Goal:** Document all graph ↔ param field mappings

**Tasks:**
- [ ] Create `fieldMappings.ts` with declarative mappings:
  ```typescript
  const FIELD_MAPPINGS = [
    {
      paramPath: 'values[latest].mean',
      graphPath: 'p.mean',
      appliesTo: 'edge',
      paramType: 'probability'
    },
    // ... all mappings
  ];
  ```
- [ ] Document value selection logic:
  - Time window selection (latest by window_from)
  - Context selection (match active contexts)
  - Fallback behavior (base value if no match)
- [ ] Document transformation rules:
  - Param → Graph (select applicable value)
  - Graph → Param (append new window)

**Success Criteria:** All mappings documented, clear selection/transformation logic

---

### Stage 0.4: Icon System Updates (0.5 day)
**Goal:** Update graph icon and add registry icons per specification in `DATA_CONNECTIONS.md` Section 2.4

**Tasks:**
- [ ] Replace graph icon throughout app:
  - Navigator graph items
  - Tab icons for graph editors
  - Graph type selector
  - Breadcrumbs
  - Use `TrendingUpDown` or `Waypoints`
- [ ] Add registry icons:
  - Cases: `Option`
  - Events: `FileExclamation`
- [ ] Create `src/config/dataConnectionIcons.ts`:
  ```typescript
  export const DATA_ICONS = {
    entities: { graph: TrendingUpDown, paramFiles: Folders, externalData: DatabaseZap },
    connection: { none: Unplug, param: Plug, paramWithSource: HousePlug },
    dataSource: { live: Zap, manual: ZapOff },
    actions: { retrieve: Zap, pull: ArrowDown, push: ArrowUp },
    sync: { synced: Check, outOfSync: AlertCircle, stale: Clock }
  };
  ```

**Success Criteria:** Graph icon updated everywhere, consistent icon language matching spec

---

### Stage 0.5: Test Data & Validation (0.5 day)
**Goal:** Create test data and validate schema compatibility

**Tasks:**
- [ ] Create sample events-index.yaml with 5-10 events
- [ ] Create sample parameter with:
  - Multiple time windows
  - n and k values
  - data_source configuration
- [ ] Create sample graph with:
  - Nodes referencing events
  - Edges with/without parameters
- [ ] Run validation tests:
  - Load events from index
  - Map param → graph
  - Map graph → param
  - Cascade: node → event → connector
- [ ] Document any issues found

**Success Criteria:** Test data validates, all mappings work, cascades resolve

---

## Validation Test Script (Pseudo-code)

```typescript
async function validateSchemaMappings() {
  console.log("🧪 Testing Schema Mappings...\n");
  
  // Test 1: Sheets → Param → Graph
  console.log("Test 1: Google Sheets Integration");
  const sheetsData = [[0.25, 0.05, "beta"]];
  const paramValue = transformSheetsToParam(sheetsData);
  const graphValue = mapParamToGraph(paramValue);
  assert(graphValue.mean === 0.25, "Sheets → Param → Graph: mean");
  console.log("✅ PASS\n");
  
  // Test 2: Amplitude → Param → Graph (with n, k)
  console.log("Test 2: Amplitude Integration");
  const amplitudeData = { series: [{ events: 10000 }, { events: 2700 }] };
  const paramFromAmplitude = transformAmplitudeToParam(amplitudeData);
  assert(paramFromAmplitude.n === 10000, "Amplitude: n stored");
  assert(paramFromAmplitude.k === 2700, "Amplitude: k stored");
  assert(paramFromAmplitude.mean === 0.27, "Amplitude: mean calculated");
  const graphFromAmplitude = mapParamToGraph(paramFromAmplitude);
  assert(graphFromAmplitude.mean === 0.27, "Amplitude → Graph: mean");
  assert(!graphFromAmplitude.n, "Graph should NOT have n");
  console.log("✅ PASS\n");
  
  // Test 3: Node → Event cascade
  console.log("Test 3: Event Cascade");
  const edge = { from: "node-checkout", to: "node-purchase" };
  const events = await getEventsForEdge(edge);
  assert(events.from === "checkout_started", "Event cascade: from");
  assert(events.to === "purchase_completed", "Event cascade: to");
  console.log("✅ PASS\n");
  
  // Test 4: Time window selection
  console.log("Test 4: Time Window Selection");
  const param = {
    values: [
      { mean: 0.25, window_from: "2025-01-01", window_to: "2025-01-31" },
      { mean: 0.27, window_from: "2025-02-01" }
    ]
  };
  const valueOnJan15 = getValueAtTime(param, new Date("2025-01-15"));
  assert(valueOnJan15.mean === 0.25, "Time window: historical");
  const valueOnFeb15 = getValueAtTime(param, new Date("2025-02-15"));
  assert(valueOnFeb15.mean === 0.27, "Time window: current");
  console.log("✅ PASS\n");
  
  // Test 5: Context selection
  console.log("Test 5: Context Selection");
  const paramWithContexts = {
    values: [
      { mean: 0.23, context_id: "device-mobile" },
      { mean: 0.31, context_id: "device-desktop" }
    ]
  };
  const mobileValue = getValueForContext(paramWithContexts, { device: "mobile" });
  assert(mobileValue.mean === 0.23, "Context: mobile");
  const desktopValue = getValueForContext(paramWithContexts, { device: "desktop" });
  assert(desktopValue.mean === 0.31, "Context: desktop");
  console.log("✅ PASS\n");
  
  console.log("🎉 All tests passed!");
}
```

---

## Next Steps

1. **Review & Decide:** Address 20 critical questions above
2. **Update Schemas:** Implement proposed enhancements
3. **Build Test Script:** Validate mappings with real data
4. **Document Mapping Logic:** Create `fieldMappings.ts` with all transformations
5. **Prototype:** Build throwaway connector to test end-to-end flow
6. **Iterate:** Fix any remaining issues before Phase 0 implementation

---

**Status:** Awaiting decisions on critical questions before proceeding to implementation.

