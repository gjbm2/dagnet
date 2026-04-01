/**
 * Dashboard Auto-Pull & View Cycling E2E Test
 *
 * Verifies the full chain:
 *   git-remote-check job detects remote is ahead
 *   → non-blocking pull fires (countdown → execute)
 *   → graph file updated in FileRegistry + GraphStore
 *   → new canvasViews visible to dashboard cycling logic
 *
 * These tests are designed to go RED if the auto-pull pipeline is broken,
 * then guide the fix.
 */

import { test, expect, Page } from '@playwright/test';

test.describe.configure({ timeout: 45_000 });

// ============================================================================
// Fixtures
// ============================================================================

const LOCAL_COMMIT_SHA = 'sha_local_0000000000000000000000000000000000';
const REMOTE_COMMIT_SHA = 'sha_remote_1111111111111111111111111111111111';
const REMOTE_TREE_SHA = 'tree_remote_2222222222222222222222222222222222';

/** Graph as it exists locally (no canvasViews). */
const LOCAL_GRAPH = {
  nodes: [
    { uuid: 'n-a', id: 'step-a', label: 'Step A', entry: { is_start: true, weight: 1.0 } },
    { uuid: 'n-b', id: 'step-b', label: 'Step B', absorbing: true },
  ],
  edges: [
    { uuid: 'e1', id: 'a-to-b', from: 'n-a', to: 'n-b', p: { mean: 0.6 } },
  ],
  currentQueryDSL: 'window(-7d:)',
  baseDSL: 'window(-7d:)',
  metadata: { name: 'e2e-autopull-graph', version: '1.0.0' },
  canvasViews: [],
};

