/**
 * As-at (asat) historical query support functions.
 *
 * Provides signature selection for asat queries, virtual snapshot → time-series
 * conversion, asat warning policy, and dense snapshot row construction for DB writes.
 *
 * Extracted from dataOperationsService.ts (Cluster E) during slimdown.
 */

import type { TimeSeriesPoint } from '../../types';
import type { VirtualSnapshotRow, SnapshotRow } from '../snapshotWriteService';
import { isCohortModeValue } from '../windowAggregationService';
import { normalizeDate, parseDate } from '../windowAggregationService';
import { normaliseSliceKeyForMatching } from '../../lib/sliceKeyNormalisation';
import { parseConstraints } from '../../lib/queryDSL';
import { parseUKDate } from '../../lib/dateFormat';
import { contextRegistry } from '../contextRegistry';
import { batchableToast, batchableToastError } from './batchMode';

// =============================================================================
// asat() Historical Query Support
// =============================================================================

export function selectQuerySignatureForAsat(args: {
  values: any[];
  mode: 'window' | 'cohort';
}): string | undefined {
  const { values, mode } = args;
  const withSig = (Array.isArray(values) ? values : []).filter(
    (v) => typeof v?.query_signature === 'string' && v.query_signature.trim()
  );
  if (withSig.length === 0) return undefined;

  // Prefer signatures from values matching the requested mode (window vs cohort).
  const modeFiltered = withSig.filter((v) => (mode === 'cohort' ? isCohortModeValue(v) : !isCohortModeValue(v)));
  if (modeFiltered.length === 0) return undefined;
  const candidates = modeFiltered;

  // Prefer the most recent signature by retrieved_at / relevant window/cohort bounds.
  const getTs = (v: any) => String(
    v?.data_source?.retrieved_at ||
    (mode === 'cohort' ? (v?.cohort_to || v?.cohort_from) : (v?.window_to || v?.window_from)) ||
    v?.window_to || v?.cohort_to || v?.window_from || v?.cohort_from ||
    ''
  );
  candidates.sort((a, b) => getTs(b).localeCompare(getTs(a)));
  return String(candidates[0].query_signature);
}

/**
 * Convert virtual snapshot rows to TimeSeriesPoint format.
 * Virtual snapshot rows come from the DB with lowercase column names (x, y, a).
 * TimeSeriesPoint uses n, k, p.
 */
