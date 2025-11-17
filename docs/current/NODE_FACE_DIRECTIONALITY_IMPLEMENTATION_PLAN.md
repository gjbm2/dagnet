# Node-Face Directionality: Complete Implementation Plan

## Executive Summary

**Goal**: Remove chevron clipPaths entirely and encode edge directionality via **node face geometry** (convex for outbound, concave for inbound) in non-Sankey view.

**Approach**: Nodes will render a **curved outline SVG overlay** inside their existing ReactFlow rectangular card, preserving all current visual elements (fonts, badges, icons, layout, shadows, borders) while only varying the **outline shape** per face direction.

**Key Constraint**: ReactFlow nodes **must** remain rectangular HTML elements for layout/hit-testing. All geometry variance happens **inside** that rectangle via SVG.

---

## 1. Current Node Structure and Visual Elements

### 1.1 Existing Node Anatomy (ReactFlow `<div>` card)

Currently, `ConversionNode` renders as a rectangular `<div>` with:

1. **Outer container (ReactFlow node)**:
   - Rectangular bounding box: `width`, `height` (default 100px × 100px; Sankey uses dynamic sizing).
   - Position managed by ReactFlow layout.
   - Hit-testing, dragging, selection all rely on this rectangular boundary.

2. **Visual layers (CSS-based)**:
   - **Border**: `2px solid #ddd` (default), `5px solid #333` (selected), `2px solid #ff6b6b` (error), or custom case-node color.
   - **Background**: `#fff` (default), case-node color, or error tint.
   - **Box-shadow** (composed):
     - **Outer halo** (edge pseudo-clip): `0 0 0 5px #f8fafc` (canvas color).
     - **Base drop shadow**: `0 2px 4px rgba(0,0,0,0.1)` (unselected) or `0 4px 8px rgba(51,51,51,0.4)` (selected).
     - **Inner glow** (start/terminal nodes): `inset 0 0 20px 0px <color>` (blue for start, green/red/gray for terminal outcomes).
     - **Side shadows** (optional, for faceDirections hint): `±4px 0 8px -2px rgba(0,0,0,0.18)` per face (convex outer, concave inset).
   - **Padding**: `8px` for internal spacing.

3. **Internal content** (Flexbox layout):
   - **Label**: `font-weight: 500`, `font-size: 12px`, centered.
   - **Probability mass indicator** (if incomplete): Red text `PMF: XX%`.
   - **Case node status badge**: Colored pill (`background`, `text-transform: uppercase`, etc.).
   - **Event ID badge**: Monospace, yellow if overridden.
   - **Start node indicator**: Absolute-positioned blue dot (top-left corner).
   - **Terminal node indicator**: Absolute-positioned colored dot (bottom-right corner, green/red/gray).

4. **Handles** (ReactFlow connection points):
   - Four handles: `left`, `right`, `top`, `bottom`.
   - `8px × 8px`, `background: #555`.
   - Visibility: `opacity: 0` (default), `opacity: 1` (on hover or during connection).
   - In Sankey mode, only `left` and `right` handles are used; `top`/`bottom` are hidden.

5. **Delete button** (when selected):
   - Absolute-positioned top-right corner.
   - Red background on hover.

### 1.2 What Must Not Change

- **Outer card dimensions and layout**: ReactFlow requires rectangular nodes; `width`/`height` must remain as-is.
- **Internal content positioning and styling**: Labels, badges, icons, fonts, colors, spacing—all must look identical.
- **Interactivity**: Hover, click, drag, handle visibility, delete button—all must work exactly as before.
- **Border colors and weights**: Selected = thick black, error = red, case-node = purple, etc.—must be preserved.
- **Drop shadow depth and color**: The "lift" effect for selected nodes and the subtle shadow for unselected nodes must remain.
- **Inner glows** (start/terminal nodes): The blue/green/red inset shadows must remain.
- **Handles**: Position, size, visibility logic unchanged.

### 1.3 What Will Change

**Only the outline shape** of the node:

- **Border**: Instead of following a rectangular box, it will follow a **curved path** where faces are convex/concave.
- **Outer halo** (canvas-colored edge mask): Will follow the same curved path (slightly larger).
- **Drop shadow**: Will be cast by the curved outline, not a rectangle.
- **Side shadows** (directional hints): Will be replaced/upgraded by the actual geometry, or kept as subtle inner cues.

---

## 2. Proposed SVG Overlay Architecture

### 2.1 Dual-layer node structure with overflow accommodation

```
┌─────────────────────────────────────────────────────┐
│ ReactFlow <div> (rectangular, SIZED FOR OVERFLOW)  │ ← Padding added for convex bulges
│  ┌───────────────────────────────────────────────┐ │
│  │ SVG overlay (absolute, EXTENDED viewBox)      │ │ ← NEW
│  │  • viewBox includes padding for convex faces  │ │
│  │  • Curved outline path (can extend beyond 0,0,w,h) │ │
│  │  • Halo path (canvas color)                   │ │
│  │  • Border path (same color as CSS)            │ │
│  │  • Drop shadow (feDropShadow on path)         │ │
│  │  • z-index: 0 (behind content)                │ │
│  └───────────────────────────────────────────────┘ │
│  ┌───────────────────────────────────────────────┐ │
│  │ Node content (Flexbox, CENTERED in padding)   │ │
│  │  • Label, badges, icons                       │ │
│  │  • z-index: 1 (above SVG)                     │ │
│  │  • pointer-events: auto                       │ │
│  │  • Inset by padding to avoid convex overlap   │ │
│  └───────────────────────────────────────────────┘ │
│  Handles (ReactFlow, at ORIGINAL positions)        │
└─────────────────────────────────────────────────────┘
```

**Critical sizing constraint**: 

When a face is **convex**, the outline bulges **outward** by `CONVEX_DEPTH` pixels beyond the nominal node rectangle. This means:

1. **The ReactFlow node `div` must be sized larger** to accommodate the bulge.
2. **Content must be inset** so it doesn't overlap with the curved outline.
3. **Handles must remain at their nominal positions** (not shifted by the padding).

**Solution**:

- ReactFlow node dimensions: `width = nominalWidth + 2 * CONVEX_DEPTH`, `height = nominalHeight + 2 * CONVEX_DEPTH`.
  - For a 100×100 nominal node with `CONVEX_DEPTH = 12`: actual div is `124×124`.
- SVG `viewBox`: `viewBox="-CONVEX_DEPTH -CONVEX_DEPTH (nominalWidth + 2*CONVEX_DEPTH) (nominalHeight + 2*CONVEX_DEPTH)"`.
  - e.g. `viewBox="-12 -12 124 124"`.
  - The path is drawn in **nominal coordinates** `(0,0)` to `(100,100)`, but the viewBox is extended so convex bulges (at e.g. `x=-12` or `x=112`) are visible.
- Content div: `padding: CONVEX_DEPTH` (12px all sides), so the actual text/badges sit within the original 100×100 area.
- Handles: Positioned at **nominal edges** (e.g. `left` at x=12 in the padded div, which corresponds to x=0 in the nominal coordinate system).

**Example** (100×100 nominal, 12px convex depth):

```tsx
<div style={{
  width: '124px',     // 100 + 2*12
  height: '124px',    // 100 + 2*12
  padding: '12px',    // Content inset
  position: 'relative',
  ...
}}>
  <svg
    width="100%"
    height="100%"
    viewBox="-12 -12 124 124"  // Extended to show bulges
    style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}
  >
    <path d="M 0,0 L 0,100 Q 50,112 100,100 L 100,0 Q 50,-12 0,0 Z" ... />
    {/* ↑ Path in nominal coords; convex bottom goes to y=112, convex top to y=-12 */}
  </svg>

  <div style={{ position: 'relative', zIndex: 1 }}>
    {/* Content here, automatically inset by the outer padding */}
  </div>

  {/* Handles at nominal edges (accounting for padding) */}
  <Handle position={Position.Left} style={{ left: '12px' }} />  {/* x=0 in nominal */}
  <Handle position={Position.Right} style={{ right: '12px' }} /> {/* x=100 in nominal */}
  ...
</div>
```

### 2.2 SVG overlay implementation details

**SVG container**:
- `<svg>` element with:
  - `width="100%"`, `height="100%"`.
  - `viewBox="0 0 {w} {h}"` where `w`, `h` are the node's pixel dimensions.
  - `style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}`.
  - This sits **behind** the content div (which has `position: relative, zIndex: 1`).

**Geometry source** (single `pathD` string):
- Computed via `useMemo` from:
  - `data.faceDirections` (if present; fallback to all `'flat'`).
  - Node `width`, `height`.
  - Curvature depth constants (`CONVEX_DEPTH`, `CONCAVE_DEPTH`).
- Path construction:
  - Start at top-left `(0, 0)`.
  - Traverse **clockwise**: left face → bottom → right → top, each using `L` (straight) or `Q` (quadratic Bezier) based on face direction.
  - Close with `Z`.

**Layers drawn using the same `pathD`**:

1. **Halo (outermost, for edge masking)**:
   - `<path d={pathD} fill="none" stroke="#f8fafc" strokeWidth={10} />` (or larger if needed).
   - Purpose: hide edge segments near the node by painting over them in canvas color.
   - z-order: drawn first (bottom layer of the SVG).

2. **Border (middle)**:
   - `<path d={pathD} fill="none" stroke={borderColor} strokeWidth={borderWidth} />`.
   - `borderColor`: same logic as existing CSS border (black selected, red error, purple case-node, gray default).
   - `borderWidth`: same as CSS (`5` selected, `2` normal).
   - Purpose: provides the visible node outline.

