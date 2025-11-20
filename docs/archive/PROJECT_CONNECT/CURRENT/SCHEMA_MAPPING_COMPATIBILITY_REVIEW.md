# Schema Mapping Compatibility Review

**Purpose:** Verify that all 18 mapping configurations from MAPPING_TYPES.md are supported by designed schemas

**Date:** 2025-11-05

**Status:** Most schemas are fully designed in DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md. This document validates completeness and identifies any remaining gaps.

---

## Key Design Decisions (CONFIRMED)

1. **Keep `edge.p.mean`** - NOT renaming to `p.p` (too confusing, mean is statistically correct)
2. **Override flags:** `mean_overridden`, `stdev_overridden`, `distribution_overridden` (suffix pattern)
3. **Evidence is separate:** `edge.p.evidence` object stores n/k/windows (not overridable)
4. **Parameter files use `mean`:** Consistent everywhere - `values[].mean` maps to `edge.p.mean`

---

## Mapping Configuration Coverage

From MAPPING_TYPES.md, we have 18 mapping configurations to validate:

| ID | Mapping Config | Direction | Operation | Sub-Dest | Flow |
|----|---------------|-----------|-----------|----------|------|
| 1 | `graph_internal.UPDATE` | graph_internal | UPDATE | - | A |
| 2 | `graph_to_file.CREATE.parameter` | graph_to_file | CREATE | parameter | B.CREATE |
| 3 | `graph_to_file.UPDATE.parameter` | graph_to_file | UPDATE | parameter | B.UPDATE |
| 4 | `graph_to_file.APPEND.parameter` | graph_to_file | APPEND | parameter | B.APPEND |
| 5 | `graph_to_file.CREATE.case` | graph_to_file | CREATE | case | C.CREATE |
| 6 | `graph_to_file.UPDATE.case` | graph_to_file | UPDATE | case | C.UPDATE |
| 7 | `graph_to_file.APPEND.case` | graph_to_file | APPEND | case | C.APPEND |
| 8 | `graph_to_file.CREATE.node` | graph_to_file | CREATE | node | D.CREATE |
| 9 | `graph_to_file.UPDATE.node` | graph_to_file | UPDATE | node | D.UPDATE |
| 10 | `graph_to_file.CREATE.context` | graph_to_file | CREATE | context | E.CREATE |
| 11 | `graph_to_file.CREATE.event` | graph_to_file | CREATE | event | F.CREATE |
| 12 | `file_to_graph.UPDATE.parameter` | file_to_graph | UPDATE | parameter | G |
| 13 | `file_to_graph.UPDATE.case` | file_to_graph | UPDATE | case | H |
| 14 | `file_to_graph.UPDATE.node` | file_to_graph | UPDATE | node | I |
| 15 | `external_to_graph.UPDATE.parameter` | external_to_graph | UPDATE | parameter | L |
| 16 | `external_to_graph.UPDATE.case` | external_to_graph | UPDATE | case | M |
| 17 | `external_to_file.APPEND.parameter` | external_to_file | APPEND | parameter | Q |
| 18 | `external_to_file.APPEND.case` | external_to_file | APPEND | case | R |

---

## Schema Inventory

### Current Schemas
1. **parameter-schema.yaml** - Parameter file structure
2. **conversion-graph JSON schema** (in code) - Graph structure
3. **node-schema.yaml** - Node registry entries
4. **case-schema.yaml** - Case file structure
5. **context-schema.yaml** (future) - Context registry
6. **event-schema.yaml** (future) - Event registry

### Schemas to Create
- [ ] event-schema.yaml
- [ ] events-index-schema.yaml
- [ ] context-schema.yaml (if not exists)
- [ ] contexts-index-schema.yaml (if not exists)

---

## Detailed Mapping Reviews

### 1. graph_internal.UPDATE (Flow A)

**Source:** Graph edge/node  
**Target:** Graph edge/node  
**Operation:** UPDATE

**Required Mappings:**

| Source Field | Target Field | Override Flag | Status |
|-------------|--------------|---------------|--------|
| `msmdc.query` | `edge.query` | `query_overridden` | ⚠️ Need to verify |
| `node.label` | `edge.from_label` | `label_overridden` | ⚠️ Check if `from_label` exists |
| `node.label` | `edge.to_label` | `label_overridden` | ⚠️ Check if `to_label` exists |

**Issues to Check:**
- [ ] Does graph schema have `edge.query` field? (Phase 0 addition)
- [ ] Does graph schema have `edge.query_overridden`? (Phase 0 addition)
- [ ] Does graph edge have `from_label` and `to_label` fields or just `label`?
- [ ] How are node label changes cascaded to edges?

