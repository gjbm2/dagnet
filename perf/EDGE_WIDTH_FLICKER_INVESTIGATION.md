# Edge Width Flicker During Slow-Path Rebuilds - Investigation Summary

## Problem Statement

When creating a new node (or other topology changes), edge widths visually flash/reset, appearing to briefly shrink before recovering. This is visually distracting and makes the UI feel broken.

## Root Cause Analysis

### What Changed Since "Scenarios, paulatim sed firmitur" (commit `f0f9253`)

At commit `f0f9253`, the slow-path rebuild worked like this:

1. **Graph→ReactFlow sync effect** triggers when graph changes
2. Slow path runs `toFlow(graphForBuild, ...)` → gets `newNodes` and `newEdges`
3. **Within the same effect**:
   - Adds `calculateWidth: () => calculateEdgeWidth(...)` to each edge
   - Runs `calculateEdgeOffsets(...)` with those width functions
   - Attaches `scaledWidth` + bundle metadata to edge data
   - Commits `setNodes(...)` and `setEdges(...)` with fully-formed edges
4. ReactFlow **never saw intermediate edges without proper widths**

### What's Different Now

On the current branch:

1. Width calculation was **moved out** of the slow-path effect into `buildScenarioRenderEdges.ts`
2. The slow path now:
   - Runs `toFlow` → gets base `newNodes` and `newEdges`
   - Attaches minimal metadata (anchors, faces, offsets from `calculateEdgeOffsets`)
   - Commits `setEdges(edgesWithAnchors)` with **geometry-only edges** (no final widths)
3. **Separately**, in a `useMemo`:
   - `renderEdges = buildScenarioRenderEdges({ baseEdges: edges, ... })`
   - This computes scenario layers + final widths
4. ReactFlow renders `renderEdges` (not `edges`)

This **two-stage pipeline** creates a gap where:
- Base `edges` are committed first (minimal geometry)
- Then `buildScenarioRenderEdges` reads those base edges and computes final widths
- During slow-path rebuilds, this can span multiple frames, exposing intermediate/bad width states

### The Visual Symptom

When you create a new node:
1. Slow path rebuilds base `edges` (creates new edge objects via `toFlow`)
2. For a few frames, `buildScenarioRenderEdges` computes widths from those new edges
3. During those frames, widths appear wrong (too large, too small, or 0)
4. Eventually settles to correct widths

The user sees edges "flash" or "reset" during this transient period.

## Attempted Solutions

### Attempt 1: Time-Based Rebuild Window

**Approach**:
- Add `isInSlowPathRebuildRef` flag
- Slow path sets it to `true`, clears it after 50ms
- `buildScenarioRenderEdges` uses merged `scaledWidth` when flag is true

**Why it failed**:
- The flag is a ref, not in `renderEdges` useMemo dependencies
- `useMemo` doesn't re-run when ref changes
- By the time `buildScenarioRenderEdges` runs, flag might already be `false`
- Time-based windows are fragile and unpredictable

### Attempt 2: Always Prefer Merged Width

**Approach**:
- Slow path merges `scaledWidth` from `lastRenderEdgesRef` into new base edges
- `buildScenarioRenderEdges` always uses `edge.data.scaledWidth ?? freshComputed`

**Why it might fail**:
- If the merge preserves a **wrong** value (e.g., `MIN_WIDTH = 2` from initial load)
- And `freshComputed` is actually **correct** (e.g., 37.35)
- Then we perpetually block the correct value from being used
- Edges would be stuck at wrong widths forever

### Current State of Confusion

**Key questions that remain unanswered**:

1. **What is the correct width for edge A→C?**
   - Visual shows ~30-40px (substantial edge)
   - Log shows `mergedWidth: 2` (seems too small)
   - Log shows `freshComputed: 37.35` (current), `65.19` (scenario)
   - Which is actually correct?

2. **When is `computeOverlayWidthRaw` correct?**
   - On initial page load (F5)?
   - After MSMDC completes (no - MSMDC only updates queries, not topology)?
   - After some number of frames?
   - Never (is it fundamentally broken)?

3. **Why does `freshComputed` stay constant?**
   - Across all frames, `freshComputed` values don't change
   - If the computation is deterministic and inputs are stable, this makes sense
   - But if it's producing the WRONG value consistently, what's wrong with the inputs?

## What We Need to Determine

Before we can fix this properly, we need empirical data:

### Test 1: Initial Render Widths

**Action**: Reload page (F5), capture first few frames of width calculation logs

**Question**: On initial render (no merge, no previous state), does `buildScenarioRenderEdges` produce correct visual widths?

