/**
 * Face selection logic for auto-routing edges
 * Determines which face of a node to use for edge connections
 */

export interface EdgeInfo {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface NodePosition {
  id: string;
  x: number;
  y: number;
}

/**
 * Get optimal face for connecting an edge to a node
 * Uses simple geometric algorithm, then avoids mixed input/output faces
 * 
 * @param nodeId - ID of the node we're connecting to
 * @param isOutput - true if this is an output connection, false if input
 * @param dx - horizontal distance to other node (positive = other node is to the right)
 * @param dy - vertical distance to other node (positive = other node is below)
 * @param allEdges - all edges in the graph
 * @param onlyHorizontal - if true, only allow 'left' and 'right' faces (for Sankey view)
 * @returns face name ('left', 'right', 'top', 'bottom')
 */
export function getOptimalFace(
  nodeId: string,
  isOutput: boolean,
  dx: number,
  dy: number,
  allEdges: EdgeInfo[],
  onlyHorizontal?: boolean
): string {
  // Get all edges connected to this node
  const nodeEdges = allEdges.filter(e => e.source === nodeId || e.target === nodeId);
  
  // Simple geometric algorithm: pick face based on dominant direction
  let primaryFace: string;
  let secondaryFace: string;
  
  if (onlyHorizontal) {
    // Sankey mode: only allow left/right
    primaryFace = dx > 0 ? 'right' : 'left';
    secondaryFace = dx > 0 ? 'left' : 'right'; // fallback is opposite horizontal
  } else if (Math.abs(dx) > Math.abs(dy)) {
    // Horizontal movement dominates
    primaryFace = dx > 0 ? 'right' : 'left';
    secondaryFace = dy > 0 ? 'bottom' : 'top';
  } else {
    // Vertical movement dominates
    primaryFace = dy > 0 ? 'bottom' : 'top';
    secondaryFace = dx > 0 ? 'right' : 'left';
  }
  
  // Try primary face first
  const primaryFaceEdges = nodeEdges.filter(edge => {
    const sourceHandle = edge.sourceHandle || 'right-out';
    const targetHandle = edge.targetHandle || 'left';
    const sourceFace = sourceHandle.split('-')[0];
    const targetFace = targetHandle.split('-')[0];
    
    return (edge.source === nodeId && sourceFace === primaryFace) || 
           (edge.target === nodeId && targetFace === primaryFace);
  });
  
  if (primaryFaceEdges.length === 0) {
    // Empty face - use it
    return primaryFace;
  }
  
  // Check if primary face has opposite direction
  const primaryHasInputs = primaryFaceEdges.some(edge => edge.target === nodeId);
  const primaryHasOutputs = primaryFaceEdges.some(edge => edge.source === nodeId);
  
  // If primary face has same direction, use it
  if (isOutput && primaryHasOutputs && !primaryHasInputs) {
    return primaryFace;
  }
  if (!isOutput && primaryHasInputs && !primaryHasOutputs) {
    return primaryFace;
  }
  
  // Try secondary face
  const secondaryFaceEdges = nodeEdges.filter(edge => {
    const sourceHandle = edge.sourceHandle || 'right-out';
    const targetHandle = edge.targetHandle || 'left';
    const sourceFace = sourceHandle.split('-')[0];
    const targetFace = targetHandle.split('-')[0];
    
    return (edge.source === nodeId && sourceFace === secondaryFace) || 
           (edge.target === nodeId && targetFace === secondaryFace);
  });
  
  if (secondaryFaceEdges.length === 0) {
    // Empty face - use it
    return secondaryFace;
  }
  
  // Check if secondary face has opposite direction
  const secondaryHasInputs = secondaryFaceEdges.some(edge => edge.target === nodeId);
  const secondaryHasOutputs = secondaryFaceEdges.some(edge => edge.source === nodeId);
  
  // If secondary face has same direction, use it
  if (isOutput && secondaryHasOutputs && !secondaryHasInputs) {
    return secondaryFace;
  }
  if (!isOutput && secondaryHasInputs && !secondaryHasOutputs) {
    return secondaryFace;
  }
  
  // Try all remaining faces
  const allFaces = ['left', 'right', 'top', 'bottom'];
  const remainingFaces = allFaces.filter(f => f !== primaryFace && f !== secondaryFace);
  
  for (const face of remainingFaces) {
    const faceEdges = nodeEdges.filter(edge => {
      const sourceHandle = edge.sourceHandle || 'right-out';
      const targetHandle = edge.targetHandle || 'left';
      const sourceFace = sourceHandle.split('-')[0];
      const targetFace = targetHandle.split('-')[0];
      
      return (edge.source === nodeId && sourceFace === face) || 
             (edge.target === nodeId && targetFace === face);
    });
    
    if (faceEdges.length === 0) {
      return face;
    }
    
    const hasInputs = faceEdges.some(edge => edge.target === nodeId);
    const hasOutputs = faceEdges.some(edge => edge.source === nodeId);
    
    if (isOutput && hasOutputs && !hasInputs) {
      return face;
    }
    if (!isOutput && hasInputs && !hasOutputs) {
      return face;
    }
  }
  
  // Fallback: return primary face
  return primaryFace;
}

// Face outward-direction unit vectors
const FACE_DIR: Record<string, { x: number; y: number }> = {
  right: { x: 1, y: 0 },
  left:  { x: -1, y: 0 },
  bottom: { x: 0, y: 1 },
  top:    { x: 0, y: -1 },
};
const ALL_FACES = ['left', 'right', 'top', 'bottom'] as const;

// Direction-mixing penalty applied when a face already has edges in the
// opposite direction.  Large enough to outweigh geometry + stickiness in
// almost all cases, but not infinite so the algorithm can still fall back
// if every face is mixed.
const DIR_CONFLICT_PENALTY = 2.0;

export interface AssignFacesOptions {
  /** 0..1 — bonus for keeping an edge on its current face. Default 0.4. */
  stickyBias?: number;
}

/**
 * Assign faces for all incident edges at a node in one pass.
 *
 * Each candidate face is scored:
 *   geometric affinity (0..1)  — dot product of face direction with edge direction
 * + sticky bonus (0..stickyBias) — if this face is the edge's CURRENT face
 * − direction conflict penalty   — if the face already has opposite-direction edges
 *
 * Highest-scoring direction-compatible face wins; if all faces conflict,
 * the least-loaded face is chosen as fallback.
 *
 * Returns a map of edgeId → face for THIS node's side only.
 */
export function assignFacesForNode(
  nodeId: string,
  nodePositions: Record<string, { x: number; y: number }>,
  allEdges: EdgeInfo[],
  options?: AssignFacesOptions,
): Record<string, string> {
  const stickyBias = options?.stickyBias ?? 0.4;

  const incident = allEdges.filter(e => e.source === nodeId || e.target === nodeId);

  // Compute direction and priority (dominant axis magnitude) per edge
  const records = incident.map(e => {
    const otherId = e.source === nodeId ? e.target : e.source;
    const nodePos = nodePositions[nodeId];
    const otherPos = nodePositions[otherId];
    const dx = (otherPos?.x ?? 0) - (nodePos?.x ?? 0);
    const dy = (otherPos?.y ?? 0) - (nodePos?.y ?? 0);
    const dominant = Math.max(Math.abs(dx), Math.abs(dy));
    const isOutput = e.source === nodeId;

    // Current face for this edge at this node (derived from handles)
    let currentFace: string | undefined;
    if (isOutput) {
      const h = e.sourceHandle || 'right-out';
      currentFace = h.split('-')[0];
    } else {
      const h = e.targetHandle || 'left';
      currentFace = h.split('-')[0];
    }

    return { edge: e, dx, dy, dominant, isOutput, currentFace };
  });

  // Sort by dominant axis magnitude descending (straighter/closer first)
  records.sort((a, b) => b.dominant - a.dominant);

  // Track current face usage at this node (built up as edges are assigned)
  const faceToDir: Record<string, 'in' | 'out' | 'mixed' | undefined> = {};
  const faceLoad: Record<string, number> = { left: 0, right: 0, top: 0, bottom: 0 };

  const result: Record<string, string> = {};

  for (const r of records) {
    const desiredDir: 'in' | 'out' = r.isOutput ? 'out' : 'in';
    const mag = Math.sqrt(r.dx * r.dx + r.dy * r.dy) || 1;

    // Score each face
    let bestFace = 'right';
    let bestScore = -Infinity;
    let bestDirOk = false;

    for (const face of ALL_FACES) {
      const fd = FACE_DIR[face];

      // Geometric affinity: cosine similarity normalised to 0..1
      const dot = (fd.x * r.dx + fd.y * r.dy) / mag; // −1..1
      const geo = (dot + 1) / 2; // 0..1

      // Sticky bonus: reward keeping the current face
      const sticky = (r.currentFace === face) ? stickyBias : 0;

      // Direction compatibility
      const dir = faceToDir[face];
      const dirOk = !dir || dir === desiredDir;
      const penalty = dirOk ? 0 : DIR_CONFLICT_PENALTY;

      const score = geo + sticky - penalty;

      // Prefer direction-compatible faces; among those, highest score wins
      if (dirOk && !bestDirOk) {
        bestFace = face; bestScore = score; bestDirOk = true;
      } else if (dirOk === bestDirOk && score > bestScore) {
        bestFace = face; bestScore = score; bestDirOk = dirOk;
      }
    }

    result[r.edge.id] = bestFace;
    faceLoad[bestFace] = (faceLoad[bestFace] || 0) + 1;
    const existing = faceToDir[bestFace];
    if (!existing) faceToDir[bestFace] = desiredDir;
    else if (existing !== desiredDir) faceToDir[bestFace] = 'mixed';
  }

  return result;
}