/** Graph as it exists on remote (has canvasViews). */
const REMOTE_GRAPH = {
  ...LOCAL_GRAPH,
  canvasViews: [
    {
      id: 'view-overview',
      name: 'Overview',
      states: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    {
      id: 'view-energy',
      name: 'Energy',
      states: [],
      viewport: { x: 100, y: 0, zoom: 1.2 },
    },
  ],
};

const GRAPH_FILE_ID = 'graph-e2e-autopull-graph';
const GRAPH_PATH = 'graphs/e2e-autopull-graph.json';
const TAB_ID = 'tab-e2e-autopull';
const WORKSPACE_ID = 'repo-1-main';

const REMOTE_GRAPH_BLOB_SHA = 'blob_graph_3333333333333333333333333333333333';

// ============================================================================
// Helpers
// ============================================================================

/** Seed IDB with workspace, graph file, and tab so the app boots with a graph open. */
async function seedWorkspace(page: Page) {
  await page.evaluate(async ({ localGraph, localSha, graphFileId, graphPath, tabId, workspaceId }) => {
    const db = (window as any).db;
    if (!db) throw new Error('db not available on window');

    // Workspace with known commitSHA
    await db.workspaces.put({
      id: workspaceId,
      repository: 'repo-1',
      branch: 'main',
      commitSHA: localSha,
      lastSynced: Date.now(),
    });

    // Graph file (unprefixed for FileRegistry)
    const fileState = {
      fileId: graphFileId,
      type: 'graph',
      name: 'e2e-autopull-graph.json',
      path: graphPath,
      data: localGraph,
      originalData: JSON.parse(JSON.stringify(localGraph)),
      isDirty: false,
      isLoaded: true,
      isLocal: false,
      viewTabs: [tabId],
      lastModified: Date.now(),
      sha: localSha,
      lastSynced: Date.now(),
      source: {
        repository: 'repo-1',
        path: graphPath,
        branch: 'main',
        commitHash: localSha,
      },
    };
    await db.files.put(fileState);

    // Prefixed copy (for workspace isolation)
    await db.files.put({ ...fileState, fileId: `repo-1-main-${graphFileId}` });

    // Tab
    await db.tabs.put({
      id: tabId,
      fileId: graphFileId,
      viewMode: 'interactive',
      title: 'Graph',
      icon: '',
      closable: true,
      group: 'main-content',
      editorState: {
        dashboardViewCycleMs: 5000,
        scenarioState: {
          scenarioOrder: ['current'],
          visibleScenarioIds: ['current'],
          visibleColourOrderIds: ['current'],
          visibilityMode: {},
        },
      },
    });

    // Credentials (seed into IDB so CredentialsManager finds them)
    await db.files.put({
      fileId: 'credentials-credentials',
      type: 'credentials',
      viewTabs: [],
      data: {
        version: '1.0.0',
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
      source: { repository: 'repo-1', branch: 'main', path: 'credentials' },
      isDirty: false,
      isLoaded: true,
      isLocal: false,
      lastModified: Date.now(),
      lastSynced: Date.now(),
    });

    // App state
    if (typeof db.saveAppState === 'function') {
      await db.saveAppState({ activeTabId: tabId, updatedAt: Date.now() });
    }
  }, {
    localGraph: LOCAL_GRAPH,
    localSha: LOCAL_COMMIT_SHA,
    graphFileId: GRAPH_FILE_ID,
    graphPath: GRAPH_PATH,
    tabId: TAB_ID,
    workspaceId: WORKSPACE_ID,
  });
}

/**
 * Install GitHub API stubs.
 *
 * Phase 1 ("local"): getRef returns LOCAL_COMMIT_SHA (remote matches local).
 * Phase 2 ("remote-ahead"): getRef returns REMOTE_COMMIT_SHA, tree/blob serve REMOTE_GRAPH.
 */
function createGitHubStubs() {
  let phase: 'local' | 'remote-ahead' = 'local';

  const install = async (page: Page) => {
    await page.route('https://api.github.com/**', async (route) => {
      const url = route.request().url();

      // getRef — branch HEAD SHA
      if (
        url.includes('/git/ref/heads/') ||
        url.includes('/git/ref/heads%2F') ||
        url.includes('/git/refs/heads/') ||
        url.includes('/git/refs/heads%2F')
      ) {
        const sha = phase === 'local' ? LOCAL_COMMIT_SHA : REMOTE_COMMIT_SHA;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ref: 'refs/heads/main',
            object: { sha, type: 'commit' },
          }),
        });
      }

      // getCommit — commit → tree SHA
      if (url.includes('/git/commits/')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            sha: REMOTE_COMMIT_SHA,
            tree: { sha: REMOTE_TREE_SHA },
          }),
        });
      }

      // getTree — repository tree
      if (url.includes('/git/trees/')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            sha: REMOTE_TREE_SHA,
            tree: [
              {
                path: GRAPH_PATH,
                mode: '100644',
                type: 'blob',
                sha: REMOTE_GRAPH_BLOB_SHA,
                size: JSON.stringify(REMOTE_GRAPH).length,
              },
            ],
            truncated: false,
          }),
        });
      }

      // getBlobContent — graph file content
      if (url.includes('/git/blobs/')) {
        const content = btoa(JSON.stringify(REMOTE_GRAPH));
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            sha: REMOTE_GRAPH_BLOB_SHA,
            content,
            encoding: 'base64',
            size: JSON.stringify(REMOTE_GRAPH).length,
          }),
        });
      }

      // Fallback: 404
      return route.fulfill({ status: 404, body: 'Not found' });
    });
  };

  return {
    install,
    setPhase: (p: 'local' | 'remote-ahead') => { phase = p; },
  };
}

