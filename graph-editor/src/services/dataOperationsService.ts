/**
 * Data Operations Service
 * 
 * Centralized service for all data sync operations (Get/Put).
 * Used by: Lightning Menu, Context Menus, Data Menu
 * 
 * This is a proper service layer that:
 * - Validates input
 * - Calls UpdateManager to transform data
 * - Applies changes to graph
 * - Shows toast notifications
 * - Handles errors gracefully
 * 
 * Architecture:
 *   UI Components → DataOperationsService → UpdateManager → Graph Update
 * 
 * Context Requirements:
 * - Requires graph + setGraph from caller (useGraphStore)
 * - Allows service to work with any tab/graph instance
 * - Supports future async operations
 * 
 * Benefits:
 * - Single source of truth for all data operations
 * - Consistent behavior across all UI entry points
 * - Easy to add logging, analytics, auth checks
 * - Testable (pure business logic)
 * - Ready for Phase 4 (async/API operations)
 */

import toast from 'react-hot-toast';
import { fileRegistry } from '../contexts/TabContext';
import { UpdateManager } from './UpdateManager';
import type { Graph, DateRange } from '../types';
import type { CombinedResult } from '../lib/das/compositeQueryExecutor';
import {
  WindowAggregationService,
  parameterToTimeSeries,
  calculateIncrementalFetch,
  mergeTimeSeriesIntoParameter,
  normalizeDate,
  parseDate,
  isDateInRange,
  parameterValueToCohortData,
  aggregateCohortData,
  aggregateLatencyStats,
  isCohortModeValue,
  type TimeSeriesPointWithLatency,
} from './windowAggregationService';
import {
  shouldRefetch,
  analyzeSliceCoverage,
  computeFetchWindow,
  type RefetchDecision,
  type LatencyConfig,
} from './fetchRefetchPolicy';
import { computeCohortRetrievalHorizon } from './cohortRetrievalHorizon';
import { 
  statisticalEnhancementService,
  computeEdgeLatencyStats,
  type EdgeLatencyStats,
  type CohortData,
} from './statisticalEnhancementService';
import type { ParameterValue } from './paramRegistryService';
import type { TimeSeriesPoint } from '../types';
import { buildScopedParamsFromFlatPack, ParamSlot } from './ParamPackDSLService';
import { isolateSlice, extractSliceDimensions, hasContextAny } from './sliceIsolation';
import { sessionLogService } from './sessionLogService';
import { parseConstraints, parseDSL } from '../lib/queryDSL';
import { normalizeToUK, formatDateUK, parseUKDate, resolveRelativeDate } from '../lib/dateFormat';
import { rateLimiter } from './rateLimiter';
import { buildDslFromEdge } from '../lib/das/buildDslFromEdge';
import { createDASRunner } from '../lib/das';
import { db } from '../db/appDatabase';
import { FORECAST_BLEND_LAMBDA, DIAGNOSTIC_LOG } from '../constants/statisticalConstants';

// Cached DAS runner instance for connection lookups (avoid recreating per-call)
let cachedDASRunner: ReturnType<typeof createDASRunner> | null = null;
function getCachedDASRunner() {
  if (!cachedDASRunner) {
    cachedDASRunner = createDASRunner();
  }
  return cachedDASRunner;
}

/**
 * Batch mode flag - when true, suppresses individual toasts during batch operations
 * Set this before starting a batch operation and reset it after
 */
let batchModeActive = false;

/** Enable batch mode to suppress individual toasts */
export function setBatchMode(active: boolean): void {
  batchModeActive = active;
}

/** Check if batch mode is active */
export function isBatchMode(): boolean {
  return batchModeActive;
}

/** Wrapper for toast that respects batch mode */
function batchableToast(message: string, options?: any): string | void {
  if (batchModeActive) return; // Suppress in batch mode
  return toast(message, options);
}

/** Wrapper for toast.success that respects batch mode */
function batchableToastSuccess(message: string, options?: any): string | void {
  if (batchModeActive) return;
  return toast.success(message, options);
}

/** Wrapper for toast.error that respects batch mode */
function batchableToastError(message: string, options?: any): string | void {
  if (batchModeActive) return;
  return toast.error(message, options);
}

/**
 * Format edge identifier in human-readable form for logging
 * Shows: "from → to (paramId)" or "from → to" if no param
 */
function formatEdgeForLog(edge: any, graph: Graph | null): string {
  if (!edge) return 'unknown edge';
  
  // Find source and target nodes to get human-readable names
  const fromNode = graph?.nodes?.find((n: any) => n.uuid === edge.from || n.id === edge.from);
  const toNode = graph?.nodes?.find((n: any) => n.uuid === edge.to || n.id === edge.to);
  
  const fromName = fromNode?.id || fromNode?.label || edge.from?.substring(0, 8) || '?';
  const toName = toNode?.id || toNode?.label || edge.to?.substring(0, 8) || '?';
  const paramId = edge.p?.id;
  
  return paramId 
    ? `${fromName} → ${toName} (${paramId})`
    : `${fromName} → ${toName}`;
}

/**
 * Format node identifier in human-readable form for logging
 */
function formatNodeForLog(node: any): string {
  if (!node) return 'unknown node';
  return node.id || node.label || node.uuid?.substring(0, 8) || '?';
}

/**
 * Compile a query with excludes() to minus/plus form for providers that don't support native excludes.
 * Calls Python MSMDC API to perform the compilation.
 * 
 * @param queryString - Original query string with excludes() terms
 * @param graph - Graph for topology analysis
 * @returns Compiled query string with minus/plus terms, or original if compilation fails
 */
interface CompileExcludeResult {
  compiled_query: string;
  was_compiled: boolean;
  success: boolean;
  error?: string;
  terms_count?: number;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DEPRECATED: 4-Dec-25 - EXCLUDE QUERY COMPILATION
 * 
 * This function compiled exclude() queries to minus/plus form via Python API.
 * This was required because we believed Amplitude didn't support native exclude filters.
 * 
 * REPLACEMENT: Native segment filters in Amplitude adapter (connections.yaml)
 * The adapter now converts excludes to segment filters with `op: "="`, `value: 0`.
 * 
 * This function will NOT be called for Amplitude because the adapter handles
 * excludes natively before this code path is reached.
 * 
 * DO NOT DELETE until native segment filters are confirmed working in production.
 * Target deletion: After 2 weeks of production validation.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
async function compileExcludeQuery(queryString: string, graph: any): Promise<{ compiled: string; wasCompiled: boolean; error?: string }> {
  try {
    // Call Python API endpoint to compile the query
    const response = await fetch('/api/compile-exclude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: queryString,
        graph: graph
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[compileExcludeQuery] API error:', errorText);
      return { compiled: queryString, wasCompiled: false, error: `API error: ${errorText}` };
    }
    
    const result: CompileExcludeResult = await response.json();
    
    // CRITICAL: Check was_compiled flag to detect silent failures
    // The API returns the original query on failure, so we can't just check compiled_query !== queryString
    if (!result.success) {
      console.error('[compileExcludeQuery] Compilation failed:', result.error);
      return { compiled: queryString, wasCompiled: false, error: result.error || 'Unknown compilation error' };
    }
    
    if (!result.was_compiled) {
      // No excludes found (shouldn't happen if we pre-checked, but handle gracefully)
      console.warn('[compileExcludeQuery] No excludes found in query - nothing to compile');
      return { compiled: queryString, wasCompiled: false };
    }
    
    if (result.compiled_query) {
      console.log('[compileExcludeQuery] Successfully compiled:', {
        original: queryString,
        compiled: result.compiled_query,
        termsCount: result.terms_count
      });
      return { compiled: result.compiled_query, wasCompiled: true };
    }
    
    console.warn('[compileExcludeQuery] No compiled_query in response:', result);
    return { compiled: queryString, wasCompiled: false, error: 'No compiled_query in response' };
  } catch (error) {
    console.error('[compileExcludeQuery] Failed to call compile API:', error);
    return { compiled: queryString, wasCompiled: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Shared UpdateManager instance
const updateManager = new UpdateManager();

// Shared WindowAggregationService instance
const windowAggregationService = new WindowAggregationService();

/**
 * Extract external update payload from Sheets DAS result for edge parameters.
 * Supports edge-param scope (p/cost_gbp/labour_cost) and edge-conditional scope.
 */
export function extractSheetsUpdateDataForEdge(
  raw: any,
  connectionString: any,
  paramSlot: 'p' | 'cost_gbp' | 'labour_cost' | undefined,
  conditionalIndex: number | undefined,
  graph: Graph | null | undefined,
  targetId: string | undefined
): { mean?: number; stdev?: number; n?: number; k?: number } {
  const update: { mean?: number; stdev?: number; n?: number; k?: number } = {};

  const mode = (connectionString?.mode as 'auto' | 'single' | 'param-pack' | undefined) ?? 'auto';
  const scalarValue = raw?.scalar_value;
  const paramPack = (raw?.param_pack ?? raw?.paramPack) as Record<string, unknown> | null | undefined;

  const hasParamPack = !!paramPack && Object.keys(paramPack).length > 0;
  const slot: ParamSlot = paramSlot || 'p';

  const shouldUseParamPack = mode === 'param-pack' || (mode === 'auto' && hasParamPack);
  const shouldUseScalar = mode === 'single' || (mode === 'auto' && !hasParamPack);

  const mergedFlat: Record<string, unknown> = {};

  if (shouldUseParamPack && paramPack) {
    Object.assign(mergedFlat, paramPack);
  }

  if (shouldUseScalar && scalarValue !== undefined && scalarValue !== null) {
    if (!('mean' in mergedFlat) && !('p.mean' in mergedFlat)) {
      mergedFlat['mean'] = scalarValue;
    }
  }

  console.log('[extractSheetsUpdateDataForEdge] Debug:', {
    mode,
    scalarValue,
    paramPack,
    paramPackKeys: paramPack ? Object.keys(paramPack) : [],
    paramPackSize: paramPack ? Object.keys(paramPack).length : 0,
    hasParamPack,
    shouldUseParamPack,
    shouldUseScalar,
    mergedFlat,
    mergedFlatKeys: Object.keys(mergedFlat),
    hasGraph: !!graph,
    targetId,
    rawErrors: raw?.errors,
    rawParsedResult: raw?.parsed_result,
  });

  if (Object.keys(mergedFlat).length === 0 || !graph || !targetId) {
    console.warn('[extractSheetsUpdateDataForEdge] Early return:', {
      mergedFlatEmpty: Object.keys(mergedFlat).length === 0,
      noGraph: !graph,
      noTargetId: !targetId,
    });
    return update;
  }

  const edge = graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId);
  console.log('[extractSheetsUpdateDataForEdge] Edge lookup:', {
    targetId,
    foundEdge: edge ? { uuid: edge.uuid, id: edge.id } : null,
    allEdgeIds: graph.edges?.map((e: any) => ({ uuid: e.uuid, id: e.id })) || [],
  });
  if (!edge) {
    console.warn('[extractSheetsUpdateDataForEdge] Edge not found for targetId:', targetId);
    return update;
  }

  // Determine scope: conditional vs edge-param
  let scopedParams: any;

  if (conditionalIndex !== undefined && edge.conditional_p && edge.conditional_p[conditionalIndex]) {
    // Targeting a specific conditional_p entry
    const condEntry = edge.conditional_p[conditionalIndex];
    const condition = condEntry.condition;

    scopedParams = buildScopedParamsFromFlatPack(
      mergedFlat,
      {
        kind: 'edge-conditional',
        edgeUuid: edge.uuid,
        edgeId: edge.id,
        condition,
      },
      graph
    );

    const edgeKey = edge.id || edge.uuid;
    const edgeParams = scopedParams.edges?.[edgeKey];
    if (edgeParams?.conditional_p?.[condition]) {
      const condP = edgeParams.conditional_p[condition];
      const apply = (field: 'mean' | 'stdev' | 'n' | 'k', value: unknown) => {
        if (value === null || value === undefined) return;
        const num = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(num)) return;
        update[field] = num;
      };
      apply('mean', condP.mean);
      apply('stdev', condP.stdev);
      apply('n', condP.n);
      apply('k', condP.k);
    }
  } else {
    // Standard edge-param scope
    scopedParams = buildScopedParamsFromFlatPack(
      mergedFlat,
      {
        kind: 'edge-param',
        edgeUuid: edge.uuid,
        edgeId: edge.id,
        slot,
      },
      graph
    );

    const edgeKey = edge.id || edge.uuid;
    const edgeParams = scopedParams.edges?.[edgeKey];
    
    console.log('[extractSheetsUpdateDataForEdge] Scoped params:', {
      edgeKey,
      edgeParams,
      scopedParamsKeys: Object.keys(scopedParams),
      edgesKeys: scopedParams.edges ? Object.keys(scopedParams.edges) : [],
      slot,
    });
    
    if (!edgeParams) {
      console.warn('[extractSheetsUpdateDataForEdge] No edgeParams found for edgeKey:', edgeKey);
      return update;
    }

    const apply = (field: 'mean' | 'stdev' | 'n' | 'k', value: unknown) => {
      if (value === null || value === undefined) return;
      const num = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(num)) return;
      update[field] = num;
    };

    if (slot === 'p' && edgeParams.p) {
      const p = edgeParams.p as any;
      console.log('[extractSheetsUpdateDataForEdge] Extracting from p:', p);
      apply('mean', p.mean);
      apply('stdev', p.stdev);
      apply('n', p.n);
      apply('k', p.k);
    } else if (slot === 'cost_gbp' && edgeParams.cost_gbp) {
      apply('mean', (edgeParams.cost_gbp as any).mean);
    } else if (slot === 'labour_cost' && edgeParams.labour_cost) {
      apply('mean', (edgeParams.labour_cost as any).mean);
    } else {
      console.warn('[extractSheetsUpdateDataForEdge] No matching slot found:', {
        slot,
        hasP: !!edgeParams.p,
        hasCostGbp: !!edgeParams.cost_gbp,
        hasCostTime: !!edgeParams.labour_cost,
      });
    }
  }

  console.log('[extractSheetsUpdateDataForEdge] Final update:', update);
  return update;
}

/**
 * Alias for extractSheetsUpdateDataForEdge with simplified signature for backward compatibility.
 * Maps (raw, connectionString, paramSlot, graph, edgeId) to the full signature.
 */
export function extractSheetsUpdateData(
  raw: any,
  connectionString: any,
  paramSlot: 'p' | 'cost_gbp' | 'labour_cost' | undefined,
  graph: Graph | null | undefined,
  edgeId: string | undefined
): { mean?: number; stdev?: number; n?: number; k?: number } {
  return extractSheetsUpdateDataForEdge(raw, connectionString, paramSlot, undefined, graph, edgeId);
}

/**
 * Compute query signature (SHA-256 hash) for consistency checking
 * Uses Web Crypto API available in modern browsers
 * 
 * Includes event_ids from nodes to detect when event definitions change
 */
export async function computeQuerySignature(
  queryPayload: any, 
  connectionName?: string,
  graph?: Graph | null,
  edge?: any
): Promise<string> {
  try {
    // Extract event_ids from nodes if graph and edge are provided
    let from_event_id: string | undefined;
    let to_event_id: string | undefined;
    let visited_event_ids: string[] = [];
    let exclude_event_ids: string[] = [];
    
    if (graph && edge && edge.query) {
      // Helper to find node by ID or UUID
      const findNode = (ref: string): any | undefined => {
        let node = graph.nodes?.find((n: any) => n.id === ref);
        if (!node) {
          node = graph.nodes?.find((n: any) => n.uuid === ref);
        }
        return node;
      };
      
      // Parse query to get node references (using static import)
      try {
        const parsed = parseDSL(edge.query);
        
        // Extract event_ids from from/to nodes
        const fromNode = parsed.from ? findNode(parsed.from) : null;
        const toNode = parsed.to ? findNode(parsed.to) : null;
        
        if (fromNode) from_event_id = fromNode.event_id;
        if (toNode) to_event_id = toNode.event_id;
        
        // Extract event_ids from visited nodes
        if (parsed.visited && Array.isArray(parsed.visited)) {
          visited_event_ids = parsed.visited
            .map((ref: string) => {
              const node = findNode(ref);
              return node?.event_id;
            })
            .filter((id: string | undefined): id is string => !!id);
        }
        
        // Extract event_ids from exclude nodes
        if (parsed.exclude && Array.isArray(parsed.exclude)) {
          exclude_event_ids = parsed.exclude
            .map((ref: string) => {
              const node = findNode(ref);
              return node?.event_id;
            })
            .filter((id: string | undefined): id is string => !!id);
        }
      } catch (error) {
        console.warn('[DataOperationsService] Failed to parse query for event_ids:', error);
        // Continue without event_ids if parsing fails
      }
    }
    
    // Create a canonical representation of the query
    // Include both node IDs (for backward compatibility) and event_ids (for change detection)
    // CRITICAL: Also include the ORIGINAL query string to detect minus()/plus() changes
    const canonical = JSON.stringify({
      connection: connectionName || '',
      // Provider-specific event names (from DSL)
      from: queryPayload.from || '',
      to: queryPayload.to || '',
      visited: (queryPayload.visited || []).sort(),
      exclude: (queryPayload.exclude || []).sort(),
      // Original event_ids from nodes (for change detection)
      from_event_id: from_event_id || '',
      to_event_id: to_event_id || '',
      visited_event_ids: visited_event_ids.sort(),
      exclude_event_ids: exclude_event_ids.sort(),
      event_filters: queryPayload.event_filters || {},
      context: (queryPayload.context || []).sort(),
      case: (queryPayload.case || []).sort(),
      // IMPORTANT: Include original query string to capture minus()/plus() terms
      // which are NOT preserved in the DSL object by buildDslFromEdge
      original_query: edge?.query || '',
    });
    
    // Compute SHA-256 hash
    const encoder = new TextEncoder();
    const data = encoder.encode(canonical);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    // ===== DIAGNOSTIC: Show what went into the signature =====
    console.log('[computeQuerySignature] Signature computed:', {
      signature: hashHex.substring(0, 12) + '...',
      originalQuery: edge?.query || 'N/A',
      hasMinus: (edge?.query || '').includes('.minus('),
      hasPlus: (edge?.query || '').includes('.plus('),
      canonicalKeys: Object.keys(JSON.parse(canonical)),
    });
    // =========================================================
    
    return hashHex;
  } catch (error) {
    console.warn('[DataOperationsService] Failed to compute query signature:', error);
    // Fallback: use simple string hash
    return `fallback-${Date.now()}`;
  }
}

/**
 * Helper function to apply field changes to a target object
 * Handles nested field paths (e.g., "p.mean")
 * Handles array append syntax (e.g., "values[]")
 * Handles array index syntax (e.g., "values[0]")
 */
function applyChanges(target: any, changes: Array<{ field: string; newValue: any }>): void {
  // Regex to match array access: fieldName[index] or fieldName[]
  const arrayAccessRegex = /^(.+)\[(\d*)\]$/;
  
  for (const change of changes) {
    console.log('[applyChanges] Applying change:', {
      field: change.field,
      newValue: change.newValue,
      'target.p BEFORE': JSON.stringify(target.p)
    });
    
    const parts = change.field.split('.');
    let obj: any = target;
    
    // Navigate to the nested object
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const arrayMatch = part.match(arrayAccessRegex);
      
      if (arrayMatch) {
        const [, arrayName, indexStr] = arrayMatch;
        if (!obj[arrayName]) {
          console.log(`[applyChanges] Creating new array at ${arrayName}`);
          obj[arrayName] = [];
        }
        if (indexStr === '') {
          // Empty brackets - don't navigate into array for intermediate paths
          obj = obj[arrayName];
        } else {
          // Specific index - navigate to that element
          const index = parseInt(indexStr, 10);
          if (!obj[arrayName][index]) {
            obj[arrayName][index] = {};
          }
          obj = obj[arrayName][index];
        }
      } else {
        if (!obj[part]) {
          console.log(`[applyChanges] Creating new object at ${part}`);
          obj[part] = {};
        }
        obj = obj[part];
      }
    }
    
    // Set the final value
    const finalPart = parts[parts.length - 1];
    const finalArrayMatch = finalPart.match(arrayAccessRegex);
    
    if (finalArrayMatch) {
      const [, arrayName, indexStr] = finalArrayMatch;
      if (!obj[arrayName]) {
        console.log(`[applyChanges] Creating new array at ${arrayName}`);
        obj[arrayName] = [];
      }
      
      if (indexStr === '') {
        // Array append: push the new value
        console.log(`[applyChanges] Appending to array ${arrayName}`);
        obj[arrayName].push(change.newValue);
      } else {
        // Array index: set at specific position
        const index = parseInt(indexStr, 10);
        console.log(`[applyChanges] Setting array ${arrayName}[${index}]`);
        obj[arrayName][index] = change.newValue;
      }
    } else {
      // Regular field set
      obj[finalPart] = change.newValue;
    }
    
    console.log('[applyChanges] After change:', {
      'target.p AFTER': JSON.stringify(target.p)
    });
  }
}