3. **Fill (innermost)**:
   - `<path d={pathD} fill={backgroundColor} />`.
   - `backgroundColor`: `#fff` (default), case-node color, error tint.
   - Purpose: fills the interior of the curved outline so the node body is solid.

4. **Drop shadow**:
   - Wrap halo + border + fill in a `<g>` with `filter="url(#node-drop-shadow-{nodeId})"`.
   - Define filter:
     ```svg
     <filter id="node-drop-shadow-{nodeId}">
       <feDropShadow dx="0" dy="{2 or 4}" stdDeviation="{2 or 4}" floodColor="{shadow color}" />
     </filter>
     ```
   - Selected: `dy=4, stdDeviation=4, floodColor="rgba(51,51,51,0.4)"`.
   - Unselected: `dy=2, stdDeviation=2, floodColor="rgba(0,0,0,0.1)"`.
   - Error: `floodColor="rgba(255,107,107,0.3)"`.
   - Purpose: casts shadow from the curved outline, not the rectangular div.

5. **Inner glows** (start/terminal nodes):
   - Apply additional filters to the fill path:
     - Start node: `<feGaussianBlur>` + `<feFlood floodColor="rgba(191, 219, 254, 0.6)">` (blue glow).
     - Terminal success: green glow.
     - Terminal failure: red glow.
     - Terminal other: gray glow.
   - Alternative: keep these as `box-shadow: inset` in the CSS and let them apply to the rectangular div, since they're subtle inner effects and don't need to follow the outline exactly.

**Z-order and pointer events**:
- SVG overlay: `zIndex: 0`, `pointerEvents: 'none'` (so clicks pass through to content/handles).
- Content div: `zIndex: 1`, `pointerEvents: 'auto'`.
- This ensures the SVG provides pure decoration without breaking interactivity.

### 2.3 Why this preserves existing look

- **Layout**: The outer card is still a rectangular div; ReactFlow layout is unaffected.
- **Content**: All text, badges, icons render in the Flexbox div exactly as before; no changes to fonts, spacing, alignment.
- **Border**: The SVG path border uses the **exact same colors and weights** as the old CSS border, so visually it's identical except the shape is now curved.
- **Shadow**: The `feDropShadow` filter uses the **exact same offsets and colors** as the old `box-shadow`, just applied to the path instead of the box.
- **Halo**: The canvas-colored halo was already in `box-shadow`; now it's an SVG stroke, but same color/size so edges are clipped identically.
- **Handles**: Still positioned by ReactFlow at the rectangular boundaries; the SVG doesn't interfere.

**Net effect**: If you set all faces to `'flat'`, the SVG overlay draws a rectangle and the node looks **exactly as it did before**. When faces go convex/concave, **only the outline curves**; everything else stays the same.

---

## 3. Face Direction Computation (GraphCanvas)

### 3.1 Data flow

1. **Input**: `graph.edges` and `graph.nodes` from GraphStore.
2. **Timing**: Compute `faceDirections` **after** edges have been auto-routed and have `data.sourceFace` / `data.targetFace` populated.
   - **Critical**: Do NOT compute during the slow-path `toFlow()` sync, because `newEdges` from `toFlow()` do not yet have faces assigned.
   - **Correct**: Use a separate `useEffect` that depends on `[edges, nodes, useSankeyView]` and runs **after** auto-route completes.
3. **Processing**:
   - Initialize `faceStatsPerNode = new Map<nodeId, { left: {in, out}, right: {in, out}, top: {in, out}, bottom: {in, out} }>()`.
   - For each edge in `edges`:
     - `srcId = edge.source`, `tgtId = edge.target`.
     - `srcFace = edge.data.sourceFace`, `tgtFace = edge.data.targetFace`.
     - If `srcId` and `srcFace` exist: `faceStatsPerNode.get(srcId)[srcFace].out += 1`.
     - If `tgtId` and `tgtFace` exist: `faceStatsPerNode.get(tgtId)[tgtFace].in += 1`.
   - For each node:
     - `stats = faceStatsPerNode.get(node.id)`.
     - For each face (`left`, `right`, `top`, `bottom`):
       - If `stats[face].in > stats[face].out` → `'concave'`.
       - If `stats[face].out > stats[face].in` → `'convex'`.
       - If both zero or tied → `'flat'`.
     - Attach `faceDirections = { left, right, top, bottom }` to `node.data`.
4. **Output**: Call `setNodes(prevNodes => prevNodes.map(n => ({ ...n, data: { ...n.data, faceDirections } })))`.

### 3.2 When this runs

Use **similar timing pattern to the old chevron bundle recalculation**, adapted for lighter computation:

- **Effect type**: `useLayoutEffect` (synchronous before paint).
- **Dependencies**: `[edges, nodes, useSankeyView, setNodes]`.
- **Guards**:
  - Skip if `useSankeyView === true` (Sankey nodes stay flat).
  - Skip if `edges.length === 0` (no faces to compute).
  - **No drag guard needed**: Face direction computation is computationally light (simple counting + map lookup), unlike chevron bundle geometry which was heavier.
- **Debouncing**: **Double-RAF coalescing**:
  - `requestAnimationFrame` × 2 to wait for layout to settle after reroute/store sync.
  - Cancels pending RAFs on dependency change to avoid stale updates.
  - **Critical**: Without double-RAF, we might compute `faceDirections` from edges that are mid-reroute (with stale or missing `sourceFace`/`targetFace`).
- **Cleanup**: Cancel both RAF handles on unmount or dependency change.

**Why this matters**:
- `useLayoutEffect` ensures `faceDirections` are set before the browser paints, avoiding flash-of-wrong-geometry.
- Double-RAF ensures edges have settled after auto-route before we read their face data.

**Code structure** (matching chevron bundle pattern):

```tsx
const faceDirectionRaf1Ref = useRef<number | null>(null);
const faceDirectionRaf2Ref = useRef<number | null>(null);

useLayoutEffect(() => {
  if (useSankeyView) return;
  if (edges.length === 0) return;
  // No drag guard - face direction computation is light

  if (faceDirectionRaf1Ref.current) cancelAnimationFrame(faceDirectionRaf1Ref.current);
  if (faceDirectionRaf2Ref.current) cancelAnimationFrame(faceDirectionRaf2Ref.current);
  
  faceDirectionRaf1Ref.current = requestAnimationFrame(() => {
    faceDirectionRaf2Ref.current = requestAnimationFrame(() => {
      // Compute face stats and update nodes
      const faceStatsPerNode = new Map();
      edges.forEach(edge => { /* populate stats */ });
      setNodes(prevNodes => prevNodes.map(node => { /* attach faceDirections */ }));
    });
  });

  return () => {
    if (faceDirectionRaf1Ref.current) cancelAnimationFrame(faceDirectionRaf1Ref.current);
    if (faceDirectionRaf2Ref.current) cancelAnimationFrame(faceDirectionRaf2Ref.current);
    faceDirectionRaf1Ref.current = null;
    faceDirectionRaf2Ref.current = null;
  };
}, [edges, nodes, useSankeyView, setNodes]);
```

This is **identical in structure** to the chevron bundle effect (lines 2119-2143 in current `GraphCanvas.tsx`), just computing `faceDirections` instead of `edgeBundles`.

### 3.3 Curvature depth

For v1, use **fixed depth** per face type:
- `CONVEX_DEPTH = 12` (pixels outward).
- `CONCAVE_DEPTH = 12` (pixels inward).

For v2 (optional):
- Scale depth by edge count: `depth = min(12 + 2 * max(in, out), 24)`.
- Clamp to avoid wild distortion: `maxDepth = min(w, h) * 0.25`.

We pass `faceDirections` as enum (`'flat' | 'convex' | 'concave'`) for each face; depth is hardcoded in `ConversionNode` geometry builder for now.

---

## 4. Node Rendering: SVG Overlay Integration

### 4.1 Outer card (unchanged)

The `ConversionNode` component remains a **ReactFlow node rendered as a `<div>`**:

```tsx
<div 
  className="conversion-node ..."
  style={{
    padding: '8px',
    border: 'none', // ← REMOVE CSS border (now drawn by SVG)
    boxShadow: '...', // ← REMOVE outer halo + drop shadow (now drawn by SVG)
                      // ← KEEP inner glow (start/terminal) if desired
    ...nodeShape, // width, height
    background: '...', // ← KEEP or set to 'transparent' (SVG fill handles it)
    ...
  }}
>
  {/* SVG overlay goes here */}
  {/* Content goes here */}
  {/* Handles */}
</div>
```

**Changes to outer card CSS**:
- **Remove** `border: ...` from the div style (border is now SVG path).
- **Remove** outer halo and base drop shadow from `boxShadow` (now SVG).
- **Keep** inner glow `boxShadow` for start/terminal nodes **OR** migrate to SVG filters (decision point below).
- **Background**: Either keep as-is (so div has a background) or set to `transparent` and let SVG fill path handle it (cleaner, avoids double-painting).

### 4.2 SVG overlay structure

Place an `<svg>` as the **first child** of the node div:

```tsx
<div className="conversion-node" style={{ position: 'relative', ... }}>
  {/* SVG overlay for curved outline + halo + shadow */}
  {!data.useSankeyView && (
    <svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${w} ${h}`}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 0,
        overflow: 'visible', // Allow halo/shadow to extend beyond div boundary
      }}
    >
      <defs>
        {/* Per-node drop shadow filter */}
        <filter id={`node-shadow-${data.id}`}>
          <feDropShadow
            dx="0"
            dy={selected ? 4 : 2}
            stdDeviation={selected ? 4 : 2}
            floodColor={
              (probabilityMass && !probabilityMass.isComplete) || conditionalValidation?.hasProbSumError
                ? 'rgba(255,107,107,0.3)'
                : selected
                  ? 'rgba(51,51,51,0.4)'
                  : 'rgba(0,0,0,0.1)'
            }
          />
        </filter>
        {/* Optional: Inner glow filters for start/terminal nodes */}
        {isStartNode && (
          <filter id={`node-start-glow-${data.id}`}>
            <feGaussianBlur in="SourceAlpha" stdDeviation="10" />
            <feFlood floodColor="rgba(191, 219, 254, 0.6)" />
            <feComposite in2="blur" operator="in" />
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        )}
        {/* ...similar for terminal success/failure/other */}
      </defs>

      {/* Group for drop shadow */}
      <g filter={`url(#node-shadow-${data.id})`}>
        {/* Halo (outermost) */}
        <path
          d={outlinePathD}
          fill="none"
          stroke="#f8fafc"
          strokeWidth={10}
        />

        {/* Fill (node body) */}
        <path
          d={outlinePathD}
          fill={isCaseNode ? (caseNodeColor || '#e5e7eb') : '#fff'}
          filter={isStartNode ? `url(#node-start-glow-${data.id})` : isTerminalNode ? `url(#node-terminal-glow-${data.id})` : undefined}
        />

        {/* Border (visible outline) */}
        <path
          d={outlinePathD}
          fill="none"
          stroke={
            selected ? '#333'
              : (probabilityMass && !probabilityMass.isComplete) || conditionalValidation?.hasProbSumError
                ? '#ff6b6b'
                : isCaseNode
                  ? (caseNodeColor || '#7C3AED')
                  : '#ddd'
          }
          strokeWidth={selected ? 5 : 2}
        />
      </g>
    </svg>
  )}

  {/* Content div (above SVG, unchanged layout) */}
  <div style={{ position: 'relative', zIndex: 1, pointerEvents: 'auto', ... }}>
    {/* Label, badges, icons—exactly as before */}
  </div>

  {/* Handles (ReactFlow, unchanged) */}
  <Handle ... />
  <Handle ... />
  ...
</div>
```

### 4.3 Generating `outlinePathD`

**Helper function** (inside `ConversionNode`, memoized):

```tsx
const outlinePathD = useMemo(() => {
  const w = nodeShape.width ? parseFloat(nodeShape.width) : 100;
  const h = nodeShape.height ? parseFloat(nodeShape.height) : 100;
  
  // Fallback: if faceDirections is missing, all faces are flat (rectangular outline)
  const faces = data.faceDirections ?? {
    left: 'flat',
    right: 'flat',
    top: 'flat',
    bottom: 'flat',
  };

  const CONVEX_DEPTH = 12;
  const CONCAVE_DEPTH = 12;

  const buildFaceSegment = (face: 'left' | 'right' | 'top' | 'bottom', direction: 'flat' | 'convex' | 'concave'): string => {
    if (direction === 'flat') {
      // Straight line to the next corner
      if (face === 'left') return `L 0,${h}`; // top-left to bottom-left
      if (face === 'bottom') return `L ${w},${h}`; // bottom-left to bottom-right
      if (face === 'right') return `L ${w},0`; // bottom-right to top-right
      if (face === 'top') return `L 0,0`; // top-right to top-left
    }

    const depth = direction === 'convex' ? CONVEX_DEPTH : -CONCAVE_DEPTH;

    // Quadratic Bezier: control point is midway along the face, offset by depth perpendicular to face
    if (face === 'left') {
      // From (0, 0) to (0, h), control at (-depth, h/2)
      return `Q ${-depth},${h/2} 0,${h}`;
    }
    if (face === 'bottom') {
      // From (0, h) to (w, h), control at (w/2, h + depth)
      return `Q ${w/2},${h + depth} ${w},${h}`;
    }
    if (face === 'right') {
      // From (w, h) to (w, 0), control at (w + depth, h/2)
      return `Q ${w + depth},${h/2} ${w},0`;
    }
    if (face === 'top') {
      // From (w, 0) to (0, 0), control at (w/2, -depth)
      return `Q ${w/2},${-depth} 0,0`;
    }

    return '';
  };

  // Build full path: start top-left, clockwise
  let path = `M 0,0`;
  path += ' ' + buildFaceSegment('left', faces.left);
  path += ' ' + buildFaceSegment('bottom', faces.bottom);
  path += ' ' + buildFaceSegment('right', faces.right);
  path += ' ' + buildFaceSegment('top', faces.top);
  path += ' Z';

  return path;
}, [data.faceDirections, nodeShape.width, nodeShape.height]);
```

**Important**: This path is in **local coordinates** `(0, 0)` to `(w, h)`, matching the `viewBox`. No need to worry about canvas position; the SVG is positioned by the div.

### 4.4 Handling corners

With quadratic Beziers per face, corners are **sharp** (the path goes from one face's endpoint directly to the next face's startpoint). If we want **rounded corners** even when faces are flat:

- Option 1: Apply a small `border-radius` to the **div** itself (visual only, doesn't affect the SVG).
- Option 2: Extend the `buildFaceSegment` logic to add small arc segments (`A`) at corners.
- For v1, **sharp corners are acceptable** to keep the implementation simple.

### 4.5 Sankey view

When `data.useSankeyView === true`:
- **Do not render the SVG overlay** (the entire `{!data.useSankeyView && <svg>...</svg>}` block is skipped).
- **Use the original CSS-based node**:
  - Border via CSS `border: 2px solid #ddd`.
  - Drop shadow via CSS `boxShadow: 0 2px 4px ...`.
  - Background via CSS `background: #fff`.
- This ensures Sankey nodes remain exactly as they were.

---

## 5. Edge Geometry Adjustments

### 5.1 Current edge anchor behavior

Edges currently use:
- `sourceX`, `sourceY`: ReactFlow-provided position at the handle (on the rectangular node boundary).
- `data.sourceOffsetX`, `data.sourceOffsetY`: Bundle-based vertical/horizontal offset for parallel edges.

After adding offsets:
- `baseSourceX = sourceX + sourceOffsetX`.
- `baseSourceY = sourceY + sourceOffsetY`.

This `(baseSourceX, baseSourceY)` is where the edge **logically** starts, on the rectangular node boundary.

### 5.2 Insetting for concave faces

**Problem**: With concave faces, if the edge starts exactly at the rectangular boundary, there's a visible gap between the edge and the curved face.

**Solution**: Pull the edge start/end points **slightly under** the rectangular boundary (into the node body). Since nodes are z-ordered above edges, this segment is hidden by the node, and the visible edge appears to start at the curved face.

**Implementation** (in `ConversionEdge.tsx`):

```tsx
const INSET = data?.useSankeyView ? 0 : 10; // pixels

// Adjust source
let adjustedSourceX = baseSourceX;
let adjustedSourceY = baseSourceY;
if (!data?.useSankeyView) {
  if (sourcePosition === Position.Left) adjustedSourceX += INSET;
  else if (sourcePosition === Position.Right) adjustedSourceX -= INSET;
  else if (sourcePosition === Position.Top) adjustedSourceY += INSET;
  else if (sourcePosition === Position.Bottom) adjustedSourceY -= INSET;
}

// Similar for target
let adjustedTargetX = baseTargetX;
let adjustedTargetY = baseTargetY;
if (!data?.useSankeyView) {
  if (targetPosition === Position.Left) adjustedTargetX += INSET;
  else if (targetPosition === Position.Right) adjustedTargetX -= INSET;
  else if (targetPosition === Position.Top) adjustedTargetY += INSET;
  else if (targetPosition === Position.Bottom) adjustedTargetY -= INSET;
}
```

**Bezier path**: Use `(adjustedSourceX, adjustedSourceY)` and `(adjustedTargetX, adjustedTargetY)` as the start/end of the cubic Bezier.

**Control points**: Compute from the **base (face) positions**, not the adjusted positions:
- `dx = baseTargetX - baseSourceX`, `dy = baseTargetY - baseSourceY`.
- `distance = sqrt(dx^2 + dy^2)`, `controlDistance = distance * curvature`.
- `c1 = baseSource + controlDistance * faceDirection`.
- `c2 = baseTarget + controlDistance * faceDirection`.

This keeps control points **near the node face** while the actual path starts **under the face**, so the curvature emerges cleanly.

### 5.3 Calculating required `INSET` for concave faces

**Geometry problem**: On a **concave face**, the curved outline is indented **inward** from the nominal rectangular boundary by `CONCAVE_DEPTH` pixels at the face midpoint.

For edges to be fully hidden by the halo, the edge endpoint must be pulled **at least as far under** the rectangular boundary as the deepest point of the concave curve.

**Worst case** (concave face, edge at face midpoint):
- Nominal boundary at `x = 0` (left face).
- Concave curve pulls face inward to `x = CONCAVE_DEPTH` at `y = h/2`.
- Halo is `HALO_WIDTH` pixels wide, starting from the curved path.
- For the halo to fully cover the edge, the edge endpoint must be at:
  - `x ≥ CONCAVE_DEPTH + HALO_WIDTH`.

**Conservative formula**:
```
INSET = CONCAVE_DEPTH + HALO_WIDTH
```

**Example** (12px concave, 12px halo):
- `INSET = 12 + 12 = 24px`.

