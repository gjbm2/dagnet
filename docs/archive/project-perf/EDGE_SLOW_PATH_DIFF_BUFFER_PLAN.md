## Edge Slow-Path Flicker – Back-Buffered Diff Swap Plan

### 1. Problem Statement

- **Symptom**: After certain graph edits (e.g. creating a new node), edges briefly redraw with `scaledWidth` collapsing to the minimum (visually ≈ 0) one or more times before settling at their correct widths.
- **Root cause (behavioural)**:
  - The **slow path** in `GraphCanvas.tsx` does a *full* `toFlow()` rebuild of all edges whenever it detects a “topology change”.
  - In the new architecture, actual edge widths and bundling are computed in `buildScenarioRenderEdges.ts`, *after* this rebuild.
  - That pipeline may take multiple render frames to converge (because it:
    - computes raw widths,
    - applies face/incident scaling and bundling,
    - re-applies scenario/what‑if overlays, etc.).
  - During those intermediate frames, ReactFlow sees a **partially-initialised** edge array where many edges have transient `scaledWidth` values that are effectively zero.
  - Because we **commit** the fully rebuilt edge array immediately, ReactFlow renders these transient widths, producing the visible “zero-width → grow back” flash.

The core issue is not just the presence of a slow path, but that it:

- Recreates the entire edge array up-front, and
- Immediately exposes that partially-initialised array to ReactFlow rendering.

We need a way to:

- Perform slow-path rebuilds **off-screen**, and
- Snap in only the **diff** between the old and new edges **atomically** within a single frame.


### 2. Goals and Non-Goals

- **Goals**
  - Avoid visible flicker / zero-width frames when:
    - Nodes are added / removed.
    - Edges are added / removed or reconnected to different nodes.
    - Conditional parameters change or case variants are added/removed (MSMDC-triggering cases).
  - Keep the slow path **semantically correct** (respect MSMDC, scenario overlays, what‑if DSL).
  - Preserve existing edge identity and stable `scaledWidth` / bundling for **unchanged** edges.
  - Make the commit of new edge data **atomic** from ReactFlow’s point of view (no partially-initialised buffer rendered).

- **Non-Goals**
  - We are *not* trying to re-introduce `calculateEdgeWidth` duplication in `GraphCanvas`. `buildScenarioRenderEdges.ts` remains the single source of truth for final widths.
  - We are *not* changing scenario semantics or what‑if math; only the **timing and shape** of the updates pushed to ReactFlow.


### 3. Current Architecture (Relevant Bits)

- **GraphCanvas**
  - Maintains `nodes` and `edges` as ReactFlow state.
  - Syncs external graph → ReactFlow via a `useEffect` with:
    - Fast path: update edge data in-place when there is no topology/position/handle change.
    - Slow path: call `toFlow()` and rebuild `nodes` + `edges` when topology changes.

- **buildScenarioRenderEdges.ts**
  - Takes `baseEdges` (ReactFlow edges), `nodes`, `graph`, `scenariosContext`, etc.
  - Computes:
    - Raw widths and probabilities.
    - Face/incident scaling and bundling.
    - Scenario overlays for each visible layer.
    - A final `renderEdges` array fed into ReactFlow.
  - This entire pipeline runs in a `useMemo` in `GraphCanvas`, so any change to `edges` may force a full recompute.

**Key consequence**: when slow path rebuilds `edges` via `toFlow`, we immediately feed that brand-new array to `buildScenarioRenderEdges`. Until that pipeline finishes, ReactFlow renders whatever partial `scaledWidth` state the pipeline has produced so far.


### 4. High-Level Solution – Back-Buffered Diff Swap

We introduce a **double-buffered edge rebuild** strategy for the slow path:

- **Visible buffer** (current behaviour):
  - `edges` – the array currently owned by ReactFlow and consumed by `buildScenarioRenderEdges`.

