/**
 * Graph canvas click → tab focus (regression test)
 *
 * When the user clicks inside a graph canvas, the graph tab should become the
 * active (focused) tab.  This matters because many menu items (e.g. Data >
 * Retrieve All Slices) are enabled/disabled based on `activeTabId`.
 *
 * Prior to the fix, the ReactFlow wrapper div had no pointer-down handler, so
 * clicking the canvas did not call `switchTab`.  The handler now uses the
 * context-sourced `activeTabIdContext` (not the prop, which can be stale due to
 * a useMemo closure in GraphEditor).
 */
import { test, expect, Page } from '@playwright/test';

test.describe.configure({ timeout: 15_000 });

const TEST_GRAPH = {
  nodes: [
    { uuid: 'n1', id: 'n1', label: 'Start', entry: { is_start: true } },
    { uuid: 'n2', id: 'n2', label: 'End' },
  ],
  edges: [
    { uuid: 'e1', id: 'n1->n2', from: 'n1', to: 'n2', p: { mean: 1.0 } },
  ],
  currentQueryDSL: 'window(27-Jan-26:3-Feb-26)',
  baseDSL: 'window(27-Jan-26:3-Feb-26)',
  metadata: { name: 'e2e-tab-focus' },
};

async function installComputeStubs(page: Page) {
  await page.route('http://127.0.0.1:9000/**', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ success: true }) }),
  );
}

/**
 * Seed two tabs: a graph tab and a session-log tab.
 * The session-log tab is set as active so the graph tab is NOT focused on boot.
 */
async function seedTwoTabs(page: Page) {
  await page.evaluate(async (graphData) => {
    const db = (window as any).db;
    if (!db) throw new Error('db not available');

    // Graph file + tab
    await db.files.put({
      fileId: 'graph-e2e-tab-focus',
      type: 'graph',
      viewTabs: ['tab-graph'],
      data: graphData,
      source: { repository: 'repo-1', branch: 'main', path: 'graphs/e2e-tab-focus.json' },
    });
    await db.tabs.put({
      id: 'tab-graph',
      fileId: 'graph-e2e-tab-focus',
      viewMode: 'interactive',
      title: 'Graph',
      icon: '',
      closable: true,
      group: 'main-content',
    });

    // Session-log tab (lightweight — no file needed for a built-in view)
    await db.tabs.put({
      id: 'tab-session-log',
      fileId: 'session-log',
      viewMode: 'default',
      title: 'Session Log',
      icon: '',
      closable: true,
      group: 'main-content',
    });

    // Make the session-log tab active so the graph tab is NOT focused.
    if (typeof db.saveAppState === 'function') {
      await db.saveAppState({ activeTabId: 'tab-session-log', updatedAt: Date.now() });
    }
  }, TEST_GRAPH);
}

/** Read the current activeTabId from IndexedDB (source of truth). */
async function getActiveTabId(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const db = (window as any).db;
    if (!db?.getAppState) return null;
    const state = await db.getAppState();
    return state?.activeTabId ?? null;
  });
}

test.describe('graph canvas tab focus', () => {
  test('clicking the graph canvas activates the graph tab', async ({ page, baseURL }) => {
    await installComputeStubs(page);

    await page.goto(new URL('/?e2e=1', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    await seedTwoTabs(page);
    await page.reload({ waitUntil: 'domcontentloaded' });

    // Wait for the app to boot fully — the graph canvas will render once the
    // graph tab becomes visible.  Because we seeded the session-log tab as
    // active, the graph canvas may not be immediately visible; click the graph
    // tab header first to make it visible.

    // 1. Verify the session-log tab is active on boot.
    await page.waitForTimeout(1_000); // allow React hydration
    const initialActive = await getActiveTabId(page);
    // Session-log may or may not be the initial active (rc-dock can override);
    // the important thing is to test the click-to-focus path below.

    // 2. Click the graph tab header to make the canvas visible.
    //    rc-dock renders tab titles inside `.dock-tab` elements.
    const graphTabHeader = page.locator('.dock-tab', { hasText: 'Graph' }).first();
    // If the graph tab header is visible, click it to activate the graph.
    if (await graphTabHeader.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await graphTabHeader.click();
      await expect(page.locator('.react-flow')).toBeVisible({ timeout: 5_000 });
    } else {
      // Fallback: switch via custom event
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('dagnet:switchToTab', { detail: { tabId: 'tab-graph' } }));
      });
      await expect(page.locator('.react-flow')).toBeVisible({ timeout: 5_000 });
    }

    // 3. Now switch AWAY from the graph tab (back to session log).
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('dagnet:switchToTab', { detail: { tabId: 'tab-session-log' } }));
    });
    // Wait for React to process the tab switch.
    await page.waitForTimeout(500);

    // Confirm active tab is now the session log.
    const afterSwitch = await getActiveTabId(page);
    expect(afterSwitch).toBe('tab-session-log');

    // 4. Click inside the graph canvas (it may still be visible if in a
    //    separate rc-dock panel, or rendered but inactive in the same panel).
    const reactFlow = page.locator('.react-flow').first();
    const canvasVisible = await reactFlow.isVisible({ timeout: 1_000 }).catch(() => false);

    if (canvasVisible) {
      // The graph canvas IS still visible (multi-panel or rc-dock keeps it
      // mounted).  Click it — this should activate the graph tab.
      await reactFlow.click({ force: true });
      await page.waitForTimeout(500);

      const afterClick = await getActiveTabId(page);
      expect(afterClick).toBe('tab-graph');
    } else {
      // Single-panel layout: the canvas is hidden when session-log is active.
      // Switch back to graph and verify clicking the canvas keeps it focused.
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('dagnet:switchToTab', { detail: { tabId: 'tab-graph' } }));
      });
      await expect(reactFlow).toBeVisible({ timeout: 5_000 });

      // Now deliberately switch away via IDB only (simulating a desync where
      // React state still shows the graph but activeTabId changed).
      await page.evaluate(async () => {
        const db = (window as any).db;
        await db.saveAppState({ activeTabId: 'tab-session-log' });
      });

      // Click the canvas — the onPointerDown handler reads from context
      // (which tracks the IDB-sourced activeTabId after the next sync).
      await reactFlow.click({ force: true });
      await page.waitForTimeout(500);

      // The graph tab should be active (handler called switchTab).
      const afterClick = await getActiveTabId(page);
      expect(afterClick).toBe('tab-graph');
    }
  });
});
