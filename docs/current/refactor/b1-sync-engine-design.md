## B1 Sync Engine Extraction — Design Document

**Created:** 16-Mar-26
**Last updated:** 16-Mar-26 (pre-work investigations complete)
**Status:** Pre-work complete — ready for Sub-phase 1
**Parent:** `docs/current/refactor/src-slimdown.md` (Target 6, Phase B1 + Phase D merged)
**Risk level:** HIGH — this is the most coupled, most stateful subsystem in GraphCanvas

---

### 1. Purpose

Extract the Graph↔ReactFlow sync engine from `GraphCanvas.tsx` into a `useGraphSync` custom hook, while simultaneously formalising the implicit state machine that governs sync guard behaviour.

This is not a mechanical move. The extraction serves three goals:

1. **Reduce GraphCanvas line count** by ~1,790 lines (from ~3,779 to ~1,989)
2. **Make the sync guard state machine explicit** — replace ~9 independent boolean/numeric refs with a centralised guard system that has documented states, transitions, and invariants
3. **Establish a clear contract** between the sync engine and the rest of GraphCanvas, making the dependency flow auditable

The original slimdown plan separated these into Phase B1 (extraction) and Phase D (state machine). This design merges them because a mechanical extraction without formalisation would just relocate the problem — the implicit state machine would be equally opaque in a new file.

---

### 2. Current State Machine (As-Is)

#### 2.1 The Guard Refs

The sync engine's behaviour is controlled by 9 refs that act as boolean/numeric flags. Together they form an implicit mutual exclusion protocol — "don't run X while Y is in progress." No single location documents all valid states or transitions.

(Note: the original analysis identified 10 refs. Pre-work investigation 4.1 confirmed `isInSlowPathRebuildRef` is dead code — see section 2.5.)

**Primary sync guards (control which sync direction fires):**

| Ref | Purpose | Prevents |
|---|---|---|
| `isSyncingRef` | Graph→RF sync is in progress | RF→Graph sync from firing (prevents loop) |
| `isDraggingNodeRef` | User is dragging a node | Graph→RF sync from overwriting RF positions (forces fast path) |
| `isResizingNodeRef` | User is resizing a canvas object | Graph→RF sync from overwriting RF styles |

**Layout transaction guards (suppress cascading side-effects):**

| Ref | Purpose | Prevents |
|---|---|---|
| `sankeyLayoutInProgressRef` | Sankey layout is running | Reroutes, what-if recomputes, RF→Graph sync |
| `effectsCooldownUntilRef` | Timestamp-based suppression window | Same as above (time-based rather than flag-based) |
| `skipSankeyNodeSizingRef` | Sankey layout already set node sizes | Next Sankey what-if sizing effect from re-computing |

**Throttle gates:**

| Ref | Purpose | Prevents |
|---|---|---|
| `recomputeInProgressRef` | rAF-throttled what-if recompute in flight | Double-scheduling of what-if edge recompute |
| `visualWhatIfUpdateRef` | Edge update is visual-only (what-if) | RF→Graph sync from persisting visual-only changes |
| `sankeyUpdatingRef` | Sankey node sizing in progress | Re-entrant Sankey sizing |

#### 2.2 Transition Map

Every mutation of every guard ref, traced to its source location. Mutations confirmed as spurious by pre-work investigations are marked with ~~strikethrough~~ and annotated.

**`isSyncingRef`** — 6 mutation sites (3 legitimate, 3 spurious):

| # | Location | Transition | Trigger | Status |
|---|---|---|---|---|
| 1 | Main sync effect (line 1139) | false → true | Graph→RF sync begins | **Legitimate** |
| 2 | Main sync effect slow path (line 2354) | true → false | setTimeout(100ms) after slow path completes | **Legitimate** |
| 3 | `handleDeleteNode` (line 644) | any → false | Before setGraph() in node deletion | **Redundant** — see 2.5.3 |
| 4 | `handleDeleteEdge` (line 767) | any → false | Before setGraph() in edge deletion | **Redundant** — see 2.5.3 |
| 5 | Edge scaling effect (line 2482) | any → false | setTimeout(50ms) after edge scaling | **Redundant** — see 2.5.2 |
| 6 | RF→Graph sync effect (lines 2797, 2806) | false → true → false | During RF→Graph sync + setTimeout(0) | **Legitimate** |

**`isDraggingNodeRef`** — 3 mutation sites (2 legitimate, 1 latent bug):

