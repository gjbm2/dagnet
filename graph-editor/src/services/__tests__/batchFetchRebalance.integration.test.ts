/**
 * Batch Fetch Rebalancing Integration Test
 * 
 * Tests the ACTUAL code path for batch fetching multiple parameters
 * and verifies rebalancing works correctly across sequential fetches.
 * 
 * Flow tested:
 *   fetchItems → fetchItem → getFromSource → getFromSourceDirect 
 *   → getParameterFromFile → handleFileToGraph → rebalanceEdgeProbabilities
 * 
 * CRITICAL: This test exercises the real UpdateManager and dataOperationsService
 * to catch bugs like the validateOnly flag preventing rebalance metadata.
 * 
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

import { Graph } from '../../types';
import { UpdateManager, updateManager } from '../UpdateManager';
import { dataOperationsService } from '../dataOperationsService';
import { fileRegistry } from '../../contexts/TabContext';

// ============================================================================
// MOCKS
// ============================================================================

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  }
}));

vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    startOperation: vi.fn(() => 'mock-op-id'),
    endOperation: vi.fn(),
    addChild: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn()
  }
}));

// ============================================================================
// TEST FIXTURES
// ============================================================================

/**
 * Creates a graph with 3 sibling edges from node A.
 * All edges start with p.mean = 0.33 (roughly equal split).
 * 
 * NOTE: Edges with p.id or p.connection are "locked" and won't be rebalanced
 * (they're expected to get values from their parameter files).
 * For rebalancing tests, we need edges WITHOUT p.id.
 */
