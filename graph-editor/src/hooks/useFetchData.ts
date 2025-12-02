/**
 * useFetchData Hook
 * 
 * THE single centralized hook for all data fetch operations.
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
import { dataOperationsService } from '../services/dataOperationsService';
import { calculateIncrementalFetch, parseDate } from '../services/windowAggregationService';
import { fileRegistry } from '../contexts/TabContext';
import type { Graph, DateRange } from '../types';
import toast from 'react-hot-toast';

// ============================================================================
// Types
// ============================================================================

export type FetchMode = 'versioned' | 'direct' | 'from-file';

export interface FetchItem {
  id: string;
  type: 'parameter' | 'case' | 'node';
  name: string;
  objectId: string;
  targetId: string;
  paramSlot?: 'p' | 'cost_gbp' | 'cost_time';
  conditionalIndex?: number;
}

export interface FetchOptions {
  /** Operation mode - defaults to 'versioned' */
  mode?: FetchMode;
  /** Bust cache for this fetch */
  bustCache?: boolean;
  /** For versioned mode with cases: use versionedCase flag */
  versionedCase?: boolean;
  /** Callback to trigger auto-updating animation */
  setAutoUpdating?: (updating: boolean) => void;
}

export interface FetchResult {
  success: boolean;
  item: FetchItem;
  error?: Error;
  /** Details for logging (e.g., "n=100, k=50, p=50%") */
  details?: string;
}

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
// Helper: Normalize window dates
// ============================================================================

function normalizeWindow(window: DateRange): DateRange {
  // Helper: Convert any date format (UK or ISO) to proper ISO format with time suffix
  // CRITICAL: UK dates like "1-Nov-25" must become "2025-11-01T00:00:00Z", not "1-Nov-25T00:00:00Z"
  const toISOWithTime = (dateStr: string, endOfDay: boolean): string => {
    if (dateStr.includes('T')) return dateStr;
    const isoDate = parseDate(dateStr).toISOString().split('T')[0];
    return endOfDay ? `${isoDate}T23:59:59Z` : `${isoDate}T00:00:00Z`;
  };
  
  return {
    start: toISOWithTime(window.start, false),
    end: toISOWithTime(window.end, true),
  };
}

// ============================================================================
// Helper: Get default DSL if none provided
// ============================================================================

export function getDefaultDSL(): string {
  // Default to last 7 days ending yesterday
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);
  
  const sevenDaysAgo = new Date(yesterday);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
  
  const formatDate = (d: Date) => {
    const day = d.getDate();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[d.getMonth()];
    const year = String(d.getFullYear()).slice(-2);
    return `${day}-${month}-${year}`;
  };
  
  return `window(${formatDate(sevenDaysAgo)}:${formatDate(yesterday)})`;
}

// ============================================================================
// Helper: Extract details from param after fetch (for logging)
// ============================================================================

