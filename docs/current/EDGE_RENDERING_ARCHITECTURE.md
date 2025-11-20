# Edge Rendering Architecture

## Overview

This document describes how edge widths are computed and rendered in the graph editor, integrating the scenario layer system, What-If analysis, and display scaling preferences.

**Key Principle:** There is ALWAYS a layer system active. The 'current' layer (visible by default) represents the live graph. All other layers are snapshots for comparison.

## Terminology

- **'current' layer**: Live working state. Connected to `graph.edges[].p.mean` in the JSON/store. What-If DSL applies here. Visible by default. The ONLY editable layer.
- **'base' layer**: Snapshot created at file load OR after 'Flatten'. Standalone params (does NOT compose). Captures the graph state at that moment.
- **Scenario layers** (layer1, layer2, etc.): User-created snapshots. Each composes params from 'base' + all **VISIBLE** scenarios below it in stack order. Non-editable. **When created, snapshots capture what user sees: composite(live graph + What-If DSL).**
- **React Flow interactive edges**: DOM `<path>` elements providing click/hover/context menu. Always connected to 'current' values.
- **Scenario overlay paths**: Additional non-interactive `<path>` elements rendered per visible layer for visual comparison.

**IMPORTANT:** Visibility state and What-If DSL are **per-tab**, not per-graph. This means:
- Different tabs viewing the same graph can show different scenario combinations
- Tab A might show `['base', 'layer1', 'layer3']` while Tab B shows `['base', 'layer1', 'layer2', 'layer3']`
- Layer compositing differs between tabs based on which layers are visible
- Each tab maintains its own What-If DSL string

---

## ⚠️ IMPLEMENTATION NOTES TO ADDRESS

**Summary of Required Changes:**
1. **Compositing**: Layers must compose from base + ALL VISIBLE layers below (not just base)
2. **Remove Legacy Parameter**: Remove `null` parameter from all `computeEffectiveEdgeProbability` calls
3. **'Current' Hidden**: Use 3% opacity instead of VIEW ONLY mode (vastly simpler)
4. **Snapshot Semantics**: Snapshots capture composite(live graph + What-If DSL) - what user sees
5. **Colour Assignment**: Hidden 'current' should NOT get palette colour (use grey, not counted in distribution)
6. **Edge Labels**: Show composite label from all visible layers, with special formatting for hidden current
7. **PMF Warnings**: Only calculate/display for 'current' layer, NOT for scenario snapshots

**Already Correct:**
- ✅ **Per-Tab State**: Visibility and What-If DSL are per-tab (not per-graph)

---

### 1. Compositing Bug - Currently WRONG
**Location:** `GraphCanvas.tsx` ~line 4674

**Current implementation (incorrect):**
```typescript
// Each layer only composes with base
composedParams = composeParams(baseParams, [scenario.params]);
```

**Should be:**
```typescript
// Each layer composes from base + all VISIBLE layers below it
const visibleLayersBelow = visibleScenarioIds
  .slice(0, visibleScenarioIds.indexOf(scenarioId))
  .filter(id => id !== 'current' && id !== 'base');

composedParams = composeParams(
  baseParams,
  visibleLayersBelow.map(id => scenarios.find(s => s.id === id)!.params)
);
```

### 2. Remove Legacy `null` Parameter

**Current code has:**
```typescript
computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL }, null, visitedNodes)
```

**Should be:**
```typescript
computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL }, visitedNodes)
```

**Rationale:** The 4th parameter (`_unused?: null`) serves no function. Removing it reduces code surface area.

**Locations to update:**
- All calls in `GraphCanvas.tsx`
- All calls in `ConversionEdge.tsx`
- Any other call sites

**Note:** The function signature has `_unused?: null` which is optional, so calls can omit it without changing the function signature first.

### 3. Snapshot Semantics - Capture What User Sees

**Key principle:** Snapshots capture the **composite** of live graph + What-If DSL.

When user clicks "Create Snapshot", the system should:
1. For each edge, call `computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL })`
2. Store the resulting probability values in the snapshot's `params.edges[edgeId].p.mean`
3. Record the What-If DSL in the snapshot's `meta.whatIfDSL` for reference

