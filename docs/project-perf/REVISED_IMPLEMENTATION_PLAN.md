# Revised Implementation Plan: Pan/Zoom Performance Fix

**Date**: November 16, 2025  
**Status**: Ready for implementation  
**Approach**: Simple debounced suppression (no incremental batching unless proven necessary)

---

## Background

### The Problem

During pan/zoom, two subsystems cause frame budget overruns:

1. **Chevron clipPaths**: Browser applies SVG clipping to 100+ edges every frame (10-15ms GPU cost)
2. **Edge beads**: React portals reconcile 100+ times per frame (8-12ms JS + paint cost)

**Result**: 27-41ms per pan frame instead of target 16.6ms → dropped frames, jank.

### The Frame Budget Reality

From `perf/frameissues.txt` and research:

- **Browser frames are fixed time slices** (~16.6ms @ 60fps)
- Cannot "extend" a frame or create a "mega-frame"
- If work doesn't finish in the slice, that frame drops
- The "half-rendered" state we see is when:
  - Frame budget exhausted mid-render
  - Browser pauses work to hit next frame deadline
  - Leaves some elements partially drawn

**Key insight**: We can't change frame duration, only **when** and **how much** work we do per frame.

---

## Current State Assessment

### ✅ What's Already Implemented

#### Beads Suppression During Pan

**Status**: ✅ Working correctly

**Implementation**:
1. `GraphCanvas` tracks pan state:
   ```typescript
   const [isPanningOrZooming, setIsPanningOrZooming] = useState(false);
   ```

2. Pan detection with threshold (avoids click false-positives):
   ```typescript
   onMove((_, viewport) => {
     const dx = Math.abs(viewport.x - moveStartViewportRef.current.x);
     const dy = Math.abs(viewport.y - moveStartViewportRef.current.y);
     const dz = Math.abs(viewport.zoom - moveStartViewportRef.current.zoom);
     
     if (dx > 1 || dy > 1 || dz > 0.01) {
       setIsPanningOrZooming(true);
     }
   })
   ```

3. Flag passed to edges via data:
   ```typescript
   data: {
     ...edge.data,
     isPanningOrZooming: isPanningOrZooming
   }
   ```

4. `EdgeBeadsRenderer` early return:
   ```typescript
   if (isPanningOrZooming) {
     return null;  // Component not in tree at all
   }
   ```

**Result**: No bead portals during pan → 0ms bead cost during pan ✅

### ❌ What's Missing

#### 1. Chevrons Still Render During Pan

**Current behaviour**:
- Bundles always computed
- `ChevronClipPaths` always rendered
- Edges always have `clip-path: url(#chevron-id)` applied
- Browser re-composites clipped edges every pan frame → 10-15ms cost

**Gap**: No pan-time suppression for chevrons

#### 2. No Post-Pan Debounce

**Current behaviour**:
- `onMoveEnd` immediately sets `isPanningOrZooming = false`
- Beads mount immediately (100+ portal reconciliations)
- Chevrons recompute immediately via double-RAF effect
- All happens in first frame after pan → potential blown frame

**Gap**: No controlled, debounced restoration

---

## Revised Solution Plan

### Core Principle

**Suppress during pan, debounce after pan, single redraw when settled.**

No incremental batching (Section 2.4 from SOLUTION_IMPLEMENTATIONS.md) unless the simple approach still blows frames.

---

## Implementation Steps

### Step 1: Chevron Suppression During Pan

**Goal**: No clipPath defs rendered while panning → 0ms GPU clip cost

**Changes**:

#### File: `graph-editor/src/components/GraphCanvas.tsx`

**1.1** - Suppress bundle generation during pan:

```typescript
// Generate edge bundles for chevron clipping (suppress in Sankey view or nochevrons mode or during pan)
const bundles = (useSankeyView || NO_CHEVRONS_MODE || isPanningOrZooming) 
  ? [] 
  : groupEdgesIntoBundles(edgesWithOffsetData, nodesWithSelection);
```

**Why**: Skip bundle computation entirely during pan (minor JS savings, clearer intent)

