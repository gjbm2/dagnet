/**
 * Fetch Data Service
 * 
 * Core fetch and cache-checking logic extracted from useFetchData hook.
 * This service can be called from both React hooks and non-React contexts
 * (e.g., ScenariosContext callbacks).
 * 
 * SINGLE CODE PATH PRINCIPLE:
 * - useFetchData hook → this service → dataOperationsService
 * - ScenariosContext  → this service → dataOperationsService
 * 
 * This ensures identical behaviour regardless of call site.
 */

import { dataOperationsService } from './dataOperationsService';
import { calculateIncrementalFetch, parseDate } from './windowAggregationService';
import { fileRegistry } from '../contexts/TabContext';
import { parseConstraints } from '../lib/queryDSL';
import { resolveRelativeDate } from '../lib/dateFormat';
import type { Graph, DateRange } from '../types';

// ============================================================================
// Types (re-exported for consumers)
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

export interface CacheCheckResult {
  needsFetch: boolean;
  items: FetchItem[];
}

export interface MultiCacheCheckResult {
  dsl: string;
  needsFetch: boolean;
  items: FetchItem[];
}

// ============================================================================
// Helper: Normalize window dates
// ============================================================================

export function normalizeWindow(window: DateRange): DateRange {
  // Helper: Convert any date format (UK or ISO) to proper ISO format with time suffix
  // CRITICAL: UK dates like "1-Nov-25" must become "2025-11-01T00:00:00Z", not "1-Nov-25T00:00:00Z"
  const toISOWithTime = (dateStr: string, endOfDay: boolean): string => {
    if (dateStr.includes('T')) return dateStr;
    // Resolve relative dates first
    const resolvedDate = resolveRelativeDate(dateStr);
    const isoDate = parseDate(resolvedDate).toISOString().split('T')[0];
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

export function extractParamDetails(param: any): string {
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
// Helper: Extract window from DSL
// ============================================================================

/**
 * Get today's date in UK format (d-MMM-yy).
 * Used as default for open-ended window DSLs like window(-10d:).
 */
function getTodayUK(): string {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const day = now.getDate();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[now.getMonth()];
  const year = now.getFullYear().toString().slice(-2);
  return `${day}-${month}-${year}`;
}

export function extractWindowFromDSL(dsl: string): DateRange | null {
  try {
    const constraints = parseConstraints(dsl);
    // Handle open-ended windows like window(-10d:) where end is undefined or empty
    // In this case, default to "today" for the end date (matching resolveWindowDates behavior)
    if (constraints.window && constraints.window.start) {
      // Resolve any relative dates to actual dates
      const start = resolveRelativeDate(constraints.window.start);
      // If end is undefined/empty, default to today
      const end = constraints.window.end 
        ? resolveRelativeDate(constraints.window.end)
        : getTodayUK();
      return { start, end };
    }
  } catch (e) {
    console.warn('[fetchDataService] Failed to parse DSL for window:', e);
  }
  return null;
}

// ============================================================================
// Core: Check if a specific item needs fetching
// ============================================================================

/**
 * Check if a specific item needs fetching for the given window.
 * 
 * @param item - The fetch item to check
 * @param window - The date range to check coverage for
 * @param graph - The current graph
 * @param dsl - The target DSL (for slice matching)
 * @returns true if the item needs to be fetched from source
 */
export function itemNeedsFetch(
  item: FetchItem,
  window: DateRange,
  graph: Graph,
  dsl: string,
  checkCache: boolean = true
): boolean {
  if (!graph) return false;
  
  const normalizedWindow = normalizeWindow(window);
  
  if (item.type === 'parameter') {
    const paramFile = item.objectId ? fileRegistry.getFile(`parameter-${item.objectId}`) : null;
    
    // Check if parameter has connection (file or direct on edge)
    const edge = graph.edges?.find((e: any) => e.uuid === item.targetId || e.id === item.targetId);
    const param = edge?.[item.paramSlot || 'p'];
    const hasConnection = !!paramFile?.data?.connection || !!param?.connection;
    
    if (!hasConnection) return false;
    
    // If we're not checking cache, we just wanted to know if it's connectable
    if (!checkCache) return true;
    
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
      dsl // targetSlice
    );
    
    return incrementalResult.needsFetch;
  } else if (item.type === 'case') {
    const caseFile = fileRegistry.getFile(`case-${item.objectId}`);
    const node = graph.nodes?.find((n: any) => n.uuid === item.targetId || n.id === item.targetId);
    const hasConnection = !!caseFile?.data?.connection || !!node?.case?.connection;
    
    if (!hasConnection) return false;
    
    if (!checkCache) return true;
    
    // For cases, check if file exists
    return !caseFile?.data;
  }
  
  return false;
}

// ============================================================================
// Core: Get all items that need fetching
// ============================================================================

/**
 * Get all items that need fetching for the given window.
 * 
 * @param window - The date range to check coverage for
 * @param graph - The current graph
 * @param dsl - The target DSL (for slice matching)
 * @param checkCache - Whether to check cache status (default: true). If false, returns all connectable items.
 * @returns Array of FetchItem objects that need fetching
 */
export function getItemsNeedingFetch(
  window: DateRange,
  graph: Graph,
  dsl: string,
  checkCache: boolean = true
): FetchItem[] {
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
        
        if (itemNeedsFetch(item, window, graph, dsl, checkCache)) {
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
        
        if (itemNeedsFetch(item, window, graph, dsl, checkCache)) {
          items.push(item);
        }
      }
    }
  }
  
  return items;
}

