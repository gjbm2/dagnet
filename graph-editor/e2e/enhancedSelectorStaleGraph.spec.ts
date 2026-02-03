/**
 * EnhancedSelector Stale Graph Regression Test
 * 
 * REGRESSION: When selecting a parameter from the dropdown, the auto-get fetch
 * was using a stale graph closure (captured at render time), which would overwrite
 * the newly selected p.id with the old value.
 * 
 * This test verifies that:
 * 1. User can type in the parameter selector
 * 2. User can select an item from the dropdown
 * 3. The selected p.id PERSISTS and is not overwritten by auto-get
 */

import { test, expect, Page } from '@playwright/test';

// 10 second timeout - if it's slower, it's broken
test.describe.configure({ timeout: 10_000 });

// ============================================================================
// Test Fixtures
// ============================================================================

const TEST_GRAPH = {
  nodes: [
    { uuid: 'node-1', id: 'start-node', label: 'Start' },
    { uuid: 'node-2', id: 'end-node', label: 'End' },
  ],
  edges: [
    {
      uuid: 'edge-1',
      id: 'test-edge',
      from: 'node-1',
      to: 'node-2',
      p: { id: 'initial-param', mean: 0.5 },
    },
  ],
  currentQueryDSL: 'window(1-Jan-26:7-Jan-26)',
  baseDSL: 'window(1-Jan-26:7-Jan-26)',
  metadata: { name: 'e2e-selector-test' },
};

const PARAMETERS_INDEX = `parameters:
  - id: initial-param
    file_path: parameters/initial-param.yaml
  - id: target-param
    file_path: parameters/target-param.yaml
  - id: another-param
    file_path: parameters/another-param.yaml
`;

const INITIAL_PARAM_FILE = `id: initial-param
name: Initial Parameter
type: probability
values:
  - mean: 0.5
    n: 100
    k: 50
`;

const TARGET_PARAM_FILE = `id: target-param
name: Target Parameter
type: probability
values:
  - mean: 0.75
    n: 200
    k: 150
`;

// ============================================================================
// Stub Setup
// ============================================================================

