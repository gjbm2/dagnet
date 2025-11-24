    # Node-Face Directionality Plan (Replace Chevrons with Node Geometry)

## 1. Scope and Objectives

We are **removing all chevron logic** from the app and replacing directional encoding with **node geometry** in non-Sankey view.

### Goals

1. **Remove chevrons completely**
   - Eliminate `ChevronClipPaths`, chevron bundles, and clipPath-based edge clipping.
   - Keep `?nochevrons` as a diagnostic if useful, but **chevron code paths should become no-ops** in steady state.

2. **Encode direction on node faces instead**
   - In **non-Sankey view only**.
   - Use **node shape** to indicate directionality for each face:
     - **Inbound edges on a face** → that face becomes **concave**.
     - **Outbound edges on a face** → that face becomes **convex**.
   - If both inbound and outbound edges exist on a given face, we need a clear rule (see §4.3). 

3. **Preserve bead semantics**
   - Beads remain the core representation of edge probabilities.
   - For outbound edges, bead starting points should be offset so they **appear to start at a roughly constant distance from the effective node face geometry** (curved).

4. **Preserve clipping semantics (without clipPath chevrons)**
   - Edges should still visually terminate at the node face.
   - Node renderers should clip edges using the new non-rectilinear geometry, as far as feasible without reintroducing performance problems.

5. **Ignore direction encoding in Sankey view**
   - In Sankey view, directionality is already implied by L→R flow.
   - Node shapes in Sankey can remain rectangular; no concave/convex faces needed there.

---

## 2. High-Level Design

### 2.1 Replace chevrons with node-face shaping

Current chevron system:

- Computes **edge bundles** for sources/targets.
- Renders `<clipPath>` chevron shapes per bundle and applies them to edges.
- Beads/edges are clipped by those chevrons.

New system:

- Node geometry itself will suggest the **direction of flow**:
  - Each face (top, bottom, left, right) becomes either:
    - Flat (no edges),
    - Convex (dominantly outbound),
    - Concave (dominantly inbound).
- Edges and beads will visually respect these face shapes but **we do not rely on clipPath-based per-bundle chevrons** anymore.

### 2.2 Where this lives in the architecture

- **Inputs**:
  - Graph `nodes` + `edges` from `GraphStore`.
  - Per-node adjacency: counts of inbound vs outbound edges per face.

- **Processing**:
  1. **Directional statistics per node face**:
     - For each node, compute (per face):
       - `nInbound(face)`, `nOutbound(face)`.
     - Decide face classification: concave / convex / flat.
  2. **Node geometry model**:
     - For each node face, define a parametric curve that represents the visual boundary.
     - Node renderer uses this geometry for:
       - Drawing the node shape.
       - Calculating edge intersection points / bead offsets.

- **Outputs**:
  - Node render props:
    - Per-face geometry data (control points, radii, etc.).
  - Edge render props:
    - Adjusted start/end positions so edges meet the curved face.
    - Bead offset distances that respect the curve.

---

## 3. Geometry Model

We treat each node as a rectangle **plus per-face deformation**.

### 3.1 Node and face coordinate system

- Each node has:
  - `width`, `height`.
  - Center at `(cx, cy)` in canvas coordinates.

- Faces:
  - **Left**: from `(cx - w/2, cy - h/2)` to `(cx - w/2, cy + h/2)`.
  - **Right**: from `(cx + w/2, cy - h/2)` to `(cx + w/2, cy + h/2)`.
  - **Top**: from `(cx - w/2, cy - h/2)` to `(cx + w/2, cy - h/2)`.
  - **Bottom**: from `(cx - w/2, cy + h/2)` to `(cx + w/2, cy + h/2)`.

We then distort these faces into **circular-arc approximations**.

### 3.2 Convex faces (outbound edges) – conceptual, not yet implemented

For a given face:

- We want the face to bulge **towards the direction of flow**.
- Simplest model: approximate a circular arc whose center is at the **center of the opposite face**.

Example (right face):

- Base segment: `P0 = (cx + w/2, cy - h/2)` to `P1 = (cx + w/2, cy + h/2)`.
- Opposite face center (left center): `C = (cx - w/2, cy)`.
- If we take a circle with center `C` and radius `R ≈ w` or `sqrt((w)^2 + (h/2)^2)`, then:
  - The right face is approximated by a vertical arc that bows outward (to the right) from the node interior.
  - For each param `t ∈ [0, 1]` along the face, we map:
    - `y(t) = cy - h/2 + t*h`.
    - Compute `x(t)` from circle equation `(x - Cx)^2 + (y(t) - Cy)^2 = R^2`, picking the solution with `x > cx`.

Similarly for other faces, we mirror the construction:

- Left face center at right face center, etc.
- Top face uses circle centered near bottom face.
- Bottom face uses circle centered near top face.

**Approximation**: we can precompute 3–5 sample points per face and render as a path or a rounded rectangle-ish polygon.

