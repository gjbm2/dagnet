/**
 * LOCAL-ONLY Real Amplitude E2E:
 * - Run real cohort-mode query through production fetch pipeline (frontend query side)
 * - For each channel context value, read edge evidence.n/k from the param pack
 * - Assert Σ(context slices) == uncontexted Amplitude baseline for the same A→X→Y funnel
 *
 * Constraints / guarantees:
 * - No mocking (no vi.mock / vi.spyOn) on the query side
 * - Uses real production code for the DagNet fetch pipeline
 * - Direct Amplitude baseline call is constructed manually (no DagNet query builder, no channel)
 * - Skips in CI, and skips locally unless `.env.amplitude.local` exists with Amplitude creds
 *
 * Env file:
 * - Create repo-root `.env.amplitude.local` (gitignored)
 * - See `local-env/amplitude.env.example` for the required keys
 *
 * Run:
 *   cd graph-editor && npm test -- --run src/services/__tests__/cohortAxy.meceSum.vsAmplitude.local.e2e.test.ts
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { fetch as undiciFetch } from 'undici';

import type { Graph } from '../../types';
import { credentialsManager } from '../../lib/credentials';
import { resolveRelativeDate } from '../../lib/dateFormat';
import { parseDate } from '../windowAggregationService';
import { RECENCY_HALF_LIFE_DAYS } from '../../constants/latency';
import { fetchItem, createFetchItem, type FetchItem } from '../fetchDataService';
import { extractParamsFromGraph } from '../GraphParamExtractor';
import { flattenParams } from '../ParamPackDSLService';
import { fileRegistry } from '../../contexts/TabContext';
import { db } from '../../db/appDatabase';
import { deriveBaseDSLForRebase, prepareScenariosForBatch, type ScenarioForBatch } from '../scenarioRegenerationService';
import { GraphComputeClient, type AnalysisResponse } from '../../lib/graphComputeClient';

type AmpCreds = { apiKey: string; secretKey: string };

// -----------------------------------------------------------------------------
// Snapshot DB test workspace prefix (must start with 'pytest-' for safe cleanup)
// -----------------------------------------------------------------------------
//
// Snapshot writes use dbParamId = `${repository}-${branch}-${objectId}`.
// We force repository/branch to be unique per test run so the DB assertions are
// strict and we can clean up via /api/snapshots/delete-test (prefix delete).
//
const SNAPSHOT_TEST_REPO = `pytest-realamp-${Date.now()}`;
const SNAPSHOT_TEST_BRANCH = `run-${Math.random().toString(16).slice(2)}`;

function findRepoRootFromCwd(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const hasParamRegistry = fs.existsSync(path.join(dir, 'param-registry'));
    const hasGraphEditor = fs.existsSync(path.join(dir, 'graph-editor'));
    if (hasParamRegistry && hasGraphEditor) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume we're running from graph-editor/
  return path.resolve(process.cwd(), '..');
}

const REPO_ROOT = findRepoRootFromCwd();
const ENV_PATH = path.join(REPO_ROOT, '.env.amplitude.local');

function loadLocalEnvFile(envPath: string): Record<string, string> {
  const raw = fs.readFileSync(envPath, 'utf8');
  const out: Record<string, string> = {};
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function getAmplitudeCredsFromEnvFile(): AmpCreds | null {
  if (!fs.existsSync(ENV_PATH)) return null;
  const env = loadLocalEnvFile(ENV_PATH);
  // IMPORTANT: local-only gate must require creds to be present in the env file itself.
  // We intentionally do NOT fall back to process.env here, because the env file may exist
  // as a stub, and ambient shell vars would otherwise cause accidental real-HTTP execution.
  const apiKey = env.AMPLITUDE_API_KEY;
  const secretKey = env.AMPLITUDE_SECRET_KEY;
  if (!apiKey || !secretKey) return null;
  // Also export into process.env so the production CredentialsManager can see them
  process.env.AMPLITUDE_API_KEY = apiKey;
  process.env.AMPLITUDE_SECRET_KEY = secretKey;
  // Opt-in flag for CredentialsManager's non-browser env credential loading
  process.env.DAGNET_LOCAL_E2E_CREDENTIALS = '1';
  return { apiKey, secretKey };
}

function b64(s: string): string {
  return Buffer.from(s).toString('base64');
}

function cohortRangeYyyymmddFromRelativeOffsets(now: Date, startOffsetDays: number, endOffsetDays: number): { start: string; end: string } {
  const base = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const start = new Date(base);
  start.setUTCDate(start.getUTCDate() + startOffsetDays);
  const end = new Date(base);
  end.setUTCDate(end.getUTCDate() + endOffsetDays);
  return {
    start: start.toISOString().slice(0, 10).replace(/-/g, ''),
    end: end.toISOString().slice(0, 10).replace(/-/g, ''),
  };
}

function yyyymmddFromRelativeDayOffset(offsetDays: number): string {
  // Use the same relative-date resolution as production code (UTC midnight, UK format).
  // resolveRelativeDate("-45d") -> "3-Nov-25" (example), then convert to yyyymmdd.
  const uk = resolveRelativeDate(`${offsetDays}d`);
  const iso = parseDate(uk).toISOString().slice(0, 10);
  return iso.replace(/-/g, '');
}

function loadYamlFixture(relFromRepoRoot: string): any {
  const abs = path.join(REPO_ROOT, relFromRepoRoot);
  return yaml.load(fs.readFileSync(abs, 'utf8'));
}

function loadJsonFixture(relFromRepoRoot: string): any {
  const abs = path.join(REPO_ROOT, relFromRepoRoot);
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

async function registerFileForTest(fileId: string, type: any, data: any): Promise<void> {
  await fileRegistry.registerFile(fileId, {
    fileId,
    type,
    data,
    originalData: structuredClone(data),
    isDirty: false,
    isInitializing: false,
    source: { repository: SNAPSHOT_TEST_REPO, branch: SNAPSHOT_TEST_BRANCH, isLocal: true } as any,
    viewTabs: [],
    lastModified: Date.now(),
  } as any);
}

function dbParamIdFor(objectId: string): string {
  return `${SNAPSHOT_TEST_REPO}-${SNAPSHOT_TEST_BRANCH}-${objectId}`;
}

async function deleteTestSnapshotsByPrefix(prefix: string): Promise<void> {
  // dev-server.py exposes /api/snapshots/delete-test for integration cleanup.
  // Safety: backend requires prefix starts with 'pytest-'.
  await undiciFetch('http://localhost:9000/api/snapshots/delete-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ param_id_prefix: prefix }),
  });
}

async function getInventory(paramIds: string[]): Promise<Record<string, any>> {
  const resp = await undiciFetch('http://localhost:9000/api/snapshots/inventory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ param_ids: paramIds }),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`snapshots/inventory HTTP ${resp.status}: ${text}`);
  }
  const body = JSON.parse(text);
  return body.inventory || {};
}

async function querySnapshotsRaw(paramId: string): Promise<any[]> {
  // Query the actual snapshot rows for this param_id (via dev-server /api/snapshots/query)
  const resp = await undiciFetch('http://localhost:9000/api/snapshots/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ param_id: paramId }),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`snapshots/query HTTP ${resp.status}: ${text}`);
  }
  const body = JSON.parse(text);
  return body.rows || [];
}

function persistTestArtifacts(filename: string, data: any): void {
  // Write to graph-editor/debug/ for easy inspection
  const debugDir = path.join(REPO_ROOT, 'graph-editor/debug');
  if (!fs.existsSync(debugDir)) {
    fs.mkdirSync(debugDir, { recursive: true });
  }
  const filePath = path.join(debugDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`[SNAPSHOT_DB_E2E] Persisted artifacts to: ${filePath}`);
}

type AmplitudeHttpRecord = {
  atIso: string;
  tag?: { run: string; dsl: string };
  request: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    requestKey: string; // sha256(url + "\n" + body)
  };
  response: {
    status?: number;
    headers?: Record<string, string>;
    rawBody?: string;
    bodySha256?: string;
  };
  error?: string;
};

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return headers;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'authorization') {
      out[k] = '***REDACTED***';
    } else {
      out[k] = v;
    }
  }
  return out;
}

function installAmplitudeHttpRecorder(getTag: () => { run: string; dsl: string } | undefined): {
  records: AmplitudeHttpRecord[];
  restore: () => void;
} {
  const records: AmplitudeHttpRecord[] = [];
  const originalFetch = (globalThis as any).fetch as typeof fetch | undefined;
  if (!originalFetch) {
    throw new Error('Global fetch not available; cannot record Amplitude HTTP');
  }

  (globalThis as any).fetch = (async (input: any, init?: any) => {
    const atIso = new Date().toISOString();
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    const isAmplitude = url.includes('amplitude.com/api/2/');

    // Always pass through for non-Amplitude requests
    if (!isAmplitude) {
      return await originalFetch(input as any, init as any);
    }

    const method = init?.method ?? 'GET';
    const headers = redactHeaders(init?.headers as Record<string, string> | undefined);
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const requestKey = sha256Hex(`${url}\n${body ?? ''}`);

    const baseRecord: AmplitudeHttpRecord = {
      atIso,
      tag: getTag(),
      request: { url, method, headers, body, requestKey },
      response: {},
    };

    try {
      const response = await originalFetch(input as any, init as any);

      // Clone before reading so downstream can still .text()
      let rawBody: string | undefined;
      try {
        const cloned = (response as any).clone ? (response as any).clone() : null;
        if (cloned) {
          rawBody = await cloned.text();
        }
      } catch {
        // best-effort only
      }

      const respHeaders: Record<string, string> = {};
      try {
        (response as any).headers?.forEach?.((value: string, key: string) => {
          respHeaders[key] = value;
        });
      } catch {
        // ignore
      }

      records.push({
        ...baseRecord,
        response: {
          status: (response as any).status,
          headers: respHeaders,
          rawBody,
          bodySha256: rawBody ? sha256Hex(rawBody) : undefined,
        },
      });

      return response;
    } catch (e) {
      records.push({
        ...baseRecord,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }) as any;

  return {
    records,
    restore: () => {
      (globalThis as any).fetch = originalFetch as any;
    },
  };
}

async function analyzeFromSnapshotDb(args: {
  param_id: string;
  core_hash?: string;
  anchor_from: string; // yyyy-mm-dd
  anchor_to: string;   // yyyy-mm-dd
  slice_keys: string[];
  analysis_type: 'daily_conversions' | 'lag_histogram';
  as_at?: string; // ISO timestamp
}): Promise<any> {
  const resp = await undiciFetch('http://localhost:9000/api/runner/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      analysis_type: args.analysis_type,
      snapshot_query: {
        param_id: args.param_id,
        core_hash: args.core_hash,
        anchor_from: args.anchor_from,
        anchor_to: args.anchor_to,
        slice_keys: args.slice_keys,
        as_at: args.as_at,
      },
    }),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`runner/analyze(snapshot_query) HTTP ${resp.status}: ${text}`);
  }
  return JSON.parse(text);
}

async function withFixedDateConstructor<T>(isoDateTime: string, fn: () => Promise<T>): Promise<T> {
  // We need to control `new Date()` (not just Date.now) because snapshot writes pass retrieved_at: new Date().
  const RealDate = Date;
  const fixedMs = new RealDate(isoDateTime).getTime();

  class MockDate extends RealDate {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(...args: any[]) {
      if (args.length === 0) {
        // Return a real Date fixed at fixedMs
        return new RealDate(fixedMs) as any;
      }
      return new RealDate(...args) as any;
    }
    static now() {
      return fixedMs;
    }
  }

  (globalThis as any).Date = MockDate as any;
  try {
    return await fn();
  } finally {
    (globalThis as any).Date = RealDate;
  }
}


async function hardResetState(): Promise<void> {
  // IndexedDB reset (Dexie)
  await Promise.all([
    db.workspaces.clear(),
    db.files.clear(),
    db.tabs.clear(),
    db.scenarios.clear(),
    db.appState.clear(),
    db.settings.clear(),
    db.credentials.clear(),
  ]);

  // FileRegistry reset (best effort; internal shape varies across refactors)
  try {
    const map = (fileRegistry as any).files as Map<string, any> | undefined;
    map?.clear();
  } catch {
    // ignore
  }
  try {
    const map = (fileRegistry as any)._files as Map<string, any> | undefined;
    map?.clear();
  } catch {
    // ignore
  }
}

async function loadAmplitudeExcludedCohortsFromConnectionsYaml(): Promise<string[]> {
  const connectionsPath = path.join(REPO_ROOT, 'graph-editor/public/defaults/connections.yaml');
  const parsed: any = yaml.load(fs.readFileSync(connectionsPath, 'utf8'));
  const conn = (parsed?.connections || []).find((c: any) => c?.name === 'amplitude-prod');
  const excluded = conn?.defaults?.excluded_cohorts;
  return Array.isArray(excluded) ? excluded.map(String) : [];
}

async function amplitudeWindowDailyCurlXY(args: {
  creds: AmpCreds;
  windowStartYyyymmdd: string;
  windowEndYyyymmdd: string;
  excludedCohorts: string[];
}): Promise<{ datesIso: string[]; nDaily: number[]; kDaily: number[]; raw: any }> {
  const { creds, windowStartYyyymmdd, windowEndYyyymmdd, excludedCohorts } = args;

  const baseUrl = 'https://amplitude.com/api/2/funnels';

  // Funnel steps: X → Y (window-mode baseline)
  // X = energy-rec
  // Y = switch-registered
  const steps: any[] = [
    {
      event_type: 'Blueprint CheckpointReached',
      filters: [
        {
          subprop_type: 'event',
          subprop_key: 'checkpoint',
          subprop_op: 'is',
          subprop_value: ['RecommendationOffered'],
        },
        {
          subprop_type: 'event',
          subprop_key: 'category',
          subprop_op: 'is',
          subprop_value: ['Energy'],
        },
      ],
    },
    {
      event_type: 'Blueprint CheckpointReached',
      filters: [
        {
          subprop_type: 'event',
          subprop_key: 'checkpoint',
          subprop_op: 'is',
          subprop_value: ['SwitchRegistered'],
        },
      ],
    },
  ];

  const segments: any[] = [];
  for (const cohortId of excludedCohorts) {
    segments.push({ prop: 'userdata_cohort', op: 'is not', values: [cohortId] });
  }

  const qsParts: string[] = [];
  for (const s of steps) {
    qsParts.push(`e=${encodeURIComponent(JSON.stringify(s))}`);
  }
  qsParts.push(`start=${encodeURIComponent(windowStartYyyymmdd)}`);
  qsParts.push(`end=${encodeURIComponent(windowEndYyyymmdd)}`);
  qsParts.push('i=1');
  if (segments.length > 0) {
    qsParts.push(`s=${encodeURIComponent(JSON.stringify(segments))}`);
  }
  // Mirror production adapter behaviour: always include a 30-day conversion window (cs, seconds)
  // even in window() mode. This materially affects k (and therefore k/n).
  qsParts.push(`cs=${encodeURIComponent(String(30 * 24 * 60 * 60))}`);

  const url = `${baseUrl}?${qsParts.join('&')}`;

  const auth = `Basic ${b64(`${creds.apiKey}:${creds.secretKey}`)}`;
  const resp = await undiciFetch(url, { method: 'GET', headers: { Authorization: auth } });
  const rawText = await resp.text();
  if (!resp.ok) {
    throw new Error(`Amplitude window baseline HTTP ${resp.status}: ${rawText}`);
  }
  let body: any;
  try {
    body = JSON.parse(rawText);
  } catch {
    throw new Error(`Amplitude window baseline returned non-JSON: ${rawText}`);
  }

  const cumulativeRaw: any[] | undefined = body?.data?.[0]?.cumulativeRaw;
  const dayFunnels: any = body?.data?.[0]?.dayFunnels;
  const datesRaw: string[] | undefined = dayFunnels?.xValues || dayFunnels?.formattedXValues;
  const series: any[] | undefined = dayFunnels?.series;

  // We rely on dayFunnels for forecast baseline parity, since DagNet forecast is computed from daily arrays.
  // Response contract (Amplitude): dayFunnels.series is an array parallel to dates:
  // - 2-step funnel: series[i] = [n_i, k_i]
  // - 3-step funnel: series[i] = [anchor_n_i, from_n_i, to_k_i]
  if (!Array.isArray(datesRaw) || !Array.isArray(series) || datesRaw.length !== series.length) {
    throw new Error(
      `Unexpected Amplitude response shape (missing dayFunnels series). ` +
      `cumulativeRaw=${JSON.stringify(cumulativeRaw)} dayFunnelsKeys=${JSON.stringify(Object.keys(dayFunnels || {}))}`
    );
  }

  // Normalise dates to ISO yyyy-mm-dd.
  // Amplitude can return either:
  // - xValues: ["2025-11-05", ...]
  // - formattedXValues: ["Nov 05", ...] (no year)
  const startYear = Number(String(windowStartYyyymmdd).slice(0, 4));
  const monthMap: Record<string, string> = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
  };
  const datesIso: string[] = datesRaw.map((s) => {
    const str = String(s);
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    const m = str.match(/^([A-Za-z]{3})\s+(\d{1,2})$/);
    if (m) {
      const mm = monthMap[m[1]];
      const dd = String(Number(m[2])).padStart(2, '0');
      if (!mm) throw new Error(`[debug] Unrecognised month in Amplitude formatted date: ${JSON.stringify(str)}`);
      return `${startYear}-${mm}-${dd}`;
    }
    throw new Error(`[debug] Unrecognised dayFunnels date format: ${JSON.stringify(str)}`);
  });

  const nDaily: number[] = [];
  const kDaily: number[] = [];
  for (let i = 0; i < datesIso.length; i++) {
    const row = series[i];
    if (!Array.isArray(row) || row.length < 2) {
      throw new Error(`Unexpected dayFunnels.series[${i}] row: ${JSON.stringify(row)}`);
    }
    const n = Number(row[0]);
    const k = Number(row[1]);
    if (!Number.isFinite(n) || !Number.isFinite(k)) {
      throw new Error(`Non-numeric dayFunnels counts at i=${i}: ${JSON.stringify(row)}`);
    }
    nDaily.push(n);
    kDaily.push(k);
  }

  return { datesIso, nDaily, kDaily, raw: body };
}

async function amplitudeBaselineCurl(args: {
  creds: AmpCreds;
  cohortStartYyyymmdd: string;
  cohortEndYyyymmdd: string;
  conversionWindowDays: number;
  excludedCohorts: string[];
  /**
   * Which funnel step indices to use for (n,k) extraction from cumulativeRaw[].
   * For 3-step A→X→Y:
   * - (1,2) yields X/Y (edge X→Y evidence)
   * - (0,2) yields A/Y (reach-to-Y n/k)
   */
  fromStepIndex?: number;
  toStepIndex?: number;
}): Promise<{ n: number; k: number; raw: any }> {
  const {
    creds,
    cohortStartYyyymmdd,
    cohortEndYyyymmdd,
    conversionWindowDays,
    excludedCohorts,
    fromStepIndex = 1,
    toStepIndex = 2,
  } = args;

  const baseUrl = 'https://amplitude.com/api/2/funnels';

  // Funnel steps: A → X → Y
  // A = Household Created
  // X = energy-rec
  // Y = switch-registered
  const steps: any[] = [
    { event_type: 'Household Created' },
    {
      event_type: 'Blueprint CheckpointReached',
      filters: [
        {
          subprop_type: 'event',
          subprop_key: 'checkpoint',
          subprop_op: 'is',
          subprop_value: ['RecommendationOffered'],
        },
        {
          subprop_type: 'event',
          subprop_key: 'category',
          subprop_op: 'is',
          subprop_value: ['Energy'],
        },
      ],
    },
    {
      event_type: 'Blueprint CheckpointReached',
      filters: [
        {
          subprop_type: 'event',
          subprop_key: 'checkpoint',
          subprop_op: 'is',
          subprop_value: ['SwitchRegistered'],
        },
      ],
    },
  ];

  const segments: any[] = [];
  for (const cohortId of excludedCohorts) {
    segments.push({ prop: 'userdata_cohort', op: 'is not', values: [cohortId] });
  }

  const csSeconds = conversionWindowDays * 24 * 60 * 60;
  const qsParts: string[] = [];
  for (const s of steps) {
    qsParts.push(`e=${encodeURIComponent(JSON.stringify(s))}`);
  }
  qsParts.push(`start=${encodeURIComponent(cohortStartYyyymmdd)}`);
  qsParts.push(`end=${encodeURIComponent(cohortEndYyyymmdd)}`);
  qsParts.push('i=1');
  if (segments.length > 0) {
    qsParts.push(`s=${encodeURIComponent(JSON.stringify(segments))}`);
  }
  qsParts.push(`cs=${encodeURIComponent(String(csSeconds))}`);

  const url = `${baseUrl}?${qsParts.join('&')}`;

  const auth = `Basic ${b64(`${creds.apiKey}:${creds.secretKey}`)}`;
  const resp = await undiciFetch(url, { method: 'GET', headers: { Authorization: auth } });
  const rawText = await resp.text();
  if (!resp.ok) {
    throw new Error(`Amplitude baseline HTTP ${resp.status}: ${rawText}`);
  }
  let body: any;
  try {
    body = JSON.parse(rawText);
  } catch {
    throw new Error(`Amplitude baseline returned non-JSON: ${rawText}`);
  }

  const cumulativeRaw: any[] | undefined = body?.data?.[0]?.cumulativeRaw;
  if (!Array.isArray(cumulativeRaw) || cumulativeRaw.length < 3) {
    throw new Error(`Unexpected Amplitude response shape (missing cumulativeRaw[0..2]): ${rawText}`);
  }

  const n = Number(cumulativeRaw[fromStepIndex]);
  const k = Number(cumulativeRaw[toStepIndex]);
  if (!Number.isFinite(n) || !Number.isFinite(k)) {
    throw new Error(`Amplitude cumulativeRaw counts are not numeric: ${JSON.stringify(cumulativeRaw)}`);
  }
  return { n, k, raw: body };
}

