# Incremental Chevron & Bead Restoration – V2 Architecture and Implementation Plan

## 1. Scope and Objectives

### 1.1 Problem Restatement

We have already:

- **Solved pan/zoom performance** by fully suppressing chevrons (SVG clipPaths) and beads (HTML portals) while the user is panning/zooming.
- **Not solved** the post‑pan experience: when pan/zoom ends and decorations are restored, we still see:
  - A **large React commit** (~30–50ms, sometimes worse), rooted in ReactFlow internals (`CanvasInner`, `EdgeRenderer`, `NodeRenderer`, `MiniMap`).
  - Resulting in an **incompletely drawn restoration frame** – chevrons/beads often appear half‑rendered.

### 1.2 Design Goals

1. **No blown frame after pan/zoom ends**
   - Browser should stay within ~16ms/frame during and after the restoration.
   - No single React commit from decorations should exceed ~10–12ms on the target graphs.

2. **Keep ReactFlow’s graph state stable during restoration**
   - `nodes`, `edges`, and their `data` props should not thrash when decorations come back.
   - Heavy ReactFlow updates (`CanvasInner`, `EdgeRenderer`, `NodeRenderer`, `MiniMap`) should only be triggered by *real* graph changes, not decoration toggles.

3. **Incremental, controllable restoration**
   - Chevrons (clipPaths) restore in **small batches across frames**.
   - Beads restore **after** chevrons complete, optionally also batched if needed.

4. **Minimal architectural surgery**
   - Avoid a full decoupling of decorations from ReactFlow.
   - Reuse existing structures (`GraphCanvas`, `ChevronClipPaths`, `EdgeBeadsRenderer`, etc.) with incremental state layered on top.

---

## 2. Key Concept: “Incremental Overlay State” vs ReactFlow Core

### 2.1 Where chevrons actually live today

Conceptually:

- ReactFlow owns:
  - Node and edge data (`nodes`, `edges`).
  - The main SVG canvas and layout (`CanvasInner`, `EdgeRenderer`, `NodeRenderer`, `MiniMap`).
  - Edge shapes and markers that may reference `clipPath` ids.

- We own:
  - `ChevronClipPaths` (a component that renders `<defs><clipPath id="...">...</clipPath></defs>`).
  - The logic to group edges into **chevron bundles** (`groupEdgesIntoBundles`).
  - Bead rendering via `EdgeBeadsRenderer` (SVG + HTML portals).

Critically:

- **Edges reference clipPath IDs**, but they do *not* need to be re‑rendered when we add/remove `<clipPath>` defs.
  - Once an edge has `clipPath="url(#edge-123-chevron)"`, the browser will apply clipping whenever that `<clipPath>` appears or changes in the DOM.
  - We can therefore treat `ChevronClipPaths` as a **separate overlay layer** that we control by changing *its* props (bundles), without touching ReactFlow’s edge props.

### 2.2 What “incremental overlay state” means

Rather than:

- Changing `edges` / `edge.data` on restoration, and letting ReactFlow recompute everything,

we instead:

- **Keep ReactFlow’s `nodes` / `edges` arrays stable** across the post‑pan restoration.
- Drive chevron + bead visibility through **our own local state** in `GraphCanvas`:
  - `chevronRestoreState` – which phase we are in.
  - `activeChevronBundleCount` – how many chevron bundles are currently rendered.
  - `beadsVisible` – whether `EdgeBeadsRenderer` should render at all.
- Only `ChevronClipPaths` and the bead renderers see those changes; ReactFlow core does not.

This is a **partial decoupling**:

- We are *not* removing ReactFlow from the picture.
- We are simply ensuring that decoration toggles do not mutate the parts of ReactFlow state (`nodes`, `edges`, their `data`) that cause the heavy `CanvasInner` / `EdgeRenderer` commits.

---

## 3. State Machine in `GraphCanvas`

### 3.1 New State

In `GraphCanvas.tsx`, augment existing pan/zoom and decoration state with:

```typescript
// Existing:
const [isPanningOrZooming, setIsPanningOrZooming] = React.useState(false);

// New: decoration restoration phases
type ChevronRestoreState = 'idle' | 'suppressing' | 'restoring' | 'complete';

const [chevronRestoreState, setChevronRestoreState] =
  React.useState<ChevronRestoreState>('idle');

// Number of chevron bundles currently rendered
const [activeChevronBundleCount, setActiveChevronBundleCount] =
  React.useState<number>(0);

// Bead visibility is controlled independently
const [beadsVisible, setBeadsVisible] = React.useState<boolean>(true);

// RAF handle for incremental chevron restoration
const chevronRestoreRafRef = React.useRef<number | null>(null);

// Snapshot of full chevron bundles at the point restoration starts
const latestBundlesRef = React.useRef<EdgeBundle[] | null>(null);
```