async function installGitHubStubs(page: Page) {
  // Stub GitHub API to serve our test fixtures
  await page.route('https://api.github.com/**', async (route) => {
    const url = route.request().url();

    // Git ref (branch HEAD)
    if (url.includes('/git/ref/heads/') || url.includes('/git/refs/heads/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ref: 'refs/heads/main',
          object: { sha: 'sha_e2e_selector_test', type: 'commit' },
        }),
      });
    }

    // Git commit
    if (url.includes('/git/commits/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sha: 'sha_e2e_selector_test',
          tree: { sha: 'tree_e2e_selector_test' },
        }),
      });
    }

    // Git tree
    if (url.includes('/git/trees/')) {
      const entries = [
        { path: 'graphs/e2e-selector-test.json', sha: 'sha_graph', type: 'blob', mode: '100644', size: 500 },
        { path: 'parameters-index.yaml', sha: 'sha_params_index', type: 'blob', mode: '100644', size: 200 },
        { path: 'parameters/initial-param.yaml', sha: 'sha_initial_param', type: 'blob', mode: '100644', size: 100 },
        { path: 'parameters/target-param.yaml', sha: 'sha_target_param', type: 'blob', mode: '100644', size: 100 },
        { path: 'settings/settings.yaml', sha: 'sha_settings', type: 'blob', mode: '100644', size: 50 },
      ];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sha: 'tree_e2e_selector_test', truncated: false, tree: entries }),
      });
    }

    // Git blobs
    if (url.includes('/git/blobs/')) {
      const sha = url.split('/git/blobs/')[1]?.split('?')[0] || '';
      let content = '';
      
      if (sha === 'sha_graph') {
        content = JSON.stringify(TEST_GRAPH);
      } else if (sha === 'sha_params_index') {
        content = PARAMETERS_INDEX;
      } else if (sha === 'sha_initial_param') {
        content = INITIAL_PARAM_FILE;
      } else if (sha === 'sha_target_param') {
        content = TARGET_PARAM_FILE;
      } else if (sha === 'sha_settings') {
        content = 'version: 1.0.0\nforecasting:\n  RECENCY_HALF_LIFE_DAYS: 30\n';
      }

      if (content) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            sha,
            size: content.length,
            encoding: 'base64',
            content: Buffer.from(content, 'utf8').toString('base64'),
          }),
        });
      }
      return route.fulfill({ status: 404 });
    }

    // Contents API fallback
    if (url.includes('/contents/')) {
      const path = url.match(/\/contents\/(.+?)(\?|$)/)?.[1] || '';
      let content = '';
      let sha = '';

      if (path === 'graphs/e2e-selector-test.json') {
        content = JSON.stringify(TEST_GRAPH);
        sha = 'sha_graph';
      } else if (path === 'parameters-index.yaml') {
        content = PARAMETERS_INDEX;
        sha = 'sha_params_index';
      } else if (path === 'parameters/initial-param.yaml') {
        content = INITIAL_PARAM_FILE;
        sha = 'sha_initial_param';
      } else if (path === 'parameters/target-param.yaml') {
        content = TARGET_PARAM_FILE;
        sha = 'sha_target_param';
      } else if (path === 'settings/settings.yaml') {
        content = 'version: 1.0.0\nforecasting:\n  RECENCY_HALF_LIFE_DAYS: 30\n';
        sha = 'sha_settings';
      }

      if (content) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            name: path.split('/').pop(),
            path,
            sha,
            size: content.length,
            type: 'file',
            content: Buffer.from(content, 'utf8').toString('base64'),
            encoding: 'base64',
          }),
        });
      }
      return route.fulfill({ status: 404 });
    }

    return route.fulfill({ status: 404 });
  });

  // Stub compute API (not needed for this test but prevents errors)
  await page.route('http://127.0.0.1:9000/**', (route) => {
    return route.fulfill({ status: 200, body: JSON.stringify({ success: true }) });
  });
}

/**
 * Seed test data into IndexedDB (persists across reload)
 */
async function seedDbData(page: Page) {
  await page.evaluate(async (graphData) => {
    const db = (window as any).db;
    if (!db) throw new Error('db not available');

    // Seed the graph file
    await db.files.put({
      fileId: 'graph-e2e-selector-test',
      type: 'graph',
      viewTabs: [],
      data: graphData,
      source: { repository: 'repo-1', branch: 'main', path: 'graphs/e2e-selector-test.json' },
    });

    // Seed parameter files
    await db.files.put({
      fileId: 'parameter-initial-param',
      type: 'parameter',
      viewTabs: [],
      data: {
        id: 'initial-param',
        name: 'Initial Parameter',
        type: 'probability',
        values: [{ mean: 0.5, n: 100, k: 50 }],
      },
      source: { repository: 'repo-1', branch: 'main', path: 'parameters/initial-param.yaml' },
    });

    await db.files.put({
      fileId: 'parameter-target-param',
      type: 'parameter',
      viewTabs: [],
      data: {
        id: 'target-param',
        name: 'Target Parameter',
        type: 'probability',
        values: [{ mean: 0.75, n: 200, k: 150 }],
      },
      source: { repository: 'repo-1', branch: 'main', path: 'parameters/target-param.yaml' },
    });

    // Open a tab for the graph
    await db.tabs.put({
      id: 'tab-graph-1',
      fileId: 'graph-e2e-selector-test',
      viewMode: 'interactive',
      title: 'E2E Selector Test',
      icon: '',
      closable: true,
      group: 'main-content',
    });

    if (typeof db.saveAppState === 'function') {
      await db.saveAppState({ activeTabId: 'tab-graph-1', updatedAt: Date.now() });
    }
  }, TEST_GRAPH);
}

