# DevTools Profiling Guide: Step-by-Step Instructions

## Overview

This guide provides simple, researched instructions for capturing and analyzing render performance during drag/pan interactions using browser developer tools.

**Two main tools:**
1. **Chrome Performance Tab**: Complete picture (JS, rendering, painting, compositing)
2. **React DevTools Profiler**: React-specific (which components rendered, why)

Use **both** for maximum insight.

---

## Tool 1: Chrome DevTools Performance Tab (Complete Picture)

### What It Shows

- **JavaScript execution** (which functions ran, for how long)
- **Rendering work** (style recalculation, layout, paint, composite)
- **Frame timing** (which frames dropped, how long each took)
- **Call stacks** (what triggered each operation)
- **Timeline** (when things happened relative to user interaction)

### Step-by-Step: Recording a Pan Interaction

#### 1. Open Chrome DevTools
- Press `F12` or `Ctrl+Shift+I` (Windows/Linux) or `Cmd+Option+I` (Mac)
- Click the **Performance** tab (not Console or Elements)

#### 2. Configure Settings (First Time Only)
- Click the **gear icon** ⚙️ in the Performance tab
- Enable these options:
  - ✅ **Screenshots** (to see visual timeline)
  - ✅ **Enable advanced paint instrumentation (slow)** (to see paint details)
  - ✅ **Memory** (to track memory during interaction)
- **Disable** throttling (set CPU to "No throttling")
  - If you want to simulate slower devices, use "4× slowdown" but start with no throttling

#### 3. Start Recording
- Click the **Record button** ⏺️ (or press `Ctrl+E` / `Cmd+E`)
- You'll see "Recording..." indicator

#### 4. Perform the Pan Interaction
- **Wait 1 second** (to establish baseline)
- **Perform ONE pan gesture** (click and drag the canvas once)
- **Wait 1 second** (to see post-interaction behavior)
- Keep it SHORT (3-5 seconds total) - shorter recordings are easier to analyze

#### 5. Stop Recording
- Click the **Stop button** ⏹️ (or press `Ctrl+E` / `Cmd+E` again)
- DevTools will process and display the profile (may take 5-10 seconds)

#### 6. Initial Analysis: Overview

You'll see several sections:

**A. Screenshots Timeline (top)**
- Visual timeline of what the page looked like
- Scrub through to see when visual changes occurred
- Look for: blank frames, half-drawn frames, flicker

**B. Frames Bar (FPS meter)**
- Green bars = good frame (< 16ms)
- Yellow/orange bars = slow frame (16-50ms)
- Red bars = dropped frame (> 50ms)
- **Click on a red/yellow bar** to zoom to that frame

**C. Main Thread (the important one)**
- Shows what the browser was doing on the main thread
- Tasks are shown as blocks (wider = took longer)
- Color coding:
  - **Yellow**: JavaScript execution
  - **Purple**: Rendering (style recalc, layout)
  - **Green**: Painting
  - **Grey**: Other/idle

#### 7. Deep Dive: Find the Bottleneck

**Step 7a: Identify Long Tasks**
- Look for **wide yellow blocks** during your pan interaction
- These are long-running JavaScript operations
- Click on a wide block to see details in the **Bottom pane**

**Step 7b: Examine Bottom Pane (Summary)**
When you click a task, the bottom pane shows:
- **Summary tab**: Pie chart of time breakdown
  - Scripting (JS)
  - Rendering
  - Painting
  - System
  - Idle
- Look for which category dominates

**Step 7c: Call Tree Tab**
- Switch to **Call Tree** tab in bottom pane
- Shows **which functions took the most time** (top-down)
- Sort by "Self Time" (time in that function alone)
- Sort by "Total Time" (time including called functions)

**What to look for:**
- Functions taking > 10ms
- Functions called many times (high "Count" column)
- Your own code vs library code (React, ReactFlow)

**Step 7d: Bottom-Up Tab**
- Switch to **Bottom-Up** tab
- Shows leaf functions (deepest calls first)
- Good for finding **hot spots** (specific operations that are slow)

**Example findings:**
- `measureText` called 200 times taking 80ms total
- `buildScenarioRenderEdges` taking 50ms
- `computeEffectiveEdgeProbability` in a loop taking 100ms
- ReactFlow's internal layout recalculation taking 30ms

#### 8. Specific Things to Check

**A. Scripting (Yellow blocks)**
- Expand the yellow blocks to see function calls
- Look for:
  - `React` → `renderWithHooks` → YourComponent → YourFunction
  - How deep the call stack is (too deep = performance issue)
  - Repeated calls to the same function

