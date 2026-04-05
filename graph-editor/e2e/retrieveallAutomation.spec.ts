import { test, expect } from '@playwright/test';

/**
 * E2E: Retrieve-All Automation (?retrieveall) boot sequence and lifecycle.
 *
 * Tests the rebuilt automation pipeline:
 *   blank boot → upfront pull → enumerate/target → per-graph retrieve+commit → close
 *
 * Strategy:
 * - Seed IDB state (credentials, workspace, graphs) in an initial visit.
 * - Navigate with ?retrieveall=...&e2e=1 to trigger automation.
 * - Stub GitHub API so pull succeeds (returns same SHA — "already up to date").
 * - Stub compute server to no-op.
 * - Assert via IDB reads + session log + window.close spy.
 */

test.describe.configure({ timeout: 60_000 });

const REPO = 'repo-1';
const BRANCH = 'main';
const SEEDED_SHA = 'abc123deadbeef';

// Track which graph names are seeded so the GitHub tree stub can include them.
let seededGraphNames: string[] = [];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function installStubs(page: any) {
  // Compute server: no-op.
  const computeHandler = async (route: any) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  };
  await page.route('http://127.0.0.1:9000/**', computeHandler);
  await page.route('http://localhost:9000/**', computeHandler);

  // GitHub API: simulate "already up to date" by returning the same SHA we seeded.
  // This makes the pull short-circuit (remoteSHA === localSHA = no work).
  await page.route('https://api.github.com/**', async (route: any) => {
    const url = route.request().url() as string;
    const method = route.request().method();

    // GET /repos/:owner/:repo (used by auth check).
    if (method === 'GET' && url.match(/\/repos\/[^/]+\/[^/]+$/) && !url.includes('/git/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 1, name: REPO, full_name: `owner-1/${REPO}`, default_branch: BRANCH }),
      });
    }

    // GET /repos/:owner/:repo/branches/:branch — branch info with commit SHA.
    if (url.includes('/branches/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          name: BRANCH,
          commit: { sha: SEEDED_SHA },
        }),
      });
    }

    // GET /repos/:owner/:repo/git/ref/heads/:branch — ref with SHA.
    if (url.includes('/git/ref')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ref: `refs/heads/${BRANCH}`,
          object: { sha: SEEDED_SHA, type: 'commit' },
        }),
      });
    }

    // GET /repos/:owner/:repo/git/trees/:sha — return tree with seeded graph files.
    // The pull compares remote tree vs local SHAs. If a file is missing from the
    // tree, the pull treats it as "deleted remotely" and removes it from IDB.
    // So we MUST include our seeded graphs here.
    if (url.includes('/git/trees/')) {
      const treeEntries = seededGraphNames.map(name => ({
        path: `graphs/${name}.json`,
        mode: '100644',
        type: 'blob',
        sha: SEEDED_SHA, // Same SHA as local → no fetch needed
        size: 100,
      }));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sha: SEEDED_SHA, tree: treeEntries, truncated: false }),
      });
    }

    // GET /repos/:owner/:repo/git/commits/:sha — single commit (used by getRepositoryTree).
    if (url.includes('/git/commits/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sha: SEEDED_SHA,
          tree: { sha: SEEDED_SHA },
          message: 'seeded',
          parents: [],
        }),
      });
    }

    // GET /repos/:owner/:repo/commits — latest commits list.
    if (url.includes('/commits')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ sha: SEEDED_SHA, commit: { message: 'seeded' } }]),
      });
    }

    // Everything else: 200 empty object.
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });
}

function installWindowCloseSpy(page: any) {
  return page.addInitScript(() => {
    window.close = () => {
      (window as any).__dagnetWindowCloseCalled = true;
    };
  });
}

async function seedAllState(page: any, graphs: Array<{ name: string; dailyFetch?: boolean }>) {
  // Track for GitHub tree stub.
  seededGraphNames = graphs.map(g => g.name);

  await page.evaluate(async ({ repo, branch, sha, graphs }: any) => {
    const w = window as any;
    const db = w.db;
    if (!db) throw new Error('window.db missing');

    // Credentials.
    await db.files.put({
      fileId: 'credentials-credentials',
      type: 'credentials',
      data: {
        git: [{
          name: repo,
          owner: 'owner-1',
          repo: repo,
          token: 'fake-token',
          branch,
          isDefault: true,
        }],
      },
      isDirty: false,
      lastModified: Date.now(),
    });

    // Workspace record.
    const allFileIds: string[] = [];
    for (const g of graphs) {
      allFileIds.push(`graph-${g.name}`, `${repo}-${branch}-graph-${g.name}`);
    }
    await db.workspaces.put({
      id: `${repo}-${branch}`,
      repository: repo,
      branch,
      fileIds: allFileIds,
      lastSynced: Date.now(),
      commitSHA: sha,
    });

    // Graph files (both unprefixed and prefixed).
    for (const g of graphs) {
      const graphData = {
        nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} }],
        edges: [],
        policies: { startNodeId: 'start' },
        metadata: { created: '1-Jan-25', modified: '1-Jan-25' },
        dailyFetch: g.dailyFetch ?? false,
      };

      for (const fId of [`graph-${g.name}`, `${repo}-${branch}-graph-${g.name}`]) {
        await db.files.put({
          fileId: fId,
          type: 'graph',
          viewTabs: [],
          data: graphData,
          originalData: graphData,
          isDirty: false,
          sha: sha, // Must match the tree stub SHA so pull sees "no change"
          source: { repository: repo, branch, path: `graphs/${g.name}.json` },
          lastModified: Date.now(),
          lastSynced: Date.now(),
        });
      }
    }

    // App state — NO tabs, NO activeTabId. Blank boot.
    await db.appState.put({
      id: 'app-state',
      dockLayout: null,
      localItems: [],
      activeTabId: null,
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
  }, { repo: REPO, branch: BRANCH, sha: SEEDED_SHA, graphs });
}

