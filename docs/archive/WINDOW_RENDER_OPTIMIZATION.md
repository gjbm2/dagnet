# Window Selector Render Optimization Analysis & Fix Plan

## Problem Statement



When toggling between window presets (e.g., 30d ↔ 90d) that both require a fetch, the application triggers **excessive unnecessary rendering** (~140ms, 10+ render cycles) even though:
- No graph data changes
- No functional outcome changes (both require fetch)
- Only the active tab for that specific graph should care

This is a symptom of a more general problem: overmuch render churn. 

We do not want a local guard against this just on window changes, 
but a more general solution which addresses the root cause.

## Root Cause Analysis

### 1. **GraphStoreProvider.subscribe() Fires on ALL State Changes**

**Location:** `GraphStoreContext.tsx:272`

**Problem:**
- `store.subscribe()` subscribes to the **entire store**, including `window` changes
- Every window change triggers async IndexedDB persistence
- This creates a cascade of state updates

**Impact:**
- Window changes trigger persistence → reload → state update → subscribe callback → more renders

**Evidence from log:**
```
Line 6: GraphStoreProvider: Persisting window for graph-WA-case-conversion-test to 2 tabs
Line 38: GraphStoreProvider: Loaded persisted window... (reload triggers another update)
Line 70: GraphStoreProvider: Persisting lastAggregatedWindow...
Line 101: GraphStoreProvider: Loaded persisted window... (another reload)
```

### 2. **Persistence → Reload Loop**

**Problem:**
- Persisting window to IndexedDB triggers `updateTabState()`
- Loading from IndexedDB calls `setState()` on the store
- This creates another store update → another subscribe callback → render cycle

**Impact:**
- Single window change causes 2-3 persistence/reload cycles
- Each cycle triggers full component re-renders

### 3. **ALL GraphEditor Instances Re-render**

**Location:** `GraphEditor.tsx:973` - `const store = useGraphStore()`

