selected edge LABELS are showing black text on a black label background, which ain't great...

we used to have a sophisticated display logic for selected  & highlithed edges, we have broken that with the new scenario rending pipeline.

Now selected and/or highlighted edges are not showing up at all.

Issue is there are two parallel rendering paths -- one for 'non scenario' rendering and one for 'scenario rendering'. 

In practice there IS no non-scenario rendering any more, so I would prefer that we removed that stale codepath entirely to avoid confusion.

Either  way, the changes you just made have not succeeded. We need to apply the selcetion / highlighting logic to the 'current' layer even when it is shown using the scenario render path.

1. Selected edge lables are showing black-on-black
2. we're seeing 'x' options showing for every edge layer; should only be shown on the actual displayed label 

---

## Scenario Rendering Refactor – Single Edge Pipeline

**Status:** Proposal  
**Scope:** `GraphCanvas.tsx`, `ConversionEdge.tsx`, `edgeLabelHelpers.tsx`, `ScenariosContext.tsx`, `TabContext.tsx`  
**Goal:** Delete the legacy “base edge” render path and render **all** edges (including `current`) exclusively through the scenario-layer pipeline, while preserving ReactFlow’s interaction model.

---

### 1. Current Architecture (Simplified)

- **ReactFlow** is still the core canvas:
  - Receives `nodes` and `edges` props.
  - Handles zoom, pan, dragging, selection, reconnection, keyboard shortcuts.
- **Base edges (`edges` state in `GraphCanvas`)**:
  - ReactFlow’s internal edge list.
  - Historically both **visual** and **interactive** representation.
- **Scenario overlays (`overlayEdges` in `GraphCanvas`)**:
  - Non-interactive clones of base edges per scenario layer (`base`, `current`, user scenarios).
  - Visual-only: colored, semi-transparent, no event handlers.

**Problem:** We now always render `current` via the scenario overlay path, but we still merge in base edges as invisible/neutral “interaction shells” when scenarios are present. This creates:

- Two partial render paths (base vs overlays) that can diverge.
- Selection/highlight logic applied to base edges that might be invisible.
- Multiple code paths for probability, What-If, and case-variant logic.

We want:

- **One visual pipeline:** Graph → scenarios → ReactFlow edges.  
- **`current`** always present as a scenario layer and always the **only interactive layer** for edges.

ReactFlow is still absolutely in use; we are only changing **what** we pass as `edges`, not removing ReactFlow.

---

### 2. Target Architecture – Single Scenario-Based Edge Pipeline

#### 2.1. Invariants

- There is **always** a scenario-layer system active:
  - `current` layer exists for every tab.
  - `base` and user scenarios are optional overlays.
- `current` is the only **editable + interactive** edge layer.
- All rendered edges are scenario-aware:
  - For `current`, probabilities are computed via `computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL }, ...)`.
  - For scenarios, probabilities come from frozen `ScenarioParams` (snapshots).

#### 2.2. Data Flow

- **Graph store (`GraphStoreContext`)**: canonical graph (`nodes`, `edges`, parameters).
- **Scenarios (`ScenariosContext`)**: base params, scenario params, current params, color palette.
- **Tab state (`TabContext`)**: per-tab visibility (`visibleScenarioIds`), layer order, What-If DSL.
- **GraphCanvas**:
  - Pulls graph + scenario + tab state.
  - Calls `buildScenarioRenderEdges(...)` to construct **all** ReactFlow edges to render.
  - Passes `renderEdges` to `<ReactFlow edges={renderEdges} ... />`.

There is no separate “base-only” render path; base edges are only used as **input** to `buildScenarioRenderEdges`, not rendered directly when scenarios are active.

---

### 3. Implementation Plan

#### Step 0 – Restore Stable Baseline

Before refactoring:

- Revert to a commit where:
  - What-If updates correctly without F5.
  - Case variant weighting is correct.
  - Scenario overlays and base edges both render without visual corruption.
- Use this as the regression baseline; keep a copy of the relevant sections from:
  - `GraphCanvas.tsx` (overlay construction and `displayEdges`).
  - `ConversionEdge.tsx` (selection/highlight, colors).
  - `edgeLabelHelpers.tsx` (labels).

This minimizes risk: all later steps are compared against known-good behavior.

---

#### Step 1 – Introduce `renderEdges` as the Only ReactFlow Edge Source

**Files:** `GraphCanvas.tsx`

1. Keep existing `edges` state (ReactFlow internal topology):
   - Still used for graph layout, reconnection, and internal bookkeeping.
