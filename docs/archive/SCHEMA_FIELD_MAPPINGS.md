# Schema Field Mappings: The Switchboard

**Purpose:** Complete field-by-field mapping across all schemas  
**Status:** Phase 0 Validation Document  
**Date:** 2025-11-05

**Critical:** This document ensures ALL field names align correctly across schemas before implementation.

---

## Mapping 1: Node Registry ↔ Graph Node

| Node Registry (param-registry/nodes/) | Graph Node (conversion-graph.json) | Notes |
|---------------------------------------|-------------------------------------|-------|
| `id` | `slug` | Connection field |
| `name` | `label` | AUTO-SYNC (if not overridden) |
| `description` | `description` | AUTO-SYNC (if not overridden) |
| `event_id` | `event_id` | AUTO-SYNC (if not overridden) |
| - | `id` | Graph-internal UUID |
| - | `label_overridden` | Override flag |
| - | `description_overridden` | Override flag |
| - | `event_id_overridden` | Override flag |
| - | `x`, `y` | User positioning (NOT synced) |
| - | `type` | "regular" or "case" |

**Mapping Type:** `registry_to_node`

**Data Flow:** Node Registry → Graph Node (one-way, pull only)

---

## Mapping 2: Parameter File ↔ Graph Edge

| Parameter File (param-registry/parameters/) | Graph Edge (conversion-graph.json) | Notes |
|--------------------------------------------|-------------------------------------|-------|
| `id` | `p.parameter_id` | Connection field |
| `name` | `label` | AUTO-SYNC (if not overridden) |
| `description` | `description` | AUTO-SYNC (if not overridden) |
| `values[latest].mean` | `p.p` | PRIMARY value (if not overridden) |
| `values[latest].stdev` | `p.stdev` | AUTO-SYNC (if not overridden) |
| `values[latest].distribution` | `p.distribution` | AUTO-SYNC (if not overridden) |
| `values[latest].n` | `p.evidence.n` | Evidence (NOT overridable) |
| `values[latest].k` | `p.evidence.k` | Evidence (NOT overridable) |
| `values[latest].window_from` | `p.evidence.window_from` | Evidence time window |
| `values[latest].window_to` | `p.evidence.window_to` | Evidence time window (optional) |
| `query` | `query` | AUTO-SYNC from MSMDC (if not overridden) |
| - | `id` | Graph-internal UUID |
| - | `from`, `to` | Node references (structural) |
| - | `label_overridden` | Override flag |
| - | `description_overridden` | Override flag |
| - | `p.p_overridden` | Override flag |
| - | `p.stdev_overridden` | Override flag |
| - | `p.distribution_overridden` | Override flag |
| - | `query_overridden` | Override flag |

**Mapping Types:** 
- `parameter_to_edge` (pull param → graph)
- `edge_to_parameter` (push graph → param, append new value)

**Data Flow:** Bidirectional (pull/push)

**CRITICAL:** `p` is PRIMARY (user edits), `n/k` is EVIDENCE (observations only)

---

## Mapping 3: Case File ↔ Graph Case Node

| Case File (param-registry/cases/) | Graph Case Node (conversion-graph.json) | Notes |
|-----------------------------------|------------------------------------------|-------|
| `id` | `case.id` | Connection field |
| `name` | `label` | AUTO-SYNC (if not overridden) |
| `description` | `description` | AUTO-SYNC (if not overridden) |
| `schedules[latest].variants` | `case.variants[].weight` | AUTO-SYNC (if not overridden) |
| `variants[].name` | `case.variants[].name` | Structural (defines branches) |
| `variants[].description` | `case.variants[].description` | Registration data |
| - | `type: "case"` | Node type marker |
| - | `label_overridden` | Override flag |
| - | `description_overridden` | Override flag |
| - | `case.variants[].weight_overridden` | Override flag (per variant) |
| - | `case.variants[].edges` | Edge assignments (user-defined) |

**Mapping Type:** `case_to_node`

**Data Flow:** Case File → Graph Node (one-way, pull only)

**CRITICAL:** Variant NAMES are structural, WEIGHTS are temporal data (like param values)

---

## Mapping 4: Event Registry ↔ Graph Node

| Event Registry (events-index.yaml) | Graph Node (via node registry) | Notes |
|------------------------------------|--------------------------------|-------|
| `id` | `event_id` | Via node registry cascade |
| `name` | - | Not copied to graph |
| `description` | - | Not copied to graph |
| `connectors.amplitude.event_name` | - | Used by connectors only |

