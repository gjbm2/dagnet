/**
 * Graph Store Sync Integration Tests
 * 
 * Tests the synchronization between GraphStore (Zustand) and FileRegistry.
 * This tests the full flow: GraphCanvas → setGraph → sync effect → updateFile → dirty state
 * 
 * These tests verify that changes made in the graph editor properly propagate
 * to the file registry and trigger dirty state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileRegistry } from '../../contexts/TabContext';
import { db } from '../../db/appDatabase';
import { createGraphStore, GraphStore } from '../../contexts/GraphStoreContext';

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
    getTabsForFile: vi.fn().mockResolvedValue([]),
  },
}));

// Test graph data
const createTestGraph = () => ({
  schema: 'graph-v1',
  metadata: {
    id: 'test-graph',
    name: 'Test Graph',
    version: '1.0',
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
  policies: { default_outcome: 'end' },
});

describe('Graph Store Sync Integration Tests', () => {
  let graphStore: ReturnType<typeof createGraphStore>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Clear file registry
    (fileRegistry as any).files.clear();
    (fileRegistry as any).listeners.clear();
    
    // Create fresh graph store
    graphStore = createGraphStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GraphStore to FileRegistry Sync Flow', () => {
    it('should simulate the complete add node flow', async () => {
      const graph = createTestGraph();
      
      // Step 1: Register file in FileRegistry (simulates file loading)
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
      
      // Step 2: Load graph into store (simulates file→store sync in GraphEditor)
      graphStore.getState().setGraph(graph);
      expect(graphStore.getState().graph).toEqual(graph);
      
      // Step 3: Simulate addNode in GraphCanvas
      const currentGraph = graphStore.getState().graph!;
      const nextGraph = structuredClone(currentGraph);
      nextGraph.nodes.push({
        uuid: 'node-new',
        id: 'new-node',
        label: 'New Node',
        absorbing: false,
        layout: { x: 200, y: 200 },
      });
      nextGraph.metadata.updated_at = new Date().toISOString();
      
      graphStore.getState().setGraph(nextGraph);
      expect(graphStore.getState().graph!.nodes.length).toBe(3);
      
      // Step 4: Simulate store→file sync effect (what GraphEditor does)
      // This is what happens in the useEffect with [graph, data, updateData] deps
      const storeGraph = graphStore.getState().graph!;
      const fileData = file.data;
      
      // The effect checks: if (graphStr !== dataStr) { updateData(graph) }
      const graphStr = JSON.stringify(storeGraph);
      const dataStr = JSON.stringify(fileData);
      
      if (graphStr !== dataStr) {
        // This is what updateData does
        await fileRegistry.updateFile('graph-test', storeGraph);
      }
      
      // Step 5: Verify dirty state
      expect(file.isDirty).toBe(true);
      expect(file.data.nodes.length).toBe(3);
    });

    it('should detect changes between store graph and file data', async () => {
      const graph = createTestGraph();
      
      // Setup
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
      graphStore.getState().setGraph(graph);
      
      // Initially, store and file should match
      expect(JSON.stringify(graphStore.getState().graph)).toBe(JSON.stringify(file.data));
      
      // Modify graph in store
      const nextGraph = structuredClone(graph);
      nextGraph.nodes[0].label = 'Modified Label';
      graphStore.getState().setGraph(nextGraph);
      
      // Now they should differ
      expect(JSON.stringify(graphStore.getState().graph)).not.toBe(JSON.stringify(file.data));
    });

    it('should handle edge reconnection sync', async () => {
      const graph = createTestGraph();
      graph.nodes.push({
        uuid: 'node-3',
        id: 'alternate',
        label: 'Alternate',
        absorbing: true,
        layout: { x: 400, y: 100 },
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
      graphStore.getState().setGraph(graph);
      
      // Simulate edge reconnection (handleReconnect in GraphCanvas)
      const nextGraph = structuredClone(graphStore.getState().graph!);
      nextGraph.edges[0].to = 'node-3';
      nextGraph.edges[0].toHandle = 'bottom';
      nextGraph.metadata.updated_at = new Date().toISOString();
      
      graphStore.getState().setGraph(nextGraph);
      
      // Simulate sync
      await fileRegistry.updateFile('graph-test', graphStore.getState().graph!);
      
      expect(file.isDirty).toBe(true);
      expect(file.data.edges[0].to).toBe('node-3');
      expect(file.data.edges[0].toHandle).toBe('bottom');
    });
  });

  describe('Sync Blocking Scenarios', () => {
    it('should correctly identify when graph and file differ', () => {
      const graph1 = createTestGraph();
      const graph2 = structuredClone(graph1);
      
      // Same content should be equal
      expect(JSON.stringify(graph1)).toBe(JSON.stringify(graph2));
      
      // Modification should make them different
      graph2.nodes[0].label = 'Changed';
      expect(JSON.stringify(graph1)).not.toBe(JSON.stringify(graph2));
    });

    it('should correctly handle structuredClone for comparison', () => {
      const graph = createTestGraph();
      const cloned = structuredClone(graph);
      
      // Clone should be deeply equal but different object
      expect(graph).not.toBe(cloned);
      expect(JSON.stringify(graph)).toBe(JSON.stringify(cloned));
      
      // Modifying clone should not affect original
      cloned.nodes.push({
        uuid: 'new',
        id: 'new',
        label: 'New',
        absorbing: false,
        layout: { x: 0, y: 0 },
      });
      
      expect(graph.nodes.length).toBe(2);
      expect(cloned.nodes.length).toBe(3);
    });
  });

  describe('History State Management', () => {
    it('should save history when graph changes', () => {
      const graph = createTestGraph();
      graphStore.getState().setGraph(graph);
      
      // Save initial state
      graphStore.getState().saveHistoryState('Initial load');
      expect(graphStore.getState().canUndo).toBe(false); // First state, nothing to undo
      
      // Make a change
      const nextGraph = structuredClone(graph);
      nextGraph.nodes.push({
        uuid: 'new',
        id: 'new',
        label: 'New',
        absorbing: false,
        layout: { x: 0, y: 0 },
      });
      graphStore.getState().setGraph(nextGraph);
      graphStore.getState().saveHistoryState('Add node');
      
      expect(graphStore.getState().canUndo).toBe(true);
    });

    it('should undo to previous state', () => {
      const graph = createTestGraph();
      graphStore.getState().setGraph(graph);
      graphStore.getState().saveHistoryState('Initial');
      
      // Make change
      const nextGraph = structuredClone(graph);
      nextGraph.nodes[0].label = 'Changed';
      graphStore.getState().setGraph(nextGraph);
      graphStore.getState().saveHistoryState('Change label');
      
      expect(graphStore.getState().graph!.nodes[0].label).toBe('Changed');
      
      // Undo
      graphStore.getState().undo();
      expect(graphStore.getState().graph!.nodes[0].label).toBe('Start');
    });
  });
});

