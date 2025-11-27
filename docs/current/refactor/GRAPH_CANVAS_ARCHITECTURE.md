# GraphCanvas Architecture

## Overview

`GraphCanvas.tsx` is the core rendering component for the DAG graph. At **5740 lines**, it's the largest component in the codebase, handling:

- ReactFlow integration (nodes, edges, interactions)
- Edge routing and bundling
- Sankey layout mode
- Scenario layer rendering
- What-If DSL application
- Path analysis calculations
- Selection and highlighting
- Context menus
- Viewport management

## File Location
`graph-editor/src/components/GraphCanvas.tsx`

---

## Component Hierarchy

```
GraphCanvas (export)
  └── ReactFlowProvider
      └── CanvasInner
          └── DecorationVisibilityContext.Provider
              └── div (wrapper)
                  ├── ReactFlow
                  │   ├── ConversionNode (nodeTypes)
                  │   └── ConversionEdge (edgeTypes)
                  ├── NodeContextMenu
                  ├── EdgeContextMenu
                  ├── ProbabilityInput
                  ├── VariantWeightInput
                  └── VariantModal
```

---

## Major Sections (by line number)

### 1. Imports & Setup (Lines 1-70)
- ReactFlow components
- Custom node/edge types
- Context providers
- Composition service imports
- **`computeEffectiveEdgeProbability`** import from whatIf.ts

### 2. DecorationVisibilityContext (Lines 33-45)
Local context for bead visibility during pan/zoom.

### 3. Props Interface (Lines 71-88)
```typescript
interface GraphCanvasProps {
  whatIfDSL?: string | null;  // From tab state
  tabId?: string;
  activeTabId?: string | null;
  // ... selection handlers, ref callbacks
}
```

### 4. CanvasInner Component (Lines 113-5740)
The main implementation - **5627 lines**.

#### 4a. State & Refs (Lines 113-280)
- ReactFlow state: `nodes`, `edges`, `setNodes`, `setEdges`
- Graph store access
- Tab context for scenarios
- View preferences
- **whatIfDSL resolution** (line 226-227):
  ```typescript
  const tabWhatIfDSL = tabForThisCanvas?.editorState?.whatIfDSL;
  const effectiveWhatIfDSL = tabWhatIfDSL ?? whatIfDSL ?? null;
  ```
- `overridesVersion` for reactivity tracking
- Sync refs, drag refs, layout refs

#### 4b. Edge Offset Calculation (Lines 315-754)
- `getEdgeSortKey` - sorting for curved edge stacking
- `calculateEdgeOffsets` - Sankey-style offset calculation
- Face-based scaling factors
- Bundle width calculations

#### 4c. Handle Calculation (Lines 793-810)
- `calculateOptimalHandles` - determine source/target handles

#### 4d. Auto Re-routing (Lines 812-1000)
- `performImmediateReroute` - re-route ALL edges
- `performAutoReroute` - re-route changed edges only

#### 4e. Graph→ReactFlow Sync (Lines 1050-2200)
Main sync logic - converts graph store to ReactFlow nodes/edges.

**What-If used here:**
- Line 1548: `whatIfDSL: effectiveWhatIfDSL` passed to edge data
- Lines 1597-1670: Sankey height calculation uses `computeEffectiveEdgeProbability`
- Lines 1812-1920: Another Sankey calculation block

#### 4f. Edge Width Calculation (Lines 2000-2200)
- Builds edge data with offsets, bundle info
- Line 2020: `whatIfDSL: effectiveWhatIfDSL` passed to edge data

#### 4g. Sankey What-If Update Effect (Lines 2558-2681)
**Critical whatIf usage:**
```typescript
useEffect(() => {
  // Recalculate node heights when what-if changes
  const effectiveProb = computeEffectiveEdgeProbability(
    currentGraph,
    edgeId,
    { whatIfDSL: effectiveWhatIfDSL },
    undefined
  );
  // ... update flow mass
}, [useSankeyView, overridesVersion, setNodes, whatIfDSL]);
```

