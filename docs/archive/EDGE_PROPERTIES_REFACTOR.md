# Edge Properties Panel Refactor

**Status:** Ready for implementation  
**Estimated Effort:** 18-25 hours  
**Prerequisites:** Colour Assignment Service, schema updates

---

## Summary of Changes

This refactor brings Edge Properties to the same quality standard as Node Properties:

1. **Reorganize into CollapsibleSections** - Basic Properties, Parameters (with 3 collapsible sub-sections), Conditional Probabilities, Case Edge Info
2. **Add missing fields** - Description, Std Dev, Distribution (for all edges, not just non-case)
3. **Refactor Conditional Probabilities** - From flat list to accordion cards (like Case Variants)
4. **Fix Colour Picker** - Show selected custom colour, open at click location
5. **Add Colour Auto-Assignment** - Create reusable utility for Case Nodes and Conditional Probabilities
6. **Remove DELETE EDGE button** - Use Delete key (just fixed!) and context menu instead
7. **Add Case Edge Info slider** - Link to upstream case node variant weight

---

## Current Issues

1. **No Standardized Styling** - Edge properties don't match the quality/consistency of node properties
2. **Poor Organization** - All fields in flat list without logical grouping
3. **Preposterously Prominent Delete Button** - "DELETE EDGE" too prominent (if exists)
4. **Conditional Probabilities Not Accordion-Based** - Uses old `<ConditionalProbabilityEditor>` component instead of collapsible cards
5. **Missing Colour Picker** - Conditional probabilities have no colour picker for visual distinction
6. **ColourSelector Issues**:
   - Custom colour doesn't show in selected box after picking
   - Picker opens at (0,0) instead of click location

## Goals

1. Match the quality and organization of Node Properties Panel
2. Use CollapsibleSections for logical grouping
3. Accordion pattern for Conditional Probabilities (like Case Variants)
4. Add colour picker to each conditional probability
5. Fix ColourSelector component issues
6. Remove/tone down edge deletion UI

---

## Proposed Structure

### Section 1: Basic Properties
**Icon:** Settings  
**Default State:** Open

```
┌─ Basic Properties ──────────────────────────────┐
│                                                  │
│ Slug:                                            │
│ [________________________]                       │
│                                                  │
│ Description:                                     │
│ [________________________]                       │
│                                                  │
│ Weight Default: [___________]                    │
│ (Used to distribute residual probability...)    │
│                                                  │
└──────────────────────────────────────────────────┘
```

**Fields:**
- **Slug** (text input) - Edge identifier
- **Description** (text input) - Edge description
- **Weight Default** (number input) - Shown for all edges (not just non-case)

---

### Section 2: Parameters
**Icon:** Layers  
**Default State:** Open

**Note:** All parameter sub-sections are collapsible (use `CollapsibleSection`)

```
┌─ Parameters ─────────────────────────────────────┐
│                                                   │
│ ┌─ Probability ────────────────────────────────┐ │
│ │ Parameter: [EnhancedSelector____________]  │ │
│ │                                             │ │
│ │ [========●================] 0.75            │ │ (ProbabilityInput slider)
│ │ ⚖                                           │ │
│ │                                             │ │
│ │ Std Dev: [_______]                          │ │
│ │ Distribution: [___________]                 │ │
│ │ ☐ Locked Probability                        │ │
│ └─────────────────────────────────────────────┘ │
│                                                   │
│ ┌─ Cost (£) ──────────────────────────────────┐ │
│ │ Parameter: [EnhancedSelector____________]  │ │
│ │                                             │ │
│ │ Mean £: [_______]                           │ │
│ │ Std Dev: [_______]                          │ │
│ │ Distribution: [___________]                 │ │
│ └─────────────────────────────────────────────┘ │
│                                                   │
│ ┌─ Cost (Time) ───────────────────────────────┐ │
│ │ Parameter: [EnhancedSelector____________]  │ │
│ │                                             │ │
│ │ Mean days [_______]   
│ │ Std Dev: [_______]                          │ │
│ │ Distribution: [___________]                 │ │
│ └─────────────────────────────────────────────┘ │
│                                                   │
└───────────────────────────────────────────────────┘
```

