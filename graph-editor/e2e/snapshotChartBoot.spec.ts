/**
 * Snapshot chart boot — heavyweight E2E spec.
 *
 * Loads the REAL production graph from the private data repo, the EXACT
 * production canvasAnalyses + scenario state from a debug graph snapshot,
 * and ALL parameter files. Seeds a heavy IDB, then verifies every chart
 * reaches a rendered state after a single page load.
 *
 * Mocks: ONLY GitHub API (unreachable in test).
 * Real: IDB hydration, FileRegistry, fetch planner, signature generation,
 *       snapshot subject resolution, preparation pipeline, Python compute
 *       backend, snapshot DB lookups.
 *
 * Skips gracefully when the data repo or graph snapshot is not present.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

// ─── Path setup ─────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ─── Data repo discovery (dir name NEVER appears in this file) ──────────

function resolveDataRepo(): { path: string; name: string } | null {
  const confPath = path.join(REPO_ROOT, '.private-repos.conf');
  if (!fs.existsSync(confPath)) return null;
  const match = fs.readFileSync(confPath, 'utf-8').match(/^DATA_REPO_DIR=(.+)$/m);
  const dir = match?.[1]?.trim();
  if (!dir) return null;
  const full = path.join(REPO_ROOT, dir);
  return fs.existsSync(full) ? { path: full, name: dir } : null;
}

const DATA_REPO_INFO = resolveDataRepo();
const DATA_REPO = DATA_REPO_INFO?.path ?? null;
const REPO_NAME = DATA_REPO_INFO?.name ?? 'repo-1';

// ─── Graph snapshot discovery (exact production state) ──────────────────

const GRAPH_NAME = 'gm-rebuild-jan-26';
const GRAPH_FILE_ID = `graph-${GRAPH_NAME}`;
const TAB_ID = `tab-${GRAPH_FILE_ID}-interactive`;
const SNAPSHOT_DIR = path.join(REPO_ROOT, 'debug', 'graph-snapshots');

function findLatestGraphSnapshot(): string | null {
  if (!fs.existsSync(SNAPSHOT_DIR)) return null;
  const files = fs.readdirSync(SNAPSHOT_DIR)
    .filter((f) => f.includes(`graph-${GRAPH_NAME}`) && f.endsWith('.json'))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(SNAPSHOT_DIR, files[0]) : null;
}

function loadGraphSnapshot(): any | null {
  const p = findLatestGraphSnapshot();
  if (!p) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

// ─── Readiness checks ───────────────────────────────────────────────────

const GRAPH_PATH = DATA_REPO
  ? path.join(DATA_REPO, 'graphs', `${GRAPH_NAME}.json`)
  : '';
const HAS_GRAPH = Boolean(GRAPH_PATH && fs.existsSync(GRAPH_PATH));
const SNAPSHOT = loadGraphSnapshot();
const HAS_SNAPSHOT = Boolean(SNAPSHOT?.graph?.canvasAnalyses?.length);
const CAN_RUN = HAS_GRAPH && HAS_SNAPSHOT;

// ─── Loaders ────────────────────────────────────────────────────────────

function loadGraphWithProductionState(): any {
  const diskGraph = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf-8'));
  const snap = SNAPSHOT!.graph;

  // Overlay production runtime state from the snapshot onto the disk graph
  diskGraph.canvasAnalyses = snap.canvasAnalyses;
  diskGraph.currentQueryDSL = snap.currentQueryDSL;
  diskGraph.baseDSL = snap.baseDSL;
  diskGraph.dataInterestsDSL = snap.dataInterestsDSL;
  diskGraph.dailyFetch = snap.dailyFetch;
  diskGraph.defaultConnection = snap.defaultConnection;
  if (snap.postits) diskGraph.postits = snap.postits;
  if (snap.containers) diskGraph.containers = snap.containers;

  return diskGraph;
}

function loadAllParameterFiles(): Array<{ id: string; data: any }> {
  const dir = path.join(DATA_REPO!, 'parameters');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => ({
      id: f.replace('.yaml', ''),
      data: yaml.load(fs.readFileSync(path.join(dir, f), 'utf-8')) as any,
    }));
}

function loadYamlDir(dirName: string): Array<{ id: string; data: any }> {
  const dir = path.join(DATA_REPO!, dirName);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => ({
      id: f.replace('.yaml', ''),
      data: yaml.load(fs.readFileSync(path.join(dir, f), 'utf-8')) as any,
    }));
}

function loadNodeFiles(): Array<{ id: string; data: any }> {
  return loadYamlDir('nodes');
}

function loadContextFiles(): Array<{ id: string; data: any }> {
  return loadYamlDir('contexts');
}

function loadCaseFiles(): Array<{ id: string; data: any }> {
  return loadYamlDir('cases');
}

function loadEventFiles(): Array<{ id: string; data: any }> {
  return loadYamlDir('events');
}

function indexFileId(name: string): string {
  if (name === 'parameters-index.yaml') return 'parameter-index';
  if (name === 'nodes-index.yaml') return 'node-index';
  if (name === 'contexts-index.yaml') return 'context-index';
  if (name === 'cases-index.yaml') return 'case-index';
  if (name === 'events-index.yaml') return 'event-index';
  return name.replace('.yaml', '');
}

function indexFileType(name: string): string {
  if (name === 'parameters-index.yaml') return 'parameter-index';
  if (name === 'nodes-index.yaml') return 'node-index';
  if (name === 'contexts-index.yaml') return 'context';
  if (name === 'cases-index.yaml') return 'case';
  if (name === 'events-index.yaml') return 'event';
  return 'unknown';
}

function loadIndexFile(name: string): any {
  const p = path.join(DATA_REPO!, name);
  if (!fs.existsSync(p)) return null;
  try {
    return yaml.load(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function extractScenarioState(): {
  scenarioState: any;
  scenarios: Array<{ id: string; name: string; colour: string; meta: any }>;
} {
  const tabId = SNAPSHOT!.tabId;
  // The snapshot doesn't store the tab editorState directly, but we can
  // reconstruct the scenario state from the canvasAnalyses' custom scenarios
  // and the known production state.
  //
  // From the production snapshot these were the visible scenarios:
  //   - scenario-1772813352827-fzaxsuy ("17-Feb – 23-Feb", #EC4899)
  //   - current
  // With scenario-1772820754238-5136pgm also in the order but not visible.

  const scenarioIds = new Set<string>();
  for (const ca of SNAPSHOT!.graph.canvasAnalyses || []) {
    for (const s of ca.recipe?.scenarios || []) {
      if (s.scenario_id && s.scenario_id !== 'current' && s.scenario_id !== 'base') {
        scenarioIds.add(s.scenario_id);
      }
    }
  }

  const scenarioRecords: Array<{ id: string; name: string; colour: string; meta: any }> = [];
  const scenarioOrder = ['base'];
  const visibleScenarioIds: string[] = [];
  const visibleColourOrderIds: string[] = ['current'];
  const visibilityMode: Record<string, string> = { current: 'f+e' };

  for (const sid of scenarioIds) {
    // Find the scenario details from any canvasAnalysis that references it
    let name = sid;
    let colour = '#EC4899';
    let effectiveDsl = '';
    for (const ca of SNAPSHOT!.graph.canvasAnalyses || []) {
      const match = (ca.recipe?.scenarios || []).find((s: any) => s.scenario_id === sid);
      if (match) {
        name = match.name || sid;
        colour = match.colour || colour;
        effectiveDsl = match.effective_dsl || '';
        break;
      }
    }
    scenarioOrder.push(sid);
    visibleScenarioIds.push(sid);
    visibleColourOrderIds.push(sid);
    visibilityMode[sid] = 'f+e';
    scenarioRecords.push({
      id: sid,
      name,
      colour,
      meta: {
        isLive: true,
        queryDSL: effectiveDsl,
        lastEffectiveDSL: effectiveDsl,
      },
    });
  }

  scenarioOrder.push('current');
  visibleScenarioIds.push('current');

  return {
    scenarioState: {
      scenarioOrder,
      visibleScenarioIds,
      visibleColourOrderIds,
      visibilityMode,
    },
    scenarios: scenarioRecords,
  };
}

// ─── Test ───────────────────────────────────────────────────────────────

test.describe('Snapshot chart boot (production-weight data)', () => {
  test.skip(!CAN_RUN, 'Requires private data repo + debug graph snapshot');
  test.describe.configure({ timeout: 90_000 });

  test('all canvas charts render after a single F5 with heavy IDB', async ({
    page,
    baseURL,
  }) => {
    const graphData = loadGraphWithProductionState();
    const chartCount = graphData.canvasAnalyses.length;
    const paramFiles = loadAllParameterFiles();
    const nodeFiles = loadNodeFiles();
    const contextFiles = loadContextFiles();
    const caseFiles = loadCaseFiles();
    const eventFiles = loadEventFiles();
    const paramsIndex = loadIndexFile('parameters-index.yaml');
    const nodesIndex = loadIndexFile('nodes-index.yaml');
    const contextsIndex = loadIndexFile('contexts-index.yaml');
    const casesIndex = loadIndexFile('cases-index.yaml');
    const eventsIndex = loadIndexFile('events-index.yaml');
    const { scenarioState, scenarios } = extractScenarioState();
    const indexFiles = [
      { fileId: indexFileId('parameters-index.yaml'), type: indexFileType('parameters-index.yaml'), path: 'parameters-index.yaml', data: paramsIndex },
      { fileId: indexFileId('nodes-index.yaml'), type: indexFileType('nodes-index.yaml'), path: 'nodes-index.yaml', data: nodesIndex },
      { fileId: indexFileId('contexts-index.yaml'), type: indexFileType('contexts-index.yaml'), path: 'contexts-index.yaml', data: contextsIndex },
      { fileId: indexFileId('cases-index.yaml'), type: indexFileType('cases-index.yaml'), path: 'cases-index.yaml', data: casesIndex },
      { fileId: indexFileId('events-index.yaml'), type: indexFileType('events-index.yaml'), path: 'events-index.yaml', data: eventsIndex },
    ].filter((file) => Boolean(file.data));

    // ── Only mock: GitHub API (can't reach it in test) ──
    await page.route('https://api.github.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({}),
      }),
    );

    // ── Navigate + seed IDB ──
    await page.goto(new URL('/?e2e=1', baseURL!).toString(), {
      waitUntil: 'domcontentloaded',
    });

    const seedPayload = {
      graphData,
      graphFileId: GRAPH_FILE_ID,
      tabId: TAB_ID,
      repoName: REPO_NAME,
      paramFiles,
      nodeFiles,
      contextFiles,
      caseFiles,
      eventFiles,
      indexFiles,
      scenarioState,
      scenarios,
    };

    await page.evaluate(async (p) => {
      const db = (window as any).db;
      if (!db) throw new Error('window.db not available — is ?e2e=1 in the URL?');

      // ── Graph (with exact production canvasAnalyses + DSLs) ──
      await db.files.put({
        fileId: p.graphFileId,
        type: 'graph',
        viewTabs: [p.tabId],
        data: p.graphData,
        source: {
          repository: p.repoName,
          branch: 'main',
          path: `graphs/${p.graphFileId.replace('graph-', '')}.json`,
        },
      });

      // ── Parameter files (ALL of them — realistic IDB pressure) ──
      for (const param of p.paramFiles) {
        await db.files.put({
          fileId: `parameter-${param.id}`,
          type: 'parameter',
          data: param.data,
          source: {
            repository: p.repoName,
            branch: 'main',
            path: `parameters/${param.id}.yaml`,
          },
        });
      }

      // ── Node files ──
      for (const node of p.nodeFiles) {
        await db.files.put({
          fileId: `node-${node.id}`,
          type: 'node',
          data: node.data,
          source: {
            repository: p.repoName,
            branch: 'main',
            path: `nodes/${node.id}.yaml`,
          },
        });
      }

      for (const context of p.contextFiles) {
        await db.files.put({
          fileId: `context-${context.id}`,
          type: 'context',
          data: context.data,
          source: {
            repository: p.repoName,
            branch: 'main',
            path: `contexts/${context.id}.yaml`,
          },
        });
      }

      for (const graphCase of p.caseFiles) {
        await db.files.put({
          fileId: `case-${graphCase.id}`,
          type: 'case',
          data: graphCase.data,
          source: {
            repository: p.repoName,
            branch: 'main',
            path: `cases/${graphCase.id}.yaml`,
          },
        });
      }

      for (const event of p.eventFiles) {
        await db.files.put({
          fileId: `event-${event.id}`,
          type: 'event',
          data: event.data,
          source: {
            repository: p.repoName,
            branch: 'main',
            path: `events/${event.id}.yaml`,
          },
        });
      }

      // ── Index files ──
      for (const indexFile of p.indexFiles) {
        await db.files.put({
          fileId: indexFile.fileId,
          type: indexFile.type,
          data: indexFile.data,
          source: {
            repository: p.repoName,
            branch: 'main',
            path: indexFile.path,
          },
        });
      }

      // ── Scenarios (exact production scenario records) ──
      for (const s of p.scenarios) {
        await db.scenarios.put({
          id: s.id,
          fileId: p.graphFileId,
          name: s.name,
          colour: s.colour,
          meta: s.meta,
        });
      }

      // ── Tab with exact production scenario state ──
      await db.tabs.put({
        id: p.tabId,
        fileId: p.graphFileId,
        viewMode: 'interactive',
        title: 'Graph',
        icon: '',
        closable: true,
        group: 'main-content',
        editorState: {
          scenarioState: p.scenarioState,
          whatIfDSL: null,
        },
      });

      // ── Workspace credentials (must match real repo to produce correct signatures) ──
      await db.credentials?.put?.({
        id: 'main',
        data: {
          defaultGitRepo: p.repoName,
          git: [
            {
              name: p.repoName,
              owner: 'e2e-owner',
              repo: p.repoName,
              token: 'test-token',
              branch: 'main',
              basePath: '',
            },
          ],
        },
      });

      if (typeof db.saveAppState === 'function') {
        await db.saveAppState({ activeTabId: p.tabId, updatedAt: Date.now() });
      }
    }, seedPayload);

    // ── Capture console for diagnostics ──
    const consoleLogs: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (
        text.includes('CanvasScheduler') ||
        text.includes('SnapshotBoot') ||
        text.includes('SnapshotResolution') ||
        text.includes('SnapshotPlannerInputs') ||
        text.includes('ChartReadiness') ||
        text.includes('AnalysisPrepare') ||
        text.includes('compute-start') ||
        text.includes('compute-success') ||
        text.includes('compute-error') ||
        text.includes('[GraphComputeClient]') ||
        text.includes('/api/runner') ||
        text.includes('Failed to fetch') ||
        text.includes('ECONNREFUSED') ||
        text.includes('FetchPlan') ||
        text.includes('signature') ||
        text.includes('ContextEpochs')
      ) {
        consoleLogs.push(`[${Date.now()}] ${text.substring(0, 4000)}`);
      }
    });

    // ── Intercept Python backend requests to capture full payloads ──
    const apiPayloads: string[] = [];
    await page.route('**/api/runner/analyze', async (route) => {
      const request = route.request();
      const postData = request.postData();
      if (postData) {
        try {
          const body = JSON.parse(postData);
          const analysisType = body.analysis_type || 'unknown';
          const scenarioCount = body.scenarios?.length || 0;
          const snapshotInfo = (body.scenarios || []).map((s: any) => ({
            scenario_id: s.scenario_id,
            snapshot_subject_count: s.snapshot_subjects?.length || 0,
            subjects: (s.snapshot_subjects || []).map((sub: any) => ({
              subject_id: sub.subject_id,
              param_id: sub.param_id,
              core_hash: sub.core_hash,
              anchor_from: sub.anchor_from,
              anchor_to: sub.anchor_to,
              sweep_from: sub.sweep_from,
              sweep_to: sub.sweep_to,
              slice_keys: sub.slice_keys,
              sig_len: sub.canonical_signature?.length || 0,
            })),
          }));
          apiPayloads.push(JSON.stringify({
            ts: Date.now(),
            analysis_type: analysisType,
            query_dsl: body.query_dsl,
            scenario_count: scenarioCount,
            snapshots: snapshotInfo,
          }, null, 2));
        } catch { /* ignore */ }
      }
      await route.continue();
    });

    // ── Full reload — this is the moment of truth ──
    await page.reload({ waitUntil: 'domcontentloaded' });

    // ── Wait for ReactFlow to mount ──
    await expect(page.locator('.react-flow').first()).toBeVisible({
      timeout: 15_000,
    });

    // ── All canvas analysis nodes must appear ──
    const nodes = page.locator('.canvas-analysis-node');
    await expect(nodes).toHaveCount(chartCount, { timeout: 20_000 });

    // ── Every chart must leave the loading/computing state ──
    const diagPath = path.join(REPO_ROOT, 'tmp', 'e2e-snapshot-boot-diag.txt');
    try {
      for (let i = 0; i < chartCount; i++) {
        const node = nodes.nth(i);
        await expect(node).toBeVisible({ timeout: 5_000 });

        await expect(node).not.toContainText('Computing...', {
          timeout: 30_000,
        });
        await expect(node).not.toContainText('Loading chart dependencies...', {
          timeout: 5_000,
        });
      }
    } finally {
      fs.mkdirSync(path.dirname(diagPath), { recursive: true });
      fs.writeFileSync(diagPath, consoleLogs.join('\n'), 'utf-8');
      const apiDiagPath = path.join(REPO_ROOT, 'tmp', 'e2e-snapshot-api-payloads.txt');
      fs.writeFileSync(apiDiagPath, apiPayloads.join('\n---\n'), 'utf-8');
    }
  });
});
