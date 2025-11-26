# Refactoring Plan: Graph Components

## Executive Summary

This plan addresses the structural issues identified in `GraphEditor.tsx` (2100 lines) and `GraphCanvas.tsx` (5740 lines). The goals are:

1. **Reduce file sizes** to manageable modules (<500 lines each)
2. **Eliminate duplicated code paths** (especially the 3-way probability pattern)
3. **Remove deprecated functionality** (path analytics now handled by AnalyticsPanel)
4. **Centralize composition logic** (What-If, scenarios, case variants)

**Estimated reduction:** ~1500 lines removed, ~2000 lines refactored into focused modules.

---

## Phase 1: Remove Deprecated Path Analytics

**Priority: HIGH | Risk: LOW | Effort: ~2 hours**

The path analysis code in GraphCanvas (lines 3500-4100, ~600 lines) is now dominated by the new analytics machinery in AnalyticsPanel + Python runner.

### Actions

1. **Mark as deprecated** (immediate)
   - Add `@deprecated` comments to path analysis functions
   - Add console warnings when called

2. **Remove path analysis code** (after verification)
   - Delete `findPathThroughIntermediates` function
   - Delete `calculateProbability` function  
   - Delete `computeGlobalPruning` function
   - Delete associated state and refs
   - Delete path analysis result rendering

3. **Remove path analysis UI panel** (~140 lines JSX at lines 5289-5430)
   - Remove the inline "Path Analysis" / "Selection Analysis" panel
   - This panel renders when nodes are selected, showing pathProbability, pathCosts
   - Now replaced by AnalyticsPanel with richer visualization

### Files Affected
- `GraphCanvas.tsx` - remove ~740 lines (600 calculation + 140 UI)

### Verification
- Ensure AnalyticsPanel provides equivalent functionality
- Test multi-node selection doesn't break

---

## Phase 2: Centralize Probability Resolution

**Priority: HIGH | Risk: MEDIUM | Effort: ~4 hours**

### The Problem

The 3-way probability resolution pattern appears 4+ times:

```typescript
if (layerId === 'current') {
  prob = computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL });
} else if (composedParams) {
  prob = composedParams.edges?.[key]?.p?.mean ?? 0;
  // + inline case variant logic (~30 lines)
} else {
  prob = edge.p?.mean ?? 0;
}
```

### The Solution

Create unified functions in `CompositionService.ts`:

```typescript
/**
 * Get effective edge probability for any layer.
 * SINGLE SOURCE OF TRUTH for edge probability across all rendering.
 */
export function getEffectiveEdgeProbability(
  layerId: string,
  edge: GraphEdge,
  graph: Graph,
  baseParams: ScenarioParams,
  currentParams: ScenarioParams,
  scenarios: ScenarioLike[],
  whatIfDSL?: string | null
): number;

/**
 * Get case variant weight for an edge.
 * Extracted from inline logic in 4+ places.
 */
export function getCaseVariantWeight(
  edge: GraphEdge,
  graph: Graph,
  composedParams: ScenarioParams
): number;
```

### Migration Steps

1. **Add functions to CompositionService** (non-breaking)
2. **Update edgeLabelHelpers.getEdgeInfoForLayer** to use new function
3. **Update buildScenarioRenderEdges.probResolver** to use new function
4. **Update GraphCanvas Sankey calculations** to use new function
5. **Remove duplicated inline code**

### Files Affected
- `CompositionService.ts` - add ~80 lines
- `edgeLabelHelpers.tsx` - simplify ~60 lines
- `buildScenarioRenderEdges.ts` - simplify ~60 lines
- `GraphCanvas.tsx` - simplify ~80 lines

---

## Phase 3: Extract GraphCanvas Modules

**Priority: MEDIUM | Risk: MEDIUM | Effort: ~6 hours**

Split GraphCanvas.tsx into focused modules:

### 3a. Create `useEdgeRouting.ts` hook

**Contents:** (~450 lines)
- `getEdgeSortKey`
- `calculateEdgeOffsets`
- `calculateOptimalHandles`
- `performAutoReroute`
- `performImmediateReroute`
- Face-based scaling logic

