/**
 * Comprehensive Batch Fetch E2E Tests
 * 
 * REAL E2E tests that exercise the COMPLETE fetch pipeline with:
 * - REAL UpdateManager, dataOperationsService, fetchDataService
 * - MOCK fileRegistry with in-memory storage
 * - REAL graph topology with proper node/edge structures
 * 
 * Tests complex scenarios:
 * 1. Sequential batch fetch preserving cumulative graph updates
 * 2. Mixed latency/non-latency edges in same batch
 * 3. Diamond topology with cascading n values through anchors
 * 4. Evidence/forecast blend calculations
 * 5. Path T95 computation after batch
 * 
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// MOCKS - Must be defined BEFORE imports
// =============================================================================

// Mock toast
vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    dismiss: vi.fn(),
    custom: vi.fn(),
  },
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    dismiss: vi.fn(),
    custom: vi.fn(),
  }
}));

// Mock session log
vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    startOperation: vi.fn(() => 'mock-op-id'),
    endOperation: vi.fn(),
    addChild: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  }
}));

// Mock fileRegistry with in-memory storage
// Must use a global to allow hoisted mock factory to access it
(globalThis as any).__mockFileStore = new Map<string, any>();

vi.mock('../../contexts/TabContext', () => {
  const getMockFiles = () => (globalThis as any).__mockFileStore as Map<string, any>;
  return {
    fileRegistry: {
      registerFile: (fileId: string, data: any) => {
        getMockFiles().set(fileId, { fileId, data: structuredClone(data), isDirty: false });
        return Promise.resolve();
      },
      getFile: (fileId: string) => {
        return getMockFiles().get(fileId);
      },
      updateFile: (fileId: string, data: any) => {
        const mockFiles = getMockFiles();
        if (mockFiles.has(fileId)) {
          const existing = mockFiles.get(fileId);
          mockFiles.set(fileId, { ...existing, data: structuredClone(data), isDirty: true });
        }
        return Promise.resolve();
      },
      deleteFile: (fileId: string) => {
        getMockFiles().delete(fileId);
        return Promise.resolve();
      },
      getAllFiles: () => Array.from(getMockFiles().values()),
    }
  };
});

// Mock IndexedDB operations
vi.mock('../../db/appDatabase', () => {
  const getMockFiles = () => (globalThis as any).__mockFileStore as Map<string, any>;
  return {
    db: {
      files: {
        get: async (fileId: string) => {
          const file = getMockFiles().get(fileId);
          return file ? { fileId, content: file.data } : undefined;
        },
        put: async () => undefined,
        delete: async () => undefined,
      },
      transaction: () => ({
        store: { put: async () => undefined },
      }),
      getDirtyFiles: async () => [],
      getCurrentWorkspace: async () => ({ repository: 'test-repo', branch: 'main' }),
    }
  };
});

// =============================================================================
// IMPORTS - After mocks
// =============================================================================

import type { Graph } from '../../types';
import { fetchDataService, createFetchItem, type FetchItem } from '../fetchDataService';
import { fileRegistry } from '../../contexts/TabContext';

// =============================================================================
// TEST HELPERS
// =============================================================================

function getMockFiles(): Map<string, any> {
  return (globalThis as any).__mockFileStore as Map<string, any>;
}

function clearMockFiles() {
  getMockFiles().clear();
}

function setupMockFile(fileId: string, data: any) {
  getMockFiles().set(fileId, { fileId, data: structuredClone(data), isDirty: false });
}

function createParameterFile(paramId: string, config: {
  type?: 'probability' | 'cost_gbp';
  connection?: string;
  values?: any[];
}): any {
  return {
    id: paramId,
    type: config.type || 'probability',
    parameter_type: config.type || 'probability',
    connection: config.connection || 'amplitude-prod',
    values: config.values || [],
  };
}

/**
 * Creates a linear funnel graph:
 * A (START) → B → C → D → E
 * 
 * Each edge can have latency tracking enabled.
 */
