## Edge Render Pipeline & State Model (GraphCanvas + Scenarios)

This document describes **how edges are rendered** in the graph editor today:

- What the **sources of truth** are (GraphStore, ReactFlow, ScenariosContext, Tab state, What-If).
- How those sources are transformed into **rendered edges** inside `GraphCanvas`.
- How **scenarios** are constructed, composed, and visualised.
- Where **geometry** (widths, offsets, bundles) is computed and stored.

The goal is to have a **clear, shared mental model** before any refactor of edge width / scenario rendering.

---

## 1. State Owners & Sources of Truth

### 1.1 GraphStore (`graph`)

Owner: `GraphStoreContext`  
Used by: `GraphCanvas`, `ScenariosContext`, scenario tools, analysis.

- **Type**: `Graph` (see `graph-editor/src/types`).
- **Contents** (high‑level):
  - `graph.nodes`: canonical node list (`uuid`, `id` (human), `label`, `layout.{x,y}`, `entry`, `type`, `case`, `tags`, etc).
  - `graph.edges`: canonical edge list
    - `uuid`: unique edge ID.
    - `id`: human readable ID; used as scenario key when present.
    - `from`, `to`: node references (uuid or `id`).
    - `fromHandle`, `toHandle`: which face/handle on each node.
    - `p`: probability params (`mean`, `stdev`, `locked`, `conditional_p`).
    - `cost_gbp`, `cost_time`, `costs`: cost parameters.
    - `case_id`, `case_variant`: for case edges.
  - `graph.metadata`, `graph.policies`, etc.

**Graph is the semantic source of truth**:

- Topology (nodes + edges).
- Raw parameters (probability, cost, case configuration).
- Node layout positions (via `layout`).

Graph **does not** store ReactFlow‑level geometry (offsets, scaledWidth).

### 1.2 ReactFlow state (`nodes`, `edges`)

Owner: `GraphCanvas` via `useNodesState`, `useEdgesState`.

```ts
const [nodes, setNodes, onNodesChangeBase] = useNodesState<Node[]>([]);
const [edges, setEdges, onEdgesChangeBase] = useEdgesState<Edge[]>([]);
```

These are **ReactFlow's working copies** of the graph:

- `nodes`: positions, selection, ReactFlow IDs, some view state in `node.data`.
- `edges`: connections between RF nodes
  - `id`: RF edge id (uuid, matching `graph.edges[...].uuid`).
  - `source`, `target`: RF node ids (uuid).
  - `sourceHandle`, `targetHandle`: faces (`left`, `right-out`, etc).
  - `data`: edge metadata used by components (probabilities, costs, case info, etc).

Important:

- `nodes` / `edges` are **derived** from `graph` via `toFlow` (slow path).
- However, they can also be **mutated locally** by user interactions (drag, reconnect) before syncing back to `graph` via `fromFlow`.

### 1.3 Scenarios (`ScenariosContext`)

Owner: `ScenariosContext` (`graph-editor/src/contexts/ScenariosContext.tsx`).

Key state:

- `baseParams: ScenarioParams`
- `currentParams: ScenarioParams`
- `scenarios: Scenario[]`
- `currentColour: string`
- `baseColour: string`

Where:

- `ScenarioParams` is `{ edges: Record<string, EdgeParamDiff>, nodes: Record<string, NodeParamDiff> }`.
- Each `Scenario` has:
  - `id`, `name`, `colour`, `createdAt`, `version`.
  - `params: ScenarioParams` (a **diff overlay**).
  - `meta`: source (`all`/`diff`, `base`/`visible`), what‑if info, window, context.

#### 1.3.1 Base vs Current params

From `ScenariosContext`:

- On file/graph change:
  - `baseParams` is set from `extractParamsFromGraph(graph)` **once per file**.
  - `currentParams` is updated from the graph for **every graph update**.
- On subsequent graph updates (same file):
  - Only `currentParams` is refreshed; `baseParams` is left alone.

Interpretation:

- `baseParams`: "baseline" parameters for the file.
- `currentParams`: "current live" parameters extracted from graph.

#### 1.3.2 Scenario overlays (`Scenario.params`)

Scenarios are created mainly via:

