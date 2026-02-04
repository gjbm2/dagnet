/**
 * Snapshot Write Path Test (Fixture-based)
 * 
 * Tests the file→DB write pipeline using pre-captured Amplitude fixtures.
 * No real Amplitude HTTP - only mocked responses from fixtures.
 * Requires Python snapshot API to be running for DB writes.
 *
 * Run:
 *   cd graph-editor && npm test -- --run src/services/__tests__/snapshotWritePath.fixture.test.ts
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { fetch as undiciFetch } from 'undici';

import type { Graph } from '../../types';
import { credentialsManager } from '../../lib/credentials';
import { fetchItem, createFetchItem, type FetchItem } from '../fetchDataService';
import { fileRegistry } from '../../contexts/TabContext';
import { db } from '../../db/appDatabase';
import { deriveOnsetDeltaDaysFromLagHistogram, roundTo1dp } from '../onsetDerivationService';

// -----------------------------------------------------------------------------
// Test config
// -----------------------------------------------------------------------------
const SNAPSHOT_TEST_REPO = `pytest-fixture-${Date.now()}`;
const SNAPSHOT_TEST_BRANCH = `run-${Math.random().toString(16).slice(2)}`;

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'param-registry')) && fs.existsSync(path.join(dir, 'graph-editor'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.resolve(process.cwd(), '..');
}

const REPO_ROOT = findRepoRoot();
const FIXTURES_DIR = path.join(REPO_ROOT, 'param-registry/test/amplitude');

// -----------------------------------------------------------------------------
// Fixture loading
// -----------------------------------------------------------------------------
type FixtureKey = 
  | 'window-paid-search' | 'window-influencer' | 'window-paid-social' | 'window-other'
  | 'cohort-paid-search' | 'cohort-influencer' | 'cohort-paid-social' | 'cohort-other'
  | 'window-paid-search-day2' | 'window-influencer-day2' | 'window-paid-social-day2' | 'window-other-day2'
  | 'cohort-paid-search-day2' | 'cohort-influencer-day2' | 'cohort-paid-social-day2' | 'cohort-other-day2';

const fixtures: Record<FixtureKey, any> = {} as any;

function loadFixtures(): void {
  const keys: FixtureKey[] = [
    'window-paid-search', 'window-influencer', 'window-paid-social', 'window-other',
    'cohort-paid-search', 'cohort-influencer', 'cohort-paid-social', 'cohort-other',
    'window-paid-search-day2', 'window-influencer-day2', 'window-paid-social-day2', 'window-other-day2',
    'cohort-paid-search-day2', 'cohort-influencer-day2', 'cohort-paid-social-day2', 'cohort-other-day2',
  ];
  for (const key of keys) {
    const filePath = path.join(FIXTURES_DIR, `${key}.json`);
    if (fs.existsSync(filePath)) {
      fixtures[key] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  }
}

// -----------------------------------------------------------------------------
// Amplitude HTTP mock
// -----------------------------------------------------------------------------
function matchFixture(url: string, body?: string): any | null {
  // Decode URL to match against
  const decodedUrl = decodeURIComponent(url);
  const decodedBody = body ? decodeURIComponent(body) : '';
  const searchText = decodedUrl + decodedBody;
  
  // Parse URL to determine which fixture to return
  const isWindow = !searchText.includes('Household Created'); // 2-step = window, 3-step = cohort
  const isCohort = searchText.includes('Household Created');
  
  // Determine channel from segment
  // The URL has segments like: {"prop":"gp:utm_medium","op":"is","values":["cpc"]}
  // or for "other": {"prop":"gp:utm_medium","op":"is not","values":["cpc",...]}
  // Note: There's also a userdata_cohort "is not" segment we need to ignore
  let channel: string | null = null;
  
  // Look for utm_medium segment specifically
  const utmMatch = searchText.match(/gp:utm_medium.*?"op"\s*:\s*"([^"]+)".*?"values"\s*:\s*\[([^\]]+)\]/);
  if (utmMatch) {
    const op = utmMatch[1];
    const values = utmMatch[2];
    if (op === 'is') {
      if (values.includes('cpc')) channel = 'paid-search';
      else if (values.includes('Influencers')) channel = 'influencer';
      else if (values.includes('Paid Social')) channel = 'paid-social';
    } else if (op === 'is not') {
      channel = 'other';
    }
  }
  
  // Determine day1 vs day2 from date range
  const isDay2 = searchText.includes('20251119') || searchText.includes('20251115') ||
                 searchText.includes('2025-11-19') || searchText.includes('2025-11-15') ||
                 searchText.includes('19-Nov') || searchText.includes('15-Nov');
  
  const mode = isCohort ? 'cohort' : 'window';
  const suffix = isDay2 ? '-day2' : '';
  const key = `${mode}-${channel}${suffix}` as FixtureKey;
  
  if (!channel) {
    return null;
  }
  
  return fixtures[key] || null;
}

function installAmplitudeMock(): () => void {
  const originalFetch = globalThis.fetch;
  
  (globalThis as any).fetch = async (input: any, init?: any): Promise<Response> => {
    const fetchUrl = typeof input === 'string' ? input : String(input?.url ?? input);
    
    // Intercept das-proxy calls (browser adapter uses proxy)
    if (fetchUrl.includes('/api/das-proxy')) {
      try {
        const proxyBody = JSON.parse(init?.body || '{}');
        const targetUrl = proxyBody.url || '';
        
        if (targetUrl.includes('amplitude.com/api/2/funnels')) {
          const fixture = matchFixture(targetUrl, proxyBody.body);
          if (fixture) {
            return new Response(JSON.stringify(fixture), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          console.log(`[MOCK] No fixture match for: ${targetUrl.slice(0, 150)}...`);
          return new Response(JSON.stringify({ error: 'No fixture match' }), { status: 404 });
        }
      } catch (e) {
        console.log(`[MOCK] Failed to parse proxy body:`, e);
      }
    }
    
    // Also intercept direct Amplitude calls (non-proxy mode)
    if (fetchUrl.includes('amplitude.com/api/2/funnels')) {
      const fixture = matchFixture(fetchUrl, init?.body);
      if (fixture) {
        return new Response(JSON.stringify(fixture), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'No fixture match' }), { status: 404 });
    }
    
    // Pass through all other requests
    return originalFetch(input, init);
  };
  
  return () => {
    globalThis.fetch = originalFetch;
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function loadYamlFixture(relPath: string): any {
  return yaml.load(fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8'));
}

function loadJsonFixture(relPath: string): any {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8'));
}

async function registerFile(fileId: string, type: any, data: any): Promise<void> {
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

function dbParamId(objectId: string): string {
  return `${SNAPSHOT_TEST_REPO}-${SNAPSHOT_TEST_BRANCH}-${objectId}`;
}

async function deleteTestSnapshots(prefix: string): Promise<void> {
  await undiciFetch('http://localhost:9000/api/snapshots/delete-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ param_id_prefix: prefix }),
  });
}

async function querySnapshotRows(paramId: string): Promise<any[]> {
  const resp = await undiciFetch('http://localhost:9000/api/snapshots/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ param_id: paramId }),
  });
  const body = await resp.json() as any;
  return body.rows || [];
}

async function queryVirtualSnapshot(params: {
  param_id: string;
  core_hash: string;
  anchor_from: string;
  anchor_to: string;
  as_at: string;
  slice_keys?: string[];
}): Promise<any> {
  const resp = await undiciFetch('http://localhost:9000/api/snapshots/query-virtual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`snapshots/query-virtual HTTP ${resp.status}: ${text}`);
  }
  return JSON.parse(text);
}

async function appendSnapshotsDirect(params: {
  param_id: string;
  core_hash: string;
  slice_key: string;
  retrieved_at: string;
  rows: Array<{ anchor_day: string; X: number; Y: number }>;
}): Promise<void> {
  const resp = await undiciFetch('http://localhost:9000/api/snapshots/append', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      param_id: params.param_id,
      core_hash: params.core_hash,
      context_def_hashes: null,
      slice_key: params.slice_key,
      retrieved_at: params.retrieved_at,
      rows: params.rows,
    }),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`snapshots/append HTTP ${resp.status}: ${text}`);
  }
  const body = JSON.parse(text);
  if (!body?.success) {
    throw new Error(`snapshots/append failed: ${text}`);
  }
}

async function isPythonReachable(): Promise<boolean> {
  try {
    await undiciFetch('http://localhost:9000/api/snapshots/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ param_ids: ['test'] }),
    });
    return true;
  } catch {
    return false;
  }
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
  try { (fileRegistry as any).files?.clear(); } catch {}
  try { (fileRegistry as any)._files?.clear(); } catch {}
}

function persistArtifacts(filename: string, data: any): void {
  const debugDir = path.join(REPO_ROOT, 'graph-editor/debug');
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
  const filePath = path.join(debugDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`[ARTIFACT] ${filePath}`);
}

// -----------------------------------------------------------------------------
// Onset helpers: α-mass day from histogram (rounded to 1 d.p.)
// -----------------------------------------------------------------------------
function deriveOnsetDeltaDaysFromAmplitudeFixture(fixture: any): number | undefined {
  // For a 2-step funnel, step_bins[1] corresponds to the X→Y transition histogram.
  const bins = fixture?.data?.[0]?.stepTransTimeDistribution?.step_bins?.[1]?.bins;
  if (!Array.isArray(bins)) return undefined;

  const onset = deriveOnsetDeltaDaysFromLagHistogram({ bins }, 0.01);
  return (typeof onset === 'number' && Number.isFinite(onset)) ? roundTo1dp(onset) : undefined;
}

function extractChannelFromSliceKey(sliceKey: unknown): string | null {
  if (typeof sliceKey !== 'string') return null;
  const m = sliceKey.match(/context\(channel:([^)]+)\)/);
  if (!m) return null;
  return m[1];
}

async function withFixedDate<T>(isoDateTime: string, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  const fixedMs = new RealDate(isoDateTime).getTime();
  class MockDate extends RealDate {
    constructor(...args: any[]) {
      // TS/JS constraint: derived class constructors must call super().
      // Avoid variadic spread to satisfy TS' tuple typing.
      switch (args.length) {
        case 0:
          super(fixedMs);
          break;
        case 1:
          super(args[0] as any);
          break;
        case 2:
          super(args[0] as any, args[1] as any);
          break;
        case 3:
          super(args[0] as any, args[1] as any, args[2] as any);
          break;
        case 4:
          super(args[0] as any, args[1] as any, args[2] as any, args[3] as any);
          break;
        case 5:
          super(args[0] as any, args[1] as any, args[2] as any, args[3] as any, args[4] as any);
          break;
        case 6:
          super(args[0] as any, args[1] as any, args[2] as any, args[3] as any, args[4] as any, args[5] as any);
          break;
        default:
          super(args[0] as any, args[1] as any, args[2] as any, args[3] as any, args[4] as any, args[5] as any, args[6] as any);
          break;
      }
    }
    static now() { return fixedMs; }
  }
  (globalThis as any).Date = MockDate as any;
  try {
    return await fn();
  } finally {
    (globalThis as any).Date = RealDate;
  }
}

// -----------------------------------------------------------------------------
// Test suite
// -----------------------------------------------------------------------------
const PYTHON_AVAILABLE = await isPythonReachable();
const describeSuite = PYTHON_AVAILABLE ? describe : describe.skip;

describeSuite('Snapshot Write Path (fixture-based)', () => {
  let restoreFetch: () => void;

  beforeAll(() => {
    globalThis.indexedDB = new IDBFactory();
    loadFixtures();
    
    // Set fake Amplitude creds so CredentialsManager doesn't block
    process.env.AMPLITUDE_API_KEY = 'fake-key';
    process.env.AMPLITUDE_SECRET_KEY = 'fake-secret';
    process.env.DAGNET_LOCAL_E2E_CREDENTIALS = '1';
  });

  beforeEach(async () => {
    restoreFetch = installAmplitudeMock();
    credentialsManager.clearCache();
    await hardResetState();
    await deleteTestSnapshots(SNAPSHOT_TEST_REPO);

    // Register test fixtures
    await registerFile('context-channel', 'context', loadYamlFixture('param-registry/test/contexts/channel-mece-local.yaml'));
    await registerFile('event-household-created', 'event', loadYamlFixture('param-registry/test/events/household-created.yaml'));
    await registerFile('event-energy-rec', 'event', loadYamlFixture('param-registry/test/events/energy-rec.yaml'));
    await registerFile('event-switch-registered', 'event', loadYamlFixture('param-registry/test/events/switch-registered.yaml'));
    await registerFile('parameter-household-created-to-energy-rec-latency', 'parameter', loadYamlFixture('param-registry/test/parameters/household-created-to-energy-rec-latency.yaml'));
    await registerFile('parameter-energy-rec-to-switch-registered-latency', 'parameter', loadYamlFixture('param-registry/test/parameters/energy-rec-to-switch-registered-latency.yaml'));
  });

  afterEach(() => {
    restoreFetch?.();
  });

  it('treats signature as part of the snapshot lookup key (query-virtual)', async () => {
    // This test is intentionally simple and direct:
    // - same param_id
    // - same slice_key, same days, same retrieved_at
    // - two different signatures (core_hash strings)
    // - query-virtual must return rows ONLY for the requested signature
    const pid = `${SNAPSHOT_TEST_REPO}-${SNAPSHOT_TEST_BRANCH}-sig-key-test`;
    const sigA = '{"c":"sig-A","x":{}}';
    const sigB = '{"c":"sig-B","x":{}}';
    const retrievedAt = '2026-01-15T10:00:00Z';

    await appendSnapshotsDirect({
      param_id: pid,
      core_hash: sigA,
      slice_key: '',
      retrieved_at: retrievedAt,
      rows: [
        { anchor_day: '2026-01-01', X: 1, Y: 1 },
        { anchor_day: '2026-01-02', X: 2, Y: 2 },
      ],
    });

    await appendSnapshotsDirect({
      param_id: pid,
      core_hash: sigB,
      slice_key: '',
      retrieved_at: retrievedAt,
      rows: [
        { anchor_day: '2026-01-01', X: 100, Y: 10 },
        { anchor_day: '2026-01-02', X: 200, Y: 20 },
      ],
    });

    const asAt = '2026-01-20T23:59:59Z';
    const resA = await queryVirtualSnapshot({
      param_id: pid,
      core_hash: sigA,
      as_at: asAt,
      anchor_from: '2026-01-01',
      anchor_to: '2026-01-02',
      slice_keys: [''],
    });

    expect(resA.success).toBe(true);
    expect(resA.count).toBe(2);
    expect(resA.rows.map((r: any) => ({ d: r.anchor_day, x: r.x, y: r.y }))).toEqual([
      { d: '2026-01-01', x: 1, y: 1 },
      { d: '2026-01-02', x: 2, y: 2 },
    ]);

    const resB = await queryVirtualSnapshot({
      param_id: pid,
      core_hash: sigB,
      as_at: asAt,
      anchor_from: '2026-01-01',
      anchor_to: '2026-01-02',
      slice_keys: [''],
    });

    expect(resB.success).toBe(true);
    expect(resB.count).toBe(2);
    expect(resB.rows.map((r: any) => ({ d: r.anchor_day, x: r.x, y: r.y }))).toEqual([
      { d: '2026-01-01', x: 100, y: 10 },
      { d: '2026-01-02', x: 200, y: 20 },
    ]);

    // Wrong signature => no rows for that key (but data exists for other sigs)
    const resWrong = await queryVirtualSnapshot({
      param_id: pid,
      core_hash: '{"c":"sig-NOT-THERE","x":{}}',
      as_at: asAt,
      anchor_from: '2026-01-01',
      anchor_to: '2026-01-02',
      slice_keys: [''],
    });

    expect(resWrong.success).toBe(true);
    expect(resWrong.count).toBe(0);
    expect(Array.isArray(resWrong.rows)).toBe(true);
    expect(resWrong.has_any_rows).toBe(true);
    expect(resWrong.has_matching_core_hash).toBe(false);
  });

  it('writes correct row counts for 2-day serial cron simulation', async () => {
    const graph0 = loadJsonFixture('param-registry/test/graphs/household-energy-rec-switch-registered-flow.json') as Graph;
    
    // Override t95 values for controlled incremental behavior
    const graph = structuredClone(graph0) as any;
    for (const edge of graph.edges || []) {
      if (edge?.p?.latency) {
        edge.p.latency.t95 = 3;       // window mode
        edge.p.latency.path_t95 = 7;  // cohort mode
      }
    }

    let currentGraph: Graph | null = graph;
    const setGraph = (g: Graph | null) => { currentGraph = g; };

    const item: FetchItem = createFetchItem('parameter', 'energy-rec-to-switch-registered-latency', 'X-Y');
    const pid = dbParamId('energy-rec-to-switch-registered-latency');
    const channels = ['paid-search', 'influencer', 'paid-social', 'other'] as const;

    const fetchResults: any[] = [];

    // Onset expectations are derived from the same captured Amplitude fixtures.
    // This validates we (a) identify the first non-zero conversion bin and (b) persist it into DB rows.
    const expectedOnsetDay1: Record<typeof channels[number], number | undefined> = {
      'paid-search': deriveOnsetDeltaDaysFromAmplitudeFixture(fixtures['window-paid-search']),
      'influencer': deriveOnsetDeltaDaysFromAmplitudeFixture(fixtures['window-influencer']),
      'paid-social': deriveOnsetDeltaDaysFromAmplitudeFixture(fixtures['window-paid-social']),
      'other': deriveOnsetDeltaDaysFromAmplitudeFixture(fixtures['window-other']),
    };
    const expectedOnsetDay2: Record<typeof channels[number], number | undefined> = {
      'paid-search': deriveOnsetDeltaDaysFromAmplitudeFixture(fixtures['window-paid-search-day2']),
      'influencer': deriveOnsetDeltaDaysFromAmplitudeFixture(fixtures['window-influencer-day2']),
      'paid-social': deriveOnsetDeltaDaysFromAmplitudeFixture(fixtures['window-paid-social-day2']),
      'other': deriveOnsetDeltaDaysFromAmplitudeFixture(fixtures['window-other-day2']),
    };

    // --- Day 1: as-at 20-Nov-25, fetch 1-Nov to 20-Nov ---
    console.log('\n=== DAY 1 (as-at 20-Nov-25) ===');
    await withFixedDate('2025-11-20T12:00:00.000Z', async () => {
      for (const ch of channels) {
        // Window mode
        const wDsl = `window(1-Nov-25:20-Nov-25).context(channel:${ch})`;
        console.log(`  Fetching: ${wDsl}`);
        const wResult = await fetchItem(item, { mode: 'versioned' }, currentGraph as Graph, setGraph, wDsl);
        fetchResults.push({ day: 1, dsl: wDsl, success: wResult.success });

        // Cohort mode
        const cDsl = `cohort(A,1-Nov-25:20-Nov-25).context(channel:${ch})`;
        console.log(`  Fetching: ${cDsl}`);
        const cResult = await fetchItem(item, { mode: 'versioned' }, currentGraph as Graph, setGraph, cDsl);
        fetchResults.push({ day: 1, dsl: cDsl, success: cResult.success });
      }
    });

    // Wait for DB writes
    await new Promise(r => setTimeout(r, 1500));

    const rowsAfterDay1 = await querySnapshotRows(pid);
    console.log(`\nDay 1 rows: ${rowsAfterDay1.length}`);
    
    // Day 1 expected: 20 days × 4 channels × 2 modes = 160 rows
    const expectedDay1 = 20 * 4 * 2;
    expect(rowsAfterDay1.length).toBe(expectedDay1);

    // Onset correctness for Day 1: window rows should carry onset_delta_days derived from histogram.
    // We detect window vs cohort via anchor column: cohort rows have A populated; window rows do not.
    for (const row of rowsAfterDay1 as any[]) {
      const isCohort = row?.a !== null && row?.a !== undefined;
      if (isCohort) continue;

      const ch = extractChannelFromSliceKey(row?.slice_key);
      if (!ch || !(channels as readonly string[]).includes(ch)) continue;

      const expected = expectedOnsetDay1[ch as typeof channels[number]];
      expect(row?.onset_delta_days).toBe(expected);
    }

    // File persistence (§0.3): window() values should carry onset_delta_days under values[].latency.
    // This is written during incremental per-gap persistence (the production path).
    const paramFileAfterDay1 = fileRegistry.getFile('parameter-energy-rec-to-switch-registered-latency')?.data as any;
    const windowValuesDay1 = (paramFileAfterDay1?.values || []).filter(
      (v: any) => typeof v?.sliceDSL === 'string' && v.sliceDSL.includes('window(')
    );
    expect(windowValuesDay1.length).toBeGreaterThan(0);
    for (const v of windowValuesDay1) {
      const ch = extractChannelFromSliceKey(v?.sliceDSL);
      if (!ch || !(channels as readonly string[]).includes(ch)) continue;
      const expected = expectedOnsetDay1[ch as typeof channels[number]];
      expect(v?.latency?.onset_delta_days).toBe(expected);
    }

    // --- Day 2: as-at 21-Nov-25, incremental fetch ---
    console.log('\n=== DAY 2 (as-at 21-Nov-25) ===');
    await withFixedDate('2025-11-21T12:00:00.000Z', async () => {
      for (const ch of channels) {
        // Window mode: t95=3 → fetch 19-Nov to 21-Nov (3 days)
        const wDsl = `window(19-Nov-25:21-Nov-25).context(channel:${ch})`;
        console.log(`  Fetching: ${wDsl}`);
        const wResult = await fetchItem(item, { mode: 'versioned' }, currentGraph as Graph, setGraph, wDsl);
        fetchResults.push({ day: 2, dsl: wDsl, success: wResult.success });

        // Cohort mode: path_t95=7 → fetch 15-Nov to 21-Nov (7 days)
        const cDsl = `cohort(A,15-Nov-25:21-Nov-25).context(channel:${ch})`;
        console.log(`  Fetching: ${cDsl}`);
        const cResult = await fetchItem(item, { mode: 'versioned' }, currentGraph as Graph, setGraph, cDsl);
        fetchResults.push({ day: 2, dsl: cDsl, success: cResult.success });
      }
    });

    // Wait for DB writes
    await new Promise(r => setTimeout(r, 1500));

    const rowsAfterDay2 = await querySnapshotRows(pid);
    console.log(`\nDay 2 rows: ${rowsAfterDay2.length}`);

    // Day 2 adds:
    // - Window: 3 days × 4 channels = 12 rows
    // - Cohort: 7 days × 4 channels = 28 rows
    // Unique constraint includes retrieved_at, so all rows are new (different timestamp)
    // Total: 160 + 12 + 28 = 200 rows
    const expectedDay2 = expectedDay1 + (3 * 4) + (7 * 4);
    expect(rowsAfterDay2.length).toBe(expectedDay2);

    // Check distinct retrieved_at timestamps
    const uniqueRetrievedAt = [...new Set(rowsAfterDay2.map((r: any) => r.retrieved_at))].sort();
    expect(uniqueRetrievedAt.length).toBe(2);
    expect(uniqueRetrievedAt).toContain('2025-11-20T12:00:00+00:00');
    expect(uniqueRetrievedAt).toContain('2025-11-21T12:00:00+00:00');

    // Onset correctness for Day 2 window rows as well (should match day2 fixtures).
    for (const row of rowsAfterDay2 as any[]) {
      const isCohort = row?.a !== null && row?.a !== undefined;
      if (isCohort) continue;

      const ch = extractChannelFromSliceKey(row?.slice_key);
      if (!ch || !(channels as readonly string[]).includes(ch)) continue;

      const isDay2 = row?.retrieved_at === '2025-11-21T12:00:00+00:00';
      const expected = isDay2
        ? expectedOnsetDay2[ch as typeof channels[number]]
        : expectedOnsetDay1[ch as typeof channels[number]];

      expect(row?.onset_delta_days).toBe(expected);
    }

    // Persist artifacts for manual inspection
    persistArtifacts(`snapshot-write-path-${Date.now()}.json`, {
      testRun: {
        repo: SNAPSHOT_TEST_REPO,
        branch: SNAPSHOT_TEST_BRANCH,
        dbParamId: pid,
        t95: 3,
        path_t95: 7,
      },
      expectedOnset: {
        day1: expectedOnsetDay1,
        day2: expectedOnsetDay2,
      },
      fetchResults,
      day1RowCount: rowsAfterDay1.length,
      day2RowCount: rowsAfterDay2.length,
      uniqueRetrievedAt,
      dbRows: rowsAfterDay2,
    });

    console.log(`\n[INSPECT] SELECT * FROM snapshots WHERE param_id = '${pid}' ORDER BY slice_key, anchor_day;`);
  }, 60_000);
});
