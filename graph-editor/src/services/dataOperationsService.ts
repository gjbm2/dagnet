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
  aggregateCohortData,
  aggregateWindowData,
  aggregateLatencyStats,
  isCohortModeValue,
  type TimeSeriesPointWithLatency,
} from './windowAggregationService';
import {
  shouldRefetch,
  analyzeSliceCoverage,
  computeFetchWindow,
  computeEffectiveMaturity,
  type RefetchDecision,
  type LatencyConfig,
} from './fetchRefetchPolicy';
import { computeCohortRetrievalHorizon } from './cohortRetrievalHorizon';
import { 
  statisticalEnhancementService,
} from './statisticalEnhancementService';
import { approximateLogNormalSumPercentileDays, fitLagDistribution } from './statisticalEnhancementService';
import type { ParameterValue } from '../types/parameterData';
import type { TimeSeriesPoint } from '../types';
import { buildScopedParamsFromFlatPack, ParamSlot } from './ParamPackDSLService';
import { isolateSlice, extractSliceDimensions, hasContextAny } from './sliceIsolation';
import { resolveMECEPartitionForImplicitUncontexted, resolveMECEPartitionForImplicitUncontextedSync } from './meceSliceService';
import { findBestMECEPartitionCandidateSync, parameterValueRecencyMs, selectImplicitUncontextedSliceSetSync } from './meceSliceService';
import { sessionLogService } from './sessionLogService';
import { isSignatureCheckingEnabled, isSignatureWritingEnabled } from './signaturePolicyService';
import { forecastingSettingsService } from './forecastingSettingsService';
import { normalizeConstraintString, parseConstraints, parseDSL } from '../lib/queryDSL';
import { contextRegistry } from './contextRegistry';
import { normalizeToUK, formatDateUK, parseUKDate, resolveRelativeDate } from '../lib/dateFormat';
import { rateLimiter } from './rateLimiter';
import { buildDslFromEdge } from '../lib/das/buildDslFromEdge';
import { createDASRunner } from '../lib/das';
import { db } from '../db/appDatabase';
import { RECENCY_HALF_LIFE_DAYS, DEFAULT_T95_DAYS } from '../constants/latency';
import { normalizeWindow } from './fetchDataService';
import { LATENCY_T95_PERCENTILE, LATENCY_PATH_T95_PERCENTILE } from '../constants/latency';

export type PermissionCopyMode = 'copy_all' | 'copy_if_false' | 'do_not_copy';
export interface PutToFileCopyOptions {
  includeValues?: boolean;
  includeMetadata?: boolean;
  permissionsMode?: PermissionCopyMode;
}

export interface GetFromFileCopyOptions {
  /**
   * If true, copy scalar/value fields from file → graph.
   * Default true for explicit GET.
   */
  includeValues?: boolean;
  /**
   * If true, copy metadata/config fields from file → graph (query/connection/latency config/etc).
   * Default true for explicit GET.
   */
  includeMetadata?: boolean;
  /**
   * Controls copying of permission flags (override flags) from file → graph.
   * Default do_not_copy to avoid unexpected permission changes.
   */
  permissionsMode?: PermissionCopyMode;
}

/**
 * Cache analysis result - reported immediately after cache check, before any API fetch.
 * Used by retrieve-all to show real-time progress ("fetching 5d across 2 gaps").
 */
export interface CacheAnalysisResult {
  /** True if all requested data is fully cached (no API call needed) */
  cacheHit: boolean;
  /** Number of days that need to be fetched from API (0 if cache hit) */
  daysToFetch: number;
  /** Number of contiguous gaps in the cache (0 if cache hit) */
  gapCount: number;
  /** Number of days already available from cache */
  daysFromCache: number;
  /** Total days in the requested window */
  totalDays: number;
}

/**
 * Fetch windows plan for a single getFromSource call.
 *
 * Emitted after cache analysis + maturity/refetch policy resolution, immediately before any external API calls.
 * This allows batch workflows (Retrieve All) to emit a precise end-of-run “what was fetched” artefact.
 *
 * IMPORTANT:
 * - Dates are UK format (d-MMM-yy) for internal/logging use.
 * - `windows` are the *actual* chained gap windows that execution will attempt.
 */
export interface FetchWindowsPlanResult {
  /** The authoritative per-item slice DSL that drove this fetch (e.g. context(channel:paid-search).window(-100d:)) */
  targetSlice: string;
  /** Window/cohort mode for this item */
  mode: 'window' | 'cohort';
  /** The resolved requested window (UK dates) */
  requestedWindow: { start: string; end: string };
  /** Planned windows to execute (UK dates), in order */
  windows: Array<{ start: string; end: string }>;
  /** True if execution will skip external fetch (fully cached and no refetch policy forces a fetch) */
  shouldSkipFetch: boolean;
  /** Optional: refetch policy classification (if available) */
  refetchPolicyType?: string;
}

/**
 * Result from getFromSource/getFromSourceDirect with fetch statistics.
 * Used by retrieve-all to aggregate stats for summary reporting.
 */
export interface GetFromSourceResult {
  /** Whether the operation completed successfully */
  success: boolean;
  /** True if all data was served from cache (no API call made) */
  cacheHit: boolean;
  /** Number of days actually fetched from API (0 if cache hit) */
  daysFetched: number;
  /** Number of days served from cache */
  daysFromCache: number;
}

// Cached DAS runner instance for connection lookups (avoid recreating per-call)
let cachedDASRunner: ReturnType<typeof createDASRunner> | null = null;
function getCachedDASRunner() {
  if (!cachedDASRunner) {
    cachedDASRunner = createDASRunner();
  }
  return cachedDASRunner;
}

function toISOWindowForDAS(window: DateRange): { start?: string; end?: string; [key: string]: unknown } {
  // CRITICAL: keep UK dates internally/logging, but DAS adapters expect ISO strings here.
  // If we pass "6-Dec-25", the Amplitude adapter will produce "6Dec25" (invalid).
  const start = window.start ? parseDate(window.start).toISOString() : undefined;
  const end = window.end ? parseDate(window.end).toISOString() : undefined;
  return { start, end };
}

/**
 * Batch mode flag - when true, suppresses individual toasts during batch operations
 * Set this before starting a batch operation and reset it after
 */
let batchModeActive = false;

/** Enable batch mode to suppress individual toasts */
export function setBatchMode(active: boolean): void {
  // When ending a batch, flush the aggregated toast + session log summary once.
  if (batchModeActive && !active) {
    // Ensure any lingering "data fetch" spinner toast is closed out at the end of a batch.
    // In batch mode, some paths may show a toast.loading with a fixed id (e.g. 'das-fetch'),
    // while success/error toasts are suppressed/buffered. Without this, the spinner can stick.
    try {
      const t: any = toast as any;
      if (typeof t?.dismiss === 'function') {
        t.dismiss('das-fetch');
      }
    } catch {
      // ignore
    }
    flushBatchToasts();
  }
  batchModeActive = active;
}

/** Check if batch mode is active */
export function isBatchMode(): boolean {
  return batchModeActive;
}

type BatchToastKind = 'success' | 'error' | 'info';
type BatchToastEntry = { kind: BatchToastKind; message: string };

let batchToastBuffer: BatchToastEntry[] = [];

function recordBatchToast(kind: BatchToastKind, message: string): void {
  batchToastBuffer.push({ kind, message });
}

function flushBatchToasts(): void {
  if (!batchToastBuffer.length) return;

  const entries = batchToastBuffer;
  batchToastBuffer = [];

  const successes = entries.filter(e => e.kind === 'success').map(e => e.message);
  const errors = entries.filter(e => e.kind === 'error').map(e => e.message);
  const infos = entries.filter(e => e.kind === 'info').map(e => e.message);

  const successCount = successes.length;
  const errorCount = errors.length;
  const infoCount = infos.length;

  // Single toast summary for the whole batch.
  if (errorCount > 0) {
    toast.error(`Updated ${successCount} item${successCount === 1 ? '' : 's'}; ${errorCount} failed`);
  } else if (successCount > 0) {
    toast.success(`Updated ${successCount} item${successCount === 1 ? '' : 's'}`);
  } else {
    toast.success(`Batch complete (${infoCount} update${infoCount === 1 ? '' : 's'})`);
  }

  // Mirror detail into session log (so details are not lost when we suppress per-item toasts).
  // Keep the detail compact; session log can store a multi-line payload.
  const detailLines: string[] = [];
  if (successCount) {
    detailLines.push('Updated:');
    detailLines.push(...successes.map(s => `- ${s}`));
  }
  if (errorCount) {
    detailLines.push('Failed:');
    detailLines.push(...errors.map(s => `- ${s}`));
  }
  if (infoCount && !successCount && !errorCount) {
    detailLines.push('Info:');
    detailLines.push(...infos.map(s => `- ${s}`));
  }
  sessionLogService.success(
    'file',
    'BATCH_FILE_UPDATES',
    `Batch updates: ${successCount} updated, ${errorCount} failed`,
    detailLines.join('\n'),
    { successCount, errorCount, infoCount }
  );
}

/** Wrapper for toast that respects batch mode */
function batchableToast(message: string, options?: any): string | void {
  if (batchModeActive) {
    recordBatchToast('info', message);
    return;
  }
  return toast(message, options);
}

/** Wrapper for toast.success that respects batch mode */
function batchableToastSuccess(message: string, options?: any): string | void {
  if (batchModeActive) {
    recordBatchToast('success', message);
    return;
  }
  return toast.success(message, options);
}

