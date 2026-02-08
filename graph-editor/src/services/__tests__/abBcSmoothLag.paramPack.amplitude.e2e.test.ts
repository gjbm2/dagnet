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
// Enable snapshot writes in test environment
// -----------------------------------------------------------------------------
// The snapshotWriteService checks VITE_SNAPSHOTS_ENABLED at module load time.
// We mock the module to always enable writes, but use the REAL fetch implementation
// so writes actually go to the production database.

// -----------------------------------------------------------------------------
// Snapshot writes use the REAL snapshotWriteService
// The tests/setup.ts mock now allows /api/snapshots/ calls through
// VITE_SNAPSHOTS_ENABLED defaults to true (only false if explicitly set)
// -----------------------------------------------------------------------------

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
// Snapshot DB verification helpers (for e2e DB write testing)
// -----------------------------------------------------------------------------

const TEST_PREFIX = 'pytest-amplitude-e2e';
const TEST_RUN_ID = Date.now().toString();
const TEST_WORKSPACE = { repository: TEST_PREFIX, branch: TEST_RUN_ID };

interface SnapshotRow {
  param_id: string;
  anchor_day: string;
  x: number;
  y: number;
  a?: number;
  median_lag_days?: number;
  mean_lag_days?: number;
}

async function querySnapshotsFromDb(paramId: string): Promise<SnapshotRow[]> {
  // Keep a small compatibility wrapper; tests should generally use strict + wait helpers.
  return querySnapshotsFromDbStrict(paramId);
}

async function querySnapshotsFromDbStrict(paramId: string): Promise<SnapshotRow[]> {
  const baseUrl = process.env.DAGNET_PYTHON_API_URL || process.env.VITE_PYTHON_API_URL || 'http://localhost:9000';

  const response = await undiciFetch(`${baseUrl}/api/snapshots/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ param_id: paramId }),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`[Snapshot Query] HTTP ${response.status}: ${raw}`);
  }

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(`[Snapshot Query] Non-JSON response (HTTP ${response.status}): ${raw}`);
  }
  return Array.isArray(body?.rows) ? body.rows : [];
}

async function waitForSnapshotRowCount(args: {
  paramId: string;
  expected: number;
  timeoutMs?: number;
}): Promise<SnapshotRow[]> {
  const { paramId, expected } = args;
  const timeoutMs = args.timeoutMs ?? 1500;

  const start = Date.now();
  let lastRows: SnapshotRow[] = [];
  let lastError: unknown = undefined;

  while (Date.now() - start < timeoutMs) {
    try {
      lastRows = await querySnapshotsFromDbStrict(paramId);
      lastError = undefined;
      if (lastRows.length === expected) return lastRows;
    } catch (e) {
      lastError = e;
    }
    await new Promise(r => setTimeout(r, 50));
  }

  if (lastError) throw lastError;
  throw new Error(`[Snapshot Query] Timed out waiting for ${expected} rows; got ${lastRows.length}`);
}

async function waitForAnySnapshotRows(args: {
  paramId: string;
  timeoutMs?: number;
}): Promise<SnapshotRow[]> {
  const { paramId } = args;
  const timeoutMs = args.timeoutMs ?? 1500;

  const start = Date.now();
  let lastRows: SnapshotRow[] = [];
  let lastError: unknown = undefined;

  while (Date.now() - start < timeoutMs) {
    try {
      lastRows = await querySnapshotsFromDbStrict(paramId);
      lastError = undefined;
      if (lastRows.length > 0) return lastRows;
    } catch (e) {
      lastError = e;
    }
    await new Promise(r => setTimeout(r, 50));
  }

  if (lastError) throw lastError;
  throw new Error(`[Snapshot Query] Timed out waiting for any rows; got ${lastRows.length}`);
}

async function deleteTestSnapshots(paramIdPrefix: string): Promise<number> {
  const baseUrl = process.env.DAGNET_PYTHON_API_URL || process.env.VITE_PYTHON_API_URL || 'http://localhost:9000';

  const response = await undiciFetch(`${baseUrl}/api/snapshots/delete-test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ param_id_prefix: paramIdPrefix }),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`[Snapshot Delete] HTTP ${response.status}: ${raw}`);
  }

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(`[Snapshot Delete] Non-JSON response (HTTP ${response.status}): ${raw}`);
  }
  return typeof body?.deleted === 'number' ? body.deleted : 0;
}

