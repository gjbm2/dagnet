/**
 * Shared BE topo pass for CLI commands.
 *
 * Builds cohort_data from disk-loaded parameter files, calls the BE
 * /api/lag/topo-pass endpoint, and writes engine-computed values onto
 * the graph edges. Used by param-pack (always) and analyse (--topo-pass).
 *
 * D18 FIX: When a queryDsl is provided, cohorts are scoped to the
 * DSL date range for IS conditioning (scoped_cohorts in edge_contexts).
 * Model fitting uses all cohorts (cohort_data). This matches the FE
 * browser behaviour in beTopoPassService.ts.
 */

import { log, isDiagnostic } from './logger';
import { PYTHON_API_BASE } from '../lib/pythonApiBase';
import { parseConstraints } from '../lib/queryDSL';
import { parseDate } from '../services/windowAggregationService';
import { resolveRelativeDate, formatDateUK } from '../lib/dateFormat';

interface TopoEdgeResult {
  edge_uuid: string;
  completeness?: number;
  completeness_stdev?: number;
  blended_mean?: number;
  p_sd?: number;
  p_infinity?: number;
  p_evidence?: number;
  t95?: number;
  path_t95?: number;
  mu?: number;
  sigma?: number;
  onset_delta_days?: number;
  mu_sd?: number;
  sigma_sd?: number;
  onset_sd?: number;
  onset_mu_corr?: number;
  path_mu?: number;
  path_sigma?: number;
  path_onset_delta_days?: number;
  path_mu_sd?: number;
  path_sigma_sd?: number;
  path_onset_sd?: number;
  median_lag_days?: number;
  mean_lag_days?: number;
}

interface TopoPassResult {
  success: boolean;
  edges: TopoEdgeResult[];
  summary: { edges_processed: number; edges_with_lag: number };
}

/**
 * Build a single cohort record from a param file's daily arrays.
 */
function buildCohortRecord(
  dates: string[], d: number,
  nDaily: number[], kDaily: number[],
  medianLagDaily: number[], meanLagDaily: number[],
  anchorMedianDaily: number[], anchorMeanDaily: number[],
): any {
  return {
    date: dates[d],
    age: dates.length - d,
    n: nDaily[d] || 0,
    k: kDaily[d] || 0,
    median_lag_days: medianLagDaily[d] ?? null,
    mean_lag_days: meanLagDaily[d] ?? null,
    anchor_median_lag_days: anchorMedianDaily[d] ?? null,
    anchor_mean_lag_days: anchorMeanDaily[d] ?? null,
  };
}

/**
 * Build cohort_data (all cohorts, for model fitting) and optionally
 * edge_contexts with scoped_cohorts (DSL-filtered, for conditioning).
 *
 * D18 FIX: when scopeWindow is provided, cohorts whose dates fall
 * within the window are emitted as scoped_cohorts in edge_contexts.
 * The BE uses scoped_cohorts for IS conditioning while using the
 * full cohort_data for model fitting — matching the FE browser
 * behaviour in beTopoPassService.ts.
 */