// ============================================================================
// Core: Fetch a single item
// ============================================================================

/**
 * Fetch a single item from source or file.
 * 
 * @param item - The item to fetch
 * @param options - Fetch options (mode, bustCache, etc.)
 * @param graph - The current graph
 * @param setGraph - Graph setter for updating state
 * @param dsl - The DSL to use for fetching
 * @param getUpdatedGraph - Optional getter for fresh graph after fetch (for details extraction)
 * @returns FetchResult with success status and details
 */
export async function fetchItem(
  item: FetchItem,
  options: FetchOptions | undefined,
  graph: Graph,
  setGraph: (g: Graph | null) => void,
  dsl: string,
  getUpdatedGraph?: () => Graph | null
): Promise<FetchResult> {
  if (!graph) {
    return { success: false, item, error: new Error('No graph loaded') };
  }
  
  const mode = options?.mode || 'versioned';
  
  try {
    let details = '';
    
    if (mode === 'from-file') {
      // ===== FROM FILE: No API call, just load from file =====
      if (item.type === 'parameter') {
        await dataOperationsService.getParameterFromFile({
          paramId: item.objectId,
          edgeId: item.targetId,
          graph: graph,
          setGraph,
          targetSlice: dsl,
          setAutoUpdating: options?.setAutoUpdating,
          conditionalIndex: item.conditionalIndex, // For conditional_p entries
        });
      } else if (item.type === 'case') {
        await dataOperationsService.getCaseFromFile({
          caseId: item.objectId,
          nodeId: item.targetId,
          graph: graph,
          setGraph,
          setAutoUpdating: options?.setAutoUpdating,
        });
      } else if (item.type === 'node') {
        await dataOperationsService.getNodeFromFile({
          nodeId: item.objectId,
          graph: graph,
          setGraph,
          targetNodeUuid: item.targetId,
          setAutoUpdating: options?.setAutoUpdating,
        });
      }
    } else if (mode === 'direct') {
      // ===== DIRECT: Fetch from source → graph (NO file write, NO aggregation) =====
      if (item.type === 'node') {
        // Nodes don't have external API sources - fall back to from-file
        await dataOperationsService.getNodeFromFile({
          nodeId: item.objectId,
          graph: graph,
          setGraph,
          targetNodeUuid: item.targetId,
          setAutoUpdating: options?.setAutoUpdating,
        });
      } else {
        await dataOperationsService.getFromSourceDirect({
          objectType: item.type,
          objectId: item.objectId,
          targetId: item.targetId,
          graph: graph,
          setGraph,
          paramSlot: item.paramSlot,
          conditionalIndex: item.conditionalIndex,
          writeToFile: false,  // FALSE = direct mode (API → graph, no file roundtrip)
          bustCache: options?.bustCache,
          versionedCase: options?.versionedCase,
          currentDSL: dsl,
          targetSlice: dsl,
        });
      }
      
      // Extract details after fetch
      const updatedGraph = getUpdatedGraph?.() ?? graph;
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
          graph: graph,
          setGraph,
          targetNodeUuid: item.targetId,
          setAutoUpdating: options?.setAutoUpdating,
        });
      } else {
        await dataOperationsService.getFromSource({
          objectType: item.type,
          objectId: item.objectId,
          targetId: item.targetId,
          graph: graph,
          setGraph,
          paramSlot: item.paramSlot,
          conditionalIndex: item.conditionalIndex,
          bustCache: options?.bustCache,
          currentDSL: dsl,
          targetSlice: dsl,
        });
      }
      
      // Extract details after fetch
      const updatedGraphVersioned = getUpdatedGraph?.() ?? graph;
      if (item.type === 'parameter' && updatedGraphVersioned) {
        const edge = updatedGraphVersioned.edges?.find((e: any) => e.uuid === item.targetId || e.id === item.targetId);
        const param = edge?.[item.paramSlot || 'p'];
        details = extractParamDetails(param);
      }
    }
    
    return { success: true, item, details };
  } catch (error) {
    console.error(`[fetchDataService] Failed to fetch ${item.name} (mode=${mode}):`, error);
    return { 
      success: false, 
      item, 
      error: error instanceof Error ? error : new Error(String(error)) 
    };
  }
}

