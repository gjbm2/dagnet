# Phase 1D: Properties Panel Schema Alignment & Data Model Display

**Date:** 2025-11-05  
**Updated:** 2025-11-06  
**Purpose:** Update properties panel to reflect Phase 0 schema changes AND properly display data model hierarchy  
**Status:** Implementation required

---

## Overview

The graph schema was updated in Phase 0 with several breaking changes:
- `id` → `uuid`, `slug` → `id` renaming
- `edge.p` structure with `mean`, `mean_overridden`, `evidence` blob
- `edge.label` and `edge.label_overridden` addition
- `node.event_id` addition
- Various `_overridden` flags throughout

**CRITICAL ADDITION (2025-11-06):**
The properties panel must clearly distinguish between different layers of metadata:
- **Graph object metadata** (node.label, edge.label, etc.) - editable, owned by graph
- **Connected file metadata** (parameter.name, case.name, etc.) - read-only display for context
- **Synced data values** (edge.p.mean, node.case.variants, etc.) - editable, with override flags

**See:** [DATA_MODEL_HIERARCHY.md](./DATA_MODEL_HIERARCHY.md) for complete data model documentation.

This audit identifies all locations in PropertiesPanel that need to be updated to reflect these changes.

---

## Schema Reference (Phase 0 Final)

### Edge Schema (Key Fields)
```typescript
interface GraphEdge {
  uuid: string;              // System identifier
  id?: string;               // Human-readable ID
  from: string;              // node uuid
  to: string;                // node uuid
  label?: string;            // NEW: display label
  label_overridden?: boolean; // NEW
  
  p: {
    mean: number;            // Primary probability (was edge.p)
    mean_overridden?: boolean;
    stdev?: number;
    stdev_overridden?: boolean;
    distribution?: string;
    distribution_overridden?: boolean;
    evidence?: {             // NEW: observational data
      n?: number;
      k?: number;
      window_from?: string;
      window_to?: string;
      retrieved_at: string;
      source: 'amplitude' | 'sheets' | 'manual' | 'computed' | 'api';
      query?: object;
    };
  };
  
  cost_gbp?: {
    mean: number;
    mean_overridden?: boolean;
    stdev?: number;
    stdev_overridden?: boolean;
  };
  
  cost_time?: {
    mean: number;
    mean_overridden?: boolean;
    stdev?: number;
    stdev_overridden?: boolean;
    unit?: 'seconds' | 'minutes' | 'hours' | 'days';
  };
  
  parameter_id?: string;         // Link to probability param file
  cost_gbp_parameter_id?: string;
  cost_time_parameter_id?: string;
  
  query?: string;                // Query expression
  query_overridden?: boolean;    // NEW
  
  conditional_p?: Array<{...}>;  // Conditional probabilities
  
  description?: string;
  description_overridden?: boolean; // NEW
}
```

### Node Schema (Key Fields)
```typescript
interface GraphNode {
  uuid: string;              // System identifier
  id?: string;               // Human-readable ID
  label: string;             // Display label
  label_overridden?: boolean;
  description?: string;
  description_overridden?: boolean;
  
  event_id?: string;         // Link to event registry
  event_id_overridden?: boolean;
  
  // Case node fields (SIMPLIFIED)
  case_id?: string;          // If present, this is a case node
                             // References /param-registry/cases/{case_id}.yaml
                             // Pull variants, weights, status, colors from file
                             // Unless specific fields are _overridden
  
  // Visual fields
  color?: string;
  position: { x: number; y: number };
  
  // Display options
  display?: {
    hideLabel?: boolean;
    hideIcon?: boolean;
  };
}
```

---

## Current State Analysis

### File: `PropertiesPanel.tsx` (2922 lines)

#### Edge Properties - Current Implementation
From `useEffect` that loads edge data (lines 229-277):

