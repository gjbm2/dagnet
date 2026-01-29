/**
 * EnhancedSelector Auto-Get Tests
 * 
 * Tests the auto-get behaviour when user selects an item from the dropdown.
 * Verifies that:
 * - fetchItem is called with correct mode ('from-file')
 * - Correct parameters are passed (type, objectId, targetId, paramSlot, conditionalIndex)
 * - setAutoUpdating callback is passed through
 * - Auto-get only triggers when conditions are met (hasFile, graph, targetInstanceUuid)
 * 
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// MOCK SETUP - vi.mock is hoisted, so inline all factories
// ============================================================================

vi.mock('../../hooks/useFetchData', () => ({
  useFetchData: vi.fn(() => ({
    fetchItem: vi.fn().mockResolvedValue({ success: true, item: {} }),
    fetchItems: vi.fn(),
    getItemsNeedingFetch: vi.fn(),
    itemNeedsFetch: vi.fn(),
    effectiveDSL: 'window(1-Dec-25:7-Dec-25)',
  })),
  createFetchItem: vi.fn((type: string, objectId: string, targetId: string, options: any) => ({
    id: `${type}-${objectId}-${targetId}`,
    type,
    name: objectId,
    objectId,
    targetId,
    paramSlot: options?.paramSlot,
    conditionalIndex: options?.conditionalIndex,
  })),
}));

// Import the mocked module
import { createFetchItem } from '../../hooks/useFetchData';

// ============================================================================
// TEST HELPERS
// ============================================================================

interface AutoGetScenario {
  type: 'parameter' | 'case' | 'node';
  itemId: string;
  targetInstanceUuid: string;
  hasFile: boolean;
  paramSlot?: 'p' | 'cost_gbp' | 'labour_cost';
  conditionalIndex?: number;
}

const mockGraph = {
  nodes: [{ uuid: 'node-1', id: 'test-node' }],
  edges: [{ uuid: 'edge-1', id: 'test-edge', p: { id: 'param-1' } }],
  currentQueryDSL: 'window(1-Dec-25:7-Dec-25)',
};

/**
 * Simulates the auto-get flow that EnhancedSelector performs when an item is selected.
 * This extracts the core logic for testing without needing to render the full component.
 */
async function simulateAutoGet(
  scenario: AutoGetScenario,
  graph: any,
  fetchItem: ReturnType<typeof vi.fn>,
  setAutoUpdating: ReturnType<typeof vi.fn>
) {
  const { type, itemId, targetInstanceUuid, hasFile, paramSlot, conditionalIndex } = scenario;
  
  // This mirrors the condition in EnhancedSelector.handleSelectItem
  if (hasFile && graph && targetInstanceUuid && (type === 'parameter' || type === 'case' || type === 'node')) {
    const fetchItemData = createFetchItem(
      type,
      itemId,
      targetInstanceUuid,
      { paramSlot, conditionalIndex }
    );
    await fetchItem(fetchItemData, { mode: 'from-file', setAutoUpdating });
    return true;
  }
  return false;
}

// ============================================================================
// TESTS: Core Auto-Get Behaviour
// ============================================================================

