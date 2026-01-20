import { graphComputeClient } from '../lib/graphComputeClient';
import { queryRegenerationService } from './queryRegenerationService';
import type { Graph } from '../types';

/**
 * Anchor Regeneration Service
 *
 * Mirrors the existing "regenerate query" pattern, but for cohort anchor node IDs.
 *
 * - Uses MSMDC's `anchors` output (edge UUID → anchor node id).
 * - Does NOT apply any graph mutations by itself; it only computes the desired anchor value.
 * - Callers are responsible for writing the field + clearing the override flag as appropriate.
 */
class AnchorRegenerationService {
  async computeAnchorNodeIdForEdge(graph: Graph, edgeId: string): Promise<string | null | undefined> {
    // Transform graph to backend schema before sending (same as query regeneration)
    const transformedGraph = queryRegenerationService.transformGraphForBackend(graph);

    // Use edge filter for efficiency; anchors are still computed for all edges by the backend,
    // but this keeps parameter generation scoped.
    const response = await graphComputeClient.generateAllParameters(
      transformedGraph,
      undefined, // downstreamOf
      undefined, // literalWeights
      undefined, // preserveCondition
      edgeId // edgeId filter
    );

    return response.anchors?.[edgeId];
  }
}

export const anchorRegenerationService = new AnchorRegenerationService();







