/**
 * analysisTypeResolutionService
 *
 * Single codepath for resolving which analysis type to use, given a graph,
 * analytics DSL, and scenario count. Wraps graphComputeClient.getAvailableAnalyses
 * + is_primary selection + ID normalisation.
 *
 * Consumers:
 *   - AnalyticsPanel (on DSL/selection change)
 *   - addCanvasAnalysisAtPosition (at creation time)
 *   - PropertiesPanel auto-update effect (when !analysis_type_overridden)
 */

import { graphComputeClient, type AvailableAnalysis } from '../lib/graphComputeClient';
import { parseDSL } from '../lib/queryDSL';

function normalizeAnalysisId(id: string): string {
  return id === 'graph_overview_empty' ? 'graph_overview' : id;
}

/**
 * Inject FE-computable analysis types (node_info, edge_info) into the
 * available list based on DSL pattern matching. These don't require
 * backend support — they're computed entirely from graph data.
 */
function injectLocalAnalysisTypes(
  analyses: AvailableAnalysis[],
  analyticsDsl: string | undefined,
  graph: any,
): void {
  if (!analyticsDsl) return;

  const parsed = parseDSL(analyticsDsl);

  // Collect all referenced node IDs from the DSL
  const allNodeRefs = [
    ...(parsed.from ? [parsed.from] : []),
    ...(parsed.to ? [parsed.to] : []),
    ...parsed.visited,
    ...parsed.visitedAny,
  ];

  // edge_info: exactly two nodes referenced, and a direct edge exists between them
  if (parsed.from && parsed.to && parsed.visited.length === 0 && parsed.visitedAny.length === 0) {
    if (!analyses.some(a => a.id === 'edge_info') && graph?.edges) {
      const fromRef = parsed.from;
      const toRef = parsed.to;
      const hasEdge = graph.edges.some((e: any) => {
        const fromNode = graph.nodes?.find((n: any) => n.uuid === e.from || n.id === e.from);
        const toNode = graph.nodes?.find((n: any) => n.uuid === e.to || n.id === e.to);
        return (fromNode && (fromNode.id === fromRef || fromNode.uuid === fromRef)) &&
               (toNode && (toNode.id === toRef || toNode.uuid === toRef));
      });
      if (hasEdge) {
        analyses.push({
          id: 'edge_info',
          name: 'Edge Info',
          description: 'Curated summary of a single edge',
          is_primary: false,
        });
      }
    }
  }

  // node_info: exactly one node referenced (via from, to, visited, or visitedAny)
  const uniqueRefs = new Set(allNodeRefs);
  if (uniqueRefs.size === 1 && !analyses.some(a => a.id === 'node_info')) {
    analyses.push({
      id: 'node_info',
      name: 'Node Info',
      description: 'Curated summary of a single node',
      is_primary: false,
    });
  }
}

export interface AnalysisTypeResolution {
  availableAnalyses: AvailableAnalysis[];
  primaryAnalysisType: string | null;
}

export async function resolveAnalysisType(
  graph: any,
  analyticsDsl?: string,
  scenarioCount: number = 1,
): Promise<AnalysisTypeResolution> {
  if (!graph) {
    return { availableAnalyses: [], primaryAnalysisType: null };
  }

  try {
    const response = await graphComputeClient.getAvailableAnalyses(
      graph,
      analyticsDsl || undefined,
      scenarioCount,
    );

    const dedupedById = new Map<string, AvailableAnalysis>();
    for (const analysis of (response.analyses || [])) {
      const normalisedId = normalizeAnalysisId(analysis.id);
      const existing = dedupedById.get(normalisedId);
      if (!existing || analysis.is_primary) {
        dedupedById.set(normalisedId, {
          ...analysis,
          id: normalisedId,
        });
      }
    }
    const normalised = Array.from(dedupedById.values());

    // Inject FE-computable analysis types based on DSL pattern
    injectLocalAnalysisTypes(normalised, analyticsDsl, graph);

    const primary = normalised.find(a => a.is_primary);

    return {
      availableAnalyses: normalised,
      primaryAnalysisType: primary?.id || null,
    };
  } catch (err) {
    console.error('[resolveAnalysisType] Failed:', err);
    return { availableAnalyses: [], primaryAnalysisType: null };
  }
}
