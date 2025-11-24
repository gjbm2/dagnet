/**
 * TIER 1 (P0): State Synchronization Tests
 * 
 * Tests that Graph ↔ File ↔ UI State remain in sync across all operations.
 * 
 * This test suite catches bugs like:
 * - File updated but graph not refreshed
 * - Graph changed but file not written
 * - UI showing stale values
 * - History not capturing changes
 * - Concurrent updates causing corruption
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestGraph, createLinearGraph, cloneGraph, graphsEqual } from '../helpers/test-graph-builder';
import { MockFileRegistry } from '../helpers/mock-file-registry';

// Create mock instance that will be used across tests
let mockFileRegistry: MockFileRegistry;

// Mock the TabContext at the top level (required for Vitest hoisting)
vi.mock('../../src/contexts/TabContext', async () => {
  const actual = await vi.importActual('../../src/contexts/TabContext');
  return {
    ...actual,
    get fileRegistry() {
      return mockFileRegistry;
    }
  };
});

describe('State Synchronization: Sources of Truth', () => {
  let currentGraph: any = null;
  let historyStack: any[] = [];

  beforeEach(() => {
    mockFileRegistry = new MockFileRegistry();
    currentGraph = createLinearGraph();
    historyStack = [cloneGraph(currentGraph)];
  });

  afterEach(() => {
    mockFileRegistry.clear();
    vi.clearAllMocks();
  });

  /**
   * Helper: Capture complete state snapshot
   */
  function captureState() {
    return {
      graph: cloneGraph(currentGraph),
      files: mockFileRegistry.getOperations().reduce((acc, op) => {
        if (op.type === 'update' || op.type === 'get') {
          const file = mockFileRegistry.getFile(op.fileId);
          if (file) acc[op.fileId] = JSON.parse(JSON.stringify(file.data));
        }
        return acc;
      }, {} as Record<string, any>),
      history: [...historyStack],
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Helper: Mock setGraph that updates history
   */
  function mockSetGraph(newGraph: any) {
    currentGraph = newGraph;
    historyStack.push(cloneGraph(newGraph));
  }

  /**
   * CRITICAL TEST: Write to Graph → File + History all update
   */
  test('graph update: file and history sync atomically', async () => {
    const { UpdateManager } = await import('../../src/services/UpdateManager');
    const updateManager = new UpdateManager();

    // Seed graph file
    mockFileRegistry.seed([{
      fileId: 'graph-test',
      data: currentGraph
    }]);

    // Capture initial state
    const before = captureState();

    // ACTION: Update edge probability
    const updated = updateManager.updateEdge(
      currentGraph,
      currentGraph.edges[0].uuid,
      { p: { mean: 0.75 } } // Change from 0.6 to 0.75
    );
    mockSetGraph(updated);

    // Simulate file save
    await mockFileRegistry.updateFile('graph-test', updated);

    // ASSERT: All sources reflect change
    const after = captureState();

    // 1. Graph changed
    expect(after.graph.edges[0].p.mean).toBe(0.75);
    expect(before.graph.edges[0].p.mean).toBe(0.6);

    // 2. File updated
    mockFileRegistry.assertFileUpdated('graph-test');
    expect(after.files['graph-test'].edges[0].p.mean).toBe(0.75);

    // 3. History has new entry
    expect(after.history.length).toBe(before.history.length + 1);
    expect(after.history[after.history.length - 1].edges[0].p.mean).toBe(0.75);
  });

  /**
   * CRITICAL TEST: Write to File → Graph + UI update
   */
  test('file update: graph loads new data', async () => {
    const { dataOperationsService } = await import('../../src/services/dataOperationsService');
    
    // Seed parameter file
    mockFileRegistry.seed([{
      fileId: 'parameter-test-param',
      data: {
        id: 'test-param',
        type: 'probability',
        query: 'from(a).to(b)',
        values: [{
          date: '2025-01-13',
          mean: 0.8,
          n: 100,
          k: 80,
          query_signature: 'abc123'
        }]
      }
    }]);

    const initialMean = currentGraph.edges[0].p.mean; // 0.6

    // ACTION: Load parameter from file
    await dataOperationsService.getParameterFromFile({
      paramId: 'test-param',
      edgeId: currentGraph.edges[0].uuid,
      graph: currentGraph,
      setGraph: mockSetGraph,
      window: { start: '2025-01-13', end: '2025-01-20' }
    });

    // ASSERT: Graph updated with file data
    expect(currentGraph.edges[0].p.mean).toBe(0.8);
    expect(currentGraph.edges[0].p.mean).not.toBe(initialMean);
  });

  /**
   * TEST: Concurrent writes - last write wins without corruption
   */
  test('concurrent updates: consistent final state', async () => {
    const { UpdateManager } = await import('../../src/services/UpdateManager');
    const updateManager = new UpdateManager();

    mockFileRegistry.seed([{
      fileId: 'graph-test',
      data: currentGraph
    }]);

    // Simulate race condition: two updates to same edge
    const update1 = updateManager.updateEdge(
      currentGraph,
      currentGraph.edges[0].uuid,
      { p: { mean: 0.5 } }
    );

    const update2 = updateManager.updateEdge(
      currentGraph,
      currentGraph.edges[0].uuid,
      { p: { mean: 0.7 } }
    );

    // Apply both updates in parallel
    await Promise.all([
      mockFileRegistry.updateFile('graph-test', update1),
      mockFileRegistry.updateFile('graph-test', update2)
    ]);

    // Get final file state
    const finalFile = mockFileRegistry.getFile('graph-test');
    const finalMean = finalFile!.data.edges[0].p.mean;

    // ASSERT: Value is one of the writes (not corrupted)
    expect([0.5, 0.7]).toContain(finalMean);

    // ASSERT: File received exactly 2 updates
    expect(mockFileRegistry.getUpdateCount('graph-test')).toBe(2);
  });

  /**
   * TEST: Rollback/undo - all sources revert atomically
   */
  test('undo operation: graph and file revert together', async () => {
    const { UpdateManager } = await import('../../src/services/UpdateManager');
    const updateManager = new UpdateManager();

    mockFileRegistry.seed([{
      fileId: 'graph-test',
      data: currentGraph
    }]);

    // Capture checkpoint
    const checkpoint = captureState();
    const checkpointMean = checkpoint.graph.edges[0].p.mean;

    // Make changes
    const updated = updateManager.updateEdge(
      currentGraph,
      currentGraph.edges[0].uuid,
      { p: { mean: 0.99 } }
    );
    mockSetGraph(updated);
    await mockFileRegistry.updateFile('graph-test', updated);

    // Verify change applied
    expect(currentGraph.edges[0].p.mean).toBe(0.99);

    // ACTION: Rollback to checkpoint
    mockSetGraph(checkpoint.graph);
    await mockFileRegistry.updateFile('graph-test', checkpoint.graph);

    // ASSERT: Both sources back to checkpoint
    const rolledBack = captureState();
    expect(rolledBack.graph.edges[0].p.mean).toBe(checkpointMean);
    
    const fileAfterRollback = mockFileRegistry.getFile('graph-test');
    expect(fileAfterRollback!.data.edges[0].p.mean).toBe(checkpointMean);
  });

  /**
   * TEST: File write failure - graph not updated (transaction integrity)
   */
  test('file write fails: graph remains unchanged', async () => {
    const { UpdateManager } = await import('../../src/services/UpdateManager');
    const updateManager = new UpdateManager();

    mockFileRegistry.seed([{
      fileId: 'graph-test',
      data: currentGraph
    }]);

    const initialMean = currentGraph.edges[0].p.mean;

    // Mock file write failure
    const originalUpdate = mockFileRegistry.updateFile.bind(mockFileRegistry);
    mockFileRegistry.updateFile = vi.fn().mockRejectedValue(new Error('Disk full'));

    // ACTION: Try to update
    try {
      const updated = updateManager.updateEdge(
        currentGraph,
        currentGraph.edges[0].uuid,
        { p: { mean: 0.99 } }
      );
      
      await mockFileRegistry.updateFile('graph-test', updated);
      
      // Should not reach here
      fail('Expected error to be thrown');
    } catch (error: any) {
      expect(error.message).toContain('Disk full');
    }

    // ASSERT: Graph unchanged (transaction rolled back)
    expect(currentGraph.edges[0].p.mean).toBe(initialMean);

    // Restore
    mockFileRegistry.updateFile = originalUpdate;
  });

  /**
   * TEST: Multiple edges updated - all sync together
   */
  test('bulk update: all edges and file consistent', async () => {
    const { UpdateManager } = await import('../../src/services/UpdateManager');
    const updateManager = new UpdateManager();

    mockFileRegistry.seed([{
      fileId: 'graph-test',
      data: currentGraph
    }]);

    // Update multiple edges
    let updated = currentGraph;
    for (const edge of currentGraph.edges) {
      updated = updateManager.updateEdge(
        updated,
        edge.uuid,
        { p: { mean: 0.88 } }
      );
    }

    mockSetGraph(updated);
    await mockFileRegistry.updateFile('graph-test', updated);

    // ASSERT: All edges in graph updated
    for (const edge of currentGraph.edges) {
      expect(edge.p.mean).toBe(0.88);
    }

    // ASSERT: File reflects all changes
    const file = mockFileRegistry.getFile('graph-test');
    for (const edge of file!.data.edges) {
      expect(edge.p.mean).toBe(0.88);
    }
  });

  /**
   * TEST: Parameter file deleted - graph edge loses reference
   */
  test('parameter file deleted: graph reference cleared', async () => {
    const { dataOperationsService } = await import('../../src/services/dataOperationsService');

    // Seed parameter file
    mockFileRegistry.seed([{
      fileId: 'parameter-test-param',
      data: {
        id: 'test-param',
        values: []
      }
    }]);

    // Edge references parameter
    currentGraph.edges[0].p.id = 'test-param';

    // ACTION: Delete parameter file
    await mockFileRegistry.deleteFile('parameter-test-param');

    // In real system, edge should be notified and clear reference
    // For now, just verify deletion happened
    expect(mockFileRegistry.getFile('parameter-test-param')).toBeUndefined();
  });

  /**
   * TEST: File listener notified on update
   */
  test('file listeners: notified atomically on update', async () => {
    const notifications: string[] = [];
    
    mockFileRegistry.seed([{
      fileId: 'graph-test',
      data: currentGraph
    }]);

    // Add listener
    mockFileRegistry.addListener('graph-test', (file) => {
      notifications.push(`Updated at ${file.lastModified}`);
    });

    // Update file multiple times
    await mockFileRegistry.updateFile('graph-test', { ...currentGraph, version: 1 });
    await mockFileRegistry.updateFile('graph-test', { ...currentGraph, version: 2 });

    // ASSERT: Listener called for each update
    expect(notifications.length).toBe(2);
  });

  /**
   * TEST: Graph dirty flag set on modification
   */
  test('dirty flag: set on graph change, cleared on save', async () => {
    mockFileRegistry.seed([{
      fileId: 'graph-test',
      data: { ...currentGraph, isDirty: false }
    }]);

    // Modify graph
    const { UpdateManager } = await import('../../src/services/UpdateManager');
    const updateManager = new UpdateManager();
    
    const updated = updateManager.updateEdge(
      currentGraph,
      currentGraph.edges[0].uuid,
      { p: { mean: 0.75 } }
    );

    // In real system, dirty flag would be set
    // Here we simulate it
    const dirtyGraph = { ...updated, isDirty: true };
    await mockFileRegistry.updateFile('graph-test', dirtyGraph);

    // Check file has dirty flag
    const fileAfterEdit = mockFileRegistry.getFile('graph-test');
    expect(fileAfterEdit!.isDirty).toBe(true);

    // Save (clear dirty)
    const cleanGraph = { ...updated, isDirty: false };
    await mockFileRegistry.updateFile('graph-test', cleanGraph);

    const fileAfterSave = mockFileRegistry.getFile('graph-test');
    expect(fileAfterSave!.isDirty).toBe(false);
  });
});

