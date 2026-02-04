/**
 * asat() Historical Query E2E Test
 *
 * REAL END-TO-END:
 * - Seeds REAL data into PRODUCTION Neon database via real API
 * - Opens REAL frontend in browser
 * - Enters asat() query
 * - Verifies REAL data flows through REAL backend
 * - NO MOCKING (except Git)
 *
 * Run: cd graph-editor && CI= PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright" npm run -s e2e -- e2e/asatHistoricalQuery.spec.ts --workers=1 --retries=0 --reporter=line --timeout=30000 --global-timeout=60000
 */
import { test, expect, Page, request } from '@playwright/test';

test.describe.configure({ timeout: 30_000 });

// Test identifiers
// The param_id in DB must match what frontend constructs: {repository}-{branch}-{paramId}
// Frontend gets repository/branch from IndexedDB file.source
const TEST_REPO = 'e2e-test-repo';
const TEST_BRANCH = 'main';
const TEST_PARAM_NAME = 'asat-test-param';
const TEST_PARAM_ID = `${TEST_REPO}-${TEST_BRANCH}-${TEST_PARAM_NAME}`; // e2e-test-repo-main-asat-test-param
const API_BASE = 'http://127.0.0.1:9000';

// Test data seeded into real DB
const SEEDED_DATA = {
  // Snapshot taken on 15-Jan-26 with data for 1-Jan to 10-Jan
  // NOTE: We intentionally seed CONTEXTED slices only, then query UNCONTEXTED and
  // expect DagNet to aggregate the MECE partition back to the uncontexted total.
  googleRows: [
    { anchor_day: '2026-01-01', X: 60, Y: 15, A: 30 },
    { anchor_day: '2026-01-02', X: 66, Y: 17, A: 33 },
    { anchor_day: '2026-01-03', X: 72, Y: 19, A: 36 },
    { anchor_day: '2026-01-04', X: 78, Y: 21, A: 39 },
    { anchor_day: '2026-01-05', X: 84, Y: 23, A: 42 },
    { anchor_day: '2026-01-06', X: 90, Y: 25, A: 45 },
    { anchor_day: '2026-01-07', X: 96, Y: 27, A: 48 },
    { anchor_day: '2026-01-08', X: 102, Y: 29, A: 51 },
    { anchor_day: '2026-01-09', X: 108, Y: 31, A: 54 },
    { anchor_day: '2026-01-10', X: 114, Y: 33, A: 57 },
  ],
  facebookRows: [
    { anchor_day: '2026-01-01', X: 40, Y: 10, A: 20 },
    { anchor_day: '2026-01-02', X: 44, Y: 11, A: 22 },
    { anchor_day: '2026-01-03', X: 48, Y: 13, A: 24 },
    { anchor_day: '2026-01-04', X: 52, Y: 14, A: 26 },
    { anchor_day: '2026-01-05', X: 56, Y: 15, A: 28 },
    { anchor_day: '2026-01-06', X: 60, Y: 17, A: 30 },
    { anchor_day: '2026-01-07', X: 64, Y: 18, A: 32 },
    { anchor_day: '2026-01-08', X: 68, Y: 19, A: 34 },
    { anchor_day: '2026-01-09', X: 72, Y: 21, A: 36 },
    { anchor_day: '2026-01-10', X: 76, Y: 22, A: 38 },
  ],
  retrieved_at: '2026-01-15T10:00:00Z',
};

// Expected totals when querying window(1-Jan-26:5-Jan-26)
const EXPECTED_N = 100 + 110 + 120 + 130 + 140; // 600
const EXPECTED_K = 25 + 28 + 32 + 35 + 38;       // 158

// Graph uses TEST_PARAM_NAME for the parameter reference
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
      // CRITICAL: query is required for signature computation
      query: 'from(start).to(end)',
      p: {
        id: TEST_PARAM_NAME,
        parameter_id: TEST_PARAM_NAME,
        mean: 0.5,
        n: 999,  // Initial value - should change after asat query
        k: 499,
      },
    },
  ],
  currentQueryDSL: 'window(1-Jan-26:10-Jan-26)',
  baseDSL: 'window(1-Jan-26:10-Jan-26)',
  // Pin the context key so uncontexted window() queries can still compute a
  // context-keyed signature for MECE aggregation (channel partition).
  dataInterestsDSL: 'context(channel:google)',
  metadata: { name: 'e2e-asat-test' },
};