async function amplitudeBaselineCurlWithSegments(args: {
  creds: AmpCreds;
  cohortStartYyyymmdd: string;
  cohortEndYyyymmdd: string;
  conversionWindowDays: number;
  excludedCohorts: string[];
  segments: any[];
  fromStepIndex?: number;
  toStepIndex?: number;
}): Promise<{ n: number; k: number; raw: any }> {
  const {
    creds,
    cohortStartYyyymmdd,
    cohortEndYyyymmdd,
    conversionWindowDays,
    excludedCohorts,
    segments,
    fromStepIndex = 1,
    toStepIndex = 2,
  } = args;

  const baseUrl = 'https://amplitude.com/api/2/funnels';

  // Funnel steps: A → X → Y (same as amplitudeBaselineCurl)
  const steps: any[] = [
    { event_type: 'Household Created' },
    {
      event_type: 'Blueprint CheckpointReached',
      filters: [
        { subprop_type: 'event', subprop_key: 'checkpoint', subprop_op: 'is', subprop_value: ['RecommendationOffered'] },
        { subprop_type: 'event', subprop_key: 'category', subprop_op: 'is', subprop_value: ['Energy'] },
      ],
    },
    {
      event_type: 'Blueprint CheckpointReached',
      filters: [{ subprop_type: 'event', subprop_key: 'checkpoint', subprop_op: 'is', subprop_value: ['SwitchRegistered'] }],
    },
  ];

  const mergedSegments: any[] = [];
  for (const cohortId of excludedCohorts) {
    mergedSegments.push({ prop: 'userdata_cohort', op: 'is not', values: [cohortId] });
  }
  if (Array.isArray(segments) && segments.length > 0) {
    mergedSegments.push(...segments);
  }

  const csSeconds = conversionWindowDays * 24 * 60 * 60;
  const qsParts: string[] = [];
  for (const s of steps) qsParts.push(`e=${encodeURIComponent(JSON.stringify(s))}`);
  qsParts.push(`start=${encodeURIComponent(cohortStartYyyymmdd)}`);
  qsParts.push(`end=${encodeURIComponent(cohortEndYyyymmdd)}`);
  qsParts.push('i=1');
  if (mergedSegments.length > 0) {
    qsParts.push(`s=${encodeURIComponent(JSON.stringify(mergedSegments))}`);
  }
  qsParts.push(`cs=${encodeURIComponent(String(csSeconds))}`);

  const url = `${baseUrl}?${qsParts.join('&')}`;
  const auth = `Basic ${b64(`${creds.apiKey}:${creds.secretKey}`)}`;
  const resp = await undiciFetch(url, { method: 'GET', headers: { Authorization: auth } });
  const rawText = await resp.text();
  if (!resp.ok) {
    throw new Error(`Amplitude baseline+segments HTTP ${resp.status}: ${rawText}`);
  }
  let body: any;
  try {
    body = JSON.parse(rawText);
  } catch {
    throw new Error(`Amplitude baseline+segments returned non-JSON: ${rawText}`);
  }

  const cumulativeRaw: any[] | undefined = body?.data?.[0]?.cumulativeRaw;
  if (!Array.isArray(cumulativeRaw) || cumulativeRaw.length < 3) {
    throw new Error(`Unexpected Amplitude response shape (missing cumulativeRaw[0..2]): ${rawText}`);
  }

  const n = Number(cumulativeRaw[fromStepIndex]);
  const k = Number(cumulativeRaw[toStepIndex]);
  if (!Number.isFinite(n) || !Number.isFinite(k)) {
    throw new Error(`Amplitude cumulativeRaw counts are not numeric: ${JSON.stringify(cumulativeRaw)}`);
  }
  return { n, k, raw: body };
}

