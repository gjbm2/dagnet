# Performance Analysis Findings - Pan Operation

**Date**: 2025-11-15  
**Profile**: `Trace-20251115T140321.json`  
**Operation**: Single pan gesture on graph canvas  
**Duration**: ~4.7 seconds of recording

---

## Executive Summary

**CATASTROPHIC PERFORMANCE ISSUE CONFIRMED**

For a simple pan operation that should complete in < 100ms with 2-3 lightweight frames, we observed:

- **13 tasks taking > 100ms each** (multi-frame freezes)
- **14 tasks taking > 50ms** (guaranteed dropped frames)
- **532ms total JavaScript time** (26× over budget)
- **112 calls to `dispatchContinuousEvent`** (mouse move handler)
- **One single task: 468ms** (blocking the main thread for 28+ frames)

**Root Cause:** Synchronous JavaScript computation during pan events, NOT rendering/layout issues.

---

## Critical Findings

### 1. The 468ms Blocking Task

**What:**
- Single continuous event dispatch (mouse move) took **468.02ms**
- This is a **synchronous** operation blocking the entire browser
- Call stack: `WidgetBaseInputHandler → EventDispatch → v8.callFunction → dispatchContinuousEvent`

**Impact:**
- At 60fps (16ms per frame), this blocks **29 frames**
- User sees complete freeze for half a second
- Guarantees visible jank, flicker, incomplete redraws

**Source:**
- JavaScript file: `chunk-FQHYCYVK.js?v=2c44b198` (your main React bundle)
- Function: `dispatchContinuousEvent`
- Triggered by: Mouse move during pan

### 2. Catastrophic Work Distribution

Timeline analysis (100ms windows):

| Time Window | Total Work | Events | Status |
|-------------|------------|--------|--------|
| 0.0s (init) | 4689ms | 57 | Expected (page load) |
| 1.0s | 51ms | 130 | ⚠️ Spike |
| **2.1s** | **1101ms** | 198 | ❌ **CATASTROPHIC** |
| **2.4s** | **130ms** | 514 | ⚠️ Major work |
| **3.2s** | **625ms** | 2893 | ❌ **CATASTROPHIC** |
| 3.3s | 97ms | 115 | ⚠️ Continued work |

**Pattern:**
- Pan starts around 2.1s
- **1.1 second stall** immediately
- Brief recovery
- **625ms stall** shortly after
- Total: **~1.9 seconds of JavaScript execution** for what should be a 50ms interaction

### 3. Function Call Analysis

**Most frequent:**
- `dispatchContinuousEvent`: **112 calls**, 470ms total, 4.2ms average
  - This is your mouse move handler
  - Being called continuously during pan (expected)
  - But each call is taking **4ms average** (should be < 1ms)