**Questions:**
- Should sub-sections be collapsible too?  
    
    YES

- Or just visual separation with borders/backgrounds? 

    NO

- Probability slider: keep outside or move inside probability sub-section?

INSIDE AS SHOWN ABOVE

---

### Section 3: Conditional Probabilities
**Icon:** Box  
**Default State:** Open

```
┌─ Conditional Probabilities ──────────────────────┐
│                                                   │
│ ┌─────────────────────────────────────────────┐ │
│ │ ▼ [🔵] When: payment-success       ✏️    ✕ │ │
│ │                                             │ │
│ │  Node Condition:                            │ │
│ │  [EnhancedSelector: payment-success____]   │ │
│ │                                             │ │
│ │  Parameter:                                 │ │
│ │  [EnhancedSelector: prob-payment-high__]   │ │
│ │                                             │ │
│ │  Probability:                               │ │
│ │  [========●================] 0.85           │ │  <--- USE EXISTING SLIDER COMPONENT
│ │ Std Dev: [_______]                          │ │
│ │ Distribution: [___________]                 │ │
│ │                                             │ │
│ └─────────────────────────────────────────────┘ │
│                                                   │
│ ┌─────────────────────────────────────────────┐ │
│ │ ▶ [🟢] When: payment-failure       ✏️    ✕ │ │
│ └─────────────────────────────────────────────┘ │
│                                                   │
│ [+ Conditional Probability]                      │
│                                                   │
└───────────────────────────────────────────────────┘
```

**Pattern:** Same as Case Variants
- Each condition in its own collapsible card (`.variant-card`)
- Header shows:
  - Collapse/expand chevron
  - **Colour picker** (NEW!) - for visual distinction on graph 

            IT IS NOT NEW, IT WAS JUST BROKEN

  - Condition name (editable inline with pencil icon)

            NAMING IS OPTIONAL; WE SHOULD GENERATE A NAME AUTOMATICALLY FROM CONTEXT UNLESS USER CHOOSES TO OVERWRITE

  - Delete button (hidden when editing name)

            YES

- Content shows:
  - Node Condition (EnhancedSelector)   <-- NB ENSURE THAT POP-UP ALSO SHOWS NODES IN THIS GRAPH
  - Parameter (EnhancedSelector)
  - Probability value (ProbabilityInput with slider)


    SEE ABOVE

- "+ Conditional Probability" button at bottom (subdued `.property-add-btn` style)

**Questions:**
- Should collapsed state show colour + condition name only?

    YES, THOUGH CONDITION NAME  GENERATED DYNAMICALLY

- Should we show probability value in collapsed header (like "When: payment-success (85%)")?

    YES

- Colour picker position: before or after chevron?

    AFTER

---

## Case Edge Info Panel

**Location:** After Parameters section? Or special callout?

```
┌─ Case Edge Information ──────────────────────────┐
│ (info background styling)                         │
│                                                   │
│ Case Node: checkout-flow                          │
│ Variant: treatment (50.0% / 0.500)                │
│ Sub-Route Probability: 75% (0.750)                │
│                                                   │
│ ┌─ Effective Probability ─────────────────────┐  │
│ │ 37.5% (0.375)                                │  │
│ │ (Variant Weight × Sub-Route Probability)    │  │
│ └──────────────────────────────────────────────┘  │
│                                                   │
└───────────────────────────────────────────────────┘

YES. 

+ STANDARD SLIDER CLASS FOR VARIANT WEIGHT (ATTACHED TO UPSTREAM CASE NODE VARIANT WEIGHT)

```

**Current Behavior:**
- Shows Case Node, Variant Name, Variant Weight
- Shows Sub-Route Probability
- Shows Effective Probability calculation
- Appears **only** for case edges

**Questions:**
- Keep current styling (yellow background with formula explanation)?

