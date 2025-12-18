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
import yaml from 'js-yaml';
import { fetch as undiciFetch } from 'undici';

import type { Graph } from '../../types';
import { credentialsManager } from '../../lib/credentials';
import { fetchItem, createFetchItem, type FetchItem } from '../fetchDataService';
import { extractParamsFromGraph } from '../GraphParamExtractor';
import { flattenParams } from '../ParamPackDSLService';
import { fileRegistry } from '../../contexts/TabContext';
import { db } from '../../db/appDatabase';
import { deriveBaseDSLForRebase, prepareScenariosForBatch, type ScenarioForBatch } from '../scenarioRegenerationService';
import { GraphComputeClient, type AnalysisResponse } from '../../lib/graphComputeClient';

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
  const steps: any[] = [
    { event_type: 'Household Created' },
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
    { event_type: 'Blueprint SwitchSuccess' },
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

const creds = getAmplitudeCredsFromEnvFile();
const isCi = !!process.env.CI;
const describeLocal = (!isCi && creds) ? describe : describe.skip;

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
const describeLocalPython = (!isCi && creds && PYTHON_AVAILABLE) ? describe : describe.skip;

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

    const evA = loadYamlFixture('param-registry/test/events/household-created.yaml');
    const evX = loadYamlFixture('param-registry/test/events/switch-registered.yaml');
    const evY = loadYamlFixture('param-registry/test/events/switch-success.yaml');
    await registerFileForTest('event-household-created', 'event', evA);
    await registerFileForTest('event-switch-registered', 'event', evX);
    await registerFileForTest('event-switch-success', 'event', evY);

    const paramAx = loadYamlFixture('param-registry/test/parameters/household-created-to-switch-registered-latency.yaml');
    await registerFileForTest('parameter-household-created-to-switch-registered-latency', 'parameter', paramAx);

    const param = loadYamlFixture('param-registry/test/parameters/switch-registered-to-switch-success-latency.yaml');
    await registerFileForTest('parameter-switch-registered-to-switch-success-latency', 'parameter', param);
  });

  it(
    'Σ over channel slices (paid-search, influencer, paid-social, other) matches uncontexted Amplitude baseline for the same cohort window',
    async () => {
      if (!creds) throw new Error('Missing Amplitude creds');

      const graph = loadJsonFixture('param-registry/test/graphs/household-switch-flow.json') as Graph;
      let currentGraph: Graph | null = structuredClone(graph);
      const setGraph = (g: Graph | null) => {
        currentGraph = g;
      };

      const edgeId = 'X-Y';
      const paramId = 'switch-registered-to-switch-success-latency';
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
});

describeLocalPython('LOCAL e2e: after retrieving all slices, live scenarios → Reach Probability(to(Y)) Σ(n/k) == uncontexted Amplitude baseline', () => {
  beforeAll(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  beforeEach(async () => {
    credentialsManager.clearCache();
    await hardResetState();

    // Register fixtures into the workspace registry (ContextRegistry loads from FileRegistry in vitest)
    const channelContext = loadYamlFixture('param-registry/test/contexts/channel-mece-local.yaml');
    await registerFileForTest('context-channel', 'context', channelContext);

    const evA = loadYamlFixture('param-registry/test/events/household-created.yaml');
    const evX = loadYamlFixture('param-registry/test/events/switch-registered.yaml');
    const evY = loadYamlFixture('param-registry/test/events/switch-success.yaml');
    await registerFileForTest('event-household-created', 'event', evA);
    await registerFileForTest('event-switch-registered', 'event', evX);
    await registerFileForTest('event-switch-success', 'event', evY);

    const paramAx = loadYamlFixture('param-registry/test/parameters/household-created-to-switch-registered-latency.yaml');
    await registerFileForTest('parameter-household-created-to-switch-registered-latency', 'parameter', paramAx);

    const param = loadYamlFixture('param-registry/test/parameters/switch-registered-to-switch-success-latency.yaml');
    await registerFileForTest('parameter-switch-registered-to-switch-success-latency', 'parameter', param);
  });

  it(
    'creates one scenario per channel value, runs Reach Probability on Y, and Σ scenario n/k equals Amplitude baseline n/k',
    async () => {
      if (!creds) throw new Error('Missing Amplitude creds');
      if (!PYTHON_AVAILABLE) throw new Error('Python GraphCompute is not reachable (expected for this local-only test)');

      // ---------------------------------------------------------------------
      // Step 1: "Retrieve all slices" (real Amplitude HTTP through prod pipeline)
      // ---------------------------------------------------------------------
      const graph0 = loadJsonFixture('param-registry/test/graphs/household-switch-flow.json') as Graph;
      let currentGraph: Graph | null = structuredClone(graph0);
      const setGraph = (g: Graph | null) => { currentGraph = g; };

      const items: FetchItem[] = [
        createFetchItem('parameter', 'household-created-to-switch-registered-latency', 'A-X'),
        createFetchItem('parameter', 'switch-registered-to-switch-success-latency', 'X-Y'),
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
        const baseGraph = loadJsonFixture('param-registry/test/graphs/household-switch-flow.json') as Graph;
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


