/**
 * Data Depth Service — composite coverage scoring for edges.
 *
 * Computes a per-edge depth score from three dimensions:
 *   f₁  Slice × date coverage (from fetch plan)
 *   f₂  Snapshot DB coverage
 *   f₃  Sample size adequacy (n relative to graph median)
 *
 * All factors ∈ [0, 1]; composite = w₁·f₁ + w₂·f₂ + w₃·f₃ (weighted average).
 *
 * Design doc: docs/current/data-depth-v2-composite-design.md
 */

import type { FetchPlan, FetchPlanItem } from './fetchPlanTypes';
import type { GraphEdge } from '../types';
import { RECENCY_HALF_LIFE_DAYS } from '../constants/latency';
import { expandWindowToDates } from './fetchPlanTypes';
import { parseUKDate } from '../lib/dateFormat';

// ── Composite weights (must sum to 1) ─────────────────────
// Tune these to control relative importance of each dimension.

/** Weight for f₁ (slice × date coverage from fetch plan) */
export const W_DATE_COVERAGE = 0.4;
/** Weight for f₂ (snapshot DB coverage) */
export const W_SNAPSHOT_COVERAGE = 0.3;
/** Weight for f₃ (sample size adequacy) */
export const W_SAMPLE_SIZE = 0.3;

// ── Types ──────────────────────────────────────────────────

export interface DataDepthScore {
  /** Composite depth ∈ [0, 1] */
  depth: number;
  /** Slice × date coverage ∈ [0, 1] */
  f1: number;
  /** Snapshot DB coverage ∈ [0, 1] */
  f2: number;
  /** Sample size adequacy ∈ [0, 1] */
  f3: number;
  /** Per-slice breakdown for hover tab */
  sliceBreakdown: SliceCoverage[];
}

export interface SliceCoverage {
  /** Slice family label (e.g. 'context(channel:paid-search)' or '(all)') */
  label: string;
  /** Date coverage for this slice ∈ [0, 1] */
  coverage: number;
  /** Covered days / total days */
  coveredDays: number;
  totalDays: number;
  /** n for this slice (from fetch plan item, if available) */
  n?: number;
}

// ── Helpers ────────────────────────────────────────────────

/** Recency weight for a date relative to a reference date. */
function recencyWeight(dateUK: string, refDate: Date, halfLifeDays: number): number {
  let d: Date;
  try {
    d = parseUKDate(dateUK);
  } catch {
    // Fallback: try ISO parse
    d = new Date(dateUK);
  }
  if (isNaN(d.getTime())) return 1; // Unparseable → neutral weight
  const ageDays = (refDate.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays <= 0) return 1;
  return Math.exp(-Math.LN2 * ageDays / halfLifeDays);
}

/**
 * Compute the recency-weighted coverage ratio.
 * @param coveredDates  Set of UK-format date strings that have data
 * @param allDates      All UK-format date strings in the expected window
 * @param refDate       Reference "now" for recency weighting
 * @param halfLifeDays  Half-life in days
 */
function weightedCoverage(
  coveredDates: Set<string>,
  allDates: string[],
  refDate: Date,
  halfLifeDays: number,
): number {
  if (allDates.length === 0) return 0;
  let num = 0;
  let den = 0;
  for (const d of allDates) {
    const w = recencyWeight(d, refDate, halfLifeDays);
    den += w;
    if (coveredDates.has(d)) num += w;
  }
  return den > 0 ? num / den : 0;
}

/** Compute median of an array of numbers. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ── Core scoring ───────────────────────────────────────────

/**
 * Compute f₁ (slice × date coverage) for a single edge from its fetch plan items.
 *
 * Each FetchPlanItem represents one slice family for the edge.  Items classified
 * as 'covered' contribute all their window dates; items with fetch windows have
 * gaps.  Items classified 'unfetchable' are treated as fully missing.
 *
 * Returns the overall f₁ and per-slice breakdown.
 */