function buildCohortDataAndContexts(
  graph: any,
  parameters: Map<string, any>,
  scopeWindow?: { start: Date; end: Date },
): { cohortData: Record<string, any[]>; edgeContexts: Record<string, any> } {
  const cohortData: Record<string, any[]> = {};
  const edgeContexts: Record<string, any> = {};
  const paramIdToEdgeUuid = new Map<string, string>();
  for (const edge of (graph.edges || [])) {
    const eid = edge.uuid || edge.id;
    const pId = edge.p?.id;
    if (pId) paramIdToEdgeUuid.set(pId, eid);
  }
  for (const [paramId, paramData] of Array.from(parameters)) {
    const edgeUuid = paramIdToEdgeUuid.get(paramId);
    if (!edgeUuid) continue;
    const vals = paramData.values || [];
    if (vals.length === 0) continue;
    const v = vals[0];
    const nDaily: number[] = v.n_daily || [];
    const kDaily: number[] = v.k_daily || [];
    const dates: string[] = v.dates || [];
    const medianLagDaily: number[] = v.median_lag_days || [];
    const meanLagDaily: number[] = v.mean_lag_days || [];
    const anchorMedianDaily: number[] = v.anchor_median_lag_days || [];
    const anchorMeanDaily: number[] = v.anchor_mean_lag_days || [];

    const cohortsAll: any[] = [];
    const cohortsScoped: any[] = [];

    for (let d = 0; d < dates.length; d++) {
      if ((nDaily[d] || 0) === 0) continue;
      const rec = buildCohortRecord(
        dates, d, nDaily, kDaily,
        medianLagDaily, meanLagDaily,
        anchorMedianDaily, anchorMeanDaily,
      );
      cohortsAll.push(rec);

      if (scopeWindow) {
        try {
          const cohortDate = parseDate(dates[d]);
          if (cohortDate >= scopeWindow.start && cohortDate <= scopeWindow.end) {
            cohortsScoped.push(rec);
          }
        } catch {
          // Unparseable date — skip from scoped set
        }
      }
    }

    if (cohortsAll.length > 0) {
      cohortData[edgeUuid] = cohortsAll;
    }

    // Only send scoped_cohorts when the scope actually reduces the set
    if (scopeWindow && cohortsScoped.length > 0 && cohortsScoped.length !== cohortsAll.length) {
      edgeContexts[edgeUuid] = { scoped_cohorts: cohortsScoped };
    }
  }
  return { cohortData, edgeContexts };
}

/**
 * Write topo pass results onto graph edges.
 *
 * Writes engine-computed values to the user-facing fields (completeness,
 * blended p.mean, completeness_stdev) AND promoted latency fields used
 * by downstream analysis types.
 */
function writeTopoResultsToGraph(graph: any, edges: TopoEdgeResult[]): void {
  const edgeMap = new Map(edges.map(e => [e.edge_uuid, e]));
  for (const edge of (graph.edges || [])) {
    const eid = edge.uuid || edge.id;
    const te = edgeMap.get(eid);
    if (!te) continue;
    const p = (edge.p ??= {});
    const lat = (p.latency ??= {});

    // Engine-computed user-facing values
    if (te.completeness != null) lat.completeness = te.completeness;
    if (te.completeness_stdev != null) lat.completeness_stdev = te.completeness_stdev;
    if (te.blended_mean != null) p.mean = te.blended_mean;
    if (te.p_sd != null) p.stdev = te.p_sd;
    if (te.p_infinity != null) {
      (p.forecast ??= {}).mean = te.p_infinity;
    }
    if (te.median_lag_days != null) lat.median_lag_days = te.median_lag_days;
    if (te.mean_lag_days != null) lat.mean_lag_days = te.mean_lag_days;

    // Promoted latency fields (used by analysis types)
    if (te.t95 != null) lat.promoted_t95 = te.t95;
    if (te.onset_delta_days != null) lat.promoted_onset_delta_days = te.onset_delta_days;
    if (te.mu != null) lat.promoted_mu = te.mu;
    if (te.sigma != null) lat.promoted_sigma = te.sigma;
    if (te.mu_sd != null) lat.promoted_mu_sd = te.mu_sd;
    if (te.sigma_sd != null) lat.promoted_sigma_sd = te.sigma_sd;
    if (te.onset_sd != null) lat.promoted_onset_sd = te.onset_sd;
    if (te.onset_mu_corr != null) lat.promoted_onset_mu_corr = te.onset_mu_corr;
    if (te.path_t95 != null) lat.promoted_path_t95 = te.path_t95;
    if (te.path_mu != null) lat.promoted_path_mu = te.path_mu;
    if (te.path_sigma != null) lat.promoted_path_sigma = te.path_sigma;
    if (te.path_onset_delta_days != null) lat.promoted_path_onset_delta_days = te.path_onset_delta_days;
    if (te.path_mu_sd != null) lat.promoted_path_mu_sd = te.path_mu_sd;
    if (te.path_sigma_sd != null) lat.promoted_path_sigma_sd = te.path_sigma_sd;
    if (te.path_onset_sd != null) lat.promoted_path_onset_sd = te.path_onset_sd;
  }
}