- `createSnapshot(options, tabId, whatIfDSL?, ...)`
- `createBlank(name, tabId)`
- Manual editing via YAML/JSON (with HRN notations).

**Snapshot creation semantics**:

1. Decide **baseline for diff**:
   - If `options.source === 'base'`:
     - Diff against `baseParams`.
   - Else (`source === 'visible'`):
     - Compose `baseParams` with **all current scenarios** to get a "visible" baseline:
       - `baseForDiff = composeParams(baseParams, scenarios.map(s => s.params))`.

2. Compute **effective current params**:
   - Default: `effectiveCurrentParams = currentParams`.
   - If `whatIfDSL` is provided:
     - Recompute **edge probabilities** using `computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL })`.
     - Bake in **case variant overrides** into `nodes[caseNodeId].case.variants` by setting the selected variant to weight `1` and others to `0`.
     - Result is a `ScenarioParams` representing the **visually effective** state under What‑If.

3. Compute diff:

```ts
const diff = computeDiff(effectiveCurrentParams, baseForDiff, options.type, diffThreshold);
```

4. Save `diff` as `scenario.params`.

So each scenario’s `params` encodes **parameter differences** relative to either `base` or `base + existing overlays`, potentially after baking What‑If into probabilities and case variants.

#### 1.3.3 Composition (`composeParams` and `composeVisibleParams`)

The core composition function is `composeParams(base, overlays)` in `CompositionService`:

- Start with `deepClone(base)`.
- For each overlay in `overlays` (in order), apply `mergeScenarioParams(acc, overlay)`:
  - **Edges**:
    - `source.edges[edgeId] === null` → remove edge param entry.
    - Else, merge into `result.edges[edgeId]`:
      - `p`: shallow merge; `null` clears.
      - `cost_gbp`, `cost_time`: shallow merge; `null` clears.
      - `conditional_p`: nested merge; `null` for a condition removes it.
  - **Nodes**:
    - `source.nodes[nodeId] === null` → remove node param entry.
    - `entry`, `costs`: shallow merges; `null` clears.
    - `case`: `null` clears; `case.variants` **replaces** variants list.

`ScenariosContext.composeVisibleParams(visibleScenarioIds)` then does:

- Filter `scenarios` to only visible IDs (in order).
- Compose:

```ts
const overlays = visibleScenarios.map(s => s.params);
return composeParams(baseParams, overlays);
```

This is used by tools like **flatten**, but **rendering uses a per‑layer composition** (see §3.3) rather than this global compose.

### 1.4 Tab / Scenario UI State (`TabContext`)

Owner: `TabContext` (`graph-editor/src/contexts/TabContext.tsx`).

Relevant fields in each tab’s `editorState`:

- `scenarioState.visibleScenarioIds: string[]`
  - Scenario IDs as understood by the UI:
    - `'current'`
    - `'base'`
    - and user scenario IDs (`scenario-...`).
- `scenarioState.visibleColourOrderIds: string[]`
  - Colour order mapping; used when assigning colours.
- `whatIfDSL` (per tab)
- `rfViewport` (ReactFlow viewport per tab)
- `hiddenNodes` (set of human-readable node IDs to hide).

`GraphCanvas` reads these via:

- `viewPrefs` (ViewPreferencesContext) for scaling/visibility prefs.
- `tabForThisCanvas.editorState` for scenario and What‑If state.

### 1.5 What‑If (`WhatIfContext` and `computeEffectiveEdgeProbability`)

The **what‑if engine** lives in `graph-editor/src/lib/whatIf.ts` and is used from:

- `buildScenarioRenderEdges` for the `current` layer.
- `ScenariosContext.createSnapshot` when baking a snapshot with active What‑If.

Core function:

```ts
computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL }, pathContext?)
```

Responsibilities:

- Parse What‑If DSL into overrides and conditionals.
- Apply:
  - Direct edge probability overrides.
  - Case node variant overrides.
  - Conditional probabilities (dependent on nodes visited along the path).
- Return the **effective probability** used for rendering and analysis.

For the `current` layer, this is the **only probability source** (scenario params are not consulted).

### 1.6 View Preferences (`ViewPreferencesContext`)