/**
 * Seed REAL data into the PRODUCTION Neon database via the REAL API.
 */
async function seedProductionDatabase(signatureStr: string): Promise<{ success: boolean; error?: string }> {
  const apiContext = await request.newContext({ baseURL: API_BASE });
  
  try {
    // Seed two MECE context slices (channel:google + channel:facebook)
    const seedOnce = async (slice_key: string, rows: any[]) => {
      const response = await apiContext.post('/api/snapshots/append', {
        data: {
          param_id: TEST_PARAM_ID,
          core_hash: signatureStr,
          context_def_hashes: { channel: 'e2e-channel-def-hash' },
          slice_key,
          rows: rows.map(r => ({
            ...r,
            median_lag_days: 5.0,
            mean_lag_days: 6.0,
            anchor_median_lag_days: 3.0,
            anchor_mean_lag_days: 4.0,
            onset_delta_days: 0,
          })),
          retrieved_at: SEEDED_DATA.retrieved_at,
        },
      });
      const body = await response.json();
      console.log('Seed response:', slice_key, response.status(), body);
      if (!response.ok()) {
        throw new Error(`HTTP ${response.status()}: ${JSON.stringify(body)}`);
      }
      if (body?.success === false) {
        throw new Error(String(body?.error || 'seed failed'));
      }
      return body;
    };

    await seedOnce('context(channel:google)', SEEDED_DATA.googleRows);
    await seedOnce('context(channel:facebook)', SEEDED_DATA.facebookRows);

    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  } finally {
    await apiContext.dispose();
  }
}

/**
 * Clean up test data from PRODUCTION database.
 */
async function cleanupProductionDatabase(): Promise<void> {
  const apiContext = await request.newContext({ baseURL: API_BASE });
  
  try {
    // Call delete endpoint
    const response = await apiContext.post('/api/snapshots/delete', {
      data: { param_id: TEST_PARAM_ID },
    });
    const body = await response.json();
    console.log('Cleanup response:', response.status(), body);
  } catch (e) {
    console.error('Cleanup failed:', e);
  } finally {
    await apiContext.dispose();
  }
}

/**
 * Verify data exists in production database via query-virtual.
 */
async function verifyDataInDatabase(signatureStr: string): Promise<{ success: boolean; count: number; error?: string }> {
  const apiContext = await request.newContext({ baseURL: API_BASE });
  
  try {
    const response = await apiContext.post('/api/snapshots/query-virtual', {
      data: {
        param_id: TEST_PARAM_ID,
        as_at: '2026-01-20T23:59:59Z',
        anchor_from: '2026-01-01',
        anchor_to: '2026-01-10',
        core_hash: signatureStr,
      },
    });
    
    const body = await response.json();
    console.log('Verify response:', response.status(), 'count:', body.count);
    
    return { 
      success: body.success && body.count > 0, 
      count: body.count || 0,
      error: body.error 
    };
  } catch (e) {
    return { success: false, count: 0, error: String(e) };
  } finally {
    await apiContext.dispose();
  }
}

/**
 * Seed IndexedDB with graph and parameter file.
 * 
 * CRITICAL: The file.source.repository and file.source.branch must match
 * what we seeded into the DB, because frontend constructs param_id as:
 *   `${repository}-${branch}-${paramId}`
 */