2. Introduce a new memoized value:
   ```ts
   const renderEdges = useMemo(
     () => buildScenarioRenderEdges({
       baseEdges: edges,
       graph,
       scenariosContext,
       visibleScenarioIds,
       whatIfDSL,
       massGenerosity,
       useSankeyView,
       tabId,
     }),
     [edges, graph, scenariosContext, visibleScenarioIds, whatIfDSL, massGenerosity, useSankeyView, tabId]
   );
   ```
3. Replace `displayEdges` and pass `renderEdges` into ReactFlow:
   ```tsx
   <ReactFlow
     nodes={nodes}
     edges={renderEdges}
     ...
   />
   ```
4. In this step, **do not** change the semantics of base vs overlay construction yet; just move the logic into `buildScenarioRenderEdges` so we have one explicit factory function.

**Risk:** Low. This is mostly a mechanical extraction: old behavior preserved, easier to reason about and test in isolation.

---

#### Step 2 – Make `current` Overlays the Only Interactive Edges

**Files:** `GraphCanvas.tsx`, specifically `buildScenarioRenderEdges`.

For each base edge and each scenario layer (`'base'`, `'current'`, user scenarios):

1. **Build a scenario edge object** with:
   - `data.scenarioOverlay: true` for non-current layers.
   - `data.scenarioOverlay: false` for `current` layer.
   - `data.scenarioColor`, `data.strokeOpacity`, scenario params, etc., as today.
   - `data.originalEdgeId`: base ID (for label lookups, path mapping, etc.).

2. **For `scenarioId === 'current'` only:**
   - `id`: reuse `edge.id` (base id) so ReactFlow selection, keyboard, reconnection, etc. continue to work without change.
   - `selectable: true`.
   - Copy interaction handlers from the original base edge:
     ```ts
     onUpdate: baseEdge.data?.onUpdate,
     onDelete: baseEdge.data?.onDelete,
     onDoubleClick: baseEdge.data?.onDoubleClick,
     onSelect: baseEdge.data?.onSelect,
     onReconnect: baseEdge.data?.onReconnect,
     ```
   - `data.suppressLabel: false` (current is where composite labels live). 
   - `style.pointerEvents: 'auto'`.

3. **For all other layers (base + user scenarios):**
   - `id`: `scenario-overlay__<layerId>__<baseEdge.id>`.
   - `selectable: false`.
   - `data.scenarioOverlay: true`.
   - `data.suppressLabel: true` (to avoid duplicate labels).
   - No interactive handlers; `pointerEvents: 'none'`.

**Result:**

- When scenarios are active (which is always, conceptually), **the only interactive edges** are the `current` overlays; base edges are never drawn or hit-tested.

**Risk:** Medium. We’re changing which edges ReactFlow considers “real” for interaction, but we preserve IDs and handlers, so selection and history should remain consistent. Careful testing needed around reconnection and undo/redo.

---

#### Step 3 – Stop Rendering Base Edges Entirely

**Files:** `GraphCanvas.tsx`

Once `renderEdges` is authoritative and `current` overlays are interactive:

1. Delete the old merge logic that combined base edges with overlays (e.g. `interactiveBaseEdges + overlayEdges`).
2. Ensure `buildScenarioRenderEdges`:
   - Uses `baseEdges` only as input.
   - Never returns raw base edges; always scenario-layer edges (including `current`).
3. Confirm that:
   - No component accesses base `edges` directly for visuals; only for topology/ReactFlow events.

**Risk:** Medium. If any legacy code still assumes base edges are rendered (e.g., for z-index, label suppression, or hit-testing), it will break. Grep for `forceBaseStrokeColor`, `suppressLabel`, etc., and remove/adjust as necessary.

---

#### Step 4 – Route Highlight / Selection into `current` Layer Only

**Files:** `GraphCanvas.tsx`, `ConversionEdge.tsx`

1. **Highlight computation** (currently applied to base edges):
   - Instead of mutating `edges` state with `data.isHighlighted` etc., compute a `Set` of highlighted base edge IDs (`highlightedBaseIds`) and a `Map` of depths (`highlightDepthMap`).
   - Pass these into `buildScenarioRenderEdges` (or derive them inside the helper).

2. Inside `buildScenarioRenderEdges`:
   - For each `current` layer edge, set:
     ```ts
     data.isHighlighted = highlightedBaseIds.has(baseEdge.id);
     data.highlightDepth = highlightDepthMap.get(baseEdge.id) ?? 0;
     data.isSingleNodeHighlight = isSingleNodeSelection; // computed once
     ```
   - For non-current layers, leave these flags unset.

3. **`ConversionEdge` shading logic** stays in one place, but now always applies to the visible `current` stroke, not to an invisible base clone:
   - Uses `data.isHighlighted`, `data.highlightDepth`, `data.isSingleNodeHighlight` to blend black with base color.
   - Uses `selected` to override color/opacity for selected current edges.

