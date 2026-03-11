/**
 * Pure helper: classify each node face as flat / convex / concave
 * from edge face assignments.
 *
 * Accepts edges with either direct `.sourceFace` / `.targetFace` properties
 * (as returned by calculateEdgeOffsets) or nested `.data.sourceFace` /
 * `.data.targetFace` (as stored in ReactFlow edges state).
 * Direct properties take precedence when both are present.
 */

export type FaceDir = 'flat' | 'convex' | 'concave';

export interface FaceDirections {
  left: FaceDir;
  right: FaceDir;
  top: FaceDir;
  bottom: FaceDir;
}

export function computeFaceDirectionsFromEdges(
  edgeList: readonly {
    source: string;
    target: string;
    sourceFace?: string;
    targetFace?: string;
    data?: { sourceFace?: string; targetFace?: string };
  }[]
): Map<string, FaceDirections> {
  const stats = new Map<string, Record<string, { in: number; out: number }>>();

  const initNode = (id: string) => {
    if (!stats.has(id)) {
      stats.set(id, {
        left: { in: 0, out: 0 },
        right: { in: 0, out: 0 },
        top: { in: 0, out: 0 },
        bottom: { in: 0, out: 0 },
      });
    }
  };

  for (const edge of edgeList) {
    const srcFace = edge.sourceFace ?? edge.data?.sourceFace;
    const tgtFace = edge.targetFace ?? edge.data?.targetFace;

    if (edge.source && srcFace) {
      initNode(edge.source);
      stats.get(edge.source)![srcFace].out += 1;
    }
    if (edge.target && tgtFace) {
      initNode(edge.target);
      stats.get(edge.target)![tgtFace].in += 1;
    }
  }

  const classify = (s: { in: number; out: number }): FaceDir => {
    if (s.in === 0 && s.out === 0) return 'flat';
    if (s.in > 0 && s.out === 0) return 'concave';
    if (s.out > 0 && s.in === 0) return 'convex';
    if (s.out > s.in) return 'convex';
    if (s.in > s.out) return 'concave';
    return 'flat';
  };

  const result = new Map<string, FaceDirections>();
  for (const [nodeId, faces] of stats) {
    result.set(nodeId, {
      left: classify(faces.left),
      right: classify(faces.right),
      top: classify(faces.top),
      bottom: classify(faces.bottom),
    });
  }
  return result;
}