**1.2** - Suppress ChevronClipPaths rendering during pan:

```typescript
{/* Chevron clipPath definitions */}
{/* DIAGNOSTIC: Skip chevrons if ?nochevrons param set */}
{/* PERF: Suppress chevrons during pan to avoid per-frame clip cost */}
{!NO_CHEVRONS_MODE && !isPanningOrZooming && (
  <Panel position="top-left" style={{ pointerEvents: 'none' }}>
    <ChevronClipPaths bundles={edgeBundles} nodes={nodes} frameId={renderFrameRef.current} />
  </Panel>
)}
```

**Why**: No clipPath defs → edges render unclipped → no GPU clip work per frame

**Effect**:
- During pan: edges are plain strokes (no chevrons)
- After pan: chevrons return when `isPanningOrZooming` flips to `false`

**Expected frame time improvement**: 10-15ms → 0ms for chevron cost during pan

---

### Step 2: Post-Pan Debounce (Single Redraw)

**Goal**: Prevent blown frame immediately after pan by delaying heavy decoration restoration

**Problem to solve**:
- `onMoveEnd` sets `isPanningOrZooming = false`
- Immediately triggers:
  - 100+ bead portals mounting
  - Chevron bundle recompute + clipPath rendering
- All in one frame → blown budget

**Solution**: Add debounce delay between pan end and decoration restoration

#### File: `graph-editor/src/components/GraphCanvas.tsx`

**2.1** - Add debounce timer state:

```typescript
const [isPanningOrZooming, setIsPanningOrZooming] = useState(false);
const panTimeoutRef = useRef<NodeJS.Timeout | null>(null);
const isPanningOrZoomingRef = useRef(false);
const hasMovedRef = useRef(false);
const moveStartViewportRef = useRef<{x,y,zoom} | null>(null);

// NEW: Debounce flag to delay decoration restoration after pan
const [decorationsEnabled, setDecorationsEnabled] = useState(true);
const decorationRestoreTimeoutRef = useRef<NodeJS.Timeout | null>(null);
```

**2.2** - Suppress decorations on pan start:

```typescript
onMoveStart={(_, viewport) => {
  // Clear any pending restoration
  if (decorationRestoreTimeoutRef.current) {
    clearTimeout(decorationRestoreTimeoutRef.current);
    decorationRestoreTimeoutRef.current = null;
  }
  
  // Suppress decorations immediately
  setDecorationsEnabled(false);
  
  // Store initial viewport to detect actual movement
  moveStartViewportRef.current = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
  hasMovedRef.current = false;
}}
```

**2.3** - Debounced restoration on pan end:

```typescript
onMoveEnd={(_, viewport) => {
  // Only process if actual movement occurred
  if (moveStartViewportRef.current) {
    const dx = Math.abs(viewport.x - moveStartViewportRef.current.x);
    const dy = Math.abs(viewport.y - moveStartViewportRef.current.y);
    const dz = Math.abs(viewport.zoom - moveStartViewportRef.current.zoom);
    
    if (dx > 1 || dy > 1 || dz > 0.01) {
      hasMovedRef.current = true;
      
      // Reset panning flag immediately (allows edges to stop updating positions)
      setIsPanningOrZooming(false);
      
      // Save viewport state (deferred)
      if (tabId) {
        startTransition(() => {
          try {
            tabOperations.updateTabState(tabId, { rfViewport: viewport });
            lastSavedViewportRef.current = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
          } catch {}
        });
      }
      
      // DEBOUNCE DECORATION RESTORATION
      // Wait 80-100ms for everything to settle before re-enabling heavy decorations
      // This allows ReactFlow, layout, and other systems to complete their work first
      decorationRestoreTimeoutRef.current = setTimeout(() => {
        console.log('[GraphCanvas] Restoring decorations after pan debounce');
        setDecorationsEnabled(true);
        decorationRestoreTimeoutRef.current = null;
      }, 80);  // Tunable: 50-150ms range
      
      // Reset movement tracking
      hasMovedRef.current = false;
      moveStartViewportRef.current = null;
    } else {
      // Just a click, not a pan - restore immediately
      setIsPanningOrZooming(false);
      setDecorationsEnabled(true);
    }
  }
}}
```