async function waitForDb(page: any) {
  await expect
    .poll(async () => page.evaluate(() => !!(window as any).db))
    .toBeTruthy();
}

async function waitForAutomationComplete(page: any) {
  // Poll for the automation run log in IDB (persisted before window.close decision).
  await expect
    .poll(
      async () => page.evaluate(async () => {
        const db = (window as any).db;
        if (!db) return false;
        const logs = await db.automationRunLogs.toArray();
        return logs && logs.length > 0;
      }),
      { timeout: 45_000, intervals: [500] }
    )
    .toBeTruthy();
}

async function getAutomationLog(page: any) {
  return page.evaluate(async () => {
    const db = (window as any).db;
    if (!db) return null;
    const logs = await db.automationRunLogs.toArray();
    if (!logs || logs.length === 0) return null;
    return logs.sort((a: any, b: any) => b.timestamp - a.timestamp)[0];
  });
}

async function getSessionLogEntries(page: any): Promise<any[]> {
  return page.evaluate(() => {
    try {
      // sessionLogService is imported at module scope; access via window if exposed,
      // or via the global import. In dev mode, it's on the module graph.
      // Fallback: read from the automation log which captures entries.
      const sls = (window as any).__dagnetSessionLogService;
      if (sls?.getEntries) return sls.getEntries();
      return [];
    } catch {
      return [];
    }
  });
}

// ---------------------------------------------------------------------------
// Test 1: Blank boot
// ---------------------------------------------------------------------------

test('starts with zero tabs before automation begins', async ({ page, baseURL }) => {
  await installStubs(page);

  // Step 1: Seed IDB with NO tabs.
  await page.goto(new URL('/?e2e=1', baseURL).toString(), { waitUntil: 'domcontentloaded' });
  await waitForDb(page);
  await seedAllState(page, [{ name: 'test-graph' }]);
  await page.waitForTimeout(100);

  // Step 2: Verify zero tabs in IDB after seeding (before automation visit).
  const tabCountBeforeVisit = await page.evaluate(async () => {
    const db = (window as any).db;
    return await db.tabs.count();
  });
  expect(tabCountBeforeVisit).toBe(0);

  // Step 3: Navigate with ?retrieveall. Use addInitScript to capture tab count
  // at the moment TabContext init completes (before the automation job opens tabs).
  await page.addInitScript(() => {
    // Capture tab count the instant TabContext signals init done.
    window.addEventListener('dagnet:tabContextInitDone', async () => {
      try {
        const db = (window as any).db;
        if (db) {
          (window as any).__dagnetTabCountAtInitDone = await db.tabs.count();
        }
      } catch { /* best effort */ }
    }, { once: true });
  });

  await page.goto(
    new URL('/?retrieveall=test-graph&e2e=1', baseURL).toString(),
    { waitUntil: 'domcontentloaded' }
  );

  // Step 4: Wait for the init-done capture to fire.
  await expect
    .poll(
      async () => page.evaluate(() => (window as any).__dagnetTabCountAtInitDone !== undefined),
      { timeout: 15_000, intervals: [200] }
    )
    .toBeTruthy();

  // Step 5: Assert zero tabs at TabContext init completion.
  // Any tabs that exist AFTER this point were created by the automation job (which is correct).
  const tabCountAtInit = await page.evaluate(() => (window as any).__dagnetTabCountAtInitDone);
  expect(tabCountAtInit).toBe(0);
});

// ---------------------------------------------------------------------------
// Test 2: Pull before tabs
// ---------------------------------------------------------------------------

