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

import { fileRegistry } from '../contexts/TabContext';
import { buildConditionedForecastGraphSnapshot } from '../lib/conditionedForecastGraphSnapshot';
import { PYTHON_API_BASE } from '../lib/pythonApiBase';
import { UpdateManager } from './UpdateManager';
import { resolveConditionedForecastScenarioId } from './conditionedForecastSupersessionState';

/** Per-edge result from the conditioned forecast endpoint.
 *  Doc 45 §Endpoint contract (lines 181-190):
 *    { edge_uuid, p_mean, p_sd, completeness, completeness_sd }
 *  CF owns completeness + completeness_sd — they replace FE topo's
 *  CDF-derived values on the edge when CF lands. */
export interface ConditionedForecastEdgeResult {
  edge_uuid: string;
  from_node?: string;
  to_node?: string;
  p_mean: number | null;
  p_sd: number | null;
  p_sd_epistemic?: number | null;
  completeness?: number | null;
  completeness_sd?: number | null;
  // CF returns observed counts at the conditioned horizon. The FE graph
  // projection persists n/k onto edge.p.evidence.{n,k}; evidence.mean
  // remains on the FE quick pass authority path.
  evidence_k?: number | null;
  evidence_n?: number | null;
  conditioning?: {
    r: number | null;
    m_S: number | null;
    m_G: number | null;
    applied: boolean;
    skip_reason?: string | null;
  };
  cf_mode?: 'sweep' | 'analytic_degraded';
  cf_reason?: 'query_scoped_posterior' | null;
  tau_max?: number | null;
  n_rows?: number;
  n_cohorts?: number;
  /** BE-supplied flag: true if observed evidence was applied to this edge's
   *  result; false if the result is the untouched prior (Class C / prior
   *  fallback per doc 50). Set by api_handlers.py:handle_conditioned_forecast
   *  from `_conditioned` on the first maturity row. */
  conditioned?: boolean;
}

/** Per-scenario result. */
export interface ConditionedForecastScenarioResult {
  scenario_id: string;
  success: boolean;
  edges: ConditionedForecastEdgeResult[];
  skipped_edges?: Array<{ edge_uuid: string; reason: string }>;
}

/**
 * Run the BE conditioned forecast for a graph.
 *
 * Builds the payload from the graph and query DSL, sends to the
 * BE endpoint, returns per-edge scalars per scenario.
 *
 * @param graph - Graph with promoted model vars (post FE quick pass)
 * @param queryDsl - The effective query DSL (temporal clause)
 * @param analyticsDsl - Optional subject DSL (from/to). If absent,
 *   forecasts all edges that have snapshot subjects.
 * @param workspace - Repository/branch for candidate regime computation
 * @param scenarioId - Scenario identifier (defaults to "current" when empty)
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
  scenarioId?: string,
): Promise<ConditionedForecastScenarioResult[]> {
  if (!queryDsl) return [];
  const resolvedScenarioId = resolveConditionedForecastScenarioId(scenarioId);

  const graphSnapshot = buildConditionedForecastGraphSnapshot(
    graph,
    (paramId) => {
      if (typeof fileRegistry.getFile !== 'function') return undefined;
      return fileRegistry.getFile(`parameter-${paramId}`)?.data;
    },
  );

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
      scenario_id: resolvedScenarioId,
      graph: graphSnapshot,
      effective_query_dsl: queryDsl,
      candidate_regimes_by_edge: candidateRegimesByEdge,
    }],
  };

  const url = `${PYTHON_API_BASE}/api/forecast/conditioned`;

  let response: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000); // 20s timeout (doc 47)
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
 * Routes through UpdateManager.applyBatchLAGValues so probability
 * writes trigger sibling rebalancing and the graph is cloned
 * atomically (doc 47 §Phase 5).
 *
 * Returns the new (cloned) graph. The input graph is NOT mutated.
 */