export function convertVirtualSnapshotToTimeSeries(
  rows: VirtualSnapshotRow[],
  sliceKey: string,
  options?: { workspace?: { repository: string; branch: string } }
): TimeSeriesPoint[] {
  const requestedNorm = normaliseSliceKeyForMatching(sliceKey);

  // 1) Exact slice match (normal path)
  const exact = rows.filter((row) => row.slice_key === sliceKey);
  const toPoints = (filtered: VirtualSnapshotRow[]): TimeSeriesPoint[] => {
    return filtered
      .map((row) => {
        const n = row.x ?? 0;
        const k = row.y ?? 0;
        const p = n > 0 ? k / n : 0;
        return {
          date: row.anchor_day,
          n,
          k,
          p,
          median_lag_days: row.median_lag_days ?? undefined,
          mean_lag_days: row.mean_lag_days ?? undefined,
          anchor_median_lag_days: row.anchor_median_lag_days ?? undefined,
          anchor_mean_lag_days: row.anchor_mean_lag_days ?? undefined,
        } as TimeSeriesPoint;
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  };

  if (exact.length > 0) return toPoints(exact);

  // 1b) Normalised slice-family match (ignore window/cohort args)
  if (requestedNorm) {
    const normMatch = rows.filter((row) => normaliseSliceKeyForMatching(row.slice_key) === requestedNorm);
    if (normMatch.length > 0) return toPoints(normMatch);
  }

  // 2) Implicit uncontexted aggregation:
  // If query sliceKey is '' (uncontexted) but DB returns only contexted MECE slices,
  // attempt to aggregate across slices (sum X/Y per day) after MECE validation.
  const modeOnly = requestedNorm === 'window()' || requestedNorm === 'cohort()';
  const allowImplicitAggregation = sliceKey === '' || modeOnly;
  if (!allowImplicitAggregation) return [];

  // If caller requested a mode-only selector, restrict to that mode.
  const rowsForAggregation = modeOnly
    ? rows.filter((r) => normaliseSliceKeyForMatching(r.slice_key).endsWith(requestedNorm))
    : rows;

  const nonEmptyRows = rowsForAggregation.filter((r) => typeof r.slice_key === 'string' && r.slice_key.trim().length > 0);
  if (nonEmptyRows.length === 0) return [];

  // Determine the implied context key (support single-dimension MECE only).
  const sliceKeysUnique = Array.from(new Set(nonEmptyRows.map((r) => r.slice_key)));
  const parsedPairs = sliceKeysUnique.map((sk) => {
    try {
      const parsed = parseConstraints(sk);
      const ctx = parsed.context || [];
      if (ctx.length !== 1) return null;
      return { sliceDSL: sk, key: ctx[0].key, value: ctx[0].value };
    } catch {
      return null;
    }
  }).filter(Boolean) as Array<{ sliceDSL: string; key: string; value: string }>;

  if (parsedPairs.length !== sliceKeysUnique.length) return [];
  const keys = Array.from(new Set(parsedPairs.map((p) => p.key)));
  if (keys.length !== 1) return [];
  const contextKey = keys[0];

  const mece = contextRegistry.detectMECEPartitionSync(
    parsedPairs.map((p) => ({ sliceDSL: p.sliceDSL })),
    contextKey,
    options?.workspace ? { workspace: options.workspace } : undefined
  );
  if (!mece.canAggregate) return [];

  // Aggregate across all slices for each anchor_day.
  const byDay = new Map<string, { n: number; k: number }>();
  for (const r of nonEmptyRows) {
    const prev = byDay.get(r.anchor_day) || { n: 0, k: 0 };
    prev.n += r.x ?? 0;
    prev.k += r.y ?? 0;
    byDay.set(r.anchor_day, prev);
  }

  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({
      date,
      n: v.n,
      k: v.k,
      p: v.n > 0 ? v.k / v.n : 0,
    }));
}

/**
 * Fire warnings for asat() queries per the warning policy.
 *
 * - Warn A: Snapshot freshness (if latest_retrieved_at_used is > 24h before asat date)
 * - Warn B: Missing anchor_to coverage (if has_anchor_to is false)
 */
export function fireAsatWarnings(
  asAtDate: string,
  latestRetrievedAt: string | null,
  hasAnchorTo: boolean,
  anchorToStr: string,
  entityLabel: string
): void {
  // Warn A: Snapshot freshness
  if (latestRetrievedAt) {
    // Policy (docs/current/project-db/3-asat.md §1.3 + §6.3):
    // Treat a date-only asat(d-MMM-yy) token as "end of that day" in UTC.
    const asAtDateObj = parseUKDate(asAtDate);
    asAtDateObj.setUTCHours(23, 59, 59, 999);
    const latestRetrievedObj = new Date(latestRetrievedAt);

    // Calculate hours difference
    const hoursDiff = (asAtDateObj.getTime() - latestRetrievedObj.getTime()) / (1000 * 60 * 60);

    if (hoursDiff > 24) {
      batchableToast(`Historical data for ${entityLabel} uses snapshot from ${latestRetrievedAt.split('T')[0]} (${Math.floor(hoursDiff / 24)} days before requested asat date)`, {
        icon: '⏱️',
        duration: 6000,
      });
    }
  } else {
    // No snapshot data at all for this asat date
    batchableToastError(`No snapshot data available for ${entityLabel} as-at ${asAtDate}`);
  }

  // Warn B: Missing anchor_to coverage
  if (!hasAnchorTo) {
    batchableToast(`Historical data for ${entityLabel} does not include the window end date ${anchorToStr}`, {
      icon: '⚠️',
      duration: 5000,
    });
  }
}

/**
 * Build dense snapshot rows for DB writes: for every anchor day in each fetched window,
 * ensure a row exists (fill gaps with explicit zeros).
 *
 * This prevents the snapshot DB coverage preflight from interpreting sparse/empty API
 * responses as "never fetched".
 */
export function buildDenseSnapshotRowsForDbWrite(params: {
  allTimeSeriesData: Array<any>;
  actualFetchWindows: Array<{ start: string; end: string }>;
  isCohortQuery: boolean;
  lastOnsetDeltaDays?: number;
}): SnapshotRow[] {
  const { allTimeSeriesData, actualFetchWindows, isCohortQuery, lastOnsetDeltaDays } = params;

  // Index returned points by anchor_day (ISO YYYY-MM-DD) for quick lookup.
  // CRITICAL: Must use ISO format here because the window-iteration loop below
  // generates keys via toISOString().split('T')[0] — format must match.
  const byDay = new Map<string, any>();
  for (const day of allTimeSeriesData || []) {
    if (!day || typeof day.date !== 'string') continue;
    const anchor_day = parseDate(day.date).toISOString().split('T')[0];
    if (!anchor_day) continue;
    // Prefer the richer / larger row if duplicates somehow occur.
    const prev = byDay.get(anchor_day);
    if (!prev) {
      byDay.set(anchor_day, day);
    } else {
      const prevN = Number(prev?.n ?? 0);
      const prevK = Number(prev?.k ?? 0);
      const nextN = Number(day?.n ?? 0);
      const nextK = Number(day?.k ?? 0);
      if (nextN + nextK >= prevN + prevK) {
        byDay.set(anchor_day, day);
      }
    }
  }

  const outByDay = new Map<string, SnapshotRow>();

  for (const fetchWindow of actualFetchWindows || []) {
    let startD: Date;
    let endD: Date;
    try {
      startD = parseDate(normalizeDate(fetchWindow.start));
      endD = parseDate(normalizeDate(fetchWindow.end));
    } catch {
      continue;
    }
    if (Number.isNaN(startD.getTime()) || Number.isNaN(endD.getTime())) continue;

    const currentD = new Date(startD);
    while (currentD <= endD) {
      const anchor_day = currentD.toISOString().split('T')[0];
      const found = byDay.get(anchor_day);

      const row: SnapshotRow = {
        anchor_day,
        X: found ? Number(found.n ?? 0) : 0,
        Y: found ? Number(found.k ?? 0) : 0,
        ...(isCohortQuery ? { A: found ? Number((found as any).anchor_n ?? 0) : 0 } : {}),
        ...(found && (found as any).median_lag_days !== undefined ? { median_lag_days: (found as any).median_lag_days } : {}),
        ...(found && (found as any).mean_lag_days !== undefined ? { mean_lag_days: (found as any).mean_lag_days } : {}),
        ...(found && (found as any).anchor_median_lag_days !== undefined ? { anchor_median_lag_days: (found as any).anchor_median_lag_days } : {}),
        ...(found && (found as any).anchor_mean_lag_days !== undefined ? { anchor_mean_lag_days: (found as any).anchor_mean_lag_days } : {}),
        ...(lastOnsetDeltaDays !== undefined ? { onset_delta_days: lastOnsetDeltaDays } : {}),
      };

      // If overlaps occur, prefer the non-zero / richer row.
      const prev = outByDay.get(anchor_day);
      if (!prev) {
        outByDay.set(anchor_day, row);
      } else {
        const prevX = Number(prev.X ?? 0);
        const prevY = Number(prev.Y ?? 0);
        const nextX = Number(row.X ?? 0);
        const nextY = Number(row.Y ?? 0);
        if (nextX + nextY >= prevX + prevY) outByDay.set(anchor_day, row);
      }

      // CRITICAL: UTC iteration to avoid DST/local-time drift.
      currentD.setUTCDate(currentD.getUTCDate() + 1);
    }
  }

  return [...outByDay.values()].sort((a, b) => a.anchor_day.localeCompare(b.anchor_day));
}
