/**
 * DSL Re-aggregation Pipeline — Integration Tests
 *
 * Tests the invariant: when currentDSL changes, from-file re-aggregation
 * produces different edge probability values reflecting the new date window.
 *
 * These tests protect the refactor of planner + auto-aggregation out of
 * WindowSelector into a graph-level hook. If these tests pass before AND
 * after the refactor, the pipeline is preserved.
 *
 * Level: focused integration (real fetchDataService + fileRegistry mock)
 * Mocks: fileRegistry (in-memory), external APIs not involved
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fetchItem, createFetchItem, fetchDataService, getItemsForFromFileLoad } from '../fetchDataService';
import { fileRegistry } from '../../contexts/TabContext';
import type { Graph } from '../../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Register a parameter file in the mock fileRegistry. */
async function registerParameterFile(paramId: string, paramData: any): Promise<void> {
  await fileRegistry.registerFile(`parameter-${paramId}`, {
    fileId: `parameter-${paramId}`,
    type: 'parameter',
    data: paramData,
    originalData: structuredClone(paramData),
    isDirty: false,
    isInitializing: false,
    source: { repository: 'test-repo', branch: 'main', isLocal: true } as any,
    viewTabs: [],
    lastModified: Date.now(),
  } as any);
}

/** Minimal graph with one edge connected to a parameter. */
function makeGraph(paramId: string, edgeId: string = 'edge-A-B'): Graph {
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
          mean: 0.5,
          stdev: 0.05,
          distribution: 'beta',
          connection: 'test-connection',
        },
      } as any,
    ],
  } as any;
}

/**
 * Create a parameter file with daily data spanning two distinct periods.
 *
 * Period 1 (Jan 2025): ~20% conversion (k=20 per day, n=100 per day)
 * Period 2 (Feb 2025): ~80% conversion (k=80 per day, n=100 per day)
 *
 * CORRECT OUTCOME when aggregated:
 *   window(1-Jan-25:31-Jan-25) → evidence.mean ≈ 0.20
 *   window(1-Feb-25:28-Feb-25) → evidence.mean ≈ 0.80
 */
