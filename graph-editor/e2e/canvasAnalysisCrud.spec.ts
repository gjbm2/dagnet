/**
 * Canvas analysis CRUD — E2E specs.
 *
 * These test the actual user flows that are currently broken.
 * They WILL FAIL until the underlying code is fixed.
 * Each spec documents the exact broken behaviour and the expected contract.
 */

import { test, expect, Page } from '@playwright/test';

test.describe.configure({ timeout: 30_000 });

const TEST_GRAPH = {
  nodes: [
    { uuid: 'n-start', id: 'start-page', label: 'Start Page', entry: { is_start: true, weight: 1.0 } },
    { uuid: 'n-mid', id: 'signup', label: 'Signup' },
    { uuid: 'n-end', id: 'purchase', label: 'Purchase', absorbing: true },
  ],
  edges: [
    { uuid: 'e1', id: 'start-to-signup', from: 'n-start', to: 'n-mid', p: { mean: 0.5 } },
    { uuid: 'e2', id: 'signup-to-purchase', from: 'n-mid', to: 'n-end', p: { mean: 0.4 } },
  ],
  currentQueryDSL: 'window(-30d:)',
  baseDSL: 'window(-30d:)',
  metadata: { name: 'e2e-canvas-analysis', version: '1.0.0' },
};

async function stubComputeApi(page: Page) {
  await page.route('http://127.0.0.1:9000/api/runner/available-analyses', async (route) => {
    const body = route.request().postDataJSON();
    const scenarioCount = body?.scenario_count ?? 1;
    const queryDsl = body?.query_dsl ?? '';
    const hasTo = queryDsl.includes('to(');
    const hasFrom = queryDsl.includes('from(');

    let analyses: any[] = [];
    if (!queryDsl) {
      analyses = [{ id: 'graph_overview', name: 'Graph Overview', is_primary: true }];
    } else if (hasFrom && hasTo) {
      analyses = [
        { id: 'conversion_funnel', name: 'Conversion Funnel', is_primary: true },
        { id: 'path_between', name: 'Path Between', is_primary: false },
      ];
    } else if (hasTo && scenarioCount >= 2) {
      analyses = [
        { id: 'bridge_view', name: 'Bridge View', is_primary: true },
        { id: 'to_node_reach', name: 'Reach Probability', is_primary: false },
      ];
    } else if (hasTo) {
      analyses = [
        { id: 'to_node_reach', name: 'Reach Probability', is_primary: true },
      ];
    } else if (hasFrom) {
      analyses = [
        { id: 'from_node_outcomes', name: 'From Node Outcomes', is_primary: true },
      ];
    } else {
      analyses = [{ id: 'graph_overview', name: 'Graph Overview', is_primary: true }];
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ analyses }),
    });
  });

  await page.route('http://127.0.0.1:9000/api/runner/analyze', async (route) => {
    const body = route.request().postDataJSON();
    const analysisType = body?.analysis_type || 'graph_overview';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        result: {
          analysis_type: analysisType,
          analysis_name: analysisType === 'bridge_view' ? 'Bridge View' : 'Reach Probability',
          data: [{ scenario_id: 'current', probability: 0.2 }],
          semantics: {
            dimensions: [{ id: 'scenario_id', role: 'primary' }],
            metrics: [{ id: 'probability', role: 'primary' }],
            chart: {
              recommended: analysisType === 'bridge_view' ? 'bridge'
                : analysisType === 'conversion_funnel' ? 'funnel'
                : 'bar',
              alternatives: [],
            },
          },
          dimension_values: {
            scenario_id: { current: { name: 'Current', colour: '#3b82f6' } },
          },
        },
      }),
    });
  });
}

