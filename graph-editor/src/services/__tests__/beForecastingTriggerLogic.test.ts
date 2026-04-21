/**
 * BE forecasting trigger logic — doc 45 §Delivery model
 *
 * Blind coverage of the race/overwrite semantics for:
 *
 *   - Job A: BE topo pass — fires alongside FE; its output is a
 *     model-var generator only, populating `model_vars[analytic_be]`.
 *     It MUST NOT overwrite `p.latency.*` directly — doing so bypasses
 *     promotion and couples BE's timing to the edge display.
 *
 *   - Job B: BE conditioned forecast — races a 500ms fast deadline.
 *     If it resolves within 500ms with real results, its `p.mean` is
 *     merged into the FE apply (single render, no FE-flash). If it
 *     misses the deadline (or returns empty), FE fallback is applied
 *     first and CF overwrites `p.mean` on arrival (second render).
 *
 * Stale responses from a previous fetch cycle must be discarded via
 * per-cycle generation counters so they cannot clobber the current graph.
 *
 * FE↔BE topo parity (doc 45 §Model var selection): once both topo passes
 * have resolved, `model_vars[analytic]` and `model_vars[analytic_be]`
 * must agree on latency parameters to within a tight tolerance — this
 * is the contract the `param-pack --diag-model-vars` CLI exists to
 * expose for blind diffing.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Graph } from '../../types';

// ── Mocks ──────────────────────────────────────────────────────────────

// runBeTopoPass: test-controlled factory so each test can script its
// timing and return value.
let beTopoImpl: (...args: any[]) => Promise<any[]> = async () => [];
vi.mock('../beTopoPassService', () => ({
  runBeTopoPass: (...args: any[]) => beTopoImpl(...args),
}));

// Conditioned forecast: same shape. `cfApplyImpl` lets tests inject a
// deterministic apply that mutates the graph so assertions can inspect
// what landed.
let cfImpl: (...args: any[]) => Promise<any[]> = async () => [];
let cfApplyImpl: (graph: any, results: any[]) => any = (graph, _r) => graph;
vi.mock('../conditionedForecastService', () => ({
  runConditionedForecast: (...args: any[]) => cfImpl(...args),
  applyConditionedForecastToGraph: (graph: any, results: any[]) => cfApplyImpl(graph, results),
}));

vi.mock('../../contexts/TabContext', () => ({
  fileRegistry: { getFile: vi.fn() },
}));

vi.mock('../../lib/queryDSL', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, parseConstraints: vi.fn() };
});

vi.mock('../forecastingSettingsService', () => ({
  forecastingSettingsService: {
    getForecastingModelSettings: vi.fn(async () => ({
      RECENCY_HALF_LIFE_DAYS: 14,
      DEFAULT_T95_DAYS: 30,
    })),
  },
}));

vi.mock('../operationRegistryService', () => ({
  operationRegistryService: {
    register: vi.fn(), setLabel: vi.fn(), setProgress: vi.fn(), complete: vi.fn(),
  },
}));

vi.mock('../rateLimitCountdownService', () => ({
  startRateLimitCountdown: vi.fn(async () => 'expired' as const),
}));

import { runStage2EnhancementsAndInboundN, type FetchItem } from '../fetchDataService';
import { fileRegistry } from '../../contexts/TabContext';
import { parseConstraints } from '../../lib/queryDSL';

// ── Helpers ────────────────────────────────────────────────────────────

const EDGE_ID = 'start-to-a';
const PARAM_ID = 'latency-param';

function latencyGraph(): any {
  return {
    nodes: [
      { id: 'start', entry: { is_start: true } },
      { id: 'a' },
    ],
    edges: [
      {
        id: EDGE_ID,
        uuid: EDGE_ID,
        from: 'start',
        to: 'a',
        p: {
          id: PARAM_ID,
          mean: 0.5,
          latency: { latency_parameter: true, anchor_node_id: 'start', t95: 30 },
          model_vars: [
            {
              source: 'analytic',
              source_at: '1-Jan-25',
              probability: { mean: 0.5, stdev: 0.05 },
            },
          ],
        },
      },
    ],
    metadata: { version: '1.1.0', created_at: '1-Jan-25' },
    policies: {},
  };
}

function registerParamFile(): void {
  (fileRegistry.getFile as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
    if (id === `parameter-${PARAM_ID}`) {
      return {
        data: {
          values: [
            {
              sliceDSL: 'window(1-Nov-25:7-Nov-25)',
              window_from: '1-Nov-25', window_to: '7-Nov-25',
              dates: ['2025-11-01', '2025-11-02', '2025-11-03'],
              n_daily: [100, 100, 100],
              k_daily: [50, 50, 50],
              median_lag_days: [5, 5, 5],
              mean_lag_days: [6, 6, 6],
              latency: { onset_delta_days: 1 },
            },
          ],
        },
      };
    }
    return null;
  });
}

function windowDsl(): void {
  (parseConstraints as ReturnType<typeof vi.fn>).mockReturnValue({
    cohort: null,
    window: { start: '1-Nov-25', end: '7-Nov-25' },
    asat: null,
    visited: [], exclude: [], context: [], cases: [],
    visitedAny: [], contextAny: [],
    asatClausePresent: false,
  });
}

function windowDslWithAsat(asat: string): void {
  (parseConstraints as ReturnType<typeof vi.fn>).mockReturnValue({
    cohort: null,
    window: { start: '1-Nov-25', end: '7-Nov-25' },
    asat,
    visited: [], exclude: [], context: [], cases: [],
    visitedAny: [], contextAny: [],
    asatClausePresent: true,
  });
}

function fetchItem(): FetchItem {
  return {
    id: `param-${PARAM_ID}-${EDGE_ID}`,
    type: 'parameter',
    name: PARAM_ID,
    objectId: PARAM_ID,
    targetId: EDGE_ID,
    paramSlot: 'p',
  };
}

/** Build a fake BE topo entry that mirrors `runBeTopoPass`'s shape. */
function fakeBeEntry(over: Record<string, number> = {}): any {
  return {
    edgeUuid: EDGE_ID,
    conditionalIndex: null,
    entry: {
      source: 'analytic_be',
      source_at: '1-Jan-25',
      probability: { mean: 0.5, stdev: 0.05 },
      // Intentionally close-but-not-identical to the FE fit (below) so
      // tests that assert on `analytic_be` vs `analytic` can check that
      // BOTH blocks land and are in tolerance.
      latency: {
        mu: 1.6,
        sigma: 0.4,
        t95: 7,
        onset_delta_days: 1,
        mu_sd: 0.05,
        sigma_sd: 0.03,
        onset_sd: 0.02,
        ...over,
      },
    },
    beScalars: {
      mu: 1.6, sigma: 0.4, t95: 7, completeness: 0.9,
      median_lag_days: 4.95,  // close to FE's 5
      mean_lag_days: 5.95,
      p_sd: 0.06,
    },
  };
}