export function applyConditionedForecastToGraph(
  graph: any,
  results: ConditionedForecastScenarioResult[],
): any {
  const updateManager = new UpdateManager();

  const edgeUpdates: Array<{
    edgeId: string;
    latency: {
      t95: number;
      completeness: number;
      completeness_stdev?: number;
      path_t95: number;
    };
    stdev?: number;
    blendedMean?: number;
    forecast?: { mean?: number };
    evidence?: {
      n?: number;
      k?: number;
    };
  }> = [];

  for (const scenario of results) {
    for (const edge of scenario.edges) {
      if (edge.p_mean == null) continue;

      // Find existing edge to preserve its non-CF-owned latency values
      const graphEdge = (graph.edges ?? []).find(
        (e: any) => (e.uuid || e.id) === edge.edge_uuid
      );
      if (!graphEdge?.p) continue;

      const lat = graphEdge.p.latency ?? {};
      // Doc 45: CF owns completeness + completeness_sd. They are the
      // authoritative values — overwrite the existing (FE-topo-derived)
      // scalars. Fall back to existing only when CF did not return a
      // value (e.g. sweep could not populate completeness_mean).
      const completenessFromCf =
        edge.completeness != null && Number.isFinite(edge.completeness)
          ? edge.completeness as number
          : (lat.completeness ?? 0);
      const completenessSdFromCf =
        edge.completeness_sd != null && Number.isFinite(edge.completeness_sd)
          ? edge.completeness_sd as number
          : lat.completeness_stdev;
      const stdevFromCf =
        edge.p_sd != null && Number.isFinite(edge.p_sd) && edge.p_sd >= 0
          ? edge.p_sd as number
          : undefined;
      // In analytic_degraded/query_scoped fallback mode, p_mean is sourced from
      // query-scoped posterior state on the graph. Projecting horizon-row
      // evidence_n/k here makes the graph non-idempotent across passes:
      // subsequent CF calls would read different query-scoped counts and drift.
      // Keep n/k on the existing query-scoped authority path for this mode.
      const isQueryScopedPosteriorFallback =
        edge.cf_mode === 'analytic_degraded'
        && (
          edge.cf_reason === 'query_scoped_posterior'
          || edge.conditioning?.skip_reason === 'source_query_scoped'
        );
      const evidenceNFromCf =
        !isQueryScopedPosteriorFallback
        && edge.evidence_n != null
        && Number.isFinite(edge.evidence_n)
        && edge.evidence_n >= 0
          ? edge.evidence_n as number
          : undefined;
      const evidenceKFromCf =
        !isQueryScopedPosteriorFallback
        && edge.evidence_k != null
        && Number.isFinite(edge.evidence_k)
        && edge.evidence_k >= 0
          ? edge.evidence_k as number
          : undefined;
      edgeUpdates.push({
        edgeId: edge.edge_uuid,
        latency: {
          // t95 + path_t95 remain FE-topo's (latency fit, not CF output)
          t95: lat.t95 ?? 0,
          path_t95: lat.path_t95 ?? 0,
          // completeness is CF-authored
          completeness: completenessFromCf,
          ...(completenessSdFromCf != null ? { completeness_stdev: completenessSdFromCf } : {}),
        },
        ...(stdevFromCf != null ? { stdev: stdevFromCf } : {}),
        blendedMean: edge.p_mean,
        forecast: { mean: edge.p_mean },
        ...((evidenceNFromCf != null || evidenceKFromCf != null)
          ? {
              evidence: {
                ...(evidenceNFromCf != null ? { n: evidenceNFromCf } : {}),
                ...(evidenceKFromCf != null ? { k: evidenceKFromCf } : {}),
              },
            }
          : {}),
      });

      console.log(
        `[conditionedForecast] ${edge.edge_uuid.slice(0, 12)}: `
        + `p.mean=${edge.p_mean.toFixed(4)} `
        + `completeness=${completenessFromCf != null ? completenessFromCf.toFixed(4) : '—'} `
        + `response_evidence=${edge.evidence_k ?? '—'}/${edge.evidence_n ?? '—'}`
      );
    }
  }

  if (edgeUpdates.length === 0) return graph;

  return updateManager.applyBatchLAGValues(graph, edgeUpdates);
}
