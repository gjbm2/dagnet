# Beads & Chevrons Performance Root Cause

## Testing Results

**?nobeads&nochevrons**: Smooth pan/zoom
**With beads OR chevrons**: Dropped frames, jank
**With both**: Unusable

## Why Are They Expensive?

### During Pan/Zoom

ReactFlow updates edge screen coordinates (sourceX/Y, targetX/Y) on every pan frame → ConversionEdge must re-render.

**This is unavoidable** - edges need new screen coordinates to render at correct positions.

### Why Beads Are Expensive

When ConversionEdge re-renders:
1. EdgeBeadsRenderer props change (new coordinates passed down)
2. React.memo comparison runs (10 edges × comparison function)
3. **EdgeLabelRenderer portal exists** - React reconciles portal tree even if children haven't changed
4. Portal reconciliation is expensive because it's outside the main SVG tree

**The killer**: `EdgeLabelRenderer` is a React portal to `document.body`. Portals are expensive when updated frequently because React has to:
- Traverse to a different part of the DOM
- Reconcile elements in that separate tree
- Manage the portal lifecycle

**With 10 edges updating 60 times/second = 600 portal reconciliations/second**

### Why Chevrons Are Expensive

`ChevronClipPaths` receives `nodes` and `bundles`:
- If either changes reference, it re-renders
- Re-rendering = regenerating ALL SVG clipPath elements
- SVG manipulation = DOM changes = potential layout recalc

**Now memoized** to check actual position changes, but:
- Still runs memo comparison on every parent render
- If positions did change (legitimate), still expensive to regenerate all clipPaths

## The Memoization Trap

We tried memoizing everything, but:
- **Memo comparisons themselves cost CPU** when run 600 times/second
- **Portal reconciliation happens anyway** even if content didn't change
- **SVG generation is DOM manipulation** which can force layout

## Why ?nobeads&nochevrons Works

With them disabled:
- No portal reconciliation
- No DOM queries in EdgeBeads (`computeVisibleStartOffsetForEdge`)
- No SVG clipPath regeneration
- Just pure SVG edge paths being transformed by viewport

ReactFlow's built-in edge rendering is optimized for high-frequency updates. Our additions are not.

## The Real Problem

**Beads and chevrons do work that's appropriate for "graph changed" but too expensive for "viewport changed".**

They should:
1. Not recalculate during active pan/zoom
2. Only update when graph topology/data actually changes
3. Use transforms instead of recalculation where possible

## Proposed Fixes

### For Beads

1. **Don't use EdgeLabelRenderer** - renders all beads as pure SVG, no portals
2. **OR**: Hide beads entirely during pan (we tried this, didn't work because edges still rendered)
3. **OR**: Freeze bead positions during pan (transform them with viewport, don't recalculate)

### For Chevrons  

1. **Memoize based on node positions** (done)
2. **Skip updates during pan** - freeze clipPaths, only update when pan ends
3. **OR**: Use CSS clip-path instead of SVG clipPath (might be faster)

## Why My Fixes Failed

- Memoizing ConversionEdge/Node: Props still change (coordinates)
- Detecting pan start/end: Edges still render during pan due to coordinate updates
- Memoizing EdgeBeadsRenderer: Portal reconciliation still happens
- Memoizing ChevronClipPaths: Memo comparison still runs frequently

## Next Steps

Need to either:
1. Prevent EdgeBeadsRenderer from being IN the tree during pan (not just hiding it)
2. Switch to pure SVG beads (no portal)
3. Accept jank and optimize what we can

The fundamental issue: **React portals + high-frequency coordinate updates = bad time**

