b# Atomic Decoration Restore Plan (Chevrons & Beads) – ReactFlow‑Safe Design

## 1. Problem Restatement (Narrow Scope)

We are **not** trying to:

- Minimize the number of frames it takes for chevrons/beads to fully appear, or
- Avoid doing a large amount of browser paint work in a single frame at all costs.

We **are** trying to ensure that:

> **When pan/zoom ends and decorations are restored, ReactFlow and the broader app do not interfere with that restoration commit.**  
> i.e. no ReactFlow graph state changes, no Tab/GraphStore/what‑if cascades, and no “second” React commit that interrupts or overwrites the restoration frame.

You explicitly accept:

- “All chevrons and beads land at once”, as long as:
  - ReactFlow’s `CanvasInner` / `EdgeRenderer` / `NodeRenderer` are **not** being re‑run as part of that restore, and
  - Tab/Navigator/AppShell cascades are **not** scheduled into the same frame window.

This document focuses **only** on that goal (call it **Goal #1**), **without** introducing incremental restoration as a requirement.

---

## 2. Current Behavior and Failure Mode (as Observed)

### 2.1 What we currently do at pan end

In `GraphCanvas.tsx` today, the pan end path looks roughly like:

- On `onMoveStart`:
  - Set `isPanningOrZooming = true`.
  - Set `decorationsEnabled = false` (suppress chevrons + beads).

- On `onMoveEnd` (for “real” movement):
  - Debounce for `DECORATION_RESTORE_DELAY` (e.g. 80ms).
  - Call `flushSync(() => setDecorationsEnabled(true));`
    - This causes:
      - `shouldSuppressDecorations` (`isPanningOrZooming || !decorationsEnabled`) to flip.
      - `ChevronClipPaths` to mount again with full `bundles`.
      - Beads to become eligible to render again.
  - After that, we **also**:
    - Save viewport (`rfViewport`) via `tabOperations.updateTabState`.
    - Allow various contexts (TabContext, GraphStore, WhatIf, etc.) to see the new state and potentially schedule work.

### 2.2 Why this can blow the final frame

Profiling shows:

- The restoration `flushSync` itself is heavy but survivable.
- What often kills the frame is a **second wave of work**:
  - ReactFlow internals (`CanvasInner`, `EdgeRenderer`, `MiniMap`) re‑rendering in response to props/context changes.
  - `TabContext.updateTabState` and `fileRegistry.notifyListeners` cascades causing GraphEditor/AppShell/Nav to re‑render.
  - What‑if / scenario recomputes (`buildScenarioRenderEdges`, etc.) landing in the same window.

In other words:

- We are *already* doing the “all at once overlay restore” you want,
- But we are **not** protecting that commit from:
  - ReactFlow graph state churn, and
  - App‑level cascades that get co‑scheduled with decorations.

---

## 3. Design Goal: “Atomic Decoration Restore Window”

We introduce the concept of an **Atomic Decoration Restore Window (ADR window)**:

> A short period (e.g. 0–200ms) immediately following pan/zoom where:
> - We perform one decoration restore commit (chevrons + beads).
> - No ReactFlow graph state changes (no `setNodes`, `setEdges`, no edge/node `data` mutations that ReactFlow treats as graph changes).
> - No tab/graph file persistence or what‑if/scenario writes.
\> - No other React commits (esp. AppShell/Menu/Nav/Navigator) are scheduled *because of* this restoration.

We don’t care if the browser then takes 1–2 vsyncs to paint all the SVG/DOM work; we **do** care that React and our own context layers are not fighting that process in the same window.

---

## 4. Invariants for a Safe Atomic Restore

To make the ADR window real, we need these invariants:

1. **ReactFlow graph state invariants**
   - During the ADR window:
     - `nodes` and `edges` **do not change** because of decoration toggles.
     - We do **not** call `setNodes` / `setEdges` in order to show/hide chevrons or beads.
     - We do **not** change any `edge.data` fields that ReactFlow uses to decide whether to re‑render `CanvasInner`/`EdgeRenderer`/`NodeRenderer`/`MiniMap`.

2. **Tab and persistence invariants**
   - During ADR:
     - No `TabContext.updateTabState` calls triggered by “pan ended” logic.
     - No `GraphStoreProvider` persistence to tabs (e.g. “window” / “lastAggregatedWindow” writes) driven by decoration restoration.
     - No `fileRegistry.updateFile` / `notifyListeners` for the graph file due to restoration.

3. **What‑if / scenario invariants**
   - During ADR:
     - No scenario visibility/state changes triggered by decoration toggles.
     - No what‑if recomputes (`buildScenarioRenderEdges` triggered by a change in overridesVersion/DSL) caused by restoration.

4. **Scope of changes**
   - The **only** state we mutate in ADR is:
     - A small number of local decoration flags in `GraphCanvas` (e.g. `decorationsVisible`, `chevronsVisible`, `beadsVisible`), and
     - Overlay components that directly depend on those flags (`ChevronClipPaths`, `EdgeBeadsRenderer`).

---

## 5. Architectural Changes to Achieve Goal #1

### 5.1 Separate “graph state” from “decoration state”

**Today:**

- Suppression/restoration is expressed as:
  - `shouldSuppressDecorations = isPanningOrZooming || !decorationsEnabled;`
  - `shouldSuppressDecorations` is referenced when building edges and bundles.
  - Edge `data` sometimes carries decoration‑related flags (e.g. `isPanningOrZooming`) which flow into `ConversionEdge` / `EdgeBeadsRenderer`.

**Problem:**

- When we flip `decorationsEnabled`, we rebuild edges and bundles in ways that ReactFlow sees as graph updates, triggering heavy commits.

**Proposal:**

1. Introduce a **pure decoration state slice** in `GraphCanvas` that is *not* baked into `nodes`/`edges`:

   ```typescript
   const [decorationsVisible, setDecorationsVisible] = React.useState(true);  // master flag
   const [chevronsVisible, setChevronsVisible] = React.useState(true);
   const [beadsVisible, setBeadsVisible] = React.useState(true);
   ```

2. Use these flags **only in overlay and bead components**, not when constructing `nodes`/`edges` arrays:

   - `ChevronClipPaths`:
     - Gated by `chevronsVisible && !NO_CHEVRONS_MODE`.
   - `EdgeBeadsRenderer`:
     - Gated by `!isPanningOrZooming && beadsVisible` (see 5.3).

3. Ensure that **when we flip these flags during ADR**, they:

   - Do **not** enter `TabContext.editorState`.
   - Do **not** cause `setNodes`/`setEdges` or any ReactFlow context provider to see new graph props.

Implementation detail:

- Where we currently pass suppression flags via `edge.data` (e.g. `isPanningOrZooming`), we keep that **only for the pan‑time suppression of beads**, not for post‑pan restoration.
- Restoration uses the separate `chevronsVisible` / `beadsVisible` flags that are consumed directly by the overlay components, not via edge data.

### 5.2 Ensure chevrons restore without touching ReactFlow graph

**Current pattern**:

- `groupEdgesIntoBundles` is called with `edgesWithOffsetData` and the result is used to render `<ChevronClipPaths bundles={edgeBundles} />`.
- We already have a path where we pass `[]` for `bundles` to suppress chevrons.
- But that computation is typically embedded in the `renderEdges` pipeline that may depend on decoration flags.

**Change**:

1. Compute “full chevron bundles” based only on **stable graph inputs**:

   ```typescript
   const chevronBundles = React.useMemo(
     () => (useSankeyView || NO_CHEVRONS_MODE)
       ? []
       : groupEdgesIntoBundles(edgesWithOffsetData, nodesWithSelection),
     [useSankeyView, NO_CHEVRONS_MODE, edgesWithOffsetData, nodesWithSelection]
   );
   ```

2. `chevronBundles` should **not** depend on `decorationsVisible` or pan suppression flags.

3. `ChevronClipPaths` uses:

   ```tsx
   {chevronsVisible && !NO_CHEVRONS_MODE && (
     <Panel position="top-left" style={{ pointerEvents: 'none' }}>
       <ChevronClipPaths
         bundles={chevronBundles}
         nodes={nodes}
         frameId={renderFrameRef.current}
       />
     </Panel>
   )}
   ```

4. During the ADR window we only flip `chevronsVisible` from `false` → `true` inside one `flushSync`, and ReactFlow’s graph data does not change.

Result:

- A single overlay commit mounts `ChevronClipPaths` with `chevronBundles` that were already computed from graph state, without rebuilding the graph or edges.

### 5.3 Beads: pan suppression vs restore visibility

We split bead logic into **two axes**:

1. **Pan‑time suppression** (smooth interactions, already working):
   - Controlled by `isPanningOrZooming` (fed from ReactFlow events).
   - This is transient and can legitimately flow through edge `data` because pan frames are already smooth.

2. **Post‑pan visibility** (the restoration we care about):
   - Controlled by a separate `beadsVisible` flag in `GraphCanvas`, not persisted anywhere.
   - Only toggled once per ADR window (`false → true`).

**Edge path**:

- During pan:

  ```typescript
  // In buildScenarioRenderEdges / edge data:
  data: {
    ...edge.data,
    isPanningOrZooming, // for bead suppression during pan
  }
  ```

- In `ConversionEdge`:

  ```tsx
  const isInteracting = data?.isPanningOrZooming ?? false;

  <EdgeBeadsRenderer
    ...
    isPanningOrZooming={isInteracting}
    beadsVisible={beadsVisible}  // from GraphCanvas via context/prop
  />
  ```

- In `EdgeBeadsRenderer`:

  ```typescript
  if (isPanningOrZooming || !beadsVisible) {
    return null;
  }
  ```

**ADR behavior**:

- During pan: `beadsVisible` is irrelevant; `isPanningOrZooming` suppresses beads.
- At pan end, inside ADR window: we flip `beadsVisible` **once** from `false` → `true` via `flushSync`, causing only beads to render, without touching edges.

### 5.4 Blocking cascades: TabContext, GraphStore, What‑if

To prevent app‑level cascades during ADR:

1. Define a small, local `decorationRestoreInProgressRef` in `GraphCanvas`:

   ```typescript
   const decorationRestoreInProgressRef = React.useRef(false);
   ```

2. Before we call the overlay restore `flushSync`, set:

   ```typescript
   decorationRestoreInProgressRef.current = true;
   ```

3. Expose this as a **global diagnostic/guard flag** (we already did something similar for logging):

   ```typescript
   if (typeof window !== 'undefined') {
     (window as any).__DAGNET_DECORATION_RESTORE_ACTIVE = true;
   }
   ```

4. Inside critical cascaders (and only there), short‑circuit when this flag is set:

   - `TabContext.updateTabState`:

     ```typescript
     const shouldDeferForDecorations =
       typeof window !== 'undefined' &&
       (window as any).__DAGNET_DECORATION_RESTORE_ACTIVE;

     if (shouldDeferForDecorations) {
       // Option A: no‑op
       // Option B: queue the update in a ref to apply after window ends
       return;
     }
     ```

   - `GraphStoreProvider` persistence (window/lastAggregatedWindow writes).
   - Any “save viewport after pan end” code.

5. After the single overlay `flushSync` is complete, end the ADR window:

   ```typescript
   flushSync(() => {
     setChevronsVisible(true);
     setBeadsVisible(true);
   });

   decorationRestoreInProgressRef.current = false;
   if (typeof window !== 'undefined') {
     (window as any).__DAGNET_DECORATION_RESTORE_ACTIVE = false;
   }
   ```

6. Any persisted state updates (viewport, scenario visibility, etc.) that are triggered by pan end should:

   - Either be skipped entirely, or
   - Be scheduled via `setTimeout`/`requestAnimationFrame` **after** the ADR window is cleared.

This ensures that even if some code path accidentally calls `updateTabState` during ADR, it will either be a no‑op or deferred until after the restore, preventing a second ReactFlow/AppShell commit from landing inside the same visual window.

---

## 6. ADR Implementation Sketch in `GraphCanvas`

Putting the pieces together:

1. **During pan (`onMoveStart`)**:

   - `setIsPanningOrZooming(true)`
   - `setChevronsVisible(false)`
   - `setBeadsVisible(false)`

2. **At pan end (`onMoveEnd`, movement case)**:

   - Debounce (e.g. 80ms) to let ReactFlow settle.
   - Start ADR window:

     ```typescript
     decorationRestoreInProgressRef.current = true;
     if (typeof window !== 'undefined') {
       (window as any).__DAGNET_DECORATION_RESTORE_ACTIVE = true;
     }

     const t0 = performance.now();
     flushSync(() => {
       setIsPanningOrZooming(false);   // stops pan suppression
       setChevronsVisible(true);       // overlay only
       setBeadsVisible(true);          // overlay only
     });
     const t1 = performance.now();
     console.log('[PERF] Atomic decoration restore took', (t1 - t0).toFixed(2), 'ms');

     decorationRestoreInProgressRef.current = false;
     if (typeof window !== 'undefined') {
       (window as any).__DAGNET_DECORATION_RESTORE_ACTIVE = false;
     }
     ```

   - Any viewport persistence / tab state updates:
     - Must **not** run inside this block.
     - Should be scheduled after ADR via `requestAnimationFrame` or a micro‑delay, and guarded by the global flag.

3. **At pan end (click/no‑move case)**:

   - Treat as a normal click; no ADR window needed.
   - `setIsPanningOrZooming(false)`, `setChevronsVisible(true)`, `setBeadsVisible(true)` without heavy work.

---

## 7. Testing and Verification Plan

1. **Instrumentation**
   - Keep the `[PERF] DECORATIONS JUST RESTORED` log and the global `__DAGNET_DECORATION_RESTORE_ACTIVE` flag.
   - Add logs inside:
     - `TabContext.updateTabState`
     - `fileRegistry.notifyListeners`
     - `GraphStoreProvider` persistence
   - Ensure they **never** log while `__DAGNET_DECORATION_RESTORE_ACTIVE` is true.

2. **React Profiler (DevTools)**
   - Capture a profile where you:
     - Pan around with chevrons/beads on.
     - Release, triggering an ADR restoration.
   - Expected:
     - One React commit corresponding to `GraphCanvas` + overlay components.
     - No large `CanvasInner`/`EdgeRenderer` commits in the same time window.

3. **Chromium Performance panel**
   - Correlate:
     - The decoration restore log timestamp.
     - `RunTask` / `FunctionCall` / `Commit` events nearby.
   - Verify:
     - There is a single block of JS work for the overlay update.
     - Any extra ReactFlow/AppShell/Navigator work is displaced *after* that window or eliminated.

4. **Visual check**
   - Pan/zoom repeatedly and watch chevrons/beads:
     - They may still take 1–2 frames to fully draw (GPU/paint), but:
     - You do **not** see ReactFlow “re‑layout” or AppShell/Navigator re‑rendering immediately after restoration.

---

## 8. Summary

This plan is intentionally **only** about Goal #1:

- Make decoration restoration a **single, atomic overlay commit** that:
  - Does not mutate ReactFlow’s `nodes`/`edges` arrays or edge `data`.
  - Does not trigger `updateTabState`, GraphStore persistence, or what‑if/scenario writes inside the critical window.
  - Explicitly blocks or defers any tab/file/what‑if cascades while `__DAGNET_DECORATION_RESTORE_ACTIVE` is true.

If we implement these invariants and guards, ReactFlow should no longer “interact with” or interrupt the chevron/bead restoration, even if all decorations land in one go. If that still proves too heavy for the GPU/paint path, we can separately consider incremental overlay restoration — but that would be a **second‑stage optimization**, not part of this plan.***

