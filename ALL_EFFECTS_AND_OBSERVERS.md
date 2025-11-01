# Complete List of All useEffect Hooks and Observers in the Application

## Summary Statistics
- **Total useEffect hooks**: 133
- **Total files with effects**: 39
- **ResizeObservers**: 1 (in GraphEditor.tsx - DISABLED, didn't fix issue)
- **MutationObservers**: 0
- **IntersectionObservers**: 0

---

## USER ACTION: Selecting EXISTING value in What-If dropdown (no state change)
**Observable behavior**: Severe input lag, browser tab becomes unresponsive for several seconds, NO console logging

---

## 🔴 CATEGORY 1: DEFINITELY FIRING (100% certain)

These MUST be running because they're in the render path of the What-If dropdown:

### WhatIfAnalysisControl.tsx
- **Component render** (line 8) - INSTRUMENTED but NOT LOGGING
  - **Why firing**: This IS the dropdown component
  - **Expected**: Should see `[WhatIfControl] RENDER START` on every render
  - **Reality**: NOT LOGGING = React isn't re-rendering
  - **Conclusion**: Issue is NOT in React render cycle

### EnhancedSelector.tsx (4 useEffect hooks) - NOT INSTRUMENTED ⚠️
**CRITICAL SUSPECT - This is the actual dropdown implementation**
1. useEffect - Position dropdown
   - **Triggers on**: Dropdown open/close, window resize, scroll
   - **Could loop if**: Positioning calculation causes layout shift which re-triggers positioning
2. useEffect - Handle click outside
   - **Triggers on**: Document mousedown events
   - **Could loop if**: Click detection re-renders which re-attaches listener
3. useEffect - Update suggestions
   - **Triggers on**: Input value changes, data source changes
   - **Could loop if**: Suggestion filtering triggers state update which re-filters
4. useEffect - Scroll selected into view
   - **Triggers on**: Selected item changes
   - **Could loop if**: Scroll causes reflow which updates selection

---

## 🟠 CATEGORY 2: VERY LIKELY FIRING (80-90% certain)

### PropertiesPanel.tsx (5 useEffect hooks) - INSTRUMENTED but NOT LOGGING
1. useEffect#PP1 (line 78) - Load node data on selection change
   - **Dependency**: `selectedNodeId`
   - **NOT firing**: Would see timestamp if it was
2. useEffect#PP2 (line 157) - Load edge data on selection change
   - **Dependency**: `selectedEdgeId`, `graph`
   - **NOT firing**: Would see timestamp if it was
3. useEffect#PP3 (line 206) - Auto-generate slug from label
   - **Dependency**: `localNodeData.label`, `selectedNodeId`, `graph`, `slugManuallyEdited`
   - **NOT firing**: Would see timestamp if it was
4. useEffect#PP4 (line 242) - Reload edge on graph change
   - **Dependency**: `selectedEdgeId`, `graph`
   - **Could fire if**: Graph object reference changes even without data change
   - **NOT firing**: Would see timestamp if it was
5. useEffect#PP5 (line 310) - Setup keyboard shortcuts
   - **Dependency**: Empty array (mount only)
   - **NOT firing**: Mount-only effect

### GraphEditor.tsx ResizeObserver (line 361) - DISABLED for testing
- **Status**: Confirmed DISABLED, didn't fix issue
- **Conclusion**: Not the culprit

---

## 🟡 CATEGORY 3: POSSIBLY FIRING (30-50% certain)

### GraphCanvas.tsx - PARTIALLY INSTRUMENTED
1. **useEffect#GC1 (line 1582) - What-If recompute** - INSTRUMENTED
   - **Dependency**: `overridesVersion`, `whatIfAnalysis`, `edges.length`
   - **Should fire if**: What-If state changes
   - **NOT firing**: Would see timestamp if it was
   
2. **useEffect#GC2 (line 1654) - Sync ReactFlow→Store** - INSTRUMENTED
   - **Dependency**: `nodes`, `edges`
   - **Should fire if**: Nodes/edges array reference changes
   - **NOT firing**: Would see timestamp if it was

3. useEffect (line 711) - Sync ReactFlow nodes → Graph store
   - **NOT INSTRUMENTED**
   - **Dependency**: `nodes` (ReactFlow state)
   - **Could fire if**: Nodes array reference changes

4. useEffect (line 923) - Sync ReactFlow edges → Graph store
   - **NOT INSTRUMENTED**
   - **Dependency**: `edges` (ReactFlow state)
   - **Could fire if**: Edges array reference changes

5. useEffect (line 1511) - Edge scaling
   - **NOT INSTRUMENTED**
   - **Dependency**: `useUniformScaling`, `massGenerosity`, `nodes`
   - **Could fire if**: Any of these change

### useSidebarState.ts
1. **useEffect#SB1 (line 91) - Persist sidebar state** - INSTRUMENTED
   - **Dependency**: `state`, `tabId`, `tabOps`, `memoizedStoredState`
   - **NOT firing**: Would see timestamp if it was

---

## ⚪ CATEGORY 4: UNLIKELY TO FIRE (10-20% certain)

### GraphEditor.tsx (16 useEffect hooks) - ALL INSTRUMENTED
- **ALL NOT LOGGING** = None of these are firing
- useEffect#1-16: None show timestamps in console

### AppShell.tsx onLayoutChange - INSTRUMENTED
- **NOT LOGGING** = rc-dock layout not changing
- Would see `[AppShell] onLayoutChange` if firing

### TabContext.tsx
1. useEffect (line 564) - Load tabs from IndexedDB on mount
   - **Dependency**: Empty array (mount only)
   - **Will not fire**: Already mounted
   
2. useEffect (line 1294) - File state subscription
   - **Dependency**: `fileId`
   - **Could fire if**: File ID changes (shouldn't)

---

## ⬜ CATEGORY 5: IMPOSSIBLE TO FIRE (<5% certain)

These are modal dialogs, menu components, or mount-only effects that cannot possibly be active:

### Modals (NOT RENDERED)
- CommitModal.tsx (3 useEffect)
- NewFileModal.tsx (2 useEffect)
- LoadGraphModal.tsx (1 useEffect)
- DeleteModal.tsx

### Menu Bar (NOT INTERACTING)
- FileMenu.tsx (1 useEffect)
- EditMenu.tsx (1 useEffect)
- ViewMenu.tsx (1 useEffect)
- HelpMenu.tsx (1 useEffect)

### Navigator (NOT VISIBLE)
- NavigatorContent.tsx (2 useEffect)
- NavigatorHeader.tsx (1 useEffect)
- NavigatorControls.tsx (2 useEffect)
- ObjectTypeSection.tsx (1 useEffect)
- NavigatorContext.tsx (5 useEffect)

### Other Inactive
- FormEditor.tsx (5 useEffect)
- SidebarIconBar.tsx (1 useEffect)
- ConversionNode.tsx (2 useEffect)
- ConversionEdge.tsx (4 useEffect)
- ColorSelector.tsx (1 useEffect)
- CollapsibleSection.tsx (1 useEffect)
- Accordion.tsx (1 useEffect)
- RawView.tsx (3 useEffect)
- ProbabilityInput.tsx (2 useEffect)
- ContextMenu.tsx (1 useEffect)
- Tooltip.tsx (2 useEffect)
- GitOperations.tsx (2 useEffect)

---

## 💀 THE SMOKING GUN ANALYSIS

### What We Know:
1. ✅ Dropdown interaction causes 2-3s main thread block
2. ✅ NO React useEffect hooks are firing (all instrumented ones silent)
3. ✅ NO component re-renders happening (WhatIfControl render not logging)
4. ✅ NO rc-dock layout changes (onLayoutChange not logging)
5. ✅ ResizeObserver disabled (didn't fix it)
6. ✅ User is selecting EXISTING value (no state change should occur)

### What This Means:
**The issue is NOT in React's render/effect cycle at all.**

The blocking is happening in:
1. **Native browser select dropdown rendering**
2. **DOM manipulation outside React**
3. **Synchronous JavaScript executing BEFORE React processes anything**
4. **A tight loop that blocks the event loop entirely**

### The Prime Suspects:

#### 🔴 #1: EnhancedSelector.tsx dropdown positioning
**Hypothesis**: When dropdown opens, positioning calculation triggers layout reflow in a tight loop
- **Evidence**: No React logging = blocking happens BEFORE React updates
- **Mechanism**: 
  ```
  1. User clicks select
  2. EnhancedSelector calculates position (getBoundingClientRect)
  3. Position update triggers DOM reflow
  4. Reflow triggers ResizeObserver in parent (even though we disabled GraphEditor's one!)
  5. Observer callback does more DOM queries
  6. Loop repeats 1000s of times
  ```
- **NOT INSTRUMENTED YET** ⚠️

#### 🔴 #2: rc-dock internal rendering loop
**Hypothesis**: rc-dock library has internal DOM mutation loop triggered by dropdown
- **Evidence**: Our onLayoutChange isn't called but rc-dock might be re-rendering internally
- **Mechanism**: Dropdown causes reflow → rc-dock recalculates panel sizes → triggers more reflows
- **Cannot instrument**: Inside node_modules

#### 🔴 #3: Browser's native select + fixed positioning conflict
**Hypothesis**: Native select dropdown conflicts with fixed/absolute positioning in sidebar
- **Evidence**: Sidebar uses complex positioning (absolute, fixed, rc-dock panels)
- **Mechanism**: Browser struggles to calculate where to render native dropdown overlay
- **Test**: Try replacing native select with custom dropdown

---

## 🎯 IMMEDIATE ACTION ITEMS (In Priority Order):

### 1. Instrument EnhancedSelector.tsx (30 seconds)
Add logging to all 4 useEffect hooks AND component render
```typescript
console.log(`[${new Date().toISOString()}] [EnhancedSelector] RENDER`);
console.log(`[${new Date().toISOString()}] [EnhancedSelector] useEffect#ES1: Position`);
console.log(`[${new Date().toISOString()}] [EnhancedSelector] useEffect#ES2: Click outside`);
console.log(`[${new Date().toISOString()}] [EnhancedSelector] useEffect#ES3: Update suggestions`);
console.log(`[${new Date().toISOString()}] [EnhancedSelector] useEffect#ES4: Scroll selected`);
```

### 2. Check if EnhancedSelector is even used for What-If dropdowns (10 seconds)
- **Look at WhatIfAnalysisControl.tsx dropdown implementation**
- **Is it using native `<select>` or EnhancedSelector?**
- **If native select**: Problem is browser-level, not our code

### 3. Add Performance API markers around dropdown (1 minute)
```typescript
performance.mark('dropdown-mousedown-start');
// ... dropdown interaction ...
performance.mark('dropdown-mousedown-end');
performance.measure('dropdown-lag', 'dropdown-mousedown-start', 'dropdown-mousedown-end');
console.log(performance.getEntriesByType('measure'));
```

### 4. Profile with Chrome DevTools Performance tab (2 minutes)
- Start recording
- Interact with dropdown
- Stop recording
- Look for:
  - Long tasks (>50ms)
  - Layout thrashing
  - Function calls in tight loops

---

## 🧠 LOGICAL DEDUCTION:

If NO React code is logging, then either:

**A) The blocking happens in native browser code**
- Native `<select>` dropdown rendering
- CSS calc() in tight loop
- Paint/Layout operations

**B) The blocking happens in synchronous non-React code**
- Plain JavaScript event handlers
- Third-party library (rc-dock)
- DOM queries in a loop

**C) There's a ResizeObserver/MutationObserver we haven't found yet**
- Check for observers in node_modules/rc-dock
- Check for observers created dynamically
- Check browser DevTools → Performance → Observers

**The answer is NOT in React useEffect hooks because NONE of them are firing.**