function computeF1ForEdge(
  edgeItems: FetchPlanItem[],
  allDatesInWindow: string[],
  refDate: Date,
  halfLifeDays: number,
): { f1: number; sliceBreakdown: SliceCoverage[] } {
  if (edgeItems.length === 0 || allDatesInWindow.length === 0) {
    return { f1: 0, sliceBreakdown: [] };
  }

  const allDatesSet = new Set(allDatesInWindow);
  let totalWeightedNum = 0;
  let totalWeightedDen = 0;
  const sliceBreakdown: SliceCoverage[] = [];

  for (const item of edgeItems) {
    // Only genuinely MISSING dates count as coverage gaps.
    // 'stale' or 'db_missing' windows have data that needs refresh — still "covered".
    const missingDates = new Set<string>();
    for (const w of item.windows) {
      if (w.reason !== 'missing') continue;
      for (const d of expandWindowToDates(w)) {
        missingDates.add(d);
      }
    }

    // Covered dates = all dates in window minus missing
    const coveredDates = new Set<string>();
    let coveredCount = 0;
    for (const d of allDatesInWindow) {
      if (!missingDates.has(d)) {
        coveredDates.add(d);
        coveredCount++;
      }
    }

    const sliceCov = weightedCoverage(coveredDates, allDatesInWindow, refDate, halfLifeDays);

    // Accumulate into overall f₁
    for (const d of allDatesInWindow) {
      const w = recencyWeight(d, refDate, halfLifeDays);
      totalWeightedDen += w;
      if (coveredDates.has(d)) totalWeightedNum += w;
    }

    // Build a meaningful label: prefer sliceFamily (e.g. "context(channel:paid-search)"),
    // fall back to mode (e.g. "window" or "cohort") so the hover preview isn't just "(all)".
    const label = item.sliceFamily || item.mode || '(all)';
    sliceBreakdown.push({
      label,
      coverage: sliceCov,
      coveredDays: coveredCount,
      totalDays: allDatesInWindow.length,
    });
  }

  const f1 = totalWeightedDen > 0 ? totalWeightedNum / totalWeightedDen : 0;

  // Sort slices by coverage ascending (weakest first)
  sliceBreakdown.sort((a, b) => a.coverage - b.coverage);

  return { f1, sliceBreakdown };
}

/**
 * Compute f₂ (snapshot coverage) for a single edge.
 * Recency-weighted: recent days matter more.
 */
function computeF2(
  snapshotDays: string[],
  allDatesInWindow: string[],
  refDate: Date,
  halfLifeDays: number,
): number {
  if (allDatesInWindow.length === 0) return 0;
  const snapSet = new Set(snapshotDays);
  return weightedCoverage(snapSet, allDatesInWindow, refDate, halfLifeDays);
}

/**
 * Compute f₃ (sample size adequacy) for a single edge.
 * Hyperbolic: f₃ = n / (n + n_median).  0.5 at the median, asymptotes to 1.
 */
function computeF3(n: number, nMedian: number): number {
  if (n <= 0 || nMedian <= 0) return 0;
  return n / (n + nMedian);
}

// ── Public API ─────────────────────────────────────────────

export interface DataDepthInput {
  /** The fetch plan for the current DSL */
  plan: FetchPlan;
  /** Per-edge snapshot days: Map<edgeId, UK-format date strings[]> */
  snapshotDaysByEdge: Map<string, string[]>;
  /** All edges in the graph */
  edges: GraphEdge[];
  /** All dates in the DSL window (UK-format strings, sorted) */
  allDatesInWindow: string[];
  /** Reference "now" for recency weighting */
  referenceNow?: Date;
  /** Override half-life (defaults to RECENCY_HALF_LIFE_DAYS) */
  halfLifeDays?: number;
}

/**
 * Compute composite data depth scores for all edges in a graph.
 *
 * Returns a Map from edge UUID to DataDepthScore.
 */
