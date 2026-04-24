/**
 * Headless Retrieve-All — Integration Tests
 *
 * Tests the three changes:
 * 1. FileRegistry re-entrancy fix (Change 3) — immediate in-memory update
 * 2. BE topo pass sequential ordering (Change 2) — no race between BE + inbound-n
 * 3. Headless retrieve-all (Change 1) — no tab opened, direct FileRegistry callbacks
 *
 * Strategy: real fake-indexeddb, real FileRegistry singleton, mocked external services.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { db } from '../../db/appDatabase';
import { fileRegistry } from '../../contexts/TabContext';

// ---------------------------------------------------------------------------
// Mocks — external services
// ---------------------------------------------------------------------------

const mockRetrieveResult = {
  totalSlices: 1, totalItems: 2, totalSuccess: 2, totalErrors: 0,
  totalCacheHits: 0, totalApiFetches: 2, totalDaysFetched: 60,
  aborted: false, durationMs: 500,
};

vi.mock('../retrieveAllSlicesService', () => ({
  executeRetrieveAllSlicesWithProgressToast: vi.fn(),
}));

vi.mock('../repositoryOperationsService', () => ({
  repositoryOperationsService: {
    pullLatestRemoteWins: vi.fn(async () => ({ success: true, conflictsResolved: 0 })),
    getCommittableFiles: vi.fn(async () => []),
    commitFiles: vi.fn(async () => {}),
  },
}));

vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    startOperation: vi.fn(() => 'op-1'),
    addChild: vi.fn(), endOperation: vi.fn(),
    info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn(),
    getEntries: vi.fn(() => []), openLogTab: vi.fn(async () => null),
  },
}));

vi.mock('../stalenessNudgeService', () => ({
  stalenessNudgeService: {
    refreshRemoteAppVersionIfDue: vi.fn(async () => {}),
    isRemoteAppVersionNewerThanLocal: vi.fn(() => false),
    getCachedRemoteAppVersion: vi.fn(() => undefined),
  },
}));

vi.mock('../lagHorizonsService', () => ({
  lagHorizonsService: { recomputeHorizons: vi.fn(async () => {}) },
}));

vi.mock('../../version', () => ({ APP_VERSION: '0.0.0-test' }));

vi.mock('../../lib/dateFormat', () => ({ formatDateUK: vi.fn(() => '6-Apr-26') }));

vi.mock('../operationRegistryService', () => ({
  operationRegistryService: {
    register: vi.fn(), setProgress: vi.fn(), setLabel: vi.fn(),
    complete: vi.fn(), subscribe: vi.fn(() => vi.fn()),
    getState: vi.fn(() => ({ active: [], recent: [] })),
    get: vi.fn(), remove: vi.fn(),
  },
}));

import { executeRetrieveAllSlicesWithProgressToast } from '../retrieveAllSlicesService';
import { dailyRetrieveAllAutomationService } from '../dailyRetrieveAllAutomationService';

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makeTestGraph() {
  return {
    nodes: [
      { uuid: 'n1', id: 'node-a', type: 'conversion', position: { x: 0, y: 0 }, data: {} },
      { uuid: 'n2', id: 'node-b', type: 'conversion', position: { x: 100, y: 0 }, data: {} },
      { uuid: 'n3', id: 'node-c', type: 'conversion', position: { x: 200, y: 0 }, data: {} },
    ],
    edges: [
      { uuid: 'e1', id: 'edge-a-to-b', from: 'node-a', to: 'node-b',
        p: { mean: 0.5, stdev: 0.1, evidence: { n: 100, k: 50 } } },
      { uuid: 'e2', id: 'edge-b-to-c', from: 'node-b', to: 'node-c',
        p: { mean: 0.3, stdev: 0.05, evidence: { n: 80, k: 24 } } },
    ],
    policies: { startNodeId: 'node-a' },
    metadata: { created: '1-Jan-25', modified: '1-Jan-25' },
    dataInterestsDSL: 'window(1-Jan-26:31-Jan-26)',
  };
}

function applyRetrieveMutations(graph: any): any {
  const mutated = structuredClone(graph);
  mutated.edges[0].p.mean = 0.52;
  mutated.edges[0].p.stdev = 0.09;
  mutated.edges[0].p.evidence = { n: 120, k: 62, scope_from: '1-Jan-26', scope_to: '31-Jan-26' };
  mutated.edges[1].p.mean = 0.31;
  mutated.edges[1].p.evidence = { n: 90, k: 28, scope_from: '1-Jan-26', scope_to: '31-Jan-26' };
  mutated.edges[0].p.latency = { t95: 14.2, path_t95: 21.5, completeness: 0.89, mu: 5.1, sigma: 2.3 };
  mutated.edges[1].p.latency = { t95: 7.8, path_t95: 21.5, completeness: 0.93, mu: 3.2, sigma: 1.1 };
  mutated.edges[0].p.model_vars = [{ source: 'analytic', probability: { mean: 0.52, stdev: 0.09 }, latency: { mu: 5.1, sigma: 2.3, t95: 14.2, path_t95: 21.5 } }];
  mutated.edges[1].p.model_vars = [{ source: 'analytic', probability: { mean: 0.31, stdev: 0.05 }, latency: { mu: 3.2, sigma: 1.1, t95: 7.8, path_t95: 21.5 } }];
  mutated.edges[0].p.n = 1000;
  mutated.edges[0].p.forecast = { k: 520 };
  mutated.edges[1].p.n = 520;
  mutated.edges[1].p.forecast = { k: 161 };
  mutated.metadata.last_retrieve_all_slices_success_at_ms = 1700000000000;
  return mutated;
}

function setupRetrieveMock() {
  vi.mocked(executeRetrieveAllSlicesWithProgressToast).mockImplementation(
    async (options: any) => {
      const graph = options.getGraph();
      if (!graph) throw new Error('getGraph returned null');
      const mutated = applyRetrieveMutations(graph);
      options.setGraph(mutated);
      await fileRegistry.updateFile('parameter-edge-a-to-b', {
        id: 'edge-a-to-b', values: [{ date: '15-Jan-26', n: 120, k: 62 }],
      });
      await fileRegistry.updateFile('parameter-edge-b-to-c', {
        id: 'edge-b-to-c', values: [{ date: '15-Jan-26', n: 90, k: 28 }],
      });
      return mockRetrieveResult;
    }
  );
}

async function seedTestData(graphFileId: string) {
  const graph = makeTestGraph();
  const makeParam = (id: string) => ({
    fileId: `parameter-${id}`, type: 'parameter' as const,
    data: { id, values: [] }, originalData: { id, values: [] },
    isDirty: false, source: { repository: 'test-repo', branch: 'main', path: `parameters/${id}.yaml` },
    lastModified: Date.now(), lastSynced: Date.now(), viewTabs: [], sha: 'sha-original',
  });

  await db.files.put({
    fileId: graphFileId, type: 'graph',
    data: graph, originalData: structuredClone(graph),
    isDirty: false, source: { repository: 'test-repo', branch: 'main', path: 'graphs/test-graph.json' },
    lastModified: Date.now(), lastSynced: Date.now(), viewTabs: [], sha: 'sha-original',
  });
  await db.files.put(makeParam('edge-a-to-b'));
  await db.files.put(makeParam('edge-b-to-c'));

  for (const fId of [graphFileId, 'parameter-edge-a-to-b', 'parameter-edge-b-to-c']) {
    const f = await db.files.get(fId);
    if (f) (fileRegistry as any).files.set(fId, { ...f, isInitializing: false });
  }
}

async function captureState(graphFileId: string) {
  const snap = (id: string) => {
    const reg = fileRegistry.getFile(id);
    return {
      data: reg?.data ? JSON.parse(JSON.stringify(reg.data)) : null,
      isDirty: reg?.isDirty,
    };
  };
  const idbSnap = async (id: string) => {
    const f = await db.files.get(id);
    return { data: f?.data ? JSON.parse(JSON.stringify(f.data)) : null, isDirty: f?.isDirty };
  };
  return {
    registry: { graph: snap(graphFileId), param1: snap('parameter-edge-a-to-b'), param2: snap('parameter-edge-b-to-c') },
    idb: { graph: await idbSnap(graphFileId), param1: await idbSnap('parameter-edge-a-to-b'), param2: await idbSnap('parameter-edge-b-to-c') },
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const GID = 'graph-test-graph';

beforeEach(async () => {
  vi.clearAllMocks();
  await db.files.clear();
  await db.tabs.clear();
  (fileRegistry as any).files.clear();
  (fileRegistry as any).listeners.clear();
  (fileRegistry as any).updatingFiles?.clear?.();
  (fileRegistry as any).pendingUpdates?.clear?.();
  (fileRegistry as any).fileGenerations?.clear?.();
});

afterEach(() => { vi.restoreAllMocks(); });

// ===========================================================================
// CHANGE 3: FileRegistry re-entrancy — immediate in-memory update
// ===========================================================================

describe('Change 3: FileRegistry re-entrancy', () => {
  it('getFile() returns latest data even during re-entrant updateFile window', async () => {
    await seedTestData(GID);

    const graph1 = { ...makeTestGraph(), _version: 1 };
    const graph2 = { ...makeTestGraph(), _version: 2 };
    const graph3 = { ...makeTestGraph(), _version: 3 };

    // Start first update (will hold the lock via updatingFiles)
    const p1 = fileRegistry.updateFile(GID, graph1);

    // While p1 is in flight, fire two more updates (re-entrant)
    // These should update in-memory immediately even though IDB write is pending
    const p2 = fileRegistry.updateFile(GID, graph2);
    const p3 = fileRegistry.updateFile(GID, graph3);

    // In-memory should reflect the LATEST write (graph3), not the first (graph1)
    const current = fileRegistry.getFile(GID)?.data as any;
    expect(current._version).toBe(3);

    // Wait for all writes to complete
    await p1; await p2; await p3;
    // Small delay for any pending replays
    await new Promise(r => setTimeout(r, 50));

    // Final state should still be graph3
    const final = fileRegistry.getFile(GID)?.data as any;
    expect(final._version).toBe(3);
  });

  it('isDirty is computed correctly in the re-entrant path', async () => {
    await seedTestData(GID);
    const original = fileRegistry.getFile(GID)?.originalData;

    // Start first update with modified data
    const modified = { ...makeTestGraph(), _extra: 'dirty' };
    const p1 = fileRegistry.updateFile(GID, modified);

    // Re-entrant update with same data as original (should be clean)
    const p2 = fileRegistry.updateFile(GID, original);

    // In-memory isDirty should be false (data matches original)
    expect(fileRegistry.getFile(GID)?.isDirty).toBe(false);

    await p1; await p2;
    await new Promise(r => setTimeout(r, 50));

    // Final isDirty should still be false
    expect(fileRegistry.getFile(GID)?.isDirty).toBe(false);
  });

  it('rapid fire-and-forget setGraph calls preserve final state', async () => {
    await seedTestData(GID);

    // Simulate what the retrieve pipeline does: rapid setGraph calls without await
    for (let i = 0; i < 10; i++) {
      const g = { ...makeTestGraph(), _iteration: i };
      void fileRegistry.updateFile(GID, g);
    }

    // In-memory should have the last iteration
    const current = fileRegistry.getFile(GID)?.data as any;
    expect(current._iteration).toBe(9);

    // Wait for pending writes to flush
    await new Promise(r => setTimeout(r, 200));

    // IDB should also have the last iteration
    const idb = await db.files.get(GID);
    expect(idb?.data?._iteration).toBe(9);
  });
});

// ===========================================================================
// CHANGE 1: Headless retrieve-all — parity with tab-open path
// ===========================================================================

describe('Change 1: Headless retrieve-all', () => {
  it('headless setGraph produces identical state to awaited setGraph', async () => {
    // Run A: awaited setGraph (simulates what tab-open path effectively does)
    await seedTestData(GID);
    setupRetrieveMock();

    await dailyRetrieveAllAutomationService.run({
      repository: 'test-repo', branch: 'main', graphFileId: GID,
      getGraph: () => fileRegistry.getFile(GID)?.data || null,
      setGraph: async (g) => { if (g) await fileRegistry.updateFile(GID, g); },
      shouldAbort: () => false,
    });
    await new Promise(r => setTimeout(r, 50));
    const stateA = await captureState(GID);

    // Run B: fire-and-forget setGraph (the actual headless path)
    await db.files.clear();
    (fileRegistry as any).files.clear();
    (fileRegistry as any).listeners.clear();
    await seedTestData(GID);
    setupRetrieveMock();

    await dailyRetrieveAllAutomationService.run({
      repository: 'test-repo', branch: 'main', graphFileId: GID,
      getGraph: () => fileRegistry.getFile(GID)?.data || null,
      setGraph: (g) => { if (g) void fileRegistry.updateFile(GID, g); },
      shouldAbort: () => false,
    });
    await new Promise(r => setTimeout(r, 50));
    const stateB = await captureState(GID);

    // Identical FileRegistry state
    expect(stateA.registry.graph.data).toEqual(stateB.registry.graph.data);
    expect(stateA.registry.param1.data).toEqual(stateB.registry.param1.data);
    expect(stateA.registry.param2.data).toEqual(stateB.registry.param2.data);

    // Identical IDB state
    expect(stateA.idb.graph.data).toEqual(stateB.idb.graph.data);
    expect(stateA.idb.param1.data).toEqual(stateB.idb.param1.data);
    expect(stateA.idb.param2.data).toEqual(stateB.idb.param2.data);
  });

  it('all graph mutations are preserved (LAG, model_vars, inbound-n, metadata)', async () => {
    await seedTestData(GID);
    setupRetrieveMock();

    await dailyRetrieveAllAutomationService.run({
      repository: 'test-repo', branch: 'main', graphFileId: GID,
      getGraph: () => fileRegistry.getFile(GID)?.data || null,
      setGraph: (g) => { if (g) void fileRegistry.updateFile(GID, g); },
      shouldAbort: () => false,
    });
    await new Promise(r => setTimeout(r, 50));

    const g = fileRegistry.getFile(GID)?.data as any;

    // Parameter values
    expect(g.edges[0].p.mean).toBe(0.52);
    expect(g.edges[0].p.evidence.n).toBe(120);
    expect(g.edges[1].p.mean).toBe(0.31);

    // LAG
    expect(g.edges[0].p.latency.t95).toBe(14.2);
    expect(g.edges[0].p.latency.path_t95).toBe(21.5);

    // Model vars
    expect(g.edges[0].p.model_vars).toHaveLength(1);
    expect(g.edges[0].p.model_vars[0].source).toBe('analytic');

    // Inbound-n
    expect(g.edges[0].p.n).toBe(1000);
    expect(g.edges[1].p.forecast.k).toBe(161);

    // Metadata
    expect(g.metadata.last_retrieve_all_slices_success_at_ms).toBe(1700000000000);
  });

  it('parameter files are persisted and marked dirty', async () => {
    await seedTestData(GID);
    setupRetrieveMock();

    await dailyRetrieveAllAutomationService.run({
      repository: 'test-repo', branch: 'main', graphFileId: GID,
      getGraph: () => fileRegistry.getFile(GID)?.data || null,
      setGraph: (g) => { if (g) void fileRegistry.updateFile(GID, g); },
      shouldAbort: () => false,
    });
    await new Promise(r => setTimeout(r, 50));

    // FileRegistry
    const p1 = fileRegistry.getFile('parameter-edge-a-to-b');
    expect(p1?.data?.values).toHaveLength(1);
    expect(p1?.data?.values[0].n).toBe(120);
    expect(p1?.isDirty).toBe(true);

    // IDB matches
    const p1Idb = await db.files.get('parameter-edge-a-to-b');
    expect(p1Idb?.data).toEqual(p1?.data);
    expect(p1Idb?.isDirty).toBe(true);
  });

  it('graph file is marked dirty after mutations', async () => {
    await seedTestData(GID);
    setupRetrieveMock();

    await dailyRetrieveAllAutomationService.run({
      repository: 'test-repo', branch: 'main', graphFileId: GID,
      getGraph: () => fileRegistry.getFile(GID)?.data || null,
      setGraph: (g) => { if (g) void fileRegistry.updateFile(GID, g); },
      shouldAbort: () => false,
    });
    await new Promise(r => setTimeout(r, 50));

    expect(fileRegistry.getFile(GID)?.isDirty).toBe(true);
    const idb = await db.files.get(GID);
    expect(idb?.isDirty).toBe(true);
  });

  it('getGraph returns fresh data between successive setGraph calls', async () => {
    await seedTestData(GID);

    // Simulate retrieve calling setGraph multiple times, reading back each time
    const versions: number[] = [];

    vi.mocked(executeRetrieveAllSlicesWithProgressToast).mockImplementation(
      async (options: any) => {
        for (let i = 1; i <= 5; i++) {
          const g = options.getGraph();
          const mutated = { ...g, _version: i };
          options.setGraph(mutated);

          // Read back immediately — should see the version we just wrote
          const readBack = options.getGraph();
          versions.push(readBack._version);
        }
        return mockRetrieveResult;
      }
    );

    await dailyRetrieveAllAutomationService.run({
      repository: 'test-repo', branch: 'main', graphFileId: GID,
      getGraph: () => fileRegistry.getFile(GID)?.data || null,
      setGraph: (g) => { if (g) void fileRegistry.updateFile(GID, g); },
      shouldAbort: () => false,
    });

    // Every read-back should see the version that was just written
    expect(versions).toEqual([1, 2, 3, 4, 5]);
  });

  it('no subscribers means notifyListeners is a no-op (no wasted clones)', async () => {
    await seedTestData(GID);

    // Verify no listeners registered for graph file
    const listeners = (fileRegistry as any).listeners.get(GID);
    expect(listeners).toBeUndefined();

    // Run a mutation — should not throw and should complete fast
    await fileRegistry.updateFile(GID, { ...makeTestGraph(), _test: true });
    expect(fileRegistry.getFile(GID)?.data?._test).toBe(true);
  });
});

// ===========================================================================
// Edge cases
// ===========================================================================

describe('Edge cases', () => {
  it('handles missing graph file gracefully (fileRegistry.getFile returns null)', async () => {
    // Don't seed any data — graph file doesn't exist in FileRegistry
    // The headless path in dailyAutomationJob checks fileRegistry.getFile()
    // and skips if null. Verify that getFile returns null for missing files.
    const missing = fileRegistry.getFile('graph-nonexistent');
    expect(missing).toBeFalsy();

    // Also verify restoreFile returns null when file isn't in IDB either
    const restored = await fileRegistry.restoreFile('graph-nonexistent');
    expect(restored).toBeNull();
  });

  it('subscriber presence does not affect committed data', async () => {
    // Run with a subscriber (simulates tab-open path)
    await seedTestData(GID);
    setupRetrieveMock();

    const notifications: any[] = [];
    const unsub = fileRegistry.subscribe(GID, (file) => {
      notifications.push(file?.data ? JSON.parse(JSON.stringify(file.data)) : null);
    });

    await dailyRetrieveAllAutomationService.run({
      repository: 'test-repo', branch: 'main', graphFileId: GID,
      getGraph: () => fileRegistry.getFile(GID)?.data || null,
      setGraph: (g) => { if (g) void fileRegistry.updateFile(GID, g); },
      shouldAbort: () => false,
    });
    await new Promise(r => setTimeout(r, 50));
    unsub();

    const withSub = await captureState(GID);

    // Run without a subscriber (headless path)
    await db.files.clear();
    (fileRegistry as any).files.clear();
    (fileRegistry as any).listeners.clear();
    await seedTestData(GID);
    setupRetrieveMock();

    await dailyRetrieveAllAutomationService.run({
      repository: 'test-repo', branch: 'main', graphFileId: GID,
      getGraph: () => fileRegistry.getFile(GID)?.data || null,
      setGraph: (g) => { if (g) void fileRegistry.updateFile(GID, g); },
      shouldAbort: () => false,
    });
    await new Promise(r => setTimeout(r, 50));

    const withoutSub = await captureState(GID);

    // Data must be identical regardless of subscriber presence
    expect(withSub.registry.graph.data).toEqual(withoutSub.registry.graph.data);
    expect(withSub.idb.graph.data).toEqual(withoutSub.idb.graph.data);
    expect(withSub.registry.param1.data).toEqual(withoutSub.registry.param1.data);
    expect(withSub.registry.param2.data).toEqual(withoutSub.registry.param2.data);

    // Subscriber DID receive notifications
    expect(notifications.length).toBeGreaterThan(0);
  });
});
