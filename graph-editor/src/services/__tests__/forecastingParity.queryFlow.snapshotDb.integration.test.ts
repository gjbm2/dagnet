/**
 * Forecasting parity integration (REALISTIC dataset, no Playwright).
 *
 * Goal:
 * - Run the real frontend from-file fetch + topo (Stage 2) pipeline to compute FE mu/sigma.
 * - Seed snapshot DB with matching evidence rows for the SAME cohort slice (same query_signature/core_hash).
 * - Run the real backend recompute endpoint and assert:
 *    1) The parity request uses the cohort() slice (NOT window()).
 *    2) BE mu/sigma/t95 match FE within tolerance.
 *
 * This catches “wrong slice family / wrong core_hash” wiring regressions that can only be seen
 * when running realistic multi-slice parameter files through the real pipeline.
 *
 * Requires:
 * - Python dev server running on http://localhost:9000
 * - Snapshot DB configured and reachable (see /api/snapshots/health)
 *
 * This is a LOCAL integration test (depends on external services + private data repo).
 * It is skipped automatically when those dependencies are not available (e.g. CI).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { fetch as undiciFetch } from 'undici';

import type { Graph } from '../../types';
import { fetchItem, type FetchItem } from '../fetchDataService';
import { fileRegistry } from '../../contexts/TabContext';
import { computeShortCoreHash } from '../coreHashService';
import { runParityComparison } from '../lagRecomputeService';
import { sessionLogService } from '../sessionLogService';

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'graph-editor'))) return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(process.cwd(), '..');
}

const REPO_ROOT = findRepoRoot();

/** Read DATA_REPO_DIR from .private-repos.conf (never hardcode private repo names). */
function getDataRepoDir(): string {
  const confPath = path.join(REPO_ROOT, '.private-repos.conf');
  if (!fs.existsSync(confPath)) {
    throw new Error(`.private-repos.conf not found at ${confPath} — see README.md for setup`);
  }
  const text = fs.readFileSync(confPath, 'utf8');
  const match = text.match(/^DATA_REPO_DIR=(.+)$/m);
  if (!match?.[1]?.trim()) {
    throw new Error('DATA_REPO_DIR not set in .private-repos.conf');
  }
  const dir = match[1].trim();
  if (!fs.existsSync(path.join(REPO_ROOT, dir))) {
    throw new Error(`Data repo directory "${dir}" not found — clone it per README.md`);
  }
  return dir;
}

function safeGetDataRepoDir(): string | null {
  try {
    return getDataRepoDir();
  } catch {
    return null;
  }
}

const PYTHON_BASE_URL =
  process.env.DAGNET_PYTHON_API_URL ||
  process.env.VITE_PYTHON_API_URL ||
  'http://localhost:9000';

async function isPythonSnapshotReachable(): Promise<boolean> {
  const url = `${PYTHON_BASE_URL}/api/snapshots/health`;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1000);
    try {
      const resp = await undiciFetch(url, { signal: controller.signal });
      return resp.ok;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    return false;
  }
}

const DATA_REPO_DIR = safeGetDataRepoDir();
const PYTHON_SNAPSHOT_AVAILABLE = await isPythonSnapshotReachable();
const describeDeps = (PYTHON_SNAPSHOT_AVAILABLE && !!DATA_REPO_DIR) ? describe : describe.skip;

function loadYaml(relPath: string): any {
  return yaml.load(fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8'));
}

function ukToISO(uk: string): string {
  const m = String(uk).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
  if (!m) throw new Error(`Expected UK date d-MMM-yy, got: ${uk}`);
  const day = Number(m[1]);
  const monStr = m[2].toLowerCase();
  const yy = Number(m[3]);
  const months: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  const mm = months[monStr];
  if (!mm) throw new Error(`Bad month in UK date: ${uk}`);
  const yyyy = 2000 + yy;
  return `${yyyy}-${String(mm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

async function deleteTestSnapshots(prefix: string): Promise<void> {
  await undiciFetch(`${PYTHON_BASE_URL}/api/snapshots/delete-test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ param_id_prefix: prefix }),
  });
}

