# Implementation Plan: Edge Rendering Architecture Updates

## Overview

This document details the implementation plan to align the codebase with the specifications in `EDGE_RENDERING_ARCHITECTURE.md`. Based on systematic review of the current implementation, 7 key changes are required.

**Status:** ❌ Not Started  
**Last Updated:** 2025-11-13  
**Est. Effort:** 3-5 days

---

## Change Summary

| # | Change | Status | Priority | Files | Complexity |
|---|--------|--------|----------|-------|------------|
| 1 | Fix scenario compositing | ❌ Not Started | **CRITICAL** | GraphCanvas.tsx | Medium |
| 2 | Remove null parameter | ❌ Not Started | **HIGH** | GraphCanvas.tsx, ConversionEdge.tsx, others | Low |
| 3 | Hidden current opacity | ❌ Not Started | **HIGH** | GraphCanvas.tsx | Low |
| 4 | Snapshot semantics | ❌ Not Started | **HIGH** | ScenariosContext.tsx | Medium |
| 5 | Color assignment | ✅ Already Correct | **MEDIUM** | ColorAssigner.ts | N/A |
| 6 | Composite edge labels | ❌ Not Started | **HIGH** | ConversionEdge.tsx | High |
| 7 | PMF warnings | ❌ Not Started | **MEDIUM** | GraphCanvas.tsx or utils | Low |

---

## Change 1: Fix Scenario Layer Compositing

### Current Implementation (WRONG)

**Location:** `graph-editor/src/components/GraphCanvas.tsx` lines 4664-4678

```typescript
// Each layer only composes with base (incorrect)
for (const scenarioId of visibleScenarioIds) {
  if (scenarioId === 'base') {
    composedParams = baseParams;
  } else if (scenarioId === 'current') {
    composedParams = composeParams(baseParams, [scenariosContext.currentParams]);
  } else if (scenario) {
    // BUG: Only composing with base, not all visible layers below
    composedParams = composeParams(baseParams, [scenario.params]);
  }
}
```

### Required Implementation

**New Logic:**
```typescript
for (const scenarioId of visibleScenarioIds) {
  if (scenarioId === 'base') {
    // Base is standalone snapshot
    composedParams = baseParams;
  } else if (scenarioId === 'current') {
    // Current reads from live graph, does NOT compose
    composedParams = null; // Not used for current - uses live graph directly
  } else if (scenario) {
    // Compose from base + ALL VISIBLE layers below this one
    const currentIndex = visibleScenarioIds.indexOf(scenarioId);
    const layersBelowIds = visibleScenarioIds.slice(0, currentIndex)
      .filter(id => id !== 'current' && id !== 'base'); // Exclude base and current
    
    const layersBelow = layersBelowIds
      .map(id => scenarios.find(s => s.id === id)?.params)
      .filter(p => p !== undefined);
    
    // Compose: base + all visible layers below
    composedParams = composeParams(baseParams, layersBelow);
  }
}
```

### Testing

**Test Case 1:** Three layers visible: `['base', 'layer1', 'layer2']`
- `layer1` should use: `base + layer1`
- `layer2` should use: `base + layer1 + layer2`

**Test Case 2:** Hidden layer: `['base', 'layer1', 'layer3']` (layer2 hidden)
- `layer1` should use: `base + layer1`
- `layer3` should use: `base + layer1 + layer3` (NOT layer2)

**Verify:** Edge probabilities differ between tabs with different visible layer combinations.

---

## Change 2: Remove Unused `null` Parameter

### Current Implementation

**Locations:**
- `GraphCanvas.tsx` line 4685
- `ConversionEdge.tsx` (multiple locations)
- Other files (need to search)

```typescript
// Current (with unused null parameter)
computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL }, null, undefined);
```

### Required Implementation

```typescript
// Remove the null parameter
computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL }, undefined);
// Or if no visitedNodes needed:
computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL });
```

### Implementation Steps

1. **Search:** Run `grep -r "computeEffectiveEdgeProbability" graph-editor/src/` to find all call sites
2. **Update:** Remove the 4th parameter (null) from all calls
3. **Verify:** The function signature in `whatIf.ts` line 220 has `_unused?: null` which is optional, so removal is safe
4. **(Optional):** Clean up function signature to remove `_unused` parameter entirely if no longer needed

