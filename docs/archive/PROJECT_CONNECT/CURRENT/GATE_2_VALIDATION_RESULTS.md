# Gate 2: Field Mapping Validation Results

**Date:** 2025-11-05  
**Phase:** 0.2 - Schema Field Mapping Validation  
**Status:** ✅ COMPLETE

---

## Summary

Systematically validated all field mappings between schemas and mapping documents. Found and fixed **8 critical field name mismatches** that would have caused runtime failures during UpdateManager implementation.

---

## Critical Issues Found & Fixed

### 🚨 Issue 1: Probability Field Names (HIGH SEVERITY)
**Problem:** Mapping documents used obsolete `p.p` and `p.p_overridden` field names  
**Actual Schema:** Uses `p.mean` and `p.mean_overridden`  
**Impact:** Would cause null reference errors in all probability mappings

**Files Fixed:**
- `SCHEMA_FIELD_MAPPINGS.md` (6 instances)
- `MAPPING_TYPES.md` (4 mapping configurations)

**Affected Mappings:**
- `graph_to_file.APPEND.parameter`
- `file_to_graph.UPDATE.parameter`
- `external_to_graph.UPDATE.parameter`
- `external_to_file.APPEND.parameter`

---

### 🚨 Issue 2: Node Registry Field Names (HIGH SEVERITY)
**Problem:** Mapping documents incorrectly used `label` for node registry  
**Actual Schema:** Node registry uses `name`, not `label`  
**Impact:** Would fail to sync node metadata from registry to graph

**Files Fixed:**
- `SCHEMA_FIELD_MAPPINGS.md` (1 instance)
- `MAPPING_TYPES.md` (2 mapping configurations)

**Affected Mappings:**
- `graph_to_file.CREATE.node` (line 496)
- `file_to_graph.UPDATE.node` (line 547)

---

### 🚨 Issue 3: UUID/ID Terminology (MEDIUM SEVERITY)
**Problem:** Pre-Phase 0.0 terminology (`id` for UUID, `slug` for human-readable)  
**Actual Schema:** Uses `uuid` (system) and `id` (human-readable) after Phase 0.0  
**Impact:** Would cause confusion and incorrect lookups during implementation

**Files Fixed:**
- `SCHEMA_FIELD_MAPPINGS.md` (all tables updated)
- `MAPPING_TYPES.md` (added clarifying comments)

**Changes:**
- `node.slug` → `node.id` (human-readable)
- `node.id` (as UUID) → `node.uuid`
- `edge.slug` → `edge.id` (human-readable)
- `edge.id` (as UUID) → `edge.uuid`

---

### 🚨 Issue 4: Case Schedule Field Names (LOW SEVERITY)
**Problem:** Used `start_date`/`end_date` instead of `window_from`/`window_to`  
**Actual Schema:** Uses temporal window naming consistent with parameter values  
**Impact:** Would fail to map case schedules correctly

**Files Fixed:**
- `SCHEMA_FIELD_MAPPINGS.md` (2 instances)

---

### 🚨 Issue 5: Cost Parameter Field Names (MEDIUM SEVERITY)
**Problem:** Documented as `cost_gbp.amount` and `cost_time.duration`  
**Actual Schema:** Uses `cost_gbp.mean` and `cost_time.mean` (consistent with probability)  
**Impact:** Would fail to map cost parameters

**Files Fixed:**
- `SCHEMA_FIELD_MAPPINGS.md` (1 instance)

---

### 🚨 Issue 6: Removed Obsolete Fields (LOW SEVERITY)
**Problem:** Parameter schema documented `condition_overridden` field  
**Actual Schema:** Field removed in Phase 0.1 (conditions encoded in query DSL)  
**Impact:** Documentation misalignment

**Files Fixed:**
- `SCHEMA_FIELD_MAPPINGS.md` (1 instance)

---

### 🚨 Issue 7: Case Parameter ID Field (LOW SEVERITY)
**Problem:** Mapping showed `caseNode.id` → `case.id`  
**Actual Schema:** Case files use `parameter_id` at root level, not `case.id`  
**Impact:** Would create invalid case files

**Files Fixed:**
- `MAPPING_TYPES.md` (1 mapping configuration)

**Affected Mappings:**
- `graph_to_file.CREATE.case` (line 480)

---

