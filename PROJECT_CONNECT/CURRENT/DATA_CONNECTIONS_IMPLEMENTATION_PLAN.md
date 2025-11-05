# Data Connections: Consolidated Implementation Plan

**Status:** Active Development  
**Last Updated:** 2025-11-05 (Phase 0.0 & 0.1 complete)  
**Current Phase:** Phase 0.3 - UpdateManager Implementation (Phase 0.0 & 0.1 ✅ COMPLETE)

**Related Documents:**
- [DATA_CONNECTIONS.md](./DATA_CONNECTIONS.md) — Main specification
- [QUERY_EXPRESSION_SYSTEM.md](./QUERY_EXPRESSION_SYSTEM.md) — Query DSL & MSMDC algorithm
- [QUERY_SELECTOR_DESIGN.md](./QUERY_SELECTOR_DESIGN.md) — UI component design
- [DATA_CONNECTIONS_SCHEMA_VALIDATION.md](./DATA_CONNECTIONS_SCHEMA_VALIDATION.md) — Schema validation
- [DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md](./DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md) — Design decisions

---

## Executive Summary

This document provides a consolidated, actionable implementation plan for the Data Connections system. It tracks progress across all phases and provides clear next steps.

### **Implementation Strategy: Foundation → Sync → Async → API**

1. **Phase 0:** Naming standardization, schemas & foundation (4-5 days) — **DESIGN COMPLETE**
2. **Phase 1:** Synchronous single-parameter operations (10-14 days)
3. **Phase 2:** Asynchronous batch operations (7-9 days)
4. **Phase 3:** API routes & automation (FUTURE — out of scope)

### **Total MVP Timeline:** ~21-27 days for Phases 0-2

**Breakdown:**
- **Phase 0:** 4-5 days (naming standardization, schemas, field mappings, UpdateManager validation) 🚨 4 GATES
- **Phase 1:** 10-14 days (core services, connectors, UI completion)
- **Phase 2:** 7-9 days (batch operations, optimization, progress UI)

---

## Current Status

### ✅ Completed

**Phase 0.0: ID/Slug Standardization Refactor (Nov 5, 2025):**
- [x] Renamed all `id` → `uuid` (system-generated)
- [x] Renamed all `slug` → `id` (human-readable)
- [x] Updated type definitions: `Slug` → `HumanId`
- [x] Refactored 17+ files across codebase
- [x] Fixed all UUID/ID lookup bugs (check both `n.uuid === ref || n.id === ref`)
- [x] Created migration script: `scripts/migrate-id-slug.ts`
- [x] Renamed `slugUtils.ts` → `idUtils.ts`
- [x] Purged ALL "slug" references from codebase (zero instances)
- [x] TypeScript compilation: 0 errors
- [x] Gate 0: ✅ **PASSED** - All code compiles, consistent naming throughout
- [x] Documentation: `PROJECT_CONNECT/PHASE_0.0_COMPLETE.md`

**Phase 0.1: Schema Updates (Nov 5, 2025):**
- [x] Updated 7 schema files (5 modified, 2 created)
- [x] Updated conversion-graph-1.0.0.json with Phase 0.0 changes
- [x] Updated parameter-schema.yaml with query DSL, evidence fields
- [x] Updated node-schema.yaml with event_id field
- [x] Updated case-parameter-schema.yaml with window_from/window_to
- [x] Created event-schema.yaml and events-index-schema.yaml
- [x] Updated credentials-schema.json with Amplitude and enhanced Google Sheets
- [x] Migrated test.json and WA-case-conversion.json to new schema
- [x] Documented conditional probability design (Query DSL strings)
- [x] Gate 1: ✅ **PASSED** - All schemas updated, test files migrated