### Files to Update

- [ ] `GraphCanvas.tsx` (line 4685)
- [ ] `ConversionEdge.tsx` (search for all occurrences)
- [ ] `graphPruning.ts` (if present)
- [ ] `pathAnalysis.ts` (if present)
- [ ] Any other files found in search

---

## Change 3: Hidden 'Current' Uses 5% Opacity

### Current Implementation

**Location:** `GraphCanvas.tsx` lines ~4700-4800 (scenario overlay rendering)

Currently may be rendering 'current' at 30% opacity like other layers, or not rendering at all when hidden.

### Required Implementation

**Update opacity logic:**
```typescript
// When rendering scenario overlay for each layer
for (const scenarioId of visibleScenarioIds) {
  const scenario = scenarios.find(s => s.id === scenarioId);
  const color = colorMap.get(scenarioId) || scenario?.color || '#808080';
  
  // Determine opacity based on layer and visibility
  let opacity = 0.30; // Default for visible layers
  
  // ALWAYS render 'current', but check if it's in visible list
  if (scenarioId === 'current' && !visibleScenarioIds.includes('current')) {
    // 'current' hidden: use 5% opacity with grey color
    opacity = 0.05;
    color = '#808080'; // Grey, not palette color
  }
  
  // Render overlay with calculated opacity...
}

// IMPORTANT: Ensure 'current' is ALWAYS rendered, even if not in visibleScenarioIds
// Add logic to render 'current' at end if not already rendered
if (!visibleScenarioIds.includes('current')) {
  // Render 'current' at 5% opacity
  renderCurrentOverlay({ opacity: 0.05, color: '#808080' });
}
```

### Testing

**Test Case:** Hide 'current' layer
- **Expected:** 'current' overlay still visible but very faint (5% opacity, grey color)
- **Expected:** Interactive edges still fully functional
- **Expected:** What-If changes update the faint 'current' overlay in real-time

---

## Change 4: Snapshots Capture Composite (Live + What-If)

### Current Implementation

**Location:** `graph-editor/src/contexts/ScenariosContext.tsx` (search for `createSnapshot` or `captureParams`)

Currently may be capturing raw `graph.edges[].p.mean` without What-If effects.

### Required Implementation

**Update snapshot capture function:**
```typescript
function captureParams(graph: Graph, options: { whatIfDSL?: string | null; type: 'all' | 'differences'; source: 'visible' | 'base' }) {
  const { whatIfDSL, type, source } = options;
  const params: ScenarioParams = { edges: {}, nodes: {} };
  
  // For each edge, capture the COMPOSITE probability (live graph + What-If)
  for (const edge of graph.edges) {
    // Use computeEffectiveEdgeProbability to get composite value
    const effectiveProb = computeEffectiveEdgeProbability(
      graph,
      edge.id,
      { whatIfDSL: whatIfDSL || undefined }  // Apply What-If when capturing
    );
    
    // Store the composite value (what user sees)
    params.edges[edge.uuid] = {
      p: { 
        mean: effectiveProb,
        stdev: edge.p?.stdev,  // Preserve stdev if present
        // ... other probability fields
      }
      // ... other edge params (costs, weights, etc.)
    };
  }
  
  // Similar for nodes...
  
  return params;
}

// Update createSnapshot to pass whatIfDSL
function createSnapshot(options: { name?: string; type?: 'all' | 'differences'; source?: 'visible' | 'base' }) {
  const graph = getCurrentGraph();
  const whatIfDSL = getCurrentTabState().whatIfDSL;  // Get current What-If DSL
  
  const params = captureParams(graph, {
    whatIfDSL,  // Pass What-If DSL to capture function
    type: options.type || 'all',
    source: options.source || 'visible'
  });
  
  const newScenario: Scenario = {
    id: generateUUID(),
    name: options.name || generateTimestampName(),
    params,
    color: '#808080',
    createdAt: new Date().toISOString(),
    version: 1,
    meta: {
      whatIfDSL,  // Record What-If DSL in metadata
      whatIfSummary: summarizeWhatIfDSL(whatIfDSL),
      source: {
        type: options.type || 'all',
        from: options.source || 'visible'
      },
      createdBy: getCurrentUser()?.id,
      createdInTabId: getCurrentTabId()
    }
  };
  
  return newScenario;
}
```