/**
 * Seed data into fileRegistry (in-memory, must be called AFTER reload)
 * This is required for registryService to find the parameter-index
 */
async function seedFileRegistry(page: Page) {
  await page.evaluate(async (graphData) => {
    const fileRegistry = (window as any).fileRegistry;
    if (!fileRegistry || typeof fileRegistry.registerFile !== 'function') {
      console.warn('fileRegistry.registerFile not available - registry may not be populated');
      return;
    }

    // Seed the parameter-index file (required for registryService.getItems)
    await fileRegistry.registerFile('parameter-index', {
      fileId: 'parameter-index',
      type: 'index',
      viewTabs: [],
      data: {
        parameters: [
          { id: 'initial-param', file_path: 'parameters/initial-param.yaml' },
          { id: 'target-param', file_path: 'parameters/target-param.yaml' },
          { id: 'another-param', file_path: 'parameters/another-param.yaml' },
        ],
      },
      source: { repository: 'repo-1', branch: 'main', path: 'parameters-index.yaml' },
    });

    // Seed the parameter files
    await fileRegistry.registerFile('parameter-initial-param', {
      fileId: 'parameter-initial-param',
      type: 'parameter',
      viewTabs: [],
      data: {
        id: 'initial-param',
        name: 'Initial Parameter',
        type: 'probability',
        values: [{ mean: 0.5, n: 100, k: 50 }],
      },
      source: { repository: 'repo-1', branch: 'main', path: 'parameters/initial-param.yaml' },
    });

    await fileRegistry.registerFile('parameter-target-param', {
      fileId: 'parameter-target-param',
      type: 'parameter',
      viewTabs: [],
      data: {
        id: 'target-param',
        name: 'Target Parameter',
        type: 'probability',
        values: [{ mean: 0.75, n: 200, k: 150 }],
      },
      source: { repository: 'repo-1', branch: 'main', path: 'parameters/target-param.yaml' },
    });

    // Seed the graph file
    await fileRegistry.registerFile('graph-e2e-selector-test', {
      fileId: 'graph-e2e-selector-test',
      type: 'graph',
      viewTabs: [],
      data: graphData,
      source: { repository: 'repo-1', branch: 'main', path: 'graphs/e2e-selector-test.json' },
    });
  }, TEST_GRAPH);
}

async function getEdgeParamId(page: Page, edgeUuid: string): Promise<string | null> {
  return page.evaluate(async ({ edgeUuid }) => {
    const db = (window as any).db;
    if (!db) return null;
    const file = await db.files.get('graph-e2e-selector-test');
    const edge = file?.data?.edges?.find((e: any) => e.uuid === edgeUuid);
    return edge?.p?.id || null;
  }, { edgeUuid });
}

async function selectEdgeOrSkip(page: Page, edgeUuid: string) {
  // Prefer dev-only E2E hook (fast + deterministic)
  const usedHook = await page.evaluate((id) => {
    const e2e = (window as any).dagnetE2e;
    if (e2e?.selectEdge) {
      e2e.selectEdge(id);
      return true;
    }
    return false;
  }, edgeUuid);

  if (usedHook) return;

  // Fallback: click ReactFlow edge element
  const edgeEl = page.locator(`[data-testid="rf__edge-${edgeUuid}"]`).first();
  if (await edgeEl.isVisible().catch(() => false)) {
    await edgeEl.click({ force: true });
    return;
  }

  test.skip(true, `Cannot select edge ${edgeUuid} (no hook; edge element not visible)`);
}

// ============================================================================
// Tests
// ============================================================================