Owner: `ViewPreferencesContext`.

Key flags used in rendering:

- `useUniformScaling: boolean`
- `massGenerosity: number`
- `autoReroute: boolean`
- `useSankeyView: boolean`

These control:

- How edge widths are mapped from mass/probability.
- Whether offsets are computed once or in Sankey mode.
- Whether nodes/edges get auto‑rerouted on position changes.

---

## 2. Graph ↔ ReactFlow Synchronisation

### 2.1 ReactFlow local state

`GraphCanvas.CanvasInner` creates local RF state:

- `nodes`, `edges` via `useNodesState`/`useEdgesState`.
- These are the arrays that ReactFlow mutates during interactions (dragging, reconnecting, selection).

### 2.2 Graph → ReactFlow sync (slow path vs fast path)

Owner: **Graph→ReactFlow sync effect** in `GraphCanvas.tsx` (`useEffect` around the large block starting near `L1282`).

Logic:

1. On `graph` change (`graph` from `GraphStoreContext`):
   - Serialize `graph` and compare with `lastSyncedGraphRef.current` to detect real changes.
   - Determine:
     - `edgeCountChanged`
     - `nodeCountChanged`
     - `nodePositionsChanged`
     - `edgeIdsChanged`
     - `edgeHandlesChanged`
     - `nodePropertiesChanged`

2. Decide **fast path vs slow path**:

   - **Fast path** (`shouldTakeFastPath`):
     - Topology unchanged: no edge or node count change; no ID or handle change.
     - Node positions either unchanged, or we are in a drag where ReactFlow’s positions are considered authoritative.
   - **Slow path**:
     - Any of the above changed (new edges, deleted edges, handle changes, etc).

#### 2.2.1 Fast path (topology unchanged)

Fast path updates:

- Edge data in place:

  ```ts
  setEdges(prevEdges => {
    const result = prevEdges.map(prevEdge => {
      // Find corresponding graphEdge by UUID / id / from->to
      // Update prevEdge.data with latest graphEdge properties (probabilities, costs, case info)
    });
    // Historically: calculateEdgeOffsets(result, nodes, MAX_WIDTH) and attach offsets
    // Goal: in refactor, stop doing geometry here and let the render pipeline handle it.
  });
  ```

- Node data if properties changed (label, tags, absorbing, etc):
  - `setNodes(prevNodes => prevNodes.map(...))`

The fast path **should not own geometry**; it’s supposed to only refresh semantic data, preserving RF component identity.

#### 2.2.2 Slow path (topology or handle changes)

Slow path does a full rebuild:

1. Preserve selection:
   - `selectedNodeIds`, `selectedEdgeIds`.

2. Optional Sankey handle normalization:
   - If `useSankeyView`, adjust `graph.edges` handles to left/right only.

3. Convert `graph` → ReactFlow:

   ```ts
   const { nodes: newNodes, edges: newEdges } = toFlow(graphForBuild, callbacks, useSankeyView);
   ```

4. Restore selection and apply Sankey node sizing (if enabled).

5. Add `calculateWidth` stubs to edges (or preserve existing `calculateWidth` contract).

6. Compute edge offsets for all edges via `calculateEdgeOffsets(edgesWithWidthFunctions, nodesWithSelection, effectiveMaxWidth)`.

7. Attach offsets, bundle metadata, and anchors to edge `data`.

8. Optionally add (currently disabled) legacy scenario overlays (old pipeline; replaced by `buildScenarioRenderEdges`).

9. **Geometry merge** for stability:
   - `lastRenderEdgesRef.current` tracks the last committed **render** edges (from `buildScenarioRenderEdges`).
   - The slow path merges geometry (scaledWidth, offsets) from previous render edges into the newly built edges when topology hasn't changed, to avoid visual flicker.

10. `setEdges(mergedEdges)` and reset sync flags.

Important: even in the slow path, **rendered geometry should ultimately be driven by the scenario pipeline**, not by ad‑hoc geometry writes in the sync effect. The merge currently uses `lastRenderEdgesRef`, which is already scenario‑aware.

### 2.3 ReactFlow → Graph sync

Owner: **ReactFlow→Graph sync effect** near `L2472`.

