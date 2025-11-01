# All Background Processes, Long Tasks, and Continuous Updates

## Hypothesis: Long-running or incomplete background tasks are causing DOM slowdown

---

## 🔴 CATEGORY 1: ReactFlow Rendering & Layout Engine

### ReactFlow's Internal Render Loop
**What**: ReactFlow continuously monitors and updates node/edge positions, handles, etc.
**How often**: On every pan, zoom, node drag, layout shift
**Can hang**: YES - if it's recalculating layout continuously
**Detection**: Look for `react-flow__renderer` in Performance tab
**Suspicious if**:
- ReactFlow is rendering 60fps even when nothing is moving
- Edge paths are being recalculated continuously
- Node positions are being updated in a loop

### Edge Width Calculations
**Location**: GraphCanvas.tsx, line ~1580s (What-If recompute)
**What**: Recalculates edge widths based on probabilities, what-if overrides, mass generosity
**Triggers on**: 
- `overridesVersion` changes
- `edges.length` changes
- `nodes` array reference changes
**Can hang**: YES - if edges array keeps getting new references
**Current status**: Throttled to one per animation frame, but...
**SUSPICIOUS**: Uses `edges.length` as dependency - if edges array is being recreated constantly, this loops
**Check**: Add `console.log` to see if it fires more than once per user action

