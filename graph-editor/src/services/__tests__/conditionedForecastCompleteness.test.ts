/**
 * FE authority contract for CF-owned fields (doc 64 Family F).
 *
 * Doc 45 §Endpoint contract (lines 181-190) specifies that the CF
 * response carries per-edge `completeness` and `completeness_sd`,
 * and line 153-154 states: "it produces per-edge scalars (p.mean,
 * p_sd, completeness) that get written back to the graph". CF is
 * the authoritative writer for these fields on the graph path; the
 * FE topo pass must yield its own CDF-derived completeness on those
 * edges, and CF projects only `evidence_k/n` onto `p.evidence.k/n`
 * (without taking over `p.evidence.mean` authority).
 *
 * This file is the FE-local authority contract. It tests only how
 * the FE projects CF's response into graph state. It does not test
 * whether CF produced the right numbers — that is the BE's semantic
 * responsibility and lives in the Python suite
 * (`test_conditioned_forecast_response_contract.py`).
 *
 * Contract asserted here:
 *
 *   1. `ConditionedForecastEdgeResult` declares `completeness`,
 *      `completeness_sd`, `cf_mode`, `cf_reason`. This file
 *      compiles only if the type carries those fields; a missing
 *      field fails the build before runtime.
 *
 *   2. `applyConditionedForecastToGraph` overwrites
 *      `edge.p.latency.completeness` and
 *      `edge.p.latency.completeness_stdev` with CF's values.
 *
 *   3. The graph projection boundary stays explicit: CF response
 *      evidence is available to direct-response consumers, and
 *      CF projects `evidence_k/n` onto `edge.p.evidence.k/n`
 *      while leaving `edge.p.evidence.mean` unchanged.
 *
 *   4. `buildConditionedForecastGraphSnapshot` engorges a clone,
 *      never the live graph.
 *
 *   5. End-to-end via `runStage2EnhancementsAndInboundN`:
 *      a. CF fast path: `completeness` on the edge is CF's value
 *         (not the FE topo CDF-derived value); CF evidence n/k is
 *         projected onto the graph path.
 *      b. CF slow path: after the subsequent-overwrite `.then()`
 *         fires, completeness reflects CF's value.
 *
 * ── Authoring receipt (doc 64 §3.6) ─────────────────────────────
 *
 * Family         F. Projection and authority — FE-local only.
 * Invariant      CF authoritatively writes `p.mean` / `p.stdev` /
 *                `completeness` / `completeness_sd` and projects
 *                `evidence_k/n` onto `p.evidence.k/n` on the graph.
 *                `p.evidence.mean` remains on the FE topo path.
 * Oracle type    FE-local authority contract. Not BE semantic
 *                correctness (that lives in the Python suite).
 * Apparatus      TypeScript integration — real
 *                `applyConditionedForecastToGraph`,
 *                `buildConditionedForecastGraphSnapshot`, and
 *                `runStage2EnhancementsAndInboundN` fast/slow
 *                path. Mocks isolate the BE boundary
 *                (`runConditionedForecast`) and
 *                infra services that are irrelevant to the
 *                authority claim.
 * Fixtures       `latencyGraph()` — minimal inline graph with one
 *                latency edge carrying pre-existing completeness
 *                and evidence so the overwrite/preserve claim is
 *                non-vacuous.
 * Reality        Real FE projection code. Only acceptable stubs
 *                are the BE boundary and infra services unrelated
 *                to the authority claim.
 * False-pass     A test could pass if CF and the FE topo silently
 *                produced the same values. Mitigated by seeding the
 *                graph with distinctive pre-existing values (0.42,
 *                0.05, n=300, k=150) and distinct CF response
 *                deliberately does not match.
 * Retires        Supersedes the `*.red.test.ts` framing from when
 *                CF did not yet write completeness. CF now does;
 *                this file is a live authority drift guard.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Graph } from '../../types';

// ── Mocks for end-to-end tests (3a, 3b) ────────────────────────────────

let cfImpl: (...args: any[]) => Promise<any[]> = async () => [];
// We want to test the REAL applyConditionedForecastToGraph behaviour, so
// pass through to the real module for it while stubbing the fetch.
vi.mock('../conditionedForecastService', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    runConditionedForecast: (...args: any[]) => cfImpl(...args),
  };
});

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

import {
  applyConditionedForecastToGraph,
  type ConditionedForecastEdgeResult,
  type ConditionedForecastScenarioResult,
} from '../conditionedForecastService';
import { buildConditionedForecastGraphSnapshot } from '../../lib/conditionedForecastGraphSnapshot';
import { runStage2EnhancementsAndInboundN, type FetchItem } from '../fetchDataService';
import { createConditionedForecastSupersessionState } from '../conditionedForecastSupersessionState';
import { fileRegistry } from '../../contexts/TabContext';
import { parseConstraints } from '../../lib/queryDSL';

// ── Helpers ────────────────────────────────────────────────────────────

const EDGE_ID = 'start-to-a';
const PARAM_ID = 'lat-param';

function latencyGraph(): any {
  return {
    nodes: [{ id: 'start', entry: { is_start: true } }, { id: 'a' }],
    edges: [
      {
        id: EDGE_ID,
        uuid: EDGE_ID,
        from: 'start',
        to: 'a',
        p: {
          id: PARAM_ID,
          mean: 0.5,
          evidence: {
            n: 300,
            k: 150,
            mean: 0.5,
          },
          latency: {
            latency_parameter: true,
            anchor_node_id: 'start',
            t95: 30,
            // An explicit existing completeness that CF must overwrite.
            completeness: 0.42,
            completeness_stdev: 0.05,
          },
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
            {
              sliceDSL: 'cohort(1-Nov-25:7-Nov-25)',
              dates: ['2025-11-01', '2025-11-02', '2025-11-03'],
              n_daily: [100, 100, 100],
              k_daily: [40, 40, 40],
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
    visited: [], exclude: [], context: [], cases: [],
    visitedAny: [], contextAny: [],
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

async function yieldMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('CF owns completeness on the graph path (FE authority contract)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cfImpl = async () => [];
    registerParamFile();
    windowDsl();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. Type-level: ConditionedForecastEdgeResult declares the fields ─

  it('ConditionedForecastEdgeResult type permits CF completeness and provenance fields', () => {
    // This test compiles only if the type declares these fields
    // (even as optional). If the type is missing them, tsc fails here.
    const example: ConditionedForecastEdgeResult = {
      edge_uuid: EDGE_ID,
      p_mean: 0.6,
      p_sd: 0.04,
      p_sd_epistemic: 0.04,
      completeness: 0.75,
      completeness_sd: 0.08,
      conditioning: {
        r: null,
        m_S: null,
        m_G: null,
        applied: false,
        skip_reason: 'source_query_scoped',
      },
      cf_mode: 'analytic_degraded',
      cf_reason: 'query_scoped_posterior',
    };
    expect(example.completeness).toBe(0.75);
    expect(example.completeness_sd).toBe(0.08);
    expect(example.cf_mode).toBe('analytic_degraded');
    expect(example.cf_reason).toBe('query_scoped_posterior');
  });

  // ── 2. applyConditionedForecastToGraph OVERWRITES completeness ──────

  it('applyConditionedForecastToGraph overwrites edge.p.latency.completeness with CF value', () => {
    // Doc 73b §6.2 / §12.2 row S9: CF apply mapping is
    // `p_sd → p.stdev_pred` (predictive), `p_sd_epistemic → p.stdev` (epistemic).
    const graph = latencyGraph();
    const results: ConditionedForecastScenarioResult[] = [
      {
        scenario_id: 'current',
        success: true,
        edges: [
          {
            edge_uuid: EDGE_ID,
            p_mean: 0.6,
            p_sd: 0.05,            // predictive (kappa-inflated)
            p_sd_epistemic: 0.04,  // epistemic
            completeness: 0.85,    // doc 45 — CF's own value
            completeness_sd: 0.07,
          },
        ],
      },
    ];

    const updated = applyConditionedForecastToGraph(graph, results);
    const edge = updated.edges.find((e: any) => (e.uuid || e.id) === EDGE_ID);
    expect(edge.p.latency.completeness).toBeCloseTo(0.85, 5);
    expect(edge.p.latency.completeness).not.toBeCloseTo(0.42, 5);
    expect(edge.p.stdev).toBeCloseTo(0.04, 5);       // p_sd_epistemic → p.stdev
    expect(edge.p.stdev_pred).toBeCloseTo(0.05, 5);  // p_sd → p.stdev_pred
  });

  it('applyConditionedForecastToGraph overwrites edge.p.latency.completeness_stdev with CF value', () => {
    const graph = latencyGraph();
    const results: ConditionedForecastScenarioResult[] = [
      {
        scenario_id: 'current',
        success: true,
        edges: [
          {
            edge_uuid: EDGE_ID,
            p_mean: 0.6,
            p_sd: 0.04,
            completeness: 0.85,
            completeness_sd: 0.07,
          },
        ],
      },
    ];

    const updated = applyConditionedForecastToGraph(graph, results);
    const edge = updated.edges.find((e: any) => (e.uuid || e.id) === EDGE_ID);
    expect(edge.p.latency.completeness_stdev).toBeCloseTo(0.07, 5);
    expect(edge.p.latency.completeness_stdev).not.toBeCloseTo(0.05, 5);
  });

  it('applyConditionedForecastToGraph projects CF evidence n/k while preserving evidence.mean', () => {
    const graph = latencyGraph();
    const results: ConditionedForecastScenarioResult[] = [
      {
        scenario_id: 'current',
        success: true,
        edges: [
          {
            edge_uuid: EDGE_ID,
            p_mean: 0.6,
            p_sd: 0.04,
            evidence_n: 120,
            evidence_k: 48,
          },
        ],
      },
    ];

    const updated = applyConditionedForecastToGraph(graph, results);
    const edge = updated.edges.find((e: any) => (e.uuid || e.id) === EDGE_ID);
    expect(edge.p.evidence.n).toBe(120);
    expect(edge.p.evidence.k).toBe(48);
    expect(edge.p.evidence.mean).toBeCloseTo(0.5, 5);
  });

  it('buildConditionedForecastGraphSnapshot engorges a clone without dirtying the live graph', () => {
    const graph = latencyGraph();

    const snapshot = buildConditionedForecastGraphSnapshot(
      graph,
      (paramId) => fileRegistry.getFile(`parameter-${paramId}`)?.data,
    );

    expect((graph.edges[0] as any)._bayes_evidence).toBeUndefined();
    expect((snapshot.edges[0] as any)._bayes_evidence).toBeDefined();
    expect((snapshot.edges[0] as any)._bayes_evidence.cohort[0].n_daily).toEqual([100, 100, 100]);
  });

  // ── 3. End-to-end: CF completeness lands via the Stage-2 pipeline ───

  it('CF fast path: edge completeness is CF value (not FE topo CDF value)', async () => {
    cfImpl = async () => [
      {
        scenario_id: 'current',
        success: true,
        edges: [
          {
            edge_uuid: EDGE_ID,
            p_mean: 0.77,
            p_sd: 0.04,
            completeness: 0.88,
            completeness_sd: 0.06,
            evidence_n: 120,
            evidence_k: 48,
          },
        ],
      },
    ];
    const graph = latencyGraph();
    let lastGraph: any = graph;
    const setGraph = (g: any) => { lastGraph = g; };

    await runStage2EnhancementsAndInboundN(
      [fetchItem()], [fetchItem()], { mode: 'from-file' } as any,
      graph, setGraph, 'window(1-Nov-25:7-Nov-25)',
    );

    const edge = lastGraph.edges.find((e: any) => (e.uuid || e.id) === EDGE_ID);
    // CF's completeness (0.88) must win — FE's CDF-based value would
    // be whatever enhanceGraphLatencies computed, NOT 0.88.
    expect(edge.p.latency.completeness).toBeCloseTo(0.88, 5);
    expect(edge.p.stdev).toBeCloseTo(0.04, 5);
    expect(edge.p.evidence.n).toBe(120);
    expect(edge.p.evidence.k).toBe(48);
    expect(edge.p.evidence.mean).toBeCloseTo(0.5, 5);
  });

  it('CF slow path: edge completeness becomes CF value after subsequent-overwrite .then() fires', async () => {
    // Slow CF — misses the 500ms race; its result lands via the
    // fire-and-forget .then() that runs applyConditionedForecastToGraph.
    cfImpl = async () => {
      await yieldMs(700);
      return [
        {
          scenario_id: 'current',
          success: true,
          edges: [
            {
              edge_uuid: EDGE_ID,
              p_mean: 0.81,
              p_sd: 0.04,
              completeness: 0.93,
              completeness_sd: 0.05,
            },
          ],
        },
      ];
    };

    const graph = latencyGraph();
    let lastGraph: any = graph;
    const setGraph = (g: any) => { lastGraph = g; };

    await runStage2EnhancementsAndInboundN(
      [fetchItem()], [fetchItem()], { mode: 'from-file' } as any,
      graph, setGraph, 'window(1-Nov-25:7-Nov-25)',
      undefined, // batchLogId
      () => lastGraph, // getUpdatedGraph
    );

    // Wait for the subsequent overwrite to land.
    await yieldMs(800);

    const edge = lastGraph.edges.find((e: any) => (e.uuid || e.id) === EDGE_ID);
    expect(edge.p.latency.completeness).toBeCloseTo(0.93, 5);
  });

  it('passes scenarioId through to conditioned forecast and supports deterministic awaitBackgroundPromises', async () => {
    let observedScenarioId: string | undefined;
    cfImpl = async (...args: any[]) => {
      observedScenarioId = args[4];
      await yieldMs(700);
      return [
        {
          scenario_id: observedScenarioId || 'current',
          success: true,
          edges: [
            {
              edge_uuid: EDGE_ID,
              p_mean: 0.79,
              p_sd: 0.04,
              completeness: 0.91,
              completeness_sd: 0.04,
            },
          ],
        },
      ];
    };

    const graph = latencyGraph();
    let lastGraph: any = graph;
    const setGraph = (g: any) => { lastGraph = g; };

    await runStage2EnhancementsAndInboundN(
      [fetchItem()],
      [fetchItem()],
      {
        mode: 'from-file',
        scenarioId: 'scenario-123',
        awaitBackgroundPromises: true,
        cfSupersessionState: createConditionedForecastSupersessionState(),
      } as any,
      graph,
      setGraph,
      'window(1-Nov-25:7-Nov-25)',
      undefined,
      () => lastGraph,
      true,
    );

    expect(observedScenarioId).toBe('scenario-123');
    const edge = lastGraph.edges.find((e: any) => (e.uuid || e.id) === EDGE_ID);
    expect(edge.p.latency.completeness).toBeCloseTo(0.91, 5);
  });
});
