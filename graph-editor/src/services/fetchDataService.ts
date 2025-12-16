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
import { 
  calculateIncrementalFetch, 
  hasFullSliceCoverageByHeader, 
  parseDate,
  aggregateCohortData,
  aggregateWindowData,
  aggregateLatencyStats,
} from './windowAggregationService';
import { isolateSlice, extractSliceDimensions } from './sliceIsolation';
import { fileRegistry } from '../contexts/TabContext';
import { parseConstraints } from '../lib/queryDSL';
import { resolveRelativeDate } from '../lib/dateFormat';
import type { Graph, DateRange } from '../types';
import type { GetFromFileCopyOptions } from './dataOperationsService';
import { showProgressToast, completeProgressToast } from '../components/ProgressToast';
import { sessionLogService } from './sessionLogService';
import { 
  getEdgesInTopologicalOrder, 
  getActiveEdges, 
  computePathT95, 
  applyPathT95ToGraph,
  computeInboundN,
  applyInboundNToGraph,
  enhanceGraphLatencies,
  type GraphForPath,
  type GraphForInboundN,
  type LAGHelpers,
  type ParameterValueForLAG,
} from './statisticalEnhancementService';
import { computeEffectiveEdgeProbability, type WhatIfOverrides } from '../lib/whatIf';
import { UpdateManager } from './UpdateManager';
import { LATENCY_HORIZON_DECIMAL_PLACES } from '../constants/latency';
import { roundToDecimalPlaces } from '../utils/rounding';

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
  /**
   * Optional: Override the target slice DSL for this item.
   *
   * Used for cohort-mode tabs to avoid forcing cohort-shaped retrieval on
   * "simple" edges (no local latency AND not behind any lagged path).
   */
  targetSliceOverride?: string;
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

  /**
   * When mode === 'from-file' and item.type === 'parameter', controls whether permission flags
   * (`*_overridden`) are copied from file → graph.
   *
   * Default: false (do not mutate graph permissions as a side-effect of reads).
   */
  includePermissions?: boolean;

  /**
   * When mode === 'from-file' and item.type === 'parameter', controls what is copied from file → graph.
   * If provided, this supersedes `includePermissions`.
   */
  copyOptions?: GetFromFileCopyOptions;
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
// Cohort-mode per-item targeting (cohort-view-implementation.md)
// ============================================================================

function stripCohortClause(dsl: string): string {
  // Remove a single cohort(...) clause from a semicolon-separated DSL string.
  const without = dsl.replace(/(^|;)\s*cohort\([^;]*\)\s*(;|$)/, (m, p1, p2) => (p1 && p2 ? ';' : ''));
  return without
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .join(';');
}

function buildWindowClauseFromCohort(dsl: string): string | null {
  try {
    const parsed: any = parseConstraints(dsl);
    const start = parsed?.cohort?.start;
    const end = parsed?.cohort?.end;
    if (!start || !end) return null;
    return `window(${start}:${end})`;
  } catch {
    return null;
  }
}

function computePathT95MapForGraph(graph: Graph): Map<string, number> {
  const graphForPath: GraphForPath = {
    nodes: (graph.nodes || []).map((n: any) => ({
      id: n.id || n.uuid || '',
      type: n.type || (n.entry?.is_start ? 'start' : undefined),
      entry: n.entry,
    })),
    edges: (graph.edges || [])
      .filter((e: any) => e.from && e.to)
      .map((e: any) => ({
        id: e.id,
        uuid: e.uuid,
        from: e.from,
        to: e.to,
        p: e.p,
      })),
  };

  if (graphForPath.edges.length === 0) return new Map<string, number>();

  const active = getActiveEdges(graphForPath);
  if (active.size === 0) return new Map<string, number>();
  return computePathT95(graphForPath, active);
}