#### 4h. ReactFlow→Graph Sync (Lines 2683-2728)
Syncs user canvas changes back to graph store.

#### 4i. Path Analysis (Lines 3500-4100)
**Heavy whatIf usage:**

- Line 3652: Forward path traversal
  ```typescript
  let edgeProbability = computeEffectiveEdgeProbability(
    currentGraph, edge.id, 
    { whatIfDSL: effectiveWhatIfDSL }, 
    edgePathContext
  );
  ```

- Line 3717: Backward path traversal (same pattern)

- Line 3874: Direct path probability
  ```typescript
  let directPathProbability = directEdge 
    ? computeEffectiveEdgeProbability(currentGraph2, directEdge.id, 
        { whatIfDSL: effectiveWhatIfDSL }, pathContext) 
    : 0;
  ```

- Line 3989: Edge grouping probability

#### 4j. Scenario Render Pipeline (Lines 4800-5015)
Calls `buildScenarioRenderEdges` which handles:
- Multi-scenario edge rendering
- Edge width calculation per scenario
- Color assignment
- **What-If for 'current' layer only**

#### 4k. ReactFlow Render (Lines 5040-5740)
Final JSX with:
- ReactFlow component
- Event handlers (pan, zoom, selection)
- Context menus
- Modals

---

## What-If Usage Summary

### Direct `computeEffectiveEdgeProbability` Calls

| Location | Purpose | Context |
|----------|---------|---------|
| Line 1659 | Sankey fast-path height calc | `{ whatIfDSL: layerWhatIfDSL }` |
| Line 1880 | Sankey slow-path height calc | `{ whatIfDSL: layerWhatIfDSL }` |
| Line 2636 | Sankey what-if update effect | `{ whatIfDSL: effectiveWhatIfDSL }` |
| Line 3652 | Path analysis forward DFS | `{ whatIfDSL: effectiveWhatIfDSL }, edgePathContext` |
| Line 3717 | Path analysis backward DFS | `{ whatIfDSL: effectiveWhatIfDSL }, edgePathContext` |
| Line 3874 | Direct path calculation | `{ whatIfDSL: effectiveWhatIfDSL }, pathContext` |
| Line 3989 | Edge grouping for pruning | `{ whatIfDSL: effectiveWhatIfDSL }` |

### Passing whatIfDSL to Children

| Location | Target |
|----------|--------|
| Line 1548 | Edge data object |
| Line 2020 | Edge data object |
| Line 2464 | Edge data object |
| Line 2528 | Edge data object |
| Line 4980 | Edge data object |

---

## buildScenarioRenderEdges.ts

**Location:** `src/components/canvas/buildScenarioRenderEdges.ts` (~450 lines)

Unified pipeline for all edge rendering:

```typescript
// Line 223-290: Probability resolver
const probResolver = (e: Edge) => {
  if (scenarioId === 'current') {
    // Uses What-If
    return computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL });
  }
  // For base/scenarios: uses frozen params + case variant weight
  // ... inline case variant logic (duplicated from elsewhere)
};
```

**Problem:** This file has ~60 lines of inline case variant logic that duplicates `getCaseEdgeVariantInfo` in edgeLabelHelpers.

---

## Duplicated Logic Locations

### 1. What-If Probability Calculation
- GraphCanvas: 7 direct calls
- buildScenarioRenderEdges: 1 call
- ConversionEdge: 2 calls
- ConversionNode: 1 call
- edgeLabelHelpers: 1 call in `getEdgeInfoForLayer`

**Total: ~12 places calling `computeEffectiveEdgeProbability`**

### 2. Case Variant Weight Application
- GraphCanvas: Lines 1663-1666, 1893-1896
- buildScenarioRenderEdges: Lines 243-284
- edgeLabelHelpers: `getCaseEdgeVariantInfo` function
- (CompositionService should centralize this)