### Testing

**Test Case:** Apply What-If `case[checkout_case] = treatment`, then create snapshot
- **Expected:** Snapshot params should contain the What-If-modified probabilities
- **Expected:** Snapshot `meta.whatIfDSL` should contain the DSL string
- **Expected:** Viewing the snapshot shows the same values user saw when they clicked "Create Snapshot"

---

## Change 5: Color Assignment (Already Correct ✅)

### Current Implementation

**Location:** `graph-editor/src/services/ColorAssigner.ts` lines 18-56

**Status:** ✅ **ALREADY CORRECT** - No changes needed!

The `assignColors` function already filters to only visible scenarios (line 25-26):

```typescript
const visibleInActivationOrder = activationOrder.filter(id => 
  visibleIds.includes(id)
);
```

This means if 'current' is not in `visibleIds`, it won't get a palette color assigned. The current implementation already follows the spec.

### Verification Only

**Verify:**
1. Hidden 'current' does NOT appear in `colorMap`
2. Hidden 'current' overlay uses grey `#808080` (see Change 3)
3. Color palette distribution is based only on visible layers

---

## Change 6: Composite Edge Labels (NEW FEATURE)

### Current Implementation

**Location:** `graph-editor/src/components/edges/ConversionEdge.tsx` lines 1630-1730

Currently shows single probability value:
```typescript
{Math.round((effectiveProbability || 0) * 100)}%
```

This only shows one value (from 'current' layer).

### Required Implementation

**Create composite label builder:**

```typescript
// New function: Build composite edge label from all visible layers
function buildCompositeEdgeLabel(
  edge: Edge,
  visibleScenarioIds: string[],
  colorMap: Map<string, string>,
  scenarios: Scenario[],
  graph: Graph,
  whatIfDSL: string | null
): React.ReactNode {
  // Special case: Single layer visible
  if (visibleScenarioIds.length === 1) {
    const layerId = visibleScenarioIds[0];
    const prob = getLayerProbability(layerId, edge.id, scenarios, graph, whatIfDSL);
    
    return (
      <span style={{ color: 'black' }}>
        {Math.round(prob * 100)}%
      </span>
    );
  }
  
  // Multiple layers: build colored segments
  const segments: React.ReactNode[] = [];
  
  // Add visible layers in order (bottom to top)
  for (const layerId of visibleScenarioIds) {
    const prob = getLayerProbability(layerId, edge.id, scenarios, graph, whatIfDSL);
    const stdev = getLayerStdev(layerId, edge.id, scenarios, graph);
    const color = colorMap.get(layerId) || '#808080';
    
    const text = stdev 
      ? `${Math.round(prob * 100)}% ± ${Math.round(stdev * 100)}%`
      : `${Math.round(prob * 100)}%`;
    
    segments.push(
      <span key={layerId} style={{ color, marginRight: '6px' }}>
        {text}
      </span>
    );
  }
  
  // Add hidden 'current' in grey with parentheses
  if (!visibleScenarioIds.includes('current')) {
    const prob = computeEffectiveEdgeProbability(graph, edge.id, { whatIfDSL });
    const stdev = graph.edges.find(e => e.id === edge.id)?.p?.stdev;
    
    const text = stdev
      ? `(${Math.round(prob * 100)}% ± ${Math.round(stdev * 100)}%)`
      : `(${Math.round(prob * 100)}%)`;
    
    segments.push(
      <span key="current-hidden" style={{ color: '#cccccc' }}>
        {text}
      </span>
    );
  }
  
  return <>{segments}</>;
}

// Helper: Get probability for a specific layer
function getLayerProbability(
  layerId: string,
  edgeId: string,
  scenarios: Scenario[],
  graph: Graph,
  whatIfDSL: string | null
): number {
  if (layerId === 'current') {
    return computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL });
  }
  
  const scenario = scenarios.find(s => s.id === layerId);
  if (!scenario) return 0;
  
  const edge = graph.edges.find(e => e.id === edgeId);
  if (!edge) return 0;
  
  // For base and other scenarios: use stored params
  const override = scenario.params.edges?.[edge.uuid]?.p?.mean;
  if (typeof override === 'number') return override;
  
  // Fallback to base
  return edge.p?.mean || 0;
}

// Helper: Get stdev for a specific layer
function getLayerStdev(
  layerId: string,
  edgeId: string,
  scenarios: Scenario[],
  graph: Graph
): number | undefined {
  if (layerId === 'current') {
    const edge = graph.edges.find(e => e.id === edgeId);
    return edge?.p?.stdev;
  }
  
  const scenario = scenarios.find(s => s.id === layerId);
  if (!scenario) return undefined;
  
  const edge = graph.edges.find(e => e.id === edgeId);
  if (!edge) return undefined;
  
  const override = scenario.params.edges?.[edge.uuid]?.p?.stdev;
  return override;
}
```

