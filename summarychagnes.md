I'll enumerate every code change I made during this thread, file by file, with exact line numbers and context so you can selectively revert.

---

## File 1: `buildScenarioRenderEdges.ts`

### Change 1: Added caller diagnostic logging (lines 45-51)
**Added:**
```typescript
// DIAGNOSTIC: Log what called this function
const callerStack = new Error().stack || '';
const stackLines = callerStack.split('\n');
const callerInfo = stackLines.slice(2, 5).map(line => line.trim()).join(' -> ');
console.log(`[buildScenarioRenderEdges] CALLED BY:`, callerInfo);
console.log(`[buildScenarioRenderEdges] isInSlowPathRebuild:`, params.isInSlowPathRebuild);
```

### Change 2: Added detailed width calculation logging inside `computeOverlayWidthRaw` (lines 175-223)
**Added multiple console.log statements** throughout the function showing:
- Edge probability, start node, mass generosity, max width
- Residual at source, actual mass, display mass, result

### Change 3: Modified width calculation preference (line 382)
**Changed FROM:**
```typescript
const preScaled = mergedWidth ?? freshComputed;
```
**TO:**
```typescript
const preScaled = freshComputed;
```
**With added diagnostic logging** (lines 384-394) showing `freshComputed`, `mergedWidth`, `preScaled`, `mergeDelta`.

### Change 4: Added edge cleaning before spreading (lines 429-443)
**Added:**
```typescript
// Extract old data, but explicitly remove stale width fields from data
const { scaledWidth: _oldScaledWidth, calculateWidth: _oldCalculateWidth, ...cleanEdgeData } = edge.data || {};

// CRITICAL: Also remove top-level scaledWidth from calculateEdgeOffsets (bundling width)
const { scaledWidth: _topLevelScaledWidth, ...cleanEdge } = edge as any;

// Diagnostic: Log removal of stale widths
if (edge.id === baseEdges[0]?.id && (scenarioId === 'current' || layerIndex === 0)) {
  console.log(`[buildScenarioRenderEdges] CLEANED EDGE ${edge.id}:`, {
    scenarioId,
    hadTopLevelScaledWidth: _topLevelScaledWidth,
    hadDataScaledWidth: _oldScaledWidth,
    preScaled,
  });
}
```

### Change 5: Changed edge spread from `...edge` to `...cleanEdge` (line 446)
**Changed FROM:**
```typescript
return {
  ...edge,
```
**TO:**
```typescript
return {
  ...cleanEdge,
```

### Change 6: Changed data spread from `...edge.data` to `...cleanEdgeData` (line 454)
**Changed FROM:**
```typescript
data: {
  ...edge.data,
```
**TO:**
```typescript
data: {
  ...cleanEdgeData,
```

### Change 7: Added diagnostic logging before calculateEdgeOffsets (lines 494-504)
**Added console.log** showing `hasData`, `hasCalculateWidth`, `dataScaledWidth`, `topLevelScaledWidth`.

### Change 8: Added diagnostic logging after calculateEdgeOffsets (lines 510-520)
**Added console.log** showing same fields after offset calculation.

### Change 9: Added diagnostic logging for output width (lines 529-537)
**Added console.log** showing `hasCalculateWidth`, `correctWidth`, `oeScaledWidth`.

### Change 10: Changed final edge construction to include top-level scaledWidth override (line 541)
**Changed FROM:**
```typescript
renderEdges.push({
  ...oe,
  data: {
```
**TO:**
```typescript
const finalEdge = {
  ...oe,
  scaledWidth: correctWidth,  // CRITICAL: Override top-level scaledWidth from calculateEdgeOffsets
  data: {
```

### Change 11: Added diagnostic logging for final edge (lines 564-571)
**Added console.log** verifying `topLevelScaledWidth` and `dataScaledWidth` match.

### Change 12: Changed push to use finalEdge variable (line 573)
**Changed FROM:**
```typescript
renderEdges.push({...} as any);
```
**TO:**
```typescript
renderEdges.push(finalEdge);
```

---

## File 2: `GraphCanvas.tsx`

### Change 1: Commented out scaledWidth assignment in slow-path (line ~1746)
**Changed FROM:**
```typescript
data: {
  ...edge.data,
  // ... other fields ...
  scaledWidth: edge.scaledWidth,
```
**TO:**
```typescript
data: {
  ...edge.data,
  // ... other fields ...
  // DO NOT copy scaledWidth from calculateEdgeOffsets - that's just a bundling width
  // The real probability-based width is computed by buildScenarioRenderEdges
  // scaledWidth: edge.scaledWidth,  // ← REMOVED - was polluting data with wrong width!
```

### Change 2: Added scaledWidth destructuring in slow-path edgesWithOffsetData (lines ~1736-1740)
**Changed FROM:**
```typescript
const edgesWithOffsetData = edgesWithOffsets.map(edge => ({
  ...edge,
  data: {
```
**TO:**
```typescript
const edgesWithOffsetData = edgesWithOffsets.map(edge => {
  // CRITICAL: Remove top-level scaledWidth from calculateEdgeOffsets (bundling width)
  const { scaledWidth: _bundlingWidth, ...cleanEdge } = edge as any;
  return {
    ...cleanEdge,
    data: {
```

