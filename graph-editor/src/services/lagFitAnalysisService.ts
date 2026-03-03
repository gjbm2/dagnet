/**
 * Lag Fit Analysis Service
 *
 * Frontend-only analysis: reads already-loaded parameter data from fileRegistry,
 * fits a log-normal lag distribution, and returns curve + observed scatter data
 * in AnalysisResult shape for rendering by LagFitChart.
 *
 * No backend call required — all data is already in-browser.
 */

import { logNormalCDF } from './lagDistributionUtils';
import {
  computeEdgeLatencyStats,
  type CohortData,
} from './statisticalEnhancementService';
import { fileRegistry } from '../contexts/TabContext';
import { formatDateUK } from '../lib/dateFormat';
import { DEFAULT_T95_DAYS, RECENCY_HALF_LIFE_DAYS } from '../constants/latency';
import type { ConversionGraph } from '../types';
import type { ParameterValue } from '../types/parameterData';
import type { AnalysisResult } from '../lib/graphComputeClient';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LagFitCurvePoint {
  t: number;         // lag days
  pdf: number;       // discretized PMF: F(t) - F(t-1)
  cdf: number;       // cumulative: F(t)
}

export interface LagFitCohortPoint {
  age: number;          // cohort age in days (today - cohort start date)
  observed_cdf: number; // empirical completeness: k / (n * p_infinity), clipped to 1
  n: number;
  k: number;
  date: string;
}

export interface LagFitData {
  curve: LagFitCurvePoint[];
  cohorts: LagFitCohortPoint[];
  mu: number;
  sigma: number;
  t95: number;
  median: number;
  p_infinity: number;
  from_node: string;
  to_node: string;
  edge_label: string;
}

// ─── DSL parsing ──────────────────────────────────────────────────────────────

/**
 * Extract from/to node IDs from a `from(A).to(B)...` DSL string.
 * Returns null if the pattern isn't matched.
 */
function parseFromTo(dsl: string): { from: string; to: string } | null {
  const fromMatch = dsl.match(/from\(([^)]+)\)/);
  const toMatch = dsl.match(/to\(([^)]+)\)/);
  if (!fromMatch || !toMatch) return null;
  return { from: fromMatch[1].trim(), to: toMatch[1].trim() };
}

// ─── Parameter helpers ────────────────────────────────────────────────────────

/** Pick the cohort-mode ParameterValue with the most entries (highest n). */
function bestCohortValue(values: ParameterValue[]): ParameterValue | undefined {
  const cohort = values.filter(
    v => v.sliceDSL?.includes('cohort(') || v.cohort_from != null
  );
  if (cohort.length === 0) return undefined;
  return cohort.reduce((best, v) => ((v.n ?? 0) > (best.n ?? 0) ? v : best));
}

/** Build CohortData[] from a ParameterValue's daily arrays. */
function buildCohortData(pv: ParameterValue): CohortData[] {
  const dates = pv.dates ?? [];
  const nDaily = pv.n_daily ?? [];
  const kDaily = pv.k_daily ?? [];
  const medianLag = pv.median_lag_days ?? [];
  const meanLag = pv.mean_lag_days ?? [];
  const today = formatDateUK(new Date());

  return dates.map((date, i) => {
    const ms = Date.parse(new Date(date).toISOString());
    const todayMs = Date.parse(new Date(today).toISOString());
    const age = Math.max(0, Math.round((todayMs - ms) / 86_400_000));
    return {
      date,
      n: nDaily[i] ?? 0,
      k: kDaily[i] ?? 0,
      age,
      median_lag_days: medianLag[i],
      mean_lag_days: meanLag[i],
    };
  });
}

// ─── Curve generation ─────────────────────────────────────────────────────────