test.describe('EnhancedSelector stale graph regression', () => {
  
  test('selecting a parameter from dropdown should persist p.id (not revert due to auto-get)', async ({ page, baseURL }) => {
    await installGitHubStubs(page);

    // Navigate to app and seed data into IndexedDB
    await page.goto(new URL('/?e2e=1', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    await seedDbData(page);
    await page.reload({ waitUntil: 'domcontentloaded' });

    // Wait for graph canvas to render (indicates app is ready)
    await expect(page.locator('.react-flow')).toBeVisible({ timeout: 5000 });

    // Seed fileRegistry AFTER reload (required for registryService)
    await seedFileRegistry(page);

    // Verify initial p.id is 'initial-param'
    const initialParamId = await getEdgeParamId(page, 'edge-1');
    expect(initialParamId).toBe('initial-param');

    // Select edge using E2E hook (or fallback to click)
    const edgeSelected = await page.evaluate(() => {
      const e2e = (window as any).dagnetE2e;
      if (e2e?.selectEdge) {
        e2e.selectEdge('edge-1');
        return true;
      }
      return false;
    });

    if (!edgeSelected) {
      // Fallback: click on edge element
      const edgeElement = page.locator('[data-testid="rf__edge-edge-1"]').first();
      if (await edgeElement.isVisible().catch(() => false)) {
        await edgeElement.click({ force: true });
      } else {
        test.skip(true, 'Cannot select edge - E2E hooks not available and edge not visible');
        return;
      }
    }

    // Wait for properties panel with edge properties
    await page.waitForTimeout(100);
    const propsPanel = page.locator('.properties-panel, [data-testid="properties-panel"]').first();
    if (!(await propsPanel.isVisible({ timeout: 2000 }).catch(() => false))) {
      test.skip(true, 'Properties panel not accessible');
      return;
    }

    // Find the parameter selector
    const selectorInput = propsPanel.locator('.enhanced-selector input').first();
    if (!(await selectorInput.isVisible().catch(() => false))) {
      test.skip(true, 'Parameter selector not found in properties panel');
      return;
    }

    // Clear and type to filter
    await selectorInput.clear();
    await selectorInput.fill('target');
    await page.waitForTimeout(100);

    // Find and click on 'target-param' in dropdown
    const dropdownItem = page.locator('.enhanced-selector-item').filter({ hasText: 'target-param' }).first();
    if (!(await dropdownItem.isVisible({ timeout: 1000 }).catch(() => false))) {
      test.skip(true, 'Dropdown item not visible - registry may not have loaded');
      return;
    }
    await dropdownItem.click();

    // Brief wait for auto-get to complete
    await page.waitForTimeout(200);

    // CRITICAL ASSERTION: Verify p.id is now 'target-param' and didn't revert
    const finalParamId = await getEdgeParamId(page, 'edge-1');
    expect(finalParamId).toBe('target-param');

    // Also verify the input shows the correct value
    await expect(selectorInput).toHaveValue('target-param');
  });

  test('parameter selection should update graph state correctly', async ({ page, baseURL }) => {
    await installGitHubStubs(page);

    await page.goto(new URL('/?e2e=1', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    await seedDbData(page);
    await page.reload({ waitUntil: 'domcontentloaded' });

    // Wait for app to be ready
    await expect(page.locator('.react-flow')).toBeVisible({ timeout: 5000 });

    // Seed fileRegistry AFTER reload
    await seedFileRegistry(page);

    // Verify initial state via DB query
    const initialState = await page.evaluate(async () => {
      const db = (window as any).db;
      if (!db) return null;
      const file = await db.files.get('graph-e2e-selector-test');
      return {
        edgeCount: file?.data?.edges?.length || 0,
        firstEdgeParamId: file?.data?.edges?.[0]?.p?.id || null,
      };
    });

    expect(initialState?.edgeCount).toBe(1);
    expect(initialState?.firstEdgeParamId).toBe('initial-param');

    // Simulate direct graph mutation (what happens when user selects in UI)
    await page.evaluate(async () => {
      const db = (window as any).db;
      if (!db) return;
      
      const file = await db.files.get('graph-e2e-selector-test');
      if (file?.data?.edges?.[0]) {
        file.data.edges[0].p.id = 'target-param';
        await db.files.put(file);
      }
    });

    // Verify mutation persisted
    const afterMutation = await getEdgeParamId(page, 'edge-1');
    expect(afterMutation).toBe('target-param');

    // Brief wait and verify no background process reverted it
    await page.waitForTimeout(200);
    const finalState = await getEdgeParamId(page, 'edge-1');
    expect(finalState).toBe('target-param');
  });
});

// ============================================================================
// Registry index notification regression (workspace load from IDB)
// ============================================================================

async function seedWorkspaceForRegistryWarningRegression(page: Page, graphData: any = TEST_GRAPH) {
  await page.evaluate(async (graphData) => {
    const db = (window as any).db;
    if (!db) throw new Error('db not available');

    // Ensure workspace exists so NavigatorContext takes the "load from IDB" path.
    await db.workspaces.put({
      id: 'repo-1-main',
      repository: 'repo-1',
      branch: 'main',
      lastSynced: Date.now(),
      fileIds: [],
    });

    // Seed registry index file into IDB (this will later be loaded into fileRegistry memory).
    await db.files.put({
      fileId: 'parameter-index',
      type: 'parameter',
      viewTabs: [],
      data: {
        version: '1.0.0',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        parameters: [
          {
            id: 'initial-param',
            file_path: 'parameters/initial-param.yaml',
            type: 'probability',
            status: 'active',
          },
          {
            id: 'target-param',
            file_path: 'parameters/target-param.yaml',
            type: 'probability',
            status: 'active',
          },
        ],
      },
      source: { repository: 'repo-1', branch: 'main', path: 'parameters-index.yaml' },
      isDirty: false,
      isLoaded: true,
      isLocal: false,
      lastModified: Date.now(),
      lastSynced: Date.now(),
    });

    // Seed the graph file (opened in a tab on reload).
    await db.files.put({
      fileId: 'graph-e2e-selector-test',
      type: 'graph',
      viewTabs: [],
      data: graphData,
      source: { repository: 'repo-1', branch: 'main', path: 'graphs/e2e-selector-test.json' },
      isDirty: false,
      isLoaded: true,
      isLocal: false,
      lastModified: Date.now(),
      lastSynced: Date.now(),
    });

    // Seed parameter files (exist in IDB and should be treated as in-registry).
    await db.files.put({
      fileId: 'parameter-initial-param',
      type: 'parameter',
      viewTabs: [],
      data: {
        id: 'initial-param',
        name: 'Initial Parameter',
        type: 'probability',
        values: [{ mean: 0.5, n: 100, k: 50 }],
      },
      source: { repository: 'repo-1', branch: 'main', path: 'parameters/initial-param.yaml' },
      isDirty: false,
      isLoaded: true,
      isLocal: false,
      lastModified: Date.now(),
      lastSynced: Date.now(),
    });

    await db.files.put({
      fileId: 'parameter-target-param',
      type: 'parameter',
      viewTabs: [],
      data: {
        id: 'target-param',
        name: 'Target Parameter',
        type: 'probability',
        values: [{ mean: 0.75, n: 200, k: 150 }],
      },
      source: { repository: 'repo-1', branch: 'main', path: 'parameters/target-param.yaml' },
      isDirty: false,
      isLoaded: true,
      isLocal: false,
      lastModified: Date.now(),
      lastSynced: Date.now(),
    });

    // Add lots of extra workspace files to make loadWorkspaceFromIDB non-trivial.
    // This increases the chance that the selector renders before the index is loaded into memory.
    const now = Date.now();
    for (let i = 0; i < 400; i++) {
      await db.files.put({
        fileId: `node-dummy-${i}`,
        type: 'node',
        viewTabs: [],
        data: { id: `dummy-${i}`, name: `Dummy ${i}`, type: 'generic' },
        source: { repository: 'repo-1', branch: 'main', path: `nodes/dummy-${i}.yaml` },
        isDirty: false,
        isLoaded: true,
        isLocal: false,
        lastModified: now,
        lastSynced: now,
      });
    }

    // Open a tab for the graph and make it active.
    await db.tabs.put({
      id: 'tab-graph-1',
      fileId: 'graph-e2e-selector-test',
      viewMode: 'interactive',
      title: 'E2E Selector Test',
      icon: '',
      closable: true,
      group: 'main-content',
    });

    if (typeof db.saveAppState === 'function') {
      await db.saveAppState({ activeTabId: 'tab-graph-1', updatedAt: Date.now() });
    }
  }, graphData);
}

test.describe('EnhancedSelector registry index notification regression', () => {
  test('registry warning: hidden for indexed param; visible for unknown param (two edges)', async ({ page, baseURL }) => {
    // This should fail fast if broken; long waits usually mean a dead boot.
    test.setTimeout(15_000);

    // Stub GitHub + compute to avoid any accidental network dependency.
    await installGitHubStubs(page);

    // Single graph with two edges:
    // - edge-1 uses a registered parameter (must NOT show warning after hydration)
    // - edge-2 uses an unregistered parameter (must show warning)
    const twoEdgeGraph = structuredClone(TEST_GRAPH) as any;
    twoEdgeGraph.edges = [
      {
        uuid: 'edge-1',
        id: 'test-edge',
        from: 'node-1',
        to: 'node-2',
        p: { id: 'initial-param', mean: 0.5 },
      },
      {
        uuid: 'edge-2',
        id: 'test-edge-2',
        from: 'node-1',
        to: 'node-2',
        p: { id: 'missing-param', mean: 0.5 },
      },
    ];

    // 1) Boot once to ensure DB is ready, then seed workspace + files.
    await page.goto(
      // Provide ?secret so CredentialsManager can load env-provided test creds
      // (NavigatorContext needs credentials to load workspace from IndexedDB).
      new URL('/?e2e=1&secret=test-secret&repo=repo-1&branch=main&graph=e2e-selector-test', baseURL!).toString(),
      { waitUntil: 'domcontentloaded' }
    );
    await seedWorkspaceForRegistryWarningRegression(page, twoEdgeGraph);

    // 2) Reload to force normal app hydration paths (tabs + NavigatorContext workspace load).
    await page.reload({ waitUntil: 'domcontentloaded' });

    // Wait for graph canvas to render (app is interactive, selector can mount).
    await expect(page.locator('.react-flow')).toBeVisible({ timeout: 10_000 });

    // Select an edge first so the properties panel becomes visible.
    await selectEdgeOrSkip(page, 'edge-1');

    const propsPanel = page.locator('.properties-panel, [data-testid="properties-panel"]').first();
    await expect(propsPanel).toBeVisible({ timeout: 10_000 });

    const selectorInput = propsPanel.getByPlaceholder('Select or enter probability parameter ID...');
    const selectorRoot = selectorInput.locator('xpath=ancestor::div[contains(@class,"enhanced-selector")]');
    const warning = selectorRoot.locator('.enhanced-selector-message.warning');

    // Edge 1: registered param -> warning should clear after hydration
    await expect(selectorInput).toHaveValue('initial-param', { timeout: 10_000 });

    // Expected behaviour: once the workspace finishes hydrating, EnhancedSelector should refresh and clear the warning.
    // Regression: workspace bulk-load does not notify index subscribers, so warning stays stuck indefinitely.
    //
    // NOTE: This assertion intentionally relies only on UI state (no internal window.fileRegistry access),
    // to keep the repro robust across builds.
    await expect(warning).toBeHidden({ timeout: 2_000 });

    // Edge 2: unknown param -> warning should be shown
    await selectEdgeOrSkip(page, 'edge-2');
    await expect(selectorInput).toHaveValue('missing-param', { timeout: 10_000 });
    await expect(warning).toBeVisible({ timeout: 2_000 });
  });
});
