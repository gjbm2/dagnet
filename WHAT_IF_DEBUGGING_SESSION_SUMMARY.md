# What-If Debugging Session - Complete Summary

**Date**: November 1, 2025
**Session Duration**: Several hours
**Primary Issue**: What-If dropdown flickering/lag, then container resize observer broken during reconstruction

---

## CRITICAL: What This Document Is For

After this debugging session:
1. Current state has BROKEN container resize observer (sidebar resizes when container resizes - WRONG)
2. Current state has WORKING What-If fixes and other improvements
3. Previous state (accessible via Cursor revert) has WORKING container resize observer
4. Previous state lacks the What-If fixes

**Goal**: Merge the working container resize observer from the old state with the What-If fixes from current state.

---

## Part 1: Original Problem - What-If Dropdown Flickering/Lag

### Initial Symptoms (Start of Debugging)
- What-If dropdown showed 2-3 second delay when toggling case variants
- Sometimes updates would render, sometimes they wouldn't (race condition behavior)
- Dropdown would flicker and go into "flickery state" - hard to use for several seconds
- Main browser thread blocked during interaction
- User emphasized: "THIS ISN'T COMPUTE THIS IS A RACE CONDITION"
- User noted: Same graph was instant and reliable on previous deployment (before sidebar changes)

### Root Cause Analysis
The issue was NOT computational cost (graph was small). The problem was:
1. **Nested rc-dock instances**: Inner dock in GraphEditor + outer dock in AppShell
2. **Multiple state update cascades**: What-If change → TabContext update → IndexedDB write → Layout reload → Component remount
3. **Layout suspension not working**: Various effects and observers were firing during dropdown interaction despite attempts to suspend them
4. **Native HTML `<select>` element**: The dropdown was a native HTML element, so the blocking was happening outside React's render cycle
5. **Something racing/looping alongside**: User repeatedly emphasized the issue was something ELSE running alongside the What-If component

### Key Diagnostic Findings
- Canvas update itself was fast (~98ms according to logs)
- The perceived 2-3s delay was from subsequent renders and layout operations
- No React logging appeared during the problematic interactions initially (caching issue - required hard refresh)
- `isTransitioning` state was getting stuck at `true`, blocking hover panels
- The `SUPPRESS_LAYOUT_HANDLERS` flag was enabled during debugging, blocking critical layout restoration logic

---

## Part 2: What-If Fixes Applied (KEEP THESE)

### Fix 1: WhatIfContext for Local State
**File**: `/home/reg/dev/dagnet/graph-editor/src/contexts/WhatIfContext.tsx` (NEW FILE)

Created a new React context to manage What-If state locally within GraphEditor, bypassing slower TabContext → IndexedDB persistence for immediate UI updates.

```typescript
import React, { createContext, useContext, useState, useCallback } from 'react';

interface WhatIfContextType {
  whatIfAnalysis: any;
  caseOverrides: Record<string, string> | undefined;
  conditionalOverrides: Record<string, Set<string>> | undefined;
  setWhatIfAnalysis: (analysis: any) => void;
  setCaseOverride: (nodeId: string, variantName: string | null) => void;
  setConditionalOverride: (edgeId: string, value: Set<string> | null) => void;
  clearAllOverrides: () => void;
}

const WhatIfContext = createContext<WhatIfContextType | undefined>(undefined);

export function useWhatIfContext() {
  const context = useContext(WhatIfContext);
  return context;
}

interface WhatIfProviderProps {
  children: React.ReactNode;
  value: WhatIfContextType;
}

export function WhatIfProvider({ children, value }: WhatIfProviderProps) {
  return (
    <WhatIfContext.Provider value={value}>
      {children}
    </WhatIfContext.Provider>
  );
}
```