**Interface:**
```typescript
export function useEdgeRouting(
  graph: Graph,
  nodes: Node[],
  edges: Edge[],
  options: EdgeRoutingOptions
): {
  calculateEdgeOffsets: (edges, nodes, maxWidth) => Edge[];
  performAutoReroute: () => void;
  performImmediateReroute: () => void;
};
```

### 3b. Create `useSankeyLayout.ts` hook

**Contents:** (~300 lines)
- Sankey height calculation
- Flow mass computation
- Node height updates
- What-If triggered recalculation

**Interface:**
```typescript
export function useSankeyLayout(
  graph: Graph,
  nodes: Node[],
  edges: Edge[],
  options: SankeyOptions
): {
  sankeyNodes: Node[];
  recalculateHeights: () => void;
};
```

### 3c. Create `useGraphSync.ts` hook

**Contents:** (~400 lines)
- Graph → ReactFlow sync
- ReactFlow → Graph sync
- Change detection
- Sync refs management

**Interface:**
```typescript
export function useGraphSync(
  graph: Graph,
  setGraph: (g: Graph) => void,
  options: SyncOptions
): {
  nodes: Node[];
  edges: Edge[];
  setNodes: Dispatch<SetStateAction<Node[]>>;
  setEdges: Dispatch<SetStateAction<Edge[]>>;
  isSyncing: boolean;
};
```

### 3d. Remaining GraphCanvas Core

**Contents:** (~2500 lines → target ~1500 lines)
- ReactFlow setup and render
- Selection handling
- Context menus
- Event handlers
- Viewport management

---

## Phase 4: Extract GraphEditor Modules

**Priority: MEDIUM | Risk: LOW | Effort: ~4 hours**

### 4a. Create `useGraphEditorLayout.ts` hook

**Contents:** (~500 lines)
- rc-dock layout management
- createLayoutStructure
- Layout initialization
- Component injection
- Floating panel tracking

**Interface:**
```typescript
export function useGraphEditorLayout(
  tabId: string,
  sidebarState: SidebarState,
  components: LayoutComponents
): {
  dockLayout: LayoutData;
  dockRef: RefObject<DockLayout>;
  onLayoutChange: (layout: LayoutData) => void;
};
```

### 4b. Create `SelectionContext.tsx`

**Contents:** (~100 lines)
- SelectionContextType interface
- SelectionContext
- useSelectionContext hook

Currently embedded in GraphEditor, should be standalone.

### 4c. Create `ScenarioLegendWrapper.tsx`

**Contents:** (~80 lines)
- Already a separate component but defined in GraphEditor
- Move to own file

### 4d. Remaining GraphEditor Core

**Contents:** (~2100 lines → target ~1200 lines)
- State management
- Sidebar state
- Event listeners
- Main render

---

## Phase 5: Consolidate Scenario Rendering

**Priority: LOW | Risk: LOW | Effort: ~3 hours**

### The Problem

Scenario edge rendering logic is split:
- `buildScenarioRenderEdges.ts` - main pipeline
- `GraphCanvas.tsx` - inline overlay logic (commented out)
- `ScenarioOverlayRenderer.tsx` - separate overlay approach

### The Solution

1. **Delete ScenarioOverlayRenderer.tsx** if unused
2. **Remove commented-out overlay code** from GraphCanvas
3. **Consolidate into buildScenarioRenderEdges.ts**

---

## Phase 6: Cleanup and Polish

**Priority: LOW | Risk: LOW | Effort: ~2 hours**

### 6a. Remove Debug Logging

Both files have 100+ console.log statements:
- Create `DEBUG` flag or use environment variable
- Wrap debug logs in conditional
- Or remove entirely for production paths

### 6b. Type Improvements

- Replace `any` types with proper interfaces
- Add JSDoc to public functions
- Create shared types file for edge/node data

### 6c. Test Coverage

- Add unit tests for extracted hooks
- Add integration tests for probability resolution
- Verify What-If behavior across all code paths

---

## Implementation Order

