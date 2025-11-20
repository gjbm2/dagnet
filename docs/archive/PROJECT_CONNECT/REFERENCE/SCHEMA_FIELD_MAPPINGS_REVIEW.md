# Schema Field Mappings Review

**Date:** 2025-11-05  
**Purpose:** Systematic review of `SCHEMA_FIELD_MAPPINGS.md` for semantic coherence, completeness, and redundancy

---

## Executive Summary

### Critical Findings

🚨 **MOST CRITICAL:** Missing direct external → graph mappings (no param file intermediary)
- `amplitude_to_edge` - Amplitude can populate edge directly
- `sheets_to_edge` - Sheets can populate edge directly  
- `statsig_to_case_node` - Statsig can populate case node directly
- **This is CORE to "flexible data location" principle**

🚨 **BLOCKER:** Several mappings reference fields that DON'T EXIST YET in current schemas (they're planned for Phase 0)

✅ **GOOD:** Overall mapping strategy is sound and semantically coherent

⚠️ **GAPS:** Missing mappings for cost/duration parameters, contexts, and graph→parameter creation flow

---

## Mapping-by-Mapping Review

### ✅ Mapping 1: Node Registry ↔ Graph Node

**Semantic Coherence:** Excellent
- `id` → `slug` makes sense (connection mechanism)
- `name` → `label` follows canonical → display pattern
- `description` → `description` straightforward
- `event_id` → `event_id` good

**Completeness:**
- ✅ All core fields mapped
- ⚠️ **MISSING:** What if node registry had `colour` or `icon` hints? (Future consideration)
- ⚠️ **MISSING:** What about node `category` or `tags` from registry?

**Current Schema Status:** ✅ All fields exist

**Trade-offs:**
- One-way flow (registry → graph) makes sense; graph is working copy
- No way to "push back" graph customizations to registry (intentional, correct)

---

### ⚠️ Mapping 2: Parameter File ↔ Graph Edge

**Semantic Coherence:** Good overall, but complex

**Completeness Issues:**

#### 🚨 MISSING: Cost & Duration Parameter Mappings
The mapping only covers `probability` type parameters. What about:

```yaml
# cost_gbp parameter
type: cost_gbp
values:
  - mean: 150.00    # Cost in GBP
    stdev: 25.00
    currency: GBP   # ← Not mapped!
```

```yaml
# cost_time parameter  
type: cost_time
values:
  - mean: 2.5       # Days
    stdev: 0.5
    units: d        # ← Not mapped!
```

