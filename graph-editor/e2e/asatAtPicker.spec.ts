/**
 * Phase 2 `@` (asat) picker E2E test
 *
 * REAL END-TO-END:
 * - Seeds REAL data into PRODUCTION Neon database via real API
 * - Opens REAL frontend in browser
 * - Uses the WindowSelector `@` UI to pick/remove asat()
 * - Verifies calendar highlighting, one-way truncation, and remove policy
 * - NO MOCKING (except Git)
 */
import { test, expect, Page, request } from '@playwright/test';
import { e2eLog } from './e2eLog';

test.describe.configure({ timeout: 30_000 });

const API_BASE = 'http://127.0.0.1:9000';

// Test identifiers
const TEST_REPO = 'e2e-test-repo';
const TEST_BRANCH = 'main';
const TEST_PARAM_NAME = 'asat-at-picker-param';
const TEST_PARAM_ID = `${TEST_REPO}-${TEST_BRANCH}-${TEST_PARAM_NAME}`;

const TEST_GRAPH_FILE_ID = 'graph-e2e-asat-at-ui';

const TEST_GRAPH = {
  nodes: [
    { uuid: 'start', id: 'start', label: 'Start', event_id: 'e2e_start_event', entry: { is_start: true } },
    { uuid: 'end', id: 'end', label: 'End', event_id: 'e2e_end_event' },
  ],
  edges: [
    {
      uuid: 'edge-1',
      id: 'start->end',
      from: 'start',
      to: 'end',
      query: 'from(start).to(end)',
      p: { id: TEST_PARAM_NAME, parameter_id: TEST_PARAM_NAME, mean: 0.5, n: 1, k: 1 },
    },
  ],
  currentQueryDSL: 'window(5-Jan-26:3-Feb-26)',
  baseDSL: 'window(5-Jan-26:3-Feb-26)',
  metadata: { name: 'e2e-asat-at-ui' },
};

async function cleanupProductionDatabase(): Promise<void> {
  const apiContext = await request.newContext({ baseURL: API_BASE });
  try {
    await apiContext.post('/api/snapshots/delete', { data: { param_id: TEST_PARAM_ID } });
  } finally {
    await apiContext.dispose();
  }
}

async function seedIndexedDb(page: Page) {
  await page.evaluate(async ({ graphData, paramName, repo, branch, graphFileId }) => {
    const db = (window as any).db;
    if (!db) throw new Error('db not available');

    const paramFile = {
      fileId: `parameter-${paramName}`,
      type: 'parameter',
      viewTabs: [],
      data: { id: paramName, name: 'E2E asat @ picker param', slices: [] },
      source: { repository: repo, branch, path: `parameters/${paramName}.yaml` },
    };
    await db.files.put(paramFile);

    const fr = (window as any).fileRegistry;
    if (fr?.registerFile) fr.registerFile(paramFile.fileId, paramFile);

    await db.files.put({
      fileId: graphFileId,
      type: 'graph',
      viewTabs: [],
      data: graphData,
      source: { repository: repo, branch, path: 'graphs/e2e-asat-at-ui.json' },
    });

    await db.tabs.put({
      id: 'tab-graph-asat-at-ui',
      fileId: graphFileId,
      viewMode: 'interactive',
      title: 'E2E asat @ UI',
      icon: '',
      closable: true,
      group: 'main-content',
    });

    if (typeof db.saveAppState === 'function') {
      await db.saveAppState({ activeTabId: 'tab-graph-asat-at-ui', updatedAt: Date.now() });
    }
  }, { graphData: TEST_GRAPH, paramName: TEST_PARAM_NAME, repo: TEST_REPO, branch: TEST_BRANCH, graphFileId: TEST_GRAPH_FILE_ID });
}

async function computeSignatureInBrowser(page: Page): Promise<string> {
  return await page.evaluate(async ({ repo, branch, graphFileId }) => {
    const fr = (window as any).fileRegistry;
    const graph = fr?.getFile?.(graphFileId)?.data;
    if (!graph) throw new Error('[E2E] graph not available in fileRegistry');
    const edge = graph.edges?.find((e: any) => e.uuid === 'edge-1' || e.id === 'edge-1');
    if (!edge) throw new Error('[E2E] edge not found');

    const dslWithoutAsat = 'window(5-Jan-26:3-Feb-26)';
    // @ts-expect-error - Vite runtime import (browser context)
    const { parseConstraints } = await import('/src/lib/queryDSL.ts');
    const constraints = parseConstraints(dslWithoutAsat);

    const connectionName =
      edge?.p?.connection ||
      edge?.cost_gbp?.connection ||
      edge?.labour_cost?.connection ||
      'amplitude';

    // @ts-expect-error - Vite runtime import (browser context)
    const { buildDslFromEdge } = await import('/src/lib/das/buildDslFromEdge.ts');
    const { queryPayload } = await buildDslFromEdge(edge, graph, connectionName, undefined, constraints);

    // @ts-expect-error - Vite runtime import (browser context)
    const { computeQuerySignature } = await import('/src/services/dataOperationsService.ts');
    const sig = await computeQuerySignature(queryPayload, connectionName, graph, edge, [], { repository: repo, branch });
    if (!sig || typeof sig !== 'string') throw new Error('[E2E] computed invalid signature');
    return sig;
  }, { repo: TEST_REPO, branch: TEST_BRANCH, graphFileId: TEST_GRAPH_FILE_ID });
}

