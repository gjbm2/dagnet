/**
 * Auto-reroute settles after drag — E2E regression test.
 *
 * Invariant: when a user drags a node to a new position, auto-reroute should
 * update edge handles to reflect the new geometry and then SETTLE. Edges must
 * not bounce between faces due to stale ReactFlow state or render-cycle lag.
 *
 * This test exists because the reroute pipeline completely regressed twice:
 * once from a stale-closure bug (performAutoReroute depending on itself in
 * the effect dep array) and once from reading RF edges instead of graph edges
 * (which lag by one render cycle).
 */

import { test, expect, Page } from '@playwright/test';

test.describe.configure({ timeout: 30_000 });

// ─── Test graph: A on left, B on right, C below-right ─────────────────────
// Initial layout:   A ──→ B
//                    ╲
//                     → C
//
// Edge A→B: right-out → left  (horizontal)
// Edge A→C: bottom-out → left (vertical-ish)

const FILE_ID = 'graph-e2e-auto-reroute';
const TAB_ID = 'tab-auto-reroute';

const TEST_GRAPH = {
  nodes: [
    { uuid: 'A', id: 'node-a', label: 'A', entry: { is_start: true, weight: 1.0 } },
    { uuid: 'B', id: 'node-b', label: 'B' },
    { uuid: 'C', id: 'node-c', label: 'C' },
  ],
  edges: [
    { uuid: 'edge-ab', id: 'A->B', from: 'A', to: 'B', fromHandle: 'right-out', toHandle: 'left', p: { mean: 0.6 } },
    { uuid: 'edge-ac', id: 'A->C', from: 'A', to: 'C', fromHandle: 'bottom-out', toHandle: 'left', p: { mean: 0.4 } },
  ],
  currentQueryDSL: 'window(-30d:)',
  baseDSL: 'window(-30d:)',
  metadata: { name: 'e2e-auto-reroute', version: '1.0.0' },
};

// Node positions: A left-centre, B right of A, C below-right of A
const INITIAL_POSITIONS: Record<string, { x: number; y: number }> = {
  A: { x: 100, y: 200 },
  B: { x: 400, y: 200 },
  C: { x: 350, y: 400 },
};

// ─── Helpers ───────────────────────────────────────────────────────────────

async function seedGraph(page: Page) {
  await page.evaluate(async ({ graphData, fileId, tabId, positions }) => {
    const db = (window as any).db;
    if (!db) throw new Error('db not available');

    const nodesWithLayout = graphData.nodes.map((n: any) => ({
      ...n,
      layout: positions[n.uuid] ? { x: positions[n.uuid].x, y: positions[n.uuid].y } : undefined,
    }));

    await db.files.put({
      fileId,
      type: 'graph',
      viewTabs: [tabId],
      data: { ...graphData, nodes: nodesWithLayout },
      source: { repository: 'repo-1', branch: 'main', path: `graphs/${fileId}.json` },
    });

    await db.tabs.put({
      id: tabId,
      fileId,
      viewMode: 'interactive',
      title: 'Auto-Reroute Test',
      icon: '',
      closable: true,
      group: 'main-content',
      editorState: {
        nodePositions: positions,
      },
    });

    if (typeof db.saveAppState === 'function') {
      await db.saveAppState({ activeTabId: tabId, updatedAt: Date.now() });
    }
  }, { graphData: TEST_GRAPH, fileId: FILE_ID, tabId: TAB_ID, positions: INITIAL_POSITIONS });
}

async function waitForCanvas(page: Page) {
  await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 10_000 });
  // Wait for boot/loading to complete
  await expect(
    page.locator('text=Loading files').first(),
  ).toBeHidden({ timeout: 10_000 }).catch(() => {
    // Toast may have already completed before we checked
  });
  // Extra settle time for graph→RF sync
  await page.waitForTimeout(1000);
}

