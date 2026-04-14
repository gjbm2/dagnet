/**
 * Shared BE topo pass for CLI commands.
 *
 * Builds cohort_data from disk-loaded parameter files, calls the BE
 * /api/lag/topo-pass endpoint, and writes engine-computed values onto
 * the graph edges. Used by param-pack (always) and analyse (--topo-pass).
 */

import { log } from './logger';
import { PYTHON_API_BASE } from '../lib/pythonApiBase';

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
 * Build cohort_data from bundle.parameters (disk-loaded param files).
 * Returns a map from edge UUID → per-date cohort records.
 */
function buildCohortData(
  graph: any,
  parameters: Map<string, any>,
): Record<string, any[]> {
  const cohortData: Record<string, any[]> = {};
  const paramIdToEdgeUuid = new Map<string, string>();
  for (const edge of (graph.edges || [])) {
    const eid = edge.uuid || edge.id;
    const edgeId = edge.id || '';
    paramIdToEdgeUuid.set(edgeId, eid);
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
    const cohorts: any[] = [];
    for (let d = 0; d < dates.length; d++) {
      if ((nDaily[d] || 0) === 0) continue;
      cohorts.push({
        date: dates[d],
        age: dates.length - d,
        n: nDaily[d] || 0,
        k: kDaily[d] || 0,
        median_lag_days: medianLagDaily[d] ?? null,
        mean_lag_days: meanLagDaily[d] ?? null,
        anchor_median_lag_days: anchorMedianDaily[d] ?? null,
        anchor_mean_lag_days: anchorMeanDaily[d] ?? null,
      });
    }
    if (cohorts.length > 0) {
      cohortData[edgeUuid] = cohorts;
    }
  }
  return cohortData;
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
 * Run the BE topo pass on a graph using disk-loaded parameter files.
 *
 * Builds cohort data from bundle.parameters, calls the BE endpoint,
 * and writes results onto the graph edges in place.
 *
 * Returns true if the topo pass ran successfully, false if the BE was
 * unreachable (graph is unchanged — FE-only values remain).
 */
export async function runCliTopoPass(
  graph: any,
  parameters: Map<string, any>,
): Promise<boolean> {
  const cohortData = buildCohortData(graph, parameters);
  log.info(`Built cohort data for ${Object.keys(cohortData).length} edges from parameter files`);

  const topoUrl = `${PYTHON_API_BASE}/api/lag/topo-pass`;
  let topoResponse: Response;
  try {
    topoResponse = await fetch(topoUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graph, cohort_data: cohortData }),
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
  log.info(`BE topo pass: ${topoResult.summary.edges_processed} edges, ${topoResult.summary.edges_with_lag} with lag`);
  return true;
}
