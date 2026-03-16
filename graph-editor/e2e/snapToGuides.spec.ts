/**
 * Snap-to-guide lines — E2E spec.
 *
 * Verifies that when a node is dragged near another node's alignment anchor,
 * the helper-lines canvas (data-testid="helper-lines-canvas") draws visible
 * guide lines AND the dragged node's position snaps.
 *
 * Tests BOTH horizontal AND vertical guide lines independently.
 * This test MUST BE RED when snap-to-guides is broken.
 */

import { test, expect, Page } from '@playwright/test';

test.describe.configure({ timeout: 30_000 });

// ─── Graph with nodes at same X (vertical alignment) and same Y (horizontal alignment) ──

const GRAPH_HORIZONTAL = {
  nodes: [
    { uuid: 'n1', id: 'node-a', label: 'Node A', entry: { is_start: true, weight: 1.0 } },
    { uuid: 'n2', id: 'node-b', label: 'Node B' },
  ],
  edges: [
    { uuid: 'e1', id: 'a-to-b', from: 'n1', to: 'n2', p: { mean: 0.5 } },
  ],
  currentQueryDSL: 'window(-30d:)',
  baseDSL: 'window(-30d:)',
  metadata: { name: 'e2e-snap-h', version: '1.0.0' },
};

const GRAPH_VERTICAL = {
  nodes: [
    { uuid: 'v1', id: 'node-c', label: 'Node C', entry: { is_start: true, weight: 1.0 } },
    { uuid: 'v2', id: 'node-d', label: 'Node D' },
  ],
  edges: [
    { uuid: 'ev1', id: 'c-to-d', from: 'v1', to: 'v2', p: { mean: 0.5 } },
  ],
  currentQueryDSL: 'window(-30d:)',
  baseDSL: 'window(-30d:)',
  metadata: { name: 'e2e-snap-v', version: '1.0.0' },
};

async function seedGraph(page: Page, graphData: any, fileId: string, tabId: string, positions: Record<string, { x: number; y: number }>) {
  await page.evaluate(async ({ graphData, fileId, tabId, positions }) => {
    const db = (window as any).db;
    if (!db) throw new Error('db not available');

    await db.files.put({
      fileId,
      type: 'graph',
      viewTabs: [tabId],
      data: graphData,
      source: { repository: 'repo-1', branch: 'main', path: `graphs/${fileId}.json` },
    });

    await db.tabs.put({
      id: tabId,
      fileId,
      viewMode: 'interactive',
      title: 'Snap Test',
      icon: '',
      closable: true,
      group: 'main-content',
      editorState: {
        snapToGuides: true,
        nodePositions: positions,
      },
    });

    if (typeof db.saveAppState === 'function') {
      await db.saveAppState({ activeTabId: tabId, updatedAt: Date.now() });
    }
  }, { graphData, fileId, tabId, positions });
}

async function waitForCanvas(page: Page) {
  await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 10_000 });
}

/**
 * Check the helper-lines canvas for non-zero alpha pixels.
 * Returns pixel count, or negative values for errors.
 */
async function getHelperLinesPixelCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas[data-testid="helper-lines-canvas"]') as HTMLCanvasElement | null;
    if (!canvas) return -1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return -2;
    if (canvas.width === 0 || canvas.height === 0) return -3;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let nonZero = 0;
    for (let i = 3; i < imageData.data.length; i += 4) {
      if (imageData.data[i] > 0) nonZero++;
    }
    return nonZero;
  });
}

/**
 * Detect whether drawn pixels form horizontal lines, vertical lines, or both.
 * Returns { horizontal: boolean, vertical: boolean } based on pixel distribution.
 */
async function detectLineOrientations(page: Page): Promise<{ horizontal: boolean; vertical: boolean }> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas[data-testid="helper-lines-canvas"]') as HTMLCanvasElement | null;
    if (!canvas) return { horizontal: false, vertical: false };
    const ctx = canvas.getContext('2d');
    if (!ctx) return { horizontal: false, vertical: false };
    if (canvas.width === 0 || canvas.height === 0) return { horizontal: false, vertical: false };

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const w = canvas.width;
    const h = canvas.height;

    // Count non-zero pixels per row and per column
    const rowCounts = new Uint32Array(h);
    const colCounts = new Uint32Array(w);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const alpha = imageData.data[(y * w + x) * 4 + 3];
        if (alpha > 0) {
          rowCounts[y]++;
          colCounts[x]++;
        }
      }
    }

    // A horizontal line spans many columns in a few rows
    // A vertical line spans many rows in a few columns
    const minSpan = Math.min(w, h) * 0.3; // line must span at least 30% of canvas

    let hasHorizontalLine = false;
    let hasVerticalLine = false;

    for (let y = 0; y < h; y++) {
      if (rowCounts[y] >= minSpan) { hasHorizontalLine = true; break; }
    }
    for (let x = 0; x < w; x++) {
      if (colCounts[x] >= minSpan) { hasVerticalLine = true; break; }
    }

    return { horizontal: hasHorizontalLine, vertical: hasVerticalLine };
  });
}

