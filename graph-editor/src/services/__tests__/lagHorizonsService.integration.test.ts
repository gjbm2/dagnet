/**
 * lagHorizonsService + fetchDataService integration tests (horizons contract)
 *
 * Contract (anti-floatiness):
 * - Ordinary Stage‑2 passes MUST NOT write t95/path_t95 onto the graph unless explicitly opted in.
 * - Explicit "recompute horizons" MUST recompute from file-backed slice data, respecting override flags,
 *   and persist horizons back to parameter files.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

import type { Graph } from '../../types';
import { db } from '../../db/appDatabase';
import { fileRegistry } from '../../contexts/TabContext';
import { createFetchItem, fetchDataService } from '../fetchDataService';
import { lagHorizonsService } from '../lagHorizonsService';
import { fitLagDistribution, logNormalInverseCDF } from '../lagDistributionUtils';
import { LATENCY_T95_PERCENTILE } from '../../constants/latency';
import { RECENCY_HALF_LIFE_DAYS } from '../../constants/latency';
import { parseDate } from '../windowAggregationService';
import { sessionLogService } from '../sessionLogService';

/**
 * Helper: produce a UK-format date string (d-MMM-yy) for N days before today (UTC).
 * Keeps test fixtures immune to calendar drift vs LATENCY_FE_FIT_LEFT_CENSOR_DAYS.
 */
function daysAgoUK(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  const day = d.getUTCDate();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[d.getUTCMonth()];
  const year = String(d.getUTCFullYear()).slice(-2);
  return `${day}-${month}-${year}`;
}

async function hardResetState(): Promise<void> {
  await Promise.all([
    db.workspaces.clear(),
    db.files.clear(),
    db.tabs.clear(),
    db.scenarios.clear(),
    db.appState.clear(),
    db.settings.clear(),
    db.credentials.clear(),
  ]);
  try {
    const map = (fileRegistry as any).files as Map<string, any> | undefined;
    map?.clear();
  } catch {
    // ignore
  }
  try {
    const map = (fileRegistry as any)._files as Map<string, any> | undefined;
    map?.clear();
  } catch {
    // ignore
  }
}

async function registerFileForTest(fileId: string, type: any, data: any): Promise<void> {
  await fileRegistry.registerFile(fileId, {
    fileId,
    type,
    data,
    originalData: structuredClone(data),
    isDirty: false,
    isInitializing: false,
    source: { repository: 'test', branch: 'main', isLocal: true } as any,
    viewTabs: [],
    lastModified: Date.now(),
  } as any);
}

function makeCohortSlice(args: { start: string; end: string; medianLagDays: number; totalK: number }) {
  // NOTE: computeT95() only uses the fitted distribution when empirical_quality_ok=true.
  // That requires totalK >= LATENCY_MIN_FIT_CONVERTERS; otherwise t95 falls back to DEFAULT_T95_DAYS.
  //
  // For deterministic tests, we use mean==median so σ=0 and t95==median (for any percentile).
  const dates = [args.start, args.end];
  const n_daily = [100, 100];
  const k0 = Math.floor(args.totalK / 2);
  const k1 = args.totalK - k0;
  const k_daily = [k0, k1];
  return {
    sliceDSL: `cohort(${args.start}:${args.end})`,
    dates,
    n: n_daily.reduce((a, b) => a + b, 0),
    k: k_daily.reduce((a, b) => a + b, 0),
    n_daily,
    k_daily,
    median_lag_days: [args.medianLagDays, args.medianLagDays],
    mean_lag_days: [args.medianLagDays, args.medianLagDays],
    mean: (k_daily.reduce((a, b) => a + b, 0) / n_daily.reduce((a, b) => a + b, 0)) || 0,
    data_source: { retrieved_at: '2025-12-10T00:00:00Z', type: 'test' },
  };
}