- **Back buffer** (new):
  - `slowPathEdgesBufferRef` – a ref that holds a fully rebuilt **candidate** edge array, not yet committed to ReactFlow.
  - `slowPathNodesBufferRef` – similarly, for nodes, if needed.

**Core idea**:

1. When slow path is required, we:
   - Run `toFlow(graphForBuild, ...)` and the entire edge anchor / bundling prep **into the back buffer**, **without** calling `setEdges` or `setNodes`.
   - Optionally run `buildScenarioRenderEdges` over that back buffer as well (purely in memory) if we want to pre-validate widths.

2. Once the back-buffered edges are **fully computed**, we:
   - Compute a **diff** between the visible buffer (`edges`) and the back buffer:
     - Edges to create.
     - Edges to remove.
     - Edges to update (handles / endpoints / MSMDC-relevant changes).
   - Preserve unchanged edges by **reusing their existing objects** wherever possible (to keep stable identity and `scaledWidth`), only swapping in new objects where truly required.
   - Apply this diff inside a **single `flushSync` + `requestAnimationFrame` window**, so ReactFlow sees one stable commit of the new edge set.

3. Until that swap happens, ReactFlow continues to render the **old** `edges`. There is **no intermediate render** where `scaledWidth` is zero just because the new pipeline isn’t finished yet.


### 5. Detailed Design

#### 5.1. New buffering + bookkeeping

In `GraphCanvas.tsx`:

- Add refs:

```ts
const slowPathEdgesBufferRef = useRef<any[] | null>(null);
const slowPathNodesBufferRef = useRef<any[] | null>(null);
const slowPathRebuildIdRef = useRef<number>(0); // monotonically increasing ID
const pendingSlowPathSwapRafRef = useRef<number | null>(null);
```

- The **visible** `nodes`/`edges` state remains unchanged; we never set them from partial slow-path work.


#### 5.2. Refine slow-path trigger conditions

We restore and tighten the original semantics from `main` plus MSMDC considerations:

- Compute:

```ts
const edgeCountChanged = edges.length !== (graph.edges?.length || 0);
const nodeCountChanged = nodes.length !== (graph.nodes?.length || 0);
const edgeIdsChanged = /* uuid mismatch, as today */;
const edgeHandlesChanged = /* fromHandle / toHandle mismatch, as today */;
const nodePositionsChanged = /* layout.x/y vs node.position, as today */;

const conditionalParamsOrCaseVariantsChanged = /* REINTRODUCE: compare graphEdge.conditional_p + case_variant/case_id vs edge.data */;
const caseNodeVariantsChanged = /* REINTRODUCE: compare case node variants in graph vs node.data.case.variants */;
```

- Then define:

```ts
const hasTopologyChange =
  edgeCountChanged ||
  nodeCountChanged ||
  edgeIdsChanged ||
  edgeHandlesChanged || // but only when endpoints change, not just face/handle cosmetic
  conditionalParamsOrCaseVariantsChanged ||
  caseNodeVariantsChanged;

const shouldTakeFastPath =
  !hasTopologyChange &&
  edges.length > 0 &&
  (isDraggingNodeRef.current || !nodePositionsChanged);
```

**Behaviour**:

- Fast path remains as today, but with MSMDC-sensitive changes routing to slow path.
- Slow path is only taken when there is a *true* topology or MSMDC-relevant change, as you outlined.


#### 5.3. Building the back buffer (slow path work)

Instead of immediately mutating state in the slow path, we:

1. Bump a local rebuild ID:

```ts
const rebuildId = ++slowPathRebuildIdRef.current;
```

2. Run the existing slow-path logic **into local arrays**:

```ts
// existing graphForBuild creation (Sankey handle coercion) kept as-is
const { nodes: newNodes, edges: newEdges } = toFlow(graphForBuild, { ... }, useSankeyView);

// existing Sankey node sizing (flowMass etc.) remain, but operate on newNodes copy
// ...

// existing edgesWithWidth/edgesWithOffsets/edgesWithAnchors pipeline,
// but instead of calling setNodes/setEdges, yield:
const bufferedNodes = nodesWithSelection;      // final nodes
const bufferedEdges = edgesWithAnchors;       // final base edges (with anchors + scaledWidth)
```

