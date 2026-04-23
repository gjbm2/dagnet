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

import toast from 'react-hot-toast';
import { dataOperationsService, setBatchMode, discardBatchMode } from './dataOperationsService';
import { isBatchMode } from './dataOperationsService';
import { 
  calculateIncrementalFetch, 
  hasFullSliceCoverageByHeader, 
  parseDate,
  aggregateCohortData,
  aggregateWindowData,
  aggregateLatencyStats,
} from './windowAggregationService';
import { isolateSlice, extractSliceDimensions } from './sliceIsolation';
import { resolveMECEPartitionForImplicitUncontexted } from './meceSliceService';
import { fileRegistry } from '../contexts/TabContext';
import { compareModelVarsSources, FORECASTING_PARALLEL_RUN } from './forecastingParityService';
import { parseConstraints } from '../lib/queryDSL';
import { resolveRelativeDate } from '../lib/dateFormat';
import type { Graph, DateRange } from '../types';
import type { GetFromFileCopyOptions } from './dataOperationsService';
import { operationRegistryService } from './operationRegistryService';
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
import { forecastingSettingsService } from './forecastingSettingsService';
import { enumerateFetchTargets } from './fetchTargetEnumerationService';
import { buildItemKey } from './fetchPlanTypes';
import { rateLimiter, getEffectiveRateLimitCooloffMinutes } from './rateLimiter';
import { startRateLimitCountdown } from './rateLimitCountdownService';

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
  /**
   * If true, skip cohort horizon bounding even when latency is enabled.
   * Used when the FetchPlan has already computed the correct windows (first-principles).
   */
  skipCohortBounding?: boolean;
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

  /**
   * When true, suppress the internal batch progress toast shown by fetchItems() for multi-item runs.
   * Default behaviour is unchanged (toast is shown for multi-item fetches).
   *
   * Intended for callers that already own a higher-level progress UI (e.g. Retrieve All modal),
   * but still need to reuse the exact fetchItems() pipeline (including logging and Stage-2 passes).
   */
  suppressBatchToast?: boolean;

  /**
   * When true, suppress the 5-step fetch-compute pipeline op (plan → fetch → FE → BE → CF).
   * Intended for batch callers (e.g. regenerateAllLive looping visible scenarios) that
   * register their own wrapping op and don't want N per-scenario pipeline indicators
   * stacking up in the operation registry. When set alongside `scenarioLabel`, Stage 2
   * emits one compact per-scenario terminal op at CF resolution carrying the CF verdict
   * (ran/ms/conditioned count) prefixed with the scenario name.
   */
  suppressPipelineToast?: boolean;

  /**
   * Human-readable scenario name used to prefix the per-scenario CF terminal op
   * when `suppressPipelineToast` is set. Ignored when the pipeline op is shown.
   */
  scenarioLabel?: string;

  /**
   * When true, skip Stage-2 graph-level enhancements (LAG topo pass + inbound-n).
   *
   * Intended for ephemeral/analysis-only fetches (e.g. share-link scenario regeneration) where we
   * want the direct file/edge values without a subsequent graph-wide recompute potentially
   * overriding them.
   */
  skipStage2?: boolean;

  /**
   * When true, Stage-2 awaits its fire-and-forget background handlers
   * (BE topo pass `.then()`, conditioned-forecast slow-path `.then()`)
   * before resolving. The browser wants fast first render and async
   * catch-up (leave this false). The CLI wants deterministic final
   * state for param pack / parity diagnostics (set this true).
   */
  awaitBackgroundPromises?: boolean;

  /**
   * When true, allow Stage‑2 to write horizon fields (t95/path_t95) onto the graph.
   *
   * Policy:
   * - Default false to avoid "floatiness" / non-deterministic behaviour after ordinary fetches.
   * - Explicit flows (Retrieve All post-pass, "Latency horizons" actions) may set this true and
   *   then persist to parameter files in the same operation.
   */
  writeLagHorizonsToGraph?: boolean;

  /**
   * When mode === 'from-file' and item.type === 'parameter', suppress the “missing days” warning toast and
   * associated session-log child.
   *
   * This is intended for explicit global recompute workflows that deliberately request very wide windows
   * (e.g. 10y) where “missing history” is expected and not actionable.
   */
  suppressMissingDataToast?: boolean;

  /**
   * Override the “analysis date” used for cohort age calculations in the LAG topo pass.
   *
   * Default: `new Date()` (current system time).
   *
   * Intended for tests that need deterministic cohort ages without relying on
   * `vi.useFakeTimers`, which does not reliably intercept `new Date()` across
   * module boundaries in vitest's worker pool.
   */
  queryDate?: Date;

  /**
   * Explicit workspace identity for non-browser callers.
   *
   * The browser-conditioned forecast path can resolve this from IDB app state.
   * CLI callers cannot, so they must thread the workspace through here for
   * candidate-regime discovery.
   */
  workspace?: { repository: string; branch: string };

  /**
   * Pre-computed query signatures from the fetch planner, keyed by FetchPlan itemKey.
   * When provided, the from-file path passes the matching signature to getParameterFromFile
   * so the asat evidence path can use it for snapshot DB lookups.
   */
  querySignatures?: Record<string, string>;
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
  
  const formatUK = (v: string) => {
    const d = new Date(v);
    const day = d.getDate();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[d.getMonth()];
    const year = String(d.getFullYear()).slice(-2);
    return `${day}-${month}-${year}`;
  };

  const parts: string[] = [];
  const evidence = param.evidence;
  
  if (evidence?.n !== undefined) parts.push(`n=${evidence.n}`);
  if (evidence?.k !== undefined) parts.push(`k=${evidence.k}`);
  if (evidence?.scope_from && evidence?.scope_to) {
    parts.push(`scope=${formatUK(evidence.scope_from)}→${formatUK(evidence.scope_to)}`);
  }
  if (evidence?.source) parts.push(`source=${evidence.source}`);
  if (param.mean !== undefined) parts.push(`p=${(param.mean * 100).toFixed(2)}%`);
  
  return parts.length > 0 ? parts.join(', ') : '';
}

// ============================================================================
// Cohort-mode semantics (investigation follow-up 2b)
// ============================================================================
//
// Historical behaviour (pre-8-Jan-26) allowed cohort() tabs to override some “simple” edges
// to window() slices (path_t95 == 0). That caused mixed cohort/window semantics within a
// single cohort view and created denominator inconsistencies at split nodes.
//
// Per follow-up 2b, we no longer apply any per-item window() override in cohort mode.

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
    // Handle open-ended ranges like window(-10d:) / cohort(-10d:) where end is undefined/empty.
    // Default the end to "today" (matching resolveWindowDates behaviour).
    const resolveRange = (startRaw?: string, endRaw?: string): DateRange | null => {
      if (!startRaw) return null;
      const start = resolveRelativeDate(startRaw);
      const end = endRaw ? resolveRelativeDate(endRaw) : getTodayUK();
      return { start, end };
    };

    const w = resolveRange(constraints.window?.start, constraints.window?.end);
    if (w) return w;
    const c = resolveRange(constraints.cohort?.start, constraints.cohort?.end);
    if (c) return c;
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
    // PARAM FILES ARE OPTIONAL:
    // If there is no parameter file for this item (either because objectId is empty OR the file is missing),
    // then this parameter is OUT OF SCOPE for fetch planning/coverage. This must apply uniformly to:
    // - base edge params (p/cost/labour)
    // - conditional_p[i].p
    //
    // Rationale: "No parameter file" means there's no persisted slice cache to check and no versioned
    // fetch target to write into. We therefore skip it rather than blocking coverage with needs_fetch.
    if (!item.objectId) return false;

    const paramFile = fileRegistry.getFile(`parameter-${item.objectId}`);
    if (!paramFile) return false;
    
    // Check if parameter has connection (edge slot or graph default)
    const edge = graph.edges?.find((e: any) => e.uuid === item.targetId || e.id === item.targetId);
    const param =
      typeof item.conditionalIndex === 'number'
        ? edge?.conditional_p?.[item.conditionalIndex]?.p
        : edge?.[item.paramSlot || 'p'];
    const hasConnection = !!param?.connection || !!graph.defaultConnection;
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
    const hasConnection = !!node?.case?.connection || !!graph.defaultConnection;
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

  const allItems = collectAllFetchItems(graph);
  const items = allItems.filter(item => itemNeedsFetch(item, window, graph, dsl, checkCache));
  return sortFetchItemsTopologically(items, graph);
}

/**
 * Collect ALL fetch items for a graph, without any cache/file/connection gating.
 *
 * This is used for "from-file" refresh/regeneration flows where we *must* attempt to
 * load all referenced params/cases from the local file cache, and missing files should
 * surface as errors (rather than silently skipping and producing identical scenario graphs).
 */
export function getItemsForFromFileLoad(graph: Graph): FetchItem[] {
  if (!graph) return [];
  return sortFetchItemsTopologically(collectAllFetchItems(graph), graph);
}