function extractParamDetails(param: any): string {
  if (!param) return '';
  
  const parts: string[] = [];
  const evidence = param.evidence;
  
  if (evidence?.n !== undefined) parts.push(`n=${evidence.n}`);
  if (evidence?.k !== undefined) parts.push(`k=${evidence.k}`);
  if (evidence?.window_from && evidence?.window_to) {
    const from = new Date(evidence.window_from).toISOString().split('T')[0];
    const to = new Date(evidence.window_to).toISOString().split('T')[0];
    parts.push(`window=${from}→${to}`);
  }
  if (evidence?.source) parts.push(`source=${evidence.source}`);
  if (param.mean !== undefined) parts.push(`p=${(param.mean * 100).toFixed(2)}%`);
  
  return parts.length > 0 ? parts.join(', ') : '';
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
    if (!graph) return false;
    
    const normalizedWindow = normalizeWindow(window);
    
    if (item.type === 'parameter') {
      const paramFile = item.objectId ? fileRegistry.getFile(`parameter-${item.objectId}`) : null;
      
      // Check if parameter has connection (file or direct on edge)
      const edge = graph.edges?.find((e: any) => e.uuid === item.targetId || e.id === item.targetId);
      const param = edge?.[item.paramSlot || 'p'];
      const hasConnection = !!paramFile?.data?.connection || !!param?.connection;
      
      if (!hasConnection) return false;
      
      if (!paramFile?.data) {
        // No file exists - assume we need to fetch
        return true;
      }
      
      // File exists - check if data is missing for this window
      const incrementalResult = calculateIncrementalFetch(
        paramFile.data,
        normalizedWindow,
        undefined, // querySignature
        false, // bustCache
        effectiveDSL // targetSlice
      );
      
      return incrementalResult.needsFetch;
    } else if (item.type === 'case') {
      const caseFile = fileRegistry.getFile(`case-${item.objectId}`);
      const node = graph.nodes?.find((n: any) => n.uuid === item.targetId || n.id === item.targetId);
      const hasConnection = !!caseFile?.data?.connection || !!node?.case?.connection;
      
      if (!hasConnection) return false;
      
      // For cases, check if file exists
      return !caseFile?.data;
    }
    
    return false;
  }, [graph, effectiveDSL]);
  
  /**
   * Get all items that need fetching for the current window.
   */
  const getItemsNeedingFetch = useCallback((window: DateRange): FetchItem[] => {
    if (!graph) return [];
    
    const items: FetchItem[] = [];
    
    // Collect parameters
    if (graph.edges) {
      for (const edge of graph.edges) {
        const edgeId = edge.uuid || edge.id || '';
        
        const paramSlots: Array<{ slot: 'p' | 'cost_gbp' | 'cost_time'; param: any }> = [];
        if (edge.p) paramSlots.push({ slot: 'p', param: edge.p });
        if (edge.cost_gbp) paramSlots.push({ slot: 'cost_gbp', param: edge.cost_gbp });
        if (edge.cost_time) paramSlots.push({ slot: 'cost_time', param: edge.cost_time });
        
        for (const { slot, param } of paramSlots) {
          const paramId = param.id;
          
          const item: FetchItem = {
            id: `param-${paramId || 'direct'}-${slot}-${edgeId}`,
            type: 'parameter',
            name: `${slot}: ${paramId || 'direct connection'}`,
            objectId: paramId || '',
            targetId: edgeId,
            paramSlot: slot,
          };
          
          if (itemNeedsFetch(item, window)) {
            items.push(item);
          }
        }
      }
    }
    
    // Collect cases
    if (graph.nodes) {
      for (const node of graph.nodes) {
        if (node.case?.id) {
          const caseId = node.case.id;
          
          const item: FetchItem = {
            id: `case-${caseId}-${node.uuid || node.id}`,
            type: 'case',
            name: `case: ${caseId}`,
            objectId: caseId,
            targetId: node.uuid || node.id || '',
          };
          
          if (itemNeedsFetch(item, window)) {
            items.push(item);
          }
        }
      }
    }
    
    return items;
  }, [graph, itemNeedsFetch]);
  
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
    
    const mode = fetchOptions?.mode || 'versioned';
    
    try {
      let details = '';
      
      if (mode === 'from-file') {
        // ===== FROM FILE: No API call, just load from file =====
        // Window is derived from currentDSL - no separate window param needed
        if (item.type === 'parameter') {
          await dataOperationsService.getParameterFromFile({
            paramId: item.objectId,
            edgeId: item.targetId,
            graph: currentGraph,
            setGraph,
            targetSlice: currentDSL,
            setAutoUpdating: fetchOptions?.setAutoUpdating,
          });
        } else if (item.type === 'case') {
          await dataOperationsService.getCaseFromFile({
            caseId: item.objectId,
            nodeId: item.targetId,
            graph: currentGraph,
            setGraph,
            setAutoUpdating: fetchOptions?.setAutoUpdating,
          });
        } else if (item.type === 'node') {
          await dataOperationsService.getNodeFromFile({
            nodeId: item.objectId,
            graph: currentGraph,
            setGraph,
            targetNodeUuid: item.targetId,
            setAutoUpdating: fetchOptions?.setAutoUpdating,
          });
        }
      } else if (mode === 'direct') {
        // ===== DIRECT: Fetch from source → graph (NO file write, NO aggregation) =====
        // This is the TRUE "direct" path: API response goes straight to graph
        if (item.type === 'node') {
          // Nodes don't have external API sources - fall back to from-file
          await dataOperationsService.getNodeFromFile({
            nodeId: item.objectId,
            graph: currentGraph,
            setGraph,
            targetNodeUuid: item.targetId,
            setAutoUpdating: fetchOptions?.setAutoUpdating,
          });
        } else {
          await dataOperationsService.getFromSourceDirect({
            objectType: item.type,
            objectId: item.objectId,
            targetId: item.targetId,
            graph: currentGraph,
            setGraph,
            paramSlot: item.paramSlot,
            conditionalIndex: item.conditionalIndex,
            writeToFile: false,  // FALSE = direct mode (API → graph, no file roundtrip)
            bustCache: fetchOptions?.bustCache,
            versionedCase: fetchOptions?.versionedCase,
            currentDSL: currentDSL,
            targetSlice: currentDSL,
          });
        }
        
        // Extract details after fetch (re-get graph as it may have been updated)
        const updatedGraph = getGraph();
        if (item.type === 'parameter' && updatedGraph) {
          const edge = updatedGraph.edges?.find((e: any) => e.uuid === item.targetId || e.id === item.targetId);
          const param = edge?.[item.paramSlot || 'p'];
          details = extractParamDetails(param);
        }
      } else {
        // ===== VERSIONED (default): Fetch from source with aggregation =====
        if (item.type === 'node') {
          // Nodes don't have external API sources - fall back to from-file
          await dataOperationsService.getNodeFromFile({
            nodeId: item.objectId,
            graph: currentGraph,
            setGraph,
            targetNodeUuid: item.targetId,
            setAutoUpdating: fetchOptions?.setAutoUpdating,
          });
        } else {
          await dataOperationsService.getFromSource({
            objectType: item.type,
            objectId: item.objectId,
            targetId: item.targetId,
            graph: currentGraph,
            setGraph,
            paramSlot: item.paramSlot,
            conditionalIndex: item.conditionalIndex,
            bustCache: fetchOptions?.bustCache,
            currentDSL: currentDSL,
            targetSlice: currentDSL,
          });
        }
        
        // Extract details after fetch (re-get graph as it may have been updated)
        const updatedGraphVersioned = getGraph();
        if (item.type === 'parameter' && updatedGraphVersioned) {
          const edge = updatedGraphVersioned.edges?.find((e: any) => e.uuid === item.targetId || e.id === item.targetId);
          const param = edge?.[item.paramSlot || 'p'];
          details = extractParamDetails(param);
        }
      }
      
      return { success: true, item, details };
    } catch (error) {
      console.error(`[useFetchData] Failed to fetch ${item.name} (mode=${mode}):`, error);
      return { 
        success: false, 
        item, 
        error: error instanceof Error ? error : new Error(String(error)) 
      };
    }
  }, [getGraph, getDSL, setGraph]);
  
  /**
   * Fetch multiple items with same mode.
   */
  const fetchItems = useCallback(async (
    items: FetchItem[],
    fetchOptions?: FetchOptions & { onProgress?: (current: number, total: number, item: FetchItem) => void }
  ): Promise<FetchResult[]> => {
    const currentGraph = getGraph();
    if (!currentGraph || items.length === 0) return [];
    
    const results: FetchResult[] = [];
    const { onProgress, ...itemOptions } = fetchOptions || {};
    
    for (let i = 0; i < items.length; i++) {
      onProgress?.(i + 1, items.length, items[i]);
      
      const result = await fetchItem(items[i], itemOptions);
      results.push(result);
    }
    
    return results;
  }, [getGraph, fetchItem]);
  
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

// ============================================================================
// Convenience: Create FetchItem from edge/param info
// ============================================================================

export function createFetchItem(
  type: 'parameter' | 'case' | 'node',
  objectId: string,
  targetId: string,
  options?: {
    paramSlot?: 'p' | 'cost_gbp' | 'cost_time';
    conditionalIndex?: number;
    name?: string;
  }
): FetchItem {
  const slot = options?.paramSlot || 'p';
  return {
    id: `${type}-${objectId || 'direct'}-${slot}-${targetId}`,
    type,
    name: options?.name || `${type}: ${objectId || 'direct'}`,
    objectId,
    targetId,
    paramSlot: options?.paramSlot,
    conditionalIndex: options?.conditionalIndex,
  };
}
