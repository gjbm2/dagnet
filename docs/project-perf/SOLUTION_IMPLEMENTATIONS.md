# Performance Solution Implementations

**Date**: November 16, 2025  
**Issue**: Pan/zoom performance bottlenecks  
**Status**: Solutions documented, ready for clean implementation

---

## Overview

This document details the diagnostic tools and solution approaches we tested. These are **reference implementations** to guide a clean production implementation.

---

## Part 1: Diagnostic Tools

### 1.1 Minimal Mode (`?minimal`)

**Purpose**: Disable scenario system entirely to isolate base ReactFlow performance.

**Usage**: Add `?minimal` to URL

**Implementation**:
```typescript
// GraphCanvas.tsx
const urlParams = new URLSearchParams(window.location.search);
const isMinimalMode = urlParams.has('minimal');

// Hardcode minimal scenario state
const visibleScenarioIds = isMinimalMode ? ['current'] : (scenarioState?.visibleScenarioIds || []);
const visibleColourOrderIds = isMinimalMode ? ['current'] : (scenarioState?.visibleColourOrderIds || []);
```

**Effect**:
- Only 'current' layer rendered (no overlays)
- No scenario colour blending
- Minimal edge count (100 vs 300)
- Isolates ReactFlow baseline performance

**Results**:
- Confirmed scenario system is NOT the bottleneck
- Base ReactFlow performance is acceptable (~8ms/frame)
- Bottleneck is in decorations (chevrons/beads)

---

### 1.2 No Beads Mode (`?nobeads`)

**Purpose**: Disable edge beads to measure their performance impact.

**Usage**: Add `?nobeads` to URL

**Implementation**:
```typescript
// ConversionEdge.tsx
{!data?.suppressLabel && 
 !data?.scenarioOverlay && 
 pathRef.current && 
 fullEdge && 
 scenariosContext && 
 !(window as any).NO_BEADS_MODE &&  // <-- Check flag
 (
  <EdgeBeadsRenderer ... />
)}

// Set flag on page load
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has('nobeads')) {
  (window as any).NO_BEADS_MODE = true;
}
```

**Effect**:
- All edge beads hidden
- No React portal reconciliation
- No DOM queries for bead positioning

**Results**:
- Pan frame time: 18-22ms (improved from 28ms)
- Beads account for ~8-10ms per pan frame
- Still not smooth 60fps (chevrons are remaining bottleneck)

---

### 1.3 No Chevrons Mode (`?nochevrons`)

**Purpose**: Disable chevron clipPaths to measure their performance impact.

**Usage**: Add `?nochevrons` to URL

**Implementation**:
```typescript
// GraphCanvas.tsx
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has('nochevrons')) {
  (window as any).NO_CHEVRONS_MODE = true;
}

// Skip bundling if flag set
const bundles = (useSankeyView || (window as any).NO_CHEVRONS_MODE) 
  ? [] 
  : groupEdgesIntoBundles(newEdges, nodesWithFaces);

// Skip rendering if flag set
{!(window as any).NO_CHEVRONS_MODE && (
  <Panel position="top-left">
    <ChevronClipPaths bundles={bundles} nodes={nodes} />
  </Panel>
)}
```

**Effect**:
- No clipPath defs generated
- Edges render without clipping (straight to node boundaries)
- No GPU clip application cost

**Results**:
- Pan frame time: 16-20ms (improved from 28ms)
- Chevrons account for ~10-12ms per pan frame
- Still not smooth 60fps (beads are remaining bottleneck)

---

### 1.4 Combined Mode (`?nobeads&nochevrons`)

**Purpose**: Disable both subsystems to confirm they're the bottleneck.

**Usage**: Add `?nobeads&nochevrons` to URL

**Results**:
- Pan frame time: 8-12ms ✅
- **Smooth 60fps** achieved
- Confirms both subsystems are required for full solution

---

## Part 2: Solution Approach

### 2.1 The Core Strategy

**Principle**: Suppress expensive decorations during high-frequency events (pan/zoom), restore after.

**Why it works**:
- Pan/zoom = 60fps event stream (16ms budget per frame)
- Decorations designed for low-frequency events (graph edits)
- Mismatch causes budget overrun
- Suppression during pan → 0ms cost for decorations

**Implementation pattern**:
```typescript
// Track pan state
const [isPanningOrZooming, setIsPanningOrZooming] = useState(false);

// Suppress decorations when panning
const shouldRenderDecorations = !isPanningOrZooming;

// Detect pan start/end
onMoveStart={() => setIsPanningOrZooming(true)}
onMoveEnd(() => setIsPanningOrZooming(false)}
```

---

### 2.2 Chevron Suppression Implementation

**Goal**: Set `bundles` prop to `[]` during pan, restore to `edgeBundles` after.