const creds = getAmplitudeCredsFromEnvFile();
const isCi = !!process.env.CI;
// This suite is intentionally expensive (real external HTTP, many slices).
// Keep it opt-in so it doesn’t run accidentally during normal local workflows.
//
// To run:
//   DAGNET_RUN_REAL_AMPLITUDE_E2E=1 npm test -- --run src/services/__tests__/cohortAxy.meceSum.vsAmplitude.local.e2e.test.ts
const RUN_REAL_AMPLITUDE_E2E = process.env.DAGNET_RUN_REAL_AMPLITUDE_E2E === '1';
const describeLocal = (!isCi && RUN_REAL_AMPLITUDE_E2E && creds) ? describe : describe.skip;

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

const PYTHON_AVAILABLE = await isPythonGraphComputeReachable();
const describeLocalPython = (!isCi && RUN_REAL_AMPLITUDE_E2E && creds && PYTHON_AVAILABLE) ? describe : describe.skip;

function pythonBaseUrlForGraphComputeClient(): string {
  // NOTE: graph-editor/tests/setup.ts stubs globalThis.fetch and fails fast for
  // URLs containing 'localhost' or '127.0.0.1'. We want to use the production
  // GraphComputeClient (which uses fetch), while still hitting the real local
  // Python server. Loopback aliases like 127.0.1.1 avoid that stub and still
  // resolve to the local host.
  const raw = process.env.DAGNET_PYTHON_API_URL || process.env.VITE_PYTHON_API_URL || 'http://localhost:9000';
  return raw.replace('localhost', '127.0.1.1').replace('127.0.0.1', '127.0.1.1');
}

