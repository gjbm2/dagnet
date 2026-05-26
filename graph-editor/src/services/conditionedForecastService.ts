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

/**
 * Canonical CF write specification per edge — what CF authoritatively writes.
 *
 * Doc 73l Fix 2 (30-Apr-26): both the fetch-pipeline race fast path
 * (`mergeCfIntoFe` in fetchDataService.ts) and the direct-apply slow path
 * (`applyConditionedForecastToGraph` below) consume this single shape, so
 * they cannot drift on field selection or validity gates. The output shapes
 * differ — the race path merges into pre-existing FE `EdgeLAGValues`, the
 * direct path constructs a fresh edge update — but both decide *what* CF
 * writes via this helper.
 *
 * Layer contract (doc 73b §6.2 / §12.2 row S9, doc 73g invariant 7):
 *   - CF owns L5 current-answer fields: `p.mean` (via `blendedMean` field on
 *     the update record), `p.stdev` (epistemic, from `p_sd_epistemic`),
 *     `p.stdev_pred` (predictive, from `p_sd`), `latency.completeness`,
 *     `latency.completeness_stdev`, `evidence.{n, k}`.
 *   - CF MUST NOT write L2 promoted-baseline `p.forecast.*` or L1 source-
 *     ledger `model_vars[*]`. Those are populated by `applyPromotion` from
 *     the active model_vars source.
 */
export interface CfEdgeWriteSpec {
  edge_uuid: string;
  /** CF p_mean, lands on `p.mean` via `blendedMean` apply field. */
  blendedMean: number;
  /** CF p_sd (predictive), lands on `p.stdev_pred`. */
  stdev_pred?: number;
  /** CF p_sd_epistemic, lands on `p.stdev`. */
  stdev?: number;
  /** CF completeness, lands on `p.latency.completeness`. */
  completeness?: number;
  /** CF completeness_sd, lands on `p.latency.completeness_stdev`. */
  completeness_stdev?: number;
  /** CF evidence_n, lands on `p.evidence.n`. */
  evidence_n?: number;
  /** CF evidence_k, lands on `p.evidence.k`. */
  evidence_k?: number;
}

/**
 * Validate and project a CF response edge into the canonical write spec.
 * Returns null if the edge has no usable `p_mean` (CF cannot write).
 *
 * Field-level validity gates (single source of truth):
 *   - p_mean: required, finite. If absent, the whole spec is null.
 *   - p_sd, p_sd_epistemic: finite and non-negative.
 *   - completeness, completeness_sd: finite.
 *   - evidence_n, evidence_k: finite and non-negative.
 */
export function extractCfEdgeWriteSpec(
  edge: ConditionedForecastEdgeResult,
): CfEdgeWriteSpec | null {
  if (edge.p_mean == null || !Number.isFinite(edge.p_mean)) return null;
  const finiteNonNeg = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const finite = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v);
  return {
    edge_uuid: edge.edge_uuid,
    blendedMean: edge.p_mean,
    ...(finiteNonNeg(edge.p_sd) ? { stdev_pred: edge.p_sd } : {}),
    ...(finiteNonNeg(edge.p_sd_epistemic) ? { stdev: edge.p_sd_epistemic } : {}),
    ...(finite(edge.completeness) ? { completeness: edge.completeness } : {}),
    ...(finite(edge.completeness_sd) ? { completeness_stdev: edge.completeness_sd } : {}),
    ...(finiteNonNeg(edge.evidence_n) ? { evidence_n: edge.evidence_n } : {}),
    ...(finiteNonNeg(edge.evidence_k) ? { evidence_k: edge.evidence_k } : {}),
  };
}

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
  cf_mode?: 'sweep';
  cf_reason?: null;
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

/**
 * Split a combined DSL (e.g. "from(x).to(y).window(-90d:)") into the
 * subject (`from(...).to(...).visited(...).visitedAny(...).exclude(...)`)
 * part and the temporal (`window(...).cohort(...).asat(...)` plus everything
 * else) part.
 *
 * Mirrors the splitter in [`analyse.ts`](../cli/commands/analyse.ts) so the
 * BE always sees `analytics_dsl` (subject) and `effective_query_dsl`
 * (temporal) separately, regardless of which CLI / FE entry point invoked
 * CF. Doc 73l: the analyse CLI splits before dispatch; runConditionedForecast
 * must do the same so the pack-side and analyse-side payloads agree.
 */