function collectAllFetchItems(graph: Graph): FetchItem[] {
  return enumerateFetchTargets(graph).map((t): FetchItem => {
    if (t.type === 'case') {
      return {
        id: `case-${t.objectId}-${t.targetId}`,
        type: 'case',
        name: `case: ${t.objectId}`,
        objectId: t.objectId,
        targetId: t.targetId,
      };
    }

    // parameter
    const slot = t.paramSlot || 'p';
    const isConditional = typeof t.conditionalIndex === 'number';
    return {
      id: isConditional
        ? `param-${t.objectId}-conditional_p[${t.conditionalIndex}]-${t.targetId}`
        : `param-${t.objectId}-${slot}-${t.targetId}`,
      type: 'parameter',
      name: isConditional ? `conditional_p[${t.conditionalIndex}]: ${t.objectId}` : `${slot}: ${t.objectId}`,
      objectId: t.objectId,
      targetId: t.targetId,
      paramSlot: slot,
      conditionalIndex: t.conditionalIndex,
    };
  });
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
        // Look up pre-computed planner signature for this item (if available).
        const itemKey = buildItemKey({
          type: item.type,
          objectId: item.objectId,
          targetId: item.targetId,
          slot: item.paramSlot,
          conditionalIndex: item.conditionalIndex,
        });
        const plannerSignature = options?.querySignatures?.[itemKey];

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
          suppressMissingDataToast: options?.suppressMissingDataToast === true,
          querySignature: plannerSignature,
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
          // Skip cohort bounding if the plan builder already computed correct windows
          skipCohortBounding: item.skipCohortBounding,
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
          // Doc 19: promoted values for consumption, fallback to user-configured.
          t95: e.p.latency.promoted_t95 ?? e.p.latency.t95,
          path_t95: e.p.latency.promoted_path_t95 ?? e.p.latency.path_t95,
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
    sessionLogService.addChild(logOpId, 'debug', 'PATH_T95_COMPUTED',
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
  
  // Build GraphForInboundN representation.
  //
  // IMPORTANT: Real graphs typically use node UUIDs for `edge.from`/`edge.to` endpoints.
  // Some synthetic/unit-test graphs may use node IDs instead. We must canonicalise the
  // node key to match the edge endpoints, otherwise inbound-n becomes an empty map
  // (breaking completeness/blend computations downstream).
  const endpointIds = new Set<string>();
  for (const e of graph.edges || []) {
    if (typeof (e as any).from === 'string') endpointIds.add((e as any).from);
    if (typeof (e as any).to === 'string') endpointIds.add((e as any).to);
  }

  const nodeKey = (n: any): string => {
    const uuid = typeof n?.uuid === 'string' ? n.uuid : undefined;
    const id = typeof n?.id === 'string' ? n.id : undefined;
    // Prefer whichever identifier is actually referenced by edges.
    if (uuid && endpointIds.has(uuid)) return uuid;
    if (id && endpointIds.has(id)) return id;
    // Fallback: uuid first (most real graphs), then id.
    return uuid || id || '';
  };

  // Build GraphForInboundN representation
  const graphForInboundN: GraphForInboundN = {
    nodes: (graph.nodes || []).map(n => ({
      id: nodeKey(n),
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
                  // Doc 19: promoted values for consumption, fallback to user-configured.
                  t95: e.p.latency.promoted_t95 ?? e.p.latency.t95,
                  path_t95: e.p.latency.promoted_path_t95 ?? e.p.latency.path_t95,
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
    sessionLogService.addChild(logOpId, 'debug', 'INBOUND_N_COMPUTED',
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
// ────────────────────────────────────────────────────────────────────────
// Fetch-compute pipeline indicator
//
// Every fetch cycle (cache hit included) registers a single parent op with
// five sub-steps that step through as the pipeline progresses, so the user
// always has visibility into what's happening. The final label reflects
// the conditioned-forecast verdict ("conditioned" vs "priors only") plus
// total elapsed ms.
//
// Stages are derived from STATS_SUBSYSTEMS.md §4:
//   plan   — planner has built the item list (marked complete at entry).
//   fetch  — per-item fetch loop (detail shows "n/total" during the loop).
//   fe     — FE topo pass (enhanceGraphLatencies) synchronous.
//   be     — BE topo pass (runBeTopoPass + apply) fire-and-forget.
//   cf     — Conditioned forecast (runConditionedForecast + apply) —
//            races 500ms, final label reports "conditioned" / "priors only".
// ────────────────────────────────────────────────────────────────────────

export type PipelineStepId = 'plan' | 'fetch' | 'fe' | 'be' | 'cf';
export type PipelineStepStatus = 'pending' | 'running' | 'complete' | 'error';

export const PIPELINE_STEP_ORDER: PipelineStepId[] = ['plan', 'fetch', 'fe', 'be', 'cf'];
export const PIPELINE_STEP_LABELS: Record<PipelineStepId, string> = {
  plan: 'Fetch plan built',
  fetch: 'Fetching data',
  fe: 'FE analytics',
  be: 'BE analytics',
  cf: 'Producing forecast',
};

interface PipelineSubStep {
  label: string;
  status: PipelineStepStatus;
  detail?: string;
}

const _pipelineStates = new Map<string, PipelineSubStep[]>();

export function initPipelineOp(opId: string): void {
  _pipelineStates.set(
    opId,
    PIPELINE_STEP_ORDER.map((id) => ({
      label: PIPELINE_STEP_LABELS[id],
      status: 'pending' as PipelineStepStatus,
    })),
  );
  operationRegistryService.register({
    id: opId,
    kind: 'fetch-compute',
    label: 'Recomputing…',
    status: 'running',
    progress: { current: 0, total: PIPELINE_STEP_ORDER.length },
  });
}

export function setPipelineStep(
  opId: string,
  stepId: PipelineStepId,
  status: PipelineStepStatus,
  detail?: string,
): void {
  const state = _pipelineStates.get(opId);
  if (!state) return;
  const i = PIPELINE_STEP_ORDER.indexOf(stepId);
  if (i < 0) return;
  state[i] = { label: PIPELINE_STEP_LABELS[stepId], status, detail };
  operationRegistryService.setSubSteps(opId, state.map((s) => ({ ...s })));
  const completeCount = state.filter((s) => s.status === 'complete').length;
  operationRegistryService.setProgress(opId, {
    current: completeCount,
    total: state.length,
  });
}

export function completePipelineOp(
  opId: string,
  outcome: 'complete' | 'warning' | 'error' | 'cancelled',
  finalLabel?: string,
  action?: { label: string; onClick: () => void },
): void {
  if (finalLabel) operationRegistryService.setLabel(opId, finalLabel);
  operationRegistryService.complete(opId, outcome, undefined, action);
  _pipelineStates.delete(opId);
}

// Generation counter: each fetchItems call increments this. The conditioned
// forecast closure captures the current generation and discards its result
// if a newer fetch cycle has started (prevents stale p.mean clobbering).
let _conditionedForecastGeneration = 0;

// Generation counter for BE topo pass (doc 45 §Delivery model): BE topo fires
// alongside FE as a model-var generator. Stale results are discarded so a
// slow response from a previous fetch cycle cannot clobber the current graph.
let _beTopoPassGeneration = 0;

export async function fetchItems(
  items: FetchItem[],
  options: FetchOptions & { onProgress?: (current: number, total: number, item: FetchItem) => void } | undefined,
  graph: Graph,
  setGraph: (g: Graph | null) => void,
  dsl: string,
  getUpdatedGraph?: () => Graph | null
): Promise<FetchResult[]> {
  if (!graph || items.length === 0) return [];

  // Intent integrity guardrail (warn & proceed):
  // An empty DSL means we cannot honour any window/context intent. Default it explicitly and log.
  // This prevents "silent defaults" when a caller forgets to pass the authoritative DSL.
  const effectiveDSL = dsl && dsl.trim() ? dsl : getDefaultDSL();
  if ((!dsl || !dsl.trim()) && (options?.parentLogId || items.length > 1)) {
    const logId = options?.parentLogId;
    if (logId) {
      sessionLogService.addChild(
        logId,
        'warning',
        'DSL_EMPTY_DEFAULTED',
        'Empty DSL provided to fetchItems(); defaulting to a 7-day window',
        effectiveDSL
      );
    }
  }

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
  
  // Cohort-mode semantics (follow-up 2b): do NOT override cohort() retrieval to window().
  const effectiveItems: FetchItem[] = items;

  const batchStart = performance.now();
  const results: FetchResult[] = [];
  const { onProgress, ...itemOptions } = options || {};
  
  // For multiple items: always suppress individual per-item toasts via batch mode.
  // When suppressBatchToast is false (default), also show a visual progress toast in the operation registry.
  // When suppressBatchToast is true, the caller owns the progress UI — we still need batch mode
  // to prevent individual "✓ Updated from X.yaml" toasts from spamming the user.
  const hasMultipleItems = effectiveItems.length > 1;
  const shouldShowBatchProgress = hasMultipleItems && !itemOptions?.suppressBatchToast;
  const shouldSuppressToasts = hasMultipleItems && !!itemOptions?.suppressBatchToast;
  const progressToastId = 'batch-fetch-progress';

  // SESSION LOG: Start batch fetch operation (only for visible batch mode)
  // If parentLogId is provided, add children to that instead of creating new operation
  const useParentLog = !!itemOptions?.parentLogId;
  const batchLogId = useParentLog
    ? itemOptions.parentLogId
    : shouldShowBatchProgress
      ? sessionLogService.startOperation('info', 'data-fetch', 'BATCH_FETCH',
          `Batch fetch: ${effectiveItems.length} items`,
          { dsl: effectiveDSL, itemCount: effectiveItems.length, mode: itemOptions?.mode || 'versioned' },
          { diagnostic: true })
      : undefined;

  if (shouldShowBatchProgress) {
    setBatchMode(true);
    operationRegistryService.register({
      id: progressToastId,
      kind: 'batch-fetch',
      label: 'Fetching',
      status: 'running',
      progress: { current: 0, total: effectiveItems.length },
    });
  } else if (shouldSuppressToasts) {
    // Caller owns progress UI but we still need batch mode to suppress per-item toasts.
    setBatchMode(true);
  }

  // ── Fetch-compute pipeline op (separate from the heavy-fetch batch-fetch op) ──
  // Registered on every fetch cycle (including cache hits). The heavy-fetch
  // `progressToastId` op above keeps its existing behaviour — per-item
  // progress bar during Amplitude fetches. This pipeline op is additive:
  // it shows the macro pipeline stages (plan → fetch → FE → BE → CF) so
  // the user always has visibility into what's happening, including for
  // cached fetches where the batch-fetch op doesn't register.
  // Pipeline indicator: batch callers (regenerateAllLive) set
  // suppressPipelineToast to avoid stacking N per-scenario pipelines.
  // When suppressed, Stage 2's finaliseCfToast emits a single compact
  // per-scenario CF terminal op instead (requires scenarioLabel).
  const pipelineEnabled = !itemOptions?.suppressPipelineToast;
  const pipelineOpId = pipelineEnabled
    ? `fetch-pipeline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    : '';
  const pipelineStartMs = Date.now();
  if (pipelineEnabled) {
    initPipelineOp(pipelineOpId);
    setPipelineStep(pipelineOpId, 'plan', 'complete', `${effectiveItems.length} item${effectiveItems.length !== 1 ? 's' : ''}`);
    setPipelineStep(pipelineOpId, 'fetch', 'running', `0/${effectiveItems.length}`);
  }
  
  let successCount = 0;
  let errorCount = 0;
  let rateLimitAborted = false;
  let rateLimitSkipped = 0;

  try {
    for (let i = 0; i < effectiveItems.length; i++) {
      onProgress?.(i + 1, effectiveItems.length, effectiveItems[i]);

      if (shouldShowBatchProgress) {
        operationRegistryService.setProgress(progressToastId, { current: i, total: effectiveItems.length });
      }
      setPipelineStep(pipelineOpId, 'fetch', 'running', `${i}/${effectiveItems.length}`);

      // CRITICAL: Use getUpdatedGraph() to get fresh graph for each item
      // This ensures rebalancing from previous items is preserved
      // Without this, each item clones the ORIGINAL graph, losing sibling rebalancing
      const currentGraph = getUpdatedGraph?.() ?? latestGraph ?? graph;

      let result = await fetchSingleItemInternal(
        effectiveItems[i],
        itemOptions,
        currentGraph,
        trackingSetGraph,
        effectiveDSL,
        getUpdatedGraph
      );

      // --- Timeout detection + quick retry with backoff ---
      if (
        !result.success &&
        result.error &&
        rateLimiter.isTimeoutError(result.error.message) &&
        !rateLimiter.isExplicitRateLimitError(result.error.message)
      ) {
        const MAX_TIMEOUT_RETRIES = 2;
        const TIMEOUT_BACKOFF_BASE_MS = 15_000; // 15s, 30s for manual runs
        let retrySucceeded = false;

        for (let attempt = 1; attempt <= MAX_TIMEOUT_RETRIES; attempt++) {
          const backoffMs = TIMEOUT_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
          if (batchLogId) {
            sessionLogService.addChild(
              batchLogId,
              'warning',
              'TIMEOUT_RETRY',
              `Item ${effectiveItems[i].name} timed out — retry ${attempt}/${MAX_TIMEOUT_RETRIES} after ${Math.round(backoffMs / 1000)}s`,
              result.error.message,
            );
          }

          await new Promise(resolve => setTimeout(resolve, backoffMs));

          const retryGraph = getUpdatedGraph?.() ?? latestGraph ?? graph;
          const retryResult = await fetchSingleItemInternal(
            effectiveItems[i],
            itemOptions,
            retryGraph,
            trackingSetGraph,
            effectiveDSL,
            getUpdatedGraph,
          );

          if (retryResult.success) {
            results.push(retryResult);
            successCount++;
            retrySucceeded = true;
            break;
          }

          // If retry got a 429, stop retrying — fall through to cooldown
          if (retryResult.error && rateLimiter.isExplicitRateLimitError(retryResult.error.message)) {
            // Use the 429 result for the cooldown path below
            result = retryResult;
            break;
          }

          // Last attempt still failed
          if (attempt === MAX_TIMEOUT_RETRIES) {
            results.push(retryResult);
            errorCount++;
            retrySucceeded = true; // Not really "succeeded" but handled — skip cooldown
          }
        }

        if (retrySucceeded) continue;
        // If we get here, a retry returned a 429 — fall through to cooldown below
      }

      // --- Explicit rate limit (429) detection + countdown + retry ---
      if (
        !result.success &&
        result.error &&
        rateLimiter.isExplicitRateLimitError(result.error.message)
      ) {
        // Don't push the failed result yet — we'll retry after countdown.
        const cooldownMinutes = getEffectiveRateLimitCooloffMinutes();

        if (batchLogId) {
          sessionLogService.addChild(
            batchLogId,
            'warning',
            'RATE_LIMIT_HIT',
            `Item ${effectiveItems[i].name} hit rate limit — starting ${cooldownMinutes}m countdown`,
            result.error.message,
            { itemIndex: i, itemName: effectiveItems[i].name, cooldownMinutes },
          );
        }

        const countdownResult = await startRateLimitCountdown({
          cooldownMinutes,
          logOpId: batchLogId,
          label: `Amplitude rate limit — retrying in ${cooldownMinutes}m`,
        });

        if (countdownResult === 'aborted') {
          // User aborted: record the original failure, skip remaining items.
          results.push(result);
          errorCount++;
          rateLimitAborted = true;
          rateLimitSkipped = effectiveItems.length - i - 1;
          break;
        }

        // Countdown expired — retry the same item.
        // Use a fresh graph in case the user edited during the wait.
        const retryGraph = getUpdatedGraph?.() ?? latestGraph ?? graph;
        const retryResult = await fetchSingleItemInternal(
          effectiveItems[i],
          itemOptions,
          retryGraph,
          trackingSetGraph,
          effectiveDSL,
          getUpdatedGraph,
        );
        results.push(retryResult);

        if (retryResult.success) {
          successCount++;
        } else {
          errorCount++;
        }
        // Continue to next item (even if retry failed — don't loop forever).
        continue;
      }

      results.push(result);

      if (result.success) {
        successCount++;
      } else {
        errorCount++;
      }
    }
    
    // Finalise the heavy-fetch batch-fetch op (existing behaviour).
    if (shouldShowBatchProgress) {
      operationRegistryService.setProgress(progressToastId, { current: effectiveItems.length, total: effectiveItems.length });
      if (rateLimitAborted) {
        const msg = `Fetched ${successCount}/${effectiveItems.length} (rate limit — ${rateLimitSkipped} skipped)`;
        operationRegistryService.complete(progressToastId, 'error', msg);
      } else if (errorCount > 0) {
        operationRegistryService.complete(progressToastId, 'error', `Fetched ${successCount}/${effectiveItems.length} (${errorCount} failed)`);
      } else {
        operationRegistryService.setLabel(progressToastId, `Fetched ${successCount} item${successCount !== 1 ? 's' : ''}`);
        operationRegistryService.complete(progressToastId, 'complete');
      }
    }

    // Finalise the "Fetching data" sub-step of the pipeline op. Stage 2
    // will pick up from here (FE analytics → BE analytics → CF).
    if (rateLimitAborted) {
      setPipelineStep(pipelineOpId, 'fetch', 'error',
        `${successCount}/${effectiveItems.length} (rate limit — ${rateLimitSkipped} skipped)`);
      completePipelineOp(pipelineOpId, 'error',
        `Fetch aborted — rate limit (${successCount}/${effectiveItems.length})`);
    } else if (errorCount > 0) {
      setPipelineStep(pipelineOpId, 'fetch', 'error',
        `${successCount}/${effectiveItems.length} (${errorCount} failed)`);
      // Don't complete the parent yet — Stage 2 still runs for successful
      // items. Stage 2 will complete the parent op at CF resolution.
    } else {
      setPipelineStep(pipelineOpId, 'fetch', 'complete',
        `${successCount} item${successCount !== 1 ? 's' : ''}`);
    }
    
    if (successCount > 0 && !itemOptions?.skipStage2) {
      const finalGraph = getUpdatedGraph?.() ?? latestGraph ?? graph;
      if (finalGraph) {
        await runStage2EnhancementsAndInboundN(
          items,
          effectiveItems,
          itemOptions,
          finalGraph,
          trackingSetGraph,
          dsl,
          batchLogId,
          getUpdatedGraph,
          itemOptions?.awaitBackgroundPromises,
          pipelineEnabled ? pipelineOpId : undefined,
          pipelineStartMs,
        );
      } else {
        // No graph to enrich — pipeline ends here.
        setPipelineStep(pipelineOpId, 'fe', 'error', 'no graph');
        completePipelineOp(pipelineOpId, errorCount > 0 ? 'error' : 'warning',
          `Recomputed (no graph, ${(Date.now() - pipelineStartMs).toLocaleString()}ms)`);
      }
    } else if (!itemOptions?.skipStage2) {
      // No items succeeded → Stage 2 won't run. Close out the pipeline
      // op here so the indicator doesn't sit on 'fetch' forever.
      completePipelineOp(pipelineOpId, errorCount > 0 ? 'error' : 'warning',
        errorCount > 0
          ? `Fetch failed (${(Date.now() - pipelineStartMs).toLocaleString()}ms)`
          : `Nothing to fetch (${(Date.now() - pipelineStartMs).toLocaleString()}ms)`);
    } else {
      // Caller skipped Stage 2 — complete the pipeline op at the fetch stage.
      completePipelineOp(pipelineOpId, errorCount > 0 ? 'error' : 'complete',
        `Fetched ${successCount}/${effectiveItems.length} (${(Date.now() - pipelineStartMs).toLocaleString()}ms)`);
    }
  } finally {
    // Always reset batch mode
    if (shouldShowBatchProgress) {
      discardBatchMode();   // fetchDataService already showed its own progress toast; don't duplicate with batch summary
    } else if (shouldSuppressToasts) {
      discardBatchMode();   // clears buffer without showing any toast
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
 * Stage-2 post-fetch graph derivations:
 * - Graph-level LAG topo pass (t95, path_t95, completeness, blended mean)
 * - Inbound-n propagation
 *
 * CRITICAL: This function is a mechanical extraction of the previous inline code,
 * to allow callers like "Retrieve All Slices" to reuse the exact same behaviour
 * and logging without maintaining a second code path.
 */
export async function runStage2EnhancementsAndInboundN(
  items: FetchItem[],
  effectiveItems: FetchItem[],
  itemOptions: FetchOptions,
  finalGraph: Graph,
  setGraph: (g: Graph | null) => void,
  dsl: string,
  batchLogId?: string,
  // Optional getter for the freshest graph; used so fire-and-forget
  // callbacks (BE topo pass) land on top of anything applied meanwhile
  // (e.g. the conditioned forecast's p.mean).
  getUpdatedGraph?: () => Graph | null,
  // Optional: when true, await all fire-and-forget background handlers
  // (BE topo pass .then(), CF slow-path .then()) before returning.
  // The browser wants fire-and-forget (fast first render, async catch-up).
  // The CLI wants deterministic final output, so it sets this to true.
  awaitBackgroundPromises?: boolean,
  // Optional: id of the fetch-compute pipeline op registered by fetchItems.
  // When provided, this function updates the FE / BE / CF sub-steps as
  // each pass fires/completes, and completes the parent op at CF
  // resolution. When undefined (direct callers like retrieveAllSlices
  // that don't use fetchItems), sub-step updates are no-ops.
  pipelineOpId?: string,
  pipelineStartMs?: number,
): Promise<void> {
  // Local shorthand: guard sub-step updates on pipelineOpId presence
  // so direct callers without a pipeline op don't fire no-op lookups.
  const updatePipelineStep = (
    stepId: PipelineStepId,
    status: PipelineStepStatus,
    detail?: string,
  ) => {
    if (pipelineOpId) setPipelineStep(pipelineOpId, stepId, status, detail);
  };
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
        // Check if any fetched items were parameters on latency edges (BOTH edge.p AND edge.conditional_p[i].p)
        const latencyCheck = effectiveItems.map(item => {
          if (item.type !== 'parameter') return { item: item.name, hasLatency: false, reason: 'not parameter' };
          const edge = finalGraph.edges?.find((e: any) => 
            e.uuid === item.targetId || e.id === item.targetId
          );
          if (!edge) return { item: item.name, hasLatency: false, reason: 'edge not found' };
          
          // Check base edge probability
          const baseHasLatency = edge?.p?.latency?.latency_parameter === true;
          
          // Check conditional probabilities (PARITY PRINCIPLE: conditional_p must be first-class)
          const conditionalLatency = (edge.conditional_p || []).map((cp: any, idx: number) => ({
            index: idx,
            hasLatency: cp?.p?.latency?.latency_parameter === true,
            t95: cp?.p?.latency?.t95,
          }));
          const anyConditionalHasLatency = conditionalLatency.some((c: any) => c.hasLatency);
          
          return { 
            item: item.name, 
            hasLatency: baseHasLatency || anyConditionalHasLatency, 
            latency_parameter: edge?.p?.latency?.latency_parameter,
            t95: edge?.p?.latency?.t95,
            edgeId: edge.uuid || edge.id,
            conditionalLatency,
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
            
            const baseEdgeId = edge.uuid || edge.id || `${edge.from}->${edge.to}`;
            
            // PARITY PRINCIPLE: conditional_p parameters use composite key format
            // Base probability: "edgeId"
            // Conditional probability: "edgeId:conditional[N]"
            const conditionalIndex = (item as any).conditionalIndex;
            const paramLookupKey = typeof conditionalIndex === 'number' 
              ? `${baseEdgeId}:conditional[${conditionalIndex}]`
              : baseEdgeId;
            
            // Try param file from registry first
            let allValues: ParameterValueForLAG[] | undefined;
            if (item.objectId) {
              const paramFile = fileRegistry.getFile(`parameter-${item.objectId}`);
              if (paramFile?.data?.values) {
                allValues = paramFile.data.values as ParameterValueForLAG[];
              }
            }
            
            // Fall back to edge's direct data if no param file
            // NOTE: For conditional params, fall back to conditional_p[N].p.values
            if (!allValues) {
              if (typeof conditionalIndex === 'number') {
                allValues = edge.conditional_p?.[conditionalIndex]?.p?.values as ParameterValueForLAG[];
              } else {
                allValues = edge.p?.values as ParameterValueForLAG[];
              }
            }
            
            if (allValues && allValues.length > 0) {
              // Filter values to:
              // 1. Same context/case dimensions (or implicit MECE partition when target is uncontexted)
              // 2. COHORT slices with dates overlapping the query window (when explicit cohort() DSL)
              // 3. WINDOW slices (for forecast baseline)

              const hasAnyExplicitUncontexted = allValues.some((v: any) => extractSliceDimensions(v.sliceDSL ?? '') === '');

              // Implicit uncontexted fallback:
              // If the active DSL is uncontexted (targetDims='') but the param file has ONLY contexted slices,
              // attempt to treat a MECE partition as the implicit uncontexted truth for LAG.
              let filteredValues: ParameterValueForLAG[] | null = null;
              if (targetDims === '' && !hasAnyExplicitUncontexted) {
                const cohortVals = (allValues as any[]).filter((v) => (v.sliceDSL ?? '').includes('cohort('));
                const windowVals = (allValues as any[]).filter((v) => (v.sliceDSL ?? '').includes('window(') && !(v.sliceDSL ?? '').includes('cohort('));

                const out: ParameterValueForLAG[] = [];
                try {
                  const meceCohort = await resolveMECEPartitionForImplicitUncontexted(cohortVals as any);
                  if (meceCohort.kind === 'mece_partition' && meceCohort.canAggregate) {
                    out.push(...(meceCohort.values as any));
                  }
                } catch (e) {
                  console.warn('[fetchDataService] Failed MECE cohort partition resolution for LAG:', e);
                }
                try {
                  const meceWindow = await resolveMECEPartitionForImplicitUncontexted(windowVals as any);
                  if (meceWindow.kind === 'mece_partition' && meceWindow.canAggregate) {
                    out.push(...(meceWindow.values as any));
                  }
                } catch (e) {
                  console.warn('[fetchDataService] Failed MECE window partition resolution for LAG:', e);
                }

                if (out.length > 0) {
                  // De-dup identical object refs
                  const uniq = Array.from(new Set(out));
                  filteredValues = uniq;
                } else {
                  filteredValues = [];
                }
              }

              // Default path: match exact dimensions
              if (!filteredValues) {
                filteredValues = allValues.filter((v: any) => {
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
              }
              
              console.log('[fetchDataService] Filtered param values for LAG:', {
                paramLookupKey,
                baseEdgeId,
                conditionalIndex,
                targetDims,
                lagSliceSource,
                hasCohortFilter: !!(cohortStart && cohortEnd),
                hasLAGWindow: !!(lagSliceStart && lagSliceEnd),
                totalValues: allValues.length,
                filteredValues: filteredValues.length,
                sampleSliceDSLs: allValues.slice(0, 3).map((v: any) => v.sliceDSL),
              });
              
              if (filteredValues.length > 0) {
                paramLookup.set(paramLookupKey, filteredValues);
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
          
          let implicitQueryDateFromDsl: Date | null = null;
          if (parsedDSL.asat) {
            try {
              implicitQueryDateFromDsl = parseDate(resolveRelativeDate(parsedDSL.asat));
            } catch (err) {
              console.warn('[fetchDataService] Failed to resolve asat() analysis date:', err);
            }
          }

          // Use the caller override when present. Otherwise, asat() defines the
          // point-in-time evaluation date for historical queries; only fall back
          // to "now" when the DSL is not historical.
          const queryDateForLAG = itemOptions?.queryDate ?? implicitQueryDateFromDsl ?? new Date();
          
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
          
          const forecasting = await forecastingSettingsService.getForecastingModelSettings();

          // ── First-fetch horizon bootstrap (FE-only, no BE network call) ──
          // If any latency edge's param file has no mu/sigma, compute
          // horizons using FE's own fitting primitives and persist before
          // the topo pass runs. Inline — no second fetch, no server needed.
          {
            const edgesMissingHorizons = (finalGraph?.edges ?? []).filter((e: any) => {
              if (!e?.p?.latency?.latency_parameter) return false;
              const pid = e.p?.id;
              if (!pid) return false;
              const pf = fileRegistry.getFile(`parameter-${pid}`)?.data;
              const fl = (pf as any)?.latency;
              const missing = !fl?.mu && !fl?.sigma;
              if (e.p.latency.latency_parameter) {
                console.log(`[HORIZON_BOOTSTRAP_CHECK] ${pid}: file.latency.mu=${fl?.mu}, file.latency.sigma=${fl?.sigma}, missing=${missing}`);
              }
              return missing;
            });
            console.log(`[HORIZON_BOOTSTRAP_CHECK] ${edgesMissingHorizons.length} edges need horizons`);
            if (edgesMissingHorizons.length > 0) {
              console.log(`[fetchDataService] Horizon bootstrap (FE): ${edgesMissingHorizons.length} edges missing mu/sigma`);
              try {
                const { computeEdgeLatencyStats } = await import('./statisticalEnhancementService');
                const { upsertModelVars, ukDateNow } = await import('./modelVarsResolution');

                const MODEL = forecasting;
                let bootstrapped = 0;

                for (const edge of edgesMissingHorizons) {
                  const edgeId = edge.uuid || edge.id;
                  if (!edgeId || !edge.p?.latency) continue;
                  const paramValues = paramLookup.get(edgeId);
                  if (!paramValues || paramValues.length === 0) continue;

                  // Aggregate cohorts (global, un-windowed — same as old BE bootstrap)
                  const cohorts = lagHelpers.aggregateCohortData(paramValues, queryDateForLAG, undefined);
                  if (cohorts.length === 0) continue;

                  // Compute aggregate lag stats
                  const lagStats = aggregateLatencyStats(cohorts, MODEL.RECENCY_HALF_LIFE_DAYS);
                  if (!lagStats) continue;

                  // Read onset from graph edge
                  const onsetDeltaDays = edge.p?.latency?.onset_delta_days ?? 0;

                  // Read authoritative t95 from edge if set
                  const edgeT95 = edge.p?.latency?.t95;
                  const validEdgeT95 = typeof edgeT95 === 'number' && Number.isFinite(edgeT95) && edgeT95 > 0
                    ? edgeT95 : undefined;

                  // Fit edge using the same function the FE topo pass uses
                  const stats = computeEdgeLatencyStats(
                    cohorts,
                    lagStats.median_lag_days,
                    lagStats.mean_lag_days,
                    MODEL.DEFAULT_T95_DAYS,
                    0,  // anchorMedianLag — bootstrap has no upstream context
                    undefined,  // fitTotalKOverride
                    undefined,  // pInfinityCohortsOverride
                    validEdgeT95,
                    MODEL.RECENCY_HALF_LIFE_DAYS,
                    onsetDeltaDays,
                    MODEL.LATENCY_MAX_MEAN_MEDIAN_RATIO,
                    true,  // applyAnchorAgeAdjustment — cohort mode default
                  );

                  if (!stats.fit || !Number.isFinite(stats.fit.mu) || !Number.isFinite(stats.fit.sigma)) continue;

                  // Write to graph edge (so topo pass can read them)
                  const ep = edge.p!;
                  const lat = ep.latency!;
                  lat.mu = stats.fit.mu;
                  lat.sigma = stats.fit.sigma;
                  lat.t95 = stats.t95;

                  // Rebuild analytic model_vars entry with latency
                  const pid = ep.id;
                  const pf = pid ? fileRegistry.getFile(`parameter-${pid}`)?.data : null;
                  const latestValue = (pf as any)?.values?.[0];
                  if (latestValue) {
                    const analyticEntry: any = {
                      source: 'analytic',
                      source_at: (latestValue as any).data_source?.retrieved_at || ukDateNow(),
                      probability: {
                        mean: latestValue.mean ?? 0,
                        stdev: latestValue.stdev ?? 0,
                      },
                      latency: {
                        mu: stats.fit.mu,
                        sigma: stats.fit.sigma,
                        t95: stats.t95,
                        onset_delta_days: onsetDeltaDays,
                      },
                    };
                    upsertModelVars(ep, analyticEntry);
                  }
                  bootstrapped++;
                }

                if (bootstrapped > 0) {
                  // Persist to param files
                  await persistGraphMasteredLatencyToParameterFiles({
                    graph: finalGraph as any,
                    setGraph: setGraph as any,
                    edgeIds: edgesMissingHorizons.map((e: any) => e.uuid || e.id),
                  });
                  console.log(`[fetchDataService] Horizon bootstrap (FE): persisted horizons for ${bootstrapped} edges`);
                }
              } catch (e: any) {
                console.warn('[fetchDataService] Horizon bootstrap failed (non-fatal):', e?.message || e);
              }
            }
          }

          // Pre-compute path_t95 for all edges ONCE (single code path)
          // This is used by enhanceGraphLatencies to classify edges
          const activeEdgesForLAG = getActiveEdges(finalGraph as GraphForPath);
          const pathT95MapForLAG = computePathT95(
            finalGraph as GraphForPath,
            activeEdgesForLAG,
            undefined,
            forecasting.DEFAULT_T95_DAYS
          );
          
          updatePipelineStep('fe', 'running');
          const feStartMs = Date.now();
          const lagResult = enhanceGraphLatencies(
            finalGraph as GraphForPath,
            paramLookup,
            queryDateForLAG,
            lagHelpers,
            lagCohortWindow,
            undefined, // whatIfDSL
            pathT95MapForLAG,
            lagSliceSource,
            forecasting
          );
          updatePipelineStep('fe', 'complete',
            `${lagResult.edgesWithLAG} edge${lagResult.edgesWithLAG !== 1 ? 's' : ''}, ${(Date.now() - feStartMs).toLocaleString()}ms`);

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

          // Stash FE topo pass outputs so the BE topo pass can log a complete
          // parity fixture (BE inputs + FE outputs) via console mirroring.
          if (import.meta.env?.DEV && typeof window !== 'undefined') {
            (window as any).__feTopoFixtureOutputs = {
              edges_processed: lagResult.edgesProcessed,
              edges_with_lag: lagResult.edgesWithLAG,
              edge_values: lagResult.edgeValues.map(v => ({
                edge_uuid: v.edgeUuid, conditional_index: v.conditionalIndex ?? null,
                t95: v.latency.t95, path_t95: v.latency.path_t95, completeness: v.latency.completeness,
                mu: v.latency.mu, sigma: v.latency.sigma,
                onset_delta_days: v.latency.promoted_onset_delta_days ?? null,
                median_lag_days: v.latency.median_lag_days ?? null, mean_lag_days: v.latency.mean_lag_days ?? null,
                path_mu: v.latency.path_mu ?? null, path_sigma: v.latency.path_sigma ?? null,
                path_onset_delta_days: v.latency.path_onset_delta_days ?? null,
                blended_mean: v.blendedMean ?? null,
              })),
            };
          }
          
          // ════════════════════════════════════════════════════════════════
          // FE + BE TOPO PASS + CONDITIONED FORECAST APPLICATION
          // (doc 45 §Delivery model, doc 50 §3.2, STATS_SUBSYSTEMS.md,
          //  FE_BE_STATS_PARALLELISM.md)
          //
          // Three independent subsystems write to the graph:
          //
          //  - FE topo pass (synchronous, already run above via
          //    enhanceGraphLatencies). Authoritative for `p.latency.*`;
          //    populates `model_vars[analytic]`. Its apply path requires
          //    `lagResult.edgeValues` to be non-empty — if the query-scoped
          //    YAML evidence is absent, FE has nothing to apply.
          //
          //  - BE topo pass (fire-and-forget). A model-var generator that
          //    populates `model_vars[analytic_be]`; promotion decides which
          //    source's latency params land on the edge. MUST NOT overwrite
          //    `p.latency.*` directly. Consults the snapshot DB server-side,
          //    so it does NOT depend on YAML-aggregated evidence being
          //    present. Fires on every query.
          //
          //  - Conditioned forecast (races a 500ms fast deadline). The
          //    authoritative writer of `p.mean` / `p.sd` /
          //    `latency.completeness*`. Reads the snapshot DB directly per
          //    doc 50, so it too is independent of YAML evidence. Doc 50
          //    §3.2 binds it to a per-edge contract: a real estimate for
          //    every edge with a prior or snapshot evidence, otherwise a
          //    structured `skipped_edges` entry. No silent drops.
          //
          // The BE topo pass and CF both fire on every query. Earlier code
          // gated them behind `lagResult.edgeValues.length > 0`, which
          // meant a narrow cohort (or any query that turned up no YAML
          // evidence) silently disabled the two subsystems that would have
          // answered it correctly from the snapshot DB. That gating was
          // pathological and contradicted doc 50's "no silent drops"
          // invariant; it is removed here.
          //
          // Generation counters (_beTopoPassGeneration,
          // _conditionedForecastGeneration) guard against a stale response
          // from a previous fetch cycle clobbering the current graph.
          // ════════════════════════════════════════════════════════════════
          const updateManager = new UpdateManager();
          const preserveLatencySummaryFromFile = itemOptions?.mode === 'from-file';
          const feEdgeValues = lagResult.edgeValues;
          let appliedEdgeValuesForFinalGraph = feEdgeValues;
          // Collect fire-and-forget background handler chains so
          // callers that need deterministic final state (CLI) can
          // await them via the awaitBackgroundPromises option.
          const backgroundPromises: Promise<unknown>[] = [];

          const applyQueryOwnedCompleteness = (
            graph: any,
            edgeValues: typeof feEdgeValues,
          ): void => {
            for (const ev of edgeValues) {
              const edge = graph?.edges?.find((e: any) => e.uuid === ev.edgeUuid || e.id === ev.edgeUuid);
              const targetP = typeof ev.conditionalIndex === 'number'
                ? edge?.conditional_p?.[ev.conditionalIndex]?.p
                : edge?.p;
              if (!targetP?.latency) continue;
              targetP.latency.completeness = ev.latency.completeness;
              const completenessStdev = (ev.latency as any).completeness_stdev;
              if (completenessStdev != null && Number.isFinite(completenessStdev)) {
                targetP.latency.completeness_stdev = completenessStdev;
              }
            }
          };

          const materialiseFeEdgeValues = async (
            graph: any,
            edgeValues: typeof feEdgeValues,
          ): Promise<any> => {
              const nextGraph = updateManager.applyBatchLAGValues(
                graph,
                edgeValues.map(ev => ({
                  edgeId: ev.edgeUuid,
                  conditionalIndex: ev.conditionalIndex,
                  latency: preserveLatencySummaryFromFile
                    ? (() => {
                        const edge = graph.edges?.find((e: any) => e.uuid === ev.edgeUuid || e.id === ev.edgeUuid);
                        const existing = typeof ev.conditionalIndex === 'number'
                          ? edge?.conditional_p?.[ev.conditionalIndex]?.p?.latency
                          : edge?.p?.latency;
                        return selectLatencyToApplyForTopoPass(ev.latency, existing, true);
                      })()
                    : ev.latency,
                  blendedMean: ev.blendedMean,
                  forecast: ev.forecast,
                  evidence: ev.evidence,
                })),
                { writeHorizonsToGraph: itemOptions?.writeLagHorizonsToGraph === true }
              );

              const { applyPromotion } = await import('./modelVarsResolution');

              // Update analytic model_vars entries with topo pass results
              for (const ev of edgeValues) {
                const edge = nextGraph.edges?.find((e: any) => e.uuid === ev.edgeUuid || e.id === ev.edgeUuid);
                if (!edge?.p?.model_vars) continue;
                const existing = edge.p.model_vars.find((v: any) => v.source === 'analytic');
                if (!existing) continue;

                // Doc 45: topo pass writes model vars only. p.mean is set
                // by the conditioned forecast (Job B).
                if (ev.latency?.mu != null) {
                  const prev: Record<string, any> = existing.latency || {};
                  existing.latency = mergeModelVarsLatencyPreservingCanonicalEdgeLatency(
                    {
                      mu: ev.latency.mu!,
                      sigma: ev.latency.sigma!,
                      t95: ev.latency.t95,
                      onset_delta_days: ev.latency.promoted_onset_delta_days ?? 0,
                      ...(ev.latency.path_mu != null ? { path_mu: ev.latency.path_mu } : {}),
                      ...(ev.latency.path_sigma != null ? { path_sigma: ev.latency.path_sigma } : {}),
                      ...(ev.latency.path_t95 != null ? { path_t95: ev.latency.path_t95 } : {}),
                      ...(ev.latency.path_onset_delta_days != null ? { path_onset_delta_days: ev.latency.path_onset_delta_days } : {}),
                      ...(ev.latency.mu_sd != null ? { mu_sd: ev.latency.mu_sd } : {}),
                      ...(ev.latency.sigma_sd != null ? { sigma_sd: ev.latency.sigma_sd } : {}),
                      ...(ev.latency.onset_sd != null ? { onset_sd: ev.latency.onset_sd } : {}),
                      ...(ev.latency.onset_mu_corr != null ? { onset_mu_corr: ev.latency.onset_mu_corr } : {}),
                      ...(ev.latency.path_mu_sd != null ? { path_mu_sd: ev.latency.path_mu_sd } : {}),
                      ...(ev.latency.path_sigma_sd != null ? { path_sigma_sd: ev.latency.path_sigma_sd } : {}),
                      ...(ev.latency.path_onset_sd != null ? { path_onset_sd: ev.latency.path_onset_sd } : {}),
                    },
                    prev,
                  );
                }
                if (ev.latency?.p_sd != null && Number.isFinite(ev.latency.p_sd) && ev.latency.p_sd > 0) {
                  existing.probability.stdev = ev.latency.p_sd;
                }
              }

              // Re-run promotion so promoted_* scalars reflect analytic entries
              for (const edge of (nextGraph.edges ?? []) as any[]) {
                if (edge.p?.model_vars?.length) {
                  applyPromotion(edge.p, (nextGraph as any).model_source_preference);
                }
              }

              // Completeness is query-authored display state, not a promoted model
              // parameter. Reassert the freshly computed / CF-merged value after the
              // promotion cascade so stale file-saved completeness cannot leak back in.
              applyQueryOwnedCompleteness(nextGraph, edgeValues);

              return nextGraph;
            };

          // ── Fire BE topo pass (model var generator, fire-and-forget) ──
          // Fires on every query. Independent of FE LAG output — consults
          // the snapshot DB server-side.
          updatePipelineStep('be', 'running');
          const { runBeTopoPass } = await import('./beTopoPassService');
          const beGen = ++_beTopoPassGeneration;
          const beStartTime = Date.now();
          if (batchLogId) {
            sessionLogService.addChild(batchLogId, 'info', 'BE_TOPO_PASS',
              `BE topo pass started for ${feEdgeValues.length} edges (gen ${beGen})`,
            );
          }
          const bePromise = runBeTopoPass(
            finalGraph, paramLookup, queryDateForLAG, lagHelpers, lagCohortWindow,
            lagSliceSource, activeEdgesForLAG,
          ).catch(e => {
            console.warn('[fetchDataService] BE topo pass failed:', e);
            if (batchLogId) {
              sessionLogService.addChild(batchLogId, 'error', 'BE_TOPO_PASS',
                `BE topo pass failed: ${e?.message || e}`,
              );
            }
            return null;
          });

          // CF must consume the FE-authored graph state even while the UI apply
          // is still held behind the 500ms race. Otherwise the request graph can
          // still carry empty-evidence stub means that FE has already superseded.
          const cfInputGraph = feEdgeValues.length > 0
            ? await materialiseFeEdgeValues(finalGraph, feEdgeValues)
            : finalGraph;

          // ── Fire conditioned forecast ──
          // Fires on every query per doc 50 §3.2 "no silent drops".
          // When the FE LAG apply runs, CF is raced against a 500ms deadline
          // so its p.mean can be folded into the FE apply (single render).
          // When FE has no values to apply, CF is the sole writer of p.mean
          // and applies its own results on arrival via
          // applyConditionedForecastToGraph.
          updatePipelineStep('cf', 'running');
          const { runConditionedForecast, applyConditionedForecastToGraph } =
            await import('./conditionedForecastService');
          const cfGen = ++_conditionedForecastGeneration;
          const cfStartTime = Date.now();
          if (batchLogId) {
            sessionLogService.addChild(batchLogId, 'info', 'CONDITIONED_FORECAST',
              `Conditioned forecast started (gen ${cfGen}, dsl=${(dsl || '').slice(0, 80)})`);
          }
          const cfPromise = runConditionedForecast(
            cfInputGraph,
            dsl,
            undefined,
            itemOptions?.workspace,
          ).catch(e => {
            console.warn('[fetchDataService] Conditioned forecast failed:', e);
            if (batchLogId) {
              sessionLogService.addChild(batchLogId, 'error', 'CONDITIONED_FORECAST',
                `Conditioned forecast failed: ${e?.message || e}`);
            }
            return [] as Awaited<ReturnType<typeof runConditionedForecast>>;
          });

          // Finalise the CF sub-step of the fetch-compute pipeline op
          // (and complete the parent op). Called exactly once per cfGen
          // from whichever branch resolves CF (fast, fast-empty, slow,
          // slow-empty, error, stale). Sub-step detail reports whether
          // any edge had observed evidence applied ("conditioned") or
          // all edges fell back to the prior ("priors only"). Includes
          // elapsed ms. Parent op's final label mirrors that summary
          // so the collapsed toast shows the verdict.
          let cfToastFinalised = false;
          const finaliseCfToast = (
            results: Awaited<ReturnType<typeof runConditionedForecast>> | null,
            outcome: 'resolved' | 'empty' | 'error' | 'stale',
          ) => {
            if (cfToastFinalised) return;
            cfToastFinalised = true;
            const elapsedMs = Date.now() - cfStartTime;
            const ms = elapsedMs.toLocaleString();
            const totalMs = pipelineStartMs != null
              ? (Date.now() - pipelineStartMs).toLocaleString()
              : ms;

            // Compute the CF verdict once (status + detail + labels).
            // Dispatched to two sinks:
            //   - Pipeline op path: updatePipelineStep + completePipelineOp
            //     with the full "Recomputed — …" label (classic single-graph
            //     fetch indicator).
            //   - Per-scenario terminal op path (when pipeline is suppressed
            //     and itemOptions.scenarioLabel is provided): emits one
            //     compact op carrying just the scenario name + CF verdict,
            //     so bulk regen over N scenarios produces N legible recent
            //     entries instead of N full 5-step pipelines.
            type Verdict = 'complete' | 'warning' | 'error' | 'cancelled';
            let verdict: Verdict;
            let cfStepStatus: PipelineStepStatus;
            let cfStepDetail: string;
            let parentLabel: string;
            let scenarioSuffix: string;

            if (outcome === 'stale') {
              verdict = 'cancelled';
              cfStepStatus = 'error';
              cfStepDetail = `discarded (${ms}ms)`;
              parentLabel = `Recomputed — CF superseded (${totalMs}ms)`;
              scenarioSuffix = `CF superseded (${ms}ms)`;
            } else if (outcome === 'error') {
              verdict = 'error';
              cfStepStatus = 'error';
              cfStepDetail = `failed (${ms}ms)`;
              parentLabel = `Recomputed — CF failed (${totalMs}ms)`;
              scenarioSuffix = `CF failed (${ms}ms)`;
            } else {
              const edges = (results && results.length > 0 && results[0]?.edges) || [];
              const withP = edges.filter(e => e.p_mean != null && Number.isFinite(e.p_mean as number));
              if (outcome === 'empty' || edges.length === 0 || withP.length === 0) {
                verdict = 'warning';
                cfStepStatus = 'error';
                cfStepDetail = `no result (${ms}ms)`;
                parentLabel = `Recomputed — CF returned no result (${totalMs}ms)`;
                scenarioSuffix = `CF: no result (${ms}ms)`;
              } else {
                const conditionedCount = withP.filter(e => e.conditioned === true).length;
                const total = withP.length;
                if (conditionedCount > 0) {
                  verdict = 'complete';
                  cfStepStatus = 'complete';
                  cfStepDetail = `${conditionedCount}/${total} conditioned, ${ms}ms`;
                  parentLabel = `Conditioned forecast returned in ${ms}ms (${conditionedCount}/${total} conditioned)`;
                  scenarioSuffix = `CF ${ms}ms (${conditionedCount}/${total} conditioned)`;
                } else {
                  verdict = 'complete';
                  cfStepStatus = 'complete';
                  cfStepDetail = `priors only, ${total} edges, ${ms}ms`;
                  parentLabel = `Conditioned forecast: priors only, ${ms}ms (${total} edges)`;
                  scenarioSuffix = `CF: priors only, ${ms}ms`;
                }
              }
            }

            updatePipelineStep('cf', cfStepStatus, cfStepDetail);

            if (pipelineOpId) {
              completePipelineOp(pipelineOpId, verdict, parentLabel);
              return;
            }

            const scenarioLabel = itemOptions?.scenarioLabel;
            if (scenarioLabel) {
              const opId = `scenario-cf-${scenarioLabel.replace(/\s+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
              operationRegistryService.register({
                id: opId,
                kind: 'scenario-cf',
                label: `${scenarioLabel} · ${scenarioSuffix}`,
                status: 'running',
              });
              operationRegistryService.complete(opId, verdict);
            }
          };

          // ── Helper: apply FE edge values through UpdateManager + analytic model_vars ──
          // Accepts the edge values to apply so the CF fast path can pass a
          // copy with p.mean already merged (single render, no FE flash).
          const applyFeEdgeValues = async (
            graph: any,
            edgeValues: typeof feEdgeValues,
          ): Promise<any> => {
              const nextGraph = await materialiseFeEdgeValues(graph, edgeValues);
              setGraph(nextGraph);
              console.log(`[fetchDataService] FE topo pass: applied ${edgeValues.length} edges via UpdateManager`);

              if (FORECASTING_PARALLEL_RUN) {
                compareModelVarsSources(nextGraph);
              }

              return nextGraph;
            };

          // ── Helper: apply BE topo result into model_vars[analytic_be] + rerun promotion ──
          // BE topo does NOT write p.latency.* directly — only model_vars[analytic_be].
          // Promotion decides which source wins based on model_source_preference.
          const applyBeTopoResult = async (
            graph: any,
            beResults: NonNullable<Awaited<ReturnType<typeof runBeTopoPass>>>,
          ): Promise<any> => {
            const nextGraph = structuredClone(graph);
            const { upsertModelVars, applyPromotion } = await import('./modelVarsResolution');

            for (const beEntry of beResults) {
              const edge = nextGraph.edges?.find((e: any) => e.uuid === beEntry.edgeUuid || e.id === beEntry.edgeUuid);
              if (!edge) continue;
              const currentP = beEntry.conditionalIndex != null
                ? edge.conditional_p?.[beEntry.conditionalIndex]?.p
                : edge.p;
              if (!currentP) continue;

              if (beEntry.entry.latency) {
                const prevLatency =
                  currentP.model_vars?.find((v: any) => v.source === 'analytic_be')?.latency ||
                  currentP.model_vars?.find((v: any) => v.source === 'analytic')?.latency;
                beEntry.entry = {
                  ...beEntry.entry,
                  latency: mergeModelVarsLatencyPreservingCanonicalEdgeLatency(
                    beEntry.entry.latency as Record<string, any>,
                    prevLatency as Record<string, any> | undefined,
                  ),
                };
              }

              if (beEntry.conditionalIndex != null) {
                const cp = edge.conditional_p?.[beEntry.conditionalIndex];
                if (cp?.p) upsertModelVars(cp.p, beEntry.entry);
              } else if (edge.p) {
                upsertModelVars(edge.p, beEntry.entry);
              }
            }

            for (const edge of (nextGraph.edges ?? []) as any[]) {
              if (edge.p?.model_vars?.length) {
                applyPromotion(edge.p, (nextGraph as any).model_source_preference);
              }
            }

            if (FORECASTING_PARALLEL_RUN) {
              compareModelVarsSources(nextGraph);
            }

            return nextGraph;
          };

          // ── Helper: log FE→BE parity (observational only) ──
          const logParity = (
            graph: any,
            feValues: typeof feEdgeValues,
            beResults: NonNullable<Awaited<ReturnType<typeof runBeTopoPass>>>,
          ) => {
            if (!batchLogId) return;
            const fmt = (v: number | null | undefined, pct = true) =>
              v != null ? (pct ? `${(v * 100).toFixed(1)}%` : v.toFixed(3)) : '—';

            for (const be of beResults) {
              if (!be.beScalars) continue;
              const feVal = feValues.find(f =>
                f.edgeUuid === be.edgeUuid &&
                f.conditionalIndex === (be.conditionalIndex ?? undefined)
              );
              if (!feVal) continue;

              const edge = graph.edges?.find((e: any) => e.uuid === be.edgeUuid || e.id === be.edgeUuid);
              const edgeId = edge?.p?.id || be.edgeUuid.substring(0, 12);
              const bs = be.beScalars;

              sessionLogService.addChild(batchLogId, 'info', 'FE_BE_PARITY',
                `${edgeId}: completeness FE=${fmt(feVal.latency.completeness)} → BE=${fmt(bs.completeness)}` +
                (bs.completeness_stdev != null ? ` ±${fmt(bs.completeness_stdev)}` : '') +
                ` | p.mean FE=${fmt(feVal.blendedMean)} → BE=${fmt(bs.blended_mean)}` +
                ` | p.sd FE=${fmt(feVal.latency.p_sd)} → BE=${fmt(bs.p_sd)}`,
                undefined,
                {
                  edge_id: edgeId,
                  fe: { completeness: feVal.latency.completeness, p_mean: feVal.blendedMean, p_sd: feVal.latency.p_sd },
                  be: {
                    completeness: bs.completeness, completeness_stdev: bs.completeness_stdev,
                    p_mean: bs.blended_mean, p_sd: bs.p_sd,
                  },
                },
              );
            }
          };

          // ── Helper: merge conditioned forecast p.mean into FE edge values ──
          // When the conditioned forecast wins the 500ms race, its p.mean
          // replaces FE's blended p.mean in the same render. FE latency
          // fields are preserved — CF only sets p.mean / forecast.mean.
          // Merge every scalar CF is authoritative for (doc 45):
          // p_mean/p_sd AND completeness/completeness_sd. FE's latency
          // fit fields (mu, sigma, t95, path_t95, median_lag_days,
          // mean_lag_days, etc.) are left untouched — those are
          // FE topo's responsibility.
          const mergeCfIntoFe = (
            feValues: typeof feEdgeValues,
            cfResults: Awaited<ReturnType<typeof runConditionedForecast>>,
          ): typeof feEdgeValues => {
            if (!cfResults || cfResults.length === 0 || !cfResults[0]?.edges?.length) return feValues;
            type CfScalars = {
              p_mean: number;
              completeness?: number;
              completeness_sd?: number;
            };
            const byEdge = new Map<string, CfScalars>();
            for (const e of cfResults[0].edges) {
              if (e.p_mean != null && Number.isFinite(e.p_mean)) {
                byEdge.set(e.edge_uuid, {
                  p_mean: e.p_mean as number,
                  completeness:
                    e.completeness != null && Number.isFinite(e.completeness)
                      ? (e.completeness as number)
                      : undefined,
                  completeness_sd:
                    e.completeness_sd != null && Number.isFinite(e.completeness_sd)
                      ? (e.completeness_sd as number)
                      : undefined,
                });
              }
            }
            if (byEdge.size === 0) return feValues;
            return feValues.map(fe => {
              const cf = byEdge.get(fe.edgeUuid);
              if (cf == null) return fe;
              return {
                ...fe,
                blendedMean: cf.p_mean,
                forecast: { ...(fe.forecast || {}), mean: cf.p_mean },
                latency: {
                  ...fe.latency,
                  ...(cf.completeness != null
                    ? { completeness: cf.completeness }
                    : {}),
                  ...(cf.completeness_sd != null
                    ? { completeness_stdev: cf.completeness_sd }
                    : {}),
                },
              };
            });
          };

          // ── Helper: attach CF slow-path apply handler ──
          // Shared between the FE-has-values slow path (CF missed the 500ms
          // race) and the FE-no-values branch (CF is the sole writer of
          // p.mean). In both cases, CF applies its own results via
          // applyConditionedForecastToGraph on the freshest graph the
          // caller can see.
          const attachCfSlowPathHandler = () => {
            backgroundPromises.push(
              cfPromise.then(async results => {
                if (cfGen !== _conditionedForecastGeneration) {
                  if (batchLogId) {
                    sessionLogService.addChild(batchLogId, 'warning', 'CONDITIONED_FORECAST',
                      `Conditioned forecast result discarded (stale gen ${cfGen} < ${_conditionedForecastGeneration})`);
                  }
                  finaliseCfToast(null, 'stale');
                  return;
                }
                const cfElapsed = Date.now() - cfStartTime;
                if (!results || results.length === 0 || !results[0]?.edges?.length) {
                  if (batchLogId) {
                    sessionLogService.addChild(batchLogId, 'warning', 'CONDITIONED_FORECAST',
                      `Conditioned forecast returned empty after ${cfElapsed}ms`);
                  }
                  finaliseCfToast(results, 'empty');
                  return;
                }
                // Apply on top of the freshest graph so BE topo's model_vars
                // upsert (if it arrived meanwhile) is preserved.
                const latestGraph = getUpdatedGraph?.() ?? finalGraph;
                if (!latestGraph) {
                  finaliseCfToast(results, 'empty');
                  return;
                }
                const updatedGraph = applyConditionedForecastToGraph(latestGraph, results);
                setGraph(updatedGraph);
                if (batchLogId) {
                  sessionLogService.addChild(batchLogId, 'info', 'CONDITIONED_FORECAST',
                    `Conditioned forecast subsequent overwrite applied in ${cfElapsed}ms`,
                    undefined,
                    { edges: results[0].edges.map(e => ({ uuid: e.edge_uuid?.slice(0, 12), p_mean: e.p_mean, p_sd: e.p_sd, completeness: e.completeness, completeness_sd: e.completeness_sd })) });
                }
                finaliseCfToast(results, 'resolved');
              }).catch(e => {
                console.warn('[fetchDataService] Conditioned forecast apply failed:', e);
                if (batchLogId) {
                  sessionLogService.addChild(batchLogId, 'error', 'CONDITIONED_FORECAST',
                    `Conditioned forecast apply failed: ${e?.message || e}`);
                }
                finaliseCfToast(null, 'error');
              })
            );
          };

          // ── FE apply gate + CF race ──
          // Only enter when FE LAG produced edge values to apply. The 500ms
          // race exists to let CF's p.mean be merged into the FE apply in a
          // single render (no FE-fallback flash). When FE has nothing to
          // apply, racing CF is meaningless — CF just applies its own
          // results on arrival via the slow-path handler below.
          if (feEdgeValues.length > 0 && finalGraph?.edges) {
            const CF_FAST_DEADLINE_MS = 500;
            const cfTimeoutSentinel = Symbol('cf-timeout');
            const cfRaceResult = await Promise.race([
              cfPromise,
              new Promise<typeof cfTimeoutSentinel>(resolve =>
                setTimeout(() => resolve(cfTimeoutSentinel), CF_FAST_DEADLINE_MS)
              ),
            ]);
            const cfResolvedFast = cfRaceResult !== cfTimeoutSentinel;
            const cfFastResults = cfResolvedFast
              ? (cfRaceResult as Awaited<ReturnType<typeof runConditionedForecast>>)
              : null;
            const cfHasFastResults =
              Array.isArray(cfFastResults) &&
              cfFastResults.length > 0 &&
              (cfFastResults[0]?.edges?.length ?? 0) > 0 &&
              cfFastResults[0].edges.some(e => e.p_mean != null && Number.isFinite(e.p_mean));

            if (cfHasFastResults && cfFastResults) {
              // FAST PATH: CF responded within 500ms with non-empty p.mean.
              // Fold it into FE apply so the user never sees an FE-fallback flash.
              const cfElapsed = Date.now() - cfStartTime;
              appliedEdgeValuesForFinalGraph = mergeCfIntoFe(feEdgeValues, cfFastResults);
              finalGraph = await applyFeEdgeValues(finalGraph, appliedEdgeValuesForFinalGraph);
              if (batchLogId) {
                sessionLogService.addChild(batchLogId, 'info', 'CONDITIONED_FORECAST',
                  `Conditioned forecast applied in ${cfElapsed}ms (fast path, single render)`,
                  undefined,
                  { edges: cfFastResults[0].edges.map(e => ({ uuid: e.edge_uuid?.slice(0, 12), p_mean: e.p_mean, p_sd: e.p_sd, completeness: e.completeness, completeness_sd: e.completeness_sd })) });
              }
              finaliseCfToast(cfFastResults, 'resolved');
            } else {
              // SLOW PATH (or fast-empty): apply FE fallback immediately.
              appliedEdgeValuesForFinalGraph = feEdgeValues;
              finalGraph = await applyFeEdgeValues(finalGraph, feEdgeValues);

              if (cfResolvedFast) {
                // CF returned fast but empty/failed — nothing to overwrite.
                if (batchLogId) {
                  sessionLogService.addChild(batchLogId, 'warning', 'CONDITIONED_FORECAST',
                    `Conditioned forecast returned ${Array.isArray(cfFastResults) && cfFastResults.length === 0
                      ? 'empty array'
                      : 'no usable p.mean'} after ${Date.now() - cfStartTime}ms`);
                }
                finaliseCfToast(cfFastResults, 'empty');
              } else {
                // CF still pending — attach a .then() for subsequent overwrite.
                if (batchLogId) {
                  sessionLogService.addChild(batchLogId, 'info', 'CONDITIONED_FORECAST',
                    `Conditioned forecast pending after ${CF_FAST_DEADLINE_MS}ms — FE fallback applied`);
                }
                attachCfSlowPathHandler();
              }
            }
          } else {
            // FE LAG produced no values (e.g. narrow cohort with no YAML
            // evidence in window). CF is the sole writer of p.mean — it
            // reads the snapshot DB server-side and applies its own
            // results on arrival. No FE apply, no race.
            if (batchLogId) {
              sessionLogService.addChild(batchLogId, 'info', 'CONDITIONED_FORECAST',
                `No FE LAG values to apply — CF is sole writer of p.mean (awaiting)`);
            }
            attachCfSlowPathHandler();
          }

          // ── BE topo pass result (always, independent of FE and CF) ──
          // When BE topo resolves, upsert analytic_be entries and rerun
          // promotion. Fire-and-forget: a stale response from a previous
          // fetch cycle is discarded via the generation counter. We read
          // the latest graph so the upsert lands on top of anything
          // applied meanwhile (e.g. the conditioned forecast's p.mean).
          backgroundPromises.push(
            bePromise.then(async beResults => {
              if (beGen !== _beTopoPassGeneration) {
                if (batchLogId) {
                  sessionLogService.addChild(batchLogId, 'warning', 'BE_TOPO_PASS',
                    `BE topo pass result discarded (stale gen ${beGen} < ${_beTopoPassGeneration})`);
                }
                updatePipelineStep('be', 'error', `discarded (stale)`);
                return;
              }
              const beElapsed = Date.now() - beStartTime;
              if (!beResults || beResults.length === 0) {
                if (batchLogId) {
                  sessionLogService.addChild(batchLogId, 'warning', 'BE_TOPO_PASS',
                    `BE topo pass returned ${beResults === null ? 'null (failed)' : 'empty'} after ${beElapsed}ms`);
                }
                updatePipelineStep('be', 'error',
                  `${beResults === null ? 'failed' : 'empty'}, ${beElapsed.toLocaleString()}ms`);
                return;
              }
              const latestGraph = getUpdatedGraph?.() ?? finalGraph;
              if (!latestGraph) {
                updatePipelineStep('be', 'error', 'no graph');
                return;
              }
              const updated = await applyBeTopoResult(latestGraph, beResults);
              setGraph(updated);
              logParity(updated, feEdgeValues, beResults);
              if (batchLogId) {
                sessionLogService.addChild(batchLogId, 'info', 'BE_TOPO_PASS',
                  `BE topo pass model vars applied in ${beElapsed}ms`,
                  undefined,
                  { edges: beResults.map(be => ({ uuid: be.edgeUuid?.slice(0, 12), p_mean: be.beScalars?.blended_mean, p_sd: be.beScalars?.p_sd, completeness: be.beScalars?.completeness, completeness_stdev: be.beScalars?.completeness_stdev })) });
              }
              updatePipelineStep('be', 'complete',
                `${beResults.length} edge${beResults.length !== 1 ? 's' : ''}, ${beElapsed.toLocaleString()}ms`);
            }).catch(e => {
              // bePromise's .catch converts rejections to null; this guards the handler itself.
              console.warn('[fetchDataService] BE topo pass apply failed:', e);
              if (batchLogId) {
                sessionLogService.addChild(batchLogId, 'error', 'BE_TOPO_PASS',
                  `BE topo pass apply failed: ${e?.message || e}`);
              }
              updatePipelineStep('be', 'error', `apply failed`);
            })
          );

          // If the caller (CLI) wants deterministic final state, wait
          // for the fire-and-forget background handlers to settle.
          if (awaitBackgroundPromises && backgroundPromises.length > 0) {
            await Promise.allSettled(backgroundPromises);
          }

          applyQueryOwnedCompleteness(finalGraph, appliedEdgeValuesForFinalGraph);

          if (batchLogId) {
            sessionLogService.addChild(batchLogId, 'debug', 'LAG_ENHANCED',
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
                
                sessionLogService.addChild(batchLogId, 'debug', 'LAG_CALC_DETAIL',
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
                    // Completeness semantics (cohort fix)
                    completenessMode: v.debug.completenessMode,
                    completenessAuthoritativeT95Days: v.debug.completenessAuthoritativeT95Days,
                    completenessTailConstraintApplied: v.debug.completenessTailConstraintApplied,
                    // Forecast/blend diagnostics (needed to debug “forecast too low”)
                    baseForecastMean: v.debug.baseForecastMean,
                    fallbackForecastMean: v.debug.fallbackForecastMean,
                    forecastMeanUsed: v.debug.forecastMeanUsed,
                    forecastMeanSource: v.debug.forecastMeanSource,
                    evidenceMeanRaw: v.debug.evidenceMeanRaw,
                    evidenceMeanUsedForBlend: v.debug.evidenceMeanUsedForBlend,
                    evidenceMeanBayesAdjusted: v.debug.evidenceMeanBayesAdjusted,
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

          // Conditioned forecast and BE topo pass are fired + handled
          // inside the `if (lagResult.edgeValues.length > 0)` block above
          // (doc 45 §Delivery model): conditioned forecast races 500ms,
          // BE topo populates model_vars[analytic_be].
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
        // IMPORTANT: Refresh from the published graph pointer when available.
        // applyFeEdgeValues / CF writes land through setGraph(), and the CLI's
        // deterministic path wants the freshest committed graph state here.
        finalGraph = getUpdatedGraph?.() ?? finalGraph;
        // NOTE: applyQueryOwnedCompleteness is called inside the hasLatencyItems
        // block above (where appliedEdgeValuesForFinalGraph is in scope) — no
        // duplicate call here.
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

        // If the pipeline op is still active (e.g. hasLatencyItems was false,
        // so no FE/BE/CF passes fired), complete it here so the indicator
        // doesn't sit on pending forever. When hasLatencyItems was true,
        // the CF finaliser completes the parent op via finishParent.
        if (pipelineOpId && _pipelineStates.has(pipelineOpId)) {
          const state = _pipelineStates.get(pipelineOpId)!;
          const feDone = state[PIPELINE_STEP_ORDER.indexOf('fe')].status !== 'pending';
          if (!feDone) {
            // No latency items → FE/BE/CF were no-ops for this cycle.
            setPipelineStep(pipelineOpId, 'fe', 'complete', 'n/a');
            setPipelineStep(pipelineOpId, 'be', 'complete', 'n/a');
            setPipelineStep(pipelineOpId, 'cf', 'complete', 'n/a');
            const totalMs = pipelineStartMs != null
              ? (Date.now() - pipelineStartMs).toLocaleString()
              : '?';
            completePipelineOp(pipelineOpId, 'complete',
              `Recomputed — no latency edges (${totalMs}ms)`);
          }
          // Otherwise: parent op completes via the CF finaliser when CF
          // resolves. For browser (awaitBackgroundPromises=false) the
          // fetch returns before CF arrives; the op stays 'running' and
          // flips to 'complete' when CF's .then() handler fires.
        }
}

/**
 * Persist graph-mastered latency fields (e.g. t95/path_t95) back to parameter files.
 *
 * Rationale:
 * - Versioned (file-backed) fetch uses parameter file latency to construct cohort conversion windows (cs).
 * - If derived horizons drift between graph and file, identical queries can yield different n/k.
 * - This mirrors the established anchor/query pattern: graph is authoritative; file is updated unless overridden.
 */
export async function persistGraphMasteredLatencyToParameterFiles(args: {
  graph: Graph;
  setGraph: (g: Graph | null) => void;
  edgeIds: string[];
}): Promise<void> {
  const { graph, setGraph, edgeIds } = args;
  if (!graph?.edges?.length || !edgeIds?.length) return;

  // Avoid toast spam during batch-derived writes.
  const wasBatch = isBatchMode();
  if (!wasBatch) setBatchMode(true);
  try {
    for (const edgeId of edgeIds) {
      const edge = graph.edges.find((e: any) => e.uuid === edgeId || e.id === edgeId || `${e.from}->${e.to}` === edgeId) as any;
      const paramId = edge?.p?.id;
      if (!paramId) continue;

      const lat = edge?.p?.latency;
      // Only persist when there is something meaningful to persist.
      //
      // Policy (doc 19):
      // - Read from promoted_* fields (model output), not t95/path_t95 (user-configured).
      // - Persist edge t95 only for latency-enabled edges (local latency parameter).
      // - Persist path_t95 only when it is a positive finite horizon (i.e. behind a lagged path).
      // - Avoid writing 0/undefined horizons into files (prevents churn + accidental "unlagging").
      // - Gate writes on override locks: when overridden, user's value is authoritative.
      const promotedT95 = lat?.promoted_t95;
      const promotedPathT95 = lat?.promoted_path_t95;
      const shouldWriteT95 =
        lat?.latency_parameter === true &&
        lat?.t95_overridden !== true &&
        typeof promotedT95 === 'number' &&
        Number.isFinite(promotedT95) &&
        promotedT95 > 0;
      const shouldWritePath =
        lat?.path_t95_overridden !== true &&
        typeof promotedPathT95 === 'number' &&
        Number.isFinite(promotedPathT95) &&
        promotedPathT95 > 0;

      // Doc 19 §4.4: mu/sigma always persist for bootstrap continuity.
      const shouldWriteModel = typeof lat?.mu === 'number' || typeof lat?.sigma === 'number';
      if (!shouldWriteT95 && !shouldWritePath && !shouldWriteModel) continue;

      // Doc 19: copy promoted values to t95/path_t95 on the edge so that
      // putParameterToFile (which copies the latency block) persists the
      // model output. Only when not overridden (checked above).
      // onset: same pattern as t95
      const promotedOnset = lat?.promoted_onset_delta_days;
      const shouldWriteOnset =
        lat?.latency_parameter === true &&
        lat?.onset_delta_days_overridden !== true &&
        typeof promotedOnset === 'number' &&
        Number.isFinite(promotedOnset) &&
        promotedOnset >= 0;

      if (shouldWriteT95) lat.t95 = promotedT95;
      if (shouldWritePath) lat.path_t95 = promotedPathT95;
      if (shouldWriteOnset) lat.onset_delta_days = promotedOnset;

      await dataOperationsService.putParameterToFile({
        paramId,
        edgeId: edge.uuid || edge.id || edgeId,
        graph,
        setGraph,
        copyOptions: {
          includeValues: false,      // metadata-only
          includeMetadata: true,
          permissionsMode: 'do_not_copy', // do not change override flags; they live on the file
        },
      });
    }
  } finally {
    if (!wasBatch) setBatchMode(false);
  }
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
  computed: {
    median_lag_days?: number;
    mean_lag_days?: number;
    t95: number;
    completeness: number;
    path_t95: number;
    promoted_onset_delta_days?: number;
    mu?: number;
    sigma?: number;
    path_mu?: number;
    path_sigma?: number;
    path_onset_delta_days?: number;
  },
  existing:
    | {
        median_lag_days?: number;
        mean_lag_days?: number;
        t95?: number;
        completeness?: number;
        onset_delta_days?: number;
      }
    | undefined,
  preserveLatencySummaryFromFile: boolean
): {
  median_lag_days?: number;
  mean_lag_days?: number;
  t95: number;
  completeness: number;
  path_t95: number;
  promoted_onset_delta_days?: number;
  mu?: number;
  sigma?: number;
  path_mu?: number;
  path_sigma?: number;
  path_onset_delta_days?: number;
} {
  if (!preserveLatencySummaryFromFile) {
    return computed;
  }

  const hasExistingSummary =
    existing?.median_lag_days !== undefined ||
    existing?.mean_lag_days !== undefined ||
    existing?.mu !== undefined ||
    existing?.sigma !== undefined ||
    existing?.t95 !== undefined;

  if (!hasExistingSummary) {
    return computed;
  }

  const preserveEdgeModel =
    existing?.mu != null &&
    existing?.sigma != null &&
    Number.isFinite(existing.mu) &&
    Number.isFinite(existing.sigma) &&
    existing.sigma > 0;

  return {
    // Preserve existing slice-level latency summary (from file)
    median_lag_days: existing?.median_lag_days,
    mean_lag_days: existing?.mean_lag_days,
    // Preserve the canonical edge-local latency family when the graph already
    // carries one; only the path-level A→Y projection is query-shaped.
    t95: preserveEdgeModel ? (existing?.t95 ?? computed.t95) : computed.t95,
    // CRITICAL: completeness must always come from the topo pass (query-date dependent).
    completeness: computed.completeness,
    // Still apply computed path_t95 (UpdateManager will respect path_t95_overridden).
    path_t95: computed.path_t95,
    promoted_onset_delta_days: preserveEdgeModel
      ? (existing?.onset_delta_days ?? computed.promoted_onset_delta_days)
      : computed.promoted_onset_delta_days,
    mu: preserveEdgeModel ? existing?.mu : computed.mu,
    sigma: preserveEdgeModel ? existing?.sigma : computed.sigma,
    // path_mu/path_sigma/path_onset_delta_days: path-level A→Y CDF params (Fenton–Wilkinson combined).
    path_mu: computed.path_mu,
    path_sigma: computed.path_sigma,
    path_onset_delta_days: computed.path_onset_delta_days,
  };
}

function mergeModelVarsLatencyPreservingCanonicalEdgeLatency(
  incoming: Record<string, any> | undefined,
  previous: Record<string, any> | undefined,
): Record<string, any> {
  const next = incoming || {};
  const prev = previous || {};
  const merged: Record<string, any> = {};

  const setIfPresent = (key: string, value: unknown): void => {
    if (value != null) {
      merged[key] = value;
    }
  };

  const preserveEdgeModel =
    prev.mu != null &&
    prev.sigma != null &&
    Number.isFinite(prev.mu) &&
    Number.isFinite(prev.sigma) &&
    prev.sigma > 0;

  if (preserveEdgeModel) {
    setIfPresent('mu', prev.mu);
    setIfPresent('sigma', prev.sigma);
    setIfPresent('t95', prev.t95 ?? next.t95);
    setIfPresent('onset_delta_days', prev.onset_delta_days ?? next.onset_delta_days);
    setIfPresent('mu_sd', prev.mu_sd ?? next.mu_sd);
    setIfPresent('sigma_sd', prev.sigma_sd ?? next.sigma_sd);
    setIfPresent('onset_sd', prev.onset_sd ?? next.onset_sd);
    setIfPresent('onset_mu_corr', prev.onset_mu_corr ?? next.onset_mu_corr);
  } else {
    setIfPresent('mu', next.mu);
    setIfPresent('sigma', next.sigma);
    setIfPresent('t95', next.t95);
    setIfPresent('onset_delta_days', next.onset_delta_days);
    setIfPresent('mu_sd', next.mu_sd);
    setIfPresent('sigma_sd', next.sigma_sd);
    setIfPresent('onset_sd', next.onset_sd);
    setIfPresent('onset_mu_corr', next.onset_mu_corr);
  }

  setIfPresent('path_mu', next.path_mu ?? prev.path_mu);
  setIfPresent('path_sigma', next.path_sigma ?? prev.path_sigma);
  setIfPresent('path_t95', next.path_t95 ?? prev.path_t95);
  setIfPresent('path_onset_delta_days', next.path_onset_delta_days ?? prev.path_onset_delta_days);
  setIfPresent('path_mu_sd', next.path_mu_sd ?? prev.path_mu_sd);
  setIfPresent('path_sigma_sd', next.path_sigma_sd ?? prev.path_sigma_sd);
  setIfPresent('path_onset_sd', next.path_onset_sd ?? prev.path_onset_sd);

  return merged;
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

  // Dev-only E2E: in share-live Playwright runs we stub external boundaries and do not want
  // scenario regeneration to kick off real provider fetches. Treat cache as "sufficient" so
  // regeneration follows the from-file path.
  //
  // Gated by:
  // - DEV build
  // - URL contains ?e2e=1
  try {
    if (import.meta.env?.DEV && typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.has('e2e')) {
        return { needsFetch: false, items: [] };
      }
    }
  } catch {
    // ignore
  }
  
  // Extract window from DSL
  const dateWindow = extractWindowFromDSL(dsl);
  if (!dateWindow) {
    // No window in DSL - can't check cache, assume no fetch needed
    // (This handles pure what-if DSLs like "case(my-case:treatment)")
    return { needsFetch: false, items: [] };
  }
  
  const items = getItemsNeedingFetch(dateWindow, graph, dsl);
  
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
    skipCohortBounding?: boolean;
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
    skipCohortBounding: options?.skipCohortBounding,
  };
}

// ============================================================================
// Export as service object for named import
// ============================================================================

export const fetchDataService = {
  // Core functions
  itemNeedsFetch,
  getItemsNeedingFetch,
  getItemsForFromFileLoad,
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