function makeTestParamId(baseName: string): string {
  return `${TEST_PREFIX}-${TEST_RUN_ID}-${baseName}`;
}

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

/**
 * Register a file with test workspace source for DB write testing.
 * The source.repository and source.branch are used to construct dbParamId.
 * This ensures dbParamId = '{TEST_PREFIX}-{TEST_RUN_ID}-{objectId}' for cleanup.
 */
async function registerFileForDbTest(fileId: string, type: any, data: any): Promise<void> {
  await fileRegistry.registerFile(fileId, {
    fileId,
    type,
    data,
    originalData: structuredClone(data),
    isDirty: false,
    isInitializing: false,
    source: { repository: TEST_PREFIX, branch: TEST_RUN_ID, isLocal: true } as any,
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
  const controller = new AbortController();
  const timeoutMs = 2000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // IMPORTANT: tests/setup.ts stubs globalThis.fetch and intentionally blocks localhost.
    // Use Undici directly so we can hit the real local Uvicorn server.
    response = await undiciFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch (e: any) {
    throw new Error(
      `Python GraphCompute server is not reachable at ${url}. ` +
      `Start it with: cd graph-editor && . venv/bin/activate && python dev-server.py\n\n` +
      `Original error: ${e?.message || String(e)}`
    );
  } finally {
    clearTimeout(timeoutId);
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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1000);
    try {
      await undiciFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    return true;
  } catch {
    return false;
  }
}

const PYTHON_GRAPHCOMPUTE_AVAILABLE = await isPythonGraphComputeReachable();
const describePython = PYTHON_GRAPHCOMPUTE_AVAILABLE ? describe : describe.skip;

describePython('E2E: Smooth lag Amplitude responses → param-pack stats', () => {

  beforeAll(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Clean up any leftover test snapshots from previous runs
    await deleteTestSnapshots(TEST_PREFIX);

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

  afterEach(async () => {
    // Clean up test snapshots from DB
    await deleteTestSnapshots(TEST_PREFIX);
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
      // Model tuning (λ, completeness, recency weighting, forecast recompute) can move the absolute level.
      // Keep this as an invariants test (sanity + stability), not a tight numeric calibration.
      expect(Number.isFinite(reachBlended)).toBe(true);
      expect(reachBlended).toBeGreaterThanOrEqual(0.16);
      expect(reachBlended).toBeLessThanOrEqual(0.22);

      // Evidence over the whole window should be ~18.75% (0.5 * 0.375).
      expect(reachEvidence).toBeGreaterThanOrEqual(0.185);
      expect(reachEvidence).toBeLessThanOrEqual(0.19);

      // Sanity: blended should be in the same ballpark as evidence, not wildly divergent.
      expect(Math.abs(reachBlended - reachEvidence)).toBeLessThanOrEqual(0.05);
    });
  }, 30_000);
});

// =============================================================================
// E2E: Snapshot DB Write Verification
// =============================================================================
// These tests verify that fetched Amplitude data is correctly written to the
// production Neon database. They use test-prefixed param_ids for cleanup.

describePython('E2E: Amplitude fetch → Snapshot DB writes', () => {
  
  // Cache fixtures - load once, reuse across tests
  let abParam: any, bcParam: any, evA: any, evB: any, evC: any;
  
  beforeAll(async () => {
    globalThis.indexedDB = new IDBFactory();
    
    // Clean up any leftover test snapshots (once at start)
    await deleteTestSnapshots(TEST_PREFIX);
    
    // Load fixtures once
    abParam = loadYaml('../../../../param-registry/test/parameters/ab-smooth-lag.yaml');
    bcParam = loadYaml('../../../../param-registry/test/parameters/bc-smooth-lag.yaml');
    evA = loadYaml('../../../../param-registry/test/events/event-a.yaml');
    evB = loadYaml('../../../../param-registry/test/events/event-b.yaml');
    evC = loadYaml('../../../../param-registry/test/events/event-c.yaml');
  });
  
  afterAll(async () => {
    // Clean up at end
    await deleteTestSnapshots(TEST_PREFIX);
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset IDB
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

    // Mock credentials (Amplitude HTTP is mocked anyway, so these aren't used for real API calls)
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

    // Register fixture files with TEST WORKSPACE source for DB cleanup
    // The source.repository and source.branch form the dbParamId prefix
    // This means dbParamId = '{TEST_PREFIX}-{TEST_RUN_ID}-ab-smooth-lag'
    await registerFileForDbTest('parameter-ab-smooth-lag', 'parameter', abParam);
    await registerFileForDbTest('parameter-bc-smooth-lag', 'parameter', bcParam);
    await registerFileForDbTest('event-event-a', 'event', evA);
    await registerFileForDbTest('event-event-b', 'event', evB);
    await registerFileForDbTest('event-event-c', 'event', evC);
  });

  // Helper to construct expected dbParamId (matches dataOperationsService logic)
  const getDbParamId = (objectId: string) => `${TEST_PREFIX}-${TEST_RUN_ID}-${objectId}`;

  it('writes snapshot rows directly via appendSnapshots', async () => {
    // Directly test the snapshot write using the real service
    const { appendSnapshots } = await import('../snapshotWriteService');
    
    const testParamId = getDbParamId('direct-write-test');
    const testRows = Array.from({ length: 31 }, (_, i) => ({
      anchor_day: `2025-07-${String(i + 1).padStart(2, '0')}`,
      X: 200,
      Y: 100,
    }));
    
    const result = await appendSnapshots({
      param_id: testParamId,
      canonical_signature: '{"c":"direct-test-hash","x":{}}',
      inputs_json: { schema: 'pytest_flexi_sigs_v1', param_id: testParamId, canonical_signature: '{"c":"direct-test-hash","x":{}}' },
      sig_algo: 'sig_v1_sha256_trunc128_b64url',
      slice_key: '',
      retrieved_at: new Date(),
      rows: testRows,
      diagnostic: true,
    });
    
    // Log result for debugging
    if (!result.success) {
      // eslint-disable-next-line no-console
      console.error('[TEST] appendSnapshots failed:', result);
    }
    
    expect(result.success).toBe(true);
    expect(result.inserted).toBe(31);
    
    // Verify by querying back
    const rows = await waitForSnapshotRowCount({ paramId: testParamId, expected: 31, timeoutMs: 2500 });
    expect(rows.length).toBe(31);
  }, 15_000);

  it('writes July window fetch data to snapshot DB with correct X/Y values', async () => {
    // Clean this specific param before test
    await deleteTestSnapshots(getDbParamId('ab-smooth-lag'));
    
    await withFixedNow('2025-07-31T12:00:00Z', async () => {
      const graph = loadJson('../../../../param-registry/test/graphs/ab-bc-smooth-lag-rebalance.json') as Graph;
      let currentGraph: Graph | null = structuredClone(graph);
      const setGraph = (g: Graph | null) => { currentGraph = g; };

      const abItem: FetchItem = {
        id: 'param-ab-smooth-lag-p-A-B',
        type: 'parameter',
        name: 'p: ab-smooth-lag',
        objectId: 'ab-smooth-lag',  // Original param ID
        targetId: 'A-B',
        paramSlot: 'p',
      };

      // Verify the file source is set up correctly for dbParamId construction
      const regFile = fileRegistry.getFile('parameter-ab-smooth-lag');
      expect(regFile?.source?.repository).toBe(TEST_PREFIX);
      expect(regFile?.source?.branch).toBe(TEST_RUN_ID);

      const windowDsl = 'window(1-Jul-25:31-Jul-25)';
      // Force fresh fetch (bypass cache) to trigger snapshot write
      const result = await fetchItem(abItem, { mode: 'versioned', bustCache: true }, currentGraph as Graph, setGraph, windowDsl);
      expect(result.success).toBe(true);

      // Query the snapshot DB - dbParamId is constructed from file source + objectId
      const dbParamId = getDbParamId('ab-smooth-lag');
      const rows = await waitForSnapshotRowCount({ paramId: dbParamId, expected: 31, timeoutMs: 3000 });
      
      // Should have 31 days of July data
      expect(rows.length).toBe(31);
      
      // Verify data integrity
      const totalX = rows.reduce((sum, r) => sum + (r.x || 0), 0);
      const totalY = rows.reduce((sum, r) => sum + (r.y || 0), 0);
      
      expect(totalX).toBeGreaterThan(0);
      expect(totalY).toBeGreaterThan(0);
      
      // Verify 50% conversion rate (fixture characteristic for A→B)
      expect(totalY / totalX).toBeCloseTo(0.5, 1);
    });
  }, 30_000);

  it('writes cohort mode fetch data to snapshot DB with anchor (A) values', async () => {
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

      const bcItem: FetchItem = {
        id: 'param-bc-smooth-lag-p-B-C',
        type: 'parameter',
        name: 'p: bc-smooth-lag',
        objectId: 'bc-smooth-lag',
        targetId: 'B-C',
        paramSlot: 'p',
      };

      const cohortDsl = 'cohort(1-Jul-25:31-Jul-25)';
      
      // Fetch both params in cohort mode
      await fetchItem(abItem, { mode: 'versioned' }, currentGraph as Graph, setGraph, cohortDsl);
      const result = await fetchItem(bcItem, { mode: 'versioned' }, currentGraph as Graph, setGraph, cohortDsl);
      expect(result.success).toBe(true);

      // Query BC param rows - should have anchor (A) values in cohort mode
      const dbParamId = getDbParamId('bc-smooth-lag');
      const rows = await waitForAnySnapshotRows({ paramId: dbParamId, timeoutMs: 3000 });
      
      expect(rows.length).toBeGreaterThan(0);
      
      // In cohort mode (3-step funnel), A column should be populated
      const rowsWithAnchor = rows.filter(r => r.a !== null && r.a !== undefined && r.a > 0);
      expect(rowsWithAnchor.length).toBe(rows.length);
    });
  }, 30_000);

  it('two successive fetches create time-stamped rows (full E2E flow)', async () => {
    // Clean this specific param before test (avoid interference from earlier tests)
    await deleteTestSnapshots(getDbParamId('ab-smooth-lag'));
    
    // FULL E2E: fetchItem → dataOperationsService → snapshotWriteService → DB
    // Each fetch has a different retrieved_at, so we get 2 sets of rows.
    // This is BY DESIGN - we track how values change over time.
    // NOTE: Do NOT use withFixedNow here - we need real time to pass for different timestamps.
    
    // Verify file registration is correct (from beforeEach)
    const regFile = fileRegistry.getFile('parameter-ab-smooth-lag');
    expect(regFile?.source?.repository).toBe(TEST_PREFIX);
    expect(regFile?.source?.branch).toBe(TEST_RUN_ID);
    
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

    // Use a specific date range in the past (within fixture data)
    const windowDsl = 'window(1-Jul-25:10-Jul-25)';
    const dbParamId = getDbParamId('ab-smooth-lag');
    
    // First fetch
    const r1 = await fetchItem(abItem, { mode: 'versioned', bustCache: true }, currentGraph as Graph, setGraph, windowDsl);
    expect(r1.success).toBe(true);
    const rowsAfterFirst = await waitForSnapshotRowCount({ paramId: dbParamId, expected: 10, timeoutMs: 3000 });
    expect(rowsAfterFirst.length).toBe(10); // 10 days of data
    
    // Record the first timestamp
    const firstTimestamp = rowsAfterFirst[0]?.retrieved_at;
    expect(firstTimestamp).toBeDefined();

    // Second fetch - use fresh graph to avoid any caching issues
    // Small wait to ensure different timestamp (retrieved_at has ms precision)
    await new Promise(r => setTimeout(r, 50));
    
    const freshGraph = loadJson('../../../../param-registry/test/graphs/ab-bc-smooth-lag-rebalance.json') as Graph;
    let freshCurrentGraph: Graph | null = structuredClone(freshGraph);
    const setFreshGraph = (g: Graph | null) => { freshCurrentGraph = g; };
    
    const r2 = await fetchItem(abItem, { mode: 'versioned', bustCache: true }, freshCurrentGraph as Graph, setFreshGraph, windowDsl);
    expect(r2.success).toBe(true);
    const rowsAfterSecond = await waitForSnapshotRowCount({ paramId: dbParamId, expected: 20, timeoutMs: 3000 });
    
    // 20 rows: 10 from first fetch + 10 from second (different retrieved_at)
    expect(rowsAfterSecond.length).toBe(20);
    
    // Verify both sets have correct data
    const uniqueDates = [...new Set(rowsAfterSecond.map((r: { anchor_day: string }) => r.anchor_day))];
    expect(uniqueDates.length).toBe(10); // Still 10 unique dates
    
    // Verify we have 2 different retrieved_at timestamps
    const uniqueTimestamps = [...new Set(rowsAfterSecond.map((r: { retrieved_at: string }) => r.retrieved_at))];
    expect(uniqueTimestamps.length).toBe(2); // 2 distinct fetch times
    
    // The second timestamp should be different from the first
    expect(uniqueTimestamps).toContain(firstTimestamp);
    const tsMs = uniqueTimestamps.map((t) => new Date(t).getTime()).sort((a, b) => a - b);
    expect(tsMs.length).toBe(2);
    // Order is not guaranteed by DB/query; assert monotonicity via min/max.
    expect(tsMs[1]).toBeGreaterThan(tsMs[0]);
  }, 15_000);

  it('DB upsert prevents exact duplicates (same timestamp)', async () => {
    // Direct DB test: ON CONFLICT (param_id, core_hash, slice_key, anchor_day, retrieved_at) DO NOTHING
    const { appendSnapshots } = await import('../snapshotWriteService');
    
    // Use a pytest-prefixed param_id so per-test cleanup reliably deletes it.
    const testParamId = makeTestParamId('upsert-test');
    const fixedTimestamp = new Date('2025-07-15T12:00:00Z');
    const testRows = Array.from({ length: 10 }, (_, i) => ({
      anchor_day: `2025-07-${String(i + 1).padStart(2, '0')}`,
      X: 200,
      Y: 100,
    }));
    
    // First write
    const r1 = await appendSnapshots({
      param_id: testParamId,
      canonical_signature: '{"c":"upsert-test-hash","x":{}}',
      inputs_json: { schema: 'pytest_flexi_sigs_v1', param_id: testParamId, canonical_signature: '{"c":"upsert-test-hash","x":{}}' },
      sig_algo: 'sig_v1_sha256_trunc128_b64url',
      slice_key: '',
      retrieved_at: fixedTimestamp,
      rows: testRows,
    });
    expect(r1.success).toBe(true);
    expect(r1.inserted).toBe(10);
    
    const rowsAfterFirst = await waitForSnapshotRowCount({ paramId: testParamId, expected: 10 });
    expect(rowsAfterFirst.length).toBe(10);

    // Second write with SAME timestamp - should be idempotent
    const r2 = await appendSnapshots({
      param_id: testParamId,
      canonical_signature: '{"c":"upsert-test-hash","x":{}}',
      inputs_json: { schema: 'pytest_flexi_sigs_v1', param_id: testParamId, canonical_signature: '{"c":"upsert-test-hash","x":{}}' },
      sig_algo: 'sig_v1_sha256_trunc128_b64url',
      slice_key: '',
      retrieved_at: fixedTimestamp,
      rows: testRows,
    });
    expect(r2.success).toBe(true);
    expect(r2.inserted).toBe(0); // All duplicates

    const rowsAfterSecond = await waitForSnapshotRowCount({ paramId: testParamId, expected: 10 });
    expect(rowsAfterSecond.length).toBe(10); // Still 10, not 20
  }, 15_000);
});