NO. MATCH NEW RESTYLING.

- Make it collapsible?

YES.

- Where should it appear in the structure?

BELOW 'PARAMETERS'.

---

## Edge Deletion

**Current State:** Need to verify if "DELETE EDGE" button exists

**Options:**
1. **Remove entirely** - use Delete key or context menu only
2. **Move to bottom** - small, subdued link-style button
3. **Move to context menu** - right-click on edge

**Recommendation:** Option 1 (remove from panel, keep keyboard shortcut)

YES.

---

## ColourSelector Component Fixes

### Issue 1: Custom Colour Not Showing in Box 

ON THIS PANEL AND IN CASE NODE COLOUR SELECTOR

**Current Behavior:**
```
[Custom Colour Box]  →  Shows gradient, not actual picked colour
```

**Expected Behavior:**
```
[#FF5733 Solid]  →  Shows the actual custom colour picked
```

**Fix Location:** `ColourSelector.tsx`
- When custom colour selected, box should show solid colour
- Update box background when `customColour` changes

### Issue 2: Picker Opens at (0,0)

**Current Behavior:**
```
Click custom box anywhere  →  Picker appears at top-left (0, 0)
```

**Expected Behavior:**
```
Click custom box at (x, y)  →  Picker appears near (x, y)
```

**Fix Strategy:**
- Use `getBoundingClientRect()` on button
- Position picker relative to click location
- Or: use native `<input type="color">` positioning

---

## Component Reuse

**From Node Properties:**
- `CollapsibleSection` - For main sections
- `.variant-card` / `.variant-card-header` / `.variant-card-content` - For conditional probabilities
- `.property-add-btn` - For "+ Conditional Probability" button
- `ColourSelector` - For conditional probability colours (after fixing)
- `EnhancedSelector` - Already used, ensure consistent styling
- `ProbabilityInput` - Already used with slider

AND SLIDER COMPONENT

---

## Implementation Checklist

### Phase 1: Reorganize Structure
- [ ] Wrap fields in CollapsibleSection components
- [ ] Group Basic Properties (Slug, Locked, Weight Default)
- [ ] Group Parameters (Probability, Cost GBP, Cost Time)
- [ ] Move Case Edge Info to appropriate location

### Phase 2: Refactor Conditional Probabilities
- [ ] Replace `<ConditionalProbabilityEditor>` with accordion cards
- [ ] Add collapse/expand state management
- [ ] Add inline name editing (with Edit3 icon)
- [ ] Add delete button (hidden during edit)
- [ ] Add "+ Conditional Probability" button

### Phase 3: Colour Picker Integration
- [ ] Import ColourSelector component
- [ ] Integrate ColourSelector into conditional probability card headers (after chevron)
- [ ] Auto-assign colours using Colour Assignment Service when creating new conditional probabilities
- [ ] Show probability value in collapsed header (e.g., "When: payment-success (85%)")
- [ ] Generate display names dynamically ("When: {node_condition}")
- [ ] Add Std Dev and Distribution fields to conditional probability content
- [ ] Ensure colours persist in graph data
- [ ] Update Node Condition EnhancedSelector to show nodes from current graph

### Phase 4: Fix ColourSelector Component
- [ ] Show selected custom colour in box (not gradient)
- [ ] Position picker near click location (not 0,0)
- [ ] Test in both Node and Edge contexts

### Phase 5: Case Edge Info Slider Integration
- [ ] Add ProbabilityInput slider to Case Edge Info section
- [ ] Link slider to upstream case node's variant weight
- [ ] Ensure editing slider updates the case node variant
- [ ] Include rebalance button on slider
- [ ] Test that changes propagate correctly to case node

### Phase 6: Polish & Cleanup
- [ ] Remove "DELETE EDGE" button (if exists)
- [ ] Ensure consistent spacing/padding across all sections
- [ ] Test all interactions (expand/collapse/edit/delete)
- [ ] Verify undo/redo works for all changes
- [ ] Test with case edges vs normal edges
- [ ] Verify Weight Default and Std Dev show for all edges
- [ ] Test colour auto-assignment for new conditional probabilities
- [ ] Verify EnhancedSelector visual treatment (dirty, open, local, registry-only)