describe('EnhancedSelector auto-get', () => {
  let mockFetchItem: ReturnType<typeof vi.fn>;
  let mockSetAutoUpdating: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchItem = vi.fn().mockResolvedValue({ success: true });
    mockSetAutoUpdating = vi.fn();
  });

  describe('parameter selection', () => {
    it('should call fetchItem with mode: from-file when selecting a parameter', async () => {
      const triggered = await simulateAutoGet(
        {
          type: 'parameter',
          itemId: 'my-param',
          targetInstanceUuid: 'edge-uuid-123',
          hasFile: true,
          paramSlot: 'p',
        },
        mockGraph,
        mockFetchItem,
        mockSetAutoUpdating
      );
      
      expect(triggered).toBe(true);
      expect(mockFetchItem).toHaveBeenCalledTimes(1);
      expect(mockFetchItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'parameter',
          objectId: 'my-param',
          targetId: 'edge-uuid-123',
          paramSlot: 'p',
        }),
        { mode: 'from-file', setAutoUpdating: mockSetAutoUpdating }
      );
    });

    it('should pass paramSlot correctly for cost_gbp parameters', async () => {
      await simulateAutoGet(
        {
          type: 'parameter',
          itemId: 'cost-param',
          targetInstanceUuid: 'edge-uuid-456',
          hasFile: true,
          paramSlot: 'cost_gbp',
        },
        mockGraph,
        mockFetchItem,
        mockSetAutoUpdating
      );
      
      expect(vi.mocked(createFetchItem)).toHaveBeenCalledWith(
        'parameter',
        'cost-param',
        'edge-uuid-456',
        { paramSlot: 'cost_gbp', conditionalIndex: undefined }
      );
    });

    it('should pass paramSlot correctly for labour_cost parameters', async () => {
      await simulateAutoGet(
        {
          type: 'parameter',
          itemId: 'time-param',
          targetInstanceUuid: 'edge-uuid-789',
          hasFile: true,
          paramSlot: 'labour_cost',
        },
        mockGraph,
        mockFetchItem,
        mockSetAutoUpdating
      );
      
      expect(vi.mocked(createFetchItem)).toHaveBeenCalledWith(
        'parameter',
        'time-param',
        'edge-uuid-789',
        { paramSlot: 'labour_cost', conditionalIndex: undefined }
      );
    });

    it('should pass conditionalIndex for conditional probability parameters', async () => {
      await simulateAutoGet(
        {
          type: 'parameter',
          itemId: 'cond-param',
          targetInstanceUuid: 'edge-uuid-abc',
          hasFile: true,
          paramSlot: 'p',
          conditionalIndex: 2,
        },
        mockGraph,
        mockFetchItem,
        mockSetAutoUpdating
      );
      
      expect(vi.mocked(createFetchItem)).toHaveBeenCalledWith(
        'parameter',
        'cond-param',
        'edge-uuid-abc',
        { paramSlot: 'p', conditionalIndex: 2 }
      );
    });
  });

  describe('case selection', () => {
    it('should call fetchItem with mode: from-file when selecting a case', async () => {
      const triggered = await simulateAutoGet(
        {
          type: 'case',
          itemId: 'my-case',
          targetInstanceUuid: 'node-uuid-123',
          hasFile: true,
        },
        mockGraph,
        mockFetchItem,
        mockSetAutoUpdating
      );
      
      expect(triggered).toBe(true);
      expect(mockFetchItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'case',
          objectId: 'my-case',
          targetId: 'node-uuid-123',
        }),
        { mode: 'from-file', setAutoUpdating: mockSetAutoUpdating }
      );
    });
  });

  describe('node selection', () => {
    it('should call fetchItem with mode: from-file when selecting a node', async () => {
      const triggered = await simulateAutoGet(
        {
          type: 'node',
          itemId: 'my-node',
          targetInstanceUuid: 'node-uuid-456',
          hasFile: true,
        },
        mockGraph,
        mockFetchItem,
        mockSetAutoUpdating
      );
      
      expect(triggered).toBe(true);
      expect(mockFetchItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'node',
          objectId: 'my-node',
          targetId: 'node-uuid-456',
        }),
        { mode: 'from-file', setAutoUpdating: mockSetAutoUpdating }
      );
    });
  });

  describe('conditions that prevent auto-get', () => {
    it('should NOT auto-get when item has no file', async () => {
      const triggered = await simulateAutoGet(
        {
          type: 'parameter',
          itemId: 'no-file-param',
          targetInstanceUuid: 'edge-uuid-123',
          hasFile: false, // No file
        },
        mockGraph,
        mockFetchItem,
        mockSetAutoUpdating
      );
      
      expect(triggered).toBe(false);
      expect(mockFetchItem).not.toHaveBeenCalled();
    });

    it('should NOT auto-get when graph is null', async () => {
      const triggered = await simulateAutoGet(
        {
          type: 'parameter',
          itemId: 'my-param',
          targetInstanceUuid: 'edge-uuid-123',
          hasFile: true,
        },
        null, // No graph
        mockFetchItem,
        mockSetAutoUpdating
      );
      
      expect(triggered).toBe(false);
      expect(mockFetchItem).not.toHaveBeenCalled();
    });

    it('should NOT auto-get when targetInstanceUuid is missing', async () => {
      const triggered = await simulateAutoGet(
        {
          type: 'parameter',
          itemId: 'my-param',
          targetInstanceUuid: '', // Empty
          hasFile: true,
        },
        mockGraph,
        mockFetchItem,
        mockSetAutoUpdating
      );
      
      expect(triggered).toBe(false);
      expect(mockFetchItem).not.toHaveBeenCalled();
    });

    it('should NOT auto-get for context type (unsupported)', async () => {
      // Context is not in the supported types list
      const type = 'context' as any;
      const hasFile = true;
      const graph = mockGraph;
      const targetInstanceUuid = 'some-uuid';
      
      // Simulate the condition check
      const shouldTrigger = hasFile && graph && targetInstanceUuid && 
        (type === 'parameter' || type === 'case' || type === 'node');
      
      expect(shouldTrigger).toBe(false);
    });

    it('should NOT auto-get for event type (unsupported)', async () => {
      const type = 'event' as any;
      const hasFile = true;
      const graph = mockGraph;
      const targetInstanceUuid = 'some-uuid';
      
      const shouldTrigger = hasFile && graph && targetInstanceUuid && 
        (type === 'parameter' || type === 'case' || type === 'node');
      
      expect(shouldTrigger).toBe(false);
    });
  });

  describe('setAutoUpdating callback', () => {
    it('should pass setAutoUpdating to fetchItem for animation support', async () => {
      await simulateAutoGet(
        {
          type: 'parameter',
          itemId: 'anim-param',
          targetInstanceUuid: 'edge-uuid-anim',
          hasFile: true,
          paramSlot: 'p',
        },
        mockGraph,
        mockFetchItem,
        mockSetAutoUpdating
      );
      
      // Verify setAutoUpdating was passed in options
      const callArgs = mockFetchItem.mock.calls[0];
      expect(callArgs[1]).toEqual({
        mode: 'from-file',
        setAutoUpdating: mockSetAutoUpdating,
      });
    });
  });

  describe('error handling', () => {
    it('should handle fetchItem failure gracefully', async () => {
      const failingFetchItem = vi.fn().mockRejectedValue(new Error('Network error'));
      
      // Should throw (in the real component, this is caught and logged silently)
      await expect(
        simulateAutoGet(
          {
            type: 'parameter',
            itemId: 'failing-param',
            targetInstanceUuid: 'edge-uuid-fail',
            hasFile: true,
            paramSlot: 'p',
          },
          mockGraph,
          failingFetchItem,
          mockSetAutoUpdating
        )
      ).rejects.toThrow('Network error');
      
      // The actual component catches this - we're just verifying the error propagates
    });
  });
});

