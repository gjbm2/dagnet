# Data Connections Schema Validation

**Purpose:** Validate that schemas fit together before building implementation  
**Status:** Pre-Implementation Analysis  
**Date:** 2025-11-03

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

**❓ QUESTIONS:**
1. How do we handle array format from Sheets? (B2:D2 vs B2:B4)

*** POINT HERE I THINK WE NEED AN UNAMBIGUOUS NAMING CONVENTION WHEN DELIVERING PARAM PACKS; SO IN DAGCALC (SEE /APP-SCRIPT/) WE DEVISED A CONVENTION, WHICH I _THINK_ STILL WORKS, E.G { "E.NODE-C-NODE-D.VISITED(NODE-A).P.MEAN" : .3 }. THE 'E' IS OPTIONAL. AND NOW WE HAVE PARAMS WITH CANONICAL NAMES WE DON'T EVEN NEED TO NAME VIA GRAPH CONTEXT, WE CAN JUST GIVE THE PARAM_ID. BUT WE MIGHT WANT A SIMILAR SUFFIX APPROACH E.G. PARAM_ID.WINDOW(DATE).CONTEXT(CONTEXT_ID).P.MEAN....WDYT? WE COULD PARSE THAT UNAMBIGUOUSLY BUT ALSO FLEXIBLY E.G.  P.PARAM_ID.WINDOW(DATE).CONTEXT(CONTEXT_ID).N = PARAM_ID.CONTEXT(CONTEXT_ID).WINDOW(DATE).N. NOW HOW DO WE HANDLE TABLES OF DATA? I GUESS WE COULD EITHER ANTICIPATE THAT THEY'RE ALTERNATELY [ELEMENT] AND [VALUE]? OR WE COULD DO SOMETHING CLEVERER? OR WE COULD DO [ELEMENT]/[VALUE] ALTERNATELY AND ANY TRANSFORMATION HAPPENS "CLIENT SIDE" (I.E. IN THE SHEET)? ***

2. What if analyst updates Sheet but doesn't retrieve? How do we show "stale" status?
3. Should we store n/k in Sheet-sourced params? (Probably NO for manual data)

*** SEE ABOVE -- KEY THING IS CANONICAL NAMING. BUT THEN N AND K WOULD BE OPTIONAL EVEN IF WE DID PROVIDE IT ***

---

## Use Case 2: Amplitude Empirical Data (Simple Node-to-Node)

### Data Flow

```
Amplitude API → Parameter File → Graph Edge
     ↓              ↓ (append)         ↓ (display)
  n: 10000      values[].n: 10000   edge.p.mean: 0.27
  k: 2700       values[].k: 2700    edge.p.stdev: 0.0044
              values[].mean: 0.27
```

### Concrete Example

**Graph Nodes:**
```json
{
  "nodes": [
    {
      "id": "node-uuid-1",
      "slug": "checkout-started",
      "label": "Checkout Started"
      // ⚠️ QUESTION: Does node need event_id here, or only in node registry?

*** I AM INCLINED TO ALLOW EVENT_ID ON GRAPH; TO SOME DEGREE NODES ARE NOT THE SAME AS EVENTS, AND IT IS SOMEWHAT CONTEXTUAL AS TO WHETHER AN EVENT IS ASSOCIATED STRICTLY WITH A CANONICAL NODE OR NOT. SO YES, I THINK EVENT_ID IS ALLOWED ON GRAPH, AND IN MANY CASES WE BRING IT THROUGH WHEN THE NODE IS CREATED, BUT NOT MANDATORILY. NB. I'M NOT 100% SURE ABOUT THIS. ***

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
event_id: checkout-started-event  # ← Reference to events registry

metadata:
  created_at: "2025-01-01T00:00:00Z"
  version: "1.0.0"
```

**Event Registry Entry:** `events/checkout-started-event.yaml`
```yaml
id: checkout-started-event
name: "Checkout Started Event"
description: "Triggered when user clicks checkout button"

amplitude:
  event_type: "checkout_started"  # ← Amplitude event name
  event_properties:
    - name: product_category
      type: string
    - name: cart_value
      type: number

metadata:
  category: conversion
  funnel_stage: revenue
  created_at: "2025-01-01T00:00:00Z"
  version: "1.0.0"
```