/**
 * Enable snap diagnostics and retrieve last diagnostic state.
 */
async function enableSnapDiag(page: Page) {
  await page.evaluate(() => { (window as any).__snapDiag = {}; });
}

async function getSnapDiag(page: Page): Promise<any> {
  return page.evaluate(() => (window as any).__snapDiag?.lastDrag ?? null);
}

test.describe('Snap-to-guide lines', () => {
  test('helper-lines canvas exists in the DOM', async ({ page, baseURL }) => {
    await page.goto(new URL('/?e2e=1', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    await seedGraph(page, GRAPH_HORIZONTAL, 'graph-e2e-snap-h', 'tab-snap-h', {
      'n1': { x: 100, y: 200 },
      'n2': { x: 400, y: 200 },
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForCanvas(page);
    await page.waitForTimeout(1000);

    const canvas = page.locator('canvas[data-testid="helper-lines-canvas"]');
    await expect(canvas, 'helper-lines-canvas must be in the DOM').toBeAttached({ timeout: 5_000 });
  });

  test('dragging produces HORIZONTAL guide lines when nodes share same Y', async ({ page, baseURL }) => {
    await page.goto(new URL('/?e2e=1', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    await seedGraph(page, GRAPH_HORIZONTAL, 'graph-e2e-snap-h', 'tab-snap-h', {
      'n1': { x: 100, y: 200 },
      'n2': { x: 400, y: 200 },
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForCanvas(page);
    await page.waitForTimeout(1500);
    await enableSnapDiag(page);

    const nodeA = page.locator('.react-flow__node').filter({ hasText: 'Node A' }).first();
    const nodeB = page.locator('.react-flow__node').filter({ hasText: 'Node B' }).first();
    await expect(nodeA).toBeVisible({ timeout: 5_000 });
    await expect(nodeB).toBeVisible({ timeout: 5_000 });

    const helperCanvas = page.locator('canvas[data-testid="helper-lines-canvas"]');
    await expect(helperCanvas).toBeAttached({ timeout: 3_000 });

    const nodeABox = await nodeA.boundingBox();
    const nodeBBox = await nodeB.boundingBox();
    expect(nodeABox).toBeTruthy();
    expect(nodeBBox).toBeTruthy();

    // Drag Node A rightward — same Y band → should trigger horizontal guide (centreY/top/bottom match)
    const startX = nodeABox!.x + nodeABox!.width / 2;
    const startY = nodeABox!.y + nodeABox!.height / 2;
    const endX = nodeBBox!.x - 5;
    const endY = nodeBBox!.y + nodeBBox!.height / 2 + 3;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (let i = 1; i <= 15; i++) {
      await page.mouse.move(
        startX + (endX - startX) * (i / 15),
        startY + (endY - startY) * (i / 15),
      );
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(300);

    const pixelsDuring = await getHelperLinesPixelCount(page);
    const orientations = await detectLineOrientations(page);
    const diag = await getSnapDiag(page);

    if (pixelsDuring <= 0 || !orientations.horizontal) {
      console.log('=== HORIZONTAL GUIDE DIAGNOSTIC ===');
      console.log('pixels:', pixelsDuring);
      console.log('orientations:', JSON.stringify(orientations));
      console.log('diag:', JSON.stringify(diag, null, 2));
      console.log('=== END ===');
    }

    expect(pixelsDuring, 'helper-lines canvas must have pixels during drag').toBeGreaterThan(0);
    expect(orientations.horizontal, 'must detect a horizontal guide line when nodes share same Y').toBe(true);

    await page.mouse.up();
    await page.waitForTimeout(300);
    const pixelsAfter = await getHelperLinesPixelCount(page);
    expect(pixelsAfter, 'canvas should be blank after release').toBe(0);
  });

  test('dragging produces VERTICAL guide lines when nodes share same X', async ({ page, baseURL }) => {
    // Position nodes at same X (centreX alignment), different Y
    // Node C at (200, 100), Node D at (200, 400) — same X, so centreX should match
    await page.goto(new URL('/?e2e=1', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    await seedGraph(page, GRAPH_VERTICAL, 'graph-e2e-snap-v', 'tab-snap-v', {
      'v1': { x: 200, y: 100 },
      'v2': { x: 200, y: 400 },
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForCanvas(page);
    await page.waitForTimeout(1500);
    await enableSnapDiag(page);

    const nodeC = page.locator('.react-flow__node').filter({ hasText: 'Node C' }).first();
    const nodeD = page.locator('.react-flow__node').filter({ hasText: 'Node D' }).first();
    await expect(nodeC).toBeVisible({ timeout: 5_000 });
    await expect(nodeD).toBeVisible({ timeout: 5_000 });

    const helperCanvas = page.locator('canvas[data-testid="helper-lines-canvas"]');
    await expect(helperCanvas).toBeAttached({ timeout: 3_000 });

    const pixelsBefore = await getHelperLinesPixelCount(page);
    expect(pixelsBefore, 'canvas should be blank before drag').toBe(0);

    const nodeCBox = await nodeC.boundingBox();
    const nodeDBox = await nodeD.boundingBox();
    expect(nodeCBox).toBeTruthy();
    expect(nodeDBox).toBeTruthy();

    // Drag Node C downward toward Node D — both at same X, so centreX should snap
    // producing a vertical guide line
    const startX = nodeCBox!.x + nodeCBox!.width / 2;
    const startY = nodeCBox!.y + nodeCBox!.height / 2;
    // Move downward, keeping X the same (± small offset within SNAP_RADIUS)
    const endX = nodeDBox!.x + nodeDBox!.width / 2 + 3; // +3px offset — within snap radius
    const endY = nodeDBox!.y - 5; // just above Node D

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (let i = 1; i <= 15; i++) {
      await page.mouse.move(
        startX + (endX - startX) * (i / 15),
        startY + (endY - startY) * (i / 15),
      );
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(300);

    await page.screenshot({ path: 'e2e/screenshots/snap-vertical-during-drag.png' });

    const pixelsDuring = await getHelperLinesPixelCount(page);
    const orientations = await detectLineOrientations(page);
    const diag = await getSnapDiag(page);

    // Always dump diagnostics for vertical test since this is the failing case
    console.log('=== VERTICAL GUIDE DIAGNOSTIC ===');
    console.log('pixels:', pixelsDuring);
    console.log('orientations:', JSON.stringify(orientations));
    console.log('diag:', JSON.stringify(diag, null, 2));
    console.log('nodeCBox:', JSON.stringify(nodeCBox));
    console.log('nodeDBox:', JSON.stringify(nodeDBox));
    console.log('drag: start=', { x: startX, y: startY }, 'end=', { x: endX, y: endY });
    console.log('=== END ===');

    expect(pixelsDuring, 'helper-lines canvas must have pixels during vertical alignment drag').toBeGreaterThan(0);
    expect(orientations.vertical, 'must detect a VERTICAL guide line when nodes share same X').toBe(true);

    await page.mouse.up();
    await page.waitForTimeout(300);
    const pixelsAfter = await getHelperLinesPixelCount(page);
    expect(pixelsAfter, 'canvas should be blank after release').toBe(0);
  });

  test('snap is suppressed when Alt key is held', async ({ page, baseURL }) => {
    await page.goto(new URL('/?e2e=1', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    await seedGraph(page, GRAPH_HORIZONTAL, 'graph-e2e-snap-h', 'tab-snap-h', {
      'n1': { x: 100, y: 200 },
      'n2': { x: 400, y: 200 },
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForCanvas(page);
    await page.waitForTimeout(1500);

    const nodeA = page.locator('.react-flow__node').filter({ hasText: 'Node A' }).first();
    const nodeB = page.locator('.react-flow__node').filter({ hasText: 'Node B' }).first();
    await expect(nodeA).toBeVisible({ timeout: 5_000 });
    await expect(nodeB).toBeVisible({ timeout: 5_000 });

    const nodeABox = await nodeA.boundingBox();
    const nodeBBox = await nodeB.boundingBox();

    const startX = nodeABox!.x + nodeABox!.width / 2;
    const startY = nodeABox!.y + nodeABox!.height / 2;
    const endX = nodeBBox!.x - 5;
    const endY = nodeBBox!.y + nodeBBox!.height / 2 + 3;

    await page.keyboard.down('Alt');

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (let i = 1; i <= 15; i++) {
      await page.mouse.move(
        startX + (endX - startX) * (i / 15),
        startY + (endY - startY) * (i / 15),
      );
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(300);

    const pixelCount = await getHelperLinesPixelCount(page);
    expect(pixelCount, 'No guide lines when Alt held').toBeLessThanOrEqual(0);

    await page.mouse.up();
    await page.keyboard.up('Alt');
  });
});