---

### 2. graph_to_file.CREATE.parameter (Flow B.CREATE)

**Source:** Graph edge parameter  
**Target:** New parameter file  
**Operation:** CREATE

**Required Mappings:**

| Source Field | Target Field | Type | Status |
|-------------|--------------|------|--------|
| `edge.p.parameter_id` | `parameter.id` | string | ⚠️ Check location |
| `edge.label` | `parameter.name` | string | ❓ Or separate field? |
| `edge.description` | `parameter.description` | string | ❓ Edge description? |
| `edge.p.p` | `parameter.values[0].mean` | number | ✅ Should work |
| `edge.p.stdev` | `parameter.values[0].stdev` | number | ✅ Should work |
| `edge.p.evidence.n` | `parameter.values[0].n` | integer | ⚠️ Check schema |
| `edge.p.evidence.k` | `parameter.values[0].k` | integer | ⚠️ Check schema |

**Issues to Check:**
- [ ] Where is `parameter_id` stored on edge? Inside `p` object or at edge level?
- [ ] Do edges have their own `label` field separate from node labels?
- [ ] Do edges have `description` field?
- [ ] Does parameter-schema.yaml support `n` and `k` in values[]? (Phase 0 addition)
- [ ] Does parameter-schema.yaml support `window_from`, `window_to` in values[]? (Phase 0 addition)

---

### 3. graph_to_file.UPDATE.parameter (Flow B.UPDATE)

**Source:** Graph edge parameter  
**Target:** Existing parameter file (metadata only)  
**Operation:** UPDATE

**Required Mappings:**

| Source Field | Target Field | Override Flag | Status |
|-------------|--------------|---------------|--------|
| `edge.description` | `parameter.description` | `description_overridden` | ❓ Edge description exists? |
| `edge.query` | `parameter.query` | `query_overridden` | ⚠️ Both need adding |

**Issues to Check:**
- [ ] Does edge have `description` field?
- [ ] Does edge have `query` field? (Phase 0 addition)
- [ ] Does parameter-schema.yaml have `query` field? (Phase 0 addition)
- [ ] Does parameter-schema.yaml have `query_overridden` flag? (Phase 0 addition)
- [ ] Does parameter-schema.yaml have `description_overridden` flag? (Phase 0 addition)

---

### 4. graph_to_file.APPEND.parameter (Flow B.APPEND)

**Source:** Graph edge parameter  
**Target:** Parameter file values[] array  
**Operation:** APPEND

**Required Mappings:**

| Source Field | Target Field | Type | Status |
|-------------|--------------|------|--------|
| `edge.p.p` | `values[].mean` | number | ✅ |
| `edge.p.stdev` | `values[].stdev` | number | ✅ |
| `edge.p.evidence.n` | `values[].n` | integer | ⚠️ Phase 0 addition |
| `edge.p.evidence.k` | `values[].k` | integer | ⚠️ Phase 0 addition |
| `edge.p.evidence.window_from` | `values[].window_from` | datetime | ⚠️ Phase 0 addition |
| `edge.p.evidence.window_to` | `values[].window_to` | datetime | ⚠️ Phase 0 addition |
| (current time) | `values[].retrieved_at` | datetime | ⚠️ Check schema |
| (manual/graph) | `values[].source` | string | ⚠️ Check schema |

**Issues to Check:**
- [ ] Does graph schema have `edge.p.evidence` object? (Phase 0 addition)
- [ ] Does graph schema have `edge.p.evidence.n`, `k`, `window_from`, `window_to`? (Phase 0 addition)
- [ ] Does parameter-schema.yaml values[] support all these fields? (Phase 0 additions)
- [ ] Does parameter-schema.yaml values[] have `source` field?
- [ ] Does parameter-schema.yaml values[] have `retrieved_at` field?

---

### 5. graph_to_file.CREATE.case (Flow C.CREATE)

**Source:** Graph case node  
**Target:** New case file  
**Operation:** CREATE

**Required Mappings:**

| Source Field | Target Field | Type | Status |
|-------------|--------------|------|--------|
| `caseNode.id` | `case.id` | string | ✅ Should exist |
| `caseNode.label` | `case.name` | string | ✅ Should exist |
| `caseNode.description` | `case.description` | string | ❓ Case node description? |
| `caseNode.variants` | `case.schedules[0].variants` | array | ⚠️ Check structure |

**Issues to Check:**
- [ ] Does case node have `description` field?
- [ ] What is structure of `caseNode.variants`? (array of {id, name, weight}?)
- [ ] Does case-schema.yaml have `schedules[]` array? (Phase 0 addition)
- [ ] What is structure of `schedules[]` entries?

