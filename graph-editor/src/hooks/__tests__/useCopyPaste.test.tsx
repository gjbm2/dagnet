/**
 * useCopyPaste Hook Tests
 * 
 * Tests the copy-paste hook functionality including:
 * - Context provider
 * - Copy operations (single items and subgraphs)
 * - Get operations
 * - Clear operations
 * - canPaste context validation
 * 
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ReactNode } from 'react';
import { 
  CopyPasteProvider, 
  useCopyPaste, 
  DagNetClipboardData,
  DagNetSubgraphClipboardData,
  canPasteInContext 
} from '../useCopyPaste';

// Mock toast
vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock clipboard API
const mockClipboard = {
  writeText: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn().mockResolvedValue(''),
};

Object.defineProperty(navigator, 'clipboard', {
  value: mockClipboard,
  writable: true,
});

// Wrapper component for testing
const wrapper = ({ children }: { children: ReactNode }) => (
  <CopyPasteProvider>{children}</CopyPasteProvider>
);

describe('useCopyPaste Hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Context Provider', () => {
    it('should throw error when used outside provider', () => {
      // Suppress console.error for this test
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      expect(() => {
        renderHook(() => useCopyPaste());
      }).toThrow('useCopyPaste must be used within a CopyPasteProvider');
      
      consoleSpy.mockRestore();
    });

    it('should provide context when used inside provider', () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      expect(result.current).toBeDefined();
      expect(result.current.copyToClipboard).toBeDefined();
      expect(result.current.getCopiedItem).toBeDefined();
      expect(result.current.getCopiedNode).toBeDefined();
      expect(result.current.getCopiedParameter).toBeDefined();
      expect(result.current.getCopiedCase).toBeDefined();
      expect(result.current.clearCopied).toBeDefined();
      expect(result.current.copiedItem).toBeNull();
    });
  });

  describe('copyToClipboard', () => {
    it('should copy node to clipboard', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      await act(async () => {
        const success = await result.current.copyToClipboard('node', 'landing-page');
        expect(success).toBe(true);
      });
      
      expect(result.current.copiedItem).not.toBeNull();
      expect(result.current.copiedItem?.objectType).toBe('node');
      expect(result.current.copiedItem?.objectId).toBe('landing-page');
      expect(result.current.copiedItem?.type).toBe('dagnet-copy');
    });

    it('should copy parameter to clipboard', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      await act(async () => {
        await result.current.copyToClipboard('parameter', 'checkout-rate');
      });
      
      expect(result.current.copiedItem?.objectType).toBe('parameter');
      expect(result.current.copiedItem?.objectId).toBe('checkout-rate');
    });

    it('should copy case to clipboard', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      await act(async () => {
        await result.current.copyToClipboard('case', 'ab-test-2025');
      });
      
      expect(result.current.copiedItem?.objectType).toBe('case');
      expect(result.current.copiedItem?.objectId).toBe('ab-test-2025');
    });

    it('should write to system clipboard', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      await act(async () => {
        await result.current.copyToClipboard('node', 'landing-page');
      });
      
      expect(mockClipboard.writeText).toHaveBeenCalled();
      const clipboardArg = mockClipboard.writeText.mock.calls[0][0];
      const parsed = JSON.parse(clipboardArg);
      expect(parsed.type).toBe('dagnet-copy');
      expect(parsed.objectType).toBe('node');
      expect(parsed.objectId).toBe('landing-page');
    });

    it('should include timestamp in clipboard data', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      const beforeTime = Date.now();
      
      await act(async () => {
        await result.current.copyToClipboard('node', 'landing-page');
      });
      
      const afterTime = Date.now();
      expect(result.current.copiedItem?.timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(result.current.copiedItem?.timestamp).toBeLessThanOrEqual(afterTime);
    });

    it('should handle clipboard write failure gracefully', async () => {
      mockClipboard.writeText.mockRejectedValueOnce(new Error('Clipboard error'));
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      await act(async () => {
        const success = await result.current.copyToClipboard('node', 'landing-page');
        // Should still succeed (memory cache works even if clipboard fails)
        expect(success).toBe(true);
      });
      
      // Item should still be in memory cache
      expect(result.current.copiedItem).not.toBeNull();
      expect(consoleSpy).toHaveBeenCalled();
      
      consoleSpy.mockRestore();
    });
  });

  describe('getCopiedItem', () => {
    it('should return null when nothing is copied', () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      expect(result.current.getCopiedItem()).toBeNull();
    });

    it('should return copied item after copy', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      await act(async () => {
        await result.current.copyToClipboard('node', 'landing-page');
      });
      
      const item = result.current.getCopiedItem();
      expect(item).not.toBeNull();
      expect(item?.objectType).toBe('node');
      expect(item?.objectId).toBe('landing-page');
    });
  });

  describe('getCopiedNode', () => {
    it('should return null when nothing is copied', () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      expect(result.current.getCopiedNode()).toBeNull();
    });

    it('should return node when node is copied', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      await act(async () => {
        await result.current.copyToClipboard('node', 'landing-page');
      });
      
      const node = result.current.getCopiedNode();
      expect(node).not.toBeNull();
      expect(node?.objectType).toBe('node');
    });

    it('should return null when parameter is copied', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      await act(async () => {
        await result.current.copyToClipboard('parameter', 'checkout-rate');
      });
      
      expect(result.current.getCopiedNode()).toBeNull();
    });

    it('should return null when case is copied', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      await act(async () => {
        await result.current.copyToClipboard('case', 'ab-test');
      });
      
      expect(result.current.getCopiedNode()).toBeNull();
    });
  });

  describe('getCopiedParameter', () => {
    it('should return null when nothing is copied', () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      expect(result.current.getCopiedParameter()).toBeNull();
    });

    it('should return parameter when parameter is copied', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      await act(async () => {
        await result.current.copyToClipboard('parameter', 'checkout-rate');
      });
      
      const param = result.current.getCopiedParameter();
      expect(param).not.toBeNull();
      expect(param?.objectType).toBe('parameter');
    });

    it('should return null when node is copied', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      await act(async () => {
        await result.current.copyToClipboard('node', 'landing-page');
      });
      
      expect(result.current.getCopiedParameter()).toBeNull();
    });
  });

  describe('getCopiedCase', () => {
    it('should return null when nothing is copied', () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      expect(result.current.getCopiedCase()).toBeNull();
    });

    it('should return case when case is copied', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      await act(async () => {
        await result.current.copyToClipboard('case', 'ab-test');
      });
      
      const caseItem = result.current.getCopiedCase();
      expect(caseItem).not.toBeNull();
      expect(caseItem?.objectType).toBe('case');
    });

    it('should return null when node is copied', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      await act(async () => {
        await result.current.copyToClipboard('node', 'landing-page');
      });
      
      expect(result.current.getCopiedCase()).toBeNull();
    });
  });

  describe('clearCopied', () => {
    it('should clear copied item', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      await act(async () => {
        await result.current.copyToClipboard('node', 'landing-page');
      });
      
      expect(result.current.copiedItem).not.toBeNull();
      
      act(() => {
        result.current.clearCopied();
      });
      
      expect(result.current.copiedItem).toBeNull();
    });

    it('should have no effect when nothing is copied', () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      expect(result.current.copiedItem).toBeNull();
      
      act(() => {
        result.current.clearCopied();
      });
      
      expect(result.current.copiedItem).toBeNull();
    });
  });

  describe('copiedItem state', () => {
    it('should update copiedItem when copying', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      expect(result.current.copiedItem).toBeNull();
      
      await act(async () => {
        await result.current.copyToClipboard('node', 'landing-page');
      });
      
      expect(result.current.copiedItem).not.toBeNull();
    });

    it('should replace previous item when copying new item', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      await act(async () => {
        await result.current.copyToClipboard('node', 'landing-page');
      });
      
      expect(result.current.copiedItem?.objectId).toBe('landing-page');
      
      await act(async () => {
        await result.current.copyToClipboard('parameter', 'checkout-rate');
      });
      
      expect(result.current.copiedItem?.objectType).toBe('parameter');
      expect(result.current.copiedItem?.objectId).toBe('checkout-rate');
    });

    it('should allow copying different types in sequence', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      // Copy node
      await act(async () => {
        await result.current.copyToClipboard('node', 'landing-page');
      });
      expect(result.current.getCopiedNode()).not.toBeNull();
      expect(result.current.getCopiedParameter()).toBeNull();
      
      // Copy parameter
      await act(async () => {
        await result.current.copyToClipboard('parameter', 'checkout-rate');
      });
      expect(result.current.getCopiedNode()).toBeNull();
      expect(result.current.getCopiedParameter()).not.toBeNull();
      
      // Copy case
      await act(async () => {
        await result.current.copyToClipboard('case', 'ab-test');
      });
      expect(result.current.getCopiedNode()).toBeNull();
      expect(result.current.getCopiedParameter()).toBeNull();
      expect(result.current.getCopiedCase()).not.toBeNull();
    });
  });

  describe('copySubgraph', () => {
    it('should copy nodes and edges as subgraph', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      const nodes = [
        { uuid: 'node-1', id: 'landing-page', label: 'Landing Page' },
        { uuid: 'node-2', id: 'checkout', label: 'Checkout' },
      ];
      const edges = [
        { uuid: 'edge-1', id: 'landing-to-checkout', from: 'node-1', to: 'node-2', p: { mean: 0.5 } },
      ];
      
      await act(async () => {
        const success = await result.current.copySubgraph(nodes as any, edges as any, 'graph-test');
        expect(success).toBe(true);
      });
      
      expect(result.current.copiedItem?.type).toBe('dagnet-subgraph');
      const subgraph = result.current.getCopiedSubgraph();
      expect(subgraph).not.toBeNull();
      expect(subgraph?.nodes).toHaveLength(2);
      expect(subgraph?.edges).toHaveLength(1);
      expect(subgraph?.sourceGraphId).toBe('graph-test');
    });

    it('should return false when copying empty nodes', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      await act(async () => {
        const success = await result.current.copySubgraph([], [], 'graph-test');
        expect(success).toBe(false);
      });
      
      expect(result.current.copiedItem).toBeNull();
    });

    it('should deep clone nodes and edges', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      const nodes = [{ uuid: 'node-1', id: 'test', label: 'Test' }];
      const edges: any[] = [];
      
      await act(async () => {
        await result.current.copySubgraph(nodes as any, edges);
      });
      
      // Modify original
      nodes[0].label = 'Modified';
      
      // Clipboard should still have original
      const subgraph = result.current.getCopiedSubgraph();
      expect(subgraph?.nodes[0].label).toBe('Test');
    });

    it('should write subgraph to system clipboard', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      const nodes = [{ uuid: 'node-1', id: 'test', label: 'Test' }];
      
      await act(async () => {
        await result.current.copySubgraph(nodes as any, []);
      });
      
      expect(mockClipboard.writeText).toHaveBeenCalled();
      const clipboardArg = mockClipboard.writeText.mock.calls[0][0];
      const parsed = JSON.parse(clipboardArg);
      expect(parsed.type).toBe('dagnet-subgraph');
    });
  });

  describe('getCopiedSubgraph', () => {
    it('should return null when nothing is copied', () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      expect(result.current.getCopiedSubgraph()).toBeNull();
    });

    it('should return null when single item is copied', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      await act(async () => {
        await result.current.copyToClipboard('node', 'landing-page');
      });
      
      expect(result.current.getCopiedSubgraph()).toBeNull();
    });

    it('should return subgraph when subgraph is copied', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      const nodes = [{ uuid: 'node-1', id: 'test', label: 'Test' }];
      
      await act(async () => {
        await result.current.copySubgraph(nodes as any, []);
      });
      
      const subgraph = result.current.getCopiedSubgraph();
      expect(subgraph).not.toBeNull();
      expect(subgraph?.nodes).toHaveLength(1);
    });
  });

  describe('canPaste', () => {
    it('should return false when nothing is copied', () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      expect(result.current.canPaste('graph')).toBe(false);
      expect(result.current.canPaste('node')).toBe(false);
      expect(result.current.canPaste('edge')).toBe(false);
    });

    it('should return true for graph context when subgraph is copied', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      const nodes = [{ uuid: 'node-1', id: 'test', label: 'Test' }];
      
      await act(async () => {
        await result.current.copySubgraph(nodes as any, []);
      });
      
      expect(result.current.canPaste('graph')).toBe(true);
      expect(result.current.canPaste('edge')).toBe(false);
    });

    it('should return true for graph context when single node is copied', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      await act(async () => {
        await result.current.copyToClipboard('node', 'landing-page');
      });
      
      expect(result.current.canPaste('graph')).toBe(true);
    });

    it('should return true for edge context when parameter is copied', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      await act(async () => {
        await result.current.copyToClipboard('parameter', 'checkout-rate');
      });
      
      expect(result.current.canPaste('edge')).toBe(true);
      expect(result.current.canPaste('graph')).toBe(false);
    });

    it('should return true for node context when case is copied', async () => {
      const { result } = renderHook(() => useCopyPaste(), { wrapper });
      
      await act(async () => {
        await result.current.copyToClipboard('case', 'ab-test');
      });
      
      expect(result.current.canPaste('node')).toBe(true);
      expect(result.current.canPaste('graph')).toBe(false);
    });
  });
});

describe('canPasteInContext', () => {
  it('should return false for null content', () => {
    expect(canPasteInContext(null, 'graph')).toBe(false);
    expect(canPasteInContext(null, 'node')).toBe(false);
    expect(canPasteInContext(null, 'edge')).toBe(false);
  });

  describe('graph context', () => {
    it('should allow subgraph paste', () => {
      const subgraph: DagNetSubgraphClipboardData = {
        type: 'dagnet-subgraph',
        nodes: [],
        edges: [],
        timestamp: Date.now(),
      };
      expect(canPasteInContext(subgraph, 'graph')).toBe(true);
    });

    it('should allow single node paste', () => {
      const node: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'node',
        objectId: 'test',
        timestamp: Date.now(),
      };
      expect(canPasteInContext(node, 'graph')).toBe(true);
    });

    it('should not allow parameter paste', () => {
      const param: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'parameter',
        objectId: 'test',
        timestamp: Date.now(),
      };
      expect(canPasteInContext(param, 'graph')).toBe(false);
    });
  });

  describe('edge context', () => {
    it('should allow parameter paste', () => {
      const param: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'parameter',
        objectId: 'test',
        timestamp: Date.now(),
      };
      expect(canPasteInContext(param, 'edge')).toBe(true);
    });

    it('should not allow node paste', () => {
      const node: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'node',
        objectId: 'test',
        timestamp: Date.now(),
      };
      expect(canPasteInContext(node, 'edge')).toBe(false);
    });

    it('should not allow subgraph paste', () => {
      const subgraph: DagNetSubgraphClipboardData = {
        type: 'dagnet-subgraph',
        nodes: [],
        edges: [],
        timestamp: Date.now(),
      };
      expect(canPasteInContext(subgraph, 'edge')).toBe(false);
    });
  });

  describe('node context', () => {
    it('should allow node paste', () => {
      const node: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'node',
        objectId: 'test',
        timestamp: Date.now(),
      };
      expect(canPasteInContext(node, 'node')).toBe(true);
    });

    it('should allow case paste', () => {
      const caseItem: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'case',
        objectId: 'test',
        timestamp: Date.now(),
      };
      expect(canPasteInContext(caseItem, 'node')).toBe(true);
    });

    it('should allow event paste', () => {
      const event: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'event',
        objectId: 'test',
        timestamp: Date.now(),
      };
      expect(canPasteInContext(event, 'node')).toBe(true);
    });

    it('should not allow parameter paste', () => {
      const param: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'parameter',
        objectId: 'test',
        timestamp: Date.now(),
      };
      expect(canPasteInContext(param, 'node')).toBe(false);
    });
  });

  describe('navigator context', () => {
    it('should not allow any paste', () => {
      const node: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'node',
        objectId: 'test',
        timestamp: Date.now(),
      };
      expect(canPasteInContext(node, 'navigator')).toBe(false);
    });
  });
});

