/**
 * conditionedForecastGraphSnapshot — build the engorged graph payload for
 * the conditioned forecast endpoint.
 *
 * Shared by the browser conditioned-forecast service and the Node CLI.
 * Keep this module free of React/TabContext imports; callers provide the
 * parameter-file lookup so runtime-specific state stays at the edge.
 */

import { buildEngorgedBayesGraphSnapshot } from './bayesEngorge';

export type ParameterFileResolver = (paramId: string) => unknown | null | undefined;

export function collectConditionedForecastParameterFiles(
  graph: any,
  resolveParameterFile: ParameterFileResolver,
): Record<string, unknown> {
  const parameterFiles: Record<string, unknown> = {};
  const referencedParamIds = new Set<string>();
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];

  for (const edge of edges) {
    const baseParamId = edge?.p?.id;
    if (baseParamId) referencedParamIds.add(String(baseParamId));

    const conditionals = Array.isArray(edge?.conditional_p) ? edge.conditional_p : [];
    for (const conditional of conditionals) {
      const conditionalParamId = conditional?.p?.id;
      if (conditionalParamId) referencedParamIds.add(String(conditionalParamId));
    }
  }

  for (const paramId of referencedParamIds) {
    const parameterFile = resolveParameterFile(paramId);
    if (parameterFile != null) {
      parameterFiles[`parameter-${paramId}`] = parameterFile;
    }
  }

  return parameterFiles;
}

export function buildConditionedForecastGraphSnapshot(
  graph: any,
  resolveParameterFile: ParameterFileResolver,
): any {
  return buildEngorgedBayesGraphSnapshot(
    graph,
    collectConditionedForecastParameterFiles(graph, resolveParameterFile),
  );
}