async function seedIndexedDb(page: Page) {
  await page.evaluate(async ({ graphData, paramName, repo, branch }) => {
    const db = (window as any).db;
    if (!db) throw new Error('db not available');

    // Create context definition (MECE partition over channel)
    const contextFile = {
      fileId: 'context-channel',
      type: 'context',
      viewTabs: [],
      data: {
        id: 'channel',
        type: 'categorical',
        otherPolicy: 'explicit',
        values: [
          { id: 'google', label: 'Google' },
          { id: 'facebook', label: 'Facebook' },
        ],
        metadata: { status: 'active' },
      },
      source: {
        repository: repo,
        branch: branch,
        path: 'contexts/channel.yaml',
      },
    };
    await db.files.put(contextFile);

    const fr = (window as any).fileRegistry;
    if (fr?.registerFile) {
      fr.registerFile(contextFile.fileId, contextFile);
      console.log('[E2E] Registered context file in fileRegistry:', contextFile.fileId);
    }

    // Create parameter file with source metadata
    // CRITICAL: repository + branch + paramId must match TEST_PARAM_ID in database
    const paramFile = {
      fileId: `parameter-${paramName}`,
      type: 'parameter',
      viewTabs: [],
      data: {
        id: paramName,
        name: 'E2E asat Test Parameter',
        slices: [], // Empty - data should come from snapshot DB
      },
      source: { 
        repository: repo,  // Must match TEST_REPO
        branch: branch,    // Must match TEST_BRANCH
        path: `parameters/${paramName}.yaml` 
      },
    };
    await db.files.put(paramFile);
    
    // CRITICAL: Also register in fileRegistry so asat code path can find it
    if (fr?.registerFile) {
      fr.registerFile(paramFile.fileId, paramFile);
      console.log('[E2E] Registered param file in fileRegistry:', paramFile.fileId);
    }

    // Create graph file
    await db.files.put({
      fileId: 'graph-e2e-asat-test',
      type: 'graph',
      viewTabs: [],
      data: graphData,
      source: { repository: repo, branch: branch, path: 'graphs/e2e-asat-test.json' },
    });

    // Create tab
    await db.tabs.put({
      id: 'tab-graph-asat',
      fileId: 'graph-e2e-asat-test',
      viewMode: 'interactive',
      title: 'E2E asat Test',
      icon: '',
      closable: true,
      group: 'main-content',
    });

    // Set active tab
    if (typeof db.saveAppState === 'function') {
      await db.saveAppState({ activeTabId: 'tab-graph-asat', updatedAt: Date.now() });
    }
  }, { 
    graphData: TEST_GRAPH, 
    paramName: TEST_PARAM_NAME,
    repo: TEST_REPO,
    branch: TEST_BRANCH,
  });
}

