/**
 * Batch Operations Tests
 * 
 * Tests for BatchOperationsModal edge cases including:
 * - Partial failure handling
 * - Progress reporting
 * - Mixed success/failure results
 * - Operation type routing
 * 
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';

// Mock dependencies
vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn().mockReturnValue('toast-id'),
    dismiss: vi.fn()
  })
}));

vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    startOperation: vi.fn(() => 'mock-op'),
    endOperation: vi.fn(),
    addChild: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn()
  }
}));

// Mock useFetchData hook
const mockFetchItem = vi.fn();
const mockCreateFetchItem = vi.fn((type, objectId, targetId, options) => ({
  id: `${type}-${objectId}-${targetId}`,
  type,
  objectId,
  targetId,
  ...options
}));

vi.mock('../../hooks/useFetchData', () => ({
  useFetchData: () => ({
    fetchItem: mockFetchItem,
    fetchItems: vi.fn(),
    getItemsNeedingFetch: vi.fn(),
    itemNeedsFetch: vi.fn(),
    effectiveDSL: 'window(1-Dec-25:7-Dec-25)'
  }),
  createFetchItem: mockCreateFetchItem
}));

// Import after mocks
import { dataOperationsService } from '../dataOperationsService';
import { fileRegistry } from '../../contexts/TabContext';
import type { Graph } from '../../types';
import toast from 'react-hot-toast';

// Mock file storage for tests
const mockFiles = new Map<string, any>();

function setMockFile(fileId: string, data: any) {
  mockFiles.set(fileId, { fileId, data, type: fileId.split('-')[0], isDirty: false });
}

function clearMockFiles() {
  mockFiles.clear();
}

// ============================================================================
// TEST HELPERS
// ============================================================================

function createTestGraph(paramCount: number = 3): Graph {
  const edges = [];
  for (let i = 1; i <= paramCount; i++) {
    edges.push({
      uuid: `edge-${i}`,
      id: `e${i}`,
      from: 'node-a',
      to: `node-b${i}`,
      p: {
        id: `param-${i}`,
        mean: 0.5,
        stdev: 0.1,
        connection: 'amplitude'
      }
    });
  }
  
  return {
    nodes: [
      { uuid: 'node-a', id: 'a', type: 'event', label: 'Start' },
      { uuid: 'node-b1', id: 'b1', type: 'event', label: 'End 1' },
      { uuid: 'node-b2', id: 'b2', type: 'event', label: 'End 2' },
      { uuid: 'node-b3', id: 'b3', type: 'event', label: 'End 3' }
    ],
    edges,
    currentQueryDSL: 'window(1-Dec-25:7-Dec-25)',
    metadata: { updated_at: new Date().toISOString() }
  } as unknown as Graph;
}

function createParamFile(paramId: string, hasConnection: boolean = true) {
  return {
    fileId: `parameter-${paramId}`,
    type: 'parameter',
    data: {
      id: paramId,
      type: 'probability',
      connection: hasConnection ? 'amplitude' : undefined,
      values: []
    },
    isDirty: false
  };
}

// ============================================================================
// TESTS: batchGetFromSource
// ============================================================================

describe('batchGetFromSource', () => {
  let mockSetGraph: ReturnType<typeof vi.fn>;
  
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetGraph = vi.fn((g) => g); // Return the graph for chaining
    clearMockFiles();
    
    // Mock fileRegistry.getFile to use our mock storage
    vi.spyOn(fileRegistry, 'getFile').mockImplementation((fileId: string) => {
      return mockFiles.get(fileId) || null;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('partial failure handling', () => {
    it('should continue processing on individual item failure', async () => {
      const graph = createTestGraph(3);
      
      // Set up files - only 2 out of 3 have files
      setMockFile('parameter-param-1', createParamFile('param-1').data);
      setMockFile('parameter-param-2', createParamFile('param-2').data);
      // param-3 has no file
      
      // Mock getFromSource to fail on param-2
      const originalGetFromSource = dataOperationsService.getFromSource.bind(dataOperationsService);
      let callCount = 0;
      vi.spyOn(dataOperationsService, 'getFromSource').mockImplementation(async (options) => {
        callCount++;
        if (options.objectId === 'param-2') {
          throw new Error('API rate limit exceeded');
        }
        // For other params, don't actually call to avoid complex mocking
        return;
      });
      
      const result = await dataOperationsService.batchGetFromSource({
        items: [
          { type: 'parameter', objectId: 'param-1', targetId: 'edge-1', paramSlot: 'p' },
          { type: 'parameter', objectId: 'param-2', targetId: 'edge-2', paramSlot: 'p' },
          { type: 'parameter', objectId: 'param-3', targetId: 'edge-3', paramSlot: 'p' }
        ],
        graph,
        setGraph: mockSetGraph,
        currentDSL: 'window(1-Dec-25:7-Dec-25)'
      });
      
      // Should have attempted all 3 items
      expect(callCount).toBe(3);
      
      // Should report mixed results
      expect(result.errors).toBeGreaterThanOrEqual(1);
      expect(result.items.some(i => !i.success)).toBe(true);
    });

    it('should report correct success/error counts', async () => {
      const graph = createTestGraph(5);
      
      // Set up files for all 5
      for (let i = 1; i <= 5; i++) {
        setMockFile(`parameter-param-${i}`, createParamFile(`param-${i}`).data);
      }
      
      // Mock: 3 succeed, 2 fail
      let callIndex = 0;
      vi.spyOn(dataOperationsService, 'getFromSource').mockImplementation(async (options) => {
        callIndex++;
        if (callIndex === 2 || callIndex === 4) {
          throw new Error('Network error');
        }
        return;
      });
      
      const result = await dataOperationsService.batchGetFromSource({
        items: [1, 2, 3, 4, 5].map(i => ({
          type: 'parameter' as const,
          objectId: `param-${i}`,
          targetId: `edge-${i}`,
          paramSlot: 'p' as const
        })),
        graph,
        setGraph: mockSetGraph,
        currentDSL: 'window(1-Dec-25:7-Dec-25)'
      });
      
      expect(result.success).toBe(3);
      expect(result.errors).toBe(2);
      expect(result.items).toHaveLength(5);
    });
  });

  describe('progress reporting', () => {
    it('should call onProgress for each item', async () => {
      const graph = createTestGraph(3);
      const progressCalls: Array<{ current: number; total: number; name?: string }> = [];
      
      // Set up files
      for (let i = 1; i <= 3; i++) {
        setMockFile(`parameter-param-${i}`, createParamFile(`param-${i}`).data);
      }
      
      vi.spyOn(dataOperationsService, 'getFromSource').mockResolvedValue(undefined);
      
      await dataOperationsService.batchGetFromSource({
        items: [1, 2, 3].map(i => ({
          type: 'parameter' as const,
          objectId: `param-${i}`,
          targetId: `edge-${i}`,
          paramSlot: 'p' as const,
          name: `Param ${i}`
        })),
        graph,
        setGraph: mockSetGraph,
        currentDSL: 'window(1-Dec-25:7-Dec-25)',
        onProgress: (current, total, name) => {
          progressCalls.push({ current, total, name });
        }
      });
      
      expect(progressCalls).toHaveLength(3);
      expect(progressCalls[0]).toEqual({ current: 1, total: 3, name: 'Param 1' });
      expect(progressCalls[1]).toEqual({ current: 2, total: 3, name: 'Param 2' });
      expect(progressCalls[2]).toEqual({ current: 3, total: 3, name: 'Param 3' });
    });

    it('should report progress correctly for large batches', async () => {
      const graph = createTestGraph(10);
      const progressCalls: number[] = [];
      
      // Set up files
      for (let i = 1; i <= 10; i++) {
        setMockFile(`parameter-param-${i}`, createParamFile(`param-${i}`).data);
      }
      
      vi.spyOn(dataOperationsService, 'getFromSource').mockResolvedValue(undefined);
      
      await dataOperationsService.batchGetFromSource({
        items: Array.from({ length: 10 }, (_, i) => ({
          type: 'parameter' as const,
          objectId: `param-${i + 1}`,
          targetId: `edge-${i + 1}`,
          paramSlot: 'p' as const
        })),
        graph,
        setGraph: mockSetGraph,
        currentDSL: 'window(1-Dec-25:7-Dec-25)',
        onProgress: (current) => {
          progressCalls.push(current);
        }
      });
      
      expect(progressCalls).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });
  });

  describe('mixed item types', () => {
    it('should handle mixed parameter and case items', async () => {
      const graph = {
        ...createTestGraph(2),
        nodes: [
          ...createTestGraph(2).nodes,
          {
            uuid: 'case-node-1',
            id: 'cn1',
            type: 'case',
            case: { id: 'case-1' }
          }
        ]
      } as unknown as Graph;
      
      setMockFile('parameter-param-1', createParamFile('param-1').data);
      setMockFile('parameter-param-2', createParamFile('param-2').data);
      setMockFile('case-case-1', { id: 'case-1', variants: [] });
      
      vi.spyOn(dataOperationsService, 'getFromSource').mockResolvedValue(undefined);
      
      const result = await dataOperationsService.batchGetFromSource({
        items: [
          { type: 'parameter', objectId: 'param-1', targetId: 'edge-1', paramSlot: 'p' },
          { type: 'case', objectId: 'case-1', targetId: 'case-node-1' },
          { type: 'parameter', objectId: 'param-2', targetId: 'edge-2', paramSlot: 'p' }
        ],
        graph,
        setGraph: mockSetGraph,
        currentDSL: 'window(1-Dec-25:7-Dec-25)'
      });
      
      expect(result.items).toHaveLength(3);
    });
  });

  describe('graph state tracking', () => {
    it('should use updated graph state for subsequent items', async () => {
      const graph = createTestGraph(3);
      const graphStates: Graph[] = [];
      
      setMockFile('parameter-param-1', createParamFile('param-1').data);
      setMockFile('parameter-param-2', createParamFile('param-2').data);
      setMockFile('parameter-param-3', createParamFile('param-3').data);
      
      // Track which graph state is passed to each call
      vi.spyOn(dataOperationsService, 'getFromSource').mockImplementation(async (options) => {
        graphStates.push(options.graph as Graph);
        // Simulate graph update
        if (options.setGraph) {
          const updated = { ...options.graph, metadata: { updated_at: Date.now().toString() } };
          options.setGraph(updated as Graph);
        }
      });
      
      await dataOperationsService.batchGetFromSource({
        items: [1, 2, 3].map(i => ({
          type: 'parameter' as const,
          objectId: `param-${i}`,
          targetId: `edge-${i}`,
          paramSlot: 'p' as const
        })),
        graph,
        setGraph: mockSetGraph,
        currentDSL: 'window(1-Dec-25:7-Dec-25)'
      });
      
      // Each subsequent call should receive the updated graph from previous
      expect(graphStates).toHaveLength(3);
      // First call gets original graph
      expect(graphStates[0]).toBe(graph);
      // Subsequent calls should get updated graphs (not the original)
      expect(graphStates[1]).not.toBe(graph);
      expect(graphStates[2]).not.toBe(graph);
    });
  });

  describe('bust cache option', () => {
    it('should pass bustCache flag to individual operations', async () => {
      const graph = createTestGraph(1);
      setMockFile('parameter-param-1', createParamFile('param-1').data);
      
      const getFromSourceSpy = vi.spyOn(dataOperationsService, 'getFromSource').mockResolvedValue(undefined);
      
      await dataOperationsService.batchGetFromSource({
        items: [{ type: 'parameter', objectId: 'param-1', targetId: 'edge-1', paramSlot: 'p' }],
        graph,
        setGraph: mockSetGraph,
        currentDSL: 'window(1-Dec-25:7-Dec-25)',
        bustCache: true
      });
      
      expect(getFromSourceSpy).toHaveBeenCalledWith(
        expect.objectContaining({ bustCache: true })
      );
    });
  });

  describe('error message collection', () => {
    it('should collect error messages for failed items', async () => {
      const graph = createTestGraph(3);
      
      for (let i = 1; i <= 3; i++) {
        setMockFile(`parameter-param-${i}`, createParamFile(`param-${i}`).data);
      }
      
      vi.spyOn(dataOperationsService, 'getFromSource').mockImplementation(async (options) => {
        if (options.objectId === 'param-2') {
          throw new Error('Connection timeout after 30s');
        }
        return;
      });
      
      const result = await dataOperationsService.batchGetFromSource({
        items: [1, 2, 3].map(i => ({
          type: 'parameter' as const,
          objectId: `param-${i}`,
          targetId: `edge-${i}`,
          paramSlot: 'p' as const,
          name: `Param ${i}`
        })),
        graph,
        setGraph: mockSetGraph,
        currentDSL: 'window(1-Dec-25:7-Dec-25)'
      });
      
      const failedItem = result.items.find(i => i.name === 'Param 2');
      expect(failedItem?.success).toBe(false);
      expect(failedItem?.error).toContain('Connection timeout');
    });
  });
});

// ============================================================================
// TESTS: Empty and edge cases
// ============================================================================

describe('batch operations edge cases', () => {
  let mockSetGraph: ReturnType<typeof vi.fn>;
  
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetGraph = vi.fn();
    clearMockFiles();
    
    // Mock fileRegistry.getFile to use our mock storage
    vi.spyOn(fileRegistry, 'getFile').mockImplementation((fileId: string) => {
      return mockFiles.get(fileId) || null;
    });
  });

  it('should handle empty items array', async () => {
    const graph = createTestGraph(0);
    
    const result = await dataOperationsService.batchGetFromSource({
      items: [],
      graph,
      setGraph: mockSetGraph,
      currentDSL: 'window(1-Dec-25:7-Dec-25)'
    });
    
    expect(result.success).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  it('should handle null graph gracefully', async () => {
    const result = await dataOperationsService.batchGetFromSource({
      items: [{ type: 'parameter', objectId: 'param-1', targetId: 'edge-1', paramSlot: 'p' }],
      graph: null,
      setGraph: mockSetGraph,
      currentDSL: 'window(1-Dec-25:7-Dec-25)'
    });
    
    // When graph is null, service returns early with empty results
    // This is the expected behaviour - no items can be processed without a graph
    expect(result.items).toHaveLength(0);
    expect(result.success).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('should handle single item batch', async () => {
    const graph = createTestGraph(1);
    setMockFile('parameter-param-1', createParamFile('param-1').data);
    
    vi.spyOn(dataOperationsService, 'getFromSource').mockResolvedValue(undefined);
    
    const result = await dataOperationsService.batchGetFromSource({
      items: [{ type: 'parameter', objectId: 'param-1', targetId: 'edge-1', paramSlot: 'p' }],
      graph,
      setGraph: mockSetGraph,
      currentDSL: 'window(1-Dec-25:7-Dec-25)'
    });
    
    expect(result.success).toBe(1);
    expect(result.errors).toBe(0);
  });
});