**B. Rendering (Purple blocks)**
- "Recalculate Style" = CSS rules being re-evaluated
- "Layout" = Browser calculating positions/sizes (expensive!)
- "Update Layer Tree" = Preparing layers for compositing
- **If you see lots of purple during pan** = DOM changes triggering layout thrashing

**C. Painting (Green blocks)**
- "Paint" = Browser drawing pixels
- Should be minimal during pan (just viewport change, no repainting needed)
- **If you see lots of green during pan** = something is forcing repaints unnecessarily

**D. Long Tasks (Red flag)**
- Any single task > 50ms will show a **red triangle** in top-right corner
- Click it to see breakdown
- These are guaranteed frame drops

#### 9. Export Profile for Later Analysis

- Click the **Download button** ⬇️ (saves as `.json`)
- Can reload later: **Upload button** ⬆️
- Can share with others for collaborative debugging

### What to Look For (Pan Operation)

**Good pan profile:**
- 2-3 thin yellow blocks (onMoveStart, onMove, onMoveEnd)
- No purple blocks (no layout recalc)
- No green blocks (no repaint)
- All frames green (< 16ms)
- Total JS time < 50ms

**Bad pan profile (what you likely have now):**
- 10+ yellow blocks (many JS operations)
- Wide yellow blocks (> 10ms each)
- Purple blocks during pan (layout thrashing)
- Red/yellow frames (dropped frames)
- Repeated calls to the same functions
- Total JS time > 200ms

---

## Tool 2: React DevTools Profiler (Component-Specific)

### What It Shows

- **Which React components rendered** during an interaction
- **Why they rendered** (props changed, context changed, hooks changed, parent rendered)
- **How long each component took** to render
- **Flame graph** (hierarchical view of render time)
- **Ranked list** (slowest components first)

### Step-by-Step: Profiling a Pan Interaction

#### 1. Install React DevTools (If Not Already)
- Chrome: https://chrome.google.com/webstore/detail/react-developer-tools/fmkadmapgofadopljbjfkapdkoienihi
- Edge: Same extension works
- Firefox: https://addons.mozilla.org/en-US/firefox/addon/react-devtools/

