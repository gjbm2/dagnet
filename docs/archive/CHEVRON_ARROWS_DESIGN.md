# Chevron Arrow Effects for Sankey Edge Bundles - Design Document

## Overview

Replace running arrows along edge splines with chevron-shaped arrow effects at bundle boundaries. Chevrons are formed by applying SVG clipping masks to edge bundles, creating visual indicators of flow direction at node interfaces.

## Visual Goal

For each edge bundle at a node interface, create a chevron (>) shape pointing in the flow direction. The chevron surface abuts the node face.

### Example: Edges Flowing LEFT → RIGHT

**At SOURCE (outbound from node):**
```
NodeA
  |\====   (top edge: chevron "bite" clips corner)
  | >===   (center edge: at chevron tip)
  |/====   (bottom edge: chevron "bite" clips corner)
```

**At TARGET (inbound to node):**
```
  ====\  |
  =====> |  NodeB (center edge: at chevron tip)
  ====/  |
```

**Result:** Both chevrons form **>** shapes pointing RIGHT (in flow direction).

## Geometry Definition

### Terminology

- **CHEVRON_HEIGHT**: Total bundle width (perpendicular to flow direction)
- **CHEVRON_WIDTH**: Depth of chevron projection along flow axis
  - Formula: `CHEVRON_WIDTH = CHEVRON_HEIGHT / 5` (tunable constant)
- **Bounding Box**: CHEVRON_WIDTH × CHEVRON_HEIGHT rectangle

### Chevron Triangle Shape

The chevron is an **equilateral triangle** positioned at each bundle boundary.

**Coordinate Reference:**
- **(nodeX, nodeY)** throughout this document refers to the **center point of the edge bundle at the node face**
- This is NOT the node's center, but rather where the bundle's centerline intersects the node face
- For a bundle with edges stacked vertically, this is the midpoint of the vertical span at the node edge
- For a bundle with edges stacked horizontally, this is the midpoint of the horizontal span at the node edge

#### SOURCE Chevron (Outbound)

**Triangle Geometry:**
- **Base**: Perpendicular to flow, AT node face, spans CHEVRON_HEIGHT
- **Tip**: CHEVRON_WIDTH distance from node (away from node, in flow direction)

**Vertex Coordinates** (for right-facing edges, flow →):
```
Where (nodeX, nodeY) = center point of the bundle AT the node face

Top:    (nodeX, nodeY - CHEVRON_HEIGHT/2)
Bottom: (nodeX, nodeY + CHEVRON_HEIGHT/2)  
Tip:    (nodeX + CHEVRON_WIDTH, nodeY)
```

**Clipping Application:**
- **SUBTRACT** this triangle from the visible region
- Creates "bite" shape (negative space chevron)

#### TARGET Chevron (Inbound)

**Triangle Geometry:**
- **Base**: Perpendicular to flow, CHEVRON_WIDTH distance from node
- **Tip**: AT node face

**Vertex Coordinates** (for left-facing target, flow →):
```
Where (nodeX, nodeY) = center point of the bundle AT the node face

Top:    (nodeX - CHEVRON_WIDTH, nodeY - CHEVRON_HEIGHT/2)
Bottom: (nodeX - CHEVRON_WIDTH, nodeY + CHEVRON_HEIGHT/2)
Tip:    (nodeX, nodeY)
```

**Clipping Application:**
- **INVERT** triangle within bounding box
- **THEN SUBTRACT** the inverted shape
- Creates pointed arrowhead (positive space chevron)

### Face Orientation Mapping

| Face   | Flow Direction | Bundle Stacks | SOURCE Triangle Base | TARGET Triangle Base |
|--------|---------------|---------------|---------------------|---------------------|
| right  | +X (right)    | Vertically (Y)| At node X, spans Y  | CHEVRON_WIDTH left  |
| left   | -X (left)     | Vertically (Y)| At node X, spans Y  | CHEVRON_WIDTH right |
| bottom | +Y (down)     | Horizontally (X)| At node Y, spans X | CHEVRON_WIDTH up    |
| top    | -Y (up)       | Horizontally (X)| At node Y, spans X | CHEVRON_WIDTH down  |

## Why Clipping Is Required

**Critical Insight:** Edges have WIDTH, not just centerline position.

### Example Bundle
- Edge 1 (top): 60% of bundle width
- Edge 2 (bottom): 40% of bundle width

When chevron clips this bundle:
- Edge 1: Triangular sector removed (chevron cuts through thick edge)
- Edge 2: Parallelogram removed (angled straight cut)

**Coordinate offset alone won't work** because it only moves the edge centerline, not the rendered stroke shape.

## Implementation Approach