| # | Location | Transition | Trigger | Status |
|---|---|---|---|---|
| 1 | `useNodeDrag.onNodeDragStart` | false → true | User begins dragging a node | **Legitimate** |
| 2 | `useNodeDrag.onNodeDragStop` | true → false | User releases the node | **Legitimate** |
| 3 | Main sync fast path (line 1312) | true → false | setTimeout(0) after fast path determines drag is in progress | **Latent bug** — see 2.5.1 |

**`isResizingNodeRef`** — 2 mutation sites (both clean):

| # | Location | Transition | Trigger | Status |
|---|---|---|---|---|
| 1 | `handleResizeStart` callback | false → true | User begins resizing a canvas object | **Legitimate** |
| 2 | `handleResizeEnd` callback | true → false | User releases the resize handle | **Legitimate** |

This is the cleanest guard. Set and cleared by symmetric callbacks. No timeouts. No secondary mutation sites.

**`sankeyLayoutInProgressRef`** — 3 mutation sites:

| # | Location | Transition | Trigger | Status |
|---|---|---|---|---|
| 1 | `performSankeyLayout` (line 3047) | false → true | Sankey layout begins | **Legitimate** |
| 2 | `performSankeyLayout` (line 3054) | (already true) → true | Redundant second set | **Redundant** (cosmetic) |
| 3 | `performSankeyLayout` (line 3080) | true → false | setTimeout(150ms) after layout completes | **Legitimate** |

This flag is read by `useEdgeRouting`, `onNodesChange`, the what-if recompute effect, and the RF→Graph sync effect. All of these are outside the sync engine proper.

**`effectsCooldownUntilRef`** — 2 mutation sites:

| # | Location | Transition | Trigger | Status |
|---|---|---|---|---|
| 1 | `performSankeyLayout` (line 3048) | 0 → now + 800ms | Sankey layout begins | **Legitimate** |
| 2 | `performSankeyLayout` (line 3081) | any → now + 500ms | setTimeout(150ms) after layout — extends cooldown | **Legitimate** |

Both mutations are in `performSankeyLayout`, which is NOT part of the sync engine. If the ref moves into the hook, `performSankeyLayout` needs write access via the guard API.

**`visualWhatIfUpdateRef`** — 2 mutation sites (both clean):

| # | Location | Transition | Trigger | Status |
|---|---|---|---|---|
| 1 | What-if rAF effect (line 2567) | false → true | What-if recompute begins | **Legitimate** |
| 2 | What-if rAF effect (line 2620) | true → false | setTimeout(0) after recompute | **Legitimate** |

**`recomputeInProgressRef`** — 2 mutation sites (both clean):

| # | Location | Transition | Trigger | Status |
|---|---|---|---|---|
| 1 | What-if rAF effect (line 2563) | false → true | rAF callback scheduled | **Legitimate** |
| 2 | What-if rAF effect finally block (line 2618) | true → false | rAF callback completes | **Legitimate** |

**`sankeyUpdatingRef`** — 2 mutation sites (both clean):

| # | Location | Transition | Trigger | Status |
|---|---|---|---|---|
| 1 | Sankey what-if effect (line 2660) | false → true | Sankey node sizing begins | **Legitimate** |
| 2 | Sankey what-if effect (line 2755) | true → false | setTimeout(0) after sizing | **Legitimate** |

**`skipSankeyNodeSizingRef`** — 2 mutation sites (both clean):

| # | Location | Transition | Trigger | Status |
|---|---|---|---|---|
| 1 | `performSankeyLayout` (line 3073) | false → true | Sankey layout sets node sizes upstream | **Legitimate** |
| 2 | Sankey what-if effect (line 2645) | true → false | Sizing effect reads and clears | **Legitimate** |

#### 2.3 Guard Check Sites

Every location where a guard ref is read to make a control flow decision:

