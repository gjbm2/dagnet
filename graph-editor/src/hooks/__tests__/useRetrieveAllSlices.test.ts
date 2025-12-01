/**
 * useRetrieveAllSlices Hook Tests
 * 
 * Tests the "Retrieve All Slices" flow including:
 * - Direct proceed when pinned query exists
 * - Prompt for pinned query when missing
 * - Continuation after pinned query is set
 * 
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRetrieveAllSlices } from '../useRetrieveAllSlices';

describe('useRetrieveAllSlices', () => {
  let mockSetGraph: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockSetGraph = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('when pinned query EXISTS', () => {
    it('should open AllSlicesModal directly', () => {
      const graph = {
        nodes: [],
        edges: [],
        dataInterestsDSL: 'window(-7d:).context(channel)',
      };

      const { result } = renderHook(() =>
        useRetrieveAllSlices({ graph: graph as any, setGraph: mockSetGraph })
      );

      expect(result.current.hasPinnedQuery).toBe(true);
      expect(result.current.showAllSlicesModal).toBe(false);
      expect(result.current.showPinnedQueryModal).toBe(false);

      act(() => {
        result.current.initiateRetrieveAllSlices();
      });

      expect(result.current.showAllSlicesModal).toBe(true);
      expect(result.current.showPinnedQueryModal).toBe(false);
    });

    it('should NOT open PinnedQueryModal', () => {
      const graph = {
        nodes: [],
        edges: [],
        dataInterestsDSL: 'context(geo)',
      };

      const { result } = renderHook(() =>
        useRetrieveAllSlices({ graph: graph as any, setGraph: mockSetGraph })
      );

      act(() => {
        result.current.initiateRetrieveAllSlices();
      });

      expect(result.current.showPinnedQueryModal).toBe(false);
    });
  });

  describe('when pinned query is MISSING', () => {
    it('should open PinnedQueryModal instead of AllSlicesModal', () => {
      const graph = {
        nodes: [],
        edges: [],
        dataInterestsDSL: '', // Empty = no pinned query
      };

      const { result } = renderHook(() =>
        useRetrieveAllSlices({ graph: graph as any, setGraph: mockSetGraph })
      );

      expect(result.current.hasPinnedQuery).toBe(false);

      act(() => {
        result.current.initiateRetrieveAllSlices();
      });

      expect(result.current.showPinnedQueryModal).toBe(true);
      expect(result.current.showAllSlicesModal).toBe(false);
    });

    it('should open PinnedQueryModal when dataInterestsDSL is undefined', () => {
      const graph = {
        nodes: [],
        edges: [],
        // dataInterestsDSL not set at all
      };

      const { result } = renderHook(() =>
        useRetrieveAllSlices({ graph: graph as any, setGraph: mockSetGraph })
      );

      expect(result.current.hasPinnedQuery).toBe(false);

      act(() => {
        result.current.initiateRetrieveAllSlices();
      });

      expect(result.current.showPinnedQueryModal).toBe(true);
    });

    it('should open AllSlicesModal after pinned query is saved', async () => {
      const graph = {
        nodes: [],
        edges: [],
        dataInterestsDSL: '',
      };

      const { result } = renderHook(() =>
        useRetrieveAllSlices({ graph: graph as any, setGraph: mockSetGraph })
      );

      // Start the flow
      act(() => {
        result.current.initiateRetrieveAllSlices();
      });

      expect(result.current.showPinnedQueryModal).toBe(true);

      // User saves a pinned query
      act(() => {
        result.current.pinnedQueryModalProps.onSave('window(-7d:).context(channel)');
      });

      // Should have called setGraph with the new DSL
      expect(mockSetGraph).toHaveBeenCalledWith(
        expect.objectContaining({
          dataInterestsDSL: 'window(-7d:).context(channel)',
        })
      );

      // PinnedQueryModal should close
      expect(result.current.showPinnedQueryModal).toBe(false);

      // Advance timer for the setTimeout
      act(() => {
        vi.advanceTimersByTime(150);
      });

      // AllSlicesModal should open
      expect(result.current.showAllSlicesModal).toBe(true);
    });

    it('should NOT open AllSlicesModal if user closes PinnedQueryModal without saving', () => {
      const graph = {
        nodes: [],
        edges: [],
        dataInterestsDSL: '',
      };

      const { result } = renderHook(() =>
        useRetrieveAllSlices({ graph: graph as any, setGraph: mockSetGraph })
      );

      act(() => {
        result.current.initiateRetrieveAllSlices();
      });

      expect(result.current.showPinnedQueryModal).toBe(true);

      // User closes without saving
      act(() => {
        result.current.closePinnedQueryModal();
      });

      expect(result.current.showPinnedQueryModal).toBe(false);
      expect(result.current.showAllSlicesModal).toBe(false);
      expect(mockSetGraph).not.toHaveBeenCalled();
    });

    it('should NOT open AllSlicesModal if user saves empty DSL', () => {
      const graph = {
        nodes: [],
        edges: [],
        dataInterestsDSL: '',
      };

      const { result } = renderHook(() =>
        useRetrieveAllSlices({ graph: graph as any, setGraph: mockSetGraph })
      );

      act(() => {
        result.current.initiateRetrieveAllSlices();
      });

      // User saves empty string
      act(() => {
        result.current.pinnedQueryModalProps.onSave('');
      });

      act(() => {
        vi.advanceTimersByTime(150);
      });

      // Should NOT open AllSlicesModal with empty DSL
      expect(result.current.showAllSlicesModal).toBe(false);
    });
  });

  describe('pinnedQueryModalProps', () => {
    it('should provide correct currentDSL from graph', () => {
      const graph = {
        nodes: [],
        edges: [],
        dataInterestsDSL: 'window(-30d:).context(channel)',
      };

      const { result } = renderHook(() =>
        useRetrieveAllSlices({ graph: graph as any, setGraph: mockSetGraph })
      );

      expect(result.current.pinnedQueryModalProps.currentDSL).toBe('window(-30d:).context(channel)');
    });

    it('should provide empty string for currentDSL when no pinned query', () => {
      const graph = {
        nodes: [],
        edges: [],
      };

      const { result } = renderHook(() =>
        useRetrieveAllSlices({ graph: graph as any, setGraph: mockSetGraph })
      );

      expect(result.current.pinnedQueryModalProps.currentDSL).toBe('');
    });
  });

  describe('null graph handling', () => {
    it('should handle null graph gracefully', () => {
      const { result } = renderHook(() =>
        useRetrieveAllSlices({ graph: null, setGraph: mockSetGraph })
      );

      expect(result.current.hasPinnedQuery).toBe(false);

      act(() => {
        result.current.initiateRetrieveAllSlices();
      });

      // Should open pinned query modal (no graph = no pinned query)
      expect(result.current.showPinnedQueryModal).toBe(true);
    });

    it('should not crash when saving with null graph', () => {
      const { result } = renderHook(() =>
        useRetrieveAllSlices({ graph: null, setGraph: mockSetGraph })
      );

      act(() => {
        result.current.initiateRetrieveAllSlices();
      });

      // Should not throw
      act(() => {
        result.current.pinnedQueryModalProps.onSave('window(-7d:)');
      });

      // setGraph should NOT be called (no graph to update)
      expect(mockSetGraph).not.toHaveBeenCalled();
    });
  });
});