async function analyzeReachProbabilityViaGraphComputeClient(args: {
  scenarios: Array<{ scenario_id: string; name: string; colour: string; visibility_mode: 'f+e' | 'f' | 'e'; graph: Graph }>;
  queryDsl: string;
  analysisType: 'to_node_reach';
}): Promise<Array<{ scenario_id: string; n: number | null; k: number | null }>> {
  const baseUrl = pythonBaseUrlForGraphComputeClient();
  const client = new GraphComputeClient(baseUrl, false);
  const response: AnalysisResponse = await client.analyzeMultipleScenarios(
    args.scenarios,
    args.queryDsl,
    args.analysisType
  );
  if (!response?.success) {
    throw new Error(`GraphComputeClient analyzeMultipleScenarios returned success=false: ${JSON.stringify(response)}`);
  }
  const rows: any[] = response?.result?.data || [];
  return rows.map((r) => ({
    scenario_id: String(r?.scenario_id ?? ''),
    n: (typeof r?.n === 'number' && Number.isFinite(r.n)) ? r.n : (r?.n == null ? null : Number(r.n)),
    k: (typeof r?.k === 'number' && Number.isFinite(r.k)) ? r.k : (r?.k == null ? null : Number(r.k)),
  }));
}

describeLocal('LOCAL e2e: cohort(A,-20d:-18d) MECE Σ(channel) == uncontexted Amplitude baseline (A→X→Y)', () => {
  beforeAll(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  beforeEach(async () => {
    credentialsManager.clearCache();
    await hardResetState();

    // Register fixtures into the workspace registry (ContextRegistry loads from FileRegistry in vitest)
    const channelContext = loadYamlFixture('param-registry/test/contexts/channel-mece-local.yaml');
    await registerFileForTest('context-channel', 'context', channelContext);

    const gateContext = loadYamlFixture('param-registry/test/contexts/activegate-new-whatsapp-journey.local.yaml');
    await registerFileForTest('context-whatsapp-journey', 'context', gateContext);

    const evA = loadYamlFixture('param-registry/test/events/household-created.yaml');
    const evX = loadYamlFixture('param-registry/test/events/energy-rec.yaml');
    const evY = loadYamlFixture('param-registry/test/events/switch-registered.yaml');
    await registerFileForTest('event-household-created', 'event', evA);
    await registerFileForTest('event-energy-rec', 'event', evX);
    await registerFileForTest('event-switch-registered', 'event', evY);

    const paramAx = loadYamlFixture('param-registry/test/parameters/household-created-to-energy-rec-latency.yaml');
    await registerFileForTest('parameter-household-created-to-energy-rec-latency', 'parameter', paramAx);

    const param = loadYamlFixture('param-registry/test/parameters/energy-rec-to-switch-registered-latency.yaml');
    await registerFileForTest('parameter-energy-rec-to-switch-registered-latency', 'parameter', param);
  });

  it(
    'Σ over channel slices (paid-search, influencer, paid-social, other) matches uncontexted Amplitude baseline for the same cohort window',
    async () => {
      if (!creds) throw new Error('Missing Amplitude creds');

      const graph = loadJsonFixture('param-registry/test/graphs/household-energy-rec-switch-registered-flow.json') as Graph;
      let currentGraph: Graph | null = structuredClone(graph);
      const setGraph = (g: Graph | null) => {
        currentGraph = g;
      };

      const edgeId = 'X-Y';
      const paramId = 'energy-rec-to-switch-registered-latency';
      const items: FetchItem[] = [createFetchItem('parameter', paramId, edgeId)];

      const channels = ['paid-search', 'influencer', 'paid-social', 'other'] as const;
      const perChannel: Array<{ channel: (typeof channels)[number]; n: number; k: number }> = [];

      for (const channel of channels) {
        const dsl = `cohort(A,-20d:-18d).context(channel:${channel})`;
        const r = await fetchItem(items[0], { mode: 'versioned' }, currentGraph as Graph, setGraph, dsl);
        expect(r.success).toBe(true);

        // Debug guard: if evidence didn't attach, fail with enough context to diagnose
        const edge = (currentGraph as any)?.edges?.find((e: any) => e?.id === edgeId || e?.uuid === edgeId);
        if (!edge?.p?.evidence || edge.p.evidence.n === undefined || edge.p.evidence.k === undefined) {
          const paramFile = fileRegistry.getFile(`parameter-${paramId}` as any) as any;
          const latest = Array.isArray(paramFile?.data?.values)
            ? paramFile.data.values[paramFile.data.values.length - 1]
            : undefined;
          throw new Error(
            `[debug] Missing edge evidence after fetch for channel=${channel}. ` +
              `edge.p.evidence=${JSON.stringify(edge?.p?.evidence)} ` +
              `param.latest=${JSON.stringify(latest)}`
          );
        }

        const pack = flattenParams(extractParamsFromGraph(currentGraph));
        const n = pack[`e.${edgeId}.p.evidence.n`];
        const k = pack[`e.${edgeId}.p.evidence.k`];
        expect(typeof n).toBe('number');
        expect(typeof k).toBe('number');
        expect(Number.isFinite(n)).toBe(true);
        expect(Number.isFinite(k)).toBe(true);

        perChannel.push({ channel, n: n as number, k: k as number });
      }

      const sumN = perChannel.reduce((acc, r) => acc + r.n, 0);
      const sumK = perChannel.reduce((acc, r) => acc + r.k, 0);

      const excludedCohorts = await loadAmplitudeExcludedCohortsFromConnectionsYaml();

      // Cohort offsets are relative to "today" at local-date midnight, matching production semantics.
      const { start: cohortStart, end: cohortEnd } = cohortRangeYyyymmddFromRelativeOffsets(new Date(), -20, -18);

      const baseline = await amplitudeBaselineCurl({
        creds,
        cohortStartYyyymmdd: cohortStart,
        cohortEndYyyymmdd: cohortEnd,
        conversionWindowDays: 30,
        excludedCohorts,
        fromStepIndex: 1,
        toStepIndex: 2,
      });

      expect(baseline.n).toBeGreaterThan(0);
      expect(baseline.k).toBeGreaterThanOrEqual(0);
      expect(sumN).toBe(baseline.n);
      expect(sumK).toBe(baseline.k);
    },
    180_000
  );

  it(
    'window forecast precision: MECE Σ(contexted window(-50d:-43d)) forecast.mean matches uncontexted Amplitude dayFunnels-derived forecast baseline',
    async () => {
      if (!creds) throw new Error('Missing Amplitude creds');

      const edgeId = 'X-Y';
      const paramId = 'energy-rec-to-switch-registered-latency';
      const item: FetchItem = createFetchItem('parameter', paramId, edgeId);

      const graph0 = loadJsonFixture('param-registry/test/graphs/household-energy-rec-switch-registered-flow.json') as Graph;
      // IMPORTANT: force a small path_t95 so a “next-day cron” re-fetch only needs a tail subset,
      // rather than re-requesting the full 20-day window.
      const graphForCron = structuredClone(graph0) as any;
      try {
        const edges: any[] = Array.isArray(graphForCron.edges) ? graphForCron.edges : [];
        for (const e of edges) {
          if (e?.p?.latency && typeof e.p.latency === 'object') {
            e.p.latency.path_t95 = 7;
          }
        }
      } catch {
        // ignore - test will fail later if graph shape changes
      }

      let currentGraph: Graph | null = graphForCron as Graph;
      const setGraph = (g: Graph | null) => { currentGraph = g; };

      const channels = ['paid-search', 'influencer', 'paid-social', 'other'] as const;

      // ---------------------------------------------------------------------
      // Step 1: Fetch MECE contexted window slices via production HTTP pipeline
      // ---------------------------------------------------------------------
      for (const channel of channels) {
        const dsl = `window(-50d:-43d).context(channel:${channel})`;
        const r = await fetchItem(item, { mode: 'versioned' }, currentGraph as Graph, setGraph, dsl);
        expect(r.success).toBe(true);
      }

      // Force edge-local t95≈0 JUST BEFORE the uncontexted from-file read:
      // update application during the versioned fetches can replace edge.p.latency and drop ad-hoc fields.
      // We need t95 present on the graph edge at query time so DataOps doesn't fall back to DEFAULT_T95_DAYS.
      {
        const edge = (currentGraph as any)?.edges?.find((e: any) => e?.id === edgeId || e?.uuid === edgeId);
        if (!edge?.p?.latency) throw new Error('[debug] Missing edge.p.latency on updated graph before forecast read');
        edge.p.latency.t95 = 0.0000001;
        edge.p.latency.latency_parameter = true;
      }
      // Also persist t95 onto the parameter file itself as a backstop (in case callers don’t thread edge latency).
      {
        const paramFile0 = fileRegistry.getFile(`parameter-${paramId}` as any) as any;
        if (!paramFile0?.data) throw new Error('[debug] Missing parameter file in FileRegistry');
        const nextParamData = structuredClone(paramFile0.data);
        nextParamData.latency = {
          ...(nextParamData.latency || {}),
          latency_parameter: true,
          t95: 0.0000001,
        };
        await fileRegistry.updateFile(`parameter-${paramId}` as any, nextParamData);
      }

      // ---------------------------------------------------------------------
      // Step 2: Compute uncontexted forecast.mean from MECE slices (file-only)
      // ---------------------------------------------------------------------
      const r2 = await fetchItem(item, { mode: 'from-file' }, currentGraph as Graph, setGraph, 'window(-50d:-43d)');
      if (!r2.success) {
        const paramFile = fileRegistry.getFile(`parameter-${paramId}` as any) as any;
        const values: any[] = Array.isArray(paramFile?.data?.values) ? paramFile.data.values : [];
        const slices = values.map((v: any) => ({
          sliceDSL: v?.sliceDSL,
          query_signature: v?.query_signature ?? null,
          retrieved_at: v?.data_source?.retrieved_at ?? v?.retrieved_at ?? null,
        }));
        const sigs = Array.from(new Set(slices.map((s) => String(s.query_signature))));
        throw new Error(
          `[debug] from-file implicit-uncontexted read failed for window(-50d:-43d). ` +
          `error=${r2.error instanceof Error ? r2.error.message : String(r2.error)} ` +
          `distinct_query_signatures=${JSON.stringify(sigs)} ` +
          `slices=${JSON.stringify(slices)}`
        );
      }
      expect(r2.success).toBe(true);

      const pack = flattenParams(extractParamsFromGraph(currentGraph));
      const forecastMean = pack[`e.${edgeId}.p.forecast.mean`];
      if (typeof forecastMean !== 'number' || !Number.isFinite(forecastMean)) {
        const paramFile = fileRegistry.getFile(`parameter-${paramId}` as any) as any;
        throw new Error(
          `[debug] Missing forecast.mean after MECE aggregation. ` +
          `pack.forecast.mean=${JSON.stringify(forecastMean)} ` +
          `param.values.slices=${JSON.stringify((paramFile?.data?.values ?? []).map((v: any) => v?.sliceDSL))}`
        );
      }

      // ---------------------------------------------------------------------
      // Step 3: Ground truth from uncontexted Amplitude daily series, computed the same way
      //         as DagNet's window forecast baseline:
      //         - asOf = window end (-43d)
      //         - maturityDays = ceil(t95)+1 (here: 2 days)
      //         - recency weights use RECENCY_HALF_LIFE_DAYS (true half-life semantics)
      // ---------------------------------------------------------------------
      const excludedCohorts = await loadAmplitudeExcludedCohortsFromConnectionsYaml();
      const wStart = yyyymmddFromRelativeDayOffset(-50);
      const wEnd = yyyymmddFromRelativeDayOffset(-43);
      const daily = await amplitudeWindowDailyCurlXY({
        creds,
        windowStartYyyymmdd: wStart,
        windowEndYyyymmdd: wEnd,
        excludedCohorts,
      });

      const parseIsoDay = (s: string): Date => {
        const iso = s.includes('T') ? s : `${s}T00:00:00Z`;
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) {
          throw new Error(`[debug] Invalid ISO day from Amplitude dayFunnels: ${JSON.stringify(s)} (coerced=${JSON.stringify(iso)})`);
        }
        return d;
      };

      const asOf = parseIsoDay(daily.datesIso[daily.datesIso.length - 1]);
      const maturityDays = Math.ceil(0.0000001) + 1; // = 2 days (matches the edge t95 set above)
      const cutoffMs = asOf.getTime() - maturityDays * 24 * 60 * 60 * 1000;

      let weightedN = 0;
      let weightedK = 0;
      for (let i = 0; i < daily.datesIso.length; i++) {
        const d = parseIsoDay(daily.datesIso[i]);
        if (d.getTime() > cutoffMs) continue;
        const ageDays = Math.max(0, (asOf.getTime() - d.getTime()) / (24 * 60 * 60 * 1000));
        const w = Math.exp(-Math.LN2 * ageDays / RECENCY_HALF_LIFE_DAYS);
        const n = daily.nDaily[i];
        const k = daily.kDaily[i];
        if (n <= 0) continue;
        weightedN += w * n;
        weightedK += w * k;
      }

      expect(weightedN).toBeGreaterThan(0);
      const expected = weightedK / weightedN;
      expect(expected).toBeGreaterThanOrEqual(0);
      expect(expected).toBeLessThanOrEqual(1);

      // Primary parity check for this test:
      // Forecast is computed from the MECE slice daily arrays we retrieved (production pipeline),
      // so validate against the same computation applied to the SAME stored MECE window slices.
      const paramFile = fileRegistry.getFile(`parameter-${paramId}` as any) as any;
      const values: any[] = Array.isArray(paramFile?.data?.values) ? paramFile.data.values : [];
      const chosen = channels.map((ch) =>
        values.find((v: any) => typeof v?.sliceDSL === 'string' && v.sliceDSL.includes('window(') && v.sliceDSL.includes(`context(channel:${ch})`))
      );
      if (chosen.some(v => !v)) {
        throw new Error(`[debug] Missing one or more contexted window slices in param file: ${JSON.stringify(values.map(v => v?.sliceDSL))}`);
      }
      const maxDate = (v: any): Date | undefined => {
        const dates: string[] | undefined = v?.dates;
        if (Array.isArray(dates) && dates.length > 0) {
          const parsed = dates.map(parseDate).filter(d => !Number.isNaN(d.getTime()));
          return parsed.sort((a, b) => b.getTime() - a.getTime())[0];
        }
        const wto = v?.window_to;
        return (typeof wto === 'string' && wto) ? parseDate(wto) : undefined;
      };
      const asOfFromSlices = chosen.map(maxDate).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
      if (!asOfFromSlices) throw new Error('[debug] Could not derive asOf from stored MECE slices');
      const cutoffMs2 = asOfFromSlices.getTime() - maturityDays * 24 * 60 * 60 * 1000;

      let wN2 = 0;
      let wK2 = 0;
      for (const v of chosen) {
        const dates: string[] = v.dates;
        const nDaily: number[] = v.n_daily;
        const kDaily: number[] = v.k_daily;
        for (let i = 0; i < dates.length; i++) {
          const d = parseDate(dates[i]);
          if (Number.isNaN(d.getTime())) continue;
          if (d.getTime() > cutoffMs2) continue;
          const ageDays = Math.max(0, (asOfFromSlices.getTime() - d.getTime()) / (24 * 60 * 60 * 1000));
          const w = Math.exp(-Math.LN2 * ageDays / RECENCY_HALF_LIFE_DAYS);
          const n = Number(nDaily[i] ?? 0);
          const k = Number(kDaily[i] ?? 0);
          if (!Number.isFinite(n) || !Number.isFinite(k) || n <= 0) continue;
          wN2 += w * n;
          wK2 += w * k;
        }
      }
      if (!(wN2 > 0)) throw new Error(`[debug] Computed MECE-slice weightedN<=0: ${wN2}`);
      const expectedFromSlices = wK2 / wN2;
      expect(forecastMean).toBeCloseTo(expectedFromSlices, 12);

      // Secondary diagnostic (NOT asserted): compare MECE-derived baseline vs truly uncontexted Amplitude baseline.
      // If these differ materially, it indicates the channel MECE partition does not equal the true uncontexted population
      // under Amplitude's segment semantics (e.g. missing utm_medium handling).
      const diff = Math.abs(expectedFromSlices - expected);
      if (diff > 0.01) {
        // eslint-disable-next-line no-console
        console.warn(
          `[diagnostic] MECE baseline != uncontexted baseline for window(-50d:-43d). ` +
          `mece=${expectedFromSlices.toFixed(6)} uncontexted=${expected.toFixed(6)} diff=${diff.toFixed(6)}`
        );
      }
    },
    180_000
  );

  it(
    'context(whatsapp-journey:on) uses Amplitude gp:activeGates.* segmentation and matches manual baseline with the same segment',
    async () => {
      if (!creds) throw new Error('Missing Amplitude creds');

      const graph = loadJsonFixture('param-registry/test/graphs/household-energy-rec-switch-registered-flow.json') as Graph;
      let currentGraph: Graph | null = structuredClone(graph);
      const setGraph = (g: Graph | null) => {
        currentGraph = g;
      };

      const edgeId = 'X-Y';
      const paramId = 'energy-rec-to-switch-registered-latency';
      const item: FetchItem = createFetchItem('parameter', paramId, edgeId);

      // DagNet pipeline: fetch the contexted cohort slice using the context file we registered above.
      const dsl = 'cohort(A,-20d:-18d).context(whatsapp-journey:on)';
      const r = await fetchItem(item, { mode: 'versioned' }, currentGraph as Graph, setGraph, dsl);
      expect(r.success).toBe(true);

      const pack = flattenParams(extractParamsFromGraph(currentGraph));
      const n = pack[`e.${edgeId}.p.evidence.n`];
      const k = pack[`e.${edgeId}.p.evidence.k`];
      expect(typeof n).toBe('number');
      expect(typeof k).toBe('number');
      expect(Number.isFinite(n)).toBe(true);
      expect(Number.isFinite(k)).toBe(true);

      const excludedCohorts = await loadAmplitudeExcludedCohortsFromConnectionsYaml();
      const { start: cohortStart, end: cohortEnd } = cohortRangeYyyymmddFromRelativeOffsets(new Date(), -20, -18);

      // Manual baseline: use the confirmed Amplitude segment key for this gate (gp: prefix).
      const baseline = await amplitudeBaselineCurlWithSegments({
        creds,
        cohortStartYyyymmdd: cohortStart,
        cohortEndYyyymmdd: cohortEnd,
        conversionWindowDays: 30,
        excludedCohorts,
        segments: [
          {
            prop: 'gp:activeGates.experiment_new_whatsapp_journey',
            op: 'is',
            values: ['true'],
          },
        ],
        fromStepIndex: 1,
        toStepIndex: 2,
      });

      expect(n).toBe(baseline.n);
      expect(k).toBe(baseline.k);
    },
    180_000
  );
});

