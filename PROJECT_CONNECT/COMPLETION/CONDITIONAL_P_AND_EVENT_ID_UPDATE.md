# Conditional Probabilities & Event ID Schema Update

**Status:** Complete  
**Date:** 2025-11-06  
**Phase:** 1B (Data Operations)

---

## Summary

Implemented support for conditional probabilities and standardized `event_id` naming across all schemas and mappings.

---

## Changes Made

### 1. Conditional Probabilities Support

**Problem:**
- `edge.conditional_p[]` is an array of conditional probability parameters
- Each element has its own `parameter_id` reference to a parameter file
- Mappings need to handle array elements, not just flat fields

**Solution:**
- Conditional probabilities **reuse the same mappings** as `edge.p`
- The `dataOperationsService` is responsible for:
  1. Finding the correct `conditional_p[i]` element by matching `p.parameter_id`
  2. Passing `conditional_p[i].p` (the `ProbabilityParam` object) to `UpdateManager`
  3. Replacing `conditional_p[i].p` with the updated object after the operation

**Files Updated:**
- `/home/gjbm2/dev/dagnet/graph-editor/src/services/UpdateManager.ts`
  - Added documentation comments explaining conditional probability handling
  - Flows G (file → graph) and B (graph → file) now support conditional probabilities via sub-object targeting

**Implementation Notes:**
- No special array syntax needed in mappings (`conditional_p[match]` approach was abandoned)
- Clean, simple design: pass the right sub-object, mappings work identically for `p` and `conditional_p[i].p`
- **dataOperationsService NOT YET UPDATED** - this is future work when conditional probabilities are actually used in the UI

---

### 2. Event ID Naming Standardization

**Problem:**
- Graph schema used flat `node.event_id` field
- Inconsistent with nested `node.case.id` pattern
- Mixed naming convention (`event_id` vs `case.id`)

**Solution:**
- Changed `node.event_id` → `node.event.id`
- Updated schema to use nested object structure:
  ```json
  "event": {
    "id": "page_view",
    "id_overridden": false
  }
  ```

**Files Updated:**
- `/home/gjbm2/dev/dagnet/graph-editor/public/schemas/schema/conversion-graph-1.0.0.json`
  - Replaced flat `event_id` and `event_id_overridden` with nested `event` object
  - Schema now consistent with `case` object pattern

- `/home/gjbm2/dev/dagnet/graph-editor/src/services/UpdateManager.ts`
  - Updated Flow D (graph → file/node) mappings to use `event.id` source field
  - Updated Flow I (file/node → graph) mappings to use `event.id` target field and `event.id_overridden` flag
  - Updated documentation comments to reference `event.id` instead of `event_id`

- `/home/gjbm2/dev/dagnet/graph-editor/src/services/UpdateManager.test.ts`
  - Updated conflict detection test to use nested `event` object structure
  - Fixed test assertion to check `target.event?.id` instead of `target.event_id`

- `/home/gjbm2/dev/dagnet/PROJECT_CONNECT/CURRENT/DATA_MODEL_HIERARCHY.md`
  - Updated diagram to show `node.event.id` structure
  - Removed *** WHY IS THIS _ID NOT .ID? *** marker
  - Added clarification note about schema update for consistency

---

## Data Model Updates

### Node Structure (Before)
```typescript
{
  uuid: "abc-123",
  id: "checkout-start",
  label: "Checkout Start",
  event_id: "page_view",           // FLAT
  event_id_overridden: false,
  case: {                          // NESTED (inconsistent!)
    id: "product-variants"
  }
}
```

### Node Structure (After)
```typescript
{
  uuid: "abc-123",
  id: "checkout-start",
  label: "Checkout Start",
  event: {                         // NESTED (consistent!)
    id: "page_view",
    id_overridden: false
  },
  case: {                          // NESTED
    id: "product-variants"
  }
}
```

---

## Key Foreign Key Relationships (Updated)

```
node.node_id ────────────FK────> NODE FILE (optional, shared definition)
node.event.id ───────────FK────> EVENT FILE (optional, event schema reference)
node.case.id ────────────FK────> CASE FILE (only for case nodes)

edge.p.id ───────────────FK────> PARAMETER FILE (optional, probability param)
edge.cost_gbp.id ────────FK────> PARAMETER FILE (optional, cost param)
edge.cost_time.id ───────FK────> PARAMETER FILE (optional, duration param)
edge.conditional_p[i].p.id ─FK─> PARAMETER FILE (0-N conditional probability params)
```

**Naming is now consistent:** All foreign keys use `.id` pattern (nested where appropriate).

---

## Testing Impact

### UpdateManager Tests
- ✅ 1 test updated for new `event` object structure
- ✅ All existing tests still pass (conditional probabilities not yet tested, as UI not implemented)

### Integration Tests
- ⚠️ **Backward compatibility:** This is a **BREAKING CHANGE**
  - Old graphs with flat `event_id` will NOT validate against new schema
  - Migration is required for existing data
  - **No migration script provided** - this is a fresh schema approach

---

## Future Work

### Immediate (Phase 1B)
- [ ] Update `dataOperationsService` to handle conditional probabilities
  - Implement `getConditionalParameterFromFile(paramId, edgeId, conditionIndex, ...)`
  - Implement `putConditionalParameterToFile(paramId, edgeId, conditionIndex, ...)`
  - These methods will find the correct `conditional_p[i]` element and pass its `.p` sub-object to `UpdateManager`

### Properties Panel (Phase 1D)
- [ ] Update UI to display `node.event.id` correctly
- [ ] Update UI selectors to set `node.event.id` correctly
- [ ] Add conditional probabilities section to edge properties panel

### Migration (If Needed)
- [ ] Create migration script to convert `event_id` → `event.id` for existing graphs
- [ ] Update graph loader to handle backward compatibility (fallback read old format)

---

## Verification Checklist

- [x] Schema updated for `node.event` object
- [x] UpdateManager mappings updated for `event.id`
- [x] UpdateManager tests updated for new structure
- [x] Documentation updated (DATA_MODEL_HIERARCHY.md)
- [x] Conditional probabilities mapping strategy documented
- [ ] UI code updated (Properties Panel, EnhancedSelector) - **NOT YET DONE**
- [ ] dataOperationsService updated for conditional probabilities - **NOT YET DONE**
- [ ] End-to-end test for conditional probabilities - **NOT YET DONE**

---

## Breaking Changes

**⚠️ BREAKING:** This update is NOT backward compatible with graphs using flat `event_id`.

**Migration Required:** Any existing graphs must be migrated to use `event.id` structure.

**Recommended Approach:**
1. For new projects: Use this schema from day 1
2. For existing projects: Create migration script OR manually update graph files

---

## Related Documents

- [DATA_MODEL_HIERARCHY.md](../CURRENT/DATA_MODEL_HIERARCHY.md) - Updated with new structure
- [DATA_CONNECTIONS_IMPLEMENTATION_PLAN_V2.md](../CURRENT/DATA_CONNECTIONS_IMPLEMENTATION_PLAN_V2.md) - Implementation roadmap
- [OVERRIDE_PATTERN_DESIGN.md](../CURRENT/OVERRIDE_PATTERN_DESIGN.md) - Override pattern used for `id_overridden` flags