**2.4** - Use combined flag for chevrons and beads:

```typescript
// Combined suppression flag: hide decorations during pan AND during debounce window
const shouldSuppressDecorations = isPanningOrZooming || !decorationsEnabled;

// Use for chevrons
{!NO_CHEVRONS_MODE && !shouldSuppressDecorations && (
  <Panel position="top-left">
    <ChevronClipPaths bundles={edgeBundles} nodes={nodes} />
  </Panel>
)}

// Pass to edges for beads
data: {
  ...edge.data,
  isPanningOrZooming: shouldSuppressDecorations  // Renamed but same semantics
}
```

**2.5** - Cleanup on unmount:

```typescript
useEffect(() => {
  return () => {
    if (decorationRestoreTimeoutRef.current) {
      clearTimeout(decorationRestoreTimeoutRef.current);
    }
  };
}, []);
```

**Effect**:
- Pan frames: No decorations (smooth 60fps)
- Pan end: ReactFlow/layout settles
- +80ms: Single frame with chevron + bead restoration
- If that frame blows budget (>16ms), we notice it but user doesn't perceive it as "during interaction"

---

### Step 3: Audit Other Edge Portals

**Goal**: Ensure no other portals are causing similar issues

**Check these in `ConversionEdge.tsx`**:

1. **Edge tooltip** (line ~1656):
   ```typescript
   {showTooltip && ReactDOM.createPortal(...)}
   ```
   - Gate on `!isPanningOrZooming` or suppress tooltip hover during pan

2. **Context menu** (if rendered as portal):
   - Close menu on pan start

**Quick fix**: Suppress tooltip on pan start:

```typescript
onMoveStart={() => {
  // ... existing logic
  setShowTooltip(false);  // Add this if tooltip is edge-controlled
})
```

Or if tooltip is controlled per-edge, suppress in `ConversionEdge`:

```typescript
const shouldShowTooltip = showTooltip && !isInteracting;

{shouldShowTooltip && ReactDOM.createPortal(...)}
```

---

## Expected Performance

### Before Implementation

| Phase | Frame Time | Status |
|-------|------------|--------|
| During pan | 27-41ms | ❌ Dropped frames |
| Pan end frame | 100-150ms | ❌ Blown |
| User perception | Janky, sluggish | ❌ |

### After Simple Suppression + Debounce

| Phase | Frame Time | Status |
|-------|------------|--------|
| During pan | 8-14ms | ✅ Smooth 60fps |
| Pan end frame | 8-12ms | ✅ Within budget |
| Debounce delay | 80ms quiet | ⏳ |
| Restoration frame | ~50-80ms | ⚠️ Heavy but after interaction |
| User perception | Smooth pan, brief pause, decorations appear | ✅ Acceptable |

### If Restoration Frame Still Too Heavy

Only if the single restoration frame is unacceptable (e.g. >100ms perceived as freeze):

- Fall back to **incremental restoration** from `SOLUTION_IMPLEMENTATIONS.md` Section 2.4
- Restore chevrons in batches (10 bundles/frame across 10 frames)
- Keep beads suppressed until all chevrons restored
- Spreads 80ms cost across 10 frames (~8ms each)

**But**: Try simple approach first. Incremental adds significant complexity.

---

## Implementation Checklist

### Phase 1: Chevron Suppression (Required)
- [ ] Modify bundle generation to skip when `isPanningOrZooming`
- [ ] Modify `ChevronClipPaths` rendering to gate on `!isPanningOrZooming`
- [ ] Test: Pan should be smooth, chevrons disappear during pan
- [ ] Verify: No console errors, edges render correctly (plain strokes during pan)

