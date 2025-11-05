# Phase 1: Properties Panel Schema Alignment Audit

**Date:** 2025-11-05  
**Purpose:** Audit current edge and node properties panels to ensure full alignment with Phase 0 schema changes  
**Status:** Pre-implementation audit

---

## Overview

The graph schema was updated in Phase 0 with several breaking changes:
- `id` → `uuid`, `slug` → `id` renaming
- `edge.p` structure with `mean`, `mean_overridden`, `evidence` blob
- `edge.label` and `edge.label_overridden` addition
- `node.event_id` addition
- Various `_overridden` flags throughout

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
  label_overridden?: boolean; // NEW
  description?: string;
  description_overridden?: boolean; // NEW
  
  event_id?: string;         // NEW: link to event registry
  
  // Case node fields
  case?: {
    uuid: string;
    id?: string;
    status: 'active' | 'paused' | 'completed';
    variants: Array<{ name: string; weight: number }>;
  };
  
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
  parameter_id: node.case?.parameter_id || '',          // ⚠️ CHECK: Is this in schema?
  status: node.case?.status || 'active',                // ✅ Correct
  variants: node.case?.variants || []                   // ✅ Correct
});
```

---

## Issues Identified

### CRITICAL ISSUES

#### 1. **Missing: `edge.label` and `edge.label_overridden`**
**Location:** Edge properties section  
**Issue:** No UI for edge label (separate from edge.id)  
**Impact:** Users cannot set/edit edge labels independently of IDs  
**Required Action:**
- Add label input field to edge properties
- Add override indicator icon
- Wire to `edge.label` and `edge.label_overridden`

---

#### 2. **Missing: `edge.p.evidence` Display**
**Location:** Edge probability section  
**Issue:** No UI to show observational evidence (`n`, `k`, `window_from`, `window_to`)  
**Impact:** Users cannot see source data that informed the probability  
**Required Action:**
- Add read-only display section showing evidence (if present)
- Format: "Based on n=1000, k=350 (Nov 1-5, 2025)"
- Show source: "Retrieved from Amplitude on Nov 5"

---

#### 3. **Missing: `node.event_id` Field**
**Location:** Node properties section  
**Issue:** No UI for linking nodes to events  
**Impact:** Users cannot associate nodes with event definitions  
**Required Action:**
- Add `EnhancedSelector` for event_id (see Events implementation doc)
- Place after description field
- Include "Open Connected" button to view event file

---

#### 4. **Wrong: `locked` → `mean_overridden`**
**Location:** Edge probability section  
**Issue:** Using obsolete `edge.p.locked` instead of `edge.p.mean_overridden`  
**Impact:** Override tracking doesn't work correctly  
**Required Action:**
- Replace all `locked` references with `mean_overridden`
- Update UI to show `<ZapOff>` icon when overridden

---

#### 5. **Missing: Override Indicators Throughout**
**Location:** All editable fields  
**Issue:** No `<Zap>` / `<ZapOff>` icons to show override status  
**Impact:** Users cannot tell which fields are auto-synced vs manually overridden  
**Required Action:**
- Add override indicator icons next to:
  - `edge.label`
  - `edge.p.mean`
  - `edge.p.stdev`
  - `edge.p.distribution`
  - `edge.cost_gbp.mean`
  - `edge.cost_time.mean`
  - `edge.description`
  - `edge.query`
  - `node.label`
  - `node.description`
- Follow pattern from `OVERRIDE_PATTERN_DESIGN.md`

---

### MEDIUM ISSUES

#### 6. **Unclear: `cost_gbp` and `cost_time` Structure**
**Location:** Edge cost sections  
**Issue:** Code suggests these might be stored as primitives, but schema says they're objects  
**Impact:** May be loading/saving cost data incorrectly  
**Required Action:**
- Audit how costs are currently stored in graph
- Update to use `edge.cost_gbp.mean` and `edge.cost_time.mean`
- Add `mean_overridden` and `stdev` support for costs

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

#### 8. **Missing: `description_overridden` Support**
**Location:** Edge and node description fields  
**Issue:** No tracking of override status for descriptions  
**Impact:** File-to-graph pulls might overwrite user descriptions  
**Required Action:**
- Add `description_overridden` flag management
- Show override indicator next to description fields

---

#### 9. **Unclear: Case Node `parameter_id`**
**Location:** Case node properties  
**Issue:** Code references `node.case.parameter_id` but this may not be in schema  
**Impact:** Potential data structure mismatch  
**Required Action:**
- Verify if `case.parameter_id` is in schema
- If not, remove from UI
- If yes, ensure it's documented in schema

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