**Simple version (immediate restoration)**:
```typescript
// GraphCanvas.tsx
<ChevronClipPaths
  bundles={isPanningOrZooming ? [] : edgeBundles}
  nodes={nodes}
/>
```

**Effect**:
- During pan: No clipPath defs → edges render unclipped → 0ms clip cost
- After pan: All clipPath defs appear → edges render clipped → normal appearance

**Problem**: Restoring 100 bundles at once causes blown frame (100-150ms)

**Advanced version (incremental restoration)** - see Section 2.4

---

### 2.3 Bead Suppression Implementation

**Goal**: Unmount `EdgeBeadsRenderer` during pan (not just hide it).

**Key insight**: Hiding beads (`display: none`) still reconciles portals. Must not render at all.

**Implementation path**: Pass flag through edge data

```typescript
// GraphCanvas.tsx - in buildScenarioRenderEdges call
const result = buildScenarioRenderEdges({
  // ... other params
  isPanningOrZooming: isPanningOrZooming  // Pass flag down
});

// buildScenarioRenderEdges.ts - add to edge data
data: {
  ...edge.data,
  isPanningOrZooming: isPanningOrZooming ?? false,
}

// ConversionEdge.tsx - conditionally render
{!data?.suppressLabel && 
 !data?.scenarioOverlay && 
 !data?.isPanningOrZooming &&  // <-- New condition
 pathRef.current && 
 fullEdge && 
 scenariosContext && 
 (
  <EdgeBeadsRenderer ... />
)}
```

**Effect**:
- During pan: `EdgeBeadsRenderer` not in tree → 0 portal reconciliations
- After pan: `EdgeBeadsRenderer` mounts → beads appear

**Why this works vs hiding**:
```typescript
// ❌ Hiding (still expensive)
<EdgeBeadsRenderer style={{ display: isPanning ? 'none' : 'block' }} />
// Portal still reconciles every frame, just not visible

// ✅ Unmounting (cheap)
{!isPanning && <EdgeBeadsRenderer />}
// Portal not in tree at all, no reconciliation
```

---

### 2.4 Incremental Restoration (Advanced)

**Problem**: Restoring all decorations at once (after pan ends) causes a single blown frame.

**Solution**: Restore in batches across multiple frames.

**Mechanism**:

```typescript
// State for incremental restoration
const [activeBundleCount, setActiveBundleCount] = useState<number>(Infinity);
const restorationRafRef = useRef<number | null>(null);

// On pan start: suppress immediately
onMoveStart(() => {
  if (restorationRafRef.current) {
    cancelAnimationFrame(restorationRafRef.current);
  }
  setActiveBundleCount(0);  // Suppress all
  setIsPanningOrZooming(true);
})

// On pan end: restore incrementally
onMoveEnd(() => {
  setIsPanningOrZooming(false);
  
  const totalBundles = edgeBundles.length;
  const BATCH_SIZE = 10;
  let currentCount = 0;
  
  const restoreNextBatch = () => {
    currentCount = Math.min(currentCount + BATCH_SIZE, totalBundles);
    setActiveBundleCount(currentCount);
    
    if (currentCount < totalBundles) {
      restorationRafRef.current = requestAnimationFrame(restoreNextBatch);
    } else {
      setActiveBundleCount(Infinity);  // Restoration complete
      restorationRafRef.current = null;
    }
  };
  
  restorationRafRef.current = requestAnimationFrame(restoreNextBatch);
})

// Render with sliced bundles
<ChevronClipPaths
  bundles={
    isPanningOrZooming 
      ? [] 
      : activeBundleCount === Infinity 
        ? edgeBundles 
        : edgeBundles.slice(0, activeBundleCount)
  }
  nodes={nodes}
/>
```

**Restoration timeline (100 bundles example)**:

| Frame | activeBundleCount | Bundles Added | Frame Time |
|-------|-------------------|---------------|------------|
| Pan end | 0 | 0 | 11ms |
| +1 | 10 | 10 | 13ms |
| +2 | 20 | 10 | 14ms |
| +3 | 30 | 10 | 13ms |
| ... | ... | ... | ... |
| +10 | 100 → ∞ | 10 | 14ms |

**Total restoration**: ~166ms across 10 frames (smooth)  
**vs immediate**: 127ms in 1 frame (blown)

**Beads restoration**: Keep suppressed until `activeBundleCount === Infinity`

```typescript
const shouldSuppressBeads = isPanningOrZooming || activeBundleCount !== Infinity;

// Pass to edges
isPanningOrZooming: shouldSuppressBeads
```

---

## Part 3: Implementation Details

### 3.1 Pan/Zoom State Management

**Challenge**: Detect actual pan/zoom vs click events.