### 3.2 Phase definitions

- **`idle`**
  - No pan/zoom in progress.
  - All chevrons rendered; `beadsVisible = true`.

- **`suppressing`**
  - User is actively panning/zooming.
  - `visibleBundles = []`, `beadsVisible = false`.

- **`restoring`**
  - Pan/zoom has ended; a debounce has elapsed.
  - We are incrementally increasing `activeChevronBundleCount` each frame.
  - `beadsVisible = false`.

- **`complete`**
  - All bundles restored; `visibleBundles = fullBundles`.
  - `beadsVisible = true`.

---

## 4. Chevron Bundles: Full vs Visible

### 4.1 Compute full chevron bundles once

Today you have something like:

```typescript
const bundles = (useSankeyView || NO_CHEVRONS_MODE || shouldSuppressDecorations)
  ? []
  : groupEdgesIntoBundles(edgesWithOffsetData, nodesWithSelection);
```

We will refactor this into **two layers**:

1. **`fullBundles`** – what chevrons *would* exist given the current graph and view, ignoring restoration state.
2. **`visibleBundles`** – the subset we actually pass into `ChevronClipPaths` during incremental restoration.

```typescript
const suppressAllChevrons =
  isPanningOrZooming || chevronRestoreState === 'suppressing' || NO_CHEVRONS_MODE;

const fullBundles = React.useMemo(() => {
  if (useSankeyView || suppressAllChevrons) {
    return [] as EdgeBundle[];
  }
  return groupEdgesIntoBundles(edgesWithOffsetData, nodesWithSelection);
}, [
  useSankeyView,
  suppressAllChevrons,
  edgesWithOffsetData,
  nodesWithSelection
]);
```

### 4.2 Visible bundles driven by `activeChevronBundleCount`

```typescript
const visibleBundles: EdgeBundle[] = React.useMemo(() => {
  if (chevronRestoreState === 'complete') {
    return fullBundles;
  }
  if (!fullBundles.length) return [];

  const count =
    activeChevronBundleCount <= 0
      ? 0
      : Math.min(activeChevronBundleCount, fullBundles.length);

  return fullBundles.slice(0, count);
}, [fullBundles, activeChevronBundleCount, chevronRestoreState]);
```

### 4.3 Use `visibleBundles` in `ChevronClipPaths`

```tsx
{!NO_CHEVRONS_MODE && chevronRestoreState !== 'suppressing' && (
  <Panel position="top-left" style={{ pointerEvents: 'none' }}>
    <ChevronClipPaths
      bundles={visibleBundles}
      nodes={nodes}
      frameId={renderFrameRef.current}
    />
  </Panel>
)}
```

**Important:** this means:

- Edges and nodes (ReactFlow’s concern) remain unchanged.
- Only our overlay component (`ChevronClipPaths`) sees different props as restoration progresses.

---

## 5. Pan/Zoom Hooks: Entering and Leaving Suppression/Restoration

### 5.1 Pan start (`onMoveStart`)

On pan/zoom start, we:

- Cancel any in‑flight restoration.
- Enter the `suppressing` phase.
- Hide beads.

```typescript
onMoveStart={(_, viewport) => {
  // ...existing logic (clear timers, mark move start, etc.)...

  if (chevronRestoreRafRef.current != null) {
    cancelAnimationFrame(chevronRestoreRafRef.current);
    chevronRestoreRafRef.current = null;
  }

  setChevronRestoreState('suppressing');
  setActiveChevronBundleCount(0);
  setBeadsVisible(false);

  setIsPanningOrZooming(true);
}}
```

### 5.2 Pan end (`onMoveEnd`) – debounce + start restoration

We keep a small debounce (`DECORATION_RESTORE_DELAY`) after pan ends, then:

- Exit `isPanningOrZooming`.
- Enter `restoring`.
- Snapshot `fullBundles` into `latestBundlesRef`.
- Start the RAF loop to incrementally increase `activeChevronBundleCount`.