---

## Resolved Design Decisions

All major design questions have been answered:

1. **Parameter Sub-sections:** ✓ YES - make collapsible (use CollapsibleSection)
2. **Probability Slider Location:** ✓ INSIDE Probability sub-section
3. **Collapsed Conditional Probability:** ✓ Show colour + name + probability value
4. **Case Edge Info:** ✓ Below Parameters section, as collapsible section
5. **Colour Picker Position:** ✓ AFTER chevron in header
6. **Default Colours:** ✓ YES - auto-assign distinct colours (reuse logic from Case Nodes)
7. **Edge Deletion:** ✓ REMOVE button from panel entirely
8. **Weight Default:** ✓ Show for ALL edges (not just non-case)
9. **Probability Std Dev:** ✓ Show for ALL edges (not just non-case)
10. **Manual vs Parameter Input:** ✓ Everything is manual entry by default; connecting to parameter pulls data where it exists 

---

## Data Structure Impact

### Current Conditional Probability Structure
```typescript
edge.conditional_p = [
  {
    node_condition: 'payment-success',
    parameter_id: 'prob-payment-high',
    p: { mean: 0.85, stdev: 0.05 }
  }
]
```

### Proposed Addition
```typescript
edge.conditional_p = [
  {
    node_condition: 'payment-success',
    parameter_id: 'prob-payment-high',
    p: { mean: 0.85, stdev: 0.05 },
    color: '#3B82F6',  // NEW: For visual distinction
    name: 'High Success Rate'  // NEW: Optional display name
  }
]
```

**Questions:**
- Add `colour` field?

DO WE NOT HAVE COLOUR ON SCHEMA FOR CONDITIONAL PS?

- Add optional `name` field for better labeling?

WE CAN ADD OPTIONALLY. WE WILL NEED TO ADD TO SCHEMA IN THAT CASE THOUGH

- Default colour assignment strategy?

YES. WE SHOULD AUTO-ASSIGN A DISTINCT NOVEL COLOUR. WE NEED A STANDARD CLASS FOR THIS & RE-USE ACROSS CASE-NODES AND CONDITIONAL PS. THIS LOGIC SHOULD LOOK AT ALL COLOURS IN USE ON THE GRAPH AND PROPOSE A SOMEWHAT DISTINCT NOVEL ONE.

---

## Timeline Estimate

- **Phase 0 (Prerequisites):** 2-3 hours
  - Colour Assignment Service creation
  - Schema verification and updates
- **Phase 1 (Structure):** 3-4 hours
  - Reorganize into CollapsibleSections
  - Add Description, Std Dev, Distribution fields
  - Refactor Case Edge Info
- **Phase 2 (Conditional Probabilities):** 4-5 hours
  - Replace ConditionalProbabilityEditor with accordion cards
  - Add collapse/expand, inline editing, delete
- **Phase 3 (Colour Picker Integration):** 3-4 hours
  - Integrate ColourSelector
  - Auto-assign colours
  - Dynamic name generation
  - Add Std Dev/Distribution to conditional probabilities
- **Phase 4 (ColourSelector Fixes):** 2-3 hours
  - Fix custom colour display
  - Fix picker positioning
- **Phase 5 (Case Edge Slider):** 2-3 hours
  - Add slider to Case Edge Info
  - Link to case node variant weight
- **Phase 6 (Polish):** 2-3 hours
  - Remove DELETE EDGE button
  - Testing and verification

**Total:** 18-25 hours

---

## Notes for Implementation

- Reuse as much code as possible from Node Properties (Case Variants pattern)
- Maintain all existing functionality (don't break anything)
- Ensure undo/redo works for all new interactions
- Test with both normal edges and case edges
- Verify that all parameter connections still work
- Check that manual value entry still functions
- Ensure slider rebalancing still operates correctly

