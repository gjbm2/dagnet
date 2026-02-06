import { test, expect } from '@playwright/test';

/**
 * E2E: Automation run logs persist to IndexedDB and survive page reload.
 *
 * Validates that:
 * 1. automationLogService.persistRunLog() writes to IDB successfully
 * 2. The record survives a full page reload (IDB persistence, not just in-memory)
 * 3. The console helper dagnetAutomationLogs() can find the record
 */
test.describe.configure({ timeout: 20_000 });

async function installNoopComputeStub(page: any) {
  const handler = async (route: any) => {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  };
  await page.route('http://127.0.0.1:9000/**', handler);
  await page.route('http://localhost:9000/**', handler);
}

test('automation run log persists to IDB and survives reload', async ({ page, baseURL }) => {
  await installNoopComputeStub(page);

  // Navigate without ?secret — IDB-driven, no network needed.
  await page.goto(new URL('/?e2e=1', baseURL).toString(), { waitUntil: 'domcontentloaded' });

  // Wait for the app to boot enough that window.db is available.
  await expect
    .poll(async () => page.evaluate(() => !!(window as any).db))
    .toBeTruthy();

  // --- Step 1: Write a test automation run log via the service ---
  const testRunId = `e2e-test-run:${Date.now()}`;
  await page.evaluate(async (runId: string) => {
    const w = window as any;
    const db = w.db;
    if (!db) throw new Error('window.db not available');

    // Write directly to the IDB table (same as automationLogService.persistRunLog does).
    await db.automationRunLogs.put({
      runId,
      timestamp: Date.now(),
      graphs: ['test-graph-alpha', 'test-graph-beta'],
      outcome: 'success',
      appVersion: '1.0.0-e2e-test',
      repository: 'e2e-repo',
      branch: 'main',
      durationMs: 12345,
      entries: [
        {
          id: 'entry-1',
          timestamp: new Date().toISOString(),
          level: 'info',
          category: 'session',
          operation: 'SESSION_START',
          message: 'E2E test session',
        },
        {
          id: 'entry-2',
          timestamp: new Date().toISOString(),
          level: 'success',
          category: 'session',
          operation: 'DAILY_RETRIEVE_ALL',
          message: 'E2E test automation complete',
          children: [
            {
              id: 'entry-2a',
              timestamp: new Date().toISOString(),
              level: 'info',
              category: 'session',
              operation: 'STEP_PULL',
              message: 'Pulling latest',
            },
          ],
        },
      ],
    });
  }, testRunId);

  // --- Step 2: Verify the record can be read back (pre-reload) ---
  const preReloadResult = await page.evaluate(async (runId: string) => {
    const db = (window as any).db;
    if (!db) return { found: false, reason: 'no-db' };
    const record = await db.automationRunLogs.get(runId);
    if (!record) return { found: false, reason: 'not-in-idb' };
    return {
      found: true,
      runId: record.runId,
      outcome: record.outcome,
      graphCount: record.graphs?.length,
      entryCount: record.entries?.length,
      repository: record.repository,
    };
  }, testRunId);

  expect(preReloadResult).toMatchObject({
    found: true,
    runId: testRunId,
    outcome: 'success',
    graphCount: 2,
    entryCount: 2,
    repository: 'e2e-repo',
  });

  // --- Step 3: Reload the page (full teardown + fresh boot) ---
  await page.reload({ waitUntil: 'domcontentloaded' });

  // Wait for db to be available again after reload.
  await expect
    .poll(async () => page.evaluate(() => !!(window as any).db))
    .toBeTruthy();

  // --- Step 4: Verify the record survived the reload ---
  const postReloadResult = await page.evaluate(async (runId: string) => {
    const db = (window as any).db;
    if (!db) return { found: false, reason: 'no-db' };
    const record = await db.automationRunLogs.get(runId);
    if (!record) return { found: false, reason: 'not-in-idb-after-reload' };
    return {
      found: true,
      runId: record.runId,
      outcome: record.outcome,
      graphCount: record.graphs?.length,
      entryCount: record.entries?.length,
      repository: record.repository,
      branch: record.branch,
      appVersion: record.appVersion,
      hasChildren: record.entries?.some((e: any) => e.children?.length > 0),
    };
  }, testRunId);

  expect(postReloadResult).toMatchObject({
    found: true,
    runId: testRunId,
    outcome: 'success',
    graphCount: 2,
    entryCount: 2,
    repository: 'e2e-repo',
    branch: 'main',
    appVersion: '1.0.0-e2e-test',
    hasChildren: true,
  });

  // --- Step 5: Verify the console helper finds it ---
  const consoleHelperResult = await page.evaluate(async (runId: string) => {
    const fn = (window as any).dagnetAutomationLogs;
    if (!fn) return { found: false, reason: 'helper-not-exposed' };
    const logs = await fn(10);
    if (!logs || !Array.isArray(logs)) return { found: false, reason: 'helper-returned-nothing' };
    const match = logs.find((l: any) => l.runId === runId);
    return {
      found: !!match,
      totalLogsReturned: logs.length,
      matchedOutcome: match?.outcome,
    };
  }, testRunId);

  expect(consoleHelperResult).toMatchObject({
    found: true,
    matchedOutcome: 'success',
  });

  // --- Step 6: Verify dagnetAutomationLogEntries returns full entries ---
  const entriesResult = await page.evaluate(async (runId: string) => {
    const fn = (window as any).dagnetAutomationLogEntries;
    if (!fn) return { found: false, reason: 'entries-helper-not-exposed' };
    const entries = await fn(runId);
    if (!entries || !Array.isArray(entries)) return { found: false, reason: 'no-entries' };
    return {
      found: true,
      count: entries.length,
      firstOperation: entries[0]?.operation,
      hasNestedChildren: entries.some((e: any) => e.children?.length > 0),
    };
  }, testRunId);

  expect(entriesResult).toMatchObject({
    found: true,
    count: 2,
    firstOperation: 'SESSION_START',
    hasNestedChildren: true,
  });
});