**Phase 0.2: Field Mapping Validation (Gate 2) (Nov 5, 2025):**
- [x] Systematic validation of all field mappings
- [x] Fixed 8 critical field name mismatches (p.p → p.mean, etc.)
- [x] Updated SCHEMA_FIELD_MAPPINGS.md with Phase 0.0 naming
- [x] Updated MAPPING_TYPES.md with corrected field mappings
- [x] Validated all 18 mapping configurations
- [x] Documented orphaned fields (intentionally excluded)
- [x] Gate 2: ✅ **PASSED** - All field mappings validated
- [x] Documentation: `PROJECT_CONNECT/CURRENT/GATE_2_VALIDATION_RESULTS.md`
- [x] Documentation: `PROJECT_CONNECT/PHASE_0.1_COMPLETE.md`

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
- [x] PHASE_0.0_COMPLETE.md (ID/Slug refactor completion report)

### 🚧 In Progress (Phase 0.3)

**UpdateManager Implementation (Gate 3):**
- [ ] Create `graph-editor/src/services/UpdateManager.ts`
- [ ] Implement 18 mapping configurations
- [ ] Add override flag respect logic
- [ ] Build conflict resolution system
- [ ] Write comprehensive tests
- [ ] Gate 3: UpdateManager tests passing
- [ ] Add Events section to Navigator

**Credentials:**
- [ ] Update credentials-schema.json (googleSheets, amplitude)

**Field Mapping Validation (Gate 2) 🚨:**
- [ ] Review `SCHEMA_FIELD_MAPPINGS.md` (complete field-to-field mapping)
- [ ] Verify NO field name mismatches
- [ ] Verify NO type mismatches
- [ ] Document orphaned fields

**UpdateManager (Gate 3) 🚨:**
- [ ] Build UpdateManager with hierarchical architecture (see MAPPING_TYPES.md)
- [ ] Implement 5 direction handlers + 18 mapping configs
- [ ] Write 6 integration tests
- [ ] ALL tests must pass before Phase 1

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

## Phase 0: Schemas & Foundation (4-5 days)

**Goal:** Standardize naming, complete ALL schema updates, validate field mappings, build UpdateManager as validation gate.

**Critical Gates:**
0. **Gate 0:** ID/Slug standardization complete (clean foundation)
1. **Gate 1:** All schemas updated + fresh sample files created (NOT backward compatible - fresh start)
2. **Gate 2:** Field mappings validated (see SCHEMA_FIELD_MAPPINGS.md)
3. **Gate 3:** UpdateManager tests passing (proves schemas dovetail)

### Task Breakdown

#### 0. ID/Slug Standardization Refactor (0.5 days) 🆕

**Goal:** Establish consistent naming pattern across all schemas before adding new fields.

**Naming Standard:**
- `object.uuid` - System-generated UUID (not commercially interesting)
- `object.id` - Human-readable identifier (current "slug")
- `object.label` - Display name (unchanged)
- `object.foreign_id` - Foreign key references (already follows pattern: `parameter_id`, `case_id`, `event_id`)

**Changes:**

**Schema Updates:**
- [x] Node: rename `id` → `uuid`, `slug` → `id`
- [x] Edge: rename `id` → `uuid`, `slug` → `id`  
- [x] Keep foreign keys unchanged: `parameter_id`, `case_id`, `event_id`, `node_id`

**Implementation Steps:**

1. **Update Type Definitions (30 min)**
   - `types/index.ts` - GraphData interface
   - Any other type files
   - Let TypeScript errors guide the refactor

2. **Automated Refactoring (1 hour)**
   ```bash
   # Order matters! Do UUID renames first
   # Use VS Code find/replace with regex
   # Pattern 1: node.id → node.uuid (where it's the system UUID)
   # Pattern 2: node.slug → node.id (human-readable)
   # Pattern 3: edge.id → edge.uuid
   # Pattern 4: edge.slug → edge.id
   # Exclude: parameter_id, case_id, event_id (keep as-is)
   ```

3. **Manual Review & Fix (1-2 hours)**
   - Fix TypeScript compilation errors
   - Review ID generation logic
   - Update string matching code
   - Fix tests

4. **Migration Script (30 min)**
   - Write script to update existing graph JSON files
   - Test on sample graphs

5. **Validation (30 min)**
   - Run full test suite
   - Manually test graph editor
   - Verify no regressions