```typescript
// Line 1582
useEffect(() => {
  console.log(`[${new Date().toISOString()}] [GraphCanvas] useEffect#GC1: What-If recompute triggered (edges=${edges.length})`);
  if (edges.length === 0) return;
  if (recomputeInProgressRef.current) {
    console.log(`[${ts()}] [GraphCanvas] what-if recompute skipped (in progress)`);
    return;
  }
  // ... lots of calculation ...
}, [overridesVersion, whatIfAnalysis, setEdges, nodes, edges.length]);
```

**Problem**: If `nodes` or `edges.length` changes due to ReactFlow internal updates, this could loop

### Edge Offset Calculations (Mass-based scaling)
**Location**: GraphCanvas.tsx, `calculateEdgeOffsets` function
**What**: When using mass-based scaling, calculates perpendicular offsets for parallel edges
**Complexity**: O(n²) - checks all edge pairs
**Can hang**: YES - if graph has many edges and this runs repeatedly
**Current status**: Part of What-If recompute (throttled)
**SUSPICIOUS**: Large graphs with 100+ edges could take significant time

### Edge Handle Visibility Updates
**Location**: GraphCanvas.tsx, line ~1641
**What**: Shows/hides connection handles based on hover state
**Triggers on**: Dependency array unknown (NOT INSTRUMENTED)
**Can hang**: Maybe - if handle visibility triggers layout shift which triggers more handle updates
**Check**: Instrument this effect

---

## 🟠 CATEGORY 2: Graph Store Synchronization Loops

### ReactFlow → Graph Store Sync
**Location**: GraphCanvas.tsx, line ~1655 (useEffect#GC2)
**What**: Syncs ReactFlow node/edge changes back to graph store
**Triggers on**: `nodes`, `edges` dependency (ReactFlow state)
**Can hang**: YES - THIS IS A PRIME SUSPECT
**Why suspicious**:
```typescript
useEffect(() => {
  console.log(`[${new Date().toISOString()}] [GraphCanvas] useEffect#GC2: Sync ReactFlow→Store triggered`);
  if (!graph) return;
  if (visualWhatIfUpdateRef.current) {
    console.log(`[${new Date().toISOString()}] [GraphCanvas] skip store sync (what-if visual update)`);
    return;
  }
  if (isSyncingRef.current) {
    return;
  }
  // ... syncs to graph store ...
}, [nodes, edges, ...]);
```

**Problem**: 
1. ReactFlow updates `nodes` array → triggers this effect
2. Effect updates graph store → triggers Graph→ReactFlow sync
3. Graph→ReactFlow sync updates `nodes` array → back to step 1
4. **Infinite loop** if sync guards fail

**Check**: Count how many times `isSyncingRef.current` is true vs false

### Graph Store → ReactFlow Sync
**Location**: GraphCanvas.tsx, line ~949, ~1181 (two separate effects)
**What**: Syncs graph store changes to ReactFlow nodes/edges
**Triggers on**: `graph` object reference
**Can hang**: YES - if graph object is being recreated constantly
**Why suspicious**:
- Graph store uses Zustand
- Zustand creates new object reference on every update
- If any component is updating graph in a loop, this fires in a loop

**Check**: Add counter to see how many times `graph` reference changes per second

### File Data → Graph Store Sync
**Location**: GraphEditor.tsx, line ~646 (useEffect#12)
**What**: Syncs file data to graph store when file changes
**Triggers on**: `data` (file content)
**Can hang**: YES - if file data keeps updating
**Why suspicious**:
- Uses `syncingRef` to prevent loops
- If `syncingRef` timing is off, could loop
- File data could be updated by external process

**Current status**: INSTRUMENTED but not logging
**Check**: Look for rapid fire of this effect

### Graph Store → File Data Sync
**Location**: GraphEditor.tsx, line ~699 (useEffect#13)
**What**: Syncs graph store changes back to file
**Triggers on**: `graph`, `data`
**Can hang**: YES - classic bidirectional sync loop
**Why suspicious**:
- Compares `graph` vs `data` using JSON.stringify
- If comparison fails (e.g., object order), loops forever
- Updates file → triggers file→store sync → loops

**Current status**: INSTRUMENTED but not logging
**Check**: Is it looping with useEffect#12?

---

## 🟡 CATEGORY 3: rc-dock Internal Operations

### rc-dock's Internal ResizeObserver
**Location**: node_modules/rc-dock (cannot instrument directly)
**What**: rc-dock uses ResizeObserver to track panel size changes
**Can hang**: YES - THIS IS A TOP SUSPECT
**Why suspicious**:
- We disabled OUR ResizeObserver in GraphEditor, but rc-dock has its own
- When native `<select>` dropdown opens, it causes layout reflow
- rc-dock's ResizeObserver fires on reflow
- ResizeObserver callback might trigger more layout changes
- **Infinite observer loop**

**Evidence**:
- User gets lag when interacting with native select
- NO React logging (our code isn't running)
- Disabling our ResizeObserver didn't fix it
- rc-dock has two nested instances (outer AppShell + inner GraphEditor)

**Check**: Use Chrome DevTools Performance tab → Look for "ResizeObserver" in call stack

### rc-dock's Internal MutationObserver
**Location**: node_modules/rc-dock
**What**: rc-dock might use MutationObserver to track DOM changes
**Can hang**: YES - if observing entire document
**Check**: Search rc-dock source code for `MutationObserver`

### rc-dock's Layout Recalculation
**Location**: node_modules/rc-dock
**What**: Recalculates panel sizes when layout changes
**Triggers on**: Panel resize, drag, float, maximize
**Can hang**: YES - if layout calculation triggers more layout events
**Why suspicious**:
- We have TWO rc-dock instances (nested)
- Inner dock changes might trigger outer dock recalc
- Outer dock recalc might trigger inner dock recalc
- **Ping-pong loop**

**Check**: `performance.now()` timestamps around dock operations

---

## 🟢 CATEGORY 4: Browser-Level Rendering

### CSS calc() Expressions
**Location**: All CSS files, particularly in sidebar and dock styling
**What**: Browser recalculates CSS expressions on layout changes
**Can hang**: YES - if calc() depends on dynamic values that keep changing
**Where to look**:
- `GraphEditor.css` - sidebar positioning
- `dock-theme.css` - rc-dock panel sizing
- Any `calc()` expressions with percentages or viewport units

**Example suspicious calc()**:
```css
.sidebar {
  width: calc(100vw - 300px - var(--nav-width));
  /* If --nav-width updates continuously, this recalcs continuously */
}
```

**Check**: Temporarily replace all `calc()` with fixed pixel values

### CSS :has() Selectors
**Location**: GraphEditor.css (we added these for hiding tab bars)
**What**: Browser recalculates :has() on DOM changes
**Can hang**: YES - :has() is expensive if DOM updates frequently
**Example**:
```css
.dock-panel:has(.canvas-tab-content) .dock-bar {
  display: none !important;
}
```

**Check**: Temporarily remove all `:has()` selectors

### Fixed/Absolute Positioning Conflicts
**Location**: Sidebar, dropdown, panels all use fixed/absolute
**What**: Browser struggles to calculate stacking context and positioning
**Can hang**: YES - especially with nested positioned elements
**Layers involved**:
- AppShell (position: relative)
- Navigator (position: absolute)
- rc-dock outer (position: relative)
- rc-dock inner (position: relative)
- Sidebar (position: absolute)
- Icon bar (position: absolute)
- Hover preview (position: absolute)
- Native select dropdown (position: fixed by browser)

**Problem**: Native select dropdown might be in different stacking context, causing browser to recalculate entire positioning tree on every frame

**Check**: Simplify positioning - move everything to flexbox

### Paint/Composite Layers
**Location**: All animated or positioned elements
**What**: Browser creates composite layers for hardware acceleration
**Can hang**: YES - if layer boundaries keep changing
**Suspects**:
- rc-dock panels (transform-based animations)
- Sidebar (transition on open/close)
- ReactFlow canvas (transform for pan/zoom)
- Many positioned overlays (multiple stacking contexts)

**Check**: DevTools → Rendering → Layer borders

---

## 🔵 CATEGORY 5: IndexedDB & File Operations

### Tab State Persistence
**Location**: TabContext.tsx, persists to IndexedDB
**What**: Saves tab state (sidebar, what-if, etc.) to IndexedDB
**Frequency**: On every state change (debounced)
**Can hang**: Maybe - if IndexedDB is slow or corrupted
**Why suspicious**:
- Multiple tabs might be writing simultaneously
- IndexedDB operations are async but can block main thread if queue is full
- Corrupted database can cause hangs

**Check**: Temporarily disable IndexedDB writes

### Layout State Persistence
**Location**: AppShell.tsx, layoutService
**What**: Saves rc-dock layout to IndexedDB
**Frequency**: On layout change (debounced 1000ms)
**Can hang**: Maybe - if layout changes rapidly
**Why suspicious**:
- Layout might be changing continuously due to rc-dock loop
- Each change queues an IndexedDB write
- Queue might be backing up

**Check**: Look for rapid `layoutService.saveLayout` calls

### File State Subscription
**Location**: TabContext.tsx, useFileState hook (line 1294)
**What**: Subscribes to file changes via fileRegistry
**Can hang**: YES - if file notifications fire in a loop
**Why suspicious**:
- File→Store and Store→File sync might be triggering notifications
- Each notification triggers subscriber callbacks
- Subscribers might trigger more file updates

**Check**: Add logging to fileRegistry.subscribe callback

---

## ⚪ CATEGORY 6: Third-Party Libraries

### ReactFlow's Internal Operations
**What**: ReactFlow has many internal effects for:
- Viewport updates (pan/zoom)
- Node selection
- Edge routing
- Handle connections
**Can hang**: YES - ReactFlow is complex
**Check**: Use React DevTools Profiler to see ReactFlow components

### Zustand Store Updates
**What**: Graph store uses Zustand for state management
**Can hang**: Unlikely - Zustand is fast
**But**: If many components subscribe and graph updates frequently, could cause cascade
**Check**: Count Zustand listener callbacks

### d3-dag (Dagre layout)
**What**: Used for auto-layout
**Can hang**: YES - layout calculation is O(n²) or worse
**When**: Only when auto-layout is explicitly triggered
**Unlikely**: User isn't triggering auto-layout
**But**: Could be running in background if triggered earlier and never completed

---

## 💀 THE MOST LIKELY CULPRITS (Ranked by Evidence)

### #1: rc-dock's Internal ResizeObserver Loop (90% confidence)
**Evidence**:
- ✅ NO React code logging (issue is outside React)
- ✅ Disabling our ResizeObserver didn't fix it
- ✅ Native select causes layout reflow
- ✅ We have TWO nested rc-dock instances
- ✅ Issue is generic (not specific to what-if)
**Mechanism**: Native select reflow → rc-dock ResizeObserver → panel size recalc → DOM mutation → reflow → loop

### #2: ReactFlow Node/Edge Array Recreation Loop (70% confidence)
**Evidence**:
- ✅ NO React logging (our useEffects not firing, but ReactFlow internal might be)
- ✅ Edge width calculation depends on `edges.length` and `nodes`
- ✅ ReactFlow is known to recreate arrays on internal updates
**Mechanism**: ReactFlow internal → nodes array new ref → our effect → setEdges → ReactFlow internal → loop

### #3: Graph Store ↔ File Data Bidirectional Sync Loop (50% confidence)
**Evidence**:
- ✅ We have bidirectional sync (file→store and store→file)
- ✅ Both instrumented but NOT logging (suspicious - might be too fast to log?)
- ✅ Uses `syncingRef` guard which could fail
**Mechanism**: Store update → file update → store update → file update → loop

### #4: CSS Calc() + :has() Recalculation Storm (40% confidence)
**Evidence**:
- ✅ Browser-level issue (no React logging)
- ✅ Complex nested positioning
- ✅ Many dynamic calc() expressions
**Mechanism**: Layout shift → calc() recalc → :has() recalc → new layout → loop

### #5: IndexedDB Write Queue Backup (20% confidence)
**Evidence**:
- ⚠️ Would cause lag but not blocking
- ⚠️ Usually manifests as async delays, not sync blocks
**Mechanism**: Rapid state changes → IndexedDB queue full → main thread blocks waiting for I/O

---

## 🎯 DIAGNOSTIC PLAN (Do in Order)

### 1. Profile with Chrome DevTools (2 minutes)
**What**: Performance tab → Record → Interact with dropdown → Stop
**Look for**:
- Long tasks (>50ms)
- "ResizeObserver" in call stack
- Repeated function calls in tight loop
- Layout thrashing (many "Layout" events)
- "Recalculate Style" happening repeatedly

### 2. Check React DevTools Profiler (1 minute)
**What**: Profile → Record → Interact → Stop
**Look for**:
- Components rendering 100+ times
- ReactFlow components in a render loop
- Any component rendering continuously

### 3. Add Frame Counter to Console (30 seconds)
```javascript
// Paste in browser console
let frameCount = 0;
setInterval(() => {
  console.log(`Frames in last second: ${frameCount}`);
  frameCount = 0;
}, 1000);
requestAnimationFrame(function count() {
  frameCount++;
  requestAnimationFrame(count);
});
```
**If showing 60fps when idle**: Something is rendering continuously

### 4. Temporarily Disable rc-dock (5 minutes)
**What**: Comment out inner rc-dock in GraphEditor, render sidebar as plain div
**If it fixes the issue**: rc-dock is the culprit

### 5. Check for ResizeObserver in node_modules
```bash
grep -r "ResizeObserver" node_modules/rc-dock/
```

### 6. Add Performance Markers Around Key Operations
```typescript
// In GraphCanvas edge width calculation
performance.mark('edge-calc-start');
// ... calculation ...
performance.mark('edge-calc-end');
performance.measure('edge-calc', 'edge-calc-start', 'edge-calc-end');
```

### 7. Count Array Reference Changes
```typescript
// In GraphCanvas
const prevNodesRef = useRef(nodes);
const prevEdgesRef = useRef(edges);
useEffect(() => {
  if (prevNodesRef.current !== nodes) {
    console.log(`[${new Date().toISOString()}] NODES ARRAY NEW REFERENCE`);
  }
  if (prevEdgesRef.current !== edges) {
    console.log(`[${new Date().toISOString()}] EDGES ARRAY NEW REFERENCE`);
  }
  prevNodesRef.current = nodes;
  prevEdgesRef.current = edges;
}, [nodes, edges]);
```

---

## 🧠 FINAL HYPOTHESIS

**Most Likely Scenario**: 
rc-dock's internal ResizeObserver (in node_modules) is in a loop. When you interact with the native `<select>`, it causes a layout reflow. rc-dock's ResizeObserver fires, recalculates panel sizes, updates DOM, causes another reflow, fires observer again, infinite loop. Main thread is blocked in ResizeObserver callback hell.

**Why our logging doesn't show it**: 
ResizeObserver callbacks run BEFORE React effects. The browser is stuck in observer callbacks and never gets to the React render cycle where our logging would happen.

**Why it's generic**:
ANY interaction that causes layout reflow triggers it (hover, click, select, focus, etc.)

**How to confirm**:
Chrome DevTools Performance profile will show ResizeObserver callbacks dominating the timeline.