**Action Required:**
- Add mappings for `edge.cost_gbp` and `edge.cost_time` parameters
- These should have similar structure to `edge.p` but without evidence (costs don't have n/k)

#### 🚨 MISSING: Conditional Probability Support
Document mentions `condition` field but doesn't map it:

```yaml
# In parameter file (PLANNED Phase 0)
condition:
  visited: [node-a, node-b]  # ← Not currently mapped to graph edge
```

**Action Required:**
- Add `parameter.condition` → `edge.condition` mapping
- Or clarify that conditions are stored ONLY in parameter file, not graph

#### 🚨 MISSING: Context-Specific Values
```yaml
values:
  - mean: 0.30
    context_id: device-mobile  # ← How does this map to graph edge?
  - mean: 0.35
    context_id: device-desktop
```

**Issue:** Mapping says `values[latest]` but what if there are multiple contexts? Which one do we pull?

**Action Required:**
- Define strategy: Do we pull ALL contexts or current context only?
- Add context resolution logic to mapping

#### 🚨 FIELDS DON'T EXIST YET
These fields are referenced in mapping but not in current parameter schema:
- `query` (planned Phase 0)
- `query_overridden` (planned Phase 0)
- `values[].n` (planned Phase 0)
- `values[].k` (planned Phase 0)
- `values[].window_to` (exists as `window_from` but no explicit end)

**Current Schema Status:** ❌ Many fields are Phase 0 additions

**Trade-offs:**
- `values[latest]` strategy: Simple but inflexible. What if user wants historical data?
- Bidirectional flow (pull/push): Good for flexibility but complex to manage
- `p` as primary, `n/k` as evidence: Correct decision (already made)

---

### ✅ Mapping 3: Case File ↔ Graph Case Node

**Semantic Coherence:** Excellent
- Structure (variant names) vs. data (weights) separation is clear
- `schedules[latest]` → variant weights makes sense

**Completeness:**
- ✅ All core fields mapped
- ⚠️ **MINOR:** What about case-level metadata (platform, experiment_id)? Should this flow to graph for display?

**Current Schema Status:** ✅ Structure exists (case-parameter-schema.yaml)

**Trade-offs:**
- `schedules[latest]` same issue as parameters - assumes most recent is always desired
- Variant weights override at graph level only (correct, already decided)

---

### ✅ Mapping 4: Event Registry ↔ Graph Node

**Semantic Coherence:** Good but indirect

**Completeness:**
- ✅ Cascade through node registry makes sense
- ⚠️ **FRAGILITY:** Two-hop mapping (Event → Node Registry → Graph Node) could break

**Current Schema Status:** ⚠️ Event registry schema doesn't exist yet (planned Phase 0)

**Trade-offs:**
- **PRO:** Maintains canonical event definitions
- **CON:** Indirection makes it harder to trace
- **CON:** What if node references event directly? (We don't allow this currently)

**Recommendation:** Keep indirect mapping but ensure clear documentation of cascade behavior

---

### ⚠️ Mapping 5: Amplitude → Parameter File

**Semantic Coherence:** Good for probability parameters

**Completeness Issues:**

#### 🚨 ONLY WORKS FOR PROBABILITY PARAMETERS
What about:
- Cost parameters from Amplitude revenue events?
- Duration parameters from time-to-conversion metrics?

**Issue:** Mapping assumes funnel conversion (n, k → p) but Amplitude can provide:
- Revenue data (for cost_gbp params)
- Duration metrics (for cost_time params)
- Counts without conversions (just n, no k)

**Action Required:**
- Add `amplitude_revenue_to_parameter` mapping for cost_gbp
- Add `amplitude_duration_to_parameter` mapping for cost_time
- Or generalize this mapping to handle all types

#### 🚨 FIELDS DON'T EXIST YET
- `values[].n` (planned Phase 0)
- `values[].k` (planned Phase 0)
- `values[].window_to` (planned Phase 0)
- `values[].data_source.query` (structure differs from current schema)

**Current Schema Status:** ❌ Requires Phase 0 schema updates

**Trade-offs:**
- APPEND strategy is good (audit trail) but could bloat files
- Automatic calculation of p from k/n is correct
- Binomial stdev calculation is appropriate

---

### ⚠️ Mapping 6: Google Sheets → Parameter File

**Semantic Coherence:** Questionable

**Completeness Issues:**

#### 🚨 FRAGILE NAMING CONVENTION
```yaml
Cell naming: checkout-conversion.mean
```

**Issues:**
- How do we discover which parameter to update?
- What if cell name doesn't match any parameter ID?
- What if user wants to update multiple parameters from one sheet?

**Action Required:**
- Define sheet structure more rigorously:
  - Option A: Header row with parameter IDs, rows with time windows
  - Option B: Named ranges that map to parameter IDs
  - Option C: Explicit mapping configuration in parameter file

#### 🚨 MISSING: Time Window Handling
Sheets mapping doesn't specify how `window_from`/`window_to` are determined

**Action Required:**
- Add column for time windows OR
- Use retrieval timestamp as window_from

#### 🚨 MISSING: Multi-Value Handling
What if sheet has historical data (multiple rows)? Do we import all or just latest?

**Recommendation:** Reconsider Google Sheets mapping design. Current approach seems fragile.

---

### ✅ Mapping 7: Statsig → Case File

**Semantic Coherence:** Excellent
- Transform allocation_percent → decimal weight is correct
- APPEND to schedules array makes sense
- Time windows (start_date, end_date) properly mapped

**Completeness:**
- ✅ All necessary fields mapped

**Current Schema Status:** ✅ Case schema supports this

**Trade-offs:**
- APPEND strategy good for audit trail
- Statsig as source of truth for live experiments (correct)

---

### ✅ Mapping 8: Graph Structure → Query (MSMDC)

**Semantic Coherence:** Good but this is different from other mappings

**Observations:**
- This is graph analysis → generation, not schema mapping
- Belongs in this document for completeness
- `query_overridden` flag properly respects user edits

**Completeness:**
- ✅ Covers both parameter.query and edge.query
- ⚠️ **MISSING:** What about case node queries? (Future)

**Current Schema Status:** ❌ `query` fields don't exist yet (Phase 0)

**Trade-offs:**
- Auto-generation is valuable but can be surprising to users
- Override mechanism handles this well

---

## Critical Missing Mappings

### 🚨 0. External Source → Graph DIRECTLY (No Parameter File)

**CRITICAL GAP:** Current mappings assume external data always goes through parameter files:
```
Amplitude → Parameter File → Graph Edge
```

**But we support direct connection:**
```
Amplitude → Graph Edge (no param file)
```

**This is core to "flexible data location" principle!**

**Need these mappings:**

#### Amplitude → Graph Edge (Direct)
```typescript
// Mapping: amplitude_to_edge_direct
Amplitude funnel result → edge.p = {
  p: k/n,                           // Calculated
  p_overridden: false,
  stdev: calculated,
  stdev_overridden: false,
  distribution: "beta",
  distribution_overridden: false,
  
  evidence: {                       // Store n/k as evidence
    n: 1000,
    k: 300,
    window_from: query.start_date,
    window_to: query.end_date,
    retrieved_at: now(),
    source: "amplitude",
    query: amplitudeQueryObject
  },
  
  // NO parameter_id (direct connection)
  data_source: {                    // Direct source metadata
    type: "amplitude",
    timestamp: now(),
    query: amplitudeQueryObject
  }
}
```

#### Google Sheets → Graph Edge (Direct)
```typescript
// Mapping: sheets_to_edge_direct
Sheet cell value → edge.p = {
  p: cell_value,
  p_overridden: false,
  
  // NO parameter_id (direct connection)
  data_source: {
    type: "sheets",
    url: sheet_url,
    range: cell_range,
    timestamp: now()
  }
}
```

#### Statsig → Graph Case Node (Direct)
```typescript
// Mapping: statsig_to_case_node_direct
Statsig experiment → case_node.case.variants = [
  {
    name: "control",
    weight: 0.5,
    weight_overridden: false,
    edges: [...]
  },
  {
    name: "treatment",
    weight: 0.5,
    weight_overridden: false,
    edges: [...]
  }
]

// NO case.id reference (direct connection)
case_node.data_source = {
  type: "statsig",
  experiment_id: "exp_123",
  timestamp: now()
}
```

**Why This Matters:**
1. **User Workflow:** User might connect edge directly to Amplitude without creating param file
2. **Simplicity:** Not every data point needs parameter file bureaucracy
3. **Flexibility:** Core principle of the system
4. **Rapid Prototyping:** Quick data connections for exploration

**Implementation in UpdateManager:**
```typescript
// Direct external → graph mappings (no param file intermediary)
this.registerMappings('amplitude_to_edge', [...]);
this.registerMappings('sheets_to_edge', [...]);
this.registerMappings('statsig_to_case_node', [...]);

// These are SEPARATE from:
// - amplitude_to_parameter (external → param file)
// - parameter_to_edge (param file → graph)
```

**UI Implications:**
In properties panel, user can choose:
- **Option A:** "Connect to Parameter" (uses param file)
- **Option B:** "Connect Directly to Source" (no param file)

**Data Source Indicator:**
```typescript
// How to tell which mode we're in:
if (edge.p.parameter_id) {
  // Connected via parameter file
  sourceIcon = "File";
  sourceLabel = parameter.name;
} else if (edge.p.data_source) {
  // Direct connection to external source
  sourceIcon = edge.p.data_source.type; // "amplitude" | "sheets"
  sourceLabel = edge.p.data_source.type;
} else {
  // Manual entry (no connection)
  sourceIcon = "Edit";
  sourceLabel = "Manual";
}
```

**Trade-off: Direct vs. Parameter File**

| Aspect | Direct Connection | Via Parameter File |
|--------|------------------|-------------------|
| **Setup** | Fast, immediate | Requires file creation |
| **Reusability** | Not reusable | Reusable across graphs |
| **History** | Lost if graph changes | Preserved in param file |
| **Auditability** | Graph-level only | File-level + graph-level |
| **Best for** | Exploration, prototyping | Production, shared params |

**Recommendation:** Support BOTH modes (already planned, just need mappings)

---

### 🚨 1. Cost Parameter Mappings (cost_gbp)

**Need:**
```typescript
// Parameter file
type: cost_gbp
values:
  - mean: 150.00
    stdev: 25.00
    currency: GBP
    
// Graph edge
edge.cost_gbp = {
  amount: 150.00,
  amount_overridden: false,
  stdev: 25.00,
  stdev_overridden: false,
  currency: "GBP",
  parameter_id: "email-campaign-cost"
}
```

**Mappings needed:**
- `parameter_to_edge` for cost_gbp
- `amplitude_revenue_to_parameter` for revenue events
- Override flags for amount, stdev, currency

---

### 🚨 2. Duration Parameter Mappings (cost_time)

**Need:**
```typescript
// Parameter file
type: cost_time
values:
  - mean: 2.5
    stdev: 0.5
    units: d    # days
    
// Graph edge
edge.cost_time = {
  duration: 2.5,
  duration_overridden: false,
  stdev: 0.5,
  stdev_overridden: false,
  units: "d",
  parameter_id: "checkout-duration"
}
```

**Mappings needed:**
- `parameter_to_edge` for cost_time
- `amplitude_duration_to_parameter` for time-based metrics

---

### 🚨 3. Context-Specific Parameter Values

**Issue:** Parameter can have multiple values with different `context_id`s. How do we map to graph?

**Options:**

**Option A:** Graph stores current context only
```typescript
edge.p = {
  p: 0.30,
  context_id: "device-mobile",  // Currently active context
  parameter_id: "conversion-rate"
}
```

**Option B:** Graph stores all contexts
```typescript
edge.p = {
  values: [
    { p: 0.30, context_id: "device-mobile" },
    { p: 0.35, context_id: "device-desktop" }
  ],
  active_context: "device-mobile",
  parameter_id: "conversion-rate"
}
```

**Option C:** Graph doesn't store contexts (parameter file only)
- Graph always pulls from parameter based on current simulation context
- Simpler but requires parameter file connection

**Recommendation:** Start with Option C (defer context complexity to later phase)

---

### 🚨 4. Graph → Parameter Creation Flow

**Missing:** When user creates parameter FROM graph edge, what gets mapped?

**Need:**
```typescript
// User creates edge with manual value
edge.p = { p: 0.30, stdev: 0.02 }

// User clicks "Create Parameter"
// → What gets written to parameter file?

parameter = {
  id: ?, // User provides
  name: edge.label,  // Copy from edge
  type: "probability",
  query: edge.query,  // Copy from edge (if exists)
  values: [{
    mean: edge.p.p,
    stdev: edge.p.stdev,
    window_from: new Date().toISOString(),
    data_source: { type: "manual" }
  }]
}
```

**Mapping needed:** `edge_to_parameter_create`

---

### 🚨 5. Conditional Probability Mappings

**Fields mentioned but not mapped:**
```yaml
# In parameter file (planned)
condition:
  visited: [node-a, node-b]
```

**Question:** Does this live on:
- Parameter file only? (query defines it)
- Graph edge? (for display/editing)
- Both? (sync between them)

**Action Required:** Decide and document mapping

---

## Schema Redundancy Analysis

### Query Field Duplication (Parameter vs. Edge)

**Current Design:** Both parameter and edge can have `query` field

**Is this redundant?**

**Analysis:**
- ✅ **NOT redundant** - This is intentional flexibility:
  - Parameter file: Canonical query (reusable across graphs)
  - Edge: Graph-specific query override
- If edge has parameter_id and no query, use parameter.query
- If edge has query, use edge.query (even if parameter connected)

**Conclusion:** Keep both. This is flexible data location principle.

---

### Description Duplication (Registry vs. Graph)

**Current Design:** Descriptions exist at multiple levels:
- Node registry: `description`
- Parameter registry: `description`
- Graph node: `description`
- Graph edge: `description`

**Is this redundant?**

**Analysis:**
- ✅ **NOT redundant** - Different purposes:
  - Registry: Canonical definition (what it is)
  - Graph: Contextual notes (how it's used in THIS graph)
- User might override for graph-specific context

**Conclusion:** Keep both. Override pattern handles divergence well.

---

### Data Source Duplication

**Issue:** `data_source` exists in multiple places:
- `parameter.metadata.data_source` (file level)
- `parameter.values[].data_source` (value level)

**Is this redundant?**

**Analysis:**
- ⚠️ **POTENTIALLY CONFUSING** - Two different purposes:
  - `metadata.data_source`: Where parameter is USUALLY sourced from
  - `values[].data_source`: Where THIS SPECIFIC value came from
- But: A parameter might be sourced from Amplitude, then have a manual override value

**Recommendation:** 
- Rename to clarify:
  - `metadata.default_source` or `metadata.refresh_config`
  - `values[].source` or `values[].provenance`

---

### Override Flags vs. Locked Flag

**Issue:** We have both:
- `{field}_overridden` - Disables auto-updates for this field
- `locked` - User explicitly locked entire entity

**Is this redundant?**

**Analysis:**
- ✅ **NOT redundant** - Different purposes:
  - `_overridden`: Tracks which specific fields user manually edited (automatic)
  - `locked`: User explicitly says "don't touch this at all" (manual flag)
- `locked` is UI-level protection, `_overridden` is field-level tracking

**Conclusion:** Keep both.

---

## Trade-offs & Concerns

### 1. [latest] Strategy for Time-Windowed Data

**Current:** Mappings use `values[latest]` and `schedules[latest]`

**Pros:**
- ✅ Simple to implement
- ✅ Most common use case (use current data)
- ✅ Clear default behavior

**Cons:**
- ❌ No way to pull historical data into graph
- ❌ No way to "pin" to specific time window
- ❌ Inflexible for historical analysis

**Recommendation:**
- Keep `[latest]` as default behavior
- Add optional `window_selector` field to edge/node for advanced use:
  ```typescript
  edge.p = {
    parameter_id: "conversion-rate",
    window_selector: "latest" | "2025-11" | { from: "...", to: "..." }
  }
  ```
- Phase 0: Use [latest] only
- Phase 3+: Add window selection

---

### 2. Append-Only Strategy for External Sources

**Current:** Amplitude, Sheets, Statsig all APPEND to arrays

**Pros:**
- ✅ Complete audit trail
- ✅ Historical data preserved
- ✅ Can compare over time

**Cons:**
- ❌ Files grow indefinitely
- ❌ No automatic cleanup
- ❌ Could bloat repository

**Recommendation:**
- Keep append-only for Phase 0-2
- Phase 3: Add archival/compression strategy:
  - Keep recent N values in main file
  - Move old values to `{param-id}.archive.yaml`
  - Or: Implement retention policy (keep 90 days)

---

### 3. One-Way vs. Bidirectional Mappings

**Current Mix:**
- Node Registry → Graph: One-way (pull only)
- Parameter ↔ Graph: Bidirectional (pull/push)
- Case → Graph: One-way (pull only)

**Concern:** Inconsistent pattern - could confuse users

**Analysis:**
- ✅ Actually **correct** - Different entities have different lifecycles:
  - Registries: Canonical sources (should not be auto-modified by graphs)
  - Parameters: Working data (should accept both manual and graph-sourced values)
  - Cases: Experiment definitions (should not be modified by graphs)

**Conclusion:** Inconsistency is intentional and correct

---

### 4. Google Sheets Mapping Fragility

**Concern:** Cell naming convention `{param-id}.{field}` is error-prone

**Issues:**
- No validation that param ID exists
- Typos will silently fail or create unexpected files
- No way to handle multi-parameter sheets efficiently

**Recommendation:**
- **Phase 0-1:** Skip Google Sheets integration (defer)
- **Phase 2+:** Design properly:
  - Explicit mapping config in parameter file
  - Sheet structure with header row
  - Validation before import

---

### 5. Event Registry Cascade (Two-Hop Mapping)

**Concern:** Event → Node Registry → Graph is indirect

**Pros:**
- ✅ Maintains canonical event definitions
- ✅ Node registry can enrich with graph-specific metadata
- ✅ Decouples event IDs from graph

**Cons:**
- ❌ More complex to maintain
- ❌ Harder to debug
- ❌ What if event registry changes but node registry doesn't update?

**Recommendation:**
- Keep cascade approach (benefits outweigh costs)
- Add explicit cascade documentation
- **Phase 0:** Create `syncEventsToNodes()` utility to propagate changes

---

## Validation Checklist Updates

Based on this review, update the validation checklist in `SCHEMA_FIELD_MAPPINGS.md`:

### Add to Field Name Consistency:
- [ ] Cost parameter fields (amount, currency) follow conventions
- [ ] Duration parameter fields (duration, units) follow conventions
- [ ] Context_id handling strategy documented

### Add to Data Structure Alignment:
- [ ] Edge.cost_gbp structure matches parameter cost_gbp values
- [ ] Edge.cost_time structure matches parameter cost_time values
- [ ] Context-specific value resolution strategy defined

### Add to Transformation Logic:
- [ ] Amplitude revenue → cost_gbp calculation defined
- [ ] Amplitude duration → cost_time calculation defined
- [ ] Multi-context value selection logic defined

### Add to No Orphaned Fields:
- [ ] All parameter types (probability, cost_gbp, cost_time) have mappings
- [ ] Conditional probability fields mapped or excluded with rationale
- [ ] Context-specific fields mapped or excluded with rationale

---

## Recommended Actions (Priority Order)

### 🔴 CRITICAL (Block Phase 0)

1. **Add direct external → graph mappings:**
   - `amplitude_to_edge` (direct, no param file)
   - `sheets_to_edge` (direct, no param file)  
   - `statsig_to_case_node` (direct, no case file)
   - Add `data_source` metadata field to edge schema
   - This is CORE to "flexible data location" principle

2. **Add missing fields to parameter schema:**
   - `query` (string)
   - `query_overridden` (boolean)
   - `values[].n` (integer)
   - `values[].k` (integer)
   - `values[].window_to` (datetime)

3. **Add cost_gbp and cost_time mappings:**
   - Define edge.cost_gbp structure
   - Define edge.cost_time structure
   - Add to UpdateManager mappings (both direct and via param file)

4. **Clarify [latest] strategy:**
   - Document that [latest] is Phase 0 behavior
   - Add note about future window selection

### 🟡 HIGH (Phase 0 or early Phase 1)

4. **Defer Google Sheets mapping:**
   - Remove from Phase 0 scope
   - Redesign in Phase 2 with proper structure

5. **Add graph → parameter creation flow:**
   - Define `edge_to_parameter_create` mapping
   - Add to UpdateManager

6. **Decide on conditional probabilities:**
   - Parameter file only? OR
   - Synced to graph edge?
   - Document decision

### 🟢 MEDIUM (Phase 2-3)

7. **Context-specific value handling:**
   - Choose Option A, B, or C from above
   - Implement mapping

8. **Data source field naming:**
   - Rename for clarity
   - Update schemas

9. **Historical data access:**
   - Add window_selector field
   - Update mappings

### 🔵 LOW (Phase 3+)

10. **Archival strategy for append-only data**
11. **Event registry cascade documentation**
12. **Multi-source parameter handling**

---

## Summary

### Overall Assessment: **GOOD with critical gaps**

✅ **Strengths:**
- Mapping strategy is semantically sound
- Override pattern is well thought out
- Bidirectional vs. one-way flows are appropriate
- Evidence structure (n/k in blob) is correct

⚠️ **Critical Gaps:**
- **MOST CRITICAL:** External → Graph direct mappings missing (core principle!)
- Cost and duration parameter mappings missing
- Several referenced fields don't exist yet in schemas
- Google Sheets mapping needs redesign
- Context-specific values need strategy

🚨 **Blockers for Phase 0:**
- Must add direct external → graph mappings (amplitude_to_edge, sheets_to_edge, statsig_to_case_node)
- Must add missing fields to parameter schema BEFORE implementing UpdateManager
- Must define cost/duration mappings BEFORE Phase 1
- Must add `data_source` field to graph edge schema

**Recommendation:** 
1. Add direct external → graph mappings to `SCHEMA_FIELD_MAPPINGS.md` (3 new mapping types)
2. Update graph schema to include `data_source` field on edges/nodes
3. Update `UpdateManager` to support 10 mapping types (not 7)
4. Then proceed with Phase 0 schema updates