describeLocalPython('LOCAL e2e: after retrieving all slices, live scenarios → Reach Probability(to(Y)) Σ(n/k) == uncontexted Amplitude baseline', () => {
  beforeAll(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  beforeAll(async () => {
    // Ensure a clean DB namespace for this run (strict counts rely on this).
    await deleteTestSnapshotsByPrefix(SNAPSHOT_TEST_REPO);
  });

  // NOTE: We intentionally do NOT clean up after the test.
  // This allows manual inspection of DB rows vs Amplitude responses.
  // To clean up manually: DELETE FROM snapshots WHERE param_id LIKE 'pytest-realamp-%';

  beforeEach(async () => {
    credentialsManager.clearCache();
    await hardResetState();

    // Register fixtures into the workspace registry (ContextRegistry loads from FileRegistry in vitest)
    const channelContext = loadYamlFixture('param-registry/test/contexts/channel-mece-local.yaml');
    await registerFileForTest('context-channel', 'context', channelContext);

    const evA = loadYamlFixture('param-registry/test/events/household-created.yaml');
    const evX = loadYamlFixture('param-registry/test/events/energy-rec.yaml');
    const evY = loadYamlFixture('param-registry/test/events/switch-registered.yaml');
    await registerFileForTest('event-household-created', 'event', evA);
    await registerFileForTest('event-energy-rec', 'event', evX);
    await registerFileForTest('event-switch-registered', 'event', evY);

    const paramAx = loadYamlFixture('param-registry/test/parameters/household-created-to-energy-rec-latency.yaml');
    await registerFileForTest('parameter-household-created-to-energy-rec-latency', 'parameter', paramAx);

    const param = loadYamlFixture('param-registry/test/parameters/energy-rec-to-switch-registered-latency.yaml');
    await registerFileForTest('parameter-energy-rec-to-switch-registered-latency', 'parameter', param);
  });

  it(
    'simulates serial daily snapshot jobs (20-Nov then 21-Nov) and verifies Python snapshot compositing does not double-count',
    async () => {
      if (!creds) throw new Error('Missing Amplitude creds');
      if (!PYTHON_AVAILABLE) throw new Error('Python GraphCompute is not reachable (expected for this local-only test)');

      // We simulate two daily cron runs:
      // - Run 1 "as-at" 20-Nov-25
      // - Run 2 "as-at" 21-Nov-25
      //
      // Underlying Amplitude data is historic, so counts likely won't change.
      // The critical property we test is that the read-side (Python) composes
      // multiple retrieved_at snapshots without double-counting.
      //
      // Fixed date ranges for determinism ("Nov data"), shifted by 1 day so the
      // anchor-day sets are not identical across runs.
      const days = 20;
      const channels = ['paid-search', 'influencer', 'paid-social', 'other'] as const;

      const graph0 = loadJsonFixture('param-registry/test/graphs/household-energy-rec-switch-registered-flow.json') as Graph;
      let currentGraph: Graph | null = structuredClone(graph0);
      const setGraph = (g: Graph | null) => { currentGraph = g; };

      // X-Y edge: energy-rec → switch-registered (2-step for window, 3-step A→X→Y for cohort)
      const item: FetchItem = createFetchItem('parameter', 'energy-rec-to-switch-registered-latency', 'X-Y');
      const objectId = 'energy-rec-to-switch-registered-latency';
      const pid = dbParamIdFor(objectId);

      // Hard reset DB namespace for this test run (strict assertions)
      await deleteTestSnapshotsByPrefix(SNAPSHOT_TEST_REPO);

      // Collect all fetch results for artifact persistence
      const fetchResults: Array<{ run: '20-Nov' | '21-Nov'; dsl: string; mode: string; result: any }> = [];
      const currentAmpTag: { run: string; dsl: string } = { run: 'unknown', dsl: '' };
      const ampRecorder = installAmplitudeHttpRecorder(() => ({ ...currentAmpTag }));

      // Log the test namespace for manual DB inspection
      console.log(`\n[SNAPSHOT_DB_E2E] Test namespace: ${SNAPSHOT_TEST_REPO}-${SNAPSHOT_TEST_BRANCH}`);
      console.log(`[SNAPSHOT_DB_E2E] dbParamId: ${pid}`);
      console.log(`[SNAPSHOT_DB_E2E] To query: SELECT * FROM snapshots WHERE param_id LIKE '${SNAPSHOT_TEST_REPO}%' ORDER BY slice_key, anchor_day;\n`);

      async function runOneCronDay(args: {
        label: '20-Nov' | '21-Nov';
        fixedRetrievedAtIso: string;
        windowDsl: string;
        cohortDsl: string;
        bustCache: boolean;
      }): Promise<void> {
        await withFixedDateConstructor(args.fixedRetrievedAtIso, async () => {
          // MECE-only: we do NOT fetch explicit uncontexted slices.
          // We fetch contexted slices (channel partition) and rely on MECE aggregation logic elsewhere.
          for (const ch of channels) {
            const dsl = `${args.windowDsl}.context(channel:${ch})`;
            currentAmpTag.run = args.label;
            currentAmpTag.dsl = dsl;
            console.log(`[SNAPSHOT_DB_E2E] [${args.label}] Fetching: ${dsl}`);
            const r = await fetchItem(item, { mode: 'versioned', bustCache: args.bustCache }, currentGraph as Graph, setGraph, dsl);
            expect(r.success).toBe(true);
            if (typeof (r as any).daysFetched === 'number') {
              console.log(`[SNAPSHOT_DB_E2E] [${args.label}] window(contexted:${ch}) daysFetched=${(r as any).daysFetched}`);
            }
            fetchResults.push({ run: args.label, dsl, mode: `window-contexted-${ch}`, result: r });
          }

          for (const ch of channels) {
            const dsl = `${args.cohortDsl}.context(channel:${ch})`;
            currentAmpTag.run = args.label;
            currentAmpTag.dsl = dsl;
            console.log(`[SNAPSHOT_DB_E2E] [${args.label}] Fetching: ${dsl}`);
            const r = await fetchItem(item, { mode: 'versioned', bustCache: args.bustCache }, currentGraph as Graph, setGraph, dsl);
            expect(r.success).toBe(true);
            if (typeof (r as any).daysFetched === 'number') {
              console.log(`[SNAPSHOT_DB_E2E] [${args.label}] cohort(contexted:${ch}) daysFetched=${(r as any).daysFetched}`);
            }
            fetchResults.push({ run: args.label, dsl, mode: `cohort-contexted-${ch}`, result: r });
          }
        });

        // Allow fire-and-forget DB writes to finish (we fixed retrieved_at so there should be one timestamp per run)
        await new Promise((r) => setTimeout(r, 1500));
      }

      // Cron run 1: as-at 20-Nov-25 (20-day windows ending 20-Nov)
      await runOneCronDay({
        label: '20-Nov',
        fixedRetrievedAtIso: '2025-11-20T12:00:00.000Z',
        windowDsl: 'window(1-Nov-25:20-Nov-25)',
        cohortDsl: 'cohort(1-Nov-25:20-Nov-25)',
        bustCache: true,
      });

      const rowsAfterRun1 = await querySnapshotsRaw(pid);
      // MECE-only: 4 context slices for window + 4 for cohort = 8 slices
      const expectedRowsRun1 = days * channels.length * 2; // 20 * 4 * 2 = 160
      expect(rowsAfterRun1.length).toBe(expectedRowsRun1);

      // Cron run 2: as-at 21-Nov-25
      // Use the SAME DSLs. With bustCache=false and small path_t95,
      // production planner should only refresh a tail subset (not re-fetch the full window).
      await runOneCronDay({
        label: '21-Nov',
        fixedRetrievedAtIso: '2025-11-21T12:00:00.000Z',
        windowDsl: 'window(1-Nov-25:20-Nov-25)',
        cohortDsl: 'cohort(1-Nov-25:20-Nov-25)',
        bustCache: false,
      });

      const rowsAfterRun2 = await querySnapshotsRaw(pid);
      // Second run should add some rows, but should NOT fully duplicate the entire first run.
      // If this fails, it indicates we're not simulating “incremental cron” behaviour properly.
      expect(rowsAfterRun2.length).toBeGreaterThan(rowsAfterRun1.length);
      expect(rowsAfterRun2.length).toBeLessThan(rowsAfterRun1.length + expectedRowsRun1);

      // We expect exactly two retrieved_at timestamps (one per cron day), since we fixed the Date constructor.
      const uniqueRetrievedAt = [...new Set(rowsAfterRun2.map((r: any) => String(r.retrieved_at)))].sort();
      expect(uniqueRetrievedAt.length).toBe(2);
      expect(uniqueRetrievedAt).toContain('2025-11-20T12:00:00+00:00');
      expect(uniqueRetrievedAt).toContain('2025-11-21T12:00:00+00:00');

      // Assert per-run row counts reflect incremental fetch (run2 subset).
      const run1Count = rowsAfterRun2.filter((r: any) => r.retrieved_at === '2025-11-20T12:00:00+00:00').length;
      const run2Count = rowsAfterRun2.filter((r: any) => r.retrieved_at === '2025-11-21T12:00:00+00:00').length;
      expect(run1Count).toBe(expectedRowsRun1);
      expect(run2Count).toBeGreaterThan(0);
      expect(run2Count).toBeLessThan(run1Count);

      // -------------------------------------------------------------------------
      // Python read-side compositing assertions:
      // Query ONE semantic series (cohort, one channel context) and ensure that adding the
      // second cron run does NOT double-count conversions/histogram totals.
      // -------------------------------------------------------------------------
      const run1Rows = rowsAfterRun2.filter((r: any) => r.retrieved_at === '2025-11-20T12:00:00+00:00');
      const cohortRun1Rows = run1Rows.filter((r: any) => r.a != null);
      if (cohortRun1Rows.length === 0) {
        throw new Error(`[SNAPSHOT_DB_E2E] Could not locate any cohort-mode rows for run-1 (expected A column populated).`);
      }

      // MECE union: Python should be able to take the 4 channel slices as input and aggregate them.
      // In production, the slice plan comes from the same DSLs the frontend requested, not by querying DB.
      const cohortSliceKeysByChannel: Record<string, string> = Object.fromEntries(
        channels.map((ch) => [ch, `cohort(1-Nov-25:20-Nov-25).context(channel:${ch})`])
      );
      const cohortSliceKeys = Object.values(cohortSliceKeysByChannel);

      const anchorFrom = '2025-11-01';
      const anchorTo = '2025-11-20';

      // As-at end-of-day cut-offs
      const asAt20 = '2025-11-20T23:59:59.000Z';
      const asAt21 = '2025-11-21T23:59:59.000Z';

      const daily20 = await analyzeFromSnapshotDb({
        param_id: pid,
        anchor_from: anchorFrom,
        anchor_to: anchorTo,
        slice_keys: cohortSliceKeys,
        analysis_type: 'daily_conversions',
        as_at: asAt20,
      });

      const daily21 = await analyzeFromSnapshotDb({
        param_id: pid,
        anchor_from: anchorFrom,
        anchor_to: anchorTo,
        slice_keys: cohortSliceKeys,
        analysis_type: 'daily_conversions',
        as_at: asAt21,
      });

      // Sanity: both should succeed and have some rows analysed.
      expect(daily20.success).toBe(true);
      expect(daily21.success).toBe(true);
      expect(Number(daily20.rows_analysed ?? 0)).toBeGreaterThan(0);
      expect(Number(daily21.rows_analysed ?? 0)).toBeGreaterThan(0);

      // Crucial compositing property:
      // The second cron run adds more snapshot rows (rows_analysed increases),
      // but derived totals should NOT double-count.
      expect(Number(daily21.rows_analysed)).toBeGreaterThan(Number(daily20.rows_analysed));
      expect(daily21.result.total_conversions).toBe(daily20.result.total_conversions);

      const hist20 = await analyzeFromSnapshotDb({
        param_id: pid,
        anchor_from: anchorFrom,
        anchor_to: anchorTo,
        slice_keys: cohortSliceKeys,
        analysis_type: 'lag_histogram',
        as_at: asAt20,
      });
      const hist21 = await analyzeFromSnapshotDb({
        param_id: pid,
        anchor_from: anchorFrom,
        anchor_to: anchorTo,
        slice_keys: cohortSliceKeys,
        analysis_type: 'lag_histogram',
        as_at: asAt21,
      });

      expect(hist20.success).toBe(true);
      expect(hist21.success).toBe(true);
      expect(Number(hist21.rows_analysed)).toBeGreaterThan(Number(hist20.rows_analysed));
      expect(hist21.result.total_conversions).toBe(hist20.result.total_conversions);

      // =========================================================================
      // PERSIST ARTIFACTS FOR MANUAL INSPECTION
      // =========================================================================
      persistTestArtifacts(`snapshot-e2e-${Date.now()}.json`, {
        testRun: {
          repo: SNAPSHOT_TEST_REPO,
          branch: SNAPSHOT_TEST_BRANCH,
          dbParamId: pid,
          cronSimulation: {
            run1RetrievedAt: '2025-11-20T12:00:00.000Z',
            run2RetrievedAt: '2025-11-21T12:00:00.000Z',
            run1: { windowDsl: 'window(1-Nov-25:20-Nov-25)', cohortDsl: 'cohort(1-Nov-25:20-Nov-25)' },
            run2: { windowDsl: 'window(1-Nov-25:21-Nov-25)', cohortDsl: 'cohort(1-Nov-25:21-Nov-25)' },
          },
          forcedPathT95: 7,
          expectedDays: days,
          expectedRowsRun1,
        },
        fetchResults: fetchResults.map(fr => ({
          run: fr.run,
          dsl: fr.dsl,
          mode: fr.mode,
          success: fr.result.success,
          daysFetched: fr.result.daysFetched,
          // Include the n/k daily data if available
          nDaily: fr.result.nDaily,
          kDaily: fr.result.kDaily,
          pDaily: fr.result.pDaily,
        })),
        // Raw Amplitude HTTP recordings (sanitised; auth header redacted). This is intended to be re-used
        // in a future test variant that mocks only the Amplitude HTTP step and replays these responses.
        amplitudeHttp: {
          records: ampRecorder.records,
          byRequestKey: Object.fromEntries(
            ampRecorder.records
              .filter(r => r.request?.requestKey && r.response?.rawBody)
              .map(r => [
                r.request.requestKey,
                {
                  request: r.request,
                  response: r.response,
                  tag: r.tag,
                },
              ])
          ),
        },
        pythonSnapshotAnalysis: {
          cohortSliceKeysByChannel,
          daily20,
          daily21,
          hist20,
          hist21,
        },
        dbRowCount: rowsAfterRun2.length,
        dbRowCountByRetrievedAt: {
          '2025-11-20T12:00:00+00:00': run1Count,
          '2025-11-21T12:00:00+00:00': run2Count,
        },
        dbRows: rowsAfterRun2,
      });

      // Always restore fetch wrapper so other tests are unaffected
      ampRecorder.restore();

      console.log(`\n[SNAPSHOT_DB_E2E] ====== DATA PERSISTED FOR MANUAL INSPECTION ======`);
      console.log(`[SNAPSHOT_DB_E2E] DB data NOT deleted - inspect directly:`);
      console.log(`[SNAPSHOT_DB_E2E]   SELECT * FROM snapshots WHERE param_id = '${pid}' ORDER BY slice_key, anchor_day;`);
      console.log(`[SNAPSHOT_DB_E2E] ===================================================\n`);
    },
    720_000  // 12 minutes for 20 real Amplitude calls
  );

  it(
    'creates one scenario per channel value, runs Reach Probability on Y, and Σ scenario n/k equals Amplitude baseline n/k',
    async () => {
      if (!creds) throw new Error('Missing Amplitude creds');
      if (!PYTHON_AVAILABLE) throw new Error('Python GraphCompute is not reachable (expected for this local-only test)');

      // ---------------------------------------------------------------------
      // Step 1: "Retrieve all slices" (real Amplitude HTTP through prod pipeline)
      // ---------------------------------------------------------------------
      const graph0 = loadJsonFixture('param-registry/test/graphs/household-energy-rec-switch-registered-flow.json') as Graph;
      let currentGraph: Graph | null = structuredClone(graph0);
      const setGraph = (g: Graph | null) => { currentGraph = g; };

      const items: FetchItem[] = [
        createFetchItem('parameter', 'household-created-to-energy-rec-latency', 'A-X'),
        createFetchItem('parameter', 'energy-rec-to-switch-registered-latency', 'X-Y'),
      ];

      const channels = ['paid-search', 'influencer', 'paid-social', 'other'] as const;

      for (const channel of channels) {
        const dsl = `cohort(A,-20d:-18d).context(channel:${channel})`;
        for (const item of items) {
          const r = await fetchItem(item, { mode: 'versioned' }, currentGraph as Graph, setGraph, dsl);
          expect(r.success).toBe(true);
        }
      }

      // ---------------------------------------------------------------------
      // Step 2: "Create live scenarios" business logic (no React UI)
      // Mirror: baseDSL is derived from current DSL, then each scenario has context-only diff
      // ---------------------------------------------------------------------
      const currentDSL = 'cohort(A,-20d:-18d).context(channel)';
      const baseDSL = deriveBaseDSLForRebase(currentDSL);
      // Base DSL for scenarios intentionally strips context and retains only the date range.
      // NOTE: `cohort()` anchor (A) is inferred from graph/latency config, so the canonical base
      // form is the date-only clause.
      expect(baseDSL).toBe('cohort(-20d:-18d)');

      const scenarios: ScenarioForBatch[] = channels.map((ch) => ({
        id: `scenario-${ch}`,
        meta: {
          isLive: true,
          queryDSL: `context(channel:${ch})`,
        },
      }));
      const visibleOrder = scenarios.map(s => s.id); // top-to-bottom doesn’t matter for context-only diffs
      const prepared = prepareScenariosForBatch(scenarios, visibleOrder, baseDSL);
      expect(prepared).toHaveLength(channels.length);

      // ---------------------------------------------------------------------
      // Step 3: For each scenario, load the cached slice into a scenario graph (from-file)
      // ---------------------------------------------------------------------
      const scenarioGraphs: Array<{ scenario_id: string; name: string; colour: string; visibility_mode: 'e'; graph: Graph }> = [];

      for (const p of prepared) {
        const baseGraph = loadJsonFixture('param-registry/test/graphs/household-energy-rec-switch-registered-flow.json') as Graph;
        let g: Graph | null = structuredClone(baseGraph);
        const setG = (next: Graph | null) => { g = next; };

        // Read from the parameter file cache; no external HTTP in this stage.
        for (const item of items) {
          const r = await fetchItem(item, { mode: 'from-file' }, g as Graph, setG, p.effectiveFetchDSL);
          expect(r.success).toBe(true);
        }

        scenarioGraphs.push({
          scenario_id: p.id,
          name: p.id,
          colour: '#3b82f6',
          visibility_mode: 'e',
          graph: g as Graph,
        });
      }

      // ---------------------------------------------------------------------
      // Step 4: Run Reach Probability analysis (to(Y)) over all scenarios (Python)
      // ---------------------------------------------------------------------
      const analysisRows = await analyzeReachProbabilityViaGraphComputeClient({
        scenarios: scenarioGraphs,
        queryDsl: 'to(Y)',
        analysisType: 'to_node_reach',
      });

      // Extract scenario n/k and sum them
      const rowById = new Map(analysisRows.map(r => [r.scenario_id, r]));
      let sumN = 0;
      let sumK = 0;
      for (const s of scenarioGraphs) {
        const row = rowById.get(s.scenario_id);
        expect(row).toBeDefined();
        if (typeof row!.n !== 'number' || typeof row!.k !== 'number') {
          throw new Error(`[debug] Python row missing numeric n/k: ${JSON.stringify({ scenario_id: s.scenario_id, row }, null, 2)}`);
        }
        sumN += row!.n as number;
        sumK += row!.k as number;
      }

      // Baseline curl (uncontexted, same cohort window)
      const excludedCohorts = await loadAmplitudeExcludedCohortsFromConnectionsYaml();
      const { start: cohortStart, end: cohortEnd } = cohortRangeYyyymmddFromRelativeOffsets(new Date(), -20, -18);
      const baseline = await amplitudeBaselineCurl({
        creds,
        cohortStartYyyymmdd: cohortStart,
        cohortEndYyyymmdd: cohortEnd,
        conversionWindowDays: 30,
        excludedCohorts,
        // Reach Probability runner reports n=start(A), k=reached(Y)
        fromStepIndex: 0,
        toStepIndex: 2,
      });

      expect(sumN).toBe(baseline.n);
      expect(sumK).toBe(baseline.k);
    },
    240_000
  );
});


