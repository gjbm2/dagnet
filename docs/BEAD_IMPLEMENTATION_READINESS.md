# Bead System Implementation Readiness

## ✅ Design Complete

### Core Design Decisions
- ✅ **Single bead position** with multi-coloured text segments (not perpendicular stacking)
- ✅ **Bead types**: p, cost_gbp, cost_time, variant, conditional_p
- ✅ **Default states**: Normal params expanded, conditional_p collapsed
- ✅ **Multi-scenario**: Coloured text segments within single bead
- ✅ **Hidden current**: Brackets with 50% alpha grey text
- ✅ **Colour contrast**: Darker colours for cases/conditionals
- ✅ **Text positioning**: Horizontal text (not curved along spline)

### Resolved Questions
- ✅ Text curvature: Horizontal
- ✅ Bead persistence: No, reset to defaults
- ✅ Maximum beads: No limit initially
- ✅ Editing: Double-click edge (not bead)
- ✅ Parameter connections: Icon overlay or prefix (to be decided during implementation)

---

## ⚠️ Issues to Clarify Before Implementation

### 1. Case Variant Format ✅ **DECIDED**
**Decision**: Show only variant weight: `treatment: 25%`
**Rationale**: Edge probability (p) shown separately in probability bead before this, so only variant weight needed

### 2. Parameter Connection Icon ✅ **DECIDED**
**Decision**: Prefix in expanded text only: `🔌 50%`
**Rationale**: Not shown on collapsed bead - only when expanded for clarity

### 3. Bead State Storage ✅ **DECIDED**
**Decision**: Component state only, no persistence
**Rationale**: Reset to defaults on load and on edge selection change - keeps UI predictable

### 4. Stdev Display in Multi-Scenario
**Question**: Show stdev for all scenarios or only when they differ?

**Current Design**: Show stdev if present and > 0
**Consideration**: With multiple scenarios, showing stdev for all might be cluttered

**Recommendation**: Show stdev for each scenario if present (allows comparison)

### 5. Very Short Edges
**Question**: What happens when edge is too short for all beads?

**Current Design**: Beads may overlap
**Options**:
- A: Reduce spacing dynamically
- B: Hide less important beads (costs before probability)
- C: Show only collapsed beads
- D: Allow overlap (user can zoom)

**Recommendation**: Option D initially, add Option A if needed

### 6. Multiple Conditional_p Beads
**Question**: What if edge has many conditional probabilities?

**Current Design**: One bead per conditional_p entry
**Consideration**: Could create very long bead strings

**Recommendation**: No limit initially, add truncation if needed (e.g., "+3 more")

---

## 📋 Implementation Checklist

### Phase 1: Remove Labels, Add Basic Beads
- [ ] Remove `EdgeLabelRenderer` usage from `ConversionEdge.tsx`
- [ ] Remove collision detection code (~200 lines)
- [ ] Remove `buildCompositeLabel` / `renderCompositeLabel` calls
- [ ] Create `EdgeBeads.tsx` component
- [ ] Create `edgeBeadHelpers.tsx` (repurpose from `edgeLabelHelpers.tsx`)
- [ ] Add basic bead rendering (collapsed circles only)
- [ ] Position beads along spline using existing marker logic

### Phase 2: Expandable Beads
- [ ] Add bead state management (`useState<Map<string, BeadState>>()`)
- [ ] Implement expanded lozenge shape
- [ ] Add text rendering in expanded beads
- [ ] Implement click-to-toggle functionality
- [ ] Add default expansion states (normal params expanded, conditional_p collapsed)

### Phase 3: Multi-Scenario Support
- [ ] Extract values from all visible scenarios
- [ ] Implement coloured text segments within expanded beads
- [ ] Add deduplication logic (identical values → single black text)
- [ ] Implement hidden current brackets (50% alpha grey)
- [ ] Colour coding matches scenario colours from `visibleColourOrderIds`

### Phase 4: Colour & Styling
- [ ] Update `conditionalColours.ts` to use dark palette (600-700 level)
- [ ] Implement `darkenCaseColour()` function
- [ ] Apply darkening to case variant beads
- [ ] Ensure white text on dark backgrounds
- [ ] Test colour contrast with all scenario colours

### Phase 5: Polish
- [ ] Smooth expand/collapse animations
- [ ] Tooltips for collapsed beads
- [ ] Parameter connection icon (🔌) implementation
- [ ] Handle edge cases (short edges, many conditionals)
- [ ] Performance optimization

---

## 🔧 Code Structure

### New Files
- `graph-editor/src/components/edges/EdgeBeads.tsx` - Main bead component
- `graph-editor/src/components/edges/edgeBeadHelpers.tsx` - Bead data extraction
- `graph-editor/src/utils/colourUtils.ts` - Colour darkening functions (if not exists)

### Modified Files
- `graph-editor/src/components/edges/ConversionEdge.tsx` - Remove labels, add beads
- `graph-editor/src/lib/conditionalColours.ts` - Update to dark palette
- `graph-editor/src/components/edges/edgeLabelHelpers.tsx` - Repurpose or remove

### Removed Code
- `EdgeLabelRenderer` usage
- Collision detection functions
- Label positioning logic
- ~200-300 lines total

---

## 🎯 Success Criteria

### Functional
- ✅ All parameter types render as beads
- ✅ Beads positioned correctly along spline (chevron-aware)
- ✅ Expand/collapse works for all bead types
- ✅ Multi-scenario values shown as coloured text segments
- ✅ Hidden current shown in brackets with 50% alpha
- ✅ Default states correct (normal params expanded, conditional_p collapsed)
- ✅ Colours match specification (dark grey normal params, dark case/conditional)

### Non-Functional
- ✅ No collision detection code remains
- ✅ Performance: < 5ms to render 100 edges with beads
- ✅ Smooth expand/collapse animations
- ✅ Beads don't overlap nodes (positioned along spline)

### User Experience
- ✅ Beads clearly indicate parameter values
- ✅ Expanded beads readable at default zoom
- ✅ Click interaction feels responsive
- ✅ Visual hierarchy clear (normal params vs variants vs conditional)
- ✅ Colour contrast ensures readability

---

## ⚡ Ready to Implement?

**Status**: ✅ **READY TO IMPLEMENT** - All decisions made

**Blockers**: None - can proceed with implementation

**Final Decisions**:
1. ✅ Case variant format: `treatment: 25%` (variant weight only, p shown separately)
2. ✅ Parameter connection icon: `🔌` prefix in expanded text only (not on collapsed)
3. ✅ Bead state: Component state only, no persistence (reset on load and edge selection change)

**Estimated Effort**: 
- Phase 1: 2-3 hours
- Phase 2: 2-3 hours
- Phase 3: 3-4 hours
- Phase 4: 1-2 hours
- Phase 5: 2-3 hours
- **Total**: ~10-15 hours

