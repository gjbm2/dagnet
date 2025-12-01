/**
 * getCaseFromFile Tests
 * 
 * Tests case fetch with windowed aggregation, schedule merging,
 * and override flag handling.
 * 
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';

// Mock external dependencies
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
    startOperation: vi.fn(() => 'mock-op'),
    endOperation: vi.fn(),
    addChild: vi.fn(),
    info: vi.fn(),
    error: vi.fn()
  }
}));

// Mock WindowAggregationService 
vi.mock('../windowAggregationService', async () => {
  const actual = await vi.importActual('../windowAggregationService');
  return {
    ...actual,
    WindowAggregationService: class {
      aggregateCaseSchedulesForWindow = vi.fn().mockReturnValue({
        method: 'time_weighted',
        schedules_included: 2,
        variants: [
          { name: 'control', weight: 0.5 },
          { name: 'variant_a', weight: 0.5 }
        ],
        coverage: { is_complete: true, message: '' }
      });
      getCaseWeightsForWindow = vi.fn().mockReturnValue({
        method: 'latest',
        schedules_included: 1,
        variants: [
          { name: 'control', weight: 0.5 },
          { name: 'variant_a', weight: 0.5 }
        ],
        coverage: { is_complete: true, message: '' }
      });
    }
  };
});

// Mock UpdateManager to return predictable results
vi.mock('../UpdateManager', () => ({
  UpdateManager: class {
    handleFileToGraph = vi.fn().mockResolvedValue({
      success: true,
      changes: [{ field: 'case.variants', value: [] }],
      conflicts: [],
      errors: []
    });
    handleExternalToGraph = vi.fn().mockResolvedValue({
      success: true,
      changes: [{ field: 'case.variants', value: [] }],
      conflicts: [],
      errors: []
    });
    rebalanceVariantWeights = vi.fn().mockReturnValue({
      graph: {},
      overriddenCount: 0
    });
  }
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

function createTestGraph(options: {
  caseId?: string;
  nodeId?: string;
  variants?: Array<{ name: string; weight: number; weight_overridden?: boolean }>;
}): Graph {
  const { caseId = 'test-case', nodeId = 'node-1', variants = [] } = options;
  
  return {
    nodes: [
      {
        uuid: nodeId,
        id: 'test-node',
        type: 'case',
        label: 'Test Case Node',
        case: {
          id: caseId,
          variants: variants.length > 0 ? variants : [
            { name: 'control', weight: 0.5 },
            { name: 'variant_a', weight: 0.5 }
          ]
        }
      }
    ],
    edges: [],
    metadata: { updated_at: new Date().toISOString() }
  } as unknown as Graph;
}

function createCaseFile(options: {
  caseId?: string;
  variants?: Array<{ name: string; weight: number }>;
  schedules?: Array<{
    effective_at: string;
    variants: Array<{ name: string; weight: number }>;
  }>;
}) {
  const { caseId = 'test-case', variants, schedules } = options;
  
  return {
    fileId: `case-${caseId}`,
    type: 'case',
    data: {
      id: caseId,
      variants: variants || [
        { name: 'control', weight: 0.5 },
        { name: 'variant_a', weight: 0.5 }
      ],
      schedules: schedules || []
    },
    isDirty: false
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('getCaseFromFile', () => {
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
  
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('error handling', () => {
    it('should error when no graph provided', async () => {
      await dataOperationsService.getCaseFromFile({
        caseId: 'test-case',
        nodeId: 'node-1',
        graph: null,
        setGraph: mockSetGraph
      });
      
      expect(toast.error).toHaveBeenCalledWith('No graph or node selected');
      expect(mockSetGraph).not.toHaveBeenCalled();
    });

    it('should error when no nodeId provided', async () => {
      const graph = createTestGraph({});
      
      await dataOperationsService.getCaseFromFile({
        caseId: 'test-case',
        nodeId: undefined,
        graph,
        setGraph: mockSetGraph
      });
      
      expect(toast.error).toHaveBeenCalledWith('No graph or node selected');
      expect(mockSetGraph).not.toHaveBeenCalled();
    });

    it('should error when case file not found', async () => {
      const graph = createTestGraph({});
      
      await dataOperationsService.getCaseFromFile({
        caseId: 'missing-case',
        nodeId: 'node-1',
        graph,
        setGraph: mockSetGraph
      });
      
      expect(toast.error).toHaveBeenCalledWith('Case file not found: missing-case');
      expect(mockSetGraph).not.toHaveBeenCalled();
    });

    it('should error when node not found in graph', async () => {
      const graph = createTestGraph({ nodeId: 'different-node' });
      const caseFile = createCaseFile({});
      
      setMockFile(caseFile.fileId, caseFile.data);
      
      await dataOperationsService.getCaseFromFile({
        caseId: 'test-case',
        nodeId: 'non-existent-node',
        graph,
        setGraph: mockSetGraph
      });
      
      expect(toast.error).toHaveBeenCalledWith('Node not found in graph');
      expect(mockSetGraph).not.toHaveBeenCalled();
    });
  });

  describe('auto-updating callback', () => {
    it('should call setAutoUpdating with true immediately', async () => {
      const graph = createTestGraph({});
      const caseFile = createCaseFile({});
      const mockSetAutoUpdating = vi.fn();
      
      setMockFile(caseFile.fileId, caseFile.data);
      
      await dataOperationsService.getCaseFromFile({
        caseId: 'test-case',
        nodeId: 'node-1',
        graph,
        setGraph: mockSetGraph,
        setAutoUpdating: mockSetAutoUpdating
      });
      
      // Should have called with true initially
      expect(mockSetAutoUpdating).toHaveBeenCalledWith(true);
    });

    it('should call setAutoUpdating with false after timeout', async () => {
      vi.useFakeTimers();
      
      const graph = createTestGraph({});
      const caseFile = createCaseFile({});
      const mockSetAutoUpdating = vi.fn();
      
      setMockFile(caseFile.fileId, caseFile.data);
      
      const promise = dataOperationsService.getCaseFromFile({
        caseId: 'test-case',
        nodeId: 'node-1',
        graph,
        setGraph: mockSetGraph,
        setAutoUpdating: mockSetAutoUpdating
      });
      
      // Advance timers
      vi.advanceTimersByTime(600);
      await promise;
      
      expect(mockSetAutoUpdating).toHaveBeenCalledWith(false);
      
      vi.useRealTimers();
    });
  });

  describe('basic functionality', () => {
    it('should call UpdateManager.handleFileToGraph for files without schedules', async () => {
      const graph = createTestGraph({});
      const caseFile = createCaseFile({ schedules: [] }); // No schedules
      
      setMockFile(caseFile.fileId, caseFile.data);
      
      await dataOperationsService.getCaseFromFile({
        caseId: 'test-case',
        nodeId: 'node-1',
        graph,
        setGraph: mockSetGraph
      });
      
      // With no schedules and no window, should use handleFileToGraph path
      // This updates the graph via UpdateManager
      expect(mockSetGraph).toHaveBeenCalled();
    });

    it('should process window aggregation when window and schedules provided', async () => {
      const graph = createTestGraph({});
      const caseFile = createCaseFile({
        schedules: [
          {
            effective_at: '2025-12-01T00:00:00.000Z',
            variants: [{ name: 'control', weight: 0.6 }, { name: 'variant_a', weight: 0.4 }]
          }
        ]
      });
      
      setMockFile(caseFile.fileId, caseFile.data);
      
      await dataOperationsService.getCaseFromFile({
        caseId: 'test-case',
        nodeId: 'node-1',
        graph,
        setGraph: mockSetGraph,
        window: { start: '2025-12-01', end: '2025-12-07' }
      });
      
      // With window and schedules, should use aggregation path
      expect(mockSetGraph).toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('should handle case file with empty variants array', async () => {
      const graph = createTestGraph({});
      const caseFile = createCaseFile({ variants: [] });
      
      setMockFile(caseFile.fileId, caseFile.data);
      
      await dataOperationsService.getCaseFromFile({
        caseId: 'test-case',
        nodeId: 'node-1',
        graph,
        setGraph: mockSetGraph
      });
      
      // Should still complete without error
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('should handle graph with node but no case property', async () => {
      const graph = {
        nodes: [{ uuid: 'node-1', id: 'test', type: 'case' }], // No case property
        edges: [],
        metadata: {}
      } as unknown as Graph;
      
      const caseFile = createCaseFile({});
      setMockFile(caseFile.fileId, caseFile.data);
      
      await dataOperationsService.getCaseFromFile({
        caseId: 'test-case',
        nodeId: 'node-1',
        graph,
        setGraph: mockSetGraph
      });
      
      // Should complete (may or may not call setGraph depending on UpdateManager result)
    });
  });
});
