# Context Parameters - Updates Based on Feedback

**Date:** October 21, 2025

---

## Summary of Changes

Three important clarifications were made to the context parameters design:

---

## 1. File Location Strategy ✅

**Issue:** Where should registry files (contexts, parameters) live?

**Decision:** Separate schemas from data

### This Repo (`dagnet/`)
**Contains:**
- ✅ **Schemas** (canonical validation):
  - `param-registry/schemas/context-schema.yaml`
  - `param-registry/schemas/parameter-schema.yaml`
  - `param-registry/schemas/registry-schema.yaml`

- ✅ **Example data** (for development):
  - `param-registry/contexts.yaml` (example)
  - `param-registry/examples/` (sample parameters)

### Production Registry Repo (`dagnet-registry/`)
**Contains:**
- ✅ **Production data**:
  - `contexts.yaml` (production contexts)
  - `registry.yaml` (production parameter index)
  - `parameters/` (production parameters)

### Configuration
```bash
# .env
VITE_PARAM_REGISTRY_URL=https://raw.githubusercontent.com/yourorg/dagnet-registry/main
```

### Benefits
- ✅ Schemas version-locked with application code
- ✅ Data can be updated independently
- ✅ Different permissions (not all devs can edit production params)
- ✅ Validation on data changes via GitHub Actions
- ✅ Clear separation of code vs data

**See:** `REGISTRY_DEPLOYMENT_STRATEGY.md` for full details

---

## 2. Context Schema Created ✅

**Issue:** We have schemas for parameters and registry, but not for contexts

**Solution:** Created `param-registry/schemas/context-schema.yaml`

### Schema Covers
- ✅ Context structure (id, name, type, values)
- ✅ Context types (categorical, ordinal, continuous)
- ✅ Value definitions (id, label, description, order)
- ✅ Metadata (category, data_source, version, status)
- ✅ Validation rules (ordinal contexts must have order values)
- ✅ Comparison support for ordinal contexts

### Example Validation
```yaml
contexts:
  - id: channel
    name: "Marketing Channel"
    type: categorical
    values:
      - id: google
        label: "Google Ads"
      - id: facebook
        label: "Facebook Ads"
    metadata:
      category: marketing
      status: "active"
```

### Updated Files
- ✅ Created: `param-registry/schemas/context-schema.yaml`
- ✅ Updated: `param-registry/contexts.yaml` to comply with schema
- ✅ Updated: `CONTEXT_PARAMETERS_ROADMAP.md` (mark schema as complete)

---

## 3. Conditional Probability UI Design ✅

**Issue:** How should UI accommodate selecting both visited nodes AND context filters?

**Solution:** Combined selector in conditional probability editor

### UI Approach: Combined Selector

**Single interface for both conditions:**

```
┌─ Add Conditional Probability ─────────────────┐
│                                                │
│ ▼ Visited Nodes (optional)                    │
│   ☑ landing-page                              │
│   ☑ pricing                                   │
│   ☐ product-details                           │
│                                                │
│ ▼ Context Filters (optional)                  │
│   Channel:  [Google Ads    ▼]  [Remove]      │
│   Device:   [Mobile        ▼]  [Remove]      │
│   [+ Add Context Filter]                      │
│                                                │
│ Probability: [0.45] ± [0.05]                  │
│                                                │
│ [Link to Registry Parameter]                  │
│ [Save]  [Cancel]                               │
└────────────────────────────────────────────────┘
```

### Key Features
- ✅ Both visited nodes and context in same condition
- ✅ Either or both can be specified
- ✅ Visual grouping makes relationship clear
- ✅ Can link to registry parameter that matches conditions
- ✅ Backward compatible (no breaking changes)

### Components to Build

1. **ConditionalProbabilityEditor** (extend existing)
   - Add context filter section
   - Support combinations

2. **VisitedNodesSelector** (exists, may need polish)
   - Multi-select checkbox list from local graph nodes
   - Search/filter by node slug/label

3. **ContextFilterSelector** (NEW)
   - Add/remove context filters
   - Context dropdown populated from registry
   - Value dropdown populated from selected context
   - Preview of generated reference

