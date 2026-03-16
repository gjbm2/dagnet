import { test, expect, Page } from '@playwright/test';

test.describe.configure({ timeout: 30_000 });

const TEST_GRAPH = {
  nodes: [
    { uuid: 'n-start', id: 'start-page', label: 'Start Page', entry: { is_start: true, weight: 1.0 } },
    { uuid: 'n-end', id: 'purchase', label: 'Purchase', absorbing: true },
  ],
  edges: [
    { uuid: 'e1', id: 'start-to-purchase', from: 'n-start', to: 'n-end', p: { mean: 0.5 } },
  ],
  currentQueryDSL: 'window(-30d:)',
  baseDSL: 'window(-30d:)',
  metadata: { name: 'e2e-reload-custom', version: '1.0.0' },
};

async function stubComputeApi(page: Page) {
  await page.route('http://127.0.0.1:9000/**', async (route) => {
    const url = route.request().url();
    if (url.includes('available-analyses')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ analyses: [{ id: 'to_node_reach', name: 'Reach Probability', is_primary: true }] }),
      });
      return;
    }
    if (url.includes('analyze')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          result: {
            analysis_type: 'to_node_reach',
            analysis_name: 'Reach Probability',
            data: [{ scenario_id: 'current', probability: 0.5 }],
            semantics: {
              dimensions: [{ id: 'scenario_id', role: 'primary' }],
              metrics: [{ id: 'probability', role: 'primary' }],
              chart: { recommended: 'bar', alternatives: ['table'] },
            },
            dimension_values: { scenario_id: { current: { name: 'Current', colour: '#3b82f6' } } },
          },
        }),
      });
      return;
    }
    await route.continue();
  });
}

async function seedGraph(page: Page) {
  await page.evaluate(async (graphData) => {
    const db = (window as any).db;
    if (!db) throw new Error('db not available');

    await db.files.put({
      fileId: 'graph-e2e-reload-custom',
      type: 'graph',
      viewTabs: ['tab-graph-reload-custom'],
      data: graphData,
      source: { repository: 'repo-1', branch: 'main', path: 'graphs/e2e-reload-custom.json' },
    });

    await db.tabs.put({
      id: 'tab-graph-reload-custom',
      fileId: 'graph-e2e-reload-custom',
      viewMode: 'interactive',
      title: 'Graph',
      icon: '',
      closable: true,
      group: 'main-content',
      editorState: {
        scenarioState: {
          scenarioOrder: ['current'],
          visibleScenarioIds: ['current'],
          visibleColourOrderIds: ['current'],
          visibilityMode: {},
        },
      },
    });

    if (typeof db.saveAppState === 'function') {
      await db.saveAppState({ activeTabId: 'tab-graph-reload-custom', updatedAt: Date.now() });
    }
  }, TEST_GRAPH);
}

test.describe('Canvas analysis reload', () => {
  test('custom chart created in app reloads and renders after F5 without user nudge', async ({ page, baseURL }) => {
    await stubComputeApi(page);
    await page.goto(new URL('/?e2e=1', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    await seedGraph(page);
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 10_000 });

    // Create a chart in the running app via pinAnalysisToCanvas
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('dagnet:pinAnalysisToCanvas', {
        detail: {
          objectType: 'canvas-analysis',
          recipe: { analysis: { analysis_type: 'to_node_reach', analytics_dsl: 'to(purchase)' } },
          analysisTypeOverridden: true,
          viewMode: 'chart',
        },
      }));
    });

    // Wait for draw mode to be active (deterministic — no arbitrary timeout)
    await expect(page.locator('.rf-create-mode')).toBeVisible({ timeout: 5_000 });

    // Click well below the nodes to avoid hitting them (which would abort the draw handler)
    const canvas = page.locator('.react-flow__pane').first();
    await canvas.click({ position: { x: 200, y: 500 }, force: true });

    await expect.poll(async () => {
      return await page.evaluate(async () => {
        const db = (window as any).db;
        const file = await db?.files?.get?.('graph-e2e-reload-custom');
        return file?.data?.canvasAnalyses?.length || 0;
      });
    }, { timeout: 10_000 }).toBe(1);

    const analysisNode = page.locator('.canvas-analysis-node').first();
    await expect(analysisNode).toBeVisible({ timeout: 10_000 });

    // Force custom mode by mutating persisted graph in-app
    await page.evaluate(async () => {
      const db = (window as any).db;
      const file = await db.files.get('graph-e2e-reload-custom');
      if (!file?.data?.canvasAnalyses?.[0]) throw new Error('analysis not persisted');
      file.data.canvasAnalyses[0].mode = 'custom';
      file.data.canvasAnalyses[0].recipe.scenarios = [
        { scenario_id: 'current', name: 'Current', colour: '#3b82f6', effective_dsl: 'window(-30d:)', visibility_mode: 'f+e' },
      ];
      await db.files.put(file);
    });

    await page.reload({ waitUntil: 'domcontentloaded' });

    const reloadedNode = page.locator('.canvas-analysis-node').first();
    await expect(reloadedNode).toBeVisible({ timeout: 10_000 });
    await expect(reloadedNode).toContainText('CUSTOM', { timeout: 10_000 });
    await expect(reloadedNode).not.toContainText('Computing...', { timeout: 10_000 });
    await expect(reloadedNode).not.toContainText('Cannot read', { timeout: 10_000 });
    await expect(reloadedNode).not.toContainText('Select this analysis', { timeout: 10_000 });
  });
});
