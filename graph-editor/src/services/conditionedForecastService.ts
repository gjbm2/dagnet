/**
 * Conditioned Forecast Service — doc 45
 *
 * Calls the BE /api/forecast/conditioned endpoint to get IS-conditioned
 * p.mean for each edge, using the full MC population model with snapshot
 * DB evidence. Same data pipeline as cohort maturity v3, same numbers.
 *
 * This is a graph enrichment service (like the topo pass), not an
 * analysis service. It writes per-edge scalars back to the graph.
 *
 * Trigger: fires after the topo pass results are applied, using the
 * same race/timeout pattern as the BE topo pass.
 */

import { PYTHON_API_BASE } from '../lib/pythonApiBase';

/** Per-edge result from the conditioned forecast endpoint. */
export interface ConditionedForecastEdgeResult {
  edge_uuid: string;
  from_node?: string;
  to_node?: string;
  p_mean: number | null;
  p_sd: number | null;
  tau_max?: number | null;
  n_rows?: number;
  n_cohorts?: number;
}

/** Per-scenario result. */
export interface ConditionedForecastScenarioResult {
  scenario_id: string;
  success: boolean;
  edges: ConditionedForecastEdgeResult[];
}

/**
 * Run the BE conditioned forecast for a graph.
 *
 * Builds the payload from the graph and query DSL, sends to the
 * BE endpoint, returns per-edge scalars per scenario.
 *
 * @param graph - Graph with promoted model vars (post topo pass)
 * @param queryDsl - The effective query DSL (temporal clause)
 * @param analyticsDsl - Optional subject DSL (from/to). If absent,
 *   forecasts all edges that have snapshot subjects.
 * @param workspace - Repository/branch for candidate regime computation
 * @param scenarioId - Scenario identifier (default: 'current')
 */
/**
 * Resolve workspace from IDB app state (same source as TabContext).
 * Returns undefined if not in browser or no workspace is set.
 */
async function resolveWorkspace(): Promise<{ repository: string; branch: string } | undefined> {
  try {
    const { db } = await import('../db/appDatabase');
    const appState = await db.appState.get('app-state');
    const repo = appState?.navigatorState?.selectedRepo;
    const branch = appState?.navigatorState?.selectedBranch || 'main';
    if (repo && branch) {
      return { repository: repo, branch };
    }
  } catch { /* not in browser or IDB unavailable */ }
  return undefined;
}

export async function runConditionedForecast(
  graph: any,
  queryDsl: string,
  analyticsDsl?: string,
  workspace?: { repository: string; branch: string },
  scenarioId: string = 'current',
): Promise<ConditionedForecastScenarioResult[]> {
  if (!queryDsl) return [];

  // Resolve workspace: explicit param → IDB state → undefined (no regimes)
  const ws = workspace || await resolveWorkspace();

  // Build candidate regimes for regime selection on the BE
  let candidateRegimesByEdge: Record<string, any[]> = {};
  if (ws) {
    try {
      const { buildCandidateRegimesByEdge, filterCandidatesByContext } = await import('./candidateRegimeService');
      const fullInventory = await buildCandidateRegimesByEdge(graph, ws);
      if (Object.keys(fullInventory).length > 0) {
        const filtered = await filterCandidatesByContext(fullInventory, queryDsl);
        candidateRegimesByEdge = Object.keys(filtered).length > 0 ? filtered : fullInventory;
      }
    } catch (err: any) {
      console.warn('[conditionedForecast] Failed to build candidate regimes:', err?.message);
    }
  }

  const payload = {
    analytics_dsl: analyticsDsl || '',
    scenarios: [{
      scenario_id: scenarioId,
      graph,
      effective_query_dsl: queryDsl,
      candidate_regimes_by_edge: candidateRegimesByEdge,
    }],
  };

  const url = `${PYTHON_API_BASE}/api/forecast/conditioned`;

  let response: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000); // 10s timeout
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(payload),
    });
    clearTimeout(timeout);
  } catch (e) {
    console.warn('[conditionedForecast] Network error or timeout:', e);
    return [];
  }

  if (!response.ok) {
    console.warn('[conditionedForecast] HTTP error:', response.status);
    return [];
  }

  let body: { success: boolean; scenarios: ConditionedForecastScenarioResult[] };
  try {
    body = await response.json();
  } catch (e) {
    console.warn('[conditionedForecast] JSON parse error:', e);
    return [];
  }

  if (!body.success || !body.scenarios) return [];

  return body.scenarios;
}

/**
 * Apply conditioned forecast results to graph edges.
 *
 * Overwrites p.mean and p.stdev on edges where the forecast produced
 * a valid result. Also updates the 'analytic_be' model_vars entry's
 * probability.mean if present.
 */
export function applyConditionedForecastToGraph(
  graph: any,
  results: ConditionedForecastScenarioResult[],
): void {
  for (const scenario of results) {
    for (const edge of scenario.edges) {
      if (edge.p_mean == null) continue;

      const graphEdge = (graph.edges ?? []).find(
        (e: any) => (e.uuid || e.id) === edge.edge_uuid
      );
      if (!graphEdge?.p) continue;

      // Write conditioned p.mean
      graphEdge.p.mean = edge.p_mean;
      if (edge.p_sd != null) {
        graphEdge.p.stdev = edge.p_sd;
      }

      // Also update the forecast.mean (p∞ from the conditioned engine)
      if (graphEdge.p.forecast) {
        graphEdge.p.forecast.mean = edge.p_mean;
      }

      console.log(`[conditionedForecast] ${edge.edge_uuid.slice(0, 12)}: p.mean=${edge.p_mean.toFixed(4)}`);
    }
  }
}