test.describe('asat() Historical Query - Real E2E', () => {
  
  test.beforeAll(async () => {
    console.log('\n=== PRE-CLEAN PRODUCTION DATABASE (E2E) ===');
    console.log('Test param_id:', TEST_PARAM_ID);
    // Clean up any leftover test data first (seed happens inside the test once we know core_hash)
    await cleanupProductionDatabase();
  });
  
  test.afterAll(async () => {
    console.log('\n=== CLEANING UP PRODUCTION DATABASE ===');
    await cleanupProductionDatabase();
  });

  test('asat query retrieves real data from production snapshot database', async ({ page, baseURL }) => {
    // Navigate to app
    await page.goto(new URL('/?e2e=1', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    
    // Seed IndexedDB
    await seedIndexedDb(page);
    
    // Reload to pick up seeded data
    await page.reload({ waitUntil: 'domcontentloaded' });
    
    // Wait for graph to render
    await expect(page.locator('.react-flow')).toBeVisible({ timeout: 10_000 });
    
    // Select the edge to show PropertiesPanel
    await page.evaluate(() => {
      const e2e = (window as any).dagnetE2e;
      if (!e2e?.selectEdge) throw new Error('dagnetE2e.selectEdge not available');
      e2e.selectEdge('edge-1');
    });
    
    // Wait for PropertiesPanel
    await expect(page.locator('.properties-panel-wrapper')).toBeVisible({ timeout: 5_000 });

    // ---------------------------------------------------------------------------
    // Compute core_hash using the SAME code path as the app, then seed DB with it.
    // ---------------------------------------------------------------------------
    const computedSignature = await page.evaluate(async () => {
      const fr = (window as any).fileRegistry;
      const graph = fr?.getFile?.('graph-e2e-asat-test')?.data;
      if (!graph) throw new Error('[E2E] graph not available in fileRegistry');
      const edge = graph.edges?.find((e: any) => e.uuid === 'edge-1' || e.id === 'edge-1');
      if (!edge) throw new Error('[E2E] edge not found');

      const dslWithoutAsat = 'window(1-Jan-26:5-Jan-26)';
      // @ts-expect-error - Vite runtime import (browser context)
      const { parseConstraints } = await import('/src/lib/queryDSL.ts');
      const constraintsWithoutAsat = parseConstraints(dslWithoutAsat);

      const connectionName =
        edge?.p?.connection ||
        edge?.cost_gbp?.connection ||
        edge?.labour_cost?.connection ||
        'amplitude';

      // @ts-expect-error - Vite runtime import (browser context)
      const { buildDslFromEdge } = await import('/src/lib/das/buildDslFromEdge.ts');
      const { queryPayload } = await buildDslFromEdge(
        edge,
        graph,
        connectionName,
        undefined,
        constraintsWithoutAsat
      );

      // @ts-expect-error - Vite runtime import (browser context)
      const { computeQuerySignature } = await import('/src/services/dataOperationsService.ts');
      // @ts-expect-error - Vite runtime import (browser context)
      const { contextRegistry } = await import('/src/services/contextRegistry.ts');

      const workspaceForSignature = { repository: 'e2e-test-repo', branch: 'main' };
      await contextRegistry.ensureContextsCached(['channel'], { workspace: workspaceForSignature });

      const explicitKeys = constraintsWithoutAsat.context?.map((c: any) => c.key) || [];
      const pinnedKeys = (() => {
        try {
          const pinnedDsl = (graph as any)?.dataInterestsDSL || '';
          if (!pinnedDsl) return [];
          const pinnedConstraints = parseConstraints(pinnedDsl);
          return pinnedConstraints.context?.map((c: any) => c.key) || [];
        } catch {
          return [];
        }
      })();
      const contextKeys = explicitKeys.length > 0 ? explicitKeys : pinnedKeys;

      const signature = await computeQuerySignature(
        queryPayload,
        connectionName,
        graph,
        edge,
        contextKeys,
        workspaceForSignature
      );
      if (!signature || typeof signature !== 'string') throw new Error('[E2E] computed invalid signature');
      return signature;
    });

    console.log('\n=== SEEDING PRODUCTION DATABASE (core_hash computed) ===');
    console.log('param_id:', TEST_PARAM_ID);
    console.log('core_hash:', computedSignature);

    // Clean up again (defensive: ensure no leftover rows from a previous failed run)
    await cleanupProductionDatabase();

    const seedResult = await seedProductionDatabase(computedSignature);
    if (!seedResult.success) {
      throw new Error(`Failed to seed production database: ${seedResult.error}`);
    }
    const verifyResult = await verifyDataInDatabase(computedSignature);
    if (!verifyResult.success) {
      throw new Error(`Data verification failed: ${verifyResult.error}`);
    }
    console.log(`Successfully seeded ${verifyResult.count} rows into production database`);
    
    // Record initial n value from file registry (fileRegistry is exposed for E2E)
    const initialN = await page.evaluate(() => {
      const fr = (window as any).fileRegistry;
      if (!fr) return undefined;
      const graphFile = fr.getFile('graph-e2e-asat-test');
      const edge = graphFile?.data?.edges?.find((e: any) => e.uuid === 'edge-1');
      return edge?.p?.n;
    });
    console.log('Initial n value:', initialN);
    expect(initialN).toBe(999); // Our test graph starts with n=999
    
    // Find the WindowSelector and click the unroll toggle to expand
    const windowSelector = page.locator('.window-selector').first();
    await expect(windowSelector).toBeVisible({ timeout: 5_000 });
    
    // Click the unroll toggle to expand and show the full query editor
    const unrollToggle = page.locator('.window-selector-unroll-toggle').first();
    await unrollToggle.click();
    
    // Wait for extended view with query editor chips
    const extendedView = page.locator('.window-selector-extended');
    await expect(extendedView).toBeVisible({ timeout: 3_000 });
    
    // Set the DSL with asat clause directly via IndexedDB and trigger a refresh
    // This bypasses Monaco editor interaction issues
    const asatDSL = 'window(1-Jan-26:5-Jan-26).asat(20-Jan-26)';
    console.log('Setting DSL via IndexedDB:', asatDSL);
    
    // Update the graph file in IndexedDB with the new DSL
    await page.evaluate(async (dsl) => {
      const db = (window as any).db;
      if (!db) throw new Error('db not available');
      
      // Get the current graph file
      const graphFile = await db.files.get('graph-e2e-asat-test');
      if (!graphFile) throw new Error('Graph file not found in IndexedDB');
      
      // Update the DSL
      graphFile.data.currentQueryDSL = dsl;
      graphFile.data.baseDSL = dsl;
      
      // Save back to IndexedDB
      await db.files.put(graphFile);
      console.log('[E2E] Updated graph DSL in IndexedDB to:', dsl);
      
      // Also update in fileRegistry if available
      const fr = (window as any).fileRegistry;
      const memFile = fr?.getFile?.('graph-e2e-asat-test');
      if (memFile?.data) {
        memFile.data.currentQueryDSL = dsl;
        memFile.data.baseDSL = dsl;
        console.log('[E2E] Updated graph DSL in fileRegistry');
      }
    }, asatDSL);
    
    // Reload the page to pick up the new DSL from IndexedDB
    console.log('Reloading page to pick up new DSL...');
    await page.reload();
    await page.waitForLoadState('networkidle');
    
    // Wait for the graph to load and the asat query to be processed
    await expect(page.locator('.properties-panel-wrapper')).toBeVisible({ timeout: 10_000 });
    
    // CRITICAL: Re-register the param file in fileRegistry AFTER reload
    // The page reload cleared fileRegistry, but IndexedDB still has it
    await page.evaluate(async ({ paramName, repo, branch }) => {
      const db = (window as any).db;
      const fr = (window as any).fileRegistry;
      
      if (!db || !fr) {
        console.error('[E2E] Missing db or fileRegistry');
        return;
      }

      // Re-register context file
      const ctxFile = await db.files.get('context-channel');
      if (ctxFile) {
        if (typeof fr.registerFile === 'function') {
          fr.registerFile(ctxFile.fileId, ctxFile);
          console.log('[E2E] Registered context file in fileRegistry:', ctxFile.fileId);
        } else {
          fr.files = fr.files || new Map();
          fr.files.set(ctxFile.fileId, ctxFile);
          console.log('[E2E] Set context file in fileRegistry.files map:', ctxFile.fileId);
        }
      } else {
        console.error('[E2E] Context file not in IndexedDB');
      }
      
      // Get from IndexedDB
      const paramFile = await db.files.get(`parameter-${paramName}`);
      if (!paramFile) {
        console.error('[E2E] Param file not in IndexedDB');
        return;
      }
      
      // Register in fileRegistry
      if (typeof fr.registerFile === 'function') {
        fr.registerFile(paramFile.fileId, paramFile);
        console.log('[E2E] Registered param file in fileRegistry:', paramFile.fileId);
      } else {
        // Try alternative: set directly
        fr.files = fr.files || new Map();
        fr.files.set(paramFile.fileId, paramFile);
        console.log('[E2E] Set param file in fileRegistry.files map:', paramFile.fileId);
      }
    }, { paramName: TEST_PARAM_NAME, repo: TEST_REPO, branch: TEST_BRANCH });
    
    // Collect console logs to see if asat is being detected
    const consoleLogs: string[] = [];
    page.on('console', msg => {
      const text = msg.text();
      if (text.includes('asat') || text.includes('snapshot') || text.includes('DataOps') || text.includes('virtual')) {
        consoleLogs.push(text);
      }
    });
    
    // Trigger the asat path directly by calling dataOperationsService
    // The fetch button is hidden if no connections are configured, so we call the service directly
    console.log('Triggering asat data operation via dataOperationsService...');
    
    await page.evaluate(async ({ paramName, asatDSL, repo, branch }) => {
      // @ts-expect-error - Vite runtime import (browser context)
      const { contextRegistry } = await import('/src/services/contextRegistry.ts');
      await contextRegistry.ensureContextsCached(['channel'], { workspace: { repository: repo, branch } });

      // Import and call dataOperationsService
      // @ts-expect-error - Vite runtime import (browser context)
      const dataOpsModule = await import('/src/services/dataOperationsService.ts');
      const dataOps = dataOpsModule.dataOperationsService || (dataOpsModule as any).default;
      
      if (!dataOps?.getParameterFromFile) {
        console.error('[E2E] dataOperationsService.getParameterFromFile not available');
        return;
      }
      
      const fr = (window as any).fileRegistry;
      const graphFile = fr?.getFile?.('graph-e2e-asat-test');
      const graph = graphFile?.data;
      
      console.log('[E2E] Calling getParameterFromFile with asat DSL:', asatDSL);
      console.log('[E2E] Graph has edges:', graph?.edges?.length);
      
      // Create a setGraph function that updates the fileRegistry
      const setGraph = (updatedGraph: any) => {
        if (graphFile) {
          graphFile.data = updatedGraph;
          console.log('[E2E] setGraph called, updated graph in fileRegistry');
        }
      };
      
      const result = await dataOps.getParameterFromFile({
        paramId: paramName, // CORRECT: paramId, not objectId
        edgeId: 'edge-1',
        graph,
        setGraph, // Required
        targetSlice: asatDSL,
      });
      
      console.log('[E2E] getParameterFromFile result:', JSON.stringify(result));
    }, { paramName: TEST_PARAM_NAME, asatDSL: 'window(1-Jan-26:5-Jan-26).asat(20-Jan-26)', repo: TEST_REPO, branch: TEST_BRANCH });
    
    // Wait for fetch to complete
    console.log('Waiting for asat data fetch to complete...');
    await page.waitForTimeout(3_000);
    
    console.log('Console logs containing asat/snapshot/DataOps/virtual:');
    consoleLogs.forEach(log => console.log('  ' + log.substring(0, 300)));
    
    // Check what DSL is actually set and what param file exists
    const debugInfo = await page.evaluate(() => {
      const fr = (window as any).fileRegistry;
      const graphFile = fr?.getFile?.('graph-e2e-asat-test');
      const paramFile = fr?.getFile?.('parameter-asat-test-param');
      return {
        graphDSL: graphFile?.data?.currentQueryDSL,
        paramExists: !!paramFile,
        paramSource: paramFile?.source,
        graphSource: graphFile?.source,
      };
    });
    console.log('Debug info:', JSON.stringify(debugInfo, null, 2));
    
    // Wait for data to be fetched and applied
    await page.waitForTimeout(3000);
    
    // Verify the edge data was updated from snapshot DB
    // Use fileRegistry which is exposed for E2E tests
    const updatedData = await page.evaluate(() => {
      const fr = (window as any).fileRegistry;
      if (!fr) return { n: undefined, k: undefined, _asat: undefined, n_daily: undefined };
      const graphFile = fr.getFile('graph-e2e-asat-test');
      const edge = graphFile?.data?.edges?.find((e: any) => e.uuid === 'edge-1');
      return {
        n: edge?.p?.n,
        k: edge?.p?.k,
        _asat: edge?.p?._asat,
        n_daily: edge?.p?.n_daily,
      };
    });
    
    console.log('Updated edge data:', updatedData);
    
    // CRITICAL ASSERTIONS:
    // 1. n should have changed from initial value (999)
    expect(updatedData.n).not.toBe(999);
    
    // 2. n should equal our expected sum from seeded data
    expect(updatedData.n).toBe(EXPECTED_N);
    
    // 3. k should equal our expected sum
    expect(updatedData.k).toBe(EXPECTED_K);
    
    // 4. _asat metadata should be set
    expect(updatedData._asat).toBeTruthy();
    
    // 5. Daily arrays should be populated
    expect(updatedData.n_daily).toBeTruthy();
    expect(updatedData.n_daily.length).toBe(5); // 5 days in window
  });
});