**Solution**: Track initial viewport and compare on move

```typescript
const [isPanningOrZooming, setIsPanningOrZooming] = useState(false);
const hasMovedRef = useRef(false);
const moveStartViewportRef = useRef<{x,y,zoom} | null>(null);

onMoveStart((_, viewport) => {
  moveStartViewportRef.current = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
  hasMovedRef.current = false;
  setIsPanningOrZooming(true);
})

onMove((_, viewport) => {
  if (moveStartViewportRef.current) {
    const dx = Math.abs(viewport.x - moveStartViewportRef.current.x);
    const dy = Math.abs(viewport.y - moveStartViewportRef.current.y);
    const dz = Math.abs(viewport.zoom - moveStartViewportRef.current.zoom);
    
    if (dx > 1 || dy > 1 || dz > 0.01) {
      hasMovedRef.current = true;
    }
  }
})

onMoveEnd((_, viewport) => {
  if (hasMovedRef.current) {
    // Actual pan occurred - start restoration
  } else {
    // Just a click - reset immediately
    setIsPanningOrZooming(false);
  }
})
```

**Why threshold check matters**: Prevents clicks from triggering suppression/restoration cycle.

---

### 3.2 Edge Data Flow for Bead Suppression

**Data flow path**:

1. `GraphCanvas.tsx`: Computes `shouldSuppressBeads`
2. `buildScenarioRenderEdges()`: Receives flag as param, adds to edge data
3. `ConversionEdge.tsx`: Reads `data.isPanningOrZooming`, conditionally renders beads

