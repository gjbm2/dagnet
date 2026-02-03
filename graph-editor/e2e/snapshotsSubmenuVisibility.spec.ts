/**
 * Snapshots submenu visibility regression test.
 *
 * Confirms:
 * - EdgeContextMenu "Snapshots" submenu opens on hover and stays within viewport.
 * - ⚡ LightningMenu "Snapshots" submenu opens on hover and stays within viewport.
 */
import { test, expect, Page } from '@playwright/test';

test.describe.configure({ timeout: 10_000 });

const TEST_GRAPH = {
  nodes: [
    { uuid: 'start', id: 'start', label: 'Start', entry: { is_start: true } },
    { uuid: 'B', id: 'B', label: 'B' },
    { uuid: 'C', id: 'C', label: 'C' },
  ],
  edges: [
    { uuid: 'edge-start-b', id: 'start->B', from: 'start', to: 'B', p: { id: 'param-1', mean: 0.3 } },
    { uuid: 'edge-start-c', id: 'start->C', from: 'start', to: 'C', p: { id: 'param-2', mean: 0.7 } },
  ],
  currentQueryDSL: 'window(27-Jan-26:3-Feb-26)',
  baseDSL: 'window(27-Jan-26:3-Feb-26)',
  metadata: { name: 'e2e-snapshots-submenu' },
};

async function installComputeAndSnapshotStubs(page: Page) {
  const handler = async (route: any) => {
    const url = route.request().url();
    try {
      if (url.includes('/api/snapshots/inventory')) {
        const body = route.request().postDataJSON?.() as any;
        const paramIds: string[] = Array.isArray(body?.param_ids) ? body.param_ids : [];
        const inventory: Record<string, any> = {};
        for (const pid of paramIds) {
          inventory[pid] = {
            has_data: true,
            param_id: pid,
            earliest: '2025-12-01',
            latest: '2025-12-10',
            row_count: 10,
            unique_days: 10,
            unique_slices: 1,
            unique_hashes: 1,
            unique_retrievals: 2,
          };
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, inventory }),
        });
      }

      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
    } catch (e) {
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: String(e) }) });
    }
  };

  await page.route('http://127.0.0.1:9000/**', handler);
  await page.route('http://localhost:9000/**', handler);
}

async function seedDbGraphTab(page: Page) {
  await page.evaluate(async (graphData) => {
    const db = (window as any).db;
    if (!db) throw new Error('db not available');

    await db.files.put({
      fileId: 'graph-e2e-snapshots-submenu',
      type: 'graph',
      viewTabs: [],
      data: graphData,
      source: { repository: 'repo-1', branch: 'main', path: 'graphs/e2e-snapshots-submenu.json' },
    });

    await db.tabs.put({
      id: 'tab-graph-1',
      fileId: 'graph-e2e-snapshots-submenu',
      viewMode: 'interactive',
      title: 'E2E Snapshots Submenu',
      icon: '',
      closable: true,
      group: 'main-content',
    });

    if (typeof db.saveAppState === 'function') {
      await db.saveAppState({ activeTabId: 'tab-graph-1', updatedAt: Date.now() });
    }
  }, TEST_GRAPH);
}

async function assertFullyWithinViewport(page: Page, locator: any) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, 'expected bounding box').toBeTruthy();
  const vp = page.viewportSize();
  expect(vp, 'expected viewport size').toBeTruthy();
  const pad = 0;
  const win = await page.evaluate(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio }));
  const right = box!.x + box!.width;
  const bottom = box!.y + box!.height;

  if (box!.x < 0 + pad || box!.y < 0 + pad || right > vp!.width - pad || bottom > vp!.height - pad) {
    throw new Error(
      `flyout not in viewport: box={x:${box!.x},y:${box!.y},w:${box!.width},h:${box!.height},right:${right},bottom:${bottom}} `
      + `viewport={w:${vp!.width},h:${vp!.height}} window={innerW:${win.innerWidth},innerH:${win.innerHeight},dpr:${win.devicePixelRatio}}`
    );
  }
}

test('Snapshots submenus open and stay within viewport', async ({ page, baseURL }) => {
  await installComputeAndSnapshotStubs(page);

  await page.goto(new URL('/?e2e=1', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
  await seedDbGraphTab(page);
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.locator('.react-flow')).toBeVisible({ timeout: 10_000 });

  // Select edge deterministically (needed for PropertiesPanel + consistent context menu state).
  await page.evaluate(() => {
    const e2e = (window as any).dagnetE2e;
    if (!e2e?.selectEdge) throw new Error('dagnetE2e.selectEdge not available');
    e2e.selectEdge('edge-start-b');
  });

  // -------------------------------------------------------------------
  // 1) EdgeContextMenu → Probability parameter → Snapshots submenu
  // -------------------------------------------------------------------
  await page.evaluate(() => {
    const e2e = (window as any).dagnetE2e;
    if (!e2e?.openEdgeContextMenu) throw new Error('dagnetE2e.openEdgeContextMenu not available');
    e2e.openEdgeContextMenu('edge-start-b', 320, 240);
  });

  await expect(page.getByText('Probability parameter', { exact: true })).toBeVisible();
  await page.getByText('Probability parameter', { exact: true }).hover();
  await expect(page.getByText('Snapshots', { exact: true })).toBeVisible();

  await page.getByText('Snapshots', { exact: true }).hover();
  const flyout1 = page.getByTestId('snapshots-flyout').first();
  await expect(page.getByText('Download snapshot data', { exact: true })).toBeVisible();
  // Critical regression: the flyout must remain open when moving into it.
  // This previously failed because the parent submenu closed immediately on mouseleave.
  const flyout1Box = await flyout1.boundingBox();
  expect(flyout1Box, 'expected flyout1 bounding box').toBeTruthy();
  await page.mouse.move(flyout1Box!.x + 10, flyout1Box!.y + 10);
  await page.waitForTimeout(250);
  await expect(page.getByText('Download snapshot data', { exact: true })).toBeVisible();
  await assertFullyWithinViewport(page, flyout1);

  // Close the edge context menu before testing the ⚡ menu path (avoid ambiguity between flyouts).
  await page.mouse.click(5, 5);
  await page.waitForTimeout(150);

  // -------------------------------------------------------------------
  // 2) ⚡ LightningMenu → Snapshots submenu
  // -------------------------------------------------------------------
  const propsPanel = page.locator('.properties-panel-wrapper').first();
  await expect(propsPanel).toBeVisible();

  const zapButton = propsPanel.locator('.lightning-menu-button').first();
  await zapButton.click();
  await expect(page.getByText('Put to file', { exact: true })).toBeVisible();

  await page.getByText('Snapshots', { exact: true }).hover();
  const flyout2 = page.getByTestId('snapshots-flyout').first();
  await expect(page.getByText('Download snapshot data', { exact: true })).toBeVisible();
  const flyout2Box = await flyout2.boundingBox();
  expect(flyout2Box, 'expected flyout2 bounding box').toBeTruthy();
  await page.mouse.move(flyout2Box!.x + 10, flyout2Box!.y + 10);
  await page.waitForTimeout(250);
  await expect(page.getByText('Download snapshot data', { exact: true })).toBeVisible();
  await assertFullyWithinViewport(page, flyout2);
});