### Architecture: SVG clipPath with Edge Bundles

**Strategy:**
1. Group edges by bundle (node + face + direction)
2. Create one `<clipPath>` per bundle with chevron mask
3. Render edges in `<g>` groups with `clip-path` attribute
4. Edges render at normal positions, clipping masks handle chevron effect

### SVG Structure

```svg
<svg>
  <defs>
    <!-- Source bundle clipPath: direct triangle subtraction -->
    <clipPath id="chevron-source-nodeA-right">
      <rect x="0" y="0" width="9999" height="9999" />  <!-- Full canvas -->
      <polygon 
        points="nodeX,topY nodeX,bottomY tipX,centerY"
        clip-rule="evenodd"  <!-- Subtract this triangle -->
      />
    </clipPath>
    
    <!-- Target bundle clipPath: inverted triangle subtraction -->
    <clipPath id="chevron-target-nodeB-left">
      <!-- Inverted: keep triangle, clip everything else in bounding box -->
      <polygon 
        points="baseX,topY baseX,bottomY tipX,centerY"
        <!-- This defines what to KEEP (the arrowhead shape) -->
      />
    </clipPath>
  </defs>
  
  <!-- Source bundle edges (clipped with bite) -->
  <g clip-path="url(#chevron-source-nodeA-right)">
    <path d="M..." stroke-width="60" />  <!-- Edge 1 -->
    <path d="M..." stroke-width="40" />  <!-- Edge 2 -->
  </g>
  
  <!-- Target bundle edges (clipped to point) -->
  <g clip-path="url(#chevron-target-nodeB-left)">
    <path d="M..." stroke-width="60" />  <!-- Edge 1 -->
    <path d="M..." stroke-width="40" />  <!-- Edge 2 -->
  </g>
</svg>
```

## Implementation Steps

### Step 1: Identify Edge Bundles

In `GraphCanvas.tsx`, after edge offset calculation:

```typescript
// Group edges by bundle
const bundles = new Map<string, EdgeBundle>();

edgesWithOffsets.forEach(edge => {
  // Source bundle
  const sourceBundleId = `${edge.source}-${edge.sourceFace}-source`;
  if (!bundles.has(sourceBundleId)) {
    bundles.set(sourceBundleId, {
      id: sourceBundleId,
      nodeId: edge.source,
      face: edge.sourceFace,
      type: 'source',
      edges: [],
      bundleWidth: edge.sourceBundleWidth,
      centerX: calculateCenterX(edge.source, edge.sourceFace),
      centerY: calculateCenterY(edge.source, edge.sourceFace),
    });
  }
  bundles.get(sourceBundleId).edges.push(edge);
  
  // Target bundle (similar)
  // ...
});
```

### Step 2: Generate Chevron ClipPath Definitions

```typescript
function generateChevronClipPath(bundle: EdgeBundle): string {
  const { face, centerX, centerY, bundleWidth, type } = bundle;
  
  const height = bundleWidth;
  const width = height / 5; // CHEVRON_WIDTH
  
  if (type === 'source') {
    // Direct triangle subtraction
    if (face === 'right') {
      const top = `${centerX},${centerY - height/2}`;
      const bottom = `${centerX},${centerY + height/2}`;
      const tip = `${centerX + width},${centerY}`;
      
      return `
        <clipPath id="chevron-${bundle.id}">
          <rect x="-9999" y="-9999" width="19999" height="19999" />
          <polygon points="${top} ${bottom} ${tip}" clip-rule="evenodd" />
        </clipPath>
      `;
    }
    // Handle other faces...
  } else {
    // Target: inverted triangle (keep the point)
    if (face === 'left') {
      const top = `${centerX - width},${centerY - height/2}`;
      const bottom = `${centerX - width},${centerY + height/2}`;
      const tip = `${centerX},${centerY}`;
      
      return `
        <clipPath id="chevron-${bundle.id}">
          <polygon points="${tip} ${top} ${bottom}" />
        </clipPath>
      `;
    }
    // Handle other faces...
  }
}
```

### Step 3: Render Edges in Bundled Groups

Modify ReactFlow rendering to group edges:

```jsx
// In GraphCanvas or custom edge layer
<svg>
  <defs>
    {Array.from(bundles.values()).map(bundle => (
      <React.Fragment key={bundle.id}>
        {generateChevronClipPathJSX(bundle)}
      </React.Fragment>
    ))}
  </defs>
  
  {Array.from(bundles.values()).map(bundle => (
    <g key={bundle.id} clipPath={`url(#chevron-${bundle.id})`}>
      {bundle.edges.map(edge => (
        <ConversionEdge key={edge.id} {...edge} />
      ))}
    </g>
  ))}
