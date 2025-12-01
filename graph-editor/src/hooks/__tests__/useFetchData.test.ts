/**
 * useFetchData Hook Tests
 * 
 * Tests for the centralized data fetch hook.
 * Verifies mode routing, node fallback, and getter support.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useFetchData, createFetchItem, getDefaultDSL, type FetchItem } from '../useFetchData';

// Mock dependencies
vi.mock('../../services/dataOperationsService', () => ({
  dataOperationsService: {
    getFromSource: vi.fn().mockResolvedValue(undefined),
    getFromSourceDirect: vi.fn().mockResolvedValue(undefined),
    getParameterFromFile: vi.fn().mockResolvedValue(undefined),
    getCaseFromFile: vi.fn().mockResolvedValue(undefined),
    getNodeFromFile: vi.fn().mockResolvedValue(undefined),
  }
}));

vi.mock('../../services/windowAggregationService', () => ({
  calculateIncrementalFetch: vi.fn().mockReturnValue({
    needsFetch: false,
    totalDays: 7,
    daysAvailable: 7,
    daysToFetch: 0,
    missingDates: [],
  }),
}));

vi.mock('../../contexts/TabContext', () => ({
  fileRegistry: {
    getFile: vi.fn().mockReturnValue(null),
  }
}));

vi.mock('react-hot-toast', () => {
  const toast = Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    loading: vi.fn().mockReturnValue('toast-id'),
    dismiss: vi.fn(),
  });
  return { default: toast };
});

// Import after mocks
import { dataOperationsService } from '../../services/dataOperationsService';

describe('useFetchData', () => {
  const mockGraph = {
    nodes: [{ uuid: 'node-1', id: 'node-1' }],
    edges: [{ uuid: 'edge-1', id: 'edge-1', p: { id: 'param-1' } }],
    currentQueryDSL: 'window(1-Dec-25:7-Dec-25)',
  };
  
  const mockSetGraph = vi.fn();
  
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('mode routing', () => {
    it('versioned mode calls getFromSource for parameter', async () => {
      const { result } = renderHook(() => useFetchData({
        graph: mockGraph as any,
        setGraph: mockSetGraph,
        currentDSL: 'window(1-Dec-25:7-Dec-25)',
      }));
      
      const item = createFetchItem('parameter', 'my-param', 'edge-1', { paramSlot: 'p' });
      
      await act(async () => {
        await result.current.fetchItem(item, { mode: 'versioned' });
      });
      
      expect(dataOperationsService.getFromSource).toHaveBeenCalledWith(
        expect.objectContaining({
          objectType: 'parameter',
          objectId: 'my-param',
          targetId: 'edge-1',
          paramSlot: 'p',
          currentDSL: 'window(1-Dec-25:7-Dec-25)',
          targetSlice: 'window(1-Dec-25:7-Dec-25)',
        })
      );
    });

    it('versioned mode calls getFromSource for case', async () => {
      const { result } = renderHook(() => useFetchData({
        graph: mockGraph as any,
        setGraph: mockSetGraph,
        currentDSL: 'window(1-Dec-25:7-Dec-25)',
      }));
      
      const item = createFetchItem('case', 'my-case', 'node-1');
      
      await act(async () => {
        await result.current.fetchItem(item, { mode: 'versioned' });
      });
      
      expect(dataOperationsService.getFromSource).toHaveBeenCalledWith(
        expect.objectContaining({
          objectType: 'case',
          objectId: 'my-case',
          targetId: 'node-1',
        })
      );
    });

    it('direct mode calls getFromSourceDirect for parameter', async () => {
      const { result } = renderHook(() => useFetchData({
        graph: mockGraph as any,
        setGraph: mockSetGraph,
        currentDSL: 'window(1-Dec-25:7-Dec-25)',
      }));
      
      const item = createFetchItem('parameter', 'my-param', 'edge-1');
      
      await act(async () => {
        await result.current.fetchItem(item, { mode: 'direct' });
      });
      
      expect(dataOperationsService.getFromSourceDirect).toHaveBeenCalledWith(
        expect.objectContaining({
          objectType: 'parameter',
          objectId: 'my-param',
          targetId: 'edge-1',
          dailyMode: true,
        })
      );
    });

    it('from-file mode calls getParameterFromFile for parameter', async () => {
      const { result } = renderHook(() => useFetchData({
        graph: mockGraph as any,
        setGraph: mockSetGraph,
        currentDSL: 'window(1-Dec-25:7-Dec-25)',
      }));
      
      const item = createFetchItem('parameter', 'my-param', 'edge-1');
      
      await act(async () => {
        await result.current.fetchItem(item, { mode: 'from-file' });
      });
      
      expect(dataOperationsService.getParameterFromFile).toHaveBeenCalledWith(
        expect.objectContaining({
          paramId: 'my-param',
          edgeId: 'edge-1',
          targetSlice: 'window(1-Dec-25:7-Dec-25)',
        })
      );
    });

    it('from-file mode calls getCaseFromFile for case', async () => {
      const { result } = renderHook(() => useFetchData({
        graph: mockGraph as any,
        setGraph: mockSetGraph,
        currentDSL: 'window(1-Dec-25:7-Dec-25)',
      }));
      
      const item = createFetchItem('case', 'my-case', 'node-1');
      
      await act(async () => {
        await result.current.fetchItem(item, { mode: 'from-file' });
      });
      
      expect(dataOperationsService.getCaseFromFile).toHaveBeenCalledWith(
        expect.objectContaining({
          caseId: 'my-case',
          nodeId: 'node-1',
        })
      );
    });

    it('from-file mode calls getNodeFromFile for node', async () => {
      const { result } = renderHook(() => useFetchData({
        graph: mockGraph as any,
        setGraph: mockSetGraph,
        currentDSL: 'window(1-Dec-25:7-Dec-25)',
      }));
      
      const item = createFetchItem('node', 'my-node', 'node-uuid');
      
      await act(async () => {
        await result.current.fetchItem(item, { mode: 'from-file' });
      });
      
      expect(dataOperationsService.getNodeFromFile).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: 'my-node',
          targetNodeUuid: 'node-uuid',
        })
      );
    });
  });

  describe('node type handling', () => {
    it('node with versioned mode falls back to getNodeFromFile', async () => {
      const { result } = renderHook(() => useFetchData({
        graph: mockGraph as any,
        setGraph: mockSetGraph,
        currentDSL: 'window(1-Dec-25:7-Dec-25)',
      }));
      
      const item = createFetchItem('node', 'my-node', 'node-uuid');
      
      await act(async () => {
        await result.current.fetchItem(item, { mode: 'versioned' });
      });
      
      // Node should fall back to getNodeFromFile, not getFromSource
      expect(dataOperationsService.getNodeFromFile).toHaveBeenCalled();
      expect(dataOperationsService.getFromSource).not.toHaveBeenCalled();
    });

    it('node with direct mode falls back to getNodeFromFile', async () => {
      const { result } = renderHook(() => useFetchData({
        graph: mockGraph as any,
        setGraph: mockSetGraph,
        currentDSL: 'window(1-Dec-25:7-Dec-25)',
      }));
      
      const item = createFetchItem('node', 'my-node', 'node-uuid');
      
      await act(async () => {
        await result.current.fetchItem(item, { mode: 'direct' });
      });
      
      // Node should fall back to getNodeFromFile, not getFromSourceDirect
      expect(dataOperationsService.getNodeFromFile).toHaveBeenCalled();
      expect(dataOperationsService.getFromSourceDirect).not.toHaveBeenCalled();
    });
  });

  describe('getter support for batch operations', () => {
    it('uses graph getter for fresh state each call', async () => {
      let graphVersion = 1;
      const graphGetter = () => ({ ...mockGraph, version: graphVersion });
      
      const { result } = renderHook(() => useFetchData({
        graph: graphGetter as any,
        setGraph: mockSetGraph,
        currentDSL: 'window(1-Dec-25:7-Dec-25)',
      }));
      
      const item = createFetchItem('parameter', 'my-param', 'edge-1');
      
      // First fetch
      await act(async () => {
        await result.current.fetchItem(item, { mode: 'versioned' });
      });
      
      // Update graph version
      graphVersion = 2;
      
      // Second fetch should use new graph
      await act(async () => {
        await result.current.fetchItem(item, { mode: 'versioned' });
      });
      
      // Verify getFromSource was called twice
      expect(dataOperationsService.getFromSource).toHaveBeenCalledTimes(2);
    });

    it('uses DSL getter for fresh DSL each call', async () => {
      let currentDSL = 'window(1-Dec-25:7-Dec-25)';
      const dslGetter = () => currentDSL;
      
      const { result } = renderHook(() => useFetchData({
        graph: mockGraph as any,
        setGraph: mockSetGraph,
        currentDSL: dslGetter,
      }));
      
      const item = createFetchItem('parameter', 'my-param', 'edge-1');
      
      // First fetch with original DSL
      await act(async () => {
        await result.current.fetchItem(item, { mode: 'versioned' });
      });
      
      expect(dataOperationsService.getFromSource).toHaveBeenLastCalledWith(
        expect.objectContaining({
          currentDSL: 'window(1-Dec-25:7-Dec-25)',
          targetSlice: 'window(1-Dec-25:7-Dec-25)',
        })
      );
      
      // Update DSL
      currentDSL = 'window(8-Dec-25:14-Dec-25).context(geo=UK)';
      
      // Second fetch should use new DSL
      await act(async () => {
        await result.current.fetchItem(item, { mode: 'versioned' });
      });
      
      expect(dataOperationsService.getFromSource).toHaveBeenLastCalledWith(
        expect.objectContaining({
          currentDSL: 'window(8-Dec-25:14-Dec-25).context(geo=UK)',
          targetSlice: 'window(8-Dec-25:14-Dec-25).context(geo=UK)',
        })
      );
    });
  });

  describe('error handling', () => {
    it('returns error result when fetch fails', async () => {
      vi.mocked(dataOperationsService.getFromSource).mockRejectedValueOnce(
        new Error('Network error')
      );
      
      const { result } = renderHook(() => useFetchData({
        graph: mockGraph as any,
        setGraph: mockSetGraph,
        currentDSL: 'window(1-Dec-25:7-Dec-25)',
      }));
      
      const item = createFetchItem('parameter', 'my-param', 'edge-1');
      
      let fetchResult: any;
      await act(async () => {
        fetchResult = await result.current.fetchItem(item, { mode: 'versioned' });
      });
      
      expect(fetchResult.success).toBe(false);
      expect(fetchResult.error).toBeInstanceOf(Error);
      expect(fetchResult.error.message).toBe('Network error');
    });

    it('returns error when no graph loaded', async () => {
      const { result } = renderHook(() => useFetchData({
        graph: null,
        setGraph: mockSetGraph,
        currentDSL: 'window(1-Dec-25:7-Dec-25)',
      }));
      
      const item = createFetchItem('parameter', 'my-param', 'edge-1');
      
      let fetchResult: any;
      await act(async () => {
        fetchResult = await result.current.fetchItem(item, { mode: 'versioned' });
      });
      
      expect(fetchResult.success).toBe(false);
      expect(fetchResult.error.message).toBe('No graph loaded');
    });
  });

  describe('DSL fallback', () => {
    it('falls back to graph.currentQueryDSL if currentDSL is empty', async () => {
      const graphWithDSL = {
        ...mockGraph,
        currentQueryDSL: 'window(1-Dec-25:7-Dec-25).context(geo=US)',
      };
      
      const { result } = renderHook(() => useFetchData({
        graph: graphWithDSL as any,
        setGraph: mockSetGraph,
        currentDSL: '', // Empty DSL
      }));
      
      const item = createFetchItem('parameter', 'my-param', 'edge-1');
      
      await act(async () => {
        await result.current.fetchItem(item, { mode: 'versioned' });
      });
      
      expect(dataOperationsService.getFromSource).toHaveBeenCalledWith(
        expect.objectContaining({
          currentDSL: 'window(1-Dec-25:7-Dec-25).context(geo=US)',
        })
      );
    });

    it('generates default DSL if no DSL available', () => {
      const defaultDSL = getDefaultDSL();
      expect(defaultDSL).toMatch(/^window\(\d+-\w+-\d+:\d+-\w+-\d+\)$/);
    });
  });

  describe('createFetchItem helper', () => {
    it('creates parameter item with all options', () => {
      const item = createFetchItem('parameter', 'my-param', 'edge-1', {
        paramSlot: 'cost_gbp',
        conditionalIndex: 2,
        name: 'Custom Name',
      });
      
      expect(item).toEqual({
        id: 'parameter-my-param-cost_gbp-edge-1',
        type: 'parameter',
        name: 'Custom Name',
        objectId: 'my-param',
        targetId: 'edge-1',
        paramSlot: 'cost_gbp',
        conditionalIndex: 2,
      });
    });

    it('creates case item with defaults', () => {
      const item = createFetchItem('case', 'my-case', 'node-1');
      
      expect(item).toEqual({
        id: 'case-my-case-p-node-1',
        type: 'case',
        name: 'case: my-case',
        objectId: 'my-case',
        targetId: 'node-1',
        paramSlot: undefined,
        conditionalIndex: undefined,
      });
    });

    it('creates node item', () => {
      const item = createFetchItem('node', 'my-node', 'node-uuid');
      
      expect(item).toEqual({
        id: 'node-my-node-p-node-uuid',
        type: 'node',
        name: 'node: my-node',
        objectId: 'my-node',
        targetId: 'node-uuid',
        paramSlot: undefined,
        conditionalIndex: undefined,
      });
    });
  });

  describe('fetchItems batch operation', () => {
    it('processes multiple items sequentially', async () => {
      const { result } = renderHook(() => useFetchData({
        graph: mockGraph as any,
        setGraph: mockSetGraph,
        currentDSL: 'window(1-Dec-25:7-Dec-25)',
      }));
      
      const items = [
        createFetchItem('parameter', 'param-1', 'edge-1'),
        createFetchItem('parameter', 'param-2', 'edge-2'),
        createFetchItem('case', 'case-1', 'node-1'),
      ];
      
      let results: any[];
      await act(async () => {
        results = await result.current.fetchItems(items, { mode: 'versioned' });
      });
      
      expect(results!.length).toBe(3);
      expect(results!.every(r => r.success)).toBe(true);
      expect(dataOperationsService.getFromSource).toHaveBeenCalledTimes(3);
    });

    it('calls progress callback during batch', async () => {
      const { result } = renderHook(() => useFetchData({
        graph: mockGraph as any,
        setGraph: mockSetGraph,
        currentDSL: 'window(1-Dec-25:7-Dec-25)',
      }));
      
      const items = [
        createFetchItem('parameter', 'param-1', 'edge-1'),
        createFetchItem('parameter', 'param-2', 'edge-2'),
      ];
      
      const onProgress = vi.fn();
      
      await act(async () => {
        await result.current.fetchItems(items, { mode: 'versioned', onProgress });
      });
      
      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(onProgress).toHaveBeenCalledWith(1, 2, items[0]);
      expect(onProgress).toHaveBeenCalledWith(2, 2, items[1]);
    });
  });
});