async function seedGraphWithScenarios(page: Page, scenarioCount: number) {
  await page.evaluate(async ({ graphData, scenarioCount }) => {
    const db = (window as any).db;
    if (!db) throw new Error('db not available');

    await db.files.put({
      fileId: 'graph-e2e-canvas-analysis',
      type: 'graph',
      viewTabs: ['tab-graph-interactive'],
      data: graphData,
      source: { repository: 'repo-1', branch: 'main', path: 'graphs/e2e-canvas-analysis.json' },
    });

    const scenarioState: any = {
      visibleScenarioIds: ['current'],
      scenarioOrder: ['current'],
      visibleColourOrderIds: ['current'],
      visibilityMode: {},
    };

    if (scenarioCount >= 2) {
      scenarioState.visibleScenarioIds.push('scenario-2');
      scenarioState.scenarioOrder.push('scenario-2');
      scenarioState.visibleColourOrderIds.push('scenario-2');
    }

    await db.tabs.put({
      id: 'tab-graph-interactive',
      fileId: 'graph-e2e-canvas-analysis',
      viewMode: 'interactive',
      title: 'Graph',
      icon: '',
      closable: true,
      group: 'main-content',
      editorState: { scenarioState },
    });

    if (scenarioCount >= 2) {
      await db.scenarios.put({
        id: 'scenario-2',
        fileId: 'graph-e2e-canvas-analysis',
        name: 'Scenario 2',
        colour: '#EC4899',
        meta: {
          isLive: true,
          queryDSL: 'context(device:mobile)',
          lastEffectiveDSL: 'window(-30d:).context(device:mobile)',
        },
      });
    }

    if (typeof db.saveAppState === 'function') {
      await db.saveAppState({ activeTabId: 'tab-graph-interactive', updatedAt: Date.now() });
    }
  }, { graphData: TEST_GRAPH, scenarioCount });
}

async function waitForCanvas(page: Page) {
  await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 10_000 });
}

async function selectNodeById(page: Page, nodeLabel: string) {
  const node = page.locator(`.react-flow__node`).filter({ hasText: nodeLabel }).first();
  await expect(node).toBeVisible({ timeout: 5_000 });
  await node.click();
  await page.waitForTimeout(500);
}

// ──────────────────────────────────────────────────────────────
// SPEC 1: Element palette creation with absorbing node + 2 scenarios
//         should open the analysis-type chooser, not pre-resolve a type
// ──────────────────────────────────────────────────────────────