### 3.3 Concave faces (inbound edges) – conceptual, not yet implemented

For concave faces we do the **symmetric opposite displacement**:

- Treat outbound convex face as “bulging outwards”.
- For inbound concave face, we “indent” the face:
  - Use the same circle construction but take the intersection on the **inside** side of the node instead of outside.
  - Or equivalently, we offset the face inward by a curvature amount using the same radius logic but mirrored.

Example (right face concave):

- Same `C` and base segment as above.
- But we choose the intersection where `x < cx + w/2` (i.e. towards node interior).

### 3.4 Face curvature magnitude

Curvature depth should be:

- Proportional to **edge count** on that face, but:
  - Clamp to a max depth, say `maxDepth = min(w, h) * 0.25`.
  - Possibly have a base curvature if any edges exist.

Simplified model:

- `depth(face) = baseDepth + k * min(nOutbound, maxEdgesContribution)`, for convex.
- `depth(face) = baseDepth + k * min(nInbound, maxEdgesContribution)`, for concave.

We can encode `depth` directly and use it to:

- Adjust circle radius `R`.
- Or use a simpler quadratic curve approximation (Bezier control points) instead of a full circle.

---

## 4. Direction Classification and Conflicts

### 4.1 Inputs per node face

For each node:

- For each incident edge, we know:
  - Source node, target node.
  - Source handle (face + offset), target handle (face + offset).

We can therefore determine, per node and per face:

- `nInbound(face)` = edges where this node is target and the target handle is on `face`.
- `nOutbound(face)` = edges where this node is source and the source handle is on `face`.

### 4.2 Simple classification rules

First-cut rule:

- If `nInbound(face) > 0` and `nOutbound(face) == 0` → **concave**.
- If `nOutbound(face) > 0` and `nInbound(face) == 0` → **convex**.
- If both zero → **flat**.

### 4.3 Mixed-direction faces

Faces can have both inbound and outbound edges. Options:

1. **Dominant direction rule** (simple):
   - If `nOutbound(face) > nInbound(face)` → convex.
   - Else if `nInbound(face) > nOutbound(face)` → concave.
   - If equal → default to convex (or flat), but important we choose a deterministic rule.

2. **Split-face approach** (more complex, probably later):
   - Partition face into two subsegments, one concave, one convex.
   - Outbound edges anchor on convex portion; inbound on concave.
   - This requires more complex mapping logic and is likely v2.

For first implementation, we use **dominant direction** with curvature scaled by `max(nInbound, nOutbound)` and a clear tie-break (e.g. convex).

---

## 5. Bead Startpoint Offsets Along Edge

We need to adjust bead startpoints so that beads still appear to start at a roughly constant distance from the **effective node face** (curved).

### 5.1 Current bead start behavior (simplified)

Today:

- Beads start a fixed param along the spline or at a fixed distance from the node center.
- Chevrons handle clipping, so we don’t care exactly where they leave the node rectangle.

With curved faces:

- For outbound edges:
  - The point where the edge emerges from the node is slightly “farther out” or “angled”.
  - We want beads to appear a constant distance **from the node boundary** along the edge, not from the rectangular box.

### 5.2 Trig-based offset

Given:

- Edge path approximated as segment from `(x0, y0)` at node face to `(x1, y1)` further along the edge.
- Node boundary point on that face: `B`, where edge intersects the curved face.

We want bead origin `P` such that:

- Distance along edge from `B` to `P` is `dBead`, e.g. 12px.

If we treat the edge locally as straight:

- Direction vector `v = normalize((x1, y1) - (x0, y0))`.
- Then `P = B + dBead * v`.

The main geometric work is to find `B`:

- For convex faces, we know the arc param at which an edge attaches (based on handle offset/face).
- We can:
  - Parameterize face arc by `t ∈ [0, 1]`.
  - Map handle’s along-face coordinate to `t`.
  - Compute `B = faceCurve(t)` (either circle intersection or Bezier).

So:

1. Node face geometry provides:
   - `faceCurve(face, t)` → `(x, y)`.
2. Edge anchor uses:
   - `tEdge` from handle info (0..1).
3. Bead engine uses:
   - `P0 = faceCurve(face, tEdge)` (boundary),
   - Local direction vector along edge,
   - Constant `dBead` to offset.

Inbound edges can use similar logic but might not need special treatment beyond clipping.

---

## 6. Node Renderer and Edge Clipping

### 6.1 Node rendering

We will adjust `ConversionNode` rendering to:

- Draw a custom path instead of a vanilla rounded rectangle:
  - Left/right/top/bottom edges are polygons formed by:
    - Straight edges where flat.
    - Approximated circular/Bezier segments where concave/convex.

Implementation strategy:

- Precompute a small number of control points for each face:
  - `faceType`: flat/convex/concave.
  - `depth`: curvature depth.
  - `radius` or Bezier control points.