### Phase 2: Post-Pan Debounce (Required)
- [ ] Add `decorationsEnabled` state to `GraphCanvas`
- [ ] Add `decorationRestoreTimeoutRef` for timeout management
- [ ] Modify `onMoveStart` to clear timeout and set `decorationsEnabled = false`
- [ ] Modify `onMoveEnd` to debounce setting `decorationsEnabled = true`
- [ ] Create `shouldSuppressDecorations` combined flag
- [ ] Update chevron rendering gate to use `shouldSuppressDecorations`
- [ ] Update edge data to pass `shouldSuppressDecorations` instead of `isPanningOrZooming`
- [ ] Test: After pan, brief pause, then decorations appear in one frame
- [ ] Profile: Measure restoration frame time

### Phase 3: Audit Other Portals (Optional but Recommended)
- [ ] Find all edge-related portals (tooltip, context menu, etc.)
- [ ] Suppress or close during pan
- [ ] Test: No unexpected portal reconciliation during pan

### Phase 4: Tuning (If Needed)
- [ ] If restoration frame >100ms: Reduce debounce delay to minimize pause
- [ ] If restoration frame >150ms: Consider incremental restoration fallback
- [ ] If pan still janky: Check for missed portals or other GPU work
- [ ] Document chosen debounce value (50-150ms range)

---

## Code Changes Summary

### Files to Modify

1. **graph-editor/src/components/GraphCanvas.tsx**
   - Add `decorationsEnabled` state
   - Modify `onMoveStart` / `onMoveEnd` handlers
   - Update bundle generation condition
   - Update `ChevronClipPaths` rendering condition
   - Create `shouldSuppressDecorations` derived value
   - Pass to edge data

2. **graph-editor/src/components/edges/ConversionEdge.tsx**
   - Already reads `data?.isPanningOrZooming` (no change needed)
   - Optionally suppress tooltip during pan

3. **graph-editor/src/components/edges/EdgeBeads.tsx**
   - Already has early return (no change needed)

**Total**: ~50 lines changed across 2-3 files

---

## Detailed Implementation

### 1. Add Decoration State

```typescript
// In GraphCanvas, near other pan/zoom state declarations:
const [isPanningOrZooming, setIsPanningOrZooming] = useState(false);
const panTimeoutRef = useRef<NodeJS.Timeout | null>(null);
const isPanningOrZoomingRef = useRef(false);
const hasMovedRef = useRef(false);
const moveStartViewportRef = useRef<{x,y,zoom} | null>(null);
const lastSavedViewportRef = useRef<{x,y,zoom} | null>(null);

// NEW: Decoration restoration control
const [decorationsEnabled, setDecorationsEnabled] = useState(true);
const decorationRestoreTimeoutRef = useRef<NodeJS.Timeout | null>(null);

// Combined suppression flag
const shouldSuppressDecorations = isPanningOrZooming || !decorationsEnabled;
```

### 2. Update Pan Handlers