3. Store these in the back buffer **only if this rebuild is still the latest**:

```ts
if (rebuildId === slowPathRebuildIdRef.current) {
  slowPathNodesBufferRef.current = bufferedNodes;
  slowPathEdgesBufferRef.current = bufferedEdges;
}
```

> If a newer slow path starts while this one is still computing, the `rebuildId` check prevents an older result from being committed.


#### 5.4. Atomic diff swap into visible state

Once `slowPathEdgesBufferRef.current` is populated, we schedule an **atomic swap**:

1. Cancel any previous pending swap:

```ts
if (pendingSlowPathSwapRafRef.current != null) {
  cancelAnimationFrame(pendingSlowPathSwapRafRef.current);
}
```

2. Schedule a `requestAnimationFrame`:

```ts
pendingSlowPathSwapRafRef.current = requestAnimationFrame(() => {
  pendingSlowPathSwapRafRef.current = null;
  const bufferedEdges = slowPathEdgesBufferRef.current;
  const bufferedNodes = slowPathNodesBufferRef.current;
  if (!bufferedEdges || !bufferedNodes) return;

  flushSync(() => {
    // 1) Compute diff between current edges and bufferedEdges
    // 2) Build nextNodes, nextEdges
    // 3) setNodes(nextNodes); setEdges(nextEdges);
  });

  // Clear buffers after swap
  slowPathEdgesBufferRef.current = null;
  slowPathNodesBufferRef.current = null;
});
```

3. Within the `flushSync` block, compute a **structure-aware diff**:

```ts
// Map by UUID (edge.id)
const currentById = new Map(edges.map(e => [e.id, e]));
const bufferedById = new Map(bufferedEdges.map(e => [e.id, e]));

const nextEdges: any[] = [];

for (const [edgeId, bufferedEdge] of bufferedById) {
  const currentEdge = currentById.get(edgeId);

  if (!currentEdge) {
    // NEW EDGE: use bufferedEdge as-is
    nextEdges.push(bufferedEdge);
    continue;
  }

  const topologyChangedForEdge =
    currentEdge.source !== bufferedEdge.source ||
    currentEdge.target !== bufferedEdge.target ||
    currentEdge.sourceHandle !== bufferedEdge.sourceHandle ||
    currentEdge.targetHandle !== bufferedEdge.targetHandle;

  if (topologyChangedForEdge) {
    // REPLACED EDGE: adopt bufferedEdge (new topology)
    nextEdges.push(bufferedEdge);
  } else {
    // UNCHANGED TOPOLOGY: preserve identity + any live state, copy over derived props that can change
    nextEdges.push({
      ...currentEdge,
      data: {
        ...currentEdge.data,
        // Copy derived geometry from bufferedEdge
        sourceOffsetX: bufferedEdge.data?.sourceOffsetX,
        sourceOffsetY: bufferedEdge.data?.sourceOffsetY,
        targetOffsetX: bufferedEdge.data?.targetOffsetX,
        targetOffsetY: bufferedEdge.data?.targetOffsetY,
        scaledWidth: bufferedEdge.data?.scaledWidth,
        sourceBundleWidth: bufferedEdge.data?.sourceBundleWidth,
        targetBundleWidth: bufferedEdge.data?.targetBundleWidth,
        sourceBundleSize: bufferedEdge.data?.sourceBundleSize,
        targetBundleSize: bufferedEdge.data?.targetBundleSize,
        sourceFace: bufferedEdge.data?.sourceFace,
        targetFace: bufferedEdge.data?.targetFace,
        // Keep what-if DSL, etc., in sync
        whatIfDSL: bufferedEdge.data?.whatIfDSL,
        useSankeyView: bufferedEdge.data?.useSankeyView,
      },
    });
  }
}

// Optionally, handle removed edges: any edgeId in currentById but not in bufferedById is removed.
```