**For convex faces**, the curve bulges outward, so edges don't need to be as deeply inset:
- Nominal boundary at `x = 0`.
- Convex curve at `x = -CONVEX_DEPTH` (outside the rect).
- Edge only needs to clear the halo width: `INSET = HALO_WIDTH = 12px`.

**Recommendation**:
- Use a **single conservative `INSET`** for all faces: `INSET = max(CONCAVE_DEPTH, CONVEX_DEPTH) + HALO_WIDTH`.
  - For `CONVEX_DEPTH = CONCAVE_DEPTH = 12`, `HALO_WIDTH = 12`: **`INSET = 24px`**.
- If edges bunch too much, we can differentiate:
  - `INSET_CONCAVE = CONCAVE_DEPTH + HALO_WIDTH` (e.g. 24px).
  - `INSET_CONVEX = HALO_WIDTH` (e.g. 12px).
  - `INSET_FLAT = HALO_WIDTH` (e.g. 12px).
  - But for v1, **use uniform `INSET = 24px`** to guarantee no gaps.

### 5.4 Bead start point adjustment for curved faces

**Problem**: Beads currently use a fixed `visibleStartOffset` along the edge path, measured from the edge's start point. With curved node faces, the **effective node boundary** is no longer rectangular, so beads need adjustment.

**Convex face** (outbound edges):
- The node face bulges **outward** by `CONVEX_DEPTH` at the midpoint.
- An edge leaving from a convex face exits the node **closer** to the edge start point (because the face is pushed outward).
- **Without adjustment**: Beads would appear **too close** to the node on convex faces (because `visibleStartOffset` is measured from the nominal rectangular boundary, which is now inside the convex bulge).

**Concave face** (inbound edges):
- The node face is indented **inward** by `CONCAVE_DEPTH` at the midpoint.
- An edge arriving at a concave face meets the node **farther** from the edge end point (because the face is pulled inward).
- For **inbound beads** (which we may not have), similar logic applies, but typically beads are on outbound edges only.

**Geometric solution for convex outbound faces**:

The edge path starts at `(adjustedSourceX, adjustedSourceY)`, which is `INSET` pixels under the **nominal** rectangular boundary. But the **visual** node boundary (convex curve) is `CONVEX_DEPTH` pixels **outside** the nominal boundary at the face midpoint.

So the **effective distance** from the visual boundary to the edge start is:
```
effectiveDistance = INSET + CONVEX_DEPTH
```

For beads to appear at a constant visual distance `D_BEAD` from the node face (e.g. 12px):
```
visibleStartOffset = effectiveDistance - D_BEAD
                   = (INSET + CONVEX_DEPTH) - D_BEAD
```

**Example** (convex face, INSET=24px, CONVEX_DEPTH=12px, D_BEAD=12px):
```
visibleStartOffset = (24 + 12) - 12 = 24px
```

**For concave faces**:
```
effectiveDistance = INSET - CONCAVE_DEPTH
visibleStartOffset = (INSET - CONCAVE_DEPTH) - D_BEAD
```

**Example** (concave face, INSET=24px, CONCAVE_DEPTH=12px, D_BEAD=12px):
```
visibleStartOffset = (24 - 12) - 12 = 0px
```

**For flat faces**:
```
effectiveDistance = INSET
visibleStartOffset = INSET - D_BEAD
```

**Example** (flat face, INSET=24px, D_BEAD=12px):
```
visibleStartOffset = 24 - 12 = 12px
```

**Implementation strategy**:

1. **In `EdgeBeads` or `ConversionEdge`**, compute `visibleStartOffset` based on the **source node's face direction**:
   ```tsx
   const sourceFace = data?.sourceFace; // 'left', 'right', 'top', 'bottom'
   const sourceFaceDirection = sourceNode?.data?.faceDirections?.[sourceFace] ?? 'flat';
   
   let visibleStartOffset;
   if (sourceFaceDirection === 'convex') {
     visibleStartOffset = (INSET + CONVEX_DEPTH) - D_BEAD;
   } else if (sourceFaceDirection === 'concave') {
     visibleStartOffset = (INSET - CONCAVE_DEPTH) - D_BEAD;
   } else { // 'flat'
     visibleStartOffset = INSET - D_BEAD;
   }
   ```

2. **Pass `visibleStartOffset` to `EdgeBeadsRenderer`** (as is done currently, but now computed per edge based on source face geometry).

3. **Verify visually**: Beads should sit at a consistent apparent distance from the visible node outline across all face types.

**Approximation note**: This assumes edges leave perpendicular to the face. For edges at an angle, the geometry is more complex (need to project along the edge direction), but for v1 this approximation should be acceptable.

---

## 6. Halo and Edge Clipping

### 6.1 Halo purpose

The **canvas-colored halo** (`stroke="#f8fafc"`) acts as a **visual mask** for edges:
- Edges are rendered in the SVG layer (below nodes in z-order).
- The node's halo path is drawn **above edges** (nodes have `z-index: 2000` in CSS).
- The halo paints over edge segments near the node, creating the illusion that edges are clipped by the node outline.

### 6.2 Halo sizing

- **`strokeWidth`**: Should be **larger than the maximum edge inset** to ensure full coverage.
  - If `INSET = 10px`, halo should be at least `strokeWidth={12}` (or more conservatively `strokeWidth={16}`).
  - Larger values (e.g. 20) provide more margin but risk painting over nearby elements.

- **Positioning**: The halo uses the **same `pathD`** as the border, so it follows the exact outline shape. It's drawn **first** in the SVG (bottom layer), so the fill and border are drawn on top of it.

### 6.3 Why this avoids chevron-style clipPaths

- **One halo per node**, not one clipPath per edge bundle.
- Halo is a simple `<path>` with a stroke; no per-frame `<clipPath>` DOM churn.
- The browser composites the halo in the same render pass as the node; no separate clipping geometry recalculation.

### 6.4 Edge z-order

- **Edges**: Default z-index in ReactFlow's SVG layer.
- **Nodes**: `z-index: 2000 !important` in CSS (set in `custom-reactflow.css`).
- This ensures nodes (including their halo) always render on top of edges, so the halo can mask edge segments.

---

## 7. Drop Shadow and Filters

### 7.1 Drop shadow implementation

**Current** (CSS `box-shadow`):
- `box-shadow: 0 2px 4px rgba(0,0,0,0.1)` (unselected).
- `box-shadow: 0 4px 8px rgba(51,51,51,0.4)` (selected).

**New** (SVG `feDropShadow`):
- Wrap the halo/fill/border paths in a `<g filter="url(#node-shadow-{nodeId})">`.
- Define filter:
  ```svg
  <filter id="node-shadow-{nodeId}">
    <feDropShadow
      dx="0"
      dy={selected ? 4 : error ? 2 : 2}
      stdDeviation={selected ? 4 : error ? 2 : 2}
      floodColor={error ? 'rgba(255,107,107,0.3)' : selected ? 'rgba(51,51,51,0.4)' : 'rgba(0,0,0,0.1)'}
    />
  </filter>
  ```

**Why SVG filter instead of CSS**:
- CSS `box-shadow` follows the rectangular div boundary.
- SVG `feDropShadow` follows the **curved path**, so the shadow accurately reflects the convex/concave outline.

**Performance**:
- One filter per node (7-10 filters for a typical graph) is fine; browsers handle this efficiently.
- No per-edge filters; only per-node.

### 7.2 Inner glows (start/terminal nodes)

**Current** (CSS `box-shadow: inset`):
- Start: `inset 0 0 20px 0px rgba(191, 219, 254, 0.6)` (blue).
- Terminal success: `inset 0 0 20px 0px rgba(187, 247, 208, 0.6)` (green).
- Terminal failure: `inset 0 0 20px 0px rgba(254, 202, 202, 0.6)` (red).
- Terminal other: `inset 0 0 20px 0px rgba(229, 231, 235, 0.6)` (gray).

**Option A** (keep as CSS `box-shadow`):
- The div retains `boxShadow: inset 0 0 20px ...` for start/terminal nodes.
- This glow applies to the rectangular div boundary, which is still present (just no longer has an outer shadow).
- **Pros**: Simpler; no need to migrate inner glows to SVG.
- **Cons**: The glow won't perfectly follow the curved outline (it will be slightly off at curved faces). Likely **acceptable** since it's a subtle inner effect.

**Option B** (migrate to SVG filter):
- Apply a second filter to the **fill path** (not the whole group):
  ```svg
  <path
    d={outlinePathD}
    fill={backgroundColor}
    filter="url(#node-start-glow-{nodeId})"
  />
  ```
- Define filters using `feGaussianBlur` + `feFlood` + `feComposite` to create an inward glow.
- **Pros**: Glow follows curved outline exactly.
- **Cons**: More complex filter setup; more filters to manage.

**Recommendation for v1**: **Option A** (keep CSS inner glow). If the curved outline and halo work well, the slight mismatch on inner glows is negligible. Migrate to Option B later if needed for polish.

---

## 8. Implementation Steps (Revised)

### Step 1: Remove chevron system COMPLETELY

**Delete entirely** (not comment out):

1. **Files to delete**:
   - `/graph-editor/src/components/ChevronClipPaths.tsx`
   - `/graph-editor/src/lib/chevronClipping.ts` (or `.tsx`)

