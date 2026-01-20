/**
 * LOCAL-ONLY Real Amplitude E2E:
 * Proves that a context mapping to an Amplitude user property gate flag works end-to-end.
 *
 * We validate:
 * - a real context file (param-registry fixture) is loaded into FileRegistry
 * - DagNet fetch pipeline uses that context to build Amplitude segmentation
 * - the resulting (n,k) matches a manual Amplitude baseline request using the same segment
 *
 * Env file:
 * - Create repo-root `.env.amplitude.local` (gitignored)
 * - See `local-env/amplitude.env.example` for the required keys
 *
 * Run:
 *   cd graph-editor && DAGNET_RUN_REAL_AMPLITUDE_E2E=1 npm test -- --run src/services/__tests__/activeGateContext.amplitude.local.e2e.test.ts
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { fetch as undiciFetch } from 'undici';

import type { Graph } from '../../types';
import { credentialsManager } from '../../lib/credentials';
import { fileRegistry } from '../../contexts/TabContext';
import { db } from '../../db/appDatabase';
import { fetchItem, createFetchItem, type FetchItem } from '../fetchDataService';
import { extractParamsFromGraph } from '../GraphParamExtractor';
import { flattenParams } from '../ParamPackDSLService';

type AmpCreds = { apiKey: string; secretKey: string };

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
    source: { repository: 'test', branch: 'main', isLocal: true } as any,
    viewTabs: [],
    lastModified: Date.now(),
  } as any);
}

async function hardResetState(): Promise<void> {
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

  // Funnel steps: A → X → Y
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
const RUN_REAL_AMPLITUDE_E2E = process.env.DAGNET_RUN_REAL_AMPLITUDE_E2E === '1';
const describeLocal = (!isCi && RUN_REAL_AMPLITUDE_E2E && creds) ? describe : describe.skip;

describeLocal('LOCAL e2e: context(active gate) matches manual Amplitude segment (gp:activeGates.*)', () => {
  beforeAll(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  beforeEach(async () => {
    credentialsManager.clearCache();
    await hardResetState();

    // Register the gate context into FileRegistry (ContextRegistry loads from FileRegistry in vitest)
    const gateContext = loadYamlFixture('param-registry/test/contexts/activegate-new-whatsapp-journey.local.yaml');
    await registerFileForTest('context-whatsapp-journey', 'context', gateContext);

    // Event + parameter fixtures needed for the X→Y edge query build
    const evA = loadYamlFixture('param-registry/test/events/household-created.yaml');
    const evX = loadYamlFixture('param-registry/test/events/energy-rec.yaml');
    const evY = loadYamlFixture('param-registry/test/events/switch-registered.yaml');
    await registerFileForTest('event-household-created', 'event', evA);
    await registerFileForTest('event-energy-rec', 'event', evX);
    await registerFileForTest('event-switch-registered', 'event', evY);

    const param = loadYamlFixture('param-registry/test/parameters/energy-rec-to-switch-registered-latency.yaml');
    await registerFileForTest('parameter-energy-rec-to-switch-registered-latency', 'parameter', param);
  });

  it('fetchItem(versioned) with context(whatsapp-journey:on) matches manual Amplitude segment baseline', async () => {
    if (!creds) throw new Error('Missing Amplitude creds');

    const graph = loadJsonFixture('param-registry/test/graphs/household-energy-rec-switch-registered-flow.json') as Graph;
    let currentGraph: Graph | null = structuredClone(graph);
    const setGraph = (g: Graph | null) => { currentGraph = g; };

    const edgeId = 'X-Y';
    const paramId = 'energy-rec-to-switch-registered-latency';
    const item: FetchItem = createFetchItem('parameter', paramId, edgeId);

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

    const baseline = await amplitudeBaselineCurlWithSegments({
      creds,
      cohortStartYyyymmdd: cohortStart,
      cohortEndYyyymmdd: cohortEnd,
      conversionWindowDays: 30,
      excludedCohorts,
      segments: [
        {
          // Confirmed in real API: this gate is addressable only as a custom user property.
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
  }, 60_000);
});







