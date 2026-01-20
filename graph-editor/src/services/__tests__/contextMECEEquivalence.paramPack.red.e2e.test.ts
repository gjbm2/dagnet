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
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { fileRegistry } from '../../contexts/TabContext';
import type { Graph } from '../../types';
import { fetchDataService, createFetchItem, type FetchItem } from '../fetchDataService';
import { extractParamsFromGraph } from '../GraphParamExtractor';
import { flattenParams } from '../ParamPackDSLService';
import { contextRegistry } from '../contextRegistry';
import { extractSliceDimensions } from '../sliceIsolation';

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
      const tolForKey =
        k.endsWith('.p.stdev') || k.endsWith('.p.evidence.stdev')
          ? 1e-4 // stdev is often rounded in the pipeline; keep tight but realistic
          : tol;
      const extra =
        k.endsWith('.p.mean')
          ? `\nA: ${JSON.stringify(
              {
                mean: a[k],
                evidenceMean: a[k.replace('.p.mean', '.p.evidence.mean')],
                evidenceN: a[k.replace('.p.mean', '.p.evidence.n')],
                evidenceK: a[k.replace('.p.mean', '.p.evidence.k')],
                forecastMean: a[k.replace('.p.mean', '.p.forecast.mean')],
                completeness: a[k.replace('.p.mean', '.p.latency.completeness')],
                t95: a[k.replace('.p.mean', '.p.latency.t95')],
              },
              null,
              0
            )}\nB: ${JSON.stringify(
              {
                mean: b[k],
                evidenceMean: b[k.replace('.p.mean', '.p.evidence.mean')],
                evidenceN: b[k.replace('.p.mean', '.p.evidence.n')],
                evidenceK: b[k.replace('.p.mean', '.p.evidence.k')],
                forecastMean: b[k.replace('.p.mean', '.p.forecast.mean')],
                completeness: b[k.replace('.p.mean', '.p.latency.completeness')],
                t95: b[k.replace('.p.mean', '.p.latency.t95')],
              },
              null,
              0
            )}`
          : '';
      expect(Math.abs(av - bv), `Key ${k} differs: ${av} vs ${bv}${extra}`).toBeLessThanOrEqual(tolForKey);
    } else {
      expect(av, `Key ${k} differs`).toEqual(bv);
    }
  }
}

describe('MECE context slices should be an implicit uncontexted truth (forecast + evidence)', () => {
  beforeAll(async () => {
    // ensure isolated registry state
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fr: any = fileRegistry as any;
    if (typeof fr.clear === 'function') {
      await fr.clear();
    } else if (fr._files?.clear) {
      fr._files.clear();
    } else if (fr.files?.clear) {
      fr.files.clear();
    }

    // Declare the MECE context used by this test (channel) so MECE aggregation is enabled in node env.
    // IMPORTANT: sync MECE detection reads ContextRegistry cache/FileRegistry, not getContext(), so we must seed cache.
    contextRegistry.clearCache();
    (contextRegistry as any).cache.set('channel', {
      id: 'channel',
      name: 'Channel',
      description: 'Test',
      type: 'categorical',
      otherPolicy: 'null',
      values: [
        { id: 'google', label: 'Google' },
        { id: 'meta', label: 'Meta' },
      ],
      metadata: {
        created_at: '17-Dec-25',
        version: '1.0.0',
        status: 'active',
      },
    });
  });

  afterAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fr: any = fileRegistry as any;
    if (typeof fr.clear === 'function') {
      await fr.clear();
    } else if (fr._files?.clear) {
      fr._files.clear();
    } else if (fr.files?.clear) {
      fr.files.clear();
    }
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

    // Sanity: slice dimension extraction must see the context dimension for contexted window slices
    expect(extractSliceDimensions('window(1-Dec-25:3-Dec-25).context(channel:google)')).toBe('context(channel:google)');
    expect(extractSliceDimensions('cohort(A,1-Dec-25:3-Dec-25).context(channel:meta)')).toBe('context(channel:meta)');

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

    // Debug: print the high-signal fields when comparing (helps diagnose MECE vs explicit mismatches)
    console.log('[MECE_EQ_DEBUG] A', {
      mean: aEdgePack[`e.${edgeId}.p.mean`],
      evidenceMean: aEdgePack[`e.${edgeId}.p.evidence.mean`],
      evidenceN: aEdgePack[`e.${edgeId}.p.evidence.n`],
      evidenceK: aEdgePack[`e.${edgeId}.p.evidence.k`],
      forecastMean: aEdgePack[`e.${edgeId}.p.forecast.mean`],
      completeness: aEdgePack[`e.${edgeId}.p.latency.completeness`],
      t95: aEdgePack[`e.${edgeId}.p.latency.t95`],
      pathT95: aEdgePack[`e.${edgeId}.p.latency.path_t95`],
      medianLag: aEdgePack[`e.${edgeId}.p.latency.median_lag_days`],
    });
    console.log('[MECE_EQ_DEBUG] B', {
      mean: bEdgePack[`e.${edgeId}.p.mean`],
      evidenceMean: bEdgePack[`e.${edgeId}.p.evidence.mean`],
      evidenceN: bEdgePack[`e.${edgeId}.p.evidence.n`],
      evidenceK: bEdgePack[`e.${edgeId}.p.evidence.k`],
      forecastMean: bEdgePack[`e.${edgeId}.p.forecast.mean`],
      completeness: bEdgePack[`e.${edgeId}.p.latency.completeness`],
      t95: bEdgePack[`e.${edgeId}.p.latency.t95`],
      pathT95: bEdgePack[`e.${edgeId}.p.latency.path_t95`],
      medianLag: bEdgePack[`e.${edgeId}.p.latency.median_lag_days`],
    });

    // Contract: identical edge param pack outputs (or within tight tolerance) for MECE-only vs explicit baseline.
    // This is expected to FAIL until implicit MECE aggregation exists for BOTH:
    // - cohort evidence (Σk/Σn across cohort slices)
    // - cohort forecast baseline (derived from summed window slices when no uncontexted window baseline exists)
    expectPacksClose(aEdgePack, bEdgePack, 1e-9);
  });
});


