import { test, expect } from '@playwright/test';

// Brisk but resilient to CI slowness: this spec should complete quickly, but cap it hard.
test.describe.configure({ timeout: 20_000 });

async function installNoopComputeStub(page: any) {
  const handler = async (route: any) => {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  };
  await page.route('http://127.0.0.1:9000/**', handler);
  await page.route('http://localhost:9000/**', handler);
}

async function seedDailyFetchWorkspace(page: any) {
  await page.evaluate(async () => {
    const w: any = window as any;
    const db = w.db;
    if (!db) throw new Error('window.db missing');

    const repo = 'repo-1';
    const branch = 'main';
    const fileId = 'graph-dailyfetch-e2e';
    const prefixedFileId = `${repo}-${branch}-${fileId}`;

    const graphData = {
      nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
      policies: { startNodeId: 'start' },
      metadata: { created: '1-Jan-25', modified: '1-Jan-25' },
      dataInterestsDSL: 'context(channel)',
      dailyFetch: false,
    };

    // Seed BOTH unprefixed and prefixed variants (this is the real bug class).
    await db.files.put({
      fileId,
      type: 'graph',
      viewTabs: [],
      data: graphData,
      originalData: graphData,
      isDirty: false,
      source: { repository: repo, branch, path: 'graphs/dailyfetch-e2e.json' },
      lastModified: Date.now(),
      lastSynced: Date.now(),
    });
    await db.files.put({
      fileId: prefixedFileId,
      type: 'graph',
      viewTabs: [],
      data: graphData,
      originalData: graphData,
      isDirty: false,
      source: { repository: repo, branch, path: 'graphs/dailyfetch-e2e.json' },
      lastModified: Date.now(),
      lastSynced: Date.now(),
    });

    // Seed an open graph tab so the UI is ready without any network fetch.
    await db.tabs.put({
      id: 'tab-graph-1',
      fileId,
      viewMode: 'interactive',
      title: 'dailyfetch-e2e',
      icon: '',
      closable: true,
      group: 'main-content',
      editorState: {
        sidebarOpen: true,
        propertiesOpen: true,
        scenarioState: {
          scenarioOrder: ['current'],
          visibleScenarioIds: ['current'],
          visibleColourOrderIds: ['current'],
          selectedScenarioId: undefined,
        },
      },
    });

    // Persist app-state deterministically (upsert). Avoid calling db.initialize() here to prevent
    // racy duplicate inserts with the app's own init path.
    await db.appState.put({
      id: 'app-state',
      dockLayout: null,
      localItems: [],
      activeTabId: 'tab-graph-1',
      navigatorState: {
        isOpen: true,
        isPinned: true,
        searchQuery: '',
        selectedRepo: repo,
        selectedBranch: branch,
        expandedSections: ['graphs'],
        availableRepos: [],
        availableBranches: [],
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

async function clickByBoundingBox(page: any, locator: any): Promise<void> {
  // Avoid flake when React re-renders and Playwright thinks the element is unstable.
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await expect(locator).toBeVisible();
      const box = await locator.boundingBox();
      if (!box) throw new Error('no bounding box');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      return;
    } catch (e) {
      if (attempt === maxAttempts - 1) throw e;
      await page.waitForTimeout(50);
    }
  }
}

test('bulk modal toggles dailyFetch and pinned modal reflects it (persists to IndexedDB)', async ({ page, baseURL }) => {
  await installNoopComputeStub(page);

  // IMPORTANT: Do NOT provide ?secret here.
  // This test is intended to be IDB-driven and must not depend on GitHub/network.
  await page.goto(new URL('/?e2e=1', baseURL).toString(), { waitUntil: 'domcontentloaded' });

  await seedDailyFetchWorkspace(page);
  // Small settle: ensure IndexedDB writes have committed before we reload to restore tabs.
  await page.waitForTimeout(50);
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.locator('.react-flow')).toBeVisible({ timeout: 10_000 });

  // Open Data menu → Automated Daily Fetches...
  await page.locator('.menubar-trigger', { hasText: /^Data$/ }).click();
  await page.getByRole('menuitem', { name: 'Automated Daily Fetches...' }).click();

  // Select our graph on the left and move it to enabled
  await page.getByText('Available Graphs').waitFor();
  const row = page.locator('label', { hasText: 'dailyfetch-e2e' }).first();
  await clickByBoundingBox(page, row);
  const moveBtn = page.locator('button[title="Move selected to Daily Fetch"]').first();
  await expect(moveBtn).toBeEnabled();
  await clickByBoundingBox(page, moveBtn);
  await page.getByRole('button', { name: /Save Changes/ }).click();

  // Open pinned modal and confirm checkbox is checked
  await page.locator('.window-selector-unroll-toggle').click();
  await page.getByRole('button', { name: /Pinned query/i }).click();
  await expect(page.getByText('Pinned Data Interests')).toBeVisible();
  const fetchDailyCheckbox = page.locator('label:has-text("Fetch daily") input[type="checkbox"]');
  await expect(fetchDailyCheckbox).toBeChecked();

  // Confirm persistence: dailyFetch is written to IndexedDB for BOTH variants (prefixed + unprefixed).
  await expect
    .poll(async () => {
      return await page.evaluate(async () => {
        const db: any = (window as any).db;
        if (!db) return { ok: false, reason: 'no-db' };
        const repo = 'repo-1';
        const branch = 'main';
        const fileId = 'graph-dailyfetch-e2e';
        const prefixedFileId = `${repo}-${branch}-${fileId}`;

        const a = await db.files.get(fileId);
        const b = await db.files.get(prefixedFileId);
        return {
          ok: Boolean(a?.data?.dailyFetch) && Boolean(b?.data?.dailyFetch),
          aDailyFetch: a?.data?.dailyFetch,
          bDailyFetch: b?.data?.dailyFetch,
          aDirty: a?.isDirty,
          bDirty: b?.isDirty,
        };
      });
    })
    .toMatchObject({ ok: true });
});

