## Render performance investigation & caching plan

This doc outlines how we will diagnose and fix the instability / flicker / incomplete renders in the graph editor, focusing on `GraphCanvas`, scenario edges, and the bead/lozenge system.

The goals:
- **Stability**: no half-drawn viewports, no disappearing beads, no error-boundary resets.
- **Responsiveness**: pan/zoom/selection feels snappy; labels/beads appear within one frame.
- **Predictability**: heavy work only runs when DSL / graph / scenarios actually change.

---

## 1. Baseline: measure what’s slow & when

Before adding caching, we need a clear picture of where the time is going.

- **1.1 Instrument key stages**
  - Add lightweight timing logs (with `performance.now()`) in:
    - `GraphCanvas.tsx`
      - What-if recompute (existing logs).
      - `buildScenarioRenderEdges` call.
      - ReactFlow `nodes`/`edges` memoization (if we add it).
    - `buildScenarioRenderEdges.ts`
      - Time to build all ReactFlow edges.
    - `edgeBeadHelpers.tsx`
      - Time inside `buildBeadDefinitions` per edge.
    - `EdgeBeads.tsx`
      - Time per edge for:
        - path length calculation.
        - bead layout along the spline.
        - text measurement.

- **1.2 Capture scenarios**
  - Test with:
    - A small graph (current test graph).
    - A larger “stress” graph with more edges and conditional/variant beads.
  - Record:
    - Pan/zoom interactions.
    - Rapid edge selection and deselection.
    - Editing What-If DSL.

- **1.3 Identify patterns**
  - From logs, identify:
    - Which stages consistently exceed ~10–15ms.
    - Whether we see **bursts** of sequential renders (e.g., 5–10 frames in quick succession).
    - Any correlation between flicker and:
      - What-if recomputes.
      - Scenario changes.
      - Bead layout / text measurement.

Outcome: a short summary section in this doc (or `tmp.log` annotated) listing the top 2–3 hotspots we will target first.

---

## 2. Coarse-grained caching: graph & scenarios

Most heavy logic does **not** need to run on every render. We will introduce coarse “versioned” caches.

- **2.1 What-if effective params cache**
  - Location: `ScenariosContext.tsx` (or a dedicated helper in `lib/whatIf.ts`).
  - Key: `{ graphVersion, whatIfDSL }` → `effectiveParams`.
    - `graphVersion`: incremented whenever the graph structure or base params change.
    - `whatIfDSL`: use the DSL string directly as part of key.
  - Behaviour:
    - On change of `(graphVersion, whatIfDSL)`:
      - Recompute effective probabilities for all edges once.
      - Store in a `Map<string, EffectiveParams>` (or similar).
    - `buildScenarioRenderEdges` then **reads** effective params from this cache instead of recomputing probabilities per render.

- **2.2 Scenario edge building memo**
  - Location: `GraphCanvas.tsx`.
  - Strategy:
    - Wrap `buildScenarioRenderEdges` in a `useMemo`:
      - Dependencies: `[graphVersion, scenariosVersion, whatIfKey, tabScenarioStateKey]`.
      - `graphVersion` & `scenariosVersion`: numeric counters updated only on meaningful changes.
      - `whatIfKey`: stable identifier derived from DSL string (or cache key from 2.1).
      - `tabScenarioStateKey`: derived from visible scenario IDs and order.
    - Ensure we **do not** include full `graph`/`scenarios` objects directly in dependencies.

Result: scenario edges are rebuilt only when graph/scenario/DSL state changes, not on every minor render (e.g. sidebar resize).

---

## 3. Edge-level caching: bead definitions per edge

`edgeBeadHelpers.tsx` should be pure and cached per edge.

- **3.1 Bead data cache**
  - Add a module-level cache:

    ```ts
    const beadCache = new Map<string, BeadDefinition[]>();
    ```

  - Key: `${edgeId}|${graphVersion}|${whatIfKey}|${scenarioKey}`
    - `edgeId`: stable edge UUID.
    - `graphVersion`: as above.
    - `whatIfKey`: from 2.1.
    - `scenarioKey`: derived from visible scenario IDs + order.

  - Export a helper:

    ```ts
    export function getBeadsForEdge(...) {
      const key = ...;
      const cached = beadCache.get(key);
      if (cached) return cached;
      const beads = buildBeadDefinitions(...);
      beadCache.set(key, beads);
      return beads;
    }
    ```

- **3.2 Use cached bead definitions in `ConversionEdge` / `EdgeBeads`**
  - `ConversionEdge` (or `EdgeBeadsRenderer`) should call `getBeadsForEdge` instead of calling `buildBeadDefinitions` directly.
  - Ensure `beadDefinitions` passed into `EdgeBeads` are **stable** until their key truly changes.