/**
 * Parse a cohort/window date range from a query DSL string.
 * Returns a scope window {start, end} or undefined if no temporal
 * clause is found.
 *
 * Handles absolute dates (cohort(7-Mar-26:21-Mar-26)) and relative
 * dates (cohort(-30d:), window(-2w:)) via resolveRelativeDate.
 * Open-ended ranges (no end date) default to today.
 *
 * Follows the same resolution pattern as the FE browser path
 * (fetchDataService.ts:1527, fetchOrchestratorService.ts:48).
 */
function parseScopeWindow(queryDsl: string): { start: Date; end: Date } | undefined {
  const parsed = parseConstraints(queryDsl);

  // Prefer cohort() range, fall back to window()
  const temporal = parsed.cohort ?? parsed.window;
  if (!temporal) return undefined;

  const startStr = temporal.start;
  if (!startStr) return undefined;

  // Open-ended range (no end) defaults to today — same as FE
  const endStr = temporal.end || formatDateUK(new Date());

  try {
    const resolvedStart = resolveRelativeDate(startStr);
    const resolvedEnd = resolveRelativeDate(endStr);
    const start = parseDate(resolvedStart);
    const end = parseDate(resolvedEnd);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return undefined;
    return { start, end };
  } catch {
    return undefined;
  }
}

/**
 * Run the BE topo pass on a graph using disk-loaded parameter files.
 *
 * Builds cohort data from bundle.parameters, calls the BE endpoint,
 * and writes results onto the graph edges in place.
 *
 * When queryDsl is provided, cohorts are scoped to the DSL date range
 * for IS conditioning (D18 fix). Model fitting uses all cohorts.
 *
 * Returns true if the topo pass ran successfully, false if the BE was
 * unreachable (graph is unchanged — FE-only values remain).
 */