```typescript
onMoveStart={(_, viewport) => {
  // Cancel any pending decoration restoration
  if (decorationRestoreTimeoutRef.current) {
    clearTimeout(decorationRestoreTimeoutRef.current);
    decorationRestoreTimeoutRef.current = null;
  }
  
  // Suppress decorations immediately (chevrons + beads)
  setDecorationsEnabled(false);
  
  // Store initial viewport to detect actual movement
  moveStartViewportRef.current = {
    x: viewport.x,
    y: viewport.y,
    zoom: viewport.zoom
  };
  hasMovedRef.current = false;
}}

onMove={(_, viewport) => {
  // Only set panning state if viewport actually changed
  if (moveStartViewportRef.current) {
    const dx = Math.abs(viewport.x - moveStartViewportRef.current.x);
    const dy = Math.abs(viewport.y - moveStartViewportRef.current.y);
    const dz = Math.abs(viewport.zoom - moveStartViewportRef.current.zoom);
    
    // Threshold check prevents clicks from triggering suppression
    if ((dx > 1 || dy > 1 || dz > 0.01) && !hasMovedRef.current) {
      hasMovedRef.current = true;
      
      // Clear any pending timeout
      if (panTimeoutRef.current) {
        clearTimeout(panTimeoutRef.current);
        panTimeoutRef.current = null;
      }
      
      setIsPanningOrZooming(true);
    }
  }
}}

onMoveEnd={(_, viewport) => {
  // Only update state if we were actually panning/zooming
  if (hasMovedRef.current) {
    // Save viewport (deferred, low priority)
    if (tabId) {
      startTransition(() => {
        try {
          tabOperations.updateTabState(tabId, { rfViewport: viewport });
          lastSavedViewportRef.current = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
        } catch {}
      });
    }
    
    // Clear pan timeout
    if (panTimeoutRef.current) {
      clearTimeout(panTimeoutRef.current);
      panTimeoutRef.current = null;
    }
    
    // Reset panning flag immediately (allows edges to settle)
    setIsPanningOrZooming(false);
    
    // DEBOUNCED DECORATION RESTORATION
    // Wait for ReactFlow, layout, and other systems to settle before re-enabling decorations
    // This prevents a blown frame immediately after pan
    decorationRestoreTimeoutRef.current = setTimeout(() => {
      console.log('[GraphCanvas] Restoring decorations after pan (debounced)');
      setDecorationsEnabled(true);
      decorationRestoreTimeoutRef.current = null;
    }, 80);  // Tunable: 50-150ms range
    
    // Reset movement tracking
    hasMovedRef.current = false;
    moveStartViewportRef.current = null;
  } else {
    // Just a click, not a pan - no suppression needed
    setIsPanningOrZooming(false);
    setDecorationsEnabled(true);  // Ensure decorations stay enabled
  }
}}
```

### 3. Update Bundle Generation

```typescript
// Generate edge bundles for chevron clipping
// Suppress in: Sankey view, nochevrons mode, OR during pan/debounce
const bundles = (useSankeyView || NO_CHEVRONS_MODE || shouldSuppressDecorations) 
  ? [] 
  : groupEdgesIntoBundles(edgesWithOffsetData, nodesWithSelection);
```

### 4. Update Chevron Rendering

```typescript
{/* Chevron clipPath definitions */}
{/* DIAGNOSTIC: Skip chevrons if ?nochevrons param set */}
{/* PERF: Suppress during pan AND during post-pan debounce */}
{!NO_CHEVRONS_MODE && !shouldSuppressDecorations && (
  <Panel position="top-left" style={{ pointerEvents: 'none' }}>
    <ChevronClipPaths bundles={edgeBundles} nodes={nodes} frameId={renderFrameRef.current} />
  </Panel>
)}
```

### 5. Update Edge Data

```typescript
// Pass combined suppression flag to edges (for beads)
const edgesWithOffsetData = edgesWithOffsets.map(edge => ({
  ...edge,
  data: {
    ...edge.data,
    sourceOffsetX: edge.sourceOffsetX,
    // ... other data ...
    isPanningOrZooming: shouldSuppressDecorations  // Combined flag
  }
}));
```

### 6. Cleanup Effect

```typescript
// Cleanup: cancel restoration timeout on unmount
useEffect(() => {
  return () => {
    if (decorationRestoreTimeoutRef.current) {
      clearTimeout(decorationRestoreTimeoutRef.current);
    }
  };
}, []);
```

---

## Behavior Timeline

### User Interaction: Pan Graph for 2 seconds, then stop

| Time | Event | `isPanningOrZooming` | `decorationsEnabled` | Chevrons | Beads | Frame Time |
|------|-------|---------------------|---------------------|----------|-------|------------|
| 0ms | Pan start | true | false | Hidden | Hidden | 11ms |
| +16ms | Pan frame 1 | true | false | Hidden | Hidden | 10ms |
| +33ms | Pan frame 2 | true | false | Hidden | Hidden | 12ms |
| ... | Pan continues | true | false | Hidden | Hidden | 10-14ms |
| 2000ms | Pan end | **false** | **false** | Hidden | Hidden | 9ms |
| +80ms | Debounce elapsed | false | **true** | **Visible** | **Visible** | ~60ms ⚠️ |
| +96ms | Next frame | false | true | Visible | Visible | 12ms |

