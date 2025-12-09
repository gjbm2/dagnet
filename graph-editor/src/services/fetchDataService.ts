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

import { dataOperationsService, setBatchMode } from './dataOperationsService';
import { calculateIncrementalFetch, hasFullSliceCoverageByHeader, parseDate } from './windowAggregationService';
import { fileRegistry } from '../contexts/TabContext';
import { parseConstraints } from '../lib/queryDSL';
import { resolveRelativeDate } from '../lib/dateFormat';
import type { Graph, DateRange } from '../types';
import { showProgressToast, completeProgressToast } from '../components/ProgressToast';
import { sessionLogService } from './sessionLogService';
import { 
  getEdgesInTopologicalOrder, 
  getActiveEdges, 
  computePathT95, 
  applyPathT95ToGraph,
  type GraphForPath 
} from './statisticalEnhancementService';

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
  paramSlot?: 'p' | 'cost_gbp' | 'labour_cost';
  conditionalIndex?: number;
  /** Optional: Bounded window for cohort queries, calculated by Planner */
  boundedCohortWindow?: DateRange;
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
  /** Parent log ID for session log hierarchy linkage */
  parentLogId?: string;
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
 * @returns true if the item needs to be fetched (from source OR from file)
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
    const hasFileData = !!paramFile?.data;
    
    // If no connection AND no file data, nothing to fetch from
    if (!hasConnection && !hasFileData) return false;
    
    // If we're not checking cache, we just wanted to know if it's fetchable
    if (!checkCache) return true;
    
    // If we have file data but no connection, this is a file-only parameter:
    // we can read from cache but there is no external source to fetch from.
    if (hasFileData && !hasConnection) {
      return false;
    }
    
    if (!hasFileData) {
      // No file exists but has connection - need to fetch from source
      return true;
    }
    
    // File exists - check if this window has been previously fetched for this slice family
    // Auto-fetch behaviour contract:
    // - If the requested window is fully covered by slice headers for this family,
    //   we consider it "previously fetched" and DO NOT require a new fetch.
    // - If any part of the window lies outside all matching slice headers,
    //   we require an explicit fetch from source.
    const hasFullCoverage = hasFullSliceCoverageByHeader(
      paramFile.data,
      normalizedWindow,
      dsl // targetSlice
    );

    return !hasFullCoverage;
  } else if (item.type === 'case') {
    const caseFile = fileRegistry.getFile(`case-${item.objectId}`);
    const node = graph.nodes?.find((n: any) => n.uuid === item.targetId || n.id === item.targetId);
    const hasConnection = !!caseFile?.data?.connection || !!node?.case?.connection;
    const hasFileData = !!caseFile?.data;
    
    // If no connection AND no file data, nothing to fetch from
    if (!hasConnection && !hasFileData) return false;
    
    if (!checkCache) return true;
    
    // For cases, check if file exists with data
    return !hasFileData;
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
      
      const paramSlots: Array<{ slot: 'p' | 'cost_gbp' | 'labour_cost'; param: any }> = [];
      if (edge.p) paramSlots.push({ slot: 'p', param: edge.p });
      if (edge.cost_gbp) paramSlots.push({ slot: 'cost_gbp', param: edge.cost_gbp });
      if (edge.labour_cost) paramSlots.push({ slot: 'labour_cost', param: edge.labour_cost });
      
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
  
  // Sort items in topological order (upstream edges first) for LAG calculation
  // This ensures that when batch fetching latency edges, upstream t95 values
  // are computed before they're needed for downstream path_t95 calculations.
  // See design.md §4.7.2.
  const sortedItems = sortFetchItemsTopologically(items, graph);
  
  return sortedItems;
}

/**
 * Sort fetch items in topological order.
 * 
 * For latency calculations, we need upstream edges fetched before downstream
 * edges so that t95 values are available for path_t95 computation.
 * 
 * Non-edge items (cases) are placed at the end since they don't affect edge ordering.
 * 
 * @param items - Unsorted fetch items
 * @param graph - The graph for topology information
 * @returns Items sorted in topological order (upstream first)
 */