```typescript
const DECORATION_RESTORE_DELAY = 80; // ms, tunable

onMoveEnd={(_, viewport) => {
  if (!hasMovedRef.current) {
    // Click without pan – just ensure decorations are enabled normally
    setIsPanningOrZooming(false);
    setChevronRestoreState('idle');
    setBeadsVisible(true);
    return;
  }

  // ...existing viewportToSave and movement tracking logic...

  setIsPanningOrZooming(false);

  decorationRestoreTimeoutRef.current = window.setTimeout(() => {
    // Start restoration
    setChevronRestoreState('restoring');
    setBeadsVisible(false);

    latestBundlesRef.current = fullBundles;
    setActiveChevronBundleCount(0);

    startChevronRestoreRaf();

    // NOTE: viewport persistence (updateTabState) should happen
    //       AFTER this restoration window or in minimal mode be skipped.
  }, DECORATION_RESTORE_DELAY);
}}
```

---

## 6. RAF Loop: Incremental Chevron Restoration

### 6.1 Implementation

```typescript
const BATCH_SIZE = 10; // number of bundles restored per frame

const startChevronRestoreRaf = React.useCallback(() => {
  const step = () => {
    const bundles = latestBundlesRef.current ?? [];

    if (!bundles.length) {
      // Nothing to restore; finish immediately
      setChevronRestoreState('complete');
      setBeadsVisible(true);
      chevronRestoreRafRef.current = null;
      return;
    }

    setActiveChevronBundleCount(prev => {
      const next = Math.min(prev + BATCH_SIZE, bundles.length);

      if (next >= bundles.length) {
        // Fully restored in this frame
        setChevronRestoreState('complete');
        setBeadsVisible(true);
        chevronRestoreRafRef.current = null;
      } else {
        chevronRestoreRafRef.current = requestAnimationFrame(step);
      }

      return next;
    });
  };

  chevronRestoreRafRef.current = requestAnimationFrame(step);
}, []);
```

### 6.2 Cancellation and cleanup

We have two cancellation points:

1. **New pan** (already shown in `onMoveStart`).
2. **Component unmount**:

```typescript
React.useEffect(() => {
  return () => {
    if (chevronRestoreRafRef.current != null) {
      cancelAnimationFrame(chevronRestoreRafRef.current);
    }
  };
}, []);
```

---

## 7. Bead Restoration Strategy

### 7.1 New `beadsVisible` flag

We extend the bead pipeline to accept a `beadsVisible` boolean from `GraphCanvas`.

**In `ConversionEdge.tsx`** (simplified sketch):

```tsx
const isInteracting = data?.isPanningOrZooming ?? false;

// beadsVisible comes from GraphCanvas via edge data or context
const beadsVisible = data?.beadsVisible ?? true;

{!data?.suppressLabel &&
 !data?.scenarioOverlay &&
 pathRef.current &&
 fullEdge &&
 scenariosContext &&
 !NO_BEADS_MODE && (
  <EdgeBeadsRenderer
    ...
    isPanningOrZooming={isInteracting}
    beadsVisible={beadsVisible}
  />
)}
```

**In `EdgeBeads.tsx`**:

```typescript
export const EdgeBeadsRenderer = React.memo(function EdgeBeadsRenderer(
  props: EdgeBeadsProps & {
    sourceClipPathId?: string;
    isPanningOrZooming?: boolean;
    beadsVisible?: boolean;
  }
) {
  const {
    sourceClipPathId,
    path,
    edgeId,
    isPanningOrZooming,
    beadsVisible = true,
    ...restProps
  } = props;

  if (isPanningOrZooming || !beadsVisible) {
    return null;
  }

  // ... existing beads implementation ...
});
```

**In `GraphCanvas`**, we ensure:

- `beadsVisible = false`:
  - while `isPanningOrZooming` is true (`onMoveStart` → `onMoveEnd`),
  - while `chevronRestoreState === 'restoring'`.
- `beadsVisible = true`:
  - when `chevronRestoreState` transitions to `'complete'`.

We can plumb `beadsVisible` down to edges either:

- Via `edge.data.beadsVisible`, set once per restoration phase, or
- Via a small context that `ConversionEdge` reads from `GraphCanvas`.

The **important constraint**: we must avoid constantly changing `edge.data` for every edge during each RAF tick. The cheapest path is:

- `beadsVisible` is flipped **once** per restoration cycle (`false → true`) and not per frame.

---

## 8. How This Keeps ReactFlow’s `nodes` / `edges` Stable

### 8.1 What changes vs current behavior

Today, decoration state tends to be expressed by mutating `edge.data` or by recomputing `bundles` in a way that causes `setEdges` or other ReactFlow state changes, which:

- Triggers heavy ReactFlow commits:
  - `CanvasInner`, `EdgeRenderer`, `NodeRenderer`, `MiniMap` all get re‑rendered.
  - React Profiler shows 30–50ms commits on restoration.

In the V2 design:

- **During restoration**:
  - `nodes` and `edges` arrays remain unchanged.
  - `edge.data` is not modified per‑frame to reflect clipPath/bead progress.
  - The only per‑frame changes are:
    - `activeChevronBundleCount` (used exclusively by `ChevronClipPaths`).
    - The internal children of `ChevronClipPaths` as the `<clipPath>` `<defs>` grow.

- **When chevrons finish**:
  - We flip `beadsVisible` **once** from `false` to `true`, visible to bead renderers only.

ReactFlow’s heavy internals no longer see a flood of decoration‑driven prop changes; they only see decoration overlays changing within our own components.

### 8.2 Why this is partial (not total) decoupling

We are not rewriting the world:

- Edges still reference clipPath IDs that we generate (`clipPath="url(#bundle-xyz)"`).
- Beads still hang off edge components.

But:

- The **incremental work** (which clipPaths exist, and when beads start rendering) is moved into a **narrow overlay state machine** that:
  - Does not mutate the graph structure.
  - Minimizes the surface area of props that change on each frame.

This is enough to make “ReactFlow’s edges/nodes stay stable during restoration” true in practice, without re‑architecting the whole decoration system.

---

## 9. Alternatives and Why We’re Not Doing Them Now

### 9.1 Full decoupling of decorations

An alternative design would be:

- Maintain a separate graph view model (positions, edge paths) that beads/chevrons subscribe to.
- Render all decorations in a completely separate SVG and DOM tree, not under ReactFlow’s `CanvasInner` at all.
- ReactFlow only knows about bare edges; decorations are drawn over the top from our own store.

Pros:

- Decoration toggles would never touch ReactFlow state.
- Pan/zoom restoration could be fully orchestrated outside the ReactFlow tree.

Cons:

- Significant refactor:
  - Need a stable, reusable “graph geometry” representation outside ReactFlow.
  - Need to keep ReactFlow and the overlay in sync for interactions.

Given the current codebase and time, this is overkill for the immediate problem.

### 9.2 Single‑frame optimization only

We could try to make “all chevrons/beads in one frame” cheaper by:

- Reducing clipPath complexity.
- Aggressively memoizing components.

However:

- ReactFlow’s own commits (CanvasInner + EdgeRenderer) are already substantial.
- With 100+ edges and multi‑scenario rendering, the **fundamental cost** of “all at once” is simply too high.

---

## 10. Implementation Checklist

1. **Add state to `GraphCanvas`**
   - `chevronRestoreState`, `activeChevronBundleCount`, `beadsVisible`, `chevronRestoreRafRef`, `latestBundlesRef`.

2. **Refactor bundle computation**
   - Introduce `fullBundles` and `visibleBundles`.
   - Replace all uses of `edgeBundles` in `ChevronClipPaths` with `visibleBundles`.

3. **Wire pan/zoom handlers**
   - `onMoveStart`: cancel RAF, set `chevronRestoreState = 'suppressing'`, `activeChevronBundleCount = 0`, `beadsVisible = false`.
   - `onMoveEnd`: after `DECORATION_RESTORE_DELAY`, set `chevronRestoreState = 'restoring'`, snapshot `fullBundles`, start RAF, defer viewport persistence.

4. **Implement `startChevronRestoreRaf`**
   - RAF loop that increments `activeChevronBundleCount` by `BATCH_SIZE` per frame.
   - Switches to `chevronRestoreState = 'complete'` + `beadsVisible = true` when done.

5. **Plumb `beadsVisible` through edge pipeline**
   - Decide plumbing (edge `data` vs context).
   - Update `ConversionEdge` and `EdgeBeadsRenderer` to respect `beadsVisible`.

6. **Add cleanup**
   - Cancel RAF on unmount.
   - Reset state correctly when URL modes (`?nochevrons`, `?nobeads`, `?minimal`) are active.

7. **Testing**
   - Use performance traces to confirm:
     - No 30–50ms React commits at restoration time.
     - Restoration frames stay within budget.
   - Verify UX:
     - Chevrons pop in progressively but acceptably.
     - Beads appear after chevrons without new jank.

Once this is implemented, we should re‑capture a profile and confirm that:

- Large ReactFlow commits coincide only with genuine graph changes, not with decoration restoration.
- The blown post‑pan frame has been eliminated in the normal mode of use.