- Build a `d` string for `<path>` that traces the full node outline.

### 6.2 Edge clipping

We’d like edges to appear cut by the node’s new outline, but **without per-edge clipPaths**:

Options:

1. **Approximate clipping via edge endpoints** (first step):
   - For each edge, compute its intersection with the node geometry and **shorten the edge** so it stops at `B`.
   - This avoids actual SVG clipping; we just adjust the geometry.
   - This is likely enough visually if we don’t have large stroke widths.

2. **Node-level clipPath** (optional/advanced):
   - One clipPath per node (not per bundle).
   - Edges are drawn inside that clipPath.
   - Could still be expensive but far less than 100+ per frame.

For the first implementation we should aim for **endpoint adjustment only**, as it is easier to make performant and doesn’t re-introduce chevron-style clipping complexity.

---

## 7. Implementation Plan (Step-by-Step)

### 7.1 Remove chevron system

1. **Identify all chevron-related code paths**:
   - `ChevronClipPaths` component.
   - `groupEdgesIntoBundles` and bundle-related types.
   - edge `data` fields used purely for chevrons.
   - `?nochevrons` diagnostics and related flags.
2. Remove:
   - Imports and JSX for `ChevronClipPaths`.
   - Bundle generation and state where not used by anything else.
   - Any chevron-specific logging, perf instrumentation, and flags.

### 7.2 Add directional face stats

1. In `GraphCanvas` or a helper:
   - For each node:
     - Initialize per-face counts `nInbound`, `nOutbound`.
   - Iterate edges:
     - Use their source/target handles to determine faces.
     - Increment corresponding counts.
2. Produce a per-node `faceDirection` map:
   - For each face: `flat | convex | concave`, plus `depth`/curvature magnitude.
3. Pass this into the node renderer:
   - Either via `node.data.faceDirection` fields or a shared map keyed by node id.

### 7.3 Implement node face geometry

1. In `ConversionNode`:
   - Add a geometry helper that:
     - Takes node bounds + `faceDirection` + `depth`.
     - Returns:
       - `pathD` for full node outline.
       - `faceCurve(face, t)` for use by edge/bead logic.
2. Replace existing rectangle node outline with new path:
   - Keep corners and overall size stable.
   - Only faces warp according to direction classification.

### 7.4 Integrate edge endpoints with node geometry (later)

For now we **do not** snap edge endpoints exactly to the curved face. Instead:

1. In non-Sankey view we inset edge endpoints a small fixed distance (e.g. 10px) “under” the nominal rectangular node boundary, along the face normal.
2. Nodes are rendered on top of edges, so this hidden segment makes edges appear to emerge cleanly from the node body even as faces become concave/convex.
3. In a later iteration, if needed, we can compute precise `B = faceCurve(face, t)` intersections and move endpoints to the true curve.

### 7.5 Bead offset adjustments

1. In `EdgeBeads` logic:
   - Use the updated boundary point `B` at source (for outbound beads).
   - Compute local direction vector along the path.
   - Offset bead startpoint by `dBead` along the direction.
2. Confirm visually:
   - Beads sit just outside the node geometry at a near-constant spacing, regardless of curvature.

### 7.6 Sankey view handling

1. In all new logic:
   - If `useSankeyView` is `true`:
     - `faceDirection` should be treated as flat for all faces.
     - Use rectangular geometry for nodes.
   - Edges and beads behave as today (except chevrons are gone).

### 7.7 Performance considerations

- Avoid per-frame recomputation:
  - Face stats should be memoized per node based on `graph.edges` and `graph.nodes`.
  - Node geometry (`faceCurve`) can be cached per node until graph topology/handles change.
  - Edge endpoint adjustment is O(edges) but should only run when graph or layout changes, not every frame.
- No per-edge clipPaths:
  - We rely on geometric shortening of edges, not SVG clipping, for the first version.

---

## 8. Open Questions / Design Choices

1. **Mixed-direction faces**:
   - Is “dominant direction” good enough, or do we need to visually differentiate mixed faces?
2. **Curvature magnitude mapping**:
   - How aggressive should curvature be for nodes with many edges on one face?
3. **Accessibility / clarity**:
   - Do concave vs convex faces read clearly enough at a glance for directionality?
   - Do we need subtle line/gradient cues in addition to shape?

These can be iterated after an initial implementation once we see the visual result in a real graph.

---

## 9. Summary

This plan:

- Completely removes chevron/clipPath-based direction encoding.
- Encodes direction through **node face geometry** (concave vs convex) in non-Sankey mode.
- Preserves bead semantics by adjusting bead startpoints along the edge to respect new node shapes.
- Keeps Sankey view unchanged directionally (L→R implicit), with rectangular nodes.

Next step: implement this incrementally, starting with **chevron removal and face direction classification**, then node geometry, then edge/bead integration.***

