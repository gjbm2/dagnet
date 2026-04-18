/**
 * Conditioned forecast — completeness authority (RED tests).
 *
 * Doc 45 §Endpoint contract (lines 181-190) specifies the CF response
 * carries per-edge `completeness` and `completeness_sd`. Line 153-154:
 * "it produces per-edge scalars (p.mean, p_sd, completeness) that get
 * written back to the graph".
 *
 * User direction (this session):
 *   "CF ABSOLUTELY 100% OWNS COMPLETENESS. If it isn't writing that then
 *    it's a first class failure and a total deviation from design. [...]
 *    BE CF [should] overwrite the things it produces. but those are NOT
 *    just p.mean. it's ALL the conditioned f, f+e values, AND
 *    completeness, and anything else that a sophisticated conditioned
 *    forecast would naturally be FAR FUCKING BETTER AT THAN THE QUICK
 *    AND DIRTY FE PASS."
 *
 * These tests assert the FE-side contract that matches the design:
 *
 *   1. `ConditionedForecastEdgeResult` accepts `completeness` and
 *      `completeness_sd`. (Static: this file compiles only if the type
 *      permits these fields — so if they're missing from the type
 *      definition, the test file itself fails to typecheck.)
 *
 *   2. `applyConditionedForecastToGraph` OVERWRITES
 *      `edge.p.latency.completeness` and `edge.p.latency.completeness_stdev`
 *      with CF's values — NOT "preserves existing" (which is the
 *      current behaviour and is wrong).
 *
 *   3. End-to-end via `runStage2EnhancementsAndInboundN`:
 *      a. CF fast path: `completeness` on the edge is CF's value (not
 *         FE topo's CDF-derived value).
 *      b. CF slow path: after the subsequent-overwrite .then() fires,
 *         completeness reflects CF's value.
 *
 * These are RED today. They will pass once:
 *   - `ConditionedForecastEdgeResult` gets `completeness?` and
 *     `completeness_sd?`.
 *   - `applyConditionedForecastToGraph` writes completeness authoritatively.
 *   - `mergeCfIntoFe` (inside `runStage2EnhancementsAndInboundN`) merges
 *     CF's completeness into the FE fast-path apply.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Graph } from '../../types';

// ── Mocks for end-to-end tests (3a, 3b) ────────────────────────────────

let beTopoImpl: (...args: any[]) => Promise<any[]> = async () => [];
vi.mock('../beTopoPassService', () => ({
  runBeTopoPass: (...args: any[]) => beTopoImpl(...args),
}));

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
import { runStage2EnhancementsAndInboundN, type FetchItem } from '../fetchDataService';
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

describe('CF owns completeness (doc 45) — RED', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    beTopoImpl = async () => [];
    cfImpl = async () => [];
    registerParamFile();
    windowDsl();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. Type-level: ConditionedForecastEdgeResult declares the fields ─

  it('ConditionedForecastEdgeResult type permits completeness and completeness_sd (doc 45 §Response contract)', () => {
    // This test compiles only if the type declares these fields
    // (even as optional). If the type is missing them, tsc fails here.
    const example: ConditionedForecastEdgeResult = {
      edge_uuid: EDGE_ID,
      p_mean: 0.6,
      p_sd: 0.04,
      completeness: 0.75,
      completeness_sd: 0.08,
    };
    expect(example.completeness).toBe(0.75);
    expect(example.completeness_sd).toBe(0.08);
  });

  // ── 2. applyConditionedForecastToGraph OVERWRITES completeness ──────

  it('applyConditionedForecastToGraph overwrites edge.p.latency.completeness with CF value', () => {
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
            completeness: 0.85,       // doc 45 — CF's own value
            completeness_sd: 0.07,
          },
        ],
      },
    ];

    const updated = applyConditionedForecastToGraph(graph, results);
    const edge = updated.edges.find((e: any) => (e.uuid || e.id) === EDGE_ID);
    expect(edge.p.latency.completeness).toBeCloseTo(0.85, 5);
    // NOT the old value (0.42).
    expect(edge.p.latency.completeness).not.toBeCloseTo(0.42, 5);
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
});
