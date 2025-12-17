/**
 * Outcome-oriented MECE tests (additive).
 *
 * Covers:
 * 1) Uncontexted window() query: explicit uncontexted baseline vs MECE-only context slices should match.
 * 2) Incomplete MECE partition: MECE-only (missing a slice) must NOT match the explicit uncontexted baseline.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { Graph } from '../../types';
import { fileRegistry } from '../../contexts/TabContext';
import { fetchDataService, createFetchItem, type FetchItem } from '../fetchDataService';
import { extractParamsFromGraph } from '../GraphParamExtractor';
import { flattenParams } from '../ParamPackDSLService';
import { contextRegistry } from '../contextRegistry';

type ParamFile = {
  id: string;
  type: string;
  values: any[];
};

async function registerParameterFile(paramId: string, data: ParamFile): Promise<void> {
  await fileRegistry.registerFile(`parameter-${paramId}`, {
    fileId: `parameter-${paramId}`,
    type: 'parameter',
    data,
    originalData: structuredClone(data),
    isDirty: false,
    isInitializing: false,
    source: { repository: 'test-repo', branch: 'main', isLocal: true } as any,
    viewTabs: [],
    lastModified: Date.now(),
  } as any);
}

function makeLatencyGraph(edgeId: string, paramId: string, currentQueryDSL: string): Graph {
  return {
    nodes: [
      { id: 'A', uuid: 'A', entry: { is_start: true, entry_weight: 1 } } as any,
      { id: 'B', uuid: 'B' } as any,
    ],
    edges: [
      {
        id: edgeId,
        uuid: edgeId,
        from: 'A',
        to: 'B',
        p: {
          id: paramId,
          connection: 'amplitude-test',
          latency: { latency_parameter: true, anchor_node_id: 'A', t95: 7 },
        },
      } as any,
    ],
    currentQueryDSL,
  } as any;
}

function toEdgePack(pack: Record<string, any>, edgeId: string): Record<string, any> {
  const prefix = `e.${edgeId}.p.`;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(pack)) {
    if (k.startsWith(prefix)) out[k] = v;
  }
  return out;
}

function expectPacksClose(a: Record<string, any>, b: Record<string, any>, tol = 1e-9): void {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  expect(aKeys).toEqual(bKeys);

  for (const k of aKeys) {
    const av = a[k];
    const bv = b[k];
    if (typeof av === 'number' && typeof bv === 'number') {
      const tolForKey =
        k.endsWith('.p.stdev') || k.endsWith('.p.evidence.stdev') ? 1e-4 : tol;
      expect(Math.abs(av - bv), `Key ${k} differs: ${av} vs ${bv}`).toBeLessThanOrEqual(tolForKey);
    } else {
      expect(av, `Key ${k} differs`).toEqual(bv);
    }
  }
}

async function resetFileRegistry(): Promise<void> {
  // FileRegistry does not expose a public clear(); use the internal maps in tests.
  // This mirrors other test patterns in the codebase.
  (fileRegistry as any).files?.clear?.();
  (fileRegistry as any).listeners?.clear?.();
}

describe('MECE equivalence: window() and incomplete partitions', () => {
  beforeAll(async () => {
    // Declare the MECE context used by this test (channel) so MECE aggregation is enabled in node env.
    // This is the "user declaration" of MECE via otherPolicy.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (contextRegistry as any).clearCache?.();
    vi.spyOn(contextRegistry, 'getContext').mockImplementation(async (id: string) => {
      if (id !== 'channel') return undefined;
      return {
        id: 'channel',
        label: 'Channel',
        description: 'Test',
        type: 'categorical',
        otherPolicy: 'null',
        values: [
          { id: 'google', label: 'Google' },
          { id: 'meta', label: 'Meta' },
        ],
      } as any;
    });
    await resetFileRegistry();
  });

  beforeEach(async () => {
    await resetFileRegistry();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await resetFileRegistry();
  });

  it('uncontexted window() query produces identical param packs: explicit uncontexted baseline vs MECE-only context slices', async () => {
    const edgeId = 'edge-A-B';
    const dsl = 'window(1-Dec-25:3-Dec-25)';

    const baselineParamId = 'mece-window-explicit';
    const meceOnlyParamId = 'mece-window-mece-only';

    const windowDates = ['1-Dec-25', '2-Dec-25', '3-Dec-25'];

    const fileA: ParamFile = {
      id: baselineParamId,
      type: 'probability',
      values: [
        {
          sliceDSL: 'window(1-Dec-25:3-Dec-25)',
          window_from: '1-Dec-25',
          window_to: '3-Dec-25',
          dates: windowDates,
          n_daily: [300, 300, 300],
          k_daily: [80, 80, 80],
          n: 900,
          k: 240,
          mean: 80 / 300,
          forecast: 80 / 300,
          // Provide lag arrays so LAG can compute completeness + median lag consistently in window mode.
          median_lag_days: [2, 2, 2],
          mean_lag_days: [3, 3, 3],
          data_source: { type: 'amplitude', retrieved_at: '17-Dec-25T00:00:00.000Z' },
        },
      ],
    };

    const fileB: ParamFile = {
      id: meceOnlyParamId,
      type: 'probability',
      values: [
        {
          sliceDSL: 'window(1-Dec-25:3-Dec-25).context(channel:google)',
          window_from: '1-Dec-25',
          window_to: '3-Dec-25',
          dates: windowDates,
          n_daily: [200, 200, 200],
          k_daily: [60, 60, 60],
          n: 600,
          k: 180,
          mean: 0.3,
          forecast: 0.3,
          median_lag_days: [2, 2, 2],
          mean_lag_days: [3, 3, 3],
          data_source: { type: 'amplitude', retrieved_at: '17-Dec-25T00:00:00.000Z' },
        },
        {
          sliceDSL: 'window(1-Dec-25:3-Dec-25).context(channel:meta)',
          window_from: '1-Dec-25',
          window_to: '3-Dec-25',
          dates: windowDates,
          n_daily: [100, 100, 100],
          k_daily: [20, 20, 20],
          n: 300,
          k: 60,
          mean: 0.2,
          forecast: 0.2,
          median_lag_days: [2, 2, 2],
          mean_lag_days: [3, 3, 3],
          data_source: { type: 'amplitude', retrieved_at: '17-Dec-25T00:00:00.000Z' },
        },
      ],
    };

    await registerParameterFile(baselineParamId, fileA);
    await registerParameterFile(meceOnlyParamId, fileB);

    // Run A
    let graphA: Graph | null = makeLatencyGraph(edgeId, baselineParamId, dsl);
    const setGraphA = (g: Graph | null) => {
      graphA = g;
    };
    const itemsA: FetchItem[] = [createFetchItem('parameter', baselineParamId, edgeId)];
    const resultsA = await fetchDataService.fetchItems(itemsA, { mode: 'from-file' }, graphA as Graph, setGraphA, dsl, () => graphA);
    expect(resultsA.every((r) => r.success)).toBe(true);
    const packA = toEdgePack(flattenParams(extractParamsFromGraph(graphA as any)), edgeId);

    // Run B
    let graphB: Graph | null = makeLatencyGraph(edgeId, meceOnlyParamId, dsl);
    const setGraphB = (g: Graph | null) => {
      graphB = g;
    };
    const itemsB: FetchItem[] = [createFetchItem('parameter', meceOnlyParamId, edgeId)];
    const resultsB = await fetchDataService.fetchItems(itemsB, { mode: 'from-file' }, graphB as Graph, setGraphB, dsl, () => graphB);
    expect(resultsB.every((r) => r.success)).toBe(true);
    const packB = toEdgePack(flattenParams(extractParamsFromGraph(graphB as any)), edgeId);

    expectPacksClose(packA, packB, 1e-9);
  });

  it('incomplete MECE partition does not synthesise an equivalent uncontexted result (pack must differ)', async () => {
    const edgeId = 'edge-A-B';
    const dsl = 'cohort(A,1-Dec-25:3-Dec-25)';

    const baselineParamId = 'mece-cohort-explicit';
    const incompleteParamId = 'mece-cohort-incomplete';

    const cohortDates = ['1-Dec-25', '2-Dec-25', '3-Dec-25'];
    const windowDates = ['1-Dec-25', '2-Dec-25', '3-Dec-25'];

    // Explicit baseline (truth): both window + cohort uncontexted
    const fileA: ParamFile = {
      id: baselineParamId,
      type: 'probability',
      values: [
        {
          sliceDSL: 'cohort(A,1-Dec-25:3-Dec-25)',
          cohort_from: '1-Dec-25',
          cohort_to: '3-Dec-25',
          dates: cohortDates,
          n_daily: [150, 150, 150],
          // baseline aggregate mean differs from the single-slice mean to make the incomplete case detectable
          k_daily: [25, 25, 25],
          n: 450,
          k: 75,
          mean: 75 / 450,
          median_lag_days: [2, 2, 2],
          mean_lag_days: [3, 3, 3],
          anchor_median_lag_days: [1, 1, 1],
          anchor_mean_lag_days: [1.5, 1.5, 1.5],
          data_source: { type: 'amplitude', retrieved_at: '17-Dec-25T00:00:00.000Z' },
        },
        {
          sliceDSL: 'window(1-Dec-25:3-Dec-25)',
          window_from: '1-Dec-25',
          window_to: '3-Dec-25',
          dates: windowDates,
          n_daily: [300, 300, 300],
          k_daily: [80, 80, 80],
          n: 900,
          k: 240,
          mean: 80 / 300,
          forecast: 80 / 300,
          data_source: { type: 'amplitude', retrieved_at: '17-Dec-25T00:00:00.000Z' },
        },
      ],
    };

    // Incomplete MECE: only google slice (meta missing) for both cohort + window.
    const fileB: ParamFile = {
      id: incompleteParamId,
      type: 'probability',
      values: [
        {
          sliceDSL: 'cohort(A,1-Dec-25:3-Dec-25).context(channel:google)',
          cohort_from: '1-Dec-25',
          cohort_to: '3-Dec-25',
          dates: cohortDates,
          n_daily: [100, 100, 100],
          k_daily: [20, 20, 20],
          n: 300,
          k: 60,
          mean: 0.2,
          median_lag_days: [2, 2, 2],
          mean_lag_days: [3, 3, 3],
          anchor_median_lag_days: [1, 1, 1],
          anchor_mean_lag_days: [1.5, 1.5, 1.5],
          data_source: { type: 'amplitude', retrieved_at: '17-Dec-25T00:00:00.000Z' },
        },
        {
          sliceDSL: 'window(1-Dec-25:3-Dec-25).context(channel:google)',
          window_from: '1-Dec-25',
          window_to: '3-Dec-25',
          dates: windowDates,
          n_daily: [200, 200, 200],
          k_daily: [60, 60, 60],
          n: 600,
          k: 180,
          mean: 0.3,
          forecast: 0.3,
          data_source: { type: 'amplitude', retrieved_at: '17-Dec-25T00:00:00.000Z' },
        },
      ],
    };

    await registerParameterFile(baselineParamId, fileA);
    await registerParameterFile(incompleteParamId, fileB);

    // Run A
    let graphA: Graph | null = makeLatencyGraph(edgeId, baselineParamId, dsl);
    const setGraphA = (g: Graph | null) => {
      graphA = g;
    };
    const itemsA: FetchItem[] = [createFetchItem('parameter', baselineParamId, edgeId)];
    const resultsA = await fetchDataService.fetchItems(itemsA, { mode: 'from-file' }, graphA as Graph, setGraphA, dsl, () => graphA);
    expect(resultsA.every((r) => r.success)).toBe(true);
    const packA = toEdgePack(flattenParams(extractParamsFromGraph(graphA as any)), edgeId);

    // Run B
    let graphB: Graph | null = makeLatencyGraph(edgeId, incompleteParamId, dsl);
    const setGraphB = (g: Graph | null) => {
      graphB = g;
    };
    const itemsB: FetchItem[] = [createFetchItem('parameter', incompleteParamId, edgeId)];
    const resultsB = await fetchDataService.fetchItems(itemsB, { mode: 'from-file' }, graphB as Graph, setGraphB, dsl, () => graphB);
    expect(resultsB.every((r) => r.success)).toBe(true);
    const packB = toEdgePack(flattenParams(extractParamsFromGraph(graphB as any)), edgeId);

    // Must be materially different due to missing MECE mass.
    // Evidence.mean should differ because the missing slice has a different mean contribution in the baseline.
    const aEvidenceMean = packA[`e.${edgeId}.p.evidence.mean`];
    const bEvidenceMean = packB[`e.${edgeId}.p.evidence.mean`];
    expect(typeof aEvidenceMean).toBe('number');
    expect(typeof bEvidenceMean).toBe('number');
    expect(bEvidenceMean).not.toBeCloseTo(aEvidenceMean, 9);
  });
});