**Why this path**:
- `renderEdges` already recomputes when `shouldSuppressBeads` changes (it's a dep)
- Edge data is the natural channel for per-edge rendering decisions
- Avoids prop drilling through intermediate components

**Alternative considered**: Global `window.DAGNET_IS_PANNING` flag
- ❌ Harder to track in React DevTools
- ❌ Doesn't trigger React re-renders automatically
- ❌ Requires manual effect to sync

---

### 3.3 Memo Dependency Management

**Critical**: `renderEdges` useMemo must depend on suppression state

```typescript
const renderEdges = useMemo(() => {
  return buildScenarioRenderEdges({
    // ...
    isPanningOrZooming: shouldSuppressBeads
  });
}, [
  // ... other deps
  shouldSuppressBeads  // MUST include this
]);
```

**Why**: Without this dep, edges render with stale `isPanningOrZooming` value, beads don't suppress.

---

### 3.4 Cleanup and Edge Cases

**Component unmount**:
```typescript
useEffect(() => {
  return () => {
    if (restorationRafRef.current) {
      cancelAnimationFrame(restorationRafRef.current);
    }
  };
}, []);
```

**Pan during restoration**:
```typescript
onMoveStart(() => {
  // Cancel any pending restoration
  if (restorationRafRef.current) {
    cancelAnimationFrame(restorationRafRef.current);
    restorationRafRef.current = null;
  }
  setActiveBundleCount(0);  // Reset to suppressed state
})
```

**Zero bundles**:
```typescript
const restoreNextBatch = () => {
  if (totalBundles === 0) {
    setActiveBundleCount(Infinity);  // Skip restoration loop
    return;
  }
  // ... normal restoration
};
```

---

## Part 4: Performance Characteristics

### 4.1 Frame Budget Breakdown

**Baseline (no optimization)**:
- ReactFlow: 3-5ms
- Edge rendering: 4-6ms
- Chevron clipping: 10-15ms
- Bead portals: 8-12ms
- **Total**: 27-41ms ❌

**With suppression**:
- ReactFlow: 3-5ms
- Edge rendering: 4-6ms
- Chevron clipping: **0ms** ✅
- Bead portals: **0ms** ✅
- **Total**: 9-14ms ✅

**Improvement**: 18-27ms saved = 2-3× faster

---

### 4.2 User Experience Impact

**During pan**:
- Edges render without chevrons (straight to nodes) - acceptable
- No beads visible - acceptable (they'd be blurry during motion anyway)
- Smooth 60fps - excellent

**After pan**:
- **Immediate restoration**: Freeze for 100ms - poor
- **Deferred restoration**: Smooth pan, then freeze later - confusing
- **Incremental restoration**: Progressive decoration appearance over 166ms - good

**User perception**: "Smooth panning" is more important than "instant decoration restoration"

---

### 4.3 Trade-offs

**Suppression during pan**:
- ✅ Pro: Smooth 60fps guaranteed
- ⚠️ Con: Decorations temporarily missing

**Incremental restoration**:
- ✅ Pro: No blown frames
- ⚠️ Con: Progressive pop-in (chevrons appear in batches)
- ⚠️ Con: More complex code

**Tuning parameters**:
- `BATCH_SIZE = 10`: Balance between restoration speed (lower = slower) and frame budget (higher = heavier frames)
- Recommended range: 5-20 bundles/frame

---

## Part 5: Alternative Approaches Considered

### 5.1 Viewport-Aware Rendering ❌

**Idea**: Only render decorations for edges in viewport.

**Why rejected**:
- ReactFlow already culls off-screen edges
- Our decorations are on visible edges
- Complexity high, benefit low

---

### 5.2 CSS Transform Instead of Recalculation ❌

**Idea**: Transform bead positions with viewport instead of recalculating.

**Why rejected**:
- Beads positioned in screen space, not graph space
- Would need complex coordinate transformation
- Doesn't help with portal reconciliation cost

---

### 5.3 Web Workers for Calculations ❌

**Idea**: Offload bead position calculations to worker thread.

**Why rejected**:
- JS calculations are fast (2-4ms)
- Bottleneck is paint, not JS
- Worker communication overhead would make it slower

---

### 5.4 Canvas Rendering Instead of SVG ❌

**Idea**: Render edges on `<canvas>` for better pan performance.

**Why rejected**:
- Massive architectural change
- Loses SVG benefits (selection, interaction, styling)
- ReactFlow is SVG-based
- Would need to prove it's faster (unclear)

---

### 5.5 Debounced Restoration ❌

**Idea**: Wait N ms after pan stops before restoring.

**Why rejected**:
- User might pan again during delay
- Causes visual "pop" when decorations suddenly appear
- Incremental restoration is smoother

---

## Part 6: Production Implementation Checklist

When implementing this solution cleanly:

### Phase 1: Core Suppression
- [ ] Add `isPanningOrZooming` state to GraphCanvas
- [ ] Wire `onMoveStart`/`onMove`/`onMoveEnd` handlers
- [ ] Implement movement detection (threshold-based)
- [ ] Pass flag to chevron renderer
- [ ] Pass flag through edge data to bead renderer
- [ ] Test: Pan should be smooth 60fps

### Phase 2: Incremental Restoration
- [ ] Add `activeBundleCount` state
- [ ] Implement RAF-based restoration loop
- [ ] Wire restoration start to `onMoveEnd`
- [ ] Wire restoration cancel to `onMoveStart`
- [ ] Slice bundles array based on `activeBundleCount`
- [ ] Test: No blown frames after pan

### Phase 3: Bead Restoration
- [ ] Compute `shouldSuppressBeads` from pan state AND restoration state
- [ ] Update edge data flag
- [ ] Test: Beads appear after chevrons complete

### Phase 4: Edge Cases
- [ ] Handle pan during restoration (cancel RAF)
- [ ] Handle component unmount (cancel RAF)
- [ ] Handle zero bundles edge case
- [ ] Test: Rapid pan/stop cycles work correctly

### Phase 5: Tuning
- [ ] Experiment with `BATCH_SIZE` (5, 10, 20)
- [ ] Profile restoration frame times
- [ ] Adjust for acceptable restoration speed
- [ ] Document chosen value and rationale

### Optional: Diagnostic Flags
- [ ] Add `?nobeads` flag for debugging
- [ ] Add `?nochevrons` flag for debugging
- [ ] Add `?minimal` flag for baseline testing
- [ ] Document flags in README

---

## Part 7: Code Locations

Files that need changes for clean implementation:

### Core Files
- `graph-editor/src/components/GraphCanvas.tsx`
  - Pan state management
  - Incremental restoration logic
  - Pass flags to subcomponents

- `graph-editor/src/components/canvas/buildScenarioRenderEdges.ts`
  - Accept `isPanningOrZooming` param
  - Add to edge data

- `graph-editor/src/components/edges/ConversionEdge.tsx`
  - Read `isPanningOrZooming` from edge data
  - Conditionally render `EdgeBeadsRenderer`

- `graph-editor/src/components/ChevronClipPaths.tsx`
  - No changes needed (just receives different bundles array)

### Type Definitions
- `graph-editor/src/components/edges/ConversionEdge.tsx`
  - Add `isPanningOrZooming?: boolean` to `ConversionEdgeData` interface

- `graph-editor/src/components/canvas/buildScenarioRenderEdges.ts`
  - Add `isPanningOrZooming?: boolean` to `BuildScenarioRenderEdgesParams` interface

---

## Conclusion

The solution is conceptually simple:

1. **Detect pan/zoom**: Track viewport movement
2. **Suppress decorations**: Unmount beads, hide chevrons
3. **Restore incrementally**: Spread restoration cost across multiple frames

The complexity is in the details (movement detection, RAF loops, edge cases), but the core principle is: **For high-frequency events, suppression beats optimization**.