```typescript
setLocalEdgeData({
  id: edge.id || '',                                    // ✅ Correct (renamed from slug)
  parameter_id: (edge as any).parameter_id || '',       // ✅ Correct
  cost_gbp_parameter_id: (edge as any).cost_gbp_parameter_id || '', // ✅ Correct
  cost_time_parameter_id: (edge as any).cost_time_parameter_id || '', // ✅ Correct
  probability: edge.p?.mean || 0,                       // ✅ Correct (edge.p.mean)
  stdev: edge.p?.stdev || undefined,                    // ✅ Correct
  description: edge.description || '',                  // ✅ Correct
  cost_gbp: edgeCostGbp,                                // ⚠️ CHECK: Is this edge.cost_gbp object or edge.cost_gbp.mean?
  cost_time: edgeCostTime,                              // ⚠️ CHECK: Is this edge.cost_time object or edge.cost_time.mean?
  weight_default: edge.weight_default || 0,             // ✅ Correct (legacy?)
  display: edge.display || {},                          // ✅ Correct
  locked: edge.p?.locked || false,                      // ❌ WRONG: Should be edge.p.mean_overridden
  query: (edge as any).query || ''                      // ✅ Correct
});
```

#### Node Properties - Current Implementation
From `useEffect` that loads node data (lines 137-227):

```typescript
setLocalNodeData({
  id: node.id || '',                                    // ✅ Correct (renamed from slug)
  label: node.label || '',                              // ✅ Correct
  description: node.description || '',                  // ✅ Correct
  color: node.color || '#3B82F6',                       // ✅ Correct
  hideLabel: node.display?.hideLabel || false,          // ✅ Correct
  hideIcon: node.display?.hideIcon || false             // ✅ Correct
});

// Case node specific:
setCaseData({
  id: node.case?.id || '',                              // ✅ Correct
  // parameter_id removed - redundant with id (schema simplified)
  status: node.case?.status || 'active',                // ✅ Correct
  variants: node.case?.variants || []                   // ✅ Correct
});
```

---

## Issues Identified

### CRITICAL ISSUES

#### 1. **RESOLVED: `edge.label` - NOT NEEDED**
**Decision:** Edge labels don't need override flags  
**Reasoning:** Edges aren't canonical objects (no edge registry). Unlike nodes, edges only obtain meaning from the nodes they connect. They're a logical way of adhering properties to transitions between states.  
**Action:** 
- ✅ Remove `edge.label_overridden` from schema if present
- ✅ Edge parameters (p, cost_gbp, cost_time) CAN be overridden because they link to param files via parameter_id
- Edge label itself can exist for display purposes, but no override tracking

---

#### 2. **Evidence Display - Add to Edge Tooltip**
**Location:** Edge tooltip (not Properties Panel)  
**Issue:** No UI to show observational evidence (`n`, `k`, `window_from`, `window_to`)  
**Impact:** Users cannot see source data that informed the probability  
**Required Action:**
- **For Phase 1:** Add evidence display to edge tooltip
  - Format: "Based on n=1000, k=350 (Nov 1-5, 2025)"
  - Show source: "Retrieved from Amplitude on Nov 5"
- **Future:** Add dedicated "Data" panel to sidebar (add to `/TODO.md`) 

---

#### 3. **Missing: `node.event_id` Selector - CRITICAL**
**Location:** Node properties section  
**Issue:** No UI for linking nodes to events  
**Impact:** Users cannot associate nodes with event definitions  
**Required Action:**
- Add `EnhancedSelector` for event_id
  - Type: `'event'`
  - **Location:** New card after "Node Behaviour" card
  - **Note:** "Open Connected" button comes built-in with EnhancedSelector
  - For now, just the event_id selector (events are simple currently)
- See `PHASE_1_EVENTS_IMPLEMENTATION.md` for full Events UI spec

---