// ============================================================================
// Core: Fetch multiple items
// ============================================================================

/**
 * Fetch multiple items sequentially.
 * 
 * @param items - Array of items to fetch
 * @param options - Fetch options including optional progress callback
 * @param graph - The current graph
 * @param setGraph - Graph setter for updating state
 * @param dsl - The DSL to use for fetching
 * @param getUpdatedGraph - Optional getter for fresh graph after each fetch
 * @returns Array of FetchResult objects
 */
export async function fetchItems(
  items: FetchItem[],
  options: FetchOptions & { onProgress?: (current: number, total: number, item: FetchItem) => void } | undefined,
  graph: Graph,
  setGraph: (g: Graph | null) => void,
  dsl: string,
  getUpdatedGraph?: () => Graph | null
): Promise<FetchResult[]> {
  if (!graph || items.length === 0) return [];
  
  const results: FetchResult[] = [];
  const { onProgress, ...itemOptions } = options || {};
  
  for (let i = 0; i < items.length; i++) {
    onProgress?.(i + 1, items.length, items[i]);
    
    // CRITICAL: Use getUpdatedGraph() to get fresh graph for each item
    // This ensures rebalancing from previous items is preserved
    // Without this, each item clones the ORIGINAL graph, losing sibling rebalancing
    const currentGraph = getUpdatedGraph?.() ?? graph;
    
    const result = await fetchItem(items[i], itemOptions, currentGraph, setGraph, dsl, getUpdatedGraph);
    results.push(result);
  }
  
  return results;
}

// ============================================================================
// Convenience: Check if DSL needs fetch
// ============================================================================

/**
 * Check if a DSL needs fetching (any items not in cache).
 * 
 * @param dsl - The DSL to check
 * @param graph - The current graph
 * @returns CacheCheckResult with needsFetch flag and items needing fetch
 */
export function checkDSLNeedsFetch(dsl: string, graph: Graph): CacheCheckResult {
  if (!graph) {
    return { needsFetch: false, items: [] };
  }
  
  // Extract window from DSL
  const window = extractWindowFromDSL(dsl);
  if (!window) {
    // No window in DSL - can't check cache, assume no fetch needed
    // (This handles pure what-if DSLs like "case(my-case:treatment)")
    return { needsFetch: false, items: [] };
  }
  
  const items = getItemsNeedingFetch(window, graph, dsl);
  
  return {
    needsFetch: items.length > 0,
    items,
  };
}

// ============================================================================
// Convenience: Check multiple DSLs for cache status
// ============================================================================

/**
 * Check multiple DSLs for cache status.
 * Useful for bulk scenario creation to show which scenarios need fetch.
 * 
 * @param dsls - Array of DSL strings to check
 * @param graph - The current graph
 * @returns Array of MultiCacheCheckResult objects in same order as input
 */
export function checkMultipleDSLsNeedFetch(dsls: string[], graph: Graph): MultiCacheCheckResult[] {
  return dsls.map(dsl => {
    const result = checkDSLNeedsFetch(dsl, graph);
    return {
      dsl,
      needsFetch: result.needsFetch,
      items: result.items,
    };
  });
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

// ============================================================================
// Export as service object for named import
// ============================================================================

export const fetchDataService = {
  // Core functions
  itemNeedsFetch,
  getItemsNeedingFetch,
  fetchItem,
  fetchItems,
  
  // Cache checking
  checkDSLNeedsFetch,
  checkMultipleDSLsNeedFetch,
  
  // Helpers
  normalizeWindow,
  getDefaultDSL,
  extractParamDetails,
  extractWindowFromDSL,
  createFetchItem,
};