**Graph Edge:**
```json
{
  "id": "edge-checkout-to-purchase",
  "from": "node-uuid-1",  // checkout-started
  "to": "node-uuid-2",    // purchase-completed
  "p": {
    "mean": 0.27,
    "stdev": 0.0044,
    "distribution": "beta",
    "parameter_id": "checkout-conversion-rate"
    // ⚠️ NO n or k on graph edge (per user decision)
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
    stdev: 0.0044                           *** <==== WHERE DOES THIS COME FROM?; WOULDN'T STDEV BE INFERRED *** 
    n: 10000        # ← Stays in param file, NOT copied to graph
    k: 2700         # ← Stays in param file, NOT copied to graph
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

### Cascade Resolution for Amplitude Query

```typescript
async function getAmplitudeEventsForEdge(edge: Edge, graph: Graph): Promise<{from: string, to: string}> {
  // 1. Find nodes
  const fromNode = graph.nodes.find(n => n.id === edge.from);
  const toNode = graph.nodes.find(n => n.id === edge.to);
  
  // 2. Load node details from registry (cascade #1)
  const fromNodeDetail = await loadNodeDetail(fromNode.slug);
  const toNodeDetail = await loadNodeDetail(toNode.slug);
  
  // 3. Load event details from registry (cascade #2)
  const fromEvent = await loadEvent(fromNodeDetail.event_id);
  const toEvent = await loadEvent(toNodeDetail.event_id);
  
  // 4. Return Amplitude event types
  return {
    from: fromEvent.amplitude.event_type,  // "checkout_started"
    to: toEvent.amplitude.event_type       // "purchase_completed"
  };
}