function createComplexGraph(options: { withParamIds?: boolean } = {}): Graph {
  const { withParamIds = false } = options;
  
  return {
    nodes: [
      { id: 'node-A', uuid: 'node-A', type: 'decision', name: 'Decision A' },
      { id: 'node-B', uuid: 'node-B', type: 'outcome', name: 'Outcome B' },
      { id: 'node-C', uuid: 'node-C', type: 'outcome', name: 'Outcome C' },
      { id: 'node-D', uuid: 'node-D', type: 'outcome', name: 'Outcome D' }
    ],
    edges: [
      {
        id: 'edge-A-B',
        uuid: 'edge-A-B',
        from: 'node-A',
        to: 'node-B',
        // Only add p.id if withParamIds is true (for testing locked edges)
        p: withParamIds 
          ? { id: 'param-ab', mean: 0.33, type: 'beta', stdev: 0.1 }
          : { mean: 0.33, type: 'beta', stdev: 0.1 }
      },
      {
        id: 'edge-A-C',
        uuid: 'edge-A-C',
        from: 'node-A',
        to: 'node-C',
        p: withParamIds
          ? { id: 'param-ac', mean: 0.33, type: 'beta', stdev: 0.1 }
          : { mean: 0.33, type: 'beta', stdev: 0.1 }
      },
      {
        id: 'edge-A-D',
        uuid: 'edge-A-D',
        from: 'node-A',
        to: 'node-D',
        p: withParamIds
          ? { id: 'param-ad', mean: 0.34, type: 'beta', stdev: 0.1 }
          : { mean: 0.34, type: 'beta', stdev: 0.1 }
      }
    ],
    metadata: {
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
  };
}

/**
 * Creates a parameter file with pre-aggregated data.
 */
function createParameterFile(paramId: string, mean: number) {
  return {
    id: paramId,
    type: 'probability',
    connection: 'amplitude-prod',
    values: [{
      mean,
      stdev: 0.1,
      window_from: '2025-12-01T00:00:00Z',
      window_to: '2025-12-07T23:59:59Z',
      n: 1000,
      k: Math.round(mean * 1000),
      sliceDSL: ''
    }]
  };
}

// ============================================================================
// TEST SUITE
// ============================================================================

describe('Batch Fetch Rebalancing Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateManager.clearAuditLog();
    
    // Reset IndexedDB
    indexedDB = new IDBFactory();
  });

  afterEach(() => {
    // Clear file registry
    vi.restoreAllMocks();
  });

  describe('handleFileToGraph with validateOnly=true', () => {
    /**
     * This is the ROOT CAUSE test.
     * 
     * getParameterFromFile calls handleFileToGraph with validateOnly: true
     * to get changes without mutating the target. BUT the old code had:
     * 
     *   if (result.success && subDest === 'parameter' && !options.validateOnly)
     * 
     * This meant requiresSiblingRebalance was NEVER set for validateOnly mode!
     */
    it('should set requiresSiblingRebalance even with validateOnly=true', async () => {
      const graphEntity = {
        uuid: 'edge-A-B',
        p: { mean: 0.33, type: 'beta' }
      };
      
      // File has different mean value - triggers change
      // MUST have type: 'probability' for isProbType condition
      const fileData = {
        type: 'probability',
        values: [{ mean: 0.5, stdev: 0.1 }]
      };
      
      // This is exactly how getParameterFromFile calls it
      const result = await updateManager.handleFileToGraph(
        fileData,
        graphEntity,
        'UPDATE',
        'parameter',
        { interactive: true, validateOnly: true }
      );
      
      expect(result.success).toBe(true);
      expect(result.changes?.length).toBeGreaterThan(0);
      
      // THE FIX: This should be true even with validateOnly=true
      expect((result.metadata as any)?.requiresSiblingRebalance).toBe(true);
      expect((result.metadata as any)?.updatedEdgeId).toBe('edge-A-B');
      expect((result.metadata as any)?.updatedField).toBe('p.mean');
    });

    it('should NOT set flag when value is unchanged', async () => {
      const graphEntity = {
        uuid: 'edge-A-B',
        p: { mean: 0.5, type: 'beta' }  // Same as file
      };
      
      // MUST have type: 'probability' for isProbType condition
      const fileData = {
        type: 'probability',
        values: [{ mean: 0.5, stdev: 0.1 }]  // Same value
      };
      
      const result = await updateManager.handleFileToGraph(
        fileData,
        graphEntity,
        'UPDATE',
        'parameter',
        { interactive: true, validateOnly: true }
      );
      
      // No change detected = no rebalance needed
      expect((result.metadata as any)?.requiresSiblingRebalance).toBeFalsy();
    });
  });

  describe('getParameterFromFile triggers rebalancing', () => {
    it('should rebalance siblings when loading from file', async () => {
      // Use graph WITHOUT param ids so siblings can be rebalanced
      const graph = createComplexGraph({ withParamIds: false });
      // Add param id only to the edge we're updating
      graph.edges[0].p = { id: 'param-ab', mean: 0.33, type: 'beta', stdev: 0.1 };
      
      let updatedGraph: Graph | null = null;
      
      const setGraph = vi.fn((g: Graph | null) => {
        updatedGraph = g;
      });
      
      // Mock fileRegistry to return our test parameter file
      const mockGetFile = vi.spyOn(fileRegistry, 'getFile');
      mockGetFile.mockImplementation((fileId: string) => {
        if (fileId === 'parameter-param-ab') {
          return {
            id: fileId,
            data: createParameterFile('param-ab', 0.6),  // New value: 60%
            isDirty: false,
            type: 'parameter'
          } as any;
        }
        return null;
      });
      
      // Call getParameterFromFile - this should:
      // 1. Load from file (via mock)
      // 2. Call handleFileToGraph with validateOnly: true
      // 3. Detect p.mean change → set requiresSiblingRebalance
      // 4. Apply changes
      // 5. Call rebalanceEdgeProbabilities
      // 6. Call setGraph with rebalanced graph
      await dataOperationsService.getParameterFromFile({
        paramId: 'param-ab',
        edgeId: 'edge-A-B',
        graph,
        setGraph,
        targetSlice: 'window(1-Dec-25:7-Dec-25)'
      });
      
      expect(setGraph).toHaveBeenCalled();
      expect(updatedGraph).not.toBeNull();
      
      // Check edge A→B was updated to 0.6
      const edgeAB = updatedGraph!.edges.find(e => e.uuid === 'edge-A-B');
      expect(edgeAB?.p?.mean).toBeCloseTo(0.6, 2);
      
      // Check siblings were rebalanced to share remaining 0.4
      const edgeAC = updatedGraph!.edges.find(e => e.uuid === 'edge-A-C');
      const edgeAD = updatedGraph!.edges.find(e => e.uuid === 'edge-A-D');
      
      // Sum of all probabilities should be 1.0
      const sum = (edgeAB?.p?.mean ?? 0) + (edgeAC?.p?.mean ?? 0) + (edgeAD?.p?.mean ?? 0);
      expect(sum).toBeCloseTo(1.0, 2);
      
      // Siblings should share the remaining 0.4
      // Original ratio was 0.33:0.34 ≈ 1:1, so should get ~0.2 each
      expect((edgeAC?.p?.mean ?? 0) + (edgeAD?.p?.mean ?? 0)).toBeCloseTo(0.4, 2);
      
      mockGetFile.mockRestore();
    });
  });

  describe('Sequential batch fetch preserves rebalancing', () => {
    it('should correctly rebalance across multiple sequential fetches', async () => {
      // Use graph WITH param ids - this tests the locked edge scenario
      // where all edges get values from their parameter files
      let currentGraph = createComplexGraph({ withParamIds: true });
      const setGraphCalls: Graph[] = [];
      
      const setGraph = vi.fn((g: Graph | null) => {
        if (g) {
          currentGraph = g;
          setGraphCalls.push(structuredClone(g));
        }
      });
      
      // Getter for fresh graph (mimics useFetchData pattern)
      const getUpdatedGraph = () => currentGraph;
      
      // Mock fileRegistry for each parameter
      const mockGetFile = vi.spyOn(fileRegistry, 'getFile');
      mockGetFile.mockImplementation((fileId: string) => {
        if (fileId === 'parameter-param-ab') {
          return {
            id: fileId,
            data: createParameterFile('param-ab', 0.5),  // 50%
            isDirty: false,
            type: 'parameter'
          } as any;
        }
        if (fileId === 'parameter-param-ac') {
          return {
            id: fileId,
            data: createParameterFile('param-ac', 0.3),  // 30%
            isDirty: false,
            type: 'parameter'
          } as any;
        }
        if (fileId === 'parameter-param-ad') {
          return {
            id: fileId,
            data: createParameterFile('param-ad', 0.2),  // 20%
            isDirty: false,
            type: 'parameter'
          } as any;
        }
        return null;
      });
      
      // Simulate batch fetch: fetch each parameter sequentially
      // This mirrors what fetchItems does
      
      // Fetch 1: param-ab → 50%
      await dataOperationsService.getParameterFromFile({
        paramId: 'param-ab',
        edgeId: 'edge-A-B',
        graph: getUpdatedGraph(),
        setGraph,
        targetSlice: 'window(1-Dec-25:7-Dec-25)'
      });
      
      console.log('After fetch 1 (A→B = 0.5):');
      console.log('  A→B:', currentGraph.edges.find(e => e.uuid === 'edge-A-B')?.p?.mean);
      console.log('  A→C:', currentGraph.edges.find(e => e.uuid === 'edge-A-C')?.p?.mean);
      console.log('  A→D:', currentGraph.edges.find(e => e.uuid === 'edge-A-D')?.p?.mean);
      
      // Fetch 2: param-ac → 30%
      await dataOperationsService.getParameterFromFile({
        paramId: 'param-ac',
        edgeId: 'edge-A-C',
        graph: getUpdatedGraph(),  // CRITICAL: Get fresh graph!
        setGraph,
        targetSlice: 'window(1-Dec-25:7-Dec-25)'
      });
      
      console.log('After fetch 2 (A→C = 0.3):');
      console.log('  A→B:', currentGraph.edges.find(e => e.uuid === 'edge-A-B')?.p?.mean);
      console.log('  A→C:', currentGraph.edges.find(e => e.uuid === 'edge-A-C')?.p?.mean);
      console.log('  A→D:', currentGraph.edges.find(e => e.uuid === 'edge-A-D')?.p?.mean);
      
      // Fetch 3: param-ad → 20%
      await dataOperationsService.getParameterFromFile({
        paramId: 'param-ad',
        edgeId: 'edge-A-D',
        graph: getUpdatedGraph(),  // CRITICAL: Get fresh graph!
        setGraph,
        targetSlice: 'window(1-Dec-25:7-Dec-25)'
      });
      
      console.log('After fetch 3 (A→D = 0.2):');
      console.log('  A→B:', currentGraph.edges.find(e => e.uuid === 'edge-A-B')?.p?.mean);
      console.log('  A→C:', currentGraph.edges.find(e => e.uuid === 'edge-A-C')?.p?.mean);
      console.log('  A→D:', currentGraph.edges.find(e => e.uuid === 'edge-A-D')?.p?.mean);
      
      // Verify final state
      const finalAB = currentGraph.edges.find(e => e.uuid === 'edge-A-B')?.p?.mean ?? 0;
      const finalAC = currentGraph.edges.find(e => e.uuid === 'edge-A-C')?.p?.mean ?? 0;
      const finalAD = currentGraph.edges.find(e => e.uuid === 'edge-A-D')?.p?.mean ?? 0;
      
      // Sum should be 1.0
      const sum = finalAB + finalAC + finalAD;
      console.log('Final sum:', sum);
      expect(sum).toBeCloseTo(1.0, 2);
      
      // Last fetch set A→D to 0.2, so that should be preserved
      expect(finalAD).toBeCloseTo(0.2, 2);
      
      // A→B and A→C should share remaining 0.8
      expect(finalAB + finalAC).toBeCloseTo(0.8, 2);
      
      mockGetFile.mockRestore();
    });
  });

  describe('rebalanceEdgeProbabilities', () => {
    it('should correctly distribute weight among siblings', () => {
      // Use graph WITHOUT param ids so siblings can be rebalanced
      const graph = createComplexGraph({ withParamIds: false });
      
      // Set A→B to 0.6
      graph.edges[0].p!.mean = 0.6;
      
      const rebalanced = updateManager.rebalanceEdgeProbabilities(graph, 'edge-A-B', false);
      
      const ab = rebalanced.edges.find(e => e.uuid === 'edge-A-B')?.p?.mean ?? 0;
      const ac = rebalanced.edges.find(e => e.uuid === 'edge-A-C')?.p?.mean ?? 0;
      const ad = rebalanced.edges.find(e => e.uuid === 'edge-A-D')?.p?.mean ?? 0;
      
      // Origin should be preserved
      expect(ab).toBeCloseTo(0.6, 3);
      
      // Sum should be 1.0
      expect(ab + ac + ad).toBeCloseTo(1.0, 3);
      
      // Siblings share remaining 0.4
      expect(ac + ad).toBeCloseTo(0.4, 3);
    });
  });
});

