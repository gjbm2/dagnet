# Data Connections Schema Decisions

**⚠️ STATUS: SUPERSEDED - Use for historical context only**

**Companion to:** DATA_CONNECTIONS_SCHEMA_VALIDATION.md  
**Purpose:** Document key decisions and discussion points  
**Date:** 2025-11-04  
**Superseded By:** OVERRIDE_PATTERN_DESIGN.md, SCHEMA_MAPPING_COMPATIBILITY_REVIEW.md (2025-11-05)

---

## ⚠️ IMPORTANT: Conflicts with Current Design

**This document contains decisions from Nov 4 that were refined on Nov 5. Key conflicts:**

1. **p/n/k Storage:** This doc says `k` is derived from `p × n`. **CURRENT DESIGN:** `p.mean` is primary (user-editable), `n` and `k` are stored in `evidence` blob (observations, not derived).

2. **Override Pattern:** This doc doesn't mention override flags. **CURRENT DESIGN:** Comprehensive override pattern with `field_overridden` flags throughout all schemas.

3. **Evidence Structure:** Not mentioned here. **CURRENT DESIGN:** Evidence blob contains `{n, k, window_from, window_to, retrieved_at, source, query}`.

**For current design, see:**
- `PROJECT_CONNECT/CURRENT/OVERRIDE_PATTERN_DESIGN.md`
- `PROJECT_CONNECT/CURRENT/SCHEMA_MAPPING_COMPATIBILITY_REVIEW.md`
- `PROJECT_CONNECT/CURRENT/DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md`

---

**Related Documents:**
- [DATA_CONNECTIONS.md](./DATA_CONNECTIONS.md) — Main data connections specification
- [DATA_CONNECTIONS_SCHEMA_VALIDATION.md](./DATA_CONNECTIONS_SCHEMA_VALIDATION.md) — Schema design & validation
- [QUERY_EXPRESSION_SYSTEM.md](./QUERY_EXPRESSION_SYSTEM.md) — Query DSL, MSMDC algorithm, and UI

This document captures the detailed discussions and decisions made during schema validation. It serves as a reference for understanding "why" certain design choices were made.

---

## Core Schema Design Decisions

### 1. Unified ParamValue Base Type

**Decision:** Create shared `ParamValue` base type extended by `ProbabilityParam`, `MoneyParam`, and `DurationParam`.

**Key Features:**
- `parameter_id` lives INSIDE param objects (not at edge level)
- `n` (sample size) included, but NOT `k` (derivable: k = p × n)
- All param types share: mean, stdev, n, distribution, parameter_id, locked, data_source
- Type-specific constraints in extensions (bounds, distributions, units)

**Benefits:**
- DRY principle (define common fields once)
- Self-contained param objects
- Easy to add new param types
- Non-redundant storage (p + n, not p + n + k)

**Breaking Change:** Yes, but acceptable (system not in production yet)

---

### 2. Costs Can Be Negative (Revenue Events)

**Issue:** Original proposal had `minimum: 0` on cost mean values.

**Decision:** Remove minimum constraint. Allow negative costs.

**Rationale:**
- Revenue events = negative costs
- Refunds/discounts may also be negative
- Don't artificially constrain the domain

---

### 3. Duration Units: Flexible & Human-Readable

**Issue:** Original proposal forced decimal days with enum units.

**Decision:** Use freeform string units, accept human-readable formats.

**Rationale:**
- "2d", "5.5h", "30m" more intuitive than decimalized schemes
- Don't overspecify what doesn't need specification
- Parser can normalize as needed
- Users reading YAML files benefit from clarity

**Examples:**
```yaml
cost_time:
  mean: 2.5
  units: "d"  # or "days" or "2.5d" - flexible!
```

---

### 4. Event_ID on Graph Nodes (Not Just Registry)

**Question:** Should `event_id` be on graph nodes or only in node registry?

**Decision:** Allow `event_id` on graph nodes (optional).

