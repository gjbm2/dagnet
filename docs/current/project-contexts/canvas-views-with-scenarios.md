# Canvas Views with Scenario Persistence

**Status:** Design agreed, implementation pending
**Date:** 26-Mar-26

## Problem

Canvas views currently capture layout state (min/max, viewport, display modes) but not scenario state. A user who defines "View 1: Sankey with scenarios A+B" and "View 2: Data Depth with scenario C" cannot cycle between them in dashboard mode because scenario visibility is ephemeral tab state, not persisted on the graph.

For views to be truly useful as durable, shareable presentation configurations, they need to carry their scenario definitions with them.

## Architecture Context

### Where things live today

| What | Storage | Scope | On graph file? |
|---|---|---|---|
| Scenario definitions (params, meta, DSL) | IndexedDB `scenarios` table | Per-file, workspace-local | No |
| Scenario visibility/order/mode | `editorState.scenarioState` (IndexedDB `tabs`) | Per-tab | No |
| Canvas view definitions | `ConversionGraph.canvasViews[]` | Per-file | **Yes** |
| Active canvas view ID | `editorState.activeCanvasViewId` | Per-tab | No |

**Key tension:** Views are durable (graph file, committed to git). Scenarios are ephemeral (IndexedDB only). Views need to carry enough information to **recreate** scenarios, not reference them by ID.

### Graph store sharing

Two tabs of the same graph share the same Zustand store (`storeRegistry` keyed by `fileId` in `GraphStoreContext.tsx`). This means `setGraphDirect()` from either tab writes to the same object. Within a single JS thread there is no true concurrency, so writes are atomic per-callback.

### Existing rehydration patterns

1. **Share bundles** (`useShareBundleFromUrl.ts`): Already rehydrate scenarios from a serialised payload. Match existing by `(queryDSL, name, colour)`, create missing ones, regenerate deterministically. This is the closest pattern to what we need.

2. **Chart recipe scenarios** (`ChartRecipeScenario` in `chartRecipe.ts`): Canvas analyses in custom/fixed mode store scenario descriptors inline. These survive across sessions. Structure: `{ scenario_id, effective_dsl, name, colour, visibility_mode, is_live, params }`.

## Design

### Data model

New type stored on `CanvasView`:

```typescript
interface CanvasViewScenario {
  /** For live scenarios: the regenerable DSL fragment */
  queryDSL?: string;
  /** For static scenarios: the frozen parameter diff */
  params?: Record<string, any>;
  name: string;
  colour: string;
  is_live: boolean;
  visible: boolean;
  /** Position in layer stack (0 = bottom, base-adjacent) */
  order: number;
  /** Display basis: forecast+evidence, forecast-only, evidence-only */
  visibility_mode?: 'f+e' | 'f' | 'e';
  /** What-if DSL overlay if present */
  whatIfDSL?: string;
}
```

Added to `CanvasView`:
```
scenarios?: CanvasViewScenario[];
```

This is a **blueprint** — everything needed to recreate the scenario from scratch. Not a reference to an ephemeral ID.

### Capture (on view create / auto-save)

When a view is created or auto-saved (while active and unlocked):

1. Read current scenarios from `ScenariosContext`
2. Read current visibility state from `editorState.scenarioState`
3. For each scenario, serialise into a `CanvasViewScenario` descriptor:
   - Live scenarios: store `queryDSL`, `name`, `colour`, `is_live: true`
   - Static scenarios: store `params` (the diff), `name`, `colour`, `is_live: false`
   - From visibility state: `visible`, `order`, `visibility_mode`

### Rehydration (on view apply)

Follow the share bundle pattern:

1. **Match existing scenarios**: For each `CanvasViewScenario`, scan current `ScenariosContext.scenarios` by `(queryDSL, name)` for live scenarios, or by `(params content hash, name)` for static. If found, reuse the existing scenario's ID.

2. **Create missing**: For unmatched descriptors, call `createLiveScenario()` or equivalent. Assign the stored colour.

3. **Set visibility**: Write `scenarioState` to the tab via `tabOperations.updateTabState()` with the matched/created IDs, stored order, and stored visibility modes.

4. **Conditional regeneration**: Only regenerate if the effective DSL differs from what's cached (see below).

### Avoiding spurious fetches

**Requirement:** Switching views must not trigger a fetch if the scenario outcome state hasn't logically changed. ID changes alone must not cause fetches.

**Mechanism:** Before regenerating a scenario, compute its effective DSL signature:

- `effectiveDSL = smartMerge(inheritedDSL, scenarioQueryDSL)`
- `signature = querySignature(connection, topology, effectiveDSL)`

Compare against the scenario's current `deps_signature_v1`. If unchanged, skip regeneration. The existing `refreshFromFilesWithRetries` pattern already handles cache-first hydration when regeneration does run.