Triggered when `nodes` or `edges` change (user interactions):

- Skips if:
  - Sankey layout in progress.
  - Effects cooldown active.
  - `visualWhatIfUpdateRef.current` (visual-only updates).
  - `isSyncingRef.current` is true (to avoid feedback loops).
  - Node list is empty but graph has nodes (initialization guard).

Otherwise:

```ts
const updatedGraph = fromFlow(nodes, edges, graph);
if (updatedGraph && !sameAsLast) {
  isSyncingRef.current = true;
  setGraph(updatedGraph);
  // reset flag after a microtask
}
```

This is the **only path** by which ReactFlow node positions and edge handle changes become persistent in `graph`.

---

## 3. Scenario Render Pipeline (`buildScenarioRenderEdges`)

### 3.1 Entry point from `GraphCanvas`

`GraphCanvas` uses a memoized pipeline:

```ts
const renderEdges = React.useMemo(() => {
  if (!scenariosContext) return edges; // fallback: no scenario system

  const result = buildScenarioRenderEdges({
    baseEdges: edges,
    nodes,
    graph,
    scenariosContext,
    visibleScenarioIds,
    visibleColourOrderIds,
    whatIfDSL: effectiveWhatIfDSL,
    useUniformScaling,
    massGenerosity,
    useSankeyView,
    calculateEdgeOffsets,
    tabId,
    highlightMetadata,
    isInSlowPathRebuild: isInSlowPathRebuildRef.current
  });

  // Track RENDER edges (scenario-aware) for slow-path geometry merge
  lastRenderEdgesRef.current = result;
  return result;
}, [...dependencies...]);
```

Then `<ReactFlow>` renders `renderEdges`:

```tsx
<ReactFlow
  nodes={nodes}
  edges={renderEdges}
  ...
/>
```

So `renderEdges` is the **effective, scenario-aware edge array** used by the canvas.

### 3.2 Layers to render

`buildScenarioRenderEdges` accepts:

- `baseEdges: Edge[]` (ReactFlow edges state; one edge per graph edge).
- `nodes`, `graph`, `scenariosContext`, and `visibleScenarioIds`.

It computes the set of **layers** to draw:

```ts
const layersToRender = visibleScenarioIds.includes('current')
  ? [...visibleScenarioIds.filter(id => id !== 'current'), 'current']  // current last
  : [...visibleScenarioIds, 'current'];  // current hidden, but still rendered (ghosted)
```

Rules:

- `visibleScenarioIds` comes from tab state (`scenarioState.visibleScenarioIds`).
- `'current'` is **always** rendered as a layer:
  - If visible, it appears in the stack.
  - If not visible, it is added at the end with low opacity (ghost view).
- Layers are rendered in order of `layersToRender`, with `zIndex = layerIndex`.
  - `current` is always the **topmost** layer (last).

Per‑layer opacity:

```ts
const numVisibleLayers = visibleScenarioIds.length;
const baseOpacityTarget = 0.8;
const dynamicLayerOpacity = 1 - Math.pow(1 - baseOpacityTarget, 1 / numVisibleLayers);
```

Special handling:

- `current` hidden: opacity fixed to `HIDDEN_CURRENT_OPACITY = 0.05`.

### 3.3 Per‑layer parameter composition

For each `scenarioId` in `layersToRender`:

1. Select colour:

   ```ts
   const colour = getScenarioColour(scenarioId, isVisible);
   ```

   - If **exactly one layer** is visible and this is that layer: forced grey `#808080`.
   - `current` uses `scenariosContext.currentColour`.
   - `base` uses `scenariosContext.baseColour`.
   - Other IDs look up `scenario.colour` from `scenariosContext.scenarios`.

2. Compute **composedParams** for this layer:

   ```ts
   let composedParams = baseParams;
   if (scenarioId === 'base') {
     composedParams = baseParams;
   } else if (scenarioId === 'current') {
     composedParams = baseParams; // params not used; current is graph+whatIf
   } else if (scenario) {
     const currentIndex = visibleScenarioIds.indexOf(scenarioId);
     const layersBelowIds = visibleScenarioIds
       .slice(0, currentIndex)
       .filter(id => id !== 'current' && id !== 'base');

     const layersBelow = layersBelowIds
       .map(id => scenarios.find(s => s.id === id)?.params)
       .filter((p): p is ScenarioParams => p !== undefined);

     // Base + all visible overlays below + this scenario
     composedParams = composeParams(baseParams, layersBelow.concat([scenario.params]));
   } else {
     continue; // unknown id
   }
   ```

