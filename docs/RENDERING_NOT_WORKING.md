# Critical Issue: Scenario Rendering Not Working

## Problem

Making scenarios visible does **nothing** visually because rendering is completely broken.

## Root Cause

`ScenarioOverlayRenderer` uses DOM queries to extract edge paths:

```typescript
const edgeElement = document.querySelector(`[data-id="${rfEdge.id}"] path.react-flow__edge-path`);
const pathData = edgeElement.getAttribute('d');
```

This doesn't work because:
1. **Wrong context**: Component is in a `<Panel>` outside ReactFlow's SVG
2. **Timing issues**: DOM might not be ready when useMemo runs
3. **No data-id**: ReactFlow edges don't have `data-id` attribute
4. **Wrong approach**: Querying DOM from React is anti-pattern

## What Actually Happens

1. User toggles scenario visible
2. `ScenarioOverlayRenderer` runs
3. `document.querySelector` returns `null` for all edges
4. `edgePaths` array is empty
5. Nothing renders
6. User sees no visual change

## Correct Approach

### Option 1: Integrate into ConversionEdge (Best)

Pass scenario overlay data as props to `ConversionEdge`:

```typescript
// In GraphCanvas, when creating edges:
const edgeData = {
  ...existingData,
  scenarioOverlays: getScenarioOverlaysForEdge(edgeUuid)
};

// In ConversionEdge.tsx, after rendering main path:
{data?.scenarioOverlays?.map(overlay => (
  <path
    key={overlay.scenarioId}
    d={edgePath}  // Same path, different width/color
    style={{
      stroke: overlay.color,
      strokeWidth: overlay.width,
      strokeOpacity: 0.3,
      fill: 'none',
      strokeLinecap: 'butt',
      strokeLinejoin: 'miter',
      mixBlendMode: 'multiply',
    }}
  />
))}
```

### Option 2: Custom Edge Component per Scenario

Create separate ReactFlow edges for each scenario overlay. More complex but cleaner separation.

### Option 3: SVG Layer (Current broken approach)

Keep `ScenarioOverlayRenderer` but fix it to:
1. Be inside ReactFlow SVG context (not in Panel)
2. Compute paths using same logic as ConversionEdge
3. Don't query DOM

## Why This Wasn't Caught

The rendering code compiles without errors because:
- TypeScript doesn't catch DOM query failures
- No runtime errors (querySelector just returns null)
- Component returns null silently
- No visual feedback that rendering failed

## Impact

**Feature is completely non-functional** for its primary purpose (visual comparison).

All the infrastructure exists but rendering doesn't work at all.

## Fix Priority

🔴 **CRITICAL** - This is the core feature. Must be fixed before anything else.

## Recommended Fix

**Option 1** (integrate into ConversionEdge):
1. Create helper to get scenario overlay data for an edge
2. Pass to ConversionEdge as prop
3. Render additional paths in ConversionEdge after main path
4. Remove ScenarioOverlayRenderer entirely

This is cleanest and works with ReactFlow's rendering model.