**This means:**
- If What-If is active when snapshot is created, the snapshot includes those effects
- User sees the snapshot as "what I was looking at when I clicked snapshot"
- Snapshot becomes a fixed reference point (it doesn't change when What-If changes later)
- Comparing snapshots shows the difference between different What-If scenarios

**Implementation in `captureParams` function:**
```typescript
function captureParams(graph, options) {
  const { whatIfDSL, type, source } = options;
  const params = { edges: {}, nodes: {} };
  
  for (const edge of graph.edges) {
    // Capture the composite: live graph + What-If effects
    const effectiveProb = computeEffectiveEdgeProbability(
      graph,
      edge.id,
      { whatIfDSL }  // Apply What-If when capturing
    );
    params.edges[edge.uuid] = {
      p: { mean: effectiveProb }
      // ... other params
    };
  }
  
  return params;
}
```

### 4. 'Current' Hidden Behavior - **ADOPTED APPROACH**

When 'current' is toggled "hidden" (not in `visibleScenarioIds`):
- Render 'current' overlay at **97% transparency** (3% opacity) instead of completely hiding it
- Keep ALL interaction fully enabled (What-If, editing, context menus, sidebar panels, etc.)
- No special VIEW ONLY mode, no auto-unhide logic, no cursor changes, no disabled controls

**Rationale:**
- **Vastly simpler implementation**: No VIEW ONLY mode code needed across ConversionEdge, PropertiesPanel, WhatIfAnalysisControl, context menus, etc.
- **User mental model**: "Hide current" means "make current nearly invisible" not "lock me out of editing"
- **Flexibility**: User can compare historical scenarios AND still edit/What-If if needed without toggling visibility first
- **Real-time feedback**: What-If changes update the (barely visible) 'current' overlay immediately
- **Visual impact**: At 3% opacity with `mix-blend-mode: multiply`, current has minimal effect on colour perception
- **Alternative exists**: Users who want pure historical comparison can open a separate tab

**Implementation:**
```typescript
// In scenario overlay rendering
const opacity = (scenarioId === 'current' && !visibleScenarioIds.includes('current'))
  ? 0.05  // 95% transparent when "hidden"
  : 0.30; // Normal 30% opacity

// No changes needed to:
// - Interactive edge behavior (always fully enabled)
// - Context menus (always full menu)
// - Sidebar panels (always editable)
// - What-If controls (always enabled)
// - Auto-unhide logic (not needed)
```

### 5. Colour Assignment - Hidden 'Current' Special Case

**Problem:** Currently colour assignment likely assigns a palette colour to 'current' even when it's hidden.

**Should be:**
```typescript
// Only assign palette colours to VISIBLE layers
const visibleLayers = visibleScenarioIds;  // Array of visible layer IDs
const colours = calculateComplementaryColours(visibleLayers.length);

const colourMap = new Map<string, string>();
for (let i = 0; i < visibleLayers.length; i++) {
  const layerId = visibleColourOrderIds[i];
  if (visibleScenarioIds.includes(layerId)) {
    colourMap.set(layerId, colours[i]);
  }
}

// Special case: 'current' hidden (always rendered, but not in visible list)
// When rendering 'current' overlay at 3% opacity:
if (!visibleScenarioIds.includes('current')) {
  // Use neutral grey, NOT a palette colour
  currentOverlayColour = '#808080';  // or derive from base edge colour
}
```

**Effect:**
- Hidden 'current' doesn't steal a palette colour from visible layers
- Colour distribution is based only on truly visible layers
- Edge label shows hidden current in light grey (see section 6)

### 6. Edge Labels - Composite Display

**Current behavior:** Edge labels likely show only one value (probably from 'current' or selected layer).

**Should be:**
```typescript
function buildEdgeLabel(edgeId, visibleScenarioIds, scenarios, graph, whatIfDSL) {
  // Special case: only one layer visible
  if (visibleScenarioIds.length === 1) {
    const layerId = visibleScenarioIds[0];
    const prob = getLayerProbability(layerId, edgeId);
    return {
      text: `${(prob * 100).toFixed(0)}%`,
      color: 'black',  // Standard black text
      style: 'normal'
    };
  }
  
  // Multiple layers: build composite label
  const segments = [];
  
  // Add visible layers in order (bottom to top)
  for (const layerId of visibleScenarioIds) {
    const prob = getLayerProbability(layerId, edgeId);
    const stdev = getLayerStdev(layerId, edgeId);
    const colour = colourMap.get(layerId);
    
    const text = stdev 
      ? `${(prob * 100).toFixed(0)}% ± ${(stdev * 100).toFixed(0)}%`
      : `${(prob * 100).toFixed(0)}%`;
    
    segments.push({ text, colour });
  }
  
  // Add hidden 'current' if it exists
  if (!visibleScenarioIds.includes('current')) {
    const prob = computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL });
    const stdev = graph.edges.find(e => e.id === edgeId)?.p?.stdev;
    
    const text = stdev
      ? `(${(prob * 100).toFixed(0)}% ± ${(stdev * 100).toFixed(0)}%)`
      : `(${(prob * 100).toFixed(0)}%)`;
    
    segments.push({ 
      text, 
      color: '#cccccc',  // Light grey
      style: 'parentheses'
    });
  }
  
  return segments;  // Render as coloured segments side by side
}
```

**Visual examples:**

One layer visible:
```
50%
```
(Black text, like current behavior)

Multiple layers (current visible):
```
[cyan] 40% ± 2%  [magenta] 45% ± 3%  [pink] 60% ± 2%
```
(Each coloured by layer palette colour)

Multiple layers (current hidden):
```
[cyan] 40% ± 2%  [magenta] 45% ± 3%  (60% ± 2%)
```
(Current in light grey with parentheses)

**Implementation location:** `ConversionEdge.tsx` or edge label rendering component

---

## Complete State → Compositing → Rendering Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        STATE: Data Sources (Read)                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  GraphStoreContext                 TabContext (per-tab)                      │
│  ┌──────────────────────┐          ┌────────────────────────────────┐       │
│  │ graph.edges[]        │          │ editorState:                   │       │
│  │   ├─ .p.mean         │          │   ├─ whatIfDSL: string | null  │       │
│  │   ├─ .conditional_p  │          │   ├─ scenarioState:            │       │
│  │   └─ ...             │          │   │   ├─ visibleScenarioIds[]  │       │
│  │ graph.nodes[]        │          │   │   ├─ visibleColourOrderIds[]│       │
│  │   ├─ .case.variants  │          │   │   └─ selectedScenarioId    │       │
│  │   └─ ...             │          │   └─ hiddenNodeIds[]          │       │
│  └──────────────────────┘          └────────────────────────────────┘       │
│                                                                               │
│  ScenariosContext (graph-level)    ViewPreferencesContext                   │
│  ┌──────────────────────┐          ┌────────────────────────────────┐       │
│  │ scenarios[]          │          │ • useUniformScaling: boolean   │       │
│  │   ├─ 'base'          │          │ • massGenerosity: 0.0 → 1.0    │       │
│  │   ├─ layer1          │          │ • useSankeyView: boolean       │       │
│  │   ├─ layer2          │          │ • confidenceIntervalLevel      │       │
│  │   └─ ...             │          └────────────────────────────────┘       │
│  │ each has:            │                                                     │
│  │   ├─ id, name, colour │                                                     │
│  │   ├─ params: {       │                                                     │
│  │   │   edges: {...}   │                                                     │
│  │   │   nodes: {...}   │                                                     │
│  │   │ }                │                                                     │
│  │   └─ meta            │                                                     │
│  └──────────────────────┘                                                     │
│                                                                               │
│  NOTE: 'current' is NOT stored in scenarios[]. It's a virtual layer that     │
│        reads from live graph + applies whatIfDSL.                            │
└───────────────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                   COMPOSITING: Scenario Layer Resolution                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  For visibleScenarioIds = ['base', 'layer1', 'layer2', 'layer3', 'current'] │
│                                                                               │
│  Layer 'base':                                                                │
│    paramsSource = scenarios.get('base').params  ← standalone snapshot        │
│    probResolver = (edge) => paramsSource.edges[edge.id]?.p?.mean ?? baseFallback
│                                                                               │
│  Layer 'layer1':                                                              │
│    composedParams = deepMerge(                                                │
│      scenarios.get('base').params,                                            │
│      scenarios.get('layer1').params                                           │
│    )                                                                          │
│    probResolver = (edge) => composedParams.edges[edge.id]?.p?.mean ?? baseFallback
│                                                                               │
│  Layer 'layer2':                                                              │
│    composedParams = deepMerge(                                                │
│      scenarios.get('base').params,                                            │
│      scenarios.get('layer1').params,                                          │
│      scenarios.get('layer2').params                                           │
│    )                                                                          │
│    probResolver = (edge) => composedParams.edges[edge.id]?.p?.mean ?? baseFallback
│                                                                               │
│  Layer 'layer3':                                                              │
│    composedParams = deepMerge(                                                │
│      scenarios.get('base').params,                                            │
│      scenarios.get('layer1').params,                                          │
│      scenarios.get('layer2').params,                                          │
│      scenarios.get('layer3').params                                           │
│    )                                                                          │
│    probResolver = (edge) => composedParams.edges[edge.id]?.p?.mean ?? baseFallback
│                                                                               │
│  Layer 'current':                                                             │
│    ⚠️  SPECIAL: Does NOT compose from scenarios                              │
│    ⚠️  ALWAYS RENDERED (even when not in visibleScenarioIds)                 │
│    ⚠️  SNAPSHOTS capture: composite(live graph + What-If DSL)                │
│    paramsSource = graph.edges[] (live JSON/store)                            │
│    probResolver = (edge) => computeEffectiveEdgeProbability(                 │
│      graph,                                                                   │
│      edge.id,                                                                 │
│      { whatIfDSL }  ← What-If ONLY applies to 'current'                     │
│    )                                                                          │
│    opacity = visibleScenarioIds.includes('current') ? 0.30 : 0.05           │
│              ↑ Normal 30%                              ↑ Nearly invisible 5%│
│                                                                               │
│  Colour Assignment (uniform for VISIBLE layers only):                         │
│    colours = calculateComplementaryColours(visibleScenarioIds.length)          │
│    for each layer in visibleColourOrderIds:                                   │
│      if visibleScenarioIds.includes(layer):                                  │
│        layer.colour = colours[indexOf(layer in visibleColourOrderIds)]          │
│                                                                               │
│    Special case: 'current' hidden (not in visibleScenarioIds)               │
│      → 'current' does NOT get a palette colour                                │
│      → Renders at 3% opacity with grey/neutral colour                         │
│      → Not counted in colour palette distribution                             │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                RENDERING: Edge Width Calculation (per layer)                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  For EACH visible layer (including 'current'):                               │
│                                                                               │
│  Step 1: Get effective probability                                           │
│    prob = probResolver(edge)  ← from compositing layer above                 │
│                                                                               │
│  Step 2: Apply width calculation mode                                        │
│                                                                               │
│    IF useUniformScaling:                                                      │
│      width = 10px (all edges uniform)                                        │
│                                                                               │
│    ELSE IF massGenerosity = 1.0 (proportional):                              │
│      width = MIN_WIDTH + (prob / Σprob_siblings) × (MAX_WIDTH - MIN_WIDTH)  │
│      • Local comparison: edge vs siblings from same source                   │
│      • Independent of upstream flow                                          │
│                                                                               │
│    ELSE IF massGenerosity = 0.0 (global mass):                               │
│      residualMass[node] = computed via graph traversal                       │
│      actualMass = residualMass[source] × prob                                │
│      width = MIN_WIDTH + actualMass × (MAX_WIDTH - MIN_WIDTH)               │
│      • Global comparison: actual flow through graph                          │
│      • Respects probability conservation                                     │
│                                                                               │
│    ELSE (hybrid 0 < massGenerosity < 1.0):                                   │
│      power = 1 - massGenerosity                                              │
│      displayMass = actualMass^power                                          │
│      width = MIN_WIDTH + displayMass × (MAX_WIDTH - MIN_WIDTH)              │
│                                                                               │
│    SPECIAL: Sankey mode                                                      │
│      Forces massGenerosity = 0 (pure global mass)                            │
│      MAX_WIDTH = 384 (vs normal 104)                                         │
│      Edges limited to left/right faces only                                  │
│                                                                               │
│  Step 3: Calculate offsets (face bundling)                                   │
│    For each node face (source-right, target-left, etc.):                     │
│      1. Group edges by (source/target, face)                                 │
│      2. totalWidth = Σ(edge.width) for bundle                                │
│      3. IF totalWidth > maxWidth:                                            │
│           scale = maxWidth / totalWidth                                      │
│           scaledWidth[e] = edge.width × scale                                │
│      4. Distribute vertical offsets to stack edges                           │
│      5. Attach to edge.data:                                                 │
│           • sourceOffsetX, sourceOffsetY                                     │
│           • targetOffsetX, targetOffsetY                                     │
│           • scaledWidth (final rendered width)                               │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     RENDERING: Visual Output (DOM)                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  React Flow Interactive Edges (always connected to 'current'):               │
│    ┌────────────────────────────────────────────────────────────────┐       │
│    │  Always fully interactive regardless of visibility state       │       │
│    │    stroke = 'transparent'  (invisible, overlay shows visual)   │       │
│    │    interactive = true      (click, hover, context menu, edit)  │       │
│    │    width/offsets = from 'current' layer calculation            │       │
│    │                                                                  │       │
│    │  Note: No special VIEW ONLY mode. 'current' overlay opacity    │       │
│    │  changes but interaction always enabled (see below).           │       │
│    └────────────────────────────────────────────────────────────────┘       │
│                                                                               │
│  Scenario Overlay Paths (one set per visible layer):                         │
│    For each layer in visibleScenarioIds:                                     │
│      ┌────────────────────────────────────────────────────────────┐         │
│      │  edgeId = `scenario-overlay__${layerId}__${baseEdgeId}`   │         │
│      │  stroke = layer.colour                                      │         │
│      │  strokeOpacity = (layerId === 'current' && !isVisible)    │         │
│      │                   ? 0.05  // 95% transparent when "hidden" │         │
│      │                   : 0.30  // 30% opacity normally          │         │
│      │  strokeWidth = layer.scaledWidth (from calculation above) │         │
│      │  mixBlendMode = 'multiply'                                 │         │
│      │  selectable = false                                        │         │
│      │  pointerEvents = 'none'  (non-interactive, display only)  │         │
│      │  zIndex = -1 (renders below interactive edges)            │         │
│      │                                                             │         │
│      │  Path geometry:                                            │         │
│      │    • Uses same control points as base edge                 │         │
│      │    • Apply layer.sourceOffsetX/Y, targetOffsetX/Y          │         │
│      │    • Render Bézier curve                                   │         │
│      │    • Clip to chevron shapes (if bundle size > 1)           │         │
│      └────────────────────────────────────────────────────────────┘         │
│                                                                               │
│  Visual Layer Stack (z-index order, bottom to top):                          │
│    -1: Scenario overlays (coloured, semi-transparent, non-interactive)        │
│     0: React Flow interactive edges (transparent)                            │
│     1: Selected edge highlight                                               │
│     2: Edge labels (composite from all visible layers)                       │
│                                                                               │
│  Edge Label Rendering (shows ALL visible layers):                            │
│    ┌────────────────────────────────────────────────────────────────┐       │
│    │  IF only ONE layer visible:                                    │       │
│    │    label = "50%" (standard black text, grey edge)              │       │
│    │                                                                  │       │
│    │  IF multiple layers visible (including 'current'):             │       │
│    │    Build composite label left-to-right (bottom to top):        │       │
│    │    [colour1] 55% ± 5%  [colour2] 65% ± 1%  [colour3] 50% ± 4%   │       │
│    │    Each segment coloured by layer's assigned palette colour      │       │
│    │                                                                  │       │
│    │  IF multiple layers visible (current HIDDEN):                  │       │
│    │    Build composite label with current in parentheses:          │       │
│    │    [colour1] 55% ± 5%  [colour2] 65% ± 1%  (50% ± 4%)           │       │
│    │    Current segment: light grey text, parentheses               │       │
│    │    Other segments: coloured by layer's palette colour            │       │
│    │                                                                  │       │
│    │  Order: visible layers from bottom to top in stack             │       │
│    │  Format: prob% ± stdev% (if stdev present)                     │       │
│    └────────────────────────────────────────────────────────────────┘       │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

## Example: 5 Visible Layers in Action

### Setup

```
visibleScenarioIds = ['base', 'layer1', 'layer2', 'layer3', 'current']
visibleColourOrderIds = ['base', 'layer1', 'layer2', 'layer3', 'current']
whatIfDSL = "case[checkout_case] = treatment"

graph.edges['checkout-to-purchase'].p.mean = 0.50  (live value)
scenarios.get('base').params.edges['checkout-to-purchase'].p.mean = 0.40
scenarios.get('layer1').params.edges['checkout-to-purchase'].p.mean = 0.45
scenarios.get('layer2').params = {} (ALL params, but no override for this edge)
scenarios.get('layer3').params.edges['checkout-to-purchase'].p.mean = 0.55
```

### Rendering Output

For edge "checkout-to-purchase":

#### Layer 'base' (bottom overlay)
```typescript
// Standalone snapshot (does NOT compose)
prob = scenarios.get('base').params.edges['checkout-to-purchase'].p.mean
    = 0.40
width = f(0.40, siblings, massGenerosity)  // e.g., 25px
colour = complementaryColours[0]  // e.g., cyan
render: cyan path, 30% opacity, non-interactive
```

#### Layer 'layer1' (overlay)
```typescript
// Composes from base
composedParams = deepMerge(
  base.params,        // { edges: { 'checkout-to-purchase': { p: { mean: 0.40 } } } }
  layer1.params       // { edges: { 'checkout-to-purchase': { p: { mean: 0.45 } } } }
)
prob = composedParams.edges['checkout-to-purchase'].p.mean
    = 0.45  // layer1 override wins
width = f(0.45, siblings, massGenerosity)  // e.g., 28px
colour = complementaryColours[1]  // e.g., magenta
render: magenta path, 30% opacity, non-interactive
```

#### Layer 'layer2' (overlay)
```typescript
// Composes from base + layer1
composedParams = deepMerge(
  base.params,        // { edges: { 'checkout-to-purchase': { p: { mean: 0.40 } } } }
  layer1.params,      // { edges: { 'checkout-to-purchase': { p: { mean: 0.45 } } } }
  layer2.params       // {} (no override for this edge)
)
prob = composedParams.edges['checkout-to-purchase'].p.mean
    = 0.45  // inherits from layer1 (layer2 has no override)
width = f(0.45, siblings, massGenerosity)  // e.g., 28px
colour = complementaryColours[2]  // e.g., yellow
render: yellow path, 30% opacity, non-interactive
```

#### Layer 'layer3' (overlay)
```typescript
// Composes from base + layer1 + layer2
composedParams = deepMerge(
  base.params,        // { edges: { 'checkout-to-purchase': { p: { mean: 0.40 } } } }
  layer1.params,      // { edges: { 'checkout-to-purchase': { p: { mean: 0.45 } } } }
  layer2.params,      // {}
  layer3.params       // { edges: { 'checkout-to-purchase': { p: { mean: 0.55 } } } }
)
prob = composedParams.edges['checkout-to-purchase'].p.mean
    = 0.55  // layer3 override wins
width = f(0.55, siblings, massGenerosity)  // e.g., 35px
colour = complementaryColours[3]  // e.g., blue
render: blue path, 30% opacity, non-interactive
```

#### Layer 'current' (top overlay)
```typescript
// Does NOT compose - reads from live graph + What-If
prob = computeEffectiveEdgeProbability(
  graph,  // graph.edges['checkout-to-purchase'].p.mean = 0.50
  'checkout-to-purchase',
  { whatIfDSL: "case[checkout_case] = treatment" },  // What-If applied
  null
)
    = 0.60  // e.g., What-If changed it from 0.50 to 0.60
width = f(0.60, siblings, massGenerosity)  // e.g., 40px
colour = complementaryColours[4]  // e.g., pink
render: pink path, 30% opacity, non-interactive
```

#### React Flow Interactive Edges
```typescript
// Always connected to 'current' values
stroke = 'transparent'  // invisible (pink overlay above shows the visual)
interactive = true      // full interaction enabled
width = 40px            // same as 'current' overlay
offsets = same as 'current' overlay
// User can click, hover, edit this edge → all interactions go to live graph
```

### Visual Result

User sees (from bottom to top):
- Cyan path (0.40, width 25px) = base at 30% opacity
- Magenta path (0.45, width 28px) = layer1 at 30% opacity
- Yellow path (0.45, width 28px) = layer2 at 30% opacity (same as layer1, overlaps perfectly)
- Blue path (0.55, width 35px) = layer3 at 30% opacity (wider, creates fringe)
- Pink path (0.60, width 40px) = current at 30% opacity (widest, creates fringe)

Where widths differ, coloured fringes appear showing divergence between layers.

**Edge Label (composite from all layers):**
```
[cyan] 40% ± 2%  [magenta] 45% ± 3%  [yellow] 45% ± 3%  [blue] 55% ± 4%  [pink] 60% ± 2%
```
Each segment coloured by its layer's palette colour, showing all visible layers left-to-right (bottom to top).

**Note on 'current' visibility:**
- If user toggles 'current' "hidden":
  - Pink path renders at 3% opacity (barely visible) instead of 30%
  - 'current' does NOT get a palette colour (uses grey)
  - Edge label shows current in parentheses with light grey:
    ```
    [cyan] 40% ± 2%  [magenta] 45% ± 3%  [yellow] 45% ± 3%  [blue] 55% ± 4%  (60% ± 2%)
    ```
- All other layers remain at 30% opacity
- Interactive edges remain fully functional regardless of 'current' opacity

## User Workflows

### Workflow 1: Default Editing (Current Visible)

```
Initial state:
  visibleScenarioIds = ['current']  // 'current' visible by default
  
User edits edge probability → goes to graph.edges[].p.mean
User applies What-If → changes 'current' overlay appearance
User sees: Pink overlay showing live graph + What-If
Interactive edges: Transparent, connected to 'current', fully editable
```

### Workflow 2: Create Snapshot

```
User clicks "Create Snapshot":
  1. Capture current state (what user sees):
     // Snapshot captures: live graph.edges[].p.mean + What-If DSL effects
     // This is the composite that computeEffectiveEdgeProbability returns
     newLayer = captureSnapshot(graph, { 
       type: 'all',           // Full parameter surface
       source: 'visible',     // From visible composition
       whatIfDSL: current     // Include What-If effects
     })
  2. Add to scenarios:
     scenarios.push(newLayer)
  3. Make visible by default:
     visibleScenarioIds.push(newLayer.id)
     visibleColourOrderIds.push(newLayer.id)
  4. Assign colour:
     newLayer.colour = complementaryColours[visibleScenarioIds.length - 1]
  
Result: New layer appears as coloured overlay showing what user saw (including What-If)
```

### Workflow 3: Compare Scenarios (Current Dimmed)

```
User toggles 'current' visibility OFF:
  visibleScenarioIds = ['base', 'layer1', 'layer2']  // 'current' not in list
  
Visual result:
  • Three coloured overlays visible (base, layer1, layer2) at 30% opacity
  • 'current' overlay still renders but at 3% opacity (97% transparent, barely visible)
  • Interactive edges fully functional:
    - Hover → normal tooltips
    - Click → normal selection
    - Edit → works normally
    - Context menu → full menu
    - What-If → works normally
    - All interaction enabled
  
Effect: User can focus on comparing historical scenarios while 'current' is 
barely visible. If they want to edit/tweak, interaction is immediately available.

Note: No auto-unhide needed. What-If changes update the (nearly invisible) 
'current' overlay in real-time. User can toggle 'current' back to visible 
to see changes at normal opacity.
```

### Workflow 4: Flatten

```
User clicks "Flatten":
  1. Capture current as new base:
     newBase = captureSnapshot(graph, { type: 'all', source: 'base' })
  2. Replace base:
     scenarios.set('base', newBase)
  3. Clear all other scenarios:
     scenarios = scenarios.filter(s => s.id === 'base')
  4. Keep current visible:
     visibleScenarioIds = ['current']
  
Result: 
  • New baseline established (old base discarded)
  • All scenario layers removed
  • Only 'current' visible (normal editing mode)
```

## Critical Implementation Rules

### Rule 1: 'current' Layer Source
```typescript
// WRONG: 'current' composes from scenarios
const currentProb = composedParams.edges[edgeId]?.p?.mean;

// CORRECT: 'current' reads from live graph
const currentProb = computeEffectiveEdgeProbability(
  graph,  // ← live store
  edgeId,
  { whatIfDSL },
  null
);
```

### Rule 2: What-If ONLY Applies to 'current'
```typescript
// For 'base' and scenario layers:
const probResolver = (edge) => composedParams.edges[edge.id]?.p?.mean ?? fallback;

// For 'current' layer ONLY:
const probResolver = (edge) => computeEffectiveEdgeProbability(
  graph,
  edge.id,
  { whatIfDSL },  // ← ONLY here
  null
);
```

### Rule 3: Colour Assignment - Only for VISIBLE Layers
```typescript
// WRONG: Assign colours to all layers including hidden 'current'
const colours = calculateComplementaryColours(visibleColourOrderIds.length);
for (let i = 0; i < visibleColourOrderIds.length; i++) {
  const layerId = visibleColourOrderIds[i];
  layerColours[layerId] = colours[i];
}

// CORRECT: Only assign palette colours to VISIBLE layers
const colours = calculateComplementaryColours(visibleScenarioIds.length);
const colourMap = new Map<string, string>();

for (let i = 0; i < visibleColourOrderIds.length; i++) {
  const layerId = visibleColourOrderIds[i];
  if (visibleScenarioIds.includes(layerId)) {  // ← Check if visible
    colourMap.set(layerId, colours[i]);
  }
}

// Hidden 'current' uses neutral grey (not a palette colour)
if (!visibleScenarioIds.includes('current')) {
  currentOverlayColour = '#808080';  // Grey, not from palette
}
```

**Effect:** Hidden 'current' doesn't steal a palette colour. Colour distribution is based only on truly visible layers.

### Rule 4: Interactive Edges Always Connect to 'current' and Always Enabled
```typescript
// Interactive edges (React Flow base edges)
// Always show 'current' values, always fully interactive
const prob = computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL }, null);
const width = calculateEdgeWidth(prob, ...);

// Stroke is transparent when ANY scenarios visible
const stroke = visibleScenarioIds.length > 0 ? 'transparent' : normalColour;

// Interaction ALWAYS enabled (no VIEW ONLY mode)
const interactive = true;  // Never disabled

// Visual feedback via 'current' overlay opacity
// When 'current' not in visibleScenarioIds, overlay renders at 3% opacity
// But interactive edges remain fully functional
```

### Rule 5: New Layers Visible by Default, Snapshots Capture Composite
```typescript
// When creating a new scenario layer
function createSnapshot(options) {
  // IMPORTANT: Capture what user sees (composite of live graph + What-If DSL)
  // For each edge, run computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL })
  // This gives the "current" state with What-If effects applied
  const params = captureParams(graph, {
    whatIfDSL: tabState.whatIfDSL,  // Include What-If effects
    type: options.type || 'all',
    source: options.source || 'visible'
  });
  
  const newLayer = {
    id: generateUUID(),
    name: options.name || generateTimestampName(),
    params,  // Captured composite (live + What-If)
    color: '#808080',  // placeholder, assigned when made visible
    meta: {
      whatIfDSL: tabState.whatIfDSL,  // Record What-If that was active
      whatIfSummary: summarizeWhatIf(tabState.whatIfDSL),
      // ... other metadata
    }
  };
  
  scenarios.push(newLayer);
  
  // Make visible by default
  visibleScenarioIds.push(newLayer.id);
  visibleColourOrderIds.push(newLayer.id);
  
  // Assign colour based on new visibility order
  reassignColours(visibleScenarioIds);
  
  return newLayer;
}
```

### Rule 6: Edge Labels Show All Visible Layers
```typescript
// WRONG: Show only one value (probably 'current')
function EdgeLabel({ edge }) {
  const prob = edge.data?.probability ?? 0;
  return <text>{(prob * 100).toFixed(0)}%</text>;
}

// CORRECT: Build composite label from all visible layers
function EdgeLabel({ edge, visibleScenarioIds, colourMap, graph, whatIfDSL }) {
  // Single layer: black text, simple
  if (visibleScenarioIds.length === 1) {
    const prob = getLayerProbability(visibleScenarioIds[0], edge.id);
    return <text fill="black">{(prob * 100).toFixed(0)}%</text>;
  }
  
  // Multiple layers: coloured segments
  const segments = [];
  
  for (const layerId of visibleScenarioIds) {
    const prob = getLayerProbability(layerId, edge.id);
    const stdev = getLayerStdev(layerId, edge.id);
    const colour = colourMap.get(layerId);
    const text = stdev 
      ? `${(prob * 100).toFixed(0)}% ± ${(stdev * 100).toFixed(0)}%`
      : `${(prob * 100).toFixed(0)}%`;
    segments.push(<tspan fill={colour}>{text}  </tspan>);
  }
  
  // Add hidden 'current' in grey with parentheses
  if (!visibleScenarioIds.includes('current')) {
    const prob = computeEffectiveEdgeProbability(graph, edge.id, { whatIfDSL });
    const stdev = graph.edges.find(e => e.id === edge.id)?.p?.stdev;
    const text = stdev
      ? `(${(prob * 100).toFixed(0)}% ± ${(stdev * 100).toFixed(0)}%)`
      : `(${(prob * 100).toFixed(0)}%)`;
    segments.push(<tspan fill="#cccccc">{text}</tspan>);
  }
  
  return <text>{segments}</text>;
}
```

**Visual result:**
- One layer: `50%` (black)
- Multiple + current visible: `[cyan] 40% ± 2%  [magenta] 45%  [pink] 60%` (coloured)
- Multiple + current hidden: `[cyan] 40% ± 2%  [magenta] 45%  (60%)` (current in grey with parens)

### Rule 7: PMF Warnings ONLY for 'Current' Layer
```typescript
// WRONG: Calculate PMF warnings per visible layer
function calculatePMFWarnings(node, visibleScenarioIds) {
  for (const layerId of visibleScenarioIds) {
    const outboundEdges = getOutboundEdges(node, layerId);
    const sum = outboundEdges.reduce((acc, e) => acc + getLayerProbability(layerId, e.id), 0);
    if (Math.abs(sum - 1.0) > 0.01) {
      addWarning(node, layerId, `Outbound PMF = ${sum.toFixed(2)}`);
    }
  }
}

// CORRECT: Only calculate PMF warnings for 'current' (live graph)
function calculatePMFWarnings(node, graph, whatIfDSL) {
  // PMF warnings are about the validity of the LIVE graph state
  // Snapshots are historical/frozen - no need to warn about them
  
  const outboundEdges = getOutboundEdges(node);
  const sum = outboundEdges.reduce((acc, e) => {
    // Use 'current' calculation: live graph + What-If
    const prob = computeEffectiveEdgeProbability(graph, e.id, { whatIfDSL });
    return acc + prob;
  }, 0);
  
  // Only show warning if current live state violates PMF constraint
  if (Math.abs(sum - 1.0) > 0.01) {
    addWarning(node, `Outbound probabilities sum to ${sum.toFixed(2)} (should be 1.0)`);
  }
}
```

**Rationale:**
- PMF warnings help users fix issues with the **live, editable graph**
- Scenario layers are **snapshots** - frozen in time, not editable
- Historical snapshots may have PMF violations (e.g., graph structure changed), but these are not actionable
- Warning the user about snapshot PMF violations is noise that obscures real issues
- **Only 'current' layer warnings are actionable** (user can edit to fix them)

**Effect:**
- When multiple layers visible: PMF warnings displayed only once per node (for 'current')
- Warnings disappear when 'current' is hidden (nothing to fix in VIEW mode)
- No confusing duplicate warnings for each visible layer
- Cleaner, more actionable UX

**Implementation location:** Wherever PMF validation happens (likely `GraphCanvas.tsx` or validation utility)

## Data Flow: Complete Example

```
USER ACTION: Apply What-If "case[checkout_case] = treatment"
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│ WhatIfAnalysisControl                                       │
│   • Builds DSL string                                       │
│   • Calls tabOps.updateTabState({ whatIfDSL: "..." })      │
│   • If 'current' hidden → auto-unhide + toast              │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│ TabContext                                                   │
│   • Updates tabs[tabId].editorState.whatIfDSL               │
│   • If auto-unhide: add 'current' to visibleScenarioIds    │
│   • Triggers re-render                                      │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│ GraphEditor                                                  │
│   • Reads whatIfDSL from tabState.editorState.whatIfDSL    │
│   • Passes to GraphCanvas                                   │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│ GraphCanvas                                                  │
│   • overridesVersion = whatIfDSL || ''                      │
│   • useEffect detects change → recompute                    │
└─────────────────────────────────────────────────────────────┘
     │
     ├─────────────────────────────────────────────────────────┐
     │                                                           │
     ▼                                                           ▼
┌──────────────────────────────────┐   ┌──────────────────────────────────┐
│ React Flow Interactive Edges     │   │ computeScenarioOverlayEdges      │
│   • Update edge.data.whatIfDSL   │   │   For 'current' layer:           │
│   • Trigger width recalculation  │   │     probResolver = (e) =>        │
│   • Show 'current' values        │   │       computeEffectiveEdge...()  │
│     (transparent stroke)         │   │         with whatIfDSL           │
└──────────────────────────────────┘   │   For other layers:              │
                                        │     probResolver = (e) =>        │
                                        │       composedParams.edges[...]  │
                                        │   Create overlay paths           │
                                        └──────────────────────────────────┘
     │                                               │
     │                                               │
     └───────────────────┬───────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ calculateEdgeWidth (called per edge per layer)              │
│   • Get probability from layer's probResolver               │
│   • Apply mass generosity settings                          │
│   • Compute width                                           │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│ calculateEdgeOffsets                                         │
│   • Bundle edges by node faces                              │
│   • Scale if total width > maxWidth                         │
│   • Assign vertical offsets                                 │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│ ConversionEdge (renders each edge)                          │
│   • Draws Bézier path with offsets                          │
│   • Applies stroke width/colour/opacity                      │
│   • Clips to chevron shape                                  │
│   • Renders edge label                                      │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│ VISUAL RESULT                                                │
│   • Multiple coloured overlays (one per visible layer)       │
│   • 'current' overlay shows What-If changes (pink)          │
│   • Wider edges where probabilities differ                  │
│   • Coloured fringes show divergence between layers          │
└─────────────────────────────────────────────────────────────┘
```

## File Locations

### Core Logic
- **`src/lib/whatIf.ts`**: `computeEffectiveEdgeProbability`, `parseWhatIfDSL`
- **`src/components/GraphCanvas.tsx`**: `calculateEdgeWidth`, `calculateEdgeOffsets`, scenario overlay logic
- **`src/components/edges/ConversionEdge.tsx`**: Final edge rendering

### State Management
- **`src/contexts/TabContext.tsx`**: `whatIfDSL`, `scenarioState` (per-tab)
- **`src/contexts/ScenariosContext.tsx`**: `scenarios[]`, base/current management
- **`src/contexts/ViewPreferencesContext.tsx`**: `massGenerosity`, `useUniformScaling`
- **`src/contexts/GraphStoreContext.tsx`**: Live `graph.edges[]`, `graph.nodes[]`

### UI Controls
- **`src/components/WhatIfAnalysisControl.tsx`**: What-If DSL editor
- **`src/components/panels/ScenariosPanel.tsx`**: Layer visibility toggles

## Common Issues & Solutions

### Issue 1: What-If Not Showing
**Symptom**: What-If applied but no visual change

**Check**:
1. Is `whatIfDSL` reaching `GraphCanvas`?
2. Is 'current' overlay being rendered? (it should always render, just with different opacity)
3. Is 'current' layer's `probResolver` using `computeEffectiveEdgeProbability` with `whatIfDSL`?
4. If 'current' is "hidden" (not in `visibleScenarioIds`), check opacity is 5% (visible but faint)

**Note**: 'current' does NOT need to be in `visibleScenarioIds` for What-If to work. It always renders, just at lower opacity when "hidden".

### Issue 2: Wrong Layer Compositing
**Symptom**: Scenario layer shows wrong values

**Check**:
1. Is the layer composing from ALL visible layers below it (not just base)?
2. Is 'base' being included in composition? (it should be for all scenario layers)
3. Is 'current' accidentally composing from scenarios? (it shouldn't - reads from live graph only)
4. Are only VISIBLE layers being used in composition? (hidden layers should be skipped)

### Issue 3: Interaction Not Working
**Symptom**: Can't click/edit edges

**Check**:
1. Are interactive edges `stroke='transparent'`? (correct when scenarios present)
2. Is `interactive = true`? (should ALWAYS be true, no VIEW ONLY mode)
3. Are overlay paths `pointerEvents='none'`? (they should be non-interactive)
4. Check browser console for React errors blocking interaction

### Issue 4: PMF Warnings Showing for Scenario Layers
**Symptom**: Multiple PMF warnings per node, or warnings about historical snapshots

**Problem**: PMF validation is being run per visible layer instead of only for 'current'.

**Check**:
1. Is PMF validation only calculating for 'current' layer (live graph + What-If)?
2. Are warnings being generated inside a loop over `visibleScenarioIds`? (wrong)
3. Is validation using `computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL })`? (correct)

**Fix**: PMF warnings should ONLY validate the live graph ('current' layer). Snapshots are frozen in time and not editable, so warnings about them are not actionable. Only warn about issues the user can fix.

---

*Last updated: 2025-11-13*
*Version: 2.0*