**Rationale:**
- Nodes ≠ Events necessarily (relationship is contextual)
- Some events are graph-context specific
- Convenience for direct queries (avoid cascade lookup)
- Not mandatory (can cascade through registry when not present)

**User Commentary:**
> "I AM INCLINED TO ALLOW EVENT_ID ON GRAPH; TO SOME DEGREE NODES ARE NOT THE SAME AS EVENTS, AND IT IS SOMEWHAT CONTEXTUAL AS TO WHETHER AN EVENT IS ASSOCIATED STRICTLY WITH A CANONICAL NODE OR NOT. SO YES, I THINK EVENT_ID IS ALLOWED ON GRAPH, AND IN MANY CASES WE BRING IT THROUGH WHEN THE NODE IS CREATED, BUT NOT MANDATORILY. NB. I'M NOT 100% SURE ABOUT THIS."

**Follow-up:** Confirm this design choice during implementation.

---

## Data Retrieval & Storage

### 5. Stdev Calculation from n and k

**Question:** Line 324 - Where does stdev come from when retrieving from Amplitude?

**Answer:** Calculated from binomial formula.

**Formula:**
```typescript
const mean = k / n;
const stdev = Math.sqrt(mean * (1 - mean) / n);
```

**Storage:** Store calculated stdev in param file (don't recalculate every time).

**Edge Case:** If user manually edits stdev, it may diverge from n/k. That's acceptable (GIGO principle).

---

### 6. Distribution Type Assignment

**Question:** What distribution to assign when retrieving from Amplitude?

**Decision:** DON'T assign anything. Parameter already has distribution specified.

**User Commentary:**
> "YOU DON'T ASSIGN ANYTHING - JUST GET THE DATA, AND THE PARAM HAS THE DISTRUBITION ALREADY SPECIFIED ON IT; WHEN WE GET TO ANALYTICS RUNNER LATER WE MAY DO CLEVERER FITTING STUFF AND GUESS THE DISTRO, BUT THAT'S NOT FOR NOW"

**Implication:** Param schema has distribution field, data retrieval populates mean/stdev/n/k only.

---

### 7. Data Volume Analysis (Back-of-Packet)

**Question:** Line 425 - How much data are we talking about in a year?

**Assumptions:**
- 100 nodes
- 200 edges/parameters
- 365 days of daily data
- Uncompressed YAML

**Calculation:**

**Per Parameter Value Entry (~200 bytes):**
```yaml
- mean: 0.27
  stdev: 0.0044
  n: 10000
  k: 2700
  distribution: beta
  window_from: "2025-11-03T14:30:00Z"
  data_source:
    type: amplitude
    retrieved_at: "2025-11-03T14:30:00Z"
```

**Annual Storage:**
- 200 params × 365 days × 200 bytes = **14.6 MB/year** (uncompressed)
- With metadata, comments: ~**30 MB/year**
- Git with compression: ~**10-15 MB/year**

**5-Year Projection:** 50-75 MB (highly manageable)

**Conclusion:** File size is NOT a concern. All data easily fits in memory. Git clone is fast.

---

### 8. Naming Conventions for Param Packs (Google Sheets)

**Question:** Line 199 - How to unambiguously name parameters when delivering from Sheets?

**Proposed Convention** (inspired by dagCalc):
```
PARAM_ID.WINDOW(DATE).CONTEXT(CONTEXT_ID).FIELD

Examples:
- checkout-conversion.window(2025-11-03).context(device-mobile).mean
- checkout-conversion.context(device-mobile).n
- checkout-conversion.mean  (base value, no window/context)
```

**Flexible Parsing:** Order doesn't matter
```
PARAM_ID.window(date).context(ctx).mean
= PARAM_ID.context(ctx).window(date).mean
```

**Sheet Layout Options:**

**Option A: Alternating Columns**
```
| Element | Value | Element | Value |
|---------|-------|---------|-------|
| checkout-conversion.mean | 0.27 | checkout-conversion.n | 10000 |
```

**Option B: Header Row + Value Row**
```
| checkout-conversion.mean | checkout-conversion.stdev | checkout-conversion.n |
|--------------------------|---------------------------|------------------------|
| 0.27                     | 0.0044                    | 10000                  |
```

**Option C: Vertical (Element/Value pairs)**
```
| Element                       | Value  |
|------------------------------|--------|
| checkout-conversion.mean      | 0.27   |
| checkout-conversion.stdev     | 0.0044 |
| checkout-conversion.n         | 10000  |
```

**Recommendation:** Option B (header + values) most familiar to analysts.

**Transformation:** Client-side (in Sheet) if needed, or parser handles various layouts.

---

## Schema Complexities & Open Issues

### 9. Conditional Probabilities in Parameters

**Major Issue (Line 994):** How to encode visited node conditions in param files?

**Problem:**
```json
// Graph has conditional_p with visited condition
{
  "conditional_p": [{
    "condition": { "visited": ["node-a", "node-b"] },
    "p": {
      "mean": 0.35,
      "parameter_id": "conversion-after-visit-a-b"
    }
  }]
}
```

**But parameter file needs the condition to query Amplitude correctly:**
```yaml
# How do we know this is conditional on visited:[node-a, node-b]?
id: conversion-after-visit-a-b
type: probability
values:
  - mean: 0.35
    n: 1200
    k: 420
    # WHERE DOES visited:[node-a, node-b] GO?
```

**Options:**

**A) Reference to graph (risky, circular?):**
```yaml
id: conversion-after-visit-a-b
applies_to:
  - graph: onboarding-flow
    edge: edge-checkout-to-purchase
    condition:
      visited: [node-a, node-b]
```

