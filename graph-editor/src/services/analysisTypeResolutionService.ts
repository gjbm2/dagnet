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
import { augmentChartKindOptionsForAnalysisType } from './chartDisplayPlanningService';

// -------------------------------------------------------------------
// Static chart-kind mapping — derived from runner output + FE augmentation
// -------------------------------------------------------------------

/** Known chart kinds per analysis type, based on backend runner semantics.chart
 *  and FE augmentation (augmentChartKindOptionsForAnalysisType). */
const CHART_KINDS_BY_ANALYSIS_TYPE: Record<string, string[]> = {
  graph_overview:           ['bar_grouped', 'pie', 'table'],
  from_node_outcomes:       ['bar_grouped', 'table'],
  to_node_reach:            ['bar', 'table'],
  bridge_view:              ['bridge', 'bridge_horizontal', 'table'],
  path_through:             ['bar', 'table'],
  branch_comparison:        ['bar_grouped', 'pie', 'table'],
  path_between:             ['funnel', 'bridge', 'bar_grouped', 'table'],
  outcome_comparison:       ['bar_grouped', 'pie', 'table'],
  conversion_funnel:        ['funnel', 'bridge', 'bar_grouped', 'table'],
  constrained_path:         ['funnel', 'bridge', 'bar_grouped', 'table'],
  branches_from_start:      ['bar_grouped', 'pie', 'table', 'time_series'],
  multi_outcome_comparison: ['bar_grouped', 'pie', 'table'],
  multi_branch_comparison:  ['bar_grouped', 'pie', 'table'],
  multi_waypoint:           ['bar_grouped', 'table'],
  general_selection:        ['bar_grouped', 'table'],
  node_info:                ['info'],
  edge_info:                ['info'],
  // Snapshot-based types have their own dedicated chart kinds + builders.
  // The chart kind matches the analysis type ID (or 'histogram' for lag_histogram).
  // The standard pipeline (useCanvasAnalysisCompute) resolves snapshot data
  // when needsSnapshots=true — no special-casing needed at the satellite level.
  cohort_maturity:          ['cohort_maturity', 'table'],
  cohort_maturity_v1:       ['cohort_maturity', 'table'],
  cohort_maturity_v2:       ['cohort_maturity', 'table'],
  daily_conversions:        ['daily_conversions', 'table'],
  conversion_rate:          ['conversion_rate', 'table'],
  lag_histogram:            ['histogram', 'table'],
  lag_fit:                  ['lag_fit', 'table'],
  surprise_gauge:           ['surprise_gauge', 'table'],
};

/** Get known chart kinds for an analysis type, including FE augmentation. */
export function getChartKindsForAnalysisType(analysisTypeId: string): string[] {
  const base = CHART_KINDS_BY_ANALYSIS_TYPE[analysisTypeId];
  if (!base) return [];
  return augmentChartKindOptionsForAnalysisType(analysisTypeId, base);
}

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
          chart_kinds: getChartKindsForAnalysisType('edge_info'),
        });
      }
    }
  }

  // surprise_gauge: from(a).to(b) edge with any model vars (probability mean + stdev)
  if (parsed.from && parsed.to && !analyses.some(a => a.id === 'surprise_gauge') && graph?.edges) {
    const fromRef = parsed.from;
    const toRef = parsed.to;
    const edge = graph.edges.find((e: any) => {
      const fromNode = graph.nodes?.find((n: any) => n.uuid === e.from || n.id === e.from);
      const toNode = graph.nodes?.find((n: any) => n.uuid === e.to || n.id === e.to);
      return (fromNode && (fromNode.id === fromRef || fromNode.uuid === fromRef)) &&
             (toNode && (toNode.id === toRef || toNode.uuid === toRef));
    });
    if (edge) {
      const modelVars = edge?.p?.model_vars || [];
      const hasAnyModelVars = modelVars.some((mv: any) =>
        mv?.probability?.mean != null && mv?.probability?.stdev != null && mv.probability.stdev > 0);
      if (hasAnyModelVars) {
        analyses.push({
          id: 'surprise_gauge',
          name: 'Expectation Gauge',
          description: 'How surprising is current evidence given model expectations',
          is_primary: false,
          chart_kinds: getChartKindsForAnalysisType('surprise_gauge'),
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
      chart_kinds: getChartKindsForAnalysisType('node_info'),
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

    // Populate chart_kinds from static FE mapping
    for (const a of normalised) {
      if (!a.chart_kinds) {
        a.chart_kinds = getChartKindsForAnalysisType(a.id);
      }
    }

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