```
Week 1:
├── Phase 1: Remove path analytics (~600 lines deleted)
└── Phase 2: Centralize probability (~200 lines simplified)

Week 2:
├── Phase 3a: Extract useEdgeRouting
├── Phase 3b: Extract useSankeyLayout  
└── Phase 3c: Extract useGraphSync

Week 3:
├── Phase 4a: Extract useGraphEditorLayout
├── Phase 4b: Extract SelectionContext
└── Phase 4c: Extract ScenarioLegendWrapper

Week 4:
├── Phase 5: Consolidate scenario rendering
└── Phase 6: Cleanup and polish
```

---

## Target Architecture

### Before
```
GraphEditor.tsx (2100 lines)
GraphCanvas.tsx (5740 lines)
─────────────────────────────
Total: 7840 lines in 2 files
```

### After
```
GraphEditor.tsx (~1200 lines)
├── hooks/useGraphEditorLayout.ts (~500 lines)
├── contexts/SelectionContext.tsx (~100 lines)
└── components/ScenarioLegendWrapper.tsx (~80 lines)

GraphCanvas.tsx (~1500 lines)
├── hooks/useEdgeRouting.ts (~450 lines)
├── hooks/useSankeyLayout.ts (~300 lines)
├── hooks/useGraphSync.ts (~400 lines)
└── canvas/buildScenarioRenderEdges.ts (~350 lines) [existing, cleaned up]

services/CompositionService.ts (~500 lines) [expanded from 380]
─────────────────────────────
Total: ~5380 lines in 10 files
Average: ~540 lines per file
```

### Net Change
- **Lines removed:** ~1500 (path analytics, duplicated code)
- **Lines refactored:** ~5000 (into focused modules)
- **Files:** 2 → 10 (more focused, testable)
- **Average file size:** 3920 → 540 lines

---

## Risk Mitigation

### High-Risk Areas

1. **Graph↔ReactFlow sync** - Complex state management
   - Mitigation: Keep sync logic together in one hook
   - Test thoroughly before/after

2. **Sankey calculations** - Performance-sensitive
   - Mitigation: Profile before/after
   - Keep memoization intact

3. **What-If reactivity** - Must trigger re-renders correctly
   - Mitigation: Verify dependency arrays
   - Test with complex what-if scenarios

### Testing Strategy

1. **Before starting:** Create snapshot tests for current behavior
2. **Per phase:** Run full test suite
3. **After completion:** Manual testing of:
   - Edge rendering across scenarios
   - What-If application
   - Sankey mode
   - Selection and highlighting
   - Context menus

---

## Success Criteria

1. ✅ No file over 1500 lines
2. ✅ Single source of truth for probability resolution
3. ✅ Path analytics removed (use AnalyticsPanel)
4. ✅ All existing tests pass
5. ✅ No visual regressions
6. ✅ Performance maintained or improved

---

## Appendix: Files to Create

| File | Lines | Purpose |
|------|-------|---------|
| `hooks/useEdgeRouting.ts` | ~450 | Edge routing and bundling |
| `hooks/useSankeyLayout.ts` | ~300 | Sankey mode calculations |
| `hooks/useGraphSync.ts` | ~400 | Graph↔ReactFlow sync |
| `hooks/useGraphEditorLayout.ts` | ~500 | rc-dock layout management |
| `contexts/SelectionContext.tsx` | ~100 | Selection state |
| `components/ScenarioLegendWrapper.tsx` | ~80 | Scenario legend |

## Appendix: Files to Modify

| File | Current | Target | Change |
|------|---------|--------|--------|
| `GraphCanvas.tsx` | 5740 | ~1500 | -4240 |
| `GraphEditor.tsx` | 2100 | ~1200 | -900 |
| `CompositionService.ts` | 380 | ~500 | +120 |
| `edgeLabelHelpers.tsx` | 770 | ~700 | -70 |
| `buildScenarioRenderEdges.ts` | 453 | ~350 | -103 |

## Appendix: Files to Delete

| File | Lines | Reason |
|------|-------|--------|
| `ScenarioOverlayRenderer.tsx` | ~200 | Superseded by buildScenarioRenderEdges |
| (path analysis code) | ~600 | Superseded by AnalyticsPanel |