**Expected outcomes**:
- **If YES**: The merge is the problem (it's preserving wrong values)
- **If NO**: `computeOverlayWidthRaw` itself is broken and needs fixing

### Test 2: Slow Path vs Fast Path

**Action**: Make a change that triggers fast path (e.g., edit edge probability), observe widths

**Question**: Does the fast path preserve correct widths while slow path breaks them?

**Expected outcomes**:
- **If YES**: The issue is specific to how slow path rebuilds edges via `toFlow`
- **If NO**: The issue is in `buildScenarioRenderEdges` regardless of path

### Test 3: Base Edge Geometry After Slow Path

**Action**: Add logging in slow path to show what `edgesWithAnchors` contains before merge

**Question**: What `scaledWidth` do base edges have after `calculateEdgeOffsets` in slow path?

**Expected values**:
- Probably MIN_WIDTH (2) or some minimal value
- This would explain why merge sees `mergedWidth: 2`

## The Fundamental Architectural Issue

The core problem is **separation of concerns**:

### In Paulatim

- **Single responsibility**: Slow-path effect computed ALL geometry (widths, offsets, anchors) for current edges
- **Single commit**: One `setEdges` with fully-formed edges
- **No intermediate state**: ReactFlow never saw partial geometry

### Now

- **Split responsibility**:
  - Slow path: Base geometry (anchors, offsets from `calculateEdgeOffsets`)
  - Scenario pipeline: Final widths (via `buildScenarioRenderEdges`)
- **Two-stage commit**:
  - First: `setEdges(baseEdges)` (minimal geometry)
  - Then: `renderEdges` useMemo recomputes from those base edges
- **Exposed intermediate state**: ReactFlow sees base edges during transition

## Potential Solutions (Not Yet Validated)

### Option A: Restore Paulatim Pattern in Slow Path

**Approach**: Put width calculation back into slow-path effect (like paulatim)

**Pros**:
- Known to work
- Single-stage commit
- No intermediate state

**Cons**:
- Duplicates width logic (slow path + scenario pipeline)
- Doesn't solve the scenario layer problem
- More complex code

### Option B: Block ReactFlow Render During Rebuild

**Approach**: Don't commit base edges to ReactFlow until `buildScenarioRenderEdges` has computed final widths

**Pros**:
- Maintains separation of concerns
- No intermediate state visible to ReactFlow

**Cons**:
- Requires buffering mechanism
- More complex coordination between effect and useMemo
- Might delay updates visibly

### Option C: Fix Root Cause in `computeOverlayWidthRaw`

**Approach**: Understand why `computeOverlayWidthRaw` produces wrong values during rebuilds

**Pros**:
- Fixes the actual bug rather than masking it
- No merge/buffering hacks needed

**Cons**:
- Requires understanding the complex width calculation logic
- Root cause still unknown

### Option D: Geometry Merge (Current Attempt)

**Approach**: 
- Slow path merges geometry from previous render edges
- `buildScenarioRenderEdges` uses merged values when available

**Status**: **BLOCKED**

**Issues**:
- Unclear which value is "correct" (merged vs fresh)
- If merge preserves wrong values, we block correct updates
- If merge is bypassed, we expose flicker
- Need empirical testing to validate assumptions

## Next Steps

1. **Run Test 1** (initial render): Determine if `freshComputed` is ever correct
2. **Add detailed logging** to slow path merge to show:
   - What's in `lastRenderEdgesRef` (previous render edges)
   - What gets merged into base edges
   - What `buildScenarioRenderEdges` receives as input
3. **Instrument `computeOverlayWidthRaw`** to log:
   - Input probabilities
   - Residual mass calculations
   - Sibling counts
   - Final computed width
4. **Compare** slow path rebuild widths vs stable-state widths to identify discrepancy

## Open Questions

1. Why does `freshComputed` produce 37.35 when `mergedWidth` is 2?
2. Which value is actually correct for edge A→C (p=0.169)?
3. Why does `freshComputed` never change across frames if inputs are updating?
4. Is the issue in `computeOverlayWidthRaw`, `calculateEdgeOffsets`, or the merge logic?
5. Should we even be merging at the base edges level, or at the render edges level?

## Current Code State

### Files Modified

1. **GraphCanvas.tsx**:
   - Added `lastRenderEdgesRef` to track final render edges (not base edges)
   - Added `isInSlowPathRebuildRef` flag (currently not working correctly)
   - Added merge logic in slow path (lines ~1880-1920)
   - Updated `renderEdges` useMemo to populate `lastRenderEdgesRef`

2. **buildScenarioRenderEdges.ts**:
   - Added `isInSlowPathRebuild` parameter (not currently used correctly)
   - Modified width selection to prefer `mergedWidth ?? freshComputed`
   - Added diagnostic logging for first edge

### Merge Strategy

Currently using: `const preScaled = mergedWidth ?? freshComputed`

This means:
- **If base edge has `scaledWidth`**: use it (from merge)
- **Else**: use fresh computation

**Problem**: We don't know if the merged value is correct or stale.

## Conclusion

The investigation has revealed a fundamental tension:

- We **must** use `buildScenarioRenderEdges` output when it's correct (to show updates)
- We **must** block it when it's wrong (to avoid flicker)
- We **don't know** how to reliably detect which state we're in

The merge approach is a band-aid that might preserve wrong values forever.

**What we need**: A way to determine whether `computeOverlayWidthRaw`'s output is valid/stable, independent of time windows or arbitrary thresholds.

**Suggested next step**: Instrument the width calculation pipeline end-to-end to understand:
- What goes into `computeOverlayWidthRaw`
- Why it produces different values during rebuilds vs steady state
- Whether those "different" values are actually correct or incorrect
- What determines when the calculation stabilizes

Only then can we design a robust solution that knows when to trust the fresh computation vs when to preserve previous values.