**Update EdgeLabelRenderer in ConversionEdge:**

```typescript
// In ConversionEdge.tsx, replace line ~1681 and ~1702:

// OLD (single value):
{Math.round((effectiveProbability || 0) * 100)}%

// NEW (composite label):
{buildCompositeEdgeLabel(
  { id: id, ...data } as Edge,
  visibleScenarioIds,
  colorMap,
  scenarios,
  graph,
  whatIfDSL
)}
```

### Access Required Data

ConversionEdge needs access to:
- `visibleScenarioIds` - from TabContext
- `colorMap` - from ScenariosPanel (may need to pass down or recalculate)
- `scenarios` - from ScenariosContext

**May need to:**
1. Pass these as props from GraphCanvas
2. Or use context hooks directly in ConversionEdge
3. Recalculate colorMap in ConversionEdge using `assignColors(visibleScenarioIds, visibleColorOrderIds)`

### Testing

**Test Case 1:** Single layer visible
- **Expected:** `50%` in black text (like current)

**Test Case 2:** Multiple layers + current visible
- **Expected:** `[cyan] 40% ± 2%  [magenta] 45%  [pink] 60%` (colored segments)

**Test Case 3:** Multiple layers + current hidden
- **Expected:** `[cyan] 40% ± 2%  [magenta] 45%  (60%)` (current in grey with parens)

---

## Change 7: PMF Warnings for 'Current' Only

### Current Implementation

**Status:** Need to search for PMF validation logic

**Search commands:**
```bash
grep -r "PMF\|outbound.*sum\|probabilities.*sum" graph-editor/src/
grep -r "validation\|validateGraph\|checkProbabilities" graph-editor/src/
```

### Required Implementation

**Ensure PMF validation only runs for 'current':**

```typescript
// WRONG: Loop over visible scenarios
for (const scenarioId of visibleScenarioIds) {
  const outboundSum = calculateOutboundSum(node, scenarioId);
  if (Math.abs(outboundSum - 1.0) > 0.01) {
    addWarning(`Node ${node.id}: Outbound PMF = ${outboundSum.toFixed(2)}`);
  }
}

// CORRECT: Only validate 'current' (live graph)
function validatePMF(graph: Graph, whatIfDSL: string | null) {
  for (const node of graph.nodes) {
    const outboundEdges = graph.edges.filter(e => e.from === node.id);
    
    const sum = outboundEdges.reduce((acc, edge) => {
      // Use 'current' probability: live graph + What-If
      const prob = computeEffectiveEdgeProbability(graph, edge.id, { whatIfDSL });
      return acc + prob;
    }, 0);
    
    // Only warn about issues in the live, editable graph
    if (Math.abs(sum - 1.0) > 0.01) {
      addWarning({
        nodeId: node.id,
        message: `Outbound probabilities sum to ${sum.toFixed(2)} (should be 1.0)`,
        severity: 'warning',
        actionable: true  // User can edit to fix
      });
    }
  }
}

// Call only once, not per visible layer
validatePMF(graph, currentTabState.whatIfDSL);
```

### Rationale

- PMF warnings are about **fixing the live graph**
- Scenario snapshots are **frozen/historical** - not editable
- Warning about snapshot PMF violations is **noise** (not actionable)
- Only 'current' layer warnings help users

### Testing