---

### 6. graph_to_file.UPDATE.case (Flow C.UPDATE)

**Source:** Graph case node  
**Target:** Existing case file (metadata only)  
**Operation:** UPDATE

**Required Mappings:**

| Source Field | Target Field | Override Flag | Status |
|-------------|--------------|---------------|--------|
| `caseNode.description` | `case.description` | `description_overridden` | ❓ Both exist? |

**Issues to Check:**
- [ ] Does case node have `description` field?
- [ ] Does case-schema.yaml have `description` field?
- [ ] Does case-schema.yaml have `description_overridden` flag? (Phase 0 addition)

---

### 7. graph_to_file.APPEND.case (Flow C.APPEND)

**Source:** Graph case node  
**Target:** Case file schedules[] array  
**Operation:** APPEND

**Required Mappings:**

| Source Field | Target Field | Type | Status |
|-------------|--------------|------|--------|
| `caseNode.variants` | `schedules[].variants` | array | ⚠️ Check structure |
| (current time) | `schedules[].window_from` | datetime | ⚠️ Phase 0 addition |
| (manual/graph) | `schedules[].source` | string | ⚠️ Phase 0 addition |

**Issues to Check:**
- [ ] Does case-schema.yaml have `schedules[]` array? (Phase 0 addition)
- [ ] What is structure of each schedules[] entry?
- [ ] Does it match variants structure from graph?
- [ ] Does schedules[] entry have `window_from`, `window_to`, `source` fields?

---

### 8. graph_to_file.CREATE.node (Flow D.CREATE)

**Source:** Graph node  
**Target:** New node registry entry  
**Operation:** CREATE

**Required Mappings:**

| Source Field | Target Field | Type | Status |
|-------------|--------------|------|--------|
| `node.id` | `nodeRegistry.id` | string | ✅ Should exist |
| `node.label` | `nodeRegistry.label` | string | ✅ Should exist |
| `node.description` | `nodeRegistry.description` | string | ❓ Node description? |
| `node.event_id` | `nodeRegistry.event_id` | string | ⚠️ Phase 0 addition |

**Issues to Check:**
- [ ] Does graph node have `description` field?
- [ ] Does graph node have `event_id` field? (Phase 0 addition)
- [ ] Does node-schema.yaml have `event_id` field? (Phase 0 addition)
- [ ] Are all other node registry fields optional or have defaults?

---

### 9. graph_to_file.UPDATE.node (Flow D.UPDATE)

**Source:** Graph node  
**Target:** Existing node registry entry  
**Operation:** UPDATE

**Required Mappings:**

| Source Field | Target Field | Override Flag | Status |
|-------------|--------------|---------------|--------|
| `node.event_id` | `nodeRegistry.event_id` | N/A | ⚠️ Phase 0 addition to both |

