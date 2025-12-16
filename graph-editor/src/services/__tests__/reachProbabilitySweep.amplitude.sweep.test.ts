/**
 * Sweep harness: Reach Probability as a function of "as-of" (system clock date).
 *
 * Purpose:
 * - Produce a CSV you can plot to *feel* how completeness / tail constraint / blending behave
 *   around a step change in conversion rate.
 * - Uses production code paths:
 *   - TS fetch pipeline (from-file mode after one initial versioned seed fetch)
 *   - Python GraphCompute runner for the reach probability numbers (single analytics codepath)
 *
 * How to run (expects Uvicorn running on :9000):
 *   DAGNET_SWEEP=1 npm test -- --run src/services/__tests__/reachProbabilitySweep.amplitude.sweep.test.ts
 *
 * Output:
 *   graph-editor/tmp/reach-sweep.<timestamp>.csv
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
const CONNECTIONS_PATH = `${process.cwd()}/public/defaults/connections.yaml`;

vi.mock('../../lib/das', async () => {
  const actual = await vi.importActual<any>('../../lib/das');
  return {
    ...actual,
    createDASRunner: (options: any = {}) =>
      actual.createDASRunner({ ...options, serverConnectionsPath: CONNECTIONS_PATH }),
  };
});

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

    if (stepCount === 2 && key.includes('Event A') && key.includes('Event B') && !key.includes('Event C')) {
      return sliceAmplitudeResponse(abFull, start, end);
    }
    if (stepCount === 2 && key.includes('Event B') && key.includes('Event C') && !key.includes('Event A')) {
      return sliceAmplitudeResponse(bcCombined.two_step, start, end);
    }
    if (stepCount === 3 && key.includes('Event A') && key.includes('Event B') && key.includes('Event C')) {
      return sliceAmplitudeResponse(bcCombined.three_step, start, end);
    }

    throw new Error(`[reachSweep] Unrecognised Amplitude request (steps=${stepCount}): ${urlStr}`);
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

import type { Graph } from '../../types';
import { db } from '../../db/appDatabase';
import { credentialsManager } from '../../lib/credentials';
import { fetchItem, type FetchItem } from '../fetchDataService';
import { fileRegistry } from '../../contexts/TabContext';

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

async function analyzeToNodeReachViaPython(
  graph: Graph,
  queryDsl: string,
  visibilityMode: 'f+e' | 'f' | 'e' = 'f+e'
): Promise<number> {
  const baseUrl = process.env.DAGNET_PYTHON_API_URL || process.env.VITE_PYTHON_API_URL || 'http://localhost:9000';
  const url = `${baseUrl}/api/runner/analyze`;
  const request = {
    scenarios: [{
      scenario_id: 'current',
      name: 'Current',
      colour: '#3b82f6',
      visibility_mode: visibilityMode,
      graph,
    }],
    query_dsl: queryDsl,
    analysis_type: 'to_node_reach',
  };

  const response = await undiciFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  const raw = await response.text();
  const body = JSON.parse(raw);
  if (!response.ok || !body?.success) throw new Error(`Python analyze failed (${response.status}): ${raw}`);
  const rows: any[] = body?.result?.data || [];
  const row = rows.find(r => r?.scenario_id === 'current') || rows[0];
  return Number(row?.probability);
}

function* dateRangeUtc(startIso: string, endIso: string, stepDays: number): Generator<string> {
  const start = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  for (let d = start; d <= end; d = new Date(d.getTime() + stepDays * 24 * 3600 * 1000)) {
    const iso = d.toISOString().slice(0, 10);
    yield iso;
  }
}

function getEdge(graph: Graph, edgeId: string): any | undefined {
  return graph?.edges?.find((e: any) => e?.id === edgeId || e?.uuid === edgeId);
}

function num(v: any): number | '' {
  return typeof v === 'number' && Number.isFinite(v) ? v : '';
}

describe('Sweep: Reach Probability vs as-of date (Amplitude fixtures)', () => {
  beforeAll(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
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
      // best-effort
    }

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

  const maybeIt = process.env.DAGNET_SWEEP === '1' ? it : it.skip;

  maybeIt('writes reach-sweep CSV for a fixed query window', async () => {
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

    // Seed once: populate param files with values via the fixture-backed HTTP executor.
    const seedDsl = process.env.DAGNET_SWEEP_SEED_DSL || 'window(1-Jul-25:31-Aug-25)';
    const s0 = await fetchItem(abItem, { mode: 'versioned' }, currentGraph as Graph, setGraph, seedDsl);
    expect(s0.success).toBe(true);
    const s1 = await fetchItem(bcItem, { mode: 'versioned' }, currentGraph as Graph, setGraph, seedDsl);
    expect(s1.success).toBe(true);

    const queryDsl = process.env.DAGNET_SWEEP_QUERY_DSL || 'window(1-Jul-25:31-Aug-25)';
    const queryDsls = (process.env.DAGNET_SWEEP_QUERY_DSLS || queryDsl)
      .split('||')
      .map(s => s.trim())
      .filter(Boolean);
    const asOfStart = process.env.DAGNET_SWEEP_ASOF_START || '2025-07-15';
    const asOfEnd = process.env.DAGNET_SWEEP_ASOF_END || '2025-09-15';
    const stepDays = Number(process.env.DAGNET_SWEEP_STEP_DAYS || '1');

    const outDir = path.resolve(process.cwd(), 'tmp');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `reach-sweep.${Date.now()}.csv`);

    const header = [
      'as_of_date',
      'query_dsl',
      'visibility_mode',
      'ab_p_mean',
      'ab_evidence_mean',
      'ab_forecast_mean',
      'ab_completeness',
      'ab_t95',
      'ab_path_t95',
      'bc_p_mean',
      'bc_evidence_mean',
      'bc_forecast_mean',
      'bc_completeness',
      'bc_t95',
      'bc_path_t95',
      'reach_to_B',
      'reach_to_C',
    ].join(',');
    const rows: string[] = [header];

    for (const dsl of queryDsls) {
      for (const asOfIso of dateRangeUtc(asOfStart, asOfEnd, stepDays)) {
        await withFixedNow(`${asOfIso}T12:00:00Z`, async () => {
          // Re-apply from-file for this as-of date to recompute LAG/blend under the current clock.
          const f0 = await fetchItem(abItem, { mode: 'from-file' }, currentGraph as Graph, setGraph, dsl);
          expect(f0.success).toBe(true);
          const f1 = await fetchItem(bcItem, { mode: 'from-file' }, currentGraph as Graph, setGraph, dsl);
          expect(f1.success).toBe(true);

          const g = currentGraph as Graph;
          const ab = getEdge(g, 'A-B');
          const bc = getEdge(g, 'B-C');

          const ab_p_mean = num(ab?.p?.mean);
          const ab_evidence_mean = num(ab?.p?.evidence?.mean);
          const ab_forecast_mean = num(ab?.p?.forecast?.mean);
          const ab_completeness = num(ab?.p?.latency?.completeness);
          const ab_t95 = num(ab?.p?.latency?.t95);
          const ab_path_t95 = num(ab?.p?.latency?.path_t95);

          const bc_p_mean = num(bc?.p?.mean);
          const bc_evidence_mean = num(bc?.p?.evidence?.mean);
          const bc_forecast_mean = num(bc?.p?.forecast?.mean);
          const bc_completeness = num(bc?.p?.latency?.completeness);
          const bc_t95 = num(bc?.p?.latency?.t95);
          const bc_path_t95 = num(bc?.p?.latency?.path_t95);

          for (const mode of ['f+e', 'e'] as const) {
            const reachB = await analyzeToNodeReachViaPython(g, 'to(B)', mode);
            const reachC = await analyzeToNodeReachViaPython(g, 'to(C)', mode);
            rows.push([
              asOfIso,
              JSON.stringify(dsl),
              mode,
              ab_p_mean,
              ab_evidence_mean,
              ab_forecast_mean,
              ab_completeness,
              ab_t95,
              ab_path_t95,
              bc_p_mean,
              bc_evidence_mean,
              bc_forecast_mean,
              bc_completeness,
              bc_t95,
              bc_path_t95,
              reachB,
              reachC,
            ].join(','));
          }
        });
      }
    }

    fs.writeFileSync(outPath, rows.join('\n') + '\n', 'utf8');
    // A single assertion so vitest treats this as a real test.
    expect(fs.existsSync(outPath)).toBe(true);
  }, 120_000);
});