2. **In `GraphCanvas.tsx`**:
   - Remove import: `import { ChevronClipPaths } from './ChevronClipPaths';`
   - Remove import: `import { groupEdgesIntoBundles, EdgeBundle, MIN_CHEVRON_THRESHOLD } from '@/lib/chevronClipping';`
   - Remove state: `const [edgeBundles, setEdgeBundles] = useState<EdgeBundle[]>([]);`
   - Remove any `useEffect` / `useLayoutEffect` that calls `groupEdgesIntoBundles` or `setEdgeBundles`.
   - Remove any JSX that renders `<ChevronClipPaths bundles={...} />`.
   - Remove any references to `bundles`, `edgeBundles`, `fullBundles`, `MIN_CHEVRON_THRESHOLD`.

3. **In `ConversionEdge.tsx`**:
   - Remove any code that uses `data.sourceClipPathId`, `data.targetClipPathId`, `data.renderFallbackTargetArrow`.
   - Remove any `<g style={{ clipPath: ... }}>` wrappers.
   - Remove marker definitions that were only used for chevron fallback arrows.

4. **In `EdgeBeads.tsx`**:
   - Remove `computeVisibleStartOffsetForEdge` function.
   - Remove `isPointInTriangle`, `sign` helper functions (chevron-specific geometry).
   - Remove any `sourceClipPathId` prop or logic.

5. **URL params**:
   - Remove `?nochevrons` logic (since chevrons are gone).

**Verification**:
- `grep -r "chevron" graph-editor/src --include="*.tsx" --include="*.ts"` should return **zero matches** (or only comments/historical notes).
- `grep -r "ClipPath" graph-editor/src --include="*.tsx" --include="*.ts"` should return **zero matches** (except `clip-path:` in CSS if used for other purposes).
- `grep -r "groupEdgesIntoBundles" graph-editor/src` should return **zero matches**.
- `grep -r "EdgeBundle" graph-editor/src` should return **zero matches**.

### Step 2: Compute `faceDirections`

**Starting state**: After revert, there is **no `faceDirections` code** in the codebase. We are starting from scratch.

**Implementation**:
1. **In `GraphCanvas`**, add a new `useEffect`:
   ```tsx
   useEffect(() => {
     if (useSankeyView || edges.length === 0) return;

     const faceStatsPerNode = new Map();
     edges.forEach(edge => {
       const srcId = edge.source;
       const tgtId = edge.target;
       const srcFace = edge.data?.sourceFace;
       const tgtFace = edge.data?.targetFace;

       if (srcId && srcFace) {
         if (!faceStatsPerNode.has(srcId)) {
           faceStatsPerNode.set(srcId, {
             left: { in: 0, out: 0 },
             right: { in: 0, out: 0 },
             top: { in: 0, out: 0 },
             bottom: { in: 0, out: 0 },
           });
         }
         faceStatsPerNode.get(srcId)[srcFace].out += 1;
       }

       if (tgtId && tgtFace) {
         if (!faceStatsPerNode.has(tgtId)) {
           faceStatsPerNode.set(tgtId, {
             left: { in: 0, out: 0 },
             right: { in: 0, out: 0 },
             top: { in: 0, out: 0 },
             bottom: { in: 0, out: 0 },
           });
         }
         faceStatsPerNode.get(tgtId)[tgtFace].in += 1;
       }
     });

     setNodes(prevNodes => prevNodes.map(node => {
       const stats = faceStatsPerNode.get(node.id);
       if (!stats) return node;

       const classifyFace = (face) => {
         const s = stats[face];
         if (!s) return 'flat';
         if (s.in > 0 && s.out === 0) return 'concave';
         if (s.out > 0 && s.in === 0) return 'convex';
         if (s.out > s.in) return 'convex';
         if (s.in > s.out) return 'concave';
         return 'flat';
       };

       return {
         ...node,
         data: {
           ...node.data,
           faceDirections: {
             left: classifyFace('left'),
             right: classifyFace('right'),
             top: classifyFace('top'),
             bottom: classifyFace('bottom'),
           },
         },
       };
     }));
   }, [edges, useSankeyView, setNodes]);
   ```

2. **Timing**: This runs **after** edges have been auto-routed and `sourceFace`/`targetFace` are populated.
3. **Debouncing**: Wrap in double-RAF if edge updates are frequent, or rely on React batching if updates are infrequent.

### Step 3: Integrate SVG overlay into `ConversionNode`

1. **Compute `outlinePathD`** (per §4.3 above).
2. **Restructure node JSX**:
   - Keep the outer `<div>` for ReactFlow.
   - Remove CSS `border` and outer `box-shadow` (halo + drop).
   - Add SVG overlay as first child (z-index 0).
   - Ensure content div has `position: relative, zIndex: 1`.
3. **SVG overlay renders**:
   - Halo path (canvas color, thick stroke).
   - Fill path (background color).
   - Border path (outline color, matching old CSS border logic).
   - Wrap in `<g filter="...">` for drop shadow.
4. **Test**:
   - With `faceDirections` all `'flat'`, nodes should look **identical** to the old rectangular nodes.
   - Toggle one face to `'convex'` or `'concave'` manually in dev tools to confirm outline curves.

### Step 4: Verify edge insetting

1. **In `ConversionEdge`**, confirm `INSET = 10` (or `INSET_DEEP = 10` if that variable name is used).
2. **Visual test**:
   - Edges should start slightly under the node outline.
   - With the halo masking them, they should appear to emerge cleanly from the curved faces.
   - No visible gaps on concave faces, no overlap on convex faces.
3. **Tune `INSET`** if needed (8–15px range).

### Step 5: Clean up logging

Remove diagnostic `console.log` calls added during development:
- `[GraphCanvas] Computing face stats ...`
- `[GraphCanvas] Edge face data: ...`
- `[GraphCanvas] Looking up stats for node ...`
- `[GraphCanvas] Attaching faceDirections ...`
- `[ConversionNode] Not using curved path ...`
- `[ConversionNode] Generating curved path ...`

### Step 6: Test in non-Sankey mode

1. **Load a graph** with multiple nodes and edges.
2. **Verify**:
   - Nodes have curved outlines where faces have inbound/outbound edges.
   - Edges appear to connect cleanly to the curved faces (no gaps, no overlap).
   - Beads appear at consistent distances from the node boundary.
   - All labels, badges, icons, start/terminal indicators render correctly.
   - Selected nodes have thick black curved outlines and deeper shadows.
   - Error nodes have red curved outlines.
   - Case nodes have purple curved outlines.
3. **Pan/zoom**:
   - **Beads and chevrons suppress and restore correctly** (existing atomic restoration behavior).
   - **Node geometry (SVG overlay) is NOT suppressed** during pan/zoom:
     - The curved outline remains visible at all times.
     - Only beads (HTML portals) are suppressed via `beadsVisible` flag.
     - Chevrons are gone, so no chevron suppression logic.
   - No performance regression vs. pre-chevron-removal baseline (smooth pan/zoom, no jank).

### Step 7: Test in Sankey mode

1. **Toggle to Sankey view**.
2. **Verify**:
   - Nodes are rectangular (no SVG overlay, original CSS border/shadow).
   - Edges are straight horizontal ribbons.
   - Layout is left-to-right.
   - No curved faces, no halo overlay.

---

## 9. Critical Implementation Pitfalls to Avoid

### 9.1 Don't replace the outer node card

- **Wrong**: `<svg>` as the top-level node element, with `<foreignObject>` for content.
- **Right**: `<div>` (ReactFlow node) with `<svg>` as an internal decoration layer.

**Why**: ReactFlow's drag/layout/hit-testing expects a rectangular HTML element. Replacing it breaks handles, selection, and positioning.

### 9.2 Don't compute `faceDirections` before edges have faces

- **Wrong**: Compute in the `toFlow()` sync effect from `newEdges` (which have no `sourceFace`/`targetFace` yet).
- **Right**: Compute in a separate `useEffect` from the current `edges` array (which has faces from auto-route).

**Why**: Auto-route assigns faces **after** `toFlow()` runs. Computing from `newEdges` yields empty stats.

### 9.3 Don't use different `pathD` for halo/border/shadow

- **Wrong**: Separate path strings for halo (offset outward), border (exact), shadow (different shape).
- **Right**: **Single `pathD`** used for all three; vary only `fill`, `stroke`, `strokeWidth`, `filter`.

**Why**: If halo/border/shadow have different shapes, they won't align, creating visual artifacts. The halo should be slightly thicker (via `strokeWidth`) but follow the exact same path.

### 9.4 Don't migrate content layout to SVG

- **Wrong**: Put labels/badges/icons in `<text>` or `<foreignObject>` inside the SVG overlay.
- **Right**: Keep content in the **existing Flexbox `<div>`** structure, z-ordered above the SVG.

**Why**: Flexbox handles text wrapping, alignment, and dynamic sizing cleanly. SVG `<text>` is fragile and breaks existing layout. The SVG is **decoration only**.

### 9.5 Don't apply the same filter to all paths

- **Wrong**: One big filter that tries to combine drop shadow + inner glow + border effects.
- **Right**:
  - Drop shadow filter on the **group** wrapping halo/fill/border.
  - Inner glow filter (if migrated to SVG) on the **fill path only**.

**Why**: Filters compose incorrectly if applied to the wrong elements. Drop shadow should affect the whole outline; inner glow should only affect the fill.

### 9.6 Don't forget to set `pointerEvents: 'none'` on SVG

- **Wrong**: SVG overlay with default pointer events; clicks on the outline don't reach content/handles.
- **Right**: `<svg style={{ pointerEvents: 'none' }}>`.

**Why**: The SVG is decoration. All interaction (clicks, drags, hover) must target the content div and handles.