async function seedSnapshots(signatureStr: string): Promise<void> {
  const apiContext = await request.newContext({ baseURL: API_BASE });
  try {
    const seedOnce = async (retrieved_at: string) => {
      const response = await apiContext.post('/api/snapshots/append', {
        data: {
          param_id: TEST_PARAM_ID,
          canonical_signature: signatureStr,
          inputs_json: {
            kind: 'playwright_seed',
            test: 'asatAtPicker',
            param_id: TEST_PARAM_ID,
          },
          sig_algo: 'sig_v1_sha256_trunc128_b64url',
          // Mode is ALWAYS part of slice identity.
          // This spec drives a window(...) query, so seed a window(...) slice_key.
          slice_key: 'window(5-Jan-26:13-Jan-26)',
          retrieved_at,
          rows: [
            { anchor_day: '2026-01-05', X: 10, Y: 1, A: 5 },
            { anchor_day: '2026-01-06', X: 11, Y: 2, A: 6 },
          ],
        },
      });
      const body = await response.json();
      if (!response.ok || body?.success === false) {
        throw new Error(`seed failed (${retrieved_at}): HTTP ${response.status()} ${JSON.stringify(body)}`);
      }
    };

    await seedOnce('2026-01-15T10:00:00Z');
    await seedOnce('2026-01-20T10:00:00Z');
  } finally {
    await apiContext.dispose();
  }
}

test.describe('asat Phase 2: @ picker', () => {
  test.beforeAll(async () => {
    await cleanupProductionDatabase();
  });

  test.afterAll(async () => {
    await cleanupProductionDatabase();
  });

  test('calendar highlights snapshot days; selecting inserts asat() and truncates; remove clears without restoring', async ({ page, baseURL }) => {
    await page.goto(new URL('/?e2e=1', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    await seedIndexedDb(page);
    await page.reload({ waitUntil: 'domcontentloaded' });

    // If the app hit the error boundary, surface the details immediately.
    const errorHeading = page.getByRole('heading', { name: 'Something went wrong' });
    if (await errorHeading.isVisible().catch(() => false)) {
      const summary = page.getByText('Error Details', { exact: true });
      if (await summary.isVisible().catch(() => false)) {
        await summary.click();
      }
      const stack = await page.locator('.error-boundary-stack').textContent();
      throw new Error(`App error boundary: ${stack || '(no stack)'}`);
    }

    await expect(page.locator('.react-flow')).toBeVisible({ timeout: 10_000 });

    // Select edge so the @ UI knows which parameter to query.
    await page.evaluate(() => {
      const e2e = (window as any).dagnetE2e;
      if (!e2e?.selectEdge) throw new Error('dagnetE2e.selectEdge not available');
      e2e.selectEdge('edge-1');
    });

    const sig = await computeSignatureInBrowser(page);
    await cleanupProductionDatabase();
    await seedSnapshots(sig);

    const asatToggle = page.getByTestId('asat-toggle');
    await expect(asatToggle).toBeVisible();

    // Open dropdown (month cursor starts at window end month: Feb-26)
    await asatToggle.click();
    await expect(page.getByTestId('asat-dropdown')).toBeVisible();

    // Wait for retrievals load to finish (otherwise calendar/nav isn't rendered yet).
    // If the retrievals call fails, surface the error rather than timing out on a missing button.
    const asatError = page.locator('.asat-dropdown-error');
    if (await asatError.isVisible().catch(() => false)) {
      const msg = (await asatError.textContent())?.trim() || '(no message)';
      throw new Error(`@ dropdown retrievals error: ${msg}`);
    }
    await expect(page.locator('.calendar-grid-nav-btn').first()).toBeVisible({ timeout: 10_000 });

    // Go to Jan-26 (previous month once)
    await page.locator('.calendar-grid-nav-btn').first().click();

    const day20 = page.getByTestId('calendar-day-2026-01-20');
    await expect(day20).toBeVisible();
    await expect(day20).toHaveClass(/has-snapshot/);

    // Select 20-Jan-26 (before window end => truncates end)
    await day20.click();

    const afterPick = await page.evaluate(async ({ graphFileId }) => {
      const fr = (window as any).fileRegistry;
      const g = fr?.getFile?.(graphFileId)?.data;
      return g?.currentQueryDSL || null;
    }, { graphFileId: TEST_GRAPH_FILE_ID });

    expect(afterPick).toContain('.asat(20-Jan-26)');
    expect(afterPick).toContain('window(5-Jan-26:20-Jan-26)');

    // Toggle should be highlighted when asat is active
    await expect(asatToggle).toHaveClass(/active/);

    // Remove @: clears asat but does NOT restore prior end date
    await asatToggle.click();
    await expect(page.getByTestId('asat-dropdown')).toBeVisible();
    await page.getByTestId('asat-remove').click();

    const afterRemove = await page.evaluate(async ({ graphFileId }) => {
      const fr = (window as any).fileRegistry;
      const g = fr?.getFile?.(graphFileId)?.data;
      return g?.currentQueryDSL || null;
    }, { graphFileId: TEST_GRAPH_FILE_ID });

    expect(afterRemove).not.toContain('.asat(');
    expect(afterRemove).toContain('window(5-Jan-26:20-Jan-26)'); // one-way truncation preserved
  });
});