class DataOperationsService {
  /**
   * Get data from parameter file → graph edge
   * 
   * Reads parameter file, uses UpdateManager to transform data,
   * applies changes to graph edge, respects override flags.
   * 
   * If window is provided and parameter has daily data (n_daily/k_daily),
   * aggregates the daily data for the specified window.
   */
  async getParameterFromFile(options: {
    paramId: string;
    edgeId?: string;
    graph: Graph | null;
    setGraph: (graph: Graph | null) => void;
    setAutoUpdating?: (updating: boolean) => void;
    window?: DateRange; // DEPRECATED: Window is now parsed from targetSlice DSL
    targetSlice?: string; // DSL containing window and context (e.g., "window(1-Dec-25:7-Dec-25).context(geo=UK)")
    suppressSignatureWarning?: boolean; // If true, don't show warning about different query signatures (e.g., after bust cache)
    conditionalIndex?: number; // For conditional_p entries - which index to update
  }): Promise<{ success: boolean; warning?: string }> {
    const timingStart = performance.now();
    const timings: Record<string, number> = {};
    const markTime = (label: string) => {
      timings[label] = performance.now() - timingStart;
    };
    
    const { paramId, edgeId, graph, setGraph, setAutoUpdating, window: explicitWindow, targetSlice = '', suppressSignatureWarning = false, conditionalIndex } = options;
    
    // Parse window AND cohort from targetSlice DSL if not explicitly provided
    // This ensures single source of truth - DSL contains window, cohort, and context
    // CRITICAL: cohort() and window() are DIFFERENT date ranges:
    //   - cohort(anchor,start:end) = cohort entry dates for EVIDENCE
    //   - window(start:end) = observation window for FORECAST baseline
    let window = explicitWindow;
    let cohortWindow: DateRange | null = null;
    let isCohortQuery = false;
    
    if (targetSlice) {
      const parsed = parseConstraints(targetSlice);
      
      // Check for cohort() first - cohort evidence window
      if (parsed.cohort?.start && parsed.cohort?.end) {
        cohortWindow = {
          start: resolveRelativeDate(parsed.cohort.start),
          end: resolveRelativeDate(parsed.cohort.end),
        };
        isCohortQuery = true;
        console.log('[DataOperationsService] Parsed cohort window from DSL:', cohortWindow);
      }
      
      // Also check for window() - observation window (may also be present for dual-slice queries)
      if (!window && parsed.window?.start && parsed.window?.end) {
        window = {
          start: resolveRelativeDate(parsed.window.start),
          end: resolveRelativeDate(parsed.window.end),
        };
      }
    }
    markTime('parseWindow');
    
    // Start session log
    const logOpId = sessionLogService.startOperation(
      'info',
      'data-fetch',
      'GET_FROM_FILE',
      `Get parameter from file: ${paramId}`,
      { fileId: `parameter-${paramId}`, fileType: 'parameter', targetId: edgeId }
    );
    
    // Set auto-updating flag to enable animations
    if (setAutoUpdating) {
      setAutoUpdating(true);
      // Clear flag after 500ms
      setTimeout(() => setAutoUpdating(false), 500);
    }
    
    try {
      // Validate inputs
      if (!graph) {
        toast.error('No graph loaded');
        sessionLogService.endOperation(logOpId, 'error', 'No graph loaded');
        return { success: false };
      }
      
      if (!edgeId) {
        toast.error('No edge selected');
        sessionLogService.endOperation(logOpId, 'error', 'No edge selected');
        return { success: false };
      }
      
      // Check if file exists
      const paramFile = fileRegistry.getFile(`parameter-${paramId}`);
      markTime('getFile');
      if (!paramFile) {
        toast.error(`Parameter file not found: ${paramId}`);
        sessionLogService.endOperation(logOpId, 'error', `Parameter file not found: ${paramId}`);
        return { success: false };
      }
      
      // Find the target edge (check uuid, id, and from->to format)
      const targetEdge = graph.edges?.find((e: any) => 
        e.uuid === edgeId || 
        e.id === edgeId ||
        `${e.from}->${e.to}` === edgeId
      );
      markTime('findEdge');
      if (!targetEdge) {
        toast.error(`Edge not found in graph`);
        sessionLogService.endOperation(logOpId, 'error', 'Edge not found in graph');
        return { success: false };
      }
      
      console.log('[DataOperationsService] TARGET EDGE AT START:', {
        'edge.uuid': targetEdge.uuid,
        'edge.p': JSON.stringify(targetEdge.p),
        'window': window
      });
      
      // If window is provided, aggregate daily data from parameter file
      // CRITICAL: Ensure 'type' is set for UpdateManager mapping conditions
      // Legacy files may not have this field, so we infer it from the edge
      let aggregatedData = paramFile.data;
      
      // Track if aggregation failed and we fell back to raw data
      // This is used to report proper status in session logs
      let aggregationFallbackError: string | null = null;
      
      // Track if there was missing data (for warning in session log)
      let missingDataWarning: string | null = null;
      if (!aggregatedData.type && !aggregatedData.parameter_type) {
        // Infer type from which slot on the edge references this parameter
        let inferredType: 'probability' | 'cost_gbp' | 'labour_cost' = 'probability';
        if (targetEdge.cost_gbp?.id === paramId) {
          inferredType = 'cost_gbp';
        } else if (targetEdge.labour_cost?.id === paramId) {
          inferredType = 'labour_cost';
        }
        aggregatedData = { ...aggregatedData, type: inferredType };
        console.log('[DataOperationsService] Inferred missing parameter type:', inferredType);
      }
      
      // CRITICAL: Filter values by target slice for regular updates too
      // Without this, values[latest] picks from ANY slice when falling back
      markTime('beforeSliceFilter');
      if (targetSlice && paramFile.data?.values) {
        try {
          const allValues = paramFile.data.values as ParameterValue[];
          
          // Treat data as "contexted" ONLY when sliceDSL actually carries context/case dimensions,
          // not merely because sliceDSL is non-empty (cohort/window alone are not contexts).
          const hasContextedData = allValues.some(v => {
            if (!v.sliceDSL) return false;
            const dims = extractSliceDimensions(v.sliceDSL);
            return dims !== '';
          });
          
          // 1) Exact sliceDSL match - strongest signal
          //    If targetSlice exactly matches one or more sliceDSL entries, prefer those.
          //    This is critical for dual-slice latency files where both cohort() and window()
          //    slices exist in the same parameter file (design.md §4.6).
          let sliceFilteredValues: ParameterValue[] | null = null;
          const exactMatches = allValues.filter(v => v.sliceDSL === targetSlice);
          if (exactMatches.length > 0) {
            sliceFilteredValues = exactMatches;
            console.log('[DataOperationsService] Exact sliceDSL match for targetSlice', {
              targetSlice,
              matchCount: exactMatches.length,
            });
          }
          
          // 2) Fallback: MECE / isolateSlice logic when there is no exact match
          if (!sliceFilteredValues) {
            // Parse target once so we can distinguish window() vs cohort() intent
            const parsedTarget = parseConstraints(targetSlice);
            const wantsCohort = !!parsedTarget.cohort;
            const wantsWindow = !!parsedTarget.window;

            // Narrow candidate set to the SAME slice function family:
            // - cohort() queries should only see cohort slices
            // - window() queries should only see window slices
            // This prevents accidental mixing of cohort/window data when both
            // exist in the same parameter file (dual-slice latency files).
            let candidateValues: ParameterValue[] = allValues;
            if (wantsCohort && !wantsWindow) {
              candidateValues = allValues.filter(v => v.sliceDSL && v.sliceDSL.includes('cohort('));
            } else if (wantsWindow && !wantsCohort) {
              candidateValues = allValues.filter(v => v.sliceDSL && v.sliceDSL.includes('window('));
            }

            // Check if this is an uncontexted query on contexted data (MECE aggregation scenario)
            // IMPORTANT: contextAny queries are NOT uncontexted - they explicitly specify which slices to use
            const targetSliceDimensions = extractSliceDimensions(targetSlice);
            const isUncontextedQuery = targetSliceDimensions === '' && !hasContextAny(targetSlice);

            // Treat as MECE ONLY when file has contexted data and NO uncontexted data
            // (e.g. all slices are context(channel:*) with no plain slice).
            const hasUncontextedData = candidateValues.some(v => {
              const dims = extractSliceDimensions(v.sliceDSL ?? '');
              return dims === '';
            });
            
            if (isUncontextedQuery && hasContextedData && !hasUncontextedData) {
              // MECE aggregation: return ALL values (they'll be summed later)
              // For uncontexted queries on PURELY contexted data, we want ALL context slices
              sliceFilteredValues = candidateValues;
              console.log('[DataOperationsService] MECE aggregation path: returning ALL values for uncontexted query on contexted data', {
                targetSlice,
                valueCount: candidateValues.length,
              });
            } else {
              // Standard path: use isolateSlice (handles contextAny and specific context queries)
              sliceFilteredValues = isolateSlice(candidateValues, targetSlice);
            }
          }
          
          if (sliceFilteredValues.length > 0) {
            aggregatedData = { ...aggregatedData, values: sliceFilteredValues };
            console.log('[DataOperationsService] Filtered to slice:', {
              targetSlice,
              originalCount: allValues.length,
              filteredCount: sliceFilteredValues.length
            });
          } else if (hasContextedData) {
            // File has contexted data but NONE for this specific slice
            // Don't show stale data from other contexts - return early
            console.warn('[DataOperationsService] No data found for context slice:', targetSlice);
            toast(`No cached data for ${targetSlice}. Fetch from source to populate.`, {
              icon: '⚠️',
              duration: 3000,
            });
            sessionLogService.endOperation(logOpId, 'warning', `No cached data for slice: ${targetSlice}`);
            return { success: false, warning: `No cached data for slice: ${targetSlice}` }; // Return early - don't update graph with wrong context data
          }
        } catch (error) {
          // isolateSlice may throw for safety checks - log and continue
          console.warn('[DataOperationsService] Slice isolation failed:', error);
        }
      }
      markTime('afterSliceFilter');
      
      // Run aggregation for EITHER window() OR cohort() queries (or both)
      // CRITICAL: For cohort queries, we MUST aggregate to filter evidence to the cohort window
      const hasDateRangeQuery = window || cohortWindow;
      
      if (hasDateRangeQuery && aggregatedData?.values) {
        const aggValues = aggregatedData.values as ParameterValue[];
        // Exact stored time slice:
        // - Applies when targetSlice explicitly includes a window() OR cohort()
        //   and matches the stored sliceDSL 1:1.
        // - Pure context slices (e.g. context(channel:google)) with an external
        //   window parameter MUST still go through aggregation so that evidence
        //   reflects the requested sub-window inside the cached slice.
        const isExactTimeSlice =
          aggValues.length === 1 &&
          aggValues[0].sliceDSL === targetSlice &&
          !!targetSlice &&
          (targetSlice.includes('window(') || targetSlice.includes('cohort('));
        
        if (isExactTimeSlice) {
          // Exact stored time slice (e.g. window(25-Nov-25:1-Dec-25) or
          // cohort(landing-page,1-Sep-25:30-Nov-25)):
          // - Use pre-computed mean/stdev from the file
          // - Still compute evidence/latency/forecast via helper below
          console.log('[DataOperationsService] Exact time slice match - skipping aggregation and using stored slice stats', {
            targetSlice,
          });
        } else {
          // Collect value entries with daily data FROM SLICE-FILTERED aggregatedData
          // CRITICAL: Use aggregatedData.values (which has been filtered above)
          // NOT paramFile.data.values (which contains ALL contexts)
          const allValuesWithDaily = (aggregatedData.values as ParameterValue[])
            .filter(v => v.n_daily && v.k_daily && v.dates && v.n_daily.length > 0);
          
          // Check if we're in MECE aggregation mode (uncontexted query on contexted data)
          // IMPORTANT:
          // - contextAny queries are NOT uncontexted - they explicitly specify which slices to use
          // - presence of cohort()/window() alone does NOT make data "contexted"
          const targetSliceDimensions = extractSliceDimensions(targetSlice);
          const isUncontextedQuery = targetSliceDimensions === '' && !hasContextAny(targetSlice);

          // Detect contexted vs uncontexted data based on context/case dimensions,
          // NOT merely on non-empty sliceDSL (cohort/window alone are not contexts).
          const hasContextedData = allValuesWithDaily.some(v => {
            const dims = extractSliceDimensions(v.sliceDSL ?? '');
            return dims !== '';
          });
          const hasUncontextedData = allValuesWithDaily.some(v => {
            const dims = extractSliceDimensions(v.sliceDSL ?? '');
            return dims === '';
          });

          // MECE aggregation ONLY applies when:
          // - Query is uncontexted (no explicit context/case)
          // - File has contexted data
          // - AND there is NO uncontexted slice (purely contexted file)
          const isMECEAggregation = isUncontextedQuery && hasContextedData && !hasUncontextedData;
          
          // For MECE aggregation, use ALL values (already filtered above)
          // For contextAny/specific slice queries, isolate to target slice
          const valuesWithDaily = isMECEAggregation 
            ? allValuesWithDaily  // MECE: use all values, they'll be summed
            : isolateSlice(allValuesWithDaily, targetSlice);  // contextAny or specific slice
          
          markTime('beforeSignatureValidation');
          if (valuesWithDaily.length > 0) {
            try {
            // Validate query signature consistency
            // Build DSL from edge to compute expected query signature
            let expectedQuerySignature: string | undefined;
            let querySignatureMismatch = false;
            const mismatchedEntries: Array<{ window: string; signature: string | undefined }> = [];
            
            if (edgeId && graph) {
              try {
                const sigStart = performance.now();
                // Build DSL from edge to get current query
                
                // Get connection name for signature computation
                const connectionName = targetEdge.p?.connection || 
                                     targetEdge.cost_gbp?.connection || 
                                     targetEdge.labour_cost?.connection ||
                                     paramFile.data.connection;
                
                // Get connection to extract provider (use cached runner to avoid per-call overhead)
                const dasRunner = getCachedDASRunner();
                let connectionProvider: string | undefined;
                
                const t1 = performance.now();
                try {
                  const connection = connectionName ? await (dasRunner as any).connectionProvider.getConnection(connectionName) : null;
                  connectionProvider = connection?.provider;
                } catch (e) {
                  console.warn('Could not load connection for provider mapping:', e);
                }
                const t2 = performance.now();
                
                // Event loader that reads from IDB
                const eventLoader = async (eventId: string) => {
                  const fileId = `event-${eventId}`;
                  const file = fileRegistry.getFile(fileId);
                  
                  if (file && file.data) {
                    return file.data;
                  }
                  
                  // Fallback: return minimal event without mapping
                  return {
                    id: eventId,
                    name: eventId,
                    provider_event_names: {}
                  };
                };
                
                // Parse and merge constraints from graph-level and edge-specific queries
                // CRITICAL: Use targetSlice (passed DSL) instead of graph.currentQueryDSL
                // This ensures we use the window that was specified when calling getParameterFromFile,
                // not the stale graph.currentQueryDSL which may not have been updated
                let constraints;
                try {
                  // Parse constraints from targetSlice (the DSL passed to this function)
                  // This is the source of truth for window - NOT graph.currentQueryDSL
                  const sliceConstraints = targetSlice ? parseConstraints(targetSlice) : null;
                  
                  // Parse edge-specific constraints
                  const edgeConstraints = targetEdge.query ? parseConstraints(targetEdge.query) : null;
                  
                  // Merge: edge-specific overrides slice-level
                  constraints = {
                    context: [...(sliceConstraints?.context || []), ...(edgeConstraints?.context || [])],
                    contextAny: [...(sliceConstraints?.contextAny || []), ...(edgeConstraints?.contextAny || [])],
                    window: edgeConstraints?.window || sliceConstraints?.window || null,
                    cohort: edgeConstraints?.cohort || sliceConstraints?.cohort || null,  // A-anchored cohort for latency edges
                    visited: edgeConstraints?.visited || [],
                    visitedAny: edgeConstraints?.visitedAny || []
                  };
                  
                  console.log('[DataOps:getParameterFromFile] Merged constraints:', {
                    targetSlice,
                    graphDSL: graph?.currentQueryDSL,
                    edgeQuery: targetEdge.query,
                    merged: constraints
                  });
                } catch (error) {
                  console.warn('[DataOps:getDataSnapshot] Failed to parse constraints:', error);
                }
                
                // Build DSL from edge
                const t3 = performance.now();
                const compResult = await buildDslFromEdge(
                  targetEdge,
                  graph,
                  connectionProvider,
                  eventLoader,
                  constraints  // Pass constraints for context filters
                );
                const t4 = performance.now();
                const compDsl = compResult.queryPayload;
                const compEventDefs = compResult.eventDefinitions;
                
                // Compute expected query signature (include event_ids from nodes)
                expectedQuerySignature = await computeQuerySignature(compDsl, connectionName, graph, targetEdge);
                const t5 = performance.now();
                
                console.log(`[TIMING:SIG] ${paramId}: getConnection=${(t2-t1).toFixed(1)}ms, buildDsl=${(t4-t3).toFixed(1)}ms, computeSig=${(t5-t4).toFixed(1)}ms, total=${(t5-sigStart).toFixed(1)}ms`);
                
                // Find the latest query signature by timestamp
                // Group entries by query signature and find the most recent timestamp for each
                const signatureTimestamps = new Map<string, string>();
                let hasAnySignatures = false;
                for (const value of valuesWithDaily) {
                  if (value.query_signature) {
                    hasAnySignatures = true;
                    const timestamp = value.data_source?.retrieved_at || value.window_to || value.window_from || '';
                    const existingTimestamp = signatureTimestamps.get(value.query_signature);
                    if (!existingTimestamp || timestamp > existingTimestamp) {
                      signatureTimestamps.set(value.query_signature, timestamp);
                    }
                  }
                }
                
                // Find the latest signature (one with the most recent timestamp)
                let latestQuerySignature: string | undefined;
                let latestTimestamp = '';
                for (const [signature, timestamp] of signatureTimestamps.entries()) {
                  if (timestamp > latestTimestamp) {
                    latestTimestamp = timestamp;
                    latestQuerySignature = signature;
                  }
                }
                
                // Check all value entries for signature consistency
                for (const value of valuesWithDaily) {
                  if (value.query_signature && value.query_signature !== expectedQuerySignature) {
                    querySignatureMismatch = true;
                    // Use window or cohort dates as available
                    const rangeStart = value.window_from || value.cohort_from;
                    const rangeEnd = value.window_to || value.cohort_to;
                    const windowDesc = rangeStart && rangeEnd 
                      ? `${normalizeDate(rangeStart)} to ${normalizeDate(rangeEnd)}`
                      : '(no date range)';
                    mismatchedEntries.push({
                      window: windowDesc,
                      signature: value.query_signature,
                    });
                  }
                }
                
                // If we found a latest signature and it differs from expected, use the latest one
                // (This handles the case where event definitions changed)
                const signatureToUse = latestQuerySignature || expectedQuerySignature;
                
                if (querySignatureMismatch || (latestQuerySignature && latestQuerySignature !== expectedQuerySignature)) {
                  // Log for debugging, but don't toast - file having old signatures is normal
                  // and the system handles it correctly by using latest signature data
                  console.log('[DataOperationsService] Query signature mismatch detected (using latest):', {
                    expectedSignature: expectedQuerySignature,
                    latestSignature: latestQuerySignature,
                    signatureToUse,
                    mismatchedEntries: mismatchedEntries.length,
                    totalEntries: valuesWithDaily.length,
                  });
                  // NOTE: No toast - this is informational, not actionable by user
                  // The file may have accumulated entries from different event configs over time
                  // We use the latest signature and the data is still correct
                }
                
                // CRITICAL: Always filter to ONLY signed values matching the signature
                // Signature validation: check staleness, but don't filter
                // (Filtering by slice already done via isolateSlice above)
                if (signatureToUse) {
                  const staleValues = valuesWithDaily.filter(v => 
                    v.query_signature && v.query_signature !== signatureToUse
                  );
                  
                  if (staleValues.length > 0) {
                    console.warn(`[DataOperationsService] ${staleValues.length} values have stale signatures (query config may have changed)`);
                  }
                  
                  // Note: We still USE the data (keyed by sliceDSL), but warn about staleness
                }
              } catch (error) {
                console.warn('[DataOperationsService] Failed to validate query signature:', error);
                // Continue with aggregation even if signature validation fails
              }
            }
            markTime('afterSignatureValidation');
            
            // Combine all daily data from all value entries into a single time series
            const allTimeSeries: TimeSeriesPoint[] = [];
            
            // CRITICAL: For evidence filtering, use the correct date range:
            // - cohort() queries: filter by cohort entry dates (cohortWindow)
            // - window() queries: filter by observation window (window)
            // This ensures evidence.mean reflects only the requested date range.
            // Note: At this point, at least one of cohortWindow or window is defined
            // (guaranteed by the hasDateRangeQuery check above)
            const evidenceFilterWindow: DateRange = (isCohortQuery && cohortWindow)
              ? cohortWindow
              : window!; // Non-null assertion safe: we're inside hasDateRangeQuery check
            
            const normalizedWindow: DateRange = {
              start: normalizeDate(evidenceFilterWindow.start),
              end: normalizeDate(evidenceFilterWindow.end),
            };
            
            console.log('[DataOperationsService] Aggregating with date filter:', {
              isCohortQuery,
              cohortWindow: cohortWindow ? { start: normalizeDate(cohortWindow.start), end: normalizeDate(cohortWindow.end) } : null,
              window: window ? { start: normalizeDate(window.start), end: normalizeDate(window.end) } : null,
              effectiveFilter: normalizedWindow,
              entriesWithDaily: valuesWithDaily.length,
            });
            
            // Process entries in order (newest last) so newer entries overwrite older ones
            // If query signature validation passed, prefer entries with matching signature
            const sortedValues = [...valuesWithDaily].sort((a, b) => {
              // If we have an expected signature, prefer matching entries
              if (expectedQuerySignature) {
                const aMatches = a.query_signature === expectedQuerySignature;
                const bMatches = b.query_signature === expectedQuerySignature;
                if (aMatches && !bMatches) return -1;
                if (!aMatches && bMatches) return 1;
              }
              // Sort by retrieved_at or date range (newest last) so newer entries overwrite older ones
              // Check both window and cohort date fields
              const aDate = a.data_source?.retrieved_at || a.window_to || a.cohort_to || a.window_from || a.cohort_from || '';
              const bDate = b.data_source?.retrieved_at || b.window_to || b.cohort_to || b.window_from || b.cohort_from || '';
              return aDate.localeCompare(bDate); // Oldest first, so when we process in order, newer overwrites older
            });
            
            // Check if we're aggregating across MULTIPLE slices (contextAny query)
            // In that case, we SUM values across different slices. Within SAME slice, newer overwrites older.
            // 
            // CRITICAL: Detect from QUERY, not from data - data might have empty/incorrect sliceDSL
            const isContextAnyQuery = hasContextAny(targetSlice);
            
            // Also check data for multiple unique slices (fallback detection)
            const uniqueSlices = new Set(sortedValues.map(v => v.sliceDSL || ''));
            const isMultiSliceAggregation = isContextAnyQuery || uniqueSlices.size > 1;
            
            if (isMultiSliceAggregation) {
              console.log(`[DataOperationsService] Multi-slice aggregation detected: ${isContextAnyQuery ? 'contextAny query' : 'multiple unique slices in data'}`, {
                targetSlice,
                uniqueSlices: Array.from(uniqueSlices),
              });
            }
            
            // Track which slice contributed to each date (for multi-slice: sum; for same-slice: overwrite)
            // For contextAny queries: each VALUE ENTRY represents a different slice, even if sliceDSL is empty
            const dateSliceMap: Map<string, Set<string>> = new Map();
            
            for (let entryIdx = 0; entryIdx < sortedValues.length; entryIdx++) {
              const value = sortedValues[entryIdx];
              const valueSlice = value.sliceDSL || '';
              
              // For contextAny queries, use entry index as slice ID (each entry = different slice)
              // For regular queries, use sliceDSL (empty means single slice)
              const sliceIdentifier = isContextAnyQuery 
                ? `entry-${entryIdx}:${valueSlice}`  // Each entry is a distinct slice
                : valueSlice;                        // Traditional: use sliceDSL
              
              if (value.n_daily && value.k_daily && value.dates) {
                // DEBUG: Log what's in the value entry
                console.log(`[LAG_DEBUG] READ_VALUE entry ${entryIdx}:`, {
                  datesCount: value.dates?.length,
                  hasMedianLagArray: !!value.median_lag_days,
                  medianLagArrayLength: value.median_lag_days?.length,
                  medianLagSample: value.median_lag_days?.slice(0, 3),
                  hasMeanLagArray: !!value.mean_lag_days,
                  meanLagArrayLength: value.mean_lag_days?.length,
                  meanLagSample: value.mean_lag_days?.slice(0, 3),
                });
                
                // Use window_from/window_to for window slices, cohort_from/cohort_to for cohort slices
                const entryStart = value.window_from || value.cohort_from || value.dates[0] || '';
                const entryEnd = value.window_to || value.cohort_to || value.dates[value.dates.length - 1] || '';
                const entryWindow = entryStart && entryEnd 
                  ? `${normalizeDate(entryStart)} to ${normalizeDate(entryEnd)}`
                  : '(no date range)';
                let entryDatesInWindow = 0;
                
                for (let i = 0; i < value.dates.length; i++) {
                  const date = normalizeDate(value.dates[i]);
                  // Only add if date is within window
                  if (isDateInRange(date, normalizedWindow)) {
                    entryDatesInWindow++;
                    const existingIndex = allTimeSeries.findIndex(p => normalizeDate(p.date) === date);
                    
                    if (existingIndex >= 0) {
                      // Date already exists - check if same slice (overwrite) or different slice (sum)
                      const existingSlices = dateSliceMap.get(date) || new Set();
                      
                      if (isMultiSliceAggregation && !existingSlices.has(sliceIdentifier)) {
                        // Different slice in multi-slice aggregation: SUM
                        const oldN = allTimeSeries[existingIndex].n;
                        const oldK = allTimeSeries[existingIndex].k;
                        const newN = oldN + value.n_daily[i];
                        const newK = oldK + value.k_daily[i];
                        // For lag data in multi-slice: use weighted average if both have data, else use whichever has data
                        const oldLag = allTimeSeries[existingIndex].median_lag_days;
                        const newLag = value.median_lag_days?.[i];
                        const combinedMedianLag = (oldLag !== undefined && newLag !== undefined)
                          ? (oldLag * oldK + newLag * value.k_daily[i]) / newK  // Weighted average by k
                          : (newLag ?? oldLag);
                        const oldMeanLag = allTimeSeries[existingIndex].mean_lag_days;
                        const newMeanLag = value.mean_lag_days?.[i];
                        const combinedMeanLag = (oldMeanLag !== undefined && newMeanLag !== undefined)
                          ? (oldMeanLag * oldK + newMeanLag * value.k_daily[i]) / newK
                          : (newMeanLag ?? oldMeanLag);
                        allTimeSeries[existingIndex] = {
                          date: value.dates[i],
                          n: newN,
                          k: newK,
                          p: newN > 0 ? newK / newN : 0,
                          median_lag_days: combinedMedianLag,
                          mean_lag_days: combinedMeanLag,
                        };
                        existingSlices.add(sliceIdentifier);
                        dateSliceMap.set(date, existingSlices);
                        console.log(`[DataOperationsService] Entry ${entryIdx} [${valueSlice || 'no-slice'}]: SUMMED ${date} (n: ${oldN} + ${value.n_daily[i]} = ${newN})`);
                      } else {
                        // Same slice or single-slice: overwrite (newer data)
                        const oldN = allTimeSeries[existingIndex].n;
                        allTimeSeries[existingIndex] = {
                          date: value.dates[i],
                          n: value.n_daily[i],
                          k: value.k_daily[i],
                          p: value.n_daily[i] > 0 ? value.k_daily[i] / value.n_daily[i] : 0,
                          // Include lag data if available (cohort mode)
                          median_lag_days: value.median_lag_days?.[i],
                          mean_lag_days: value.mean_lag_days?.[i],
                        };
                        console.log(`[DataOperationsService] Entry ${entryIdx} [${valueSlice || 'no-slice'}]: Overwrote ${date} (n: ${oldN} → ${value.n_daily[i]})`);
                      }
                    } else {
                      // New date - add entry
                      allTimeSeries.push({
                        date: value.dates[i],
                        n: value.n_daily[i],
                        k: value.k_daily[i],
                        p: value.n_daily[i] > 0 ? value.k_daily[i] / value.n_daily[i] : 0,
                        // Include lag data if available (cohort mode)
                        median_lag_days: value.median_lag_days?.[i],
                        mean_lag_days: value.mean_lag_days?.[i],
                      });
                      const sliceSet = new Set([sliceIdentifier]);
                      dateSliceMap.set(date, sliceSet);
                      console.log(`[DataOperationsService] Entry ${entryIdx} [${valueSlice || 'no-slice'}]: Added ${date} (n: ${value.n_daily[i]}, lag: ${value.median_lag_days?.[i]?.toFixed(1) ?? 'N/A'})`);
                    }
                  }
                }
                
                console.log(`[DataOperationsService] Entry ${entryIdx} [${valueSlice || 'no-slice'}]: window=${entryWindow}, datesInWindow=${entryDatesInWindow}/${value.dates.length}`);
              }
            }
            
            if (isMultiSliceAggregation) {
              console.log(`[DataOperationsService] Multi-slice aggregation completed:`, {
                isContextAnyQuery,
                entriesProcessed: sortedValues.length,
                uniqueSlicesFromData: Array.from(uniqueSlices),
              });
            }
            
            console.log('[DataOperationsService] Combined time series:', {
              totalPoints: allTimeSeries.length,
              dates: allTimeSeries.map(p => p.date),
              nValues: allTimeSeries.map(p => ({ date: p.date, n: p.n, k: p.k, p: (p.k/p.n*100).toFixed(1)+'%' })),
              totalN: allTimeSeries.reduce((sum, p) => sum + p.n, 0),
              totalK: allTimeSeries.reduce((sum, p) => sum + p.k, 0),
              expectedStdev: (() => {
                const totalN = allTimeSeries.reduce((sum, p) => sum + p.n, 0);
                const totalK = allTimeSeries.reduce((sum, p) => sum + p.k, 0);
                if (totalN === 0) return 'N/A';
                const p = totalK / totalN;
                return (Math.sqrt((p * (1 - p)) / totalN) * 100).toFixed(2) + '%';
              })(),
            });
            
            // Sort by date
            allTimeSeries.sort((a, b) => {
              const dateA = parseDate(a.date).getTime();
              const dateB = parseDate(b.date).getTime();
              return dateA - dateB;
            });
            
            // Aggregate the combined time series
            const aggregation = windowAggregationService.aggregateWindow(allTimeSeries, normalizedWindow);
            
            // Enhance with statistical methods (inverse-variance weighting by default)
            // Handle both sync (TS) and async (Python) results
            const enhancedResult = statisticalEnhancementService.enhance(aggregation, 'inverse-variance');
            const enhanced = enhancedResult instanceof Promise 
              ? await enhancedResult 
              : enhancedResult;
            
            // LAG: Compute latency statistics if edge has latency tracking enabled
            // See design.md §5.3-5.6 for the statistical model
            let latencyStats: EdgeLatencyStats | undefined;
            const maturityDays = targetEdge?.p?.latency?.maturity_days;
            const pathT95 = targetEdge?.p?.latency?.path_t95 ?? 0;
            
            if (maturityDays && maturityDays > 0 && valuesWithDaily.length > 0) {
              try {
                // Convert time series to cohort data for LAG calculations
                const queryDate = new Date();
                const cohortData: CohortData[] = [];
                
                // Build cohort data from all time series points
                for (const point of allTimeSeries) {
                  const cohortDate = parseDate(point.date);
                  const ageMs = queryDate.getTime() - cohortDate.getTime();
                  const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
                  
                  cohortData.push({
                    date: point.date,
                    n: point.n,
                    k: point.k,
                    age: Math.max(0, ageDays),
                    // Include per-cohort lag data if available (cohort mode)
                    median_lag_days: point.median_lag_days,
                    mean_lag_days: point.mean_lag_days,
                  });
                }
                
                // Get aggregate lag stats from values (if available from cohort mode data)
                const lagStats = aggregateLatencyStats(cohortData);
                const aggregateMedianLag = lagStats?.median_lag_days ?? maturityDays / 2;
                const aggregateMeanLag = lagStats?.mean_lag_days;
                
                // Compute full latency statistics using Formula A and CDF fitting
                // Pass pathT95 to adjust cohort ages for downstream edges
                latencyStats = computeEdgeLatencyStats(
                  cohortData,
                  aggregateMedianLag,
                  aggregateMeanLag,
                  maturityDays,
                  pathT95
                );
                
                console.log('[DataOperationsService] LAG statistics computed:', {
                  maturityDays,
                  cohortCount: cohortData.length,
                  latencyStats: {
                    t95: latencyStats.t95,
                    p_infinity: latencyStats.p_infinity,
                    p_mean: latencyStats.p_mean,
                    p_evidence: latencyStats.p_evidence,
                    completeness: latencyStats.completeness,
                    forecast_available: latencyStats.forecast_available,
                    fit_quality_ok: latencyStats.fit.empirical_quality_ok,
                  },
                });
              } catch (error) {
                console.warn('[DataOperationsService] LAG computation failed:', error);
                // Continue without latency stats - non-fatal
              }
            }
            
            // Find the most recent value entry with a data_source (prefer non-manual sources)
            // Sort by retrieved_at or window_to descending to get most recent
            const sortedByDate = [...valuesWithDaily].sort((a, b) => {
              const aDate = a.data_source?.retrieved_at || a.window_to || '';
              const bDate = b.data_source?.retrieved_at || b.window_to || '';
              return bDate.localeCompare(aDate); // Descending (newest first)
            });
            
            // Prefer entries with data_source.type that's not 'manual' or 'file'
            const latestValueWithSource = sortedByDate.find(v => 
              v.data_source?.type && 
              v.data_source.type !== 'manual' && 
              v.data_source.type !== 'file'
            ) || sortedByDate[0]; // Fallback to most recent entry
            
            // Create a new aggregated value entry
            // LAG FIX (lag-fixes.md §4.2): For latency edges, we normally use
            // Formula A blended p_mean for the 'mean' field, with evidence stored
            // separately. However, when this aggregation corresponds EXACTLY to a
            // single stored slice (e.g. window(25-Nov-25:1-Dec-25)), we trust the
            // pre-computed mean/stdev on that slice and only use latencyStats for
            // evidence/forecast/latency diagnostics (design.md §4.8 table).
            const isSingleExactSlice =
              !isMultiSliceAggregation &&
              sortedValues.length === 1 &&
              latestValueWithSource?.sliceDSL === targetSlice;
            
            let blendedMean: number;
            let blendedStdev: number;
            
            // Helper to check for valid numbers (not NaN/Infinity)
            const isValidNumber = (n: number | undefined): n is number => 
              n !== undefined && !Number.isNaN(n) && Number.isFinite(n);
            
            if (latencyStats) {
              if (isSingleExactSlice && latestValueWithSource?.mean !== undefined) {
                // Exact stored slice: preserve file mean/stdev to avoid tiny numerical
                // drift between Python and TS implementations.
                blendedMean = latestValueWithSource.mean;
                blendedStdev = latestValueWithSource.stdev ?? enhanced.stdev;
              } else {
                // Guard against NaN from latencyStats - fall back to evidence if NaN
                blendedMean = isValidNumber(latencyStats.p_mean) ? latencyStats.p_mean : enhanced.mean;
                blendedStdev = enhanced.n > 0
                  ? Math.sqrt((blendedMean * (1 - blendedMean)) / enhanced.n)
                  : 0;
              }
            } else {
              blendedMean = enhanced.mean;
              blendedStdev = enhanced.stdev;
            }
            
            // Final NaN guard
            if (!isValidNumber(blendedMean)) blendedMean = enhanced.mean;
            if (!isValidNumber(blendedStdev)) blendedStdev = enhanced.stdev;
            
            // Compute evidence scalars (raw observed rate = k/n)
            const evidenceMean = enhanced.n > 0 ? enhanced.k / enhanced.n : 0;
            const evidenceStdev = enhanced.n > 0 
              ? Math.sqrt((evidenceMean * (1 - evidenceMean)) / enhanced.n) 
              : 0;
            
            // Use the effective filter window for storing date bounds
            // For cohort queries, this is the cohort window; for window queries, it's the window
            const effectiveWindow = evidenceFilterWindow;
            
            const aggregatedValue = {
              mean: blendedMean,
              stdev: blendedStdev,
              n: enhanced.n,
              k: enhanced.k,
              // Store both window_from/to (standard) and cohort_from/to if applicable
              ...(isCohortQuery && cohortWindow ? {
                cohort_from: normalizeToUK(cohortWindow.start),
                cohort_to: normalizeToUK(cohortWindow.end),
              } : {}),
              window_from: normalizeToUK(effectiveWindow.start),
              window_to: normalizeToUK(effectiveWindow.end),
              data_source: {
                type: latestValueWithSource?.data_source?.type || 'file',
                retrieved_at: new Date().toISOString(),
                // NOTE: data_source.query removed - unused and caused type mismatches with Python
                full_query: latestValueWithSource?.data_source?.full_query,
              },
              // LAG FIX: Include evidence scalars for graph edge p.evidence.mean/stdev
              evidence: {
                mean: evidenceMean,
                stdev: evidenceStdev,
              },
              // LAG: Include latency stats if computed (for UpdateManager to apply to edge)
              ...(latencyStats && {
                latency: {
                  median_lag_days: latencyStats.fit.mu ? Math.exp(latencyStats.fit.mu) : undefined,
                  completeness: latencyStats.completeness,
                  t95: latencyStats.t95,
                },
                // Only include forecast if available (requires mature cohorts for p_infinity)
                ...(latencyStats.forecast_available && {
                  forecast: latencyStats.p_infinity,
                }),
              }),
            } as ParameterValue;
            
            // Create a modified parameter file data with aggregated value
            // CRITICAL: Preserve the inferred type from earlier (if paramFile.data lacked it)
            aggregatedData = {
              ...paramFile.data,
              type: aggregatedData.type || paramFile.data.type,  // Preserve inferred type
              values: [aggregatedValue], // Replace with single aggregated value
            };
            
            console.log('[DataOperationsService] Window aggregation result:', {
              window,
              aggregation: {
                ...aggregation,
                stdev: aggregation.stdev,
                stdevPercent: (aggregation.stdev * 100).toFixed(2) + '%',
              },
              enhanced: {
                ...enhanced,
                stdev: enhanced.stdev,
                stdevPercent: (enhanced.stdev * 100).toFixed(2) + '%',
              },
              // LAG FIX: Show evidence vs blended mean separately
              evidence: {
                mean: evidenceMean,
                stdev: evidenceStdev,
                meanPercent: (evidenceMean * 100).toFixed(2) + '%',
              },
              blended: {
                mean: blendedMean,
                stdev: blendedStdev,
                meanPercent: (blendedMean * 100).toFixed(2) + '%',
              },
              aggregatedValue: {
                ...aggregatedValue,
                stdev: aggregatedValue.stdev ?? 0,
                stdevPercent: ((aggregatedValue.stdev ?? 0) * 100).toFixed(2) + '%',
              },
              entriesProcessed: valuesWithDaily.length,
              totalDays: allTimeSeries.length,
              missingDates: aggregation.missing_dates,
              gaps: aggregation.gaps,
              missingAtStart: aggregation.missing_at_start,
              missingAtEnd: aggregation.missing_at_end,
              hasMiddleGaps: aggregation.has_middle_gaps,
              hasLatencyStats: !!latencyStats,
            });
            
            // Add session log child with aggregation details
            const slicesSummary = isMultiSliceAggregation 
              ? `${uniqueSlices.size} slices` 
              : (Array.from(uniqueSlices)[0] || 'uncontexted');
            sessionLogService.addChild(logOpId, 'info', 'AGGREGATION_RESULT',
              `Aggregated ${allTimeSeries.length} days from ${slicesSummary}: n=${enhanced.n}, k=${enhanced.k}, evidence=${(evidenceMean * 100).toFixed(1)}%, blended=${(blendedMean * 100).toFixed(1)}%`,
              `${isCohortQuery ? 'Cohort' : 'Window'}: ${normalizeToUK(evidenceFilterWindow.start)} to ${normalizeToUK(evidenceFilterWindow.end)}`,
              { 
                slices: Array.from(uniqueSlices),
                n: enhanced.n, 
                k: enhanced.k, 
                evidence_mean: evidenceMean,
                blended_mean: blendedMean,
                daysAggregated: allTimeSeries.length,
                isMultiSlice: isMultiSliceAggregation,
                hasLatencyStats: !!latencyStats,
              }
            );
            
            if (aggregation.days_missing > 0) {
              // Missing data detected - this is expected when filtering to latest signature
              // If called from "get from file", suggest getting from source
              // If called from "get from source", the fetch logic should handle it
              
              // Build detailed message about missing dates
              let message = `⚠ Aggregated ${aggregation.days_included} days (${aggregation.days_missing} missing)`;
              let locationInfo = '';
              
              if (aggregation.missing_at_start && aggregation.missing_at_end) {
                locationInfo = 'missing at start and end';
                message += ` - ${locationInfo}`;
              } else if (aggregation.missing_at_start) {
                locationInfo = 'missing at start';
                message += ` - ${locationInfo}`;
              } else if (aggregation.missing_at_end) {
                locationInfo = 'missing at end';
                message += ` - ${locationInfo}`;
              }
              
              if (aggregation.has_middle_gaps) {
                locationInfo += locationInfo ? ', gaps in middle' : 'gaps in middle';
                message += ` - gaps in middle`;
              }
              
              let gapSummary = '';
              if (aggregation.gaps.length > 0) {
                gapSummary = aggregation.gaps.map(g => 
                  g.length === 1 ? g.start : `${g.start} to ${g.end} (${g.length} days)`
                ).join(', ');
                console.warn('[DataOperationsService] Missing date gaps:', gapSummary);
              }
              
              // This is called from "get from file" - suggest getting from source
              message += `. Try getting from source to fetch missing data.`;
              
              toast(message, {
                icon: '⚠️',
                duration: 5000,
              });
              
              // Add session log child for visibility
              sessionLogService.addChild(logOpId, 'warning', 'MISSING_DATA', 
                `${aggregation.days_included}/${aggregation.days_included + aggregation.days_missing} days available${locationInfo ? ` (${locationInfo})` : ''}`,
                gapSummary || undefined,
                { 
                  daysIncluded: aggregation.days_included,
                  daysMissing: aggregation.days_missing,
                  gaps: gapSummary || undefined,
                }
              );
              
              // Track the warning for return value
              missingDataWarning = `${aggregation.days_missing} days missing`;
            }
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            // If no data available for window, don't fall back - show error and return early
            if (errorMsg.includes('No data available for window')) {
              const filterRange = (isCohortQuery && cohortWindow) ? cohortWindow : window;
              toast.error(`No data available for selected ${isCohortQuery ? 'cohort' : 'window'} (${filterRange?.start} to ${filterRange?.end})`);
              sessionLogService.endOperation(logOpId, 'error', `No data for ${isCohortQuery ? 'cohort' : 'window'} (${filterRange?.start} to ${filterRange?.end})`);
              return { success: false }; // Don't proceed with file-to-graph update
            }
            toast.error(`Window aggregation failed: ${errorMsg}`);
            // Fall back to regular file-to-graph update only for other errors
            // IMPORTANT: Track the error so session log can report 'warning' instead of 'success'
            aggregationFallbackError = errorMsg;
            console.warn('[DataOperationsService] Falling back to regular update:', error);
            sessionLogService.addChild(logOpId, 'warning', 'AGGREGATION_FALLBACK', 
              `Window aggregation failed, using raw file values`, 
              errorMsg, 
              { error: errorMsg }
            );
          }
          } else {
            // No daily data available, fall back to regular update
            console.log('[DataOperationsService] No daily data found, using regular update');
          }
        }
      }
      markTime('afterAggregation');
      
      // LAG FIX (lag-fixes.md §4.2, §4.6):
      // Ensure evidence and forecast scalars are present on ParameterValue entries
      // BEFORE passing to UpdateManager, for ALL code paths (window aggregation and
      // simple slice-to-edge updates). This guarantees:
      // - values[latest].evidence.mean/stdev → p.evidence.mean/stdev
      // - values[latest].forecast           → p.forecast.mean
      aggregatedData = this.addEvidenceAndForecastScalars(
        aggregatedData,
        paramFile.data,
        targetSlice
      );
      
      // Call UpdateManager to transform data
      // Use validateOnly: true to get changes without mutating targetEdge in place
      // (we apply changes ourselves to nextGraph after cloning)
      const result = await updateManager.handleFileToGraph(
        aggregatedData,    // source (parameter file data, possibly aggregated)
        targetEdge,        // target (graph edge) - used for override checks, not mutated
        'UPDATE',          // operation
        'parameter',       // sub-destination
        { interactive: true, validateOnly: true }  // Don't apply in UpdateManager, we'll use applyChanges
      );
      markTime('afterUpdateManager');
      
      if (!result.success) {
        if (result.conflicts && result.conflicts.length > 0) {
          toast.error(`Conflicts found: ${result.conflicts.length} field(s) overridden`);
          sessionLogService.endOperation(logOpId, 'error', `Conflicts: ${result.conflicts.length} field(s) overridden`);
          // TODO: Show conflict resolution modal
        } else {
          toast.error('Update failed');
          sessionLogService.endOperation(logOpId, 'error', 'Update failed');
        }
        return { success: false };
      }
      
      // Apply changes to graph
      const nextGraph = structuredClone(graph);
      const edgeIndex = nextGraph.edges.findIndex((e: any) => 
        e.uuid === edgeId || 
        e.id === edgeId ||
        `${e.from}->${e.to}` === edgeId
      );
      
      console.log('[DataOperationsService] BEFORE applyChanges:', {
        edgeId,
        edgeIndex,
        'edge.p': JSON.stringify(nextGraph.edges[edgeIndex]?.p),
        changes: JSON.stringify(result.changes),
        conditionalIndex
      });
      
      if (edgeIndex >= 0 && result.changes) {
        // ===== CONDITIONAL_P HANDLING =====
        // Use unified UpdateManager code path for conditional probability updates
        if (conditionalIndex !== undefined) {
          // Validate conditional_p entry exists before attempting update
          if (!nextGraph.edges[edgeIndex].conditional_p?.[conditionalIndex]) {
            console.error('[DataOperationsService] conditional_p entry not found for getParameterFromFile', {
              conditionalIndex,
              conditionalPLength: nextGraph.edges[edgeIndex].conditional_p?.length
            });
            toast.error(`Conditional entry [${conditionalIndex}] not found on edge`);
            sessionLogService.endOperation(logOpId, 'error', `Conditional entry [${conditionalIndex}] not found`);
            return { success: false };
          }
          
          const { updateManager } = await import('./UpdateManager');
          
          // Extract values from the changes that UpdateManager's handleFileToEdge produced
          // (these already have transforms applied - rounding, etc.)
          const meanChange = result.changes.find((c: { field: string }) => c.field === 'p.mean');
          const stdevChange = result.changes.find((c: { field: string }) => c.field === 'p.stdev');
          const nChange = result.changes.find((c: { field: string }) => c.field === 'p.evidence.n');
          const kChange = result.changes.find((c: { field: string }) => c.field === 'p.evidence.k');
          
          console.log('[DataOperationsService] Applying file changes to conditional_p via UpdateManager:', {
            conditionalIndex,
            meanChange,
            stdevChange,
            nChange,
            kChange
          });
          
          // Apply via unified UpdateManager method
          let updatedGraph = updateManager.updateConditionalProbability(
            graph,
            edgeId,
            conditionalIndex,
            {
              mean: meanChange?.newValue,
              stdev: stdevChange?.newValue,
              evidence: (nChange || kChange) ? {
                n: nChange?.newValue,
                k: kChange?.newValue
              } : undefined
            },
            { respectOverrides: true }
          );
          
          // AUTO-REBALANCE: If mean was updated, rebalance conditional probability siblings
          let finalGraph = updatedGraph;
          const meanWasUpdated = meanChange !== undefined;
          
          if (meanWasUpdated && updatedGraph !== graph) {
            const updatedEdgeId = edgeId;
            
            console.log('[DataOperationsService] Rebalancing conditional_p siblings after file update:', {
              updatedEdgeId,
              conditionalIndex,
              meanWasUpdated
            });
            
            finalGraph = updateManager.rebalanceConditionalProbabilities(
              updatedGraph,
              updatedEdgeId,
              conditionalIndex,
              false // Don't force rebalance - respect overrides
            );
          }
          
          setGraph(finalGraph);
          
          const hadRebalance = finalGraph !== updatedGraph;
          if (hadRebalance) {
            batchableToastSuccess(`✓ Updated conditional[${conditionalIndex}] from ${paramId}.yaml + siblings rebalanced`, { duration: 2000 });
            sessionLogService.endOperation(logOpId, 'success', `Updated conditional_p[${conditionalIndex}] + siblings rebalanced`);
          } else {
            batchableToastSuccess(`✓ Updated conditional[${conditionalIndex}] from ${paramId}.yaml`, { duration: 2000 });
            sessionLogService.endOperation(logOpId, 'success', `Updated conditional_p[${conditionalIndex}] from ${paramId}.yaml`);
          }
          return { success: true }; // Done - skip the base edge path below
        }
        // ===== END CONDITIONAL_P HANDLING =====
        
        // Apply changes to the edge (base p slot)
        applyChanges(nextGraph.edges[edgeIndex], result.changes);
        
        console.log('[DataOperationsService] AFTER applyChanges:', {
          'edge.p': JSON.stringify(nextGraph.edges[edgeIndex]?.p)
        });
        
        // Ensure we do NOT lose the correct parameter connection id after file update.
        // Detect which slot to use from parameter file type OR from changes
        if (paramId) {
          let slot: 'p' | 'cost_gbp' | 'labour_cost' | null = null;
          
          // First, try to determine slot from parameter file type
          const paramType = paramFile.data?.type || paramFile.data?.parameter_type;
          if (paramType === 'probability') {
            slot = 'p';
          } else if (paramType === 'cost_gbp') {
            slot = 'cost_gbp';
          } else if (paramType === 'labour_cost') {
            slot = 'labour_cost';
          } else {
            // Fallback: try to infer from changes
            const fields = (result.changes || []).map((c: any) => c.field || '');
            if (fields.some(f => f.startsWith('cost_gbp'))) slot = 'cost_gbp';
            else if (fields.some(f => f.startsWith('labour_cost'))) slot = 'labour_cost';
            else if (fields.some(f => f === 'p' || f.startsWith('p.'))) slot = 'p';
          }
          
          if (slot) {
            if (!nextGraph.edges[edgeIndex][slot]) {
              // initialize object for the slot
              (nextGraph.edges[edgeIndex] as any)[slot] = {};
            }
            // Always set the ID to ensure it's preserved
            (nextGraph.edges[edgeIndex] as any)[slot].id = paramId;
            console.log('[DataOperationsService] PRESERVE param id after update:', {
              slot,
              paramId,
              paramType,
              'edge.slot.id': (nextGraph.edges[edgeIndex] as any)[slot].id
            });
          } else {
            console.warn('[DataOperationsService] Could not determine parameter slot. paramType:', paramType);
          }
        }
        
        // Update metadata
        if (nextGraph.metadata) {
          nextGraph.metadata.updated_at = new Date().toISOString();
        }
        
        // AUTO-REBALANCE: If UpdateManager flagged this update as needing sibling rebalance
        // This applies to file pulls (same as external data), but NOT manual slider edits
        let finalGraph = nextGraph;
        if ((result.metadata as any)?.requiresSiblingRebalance) {
          // Use UpdateManager's rebalance method
          const { UpdateManager } = await import('./UpdateManager');
          const updateManagerInstance = new UpdateManager();
          const updatedEdgeId = (result.metadata as any).updatedEdgeId;
          const updatedField = (result.metadata as any).updatedField;
          
          // Rebalance based on field type
          if (updatedField === 'p.mean') {
            finalGraph = updateManagerInstance.rebalanceEdgeProbabilities(
              nextGraph,
              updatedEdgeId,
              false // Don't force rebalance - respect overrides
            );
          }
        }
        
        // Save to graph store
        // Note: We do NOT suppress store→file sync here because graph updates from
        // external sources (DAS, parameter files) are USER-INITIATED operations that
        // should persist to the graph file. The GraphEditor's syncingRef flag already
        // prevents infinite loops during the initial load.
        setGraph(finalGraph);
        markTime('afterSetGraph');
        
        const hadRebalance = finalGraph !== nextGraph;
        
        // Log timing breakdown (individual values to avoid Chrome truncation)
        const totalTime = performance.now() - timingStart;
        console.log(`[TIMING] getParameterFromFile ${paramId}: ${totalTime.toFixed(1)}ms | ` +
          `parse=${timings.parseWindow?.toFixed(1) || '?'}ms, ` +
          `file=${timings.getFile?.toFixed(1) || '?'}ms, ` +
          `edge=${timings.findEdge?.toFixed(1) || '?'}ms, ` +
          `sliceFilter=${timings.afterSliceFilter?.toFixed(1) || '?'}ms, ` +
          `sigValid=${timings.afterSignatureValidation?.toFixed(1) || '?'}ms, ` +
          `aggregate=${timings.afterAggregation?.toFixed(1) || '?'}ms, ` +
          `updateMgr=${timings.afterUpdateManager?.toFixed(1) || '?'}ms, ` +
          `setGraph=${timings.afterSetGraph?.toFixed(1) || '?'}ms`);
        
        if (hadRebalance) {
          batchableToastSuccess(`✓ Updated from ${paramId}.yaml + siblings rebalanced`, { duration: 2000 });
        } else {
          batchableToastSuccess(`✓ Updated from ${paramId}.yaml`, { duration: 2000 });
        }
        
        // Report appropriate status based on whether aggregation fell back
        if (aggregationFallbackError) {
          // Aggregation failed but update proceeded with raw data - report as warning
          const msg = hadRebalance 
            ? `Updated from ${paramId}.yaml (fallback to raw values) + siblings rebalanced`
            : `Updated from ${paramId}.yaml (fallback to raw values - aggregation failed)`;
          sessionLogService.endOperation(logOpId, 'warning', msg);
          return { success: true, warning: aggregationFallbackError };
        } else if (missingDataWarning) {
          // Aggregation succeeded but with missing data - report as success with warning child
          // (The child warning was already added in the aggregation block)
          const msg = hadRebalance 
            ? `Updated from ${paramId}.yaml + siblings rebalanced`
            : `Updated from ${paramId}.yaml`;
          sessionLogService.endOperation(logOpId, 'success', msg);
          return { success: true, warning: missingDataWarning };
        } else {
          // Normal success
          const msg = hadRebalance 
            ? `Updated from ${paramId}.yaml + siblings rebalanced`
            : `Updated from ${paramId}.yaml`;
          sessionLogService.endOperation(logOpId, 'success', msg);
          return { success: true };
        }
      }
      
      // Fallback return if none of the above paths were taken
      return { success: true };
      
    } catch (error) {
      console.error('[DataOperationsService] Failed to get parameter from file:', error);
      batchableToastError('Failed to get data from file');
      sessionLogService.endOperation(logOpId, 'error', `Failed: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false };
    }
  }
  
  /**
   * Put data from graph edge → parameter file
   * 
   * Reads edge data, uses UpdateManager to transform to file format,
   * appends new value to parameter file values[], marks file dirty.
   */
  async putParameterToFile(options: {
    paramId: string;
    edgeId?: string;
    graph: Graph | null;
    setGraph: (graph: Graph | null) => void;
    conditionalIndex?: number; // For conditional_p entries - which index to write from
  }): Promise<void> {
    const { paramId, edgeId, graph, conditionalIndex } = options;
    
    console.log('[DataOperationsService] putParameterToFile CALLED:', {
      paramId,
      edgeId,
      conditionalIndex,
      timestamp: new Date().toISOString()
    });
    
    try {
      // Validate inputs
      if (!graph) {
        toast.error('No graph loaded');
        return;
      }
      
      if (!edgeId) {
        toast.error('No edge selected');
        return;
      }
      
      // Find the source edge first (needed to determine parameter type if creating)
      const sourceEdge = graph.edges?.find((e: any) => e.uuid === edgeId || e.id === edgeId);
      if (!sourceEdge) {
        toast.error(`Edge not found in graph`);
        return;
      }
      
      // Check if file exists, create if missing
      let paramFile = fileRegistry.getFile(`parameter-${paramId}`);
      let isNewFile = false;
      if (!paramFile) {
        console.log(`[putParameterToFile] File not found, creating: ${paramId}`);
        isNewFile = true;
        
        // Determine parameter type from edge
        let paramType: 'probability' | 'cost_gbp' | 'labour_cost' = 'probability';
        if (sourceEdge.cost_gbp?.id === paramId) {
          paramType = 'cost_gbp';
        } else if (sourceEdge.labour_cost?.id === paramId) {
          paramType = 'labour_cost';
        }
        
        // Create file using fileOperationsService (handles registry update)
        const { fileOperationsService } = await import('./fileOperationsService');
        await fileOperationsService.createFile(paramId, 'parameter', {
          openInTab: false,
          metadata: { parameterType: paramType }
        });
        
        // Now get the created file
        paramFile = fileRegistry.getFile(`parameter-${paramId}`);
        if (!paramFile) {
          toast.error(`Failed to create parameter file: ${paramId}`);
          return;
        }
        
        toast.success(`Created new parameter file: ${paramId}`);
      }
      // Determine which parameter slot this file corresponds to
      // (an edge can have p, cost_gbp, labour_cost, AND conditional_p[] - we only want to write ONE)
      let filteredEdge: any = { ...sourceEdge };
      
      // ===== CONDITIONAL_P HANDLING =====
      // For conditional parameters, extract data from conditional_p[conditionalIndex].p
      if (conditionalIndex !== undefined) {
        const condEntry = sourceEdge.conditional_p?.[conditionalIndex];
        if (!condEntry?.p) {
          toast.error(`Conditional entry [${conditionalIndex}] not found on edge`);
          return;
        }
        
        // Verify this conditional entry is connected to the paramId
        if (condEntry.p.id !== paramId) {
          // Also check if paramId matches when creating new file
          console.log('[DataOperationsService] putParameterToFile conditional_p - ID mismatch or new file:', {
            condPId: condEntry.p.id,
            paramId,
            isNewFile
          });
        }
        
        // Create a filtered edge with just the conditional probability data
        // We present it as { p: ... } so UpdateManager handles it correctly
        filteredEdge = { p: condEntry.p };
        console.log('[DataOperationsService] putParameterToFile - using conditional_p data:', {
          conditionalIndex,
          condition: condEntry.condition,
          pData: condEntry.p
        });
      }
      // ===== END CONDITIONAL_P HANDLING =====
      else if (sourceEdge.p?.id === paramId) {
        // Writing probability parameter - keep only p field
        filteredEdge = { p: sourceEdge.p };
      } else if (sourceEdge.cost_gbp?.id === paramId) {
        // Writing cost_gbp parameter - keep only cost_gbp field
        filteredEdge = { cost_gbp: sourceEdge.cost_gbp };
      } else if (sourceEdge.labour_cost?.id === paramId) {
        // Writing labour_cost parameter - keep only labour_cost field
        filteredEdge = { labour_cost: sourceEdge.labour_cost };
      } else {
        toast.error(`Edge is not connected to parameter ${paramId}`);
        return;
      }
      
      // For NEW files: Use CREATE operation to initialize connection settings from edge
      // This copies connection, connection_string, and other metadata from the edge
      let createResult: any = null;
      if (isNewFile) {
        createResult = await updateManager.handleGraphToFile(
          filteredEdge,      // source (filtered to only relevant parameter)
          paramFile.data,    // target (parameter file)
          'CREATE',          // operation (initialize connection settings)
          'parameter',       // sub-destination
          { interactive: true, validateOnly: true }  // Don't apply in UpdateManager, we'll use applyChanges
        );
        
        if (!createResult.success) {
          console.warn('[DataOperationsService] CREATE operation failed for new parameter file:', createResult);
        }
      }
      
      // Call UpdateManager to transform data (validateOnly mode - don't apply yet)
      const result = await updateManager.handleGraphToFile(
        filteredEdge,      // source (filtered to only relevant parameter)
        paramFile.data,    // target (parameter file)
        'APPEND',          // operation (append to values[])
        'parameter',       // sub-destination
        { interactive: true, validateOnly: true }  // Don't apply in UpdateManager, we'll use applyChanges
      );
      
      if (!result.success || !result.changes) {
        toast.error('Failed to update file');
        return;
      }
      
      // Also update connection settings (UPDATE operation, not APPEND)
      // Connection settings go to top-level fields, not values[]
      const updateResult = await updateManager.handleGraphToFile(
        filteredEdge,      // source (filtered to only relevant parameter)
        paramFile.data,    // target (parameter file)
        'UPDATE',          // operation (update top-level fields)
        'parameter',       // sub-destination
        { interactive: true, validateOnly: true }  // Don't apply in UpdateManager, we'll use applyChanges
      );
      
      // Apply changes to file data
      const updatedFileData = structuredClone(paramFile.data);
      console.log('[DataOperationsService] putParameterToFile - changes to apply:', {
        paramId,
        isNewFile,
        createChanges: createResult?.changes ? JSON.stringify(createResult.changes, null, 2) : 'none',
        appendChanges: JSON.stringify(result.changes, null, 2),
        updateChanges: updateResult.changes ? JSON.stringify(updateResult.changes, null, 2) : 'none'
      });
      
      // For new files: Apply CREATE changes first (connection settings)
      if (isNewFile && createResult?.success && createResult?.changes) {
        applyChanges(updatedFileData, createResult.changes);
      }
      
      // Apply APPEND changes (values[])
      applyChanges(updatedFileData, result.changes);
      
      // Apply UPDATE changes (connection settings, etc.)
      if (updateResult.success && updateResult.changes) {
        applyChanges(updatedFileData, updateResult.changes);
      }
      console.log('[DataOperationsService] putParameterToFile - after applyChanges:', {
        'updatedFileData.values': JSON.stringify(updatedFileData.values, null, 2),
        'updatedFileData.connection': updatedFileData.connection,
        'updatedFileData.connection_string': updatedFileData.connection_string
      });
      
      console.log('[DataOperationsService] Before updateFile:', {
        fileId: `parameter-${paramId}`,
        wasDirty: paramFile.isDirty,
        isInitializing: paramFile.isInitializing
      });
      
      // Update file in registry and mark dirty
      await fileRegistry.updateFile(`parameter-${paramId}`, updatedFileData);
      
      // Check if it worked
      const updatedFile = fileRegistry.getFile(`parameter-${paramId}`);
      console.log('[DataOperationsService] After updateFile:', {
        fileId: `parameter-${paramId}`,
        isDirty: updatedFile?.isDirty,
        isInitializing: updatedFile?.isInitializing
      });
      
      toast.success(`✓ Updated ${paramId}.yaml`, { duration: 2000 });
      
    } catch (error) {
      console.error('[DataOperationsService] Failed to put parameter to file:', error);
      toast.error('Failed to put data to file');
    }
  }
  
  /**
   * Get data from case file → graph case node (with optional window aggregation)
   */
  async getCaseFromFile(options: {
    caseId: string;
    nodeId?: string;
    graph: Graph | null;
    setGraph: (graph: Graph | null) => void;
    setAutoUpdating?: (updating: boolean) => void;
    window?: DateRange; // Optional: if provided, use time-weighted aggregation for this window
  }): Promise<void> {
    const { caseId, nodeId, graph, setGraph, setAutoUpdating, window } = options;
    
    // Start session log
    const logOpId = sessionLogService.startOperation(
      'info',
      'data-fetch',
      'GET_FROM_FILE',
      `Get case from file: ${caseId}`,
      { fileId: `case-${caseId}`, fileType: 'case', targetId: nodeId }
    );
    
    // Set auto-updating flag to enable animations
    if (setAutoUpdating) {
      setAutoUpdating(true);
      setTimeout(() => setAutoUpdating(false), 500);
    }
    
    try {
      if (!graph || !nodeId) {
        toast.error('No graph or node selected');
        sessionLogService.endOperation(logOpId, 'error', 'No graph or node selected');
        return;
      }
      
      const caseFile = fileRegistry.getFile(`case-${caseId}`);
      if (!caseFile) {
        toast.error(`Case file not found: ${caseId}`);
        sessionLogService.endOperation(logOpId, 'error', `Case file not found: ${caseId}`);
        return;
      }
      
      const targetNode = graph.nodes?.find((n: any) => n.uuid === nodeId || n.id === nodeId);
      if (!targetNode) {
        toast.error(`Node not found in graph`);
        sessionLogService.endOperation(logOpId, 'error', 'Node not found in graph');
        return;
      }
      
      // If window is provided and case file has schedules, use windowed aggregation
      let variantsToApply: Array<{ name: string; weight: number; description?: string }> | undefined;
      
      if (window && caseFile.data.schedules && Array.isArray(caseFile.data.schedules)) {
        const { WindowAggregationService } = await import('./windowAggregationService');
        const aggregationService = new WindowAggregationService();
        
        // Use time-weighted aggregation (Phase 2)
        const aggregated = aggregationService.aggregateCaseSchedulesForWindow(
          caseFile.data.schedules,
          window
        );
        
        console.log('[DataOperationsService] Window-aggregated case weights:', {
          caseId,
          window,
          method: aggregated.method,
          schedules_included: aggregated.schedules_included,
          variants: aggregated.variants,
          coverage: aggregated.coverage
        });
        
        // Warn user if coverage is incomplete
        if (aggregated.coverage && !aggregated.coverage.is_complete) {
          console.warn(`[DataOperationsService] ${aggregated.coverage.message}`);
        }
        
        if (aggregated.variants.length > 0) {
          variantsToApply = aggregated.variants.map(v => ({
            name: v.name,
            weight: v.weight,
            description: '' // Descriptions come from graph, not schedules
          }));
        }
      }
      
      // If no windowed aggregation, use standard file-to-graph update
      if (!variantsToApply) {
        const result = await updateManager.handleFileToGraph(
          caseFile.data,
          targetNode,
          'UPDATE',
          'case',
          { interactive: true }
        );
        
        if (!result.success) {
          console.error('[DataOperationsService] getCaseFromFile failed:', result);
          const errorMsg = result.errors?.length ? result.errors.map(e => typeof e === 'string' ? e : e.message || JSON.stringify(e)).join(', ') : 'Unknown error';
          toast.error(`Failed to update from case file: ${errorMsg}`);
          return;
        }
        
        let nextGraph = structuredClone(graph);
        const nodeIndex = nextGraph.nodes.findIndex((n: any) => n.uuid === nodeId || n.id === nodeId);
        
        if (nodeIndex >= 0) {
          // Ensure case structure exists BEFORE applying changes
          if (caseId && !nextGraph.nodes[nodeIndex].case) {
            nextGraph.nodes[nodeIndex].case = { id: caseId, status: 'active', variants: [] };
          }
          
          // Apply changes if any (might be empty if already up to date)
          // This will populate/merge variants from the case file
          if (result.changes) {
            applyChanges(nextGraph.nodes[nodeIndex], result.changes);
          }
          
          // Ensure we do NOT lose the human-readable node id after file update
          if (nodeId && !nextGraph.nodes[nodeIndex].id) {
            nextGraph.nodes[nodeIndex].id = nodeId;
            console.log('[DataOperationsService] PRESERVE node.id after update:', {
              nodeId,
              'node.id': nextGraph.nodes[nodeIndex].id
            });
          }
          
          // Ensure case.id is set (in case applyChanges didn't set it)
          if (caseId && nextGraph.nodes[nodeIndex].case && !nextGraph.nodes[nodeIndex].case.id) {
            nextGraph.nodes[nodeIndex].case.id = caseId;
          }
          
          console.log('[DataOperationsService] After getCaseFromFile:', {
            caseId,
            'node.case.id': nextGraph.nodes[nodeIndex].case?.id,
            'variants.length': nextGraph.nodes[nodeIndex].case?.variants?.length,
            'variants': nextGraph.nodes[nodeIndex].case?.variants,
            'requiresVariantRebalance': (result.metadata as any)?.requiresVariantRebalance
          });
          
          // AUTO-REBALANCE: If UpdateManager flagged this update as needing variant rebalance
          let overriddenCount = 0;
          if ((result.metadata as any)?.requiresVariantRebalance) {
            const variantIndex = nextGraph.nodes[nodeIndex].case?.variants?.findIndex((v: any) => !v.weight_overridden) ?? 0;
            
            if (variantIndex >= 0) {
              const { updateManager } = await import('./UpdateManager');
              const rebalanceResult = updateManager.rebalanceVariantWeights(
                nextGraph,
                nextGraph.nodes[nodeIndex].uuid || nextGraph.nodes[nodeIndex].id,
                variantIndex,
                false // Don't force - respect override flags
              );
              
              nextGraph = rebalanceResult.graph;
              overriddenCount = rebalanceResult.overriddenCount;
              
              console.log('[DataOperationsService] Rebalanced case variants from file:', {
                nodeId: nextGraph.nodes[nodeIndex].uuid || nextGraph.nodes[nodeIndex].id,
                overriddenCount
              });
            }
          }
          
          if (nextGraph.metadata) {
            nextGraph.metadata.updated_at = new Date().toISOString();
          }
          setGraph(nextGraph);
          
          // Show overridden notification if any variants were skipped during rebalancing
          if (overriddenCount > 0) {
            toast(`⚠️ ${overriddenCount} variant${overriddenCount > 1 ? 's' : ''} overridden`, { 
              duration: 3000,
              icon: '⚠️'
            });
          }
          
          toast.success(`✓ Updated from ${caseId}.yaml`, { duration: 2000 });
          sessionLogService.endOperation(logOpId, 'success', `Updated from ${caseId}.yaml`);
        } else {
          sessionLogService.endOperation(logOpId, 'warning', `Node not found for case update`);
        }
      } else {
        // Apply windowed aggregation results
        const nextGraph = structuredClone(graph);
        const nodeIndex = nextGraph.nodes.findIndex((n: any) => n.uuid === nodeId || n.id === nodeId);
        
        if (nodeIndex >= 0) {
          // Ensure case structure exists
          if (!nextGraph.nodes[nodeIndex].case) {
            nextGraph.nodes[nodeIndex].case = { id: caseId, status: 'active', variants: [] };
          }
          
          // Update variant weights from aggregation
          // Preserve existing descriptions and override flags
          const existingVariants = nextGraph.nodes[nodeIndex].case.variants || [];
          nextGraph.nodes[nodeIndex].case.variants = variantsToApply.map(v => {
            const existing = existingVariants.find((ev: any) => ev.name === v.name);
            return {
              name: v.name,
              weight: v.weight,
              description: existing?.description || '',
              weight_overridden: true, // Mark as overridden since from file
              name_overridden: existing?.name_overridden,
              description_overridden: existing?.description_overridden
            };
          });
          
          console.log('[DataOperationsService] Applied windowed case weights:', {
            caseId,
            window,
            variants: nextGraph.nodes[nodeIndex].case.variants
          });
          
          if (nextGraph.metadata) {
            nextGraph.metadata.updated_at = new Date().toISOString();
          }
          setGraph(nextGraph);
          toast.success(`✓ Updated from ${caseId}.yaml (windowed)`, { duration: 2000 });
          sessionLogService.endOperation(logOpId, 'success', `Updated from ${caseId}.yaml (windowed)`);
        } else {
          sessionLogService.endOperation(logOpId, 'warning', `Node not found for windowed case update`);
        }
      }
    } catch (error) {
      console.error('[DataOperationsService] Failed to get case from file:', error);
      toast.error('Failed to get case from file');
      sessionLogService.endOperation(logOpId, 'error', `Failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  /**
   * Put data from graph case node → case file
   */
  async putCaseToFile(options: {
    caseId: string;
    nodeId?: string;
    graph: Graph | null;
    setGraph: (graph: Graph | null) => void;
  }): Promise<void> {
    const { caseId, nodeId, graph } = options;
    
    try {
      if (!graph || !nodeId) {
        toast.error('No graph or node selected');
        return;
      }
      
      // Find the source node first
      const sourceNode = graph.nodes?.find((n: any) => n.uuid === nodeId || n.id === nodeId);
      if (!sourceNode) {
        toast.error(`Node not found in graph`);
        return;
      }
      
      // Check if file exists, create if missing
      let caseFile = fileRegistry.getFile(`case-${caseId}`);
      if (!caseFile) {
        console.log(`[putCaseToFile] File not found, creating: ${caseId}`);
        
        // Create file using fileOperationsService (handles registry update)
        const { fileOperationsService } = await import('./fileOperationsService');
        await fileOperationsService.createFile(caseId, 'case', {
          openInTab: false,
          metadata: {}
        });
        
        // Now get the created file
        caseFile = fileRegistry.getFile(`case-${caseId}`);
        if (!caseFile) {
          toast.error(`Failed to create case file: ${caseId}`);
          return;
        }
        
        toast.success(`Created new case file: ${caseId}`);
      }
      
      // Filter node to only include the relevant case data
      const filteredNode: any = { case: sourceNode.case };
      
      console.log('[putCaseToFile] Source node case data:', {
        hasCase: !!sourceNode.case,
        hasConnection: !!sourceNode.case?.connection,
        connection: sourceNode.case?.connection,
        connectionString: sourceNode.case?.connection_string,
        filteredNode
      });
      
      // 1) APPEND schedule entry from current variants (keeps history)
      const appendResult = await updateManager.handleGraphToFile(
        filteredNode,
        caseFile.data,
        'APPEND', // APPEND to case.schedules[]
        'case',
        { interactive: true, validateOnly: true } // Don't apply in UpdateManager, we'll use applyChanges
      );
      
      console.log('[putCaseToFile] APPEND result:', {
        success: appendResult.success,
        changesCount: appendResult.changes?.length,
        changes: appendResult.changes
      });
      
      if (!appendResult.success || !appendResult.changes) {
        toast.error('Failed to update case file (schedule)');
        return;
      }
      
      const updatedFileData = structuredClone(caseFile.data);
      applyChanges(updatedFileData, appendResult.changes);
      
      // 2) UPDATE case metadata (connection, etc.) at top level
      const updateResult = await updateManager.handleGraphToFile(
        filteredNode,
        updatedFileData,
        'UPDATE', // UPDATE case.variants + connection fields
        'case',
        { interactive: true, validateOnly: true }
      );
      
      console.log('[putCaseToFile] UPDATE result:', {
        success: updateResult.success,
        changesCount: updateResult.changes?.length,
        errorsCount: updateResult.errors?.length,
        changes: updateResult.changes,
        errors: updateResult.errors,
        updatedFileDataBefore: structuredClone(updatedFileData)
      });
      
      // Apply changes even if there were some errors (as long as we have changes)
      if (updateResult.changes && updateResult.changes.length > 0) {
        applyChanges(updatedFileData, updateResult.changes);
        console.log('[putCaseToFile] After applying UPDATE changes:', {
          hasConnection: !!updatedFileData.case?.connection,
          connection: updatedFileData.case?.connection,
          connectionString: updatedFileData.case?.connection_string
        });
        
        if (!updateResult.success) {
          console.warn('[putCaseToFile] Applied changes despite errors:', updateResult.errors);
        }
      }
      
      await fileRegistry.updateFile(`case-${caseId}`, updatedFileData);
      toast.success(`✓ Updated ${caseId}.yaml`, { duration: 2000 });
    } catch (error) {
      console.error('[DataOperationsService] Failed to put case to file:', error);
      toast.error('Failed to put case to file');
    }
  }
  
  /**
   * Get data from node file → graph node
   */
  async getNodeFromFile(options: {
    nodeId: string;
    graph: Graph | null;
    setGraph: (graph: Graph | null) => void;
    targetNodeUuid?: string; // Optional: if provided, find node by UUID instead of nodeId
    setAutoUpdating?: (updating: boolean) => void;
  }): Promise<void> {
    const { nodeId, graph, setGraph, targetNodeUuid, setAutoUpdating } = options;
    
    // Start session log
    const logOpId = sessionLogService.startOperation(
      'info',
      'data-fetch',
      'GET_FROM_FILE',
      `Get node from file: ${nodeId}`,
      { fileId: `node-${nodeId}`, fileType: 'node', targetId: targetNodeUuid || nodeId }
    );
    
    // Set auto-updating flag to enable animations
    if (setAutoUpdating) {
      setAutoUpdating(true);
      setTimeout(() => setAutoUpdating(false), 500);
    }
    
    try {
      if (!graph) {
        toast.error('No graph loaded');
        sessionLogService.endOperation(logOpId, 'error', 'No graph loaded');
        return;
      }
      
      const nodeFile = fileRegistry.getFile(`node-${nodeId}`);
      if (!nodeFile) {
        toast.error(`Node file not found: ${nodeId}`);
        sessionLogService.endOperation(logOpId, 'error', `Node file not found: ${nodeId}`);
        return;
      }
      
      // Find node: if targetNodeUuid provided, use that; otherwise use nodeId
      const targetNode = targetNodeUuid
        ? graph.nodes?.find((n: any) => n.uuid === targetNodeUuid)
        : graph.nodes?.find((n: any) => n.uuid === nodeId || n.id === nodeId || n.data?.id === nodeId);
      
      if (!targetNode) {
        toast.error(`Node not found in graph`);
        sessionLogService.endOperation(logOpId, 'error', 'Node not found in graph');
        return;
      }
      
      const result = await updateManager.handleFileToGraph(
        nodeFile.data,
        targetNode,
        'UPDATE',
        'node',
        { interactive: true }
      );
      
      if (!result.success || !result.changes) {
        toast.error('Failed to update from node file');
        return;
      }
      
      const nextGraph = structuredClone(graph);
      const nodeIndex = targetNodeUuid
        ? nextGraph.nodes.findIndex((n: any) => n.uuid === targetNodeUuid)
        : nextGraph.nodes.findIndex((n: any) => n.uuid === nodeId || n.id === nodeId || n.data?.id === nodeId);
      
      if (nodeIndex >= 0) {
        applyChanges(nextGraph.nodes[nodeIndex], result.changes);
        // Ensure we do NOT lose the human-readable node id after file update
        if (nodeId && !nextGraph.nodes[nodeIndex].id) {
          nextGraph.nodes[nodeIndex].id = nodeId;
          console.log('[DataOperationsService] PRESERVE node.id after update:', {
            nodeId,
            'node.id': nextGraph.nodes[nodeIndex].id
          });
        }
        if (nextGraph.metadata) {
          nextGraph.metadata.updated_at = new Date().toISOString();
        }
        setGraph(nextGraph);
        toast.success(`✓ Updated from ${nodeId}.yaml`, { duration: 2000 });
        sessionLogService.endOperation(logOpId, 'success', `Updated from ${nodeId}.yaml`);
      } else {
        sessionLogService.endOperation(logOpId, 'warning', 'Node index not found after lookup');
      }
    } catch (error) {
      console.error('[DataOperationsService] Failed to get node from file:', error);
      toast.error('Failed to get node from file');
      sessionLogService.endOperation(logOpId, 'error', `Failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  /**
   * Put data from graph node → node file
   */
  async putNodeToFile(options: {
    nodeId: string;
    graph: Graph | null;
    setGraph: (graph: Graph | null) => void;
  }): Promise<void> {
    const { nodeId, graph } = options;
    
    try {
      if (!graph) {
        toast.error('No graph loaded');
        return;
      }
      
      const nodeFile = fileRegistry.getFile(`node-${nodeId}`);
      if (!nodeFile) {
        toast.error(`Node file not found: ${nodeId}`);
        return;
      }
      
      const sourceNode = graph.nodes?.find((n: any) => n.uuid === nodeId || n.id === nodeId || n.data?.id === nodeId);
      if (!sourceNode) {
        toast.error(`Node not found in graph`);
        return;
      }
      
      const result = await updateManager.handleGraphToFile(
        sourceNode,
        nodeFile.data,
        'UPDATE',
        'node',
        { interactive: true }
      );
      
      if (!result.success || !result.changes) {
        toast.error('Failed to update node file');
        return;
      }
      
      const updatedFileData = structuredClone(nodeFile.data);
      applyChanges(updatedFileData, result.changes);
      
      await fileRegistry.updateFile(`node-${nodeId}`, updatedFileData);
      
      toast.success(`✓ Updated ${nodeId}.yaml`, { duration: 2000 });
    } catch (error) {
      console.error('[DataOperationsService] Failed to put node to file:', error);
      toast.error('Failed to put node to file');
    }
  }
  
  /**
   * Get data from external source → file → graph (versioned)
   * 
   * Fetches data from external source, appends to file values[], then updates graph from file.
   * This is the "versioned" pathway: Source → File → Graph
   */
  async getFromSource(options: {
    objectType: 'parameter' | 'case' | 'node';
    objectId: string;
    targetId?: string;
    graph?: Graph | null;
    setGraph?: (graph: Graph | null) => void;
    paramSlot?: 'p' | 'cost_gbp' | 'labour_cost';
    conditionalIndex?: number;
    bustCache?: boolean; // If true, ignore existing dates and re-fetch everything
    targetSlice?: string; // Optional: DSL for specific slice (default '' = uncontexted)
    currentDSL?: string;  // Explicit DSL for window/context (e.g. from WindowSelector / scenario)
    boundedCohortWindow?: DateRange; // Optional: Pre-calculated bounded window from planner
  }): Promise<void> {
    const { objectType, objectId, targetId, graph, setGraph, paramSlot, conditionalIndex, bustCache, targetSlice = '', currentDSL, boundedCohortWindow } = options;
    sessionLogService.info('data-fetch', 'DATA_GET_FROM_SOURCE', `Get from Source (versioned): ${objectType} ${objectId}`,
      undefined, { fileId: `${objectType}-${objectId}`, fileType: objectType });
    
    // CRITICAL: Track current graph state to avoid stale closure across sequential operations
    // Without this, step 2 would use the original graph, not the one updated by step 1
    let currentGraph = graph;
    const trackingSetGraph = setGraph ? (newGraph: Graph | null) => {
      currentGraph = newGraph;
      setGraph(newGraph);
    } : undefined;
    
    try {
      if (objectType === 'parameter') {
        // Parameters: fetch daily data, append to values[], update graph
        // getFromSourceDirect with writeToFile=true handles the full flow:
        // - Fetches data from source OR skips if cached
        // - Writes time-series to parameter file
        // - Calls getParameterFromFile internally to update graph
        // No need to call getParameterFromFile again here - that would cause double updates!
        await this.getFromSourceDirect({
          objectType: 'parameter',
          objectId, // Parameter file ID
          targetId,
          graph: currentGraph,
          setGraph: trackingSetGraph,
          paramSlot,
          conditionalIndex,
          writeToFile: true, // Internal: write daily time-series into file when provider supports it
          bustCache,       // Pass through bust cache flag
          currentDSL,
          targetSlice,
          boundedCohortWindow,
        });
        
        // NOTE: getFromSourceDirect already calls getParameterFromFile internally
        // (both for cache hits and after writing new data), so no second call needed
        
        batchableToastSuccess('Fetched from source and updated graph from file');
        
      } else if (objectType === 'case') {
        // Cases: fetch gate config, append to schedules[], update graph nodes
        console.log(`[DataOperationsService] getFromSource for case: ${objectId}`);
        
        // 1. Fetch from source and write to case file
        // For cases, we manually extract variants_update and write to file
        // (Unlike params which have daily time_series, cases have discrete schedule snapshots)
        await this.getFromSourceDirect({
          objectType,
          objectId,
          targetId,
          graph: currentGraph,
          setGraph: trackingSetGraph,
          writeToFile: false, // Cases do not use daily time-series; this is a single snapshot
          versionedCase: true, // Signal to append schedule to case file instead of direct graph apply
          bustCache: false,
          currentDSL,
        });
        
        // 2. Update graph nodes from case file (with windowed aggregation)
        // Find all nodes with this case_id and update their variant weights from file
        // Use currentGraph which was updated by step 1's setGraph call
        if (currentGraph && trackingSetGraph && targetId) {
          // Find the first case node with this case_id to update from file
          const caseNode = currentGraph.nodes?.find((n: any) => 
            n.type === 'case' && n.case?.id === objectId
          );
          
          if (caseNode) {
            const nodeId = caseNode.uuid || caseNode.id;
            
            // Use getCaseFromFile for time-weighted aggregation; service will infer window from DSL
            await this.getCaseFromFile({
              caseId: objectId,
              nodeId,
              graph: currentGraph,
              setGraph: trackingSetGraph
            });
          } else {
            console.warn(`[DataOperationsService] No case node found with case_id="${objectId}"`);
          }
        } else if (currentGraph && trackingSetGraph && !targetId) {
          // No targetId provided - update all nodes with this case_id
          // This is the batch update path (less common)
          const caseFileId = `case-${objectId}`;
          const caseFile = fileRegistry.getFile(caseFileId);
          
          if (caseFile && caseFile.data) {
            const { WindowAggregationService } = await import('./windowAggregationService');
            const aggregationService = new WindowAggregationService();
            
            // Get windowed aggregation (or latest if no window) - using default service semantics
            const aggregated = aggregationService.getCaseWeightsForWindow(caseFile.data.schedules || []);
            
            const variants = aggregated.variants || [];
            
            if (variants.length > 0) {
              console.log(`[DataOperationsService] Aggregated case variants:`, {
                method: aggregated.method,
                schedules_included: aggregated.schedules_included,
                variants,
                coverage: aggregated.coverage
              });
              
              // Warn user if coverage is incomplete
              if (aggregated.coverage && !aggregated.coverage.is_complete) {
                console.warn(`[DataOperationsService] ${aggregated.coverage.message}`);
              }
              
              // Update all nodes with this case_id using UpdateManager
              let updatedGraph = structuredClone(currentGraph);
              let updated = false;
              let totalOverriddenCount = 0; // Track total overridden across all nodes and rebalancing
              
              for (const node of updatedGraph.nodes || []) {
                if (node.type === 'case' && node.case?.id === objectId) {
                  // Use UpdateManager to apply external data to case node
                  // This respects weight_overridden flags and sets rebalancing metadata
                  const updateResult = await updateManager.handleExternalToGraph(
                    { variants },  // External data from Statsig
                    node,          // Target case node
                    'UPDATE',
                    'case',
                    { interactive: false }
                  );
                  
                  console.log('[DataOperationsService] UpdateManager result for case:', {
                    success: updateResult.success,
                    changes: updateResult.changes,
                    conflicts: updateResult.conflicts,
                    metadata: updateResult.metadata
                  });
                  
                  // Track overridden fields from UpdateManager
                  if (updateResult.conflicts && updateResult.conflicts.length > 0) {
                    const overriddenCount = updateResult.conflicts.filter(c => c.reason === 'overridden').length;
                    totalOverriddenCount += overriddenCount;
                  }
                  
                  if (!updateResult.success) {
                    console.warn('[DataOperationsService] Failed to apply case updates');
                    continue;
                  }
                  
                  // Apply changes to node
                  if (updateResult.changes && updateResult.changes.length > 0) {
                    applyChanges(node, updateResult.changes);
                    
                    // AUTO-REBALANCE: If UpdateManager flagged this update as needing variant rebalance
                    // This is parallel to parameter rebalancing logic
                    const shouldRebalance = (updateResult.metadata as any)?.requiresVariantRebalance;
                    
                    console.log('[DataOperationsService] Rebalance check for case:', {
                      requiresVariantRebalance: shouldRebalance,
                      updatedField: (updateResult.metadata as any)?.updatedField
                    });
                    
                    if (shouldRebalance) {
                      // Find first non-overridden variant as origin for rebalancing
                      const variantIndex = node.case.variants?.findIndex((v: any) => !v.weight_overridden) ?? 0;
                      
                      const rebalanceResult = updateManager.rebalanceVariantWeights(
                        updatedGraph,
                        node.uuid || node.id,
                        variantIndex,
                        false // Don't force - respect override flags
                      );
                      
                      updatedGraph = rebalanceResult.graph;
                      totalOverriddenCount += rebalanceResult.overriddenCount;
                      
                      // Copy rebalanced variants back
                      const rebalancedNode = updatedGraph.nodes.find(
                        (n: any) => (n.uuid || n.id) === (node.uuid || node.id)
                      );
                      if (rebalancedNode && rebalancedNode.case?.variants) {
                        node.case.variants = rebalancedNode.case.variants;
                      }
                      
                      console.log('[DataOperationsService] Rebalanced case variants:', {
                        nodeId: node.uuid || node.id,
                        variants: node.case.variants
                      });
                    }
                    
                    updated = true;
                  }
                }
              }
              
              if (updated) {
                if (updatedGraph.metadata) {
                  updatedGraph.metadata.updated_at = new Date().toISOString();
                }
                trackingSetGraph(updatedGraph);
                
                // Show combined overridden count notification
                if (totalOverriddenCount > 0) {
                  toast(`⚠️ ${totalOverriddenCount} variant${totalOverriddenCount > 1 ? 's' : ''} overridden`, { 
                    duration: 3000,
                    icon: '⚠️'
                  });
                }
              }
            }
          }
        }
        
        batchableToastSuccess('Fetched from source and updated graph from file');
        
      } else {
        batchableToastError(`Versioned fetching not yet supported for ${objectType}`);
        return;
      }
      
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      batchableToastError(`Error fetching from source: ${message}`);
      console.error('getFromSource error:', error);
    }
  }
  
  /**
   * Get data from external source → graph (direct, not versioned)
   * 
   * If window is provided and writeToFile mode is enabled, fetches daily time-series data
   * and stores it in the parameter file (if objectType is 'parameter').
   */
  async getFromSourceDirect(options: {
    objectType: 'parameter' | 'case' | 'node';
    objectId: string;
    targetId?: string;
    graph?: Graph | null;
    setGraph?: (graph: Graph | null) => void;
    // For direct parameter references (no param file)
    paramSlot?: 'p' | 'cost_gbp' | 'labour_cost';
    conditionalIndex?: number;
    writeToFile?: boolean;    // Whether to persist time-series to parameter file (versioned path) vs direct to graph
    bustCache?: boolean;      // If true, ignore existing dates and re-fetch everything
    // For cases: distinguish direct vs versioned/schedule-based path
    versionedCase?: boolean;  // If true AND objectType==='case', append schedule to case file instead of direct graph update
    currentDSL?: string;      // Explicit DSL for window/context (e.g. from WindowSelector / scenario)
    targetSlice?: string;     // Optional: DSL for specific slice (default '' = uncontexted)
    boundedCohortWindow?: DateRange; // Optional: Pre-calculated bounded window
  }): Promise<void> {
      const {
        objectType,
        objectId,
        targetId,
        graph,
        setGraph,
        paramSlot,
        conditionalIndex,
        writeToFile,
        bustCache,
        versionedCase,
        currentDSL,
        targetSlice = '',
        boundedCohortWindow,
      } = options;
    
    // DEBUG: Log conditionalIndex at entry point
    console.log('[DataOps:getFromSourceDirect] Entry:', {
      objectType,
      objectId,
      targetId,
      paramSlot,
      conditionalIndex,
      hasConditionalIndex: conditionalIndex !== undefined,
    });
    
    // Read excludeTestAccounts setting (temporary hack - will be replaced with proper contexts)
    const settings = await db.getSettings();
    const excludeTestAccounts = settings?.data?.excludeTestAccounts ?? true;  // Default to true
    
    // Get human-readable identifiers for logging
    const targetEntity = targetId && graph 
      ? (objectType === 'parameter'
          ? graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId)
          : graph.nodes?.find((n: any) => n.uuid === targetId || n.id === targetId))
      : null;
    
    const entityLabel = objectType === 'parameter' && targetEntity
      ? formatEdgeForLog(targetEntity, graph || null)
      : targetEntity
        ? formatNodeForLog(targetEntity)
        : objectId || 'inline';
    
    // Start hierarchical logging for data operation
    const logOpId = sessionLogService.startOperation(
      'info',
      'data-fetch',
      writeToFile ? 'DATA_FETCH_VERSIONED' : 'DATA_FETCH_DIRECT',
      `Fetching ${objectType}: ${entityLabel}`,
      { 
        fileId: objectId ? `${objectType}-${objectId}` : undefined, 
        fileType: objectType,
        targetId
      }
    );
    
    try {
      let connectionName: string | undefined;
      let connectionString: any = {};
      
      // Try to get connection info from parameter/case/node file (if objectId provided)
      if (objectId) {
      const fileId = `${objectType}-${objectId}`;
      const file = fileRegistry.getFile(fileId);
      
        if (file) {
      const data = file.data;
          connectionName = data.connection;
          
          // Parse connection_string (it's a JSON string in the schema)
      if (data.connection_string) {
        try {
          connectionString = typeof data.connection_string === 'string' 
            ? JSON.parse(data.connection_string)
            : data.connection_string;
            } catch (e) {
              toast.error('Invalid connection_string JSON in parameter file');
              sessionLogService.endOperation(logOpId, 'error', 'Invalid connection_string JSON in parameter file');
              return;
            }
          }
        }
      }
      
      // If no connection from file, try to get it from the edge/node directly
      if (!connectionName && targetId && graph) {
        const target: any = objectType === 'parameter' 
          ? graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId)
          : graph.nodes?.find((n: any) => n.uuid === targetId || n.id === targetId);
        
        if (target) {
          // For parameters, resolve the specific parameter location
          if (objectType === 'parameter') {
            let param: any = null;
            let baseParam: any = null;  // For fallback connection
            
            // If paramSlot specified, use that (e.g., 'p', 'cost_gbp', 'labour_cost')
            if (paramSlot) {
              baseParam = target[paramSlot];
              param = baseParam;
              
              // If conditionalIndex specified, get from conditional_p array on edge
              // Conditional probabilities are at edge.conditional_p, NOT edge.p.conditional_ps
              if (conditionalIndex !== undefined && target?.conditional_p?.[conditionalIndex]) {
                const condEntry = target.conditional_p[conditionalIndex];
                param = condEntry.p;  // The p object within the conditional entry
                console.log(`[DataOps] Using conditional_p[${conditionalIndex}] for connection:`, param);
              }
            }
            // Otherwise, default to p (backward compatibility)
            else {
              baseParam = target.p;
              param = baseParam;
            }
            
            if (param) {
              // Use param.connection, or fall back to base param's connection for conditionals
              connectionName = param.connection || baseParam?.connection;
              const connString = param.connection_string || baseParam?.connection_string;
              if (connString) {
                try {
                  connectionString = typeof connString === 'string'
                    ? JSON.parse(connString)
                    : connString;
                } catch (e) {
                  toast.error('Invalid connection_string JSON on edge');
                  sessionLogService.endOperation(logOpId, 'error', 'Invalid connection_string JSON on edge');
                  return;
                }
              }
            }
          }
          // For cases, check node.case.connection
          else if (objectType === 'case') {
            if (target.case?.connection) {
              connectionName = target.case.connection;
              if (target.case.connection_string) {
                try {
                  connectionString = typeof target.case.connection_string === 'string'
                    ? JSON.parse(target.case.connection_string)
                    : target.case.connection_string;
                } catch (e) {
                  toast.error('Invalid connection_string JSON on case');
                  sessionLogService.endOperation(logOpId, 'error', 'Invalid connection_string JSON on case');
                  return;
                }
              }
            }
          }
          // For nodes/events, check top-level connection
          else if (target.connection) {
            connectionName = target.connection;
            if (target.connection_string) {
              try {
                connectionString = typeof target.connection_string === 'string'
                  ? JSON.parse(target.connection_string)
                  : target.connection_string;
              } catch (e) {
                toast.error('Invalid connection_string JSON');
                sessionLogService.endOperation(logOpId, 'error', 'Invalid connection_string JSON');
                return;
              }
            }
          }
        }
      }
      
      // 2. Check if we have a connection configured
      if (!connectionName) {
        sessionLogService.endOperation(logOpId, 'error', 'No connection configured');
        toast.error(`No connection configured. Please set the 'connection' field.`);
        return;
      }
      
      // Log connection info
      sessionLogService.addChild(logOpId, 'info', 'CONNECTION', 
        `Using connection: ${connectionName}`,
        connectionString ? `Config: ${JSON.stringify(connectionString).substring(0, 100)}...` : undefined,
        { sourceType: connectionName });
      
      // 3. Build DSL from edge query (if available in graph)
      let queryPayload: any = {};
      let eventDefinitions: Record<string, any> = {};  // Event file data for adapter
      let connectionProvider: string | undefined;
      let supportsDailyTimeSeries = false; // Capability from connections.yaml
      
      if (objectType === 'case') {
        // Cases don't need DSL building
        // Statsig adapter only needs caseId (passed via context below)
        console.log('[DataOperationsService] Skipping DSL build for case (caseId passed via context)');
        queryPayload = {};  // Empty DSL is fine
        
      } else if (targetId && graph) {
        // Parameters: build DSL from edge query (graph available)
        const targetEdge = graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId);
        
        // CRITICAL: For conditional_p fetches, use the conditional entry's query, not the base edge query
        // This ensures visited() clauses in conditional queries are included
        let effectiveQuery = targetEdge?.query;
        if (conditionalIndex !== undefined && targetEdge?.conditional_p?.[conditionalIndex]?.query) {
          effectiveQuery = targetEdge.conditional_p[conditionalIndex].query;
          console.log(`[DataOps] Using conditional_p[${conditionalIndex}] query:`, effectiveQuery);
        }
        
        if (targetEdge && effectiveQuery) {
          // ===== DIAGNOSTIC LOGGING FOR COMPOSITE QUERIES =====
          console.log('[DataOps:COMPOSITE] Effective query string:', effectiveQuery);
          console.log('[DataOps:COMPOSITE] Contains minus():', effectiveQuery.includes('.minus('));
          console.log('[DataOps:COMPOSITE] Contains plus():', effectiveQuery.includes('.plus('));
          console.log('[DataOps:COMPOSITE] Contains visited():', effectiveQuery.includes('.visited('));
          // ===================================================
          
          // Parse query string (format: "from(nodeA).to(nodeB)")
          // For now, pass the edge with query string to buildDslFromEdge
          // which will parse node references and resolve event names
          
          // Load buildDslFromEdge and event loader
          const { buildDslFromEdge } = await import('../lib/das/buildDslFromEdge');
          const { paramRegistryService } = await import('./paramRegistryService');
          
          // Get connection to extract provider and check if it requires event_ids
          const { createDASRunner } = await import('../lib/das');
          const tempRunner = createDASRunner();
          try {
            const connection = await (tempRunner as any).connectionProvider.getConnection(connectionName);
            connectionProvider = connection.provider;
            
            // Check if connection supports daily time series (from capabilities in connections.yaml)
            supportsDailyTimeSeries = connection.capabilities?.supports_daily_time_series === true;
            console.log('[DataOps] Connection capabilities:', {
              connectionName,
              supportsDailyTimeSeries,
              capabilities: connection.capabilities
            });
            
            // Skip DSL building for connections that don't require event_ids
            // This is specified in the connection definition (requires_event_ids: false)
            const requiresEventIds = connection.requires_event_ids !== false; // Default to true if not specified
            if (!requiresEventIds) {
              console.log(`[DataOperationsService] Skipping DSL build for ${connectionName} (requires_event_ids=false)`);
              queryPayload = {};  // Empty DSL is fine for connections that don't need event_ids
            } else {
              // Event loader that reads from IDB
              const eventLoader = async (eventId: string) => {
                const fileId = `event-${eventId}`;
                const file = fileRegistry.getFile(fileId);
                
                if (file && file.data) {
                  console.log(`Loaded event "${eventId}" from IDB:`, file.data);
                  return file.data;
                }
                
                // Fallback: return minimal event without mapping
                console.warn(`Event "${eventId}" not found in IDB, using fallback`);
                return {
                  id: eventId,
                  name: eventId,
                  provider_event_names: {}
                };
              };
              
              // Parse and merge constraints from graph-level and edge-specific queries
              // CRITICAL: currentDSL MUST be provided from graphStore.currentDSL (authoritative)
              // NEVER fall back to graph.currentQueryDSL - it's only for historic record!
              let constraints;
              try {
                const { parseConstraints } = await import('../lib/queryDSL');
                
                // currentDSL is AUTHORITATIVE - from graphStore.currentDSL
                const effectiveDSL = currentDSL || '';
                
                // Parse graph-level constraints (from WindowSelector or scenario)
                const graphConstraints = effectiveDSL ? parseConstraints(effectiveDSL) : null;
                
                // Parse edge-specific constraints (use effectiveQuery which may be from conditional_p)
                const edgeConstraints = effectiveQuery ? parseConstraints(effectiveQuery) : null;
                
                // Merge: edge-specific overrides graph-level
                constraints = {
                  context: [...(graphConstraints?.context || []), ...(edgeConstraints?.context || [])],
                  contextAny: [...(graphConstraints?.contextAny || []), ...(edgeConstraints?.contextAny || [])],
                  window: edgeConstraints?.window || graphConstraints?.window || null,
                  cohort: edgeConstraints?.cohort || graphConstraints?.cohort || null,  // A-anchored cohort for latency edges
                  visited: edgeConstraints?.visited || [],
                  visitedAny: edgeConstraints?.visitedAny || []
                };
                
                console.log('[DataOps] Merged constraints:', {
                  currentDSL,
                  effectiveDSL,
                  edgeQuery: effectiveQuery,
                  graphConstraints,
                  edgeConstraints,
                  merged: constraints
                });
              } catch (error) {
                console.warn('[DataOps] Failed to parse constraints:', error);
              }
              
              // Clear context registry cache to ensure fresh data from filesystem
              const { contextRegistry } = await import('./contextRegistry');
              contextRegistry.clearCache();
              
              // Build DSL with event mapping for analytics-style connections (e.g., Amplitude)
              // Create edge-like object with effective query (may be from conditional_p)
              const edgeForDsl = {
                ...targetEdge,
                query: effectiveQuery  // Use effective query (base or conditional_p)
              };
              
              const buildResult = await buildDslFromEdge(
                edgeForDsl,
                graph,
                connectionProvider,
                eventLoader,
                constraints  // Pass constraints for context filters
              );
              queryPayload = buildResult.queryPayload;
              eventDefinitions = buildResult.eventDefinitions;
              console.log('Built DSL from edge with event mapping:', queryPayload);
              console.log('[DataOps] Event definitions loaded:', Object.keys(eventDefinitions));
              console.log('[DataOps] Query used for DSL:', effectiveQuery);
              console.log('[DataOps] Context filters:', queryPayload.context_filters);
              console.log('[DataOps] Window dates:', queryPayload.start, queryPayload.end);
              console.log('[DataOps] Cohort info:', queryPayload.cohort);
              console.log('[DataOps] Edge anchor_node_id:', edgeForDsl.p?.latency?.anchor_node_id);
              
              // Log query details for user
              const queryDesc = effectiveQuery || 'no query';
              // Check cohort dates first (for latency-enabled edges), then window dates
              const windowDesc = (queryPayload.cohort?.start && queryPayload.cohort?.end)
                ? `Cohort: ${normalizeDate(queryPayload.cohort.start)} to ${normalizeDate(queryPayload.cohort.end)}${queryPayload.cohort.anchor_event_id ? ` (anchor: ${queryPayload.cohort.anchor_event_id})` : ''}`
                : (queryPayload.start && queryPayload.end) 
                  ? `Window: ${normalizeDate(queryPayload.start)} to ${normalizeDate(queryPayload.end)}`
                  : 'default window';
              sessionLogService.addChild(logOpId, 'info', 'QUERY_BUILT',
                `Query: ${queryDesc}`,
                `Window: ${windowDesc}${queryPayload.context_filters?.length ? `, Filters: ${queryPayload.context_filters.length}` : ''}`,
                { 
                  edgeQuery: queryDesc,
                  resolvedWindow: windowDesc,
                  events: queryPayload.events?.map((e: any) => e.event_id || e),
                  contextFilters: queryPayload.context_filters,
                  isConditional: conditionalIndex !== undefined,
                  conditionalIndex
                });
            }
          } catch (e) {
            console.warn('Could not load connection for provider mapping:', e);
            // If we can't determine provider, try building DSL anyway (will fail gracefully if event_ids missing)
            try {
              const eventLoader = async (eventId: string) => {
                const fileId = `event-${eventId}`;
                const file = fileRegistry.getFile(fileId);
                if (file && file.data) {
                  return file.data;
                }
                return {
                  id: eventId,
                  name: eventId,
                  provider_event_names: {}
                };
              };
              
              // Parse and merge constraints from graph-level and edge-specific queries (fallback path)
              // CRITICAL: currentDSL MUST be provided from graphStore.currentDSL (authoritative)
              // NEVER fall back to graph.currentQueryDSL - it's only for historic record!
              let constraints;
              try {
                const { parseConstraints } = await import('../lib/queryDSL');
                
                // currentDSL is AUTHORITATIVE - from graphStore.currentDSL
                const effectiveDSL = currentDSL || '';
                const graphConstraints = effectiveDSL ? parseConstraints(effectiveDSL) : null;
                
                // Parse edge-specific constraints
                const edgeConstraints = targetEdge.query ? parseConstraints(targetEdge.query) : null;
                
                // Merge: edge-specific overrides graph-level
                constraints = {
                  context: [...(graphConstraints?.context || []), ...(edgeConstraints?.context || [])],
                  contextAny: [...(graphConstraints?.contextAny || []), ...(edgeConstraints?.contextAny || [])],
                  window: edgeConstraints?.window || graphConstraints?.window || null,
                  cohort: edgeConstraints?.cohort || graphConstraints?.cohort || null,  // A-anchored cohort for latency edges
                  visited: edgeConstraints?.visited || [],
                  visitedAny: edgeConstraints?.visitedAny || []
                };
                
                console.log('[DataOps] Merged constraints (fallback):', {
                  currentDSL,
                  effectiveDSL,
                  edgeQuery: targetEdge.query,
                  merged: constraints
                });
              } catch (error) {
                console.warn('[DataOps] Failed to parse constraints (fallback):', error);
              }
              
              const fallbackResult = await buildDslFromEdge(
                targetEdge,
                graph,
                connectionProvider,
                eventLoader,
                constraints  // Pass constraints for context filters
              );
              queryPayload = fallbackResult.queryPayload;
              eventDefinitions = fallbackResult.eventDefinitions;
            } catch (error) {
              console.error('Error building DSL from edge:', error);
              toast.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
              sessionLogService.endOperation(logOpId, 'error', `Failed to build query: ${error instanceof Error ? error.message : String(error)}`);
              return;
            }
          }
        }
      } else if (objectType === 'parameter' && objectId && !graph) {
        // FALLBACK: No graph available, try to read query from parameter file
        // This enables standalone parameter file usage without the graph
        // NOTE: This path has limitations - it requires the query string to reference
        // node IDs that match event IDs (or event files to exist for lookup)
        const paramFile = fileRegistry.getFile(`parameter-${objectId}`);
        const fileQuery = paramFile?.data?.query;
        
        if (fileQuery && typeof fileQuery === 'string' && fileQuery.trim()) {
          console.log('[DataOps] No graph available, using query from parameter file:', fileQuery);
          sessionLogService.addChild(logOpId, 'info', 'QUERY_FROM_FILE',
            'Using query from parameter file (no graph available)',
            `Query: ${fileQuery}`,
            { fileId: `parameter-${objectId}`, query: fileQuery });
          
          try {
            const { parseDSL } = await import('../lib/queryDSL');
            const parsedQuery = parseDSL(fileQuery);
            
            // Build a minimal query payload from the parsed query
            // This assumes node IDs in query can be resolved via eventLoader
            if (parsedQuery.from && parsedQuery.to) {
              const eventLoader = async (eventId: string) => {
                const file = fileRegistry.getFile(`event-${eventId}`);
                if (file?.data) {
                  return file.data;
                }
                // Fallback: use ID as event name
                return { id: eventId, name: eventId, provider_event_names: {} };
              };
              
              // Load event data for from/to nodes
              const fromEvent = await eventLoader(parsedQuery.from);
              const toEvent = await eventLoader(parsedQuery.to);
              
              // Build query payload without full graph
              queryPayload = {
                from: fromEvent?.provider_event_names?.[connectionProvider || 'amplitude'] || parsedQuery.from,
                to: toEvent?.provider_event_names?.[connectionProvider || 'amplitude'] || parsedQuery.to,
              };
              
              // Add visited events if any
              if (parsedQuery.visited?.length) {
                const visitedEvents = await Promise.all(
                  parsedQuery.visited.map(async (v: string) => {
                    const ev = await eventLoader(v);
                    return ev?.provider_event_names?.[connectionProvider || 'amplitude'] || v;
                  })
                );
                queryPayload.visited = visitedEvents;
              }
              
              console.log('[DataOps] Built query payload from file query:', queryPayload);
            }
          } catch (error) {
            console.warn('[DataOps] Failed to build query from parameter file:', error);
            sessionLogService.addChild(logOpId, 'warning', 'QUERY_PARSE_FAILED',
              `Could not parse query from file: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else {
          console.warn('[DataOps] No graph and no query in parameter file - cannot determine fetch query');
          sessionLogService.addChild(logOpId, 'warning', 'NO_QUERY_SOURCE',
            'No graph available and parameter file has no query - fetch may fail');
        }
      }
      
      // ═══════════════════════════════════════════════════════════════════════════════
      // DEPRECATED: 4-Dec-25 - DUAL QUERY LOGIC FOR VISITED_UPSTREAM
      // 
      // This section implements dual queries (base for n, conditioned for k) when
      // visited_upstream is present. This was required because we used a "super-funnel"
      // approach where upstream visited nodes were prepended to the funnel.
      // 
      // REPLACEMENT: Native segment filters in Amplitude adapter (connections.yaml)
      // The adapter now converts visited_upstream to segment filters with `op: ">="`,
      // `value: 1`, which correctly filters users who performed the event.
      // 
      // This code will NOT execute for Amplitude because the adapter clears
      // visited_upstream after converting to segment filters. The needsDualQuery
      // flag will be false.
      // 
      // DO NOT DELETE until native segment filters are confirmed working in production.
      // Target deletion: After 2 weeks of production validation.
      // ═══════════════════════════════════════════════════════════════════════════════
      
      // 4b. Detect upstream conditions OR explicit n_query, and prepare base query for n
      // When a query has visited_upstream (or exclude with upstream nodes), OR when user has
      // explicitly provided an n_query (for complex topologies), we need TWO queries:
      // - Conditioned query (super-funnel or main query) → gives k
      // - Base query (explicit n_query or strip upstream conditions) → gives n
      // This is because n should be ALL users at the 'from' node, not just those who came via a specific path
      let baseQueryPayload: any = null;
      let needsDualQuery = false;
      let explicitNQuery: string | undefined = undefined;
      
      // Check for explicit n_query on edge (used when 'from' node shares an event with siblings
      // and n can't be derived by simply stripping upstream conditions)
      // n_query is mastered on edge but also copied to param file for standalone use
      const nQueryEdge = targetId && graph ? graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId) : undefined;
      let nQueryString: string | undefined = undefined;  // Keep the original n_query string for excludes/composite processing
      let nQueryIsComposite = false;  // Track if n_query needs composite execution
      
      // First try edge (master), then fall back to param file (for standalone use without graph)
      let nQuerySource: string | undefined = nQueryEdge?.n_query;
      if (!nQuerySource && objectType === 'parameter') {
        // Try to get n_query from parameter file if edge doesn't have it
        const paramFile = fileRegistry.getFile(`parameter-${objectId}`);
        if (paramFile?.data?.n_query && typeof paramFile.data.n_query === 'string') {
          nQuerySource = paramFile.data.n_query;
          console.log('[DataOps:DUAL_QUERY] Using n_query from parameter file (edge not available):', nQuerySource);
        }
      }
      
      if (nQuerySource && typeof nQuerySource === 'string' && nQuerySource.trim()) {
        explicitNQuery = nQuerySource.trim();
        nQueryString = explicitNQuery;
        needsDualQuery = true;
        console.log('[DataOps:DUAL_QUERY] Detected explicit n_query on edge:', explicitNQuery);
        
        // Check if n_query has excludes() that need compilation (same as main query)
        const nQueryHasExcludes = /\.excludes?\(/.test(nQueryString);
        const nQueryIsAlreadyComposite = /\.(minus|plus)\(/.test(nQueryString);
        
        if (nQueryHasExcludes && !nQueryIsAlreadyComposite && connectionName?.includes('amplitude')) {
          console.log('[DataOps:DUAL_QUERY:EXCLUDE] n_query has excludes, compiling to minus/plus for Amplitude');
          sessionLogService.addChild(logOpId, 'info', 'N_QUERY_EXCLUDE_COMPILE_START',
            'Compiling n_query exclude() to minus/plus for Amplitude',
            `Original n_query: ${nQueryString}`
          );
          try {
            const nQueryCompileResult = await compileExcludeQuery(nQueryString, graph);
            if (nQueryCompileResult.wasCompiled && nQueryCompileResult.compiled !== nQueryString) {
              console.log('[DataOps:DUAL_QUERY:EXCLUDE] Compiled n_query:', nQueryCompileResult.compiled);
              sessionLogService.addChild(logOpId, 'success', 'N_QUERY_EXCLUDE_COMPILE_SUCCESS',
                'n_query exclude compiled to minus/plus form',
                `Compiled: ${nQueryCompileResult.compiled}`
              );
              nQueryString = nQueryCompileResult.compiled;
              nQueryIsComposite = true;
            } else if (nQueryCompileResult.error) {
              console.error('[DataOps:DUAL_QUERY:EXCLUDE] n_query exclude compilation failed:', nQueryCompileResult.error);
              sessionLogService.addChild(logOpId, 'error', 'N_QUERY_EXCLUDE_COMPILE_FAILED',
                `n_query exclude compilation failed: ${nQueryCompileResult.error}`,
                'n_query excludes will be ignored - data may be incorrect!'
              );
              toast.error(`n_query exclude compilation failed: ${nQueryCompileResult.error}`);
            }
          } catch (error) {
            console.error('[DataOps:DUAL_QUERY:EXCLUDE] Failed to compile n_query excludes:', error);
            sessionLogService.addChild(logOpId, 'error', 'N_QUERY_EXCLUDE_COMPILE_ERROR',
              `Exception during n_query exclude compilation: ${error instanceof Error ? error.message : String(error)}`
            );
            toast.error('Failed to compile n_query excludes - excludes will be ignored');
          }
        } else if (nQueryIsAlreadyComposite) {
          nQueryIsComposite = true;
        }
      }
      
      if (explicitNQuery) {
        // User provided explicit n_query - build DSL from it
        // This is used when the 'from' node shares an event with other nodes (siblings)
        // and we need a specific query to get the correct n value
        try {
          console.log('[DataOps:DUAL_QUERY] Building DSL from explicit n_query');
          
          // Determine connection provider for event name mapping
          const nQueryConnectionProvider = connectionName?.includes('amplitude') 
            ? 'amplitude' 
            : connectionName?.includes('sheets') 
              ? 'sheets' 
              : connectionName?.includes('statsig') 
                ? 'statsig' 
                : undefined;
          
          // Load events for n_query
          const nQueryEventLoader = async (eventId: string) => {
            const fileId = `event-${eventId}`;
            const file = fileRegistry.getFile(fileId);
            if (file && file.data) {
              return file.data;
            }
            return { id: eventId, name: eventId, provider_event_names: {} };
          };
          
          // Parse constraints for n_query (same as main query)
          // CRITICAL: currentDSL MUST be provided from graphStore.currentDSL (authoritative)
          // NEVER fall back to graph.currentQueryDSL - it's only for historic record!
          let nQueryConstraints;
          try {
            const { parseConstraints } = await import('../lib/queryDSL');
            // currentDSL is AUTHORITATIVE - from graphStore.currentDSL
            const effectiveDSL = currentDSL || '';
            const graphConstraints = effectiveDSL ? parseConstraints(effectiveDSL) : null;
            const nQueryEdgeConstraints = parseConstraints(explicitNQuery);
            
            nQueryConstraints = {
              context: [...(graphConstraints?.context || []), ...(nQueryEdgeConstraints?.context || [])],
              contextAny: [...(graphConstraints?.contextAny || []), ...(nQueryEdgeConstraints?.contextAny || [])],
              window: nQueryEdgeConstraints?.window || graphConstraints?.window || null,
              cohort: nQueryEdgeConstraints?.cohort || graphConstraints?.cohort || null,  // A-anchored cohort for latency edges
              visited: nQueryEdgeConstraints?.visited || [],
              visitedAny: nQueryEdgeConstraints?.visitedAny || []
            };
          } catch (error) {
            console.warn('[DataOps:DUAL_QUERY] Failed to parse n_query constraints:', error);
          }
          
          let nQueryResult: any;
          
          if (graph) {
            // Full path with graph available - use buildDslFromEdge
            const { buildDslFromEdge: buildDslFromEdgeForNQuery } = await import('../lib/das/buildDslFromEdge');
            
            // Build an edge-like object with the n_query as its query
            // Use the potentially-compiled nQueryString (with minus/plus if excludes were compiled)
            const nQueryEdgeData = {
              ...nQueryEdge,
              query: nQueryString || explicitNQuery,  // Use compiled version if available
            };
            
            nQueryResult = await buildDslFromEdgeForNQuery(
              nQueryEdgeData,
              graph,
              nQueryConnectionProvider,
              nQueryEventLoader,
              nQueryConstraints
            );
          } else {
            // Fallback: No graph available, build simplified payload from n_query string
            console.log('[DataOps:DUAL_QUERY] No graph available, building n_query payload from string');
            const { parseDSL } = await import('../lib/queryDSL');
            const parsedNQuery = parseDSL(nQueryString || explicitNQuery);
            
            if (parsedNQuery.from && parsedNQuery.to) {
              const fromEvent = await nQueryEventLoader(parsedNQuery.from);
              const toEvent = await nQueryEventLoader(parsedNQuery.to);
              
              const nQueryPayload: any = {
                from: fromEvent?.provider_event_names?.[nQueryConnectionProvider || 'amplitude'] || parsedNQuery.from,
                to: toEvent?.provider_event_names?.[nQueryConnectionProvider || 'amplitude'] || parsedNQuery.to,
              };
              
              if (parsedNQuery.visited?.length) {
                const visitedEvents = await Promise.all(
                  parsedNQuery.visited.map(async (v: string) => {
                    const ev = await nQueryEventLoader(v);
                    return ev?.provider_event_names?.[nQueryConnectionProvider || 'amplitude'] || v;
                  })
                );
                nQueryPayload.visited = visitedEvents;
              }
              
              nQueryResult = { queryPayload: nQueryPayload, eventDefinitions: {} };
            } else {
              throw new Error('n_query must have from() and to()');
            }
          }
          
          baseQueryPayload = nQueryResult.queryPayload;
          
          // CRITICAL: Merge n_query's event definitions into main eventDefinitions
          // Without this, the adapter won't have provider_event_names for n_query nodes
          if (nQueryResult.eventDefinitions) {
            Object.assign(eventDefinitions, nQueryResult.eventDefinitions);
            console.log('[DataOps:DUAL_QUERY] Merged n_query event definitions:', Object.keys(nQueryResult.eventDefinitions));
          }
          
          console.log('[DataOps:DUAL_QUERY] Built n_query payload:', {
            from: baseQueryPayload.from,
            to: baseQueryPayload.to,
            visited: baseQueryPayload.visited,
            visited_upstream: baseQueryPayload.visited_upstream,
            isComposite: nQueryIsComposite,
          });
        } catch (error) {
          console.error('[DataOps:DUAL_QUERY] Failed to build DSL from explicit n_query:', error);
          // Fall back to auto-strip if n_query parsing fails
          explicitNQuery = undefined;
          nQueryIsComposite = false;
          needsDualQuery = queryPayload.visited_upstream?.length > 0;
        }
      }
      
      // If no explicit n_query but we have visited_upstream, auto-derive by stripping
      // CRITICAL FIX (4-Dec-25): Check if connection supports native segment filters
      // If it does, the adapter will handle visited_upstream natively - no dual query needed
      let connectionSupportsNativeVisited = false;
      try {
        const { createDASRunner } = await import('../lib/das');
        const tempRunner = createDASRunner();
        const conn = await (tempRunner as any).connectionProvider.getConnection(connectionName);
        // supports_native_exclude also means supports native visited() via segment filters
        connectionSupportsNativeVisited = conn?.capabilities?.supports_native_exclude === true;
        console.log('[DataOps:DUAL_QUERY] Connection capabilities check:', {
          connectionName,
          supportsNativeVisited: connectionSupportsNativeVisited,
          hasVisitedUpstream: queryPayload.visited_upstream?.length > 0
        });
      } catch (e) {
        console.warn('[DataOps:DUAL_QUERY] Failed to check connection capabilities:', e);
      }
      
      if (!explicitNQuery && queryPayload.visited_upstream && Array.isArray(queryPayload.visited_upstream) && queryPayload.visited_upstream.length > 0) {
        // If connection supports native segment filters, skip dual query - adapter handles it
        if (connectionSupportsNativeVisited) {
          console.log('[DataOps:DUAL_QUERY] Connection supports native segment filters - skipping dual query');
          console.log('[DataOps:DUAL_QUERY] visited_upstream will be handled by adapter:', queryPayload.visited_upstream);
          needsDualQuery = false;
          // Don't create baseQueryPayload - not needed for native segment filters
        } else {
          // DEPRECATED: Dual query path for providers without native segment filters
          needsDualQuery = true;
          console.log('[DataOps:DUAL_QUERY] Detected visited_upstream, will run dual queries for n and k');
          console.log('[DataOps:DUAL_QUERY] Conditioned query has visited_upstream:', queryPayload.visited_upstream);
          
          // Create base query: same from/to, but strip visited_upstream
          // This will give us a simple 2-step funnel where:
          // - n = cumulativeRaw[0] = all users at 'from'
          // - k = cumulativeRaw[1] = all users at 'from' who went to 'to'
          // We only use n from this query
          baseQueryPayload = {
            ...queryPayload,
            visited_upstream: undefined,  // Strip upstream conditions
            visitedAny_upstream: undefined,  // Also strip any visitedAny upstream
            // Note: Keep 'visited' (between from and to) if present - that's part of the path
          };
          
          console.log('[DataOps:DUAL_QUERY] Base query (for n, auto-stripped):', {
            from: baseQueryPayload.from,
            to: baseQueryPayload.to,
            visited: baseQueryPayload.visited,
            visited_upstream: baseQueryPayload.visited_upstream,  // should be undefined
          });
        }
      }
      
      // 5. Check for incremental fetch opportunities (if writeToFile and parameter file exists)
      // Determine default window first - aligned to date boundaries
      // Normalize 'now' to current local date at UTC midnight to prevent timezone drift
      const nowDate = parseUKDate(formatDateUK(new Date()));
      const sevenDaysAgoDate = new Date(nowDate);
      sevenDaysAgoDate.setUTCDate(nowDate.getUTCDate() - 7);
      
      // Extract cohort from queryPayload FIRST (needed to determine if we're in cohort mode)
      // Cohort mode uses A-anchored entry dates rather than X-anchored event dates
      interface CohortOptions {
        start?: string;
        end?: string;
        anchor_event_id?: string;
        maturity_days?: number;
        [key: string]: unknown;
      }
      let requestedCohort: CohortOptions | undefined;
      if (queryPayload.cohort && typeof queryPayload.cohort === 'object') {
        const cohort = queryPayload.cohort as CohortOptions;
        if (cohort.start || cohort.end) {
          requestedCohort = {
            start: cohort.start,
            end: cohort.end,
            anchor_event_id: cohort.anchor_event_id,
            maturity_days: cohort.maturity_days
          };
          console.log('[DataOps] Using cohort from DSL object:', requestedCohort);
        }
      }
      
      // CRITICAL: Use window dates from DSL object if available (already ISO format from buildDslFromEdge)
      // This is the authoritative source - buildDslFromEdge has already parsed and normalized the window
      // BUG FIX: For cohort mode, use cohort dates - NOT the default 7-day window!
      let requestedWindow: DateRange;
      if (queryPayload.start && queryPayload.end) {
        // DSL object has window dates (already ISO format from buildDslFromEdge)
        requestedWindow = {
          start: queryPayload.start,
          end: queryPayload.end
        };
        console.log('[DataOps] Using window from DSL object:', requestedWindow);
      } else if (requestedCohort?.start && requestedCohort?.end) {
        // COHORT MODE: Use cohort entry dates as the fetch window
        // The cohort dates specify which cohort entry dates to fetch, and these ARE the dates
        // we need to send to the API for cohort-based queries
        requestedWindow = {
          start: requestedCohort.start,
          end: requestedCohort.end
        };
        console.log('[DataOps] Using cohort dates as window (cohort mode):', requestedWindow);
      } else {
        // No window in DSL, use default last 7 days (aligned to date boundaries)
        requestedWindow = {
          start: sevenDaysAgoDate.toISOString(),
          end: nowDate.toISOString()
        };
        console.log('[DataOps] No window in DSL, using default last 7 days:', requestedWindow);
      }
      
      let actualFetchWindows: DateRange[] = [requestedWindow];
      let querySignature: string | undefined;
      let shouldSkipFetch = false;
      
      // CRITICAL: ALWAYS compute query signature when writing to parameter files
      // (we only write for parameter objects in versioned/source-via-file pathway)
      if (objectType === 'parameter' && writeToFile) {
        const targetEdge = targetId && graph ? graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId) : undefined;
        querySignature = await computeQuerySignature(queryPayload, connectionName, graph, targetEdge);
        console.log('[DataOperationsService] Computed query signature for storage:', {
          signature: querySignature?.substring(0, 16) + '...',
          writeToFile,
          objectType
        });
      }
      
      // IMPORTANT: Only check for incremental fetch if bustCache is NOT set and we are
      // in the versioned parameter pathway (source→file→graph).
      const shouldCheckIncrementalFetch = writeToFile && !bustCache && objectType === 'parameter' && objectId;
      
      // ═══════════════════════════════════════════════════════════════════════════════
      // MATURITY-AWARE REFETCH POLICY (design.md §4.7.3)
      // For latency edges, use shouldRefetch to determine fetch strategy:
      // - gaps_only: standard incremental (non-latency or fully mature)
      // - partial: refetch only immature portion of window
      // - replace_slice: replace entire cohort slice
      // - use_cache: skip fetch entirely
      // ═══════════════════════════════════════════════════════════════════════════════
      let refetchPolicy: RefetchDecision | undefined;
      const isCohortQuery = !!requestedCohort;
      
      if (shouldCheckIncrementalFetch) {
        const paramFile = fileRegistry.getFile(`parameter-${objectId}`);
        const targetEdgeForPolicy = targetId && graph 
          ? graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId) 
          : undefined;
        const latencyConfig = targetEdgeForPolicy?.p?.latency as LatencyConfig | undefined;
        
        // Check if this edge has latency tracking enabled
        if (latencyConfig?.maturity_days && latencyConfig.maturity_days > 0) {
          // Get existing slice for this context/case family
          const existingValues = paramFile?.data?.values as ParameterValue[] | undefined;
          const existingSlice = existingValues?.find(v => {
            // Match by slice type (cohort vs window) and context dimensions
            const isCorrectMode = isCohortQuery ? isCohortModeValue(v) : !isCohortModeValue(v);
            if (!isCorrectMode) return false;
            
            // Match context/case dimensions (extractSliceDimensions is imported at top of file)
            const targetDims = extractSliceDimensions(targetSlice || '');
            const valueDims = extractSliceDimensions(v.sliceDSL || '');
            return targetDims === valueDims;
          });
          
          refetchPolicy = shouldRefetch({
            existingSlice,
            latencyConfig,
            requestedWindow,
            isCohortQuery,
          });
          
          console.log('[DataOps:REFETCH_POLICY] Maturity-aware refetch decision:', {
            maturityDays: latencyConfig.maturity_days,
            isCohortQuery,
            hasExistingSlice: !!existingSlice,
            policy: refetchPolicy.type,
            matureCutoff: refetchPolicy.matureCutoff,
            refetchWindow: refetchPolicy.refetchWindow,
            reason: refetchPolicy.reason,
          });
          
          sessionLogService.addChild(logOpId, 'info', 'REFETCH_POLICY',
            `Maturity-aware policy: ${refetchPolicy.type}`,
            `Maturity: ${latencyConfig.maturity_days}d | Mode: ${isCohortQuery ? 'cohort' : 'window'}${refetchPolicy.matureCutoff ? ` | Cutoff: ${refetchPolicy.matureCutoff}` : ''}`,
            {
              maturityDays: latencyConfig.maturity_days,
              isCohortQuery,
              policyType: refetchPolicy.type,
              matureCutoff: refetchPolicy.matureCutoff,
            }
          );
          
          // Handle use_cache policy: skip fetch entirely
          if (refetchPolicy.type === 'use_cache') {
            shouldSkipFetch = true;
            batchableToastSuccess('Data is mature and cached - no refetch needed', { id: 'das-fetch' });
            console.log('[DataOps:REFETCH_POLICY] Skipping fetch - data is mature and cached');
          }
          // Handle replace_slice policy: for cohorts, use bounded window based on path_t95
          else if (refetchPolicy.type === 'replace_slice') {
            // ═══════════════════════════════════════════════════════════════════════════
            // BOUNDED COHORT WINDOW (retrieval-date-logic §6.2)
            // For cohort queries on latency edges, bound the retrieval window using
            // path_t95 (cumulative latency from anchor). This prevents refetching
            // mature historical cohorts that won't meaningfully change.
            // ═══════════════════════════════════════════════════════════════════════════
            let fetchWindow = requestedWindow;
            
            // 1. Prefer pre-calculated window from planner (uses on-demand path_t95)
            if (boundedCohortWindow) {
              fetchWindow = boundedCohortWindow;
              console.log('[DataOps:COHORT_HORIZON] Using pre-calculated bounded window from planner:', fetchWindow);
              sessionLogService.addChild(logOpId, 'info', 'COHORT_HORIZON_PLANNER',
                `Using planner-provided bounded window`,
                undefined,
                { boundedWindow: fetchWindow }
              );
            }
            // 2. Fallback: recalculate using edge path_t95 (may be undefined on first load)
            else if (isCohortQuery && latencyConfig) {
              const horizonResult = computeCohortRetrievalHorizon({
                requestedWindow,
                pathT95: latencyConfig.path_t95,
                edgeT95: latencyConfig.t95,
                maturityDays: latencyConfig.maturity_days,
              });
              
              if (horizonResult.wasBounded) {
                fetchWindow = horizonResult.boundedWindow;
                console.log('[DataOps:COHORT_HORIZON] Bounded cohort window:', {
                  original: requestedWindow,
                  bounded: fetchWindow,
                  daysTrimmed: horizonResult.daysTrimmed,
                  effectiveT95: horizonResult.effectiveT95,
                  source: horizonResult.t95Source,
                });
                
                sessionLogService.addChild(logOpId, 'info', 'COHORT_HORIZON_BOUNDED',
                  `Cohort window bounded: ${horizonResult.daysTrimmed}d trimmed`,
                  horizonResult.summary,
                  {
                    originalStart: requestedWindow.start,
                    originalEnd: requestedWindow.end,
                    boundedStart: fetchWindow.start,
                    boundedEnd: fetchWindow.end,
                    daysTrimmed: horizonResult.daysTrimmed,
                    effectiveT95: horizonResult.effectiveT95,
                    t95Source: horizonResult.t95Source,
                  }
                );
              }
            }
            
            actualFetchWindows = [fetchWindow];
            toast.loading(
              `Refetching ${isCohortQuery ? 'cohort' : 'window'} slice (immature data)...`,
              { id: 'das-fetch' }
            );
            console.log('[DataOps:REFETCH_POLICY] Slice replacement - will fetch:', fetchWindow);
            // Skip incremental fetch logic below
          }
          // Handle partial policy: modify window to immature portion only
          else if (refetchPolicy.type === 'partial' && refetchPolicy.refetchWindow) {
            // For partial refetch, we fetch the immature portion but also check for gaps in mature portion
            actualFetchWindows = [refetchPolicy.refetchWindow];
            toast.loading(
              `Refetching immature portion (${refetchPolicy.refetchWindow.start} to ${refetchPolicy.refetchWindow.end})...`,
              { id: 'das-fetch' }
            );
            console.log('[DataOps:REFETCH_POLICY] Partial refetch of immature portion:', refetchPolicy.refetchWindow);
            // We still want to check for mature gaps below, but the primary fetch is the immature window
          }
        }
        
        if (paramFile && paramFile.data && refetchPolicy?.type !== 'use_cache' && refetchPolicy?.type !== 'replace_slice') {
          // Query signature was already computed above for signing purposes
          // Now use it for incremental fetch logic
          
          // Filter parameter file values to latest signature before calculating incremental fetch
          // Isolate to target slice, then check signatures
          let filteredParamData = paramFile.data;
          if (paramFile.data.values && Array.isArray(paramFile.data.values)) {
            // First: collect all values with daily data
            const allValuesWithDaily = (paramFile.data.values as ParameterValue[])
              .filter(v => v.n_daily && v.k_daily && v.dates && v.n_daily.length > 0);
            
            // CRITICAL: Isolate to target slice to prevent cross-slice date contamination
            const valuesWithDaily = isolateSlice(allValuesWithDaily, targetSlice);
            
            if (valuesWithDaily.length > 0 && querySignature) {
              const signatureTimestamps = new Map<string, string>();
              let hasAnySignatures = false;
              
              for (const value of valuesWithDaily) {
                if (value.query_signature) {
                  hasAnySignatures = true;
                  const timestamp = value.data_source?.retrieved_at || value.window_to || value.window_from || '';
                  const existingTimestamp = signatureTimestamps.get(value.query_signature);
                  if (!existingTimestamp || timestamp > existingTimestamp) {
                    signatureTimestamps.set(value.query_signature, timestamp);
                  }
                }
              }
              
              // Find latest signature
              let latestQuerySignature: string | undefined;
              let latestTimestamp = '';
              for (const [sig, ts] of signatureTimestamps.entries()) {
                if (ts > latestTimestamp) {
                  latestTimestamp = ts;
                  latestQuerySignature = sig;
                }
              }
              
              // Use latest signature if found, otherwise use expected signature
              const signatureToUse = latestQuerySignature || querySignature;
              
              // Check signature staleness (but use slice-isolated data)
              if (signatureToUse) {
                const staleValues = valuesWithDaily.filter(v => 
                  v.query_signature && v.query_signature !== signatureToUse
                );
                
                if (staleValues.length > 0) {
                  console.warn(`[DataOperationsService] ${staleValues.length} values in slice have stale signatures`);
                }
              }
              
              // Use slice-isolated values for incremental fetch
              filteredParamData = {
                ...paramFile.data,
                values: valuesWithDaily
              };
            }
          }
          
          // Calculate incremental fetch (pass bustCache flag)
          // Use filtered data so we only consider dates from matching signature
          // CRITICAL: Pass targetSlice (currentDSL) to isolate by context slice
          const incrementalResult = calculateIncrementalFetch(
            filteredParamData,
            requestedWindow,
            querySignature,
            bustCache || false,
            currentDSL || targetSlice || ''  // Filter by context slice
          );
          
          console.log('[DataOperationsService] Incremental fetch analysis:', {
            totalDays: incrementalResult.totalDays,
            daysAvailable: incrementalResult.daysAvailable,
            daysToFetch: incrementalResult.daysToFetch,
            needsFetch: incrementalResult.needsFetch,
            fetchWindows: incrementalResult.fetchWindows,
            fetchWindow: incrementalResult.fetchWindow, // Combined window for backward compat
            bustCache: bustCache, // Show if cache bust is active
          });
          
          // SESSION LOG: Cache analysis result - critical for debugging fetch issues
          const windowDesc = `${normalizeDate(requestedWindow.start)} to ${normalizeDate(requestedWindow.end)}`;
          const cacheStatus = bustCache 
            ? 'BUST_CACHE' 
            : (incrementalResult.needsFetch ? 'CACHE_MISS' : 'CACHE_HIT');
          const cacheDetail = bustCache
            ? `Ignoring cache: will fetch all ${incrementalResult.totalDays} days`
            : incrementalResult.needsFetch
              ? `Cached: ${incrementalResult.daysAvailable}/${incrementalResult.totalDays} days | Missing: ${incrementalResult.daysToFetch} days across ${incrementalResult.fetchWindows.length} gap(s)`
              : `Fully cached: ${incrementalResult.daysAvailable}/${incrementalResult.totalDays} days`;
          
          // Build gap detail string for fetchWindows
          const gapDetails = incrementalResult.fetchWindows.length > 0
            ? incrementalResult.fetchWindows.map((w, i) => 
                `Gap ${i + 1}: ${normalizeDate(w.start)} to ${normalizeDate(w.end)}`
              ).join('; ')
            : 'No gaps';
          
          sessionLogService.addChild(logOpId, 
            cacheStatus === 'CACHE_HIT' ? 'success' : 'info',
            cacheStatus,
            `Cache check for window ${windowDesc}`,
            `${cacheDetail}${incrementalResult.fetchWindows.length > 0 ? `\n${gapDetails}` : ''}`,
            {
              window: windowDesc,
              totalDays: incrementalResult.totalDays,
              daysAvailable: incrementalResult.daysAvailable,
              daysToFetch: incrementalResult.daysToFetch,
              gapCount: incrementalResult.fetchWindows.length,
              bustCache: bustCache || false,
              targetSlice: currentDSL || targetSlice || '',
            }
          );
          
          if (!incrementalResult.needsFetch && !bustCache) {
            // All dates already exist - skip fetching (unless bustCache is true)
            shouldSkipFetch = true;
            batchableToastSuccess(`All ${incrementalResult.totalDays} days already cached`, { id: 'das-fetch' });
            console.log('[DataOperationsService] Skipping fetch - all dates already exist');
          } else if (incrementalResult.fetchWindows.length > 0) {
            // We have multiple contiguous gaps - chain requests for each
            actualFetchWindows = incrementalResult.fetchWindows;
            const gapCount = incrementalResult.fetchWindows.length;
            const cacheBustText = bustCache ? ' (busting cache)' : '';
            toast.loading(
              `Fetching ${incrementalResult.daysToFetch} missing days across ${gapCount} gap${gapCount > 1 ? 's' : ''}${bustCache ? ' (busting cache)' : ` (${incrementalResult.daysAvailable}/${incrementalResult.totalDays} cached)`}`,
              { id: 'das-fetch' }
            );
          } else if (incrementalResult.fetchWindow) {
            // Fallback to combined window (shouldn't happen, but keep for safety)
            actualFetchWindows = [incrementalResult.fetchWindow];
            toast.loading(
              `Fetching ${incrementalResult.daysToFetch} missing days${bustCache ? ' (busting cache)' : ` (${incrementalResult.daysAvailable}/${incrementalResult.totalDays} cached)`}`,
              { id: 'das-fetch' }
            );
          } else {
            // Fallback to requested window
            actualFetchWindows = [requestedWindow];
            const cacheBustText = bustCache ? ' (busting cache)' : '';
            toast.loading(`Fetching data from source${cacheBustText}...`, { id: 'das-fetch' });
          }
        } else {
          // No parameter file - use requested window
          actualFetchWindows = [requestedWindow];
          toast.loading(`Fetching data from source...`, { id: 'das-fetch' });
        }
      } else {
        // Not writeToFile mode or no parameter file - use requested window
        actualFetchWindows = [requestedWindow];
        toast.loading(`Fetching data from source...`, { id: 'das-fetch' });
      }
      
      // If all dates are cached, skip fetching and use existing data
      if (shouldSkipFetch && objectType === 'parameter' && objectId && targetId && graph && setGraph) {
        // Use existing data from file
        // CRITICAL: Pass currentDSL as targetSlice to ensure correct window is used
        // NOTE: Suppress signature warnings here too - user is explicitly fetching this edge
        
        // SESSION LOG: Using cached data, no API fetch
        sessionLogService.addChild(logOpId, 'success', 'USING_CACHE',
          `Using cached data for ${entityLabel}`,
          `All ${requestedWindow ? Math.round((new Date(requestedWindow.end).getTime() - new Date(requestedWindow.start).getTime()) / (1000 * 60 * 60 * 24)) + 1 : '?'} days available from cache`,
          { source: 'cache', parameterId: objectId, targetId }
        );
        
        await this.getParameterFromFile({
          paramId: objectId,
          edgeId: targetId,
          graph,
          setGraph,
          window: requestedWindow,
          targetSlice: currentDSL || '', // Pass the DSL to ensure correct constraints
          suppressSignatureWarning: true, // Suppress warning when using cache (user triggered this)
          conditionalIndex, // Pass through for conditional_p handling
        });
        
        sessionLogService.endOperation(logOpId, 'success', `Applied cached data to graph`);
        return;
      }
      
      // 6. Execute DAS Runner - chain requests for each contiguous gap
      const { createDASRunner } = await import('../lib/das');
      const runner = createDASRunner();
      
      // Set context mode based on provider capabilities (from connections.yaml).
      // Connections with supports_daily_time_series: true can return per-day data for incremental fetch.
      const contextMode = supportsDailyTimeSeries ? 'daily' : 'aggregate';
      console.log('[DataOps] Context mode:', { contextMode, supportsDailyTimeSeries, connectionName });
      
      // Collect all time-series data from all gaps (parameters only)
      const allTimeSeriesData: Array<{ date: string; n: number; k: number; p: number }> = [];
      let updateData: any = {};
      // For cases: capture the most recent transformed raw result (e.g. variants_update, gate_id)
      let lastResultRaw: any = null;
      
      // Store query info for versioned parameter storage
      let queryParamsForStorage: any = undefined;
      let fullQueryForStorage: string | undefined = undefined;
      
      // ═══════════════════════════════════════════════════════════════════════════════
      // DEPRECATED: 4-Dec-25 - COMPOSITE QUERY DETECTION (minus/plus compilation)
      // 
      // This section detects exclude() queries and compiles them to minus/plus form
      // for providers that don't support native excludes.
      // 
      // REPLACEMENT: Native segment filters in Amplitude adapter (connections.yaml)
      // The adapter now converts excludes to segment filters with `op: "="`,
      // `value: 0`, which correctly excludes users who performed the event.
      // 
      // This compilation step will NOT trigger for Amplitude because:
      // 1. The adapter clears the `excludes` array after converting to segment filters
      // 2. The capability `supports_native_exclude` is now true
      // 
      // DO NOT DELETE until native segment filters are confirmed working in production.
      // Target deletion: After 2 weeks of production validation.
      // ═══════════════════════════════════════════════════════════════════════════════
      
      // Check if query uses composite operators (minus/plus for inclusion-exclusion)
      // CRITICAL: Check the ORIGINAL edge query string, NOT queryPayload.query (which doesn't exist after buildDslFromEdge)
      const targetEdge = targetId && graph ? graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId) : undefined;
      let queryString = targetEdge?.query || '';
      const isAlreadyComposite = /\.(minus|plus)\(/.test(queryString);
      const hasExcludes = /\.excludes?\(/.test(queryString);
      
      // If query has excludes but isn't already compiled to minus/plus,
      // we need to compile it for providers that don't support native excludes
      // NOTE: As of 4-Dec-25, Amplitude supports native exclude via segment filters,
      // so this compilation is SKIPPED for Amplitude connections.
      let isComposite = isAlreadyComposite;
      
      // CRITICAL: Check supports_native_exclude capability before compiling
      // Amplitude now supports native excludes (4-Dec-25), so we skip compilation
      // Get connection capabilities from runner
      let supportsNativeExclude = false;
      try {
        const connection = await (runner as any).connectionProvider.getConnection(connectionName);
        supportsNativeExclude = connection?.capabilities?.supports_native_exclude === true;
        console.log('[DataOps:EXCLUDE] Connection capabilities check:', {
          connectionName,
          supportsNativeExclude,
          hasExcludes
        });
      } catch (e) {
        console.warn('[DataOps:EXCLUDE] Failed to get connection capabilities, assuming no native exclude support');
      }
      
      if (hasExcludes && !isAlreadyComposite && !supportsNativeExclude) {
        console.log('[DataOps:EXCLUDE] Query has excludes, provider does not support native exclude, compiling to minus/plus');
        sessionLogService.addChild(logOpId, 'info', 'EXCLUDE_COMPILE_START',
          `Compiling exclude() to minus/plus for ${connectionName} (no native exclude support)`,
          `Original query: ${queryString}`
        );
        try {
          // Call Python API to compile exclude query
          const compileResult = await compileExcludeQuery(queryString, graph);
          if (compileResult.wasCompiled && compileResult.compiled !== queryString) {
            console.log('[DataOps:EXCLUDE] Compiled query:', compileResult.compiled);
            sessionLogService.addChild(logOpId, 'success', 'EXCLUDE_COMPILE_SUCCESS',
              'Exclude compiled to minus/plus form',
              `Compiled: ${compileResult.compiled}`
            );
            queryString = compileResult.compiled;
            isComposite = true;
          } else if (compileResult.error) {
            // Compilation failed with error
            console.error('[DataOps:EXCLUDE] Exclude compilation failed:', compileResult.error);
            sessionLogService.addChild(logOpId, 'error', 'EXCLUDE_COMPILE_FAILED',
              `Exclude compilation failed: ${compileResult.error}`,
              'Excludes will be ignored - data may be incorrect!'
            );
            toast.error(`Exclude compilation failed: ${compileResult.error}. Excludes will be ignored!`);
          } else if (!compileResult.wasCompiled) {
            // No excludes found (unexpected since we pre-checked)
            console.warn('[DataOps:EXCLUDE] No excludes compiled (unexpected)');
            sessionLogService.addChild(logOpId, 'warning', 'EXCLUDE_COMPILE_NONE',
              'No excludes found to compile (unexpected)',
              `Query checked: ${queryString}`
            );
          }
        } catch (error) {
          console.error('[DataOps:EXCLUDE] Failed to compile exclude query:', error);
          sessionLogService.addChild(logOpId, 'error', 'EXCLUDE_COMPILE_ERROR',
            `Exception during exclude compilation: ${error instanceof Error ? error.message : String(error)}`
          );
          toast.error('Failed to compile exclude query - excludes will be ignored');
        }
      }
      
      // ===== DIAGNOSTIC LOGGING FOR COMPOSITE QUERY DETECTION =====
      console.log('[DataOps:COMPOSITE] Query detection:', {
        hasTargetEdge: !!targetEdge,
        queryString: queryString,
        isAlreadyComposite: isAlreadyComposite,
        hasExcludes: hasExcludes,
        isComposite: isComposite,
        dslHasQuery: !!(queryPayload as any).query,
        dslKeys: Object.keys(queryPayload),
      });
      // ===========================================================
      
      // Capture query info for storage (same for all gaps)
      // queryParamsForStorage = DSL object (dictionary) for data_source.query
      // fullQueryForStorage = DSL string for data_source.full_query
      // NOTE: Python expects data_source.query to be Dict, NOT string!
      if (writeToFile && objectType === 'parameter') {
        queryParamsForStorage = queryPayload; // Always use DSL object (dictionary)
        fullQueryForStorage = queryString || JSON.stringify(queryPayload); // String goes in full_query
      }
      
      // Determine data source type from connection name (used for parameter files)
      const dataSourceType =
        connectionName?.includes('amplitude')
          ? 'amplitude'
          : connectionName?.includes('sheets')
          ? 'sheets'
          : connectionName?.includes('statsig')
          ? 'statsig'
          : 'api';
      
      // Chain requests for each contiguous gap
      for (let gapIndex = 0; gapIndex < actualFetchWindows.length; gapIndex++) {
        const fetchWindow = actualFetchWindows[gapIndex];
        
        // Rate limit before making API calls to external providers
        // This centralizes throttling for Amplitude and other rate-limited APIs
        if (connectionName) {
          await rateLimiter.waitForRateLimit(connectionName);
        }
        
        if (actualFetchWindows.length > 1) {
          toast.loading(
            `Fetching gap ${gapIndex + 1}/${actualFetchWindows.length} (${normalizeDate(fetchWindow.start)} to ${normalizeDate(fetchWindow.end)})`,
            { id: 'das-fetch' }
          );
        }
        
        // =====================================================================
        // DUAL QUERY FOR N: Run base query first if we have upstream conditions
        // This runs ONCE, upstream of both composite and simple query paths
        // =====================================================================
        let baseN: number | undefined;
        let baseTimeSeries: Array<{ date: string; n: number; k: number; p: number }> | undefined;
        
        if (needsDualQuery && baseQueryPayload) {
          console.log('[DataOps:DUAL_QUERY] Running base query for n (upstream of k queries)...');
          
          let baseRaw: any;
          
          // Check if n_query is composite (has minus/plus from excludes compilation)
          if (nQueryIsComposite && nQueryString) {
            // n_query is composite - run through composite executor
            console.log('[DataOps:DUAL_QUERY:COMPOSITE] n_query is composite, using inclusion-exclusion executor');
            
            const { executeCompositeQuery } = await import('../lib/das/compositeQueryExecutor');
            
            try {
              const nQueryCombined = await executeCompositeQuery(
                nQueryString,
                { ...baseQueryPayload, window: fetchWindow, mode: contextMode },
                connectionName,
                runner,
                graph,
                eventDefinitions  // Pass event definitions for event_id → provider event name translation
              );
              
              // executeCompositeQuery returns { n, k, p_mean, evidence }
              baseRaw = {
                n: nQueryCombined.n,
                k: nQueryCombined.k,
                p: nQueryCombined.p_mean,
                time_series: nQueryCombined.evidence?.time_series,
              };
              
              console.log('[DataOps:DUAL_QUERY:COMPOSITE] n_query composite result:', {
                n: baseRaw.n,
                k: baseRaw.k,
                p: baseRaw.p,
              });
            } catch (error) {
              console.error('[DataOps:DUAL_QUERY:COMPOSITE] n_query composite execution failed:', error);
              // Report rate limit errors to rate limiter for backoff
              const errorMsg = error instanceof Error ? error.message : String(error);
              if (connectionName && rateLimiter.isRateLimitError(errorMsg)) {
                rateLimiter.reportRateLimitError(connectionName, errorMsg);
              }
              toast.error(`n_query composite query failed: ${errorMsg}`, { id: 'das-fetch' });
              sessionLogService.endOperation(logOpId, 'error', `n_query composite query failed: ${error}`);
              return;
            }
            // Report success to reset rate limiter backoff
            if (connectionName) {
              rateLimiter.reportSuccess(connectionName);
            }
          } else {
            // Simple n_query - direct execution
            const baseResult = await runner.execute(connectionName, baseQueryPayload, {
              connection_string: connectionString,
              window: fetchWindow as { start?: string; end?: string; [key: string]: unknown },
              cohort: requestedCohort,  // A-anchored cohort for latency-tracked edges
              context: { mode: contextMode, excludeTestAccounts },
              edgeId: objectType === 'parameter' ? (targetId || 'unknown') : undefined,
              eventDefinitions,
            });
            
            if (!baseResult.success) {
              console.error('[DataOps:DUAL_QUERY] Base query failed:', baseResult.error);
              // Report rate limit errors to rate limiter for backoff
              if (connectionName && rateLimiter.isRateLimitError(baseResult.error)) {
                rateLimiter.reportRateLimitError(connectionName, baseResult.error);
              }
              toast.error(`Base query failed: ${baseResult.error}`, { id: 'das-fetch' });
              sessionLogService.endOperation(logOpId, 'error', `Base query failed: ${baseResult.error}`);
              return;
            }
            // Report success to reset rate limiter backoff
            if (connectionName) {
              rateLimiter.reportSuccess(connectionName);
            }
            
            baseRaw = baseResult.raw as any;
          }
          
          // CRITICAL: Different extraction depending on n_query type:
          // - Explicit n_query (e.g., "from(A).to(D)"): we want the COMPLETION count (k/to_count)
          //   because n_query defines a funnel, and we want "users who completed that funnel"
          // - Auto-stripped query: we want the FROM count (n/from_count)
          //   because we stripped visited_upstream but kept from/to, so n = all users at 'from'
          if (explicitNQuery) {
            // Explicit n_query: use k (to_count) = users who completed the n_query funnel
            baseN = baseRaw?.k ?? 0;
            console.log('[DataOps:DUAL_QUERY] Explicit n_query: using k (to_count) as baseN:', baseN);
          } else {
            // Auto-stripped: use n (from_count) = all users at 'from'
            baseN = baseRaw?.n ?? 0;
            console.log('[DataOps:DUAL_QUERY] Auto-stripped: using n (from_count) as baseN:', baseN);
          }
          
          // For time series: same logic - use k values for explicit n_query, n values for auto-stripped
          if (Array.isArray(baseRaw?.time_series)) {
            if (explicitNQuery) {
              // For explicit n_query, the "n" for the main query is the "k" of the n_query
              baseTimeSeries = baseRaw.time_series.map((day: any) => ({
                date: day.date,
                n: day.k,  // Use k as n
                k: day.k,  // (k is the same for reference)
                p: day.p
              }));
            } else {
              baseTimeSeries = baseRaw.time_series;
            }
          }
          
          console.log('[DataOps:DUAL_QUERY] Base query result (for n):', {
            n: baseN,
            usedExplicitNQuery: !!explicitNQuery,
            isComposite: nQueryIsComposite,
            hasTimeSeries: !!baseTimeSeries,
            timeSeriesLength: baseTimeSeries?.length ?? 0,
          });
          
          sessionLogService.addChild(logOpId, 'info', 'DUAL_QUERY_BASE',
            `Base query for n: n=${baseN} (${explicitNQuery ? 'completion count of n_query' : 'all users at from'}${nQueryIsComposite ? ', composite' : ''})`,
            `This is the denominator for upstream-conditioned queries`
          );
        }
        
        if (isComposite) {
          // Composite query: use inclusion-exclusion executor
          console.log('[DataOps] Detected composite query, using inclusion-exclusion executor');
          
          const { executeCompositeQuery } = await import('../lib/das/compositeQueryExecutor');
          
          try {
            // CRITICAL: Pass context mode to sub-queries (daily or aggregate)
            // Also pass graph for upstream/between categorization of visited nodes
            // Also pass eventDefinitions for event_id → provider event name translation
            const combined: CombinedResult = await executeCompositeQuery(
              queryString,
              { ...queryPayload, window: fetchWindow, mode: contextMode },
              connectionName,
              runner,
              graph,  // Pass graph for isNodeUpstream checks
              eventDefinitions  // Pass event definitions for event_id → provider event name translation
            );
            
            console.log(`[DataOperationsService] Composite query result for gap ${gapIndex + 1}:`, combined);
            
            // If we have a base n from dual query, use it instead of composite's n
            let finalN = combined.n;
            let finalK = combined.k;
            let finalP = combined.p_mean;
            
            if (needsDualQuery && baseN !== undefined) {
              finalN = baseN;  // Override n with base query's n
              finalP = finalN > 0 ? finalK / finalN : 0;
              console.log('[DataOps:DUAL_QUERY] Overriding composite n with base n:', {
                composite_n: combined.n,
                base_n: baseN,
                final_n: finalN,
                k: finalK,
                p: finalP
              });
            }
            
            // Extract results based on pathway: for parameters we collect time-series
            if (writeToFile && objectType === 'parameter') {
              // CRITICAL: Extract time-series data from composite result
              if (combined.evidence?.time_series && Array.isArray(combined.evidence.time_series)) {
                let timeSeries = combined.evidence.time_series;
                
                // If dual query, override n values with base time-series n
                if (needsDualQuery && baseTimeSeries) {
                  const baseDateMap = new Map(baseTimeSeries.map(d => [d.date, d.n]));
                  timeSeries = timeSeries.map(day => {
                    const base_n = baseDateMap.get(day.date) ?? day.n;
                    return {
                      date: day.date,
                      n: base_n,  // Use base n
                      k: day.k,   // Keep composite k
                      p: base_n > 0 ? day.k / base_n : 0
                    };
                  });
                  console.log('[DataOps:DUAL_QUERY] Overrode composite time-series n with base n');
                }
                
                console.log(`[DataOperationsService] Extracted ${timeSeries.length} days from composite query (gap ${gapIndex + 1})`);
                allTimeSeriesData.push(...timeSeries);
              } else {
                console.warn(`[DataOperationsService] No time-series in composite result for gap ${gapIndex + 1}`, combined);
                toast.error(`Composite query returned no daily data for gap ${gapIndex + 1}`, { id: 'das-fetch' });
                sessionLogService.endOperation(logOpId, 'error', `Composite query returned no daily data for gap ${gapIndex + 1}`);
                return;
              }
            } else {
              // Non-writeToFile mode: use aggregated results (with potentially overridden n)
              updateData = {
                mean: finalP,
                n: finalN,
                k: finalK
              };
            }
            
          } catch (error) {
            // Report rate limit errors to rate limiter for backoff
            const errorMsg = error instanceof Error ? error.message : String(error);
            if (connectionName && rateLimiter.isRateLimitError(errorMsg)) {
              rateLimiter.reportRateLimitError(connectionName, errorMsg);
            }
            toast.error(`Composite query failed for gap ${gapIndex + 1}: ${errorMsg}`, { id: 'das-fetch' });
            sessionLogService.endOperation(logOpId, 'error', `Composite query failed: ${errorMsg}`);
            return;
          }
          // Report success to reset rate limiter backoff
          if (connectionName) {
            rateLimiter.reportSuccess(connectionName);
          }
          
        } else if (needsDualQuery && baseQueryPayload) {
          // DUAL QUERY (simple): Already have base n, now get k from conditioned query
          console.log('[DataOps:DUAL_QUERY] Running conditioned query (for k)...');
          
          const condResult = await runner.execute(connectionName, queryPayload, {
            connection_string: connectionString,
            window: fetchWindow as { start?: string; end?: string; [key: string]: unknown },
            cohort: requestedCohort,  // A-anchored cohort for latency-tracked edges
            context: { mode: contextMode, excludeTestAccounts },
            edgeId: objectType === 'parameter' ? (targetId || 'unknown') : undefined,
            eventDefinitions,
          });
          
          if (!condResult.success) {
            console.error('[DataOps:DUAL_QUERY] Conditioned query failed:', condResult.error);
            // Report rate limit errors to rate limiter for backoff
            if (connectionName && rateLimiter.isRateLimitError(condResult.error)) {
              rateLimiter.reportRateLimitError(connectionName, condResult.error);
            }
            toast.error(`Conditioned query failed: ${condResult.error}`, { id: 'das-fetch' });
            sessionLogService.endOperation(logOpId, 'error', `Conditioned query failed: ${condResult.error}`);
            return;
          }
          // Report success to reset rate limiter backoff
          if (connectionName) {
            rateLimiter.reportSuccess(connectionName);
          }
          
          const condRaw = condResult.raw as any;
          console.log('[DataOps:DUAL_QUERY] Conditioned query result:', {
            n: condRaw?.n,  // Users at 'from' who visited the upstream node(s)
            k: condRaw?.k,  // Users who visited upstream, reached 'from', and converted to 'to'
            hasTimeSeries: !!condRaw?.time_series,
            timeSeriesLength: Array.isArray(condRaw?.time_series) ? condRaw.time_series.length : 0,
          });
          
          // For conditional probability with visited_upstream:
          // - n = users at 'from' who ALSO visited the upstream condition node(s)
          // - k = users who visited upstream, reached 'from', and converted to 'to'
          // This gives P(to | from, visited_upstream) - the conditional probability
          // Note: If explicit n_query was provided, baseN already has the correct value
          const combinedN = explicitNQuery ? (baseN ?? 0) : (condRaw?.n ?? 0);
          const combinedK = condRaw?.k ?? 0;
          const combinedP = combinedN > 0 ? combinedK / combinedN : 0;
          
          console.log('[DataOps:DUAL_QUERY] Combined result:', {
            n: combinedN,
            k: combinedK,
            p: combinedP,
            usedExplicitNQuery: !!explicitNQuery,
            explanation: explicitNQuery 
              ? `n=${combinedN} (from n_query), k=${combinedK} (conditioned), p=${(combinedP * 100).toFixed(2)}%`
              : `n=${combinedN} (at 'from' via upstream), k=${combinedK} (converted), p=${(combinedP * 100).toFixed(2)}%`
          });
          
          sessionLogService.addChild(logOpId, 'info', 'DUAL_QUERY_COMBINED',
            `Dual query: n=${combinedN}${explicitNQuery ? ' (n_query)' : ' (conditioned)'}, k=${combinedK}, p=${(combinedP * 100).toFixed(2)}%`,
            explicitNQuery 
              ? `n from explicit n_query, k from conditioned query`
              : `n = users at 'from' who visited upstream, k = those who converted`
          );
          
          // Combine time-series data if in writeToFile mode
          if (writeToFile && objectType === 'parameter') {
            const condTimeSeries = Array.isArray(condRaw?.time_series) ? condRaw.time_series : [];
            
            // Build combined time series
            // For conditional probability: n comes from conditioned query (users at 'from' who visited upstream)
            // unless there's an explicit n_query, in which case n comes from that
            const combinedTimeSeries: Array<{ date: string; n: number; k: number; p: number }> = [];
            
            if (explicitNQuery && baseTimeSeries) {
              // With explicit n_query: use base (n_query) for n, conditioned for k
              const dateMap = new Map<string, { n: number; k: number }>();
              
              for (const day of baseTimeSeries) {
                dateMap.set(day.date, { n: day.n, k: 0 });
              }
              
              for (const day of condTimeSeries) {
                const existing = dateMap.get(day.date);
                if (existing) {
                  existing.k = day.k;
                } else {
                  dateMap.set(day.date, { n: 0, k: day.k });
                }
              }
              
              for (const [date, { n, k }] of dateMap) {
                combinedTimeSeries.push({
                  date,
                  n,  // From n_query
                  k,  // From conditioned query
                  p: n > 0 ? k / n : 0
                });
              }
            } else {
              // Without explicit n_query: use conditioned query for BOTH n and k
              // This is the correct conditional probability P(to | from, visited)
              for (const day of condTimeSeries) {
                combinedTimeSeries.push({
                  date: day.date,
                  n: day.n,  // Users at 'from' who visited upstream
                  k: day.k,  // Users who converted after visiting upstream
                  p: day.n > 0 ? day.k / day.n : 0
                });
              }
            }
            
            // Sort by date
            combinedTimeSeries.sort((a, b) => a.date.localeCompare(b.date));
            
            console.log('[DataOps:DUAL_QUERY] Combined time series:', {
              days: combinedTimeSeries.length,
              usedExplicitNQuery: !!explicitNQuery,
              sample: combinedTimeSeries.slice(0, 3),
            });
            
            allTimeSeriesData.push(...combinedTimeSeries);
          } else {
            // Non-writeToFile mode: use combined aggregates
            updateData = {
              mean: combinedP,
              n: combinedN,
              k: combinedK
            };
          }
          
        } else {
          // Simple query: use standard DAS runner (no upstream conditions)
          const result = await runner.execute(connectionName, queryPayload, {
            connection_string: connectionString,
            window: fetchWindow as { start?: string; end?: string; [key: string]: unknown },
            cohort: requestedCohort,  // A-anchored cohort for latency-tracked edges
            context: { mode: contextMode, excludeTestAccounts }, // Pass mode and test account exclusion to adapter
            edgeId: objectType === 'parameter' ? (targetId || 'unknown') : undefined,
            caseId: objectType === 'case' ? objectId : undefined, // Pass caseId for cases
            nodeId: objectType === 'node' ? (targetId || objectId) : undefined, // Pass nodeId for nodes (future)
            eventDefinitions,  // Event file data for adapter to resolve provider names + filters
          });
          
          // Capture DAS execution history for session logs (request/response details)
          // Only include verbose data when DIAGNOSTIC_LOG is enabled to avoid bloating logs
          if (DIAGNOSTIC_LOG) {
            const dasHistory = runner.getExecutionHistory();
            for (const entry of dasHistory) {
              // Add each DAS execution step as a child log entry
              const level = entry.phase === 'error' ? 'error' : 'info';
              sessionLogService.addChild(logOpId, level, `DAS_${entry.phase.toUpperCase()}`,
                entry.message,
                undefined,
                entry.data as Record<string, unknown> | undefined
              );
            }
          }
          
          if (!result.success) {
            // Log technical details to console
            console.error(`[DataOperationsService] DAS execution failed for gap ${gapIndex + 1}:`, {
              error: result.error,
              phase: result.phase,
              details: result.details,
              window: fetchWindow,
            });
            
            // Report rate limit errors to rate limiter for backoff
            if (connectionName && rateLimiter.isRateLimitError(result.error)) {
              rateLimiter.reportRateLimitError(connectionName, result.error);
            }
            
            // Show user-friendly message in toast
            const userMessage = result.error || 'Failed to fetch data from source';
            toast.error(`${userMessage} (gap ${gapIndex + 1}/${actualFetchWindows.length})`, { id: 'das-fetch' });
            sessionLogService.endOperation(logOpId, 'error', `API call failed: ${userMessage}`);
            return;
          }
          
          // Report success to reset rate limiter backoff
          if (connectionName) {
            rateLimiter.reportSuccess(connectionName);
          }
          
          console.log(`[LAG_DEBUG] DAS_RESULT gap ${gapIndex + 1}:`, {
            updates: result.updates.length,
            hasTimeSeries: !!result.raw?.time_series,
            timeSeriesType: typeof result.raw?.time_series,
            timeSeriesIsArray: Array.isArray(result.raw?.time_series),
            timeSeriesLength: Array.isArray(result.raw?.time_series)
              ? result.raw.time_series.length
              : result.raw?.time_series
              ? 'not array'
              : 'null/undefined',
            // Show first time_series entry to check if lag data is present
            firstTimeSeriesEntry: Array.isArray(result.raw?.time_series) && result.raw.time_series.length > 0
              ? result.raw.time_series[0]
              : 'no time_series',
            // Check if lag data is in the time_series
            hasLagInTimeSeries: Array.isArray(result.raw?.time_series) && result.raw.time_series.length > 0
              ? {
                  hasMedianLag: 'median_lag_days' in result.raw.time_series[0],
                  hasMeanLag: 'mean_lag_days' in result.raw.time_series[0],
                  medianLagValue: result.raw.time_series[0]?.median_lag_days,
                  meanLagValue: result.raw.time_series[0]?.mean_lag_days,
                }
              : 'no time_series to check',
            window: fetchWindow,
          });
          
          // Log API response for user
          const responseDesc: string[] = [];
          const rawData = result.raw as any;
          if (rawData?.time_series && Array.isArray(rawData.time_series) && rawData.time_series.length > 0) {
            responseDesc.push(`${rawData.time_series.length} days of daily data`);
          }
          if (rawData?.n !== undefined) responseDesc.push(`n=${rawData.n}`);
          if (rawData?.k !== undefined) responseDesc.push(`k=${rawData.k}`);
          if (rawData?.p_mean !== undefined) responseDesc.push(`p=${((rawData.p_mean as number) * 100).toFixed(2)}%`);
          if (rawData?.variants_update) responseDesc.push(`${rawData.variants_update.length} variants`);
          
          // Provide meaningful description even when no daily breakdown
          const finalDesc = responseDesc.length > 0 
            ? responseDesc.join(', ')
            : 'aggregate data (no daily breakdown)';
          
          sessionLogService.addChild(logOpId, 'success', 'API_RESPONSE',
            `Received: ${finalDesc}`,
            `Window: ${normalizeDate(fetchWindow.start)} to ${normalizeDate(fetchWindow.end)}`,
            { 
              rowCount: rawData?.time_series?.length || result.updates?.length || 1,
              aggregates: {
                n: rawData?.n,
                k: rawData?.k,
                p: rawData?.p_mean,
                variants: rawData?.variants_update?.length
              }
          });
          
          // Capture raw data for cases (used for direct graph updates)
          if (objectType === 'case') {
            lastResultRaw = result.raw;
          }
        
          // Collect time-series data for versioned parameters when time_series is present
          if (writeToFile && objectType === 'parameter' && result.raw?.time_series) {
            // Ensure time_series is an array before spreading
            const timeSeries = result.raw.time_series;
            if (Array.isArray(timeSeries)) {
              allTimeSeriesData.push(...timeSeries);
            } else {
              // If it's not an array (e.g., single object), wrap it
              console.warn(`[DataOperationsService] time_series is not an array, wrapping:`, {
                type: typeof timeSeries,
                isArray: Array.isArray(timeSeries),
                value: timeSeries
              });
              allTimeSeriesData.push(timeSeries as { date: string; n: number; k: number; p: number });
            }
          }
          
          // Parse the updates to extract values for simple queries (use latest result for non-writeToFile mode)
          // UpdateManager now expects schema terminology: mean, n, k (not external API terminology)
          if (!writeToFile) {
            // Special handling for Sheets: interpret scalar_value / param_pack using the
            // canonical ParamPackDSLService engine and scoping.
            if (connectionName?.includes('sheets')) {
              if (objectType === 'parameter') {
                const sheetsUpdate = extractSheetsUpdateDataForEdge(
                  result.raw,
                  connectionString,
                  paramSlot,
                  conditionalIndex,
                  graph,
                  targetId
                );

                const parsedResult = result.raw?.parsed_result as any;
                console.log('[DataOperationsService] Sheets (parameter) scalar/param_pack extracted:', {
                  sheetsUpdate,
                  raw: result.raw,
                  rawValues: result.raw?.values,
                  rawValuesStringified: JSON.stringify(result.raw?.values),
                  rawParsedResult: parsedResult,
                  rawParsedResultStringified: JSON.stringify(parsedResult),
                  rawParsedResultMode: parsedResult?.mode,
                  rawParsedResultParamPack: parsedResult?.paramPack,
                  rawParsedResultParamPackKeys: parsedResult?.paramPack ? Object.keys(parsedResult.paramPack) : [],
                  rawParsedResultParamPackStringified: parsedResult?.paramPack ? JSON.stringify(parsedResult.paramPack) : 'null/undefined',
                  rawParamPack: result.raw?.param_pack,
                  rawParamPackKeys: result.raw?.param_pack ? Object.keys(result.raw?.param_pack) : [],
                  rawScalarValue: result.raw?.scalar_value,
                  rawErrors: result.raw?.errors,
                  rawErrorsStringified: JSON.stringify(result.raw?.errors),
                  connection_string: connectionString,
                  conditionalIndex,
                  targetId,
                });

                Object.assign(updateData, sheetsUpdate);
              } else if (objectType === 'case') {
                // Sheets-driven case variants via HRN param packs:
                //   n.<nodeId>.case(<caseId>:<variant>).weight
                const rawAny: any = result.raw;
                const paramPack = (rawAny.param_pack ?? rawAny.paramPack) as
                  | Record<string, unknown>
                  | null
                  | undefined;

                if (graph && targetId && paramPack) {
                  const caseNode = graph.nodes?.find(
                    (n: any) => n.uuid === targetId || n.id === targetId
                  );

                  if (caseNode) {
                    const scopedParams = buildScopedParamsFromFlatPack(
                      paramPack,
                      {
                        kind: 'case',
                        nodeUuid: caseNode.uuid,
                        nodeId: caseNode.id,
                      },
                      graph
                    );

                    const nodeKey: string = caseNode.id || caseNode.uuid;
                    const nodeParams = scopedParams.nodes?.[nodeKey];
                    const variants = nodeParams?.case?.variants;

                    if (variants && variants.length > 0) {
                      updateData.variants = variants.map((v) => ({
                        name: v.name,
                        weight: v.weight,
                      }));

                      console.log('[DataOperationsService] Sheets (case) variants extracted from param_pack:', {
                        variants: updateData.variants,
                        raw: result.raw,
                        connection_string: connectionString,
                      });
                    }
                  } else {
                    console.warn('[DataOperationsService] Sheets case update: target case node not found', {
                      targetId,
                    });
                  }
                }
              } else {
                console.warn('[DataOperationsService] Sheets ingestion for objectType not yet implemented:', {
                  objectType,
                });
              }
            } else {
              // Default path: use updates emitted by the adapter (e.g., Amplitude)
              for (const update of result.updates) {
                const parts = update.target.split('/').filter(Boolean);
                const field = parts[parts.length - 1];

                // Pass schema terminology directly to UpdateManager
                if (field === 'mean' || field === 'n' || field === 'k' || field === 'stdev') {
                  updateData[field] =
                    typeof update.value === 'number' ? update.value : Number(update.value);
                } else {
                  updateData[field] = update.value;
                }
              }
            }
          }
        }
      }
      
      // Show success message after all gaps are fetched (for non-daily/direct pulls)
      if (actualFetchWindows.length > 1) {
        batchableToastSuccess(`✓ Fetched all ${actualFetchWindows.length} gaps`, { id: 'das-fetch' });
      } else if (!writeToFile) {
        batchableToastSuccess(`Fetched data from source`, { id: 'das-fetch' });
      }
      
      // SESSION LOG: Fetch completed summary
      const fetchedDays = allTimeSeriesData.length;
      const gapsDesc = actualFetchWindows.map((w, i) => 
        `${normalizeDate(w.start)} to ${normalizeDate(w.end)}`
      ).join(', ');
      
      if (writeToFile && objectType === 'parameter') {
        sessionLogService.addChild(logOpId, 
          fetchedDays > 0 ? 'success' : 'info', 
          'FETCH_COMPLETE',
          `Fetched ${fetchedDays} days from ${connectionName || 'source'}`,
          `Windows: ${gapsDesc}${fetchedDays === 0 ? ' (no data returned)' : ''}`,
          {
            source: connectionName || 'unknown',
            daysReturned: fetchedDays,
            gapsCount: actualFetchWindows.length,
            windows: gapsDesc,
          }
        );
      } else if (Object.keys(updateData).length > 0) {
        const updateFields = Object.keys(updateData).filter(k => k !== 'data_source');
        sessionLogService.addChild(logOpId, 'success', 'FETCH_COMPLETE',
          `Fetched from ${connectionName || 'source'}`,
          `Updated: ${updateFields.join(', ')}`,
          { source: connectionName || 'unknown', fields: updateFields }
        );
      }
      
      // Add data_source metadata for direct external connections (graph-level provenance)
      if (!writeToFile) {
        updateData.data_source = {
          type: connectionName?.includes('amplitude')
            ? 'amplitude'
            : connectionName?.includes('statsig')
            ? 'statsig'
            : 'api',
          retrieved_at: new Date().toISOString(),
          // NOTE: data_source.query removed - unused and caused type mismatches with Python
          full_query: queryPayload.query || JSON.stringify(queryPayload),
        };
      }
      
      // For cases (Statsig, etc.), extract variants from raw transformed data
      // Adapters expose variant weights as `variants_update` (or `variants`) in transform output.
      // For Sheets, variants are extracted from param_pack above and stored in updateData.variants.
      if (objectType === 'case' && !writeToFile && lastResultRaw && !connectionName?.includes('sheets')) {
        console.log('[DataOperationsService] Extracting case variants from raw data', {
          rawKeys: Object.keys(lastResultRaw),
          hasVariantsUpdate: !!(lastResultRaw as any).variants_update,
          hasVariants: !!(lastResultRaw as any).variants,
        });
        const rawAny: any = lastResultRaw;
        if (rawAny.variants_update) {
          updateData.variants = rawAny.variants_update;
        } else if (rawAny.variants) {
          updateData.variants = rawAny.variants;
        }
      }
      
      // 6a. If writeToFile is true, write data to files
      // For parameters: write time-series data (or "no data" marker if API returned empty)
      if (writeToFile && objectType === 'parameter' && objectId) {
        try {
          // Get parameter file (re-read to get latest state)
          let paramFile = fileRegistry.getFile(`parameter-${objectId}`);
          if (paramFile) {
            let existingValues = (paramFile.data.values || []) as ParameterValue[];
            // CRITICAL: Use targetSlice (the specific slice being fetched), not currentDSL
            // targetSlice contains the context filter (e.g., "context(channel:influencer)")
            const sliceDSL = targetSlice || extractSliceDimensions(currentDSL || '');
            
            // Get latency config from target edge for forecast recomputation on merge
            const targetEdgeForMerge = targetId && graph 
              ? graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId) 
              : undefined;
            const latencyConfigForMerge = targetEdgeForMerge?.p?.latency;
            const shouldRecomputeForecast = !!(latencyConfigForMerge?.maturity_days && latencyConfigForMerge.maturity_days > 0);
            
            if (allTimeSeriesData.length > 0) {
              // API returned data - store each gap as a separate value entry
              for (let gapIndex = 0; gapIndex < actualFetchWindows.length; gapIndex++) {
                const fetchWindow = actualFetchWindows[gapIndex];
                
                // Filter time-series data for this specific gap
                const gapTimeSeries = allTimeSeriesData.filter(point => {
                  const pointDate = normalizeDate(point.date);
                  return isDateInRange(pointDate, fetchWindow);
                });
                
                if (gapTimeSeries.length > 0) {
                  // DEBUG: Log time series BEFORE merge to check lag data
                  console.log(`[LAG_DEBUG] BEFORE_MERGE gap ${gapIndex + 1}:`, {
                    timeSeriesCount: gapTimeSeries.length,
                    firstEntry: gapTimeSeries[0],
                  });
                  
                  // Append new time-series as a separate value entry for this gap
                  // For latency edges, pass latency config to enable forecast recomputation
                  existingValues = mergeTimeSeriesIntoParameter(
                    existingValues,
                    gapTimeSeries,
                    fetchWindow,
                    querySignature,
                    queryParamsForStorage,
                    fullQueryForStorage,
                    dataSourceType,
                    sliceDSL, // CRITICAL: Pass context slice for isolateSlice matching
                    // CRITICAL: Always pass isCohortMode to ensure correct storage mode
                    // isCohortMode determines sliceDSL format (cohort vs window), independent of forecast
                    {
                      isCohortMode: isCohortQuery,
                      // LAG: Pass latency config for forecast recomputation if available
                      ...(shouldRecomputeForecast && {
                        latencyConfig: {
                          maturity_days: latencyConfigForMerge?.maturity_days,
                          anchor_node_id: latencyConfigForMerge?.anchor_node_id,
                        },
                        recomputeForecast: true,
                      }),
                    }
                  );
                  
                  // DEBUG: Log what was stored AFTER merge
                  const lastValue = existingValues[existingValues.length - 1];
                  console.log(`[LAG_DEBUG] AFTER_MERGE gap ${gapIndex + 1}:`, {
                    paramId: objectId,
                    newDays: gapTimeSeries.length,
                    fetchWindow,
                    sliceDSL,
                    storedValue: {
                      datesCount: lastValue?.dates?.length,
                      hasMedianLagArray: !!lastValue?.median_lag_days,
                      medianLagArrayLength: lastValue?.median_lag_days?.length,
                      medianLagSample: lastValue?.median_lag_days?.slice?.(0, 3),
                      hasMeanLagArray: !!lastValue?.mean_lag_days,
                      meanLagArrayLength: lastValue?.mean_lag_days?.length,
                    },
                  });
                }
              }
              
              batchableToastSuccess(`✓ Added ${allTimeSeriesData.length} new days across ${actualFetchWindows.length} gap${actualFetchWindows.length > 1 ? 's' : ''}`, { duration: 2000 });
            } else {
              // API returned NO DATA - write a "no data" marker so we can cache this result
              // Without this, switching to this slice later would show fetch button again
              for (const fetchWindow of actualFetchWindows) {
                // Generate all dates in the window
                const startD = parseDate(normalizeDate(fetchWindow.start));
                const endD = parseDate(normalizeDate(fetchWindow.end));
                const dates: string[] = [];
                const currentD = new Date(startD);
                while (currentD <= endD) {
                  dates.push(normalizeDate(currentD.toISOString()));
                  currentD.setDate(currentD.getDate() + 1);
                }
                
                // Create "no data" entry with zero values for each date
                const noDataEntry: ParameterValue = {
                  mean: 0,
                  n: 0,
                  k: 0,
                  dates: dates.map(d => normalizeToUK(d)),
                  n_daily: dates.map(() => 0),
                  k_daily: dates.map(() => 0),
                  window_from: normalizeToUK(fetchWindow.start),
                  window_to: normalizeToUK(fetchWindow.end),
                  sliceDSL, // CRITICAL: Tag with context so isolateSlice finds it
                  data_source: {
                    type: 'amplitude',
                    retrieved_at: new Date().toISOString(),
                    full_query: fullQueryForStorage,
                  },
                  query_signature: querySignature,
                };
                existingValues.push(noDataEntry);
                
                console.log(`[DataOperationsService] Cached "no data" marker for slice:`, {
                  paramId: objectId,
                  sliceDSL,
                  fetchWindow,
                  dates,
                });
              }
              
              toast(`No data from source for ${sliceDSL || 'base context'}`, { icon: 'ℹ️', duration: 2000 });
            }
            
            // Update file once with all new value entries
            const updatedFileData = structuredClone(paramFile.data);
            updatedFileData.values = existingValues;
            
            // CRITICAL: Push graph's query strings to parameter file (graph is master for queries)
            // This is the ONE place where graph→file update happens (when fetching from source)
            // Both query and n_query follow the same pattern: mastered on edge, copied to file
            if (queryString) {
              updatedFileData.query = queryString;
              // Also copy query_overridden flag from edge
              if (targetEdge?.query_overridden !== undefined) {
                updatedFileData.query_overridden = targetEdge.query_overridden;
              }
              console.log('[DataOperationsService] Updated parameter file query from graph:', {
                paramId: objectId,
                query: queryString,
                query_overridden: targetEdge?.query_overridden
              });
            }
            
            // Also push n_query if present (same pattern as query - edge is master, file is copy)
            // This allows the parameter file to be used independently without the graph
            if (explicitNQuery) {
              updatedFileData.n_query = explicitNQuery;
              // Also copy n_query_overridden flag
              if (nQueryEdge?.n_query_overridden !== undefined) {
                updatedFileData.n_query_overridden = nQueryEdge.n_query_overridden;
              }
              console.log('[DataOperationsService] Updated parameter file n_query from graph:', {
                paramId: objectId,
                n_query: explicitNQuery,
                n_query_overridden: nQueryEdge?.n_query_overridden
              });
            } else if (updatedFileData.n_query && !nQueryEdge?.n_query) {
              // Edge no longer has n_query but file still does - remove it
              delete updatedFileData.n_query;
              delete updatedFileData.n_query_overridden;
              console.log('[DataOperationsService] Removed stale n_query from parameter file:', {
                paramId: objectId
              });
            }
            
            await fileRegistry.updateFile(`parameter-${objectId}`, updatedFileData);
            
            // Log file update
            sessionLogService.addChild(logOpId, 'success', 'FILE_UPDATED',
              `Updated parameter file: ${objectId}`,
              `Added ${allTimeSeriesData.length > 0 ? allTimeSeriesData.length + ' days of data' : '"no data" marker'}`,
              { fileId: `parameter-${objectId}`, rowCount: allTimeSeriesData.length });
          } else {
            console.warn('[DataOperationsService] Parameter file not found, skipping time-series storage');
          }
        } catch (error) {
          console.error('[DataOperationsService] Failed to append time-series data:', error);
          // Don't fail the whole operation, just log the error
        }
      }
      
      // 6a-cont. ALWAYS load from file after fetch attempt (even if no new data)
      // This ensures the graph shows cached data for the requested window/context
      // even when the API returns empty results for this specific slice/date
      if (writeToFile && objectType === 'parameter' && objectId && graph && setGraph && targetId) {
        console.log('[DataOperationsService] Loading parameter data from file into graph (post-fetch)', {
          currentDSL,
          targetSliceToPass: currentDSL || '',
          requestedWindow,
          hadNewData: allTimeSeriesData.length > 0,
          bustCache,
          conditionalIndex,
        });
        await this.getParameterFromFile({
          paramId: objectId,
          edgeId: targetId,
          graph,
          setGraph,
          window: requestedWindow, // Aggregate across the full requested window
          targetSlice: currentDSL || '', // Pass the DSL to ensure correct constraints
          suppressSignatureWarning: bustCache, // Don't warn about signature mismatch when busting cache
          conditionalIndex, // Pass through for conditional_p handling
        });
      }
      
      // 6b. For versioned case fetches: write schedule entry to case file
      // NOTE: Controlled by versionedCase flag, NOT writeToFile (writeToFile is parameter-specific and for parameters only)
      if (versionedCase && objectType === 'case' && objectId && lastResultRaw) {
        try {
          const caseFileId = `case-${objectId}`;
          const caseFile = fileRegistry.getFile(caseFileId);
          
          if (!caseFile) {
            console.error('[DataOperationsService] Case file not found for versioned case fetch:', { caseFileId });
            toast.error(`Case file not found: ${objectId}`);
            sessionLogService.endOperation(logOpId, 'error', `Case file not found: ${objectId}`);
            return;
          }
          
          // Extract variants from transform output
          const variants = lastResultRaw.variants_update || lastResultRaw.variants;
          if (!variants) {
            console.error('[DataOperationsService] No variants found in transform output');
            toast.error('No variant data returned from Statsig');
            sessionLogService.endOperation(logOpId, 'error', 'No variant data returned from Statsig');
            return;
          }
          
          // Create new schedule entry
          const newSchedule = {
            window_from: normalizeToUK(new Date().toISOString()),
            window_to: null,
            variants,
            // Capture provenance on the schedule itself (case file history)
            retrieved_at: new Date().toISOString(),
            source: connectionName?.includes('statsig')
              ? 'statsig'
              : connectionName?.includes('amplitude')
              ? 'amplitude'
              : 'external',
          };
          
          console.log('[DataOperationsService] Appending case schedule:', newSchedule);
          
          const updatedFileData: any = structuredClone(caseFile.data);
          // Support both legacy root-level schedules and nested case.schedules[]
          if (Array.isArray(updatedFileData.schedules)) {
            updatedFileData.schedules.push(newSchedule);
          } else {
            updatedFileData.case = updatedFileData.case || {};
            updatedFileData.case.schedules = updatedFileData.case.schedules || [];
            updatedFileData.case.schedules.push(newSchedule);
          }
          
          await fileRegistry.updateFile(caseFileId, updatedFileData);
          toast.success(`✓ Added new schedule entry to case file`);
          
        } catch (error) {
          console.error('[DataOperationsService] Failed to append case schedule:', error);
          // Don't fail the whole operation, just log the error
        }
      }
      
      if (!writeToFile) {
        console.log('Extracted data from DAS (using schema terminology):', updateData);
        
        // Calculate stdev and enhance stats if we have n and k (same codepath as file pulls)
        // Use schema terminology: mean, n, k (not external API terminology)
        if (updateData.n && updateData.k !== undefined) {
          const n = updateData.n;
          const k = updateData.k;
          const mean = updateData.mean ?? (k / n);
          
          // Create raw aggregation (same format as windowAggregationService.aggregateWindow returns)
          // For direct pulls, we have a single aggregated point (no daily time-series)
          const rawAggregation = {
            method: 'naive' as const,
            n,
            k,
            mean,
            stdev: (mean === 0 || mean === 1 || n === 0) ? 0 : Math.sqrt((mean * (1 - mean)) / n),
            raw_data: [], // No daily data for direct pulls
            window: window || {
              start: new Date().toISOString().split('T')[0],
              end: new Date().toISOString().split('T')[0]
            },
            days_included: 1,
            days_missing: 0,
            missing_dates: [],
            gaps: [],
            missing_at_start: false,
            missing_at_end: false,
            has_middle_gaps: false
          };
          
          // Enhance with statistical methods (same as file pulls: inverse-variance)
          // Handle both sync (TS) and async (Python) results
          const enhancedResult = statisticalEnhancementService.enhance(rawAggregation as any, 'inverse-variance');
          const enhanced = enhancedResult instanceof Promise 
            ? await enhancedResult 
            : enhancedResult;
          
          // Update with enhanced stats (same as file pull path) - use schema terminology
          updateData.mean = enhanced.mean;
          updateData.stdev = enhanced.stdev;
          
          console.log('[DataOperationsService] Enhanced stats from external data (same codepath as file pulls):', {
            raw: {
              mean: rawAggregation.mean,
              stdev: rawAggregation.stdev,
              n: rawAggregation.n,
              k: rawAggregation.k
            },
            enhanced: {
              mean: enhanced.mean,
              stdev: enhanced.stdev,
              n: enhanced.n,
              k: enhanced.k
            }
          });
        }
      }
      
      // 7. Apply directly to graph (only if NOT in writeToFile)
      // When writeToFile is true, the versioned path (getFromSource) will update the graph
      // via getParameterFromFile after the file is updated
      if (!writeToFile && objectType === 'parameter') {
        if (!targetId || !graph || !setGraph) {
          console.error('[DataOperationsService] Cannot apply to graph: missing context', {
            targetId, hasGraph: !!graph, hasSetGraph: !!setGraph
          });
          toast.error('Cannot apply to graph: missing context');
          sessionLogService.endOperation(logOpId, 'error', 'Cannot apply to graph: missing context');
          return;
        }
        
        // Find the target edge
        const targetEdge = graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId);
        if (!targetEdge) {
          console.error('[DataOperationsService] Target edge not found in graph', {
            targetId, edgeCount: graph.edges?.length
          });
          toast.error('Target edge not found in graph');
          sessionLogService.endOperation(logOpId, 'error', 'Target edge not found in graph');
          return;
        }
        
        // ===== CONDITIONAL_P HANDLING =====
        // Use unified UpdateManager code path for conditional probability updates
        if (conditionalIndex !== undefined) {
          console.log('[DataOperationsService] Applying to conditional_p via UpdateManager:', {
            conditionalIndex,
            updateData,
            hasConditionalP: !!targetEdge.conditional_p,
            conditionalPLength: targetEdge.conditional_p?.length
          });
          
          // Use UpdateManager's unified conditional probability update
          let nextGraph = updateManager.updateConditionalProbability(
            graph,
            targetId!,
            conditionalIndex,
            {
              mean: updateData.mean,
              stdev: updateData.stdev,
              evidence: (updateData.n !== undefined || updateData.k !== undefined) 
                ? { n: updateData.n, k: updateData.k }
                : undefined,
              data_source: updateData.data_source
            },
            { respectOverrides: true }
          );
          
          // Check if graph actually changed (UpdateManager returns original if no changes)
          if (nextGraph === graph) {
            toast('No changes applied (fields may be overridden)', { icon: 'ℹ️' });
            sessionLogService.endOperation(logOpId, 'success', `No changes to conditional_p[${conditionalIndex}] (overridden)`);
            return;
          }
          
          // AUTO-REBALANCE: If mean was updated, rebalance conditional probability siblings
          const meanWasUpdated = updateData.mean !== undefined;
          let finalGraph = nextGraph;
          
          if (meanWasUpdated) {
            const updatedEdgeId = targetId!;
            
            console.log('[DataOperationsService] Rebalancing conditional_p siblings after external fetch:', {
              updatedEdgeId,
              conditionalIndex,
              meanWasUpdated
            });
            
            finalGraph = updateManager.rebalanceConditionalProbabilities(
              nextGraph,
              updatedEdgeId,
              conditionalIndex,
              false // Don't force rebalance - respect overrides
            );
          }
          
          setGraph(finalGraph);
          
          const hadRebalance = finalGraph !== nextGraph;
          if (hadRebalance) {
            toast.success(`Applied to conditional[${conditionalIndex}] + siblings rebalanced`);
          } else {
            toast.success(`Applied to conditional[${conditionalIndex}]`);
          }
          
          sessionLogService.endOperation(logOpId, 'success', `Applied to conditional_p[${conditionalIndex}]`);
          return;  // Done - skip the base edge path below
        }
        // ===== END CONDITIONAL_P HANDLING =====
        
        // Call UpdateManager to transform and apply external data directly to graph
        // DAS data is "external" data (not from file), so use handleExternalToGraph
        console.log('[DataOperationsService] Calling UpdateManager with:', {
          updateData,
          targetEdge: {
            uuid: targetEdge.uuid,
            'p.mean': targetEdge.p?.mean,
            'p.mean_overridden': targetEdge.p?.mean_overridden
          }
        });
        
        const updateResult = await updateManager.handleExternalToGraph(
          updateData,  // External data with {mean, n, k, etc}
          targetEdge,
          'UPDATE',
          'parameter',
          { interactive: false }
        );
        
        console.log('[DataOperationsService] UpdateManager result:', {
          success: updateResult.success,
          changesLength: updateResult.changes?.length,
          changes: updateResult.changes,
          conflicts: updateResult.conflicts,
          metadata: updateResult.metadata
        });
        
        // Notify user of overridden fields
        if (updateResult.conflicts && updateResult.conflicts.length > 0) {
          const overriddenCount = updateResult.conflicts.filter(c => c.reason === 'overridden').length;
          if (overriddenCount > 0) {
            toast(`⚠️ ${overriddenCount} parameter field${overriddenCount > 1 ? 's' : ''} overridden`, { 
              duration: 3000,
              icon: '⚠️'
            });
          }
        }
        
        if (!updateResult.success) {
          toast.error('Failed to apply updates to graph');
          sessionLogService.endOperation(logOpId, 'error', 'Failed to apply updates to graph');
          return;
        }
        
        // Apply the changes to the graph
        if (updateResult.changes && updateResult.changes.length > 0) {
          const nextGraph = structuredClone(graph);
          const edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === targetId || e.id === targetId);
          
          if (edgeIndex >= 0) {
            applyChanges(nextGraph.edges[edgeIndex], updateResult.changes);
            
            if (nextGraph.metadata) {
              nextGraph.metadata.updated_at = new Date().toISOString();
            }
            
            // AUTO-REBALANCE: If UpdateManager flagged this update as needing sibling rebalance
            // This applies to both external data (DAS) and file pulls, but NOT manual slider edits
            // Also rebalance if mean was provided in updateData (even if value didn't change)
            // Use schema terminology: mean (not probability)
            let finalGraph = nextGraph;
            const shouldRebalance = (updateResult.metadata as any)?.requiresSiblingRebalance || 
                                   (updateData.mean !== undefined && updateData.mean !== null);
            
            console.log('[DataOperationsService] Rebalance check:', {
              requiresSiblingRebalance: (updateResult.metadata as any)?.requiresSiblingRebalance,
              hasMean: updateData.mean !== undefined && updateData.mean !== null,
              shouldRebalance,
              updatedField: (updateResult.metadata as any)?.updatedField
            });
            
            if (shouldRebalance) {
              // Use UpdateManager's rebalance method
              const { UpdateManager } = await import('./UpdateManager');
              const updateManagerInstance = new UpdateManager();
              const updatedEdgeId = (updateResult.metadata as any)?.updatedEdgeId || targetId;
              
              console.log('[DataOperationsService] Calling rebalanceEdgeProbabilities:', {
                edgeId: updatedEdgeId,
                targetId
              });
              
              finalGraph = updateManagerInstance.rebalanceEdgeProbabilities(
                nextGraph,
                updatedEdgeId,
                false // Don't force rebalance - respect overrides
              );
            }
            
            setGraph(finalGraph);
            
            const hadRebalance = finalGraph !== nextGraph;
            if (hadRebalance) {
              toast.success(`Applied: ${updateResult.changes.length} fields + siblings rebalanced`);
            } else {
              toast.success(`Applied to graph: ${updateResult.changes.length} fields updated`);
            }
          }
        } else {
          toast('No changes to apply', { icon: 'ℹ️' });
        }
      } else {
        // In writeToFile, we've already updated the parameter file - graph will be updated by getFromSource via getParameterFromFile
        console.log(
          '[DataOperationsService] Skipping direct graph update for parameters (writeToFile=true, versioned path will handle it)'
        );
      }
      
      // 8. For cases in direct mode: Apply variants directly to graph nodes (no case file)
      // (External → Graph Case Node: see Mapping 7 in SCHEMA_FIELD_MAPPINGS.md)
      if (objectType === 'case' && !writeToFile && !versionedCase && graph && setGraph && targetId) {
        if (!updateData.variants) {
          console.warn('[DataOperationsService] No variants data to apply to case node');
          sessionLogService.endOperation(logOpId, 'warning', 'No variants data to apply to case node');
          return;
        }
        
        console.log('[DataOperationsService] Applying case variants directly to graph', {
          variants: updateData.variants,
          data_source: updateData.data_source,
        });
        
        const caseNode = graph.nodes?.find((n: any) => 
          (n.uuid === targetId || n.id === targetId) && n.type === 'case'
        );
        
        if (!caseNode) {
          console.error('[DataOperationsService] Case node not found', { targetId });
          toast.error('Case node not found in graph');
          sessionLogService.endOperation(logOpId, 'error', 'Case node not found in graph');
          return;
        }
        
        // Build payload for UpdateManager: variants + data_source provenance
        const caseDataSource = updateData.data_source
          ? {
              ...updateData.data_source,
              // Attach experiment/gate id if available from transform or DSL
              experiment_id:
                (lastResultRaw as any)?.gate_id ??
                (queryPayload as any)?.gate_id ??
                updateData.data_source.experiment_id,
            }
          : undefined;

        const payload: any = {
          variants: updateData.variants,
        };
        if (caseDataSource) {
          payload.data_source = caseDataSource;
        }

        // Use UpdateManager to apply variants (and data_source) to case node (respects override flags)
        const updateResult = await updateManager.handleExternalToGraph(
          payload,
          caseNode,
          'UPDATE',
          'case',
          { interactive: false }
        );
        
        console.log('[DataOperationsService] Direct case update result:', {
          success: updateResult.success,
          changes: updateResult.changes,
          conflicts: updateResult.conflicts
        });
        
        // Track overridden fields
        let totalOverriddenCount = 0;
        if (updateResult.conflicts && updateResult.conflicts.length > 0) {
          const overriddenCount = updateResult.conflicts.filter(c => c.reason === 'overridden').length;
          totalOverriddenCount += overriddenCount;
        }
        
        if (!updateResult.success) {
          console.error('[DataOperationsService] UpdateManager failed for case', updateResult);
          toast.error('Failed to apply case updates');
          sessionLogService.endOperation(logOpId, 'error', 'Failed to apply case updates');
          return;
        }
        
        // Apply changes to graph
        if (updateResult.changes && updateResult.changes.length > 0) {
          const nextGraph = structuredClone(graph);
          const nodeIndex = nextGraph.nodes.findIndex((n: any) => 
            n.uuid === targetId || n.id === targetId
          );
          
          if (nodeIndex >= 0) {
            applyChanges(nextGraph.nodes[nodeIndex], updateResult.changes);
            
            // Auto-rebalance variants if needed
            if (
              (updateResult.metadata as any)?.requiresVariantRebalance &&
              nextGraph.nodes[nodeIndex].case &&
              Array.isArray(nextGraph.nodes[nodeIndex].case.variants)
            ) {
              const variantIndex =
                nextGraph.nodes[nodeIndex].case.variants.findIndex(
                  (v: any) => !v.weight_overridden
                );
              
              if (variantIndex >= 0) {
                const rebalanceResult = updateManager.rebalanceVariantWeights(
                  nextGraph,
                  targetId,
                  variantIndex,
                  false
                );
                
                totalOverriddenCount += rebalanceResult.overriddenCount;
                
                // Copy rebalanced node back
                const rebalancedNode = rebalanceResult.graph.nodes.find(
                  (n: any) => (n.uuid || n.id) === targetId
                );
                if (rebalancedNode && rebalancedNode.case?.variants) {
                  nextGraph.nodes[nodeIndex].case.variants =
                    rebalancedNode.case.variants;
                }
              }
            }
            
            if (nextGraph.metadata) {
              nextGraph.metadata.updated_at = new Date().toISOString();
            }
            
            setGraph(nextGraph);
            
            // Show combined notification
            if (totalOverriddenCount > 0) {
              toast(`⚠️ ${totalOverriddenCount} variant${totalOverriddenCount > 1 ? 's' : ''} overridden`, { 
                duration: 3000,
                icon: '⚠️'
              });
            }
            toast.success('✓ Updated case from Statsig');
            
            // Log graph update
            sessionLogService.addChild(logOpId, 'success', 'GRAPH_UPDATED',
              `Updated case node: ${formatNodeForLog(caseNode)}`,
              `${updateResult.changes?.length || 0} changes applied`,
              { targetId });
          }
        } else {
          toast('No changes to apply', { icon: 'ℹ️' });
        }
      }
      
      // End operation successfully
      sessionLogService.endOperation(logOpId, 'success', 
        `Completed: ${entityLabel}`,
        { sourceType: connectionName });
      
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Error: ${message}`);
      console.error('getFromSourceDirect error:', error);
      sessionLogService.endOperation(logOpId, 'error', `Data fetch failed: ${message}`);
    }
  }
  
  /**
   * Open connection settings modal
   * Opens File > Connections tab
   */
  async openConnectionSettings(objectType: 'parameter' | 'case', objectId: string): Promise<void> {
    // Open connections file using fileOperationsService
    const { fileOperationsService } = await import('./fileOperationsService');
    const connectionsItem = {
      id: 'connections',
      type: 'connections' as const,
      name: 'Connections',
      path: 'connections/connections.yaml'
    };
    
    await fileOperationsService.openFile(connectionsItem, {
      viewMode: 'interactive',
      switchIfExists: true
    });
  }
  
  /**
   * Unsign cache for a parameter, case, or node file
   * 
   * For parameters: Removes query_signature from all cached values[] entries
   *   - Data stays intact (less destructive)
   *   - Signatures don't match, so next fetch will re-retrieve
   * For cases: Removes signatures from schedule data
   * For nodes: Currently no-op (nodes don't have cached data)
   * 
   * Use this when:
   * - Implementation bugs were fixed (e.g., adapter query generation)
   * - You suspect cached data is stale
   * - Query signature doesn't detect the change but data is wrong
   */
  async clearCache(objectType: 'parameter' | 'case' | 'node', objectId: string): Promise<void> {
    try {
      if (objectType === 'parameter') {
        const fileId = `parameter-${objectId}`;
        const file = fileRegistry.getFile(fileId);
        
        if (!file) {
          toast.error(`Parameter file not found: ${objectId}`);
          return;
        }
        
        // Count how many values have signatures
        const signedCount = file.data.values?.filter((v: any) => v.query_signature).length || 0;
        
        if (signedCount === 0) {
          toast('No signed cache entries to unsign', { icon: 'ℹ️', duration: 2000 });
          return;
        }
        
        // Remove query_signature from all values (keep the data itself)
        const updatedValues = file.data.values?.map((v: any) => {
          const { query_signature, ...rest } = v;
          return rest;
        }) || [];
        
        const updatedData = {
          ...file.data,
          values: updatedValues
        };
        
        await fileRegistry.updateFile(fileId, updatedData);
        
        toast.success(`Unsigned ${signedCount} cached value${signedCount !== 1 ? 's' : ''} in ${objectId}`, {
          duration: 3000
        });
        
        console.log('[DataOperationsService] Unsigned cache:', {
          objectType,
          objectId,
          signedCount
        });
        
      } else if (objectType === 'case') {
        const fileId = `case-${objectId}`;
        const file = fileRegistry.getFile(fileId);
        
        if (!file) {
          toast.error(`Case file not found: ${objectId}`);
          return;
        }
        
        // For cases, remove signature if present
        // (Case schema may vary - adjust as needed)
        const scheduleCount = Array.isArray(file.data.schedules) 
          ? file.data.schedules.length 
          : file.data.case?.schedules?.length || 0;
        
        if (scheduleCount === 0) {
          toast('No cached schedules to unsign', { icon: 'ℹ️', duration: 2000 });
          return;
        }
        
        // Remove signatures from schedules if they have them
        const updatedSchedules = (file.data.schedules || file.data.case?.schedules || []).map((s: any) => {
          const { query_signature, ...rest } = s;
          return rest;
        });
        
        const updatedData = {
          ...file.data,
          schedules: updatedSchedules,
          case: {
            ...file.data.case,
            schedules: updatedSchedules
          }
        };
        
        await fileRegistry.updateFile(fileId, updatedData);
        
        toast.success(`Unsigned ${scheduleCount} cached schedule${scheduleCount !== 1 ? 's' : ''} in ${objectId}`, {
          duration: 3000
        });
        
      } else {
        // Nodes don't have cached data (yet)
        toast('Nodes don\'t have cached data to unsign', { icon: 'ℹ️', duration: 2000 });
      }
      
    } catch (error) {
      console.error('[DataOperationsService] Failed to unsign cache:', error);
      toast.error(`Failed to unsign cache: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  /**
   * Open sync status modal
   * 
   * Should show comparison:
   * - Current value in graph (with override status)
   * - Current value in file (latest values[] entry)
   * - Last retrieved from source (evidence fields: n, k, window_from, window_to)
   * - Sync/conflict indicators (overridden fields, missing data, etc.)
   * - Query signature consistency (if query changed since last fetch)
   * 
   * STUB for Phase 1 - shows toast notification
   */
  async openSyncStatus(objectType: 'parameter' | 'case' | 'node', objectId: string): Promise<void> {
    toast('Sync Status modal coming in Phase 2!', { icon: '📊', duration: 3000 });
    // TODO Phase 2: Build sync status modal
    // Show comparison:
    // - Current value in graph
    // - Current value in file
    // - Last retrieved from source
    // - Sync/conflict indicators
  }
  
  /**
   * Batch get from source - fetches multiple items and updates graph correctly.
   * 
   * CRITICAL: This method handles the iteration internally to avoid stale closure
   * problems. Each iteration uses the updated graph from the previous iteration.
   * 
   * UI components should call this instead of looping over getFromSource() themselves.
   * 
   * @param options.items - Array of items to fetch
   * @param options.graph - Initial graph state
   * @param options.setGraph - Function to update graph (called after each item)
   * @param options.currentDSL - DSL for window/context
   * @param options.targetSlice - Optional slice DSL
   * @param options.bustCache - If true, ignore cached data
   * @param options.onProgress - Optional callback for progress updates
   * @returns Results summary { success: number, errors: number, items: ItemResult[] }
   */
  async batchGetFromSource(options: {
    items: Array<{
      type: 'parameter' | 'case';
      objectId: string;
      targetId: string;
      paramSlot?: 'p' | 'cost_gbp' | 'labour_cost';
      name?: string;
    }>;
    graph: Graph | null;
    setGraph: (graph: Graph | null) => void;
    currentDSL?: string;
    targetSlice?: string;
    bustCache?: boolean;
    onProgress?: (current: number, total: number, itemName?: string) => void;
  }): Promise<{
    success: number;
    errors: number;
    items: Array<{ name: string; success: boolean; error?: string }>;
  }> {
    const { items, graph: initialGraph, setGraph, currentDSL, targetSlice, bustCache = false, onProgress } = options;
    
    if (!initialGraph || items.length === 0) {
      return { success: 0, errors: 0, items: [] };
    }
    
    // CRITICAL: Track current graph state internally to avoid stale closure
    let currentGraph: Graph | null = initialGraph;
    const results: Array<{ name: string; success: boolean; error?: string }> = [];
    let successCount = 0;
    let errorCount = 0;
    
    // Create a setGraph wrapper that updates our internal state
    const setGraphInternal = (newGraph: Graph | null) => {
      currentGraph = newGraph;
      setGraph(newGraph);
    };
    
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemName = item.name || `${item.type}-${item.objectId}`;
      
      // Report progress
      if (onProgress) {
        onProgress(i + 1, items.length, itemName);
      }
      
      try {
        if (item.type === 'parameter') {
          await this.getFromSource({
            objectType: 'parameter',
            objectId: item.objectId,
            targetId: item.targetId,
            graph: currentGraph,  // Use current (not stale) graph
            setGraph: setGraphInternal,  // Updates internal state
            paramSlot: item.paramSlot,
            bustCache,
            currentDSL: currentDSL || '',
            targetSlice
          });
        } else if (item.type === 'case') {
          await this.getFromSource({
            objectType: 'case',
            objectId: item.objectId,
            targetId: item.targetId,
            graph: currentGraph,
            setGraph: setGraphInternal,
            currentDSL: currentDSL || ''
          });
        }
        
        results.push({ name: itemName, success: true });
        successCount++;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        results.push({ name: itemName, success: false, error: errorMessage });
        errorCount++;
        console.error(`[DataOps:BATCH] Failed to fetch ${itemName}:`, err);
      }
    }
    
    return { success: successCount, errors: errorCount, items: results };
  }
  
  /**
   * Helper: Ensure evidence/forecast scalars are present on aggregated parameter data.
   * 
   * - evidence.mean / evidence.stdev are ALWAYS derived from n/k for probability params
   *   (raw observed rate and binomial uncertainty) before UpdateManager runs.
   * - For cohort() queries, p.forecast.mean is copied from the corresponding window()
   *   slice in the same parameter file (dual-slice retrieval – design.md §4.6, §4.8).
   */
  private addEvidenceAndForecastScalars(
    aggregatedData: any,
    originalParamData: any,
    targetSlice: string | undefined
  ): any {
    if (!aggregatedData || !Array.isArray(aggregatedData.values)) {
      return aggregatedData;
    }
    
    const isProbabilityParam =
      aggregatedData.type === 'probability' ||
      aggregatedData.parameter_type === 'probability';
    
    if (!isProbabilityParam) {
      return aggregatedData;
    }
    
    const values = aggregatedData.values as ParameterValue[];
    
    // Parse target constraints once for both cohort and forecast logic
    const parsedTarget = targetSlice ? parseConstraints(targetSlice) : null;
    const isCohortQuery = !!parsedTarget?.cohort;
    
    // Check if this is an EXACT slice match (targetSlice == value.sliceDSL)
    // For exact matches with a single value, use the header n/k directly rather
    // than re-aggregating from daily arrays (which may be incomplete samples).
    const isExactMatch = values.length === 1 && values[0].sliceDSL === targetSlice;
    
    // === 1) Evidence scalars ===
    //
    // Exact slice match:
    //   - Use header n/k directly (authoritative totals for that slice).
    // Window() queries (non-exact):
    //   - evidence is derived from n/k of the aggregated window (handled upstream in aggregation).
    // Cohort() queries (non-exact):
    //   - evidence MUST be sliced to the cohort() window in the DSL (design.md §4.8, §5.3).
    //
    let valuesWithEvidence = values;
    
    // EXACT MATCH PATH: Use header n/k for evidence (most authoritative source)
    if (isExactMatch && values[0].n !== undefined && values[0].k !== undefined && values[0].n > 0) {
      const exactN = values[0].n;
      const exactK = values[0].k;
      const evidenceMean = exactK / exactN;
      const evidenceStdev = Math.sqrt((evidenceMean * (1 - evidenceMean)) / exactN);
      
      valuesWithEvidence = values.map((v) => {
        const existingEvidence: any = (v as any).evidence || {};
        return {
          ...v,
          evidence: {
            ...existingEvidence,
            n: exactN,
            k: exactK,
            mean: evidenceMean,
            stdev: evidenceStdev,
          },
        } as ParameterValue;
      });
    } else if (isCohortQuery && parsedTarget?.cohort?.start && parsedTarget.cohort.end) {
      // Cohort-based evidence: restrict to cohorts within the requested cohort() window.
      const queryDate = new Date();
      const allCohorts = aggregateCohortData(values, queryDate);
      
      // Resolve cohort window bounds to UK dates and normalise
      const startResolved = resolveRelativeDate(parsedTarget.cohort.start);
      const endResolved = resolveRelativeDate(parsedTarget.cohort.end);
      const startUK = normalizeToUK(startResolved);
      const endUK = normalizeToUK(endResolved);
      
      const filteredCohorts = allCohorts.filter(c =>
        isDateInRange(
          normalizeDate(c.date),
          { start: startUK, end: endUK }
        )
      );
      
      const totalN = filteredCohorts.reduce((sum, c) => sum + c.n, 0);
      const totalK = filteredCohorts.reduce((sum, c) => sum + c.k, 0);
      
      if (totalN > 0) {
        const evidenceMean = totalK / totalN;
        const evidenceStdev = Math.sqrt((evidenceMean * (1 - evidenceMean)) / totalN);
        
        valuesWithEvidence = values.map((v) => {
          const existingEvidence: any = (v as any).evidence || {};
          return {
            ...v,
            evidence: {
              ...existingEvidence,
              n: totalN,
              k: totalK,
              mean: evidenceMean,
              stdev: evidenceStdev,
            },
          } as ParameterValue;
        });
      } else {
        // totalN === 0 can mean:
        // 1. No daily arrays present (should fall back to header n/k)
        // 2. Daily arrays exist but query window doesn't match (should leave evidence unchanged)
        const hasDailyArrays = values.some(v => v.dates && v.n_daily && v.k_daily && v.dates.length > 0);
        
        if (!hasDailyArrays) {
          // No daily cohort arrays found - fall back to header-level n/k if present
          // This handles param files that have flat n/k totals without dates/n_daily/k_daily arrays
          // (design.md §4.8: evidence.mean = Σk/Σn should always be computable from stored data)
          const headerN = values.reduce((sum, v) => sum + (v.n || 0), 0);
          const headerK = values.reduce((sum, v) => sum + (v.k || 0), 0);
          
          if (headerN > 0) {
            const evidenceMean = headerK / headerN;
            const evidenceStdev = Math.sqrt((evidenceMean * (1 - evidenceMean)) / headerN);
            
            valuesWithEvidence = values.map((v) => {
              const existingEvidence: any = (v as any).evidence || {};
              return {
                ...v,
                evidence: {
                  ...existingEvidence,
                  n: headerN,
                  k: headerK,
                  mean: evidenceMean,
                  stdev: evidenceStdev,
                },
              } as ParameterValue;
            });
          } else {
            // Truly no usable data – leave evidence unchanged
            valuesWithEvidence = values;
          }
        } else {
          // Daily arrays exist but query window doesn't match stored data
          // Leave evidence unchanged (no valid data for requested window)
          valuesWithEvidence = values;
        }
      }
    } else {
      // Default path: evidence from each value's own n/k
      valuesWithEvidence = values.map((v) => {
        if (v.n !== undefined && v.k !== undefined && v.n > 0) {
          const evidenceMean = v.k / v.n;
          const evidenceStdev = Math.sqrt((evidenceMean * (1 - evidenceMean)) / v.n);
          const existingEvidence: any = (v as any).evidence || {};
          
          return {
            ...v,
            evidence: {
              ...existingEvidence,
              // Do not clobber existing values if already present
              n: existingEvidence.n !== undefined ? existingEvidence.n : v.n,
              k: existingEvidence.k !== undefined ? existingEvidence.k : v.k,
              mean: existingEvidence.mean !== undefined ? existingEvidence.mean : evidenceMean,
              stdev: existingEvidence.stdev !== undefined ? existingEvidence.stdev : evidenceStdev,
            },
          } as ParameterValue;
        }
        return v;
      });
    }
    
    // === 1b) Window() super-range correction for from-file fixtures ===
    //
    // For window() queries where the requested window FULLY CONTAINS the stored
    // base window slice (e.g. query=window(24-Nov-25:2-Dec-25) vs stored
    // window(25-Nov-25:1-Dec-25)), evidence should reflect the FULL stored
    // slice totals, not a partial subset of daily arrays.
    //
    // This aligns with design.md and cohort-window-fixes.md §2.1:
    // - Missing days outside the stored window are treated as gaps, not zeros.
    // - Evidence totals for super-range queries should equal the base window totals.
    const hasWindowConstraint = !!parsedTarget?.window?.start && !!parsedTarget.window?.end;
    if (!isCohortQuery && hasWindowConstraint && originalParamData?.values && Array.isArray(originalParamData.values)) {
      try {
        const targetDims = extractSliceDimensions(targetSlice || '');
        const originalValues = originalParamData.values as ParameterValue[];

        // Find base window slices matching the same context/case dimensions
        const baseWindowCandidates = originalValues.filter((v) => {
          if (!v.sliceDSL || !v.sliceDSL.includes('window(')) return false;
          const dims = extractSliceDimensions(v.sliceDSL);
          return dims === targetDims && v.n !== undefined && v.k !== undefined && v.window_from && v.window_to;
        });

        if (baseWindowCandidates.length > 0) {
          // Use the most recent base window slice (by retrieved_at / window_to)
          const baseWindow = [...baseWindowCandidates].sort((a, b) => {
            const aDate = a.data_source?.retrieved_at || a.window_to || '';
            const bDate = b.data_source?.retrieved_at || b.window_to || '';
            return bDate.localeCompare(aDate);
          })[0];

          const qStart = parseDate(resolveRelativeDate(parsedTarget.window!.start!));
          const qEnd = parseDate(resolveRelativeDate(parsedTarget.window!.end!));
          const baseStart = parseDate(baseWindow.window_from!);
          const baseEnd = parseDate(baseWindow.window_to!);

          const isSuperWindow =
            qStart.getTime() <= baseStart.getTime() &&
            qEnd.getTime() >= baseEnd.getTime();

          if (isSuperWindow && baseWindow.n && baseWindow.k && baseWindow.n > 0) {
            const evidenceMean = baseWindow.k / baseWindow.n;
            const evidenceStdev = Math.sqrt((evidenceMean * (1 - evidenceMean)) / baseWindow.n);

            valuesWithEvidence = (valuesWithEvidence as ParameterValue[]).map((v) => {
              const existingEvidence: any = (v as any).evidence || {};
              return {
                ...v,
                evidence: {
                  ...existingEvidence,
                  // Super-window should use FULL base window totals
                  mean: evidenceMean,
                  stdev: evidenceStdev,
                },
              } as ParameterValue;
            });
          }
        }
      } catch (e) {
        console.warn('[DataOperationsService] Window super-range evidence adjustment failed:', e);
      }
    }
    
    let nextAggregated: any = {
      ...aggregatedData,
      values: valuesWithEvidence,
    };
    
    // === 2) Forecast scalars for cohort() queries (copy from matching window() slice) ===
    if (targetSlice && originalParamData?.values && Array.isArray(originalParamData.values)) {
      if (isCohortQuery) {
        const targetDims = extractSliceDimensions(targetSlice);
        const originalValues = originalParamData.values as ParameterValue[];
        
        // Find window() slices in the same param file with matching context/case dimensions
        const windowCandidates = originalValues.filter((v) => {
          if (!v.sliceDSL) return false;
          const parsed = parseConstraints(v.sliceDSL);
          const hasWindow = !!parsed.window;
          const hasCohort = !!parsed.cohort;
          if (!hasWindow || hasCohort) return false;
          
          const dims = extractSliceDimensions(v.sliceDSL);
          return dims === targetDims && (v as any).forecast !== undefined;
        });
        
        if (windowCandidates.length > 0) {
          // Prefer most recent window slice by retrieved_at / window_to (same strategy as aggregation)
          const bestWindow = [...windowCandidates].sort((a, b) => {
            const aDate = a.data_source?.retrieved_at || a.window_to || '';
            const bDate = b.data_source?.retrieved_at || b.window_to || '';
            return bDate.localeCompare(aDate);
          })[0] as any;
          
          const forecastValue = bestWindow.forecast;
          const nBaseline = bestWindow.n; // Sample size behind the forecast
          
          if (forecastValue !== undefined) {
            nextAggregated = {
              ...nextAggregated,
              values: (nextAggregated.values as ParameterValue[]).map((v: any) => {
                // Do not overwrite an existing forecast on the value
                if (v.forecast !== undefined) return v;
                
                // === FORECAST BLEND (forecast-fix.md) ===
                // If we have completeness and evidence, compute blended p.mean
                const completeness = v.latency?.completeness;
                const evidenceMean = v.evidence?.mean;
                const nQuery = v.n;
                
                let blendedMean: number | undefined;
                if (
                  completeness !== undefined &&
                  evidenceMean !== undefined &&
                  nQuery !== undefined &&
                  nQuery > 0 &&
                  nBaseline !== undefined &&
                  nBaseline > 0
                ) {
                  // w_evidence = (c * n_q) / (λ * n_baseline + c * n_q)
                  const nEff = completeness * nQuery;
                  const m0 = FORECAST_BLEND_LAMBDA * nBaseline;
                  const wEvidence = nEff / (m0 + nEff);
                  
                  // p.mean = w_evidence * p.evidence + (1 - w_evidence) * p.forecast
                  blendedMean = wEvidence * evidenceMean + (1 - wEvidence) * forecastValue;
                  
                  console.log('[addEvidenceAndForecastScalars] Computed forecast blend:', {
                    completeness,
                    nQuery,
                    nBaseline,
                    lambda: FORECAST_BLEND_LAMBDA,
                    nEff,
                    m0,
                    wEvidence: wEvidence.toFixed(3),
                    evidenceMean: evidenceMean.toFixed(3),
                    forecastMean: forecastValue.toFixed(3),
                    blendedMean: blendedMean.toFixed(3),
                  });
                }
                
                return {
                  ...v,
                  forecast: forecastValue,
                  // Update mean to blended value if computed
                  ...(blendedMean !== undefined ? { mean: blendedMean } : {}),
                };
              }),
            };
          }
        } else {
          // === 2b) FORECAST FALLBACK: Compute from cohort data when no window baseline exists ===
          // (design.md §3.3.3 - Cohort-only forecast fallback)
          //
          // If no window() slice is available, we can estimate p_infinity from mature cohorts
          // in the cohort data itself. This is less reliable than window-based forecast but
          // better than having no forecast at all.
          //
          // Strategy: Use the statisticalEnhancementService.estimatePInfinity on mature cohorts.
          try {
            const queryDate = new Date();
            const allCohorts = aggregateCohortData(valuesWithEvidence as ParameterValue[], queryDate);
            
            // Get lag stats and maturity for fallback forecast
            const lagStats = aggregateLatencyStats(allCohorts);
            const aggregateMedianLag = lagStats?.median_lag_days;
            const aggregateMeanLag = lagStats?.mean_lag_days;
            
            // We need maturity_days to compute t95 - look for it in latency config of the values
            // or use a default based on lag stats
            const firstValueWithLatency = (valuesWithEvidence as ParameterValue[]).find(
              (v: any) => v.latency?.maturity_days || originalParamData?.latency?.maturity_days
            ) as any;
            const maturityDays = firstValueWithLatency?.latency?.maturity_days 
              || originalParamData?.latency?.maturity_days 
              || (aggregateMedianLag ? Math.ceil(aggregateMedianLag * 5) : undefined);
            
            // Guard: if we don't have a valid median lag OR maturity, skip cohort fallback entirely
            if (
              allCohorts.length > 0 &&
              aggregateMedianLag !== undefined &&
              Number.isFinite(aggregateMedianLag) &&
              maturityDays !== undefined &&
              Number.isFinite(maturityDays)
            ) {
              // Get path_t95 for downstream edges (if available)
              const pathT95ForFallback = originalParamData?.latency?.path_t95 ?? 0;
              
              // computeEdgeLatencyStats is imported at the top of the file
              const latencyStats = computeEdgeLatencyStats(
                allCohorts,
                aggregateMedianLag,
                aggregateMeanLag,
                maturityDays,
                pathT95ForFallback
              );
              
              if (latencyStats.forecast_available && latencyStats.p_infinity !== undefined) {
                // Compute n_baseline from mature cohorts (age >= maturityDays)
                const matureCohorts = allCohorts.filter(c => c.age >= maturityDays);
                const nBaselineFallback = matureCohorts.reduce((sum, c) => sum + c.n, 0);
                
                console.log('[addEvidenceAndForecastScalars] Using cohort-based forecast fallback:', {
                  p_infinity: latencyStats.p_infinity,
                  t95: latencyStats.t95,
                  completeness: latencyStats.completeness,
                  cohortCount: allCohorts.length,
                  matureCohortCount: matureCohorts.length,
                  nBaselineFallback,
                  maturityDays,
                });
                
                nextAggregated = {
                  ...nextAggregated,
                  values: (nextAggregated.values as ParameterValue[]).map((v: any) => {
                    if (v.forecast !== undefined) return v;
                    
                    // === FORECAST BLEND (forecast-fix.md) – cohort fallback path ===
                    const completeness = v.latency?.completeness ?? latencyStats.completeness;
                    const evidenceMean = v.evidence?.mean;
                    const nQuery = v.n;
                    const forecastValue = latencyStats.p_infinity!;
                    
                    let blendedMean: number | undefined;
                    if (
                      completeness !== undefined &&
                      evidenceMean !== undefined &&
                      nQuery !== undefined &&
                      nQuery > 0 &&
                      nBaselineFallback > 0
                    ) {
                      const nEff = completeness * nQuery;
                      const m0 = FORECAST_BLEND_LAMBDA * nBaselineFallback;
                      const wEvidence = nEff / (m0 + nEff);
                      blendedMean = wEvidence * evidenceMean + (1 - wEvidence) * forecastValue;
                      
                      console.log('[addEvidenceAndForecastScalars] Computed forecast blend (cohort fallback):', {
                        completeness,
                        nQuery,
                        nBaselineFallback,
                        wEvidence: wEvidence.toFixed(3),
                        evidenceMean: evidenceMean.toFixed(3),
                        forecastMean: forecastValue.toFixed(3),
                        blendedMean: blendedMean.toFixed(3),
                      });
                    }
                    
                    return {
                      ...v,
                      forecast: forecastValue,
                      ...(blendedMean !== undefined ? { mean: blendedMean } : {}),
                    };
                  }),
                };
              }
            }
          } catch (fallbackError) {
            console.warn('[addEvidenceAndForecastScalars] Cohort forecast fallback failed:', fallbackError);
            // Continue without fallback forecast
          }
        }
      }
    }
    
    return nextAggregated;
  }
}

// Singleton instance
export const dataOperationsService = new DataOperationsService();

// =============================================================================
// Test Harness: Expose private methods for unit testing
// =============================================================================

/**
 * Test-only harness that exposes private methods for testing.
 * 
 * WARNING: This is ONLY for unit tests. Do NOT use in production code.
 * The methods exposed here may change without notice.
 */
export const __test_only__ = {
  /**
   * Exposes addEvidenceAndForecastScalars for testing evidence/forecast
   * computation without going through the full getParameterFromFile flow.
   */
  addEvidenceAndForecastScalars: (
    aggregatedData: any,
    originalParamData: any,
    targetSlice: string | undefined
  ) => (dataOperationsService as any).addEvidenceAndForecastScalars(
    aggregatedData,
    originalParamData,
    targetSlice
  ),
};