async function retrieveFromAmplitude(edge: Edge, param: Parameter): Promise<ParameterValue> {
  const creds = await getCredentials();
  const amplitude = new AmplitudeConnector(creds.amplitude);
  
  // Get events via cascade
  const events = await getAmplitudeEventsForEdge(edge, currentGraph);
  
  // Query Amplitude
  const funnelData = await amplitude.queryFunnel({
    steps: [
      { event_type: events.from },
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
      type: "amplitude",
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

**🚨 ISSUES FOUND:**

1. **Cascade Performance:** For batch "Update All", we'd need to load:
   - All node details (N lookups)
   - All event details (M lookups)
   - This could be 100+ registry lookups for large graphs 

   *** YEAH, BUT IT'S ALL IN MEMORY ALREADY -- WE DO A GIT CLONE ON INIT AND SO IT'S ALL LOCAL; THESE FILES AREN'T REALLY VERY LARGE IN ABSOLUTE TERMS...SO IT'S JUST A GIT CLONE TO START, AND THEN IT'S ALL IN MEMORY FOR THE ANALYSIS. ===> GO AND DO A BACK OF THE PACKET ANALYSIS ON HOW MUCH DATA WE'RE LIKELY TALKING ABOUT A YEAR FROM NOW ACROSS 100 NODES, 200 PARAMS, ONE DATASET PER DAY, ALL STORED UNCOMPRESSED IN YAML FILES TO CONFIRM IT'S MANAGEABLE ***

2. **Event ID Location:** Should graph node have `event_id` for quick access?
   - Pro: Faster, no registry lookup needed
   - Con: Duplication (node registry already has it)
   - Decision needed: **Convenience vs. DRY principle**

    *** IT'S NOT ONLY CONVENIENCE. I'M NOT SURE NODE = EVENT. I THINK THERE ARE TIMES WHEN EVENTS ARE GRAPH CONTEXT SPECIFIC. SO I DO THINK WE NEED EVENT ON GRAPH. THE REASON WE HAVE NODE_ID IN THE FIRST PLACE IS ONLY REALLY FOR VISITED(NODEA) PURPOSES; ALL THE GOOD STUFF MOSTLY LIVES ON EDGES CURRENTLY [ALTHOUGH THAT MAY CHANGE] *** 

3. **Parameter Creation:** When edge references non-existent parameter, who creates it?
   - Auto-create with placeholder?
   - Force user to create manually?
   - Decision needed

    *** I DON'T UNDERSTAND...THE PARAM MAY NOT "EXIST" IN THE REGISTRY OR IN A FILE; THAT IS POSSIBLE. IN THAT CASE IT LIVES ON THE GRAPH WHERE THE USER DEFINED IT, AND IT WON'T UPDATE BECAUSE THERE'S NO ASSOCIATED SOURCE... WHAT AM I MISSING? *** 

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
    color: string;         // Blended color showing delta
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
      color: delta > 0 
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

**❓ QUESTIONS:**
4. Should snapshots be saved to files? Or only in-memory for comparison?

*** AT PRESENT, I'M IMAGINGING THEY'RE EPHEMERAL -- FOR NOW AT LEAST *** 

5. How do we handle case weight changes from Statsig API? Same pattern as Amplitude?

*** WHY NOT? ***

6. Do we need a `case_weights` field on graph node, or always load from case file?

*** SAME AS ABOVE -- IT LIVES ON GRAPH, BECAUSE IT DOES SO THE USER CAN PLAY WITH THE GRAPH. IN PRACTICE IF USER RETRIEVES IT FROM LIVE DATA [STATSIG, WHATEVER] AND THEN PULLS IT INTO THE GRAPH, THEN THE GRAPH WILL HAVE THE LATEST ACTUAL VALUE; USER CAN THEN WHAT IF FROM THERE IF THEY LIKE ***


*** ONE KEY ASPECT NOT OTHERWISE COVERED HERE WE NEED TO ENSURE WE ARE CONSIDERING: WINDOWED PARAM VALUES ARE ESSENTIAL WHEN WE [LATER] WANT TO SEE LATENCY ANALYSIS ON GRAPH EVENTS. SOME GRAPHS TAKE ~45 DAYS TO COMPLETE. WE WILL WANT TO ASK QUESTIONS SUCH AS 'HOW NEARLY MATURE IS THIS?', 'WHAT WILL IT LOOK LIKE WHEN IT MATURES?', 'IF WE HAD X OF THESE TODAY, WAS THAT WHAT WE EXPECTED?' WHICH MEANS CONVOLVING WEIGHTED TIME COST ALONG THE EDGES BEFORE DETERMING PMF. WE WILL DO ALL THIS IN PY I SUSPECT, BUT LET'S REASON THROUGH WHETHER THESE DATA ARCHITECTURE QUESTIONS SUPPORT THAT PROPERLY ***

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

**❓ QUESTIONS:**
7. How does user select active contexts in UI?

*** USING THE CONTEXTS_ID CLASS, WHICH ISN'T YET INTEGRATED INTO THE EDITOR, BUT WILL BE LATER; WE WILL ADD 'SET_CONTEXT' ON NODES AND ALLOW A MY-EDGE.CONTEXT(CONTEXT_ID).P.MEANS LATER ON TOO. ***

8. Do we need multiple context dimensions simultaneously? (device + utm_source + user_segment)

*** YES. BUT OPTIONALLY. ***

9. Should graph store "last used context" for quick reload?

*** DON'T FOLLOW. CONTEXTS ARE DEFINED IN <CONTEXTS> ***

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

**Recommendation:** *** I THINK WE BRING IT INTO GRAPH ***

### Q2: **n and k on Graph Edges**

**Current State:**
- Graph edge has: p.mean, p.stdev, p.distribution
- Param values have: mean, stdev, distribution, n, k

**User's position:** "I don't think graphs need n & k... p & stdev suffice"

**Use cases that might need n/k on graph:**
- ❌ Snapshot visualization (NO - just need mean for fringe colors)
- ❌ Stdev visualization (NO - already have stdev)
- ❌ Revenue/day calculations (NO - do in dagCalc or separate tool)
- ❌ MCMC analysis (NO - pull from params before sending to Py runner)
- ❓ Anything else?

**Recommendation:** Keep n/k only in param files (NOT on graph)

*** IF WE CHANGED OUR MINDS LATER ON THIS I DON'T THINK IT'S A BIG DEAL. BUT WE CAN ADD A 'INSPECT' FEATURE WHICH LOOKS THROUGH THE GRAPH INTO THE PARM FILE LATER IF WE LIKE ***

### Q3: **Parameter Auto-Creation**

**Scenario:** Edge references `parameter_id: "foo"` but parameter file doesn't exist.

**Options:**
- **A) Error:** "Parameter 'foo' not found"
- **B) Auto-create:** Create stub param file with default values
- **C) Soft warning:** Allow graph to work, show warning indicator

**Recommendation:**  *** LEAVE IT TO THE GRAPH EDITOR, NO AUTOMATION IN THE DATA LAYER; USER COMMMITS *** 

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
- Latest by window_from? (0.27)
- Most specific (shortest range)? (0.25)
- Error?

**Recommendation:**  *** DO WE ACTUALLY NEED BOTH FROM & TO? I'M UNCLEAR WHETHER 'FROM' SUFFICES? ***

### Q5: **Snapshot Persistence**

**User wants:** Snapshot feature for before/after visualization

**Questions:**
- Where do we store snapshots? (File? Memory only? IndexedDB?) *** THIS IS IN MEMORY FEATURE INITIALLY... ***
- Format? (JSON? Part of graph file? Separate .snapshot files?) *** BUT YES, THEY'RE JUST PARAMETER PACKS ULTIAMTELY, SO SIMPLE ENOUGH TO THINK OF THEM AS JSON AND USER CAN PERSIST THEM IF THEY LIKE ***
- How many snapshots to keep? (Just one "last saved"? Multiple named snapshots?)
- Include in Git? (Probably NO - too much churn) *** NAH NOT FOR NOW, THIS IS EPHEMERAL *** 

**Recommendation:** ?

### Q6: **Case Weights Time Resolution**

**Scenario:** User retrieves live data on 2025-02-15, but case has different weights on 2025-02-01 vs 2025-02-15.

**Question:** When calculating "is experiment working?", which weights apply to which data?

**Options:**
- **A) Use weights at time of data retrieval** (simple, but might be wrong)
- **B) Store weight history with data** (complex, but accurate)
- **C) User specifies analysis date range** (flexible)

