/**
 * CSV runner (TS stats machinery): input daily data CSV + queries CSV → output CSV of param-pack columns.
 *
 * Why:
 * - You can edit inputs in a spreadsheet, re-run locally, and plot outputs to “feel” the maths.
 * - This intentionally avoids Python analytics: we’re exercising the TS pipeline that computes
 *   evidence/completeness/tail-constraint/blend and writes p.mean onto the graph.
 *
 * Inputs
 * 1) Daily data CSV (editable in Sheets/Excel):
 *    Columns (required):
 *      date,ab_n,ab_k,ab_median_lag_days,bc_n,bc_k,bc_median_lag_days
 *    Optional (blank = not supplied):
 *      ab_mean_lag_days,bc_mean_lag_days,ab_t95,ab_path_t95,bc_t95,bc_path_t95
 *    `date` may be ISO (YYYY-MM-DD) or UK (d-MMM-yy). Converted immediately.
 *
 * 2) Queries CSV:
 *    Columns (required):
 *      dsl,as_of_date
 *    `as_of_date` may be ISO or UK. We evaluate the TS pipeline "as of" noon UTC that day.
 *
 * Output
 * - Wide CSV: one row per query with param-pack keys as columns (union across all runs).
 *
 * Run (example):
 *   DAGNET_CSV_RUN=1 \
 *   DAGNET_CSV_DATA=../param-registry/test/csv/reach-sweep-input.example.csv \
 *   DAGNET_CSV_QUERIES=../param-registry/test/csv/reach-queries.example.csv \
 *   DAGNET_CSV_OUT=tmp/param-pack-output.csv \
 *   npm test -- --run src/services/__tests__/paramPackCsvRunner.csvDriven.tool.test.ts
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
import { fetchItems, type FetchItem } from '../fetchDataService';
import { extractParamsFromGraph } from '../GraphParamExtractor';
import { flattenParams } from '../ParamPackDSLService';
import { parseDate } from '../windowAggregationService';
import { formatDateUK } from '../../lib/dateFormat';

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
  // IMPORTANT:
  // - The stats pipeline uses both Date.now() *and* `new Date()` internally.
  // - Overriding Date.now alone is NOT sufficient (V8 does not route new Date() through Date.now()).
  // - Use Vitest fake timers + setSystemTime so both behave consistently.
  vi.useFakeTimers();
  vi.setSystemTime(new Date(isoDateTime));
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

type DataRow = {
  dateIso: string; // YYYY-MM-DD
  ab_n: number;
  ab_k: number;
  ab_median_lag_days: number;
  ab_mean_lag_days?: number;
  ab_t95?: number;
  ab_path_t95?: number;
  bc_n: number;
  bc_k: number;
  bc_median_lag_days: number;
  bc_mean_lag_days?: number;
  bc_t95?: number;
  bc_path_t95?: number;
};

type QueryRow = {
  dsl: string;
  asOfIso: string; // YYYY-MM-DD
};

function parseCsvTable(raw: string): { header: string[]; rows: string[][] } {
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return { header: [], rows: [] };
  const header = lines[0].split(',').map(s => s.trim());
  const rows = lines.slice(1).map(l => l.split(',').map(s => s.trim()));
  return { header, rows };
}

function requiredIndex(header: string[], name: string): number {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`CSV missing required column: ${name}`);
  return i;
}

function toIsoDate(dateStr: string): string {
  const d = parseDate(dateStr);
  return d.toISOString().slice(0, 10);
}

function parseDailyDataCsv(raw: string): DataRow[] {
  const { header, rows } = parseCsvTable(raw);
  const iDate = requiredIndex(header, 'date');
  const iAbN = requiredIndex(header, 'ab_n');
  const iAbK = requiredIndex(header, 'ab_k');
  const iAbLag = requiredIndex(header, 'ab_median_lag_days');
  const iBcN = requiredIndex(header, 'bc_n');
  const iBcK = requiredIndex(header, 'bc_k');
  const iBcLag = requiredIndex(header, 'bc_median_lag_days');
  const iAbMeanLag = header.indexOf('ab_mean_lag_days');
  const iBcMeanLag = header.indexOf('bc_mean_lag_days');
  const iAbT95 = header.indexOf('ab_t95');
  const iAbPathT95 = header.indexOf('ab_path_t95');
  const iBcT95 = header.indexOf('bc_t95');
  const iBcPathT95 = header.indexOf('bc_path_t95');

  const parsed: DataRow[] = [];
  for (const parts of rows) {
    const dateStr = parts[iDate];
    if (!dateStr) continue; // blank date => “no data”

    const ab_n = Number(parts[iAbN]);
    const ab_k = Number(parts[iAbK]);
    const ab_median_lag_days = Number(parts[iAbLag]);
    const bc_n = Number(parts[iBcN]);
    const bc_k = Number(parts[iBcK]);
    const bc_median_lag_days = Number(parts[iBcLag]);

    // Any blank REQUIRED numeric cell means “no data for that date” (skip row).
    if (
      !Number.isFinite(ab_n) ||
      !Number.isFinite(ab_k) ||
      !Number.isFinite(ab_median_lag_days) ||
      !Number.isFinite(bc_n) ||
      !Number.isFinite(bc_k) ||
      !Number.isFinite(bc_median_lag_days)
    ) {
      continue;
    }

    const maybeNum = (idx: number): number | undefined => {
      if (idx < 0) return undefined;
      const raw = parts[idx];
      if (raw === undefined || raw === null || raw.trim() === '') return undefined;
      const v = Number(raw);
      return Number.isFinite(v) ? v : undefined;
    };

    parsed.push({
      dateIso: toIsoDate(dateStr),
      ab_n,
      ab_k,
      ab_median_lag_days,
      ab_mean_lag_days: maybeNum(iAbMeanLag),
      ab_t95: maybeNum(iAbT95),
      ab_path_t95: maybeNum(iAbPathT95),
      bc_n,
      bc_k,
      bc_median_lag_days,
      bc_mean_lag_days: maybeNum(iBcMeanLag),
      bc_t95: maybeNum(iBcT95),
      bc_path_t95: maybeNum(iBcPathT95),
    });
  }

  return parsed.sort((a, b) => a.dateIso.localeCompare(b.dateIso));
}

function parseQueriesCsv(raw: string): QueryRow[] {
  const { header, rows } = parseCsvTable(raw);
  const iDsl = requiredIndex(header, 'dsl');
  const iAsOf = requiredIndex(header, 'as_of_date');

  return rows.map((parts) => ({
    dsl: parts[iDsl],
    asOfIso: toIsoDate(parts[iAsOf]),
  }));
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function firstFinite(xs: Array<number | undefined>): number | undefined {
  for (const x of xs) {
    if (typeof x === 'number' && Number.isFinite(x)) return x;
  }
  return undefined;
}

function applyLatencyOverrides(
  graph: Graph,
  edgeId: string,
  overrides: { t95?: number; path_t95?: number }
): void {
  const e = (graph as any)?.edges?.find((x: any) => x?.id === edgeId);
  if (!e) return;
  e.p = e.p ?? {};
  e.p.latency = e.p.latency ?? {};

  // Important: the production pipeline only treats these as authoritative if the override flags are true.
  // We do not expose override flags in CSV: supplying a value implies “authoritative”.
  if (typeof overrides.t95 === 'number' && Number.isFinite(overrides.t95)) {
    e.p.latency.t95 = overrides.t95;
    e.p.latency.t95_overridden = true;
  }
  if (typeof overrides.path_t95 === 'number' && Number.isFinite(overrides.path_t95)) {
    e.p.latency.path_t95 = overrides.path_t95;
    e.p.latency.path_t95_overridden = true;
  }
}

describe('Tool: CSV → TS stats → param-pack CSV', () => {
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

  const maybeIt = process.env.DAGNET_CSV_RUN === '1' ? it : it.skip;

  maybeIt('runs all queries and writes wide output CSV', async () => {
    const dataPathRel = process.env.DAGNET_CSV_DATA;
    const queriesPathRel = process.env.DAGNET_CSV_QUERIES;
    const outPathRel = process.env.DAGNET_CSV_OUT;

    if (!dataPathRel || !queriesPathRel) {
      throw new Error('Set DAGNET_CSV_DATA and DAGNET_CSV_QUERIES to run this tool.');
    }

    const dataPathAbs = path.resolve(process.cwd(), dataPathRel);
    const queriesPathAbs = path.resolve(process.cwd(), queriesPathRel);
    const dataRaw = fs.readFileSync(dataPathAbs, 'utf8');
    const queriesRaw = fs.readFileSync(queriesPathAbs, 'utf8');

    const daily = parseDailyDataCsv(dataRaw);
    const queries = parseQueriesCsv(queriesRaw);
    expect(daily.length).toBeGreaterThan(0);
    expect(queries.length).toBeGreaterThan(0);

    const minIso = daily[0].dateIso;
    const maxIso = daily[daily.length - 1].dateIso;
    const minUK = formatDateUK(parseDate(minIso));
    const maxUK = formatDateUK(parseDate(maxIso));
    const sliceWindowDSL = `window(${minUK}:${maxUK})`;
    const sliceCohortDSL = `cohort(A,${minUK}:${maxUK})`;

    const dates = daily.map(r => r.dateIso);
    const abN = daily.map(r => r.ab_n);
    const abK = daily.map(r => r.ab_k);
    const abLag = daily.map(r => r.ab_median_lag_days);
    const abMeanLag = daily.map(r => r.ab_mean_lag_days ?? r.ab_median_lag_days);
    const bcN = daily.map(r => r.bc_n);
    const bcK = daily.map(r => r.bc_k);
    const bcLag = daily.map(r => r.bc_median_lag_days);
    const bcMeanLag = daily.map(r => r.bc_mean_lag_days ?? r.bc_median_lag_days);

    const abT95 = firstFinite(daily.map(r => r.ab_t95));
    const abPathT95 = firstFinite(daily.map(r => r.ab_path_t95));
    const bcT95 = firstFinite(daily.map(r => r.bc_t95));
    const bcPathT95 = firstFinite(daily.map(r => r.bc_path_t95));

    // Write values into the param files in FileRegistry (this is the “source data” for TS stats).
    const abFile = fileRegistry.getFile('parameter-ab-smooth-lag')!;
    const bcFile = fileRegistry.getFile('parameter-bc-smooth-lag')!;

    const abWindowValue = {
      mean: sum(abK) / sum(abN),
      n: sum(abN),
      k: sum(abK),
      dates,
      n_daily: abN,
      k_daily: abK,
      median_lag_days: abLag,
      mean_lag_days: abMeanLag,
      sliceDSL: sliceWindowDSL,
      window_from: minUK,
      window_to: maxUK,
      data_source: { type: 'file', retrieved_at: new Date().toISOString(), full_query: 'csv:ab:window' },
    };
    const abCohortValue = {
      mean: sum(abK) / sum(abN),
      n: sum(abN),
      k: sum(abK),
      dates,
      n_daily: abN,
      k_daily: abK,
      median_lag_days: abLag,
      mean_lag_days: abMeanLag,
      sliceDSL: sliceCohortDSL,
      cohort_from: minUK,
      cohort_to: maxUK,
      data_source: { type: 'file', retrieved_at: new Date().toISOString(), full_query: 'csv:ab:cohort' },
    };

    const bcWindowValue = {
      mean: sum(bcK) / sum(bcN),
      n: sum(bcN),
      k: sum(bcK),
      dates,
      n_daily: bcN,
      k_daily: bcK,
      median_lag_days: bcLag,
      mean_lag_days: bcMeanLag,
      sliceDSL: sliceWindowDSL,
      window_from: minUK,
      window_to: maxUK,
      data_source: { type: 'file', retrieved_at: new Date().toISOString(), full_query: 'csv:bc:window' },
    };
    const bcCohortValue = {
      mean: sum(bcK) / sum(bcN),
      n: sum(bcN),
      k: sum(bcK),
      dates,
      n_daily: bcN,
      k_daily: bcK,
      median_lag_days: bcLag,
      mean_lag_days: bcMeanLag,
      // Anchor arrays derived from AB (A→B is the anchor path to B)
      anchor_n_daily: abN,
      anchor_median_lag_days: abLag,
      anchor_mean_lag_days: abMeanLag,
      sliceDSL: sliceCohortDSL,
      cohort_from: minUK,
      cohort_to: maxUK,
      data_source: { type: 'file', retrieved_at: new Date().toISOString(), full_query: 'csv:bc:cohort' },
    };

    abFile.data.values = [abWindowValue, abCohortValue];
    bcFile.data.values = [bcWindowValue, bcCohortValue];

    const graphBase = loadJson('../../../../param-registry/test/graphs/ab-bc-smooth-lag-rebalance.json') as Graph;

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

    const results: Array<{ q: QueryRow; pack: Record<string, any> }> = [];
    const allKeys = new Set<string>();

    for (const q of queries) {
      let graph: Graph | null = structuredClone(graphBase);
      const setGraph = (g: Graph | null) => { graph = g; };

      // Optional latency overrides (blank in CSV => derived by production pipeline)
      if (graph) {
        applyLatencyOverrides(graph, 'A-B', { t95: abT95, path_t95: abPathT95 });
        applyLatencyOverrides(graph, 'B-C', { t95: bcT95, path_t95: bcPathT95 });
      }

      await withFixedNow(`${q.asOfIso}T12:00:00Z`, async () => {
        // Fetch as a single batch so Stage-2 passes (LAG/inbound-n) run on the freshest graph.
        // This avoids subtle “stale graph” loss of fields like p.stdev during the topo pass.
        const results = await fetchItems([abItem, bcItem], { mode: 'from-file' }, graph as Graph, setGraph, q.dsl);
        expect(results.length).toBe(2);
        expect(results.every(r => r.success)).toBe(true);
      });

      const pack = flattenParams(extractParamsFromGraph(graph));
      for (const k of Object.keys(pack)) allKeys.add(k);
      results.push({ q, pack });
    }

    const sortedKeys = Array.from(allKeys).sort();
    const header = ['dsl', 'as_of_date', ...sortedKeys].join(',');

    const outLines: string[] = [header];
    for (const r of results) {
      const base = [
        JSON.stringify(r.q.dsl),
        JSON.stringify(formatDateUK(parseDate(r.q.asOfIso))),
      ];
      const vals = sortedKeys.map(k => {
        const v = r.pack[k];
        // IMPORTANT: emit a non-empty token for “missing” so spreadsheets that use SPLIT()
        // (with remove_empty_text defaulting to TRUE) don't collapse columns.
        // `""` is a clear sentinel and stays a single token.
        return typeof v === 'number' && Number.isFinite(v) ? v : (v === undefined ? '\"\"' : JSON.stringify(v));
      });
      outLines.push([...base, ...vals].join(','));
    }

    const outDir = path.resolve(process.cwd(), 'tmp');
    fs.mkdirSync(outDir, { recursive: true });
    const outPathAbs = outPathRel ? path.resolve(process.cwd(), outPathRel) : path.join(outDir, `param-pack.${Date.now()}.csv`);
    fs.writeFileSync(outPathAbs, outLines.join('\n') + '\n', 'utf8');

    expect(fs.existsSync(outPathAbs)).toBe(true);
  }, 120_000);
});