**Mapping Type:** None direct (cascade via node registry)

**Data Flow:** Event → Node Registry → Graph Node (two-hop)

---

## Mapping 5: External Source → Parameter File

**ANY external source** (Amplitude, Google Sheets, APIs, etc.) can append values to parameter files.

| External Source | Parameter File (values[] array) | Notes |
|----------------|--------------------------------|-------|
| Result data | `values[new].mean` | Primary value (p, cost, duration) |
| Result data | `values[new].stdev` | Standard deviation |
| Result data | `values[new].n` | Sample size (for probability params) |
| Result data | `values[new].k` | Successes (for probability params) |
| Result data | `values[new].distribution` | Distribution type |
| Query metadata | `values[new].window_from` | Time range start |
| Query metadata | `values[new].window_to` | Time range end |
| - | `values[new].data_source.type` | Source type (amplitude, sheets, api, etc.) |
| - | `values[new].data_source.retrieved_at` | Timestamp |
| Source-specific | `values[new].data_source.{metadata}` | Source-specific metadata |

**Mapping Type:** `external_to_parameter`

**Data Flow:** External Source → Parameter File (append to values array)

**Source Examples:**
- **Amplitude:** Funnel API → calculate p from k/n, apply binomial stdev
- **Google Sheets:** Cell values → direct import with validation
- **Custom API:** JSON response → map to parameter fields
- **Manual:** User-entered values → record as manual source

**Connection Configuration:** Each parameter file specifies connection details:
```yaml
connection:
  type: amplitude | sheets | api | manual
  config:
    # Source-specific configuration
    # For Amplitude: query definition
    # For Sheets: URL and range
    # For API: endpoint and mapping
```

**CRITICAL:** This APPENDS a new value, doesn't overwrite (maintains history)

---

## Mapping 6: External Source → Graph Edge (Direct)

**ANY external source** can populate graph edge parameters **directly** (no parameter file).

| External Source | Graph Edge | Notes |
|----------------|-----------|-------|
| Result data | `p.p` OR `cost_gbp.amount` OR `cost_time.duration` | Primary value |
| Result data | `p.stdev` OR `cost_gbp.stdev` OR `cost_time.stdev` | Standard deviation |
| Result data | `p.evidence.n` | Sample size (probability only) |
| Result data | `p.evidence.k` | Successes (probability only) |
| Result data | `p.evidence.window_from` | Time window start |
| Result data | `p.evidence.window_to` | Time window end |
| - | `p.evidence.retrieved_at` | Timestamp |
| - | `p.evidence.source` | Source type |
| - | `p.data_source` | Direct source metadata (no parameter_id) |
| - | `label` | AUTO-SYNC (if not overridden) |
| - | `description` | AUTO-SYNC (if not overridden) |

**Mapping Type:** `external_to_edge`

**Data Flow:** External Source → Graph Edge (no parameter file intermediary)

**Use Cases:**
- **Rapid prototyping:** Quick data connection for exploration
- **One-off analysis:** Data specific to this graph only
- **Real-time data:** Live connection without file overhead

**How to distinguish from parameter-based edges:**
```typescript
if (edge.p.parameter_id) {
  // Connected via parameter file
} else if (edge.p.data_source) {
  // Direct external connection
} else {
  // Manual entry (no connection)
}
```

**CRITICAL:** This is core to "flexible data location" principle - user chooses graph OR param file

---

## Mapping 7: External Source → Graph Case Node (Direct)

**ANY external source** (Statsig, Optimizely, etc.) can populate case node variant weights **directly** (no case file).

| External Source | Graph Case Node | Notes |
|----------------|-----------------|-------|
| Experiment config | `case.variants[].name` | Variant identifier |
| Experiment config | `case.variants[].weight` | Current allocation |
| Metadata | `label` | AUTO-SYNC (if not overridden) |
| Metadata | `description` | AUTO-SYNC (if not overridden) |
| - | `case.data_source.type` | Source type (statsig, optimizely, etc.) |
| - | `case.data_source.experiment_id` | Platform experiment ID |
| - | `case.data_source.retrieved_at` | Timestamp |

**Mapping Type:** `external_to_case`

**Data Flow:** External Source → Graph Case Node (no case file intermediary)