#### 4. **Wrong: `locked` → `mean_overridden` - CRITICAL**
**Location:** Edge probability section  
**Issue:** Using obsolete `edge.p.locked` instead of `edge.p.mean_overridden`  
**Impact:** Override tracking doesn't work correctly  
**Background:** `locked` was never actually implemented and is functionally superseded  
**Required Action:**
- ✅ Deprecate `edge.p.locked` in schema (mark as deprecated)
- Replace all `locked` references in code with `mean_overridden`
- Update UI to show `<ZapOff>` icon when overridden
- Remove any `locked` UI elements (checkboxes, etc.)


---

#### 5. **Missing: Override Indicators Throughout - CRITICAL**
**Location:** All editable fields  
**Issue:** No `<Zap>` / `<ZapOff>` icons to show override status  
**Impact:** Users cannot tell which fields are auto-synced vs manually overridden  
**Required Action:**
- **Create standard `OverrideIndicator` component** (reusable pattern)
  - Shows `<ZapOff>` when field is overridden
  - Clickable to remove override flag
  - Tooltip: "Manual override (click to allow auto-sync)"
- Add override indicator icons next to:
  - **Edge parameters:**
    - `edge.p.mean_overridden`
    - `edge.p.stdev_overridden`
    - `edge.p.distribution_overridden`
    - `edge.cost_gbp.mean_overridden`
    - `edge.cost_time.mean_overridden`
    - `edge.query_overridden`
  - **Node fields:**
    - `node.label_overridden`
    - `node.description_overridden`
    - `node.event_id_overridden`
- Follow pattern from `OVERRIDE_PATTERN_DESIGN.md`
- **Note:** NOT on `edge.description` or `edge.label` (no external source to override from)

---

#### 6. **NEW: Query Builder for Conditional Probabilities - CRITICAL**
**Location:** Conditional Probabilities cards  
**Issue:** Need interactive query/selector class for constructing condition expressions  
**Background:** Monaco test prototype exists, needs proper implementation and generalization  
**Required Action:**
- Build proper `QueryStringBuilder` component
  - Based on Monaco test prototype (under parameter_id field example)
  - Generates Query DSL syntax: `visited(A,B)`, `exclude(C)`, `context(device:mobile)`, `case(test:treatment)`
  - Interactive selector/builder pattern
- Update Conditional Probabilities cards
  - Use QueryStringBuilder for condition field (top part of card)
  - Allows users to specify precise conditions interactively
- Wire up to edge.conditional_p array
- See Query DSL documentation for full syntax

**Components needed:**
1. `QueryStringBuilder` - Main interactive builder component
2. Query syntax validator
3. Integration with Conditional Probabilities UI

**Priority:** CRITICAL - needed for conditional probabilities to be fully usable

---

### MEDIUM ISSUES

#### 6. **Cost Structure - Verify Current Implementation**
**Location:** Edge cost sections  
**Issue:** Structure was migrated some time ago, need to verify consistency  
**Background:** Cost structure was flattened previously; stale code may remain  
**Required Action:**
- Audit current implementation: ensure using `edge.cost_gbp.mean` and `edge.cost_time.mean` (object structure)
- Remove any stale code that treats costs as primitives
- Ensure consistency: schema ↔ types ↔ UI classes
- Add `mean_overridden` and `stdev_overridden` support for costs
- Add override indicators for cost fields

---

#### 7. **Missing: `query_overridden` Support**
**Location:** Edge query section  
**Issue:** No tracking of whether query was manually edited vs auto-generated  
**Impact:** MSMDC algorithm might overwrite user's custom queries  
**Required Action:**
- Add `query_overridden` flag management
- Show override indicator next to query editor
- Skip auto-generation if overridden

---

#### 8. **RESOLVED: `description_overridden` - Only on Nodes**
**Decision:** Override tracking only makes sense for canonical objects  
**Reasoning:** 
- **Edges:** No edge registry, not canonical. Description/label overrides don't make sense - no external source to override FROM
- **Nodes:** CAN have `description_overridden` because nodes link to node registry
- **Edge Parameters:** CAN be overridden because they link to param files via parameter_id
**Required Action:**
- ✅ Remove `edge.description_overridden` and `edge.label_overridden` from schema if present
- Add `node.description_overridden` support in UI (with override indicator)
- Keep parameter override support on edges (already planned)