4. Nodes use a similar pattern:

```ts
setNodes(bufferedNodes);
setEdges(nextEdges);
```

Because this entire swap happens inside `flushSync` within an RAF, ReactFlow sees **one consistent edge set** per frame:

- No partially initialised edge arrays are ever rendered.
- Unchanged edges keep their identity; changed edges get atomically replaced.


### 6. Interaction with `buildScenarioRenderEdges`

`buildScenarioRenderEdges` today is driven by `renderEdges = useMemo(() => buildScenarioRenderEdges({ baseEdges: edges, ... }))`.

Under the back-buffered slow path:

- `edges` still transitions from “old base edges” → “new base edges”, but:
  - The transition only happens **once** per slow-path rebuild, at the point where the back buffer is complete.
  - We never expose the partially rebuilt edge set to ReactFlow.
- `buildScenarioRenderEdges` will recompute over the **new** base edges, but because that recomputation happens on a stable array:
  - We avoid the “zero, then grow back” oscillation driven by rapid, intermediate changes to `edges`.

If we find that scenario recomputation itself is heavy enough to cause its own visible stepping, we can apply a similar double-buffer pattern **inside** `buildScenarioRenderEdges` (compute `renderEdges` into a ref and only swap `renderEdges` when fully computed), but this plan starts by fixing the more egregious slow-path rebuild.


### 7. Implementation Steps

1. **Reintroduce and tighten slow-path conditions**
   - Restore `conditionalParamsOrCaseVariantsChanged` and `caseNodeVariantsChanged`.
   - Define `hasTopologyChange` exactly as per your criteria.
   - Ensure `shouldTakeFastPath` only falls back to slow path when `hasTopologyChange` is true.

2. **Add back-buffer refs and bookkeeping**
   - `slowPathEdgesBufferRef`, `slowPathNodesBufferRef`, `slowPathRebuildIdRef`, `pendingSlowPathSwapRafRef`.

3. **Refactor slow path to fill buffers, not state**
   - Move the current `toFlow` + Sankey sizing + offsets + anchors logic into a helper that returns `{ bufferedNodes, bufferedEdges }`.
   - In the Graph→ReactFlow sync effect, call this helper when `hasTopologyChange` is true, storing results into the refs.

4. **Implement atomic diff swap**
   - Inside an RAF + `flushSync`, compute the diff between `edges` and `bufferedEdges`.
   - Preserve unchanged edges’ identity; replace only edges whose topology/MSMDC-relevant data changed.
   - Commit `setNodes(bufferedNodes)` and `setEdges(nextEdges)` in a single flush.

5. **Cleanup + safety**
   - Clear buffers after each successful swap.
   - Cancel outstanding RAF if a new slow-path rebuild starts.
   - Guard against race conditions using `slowPathRebuildIdRef`.

6. **Testing**
   - **Create node**: verify edges do not visibly snap to zero width; only affected bundles adjust.
   - **Delete node**: verify removed edges disappear cleanly; remaining bundles reflow without flicker.
   - **Reconnect edge**: only that edge and its incident bundles visibly adjust; other edges retain widths.
   - **Edit conditional p / case variants**: verify slow path triggers but widths transition smoothly, with no multi-frame zeroing.
   - **Stress**: rapid add/remove/reconnect operations and pan/zoom; confirm no regressions in bead suppression or tooltip behaviour.


### 8. Future Extensions

- If `buildScenarioRenderEdges` itself becomes the bottleneck:
  - Apply the same **back-buffered diff swap** pattern at the level of `renderEdges` (scenario overlays), keeping `edges` as the stable input.
- If we introduce background workers or batched MSMDC computation, the back-buffer becomes even more valuable:
  - All heavy work can happen off the main visible edge array, with the UI only updating once per completed batch.