**Use Cases:**
- **Single-graph experiments:** Case specific to this graph
- **Live experiment tracking:** Real-time weight updates
- **Exploration:** Testing experiment ideas before formalizing

**How to distinguish from case-file-based nodes:**
```typescript
if (caseNode.case.id) {
  // Connected via case file
} else if (caseNode.case.data_source) {
  // Direct external connection
} else {
  // Manual case definition
}
```

**CRITICAL:** This is core to "flexible data location" principle - user chooses graph OR case file

---

## Mapping 8: External Source → Case File

**ANY external source** (Statsig, Optimizely, etc.) can append schedules to case files.

| External Source | Case File (schedules[] array) | Notes |
|----------------|-------------------------------|-------|
| Experiment config | `schedules[new].variants[name]` | Variant identifier → weight mapping |
| Experiment config | `schedules[new].start_date` | Schedule period start |
| Experiment config | `schedules[new].end_date` | Schedule period end (optional) |
| - | `schedules[new].retrieved_at` | Timestamp |
| - | `schedules[new].source` | Source type (statsig, optimizely, etc.) |

**Mapping Type:** `external_to_case_file`

**Data Flow:** External Source → Case File (append to schedules array)

**Source Examples:**
- **Statsig:** Experiment allocations → transform from percentage to decimal
- **Optimizely:** Experiment traffic allocation → direct import
- **Manual:** User-entered weights → record as manual source

**CRITICAL:** This APPENDS a new schedule, doesn't overwrite (maintains history)

---

## Mapping 9: Graph Structure → Query Expression (MSMDC)

| Graph Analysis | Parameter File / Edge | Notes |
|----------------|----------------------|-------|
| MSMDC algorithm result | `parameter.query` | Auto-generated |
| MSMDC algorithm result | `edge.query` | Auto-generated (if param not connected) |
| Graph structure hash | `parameter.query_overridden` | False = regenerate on change |
| - | `edge.query_overridden` | False = regenerate on change |

**Mapping Type:** `msmdc_to_query`

**Data Flow:** Graph Structure Analysis → Query Expression (auto-generation)

**CRITICAL:** Only updates if `query_overridden = false`

---

## Cross-Schema Field Name Validation

### All "id" Fields

| Schema | Field Name | Purpose | Pattern |
|--------|-----------|---------|---------|
| Node Registry | `id` | Canonical node ID | `^[a-z0-9-]+$` |
| Parameter Registry | `id` | Canonical parameter ID | `^[a-z0-9-]+$` |
| Case Registry | `id` | Canonical case ID | `^[a-z0-9-]+$` |
| Event Registry | `id` | Canonical event ID | `^[a-z0-9_]+$` (allows underscore!) |
| Graph Node | `id` | Graph-internal UUID | UUID v4 |
| Graph Node | `slug` | Reference to node registry | `^[a-z0-9-]+$` |
| Graph Edge | `id` | Graph-internal UUID | UUID v4 |

**Validation:** Event IDs use underscore (production event names), everything else uses hyphen

---

### All "name" vs "label" Fields

| Schema | Field Name | Purpose | Synced? |
|--------|-----------|---------|---------|
| Node Registry | `name` | Canonical name | Source |
| Graph Node | `label` | Display label | **YES** (if not overridden) |
| Parameter Registry | `name` | Canonical name | Source |
| Graph Edge | `label` | Display label | **YES** (if not overridden) |
| Case Registry | `name` | Canonical name | Source |
| Graph Case Node | `label` | Display label | **YES** (if not overridden) |

**Pattern:** Registries use `name`, graphs use `label` (auto-synced)

---

### All "description" Fields

| Schema | Field | Synced? | Notes |
|--------|-------|---------|-------|
| Node Registry | `description` | Source | Registration data |
| Graph Node | `description` | **YES** (if not overridden) | Can override for graph-specific context |
| Parameter Registry | `description` | Source | Registration data |
| Graph Edge | `description` | **YES** (if not overridden) | Can override for graph-specific context |
| Case Registry | `description` | Source | Registration data (NOT overridden) |

**Pattern:** Descriptions sync from registry to graph (except case description - registration only)

---

### All "query" Fields

| Schema | Field | Type | Overridable? |
|--------|-------|------|--------------|
| Parameter Registry | `query` | string (DSL) | YES |
| Graph Edge | `query` | string (DSL) | YES |