| Guard | Check site | Decision |
|---|---|---|
| `isSyncingRef` | `onNodesChange` (line 427) | Skip reroute trigger if syncing |
| `isSyncingRef` | RF→Graph sync effect (line 2771) | Skip entire RF→Graph sync |
| `isDraggingNodeRef` | Main sync fast/slow decision (line 1267) | Force fast path during drag |
| `isDraggingNodeRef` | RF→Graph sync effect (line 2776) | Block RF→Graph sync during drag |
| `isResizingNodeRef` | Main sync fast/slow decision (line 1267) | Force fast path during resize |
| `isResizingNodeRef` | Fast path postit/container/analysis reconciliation | Preserve RF styles during resize |
| `isResizingNodeRef` | RF→Graph sync effect (line 2776) | Block RF→Graph sync during resize |
| `sankeyLayoutInProgressRef` | `onNodesChange` (line 428) | Suppress reroute during layout |
| `sankeyLayoutInProgressRef` | What-if recompute effect (line 2556) | Skip recompute during layout |
| `sankeyLayoutInProgressRef` | RF→Graph sync effect (line 2762) | Skip sync during layout |
| `effectsCooldownUntilRef` | `onNodesChange` (line 428) | Suppress reroute during cooldown |
| `effectsCooldownUntilRef` | What-if recompute effect (line 2556) | Skip recompute during cooldown |
| `effectsCooldownUntilRef` | RF→Graph sync effect (line 2762) | Skip sync during cooldown |
| `visualWhatIfUpdateRef` | RF→Graph sync effect (line 2766) | Skip sync for visual-only updates |
| `recomputeInProgressRef` | What-if recompute effect (line 2560) | Skip if already in progress |
| `sankeyUpdatingRef` | Sankey what-if effect (line 2642) | Skip if already updating |
| `skipSankeyNodeSizingRef` | Sankey what-if effect (line 2642) | Skip sizing after layout |

#### 2.4 Known Issues in Current State Machine

1. **No invalid-state detection.** There is no assertion or warning if contradictory states occur (e.g. `isSyncingRef=true` while `isDraggingNodeRef=true` is transitioning to false via setTimeout).

2. **setTimeout-based clearing with magic delays.** Five different delay values (0, 50, 100, 150, 250ms) are used. None are tied to observable completion events. A slow frame or React batching change could violate the assumptions.

3. **Cross-owner mutations (confirmed spurious — see 2.5).** The fast path clears `isDraggingNodeRef` (owned by `useNodeDrag`), `handleDeleteNode`/`handleDeleteEdge` clear `isSyncingRef` (owned by sync engine), and the edge scaling effect clears `isSyncingRef` (never set by that effect). All three are either redundant or latent bugs.

4. **Defensive redundant clears (confirmed — see 2.5).** The edge scaling effect clears `isSyncingRef` defensively. `handleDeleteNode`/`handleDeleteEdge` clear `isSyncingRef` redundantly. These suggest a history of "flag got stuck" bugs being patched locally rather than fixing the root cause.

#### 2.5 Pre-Work Investigation Results (Completed 16-Mar-26)

**2.5.1 `isInSlowPathRebuildRef` — DEAD CODE (Investigation 4.1)**

The ref is initialised to `false` at line 513 and has a `setTimeout` that sets it to `false` at line 2348. It is read by `buildScenarioRenderEdges` at line 3361. But **it is never set to `true` anywhere in the codebase**. The `isInSlowPathRebuild` flag passed to the render pipeline is always `false`.

**Action:** Remove the ref, its setTimeout clear, and hard-code `false` in the `buildScenarioRenderEdges` call. This reduces the guard count from 10 to 9.

**2.5.2 `isDraggingNodeRef` Fast-Path Clear — LATENT BUG (Investigation 4.2)**

The fast path at line 1312 does `setTimeout(() => { isDraggingNodeRef.current = false }, 0)`. This can fire **while the user is still dragging**, creating a race condition:

1. User starts dragging → `isDraggingNodeRef = true` (useNodeDrag)
2. External graph mutation → sync effect fires → fast path taken (because dragging)
3. Fast path schedules `setTimeout(0)` → `isDraggingNodeRef = false`
4. User is still dragging but flag is now `false`
5. Next graph mutation → sync effect may take slow path → overwrites node positions → visual snap

`useNodeDrag.onNodeDragStop` intentionally keeps the flag true (comment: *"Keep isDraggingNodeRef.current = true - sync effect will clear it after taking fast path"*). So `onNodeDragStop` expects the sync fast path to clear it — but the fast path clears it too early via setTimeout(0), before the drag has ended.

**Why this hasn't been observed in practice:** The race requires two separate graph mutations to occur during a single drag — the first triggers the fast path (which schedules the clear), and the second arrives after the setTimeout(0) fires but before `onNodeDragStop`. This is rare but possible with external data operations, live-share syncs, or concurrent edits from PropertiesPanel.

**Action:** Remove the `setTimeout(() => { isDraggingNodeRef.current = false }, 0)` from the fast path. `isDraggingNodeRef` should only be cleared by `useNodeDrag.onNodeDragStop`. The guard API will enforce single-owner semantics: only `guards.endInteraction('drag')` clears the flag, and only `useNodeDrag` calls that function.

**2.5.3 Edge Scaling `isSyncingRef` Clear — UNNECESSARY (Investigation 4.3)**