function makeParameterFileWithTwoPeriods(paramId: string): any {
  const dates: string[] = [];
  const nDaily: number[] = [];
  const kDaily: number[] = [];

  // January: 31 days at 20% conversion
  for (let d = 1; d <= 31; d++) {
    dates.push(`${d}-Jan-25`);
    nDaily.push(100);
    kDaily.push(20);
  }
  // February: 28 days at 80% conversion
  for (let d = 1; d <= 28; d++) {
    dates.push(`${d}-Feb-25`);
    nDaily.push(100);
    kDaily.push(80);
  }

  return {
    id: paramId,
    name: `Test param ${paramId}`,
    type: 'probability',
    query: 'from(A).to(B)',
    query_overridden: false,
    values: [
      {
        mean: 0.5,
        stdev: 0.1,
        distribution: 'beta',
        n_daily: nDaily,
        k_daily: kDaily,
        dates: dates,
        window_from: '1-Jan-25',
        window_to: '28-Feb-25',
        sliceDSL: 'window(1-Jan-25:28-Feb-25)',
        data_source: {
          type: 'external',
          retrieved_at: '2025-03-01T00:00:00Z',
        },
      },
    ],
    metadata: {
      description: 'Test parameter with two distinct periods',
      description_overridden: false,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-03-01T00:00:00Z',
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DSL re-aggregation pipeline', () => {
  const paramId = 'reagg-test-param';
  const edgeId = 'edge-A-B';

  beforeEach(async () => {
    vi.clearAllMocks();
    // Register parameter file with data for both periods
    await registerParameterFile(paramId, makeParameterFileWithTwoPeriods(paramId));
  });

  it('should produce ~20% evidence.mean when DSL covers January', async () => {
    // CORRECT OUTCOME: January has k=20, n=100 per day → evidence.mean ≈ 0.20
    let graph: Graph | null = makeGraph(paramId, edgeId);
    const setGraph = (g: Graph | null) => { graph = g; };

    const item = createFetchItem('parameter', paramId, edgeId);
    const dsl = 'window(1-Jan-25:31-Jan-25)';

    const result = await fetchItem(item, { mode: 'from-file' }, graph as Graph, setGraph, dsl, () => graph);
    expect(result.success).toBe(true);

    const edge = (graph as any).edges.find((e: any) => e.uuid === edgeId);
    expect(edge.p.evidence).toBeDefined();
    expect(edge.p.evidence.mean).toBeCloseTo(0.20, 1);
    expect(edge.p.evidence.n).toBeGreaterThan(0);
  });

  it('should produce ~80% evidence.mean when DSL covers February', async () => {
    // CORRECT OUTCOME: February has k=80, n=100 per day → evidence.mean ≈ 0.80
    let graph: Graph | null = makeGraph(paramId, edgeId);
    const setGraph = (g: Graph | null) => { graph = g; };

    const item = createFetchItem('parameter', paramId, edgeId);
    const dsl = 'window(1-Feb-25:28-Feb-25)';

    const result = await fetchItem(item, { mode: 'from-file' }, graph as Graph, setGraph, dsl, () => graph);
    expect(result.success).toBe(true);

    const edge = (graph as any).edges.find((e: any) => e.uuid === edgeId);
    expect(edge.p.evidence).toBeDefined();
    expect(edge.p.evidence.mean).toBeCloseTo(0.80, 1);
    expect(edge.p.evidence.n).toBeGreaterThan(0);
  });

  it('should produce different edge values when DSL changes from January to February', async () => {
    // CORRECT OUTCOME: same graph + same parameter file → different edge probability
    // depending on which DSL window is used for aggregation.
    // This is the core invariant that views rely on.
    let graph: Graph | null = makeGraph(paramId, edgeId);
    const setGraph = (g: Graph | null) => { graph = g; };

    const item = createFetchItem('parameter', paramId, edgeId);

    // First: aggregate for January
    const r1 = await fetchItem(item, { mode: 'from-file' }, graph as Graph, setGraph, 'window(1-Jan-25:31-Jan-25)', () => graph);
    expect(r1.success).toBe(true);
    const janMean = (graph as any).edges.find((e: any) => e.uuid === edgeId).p.evidence.mean;

    // Second: re-aggregate for February (same graph, same file, different DSL)
    const r2 = await fetchItem(item, { mode: 'from-file' }, graph as Graph, setGraph, 'window(1-Feb-25:28-Feb-25)', () => graph);
    expect(r2.success).toBe(true);
    const febMean = (graph as any).edges.find((e: any) => e.uuid === edgeId).p.evidence.mean;

    // January ≈ 0.20, February ≈ 0.80 — must be significantly different
    expect(janMean).toBeCloseTo(0.20, 1);
    expect(febMean).toBeCloseTo(0.80, 1);
    expect(Math.abs(febMean - janMean)).toBeGreaterThan(0.4);
  });

  it('should enumerate all fetchable items via getItemsForFromFileLoad', () => {
    // CORRECT OUTCOME: the graph's edge with a paramId produces one fetch item
    const graph = makeGraph(paramId, edgeId);
    const items = getItemsForFromFileLoad(graph);

    expect(items.length).toBeGreaterThanOrEqual(1);
    const paramItem = items.find(i => i.objectId === paramId);
    expect(paramItem).toBeDefined();
    expect(paramItem!.type).toBe('parameter');
    expect(paramItem!.targetId).toBe(edgeId);
  });

  it('should update graph via setGraph callback during from-file fetch', async () => {
    // CORRECT OUTCOME: the setGraph callback IS called with an updated graph,
    // not just a mutation of the original reference
    let graphUpdates = 0;
    let graph: Graph | null = makeGraph(paramId, edgeId);
    const setGraph = (g: Graph | null) => { graphUpdates++; graph = g; };

    const item = createFetchItem('parameter', paramId, edgeId);
    await fetchItem(item, { mode: 'from-file' }, graph as Graph, setGraph, 'window(1-Jan-25:31-Jan-25)', () => graph);

    expect(graphUpdates).toBeGreaterThanOrEqual(1);
  });
});