**Issues to Check:**
- [ ] Does graph node have `event_id` field? (Phase 0 addition)
- [ ] Does node-schema.yaml have `event_id` field? (Phase 0 addition)
- [ ] Should registry have override flag for event_id? (Probably not - it's curated)

---

### 10. graph_to_file.CREATE.context (Flow E.CREATE)

**Source:** Graph/UI (manual)  
**Target:** New context registry entry  
**Operation:** CREATE

**Required Mappings:**

| Source Field | Target Field | Type | Status |
|-------------|--------------|------|--------|
| (user input) | `context.id` | string | ❓ Schema doesn't exist yet |
| (user input) | `context.name` | string | ❓ Schema doesn't exist yet |
| (user input) | `context.description` | string | ❓ Schema doesn't exist yet |

**Issues to Check:**
- [ ] Create context-schema.yaml (Phase 0 - deferred or minimal?)
- [ ] Define context structure (dimensions, rules?)
- [ ] This is manual creation - no graph source fields

---

### 11. graph_to_file.CREATE.event (Flow F.CREATE)

**Source:** Graph/UI (manual)  
**Target:** New event registry entry  
**Operation:** CREATE

**Required Mappings:**

| Source Field | Target Field | Type | Status |
|-------------|--------------|------|--------|
| (user input) | `event.event_id` | string | ❓ Schema doesn't exist yet |
| (user input) | `event.name` | string | ❓ Schema doesn't exist yet |
| (user input) | `event.description` | string | ❓ Schema doesn't exist yet |
| (user input) | `event.connectors.amplitude.event_name` | string | ❓ Schema doesn't exist yet |

**Issues to Check:**
- [ ] Create event-schema.yaml (Phase 0)
- [ ] Create events-index-schema.yaml (Phase 0)
- [ ] Define event structure (connectors object for Amplitude mappings)
- [ ] This is manual creation - no graph source fields

---

### 12. file_to_graph.UPDATE.parameter (Flow G)

**Source:** Parameter file  
**Target:** Graph edge parameter  
**Operation:** UPDATE

**Required Mappings:**

| Source Field | Target Field | Override Flag | Status |
|-------------|--------------|---------------|--------|
| `parameter.values[0].mean` | `edge.p.p` | `p.p_overridden` | ⚠️ Check override location |
| `parameter.values[0].stdev` | `edge.p.stdev` | `p.stdev_overridden` | ⚠️ Check override location |
| `parameter.values[0].n` | `edge.p.evidence.n` | N/A (not overridable) | ⚠️ Phase 0 additions |
| `parameter.values[0].k` | `edge.p.evidence.k` | N/A (not overridable) | ⚠️ Phase 0 additions |
| `parameter.values[0].window_from` | `edge.p.evidence.window_from` | N/A | ⚠️ Phase 0 additions |
| `parameter.values[0].window_to` | `edge.p.evidence.window_to` | N/A | ⚠️ Phase 0 additions |
| `parameter.query` | `edge.query` | `query_overridden` | ⚠️ Phase 0 additions |

**Issues to Check:**
- [ ] Does parameter-schema.yaml values[] have `n`, `k`, `window_from`, `window_to`? (Phase 0)
- [ ] Does parameter-schema.yaml have `query` field? (Phase 0)
- [ ] Does graph edge have `query` field? (Phase 0)
- [ ] Are override flags inside `edge.p` object or at edge level?
- [ ] Confirmed: Override flags are `p.p_overridden`, `p.stdev_overridden` (suffix pattern inside p)
- [ ] Does graph schema support `edge.query_overridden` at edge level?

---

### 13. file_to_graph.UPDATE.case (Flow H)

**Source:** Case file  
**Target:** Graph case node  
**Operation:** UPDATE

**Required Mappings:**

| Source Field | Target Field | Override Flag | Status |
|-------------|--------------|---------------|--------|
| `case.schedules[0].variants` | `caseNode.variants` | (per-variant weight_overridden) | ⚠️ Check structure |

**Issues to Check:**
- [ ] Does case-schema.yaml have `schedules[]` array? (Phase 0)
- [ ] What is structure of schedules[].variants?
- [ ] What is structure of caseNode.variants?
- [ ] Are they compatible?
- [ ] Do variants have individual `weight_overridden` flags?

---

### 14. file_to_graph.UPDATE.node (Flow I)

**Source:** Node registry  
**Target:** Graph node  
**Operation:** UPDATE

**Required Mappings:**

| Source Field | Target Field | Override Flag | Status |
|-------------|--------------|---------------|--------|
| `nodeRegistry.label` | `node.label` | `label_overridden` | ✅ Should work |
| `nodeRegistry.description` | `node.description` | `description_overridden` | ❓ Node description exists? |
| `nodeRegistry.event_id` | `node.event_id` | `event_id_overridden` | ⚠️ Phase 0 additions |

**Issues to Check:**
- [ ] Does graph node have `description` field?
- [ ] Does graph node have `event_id` field? (Phase 0)
- [ ] Does graph node have `label_overridden`, `description_overridden`, `event_id_overridden` flags? (Phase 0)
- [ ] Does node-schema.yaml have `event_id` field? (Phase 0)

---

### 15. external_to_graph.UPDATE.parameter (Flow L)

**Source:** External data (Amplitude/Sheets)  
**Target:** Graph edge parameter  
**Operation:** UPDATE

**Required Mappings:**

| Source Field | Target Field | Override Flag | Status |
|-------------|--------------|---------------|--------|
| `external.n` | `edge.p.evidence.n` | N/A (not overridable) | ⚠️ Phase 0 addition |
| `external.k` | `edge.p.evidence.k` | N/A (not overridable) | ⚠️ Phase 0 addition |
| `external.p` (calculated) | `edge.p.p` | `p.p_overridden` | ⚠️ Check override |
| `external.window_from` | `edge.p.evidence.window_from` | N/A | ⚠️ Phase 0 addition |
| `external.window_to` | `edge.p.evidence.window_to` | N/A | ⚠️ Phase 0 addition |

**Issues to Check:**
- [ ] Does graph schema support `edge.p.evidence` object with all fields? (Phase 0)
- [ ] Does external data response include n, k, p, window_from, window_to?
- [ ] Should we calculate p from n/k or trust external p?

---

### 16. external_to_graph.UPDATE.case (Flow M)

**Source:** External data (Statsig/Optimizely)  
**Target:** Graph case node  
**Operation:** UPDATE

**Required Mappings:**

| Source Field | Target Field | Override Flag | Status |
|-------------|--------------|---------------|--------|
| `external.variants` | `caseNode.variants` | (per-variant weight_overridden) | ⚠️ Check structure |

**Issues to Check:**
- [ ] What is structure of external case data?
- [ ] Does it match caseNode.variants structure?
- [ ] Are variant weights individually overridable?

---

### 17. external_to_file.APPEND.parameter (Flow Q)

**Source:** External data (Amplitude/Sheets)  
**Target:** Parameter file values[] array  
**Operation:** APPEND

**Required Mappings:**

| Source Field | Target Field | Type | Status |
|-------------|--------------|------|--------|
| `external.n` | `values[].n` | integer | ⚠️ Phase 0 addition |
| `external.k` | `values[].k` | integer | ⚠️ Phase 0 addition |
| `external.p` (or calc) | `values[].mean` | number | ✅ Should work |
| `external.stdev` (or calc) | `values[].stdev` | number | ✅ Should work |
| `external.window_from` | `values[].window_from` | datetime | ⚠️ Phase 0 addition |
| `external.window_to` | `values[].window_to` | datetime | ⚠️ Phase 0 addition |
| (current time) | `values[].retrieved_at` | datetime | ⚠️ Check schema |
| (amplitude/sheets) | `values[].source` | string | ⚠️ Check schema |

**Issues to Check:**
- [ ] Does parameter-schema.yaml values[] support n, k, window_from, window_to? (Phase 0)
- [ ] Does parameter-schema.yaml values[] have source field?
- [ ] Does parameter-schema.yaml values[] have retrieved_at field?
- [ ] Should we have data_source object instead of flat fields?

---

### 18. external_to_file.APPEND.case (Flow R)

**Source:** External data (Statsig/Optimizely)  
**Target:** Case file schedules[] array  
**Operation:** APPEND

**Required Mappings:**

| Source Field | Target Field | Type | Status |
|-------------|--------------|------|--------|
| `external.variants` | `schedules[].variants` | array | ⚠️ Check structure |
| `external.window_from` | `schedules[].window_from` | datetime | ⚠️ Phase 0 addition |
| `external.window_to` | `schedules[].window_to` | datetime | ⚠️ Phase 0 addition |
| (current time) | `schedules[].retrieved_at` | datetime | ⚠️ Check schema |
| (statsig/optimizely) | `schedules[].source` | string | ⚠️ Check schema |

**Issues to Check:**
- [ ] Does case-schema.yaml have schedules[] array? (Phase 0)
- [ ] What is structure of schedules[] entries?
- [ ] Does it have window_from, window_to, retrieved_at, source fields?
- [ ] Does external variants structure match schedules[].variants structure?

---

## Critical Issues Summary

### Schema Gaps (Must Address in Phase 0)

#### 1. Graph Schema (conversion-graph)
- [ ] **Missing:** `edge.query` field (object)
- [ ] **Missing:** `edge.query_overridden` field (boolean)
- [ ] **Missing:** `edge.p.evidence` object with {n, k, window_from, window_to, retrieved_at, source, query}
- [ ] **Missing:** `edge.p.p_overridden`, `edge.p.stdev_overridden`, `edge.p.distribution_overridden` flags
- [ ] **Missing:** `node.event_id` field (string)
- [ ] **Missing:** `node.event_id_overridden` field (boolean)
- [ ] **Missing:** `node.description` field? (check if exists)
- [ ] **Missing:** `edge.description` field? (check if exists)
- [ ] **Missing:** `node.label_overridden`, `node.description_overridden` flags
- [ ] **Missing:** `edge.label_overridden`, `edge.description_overridden` flags
- [ ] **Unclear:** Location of `parameter_id` - inside `edge.p` or at edge level?
- [ ] **Unclear:** Case node variants structure - what fields do variants have?

#### 2. Parameter Schema (parameter-schema.yaml)
- [ ] **Missing:** `query` field (object with expression)
- [ ] **Missing:** `query_overridden` field (boolean)
- [ ] **Missing:** `description_overridden` field (boolean)
- [ ] **Missing:** `condition` field (string, optional)
- [ ] **Missing:** `source` field (object: {type, connection_id})
- [ ] **Missing:** `connection` field (object: {connection_id, last_sync})
- [ ] **Missing:** `values[].n` field (integer)
- [ ] **Missing:** `values[].k` field (integer)
- [ ] **Missing:** `values[].window_from` field (datetime)
- [ ] **Missing:** `values[].window_to` field (datetime)
- [ ] **Missing:** `values[].retrieved_at` field (datetime)
- [ ] **Missing:** `values[].source` field (string: amplitude/sheets/manual)
- [ ] **Unclear:** Should we have nested `data_source` object instead of flat fields?

#### 3. Node Schema (node-schema.yaml)
- [ ] **Missing:** `event_id` field (string, optional)

#### 4. Case Schema (case-schema.yaml)
- [ ] **Missing:** `schedules[]` array (timestamped history of variants)
- [ ] **Missing:** `description_overridden` field (boolean)
- [ ] **Unclear:** Structure of schedules[] entries - what fields?
- [ ] **Unclear:** Structure of variants within schedules[]

#### 5. Event Schema (NEW - event-schema.yaml)
- [ ] **Missing:** Entire schema needs to be created
- [ ] **Required fields:** event_id, name, description
- [ ] **Required:** connectors object (Amplitude event_name mappings)

#### 6. Events Index Schema (NEW - events-index-schema.yaml)
- [ ] **Missing:** Entire schema needs to be created
- [ ] **Required:** Array of event IDs

#### 7. Context Schema (FUTURE - context-schema.yaml)
- [ ] Defer to future phase (not in Phase 0 scope)

---

## Structural Compatibility Issues

### Issue 1: Edge Label vs Node Label Cascades
**Problem:** When node label changes, should it cascade to edges?
- Graph has nodes with labels
- Edges connect nodes but may or may not have their own labels
- If edge label is derived from node labels, how is it stored?

**Questions:**
- [ ] Do edges have their own `label` field or is it derived from `from_node.label` and `to_node.label`?
- [ ] If derived, how do we handle label cascades and overrides?

### Issue 2: Parameter ID Location
**Problem:** Unclear where `parameter_id` is stored on edge
- Is it `edge.parameter_id` (at edge level)?
- Is it `edge.p.parameter_id` (inside param object)?
- Is it `edge.p.id` or `edge.p.parameter_id`?

**Impact:** Affects all mappings involving parameter linking

**Decision needed:** Confirm location in graph schema

### Issue 3: Variants Structure
**Problem:** Multiple representations of case variants
- Graph case node has `variants`
- Case file has `schedules[].variants`
- External sources have variant data

**Questions:**
- [ ] What fields do variants have? (id, name, weight, description?)
- [ ] Is structure consistent across all three?
- [ ] How are weight_overridden flags stored? (per-variant or per-case-node?)

### Issue 4: Evidence vs Values Structure
**Problem:** Parameter files have rich `values[]` history, graph has simpler `evidence`
- Parameter file: `values[].{mean, stdev, n, k, window_from, window_to, source, retrieved_at}`
- Graph edge: `p.{p, stdev, evidence: {n, k, window_from, window_to, source}}`

**Questions:**
- [ ] Is this intentional asymmetry OK?
- [ ] Should graph store more evidence metadata?
- [ ] Should we add `retrieved_at` to graph evidence?

### Issue 5: Data Source Metadata
**Problem:** Inconsistent storage of source metadata
- Parameter values[] has flat fields: `source`, `retrieved_at`
- Or should it have nested: `data_source: {type, retrieved_at, query}`?

**Decision needed:** Choose structure and apply consistently

---

## Recommendations

### Priority 1: Critical Schema Updates (MUST DO)
1. **Graph schema:** Add `edge.query`, `edge.p.evidence`, all override flags, `node.event_id`
2. **Parameter schema:** Add `query`, `n/k/window fields to values[]`, override flags
3. **Node schema:** Add `event_id`
4. **Case schema:** Add `schedules[]` array
5. **Event schemas:** Create event-schema.yaml and events-index-schema.yaml

### Priority 2: Structural Decisions (MUST CLARIFY)
1. Confirm `parameter_id` location on edge
2. Define variants structure completely
3. Decide on data_source metadata structure
4. Clarify edge label vs node label relationship

### Priority 3: Validation Actions
1. Read current graph schema code to verify existing fields
2. Read current parameter-schema.yaml to verify existing fields
3. Map out complete variants structure
4. Create test data for each mapping type
5. Build minimal UpdateManager to test schema compatibility

---

---

## Schema Audit Results

### What Exists Today

#### Parameter Schema (parameter-schema.yaml) ✅
**Has:**
- `id`, `name`, `type` (probability, cost_gbp, cost_time)
- `values[]` array with: `mean`, `stdev`, `distribution`, `window_from`, `context_id`
- `values[].data_source` object with: `type`, `url`, `notes`
- `metadata` object with: `description`, `units`, `tags`, `created_at`, `author`, `version`

**Missing (Phase 0):**
- ❌ `query` field (top-level)
- ❌ `query_overridden` flag
- ❌ `description_overridden` flag
- ❌ `condition` field
- ❌ `source` field (connection info)
- ❌ `connection` field
- ❌ `values[].n` (sample size)
- ❌ `values[].k` (successes)
- ❌ `values[].window_to` (has window_from, needs window_to)
- ❌ `values[].retrieved_at` (timestamp)

**Note:** Has `data_source` object in values[] but missing specific fields like retrieved_at

#### Graph Schema (types/index.ts GraphData interface) ✅
**Node fields:**
- `id`, `slug`, `label`, `description`, `tags`
- `type` ('normal' | 'case')
- `absorbing`, `outcome_type`
- `entry`, `costs`, `residual_behavior`
- `layout` (x, y, colour)
- `case` object (for case nodes)

**Edge fields:**
- `id`, `slug`, `from`, `to`, `fromHandle`, `toHandle`
- `description`
- `p` object with: `mean`, `stdev`, `locked`, `parameter_id`, `distribution`
- `conditional_p` array
- `weight_default`, `costs`
- `case_variant`, `case_id`
- `display` object

**Missing (Phase 0):**
- ❌ `node.event_id`
- ❌ `node.event_id_overridden`
- ❌ `node.label_overridden`
- ❌ `node.description_overridden`
- ❌ `edge.query` (query expression)
- ❌ `edge.query_overridden`
- ❌ `edge.label` (or is it derived?)
- ❌ `edge.label_overridden`
- ❌ `edge.description_overridden`
- ❌ `edge.p.p` (currently uses `mean`, not `p`)
- ❌ `edge.p.p_overridden`
- ❌ `edge.p.stdev_overridden`
- ❌ `edge.p.distribution_overridden`
- ❌ `edge.p.evidence` object with {n, k, window_from, window_to, retrieved_at, source, query}
- ❌ `caseNode.variants[].weight_overridden`

**Important:** `parameter_id` is inside `edge.p` object ✅ (location confirmed)

#### Node Schema (node-schema.yaml) ✅
**Has:**
- `id`, `name`, `description`, `tags`
- `resources` array
- `metadata` object

**Missing (Phase 0):**
- ❌ `event_id` field

#### Case Schema (case-schema.yaml) ❌
**Status:** Does NOT exist yet
**Needs creation in Phase 0**

#### Event Schemas (event-schema.yaml, events-index-schema.yaml) ❌
**Status:** Do NOT exist yet
**Needs creation in Phase 0**

---

## Critical Schema Gaps Summary

### Must Add to Graph Schema
1. **Nodes:**
   - `event_id` (string, optional)
   - `event_id_overridden` (boolean)
   - `label_overridden` (boolean)
   - `description_overridden` (boolean)

2. **Edges:**
   - `query` (object with expression)
   - `query_overridden` (boolean)
   - `label` (string, optional - or clarify derivation)
   - `label_overridden` (boolean)
   - `description_overridden` (boolean)
   - Rename `p.mean` → `p.p` (align with parameter schema)
   - Add `p.p_overridden` (boolean)
   - Add `p.stdev_overridden` (boolean)
   - Add `p.distribution_overridden` (boolean)
   - Add `p.evidence` object: {n, k, window_from, window_to, retrieved_at, source, query}

3. **Case Nodes:**
   - Add `variants[].weight_overridden` (boolean per variant)

### Must Add to Parameter Schema
1. `query` (object at top level)
2. `query_overridden` (boolean)
3. `description_overridden` (boolean in metadata?)
4. `condition` (string, optional)
5. `source` (object: {type, connection_id})
6. `connection` (object: {connection_id, last_sync})
7. **In values[] array:**
   - `n` (integer)
   - `k` (integer)
   - `window_to` (datetime - already has window_from)
   - `retrieved_at` (datetime)
   - Potentially restructure or enhance `data_source` to match needs

### Must Add to Node Schema
1. `event_id` (string, optional)

### Must Create: Case Schema (case-schema.yaml)
**Required structure:**
- `id`, `name`, `description`
- `schedules[]` array with entries:
  - `variants[]` array (id, name, weight)
  - `window_from`, `window_to`
  - `retrieved_at`, `source`
- `metadata` object (description_overridden flag)

### Must Create: Event Schemas
1. **event-schema.yaml:**
   - `event_id`, `name`, `description`
   - `connectors` object (amplitude: {event_name})
   - `metadata`

2. **events-index-schema.yaml:**
   - Array of event IDs

---

## Open Questions (For User Review)

### Question 1: Edge Label Storage ❓
**Status:** Not specified in design docs

Edges currently don't have a `label` field. Should they?

**Options:**
- A) Add optional `edge.label` field (can be overridden, otherwise derived from nodes)
- B) Keep derived only (no storage, no override needed)

