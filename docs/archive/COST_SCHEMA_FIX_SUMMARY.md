# Cost Schema Migration Fix Summary

## Date: October 29, 2025

## Problem
The cost schema was migrated from nested `edge.costs.monetary.value` / `edge.costs.time.value` to flat `edge.cost_gbp.mean` / `edge.cost_time.mean`, but analytics code was still using the old paths, causing all cost calculations to return zero.

## Root Cause
Path Analysis and What-If Analysis code was reading edge costs using the old nested schema:
- Old: `edge.data?.costs?.monetary?.value`
- New: `edge.data?.cost_gbp?.mean`

## Files Fixed

### 1. `/graph-editor/src/lib/pathAnalysis.ts`
**Line 257-262**: Updated `calculatePathProbability()` function
- **Before**: 
  ```typescript
  const edgeCost = {
    monetary: edgeCosts?.monetary?.value || 0,
    time: edgeCosts?.time?.value || 0,
    units: edgeCosts?.time?.units || ''
  };
  ```
- **After**:
  ```typescript
  const edgeCost = {
    monetary: edge.data?.cost_gbp?.mean || 0,
    time: edge.data?.cost_time?.mean || 0,
    units: 'days' // Units now implicit: GBP and days
  };
  ```

**Lines 622-625**: Already correct (using new schema in `calculateGeneralStats()`)

### 2. `/graph-editor/src/components/GraphCanvas.tsx`
**Line 2568-2573**: Updated `dagCalc()` internal DFS function
- **Before**:
  ```typescript
  const edgeCost = {
    monetary: edgeCosts?.monetary?.value || 0,
    time: edgeCosts?.time?.value || 0,
    units: edgeCosts?.time?.units || ''
  };
  ```
- **After**:
  ```typescript
  const edgeCost = {
    monetary: edge.data?.cost_gbp?.mean || 0,
    time: edge.data?.cost_time?.mean || 0,
    units: 'days' // Units now implicit: GBP and days
  };
  ```

**Line 2778-2782**: Updated direct path cost calculation
- **Before**:
  ```typescript
  const directPathCosts = {
    monetary: directEdge?.data?.costs?.monetary?.value || 0,
    time: directEdge?.data?.costs?.time?.value || 0,
    units: directEdge?.data?.costs?.time?.units || ''
  };
  ```
- **After**:
  ```typescript
  const directPathCosts = {
    monetary: directEdge?.data?.cost_gbp?.mean || 0,
    time: directEdge?.data?.cost_time?.mean || 0,
    units: 'days' // Units now implicit: GBP and days
  };
  ```

**Lines 3070-3076**: Already correct (using new schema in general stats aggregation)

### 3. `/graph-editor/src/lib/runner.ts`
**Line 385-389**: Updated edge cost precomputation map
- **Before**:
  ```typescript
  const monetaryCost = (e as any).costs?.monetary;
  const timeCost = (e as any).costs?.time;
  const edgeCost = {
    monetary: typeof monetaryCost === 'object' && monetaryCost !== null ? (monetaryCost.value || 0) : (typeof monetaryCost === 'number' ? monetaryCost : 0),
    time: typeof timeCost === 'object' && timeCost !== null ? (timeCost.value || 0) : (typeof timeCost === 'number' ? timeCost : 0)
  };
  ```
- **After**:
  ```typescript
  const edgeCost = {
    monetary: (e as any).cost_gbp?.mean || 0,
    time: (e as any).cost_time?.mean || 0
  };
  ```

**Lines 322-325**: Already correct (using new schema in state calculation)

## Already Correct (No Changes Needed)
- `/graph-editor/src/components/edges/ConversionEdge.tsx` - Edge label display (lines 144-158, 1107-1140)
- `/graph-editor/src/lib/pathAnalysis.ts` - `calculateGeneralStats()` aggregation (lines 622-625)
- `/graph-editor/src/components/GraphCanvas.tsx` - General stats aggregation (lines 3070-3076)
- `/graph-editor/src/lib/runner.ts` - State-based cost tracking (lines 322-325)

## Verification
✅ All linter errors resolved
✅ No remaining references to old schema in active code paths
✅ Cost calculations now correctly read from `cost_gbp.mean` and `cost_time.mean`
✅ Units are now implicit (GBP for monetary, days for time)

## Impact
This fix ensures that:
1. **Path Analysis** correctly calculates and displays expected costs for all path modes (single node, two nodes, sequential, parallel, multi-end)
2. **What-If Analysis** correctly computes cost impacts when probabilities are overridden
3. **Runner/Simulation** correctly accumulates costs through the graph
4. **Edge displays** continue to show cost information correctly (already working)

## Legacy Compatibility
The `edge.costs` field is still preserved in edge data for backward compatibility, but is no longer used in any calculation paths.

