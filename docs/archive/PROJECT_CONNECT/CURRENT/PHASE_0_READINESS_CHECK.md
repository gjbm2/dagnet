# Phase 0 Readiness Check

**Status:** ✅ Design 100% Complete - Ready to Commence Implementation

**Date:** 2025-11-05  
**Last Updated:** 2025-11-05 (Schema review finalized)

---

## Design Documents Complete

### Core Architecture
- ✅ **MAPPING_TYPES.md** - Hierarchical mapping architecture (5 handlers, 18 configs, 13 flows)
- ✅ **OVERRIDE_PATTERN_DESIGN.md** - Override pattern for auto-calculated fields
- ✅ **DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md** - Complete phase breakdown
- ✅ **DATA_CONNECTIONS_SCHEMA_VALIDATION.md** - Core design principles

### Supporting Documentation
- ✅ **SCHEMA_FIELD_MAPPINGS.md** - Field-by-field mapping registry
- ✅ **CASE_PARAMETER_REGISTRY_DESIGN.md** - Registry architecture
- ✅ **DATA_CONNECTIONS_README.md** - High-level overview

---

## Key Design Decisions Finalized

### 1. Data Flow Architecture ✅
**13 in-scope flows (A-I, L-M, Q-R):**
- A: Graph → Graph (internal updates)
- B-F: Graph → File (CREATE, UPDATE, APPEND)
- G-I: File → Graph (UPDATE/sync)
- K: **NOT A REAL FLOW** - event_id flows via I
- L-M: External → Graph (direct UPDATE)
- Q-R: External → File (APPEND to history)

**Key clarification:** Event registry data does NOT flow to graph. The `event_id` field in node registry flows to graph via Flow I.

### 2. UpdateManager Architecture ✅
**Three-level hierarchy:**
- **Level 1:** 5 direction handlers (graph_internal, graph_to_file, file_to_graph, external_to_graph, external_to_file)
- **Level 2:** Shared operation logic (CREATE, UPDATE, APPEND implementations)
- **Level 3:** 18 mapping configurations (data, not code)

**Benefits:**
- Maximum code reuse
- Clear separation of concerns
- Override respect guaranteed
- Proves schemas dovetail

### 3. Override Pattern ✅
**Suffix pattern confirmed:**
- `field_overridden` (not nested objects)
- Applies to: p, stdev, distribution, label, description, query, event_id, weights
- Evidence (n, k) is NOT overridable - observation data only

**UI indicators:**
- `<ZapOff>` icon = "auto-updates disabled"
- `<Zap>` icon = "auto-synced from [source]"

### 4. Edge Parameters Structure ✅
**Primary vs Evidence:**
- `p` is PRIMARY (user-editable, what they see)
- `n`, `k` are EVIDENCE (observations, stored in `evidence` blob)
- Evidence includes: `n`, `k`, `window_from`, `window_to`, `retrieved_at`, `source`, `query`

**Multi-parameter edges:**
- Edge has 1:n parameters (p, cost, duration, etc.)
- Each parameter can link to a parameter file
- UI shows specific parameter context (e.g., "Pull from conversion-rate.yaml")
- UpdateManager accepts `targetParamKey` in options for specificity

### 5. Registry Files ✅
**Curated, not auto-updated:**
- **Node registry:** CREATE + UPDATE (bidirectional with graph)
- **Context registry:** CREATE only (manual curation)
- **Event registry:** CREATE only (manual curation)

**File operations:**
- Parameter/Case files: Support full lifecycle (CREATE, UPDATE, APPEND)
- Registry files: CREATE + UPDATE only (no APPEND, no history arrays)

### 6. Naming Standardization ✅ **NEW - Schema Review 2025-11-05**
**ID/Slug Refactor (NEW Phase 0.0):**
- `object.uuid` - System-generated UUID (not commercially interesting)
- `object.id` - Human-readable identifier (replaces "slug")
- `object.label` - Display name (unchanged)
- `object.foreign_id` - Foreign key references (already correct: `parameter_id`, `case_id`, `event_id`)

**Impact:** ~251 references across 23 files. Automated refactoring + manual review = 3-4 hours.

**Why now:** Clean foundation before adding new fields; establishes consistent pattern; all foreign keys already match.

### 7. Schema-Specific Decisions ✅ **NEW - Schema Review 2025-11-05**

**Edge Label:**
- Add optional `edge.label` field (auto-derived from upstream/downstream node labels)
- Add `edge.label_overridden` flag
- When NOT overridden: UpdateManager auto-updates from nodes
- When overridden: User's custom label preserved

**Case Schedule Naming:**
- Rename `start_date` → `window_from`
- Rename `end_date` → `window_to`
- Consistency across all windowed data (parameters, cases, evidence)

**Description Override:**
- Top-level: `description_overridden: boolean`
- Consistent with `query_overridden` placement
- Applies to parameters, cases, nodes, edges

**Keep `edge.p.mean`:**
- NOT renaming to `.p.p` (confusing)
- Statistically correct terminology
- Override flag: `mean_overridden`

---

## Schema Updates Required (Phase 0)