So **per layer**:

```text
Layer 'base':   params = Base
Layer 'current':params = Base (but probabilities come from graph+whatIf, not params)
Layer S_k:      params = compose(Base, visibleBelowScenarios, S_k.params)
```

This is **not** the same as `composeVisibleParams(visibleScenarioIds)`, which composes all visible overlays at once. Rendering does per‑layer composition to reflect the visual stacking and below/above semantics.

### 3.4 Probability resolver per layer

Within each layer, `buildScenarioRenderEdges` defines `probResolver(e: Edge)` to compute the probability for that edge in that layer:

```ts
const probResolver = (e: Edge) => {
  if (scenarioId === 'current') {
    const edgeId = e.id || `${e.source}->${e.target}`;
    return computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL });
  }

  const flowEdgeUuid = (e.data as any)?.uuid;
  const graphEdge = graph.edges?.find(ge => ge.uuid === flowEdgeUuid || ge.id === e.id);
  if (!graphEdge) return 0;

  const key = graphEdge.id || graphEdge.uuid;
  let probability = composedParams.edges?.[key]?.p?.mean;
  if (typeof probability !== 'number') return 0;

  // Case variant weight
  if (graphEdge.case_variant) {
    // deduce case node id (case_id or source node case.id)
    // look up composedParams.nodes[caseNodeKey].case.variants
    // multiply probability by variantWeight from that scenario overlay
  }

  return probability;
};
```

Semantics:

- **Current layer**:
  - Uses the **live graph** and `whatIfDSL` via `computeEffectiveEdgeProbability`.
  - This includes:
    - case variant overrides,
    - conditional probabilities based on path context,
    - scenario‑independent what‑if overlays.

- **Base & scenario layers**:
  - Use the frozen scenario param overlays (`composedParams`) to get `p.mean` and any case variant weights.
  - This decouples scenario visualization from the current graph/what‑if state.

### 3.5 Mass helpers and raw width computation

#### 3.5.1 Residual mass helpers

`buildResidualHelpers(probResolver)` constructs:

- Maps of outgoing/incoming edges per node from `rfEdges` (`baseEdges`).
- A DFS `dfs(nodeId)` computing residual mass at node:

  - If the node is the **start node**, residual mass = `1.0`.
  - Otherwise:
    - For each incoming edge from predecessor `pred`:
      - Let `massAtPred = dfs(pred)`.
      - Let `denom = sum(probResolver(oe) for oe in outgoing[pred])`.
      - Contribution to this node = `massAtPred * (probResolver(inEdge) / denom)`.
    - Sum all contributions.

The **start node** is chosen from `rfNodes`:

```ts
const startNode = rfNodes.find(
  n => n.data?.entry?.is_start === true || (n.data?.entry?.entry_weight || 0) > 0
);
const startNodeId = startNode?.id || null;
```

This ties scenario/rendering back to the same notion of start nodes used in Sankey sizing and analysis.

#### 3.5.2 Raw width per edge (`computeOverlayWidthRaw`)

For each edge `e` in `baseEdges`, raw width is computed as:

```ts
if (useUniformScaling) return 10; // constant

const edgeProb = probResolver(e);

if (!startNodeId) {
  // fallback: sibling proportion at source
  const siblings = rfEdges.filter(se => se.source === e.source);
  const denom = siblings.reduce((sum, se) => sum + (probResolver(se) || 0), 0);
  if (denom === 0) return MIN_WIDTH;
  const proportion = edgeProb / denom;
  return MIN_WIDTH + proportion * (effectiveMaxWidth - MIN_WIDTH);
}

// with start node
const residualAtSource = helpers.dfs(e.source);
if (residualAtSource === 0) return MIN_WIDTH;
const actualMass = residualAtSource * edgeProb;

let displayMass: number;
if (effectiveMassGenerosity === 0) {
  displayMass = actualMass;
} else if (effectiveMassGenerosity === 1) {
  // purely local distribution at source
  const siblings = rfEdges.filter(se => se.source === e.source);
  const denom = siblings.reduce((sum, se) => sum + (probResolver(se) || 0), 0);
  if (denom === 0) return MIN_WIDTH;
  displayMass = edgeProb / denom;
} else {
  const power = 1 - effectiveMassGenerosity;
  displayMass = Math.pow(actualMass, power);
}

return MIN_WIDTH + displayMass * (effectiveMaxWidth - MIN_WIDTH);
```

