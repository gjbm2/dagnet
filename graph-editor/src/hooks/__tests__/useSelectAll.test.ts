/**
 * useSelectAll Hook Tests
 * 
 * Tests the select-all hook functionality including:
 * - Availability checks (canSelectAll)
 * - Select all dispatch
 * 
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { ReactNode } from 'react';

// Mock TabContext
const mockTabs: any[] = [];
let mockActiveTabId = '';

vi.mock('../../contexts/TabContext', () => ({
  useTabContext: () => ({
    activeTabId: mockActiveTabId,
    tabs: mockTabs,
  }),
}));

// Mock GraphStoreContext
let mockGraphStore: any = null;

vi.mock('../../contexts/GraphStoreContext', () => ({
  getGraphStore: () => mockGraphStore,
}));

// Import after mocks
import { useSelectAll } from '../useSelectAll';

describe('useSelectAll Hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTabs.length = 0;
    mockActiveTabId = '';
    mockGraphStore = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('canSelectAll', () => {
    it('should return false when no active tab', () => {
      mockActiveTabId = 'tab-1';
      mockTabs.length = 0;
      
      const { result } = renderHook(() => useSelectAll());
      
      expect(result.current.canSelectAll()).toBe(false);
    });

    it('should return false when active tab is not a graph editor', () => {
      mockActiveTabId = 'tab-1';
      mockTabs.push({
        id: 'tab-1',
        fileId: 'parameter-test',
        viewMode: 'interactive',
      });
      
      const { result } = renderHook(() => useSelectAll());
      
      expect(result.current.canSelectAll()).toBe(false);
    });

    it('should return false when graph editor is in raw view', () => {
      mockActiveTabId = 'tab-1';
      mockTabs.push({
        id: 'tab-1',
        fileId: 'graph-test',
        viewMode: 'raw-yaml',
      });
      
      const { result } = renderHook(() => useSelectAll());
      
      expect(result.current.canSelectAll()).toBe(false);
    });

    it('should return false when graph store is not available', () => {
      mockActiveTabId = 'tab-1';
      mockTabs.push({
        id: 'tab-1',
        fileId: 'graph-test',
        viewMode: 'interactive',
      });
      mockGraphStore = null;
      
      const { result } = renderHook(() => useSelectAll());
      
      expect(result.current.canSelectAll()).toBe(false);
    });

    it('should return false when graph has no nodes', () => {
      mockActiveTabId = 'tab-1';
      mockTabs.push({
        id: 'tab-1',
        fileId: 'graph-test',
        viewMode: 'interactive',
      });
      mockGraphStore = {
        getState: () => ({
          graph: { nodes: [], edges: [] },
        }),
      };
      
      const { result } = renderHook(() => useSelectAll());
      
      expect(result.current.canSelectAll()).toBe(false);
    });

    it('should return true when in graph editor with nodes', () => {
      mockActiveTabId = 'tab-1';
      mockTabs.push({
        id: 'tab-1',
        fileId: 'graph-test',
        viewMode: 'interactive',
      });
      mockGraphStore = {
        getState: () => ({
          graph: { 
            nodes: [{ uuid: 'node-1', id: 'test' }], 
            edges: [] 
          },
        }),
      };
      
      const { result } = renderHook(() => useSelectAll());
      
      expect(result.current.canSelectAll()).toBe(true);
    });
  });

  describe('selectAll', () => {
    it('should return false when canSelectAll returns false', () => {
      mockActiveTabId = '';
      
      const { result } = renderHook(() => useSelectAll());
      
      expect(result.current.selectAll()).toBe(false);
    });

    it('should dispatch event when canSelectAll returns true', () => {
      mockActiveTabId = 'tab-1';
      mockTabs.push({
        id: 'tab-1',
        fileId: 'graph-test',
        viewMode: 'interactive',
      });
      mockGraphStore = {
        getState: () => ({
          graph: { 
            nodes: [{ uuid: 'node-1', id: 'test' }], 
            edges: [] 
          },
        }),
      };
      
      const eventSpy = vi.fn();
      window.addEventListener('dagnet:selectAllNodes', eventSpy);
      
      const { result } = renderHook(() => useSelectAll());
      
      const success = result.current.selectAll();
      
      expect(success).toBe(true);
      expect(eventSpy).toHaveBeenCalled();
      
      window.removeEventListener('dagnet:selectAllNodes', eventSpy);
    });
  });
});