**B) Encode conditionality in parameter itself:**
```yaml
id: conversion-after-visit-a-b
type: probability
condition:  # New field
  visited: [node-a, node-b]
values:
  - mean: 0.35
    n: 1200
    k: 420
```

**C) In data_source.query:**
```yaml
values:
  - mean: 0.35
    data_source:
      type: amplitude
      query:
        from_event: checkout_started
        to_event: purchase_completed
        condition:  # Amplitude-specific
          visited_events: [event-a, event-b]
```

**User Commentary:**
> "AHH. THIS IS A PROBLEM. GOOD CATCH. WE HAVE THIS ON THE GRAPH, OF COURSE, AS IT'S INCORPORATED INTO THE EDGE CONDITIONAL P STRCUTURE, BUT WE DON'T HAVE IT IN THE PARAM ITSELF--BUT WE WILL NEED IT AS ELSE YOU CAN'T GET DATA INTO THE PARAM RELIABLY AS E.G. THE AMPLITUDE QUERY TO RETRIEVE A CONDITIONAL P ISN'T THE SAME; IT MUST LOOK ONLY AT EVENT CHAINS WHICH PASS THROUGH THE VISITED NODES LIST. SO WE NEED TO ENCODE INTO PARAM _EITHER_ A REFERENCE TO THE GRAPH IN WHICH ITS CONDITIONALITY WAS EXPRESED [RISKY, ?CIRCULAR], *OR* TO ALLOW INTO PARAMS SCHEMA A WAY TO EXPRESS CONDITIONALITY _AND_ ENSURE THAT THIS IS REFLECTED IN THE CONDITIONAL PROBATILTIEIS PANEL IN THE GRAPH EDITOR. TRICKY. PROPOSE OPTIONS PLEASE"

**Recommendation:** **Option B + Graph Editor Integration**

Add `condition` field to parameter schema:
```yaml
# parameter-schema.yaml
properties:
  condition:
    type: object
    description: "Conditional context for this parameter (for conditional probabilities)"
    properties:
      visited:
        type: array
        items: { type: string }
        description: "Node IDs that must be visited"
      # Future: all_of, any_of, none_of
```

**Graph Editor Sync:**
- When creating conditional_p, prompt user to create/link parameter
- Pre-populate condition in parameter from graph
- Show condition in conditional probabilities panel
- Warn if graph condition ≠ param condition

