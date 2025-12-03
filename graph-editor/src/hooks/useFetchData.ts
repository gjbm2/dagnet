/**
 * useFetchData Hook
 * 
 * THE single centralized hook for all data fetch operations in React components.
 * 
 * This hook is a thin wrapper around fetchDataService, providing:
 * - React memoization (useCallback, useMemo)
 * - Getter pattern for fresh graph/DSL in batch operations
 * 
 * SINGLE CODE PATH PRINCIPLE:
 * All actual fetch logic lives in fetchDataService.ts.
 * This hook and direct service calls both use the same underlying code.
 * 
 * Principles:
 * - WindowSelector expresses current slice (DSL)
 * - Same logic/codepath regardless of UI entry point
 * - Operation mode controls behavior, not call site
 * 
 * Modes:
 * - 'versioned' (default): Fetch from source with window aggregation
 * - 'direct': Fetch from source without aggregation (daily mode)
 * - 'from-file': Load from file only (no API call)
 */

import { useCallback, useMemo } from 'react';
import {
  fetchDataService,
  getDefaultDSL,
  type FetchItem,
  type FetchOptions,
  type FetchResult,
  type FetchMode,
} from '../services/fetchDataService';
import type { Graph, DateRange } from '../types';
import toast from 'react-hot-toast';

// ============================================================================
// Re-export types from service for backward compatibility
// ============================================================================

export type { FetchMode, FetchItem, FetchOptions, FetchResult };
export { getDefaultDSL, createFetchItem } from '../services/fetchDataService';

// ============================================================================
// Hook Types
// ============================================================================

export interface UseFetchDataOptions {
  /** The graph to operate on. Can be a value or a getter for batch operations. */
  graph: Graph | null | (() => Graph | null);
  /** Setter for the graph - should handle ref updates for batch operations */
  setGraph: (graph: Graph | null) => void;
  /** The current slice DSL (from WindowSelector). Can be a value or a getter. */
  currentDSL: string | (() => string);
}

export interface UseFetchDataReturn {
  /**
   * Fetch a single item. Mode defaults to 'versioned'.
   * 
   * @example
   * // Versioned fetch (default)
   * await fetchItem(item);
   * 
   * // Direct fetch (no aggregation)
   * await fetchItem(item, { mode: 'direct' });
   * 
   * // From file only (no API call)
   * await fetchItem(item, { mode: 'from-file' });
   */
  fetchItem: (item: FetchItem, options?: FetchOptions) => Promise<FetchResult>;
  
  /**
   * Fetch multiple items with same mode.
   */
  fetchItems: (items: FetchItem[], options?: FetchOptions & { 
    onProgress?: (current: number, total: number, item: FetchItem) => void 
  }) => Promise<FetchResult[]>;
  
  /**
   * Calculate which items need fetching for the current window.
   * Only applies to 'versioned' mode - direct/from-file always "need" fetch.
   */
  getItemsNeedingFetch: (window: DateRange) => FetchItem[];
  
  /**
   * Check if a specific item needs fetching for the given window.
   */
  itemNeedsFetch: (item: FetchItem, window: DateRange) => boolean;
  