Where:

- `effectiveMaxWidth` is either `MAX_EDGE_WIDTH` or `SANKEY_MAX_EDGE_WIDTH`, depending on `useSankeyView`.
- `effectiveMassGenerosity` is `0` in Sankey view, or `massGenerosity` otherwise.

This entire computation is **layer‑specific** because it depends on the layer’s `probResolver`.

### 3.6 From raw widths to scenario render edges

For each layer:

1. **Precompute raw widths** into `rawWidths: Map<edgeId, number>`.

2. **Build draft overlay edges** from `baseEdges`:

   - For each `edge` in `baseEdges`:
     - `freshComputed = rawWidths.get(edge.id) || MIN_WIDTH`.
     - `preScaled = freshComputed` (merged widths only used diagnostically).
     - Build `edgeParams` from `composedParams.edges`.
     - Compute `overlayOpacity` from visibility + current/hidden rules.
     - Determine `isCurrent = scenarioId === 'current'`.
     - Compute highlight metadata (`isHighlighted`, `highlightDepth`, `isSingleNodeHighlight`) from `highlightMetadata`.
     - **Strip stale width fields**:
       - From `edge.data`: `scaledWidth`, `calculateWidth`.
       - From the top level: `scaledWidth` (geometry from `calculateEdgeOffsets`).
     - Construct a new edge:

       ```ts
       {
         ...cleanEdge, // no top-level scaledWidth
         id: isCurrent ? edge.id : `scenario-overlay__${scenarioId}__${edge.id}`,
         selectable: isCurrent,
         reconnectable: isCurrent,
         data: {
           ...cleanEdgeData, // no data.scaledWidth
           scenarioOverlay: !isCurrent,
           scenarioColour: colour,
           strokeOpacity: overlayOpacity,
           originalEdgeId: edge.id,
           probability: edgeParams?.p?.mean ?? edge.data?.probability ?? 0.5,
           stdev: edgeParams?.p?.stdev ?? edge.data?.stdev,
           calculateWidth: () => preScaled,
           effectiveWeight: edgeProb,
           renderFallbackTargetArrow: preScaled < MIN_CHEVRON_THRESHOLD,
           highlight flags on current,
           interaction handlers only on current,
         },
         style: { stroke: colour, strokeOpacity: overlayOpacity, pointerEvents: isCurrent ? 'auto' : 'none' },
         zIndex: layerIndex,
       }
       ```

3. **Log "BEFORE calculateEdgeOffsets"** for diagnostics on the first draft edge of the first layer(s).

4. **Compute offsets via `calculateEdgeOffsets`**:

   ```ts
   const overlayWithOffsets = calculateEdgeOffsets(draftOverlayEdges, rfNodes, effectiveMaxWidth);
   ```

   This returns edges decorated with:
   - `sourceOffsetX/Y`, `targetOffsetX/Y`.
   - `scaledWidth` (bundling width).
   - bundling metadata (bundle widths, sizes, isFirst/isLast, sourceFace/targetFace).

5. **Log "AFTER calculateEdgeOffsets"** for first edge in each relevant layer for debugging.