/** Stub compute API so chart rendering doesn't error. */
async function stubComputeApi(page: Page) {
  await page.route('http://127.0.0.1:9000/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

/**
 * Clear the shouldCheckRemoteHead rate-limit in localStorage so the
 * git-remote-check job actually performs a network call.
 */
async function clearRemoteCheckRateLimit(page: Page) {
  await page.evaluate(() => {
    // Clear all staleness-related localStorage keys
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (
        key.includes('lastRemoteCheck') ||
        key.includes('lastPrompted') ||
        key.includes('dismissedRemoteSha') ||
        key.includes('snoozed')
      )) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
  });
}

// ============================================================================
// Tests
// ============================================================================

test.describe('Dashboard auto-pull pipeline', () => {

  test('DEFECT: dashboard mode must register staleness nudge jobs (useStalenessNudges not mounted)', async ({ page, baseURL }) => {
    // This test exercises the REAL dashboard code path — no manual wiring.
    // DashboardShell is rendered instead of MainAppShellContent.
    // useStalenessNudges (which registers the git-remote-check job) lives in
    // MainAppShellContent → so in dashboard mode the jobs are NEVER registered.
    const stubs = createGitHubStubs();
    await stubs.install(page);
    await stubComputeApi(page);
    stubs.setPhase('remote-ahead');

    await page.goto(new URL('/?e2e=1&dashboard=1&secret=test-secret', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    await seedWorkspace(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 10_000 });

    // Wait for boot to complete (if it ever does)
    await page.waitForTimeout(2000);

    // In the REAL dashboard code path, check if the job was registered
    const jobsState = await page.evaluate(() => {
      const scheduler = (window as any).__dagnet_jobScheduler;
      // getSnapshot returns a Map which doesn't serialise — use the internal jobs Map
      const internalJobs = (scheduler as any).jobs;
      const jobIds = internalJobs ? Array.from(internalJobs.keys()) : [];
      const hasGitRemoteCheck = jobIds.includes('git-remote-check');
      const bootComplete = scheduler.bootComplete;

      // Also check if nudge context has repository wired
      const ctx = (window as any).__dagnet_getNudgeContext?.();
      const hasRepo = !!ctx?.repository;
      const hasOnPullNeeded = typeof ctx?.onPullNeeded === 'function';

      return { jobIds, hasGitRemoteCheck, bootComplete, hasRepo, hasOnPullNeeded };
    });

    console.log('Dashboard mode job state:', JSON.stringify(jobsState, null, 2));

    // These assertions prove the defect:
    // In dashboard mode, useStalenessNudges is NOT mounted, so:
    expect(jobsState.hasGitRemoteCheck).toBe(true);    // FAILS: job never registered
    expect(jobsState.hasRepo).toBe(true);               // FAILS: nudge context never wired
    expect(jobsState.hasOnPullNeeded).toBe(true);        // FAILS: pull callback never set
  });


  test('git-remote-check job detects remote-ahead and triggers non-blocking pull', async ({ page, baseURL }) => {
    const stubs = createGitHubStubs();
    await stubs.install(page);
    await stubComputeApi(page);

    // Phase 1: remote matches local (no pull needed)
    stubs.setPhase('local');

    // Boot app with ?e2e and ?dashboard
    await page.goto(new URL('/?e2e=1&dashboard=1&secret=test-secret', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    await seedWorkspace(page);
    await page.reload({ waitUntil: 'domcontentloaded' });

    // Wait for app to boot (react-flow visible)
    await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 10_000 });

    // Verify local graph has no canvasViews
    const localViews = await page.evaluate((fileId) => {
      const store = (window as any).__dagnet_getGraphStore?.(fileId);
      if (!store) return null;
      return store.getState().graph?.canvasViews ?? [];
    }, GRAPH_FILE_ID);
    expect(localViews).toEqual([]);

    // Phase 2: remote is now ahead
    stubs.setPhase('remote-ahead');
    await clearRemoteCheckRateLimit(page);

    // Wait for the real useStalenessNudges hook to wire the nudge context
    // (now mounted in AppShellContent for all modes including dashboard)
    await expect.poll(async () => {
      return await page.evaluate(() => {
        const ctx = (window as any).__dagnet_getNudgeContext?.();
        return !!ctx?.repository && typeof ctx?.onPullNeeded === 'function';
      });
    }, { timeout: 5_000, message: 'Nudge context should be wired by useStalenessNudges' }).toBe(true);

    // Force-run the git-remote-check job (don't wait 30 minutes)
    await page.evaluate(async () => {
      (window as any).__dagnet_jobScheduler.run('git-remote-check');
      await new Promise(r => setTimeout(r, 500));
    });

    // Wait for canvasViews to appear in the graph store.
    // The real non-blocking pull has a 15-second countdown, then executes the pull.
    // After pull completes: IDB → FileRegistry → useFileState → setGraph → graphRef.current
    const viewsAfterPull = await expect.poll(async () => {
      return await page.evaluate((fileId) => {
        const store = (window as any).__dagnet_getGraphStore?.(fileId);
        if (!store) return [];
        return store.getState().graph?.canvasViews ?? [];
      }, GRAPH_FILE_ID);
    }, {
      timeout: 25_000,
      message: 'canvasViews should propagate to GraphStore after auto-pull',
    }).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'view-overview', name: 'Overview' }),
        expect.objectContaining({ id: 'view-energy', name: 'Energy' }),
      ])
    );
  });


  test('shouldCheckRemoteHead rate-limits block re-check within 30-minute window', async ({ page, baseURL }) => {
    await stubComputeApi(page);
    await page.goto(new URL('/?e2e=1&dashboard=1&secret=test-secret', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    await seedWorkspace(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 10_000 });

    // Directly test the rate-limit mechanism (no job execution needed)
    const results = await page.evaluate(() => {
      const svc = (window as any).__dagnet_stalenessNudgeService;
      const now = Date.now();

      // Clear any existing rate-limit
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.includes('lastRemoteCheck')) keysToRemove.push(key);
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));

      // Before marking: should allow check (no previous check recorded)
      const beforeMark = svc.shouldCheckRemoteHead('repo-1', 'main', now, localStorage);

      // Mark that we just checked
      svc.markRemoteHeadChecked('repo-1', 'main', now, localStorage);

      // Immediately after: should block (within 30-min window)
      const afterMark = svc.shouldCheckRemoteHead('repo-1', 'main', now, localStorage);

      // 5 minutes later: still blocked
      const after5Min = svc.shouldCheckRemoteHead('repo-1', 'main', now + 5 * 60 * 1000, localStorage);

      // 31 minutes later: should allow
      const after31Min = svc.shouldCheckRemoteHead('repo-1', 'main', now + 31 * 60 * 1000, localStorage);

      return { beforeMark, afterMark, after5Min, after31Min };
    });

    expect(results.beforeMark).toBe(true);   // No previous check → allow
    expect(results.afterMark).toBe(false);    // Just checked → block
    expect(results.after5Min).toBe(false);    // 5 min later → still block
    expect(results.after31Min).toBe(true);    // 31 min later → allow
  });


  test('document.hidden guard prevents git-remote-check from running', async ({ page, baseURL }) => {
    const stubs = createGitHubStubs();
    await stubs.install(page);
    await stubComputeApi(page);
    stubs.setPhase('remote-ahead');

    await page.goto(new URL('/?e2e=1&dashboard=1&secret=test-secret', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    await seedWorkspace(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 10_000 });

    // Register jobs + boot + nudge context
    await page.evaluate(() => {
      (window as any).__dagnet_registerStalenessNudgeJobs?.();
      const scheduler = (window as any).__dagnet_jobScheduler;
      if (!scheduler.bootComplete) scheduler.signalBootComplete();

      (window as any).__dagnet_updateNudgeContext({
        repository: 'repo-1',
        branch: 'main',
        isDashboardMode: true,
        navigatorIsLoading: false,
        suppressed: false,
        isShareLive: false,
        onPullNeeded: () => {},
      });
    });

    await clearRemoteCheckRateLimit(page);

    // Simulate document.hidden = true by overriding the property
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, writable: true, configurable: true });
    });

    // Run the job — it should bail out immediately because document.hidden is true
    await page.evaluate(async () => {
      await (window as any).__dagnet_jobScheduler.run('git-remote-check');
    });

    // Graph store should still have empty canvasViews (no pull happened)
    const views = await page.evaluate((fileId) => {
      const store = (window as any).__dagnet_getGraphStore?.(fileId);
      if (!store) return null;
      return store.getState().graph?.canvasViews ?? [];
    }, GRAPH_FILE_ID);

    expect(views).toEqual([]);

    // Restore document.hidden
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: false, writable: true, configurable: true });
    });
  });

});
