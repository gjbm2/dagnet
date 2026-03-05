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
  metadata: { name: 'e2e-postit-autoedit' },
};

async function installComputeStubs(page: Page) {
  await page.route('http://127.0.0.1:9000/**', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ success: true }) }),
  );
}

async function seedSingleGraphTab(page: Page) {
  await page.evaluate(async (graphData) => {
    const db = (window as any).db;
    if (!db) throw new Error('db not available');

    await db.files.put({
      fileId: 'graph-e2e-postit-autoedit',
      type: 'graph',
      viewTabs: ['tab-graph'],
      data: graphData,
      source: { repository: 'repo-1', branch: 'main', path: 'graphs/e2e-postit-autoedit.json' },
    });

    await db.tabs.put({
      id: 'tab-graph',
      fileId: 'graph-e2e-postit-autoedit',
      viewMode: 'interactive',
      title: 'Graph',
      icon: '',
      closable: true,
      group: 'main-content',
    });

    if (typeof db.saveAppState === 'function') {
      await db.saveAppState({ activeTabId: 'tab-graph', updatedAt: Date.now() });
    }
  }, TEST_GRAPH);
}

test.describe('post-it auto-edit', () => {
  test('new post-it is selected and editor is focused', async ({ page, baseURL }) => {
    await installComputeStubs(page);

    await page.goto(new URL('/?e2e=1', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    await seedSingleGraphTab(page);
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 8_000 });

    // Create the post-it via the same custom event used by menus/palette fallbacks.
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('dagnet:addPostit'));
    });

    const postitNode = page.locator('.react-flow__node-postit').first();
    await expect(postitNode).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.react-flow__node-postit.selected').first()).toBeVisible({ timeout: 5_000 });

    const editor = postitNode.locator('[contenteditable="true"]').first();
    await expect(editor).toBeVisible({ timeout: 5_000 });
    await expect(editor).toBeFocused({ timeout: 5_000 });

    await editor.type('Hello post-it');
    await expect(postitNode).toContainText('Hello post-it');
  });
});