The edge scaling effect (line 2482) clears `isSyncingRef` even though it never sets it. Added in October 2025 as part of a systematic "defensive clear" pattern. The edge scaling effect's dependencies (`useUniformScaling`, `massGenerosity`, `edges`, `nodes`) are independent of graph synchronisation.

**Action:** Remove the defensive `isSyncingRef.current = false` and its surrounding setTimeout from the edge scaling effect. The guard API will not expose a sync-clear mechanism to this effect.

**2.5.4 `handleDeleteNode`/`handleDeleteEdge` Safety Valve — REDUNDANT (Investigation 4.4)**

Both callbacks clear `isSyncingRef.current = false` before calling `setGraph()`. The comment says "Clear the sync flag to allow graph→ReactFlow sync" — but this is **misleading**. Investigation confirmed:

- The Graph→ReactFlow sync effect (line 1026) does **NOT** check `isSyncingRef`. The comment at line 1031–1032 explicitly states: *"Don't block external graph changes (like undo) even if we're syncing ReactFlow→Graph."*
- `isSyncingRef` only guards the RF→Graph direction (line 2771), not Graph→RF.
- Therefore, clearing `isSyncingRef` in `handleDeleteNode` does **nothing** to enable the Graph→RF sync that needs to run after the deletion.
- The flag would be cleared anyway by the pending `setTimeout(100ms)` from the previous sync cycle.

**Action:** Remove the `isSyncingRef.current = false` from both `handleDeleteNode` and `handleDeleteEdge`. The guard API's originally proposed `clearSyncFlag()` method is no longer needed and has been removed from the design.

**2.5.5 Baseline Tests — ALL GREEN (Investigation 4.6)**

75 tests across 11 files, 0 failures. Clean baseline recorded 16-Mar-26.

| Test suite | Tests | Status |
|---|---|---|
| buildScenarioRenderEdges.test.ts | 1 | Pass |
| buildScenarioRenderEdges.efGeometry.test.ts | 2 | Pass |
| EdgeBeads.test.tsx | 31 | Pass |
| EdgeBeads.probabilityMode.test.tsx | 1 | Pass |
| EdgeBeads.probabilityMode.scalarEvidence.test.tsx | 2 | Pass |
| EdgeBeads.derivedBracket.test.tsx | 1 | Pass |
| EdgeBeads.derivedForecastBracket.test.tsx | 3 | Pass |
| ConversionEdge.sankeyParity.test.tsx | 1 | Pass |
| graphStoreSyncIntegration.test.ts | 7 | Pass |
| edgeReconnection.test.ts | 8 | Pass |
| smoke.test.ts | 18 | Pass |
| **Total** | **75** | **All pass** |

#### 2.6 Revised setTimeout Catalogue (Post-Investigation)

After removing spurious mutations, the legitimate timeouts are:

| Delay | Location | Purpose | Status |
|---|---|---|---|
| 0ms | RF→Graph `isSyncingRef` clear | Clear sync flag after RF→Graph sync completes | Legitimate |
| 0ms | Sankey `sankeyUpdatingRef` clear | Clear re-entrancy gate | Legitimate |
| 0ms | `visualWhatIfUpdateRef` clear | Clear visual-only flag after queue flush | Legitimate |
| 100ms | Slow path `isSyncingRef` clear | Let cascading updates complete before allowing RF→Graph sync | Legitimate |
| 150ms | `sankeyLayoutInProgressRef` clear | Let Sankey effects settle | Legitimate |
| 250ms | Initial fitView | Wait for nodes to populate | Legitimate |
| ~~0ms~~ | ~~Fast path `isDraggingNodeRef` clear~~ | ~~Clear drag flag after sync~~ | **Remove — latent bug** |
| ~~50ms~~ | ~~Edge scaling `isSyncingRef` clear~~ | ~~Defensive clear~~ | **Remove — unnecessary** |
| ~~50ms~~ | ~~`isInSlowPathRebuildRef` clear~~ | ~~Let scenario pipeline settle~~ | **Remove — dead code** |

---

### 3. Proposed Design (To-Be)

#### 3.1 Design Principles

1. **All guard state in one place.** The sync engine hook owns all guard refs. External code that needs to influence guards (e.g. drag start, resize start, Sankey layout) does so through named functions returned by the hook — never by directly mutating refs.

2. **Transitions are named operations.** Instead of `isSyncingRef.current = true`, external code calls `guards.beginSync()`. The guard system validates the transition and can warn on illegal states (dev-only).

3. **Timeout-based clearing is consolidated.** Each "end" transition that currently uses setTimeout is channelled through a single mechanism so delay values are visible in one place and can be tuned or replaced with observable completion events later.