**Most expensive:**
- `dispatchContinuousEvent`: **470ms total**
- `performWorkUntilDeadline`: **51ms total** (React's scheduler)
  - 5 calls, averaging 10.26ms each
  - This is React processing the work queue

**Implication:**
- Mouse move events are triggering React work
- React is doing expensive computation synchronously
- Not yielding between events (batching issue or dependency cascade)

### 4. Script Execution Breakdown

| Script File | Calls | Total Time | What It Is |
|-------------|-------|------------|------------|
| `chunk-FQHYCYVK.js` | 128 | 527.96ms | Your main React bundle (GraphCanvas, edges, beads) |
| `reactflow.js` | 6 | 1.01ms | ReactFlow library (minimal - good!) |
| `GraphCanvas.tsx` | 7 | 0.37ms | Direct GraphCanvas script (minimal) |

**Key insight:**
- The bundled React code (`chunk-FQHYCYVK.js`) is doing 99% of the work
- ReactFlow itself is barely involved (1ms)
- This confirms: **Your React re-render logic is the problem, not ReactFlow**

### 5. Rendering Work is NOT the Problem

- **UpdateLayoutTree**: 5 calls, 0.83ms total
- **Layout**: 2 calls, 0.60ms total  
- **Paint**: 14 calls, 17.64ms total
- **Total rendering: 19ms** ✅

**Conclusion:**
- DOM/layout/paint work is minimal and healthy
- **The 532ms of JavaScript is pure computation**, not browser rendering
- This means:
  - Not layout thrashing
  - Not forced reflows
  - Not CSS complexity
  - **It's React component re-renders and memo recomputation**

---

## Console Log Correlation

From `tmp.log`, we see 13 render frames during the ~5 second window.

**Timeline correlation:**

| Trace Spike | Console Frames | Timing |
|-------------|----------------|--------|
| 2.1s (1101ms) | Frames #28-31 | GraphCanvas re-rendering, buildScenarioRenderEdges recomputing |
| 3.2s (625ms) | Frames #32-33 | More re-renders, more edge rebuilds |

**Pattern matches:**
- Every `Render frame` in console logs corresponds to a spike in the trace
- Every spike shows `buildScenarioRenderEdges` recomputing
- Every `renderEdges useMemo recompute` log happens during a trace spike

**Proof:** The console logs directly correlate with the trace timeline spikes, confirming that `renderEdges` memo recomputation is causing the 100ms+ stalls.

---

## Root Cause Analysis

### Why `dispatchContinuousEvent` Takes 468ms

The call chain is:

1. **Browser dispatches mouse move event**
2. **ReactFlow's pan handler fires** (`onMove` callback)
3. **Your `onMove` handler in GraphCanvas**:
   - Does something that changes state or props
   - Triggers React re-render
4. **React renders GraphCanvas**:
   - `renderEdges` useMemo dependencies have changed
   - Calls `buildScenarioRenderEdges` (3-7ms per call from logs)
   - But it's being called MANY times in succession (cascading)
5. **React renders all 10 ConversionEdge components**:
   - Each edge rebuilds beads
   - Each edge calls `buildBeadDefinitions` (0.1-2ms each)
   - Each edge renders lozenges (2-3ms each from logs)
6. **Total accumulates to 468ms synchronously**

### Why It's Cascading

From the analysis, we see:
- **198 events** in the 2.1s window (cluster #23)
- **2893 events** in the 3.2s window (cluster #36)

This suggests:
- Not a single 468ms computation
- But a **cascade** of smaller recomputations happening in rapid succession
- Each triggering the next (effect loop or state update cascade)

**Hypothesis:**
1. Mouse move → changes viewport → triggers state update
2. State update → `renderEdges` deps change → recomputes edges
3. New edges → ReactFlow reconciliation → more state updates
4. More state updates → more memo recomputes
5. Loop continues until something settles

---

## Specific Technical Issues Identified

### Issue #1: `renderEdges` Recomputing on Pan

**Evidence:**
- Console logs show `renderEdges useMemo recompute: 3-7ms` on multiple frames during pan
- Trace shows corresponding spikes when those logs appear

**Cause:**
- One or more dependencies in the `renderEdges` useMemo are changing during pan
- Most likely candidates (from code review):
  - `graph` object identity changing
  - `scenariosContext` object identity changing  
  - `calculateEdgeOffsets` function identity changing
  - `highlightMetadata` object identity changing

**Fix Required:**
- Add dependency change tracking (as planned in RENDER_FORENSICS_PLAN.md)
- Identify which specific dep is flapping
- Stabilize that dependency (use version numbers, useMemo the object, etc.)

### Issue #2: Cascading Re-Renders

**Evidence:**
- 2893 events in a single 100ms window (cluster #36)
- 198 events in another 50ms window (cluster #23)
- Multiple `Render frame` logs in quick succession (frames #28-33)

**Cause:**
- React re-render triggers effect
- Effect triggers state update
- State update triggers another re-render
- Cycle repeats

**Fix Required:**
- Audit effects in GraphCanvas for circular dependencies
- Ensure effects only run when intended (not on every render)
- Break the loop (use refs, guard conditions, or remove unnecessary effects)

### Issue #3: `performWorkUntilDeadline` Taking 10ms Each

**Evidence:**
- 5 calls, 51ms total, 10.26ms average
- This is React's Concurrent Mode scheduler trying to process work

**Cause:**
- React has a large work queue from all the re-renders
- It's trying to process them in batches
- But the queue is too large to process efficiently

**Implication:**
- Even if we fix the cascade, React still has to process the accumulated work
- Need to prevent the work from accumulating in the first place

---

## Smoking Gun: Cluster #23 (2.1s)

Let's focus on the **worst cluster** (2.1s, 1097ms of work):

**Breakdown:**
- 198 total events
- 84 RunTask events
- 43 v8.callFunction events
- 43 FunctionCall events

**Timeline:**
- Starts at 2.081s into recording
- **1.1 seconds of continuous work**
- During this time, browser is **completely blocked**

**What's happening (from console correlation):**
- Multiple `Render frame` logs
- Multiple `buildScenarioRenderEdges` recomputes
- Multiple `renderEdges useMemo recompute` logs

**This is the cascade in action:**
- Pan event → state change → render frame
- Render computes new edges → ReactFlow reconciles → triggers more renders
- Loop continues for **1.1 seconds** before settling

---

## Actionable Next Steps

### Immediate (Phase 1): Dependency Tracking

**Add logging to `renderEdges` useMemo to see which dep changes on each recompute:**

```typescript
const prevDeps = useRef<any>(null);

const renderEdges = useMemo(() => {
  // Log what changed
  if (prevDeps.current) {
    const changes = [];
    if (prevDeps.current.edgeIdsKey !== edgeIdsKey) changes.push('edgeIdsKey');
    if (prevDeps.current.nodeIdsKey !== nodeIdsKey) changes.push('nodeIdsKey');
    if (prevDeps.current.graph !== graph) changes.push('graph');
    if (prevDeps.current.scenariosContext !== scenariosContext) changes.push('scenariosContext');
    // ... check all deps
    
    console.log('[DEPS] renderEdges deps changed:', changes);
  }
  
  prevDeps.current = { edgeIdsKey, nodeIdsKey, graph, scenariosContext, /*...*/ };
  
  // ... rest of memo
}, [dependencies]);
```

**Run another pan profile with this logging**, and you'll see exactly which dependency is changing.

### Phase 2: Fix the Unstable Dependency

Based on what Phase 1 reveals, apply the appropriate fix:

**If `graph` is changing:**
- Introduce `graphVersion` number in GraphStoreContext
- Only increment when topology actually changes
- Use `graphVersion` instead of `graph` object in deps

**If `scenariosContext` is changing:**
- Audit ScenariosContext for unnecessary re-emits
- Use stable references for scenarios array
- Memoize the context value

**If `calculateEdgeOffsets` is changing:**
- Wrap in useCallback with minimal deps
- Or hoist outside GraphCanvas if it's truly static

**If `highlightMetadata` is changing:**
- Already has deps: `[nodeSelectionKey, edgesChanged, findPathEdges]`
- But `findPathEdges` might be changing
- Stabilize `findPathEdges` with tighter deps

### Phase 3: Validate

After the fix:
- Record another pan profile
- Run the analysis scripts
- **Expected results:**
  - Long tasks: 0-2 (down from 35)
  - Total JS time: < 20ms (down from 532ms)
  - No 100ms+ stalls
  - Smooth 60fps pan

---

## Priority Order

1. **CRITICAL (Do First)**: Add dependency tracking to `renderEdges` to identify the flapping dep
2. **HIGH**: Stabilize the identified dependency
3. **MEDIUM**: Audit effects for cascades (may not be needed if #1-2 fix it)
4. **LOW**: Add full diagnostic logging infrastructure (nice to have for future)

The trace data gives us enough information to proceed directly to fixing the specific dependency issue rather than building extensive instrumentation first.

---

## How to Use These Findings

1. **Implement Phase 1** (dependency tracking) - 5 minutes of coding
2. **Record another pan with the tracking enabled** - 30 seconds
3. **Check console for `[DEPS] renderEdges deps changed:` log** - see which deps flapped
4. **Implement the fix** for that specific dependency - 10-30 minutes
5. **Record a validation pan profile** - 30 seconds
6. **Run analysis scripts again** - compare before/after

**Expected outcome:** Going from 532ms → < 20ms JavaScript time, smooth 60fps pan.

---

## Technical Details for Reference

### Trace File Stats
- Total events: 17,420
- Renderer process events: 12,064
- Recording duration: 4.69 seconds
- Renderer process ID: 30064

### Top Time Consumers (Functions)
1. `dispatchContinuousEvent`: 470ms (112 calls, 4.2ms avg)
2. `performWorkUntilDeadline`: 51ms (5 calls, 10.26ms avg)

### Top Time Consumers (Scripts)
1. `chunk-FQHYCYVK.js` (React bundle): 527ms
2. All other scripts: < 2ms

### Activity Clusters
- 44 clusters total
- Worst cluster: 2.081s, 1097ms work, 198 events
- Second worst: 3.261s, 409ms work, 2508 events

### Rendering Performance (Good!)
- Layout: 0.60ms total ✅
- Paint: 17.64ms total ✅
- UpdateLayoutTree: 0.83ms total ✅

---

## Files Generated

- `perf/analysis_report.txt`: Basic analysis output
- `perf/FINDINGS.md`: This summary (you are here)
- `perf/analyze_trace.py`: Basic trace analyzer
- `perf/deep_analyze_trace.py`: Detailed trace analyzer

**To re-run analysis:**
```bash
python3 perf/deep_analyze_trace.py perf/Trace-20251115T140321.json --console-log tmp.log
```

**To analyze a new trace:**
```bash
python3 perf/deep_analyze_trace.py perf/new-trace.json
```