describe('lag horizons contract (integration)', () => {
  beforeEach(async () => {
    await hardResetState();
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('ordinary Stage‑2 updates completeness but does NOT write horizons onto graph by default', async () => {
    // Use dynamic dates to stay within LATENCY_FE_FIT_LEFT_CENSOR_DAYS
    const cohortStart = daysAgoUK(30);
    const cohortEnd = daysAgoUK(29);

    const paramId = 'p1';
    await registerFileForTest(`parameter-${paramId}`, 'parameter', {
      id: paramId,
      type: 'probability',
      latency: { latency_parameter: true, t95_overridden: false, path_t95_overridden: false },
      values: [
        makeCohortSlice({ start: cohortStart, end: cohortEnd, medianLagDays: 10, totalK: 50 }),
      ],
    });

    let graphState: Graph = {
      nodes: [{ id: 'A' } as any, { id: 'B' } as any],
      edges: [
        {
          uuid: 'e1',
          id: 'e1',
          from: 'A',
          to: 'B',
          query: 'from(A).to(B)',
          p: {
            id: paramId,
            mean: 0.5,
            latency: {
              latency_parameter: true,
              // Seed horizons (these must NOT be overwritten by ordinary Stage‑2)
              t95: 111,
              path_t95: 222,
              // Seed completeness to prove Stage‑2 did run
              completeness: 0,
              t95_overridden: false,
              path_t95_overridden: false,
            },
          },
        } as any,
      ],
    } as any;

    const setGraph = (g: Graph | null) => {
      if (g) graphState = g;
    };

    const item = createFetchItem('parameter', paramId, 'e1', { paramSlot: 'p' });
    await fetchDataService.fetchItems(
      [item],
      { mode: 'from-file', skipStage2: false },
      graphState,
      setGraph,
      // cohort-mode so Stage‑2 runs LAG topo pass
      `cohort(${cohortStart}:${cohortEnd})`,
      () => graphState
    );

    const edge = graphState.edges?.find((e: any) => e.uuid === 'e1');
    expect(edge?.p?.latency?.completeness).toBeGreaterThan(0);
    expect(edge?.p?.latency?.t95).toBe(111);
    expect(edge?.p?.latency?.path_t95).toBe(222);
  });

  it('recomputeHorizons(global) recomputes from file slice data, writes horizons to graph, and persists to parameter files', async () => {
    const addChildSpy = vi.spyOn(sessionLogService, 'addChild');

    // Use dynamic dates to stay within LATENCY_FE_FIT_LEFT_CENSOR_DAYS
    const cohortStart = daysAgoUK(30);
    const cohortEnd = daysAgoUK(29);

    const paramId = 'p1';
    const medianLagDays = 10;
    const totalK = 1000; // ensure effective (recency-weighted) k remains above fit threshold
    // Match pipeline semantics: the horizon fit may legitimately run with meanLag unavailable,
    // in which case σ defaults and t95 > median.
    const fit = fitLagDistribution(medianLagDays, undefined, totalK);
    const expectedT95 = logNormalInverseCDF(LATENCY_T95_PERCENTILE, fit.mu, fit.sigma);

    await registerFileForTest(`parameter-${paramId}`, 'parameter', {
      id: paramId,
      type: 'probability',
      latency: { latency_parameter: true, t95: 5, path_t95: 5, t95_overridden: false, path_t95_overridden: false },
      values: [
        makeCohortSlice({ start: cohortStart, end: cohortEnd, medianLagDays, totalK }),
      ],
    });

    let graphState: Graph = {
      nodes: [{ id: 'A' } as any, { id: 'B' } as any],
      edges: [
        {
          uuid: 'e1',
          id: 'e1',
          from: 'A',
          to: 'B',
          query: 'from(A).to(B)',
          p: {
            id: paramId,
            mean: 0.5,
            latency: {
              latency_parameter: true,
              // Stale horizons on graph: recompute must NOT treat these as authoritative
              // (lagHorizonsService clears unlocked horizons before recompute).
              t95: 999,
              path_t95: 999,
              t95_overridden: false,
              path_t95_overridden: false,
            },
          },
        } as any,
      ],
    } as any;

    const setGraph = (g: Graph | null) => {
      if (g) graphState = g;
    };

    await lagHorizonsService.recomputeHorizons({
      mode: 'global',
      getGraph: () => graphState as any,
      setGraph: setGraph as any,
      reason: 'test',
    });

    const edge = graphState.edges?.find((e: any) => e.uuid === 'e1');
    expect(edge?.p?.latency?.t95).toBeGreaterThan(0);
    expect(edge?.p?.latency?.path_t95).toBeGreaterThan(0);
    expect(edge?.p?.latency?.t95).not.toBe(999);
    expect(edge?.p?.latency?.path_t95).not.toBe(999);
    // Horizons are rounded when applied to the graph (LATENCY_HORIZON_DECIMAL_PLACES = 2).
    expect(edge?.p?.latency?.t95).toBeCloseTo(expectedT95, 2);

    const updatedFile = fileRegistry.getFile(`parameter-${paramId}`)?.data as any;
    expect(updatedFile?.latency?.t95_overridden).toBe(false);
    expect(updatedFile?.latency?.path_t95_overridden).toBe(false);
    expect(updatedFile?.latency?.t95).toBeCloseTo(edge?.p?.latency?.t95, 12);
    expect(updatedFile?.latency?.path_t95).toBeCloseTo(edge?.p?.latency?.path_t95, 12);

    // Global recompute requests a very wide window; missing-history warnings are expected and should be suppressed.
    expect(addChildSpy.mock.calls.some((c) => c[2] === 'MISSING_DATA')).toBe(false);
  });

  it('recomputeHorizons respects file override flags (locked horizons do not change)', async () => {
    // Use dynamic dates to stay within LATENCY_FE_FIT_LEFT_CENSOR_DAYS
    const cohortStart = daysAgoUK(30);
    const cohortEnd = daysAgoUK(29);

    const paramId = 'p1';
    await registerFileForTest(`parameter-${paramId}`, 'parameter', {
      id: paramId,
      type: 'probability',
      latency: { latency_parameter: true, t95: 12, path_t95: 20, t95_overridden: true, path_t95_overridden: true },
      values: [
        // If recompute ignored overrides, this would move horizons.
        makeCohortSlice({ start: cohortStart, end: cohortEnd, medianLagDays: 30, totalK: 50 }),
      ],
    });

    let graphState: Graph = {
      nodes: [{ id: 'A' } as any, { id: 'B' } as any],
      edges: [
        {
          uuid: 'e1',
          id: 'e1',
          from: 'A',
          to: 'B',
          query: 'from(A).to(B)',
          p: {
            id: paramId,
            mean: 0.5,
            latency: {
              latency_parameter: true,
              t95: 999,
              path_t95: 999,
              t95_overridden: false, // will be hydrated from file
              path_t95_overridden: false, // will be hydrated from file
            },
          },
        } as any,
      ],
    } as any;

    const setGraph = (g: Graph | null) => {
      if (g) graphState = g;
    };

    await lagHorizonsService.recomputeHorizons({
      mode: 'global',
      getGraph: () => graphState as any,
      setGraph: setGraph as any,
      reason: 'test',
    });

    const edge = graphState.edges?.find((e: any) => e.uuid === 'e1');
    // Flags must be hydrated from file for explicit recompute workflow
    expect(edge?.p?.latency?.t95_overridden).toBe(true);
    expect(edge?.p?.latency?.path_t95_overridden).toBe(true);

    // File must remain unchanged because overrides are locked
    const updatedFile = fileRegistry.getFile(`parameter-${paramId}`)?.data as any;
    expect(updatedFile?.latency?.t95).toBe(12);
    expect(updatedFile?.latency?.path_t95).toBe(20);
    expect(updatedFile?.latency?.t95_overridden).toBe(true);
    expect(updatedFile?.latency?.path_t95_overridden).toBe(true);
  });

  it('recomputeHorizons uses the same half-life recency weighting as forecast when computing horizons', async () => {
    const paramId = 'p1';
    // Two cohort-days: one very old with long lag, one recent with short lag.
    // With half-life weighting, the recent cohort should dominate the aggregated lag moments,
    // so t95 should be much closer to 10 than 100.
    //
    // Use dynamic dates so the recent cohort stays within LATENCY_FE_FIT_LEFT_CENSOR_DAYS.
    // The old date is intentionally ancient (its recency weight ≈ 0 and it will be left-censored,
    // but that doesn't affect the result because it contributes negligible weight either way).
    const oldDate = daysAgoUK(4000);
    const recentDate = daysAgoUK(30);

    await registerFileForTest(`parameter-${paramId}`, 'parameter', {
      id: paramId,
      type: 'probability',
      latency: { latency_parameter: true, t95_overridden: false, path_t95_overridden: false },
      values: [
        {
          sliceDSL: `cohort(${oldDate}:${recentDate})`,
          dates: [oldDate, recentDate],
          n: 2000,
          k: 2000,
          n_daily: [1000, 1000],
          k_daily: [1000, 1000],
          median_lag_days: [100, 10],
          mean_lag_days: [100, 10],
          mean: 1,
          data_source: { retrieved_at: '2025-12-10T00:00:00Z', type: 'test' },
        },
      ],
    });

    let graphState: Graph = {
      nodes: [{ id: 'A' } as any, { id: 'B' } as any],
      edges: [
        {
          uuid: 'e1',
          id: 'e1',
          from: 'A',
          to: 'B',
          query: 'from(A).to(B)',
          p: {
            id: paramId,
            mean: 0.5,
            latency: {
              latency_parameter: true,
              t95_overridden: false,
              path_t95_overridden: false,
            },
          },
        } as any,
      ],
    } as any;

    const setGraph = (g: Graph | null) => {
      if (g) graphState = g;
    };

    await lagHorizonsService.recomputeHorizons({
      mode: 'global',
      getGraph: () => graphState as any,
      setGraph: setGraph as any,
      reason: 'test-half-life',
    });

    const edge = graphState.edges?.find((e: any) => e.uuid === 'e1');
    const t95 = edge?.p?.latency?.t95 as number | undefined;
    expect(typeof t95).toBe('number');
    expect(t95!).toBeGreaterThan(0);

    // Compute the exact expected aggregated lag when using forecast-style half-life weights.
    // Use the same date parser as the pipeline (UK d-MMM-yy).
    //
    // NOTE: The pipeline applies LATENCY_FE_FIT_LEFT_CENSOR_DAYS, so the old date
    // is censored out entirely. We mirror that here: only the recent date contributes.
    const asOfDate = new Date();
    const ageDays = (uk: string) =>
      Math.floor((asOfDate.getTime() - parseDate(uk).getTime()) / (24 * 60 * 60 * 1000));
    const w = (age: number) => Math.exp(-Math.LN2 * Math.max(0, age) / RECENCY_HALF_LIFE_DAYS);
    // Old date is left-censored; only the recent date survives.
    const wkOld = 0;
    const wkNew = 1000 * w(ageDays(recentDate));
    const effectiveK = wkOld + wkNew;
    const aggregateMedianLag = (wkOld * 100 + wkNew * 10) / (effectiveK || 1);

    // Expected t95 under the current fit path (meanLag may be absent → default σ).
    const fit = fitLagDistribution(aggregateMedianLag, undefined, effectiveK);
    const expected = logNormalInverseCDF(LATENCY_T95_PERCENTILE, fit.mu, fit.sigma);

    // Horizons are rounded to 2 d.p. in UpdateManager.
    expect(t95!).toBeCloseTo(expected, 2);

  });
});