---

#### 9. **Case Node Structure - Simplify to `case_id` Only**
**Location:** Case node properties  
**Issue:** Redundant structure - should just be `node.case_id`  
**Correct Design:**
- `node.case_id` (optional) - if present, this is a case node
- References case file: `/param-registry/cases/{case_id}.yaml`
- Pull data from case file: variants, weights, status, colors, etc.
- Override pattern applies: fields can be `_overridden` to prevent auto-sync from file
**Required Action:**
- ✅ Remove nested `node.case` object structure if present
- Use flat `node.case_id` field
- Check Props Panel uses `node.case_id` (not `node.case.id` or `node.case.parameter_id`)
- Update schema/types to match this simpler structure 

---

### LOW PRIORITY / COSMETIC

#### 10. **Inconsistent: ID vs Slug terminology**
**Location:** Various comments and labels  
**Issue:** Some comments still refer to "slug" instead of "id"  
**Impact:** Developer confusion  
**Required Action:**
- Update all comments to use "id" terminology
- Update any UI labels that say "slug"

---

## Detailed Audit Findings

### Section: Edge Properties - Probability

**Current Fields Shown:**
- ✅ ID (edge.id)
- ✅ Probability slider (edge.p.mean)
- ✅ Standard deviation input (edge.p.stdev)
- ✅ Distribution dropdown (edge.p.distribution)
- ✅ Parameter selector (edge.parameter_id)
- ✅ Query expression editor (edge.query)
- ✅ Conditional probabilities (edge.conditional_p)

**Missing:**
- ❌ Label input (edge.label)
- ❌ Label override indicator
- ❌ Probability override indicator (edge.p.mean_overridden)
- ❌ Stdev override indicator (edge.p.stdev_overridden)
- ❌ Distribution override indicator (edge.p.distribution_overridden)
- ❌ Evidence display (edge.p.evidence)
- ❌ Query override indicator (edge.query_overridden)
- ❌ Description override indicator (edge.description_overridden)

---

### Section: Edge Properties - Cost (£)

**Current Fields Shown:**
- ✅ Cost value input
- ✅ Parameter selector (edge.cost_gbp_parameter_id)

**Missing:**
- ❌ Cost override indicator (edge.cost_gbp.mean_overridden)
- ❌ Cost standard deviation (edge.cost_gbp.stdev)
- ❌ Evidence display (if applicable)

**Needs Verification:**
- ⚠️ Is cost stored as `edge.cost_gbp` (number) or `edge.cost_gbp.mean` (object)?

**CONFIRMED:** Schema uses flattened structure `edge.cost_gbp.mean` (CostParam object). Implementation needs audit to ensure consistency.

---

### Section: Edge Properties - Duration

**Current Fields Shown:**
- ✅ Duration value input
- ✅ Unit selector (seconds/minutes/hours/days)
- ✅ Parameter selector (edge.cost_time_parameter_id)

**Missing:**
- ❌ Duration override indicator (edge.cost_time.mean_overridden)
- ❌ Duration standard deviation (edge.cost_time.stdev)
- ❌ Evidence display (if applicable)

**Needs Verification:**
- ⚠️ Is duration stored as `edge.cost_time` (number) or `edge.cost_time.mean` (object)?

**CONFIRMED:** Schema uses flattened structure `edge.cost_time.mean` (CostParam object). Implementation needs audit to ensure consistency.

---

### Section: Node Properties

**Current Fields Shown:**
- ✅ ID (node.id)
- ✅ Label (node.label)
- ✅ Description (node.description)
- ✅ Color picker (node.color)
- ✅ Display options (hideLabel, hideIcon)
- ✅ Case fields (for case nodes)