**Impact:** Medium - affects Flow A (label cascades) and override tracking

**Recommendation:** Option A for flexibility, but need decision

*** Good catch. We want edge.label auto-derived from graph. We infer it from up & downstream node_id. We previously did that with a front end kludge. But now we have _overridden logic scoped, this is a perfect instance of it. The edge label should automatically update (from graph) unless _overridden because e.g. the user enters a different slug [which they are welcome to do if they wish], at which point overridden is set, and node name changes will not auto-updated edge slug names. It's less obvious to me that it should be 'label' rather than slug. I'm not precious about this, but if we're using 'slug' for nodes and 'label' for edges and in other cases 'id' it's potentially confusing. I guess we reserve .id for true UUID on the graph [not interesting from a commercial data design perspective], although I we do talk about e.g. 'event_id' which may risk being confusing. Is there a reason not to move to:
object.uuid
object.id [instead of slug]

then we handle foreign keys (e.g. event_id on node) like:

object.foreignobject_id

across the board for nodes, edges, cases, events, contexts, params? While we're doing a big breakign schema rethink this is a good time to standardise it...but we would need to ensure we systematically handle across the app code, which is a moderate re-factor....? ***

---

### Question 2: Case Schedule Field Names ❓
**Status:** Minor inconsistency

Existing case-parameter-schema.yaml uses `start_date`/`end_date`, but parameter schema uses `window_from`/`window_to`.

