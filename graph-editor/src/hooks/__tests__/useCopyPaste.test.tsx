/**
 * useCopyPaste Hook Tests
 * 
 * Tests the copy-paste hook functionality including:
 * - Context provider
 * - Copy operations
 * - Get operations
 * - Clear operations
 * 
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ReactNode } from 'react';
import { CopyPasteProvider, useCopyPaste, DagNetClipboardData } from '../useCopyPaste';

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
});