export function computeDataDepthScores(input: DataDepthInput): Map<string, DataDepthScore> {
  const {
    plan,
    snapshotDaysByEdge,
    edges,
    allDatesInWindow,
    referenceNow = new Date(),
    halfLifeDays = RECENCY_HALF_LIFE_DAYS,
  } = input;

  const scores = new Map<string, DataDepthScore>();

  // Compute n_median from edges that have parameter data
  const nValues = edges
    .filter(e => !!(e.p?.id || (e.p as any)?.parameter_id))
    .map(e => e.p?.evidence?.n ?? 0)
    .filter(n => n > 0);
  const nMedian = median(nValues);

  // Index fetch plan items by edge UUID (targetId)
  const itemsByEdge = new Map<string, FetchPlanItem[]>();
  for (const item of plan.items) {
    if (item.type !== 'parameter') continue;
    const existing = itemsByEdge.get(item.targetId) ?? [];
    existing.push(item);
    itemsByEdge.set(item.targetId, existing);
  }

  for (const edge of edges) {
    const edgeId = edge.uuid ?? edge.id ?? '';
    if (!edgeId) continue;

    // Skip edges without parameter data — they have nothing to measure.
    // They'll render as grey (no-data) rather than alarming red.
    const hasParam = !!(edge.p?.id || (edge.p as any)?.parameter_id);
    if (!hasParam) continue;

    const edgeItems = itemsByEdge.get(edgeId) ?? [];
    const snapshotDays = snapshotDaysByEdge.get(edgeId) ?? [];
    const n = edge.p?.evidence?.n ?? 0;

    const { f1, sliceBreakdown } = computeF1ForEdge(
      edgeItems, allDatesInWindow, referenceNow, halfLifeDays,
    );
    const f2 = computeF2(snapshotDays, allDatesInWindow, referenceNow, halfLifeDays);
    const f3 = computeF3(n, nMedian);

    // Weighted-average composite
    const depth = W_DATE_COVERAGE * f1 + W_SNAPSHOT_COVERAGE * f2 + W_SAMPLE_SIZE * f3;

    scores.set(edgeId, { depth, f1, f2, f3, sliceBreakdown });
  }

  return scores;
}

// ── Colour mapping ─────────────────────────────────────────

/** Colour ramp: 0 (red/sparse) → 1 (blue/rich). */
const RAMP_STOPS = [
  { t: 0.0, dark: [248, 113, 113], light: [239, 68, 68] },    // red
  { t: 0.25, dark: [251, 146, 60], light: [249, 115, 22] },   // orange
  { t: 0.5, dark: [250, 204, 21], light: [234, 179, 8] },     // yellow
  { t: 0.75, dark: [125, 211, 252], light: [56, 189, 248] },  // light blue
  { t: 1.0, dark: [59, 130, 246], light: [37, 99, 235] },     // blue
];

const NO_DATA_DARK = '#6b7280';
const NO_DATA_LIGHT = '#9ca3af';

/**
 * Map a depth score [0, 1] to a colour string.
 * Returns the no-data colour for null/undefined scores.
 */
export function depthToColour(
  depth: number | null | undefined,
  theme: 'light' | 'dark' = 'dark',
): string {
  if (depth == null || depth < 0) {
    return theme === 'dark' ? NO_DATA_DARK : NO_DATA_LIGHT;
  }
  const t = Math.min(Math.max(depth, 0), 1);
  const key = theme === 'dark' ? 'dark' : 'light';

  // Find the two stops bracketing t
  for (let i = 0; i < RAMP_STOPS.length - 1; i++) {
    const s0 = RAMP_STOPS[i];
    const s1 = RAMP_STOPS[i + 1];
    if (t >= s0.t && t <= s1.t) {
      const frac = (t - s0.t) / (s1.t - s0.t);
      const c0 = s0[key];
      const c1 = s1[key];
      const r = Math.round(c0[0] + frac * (c1[0] - c0[0]));
      const g = Math.round(c0[1] + frac * (c1[1] - c0[1]));
      const b = Math.round(c0[2] + frac * (c1[2] - c0[2]));
      return `rgb(${r}, ${g}, ${b})`;
    }
  }

  // Fallback to last stop
  const last = RAMP_STOPS[RAMP_STOPS.length - 1][key];
  return `rgb(${last[0]}, ${last[1]}, ${last[2]})`;
}