### 9.7 Don't use global filter IDs

- **Wrong**: `<filter id="node-shadow">` (one global filter for all nodes).
- **Right**: `<filter id="node-shadow-{data.id}">` (one filter per node, uniquely scoped).

**Why**: Different nodes have different states (selected, error, case-node color). Each node's filter must reflect its own state. Global filters would apply the wrong shadow to nodes with different states, or require complex state management in a shared `<defs>`.

**Trade-off**: This creates N filters (one per node), which is fine for 7–20 nodes but could be optimized later by batching nodes with identical states into shared filter IDs.

---

## 10. Detailed Node Rendering Pseudocode

```tsx
export default function ConversionNode({ data, selected }: NodeProps<ConversionNodeData>) {
  // ... existing hooks, state, logic (unchanged) ...

  // Compute curved outline path
  const outlinePathD = useMemo(() => {
    if (data.useSankeyView) return null; // Sankey uses CSS rendering

    const w = parseFloat(nodeShape.width) || 100;
    const h = parseFloat(nodeShape.height) || 100;
    const faces = data.faceDirections ?? { left: 'flat', right: 'flat', top: 'flat', bottom: 'flat' };
    
    const CONVEX_DEPTH = 12;
    const CONCAVE_DEPTH = 12;

    const buildFaceSegment = (face, direction) => {
      if (direction === 'flat') {
        if (face === 'left') return `L 0,${h}`;
        if (face === 'bottom') return `L ${w},${h}`;
        if (face === 'right') return `L ${w},0`;
        if (face === 'top') return `L 0,0`;
      }
      const depth = direction === 'convex' ? CONVEX_DEPTH : -CONCAVE_DEPTH;
      if (face === 'left') return `Q ${-depth},${h/2} 0,${h}`;
      if (face === 'bottom') return `Q ${w/2},${h + depth} ${w},${h}`;
      if (face === 'right') return `Q ${w + depth},${h/2} ${w},0`;
      if (face === 'top') return `Q ${w/2},${-depth} 0,0`;
      return '';
    };

    let path = `M 0,0`;
    path += ' ' + buildFaceSegment('left', faces.left);
    path += ' ' + buildFaceSegment('bottom', faces.bottom);
    path += ' ' + buildFaceSegment('right', faces.right);
    path += ' ' + buildFaceSegment('top', faces.top);
    path += ' Z';

    return path;
  }, [data.useSankeyView, data.faceDirections, nodeShape.width, nodeShape.height]);

  // Determine colors and styles (existing logic)
  const borderColor = selected ? '#333' : error ? '#ff6b6b' : isCaseNode ? caseNodeColor : '#ddd';
  const borderWidth = selected ? 5 : 2;
  const backgroundColor = isCaseNode ? caseNodeColor : '#fff';
  const shadowColor = error ? 'rgba(255,107,107,0.3)' : selected ? 'rgba(51,51,51,0.4)' : 'rgba(0,0,0,0.1)';
  const shadowY = selected ? 4 : 2;
  const shadowBlur = selected ? 4 : 2;

  return (
    <Tooltip content={getTooltipContent()} position="top" delay={300}>
      <div
        className="conversion-node ..."
        style={{
          position: 'relative',
          padding: '8px',
          border: 'none', // Removed; SVG border now
          background: outlinePathD ? 'transparent' : backgroundColor, // SVG handles fill if outline present
          boxShadow: outlinePathD
            ? (isStartNode || isTerminalNode ? '...' : 'none') // Keep inner glow if desired, remove outer
            : '...', // Fallback to old box-shadow if no SVG
          ...nodeShape,
          cursor: 'pointer',
          boxSizing: 'border-box',
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* SVG overlay (curved outline + halo + shadow) */}
        {outlinePathD && (
          <svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${parseFloat(nodeShape.width) || 100} ${parseFloat(nodeShape.height) || 100}`}
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              zIndex: 0,
              overflow: 'visible',
            }}
          >
            <defs>
              <filter id={`node-shadow-${data.id}`}>
                <feDropShadow dx="0" dy={shadowY} stdDeviation={shadowBlur} floodColor={shadowColor} />
              </filter>
              {/* Optional: inner glow filters */}
            </defs>

            <g filter={`url(#node-shadow-${data.id})`}>
              {/* Halo (edge masking) */}
              <path d={outlinePathD} fill="none" stroke="#f8fafc" strokeWidth={12} />

              {/* Fill */}
              <path d={outlinePathD} fill={backgroundColor} />

              {/* Border */}
              <path d={outlinePathD} fill="none" stroke={borderColor} strokeWidth={borderWidth} />
            </g>
          </svg>
        )}

        {/* Content (unchanged, z-index above SVG) */}
        <div style={{ position: 'relative', zIndex: 1, pointerEvents: 'auto' }}>
          <div style={{ fontWeight: '500', marginBottom: '4px', wordBreak: 'break-word' }}>
            {data.label}
          </div>
          {/* ... badges, icons, exactly as before ... */}
        </div>

        {/* Handles (unchanged) */}
        <Handle type="target" position={Position.Left} id="left" style={{ ... }} />
        <Handle type="target" position={Position.Top} id="top" style={{ ... }} />
        <Handle type="source" position={Position.Right} id="right-out" style={{ ... }} />
        <Handle type="source" position={Position.Bottom} id="bottom-out" style={{ ... }} />

        {/* Delete button (unchanged) */}
        {selected && (
          <div style={{ position: 'absolute', top: 0, right: 0, ... }} onClick={handleDelete}>
            ×
          </div>
        )}
      </div>
    </Tooltip>
  );
}
```

### Step 3: Verify edge insetting

- Confirm `INSET` or `INSET_DEEP` is set to `10` in `ConversionEdge`.
- Edges should start under the node; halo masks the hidden segment.

### Step 4: Test and tune

- **Load graph**: Verify nodes look correct (curved outlines, same labels/badges/icons/shadows).
- **Pan/zoom**: Verify no performance regression.
- **Sankey toggle**: Verify Sankey nodes use old CSS rendering.
- **Tune curvature**: Adjust `CONVEX_DEPTH` / `CONCAVE_DEPTH` if faces are too subtle or too aggressive.

---

## 11. Alternative Approaches (for reference only)

If SVG overlay proves problematic, alternative geometry strategies:

1. **CSS `clip-path: path(...)`**:
   - Apply CSS clip-path to the node div using the same `pathD` string.
   - **Cons**: Requires `clip-path` browser support, can't independently control halo/shadow/border layers, likely same or worse perf than SVG.

2. **CSS `border-image` + mask**:
   - Use border-image with SVG source for curved borders.
   - **Cons**: Complex, limited control, browser inconsistencies.

3. **Canvas-based rendering**:
   - Draw nodes on a `<canvas>` element.
   - **Cons**: Breaks ReactFlow integration, requires full renderer rewrite, not feasible.

**None of these are preferred**. The SVG overlay approach is the correct one; these are documented only for completeness.

---

## 11. Visual Element Positioning Analysis

This section analyzes **every visual element** in the node to ensure nothing conflicts with the curved outline or gets mispositioned due to the padding/viewBox changes.

### 11.1 Elements that apply at div level (not SVG)

These are rendered as HTML inside the content div and positioned using CSS:

#### 11.1.1 Node label (main text)
- **Current**: Centered in the card via Flexbox (`display: flex, justifyContent: center, alignItems: center`).
- **With padding**: The content div has `padding: CONVEX_DEPTH` (12px), so the Flexbox centering happens within the **padded area**.
- **Effect**: Label is centered in the **nominal 100×100** area (after accounting for padding), not the full 124×124 div.
- **Conflict check**: ✅ No conflict. Label stays well inside the curved outline (which is at the edge of the nominal area).

#### 11.1.2 Probability mass indicator (PMF: XX%)
- **Current**: Below the label, also Flexbox-centered.
- **With padding**: Same as label; centered within padded area.
- **Conflict check**: ✅ No conflict. Stays inside nominal area.

#### 11.1.3 Case node status badge
- **Current**: Below label, Flexbox-centered, `padding: 2px 6px`, small text.
- **With padding**: Centered within padded area.
- **Conflict check**: ✅ No conflict. Small badge stays well inside nominal area.

#### 11.1.4 Event ID badge
- **Current**: Below status badge, Flexbox-centered, monospace text.
- **With padding**: Centered within padded area.
- **Conflict check**: ✅ No conflict. Stays inside nominal area.

#### 11.1.5 Start node indicator (blue dot, top-left)
- **Current**: `position: absolute, top: 4px, left: 4px`, `width: 12px, height: 12px`.
- **With padding**: The `top: 4px, left: 4px` is relative to the **padded div's content area**.
  - In the 124×124 div with 12px padding, `top: 4px, left: 4px` puts the dot at:
    - Absolute position: `(12 + 4, 12 + 4) = (16, 16)` in the div.
    - Nominal position: `(4, 4)` in the 100×100 nominal area.
- **Conflict check**: 
  - The dot center is at `(16 + 6, 16 + 6) = (22, 22)` in div coords, or `(10, 10)` in nominal coords.
  - The nominal area starts at `(0, 0)` and the curved outline might bulge outward to `(-12, -12)` at a convex corner, but the **outline itself** is inside the nominal boundary at the corners (curvature is only on the **faces**, not at corners, per our quadratic Bezier construction).
  - **Wait**: We need to check if the **top-left corner** is curved or sharp.
    - Current path construction (per §4.3): `M 0,0` then `buildFaceSegment('left', ...)`, which goes from `(0,0)` to `(0,h)` via a curve.
    - The **corner at (0,0)** is a **sharp point** where the top face meets the left face.
    - So the outline **does pass through (0,0)** exactly; no bulge at the corner itself.
  - The start dot at nominal `(4, 4)` is **4px inside** the nominal boundary.
  - The outline at that location (near the corner) is **flat or slightly curved inward** (if both top and left faces are concave, the corner region is effectively concave).
  - **Conflict**: ⚠️ **Possible**. If the top face is **convex** and bulges upward to `y = -12`, the outline near the top-left corner could approach `(0, -12)` to `(0, 0)`. The start dot at `(4, 4)` is well inside this, but the **curved outline border stroke** (2–5px thick) could overlap the dot if the curvature is aggressive near the corner.
  - **Mitigation**: 
    - Either: Move the start dot further in (`top: 8px, left: 8px` instead of `4px, 4px`).
    - Or: Use sharp corners (not curved) so the outline is well-defined at `(0, 0)` and doesn't encroach inward.
  - **Recommendation**: For v1, **move start/terminal indicators inward** to `top/bottom: 8px, left/right: 8px` (or 10px) to ensure clearance.

#### 11.1.6 Terminal node indicator (colored dot, bottom-right)
- **Current**: `position: absolute, bottom: 4px, right: 4px`, `width: 12px, height: 12px`.
- **With padding**: `bottom: 4px, right: 4px` puts the dot at nominal `(w - 4, h - 4) = (96, 96)` in a 100×100 nominal area.
- **Conflict check**: Similar to start indicator; if the bottom-right corner is convex on both faces, the outline could bulge outward, but the corner itself is sharp at `(100, 100)`. The dot at `(96, 96)` is 4px inside; the outline stroke could graze it.
- **Recommendation**: **Move to `bottom: 8px, right: 8px`** (or 10px).

#### 11.1.7 Delete button (×, top-right)
- **Current**: `position: absolute, top: 0, right: 0`, `width: 20px, height: 20px`.
- **With padding**: `top: 0, right: 0` is relative to the padded div's content area.
  - Absolute in div: `(12 + contentWidth - 20, 12)` ≈ `(?, 12)`.
  - Actually, `right: 0` means it's flush with the **right edge of the content area**, so:
    - In a 124×124 div with 12px padding, the content area is 100×100.
    - `right: 0` puts the button's right edge at the content area's right edge, which is at `x = 112` in the div (12px padding + 100px content).
    - `top: 0` puts the top edge at `y = 12` in the div.
  - In nominal coords: `(100, 0)` (top-right corner of the nominal area).
- **Conflict check**: The delete button sits **exactly at the top-right corner** of the nominal area. If the right face is convex, the outline bulges to `x = 112` in div coords (or `x = 100 + 12 = 112` past the nominal boundary). The button is at the edge of the nominal area, so the outline **could overlap the button**.
- **Mitigation**: 
  - Either: Inset the button slightly (`top: 4px, right: 4px`).
  - Or: Render the button **inside the SVG** (on top of the outline) with `zIndex` above the border path.
  - Or: Accept that the outline might graze the button edge (probably fine visually since the button is small and has its own background).
- **Recommendation**: For v1, **inset the button** to `top: 4px, right: 4px` (or move it inside the SVG at a higher z-index).

### 11.2 Elements that apply at SVG path level

These are rendered using the `outlinePathD`:

#### 11.2.1 Halo (canvas-colored stroke)
- **Applied to**: `<path d={outlinePathD} stroke="#f8fafc" strokeWidth={12} />`.
- **Conflict check**: ✅ No conflict. The halo follows the outline by definition.

#### 11.2.2 Border (visible outline stroke)
- **Applied to**: `<path d={outlinePathD} stroke={borderColor} strokeWidth={borderWidth} />`.
- **Conflict check**: ✅ No conflict. The border follows the outline by definition.

#### 11.2.3 Fill (node body color)
- **Applied to**: `<path d={outlinePathD} fill={backgroundColor} />`.
- **Conflict check**: ✅ No conflict. The fill is the interior of the outline.

#### 11.2.4 Drop shadow
- **Applied to**: `<g filter="url(#node-shadow-{nodeId})">` wrapping halo/fill/border.
- **Conflict check**: ✅ No conflict. The shadow is cast from the outline shape.

### 11.3 Elements rendered via CSS box-shadow (inner glows)

If we **keep inner glows as CSS `box-shadow: inset`** (Option A from the plan):

#### 11.3.1 Start node inner glow (blue)
- **Current**: `boxShadow: 'inset 0 0 20px 0px rgba(191, 219, 254, 0.6)'`.
- **Applied to**: The rectangular `<div>`.
- **With curved outline**: The div is still rectangular (124×124 with padding), but the **visible boundary** is the curved SVG path, not the div edge.
- **Conflict check**: ⚠️ **Mismatch**. The inset glow will follow the **rectangular div boundary**, not the curved outline. This means:
  - At convex corners (where the outline bulges outward), the glow might not reach the outline edge.
  - At concave faces (where the outline is indented), the glow might extend slightly beyond the visible outline into the content area.
- **Visual impact**: Subtle. The glow is a soft 20px blur, so small shape mismatches are unlikely to be jarring.
- **Recommendation**: For v1, **accept the mismatch**. If it's visually problematic, migrate to SVG filters (Option B) in v2.

#### 11.3.2 Terminal node inner glow (green/red/gray)
- **Same analysis as start node glow**: Slight mismatch acceptable for v1.

### 11.4 ReactFlow handles

**Current behavior**: Handles use ReactFlow's default positioning with `Position` enum (`Left`, `Right`, `Top`, `Bottom`). ReactFlow places them at the **edges of the div**, centered on each face.

**Question**: Do handles need explicit repositioning when we add padding?

**Analysis**:

When we add padding to the div:
- Old div: `100×100`, no padding.
  - `Position.Left` → div `x = 0`, `y = 50` (center of left edge). ✅ Correct.
- New div: `124×124`, `padding: 12px`.
  - Content area: `100×100` starting at `(12, 12)`.
  - `Position.Left` → ReactFlow places at div `x = 0`, `y = 62` (center of div's left edge).
  - But we want the handle at **nominal `x = 0, y = 50`** (center of the nominal left face), which is **div `x = 12, y = 62`** (accounting for padding).
  - **Mismatch**: Handle is at div edge `(0, 62)`, not nominal edge `(12, 62)`.

**Impact**:
1. **Visual**: Handles appear **outside the curved outline** (12px to the left of where they should be for `Position.Left`).
2. **Functional**: Edges will connect to the handle position, which is now offset from the intended face location.
   - Edges will appear to connect **outside the node boundary** by 12px.
   - This breaks the visual connection between edges and nodes.

**Critical**: ❌ **Handles MUST be repositioned**.

**Solution**:

Override handle positions explicitly to account for padding:

```tsx
const CONVEX_DEPTH = 12; // Same constant used for padding

