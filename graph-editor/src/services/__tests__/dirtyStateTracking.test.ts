/**
 * Dirty State Tracking Tests
 * 
 * Tests the fundamental dirty state tracking mechanism in the file registry.
 * These tests verify that graph modifications properly trigger dirty state.
 * 
 * This is a CRITICAL test file - dirty tracking is essential for:
 * - Showing unsaved indicators in UI
 * - Prompting users before losing changes
 * - Git commit workflows (identifying changed files)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileRegistry } from '../../contexts/TabContext';
import { db } from '../../db/appDatabase';

// Mock IndexedDB
vi.mock('../../db/appDatabase', () => ({
  db: {
    files: {
      put: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(undefined),
      where: vi.fn(() => ({
        equals: vi.fn(() => ({
          and: vi.fn(() => ({
            toArray: vi.fn().mockResolvedValue([]),
          })),
          toArray: vi.fn().mockResolvedValue([]),
        })),
      })),
      toArray: vi.fn().mockResolvedValue([]),
    },
    workspaces: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

// Test graph data
const createTestGraph = () => ({
  schema: 'graph-v1',
  metadata: {
    id: 'test-graph',
    name: 'Test Graph',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  nodes: [
    {
      uuid: 'node-1',
      id: 'start',
      label: 'Start',
      absorbing: false,
      entry: { is_start: true },
      layout: { x: 100, y: 100 },
    },
    {
      uuid: 'node-2', 
      id: 'end',
      label: 'End',
      absorbing: true,
      layout: { x: 300, y: 100 },
    },
  ],
  edges: [
    {
      uuid: 'edge-1',
      id: 'start->end',
      from: 'node-1',
      to: 'node-2',
      p: { mean: 0.5 },
      fromHandle: 'right-out',
      toHandle: 'left',
    },
  ],
});

describe('Dirty State Tracking', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Clear file registry
    (fileRegistry as any).files.clear();
    (fileRegistry as any).listeners.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Initial State', () => {
    it('should start with isDirty=false for new files', async () => {
      const graph = createTestGraph();
      const file = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/test.json',
        },
        graph
      );

      expect(file.isDirty).toBe(false);
      expect(file.data).toEqual(graph);
      expect(file.originalData).toEqual(graph);
    });

    it('should preserve isDirty=false when initialization completes', async () => {
      const graph = createTestGraph();
      const file = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/test.json',
        },
        graph
      );

      // Complete initialization (simulates form normalization completing)
      await fileRegistry.completeInitialization('graph-test');

      expect(file.isDirty).toBe(false);
      expect(file.isInitializing).toBe(false);
    });
  });

  describe('Node Operations', () => {
    it('should mark graph dirty when adding a node', async () => {
      const graph = createTestGraph();
      const file = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/test.json',
        },
        graph
      );

      // Complete initialization first
      await fileRegistry.completeInitialization('graph-test');
      expect(file.isDirty).toBe(false);

      // Add a new node
      const modifiedGraph = structuredClone(graph);
      modifiedGraph.nodes.push({
        uuid: 'node-3',
        id: 'new-node',
        label: 'New Node',
        absorbing: false,
        layout: { x: 200, y: 200 },
      });
      modifiedGraph.metadata.updated_at = new Date().toISOString();

      await fileRegistry.updateFile('graph-test', modifiedGraph);

      expect(file.isDirty).toBe(true);
      expect(file.data.nodes.length).toBe(3);
    });

    it('should mark graph dirty when deleting a node', async () => {
      const graph = createTestGraph();
      const file = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/test.json',
        },
        graph
      );

      await fileRegistry.completeInitialization('graph-test');
      expect(file.isDirty).toBe(false);

      // Delete a node
      const modifiedGraph = structuredClone(graph);
      modifiedGraph.nodes = modifiedGraph.nodes.filter(n => n.uuid !== 'node-2');
      modifiedGraph.edges = []; // Remove edge since target is deleted
      modifiedGraph.metadata.updated_at = new Date().toISOString();

      await fileRegistry.updateFile('graph-test', modifiedGraph);

      expect(file.isDirty).toBe(true);
      expect(file.data.nodes.length).toBe(1);
    });

    it('should mark graph dirty when updating node properties', async () => {
      const graph = createTestGraph();
      const file = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/test.json',
        },
        graph
      );

      await fileRegistry.completeInitialization('graph-test');
      expect(file.isDirty).toBe(false);

      // Update node label
      const modifiedGraph = structuredClone(graph);
      modifiedGraph.nodes[0].label = 'Updated Label';
      modifiedGraph.metadata.updated_at = new Date().toISOString();

      await fileRegistry.updateFile('graph-test', modifiedGraph);

      expect(file.isDirty).toBe(true);
      expect(file.data.nodes[0].label).toBe('Updated Label');
    });

    it('should mark graph dirty when moving a node', async () => {
      const graph = createTestGraph();
      const file = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/test.json',
        },
        graph
      );

      await fileRegistry.completeInitialization('graph-test');
      expect(file.isDirty).toBe(false);

      // Move node to new position
      const modifiedGraph = structuredClone(graph);
      modifiedGraph.nodes[0].layout = { x: 500, y: 500 };
      modifiedGraph.metadata.updated_at = new Date().toISOString();

      await fileRegistry.updateFile('graph-test', modifiedGraph);

      expect(file.isDirty).toBe(true);
    });
  });

  describe('Edge Operations', () => {
    it('should mark graph dirty when adding an edge', async () => {
      // Create graph with multiple nodes but only one edge
      const graph = createTestGraph();
      graph.nodes.push({
        uuid: 'node-3',
        id: 'middle',
        label: 'Middle',
        absorbing: false,
        layout: { x: 200, y: 100 },
      });

      const file = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/test.json',
        },
        graph
      );

      await fileRegistry.completeInitialization('graph-test');
      expect(file.isDirty).toBe(false);

      // Add a new edge
      const modifiedGraph = structuredClone(graph);
      modifiedGraph.edges.push({
        uuid: 'edge-2',
        id: 'start->middle',
        from: 'node-1',
        to: 'node-3',
        p: { mean: 0.3 },
        fromHandle: 'bottom-out',
        toHandle: 'top',
      });
      modifiedGraph.metadata.updated_at = new Date().toISOString();

      await fileRegistry.updateFile('graph-test', modifiedGraph);

      expect(file.isDirty).toBe(true);
      expect(file.data.edges.length).toBe(2);
    });

    it('should mark graph dirty when deleting an edge', async () => {
      const graph = createTestGraph();
      const file = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/test.json',
        },
        graph
      );

      await fileRegistry.completeInitialization('graph-test');
      expect(file.isDirty).toBe(false);

      // Delete edge
      const modifiedGraph = structuredClone(graph);
      modifiedGraph.edges = [];
      modifiedGraph.metadata.updated_at = new Date().toISOString();

      await fileRegistry.updateFile('graph-test', modifiedGraph);

      expect(file.isDirty).toBe(true);
      expect(file.data.edges.length).toBe(0);
    });

    it('should mark graph dirty when updating edge probability', async () => {
      const graph = createTestGraph();
      const file = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/test.json',
        },
        graph
      );

      await fileRegistry.completeInitialization('graph-test');
      expect(file.isDirty).toBe(false);

      // Update edge probability
      const modifiedGraph = structuredClone(graph);
      modifiedGraph.edges[0].p.mean = 0.75;
      modifiedGraph.metadata.updated_at = new Date().toISOString();

      await fileRegistry.updateFile('graph-test', modifiedGraph);

      expect(file.isDirty).toBe(true);
      expect(file.data.edges[0].p.mean).toBe(0.75);
    });

    it('should mark graph dirty when reconnecting edge to different handle', async () => {
      const graph = createTestGraph();
      const file = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/test.json',
        },
        graph
      );

      await fileRegistry.completeInitialization('graph-test');
      expect(file.isDirty).toBe(false);

      // Change edge handle (reconnect to different face)
      const modifiedGraph = structuredClone(graph);
      modifiedGraph.edges[0].fromHandle = 'bottom-out'; // Changed from 'right-out'
      modifiedGraph.metadata.updated_at = new Date().toISOString();

      await fileRegistry.updateFile('graph-test', modifiedGraph);

      expect(file.isDirty).toBe(true);
      expect(file.data.edges[0].fromHandle).toBe('bottom-out');
    });

    it('should mark graph dirty when reconnecting edge to different node', async () => {
      const graph = createTestGraph();
      graph.nodes.push({
        uuid: 'node-3',
        id: 'alternate',
        label: 'Alternate End',
        absorbing: true,
        layout: { x: 300, y: 200 },
      });

      const file = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/test.json',
        },
        graph
      );

      await fileRegistry.completeInitialization('graph-test');
      expect(file.isDirty).toBe(false);

      // Reconnect edge to different target node
      const modifiedGraph = structuredClone(graph);
      modifiedGraph.edges[0].to = 'node-3';
      modifiedGraph.edges[0].id = 'start->alternate';
      modifiedGraph.metadata.updated_at = new Date().toISOString();

      await fileRegistry.updateFile('graph-test', modifiedGraph);

      expect(file.isDirty).toBe(true);
      expect(file.data.edges[0].to).toBe('node-3');
    });
  });

  describe('Revert Operations', () => {
    it('should clear dirty state when reverting', async () => {
      const graph = createTestGraph();
      const file = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/test.json',
        },
        graph
      );

      await fileRegistry.completeInitialization('graph-test');

      // Make a change
      const modifiedGraph = structuredClone(graph);
      modifiedGraph.nodes.push({
        uuid: 'node-new',
        id: 'new',
        label: 'New',
        absorbing: false,
        layout: { x: 400, y: 400 },
      });

      await fileRegistry.updateFile('graph-test', modifiedGraph);
      expect(file.isDirty).toBe(true);
      expect(file.data.nodes.length).toBe(3);

      // Revert
      await fileRegistry.revertFile('graph-test');

      expect(file.isDirty).toBe(false);
      expect(file.data.nodes.length).toBe(2); // Back to original
      expect(file.data).toEqual(graph);
    });

    it('should restore original data structure when reverting', async () => {
      const graph = createTestGraph();
      const file = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/test.json',
        },
        graph
      );

      await fileRegistry.completeInitialization('graph-test');

      // Make multiple changes
      const modifiedGraph = structuredClone(graph);
      modifiedGraph.nodes[0].label = 'Changed Label';
      modifiedGraph.edges[0].p.mean = 0.99;
      modifiedGraph.metadata.updated_at = new Date().toISOString();

      await fileRegistry.updateFile('graph-test', modifiedGraph);
      expect(file.isDirty).toBe(true);

      // Revert
      await fileRegistry.revertFile('graph-test');

      expect(file.isDirty).toBe(false);
      expect(file.data.nodes[0].label).toBe('Start');
      expect(file.data.edges[0].p.mean).toBe(0.5);
    });
  });

  describe('Dirty State Events', () => {
    it('should emit dagnet:fileDirtyChanged event when dirty state changes', async () => {
      const graph = createTestGraph();
      const file = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/test.json',
        },
        graph
      );

      await fileRegistry.completeInitialization('graph-test');

      const eventListener = vi.fn();
      window.addEventListener('dagnet:fileDirtyChanged', eventListener);

      // Make a change to trigger dirty
      const modifiedGraph = structuredClone(graph);
      modifiedGraph.nodes[0].label = 'Changed';
      await fileRegistry.updateFile('graph-test', modifiedGraph);

      expect(eventListener).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: { fileId: 'graph-test', isDirty: true }
        })
      );

      window.removeEventListener('dagnet:fileDirtyChanged', eventListener);
    });

    it('should emit dagnet:fileDirtyChanged event when reverting', async () => {
      const graph = createTestGraph();
      const file = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/test.json',
        },
        graph
      );

      await fileRegistry.completeInitialization('graph-test');

      // Make dirty first
      const modifiedGraph = structuredClone(graph);
      modifiedGraph.nodes[0].label = 'Changed';
      await fileRegistry.updateFile('graph-test', modifiedGraph);

      const eventListener = vi.fn();
      window.addEventListener('dagnet:fileDirtyChanged', eventListener);

      // Revert
      await fileRegistry.revertFile('graph-test');

      expect(eventListener).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: { fileId: 'graph-test', isDirty: false }
        })
      );

      window.removeEventListener('dagnet:fileDirtyChanged', eventListener);
    });
  });

  describe('Save Operations', () => {
    it('should clear dirty state when marked as saved', async () => {
      const graph = createTestGraph();
      const file = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/test.json',
        },
        graph
      );

      await fileRegistry.completeInitialization('graph-test');

      // Make a change
      const modifiedGraph = structuredClone(graph);
      modifiedGraph.nodes[0].label = 'Changed';
      await fileRegistry.updateFile('graph-test', modifiedGraph);
      expect(file.isDirty).toBe(true);

      // Mark as saved
      await fileRegistry.markSaved('graph-test');

      expect(file.isDirty).toBe(false);
      // Original data should now match current data
      expect(JSON.stringify(file.originalData)).toBe(JSON.stringify(file.data));
    });

    it('should update originalData to match current data on save', async () => {
      const graph = createTestGraph();
      const file = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/test.json',
        },
        graph
      );

      await fileRegistry.completeInitialization('graph-test');

      // Make a change
      const modifiedGraph = structuredClone(graph);
      modifiedGraph.nodes.push({
        uuid: 'node-new',
        id: 'new',
        label: 'New Node',
        absorbing: false,
        layout: { x: 400, y: 400 },
      });
      await fileRegistry.updateFile('graph-test', modifiedGraph);

      // Save
      await fileRegistry.markSaved('graph-test');

      // Make another change
      const furtherModifiedGraph = structuredClone(file.data);
      furtherModifiedGraph.nodes.push({
        uuid: 'node-another',
        id: 'another',
        label: 'Another Node',
        absorbing: false,
        layout: { x: 500, y: 500 },
      });
      await fileRegistry.updateFile('graph-test', furtherModifiedGraph);

      expect(file.isDirty).toBe(true);

      // Revert should go back to the SAVED state, not the original
      await fileRegistry.revertFile('graph-test');

      expect(file.isDirty).toBe(false);
      expect(file.data.nodes.length).toBe(3); // 2 original + 1 added before save
    });
  });

  describe('Initialization Period', () => {
    it('should mark dirty for ANY change (simplified dirty tracking)', async () => {
      // NOTE: We removed the complex "initialization period" logic that suppressed
      // dirty state for non-structural changes. This was causing bugs where node
      // moves and other changes weren't being tracked. Now ALL changes mark dirty.
      const graph = createTestGraph();
      const file = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/test.json',
        },
        graph
      );

      // Make a change
      const modifiedGraph = structuredClone(graph);
      modifiedGraph.nodes[0].label = 'Changed';
      await fileRegistry.updateFile('graph-test', modifiedGraph);

      // Should BE dirty - any change marks dirty now
      expect(file.isDirty).toBe(true);
      
      // Data should be updated
      expect(file.data.nodes[0].label).toBe('Changed');
    });

    it('should mark dirty for structural changes (adding nodes)', async () => {
      const graph = createTestGraph();
      const file = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/test.json',
        },
        graph
      );

      // Make a STRUCTURAL change (add a node)
      const modifiedGraph = structuredClone(graph);
      modifiedGraph.nodes.push({
        uuid: 'node-new',
        id: 'new-node',
        label: 'New Node',
        absorbing: false,
        layout: { x: 400, y: 400 },
      });
      await fileRegistry.updateFile('graph-test', modifiedGraph);

      // Should be dirty
      expect(file.isDirty).toBe(true);
      
      // Data should have the new node
      expect(file.data.nodes.length).toBe(3);
      
      // Original data should NOT have the new node (it keeps the original)
      expect(file.originalData.nodes.length).toBe(2);
    });

    it('should start tracking dirty after initialization completes', async () => {
      const graph = createTestGraph();
      const file = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        {
          repository: 'test-repo',
          branch: 'main',
          path: 'graphs/test.json',
        },
        graph
      );

      // Complete initialization
      await fileRegistry.completeInitialization('graph-test');
      expect(file.isInitializing).toBe(false);

      // Now changes should mark dirty
      const modifiedGraph = structuredClone(graph);
      modifiedGraph.nodes[0].label = 'Changed After Init';
      await fileRegistry.updateFile('graph-test', modifiedGraph);

      expect(file.isDirty).toBe(true);
    });
  });
});

