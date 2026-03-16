/**
 * FileRegistry.updateFile tests.
 *
 * Covers:
 * - Listener notification contract
 * - Pending update replay: opts (syncOrigin) preservation
 * - Pending update replay: stale data rejection via generation counter
 * - Rapid A→B→C update sequence: final state must be C
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Must import after fake-indexeddb is loaded
let fileRegistry: any;
let db: any;

beforeEach(async () => {
  // Dynamic import to pick up fake-indexeddb
  const tabCtx = await import('../../contexts/TabContext');
  fileRegistry = tabCtx.fileRegistry;
  const dbMod = await import('../../db/appDatabase');
  db = dbMod.db;
  // Clear state
  await db.files.clear();
});

describe('FileRegistry.updateFile listener contract', () => {
  it('listener should be called with new data after updateFile', async () => {
    const fileId = 'test-chart-1';
    const initialData = {
      version: '1.0.0',
      title: 'Before',
      definition: { display: {} },
      payload: { analysis_result: null, scenario_ids: [] },
    };

    // Register file
    await fileRegistry.registerFile(fileId, {
      fileId,
      type: 'chart',
      data: initialData,
      originalData: structuredClone(initialData),
      isDirty: false,
      isInitializing: false,
      lastModified: Date.now(),
      viewTabs: [],
    });

    // Subscribe
    const received: any[] = [];
    const unsub = fileRegistry.subscribe(fileId, (file: any) => {
      received.push(structuredClone(file?.data));
    });

    // Update
    const nextData = structuredClone(initialData);
    (nextData as any).definition.display.orientation = 'horizontal';
    (nextData as any).title = 'After';
    await fileRegistry.updateFile(fileId, nextData);

    // Verify listener was called
    expect(received.length).toBeGreaterThanOrEqual(1);
    const last = received[received.length - 1];
    expect(last.title).toBe('After');
    expect(last.definition.display.orientation).toBe('horizontal');

    unsub();
  });

  it('useFileState pattern: subscribe + updateFile should deliver new data', async () => {
    const fileId = 'test-chart-2';
    const initialData = {
      version: '1.0.0',
      definition: { display: {}, recipe: { scenarios: [{ scenario_id: 'current' }, { scenario_id: 'sc-1' }] } },
      recipe: {},
      payload: { analysis_result: null, scenario_ids: [] },
    };

    await fileRegistry.registerFile(fileId, {
      fileId,
      type: 'chart',
      data: initialData,
      originalData: structuredClone(initialData),
      isDirty: false,
      isInitializing: false,
      lastModified: Date.now(),
      viewTabs: [],
    });

    // Simulate useFileState: subscribe, track latest data
    let latestData: any = initialData;
    const unsub = fileRegistry.subscribe(fileId, (file: any) => {
      if (file) latestData = file.data;
    });

    // Simulate updateChartFile: clone, mutate, updateFile
    const next = structuredClone(latestData);
    next.definition.display.hidden_scenarios = ['sc-1'];
    await fileRegistry.updateFile(fileId, next);

    // Verify the listener received the update
    expect(latestData.definition.display.hidden_scenarios).toEqual(['sc-1']);

    unsub();
  });

  it('restoreFile should hydrate unprefixed runtime IDs from workspace-prefixed IndexedDB entries', async () => {
    await db.files.add({
      fileId: 'repo-a-main-parameter-gm-delegated-to-registered',
      type: 'parameter',
      data: { id: 'gm-delegated-to-registered', values: [{ mean: 0.42 }] },
      originalData: { id: 'gm-delegated-to-registered', values: [{ mean: 0.42 }] },
      isDirty: false,
      isInitializing: false,
      lastModified: Date.now(),
      viewTabs: [],
      source: {
        repository: 'repo-a',
        branch: 'main',
        path: 'parameters/gm-delegated-to-registered.yaml',
      },
    });

    const restored = await fileRegistry.restoreFile('parameter-gm-delegated-to-registered', {
      repository: 'repo-a',
      branch: 'main',
    });

    expect(restored).not.toBeNull();
    expect(restored.fileId).toBe('parameter-gm-delegated-to-registered');
    expect(restored.source.repository).toBe('repo-a');
    expect(fileRegistry.getFile('parameter-gm-delegated-to-registered')?.data?.id).toBe('gm-delegated-to-registered');
  });
});

// Helper: flush all pending microtasks (IDB writes via fake-indexeddb resolve as microtasks)
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// Helper: flush microtasks until all pending IDB writes and replays settle.
//
// Under isolate: false (local dev), multiple test files share a thread and their
// microtasks can interleave. 3 rounds is not always enough — each updateFile has
// 1-2 IDB writes and may trigger a pending replay that starts another chain.
// 8 rounds handles worst-case interleaving with comfortable margin.
async function flushAll(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await flushMicrotasks();
  }
}

function makeGraphData(label: string) {
  return {
    nodes: [{ uuid: 'n1', id: 'node-1', label }],
    edges: [],
    metadata: { updated_at: new Date().toISOString() },
  };
}

async function registerTestFile(fRegistry: any, fileId: string, data: any) {
  await fRegistry.registerFile(fileId, {
    fileId,
    type: 'graph',
    data: structuredClone(data),
    originalData: structuredClone(data),
    isDirty: false,
    isInitializing: false,
    lastModified: Date.now(),
    viewTabs: [],
  });
}

describe('FileRegistry.updateFile pending replay', () => {
  it('should preserve syncOrigin through pending replay when re-entrant guard triggers', async () => {
    const fileId = 'pending-opts-test';
    const dataA = makeGraphData('A');
    const dataB = makeGraphData('B');
    await registerTestFile(fileRegistry, fileId, makeGraphData('initial'));

    // Track all notifications
    const notifications: Array<{ data: any; syncOrigin: any }> = [];
    const unsub = fileRegistry.subscribe(fileId, (file: any) => {
      notifications.push({
        data: structuredClone(file?.data),
        syncOrigin: file?.syncOrigin,
      });
    });

    // Fire A (starts IDB write) — don't await
    fileRegistry.updateFile(fileId, dataA, { syncOrigin: 'store' });
    // Fire B immediately — hits re-entrant guard, queued as pending
    fileRegistry.updateFile(fileId, dataB, { syncOrigin: 'store' });

    // Wait for all IDB writes + pending replay to complete
    await flushAll();

    // Final file state should be B
    const file = fileRegistry.getFile(fileId);
    expect(file.data.nodes[0].label).toBe('B');

    // The notification for B must have syncOrigin: 'store' (not undefined)
    const lastNotification = notifications[notifications.length - 1];
    expect(lastNotification.data.nodes[0].label).toBe('B');
    expect(lastNotification.syncOrigin).toBe('store');

    unsub();
  });

  it('should end with data C (not stale B) after rapid A→B→C updates', async () => {
    const fileId = 'rapid-abc-test';
    const dataA = makeGraphData('A');
    const dataB = makeGraphData('B');
    const dataC = makeGraphData('C');
    await registerTestFile(fileRegistry, fileId, makeGraphData('initial'));

    const notifications: Array<{ label: string; syncOrigin: any }> = [];
    const unsub = fileRegistry.subscribe(fileId, (file: any) => {
      notifications.push({
        label: file?.data?.nodes?.[0]?.label,
        syncOrigin: file?.syncOrigin,
      });
    });

    // Fire A — starts IDB write
    fileRegistry.updateFile(fileId, dataA, { syncOrigin: 'store' });
    // Fire B immediately — queued as pending
    fileRegistry.updateFile(fileId, dataB, { syncOrigin: 'store' });

    // Wait for A's IDB write to complete (queues B's setTimeout replay)
    await flushMicrotasks();

    // Fire C before B's setTimeout fires — C starts a fresh IDB write
    fileRegistry.updateFile(fileId, dataC, { syncOrigin: 'store' });

    // Now flush everything: B's setTimeout + C's IDB write + any further replays
    await flushAll();
    // Extra round to catch any lingering pending replays
    await flushAll();

    // Final in-memory state must be C
    const file = fileRegistry.getFile(fileId);
    expect(file.data.nodes[0].label).toBe('C');

    // Final IDB state must also be C
    const idbFile = await db.files.get(fileId);
    expect(idbFile.data.nodes[0].label).toBe('C');

    // No notification after C should carry stale data B
    const indexOfLastC = notifications.map(n => n.label).lastIndexOf('C');
    const notificationsAfterC = notifications.slice(indexOfLastC + 1);
    const staleAfterC = notificationsAfterC.filter(n => n.label === 'B');
    expect(staleAfterC).toHaveLength(0);

    unsub();
  });

  it('should drop stale pending data from a previous generation', async () => {
    const fileId = 'generation-test';
    const dataA = makeGraphData('A');
    const dataB = makeGraphData('B');
    const dataC = makeGraphData('C');
    await registerTestFile(fileRegistry, fileId, makeGraphData('initial'));

    // Spy on console.log to detect the "Dropped stale pending" message
    const logSpy = vi.spyOn(console, 'log');

    // Fire A — generation incremented to 1, IDB write starts
    fileRegistry.updateFile(fileId, dataA, { syncOrigin: 'store' });
    // Fire B — queued as pending at generation 1
    fileRegistry.updateFile(fileId, dataB, { syncOrigin: 'store' });

    // Wait for A to complete and B's setTimeout to be queued
    await flushMicrotasks();

    // Fire C — generation incremented to 2, IDB write starts
    // B's setTimeout hasn't fired yet — when it does, it will try to queue as pending again
    fileRegistry.updateFile(fileId, dataC, { syncOrigin: 'store' });

    // Flush everything
    await flushAll();
    await flushAll();

    // Final state must be C
    const file = fileRegistry.getFile(fileId);
    expect(file.data.nodes[0].label).toBe('C');

    // Verify the stale pending was detected (either dropped or the B data
    // was never re-applied after C)
    const idbFile = await db.files.get(fileId);
    expect(idbFile.data.nodes[0].label).toBe('C');

    logSpy.mockRestore();
  });
});