export async function runCliTopoPass(
  graph: any,
  parameters: Map<string, any>,
  queryDsl?: string,
  workspace?: { repository: string; branch: string },
): Promise<boolean> {
  // Parse temporal scope from DSL
  const scopeWindow = queryDsl ? parseScopeWindow(queryDsl) : undefined;
  if (scopeWindow) {
    log.info(`Scoping topo pass cohorts to ${scopeWindow.start.toISOString().slice(0, 10)} – ${scopeWindow.end.toISOString().slice(0, 10)}`);
  }

  const { cohortData, edgeContexts } = buildCohortDataAndContexts(graph, parameters, scopeWindow);
  const scopedCount = Object.keys(edgeContexts).length;
  log.info(`Built cohort data for ${Object.keys(cohortData).length} edges` +
    (scopedCount > 0 ? ` (${scopedCount} with scoped_cohorts)` : ''));

  // Determine query mode from DSL
  const queryMode = queryDsl?.includes('window(') ? 'window' : 'cohort';

  // ── Build snapshot_evidence for parity with v3 ──────────────────
  // Design invariant: p.mean from topo pass == p@∞ from v3 cohort
  // maturity. Both must use the same snapshot DB evidence. When
  // workspace is available, compute candidate regimes and date bounds
  // so the BE can query the DB instead of using parameter file cohorts.
  let snapshotEvidence: Record<string, any> | undefined;
  if (workspace && scopeWindow && queryDsl) {
    try {
      const { buildCandidateRegimesByEdge, filterCandidatesByContext } = await import('../services/candidateRegimeService');
      const fullInventory = await buildCandidateRegimesByEdge(graph, workspace);
      let candidateRegimesByEdge = fullInventory;
      if (Object.keys(fullInventory).length > 0) {
        const filtered = await filterCandidatesByContext(fullInventory, queryDsl);
        if (Object.keys(filtered).length > 0) {
          candidateRegimesByEdge = filtered;
        }
      }
      if (Object.keys(candidateRegimesByEdge).length > 0) {
        const anchorFrom = scopeWindow.start.toISOString().slice(0, 10);
        const anchorTo = scopeWindow.end.toISOString().slice(0, 10);
        snapshotEvidence = {
          candidate_regimes_by_edge: candidateRegimesByEdge,
          anchor_from: anchorFrom,
          anchor_to: anchorTo,
          sweep_from: anchorFrom,
          sweep_to: anchorTo,
        };
        log.info(`Snapshot evidence: ${Object.keys(candidateRegimesByEdge).length} edges with candidate regimes`);
        if (isDiagnostic()) {
          log.diag('── Topo pass: snapshot evidence ──');
          for (const [eid, cands] of Object.entries(candidateRegimesByEdge)) {
            for (const c of cands as any[]) {
              log.diag(`  ${eid.slice(0, 12)}: hash=${c.core_hash?.slice(0, 16)} mode=${c.temporal_mode || '?'} eq=${(c.equivalent_hashes || []).length}`);
            }
          }
        }
      }
    } catch (err: any) {
      log.warn(`Failed to build snapshot evidence: ${err.message} — falling back to parameter files`);
    }
  }

  const topoUrl = `${PYTHON_API_BASE}/api/lag/topo-pass`;

  // Diagnostic: per-edge cohort detail
  if (isDiagnostic()) {
    log.diag('── Topo pass: cohort data detail ──');
    for (const [edgeUuid, cohorts] of Object.entries(cohortData)) {
      const scoped = edgeContexts[edgeUuid]?.scoped_cohorts;
      const totalN = (cohorts as any[]).reduce((sum: number, c: any) => sum + (c.n || 0), 0);
      const totalK = (cohorts as any[]).reduce((sum: number, c: any) => sum + (c.k || 0), 0);
      log.diag(`  ${edgeUuid}: ${(cohorts as any[]).length} cohorts (total n=${totalN}, k=${totalK})${scoped ? `, ${scoped.length} scoped` : ''}`);
    }
    log.diag(`  query_mode=${queryMode}`);
    log.diag(`  endpoint=${topoUrl}`);
  }
  let topoResponse: Response;
  try {
    topoResponse = await fetch(topoUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        graph,
        cohort_data: cohortData,
        edge_contexts: edgeContexts,
        query_mode: queryMode,
        ...(snapshotEvidence ? { snapshot_evidence: snapshotEvidence } : {}),
      }),
    });
  } catch (err: any) {
    log.warn(`BE topo pass unavailable (${err.message}) — using FE-only values`);
    return false;
  }

  if (!topoResponse.ok) {
    log.warn(`BE topo pass failed: ${topoResponse.status} ${topoResponse.statusText} — using FE-only values`);
    return false;
  }

  const topoResult = await topoResponse.json() as TopoPassResult;
  if (!topoResult.success) {
    log.warn('BE topo pass returned success=false — using FE-only values');
    return false;
  }

  writeTopoResultsToGraph(graph, topoResult.edges);
  const snapCount = (topoResult.summary as any).forecast_state_snapshot_count ?? 0;
  log.info(`BE topo pass: ${topoResult.summary.edges_processed} edges, ${topoResult.summary.edges_with_lag} with lag` +
    (snapCount > 0 ? `, ${snapCount} via snapshot DB` : ''));

  // Diagnostic: per-edge topo pass results
  if (isDiagnostic()) {
    log.diag('── Topo pass: per-edge results ──');
    for (const te of topoResult.edges) {
      const parts: string[] = [];
      if (te.completeness != null) parts.push(`completeness=${te.completeness.toFixed(4)}`);
      if (te.blended_mean != null) parts.push(`blended_mean=${te.blended_mean.toFixed(4)}`);
      if (te.p_sd != null) parts.push(`p_sd=${te.p_sd.toFixed(4)}`);
      if (te.t95 != null) parts.push(`t95=${te.t95.toFixed(1)}`);
      if (te.mu != null) parts.push(`mu=${te.mu.toFixed(3)}`);
      if (te.sigma != null) parts.push(`sigma=${te.sigma.toFixed(3)}`);
      if (te.onset_delta_days != null) parts.push(`onset=${te.onset_delta_days.toFixed(1)}`);
      if (te.path_t95 != null) parts.push(`path_t95=${te.path_t95.toFixed(1)}`);
      if (te.path_mu != null) parts.push(`path_mu=${te.path_mu.toFixed(3)}`);
      log.diag(`  ${te.edge_uuid}: ${parts.join('  ')}`);
    }
  }

  return true;
}