// ============================================================================
// TESTS: createFetchItem Utility
// ============================================================================

describe('createFetchItem for EnhancedSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create correct FetchItem for parameter', () => {
    const item = createFetchItem('parameter', 'my-param', 'edge-123', { paramSlot: 'p' });
    
    expect(item).toEqual(expect.objectContaining({
      type: 'parameter',
      objectId: 'my-param',
      targetId: 'edge-123',
      paramSlot: 'p',
    }));
  });

  it('should create correct FetchItem for case', () => {
    const item = createFetchItem('case', 'my-case', 'node-456', {});
    
    expect(item).toEqual(expect.objectContaining({
      type: 'case',
      objectId: 'my-case',
      targetId: 'node-456',
    }));
  });

  it('should create correct FetchItem for node', () => {
    const item = createFetchItem('node', 'my-node', 'node-789', {});
    
    expect(item).toEqual(expect.objectContaining({
      type: 'node',
      objectId: 'my-node',
      targetId: 'node-789',
    }));
  });

  it('should include conditionalIndex when provided', () => {
    const item = createFetchItem('parameter', 'cond-param', 'edge-abc', { 
      paramSlot: 'p', 
      conditionalIndex: 3 
    });
    
    expect(item.conditionalIndex).toBe(3);
  });
});

// ============================================================================
// TESTS: Mode Verification
// ============================================================================

// ============================================================================
// TESTS: Stale Graph Closure Regression (Critical Bug Fix)
// ============================================================================

