/**
 * Edge Reconnection Tests
 * 
 * Tests the edge reconnection functionality including:
 * - Moving edge to different face on same node
 * - Moving edge to different node
 * - Dirty state tracking after reconnection
 * 
 * These are regression tests for the bug where:
 * 1. Moving an edge to different face was rebuilding edge badly
 * 2. Reconnection wasn't marking graph as dirty
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
    {
      uuid: 'node-3',
      id: 'alternate',
      label: 'Alternate End',
      absorbing: true,
      layout: { x: 300, y: 200 },
    },
  ],
  edges: [
    {
      uuid: 'edge-1',
      id: 'start->end',
      from: 'node-1',
      to: 'node-2',
      p: { mean: 0.5, stdev: 0.1 },
      fromHandle: 'right-out',
      toHandle: 'left',
      description: 'Test edge',
    },
  ],
});

/**
 * Simulates the handleReconnect function from GraphCanvas
 * This mirrors the actual implementation to test the logic
 */
function simulateHandleReconnect(
  graph: any,
  edgeId: string,
  newSource?: string,
  newTarget?: string,
  newTargetHandle?: string,
  newSourceHandle?: string
): any {
  const nextGraph = structuredClone(graph);
  const edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === edgeId || e.id === edgeId);
  
  if (edgeIndex === -1) {
    console.warn('Edge not found:', edgeId);
    return graph;
  }
  
  const edge = nextGraph.edges[edgeIndex];
  const originalFrom = edge.from;
  const originalTo = edge.to;
  
  // Update source if provided
  if (newSource !== undefined) {
    edge.from = newSource;
    if (newSourceHandle) {
      edge.fromHandle = newSourceHandle.endsWith('-out') ? newSourceHandle : `${newSourceHandle}-out`;
    }
  }
  
  // Update target if provided
  if (newTarget !== undefined) {
    edge.to = newTarget;
    if (newTargetHandle) {
      edge.toHandle = newTargetHandle;
    }
  }
  
  // Update edge ID if source/target changed
  if (edge.from !== originalFrom || edge.to !== originalTo) {
    const newEdgeId = `${edge.from}->${edge.to}`;
    edge.id = newEdgeId;
  }
  
  // Update metadata
  if (nextGraph.metadata) {
    nextGraph.metadata.updated_at = new Date().toISOString();
  }
  
  return nextGraph;
}