/** Wrapper for toast.error that respects batch mode */
function batchableToastError(message: string, options?: any): string | void {
  if (batchModeActive) {
    recordBatchToast('error', message);
    return;
  }
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
  edge?: any,
  contextKeys?: string[],
  workspace?: { repository: string; branch: string }
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
    
    const sortPrimitiveArray = (items: unknown[]): unknown[] => {
      if (items.every(v => typeof v === 'string')) {
        return [...(items as string[])].sort();
      }
      if (items.every(v => typeof v === 'number')) {
        return [...(items as number[])].sort((a, b) => a - b);
      }
      return items;
    };

    const normalizeObjectKeys = (obj: Record<string, any>): Record<string, any> => {
      const out: Record<string, any> = {};
      Object.keys(obj).sort().forEach((k) => {
        const v = obj[k];
        if (Array.isArray(v)) {
          out[k] = v.map((item) => (item && typeof item === 'object' ? normalizeObjectKeys(item) : item));
        } else if (v && typeof v === 'object') {
          out[k] = normalizeObjectKeys(v);
        } else {
          out[k] = v;
        }
      });
      return out;
    };

    const normalizeContextDefinition = (ctx: any): Record<string, any> => {
      const values = Array.isArray(ctx?.values) ? [...ctx.values] : [];
      const normalizedValues = values
        .map((v: any) => ({
          id: v.id,
          label: v.label,
          description: v.description,
          order: v.order,
          aliases: Array.isArray(v.aliases) ? sortPrimitiveArray(v.aliases) : v.aliases,
          sources: v.sources ? normalizeObjectKeys(v.sources) : v.sources,
        }))
        .sort((a: any, b: any) => String(a.id ?? '').localeCompare(String(b.id ?? '')));

      const metadata = ctx?.metadata ? normalizeObjectKeys(ctx.metadata) : ctx?.metadata;

      return normalizeObjectKeys({
        id: ctx?.id,
        name: ctx?.name,
        description: ctx?.description,
        type: ctx?.type,
        otherPolicy: ctx?.otherPolicy ?? 'undefined',
        values: normalizedValues,
        metadata,
      });
    };

    const hashText = async (canonical: string): Promise<string> => {
      const encoder = new TextEncoder();
      const data = encoder.encode(canonical);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    };

    const payloadContextKeys = Array.isArray(queryPayload?.context)
      ? queryPayload.context.map((c: any) => c?.key).filter(Boolean)
      : [];
    const allContextKeys = Array.from(new Set([...(contextKeys || []), ...payloadContextKeys]))
      .map((k) => String(k))
      .sort();

    const contextHashes = await Promise.all(
      allContextKeys.map(async (key) => {
        try {
          const ctx = await contextRegistry.getContext(key, workspace ? { workspace } : undefined);
          if (!ctx) {
            return { key, hash: 'missing', status: 'missing' };
          }
          const normalized = normalizeContextDefinition(ctx);
          const ctxHash = await hashText(JSON.stringify(normalized));
          return { key, hash: ctxHash, status: 'ok' };
        } catch (error) {
          console.warn('[computeQuerySignature] Failed to hash context definition:', { key, error });
          return { key, hash: 'error', status: 'error' };
        }
      })
    );

    // Normalize original query string for signature purposes.
    //
    // CRITICAL DESIGN RULE:
    // - Signature MUST include context *definition* hashes (so it changes when the context YAML changes)
    // - Signature MUST NOT vary by context *value* (e.g. channel:paid-search vs channel:other)
    //   because slice identity already carries the value and MECE fulfilment relies on stable semantics.
    //
    // Therefore we strip `.context(...)` / `.contextAny(...)` and explicit window/cohort bounds from the
    // original query string before hashing. We still preserve minus()/plus()/visited()/exclude() structure.
    const normalizeOriginalQueryForSignature = (q: string): string => {
      if (!q) return '';
      let out = String(q);
      // Remove trailing/embedded context constraints.
      out = out.replace(/\.contextAny\([^)]*\)/g, '');
      out = out.replace(/\.context\([^)]*\)/g, '');
      // Remove explicit window/cohort bounds if present on the edge query (rare but possible).
      // Bounds must not affect signature; cache coverage is proven via header ranges.
      out = out.replace(/\.window\([^)]*\)/g, '');
      out = out.replace(/\.cohort\([^)]*\)/g, '');
      // Collapse whitespace and repeated dots from removals.
      out = out.replace(/\s+/g, ' ').trim();
      out = out.replace(/\.\./g, '.');
      // Remove trailing dot.
      out = out.replace(/\.$/, '');
      return out;
    };

    const rawOriginalQuery = edge?.query || '';
    const originalQueryForSignature = normalizeOriginalQueryForSignature(rawOriginalQuery);

    // Create a canonical representation of the query.
    // Include event_ids and original query string to detect topology changes.
    // Include context hashes for the ENTIRE context key definition (not per-value filters).
    //
    // Latency / cohort semantics:
    // - Cohort mode (A-anchored) changes the external query shape.
    // - Anchor identity changes the query semantics.
    // - Conversion window days (derived from latency horizon / path) changes provider query parameters.
    //
    // IMPORTANT: We intentionally do NOT include cohort/`window date bounds here.
    // Those bounds are stored on each cached value entry (window_from/window_to or cohort_from/cohort_to),
    // and including them in the signature would defeat incremental re-use for daily caches.
    const edgeLatency = edge?.p?.latency;
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
      context_keys: allContextKeys,
      context_hashes: contextHashes,
      case: (queryPayload.case || []).sort(),
      // Cohort / latency semantics (exclude bounds, include shape + anchor + conversion window)
      cohort_mode: !!queryPayload.cohort,
      cohort_anchor_event_id: queryPayload?.cohort?.anchor_event_id || '',
      // Edge latency primitives (include anchor node id and enablement as semantic inputs)
      latency_parameter: edgeLatency?.latency_parameter === true,
      anchor_node_id: edgeLatency?.anchor_node_id || '',
      // IMPORTANT: Include normalized original query string to capture minus()/plus()/visited()/exclude()
      // terms which are NOT preserved in the DSL object by buildDslFromEdge.
      // This MUST NOT include context/window/cohort bounds (see normalization above).
      original_query: originalQueryForSignature,
    });
    
    // Compute SHA-256 hash
    const hashHex = await hashText(canonical);
    
    // ===== DIAGNOSTIC: Show what went into the signature =====
    console.log('[computeQuerySignature] Signature computed:', {
      signature: hashHex.substring(0, 12) + '...',
      originalQuery: rawOriginalQuery || 'N/A',
      normalizedOriginalQuery: originalQueryForSignature || 'N/A',
      hasMinus: rawOriginalQuery.includes('.minus('),
      hasPlus: rawOriginalQuery.includes('.plus('),
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

function extractContextKeysFromConstraints(constraints?: {
  context?: Array<{ key: string }>;
  contextAny?: Array<{ pairs: Array<{ key: string }> }>;
} | null): string[] {
  if (!constraints) return [];
  const keys = new Set<string>();
  for (const ctx of constraints.context || []) {
    if (ctx?.key) keys.add(ctx.key);
  }
  for (const ctxAny of constraints.contextAny || []) {
    for (const pair of ctxAny?.pairs || []) {
      if (pair?.key) keys.add(pair.key);
    }
  }
  return Array.from(keys).sort();
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
    suppressMissingDataToast?: boolean; // If true, don't show toast about missing days (e.g., after fetch from source - user knows data may be incomplete)
    conditionalIndex?: number; // For conditional_p entries - which index to update
    /** Back-compat: if true, copy permission flags (override flags) from file → graph. Defaults to false. */
    includePermissions?: boolean;
    /** New: explicit copy options for GET-from-file */
    copyOptions?: GetFromFileCopyOptions;
  }): Promise<{ success: boolean; warning?: string }> {
    const timingStart = performance.now();
    const timings: Record<string, number> = {};
    const markTime = (label: string) => {
      timings[label] = performance.now() - timingStart;
    };
    
    const { paramId, edgeId, graph, setGraph, setAutoUpdating, window: explicitWindow, targetSlice = '', suppressSignatureWarning = false, suppressMissingDataToast = false, conditionalIndex } = options;

    const includeValues = options.copyOptions?.includeValues !== false;
    const includeMetadata = options.copyOptions?.includeMetadata !== false;
    const permissionsMode: PermissionCopyMode = options.copyOptions?.permissionsMode
      ?? (options.includePermissions === true ? 'copy_all' : 'do_not_copy');

    // Whether we copy any permission flags at all.
    const includePermissions = permissionsMode !== 'do_not_copy';
    
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
      const todayUK = formatDateUK(new Date());

      if (parsed.cohort?.start) {
        cohortWindow = {
          start: resolveRelativeDate(parsed.cohort.start),
          end: resolveRelativeDate(parsed.cohort.end ?? todayUK),
        };
        isCohortQuery = true;
        console.log('[DataOperationsService] Parsed cohort window from DSL:', cohortWindow);
      }
      
      // Also check for window() - observation window (may also be present for dual-slice queries)
      if (!window && parsed.window?.start) {
        window = {
          start: resolveRelativeDate(parsed.window.start),
          end: resolveRelativeDate(parsed.window.end ?? todayUK),
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
      let paramFile = fileRegistry.getFile(`parameter-${paramId}`);
      markTime('getFile');
      if (!paramFile) {
        // Share/live boot can seed IndexedDB before FileRegistry is hydrated.
        // Since IndexedDB is the source of truth, attempt to restore the file from IDB on-demand.
        try {
          await fileRegistry.restoreFile(`parameter-${paramId}`);
          paramFile = fileRegistry.getFile(`parameter-${paramId}`);
        } catch {
          // ignore
        }
      }
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
          const normalizedTargetSlice = normalizeConstraintString(targetSlice);
          const exactMatches = allValues.filter(v => {
            if (!v.sliceDSL) return false;
            return normalizeConstraintString(v.sliceDSL) === normalizedTargetSlice;
          });
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
            const desiredMode: 'cohort' | 'window' | null =
              wantsCohort ? 'cohort' : (wantsWindow ? 'window' : null);

            // Narrow candidate set to the SAME slice function family:
            // - cohort() queries should only see cohort slices
            // - window() queries should only see window slices
            // This prevents accidental mixing of cohort/window data when both
            // exist in the same parameter file (dual-slice latency files).
            let candidateValues: ParameterValue[] = allValues;
            if (desiredMode === 'cohort') {
              candidateValues = allValues.filter(v => isCohortModeValue(v));
            } else if (desiredMode === 'window') {
              candidateValues = allValues.filter(v => !isCohortModeValue(v));
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
            
            if (isUncontextedQuery && hasContextedData) {
              // Implicit uncontexted can be satisfied by either:
              // - An explicit uncontexted slice (dims == '')
              // - A complete MECE partition over a single context key (e.g. channel)
              //
              // Selection rule (user-specified): pick the MOST RECENT matching slice-set.
              // - explicit uncontexted recency = max(retrieved_at)
              // - MECE recency = min(retrieved_at) across the MECE slices (set freshness = stalest member)

              const selection = selectImplicitUncontextedSliceSetSync({
                candidateValues,
                requireCompleteMECE: true,
              });

              if (selection.kind === 'mece_partition') {
                sliceFilteredValues = selection.values;
                console.log('[DataOperationsService] Implicit uncontexted: chose MECE slice-set by recency', {
                  targetSlice,
                  meceKey: selection.key,
                  meceQuerySignature: selection.querySignature,
                  meceRecencyMs: selection.diagnostics.meceRecencyMs,
                  uncontextedRecencyMs: selection.diagnostics.uncontextedRecencyMs,
                  counts: selection.diagnostics.counts,
                  warnings: selection.diagnostics.warnings,
                });
              } else if (selection.kind === 'explicit_uncontexted') {
                sliceFilteredValues = selection.values;
                console.log('[DataOperationsService] Implicit uncontexted: chose explicit uncontexted slice by recency', {
                  targetSlice,
                  uncontextedRecencyMs: selection.diagnostics.uncontextedRecencyMs,
                  hasMECECandidate: selection.diagnostics.hasMECECandidate,
                  meceKey: selection.diagnostics.meceKey,
                  meceQuerySignature: selection.diagnostics.meceQuerySignature,
                  meceRecencyMs: selection.diagnostics.meceRecencyMs,
                  counts: selection.diagnostics.counts,
                  warnings: selection.diagnostics.warnings,
                });
              } else {
                // No explicit uncontexted, no usable complete MECE → refuse
                const reason = selection.reason;
                console.warn('[DataOperationsService] Cannot satisfy implicit uncontexted query from cache', { targetSlice, reason });
                toast(`Cannot compute uncontexted total from cached slices: ${reason}`, { icon: '⚠️', duration: 4000 });
                sessionLogService.endOperation(logOpId, 'warning', `Cannot compute implicit uncontexted total: ${reason}`);
                return { success: false, warning: `Cannot compute implicit uncontexted total: ${reason}` };
              }
            } else {
              // Standard path: use isolateSlice (handles contextAny and specific context queries)
              sliceFilteredValues = isolateSlice(candidateValues, targetSlice);
            }
          }
          
          if (sliceFilteredValues.length > 0) {
            // For uncontexted queries, ensure we don't accidentally "mix" multiple cached uncontexted entries.
            // If multiple uncontexted entries match, use the most recent one.
            const targetDims = extractSliceDimensions(targetSlice);
            const isUncontexted = targetDims === '' && !hasContextAny(targetSlice);
            if (isUncontexted && sliceFilteredValues.length > 1) {
              // IMPORTANT: Do NOT collapse a MECE slice-set (contexted slices) down to one slice.
              // Only collapse when the matched entries are themselves uncontexted (dims == '').
              const allMatchedAreUncontexted = sliceFilteredValues.every(v => extractSliceDimensions(v.sliceDSL ?? '') === '');
              if (allMatchedAreUncontexted) {
                const best = sliceFilteredValues.reduce((best, cur) => (parameterValueRecencyMs(cur) > parameterValueRecencyMs(best) ? cur : best));
                sliceFilteredValues = [best];
              }
            }
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
        const parsedTargetForMode = targetSlice ? parseConstraints(targetSlice) : null;
        const desiredAggregationMode: 'cohort' | 'window' | null =
          parsedTargetForMode?.cohort ? 'cohort' : (parsedTargetForMode?.window ? 'window' : null);

        const isExactStoredSliceByBounds = (v: ParameterValue): boolean => {
          if (desiredAggregationMode === 'cohort') {
            if (!cohortWindow) return false;
            if (!isCohortModeValue(v)) return false;
            const from = v.cohort_from ? normalizeDate(v.cohort_from) : undefined;
            const to = v.cohort_to ? normalizeDate(v.cohort_to) : undefined;
            const wantFrom = normalizeDate(cohortWindow.start);
            const wantTo = normalizeDate(cohortWindow.end);
            return !!from && !!to && from === wantFrom && to === wantTo;
          }
          if (desiredAggregationMode === 'window') {
            if (!window) return false;
            if (isCohortModeValue(v)) return false;
            const from = v.window_from ? normalizeDate(v.window_from) : undefined;
            const to = v.window_to ? normalizeDate(v.window_to) : undefined;
            const wantFrom = normalizeDate(window.start);
            const wantTo = normalizeDate(window.end);
            return !!from && !!to && from === wantFrom && to === wantTo;
          }
          return false;
        };
        // Exact stored time slice:
        // - Applies when targetSlice explicitly includes a window() OR cohort()
        //   and matches the stored sliceDSL 1:1.
        // - Pure context slices (e.g. context(channel:google)) with an external
        //   window parameter MUST still go through aggregation so that evidence
        //   reflects the requested sub-window inside the cached slice.
        const isExactTimeSlice =
          aggValues.length === 1 &&
          !!targetSlice &&
          (targetSlice.includes('window(') || targetSlice.includes('cohort(')) &&
          ((!!aggValues[0].sliceDSL && normalizeConstraintString(aggValues[0].sliceDSL) === normalizeConstraintString(targetSlice)) || isExactStoredSliceByBounds(aggValues[0]));

        // IMPORTANT (design + tests):
        // - For window() queries, we aggregate so evidence reflects the requested window,
        //   and so non-latency edges use query-time evidence for p.mean.
        // - For cohort() queries, we may skip aggregation on exact matches to avoid relying
        //   on sampled/incomplete daily arrays when header totals are authoritative.
        const shouldSkipAggregation =
          desiredAggregationMode === 'cohort' && isExactTimeSlice;

        if (shouldSkipAggregation) {
          console.log('[DataOperationsService] Exact cohort time slice match - skipping aggregation and using stored slice stats', {
            targetSlice,
          });
        } else {
          // Collect value entries with daily data FROM SLICE-FILTERED aggregatedData
          // CRITICAL: Use aggregatedData.values (which has been filtered above)
          // NOT paramFile.data.values (which contains ALL contexts)
          const allValuesWithDaily = (aggregatedData.values as ParameterValue[])
            .filter(v => v.n_daily && v.k_daily && v.dates && v.n_daily.length > 0)
            // HARD SAFETY: even if earlier slice filtering failed, never mix cohort/window
            // daily data when aggregating a specific targetSlice mode.
            .filter(v => {
              if (desiredAggregationMode === 'cohort') return isCohortModeValue(v);
              if (desiredAggregationMode === 'window') return !isCohortModeValue(v);
              return true;
            });
          
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
                if (isSignatureCheckingEnabled()) {
                  const signatureContextKeys = extractContextKeysFromConstraints(constraints);
                  expectedQuerySignature = await computeQuerySignature(
                    compDsl,
                    connectionName,
                    graph,
                    targetEdge,
                    signatureContextKeys
                  );
                }
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
                
                if (isSignatureCheckingEnabled()) {
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
                }
                
                // If we found a latest signature and it differs from expected, use the latest one
                // (This handles the case where event definitions changed)
                const signatureToUse = latestQuerySignature || expectedQuerySignature;
                
                if (
                  isSignatureCheckingEnabled() &&
                  (querySignatureMismatch || (latestQuerySignature && latestQuerySignature !== expectedQuerySignature))
                ) {
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
                
                // Signature validation: check staleness, but don't filter
                // (Filtering by slice already done via isolateSlice above)
                if (isSignatureCheckingEnabled() && signatureToUse) {
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
            
            // Process entries in order (newest last) so newer entries overwrite older ones.
            // When signature checking is enabled, prefer entries with matching signature.
            const sortedValues = [...valuesWithDaily].sort((a, b) => {
              // If we have an expected signature, prefer matching entries
              if (isSignatureCheckingEnabled() && expectedQuerySignature) {
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
                        // For lag data in multi-slice: keep existing behaviour here (weighted average by k).
                        // NOTE: mathematically defensible mixture-median aggregation is implemented at the cohort/window
                        // LAG aggregation layer (aggregateCohortData / aggregateWindowData), where we can operate on
                        // full per-slice component sets rather than sequentially folding.
                        const oldLag = allTimeSeries[existingIndex].median_lag_days;
                        const newLag = value.median_lag_days?.[i];
                        const combinedMedianLag =
                          oldLag !== undefined && newLag !== undefined
                            ? (oldLag * oldK + newLag * value.k_daily[i]) / newK // Weighted average by k
                            : newLag ?? oldLag;
                        const oldMeanLag = allTimeSeries[existingIndex].mean_lag_days;
                        const newMeanLag = value.mean_lag_days?.[i];
                        const combinedMeanLag =
                          oldMeanLag !== undefined && newMeanLag !== undefined
                            ? (oldMeanLag * oldK + newMeanLag * value.k_daily[i]) / newK
                            : newMeanLag ?? oldMeanLag;
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
            
            // LAG: Latency statistics are computed in a separate topo pass after all
            // fetches complete (see enhanceGraphLatencies in statisticalEnhancementService).
            // Here we just store raw data; the graph-level pass computes t95, path_t95,
            // and path-adjusted completeness with full knowledge of the graph topology.
            //
            // The graph edge's p.latency.* fields are the source of truth after the topo pass.
            
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
            // 
            // NOTE: LAG computation (completeness, t95) happens in the
            // graph-level topo pass after all fetches complete. Here we store the
            // raw evidence mean. The graph edge's p.mean will be updated by the
            // topo pass with the path-adjusted blended value.
            const isSingleExactSlice =
              !isMultiSliceAggregation &&
              sortedValues.length === 1 &&
              !!latestValueWithSource?.sliceDSL &&
              normalizeConstraintString(latestValueWithSource.sliceDSL) === normalizeConstraintString(targetSlice) &&
              // If a window filter is explicitly provided (or derived from DSL),
              // treat this as an exact slice only when the stored window bounds match.
              // Otherwise (common cache-subset case: context slice + explicit window),
              // we must use the aggregated daily totals for the requested window.
              (
                !window ||
                (
                  !isCohortQuery &&
                  !!latestValueWithSource?.window_from &&
                  !!latestValueWithSource?.window_to &&
                  normalizeDate(latestValueWithSource.window_from) === normalizeDate(window.start) &&
                  normalizeDate(latestValueWithSource.window_to) === normalizeDate(window.end)
                )
              );
            
            // For single exact slice, preserve pre-computed mean; otherwise use enhanced
            const storedMean = isSingleExactSlice && latestValueWithSource?.mean !== undefined
              ? latestValueWithSource.mean
              : enhanced.mean;
            const storedStdev = isSingleExactSlice && latestValueWithSource?.stdev !== undefined
              ? latestValueWithSource.stdev
              : enhanced.stdev;
            
            // Compute evidence scalars (raw observed rate = k/n)
            // IMPORTANT: When the query DSL exactly matches a stored sliceDSL, treat the
            // slice header totals (n/k) as authoritative (daily arrays may be sampled or
            // inconsistent). For non-exact queries, use the aggregated daily totals.
            const effectiveN = isSingleExactSlice && typeof latestValueWithSource?.n === 'number'
              ? latestValueWithSource.n
              : enhanced.n;
            const effectiveK = isSingleExactSlice && typeof latestValueWithSource?.k === 'number'
              ? latestValueWithSource.k
              : enhanced.k;
            const evidenceMean = effectiveN > 0 ? effectiveK / effectiveN : 0;
            const evidenceStdev = effectiveN > 0 
              ? Math.sqrt((evidenceMean * (1 - evidenceMean)) / effectiveN) 
              : 0;
            
            // Use the effective filter window for storing date bounds
            // For cohort queries, this is the cohort window; for window queries, it's the window
            const effectiveWindow = evidenceFilterWindow;
            
            // If the latest value already has a latency summary (from previous cohort merge),
            // preserve it on the aggregated view so UpdateManager can map it to edge.p.latency.*.
            // This is especially important for fresh latency-enabled edges, where the topo LAG
            // pass may not have run yet but the parameter already contains a valid summary.
            const latestLatencySummary = (latestValueWithSource as any)?.latency;

            const aggregatedValue = {
              // DESIGN (§5.2, Non-latency row): For non-latency edges, p.mean MUST
              // reflect the raw observed rate (Σk/Σn), not the historical stored mean.
              // For latency edges, this evidence-based mean is a safe default that
              // will later be replaced by the LAG topo pass with the blended value.
              //
              // Previous behaviour (mean: storedMean) caused a regression where
              // simple/window-only edges kept stale mastered means even when fresh
              // evidence was available. By using evidenceMean here, UpdateManager’s
              // values[latest].mean → p.mean mapping does the right thing for both:
              //   - Non-latency edges: final p.mean = evidence (no LAG pass)
              //   - Latency edges: p.mean is later overwritten by blendedMean
              //
              // BUT: if this is an exact slice match, preserve the stored aggregate mean.
              mean: isSingleExactSlice ? storedMean : evidenceMean,
              stdev: storedStdev,
              n: effectiveN,
              k: effectiveK,
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
              // Include evidence scalars for graph edge p.evidence.mean/stdev
              evidence: {
                mean: evidenceMean,
                stdev: evidenceStdev,
              },
              // Preserve any existing latency summary so values[latest].latency.* is available
              // to UpdateManager mappings (file → graph) for p.latency.median_lag_days, etc.
              ...(latestLatencySummary && { latency: latestLatencySummary }),
              // NOTE: Latency stats (t95, completeness, forecast) are computed in the
              // graph-level topo pass after all fetches complete. They are NOT stored
              // in the param file; the graph edge is the source of truth for these.
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
              evidence: {
                mean: evidenceMean,
                stdev: evidenceStdev,
                meanPercent: (evidenceMean * 100).toFixed(2) + '%',
              },
              stored: {
                mean: storedMean,
                stdev: storedStdev,
                meanPercent: (storedMean * 100).toFixed(2) + '%',
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
            });
            
            // Add session log child with aggregation details
            const slicesSummary = isMultiSliceAggregation 
              ? `${uniqueSlices.size} slices` 
              : (Array.from(uniqueSlices)[0] || 'uncontexted');
            sessionLogService.addChild(logOpId, 'info', 'AGGREGATION_RESULT',
              `Aggregated ${allTimeSeries.length} days from ${slicesSummary}: n=${enhanced.n}, k=${enhanced.k}, evidence=${(evidenceMean * 100).toFixed(1)}%`,
              `${isCohortQuery ? 'Cohort' : 'Window'}: ${normalizeToUK(evidenceFilterWindow.start)} to ${normalizeToUK(evidenceFilterWindow.end)}`,
              { 
                slices: Array.from(uniqueSlices),
                n: enhanced.n, 
                k: enhanced.k, 
                evidence_mean: evidenceMean,
                stored_mean: storedMean,
                daysAggregated: allTimeSeries.length,
                isMultiSlice: isMultiSliceAggregation,
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
              
              // Only show toast/warning if NOT coming from "get from source" path
              // (when suppressMissingDataToast=true, user already fetched from source - they know data may be incomplete)
              if (!suppressMissingDataToast) {
                message += `. Try getting from source to fetch missing data.`;
                batchableToast(message, {
                  icon: '⚠️',
                  duration: 5000,
                });
                
                // Add session log child for visibility (only when showing warning)
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
      //
      // IMPORTANT: The evidence/forecast helper is intentionally synchronous (used by unit tests).
      // Any async MECE resolution for an implicit uncontexted window baseline (for cohort forecasts)
      // is handled here, before invoking the helper.
      let paramDataForScalars: any = paramFile.data;
      try {
        const parsedForScalars = targetSlice ? parseConstraints(targetSlice) : null;
        const isCohortForScalars = !!parsedForScalars?.cohort;
        const targetDims = extractSliceDimensions(targetSlice || '');
        if (
          isCohortForScalars &&
          targetDims === '' &&
          paramFile.data?.values &&
          Array.isArray(paramFile.data.values)
        ) {
          const originalValues = paramFile.data.values as ParameterValue[];
          const hasUncontextedWindowBaseline = originalValues.some((v) => {
            if (!v.sliceDSL) return false;
            const parsed = parseConstraints(v.sliceDSL);
            if (!parsed.window || parsed.cohort) return false;
            return extractSliceDimensions(v.sliceDSL) === '';
          });

          if (!hasUncontextedWindowBaseline) {
            const allWindowValues = originalValues.filter((v) => {
              if (!v.sliceDSL) return false;
              const parsed = parseConstraints(v.sliceDSL);
              return !!parsed.window && !parsed.cohort;
            });

            const mece = await resolveMECEPartitionForImplicitUncontexted(allWindowValues);
            if (mece.kind === 'mece_partition' && mece.canAggregate) {
              // Use max(window date) as the reference date for window aggregation (not wall-clock now).
              const asOfDate = (() => {
                const maxDateFromValue = (v: any): Date | undefined => {
                  const dates: string[] | undefined = v?.dates;
                  if (Array.isArray(dates) && dates.length > 0) {
                    try {
                      const d = parseDate(dates[dates.length - 1]);
                      if (!Number.isNaN(d.getTime())) return d;
                    } catch {
                      // ignore
                    }
                  }
                  const windowTo = v?.window_to;
                  if (typeof windowTo === 'string' && windowTo.trim()) {
                    try {
                      const d = parseDate(windowTo);
                      if (!Number.isNaN(d.getTime())) return d;
                    } catch {
                      // ignore
                    }
                  }
                  return undefined;
                };
                const best =
                  mece.values
                    .map((v) => maxDateFromValue(v))
                    .filter((d): d is Date => !!d)
                    .sort((a, b) => b.getTime() - a.getTime())[0];
                return best ?? new Date();
              })();

              const cohorts = aggregateWindowData(mece.values, asOfDate);
              const dates = cohorts.map((c) => c.date);
              const nDaily = cohorts.map((c) => c.n);
              const kDaily = cohorts.map((c) => c.k);
              const totalN = nDaily.reduce((s, n) => s + n, 0);
              const totalK = kDaily.reduce((s, k) => s + k, 0);
              if (dates.length > 0) {
                const synthetic: any = {
                  sliceDSL: `window(${dates[0]}:${dates[dates.length - 1]})`,
                  window_from: dates[0],
                  window_to: dates[dates.length - 1],
                  dates,
                  n_daily: nDaily,
                  k_daily: kDaily,
                  n: totalN,
                  k: totalK,
                  mean: totalN > 0 ? totalK / totalN : 0,
                  data_source: {
                    type: 'amplitude',
                    retrieved_at: new Date().toISOString(),
                  },
                };
                paramDataForScalars = { ...paramFile.data, values: [...originalValues, synthetic] };
              }
            }
          }
        }
      } catch (e) {
        console.warn('[DataOperationsService] Failed to prepare synthetic MECE window baseline for scalars:', e);
      }

      // Feed authoritative t95 into query-time forecast recomputation.
      // This prevents silent fallback to DEFAULT_T95_DAYS when the graph already has a real t95.
      const t95FromEdge =
        typeof (targetEdge as any)?.p?.latency?.t95 === 'number' && Number.isFinite((targetEdge as any).p.latency.t95) && (targetEdge as any).p.latency.t95 > 0
          ? (targetEdge as any).p.latency.t95
          : undefined;
      const t95FromFile =
        typeof (paramFile as any)?.data?.latency?.t95 === 'number' && Number.isFinite((paramFile as any).data.latency.t95) && (paramFile as any).data.latency.t95 > 0
          ? (paramFile as any).data.latency.t95
          : undefined;
      const isLatencyEdge = Boolean((targetEdge as any)?.p?.latency?.latency_parameter);
      const t95Days = isLatencyEdge ? (t95FromEdge ?? t95FromFile) : 0;
      const t95Source: 'edge' | 'file_latency' | 'none' | 'unknown' =
        isLatencyEdge
          ? (t95FromEdge !== undefined ? 'edge' : (t95FromFile !== undefined ? 'file_latency' : 'unknown'))
          : 'none';

      const forecasting = await forecastingSettingsService.getForecastingModelSettings();
      aggregatedData = this.addEvidenceAndForecastScalars(
        aggregatedData,
        paramDataForScalars,
        targetSlice,
        { logOpId, t95Days, t95Source, forecasting }
      );
      
      // Log forecast data if present
      const latestValue = aggregatedData?.values?.[aggregatedData.values.length - 1];
      if (latestValue?.forecast !== undefined) {
        sessionLogService.addChild(logOpId, 'info', 'FORECAST_ATTACHED',
          `Forecast: ${(latestValue.forecast * 100).toFixed(1)}%, evidence: ${((latestValue.evidence?.mean ?? latestValue.k / latestValue.n) * 100).toFixed(1)}%`,
          undefined,
          {
            forecastMean: latestValue.forecast,
            evidenceMean: latestValue.evidence?.mean,
            blendedMean: latestValue.mean,
            completeness: latestValue.latency?.completeness,
            n: latestValue.n,
            k: latestValue.k,
          }
        );
      }
      
      // Call UpdateManager to transform data
      // Use validateOnly: true to get changes without mutating targetEdge in place
      // (we apply changes ourselves to nextGraph after cloning)
      const result = await updateManager.handleFileToGraph(
        aggregatedData,    // source (parameter file data, possibly aggregated)
        targetEdge,        // target (graph edge) - used for override checks, not mutated
        'UPDATE',          // operation
        'parameter',       // sub-destination
        {
          interactive: true,
          validateOnly: true,
          // IMPORTANT: explicit GET should be able to copy permission flags without forcing
          // overwrites of overridden value fields.
          allowPermissionFlagCopy: includePermissions,
        }
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
        // Filter changes by requested copy options (values / metadata / permissions).
        const isPermissionField = (field: string): boolean => field.includes('_overridden');
        const isValueField = (field: string): boolean => {
          // Probability
          if (field === 'p.mean' || field === 'p.stdev' || field === 'p.distribution') return true;
          if (field.startsWith('p.evidence.') || field.startsWith('p.forecast.')) return true;
          // Latency *data* (display-only) fields
          if (field === 'p.latency.median_lag_days' || field === 'p.latency.completeness') return true;
          // Cost params
          if (field === 'cost_gbp.mean' || field === 'cost_gbp.stdev' || field === 'cost_gbp.distribution') return true;
          if (field.startsWith('cost_gbp.evidence.')) return true;
          if (field === 'labour_cost.mean' || field === 'labour_cost.stdev' || field === 'labour_cost.distribution') return true;
          if (field.startsWith('labour_cost.evidence.')) return true;
          return false;
        };

        const filteredChanges = (result.changes as any[]).filter((c: any) => {
          const field = String(c.field || '');
          const isPerm = isPermissionField(field);
          if (isPerm) {
            if (permissionsMode === 'do_not_copy') return false;
            if (permissionsMode === 'copy_if_false') {
              return c.newValue === true && c.oldValue !== true;
            }
            return true; // copy_all
          }

          const isVal = isValueField(field);
          if (isVal) return includeValues;
          return includeMetadata;
        });

        // Replace changes with filtered list for downstream apply logic.
        (result as any).changes = filteredChanges;

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
          const windowFromChange = result.changes.find((c: { field: string }) => c.field === 'p.evidence.window_from');
          const windowToChange = result.changes.find((c: { field: string }) => c.field === 'p.evidence.window_to');
          const retrievedAtChange = result.changes.find((c: { field: string }) => c.field === 'p.evidence.retrieved_at');
          const sourceChange = result.changes.find((c: { field: string }) => c.field === 'p.evidence.source');
          
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
                k: kChange?.newValue,
                window_from: windowFromChange?.newValue,
                window_to: windowToChange?.newValue,
                retrieved_at: retrievedAtChange?.newValue,
                source: sourceChange?.newValue,
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
    copyOptions?: PutToFileCopyOptions;
  }): Promise<void> {
    const { paramId, edgeId, graph, conditionalIndex } = options;
    const includeValues = options.copyOptions?.includeValues !== false;
    const includeMetadata = options.copyOptions?.includeMetadata !== false;
    const permissionsMode: PermissionCopyMode = options.copyOptions?.permissionsMode ?? 'copy_all';
    
    console.log('[DataOperationsService] putParameterToFile CALLED:', {
      paramId,
      edgeId,
      conditionalIndex,
      includeValues,
      includeMetadata,
      permissionsMode,
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
        // IMPORTANT: some parameter-file fields live on the EDGE (query/n_query + override flags),
        // so we must include them for UpdateManager graph→file mappings.
        const pClone = structuredClone(sourceEdge.p);

        // Control whether we copy permission flags (override flags) into the parameter file.
        // Defaults to copy_all to match current behaviour; caller can disable or make it one-way.
        if (permissionsMode !== 'copy_all') {
          // Query/N-query flags live on edge; latency flags live under p.latency.
          // When permissions are not copied, remove all overridden flags from the payload.
          // When copying only-if-false, only send true flags when the file isn't already locked.
          const targetFile = paramFile?.data;
          const targetLatency = targetFile?.latency ?? {};

          // Latency flags under p.latency
          if (pClone?.latency) {
            const srcLat = pClone.latency;
            const maybeKeepTrue = (flagKey: string, targetFlag: any) => {
              if (permissionsMode === 'do_not_copy') {
                delete srcLat[flagKey];
                return;
              }
              if (permissionsMode === 'copy_if_false') {
                if (targetFlag === true) {
                  delete srcLat[flagKey];
                  return;
                }
                if (srcLat[flagKey] === true) {
                  // keep true (promote)
                  return;
                }
                delete srcLat[flagKey];
              }
            };

            maybeKeepTrue('latency_parameter_overridden', targetLatency.latency_parameter_overridden);
            maybeKeepTrue('anchor_node_id_overridden', targetLatency.anchor_node_id_overridden);
            maybeKeepTrue('t95_overridden', targetLatency.t95_overridden);
            maybeKeepTrue('path_t95_overridden', targetLatency.path_t95_overridden);
          }
        }

        // IMPORTANT: For force-copy mode, we want the file to match the graph even when
        // the graph omits optional fields (treat omission as "cleared"/false).
        // Without this, UPDATE mappings will skip (sourceValue undefined) and stale file
        // values persist even under "Copy all (force copy)".
        const forceCopy = permissionsMode === 'copy_all';
        const effectiveQueryOverridden =
          forceCopy ? (sourceEdge.query_overridden === true) : sourceEdge.query_overridden;
        const effectiveNQuery =
          forceCopy ? (typeof sourceEdge.n_query === 'string' ? sourceEdge.n_query : '') : sourceEdge.n_query;
        const effectiveNQueryOverridden =
          forceCopy ? (sourceEdge.n_query_overridden === true) : sourceEdge.n_query_overridden;

        filteredEdge = {
          p: pClone,
          query: sourceEdge.query,
          query_overridden: effectiveQueryOverridden,
          n_query: effectiveNQuery,
          n_query_overridden: effectiveNQueryOverridden,
        };

        // If user requested no permission copying, remove edge-level override flags from payload.
        if (permissionsMode === 'do_not_copy') {
          delete filteredEdge.query_overridden;
          delete filteredEdge.n_query_overridden;
        } else if (permissionsMode === 'copy_if_false') {
          const targetFile = paramFile?.data;
          if (targetFile?.query_overridden === true || filteredEdge.query_overridden !== true) {
            delete filteredEdge.query_overridden;
          }
          if (targetFile?.n_query_overridden === true || filteredEdge.n_query_overridden !== true) {
            delete filteredEdge.n_query_overridden;
          }
        }
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
      let result: any = null;
      if (includeValues) {
        result = await updateManager.handleGraphToFile(
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
      }
      
      // Also update connection settings (UPDATE operation, not APPEND)
      // Connection settings go to top-level fields, not values[]
      const ignoreOverrideFlags = permissionsMode === 'copy_all';
      const updateResult = includeMetadata
        ? await updateManager.handleGraphToFile(
            filteredEdge,      // source (filtered to only relevant parameter)
            paramFile.data,    // target (parameter file)
            'UPDATE',          // operation (update top-level fields)
            'parameter',       // sub-destination
            {
              interactive: true,
              validateOnly: true,
              ignoreOverrideFlags,
              allowPermissionFlagCopy: permissionsMode !== 'do_not_copy',
            }  // Explicit PUT: optionally copy permissions
          )
        : { success: true, changes: [] };
      
      // Apply changes to file data
      const updatedFileData = structuredClone(paramFile.data);
      console.log('[DataOperationsService] putParameterToFile - changes to apply:', {
        paramId,
        isNewFile,
        createChanges: createResult?.changes ? JSON.stringify(createResult.changes, null, 2) : 'none',
        appendChanges: result?.changes ? JSON.stringify(result.changes, null, 2) : 'none',
        updateChanges: updateResult.changes ? JSON.stringify(updateResult.changes, null, 2) : 'none'
      });
      
      // For new files: Apply CREATE changes first (connection settings)
      if (isNewFile && createResult?.success && createResult?.changes) {
        applyChanges(updatedFileData, createResult.changes);
      }
      
      // Apply APPEND changes (values[])
      if (includeValues && result?.changes) {
        applyChanges(updatedFileData, result.changes);
      }
      
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
      // Mirror putParameterToFile behaviour: create file if missing.
      let nodeFile = fileRegistry.getFile(`node-${nodeId}`);
      let isNewFile = false;
      if (!nodeFile) {
        isNewFile = true;
        console.log(`[putNodeToFile] File not found, creating: ${nodeId}`);
        const { fileOperationsService } = await import('./fileOperationsService');
        await fileOperationsService.createFile(nodeId, 'node', { openInTab: false });
        nodeFile = fileRegistry.getFile(`node-${nodeId}`);
        if (!nodeFile) {
          toast.error(`Failed to create node file: ${nodeId}`);
          return;
        }
        toast.success(`Created new node file: ${nodeId}`);
      }
      
      const sourceNode = graph.nodes?.find((n: any) => n.uuid === nodeId || n.id === nodeId || n.data?.id === nodeId);
      if (!sourceNode) {
        toast.error(`Node not found in graph`);
        return;
      }

      // For new files, run CREATE mappings first to initialise id/name/description/event_id.
      if (isNewFile) {
        const createResult = await updateManager.handleGraphToFile(
          sourceNode,
          nodeFile.data,
          'CREATE',
          'node',
          { interactive: true, validateOnly: true }
        );
        if (createResult.success && createResult.changes?.length) {
          const createdFileData = structuredClone(nodeFile.data);
          applyChanges(createdFileData, createResult.changes);
          await fileRegistry.updateFile(`node-${nodeId}`, createdFileData);
          // Refresh local ref for subsequent UPDATE
          nodeFile = fileRegistry.getFile(`node-${nodeId}`) || nodeFile;
        }
      }

      const result = await updateManager.handleGraphToFile(
        sourceNode,
        nodeFile.data,
        'UPDATE',
        'node',
        { interactive: true, validateOnly: true }
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
    skipCohortBounding?: boolean; // If true, skip cohort horizon bounding
    /** If true, run the real planning + DAS request construction, but DO NOT execute external HTTP. */
    dontExecuteHttp?: boolean;
    /**
     * Plan interpreter mode: execute exactly these windows (bypass cache-cutting window derivation).
     */
    overrideFetchWindows?: DateRange[];
    /**
     * Callback fired immediately after cache analysis, before any API fetch.
     * Used by retrieve-all to show real-time progress.
     */
    onCacheAnalysis?: (result: CacheAnalysisResult) => void;
  }): Promise<GetFromSourceResult> {
    const { objectType, objectId, targetId, graph, setGraph, paramSlot, conditionalIndex, bustCache, targetSlice = '', currentDSL, boundedCohortWindow, skipCohortBounding, dontExecuteHttp, overrideFetchWindows, onCacheAnalysis } = options;
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
        const result = await this.getFromSourceDirect({
          objectType: 'parameter',
          objectId, // Parameter file ID
          targetId,
          graph: currentGraph,
          setGraph: dontExecuteHttp ? undefined : trackingSetGraph,
          paramSlot,
          conditionalIndex,
          writeToFile: true, // Internal: write daily time-series into file when provider supports it
          bustCache,       // Pass through bust cache flag
          currentDSL,
          targetSlice,
          boundedCohortWindow,
          skipCohortBounding, // Pass through to skip bounding if set
          dontExecuteHttp,
          overrideFetchWindows,
          onCacheAnalysis,
        });
        
        // NOTE: getFromSourceDirect already calls getParameterFromFile internally
        // (both for cache hits and after writing new data), so no second call needed
        
        batchableToastSuccess('Fetched from source and updated graph from file');
        return result;
        
      } else if (objectType === 'case') {
        // Cases: fetch gate config, append to schedules[], update graph nodes
        console.log(`[DataOperationsService] getFromSource for case: ${objectId}`);
        
        // 1. Fetch from source and write to case file
        // For cases, we manually extract variants_update and write to file
        // (Unlike params which have daily time_series, cases have discrete schedule snapshots)
        const caseResult = await this.getFromSourceDirect({
          objectType,
          objectId,
          targetId,
          graph: currentGraph,
          setGraph: dontExecuteHttp ? undefined : trackingSetGraph,
          writeToFile: false, // Cases do not use daily time-series; this is a single snapshot
          versionedCase: true, // Signal to append schedule to case file instead of direct graph apply
          bustCache: false,
          currentDSL,
          dontExecuteHttp,
          onCacheAnalysis,
        });
        
        // 2. Update graph nodes from case file (with windowed aggregation)
        // Find all nodes with this case_id and update their variant weights from file
        // Use currentGraph which was updated by step 1's setGraph call
        if (dontExecuteHttp) {
          // Dry-run simulation must not mutate graph.
          return caseResult;
        }
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
        return caseResult;
        
      } else {
        batchableToastError(`Versioned fetching not yet supported for ${objectType}`);
        return { success: false, cacheHit: false, daysFetched: 0, daysFromCache: 0 };
      }
      
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      batchableToastError(`Error fetching from source: ${message}`);
      console.error('getFromSource error:', error);
      // IMPORTANT: propagate failure so callers (batch operations, Retrieve All) can count failures correctly.
      throw (error instanceof Error ? error : new Error(message));
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
    /** If true, run the real planning + DAS request construction, but DO NOT execute external HTTP. */
    dontExecuteHttp?: boolean;
    /**
     * If true, skip cohort horizon bounding even when latency is enabled.
     * Used when the FetchPlan has already computed the correct windows.
     * This ensures the planner's plan is executed exactly as computed.
     */
    skipCohortBounding?: boolean;
    /**
     * Plan interpreter mode: execute exactly these windows (bypass cache-cutting window derivation).
     */
    overrideFetchWindows?: DateRange[];
    /**
     * Callback fired immediately after cache analysis, before any API fetch.
     * Used by retrieve-all to show real-time progress.
     */
    onCacheAnalysis?: (result: CacheAnalysisResult) => void;
    /**
     * Optional forecasting settings (used for consistent recency weighting in horizon estimation).
     * If omitted, defaults are loaded from forecasting settings / constants.
     */
    forecasting?: {
      RECENCY_HALF_LIFE_DAYS?: number;
      DEFAULT_T95_DAYS?: number;
    };
  }): Promise<GetFromSourceResult> {
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
        dontExecuteHttp = false,
        skipCohortBounding = false,
        overrideFetchWindows,
        onCacheAnalysis,
      } = options;

    // Per-item slice identity for logging (distinct from the resolved window/cohort range).
    // - `sliceDSLForLog` may be a full DSL (window/cohort/context/etc)
    // - `sliceDimensionsForLog` is the canonical slice identifier used for file storage (context/case only)
    const sliceDSLForLog = targetSlice || currentDSL || '';
    const sliceDimensionsForLog = extractSliceDimensions(sliceDSLForLog);
    const sliceLabelForLog =
      sliceDimensionsForLog ||
      (hasContextAny(sliceDSLForLog) ? 'contextAny(...)' : '(uncontexted)');
    
    // Track fetch statistics for return value
    let fetchStats = {
      cacheHit: false,
      daysFetched: 0,
      daysFromCache: 0,
    };
    
    // Helper for error returns
    const errorResult: GetFromSourceResult = { success: false, cacheHit: false, daysFetched: 0, daysFromCache: 0 };
    
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
        targetId,
        slice: sliceDimensionsForLog || undefined,
        sliceDSL: sliceDSLForLog || undefined,
        sliceLabel: sliceLabelForLog,
      }
    );

    // ============================================================================
    // Intent integrity guardrails (warn & proceed)
    // ============================================================================
    // Class of failure: DSL expresses a window()/cohort() intent, but it is dropped and
    // execution proceeds (often falling back to the default window). This must never be silent.
    //
    // Centralised here so all callers + all code paths share identical warning behaviour.
    const warnIfQueryIntentDropped = (queryPayloadToCheck: any) => {
      try {
        // IMPORTANT:
        // - currentDSL is the graph-level view (often cohort-view).
        // - targetSlice is an optional per-item override (e.g. fetch a simple edge via window()
        //   even while the overall view is cohort()).
        //
        // The guardrail should validate the DSL that actually drove query construction for THIS item,
        // otherwise we'll emit false-positive "intent dropped" warnings.
        const intentDSL = targetSlice || currentDSL || '';
        const hasWindowToken = intentDSL.includes('window(');
        const hasCohortToken = intentDSL.includes('cohort(');

        if (hasWindowToken && (!queryPayloadToCheck?.start || !queryPayloadToCheck?.end)) {
          sessionLogService.addChild(
            logOpId,
            'warning',
            'WINDOW_INTENT_DROPPED',
            'DSL contained window() but resolved query payload did not include an explicit window range',
            intentDSL,
            { start: queryPayloadToCheck?.start, end: queryPayloadToCheck?.end }
          );
        }

        if (hasCohortToken && (!queryPayloadToCheck?.cohort?.start || !queryPayloadToCheck?.cohort?.end)) {
          sessionLogService.addChild(
            logOpId,
            'warning',
            'COHORT_INTENT_DROPPED',
            'DSL contained cohort() but resolved query payload did not include an explicit cohort range',
            intentDSL,
            { cohort: queryPayloadToCheck?.cohort }
          );
        }
      } catch (e) {
        console.warn('[DataOps] Failed to run intent integrity guardrails:', e);
      }
    };
    
    try {
      let connectionName: string | undefined;
      let connectionString: any = {};
      
      // Persisted config selection (critical):
      // - Versioned parameter fetch: prefer parameter file connection/connection_string
      // - Direct parameter fetch: prefer graph edge connection/connection_string
      // - Cases: versionedCase uses file; direct uses node.case
      if (objectType === 'parameter' && targetId && graph) {
        const targetEdge: any = graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId);
        const paramFile = objectId ? fileRegistry.getFile(`parameter-${objectId}`) : undefined;
        const { selectPersistedProbabilityConfig } = await import('./persistedParameterConfigService');
        const graphParam =
          conditionalIndex !== undefined ? targetEdge?.conditional_p?.[conditionalIndex]?.p : (paramSlot ? targetEdge?.[paramSlot] : targetEdge?.p);
        const persisted = selectPersistedProbabilityConfig({
          writeToFile: writeToFile === true,
          fileParamData: paramFile?.data,
          graphParam,
          graphEdge: targetEdge,
        });
        connectionName = persisted.connection;
        if (persisted.connection_string) {
          try {
            connectionString = typeof persisted.connection_string === 'string'
              ? JSON.parse(persisted.connection_string)
              : persisted.connection_string;
          } catch (e) {
            toast.error('Invalid connection_string JSON in persisted parameter config');
            sessionLogService.endOperation(logOpId, 'error', 'Invalid connection_string JSON in persisted parameter config');
            return errorResult;
          }
        }
      } else if (objectType === 'case' && targetId && graph) {
        // Cases: choose persisted source by mode:
        // - versionedCase=true → consult case file (persists schedules)
        // - versionedCase=false → consult graph node inline case config
        const targetNode: any = graph.nodes?.find((n: any) => n.uuid === targetId || n.id === targetId);
        const caseFile = objectId ? fileRegistry.getFile(`case-${objectId}`) : undefined;
        const { selectPersistedCaseConfig } = await import('./persistedCaseConfigService');
        const persisted = selectPersistedCaseConfig({
          versionedCase: versionedCase === true,
          fileCaseData: caseFile?.data,
          graphNode: targetNode,
        });
        connectionName = persisted.connection;
        if (persisted.connection_string) {
          try {
            connectionString = typeof persisted.connection_string === 'string'
              ? JSON.parse(persisted.connection_string)
              : persisted.connection_string;
          } catch (e) {
            toast.error('Invalid connection_string JSON in persisted case config');
            sessionLogService.endOperation(logOpId, 'error', 'Invalid connection_string JSON in persisted case config');
            return errorResult;
          }
        }
      } else if (objectId) {
        // Non-parameter, non-case fallback: keep existing behaviour (file if present).
        const fileId = `${objectType}-${objectId}`;
        const file = fileRegistry.getFile(fileId);
        if (file) {
          const data = file.data;
          connectionName = data.connection;
          if (data.connection_string) {
            try {
              connectionString = typeof data.connection_string === 'string'
                ? JSON.parse(data.connection_string)
                : data.connection_string;
            } catch (e) {
              toast.error('Invalid connection_string JSON in file');
              sessionLogService.endOperation(logOpId, 'error', 'Invalid connection_string JSON in file');
              return errorResult;
            }
          }
        }
      }
      
      // If still no connection, try to get it from the edge/node directly
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
                  return errorResult;
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
                  return errorResult;
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
                return errorResult;
              }
            }
          }
        }
      }
      
      // 2. Check if we have a connection configured
      if (!connectionName) {
        sessionLogService.endOperation(logOpId, 'error', 'No connection configured');
        toast.error(`No connection configured. Please set the 'connection' field.`);
        return errorResult;
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
      let signatureContextKeys: string[] = [];
      // The exact edge-like object used to build the QueryPayload.
      // We re-use it when computing query_signature so latency/anchor semantics match the payload.
      let edgeForQuerySignature: any | undefined;
      
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
              // Even when we don't need event-id mapping, we must preserve window()/cohort()
              // constraints for correct fetch windows. Otherwise we silently fall back to the
              // default window, which is unacceptable.
              queryPayload = {};
              eventDefinitions = {};

              try {
                const { parseConstraints } = await import('../lib/queryDSL');
                // IMPORTANT: In cohort-view we sometimes override per-item retrieval mode
                // via targetSliceOverride (e.g. fetch simple edges via window() even while
                // the overall view is cohort()).
                // targetSlice is the per-item source of truth when provided.
                const effectiveDSL = targetSlice || currentDSL || '';
                const graphConstraints = effectiveDSL ? parseConstraints(effectiveDSL) : null;
                const edgeConstraints = effectiveQuery ? parseConstraints(effectiveQuery) : null;
                const constraints = {
                  context: [...(graphConstraints?.context || []), ...(edgeConstraints?.context || [])],
                  contextAny: [...(graphConstraints?.contextAny || []), ...(edgeConstraints?.contextAny || [])],
                  window: edgeConstraints?.window || graphConstraints?.window || null,
                  cohort: edgeConstraints?.cohort || graphConstraints?.cohort || null,
                  visited: edgeConstraints?.visited || [],
                  visitedAny: edgeConstraints?.visitedAny || [],
                };
                signatureContextKeys = extractContextKeysFromConstraints(constraints);

                // Normalise open-ended ranges (e.g. window(-60d:)) to an explicit end = today.
                const todayUK = formatDateUK(new Date());
                if (constraints.window?.start && !constraints.window.end) {
                  constraints.window = { ...constraints.window, end: todayUK };
                }
                if (constraints.cohort?.start && !constraints.cohort.end) {
                  constraints.cohort = { ...constraints.cohort, end: todayUK };
                }

                if (constraints.window?.start || constraints.window?.end) {
                  const startUK = constraints.window?.start ? resolveRelativeDate(constraints.window.start) : undefined;
                  const endUK = constraints.window?.end
                    ? resolveRelativeDate(constraints.window.end)
                    : todayUK;
                  if (startUK) queryPayload.start = parseUKDate(startUK).toISOString();
                  if (endUK) queryPayload.end = parseUKDate(endUK).toISOString();
                }

                if (constraints.cohort?.start || constraints.cohort?.end) {
                  const startUK = constraints.cohort?.start ? resolveRelativeDate(constraints.cohort.start) : undefined;
                  const endUK = constraints.cohort?.end
                    ? resolveRelativeDate(constraints.cohort.end)
                    : todayUK;
                  queryPayload.cohort = {
                    start: startUK ? parseUKDate(startUK).toISOString() : undefined,
                    end: endUK ? parseUKDate(endUK).toISOString() : undefined,
                    anchor_event_id: constraints.cohort?.anchor,
                  };
                }
              } catch (e) {
                console.warn('[DataOps] Failed to preserve window/cohort constraints for requires_event_ids=false connection:', e);
              }

              // Guardrail: if the DSL had intent but we didn't resolve it, warn loudly.
              warnIfQueryIntentDropped(queryPayload);
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
                const effectiveDSL = targetSlice || currentDSL || '';
                
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
                signatureContextKeys = extractContextKeysFromConstraints(constraints);

                // Open-ended slice windows are valid in DagNet (e.g. window(-60d:), cohort(-60d:)).
                // Normalise here so downstream DSL building (buildDslFromEdge) doesn't silently fall back to
                // the default 7-day window when end is missing.
                const todayUK = formatDateUK(new Date());
                if (constraints.window?.start && !constraints.window.end) {
                  constraints.window = { ...constraints.window, end: todayUK };
                }
                if (constraints.cohort?.start && !constraints.cohort.end) {
                  constraints.cohort = { ...constraints.cohort, end: todayUK };
                }
                
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
                sessionLogService.addChild(
                  logOpId,
                  'warning',
                  'CONSTRAINTS_PARSE_FAILED',
                  'Failed to parse window/context constraints; proceeding without parsed constraints (may trigger fallbacks)',
                  currentDSL ?? undefined
                );
              }
              
              // Clear context registry cache to ensure fresh data from filesystem
              const { contextRegistry } = await import('./contextRegistry');
              contextRegistry.clearCache();
              
              // Build DSL with event mapping for analytics-style connections (e.g., Amplitude)
              // IMPORTANT: For versioned parameter operations (writeToFile=true), prefer persisted
              // parameter-file config for connection/latency primitives (e.g. conversion_window_days).
              const paramFileForCfg =
                objectType === 'parameter' && objectId
                  ? fileRegistry.getFile(`parameter-${objectId}`)
                  : undefined;
              const { selectPersistedProbabilityConfig } = await import('./persistedParameterConfigService');
              const persistedCfg = selectPersistedProbabilityConfig({
                writeToFile: writeToFile === true,
                fileParamData: paramFileForCfg?.data,
                graphParam: conditionalIndex !== undefined ? targetEdge?.conditional_p?.[conditionalIndex]?.p : targetEdge?.p,
                graphEdge: targetEdge,
              });

              // Create edge-like object with effective query (may be from conditional_p)
              // and persisted config merged in (versioned only).
              const graphPForDsl =
                conditionalIndex !== undefined
                  ? targetEdge?.conditional_p?.[conditionalIndex]?.p
                  : targetEdge?.p;
              const edgeForDsl = {
                ...targetEdge,
                query: effectiveQuery, // Use effective query (base or conditional_p)
                // IMPORTANT: buildDslFromEdge reads anchor_node_id from edge.p.latency.
                // For conditional fetches, use the conditional param's latency config so cohort anchoring
                // is explicit and auditable (no hidden inheritance from base edge state).
                p: graphPForDsl
                  ? {
                      ...graphPForDsl,
                      ...(persistedCfg.source === 'file' && persistedCfg.connection ? { connection: persistedCfg.connection } : {}),
                      ...(persistedCfg.source === 'file' && persistedCfg.connection_string ? { connection_string: persistedCfg.connection_string } : {}),
                      ...(persistedCfg.source === 'file' && persistedCfg.latency ? { latency: persistedCfg.latency } : {}),
                    }
                  : graphPForDsl,
              };
              edgeForQuerySignature = edgeForDsl;
              
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

              // Guardrail: if the DSL had intent but we didn't resolve it, warn loudly.
              warnIfQueryIntentDropped(queryPayload);
              
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
                  slice: sliceDimensionsForLog || undefined,
                  sliceDSL: sliceDSLForLog || undefined,
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
                const effectiveDSL = targetSlice || currentDSL || '';
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

                // Open-ended slice windows are valid in DagNet (e.g. window(-60d:), cohort(-60d:)).
                // Normalise here so downstream DSL building doesn't silently fall back to the default window.
                const todayUK = formatDateUK(new Date());
                if (constraints.window?.start && !constraints.window.end) {
                  constraints.window = { ...constraints.window, end: todayUK };
                }
                if (constraints.cohort?.start && !constraints.cohort.end) {
                  constraints.cohort = { ...constraints.cohort, end: todayUK };
                }
                
                console.log('[DataOps] Merged constraints (fallback):', {
                  currentDSL,
                  effectiveDSL,
                  edgeQuery: targetEdge.query,
                  merged: constraints
                });
              } catch (error) {
                console.warn('[DataOps] Failed to parse constraints (fallback):', error);
                sessionLogService.addChild(
                  logOpId,
                  'warning',
                  'CONSTRAINTS_PARSE_FAILED',
                  'Failed to parse window/context constraints (fallback path); proceeding without parsed constraints (may trigger fallbacks)',
                  currentDSL ?? undefined
                );
              }
              
              const paramFileForCfg =
                objectType === 'parameter' && objectId
                  ? fileRegistry.getFile(`parameter-${objectId}`)
                  : undefined;
              const { selectPersistedProbabilityConfig } = await import('./persistedParameterConfigService');
              const persistedCfg = selectPersistedProbabilityConfig({
                writeToFile: writeToFile === true,
                fileParamData: paramFileForCfg?.data,
                graphParam: targetEdge?.p,
                graphEdge: targetEdge,
              });

              const targetEdgeWithPersisted = {
                ...targetEdge,
                p: targetEdge?.p
                  ? {
                      ...targetEdge.p,
                      ...(persistedCfg.source === 'file' && persistedCfg.connection ? { connection: persistedCfg.connection } : {}),
                      ...(persistedCfg.source === 'file' && persistedCfg.connection_string ? { connection_string: persistedCfg.connection_string } : {}),
                      ...(persistedCfg.source === 'file' && persistedCfg.latency ? { latency: persistedCfg.latency } : {}),
                    }
                  : targetEdge?.p,
              };
              edgeForQuerySignature = targetEdgeWithPersisted;

              const fallbackResult = await buildDslFromEdge(
                targetEdgeWithPersisted,
                graph,
                connectionProvider,
                eventLoader,
                constraints  // Pass constraints for context filters
              );
              queryPayload = fallbackResult.queryPayload;
              eventDefinitions = fallbackResult.eventDefinitions;

              // Guardrail: if the DSL had intent but we didn't resolve it, warn loudly.
              warnIfQueryIntentDropped(queryPayload);
            } catch (error) {
              console.error('Error building DSL from edge:', error);
              toast.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
              sessionLogService.endOperation(logOpId, 'error', `Failed to build query: ${error instanceof Error ? error.message : String(error)}`);
              return errorResult;
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
      let explicitNQueryWasToOnlyNormalForm = false;
      let explicitNQueryWindowDenomUsesFromCount = false;
      
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

        // Anchor-free MSMDC normal form: "to(X)" (no from()).
        // Legacy "from(A).to(X)" remains supported.
        if (/^\s*to\(\s*[^)]+?\s*\)\s*$/.test(explicitNQuery)) {
          explicitNQueryWasToOnlyNormalForm = true;
        }
        
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
            const effectiveDSL = targetSlice || currentDSL || '';
            const graphConstraints = effectiveDSL ? parseConstraints(effectiveDSL) : null;
            const nQueryEdgeConstraints = explicitNQueryWasToOnlyNormalForm ? null : parseConstraints(explicitNQuery);
            
            nQueryConstraints = {
              context: [...(graphConstraints?.context || []), ...((nQueryEdgeConstraints as any)?.context || [])],
              contextAny: [...(graphConstraints?.contextAny || []), ...((nQueryEdgeConstraints as any)?.contextAny || [])],
              window: (nQueryEdgeConstraints as any)?.window || graphConstraints?.window || null,
              cohort: (nQueryEdgeConstraints as any)?.cohort || graphConstraints?.cohort || null,  // A-anchored cohort for latency edges
              visited: (nQueryEdgeConstraints as any)?.visited || [],
              visitedAny: (nQueryEdgeConstraints as any)?.visitedAny || []
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

            // Support anchor-free normal form: "to(X)".
            // We synthesise a concrete query string that buildDslFromEdge can resolve:
            // - cohort(): from(anchor).to(X) (anchor taken from cohort DSL / edge latency)
            // - window(): from(X).to(mainTo) and later use from_count as the denominator
            if (explicitNQueryWasToOnlyNormalForm) {
              const toOnlyMatch = explicitNQuery.match(/^\s*to\(\s*([^)]+?)\s*\)\s*$/);
              const xId = toOnlyMatch ? toOnlyMatch[1].trim() : null;
              try {
                const { parseConstraints, parseDSL } = await import('../lib/queryDSL');
                const effectiveDSL = targetSlice || currentDSL || '';
                const graphConstraints = effectiveDSL ? parseConstraints(effectiveDSL) : null;
                const wantsCohort = !!graphConstraints?.cohort;
                const wantsWindow = !!graphConstraints?.window && !wantsCohort;

                // Parse the *main edge* query to obtain a stable "to" node id for window synthesis.
                let mainToId: string | null = null;
                try {
                  const parsedMain = parseDSL((nQueryEdge as any)?.query || '');
                  mainToId = parsedMain?.to ? String(parsedMain.to) : null;
                } catch {
                  mainToId = null;
                }

                if (wantsCohort) {
                  const anchorId = (graphConstraints?.cohort as any)?.anchor || (nQueryEdgeData as any)?.p?.latency?.anchor_node_id;
                  if (anchorId && xId) {
                    nQueryEdgeData.query = `from(${anchorId}).to(${xId})`;
                  } else {
                    console.warn('[DataOps:DUAL_QUERY] to(X) n_query in cohort mode but no anchor available; skipping explicit n_query for this run');
                    explicitNQuery = undefined;
                    needsDualQuery = false;
                  }
                } else if (wantsWindow) {
                  if (xId) {
                    // Window-mode denominator for to(X) is a single-event "arrivals at X" count.
                    // We execute this via the Amplitude /events/segmentation endpoint (uniques),
                    // but we still build a normal QueryPayload via buildDslFromEdge to get
                    // eventDefinitions + context filters. We then tag the payload so the adapter
                    // switches endpoint/response parsing.
                    nQueryEdgeData.query = `from(${xId}).to(${xId})`;
                    explicitNQueryWindowDenomUsesFromCount = true;
                  }
                }
              } catch (error) {
                console.warn('[DataOps:DUAL_QUERY] Failed to synthesise concrete query for to(X) n_query:', error);
              }
            }
            
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

          // Mark window-mode to(X) denominators as "segmentation" so the Amplitude adapter uses
          // the single-event endpoint rather than /funnels.
          if (explicitNQueryWasToOnlyNormalForm && explicitNQueryWindowDenomUsesFromCount) {
            (baseQueryPayload as any).query_kind = 'segmentation';
          }
          
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
        conversion_window_days?: number;
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
            conversion_window_days: cohort.conversion_window_days,
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
        // Never allow this to be silent: surface a session log warning that a default window was applied.
        // This is especially important for bulk "Retrieve all slices" runs where the user expects the
        // per-slice DSL to drive the window. If we ever land here unexpectedly, the log must make it obvious.
        sessionLogService.addChild(
          logOpId,
          'warning',
          'DEFAULT_WINDOW_APPLIED',
          'No explicit window/cohort range could be resolved from DSL; using default last 7 days',
          `Default window: ${normalizeDate(requestedWindow.start)} to ${normalizeDate(requestedWindow.end)}\n` +
            `If this is unexpected, check for open-ended window/cohort (e.g. window(-60d:)) not being normalised.`,
          { requestedWindow }
        );
      }
      
      let actualFetchWindows: DateRange[] = [];
      const hasOverrideWindows = Array.isArray(overrideFetchWindows) && overrideFetchWindows.length > 0;
      if (hasOverrideWindows) {
        // Normalise override windows immediately (store as ISO strings for consistent downstream handling).
        actualFetchWindows = overrideFetchWindows!.map((w) => ({
          start: parseDate(w.start).toISOString(),
          end: parseDate(w.end).toISOString(),
        }));
        sessionLogService.addChild(
          logOpId,
          'info',
          'FETCH_WINDOWS_OVERRIDDEN',
          `Executing ${actualFetchWindows.length} plan window(s) exactly (overrideFetchWindows)`,
          undefined,
          { windows: actualFetchWindows.map((w) => ({ start: normalizeDate(w.start), end: normalizeDate(w.end) })) }
        );
      }

      const mergeFetchWindows = (windows: DateRange[]): DateRange[] => {
        if (windows.length <= 1) return windows;
        const sorted = [...windows].sort((a, b) => {
          const as = parseDate(a.start).getTime();
          const bs = parseDate(b.start).getTime();
          return as - bs;
        });
        const merged: DateRange[] = [];
        for (const w of sorted) {
          if (merged.length === 0) {
            merged.push({ start: w.start, end: w.end });
            continue;
          }
          const last = merged[merged.length - 1];
          const lastEnd = parseDate(last.end).getTime();
          const nextStart = parseDate(w.start).getTime();
          if (nextStart <= lastEnd) {
            const nextEnd = parseDate(w.end).getTime();
            if (nextEnd > lastEnd) {
              last.end = w.end;
            }
          } else {
            merged.push({ start: w.start, end: w.end });
          }
        }
        return merged;
      };
      let querySignature: string | undefined;
      let shouldSkipFetch = false;
      
      // CRITICAL: ALWAYS compute query signature when writing to parameter files
      // (we only write for parameter objects in versioned/source-via-file pathway)
      if (isSignatureWritingEnabled() && objectType === 'parameter' && writeToFile) {
        const targetEdge = targetId && graph ? graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId) : undefined;
        const workspaceForSignature = (() => {
          const pf = objectId ? fileRegistry.getFile(`parameter-${objectId}`) : undefined;
          const repo = (pf as any)?.source?.repository;
          const branch = (pf as any)?.source?.branch;
          return repo && branch ? { repository: repo, branch } : undefined;
        })();
        const fallbackContextKeys = (() => {
          if (signatureContextKeys.length > 0) return signatureContextKeys;
          const dsl = targetSlice || currentDSL || '';
          if (!dsl) return [];
          try {
            return extractContextKeysFromConstraints(parseConstraints(dsl));
          } catch (error) {
            console.warn('[DataOperationsService] Failed to parse context keys for signature:', error);
            return [];
          }
        })();
        querySignature = await computeQuerySignature(
          queryPayload,
          connectionName,
          graph,
          edgeForQuerySignature || targetEdge,
          fallbackContextKeys,
          workspaceForSignature
        );
        console.log('[DataOperationsService] Computed query signature for storage:', {
          signature: querySignature?.substring(0, 16) + '...',
          writeToFile,
          objectType
        });
      }
      
      // IMPORTANT: Only check for incremental fetch if bustCache is NOT set and we are
      // in the versioned parameter pathway (source→file→graph).
      const shouldCheckIncrementalFetch = writeToFile && !bustCache && objectType === 'parameter' && objectId && !hasOverrideWindows;
      
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
        const { selectPersistedProbabilityConfig } = await import('./persistedParameterConfigService');
        const graphLatencyConfig = targetEdgeForPolicy?.p?.latency as LatencyConfig | undefined;
        const fileLatencyConfig = (paramFile?.data?.latency as LatencyConfig | undefined) ?? undefined;
        const persistedCfg = selectPersistedProbabilityConfig({
          writeToFile: writeToFile === true,
          fileParamData: paramFile?.data,
          graphParam: targetEdgeForPolicy?.p,
          graphEdge: targetEdgeForPolicy,
        });
        const latencyConfig = (persistedCfg.latency as LatencyConfig | undefined) ?? (writeToFile ? fileLatencyConfig : graphLatencyConfig);
        
        // Check if this edge has latency tracking enabled
        const isLatencyEnabled = latencyConfig?.latency_parameter === true;
        if (isLatencyEnabled) {
          // Get existing slice for this context/case family
          const existingValues = paramFile?.data?.values as ParameterValue[] | undefined;
          const targetDims = extractSliceDimensions(targetSlice || '');
          const matching = (existingValues || []).filter(v => {
            // Match by slice type (cohort vs window) and context dimensions
            const isCorrectMode = isCohortQuery ? isCohortModeValue(v) : !isCohortModeValue(v);
            if (!isCorrectMode) return false;
            const valueDims = extractSliceDimensions(v.sliceDSL || '');
            return targetDims === valueDims;
          });
          // Prefer most recent match (avoid “first in file wins” if duplicates exist).
          const existingSlice = matching.length > 0
            ? matching.reduce((best, cur) => {
                const bestKey = best?.data_source?.retrieved_at || best?.cohort_to || best?.window_to || best?.cohort_from || best?.window_from || '';
                const curKey = cur?.data_source?.retrieved_at || cur?.cohort_to || cur?.window_to || cur?.cohort_from || cur?.window_from || '';
                return curKey > bestKey ? cur : best;
              })
            : undefined;
          
          refetchPolicy = shouldRefetch({
            existingSlice,
            latencyConfig,
            requestedWindow,
            isCohortQuery,
          });
          
          console.log('[DataOps:REFETCH_POLICY] Latency-aware refetch decision:', {
            latency_parameter: latencyConfig?.latency_parameter,
            t95: latencyConfig?.t95,
            isCohortQuery,
            hasExistingSlice: !!existingSlice,
            policy: refetchPolicy.type,
            matureCutoff: refetchPolicy.matureCutoff,
            refetchWindow: refetchPolicy.refetchWindow,
            reason: refetchPolicy.reason,
          });
          
          const effectiveHorizon = latencyConfig?.t95 ?? 30;
          sessionLogService.addChild(logOpId, 'info', 'REFETCH_POLICY',
            `Latency-aware policy: ${refetchPolicy.type}`,
            `Horizon: ${effectiveHorizon.toFixed(1)}d | Mode: ${isCohortQuery ? 'cohort' : 'window'}${refetchPolicy.matureCutoff ? ` | Cutoff: ${refetchPolicy.matureCutoff}` : ''}`,
            {
              latency_parameter: latencyConfig?.latency_parameter,
              t95: latencyConfig?.t95,
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
            // 2. Skip bounding if explicitly requested (first-principles plan already computed correct windows)
            else if (skipCohortBounding) {
              console.log('[DataOps:COHORT_HORIZON] Skipping bounding: skipCohortBounding=true, using full window:', fetchWindow);
              sessionLogService.addChild(logOpId, 'info', 'COHORT_HORIZON_SKIPPED',
                `Bounding skipped: using full requested window`,
                undefined,
                { window: fetchWindow, reason: 'skipCohortBounding flag set' }
              );
            }
            // 3. Fallback: recalculate using edge path_t95 (may be undefined on first load)
            else if (isCohortQuery && latencyConfig) {
              // Canonical behaviour (t95/path_t95 refactor intent):
              // - Use the persisted path_t95 from the active source of truth (file for versioned, graph for direct).
              // - Only fall back to on-demand estimates when persisted path_t95 is missing.
              const persistedSource: 'file.latency.path_t95' | 'graph.latency.path_t95' =
                persistedCfg.source === 'file' ? 'file.latency.path_t95' : 'graph.latency.path_t95';

              let effectivePathT95: number | undefined = latencyConfig.path_t95;
              let effectivePathT95Source: 'moment-matched' | 'persisted.path_t95' | 'none' =
                effectivePathT95 !== undefined ? 'persisted.path_t95' : 'none';
              let momentMatchDebug:
                | {
                    percentile: number;
                    totalNForAnchor: number;
                    totalKForEdge: number;
                    anchorMedian: number;
                    anchorMean: number;
                    edgeMedian: number;
                    edgeMean: number;
                    anchorFitOk: boolean;
                    edgeFitOk: boolean;
                    estimate: number;
                  }
                | undefined;
              try {
                // Only compute moment-matched estimate if we don't already have a persisted path_t95.
                if (
                  effectivePathT95 === undefined &&
                  existingSlice &&
                  isCohortModeValue(existingSlice) &&
                  Array.isArray((existingSlice as any).dates)
                ) {
                  const cohorts = aggregateCohortData([existingSlice as any], new Date(), undefined);
                  const anchorCandidates = cohorts.filter(c =>
                    c.n > 0 &&
                    c.anchor_median_lag_days !== undefined &&
                    Number.isFinite(c.anchor_median_lag_days) &&
                    (c.anchor_median_lag_days ?? 0) > 0
                  );
                  if (anchorCandidates.length > 0) {
                    const halfLife =
                      typeof options?.forecasting?.RECENCY_HALF_LIFE_DAYS === 'number' &&
                      Number.isFinite(options.forecasting.RECENCY_HALF_LIFE_DAYS) &&
                      options.forecasting.RECENCY_HALF_LIFE_DAYS > 0
                        ? options.forecasting.RECENCY_HALF_LIFE_DAYS
                        : RECENCY_HALF_LIFE_DAYS;

                    // Use the same recency weighting semantics as forecasts for horizon estimation.
                    const w = (ageDays: number) => Math.exp(-Math.LN2 * Math.max(0, ageDays) / halfLife);

                    const totalWNForAnchor = anchorCandidates.reduce((sum, c) => sum + c.n * w(c.age ?? 0), 0);
                    const anchorMedian =
                      anchorCandidates.reduce((sum, c) => sum + c.n * w(c.age ?? 0) * (c.anchor_median_lag_days ?? 0), 0) /
                      (totalWNForAnchor || 1);
                    const anchorMean =
                      anchorCandidates.reduce(
                        (sum, c) => sum + c.n * w(c.age ?? 0) * (c.anchor_mean_lag_days ?? c.anchor_median_lag_days ?? 0),
                        0
                      ) / (totalWNForAnchor || 1);

                    const edgeLag = aggregateLatencyStats(cohorts, halfLife);
                    const totalWK = cohorts.reduce((sum, c) => sum + (c.k ?? 0) * w(c.age ?? 0), 0);
                    if (edgeLag?.median_lag_days && edgeLag.median_lag_days > 0) {
                      const anchorFit = fitLagDistribution(anchorMedian, anchorMean, totalWNForAnchor);
                      const edgeFit = fitLagDistribution(edgeLag.median_lag_days, edgeLag.mean_lag_days, totalWK);
                      const estimate = approximateLogNormalSumPercentileDays(anchorFit, edgeFit, LATENCY_PATH_T95_PERCENTILE);
                      if (estimate !== undefined && Number.isFinite(estimate) && estimate > 0) {
                        effectivePathT95 = estimate;
                        effectivePathT95Source = 'moment-matched';
                        momentMatchDebug = {
                          percentile: LATENCY_PATH_T95_PERCENTILE,
                          totalNForAnchor: totalWNForAnchor,
                          totalKForEdge: totalWK,
                          anchorMedian,
                          anchorMean,
                          edgeMedian: edgeLag.median_lag_days,
                          edgeMean: edgeLag.mean_lag_days,
                          anchorFitOk: anchorFit.empirical_quality_ok,
                          edgeFitOk: edgeFit.empirical_quality_ok,
                          estimate,
                        };
                      }
                    }
                  }
                }
              } catch {
                // Non-fatal: fall back to graph.path_t95 / other horizon fallbacks.
              }

              if (momentMatchDebug) {
                sessionLogService.addChild(
                  logOpId,
                  'info',
                  'COHORT_HORIZON_PATH_T95_ESTIMATE',
                  `path_t95 estimate (moment-matched, p=${(momentMatchDebug.percentile * 100).toFixed(1)}%) = ${momentMatchDebug.estimate.toFixed(2)}d`,
                  `A→X: median=${momentMatchDebug.anchorMedian.toFixed(2)}d mean=${momentMatchDebug.anchorMean.toFixed(2)}d (n=${momentMatchDebug.totalNForAnchor})\nX→Y: median=${momentMatchDebug.edgeMedian.toFixed(2)}d mean=${momentMatchDebug.edgeMean.toFixed(2)}d (k=${momentMatchDebug.totalKForEdge})\nfitOk: anchor=${momentMatchDebug.anchorFitOk ? 'yes' : 'no'} edge=${momentMatchDebug.edgeFitOk ? 'yes' : 'no'}`,
                  {
                    percentile: momentMatchDebug.percentile,
                    totalNForAnchor: momentMatchDebug.totalNForAnchor,
                    totalKForEdge: momentMatchDebug.totalKForEdge,
                    anchorMedian: momentMatchDebug.anchorMedian,
                    anchorMean: momentMatchDebug.anchorMean,
                    edgeMedian: momentMatchDebug.edgeMedian,
                    edgeMean: momentMatchDebug.edgeMean,
                    anchorFitOk: momentMatchDebug.anchorFitOk,
                    edgeFitOk: momentMatchDebug.edgeFitOk,
                    estimate: momentMatchDebug.estimate,
                  }
                );
              }

              const horizonResult = computeCohortRetrievalHorizon({
                requestedWindow,
                pathT95: effectivePathT95,
                edgeT95: latencyConfig.t95,
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
                    effectivePathT95,
                    effectivePathT95Source,
                    persistedPathT95Source: persistedSource,
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
          // Signature to use for cache coverage / incremental fetch checks.
          // MUST be defined regardless of whether we find any values in cache.
          // Default to the expected signature for this run; may be overridden to the latest
          // signature observed in the file to avoid false cache-misses after query-def changes.
          let signatureToUse: string | undefined = querySignature;
          if (paramFile.data.values && Array.isArray(paramFile.data.values)) {
            // First: collect all values with daily data
            const allValuesWithDaily = (paramFile.data.values as ParameterValue[])
              .filter(v => v.n_daily && v.k_daily && v.dates && v.n_daily.length > 0);
            
            // CRITICAL: Isolate to target slice to prevent cross-slice date contamination.
            //
            // IMPORTANT (versioned fetch / Retrieve All Slices):
            // Slice isolation errors must not abort a fetch-from-source operation. They indicate the cache
            // cannot safely satisfy this requested slice, so we should treat this as "no usable cached values"
            // and proceed (which will drive an external fetch + append the missing slice).
            let valuesWithDaily: ParameterValue[] = [];
            try {
              valuesWithDaily = isolateSlice(allValuesWithDaily, targetSlice);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              if (msg.includes('Slice isolation error') && msg.includes('MECE aggregation')) {
                valuesWithDaily = [];
                sessionLogService.addChild(
                  logOpId,
                  'info',
                  'CACHE_SLICE_ISOLATION_MISS',
                  'Cache slice isolation refused implicit cross-slice use; treating as cache miss',
                  msg,
                  { targetSlice }
                );
              } else {
                throw e;
              }
            }
            
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
              
              // Use latest signature if found, otherwise use expected signature.
              // IMPORTANT: this must be the signature we use for cache coverage checks too,
              // otherwise we can incorrectly report "missing" days even when the latest cached
              // values exist (often showing up as "yesterday missing").
              signatureToUse = latestQuerySignature || querySignature;
              
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
          
          // Ensure relevant context definitions are cached before any synchronous MECE/cache-cutting logic runs.
          //
          // Rationale: MECE selection currently uses ContextRegistry's sync detector, which cannot hit IndexedDB.
          // We therefore prime the in-memory cache from IndexedDB here, at the start of fetch analysis.
          try {
            const keys = new Set<string>();
            const valuesForKeyScan: ParameterValue[] = Array.isArray((filteredParamData as any)?.values)
              ? ((filteredParamData as any).values as ParameterValue[])
              : [];
            for (const v of valuesForKeyScan) {
              const dims = extractSliceDimensions(v.sliceDSL ?? '');
              if (!dims) continue;
              const parsed = parseConstraints(dims);
              for (const c of parsed.context) keys.add(c.key);
              for (const group of parsed.contextAny) {
                for (const pair of group.pairs) keys.add(pair.key);
              }
            }
            const repo = (paramFile as any)?.source?.repository;
            const branch = (paramFile as any)?.source?.branch;
            const workspace = repo && branch ? { repository: repo, branch } : undefined;
            await contextRegistry.ensureContextsCached(Array.from(keys), workspace ? { workspace } : undefined);
          } catch (e) {
            // Best-effort: failure to preload contexts must not prevent fetching; it only affects MECE cache-fulfilment.
            const msg = e instanceof Error ? e.message : String(e);
            sessionLogService.addChild(
              logOpId,
              'warning',
              'CONTEXT_PRELOAD_FAILED',
              'Context preload failed; MECE cache fulfilment may be unavailable',
              msg
            );
          }

          // Calculate incremental fetch (pass bustCache flag)
          // Use filtered data so we only consider dates from matching signature
          // CRITICAL: Pass targetSlice (currentDSL) to isolate by context slice
          const incrementalResult = calculateIncrementalFetch(
            filteredParamData,
            requestedWindow,
            signatureToUse,
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
          
          // Report cache analysis to callback (for retrieve-all progress)
          if (onCacheAnalysis) {
            const isCacheHit = !incrementalResult.needsFetch && !bustCache;
            onCacheAnalysis({
              cacheHit: isCacheHit,
              daysToFetch: bustCache ? incrementalResult.totalDays : incrementalResult.daysToFetch,
              gapCount: bustCache ? 1 : incrementalResult.fetchWindows.length,
              daysFromCache: isCacheHit ? incrementalResult.totalDays : incrementalResult.daysAvailable,
              totalDays: incrementalResult.totalDays,
            });
            // Pre-populate fetchStats with cache analysis (may be updated after actual fetch)
            fetchStats.daysFromCache = incrementalResult.daysAvailable;
          }
          
          // If partial refetch is active, we still fetch the immature portion even if cache is complete.
          if (!incrementalResult.needsFetch && !bustCache && refetchPolicy?.type !== 'partial') {
            // All dates already exist - skip fetching (unless bustCache is true)
            shouldSkipFetch = true;
            fetchStats.cacheHit = true;
            fetchStats.daysFromCache = incrementalResult.totalDays;
            fetchStats.daysFetched = 0;
            batchableToastSuccess(`All ${incrementalResult.totalDays} days already cached`, { id: 'das-fetch' });
            console.log('[DataOperationsService] Skipping fetch - all dates already exist');
          } else if (incrementalResult.fetchWindows.length > 0) {
            // We have multiple contiguous gaps - chain requests for each
            // If partial refetch is active, avoid redundant/overlapping fetch windows:
            // - The immature refetchWindow already covers some (or all) missing dates.
            // - Only fetch "mature gaps" outside the refetchWindow.
            if (refetchPolicy?.type === 'partial' && refetchPolicy.refetchWindow && actualFetchWindows.length > 0) {
              const refetch = refetchPolicy.refetchWindow;
              const refetchStart = new Date(refetch.start).getTime();
              const refetchEnd = new Date(refetch.end).getTime();

              const outside = incrementalResult.fetchWindows.filter(w => {
                const ws = new Date(w.start).getTime();
                const we = new Date(w.end).getTime();
                // keep only windows that are NOT fully contained by refetch window
                return !(ws >= refetchStart && we <= refetchEnd);
              });

              // Combine refetch + remaining mature gaps, de-dup exact matches
              const combined = [refetch, ...outside];
              const seen = new Set<string>();
              actualFetchWindows = combined.filter(w => {
                const k = `${w.start}::${w.end}`;
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
              });
              actualFetchWindows = mergeFetchWindows(actualFetchWindows);
            } else {
              actualFetchWindows = incrementalResult.fetchWindows;
            }
            const gapCount = actualFetchWindows.length || incrementalResult.fetchWindows.length;
            const cacheBustText = bustCache ? ' (busting cache)' : '';
            toast.loading(
              `Fetching ${incrementalResult.daysToFetch} missing days across ${gapCount} gap${gapCount > 1 ? 's' : ''}${bustCache ? ' (busting cache)' : ` (${incrementalResult.daysAvailable}/${incrementalResult.totalDays} cached)`}`,
              { id: 'das-fetch' }
            );
          } else if (incrementalResult.fetchWindow) {
            // Fallback to combined window (shouldn't happen, but keep for safety)
            if (refetchPolicy?.type === 'partial' && refetchPolicy.refetchWindow && actualFetchWindows.length > 0) {
              // Avoid redundant single-day gap inside the refetch window
              const refetch = refetchPolicy.refetchWindow;
              const ws = new Date(incrementalResult.fetchWindow.start).getTime();
              const we = new Date(incrementalResult.fetchWindow.end).getTime();
              const rs = new Date(refetch.start).getTime();
              const re = new Date(refetch.end).getTime();
              if (ws >= rs && we <= re) {
                actualFetchWindows = [refetch];
              } else {
                actualFetchWindows = [refetch, incrementalResult.fetchWindow];
              }
              actualFetchWindows = mergeFetchWindows(actualFetchWindows);
            } else {
              actualFetchWindows = [incrementalResult.fetchWindow];
            }
            toast.loading(
              `Fetching ${incrementalResult.daysToFetch} missing days${bustCache ? ' (busting cache)' : ` (${incrementalResult.daysAvailable}/${incrementalResult.totalDays} cached)`}`,
              { id: 'das-fetch' }
            );
          } else if (actualFetchWindows.length === 0) {
            // Fallback to requested window
            actualFetchWindows = [requestedWindow];
            const cacheBustText = bustCache ? ' (busting cache)' : '';
            toast.loading(`Fetching data from source${cacheBustText}...`, { id: 'das-fetch' });
          }
        } else {
          // No parameter file - use requested window (unless already set)
          if (actualFetchWindows.length === 0) {
            actualFetchWindows = [requestedWindow];
            toast.loading(`Fetching data from source...`, { id: 'das-fetch' });
          }
        }
      } else {
        // Not writeToFile mode or no parameter file - use requested window (unless already set)
        if (actualFetchWindows.length === 0) {
          actualFetchWindows = [requestedWindow];
          toast.loading(`Fetching data from source...`, { id: 'das-fetch' });
        }
      }
      
      // If all dates are cached, skip fetching and use existing data
      // IMPORTANT: In dry-run mode, never mutate graph (even by applying cache).
      if (!dontExecuteHttp && shouldSkipFetch && objectType === 'parameter' && objectId && targetId && graph && setGraph) {
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
        return { success: true, cacheHit: true, daysFetched: 0, daysFromCache: fetchStats.daysFromCache };
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

      // ---------------------------------------------------------------------
      // Versioned parameter fetch resilience:
      // Persist each successful gap immediately so partial runs are resumable.
      // ---------------------------------------------------------------------
      const shouldPersistPerGap =
        writeToFile && objectType === 'parameter' && !!objectId && !dontExecuteHttp;

      let paramFileForGapWrites: any | undefined;
      let existingValuesForGapWrites: ParameterValue[] | undefined;
      let sliceDSLForGapWrites: string | undefined;
      let shouldRecomputeForecastForGapWrites = false;
      let latencyConfigForGapWrites: any | undefined;
      let didPersistAnyGap = false;
      let hadGapFailureAfterSomeSuccess = false;
      let gapFailureMessage: string | undefined;
      let failedGapIndex: number | undefined;

      // Track whether we actually attempted external execution (runner.execute) for this call.
      // This is used to avoid misclassifying "executed but returned 0 daily points" as a cache hit.
      let didAttemptExternalFetch = false;
      let expectedDaysAttempted = 0;

      if (shouldPersistPerGap) {
        paramFileForGapWrites = fileRegistry.getFile(`parameter-${objectId}`);
        if (paramFileForGapWrites) {
          existingValuesForGapWrites = (paramFileForGapWrites.data.values || []) as ParameterValue[];
          // CRITICAL: Use targetSlice (the specific slice being fetched), not currentDSL
          sliceDSLForGapWrites = targetSlice || extractSliceDimensions(currentDSL || '');

          const targetEdgeForMerge =
            targetId && graph
              ? graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId)
              : undefined;
          latencyConfigForGapWrites = targetEdgeForMerge?.p?.latency;
          // Always recompute forecast for probability parameters (both latency and non-latency edges).
          // Non-latency edges have latency_parameter: false/undefined and will skip maturity exclusion.
          shouldRecomputeForecastForGapWrites = true;
        }
      }

      const persistGapIfNeeded = async (fetchWindow: DateRange): Promise<void> => {
        // CRITICAL: dry-run simulation must never mutate files.
        if (dontExecuteHttp) {
          return;
        }
        if (
          !shouldPersistPerGap ||
          !paramFileForGapWrites ||
          !existingValuesForGapWrites ||
          !sliceDSLForGapWrites ||
          !objectId
        ) {
          return;
        }

        try {
          const gapTimeSeries = allTimeSeriesData.filter((point: any) => {
            const pointDate = normalizeDate(point.date);
            return isDateInRange(pointDate, fetchWindow);
          });

          if (gapTimeSeries.length > 0) {
            const forecasting = await forecastingSettingsService.getForecastingModelSettings();
            existingValuesForGapWrites = mergeTimeSeriesIntoParameter(
              existingValuesForGapWrites,
              gapTimeSeries,
              fetchWindow,
              querySignature,
              queryParamsForStorage,
              fullQueryForStorage,
              dataSourceType,
              sliceDSLForGapWrites,
              {
                isCohortMode: isCohortQuery,
                ...(shouldRecomputeForecastForGapWrites && {
                  latencyConfig: {
                    latency_parameter: latencyConfigForGapWrites?.latency_parameter,
                    anchor_node_id: latencyConfigForGapWrites?.anchor_node_id,
                    t95: latencyConfigForGapWrites?.t95,
                  },
                  recomputeForecast: true,
                  forecastingConfig: {
                    RECENCY_HALF_LIFE_DAYS: forecasting.RECENCY_HALF_LIFE_DAYS,
                    DEFAULT_T95_DAYS: forecasting.DEFAULT_T95_DAYS,
                  },
                }),
              }
            );
          } else {
            // Cache a "no data" marker for this gap so subsequent runs can skip it.
            //
            // CRITICAL: still route through mergeTimeSeriesIntoParameter so we canonicalise
            // the slice family (prevents value fragmentation like "big slice + 1-day slice").
            const startD = parseDate(normalizeDate(fetchWindow.start));
            const endD = parseDate(normalizeDate(fetchWindow.end));
            const gapZeros: Array<{ date: string; n: number; k: number; p: number }> = [];
            const currentD = new Date(startD);
            while (currentD <= endD) {
              gapZeros.push({ date: currentD.toISOString(), n: 0, k: 0, p: 0 });
              // CRITICAL: Use UTC iteration to avoid DST/local-time drift across long ranges.
              currentD.setUTCDate(currentD.getUTCDate() + 1);
            }

            const forecasting = await forecastingSettingsService.getForecastingModelSettings();
            existingValuesForGapWrites = mergeTimeSeriesIntoParameter(
              existingValuesForGapWrites,
              gapZeros as any,
              fetchWindow,
              querySignature,
              queryParamsForStorage,
              fullQueryForStorage,
              dataSourceType,
              sliceDSLForGapWrites,
              {
                isCohortMode: isCohortQuery,
                ...(shouldRecomputeForecastForGapWrites && {
                  latencyConfig: {
                    latency_parameter: latencyConfigForGapWrites?.latency_parameter,
                    anchor_node_id: latencyConfigForGapWrites?.anchor_node_id,
                    t95: latencyConfigForGapWrites?.t95,
                  },
                  recomputeForecast: true,
                  forecastingConfig: {
                    RECENCY_HALF_LIFE_DAYS: forecasting.RECENCY_HALF_LIFE_DAYS,
                    DEFAULT_T95_DAYS: forecasting.DEFAULT_T95_DAYS,
                  },
                }),
              }
            );
          }

          const updatedFileData = structuredClone(paramFileForGapWrites.data);
          updatedFileData.values = existingValuesForGapWrites;

          // Keep query/n_query synced from graph master on every persisted write.
          if (queryString) {
            updatedFileData.query = queryString;
            if (targetEdge?.query_overridden !== undefined) {
              updatedFileData.query_overridden = targetEdge.query_overridden;
            }
          }
          if (explicitNQuery) {
            updatedFileData.n_query = explicitNQuery;
            if (nQueryEdge?.n_query_overridden !== undefined) {
              updatedFileData.n_query_overridden = nQueryEdge.n_query_overridden;
            }
          } else if (updatedFileData.n_query && !nQueryEdge?.n_query) {
            delete updatedFileData.n_query;
            delete updatedFileData.n_query_overridden;
          }

          await fileRegistry.updateFile(`parameter-${objectId}`, updatedFileData);
          // Keep local reference fresh to avoid stale clones across gaps
          paramFileForGapWrites.data = updatedFileData;
          didPersistAnyGap = true;
        } catch (error) {
          console.error('[DataOperationsService] Failed to persist gap incrementally:', error);
        }
      };
      
      // Chain requests for each contiguous gap
      for (let gapIndex = 0; gapIndex < actualFetchWindows.length; gapIndex++) {
        const fetchWindow = actualFetchWindows[gapIndex];

        // Record whether this gap would be an external fetch (vs dry-run).
        // This must be set before any non-dry-run executeDAS calls.
        if (!dontExecuteHttp) {
          didAttemptExternalFetch = true;
          try {
            const startD = parseDate(normalizeDate(fetchWindow.start));
            const endD = parseDate(normalizeDate(fetchWindow.end));
            if (!Number.isNaN(startD.getTime()) && !Number.isNaN(endD.getTime())) {
              const ms = endD.getTime() - startD.getTime();
              const days = Math.floor(ms / (24 * 60 * 60 * 1000)) + 1; // inclusive
              if (days > 0) expectedDaysAttempted += days;
            }
          } catch {
            // Best-effort only.
          }
        }
        
        // Ensure the payload window reflects the actual window being executed.
        // This is required for plan-interpreter mode (overrideFetchWindows), and is harmless for
        // incremental-gap mode (where fetchWindow == derived gap window).
        const isoWindowForPayload = toISOWindowForDAS(fetchWindow);
        if (queryPayload && typeof queryPayload === 'object') {
          // Window-mode payload
          (queryPayload as any).start = isoWindowForPayload.start;
          (queryPayload as any).end = isoWindowForPayload.end;
          // Cohort-mode payload
          if ((queryPayload as any).cohort && typeof (queryPayload as any).cohort === 'object') {
            (queryPayload as any).cohort = {
              ...(queryPayload as any).cohort,
              start: isoWindowForPayload.start,
              end: isoWindowForPayload.end,
            };
          }
        }
        if (requestedCohort && typeof requestedCohort === 'object') {
          requestedCohort.start = isoWindowForPayload.start;
          requestedCohort.end = isoWindowForPayload.end;
        }

        // =====================================================================
        // DRY RUN & LIVE EXECUTION MUST SHARE THE SAME DAS CALL SHAPE
        //
        // Any fetch “report” generated in dry-run mode must correspond 1:1 with
        // the actual runner.execute calls we would make in a live run. The ONLY
        // intentional divergence is the adapter option { dryRun: true }.
        // =====================================================================
        const executeDAS = async (payload: any, opts?: { dryRun?: boolean }) => {
          return await runner.execute(connectionName, payload, {
            connection_string: connectionString,
            window: toISOWindowForDAS(fetchWindow),
            cohort: requestedCohort,  // A-anchored cohort for latency-tracked edges
            context: { mode: contextMode, excludeTestAccounts },
            edgeId: objectType === 'parameter' ? (targetId || 'unknown') : undefined,
            caseId: objectType === 'case' ? objectId : undefined,
            nodeId: objectType === 'node' ? (targetId || objectId) : undefined,
            eventDefinitions,
            dryRun: opts?.dryRun === true,
          });
        };

        const buildDASFailureDetailsForSessionLog = (r: {
          error?: string;
          phase?: string;
          details?: unknown;
        }): { detailsText: string; context: Record<string, unknown> } => {
          const SENSITIVE_KEY_SUBSTRINGS = [
            'api_key',
            'secret_key',
            'password',
            'token',
            'access_token',
            'refresh_token',
            'authorization',
            'basic_auth',
            'client_secret',
            'service_account',
          ];

          const redactDeep = (value: unknown): unknown => {
            if (value === null || value === undefined) return value;
            if (typeof value !== 'object') return value;
            if (Array.isArray(value)) return value.map(redactDeep);

            const obj = value as Record<string, unknown>;
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(obj)) {
              const lower = k.toLowerCase();
              const isSensitive = SENSITIVE_KEY_SUBSTRINGS.some((s) => lower.includes(s));
              out[k] = isSensitive ? '[REDACTED]' : redactDeep(v);
            }
            return out;
          };

          const safeJson = (value: unknown, maxChars: number): string => {
            try {
              const s = JSON.stringify(redactDeep(value));
              if (s.length <= maxChars) return s;
              return `${s.slice(0, maxChars)}…[truncated]`;
            } catch {
              const s = String(value);
              if (s.length <= maxChars) return s;
              return `${s.slice(0, maxChars)}…[truncated]`;
            }
          };

          const phase = r.phase || 'unknown';
          const detailsObj = (r.details && typeof r.details === 'object') ? (r.details as any) : undefined;
          const httpStatus =
            detailsObj && typeof detailsObj.status === 'number'
              ? (detailsObj.status as number)
              : undefined;

          const lines: string[] = [];
          lines.push(`phase: ${phase}`);
          if (httpStatus !== undefined) lines.push(`http_status: ${httpStatus}`);
          if (r.error) lines.push(`error: ${r.error}`);

          // Always include a small, redacted preview of details so prod session logs remain useful.
          if (r.details !== undefined) {
            lines.push(`details: ${safeJson(r.details, 2000)}`);
          }

          return {
            detailsText: lines.join('\n'),
            context: {
              dasPhase: phase,
              httpStatus,
            },
          };
        };
        
        // Rate limit before making API calls to external providers
        // This centralizes throttling for Amplitude and other rate-limited APIs
        if (!dontExecuteHttp && connectionName) {
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
                { ...baseQueryPayload, window: toISOWindowForDAS(fetchWindow), mode: contextMode },
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
              // If we already persisted earlier gaps, degrade gracefully (file is partially updated).
              if (shouldPersistPerGap && didPersistAnyGap) {
                hadGapFailureAfterSomeSuccess = true;
                gapFailureMessage = errorMsg;
                failedGapIndex = gapIndex;
                sessionLogService.endOperation(
                  logOpId,
                  'warning',
                  `Partial fetch persisted; n_query composite failed on gap ${gapIndex + 1}/${actualFetchWindows.length}: ${errorMsg}`
                );
                break;
              }
              sessionLogService.endOperation(logOpId, 'error', `n_query composite query failed: ${error}`);
              // IMPORTANT: propagate failure so batch operations record a real failure (not a silent success).
              throw new Error(`n_query composite query failed: ${errorMsg}`);
            }
            // Report success to reset rate limiter backoff
            if (connectionName) {
              rateLimiter.reportSuccess(connectionName);
            }
          } else {
            // Simple n_query - direct execution
            const baseResult = await executeDAS(baseQueryPayload);
            
            if (!baseResult.success) {
              console.error('[DataOps:DUAL_QUERY] Base query failed:', baseResult.error);
              // Report rate limit errors to rate limiter for backoff
              if (connectionName && rateLimiter.isRateLimitError(baseResult.error)) {
                rateLimiter.reportRateLimitError(connectionName, baseResult.error);
              }
              toast.error(`Base query failed: ${baseResult.error}`, { id: 'das-fetch' });
              // If we already persisted earlier gaps, degrade gracefully (file is partially updated).
              if (shouldPersistPerGap && didPersistAnyGap) {
                hadGapFailureAfterSomeSuccess = true;
                gapFailureMessage = baseResult.error;
                failedGapIndex = gapIndex;
                sessionLogService.endOperation(
                  logOpId,
                  'warning',
                  `Partial fetch persisted; base query failed on gap ${gapIndex + 1}/${actualFetchWindows.length}: ${baseResult.error}`
                );
                break;
              }
              sessionLogService.endOperation(logOpId, 'error', `Base query failed: ${baseResult.error}`);
              // IMPORTANT: propagate failure so batch operations record a real failure (not a silent success).
              throw new Error(`Base query failed: ${baseResult.error}`);
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
          // - Explicit n_query in anchor-free normal form "to(X)" executed under window(): we want FROM count (n/from_count)
          //   because the synthetic query is "from(X).to(mainTo)" and the denominator is arrivals at X in-window.
          // - Auto-stripped query: we want the FROM count (n/from_count)
          //   because we stripped visited_upstream but kept from/to, so n = all users at 'from'
          if (explicitNQuery) {
            // Explicit n_query: use k (to_count) = users who completed the n_query funnel
            if (explicitNQueryWasToOnlyNormalForm && explicitNQueryWindowDenomUsesFromCount) {
              baseN = baseRaw?.n ?? 0;
              console.log('[DataOps:DUAL_QUERY] Explicit n_query (to(X) window): using n (from_count) as baseN:', baseN);
            } else {
              baseN = baseRaw?.k ?? 0;
              console.log('[DataOps:DUAL_QUERY] Explicit n_query: using k (to_count) as baseN:', baseN);
            }
          } else {
            // Auto-stripped: use n (from_count) = all users at 'from'
            baseN = baseRaw?.n ?? 0;
            console.log('[DataOps:DUAL_QUERY] Auto-stripped: using n (from_count) as baseN:', baseN);
          }
          
          // For time series: same logic - use k values for explicit n_query, n values for auto-stripped
          if (Array.isArray(baseRaw?.time_series)) {
            if (explicitNQuery) {
              // For explicit n_query, the "n" for the main query is the "k" of the n_query
              if (explicitNQueryWasToOnlyNormalForm && explicitNQueryWindowDenomUsesFromCount) {
                baseTimeSeries = baseRaw.time_series.map((day: any) => ({
                  date: day.date,
                  n: day.n,  // Use from_count as n for window-mode to(X)
                  k: day.n,
                  p: day.p
                }));
              } else {
                baseTimeSeries = baseRaw.time_series.map((day: any) => ({
                  date: day.date,
                  n: day.k,  // Use k as n
                  k: day.k,  // (k is the same for reference)
                  p: day.p
                }));
              }
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
        
        // DRY RUN: Build the real DAS request(s) but stop before external HTTP.
        // IMPORTANT: In dry-run mode we do NOT attempt to compute composite inclusion-exclusion results,
        // because that requires real numerical responses. We only show the exact runner.execute calls
        // that would be made for the non-composite pipeline.
        if (dontExecuteHttp) {
          const redactUrlForLog = (url: string): string => {
            try {
              // Redact common secret-bearing query params.
              // (We do not attempt perfect coverage; this is a best-effort safety layer.)
              return url
                .replace(/([?&]api_key=)[^&]+/gi, '$1<redacted>')
                .replace(/([?&]apikey=)[^&]+/gi, '$1<redacted>')
                .replace(/([?&]token=)[^&]+/gi, '$1<redacted>')
                .replace(/([?&]access_token=)[^&]+/gi, '$1<redacted>');
            } catch {
              return url;
            }
          };

          const redactRequestForLog = (req: any): any => {
            if (!req || typeof req !== 'object') return req;
            const out: any = structuredClone(req);
            if (typeof out.url === 'string') {
              out.url = redactUrlForLog(out.url);
            }
            if (out.headers && typeof out.headers === 'object') {
              for (const [k, v] of Object.entries(out.headers)) {
                const key = String(k);
                if (/authorization|cookie|x-api-key|api-key|apikey/i.test(key)) {
                  out.headers[key] = '<redacted>';
                } else {
                  out.headers[key] = v;
                }
              }
            }
            return out;
          };

          const toCurlCommandForLog = (req: any): string | undefined => {
            if (!req?.method || !req?.url) return undefined;
            const method = String(req.method).toUpperCase();
            const url = String(req.url);
            const parts: string[] = [`curl -X ${method} '${url}'`];
            const headers = req.headers && typeof req.headers === 'object' ? req.headers : undefined;
            if (headers) {
              for (const [k, v] of Object.entries(headers)) {
                if (v === undefined || v === null) continue;
                parts.push(`-H '${String(k)}: ${String(v)}'`);
              }
            }
            // Prefer explicit body fields if present.
            const body = (req.body ?? req.data ?? req.payload) as unknown;
            if (body !== undefined && body !== null && method !== 'GET') {
              const bodyStr =
                typeof body === 'string'
                  ? body
                  : (() => {
                      try { return JSON.stringify(body); } catch { return String(body); }
                    })();
              parts.push(`--data-raw '${bodyStr.replace(/'/g, `'\"'\"'`)}'`);
            }
            return parts.join(' ');
          };

          const runDry = async (label: string, payload: any) => {
            const dry = await executeDAS(payload, { dryRun: true });

            const req = (dry.success ? (dry.raw as any)?.request : undefined) as any;
            const reqRedacted = req ? redactRequestForLog(req) : undefined;
            const curl = reqRedacted ? toCurlCommandForLog(reqRedacted) : undefined;
            sessionLogService.addChild(
              logOpId,
              'info',
              'DRY_RUN_HTTP',
              `DRY RUN: would call HTTP (${label})`,
              curl ?? (reqRedacted ? `${reqRedacted.method} ${reqRedacted.url}` : undefined),
              reqRedacted ? { request: reqRedacted, httpCommand: curl } : undefined
            );
          };

          if (isComposite) {
            sessionLogService.addChild(
              logOpId,
              'warning',
              'DRY_RUN_COMPOSITE',
              'DRY RUN: composite query detected (minus/plus); not enumerating sub-queries in dry-run yet',
              queryString
            );
            // Still show the single top-level request that would have been executed in the simple path
            // (this is useful for visibility even though actual execution would call composite executor).
            await runDry('composite-top-level', queryPayload);
          } else if (needsDualQuery && baseQueryPayload) {
            await runDry('base (n_query)', baseQueryPayload);
            await runDry('conditioned (k query)', queryPayload);
          } else {
            await runDry('simple', queryPayload);
          }

          // Do not mutate files or graph in dry-run mode.
          continue;
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
              { ...queryPayload, window: toISOWindowForDAS(fetchWindow), mode: contextMode },
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
                await persistGapIfNeeded(fetchWindow);
              } else {
                console.warn(`[DataOperationsService] No time-series in composite result for gap ${gapIndex + 1}`, combined);
                toast.error(`Composite query returned no daily data for gap ${gapIndex + 1}`, { id: 'das-fetch' });
                // If we already persisted earlier gaps, degrade gracefully (file is partially updated).
                if (shouldPersistPerGap && didPersistAnyGap) {
                  hadGapFailureAfterSomeSuccess = true;
                  gapFailureMessage = 'Composite query returned no daily data';
                  failedGapIndex = gapIndex;
                  sessionLogService.endOperation(
                    logOpId,
                    'warning',
                    `Partial fetch persisted; composite query returned no daily data on gap ${gapIndex + 1}/${actualFetchWindows.length}`
                  );
                  break;
                }
                sessionLogService.endOperation(logOpId, 'error', `Composite query returned no daily data for gap ${gapIndex + 1}`);
                return errorResult;
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
            // If we already persisted earlier gaps, degrade gracefully (file is partially updated).
            if (shouldPersistPerGap && didPersistAnyGap) {
              hadGapFailureAfterSomeSuccess = true;
              gapFailureMessage = errorMsg;
              failedGapIndex = gapIndex;
              sessionLogService.endOperation(
                logOpId,
                'warning',
                `Partial fetch persisted; composite query failed on gap ${gapIndex + 1}/${actualFetchWindows.length}: ${errorMsg}`
              );
              break;
            }
            sessionLogService.endOperation(logOpId, 'error', `Composite query failed: ${errorMsg}`);
            // IMPORTANT: propagate failure so batch operations record a real failure (not a silent success).
            throw new Error(`Composite query failed: ${errorMsg}`);
          }
          // Report success to reset rate limiter backoff
          if (connectionName) {
            rateLimiter.reportSuccess(connectionName);
          }
          
        } else if (needsDualQuery && baseQueryPayload) {
          // DUAL QUERY (simple): Already have base n, now get k from conditioned query
          console.log('[DataOps:DUAL_QUERY] Running conditioned query (for k)...');
          
          const condResult = await executeDAS(queryPayload);
          
          if (!condResult.success) {
            console.error('[DataOps:DUAL_QUERY] Conditioned query failed:', condResult.error);

            const failure = buildDASFailureDetailsForSessionLog(condResult);
            sessionLogService.addChild(
              logOpId,
              'error',
              'DAS_FAILURE_DETAILS',
              `Conditioned query failed (gap ${gapIndex + 1}/${actualFetchWindows.length})`,
              failure.detailsText,
              failure.context
            );

            // Report rate limit errors to rate limiter for backoff
            if (connectionName && rateLimiter.isRateLimitError(condResult.error)) {
              rateLimiter.reportRateLimitError(connectionName, condResult.error);
            }
            toast.error(`Conditioned query failed: ${condResult.error}`, { id: 'das-fetch' });
            // If we already persisted earlier gaps, degrade gracefully (file is partially updated).
            if (shouldPersistPerGap && didPersistAnyGap) {
              hadGapFailureAfterSomeSuccess = true;
              gapFailureMessage = condResult.error;
              failedGapIndex = gapIndex;
              sessionLogService.endOperation(
                logOpId,
                'warning',
                `Partial fetch persisted; conditioned query failed on gap ${gapIndex + 1}/${actualFetchWindows.length}: ${condResult.error}`,
                failure.context
              );
              break;
            }
            sessionLogService.endOperation(
              logOpId,
              'error',
              `Conditioned query failed: ${condResult.error}`,
              failure.context
            );
            // IMPORTANT: propagate failure so batch operations record a real failure (not a silent success).
            throw new Error(`Conditioned query failed: ${condResult.error}`);
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
            await persistGapIfNeeded(fetchWindow);
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
          const result = await executeDAS(queryPayload);
          
          // Capture DAS execution history for session logs (request/response details)
          // Only include verbose data when diagnostic logging is enabled to avoid bloating logs.
          if (sessionLogService.getDiagnosticLoggingEnabled()) {
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

            const failure = buildDASFailureDetailsForSessionLog(result);
            sessionLogService.addChild(
              logOpId,
              'error',
              'DAS_FAILURE_DETAILS',
              `DAS execution failed (gap ${gapIndex + 1}/${actualFetchWindows.length})`,
              failure.detailsText,
              failure.context
            );
            
            // Report rate limit errors to rate limiter for backoff
            if (connectionName && rateLimiter.isRateLimitError(result.error)) {
              rateLimiter.reportRateLimitError(connectionName, result.error);
            }
            
            // Show user-friendly message in toast
            const userMessage = result.error || 'Failed to fetch data from source';
            toast.error(`${userMessage} (gap ${gapIndex + 1}/${actualFetchWindows.length})`, { id: 'das-fetch' });
            // If we already persisted earlier gaps, degrade gracefully (file is partially updated).
            if (shouldPersistPerGap && didPersistAnyGap) {
              hadGapFailureAfterSomeSuccess = true;
              gapFailureMessage = userMessage;
              failedGapIndex = gapIndex;
              sessionLogService.endOperation(
                logOpId,
                'warning',
                `Partial fetch persisted; API failed on gap ${gapIndex + 1}/${actualFetchWindows.length}: ${userMessage}`,
                failure.context
              );
              break;
            }
            sessionLogService.endOperation(logOpId, 'error', `API call failed: ${userMessage}`, failure.context);
            // IMPORTANT: propagate failure so batch operations record a real failure (not a silent success).
            throw new Error(`API call failed: ${userMessage}`);
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
          const timeSeriesPoints = Array.isArray(rawData?.time_series) ? rawData.time_series.length : 0;
          if (timeSeriesPoints > 0) {
            responseDesc.push(`${timeSeriesPoints} daily points`);
          }
          if (rawData?.n !== undefined) responseDesc.push(`n=${rawData.n}`);
          if (rawData?.k !== undefined) responseDesc.push(`k=${rawData.k}`);
          if (rawData?.p_mean !== undefined) responseDesc.push(`p=${((rawData.p_mean as number) * 100).toFixed(2)}%`);
          if (rawData?.variants_update) responseDesc.push(`${rawData.variants_update.length} variants`);
          
          // Provide meaningful description even when no daily breakdown
          const finalDesc = responseDesc.length > 0 
            ? responseDesc.join(', ')
            : 'aggregate data (no daily breakdown)';

          const expectedDaysInFetchWindow = (() => {
            try {
              const startD = parseDate(normalizeDate(fetchWindow.start));
              const endD = parseDate(normalizeDate(fetchWindow.end));
              if (Number.isNaN(startD.getTime()) || Number.isNaN(endD.getTime())) return undefined;
              const ms = endD.getTime() - startD.getTime();
              const days = Math.floor(ms / (24 * 60 * 60 * 1000)) + 1; // inclusive
              return days > 0 ? days : undefined;
            } catch {
              return undefined;
            }
          })();
          
          sessionLogService.addChild(logOpId, 'success', 'API_RESPONSE',
            `Received: ${finalDesc}`,
            `Fetched window: ${normalizeDate(fetchWindow.start)} to ${normalizeDate(fetchWindow.end)}${expectedDaysInFetchWindow ? ` (${expectedDaysInFetchWindow}d)` : ''}`,
            { 
              rowCount: timeSeriesPoints || result.updates?.length || 1,
              fetched: {
                window: {
                  start: normalizeDate(fetchWindow.start),
                  end: normalizeDate(fetchWindow.end),
                  expectedDays: expectedDaysInFetchWindow,
                },
                timeSeriesPoints,
              },
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
            await persistGapIfNeeded(fetchWindow);
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
      
      // Update fetch stats with actual results
      fetchStats.daysFetched = fetchedDays;
      // cacheHit should mean "served from cache / skipped external fetch", not "executed but returned empty".
      fetchStats.cacheHit = (!didAttemptExternalFetch && fetchedDays === 0 && !bustCache);

      // If we executed plan-interpreter windows and received no daily points, emit an explicit log entry.
      // This is not necessarily an error, but it is surprising and should be visible in batch runs.
      if (
        !dontExecuteHttp &&
        hasOverrideWindows &&
        writeToFile &&
        objectType === 'parameter' &&
        fetchedDays === 0 &&
        actualFetchWindows.length > 0
      ) {
        sessionLogService.addChild(
          logOpId,
          'warning',
          'FETCH_NO_DATA_RETURNED',
          `No daily datapoints returned for ${objectId} (executed ${actualFetchWindows.length} plan window(s))`,
          `Windows: ${gapsDesc}`,
          {
            source: connectionName || 'unknown',
            fileId: `parameter-${objectId}`,
            gapsCount: actualFetchWindows.length,
            expectedDays: expectedDaysAttempted || undefined,
            windows: actualFetchWindows.map((w) => ({
              start: normalizeDate(w.start),
              end: normalizeDate(w.end),
            })),
          }
        );
      }
      
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
        // Summarise the effective fetch window across gaps for evidence provenance.
        // (The per-gap `fetchWindow` variable is scoped to the loop above.)
        const toDateSafe = (v: any): Date | undefined => {
          if (!v) return undefined;
          if (v instanceof Date) return v;
          if (typeof v === 'string') {
            // Prefer ISO timestamps
            if (v.includes('T')) {
              const d = new Date(v);
              return Number.isNaN(d.getTime()) ? undefined : d;
            }
            // DagNet uses UK date strings (d-MMM-yy) and relative dates; parse those.
            try {
              const uk = resolveRelativeDate(v);
              return parseUKDate(uk);
            } catch {
              const d = new Date(v);
              return Number.isNaN(d.getTime()) ? undefined : d;
            }
          }
          return undefined;
        };

        const starts = actualFetchWindows.map((w) => toDateSafe((w as any).start)).filter(Boolean) as Date[];
        const ends = actualFetchWindows.map((w) => toDateSafe((w as any).end)).filter(Boolean) as Date[];
        const evidenceWindow =
          starts.length > 0 && ends.length > 0
            ? {
                start: new Date(Math.min(...starts.map((d) => d.getTime()))),
                end: new Date(Math.max(...ends.map((d) => d.getTime()))),
              }
            : undefined;

        // Also store evidence-level provenance fields (used by UI + runner evidence mode).
        // These MUST reflect the actual fetched window, otherwise logs and E-mode computations
        // can remain stale even when n/k changed.
        updateData.window_from = evidenceWindow?.start ? evidenceWindow.start.toISOString() : undefined;
        updateData.window_to = evidenceWindow?.end ? evidenceWindow.end.toISOString() : undefined;
        updateData.retrieved_at = new Date().toISOString();
        updateData.source = connectionName?.includes('amplitude')
          ? 'amplitude'
          : connectionName?.includes('statsig')
          ? 'statsig'
          : 'api';

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
      // CRITICAL: dry-run simulation must never mutate files.
      if (!dontExecuteHttp && writeToFile && objectType === 'parameter' && objectId) {
        try {
          // If we already persisted incrementally per-gap, do not bulk-merge/write again here.
          // The post-fetch getParameterFromFile step will still refresh the graph from file.
          if (shouldPersistPerGap && didPersistAnyGap) {
            sessionLogService.addChild(
              logOpId,
              hadGapFailureAfterSomeSuccess ? 'warning' : 'success',
              'FILE_UPDATED',
              `Updated parameter file incrementally: ${objectId}`,
              hadGapFailureAfterSomeSuccess
                ? `Partial fetch persisted; failed on gap ${(failedGapIndex ?? 0) + 1}/${actualFetchWindows.length}`
                : `Persisted ${allTimeSeriesData.length} day${allTimeSeriesData.length !== 1 ? 's' : ''} across ${actualFetchWindows.length} gap${actualFetchWindows.length !== 1 ? 's' : ''}`,
              {
                fileId: `parameter-${objectId}`,
                rowCount: allTimeSeriesData.length,
                gapsCount: actualFetchWindows.length,
                failedGapIndex,
              }
            );
          } else {
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
            // Always recompute forecast for probability parameters (both latency and non-latency edges).
            // Non-latency edges have latency_parameter: false/undefined and will skip maturity exclusion.
            const shouldRecomputeForecast = true;
            
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
                  const forecasting = await forecastingSettingsService.getForecastingModelSettings();
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
                          latency_parameter: latencyConfigForMerge?.latency_parameter,
                          anchor_node_id: latencyConfigForMerge?.anchor_node_id,
                          // CRITICAL: t95 is required to exclude immature window days when computing forecast baseline.
                          // Without this, recomputeForecast degenerates to forecast≈mean which is systematically low.
                          t95: latencyConfigForMerge?.t95,
                        },
                        recomputeForecast: true,
                        forecastingConfig: {
                          RECENCY_HALF_LIFE_DAYS: forecasting.RECENCY_HALF_LIFE_DAYS,
                          DEFAULT_T95_DAYS: forecasting.DEFAULT_T95_DAYS,
                        },
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
                // No-data marker, but still run through mergeTimeSeriesIntoParameter so we:
                // - coalesce with any existing slice family
                // - canonicalise sliceDSL + headers for coverage checks
                const startD = parseDate(normalizeDate(fetchWindow.start));
                const endD = parseDate(normalizeDate(fetchWindow.end));
                const gapZeros: Array<{ date: string; n: number; k: number; p: number }> = [];
                const currentD = new Date(startD);
                while (currentD <= endD) {
                  gapZeros.push({ date: currentD.toISOString(), n: 0, k: 0, p: 0 });
                  // CRITICAL: Use UTC iteration to avoid DST/local-time drift across long ranges.
                  currentD.setUTCDate(currentD.getUTCDate() + 1);
                }

                const forecasting = await forecastingSettingsService.getForecastingModelSettings();
                existingValues = mergeTimeSeriesIntoParameter(
                  existingValues,
                  gapZeros as any,
                  fetchWindow,
                  querySignature,
                  queryParamsForStorage,
                  fullQueryForStorage,
                  dataSourceType,
                  sliceDSL, // CRITICAL: Pass slice family identifier for isolateSlice matching
                  {
                    isCohortMode: isCohortQuery,
                    ...(shouldRecomputeForecast && {
                      latencyConfig: {
                        latency_parameter: latencyConfigForMerge?.latency_parameter,
                        anchor_node_id: latencyConfigForMerge?.anchor_node_id,
                        t95: latencyConfigForMerge?.t95,
                      },
                      recomputeForecast: true,
                      forecastingConfig: {
                        RECENCY_HALF_LIFE_DAYS: forecasting.RECENCY_HALF_LIFE_DAYS,
                        DEFAULT_T95_DAYS: forecasting.DEFAULT_T95_DAYS,
                      },
                    }),
                  }
                );
                
                console.log(`[DataOperationsService] Cached "no data" marker for slice:`, {
                  paramId: objectId,
                  sliceDSL,
                  fetchWindow,
                  days: gapZeros.length,
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
            
            // Log merged coverage for this slice (distinct from "new days fetched").
            // This helps explain cache-cutting runs where we fetch only gaps but the merged slice covers a larger window.
            let mergedCoverage: { uniqueDays: number; from?: string; to?: string } | undefined;
            try {
              const normalizedSlice = sliceDSL ? normalizeConstraintString(sliceDSL) : '';
              if (normalizedSlice) {
                const matching = existingValues.filter(v => {
                  if (!v.sliceDSL) return false;
                  return normalizeConstraintString(v.sliceDSL) === normalizedSlice;
                });
                const dateSet = new Set<string>();
                for (const v of matching) {
                  if (Array.isArray((v as any).dates)) {
                    for (const d of (v as any).dates) {
                      if (d) dateSet.add(normalizeDate(resolveRelativeDate(d)));
                    }
                  }
                }
                const sorted = [...dateSet].sort();
                mergedCoverage = {
                  uniqueDays: dateSet.size,
                  from: sorted[0],
                  to: sorted[sorted.length - 1],
                };
              }
            } catch {
              // Best-effort logging only.
            }
            
            // Log file update
            sessionLogService.addChild(logOpId, 'success', 'FILE_UPDATED',
              `Updated parameter file: ${objectId}`,
              `Added ${allTimeSeriesData.length > 0 ? allTimeSeriesData.length + ' new day' + (allTimeSeriesData.length !== 1 ? 's' : '') : '"no data" marker'}${mergedCoverage ? `; merged slice now covers ${mergedCoverage.uniqueDays}d${mergedCoverage.from && mergedCoverage.to ? ` (${normalizeDate(mergedCoverage.from)} to ${normalizeDate(mergedCoverage.to)})` : ''}` : ''}`,
              { 
                fileId: `parameter-${objectId}`,
                rowCount: allTimeSeriesData.length,
                fetchedDays: allTimeSeriesData.length,
                mergedCoverage,
              });
          } else {
            console.warn('[DataOperationsService] Parameter file not found, skipping time-series storage');
          }
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
          // Don't show missing data toast during batch operations (e.g. retrieveall), and also suppress
          // when user explicitly busts cache (they already expect churn/incompleteness).
          suppressMissingDataToast: isBatchMode() || bustCache,
          conditionalIndex, // Pass through for conditional_p handling
        });
      }
      
      // 6b. For versioned case fetches: write schedule entry to case file
      // NOTE: Controlled by versionedCase flag, NOT writeToFile (writeToFile is parameter-specific and for parameters only)
      // CRITICAL: dry-run simulation must never mutate files.
      if (!dontExecuteHttp && versionedCase && objectType === 'case' && objectId && lastResultRaw) {
        try {
          const caseFileId = `case-${objectId}`;
          const caseFile = fileRegistry.getFile(caseFileId);
          
          if (!caseFile) {
            console.error('[DataOperationsService] Case file not found for versioned case fetch:', { caseFileId });
            toast.error(`Case file not found: ${objectId}`);
            sessionLogService.endOperation(logOpId, 'error', `Case file not found: ${objectId}`);
            return errorResult;
          }
          
          // Extract variants from transform output
          const variants = lastResultRaw.variants_update || lastResultRaw.variants;
          if (!variants) {
            console.error('[DataOperationsService] No variants found in transform output');
            toast.error('No variant data returned from Statsig');
            sessionLogService.endOperation(logOpId, 'error', 'No variant data returned from Statsig');
            return errorResult;
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
          return errorResult;
        }
        
        // Find the target edge
        const targetEdge = graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId);
        if (!targetEdge) {
          console.error('[DataOperationsService] Target edge not found in graph', {
            targetId, edgeCount: graph.edges?.length
          });
          toast.error('Target edge not found in graph');
          sessionLogService.endOperation(logOpId, 'error', 'Target edge not found in graph');
          return errorResult;
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
                ? {
                    n: updateData.n,
                    k: updateData.k,
                    window_from: updateData.window_from,
                    window_to: updateData.window_to,
                    retrieved_at: updateData.retrieved_at,
                    source: updateData.source,
                  }
                : undefined,
              data_source: updateData.data_source
            },
            { respectOverrides: true }
          );
          
          // Check if graph actually changed (UpdateManager returns original if no changes)
          if (nextGraph === graph) {
            toast('No changes applied (fields may be overridden)', { icon: 'ℹ️' });
            sessionLogService.endOperation(logOpId, 'success', `No changes to conditional_p[${conditionalIndex}] (overridden)`);
            return { success: true, ...fetchStats };
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
          return { success: true, ...fetchStats };  // Done - skip the base edge path below
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
          return errorResult;
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
          return errorResult;
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
          return errorResult;
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
          return errorResult;
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
        `Completed: ${entityLabel} (slice: ${sliceLabelForLog})`,
        { sourceType: connectionName, slice: sliceDimensionsForLog || undefined, sliceDSL: sliceDSLForLog || undefined });
      
      return { success: true, ...fetchStats };
      
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Error: ${message}`);
      console.error('getFromSourceDirect error:', error);
      sessionLogService.endOperation(logOpId, 'error', `Data fetch failed: ${message}`);
      // CRITICAL: propagate failure so callers (e.g. batch operations) can record failures correctly.
      // Without this, fetch errors can be logged but still counted as success.
      throw (error instanceof Error ? error : new Error(message));
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
   * Open forecasting settings (shared settings/settings.yaml)
   *
   * NOTE: This is a shared, repo-committed file. Changes affect analytics results across clients.
   */
  async openForecastingSettings(): Promise<void> {
    const { fileOperationsService } = await import('./fileOperationsService');
    const settingsItem = {
      id: 'settings',
      type: 'settings' as const,
      name: 'Forecasting settings',
      path: 'settings/settings.yaml',
    };

    await fileOperationsService.openFile(settingsItem, {
      viewMode: 'interactive',
      switchIfExists: true,
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
   * (Removed) Sync status modal entry-point.
   *
   * This was a Phase-2 stub that only showed a toast, and was wired into the ⚡ menu.
   * Placeholder menu items should not ship; reintroduce only when the modal is implemented.
   */
  // async openSyncStatus(...) { ... }  // Intentionally removed.
  
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

  // ===========================================================================
  // ===========================================================================
  // DRY RUN / SIMULATION
  //
  // Simulation is implemented by running the REAL retrieval codepaths (e.g. Retrieve All)
  // with dontExecuteHttp=true, which produces DRY_RUN_HTTP session log entries.
  // There is intentionally no bespoke "markdown narrative" pathway.
  // ===========================================================================


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
    targetSlice: string | undefined,
    options?: {
      logOpId?: string;
      t95Days?: number;
      t95Source?: 'edge' | 'file_latency' | 'none' | 'unknown';
      forecasting?: import('./forecastingSettingsService').ForecastingModelSettings;
    }
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

    const computeRecencyWeightedMatureForecast = (args: {
      bestWindow: any;
      // Use a conservative maturity threshold (days) when we can infer it; otherwise fall back
      t95Days?: number;
      /** As-of date for maturity + recency weighting. Must be max(window date) when available. */
      asOfDate: Date;
    }): { mean?: number; weightedN: number; weightedK: number; maturityDays: number; usedAllDaysFallback: boolean } => {
      const { bestWindow, t95Days, asOfDate } = args;
      const dates: string[] | undefined = bestWindow?.dates;
      const nDaily: number[] | undefined = bestWindow?.n_daily;
      const kDaily: number[] | undefined = bestWindow?.k_daily;
      if (!Array.isArray(dates) || !Array.isArray(nDaily) || !Array.isArray(kDaily)) {
        return { mean: undefined, weightedN: 0, weightedK: 0, maturityDays: 0, usedAllDaysFallback: false };
      }
      if (dates.length === 0 || nDaily.length !== dates.length || kDaily.length !== dates.length) {
        return { mean: undefined, weightedN: 0, weightedK: 0, maturityDays: 0, usedAllDaysFallback: false };
      }

      // Mature cutoff: exclude the most recent (ceil(t95)+1) days, which are systematically under-counted for lagged conversions.
      // If we don't have t95, fall back to DEFAULT_T95_DAYS for safety.
      // Special case: non-latency edges should NOT apply any maturity censoring.
      // We represent that by passing t95Days=0.
      const hasExplicitNoCensor = t95Days === 0;
      const defaultT95 =
        typeof options?.forecasting?.DEFAULT_T95_DAYS === 'number' && Number.isFinite(options.forecasting.DEFAULT_T95_DAYS)
          ? options.forecasting.DEFAULT_T95_DAYS
          : DEFAULT_T95_DAYS;
      const halfLife =
        typeof options?.forecasting?.RECENCY_HALF_LIFE_DAYS === 'number' &&
        Number.isFinite(options.forecasting.RECENCY_HALF_LIFE_DAYS) &&
        options.forecasting.RECENCY_HALF_LIFE_DAYS > 0
          ? options.forecasting.RECENCY_HALF_LIFE_DAYS
          : RECENCY_HALF_LIFE_DAYS;

      const effectiveT95 =
        hasExplicitNoCensor
          ? 0
          : ((t95Days !== undefined && Number.isFinite(t95Days) && t95Days > 0) ? t95Days : defaultT95);
      const maturityDays = hasExplicitNoCensor ? 0 : (Math.ceil(effectiveT95) + 1);
      const cutoffMs = hasExplicitNoCensor
        ? Number.POSITIVE_INFINITY
        : (asOfDate.getTime() - maturityDays * 24 * 60 * 60 * 1000);

      let weightedN = 0;
      let weightedK = 0;
      let totalNAll = 0;
      let totalKAll = 0;

      for (let i = 0; i < dates.length; i++) {
        const d = parseDate(dates[i]);
        if (Number.isNaN(d.getTime())) continue;
        const n = typeof nDaily[i] === 'number' ? nDaily[i] : 0;
        const k = typeof kDaily[i] === 'number' ? kDaily[i] : 0;
        if (n <= 0) continue;

        totalNAll += n;
        totalKAll += k;

        if (d.getTime() > cutoffMs) {
          // Immature day → exclude from baseline forecast
          continue;
        }

        const ageDays = Math.max(0, (asOfDate.getTime() - d.getTime()) / (24 * 60 * 60 * 1000));
        // Mirror statisticalEnhancementService: true half-life semantics.
        const w = Math.exp(-Math.LN2 * ageDays / halfLife);

        weightedN += w * n;
        weightedK += w * k;
      }

      if (weightedN > 0) {
        return { mean: weightedK / weightedN, weightedN, weightedK, maturityDays, usedAllDaysFallback: false };
      }

      // Fallback: censoring left no mature days; use full-window mean if available.
      if (totalNAll > 0) {
        return { mean: totalKAll / totalNAll, weightedN: totalNAll, weightedK: totalKAll, maturityDays, usedAllDaysFallback: true };
      }

      return { mean: undefined, weightedN: 0, weightedK: 0, maturityDays, usedAllDaysFallback: false };
    };
    
    // === 2) Forecast scalars (query-time recompute from matching window() slice daily arrays) ===
    // This applies to BOTH cohort() and window() queries:
    // - For cohort() queries: find the window baseline slice (dual-slice retrieval, design.md §4.6)
    // - For window() queries: the aggregated slice itself may have forecast, or find a matching window slice
    //
    // The presence of p.forecast.mean should NOT depend on whether the edge is "latency" or not;
    // it should depend only on whether a window baseline with forecast exists.
    if (targetSlice && originalParamData?.values && Array.isArray(originalParamData.values)) {
      const targetDims = extractSliceDimensions(targetSlice);
      const originalValues = originalParamData.values as ParameterValue[];
      
      const allWindowValues = originalValues.filter((v) => {
        if (!v.sliceDSL) return false;
        const parsed = parseConstraints(v.sliceDSL);
        return !!parsed.window && !parsed.cohort;
      });

      const isDailyCapable = (v: ParameterValue): boolean => {
        const dates: unknown = (v as any).dates;
        const nDaily: unknown = (v as any).n_daily;
        const kDaily: unknown = (v as any).k_daily;
        return (
          Array.isArray(dates) &&
          Array.isArray(nDaily) &&
          Array.isArray(kDaily) &&
          dates.length > 0 &&
          nDaily.length === dates.length &&
          kDaily.length === dates.length
        );
      };

      type DailyAccessor = {
        sliceDSL: string;
        recencyMs: number;
        startMs: number;
        endMs: number;
        coverageDays: number;
        hasDaily: boolean;
        getNKForDay: (dayUK: string) => { covered: boolean; n: number; k: number };
      };

      const buildDailyAccessor = (v: ParameterValue): DailyAccessor | null => {
        const sliceDSL = v.sliceDSL ?? '';
        if (!sliceDSL.trim()) return null;
        const recencyMs = parameterValueRecencyMs(v);

        const hasDaily = isDailyCapable(v);
        const dates: string[] = hasDaily ? ((v as any).dates as string[]) : [];
        const nDaily: number[] = hasDaily ? ((v as any).n_daily as number[]) : [];
        const kDaily: number[] = hasDaily ? ((v as any).k_daily as number[]) : [];

        // Coverage bounds: prefer explicit window_from/window_to; fall back to min/max of dates.
        let startMs = Number.POSITIVE_INFINITY;
        let endMs = Number.NEGATIVE_INFINITY;
        try {
          if (typeof (v as any).window_from === 'string' && String((v as any).window_from).trim()) {
            startMs = parseDate(String((v as any).window_from)).getTime();
          }
        } catch {
          // ignore
        }
        try {
          if (typeof (v as any).window_to === 'string' && String((v as any).window_to).trim()) {
            endMs = parseDate(String((v as any).window_to)).getTime();
          }
        } catch {
          // ignore
        }

        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
          if (hasDaily) {
            for (const ds of dates) {
              try {
                const t = parseDate(ds).getTime();
                if (!Number.isNaN(t)) {
                  if (t < startMs) startMs = t;
                  if (t > endMs) endMs = t;
                }
              } catch {
                // ignore
              }
            }
          }
        }

        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
          // No usable bounds; treat as non-covering.
          return {
            sliceDSL,
            recencyMs,
            startMs: Number.POSITIVE_INFINITY,
            endMs: Number.NEGATIVE_INFINITY,
            coverageDays: 0,
            hasDaily,
            getNKForDay: () => ({ covered: false, n: 0, k: 0 }),
          };
        }

        const coverageDays = Math.max(1, Math.floor((endMs - startMs) / (24 * 60 * 60 * 1000)) + 1);

        // Index for sparse arrays; missing day within coverage counts as 0 (thin day), not “invalid”.
        const index = new Map<string, number>();
        if (hasDaily) {
          for (let i = 0; i < dates.length; i++) index.set(dates[i], i);
        }

        const getNKForDay = (dayUK: string): { covered: boolean; n: number; k: number } => {
          let t = Number.NaN;
          try {
            t = parseDate(dayUK).getTime();
          } catch {
            return { covered: false, n: 0, k: 0 };
          }
          if (Number.isNaN(t)) return { covered: false, n: 0, k: 0 };
          if (t < startMs || t > endMs) return { covered: false, n: 0, k: 0 };
          if (!hasDaily) return { covered: true, n: 0, k: 0 };
          const i = index.get(dayUK);
          if (i === undefined) {
            // Missing day within declared coverage → treat as 0 contribution.
            return { covered: true, n: 0, k: 0 };
          }
          const n = typeof nDaily[i] === 'number' && Number.isFinite(nDaily[i]) ? nDaily[i] : 0;
          const k = typeof kDaily[i] === 'number' && Number.isFinite(kDaily[i]) ? kDaily[i] : 0;
          return { covered: true, n, k };
        };

        return { sliceDSL, recencyMs, startMs, endMs, coverageDays, hasDaily, getNKForDay };
      };

      // Find window() slices in the same param file with matching context/case dimensions (for contexted queries).
      const contextMatchedWindowCandidates = allWindowValues.filter((v) => extractSliceDimensions(v.sliceDSL ?? '') === targetDims);

      // For uncontexted queries, we may also synthesise an implicit-uncontexted MECE baseline on a per-day basis.
      const isUncontextedTarget = targetDims === '';
      const bestMECE = isUncontextedTarget ? findBestMECEPartitionCandidateSync(allWindowValues, { requireComplete: true }) : null;
      const meceKey = bestMECE?.key;
      const meceWarnings = bestMECE?.warnings;

      // Build accessors for:
      // - context-matching (always) OR explicit uncontexted (when targetDims === '')
      // - MECE member slices (uncontexted only)
      const explicitAccessorsRaw =
        isUncontextedTarget
          ? allWindowValues.filter((v) => extractSliceDimensions(v.sliceDSL ?? '') === '')
          : contextMatchedWindowCandidates;
      const explicitAccessors = explicitAccessorsRaw.map(buildDailyAccessor).filter((a): a is DailyAccessor => !!a);

      // Group MECE accessors by the MECE key's value (e.g. channel=paid-search).
      const meceByValue = new Map<string, DailyAccessor[]>();
      if (bestMECE && meceKey) {
        for (const pv of bestMECE.values) {
          const dims = extractSliceDimensions(pv.sliceDSL ?? '');
          const parsed = parseConstraints(dims);
          const ctx = parsed.context?.[0];
          if (!ctx || ctx.key !== meceKey) continue;
          const acc = buildDailyAccessor(pv);
          if (!acc) continue;
          const arr = meceByValue.get(ctx.value) ?? [];
          arr.push(acc);
          meceByValue.set(ctx.value, arr);
        }
      }

      const anyDailyInputs =
        explicitAccessors.some((a) => a.hasDaily) ||
        Array.from(meceByValue.values()).some((arr) => arr.some((a) => a.hasDaily));

      if (anyDailyInputs) {
        // Meta-slice day range: union of all candidate coverage intervals (greedy temporally-wide).
        const allBounds: Array<{ startMs: number; endMs: number }> = [];
        for (const a of explicitAccessors) {
          if (Number.isFinite(a.startMs) && Number.isFinite(a.endMs) && a.startMs <= a.endMs) {
            allBounds.push({ startMs: a.startMs, endMs: a.endMs });
          }
        }
        for (const arr of meceByValue.values()) {
          for (const a of arr) {
            if (Number.isFinite(a.startMs) && Number.isFinite(a.endMs) && a.startMs <= a.endMs) {
              allBounds.push({ startMs: a.startMs, endMs: a.endMs });
            }
          }
        }
        const minStart = allBounds.reduce((m, b) => Math.min(m, b.startMs), Number.POSITIVE_INFINITY);
        const maxEnd = allBounds.reduce((m, b) => Math.max(m, b.endMs), Number.NEGATIVE_INFINITY);

        // If we still don't have bounds, fall back to "now" and skip.
        const startDate = Number.isFinite(minStart) ? new Date(minStart) : new Date();
        const endDate = Number.isFinite(maxEnd) ? new Date(maxEnd) : new Date();

        const pickBestAccessorForDay = (arr: DailyAccessor[], dayUK: string): DailyAccessor | null => {
          let best: DailyAccessor | null = null;
          for (const a of arr) {
            // Only consider slices that can cover this day (coverage window), regardless of whether the day is present in dates[].
            const nk = a.getNKForDay(dayUK);
            if (!nk.covered) continue;
            if (!best) {
              best = a;
              continue;
            }
            if (a.recencyMs > best.recencyMs) {
              best = a;
              continue;
            }
            if (a.recencyMs < best.recencyMs) continue;
            if (a.coverageDays > best.coverageDays) {
              best = a;
              continue;
            }
          }
          return best;
        };

        const datesMeta: string[] = [];
        const nMeta: number[] = [];
        const kMeta: number[] = [];

        // For diagnostics: record winner switchpoints (not per-day spam).
        type WinnerKind = 'explicit' | 'mece';
        const winnerRuns: Array<{ kind: WinnerKind; from: string; to: string; detail: string }> = [];
        const pushRun = (kind: WinnerKind, dayUK: string, detail: string): void => {
          const last = winnerRuns[winnerRuns.length - 1];
          if (last && last.kind === kind && last.detail === detail) {
            last.to = dayUK;
            return;
          }
          winnerRuns.push({ kind, from: dayUK, to: dayUK, detail });
        };

        // Iterate day-by-day over the wide horizon.
        const dayMs = 24 * 60 * 60 * 1000;
        for (let t = startDate.getTime(); t <= endDate.getTime(); t += dayMs) {
          const dayUK = formatDateUK(new Date(t));

          // Contexted queries: only use context-matching explicit series (never uncontexted).
          if (!isUncontextedTarget) {
            const best = pickBestAccessorForDay(explicitAccessors.filter((a) => a.hasDaily), dayUK);
            if (!best) continue;
            const nk = best.getNKForDay(dayUK);
            datesMeta.push(dayUK);
            nMeta.push(nk.n);
            kMeta.push(nk.k);
            pushRun('explicit', dayUK, best.sliceDSL);
            continue;
          }

          // Uncontexted: consider explicit-uncontexted and MECE aggregate (if available).
          const bestExplicit = pickBestAccessorForDay(explicitAccessors.filter((a) => a.hasDaily), dayUK);

          // Build MECE aggregate for this day: require every context value to cover the day.
          let meceCovered = meceByValue.size > 0;
          let meceN = 0;
          let meceK = 0;
          let meceRecencyMs = Number.POSITIVE_INFINITY;
          let meceCoverageDays = Number.POSITIVE_INFINITY;
          const meceDetails: string[] = [];

          if (meceCovered) {
            for (const [ctxVal, arr] of meceByValue.entries()) {
              const best = pickBestAccessorForDay(arr.filter((a) => a.hasDaily), dayUK);
              if (!best) {
                meceCovered = false;
                break;
              }
              const nk = best.getNKForDay(dayUK);
              meceN += nk.n;
              meceK += nk.k;
              meceRecencyMs = Math.min(meceRecencyMs, best.recencyMs);
              meceCoverageDays = Math.min(meceCoverageDays, best.coverageDays);
              meceDetails.push(`${ctxVal}:${best.sliceDSL}`);
            }
          }

          const explicitCovered = !!bestExplicit;

          // Pick per-day winner: freshest dataset wins; tie-break by wider coverage; final tie-break prefers explicit.
          let winner: { kind: WinnerKind; n: number; k: number; detail: string } | null = null;
          if (explicitCovered && meceCovered) {
            const explicitRecencyMs = bestExplicit!.recencyMs;
            if (explicitRecencyMs > meceRecencyMs) {
              const nk = bestExplicit!.getNKForDay(dayUK);
              winner = { kind: 'explicit', n: nk.n, k: nk.k, detail: bestExplicit!.sliceDSL };
            } else if (explicitRecencyMs < meceRecencyMs) {
              winner = { kind: 'mece', n: meceN, k: meceK, detail: `MECE(${meceKey ?? 'unknown'})` };
            } else {
              // Tie on recency: prefer wider coverage; if still tied, prefer explicit deterministically.
              const explicitCoverageDays = bestExplicit!.coverageDays;
              if (explicitCoverageDays > meceCoverageDays) {
                const nk = bestExplicit!.getNKForDay(dayUK);
                winner = { kind: 'explicit', n: nk.n, k: nk.k, detail: bestExplicit!.sliceDSL };
              } else if (explicitCoverageDays < meceCoverageDays) {
                winner = { kind: 'mece', n: meceN, k: meceK, detail: `MECE(${meceKey ?? 'unknown'})` };
              } else {
                const nk = bestExplicit!.getNKForDay(dayUK);
                winner = { kind: 'explicit', n: nk.n, k: nk.k, detail: bestExplicit!.sliceDSL };
              }
            }
          } else if (explicitCovered) {
            const nk = bestExplicit!.getNKForDay(dayUK);
            winner = { kind: 'explicit', n: nk.n, k: nk.k, detail: bestExplicit!.sliceDSL };
          } else if (meceCovered) {
            winner = { kind: 'mece', n: meceN, k: meceK, detail: `MECE(${meceKey ?? 'unknown'})` };
          } else {
            continue;
          }

          datesMeta.push(dayUK);
          nMeta.push(winner.n);
          kMeta.push(winner.k);
          pushRun(winner.kind, dayUK, winner.detail);
        }

        // As-of date for maturity + recency weighting: max meta date.
        const asOfDate =
          datesMeta.length > 0
            ? (() => {
                let best = new Date(0);
                for (const ds of datesMeta) {
                  try {
                    const d = parseDate(ds);
                    if (!Number.isNaN(d.getTime()) && d.getTime() > best.getTime()) best = d;
                  } catch {
                    // ignore
                  }
                }
                return best.getTime() > 0 ? best : new Date();
              })()
            : new Date();

        // Prefer t95 from the caller (edge-authoritative); then the aggregated latency; then window slice latency.
        const latestAggregatedValue: any = (nextAggregated.values as any[])?.[(nextAggregated.values as any[]).length - 1];
        const inferredT95Days =
          // Explicit "no censor" sentinel: non-latency edges should pass t95Days=0.
          (options?.t95Days === 0)
            ? 0
            : ((typeof options?.t95Days === 'number' && Number.isFinite(options.t95Days) && options.t95Days > 0)
                ? options.t95Days
                : (typeof latestAggregatedValue?.latency?.t95 === 'number'
                    ? latestAggregatedValue.latency.t95
                    : undefined));

        const dailyResult = computeRecencyWeightedMatureForecast({
          bestWindow: { dates: datesMeta, n_daily: nMeta, k_daily: kMeta },
          t95Days: inferredT95Days,
          asOfDate,
        });
        const weightedNTotal = dailyResult.weightedN;
        const weightedKTotal = dailyResult.weightedK;
        const maturityDaysUsed = dailyResult.maturityDays;
        const usedAllDaysFallback = dailyResult.usedAllDaysFallback;

        // If we have a proper weighted population, compute the weighted mean.
        // Otherwise, if there is exactly one chosen slice with a scalar forecast, use it directly
        // (we still want F-mode to work even if header n is missing in some legacy fixtures).
        let forecastMeanComputed: number | undefined =
          weightedNTotal > 0 ? (weightedKTotal / weightedNTotal) : undefined;
        if (forecastMeanComputed !== undefined) {
          // Attach forecast scalar (query-time) – always overwrite so F-mode is explainable and consistent.
          nextAggregated = {
            ...nextAggregated,
            values: (nextAggregated.values as ParameterValue[]).map((v: any) => ({
              ...v,
              forecast: forecastMeanComputed,
            })),
          };

          if (options?.logOpId) {
            const diagnosticsOn = sessionLogService.getDiagnosticLoggingEnabled();
            const basisLabel =
              (!isUncontextedTarget)
                ? 'context-matching'
                : (meceKey ? `meta-slice (explicit vs MECE(${meceKey}))` : 'meta-slice (explicit)');

            const effectiveT95ForLog =
              (typeof inferredT95Days === 'number' && Number.isFinite(inferredT95Days) && inferredT95Days > 0)
                ? inferredT95Days
                : (inferredT95Days === 0 ? 0 : DEFAULT_T95_DAYS);

            const effectiveHalfLifeForLog =
              typeof options?.forecasting?.RECENCY_HALF_LIFE_DAYS === 'number' &&
              Number.isFinite(options.forecasting.RECENCY_HALF_LIFE_DAYS) &&
              options.forecasting.RECENCY_HALF_LIFE_DAYS > 0
                ? options.forecasting.RECENCY_HALF_LIFE_DAYS
                : RECENCY_HALF_LIFE_DAYS;

            const summaryLines: string[] = [];
            summaryLines.push(`basis: ${basisLabel}`);
            summaryLines.push(`as_of: ${normalizeDate(asOfDate.toISOString())} (max window date)`);
            summaryLines.push(
              inferredT95Days === 0
                ? `maturity_exclusion: none (non-latency)`
                : `maturity_exclusion: last ${maturityDaysUsed} days (t95≈${effectiveT95ForLog})`
            );
            if (options.t95Source) summaryLines.push(`t95_source: ${options.t95Source}`);
            summaryLines.push(`recency_weight: w=exp(-ln2*age/${effectiveHalfLifeForLog}d)`);
            summaryLines.push(`weighted: N=${Math.round(weightedNTotal)}, K=${Math.round(weightedKTotal)} → forecast=${(forecastMeanComputed * 100).toFixed(2)}%`);
            if (usedAllDaysFallback) summaryLines.push(`fallback: censoring left no mature days; used full-window mean`);
            if (Array.isArray(meceWarnings) && meceWarnings.length > 0) summaryLines.push(`mece_warnings: ${meceWarnings.join(' | ')}`);

            const verboseDetails =
              diagnosticsOn
                ? (() => {
                    const runs = winnerRuns
                      .slice(0, 250) // hard cap for safety; switchpoints should be small in practice
                      .map((r) => `${r.kind}: ${r.from} → ${r.to} :: ${r.detail}`)
                      .join('\n');
                    return `${summaryLines.join('\n')}\n\nmeta-slice switchpoints:\n${runs}`;
                  })()
                : summaryLines.join('\n');

            sessionLogService.addChild(
              options.logOpId,
              'info',
              'FORECAST_BASIS',
              `Forecast recomputed at query time (${basisLabel})`,
              verboseDetails,
              {
                requestedSlice: targetSlice,
                targetDims,
                meceKey,
                asOf: asOfDate.toISOString(),
                maturityDays: maturityDaysUsed,
                halfLifeDays: effectiveHalfLifeForLog,
                weightedN: weightedNTotal,
                weightedK: weightedKTotal,
                forecastMean: forecastMeanComputed,
                t95Days: effectiveT95ForLog,
                t95Source: options.t95Source,
                metaDays: datesMeta.length,
                switchpoints: winnerRuns.length,
                diagnosticsOn,
              }
            );
          }
        }
      } else {
        // Scalar-only fallback: no usable daily arrays anywhere. Preserve legacy behaviour by attaching a
        // scalar forecast when available (even if header n is missing).
        const scalarCandidates = contextMatchedWindowCandidates.filter((v) => {
          const f = (v as any).forecast;
          return typeof f === 'number' && Number.isFinite(f);
        });

        // For uncontexted, if there is no explicit uncontexted scalar, attempt an implicit-uncontexted MECE aggregate
        // (weighted by header n when present).
        let forecastMeanComputed: number | undefined;
        let basisLabel = 'scalar (context-matching)';
        let basisSlices: string[] = [];

        if (scalarCandidates.length > 0) {
          const best = scalarCandidates.reduce((b, cur) => (parameterValueRecencyMs(cur) > parameterValueRecencyMs(b) ? cur : b));
          forecastMeanComputed = (best as any).forecast;
          basisSlices = [best.sliceDSL ?? '<missing sliceDSL>'];
          basisLabel = isUncontextedTarget ? 'scalar (explicit uncontexted)' : 'scalar (context-matching)';
        } else if (isUncontextedTarget && bestMECE?.values?.length) {
          let wN = 0;
          let wK = 0;
          let lone: any | undefined;
          for (const v of bestMECE.values) {
            const f = (v as any).forecast;
            if (typeof f !== 'number' || !Number.isFinite(f)) continue;
            lone = v;
            const n = typeof (v as any).n === 'number' && Number.isFinite((v as any).n) && (v as any).n > 0 ? (v as any).n : 0;
            if (n > 0) {
              wN += n;
              wK += n * f;
            }
            basisSlices.push(v.sliceDSL ?? '<missing sliceDSL>');
          }
          if (wN > 0) {
            forecastMeanComputed = wK / wN;
            basisLabel = `scalar (MECE(${meceKey ?? 'unknown'}))`;
          } else if (lone && typeof (lone as any).forecast === 'number') {
            // Last resort: single slice forecast with no n weighting available.
            forecastMeanComputed = (lone as any).forecast;
            basisLabel = `scalar (MECE(${meceKey ?? 'unknown'}), unweighted)`;
          }
        }

        if (forecastMeanComputed !== undefined) {
          nextAggregated = {
            ...nextAggregated,
            values: (nextAggregated.values as ParameterValue[]).map((v: any) => ({
              ...v,
              forecast: forecastMeanComputed,
            })),
          };

          if (options?.logOpId) {
            const diagnosticsOn = sessionLogService.getDiagnosticLoggingEnabled();
            const msg = `Forecast attached from stored scalar (${basisLabel})`;
            const details = diagnosticsOn ? `slices:\n${basisSlices.join('\n')}` : undefined;
            sessionLogService.addChild(
              options.logOpId,
              'info',
              'FORECAST_BASIS',
              msg,
              details,
              {
                requestedSlice: targetSlice,
                targetDims,
                meceKey,
                forecastMean: forecastMeanComputed,
                basis: basisLabel,
                diagnosticsOn,
              }
            );
          }
        }
      }
      // NOTE: LAG computation (t95, completeness, forecast blend) is handled by
      // enhanceGraphLatencies in statisticalEnhancementService, which runs after
      // batch fetches in topological order. No fallback computation here.
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
    targetSlice,
    undefined
  ),
};

