/**
 * CLI-specific aggregation pipeline.
 *
 * Replicates the core of fileToGraphSync.getParameterFromFile() without
 * browser dependencies (react-hot-toast, window events, etc.).
 *
 * Uses the same pure functions the browser uses:
 *   - parseConstraints / resolveRelativeDate for DSL → date range
 *   - aggregateWindowData / aggregateCohortData for daily → evidence
 *   - enhanceGraphLatencies for LAG topo pass (completeness, blend, t95)
 */

import type { Graph, DateRange } from '../types';
import type { ParameterValue } from '../types/parameterData';
import { parseConstraints } from '../lib/queryDSL';
import { resolveRelativeDate, normalizeToUK, parseUKDate } from '../lib/dateFormat';
import {
  aggregateWindowData,
  aggregateCohortData,
  aggregateLatencyStats,
  isCohortModeValue,
  isDateInRange,
  parseDate,
} from '../services/windowAggregationService';
import type { CohortData } from '../services/windowAggregationService';
import {
  enhanceGraphLatencies,
  computeBlendedMean,
} from '../services/statisticalEnhancementService';
import type { LAGHelpers } from '../services/statisticalEnhancementService';
import type { GraphBundle } from './diskLoader';

/**
 * Aggregate parameter file data for the requested DSL window and populate
 * graph edge fields (p.mean, p.evidence, p.forecast, p.latency, etc.).
 *
 * This is the CLI equivalent of the browser's from-file fetch pipeline.
 */