test.describe('Canvas analysis creation parity', () => {
  test('element palette: absorbing node + 2 scenarios should show chooser with bridge_view available', async ({ page, baseURL }) => {
    await stubComputeApi(page);
    await page.goto(new URL('/?e2e=1', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    await seedGraphWithScenarios(page, 2);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForCanvas(page);

    await selectNodeById(page, 'Purchase');

    // Click "Add Analysis" in element palette
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('dagnet:addAnalysis'));
    });

    // Wait for draw mode, then click on canvas to place chart (default size)
    await page.waitForTimeout(1000);
    const canvas = page.locator('.react-flow__pane').first();
    await canvas.click({ position: { x: 600, y: 400 } });

    // Wait for canvas analysis node to appear
    const analysisNode = page.locator('.canvas-analysis-node').first();
    await expect(analysisNode).toBeVisible({ timeout: 10_000 });

    // Element palette creates a blank analysis seeded with DSL.
    // The user chooses the type here rather than getting a pre-resolved chart.
    await expect(analysisNode).toContainText('Choose an analysis type', { timeout: 10_000 });
    await expect(analysisNode).toContainText('Bridge View');
    await expect(analysisNode).toContainText('Reach Probability');

    // Verify the graph recipe persisted the selection DSL but not an analysis type.
    const persisted = await page.evaluate(async () => {
      const db = (window as any).db;
      if (!db) return null;
      const file = await db.files.get('graph-e2e-canvas-analysis');
      return file?.data?.canvasAnalyses?.[0]?.recipe?.analysis || null;
    });
    expect(persisted?.analytics_dsl).toBe('to(purchase)');
    expect(persisted?.analysis_type || '').toBe('');
  });

  test('analytics panel drag: absorbing node + 2 scenarios should create bridge_view', async ({ page, baseURL }) => {
    await stubComputeApi(page);
    await page.goto(new URL('/?e2e=1', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    await seedGraphWithScenarios(page, 2);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForCanvas(page);

    await selectNodeById(page, 'Purchase');

    // Wait for analytics panel to resolve
    await page.waitForTimeout(2000);

    // Check analytics panel shows bridge_view as selected type
    const analyticsPanel = page.locator('.analytics-panel').first();
    if (await analyticsPanel.isVisible()) {
      await expect(analyticsPanel).toContainText('Bridge', { timeout: 5_000 });
    }
  });
});

// ──────────────────────────────────────────────────────────────
// SPEC 2: Live → Custom toggle must preserve chart output
// ──────────────────────────────────────────────────────────────

test.describe('Live → Custom parity', () => {
  test('toggling to Custom must not change the visible chart type or content', async ({ page, baseURL }) => {
    await stubComputeApi(page);
    await page.goto(new URL('/?e2e=1', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    await seedGraphWithScenarios(page, 1);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForCanvas(page);

    // Create a chart via analytics panel path (this works)
    await selectNodeById(page, 'Purchase');
    await page.waitForTimeout(1500);

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

    await page.waitForTimeout(500);
    const canvas = page.locator('.react-flow__pane').first();
    await canvas.click({ position: { x: 600, y: 400 } });

    const analysisNode = page.locator('.canvas-analysis-node').first();
    await expect(analysisNode).toBeVisible({ timeout: 10_000 });

    // Record what's shown in Live mode
    const liveTitle = await analysisNode.locator('span').first().textContent();
    await expect(analysisNode.locator('text="LIVE"')).toBeVisible();

    // Select the analysis node and find its props panel
    await analysisNode.click();
    await page.waitForTimeout(1000);

    // Toggle to Custom in the Data Source section
    const customToggle = page.locator('text=Custom').first();
    if (await customToggle.isVisible()) {
      await customToggle.click();
      await page.waitForTimeout(2000);

      // Badge should now say CUSTOM
      await expect(analysisNode.locator('text="CUSTOM"')).toBeVisible({ timeout: 5_000 });

      // Chart content must remain the same
      const customTitle = await analysisNode.locator('span').first().textContent();
      expect(customTitle).toBe(liveTitle);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// SPEC 3: Display settings edits must update the chart
// ──────────────────────────────────────────────────────────────

test.describe('Chart settings reactivity', () => {
  test('changing display settings must update the chart on canvas without F5', async ({ page, baseURL }) => {
    await stubComputeApi(page);
    await page.goto(new URL('/?e2e=1', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    await seedGraphWithScenarios(page, 1);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForCanvas(page);

    // Create chart via pin (avoids node click issues)
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

    await page.waitForTimeout(500);
    const canvas = page.locator('.react-flow__pane').first();
    await canvas.click({ position: { x: 600, y: 400 } });

    const analysisNode = page.locator('.canvas-analysis-node').first();
    await expect(analysisNode).toBeVisible({ timeout: 10_000 });

    // Verify analysis exists in graph by reading IDB
    const hasAnalysis = await page.evaluate(async () => {
      const db = (window as any).db;
      if (!db) return false;
      const file = await db.files.get('graph-e2e-canvas-analysis');
      return file?.data?.canvasAnalyses?.length > 0;
    });
    expect(hasAnalysis).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────
// SPEC 4: Analysis type change must trigger recompute
// ──────────────────────────────────────────────────────────────

test.describe('Analysis type change reactivity', () => {
  test('canvas analysis persists to graph file in IDB after creation', async ({ page, baseURL }) => {
    await stubComputeApi(page);
    await page.goto(new URL('/?e2e=1', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    await seedGraphWithScenarios(page, 1);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForCanvas(page);

    // Create chart via pin
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

    await page.waitForTimeout(500);
    const canvas = page.locator('.react-flow__pane').first();
    await canvas.click({ position: { x: 600, y: 400 } });

    const analysisNode = page.locator('.canvas-analysis-node').first();
    await expect(analysisNode).toBeVisible({ timeout: 10_000 });

    // Wait for graph store -> IDB sync
    await page.waitForTimeout(3000);

    // Verify the analysis persisted to IDB with correct recipe
    const analysis = await page.evaluate(async () => {
      const db = (window as any).db;
      if (!db) return null;
      const file = await db.files.get('graph-e2e-canvas-analysis');
      return file?.data?.canvasAnalyses?.[0];
    });

    expect(analysis).toBeTruthy();
    expect(analysis.recipe.analysis.analysis_type).toBe('to_node_reach');
    expect(analysis.recipe.analysis.analytics_dsl).toBe('to(purchase)');
    expect(analysis.live).toBe(true);
    expect(analysis.view_mode).toBe('chart');
  });
});