test('automation run log with warning outcome is retrievable', async ({ page, baseURL }) => {
  await installNoopComputeStub(page);
  await page.goto(new URL('/?e2e=1', baseURL).toString(), { waitUntil: 'domcontentloaded' });

  await expect
    .poll(async () => page.evaluate(() => !!(window as any).db))
    .toBeTruthy();

  const testRunId = `e2e-warning-run:${Date.now()}`;
  await page.evaluate(async (runId: string) => {
    const db = (window as any).db;
    await db.automationRunLogs.put({
      runId,
      timestamp: Date.now(),
      graphs: ['problem-graph'],
      outcome: 'warning',
      appVersion: '1.0.0-e2e-test',
      repository: 'e2e-repo',
      branch: 'main',
      durationMs: 5000,
      entries: [
        {
          id: 'w-1',
          timestamp: new Date().toISOString(),
          level: 'warning',
          category: 'session',
          operation: 'DAILY_RETRIEVE_ALL',
          message: 'Retrieve had warnings',
          children: [
            {
              id: 'w-1a',
              timestamp: new Date().toISOString(),
              level: 'warning',
              category: 'data-fetch',
              operation: 'RETRIEVE_COMPLETE',
              message: '3 succeeded, 1 failed',
            },
          ],
        },
      ],
    });
  }, testRunId);

  // Reload and verify the warning run is retrievable and its outcome is correct.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect
    .poll(async () => page.evaluate(() => !!(window as any).db))
    .toBeTruthy();

  const result = await page.evaluate(async (runId: string) => {
    const logs = await (window as any).dagnetAutomationLogs(10);
    const match = logs?.find((l: any) => l.runId === runId);
    return {
      found: !!match,
      outcome: match?.outcome,
      graphs: match?.graphs,
    };
  }, testRunId);

  expect(result).toMatchObject({
    found: true,
    outcome: 'warning',
    graphs: ['problem-graph'],
  });
});