**Problem:**
- `useGraphStore()` subscribes to **all store changes**, including `window`
- All 3 GraphEditor instances re-render:
  - `graph-WA-case-conversion-test` (active tab - should render)
  - `graph-test-project-data` (inactive - shouldn't render)
  - `graph-WA-case-conversion` (inactive - shouldn't render)

**Impact:**
- 3x unnecessary GraphEditor renders
- Each GraphEditor render triggers GraphCanvas render
- Multiple useEffect re-runs (keyboard shortcuts, sidebar state, menu listeners)

**Evidence from log:**
```
Lines 17-31: All 3 GraphEditors render
Lines 48-70: All 3 GraphEditors render again
Lines 81-95: All 3 GraphEditors render again
Lines 111-115: All 3 GraphEditors render again
```

### 4. **Window Changes Should Only Affect Visible Tabs for That Graph**

**Current Behavior:**
- Window change affects ALL tabs for that fileId
- Even inactive/background/hidden tabs re-render
- Other graphs' tabs also re-render (incorrectly)

**Expected Behavior:**
- Window is correctly per graph file (fileId) - this is correct design
- Window change should ONLY affect:
  - **Visible tabs** for the specific graph (can be multiple if split view, etc.)
  - Only if those tabs are currently visible/rendered
  - Hidden/invisible tabs for that graph should NOT re-render until they become visible
  - Tabs for OTHER graphs should NOT re-render at all

**Key Insight:**
- rc-dock uses `cached: true` - tabs are kept in DOM but may not be visible
- A tab is "visible" if its EditorComponent is mounted AND the tab's panel is visible
- Multiple tabs can be visible simultaneously (split view, multiple dock panels)
- Need to check tab visibility, not just if it's active

**Evidence:**
- Log shows 3 different graphs rendering: `WA-case-conversion-test`, `test-project-data`, `WA-case-conversion`
- Only `WA-case-conversion-test` tabs are visible
- Other graphs shouldn't care about this window change at all
- Hidden tabs for `WA-case-conversion-test` shouldn't render either

### 5. **WindowSelector Coverage Check Runs Too Late**

**Location:** `WindowSelector.tsx:143` - debounced 300ms

**Problem:**
- Coverage check is debounced 300ms
- Runs AFTER all the renders have already happened
- Could short-circuit earlier if we knew window didn't functionally change

**Impact:**
- All renders happen before we even check if anything needs to happen
- Could prevent renders if we detect "no functional change" earlier

### 6. **Multiple useEffect Re-runs**

**Locations:**
- `PropertiesPanel.tsx:395` - Setup keyboard shortcuts (runs 3+ times)
- `useSidebarState.ts:106` - Persist sidebar state (runs 3+ times)
- `GraphEditor.tsx:1178` - Setup menu bar listeners (runs 3+ times)

**Problem:**
- These effects depend on store subscriptions or tab state
- Window changes trigger store updates → effects re-run unnecessarily

**Evidence from log:**
```
Lines 33-36: Effects run
Lines 41-46: Effects run again
Lines 97-109: Effects run again
```

### 7. **NavigatorContent Re-renders Multiple Times**

**Location:** `NavigatorContent.tsx:164`

**Problem:**
- Renders for all 3 files, multiple times per window change
- Likely triggered by tab state updates

**Evidence from log:**
```
Lines 11-16: Navigator renders for all 3 files
Lines 75-80: Navigator renders for all 3 files again
```

## Fix Plan

### Phase 1: Prevent Invisible Tab Re-renders (Visibility + Selective Subscriptions)

**Goal:** Only visible tabs for the specific graph should re-render when window changes.

**Current Design (CORRECT):**
- Window is stored per `fileId` in GraphStore (shared across all tabs for that graph)
- This is the correct design - all tabs viewing the same graph share the same window

**Problem:**
- All tabs for that fileId re-render when window changes, even if not visible
- Other graphs' tabs also re-render (incorrectly)

**Changes:**

1. **Define “visibility” precisely and centrally**
   - Create a `VisibleTabsContext` maintaining a Set of visible `tabId`s.
   - Feed it from rc-dock events (e.g., `onLayoutChange`, panel shown/hidden, minimization) to mark tabs whose panels are actually visible.
   - As a fallback, allow an `IntersectionObserver` on each editor container to flag visibility.

2. **Gate heavy subtrees inside GraphEditor**
   - Keep a lightweight editor shell mounted so layout and event wiring remain stable.
   - Conditionally render heavy children only when the `tabId` is listed as visible:
     - `GraphCanvas`
     - Expensive sidebar panels content (the containers may stay mounted; gate inner content)
   - On visibility transition to visible, trigger a safe revalidation:
     - Recompute canvas dimensions and force a redraw (reuse the existing `dagnet:forceRedraw` pattern).
     - If window changed while hidden, perform a single coverage check.

3. **Use selective store subscriptions**
   - Ensure `GraphEditor` subscribes only to slices it actually needs (e.g., `graph`), not the full store including `window`.
   - `WindowSelector` remains the place that cares about `window`.
   - Use Zustand selectors with `shallow` or custom equality to avoid re-renders from unrelated state.

4. **Keyboard/menu handlers remain scoped to active tab**
   - Current handlers already guard on `activeTabId === tabId`. Keep that behavior unchanged.

**Key Question:** How do we determine if a tab is "visible"?
- rc-dock uses `cached: true` for tabs - cached tabs are kept in DOM but may not be visible
- A tab is "visible" if:
  - Its EditorComponent is mounted (tab exists in rc-dock layout)
  - The tab's panel is visible (not hidden/minimized)
  - The tab is in a visible dock panel (not just cached)
- Multiple tabs can be visible at once (split view, multiple dock panels)
- Possible approach: 
  - Track visibility via a `VisibleTabsContext` updated from rc-dock layout events.
  - Optionally confirm with `IntersectionObserver` on the editor container for robustness.
  - Do not rely on DOM presence alone when `cached: true` is set.

**Files to modify:**
- `graph-editor/src/components/editors/GraphEditor.tsx` - Add visibility gating and selective subscriptions
- `graph-editor/src/components/GraphCanvas.tsx` - Add an early exit or no-op render when not visible; add resize/reflow hook on become-visible
- `graph-editor/src/contexts/VisibleTabsContext.tsx` (new) - Track visible tabs from rc-dock events

**Benefits:**
- Only visible tabs re-render on window change
- Hidden/invisible tabs don't waste CPU
- Other graphs' tabs don't re-render at all
- Multiple visible tabs for same graph all update correctly

### Phase 2: Optimize Persistence Logic (Centralized Debounce + Loop Guards)

**Goal:** Prevent persistence → reload loops while keeping window per `fileId`. Avoid double-debouncing and brittle equality.

**Changes:**

1. **Centralize debouncing at persistence layer**
   - Debounce persistence of `window` in the store/provider (not in multiple places).
   - 400–600ms debounce to reduce IDB churn; use a single source of truth.

2. **Robust equality checks**
   - For `DateRange`, normalize and compare `start`/`end` strings exactly.
   - Avoid `JSON.stringify` except as a last resort; prefer explicit normalization functions and/or stable hash/version.

3. **Loop guards**
   - Track `lastPersistedWindow` and `lastLoadedWindowVersion` (or hash).
   - Do not load from persistence if equal to current in-memory value.
   - Write-through should not trigger a read unless a meaningful change occurred.

4. **Avoid duplicate debounce layers**
   - Keep coverage debounce focused in `WindowSelector` (Phase 3).
   - Do not also debounce the same signal elsewhere.

**Files to modify:**
- `graph-editor/src/contexts/GraphStoreContext.tsx` - Debounce persistence, equality checks, loop guards
- `graph-editor/src/contexts/TabContext.tsx` - If any tab-level persistence touches window, align to store’s debounce and equality rules

**Benefits:**
- No persistence → reload loops
- Fewer IndexedDB operations
- Smoother UI

### Phase 3: Early Short-Circuit Coverage Checks (Fast No-Op + Coverage Cache)

**Goal:** Detect "no functional change" before triggering renders.

**Changes:**

1. **Compare windows before state update**
   - In `WindowSelector.handlePreset()`, normalize and compare against current window.
   - If equal, skip `setWindow` entirely to avoid cascading effects.

2. **Memoize coverage check results**
   - Cache per `fileId|windowKey`.
   - Reuse results when window hasn’t changed.

3. **Reduce debounce time**
   - Keep coverage debounce short (100–150ms) for snappy UI.
   - The synchronous equality check prevents most no-op work before debounce kicks in.

**Files to modify:**
- `graph-editor/src/components/WindowSelector.tsx` - Add early short-circuit logic

**Benefits:**
- Faster response to user input
- Fewer unnecessary coverage checks
- Better UX

### Phase 4: Optimize Effect Dependencies (Effect Hygiene)

**Goal:** Prevent unnecessary effect re-runs.

**Changes:**

1. **Review all useEffect dependencies**
   - `PropertiesPanel`, `useSidebarState`, `GraphEditor` effects
   - Remove store subscriptions from dependencies if not needed
   - Use refs for values that shouldn't trigger re-runs

2. **Split effects by concern**
   - Separate "setup" effects from "reactive" effects
   - Setup effects should run once (empty deps)
   - Reactive effects should only depend on what they actually react to

3. **Use useMemo/useCallback**
   - Memoize expensive computations
   - Prevent unnecessary recalculations

4. **Honor active tab and visibility scope**
   - Keep keyboard/menu handlers scoped to `activeTabId`.
   - Where applicable, skip reactive work when tab is not visible.

**Files to modify:**
- `graph-editor/src/components/PropertiesPanel.tsx`
- `graph-editor/src/hooks/useSidebarState.ts`
- `graph-editor/src/components/editors/GraphEditor.tsx`

**Benefits:**
- Fewer effect re-runs
- Better performance
- More predictable behavior

## Implementation Order

1. **Phase 1** (Highest priority) - Visibility + selective subscriptions
   - This will eliminate most unnecessary GraphEditor renders
   - Only visible tabs re-render on window change
   - Foundation for other optimizations

2. **Phase 2** - Optimize persistence (centralized debounce + guards)
   - Will eliminate the persistence → reload loops
   - Can be done in parallel with Phase 1

3. **Phase 3** - Early short-circuit + coverage cache
   - Nice-to-have optimization
   - Can be done independently

4. **Phase 4** - Optimize effects
   - Final polish
   - Can be done incrementally

## Risk Mitigations

- GraphCanvas staleness on hidden tabs
  - Keep editor shell mounted; gate only heavy children.
  - On become-visible, recalc size and force redraw; if window changed, perform one coverage check.

- PropertiesPanel and sidebar correctness
  - Do not remove needed deps; split setup vs reactive effects.
  - Use selector-based subscriptions for exact slices.

- Persistence double-debounce and brittle equality
  - Centralize debounce in store; use normalized `DateRange` comparer; track `lastPersistedWindow` to avoid ping-pong.

- Multi-tab (split view) correctness
  - Use `VisibleTabsContext` to allow multiple visible tabs for the same graph to update concurrently.

- rc-dock visibility assumptions
  - Drive visibility from rc-dock events; optionally confirm via `IntersectionObserver`.

- Rollout safety
  - Add a feature flag (e.g., `windowOptimizationsEnabled`) and render counters for `GraphEditor`, `GraphCanvas`, and `WindowSelector`.
  - Validate in split view, rapid toggles, and hidden→visible transitions before enabling by default.

## Expected Results

**Before:**
- ~140ms of renders
- 10+ render cycles
- All 3 GraphEditors render
- Multiple persistence/reload cycles

**After:**
- ~20-30ms of renders
- 2-3 render cycles (only visible tabs for that graph)
- Only visible GraphEditor instances render
- Single persistence operation (debounced)
- No reload loops

## Testing Strategy

1. **Render counting**
   - Add render counters to GraphEditor, GraphCanvas, WindowSelector
   - Verify only visible tabs for that graph render on window change
   - Verify tabs for other graphs don't render

2. **Performance profiling**
   - Use React DevTools Profiler
   - Measure render time before/after

3. **Functional testing**
   - Verify window changes still work correctly
   - Verify multiple visible tabs for same graph all update correctly
   - Verify persistence still works
   - Verify window is shared across all tabs for that graph (correct behavior)

4. **Edge cases**
   - Tab switching with window changes
   - Multiple visible tabs for same graph (split view)
   - Hidden tabs becoming visible (should render then)
   - Rapid window changes (debouncing)

## Notes

- **Window state design is CORRECT**: Window is per `fileId` in GraphStore (shared across tabs for that graph)
- **Problem is visibility**: Invisible/hidden tabs shouldn't re-render when window changes
- GraphStore correctly manages window per graph file
- GraphEditor should only re-render if tab is visible (can be multiple visible tabs for same graph)
- WindowSelector correctly uses GraphStore for window state
- Need to determine how to check if a tab is "visible" in rc-dock (cached vs actually visible)