### 🚨 Issue 8: Missing UUID Documentation (LOW SEVERITY)
**Problem:** No explicit documentation of UUID auto-generation  
**Fix:** Added clarifying comments that `uuid` is system-generated and never mapped  
**Impact:** Would cause confusion during implementation

**Files Fixed:**
- `MAPPING_TYPES.md` (added comments to 3 CREATE mappings)

---

## Validation Checklist

### Field Name Consistency ✅
- [x] All `id` fields follow correct pattern (hyphen vs underscore)
- [x] All registry `name` fields correctly map to graph `label` fields
- [x] All `description` fields have clear sync rules
- [x] All override flags use `{field}_overridden` suffix pattern (updated to `mean_overridden`)
- [x] All evidence fields grouped under `.evidence` object
- [x] All temporal data uses `values[]` or `schedules[]` arrays
- [x] All temporal windows use `window_from`/`window_to` consistently

### Data Structure Alignment ✅
- [x] Edge.p structure matches parameter values structure (`mean`, not `p`)
- [x] Case node variants structure matches case file schedules structure
- [x] All connection fields (id, parameter_id, case.id) validated
- [x] All optional fields clearly documented
- [x] UUID fields documented as system-generated, never mapped

### Mapping Coverage ✅
- [x] All 18 mapping combinations documented
- [x] All 13 in-scope flows covered (A-I, L-M, Q-R)
- [x] No orphaned mappings (all reference valid schema fields)

### Type Consistency ✅
- [x] `mean`: number (0-1 for probability, ≥0 for costs)
- [x] `stdev`: number (≥0)
- [x] `n`, `k`: integer (≥0)
- [x] `window_from`, `window_to`: string (date-time format)
- [x] `uuid`: string (UUID v4 format)
- [x] `id`: string (pattern: `^[a-z0-9-]+$` or `^[a-z0-9_]+$` for events)

---

## Orphaned Fields Analysis

### Fields in Schema but NOT in Mappings (Intentional)
These fields are intentionally excluded from auto-mapping:

**Graph Node:**
- `uuid` - System-generated, never synced
- `layout.x`, `layout.y` - User positioning, never synced
- `layout.rank`, `layout.group`, `layout.color` - UI state, not data
- `tags` - Graph-specific categorization
- `absorbing`, `outcome_type` - Graph structure, not registry data
- `entry.is_start`, `entry.entry_weight` - Graph semantics

**Graph Edge:**
- `uuid` - System-generated, never synced
- `from`, `to` - Structural references, not data
- `fromHandle`, `toHandle` - UI state
- `weight_default` - Graph policy calculation
- `case_variant`, `case_id` - Structural, not parameter data
- `locked` - UI state

**Parameter File:**
- `metadata.*` - File metadata, not mapped to graph
- `connection.*` - Automation config, not graph data
- `source.*` - Data lineage, not graph data

**Node Registry:**
- `metadata.*` - File metadata, not mapped to graph
- `tags` - Registry categorization, not graph data
- `resources` - External documentation links

### Fields That SHOULD Be Mapped (All Accounted For) ✅
- Node: `id`, `name`, `description`, `event_id` ✅
- Parameter: `id`, `name`, `description`, `query`, `values[].mean/stdev/n/k/window_from/window_to` ✅
- Case: `parameter_id`, `name`, `description`, `variants`, `schedules[].variants/window_from/window_to` ✅

---

## Next Steps

### Phase 0.2 Gate 2: ✅ PASSED

All field mappings validated and corrected. Documents are now consistent with actual schemas.

### Ready for Phase 0.3: UpdateManager Implementation

With validated field mappings, we can now safely implement the UpdateManager class with confidence that:
1. All field names match actual schemas
2. All mappings are bidirectionally consistent
3. All override flags use correct naming
4. No orphaned or missing mappings exist

**Recommendation:** Proceed to UpdateManager implementation (Phase 0.3).

---

## Confidence Level

**High Confidence (95%)** that all field mappings are now correct and aligned across:
- Actual schema files (YAML/JSON)
- `SCHEMA_FIELD_MAPPINGS.md` (field-by-field mapping table)
- `MAPPING_TYPES.md` (hierarchical architecture and code examples)

**Remaining 5% Risk:**
- Conditional probability field structure (newly added in Phase 0.1)
- Edge data_source metadata (flexible structure)
- External source-specific metadata fields (varies by connector)

These will be validated during actual connector implementation in Phase 1.