function computeTargetSliceOverrideForItem(
  item: FetchItem,
  graph: Graph,
  dsl: string,
  pathT95Map: Map<string, number>
): string | undefined {
  if (!dsl.includes('cohort(')) return undefined;
  if (item.type !== 'parameter') return undefined;

  const edge = graph.edges?.find((e: any) => e.uuid === item.targetId || e.id === item.targetId);
  if (!edge) return undefined;

  const latency = edge?.p?.latency;
  const hasLocalLatency = latency?.latency_parameter === true || !!latency?.t95;

  const edgeId = edge.uuid || edge.id || `${edge.from}->${edge.to}`;
  const computedPathT95 = pathT95Map.get(edgeId);
  const persistedPathT95 = latency?.path_t95;
  const pathT95 = (computedPathT95 ?? persistedPathT95 ?? 0);
  const isBehindLaggedPath = pathT95 > 0;

  if (hasLocalLatency || isBehindLaggedPath) return undefined;

  const windowClause = buildWindowClauseFromCohort(dsl);
  if (!windowClause) return undefined;

  const withoutCohort = stripCohortClause(dsl);
  if (withoutCohort.includes('window(')) return withoutCohort;
  return withoutCohort ? `${windowClause};${withoutCohort}` : windowClause;
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
  
  // COHORT-VIEW: Precompute path_t95 once so we can decide, per edge,
  // whether cohort-mode should be overridden to window() for "simple" edges.
  const pathT95Map = dsl.includes('cohort(') ? computePathT95MapForGraph(graph) : new Map<string, number>();

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
        
        const override = computeTargetSliceOverrideForItem(item, graph, dsl, pathT95Map);
        if (override) item.targetSliceOverride = override;

        const targetSlice = item.targetSliceOverride ?? dsl;
        if (itemNeedsFetch(item, window, graph, targetSlice, checkCache)) {
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
 * Internal helper: perform the actual fetch/merge work for a single item (Stage 1 only).
 * This does NOT run the graph-level LAG / inbound-n passes.
 */
async function fetchSingleItemInternal(
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
  const targetSlice = item.targetSliceOverride ?? dsl;
  
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
          targetSlice,
          setAutoUpdating: options?.setAutoUpdating,
          conditionalIndex: item.conditionalIndex, // For conditional_p entries
          includePermissions: options?.includePermissions === true,
          copyOptions: options?.copyOptions,
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
          targetSlice,
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
          targetSlice,
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

/**
 * Public entrypoint: Fetch a single item and then run the unified batch pipeline.
 *
 * This delegates to fetchItems([item], ...) so that both single-item and batch
 * flows share the same Stage-2 LAG/inbound-n logic.
 */
export async function fetchItem(
  item: FetchItem,
  options: FetchOptions | undefined,
  graph: Graph,
  setGraph: (g: Graph | null) => void,
  dsl: string,
  getUpdatedGraph?: () => Graph | null
): Promise<FetchResult> {
  const results = await fetchItems(
    [item],
    (options || {}) as FetchOptions & { onProgress?: (current: number, total: number, item: FetchItem) => void },
    graph,
    setGraph,
    dsl,
    getUpdatedGraph
  );
  return results[0] ?? { success: false, item, error: new Error('fetchItems returned no result') };
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
  logOpId?: string,
  whatIfDSL?: string
): void {
  if (!graph?.edges?.length) return;
  
  // Build GraphForPath representation
  const graphForPath: GraphForPath = {
    nodes: (graph.nodes || []).map(n => ({
      id: n.id || n.uuid || '',
      type: n.type,
      entry: n.entry, // Include entry.is_start for START node detection
    })),
    edges: (graph.edges || []).map(e => ({
      id: e.id,
      uuid: e.uuid,
      from: e.from,
      to: e.to,
      p: e.p ? {
        latency: e.p.latency ? {
          latency_parameter: e.p.latency.latency_parameter,
          t95: e.p.latency.t95,
          path_t95: e.p.latency.path_t95,
        } : undefined,
        mean: e.p.mean,
      } : undefined,
    })),
  };
  
  // Get active edges (edges with non-zero probability)
  // Pass whatIfDSL for scenario-aware active edge determination (B4 fix)
  const activeEdges = getActiveEdges(graphForPath, whatIfDSL);
  
  console.log('[fetchDataService] path_t95 prep:', {
    nodeCount: graphForPath.nodes.length,
    edgeCount: graphForPath.edges.length,
    activeCount: activeEdges.size,
    startNodes: graphForPath.nodes.filter(n => n.entry?.is_start).map(n => n.id),
    edgesWithT95: graphForPath.edges.filter(e => e.p?.latency?.t95).length,
  });
  
  if (activeEdges.size === 0) {
    console.log('[fetchDataService] No active edges for path_t95 computation');
    return;
  }
  
  // Compute path_t95 for all active edges
  const pathT95Map = computePathT95(graphForPath, activeEdges);
  
  console.log('[fetchDataService] path_t95 result:', {
    mapSize: pathT95Map.size,
    entries: Array.from(pathT95Map.entries()).slice(0, 5),
  });
  
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
            path_t95: roundToDecimalPlaces(pathT95, LATENCY_HORIZON_DECIMAL_PLACES),
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

/**
 * Compute and apply inbound-n (forecast population) to the graph.
 * 
 * p.n is the forecast population for each edge under the current DSL,
 * derived by step-wise convolution of upstream p.mean values. This enables
 * correct completeness calculations for downstream latency edges.
 * 
 * See inbound-n-fix.md for the full design.
 * 
 * @param graph - The graph with edges that have evidence.n and p.mean
 * @param setGraph - Graph setter to apply the updated p.n values
 * @param whatIfDSL - Optional scenario DSL for computing effective probabilities
 * @param logOpId - Optional parent log operation ID for session logging
 */
export function computeAndApplyInboundN(
  graph: Graph,
  setGraph: (g: Graph | null) => void,
  whatIfDSL?: string | null,
  logOpId?: string
): void {
  console.log('[fetchDataService] computeAndApplyInboundN called', {
    hasGraph: !!graph,
    edgeCount: graph?.edges?.length ?? 0,
    whatIfDSL,
    logOpId,
  });
  
  if (!graph?.edges?.length) {
    console.log('[fetchDataService] computeAndApplyInboundN: no edges, returning early');
    return;
  }
  
  // Build GraphForInboundN representation
  const graphForInboundN: GraphForInboundN = {
    nodes: (graph.nodes || []).map(n => ({
      id: n.id || n.uuid || '',
      type: n.type,
      entry: n.entry, // Include entry.is_start for START node detection
    })),
    edges: (graph.edges || []).map(e => ({
      id: e.id,
      uuid: e.uuid,
      from: e.from,
      to: e.to,
      p: e.p
        ? {
            latency: e.p.latency
              ? {
                  latency_parameter: e.p.latency.latency_parameter,
                  t95: e.p.latency.t95,
                  path_t95: e.p.latency.path_t95,
                }
              : undefined,
            mean: e.p.mean,
            evidence: e.p.evidence
              ? {
                  n: e.p.evidence.n,
                  k: e.p.evidence.k,
                }
              : undefined,
            // Carry through any existing cached inbound-n results so that
            // computeInboundN can be incremental if needed.
            n: e.p.n,
          }
        : undefined,
    })),
  };
  
  // Get active edges (edges with non-zero probability)
  const activeEdges = getActiveEdges(graphForInboundN);
  
  console.log('[fetchDataService] Active edges for inbound-n:', {
    activeCount: activeEdges.size,
    totalEdges: graphForInboundN.edges.length,
    edgeMeans: graphForInboundN.edges.slice(0, 5).map(e => ({ 
      id: e.id || e.uuid, 
      mean: e.p?.mean,
      evidenceN: e.p?.evidence?.n 
    })),
  });
  
  if (activeEdges.size === 0) {
    console.log('[fetchDataService] No active edges for inbound-n computation');
    return;
  }
  
  // Create effective probability getter using whatIf logic
  const whatIfOverrides: WhatIfOverrides = { whatIfDSL: whatIfDSL ?? null };
  const getEffectiveP = (edgeId: string): number => {
    return computeEffectiveEdgeProbability(graph, edgeId, whatIfOverrides);
  };
  
  // Compute inbound-n for all active edges
  const inboundNMap = computeInboundN(graphForInboundN, activeEdges, getEffectiveP);
  
  if (inboundNMap.size === 0) {
    console.log('[fetchDataService] inbound-n computation returned empty map');
    // IMPORTANT: Even if inbound-n is empty, we must still call setGraph
    // to persist any LAG values that were applied to the graph before this function was called.
    // Without this, LAG-enhanced p.mean values would be lost when inbound-n returns empty.
    setGraph({ ...graph });
    return;
  }
  
  // DEBUG: Log p.mean values BEFORE inbound-n (should have LAG values)
  const latencyEdgesInput = graph.edges?.filter((e: any) => e.p?.latency?.completeness !== undefined) || [];
  console.log('[fetchDataService] computeAndApplyInboundN INPUT graph:', {
    latencyEdgeCount: latencyEdgesInput.length,
    sample: latencyEdgesInput.slice(0, 3).map((e: any) => ({
      id: e.uuid || e.id,
      pMean: e.p?.mean,
      completeness: e.p?.latency?.completeness,
    })),
  });
  
  // Apply to in-memory graph (clone to trigger React update)
  const updatedGraph = { ...graph };
  updatedGraph.edges = graph.edges.map(edge => {
    const edgeId = edge.uuid || edge.id || `${edge.from}->${edge.to}`;
    const result = inboundNMap.get(edgeId);

    if (result !== undefined && edge.p) {
      return {
        ...edge,
        p: {
          ...edge.p,
          // Persist inbound-n forecast population
          n: result.n,
          // Persist expected converters so single-edge fetches can
          // reconstruct p.n by summing inbound forecast.k.
          forecast: {
            ...edge.p.forecast,
            k: result.forecast_k,
          },
        },
      };
    }
    return edge;
  });
  
  // DEBUG: Log p.mean values AFTER inbound-n (should still have LAG values)
  const latencyEdgesOutput = updatedGraph.edges?.filter((e: any) => e.p?.latency?.completeness !== undefined) || [];
  console.log('[fetchDataService] computeAndApplyInboundN OUTPUT graph (calling setGraph):', {
    latencyEdgeCount: latencyEdgesOutput.length,
    sample: latencyEdgesOutput.slice(0, 3).map((e: any) => ({
      id: e.uuid || e.id,
      pMean: e.p?.mean,
      completeness: e.p?.latency?.completeness,
    })),
  });
  
  setGraph(updatedGraph);
  
  // Log summary
  const edgesWithN = Array.from(inboundNMap.entries()).filter(([_, v]) => v.n > 0);
  console.log(`[fetchDataService] Computed inbound-n for ${edgesWithN.length} edges:`, 
    Object.fromEntries(edgesWithN.slice(0, 5).map(([id, r]) => [id, { n: r.n, forecast_k: r.forecast_k }])));
  
  if (logOpId) {
    sessionLogService.addChild(logOpId, 'info', 'INBOUND_N_COMPUTED',
      `Computed inbound-n for ${edgesWithN.length} edges`,
      undefined,
      { edgeCount: edgesWithN.length, sample: Object.fromEntries(edgesWithN.slice(0, 3).map(([id, r]) => [id, r.n])) }
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

  // CRITICAL: Track the freshest graph as we go.
  //
  // Many callers (including tests) pass a setGraph callback but do NOT provide
  // getUpdatedGraph(). Without local tracking, this function keeps using the
  // original `graph` reference for subsequent items and for Stage-2 passes
  // (LAG + inbound-n), which causes LAG to run on stale data and drop p.evidence.*,
  // p.stdev, and other fields.
  let latestGraph: Graph | null = graph;
  const trackingSetGraph = (g: Graph | null) => {
    latestGraph = g;
    setGraph(g);
  };
  
  // COHORT-VIEW: Apply per-item targetSlice overrides so cohort-mode tabs only use
  // cohort-shaped retrieval for edges behind lagged paths (path_t95 > 0) or with
  // local latency config. Truly simple edges are fetched via window().
  const pathT95Map = dsl.includes('cohort(') ? computePathT95MapForGraph(graph) : new Map<string, number>();
  const effectiveItems: FetchItem[] = items.map((it) => {
    if (!dsl.includes('cohort(')) return it;
    if (it.type !== 'parameter') return it;
    const override = it.targetSliceOverride ?? computeTargetSliceOverrideForItem(it, graph, dsl, pathT95Map);
    return override ? { ...it, targetSliceOverride: override } : it;
  });

  const batchStart = performance.now();
  const results: FetchResult[] = [];
  const { onProgress, ...itemOptions } = options || {};
  
  // For multiple items: use batch mode with visual progress toast
  const shouldUseBatchMode = effectiveItems.length > 1;
  const progressToastId = 'batch-fetch-progress';
  
  // SESSION LOG: Start batch fetch operation (only for batch mode)
  // If parentLogId is provided, add children to that instead of creating new operation
  const useParentLog = !!itemOptions?.parentLogId;
  const batchLogId = useParentLog
    ? itemOptions.parentLogId
    : shouldUseBatchMode 
      ? sessionLogService.startOperation('info', 'data-fetch', 'BATCH_FETCH',
          `Batch fetch: ${effectiveItems.length} items`,
          { dsl, itemCount: effectiveItems.length, mode: itemOptions?.mode || 'versioned' })
      : undefined;
  
  if (shouldUseBatchMode) {
    setBatchMode(true);
    // Show initial progress toast with visual bar
    showProgressToast(progressToastId, 0, effectiveItems.length, 'Fetching');
  }
  
  let successCount = 0;
  let errorCount = 0;
  
  try {
    for (let i = 0; i < effectiveItems.length; i++) {
      onProgress?.(i + 1, effectiveItems.length, effectiveItems[i]);
      
      // Update progress toast with visual bar
      if (shouldUseBatchMode) {
        showProgressToast(progressToastId, i, effectiveItems.length, 'Fetching');
      }
      
      // CRITICAL: Use getUpdatedGraph() to get fresh graph for each item
      // This ensures rebalancing from previous items is preserved
      // Without this, each item clones the ORIGINAL graph, losing sibling rebalancing
      const currentGraph = getUpdatedGraph?.() ?? latestGraph ?? graph;
      
      const result = await fetchSingleItemInternal(
        effectiveItems[i],
        itemOptions,
        currentGraph,
        trackingSetGraph,
        dsl,
        getUpdatedGraph
      );
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
      showProgressToast(progressToastId, effectiveItems.length, effectiveItems.length, 'Fetching');
      
      // Small delay to show completed bar, then show final message
      setTimeout(() => {
        if (errorCount > 0) {
          completeProgressToast(progressToastId, `Fetched ${successCount}/${effectiveItems.length} (${errorCount} failed)`, true);
        } else {
          completeProgressToast(progressToastId, `Fetched ${successCount} item${successCount !== 1 ? 's' : ''}`, false);
        }
      }, 300);
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // GRAPH-LEVEL LATENCY ENHANCEMENT (Topological Pass)
    // 
    // This is the single place where LAG statistics are computed. It runs
    // in topological order so that upstream path_t95 is available when
    // computing downstream completeness.
    // 
    // For each edge in topo order:
    //   1. Build cohorts from the edge's parameter values
    //   2. Fit lag distribution (median, mean, t95)
    //   3. Compute completeness using path-adjusted cohort ages
    //   4. Compute path_t95 = upstream path_t95 + edge t95
    // 
    // This replaces the old approach where LAG was computed per-edge in
    // dataOperationsService, then path_t95 was computed separately here.
    // ═══════════════════════════════════════════════════════════════════════
    if (successCount > 0) {
      let finalGraph = getUpdatedGraph?.() ?? latestGraph ?? graph;
      if (finalGraph) {
        // Check if any fetched items were parameters on latency edges
        const latencyCheck = effectiveItems.map(item => {
          if (item.type !== 'parameter') return { item: item.name, hasLatency: false, reason: 'not parameter' };
          const edge = finalGraph.edges?.find((e: any) => 
            e.uuid === item.targetId || e.id === item.targetId
          );
          if (!edge) return { item: item.name, hasLatency: false, reason: 'edge not found' };
          const hasLatency = edge?.p?.latency?.latency_parameter === true;
          return { 
            item: item.name, 
            hasLatency, 
            latency_parameter: edge?.p?.latency?.latency_parameter,
            t95: edge?.p?.latency?.t95,
            edgeId: edge.uuid || edge.id,
          };
        });
        const hasLatencyItems = latencyCheck.some(c => c.hasLatency);
        
        console.log('[fetchDataService] Latency items check:', { hasLatencyItems, details: latencyCheck });
        
        if (hasLatencyItems) {
          // Build param lookup: edge ID -> parameter values
          // CRITICAL: Filter to current DSL cohort window so LAG uses the right cohorts
          const paramLookup = new Map<string, ParameterValueForLAG[]>();
          
          // Parse the cohort/window from the DSL
          const parsedDSL = parseConstraints(dsl);
          const targetDims = extractSliceDimensions(dsl);
          
          // Determine LAG slice window for completeness computation.
          // 
          // DESIGN PRINCIPLE (11-Dec-25):
          //   - In window() mode: evidence is window-based, so completeness should
          //     also be window-based (only cohorts whose dates fall in the window).
          //   - In cohort() mode: completeness is cohort-anchored as always.
          //   - This makes both modes internally consistent and intelligible.
          //
          // Two separate concerns:
          //   1. paramLookup filter: Only applies to explicit cohort() DSL (filters
          //      which cohort slices to include in LAG calculations)
          //   2. lagCohortWindow: Passed to aggregateCohortData to filter the 
          //      cohort dates used for completeness computation (applies to both
          //      cohort() and window() modes)
          //
          let cohortStart: Date | null = null;
          let cohortEnd: Date | null = null;
          
          // For paramLookup filtering: only use explicit cohort() DSL
          if (parsedDSL.cohort?.start && parsedDSL.cohort?.end) {
            cohortStart = parseDate(resolveRelativeDate(parsedDSL.cohort.start));
            cohortEnd = parseDate(resolveRelativeDate(parsedDSL.cohort.end));
          }
          
          // For LAG completeness: use either cohort() or window() dates
          let lagSliceStart: Date | null = cohortStart;
          let lagSliceEnd: Date | null = cohortEnd;
          let lagSliceSource: 'cohort' | 'window' | 'none' = cohortStart ? 'cohort' : 'none';
          
          if (!lagSliceStart && parsedDSL.window?.start && parsedDSL.window?.end) {
            // Window() mode: use window dates for LAG completeness scoping
            lagSliceStart = parseDate(resolveRelativeDate(parsedDSL.window.start));
            lagSliceEnd = parseDate(resolveRelativeDate(parsedDSL.window.end));
            lagSliceSource = 'window';
          }
          
          console.log('[fetchDataService] LAG filter setup:', {
            dsl,
            targetDims,
            lagSliceSource,
            cohortFilter: cohortStart ? `${cohortStart.toISOString().split('T')[0]} to ${cohortEnd?.toISOString().split('T')[0]}` : 'none',
            lagWindow: lagSliceStart ? `${lagSliceStart.toISOString().split('T')[0]} to ${lagSliceEnd?.toISOString().split('T')[0]}` : 'none',
          });
          
          for (const item of items) {
            if (item.type !== 'parameter') continue;
            
            // Find the edge for this item (check both uuid and id)
            const edge = finalGraph.edges?.find((e: any) => 
              e.uuid === item.targetId || e.id === item.targetId
            ) as any;
            if (!edge) continue;
            
            const edgeId = edge.uuid || edge.id || `${edge.from}->${edge.to}`;
            
            // Try param file from registry first
            let allValues: ParameterValueForLAG[] | undefined;
            if (item.objectId) {
              const paramFile = fileRegistry.getFile(`parameter-${item.objectId}`);
              if (paramFile?.data?.values) {
                allValues = paramFile.data.values as ParameterValueForLAG[];
              }
            }
            
            // Fall back to edge's direct data if no param file
            if (!allValues && edge.p?.values) {
              allValues = edge.p.values as ParameterValueForLAG[];
            }
            
            if (allValues && allValues.length > 0) {
              // Filter values to:
              // 1. Same context/case dimensions
              // 2. COHORT slices with dates overlapping the query window
              // 3. WINDOW slices (for forecast baseline) - include all with matching dims
              const filteredValues = allValues.filter((v: any) => {
                // Check context/case dimensions match
                const valueDims = extractSliceDimensions(v.sliceDSL ?? '');
                if (valueDims !== targetDims) return false;
                
                const sliceDSL = v.sliceDSL ?? '';
                const isCohortSlice = sliceDSL.includes('cohort(');
                const isWindowSlice = sliceDSL.includes('window(') && !isCohortSlice;
                
                // Window slices: always include for forecast baseline
                if (isWindowSlice) return true;
                
                // Cohort slices: filter by date overlap ONLY if explicit cohort() DSL
                // (In window() mode, we don't filter cohort slices - we need all of them
                // for LAG calculations; the completeness window is applied later)
                if (isCohortSlice && cohortStart && cohortEnd && v.dates && v.dates.length > 0) {
                  // Check if ANY of this value's dates fall within the cohort query window
                  for (const dateStr of v.dates) {
                    const d = parseDate(dateStr);
                    if (d >= cohortStart && d <= cohortEnd) {
                      return true; // At least one date overlaps
                    }
                  }
                  return false; // No dates overlap
                }
                
                // No cohort window in DSL, or value has no dates - include it
                return true;
              });
              
              console.log('[fetchDataService] Filtered param values for LAG:', {
                edgeId,
                targetDims,
                lagSliceSource,
                hasCohortFilter: !!(cohortStart && cohortEnd),
                hasLAGWindow: !!(lagSliceStart && lagSliceEnd),
                totalValues: allValues.length,
                filteredValues: filteredValues.length,
                sampleSliceDSLs: allValues.slice(0, 3).map((v: any) => v.sliceDSL),
              });
              
              if (filteredValues.length > 0) {
                paramLookup.set(edgeId, filteredValues);
              }
            }
          }
          
          console.log('[LAG_TOPO_000] paramLookup:', {
            edgeCount: paramLookup.size,
            edgeIds: Array.from(paramLookup.keys()),
          });
          
          // Run the unified topo pass: t95, path_t95, and path-adjusted completeness
          // Cast helpers to LAGHelpers - ParameterValueForLAG is a subset of ParameterValue
          const lagHelpers: LAGHelpers = {
            aggregateCohortData: aggregateCohortData as LAGHelpers['aggregateCohortData'],
            aggregateWindowData: aggregateWindowData as LAGHelpers['aggregateWindowData'],
            aggregateLatencyStats,
          };
          
          // Use the *analysis date* (now) for age calculations.
          // Cohort dates come from Amplitude; as time passes, cohorts age and
          // completeness should converge towards 1 for long-ago cohorts,
          // independent of the cohort() window bounds.
          const queryDateForLAG = new Date();
          
          // Pass LAG slice window so completeness is computed from cohorts in the
          // same date range as the evidence (whether from cohort() or window() DSL).
          // 
          // In window() mode: this ensures completeness reflects "how mature are the
          // cohorts whose dates fall in this window?" rather than mixing in all
          // historical cohort data, making completeness consistent with evidence.
          //
          // In cohort() mode: this is the explicit cohort window (unchanged).
          const lagCohortWindow = (lagSliceStart && lagSliceEnd) 
            ? { start: lagSliceStart, end: lagSliceEnd }
            : undefined;
          
          console.log('[fetchDataService] LAG cohort window:', {
            lagSliceSource,
            lagCohortWindow: lagCohortWindow ? {
              start: lagCohortWindow.start.toISOString().split('T')[0],
              end: lagCohortWindow.end.toISOString().split('T')[0],
            } : 'none (using all cohorts)',
          });
          
          // Pre-compute path_t95 for all edges ONCE (single code path)
          // This is used by enhanceGraphLatencies to classify edges
          const activeEdgesForLAG = getActiveEdges(finalGraph as GraphForPath);
          const pathT95MapForLAG = computePathT95(
            finalGraph as GraphForPath,
            activeEdgesForLAG
          );
          
          const lagResult = enhanceGraphLatencies(
            finalGraph as GraphForPath,
            paramLookup,
            queryDateForLAG,
            lagHelpers,
            lagCohortWindow,
            undefined, // whatIfDSL
            pathT95MapForLAG,
            lagSliceSource
          );
          
          console.log('[fetchDataService] LAG enhancement result:', {
            edgesProcessed: lagResult.edgesProcessed,
            edgesWithLAG: lagResult.edgesWithLAG,
            edgeValuesCount: lagResult.edgeValues.length,
            sampleEdgeValues: lagResult.edgeValues.slice(0, 2).map(v => ({
              uuid: v.edgeUuid,
              t95: v.latency.t95,
              completeness: v.latency.completeness,
              blendedMean: v.blendedMean,
            })),
          });
          
          // Apply ALL LAG values in ONE atomic operation via UpdateManager
          // Single call: clone once, apply all latency + means, rebalance once
          if (lagResult.edgeValues.length > 0 && finalGraph?.edges) {
            const updateManager = new UpdateManager();

            // In from-file mode, the parameter file already contains slice-level latency
            // summaries (median/t95/completeness). The LAG topo pass is primarily needed
            // for path_t95 and (in cohort mode) blended p.mean. Do not overwrite the
            // file-provided latency summary fields.
            const preserveLatencySummaryFromFile = itemOptions?.mode === 'from-file';

            // Phase 2: apply blended p.mean for latency edges in BOTH window() and cohort() modes.
            const edgeValuesToApply = lagResult.edgeValues;
            
            // DEBUG: Log p.mean values BEFORE LAG application
            console.log('[fetchDataService] BEFORE applyBatchLAGValues:', {
              edgeMeans: edgeValuesToApply.slice(0, 3).map(ev => {
                const edge = finalGraph.edges?.find((e: any) => e.uuid === ev.edgeUuid || e.id === ev.edgeUuid);
                return {
                  id: ev.edgeUuid,
                  currentMean: edge?.p?.mean,
                  targetBlendedMean: ev.blendedMean,
                };
              }),
            });
            
            finalGraph = updateManager.applyBatchLAGValues(
              finalGraph,
              edgeValuesToApply.map(ev => ({
                edgeId: ev.edgeUuid,
                latency: preserveLatencySummaryFromFile
                  ? (() => {
                      const edge = finalGraph.edges?.find((e: any) => e.uuid === ev.edgeUuid || e.id === ev.edgeUuid);
                      const existing = edge?.p?.latency;
                      return selectLatencyToApplyForTopoPass(ev.latency, existing, true);
                    })()
                  : ev.latency,
                blendedMean: ev.blendedMean,
                forecast: ev.forecast,
                evidence: ev.evidence,
              }))
            );
            
            // DEBUG: Log p.mean values AFTER LAG application
            console.log('[fetchDataService] AFTER applyBatchLAGValues:', {
              edgeMeans: edgeValuesToApply.slice(0, 3).map(ev => {
                const edge = finalGraph.edges?.find((e: any) => e.uuid === ev.edgeUuid || e.id === ev.edgeUuid);
                return {
                  id: ev.edgeUuid,
                  newMean: edge?.p?.mean,
                  expectedBlendedMean: ev.blendedMean,
                  match: edge?.p?.mean === Math.round((ev.blendedMean ?? 0) * 1000) / 1000,
                };
              }),
            });
          }
          
          if (batchLogId) {
            sessionLogService.addChild(batchLogId, 'info', 'LAG_ENHANCED',
              `Enhanced ${lagResult.edgesWithLAG} edges with LAG stats (topo pass)`,
              undefined,
              { 
                edgesProcessed: lagResult.edgesProcessed, 
                edgesWithLAG: lagResult.edgesWithLAG,
                queryDate: queryDateForLAG.toISOString().split('T')[0],
                sample: lagResult.edgeValues.slice(0, 3).map(v => ({
                  id: v.edgeUuid,
                  t95: v.latency.t95.toFixed(1),
                  pathT95: v.latency.path_t95.toFixed(1),
                  completeness: (v.latency.completeness * 100).toFixed(1) + '%',
                  forecastMean: v.forecast?.mean?.toFixed(3),
                  evidenceMean: v.evidence?.mean?.toFixed(3),
                  blendedMean: v.blendedMean?.toFixed(3),
                })),
              }
            );
            
            // Add detailed debug entries for each edge (for debugging completeness calc)
            for (const v of lagResult.edgeValues) {
              if (v.debug) {
                // Check for data quality issues
                const hasKGreaterThanN = v.debug.sampleCohorts.some(c => c.k > c.n);
                const dataQuality = hasKGreaterThanN ? '⚠️ k>n detected!' : '✓';
                const windowInfo = v.debug.cohortWindow || 'all history';
                
                // Build anchor lag indicator for message
                const anchorLagInfo = v.debug.anchorMedianLag > 0
                  ? ` anchorLag=${v.debug.anchorMedianLag.toFixed(1)}d`
                  : v.debug.cohortsWithAnchorLag === 0 ? ' (no anchor data)' : '';
                
                sessionLogService.addChild(batchLogId, 'info', 'LAG_CALC_DETAIL',
                  `${v.edgeUuid.substring(0, 8)}...: completeness=${(v.latency.completeness * 100).toFixed(1)}%${anchorLagInfo} ${dataQuality}`,
                  `Window: ${windowInfo} → ${v.debug.cohortCount} cohorts, n=${v.debug.totalN}, k=${v.debug.totalK}`,
                  {
                    edgeId: v.edgeUuid,
                    queryDate: v.debug.queryDate,
                    cohortWindow: v.debug.cohortWindow || 'all history (no filter)',
                    inputSlices: {
                      cohort: v.debug.inputCohortSlices,
                      window: v.debug.inputWindowSlices,
                    },
                    cohortCount: v.debug.cohortCount,
                    rawAgeRange: v.debug.rawAgeRange,
                    adjustedAgeRange: v.debug.adjustedAgeRange,
                    anchorMedianLag: v.debug.anchorMedianLag?.toFixed(2) ?? '0 (first edge)',
                    cohortsWithAnchorLag: `${v.debug.cohortsWithAnchorLag ?? 0}/${v.debug.cohortCount}`,
                    pathT95: v.latency.path_t95.toFixed(1),
                    mu: v.debug.mu.toFixed(3),
                    sigma: v.debug.sigma.toFixed(3),
                    // Forecast/blend diagnostics (needed to debug “forecast too low”)
                    baseForecastMean: v.debug.baseForecastMean,
                    fallbackForecastMean: v.debug.fallbackForecastMean,
                    forecastMeanUsed: v.debug.forecastMeanUsed,
                    forecastMeanSource: v.debug.forecastMeanSource,
                    nQuery: v.debug.nQuery,
                    nBaseline: v.debug.nBaseline,
                    nBaselineSource: v.debug.nBaselineSource,
                    baselineWindowSliceDSL: v.debug.baselineWindowSliceDSL,
                    baselineWindowRetrievedAt: v.debug.baselineWindowRetrievedAt,
                    baselineWindowN: v.debug.baselineWindowN,
                    baselineWindowK: v.debug.baselineWindowK,
                    baselineWindowForecast: v.debug.baselineWindowForecast,
                    wEvidence: v.debug.wEvidence,
                    totalN: v.debug.totalN,
                    totalK: v.debug.totalK,
                    dataQuality: hasKGreaterThanN ? 'ERROR: k > n in some cohorts' : 'OK',
                    sampleCohorts: v.debug.sampleCohorts.map(c => ({
                      date: c.date,
                      rawAge: c.rawAge,
                      adjAge: c.adjustedAge,
                      anchorLag: c.anchorLag?.toFixed(1) ?? '-',
                      n: c.n,
                      k: c.k,
                      kOk: c.k <= c.n ? '✓' : '⚠️',
                      cdf: (c.cdf * 100).toFixed(1) + '%',
                    })),
                  }
                );
              }
            }
          }
        }
        
        // ═══════════════════════════════════════════════════════════════════
        // INBOUND-N COMPUTATION (forecast population propagation)
        // 
        // After LAG enhancement is complete (t95, path_t95, completeness all set),
        // compute p.n for each edge via step-wise convolution of upstream p.mean.
        // 
        // p.n is transient (not persisted) - it's recomputed whenever
        // the scenario, DSL, or graph changes.
        // 
        // IMPORTANT: Use finalGraph directly (not getUpdatedGraph) since we just
        // modified it and haven't called setGraph yet. This avoids race conditions.
        // ═══════════════════════════════════════════════════════════════════
        // Debug: Check if LAG values actually landed on latency-labelled edges
        const latencyEdges = (finalGraph?.edges || []).filter(
          (e: any) => e.p?.latency && (e.p.latency.latency_parameter || e.p.latency.t95 || e.p.latency.completeness)
        );
        console.log('[fetchDataService] LAG_DEBUG finalGraph before inbound-n:', {
          edgeCount: finalGraph?.edges?.length,
          latencyEdgeCount: latencyEdges.length,
          latencyEdges: latencyEdges.map((e: any) => ({
            uuid: e.uuid,
            id: e.id,
            from: e.from,
            to: e.to,
            pMean: e.p?.mean,
            latency_parameter: e.p?.latency?.latency_parameter,
            t95: e.p?.latency?.t95,
            completeness: e.p?.latency?.completeness,
            path_t95: e.p?.latency?.path_t95,
          })),
        });
        
        console.log('[fetchDataService] About to compute inbound-n', { 
          hasFinalGraph: !!finalGraph,
          batchLogId 
        });
        if (finalGraph) {
          // Apply inbound-n to the SAME graph we just applied LAG values to
          computeAndApplyInboundN(finalGraph, setGraph, dsl, batchLogId);
        } else {
          console.log('[fetchDataService] No graph for inbound-n computation');
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

/**
 * Decide which latency fields to apply during the Stage-2 LAG topo pass.
 *
 * In `from-file` mode we may want to preserve *shape* fields that were authored
 * from file slices (median/mean lag, and sometimes t95), but **completeness is
 * always query-date dependent** and must never be preserved from a previous run.
 *
 * This helper is exported purely for unit testing to prevent regressions where
 * the graph renders a stale completeness value after a fetch.
 */
export function selectLatencyToApplyForTopoPass(
  computed: { median_lag_days?: number; mean_lag_days?: number; t95: number; completeness: number; path_t95: number },
  existing: { median_lag_days?: number; mean_lag_days?: number; t95?: number; completeness?: number } | undefined,
  preserveLatencySummaryFromFile: boolean
): { median_lag_days?: number; mean_lag_days?: number; t95: number; completeness: number; path_t95: number } {
  if (!preserveLatencySummaryFromFile) {
    return computed;
  }

  const hasExistingSummary =
    existing?.median_lag_days !== undefined ||
    existing?.mean_lag_days !== undefined;

  if (!hasExistingSummary) {
    return computed;
  }

  return {
    // Preserve existing slice-level latency summary (from file)
    median_lag_days: existing?.median_lag_days,
    mean_lag_days: existing?.mean_lag_days,
    // Keep existing t95 if present (UpdateManager will still respect t95_overridden).
    t95: existing?.t95 ?? computed.t95,
    // CRITICAL: completeness must always come from the topo pass (query-date dependent).
    completeness: computed.completeness,
    // Still apply computed path_t95 (UpdateManager will respect path_t95_overridden).
    path_t95: computed.path_t95,
  };
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

