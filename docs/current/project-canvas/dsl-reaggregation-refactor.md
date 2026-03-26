# DSL Re-aggregation Refactor

**Status:** Design, pending approval
**Date:** 26-Mar-26
**Triggered by:** Canvas views exposing the architectural gap — graph edge re-aggregation is coupled to the WindowSelector component, which isn't mounted in dashboard mode.

## Problem

When `currentDSL` changes (from view switch, share bundle, or user editing dates), the graph edge probabilities need to be re-aggregated from cached parameter files using the new date window. Today this logic lives inside the WindowSelector component as two `useEffect` hooks:

1. **Planner analysis** (~line 720): watches `currentDSL`, calls `windowFetchPlannerService.analyse()` to check if data is covered
2. **Auto-aggregation** (~line 802): if planner says covered, runs `fetchItems(items, { mode: 'from-file' })` to re-aggregate from file → `setGraph()`

This means:
- In dashboard mode (no WindowSelector mounted), DSL changes don't update the graph
- Any headless/programmatic DSL change (views, automation) relies on the WindowSelector being mounted
- The WindowSelector is both a UI control AND a data pipeline trigger — these should be separate concerns

## Design

### New hook: `useDSLReaggregation`

Lives at `GraphEditor` level (always mounted). Watches `currentDSL` on the graph store and reactively re-aggregates when it changes.

**Responsibilities (extracted from WindowSelector):**
- Run `windowFetchPlannerService.analyse(graph, dsl, trigger)` when DSL changes
- If coverage is `stable` or `stale`: run `fetchItems(autoAggregationItems, { mode: 'from-file' })` → `setGraph()`
- If coverage is `not_covered`: expose this status for the WindowSelector to display (Fetch button)
- Deduplicate via `lastAutoAggregatedDSL` ref
- Skip on `initial_load` (trust persisted graph state)

**State exposed:**
- `plannerResult`: the coverage analysis result
- `isAggregating`: boolean, true during from-file refresh
- `lastAggregatedDSL`: the DSL that was last successfully aggregated

**Does NOT do:**
- API fetches (that stays with the WindowSelector's "Fetch Data" button)
- DSL editing UI (stays with WindowSelector)
- Date/context parsing (stays with WindowSelector)

### WindowSelector changes

- Removes the planner analysis `useEffect` (~line 720-753)
- Removes the auto-aggregation `useEffect` (~line 802-861)
- Reads `plannerResult` from the new hook (via context or prop)
- Keeps: date pickers, context selectors, Fetch Data button, DSL display
- The Fetch Data button still calls `executeFetchPlan` for API-sourced fetches
- Coverage status (`buttonNeedsAttention`, etc.) derived from the hook's `plannerResult`

### GraphEditor changes

- Mounts `useDSLReaggregation` hook (or wraps in a provider)
- Passes `plannerResult` down to WindowSelector

### handleApplyView changes

- Removes ALL fetch/aggregation logic
- Just sets `currentDSL` on the graph store
- The `useDSLReaggregation` hook reacts to the DSL change and handles re-aggregation automatically
- This is the same codepath whether manual click, auto-cycle, or any other trigger

### What stays the same

- `windowFetchPlannerService.analyse()` — unchanged, just called from a different location
- `fetchItems()` with `mode: 'from-file'` — unchanged
- `getItemsForFromFileLoad()` — unchanged
- The graph store's `currentDSL` / `setCurrentDSL` — unchanged
- API fetch pipeline (`executeFetchPlan`) — stays in WindowSelector
- Parameter file format — unchanged

## Sequencing

1. Create `useDSLReaggregation` hook with the extracted logic
2. Mount it in `GraphEditor`
3. Pass `plannerResult` to WindowSelector
4. Remove the two effects from WindowSelector (planner + auto-agg)
5. Remove the fetch hack from `handleApplyView` in GraphCanvas
6. Test: manual DSL change via WindowSelector still works
7. Test: view switch updates graph (with and without WindowSelector mounted)
8. Test: dashboard auto-cycle updates graph

## Risk

- The planner analysis and auto-aggregation effects interact with several refs and state variables in WindowSelector (`isAggregatingRef`, `lastAutoAggregatedDSLRef`, `lastAggregatedDSLRef`, `graphRef`, `plannerResult`). Extracting cleanly requires understanding all these interactions.
- The `fetchItems` call in WindowSelector uses the `useFetchData` hook which provides graph/setGraph/dsl getters. The new hook needs the same access pattern.
- The `setGraph` callback in the auto-aggregation effect goes through the full mutation pipeline. The new hook needs access to the same `setGraph`.

## Files involved

| File | Change |
|---|---|
| `hooks/useDSLReaggregation.ts` | New — extracted planner + auto-agg logic |
| `components/editors/GraphEditor.tsx` | Mount the hook, pass plannerResult down |
| `components/WindowSelector.tsx` | Remove planner + auto-agg effects, read from hook |
| `components/GraphCanvas.tsx` | Remove fetch hack from handleApplyView |