**Missing:**
- ❌ Event selector (node.event_id) **CRITICAL**
- ❌ Label override indicator (node.label_overridden)
- ❌ Description override indicator (node.description_overridden)

---

### Section: Case Node Properties

**Current Fields Shown:**
- ✅ Case ID selector (node.case.id)
- ✅ Case status dropdown (node.case.status)
- ✅ Variants list (node.case.variants)
- ⚠️ Parameter ID selector (node.case.parameter_id) - VERIFY IF IN SCHEMA

**Missing:**
- Nothing identified (pending schema verification)

---

## Implementation Strategy

### Phase 1: Critical Fixes (High Priority)

**Time Estimate:** 4-6 hours

1. **Add `node.event_id` selector** (1 hour)
   - Copy pattern from case.id selector
   - Use EnhancedSelector with type='event'
   - Add to node properties after description

2. **Add `edge.label` input** (1 hour)
   - Add text input after edge.id
   - Wire to edge.label
   - Add label_overridden flag management

3. **Replace `locked` with `mean_overridden`** (1 hour)
   - Find all `edge.p.locked` references
   - Replace with `edge.p.mean_overridden`
   - Update checkbox/toggle UI

4. **Add override indicator icons** (2-3 hours)
   - Create OverrideIcon component (per OVERRIDE_PATTERN_DESIGN.md)
   - Add next to all overridable fields
   - Wire to `_overridden` flags
   - Add tooltips

5. **Add evidence display** (1 hour)
   - Create read-only display component
   - Show n, k, window dates if present
   - Place below probability slider

---

### Phase 2: Structure Fixes (Medium Priority)

**Time Estimate:** 3-4 hours

6. **Audit and fix cost structure** (2 hours)
   - Verify how costs are currently stored
   - Update to use `.mean` consistently
   - Add `.stdev` and `.mean_overridden` support

7. **Add `query_overridden` support** (1 hour)
   - Add flag management
   - Show override indicator
   - Update MSMDC logic to respect flag

8. **Add `description_overridden` support** (1 hour)
   - Add flag management for edge and node descriptions
   - Show override indicators

---

### Phase 3: Polish (Low Priority)

**Time Estimate:** 1-2 hours

9. **Update terminology** (1 hour)
   - Remove all "slug" references
   - Update comments

10. **Verify case.parameter_id** (30 min)
    - Check schema
    - Remove or document as needed

---

## Testing Plan

After implementation, verify:

- [ ] Node event selector works (can select, clear, open event file)
- [ ] Edge label input works independently of edge.id
- [ ] All override indicators show correct state
- [ ] Clicking override indicators toggles flags correctly
- [ ] Evidence display shows when present, hidden when not
- [ ] Cost/duration values save to `.mean` property
- [ ] Query override prevents MSMDC from overwriting
- [ ] Description overrides respected by "Get from File" operations
- [ ] All `_overridden` flags persist correctly across save/load

---

## Dependencies

- ✅ Phase 0.0-0.3 complete (schema updates, UpdateManager)
- ⏳ Phase 1 Events implementation (for event selector)
- ⏳ OverrideIcon component (to be created or imported from design docs)

---

## Risk Assessment

**High Risk:**
- Cost/duration structure changes (may affect existing graphs)
- Override flag behavior changes (may surprise users)

**Medium Risk:**
- UI complexity increase (many new indicators/fields)
- Performance impact (more reactive state)

**Low Risk:**
- Event selector addition (net new feature)
- Label field addition (net new feature)

---

## Recommendations

1. **Do Critical Fixes First:** Event selector and override indicators are user-facing
2. **Verify Cost Structure Early:** Could affect data integrity
3. **Create OverrideIcon Component Once:** Reuse everywhere for consistency
4. **Test With Real Data:** Use sample files from /param-registry/test/
5. **Consider Phased Rollout:** Could deploy Critical Fixes separately from Structure Fixes

---