function sortFetchItemsTopologically(items: FetchItem[], graph: Graph): FetchItem[] {
  if (!graph.edges || items.length <= 1) return items;

  // Build map of targetId (edgeId) -> FetchItem for quick lookup
  const edgeItems = new Map<string, FetchItem>();
  const nonEdgeItems: FetchItem[] = [];

  for (const item of items) {
    if (item.type === 'parameter' && item.targetId) {
      // Multiple items might share the same targetId (p, cost_gbp, labour_cost on same edge)
      // Store all of them
      const existingItems = edgeItems.get(item.targetId);
      if (existingItems) {
        // Handle multiple items per edge - create array
        const arr = Array.isArray(existingItems) ? existingItems : [existingItems];
        arr.push(item);
        edgeItems.set(item.targetId, arr as any);
      } else {
        edgeItems.set(item.targetId, item);
      }
    } else {
      nonEdgeItems.push(item);
    }
  }

  // If no edge items, return as-is
  if (edgeItems.size === 0) return items;

  // Check if edges have topology data (from/to fields)
  const hasTopologyData = graph.edges.some(e => e.from && e.to);
  if (!hasTopologyData) {
    // No topology data - return items in original order
    // This handles mock/test graphs without from/to fields
    return items;
  }

  try {
    // Get edges in topological order
    const graphForPath: GraphForPath = {
      nodes: graph.nodes?.map(n => ({ id: n.uuid || n.id || '', type: n.type })) || [],
      edges: graph.edges?.filter(e => e.from && e.to).map(e => ({
        id: e.id,
        uuid: e.uuid,
        from: e.from,
        to: e.to,
        p: e.p,
      })) || [],
    };

    // If no edges with topology, return original order
    if (graphForPath.edges.length === 0) {
      return items;
    }

    // Use all edges as active for topological ordering
    // (We want to maintain consistent order regardless of scenario)
    const allEdgeIds = new Set(graphForPath.edges.map(e => e.uuid || e.id || `${e.from}->${e.to}`));
    const sortedEdges = getEdgesInTopologicalOrder(graphForPath, allEdgeIds);

    // Build sorted items list following topological order
    const sortedItems: FetchItem[] = [];
    const addedIds = new Set<string>();

    for (const edge of sortedEdges) {
      const edgeId = edge.uuid || edge.id || '';
      const itemOrItems = edgeItems.get(edgeId);
      if (itemOrItems) {
        // Handle both single item and array of items
        const itemsArray = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems];
        for (const item of itemsArray) {
          if (!addedIds.has(item.id)) {
            sortedItems.push(item);
            addedIds.add(item.id);
          }
        }
      }
    }

    // Add any edge items not in topological sort (disconnected edges)
    for (const [_, itemOrItems] of edgeItems) {
      const itemsArray = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems];
      for (const item of itemsArray) {
        if (!addedIds.has(item.id)) {
          sortedItems.push(item);
          addedIds.add(item.id);
        }
      }
    }

    // Add non-edge items at the end
    sortedItems.push(...nonEdgeItems);

    return sortedItems;
  } catch (error) {
    // If topological sort fails, fall back to original order
    console.warn('[fetchDataService] Topological sort failed, using original order:', error);
    return items;
  }
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
        const result = await dataOperationsService.getParameterFromFile({
          paramId: item.objectId,
          edgeId: item.targetId,
          graph: graph,
          setGraph,
          targetSlice: dsl,
          setAutoUpdating: options?.setAutoUpdating,
          conditionalIndex: item.conditionalIndex, // For conditional_p entries
        });
        // If getParameterFromFile returned a failure or warning, propagate it
        if (!result.success) {
          return { success: false, item, error: new Error(result.warning || 'Operation failed') };
        }
        if (result.warning) {
          // Aggregation fallback - treat as partial success for batch counting
          details = `(warning: ${result.warning})`;
        }
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
          // Pass through any bounded cohort window calculated by the planner
          boundedCohortWindow: item.boundedCohortWindow,
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
          // Pass through any bounded cohort window calculated by the planner
          boundedCohortWindow: item.boundedCohortWindow,
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
// Path T95 Computation
// ============================================================================

/**
 * Compute and apply path_t95 to the graph.
 * 
 * path_t95 is the cumulative latency from the anchor (start node) to each edge,
 * computed by summing t95 values along the path. This is used by the planner to
 * bound cohort retrieval horizons for downstream edges.
 * 
 * This function is called after batch fetches complete, when all edge t95 values
 * have been updated. The computed path_t95 values are transient (not persisted)
 * and are recomputed whenever the scenario or graph topology changes.
 * 
 * @param graph - The graph with updated t95 values on edges
 * @param setGraph - Graph setter to apply the updated path_t95 values
 * @param logOpId - Optional parent log operation ID for session logging
 */
