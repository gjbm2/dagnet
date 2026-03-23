/**
 * BE Topo Pass Service — calls the Python /api/lag/topo-pass endpoint
 * and upserts analytic_be model_vars entries.
 *
 * Fire-and-forget from the FE fetch pipeline: runs alongside the FE
 * topo pass so both analytic and analytic_be entries are always populated.
 */

import type { CohortData, ParameterValueForLAG, LAGHelpers } from './statisticalEnhancementService';
import type { ModelVarsEntry } from '../types';
import { buildForecastingSettings } from '../constants/latency';

/** Python API base URL (same pattern as snapshotWriteService). */
const PYTHON_API_BASE = import.meta.env.DEV
  ? (import.meta.env.VITE_PYTHON_API_URL || 'http://localhost:9000')
  : '';

/** Per-edge result from the BE topo pass. */
interface BeTopoEdgeResult {
  edge_uuid: string;
  conditional_index?: number | null;
  t95: number;
  path_t95: number;
  completeness: number;
  mu: number;
  sigma: number;
  onset_delta_days: number;
  median_lag_days?: number;
  mean_lag_days?: number;
  path_mu?: number;
  path_sigma?: number;
  path_onset_delta_days: number;
  p_infinity?: number;
  p_evidence: number;
  forecast_available: boolean;
  blended_mean?: number;
}

/**
 * Call the BE topo pass and return analytic_be ModelVarsEntry per edge.
 *
 * Aggregates cohort data from paramLookup using the same helpers the FE
 * topo pass uses, sends it to the BE, and converts results to
 * ModelVarsEntry objects ready for upsert.
 */