/** Read edge handles from the graph store (source of truth, not ReactFlow). */
async function getEdgeHandles(page: Page, edgeUuid: string): Promise<{ fromHandle: string; toHandle: string } | null> {
  return page.evaluate(({ fileId, edgeUuid }) => {
    const state = (window as any).dagnetE2e?.getGraphStoreState(fileId);
    if (!state?.graph?.edges) return null;
    const edge = state.graph.edges.find((e: any) => e.uuid === edgeUuid);
    if (!edge) return null;
    return { fromHandle: edge.fromHandle || null, toHandle: edge.toHandle || null };
  }, { fileId: FILE_ID, edgeUuid });
}

/** Drag a ReactFlow node by label from its current position by (dx, dy) in screen pixels. */
async function dragNode(page: Page, label: string, dx: number, dy: number) {
  const node = page.locator('.react-flow__node').filter({ hasText: label }).first();
  await expect(node).toBeVisible({ timeout: 5_000 });

  const box = await node.boundingBox();
  expect(box).toBeTruthy();

  const startX = box!.x + box!.width / 2;
  const startY = box!.y + box!.height / 2;

  const STEPS = 15;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 1; i <= STEPS; i++) {
    await page.mouse.move(
      startX + dx * (i / STEPS),
      startY + dy * (i / STEPS),
    );
    await page.waitForTimeout(30);
  }
  // Hold at end position to let reroute debounce fire
  await page.waitForTimeout(200);
  await page.mouse.up();
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test.describe('Auto-reroute settles after drag', () => {
  test('edge handles update to reflect new geometry after dragging a node', async ({ page, baseURL }) => {
    await page.goto(new URL('/?e2e=1', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    await seedGraph(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForCanvas(page);
    await page.waitForTimeout(1500);

    // Verify initial state: A→B should route right→left
    const before = await getEdgeHandles(page, 'edge-ab');
    expect(before, 'edge-ab should exist in graph store').toBeTruthy();
    expect(before!.fromHandle).toBe('right-out');
    expect(before!.toHandle).toBe('left');

    // Drag B from right-of-A to well below A.
    // Screen coords map to ~0.53x graph coords, so use large values.
    // dx=-600, dy=+600 → B ends clearly below A (dy >> dx in graph coords).
    await dragNode(page, 'B', -600, 600);

    // Wait for reroute debounce (100ms) + graph sync to settle
    await page.waitForTimeout(500);

    const after = await getEdgeHandles(page, 'edge-ab');
    expect(after, 'edge-ab should still exist after drag').toBeTruthy();

    // B is now below A — A's output should route downward.
    expect(
      after!.fromHandle,
      `A→B source should route downward after B moved below A (got ${after!.fromHandle})`,
    ).toBe('bottom-out');
  });

  test('edge handles do not bounce back after settling', async ({ page, baseURL }) => {
    await page.goto(new URL('/?e2e=1', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    await seedGraph(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForCanvas(page);
    await page.waitForTimeout(1500);

    // Drag B well below A (same dramatic vertical drag as test 1).
    // This reliably changes A→B from right-out to bottom-out.
    await dragNode(page, 'B', -600, 600);

    // Wait for reroute to settle
    await page.waitForTimeout(500);

    const settled = await getEdgeHandles(page, 'edge-ab');
    expect(settled).toBeTruthy();
    expect(
      settled!.fromHandle,
      `A→B source should have changed face after drag (got ${settled!.fromHandle})`,
    ).toBe('bottom-out');

    // THE KEY ASSERTION: wait and check stability — handles must not bounce back.
    // Previous bugs caused the edge to flip back to 'right-out' on the next
    // render cycle because performAutoReroute read stale RF edge state.
    await page.waitForTimeout(500);

    const stable = await getEdgeHandles(page, 'edge-ab');
    expect(stable).toBeTruthy();
    expect(
      stable!.fromHandle,
      `A→B source handle should be stable (no bounce). Was ${settled!.fromHandle}, now ${stable!.fromHandle}`,
    ).toBe(settled!.fromHandle);
    expect(
      stable!.toHandle,
      `A→B target handle should be stable (no bounce). Was ${settled!.toHandle}, now ${stable!.toHandle}`,
    ).toBe(settled!.toHandle);
  });
});
