/**
 * CSV-driven sweep harness (TS stats machinery only).
 *
 * Goal:
 * - Make it easy to iterate on daily n/k/lag inputs in a spreadsheet (CSV),
 *   then run one command to get a CSV output curve you can plot.
 * - Uses production TS machinery for: aggregation → completeness → tail constraint → blending → p.mean.
 * - Produces outputs by reading the resulting graph/param-pack state (no Python analytics).
 *
 * Run:
 *   DAGNET_SWEEP=1 \
 *   DAGNET_SWEEP_INPUT_CSV=../param-registry/test/csv/reach-sweep-input.example.csv \
 *   DAGNET_SWEEP_QUERY_DSL="window(1-Jul-25:31-Aug-25)" \
 *   DAGNET_SWEEP_ASOF_START=2025-07-15 \
 *   DAGNET_SWEEP_ASOF_END=2025-09-15 \
 *   DAGNET_SWEEP_STEP_DAYS=1 \
 *   npm test -- --run src/services/__tests__/reachProbabilitySweep.csvDriven.sweep.test.ts
 *
 * Output:
 *   graph-editor/tmp/reach-sweep-ts.<timestamp>.csv
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

import type { Graph } from '../../types';
import { db } from '../../db/appDatabase';
import { fileRegistry } from '../../contexts/TabContext';
import { fetchItem, type FetchItem } from '../fetchDataService';
import { extractParamsFromGraph } from '../GraphParamExtractor';
import { flattenParams } from '../ParamPackDSLService';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function* dateRangeUtc(startIso: string, endIso: string, stepDays: number): Generator<string> {
  const start = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  for (let d = start; d <= end; d = new Date(d.getTime() + stepDays * 24 * 3600 * 1000)) {
    yield d.toISOString().slice(0, 10);
  }
}

type CsvRow = {
  date: string; // YYYY-MM-DD
  ab_n: number;
  ab_k: number;
  ab_median_lag_days: number;
  bc_n: number;
  bc_k: number;
  bc_median_lag_days: number;
};

function parseCsv(input: string): CsvRow[] {
  const lines = input.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map(s => s.trim());
  const idx = (name: string) => header.indexOf(name);
  const req = ['date','ab_n','ab_k','ab_median_lag_days','bc_n','bc_k','bc_median_lag_days'];
  for (const r of req) {
    if (idx(r) < 0) throw new Error(`CSV missing required column: ${r}`);
  }
  const rows: CsvRow[] = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(',').map(s => s.trim());
    const get = (name: string) => parts[idx(name)];
    const row: CsvRow = {
      date: get('date'),
      ab_n: Number(get('ab_n')),
      ab_k: Number(get('ab_k')),
      ab_median_lag_days: Number(get('ab_median_lag_days')),
      bc_n: Number(get('bc_n')),
      bc_k: Number(get('bc_k')),
      bc_median_lag_days: Number(get('bc_median_lag_days')),
    };
    rows.push(row);
  }
  return rows;
}

function num(v: any): number | '' {
  return typeof v === 'number' && Number.isFinite(v) ? v : '';
}

describe('Sweep: TS stats vs as-of date (CSV-driven)', () => {
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

  maybeIt('writes reach-sweep CSV from a daily input CSV', async () => {
    const inputCsvRel = process.env.DAGNET_SWEEP_INPUT_CSV || '../param-registry/test/csv/reach-sweep-input.example.csv';
    const inputCsvAbs = path.resolve(process.cwd(), inputCsvRel);
    const input = fs.readFileSync(inputCsvAbs, 'utf8');
    const rows = parseCsv(input);
    expect(rows.length).toBeGreaterThan(0);

    const dates = rows.map(r => r.date).sort();
    const minIso = dates[0];
    const maxIso = dates[dates.length - 1];

    // Build ParameterValue entries (window slice + cohort slice) purely from the CSV.
    const abDates = rows.map(r => r.date);
    const abN = rows.map(r => r.ab_n);
    const abK = rows.map(r => r.ab_k);
    const abMedianLag = rows.map(r => r.ab_median_lag_days);

    const bcDates = rows.map(r => r.date);
    const bcN = rows.map(r => r.bc_n);
    const bcK = rows.map(r => r.bc_k);
    const bcMedianLag = rows.map(r => r.bc_median_lag_days);

    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

    const abValue = {
      mean: sum(abK) / sum(abN),
      n: sum(abN),
      k: sum(abK),
      dates: abDates,
      n_daily: abN,
      k_daily: abK,
      median_lag_days: abMedianLag,
      mean_lag_days: abMedianLag,
      sliceDSL: `window(1-Jul-25:31-Aug-25)`,
      window_from: '1-Jul-25',
      window_to: '31-Aug-25',
      data_source: { type: 'file', retrieved_at: new Date().toISOString(), full_query: 'csv:ab' },
    };

    const bcValue = {
      mean: sum(bcK) / sum(bcN),
      n: sum(bcN),
      k: sum(bcK),
      dates: bcDates,
      n_daily: bcN,
      k_daily: bcK,
      median_lag_days: bcMedianLag,
      mean_lag_days: bcMedianLag,
      sliceDSL: `window(1-Jul-25:31-Aug-25)`,
      window_from: '1-Jul-25',
      window_to: '31-Aug-25',
      data_source: { type: 'file', retrieved_at: new Date().toISOString(), full_query: 'csv:bc' },
    };

    // Write values into param files in the registry (as if they came from source).
    const abFile = fileRegistry.getFile('parameter-ab-smooth-lag')!;
    const bcFile = fileRegistry.getFile('parameter-bc-smooth-lag')!;
    abFile.data.values = [abValue];
    bcFile.data.values = [bcValue];

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

    const queryDsl = process.env.DAGNET_SWEEP_QUERY_DSL || 'window(1-Jul-25:31-Aug-25)';
    const asOfStart = process.env.DAGNET_SWEEP_ASOF_START || minIso;
    const asOfEnd = process.env.DAGNET_SWEEP_ASOF_END || maxIso;
    const stepDays = Number(process.env.DAGNET_SWEEP_STEP_DAYS || '1');

    const outDir = path.resolve(process.cwd(), 'tmp');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `reach-sweep-ts.${Date.now()}.csv`);

    const header = [
      'as_of_date',
      'query_dsl',
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
      'reach_to_B_from_pack',
      'reach_to_C_from_pack',
    ].join(',');
    const outRows: string[] = [header];

    for (const asOfIso of dateRangeUtc(asOfStart, asOfEnd, stepDays)) {
      await withFixedNow(`${asOfIso}T12:00:00Z`, async () => {
        const r0 = await fetchItem(abItem, { mode: 'from-file' }, currentGraph as Graph, setGraph, queryDsl);
        expect(r0.success).toBe(true);
        const r1 = await fetchItem(bcItem, { mode: 'from-file' }, currentGraph as Graph, setGraph, queryDsl);
        expect(r1.success).toBe(true);

        const pack = flattenParams(extractParamsFromGraph(currentGraph));

        const ab_p_mean = pack['e.A-B.p.mean'];
        const ab_evidence_mean = pack['e.A-B.p.evidence.mean'];
        const ab_forecast_mean = pack['e.A-B.p.forecast.mean'];
        const ab_completeness = pack['e.A-B.p.latency.completeness'];
        const ab_t95 = pack['e.A-B.p.latency.t95'];
        const ab_path_t95 = pack['e.A-B.p.latency.path_t95'];

        const bc_p_mean = pack['e.B-C.p.mean'];
        const bc_evidence_mean = pack['e.B-C.p.evidence.mean'];
        const bc_forecast_mean = pack['e.B-C.p.forecast.mean'];
        const bc_completeness = pack['e.B-C.p.latency.completeness'];
        const bc_t95 = pack['e.B-C.p.latency.t95'];
        const bc_path_t95 = pack['e.B-C.p.latency.path_t95'];

        // Reach from pack (deterministic product for this simple graph)
        const reachB = typeof ab_p_mean === 'number' ? ab_p_mean : '';
        const reachC = (typeof ab_p_mean === 'number' && typeof bc_p_mean === 'number') ? (ab_p_mean * bc_p_mean) : '';

        outRows.push([
          asOfIso,
          JSON.stringify(queryDsl),
          num(ab_p_mean),
          num(ab_evidence_mean),
          num(ab_forecast_mean),
          num(ab_completeness),
          num(ab_t95),
          num(ab_path_t95),
          num(bc_p_mean),
          num(bc_evidence_mean),
          num(bc_forecast_mean),
          num(bc_completeness),
          num(bc_t95),
          num(bc_path_t95),
          reachB,
          reachC,
        ].join(','));
      });
    }

    fs.writeFileSync(outPath, outRows.join('\n') + '\n', 'utf8');
    expect(fs.existsSync(outPath)).toBe(true);
  }, 120_000);
});