test('pull completes before any graph tab is opened', async ({ page, baseURL }) => {
  await installStubs(page);
  await installWindowCloseSpy(page);

  // Seed.
  await page.goto(new URL('/?e2e=1', baseURL).toString(), { waitUntil: 'domcontentloaded' });
  await waitForDb(page);
  await seedAllState(page, [{ name: 'test-graph' }]);
  await page.waitForTimeout(100);

  // Trigger automation.
  await page.goto(
    new URL('/?retrieveall=test-graph&e2e=1', baseURL).toString(),
    { waitUntil: 'domcontentloaded' }
  );

  // Wait for automation to complete.
  await waitForAutomationComplete(page);

  // Read the automation run log entries and check ordering.
  const log = await getAutomationLog(page);
  expect(log).not.toBeNull();

  // Find the pull entry and graph-start entry in the run log.
  const entries = log.entries as any[];
  const flatOps = entries.map((e: any) => e.operation);

  const pullIndex = flatOps.indexOf('DAILY_RETRIEVE_ALL_PRE_PULL');
  const graphStartIndex = flatOps.indexOf('DAILY_RETRIEVE_ALL_GRAPH_START');

  expect(pullIndex).toBeGreaterThanOrEqual(0);
  expect(graphStartIndex).toBeGreaterThanOrEqual(0);
  expect(pullIndex).toBeLessThan(graphStartIndex);
});

// ---------------------------------------------------------------------------
// Test 3: Enumeration mode
// ---------------------------------------------------------------------------

test('enumeration mode processes only dailyFetch graphs', async ({ page, baseURL }) => {
  await installStubs(page);
  await installWindowCloseSpy(page);

  // Seed two graphs: one enabled, one not.
  await page.goto(new URL('/?e2e=1', baseURL).toString(), { waitUntil: 'domcontentloaded' });
  await waitForDb(page);
  await seedAllState(page, [
    { name: 'enabled-graph', dailyFetch: true },
    { name: 'disabled-graph', dailyFetch: false },
  ]);
  await page.waitForTimeout(100);

  // Trigger enumeration mode (no graph name).
  await page.goto(
    new URL('/?retrieveall&e2e=1', baseURL).toString(),
    { waitUntil: 'domcontentloaded' }
  );

  await waitForAutomationComplete(page);

  const log = await getAutomationLog(page);
  expect(log).not.toBeNull();
  expect(log.graphs).toEqual(['enabled-graph']);
});

// ---------------------------------------------------------------------------
// Test 4: Explicit mode
// ---------------------------------------------------------------------------

test('explicit mode processes only named graphs', async ({ page, baseURL }) => {
  await installStubs(page);
  await installWindowCloseSpy(page);

  // Seed two graphs.
  await page.goto(new URL('/?e2e=1', baseURL).toString(), { waitUntil: 'domcontentloaded' });
  await waitForDb(page);
  await seedAllState(page, [
    { name: 'graph-a' },
    { name: 'graph-b' },
  ]);
  await page.waitForTimeout(100);

  // Trigger explicit mode for graph-a only.
  await page.goto(
    new URL('/?retrieveall=graph-a&e2e=1', baseURL).toString(),
    { waitUntil: 'domcontentloaded' }
  );

  await waitForAutomationComplete(page);

  const log = await getAutomationLog(page);
  expect(log).not.toBeNull();
  expect(log.graphs).toEqual(['graph-a']);
});

// ---------------------------------------------------------------------------
// Test 5: Window close
// ---------------------------------------------------------------------------

test('window.close() fires after completion and log is persisted', async ({ page, baseURL }) => {
  await installStubs(page);
  await installWindowCloseSpy(page);

  // Seed.
  await page.goto(new URL('/?e2e=1', baseURL).toString(), { waitUntil: 'domcontentloaded' });
  await waitForDb(page);
  await seedAllState(page, [{ name: 'test-graph' }]);
  await page.waitForTimeout(100);

  // Trigger automation.
  await page.goto(
    new URL('/?retrieveall=test-graph&e2e=1', baseURL).toString(),
    { waitUntil: 'domcontentloaded' }
  );

  // Wait for window.close() spy to fire.
  await expect
    .poll(
      async () => page.evaluate(() => (window as any).__dagnetWindowCloseCalled === true),
      { timeout: 45_000, intervals: [500] }
    )
    .toBeTruthy();

  // Verify log was persisted.
  const log = await getAutomationLog(page);
  expect(log).not.toBeNull();
  expect(log.graphs).toContain('test-graph');
  expect(['success', 'warning', 'error']).toContain(log.outcome);
  expect(log.entries.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Test 6: No-close mode
// ---------------------------------------------------------------------------

test('?noclose prevents window.close()', async ({ page, baseURL }) => {
  await installStubs(page);
  await installWindowCloseSpy(page);

  // Seed.
  await page.goto(new URL('/?e2e=1', baseURL).toString(), { waitUntil: 'domcontentloaded' });
  await waitForDb(page);
  await seedAllState(page, [{ name: 'test-graph' }]);
  await page.waitForTimeout(100);

  // Trigger automation WITH ?noclose.
  await page.goto(
    new URL('/?retrieveall=test-graph&e2e=1&noclose', baseURL).toString(),
    { waitUntil: 'domcontentloaded' }
  );

  // Wait for automation to complete (log persisted).
  await waitForAutomationComplete(page);

  // Wait a further 2 seconds to ensure close would have fired if it was going to.
  await page.waitForTimeout(2000);

  // Assert window.close was NOT called.
  const closeCalled = await page.evaluate(() => (window as any).__dagnetWindowCloseCalled === true);
  expect(closeCalled).toBe(false);
});
