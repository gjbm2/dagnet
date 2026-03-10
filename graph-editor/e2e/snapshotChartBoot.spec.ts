/**
 * Snapshot chart boot — heavyweight E2E spec.
 *
 * Loads the REAL production graph + ALL parameter files from the private
 * data repo at runtime, seeds a heavy IDB, sets up multiple scenarios
 * and 9 canvas analyses (4 snapshot-backed, 5 standard), then verifies
 * every chart reaches a rendered state after a single page load.
 *
 * Mocks: ONLY GitHub API (unreachable in test).
 * Real: IDB hydration, FileRegistry, snapshot subject resolution,
 *       preparation pipeline, Python compute backend.
 *
 * Skips gracefully when the data repo is not present (CI / fresh clone).
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

// ─── Data repo discovery (dir name NEVER appears in this file) ──────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONF_PATH = path.join(REPO_ROOT, '.private-repos.conf');

function resolveDataRepoPath(): string | null {
  if (!fs.existsSync(CONF_PATH)) return null;
  const match = fs.readFileSync(CONF_PATH, 'utf-8').match(/^DATA_REPO_DIR=(.+)$/m);
  const dir = match?.[1]?.trim();
  if (!dir) return null;
  const full = path.join(REPO_ROOT, dir);
  return fs.existsSync(full) ? full : null;
}

const DATA_REPO = resolveDataRepoPath();

// ─── Graph + fixture loading (all at import time so skip is fast) ───────

const GRAPH_NAME = 'gm-rebuild-jan-26';
const GRAPH_FILE_ID = `graph-${GRAPH_NAME}`;
const TAB_ID = `tab-${GRAPH_FILE_ID}-interactive`;
const GRAPH_PATH = DATA_REPO
  ? path.join(DATA_REPO, 'graphs', `${GRAPH_NAME}.json`)
  : '';
const HAS_GRAPH = GRAPH_PATH && fs.existsSync(GRAPH_PATH);

function loadGraphData(): any {
  const raw = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf-8'));
  // Use cohort DSL — that's the production state where snapshot charts fire.
  raw.currentQueryDSL = 'cohort(10-Dec-25:9-Mar-26)';
  return raw;
}

function nodeById(graph: any, uuid: string): any {
  return graph.nodes.find((n: any) => n.uuid === uuid);
}

function buildCanvasAnalyses(graph: any): any[] {
  const edgesWithParam = graph.edges.filter((e: any) => e.p?.id);
  const uuidToId = new Map(graph.nodes.map((n: any) => [n.uuid, n.id]));
  const intermediateNodes = graph.nodes.filter(
    (n: any) => !n.absorbing && !n.entry?.is_start,
  );
  const absorbingNodes = graph.nodes.filter((n: any) => n.absorbing);

  const edge0From = uuidToId.get(edgesWithParam[0]?.from) || '';
  const edge0To = uuidToId.get(edgesWithParam[0]?.to) || '';
  const edge1From = uuidToId.get(edgesWithParam[1]?.from) || '';
  const edge1To = uuidToId.get(edgesWithParam[1]?.to) || '';
  const inter0 = intermediateNodes[0]?.id || '';
  const inter1 = intermediateNodes[1]?.id || '';
  const inter2 = intermediateNodes[2]?.id || inter0;
  const absorb0 = absorbingNodes[0]?.id || '';
  const absorb1 = absorbingNodes[1]?.id || absorb0;
  const startNode = graph.nodes.find((n: any) => n.entry?.is_start);
  const startId = startNode?.id || '';

  let x = -650;
  const col = () => { const v = x; x += 460; return v; };

  return [
    // ── 4 snapshot-backed charts ──
    {
      id: 'e2e-snap-daily',
      x: col(), y: -180, width: 436, height: 398,
      view_mode: 'chart',
      chart_kind: 'daily_conversions',
      live: true,
      analysis_type_overridden: true,
      recipe: {
        analysis: {
          analysis_type: 'daily_conversions',
          analytics_dsl: `from(${edge0From}).to(${edge0To})`,
        },
      },
      display: {
        show_subject_overlay: false,
        time_grouping: 'day',
        show_trend_line: false,
        cumulative: false,
        show_legend: false,
      },
    },
    {
      id: 'e2e-snap-branch1',
      x: col(), y: -130, width: 651, height: 314,
      view_mode: 'chart',
      chart_kind: 'time_series',
      live: true,
      analysis_type_overridden: true,
      recipe: {
        analysis: {
          analysis_type: 'branch_comparison',
          analytics_dsl: `visited(${inter0})`,
        },
      },
      display: {
        metric_mode: 'absolute',
        stack_mode: 'stacked',
        series_type: 'bar',
        show_legend: true,
        time_grouping: 'week',
      },
    },
    {
      id: 'e2e-snap-branch2',
      x: col(), y: 200, width: 400, height: 300,
      view_mode: 'chart',
      chart_kind: 'time_series',
      live: true,
      analysis_type_overridden: true,
      recipe: {
        analysis: {
          analysis_type: 'branch_comparison',
          analytics_dsl: `visited(${inter1})`,
        },
      },
      display: { series_type: 'line', metric_mode: 'absolute', show_legend: false },
    },
    {
      id: 'e2e-snap-cohort',
      x: -150, y: 950, width: 400, height: 300,
      view_mode: 'chart',
      live: true,
      analysis_type_overridden: true,
      recipe: {
        analysis: {
          analysis_type: 'cohort_maturity',
          analytics_dsl: `from(${edge1From}).to(${edge1To})`,
        },
      },
    },

    // ── 5 non-snapshot charts (realistic load + potential interference) ──
    {
      id: 'e2e-std-general',
      x: 500, y: 600, width: 326, height: 366,
      view_mode: 'chart',
      live: true,
      analysis_type_overridden: true,
      recipe: {
        analysis: {
          analysis_type: 'general_selection',
          analytics_dsl: `to(${absorb0})`,
        },
      },
    },
    {
      id: 'e2e-std-overview',
      x: 20, y: 640, width: 400, height: 300,
      view_mode: 'chart',
      chart_kind: 'bar_grouped',
      live: true,
      analysis_type_overridden: true,
      recipe: {
        analysis: { analysis_type: 'graph_overview', analytics_dsl: '.' },
      },
    },
    {
      id: 'e2e-std-constrained',
      x: -560, y: -100, width: 400, height: 300,
      view_mode: 'chart',
      live: true,
      analysis_type_overridden: true,
      recipe: {
        analysis: {
          analysis_type: 'constrained_path',
          analytics_dsl: `from(${edge0From}).to(${absorb0}).visited(${inter2})`,
        },
      },
      display: { show_legend: false },
    },
    {
      id: 'e2e-std-branch-pie',
      x: -570, y: 730, width: 400, height: 300,
      view_mode: 'chart',
      live: false,
      analysis_type_overridden: true,
      recipe: {
        analysis: {
          analysis_type: 'branch_comparison',
          analytics_dsl: `visitedAny(${inter2},${absorb1})`,
        },
        scenarios: [
          {
            scenario_id: 'e2e-scenario-a',
            name: 'Scenario A',
            colour: '#EC4899',
            visibility_mode: 'f+e',
            effective_dsl: 'window(17-Feb-26:23-Feb-26)',
            is_live: true,
          },
          {
            scenario_id: 'current',
            name: 'Current',
            colour: '#3B82F6',
            visibility_mode: 'f+e',
            effective_dsl: 'window(2-Mar-26:8-Mar-26)',
            is_live: true,
          },
        ],
      },
      display: { show_legend: false },
      chart_kind: 'pie',
    },
    {
      id: 'e2e-std-branch-default',
      x: 680, y: 280, width: 400, height: 300,
      view_mode: 'chart',
      live: true,
      analysis_type_overridden: true,
      recipe: {
        analysis: {
          analysis_type: 'branch_comparison',
          analytics_dsl: `visited(${inter0})`,
        },
      },
    },
  ];
}

function loadAllParameterFiles(): Array<{ id: string; data: any }> {
  const dir = path.join(DATA_REPO!, 'parameters');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => ({
      id: f.replace('.yaml', ''),
      data: yaml.load(fs.readFileSync(path.join(dir, f), 'utf-8')) as any,
    }));
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

function loadNodeFiles(): Array<{ id: string; data: any }> {
  const dir = path.join(DATA_REPO!, 'nodes');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => ({
      id: f.replace('.yaml', ''),
      data: yaml.load(fs.readFileSync(path.join(dir, f), 'utf-8')) as any,
    }));
}

// ─── Test ───────────────────────────────────────────────────────────────

test.describe('Snapshot chart boot (production-weight data)', () => {
  test.skip(!HAS_GRAPH, 'Requires private data repo with graph fixture');
  test.describe.configure({ timeout: 90_000 });

  test('all 9 charts (4 snapshot) render after a single F5 with heavy IDB', async ({
    page,
    baseURL,
  }) => {
    const graphData = loadGraphData();
    graphData.canvasAnalyses = buildCanvasAnalyses(graphData);

    const paramFiles = loadAllParameterFiles();
    const nodeFiles = loadNodeFiles();
    const paramsIndex = loadIndexFile('parameters-index.yaml');
    const nodesIndex = loadIndexFile('nodes-index.yaml');

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
      paramFiles,
      nodeFiles,
      paramsIndex,
      nodesIndex,
    };

    await page.evaluate(async (p) => {
      const db = (window as any).db;
      if (!db) throw new Error('window.db not available — is ?e2e=1 in the URL?');

      // ── Graph ──
      await db.files.put({
        fileId: p.graphFileId,
        type: 'graph',
        viewTabs: [p.tabId],
        data: p.graphData,
        source: {
          repository: 'repo-1',
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
            repository: 'repo-1',
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
            repository: 'repo-1',
            branch: 'main',
            path: `nodes/${node.id}.yaml`,
          },
        });
      }

      // ── Index files ──
      if (p.paramsIndex) {
        await db.files.put({
          fileId: 'parameter-index',
          type: 'parameter-index',
          data: p.paramsIndex,
          source: {
            repository: 'repo-1',
            branch: 'main',
            path: 'parameters-index.yaml',
          },
        });
      }
      if (p.nodesIndex) {
        await db.files.put({
          fileId: 'node-index',
          type: 'node-index',
          data: p.nodesIndex,
          source: {
            repository: 'repo-1',
            branch: 'main',
            path: 'nodes-index.yaml',
          },
        });
      }

      // ── Scenarios (live window-based, like production) ──
      await db.scenarios.put({
        id: 'e2e-scenario-a',
        fileId: p.graphFileId,
        name: 'Scenario A',
        colour: '#EC4899',
        meta: {
          isLive: true,
          queryDSL: 'window(17-Feb-26:23-Feb-26)',
          lastEffectiveDSL: 'window(17-Feb-26:23-Feb-26)',
        },
      });
      await db.scenarios.put({
        id: 'e2e-scenario-b',
        fileId: p.graphFileId,
        name: 'Scenario B',
        colour: '#10B981',
        meta: {
          isLive: true,
          queryDSL: 'window(10-Feb-26:16-Feb-26)',
          lastEffectiveDSL: 'window(10-Feb-26:16-Feb-26)',
        },
      });

      // ── Tab with multi-scenario state ──
      await db.tabs.put({
        id: p.tabId,
        fileId: p.graphFileId,
        viewMode: 'interactive',
        title: 'Graph',
        icon: '',
        closable: true,
        group: 'main-content',
        editorState: {
          scenarioState: {
            scenarioOrder: ['base', 'e2e-scenario-a', 'e2e-scenario-b', 'current'],
            visibleScenarioIds: ['e2e-scenario-a', 'current'],
            visibleColourOrderIds: ['current', 'e2e-scenario-a'],
            visibilityMode: {
              'e2e-scenario-a': 'f+e',
              'e2e-scenario-b': 'f+e',
              current: 'f+e',
            },
          },
          whatIfDSL: null,
        },
      });

      // ── Workspace credentials ──
      await db.credentials?.put?.({
        id: 'main',
        data: {
          defaultGitRepo: 'repo-1',
          git: [
            {
              name: 'repo-1',
              owner: 'owner-1',
              repo: 'repo-1',
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

    // ── Full reload — this is the moment of truth ──
    await page.reload({ waitUntil: 'domcontentloaded' });

    // ── Wait for ReactFlow to mount ──
    await expect(page.locator('.react-flow').first()).toBeVisible({
      timeout: 15_000,
    });

    // ── All 9 canvas analysis nodes must appear ──
    const nodes = page.locator('.canvas-analysis-node');
    await expect(nodes).toHaveCount(9, { timeout: 20_000 });

    // ── Every chart must leave the loading/computing state ──
    // This is the assertion that catches the race condition:
    // stuck charts show "Computing..." or "Loading chart dependencies..."
    // indefinitely.
    for (let i = 0; i < 9; i++) {
      const node = nodes.nth(i);
      await expect(node).toBeVisible({ timeout: 5_000 });

      // Must not be stuck computing
      await expect(node).not.toContainText('Computing...', {
        timeout: 30_000,
      });
      // Must not be stuck waiting for deps (hydration stall)
      await expect(node).not.toContainText('Loading chart dependencies...', {
        timeout: 5_000,
      });
    }
  });
});