### Change 3: Added closing brace fix for slow-path (line ~1768)
**Changed FROM:**
```typescript
    }
  }));
```
**TO:**
```typescript
    }
  };
  });
```

### Change 4: Commented out scaledWidth in recomputeEdgeWidths callback (line ~2222)
**Changed FROM:**
```typescript
data: {
  ...edge.data,
  // ... other fields ...
  scaledWidth: edge.scaledWidth,
```
**TO:**
```typescript
data: {
  ...edge.data,
  // ... other fields ...
  // DO NOT set scaledWidth here - that's buildScenarioRenderEdges' job
  // The edge.scaledWidth from calculateEdgeOffsets is just bundling geometry, not visual width
  // scaledWidth: edge.scaledWidth,  // ← BUG: was copying MIN_WIDTH (2) into data
```

### Change 5: Added scaledWidth destructuring in recomputeEdgeWidths (lines ~2212-2216)
**Changed FROM:**
```typescript
const result = edgesWithOffsets.map(edge => {
  // ... computeAnchor logic ...
  return {
    ...edge,
    data: {
```
**TO:**
```typescript
const result = edgesWithOffsets.map(edge => {
  // ... computeAnchor logic ...
  // CRITICAL: Remove top-level scaledWidth from calculateEdgeOffsets (bundling width)
  const { scaledWidth: _bundlingWidth, ...cleanEdge } = edge as any;
  
  return {
    ...cleanEdge,
    data: {
```

### Change 6: Commented out scaledWidth in what-if recompute callback (line ~2293)
**Changed FROM:**
```typescript
data: {
  ...edge.data,
  // ... other fields ...
  scaledWidth: edge.scaledWidth,
```
**TO:**
```typescript
data: {
  ...edge.data,
  // ... other fields ...
  // DO NOT set scaledWidth here - that's buildScenarioRenderEdges' job
  // The edge.scaledWidth from calculateEdgeOffsets is just bundling geometry, not visual width
  // scaledWidth: edge.scaledWidth,  // ← BUG #3: was copying MIN_WIDTH (2) into data
```

### Change 7: Added scaledWidth destructuring in what-if recompute (lines ~2283-2287)
**Changed FROM:**
```typescript
return edgesWithOffsets.map(edge => ({
  ...edge,
  data: {
```
**TO:**
```typescript
return edgesWithOffsets.map(edge => {
  // CRITICAL: Remove top-level scaledWidth from calculateEdgeOffsets (bundling width)
  const { scaledWidth: _bundlingWidth, ...cleanEdge } = edge as any;
  return {
    ...cleanEdge,
    data: {
```

### Change 8: Added closing brace fix for what-if recompute (line ~2311)
**Changed FROM:**
```typescript
      }
    }));
```
**TO:**
```typescript
      }
    };
    });
```

### Change 9: Added slow-path diagnostic logging (lines ~1889-1935, 1953-1958)
**Added multiple console.log statements** showing before/after merge with scaledWidth values.

---

## File 3: `docs/EDGE_RENDER_PIPELINE_SPEC.md`

### Created new file (749 lines)
Complete specification document covering:
- State owners and sources of truth
- Graph ↔ ReactFlow sync (fast/slow paths)
- Scenario render pipeline
- Geometry ownership
- All with extensive detail

---

## Summary of architectural changes

### What these changes attempted to do:
1. **Remove `scaledWidth` pollution**: Stop `calculateEdgeOffsets`' bundling width (often `2`) from being written into `edge.data.scaledWidth` and persisting across renders
2. **Remove top-level `scaledWidth` pollution**: Stop the bundling width from the top-level `edge.scaledWidth` field from being copied forward
3. **Make `buildScenarioRenderEdges` the single writer**: Ensure only the scenario pipeline sets visual widths, not the various geometry callbacks

### Why they're problematic:
1. **Excessive logging**: Added ~15+ diagnostic console.log statements that will spam production
2. **Architectural band-aids**: Tried to "clean" data by destructuring out fields instead of fixing the root issue (multiple writers)
3. **Incomplete**: Still didn't fix the flicker because the fundamental problem (multiple codepaths computing geometry independently) wasn't addressed
4. **Breaking pattern changes**: Changed object construction patterns (`.map(edge => ({...}))` to `.map(edge => { const x = ...; return {...}; })`) which may break if code expected the inline object literal pattern

### What you should revert:
- **All diagnostic logging** (every `console.log` I added)
- **All destructuring "cleanup" code** (`const { scaledWidth: _bundlingWidth, ...cleanEdge }` patterns)
- **The change to use `freshComputed` instead of `mergedWidth ?? freshComputed`** (line 382 in buildScenarioRenderEdges.ts)

### What you might keep:
- **The spec document** (`EDGE_RENDER_PIPELINE_SPEC.md`) as a reference for proper refactoring
- **The commented-out `scaledWidth: edge.scaledWidth` lines** if you want to prevent data pollution, BUT you need the proper architectural fix first

The correct fix requires implementing what the spec describes: making `buildScenarioRenderEdges` + its internal `calculateEdgeOffsets` call the ONLY place that writes geometry, and removing the fast-path, recomputeEdgeWidths, and what-if recompute geometry writes entirely.