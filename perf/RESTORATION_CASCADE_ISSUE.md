# Decoration Restoration Cascade Issue

**Date**: November 16, 2025  
**Issue**: SVG restoration frame interrupted by competing re-renders  
**Status**: Under investigation

---

## Observation

After implementing pan/zoom suppression + debounced restoration:

✅ **During pan**: Smooth 60fps (decorations suppressed)  
❌ **After pan**: Restoration frame gets "halfway through and stops"

### Symptoms

From user logs around frame #38 (restoration time):

```
GraphCanvas.tsx:4825 [GraphCanvas] Restoring decorations after pan (debounced)
AppShell.tsx:63 AppShell render - navState: {...}
EditMenu.tsx:26 EditMenu render: {...}
DataMenu.tsx:469 [DataMenu] RENDER STATE: {...}
NavigatorContent.tsx:164 🗂 NavigatorContent: Graph entry for test-project-data {...}
GraphEditor.tsx:158 [GraphEditor graph-test-project-data] RENDER: tabId=...
GraphCanvas.tsx:224 [GraphCanvas] Render frame #38 start
GraphCanvas.tsx:224 [GraphCanvas] Render frame #39 start
```

**Pattern**: Multiple unrelated components (AppShell, menus, navigator) all rendering when decorations restore.

---

## Root Cause (Per frameissues.txt Analysis)

### The "Half-Finished Frame" Misconception

It's **not** that the browser paints half a frame then stops. It's that:

1. Heavy SVG restoration work starts (chevrons + beads)
2. **Other React updates come in** (AppShell, menus, navigator)
3. React throws away in-progress render work and restarts
4. The heavy SVG frame **never completes** because it keeps being interrupted
5. User sees old/partial state frozen, not the final intended state

**Quote from frameissues.txt**:

> "What you're seeing as a 'half-finished frame' is almost certainly:
> Work that would finish the image never gets to complete / commit,
> Not 'the browser painted half a frame and then bailed mid-composition.'"

### Why Other Components Are Rendering

From frameissues.txt analysis:

1. **Shared state / context updates**: Something changing when decorations restore is causing parent contexts to update
2. **Unstable props / callbacks**: New object/function references on every render
3. **Context churn**: `value={{ ... }}` in providers creating new objects
4. **Coarse React reconciliation**: Parent re-renders force children to reconcile

**Quote**:

> "If your sidebar/menu are visibly changing or re-rendering every time the SVG work happens, yes, that usually means React is re-running those components too, often because of shared state / unstable props / context updates."

---

## Hypothesis: Competing Updates Starve SVG Restoration

### Timeline of Events

| Time | Event | Effect |
|------|-------|--------|
| 0ms | Pan end | `isPanningOrZooming` → false, `decorationsEnabled` → false |
| +80ms | Debounce expires | `setDecorationsEnabled(true)` called |
| +80ms | GraphCanvas re-renders | `shouldSuppressDecorations` → false, triggers `renderEdges` useMemo |
| +80ms | **AppShell re-renders** | Competing render starts |
| +80ms | **EditMenu re-renders** | Competing render starts |
| +80ms | **DataMenu re-renders** | Competing render starts |
| +80ms | **Navigator re-renders** | Competing render starts |
| +80-100ms | **SVG work never completes** | Constantly restarted by competing renders |

### Why This Happens

Possible causes:

1. **TabContext update**: `updateTabState` in `onMoveEnd` triggers tab state change, which causes entire app to re-render
2. **ViewPreferences or other contexts**: Some context value changes when GraphCanvas re-renders
3. **Callback/prop instability**: GraphCanvas passes new callbacks up that destabilize parent
4. **Layout recalculation triggers**: Browser layout changes trigger React effects that cause more renders

---

## Evidence Needed

To confirm this hypothesis, we need to answer:

### Q1: Are these re-renders caused by the decoration restoration?

**Test**: Add timestamp logging to every `console.log` in AppShell/menus/navigator

**Expected**: If cascade is real, all those renders will be within 0-100ms of decoration restoration

### Q2: What's triggering AppShell to re-render?

**Test**: Add logging to AppShell showing which props/contexts changed:

```typescript
// In AppShellContent
const prevPropsRef = useRef({ tabs, activeTabId, navState });
useEffect(() => {
  const changes = [];
  if (prevPropsRef.current.tabs !== tabs) changes.push('tabs');
  if (prevPropsRef.current.activeTabId !== activeTabId) changes.push('activeTabId');
  if (prevPropsRef.current.navState !== navState) changes.push('navState');
  
  if (changes.length > 0) {
    console.log('[PERF] AppShell re-render triggered by:', changes);
  }
  
  prevPropsRef.current = { tabs, activeTabId, navState };
});
```

**Expected**: Will show which context is churning

### Q3: Is the SVG work actually being interrupted?

**Test**: Use Chrome DevTools Performance profiler during restoration