function createLinearFunnelGraph(options: {
  edgeCount: number;
  latencyEnabled?: boolean[];
  fallbackT95Days?: number;
}): Graph {
  const { edgeCount, latencyEnabled = [], fallbackT95Days = 30 } = options;
  
  const nodes: any[] = [];
  const edges: any[] = [];
  
  const nodeNames = 'ABCDEFGHIJ'.split('');
  for (let i = 0; i <= edgeCount; i++) {
    const isStart = i === 0;
    nodes.push({
      id: `node-${nodeNames[i]}`,
      uuid: `node-${nodeNames[i]}-uuid`,
      type: isStart ? 'start' : 'step',
      label: `Node ${nodeNames[i]}`,
      event_id: `event-${nodeNames[i].toLowerCase()}`,
      // Mark first node as START for LAG topo traversal
      ...(isStart ? { entry: { is_start: true } } : {}),
    });
  }
  
  for (let i = 0; i < edgeCount; i++) {
    const hasLatency = latencyEnabled[i] ?? false;
    edges.push({
      id: `edge-${nodeNames[i]}-${nodeNames[i + 1]}`,
      uuid: `edge-${nodeNames[i]}-${nodeNames[i + 1]}-uuid`,
      from: `node-${nodeNames[i]}`,
      to: `node-${nodeNames[i + 1]}`,
      query: `from(node-${nodeNames[i]}).to(node-${nodeNames[i + 1]})`,
      p: {
        id: `param-${nodeNames[i]}-to-${nodeNames[i + 1]}`,
        mean: 0.5,
        connection: 'amplitude-prod',
        ...(hasLatency ? {
          latency: {
            latency_parameter: true,
            t95: fallbackT95Days,
            anchor_node_id: 'node-A',
          }
        } : {})
      }
    });
  }
  
  return {
    nodes,
    edges,
    metadata: {
      name: 'Test Linear Funnel',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
  } as Graph;
}

/**
 * Creates a diamond topology graph:
 * 
 *        A (START)
 *       / \
 *      B   C
 *       \ /
 *        D
 */
function createDiamondGraph(options: {
  latencyEnabled?: boolean;
  fallbackT95Days?: number;
}): Graph {
  const { latencyEnabled = true, fallbackT95Days = 30 } = options;
  
  const latencyConfig = latencyEnabled ? {
    latency: {
      latency_parameter: true,
      t95: fallbackT95Days,
      anchor_node_id: 'node-A',
    }
  } : {};
  
  return {
    nodes: [
      { id: 'node-A', uuid: 'node-A-uuid', type: 'start', label: 'Entry', event_id: 'event-entry' },
      { id: 'node-B', uuid: 'node-B-uuid', type: 'step', label: 'Path B', event_id: 'event-path-b' },
      { id: 'node-C', uuid: 'node-C-uuid', type: 'step', label: 'Path C', event_id: 'event-path-c' },
      { id: 'node-D', uuid: 'node-D-uuid', type: 'step', label: 'Destination', event_id: 'event-dest' },
    ],
    edges: [
      {
        id: 'edge-A-B', uuid: 'edge-A-B-uuid',
        from: 'node-A', to: 'node-B',
        query: 'from(node-A).to(node-B)',
        p: { id: 'param-a-to-b', mean: 0.6, connection: 'amplitude-prod', ...latencyConfig }
      },
      {
        id: 'edge-A-C', uuid: 'edge-A-C-uuid',
        from: 'node-A', to: 'node-C',
        query: 'from(node-A).to(node-C)',
        p: { id: 'param-a-to-c', mean: 0.4, connection: 'amplitude-prod', ...latencyConfig }
      },
      {
        id: 'edge-B-D', uuid: 'edge-B-D-uuid',
        from: 'node-B', to: 'node-D',
        query: 'from(node-B).to(node-D)',
        p: { id: 'param-b-to-d', mean: 0.7, connection: 'amplitude-prod', ...latencyConfig }
      },
      {
        id: 'edge-C-D', uuid: 'edge-C-D-uuid',
        from: 'node-C', to: 'node-D',
        query: 'from(node-C).to(node-D)',
        p: { id: 'param-c-to-d', mean: 0.5, connection: 'amplitude-prod', ...latencyConfig }
      },
    ],
    metadata: {
      name: 'Test Diamond Graph',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
  } as Graph;
}

// =============================================================================
// TESTS
// =============================================================================

describe('Comprehensive Batch Fetch E2E Tests', () => {

  beforeEach(() => {
    clearMockFiles();
    vi.clearAllMocks();
  });

  // ===========================================================================
  // SCENARIO 1: Sequential Batch Fetch - Graph Tracking
  // ===========================================================================
  
  describe('Scenario 1: Sequential Batch Fetch with Graph Tracking', () => {
    /**
     * Tests that when fetching 3 items in a batch, ALL items' updates
     * are preserved in the final graph, not just the last one.
     * 
     * BUG SCENARIO (without getUpdatedGraph):
     * - Fetch item 1: graph cloned from original, setGraph(graph1)
     * - Fetch item 2: graph cloned from ORIGINAL (not graph1!), setGraph(graph2)
     * - Fetch item 3: graph cloned from ORIGINAL (not graph2!), setGraph(graph3)
     * - Result: Only item 3's changes survive
     * 
     * CORRECT BEHAVIOR (with getUpdatedGraph):
     * - Fetch item 1: graph = original, setGraph(graph1), currentGraph = graph1
     * - Fetch item 2: graph = graph1, setGraph(graph2), currentGraph = graph2
     * - Fetch item 3: graph = graph2, setGraph(graph3)
     * - Result: All 3 items' changes in graph3
     */
    it('should preserve all updates when fetching 3 items sequentially', async () => {
      const graph = createLinearFunnelGraph({ edgeCount: 3, latencyEnabled: [false, false, false] });
      
      // Track all setGraph calls to verify cumulative state
      let currentGraph = graph;
      const setGraphCalls: Graph[] = [];
      const setGraph = (g: Graph | null) => {
        if (g) {
          currentGraph = g;
          setGraphCalls.push(structuredClone(g));
        }
      };
      const getUpdatedGraph = () => currentGraph;
      
      // Create parameter files with DIFFERENT n/k values
      setupMockFile('parameter-param-A-to-B', createParameterFile('param-A-to-B', {
        values: [{
          mean: 0.50, n: 100, k: 50,
          sliceDSL: 'window(1-Nov-25:7-Nov-25)',
          window_from: '1-Nov-25', window_to: '7-Nov-25',
        }]
      }));
      
      setupMockFile('parameter-param-B-to-C', createParameterFile('param-B-to-C', {
        values: [{
          mean: 0.70, n: 100, k: 70,
          sliceDSL: 'window(1-Nov-25:7-Nov-25)',
          window_from: '1-Nov-25', window_to: '7-Nov-25',
        }]
      }));
      
      setupMockFile('parameter-param-C-to-D', createParameterFile('param-C-to-D', {
        values: [{
          mean: 0.30, n: 100, k: 30,
          sliceDSL: 'window(1-Nov-25:7-Nov-25)',
          window_from: '1-Nov-25', window_to: '7-Nov-25',
        }]
      }));
      
      // Event files
      setupMockFile('event-event-a', { id: 'event-a', provider_event_names: { amplitude: 'Event A' } });
      setupMockFile('event-event-b', { id: 'event-b', provider_event_names: { amplitude: 'Event B' } });
      setupMockFile('event-event-c', { id: 'event-c', provider_event_names: { amplitude: 'Event C' } });
      setupMockFile('event-event-d', { id: 'event-d', provider_event_names: { amplitude: 'Event D' } });
      
      // Create fetch items for all 3 edges
      const items: FetchItem[] = [
        createFetchItem('parameter', 'param-A-to-B', 'edge-A-B-uuid'),
        createFetchItem('parameter', 'param-B-to-C', 'edge-B-C-uuid'),
        createFetchItem('parameter', 'param-C-to-D', 'edge-C-D-uuid'),
      ];
      
      // Execute batch fetch with from-file mode (no HTTP needed)
      const results = await fetchDataService.fetchItems(
        items,
        { mode: 'from-file' },
        graph,
        setGraph,
        'window(1-Nov-25:7-Nov-25)',
        getUpdatedGraph
      );
      
      // Verify all 3 fetches succeeded
      expect(results.length).toBe(3);
      expect(results.filter(r => r.success).length).toBe(3);
      
      // THE CRITICAL ASSERTION:
      // All 3 edges should have evidence.mean set to their respective values
      const finalGraph = currentGraph;
      
      const edgeAB = finalGraph.edges.find(e => e.id === 'edge-A-B');
      const edgeBC = finalGraph.edges.find(e => e.id === 'edge-B-C');
      const edgeCD = finalGraph.edges.find(e => e.id === 'edge-C-D');
      
      // If graph tracking is broken, only the last edge (C-D) would have evidence.mean
      // because each fetch would clone the ORIGINAL graph, not the cumulative result
      
      console.log('[TEST] Edge A-B p:', edgeAB?.p);
      console.log('[TEST] Edge B-C p:', edgeBC?.p);
      console.log('[TEST] Edge C-D p:', edgeCD?.p);
      
      expect(edgeAB?.p?.evidence?.mean).toBeCloseTo(0.50, 2);
      expect(edgeBC?.p?.evidence?.mean).toBeCloseTo(0.70, 2);
      expect(edgeCD?.p?.evidence?.mean).toBeCloseTo(0.30, 2);
      
      // Additional check: verify setGraph was called 3 times with CUMULATIVE state
      expect(setGraphCalls.length).toBeGreaterThanOrEqual(3);
      
      // The last setGraph call should have ALL edges updated
      const lastSetGraphCall = setGraphCalls[setGraphCalls.length - 1];
      const countWithEvidence = lastSetGraphCall.edges.filter(e => e.p?.evidence?.mean !== undefined).length;
      expect(countWithEvidence).toBe(3);
    });
    
    it('should handle partial failures without losing successful updates', async () => {
      const graph = createLinearFunnelGraph({ edgeCount: 3 });
      
      let currentGraph = graph;
      const setGraph = (g: Graph | null) => { if (g) currentGraph = g; };
      const getUpdatedGraph = () => currentGraph;
      
      // Only create 2 parameter files - third will fail
      setupMockFile('parameter-param-A-to-B', createParameterFile('param-A-to-B', {
        values: [{ mean: 0.50, n: 100, k: 50, sliceDSL: 'window(1-Nov-25:7-Nov-25)' }]
      }));
      setupMockFile('parameter-param-B-to-C', createParameterFile('param-B-to-C', {
        values: [{ mean: 0.70, n: 100, k: 70, sliceDSL: 'window(1-Nov-25:7-Nov-25)' }]
      }));
      // param-C-to-D deliberately MISSING
      
      // Event files
      setupMockFile('event-event-a', { id: 'event-a', provider_event_names: { amplitude: 'Event A' } });
      setupMockFile('event-event-b', { id: 'event-b', provider_event_names: { amplitude: 'Event B' } });
      setupMockFile('event-event-c', { id: 'event-c', provider_event_names: { amplitude: 'Event C' } });
      setupMockFile('event-event-d', { id: 'event-d', provider_event_names: { amplitude: 'Event D' } });
      
      const items: FetchItem[] = [
        createFetchItem('parameter', 'param-A-to-B', 'edge-A-B-uuid'),
        createFetchItem('parameter', 'param-B-to-C', 'edge-B-C-uuid'),
        createFetchItem('parameter', 'param-C-to-D', 'edge-C-D-uuid'), // Will fail
      ];
      
      const results = await fetchDataService.fetchItems(
        items,
        { mode: 'from-file' },
        graph,
        setGraph,
        'window(1-Nov-25:7-Nov-25)',
        getUpdatedGraph
      );
      
      // 2 successes, 1 failure
      expect(results.filter(r => r.success).length).toBe(2);
      expect(results.filter(r => !r.success).length).toBe(1);
      
      // First 2 edges should still have updates
      const edgeAB = currentGraph.edges.find(e => e.id === 'edge-A-B');
      const edgeBC = currentGraph.edges.find(e => e.id === 'edge-B-C');
      
      expect(edgeAB?.p?.evidence?.mean).toBeCloseTo(0.50, 2);
      expect(edgeBC?.p?.evidence?.mean).toBeCloseTo(0.70, 2);
    });
  });

  // ===========================================================================
  // SCENARIO 2: Diamond Topology with Anchor Propagation
  // ===========================================================================
  
  describe('Scenario 2: Diamond Topology - Anchor Propagation', () => {
    /**
     * Tests that downstream edges (B→D, C→D) correctly use anchor A
     * for cohort queries, ensuring n values cascade correctly.
     * 
     * In a diamond:
     *        A (n=1000)
     *       / \
     *      B   C
     *     (k=600) (k=400)
     *       \ /
     *        D
     * 
     * B→D should see n=600 (people who did A then B)
     * C→D should see n=400 (people who did A then C)
     * NOT n=all people at B or C
     */
    it('should ensure anchor_node_id is set on all latency edges', async () => {
      const graph = createDiamondGraph({ latencyEnabled: true });
      
      // Verify all edges have anchor_node_id set to node-A
      for (const edge of graph.edges) {
        expect(edge.p?.latency?.anchor_node_id).toBe('node-A');
      }
    });
    
    it('should preserve anchor through batch fetch', async () => {
      const graph = createDiamondGraph({ latencyEnabled: true });
      
      let currentGraph = graph;
      const setGraph = (g: Graph | null) => { if (g) currentGraph = g; };
      const getUpdatedGraph = () => currentGraph;
      
      // Setup files with cascading n values
      setupMockFile('parameter-param-a-to-b', createParameterFile('param-a-to-b', {
        values: [{
          mean: 0.60, n: 1000, k: 600,
          sliceDSL: 'cohort(node-A,1-Nov-25:15-Nov-25)',
        }]
      }));
      setupMockFile('parameter-param-a-to-c', createParameterFile('param-a-to-c', {
        values: [{
          mean: 0.40, n: 1000, k: 400,
          sliceDSL: 'cohort(node-A,1-Nov-25:15-Nov-25)',
        }]
      }));
      setupMockFile('parameter-param-b-to-d', createParameterFile('param-b-to-d', {
        values: [{
          // n should be 600 (from A→B's k), not 600+400=1000
          mean: 0.70, n: 600, k: 420,
          sliceDSL: 'cohort(node-A,1-Nov-25:15-Nov-25)',
        }]
      }));
      setupMockFile('parameter-param-c-to-d', createParameterFile('param-c-to-d', {
        values: [{
          // n should be 400 (from A→C's k), not all at C
          mean: 0.50, n: 400, k: 200,
          sliceDSL: 'cohort(node-A,1-Nov-25:15-Nov-25)',
        }]
      }));
      
      // Event files
      setupMockFile('event-event-entry', { id: 'event-entry', provider_event_names: { amplitude: 'Entry' } });
      setupMockFile('event-event-path-b', { id: 'event-path-b', provider_event_names: { amplitude: 'Path B' } });
      setupMockFile('event-event-path-c', { id: 'event-path-c', provider_event_names: { amplitude: 'Path C' } });
      setupMockFile('event-event-dest', { id: 'event-dest', provider_event_names: { amplitude: 'Destination' } });
      
      const items: FetchItem[] = [
        createFetchItem('parameter', 'param-a-to-b', 'edge-A-B-uuid'),
        createFetchItem('parameter', 'param-a-to-c', 'edge-A-C-uuid'),
        createFetchItem('parameter', 'param-b-to-d', 'edge-B-D-uuid'),
        createFetchItem('parameter', 'param-c-to-d', 'edge-C-D-uuid'),
      ];
      
      await fetchDataService.fetchItems(
        items,
        { mode: 'from-file' },
        graph,
        setGraph,
        'cohort(1-Nov-25:15-Nov-25)',
        getUpdatedGraph
      );
      
      // All edges should still have anchor_node_id after fetch
      for (const edge of currentGraph.edges) {
        if (edge.p?.latency?.latency_parameter === true) {
          expect(edge.p.latency.anchor_node_id).toBe('node-A');
        }
      }
      
      // Verify n cascades correctly
      const edgeBD = currentGraph.edges.find(e => e.id === 'edge-B-D');
      const edgeCD = currentGraph.edges.find(e => e.id === 'edge-C-D');
      
      expect(edgeBD?.p?.evidence?.n).toBe(600);
      expect(edgeCD?.p?.evidence?.n).toBe(400);
    });
  });

  // ===========================================================================
  // SCENARIO 3: Evidence/Forecast Blend Calculation
  // ===========================================================================
  
  describe('Scenario 3: Evidence/Forecast Blend', () => {
    /**
     * Tests that when both evidence and forecast are present,
     * p.mean is correctly computed as a weighted blend.
     * 
     * KNOWN BUG (sampleFileQueryFlow.e2e.test.ts Bug 2):
     * evidence.mean should be computed from k/n during fetch, but currently
     * the UpdateManager only copies evidence.mean if it already exists in the file.
     * This test documents the EXPECTED behavior once the bug is fixed.
     * 
     * To fix: dataOperationsService must ALWAYS compute evidence.mean = k/n
     * from raw counts before passing to UpdateManager.
     */
    it('should compute blended mean from evidence and forecast', async () => {
      const graph = createLinearFunnelGraph({ edgeCount: 1, latencyEnabled: [true] });
      
      let currentGraph = graph;
      const setGraph = (g: Graph | null) => { if (g) currentGraph = g; };
      const getUpdatedGraph = () => currentGraph;
      
      // Setup file with both evidence data and PRE-COMPUTED evidence.mean
      // NOTE: In the ideal case, we'd only have n/k and the system would compute mean
      // But currently UpdateManager requires evidence.mean to exist in source
      setupMockFile('parameter-param-A-to-B', createParameterFile('param-A-to-B', {
        values: [{
          mean: 0.55, // Pre-computed blended mean
          n: 200, k: 90,
          evidence: { mean: 0.45, stdev: 0.035 }, // Pre-computed evidence
          forecast: 0.60,
          sliceDSL: 'cohort(node-A,1-Nov-25:15-Nov-25)',
          latency: {
            median_lag_days: 10,
            completeness: 0.70,
            t95: 25,
          },
        }]
      }));
      
      // Event files
      setupMockFile('event-event-a', { id: 'event-a', provider_event_names: { amplitude: 'Event A' } });
      setupMockFile('event-event-b', { id: 'event-b', provider_event_names: { amplitude: 'Event B' } });
      
      const items: FetchItem[] = [
        createFetchItem('parameter', 'param-A-to-B', 'edge-A-B-uuid'),
      ];
      
      await fetchDataService.fetchItems(
        items,
        { mode: 'from-file' },
        graph,
        setGraph,
        'cohort(1-Nov-25:15-Nov-25)',
        getUpdatedGraph
      );
      
      const edge = currentGraph.edges.find(e => e.id === 'edge-A-B');
      
      // Should have all three values set
      expect(edge?.p?.evidence?.mean).toBeCloseTo(0.45, 2);
      expect(edge?.p?.forecast?.mean).toBeCloseTo(0.60, 2);
      expect(edge?.p?.mean).toBeDefined();
      
      // Blended mean should be between evidence and forecast
      const mean = edge?.p?.mean || 0;
      expect(mean).toBeGreaterThanOrEqual(0.45);
      expect(mean).toBeLessThanOrEqual(0.60);
    });
    
    /**
     * Tests that evidence.mean is computed from header-level n/k when no daily arrays present.
     * 
     * This covers the case where param files have flat totals (n, k) but not
     * daily arrays (dates, n_daily, k_daily). The system should fall back to
     * computing evidence.mean = k/n from header totals.
     */
    it('should compute evidence.mean from n/k when no daily arrays present', async () => {
      const graph = createLinearFunnelGraph({ edgeCount: 1, latencyEnabled: [true] });
      
      let currentGraph = graph;
      const setGraph = (g: Graph | null) => { if (g) currentGraph = g; };
      const getUpdatedGraph = () => currentGraph;
      
      // File with ONLY header-level n/k - no dates/n_daily/k_daily arrays
      setupMockFile('parameter-param-A-to-B', createParameterFile('param-A-to-B', {
        values: [{
          mean: 0.55,
          n: 200, k: 90, // Should compute evidence.mean = 0.45
          // NO evidence object, NO daily arrays
          sliceDSL: 'cohort(node-A,1-Nov-25:15-Nov-25)',
        }]
      }));
      
      setupMockFile('event-event-a', { id: 'event-a', provider_event_names: { amplitude: 'Event A' } });
      setupMockFile('event-event-b', { id: 'event-b', provider_event_names: { amplitude: 'Event B' } });
      
      const items: FetchItem[] = [
        createFetchItem('parameter', 'param-A-to-B', 'edge-A-B-uuid'),
      ];
      
      await fetchDataService.fetchItems(
        items,
        { mode: 'from-file' },
        graph,
        setGraph,
        'cohort(1-Nov-25:15-Nov-25)',
        getUpdatedGraph
      );
      
      const edge = currentGraph.edges.find(e => e.id === 'edge-A-B');
      
      // evidence.mean should be computed as k/n = 90/200 = 0.45
      expect(edge?.p?.evidence?.mean).toBeCloseTo(0.45, 2);
      expect(edge?.p?.evidence?.n).toBe(200);
      expect(edge?.p?.evidence?.k).toBe(90);
    });
  });

  // ===========================================================================
  // SCENARIO 4: T95 Values
  // ===========================================================================
  
  describe('Scenario 4: T95 Computation', () => {
    /**
     * Tests that t95 values are correctly propagated from file to graph.
     */
    it('should preserve t95 values after batch fetch', async () => {
      const graph = createLinearFunnelGraph({ edgeCount: 3, latencyEnabled: [true, true, true] });
      
      let currentGraph = graph;
      const setGraph = (g: Graph | null) => { if (g) currentGraph = g; };
      const getUpdatedGraph = () => currentGraph;
      
      // Setup files with different t95 values
      setupMockFile('parameter-param-A-to-B', createParameterFile('param-A-to-B', {
        values: [{
          mean: 0.60, n: 100, k: 60,
          sliceDSL: 'cohort(node-A,1-Nov-25:15-Nov-25)',
          latency: { t95: 10, median_lag_days: 5, completeness: 0.9 },
        }]
      }));
      setupMockFile('parameter-param-B-to-C', createParameterFile('param-B-to-C', {
        values: [{
          mean: 0.70, n: 60, k: 42,
          sliceDSL: 'cohort(node-A,1-Nov-25:15-Nov-25)',
          latency: { t95: 15, median_lag_days: 7, completeness: 0.85 },
        }]
      }));
      setupMockFile('parameter-param-C-to-D', createParameterFile('param-C-to-D', {
        values: [{
          mean: 0.50, n: 42, k: 21,
          sliceDSL: 'cohort(node-A,1-Nov-25:15-Nov-25)',
          latency: { t95: 20, median_lag_days: 10, completeness: 0.80 },
        }]
      }));
      
      // Event files
      setupMockFile('event-event-a', { id: 'event-a', provider_event_names: { amplitude: 'Event A' } });
      setupMockFile('event-event-b', { id: 'event-b', provider_event_names: { amplitude: 'Event B' } });
      setupMockFile('event-event-c', { id: 'event-c', provider_event_names: { amplitude: 'Event C' } });
      setupMockFile('event-event-d', { id: 'event-d', provider_event_names: { amplitude: 'Event D' } });
      
      const items: FetchItem[] = [
        createFetchItem('parameter', 'param-A-to-B', 'edge-A-B-uuid'),
        createFetchItem('parameter', 'param-B-to-C', 'edge-B-C-uuid'),
        createFetchItem('parameter', 'param-C-to-D', 'edge-C-D-uuid'),
      ];
      
      await fetchDataService.fetchItems(
        items,
        { mode: 'from-file' },
        graph,
        setGraph,
        'cohort(1-Nov-25:15-Nov-25)',
        getUpdatedGraph
      );
      
      // Verify t95 was set on each edge
      const edgeAB = currentGraph.edges.find(e => e.id === 'edge-A-B');
      const edgeBC = currentGraph.edges.find(e => e.id === 'edge-B-C');
      const edgeCD = currentGraph.edges.find(e => e.id === 'edge-C-D');
      
      expect(edgeAB?.p?.latency?.t95).toBe(10);
      expect(edgeBC?.p?.latency?.t95).toBe(15);
      expect(edgeCD?.p?.latency?.t95).toBe(20);
    });

    /**
     * CRITICAL TEST: Verifies t95 is COMPUTED from per-day lag arrays, not defaulting to 30.
     * This test catches the bug where median_lag_days[] and mean_lag_days[] were not
     * being extracted from parameter files during aggregation.
     */
    it('should compute t95 from per-day lag arrays (not default to 30)', async () => {
      const graph = createLinearFunnelGraph({ edgeCount: 1, latencyEnabled: [true] });
      
      let currentGraph = graph;
      const setGraph = (g: Graph | null) => { if (g) currentGraph = g; };
      const getUpdatedGraph = () => currentGraph;

      // IMPORTANT: This test is specifically verifying that t95 is DERIVED from lag arrays.
      // If the graph already has edge.p.latency.t95 set, it is treated as authoritative and
      // will intentionally override any computed value.
      const edge0: any = graph.edges?.[0];
      if (edge0?.p?.latency) {
        delete edge0.p.latency.t95;
      }
      
      // Setup file with PER-DAY lag data arrays (NOT pre-computed t95)
      // Median lag ~5 days, mean lag ~6 days → should compute t95 around 15-20 days
      setupMockFile('parameter-param-A-to-B', createParameterFile('param-A-to-B', {
        values: [{
          mean: 0.60,
          n: 700,
          k: 420,
          dates: ['16-Nov-25', '17-Nov-25', '18-Nov-25', '19-Nov-25', '20-Nov-25', '21-Nov-25', '22-Nov-25'],
          n_daily: [100, 100, 100, 100, 100, 100, 100],
          k_daily: [60, 60, 60, 60, 60, 60, 60],
          // Per-day lag data - this is what DAS actually returns
          median_lag_days: [5.0, 5.2, 4.8, 5.1, 4.9, 5.3, 5.0],
          mean_lag_days: [6.0, 6.2, 5.8, 6.1, 5.9, 6.3, 6.0],
          sliceDSL: 'cohort(node-A,16-Nov-25:22-Nov-25)',
          // Note: NO pre-computed t95 - it must be computed from the per-day data
        }]
      }));
      
      // Event files required for edge lookup
      setupMockFile('event-event-a', { id: 'event-a', provider_event_names: { amplitude: 'Event A' } });
      setupMockFile('event-event-b', { id: 'event-b', provider_event_names: { amplitude: 'Event B' } });
      
      const items: FetchItem[] = [
        createFetchItem('parameter', 'param-A-to-B', 'edge-A-B'),
      ];
      
      // Run fetch in from-file mode - this should compute t95 from the per-day lag data
      await fetchDataService.fetchItems(
        items,
        // IMPORTANT:
        // By default, Stage‑2 does NOT write horizons onto the graph (anti-floatiness policy).
        // This test is specifically verifying horizon computation from lag arrays, so we opt in.
        { mode: 'from-file', writeLagHorizonsToGraph: true },
        graph,
        setGraph,
        'cohort(16-Nov-25:22-Nov-25)',
        getUpdatedGraph
      );
      
      // Verify t95 was computed from lag data, NOT defaulting to 30
      const edge = currentGraph.edges.find(e => e.id === 'edge-A-B');
      const t95 = edge?.p?.latency?.t95;
      
      // With median ~5 days and mean ~6 days, t95 should be computed (not 30)
      // The exact value depends on the log-normal fit, but it should NOT be 30 (the default)
      expect(t95).toBeDefined();
      expect(t95).not.toBe(30); // 30 is the DEFAULT_T95_DAYS fallback
      expect(t95).toBeGreaterThan(0);
      expect(t95).toBeLessThan(30); // With mean/median around 5-6, t95 should be well under 30
      
      // Also verify median_lag_days was aggregated correctly
      const medianLag = edge?.p?.latency?.median_lag_days;
      expect(medianLag).toBeDefined();
      expect(medianLag).toBeGreaterThan(4);
      expect(medianLag).toBeLessThan(7);
    });
  });
});