export function aggregateAndPopulateGraph(
  bundle: GraphBundle,
  queryDsl: string,
): { graph: any; warnings: string[] } {
  const graph = structuredClone(bundle.graph);
  const warnings: string[] = [];

  // Parse DSL to extract window/cohort dates
  const parsed = parseConstraints(queryDsl);
  const now = new Date();

  let windowRange: DateRange | undefined;
  let cohortRange: DateRange | undefined;
  let isCohort = false;

  // resolveRelativeDate returns a UK date string (e.g. "1-Dec-25")
  const today = normalizeToUK(now.toISOString().split('T')[0]);

  if (parsed.cohort?.start) {
    const start = resolveRelativeDate(parsed.cohort.start);
    const end = parsed.cohort.end ? resolveRelativeDate(parsed.cohort.end) : today;
    cohortRange = { start, end };
    isCohort = true;
  }
  if (parsed.window?.start) {
    const start = resolveRelativeDate(parsed.window.start);
    const end = parsed.window.end ? resolveRelativeDate(parsed.window.end) : today;
    windowRange = { start, end };
  }

  if (!windowRange && !cohortRange) {
    warnings.push('No window() or cohort() clause found in query DSL — using graph-as-saved values');
    return { graph, warnings };
  }

  const effectiveWindow = windowRange ?? cohortRange!;

  // For each edge, aggregate parameter file data
  for (const edge of graph.edges ?? []) {
    const paramId = edge.p?.id || edge.p?.parameter_id;
    if (!paramId) continue;

    const paramFile = bundle.parameters.get(paramId);
    if (!paramFile?.values || paramFile.values.length === 0) {
      warnings.push(`${edge.id || edge.uuid}: no parameter file data for '${paramId}'`);
      continue;
    }

    const values: ParameterValue[] = paramFile.values;

    // Filter to window/cohort mode values
    const modeValues = isCohort
      ? values.filter((v: any) => isCohortModeValue(v))
      : values.filter((v: any) => !isCohortModeValue(v));

    if (modeValues.length === 0) {
      warnings.push(`${edge.id || edge.uuid}: no ${isCohort ? 'cohort' : 'window'}-mode values in parameter file`);
      continue;
    }

    // TODO: slice filtering by context from DSL (context(channel:google) etc.)
    // For now, use all values in the correct mode.

    // Aggregate daily arrays within the requested window
    const aggregated = aggregateDailyArrays(modeValues, effectiveWindow);

    if (aggregated.n === 0) {
      warnings.push(`${edge.id || edge.uuid}: no data points within requested window`);
      continue;
    }

    // Compute evidence scalars
    const evidenceMean = aggregated.n > 0 ? aggregated.k / aggregated.n : 0;
    const evidenceStdev = aggregated.n > 0
      ? Math.sqrt((evidenceMean * (1 - evidenceMean)) / aggregated.n)
      : 0;

    // Write to edge
    if (!edge.p) edge.p = {};
    edge.p.evidence = {
      mean: evidenceMean,
      stdev: evidenceStdev,
      n: aggregated.n,
      k: aggregated.k,
    };
    edge.p.mean = evidenceMean;
    edge.p.stdev = evidenceStdev;

    // Preserve latency summary if available from param file
    if (aggregated.medianLagDays !== undefined) {
      if (!edge.p.latency) edge.p.latency = {};
      edge.p.latency.median_lag_days = aggregated.medianLagDays;
    }
  }

  // Stage 2: LAG topological pass (latency, completeness, blend, t95)
  // This requires paramLookup and helpers — build from the aggregated data
  try {
    const paramLookup = buildParamLookup(bundle, isCohort);
    const helpers = buildLAGHelpers();
    // enhanceGraphLatencies expects cohortWindow as { start: Date; end: Date }
    const cohortWindowDates = effectiveWindow
      ? { start: parseUKDate(effectiveWindow.start), end: parseUKDate(effectiveWindow.end) }
      : undefined;
    const lagResult = enhanceGraphLatencies(
      graphToGraphForPath(graph),
      paramLookup,
      now,
      helpers,
      cohortWindowDates,
      undefined, // whatIfDSL
      undefined, // pathT95Map
      isCohort ? 'cohort' : 'window',
    );

    // Apply LAG results to graph edges
    for (const ev of lagResult.edgeValues) {
      if (ev.conditionalIndex !== undefined) continue; // skip conditional_p for now
      const edge = (graph.edges ?? []).find((e: any) => e.uuid === ev.edgeUuid);
      if (!edge?.p) continue;

      // Latency fields
      if (!edge.p.latency) edge.p.latency = {};
      edge.p.latency.t95 = ev.latency.t95;
      edge.p.latency.path_t95 = ev.latency.path_t95;
      edge.p.latency.completeness = ev.latency.completeness;
      if (ev.latency.median_lag_days !== undefined) edge.p.latency.median_lag_days = ev.latency.median_lag_days;
      if (ev.latency.mean_lag_days !== undefined) edge.p.latency.mean_lag_days = ev.latency.mean_lag_days;

      // Blended mean (completeness-weighted evidence + forecast)
      if (ev.blendedMean !== undefined) {
        edge.p.mean = ev.blendedMean;
      }

      // Forecast
      if (ev.forecast?.mean !== undefined) {
        if (!edge.p.forecast) edge.p.forecast = {};
        edge.p.forecast.mean = ev.forecast.mean;
      }

      // Evidence (LAG pass may refine these)
      if (ev.evidence?.mean !== undefined) {
        if (!edge.p.evidence) edge.p.evidence = {};
        edge.p.evidence.mean = ev.evidence.mean;
      }
    }
  } catch (err: any) {
    warnings.push(`LAG enhancement failed: ${err.message}`);
  }

  return { graph, warnings };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface AggregatedDaily {
  n: number;
  k: number;
  dates: string[];
  medianLagDays?: number;
}

/**
 * Sum n_daily and k_daily arrays within the requested window range.
 */
function aggregateDailyArrays(
  values: ParameterValue[],
  window: DateRange,
): AggregatedDaily {
  let totalN = 0;
  let totalK = 0;
  const includedDates: string[] = [];
  let medianLagSum = 0;
  let medianLagCount = 0;

  for (const v of values as any[]) {
    const dates: string[] = v.dates ?? [];
    const nDaily: number[] = v.n_daily ?? [];
    const kDaily: number[] = v.k_daily ?? [];
    const medianLagDaily: number[] = v.median_lag_days ?? [];

    for (let i = 0; i < dates.length; i++) {
      if (typeof dates[i] !== 'string') continue; // skip non-string entries
      if (!isDateInRange(dates[i], window)) continue;

      const n = nDaily[i] ?? 0;
      const k = kDaily[i] ?? 0;
      totalN += n;
      totalK += k;
      includedDates.push(dates[i]);

      if (medianLagDaily[i] !== undefined && medianLagDaily[i] !== null && n > 0) {
        medianLagSum += medianLagDaily[i] * n;
        medianLagCount += n;
      }
    }
  }

  return {
    n: totalN,
    k: totalK,
    dates: includedDates.sort(),
    medianLagDays: medianLagCount > 0 ? medianLagSum / medianLagCount : undefined,
  };
}

/**
 * Build the paramLookup Map that enhanceGraphLatencies expects.
 */
function buildParamLookup(bundle: GraphBundle, isCohort: boolean): Map<string, any[]> {
  const lookup = new Map<string, any[]>();
  for (const edge of bundle.graph.edges ?? []) {
    const paramId = edge.p?.id || edge.p?.parameter_id;
    if (!paramId) continue;
    const paramFile = bundle.parameters.get(paramId);
    if (!paramFile?.values) continue;

    const values = isCohort
      ? paramFile.values.filter((v: any) => isCohortModeValue(v))
      : paramFile.values.filter((v: any) => !isCohortModeValue(v));

    const edgeKey = edge.uuid || edge.id;
    lookup.set(edgeKey, values);
  }
  return lookup;
}

/**
 * Build the LAGHelpers object expected by enhanceGraphLatencies.
 * Provides the three aggregation functions from windowAggregationService.
 */
function buildLAGHelpers(): LAGHelpers {
  return {
    aggregateCohortData,
    aggregateWindowData,
    aggregateLatencyStats,
  };
}

/**
 * Convert our graph to the GraphForPath interface enhanceGraphLatencies expects.
 */
function graphToGraphForPath(graph: any) {
  return {
    nodes: graph.nodes ?? [],
    edges: graph.edges ?? [],
  };
}