**Changes in GraphEditor.tsx**:
- Added local What-If state: `whatIfLocal` with setters
- Wrapped entire `GraphEditorInner` with `WhatIfProvider`
- Created `CanvasHost` component to consume What-If from context
- Made persistence asynchronous (though `PERSIST_WHATIF` set to false as it's ephemeral)

### Fix 2: Layout Suspension During Dropdown Interaction
**File**: `/home/reg/dev/dagnet/graph-editor/src/components/editors/GraphEditor.tsx`

Added mechanism to temporarily suspend layout changes during user interactions:

```typescript
const suspendLayoutUntilRef = useRef<number>(0);
const [isHoverLocked, setIsHoverLocked] = useState(false);

// Listen for temporary layout suspension requests
useEffect(() => {
  const handler = (e: any) => {
    const ms = e?.detail?.ms ?? 600;
    suspendLayoutUntilRef.current = Date.now() + ms;
    setIsHoverLocked(true);
    setTimeout(() => {
      setIsHoverLocked(false);
    }, ms);
  };
  window.addEventListener('dagnet:suspendLayout' as any, handler);
  return () => window.removeEventListener('dagnet:suspendLayout' as any, handler);
}, []);
```

Guards added to multiple effects:
- `onLayoutChange` handler: `if (Date.now() < suspendLayoutUntilRef.current) return;`
- File→Store sync effect (#12)
- Store→File sync effect (#13)
- Mode change effect (#10)
- Active panel change effect (#11)

**WhatIfAnalysisControl.tsx changes**:
```typescript
// Added to dropdown onMouseDown and onFocus:
onMouseDown={() => {
  window.dispatchEvent(new CustomEvent('dagnet:suspendLayout', { 
    detail: { ms: 3000 } 
  }));
}}
```

### Fix 3: What-If Visual Update Guard
**File**: `/home/reg/dev/dagnet/graph-editor/src/components/GraphCanvas.tsx`

Added `visualWhatIfUpdateRef` to prevent ReactFlow→Store sync during What-If edge updates:

```typescript
const visualWhatIfUpdateRef = useRef(false);

// In What-If recompute effect:
visualWhatIfUpdateRef.current = true;
setEdges(newEdges);
requestAnimationFrame(() => {
  visualWhatIfUpdateRef.current = false;
});

// In ReactFlow→Store sync effect:
if (visualWhatIfUpdateRef.current) {
  console.log('[GraphCanvas] skip store sync (what-if visual update)');
  return;
}
```

### Fix 4: Hover Panel Positioning Fix
**File**: `/home/reg/dev/dagnet/graph-editor/src/components/editors/GraphEditor.tsx`

Fixed hover panel rendering with proper CSS positioning:

```typescript
{sidebarState.mode === 'minimized' && hoveredPanel && (
  <div
    style={{
      position: 'absolute',
      top: 0,
      right: '48px',
      bottom: 0,
      width: '350px',
      zIndex: 99,
      pointerEvents: 'auto'
    }}
    onMouseEnter={() => setHoveredPanel(hoveredPanel)}
    onMouseLeave={() => {
      if (!isHoverLocked) setHoveredPanel(null);
    }}
  >
    <SidebarHoverPreview
      panel={hoveredPanel}
      tabId={tabId}
      selectedNodeId={selectedNodeId}
      selectedEdgeId={selectedEdgeId}
      onSelectedNodeChange={handleNodeSelection}
      onSelectedEdgeChange={handleEdgeSelection}
    />
  </div>
)}
```

### Fix 5: isTransitioning State Management
**File**: `/home/reg/dev/dagnet/graph-editor/src/hooks/useSidebarState.ts`

Fixed `isTransitioning` getting stuck at `true`:

```typescript
// In persist effect - filter out isTransitioning:
const stateToSave = {
  ...localState,
  isTransitioning: false // Always force to false when saving
};

// In initial state - force to false:
const [localState, setLocalState] = useState<SidebarState>(() => {
  const stored = memoizedStoredState;
  return stored ? { ...stored, isTransitioning: false } : DEFAULT_SIDEBAR_STATE;
});

// In sync effect - force to false:
setLocalState(prev => ({
  ...memoizedStoredState,
  isTransitioning: false
}));

// One-time cleanup on mount:
const hasRunCleanupRef = useRef(false);
useEffect(() => {
  if (!hasRunCleanupRef.current && localState.isTransitioning) {
    hasRunCleanupRef.current = true;
    updateState({ isTransitioning: false });
  }
}, []);
```

### Fix 6: Re-enabled Layout Change Handler
**File**: `/home/reg/dev/dagnet/graph-editor/src/components/editors/GraphEditor.tsx`

Changed `SUPPRESS_LAYOUT_HANDLERS` from `true` to `false`:

```typescript
const SUPPRESS_LAYOUT_HANDLERS = false; // Re-enabled: needed for restore-closed-tabs logic
```

This was critical because it restores closed sidebar panels to their dock position automatically.

### Fix 7: Performance Markers
**File**: `/home/reg/dev/dagnet/graph-editor/src/components/WhatIfAnalysisControl.tsx`

Added performance API markers for detailed timing:

```typescript
performance.mark('⚡ setCaseOverride-start');
// ... setCaseOverride logic ...
performance.mark('⚡ setCaseOverride-end');
performance.measure('⚡ setCaseOverride', '⚡ setCaseOverride-start', '⚡ setCaseOverride-end');
```

---

## Part 3: Diagnostic Logging Added (REMOVE OR MAKE CONDITIONAL)

### Extensive Console Logging
Added timestamped logging to ALL useEffect hooks and event handlers:

```typescript
const ts = () => new Date().toISOString();
console.log(`[${ts()}] [ComponentName] Description`, data);
```

**Files with extensive logging**:
- `GraphEditor.tsx`: All 16 useEffect hooks numbered, onLayoutChange, handleIconHover, ResizeObserver callbacks
- `GraphCanvas.tsx`: All 5 useEffect hooks, onNodesChange, onEdgesChange, array reference tracking
- `WhatIfAnalysisControl.tsx`: Render logs, setCaseOverride, dropdown handlers
- `useSidebarState.ts`: Persist effect, minimize/maximize functions
- `AppShell.tsx`: handleLayoutChange
- `PropertiesPanel.tsx`: All 5 useEffect hooks
- `EnhancedSelector.tsx`: Render and all 4 useEffect hooks
- `SidebarIconBar.tsx`: handleMouseEnter, handleMouseLeave

### Performance Timing
Added `performance.now()` measurements:

```typescript
const t0 = performance.now();
// ... operation ...
const t1 = performance.now();
console.log(`Operation took ${(t1-t0).toFixed(2)}ms`);
```

### Array Reference Tracking
In GraphCanvas.tsx:

```typescript
const nodesRefCountRef = useRef(0);
const edgesRefCountRef = useRef(0);
const graphRefCountRef = useRef(0);

useEffect(() => {
  nodesRefCountRef.current++;
  console.log(`[GraphCanvas] nodes array ref changed (count=${nodesRefCountRef.current})`);
}, [nodes]);
```

---

## Part 4: Diagnostic Files Created (CAN DELETE)

### 1. ALL_EFFECTS_AND_OBSERVERS.md
Complete categorization of all 133 `useEffect` hooks across 39 files, categorized by likelihood of being triggered by dropdown interaction.

### 2. BACKGROUND_PROCESSES_AND_LONG_TASKS.md
Analysis of all potential long-running background tasks that could cause DOM slowdown.

### 3. tmp.log
Console log output captured during debugging (688 lines).

---

## Part 5: THE BROKEN PART - Container Resize Observer

### What's Broken
When you resize the browser window/tab, the sidebar resizes proportionally instead of maintaining its fixed pixel width.

### What Should Happen
1. Sidebar opens with default 300px width
2. `createLayoutStructure()` back-calculates flex weights to achieve this width
3. Actual rendered width is captured and stored in `sidebarState.sidebarWidth`
4. User can drag sidebar handle to change width
5. When container resizes, container observer recalculates flex weights to maintain the stored width
6. Sidebar stays at fixed pixel width, canvas absorbs all size changes

### Current (Broken) Implementation
**Location**: GraphEditor.tsx, lines ~316-403

Key issues with current code:
- Uses `sidebarState.sidebarWidth` directly (might be causing dependency issues)
- May not be properly preventing sidebar observer from firing
- Timing of `isAdjustingLayoutRef` flag may be wrong

### What We Know About the Working Version
From conversation context before debugging started:

1. **Error 76**: Default sidebar width not correctly set
   - **Fix**: Added `useEffect` to capture actual rendered sidebar width after layout created
   
2. **Error 77**: Container ResizeObserver causing infinite loop
   - **Fix**: Added `isAdjustingLayoutRef` flag and width change threshold (>10px)
   - **Fix**: REMOVED `sidebarState.sidebarWidth` from dependencies (this was key!)
   - Dependencies after fix: `[sidebarState.mode, fileId]` (NOT sidebarOps, NOT sidebarState.sidebarWidth)

3. **Error 79**: Sidebar continually resizing itself
   - **Fix**: Disabled `containerResizeObserverRef` temporarily during What-If debugging
   - This means it WAS working between Error 77 and 79

### Critical Code Sections to Compare

#### createLayoutStructure (This logic is CORRECT)
Location: GraphEditor.tsx, lines ~557-619

```typescript
const createLayoutStructure = useCallback((mode: 'minimized' | 'maximized') => {
  const layout = mode === 'maximized' 
    ? getGraphEditorLayout() 
    : getGraphEditorLayoutMinimized();
  
  // Back-calculate flex weights based on desired pixel widths
  if (containerRef.current && mode === 'maximized') {
    const containerWidth = containerRef.current.getBoundingClientRect().width;
    const desiredSidebarWidth = sidebarState.sidebarWidth ?? 300;
    
    // Calculate flex weights to achieve absolute pixel widths
    const canvasWidth = containerWidth - desiredSidebarWidth;
    
    // Apply calculated weights
    if (layout.dockbox.children?.[0]) {
      layout.dockbox.children[0].size = canvasWidth;
    }
    if (layout.dockbox.children?.[1]) {
      layout.dockbox.children[1].size = desiredSidebarWidth;
    }
  }
  
  // ... inject components ...
  
  return layout;
}, [sidebarState.activePanel, sidebarState.sidebarWidth, fileId, ...components]);
```

This function correctly back-calculates flex weights. The container observer should use THE SAME LOGIC.

#### Initial Width Capture (This logic is CORRECT)
Location: GraphEditor.tsx, lines ~625-641

```typescript
useEffect(() => {
  if (dockLayout) return;
  
  const layout = createLayoutStructure(sidebarState.mode);
  setDockLayout(layout);
  
  // Capture actual rendered sidebar width after layout is created
  if (sidebarState.mode === 'maximized') {
    setTimeout(() => {
      if (containerRef.current) {
        const sidebarEl = containerRef.current.querySelector(/* ... */)?.closest('.dock-panel');
        if (sidebarEl) {
          const actualWidth = sidebarEl.getBoundingClientRect().width;
          sidebarOps.setSidebarWidth(actualWidth);
        }
      }
    }, 150);
  }
}, [dockLayout, sidebarState.mode, createLayoutStructure, fileId, sidebarOps]);
```

This correctly captures the initial rendered width.

---

## Part 6: Merge Strategy

### Step 1: Commit Current State
```bash
git add -A
git commit -m "WIP: What-If debugging - sidebar resize broken, extensive logging

- Fixed What-If dropdown lag with WhatIfContext
- Added layout suspension mechanism
- Fixed hover panel positioning
- Fixed isTransitioning stuck state
- Re-enabled layout handlers
- Added extensive diagnostic logging (needs cleanup)
- BROKEN: Container resize observer not maintaining sidebar width"
```

### Step 2: Revert to Working State
Use Cursor's revert feature to go back to when container resize was working (before What-If debugging).

### Step 3: Create Comparison Branch
```bash
git checkout -b working-sidebar-resize
# Now in working state
git diff working-sidebar-resize <wip-commit-hash> > what-if-fixes.diff
```

### Step 4: Extract Container Resize Observer from Working State
Read the container resize observer code from `working-sidebar-resize` branch:

```bash
git show working-sidebar-resize:graph-editor/src/components/editors/GraphEditor.tsx | grep -A 100 "Container resize observer"
```

### Step 5: Merge Systematically

1. **Keep from working state**:
   - Container resize observer implementation (lines ~316-403 in old)
   - Its dependencies array
   - The `isAdjustingLayoutRef` flag usage

2. **Keep from WIP state**:
   - WhatIfContext and all What-If fixes
   - Layout suspension mechanism
   - Hover panel fixes
   - isTransitioning fixes
   - Re-enabled `SUPPRESS_LAYOUT_HANDLERS`

3. **Clean up**:
   - Remove or make conditional all timestamped logging
   - Remove performance.now() measurements
   - Remove array reference tracking
   - Remove diagnostic files (or move to docs)

### Step 6: Test Plan
1. Open graph editor
2. Verify sidebar opens at ~300px width
3. Drag sidebar handle - verify it moves
4. Resize browser window - verify sidebar DOES NOT change width (only canvas changes)
5. Test What-If dropdown - verify no lag/flicker
6. Test hover panels - verify they appear and lock correctly
7. Close sidebar panels - verify they restore to dock
8. Float panels - verify they work

---

## Part 7: Key Code Patterns to Preserve

### Pattern 1: Back-calculating Flex Weights
```typescript
// Given: desired pixel width, container pixel width
// Calculate: flex weights that achieve the pixel width

const containerWidth = container.getBoundingClientRect().width;
const desiredSidebarWidth = sidebarState.sidebarWidth ?? 300;
const canvasFlexWeight = containerWidth - desiredSidebarWidth;
const sidebarFlexWeight = desiredSidebarWidth;

// Apply to layout:
mainBox.children[0].size = canvasFlexWeight;
mainBox.children[1].size = sidebarFlexWeight;
dockRef.current.loadLayout(currentLayout);
```

This pattern is used in:
- `createLayoutStructure()` - CORRECT
- Container resize observer - NEEDS TO MATCH THIS EXACTLY

### Pattern 2: Loop Prevention
```typescript
const isAdjustingLayoutRef = useRef<boolean>(false);

// Before making changes:
if (isAdjustingLayoutRef.current) return;
isAdjustingLayoutRef.current = true;

// After changes:
setTimeout(() => {
  isAdjustingLayoutRef.current = false;
}, 100); // or 200ms
```

Both observers (container and sidebar) check this flag to avoid circular loops.

### Pattern 3: Width Change Threshold
```typescript
const widthDelta = Math.abs(newWidth - lastWidthRef.current);
if (widthDelta < 10) return; // Only react to significant changes
```

Prevents noise and micro-adjustments from triggering layout changes.

---

## Part 8: Critical Dependencies

### Container Resize Observer Dependencies (from Error 77 fix)
```typescript
}, [sidebarState.mode, fileId]); // NO sidebarOps, NO sidebarState.sidebarWidth
```

Removing these prevented infinite loop. The observer reads `sidebarState.sidebarWidth` INSIDE the callback but doesn't depend on it, preventing re-creation of the observer when width changes.

### Sidebar Resize Observer Dependencies
```typescript
}, [sidebarState.mode, sidebarOps, fileId]);
```

This one DOES include `sidebarOps` because it needs to call `setSidebarWidth()`.

---

## Part 9: References & Context

### User's Key Statements
- "THIS ISN'T COMPUTE THIS IS A RACE CONDITION"
- "It's NOTHING TO DO WITH THE WHAT IF COMPONENT it's SOMETHING TO DO WITH WHAT HAS CHANGED SINCE WE IMPLEENTED SIDEBAR"
- "Same graph was instant and reliable on previous deployment"
- "It's something ELSE that is racing or looping alongside"
- "You have LOST THE CODE. PLEASE PLEASE PLEASE fully reconstruct it from this thread history"
- "We have to work around the fact that rc containers use FLEX not absolute size, so we need to figure out how large to make the sidebar relative to the width of the actual graph tab"

### Technical Insights
- rc-dock uses flex sizing, not absolute pixels
- We have nested rc-dock instances (AppShell + GraphEditor)
- The native HTML `<select>` element means blocking happens outside React
- Browser caching and Vite HMR can hide diagnostic logs (requires hard refresh)
- The `isTransitioning` flag persisting to IndexedDB caused hidden bugs

---

## Part 10: Files Modified During Session

### New Files
1. `/home/reg/dev/dagnet/graph-editor/src/contexts/WhatIfContext.tsx`
2. `/home/reg/dev/dagnet/ALL_EFFECTS_AND_OBSERVERS.md` (can delete)
3. `/home/reg/dev/dagnet/BACKGROUND_PROCESSES_AND_LONG_TASKS.md` (can delete)
4. `/home/reg/dev/dagnet/tmp.log` (can delete)
5. `/home/reg/dev/dagnet/WHAT_IF_DEBUGGING_SESSION_SUMMARY.md` (this file)

### Modified Files
1. `/home/reg/dev/dagnet/graph-editor/src/components/editors/GraphEditor.tsx` (HEAVILY MODIFIED)
2. `/home/reg/dev/dagnet/graph-editor/src/components/GraphCanvas.tsx` (logging + visual guard)
3. `/home/reg/dev/dagnet/graph-editor/src/components/WhatIfAnalysisControl.tsx` (context + suspension)
4. `/home/reg/dev/dagnet/graph-editor/src/hooks/useSidebarState.ts` (isTransitioning fix)
5. `/home/reg/dev/dagnet/graph-editor/src/components/PropertiesPanel.tsx` (logging only)
6. `/home/reg/dev/dagnet/graph-editor/src/components/EnhancedSelector.tsx` (logging only)
7. `/home/reg/dev/dagnet/graph-editor/src/components/SidebarIconBar.tsx` (logging only)
8. `/home/reg/dev/dagnet/graph-editor/src/AppShell.tsx` (logging only)

---

## Part 11: Specific Line Ranges to Compare

When doing the merge, pay special attention to these sections in `GraphEditor.tsx`:

1. **Lines 1-150**: Imports and refs
   - Check for new refs added (suspendLayoutUntilRef, isHoverLocked)
   
2. **Lines 150-250**: Event handlers
   - handleIconHover with hover lock logic
   - Event listeners for suspension and panel opening
   
3. **Lines 316-403**: Container resize observer
   - THIS IS THE BROKEN SECTION - replace with working version
   
4. **Lines 405-500**: Sidebar resize observer
   - Should be mostly unchanged, but check isAdjustingLayoutRef usage
   
5. **Lines 557-619**: createLayoutStructure
   - Should be unchanged, this is the reference implementation
   
6. **Lines 625-641**: Initial layout effect
   - Should be unchanged, captures initial width correctly
   
7. **Lines 1000-1100**: WhatIfProvider wrapper
   - Keep this, it's part of What-If fixes
   
8. **Lines 1200-1300**: Hover panel rendering
   - Keep the fixed positioning

---

## FINAL CHECKLIST FOR MERGE

- [ ] Container resize observer matches working version exactly
- [ ] Container resize observer dependencies: `[sidebarState.mode, fileId]` only
- [ ] WhatIfContext implementation preserved
- [ ] Layout suspension mechanism preserved
- [ ] Hover panel positioning preserved
- [ ] isTransitioning fixes preserved
- [ ] SUPPRESS_LAYOUT_HANDLERS set to `false`
- [ ] Excessive logging removed or made conditional
- [ ] Performance markers removed or made conditional
- [ ] Diagnostic files deleted or moved
- [ ] Test: sidebar maintains width on container resize
- [ ] Test: What-If dropdown works without lag
- [ ] Test: hover panels work correctly

---

## END OF SUMMARY

This document should contain everything needed to successfully merge the working container resize logic with the What-If fixes, even after losing the Cursor session context.

