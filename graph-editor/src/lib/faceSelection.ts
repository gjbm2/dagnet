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
 * @returns face name ('left', 'right', 'top', 'bottom')
 */
export function getOptimalFace(
  nodeId: string,
  isOutput: boolean,
  dx: number,
  dy: number,
  allEdges: EdgeInfo[]
): string {
  // Get all edges connected to this node
  const nodeEdges = allEdges.filter(e => e.source === nodeId || e.target === nodeId);
  
  // Simple geometric algorithm: pick face based on dominant direction
  let primaryFace: string;
  let secondaryFace: string;
  
  if (Math.abs(dx) > Math.abs(dy)) {
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

/**
 * Assign faces for all incident edges at a node in one pass.
 * Ensures faces avoid mixing inputs/outputs where possible and prefers straighter (dominant axis) directions.
 * Returns a map of edgeId -> face for THIS node's side only.
 */
export function assignFacesForNode(
  nodeId: string,
  nodePositions: Record<string, { x: number; y: number }>,
  allEdges: EdgeInfo[]
): Record<string, string> {
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
    return { edge: e, dx, dy, dominant, isOutput };
  });

  // Sort by dominant axis magnitude descending (straighter/closer first)
  records.sort((a, b) => b.dominant - a.dominant);

  // Track current face usage at this node
  const faceToDir: Record<string, 'in' | 'out' | 'mixed' | undefined> = {};
  const faceLoad: Record<string, number> = { left: 0, right: 0, top: 0, bottom: 0 };

  const result: Record<string, string> = {};

  for (const r of records) {
    // Candidate faces: primary then secondary then others (geometric simple algorithm)
    const candidates: string[] = [];
    if (Math.abs(r.dx) > Math.abs(r.dy)) {
      candidates.push(r.dx > 0 ? 'right' : 'left');
      candidates.push(r.dy > 0 ? 'bottom' : 'top');
    } else {
      candidates.push(r.dy > 0 ? 'bottom' : 'top');
      candidates.push(r.dx > 0 ? 'right' : 'left');
    }
    for (const f of ['left', 'right', 'top', 'bottom']) {
      if (!candidates.includes(f)) candidates.push(f);
    }

    const desiredDir: 'in' | 'out' = r.isOutput ? 'out' : 'in';

    // Pick first face that doesn't mix opposite direction; else choose least-loaded
    let pick: string | null = null;
    for (const face of candidates) {
      const dir = faceToDir[face];
      if (!dir) { pick = face; break; }
      if (dir === desiredDir) { pick = face; break; }
    }
    if (!pick) {
      // All faces have opposite/mixed; pick least loaded among candidates
      pick = candidates.reduce((best, face) => (faceLoad[face] < faceLoad[best] ? face : best), candidates[0]);
    }

    result[r.edge.id] = pick;
    faceLoad[pick] = (faceLoad[pick] || 0) + 1;
    const existing = faceToDir[pick];
    if (!existing) faceToDir[pick] = desiredDir;
    else if (existing !== desiredDir) faceToDir[pick] = 'mixed';
  }

  return result;
}