**Recommendation:** ?

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

**Recommendation:** ?

### Q8: **Parameter Type Coercion**

**Scenario:** Param is type `probability` but has values outside [0, 1].

**Options:**
- **A) Validation error:** Reject invalid data
- **B) Coerce:** Clamp to [0, 1]
- **C) Warning:** Allow but show warning

**Also:** What about `cost_gbp` with negative values? `cost_time` with negative values?

**Recommendation:** ?

### Q9: **Graph Field Mapping Conflicts**

**Scenario:** Edge has both:
- Direct values: `p.mean = 0.25`
- Parameter reference: `p.parameter_id = "checkout-conversion"`

**Which takes precedence when pushing to param file?**
- Use graph value? (0.25)
- Ignore graph value, keep param value?
- Merge somehow?

**Recommendation:** ?

### Q10: **Data Source Priority (Multiple Sources)**

**Scenario:** Parameter has:
- Manual baseline value
- Sheets-sourced value
- Amplitude-sourced value

**Which is "current"?**
- Latest by `window_from`? (YES - user's stated convention)
- Highest priority source type? (NO)
- User-selected "active" value? (TOO COMPLEX)

**Confirmation needed:** Latest by window_from, regardless of source type?

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

**Recommendation:** ?

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

**Recommendation:** ?

### Q13: **Stdev Calculation vs Storage**

**Scenario:** Amplitude returns n and k, we calculate stdev.

**Questions:**
- Store calculated stdev in param file? (YES - for consistency)
- Recalculate stdev on every load? (NO - expensive)
- What if user manually edits stdev? (Warn that it's inconsistent with n/k?)

**Recommendation:** Store calculated stdev, accept that it might diverge from n/k if manually edited

### Q14: **Distribution Type Inference**

**Scenario:** Retrieve data from Amplitude (binomial data: n, k)

**What distribution should we assign?**
- Always `beta` for probability? (Sensible Bayesian conjugate)
- Let user configure? (Complex)
- Infer from data? (How?)

**Recommendation:** ?

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
- Can we retrieve latest data? (NO - no source defined)
- Should we auto-create parameter? (Maybe?)
- Is this a valid state? (YES - for quick prototyping)

**Recommendation:** ?

### Q16: **Registry Index Staleness**

**Scenario:**
- User creates new parameter file: `parameters/probability/new-param.yaml`
- But doesn't update `registry.yaml`

**Result:** Parameter exists but not in registry index

**Options:**
- **A) Scan directory:** Find all param files, ignore index (slow but works)
- **B) Require index:** Error if not in index (strict but fragile)
- **C) Auto-update index:** On create, update index automatically (best?)

**Recommendation:** ?

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

**Recommendation:** ?

### Q18: **Amplitude Query Caching**

**Scenario:** User retrieves data from Amplitude for edge A. 5 minutes later, retrieves for edge B (same node pair).

**Should we:**
- Cache result for X minutes? (Faster, but might be stale)
- Always fetch fresh? (Slow, but accurate)
- User-configurable TTL? (Complex)

**Recommendation:** ?

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

**Recommendation:** ?

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

**Recommendation:** ?

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

# ADD: Status tracking (optional)
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

### 2. Node Schema Updates

```yaml
# ADD: event_id (optional, references events registry)
event_id:
  type: string
  pattern: ^[a-z0-9-]+$
  description: "Reference to event in events registry (for analytics integration)"
```

### 3. Event Schema (NEW)

```yaml
# Create: param-schemas/event-schema.yaml
$schema: http://json-schema.org/draft-07/schema#
title: Event Definition Schema

type: object
required: [id, name, metadata]

properties:
  id:
    type: string
    pattern: ^[a-z0-9-]+$
  
  name:
    type: string
  
  description:
    type: string
  
  amplitude:
    type: object
    properties:
      event_type:
        type: string
        description: "Amplitude event type string"
      event_properties:
        type: array
        items:
          type: object
          properties:
            name: { type: string }
            type: { type: string, enum: [string, number, boolean, date] }
            required: { type: boolean, default: false }
  
  metadata:
    # Standard metadata block
```

### 4. Graph Schema Updates

```yaml
# ADD: event_id to Node (optional)
Node:
  properties:
    event_id:
      type: string
      description: "Event reference for analytics integration"

# CONFIRM: NO n, k on edge.p (stays in params only)
```

### 5. Credentials Schema Updates

```yaml
# ADD: amplitude section
amplitude:
  type: object
  properties:
    apiKey:
      type: string
      format: password
    secretKey:
      type: string
      format: password

# ADD: googleSheets section
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
```

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