4. **Single-owner semantics.** Each guard has exactly one "owner" that sets it and clears it. Cross-owner mutations (identified as bugs/redundancies in section 2.5) are eliminated.

5. **No behavioural change** (except the 3 spurious mutation removals documented in 2.5, which are bug fixes or dead code removal).

#### 3.2 Guard Domains

The 9 surviving refs group into 3 logical domains:

**Domain 1 — Sync direction control**
- `syncing`: Graph→RF sync is active (blocks RF→Graph direction)
- `interacting`: User is dragging or resizing (forces fast path, blocks RF→Graph)

**Domain 2 — Layout transaction**
- `layoutTransaction`: Sankey layout is running (blocks reroutes, effects, RF→Graph sync)
- `cooldownUntil`: Timestamp-based effect suppression (supplements layoutTransaction)
- `skipSankeyNodeSizing`: One-shot flag to skip next Sankey sizing cycle

**Domain 3 — Throttle gates**
- `recomputeInProgress`: rAF throttle for what-if edge recompute
- `visualOnlyUpdate`: Edge update is visual-only (blocks RF→Graph sync)
- `sankeyUpdating`: Sankey node sizing in progress (blocks re-entrant sizing)

#### 3.3 Guard API

The hook returns a `guards` object with named transition functions. Each function is a simple ref mutation today, but the indirection creates a single point of control for future improvements (dev-mode invariant checks, transition logging, etc.).

**Transition functions (called by external code):**
- `guards.beginInteraction(kind: 'drag' | 'resize')` — called by useNodeDrag.onNodeDragStart and handleResizeStart
- `guards.endInteraction(kind: 'drag' | 'resize')` — called by useNodeDrag.onNodeDragStop and handleResizeEnd
- `guards.beginLayoutTransaction(cooldownMs: number)` — called by performSankeyLayout
- `guards.endLayoutTransaction(extendCooldownMs: number)` — called by performSankeyLayout's setTimeout
- `guards.skipNextSankeyNodeSizing()` — called by performSankeyLayout

**Query functions (called by external code to check guard state):**
- `guards.isBlocked()` — returns true if layout transaction or cooldown is active (used by onNodesChange, what-if effect, etc.)
- `guards.isInteracting()` — returns true if dragging or resizing
- `guards.isSyncing()` — returns true if Graph→RF sync is in progress
- `guards.isEffectsCooldownActive()` — returns true if timestamp-based cooldown is active (used by useEdgeRouting and onNodesChange)

**Internal transitions (called only within the sync engine hook):**
- beginSync / endSync — managed entirely within the main sync effect
- beginWhatIfRecompute / endWhatIfRecompute — managed within the what-if rAF effect
- markVisualOnly / clearVisualOnly — managed within the what-if effect
- beginSankeyUpdate / endSankeyUpdate — managed within the Sankey sizing effect

Note: `clearSyncFlag()` (originally proposed for handleDeleteNode/handleDeleteEdge) has been removed from the API — investigation 2.5.4 confirmed those safety valves are redundant.

#### 3.4 What the Hook Owns vs What Stays in GraphCanvas

**Moves into `useGraphSync` hook:**

All 9 sync-related effects:
1. Main Graph→ReactFlow sync effect (lines 1026–2357)
2. Strip per-node draggable/selectable overrides (lines 2359–2367)
3. Force re-route on Sankey toggle (lines 2373–2388)
4. Hidden state effect (lines 2391–2421)
5. Initial fitView + graph-change reset (lines 2423–2460)
6. Edge scaling recalculation (lines 2463–2550)
7. What-if edge recompute (lines 2552–2634)
8. Sankey what-if node sizing (lines 2636–2757)
9. ReactFlow→Graph sync (lines 2759–2809)

All 9 guard refs.

All sync-internal refs:
- `lastSyncedGraphRef`, `lastSyncedReactFlowRef`
- `snapshotBootCycleKeyRef`, `snapshotBootCycleIdRef`
- `prevSankeyViewRef`, `prevShowNodeImagesRef`
- `hasInitialFitViewRef`, `currentGraphIdRef`
- `lastRenderEdgesRef`
- `lastScalingRef`, `lastWhatIfVersionRef`
- `whatIfStartRef`

The `dagnet:forceRedraw` event listener (line 968–978).

The `autoEditPostitIdRef` and `autoSelectAnalysisIdRef` refs — declared in the hook, returned for useCanvasCreation to write to.

**Stays in GraphCanvas:**

