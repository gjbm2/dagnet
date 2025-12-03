/**
 * Integration tests for DataOperationsService
 * 
 * These tests cover full roundtrip flows (Get → Put → Get) and ensure
 * data survives the complete cycle without corruption.
 * 
 * @group integration
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { dataOperationsService } from '../dataOperationsService';
import { updateManager } from '../UpdateManager';
import type { Graph, ConversionGraph } from '../../types';

// Mock toast
vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  }
}));

// Mock fileRegistry with in-memory storage
vi.mock('../../contexts/TabContext', () => {
  const mockFiles = new Map<string, any>();
  
  return {
    fileRegistry: {
      registerFile: vi.fn((id: string, data: any) => {
        mockFiles.set(id, { data: structuredClone(data) });
        return Promise.resolve();
      }) as any,
      getFile: vi.fn((id: string) => {
        return mockFiles.get(id);
      }) as any,
      updateFile: vi.fn((id: string, data: any) => {
        if (mockFiles.has(id)) {
          mockFiles.set(id, { data: structuredClone(data) });
        }
        return Promise.resolve();
      }) as any,
      deleteFile: vi.fn((id: string) => {
        mockFiles.delete(id);
        return Promise.resolve();
      }) as any,
      _mockFiles: mockFiles // For testing/clearing
    }
  };
});

// Import after mocking
const { fileRegistry } = await import('../../contexts/TabContext');

// Test fixtures
import { 
  createTestEdge, 
  createTestNode,
  createTestParameterFile,
  createTestCaseFile,
  createTestNodeFile,
  createTestGraph,
  createTestEdgeWithConditionalP,
  createTestConditionalParameterFile
} from './helpers/testFixtures';

describe('DataOperationsService Integration Tests', () => {
  
  beforeEach(() => {
    // Clear mocks and mock file storage before each test
    vi.clearAllMocks();
    (fileRegistry as any)._mockFiles.clear();
  });

  // ============================================================
  // PROBABILITY PARAMETERS
  // ============================================================

  describe('Probability Parameter Roundtrips', () => {
    it('basic probability: graph → file → graph preserves all fields', async () => {
      // Setup edge with probability data AND connection ID
      const edge = createTestEdge({
        uuid: 'edge-1',
        p: { 
          id: 'test-prob-param',  // Connect to parameter file
          mean: 0.45, 
          stdev: 0.03, 
          distribution: 'beta' 
        }
      });

      const paramFile = createTestParameterFile({
        id: 'test-prob-param',
        type: 'probability',
        values: []
      });

      // Register file
      await fileRegistry.registerFile('parameter-test-prob-param', paramFile);

      const graph = createTestGraph({ edges: [edge] });
      const setGraph = vi.fn();

      // Step 1: Put to file
      await dataOperationsService.putParameterToFile({
        paramId: 'test-prob-param',
        edgeId: 'edge-1',
        graph,
        setGraph
      });

      const fileAfterPut = fileRegistry.getFile('parameter-test-prob-param')!;
      const latestValue = fileAfterPut.data.values[fileAfterPut.data.values.length - 1];

      // Verify put added correct data with provenance
      expect(latestValue).toMatchObject({
        mean: 0.45,
        stdev: 0.03,
        distribution: 'beta',
        window_from: expect.stringMatching(/\d{4}-\d{2}-\d{2}T/),
        data_source: {
          type: 'manual',
          edited_at: expect.stringMatching(/\d{4}-\d{2}-\d{2}T/)
        }
      });

      // Verify no stale evidence data
      expect(latestValue).not.toHaveProperty('n');
      expect(latestValue).not.toHaveProperty('k');

      // Step 2: Connect and get back from file
      edge.p!.id = 'test-prob-param';
      const graphWithConnection = createTestGraph({ edges: [edge] });

      await dataOperationsService.getParameterFromFile({
        paramId: 'test-prob-param',
        edgeId: 'edge-1',
        graph: graphWithConnection,
        setGraph
      });

      // Verify setGraph was called with updated data
      expect(setGraph).toHaveBeenCalled();
      const updatedGraph = setGraph.mock.calls[setGraph.mock.calls.length - 1][0];
      const updatedEdge = updatedGraph.edges.find((e: any) => e.uuid === 'edge-1');

      // Verify data came back correctly
      expect(updatedEdge.p).toMatchObject({
        mean: 0.45,
        stdev: 0.03,
        distribution: 'beta',
        id: 'test-prob-param'  // Connection preserved
      });
    });

    it('probability with locked flag survives roundtrip', async () => {
      const edge = createTestEdge({
        uuid: 'edge-1',
        p: { 
          mean: 0.55, 
          stdev: 0.04, 
          distribution: 'beta',
          locked: true 
        }
      });

      const paramFile = createTestParameterFile({
        id: 'locked-param',
        type: 'probability',
        values: []
      });

      await fileRegistry.registerFile('parameter-locked-param', paramFile);
      const graph = createTestGraph({ edges: [edge] });
      const setGraph = vi.fn();

      // Put
      await dataOperationsService.putParameterToFile({
        paramId: 'locked-param',
        edgeId: 'edge-1',
        graph,
        setGraph
      });

      // Get back
      edge.p!.id = 'locked-param';
      await dataOperationsService.getParameterFromFile({
        paramId: 'locked-param',
        edgeId: 'edge-1',
        graph: createTestGraph({ edges: [edge] }),
        setGraph
      });

      const updatedGraph = setGraph.mock.calls[setGraph.mock.calls.length - 1][0];
      const updatedEdge = updatedGraph.edges.find((e: any) => e.uuid === 'edge-1');

      expect(updatedEdge.p.locked).toBe(true);
    });

    it('stale evidence data is NOT written to file', async () => {
      const edge = createTestEdge({
        uuid: 'edge-1',
        p: {
          id: 'no-stale-data',  // Connect to parameter file
          mean: 0.45,
          stdev: 0.03,
          distribution: 'beta',
          // Stale evidence from previous "get"
          evidence: {
            n: 6000,
            k: 2700,
            window_from: '2025-01-01T00:00:00Z',
            window_to: '2025-01-31T23:59:59Z'
          }
        }
      });

      const paramFile = createTestParameterFile({
        id: 'no-stale-data',
        type: 'probability',
        values: []
      });

      await fileRegistry.registerFile('parameter-no-stale-data', paramFile);
      const graph = createTestGraph({ edges: [edge] });
      const setGraph = vi.fn();

      await dataOperationsService.putParameterToFile({
        paramId: 'no-stale-data',
        edgeId: 'edge-1',
        graph,
        setGraph
      });

      const fileAfterPut = fileRegistry.getFile('parameter-no-stale-data');
      const latestValue = fileAfterPut!.data.values[fileAfterPut!.data.values.length - 1];

      expect(latestValue.mean).toBe(0.45);
      expect(latestValue).not.toHaveProperty('n');
      expect(latestValue).not.toHaveProperty('k');
      expect(latestValue).not.toHaveProperty('window_to');
    });
  });

  // ============================================================
  // CONDITIONAL PROBABILITY PARAMETERS (PARITY WITH edge.p)
  // ============================================================

  describe('Conditional Probability Parameter Roundtrips', () => {
    /**
     * PARITY PRINCIPLE: conditional_p MUST behave identically to edge.p
     * in all file management, data operations, and scenarios.
     * 
     * The ONLY differences are:
     * - conditional_p uses conditionalIndex to target specific entries
     * - conditional_p entries have a `condition` string (e.g., "visited(promo)")
     * - n_query is not yet implemented for conditional_p
     */

    it('conditional_p[0]: graph → file → graph preserves all fields', async () => {
      // Setup edge with conditional_p array
      const edge = createTestEdgeWithConditionalP({
        uuid: 'edge-1',
        conditional_p: [
          {
            condition: 'visited(promo)',
            p: {
              id: 'cond-param-0',
              mean: 0.65,
              stdev: 0.04,
              distribution: 'beta'
            }
          }
        ]
      });

      const paramFile = createTestConditionalParameterFile({
        id: 'cond-param-0',
        type: 'conditional_probability',
        values: []
      });

      // Register file
      await fileRegistry.registerFile('parameter-cond-param-0', paramFile);

      const graph = createTestGraph({ edges: [edge] });
      const setGraph = vi.fn();

      // Step 1: Put to file (targeting conditionalIndex: 0)
      await dataOperationsService.putParameterToFile({
        paramId: 'cond-param-0',
        edgeId: 'edge-1',
        graph,
        setGraph,
        conditionalIndex: 0
      });

      const fileAfterPut = fileRegistry.getFile('parameter-cond-param-0')!;
      const latestValue = fileAfterPut.data.values[fileAfterPut.data.values.length - 1];

      // Verify put added correct data with provenance
      expect(latestValue).toMatchObject({
        mean: 0.65,
        stdev: 0.04,
        distribution: 'beta',
        window_from: expect.stringMatching(/\d{4}-\d{2}-\d{2}T/),
        data_source: {
          type: 'manual',
          edited_at: expect.stringMatching(/\d{4}-\d{2}-\d{2}T/)
        }
      });

      // Step 2: Get back from file (targeting conditionalIndex: 0)
      await dataOperationsService.getParameterFromFile({
        paramId: 'cond-param-0',
        edgeId: 'edge-1',
        graph,
        setGraph,
        conditionalIndex: 0
      });

      // Verify setGraph was called with updated conditional_p
      expect(setGraph).toHaveBeenCalled();
      const updatedGraph = setGraph.mock.calls[setGraph.mock.calls.length - 1][0];
      const updatedEdge = updatedGraph.edges.find((e: any) => e.uuid === 'edge-1');

      // Verify conditional_p[0].p was updated correctly
      expect(updatedEdge.conditional_p[0].p).toMatchObject({
        mean: 0.65,
        stdev: 0.04,
        distribution: 'beta',
        id: 'cond-param-0'  // Connection preserved
      });

      // Verify condition is preserved
      expect(updatedEdge.conditional_p[0].condition).toBe('visited(promo)');
    });

    it('conditional_p[1]: second entry in array roundtrips correctly', async () => {
      // Setup edge with multiple conditional_p entries
      const edge = createTestEdgeWithConditionalP({
        uuid: 'edge-1',
        conditional_p: [
          {
            condition: 'visited(promo)',
            p: { id: 'cond-param-0', mean: 0.65, stdev: 0.04, distribution: 'beta' }
          },
          {
            condition: 'visited(checkout)',
            p: { id: 'cond-param-1', mean: 0.45, stdev: 0.03, distribution: 'beta' }
          }
        ]
      });

      const paramFile = createTestConditionalParameterFile({
        id: 'cond-param-1',
        type: 'conditional_probability',
        values: []
      });

      await fileRegistry.registerFile('parameter-cond-param-1', paramFile);

      const graph = createTestGraph({ edges: [edge] });
      const setGraph = vi.fn();

      // Put conditional_p[1] to file
      await dataOperationsService.putParameterToFile({
        paramId: 'cond-param-1',
        edgeId: 'edge-1',
        graph,
        setGraph,
        conditionalIndex: 1  // Second entry
      });

      const fileAfterPut = fileRegistry.getFile('parameter-cond-param-1')!;
      const latestValue = fileAfterPut.data.values[fileAfterPut.data.values.length - 1];

      // Verify correct entry was written (0.45, not 0.65)
      expect(latestValue.mean).toBe(0.45);
      expect(latestValue.stdev).toBe(0.03);

      // Get back from file
      await dataOperationsService.getParameterFromFile({
        paramId: 'cond-param-1',
        edgeId: 'edge-1',
        graph,
        setGraph,
        conditionalIndex: 1
      });

      const updatedGraph = setGraph.mock.calls[setGraph.mock.calls.length - 1][0];
      const updatedEdge = updatedGraph.edges.find((e: any) => e.uuid === 'edge-1');

      // Verify conditional_p[1].p was updated, not [0]
      expect(updatedEdge.conditional_p[1].p.mean).toBe(0.45);
      expect(updatedEdge.conditional_p[1].condition).toBe('visited(checkout)');
      
      // Verify conditional_p[0] is unchanged
      expect(updatedEdge.conditional_p[0].p.mean).toBe(0.65);
    });

    it('conditional_p with locked flag survives roundtrip', async () => {
      const edge = createTestEdgeWithConditionalP({
        uuid: 'edge-1',
        conditional_p: [{
          condition: 'visited(promo)',
          p: {
            id: 'locked-cond-param',
            mean: 0.55,
            stdev: 0.04,
            distribution: 'beta',
            locked: true
          }
        }]
      });

      const paramFile = createTestConditionalParameterFile({
        id: 'locked-cond-param',
        type: 'conditional_probability',
        values: []
      });

      await fileRegistry.registerFile('parameter-locked-cond-param', paramFile);
      const graph = createTestGraph({ edges: [edge] });
      const setGraph = vi.fn();

      // Put
      await dataOperationsService.putParameterToFile({
        paramId: 'locked-cond-param',
        edgeId: 'edge-1',
        graph,
        setGraph,
        conditionalIndex: 0
      });

      // Get back
      await dataOperationsService.getParameterFromFile({
        paramId: 'locked-cond-param',
        edgeId: 'edge-1',
        graph,
        setGraph,
        conditionalIndex: 0
      });

      const updatedGraph = setGraph.mock.calls[setGraph.mock.calls.length - 1][0];
      const updatedEdge = updatedGraph.edges.find((e: any) => e.uuid === 'edge-1');

      expect(updatedEdge.conditional_p[0].p.locked).toBe(true);
    });

    it('conditional_p stale evidence data is NOT written to file', async () => {
      const edge = createTestEdgeWithConditionalP({
        uuid: 'edge-1',
        conditional_p: [{
          condition: 'visited(promo)',
          p: {
            id: 'no-stale-cond',
            mean: 0.45,
            stdev: 0.03,
            distribution: 'beta',
            // Stale evidence from previous "get"
            evidence: {
              n: 6000,
              k: 2700,
              window_from: '2025-01-01T00:00:00Z',
              window_to: '2025-01-31T23:59:59Z'
            }
          }
        }]
      });

      const paramFile = createTestConditionalParameterFile({
        id: 'no-stale-cond',
        type: 'conditional_probability',
        values: []
      });

      await fileRegistry.registerFile('parameter-no-stale-cond', paramFile);
      const graph = createTestGraph({ edges: [edge] });
      const setGraph = vi.fn();

      await dataOperationsService.putParameterToFile({
        paramId: 'no-stale-cond',
        edgeId: 'edge-1',
        graph,
        setGraph,
        conditionalIndex: 0
      });

      const fileAfterPut = fileRegistry.getFile('parameter-no-stale-cond');
      const latestValue = fileAfterPut!.data.values[fileAfterPut!.data.values.length - 1];

      expect(latestValue.mean).toBe(0.45);
      expect(latestValue).not.toHaveProperty('n');
      expect(latestValue).not.toHaveProperty('k');
      expect(latestValue).not.toHaveProperty('window_to');
    });

    it('conditional_p id preserved after multiple gets', async () => {
      const edge = createTestEdgeWithConditionalP({
        uuid: 'edge-1',
        conditional_p: [{
          condition: 'visited(promo)',
          p: { id: 'my-cond-param', mean: 0.5, stdev: 0.05, distribution: 'beta' }
        }]
      });

      const paramFile = createTestConditionalParameterFile({
        id: 'my-cond-param',
        values: [{ mean: 0.55, stdev: 0.04, distribution: 'beta', window_from: '2025-01-01T00:00:00Z' }]
      });

      await fileRegistry.registerFile('parameter-my-cond-param', paramFile);
      const graph = createTestGraph({ edges: [edge] });
      const setGraph = vi.fn();

      // First get
      await dataOperationsService.getParameterFromFile({
        paramId: 'my-cond-param',
        edgeId: 'edge-1',
        graph,
        setGraph,
        conditionalIndex: 0
      });

      let updatedGraph = setGraph.mock.calls[0][0];
      let updatedEdge = updatedGraph.edges.find((e: any) => e.uuid === 'edge-1');
      expect(updatedEdge.conditional_p[0].p.id).toBe('my-cond-param');

      // Update file
      paramFile.values.push({ mean: 0.60, stdev: 0.03, distribution: 'beta', window_from: '2025-02-01T00:00:00Z' });
      await fileRegistry.updateFile('parameter-my-cond-param', paramFile);

      // Second get
      await dataOperationsService.getParameterFromFile({
        paramId: 'my-cond-param',
        edgeId: 'edge-1',
        graph: updatedGraph,
        setGraph,
        conditionalIndex: 0
      });

      updatedGraph = setGraph.mock.calls[1][0];
      updatedEdge = updatedGraph.edges.find((e: any) => e.uuid === 'edge-1');

      expect(updatedEdge.conditional_p[0].p.id).toBe('my-cond-param');  // Still preserved
      expect(updatedEdge.conditional_p[0].p.mean).toBe(0.60);  // Updated value
    });
  });

  describe('Conditional Probability values[latest] Resolution', () => {
    it('finds most recent conditional_p by window_from, not array order', async () => {
      const paramFile = createTestConditionalParameterFile({
        id: 'cond-latest',
        type: 'conditional_probability',
        values: [
          { mean: 0.42, window_from: '2025-01-01T00:00:00Z' },
          { mean: 0.45, window_from: '2025-02-01T00:00:00Z' },
          { mean: 0.30, window_from: '2025-03-01T00:00:00Z' },  // ← Most recent
          { mean: 0.35, window_from: '2025-01-15T00:00:00Z' }   // ← Added later but older
        ]
      });

      const edge = createTestEdgeWithConditionalP({
        uuid: 'edge-1',
        conditional_p: [{
          condition: 'visited(promo)',
          p: { id: 'cond-latest' }
        }]
      });

      await fileRegistry.registerFile('parameter-cond-latest', paramFile);
      const graph = createTestGraph({ edges: [edge] });
      const setGraph = vi.fn();

      await dataOperationsService.getParameterFromFile({
        paramId: 'cond-latest',
        edgeId: 'edge-1',
        graph,
        setGraph,
        conditionalIndex: 0
      });

      const updatedGraph = setGraph.mock.calls[0][0];
      const updatedEdge = updatedGraph.edges.find((e: any) => e.uuid === 'edge-1');

      // Should get 2025-03-01 entry (mean: 0.30), not last in array
      expect(updatedEdge.conditional_p[0].p.mean).toBe(0.30);
    });

    it('after put, new conditional_p entry becomes latest', async () => {
      const edge = createTestEdgeWithConditionalP({
        uuid: 'edge-1',
        conditional_p: [{
          condition: 'visited(promo)',
          p: { id: 'cond-new-latest', mean: 0.50, stdev: 0.05, distribution: 'beta' }
        }]
      });

      const paramFile = createTestConditionalParameterFile({
        id: 'cond-new-latest',
        type: 'conditional_probability',
        values: [
          { mean: 0.42, window_from: '2025-01-01T00:00:00Z' },
          { mean: 0.45, window_from: '2025-02-01T00:00:00Z' }
        ]
      });

      await fileRegistry.registerFile('parameter-cond-new-latest', paramFile);
      const graph = createTestGraph({ edges: [edge] });
      const setGraph = vi.fn();

      // Put new value
      await dataOperationsService.putParameterToFile({
        paramId: 'cond-new-latest',
        edgeId: 'edge-1',
        graph,
        setGraph,
        conditionalIndex: 0
      });

      // Get back - should retrieve the newly added value
      await dataOperationsService.getParameterFromFile({
        paramId: 'cond-new-latest',
        edgeId: 'edge-1',
        graph,
        setGraph,
        conditionalIndex: 0
      });

      const updatedGraph = setGraph.mock.calls[setGraph.mock.calls.length - 1][0];
      const updatedEdge = updatedGraph.edges.find((e: any) => e.uuid === 'edge-1');

      expect(updatedEdge.conditional_p[0].p.mean).toBe(0.50);  // Our new value
    });
  });

  describe('Conditional Probability Error Conditions', () => {
    it('missing conditionalIndex gracefully falls back to edge.p', async () => {
      // When conditionalIndex is NOT provided, operations target edge.p
      const edge = createTestEdgeWithConditionalP({
        uuid: 'edge-1',
        p: { id: 'base-param', mean: 0.5, stdev: 0.05, distribution: 'beta' },
        conditional_p: [{
          condition: 'visited(promo)',
          p: { id: 'cond-param', mean: 0.65, stdev: 0.04, distribution: 'beta' }
        }]
      });

      const paramFile = createTestParameterFile({
        id: 'base-param',
        type: 'probability',
        values: [{ mean: 0.55, stdev: 0.04, distribution: 'beta', window_from: '2025-01-01T00:00:00Z' }]
      });

      await fileRegistry.registerFile('parameter-base-param', paramFile);
      const graph = createTestGraph({ edges: [edge] });
      const setGraph = vi.fn();

      // Get WITHOUT conditionalIndex - should update edge.p, not conditional_p
      await dataOperationsService.getParameterFromFile({
        paramId: 'base-param',
        edgeId: 'edge-1',
        graph,
        setGraph
        // NO conditionalIndex
      });

      const updatedGraph = setGraph.mock.calls[0][0];
      const updatedEdge = updatedGraph.edges.find((e: any) => e.uuid === 'edge-1');

      // edge.p should be updated
      expect(updatedEdge.p.mean).toBe(0.55);
      // conditional_p should be unchanged
      expect(updatedEdge.conditional_p[0].p.mean).toBe(0.65);
    });

    it('invalid conditionalIndex does not crash', async () => {
      const edge = createTestEdgeWithConditionalP({
        uuid: 'edge-1',
        conditional_p: [{
          condition: 'visited(promo)',
          p: { id: 'cond-param', mean: 0.65, stdev: 0.04, distribution: 'beta' }
        }]
      });

      const paramFile = createTestConditionalParameterFile({
        id: 'cond-param',
        values: [{ mean: 0.55, window_from: '2025-01-01T00:00:00Z' }]
      });

      await fileRegistry.registerFile('parameter-cond-param', paramFile);
      const graph = createTestGraph({ edges: [edge] });
      const setGraph = vi.fn();

      // Try to get conditionalIndex: 5 (out of bounds) - should not throw
      await dataOperationsService.getParameterFromFile({
        paramId: 'cond-param',
        edgeId: 'edge-1',
        graph,
        setGraph,
        conditionalIndex: 5  // Invalid - only index 0 exists
      });

      // setGraph should not be called on error
      expect(setGraph).not.toHaveBeenCalled();
    });

    it('edge with no conditional_p array does not crash when conditionalIndex provided', async () => {
      // Edge WITHOUT conditional_p
      const edge = createTestEdge({
        uuid: 'edge-1',
        p: { id: 'test-param', mean: 0.5, stdev: 0.05, distribution: 'beta' }
        // NO conditional_p array
      });

      const paramFile = createTestParameterFile({
        id: 'test-param',
        values: [{ mean: 0.55, window_from: '2025-01-01T00:00:00Z' }]
      });

      await fileRegistry.registerFile('parameter-test-param', paramFile);
      const graph = createTestGraph({ edges: [edge] });
      const setGraph = vi.fn();

      // Try to get with conditionalIndex even though edge has no conditional_p
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-param',
        edgeId: 'edge-1',
        graph,
        setGraph,
        conditionalIndex: 0
      });

      // Should not crash, setGraph not called on error
      expect(setGraph).not.toHaveBeenCalled();
    });
  });

  describe('Multi-Conditional Edge Operations', () => {
    it('only specified conditional_p entry is written (no cross-contamination)', async () => {
      const edge = createTestEdgeWithConditionalP({
        uuid: 'edge-1',
        conditional_p: [
          {
            condition: 'visited(promo)',
            p: { id: 'cond-param-a', mean: 0.65, stdev: 0.04, distribution: 'beta' }
          },
          {
            condition: 'visited(checkout)',
            p: { id: 'cond-param-b', mean: 0.45, stdev: 0.03, distribution: 'beta' }
          }
        ]
      });

      // Create two separate parameter files
      await fileRegistry.registerFile('parameter-cond-param-a', createTestConditionalParameterFile({
        id: 'cond-param-a',
        values: []
      }));

      await fileRegistry.registerFile('parameter-cond-param-b', createTestConditionalParameterFile({
        id: 'cond-param-b',
        values: []
      }));

      const graph = createTestGraph({ edges: [edge] });
      const setGraph = vi.fn();

      // Put only conditional_p[0]
      await dataOperationsService.putParameterToFile({
        paramId: 'cond-param-a',
        edgeId: 'edge-1',
        graph,
        setGraph,
        conditionalIndex: 0
      });

      const fileA = fileRegistry.getFile('parameter-cond-param-a');
      const latestA = fileA!.data.values[fileA!.data.values.length - 1];
      expect(latestA.mean).toBe(0.65);

      // Put only conditional_p[1]
      await dataOperationsService.putParameterToFile({
        paramId: 'cond-param-b',
        edgeId: 'edge-1',
        graph,
        setGraph,
        conditionalIndex: 1
      });

      const fileB = fileRegistry.getFile('parameter-cond-param-b');
      const latestB = fileB!.data.values[fileB!.data.values.length - 1];
      expect(latestB.mean).toBe(0.45);

      // Verify no cross-contamination
      const allAValues = fileA!.data.values.map((v: any) => v.mean);
      expect(allAValues).not.toContain(0.45);

      const allBValues = fileB!.data.values.map((v: any) => v.mean);
      expect(allBValues).not.toContain(0.65);
    });

    it('can put/get edge.p and conditional_p independently', async () => {
      const edge = createTestEdgeWithConditionalP({
        uuid: 'edge-1',
        p: { id: 'base-param', mean: 0.5, stdev: 0.05, distribution: 'beta' },
        conditional_p: [{
          condition: 'visited(promo)',
          p: { id: 'cond-param', mean: 0.65, stdev: 0.04, distribution: 'beta' }
        }]
      });

      // Create both files
      await fileRegistry.registerFile('parameter-base-param', createTestParameterFile({
        id: 'base-param',
        type: 'probability',
        values: []
      }));

      await fileRegistry.registerFile('parameter-cond-param', createTestConditionalParameterFile({
        id: 'cond-param',
        values: []
      }));

      const graph = createTestGraph({ edges: [edge] });
      const setGraph = vi.fn();

      // Put edge.p (no conditionalIndex)
      await dataOperationsService.putParameterToFile({
        paramId: 'base-param',
        edgeId: 'edge-1',
        graph,
        setGraph
      });

      // Put conditional_p[0] (with conditionalIndex)
      await dataOperationsService.putParameterToFile({
        paramId: 'cond-param',
        edgeId: 'edge-1',
        graph,
        setGraph,
        conditionalIndex: 0
      });

      // Verify both files have correct data
      const baseFile = fileRegistry.getFile('parameter-base-param');
      expect(baseFile!.data.values[baseFile!.data.values.length - 1].mean).toBe(0.5);

      const condFile = fileRegistry.getFile('parameter-cond-param');
      expect(condFile!.data.values[condFile!.data.values.length - 1].mean).toBe(0.65);
    });
  });

  // ============================================================
  // COST PARAMETERS (GBP & TIME)
  // ============================================================

  describe('Cost Parameter Roundtrips', () => {
    it('cost_gbp: roundtrip preserves all fields', async () => {
      const edge = createTestEdge({
        uuid: 'edge-1',
        cost_gbp: {
          id: 'cost-gbp-param',  // Connect to parameter file
          mean: 14.8,
          stdev: 2.9,
          distribution: 'lognormal'
        }
      });

      const paramFile = createTestParameterFile({
        id: 'cost-gbp-param',
        type: 'cost_gbp',
        values: []
      });

      await fileRegistry.registerFile('parameter-cost-gbp-param', paramFile);
      const graph = createTestGraph({ edges: [edge] });
      const setGraph = vi.fn();

      // Put
      await dataOperationsService.putParameterToFile({
        paramId: 'cost-gbp-param',
        edgeId: 'edge-1',
        graph,
        setGraph
      });

      const fileAfterPut = fileRegistry.getFile('parameter-cost-gbp-param');
      const latestValue = fileAfterPut!.data.values[fileAfterPut!.data.values.length - 1];

      expect(latestValue).toMatchObject({
        mean: 14.8,
        stdev: 2.9,
        distribution: 'lognormal',
        data_source: { type: 'manual' }
      });

      // Get back
      edge.cost_gbp!.id = 'cost-gbp-param';
      await dataOperationsService.getParameterFromFile({
        paramId: 'cost-gbp-param',
        edgeId: 'edge-1',
        graph: createTestGraph({ edges: [edge] }),
        setGraph
      });

      const updatedGraph = setGraph.mock.calls[setGraph.mock.calls.length - 1][0];
      const updatedEdge = updatedGraph.edges.find((e: any) => e.uuid === 'edge-1');

      expect(updatedEdge.cost_gbp).toMatchObject({
        mean: 14.8,
        stdev: 2.9,
        distribution: 'lognormal',
        id: 'cost-gbp-param'
      });
    });

    it('cost_time: roundtrip with lognormal distribution', async () => {
      const edge = createTestEdge({
        uuid: 'edge-1',
        cost_time: {
          mean: 310,
          stdev: 95,
          distribution: 'lognormal'
        }
      });

      const paramFile = createTestParameterFile({
        id: 'checkout-duration',
        type: 'cost_time',
        values: []
      });

      await fileRegistry.registerFile('parameter-checkout-duration', paramFile);
      const graph = createTestGraph({ edges: [edge] });
      const setGraph = vi.fn();

      // Put
      await dataOperationsService.putParameterToFile({
        paramId: 'checkout-duration',
        edgeId: 'edge-1',
        graph,
        setGraph
      });

      // Get back
      edge.cost_time!.id = 'checkout-duration';
      await dataOperationsService.getParameterFromFile({
        paramId: 'checkout-duration',
        edgeId: 'edge-1',
        graph: createTestGraph({ edges: [edge] }),
        setGraph
      });

      const updatedGraph = setGraph.mock.calls[setGraph.mock.calls.length - 1][0];
      const updatedEdge = updatedGraph.edges.find((e: any) => e.uuid === 'edge-1');

      expect(updatedEdge.cost_time).toMatchObject({
        mean: 310,
        stdev: 95,
        distribution: 'lognormal',
        id: 'checkout-duration'
      });
    });
  });

  // ============================================================
  // MULTI-PARAMETER EDGES
  // ============================================================

  describe('Multi-Parameter Edge Operations', () => {
    it('only specified parameter is written (no cross-contamination)', async () => {
      const edge = createTestEdge({
        uuid: 'edge-1',
        p: { mean: 0.45, stdev: 0.03, distribution: 'beta', id: 'param-p' },
        cost_gbp: { mean: 14.8, stdev: 2.9, distribution: 'lognormal', id: 'param-gbp' },
        cost_time: { mean: 310, stdev: 95, distribution: 'lognormal', id: 'param-time' }
      });

      // Create three separate parameter files
      await fileRegistry.registerFile('parameter-param-p', createTestParameterFile({
        id: 'param-p',
        type: 'probability',
        values: []
      }));

      await fileRegistry.registerFile('parameter-param-gbp', createTestParameterFile({
        id: 'param-gbp',
        type: 'cost_gbp',
        values: []
      }));

      await fileRegistry.registerFile('parameter-param-time', createTestParameterFile({
        id: 'param-time',
        type: 'cost_time',
        values: []
      }));

      const graph = createTestGraph({ edges: [edge] });
      const setGraph = vi.fn();

      // Put only probability parameter
      await dataOperationsService.putParameterToFile({
        paramId: 'param-p',
        edgeId: 'edge-1',
        graph,
        setGraph
      });

      const fileP = fileRegistry.getFile('parameter-param-p');
      const latestP = fileP!.data.values[fileP!.data.values.length - 1];
      expect(latestP.mean).toBe(0.45);
      expect(latestP.distribution).toBe('beta');

      // Put only cost_time parameter
      await dataOperationsService.putParameterToFile({
        paramId: 'param-time',
        edgeId: 'edge-1',
        graph,
        setGraph
      });

      const fileTime = fileRegistry.getFile('parameter-param-time');
      const latestTime = fileTime!.data.values[fileTime!.data.values.length - 1];
      expect(latestTime.mean).toBe(310);
      expect(latestTime.distribution).toBe('lognormal');

      // Verify no cross-contamination
      const allPValues = fileP!.data.values.map((v: any) => v.mean);
      expect(allPValues).not.toContain(310);
      expect(allPValues).not.toContain(14.8);

      const allTimeValues = fileTime!.data.values.map((v: any) => v.mean);
      expect(allTimeValues).not.toContain(0.45);
      expect(allTimeValues).not.toContain(14.8);
    });

    it('putting unconnected parameter does not crash', async () => {
      const edge = createTestEdge({
        uuid: 'edge-1',
        p: { mean: 0.45, id: 'param-a' },
        cost_time: { mean: 310, id: 'param-b' }
      });

      await fileRegistry.registerFile('parameter-param-c', createTestParameterFile({
        id: 'param-c',
        type: 'probability',
        values: []
      }));

      const graph = createTestGraph({ edges: [edge] });
      const setGraph = vi.fn();

      // Try to put param-c (not connected to this edge) - should use toast.error, not throw
      await dataOperationsService.putParameterToFile({
        paramId: 'param-c',
        edgeId: 'edge-1',
        graph,
        setGraph
      });
      
      // File should not be updated
      const file = fileRegistry.getFile('parameter-param-c');
      expect(file!.data.values).toHaveLength(0);
    });
  });

  // ============================================================
  // NODES
  // ============================================================

  describe('Node Roundtrips', () => {
    it('node: graph → file → graph preserves data', async () => {
      const node = createTestNode({
        uuid: 'node-1',
        id: 'checkout',
        label: 'Checkout Process',
        description: 'User checkout flow'
      });

      const nodeFile = createTestNodeFile({
        id: 'checkout',
        name: 'Checkout Process From File',
        description: 'Updated description from file'
      });

      await fileRegistry.registerFile('node-checkout', nodeFile);
      const graph = createTestGraph({ nodes: [node] });
      const setGraph = vi.fn();

      // Get from file
      await dataOperationsService.getNodeFromFile({
        nodeId: 'checkout',
        targetNodeUuid: 'node-1',
        graph,
        setGraph
      });

      const updatedGraph = setGraph.mock.calls[0][0];
      const updatedNode = updatedGraph.nodes.find((n: any) => n.uuid === 'node-1');

      expect(updatedNode).toMatchObject({
        id: 'checkout',  // ID preserved
        label: 'Checkout Process From File',
        description: 'Updated description from file'
      });
    });

    it('node.id preserved after multiple gets', async () => {
      const node = createTestNode({
        uuid: 'node-1',
        id: 'my-node'
      });

      const nodeFile = createTestNodeFile({
        id: 'my-node',
        name: 'Node Name v1'
      });

      await fileRegistry.registerFile('node-my-node', nodeFile);
      const graph = createTestGraph({ nodes: [node] });
      const setGraph = vi.fn();

      // Get from file
      await dataOperationsService.getNodeFromFile({
        nodeId: 'my-node',
        targetNodeUuid: 'node-1',
        graph,
        setGraph
      });

      let updatedGraph = setGraph.mock.calls[0][0];
      let updatedNode = updatedGraph.nodes.find((n: any) => n.uuid === 'node-1');
      expect(updatedNode.id).toBe('my-node');

      // Update file
      nodeFile.name = 'Node Name v2';
      await fileRegistry.updateFile('node-my-node', nodeFile);

      // Get again
      await dataOperationsService.getNodeFromFile({
        nodeId: 'my-node',
        targetNodeUuid: 'node-1',
        graph: updatedGraph,
        setGraph
      });

      updatedGraph = setGraph.mock.calls[1][0];
      updatedNode = updatedGraph.nodes.find((n: any) => n.uuid === 'node-1');
      
      expect(updatedNode.id).toBe('my-node');  // Still preserved
      expect(updatedNode.label).toBe('Node Name v2');
    });
  });

  // ============================================================
  // CASES
  // ============================================================

  describe('Case Roundtrips', () => {
    it('case: graph → file → graph preserves variants', async () => {
      const node = createTestNode({
        uuid: 'node-1',
        type: 'case',
        case: {
          id: 'checkout-test-2025',
          status: 'active',
          variants: [
            { name: 'control', weight: 0.5 },
            { name: 'treatment', weight: 0.5 }
          ]
        }
      });

      const caseFile = createTestCaseFile({
        id: 'checkout-test-2025',
        case: {
          id: 'checkout-test-2025',
          status: 'active',
          variants: [
            { name: 'control', weight: 0.3 },
            { name: 'treatment', weight: 0.7 }
          ],
          schedules: []
        }
      });

      await fileRegistry.registerFile('case-checkout-test-2025', caseFile);
      const graph = createTestGraph({ nodes: [node] });
      const setGraph = vi.fn();

      // Get from file
      await dataOperationsService.getCaseFromFile({
        caseId: 'checkout-test-2025',
        nodeId: 'node-1',
        graph,
        setGraph
      });

      const updatedGraph = setGraph.mock.calls[0][0];
      const updatedNode = updatedGraph.nodes.find((n: any) => n.uuid === 'node-1');

      expect(updatedNode.case).toMatchObject({
        id: 'checkout-test-2025',
        status: 'active',
        variants: [
          { name: 'control', weight: 0.3 },
          { name: 'treatment', weight: 0.7 }
        ]
      });
    });

    it('case: put to file includes provenance', async () => {
      const node = createTestNode({
        uuid: 'node-1',
        id: 'test-node',  // Node needs an ID
        type: 'case',
        case: {
          id: 'my-test',
          status: 'active',
          variants: [
            { name: 'control', weight: 0.3 },
            { name: 'treatment', weight: 0.7 }
          ]
        }
      });

      const caseFile = createTestCaseFile({
        id: 'my-test',
        case: {
          id: 'my-test',
          status: 'active',
          variants: [],
          schedules: []
        }
      });

      await fileRegistry.registerFile('case-my-test', caseFile);
      const graph = createTestGraph({ nodes: [node] });
      const setGraph = vi.fn();

      // Put to file
      await dataOperationsService.putCaseToFile({
        caseId: 'my-test',
        nodeId: 'node-1',
        graph,
        setGraph
      });

      const fileAfterPut = fileRegistry.getFile('case-my-test');
      const latestSchedule = fileAfterPut!.data.case.schedules[fileAfterPut!.data.case.schedules.length - 1];

      expect(latestSchedule).toMatchObject({
        variants: [
          { name: 'control', weight: 0.3 },
          { name: 'treatment', weight: 0.7 }
        ],
        window_from: expect.stringMatching(/\d{4}-\d{2}-\d{2}T/),
        source: 'manual',
        edited_at: expect.stringMatching(/\d{4}-\d{2}-\d{2}T/)
      });
    });

    it('case.id preserved after get', async () => {
      const node = createTestNode({
        uuid: 'node-1',
        type: 'case',
        case: {
          id: 'my-case',
          status: 'active',
          variants: []
        }
      });

      const caseFile = createTestCaseFile({
        id: 'my-case',
        case: {
          id: 'my-case',
          status: 'paused',
          variants: [
            { name: 'control', weight: 0.5 },
            { name: 'treatment', weight: 0.5 }
          ],
          schedules: []
        }
      });

      await fileRegistry.registerFile('case-my-case', caseFile);
      const graph = createTestGraph({ nodes: [node] });
      const setGraph = vi.fn();

      await dataOperationsService.getCaseFromFile({
        caseId: 'my-case',
        nodeId: 'node-1',
        graph,
        setGraph
      });

      const updatedGraph = setGraph.mock.calls[0][0];
      const updatedNode = updatedGraph.nodes.find((n: any) => n.uuid === 'node-1');

      expect(updatedNode.case.id).toBe('my-case');
      expect(updatedNode.case.status).toBe('paused');
      expect(updatedNode.case.variants).toHaveLength(2);
    });
  });

  // ============================================================
  // values[latest] RESOLUTION
  // ============================================================

  describe('values[latest] Timestamp Sorting', () => {
    it('finds most recent by window_from, not array order', async () => {
      const paramFile = createTestParameterFile({
        id: 'test-latest',
        type: 'probability',
        values: [
          { mean: 0.42, window_from: '2025-01-01T00:00:00Z' },
          { mean: 0.45, window_from: '2025-02-01T00:00:00Z' },
          { mean: 0.30, window_from: '2025-03-01T00:00:00Z' },  // ← Most recent
          { mean: 0.35, window_from: '2025-01-15T00:00:00Z' }   // ← Added later but older
        ]
      });

      const edge = createTestEdge({
        uuid: 'edge-1',
        p: { id: 'test-latest' }
      });

      await fileRegistry.registerFile('parameter-test-latest', paramFile);
      const graph = createTestGraph({ edges: [edge] });
      const setGraph = vi.fn();

      await dataOperationsService.getParameterFromFile({
        paramId: 'test-latest',
        edgeId: 'edge-1',
        graph,
        setGraph
      });

      const updatedGraph = setGraph.mock.calls[0][0];
      const updatedEdge = updatedGraph.edges.find((e: any) => e.uuid === 'edge-1');

      // Should get 2025-03-01 entry (mean: 0.30), not last in array
      expect(updatedEdge.p.mean).toBe(0.30);
    });

    it('handles missing window_from (treats as epoch)', async () => {
      const paramFile = createTestParameterFile({
        id: 'test-no-timestamp',
        type: 'probability',
        values: [
          { mean: 0.42, window_from: '2025-01-01T00:00:00Z' },
          { mean: 0.35 }  // No timestamp, should sort as oldest
        ]
      });

      const edge = createTestEdge({
        uuid: 'edge-1',
        p: { id: 'test-no-timestamp' }
      });

      await fileRegistry.registerFile('parameter-test-no-timestamp', paramFile);
      const graph = createTestGraph({ edges: [edge] });
      const setGraph = vi.fn();

      await dataOperationsService.getParameterFromFile({
        paramId: 'test-no-timestamp',
        edgeId: 'edge-1',
        graph,
        setGraph
      });

      const updatedGraph = setGraph.mock.calls[0][0];
      const updatedEdge = updatedGraph.edges.find((e: any) => e.uuid === 'edge-1');

      // Should get entry with timestamp (0.42), not the one without
      expect(updatedEdge.p.mean).toBe(0.42);
    });

    it('after put, new entry becomes latest', async () => {
      const edge = createTestEdge({
        uuid: 'edge-1',
        p: { id: 'test-new-latest', mean: 0.50, stdev: 0.05, distribution: 'beta' }  // Must have id for put to work
      });

      const paramFile = createTestParameterFile({
        id: 'test-new-latest',
        type: 'probability',
        values: [
          { mean: 0.42, window_from: '2025-01-01T00:00:00Z' },
          { mean: 0.45, window_from: '2025-02-01T00:00:00Z' }
        ]
      });

      await fileRegistry.registerFile('parameter-test-new-latest', paramFile);
      const graph = createTestGraph({ edges: [edge] });
      const setGraph = vi.fn();

      // Put new value
      await dataOperationsService.putParameterToFile({
        paramId: 'test-new-latest',
        edgeId: 'edge-1',
        graph,
        setGraph
      });

      // Get back - should retrieve the newly added value
      await dataOperationsService.getParameterFromFile({
        paramId: 'test-new-latest',
        edgeId: 'edge-1',
        graph: createTestGraph({ edges: [edge] }),
        setGraph
      });

      const updatedGraph = setGraph.mock.calls[setGraph.mock.calls.length - 1][0];
      const updatedEdge = updatedGraph.edges.find((e: any) => e.uuid === 'edge-1');

      expect(updatedEdge.p.mean).toBe(0.50);  // Our new value
    });
  });

  // ============================================================
  // ERROR HANDLING
  // ============================================================
  
  describe('Error Conditions', () => {
    it('missing parameter file does not crash', async () => {
      const graph = createTestGraph();
      const setGraph = vi.fn();

      // Should not throw - dataOperationsService uses toast.error instead
      await dataOperationsService.getParameterFromFile({
        paramId: 'nonexistent',
        edgeId: 'edge-1',
        graph,
        setGraph
      });
      
      // setGraph should not be called on error
      expect(setGraph).not.toHaveBeenCalled();
    });
    
    it('missing node file does not crash', async () => {
      const graph = createTestGraph();
      const setGraph = vi.fn();

      // Should not throw - dataOperationsService uses toast.error instead
      await dataOperationsService.getNodeFromFile({
        nodeId: 'nonexistent',
        targetNodeUuid: 'node-1',
        graph,
        setGraph
      });
      
      expect(setGraph).not.toHaveBeenCalled();
    });
    
    it('missing case file does not crash', async () => {
      const graph = createTestGraph();
      const setGraph = vi.fn();

      // Should not throw - dataOperationsService uses toast.error instead
      await dataOperationsService.getCaseFromFile({
        caseId: 'nonexistent',
        nodeId: 'node-1',
        graph,
        setGraph
      });
      
      expect(setGraph).not.toHaveBeenCalled();
    });
    
    it('edge not found in graph does not crash', async () => {
      await fileRegistry.registerFile('parameter-test', createTestParameterFile({ id: 'test' }));
      const graph = createTestGraph({ edges: [] });  // No edges
      const setGraph = vi.fn();

      // Should not throw - dataOperationsService uses toast.error instead
      await dataOperationsService.getParameterFromFile({
        paramId: 'test',
        edgeId: 'nonexistent-edge',
        graph,
        setGraph
      });
      
      expect(setGraph).not.toHaveBeenCalled();
    });
    
    it('node not found in graph does not crash', async () => {
      await fileRegistry.registerFile('node-test', createTestNodeFile({ id: 'test' }));
      const graph = createTestGraph({ nodes: [] });  // No nodes
      const setGraph = vi.fn();

      // Should not throw - dataOperationsService uses toast.error instead
      await dataOperationsService.getNodeFromFile({
        nodeId: 'test',
        targetNodeUuid: 'nonexistent-node',
        graph,
        setGraph
      });
      
      expect(setGraph).not.toHaveBeenCalled();
    });
  });
});