function splitDslSubjectTemporal(dsl: string): { subject: string; temporal: string } {
  if (!dsl) return { subject: '', temporal: '' };
  const subjectRe = /\b(from|to|visited|visitedAny|exclude)\([^)]*\)/g;
  const subjectParts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = subjectRe.exec(dsl)) !== null) {
    subjectParts.push(match[0]);
  }
  const temporal = dsl.replace(subjectRe, '').replace(/^\.+|\.+$/g, '').replace(/\.{2,}/g, '.');
  return { subject: subjectParts.join('.'), temporal };
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

  // Doc 73l Fix 2 (30-Apr-26): the BE handler at api_handlers.py expects
  // `analytics_dsl` to carry the subject (from/to/visited/...) and
  // `effective_query_dsl` to carry the temporal clause only. The analyse
  // CLI splits before dispatching to the prepared-analysis path; this
  // function (the fetch-pipeline race-path CF call) must split too, or the
  // BE sees a different request shape than the analyse path. When the
  // caller has already split (analyticsDsl provided), keep the inputs
  // unchanged.
  let resolvedAnalyticsDsl: string;
  let resolvedTemporalDsl: string;
  if (analyticsDsl != null && analyticsDsl !== '') {
    resolvedAnalyticsDsl = analyticsDsl;
    resolvedTemporalDsl = queryDsl;
  } else {
    const split = splitDslSubjectTemporal(queryDsl);
    resolvedAnalyticsDsl = split.subject;
    resolvedTemporalDsl = split.temporal || queryDsl;
  }

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
        // Filter by the temporal portion only — context() lives on the
        // temporal side, not the subject side.
        const filtered = await filterCandidatesByContext(fullInventory, resolvedTemporalDsl);
        candidateRegimesByEdge = Object.keys(filtered).length > 0 ? filtered : fullInventory;
      }
    } catch (err: any) {
      console.warn('[conditionedForecast] Failed to build candidate regimes:', err?.message);
    }
  }

  const payload = {
    analytics_dsl: resolvedAnalyticsDsl,
    scenarios: [{
      scenario_id: resolvedScenarioId,
      graph: graphSnapshot,
      effective_query_dsl: resolvedTemporalDsl,
      candidate_regimes_by_edge: candidateRegimesByEdge,
    }],
  };

  const url = `${PYTHON_API_BASE}/api/forecast/conditioned`;

  const CF_TIMEOUT_MS = 20_000;

  let response: Response;
  let timedOut = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CF_TIMEOUT_MS);
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(payload),
    });
    clearTimeout(timeout);
  } catch (e) {
    // Throw so callers (notably fetchDataService's CF .catch handler
    // and the param-pack CLI) see the failure rather than silently
    // proceeding with FE-only values. Timeout / network failures are
    // distinguished in the message so operators can tell which budget
    // is being blown.
    const reason = timedOut
      ? `Timed out after ${CF_TIMEOUT_MS}ms`
      : `Network error: ${(e as any)?.message ?? e}`;
    console.warn('[conditionedForecast]', reason);
    throw new Error(`[conditionedForecast] ${reason}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const reason = `HTTP ${response.status} ${response.statusText}: ${text.slice(0, 200)}`;
    console.warn('[conditionedForecast]', reason);
    throw new Error(`[conditionedForecast] ${reason}`);
  }

  let body: { success: boolean; scenarios: ConditionedForecastScenarioResult[] };
  try {
    body = await response.json();
  } catch (e) {
    const reason = `JSON parse error: ${(e as any)?.message ?? e}`;
    console.warn('[conditionedForecast]', reason);
    throw new Error(`[conditionedForecast] ${reason}`);
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
      const spec = extractCfEdgeWriteSpec(edge);
      if (!spec) continue;

      // Find existing edge to preserve its non-CF-owned latency values
      // (t95, path_t95 — FE topo's responsibility, not CF output).
      const graphEdge = (graph.edges ?? []).find(
        (e: any) => (e.uuid || e.id) === spec.edge_uuid
      );
      if (!graphEdge?.p) continue;

      const lat = graphEdge.p.latency ?? {};
      // Doc 45: CF owns completeness + completeness_sd. They are the
      // authoritative values — overwrite the existing (FE-topo-derived)
      // scalars. Fall back to existing only when CF did not return a value.
      const completenessFromCf =
        spec.completeness != null ? spec.completeness : (lat.completeness ?? 0);
      const completenessSdFromCf =
        spec.completeness_stdev != null ? spec.completeness_stdev : lat.completeness_stdev;

      // Doc 73b §3.2 / Stage 4(c) — CF de-collapse: CF must NOT write
      // p.forecast.{mean, stdev, source}. The promoted surface is
      // populated exclusively by applyPromotion from model_vars[]. CF's
      // p.mean (current-answer) lands via blendedMean below; CF's
      // dispersion lands via stdev / stdev_pred per §6.2 row S9.
      edgeUpdates.push({
        edgeId: spec.edge_uuid,
        latency: {
          // t95 + path_t95 remain FE-topo's (latency fit, not CF output)
          t95: lat.t95 ?? 0,
          path_t95: lat.path_t95 ?? 0,
          // completeness is CF-authored
          completeness: completenessFromCf,
          ...(completenessSdFromCf != null ? { completeness_stdev: completenessSdFromCf } : {}),
        },
        ...(spec.stdev != null ? { stdev: spec.stdev } : {}),
        ...(spec.stdev_pred != null ? { stdev_pred: spec.stdev_pred } : {}),
        blendedMean: spec.blendedMean,
        ...((spec.evidence_n != null || spec.evidence_k != null)
          ? {
              evidence: {
                ...(spec.evidence_n != null ? { n: spec.evidence_n } : {}),
                ...(spec.evidence_k != null ? { k: spec.evidence_k } : {}),
              },
            }
          : {}),
      });

      console.log(
        `[conditionedForecast] ${spec.edge_uuid.slice(0, 12)}: `
        + `p.mean=${spec.blendedMean.toFixed(4)} `
        + `completeness=${completenessFromCf != null ? completenessFromCf.toFixed(4) : '—'} `
        + `response_evidence=${spec.evidence_k ?? '—'}/${spec.evidence_n ?? '—'}`
      );
    }
  }

  if (edgeUpdates.length === 0) return graph;

  // scope:'cf' tells applyBatchLAGValues NOT to touch model_vars[*].
  // CF only owns current-answer scalars (`p.mean` via blendedMean,
  // `p.stdev`, `p.latency.completeness`, `p.latency.completeness_stdev`,
  // `p.evidence.*`). Per first principles only FE topo (analytic) and
  // file-fetch (bayesian) may mutate the source ledger.
  return updateManager.applyBatchLAGValues(graph, edgeUpdates, { scope: 'cf' });
}