- ReactFlow state: `nodes`, `edges`, `setNodes`, `setEdges`, `onNodesChangeBase`, `onEdgesChangeBase` — these are ReactFlow's own state hooks and must be called at the component level. The sync hook receives them as parameters.
- All CRUD callbacks: `handleUpdateNode`, `handleDeleteNode`, `handleUpdateEdge`, `handleDeleteEdge`, `handleUpdatePostit`, `handleDeletePostit`, `handleUpdateContainer`, `handleDeleteContainer`, `handleUpdateAnalysis`, `handleDeleteAnalysis`, `handleReconnect`, `handleResizeStart`, `handleResizeEnd` — these are passed to the hook as callback parameters.
- `calculateEdgeOffsets` — a useCallback that the sync engine calls. Passed as parameter.
- `onNodesChange` and `onEdgesChange` — the custom wrappers that call guard query functions before triggering reroutes. These stay in GraphCanvas but call `guards.isBlocked()` / `guards.isSyncing()` etc.
- All context menu state, selection handlers, layout functions, context menus JSX — unrelated to sync.
- `reactFlowWrapperRef` — DOM ref for the canvas wrapper, used by lasso selection.

#### 3.5 Hook Parameters and Return Value

**Parameters (passed from GraphCanvas):**

The hook receives all external dependencies it needs. These fall into categories:

- Graph data: `graph`, `setGraph`, `setGraphDirect`, `graphStoreHook`
- ReactFlow state: `nodes`, `edges`, `setNodes`, `setEdges`
- View preferences: `useSankeyView`, `showNodeImages`, `useUniformScaling`, `massGenerosity`, `effectiveWhatIfDSL`, `overridesVersion`
- Tab/scenario context: `tabId`, `effectiveActiveTabId`, `tabs`, `scenariosContext`
- CRUD callbacks: all the `handleUpdate*`, `handleDelete*`, `handleReconnect`, `handleResizeStart`, `handleResizeEnd` callbacks
- Canvas callbacks: `onDoubleClickNode`, `onDoubleClickEdge`, `onSelectEdge`, `onSelectedAnnotationChange`
- Extracted hooks: `setForceReroute` (from useEdgeRouting), `fitView`
- Utilities: `calculateEdgeOffsets`, `calculateOptimalHandles`
- `activeElementTool` (for strip-draggable effect)

**Return value:**

- `guards` — the guard API object (see section 3.3)
- `autoEditPostitIdRef` — MutableRefObject for useCanvasCreation to write
- `autoSelectAnalysisIdRef` — MutableRefObject for useCanvasCreation to write
- `lastRenderEdgesRef` — MutableRefObject for the `renderEdges` useMemo to write (sync engine reads during slow-path geometry merge)

---

### 4. Pre-Work (Risk Mitigation Before Extraction)

#### 4.1–4.4: COMPLETED — see section 2.5 for results.