**Key points**:
- Pan frames: 10-14ms (smooth)
- Pan end frame: 9ms (smooth)
- Restoration frame: ~60ms (heavy but acceptable, happens after interaction)
- If restoration frame >100ms: Consider incremental approach

---

## Tuning Parameters

### Debounce Delay

```typescript
const DECORATION_RESTORE_DELAY = 80; // milliseconds
```

**Trade-offs**:
- **Shorter** (50ms): Less pause, but risk of collision with ReactFlow settling
- **Longer** (150ms): More pause, but safer / cleaner restoration
- **Recommended**: 80ms balances speed and safety

### Movement Threshold

```typescript
const MOVEMENT_THRESHOLD_PX = 1;      // pixels
const MOVEMENT_THRESHOLD_ZOOM = 0.01; // zoom delta
```

**Trade-offs**:
- **Lower**: More sensitive, clicks might trigger suppression
- **Higher**: Less sensitive, small pans might not suppress
- **Current**: 1px / 0.01 zoom works well in practice

---

## Fallback: Incremental Restoration

**Only if**: Simple debounced restoration still causes unacceptable jank (restoration frame >100ms)

### Mechanism

Instead of restoring all decorations at once, restore in batches:

```typescript
const [activeBundleCount, setActiveBundleCount] = useState<number>(Infinity);
const restorationRafRef = useRef<number | null>(null);

// On restoration timer:
const restoreIncrementally = () => {
  const totalBundles = edgeBundles.length;
  const BATCH_SIZE = 10;
  let currentCount = 0;
  
  const restoreNextBatch = () => {
    currentCount = Math.min(currentCount + BATCH_SIZE, totalBundles);
    setActiveBundleCount(currentCount);
    
    if (currentCount < totalBundles) {
      restorationRafRef.current = requestAnimationFrame(restoreNextBatch);
    } else {
      setActiveBundleCount(Infinity);
      setDecorationsEnabled(true);  // Beads restore after chevrons
      restorationRafRef.current = null;
    }
  };
  
  restorationRafRef.current = requestAnimationFrame(restoreNextBatch);
};

// Render with sliced bundles
<ChevronClipPaths
  bundles={
    shouldSuppressDecorations 
      ? [] 
      : activeBundleCount === Infinity 
        ? edgeBundles 
        : edgeBundles.slice(0, activeBundleCount)
  }
  nodes={nodes}
/>
```

**Only add this if profiling shows restoration frame >100ms.**

---

## Testing Plan

### 1. Test Suppression

**Action**: Pan graph for 2 seconds

**Expected**:
- Chevrons disappear during pan
- Beads disappear during pan
- Edges render as plain strokes
- Pan feels smooth (60fps)

**Verify**:
- DevTools Performance: Pan frames 8-14ms
- No purple (rendering) spikes during pan
- Console: No errors

### 2. Test Restoration

**Action**: Pan, then stop and wait

**Expected**:
- Pan end: edges still plain (no decorations yet)
- +80ms: Chevrons and beads appear together
- Decorations render correctly (no visual bugs)

**Verify**:
- DevTools Performance: Restoration frame time
- If >100ms: Consider incremental fallback
- If <80ms: Can reduce debounce delay
- Console: "Restoring decorations after pan" log

### 3. Test Click (No Pan)

**Action**: Single click on canvas

**Expected**:
- Decorations never disappear
- No suppression triggered
- No debounce delay