export function computeAndApplyPathT95(
  graph: Graph,
  setGraph: (g: Graph | null) => void,
  logOpId?: string
): void {
  if (!graph?.edges?.length) return;
  
  // Build GraphForPath representation
  const graphForPath: GraphForPath = {
    nodes: (graph.nodes || []).map(n => ({
      id: n.id || n.uuid || '',
      type: n.type,
    })),
    edges: (graph.edges || []).map(e => ({
      id: e.id,
      uuid: e.uuid,
      from: e.from,
      to: e.to,
      p: e.p ? {
        latency: e.p.latency ? {
          maturity_days: e.p.latency.maturity_days,
          t95: e.p.latency.t95,
          path_t95: e.p.latency.path_t95,
        } : undefined,
        mean: e.p.mean,
      } : undefined,
    })),
  };
  
  // Get active edges (edges with non-zero probability)
  const activeEdges = getActiveEdges(graphForPath);
  
  if (activeEdges.size === 0) {
    console.log('[fetchDataService] No active edges for path_t95 computation');
    return;
  }
  
  // Compute path_t95 for all active edges
  const pathT95Map = computePathT95(graphForPath, activeEdges);
  
  if (pathT95Map.size === 0) {
    console.log('[fetchDataService] path_t95 computation returned empty map');
    return;
  }
  
  // Apply to in-memory graph (clone to trigger React update)
  const updatedGraph = { ...graph };
  updatedGraph.edges = graph.edges.map(edge => {
    const edgeId = edge.uuid || edge.id || `${edge.from}->${edge.to}`;
    const pathT95 = pathT95Map.get(edgeId);
    
    if (pathT95 !== undefined && edge.p?.latency) {
      return {
        ...edge,
        p: {
          ...edge.p,
          latency: {
            ...edge.p.latency,
            path_t95: pathT95,
          },
        },
      };
    }
    return edge;
  });
  
  setGraph(updatedGraph);
  
  // Log summary
  const edgesWithPathT95 = Array.from(pathT95Map.entries()).filter(([_, v]) => v > 0);
  console.log(`[fetchDataService] Computed path_t95 for ${edgesWithPathT95.length} edges:`, 
    Object.fromEntries(edgesWithPathT95.slice(0, 5)));
  
  if (logOpId) {
    sessionLogService.addChild(logOpId, 'info', 'PATH_T95_COMPUTED',
      `Computed path_t95 for ${edgesWithPathT95.length} edges`,
      undefined,
      { edgeCount: edgesWithPathT95.length, sample: Object.fromEntries(edgesWithPathT95.slice(0, 3)) }
    );
  }
}

// ============================================================================
// Core: Fetch multiple items
// ============================================================================