Summary of actions to take before Sub-phase 1:
- **Remove `isInSlowPathRebuildRef`** — dead code (never set to true)
- **Remove fast-path `isDraggingNodeRef` setTimeout(0) clear** — latent race condition bug
- **Remove edge scaling `isSyncingRef` defensive clear** — unnecessary workaround
- **Remove `handleDeleteNode`/`handleDeleteEdge` `isSyncingRef` clears** — redundant (Graph→RF sync doesn't check this flag)
- **Remove redundant second `sankeyLayoutInProgressRef = true`** — cosmetic duplicate at line 3054

These 5 removals are preparatory cleanup that simplifies the extraction. Each is independently testable — remove one, run core tests, confirm green, move to the next.

#### 4.5 setTimeout Delay Catalogue: COMPLETED — see section 2.6.

#### 4.6 Baseline Test Snapshot: COMPLETED — see section 2.5.5.

75 tests, 0 failures. Clean baseline recorded 16-Mar-26.

#### 4.7 Manual Smoke Test Checklist

To be performed by the user after the preparatory cleanup (section 4.1–4.4 removals) and again after each sub-phase:

- Load a graph → verify nodes/edges render (slow path)
- Edit a node label in PropertiesPanel → verify canvas updates (fast path)
- Drag a node → verify edge positions update during drag (fast path + reroute)
- Resize a container → verify container size changes smoothly
- Undo/redo → verify canvas updates (dagnet:forceRedraw → slow path)
- Toggle Sankey mode → verify node sizes change and edges reroute
- Delete a node → verify connected edges are removed
- Toggle image view → verify node sizes change
- Apply what-if DSL → verify edge widths update

---

### 5. Implementation Approach

#### 5.0 Preparatory Cleanup (before Sub-phase 1)

Remove the 5 spurious mutations identified in section 2.5. Each removal is a single-line (or few-line) change. Sequence:

1. Remove `isInSlowPathRebuildRef` declaration, its setTimeout clear, and hard-code `false` in the `buildScenarioRenderEdges` call → run core tests
2. Remove fast-path `isDraggingNodeRef` setTimeout(0) clear (lines 1309–1314) → run core tests
3. Remove edge scaling `isSyncingRef` defensive clear (line 2480–2484) → run core tests
4. Remove `handleDeleteNode` `isSyncingRef` clear (line 644) and fix comment → run core tests
5. Remove `handleDeleteEdge` `isSyncingRef` clear (line 767) and fix comment → run core tests
6. Remove redundant `sankeyLayoutInProgressRef = true` at line 3054 → run core tests
7. User performs manual smoke test checklist (section 4.7)

After this step, the guard state machine is cleaner: 9 guards, no cross-owner mutations, no defensive workarounds.

#### 5.1 Sub-phase 1: Guard API (no code movement)

Create the guard API as a standalone module (`canvas/syncGuards.ts`) that wraps the existing refs. At this point, the refs still live in GraphCanvas. The guard API is a thin wrapper — `beginSync()` sets `isSyncingRef.current = true`, `endSync()` clears it via the same setTimeout pattern. No behaviour changes.

Then, one by one, replace every raw ref mutation in GraphCanvas with a guard API call. After each replacement, run the core tests. At the end of this sub-phase:
- Every guard ref is only mutated through the guard API
- The guard API module is importable and testable in isolation
- GraphCanvas still has all the same code, but ref mutations are routed through named functions
- Dev-mode warnings for illegal transitions can be added at this point

#### 5.2 Sub-phase 2: Extract effects into hook

Move the 9 sync-related effects, all sync-internal refs, and the guard API state into `canvas/useGraphSync.ts`. GraphCanvas calls the hook and receives back the guard API + the autoEdit/autoSelect refs + lastRenderEdgesRef.

This is the mechanical extraction. Because Sub-phase 1 already established the guard API boundary, the extraction is a matter of moving code and wiring parameters — no guard logic changes.

#### 5.3 Sub-phase 3: Clean up cross-boundary ref access

After extraction, verify:
- No code outside the hook directly reads or writes any guard ref
- All guard queries go through the returned `guards` object
- The `onNodesChange` handler in GraphCanvas calls `guards.isBlocked()` / `guards.isSyncing()` instead of reading individual refs
- `performSankeyLayout` calls `guards.beginLayoutTransaction()` instead of setting refs directly
- `useNodeDrag` receives `guards.beginInteraction('drag')` and `guards.endInteraction('drag')` instead of the raw ref
- `useEdgeRouting` receives `guards.isBlocked` and `guards.isEffectsCooldownActive` instead of raw refs

#### 5.4 What NOT to Change

- The fast path / slow path decision logic
- The topology change detection algorithm
- The Sankey mass calculation (even though it's duplicated 3 times — that's a separate cleanup)
- The snapshot boot tracing
- The container colour injection logic
- The geometry merge anti-flicker technique
- Any surviving setTimeout delay values (catalogue them, don't change them)
- The dependency arrays of any useEffect

---

### 6. Risks and Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Preparatory cleanup (spurious mutation removal) introduces regression | Low | Medium | Each removal is independent, tested separately. All are confirmed spurious by investigation. |
| 2 | Guard API wrapper introduces subtle timing difference | Low | High | Sub-phase 1 replaces refs one at a time with tests after each. Any timing change is immediately caught. |
| 3 | Effect dependency arrays change during extraction | Medium | High | Explicitly verify every dependency array before and after extraction. Use a diff checklist. |
| 4 | Closure capture changes when effects move into hook | Medium | High | Verify that every value captured by a closure in the current code is either passed as a hook parameter or declared within the hook. |
| 5 | `onNodesChange` reroute-suppression breaks | Medium | Medium | This handler reads guard state. After extraction it must call `guards.isBlocked()` instead of reading refs directly. Test by dragging nodes and verifying reroute behaviour. |
| 6 | `autoEditPostitIdRef` / `autoSelectAnalysisIdRef` ownership confusion | Low | Medium | Declared in hook, returned as MutableRefObjects. useCanvasCreation writes to them, sync engine reads and clears them. The flow is: creation hook sets → sync engine consumes and clears → next sync cycle sees null. |
| 7 | `lastRenderEdgesRef` bidirectional dependency | Medium | Medium | Declared in hook, returned as MutableRefObject. Written by `renderEdges` useMemo (stays in GraphCanvas), read by sync engine slow path (moves into hook). |
| 8 | Render loop from hook parameter changes | Medium | High | The hook's parameters must be stable references (useCallback, useMemo, refs). If a parameter is recreated every render, it will cause the hook's effects to re-fire continuously. |

---

### 7. Test Strategy

#### 7.1 Core Tests (Must Pass After Each Step)

All tests listed in the slimdown doc's Target 6 core tests section:
- `canvas/__tests__/buildScenarioRenderEdges.test.ts`
- `canvas/__tests__/buildScenarioRenderEdges.efGeometry.test.ts`
- `edges/__tests__/EdgeBeads.test.tsx`
- `edges/__tests__/EdgeBeads.probabilityMode.test.tsx`
- `edges/__tests__/EdgeBeads.probabilityMode.scalarEvidence.test.tsx`
- `edges/__tests__/EdgeBeads.derivedBracket.test.tsx`
- `edges/__tests__/EdgeBeads.derivedForecastBracket.test.tsx`
- `edges/__tests__/ConversionEdge.sankeyParity.test.tsx`
- `services/__tests__/graphStoreSyncIntegration.test.ts`
- `services/__tests__/edgeReconnection.test.ts`

Safety net:
- `tests/smoke.test.ts`

Baseline: 75 tests, 0 failures (16-Mar-26).

#### 7.2 Manual Smoke Tests

The user flow checklist (section 4.7) must be performed:
- After preparatory cleanup (section 5.0)
- After Sub-phase 2 (extraction)
- After Sub-phase 3 (cleanup)

#### 7.3 Guard API Unit Tests (New, After Sub-Phase 1)

The guard API module (`canvas/syncGuards.ts`) can be tested in isolation:
- Verify transition functions set/clear the correct state
- Verify `isBlocked()` returns true when layout transaction or cooldown is active
- Verify `isInteracting()` distinguishes drag from resize
- Verify dev-mode warnings fire for illegal transitions (e.g. `endSync()` when not syncing)

These are pure unit tests — no React, no ReactFlow, no IndexedDB.

---

### 8. Success Criteria

After all sub-phases:

1. GraphCanvas is reduced by ~1,790 lines (from ~3,779 to ~1,989)
2. All 9 guard refs are encapsulated in the `useGraphSync` hook and mutated only through the guard API
3. No code outside the hook directly reads or writes guard refs
4. Every guard transition is a named function call, visible in the guard API module
5. Dev-mode warnings exist for illegal state transitions
6. 3 spurious mutations removed (latent bug fix + 2 dead code removals)
7. All core tests pass (75/75)
8. Manual smoke tests confirm identical visual behaviour
9. The setTimeout delay catalogue (section 2.6) is preserved as a comment in the guard API module for future reference

---

### 9. Relationship to Slimdown Phases

This design merges the original Phase B1 (extraction) and Phase D (state machine formalisation) from the slimdown doc. After this work:

- Phase B1 is complete (sync engine extracted)
- Phase D is partially complete (guard API established, transitions named, dev-mode warnings added)
- The remaining Phase D work (replacing boolean flags with a typed discriminated union mode value) becomes a future enhancement that builds on the guard API. The guard API is the prerequisite — it centralises all mutations — and the discriminated union is a further refinement that constrains the state space. This can be done later without risk because the guard API already provides the single point of control.

---

### 10. Resolved Questions

All 5 original open questions have been resolved by pre-work investigations:

| # | Question | Resolution |
|---|---|---|
| 1 | Is `isInSlowPathRebuildRef` live? | **Dead code. Remove it.** Never set to true anywhere. |
| 2 | Is fast-path `isDraggingNodeRef` clear needed? | **Latent bug. Remove it.** Creates race where flag is false during active drag. |
| 3 | Is edge scaling `isSyncingRef` clear needed? | **Unnecessary. Remove it.** Historical defensive workaround from Oct 2025. |
| 4 | Is `handleDeleteNode` safety valve needed? | **Redundant. Remove it.** Graph→RF sync doesn't check `isSyncingRef`. |
| 5 | `lastRenderEdgesRef` flow direction? | **Hook owns it, returns as MutableRefObject.** GraphCanvas `renderEdges` useMemo writes to it; sync engine slow path reads it. |

### 11. Remaining Open Question

1. **`onNodesChange` ownership.** Should the enhanced `onNodesChange` handler (which reads guard state for reroute suppression) stay in GraphCanvas or move into the hook? It currently depends on `autoReroute`, `snapToGuides`, `activeElementTool`, and `applySnapToChanges` — none of which are sync-related. Current recommendation: keep it in GraphCanvas with guard queries via `guards.isBlocked()` / `guards.isSyncing()`.