### 3. Layer Probability Resolution
Three different patterns:
```typescript
// Pattern A: Current layer (uses whatIf)
if (scenarioId === 'current') {
  prob = computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL });
}

// Pattern B: Other layers (uses composed params)
else if (composedParams) {
  prob = composedParams.edges?.[edgeKey]?.p?.mean ?? 0;
  // Apply case variant weight inline
}

// Pattern C: Fallback
else {
  prob = edge.p?.mean ?? 0;
}
```

This 3-way pattern appears in:
- GraphCanvas lines 1656-1669
- GraphCanvas lines 1876-1900
- buildScenarioRenderEdges lines 223-290
- edgeLabelHelpers `getEdgeInfoForLayer`

---

## Dependencies

### Contexts Used
- `GraphStoreContext` - graph data
- `TabContext` - tab state, whatIfDSL
- `ViewPreferencesContext` - edge scaling, etc.
- `ScenariosContext` - scenario params

### Key Imports
- `computeEffectiveEdgeProbability` from `@/lib/whatIf`
- `getComposedParamsForLayer` from `services/CompositionService`
- `getCaseEdgeVariantInfo` from `edges/edgeLabelHelpers`
- `buildScenarioRenderEdges` from `canvas/buildScenarioRenderEdges`

---

## Refactoring Recommendations

### High Priority

1. **Centralize Probability Resolution**
   Create `getEffectiveEdgeProbability(layerId, edgeId, graph, params, whatIfDSL)` in CompositionService that:
   - For 'current': calls `computeEffectiveEdgeProbability`
   - For others: gets from composed params + case variant weight
   - Single function replaces 3-way pattern everywhere

2. **Extract Case Variant Logic**
   - Move inline case variant code to `CompositionService.getCaseVariantWeight()`
   - Use in both CompositionService and buildScenarioRenderEdges

3. **Reduce Direct whatIf Calls**
   - GraphCanvas path analysis can use the centralized function
   - Sankey calculations can use centralized function

### Medium Priority

4. **Extract Path Analysis**
   - ~600 lines (3500-4100) could be separate module
   - Would make GraphCanvas more manageable

5. **Extract Sankey Logic**
   - Sankey-specific calculations are scattered
   - Could be `useSankeyLayout` hook

6. **Simplify Edge Data Flow**
   - Currently passes `whatIfDSL` in 5 different places
   - Could use context or single propagation point

### Low Priority

7. **Remove Debug Logging**
   - ~100+ console.log statements
   - Use configurable debug flag

8. **Split Large File**
   - Consider splitting into multiple files:
     - GraphCanvasCore (ReactFlow setup, sync)
     - useEdgeRouting (routing logic)
     - usePathAnalysis (path calculations)
     - useSankeyLayout (Sankey mode)

---

## File Size Breakdown

| Section | Approx Lines |
|---------|-------------|
| Imports & setup | 115 |
| Edge offset calc | 440 |
| Handle/routing | 250 |
| Graph↔ReactFlow sync | 1150 |
| Edge width calc | 200 |
| Sankey effects | 200 |
| Path analysis | 600 |
| Scenario pipeline | 200 |
| Event handlers | 700 |
| Context menus | 400 |
| ReactFlow JSX | 700 |
| Misc (modals, etc.) | 785 |
| **Total** | **~5740** |

---

## Key Insight for Refactoring

The core issue is the **3-way probability resolution pattern** that appears 4+ times:

```typescript
if (layerId === 'current') {
  // Uses computeEffectiveEdgeProbability with whatIfDSL
} else if (composedParams) {
  // Uses composed params + inline case variant weight
} else {
  // Fallback to raw edge.p.mean
}
```

Creating a single `getEffectiveEdgeProbability(layerId, ...)` function that encapsulates this pattern would:
1. Reduce code duplication by ~200 lines
2. Ensure consistent behavior across all usage sites
3. Make what-if logic testable in one place
4. Simplify future changes to probability resolution