/**
 * Fetch multiple items sequentially.
 * 
 * After all items are fetched, computes path_t95 for the graph so that
 * downstream latency-aware decisions (e.g., cohort retrieval horizons)
 * can use cumulative lag information.
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
  
  const batchStart = performance.now();
  const results: FetchResult[] = [];
  const { onProgress, ...itemOptions } = options || {};
  
  // For multiple items: use batch mode with visual progress toast
  const shouldUseBatchMode = items.length > 1;
  const progressToastId = 'batch-fetch-progress';
  
  // SESSION LOG: Start batch fetch operation (only for batch mode)
  // If parentLogId is provided, add children to that instead of creating new operation
  const useParentLog = !!itemOptions?.parentLogId;
  const batchLogId = useParentLog
    ? itemOptions.parentLogId
    : shouldUseBatchMode 
      ? sessionLogService.startOperation('info', 'data-fetch', 'BATCH_FETCH',
          `Batch fetch: ${items.length} items`,
          { dsl, itemCount: items.length, mode: itemOptions?.mode || 'versioned' })
      : undefined;
  
  if (shouldUseBatchMode) {
    setBatchMode(true);
    // Show initial progress toast with visual bar
    showProgressToast(progressToastId, 0, items.length, 'Fetching');
  }
  
  let successCount = 0;
  let errorCount = 0;
  
  try {
    for (let i = 0; i < items.length; i++) {
      onProgress?.(i + 1, items.length, items[i]);
      
      // Update progress toast with visual bar
      if (shouldUseBatchMode) {
        showProgressToast(progressToastId, i, items.length, 'Fetching');
      }
      
      // CRITICAL: Use getUpdatedGraph() to get fresh graph for each item
      // This ensures rebalancing from previous items is preserved
      // Without this, each item clones the ORIGINAL graph, losing sibling rebalancing
      const currentGraph = getUpdatedGraph?.() ?? graph;
      
      const result = await fetchItem(items[i], itemOptions, currentGraph, setGraph, dsl, getUpdatedGraph);
      results.push(result);
      
      if (result.success) {
        successCount++;
      } else {
        errorCount++;
      }
    }
    
    // Show completion toast
    if (shouldUseBatchMode) {
      // Show full bar briefly before completion message
      showProgressToast(progressToastId, items.length, items.length, 'Fetching');
      
      // Small delay to show completed bar, then show final message
      setTimeout(() => {
        if (errorCount > 0) {
          completeProgressToast(progressToastId, `Fetched ${successCount}/${items.length} (${errorCount} failed)`, true);
        } else {
          completeProgressToast(progressToastId, `Fetched ${successCount} item${successCount !== 1 ? 's' : ''}`, false);
        }
      }, 300);
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // PATH_T95 COMPUTATION (Phase 1 of retrieval-date-logic implementation)
    // 
    // After all items are fetched and their t95 values updated on the graph,
    // compute path_t95 (cumulative latency from anchor) for each edge.
    // This enables the planner to bound cohort retrieval horizons using
    // cumulative lag rather than just edge-local t95.
    // 
    // path_t95 is transient (not persisted) - it's recomputed whenever
    // the scenario or graph topology changes.
    // ═══════════════════════════════════════════════════════════════════════
    if (successCount > 0) {
      const finalGraph = getUpdatedGraph?.() ?? graph;
      if (finalGraph) {
        // Check if any fetched items were parameters on latency edges
        const hasLatencyItems = items.some(item => {
          if (item.type !== 'parameter') return false;
          const edge = finalGraph.edges?.find((e: any) => 
            (e.uuid || e.id) === item.targetId
          );
          return edge?.p?.latency?.maturity_days || edge?.p?.latency?.t95;
        });
        
        if (hasLatencyItems) {
          computeAndApplyPathT95(finalGraph, setGraph, batchLogId);
        }
      }
    }
  } finally {
    // Always reset batch mode
    if (shouldUseBatchMode) {
      setBatchMode(false);
    }
    
    // Log batch timing
    const batchTime = performance.now() - batchStart;
    const avgTime = items.length > 0 ? batchTime / items.length : 0;
    console.log(`[TIMING] fetchItems batch: ${batchTime.toFixed(1)}ms total, ${avgTime.toFixed(1)}ms avg per item (${items.length} items)`);
    
    // SESSION LOG: End batch fetch operation with summary
    // If using parent log, add summary as child instead of ending operation
    if (batchLogId) {
      // Build summary of what was fetched
      const successItems = results.filter(r => r.success);
      const failedItems = results.filter(r => !r.success);
      
      // Group successful items by type for summary
      const byType: Record<string, string[]> = {};
      for (const r of successItems) {
        const type = r.item.type;
        if (!byType[type]) byType[type] = [];
        byType[type].push(r.item.name);
      }
      
      // Build details string
      const typeSummaries = Object.entries(byType)
        .map(([type, names]) => `${type}s: ${names.length}`)
        .join(', ');
      
      const detailLines: string[] = [];
      if (successItems.length > 0) {
        detailLines.push(`✓ Updated: ${successItems.map(r => r.item.name).join(', ')}`);
        // Add result details if available
        for (const r of successItems) {
          if (r.details) {
            detailLines.push(`  ${r.item.name}: ${r.details}`);
          }
        }
      }
      if (failedItems.length > 0) {
        detailLines.push(`✗ Failed: ${failedItems.map(r => `${r.item.name}${r.error ? ` (${r.error.message})` : ''}`).join(', ')}`);
      }
      
      const status = errorCount > 0 ? (successCount > 0 ? 'warning' : 'error') : 'success';
      const summary = errorCount > 0 
        ? `${successCount}/${items.length} succeeded, ${errorCount} failed` 
        : `${successCount} item${successCount !== 1 ? 's' : ''} updated`;
      
      if (useParentLog) {
        // Add summary as child entry - parent will end operation
        sessionLogService.addChild(batchLogId, status, 'FETCH_COMPLETE', summary, 
          detailLines.join('\n'),
          {
            successCount,
            errorCount,
            itemCount: items.length,
            duration: Math.round(batchTime),
            byType,
          }
        );
      } else {
        // End our own operation
        sessionLogService.endOperation(batchLogId, status, summary, 
          {
            successCount,
            errorCount,
            itemCount: items.length,
            duration: Math.round(batchTime),
            byType,
            details: detailLines.join('\n'),
          }
        );
      }
    }
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
    paramSlot?: 'p' | 'cost_gbp' | 'labour_cost';
    conditionalIndex?: number;
    name?: string;
    boundedCohortWindow?: DateRange;
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
    boundedCohortWindow: options?.boundedCohortWindow,
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