</svg>
```

### Step 4: Remove Old Arrow Code

Delete from `ConversionEdge.tsx`:
- Running arrows logic (`arrowPositions` calculation)
- Arrow rendering in JSX
- Any chevron coordinate offset code (revert to pre-chevron state)

### Step 5: Threshold Behavior & Fallback Arrowheads

**Problem:** Chevrons on thin bundles (< ~8px) are visually unclear.

**Solution:** Use traditional small arrowhead instead.

```typescript
const MIN_CHEVRON_THRESHOLD = 8; // pixels

if (bundle.bundleWidth < MIN_CHEVRON_THRESHOLD) {
  // Skip chevron clipPath generation
  // Render traditional arrowhead on TARGET bundle only
  return generateFallbackArrowhead(bundle);
}

function generateFallbackArrowhead(bundle: EdgeBundle) {
  // Only render arrowhead at TARGET (inbound), not SOURCE
  if (bundle.type !== 'target') return null;
  
  // Calculate position at 75% along center edge of bundle
  const centerEdge = bundle.edges.find(e => 
    Math.abs(e.offsetFromBundleCenter) < 0.01
  ) || bundle.edges[0];
  
  const arrowPosition = calculatePositionAlongPath(centerEdge, 0.75);
  const arrowAngle = calculateTangentAngle(centerEdge, 0.75);
  
  return (
    <polygon
      key={`arrow-${bundle.id}`}
      points="-4,-3 -4,3 4,0"  // Small triangle
      fill={getEdgeColour(centerEdge)}
      transform={`translate(${arrowPosition.x},${arrowPosition.y}) rotate(${arrowAngle})`}
    />
  );
}
```

**Rationale:**
- Chevrons are only visually meaningful when bundle is thick enough to see the shape
- Traditional arrowhead at TARGET only (SOURCE "bite" not needed for thin bundles)
- Positioned at 75% along center edge (standard position)
- Uses same colour as edge for consistency

## Integration with ReactFlow

### Challenge: ReactFlow renders edges in flat list

**Current**: ReactFlow manages edge components individually

**Needed**: Group edges by bundle for clipping

### Solution Options

**Option A: Custom SVG Layer (Recommended)**
- Render edges in custom SVG structure outside ReactFlow's control
- More control over grouping and clipping
- Requires replicating some ReactFlow edge features

**Option B: Post-Process ReactFlow SVG**
- Let ReactFlow render edges normally
- Wrap rendered SVG with clip groups via DOM manipulation
- More fragile, depends on ReactFlow internals

**Option C: ReactFlow Custom Edge Wrapper**
- Create wrapper edge type that handles grouping
- Use React context to coordinate bundles
- Complex state management

## Testing Checklist

- [ ] Right-facing bundles (edges flowing right)
- [ ] Left-facing bundles (edges flowing left)  
- [ ] Top-facing bundles (edges flowing up)
- [ ] Bottom-facing bundles (edges flowing down)
- [ ] Single-edge bundles (chevron still appears if width > threshold)
- [ ] Thin bundles < MIN_CHEVRON_THRESHOLD (8px)
  - [ ] No chevron clipPath applied
  - [ ] Traditional arrowhead appears at target (75% along center edge)
  - [ ] No arrowhead at source
  - [ ] Arrowhead colour matches edge colour
- [ ] Wide bundles > node height (scaled appropriately)
- [ ] Different bundle widths at source vs target
- [ ] Edge selection still works with chevron clipping
- [ ] Edge labels don't interfere with chevrons
- [ ] Reconnecting edges updates chevron bundles correctly
- [ ] Deleting edges updates chevron bundles correctly

## Open Questions

1. **Bundle grouping performance**: Will re-grouping on every render be expensive?
   - Consider memoization/caching of bundle structure
   
2. **ReactFlow compatibility**: Which option for edge grouping is most maintainable?
   - Prototype needed to evaluate approaches

3. **Visual tuning**: Is CHEVRON_WIDTH = HEIGHT/5 the right ratio?
   - Make configurable for iteration

4. **Edge case handling**: What if bundles overlap or nodes are very close?
   - May need minimum spacing or chevron suppression

## Summary

- ✅ Geometry: Equilateral triangles, CHEVRON_WIDTH = HEIGHT/5
- ✅ Source: Direct triangle subtraction (creates bite)
- ✅ Target: Inverted triangle subtraction (creates point)  
- ✅ Implementation: SVG clipPath on edge bundle groups
- ⚠️ Integration: Requires grouping edges outside ReactFlow's default rendering
- 🔨 Next: Prototype bundle grouping and clipPath generation