**Pattern:** Query expressions can exist on parameter OR edge, synced via MSMDC

---

### All Override Flag Fields

**Suffix Pattern (DECIDED):** All override flags use `{field}_overridden`

| Entity | Override Flags |
|--------|----------------|
| Graph Node | `label_overridden`, `description_overridden`, `event_id_overridden` |
| Graph Edge | `label_overridden`, `description_overridden`, `query_overridden` |
| Graph Edge.p | `p_overridden`, `stdev_overridden`, `distribution_overridden` |
| Graph Case Node | `label_overridden`, `description_overridden` |
| Graph Case Node variants | `weight_overridden` (per variant) |
| Parameter File | `query_overridden`, `condition_overridden` |

**NO override flags on:**
- Registry files (they ARE the source of truth)
- Evidence fields (observations, not calculations)
- Structural fields (id, from, to, x, y)

---

## Edge Parameter Value Structure (DEFINITIVE)

```typescript
// Graph Edge Probability Parameter
interface EdgeProbabilityParam {
  // PRIMARY VALUES (user-facing, what user edits)
  p: number;                      // Probability [0, 1]
  p_overridden?: boolean;         // Auto-updates disabled?
  
  stdev?: number;                 // Standard deviation
  stdev_overridden?: boolean;
  
  distribution?: string;          // "beta", "normal", etc.
  distribution_overridden?: boolean;
  
  // EVIDENCE (observations from data sources, NOT overridable)
  evidence?: {
    n: number;                    // Sample size
    k: number;                    // Successes
    window_from: string;          // Time window start (CRITICAL for context)
    window_to?: string;           // Time window end (optional)
    retrieved_at: string;         // When we retrieved this data
    source: "amplitude" | "sheets" | "manual";
    query?: object;               // Query that produced this
  };
  
  // METADATA (reference to parameter file)
  parameter_id?: string;          // Link to param file
  locked?: boolean;               // User locked (no edits allowed)
}
```

---

## Parameter File Value Structure (DEFINITIVE)

```yaml
# Parameter File (param-registry/parameters/checkout-conversion.yaml)
id: checkout-conversion
name: "Checkout Conversion"
type: probability
query: "from(checkout).to(purchase)"  # Auto-generated by MSMDC
query_overridden: false               # Can be manually edited

values:
  # Each value represents a time window or data retrieval
  - mean: 0.30              # PRIMARY: p value
    stdev: 0.0145           # Can be calculated or manual
    n: 1000                 # EVIDENCE: Sample size
    k: 300                  # EVIDENCE: Successes
    distribution: beta      # Distribution type
    
    window_from: "2025-11-01T00:00:00Z"
    window_to: "2025-11-30T23:59:59Z"    # Optional explicit end
    
    context_id: null        # Optional: device-mobile, etc.
    
    data_source:
      type: amplitude
      retrieved_at: "2025-11-05T10:00:00Z"
      query:
        from_event: "checkout_started"
        to_event: "purchase_completed"
        time_range: "30d"
```

---

## Case File Schedule Structure (DEFINITIVE)

```yaml
# Case File (param-registry/cases/checkout-test.yaml)
id: checkout-test
name: "Checkout Redesign Test"
description: "A/B test of checkout flow"

platform:
  type: statsig
  experiment_id: "exp_checkout_2025"

# STRUCTURE: Variant names (defines branches in graph)
variants:
  - name: control
    description: "Current checkout flow"
    weight: 0.5           # Baseline weight (for reference)
  
  - name: treatment
    description: "New streamlined checkout"
    weight: 0.5

# DATA: Time-windowed weights from Statsig (like parameter values)
schedules:
  - start_date: "2025-11-01T00:00:00Z"
    end_date: "2025-11-30T23:59:59Z"
    variants:
      control: 0.5
      treatment: 0.5
    retrieved_at: "2025-11-01T08:00:00Z"
    source: statsig
  
  - start_date: "2025-12-01T00:00:00Z"
    # No end_date = current
    variants:
      control: 0.3
      treatment: 0.7      # Rolling out treatment
    retrieved_at: "2025-12-01T08:00:00Z"
    source: statsig
```

---

## Validation Checklist

Before proceeding to implementation, verify:

### Field Name Consistency
- [ ] All `id` fields follow correct pattern (hyphen vs underscore)
- [ ] All registry `name` fields map to graph `label` fields
- [ ] All `description` fields have clear sync rules
- [ ] All override flags use `{field}_overridden` suffix pattern
- [ ] All evidence fields grouped under `.evidence` object
- [ ] All temporal data uses `values[]` or `schedules[]` arrays

### Data Structure Alignment
- [ ] Edge.p structure matches parameter values structure
- [ ] Case node variants structure matches case file schedules structure
- [ ] All connection fields (slug, parameter_id, case.id) validated
- [ ] All optional fields clearly documented

### Transformation Logic
- [ ] Amplitude (n, k) → (p, stdev) calculation defined
- [ ] Statsig weights → case variant weights transformation defined
- [ ] Sheets cell naming → parameter field mapping defined
- [ ] MSMDC graph analysis → query DSL generation defined

### No Orphaned Fields
- [ ] Every auto-populatable field has a mapping OR documented exclusion
- [ ] Every override flag has corresponding value field
- [ ] Every connection field has target in registry

---

## Implementation: UpdateManager Class

**All mappings are implemented in a SINGLE CLASS:** `UpdateManager`

**File:** `graph-editor/src/services/updateManager.ts`

**Why one class?**
- Single source of truth for ALL field mappings
- Guaranteed consistency (same logic everywhere)
- Easy to maintain (add/change mapping in one place)
- Testable in isolation (mock external sources)
- Override respect built-in (can't be bypassed)
- **Works in both modes:** Interactive UI + Unattended API/batch

**Structure:**

```typescript
class UpdateManager extends EventEmitter {
  private mappings: Map<string, FieldMapping[]>;
  
  constructor() {
    this.registerDefaultMappings();  // ← ALL 7 mappings registered here
  }
  
  private registerDefaultMappings(): void {
    // MAPPING 1: Node Registry → Graph Node
    this.registerMappings('registry_to_node', [...]);
    
    // MAPPING 2: Parameter File → Graph Edge
    this.registerMappings('parameter_to_edge', [...]);
    
    // MAPPING 3: Case File → Graph Case Node
    this.registerMappings('case_to_node', [...]);
    
    // MAPPING 4: Graph → Parameter Query (MSMDC)
    this.registerMappings('msmdc_to_query', [...]);
    
    // MAPPING 5: External Source → Parameter File
    this.registerMappings('external_to_parameter', [...]);
    
    // MAPPING 6: External Source → Graph Edge (Direct)
    this.registerMappings('external_to_edge', [...]);
    
    // MAPPING 7: External Source → Graph Case Node (Direct)
    this.registerMappings('external_to_case', [...]);
    
    // MAPPING 8: External Source → Case File
    this.registerMappings('external_to_case_file', [...]);
    
    // MAPPING 9: (Event Registry → Node Registry → Graph Node is handled by cascade)
  }
  
  // Main update method (respects overrides)
  async updateEntity(source, target, mappingType, context, options): Promise<UpdateResult>
  
  // Helper methods
  markOverridden(entity, field, overridden)
  clearOverride(entity, field, source, mappingType, context)
  canAutoUpdate(entity, field): boolean
}

// Singleton instance (used everywhere)
export const updateManager = new UpdateManager();
```

**Usage everywhere:**

```typescript
// In PropertiesPanel.tsx
import { updateManager } from '@/services/updateManager';

function pullFromParameter(edge, param) {
  await updateManager.updateEntity(param, edge, 'parameter_to_edge', {...});
}

// In registryService.ts
registry.on('nodeUpdated', (nodeDef) => {
  await updateManager.updateEntity(nodeDef, node, 'registry_to_node', {...});
});

// In AmplitudeConnector.ts
const result = await amplitudeAPI.query(...);
await updateManager.updateEntity(result, parameter, 'amplitude_to_parameter', {...});
```

**Benefits:**
1. **Impossible to bypass** - All updates go through one class
2. **Override respect guaranteed** - Built into updateEntity logic
3. **Audit trail automatic** - Every update logged
4. **Easy debugging** - One place to set breakpoints
5. **Schema changes easy** - Update mapping in one place

**Phase 0 Task:** Build this class with all 7 mappings as VALIDATION that schemas dovetail.

## Next Step: Validate Field Mappings

**Output:** `SCHEMA_FIELD_MAPPING_VALIDATION_RESULTS.md` documenting:
- Any field mismatches found
- Any type mismatches found
- Test results from UpdateManager
- Any schema changes needed

