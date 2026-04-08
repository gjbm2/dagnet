/**
 * CLI ↔ FE parity E2E test.
 *
 * Loads a real graph in the browser, triggers from-file reaggregation
 * for a target DSL window, then calls the BE directly with the FE's
 * graph state. Separately runs the CLI with the same graph + DSL.
 * Compares the two BE results field-by-field.
 *
 * This proves the CLI produces the same graph state as the FE,
 * because the same BE produces different results from different graphs.
 *
 * Mocks: ONLY GitHub API (unreachable in test).
 * Real: IDB hydration, FileRegistry, from-file pipeline, Python BE.
 *
 * Skips when data repo is not present.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GRAPH_EDITOR = path.resolve(__dirname, '..');

// ─── Data repo discovery ───────────────────────────────────────────────

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

const GRAPH_NAME = 'gm-rebuild-jan-26';
const GRAPH_FILE_ID = `graph-${GRAPH_NAME}`;
const TAB_ID = `tab-${GRAPH_FILE_ID}-interactive`;
const INITIAL_DSL = 'window(1-Nov-25:30-Nov-25)';
const TARGET_DSL = 'window(1-Dec-25:20-Dec-25)';
const GRAPH_PATH = DATA_REPO ? path.join(DATA_REPO, 'graphs', `${GRAPH_NAME}.json`) : '';
const HAS_GRAPH = Boolean(GRAPH_PATH && fs.existsSync(GRAPH_PATH));

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

// ─── Test ──────────────────────────────────────────────────────────────

test.describe('CLI ↔ FE parity (graph_overview)', () => {
  test.skip(!HAS_GRAPH, 'Requires private data repo');
  test.describe.configure({ timeout: 90_000 });

  test('CLI produces identical graph_overview result to browser', async ({
    page,
    baseURL,
  }) => {
    const graphData = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf-8'));
    // Seed with initial DSL — we'll change to TARGET_DSL after boot to trigger reaggregation
    graphData.currentQueryDSL = INITIAL_DSL;

    const paramFiles = loadYamlDir('parameters');
    const eventFiles = loadYamlDir('events');
    const contextFiles = loadYamlDir('contexts');

    // ── Only mock: GitHub API ──
    await page.route('https://api.github.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    );

    // ── Navigate + seed IDB ──
    await page.goto(new URL('/?e2e=1', baseURL!).toString(), {
      waitUntil: 'domcontentloaded',
    });

    await page.evaluate(async (p) => {
      const db = (window as any).db;
      if (!db) throw new Error('window.db not available');

      await db.files.put({
        fileId: p.graphFileId, type: 'graph', viewTabs: [p.tabId],
        data: p.graphData,
        source: { repository: p.repoName, branch: 'main', path: `graphs/${p.graphName}.json` },
      });
      for (const param of p.paramFiles) {
        await db.files.put({
          fileId: `parameter-${param.id}`, type: 'parameter', data: param.data,
          source: { repository: p.repoName, branch: 'main', path: `parameters/${param.id}.yaml` },
        });
      }
      for (const event of p.eventFiles) {
        await db.files.put({
          fileId: `event-${event.id}`, type: 'event', data: event.data,
          source: { repository: p.repoName, branch: 'main', path: `events/${event.id}.yaml` },
        });
      }
      for (const context of p.contextFiles) {
        await db.files.put({
          fileId: `context-${context.id}`, type: 'context', data: context.data,
          source: { repository: p.repoName, branch: 'main', path: `contexts/${context.id}.yaml` },
        });
      }
      await db.credentials?.put?.({
        id: 'main',
        data: {
          defaultGitRepo: p.repoName,
          git: [{ name: p.repoName, owner: 'e2e-owner', repo: p.repoName, token: 'test-token', branch: 'main', basePath: '' }],
        },
      });
      await db.tabs.put({
        id: p.tabId, fileId: p.graphFileId, viewMode: 'interactive',
        title: 'Graph', icon: '', closable: true, group: 'main-content',
        editorState: {
          scenarioState: { scenarioOrder: ['base', 'current'], visibleScenarioIds: ['current'], visibleColourOrderIds: ['current'], visibilityMode: { current: 'f+e' } },
          whatIfDSL: null,
        },
      });
      if (typeof db.saveAppState === 'function') {
        await db.saveAppState({ activeTabId: p.tabId, updatedAt: Date.now() });
      }
    }, {
      graphFileId: GRAPH_FILE_ID, tabId: TAB_ID, graphName: GRAPH_NAME,
      graphData, repoName: REPO_NAME, paramFiles, eventFiles, contextFiles,
    });

    // ── Reload and wait for app to boot ──
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(3_000);

    // ── Set target DSL and trigger from-file fetch ──
    await page.evaluate(async (args) => {
      const getGraphStore = (window as any).__dagnet_getGraphStore;
      if (!getGraphStore) throw new Error('__dagnet_getGraphStore not available');
      const store = getGraphStore(args.graphFileId);
      if (!store) throw new Error(`No graphStore for ${args.graphFileId}`);

      // Set the target DSL
      store.getState().setCurrentDSL(args.targetDsl);
    }, { graphFileId: GRAPH_FILE_ID, targetDsl: TARGET_DSL });

    // Trigger refetch-from-files which runs the from-file pipeline
    // on the active graph (same as clicking the dev refresh button)
    await page.evaluate(async () => {
      const debug = (window as any).dagnetDebug;
      if (!debug?.refetchFromFiles) throw new Error('dagnetDebug.refetchFromFiles not available');
      await debug.refetchFromFiles('e2e-parity-test');
    });

    // Wait for from-file pipeline to complete and graph to update
    await page.waitForTimeout(10_000);

    // ── Extract the FE's graph state and call the BE directly ──
    const feResult = await page.evaluate(async (args) => {
      const getGraphStore = (window as any).__dagnet_getGraphStore;
      const store = getGraphStore(args.graphFileId);
      if (!store) throw new Error('No graphStore');
      const graph = store.getState().graph;
      if (!graph) throw new Error('No graph in store');

      // Call the BE directly with the FE's current graph
      const resp = await fetch('http://127.0.0.1:9000/api/runner/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenarios: [{
            scenario_id: 'current',
            name: 'Current',
            colour: '#3b82f6',
            visibility_mode: 'f+e',
            graph,
          }],
          query_dsl: args.targetDsl,
          analysis_type: 'graph_overview',
        }),
      });
      return resp.json();
    }, { graphFileId: GRAPH_FILE_ID, targetDsl: TARGET_DSL });

    expect(feResult.success).toBe(true);

    // ── Run the CLI ──
    const cliOutput = execSync(
      `npx tsx src/cli/analyse.ts --graph "${DATA_REPO}" --name "${GRAPH_NAME}" --query "${TARGET_DSL}" --type graph_overview --format json`,
      { cwd: GRAPH_EDITOR, timeout: 30_000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const cliResult = JSON.parse(cliOutput.trim());
    expect(cliResult.success).toBe(true);

    // ── Diagnostics ──
    const diagDir = path.join(REPO_ROOT, 'tmp');
    fs.mkdirSync(diagDir, { recursive: true });
    fs.writeFileSync(path.join(diagDir, 'parity-fe.json'), JSON.stringify(feResult.result?.data, null, 2));
    fs.writeFileSync(path.join(diagDir, 'parity-cli.json'), JSON.stringify(cliResult.result?.data, null, 2));

    // ── Field-by-field comparison ──
    const feData = feResult.result.data;
    const cliData = cliResult.result.data;

    expect(cliData.length).toBe(feData.length);

    const DISPLAY_ONLY = new Set(['scenario_name']);
    const mismatches: string[] = [];

    for (let i = 0; i < feData.length; i++) {
      for (const key of Object.keys(feData[i])) {
        if (DISPLAY_ONLY.has(key)) continue;
        if (typeof feData[i][key] === 'number') {
          const fe = feData[i][key];
          const cli = cliData[i][key];
          if (Math.abs(fe - cli) > 1e-6) {
            const outcome = feData[i].outcome || `row-${i}`;
            mismatches.push(`[${i}] ${outcome}.${key}: FE=${fe} CLI=${cli} diff=${Math.abs(fe - cli).toExponential(3)}`);
          }
        }
      }
    }

    if (mismatches.length > 0) {
      fs.writeFileSync(path.join(diagDir, 'parity-mismatches.txt'), mismatches.join('\n'));
    }

    expect(mismatches).toEqual([]);
  });
});
