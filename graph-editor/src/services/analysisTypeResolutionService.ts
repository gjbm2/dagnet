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

    const normalised = (response.analyses || []).map(a => ({
      ...a,
      id: normalizeAnalysisId(a.id),
    }));

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
