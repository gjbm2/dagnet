/**
 * RED TESTS: Context MECE equivalence (param file → graph → param pack)
 *
 * These tests are deliberately outcome-oriented. They define the acceptance criteria
 * for the context MECE work described in:
 * - docs/current/project-lag/context-fix.md
 *
 * They are added BEFORE implementation and are expected to fail when enabled.
 * They are kept skipped until the implementation work begins, then progressively un-skipped.
 *
 * No external HTTP is used here: we test the "from-file" pipeline end-to-end.
 *
 * @vitest-environment node
 */
/// <reference types="node" />
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileRegistry } from '../../contexts/TabContext';
import type { Graph } from '../../types';
import { fetchDataService, createFetchItem, type FetchItem } from '../fetchDataService';
import { extractParamsFromGraph } from '../GraphParamExtractor';
import { flattenParams } from '../ParamPackDSLService';

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

function makeLatencyGraph(edgeId: string, paramId: string): Graph {
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
    currentQueryDSL: 'cohort(A,1-Dec-25:3-Dec-25)',
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
      expect(Math.abs(av - bv), `Key ${k} differs: ${av} vs ${bv}`).toBeLessThanOrEqual(tol);
    } else {
      expect(av, `Key ${k} differs`).toEqual(bv);
    }
  }
}

describe.skip('RED: MECE context slices should be an implicit uncontexted truth (forecast + evidence)', () => {
  beforeAll(async () => {
    // ensure isolated registry state
    await fileRegistry.clear();
  });

  afterAll(async () => {
    await fileRegistry.clear();
  });

  it('uncontexted cohort() query produces identical param packs: explicit uncontexted baseline vs MECE-only context slices', async () => {
    const edgeId = 'edge-A-B';

    // ----------------------------------------------------------------------------
    // World definition: two MECE channels (google/meta) over 3 days.
    //
    // Cohort evidence totals (expected):
    // - per day: N = 100+50 = 150, K = 20+10 = 30  => p = 0.2
    // Forecast baseline (window) totals (expected):
    // - per day: N = 200+100 = 300, K = 60+20 = 80 => p = 0.266666...
    //
    // We encode File A to reflect these expected uncontexted aggregates explicitly.
    // File B encodes only the contexted slices and must implicitly reproduce the same result.
    // ----------------------------------------------------------------------------

    const cohortDates = ['1-Dec-25', '2-Dec-25', '3-Dec-25'];
    const windowDates = ['1-Dec-25', '2-Dec-25', '3-Dec-25'];

    const baselineParamId = 'mece-baseline-explicit';
    const meceOnlyParamId = 'mece-baseline-mece-only';

    const fileA: ParamFile = {
      id: baselineParamId,
      type: 'probability',
      values: [
        // Explicit uncontexted COHORT slice
        {
          sliceDSL: 'cohort(A,1-Dec-25:3-Dec-25)',
          cohort_from: '1-Dec-25',
          cohort_to: '3-Dec-25',
          dates: cohortDates,
          n_daily: [150, 150, 150],
          k_daily: [30, 30, 30],
          n: 450,
          k: 90,
          mean: 0.2,
          // Lag moments (simple constants) — the implicit MECE aggregator must reproduce these.
          // For the RED test contract, we assume conversion-weighted mean and a deterministic median rule.
          median_lag_days: [2, 2, 2],
          mean_lag_days: [3, 3, 3],
          anchor_median_lag_days: [1, 1, 1],
          anchor_mean_lag_days: [1.5, 1.5, 1.5],
          data_source: { type: 'amplitude', retrieved_at: '17-Dec-25T00:00:00.000Z' },
        },
        // Explicit uncontexted WINDOW slice (forecast baseline source)
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
          // forecast scalar present (used for cohort forecast)
          forecast: 80 / 300,
          data_source: { type: 'amplitude', retrieved_at: '17-Dec-25T00:00:00.000Z' },
        },
      ],
    };

    const fileB: ParamFile = {
      id: meceOnlyParamId,
      type: 'probability',
      values: [
        // Cohort slices (contexted, MECE)
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
          sliceDSL: 'cohort(A,1-Dec-25:3-Dec-25).context(channel:meta)',
          cohort_from: '1-Dec-25',
          cohort_to: '3-Dec-25',
          dates: cohortDates,
          n_daily: [50, 50, 50],
          k_daily: [10, 10, 10],
          n: 150,
          k: 30,
          mean: 0.2,
          median_lag_days: [2, 2, 2],
          mean_lag_days: [3, 3, 3],
          anchor_median_lag_days: [1, 1, 1],
          anchor_mean_lag_days: [1.5, 1.5, 1.5],
          data_source: { type: 'amplitude', retrieved_at: '17-Dec-25T00:00:00.000Z' },
        },

        // Window slices (contexted, MECE)
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
          data_source: { type: 'amplitude', retrieved_at: '17-Dec-25T00:00:00.000Z' },
        },
      ],
    };

    await registerParameterFile(baselineParamId, fileA);
    await registerParameterFile(meceOnlyParamId, fileB);

    // Run A
    let graphA: Graph | null = makeLatencyGraph(edgeId, baselineParamId);
    const setGraphA = (g: Graph | null) => { graphA = g; };
    const itemsA: FetchItem[] = [createFetchItem('parameter', baselineParamId, edgeId)];
    const dsl = 'cohort(A,1-Dec-25:3-Dec-25)';
    const resultsA = await fetchDataService.fetchItems(itemsA, { mode: 'from-file' }, graphA as Graph, setGraphA, dsl, () => graphA);
    expect(resultsA.every(r => r.success)).toBe(true);
    const packA = flattenParams(extractParamsFromGraph(graphA as any));

    // Run B
    let graphB: Graph | null = makeLatencyGraph(edgeId, meceOnlyParamId);
    const setGraphB = (g: Graph | null) => { graphB = g; };
    const itemsB: FetchItem[] = [createFetchItem('parameter', meceOnlyParamId, edgeId)];
    const resultsB = await fetchDataService.fetchItems(itemsB, { mode: 'from-file' }, graphB as Graph, setGraphB, dsl, () => graphB);
    expect(resultsB.every(r => r.success)).toBe(true);
    const packB = flattenParams(extractParamsFromGraph(graphB as any));

    const aEdgePack = toEdgePack(packA, edgeId);
    const bEdgePack = toEdgePack(packB, edgeId);

    // Contract: identical edge param pack outputs (or within tight tolerance) for MECE-only vs explicit baseline.
    // This is expected to FAIL until implicit MECE aggregation exists for BOTH:
    // - cohort evidence (Σk/Σn across cohort slices)
    // - cohort forecast baseline (derived from summed window slices when no uncontexted window baseline exists)
    expectPacksClose(aEdgePack, bEdgePack, 1e-9);
  });
});


