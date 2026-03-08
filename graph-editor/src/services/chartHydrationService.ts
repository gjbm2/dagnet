import type { Graph } from '../types';

/**
 * Runtime readiness checks for chart compute.
 *
 * This does NOT fetch or mutate anything. It simply answers whether the
 * local runtime has the pieces a chart needs before compute is attempted.
 *
 * Unlike liveShareHydrationService, this is surface-agnostic:
 * canvas charts, chart tabs, and future chart surfaces can all use it.
 */
export function isChartComputeReady(args: {
  graph: Graph | null | undefined;
  analysisType?: string | null;
  live: boolean;
  scenarioState?: any | null;
  scenariosReady?: boolean;
  customScenarios?: any[] | null;
}): boolean {
  const { graph, analysisType, live, scenarioState, scenariosReady, customScenarios } = args;
  const graphReady = !!(graph && Array.isArray((graph as any).nodes) && Array.isArray((graph as any).edges));
  const analysisReady = typeof analysisType === 'string' && analysisType.trim().length > 0;
  const scenariosCtxReady = scenariosReady === true;
  const liveReady = live ? !!scenarioState && scenariosCtxReady : true;
  const customReady = live ? true : Array.isArray(customScenarios) && scenariosCtxReady;
  return graphReady && analysisReady && liveReady && customReady;
}