  /** The effective DSL being used (resolved from options/graph/defaults) */
  effectiveDSL: string;
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useFetchData(options: UseFetchDataOptions): UseFetchDataReturn {
  const { graph: graphOrGetter, setGraph, currentDSL: dslOrGetter } = options;
  
  // Helper to resolve graph (supports both value and getter for batch operations)
  const getGraph = useCallback((): Graph | null => {
    return typeof graphOrGetter === 'function' ? graphOrGetter() : graphOrGetter;
  }, [graphOrGetter]);
  
  // Helper to resolve DSL
  // CRITICAL: NEVER fall back to graph.currentQueryDSL - it's only for historic record!
  // The caller MUST provide the authoritative DSL from graphStore.currentDSL
  const getDSL = useCallback((): string => {
    const dsl = typeof dslOrGetter === 'function' ? dslOrGetter() : dslOrGetter;
    if (dsl && dsl.trim()) return dsl;
    // Only fall back to default DSL if nothing provided - NEVER read from graph
    return getDefaultDSL();
  }, [dslOrGetter]);
  
  // For render-time access (e.g., display in UI)
  const graph = getGraph();
  const effectiveDSL = useMemo(() => getDSL(), [getDSL]);
  
  /**
   * Check if a specific item needs fetching for the given window.
   * Only meaningful for 'versioned' mode.
   */
  const itemNeedsFetch = useCallback((item: FetchItem, window: DateRange): boolean => {
    const currentGraph = getGraph();
    if (!currentGraph) return false;
    return fetchDataService.itemNeedsFetch(item, window, currentGraph, effectiveDSL);
  }, [getGraph, effectiveDSL]);
  
  /**
   * Get all items that need fetching for the current window.
   */
  const getItemsNeedingFetch = useCallback((window: DateRange): FetchItem[] => {
    const currentGraph = getGraph();
    if (!currentGraph) return [];
    return fetchDataService.getItemsNeedingFetch(window, currentGraph, effectiveDSL);
  }, [getGraph, effectiveDSL]);
  
  /**
   * Fetch a single item.
   * Uses getGraph() and getDSL() at call time for fresh values in batch operations.
   */
  const fetchItem = useCallback(async (
    item: FetchItem,
    fetchOptions?: FetchOptions
  ): Promise<FetchResult> => {
    // Get fresh graph and DSL at call time (critical for batch operations)
    const currentGraph = getGraph();
    const currentDSL = getDSL();
    
    if (!currentGraph) {
      return { success: false, item, error: new Error('No graph loaded') };
    }
    
    return fetchDataService.fetchItem(
      item,
      fetchOptions,
      currentGraph,
      setGraph,
      currentDSL,
      getGraph // Pass getter for fresh graph after fetch
    );
  }, [getGraph, getDSL, setGraph]);
  
  /**
   * Fetch multiple items with same mode.
   */
  const fetchItems = useCallback(async (
    items: FetchItem[],
    fetchOptions?: FetchOptions & { onProgress?: (current: number, total: number, item: FetchItem) => void }
  ): Promise<FetchResult[]> => {
    const currentGraph = getGraph();
    const currentDSL = getDSL();
    
    if (!currentGraph || items.length === 0) return [];
    
    return fetchDataService.fetchItems(
      items,
      fetchOptions,
      currentGraph,
      setGraph,
      currentDSL,
      getGraph // Pass getter for fresh graph after each fetch
    );
  }, [getGraph, getDSL, setGraph]);
  
  return {
    fetchItem,
    fetchItems,
    getItemsNeedingFetch,
    itemNeedsFetch,
    effectiveDSL,
  };
}

// ============================================================================
// Convenience: Fetch with toast notifications
// ============================================================================

export async function fetchWithToast(
  fetchFn: () => Promise<FetchResult[]>,
  itemCount: number,
  modeLabel?: string
): Promise<FetchResult[]> {
  const label = modeLabel || 'Fetching';
  const progressToastId = toast.loading(`${label} 0/${itemCount}...`, { duration: Infinity });
  
  try {
    const results = await fetchFn();
    
    toast.dismiss(progressToastId);
    
    const successCount = results.filter(r => r.success).length;
    const errorCount = results.filter(r => !r.success).length;
    
    if (successCount > 0) {
      toast.success(
        `✓ ${label.replace('ing', 'ed')} ${successCount} item${successCount > 1 ? 's' : ''}${errorCount > 0 ? `, ${errorCount} failed` : ''}`,
        { duration: 3000 }
      );
    } else if (errorCount > 0) {
      toast.error(`Failed to fetch ${errorCount} item${errorCount > 1 ? 's' : ''}`);
    }
    
    return results;
  } catch (error) {
    toast.dismiss(progressToastId);
    toast.error(`Fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