describe('Edge Reconnection Tests', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    (fileRegistry as any).files.clear();
    (fileRegistry as any).listeners.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Handle Changes (Same Nodes)', () => {
    it('should preserve edge properties when changing source handle', async () => {
      const graph = createTestGraph();
      const originalEdge = graph.edges[0];
      
      // Reconnect: change source handle from 'right-out' to 'bottom-out'
      const nextGraph = simulateHandleReconnect(
        graph,
        'edge-1',
        'node-1',      // same source
        undefined,     // no target change
        undefined,     // no target handle change
        'bottom'       // new source handle
      );
      
      const updatedEdge = nextGraph.edges[0];
      
      // Edge UUID should be preserved
      expect(updatedEdge.uuid).toBe(originalEdge.uuid);
      
      // Edge probability should be preserved
      expect(updatedEdge.p.mean).toBe(originalEdge.p.mean);
      expect(updatedEdge.p.stdev).toBe(originalEdge.p.stdev);
      
      // Edge description should be preserved
      expect(updatedEdge.description).toBe(originalEdge.description);
      
      // Source handle should be updated
      expect(updatedEdge.fromHandle).toBe('bottom-out');
      
      // Target handle should be preserved
      expect(updatedEdge.toHandle).toBe(originalEdge.toHandle);
      
      // Source/target nodes should be preserved
      expect(updatedEdge.from).toBe(originalEdge.from);
      expect(updatedEdge.to).toBe(originalEdge.to);
    });

    it('should preserve edge properties when changing target handle', async () => {
      const graph = createTestGraph();
      const originalEdge = graph.edges[0];
      
      // Reconnect: change target handle from 'left' to 'top'
      const nextGraph = simulateHandleReconnect(
        graph,
        'edge-1',
        undefined,     // no source change
        'node-2',      // same target
        'top',         // new target handle
        undefined      // no source handle change
      );
      
      const updatedEdge = nextGraph.edges[0];
      
      // Edge UUID should be preserved
      expect(updatedEdge.uuid).toBe(originalEdge.uuid);
      
      // Edge probability should be preserved
      expect(updatedEdge.p.mean).toBe(originalEdge.p.mean);
      expect(updatedEdge.p.stdev).toBe(originalEdge.p.stdev);
      
      // Target handle should be updated
      expect(updatedEdge.toHandle).toBe('top');
      
      // Source handle should be preserved
      expect(updatedEdge.fromHandle).toBe(originalEdge.fromHandle);
    });

    it('should mark graph dirty when changing handle', async () => {
      const graph = createTestGraph();
      
      const file = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        { repository: 'test-repo', branch: 'main', path: 'graphs/test.json' },
        graph
      );
      await fileRegistry.completeInitialization('graph-test');
      expect(file.isDirty).toBe(false);
      
      // Simulate handle change
      const nextGraph = simulateHandleReconnect(graph, 'edge-1', undefined, 'node-2', 'bottom', undefined);
      await fileRegistry.updateFile('graph-test', nextGraph);
      
      expect(file.isDirty).toBe(true);
    });
  });

  describe('Node Changes (Different Nodes)', () => {
    it('should update edge when reconnecting to different target node', async () => {
      const graph = createTestGraph();
      const originalEdge = graph.edges[0];
      
      // Reconnect: change target from node-2 to node-3
      const nextGraph = simulateHandleReconnect(
        graph,
        'edge-1',
        undefined,     // no source change
        'node-3',      // new target
        'left',        // target handle
        undefined      // no source handle change
      );
      
      const updatedEdge = nextGraph.edges[0];
      
      // Edge UUID should be preserved
      expect(updatedEdge.uuid).toBe(originalEdge.uuid);
      
      // Edge probability should be preserved
      expect(updatedEdge.p.mean).toBe(originalEdge.p.mean);
      
      // Target should be updated
      expect(updatedEdge.to).toBe('node-3');
      
      // Edge ID should be updated to reflect new connection
      expect(updatedEdge.id).toBe('node-1->node-3');
      
      // Source should be preserved
      expect(updatedEdge.from).toBe(originalEdge.from);
    });

    it('should update edge when reconnecting to different source node', async () => {
      const graph = createTestGraph();
      
      // Add another node to be the new source
      graph.nodes.push({
        uuid: 'node-4',
        id: 'new-source',
        label: 'New Source',
        absorbing: false,
        entry: { is_start: true },
        layout: { x: 0, y: 100 },
      });
      
      const originalEdge = graph.edges[0];
      
      // Reconnect: change source from node-1 to node-4
      const nextGraph = simulateHandleReconnect(
        graph,
        'edge-1',
        'node-4',      // new source
        undefined,     // no target change
        undefined,     // no target handle change
        'right'        // source handle
      );
      
      const updatedEdge = nextGraph.edges[0];
      
      // Edge UUID should be preserved
      expect(updatedEdge.uuid).toBe(originalEdge.uuid);
      
      // Edge probability should be preserved
      expect(updatedEdge.p.mean).toBe(originalEdge.p.mean);
      
      // Source should be updated
      expect(updatedEdge.from).toBe('node-4');
      
      // Edge ID should be updated
      expect(updatedEdge.id).toBe('node-4->node-2');
      
      // Target should be preserved
      expect(updatedEdge.to).toBe(originalEdge.to);
    });

    it('should mark graph dirty when reconnecting to different node', async () => {
      const graph = createTestGraph();
      
      const file = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        { repository: 'test-repo', branch: 'main', path: 'graphs/test.json' },
        graph
      );
      await fileRegistry.completeInitialization('graph-test');
      expect(file.isDirty).toBe(false);
      
      // Simulate reconnection to different target node
      const nextGraph = simulateHandleReconnect(graph, 'edge-1', undefined, 'node-3', 'left', undefined);
      await fileRegistry.updateFile('graph-test', nextGraph);
      
      expect(file.isDirty).toBe(true);
      expect(file.data.edges[0].to).toBe('node-3');
    });
  });

  describe('Edge Property Preservation', () => {
    it('should preserve all edge properties during reconnection', async () => {
      const graph = createTestGraph();
      
      // Add more properties to the edge
      graph.edges[0].cost_gbp = { mean: 10, connection: 'test-conn' };
      graph.edges[0].cost_time = { mean: 5 };
      graph.edges[0].case_variant = 'variant-a';
      graph.edges[0].case_id = 'case-1';
      
      const originalEdge = { ...graph.edges[0] };
      
      // Reconnect to different node
      const nextGraph = simulateHandleReconnect(
        graph,
        'edge-1',
        undefined,
        'node-3',
        'bottom',
        undefined
      );
      
      const updatedEdge = nextGraph.edges[0];
      
      // All properties should be preserved
      expect(updatedEdge.uuid).toBe(originalEdge.uuid);
      expect(updatedEdge.p).toEqual(originalEdge.p);
      expect(updatedEdge.cost_gbp).toEqual(originalEdge.cost_gbp);
      expect(updatedEdge.cost_time).toEqual(originalEdge.cost_time);
      expect(updatedEdge.case_variant).toBe(originalEdge.case_variant);
      expect(updatedEdge.case_id).toBe(originalEdge.case_id);
      expect(updatedEdge.description).toBe(originalEdge.description);
      
      // Only these should change
      expect(updatedEdge.to).toBe('node-3');
      expect(updatedEdge.toHandle).toBe('bottom');
      expect(updatedEdge.id).toBe('node-1->node-3');
    });
  });

  describe('Revert After Reconnection', () => {
    it('should revert reconnection changes correctly', async () => {
      const graph = createTestGraph();
      const originalEdge = { ...graph.edges[0] };
      
      const file = await fileRegistry.getOrCreateFile(
        'graph-test',
        'graph',
        { repository: 'test-repo', branch: 'main', path: 'graphs/test.json' },
        graph
      );
      await fileRegistry.completeInitialization('graph-test');
      
      // Reconnect edge
      const nextGraph = simulateHandleReconnect(graph, 'edge-1', undefined, 'node-3', 'top', undefined);
      await fileRegistry.updateFile('graph-test', nextGraph);
      
      expect(file.isDirty).toBe(true);
      expect(file.data.edges[0].to).toBe('node-3');
      
      // Revert
      await fileRegistry.revertFile('graph-test');
      
      expect(file.isDirty).toBe(false);
      expect(file.data.edges[0].to).toBe(originalEdge.to);
      expect(file.data.edges[0].toHandle).toBe(originalEdge.toHandle);
      expect(file.data.edges[0].id).toBe(originalEdge.id);
    });
  });
});

