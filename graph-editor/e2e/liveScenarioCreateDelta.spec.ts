/**
 * Live scenario creation semantics E2E (DSL delta vs visible stack).
 *
 * Confirms "+" / `dagnet:newScenario` creates a live scenario whose meta.queryDSL is the
 * MECE delta between:
 * - S: effective visible stack fetch DSL (Base + visible live scenarios, excluding Current)
 * - C: Current DSL
 *
 * This specifically covers explicit clears:
 * - If Base has context()/asat() but Current does not, the new scenario must emit `context()` / `asat()`.
 */
import { test, expect, Page } from '@playwright/test';

test.describe.configure({ timeout: 15_000 });

const TEST_GRAPH = {
  nodes: [
    { uuid: 'start', id: 'start', label: 'Start', entry: { is_start: true } },
    { uuid: 'end', id: 'end', label: 'End' },
  ],
  edges: [
    { uuid: 'edge-1', id: 'start->end', from: 'start', to: 'end', p: { id: 'param-1', mean: 0.5 } },
  ],
  // Current: no context/asat
  currentQueryDSL: 'window(1-Nov-25:7-Nov-25)',
  // Base: has extra fetch axes that must be cleared by the new live scenario
  baseDSL: 'window(1-Nov-25:7-Nov-25).context(region:uk).asat(5-Nov-25)',
  metadata: { name: 'e2e-live-scenario-dsl-delta' },
};

async function installComputeStubs(page: Page) {
  const handler = async (route: any) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  };
  await page.route('http://127.0.0.1:9000/**', handler);
  await page.route('http://localhost:9000/**', handler);
}

async function seedDbGraphTab(page: Page) {
  await page.evaluate(async (graphData) => {
    const db = (window as any).db;
    if (!db) throw new Error('db not available');

    // Clean slate (important when reusing server locally).
    await db.scenarios.clear();
    await db.files.put({
      fileId: 'graph-e2e-live-scenario-dsl-delta',
      type: 'graph',
      viewTabs: [],
      data: graphData,
      source: { repository: 'repo-1', branch: 'main', path: 'graphs/e2e-live-scenario-dsl-delta.json' },
    });

    await db.tabs.put({
      id: 'tab-graph-live-delta',
      fileId: 'graph-e2e-live-scenario-dsl-delta',
      viewMode: 'interactive',
      title: 'E2E Live Scenario DSL Delta',
      icon: '',
      closable: true,
      group: 'main-content',
    });

    if (typeof db.saveAppState === 'function') {
      await db.saveAppState({ activeTabId: 'tab-graph-live-delta', updatedAt: Date.now() });
    }
  }, TEST_GRAPH);
}

async function pollForLiveScenarioQueryDSL(page: Page, timeoutMs: number): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await page.evaluate(async () => {
      const db = (window as any).db;
      const rows = db ? await db.scenarios.toArray() : [];
      const live = rows.filter((s: any) => s?.meta?.isLive);
      // Return the most recently created live scenario's queryDSL, if any.
      const last = live[live.length - 1] || null;
      return last?.meta?.queryDSL || null;
    });
    if (typeof res === 'string' && res.trim()) return res;
    await page.waitForTimeout(150);
  }
  throw new Error('Timed out waiting for live scenario creation');
}

test('create live scenario uses MECE delta (clears context/asat)', async ({ page, baseURL }) => {
  await installComputeStubs(page);

  await page.goto(new URL('/?e2e=1', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
  await seedDbGraphTab(page);
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.locator('.react-flow')).toBeVisible({ timeout: 10_000 });

  // Ensure ScenariosPanel is mounted (it registers the dagnet:newScenario listener).
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('dagnet:openScenariosPanel'));
  });
  await expect(page.locator('.scenarios-panel')).toBeVisible({ timeout: 5_000 });

  // Trigger "+" semantics deterministically.
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('dagnet:newScenario', { detail: { tabId: 'tab-graph-live-delta' } }));
  });

  const q = await pollForLiveScenarioQueryDSL(page, 5_000);
  expect(q).toBe('context().asat()');
});