Outcome: Bead extraction (multi-scenario values, hidden current, text nodes) runs once per edge per logical state, not on every render.

---

## 4. Render-time geometry caching in `EdgeBeads`

We must minimise DOM queries and heavy math inside the render path.

- **4.1 Path metrics cache**
  - Key: `${edgeId}|${pathD}`.
  - Cache:
    - `pathLength: number`.
    - Optionally a small lookup table for `getPointAtLength` if needed.
  - Only call `path.getTotalLength()` when `pathD` changes.

- **4.2 Text width cache**
  - Global cache: `Map<string, number>`.
  - Key: `${fontSize}|${fontWeight}|${text}`.
  - All beads for the same text reuse the measured width instead of calling `measureText` repeatedly.

- **4.3 Bead layout simplification**
  - Continue using cumulative `currentDistance` per edge:
    - `start = currentDistance`.
    - `width = baseWidth + contentWidth`.
    - `currentDistance += width + BEAD_SPACING`.
  - For **collapsed beads**:
    - `contentWidth = 0`, `width = baseWidth`.
    - Use **exact same stroke geometry** as expanded case, just with shorter `strokeLength`.
  - This keeps one code path and keeps spacing purely a function of widths + spacing.

- **4.4 Avoid DOM work in render**
  - Any code that *must* touch real DOM (e.g. sampling clip paths for chevron-aware offsets) should:
    - Preferably run in `useLayoutEffect` or on first mount only.
    - Cache its result keyed by `edgeId` + `clipPathId`.

---

## 5. Minimising render triggers

Caching only helps if we also stop triggering renders unnecessarily.

- **5.1 Stabilise props into `ReactFlow`**
  - In `GraphCanvas.tsx`, ensure:
    - `nodes` and `edges` arrays are wrapped in `useMemo`.
    - Callbacks (`onNodesChange`, `onEdgesChange`, `onConnect`, etc.) wrapped in `useCallback`.
  - Goal: ReactFlow sees the same identities unless the underlying data really changes.

- **5.2 Bead renderer memo**
  - `EdgeBeadsRenderer` is already wrapped in `React.memo`.
  - Ensure props:
    - `beadDefinitions`,
    - `path`,
    - `isPanningOrZooming`,
    - `edgeId`
    are stable and compared by simple keys where possible.
  - Custom `areEqual` function should ignore props that aren’t relevant to bead rendering.

- **5.3 Pan/zoom detection**
  - Confirm `isPanningOrZooming` toggles **only** when viewport truly changes (use the existing deltas/threshold logic).
  - Don’t let minor jitter or clicks flip this flag on/off, which would cause beads to hide/show and re-render frequently.

---

## 6. Error handling and resilience

Render instability is worsened by any runtime throwing inside `EdgeBeads` and triggering the error boundary.

- **6.1 Harden `EdgeBeads` against bad inputs**
  - Guard:
    - `path` existence.
    - `pathLength > 0`.
    - Bead widths not `NaN` or negative.
  - If any of these fail, **skip beads for that edge** quietly instead of throwing.

- **6.2 Narrow error boundary impact**
  - If we add any local error boundaries around beads/labels, ensure they don’t force a full graph remount.
  - For now: rely on input guards to avoid throwing at all.

---

## 7. Implementation order (so we can test incrementally)

To avoid destabilising everything at once, implement in this sequence:

1. **Path & text caches in `EdgeBeads`** (4.1, 4.2)  
   - Easiest and immediately reduces per-frame cost.
2. **Bead definition cache per edge** (3.1–3.2)  
   - Ensures bead data isn’t rebuilt on every render.
3. **Scenario edge memo in `GraphCanvas`** (2.2)  
   - Stops full edge rebuilds on trivial renders.
4. **What-if effective params cache** (2.1)  
   - Removes the largest CPU chunk from repeated renders.
5. **Render trigger clean-up** (5.1–5.3)  
   - Stabilise ReactFlow props and pan/zoom flag.
6. **Hardening & guard rails** (6.x)  
   - Make sure no residual edge cases can throw and cause catastrophic flicker.

At each step, we’ll:
- Re-run the same interactions (pan/zoom, edit DSL, select edges).
- Capture `tmp.log` timings again.
- Verify:
  - Fewer frames per interaction (less “frame spam”).
  - Lower per-frame cost for the heavy stages.
  - Visually: no partial viewports / missing beads at rest.

Once these are in, the graph editor should feel significantly more stable and responsive, while still preserving the visual fidelity of the bead/lozenge system. 


