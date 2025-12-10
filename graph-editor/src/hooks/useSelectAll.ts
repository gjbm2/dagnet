/**
 * useSelectAll Hook
 * 
 * Provides select-all functionality for graph editors.
 * Dispatches an event to GraphCanvas to select all visible nodes.
 */

import { useCallback } from 'react';
import { useTabContext } from '../contexts/TabContext';
import { getGraphStore } from '../contexts/GraphStoreContext';

/**
 * Hook to select all nodes in the current graph
 */
export function useSelectAll() {
  const { activeTabId, tabs } = useTabContext();
  
  /**
   * Check if select all is available (must be in a graph editor)
   */
  const canSelectAll = useCallback((): boolean => {
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (!activeTab) return false;
    
    const isGraphEditor = activeTab.fileId.startsWith('graph-') && 
                          activeTab.viewMode === 'interactive';
    if (!isGraphEditor) return false;
    
    // Check that we have a graph with nodes
    const store = getGraphStore(activeTab.fileId);
    if (!store) return false;
    
    const graph = store.getState().graph;
    return Boolean(graph?.nodes && graph.nodes.length > 0);
  }, [activeTabId, tabs]);
  
  /**
   * Select all nodes in the current graph
   * Dispatches an event that GraphCanvas listens for
   */
  const selectAll = useCallback(() => {
    if (!canSelectAll()) {
      console.warn('[useSelectAll] Cannot select all - not in a graph editor with nodes');
      return false;
    }
    
    // Dispatch event for GraphCanvas to handle
    window.dispatchEvent(new CustomEvent('dagnet:selectAllNodes'));
    
    return true;
  }, [canSelectAll]);
  
  return {
    selectAll,
    canSelectAll,
  };
}