4. **ParameterBrowser** (NEW)
   - Browse registry parameters
   - Filter by conditions (visited + context)
   - Show exact/partial matches
   - Create new parameter if none match

### Data Structure

```typescript
interface ConditionalProbability {
  // Structural condition (from local graph)
  visited_nodes?: string[];  // Node slugs
  
  // External condition (from registry)
  context_filter?: ContextFilter;  // e.g., { channel: 'google', device: 'mobile' }
  
  // The probability when conditions match
  p: {
    mean?: number;
    stdev?: number;
    parameter_id?: string;  // Link to registry
    locked?: boolean;
  };
}
```

### Resolution Example

Given edge `signup` with conditions:
1. `visited=[pricing], context={channel: google}` → 45%
2. `visited=[pricing]` → 40%
3. `context={channel: google}` → 35%
4. (base, no conditions) → 30%

**User state:** Visited pricing page, from Google

**Resolution:** Matches condition 1 (most specific) → **45%**

**See:** `CONDITIONAL_PROBABILITY_UI_DESIGN.md` for full details

---

## Implementation Impact

### Phase 1: Core Infrastructure
- ✅ Context schema ready
- ✅ Example contexts.yaml ready
- ⏳ Need to extend TypeScript types

### Phase 2: Resolution Logic
- ⏳ Extend to handle context_filter in conditional_p
- ⏳ Update resolution algorithm

### Phase 3: UI Components
- ⏳ Build ContextFilterSelector
- ⏳ Extend ConditionalProbabilityEditor
- ⏳ Build ParameterBrowser

### Deployment Strategy
- ✅ Development: Use local examples
- ✅ Production: Fetch from dagnet-registry repo
- ✅ Validation: Schemas always from app repo
- ✅ CI/CD: Validate data changes on PR

---

## Files Created/Updated

### New Files
1. `REGISTRY_DEPLOYMENT_STRATEGY.md` - File location and deployment strategy
2. `param-registry/schemas/context-schema.yaml` - Context validation schema
3. `CONDITIONAL_PROBABILITY_UI_DESIGN.md` - UI component designs
4. `CONTEXT_PARAMETERS_UPDATES.md` - This document

### Updated Files
1. `param-registry/contexts.yaml` - Added schema-compliant fields
2. `CONTEXT_PARAMETERS_ROADMAP.md` - Marked schema as complete
3. `CONTEXT_PARAMETERS_SUMMARY.md` - Added new file references

---

## Action Items

### Before Implementation
- [ ] Create `dagnet-registry` repository (or similar)
- [ ] Decide on registry URL for production
- [ ] Set up GitHub Actions for validation

### Phase 1 Implementation
- [x] Context schema complete
- [ ] Extend TypeScript types with context fields
- [ ] Add context_filter to ConditionalProbability type
- [ ] Update reference parser for context

### Phase 3 Implementation
- [ ] Build ContextFilterSelector component
- [ ] Extend ConditionalProbabilityEditor UI
- [ ] Build ParameterBrowser component
- [ ] Test visited + context combinations

---

## Open Questions (from earlier)

### Q1: Context Value Validation
**Decision:** Strict validation (reject unknown context values)
**Status:** ✅ Schema enforces this

### Q2: Default Context State
**Decision:** All contexts active by default
**Status:** ⏳ Implement in UI

### Q3: Naming Convention
**Decision:** 
- Context IDs: `snake_case` (e.g., `utm_source`)
- Context values: `kebab-case` (e.g., `google-ads`)
**Status:** ✅ Applied in examples

### Q4: Implementation Timing
**Decision:** Parallel with Phase 0 (parameter loader)
**Status:** ⏳ Awaiting start

---

## Summary

All three issues addressed:

1. ✅ **File location:** Clear separation (schemas in app, data in registry repo)
2. ✅ **Context schema:** Created and contexts.yaml compliant
3. ✅ **Conditional UI:** Designed combined selector for visited + context

**Ready to proceed with implementation!**