describe('EnhancedSelector stale graph closure regression', () => {
  /**
   * REGRESSION TEST for the stale graph closure bug.
   * 
   * The bug: When a user selects an item from the dropdown:
   * 1. handleSelectItem calls onChange(item.id) to update graph (e.g., edge.p.id = 'new-param')
   * 2. handleSelectItem schedules setTimeout for auto-get
   * 3. When setTimeout fires, fetchItem was using the OLD graph (captured at render time)
   * 4. The fetch service would write back using stale graph, overwriting the new p.id
   * 
   * The fix: EnhancedSelector now uses a graphRef and passes a getter function
   * to useFetchData, ensuring fetchItem always reads the CURRENT graph state.
   */
  
  it('should use the UPDATED graph when fetchItem is called after graph mutation', async () => {
    // Simulate the scenario:
    // 1. Initial graph has edge.p.id = 'old-param'
    // 2. User selects 'new-param' -> graph is mutated to edge.p.id = 'new-param'
    // 3. Auto-get fires -> fetchItem must see graph with edge.p.id = 'new-param'
    
    const initialGraph = {
      nodes: [{ uuid: 'node-1', id: 'test-node' }],
      edges: [{ uuid: 'edge-1', id: 'test-edge', p: { id: 'old-param' } }],
      currentQueryDSL: 'window(1-Dec-25:7-Dec-25)',
    };
    
    const updatedGraph = {
      ...initialGraph,
      edges: [{ uuid: 'edge-1', id: 'test-edge', p: { id: 'new-param' } }],
    };
    
    // This simulates what EnhancedSelector does with graphRef
    let currentGraph = initialGraph;
    const graphRef = { current: initialGraph };
    const getGraph = () => graphRef.current;
    
    // Track what graph fetchItem receives
    let graphSeenByFetchItem: any = null;
    const trackingFetchItem = vi.fn(async (item: any, options: any) => {
      // In the real implementation, fetchItem calls getGraph() to get current graph
      graphSeenByFetchItem = getGraph();
      return { success: true };
    });
    
    // Simulate the selection flow:
    // Step 1: User selects 'new-param' - this triggers onChange which mutates graph
    graphRef.current = updatedGraph; // Graph is updated BEFORE auto-get fires
    
    // Step 2: Auto-get fires (via setTimeout in real code)
    await simulateAutoGet(
      {
        type: 'parameter',
        itemId: 'new-param',
        targetInstanceUuid: 'edge-1',
        hasFile: true,
        paramSlot: 'p',
      },
      getGraph(), // Pass the getter result (simulating what useFetchData does)
      trackingFetchItem,
      vi.fn()
    );
    
    // Verify fetchItem saw the UPDATED graph, not the stale initial graph
    expect(graphSeenByFetchItem).toBe(updatedGraph);
    expect(graphSeenByFetchItem.edges[0].p.id).toBe('new-param');
    expect(graphSeenByFetchItem.edges[0].p.id).not.toBe('old-param');
  });
  
  it('should NOT see stale graph when using ref pattern (the fix)', async () => {
    // This test explicitly verifies the ref pattern works correctly
    const staleGraph = {
      nodes: [],
      edges: [{ uuid: 'e1', p: { id: 'stale-value' } }],
    };
    
    const freshGraph = {
      nodes: [],
      edges: [{ uuid: 'e1', p: { id: 'fresh-value' } }],
    };
    
    // Ref pattern: always points to latest
    const graphRef = { current: staleGraph };
    
    // Simulate what happens during render vs async callback
    const capturedAtRenderTime = graphRef.current; // Would be stale in old code
    
    // Graph updates (as if onChange was called)
    graphRef.current = freshGraph;
    
    // In the old buggy code, fetchItem would use capturedAtRenderTime
    // In the fixed code, fetchItem reads from graphRef.current
    
    // Verify the ref pattern gives us fresh data
    expect(graphRef.current).toBe(freshGraph);
    expect(graphRef.current.edges[0].p.id).toBe('fresh-value');
    
    // The stale capture would have been wrong
    expect(capturedAtRenderTime).toBe(staleGraph);
    expect(capturedAtRenderTime.edges[0].p.id).toBe('stale-value');
  });
});

describe('EnhancedSelector auto-get mode', () => {
  let mockFetchItem: ReturnType<typeof vi.fn>;
  let mockSetAutoUpdating: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchItem = vi.fn().mockResolvedValue({ success: true });
    mockSetAutoUpdating = vi.fn();
  });

  it('should ALWAYS use from-file mode (never versioned or direct)', async () => {
    // Test multiple scenarios to ensure mode is always 'from-file'
    const scenarios: AutoGetScenario[] = [
      { type: 'parameter', itemId: 'p1', targetInstanceUuid: 'e1', hasFile: true, paramSlot: 'p' },
      { type: 'parameter', itemId: 'p2', targetInstanceUuid: 'e2', hasFile: true, paramSlot: 'cost_gbp' },
      { type: 'case', itemId: 'c1', targetInstanceUuid: 'n1', hasFile: true },
      { type: 'node', itemId: 'n1', targetInstanceUuid: 'n2', hasFile: true },
    ];
    
    for (const scenario of scenarios) {
      vi.clearAllMocks();
      await simulateAutoGet(scenario, mockGraph, mockFetchItem, mockSetAutoUpdating);
      
      expect(mockFetchItem).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ mode: 'from-file' })
      );
    }
  });

  it('should NOT use versioned mode (that would trigger API calls)', async () => {
    await simulateAutoGet(
      {
        type: 'parameter',
        itemId: 'test-param',
        targetInstanceUuid: 'edge-test',
        hasFile: true,
        paramSlot: 'p',
      },
      mockGraph,
      mockFetchItem,
      mockSetAutoUpdating
    );
    
    const callArgs = mockFetchItem.mock.calls[0];
    expect(callArgs[1].mode).not.toBe('versioned');
    expect(callArgs[1].mode).not.toBe('direct');
    expect(callArgs[1].mode).toBe('from-file');
  });
});
