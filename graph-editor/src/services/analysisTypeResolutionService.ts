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

function normalizeAnalysisId(id: string): string {
  return id === 'graph_overview_empty' ? 'graph_overview' : id;
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
