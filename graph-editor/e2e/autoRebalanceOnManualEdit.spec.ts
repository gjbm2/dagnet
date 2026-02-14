/**
 * Auto-rebalance on manual p.mean commit (ergonomic regression test)
 *
 * Expected behaviour:
 * - When the user commits a manual edit to an edge's p.mean, sibling edges from the same
 *   source node should rebalance automatically (unless overridden/locked).
 *
 * Coverage:
 * - PropertiesPanel (edge props)
 * - EdgeContextMenu (right-click menu)
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
    { uuid: 'edge-start-b', id: 'start->B', from: 'start', to: 'B', p: { mean: 0.3 } },
    { uuid: 'edge-start-c', id: 'start->C', from: 'start', to: 'C', p: { mean: 0.7 } },
  ],
  currentQueryDSL: 'window(27-Jan-26:3-Feb-26)',
  baseDSL: 'window(27-Jan-26:3-Feb-26)',
  metadata: { name: 'e2e-auto-rebalance' },
};

async function installComputeStubs(page: Page) {
  // Prevent failures if the app tries to call the compute backend during boot.
  await page.route('http://127.0.0.1:9000/**', (route) => {
    return route.fulfill({ status: 200, body: JSON.stringify({ success: true }) });
  });
}

async function seedDbGraphTab(page: Page) {
  await page.evaluate(async (graphData) => {
    const db = (window as any).db;
    if (!db) throw new Error('db not available');

    // Seed the graph file into IndexedDB.
    await db.files.put({
      fileId: 'graph-e2e-auto-rebalance',
      type: 'graph',
      viewTabs: [],
      data: graphData,
      source: { repository: 'repo-1', branch: 'main', path: 'graphs/e2e-auto-rebalance.json' },
    });

    // Open a tab for the graph and make it active.
    await db.tabs.put({
      id: 'tab-graph-1',
      fileId: 'graph-e2e-auto-rebalance',
      viewMode: 'interactive',
      title: 'E2E Auto Rebalance',
      icon: '',
      closable: true,
      group: 'main-content',
    });

    if (typeof db.saveAppState === 'function') {
      await db.saveAppState({ activeTabId: 'tab-graph-1', updatedAt: Date.now() });
    }
  }, TEST_GRAPH);
}

async function getEdgeMeans(page: Page): Promise<{ ab: number; ac: number; abOverridden: boolean; acOverridden: boolean }> {
  return page.evaluate(async () => {
    // Prefer in-memory FileRegistry (updates immediately on setGraph),
    // fall back to IndexedDB (may lag due to async store→file sync).
    const fileRegistry = (window as any).fileRegistry;
    const mem = fileRegistry?.getFile?.('graph-e2e-auto-rebalance')?.data;
    const edges = mem?.edges
      || (await (window as any).db?.files?.get?.('graph-e2e-auto-rebalance'))?.data?.edges
      || [];
    const ab = edges.find((e: any) => e.uuid === 'edge-start-b')?.p?.mean ?? null;
    const ac = edges.find((e: any) => e.uuid === 'edge-start-c')?.p?.mean ?? null;
    const abOverridden = edges.find((e: any) => e.uuid === 'edge-start-b')?.p?.mean_overridden === true;
    const acOverridden = edges.find((e: any) => e.uuid === 'edge-start-c')?.p?.mean_overridden === true;
    return { ab, ac, abOverridden, acOverridden };
  });
}

async function getEdgeDescription(page: Page): Promise<{ desc: string; overridden: boolean }> {
  return page.evaluate(async () => {
    const fileRegistry = (window as any).fileRegistry;
    const mem = fileRegistry?.getFile?.('graph-e2e-auto-rebalance')?.data;
    const edges = mem?.edges
      || (await (window as any).db?.files?.get?.('graph-e2e-auto-rebalance'))?.data?.edges
      || [];
    const edge = edges.find((e: any) => e.uuid === 'edge-start-b') || null;
    return {
      desc: edge?.description || '',
      overridden: edge?.description_overridden === true,
    };
  });
}

test.describe('auto-rebalance on manual commit', () => {
  test('PropertiesPanel + EdgeContextMenu: manual commit rebalances siblings (normal mode)', async ({ page, baseURL }) => {
    await installComputeStubs(page);

    await page.goto(new URL('/?e2e=1', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    await seedDbGraphTab(page);
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(page.locator('.react-flow')).toBeVisible({ timeout: 10_000 });

    // ---------------------------------------------------------------------
    // 1) PropertiesPanel commit
    // ---------------------------------------------------------------------
    await page.evaluate(() => {
      const e2e = (window as any).dagnetE2e;
      if (!e2e?.selectEdge) throw new Error('dagnetE2e.selectEdge not available');
      e2e.selectEdge('edge-start-b');
    });

    const propsPanel = page.locator('.properties-panel, [data-testid="properties-panel"]').first();
    await expect(propsPanel).toBeVisible({ timeout: 10_000 });

    const propsProbInput = propsPanel.locator('.probability-input input[type="text"]').first();
    await expect(propsProbInput).toBeVisible();
    await propsProbInput.fill('0.6');
    await propsProbInput.press('Enter');

    // Validate: origin edge overridden, sibling edge rebalanced to 0.4 (and not overridden).
    // NOTE: store→fileRegistry sync is async; poll briefly for the updated graph snapshot.
    await expect
      .poll(async () => (await getEdgeMeans(page)).ab, { timeout: 1500 })
      .toBeCloseTo(0.6, 3);
    await expect
      .poll(async () => (await getEdgeMeans(page)).ac, { timeout: 1500 })
      .toBeCloseTo(0.4, 3);
    await expect
      .poll(async () => (await getEdgeMeans(page)).abOverridden, { timeout: 1500 })
      .toBe(true);
    await expect
      .poll(async () => (await getEdgeMeans(page)).acOverridden, { timeout: 1500 })
      .toBe(false);

    // ---------------------------------------------------------------------
    // 3) Edge description: blur commit persists (regression guard)
    // ---------------------------------------------------------------------
    const desc = 'hello description 123';
    const descInput = propsPanel.locator('textarea[placeholder="Edge description..."]').first();
    await expect(descInput).toBeVisible({ timeout: 2_000 });
    await descInput.fill(desc);
    await descInput.blur();

    await expect
      .poll(async () => (await getEdgeDescription(page)).desc, { timeout: 1500 })
      .toBe(desc);
    await expect
      .poll(async () => (await getEdgeDescription(page)).overridden, { timeout: 1500 })
      .toBe(true);

    // ---------------------------------------------------------------------
    // 2) EdgeContextMenu commit
    // ---------------------------------------------------------------------
    await page.evaluate(() => {
      const e2e = (window as any).dagnetE2e;
      if (!e2e?.openEdgeContextMenu) throw new Error('dagnetE2e.openEdgeContextMenu not available');
      e2e.openEdgeContextMenu('edge-start-b', 200, 200);
    });

    const menu = page.locator('.dagnet-popup').first();
    await expect(menu).toBeVisible({ timeout: 2_000 });

    const probInput = menu.locator('.probability-input input[type="text"]').first();
    await expect(probInput).toBeVisible({ timeout: 2_000 });
    await probInput.fill('0.2');
    await probInput.press('Enter');

    // Validate rebalance: 0.2 + 0.8 = 1.0. Sibling remains non-overridden.
    await expect
      .poll(async () => (await getEdgeMeans(page)).ab, { timeout: 1500 })
      .toBeCloseTo(0.2, 3);
    await expect
      .poll(async () => (await getEdgeMeans(page)).ac, { timeout: 1500 })
      .toBeCloseTo(0.8, 3);
    await expect
      .poll(async () => (await getEdgeMeans(page)).abOverridden, { timeout: 1500 })
      .toBe(true);
    await expect
      .poll(async () => (await getEdgeMeans(page)).acOverridden, { timeout: 1500 })
      .toBe(false);
  });
});