6. **Attach offsets and final widths**:

   - For each `oe` in `overlayWithOffsets`:

     ```ts
     const correctWidth = oe.data?.calculateWidth ? oe.data.calculateWidth() : oe.scaledWidth;

     const finalEdge = {
       ...oe,
       scaledWidth: correctWidth,  // override bundling width at top level
       data: {
         ...oe.data,
         sourceOffsetX: oe.sourceOffsetX,
         sourceOffsetY: oe.sourceOffsetY,
         targetOffsetX: oe.targetOffsetX,
         targetOffsetY: oe.targetOffsetY,
         isPanningOrZooming,
         scaledWidth: correctWidth, // final visual width
         sourceBundleWidth: oe.sourceBundleWidth,
         targetBundleWidth: oe.targetBundleWidth,
         sourceBundleSize: oe.sourceBundleSize,
         targetBundleSize: oe.targetBundleSize,
         isFirstInSourceBundle: oe.isFirstInSourceBundle,
         isLastInSourceBundle: oe.isLastInSourceBundle,
         isFirstInTargetBundle: oe.isFirstInTargetBundle,
         isLastInTargetBundle: oe.isLastInTargetBundle,
         sourceFace: oe.sourceFace,
         targetFace: oe.targetFace,
       },
     } as Edge;
     ```

   - Log "FINAL EDGE" for first edge to ensure top‑level `scaledWidth` and `data.scaledWidth` match.

7. **Push `finalEdge` into `renderEdges`**.

At the end, `buildScenarioRenderEdges` returns the concatenation of all layers’ edges (`renderEdges`).

---

## 4. Geometry & Width Ownership (Current vs Desired)

### 4.1 Where geometry is *currently* computed / written

Today, geometry (offsets and widths) is touched in multiple places:

- `calculateEdgeOffsets` in `GraphCanvas.tsx`:
  - Computes offsets and a bundling `scaledWidth` based on `edge.data.calculateWidth()` and scaling modes.
  - Returns edges with:
    - `sourceOffsetX/Y`, `targetOffsetX/Y`.
    - bundle metadata (`sourceBundleWidth`, `sourceBundleSize`, etc).
    - `scaledWidth` (bundling width).

- `buildScenarioRenderEdges`:
  - Uses `calculateEdgeOffsets` on per‑layer overlay edges.
  - Sets **final visual width** at:
    - `finalEdge.scaledWidth` (top level).
    - `finalEdge.data.scaledWidth`.
  - The semantics here are **scenario-aware** and mass‑based.

- Graph→ReactFlow sync (fast and slow paths) historically:
  - Called `calculateEdgeOffsets` directly on `edges`.
  - Wrote geometry (offsets, bundle widths, `scaledWidth`) back into:
    - `edges` state.
    - `edge.data.scaledWidth` in some code paths.

- Scaling and what‑if effects:
  - `useEffect` on `useUniformScaling`/`massGenerosity` recomputed offsets and updated `edges`.
  - What‑if recompute effect also recomputed offsets and mutated `edges`.

This leads to **multiple writers** of width/geometry in the system, some scenario‑aware (inside `buildScenarioRenderEdges`), some not (effects working directly on `edges`).

### 4.2 Ground rules for refactoring

Given the scenario machinery:

- `buildScenarioRenderEdges` is the **correct, scenario‑aware place** to:
  - Compose parameters per layer.
  - Resolve per‑layer probabilities (graph+what‑if vs scenario overlays).
  - Compute mass‑based raw widths.
  - Call `calculateEdgeOffsets` to get offsets and bundling metadata.
  - Decide final visual width (`scaledWidth`) for each render edge.

Therefore, any refactor of edge widths / geometry should:

- Make `buildScenarioRenderEdges` (plus `calculateEdgeOffsets` inside that pipeline) the **single owner** of visual width in the normal render path.
- Treat `nodes`, `edges`, `graph`, `scenariosContext`, `visibleScenarioIds`, `whatIfDSL`, `viewPrefs` as **inputs** to the scenario pipeline.
- Ensure:
  - No independent effect re-runs `calculateEdgeOffsets` and mutates `edges` geometry in ways that bypass scenario composition.
  - Fast path only updates semantic data on `edges`/`nodes`, not geometry.
  - Slow path rebuilds `nodes`/`edges` topology and then lets the scenario pipeline (`renderEdges` memo) derive geometry, possibly using `lastRenderEdgesRef` for merge.

This document is descriptive, not prescriptive; it captures the **current behavior and invariants** so that any future refactor can be checked against the actual scenario semantics before changing code paths.