**Test Case:** Multiple layers visible with PMF violations
- **Expected:** Only ONE warning per node (for 'current' layer)
- **Expected:** No warnings about historical snapshots
- **Expected:** Warnings disappear when 'current' hidden (VIEW mode - nothing to fix)

---

## Implementation Order

### Phase 1: Critical Fixes (Day 1-2)
1. ✅ **Change 1:** Fix compositing (critical for correct layer values)
2. ✅ **Change 2:** Remove null parameter (code cleanup, low risk)
3. ✅ **Change 3:** Hidden current opacity (important for UX)

### Phase 2: Snapshot & Display (Day 2-3)
4. ✅ **Change 4:** Snapshot semantics (important for correct capture)
5. ✅ **Change 6:** Composite edge labels (major UI feature)

### Phase 3: Validation & Polish (Day 3-4)
6. ✅ **Change 5:** Verify color assignment (already correct)
7. ✅ **Change 7:** PMF warnings (nice to have, low impact)

### Phase 4: Testing & Documentation (Day 4-5)
- Comprehensive testing of all changes
- Update user documentation
- Create migration guide if needed

---

## Testing Strategy

### Unit Tests Needed

1. **Compositing Logic:**
   ```typescript
   describe('Scenario Layer Compositing', () => {
     it('should compose from base + all visible layers below', () => {
       // Test case with 3 visible layers
     });
     
     it('should skip hidden layers in composition', () => {
       // Test case with hidden layer in middle
     });
   });
   ```

2. **Snapshot Capture:**
   ```typescript
   describe('Snapshot Capture', () => {
     it('should capture What-If effects in snapshot', () => {
       // Apply What-If, create snapshot, verify values
     });
   });
   ```

3. **Edge Labels:**
   ```typescript
   describe('Composite Edge Labels', () => {
     it('should show single black text for one layer', () => {});
     it('should show colored segments for multiple layers', () => {});
     it('should show grey parentheses for hidden current', () => {});
   });
   ```

### Integration Tests

1. **Multi-Layer Rendering:**
   - Create 3 scenarios
   - Toggle visibility in different combinations
   - Verify edge widths differ correctly

2. **What-If with Scenarios:**
   - Apply What-If
   - Create snapshot
   - Verify snapshot shows What-If values
   - Change What-If
   - Verify snapshot doesn't change

3. **Hidden Current Interaction:**
   - Hide current
   - Verify edges still clickable
   - Verify What-If still works
   - Verify faint current overlay visible

### Manual Testing Checklist

- [ ] Layer compositing: Tab A vs Tab B show different values with different visible layers
- [ ] Hidden current: Very faint overlay (5% opacity) still visible
- [ ] Snapshot capture: Snapshots include What-If effects
- [ ] Edge labels: Multiple colored segments shown correctly
- [ ] PMF warnings: Only one warning per node (not per layer)
- [ ] Color assignment: Hidden current doesn't get palette color
- [ ] Interactive edges: Always work regardless of current visibility

---

## Rollback Plan

If issues arise:

1. **Compositing (Change 1):** Can revert to base-only composition (old behavior)
2. **Null parameter (Change 2):** Add back null if needed (function signature allows it)
3. **Opacity (Change 3):** Can change back to completely hiding current
4. **Snapshots (Change 4):** Can revert to capturing raw values
5. **Labels (Change 6):** Can revert to single value display
6. **PMF (Change 7):** Can revert to validating all layers

**Mitigation:** Feature flags for each change to enable gradual rollout

---

## Success Criteria

✅ All 7 changes implemented and tested  
✅ No regressions in existing functionality  
✅ Unit tests passing for new logic  
✅ Integration tests passing for multi-layer scenarios  
✅ Manual testing checklist completed  
✅ Documentation updated  
✅ Code reviewed and approved  

---

## Notes for Reviewers

- **Critical:** Change 1 (compositing) affects correctness of scenario values
- **High Impact:** Change 6 (labels) is most visible to users
- **Low Risk:** Changes 2, 3, 7 are relatively safe
- **Already Done:** Change 5 requires no code changes (verify only)

---

*Plan created: 2025-11-13*  
*Based on: EDGE_RENDERING_ARCHITECTURE.md v2.0*