async function appendSnapshots(args: {
  param_id: string;
  canonical_signature: string;
  core_hash: string;
  slice_key: string;
  retrieved_at: string;
  rows: Array<Record<string, any>>;
}): Promise<void> {
  const resp = await undiciFetch(`${PYTHON_BASE_URL}/api/snapshots/append`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      param_id: args.param_id,
      canonical_signature: args.canonical_signature,
      core_hash: args.core_hash,
      inputs_json: { schema: 'pytest_parity_v1', note: 'from-file integration test' },
      sig_algo: 'sig_v1_sha256_trunc128_b64url',
      slice_key: args.slice_key,
      retrieved_at: args.retrieved_at,
      rows: args.rows,
      diagnostic: false,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`snapshots/append HTTP ${resp.status}: ${text}`);
  }
  const body = await resp.json() as any;
  if (!body.success) throw new Error(`snapshots/append failed: ${JSON.stringify(body)}`);
}

describeDeps('Forecasting parity — query flow + snapshot DB (integration)', () => {
  const SNAPSHOT_TEST_REPO = `pytest-parity-${Date.now()}`;
  const SNAPSHOT_TEST_BRANCH = `run-${Math.random().toString(16).slice(2)}`;
  const SNAPSHOT_PREFIX = `${SNAPSHOT_TEST_REPO}-${SNAPSHOT_TEST_BRANCH}-`;

  if (!DATA_REPO_DIR) {
    throw new Error('.private-repos.conf / DATA_REPO_DIR not available (required for this local integration test)');
  }

  // Realistic source parameter file containing both window() and cohort() slices with query_signature.
  // Loaded directly from the local data repo (directory name from .private-repos.conf).
  const PARAM_REL = `${DATA_REPO_DIR}/parameters/registration-to-success.yaml`;
  const PARAM_ID = 'registration-to-success';
  const CHANNEL_CONTEXT_REL = `${DATA_REPO_DIR}/contexts/channel.yaml`;

  // We use a single, concrete cohort DSL from the file itself.
  // This ensures the FE from-file pipeline selects a realistic slice and computes mu/sigma.
  const TARGET_CONTEXT = 'context(channel:paid-search)';

  let reducedParam: any;
  let cohortValue: any;
  let windowValue: any;
  let cohortMECEValues: any[] = [];

  beforeAll(async () => {
    // Ensure Python snapshot API is running and DB is reachable.
    const health = await undiciFetch(`${PYTHON_BASE_URL}/api/snapshots/health`);
    if (!health.ok) {
      throw new Error(`Python snapshot API not reachable: HTTP ${health.status}`);
    }
    const healthBody = await health.json() as any;
    if (healthBody?.status !== 'ok') {
      throw new Error(`Snapshot DB not healthy: ${JSON.stringify(healthBody)}`);
    }

    const fullParam = loadYaml(PARAM_REL);
    const values: any[] = fullParam?.values || [];

    cohortValue = values.find(v =>
      typeof v?.sliceDSL === 'string' &&
      v.sliceDSL.startsWith('cohort(') &&
      v.sliceDSL.includes(TARGET_CONTEXT)
    );
    windowValue = values.find(v =>
      typeof v?.sliceDSL === 'string' &&
      v.sliceDSL.startsWith('window(') &&
      v.sliceDSL.includes(TARGET_CONTEXT)
    );
    if (!cohortValue || !windowValue) {
      throw new Error(`Expected both cohort+window values for ${TARGET_CONTEXT} in ${PARAM_REL}`);
    }
    if (typeof cohortValue.query_signature !== 'string' || typeof windowValue.query_signature !== 'string') {
      throw new Error('Expected query_signature on both cohort and window values');
    }

    // CRITICAL: Salt the query_signature so the test's core_hash never collides
    // with production snapshot data. The BE reads by core_hash (not param_id), so
    // real production rows for the unsalted hash leak into the BE model fit and
    // cause parity drift as production data accumulates. The salt preserves the
    // full hash-matching pipeline test -- only the hash value changes, not the logic.
    const testSalt = `|__test_salt__:${SNAPSHOT_TEST_REPO}`;
    const unsaltedCohortSig = cohortValue.query_signature;
    cohortValue = { ...cohortValue, query_signature: cohortValue.query_signature + testSalt };
    windowValue = { ...windowValue, query_signature: windowValue.query_signature + testSalt };

    // Reduce to exactly two slices (one cohort, one window) to make “wrong slice” wiring unambiguous.
    reducedParam = {
      ...fullParam,
      id: PARAM_ID,
      values: [cohortValue, windowValue],
    };

    // For MECE-union parity: the parameter file contains ONLY contexted cohort() slices
    // for the (single) MECE key `channel`. For an uncontexted cohort(...) query, FE must
    // treat the MECE partition as the implicit "total" and BE must receive ALL slice_keys.
    // Filter by unsalted signature (matches on-disk file), then salt each match.
    cohortMECEValues = values.filter(v =>
      typeof v?.sliceDSL === 'string' &&
      v.sliceDSL.startsWith('cohort(') &&
      v.sliceDSL.includes('context(channel:') &&
      typeof v.query_signature === 'string' &&
      v.query_signature === unsaltedCohortSig
    ).map(v => ({ ...v, query_signature: v.query_signature + testSalt }));
    if (cohortMECEValues.length < 2) {
      throw new Error(`Expected >=2 cohort()+context(channel:*) slices with same query_signature in ${PARAM_REL}`);
    }
    // This specific debug bundle is expected to include the full MECE set for channel.
    const sliceSet = new Set(cohortMECEValues.map(v => String(v.sliceDSL)));
    const expected = [
      'context(channel:paid-search)',
      'context(channel:influencer)',
      'context(channel:paid-social)',
      'context(channel:other)',
    ];
    for (const frag of expected) {
      const has = Array.from(sliceSet).some(s => s.includes(frag));
      if (!has) throw new Error(`Expected cohort MECE slice set to include ${frag}`);
    }
  });

  beforeEach(async () => {
    // Snapshot DB is shared across local runs. The BE reads by core_hash (not param_id),
    // so stale rows from previous local runs can leak into evidence selection unless we
    // clear the whole pytest-parity namespace.
    await deleteTestSnapshots('pytest-parity-');

    // Register the channel context so implicit-uncontexted MECE resolution is allowed.
    // (MECE logic is conservatively disabled when the context definition is unavailable.)
    const channelContext = loadYaml(CHANNEL_CONTEXT_REL);
    await fileRegistry.registerFile('context-channel', {
      fileId: 'context-channel',
      type: 'context',
      data: channelContext,
      originalData: structuredClone(channelContext),
      isDirty: false,
      isInitializing: false,
      source: { repository: SNAPSHOT_TEST_REPO, branch: SNAPSHOT_TEST_BRANCH, isLocal: true } as any,
      viewTabs: [],
      lastModified: Date.now(),
    } as any);

    // Reset FileRegistry state for this param file id.
    // (Registering again is fine; the registry overwrites.)
    await fileRegistry.registerFile(`parameter-${PARAM_ID}`, {
      fileId: `parameter-${PARAM_ID}`,
      type: 'parameter',
      data: reducedParam,
      originalData: structuredClone(reducedParam),
      isDirty: false,
      isInitializing: false,
      source: { repository: SNAPSHOT_TEST_REPO, branch: SNAPSHOT_TEST_BRANCH, isLocal: true } as any,
      viewTabs: [],
      lastModified: Date.now(),
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('structural parity: throws + logs FORECASTING_PARITY_MISMATCH when BE is seeded wrong', async () => {
    const parityErrors: any[] = [];
    const errorSpy = vi.spyOn(sessionLogService, 'error').mockImplementation((...args: any[]) => {
      // args: (category, operation, message, details?, context?)
      const operation = args?.[1];
      if (operation === 'FORECASTING_PARITY_MISMATCH') parityErrors.push(args);
      // still call through to avoid changing behaviour in test environment
      return undefined as any;
    });

    // Freeze time so the FE/BE “as_at” reference is deterministic.
    vi.setSystemTime(new Date('2026-02-10T12:00:00.000Z'));

    // Seed snapshot DB with WINDOW evidence rows ONLY (wrong on purpose).
    // FE fits from cohort(); BE will query cohort slice keys and should fall back / diverge,
    // which must trigger the structural parity hard-fail.
    const cohortSig = cohortValue.query_signature as string;
    const cohortCoreHash = await computeShortCoreHash(cohortSig);
    // Ensure retrieved_at <= as_at (query_snapshots filters by retrieved_at <= as_at).
    const retrievedAt = new Date('2026-02-10T00:00:00.000Z').toISOString();

    const dates: string[] = windowValue.dates || [];
    const nDaily: number[] = windowValue.n_daily || [];
    const kDaily: number[] = windowValue.k_daily || [];
    const med: number[] = windowValue.median_lag_days || [];
    const mn: number[] = windowValue.mean_lag_days || [];
    if (!(dates.length && dates.length === nDaily.length && dates.length === kDaily.length)) {
      throw new Error('Cohort slice arrays missing or mismatched lengths');
    }

    const rows = dates.map((d, i) => ({
      anchor_day: ukToISO(d),
      X: nDaily[i] ?? 0,
      Y: kDaily[i] ?? 0,
      median_lag_days: med[i] ?? null,
      mean_lag_days: mn[i] ?? null,
      onset_delta_days: null,
    }));

    await appendSnapshots({
      param_id: `${SNAPSHOT_TEST_REPO}-${SNAPSHOT_TEST_BRANCH}-${PARAM_ID}`,
      canonical_signature: cohortSig,
      core_hash: cohortCoreHash,
      slice_key: windowValue.sliceDSL,
      retrieved_at: retrievedAt,
      rows,
    });

    // Minimal graph containing one latency edge referencing the parameter.
    // This matches what the “query a graph” pipeline operates on: graph → fetch → stage2 topo.
    const edgeUuid = 'edge-parity-test-1';
    let currentGraph: Graph | null = {
      nodes: [
        { uuid: 'n1', id: 'household-created', entry: { is_start: true } } as any,
        { uuid: 'n2', id: 'switch-success' } as any,
      ],
      edges: [
        {
          uuid: edgeUuid,
          id: 'household-created-to-switch-success',
          from: 'n1',
          to: 'n2',
          p: {
            id: PARAM_ID,
            connection: reducedParam.connection || 'amplitude-prod',
            latency: {
              latency_parameter: true,
              // Provide an onset so BE must honour the graph-mastered override (parity3 failure mode).
              onset_delta_days: 3,
              onset_delta_days_overridden: true,
              // Provide an authoritative t95 to mirror the production path.
              t95: 14.0,
              anchor_node_id: 'household-created',
            },
          },
        } as any,
      ],
    } as any;
    const setGraph = (g: Graph | null) => { currentGraph = g; };

    const item: FetchItem = {
      id: `param-${PARAM_ID}-p-${edgeUuid}`,
      type: 'parameter',
      name: `p: ${PARAM_ID}`,
      objectId: PARAM_ID,
      targetId: edgeUuid,
      paramSlot: 'p',
    };

    const dsl = String(cohortValue.sliceDSL);

    const r = await fetchItem(
      item,
      { mode: 'from-file' } as any,
      currentGraph as Graph,
      setGraph,
      dsl,
    );
    expect(r.success).toBe(true);

    const g = currentGraph as any;
    const edge = (g.edges || []).find((e: any) => e.uuid === edgeUuid);
    expect(edge?.p?.latency?.latency_parameter).toBe(true);
    expect(typeof edge?.p?.latency?.mu).toBe('number');
    expect(typeof edge?.p?.latency?.sigma).toBe('number');

    const feMu = edge.p.latency.mu as number;
    const feSigma = edge.p.latency.sigma as number;
    const feOnset = edge.p.latency.onset_delta_days as number;

    // Capture the parity request (and response) by wrapping fetch.
    const originalFetch = globalThis.fetch;
    const seen: { requestBody?: any; responseBody?: any } = {};
    (globalThis as any).fetch = async (input: any, init?: any): Promise<Response> => {
      const url = typeof input === 'string' ? input : String(input?.url ?? input);
      if (url.includes('/api/lag/recompute-models')) {
        try {
          seen.requestBody = init?.body ? JSON.parse(init.body) : undefined;
        } catch { /* ignore */ }
        const resp = await originalFetch(input, init);
        const text = await resp.text();
        try {
          seen.responseBody = JSON.parse(text);
        } catch { /* ignore */ }
        return new Response(text, { status: resp.status, headers: resp.headers });
      }
      return originalFetch(input, init);
    };

    await expect(runParityComparison({
      graph: currentGraph as any,
      workspace: { repository: SNAPSHOT_TEST_REPO, branch: SNAPSHOT_TEST_BRANCH },
    })).rejects.toThrow(/FORECASTING_PARITY/);

    expect(parityErrors.length).toBeGreaterThan(0);

    expect(seen.requestBody).toBeTruthy();
    const subj = seen.requestBody.subjects?.[0];
    expect(subj).toBeTruthy();

    // Critical: subject should target cohort slice + cohort core hash.
    expect(subj.param_id).toBe(`${SNAPSHOT_TEST_REPO}-${SNAPSHOT_TEST_BRANCH}-${PARAM_ID}`);
    expect(subj.core_hash).toBe(cohortCoreHash);
    expect(subj.slice_keys?.[0]).toBe(cohortValue.sliceDSL);

    // We intentionally don't assert BE numbers here — we assert the structural guard tripped.

    errorSpy.mockRestore();
  });

  it('structural parity: does not throw and emits no FORECASTING_PARITY_MISMATCH (single slice, correct seed)', async () => {
    const parityErrors: any[] = [];
    const errorSpy = vi.spyOn(sessionLogService, 'error').mockImplementation((...args: any[]) => {
      const operation = args?.[1];
      if (operation === 'FORECASTING_PARITY_MISMATCH') parityErrors.push(args);
      return undefined as any;
    });

    vi.setSystemTime(new Date('2026-02-10T12:00:00.000Z'));

    // Seed snapshot DB with cohort evidence rows ONLY (correct).
    const cohortSig = cohortValue.query_signature as string;
    const cohortCoreHash = await computeShortCoreHash(cohortSig);
    const retrievedAt = new Date('2026-02-10T00:00:00.000Z').toISOString();

    const dates: string[] = cohortValue.dates || [];
    const nDaily: number[] = cohortValue.n_daily || [];
    const kDaily: number[] = cohortValue.k_daily || [];
    const med: number[] = cohortValue.median_lag_days || [];
    const mn: number[] = cohortValue.mean_lag_days || [];
    if (!(dates.length && dates.length === nDaily.length && dates.length === kDaily.length)) {
      throw new Error('Cohort slice arrays missing or mismatched lengths');
    }

    const rows = dates.map((d, i) => ({
      anchor_day: ukToISO(d),
      X: nDaily[i] ?? 0,
      Y: kDaily[i] ?? 0,
      median_lag_days: med[i] ?? null,
      mean_lag_days: mn[i] ?? null,
      onset_delta_days: null,
    }));

    await appendSnapshots({
      param_id: `${SNAPSHOT_TEST_REPO}-${SNAPSHOT_TEST_BRANCH}-${PARAM_ID}`,
      canonical_signature: cohortSig,
      core_hash: cohortCoreHash,
      slice_key: cohortValue.sliceDSL,
      retrieved_at: retrievedAt,
      rows,
    });

    const edgeUuid = 'edge-parity-test-1';
    let currentGraph: Graph | null = {
      nodes: [
        { uuid: 'n1', id: 'household-created', entry: { is_start: true } } as any,
        { uuid: 'n2', id: 'switch-success' } as any,
      ],
      edges: [
        {
          uuid: edgeUuid,
          id: 'household-created-to-switch-success',
          from: 'n1',
          to: 'n2',
          p: {
            id: PARAM_ID,
            connection: reducedParam.connection || 'amplitude-prod',
            latency: {
              latency_parameter: true,
              onset_delta_days: 3,
              t95: 14.0,
              anchor_node_id: 'household-created',
            },
          },
        } as any,
      ],
    } as any;
    const setGraph = (g: Graph | null) => { currentGraph = g; };

    const item: FetchItem = {
      id: `param-${PARAM_ID}-p-${edgeUuid}`,
      type: 'parameter',
      name: `p: ${PARAM_ID}`,
      objectId: PARAM_ID,
      targetId: edgeUuid,
      paramSlot: 'p',
    };

    const dsl = String(cohortValue.sliceDSL);
    const r = await fetchItem(
      item,
      { mode: 'from-file' } as any,
      currentGraph as Graph,
      setGraph,
      dsl,
    );
    expect(r.success).toBe(true);

    // Capture BE recompute request/response (instrumentation only; still hits the real server).
    const originalFetch = globalThis.fetch;
    const seen: { requestBody?: any; responseBody?: any } = {};
    (globalThis as any).fetch = async (input: any, init?: any): Promise<Response> => {
      const url = typeof input === 'string' ? input : String(input?.url ?? input);
      if (url.includes('/api/lag/recompute-models')) {
        try { seen.requestBody = init?.body ? JSON.parse(init.body) : undefined; } catch { /* ignore */ }
        const resp = await originalFetch(input, init);
        const text = await resp.text();
        try { seen.responseBody = JSON.parse(text); } catch { /* ignore */ }
        return new Response(text, { status: resp.status, headers: resp.headers });
      }
      return originalFetch(input, init);
    };

    try {
      await runParityComparison({
        graph: currentGraph as any,
        workspace: { repository: SNAPSHOT_TEST_REPO, branch: SNAPSHOT_TEST_BRANCH },
      });
    } catch (e: any) {
      const firstCtx = parityErrors?.[0]?.[4];
      throw new Error(
        `Parity threw unexpectedly: ${String(e)}\n` +
        `first FORECASTING_PARITY_MISMATCH context: ${JSON.stringify(firstCtx)}\n` +
        `request as_at: ${String(seen.requestBody?.as_at)}`
      );
    }

    expect(seen.requestBody?.as_at).toBe('2026-02-10T12:00:00.000Z');
    expect(parityErrors).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it('read contract: cross-branch snapshot reads do not depend on param_id', async () => {
    // This is the regression we keep reintroducing:
    // - snapshots are physically keyed by (param_id, core_hash, slice_key, anchor_day, retrieved_at)
    // - but the logical read key must NOT depend on param_id (repo/branch) once core_hash is known.
    //
    // We seed DB rows under one workspace prefix, then query via a different workspace prefix
    // (simulating graph development on a branch).
    const parityErrors: any[] = [];
    const errorSpy = vi.spyOn(sessionLogService, 'error').mockImplementation((...args: any[]) => {
      const operation = args?.[1];
      if (operation === 'FORECASTING_PARITY_MISMATCH') parityErrors.push(args);
      return undefined as any;
    });

    vi.setSystemTime(new Date('2026-02-10T12:00:00.000Z'));

    const cohortSig = cohortValue.query_signature as string;
    const cohortCoreHash = await computeShortCoreHash(cohortSig);
    const retrievedAt = new Date('2026-02-10T00:00:00.000Z').toISOString();

    const dates: string[] = cohortValue.dates || [];
    const nDaily: number[] = cohortValue.n_daily || [];
    const kDaily: number[] = cohortValue.k_daily || [];
    const med: number[] = cohortValue.median_lag_days || [];
    const mn: number[] = cohortValue.mean_lag_days || [];
    if (!(dates.length && dates.length === nDaily.length && dates.length === kDaily.length)) {
      throw new Error('Cohort slice arrays missing or mismatched lengths');
    }

    const rows = dates.map((d, i) => ({
      anchor_day: ukToISO(d),
      X: nDaily[i] ?? 0,
      Y: kDaily[i] ?? 0,
      median_lag_days: med[i] ?? null,
      mean_lag_days: mn[i] ?? null,
      onset_delta_days: null,
    }));

    const SEED_REPO = `pytest-parity-seed-${Date.now()}`;
    const SEED_BRANCH = 'main';
    const QUERY_BRANCH = 'feature-x';
    // Seed under "main".
    await appendSnapshots({
      param_id: `${SEED_REPO}-${SEED_BRANCH}-${PARAM_ID}`,
      canonical_signature: cohortSig,
      core_hash: cohortCoreHash,
      slice_key: cohortValue.sliceDSL,
      retrieved_at: retrievedAt,
      rows,
    });

    // Query under "feature-x" (different param_id prefix), should still find rows by core_hash.
    const edgeUuid = 'edge-parity-test-cross-branch-1';
    let currentGraph: Graph | null = {
      nodes: [
        { uuid: 'n1', id: 'household-created', entry: { is_start: true } } as any,
        { uuid: 'n2', id: 'switch-success' } as any,
      ],
      edges: [
        {
          uuid: edgeUuid,
          id: 'household-created-to-switch-success',
          from: 'n1',
          to: 'n2',
          p: {
            id: PARAM_ID,
            connection: reducedParam.connection || 'amplitude-prod',
            latency: {
              latency_parameter: true,
              // Authoritative t95 to mirror prod; onset comes from topo pass or 0.
              t95: 14.0,
              anchor_node_id: 'household-created',
            },
          },
        } as any,
      ],
    } as any;
    const setGraph = (g: Graph | null) => { currentGraph = g; };

    const item: FetchItem = {
      id: `param-${PARAM_ID}-p-${edgeUuid}`,
      type: 'parameter',
      name: `p: ${PARAM_ID}`,
      objectId: PARAM_ID,
      targetId: edgeUuid,
      paramSlot: 'p',
    };

    const dsl = String(cohortValue.sliceDSL);
    const r = await fetchItem(
      item,
      { mode: 'from-file' } as any,
      currentGraph as Graph,
      setGraph,
      dsl,
    );
    expect(r.success).toBe(true);

    await runParityComparison({
      graph: currentGraph as any,
      workspace: { repository: SEED_REPO, branch: QUERY_BRANCH }, // NOTE: query branch differs from seed branch
    });

    expect(parityErrors).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it('structural parity: emits no FORECASTING_PARITY_MISMATCH (MECE union → multiple slice_keys)', async () => {
    const parityErrors: any[] = [];
    const errorSpy = vi.spyOn(sessionLogService, 'error').mockImplementation((...args: any[]) => {
      const operation = args?.[1];
      if (operation === 'FORECASTING_PARITY_MISMATCH') parityErrors.push(args);
      return undefined as any;
    });

    vi.setSystemTime(new Date('2026-02-10T12:00:00.000Z'));

    const cohortSig = cohortValue.query_signature as string;
    const cohortCoreHash = await computeShortCoreHash(cohortSig);

    // Seed snapshot DB for BOTH cohort slices, same core_hash family, different slice_key.
    const seedOne = async (v: any) => {
      const retrievedAt = new Date('2026-02-10T00:00:00.000Z').toISOString();

      const dates: string[] = v.dates || [];
      const nDaily: number[] = v.n_daily || [];
      const kDaily: number[] = v.k_daily || [];
      const med: number[] = v.median_lag_days || [];
      const mn: number[] = v.mean_lag_days || [];
      if (!(dates.length && dates.length === nDaily.length && dates.length === kDaily.length)) {
        throw new Error('Cohort slice arrays missing or mismatched lengths');
      }
      const rows = dates.map((d, i) => ({
        anchor_day: ukToISO(d),
        X: nDaily[i] ?? 0,
        Y: kDaily[i] ?? 0,
        median_lag_days: med[i] ?? null,
        mean_lag_days: mn[i] ?? null,
        onset_delta_days: null,
      }));

      await appendSnapshots({
        param_id: `${SNAPSHOT_TEST_REPO}-${SNAPSHOT_TEST_BRANCH}-${PARAM_ID}`,
        canonical_signature: cohortSig,
        core_hash: cohortCoreHash,
        slice_key: v.sliceDSL,
        retrieved_at: retrievedAt,
        rows,
      });
    };

    for (const v of cohortMECEValues) {
      await seedOne(v);
    }

    // Register param file with ONLY the two cohort slices (no window slice),
    // matching the real “MECE only” shape.
    const meceOnlyParam = {
      ...reducedParam,
      values: cohortMECEValues,
    };
    await fileRegistry.registerFile(`parameter-${PARAM_ID}`, {
      fileId: `parameter-${PARAM_ID}`,
      type: 'parameter',
      data: meceOnlyParam,
      originalData: structuredClone(meceOnlyParam),
      isDirty: false,
      isInitializing: false,
      source: { repository: SNAPSHOT_TEST_REPO, branch: SNAPSHOT_TEST_BRANCH, isLocal: true } as any,
      viewTabs: [],
      lastModified: Date.now(),
    } as any);

    const edgeUuid = 'edge-parity-test-mece-1';
    let currentGraph: Graph | null = {
      nodes: [
        { uuid: 'n1', id: 'household-created', entry: { is_start: true } } as any,
        { uuid: 'n2', id: 'switch-success' } as any,
      ],
      edges: [
        {
          uuid: edgeUuid,
          id: 'household-created-to-switch-success',
          from: 'n1',
          to: 'n2',
          p: {
            id: PARAM_ID,
            connection: meceOnlyParam.connection || 'amplitude-prod',
            latency: {
              latency_parameter: true,
              onset_delta_days: 2,
              t95: 14.0,
              anchor_node_id: 'household-created',
            },
          },
        } as any,
      ],
    } as any;
    const setGraph = (g: Graph | null) => { currentGraph = g; };

    const item: FetchItem = {
      id: `param-${PARAM_ID}-p-${edgeUuid}`,
      type: 'parameter',
      name: `p: ${PARAM_ID}`,
      objectId: PARAM_ID,
      targetId: edgeUuid,
      paramSlot: 'p',
    };

    // Use an uncontexted cohort DSL to force “MECE union” semantics in the FE path.
    const uncontextedCohortDsl = String(cohortValue.sliceDSL).split('.context(')[0];

    const r = await fetchItem(
      item,
      { mode: 'from-file' } as any,
      currentGraph as Graph,
      setGraph,
      uncontextedCohortDsl,
    );
    expect(r.success).toBe(true);

    // Capture BE recompute request.
    const originalFetch = globalThis.fetch;
    const seen: { requestBody?: any; responseBody?: any } = {};
    (globalThis as any).fetch = async (input: any, init?: any): Promise<Response> => {
      const url = typeof input === 'string' ? input : String(input?.url ?? input);
      if (url.includes('/api/lag/recompute-models')) {
        try { seen.requestBody = init?.body ? JSON.parse(init.body) : undefined; } catch { /* ignore */ }
        const resp = await originalFetch(input, init);
        const text = await resp.text();
        try { seen.responseBody = JSON.parse(text); } catch { /* ignore */ }
        return new Response(text, { status: resp.status, headers: resp.headers });
      }
      return originalFetch(input, init);
    };

    try {
      await runParityComparison({
        graph: currentGraph as any,
        workspace: { repository: SNAPSHOT_TEST_REPO, branch: SNAPSHOT_TEST_BRANCH },
      });
    } catch (e: any) {
      // Improve failure diagnostics: surface the parity mismatch context + BE payload.
      // This does not soften the test; it just makes failures actionable.
      const first = parityErrors?.[0];
      const ctx = first?.[4];
      const extra =
        `\n\n[MECE DEBUG] parityErrors[0].context=${ctx ? JSON.stringify(ctx, null, 2) : 'null'}` +
        `\n\n[MECE DEBUG] beResponse.subjects[0]=${seen.responseBody?.subjects?.[0] ? JSON.stringify(seen.responseBody.subjects[0], null, 2) : 'null'}` +
        `\n\n[MECE DEBUG] feEdgeLatency=${JSON.stringify((currentGraph as any)?.edges?.[0]?.p?.latency ?? null, null, 2)}` +
        `\n\n[MECE DEBUG] requestBody.subjects[0]=${seen.requestBody?.subjects?.[0] ? JSON.stringify(seen.requestBody.subjects[0], null, 2) : 'null'}`;
      throw new Error(String(e?.message || e) + extra);
    }

    expect(seen.requestBody).toBeTruthy();
    const subj = seen.requestBody.subjects?.[0];
    expect(subj).toBeTruthy();
    expect(subj.core_hash).toBe(cohortCoreHash);
    expect(Array.isArray(subj.slice_keys)).toBe(true);
    expect(subj.slice_keys.length).toBeGreaterThanOrEqual(2);

    // The thing you see in prod.
    expect(parityErrors).toHaveLength(0);

    // Tight drift assertion (controlled fixture): FE and BE should match essentially exactly.
    // This is intentionally stricter than the runtime parity thresholds, so if we ever see
    // a tiny mismatch here we treat it as a real drift signal to investigate.
    const feLat = (currentGraph as any)?.edges?.[0]?.p?.latency;
    const beSubj = seen.responseBody?.subjects?.[0];
    expect(feLat).toBeTruthy();
    expect(beSubj).toBeTruthy();
    expect(typeof feLat.mu).toBe('number');
    expect(typeof feLat.sigma).toBe('number');
    expect(typeof beSubj.mu).toBe('number');
    expect(typeof beSubj.sigma).toBe('number');

    const EPS = 0.000001;
    expect(Math.abs(feLat.mu - beSubj.mu)).toBeLessThan(EPS);
    expect(Math.abs(feLat.sigma - beSubj.sigma)).toBeLessThan(EPS);

    errorSpy.mockRestore();
  });
});