**Verify**:
- Movement threshold working (click doesn't exceed 1px)
- `hasMovedRef` stays false
- Immediate decoration restoration path taken

### 4. Test Rapid Pan/Stop Cycles

**Action**: Pan → stop → pan → stop (quickly)

**Expected**:
- Each pan suppresses decorations
- Pending restoration cancelled if new pan starts
- No stacked timeouts
- Eventually decorations restore when user stops

**Verify**:
- Console: Restoration logs only when actually restored
- No timeout leaks
- No visual glitches

### 5. Test Diagnostic Flags

**Actions**:
- Load with `?nobeads`
- Load with `?nochevrons`
- Load with `?nobeads&nochevrons`
- Load with `?minimal`

**Expected**:
- Each flag works independently
- Combined flags work together
- Minimal mode shows graph only

---

## Success Criteria

### Required (Must Pass)
- ✅ Pan frames consistently <16ms (60fps)
- ✅ Pan feels smooth to user
- ✅ Decorations correctly suppressed during pan
- ✅ Decorations correctly restored after pan
- ✅ No visual artifacts or half-drawn states
- ✅ No console errors

### Stretch Goals
- ✅ Restoration frame <80ms (acceptable single heavy frame)
- ✅ Debounce delay <100ms (minimal pause perception)
- ✅ Diagnostic flags all working

### Escalation Triggers
- ❌ Restoration frame >100ms → Implement incremental batching
- ❌ Pan frames >20ms → Investigate other bottlenecks
- ❌ Half-drawn states persist → Check for portal leaks or context churn

---

## Risks & Mitigations

### Risk 1: Decorations Never Restore

**Scenario**: Bug in restoration logic, decorations stay hidden forever

**Mitigation**:
- Add console logging for restoration
- Visual indicator during suppression (optional debug overlay)
- Manual escape hatch (re-clicking canvas forces restore)

### Risk 2: Debounce Delay Too Long

**Scenario**: 80ms pause feels sluggish to users

**Mitigation**:
- Start with 50ms, tune up if restoration frame too heavy
- Profile restoration frame time to find sweet spot
- Consider adaptive delay based on bundle count

### Risk 3: Restoration Frame Still Blows Budget

**Scenario**: Even with debounce, single restoration frame >100ms

**Mitigation**:
- Fall back to incremental restoration (Section 2.4 from SOLUTION_IMPLEMENTATIONS.md)
- Restore 10 bundles per frame across 10 frames
- Accept progressive pop-in as trade-off for smooth frames

### Risk 4: Other Portals Still Reconciling

**Scenario**: We suppressed beads, but forgot about tooltips/menus/other portals

**Mitigation**:
- Audit all `ReactDOM.createPortal` calls in edge components
- Suppress or close all edge-related portals during pan
- Profile to confirm no remaining portal overhead

---

## Alternative: "Double Buffering" Interpretation

Your request: "double buffer these updates and render a single correct view"

**Interpretation**: Compute new chevrons while hidden, then apply atomically

**Why current approach achieves this**:

1. **During pan**: Decorations suppressed, bundles empty
2. **Pan ends**: `decorationsEnabled` still `false`, but `isPanningOrZooming` flips to `false`
3. **Debounce window** (80ms): ReactFlow settles, edges finalize positions, layout completes
4. **Restoration**: `decorationsEnabled` flips to `true`
   - `groupEdgesIntoBundles` computes fresh bundles from settled state
   - `ChevronClipPaths` renders all clipPath defs at once
   - Browser applies clips to edges
   - Beads mount and render
5. **Result**: Single "correct view" incorporating all settled changes

This is effectively double buffering:
- **Buffer A (active during pan)**: No decorations, plain edges
- **Buffer B (computed during debounce)**: Fresh bundles from settled state
- **Flip**: When `decorationsEnabled` → `true`, switch to Buffer B

The "buffering" happens via React state, not manual frame buffers, but the effect is the same: **one atomic transition to the correct final state**.

---

## Next Steps

1. **Implement Steps 1-2** from checklist (chevron suppression + debounce)
2. **Profile** restoration frame time
3. **Tune** debounce delay if needed
4. **Only if** restoration frame >100ms: Implement incremental batching

**Estimated implementation time**: 30 minutes  
**Estimated testing time**: 15 minutes  
**Total**: ~1 hour for simple approach

---

## Conclusion

The revised plan is:

1. ✅ **Beads**: Already suppressed during pan (keep as-is)
2. 🔨 **Chevrons**: Add suppression during pan (new)
3. 🔨 **Post-pan**: Add 80ms debounce before restoration (new)

**If this works**: We're done. ~50 lines of code, no complex batching.  
**If restoration frame still blows**: Fall back to incremental restoration.

**Philosophy**: Start simple, add complexity only if proven necessary.