#### 2. Open React DevTools
- Press `F12` to open DevTools
- Click the **⚛️ Profiler** tab (if you don't see it, click the `>>` arrows)

#### 3. Configure Settings (First Time)
- Click the **gear icon** ⚙️ in the Profiler tab
- Enable:
  - ✅ **Record why each component rendered while profiling**
  - ✅ **Hide commits below X ms** → set to **1ms** (to see everything)

#### 4. Start Profiling
- Click the **blue record button** ⏺️ in the Profiler tab
- You'll see "Profiling..." indicator

#### 5. Perform the Pan Interaction
- **Wait 1 second** (baseline)
- **Perform ONE pan gesture** (click and drag canvas once)
- **Wait 1 second** (to see aftermath)
- Keep it short (3-5 seconds total)

#### 6. Stop Profiling
- Click the **red stop button** ⏹️
- React DevTools will process the recording

#### 7. Analyze the Results

You'll see a timeline at the top with **"commits"** (each commit = one React render cycle).

**A. Navigate Between Commits**
- Each vertical bar = one commit
- **Height** = how long that commit took
- **Color**:
  - Green/yellow = fast
  - Orange/red = slow
- **Click on a bar** to see details

**B. Flame Graph View (Default)**

Shows a hierarchical flame chart:
- **Width** = render time
- **Color** = render duration (green fast → yellow → orange → red slow)
- Top component = your root (App/AppShell)
- Below = children that rendered

**Click on a component** to see:
- **Render duration** (how long it took)
- **Why it rendered**:
  - Props changed (shows which props)
  - State changed (shows which hooks)
  - Context changed (shows which context)
  - Parent component rendered (cascading render)

**C. Ranked View**

- Switch to **Ranked** tab (top-right)
- Shows components sorted by render time (slowest first)
- Look for:
  - Components that took > 10ms
  - Components that rendered many times (high commit count)

**D. Component Deep Dive**

Click on a slow component (e.g., `GraphCanvas`) to see:

**"Why did this render?"** section shows:
- ✅ Props changed: `whatIfDSL` (if props changed)
- ✅ Context changed (which context triggered it)
- ✅ Hook 3 changed (if state/hook changed)
- Or: "Parent component rendered" (cascading)

**Props comparison:**
- If props changed, you can click to see old vs new values
- **Critical**: If props are objects/arrays, you'll see if the reference changed but content stayed the same (identity churn!)

#### 8. Export Profile

- Click the **export icon** (disk with arrow)
- Saves as `.json` file
- Can reload later or share

### What to Look For (Pan Operation)

**Good pan profile:**
- 2-3 commits total (onMoveStart, onMove, onMoveEnd)
- Only `GraphCanvas` renders (no parent cascades)
- "Why": Parent rendered (ReactFlow internal viewport change)
- No `buildScenarioRenderEdges` or other expensive children
- Total time per commit: < 5ms

**Bad pan profile (what you likely have):**
- 10+ commits
- `AppShell`, `GraphEditor`, `GraphCanvas` all re-rendering
- `ConversionEdge` (all 10 edges) rendering
- "Why": Context changed, Props changed (object identities)
- Red/orange flame graph (slow renders)
- Total time per commit: > 20ms

---

## Tool 3: Chrome Performance Monitor (Real-Time)

### Quick Real-Time FPS Monitoring

#### 1. Open Performance Monitor
- Press `Ctrl+Shift+P` (Command Menu)
- Type "Show Performance Monitor"
- Press Enter

#### 2. Monitor During Pan
- You'll see a small overlay showing:
  - **CPU usage** (%)
  - **JS heap size** (memory)
  - **DOM Nodes** (count)
  - **JS event listeners** (count)
  - **Style recalcs / sec**
  - **Layouts / sec**

**What to watch:**
- **Layouts / sec** should be **0-1** during pan (viewport-only change)
  - If > 5: you're triggering layout thrashing
- **Style recalcs / sec** should be **0-2**
  - If > 10: DOM mutations during pan
- **CPU usage** should spike briefly then return to idle
  - If stays high: runaway computation

---

## Tool 4: Chrome Rendering Tab (Paint/Composite Analysis)

### See What's Being Repainted

#### 1. Open Rendering Tab
- Press `Ctrl+Shift+P` (Command Menu)
- Type "Show Rendering"
- Press Enter

#### 2. Enable Paint Flashing
- In Rendering tab, enable:
  - ✅ **Paint flashing** (green highlights show repainted areas)
  - ✅ **Layer borders** (orange/teal outlines show composited layers)
  - ✅ **Frame Rendering Stats** (FPS counter)

#### 3. Perform Pan and Observe
- **Green flashes** = areas being repainted
- **During pan, you should see:**
  - **Good**: No green flashes (viewport scroll only, no repaint)
  - **Bad**: Entire canvas flashing green (full repaint each frame)
  - **Very bad**: Individual edges/beads flashing green (element-level repaints)

---

## Combined Diagnostic Workflow

### Recommended Sequence

**Step 1: Quick FPS check** (Performance Monitor)
- Open Performance Monitor
- Perform pan
- Check FPS, layouts/sec, style recalcs/sec
- **If FPS drops or layouts > 0**: investigate further

**Step 2: Visual paint analysis** (Rendering Tab)
- Enable Paint Flashing
- Perform pan
- **If you see green flashes**: you're repainting when you shouldn't
- **What's being repainted?** Canvas? Edges? Beads? Whole app?

**Step 3: React component analysis** (React Profiler)
- Record a pan with React Profiler
- Check how many commits (should be 2-3)
- Check which components rendered (should be minimal)
- Check WHY they rendered (props? context? parent?)
- **Export the profile** for detailed analysis

**Step 4: Deep performance analysis** (Chrome Performance)
- Record a pan with Chrome Performance tab
- Find the long tasks (yellow blocks)
- Drill into Call Tree to find hot functions
- Check for purple blocks (layout) and green blocks (paint)
- **Export the profile** for detailed analysis

### Interpreting Combined Results

**Scenario A: Many commits in React Profiler + Many yellow blocks in Chrome Performance**
- **Problem**: Too many React re-renders
- **Cause**: Dependency instability, context churn, effect loops
- **Fix**: Stabilize dependencies, use version keys, reduce context re-emits

**Scenario B: Few commits in React Profiler, but long yellow blocks in Chrome Performance**
- **Problem**: Individual renders are too expensive
- **Cause**: Heavy computation in render path (not caching, expensive loops)
- **Fix**: Add memoization, caching, move work out of render

**Scenario C: Green flashes in Rendering tab + Green blocks in Performance**
- **Problem**: Unnecessary repaints
- **Cause**: DOM mutations during pan, or CSS triggering reflows
- **Fix**: Use transform/translate for movement, avoid forced layouts

**Scenario D: Purple blocks in Performance tab**
- **Problem**: Layout recalculation during pan
- **Cause**: Reading layout properties (`offsetWidth`, `getBoundingClientRect`) then writing (`style.width = ...`)
- **Fix**: Batch reads before writes, use cached layout values, avoid DOM queries in render

---

## Specific Analysis for Your Pan Issue

### What to Capture

Record **TWO profiles** of the same pan operation:

1. **Chrome Performance profile**:
   - Focus on: Main thread yellow/purple/green blocks
   - Export as: `pan-chrome-perf.json`

2. **React Profiler profile**:
   - Focus on: Number of commits, which components, why
   - Export as: `pan-react-prof.json`

### What to Look For in Chrome Performance

**A. Main Thread Activity**

Zoom into the pan interaction (click and drag on the timeline):

1. **Find the `onMoveStart` event**
   - Should be a small yellow block labeled something like "onMoveStart" or "mousedown"
   
2. **Find the `onMove` events**
   - Multiple yellow blocks during the drag
   - **Each should be < 5ms**
   - If > 10ms: click it and check Call Tree

3. **Find the `onMoveEnd` event**
   - Small yellow block at end of drag
   - Should be < 5ms

4. **Look for unexpected yellow blocks BETWEEN move events**
   - These are "extra work" that shouldn't be happening
   - Click them and check Call Tree to see what's running

**B. Call Tree for Long Tasks**

When you click a long yellow block and switch to Call Tree:

1. **Expand the tree** starting from top
2. Look for your code (not React internals):
   - `buildScenarioRenderEdges`
   - `buildBeadDefinitions`
   - `computeEffectiveEdgeProbability`
   - `computeVisibleStartOffsetForEdge`
   - `measureText`
   - `getPointAtLength`

3. **Check "Self Time" column**:
   - Time spent in that function alone (not children)
   - If high: that function is doing expensive work

4. **Check "Total Time" column**:
   - Time including all children
   - If high but Self Time is low: children are expensive

5. **Check "Count" column**:
   - How many times the function was called
   - If > 100 for a 10-edge graph: something is wrong

**C. Rendering/Layout Blocks (Purple)**

If you see purple blocks during pan:

1. Click the purple block
2. Check the label:
   - "Recalculate Style" = CSS selectors being re-evaluated
   - "Layout" = Browser calculating element positions
   - "Update Layer Tree" = GPU layer updates

3. **Forced reflow detection**:
   - Expand the purple block
   - Look for patterns like:
     - Read: `offsetWidth`, `getComputedStyle`, `getBoundingClientRect`
     - Then Write: `style.width = ...`, `classList.add(...)`
   - This is "layout thrashing"

### What to Look For in React Profiler

**A. Commit Count**

- Top of the screen shows commit bars
- **Count them**
- For a single pan:
  - **Good**: 2-3 commits
  - **Acceptable**: 4-5 commits
  - **Bad**: > 5 commits
  - **Very bad**: > 10 commits (you likely have this)

**B. Which Components Rendered**

Click on each commit and look at the flame graph:

1. **Hover over bars** to see component names and render times
2. **Look for red/orange bars** (slow components)
3. **Check the hierarchy**:
   - Does `AppShell` render? (it shouldn't during pan)
   - Does `GraphEditor` render? (maybe, if tab state updates)
   - Does `GraphCanvas` render? (yes, expected)
   - Do ALL `ConversionEdge` components render? (no! shouldn't unless edges changed)

**C. Why Did It Render?**

Click on a component (e.g., `GraphCanvas`) in the flame graph:

**Right panel shows:**
- "Rendered at X.Xs" (timestamp)
- "Render duration: Y.Yms"
- **"Why did this render?"**:
  - If it says **"Props changed"**: expand to see which props
    - Look for object/array props that changed identity
    - Example: `graph: [object] → [object]` (same content, different reference)
  - If it says **"Context changed"**: which context?
    - Example: `GraphStoreContext`, `ScenariosContext`
  - If it says **"Hook 3 changed"**: which useState/useReducer
  - If it says **"Parent component rendered"**: cascading re-render

**D. Ranked View Analysis**

Switch to **Ranked** tab:

1. Sort by **"Render duration"**
2. Top components are your bottlenecks
3. Click each one to see:
   - How many times it rendered (count)
   - Total time across all renders
   - Why it rendered each time

**Example findings:**
- `GraphCanvas` rendered 8 times in 3 seconds
- Each time: "Context changed: ScenariosContext"
- Means: `ScenariosContext` is re-emitting on every frame

---

## Exporting and Sharing Profiles

### From Chrome Performance Tab

1. Click the **Download** icon (⬇️) in Performance tab
2. Save as `pan-interaction-chrome.json`
3. To reload:
   - Click **Upload** icon (⬆️)
   - Select the `.json` file

### From React DevTools Profiler

1. After recording, click the **export icon** (right side of toolbar)
2. Save as `pan-interaction-react.json`
3. To reload:
   - Click the **import icon** (left side of toolbar)
   - Select the `.json` file

### Analyzing Exported Profiles

You can:
- Load them in DevTools on another machine
- Compare before/after profiles (after implementing fixes)
- Share with others for collaborative debugging
- Process programmatically (JSON format is documented)

---

## Quick Reference: Key Indicators

### Chrome Performance Tab

| What You See | What It Means | Action |
|--------------|---------------|--------|
| Many wide yellow blocks | Too much JS execution | Find hot functions in Call Tree |
| Purple blocks during pan | Layout recalculation | Find forced reflows, batch DOM reads/writes |
| Green blocks during pan | Repainting | Find what's changing visually, use CSS transforms |
| Red bars in FPS meter | Dropped frames | Focus on frames > 50ms |
| Repeated function calls (Count > 100) | Loop or lack of caching | Add memoization/caching |
| Deep call stacks (> 20 levels) | Inefficient recursion | Optimize algorithm |

### React DevTools Profiler

| What You See | What It Means | Action |
|--------------|---------------|--------|
| > 5 commits per pan | Too many re-renders | Stabilize props/context, fix effect loops |
| "Props changed: graph" but same content | Identity churn | Use version numbers, not object deps |
| "Context changed: X" on every commit | Context re-emitting | Fix context to only emit on semantic changes |
| Parent cascades (AppShell → GraphEditor → GraphCanvas) | Unnecessary parent re-renders | Isolate state, use React.memo |
| All edges rendering on pan | Edges rebuilding unnecessarily | Check renderEdges memo deps |
| Red/orange bars (> 20ms) | Expensive renders | Find slow components in Ranked view |

---

## Action Items for Your Immediate Issue

### Right Now: Capture Two Profiles

1. **Open your app with the graph loaded**
2. **Chrome Performance**: Record + pan + stop → export as `current-pan-chrome.json`
3. **React Profiler**: Record + pan + stop → export as `current-pan-react.json`

### Then: Answer These Questions

**From Chrome Performance:**
- How many long tasks (> 10ms) during the ~2 second pan?
- What functions dominate the Call Tree (top 5 by Total Time)?
- Are there purple (layout) or green (paint) blocks during pan?
- How much total JS time was spent?

**From React Profiler:**
- How many commits total?
- Which components rendered on EVERY commit?
- What's the most common "Why did this render?" reason?
- Which component took the longest (Ranked view)?

### Expected Findings (Based on Current Logs)

**Chrome Performance likely shows:**
- 10-15 long yellow blocks (each 3-7ms)
- Functions: `buildScenarioRenderEdges`, `buildBeadDefinitions`, `useMemo` recomputes
- Possibly some purple blocks (layout recalc from DOM queries in beads)
- Total JS time: 50-100ms (should be < 20ms)

**React Profiler likely shows:**
- 8-12 commits
- Components: `AppShell`, `GraphEditor`, `GraphCanvas`, all 10 `ConversionEdge`s
- Why: "Context changed: ScenariosContext" or "Props changed: graph"
- Slowest: `GraphCanvas` (4-7ms) or `ConversionEdge` (cumulative)

Once you have the profiles, we can:
1. Analyze them to confirm the exact problem
2. Prioritize the top 3 issues by impact
3. Implement targeted fixes
4. Re-profile to validate improvements

---

## Pro Tips

### Chrome Performance

- **Use "Screenshots" setting**: Helps correlate visual issues with profiler data
- **Zoom in**: Click and drag on the timeline to zoom to specific time ranges
- **Use keyboard shortcuts**: `W/S` to zoom in/out, `A/D` to pan timeline
- **Compare before/after**: Record baseline, implement fix, record again, compare side-by-side
- **Focus on "Self Time"**: This shows where work is actually happening, not just call stack overhead

### React Profiler

- **Enable "why did render"**: Critical for diagnosing unnecessary renders
- **Use Ranked view**: Fastest way to find the slowest components
- **Click through commits**: See which components render on each commit (pattern detection)
- **Check "Did not render"**: Shows components that were skipped (good!)
- **Compare commit counts**: Before/after fixes should show fewer commits

### General

- **Record SHORT interactions**: 3-5 seconds max, easier to analyze
- **Disable browser extensions**: Can interfere with profiling
- **Use Incognito/Private mode**: Clean environment without extension overhead
- **Close other tabs**: Reduce system noise
- **Repeat 3 times**: Ensure results are consistent, not one-off flukes
- **Start simple**: Profile pan first, then zoom, then selection, etc.

---

## Common Pitfalls to Avoid

1. **Recording too long** (> 10 seconds):
   - Profiler data becomes huge and hard to analyze
   - Keep it short and focused

2. **Not waiting before/after interaction**:
   - You need baseline and aftermath to see the complete picture
   - Wait 1 second before and after

3. **Multiple interactions in one recording**:
   - Pan + zoom + click all in one profile = confusing
   - **One interaction per recording**

4. **Ignoring the "Why"** in React Profiler:
   - The "why did render" is THE most important data
   - Always check it for unexpected renders

5. **Focusing on total time instead of count × time**:
   - A function taking 0.5ms but called 100 times = 50ms total
   - Look at both "Self Time" AND "Count" in Call Tree

---

## Console Commands for Quick Checks

After profiling, use these in the browser console:

```javascript
// Check React DevTools Profiler data (if available)
window.__REACT_DEVTOOLS_GLOBAL_HOOK__

// Force a profile export from our custom logger (once implemented)
window.__exportDiagnostics()

// Get diagnostic log entries
window.__getDiagnostics()

// Clear diagnostic logs
window.__clearDiagnostics()

// Manually trigger GC to see if memory is the issue
if (window.gc) window.gc(); // Requires Chrome launched with --js-flags="--expose-gc"
```

---

## Next Steps After Capturing Profiles

1. **Review profiles yourself first**:
   - Use the checklists above
   - Note obvious issues

2. **Share findings**:
   - Export both Chrome and React profiles
   - Note specific commits/tasks that are problematic
   - Provide context (what were you doing, what did you expect)

3. **Implement fixes based on data**:
   - Don't guess - let the profiler tell you where time is going
   - Fix the biggest bottleneck first
   - Re-profile after each fix to validate

4. **Build regression tests**:
   - After fixing, keep the "good" profiles
   - Re-profile periodically to ensure no regressions
   - Automate with performance budgets (if needed)

---

## Summary: What You Need to Do Right Now

### Immediate Actions (5 minutes)

1. **Open your app** with the problematic graph
2. **Open Chrome DevTools** → Performance tab
3. Click **Record** ⏺️
4. **Wait 1 second**
5. **Pan the canvas once** (single drag gesture)
6. **Wait 1 second**
7. Click **Stop** ⏹️
8. **Export** the profile → save as `pan-chrome.json`

9. **Switch to React DevTools** → ⚛️ Profiler tab
10. Click **Record** ⏺️
11. **Wait 1 second**
12. **Pan the canvas once** (same gesture)
13. **Wait 1 second**
14. Click **Stop** ⏹️
15. **Export** the profile → save as `pan-react.json`

### Analysis (10 minutes)

**In Chrome Performance:**
- Count the yellow blocks during pan: _____ (should be 2-3, likely 10+)
- Check longest yellow block duration: _____ ms (should be < 5ms, likely 10-50ms)
- Expand longest block → Call Tree → note top 3 functions by Total Time
- Check for purple blocks: Yes/No (should be No)
- Check for green blocks: Yes/No (should be No)

**In React Profiler:**
- Count commits: _____ (should be 2-3, likely 8-15)
- Note components that rendered on EVERY commit: _____
- Click slowest component → note "Why did this render?": _____
- Note any "Props changed: [object]" where content didn't actually change

### Report Findings

Based on your analysis:

**Problem summary:**
- "During a simple pan, I see X commits in React Profiler (expected 2-3)"
- "Chrome Performance shows Y long tasks averaging Z ms each"
- "Top bottleneck functions: A, B, C (from Call Tree)"
- "React Profiler shows components rendering due to: [context change / props identity churn / effect loop]"

This data will pinpoint the **exact** problem(s) and allow for **targeted** fixes.

