# LAG Update Problems - 10-Dec-25

## Status Summary

| Feature | Status | Notes |
|---------|--------|-------|
| p.mean update | ✅ Working | Blended mean computed, applied via UpdateManager |
| Sibling rebalancing | ✅ Working | Rebalancing triggers when p.mean changes |
| p.forecast display | ❌ Not working | Forecast values not appearing on rendered graph |
| p.latency.completeness | ❌ Not working | Completeness invariant when DSL changes |
| p.latency.* (t95, path_t95, etc.) | ❌ Not working | Latency objects not updating on graph |

---

## Issue 1: Forecasts Not Displaying

### Symptoms
- `p.forecast.mean` exists in logs during LAG computation
- `p.mean` equals `p.evidence.mean` instead of being blended
- Striped forecast bands not rendering

### Root Cause Analysis
The LAG pass flow is:
1. Per-edge fetches → set `p.forecast.mean` via `UpdateManager.applyMappings`
2. `getUpdatedGraph()` returns graph to use for LAG pass
3. `enhanceGraphLatencies(finalGraph)` reads `edge.p.forecast.mean` for blending
4. `applyBatchLAGValues` applies results to graph

**Suspected issue**: `getUpdatedGraph()` may return a STALE graph that doesn't have the per-edge fetch updates (including `p.forecast.mean`).

Most callers pass `graph` as a VALUE to `useFetchData`, not a getter:
```typescript
// These pass stale values:
useFetchData({ graph: graph, ... })  // DataMenu, PropertiesPanel, etc.

// These pass getters (correct):
useFetchData({ graph: () => graphRef.current, ... })  // WindowSelector, BatchOperationsModal
```

### Attempted Fixes
1. Added `forecast` and `evidence` fields to `EdgeLAGValues` interface
2. Modified `enhanceGraphLatencies` to capture `edge.p.forecast` and `edge.p.evidence`
3. Modified `applyBatchLAGValues` to accept and apply these values
4. Updated `fetchDataService` to pass `forecast` and `evidence` through

**Why this didn't work**: If `getUpdatedGraph()` returns stale graph, `edge.p.forecast.mean` is `undefined` when `enhanceGraphLatencies` reads it, so there's nothing to pass through.

---

## Issue 2: Completeness Invariant

### Symptoms
- Changing cohort window DSL doesn't change completeness values
- Downstream edges show ~99% completeness even for recent cohorts
- Completeness should decrease for immature cohorts

### Root Cause Analysis
Completeness is calculated from:
```typescript
const completeness = calculateCompleteness(cohorts, t95, pathT95)
```

Where `cohorts` come from `paramLookup`, which is built from per-edge fetch results.

**Suspected issues**:
1. `paramLookup` may contain ALL historical slices, not just the active DSL's cohort window
2. Filtering logic in `fetchDataService` may not correctly match the DSL

The filtering code attempts to match `cohort()` dates:
```typescript
const filteredValues = allValues.filter(v => {
  // ... parsing cohort() from DSL and matching dates
});
```

But this may not be working correctly, leading to stale/wrong cohorts being used.

### Attempted Fixes
1. Added filtering of `paramValues` based on DSL in `fetchDataService` before passing to `enhanceGraphLatencies`

**Why this may not have worked**: The filtering logic may have bugs, or the dates may not be matching correctly.

---

## Issue 3: Latency Objects Not Updating

### Symptoms
- `p.latency.t95`, `p.latency.completeness`, `p.latency.path_t95` not appearing on graph
- `applyBatchLAGValues` logs show values being applied, but they don't show in UI

### Root Cause Analysis
The flow is:
1. `applyBatchLAGValues` applies latency values to cloned graph
2. Returns graph with latency
3. `computeAndApplyInboundN` maps edges and calls `setGraph`

**Suspected issue**: `computeAndApplyInboundN` may be overwriting or not preserving the latency values.

The mapping in `computeAndApplyInboundN`:
```typescript
updatedGraph.edges = graph.edges.map(edge => {
  if (result !== undefined && edge.p) {
    return {
      ...edge,
      p: {
        ...edge.p,  // Should spread latency
        n: result.n,
        forecast: { ...edge.p.forecast, k: result.forecast_k },
      },
    };
  }
  return edge;
});
```

The `...edge.p` spread SHOULD preserve `latency`, but may not be if the edge object references are stale.

### Attempted Fixes
1. Created `applyBatchLAGValues` to apply all LAG values in one atomic operation
2. Used `structuredClone` to ensure deep copy
3. Added explicit application of `forecast` and `evidence`

**Why this may not have worked**: The subsequent `computeAndApplyInboundN` call or the `setGraph` flow may be discarding the changes.

---

## Key Code Locations

### Graph Update Flow
1. **Per-edge fetch**: `dataOperationsService.getDataFromSource` → `UpdateManager.update` → `setGraph`
2. **LAG enhancement**: `fetchDataService.fetchItems` → `enhanceGraphLatencies` → `applyBatchLAGValues`
3. **Inbound-N**: `computeAndApplyInboundN` → `setGraph`

### Critical Files
- `graph-editor/src/services/fetchDataService.ts` - Orchestrates fetch and LAG pass
- `graph-editor/src/services/statisticalEnhancementService.ts` - `enhanceGraphLatencies` function
- `graph-editor/src/services/UpdateManager.ts` - `applyBatchLAGValues` function
- `graph-editor/src/hooks/useFetchData.ts` - Provides `getUpdatedGraph` callback

### Debug Logs to Check
- `[LAG_PRE_ENHANCE]` - Check if `finalGraph` has forecast values before LAG pass
- `[enhanceGraphLatencies] Blend check:` - Check what values are being used for blending
- `[LAG_TOPO_PUSHING]` - Check what values are being returned from LAG pass
- `[UpdateManager] applyBatchLAGValues:` - Check what's being applied
- `[computeAndApplyInboundN]` - Check if graph has LAG values going in/out

---

## Recommended Next Steps

### Priority 1: Fix the stale graph issue
- Ensure `getUpdatedGraph()` returns the LATEST graph after per-edge fetches
- Consider accumulating graph changes directly in `fetchItems` instead of relying on React state callbacks
- Or use a ref-based approach like `WindowSelector` does

### Priority 2: Verify the data flow
- Add strategic logging to trace the exact graph state at each stage:
  1. After per-edge fetches complete
  2. After `getUpdatedGraph()` call
  3. After `enhanceGraphLatencies` 
  4. After `applyBatchLAGValues`
  5. After `computeAndApplyInboundN`
  6. In the final `setGraph` call

### Priority 3: Consider architectural simplification
- The current approach of reading from graph state → computing → writing back via state is prone to race conditions
- Consider a more functional approach where each stage receives explicit inputs and returns explicit outputs
- Or maintain a graph ref that's updated synchronously instead of via async React state

---

## Tests to Write

1. Test that `applyBatchLAGValues` correctly preserves all fields on output
2. Test that `computeAndApplyInboundN` preserves latency values
3. E2E test that fetching with different DSLs produces different completeness values
4. Test that forecast blending produces different `p.mean` from `p.evidence.mean`