**Amplitude Query:**
- Use param.condition.visited to construct proper query
- Query event sequences that pass through visited nodes
- More complex Markov chain queries

**Trade-offs:**
- ✅ Parameter is self-contained (has condition info)
- ✅ Can query data source without graph context
- ✅ Clear semantics
- ⚠️ Duplication between graph and param (but manageable)
- ⚠️ Need to keep them in sync (UI responsibility)

---

### 10. Data Source Configuration & Connections Registry

**Question (Line 928, 1081):** Where do we define connection configurations?

**Problem:** Beyond credentials, we need:
- Standard query parameters for each connector
- Connection metadata (base URLs, API versions, etc.)
- Query templates
- Field mappings

**Current State:**
- **Credentials:** In IndexedDB via `credentials.yaml` (secure, user-specific) ✓
- **Connections:** Nowhere yet!

**Example Amplitude Connection Config:**
```yaml
# Where does this live?
connections:
  amplitude:
    base_url: "https://amplitude.com/api/2"
    api_version: "2"
    rate_limit: "1req/sec"  # or paid tier limits
    query_defaults:
      time_range: "30d"
      include_segments: true
    field_mappings:
      event_type: "event_type"  # Their field name
```

**Options:**

**A) In Code (graph-editor repo):**
```typescript
// src/connectors/amplitude/config.ts
export const AMPLITUDE_CONFIG = {
  baseUrl: "https://amplitude.com/api/2",
  apiVersion: "2",
  // ...
};
```
- ✅ Version controlled with code
- ✅ Simple for developers
- ❌ Requires code changes to update
- ❌ Can't customize per-deployment

**B) In Param Registry (alongside params):**
```
param-registry/
├── connections/
│   ├── amplitude.yaml
│   ├── google-sheets.yaml
│   └── snowflake.yaml
```
- ✅ User-editable
- ✅ Git versioned
- ✅ Per-project customization
- ⚠️ Not sensitive (unlike credentials)
- ⚠️ Adds another file type

**C) In System Config (environment variables):**
```env
AMPLITUDE_BASE_URL=https://amplitude.com/api/2
AMPLITUDE_API_VERSION=2
```
- ✅ Deployment-specific
- ❌ Not version controlled
- ❌ Hard to manage many settings

**D) Hybrid: Code defaults + Optional overrides in param registry:**
```typescript
// Code has sensible defaults
const DEFAULT_CONFIG = { ... };

// Can be overridden by param-registry/connections/amplitude.yaml
const config = await loadConnectionConfig('amplitude') ?? DEFAULT_CONFIG;
```
- ✅ Works out of box (code defaults)
- ✅ Customizable when needed
- ✅ Clean separation

**User Commentary:**
> "WE PROBABLY NEED A CONENCTIONS REGISTRY IN FACT TO ALLOW OCCASIONAL USER MAINTENACNE, BUT WONDERING IF WE CAN DO WITHOUT YET ANOTHER CLASS IN OUR ONTOLOGY....WE HAVE CREDS WHICH ARE PERSISTED IN IBD [WHICH IS RIGHT], BUT CONNECTIONS CAN BE SYSTEM WIDE, AND AREN'T SENSITIVE, SO I'M LESS FUSSED ABOUT THAT....SO IT MAY BE WE CAN PERSIST IN CODE BUT ...WHERE? IN THIS REPO OR IN THE PARAMS REPO ? HMMM.... PROPOSE OPTIONS"

**Recommendation:** **Option D (Hybrid)** for now, **Option B (Connections Registry)** later

**Phase 1:** Hard-code connection configs in connector classes (simple, works immediately)

**Phase 2+:** Add connections registry when needed:
- File type: `connection` (like parameter, case, event)
- Location: `param-registry/connections/`
- Schema: `connection-schema.yaml`
- Navigator shows connections
- Edit with FormEditor

**Not urgent** - Can start with code and migrate later.

---

### 11. Time Windows: window_from vs. window_to

**Question (Line 838):** Do we need both window_from AND window_to, or is window_from sufficient?