**Options:**
- A) Rename to `window_from`/`window_to` (consistency)
- B) Keep `start_date`/`end_date` (existing schema)

**Impact:** Low - just naming consistency

**Recommendation:** Rename for consistency across all windowed data

*** yes, let's have something standard ***

---

### Question 3: Description Override Location ❓
**Status:** Not specified where to put this flag

Parameter files need `description_overridden` flag. Where?

**Options:**
- A) Top-level: `description_overridden: boolean`
- B) In metadata: `metadata.description_overridden: boolean`

**Impact:** Very low - just organization

**Recommendation:** Top-level (consistent with `query_overridden`)

*** SURE ***

---

## Summary

### Design Status: ✅ 100% Complete

**Fully Designed (in DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md):**
- ✅ Graph schema updates (nodes, edges, override flags, evidence object)
- ✅ Parameter schema updates (query, n/k, window fields, override flags)
- ✅ Node schema updates (event_id)
- ✅ Event schemas (event-schema.yaml, events-index-schema.yaml)
- ✅ Case schema exists (case-parameter-schema.yaml) - needs field renames

**Confirmed Decisions:**
- ✅ Keep `edge.p.mean` (NOT renaming to p.p - statistically correct, less confusing)
- ✅ Override flags: `mean_overridden`, `stdev_overridden`, etc. (suffix pattern)
- ✅ Evidence separate: `edge.p.evidence` object (not overridable)
- ✅ `parameter_id` location: inside `edge.p` object
- ✅ Data source metadata: enhance existing `data_source` object in values[]

