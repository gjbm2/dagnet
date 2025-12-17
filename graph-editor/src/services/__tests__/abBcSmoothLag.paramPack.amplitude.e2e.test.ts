/**
 * E2E (Amplitude-stubbed) Test: Smooth lag data → param-pack outcomes
 *
 * Goal:
 * - Use production code from "retrieve data" → merge into parameter file → apply to graph → param pack.
 * - Mock ONLY the Amplitude HTTP interface (DAS HTTP executor) using recorded payload fixtures.
 *
 * Fixtures live under:
 * - param-registry/test/graphs/ab-bc-smooth-lag-rebalance.json
 * - param-registry/test/parameters/{ab-smooth-lag,bc-smooth-lag}.yaml
 * - param-registry/test/events/{event-a,event-b,event-c}.yaml
 * - param-registry/test/amplitude/*.amplitude-response.json
 *
 * Expectations (July only):
 * - window(1-Jul-25:31-Jul-25) → B→C p.mean = 50%
 * - cohort(1-Jul-25:31-Jul-25) → B→C p.mean = 50%
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { fetch as undiciFetch } from 'undici';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// -----------------------------------------------------------------------------
// Force DAS (node) to use the shipped connections.yaml
// -----------------------------------------------------------------------------

// NOTE: This constant is used from within `vi.mock(...)` factories, which are hoisted
// above imports. Avoid referencing imported modules (e.g., `path`) here.
const CONNECTIONS_PATH = `${process.cwd()}/public/defaults/connections.yaml`;

vi.mock('../../lib/das', async () => {
  const actual = await vi.importActual<any>('../../lib/das');
  return {
    ...actual,
    createDASRunner: (options: any = {}) =>
      actual.createDASRunner({ ...options, serverConnectionsPath: CONNECTIONS_PATH }),
  };
});

// -----------------------------------------------------------------------------
// Mock ONLY the HTTP executor used by DAS in node (Amplitude interface)
// -----------------------------------------------------------------------------

type AnyObject = Record<string, any>;

function yyyymmddToIso(yyyymmdd: string): string {
  if (!/^\d{8}$/.test(yyyymmdd)) return yyyymmdd;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function isoToYyyymmdd(iso: string): string {
  return iso.replace(/-/g, '');
}

function sliceAmplitudeResponse(full: AnyObject, startIso: string, endIso: string): AnyObject {
  const start = isoToYyyymmdd(startIso);
  const end = isoToYyyymmdd(endIso);

  const dayFunnels = full?.data?.[0]?.dayFunnels;
  const xValues: string[] = dayFunnels?.xValues ?? [];

  const idxs: number[] = [];
  for (let i = 0; i < xValues.length; i++) {
    const d = isoToYyyymmdd(xValues[i]);
    if (d >= start && d <= end) idxs.push(i);
  }

  const pick = <T>(arr: T[]): T[] => idxs.map(i => arr[i]).filter(v => v !== undefined);

  const series: number[][] = pick(dayFunnels?.series ?? []);
  const steps = series[0]?.length ?? 0;

  const cumulativeRaw = new Array(steps).fill(0);
  for (const row of series) {
    for (let s = 0; s < steps; s++) cumulativeRaw[s] += row[s] ?? 0;
  }

  const cumulative = cumulativeRaw.map((v, i) => (i === 0 ? 1.0 : (cumulativeRaw[0] > 0 ? v / cumulativeRaw[0] : 0)));
  const stepByStep = cumulativeRaw.map((v, i) => (i === 0 ? 1.0 : ((cumulativeRaw[i - 1] ?? 0) > 0 ? v / cumulativeRaw[i - 1] : 0)));

  const perDayMedian = pick(full?.data?.[0]?.dayMedianTransTimes?.series ?? []);
  const perDayAvg = pick(full?.data?.[0]?.dayAvgTransTimes?.series ?? []);

  return {
    ...full,
    data: [
      {
        ...full.data[0],
        cumulativeRaw,
        cumulative,
        stepByStep,
        dayFunnels: {
          ...full.data[0].dayFunnels,
          xValues: pick(full.data[0].dayFunnels.xValues),
          formattedXValues: pick(full.data[0].dayFunnels.formattedXValues ?? full.data[0].dayFunnels.xValues),
          series,
        },
        dayMedianTransTimes: full.data[0].dayMedianTransTimes
          ? {
              ...full.data[0].dayMedianTransTimes,
              xValues: pick(full.data[0].dayMedianTransTimes.xValues ?? full.data[0].dayFunnels.xValues),
              formattedXValues: pick(full.data[0].dayMedianTransTimes.formattedXValues ?? full.data[0].dayFunnels.xValues),
              series: perDayMedian,
            }
          : full.data[0].dayMedianTransTimes,
        dayAvgTransTimes: full.data[0].dayAvgTransTimes
          ? {
              ...full.data[0].dayAvgTransTimes,
              xValues: pick(full.data[0].dayAvgTransTimes.xValues ?? full.data[0].dayFunnels.xValues),
              formattedXValues: pick(full.data[0].dayAvgTransTimes.formattedXValues ?? full.data[0].dayFunnels.xValues),
              series: perDayAvg,
            }
          : full.data[0].dayAvgTransTimes,
      },
    ],
  };
}

vi.mock('../../lib/das/ServerHttpExecutor', async () => {
  // `process.cwd()` is `graph-editor/` when running `npm test` from that package.
  const fixtureRoot = `${process.cwd()}/../param-registry/test/amplitude`;
  const abPath = `${fixtureRoot}/ab-smooth-lag.amplitude-response.json`;
  const bcPath = `${fixtureRoot}/bc-smooth-lag.amplitude-response.json`;

  const abFull = JSON.parse(fs.readFileSync(abPath, 'utf8'));
  const bcCombined = JSON.parse(fs.readFileSync(bcPath, 'utf8'));

  const pickResponse = (urlStr: string): AnyObject => {
    const url = new URL(urlStr);
    const start = yyyymmddToIso(url.searchParams.get('start') || '');
    const end = yyyymmddToIso(url.searchParams.get('end') || '');

    const events = url.searchParams.getAll('e').map((e) => {
      try {
        const parsed = JSON.parse(decodeURIComponent(e));
        return parsed?.event_type ?? '';
      } catch {
        return '';
      }
    });

    const stepCount = events.length;
    const key = events.join('>');

    // A→B (2-step)
    if (stepCount === 2 && key.includes('Event A') && key.includes('Event B') && !key.includes('Event C')) {
      return sliceAmplitudeResponse(abFull, start, end);
    }

    // B→C (2-step, window mode)
    if (stepCount === 2 && key.includes('Event B') && key.includes('Event C') && !key.includes('Event A')) {
      return sliceAmplitudeResponse(bcCombined.two_step, start, end);
    }

    // A→B→C (3-step, cohort mode with anchor)
    if (stepCount === 3 && key.includes('Event A') && key.includes('Event B') && key.includes('Event C')) {
      return sliceAmplitudeResponse(bcCombined.three_step, start, end);
    }

    throw new Error(`[abBcSmoothLag] Unrecognised Amplitude request (steps=${stepCount}): ${urlStr}`);
  };

  return {
    ServerHttpExecutor: class {
      // eslint-disable-next-line class-methods-use-this
      async execute(request: any) {
        const body = pickResponse(request.url);
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body,
          rawBody: JSON.stringify(body),
        };
      }
    },
  };
});

// -----------------------------------------------------------------------------
// Real production imports (after mocks)
// -----------------------------------------------------------------------------

import type { Graph } from '../../types';
import { credentialsManager } from '../../lib/credentials';
import { fetchItem, type FetchItem } from '../fetchDataService';
import { extractParamsFromGraph } from '../GraphParamExtractor';
import { flattenParams } from '../ParamPackDSLService';
import { fileRegistry } from '../../contexts/TabContext';
import { db } from '../../db/appDatabase';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function loadJson(relPath: string): any {
  const abs = path.resolve(__dirname, relPath);
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

function loadYaml(relPath: string): any {
  const abs = path.resolve(__dirname, relPath);
  return yaml.load(fs.readFileSync(abs, 'utf8'));
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

async function withFixedNow<T>(isoDateTime: string, fn: () => Promise<T>): Promise<T> {
  const fixed = new Date(isoDateTime).getTime();
  const spy = vi.spyOn(Date, 'now').mockReturnValue(fixed);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

async function analyzeReachProbabilityViaPython(
  graph: Graph,
  queryDsl: string,
  visibilityMode: 'f+e' | 'f' | 'e' = 'f+e'
): Promise<number> {
  // NOTE: 0.0.0.0 is a bind address, not a client address. Use localhost by default.
  const baseUrl = process.env.DAGNET_PYTHON_API_URL || process.env.VITE_PYTHON_API_URL || 'http://localhost:9000';
  const url = `${baseUrl}/api/runner/analyze`;

  const request = {
    scenarios: [
      {
        scenario_id: 'current',
        name: 'Current',
        colour: '#3b82f6',
        visibility_mode: visibilityMode,
        graph,
      },
    ],
    query_dsl: queryDsl,
    analysis_type: 'to_node_reach',
  };

  let response: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    // IMPORTANT: tests/setup.ts stubs globalThis.fetch and intentionally blocks localhost.
    // Use Undici directly so we can hit the real local Uvicorn server.
    response = await undiciFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch (e: any) {
    throw new Error(
      `Python GraphCompute server is not reachable at ${url}. ` +
      `Start it with: cd graph-editor && . venv/bin/activate && python dev-server.py\n\n` +
      `Original error: ${e?.message || String(e)}`
    );
  }

  const rawText = await response.text();
  let body: any;
  try {
    body = JSON.parse(rawText);
  } catch {
    throw new Error(
      `Python analysis returned non-JSON from ${url} (HTTP ${response.status}). ` +
      `Body:\n${rawText}`
    );
  }
  if (!response.ok || !body?.success) {
    throw new Error(`Python analysis failed (${response.status}): ${JSON.stringify(body)}`);
  }

  const rows: any[] = body?.result?.data || [];
  const row = rows.find(r => r?.scenario_id === 'current') || rows[0];
  const probability = row?.probability;
  if (typeof probability !== 'number') {
    throw new Error(`Python analysis response missing numeric probability: ${JSON.stringify(body)}`);
  }
  return probability;
}

async function isPythonGraphComputeReachable(): Promise<boolean> {
  const baseUrl = process.env.DAGNET_PYTHON_API_URL || process.env.VITE_PYTHON_API_URL || 'http://localhost:9000';
  const url = `${baseUrl}/api/runner/analyze`;
  try {
    // Minimal reachability check; we only care whether the socket is reachable.
    await undiciFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return true;
  } catch {
    return false;
  }
}

const PYTHON_GRAPHCOMPUTE_AVAILABLE = process.env.CI ? await isPythonGraphComputeReachable() : true;
const describePython = (process.env.CI && !PYTHON_GRAPHCOMPUTE_AVAILABLE) ? describe.skip : describe;

describePython('E2E: Smooth lag Amplitude responses → param-pack stats', () => {

  beforeAll(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Hard reset between tests: both the in-memory FileRegistry cache and IndexedDB.
    // Without this, versioned fetch can hit old parameter-file state and silently reuse July data.
    // NOTE: In node (fake-indexeddb) Dexie.delete() can trip browser-only code paths (CustomEvent).
    // Clearing tables is sufficient and keeps this fully production-code.
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
      // Best-effort only.
    }

    // Ensure credentials are always present for the Amplitude adapter's Basic auth header.
    vi.spyOn(credentialsManager, 'loadCredentials').mockResolvedValue({
      success: true,
      source: 'mock' as any,
      credentials: {
        amplitude: {
          api_key: 'test-api-key',
          secret_key: 'test-secret-key',
          basic_auth_b64: Buffer.from('test-api-key:test-secret-key').toString('base64'),
        },
      },
    } as any);
    vi.spyOn(credentialsManager, 'getProviderCredentials').mockReturnValue({
      api_key: 'test-api-key',
      secret_key: 'test-secret-key',
      basic_auth_b64: Buffer.from('test-api-key:test-secret-key').toString('base64'),
    } as any);

    // Register fixture param + event files as if they were loaded into the workspace.
    const abParam = loadYaml('../../../../param-registry/test/parameters/ab-smooth-lag.yaml');
    const bcParam = loadYaml('../../../../param-registry/test/parameters/bc-smooth-lag.yaml');
    const evA = loadYaml('../../../../param-registry/test/events/event-a.yaml');
    const evB = loadYaml('../../../../param-registry/test/events/event-b.yaml');
    const evC = loadYaml('../../../../param-registry/test/events/event-c.yaml');

    await registerFileForTest('parameter-ab-smooth-lag', 'parameter', abParam);
    await registerFileForTest('parameter-bc-smooth-lag', 'parameter', bcParam);
    await registerFileForTest('event-event-a', 'event', evA);
    await registerFileForTest('event-event-b', 'event', evB);
    await registerFileForTest('event-event-c', 'event', evC);
  });

  it('July window vs July cohort produce identical B→C p.mean = 25%', async () => {
    await withFixedNow('2025-07-31T12:00:00Z', async () => {
      const graph = loadJson('../../../../param-registry/test/graphs/ab-bc-smooth-lag-rebalance.json') as Graph;
      let currentGraph: Graph | null = structuredClone(graph);
      const setGraph = (g: Graph | null) => { currentGraph = g; };

    const abItem: FetchItem = {
      id: 'param-ab-smooth-lag-p-A-B',
      type: 'parameter',
      name: 'p: ab-smooth-lag',
      objectId: 'ab-smooth-lag',
      targetId: 'A-B',
      paramSlot: 'p',
    };

    const item: FetchItem = {
      id: 'param-bc-smooth-lag-p-B-C',
      type: 'parameter',
      name: 'p: bc-smooth-lag',
      objectId: 'bc-smooth-lag',
      targetId: 'B-C',
      paramSlot: 'p',
    };

    // Window semantics: X-event dates (B→C), but the query itself is A-conditioned via visited(A).
      const windowDsl = 'window(1-Jul-25:31-Jul-25)';
      const r0 = await fetchItem(abItem, { mode: 'versioned' }, currentGraph as Graph, setGraph, windowDsl);
      expect(r0.success).toBe(true);
      const r1 = await fetchItem(item, { mode: 'versioned' }, currentGraph as Graph, setGraph, windowDsl);
      expect(r1.success).toBe(true);

      const packAfterWindow = flattenParams(extractParamsFromGraph(currentGraph));
      expect(packAfterWindow['e.A-B.p.mean']).toBeCloseTo(0.5, 10);
      expect(packAfterWindow['e.B-C.p.mean']).toBeCloseTo(0.25, 10);

    // Reach Probability analysis (Python GraphCompute): reach(C) = 50% * 25% = 12.5% in July.
      expect(await analyzeReachProbabilityViaPython(currentGraph as Graph, 'to(C)')).toBeCloseTo(0.125, 10);

    // Cohort semantics: A-entry dates (anchor = A via edge latency config), step indices shift to extract B→C.
      const cohortDsl = 'cohort(1-Jul-25:31-Jul-25)';
      const r2 = await fetchItem(item, { mode: 'versioned' }, currentGraph as Graph, setGraph, cohortDsl);
      expect(r2.success).toBe(true);

      const packAfterCohort = flattenParams(extractParamsFromGraph(currentGraph));
      expect(packAfterCohort['e.B-C.p.mean']).toBeCloseTo(0.25, 10);
      expect(await analyzeReachProbabilityViaPython(currentGraph as Graph, 'to(C)')).toBeCloseTo(0.125, 10);
    });
  });

  it('Aug window vs Aug cohort produce identical reach(to(C)) = 25%', async () => {
    await withFixedNow('2025-08-31T12:00:00Z', async () => {
      const graph = loadJson('../../../../param-registry/test/graphs/ab-bc-smooth-lag-rebalance.json') as Graph;
      let currentGraph: Graph | null = structuredClone(graph);
      const setGraph = (g: Graph | null) => { currentGraph = g; };

    const abItem: FetchItem = {
      id: 'param-ab-smooth-lag-p-A-B',
      type: 'parameter',
      name: 'p: ab-smooth-lag',
      objectId: 'ab-smooth-lag',
      targetId: 'A-B',
      paramSlot: 'p',
    };

    const bcItem: FetchItem = {
      id: 'param-bc-smooth-lag-p-B-C',
      type: 'parameter',
      name: 'p: bc-smooth-lag',
      objectId: 'bc-smooth-lag',
      targetId: 'B-C',
      paramSlot: 'p',
    };

    // Window: Aug B→C is 50%, so reach(C) = 50% * 50% = 25%
      const augWindowDsl = 'window(1-Aug-25:31-Aug-25)';
      const r0 = await fetchItem(abItem, { mode: 'versioned' }, currentGraph as Graph, setGraph, augWindowDsl);
      expect(r0.success).toBe(true);
      const r1 = await fetchItem(bcItem, { mode: 'versioned' }, currentGraph as Graph, setGraph, augWindowDsl);
      expect(r1.success).toBe(true);

      const packAfterWindow = flattenParams(extractParamsFromGraph(currentGraph));
      expect(packAfterWindow['e.A-B.p.mean']).toBeCloseTo(0.5, 10);
      expect(packAfterWindow['e.B-C.p.mean']).toBeCloseTo(0.5, 10);
      expect(await analyzeReachProbabilityViaPython(currentGraph as Graph, 'to(C)')).toBeCloseTo(0.25, 10);

    // Cohort: Aug should be the same reach probability in this smooth fixture.
      const augCohortDsl = 'cohort(1-Aug-25:31-Aug-25)';
      const r2 = await fetchItem(abItem, { mode: 'versioned' }, currentGraph as Graph, setGraph, augCohortDsl);
      expect(r2.success).toBe(true);
      const r3 = await fetchItem(bcItem, { mode: 'versioned' }, currentGraph as Graph, setGraph, augCohortDsl);
      expect(r3.success).toBe(true);

      const packAfterCohort = flattenParams(extractParamsFromGraph(currentGraph));
      expect(packAfterCohort['e.A-B.p.mean']).toBeCloseTo(0.5, 10);
      expect(packAfterCohort['e.B-C.p.mean']).toBeCloseTo(0.5, 10);
      expect(await analyzeReachProbabilityViaPython(currentGraph as Graph, 'to(C)')).toBeCloseTo(0.25, 10);
    });
  }, 30_000);

  it('Jul–Aug window reach(to(C)) is stable; f+e (blended) > e (evidence-only) after step-up', async () => {
    await withFixedNow('2025-08-31T12:00:00Z', async () => {
      const graph = loadJson('../../../../param-registry/test/graphs/ab-bc-smooth-lag-rebalance.json') as Graph;
      let currentGraph: Graph | null = structuredClone(graph);
      const setGraph = (g: Graph | null) => { currentGraph = g; };

    const abItem: FetchItem = {
      id: 'param-ab-smooth-lag-p-A-B',
      type: 'parameter',
      name: 'p: ab-smooth-lag',
      objectId: 'ab-smooth-lag',
      targetId: 'A-B',
      paramSlot: 'p',
    };

    const bcItem: FetchItem = {
      id: 'param-bc-smooth-lag-p-B-C',
      type: 'parameter',
      name: 'p: bc-smooth-lag',
      objectId: 'bc-smooth-lag',
      targetId: 'B-C',
      paramSlot: 'p',
    };

      const combinedWindowDsl = 'window(1-Jul-25:31-Aug-25)';
      const r0 = await fetchItem(abItem, { mode: 'versioned' }, currentGraph as Graph, setGraph, combinedWindowDsl);
      expect(r0.success).toBe(true);
      const r1 = await fetchItem(bcItem, { mode: 'versioned' }, currentGraph as Graph, setGraph, combinedWindowDsl);
      expect(r1.success).toBe(true);

      // f+e uses p.mean (which may be a blended/forecast-influenced value)
      const reachBlended = await analyzeReachProbabilityViaPython(currentGraph as Graph, 'to(C)', 'f+e');
      // evidence uses p.evidence.mean (pure window evidence)
      const reachEvidence = await analyzeReachProbabilityViaPython(currentGraph as Graph, 'to(C)', 'e');

      // With a step-up in Aug, the blend should be pulled upward vs the window evidence average.
      // Model tuning (λ, completeness, recency weighting) can move this slightly; keep the band outcome-focused.
      expect(reachBlended).toBeGreaterThanOrEqual(0.19);
      expect(reachBlended).toBeLessThanOrEqual(0.205);

      // Evidence over the whole window should be ~18.75% (0.5 * 0.375).
      expect(reachEvidence).toBeGreaterThanOrEqual(0.185);
      expect(reachEvidence).toBeLessThanOrEqual(0.19);

      // Sanity: blended should be >= evidence here because Aug is better and blending is recency/forecast-influenced.
      expect(reachBlended).toBeGreaterThanOrEqual(reachEvidence);
    });
  }, 30_000);
});