<Handle 
  type="target" 
  position={Position.Left} 
  id="left" 
  style={{ 
    left: `${CONVEX_DEPTH}px`,     // Offset from div edge to nominal edge
    top: '50%',
    transform: 'translateY(-50%)', // Center vertically
    background: '#555', 
    width: '8px', 
    height: '8px',
    opacity: showHandles ? 1 : 0,
    transition: 'opacity 0.2s ease'
  }} 
/>

<Handle 
  type="source" 
  position={Position.Right} 
  id="right-out" 
  style={{ 
    right: `${CONVEX_DEPTH}px`,    // Offset from div edge
    top: '50%',
    transform: 'translateY(-50%)',
    ...
  }} 
/>

<Handle 
  type="target" 
  position={Position.Top} 
  id="top" 
  style={{ 
    left: '50%',
    top: `${CONVEX_DEPTH}px`,      // Offset from div edge
    transform: 'translateX(-50%)', // Center horizontally
    ...
  }} 
/>

<Handle 
  type="source" 
  position={Position.Bottom} 
  id="bottom-out" 
  style={{ 
    left: '50%',
    bottom: `${CONVEX_DEPTH}px`,   // Offset from div edge
    transform: 'translateX(-50%)',
    ...
  }} 
/>
```

**Important**: The `left/right/top/bottom` style overrides **replace** ReactFlow's auto-positioning. We then use `transform: translate` to center the handle on the face.

**Verification**: After implementing, hover over a node; handles should appear **at the centers of the curved faces**, not offset to the div boundary.

### 11.5 Summary of required adjustments

| Element | Current position | Adjustment needed | Conflict risk | Fix |
|---------|-----------------|-------------------|---------------|-----|
| Label (center) | Flexbox center | None (padding handles it) | ✅ None | - |
| Badges (center) | Flexbox center | None | ✅ None | - |
| Start dot (top-left) | `top: 4px, left: 4px` | **Move inward** to avoid outline overlap | ⚠️ Possible | `top: 8-10px, left: 8-10px` |
| Terminal dot (bottom-right) | `bottom: 4px, right: 4px` | **Move inward** to avoid outline overlap | ⚠️ Possible | `bottom: 8-10px, right: 8-10px` |
| Delete button (top-right) | `top: 0, right: 0` | **Inset slightly** or increase z-index | ⚠️ Possible | `top: 4px, right: 4px` |
| Handles (all faces) | ReactFlow auto | **Explicit positioning** accounting for padding | ❌ Will break | `left/right/top/bottom: CONVEX_DEPTH` |
| Inner glows (CSS box-shadow) | Div rectangle | None (mismatch acceptable) | ⚠️ Subtle mismatch | Accept for v1, migrate to SVG filter in v2 |

### 11.6 Coordinate system cheat sheet

For a **100×100 nominal node** with **12px padding** (accommodating convex bulges):

- **Div dimensions**: `124×124`.
- **Content area** (after padding): `100×100`, starting at `(12, 12)` in div coords.
- **SVG viewBox**: `-12 -12 124 124` (extends to show convex bulges outside nominal area).
- **Nominal coordinates** (in viewBox): `(0, 0)` to `(100, 100)`.
  - Nominal `(0, 0)` = div `(12, 12)`.
  - Nominal `(100, 100)` = div `(112, 112)`.
- **Convex bulge coordinates** (in viewBox): Can extend to `(-12, y)` or `(x, -12)` or `(112, y)` or `(x, 112)`.
  - These are **outside** the nominal area but **inside** the extended viewBox.

**Content positioning rule**:
- Use **nominal coordinates** for all content positioning (relative to the padded content area).
- The padding automatically accounts for the difference between div coords and nominal coords.

**Exception: Absolute-positioned elements**:
- Elements with `position: absolute` are positioned relative to the **nearest positioned ancestor** (the padded div).
- Their `top/left/right/bottom` values are relative to the **content area edges** (after padding), not the div edges.
- So `top: 0, left: 0` = nominal `(0, 0)` = div `(12, 12)`. ✅ Correct.
- But elements at the **edge** of the nominal area (e.g. `top: 0, right: 0`) might overlap the curved outline if that face is convex.

**Fix for edge-positioned elements**:
- **Inset by 4-8px** from the nominal edge to ensure clearance:
  - Start dot: `top: 8px, left: 8px` (was `4px, 4px`).
  - Terminal dot: `bottom: 8px, right: 8px` (was `4px, 4px`).
  - Delete button: `top: 4px, right: 4px` (was `0, 0`).

---

## 12. Success Criteria

Implementation is **complete and correct** when:

1. **Visual fidelity**:
   - Nodes in non-Sankey view have curved outlines (convex/concave per face direction).
   - All other node visuals (fonts, badges, icons, start/terminal dots, delete button) are **pixel-identical** to pre-implementation.
   - Borders, shadows, and halos follow the curved outline smoothly.

2. **Functional correctness**:
   - Edges connect to curved faces without visible gaps.
   - Beads appear at consistent distances from node boundaries.
   - Node dragging, selection, handle interaction work identically.

3. **Performance**:
   - Pan/zoom is as smooth as the pre-chevron baseline (or better).
   - No frame drops during decoration restoration.
   - No GPU thrashing from excessive filters or clipPaths.

4. **Sankey mode**:
   - Sankey nodes remain rectangular, use CSS rendering, and look **exactly** as before.

5. **Code quality**:
   - No hacky workarounds; clean separation between geometry computation and rendering.
   - Single source of truth for `outlinePathD`; reused by halo/fill/border/shadow.
   - Diagnostic logging removed or gated by `?debug` flag.

---

## 13. What This Plan Fixes from the Failed Attempt

### 13.1 Structural mistakes in the failed attempt

1. **Wrong data source**: Computed `faceDirections` from `newEdges` (no faces yet) instead of `edges` (has faces after auto-route).
2. **Wrong effect placement**: Tried to compute during slow-path sync, before edges were ready.
3. **Wrong rendering strategy**: Replaced the entire node with SVG + `foreignObject`, breaking layout and breaking the visual language.
4. **Wrong geometry propagation**: Used separate paths for halo/border/shadow instead of a single `pathD`.
5. **Wrong z-order**: SVG elements interfered with content/handles instead of sitting purely as background decoration.

### 13.2 How this plan addresses each

1. **Data source**: Explicit `useEffect([edges, ...])` that runs **after auto-route**, using `edges.data.sourceFace`.
2. **Effect placement**: Separate effect, not inside the `toFlow()` sync block.
3. **Rendering strategy**: **SVG overlay inside div**, not SVG replacing div. Outer card is untouched.
4. **Geometry propagation**: **Single `outlinePathD`**, used by all layers (halo, fill, border). Shadow filter applied to the group.
5. **Z-order**: SVG at `zIndex: 0, pointerEvents: 'none'`; content at `zIndex: 1, pointerEvents: 'auto'`.

### 13.3 Lessons learned

- **Read the constraints first**: ReactFlow layout constraints, existing visual language, performance budget.
- **Separate data from presentation**: Compute `faceDirections` once, cleanly; use that data to drive a single geometry path; apply that path consistently.
- **Don't replace working systems wholesale**: Add an overlay, don't rip out the card.
- **Test incrementally**: Flat faces should look identical to the old rectangular nodes before introducing curvature.

---

## 14. Timeline and Checkpoints

### Checkpoint 1: Chevron removal (DONE)
- All chevron code commented out / removed.
- Edges render without clipPaths.
- App loads and displays correctly.

### Checkpoint 2: Face direction computation (IN PROGRESS)
- `useEffect` in `GraphCanvas` computes `faceDirections` from `edges`.
- Nodes receive `data.faceDirections`.
- **Test**: Log `faceDirections` per node; verify `'convex'`/`'concave'`/`'flat'` per face based on actual edge directions.

### Checkpoint 3: SVG overlay (NEXT)
- `ConversionNode` generates `outlinePathD` from `faceDirections`.
- SVG overlay renders halo + fill + border + shadow using `outlinePathD`.
- **Test**: With all faces `'flat'`, nodes should look **identical** to pre-implementation.

### Checkpoint 4: Curved faces (NEXT)
- Faces with edges go convex/concave per `faceDirections`.
- **Test**: Visually confirm outlines curve; all other visuals (fonts, badges, icons) unchanged.

### Checkpoint 5: Edge/bead integration (NEXT)
- Edges inset under nodes.
- Beads positioned correctly.
- **Test**: No gaps on concave faces, no overlap on convex faces.

### Checkpoint 6: Cleanup and polish (FINAL)
- Remove diagnostic logging.
- Tune curvature depth if needed.
- Performance profiling to confirm no regression.
- Document final state in `perf/`.

---

## 15. Open Design Questions

### 15.1 Inner glow migration

**Decision**: Keep as CSS `box-shadow: inset` (Option A) or migrate to SVG filter (Option B)?

- **Option A** (CSS, recommended for v1):
  - Simpler, no extra filters.
  - Glow won't perfectly follow curved outline (slight mismatch at concave/convex faces).
  - Likely acceptable since it's a subtle effect.

- **Option B** (SVG filter):
  - Glow follows outline exactly.
  - More filters to manage (4 additional: start, success, failure, other).
  - Slight perf cost, but probably negligible for 7–20 nodes.

**Recommendation**: Start with Option A; migrate to Option B only if visual mismatch is jarring.

### 15.2 Halo stroke width

**Decision**: What `strokeWidth` for the canvas-colored halo?

- Needs to be **larger than edge `INSET`** to fully mask inset segments.
- If `INSET = 10px`, halo should be ≥ `12px` (safe) or `16px` (conservative).
- Too large (> 20px) risks painting over adjacent nodes or edges.

**Recommendation**: Start with `strokeWidth={12}`, increase to `16` if gaps visible.

### 15.3 Corner rounding

**Decision**: Should corners between faces be **sharp** (straight line-to-line) or **rounded** (small arc)?

- Quadratic Beziers per face create sharp corners where two Beziers meet.
- For smoother look, add small `A` (arc) commands at corners.
- **Recommendation**: Start with sharp corners (simpler); add rounding in v2 if desired.

### 15.4 Curvature depth scaling

**Decision**: Fixed depth (12px) or scaled by edge count?

- Fixed depth: Simpler, consistent visual.
- Scaled depth: `depth = 12 + 2 * min(max(in, out), 5)` (clamped at 22px).
  - More edges → deeper curvature.
  - Risks wild shapes if one node has 10+ edges on one face.

**Recommendation**: Start with **fixed depth (12px)**; add scaling in v2 if needed for clarity.

---

## 16. Final Implementation Checklist

Before declaring this done, verify:

- [ ] Chevron system completely removed (no `ChevronClipPaths`, `groupEdgesIntoBundles`, clipPath IDs).
- [ ] `faceDirections` computed in a separate `useEffect` from `edges` (not `newEdges`).
- [ ] `faceDirections` attached to `node.data` correctly.
- [ ] `ConversionNode` generates `outlinePathD` from `faceDirections`.
- [ ] SVG overlay renders halo + fill + border + shadow using `outlinePathD`.
- [ ] SVG overlay has `pointerEvents: 'none'`, `zIndex: 0`.
- [ ] Content div has `zIndex: 1`, `pointerEvents: 'auto'`.
- [ ] Per-node filters use unique IDs (`node-shadow-${data.id}`).
- [ ] Outer card CSS has `border: 'none'`, `background: 'transparent'` (or compatible).
- [ ] All labels, badges, icons, start/terminal dots render correctly.
- [ ] Handles positioned and functional.
- [ ] Delete button positioned and functional.
- [ ] Edges inset by `10px` in non-Sankey view.
- [ ] Edges appear to connect cleanly to curved faces (no gaps).
- [ ] Beads positioned correctly.
- [ ] Sankey view uses original CSS rendering (no SVG overlay).
- [ ] Pan/zoom performance acceptable.
- [ ] No linter errors.
- [ ] Diagnostic logging removed or gated.

---

**Ready to implement**: Yes, following this plan step-by-step with each checkpoint verified before moving to the next.