function buildCurve(mu: number, sigma: number, t95: number): LagFitCurvePoint[] {
  const tMax = Math.ceil(t95 * 1.5);
  const points: LagFitCurvePoint[] = [];
  for (let t = 0; t <= tMax; t++) {
    const cdf = logNormalCDF(t, mu, sigma);
    const cdfPrev = t === 0 ? 0 : logNormalCDF(t - 1, mu, sigma);
    points.push({ t, pdf: cdf - cdfPrev, cdf });
  }
  return points;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Compute a lag fit analysis from currently-loaded graph + parameter data.
 *
 * @param graph  - the ConversionGraph loaded in the current tab
 * @param queryDSL - the analytics panel DSL (must contain from() and to())
 * @returns AnalysisResult suitable for AnalysisChartContainer, or null if unavailable
 */
export function computeLagFitAnalysis(
  graph: ConversionGraph,
  queryDSL: string
): AnalysisResult | null {
  // 1. Parse from/to out of DSL
  const fromTo = parseFromTo(queryDSL);
  if (!fromTo) return null;

  // 2. Build node-id → label lookup
  const nodeIdToLabel = new Map<string, string>();
  const nodeUuidToId = new Map<string, string>();
  for (const node of graph.nodes ?? []) {
    nodeIdToLabel.set(node.id, node.label ?? node.id);
    if (node.uuid) nodeUuidToId.set(node.uuid, node.id);
  }

  // 3. Find the matching edge (from/to resolved via id OR uuid)
  const resolveNodeId = (ref: string): string =>
    nodeUuidToId.get(ref) ?? ref;

  const edge = (graph.edges ?? []).find(e => {
    const fromId = resolveNodeId(e.from);
    const toId = resolveNodeId(e.to);
    return fromId === fromTo.from && toId === fromTo.to;
  });

  if (!edge) return null;

  const paramId = (edge as any).p?.id;
  if (!paramId) return null;

  // 4. Load parameter file
  const paramFile = fileRegistry.getFile(`parameter-${paramId}`);
  if (!paramFile?.data) return null;

  const values: ParameterValue[] = paramFile.data.values ?? [];
  const pv = bestCohortValue(values);
  if (!pv || !pv.dates?.length || !pv.n_daily?.length) return null;

  // 5. Get latency meta
  const latency = pv.latency ?? {};
  const aggregateMedianLag = latency.median_lag_days;
  const aggregateMeanLag = latency.mean_lag_days;
  const onsetDeltaDays = latency.onset_delta_days ?? 0;
  const edgeT95 = latency.t95;

  if (!aggregateMedianLag) return null;

  const cohorts = buildCohortData(pv);
  if (cohorts.every(c => c.n === 0)) return null;

  // 6. Fit lag distribution
  let stats;
  try {
    stats = computeEdgeLatencyStats(
      cohorts,
      aggregateMedianLag,
      aggregateMeanLag,
      DEFAULT_T95_DAYS,
      0,
      undefined,
      undefined,
      edgeT95,
      RECENCY_HALF_LIFE_DAYS,
      onsetDeltaDays,
      undefined,
      false
    );
  } catch {
    return null;
  }

  if (!stats.forecast_available || !Number.isFinite(stats.p_infinity)) return null;

  const { mu, sigma } = stats.fit;
  const t95 = stats.t95;
  const p_infinity = stats.p_infinity;
  const median = Math.exp(mu);

  // 7. Generate fitted curve
  const curve = buildCurve(mu, sigma, t95);

  // 8. Generate observed cohort scatter (each cohort's empirical completeness vs age)
  const cohortPoints: LagFitCohortPoint[] = cohorts
    .filter(c => c.n > 0 && c.age > 0)
    .map(c => ({
      age: c.age,
      observed_cdf: Math.min(1, c.k / (c.n * p_infinity)),
      n: c.n,
      k: c.k,
      date: c.date,
    }));

  // 9. Pack into AnalysisResult data rows
  const fromLabel = nodeIdToLabel.get(fromTo.from) ?? fromTo.from;
  const toLabel = nodeIdToLabel.get(fromTo.to) ?? fromTo.to;
  const edgeLabel = `${fromLabel} → ${toLabel}`;

  const dataRows: Record<string, any>[] = [
    // Metadata row (row 0)
    {
      row_type: 'meta',
      mu,
      sigma,
      t95,
      median,
      p_infinity,
      from_node: fromTo.from,
      to_node: fromTo.to,
      edge_label: edgeLabel,
    },
    // Curve rows
    ...curve.map(p => ({ row_type: 'curve', t: p.t, pdf: p.pdf, cdf: p.cdf })),
    // Cohort scatter rows
    ...cohortPoints.map(p => ({
      row_type: 'cohort',
      age: p.age,
      observed_cdf: p.observed_cdf,
      n: p.n,
      k: p.k,
      date: p.date,
    })),
  ];

  return {
    analysis_type: 'lag_fit',
    analysis_name: 'Lag Fit',
    analysis_description: `Fitted log-normal lag distribution for ${edgeLabel}`,
    metadata: {
      mu,
      sigma,
      t95,
      median,
      p_infinity,
      edge_label: edgeLabel,
      from_node: fromTo.from,
      to_node: fromTo.to,
    },
    data: dataRows,
  };
}

/**
 * Returns true if the DSL points to an edge that has usable cohort lag data.
 * Used to decide whether to inject the lag_fit analysis type into the available list.
 */
export function checkLagFitAvailable(graph: ConversionGraph, queryDSL: string): boolean {
  return computeLagFitAnalysis(graph, queryDSL) !== null;
}