**Risk:** Low–medium. Logic is already centralized in `ConversionEdge`; we’re just making sure the right edges carry the highlight flags.

---

#### Step 5 – Unify Probability / What-If / Variant Weight Logic

**Files:** `ConversionEdge.tsx`, `GraphCanvas.tsx`, `ScenariosContext.tsx`

1. **Current layer (`current`):**
   - For effective probability (tooltips, dashed lines, widths), always use:
     ```ts
     computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL }, pathContext);
     ```
   - `pathContext` is used where we simulate traversal; for simple render-width, it can be `undefined`.
   - Do **not** re-implement variant weighting or conditionals in a second code path; rely on `computeEffectiveEdgeProbability` exclusively.

2. **Scenario layers:**
   - Use `ScenarioParams` (snapshots) only:
     - `scenario.params.edges[edgeId].p.mean` etc.
   - Do **not** apply What-If when rendering scenario layers; they represent frozen views that already baked in What-If at snapshot time.

3. **Snapshots (`ScenariosContext.createSnapshot`):**
   - Already recompute effective probabilities via `computeEffectiveEdgeProbability` when What-If DSL is active.
   - Ensure this is the **only** place that captures effective probabilities into snapshot params.

**Risk:** Medium. Any remaining ad hoc probability logic must be removed carefully to avoid changing semantics of existing graphs. Tests around What-If and case edges are helpful here.

---

#### Step 6 – Delete Legacy Base Render Logic

After the new pipeline is stable and tested, aggressively remove dead surface area:

- **In `ConversionEdge.tsx`:**
  - Remove or narrow usage of:
    - `forceBaseStrokeColor` (no base edges rendered).
    - `suppressConditionalColors` (scenario overlays already control color via `scenarioColor`).
    - Any stroke/opacity hacks that only existed to hide base edges under overlays.

- **In `GraphCanvas.tsx`:**
  - Delete:
    - The old `displayEdges` merge logic.
    - Any comments/branches that refer to “no scenarios visible” as a special visual mode.

- **In CSS / other components:**
  - Remove styles that refer to legacy base edge z-indices or labels that are no longer rendered.

**Risk:** Low, if done after thorough testing; this is cleanup once the new path is proven.

---

### 4. ReactFlow Usage and Risks

ReactFlow remains central to the editor even after this refactor:

- **Still used for:**
  - Node and edge layout / positioning.
  - Zoom, pan, viewport management.
  - Selection state, keyboard shortcuts, reconnection interactions.
  - Event dispatch (click, double-click, context menu, drag, etc.).

- **What changes:**
  - The `edges` prop now always consists of **scenario-rendered edges**, with `current` as the only interactive layer.
  - The old notion of “base edges are what ReactFlow renders” is gone; base edges become internal, not visual.

**Key risks & mitigations:**

- **Risk:** Breaking selection/undo/redo if edge IDs change.
  - **Mitigation:** For `current` layer, reuse base edge IDs exactly; only overlays use prefixed IDs.

- **Risk:** Breaking reconnection if handlers are not correctly copied.
  - **Mitigation:** In `buildScenarioRenderEdges`, explicitly copy `onUpdate`, `onDelete`, `onDoubleClick`, `onSelect`, `onReconnect` from the base edge’s `data` for the `current` layer only.

- **Risk:** Performance regressions if `renderEdges` recalculates too often.
  - **Mitigation:** Keep `renderEdges` in a `useMemo` with a tight dependency list (graph, scenarios, visibleScenarioIds, whatIfDSL, etc.). Avoid capturing large objects unnecessarily.

- **Risk:** Visual regressions (e.g. What-If or case variants silently changing behavior).
  - **Mitigation:**
    - Add targeted logging for a small graph (like `test.json`) to compare effective probabilities and edge labels before/after.
    - Use the existing `EDGE_RENDERING_ARCHITECTURE.md` expectations as acceptance criteria.

---

### 5. Summary

This refactor moves the graph editor to a **single, scenario-based edge pipeline**:

- `current` is always rendered through the scenario logic and is the only interactive edge layer.
- Base edges are no longer drawn; they exist only as input to the scenario renderer.
- Selection, highlighting, What-If, and case variant behavior are unified in one path (`buildScenarioRenderEdges` + `ConversionEdge`).
- ReactFlow remains the engine for interaction and layout; we simply change the edges we feed it.

Once implemented, this removes the duplicated render logic that has been causing drift and makes future maintenance and bugfixing substantially simpler.*** End Patch***


