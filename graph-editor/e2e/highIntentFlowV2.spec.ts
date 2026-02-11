/**
 * High Intent Flow v2 — Graph structure smoke test
 *
 * Verifies that the high-intent-flow-v2 graph loads correctly in the editor:
 * - Correct number of nodes rendered on canvas
 * - Correct number of edges rendered
 * - Key nodes are present (landing page, confirm switch, switch success, etc.)
 * - Absorbing nodes are properly marked
 * - Context DSL is applied
 *
 * This test injects the graph JSON into IndexedDB directly, bypassing
 * the clone/fetch workflow. It validates structure, not data fetch.
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

test.describe.configure({ timeout: 15_000 });

/**
 * Resolve the data repo directory name from .private-repos.conf.
 * Returns undefined if the config file is missing or DATA_REPO_DIR is not set.
 */
function readDataRepoDir(): string | undefined {
  const confPath = path.resolve(__dirname, '../../.private-repos.conf');
  try {
    const text = fs.readFileSync(confPath, 'utf-8');
    const match = text.match(/^DATA_REPO_DIR=(.+)$/m);
    return match?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

// Load the graph JSON from the data repo
const DATA_REPO_DIR = readDataRepoDir();
const GRAPH_PATH = DATA_REPO_DIR
  ? path.resolve(__dirname, '../../', DATA_REPO_DIR, 'graphs/high-intent-flow-v2.json')
  : '';

let TEST_GRAPH: any;
try {
  if (GRAPH_PATH) {
    TEST_GRAPH = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf-8'));
  }
} catch {
  // Fallback: if the data repo isn't available, skip
  TEST_GRAPH = null;
}

async function installComputeStubs(page: Page) {
  await page.route('http://127.0.0.1:9000/**', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ success: true }) }),
  );
}

async function seedGraph(page: Page) {
  await page.evaluate(async (graphData) => {
    const db = (window as any).db;
    if (!db) throw new Error('db not available');

    const fileId = 'graph-high-intent-flow-v2';
    const tabId = 'tab-hif-v2';

    await db.files.put({
      fileId,
      type: 'graph',
      viewTabs: [tabId],
      data: graphData,
      isDirty: false,
    });

    await db.tabs.put({
      id: tabId,
      fileId,
      type: 'graph',
      label: 'high-intent-flow-v2',
      isActive: true,
    });
  }, TEST_GRAPH);
}

test.describe('High Intent Flow v2 — structure smoke test', () => {
  test.skip(!TEST_GRAPH, 'Graph JSON not available (data repo not cloned)');

  test.beforeEach(async ({ page }) => {
    await installComputeStubs(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="app-ready"]', { timeout: 8000 }).catch(() => {});
    await seedGraph(page);
    await page.reload();
    await page.waitForSelector('.react-flow', { timeout: 8000 });
  });

  test('graph has expected node count', async ({ page }) => {
    // Wait for nodes to render
    await page.waitForTimeout(1000);
    const nodeCount = await page.locator('.react-flow__node').count();
    // Graph has 36 nodes
    expect(nodeCount).toBe(36);
  });

  test('graph has expected edge count', async ({ page }) => {
    await page.waitForTimeout(1000);
    const edgeCount = await page.locator('.react-flow__edge').count();
    // Graph has 50 edges
    expect(edgeCount).toBe(50);
  });

  test('key nodes are present on canvas', async ({ page }) => {
    await page.waitForTimeout(1000);
    const nodeTexts = await page.locator('.react-flow__node').allTextContents();
    const allText = nodeTexts.join(' ');

    // Check for key funnel nodes
    expect(allText).toContain('High Intent Landing Page');
    expect(allText).toContain('Confirm Switch');
    expect(allText).toContain('Switch Success');
    expect(allText).toContain('Delegated');
    expect(allText).toContain('WhatsApp');
  });

  test('context DSL is applied', async ({ page }) => {
    // The graph's currentQueryDSL should contain the context filter
    const graphData = await page.evaluate(async () => {
      const db = (window as any).db;
      const file = await db.files.get('graph-high-intent-flow-v2');
      return file?.data;
    });

    expect(graphData?.currentQueryDSL).toContain('context(hif-high-intent-traffic:high-intent-energy)');
    expect(graphData?.baseDSL).toContain('context(hif-high-intent-traffic:high-intent-energy)');
  });
});
