import { test, expect } from '@playwright/test';

/**
 * E2E: Automation window auto-close after ?retrieveall completes.
 *
 * Validates that window.close() is called after the automation finishes,
 * regardless of outcome (success, error, warning). Previously, non-success
 * outcomes kept the window open forever, blocking the next day's scheduled run.
 *
 * Strategy:
 * - Seed ALL required IDB state (credentials, workspace, graph, tab, appState)
 *   in a single visit BEFORE triggering automation.
 * - Navigate with ?retrieveall=<graph>&e2e=1 (e2e=1 shortens all delays).
 * - Spy on window.close() via addInitScript to prevent the page actually closing.
 * - Assert the spy was triggered (meaning the close logic fired).
 */
test.describe.configure({ timeout: 30_000 });

async function installStubs(page: any) {
  // Compute server: noop (automation calls Retrieve All).
  const computeHandler = async (route: any) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  };
  await page.route('http://127.0.0.1:9000/**', computeHandler);
  await page.route('http://localhost:9000/**', computeHandler);

  // GitHub API: return 500 for all calls. This makes the pull step fail
  // immediately, producing an 'error' outcome — which is exactly the scenario
  // that previously kept the window open forever.
  await page.route('https://api.github.com/**', async (route: any) => {
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'E2E stub: intentional failure' }),
    });
  });
}

async function seedAllState(page: any) {
  await page.evaluate(async () => {
    const w = window as any;
    const db = w.db;
    if (!db) throw new Error('window.db missing');

    const repo = 'repo-1';
    const branch = 'main';
    const fileId = 'graph-autoclose-e2e';
    const prefixedFileId = `${repo}-${branch}-${fileId}`;

    const graphData = {
      nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
      policies: { startNodeId: 'start' },
      metadata: { created: '1-Jan-25', modified: '1-Jan-25' },
    };

    // Graph files (both unprefixed and prefixed).
    for (const fId of [fileId, prefixedFileId]) {
      await db.files.put({
        fileId: fId,
        type: 'graph',
        viewTabs: [],
        data: graphData,
        originalData: graphData,
        isDirty: false,
        source: { repository: repo, branch, path: 'graphs/autoclose-e2e.json' },
        lastModified: Date.now(),
        lastSynced: Date.now(),
      });
    }

    // Tab.
    await db.tabs.put({
      id: 'tab-graph-autoclose',
      fileId,
      viewMode: 'interactive',
      title: 'autoclose-e2e',
      icon: '',
      closable: true,
      group: 'main-content',
      editorState: {
        sidebarOpen: true,
        propertiesOpen: false,
        scenarioState: {
          scenarioOrder: ['current'],
          visibleScenarioIds: ['current'],
          visibleColourOrderIds: ['current'],
          selectedScenarioId: undefined,
        },
      },
    });

    // Credentials — required for NavigatorContext boot.
    await db.files.put({
      fileId: 'credentials-credentials',
      type: 'credentials',
      data: {
        git: [{
          name: repo,
          owner: 'test-owner',
          repo: repo,
          token: 'fake-token',
          branch,
          isDefault: true,
        }],
      },
      isDirty: false,
      lastModified: Date.now(),
    });

    // Workspace record — prevents navigator from attempting a clone.
    await db.workspaces.put({
      id: `${repo}-${branch}`,
      repository: repo,
      branch,
      fileIds: [fileId, prefixedFileId],
      lastSynced: Date.now(),
    });

    // App state.
    await db.appState.put({
      id: 'app-state',
      dockLayout: null,
      localItems: [],
      activeTabId: 'tab-graph-autoclose',
      navigatorState: {
        isOpen: true,
        isPinned: true,
        searchQuery: '',
        selectedRepo: repo,
        selectedBranch: branch,
        expandedSections: ['graphs'],
        availableRepos: [repo],
        availableBranches: [branch],
        viewMode: 'all',
        showLocalOnly: false,
        showDirtyOnly: false,
        showOpenOnly: false,
        sortBy: 'name',
        groupBySubCategories: true,
        groupByTags: false,
      },
      updatedAt: Date.now(),
    });
  });
}

test('window.close() is called after automation finishes with error outcome', async ({ page, baseURL }) => {
  await installStubs(page);

  // Spy on window.close() — runs before any page JS, so it is always in place.
  await page.addInitScript(() => {
    window.close = () => {
      (window as any).__dagnetWindowCloseCalled = true;
    };
  });

  // Step 1: Seed IDB. Visit without ?retrieveall so automation doesn't trigger.
  // All state (credentials, workspace, graph, tab, appState) is seeded in one go
  // so the CredentialsManager cache is populated correctly on the automation visit.
  await page.goto(new URL('/?e2e=1', baseURL).toString(), { waitUntil: 'domcontentloaded' });
  await expect
    .poll(async () => page.evaluate(() => !!(window as any).db))
    .toBeTruthy();
  await seedAllState(page);
  await page.waitForTimeout(200);

  // Step 2: Navigate with ?retrieveall to trigger automation.
  // Full page reload clears all module singletons. The app boots fresh with
  // all IDB state already present — credentials, workspace, graph, tab.
  // The pull step will fail (GitHub stubbed to 500) → error outcome.
  // With ?e2e=1 all delays are shortened (start: 0ms, close: 500ms).
  await page.goto(
    new URL('/?retrieveall=autoclose-e2e&e2e=1', baseURL).toString(),
    { waitUntil: 'domcontentloaded' }
  );

  // Step 3: Wait for window.close() spy to fire.
  // Budget: app boot (~2-4s) + job waitForAppReady + automation fail + close delay (500ms).
  await expect
    .poll(
      async () => page.evaluate(() => (window as any).__dagnetWindowCloseCalled === true),
      { timeout: 20_000, intervals: [500] }
    )
    .toBeTruthy();

  // Step 4: Verify automation log was persisted to IDB.
  const idbResult = await page.evaluate(async () => {
    const db = (window as any).db;
    if (!db) return { found: false };
    const logs = await db.automationRunLogs.toArray();
    if (!logs || logs.length === 0) return { found: false };
    // Find the most recent run.
    const latest = logs.sort((a: any, b: any) => b.timestamp - a.timestamp)[0];
    return {
      found: true,
      outcome: latest.outcome,
      graphs: latest.graphs,
    };
  });

  expect(idbResult.found).toBe(true);
  // The pull failure should produce an error or warning outcome.
  expect(['error', 'warning']).toContain(idbResult.outcome);
});
