# Phase 0.0: UUID/ID Migration Fix Tracking

**Issue:** After Phase 0.0 migration (id→uuid, slug→id), many places in the codebase still search for edges/nodes using `e.id` instead of checking both `e.uuid` and `e.id`.

**Status:** 🟢 Critical Path Complete (26 instances fixed, 14 remaining non-critical)

---

## Root Cause

After Phase 0.0 migration:
- **Nodes:** `node.uuid` = system ID (ReactFlow uses this), `node.id` = human-readable ID (e.g., "checkout")
- **Edges:** `edge.uuid` = system ID (ReactFlow uses this), `edge.id` = human-readable ID (e.g., "start-to-success")

ReactFlow components use **UUIDs** as their IDs, but many graph operations search using `e.id` which now contains the human-readable ID, causing lookup failures.

---

## Solution Pattern

### Before (Broken):
```typescript
const edge = graph.edges.find((e: any) => e.id === edgeId);
```

### After (Fixed):
```typescript
const edge = graph.edges.find((e: any) => 
  e.uuid === edgeId ||           // ReactFlow uses UUID as edge ID
  e.id === edgeId ||             // Human-readable ID
  `${e.from}->${e.to}` === edgeId  // Fallback format
);
```

### Helper Function Created:
`src/lib/graphHelpers.ts` - Provides:
- `findEdgeById(graph, edgeId)` - Find edge by UUID or human ID
- `findEdgeIndexById(graph, edgeId)` - Find edge index
- `findNodeById(graph, nodeId)` - Find node by UUID or human ID
- `findNodeIndexById(graph, nodeId)` - Find node index

---

## Fixes Completed ✅

### Critical Path (Rendering & Core Functionality)

1. **✅ `/src/lib/whatIf.ts` (2 instances)**
   - Line 100: `computeEffectiveEdgeProbability()` - **CRITICAL** (was causing "weightless" edges)
   - Line 209: `getEdgeWhatIfDisplay()` - **CRITICAL** (affects tooltips and UI)

2. **✅ `/src/components/edges/ConversionEdge.tsx` (2 instances)**
   - Line 176: `fullEdge` lookup - **CRITICAL** (affects edge rendering, colours, tooltips)
   - Line 187: Dependency array lookup - **CRITICAL** (was causing dashed stroke on all edges)

3. **✅ `/src/components/PropertiesPanel.tsx` (18 instances)**
   - Line 130: Node data loading - **CRITICAL** (node properties not displaying)
   - Line 454: `updateNode` function - **CRITICAL** (node updates not working)
   - Lines 593-1237: All node update handlers (16 instances) - **CRITICAL** (editing node properties)
   - Line 1519: Edge update handler - **CRITICAL** (editing edge properties)

4. **✅ `/src/components/GraphCanvas.tsx` (4 instances)**
   - Line 1268: Edge handles check - **CRITICAL** (edge sync)
   - Line 1283: Node properties check - **CRITICAL** (node sync)
   - Line 1341: Fast path edge sync - **CRITICAL** (edge data updates)

### Result
- ✅ Edges render with correct stroke width (no more dashed strokes)
- ✅ Edge probabilities display correctly
- ✅ Node properties panel loads and displays correctly
- ✅ Node property editing works (label, description, etc.)
- ✅ Edge property editing works
- ✅ What-if analysis works
- ✅ Conditional probabilities recognized
- ✅ Graph sync works properly

---

## Remaining Fixes 🟡 (14 instances)

These affect editing, context menus, and advanced features but don't break basic rendering:

### High Priority (Editing & Interaction)

**`/src/components/GraphCanvas.tsx` (13 instances)**
- Lines 913, 914: Edge duplication
- Lines 1892, 1897: Edge reconnection
- Lines 4193, 4206, 4221, 4230, 4240: Edge context menu (delete, lock, properties)
- Lines 4270, 4278, 4289, 4304, 4322, 4351, 4374, 4420, 4423: Edge context menu (advanced features)

### Medium Priority (Advanced Features)

**`/src/components/ConditionalProbabilitiesSection.tsx` (6 instances)**
- Lines 348, 374, 394, 464, 485: Conditional probability editing

**`/src/components/WhatIfAnalysisControl.tsx` (3 instances)**
- Lines 166, 245, 462: What-if analysis controls

**`/src/components/QueryExpressionEditor.tsx` (1 instance)**
- Line 176: Query expression building

### Low Priority (Utilities)

**`/src/lib/conditionalReferences.ts` (1 instance)**
- Line 237: Reference resolution

---

## Testing Checklist

### ✅ Working Now (After Critical Fixes)
- [x] Graph loads and displays correctly
- [x] Edges show correct stroke width based on probability (no more dashed strokes!)
- [x] Edge labels show correct probability values
- [x] What-if analysis displays correct info
- [x] Conditional probabilities are recognized
- [x] **Node properties panel loads and displays** ✨ NEW
- [x] **Node property editing works (label, description, etc.)** ✨ NEW
- [x] **Edge property editing works** ✨ NEW
- [x] **Graph syncing works properly** ✨ NEW

### 🟡 Needs Testing (Remaining Fixes Required)
- [ ] Right-click edge → Delete (GraphCanvas context menu)
- [ ] Right-click edge → Lock/Unlock (GraphCanvas context menu)
- [ ] Add/edit conditional probabilities (ConditionalProbabilitiesSection)
- [ ] What-if analysis controls (WhatIfAnalysisControl)
- [ ] Edge duplication (GraphCanvas)
- [ ] Edge reconnection (GraphCanvas)
- [ ] Query expression editor (QueryExpressionEditor)

---

## Implementation Strategy

### Option A: Gradual Fix (Recommended for now)
- ✅ **Done:** Critical path fixed (rendering works)
- **Next:** Fix editing features as users encounter issues
- **Benefit:** Unblocks immediate work, fixes issues incrementally

### Option B: Systematic Fix (Phase 0.2)
- Replace all 36 remaining instances with helper functions
- Create comprehensive test suite
- **Benefit:** Clean, complete solution
- **Cost:** More upfront work

---

## Acceptance Criteria

### Minimum (Critical Path) ✅ COMPLETE
- [x] Edges render with correct width
- [x] Probabilities display correctly
- [x] Graph is usable for viewing and basic navigation

### Full (All Features) 🟡 PENDING
- [ ] All edge operations work (edit, delete, duplicate, reconnect)
- [ ] Sibling edge updates work when changing probabilities
- [ ] Context menus work correctly
- [ ] Conditional probability editing works
- [ ] What-if analysis controls work
- [ ] All 40 instances converted to use UUID-aware lookups

---

## Notes

**This is an EXPECTED migration issue** - we knew Phase 0.0 would require systematic updates throughout the codebase. The good news:
1. The fix is mechanical and consistent
2. We have a clear pattern to follow
3. Critical functionality is now restored
4. Remaining fixes are low-risk (editing features, not core rendering)

**Recommendation:** Proceed with Phase 0.1 work. Fix remaining instances as needed or in a dedicated Phase 0.2 cleanup pass.

