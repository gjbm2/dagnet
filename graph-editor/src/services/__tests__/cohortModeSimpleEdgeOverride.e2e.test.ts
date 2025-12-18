/**
 * E2E-ish Test: cohort() mode + simple edges should fetch as window()
 *
 * Validates the cohort-view-implementation behaviour:
 * - In a cohort-mode tab, edges with NO local latency and path_t95 == 0
 *   should NOT be retrieved/aggregated using cohort() slices.
 * - Instead, they should be read as window() for the cohort date range.
 *
 * This test asserts that the resulting edge scalars come from the window slice:
 * - p.mean
 * - p.evidence.mean / n / k
 * - p.forecast.mean (from window baseline forecast scalar)
 * - and that no latency block is attached (this is a simple edge).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fetchItem } from '../fetchDataService';
import { fileRegistry } from '../../contexts/TabContext';
import type { Graph } from '../../types';
import { parseDate } from '../windowAggregationService';
import { RECENCY_HALF_LIFE_DAYS } from '../../constants/latency';

vi.mock('../../components/ProgressToast', () => ({
  showProgressToast: vi.fn(),
  completeProgressToast: vi.fn(),
}));

describe('cohort() mode: simple edges fetch/aggregate as window()', () => {
  beforeEach(async () => {
    // Clear file registry state
    // @ts-ignore - internal state for tests
    if (fileRegistry._files) {
      // @ts-ignore
      fileRegistry._files.clear();
    }
  });

  it('derives p.mean / evidence / forecast from the window slice, not the cohort slice', async () => {
    const paramId = 'simple-edge';
    const edgeUuid = 'edge-simple';

    // Parameter file contains BOTH cohort and window slices with deliberately different means.
    // If the cohort slice were (incorrectly) used in cohort-mode for this simple edge,
    // we'd see p.mean ≈ 0.90. Correct behaviour should yield p.mean ≈ 0.20.
    const paramFileData: any = {
      id: paramId,
      connection: 'amplitude-prod',
      query: 'from(A).to(B)',
      values: [
        {
          sliceDSL: 'cohort(anchor,1-Nov-25:7-Nov-25)',
          mean: 0.9,
          n: 100,
          k: 90,
          cohort_from: '1-Nov-25',
          cohort_to: '7-Nov-25',
          dates: ['1-Nov-25', '2-Nov-25', '3-Nov-25', '4-Nov-25', '5-Nov-25', '6-Nov-25', '7-Nov-25'],
          n_daily: [14, 14, 14, 14, 14, 15, 15],
          k_daily: [13, 13, 13, 13, 13, 12, 13],
        },
        {
          sliceDSL: 'window(1-Nov-25:7-Nov-25)',
          mean: 0.2,
          n: 100,
          k: 20,
          window_from: '1-Nov-25',
          window_to: '7-Nov-25',
          dates: ['1-Nov-25', '2-Nov-25', '3-Nov-25', '4-Nov-25', '5-Nov-25', '6-Nov-25', '7-Nov-25'],
          n_daily: [14, 14, 14, 14, 14, 15, 15],
          k_daily: [3, 3, 3, 3, 3, 2, 3],
          // Window baseline forecast scalar (p∞) stored on window slices
          forecast: 0.25,
        },
      ],
    };

    await fileRegistry.registerFile(`parameter-${paramId}`, {
      fileId: `parameter-${paramId}`,
      type: 'parameter',
      data: paramFileData,
      originalData: structuredClone(paramFileData),
      isDirty: false,
      isInitializing: false,
      source: { repository: 'test', branch: 'main', isLocal: true } as any,
      viewTabs: [],
      lastModified: Date.now(),
    } as any);

    const graph: Graph = {
      nodes: [
        { id: 'A', uuid: 'A', entry: { is_start: true, entry_weight: 1 } } as any,
        { id: 'B', uuid: 'B' } as any,
      ],
      edges: [
        {
          uuid: edgeUuid,
          id: edgeUuid,
          from: 'A',
          to: 'B',
          p: {
            id: paramId,
            connection: 'amplitude-prod',
          },
        } as any,
      ],
      currentQueryDSL: 'cohort(1-Nov-25:7-Nov-25)',
    } as any;

    let currentGraph: Graph | null = graph;
    const setGraph = (g: Graph | null) => {
      currentGraph = g;
    };

    const result = await fetchItem(
      {
        id: `param-${paramId}-p-${edgeUuid}`,
        type: 'parameter',
        name: `p: ${paramId}`,
        objectId: paramId,
        targetId: edgeUuid,
        paramSlot: 'p',
      },
      { mode: 'from-file' },
      graph,
      setGraph,
      'cohort(1-Nov-25:7-Nov-25)',
      () => currentGraph
    );

    expect(result.success).toBe(true);

    const updated = currentGraph as any;
    const edge = updated.edges.find((e: any) => e.uuid === edgeUuid || e.id === edgeUuid);
    expect(edge).toBeDefined();

    // Confirm we DID NOT use the cohort slice (mean 0.9)
    expect(edge.p.mean).toBeCloseTo(0.2, 6);

    // Evidence should be derived and attached for this query slice
    expect(edge.p.evidence).toBeDefined();
    expect(edge.p.evidence.n).toBe(100);
    expect(edge.p.evidence.k).toBe(20);
    expect(edge.p.evidence.mean).toBeCloseTo(0.2, 6);

    // Forecast baseline should be attached from window slice's forecast scalar
    expect(edge.p.forecast).toBeDefined();
    // Forecast is recomputed at query time from daily arrays (true half-life recency; as-of = max(window date)).
    const asOf = parseDate('7-Nov-25');
    const dates = ['1-Nov-25', '2-Nov-25', '3-Nov-25', '4-Nov-25', '5-Nov-25', '6-Nov-25', '7-Nov-25'];
    const nDaily = [14, 14, 14, 14, 14, 15, 15];
    const kDaily = [3, 3, 3, 3, 3, 2, 3];
    let weightedN = 0;
    let weightedK = 0;
    for (let i = 0; i < dates.length; i++) {
      const d = parseDate(dates[i]);
      const ageDays = Math.max(0, (asOf.getTime() - d.getTime()) / (24 * 60 * 60 * 1000));
      const w = Math.exp(-Math.LN2 * ageDays / RECENCY_HALF_LIFE_DAYS);
      const n = nDaily[i];
      const k = kDaily[i];
      if (n <= 0) continue;
      weightedN += w * n;
      weightedK += w * k;
    }
    const expectedForecast = weightedN > 0 ? (weightedK / weightedN) : undefined;
    expect(expectedForecast).toBeDefined();
    expect(edge.p.forecast.mean).toBeCloseTo(expectedForecast as number, 6);

    // No latency block for a simple edge
    expect(edge.p.latency).toBeUndefined();
  });
});



