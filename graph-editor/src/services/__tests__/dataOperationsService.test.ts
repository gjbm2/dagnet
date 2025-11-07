/**
 * DataOperationsService Integration Tests
 * 
 * Tests the full end-to-end flow:
 * UI → DataOperationsService → UpdateManager → Graph/File updates
 * 
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { dataOperationsService } from '../dataOperationsService';
import type { Graph } from '../../types';

// Mock toast to avoid React dependencies in tests
vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fileRegistry with in-memory storage
vi.mock('../../contexts/TabContext', () => {
  const mockFiles = new Map<string, any>();
  
  return {
    fileRegistry: {
      registerFile: vi.fn((id: string, data: any) => {
        mockFiles.set(id, { data: structuredClone(data), isDirty: false, isInitializing: false });
        return Promise.resolve();
      }),
      getFile: vi.fn((id: string) => {
        return mockFiles.get(id);
      }),
      updateFile: vi.fn((id: string, data: any) => {
        if (mockFiles.has(id)) {
          mockFiles.set(id, { data: structuredClone(data), isDirty: true, isInitializing: false });
        }
        return Promise.resolve();
      }),
      deleteFile: vi.fn((id: string) => {
        mockFiles.delete(id);
        return Promise.resolve();
      }),
      _mockFiles: mockFiles // For testing/clearing
    }
  };
});

// Import after mocking
const { fileRegistry } = await import('../../contexts/TabContext');

describe('DataOperationsService', () => {
  let mockGraph: Graph;
  let mockSetGraph: (graph: Graph | null) => void;

  beforeEach(() => {
    // Reset mocks
    mockSetGraph = vi.fn() as any;
    vi.clearAllMocks();
    (fileRegistry as any)._mockFiles.clear();
    
    // Create a minimal test graph
    mockGraph = {
      schema_version: '1.0.0',
      id: 'test-graph',
      name: 'Test Graph',
      description: 'Test graph for data operations',
      nodes: [
        {
          uuid: 'node-1-uuid',
          id: 'homepage',
          label: 'Homepage',
          layout: { x: 0, y: 0 },
        },
        {
          uuid: 'node-2-uuid',
          id: 'product-page',
          label: 'Product Page',
          layout: { x: 100, y: 100 },
          case: {
            id: 'product-variants',
          },
        },
      ],
      edges: [
        {
          uuid: 'edge-1-uuid',
          id: 'homepage-to-product',
          from: 'homepage',
          to: 'product-page',
          p: {
            id: 'homepage-to-product-param',  // Connection ID
            mean: 0.5,
            stdev: 0.1,
            distribution: 'beta',
          },
        },
      ],
      policies: {
        default_outcome: 'product-page',
      },
      metadata: {
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      },
    } as any as Graph;

    // Mock fileRegistry
    vi.spyOn(fileRegistry, 'getFile').mockImplementation((fileId: string): any => {
      if (fileId === 'parameter-homepage-to-product-param') {
        return {
          fileId,
          data: {
            id: 'homepage-to-product-param',
            name: 'Homepage to Product Conversion',
            description: 'Conversion rate from homepage to product page',
            type: 'probability',
            values: [
              {
                mean: 0.6,
                stdev: 0.08,
                distribution: 'beta',
                valid_from: '2025-01-01',
                evidence: {
                  n: 1000,
                  k: 600,
                  retrieved_at: '2025-01-01T00:00:00Z',
                  source: 'test',
                },
              },
            ],
          },
          originalData: {},
          isDirty: false,
          source: { repository: 'test', branch: 'main', path: 'parameters/homepage-to-product-param.yaml' },
          viewTabs: [],
        };
      }
      
      if (fileId === 'case-product-variants') {
        return {
          fileId,
          data: {
            parameter_id: 'product-variants',
            case: {
              id: 'product-variants',
              status: 'active',
              variants: [
                { name: 'control', weight: 0.5 },
                { name: 'variant-a', weight: 0.3 },
                { name: 'variant-b', weight: 0.2 },
              ],
            },
            metadata: {
              description: 'Different product page variants',
              status: 'active',
            }
          },
          originalData: {},
          isDirty: false,
          source: { repository: 'test', branch: 'main', path: 'cases/product-variants.yaml' },
          viewTabs: [],
        };
      }
      
      return null;
    });

    vi.spyOn(fileRegistry, 'updateFile').mockImplementation(async () => {});
  });

  // ============================================================
  // TEST SUITE 1: Parameter Operations
  // ============================================================

  describe('Parameter Operations', () => {
    it('should get parameter from file and update graph edge', async () => {
      await dataOperationsService.getParameterFromFile({
        paramId: 'homepage-to-product-param',
        edgeId: 'edge-1-uuid',
        graph: mockGraph,
        setGraph: mockSetGraph,
      });

      // Verify setGraph was called
      expect(mockSetGraph).toHaveBeenCalledTimes(1);
      
      // Verify the updated graph
      const updatedGraph = (mockSetGraph as any).mock.calls[0][0];
      expect(updatedGraph).toBeDefined();
      expect(updatedGraph.edges[0].p.mean).toBe(0.6); // Updated from file
      expect(updatedGraph.metadata.updated_at).toBeDefined();
    });

    it('should put parameter to file from graph edge', async () => {
      await dataOperationsService.putParameterToFile({
        paramId: 'homepage-to-product-param',
        edgeId: 'edge-1-uuid',
        graph: mockGraph,
        setGraph: mockSetGraph,
      });

      // Verify file was updated
      expect(fileRegistry.updateFile).toHaveBeenCalledTimes(1);
      const [fileId, updatedData] = (fileRegistry.updateFile as any).mock.calls[0];
      expect(fileId).toBe('parameter-homepage-to-product-param');
      expect(updatedData).toBeDefined();
      // Note: The exact structure depends on UpdateManager's APPEND logic
    });

    it('should handle missing parameter file gracefully', async () => {
      await dataOperationsService.getParameterFromFile({
        paramId: 'nonexistent-param',
        edgeId: 'edge-1-uuid',
        graph: mockGraph,
        setGraph: mockSetGraph,
      });

      // Should not call setGraph if file doesn't exist
      expect(mockSetGraph).not.toHaveBeenCalled();
    });

    it('should handle missing edge gracefully', async () => {
      await dataOperationsService.getParameterFromFile({
        paramId: 'homepage-to-product-param',
        edgeId: 'nonexistent-edge-uuid',
        graph: mockGraph,
        setGraph: mockSetGraph,
      });

      // Should not call setGraph if edge doesn't exist
      expect(mockSetGraph).not.toHaveBeenCalled();
    });

    it('should handle null graph gracefully', async () => {
      await dataOperationsService.getParameterFromFile({
        paramId: 'homepage-to-product-param',
        edgeId: 'edge-1-uuid',
        graph: null,
        setGraph: mockSetGraph,
      });

      // Should not call setGraph if graph is null
      expect(mockSetGraph).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // TEST SUITE 2: Case Operations
  // ============================================================

  describe('Case Operations', () => {
    it('should get case from file and update graph node', async () => {
      await dataOperationsService.getCaseFromFile({
        caseId: 'product-variants',
        nodeId: 'node-2-uuid',
        graph: mockGraph,
        setGraph: mockSetGraph,
      });

      // Verify setGraph was called
      expect(mockSetGraph).toHaveBeenCalledTimes(1);
      
      // Verify the updated graph
      const updatedGraph = (mockSetGraph as any).mock.calls[0][0];
      expect(updatedGraph).toBeDefined();
      expect(updatedGraph.nodes[1].case).toBeDefined();
    });

    it('should put case to file from graph node', async () => {
      await dataOperationsService.putCaseToFile({
        caseId: 'product-variants',
        nodeId: 'node-2-uuid',
        graph: mockGraph,
        setGraph: mockSetGraph,
      });

      // Verify file was updated
      expect(fileRegistry.updateFile).toHaveBeenCalledTimes(1);
      const [fileId] = (fileRegistry.updateFile as any).mock.calls[0];
      expect(fileId).toBe('case-product-variants');
    });

    it('should handle missing case file gracefully', async () => {
      await dataOperationsService.getCaseFromFile({
        caseId: 'nonexistent-case',
        nodeId: 'node-2-uuid',
        graph: mockGraph,
        setGraph: mockSetGraph,
      });

      // Should not call setGraph if file doesn't exist
      expect(mockSetGraph).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // TEST SUITE 3: Node Operations
  // ============================================================

  describe('Node Operations', () => {
    beforeEach(() => {
      // Mock a node file
      vi.spyOn(fileRegistry, 'getFile').mockImplementation((fileId: string): any => {
        if (fileId === 'node-homepage') {
          return {
            fileId,
            data: {
              id: 'homepage',
              name: 'Homepage Node',
              description: 'Landing page node',
              tags: ['entry-point'],
            },
            originalData: {},
            isDirty: false,
            source: { repository: 'test', branch: 'main', path: 'nodes/homepage.yaml' },
            viewTabs: [],
          };
        }
        return null;
      });
    });

    it('should get node from file and update graph node', async () => {
      await dataOperationsService.getNodeFromFile({
        nodeId: 'homepage',
        graph: mockGraph,
        setGraph: mockSetGraph,
      });

      // Verify setGraph was called
      expect(mockSetGraph).toHaveBeenCalledTimes(1);
      
      // Verify the updated graph
      const updatedGraph = (mockSetGraph as any).mock.calls[0][0];
      expect(updatedGraph).toBeDefined();
      expect(updatedGraph.nodes[0]).toBeDefined();
    });

    it('should put node to file from graph node', async () => {
      await dataOperationsService.putNodeToFile({
        nodeId: 'homepage',
        graph: mockGraph,
        setGraph: mockSetGraph,
      });

      // Verify file was updated
      expect(fileRegistry.updateFile).toHaveBeenCalledTimes(1);
      const [fileId] = (fileRegistry.updateFile as any).mock.calls[0];
      expect(fileId).toBe('node-homepage');
    });
  });

  // ============================================================
  // TEST SUITE 4: Error Handling
  // ============================================================

  describe('Error Handling', () => {
    it('should handle UpdateManager errors gracefully', async () => {
      // Create a graph with invalid data to trigger UpdateManager error
      const invalidGraph: Graph = {
        ...mockGraph,
        edges: [], // No edges
      };

      await dataOperationsService.getParameterFromFile({
        paramId: 'homepage-to-product-param',
        edgeId: 'nonexistent-edge',
        graph: invalidGraph,
        setGraph: mockSetGraph,
      });

      // Should not crash, should handle error internally
      expect(mockSetGraph).not.toHaveBeenCalled();
    });

    it('should handle missing graph gracefully in all operations', async () => {
      // Test all 6 operations with null graph
      await dataOperationsService.getParameterFromFile({
        paramId: 'test',
        edgeId: 'test',
        graph: null,
        setGraph: mockSetGraph,
      });

      await dataOperationsService.putParameterToFile({
        paramId: 'test',
        edgeId: 'test',
        graph: null,
        setGraph: mockSetGraph,
      });

      await dataOperationsService.getCaseFromFile({
        caseId: 'test',
        nodeId: 'test',
        graph: null,
        setGraph: mockSetGraph,
      });

      await dataOperationsService.putCaseToFile({
        caseId: 'test',
        nodeId: 'test',
        graph: null,
        setGraph: mockSetGraph,
      });

      await dataOperationsService.getNodeFromFile({
        nodeId: 'test',
        graph: null,
        setGraph: mockSetGraph,
      });

      await dataOperationsService.putNodeToFile({
        nodeId: 'test',
        graph: null,
        setGraph: mockSetGraph,
      });

      // None should have called setGraph
      expect(mockSetGraph).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // TEST SUITE 5: Graph State Preservation
  // ============================================================

  describe('Graph State Preservation', () => {
    it('should preserve unrelated graph data when updating edge', async () => {
      await dataOperationsService.getParameterFromFile({
        paramId: 'homepage-to-product-param',
        edgeId: 'edge-1-uuid',
        graph: mockGraph,
        setGraph: mockSetGraph,
      });

      const updatedGraph = (mockSetGraph as any).mock.calls[0][0];
      
      // Verify structure is preserved
      expect(updatedGraph.nodes).toHaveLength(2);
      expect(updatedGraph.edges).toHaveLength(1);
      expect(updatedGraph.policies).toEqual(mockGraph.policies);
      expect(updatedGraph.id).toBe('test-graph');
      expect(updatedGraph.name).toBe('Test Graph');
    });

    it('should update metadata timestamp on changes', async () => {
      const oldTimestamp = mockGraph.metadata.updated_at;

      await dataOperationsService.getParameterFromFile({
        paramId: 'homepage-to-product-param',
        edgeId: 'edge-1-uuid',
        graph: mockGraph,
        setGraph: mockSetGraph,
      });

      const updatedGraph = (mockSetGraph as any).mock.calls[0][0];
      expect(updatedGraph.metadata.updated_at).not.toBe(oldTimestamp);
    });
  });

  // ============================================================
  // TEST SUITE 6: Integration with FileRegistry
  // ============================================================

  describe('FileRegistry Integration', () => {
    it('should mark file as dirty when putting data', async () => {
      await dataOperationsService.putParameterToFile({
        paramId: 'homepage-to-product-param',
        edgeId: 'edge-1-uuid',
        graph: mockGraph,
        setGraph: mockSetGraph,
      });

      // Verify updateFile was called (which marks as dirty)
      expect(fileRegistry.updateFile).toHaveBeenCalledTimes(1);
    });

    it('should read file data correctly via getFile', async () => {
      const spy = vi.spyOn(fileRegistry, 'getFile');

      await dataOperationsService.getParameterFromFile({
        paramId: 'homepage-to-product-param',
        edgeId: 'edge-1-uuid',
        graph: mockGraph,
        setGraph: mockSetGraph,
      });

      // Verify getFile was called with correct fileId
      expect(spy).toHaveBeenCalledWith('parameter-homepage-to-product-param');
    });
  });
});