/** No-data colour accessor for legend. */
export function noDataColour(theme: 'light' | 'dark' = 'dark'): string {
  return theme === 'dark' ? NO_DATA_DARK : NO_DATA_LIGHT;
}

// ── Formatting helpers ─────────────────────────────────────

/** Format a number compactly (e.g. 12400 → '12.4k'). */
export function formatN(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** Format a coverage fraction as percentage string. */
export function formatPct(f: number): string {
  return `${Math.round(f * 100)}%`;
}

/** Build a concise bead label from a depth score (shown on edge in overlay mode). */
export function depthBeadLabel(score: DataDepthScore, n: number): string {
  return `${formatPct(score.depth)}  dates ${formatPct(score.f1)} · snaps ${formatPct(score.f2)} · n ${formatPct(score.f3)} (${formatN(n)})`;
}

// ── Hover tab row builder ──────────────────────────────────

export interface DataDepthInfoRow {
  tab: string;
  section: string;
  property: string;
  value: string;
  /** RAG indicator: maps to freshnessColour in the info card renderer. */
  freshness?: string;
}

/** Map a coverage/adequacy fraction [0,1] to a RAG level. */
function ragLevel(f: number): 'good' | 'stale' | 'very-stale' {
  if (f >= 0.7) return 'good';
  if (f >= 0.4) return 'stale';
  return 'very-stale';
}

/**
 * Build data-depth info rows for the edge hover preview tab.
 * Returns rows compatible with the localAnalysisComputeService data[] format.
 */
export function buildDataDepthInfoRows(
  score: DataDepthScore,
  n: number,
  k?: number,
  nMedian?: number,
): DataDepthInfoRow[] {
  const rows: DataDepthInfoRow[] = [];

  // Coverage summary (RAG-coloured)
  rows.push({ tab: 'depth', section: 'Coverage', property: 'Composite', value: formatPct(score.depth), freshness: ragLevel(score.depth) });
  rows.push({ tab: 'depth', section: 'Coverage', property: 'Date Coverage (f₁)', value: formatPct(score.f1), freshness: ragLevel(score.f1) });
  rows.push({ tab: 'depth', section: 'Coverage', property: 'Snapshot Coverage (f₂)', value: formatPct(score.f2), freshness: ragLevel(score.f2) });
  rows.push({ tab: 'depth', section: 'Coverage', property: 'n Adequacy (f₃)', value: formatPct(score.f3), freshness: ragLevel(score.f3) });

  // Sample size
  rows.push({ tab: 'depth', section: 'Sample Size', property: 'n', value: formatN(n) });
  if (k != null && n > 0) {
    rows.push({ tab: 'depth', section: 'Sample Size', property: 'k', value: formatN(k) });
    rows.push({ tab: 'depth', section: 'Sample Size', property: 'Observed Rate', value: `${(k / n * 100).toFixed(1)}%` });
  }
  if (nMedian != null && nMedian > 0) {
    rows.push({ tab: 'depth', section: 'Sample Size', property: 'Graph Median n', value: formatN(nMedian) });
  }

  // Per-slice breakdown (sorted weakest-first)
  if (score.sliceBreakdown.length > 0) {
    for (const slice of score.sliceBreakdown) {
      rows.push({
        tab: 'depth',
        section: 'By Slice',
        property: slice.label,
        value: `${formatPct(slice.coverage)} (${slice.coveredDays}/${slice.totalDays} days)`,
        freshness: ragLevel(slice.coverage),
      });
    }
  }

  return rows;
}