**Expected**: If interrupted, we'll see:
- Multiple "Render" tasks starting and being cancelled
- No single long "Paint" task completing
- Lots of "Recalculate Style" and "Layout" interleaved

---

## Solutions (Ordered by Likelihood)

### Solution 1: Prevent TabContext Update During Restoration

**Hypothesis**: `updateTabState` in `onMoveEnd` is triggering the cascade

**Current code**:
```typescript
onMoveEnd(() => {
  // ... 
  startTransition(() => {
    tabOperations.updateTabState(tabId, { rfViewport: viewport });
  });
  
  // 80ms later: setDecorationsEnabled(true)
})
```

**Problem**: `startTransition` doesn't prevent the update, it just marks it low-priority. It could still run during restoration window.

**Fix**: Defer tab state update until AFTER decorations restore:

```typescript
onMoveEnd(() => {
  // Don't update tab state immediately
  
  // Restoration timeout:
  decorationRestoreTimeoutRef.current = setTimeout(() => {
    setDecorationsEnabled(true);
    
    // AFTER decorations restored, update tab state
    requestAnimationFrame(() => {
      startTransition(() => {
        tabOperations.updateTabState(tabId, { rfViewport: viewport });
      });
    });
  }, 80);
})
```

**Effect**: Tab state update happens AFTER SVG restoration completes, not competing with it

### Solution 2: Isolate GraphCanvas State

**Hypothesis**: GraphCanvas re-rendering causes parent re-renders through callbacks

**Check**: Are any of these passed to GraphCanvas creating new references?
- `onSelectedNodeChange`
- `onSelectedEdgeChange`
- `onDoubleClickNode`
- `onDoubleClickEdge`

**Fix**: Ensure GraphEditor wraps all callbacks in `useCallback` with stable deps

### Solution 3: Prevent Navigator/Menu Re-renders

**Hypothesis**: Navigator re-renders are independent but coincidentally timed

Looking at logs:
```
ObjectTypeSection.tsx:136 [Navigator] graph content height: 92
ObjectTypeSection.tsx:136 [Navigator] parameter content height: 269
```

These are layout measurements happening during restoration window.

**Fix**: Wrap navigator sections in `React.memo` to prevent unnecessary re-renders:

```typescript
const ObjectTypeSection = React.memo(function ObjectTypeSection(props) {
  // ...
});
```

### Solution 4: Use flushSync for Atomic Restoration

**Hypothesis**: Restoration needs to be synchronous to avoid interruption

**Fix**: Force synchronous commit of decoration restoration:

```typescript
decorationRestoreTimeoutRef.current = setTimeout(() => {
  const restoreT0 = performance.now();
  console.log('[PERF] Starting decoration restoration (flushSync)');
  
  // Force synchronous commit - no interruptions
  flushSync(() => {
    setDecorationsEnabled(true);
  });
  
  const restoreT1 = performance.now();
  console.log(`[PERF] Decoration restoration completed in ${(restoreT1 - restoreT0).toFixed(2)}ms`);
}, DECORATION_RESTORE_DELAY);
```

**Warning**: `flushSync` is a big hammer - only use if cascade is proven

---

## Recommended Investigation Steps

### Step 1: Confirm Cascade Timing

Run the app with current logging, pan, and capture timestamps:

- When does "Restoring decorations" log?
- When do AppShell/menu/navigator renders happen?
- Are they within 0-100ms of restoration?

**If yes** → Cascade is real, proceed to Step 2  
**If no** → Renders are independent, issue is elsewhere

### Step 2: Identify Cascade Trigger

Add prop/context change logging to AppShell (see Q2 above)

**Expected result**: Will show which context is causing cascade (likely TabContext or NavigatorContext)

### Step 3: Apply Targeted Fix

Based on what's changing:

- **If TabContext**: Defer `updateTabState` until after restoration (Solution 1)
- **If callbacks**: Add `useCallback` wrappers (Solution 2)
- **If navigator**: Add `React.memo` to sections (Solution 3)
- **If multiple/unclear**: Use `flushSync` (Solution 4)

### Step 4: Verify Fix

After applying fix:

- Pan and watch console
- Should see: "Restoring decorations" → NO other component renders for 100ms
- SVG work completes uninterrupted
- No "half-finished" visual state

---

## Success Criteria

After fix:

- ✅ Decoration restoration log appears
- ✅ NO AppShell/menu/navigator renders within 100ms of restoration
- ✅ SVG fully renders (no half-drawn state)
- ✅ Chrome DevTools shows single long Paint task completing
- ✅ User sees: pan → brief pause → decorations pop in cleanly

---

## Next Steps

1. **Capture logs** during pan/restore cycle with current code
2. **Analyze timestamps** to confirm cascade
3. **Implement Solution 1** (defer tab state update) as most likely fix
4. **Re-test** and profile restoration frame
5. **If still interrupted**: Apply Solutions 2-4 progressively

**Current status**: Logging added, ready for diagnostic capture.