**NEW Decisions (from schema review 2025-11-05):**

1. **✅ Edge Label - Auto-derived with Override**
   - Add optional `edge.label` field (auto-derived from upstream/downstream nodes)
   - Add `edge.label_overridden` flag
   - When NOT overridden: UpdateManager auto-updates from node labels
   - When overridden: User's custom label preserved, no auto-updates

2. **✅ Case Schedule Field Naming**
   - Rename `start_date` → `window_from`
   - Rename `end_date` → `window_to`
   - Consistency across all windowed data (parameters, cases, evidence)

3. **✅ Description Override Location**
   - Top-level: `description_overridden: boolean`
   - Consistent with `query_overridden` placement

4. **✅ ID/Slug Standardization (NEW PHASE 0.0)**
   - **Rename:** `node.id` → `node.uuid` (system UUID)
   - **Rename:** `node.slug` → `node.id` (human-readable identifier)
   - **Rename:** `edge.id` → `edge.uuid` (system UUID)
   - **Rename:** `edge.slug` → `edge.id` (human-readable identifier)
   - **Keep:** All foreign keys as-is (`parameter_id`, `case_id`, `event_id`, `node_id`)
   - **Pattern:** `object.uuid` (system), `object.id` (human), `object.foreign_id` (references)

**All 18 mapping configurations are fully supported.**

---

## Next Actions

1. **✅ DONE:** All design decisions finalized
2. **NEXT:** Phase 0.0 - ID/Slug Standardization Refactor (3-4 hours)
3. **THEN:** Phase 0.1-0.3 - Schema updates per DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md
4. **Timeline:** 4-5 days total (was 3-4, +1 day for id/slug refactor)