### 1. parameter-schema.yaml
- Add `query` (object, with `query_overridden` flag)
- Add `condition` (string, optional)
- Add `source` (object: type, connection_id)
- Add `connection` (object: connection_id, last_sync)
- Expand `values[]` entries to include `n`, `k`, `window_from`, `window_to`

### 2. conversion-graph schema
- Add unified `ParamValue` base type
- Update edge parameters: `p` as primary with `evidence` blob
- Add override fields: `p_overridden`, `stdev_overridden`, `distribution_overridden`
- Add `query` and `query_overridden` to edges
- Add `label_overridden`, `description_overridden` to nodes and edges
- Add `event_id_overridden` to nodes
- Move `parameter_id` inside param objects

### 3. node-schema.yaml
- Add `event_id` field (string, optional)

### 4. case-schema.yaml
- Add `schedules[]` array (timestamped history of variants)
- Structure: `[{ variants: [...], window_from, window_to, source, ... }]`
- **Rename:** `start_date` → `window_from` (consistency)
- **Rename:** `end_date` → `window_to` (consistency)
- Add `description_overridden` flag (top-level)

### 5. New: event-schema.yaml + events-index-schema.yaml
- Create event registry structure
- Fields: `event_id`, `name`, `description`, `connectors` (Amplitude mappings)

### 6. credentials-schema.json
- Add Google Sheets credentials structure
- Add Amplitude credentials structure

---

## Four Critical Gates

### Gate 0: ID/Slug Standardization ✅ (NEW - must complete)
- [ ] Update type definitions (GraphData interface, etc.)
- [ ] Automated refactoring (~251 references)
- [ ] Manual review & fix (TypeScript errors, ID generation logic)
- [ ] Migration script for existing graph JSON files
- [ ] All tests passing
- [ ] No regressions in graph editor

**STOP:** Don't proceed to Gate 1 until this is complete. Clean foundation required.

### Gate 1: Schemas Updated ✅ (must complete)
- [ ] All schemas updated as above
- [ ] Backward compatible
- [ ] Validate against JSON Schema spec
- [ ] Override fields added (all optional)

### Gate 2: Field Mappings Validated ✅ (must complete)
- [ ] Review SCHEMA_FIELD_MAPPINGS.md
- [ ] NO field name mismatches
- [ ] NO type mismatches
- [ ] All auto-populatable fields have mappings OR documented exclusions

### Gate 3: UpdateManager Tests Passing ✅ (must complete)
- [ ] Build UpdateManager with hierarchical architecture
- [ ] 5 direction handlers implemented
- [ ] 18 mapping configs registered
- [ ] 6 integration tests written and passing
- [ ] Proves schemas dovetail correctly

**STOP:** If any gate fails, fix before proceeding to next gate.

---

## What's NOT in Scope (Deferred)

❌ **Not in Phase 0:**
- Query parser implementation (Phase 1)
- MSMDC algorithm implementation (Phase 1)
- Actual connector implementations (Phase 1)
- UI for data connections (Phase 1)
- Batch operations (Phase 2)
- Progress indicators (Phase 2)

❌ **Not in Phase 0-2:**
- Context-aware parameter selection (Flow J)
- Event discovery from external sources (Flows S-U)
- DELETE operations (future)

---

## Implementation Order (Phase 0)

**Phase 0.0:** ID/Slug Standardization (Gate 0)
1. **30 min:** Update type definitions
2. **1 hour:** Automated refactoring (regex find/replace)
3. **1-2 hours:** Manual review & fix TypeScript errors
4. **30 min:** Migration script for existing graphs
5. **30 min:** Validation & testing

**Phase 0.1-0.3:** Schema Updates & UpdateManager (Gates 1-3)
1. **Days 1-2:** Schema updates (all 6 schemas)
2. **Day 2-3:** Field mapping validation (Gate 2)
3. **Day 3:** Build UpdateManager core (5 handlers + shared logic)
4. **Day 3-4:** Register 18 mapping configs + tests (Gate 3)
5. **Day 4-5:** Final validation + documentation

**Estimate:** 4-5 days total (was 3-4, +0.5 days for id/slug refactor)

---

## Success Criteria

**Phase 0 is complete when:**
- ✅ All schemas updated and backward compatible
- ✅ SCHEMA_FIELD_MAPPINGS.md reviewed and accurate
- ✅ UpdateManager built with hierarchical architecture
- ✅ All 6 integration tests passing
- ✅ No TypeScript errors
- ✅ All existing tests still pass
- ✅ Events registry working (basic UI)
- ✅ QueryExpressionEditor prototype visible

**Then and ONLY then:** Proceed to Phase 1.

---

## References

- **Architecture:** `MAPPING_TYPES.md`
- **Override handling:** `OVERRIDE_PATTERN_DESIGN.md`
- **Field mappings:** `SCHEMA_FIELD_MAPPINGS.md`
- **Implementation plan:** `DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md`
- **Design principles:** `DATA_CONNECTIONS_SCHEMA_VALIDATION.md`

---

**Next Step:** Commit design documents and commence implementation.