**Practical outcomes:**
- Same scenarios, same order across views: no fetch (signatures match)
- Same DSLs but different IDs (freshly created): no fetch (signatures still match after regen from cache)
- Genuinely different DSLs: regenerate, cache-first, API only on cache miss
- Same DSLs different visibility order: signatures may differ (inheritance changes) but data likely cache-covered

### The cascade on view switch

```
Apply view
  -> Rehydrate scenarios (match existing / create missing)
  -> Set scenarioState on tab (visibility, order, modes)
  -> ScenariosContext reacts to visibility change
  -> Conditional regeneration (signature comparison, cache-first)
  -> Composition pipeline recomposes with new visible set
  -> Charts reconcile (scheduleChartReconcile)
  -> Canvas + analyses re-render with new scenario configuration
```

This is the same cascade that happens today when toggling scenario visibility. The view automates the setup.

### Auto-save (while view active, not locked)

When scenario state changes during a session with a view active:

- Watch `scenarioState` changes on the tab (via an effect)
- Re-snapshot current scenarios from ScenariosContext into the view's `scenarios[]` array
- Use `setGraphDirect` to persist (same pattern as min/max auto-save)

**Interception point:** This is the trickiest wiring. Scenario visibility changes happen through `TabContext.operations`, not through window events in GraphCanvas. Options:
1. An effect in GraphCanvas watching `scenarioState` from the tab
2. A dedicated hook that bridges scenario state changes to view auto-save
3. Intercepting `toggleScenarioVisibility` etc. in TabContext to emit an event

Option 1 is simplest and consistent with existing patterns (GraphCanvas already watches tab state for other purposes).

## Edge Cases

### Two tabs, same view active, both unlocked

- Tab A and Tab B share the same graph store (same `fileId`)
- Tab A changes a scenario -> auto-saves to view -> writes to shared graph
- Tab B changes a scenario -> auto-saves to view -> overwrites Tab A's snapshot
- **Result:** Latest write wins. No merge attempted.

**Why this is acceptable:**
- Same class of issue as two tabs editing the same post-it text (already accepted)
- The lock feature exists precisely for protecting view state
- Different active views per tab avoids the conflict entirely (most common case)
- Within a single JS thread, writes are atomic per-callback (no partial state)

### View references a deleted scenario

When a scenario was captured in a view but has since been deleted from IndexedDB:
- On rehydration, the match step finds no existing scenario
- The create step recreates it from the stored blueprint
- For live scenarios with `queryDSL`, this works perfectly
- For static scenarios with `params`, the frozen diff is applied directly

### View applied in a fresh workspace (no IndexedDB history)

All scenarios in the view will be "unmatched" and created fresh. Regeneration runs for all live scenarios (cache-first; likely cache-miss on a fresh workspace, so API fetch occurs). This is correct behaviour — the view is bootstrapping the scenario environment from scratch.

### Scenario order affects inheritance

Live scenarios inherit from visible live scenarios below them in the stack. If View A has scenarios ordered [X, Y] and View B has [Y, X], the inheritance changes even though the same scenarios are visible. This may produce different effective DSLs, triggering regeneration. The cache layer handles this gracefully — if the data for the new effective DSL is already cached (common), no API call occurs.

### Base DSL changes between view captures

A view captures scenario DSLs, not effective DSLs. The effective DSL is `smartMerge(baseDSL, scenarioQueryDSL)`. If `baseDSL` has changed since the view was saved, the effective DSL on rehydration will differ from when the view was captured. This is **correct** — scenarios should inherit the current base, not a frozen one. Staleness detection (`deps_v1`) handles this naturally.

## Implementation Phases

1. **Type changes**: Add `CanvasViewScenario` to types (TS, Python, JSON schema)
2. **Capture**: On view create/save, snapshot scenarios from ScenariosContext
3. **Rehydrate**: On view apply, match/create scenarios (extract share-bundle pattern into reusable service)
4. **Conditional regen**: Compare DSL signatures before regenerating
5. **Auto-save**: Watch scenarioState and sync back to active view
6. **Tests**: Rehydration matching, signature comparison, round-trip create-apply, cross-view switching

Phase 3 is the most complex — it's the share bundle rehydration logic generalised into a `scenarioRehydrationService`. Phase 4 is where fetch-avoidance lives.

## Files Involved

| File | Change |
|---|---|
| `types/index.ts` | Add `CanvasViewScenario`, extend `CanvasView` |
| `lib/graph_types.py` | Mirror in Pydantic |
| `public/schemas/conversion-graph-1.1.0.json` | Mirror in JSON schema |
| `services/canvasViewService.ts` | Capture/restore scenario snapshots |
| `services/scenarioRehydrationService.ts` | New — match/create/regen logic (extracted from share bundle pattern) |
| `components/GraphCanvas.tsx` | Wire scenario capture/restore into view apply/create/auto-save |
| `contexts/ScenariosContext.tsx` | Possibly expose `createScenarioFromBlueprint()` for rehydration |
| `hooks/useShareBundleFromUrl.ts` | Refactor to share rehydration logic with new service |
