/**
 * Edge geometry & bundling — pure computation functions extracted from GraphCanvas.
 *
 * getEdgeSortKey:        angle-based sort key for curved edge stacking within a face bundle.
 * calculateEdgeOffsets:  Sankey-style offset and scale computation for bundled edges.
 */

/**
 * Calculate edge sort keys for curved edge stacking.
 * For Bézier curves, sort by the angle/direction at which edges leave/enter the face.
 */
export function getEdgeSortKey(
  sourceNode: any,
  targetNode: any,
  face: string,
  isSourceFace: boolean = true,
  edgeId?: string,
): [number, number, number] {
  if (!sourceNode || !targetNode) return [0, 0, 0];

  const sourceX = sourceNode.position?.x || 0;
  const sourceY = sourceNode.position?.y || 0;
  const targetX = targetNode.position?.x || 0;
  const targetY = targetNode.position?.y || 0;

  // Calculate vector from source to target
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;

  // Angle-based sorting (preferred). Use abs(dy) to mirror top/bottom behavior
  // so tiny vertical shifts don't flip ordering on left/right faces.
  let directionAngle: number;
  if (isSourceFace) {
    // Edge leaves the source
    if (face === 'right') {
      directionAngle = Math.atan2(Math.abs(dx), -dy); // rotate top/bottom by 90°: swap x↔y
    } else if (face === 'left') {
      directionAngle = -Math.atan2(Math.abs(dx), dy); // rotate top/bottom by 90°: swap x↔y
    } else if (face === 'bottom') {
      directionAngle = Math.atan2(Math.abs(dy), -dx);
    } else { // top
      directionAngle = -Math.atan2(Math.abs(dy), dx);
    }
  } else {
    // Edge enters the target
    if (face === 'left') {
      directionAngle = Math.atan2(-Math.abs(dx), -dy); // rotate top/bottom by 90°: swap x↔y
    } else if (face === 'right') {
      directionAngle = -Math.atan2(Math.abs(dx), -dy); // rotate top/bottom by 90°: swap x↔y
    } else if (face === 'top') {
      directionAngle = Math.atan2(-Math.abs(dy), -dx);
    } else { // bottom
      directionAngle = -Math.atan2(Math.abs(dy), -dx);
    }
  }

  // Secondary sort by span for stability when angles are very close
  const span = Math.sqrt(dx * dx + dy * dy);

  // Final tie-breaker to keep order stable under tiny movements
  const edgeIdHash = edgeId ? edgeId.split('').reduce((a, b) => a + b.charCodeAt(0), 0) : 0;

  return [directionAngle, -span, edgeIdHash];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getEdgeWidth(edge: any): number {
  return edge.data?.calculateWidth ? edge.data.calculateWidth() : 2;
}

function extractFace(handle: string, defaultHandle: string): string {
  return (handle || defaultHandle).split('-')[0];
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

/**
 * Calculate cumulative scaled width for a sorted bundle of edges, up to (but not including) the edge at `upToIndex`.
 */
function cumulativeScaledWidth(
  sortedEdges: any[],
  upToIndex: number,
  faceScaleFactors: Record<string, number>,
  useUniformScaling: boolean,
): number {
  return sortedEdges.slice(0, upToIndex).reduce((sum, e) => {
    const width = getEdgeWidth(e);
    const eSourceFace = extractFace(e.sourceHandle, 'right-out');
    const eTargetFace = extractFace(e.targetHandle, 'left');
    const eSourceKey = `source-${e.source}-${eSourceFace}`;
    const eIncidentKey = `incident-${e.target}-${eTargetFace}`;
    const eSourceScale = faceScaleFactors[eSourceKey] || 1.0;
    const eIncidentScale = faceScaleFactors[eIncidentKey] || 1.0;
    const eScale = !useUniformScaling ? Math.min(eSourceScale, eIncidentScale) : 1.0;
    return sum + (width * eScale);
  }, 0);
}

/**
 * Total scaled width of a bundle.
 */
function totalScaledBundleWidth(
  sortedEdges: any[],
  faceScaleFactors: Record<string, number>,
  useUniformScaling: boolean,
): number {
  return cumulativeScaledWidth(sortedEdges, sortedEdges.length, faceScaleFactors, useUniformScaling);
}

// ---------------------------------------------------------------------------
// Main calculation
// ---------------------------------------------------------------------------

/**
 * Calculate edge offsets for Sankey-style visualisation.
 *
 * This is a pure function — it does not depend on React state. GraphCanvas wraps it
 * in a useCallback that closes over `useUniformScaling`.
 */
export function calculateEdgeOffsets(
  edgesWithWidth: any[],
  allNodes: any[],
  maxWidth: number,
  useUniformScaling: boolean,
  sortKeyFn: typeof getEdgeSortKey = getEdgeSortKey,
): any[] {

  // Group edges by source node (for source offsets)
  const edgesBySource = groupBy(edgesWithWidth, e => e.source);

  // Group edges by target node (for target offsets)
  const edgesByTarget = groupBy(edgesWithWidth, e => e.target);

  // Pre-calculate scale factors per face to ensure consistency
  // Scale factors always apply to keep bundles within MAX_WIDTH, regardless of scaling mode
  const faceScaleFactors: Record<string, number> = {};

  // Calculate scale factors for each source face
  for (const sourceId of Object.keys(edgesBySource)) {
    const sourceEdges = edgesBySource[sourceId];
    const sourceNode = allNodes.find(n => n.id === sourceId || n.data?.id === sourceId);
    if (!sourceNode) continue;

    const edgesByFace = groupBy(sourceEdges, e => extractFace(e.sourceHandle, 'right-out'));

    for (const face of Object.keys(edgesByFace)) {
      const totalWidth = edgesByFace[face].reduce((sum, e) => sum + getEdgeWidth(e), 0);
      faceScaleFactors[`source-${sourceId}-${face}`] = totalWidth > maxWidth ? maxWidth / totalWidth : 1.0;
    }
  }

  // Calculate scale factors for each target face
  for (const targetId of Object.keys(edgesByTarget)) {
    const targetEdges = edgesByTarget[targetId];
    const targetNode = allNodes.find(n => n.id === targetId || n.data?.id === targetId);
    if (!targetNode) continue;

    const edgesByFace = groupBy(targetEdges, e => extractFace(e.targetHandle, 'left'));

    for (const face of Object.keys(edgesByFace)) {
      const totalWidth = edgesByFace[face].reduce((sum, e) => sum + getEdgeWidth(e), 0);
      faceScaleFactors[`target-${targetId}-${face}`] = totalWidth > maxWidth ? maxWidth / totalWidth : 1.0;
    }
  }

  // Calculate scale factors for incident faces (faces with edges from multiple sources)
  const incidentFaces = groupBy(edgesWithWidth, e => {
    const targetFace = extractFace(e.targetHandle, 'left');
    return `incident-${e.target}-${targetFace}`;
  });

  for (const [faceKey, faceEdges] of Object.entries(incidentFaces)) {
    const totalWidth = faceEdges.reduce((sum, e) => sum + getEdgeWidth(e), 0);
    faceScaleFactors[faceKey] = totalWidth > maxWidth ? maxWidth / totalWidth : 1.0;
  }

  // Calculate offsets for each edge (both source and target)
  const edgesWithOffsets = edgesWithWidth.map(edge => {
    const sourceEdges = edgesBySource[edge.source] || [];
    const targetEdges = edgesByTarget[edge.target] || [];

    const sourceNode = allNodes.find(n => n.id === edge.source || n.data?.id === edge.source);
    const targetNode = allNodes.find(n => n.id === edge.target || n.data?.id === edge.target);

    if (!sourceNode || !targetNode) {
      return {
        ...edge,
        sourceOffsetX: 0,
        sourceOffsetY: 0,
        targetOffsetX: 0,
        targetOffsetY: 0,
      };
    }

    const sourceFace = extractFace(edge.sourceHandle, 'right-out');
    const targetFace = extractFace(edge.targetHandle, 'left');

    // ===== Calculate SOURCE offsets =====
    const sameFaceSourceEdges = sourceEdges.filter(e => extractFace(e.sourceHandle, 'right-out') === sourceFace);

    const sortedSourceEdges = [...sameFaceSourceEdges].sort((a, b) => {
      const aTarget = allNodes.find(n => n.id === a.target || n.data?.id === a.target);
      const bTarget = allNodes.find(n => n.id === b.target || n.data?.id === b.target);
      if (!aTarget || !bTarget) return 0;

      const aKey = sortKeyFn(sourceNode, aTarget, sourceFace, true, a.id);
      const bKey = sortKeyFn(sourceNode, bTarget, sourceFace, true, b.id);

      if (aKey[0] !== bKey[0]) return aKey[0] - bKey[0];
      if (aKey[1] !== bKey[1]) return aKey[1] - bKey[1];
      return aKey[2] - bKey[2];
    });

    const sourceFaceKey = `source-${edge.source}-${sourceFace}`;
    const sourceScaleFactor = faceScaleFactors[sourceFaceKey] || 1.0;

    let sourceOffsetX = 0;
    let sourceOffsetY = 0;

    if (sortedSourceEdges.length > 0) {
      const sourceEdgeIndex = sortedSourceEdges.findIndex(e => e.id === edge.id);
      if (sourceEdgeIndex !== -1) {
        // Calculate cumulative width using per-edge scale = min(source-face, incident target-face)
        const sourceCumulativeWidth = sortedSourceEdges.slice(0, sourceEdgeIndex).reduce((sum, e) => {
          const width = getEdgeWidth(e);
          const eSourceFace = extractFace(e.sourceHandle, 'right-out');
          const eTargetFace = extractFace(e.targetHandle, 'left');
          const eSourceKey = `source-${e.source}-${eSourceFace}`;
          const eIncidentKey = `incident-${e.target}-${eTargetFace}`;
          const eSourceScale = faceScaleFactors[eSourceKey] || 1.0;
          const eIncidentScale = faceScaleFactors[eIncidentKey] || 1.0;
          // Always apply scale factors to enforce MAX_WIDTH constraint
          const eScale = Math.min(eSourceScale, eIncidentScale);
          return sum + (width * eScale);
        }, 0);

        const edgeWidth = getEdgeWidth(edge);
        const incidentFaceKeyForThis = `incident-${edge.target}-${targetFace}`;
        const incidentScaleForThis = faceScaleFactors[incidentFaceKeyForThis] || 1.0;
        // Always apply scale factors to enforce MAX_WIDTH constraint
        const thisEdgeScale = Math.min(sourceScaleFactor, incidentScaleForThis);
        const scaledEdgeWidth = edgeWidth * thisEdgeScale;

        const sourceCenterInStack = sourceCumulativeWidth + (scaledEdgeWidth / 2);

        // Calculate total scaled width for centering using per-edge scales
        const totalScaledWidth = sortedSourceEdges.reduce((sum, e) => {
          const width = getEdgeWidth(e);
          const eSourceFace = extractFace(e.sourceHandle, 'right-out');
          const eTargetFace = extractFace(e.targetHandle, 'left');
          const eSourceKey = `source-${e.source}-${eSourceFace}`;
          const eIncidentKey = `incident-${e.target}-${eTargetFace}`;
          const eSourceScale = faceScaleFactors[eSourceKey] || 1.0;
          const eIncidentScale = faceScaleFactors[eIncidentKey] || 1.0;
          // Always apply scale factors to enforce MAX_WIDTH constraint
          const eScale = Math.min(eSourceScale, eIncidentScale);
          return sum + (width * eScale);
        }, 0);

        const sourceStackCenter = totalScaledWidth / 2;
        const sourceOffsetFromCenter = sourceCenterInStack - sourceStackCenter;

        if (sourceFace === 'left' || sourceFace === 'right') {
          sourceOffsetY = sourceOffsetFromCenter;
        } else {
          sourceOffsetX = sourceOffsetFromCenter;
        }
      }
    }

    // ===== Calculate TARGET offsets =====
    const sameFaceTargetEdges = targetEdges.filter(e => extractFace(e.targetHandle, 'left') === targetFace);

    const sortedTargetEdges = [...sameFaceTargetEdges].sort((a, b) => {
      const aSource = allNodes.find(n => n.id === a.source || n.data?.id === a.source);
      const bSource = allNodes.find(n => n.id === b.source || n.data?.id === b.source);
      if (!aSource || !bSource) return 0;

      const aKey = sortKeyFn(aSource, targetNode, targetFace, false, a.id);
      const bKey = sortKeyFn(bSource, targetNode, targetFace, false, b.id);

      if (aKey[0] !== bKey[0]) return aKey[0] - bKey[0];
      if (aKey[1] !== bKey[1]) return aKey[1] - bKey[1];
      return aKey[2] - bKey[2];
    });

    const incidentFaceKey = `incident-${edge.target}-${targetFace}`;
    const targetScaleFactor = faceScaleFactors[incidentFaceKey] || 1.0;

    let targetOffsetX = 0;
    let targetOffsetY = 0;

    if (sortedTargetEdges.length > 0) {
      const targetEdgeIndex = sortedTargetEdges.findIndex(e => e.id === edge.id);
      if (targetEdgeIndex !== -1) {
        // Calculate cumulative width using per-edge scale = min(source-face, incident target-face)
        const targetCumulativeWidth = sortedTargetEdges.slice(0, targetEdgeIndex).reduce((sum, e) => {
          const width = getEdgeWidth(e);
          const eSourceFace = extractFace(e.sourceHandle, 'right-out');
          const eTargetFace = extractFace(e.targetHandle, 'left');
          const eSourceKey = `source-${e.source}-${eSourceFace}`;
          const eIncidentKey = `incident-${e.target}-${eTargetFace}`;
          const eSourceScale = faceScaleFactors[eSourceKey] || 1.0;
          const eIncidentScale = faceScaleFactors[eIncidentKey] || 1.0;
          // Always apply scale factors to enforce MAX_WIDTH constraint
          const eScale = Math.min(eSourceScale, eIncidentScale);
          return sum + (width * eScale);
        }, 0);

        const edgeWidth = getEdgeWidth(edge);
        const thisEdgeScaleAtTarget = !useUniformScaling ? Math.min(sourceScaleFactor, targetScaleFactor) : 1.0;
        const scaledEdgeWidth = edgeWidth * thisEdgeScaleAtTarget;

        const targetCenterInStack = targetCumulativeWidth + (scaledEdgeWidth / 2);

        // Calculate total scaled width for centering using per-edge scales
        const totalScaledWidth = sortedTargetEdges.reduce((sum, e) => {
          const width = getEdgeWidth(e);
          const eSourceFace = extractFace(e.sourceHandle, 'right-out');
          const eTargetFace = extractFace(e.targetHandle, 'left');
          const eSourceKey = `source-${e.source}-${eSourceFace}`;
          const eIncidentKey = `incident-${e.target}-${eTargetFace}`;
          const eSourceScale = faceScaleFactors[eSourceKey] || 1.0;
          const eIncidentScale = faceScaleFactors[eIncidentKey] || 1.0;
          // Always apply scale factors to enforce MAX_WIDTH constraint
          const eScale = Math.min(eSourceScale, eIncidentScale);
          return sum + (width * eScale);
        }, 0);

        const targetStackCenter = totalScaledWidth / 2;
        const targetOffsetFromCenter = targetCenterInStack - targetStackCenter;

        if (targetFace === 'left' || targetFace === 'right') {
          targetOffsetY = targetOffsetFromCenter;
        } else {
          targetOffsetX = targetOffsetFromCenter;
        }
      }
    }

    // Get the final edge width using the per-edge scale factor = min(source-face, incident target-face)
    // Always apply scale factors to enforce MAX_WIDTH constraint
    let scaledWidth = getEdgeWidth(edge);
    const thisIncidentScale = faceScaleFactors[`incident-${edge.target}-${targetFace}`] || 1.0;
    const thisEdgeScale = Math.min(sourceScaleFactor, thisIncidentScale);
    scaledWidth = scaledWidth * thisEdgeScale;

    // Calculate bundle metadata
    const sourceEdgeIndex = sortedSourceEdges.findIndex(e => e.id === edge.id);
    const targetEdgeIndex = sortedTargetEdges.findIndex(e => e.id === edge.id);

    const sourceBundleWidth = totalScaledBundleWidth(sortedSourceEdges, faceScaleFactors, useUniformScaling);
    const targetBundleWidth = totalScaledBundleWidth(sortedTargetEdges, faceScaleFactors, useUniformScaling);

    return {
      ...edge,
      sourceOffsetX,
      sourceOffsetY,
      targetOffsetX,
      targetOffsetY,
      scaledWidth,
      // Bundle metadata
      sourceBundleWidth,
      targetBundleWidth,
      sourceBundleSize: sortedSourceEdges.length,
      targetBundleSize: sortedTargetEdges.length,
      isFirstInSourceBundle: sourceEdgeIndex === 0,
      isLastInSourceBundle: sourceEdgeIndex === sortedSourceEdges.length - 1,
      isFirstInTargetBundle: targetEdgeIndex === 0,
      isLastInTargetBundle: targetEdgeIndex === sortedTargetEdges.length - 1,
      sourceFace,
      targetFace,
    };
  });

  return edgesWithOffsets;
}