**User Commentary:**
> "DO WE ACTUALLY NEED BOTH FROM & TO? I'M UNCLEAR WHETHER 'FROM' SUFFICES?"

**Analysis:**

**Case 1: No window_to (open-ended)**
```yaml
values:
  - mean: 0.27
    window_from: "2025-11-01T00:00:00Z"
    # Applies: 2025-11-01 → present
```
✅ Works for "latest value"

**Case 2: Explicit range**
```yaml
values:
  - mean: 0.25
    window_from: "2025-01-01T00:00:00Z"
    window_to: "2025-01-31T23:59:59Z"
    # Applies: Jan 2025 only
  
  - mean: 0.27
    window_from: "2025-02-01T00:00:00Z"
    # Applies: Feb 2025 → present
```
✅ Useful for historical archiving

**Case 3: Latency Analysis** (User's concern, Line 640)
> "WINDOWED PARAM VALUES ARE ESSENTIAL WHEN WE [LATER] WANT TO SEE LATENCY ANALYSIS ON GRAPH EVENTS. SOME GRAPHS TAKE ~45 DAYS TO COMPLETE. WE WILL WANT TO ASK QUESTIONS SUCH AS 'HOW NEARLY MATURE IS THIS?', 'WHAT WILL IT LOOK LIKE WHEN IT MATURES?', 'IF WE HAD X OF THESE TODAY, WAS THAT WHAT WE EXPECTED?'"

For latency analysis, need to convolve params over time:
- User started journey on 2025-01-15
- Graph takes 45 days to complete
- Need params as they were during Jan-Feb 2025
- `window_to` helps identify "what param applied when"

**Recommendation:** **Yes, include window_to (optional)**

**Semantics:**
- **No window_to:** Applies from window_from onward (until superseded)
- **With window_to:** Applies only in [window_from, window_to] range
- **Selection:** Latest by window_from that matches query time

**Use Cases:**
- Latest values: Omit window_to
- Historical archiving: Include window_to
- Latency convolution: Need explicit ranges

---

### 12. Multi-Dimensional Context Filtering

**Question (Line 958):** Cartesian product of contexts?

**Example:**
```yaml
# Can we do this?
values:
  - mean: 0.28
    contexts:  # Multiple dimensions
      device: mobile
      utm_source: google
      user_segment: premium
```

**User Commentary:**
> "NOPE, CARTESIAN PRODUCT IS ABSOLUTELY POSSIBLE & QUITE PERMISSABLE"

**Decision:** YES, support multi-dimensional contexts.

**Schema Update:**
```yaml
# Current (single context_id)
values:
  - mean: 0.23
    context_id: "device-mobile"

# Enhanced (multi-dimensional)
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
```typescript
function matchesContexts(value: ParameterValue, activeContexts: Record<string, string>): boolean {
  if (!value.context_filters) return true;  // Base value
  
  // All specified contexts must match
  for (const [dim, val] of Object.entries(value.context_filters)) {
    if (activeContexts[dim] !== val) return false;
  }
  return true;
}
```

**Priority:** More specific (more dimensions) matches win over less specific.

**Phase:** Include in schema now, implement matching later (contexts system coming soon).

---

### 13. Parameter Without Registry Entry

**Question (Line 439, 1053):** What if param_id references non-existent parameter?

**User Commentary (Line 439):**
> "I DON'T UNDERSTAND...THE PARAM MAY NOT 'EXIST' IN THE REGISTRY OR IN A FILE; THAT IS POSSIBLE. IN THAT CASE IT LIVES ON THE GRAPH WHERE THE USER DEFINED IT, AND IT WON'T UPDATE BECAUSE THERE'S NO ASSOCIATED SOURCE... WHAT AM I MISSING?"

**Clarification:** You're right. Valid states:

**State 1: Edge with param_id, param file exists**
```json
{ "p": { "mean": 0.27, "parameter_id": "checkout-conversion" } }
```
✅ Can retrieve data (file has data_source config)

**State 2: Edge with param_id, no param file**
```json
{ "p": { "mean": 0.27, "parameter_id": "foo" } }
```
✅ Valid! Param_id is just a label/reference
⚠️ Can't retrieve data (no file with data_source)
💡 UI shows warning: "Parameter 'foo' not found - create to enable data retrieval"

**State 3: Edge without param_id**
```json
{ "p": { "mean": 0.27 } }
```
✅ Valid! Manual/prototype values
⚠️ Can't retrieve data (no param file reference)
💡 Can still do direct retrieval (if nodes have event_ids)

**Decision:** All states valid. No auto-creation. Graph editor responsibility.

**User Commentary (Line 1053):**
> "THIS IS A DIFFERENT ISSUE. IN GENERAL USER UPDATES WILL BE THROUGH THE APP, AND APP SHOULD HAVE ROBUST CRUD PATHWAYS TO ENSURE INDEX IS SYNC. WE WILL LATER NEED A REINDEX FUNCTION -- NOT URGENT THOUGH. IN TERMS HOW WE COPE? PARAM WINS, THEN INDEX -- UNLESS USER IS RETRIEVING DIRECTLY TO GRAPH IN WHICH CASE GRAPH WINS, THEN PARAM, THEN INDEX."

**Precedence:**
1. Graph values (if direct retrieval or manual edit)
2. Param file (if exists and referenced)
3. Index (for listing/autocomplete)

**Reindex function:** Phase 2+

---

### 14. Validation Strategy

**Question (Line 899):** How strictly to validate param values?

**Example:** Probability param with mean = 1.5 (invalid!)

**User Commentary:**
> "MAY HAPPEN; WE SHOULD HANDLE AS GRACEFULLY AS POSSIBLE AND DISCOURAGE INVALID DATA THROUGH GUI BUT RECOGNISE THAT USER CAN DO WHATEVER THEY WANT IN YAML, AND SO IT GOES -- WE WILL LET MONACO WARN, BUT NOT ENFORCE"

**Strategy:**
- **Monaco Editor:** Show warnings (schema validation)
- **Data Loader:** Accept invalid data (graceful degradation)
- **Runner:** Validate strictly, error on invalid data
- **UI:** Show validation warnings, don't block

**Fail Gracefully Principle:** System works even with weird data, but warns user.

---

### 15. Snapshots

**Questions (Line 629, 845-848):** How to handle snapshots?

**User Commentary:**
> "AT PRESENT, I'M IMAGINGING THEY'RE EPHEMERAL -- FOR NOW AT LEAST"
> "THIS IS IN MEMORY FEATURE INITIALLY... BUT YES, THEY'RE JUST PARAMETER PACKS ULTIAMTELY, SO SIMPLE ENOUGH TO THINK OF THEM AS JSON AND USER CAN PERSIST THEM IF THEY LIKE"

**Decision:** Ephemeral in-memory feature (Phase 1), optional persistence later.

**Format:** Just parameter packs (JSON)
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

**User can:**
- Create snapshot (save current state)
- Compare snapshot vs current (visual diff)
- Optionally save to file (manual action)
- Not persisted to Git by default

---

### 16. Case Weights & Time Resolution

**Question (Line 863):** When analyzing experiments, which case weights apply to which data?

**User Commentary:**
> "NAIVE PATHWAY IS 'GET LATEST' AND THIS IS DEFAULT. HOWEVER WE WILL LATER ALLOW 'AS AT TIME' FEATURE IN GUI WHICH THEN RETRIEVES THIS [AND ANY OTHER PARAM] AS WAS AT THAT TIME. ALSO NOTE LATENCY CALCS WHEN WE CONVOLVE GRAPH WITH LAG DATA [TIME+COST] WILL HAVE TO RETREIVE HISTORY VALUES AND CONVOLVE ACROSS THAT LAG DISTRIBUTION. NB I DO NOT UNDERSTAND YOUR OPTION B"

**Decision:** Two modes

**Mode 1: Get Latest (default, naive)**
- Retrieve current case weights
- Retrieve current param values
- Simple, fast

**Mode 2: As-At-Time (future, sophisticated)**
- User specifies analysis date (e.g., "2025-02-15")
- System retrieves case weights as they were on that date
- System retrieves param values as they were on that date
- Enables historical "what actually happened" analysis

**Mode 3: Latency Convolution (future, complex)**
- User started journey on day T
- Journey takes D days (distributed: time_cost params)
- For each day T+d, use params as they were on that day
- Convolve distributions across time

**Phase 1:** Mode 1 only (get latest)
**Phase 2+:** Modes 2 & 3

---

### 17. Graph Metadata for Provenance

**Question (Line 1131):** Add data provenance to graph metadata?

**User Commentary:**
> "NO HARM IN STICKING THIS INTO THE GRAPH METADATA -- QUITE A GOOD IDEA. WONDERING WHETHER WE SHOULD HAVE OPTIONAL TIMESTAMPS ON EACH PARAM ON THE GRAPH ACTUALLY COME TO THINK OF IT, EVEN IF IT'S NOT EXPOSED IN THE UI... NO HARM? THEN WE JUST UPDATE THOSE WHEN WE PULL DATA. ADD THIS TO THE SCOPE OF GRAPH SCHEMA UDPATES"

**Decision:** YES - Add to graph metadata AND param objects

**Graph Metadata:**
```json
{
  "metadata": {
    "version": "1.0.0",
    "created_at": "2025-01-01T00:00:00Z",
    "updated_at": "2025-11-03T14:30:00Z",
    "last_data_retrieval": "2025-11-03T14:30:00Z",
    "data_sources_used": ["amplitude", "sheets"],
    "parameters_updated": 47
  }
}
```

**Per-Param Metadata on Graph:**
```json
{
  "p": {
    "mean": 0.27,
    "stdev": 0.0044,
    "n": 10000,
    "parameter_id": "checkout-conversion",
    "retrieved_at": "2025-11-03T14:30:00Z",  // NEW
    "data_source": {
      "type": "amplitude",
      "direct": false
    }
  }
}
```

**Benefits:**
- Know when graph was last refreshed
- Per-param timestamps (even if not shown in UI)
- Provenance tracking
- "Stale data" indicators

---

## Batch Operations & Performance

### 18. Batch Optimization & Caching

**Question (Line 884, 1092):** Caching strategy for batch operations?

**User Commentary:**
> "WE WILL DESIGN BATCH LOGICS & CACHING LATER ; NOTE AS OPEN ISSUE FOR PHASE 2+"
> "NOT YET"

**Decision:** Phase 2+ concern. Note for later.

**Considerations for Phase 2:**
- Cache node→event lookups during batch operations
- Deduplicate Amplitude queries (same node pairs)
- Respect rate limits with queuing
- Batch optimizations per connector

---

### 19. Error State Persistence & Logging

**Question (Line 1112):** Track error states in param files?

**User Commentary:**
> "SURE. BUT WE'LL RETURN TO LOGGING WHEN WE GET TO BATCH OPS"

**Decision:** Add status field to param schema (optional), implement in Phase 2.

```yaml
# parameter-schema.yaml
status:
  type: object
  properties:
    state: { enum: [fresh, stale, error] }
    last_successful_retrieve: { format: date-time }
    last_error: { type: string }
    last_attempt: { format: date-time }
```

**Phase 1:** Basic retrieval, no error tracking
**Phase 2:** Full logging, status indicators, retry logic

---

## Miscellaneous Decisions

### 20. Edge with Both Direct Value AND param_id

**Question (Line 912):** Which takes precedence when pushing to param?

**User Commentary:**
> "THIS QUESTIONS BETRAYS A LACK OF UNDERSTANDING. EDGES WILL ALMOST ALWAYS HAVE BOTH A DIRECT VALUE AND A PARAM ID; THAT'S BY DESIGN. BUT THE OPERATION YOU'RE ENVISAGING IS BY DEFINITION PUSHING FROM GRAPH TO FILE [WHICH IS THE FILE REFERREDNCE BY THE PARAM_ID]. SO RETHINK YOUR QUESTION AS IT'S INCOHERENT"

**Clarification:** Question was indeed incoherent. Correct understanding:

- Edges **always** have direct values (mean, stdev, etc.)
- Edges **optionally** have parameter_id (reference to param file)
- **Push operation** (graph → param) by definition updates the file referenced by parameter_id
- **No conflict** - the operation itself defines the direction

**Apology:** Question showed misunderstanding of data flow.

---

### 21. Context Selection in UI

**Question (Line 747, 756):** How does user select active contexts?

**User Commentary:**
> "USING THE CONTEXTS_ID CLASS, WHICH ISN'T YET INTEGRATED INTO THE EDITOR, BUT WILL BE LATER; WE WILL ADD 'SET_CONTEXT' ON NODES AND ALLOW A MY-EDGE.CONTEXT(CONTEXT_ID).P.MEANS LATER ON TOO."
> "DON'T FOLLOW. CONTEXTS ARE DEFINED IN <CONTEXTS>"

**Clarification:**
- Contexts defined in `contexts.yaml`
- UI for context selection coming later
- SET_CONTEXT on nodes future feature
- Edge-level context overrides possible

**Phase 1:** Basic context support in schema
**Phase 2+:** Full context UI integration

---

### 22. Data Sources Per Parameter

**Question (Line 928):** Can parameter have multiple data sources?

**User Commentary:**
> "DON'T KNOW THAT THIS IS HOW OUR SCHEMA FOR PARAMS IS ACTUALLY BUILT? I THINK WE MAY ONLY ALLOW ONE DATA SOURCE PER PARAM, NO? THAT WOULD BE SIMPLEST."

**Clarification Needed:** Check current param schema.

**Current Schema:** Each value entry can have its own data_source (per-window data sources).

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

**This is actually GOOD** - different windows can come from different sources.

**metadata.data_source** indicates "primary" source for ongoing updates.

**Decision:** Keep current design (per-value data sources).

---

### 23. Statsig Integration for Cases

**Question (Line 633, 637):** How to handle case weights from Statsig?

**User Commentary:**
> "WHY NOT?" (Same pattern as Amplitude)
> "SAME AS ABOVE -- IT LIVES ON GRAPH, BECAUSE IT DOES SO THE USER CAN PLAY WITH THE GRAPH. IN PRACTICE IF USER RETRIEVES IT FROM LIVE DATA [STATSIG, WHATEVER] AND THEN PULLS IT INTO THE GRAPH, THEN THE GRAPH WILL HAVE THE LATEST ACTUAL VALUE; USER CAN THEN WHAT IF FROM THERE IF THEY LIKE"

**Decision:** Yes, same pattern as Amplitude.

**Data Flow:**
1. Statsig API → Case File (schedules[] with time windows)
2. Case File → Graph Case Node (variant weights)
3. User can what-if from there

**Statsig Connector:** Phase 2+ (after Amplitude pattern proven)

---

## Summary of Key Decisions

1. ✅ Unified `ParamValue` base type with n (not k)
2. ✅ `parameter_id` inside param objects (not edge-level)
3. ✅ Costs can be negative (revenue events)
4. ✅ Flexible duration units ("2d", "5.5h", etc.)
5. ✅ `event_id` on graph nodes (optional)
6. ✅ Add `window_to` (optional, for explicit ranges)
7. ✅ Multi-dimensional context support
8. ✅ Add `condition` field to params (for conditional probabilities)
9. ✅ Connections registry later (Phase 2+), hard-code configs initially
10. ✅ Graph metadata includes provenance (last_data_retrieval, etc.)
11. ✅ Param objects on graph include timestamps (retrieved_at)
12. ✅ Snapshots ephemeral (Phase 1), optional persistence later
13. ✅ Validation graceful (Monaco warns, don't block)
14. ✅ All parameter states valid (with/without files, with/without param_id)

---

**Next:** Update main validation document with clean schema proposals incorporating these decisions.