**Deliverables:**
- [ ] All type definitions updated
- [ ] All code references updated (~251 instances)
- [ ] Migration script for existing graphs
- [ ] All tests passing
- [ ] Documentation updated

**Why now:** Already doing breaking schema changes; establishes clean foundation for data connections; foreign keys already match this pattern.

---

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

query_overridden:
  type: boolean
  description: "Auto-updates disabled (user manually edited query)"
  default: false

description_overridden:
  type: boolean
  description: "Auto-updates disabled for description"
  default: false

condition:
  type: object
  description: "Conditional context (for conditional probabilities)"
  properties:
    visited:
      type: array
      items: { type: string }
      description: "Node IDs that must be visited"
```

**Note:** Removed redundant `query_auto_generated` (if not overridden, it's auto-generated).

**Validation:** Run against existing parameter files, ensure backward compatibility.

**Related:** See `SCHEMA_FIELD_MAPPINGS.md` for complete field-to-field mappings.

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
            // PRIMARY VALUES (user-facing)
            "mean": { 
              "type": "number", 
              "minimum": 0, 
              "maximum": 1,
              "description": "Mean probability value (primary, what user sees/edits)"
            },
            "mean_overridden": {
              "type": "boolean",
              "description": "Auto-updates disabled for mean"
            },
            "stdev": { "type": "number", "minimum": 0 },
            "stdev_overridden": { "type": "boolean" },
            "distribution": { "type": "string" },
            "distribution_overridden": { "type": "boolean" },
            
            // EVIDENCE (observations, not overridable)
            "evidence": {
              "type": "object",
              "description": "Observations from data sources (context for n/k)",
              "properties": {
                "n": { "type": "integer", "minimum": 0, "description": "Sample size" },
                "k": { "type": "integer", "minimum": 0, "description": "Successes" },
                "window_from": { 
                  "type": "string", 
                  "format": "date-time",
                  "description": "Time window start (CRITICAL: gives context to n/k)"
                },
                "window_to": { 
                  "type": "string", 
                  "format": "date-time",
                  "description": "Time window end (optional)"
                },
                "retrieved_at": { 
                  "type": "string", 
                  "format": "date-time",
                  "description": "When this data was retrieved"
                },
                "source": { 
                  "type": "string",
                  "enum": ["amplitude", "sheets", "manual"],
                  "description": "Where this data came from"
                },
                "query": { 
                  "type": "object",
                  "description": "Query that produced this data"
                }
              },
              "required": ["n", "window_from", "retrieved_at", "source"]
            }
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
        "label": { "type": "string" },
        "label_overridden": { 
          "type": "boolean",
          "description": "Auto-updates disabled for label"
        },
        
        "description": { "type": "string" },
        "description_overridden": { "type": "boolean" },
        
        "event_id": {
          "type": "string",
          "pattern": "^[a-z0-9_]+$",
          "description": "Reference to event in events registry"
        },
        "event_id_overridden": { "type": "boolean" }
      }
    },
    
    "Edge": {
      "properties": {
        "label": { 
          "type": "string",
          "description": "Edge label (auto-derived from upstream/downstream nodes unless overridden)"
        },
        "label_overridden": { 
          "type": "boolean",
          "description": "Auto-updates disabled for label (user entered custom value)"
        },
        
        "description": { "type": "string" },
        "description_overridden": { "type": "boolean" },
        
        "p": { "$ref": "#/$defs/ProbabilityParam" },
        "cost_gbp": { "$ref": "#/$defs/MoneyParam" },
        "cost_time": { "$ref": "#/$defs/DurationParam" },
        
        "query": {
          "type": "string",
          "description": "Query expression (auto-generated by MSMDC or manual)"
        },
        "query_overridden": {
          "type": "boolean",
          "description": "Auto-updates disabled for query"
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

#### 6. Field Mapping Validation & UpdateManager (1 day) 🚨 CRITICAL GATE

**Purpose:** Validate ALL field mappings before proceeding to Phase 1

**File:** `SCHEMA_FIELD_MAPPINGS.md` (created above)

**Tasks:**

**6.1: Manual Review (0.5 days)**
- [ ] Review SCHEMA_FIELD_MAPPINGS.md for every mapping
- [ ] Verify NO field name mismatches (e.g., `name` vs `label`)
- [ ] Verify NO type mismatches (string vs number, etc.)
- [ ] Document any orphaned fields (fields with no mapping)
- [ ] **DECISION:** Confirmed suffix pattern for override flags

**6.2: Build UpdateManager (0.5 days)**

**File:** `graph-editor/src/services/updateManager.ts`

**Purpose:** Single class containing ALL field mappings (the "switchboard")

**Architecture:** See `MAPPING_TYPES.md` for complete hierarchical design.

Implement UpdateManager with **three-level architecture:**

**Level 1: Direction Handlers (5 methods)**
1. `handleGraphInternal()` - Internal graph updates (MSMDC, cascades)
2. `handleGraphToFile()` - Graph → Files (CREATE, UPDATE, APPEND)
3. `handleFileToGraph()` - Files → Graph (UPDATE/sync)
4. `handleExternalToGraph()` - External → Graph (direct UPDATE)
5. `handleExternalToFile()` - External → Files (APPEND to history)

**Level 2: Operation Logic (shared implementations)**
- `createFileFromGraph()` - Shared logic for CREATE operations
- `updateFileMetadata()` - Shared logic for UPDATE operations  
- `appendToFileHistory()` - Shared logic for APPEND operations
- `syncFileToGraph()` - Shared logic for file→graph sync
- Each operation reused across different sub-destinations

**Level 3: Mapping Registry (18 configs)**
- Field mappings stored as data, not code
- Config keys: `{direction}.{operation}.{subDest}` (e.g., `graph_to_file.CREATE.parameter`)
- Covers all 13 in-scope flows (A-I, L-M, Q-R)

**Why hierarchical?**
- **Maximum code reuse** - Operations shared across sub-destinations
- **Clear separation** - Direction logic, operation logic, schema-specific data
- **Single source of truth** - ALL mappings in one registry
- **Override respect guaranteed** - Built into shared operation logic
- **Validation** - Building this PROVES schemas dovetail

See `MAPPING_TYPES.md` for complete architecture, `OVERRIDE_PATTERN_DESIGN.md` for override handling details, and `SCHEMA_FIELD_MAPPINGS.md` for field-by-field mappings.

**6.3: Integration Tests (Must Pass)**

**File:** `graph-editor/src/services/__tests__/updateManager.test.ts`

Test suite MUST include:
- [ ] Test 1: Node Registry → Graph Node (all fields map correctly)
- [ ] Test 2: Parameter → Edge with overrides (respects override flags)
- [ ] Test 3: Amplitude → Parameter (appends new value, calculates p/stdev)
- [ ] Test 4: Case File → Graph Node (transforms schedules to variants)
- [ ] Test 5: Full integration (Amplitude → Param → Graph end-to-end)
- [ ] Test 6: No orphaned fields (every mappable field has mapping)

**Gate:** ALL tests must pass before Phase 1. If any test fails, fix schemas or mappings.

**Output:** Document results in `SCHEMA_FIELD_MAPPING_VALIDATION_RESULTS.md`

---

#### 7. Create Fresh Sample Files (0.5 days)

**Purpose:** Test new schemas with realistic sample data; provide working examples for development.

**Directory:** `/param-registry/test/` (delete existing contents first - fresh start)

**Tasks:**

**7.1: Clean Slate**
- [ ] Delete all existing files in `/param-registry/test/` (we're starting fresh)
- [ ] Create new directory structure:
  ```
  /param-registry/test/
    /parameters/
      /probability/
      /cost/
      /duration/
    /cases/
    /nodes/
    /contexts/
    /events/
    /graphs/
  ```

**7.2: Parameter Examples (3+ files)**
- [ ] `conversion-rate.yaml` - Probability parameter with:
  - Full query expression
  - Values array with n, k, window_from, window_to
  - Override flags example
  - Connection configuration (Amplitude)
- [ ] `email-campaign-cost.yaml` - Cost parameter (GBP) with:
  - Values array with monetary amounts
  - Connection configuration (Google Sheets)
- [ ] `checkout-duration.yaml` - Duration parameter with:
  - Values array with time measurements
  - Conditional context example

**7.3: Case Examples (2+ files)**
- [ ] `checkout-redesign.yaml` - A/B test case with:
  - Schedules array (time-windowed variants)
  - window_from/window_to fields
  - Connection configuration (Statsig/Optimizely)
  - description_overridden example
- [ ] `payment-provider.yaml` - Multi-variant case

**7.4: Node Registry (5+ files)**
- [ ] `product-page.yaml`, `shopping-cart.yaml`, `checkout.yaml`, `payment.yaml`, `confirmation.yaml`
- Each with:
  - Node ID, label, description
  - event_id field (linked to events registry)
  - Override flags where appropriate

**7.5: Context Registry (2+ files)**
- [ ] `device.yaml` - Device context (mobile/desktop/tablet)
- [ ] `channel.yaml` - Acquisition channel context

**7.6: Event Registry (3+ files)**
- [ ] `page_view.yaml`, `add_to_cart.yaml`, `purchase.yaml`
- Each with:
  - event_id, name, description
  - Amplitude connector configuration (event mappings)

**7.7: Index Files**
- [ ] `parameters-index.yaml` - List all parameter files
- [ ] `cases-index.yaml` - List all case files
- [ ] `nodes-index.yaml` - List all node files
- [ ] `contexts-index.yaml` - List all context files
- [ ] `events-index.yaml` - List all event files

**7.8: Sample Graph**
- [ ] `/graphs/checkout-flow.json` - Complete graph using new schema:
  - Nodes with new structure (uuid, id, event_id, override flags)
  - Edges with new parameter structure (mean, evidence, override flags)
  - Edge labels (auto-derived)
  - Parameter IDs linking to parameter files
  - Case IDs linking to case files

**Why this matters:**
- Tests that schemas actually work with real data
- Provides working examples for Phase 1 development
- Validates UpdateManager against concrete examples
- Serves as documentation for schema usage

**Deliverables:**
- [ ] Fresh `/param-registry/test/` directory with complete examples
- [ ] All YAML files validate against their schemas
- [ ] Sample graph loads without errors in graph editor
- [ ] Can demonstrate full data flow: External → File → Graph

---

### Phase 0 Acceptance Criteria

**Gate 1: Schemas Updated + Sample Files**
- [ ] All schemas validate against JSON Schema spec
- [ ] **NOTE:** Backward compatibility NOT required (fresh start)
- [ ] Override fields added (all optional)
- [ ] Evidence structure added to edge parameters
- [ ] Fresh sample YAML files created in `/param-registry/test/` (inthe appropriate directories, per existing pattern) for:
  - [ ] Parameters (at least 3 examples: probability, cost, duration)
  - [ ] Cases (at least 2 examples with schedules)
  - [ ] Nodes (at least 5 examples with event_id)
  - [ ] Contexts (at least 2 examples)
  - [ ] Events (at least 3 examples with Amplitude mappings)
  - [ ] Index files for each type
  - [ ] Sample graph JSON with new schema structure

**Gate 2: Field Mappings Validated** 🚨
- [ ] SCHEMA_FIELD_MAPPINGS.md reviewed and accurate
- [ ] NO field name mismatches across schemas
- [ ] NO type mismatches
- [ ] All auto-populatable fields have mappings OR documented exclusions

**Gate 3: UpdateManager Tests Passing** 🚨
- [ ] All 6 integration tests passing
- [ ] No TypeScript errors in updateManager.ts
- [ ] UpdateManager proves schemas dovetail correctly

**Other Acceptance Criteria:**
- [ ] Events registry working (can create/edit/view events)
- [ ] QueryExpressionEditor prototype showing in edge properties
- [ ] Credentials UI allows entering Google Sheets + Amplitude credentials
- [ ] All existing tests still pass (no regressions)

**If Gates 2 or 3 fail:** Do NOT proceed to Phase 1. Fix schemas/mappings first.

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