export async function runBeTopoPass(
  graph: any,
  paramLookup: Map<string, ParameterValueForLAG[]>,
  queryDate: Date,
  lagHelpers: LAGHelpers,
  cohortWindow?: { start: Date; end: Date },
): Promise<Array<{ edgeUuid: string; conditionalIndex?: number; entry: ModelVarsEntry }>> {
  const result: Array<{ edgeUuid: string; conditionalIndex?: number; entry: ModelVarsEntry }> = [];

  // 1. Aggregate cohort data per edge (same as FE topo pass input)
  const cohortData: Record<string, any[]> = {};
  const edgeContexts: Record<string, any> = {};

  const serializeCohorts = (cohorts: CohortData[]) => cohorts.map(c => ({
    date: c.date,
    age: c.age,
    n: c.n,
    k: c.k,
    median_lag_days: c.median_lag_days,
    mean_lag_days: c.mean_lag_days,
    anchor_median_lag_days: c.anchor_median_lag_days,
    anchor_mean_lag_days: c.anchor_mean_lag_days,
  }));

  // Helper to aggregate window slices (for onset + forecast derivation)
  const windowAggregateFn = lagHelpers.aggregateWindowData ?? lagHelpers.aggregateCohortData;

  for (const [edgeId, paramValues] of paramLookup) {
    // cohortsAll: un-windowed (for fitting/p∞)
    const cohortsAll = lagHelpers.aggregateCohortData(paramValues, queryDate, undefined);
    // cohortsScoped: windowed (for evidence/completeness/blend) — matches FE cohortsScoped
    const cohortsScoped = lagHelpers.aggregateCohortData(paramValues, queryDate, cohortWindow);
    if (cohortsAll.length > 0) {
      cohortData[edgeId] = serializeCohorts(cohortsAll);
    }

    // Build per-edge context for FE parity (D2, D4, D6)
    const ctx: any = {};

    // D2: Onset from window() slices via weighted quantile
    const windowSlicesWithOnset = (paramValues as any[]).filter((v: any) => {
      const dsl = v.sliceDSL ?? '';
      return dsl.includes('window(') && typeof v.latency?.onset_delta_days === 'number';
    });
    if (windowSlicesWithOnset.length > 0) {
      // Weighted quantile (weight = dates.length, β = 0.5)
      const items = windowSlicesWithOnset.map((v: any) => ({
        value: v.latency.onset_delta_days as number,
        weight: (Array.isArray(v.dates) && v.dates.length > 0) ? v.dates.length : 1,
      }));
      // Simple weighted quantile (matches FE weightedQuantile with β=0.5)
      const sorted = [...items].sort((a, b) => a.value - b.value);
      const totalW = sorted.reduce((s, x) => s + x.weight, 0);
      if (totalW > 0) {
        let cum = 0;
        for (const x of sorted) {
          cum += x.weight;
          if (cum / totalW >= 0.5) {
            ctx.onset_from_window_slices = x.value;
            break;
          }
        }
      }
    }

    // D4+D9: Window cohorts for forecast derivation.
    // FE uses forecastAsOfDate (max window end date) as the recency reference.
    // Compute that date and pass window cohorts aggregated against it.
    const forecastAsOfDate = (() => {
      try {
        let best: Date | undefined;
        const windowCandidates = (paramValues as any[]).filter(v => {
          const dsl = v?.sliceDSL;
          return typeof dsl === 'string' && dsl.includes('window(') && !dsl.includes('cohort(');
        });
        for (const v of windowCandidates) {
          const dates: string[] | undefined = v?.dates;
          if (Array.isArray(dates) && dates.length > 0) {
            const last = dates[dates.length - 1];
            if (typeof last === 'string') {
              const d = new Date(last);
              if (!Number.isNaN(d.getTime()) && (!best || d.getTime() > best.getTime())) best = d;
            }
          }
          const windowTo = v?.window_to;
          if (typeof windowTo === 'string' && windowTo.trim()) {
            const d = new Date(windowTo);
            if (!Number.isNaN(d.getTime()) && (!best || d.getTime() > best.getTime())) best = d;
          }
        }
        return best ?? queryDate;
      } catch {
        return queryDate;
      }
    })();
    const windowCohorts = windowAggregateFn(paramValues, forecastAsOfDate, cohortWindow);
    if (windowCohorts.length > 0) {
      ctx.window_cohorts = serializeCohorts(windowCohorts);
    }

    // D7: Send scoped cohorts (cohort-window-filtered)
    if (cohortWindow && cohortsScoped.length > 0 && cohortsScoped.length !== cohortsAll.length) {
      ctx.scoped_cohorts = serializeCohorts(cohortsScoped);
    }

    // D6: nBaseline from window() slices
    const windowParamValues = (paramValues as any[]).filter((v: any) => {
      const dsl = v.sliceDSL ?? '';
      return dsl.includes('window(') && !dsl.includes('cohort(') && typeof v.n === 'number' && v.n > 0;
    });
    if (windowParamValues.length > 0) {
      ctx.n_baseline_from_window = windowParamValues.reduce((sum: number, v: any) => sum + (v.n ?? 0), 0);
    }

    if (Object.keys(ctx).length > 0) {
      edgeContexts[edgeId] = ctx;
    }
  }

  if (Object.keys(cohortData).length === 0) {
    return result;
  }

  // 2. Call BE
  const settings = buildForecastingSettings();
  const url = `${PYTHON_API_BASE}/api/lag/topo-pass`;

  // ── Golden fixture: send FE outputs alongside BE request ──
  // The BE /api/lag/topo-pass endpoint writes the fixture to debug/ when
  // fe_outputs is present in the request body.
  const feOutputs = (typeof window !== 'undefined' && (window as any).__feTopoFixtureOutputs)
    ? (window as any).__feTopoFixtureOutputs
    : undefined;
  if (feOutputs) {
    delete (window as any).__feTopoFixtureOutputs;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        graph,
        cohort_data: cohortData,
        edge_contexts: edgeContexts,
        forecasting_settings: settings,
        ...(feOutputs ? { fe_outputs: feOutputs } : {}),
      }),
    });
  } catch (e) {
    console.warn('[beTopoPass] Network error:', e);
    return result;
  }

  if (!response.ok) {
    console.warn('[beTopoPass] HTTP error:', response.status, await response.text().catch(() => ''));
    return result;
  }

  let body: { success: boolean; edges: BeTopoEdgeResult[] };
  try {
    body = await response.json();
  } catch (e) {
    console.warn('[beTopoPass] JSON parse error:', e);
    return result;
  }

  if (!body.success || !body.edges) {
    return result;
  }

  // 3. Convert to ModelVarsEntry per edge
  const now = new Date();
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const sourceAt = `${now.getDate()}-${months[now.getMonth()]}-${String(now.getFullYear()).slice(-2)}`;

  for (const edge of body.edges) {
    const entry: ModelVarsEntry = {
      source: 'analytic_be',
      source_at: sourceAt,
      probability: {
        mean: edge.p_evidence,
        stdev: 0, // BE doesn't compute stdev in this path
      },
      ...(edge.mu != null ? {
        latency: {
          mu: edge.mu,
          sigma: edge.sigma,
          t95: edge.t95,
          onset_delta_days: edge.onset_delta_days,
          ...(edge.path_mu != null ? {
            path_mu: edge.path_mu,
            path_sigma: edge.path_sigma,
            path_t95: edge.path_t95,
            path_onset_delta_days: edge.path_onset_delta_days,
          } : {}),
        },
      } : {}),
    };
    result.push({
      edgeUuid: edge.edge_uuid,
      conditionalIndex: edge.conditional_index ?? undefined,
      entry,
    });
  }

  console.log(`[beTopoPass] ${result.length} edge entries computed from BE`);
  return result;
}