/** A CF scenario result with a single edge's p.mean populated. */
function fakeCfResult(pMean: number, completeness?: number): any[] {
  return [
    {
      scenario_id: 'current',
      success: true,
      edges: [
        {
          edge_uuid: EDGE_ID,
          p_mean: pMean,
          p_sd: 0.04,
          ...(completeness != null ? { completeness } : {}),
        },
      ],
    },
  ];
}

/** Track every setGraph call so tests can assert render ordering. */
function captureSetGraph() {
  const calls: Array<{ graph: any; tick: number }> = [];
  let tick = 0;
  const setGraph = vi.fn((g: any) => {
    calls.push({ graph: g, tick: ++tick });
  });
  return { setGraph, calls };
}

async function yieldMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Test suite ─────────────────────────────────────────────────────────

describe('BE forecasting trigger logic (doc 45)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    beTopoImpl = async () => [];
    cfImpl = async () => [];
    cfApplyImpl = (graph, _r) => graph;
    registerParamFile();
    windowDsl();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── BE topo scoping (doc 45: model var generator only) ──────────────

  it('BE topo result populates model_vars[analytic_be] only, never p.latency.* directly', async () => {
    beTopoImpl = async () => [fakeBeEntry()];
    cfImpl = async () => [];  // CF empty fast → no interference

    const graph = latencyGraph();
    const { setGraph } = captureSetGraph();

    await runStage2EnhancementsAndInboundN(
      [fetchItem()], [fetchItem()], { mode: 'from-file' } as any,
      graph, setGraph, 'window(1-Nov-25:7-Nov-25)',
    );

    // Allow the BE .then() to run.
    await yieldMs(50);

    // The most recent graph handed to setGraph should have:
    //   - analytic_be entry in model_vars (populated by BE topo)
    //   - p.latency.median_lag_days from FE, NOT from BE's beScalars
    const lastGraph = setGraph.mock.calls[setGraph.mock.calls.length - 1][0] as any;
    const edge = lastGraph.edges.find((e: any) => (e.uuid || e.id) === EDGE_ID);
    const analyticBe = edge?.p?.model_vars?.find((v: any) => v.source === 'analytic_be');
    expect(analyticBe).toBeDefined();
    expect(analyticBe.latency?.mu).toBe(1.6);
    // p.latency.median_lag_days must be FE-sourced (~5 from the
    // input), never the BE scalar 4.95 copied directly.
    expect(edge.p.latency.median_lag_days).not.toBe(4.95);
  });

  it('BE topo stale response (older generation) is discarded', async () => {
    // Slow BE: resolves in 150ms. Two fetchItems cycles run back-to-back,
    // so the first cycle's BE response arrives AFTER the second cycle
    // has incremented the generation counter.
    let beFireCount = 0;
    beTopoImpl = async () => {
      beFireCount++;
      const myFire = beFireCount;
      await yieldMs(150);
      // First fire's payload is (intentionally) distinguishable.
      return [fakeBeEntry({ mu: myFire === 1 ? 99 : 1.6 })];
    };

    const graph = latencyGraph();
    const { setGraph } = captureSetGraph();

    // Cycle 1 — returns quickly; BE still in flight.
    await runStage2EnhancementsAndInboundN(
      [fetchItem()], [fetchItem()], { mode: 'from-file' } as any,
      graph, setGraph, 'window(1-Nov-25:7-Nov-25)',
    );
    // Cycle 2 — increments BE generation. Cycle 1's BE must be discarded
    // when it eventually resolves.
    await runStage2EnhancementsAndInboundN(
      [fetchItem()], [fetchItem()], { mode: 'from-file' } as any,
      graph, setGraph, 'window(1-Nov-25:7-Nov-25)',
    );

    // Wait long enough for both BE promises to settle.
    await yieldMs(250);

    const lastGraph = setGraph.mock.calls[setGraph.mock.calls.length - 1][0] as any;
    const edge = lastGraph.edges.find((e: any) => (e.uuid || e.id) === EDGE_ID);
    const analyticBe = edge?.p?.model_vars?.find((v: any) => v.source === 'analytic_be');
    // Only the second cycle's BE should have landed (mu = 1.6, never 99).
    expect(analyticBe?.latency?.mu).toBe(1.6);
  });

  // ── Conditioned forecast 500ms race (doc 45 §Delivery model step 3) ─

  it('CF fast path (<500ms with results): single render, p.mean replaces FE fallback', async () => {
    cfImpl = async () => fakeCfResult(0.77);
    cfApplyImpl = (_graph, _r) => _graph;  // unused on fast path

    const graph = latencyGraph();
    const { setGraph, calls } = captureSetGraph();

    const t0 = Date.now();
    await runStage2EnhancementsAndInboundN(
      [fetchItem()], [fetchItem()], { mode: 'from-file' } as any,
      graph, setGraph, 'window(1-Nov-25:7-Nov-25)',
    );
    const elapsed = Date.now() - t0;

    // CF returned essentially instantly — we must NOT have waited the
    // 500ms deadline.
    expect(elapsed).toBeLessThan(450);

    // FE apply happens once. The graph handed to setGraph must carry
    // CF's p.mean (0.77), not FE's blended output.
    const lastGraph = calls[calls.length - 1].graph;
    const edge = lastGraph.edges.find((e: any) => (e.uuid || e.id) === EDGE_ID);
    expect(edge.p.mean).toBeCloseTo(0.77, 5);
  });

  it('CF fast path also overwrites stale completeness on from-file graphs', async () => {
    cfImpl = async () => fakeCfResult(0.77, 0);

    const graph = latencyGraph();
    graph.edges[0].p.latency = {
      ...graph.edges[0].p.latency,
      completeness: 0.81,
      completeness_stdev: 0.02,
      median_lag_days: 5,
      mean_lag_days: 6,
    };
    const { setGraph, calls } = captureSetGraph();

    await runStage2EnhancementsAndInboundN(
      [fetchItem()], [fetchItem()], { mode: 'from-file' } as any,
      graph, setGraph, 'window(1-Nov-25:7-Nov-25)',
    );

    const lastGraph = calls[calls.length - 1].graph;
    const edge = lastGraph.edges.find((e: any) => (e.uuid || e.id) === EDGE_ID);
    expect(edge.p.mean).toBeCloseTo(0.77, 5);
    expect(edge.p.latency.completeness).toBe(0);
  });

  it('CF slow path (>500ms): FE fallback applied first, CF overwrites p.mean on arrival', async () => {
    // CF takes long enough to miss the 500ms fast deadline.
    cfImpl = async () => {
      await yieldMs(700);
      return fakeCfResult(0.82);
    };
    cfApplyImpl = (graph, results) => {
      // Minimal apply: clone + write p.mean on the target edge so tests
      // can see the subsequent overwrite happened.
      const g = structuredClone(graph);
      const e = g.edges.find((x: any) => (x.uuid || x.id) === EDGE_ID);
      if (e?.p) e.p.mean = results[0].edges[0].p_mean;
      return g;
    };

    const graph = latencyGraph();
    const { setGraph, calls } = captureSetGraph();

    await runStage2EnhancementsAndInboundN(
      [fetchItem()], [fetchItem()], { mode: 'from-file' } as any,
      graph, setGraph, 'window(1-Nov-25:7-Nov-25)',
    );

    // Contract: at return time the FE fallback is on the graph (CF has
    // not yet overwritten p.mean). The absolute elapsed time depends on
    // other Stage-2 work (bootstrap, IDB writes) so assert on behaviour,
    // not wall clock.
    const feGraph = calls[calls.length - 1].graph;
    const feEdge = feGraph.edges.find((e: any) => (e.uuid || e.id) === EDGE_ID);
    expect(feEdge.p.mean).not.toBe(0.82);
    const feRenderCount = calls.length;

    // Wait for the subsequent CF .then() to fire and setGraph again.
    await yieldMs(800);
    const cfGraph = calls[calls.length - 1].graph;
    const cfEdge = cfGraph.edges.find((e: any) => (e.uuid || e.id) === EDGE_ID);
    expect(cfEdge.p.mean).toBeCloseTo(0.82, 5);

    // A second render must have happened for the CF overwrite.
    expect(calls.length).toBeGreaterThan(feRenderCount);
  });

  it('CF fast-empty response: FE fallback retained, no crash', async () => {
    cfImpl = async () => [];  // resolves fast, but with nothing usable

    const graph = latencyGraph();
    const { setGraph, calls } = captureSetGraph();

    await runStage2EnhancementsAndInboundN(
      [fetchItem()], [fetchItem()], { mode: 'from-file' } as any,
      graph, setGraph, 'window(1-Nov-25:7-Nov-25)',
    );

    // FE apply happened exactly once (no CF overwrite to come).
    const lastGraph = calls[calls.length - 1].graph;
    const edge = lastGraph.edges.find((e: any) => (e.uuid || e.id) === EDGE_ID);
    // p.mean should be FE blended (any real finite number), not null.
    expect(typeof edge.p.mean).toBe('number');
  });

  it('asat() becomes the implicit FE analysis date when no queryDate override is supplied', async () => {
    windowDslWithAsat('15-Nov-25');

    let beQueryDate: Date | undefined;
    beTopoImpl = async (...args: any[]) => {
      beQueryDate = args[2];
      return [];
    };
    cfImpl = async () => [];

    const graph = latencyGraph();
    const { setGraph } = captureSetGraph();

    await runStage2EnhancementsAndInboundN(
      [fetchItem()], [fetchItem()], { mode: 'from-file' } as any,
      graph, setGraph, 'window(1-Nov-25:7-Nov-25).asat(15-Nov-25)',
    );

    expect(beQueryDate).toBeInstanceOf(Date);
    expect(beQueryDate!.toISOString().split('T')[0]).toBe('2025-11-15');
  });

  it('passes explicit non-browser workspace through to conditioned forecast', async () => {
    const workspace = { repository: 'repo-name', branch: 'feature/asat' };
    let cfWorkspace: { repository: string; branch: string } | undefined;

    cfImpl = async (...args: any[]) => {
      cfWorkspace = args[3];
      return [];
    };

    const graph = latencyGraph();
    const { setGraph } = captureSetGraph();

    await runStage2EnhancementsAndInboundN(
      [fetchItem()], [fetchItem()], { mode: 'from-file', workspace } as any,
      graph, setGraph, 'window(1-Nov-25:7-Nov-25)',
    );

    expect(cfWorkspace).toEqual(workspace);
  });

  it('CF stale response (older generation) is discarded', async () => {
    let cfFireCount = 0;
    cfImpl = async () => {
      cfFireCount++;
      const myFire = cfFireCount;
      await yieldMs(700);  // slow — overruns the 500ms deadline
      return fakeCfResult(myFire === 1 ? 0.111 : 0.999);
    };
    cfApplyImpl = (graph, results) => {
      const g = structuredClone(graph);
      const e = g.edges.find((x: any) => (x.uuid || x.id) === EDGE_ID);
      if (e?.p) e.p.mean = results[0].edges[0].p_mean;
      return g;
    };

    const graph = latencyGraph();
    const { setGraph, calls } = captureSetGraph();

    // Cycle 1 — slow CF promise is still in flight when we return.
    await runStage2EnhancementsAndInboundN(
      [fetchItem()], [fetchItem()], { mode: 'from-file' } as any,
      graph, setGraph, 'window(1-Nov-25:7-Nov-25)',
    );
    // Cycle 2 — increments CF generation; cycle 1's CF must be discarded.
    await runStage2EnhancementsAndInboundN(
      [fetchItem()], [fetchItem()], { mode: 'from-file' } as any,
      graph, setGraph, 'window(1-Nov-25:7-Nov-25)',
    );

    // Wait for both CF promises to settle.
    await yieldMs(900);

    const lastGraph = calls[calls.length - 1].graph;
    const edge = lastGraph.edges.find((e: any) => (e.uuid || e.id) === EDGE_ID);
    // Only the second cycle's CF should have landed (0.999). The stale
    // first cycle (0.111) must be discarded.
    expect(edge.p.mean).not.toBeCloseTo(0.111, 5);
  });

  // ── FE↔BE topo parity (doc 45 §Model var selection) ─────────────────
  //
  // This test covers the SHAPE contract exposed by the
  // `param-pack --diag-model-vars` CLI: after both topo passes have
  // resolved, every latency-bearing edge must carry BOTH an
  // `analytic` entry (FE) and an `analytic_be` entry (BE) with a
  // populated `latency` block. Downstream parity diffing (manual or
  // in CI via the CLI) asserts numeric agreement — that lives
  // outside this unit-level test because it depends on the real
  // FE/BE fitter outputs, not the mocked ones.

  it('FE↔BE topo parity shape: analytic and analytic_be both populated after BE resolves', async () => {
    beTopoImpl = async () => [fakeBeEntry()];
    cfImpl = async () => [];

    const graph = latencyGraph();
    const { setGraph } = captureSetGraph();

    await runStage2EnhancementsAndInboundN(
      [fetchItem()], [fetchItem()], { mode: 'from-file' } as any,
      graph, setGraph, 'window(1-Nov-25:7-Nov-25)',
    );
    await yieldMs(50);

    const lastGraph = setGraph.mock.calls[setGraph.mock.calls.length - 1][0] as any;
    const edge = lastGraph.edges.find((e: any) => (e.uuid || e.id) === EDGE_ID);
    const modelVars = edge?.p?.model_vars ?? [];
    const analytic = modelVars.find((v: any) => v.source === 'analytic');
    const analyticBe = modelVars.find((v: any) => v.source === 'analytic_be');

    expect(analytic).toBeDefined();
    expect(analyticBe).toBeDefined();
    // Both entries must carry a latency block with the canonical
    // fields. Numeric parity is the CLI's concern (see
    // `param-pack --diag-model-vars`).
    for (const entry of [analytic, analyticBe]) {
      expect(entry.latency).toBeDefined();
      expect(typeof entry.latency.mu).toBe('number');
      expect(typeof entry.latency.sigma).toBe('number');
      expect(typeof entry.latency.t95).toBe('number');
    }
  });
});
