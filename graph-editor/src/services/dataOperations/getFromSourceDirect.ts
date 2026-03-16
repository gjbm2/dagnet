/**
 * getFromSourceDirect — fetch data from an external source directly into the graph.
 *
 * Extracted from dataOperationsService.ts during slimdown.
 *
 * If window is provided and writeToFile mode is enabled, fetches daily time-series data
 * and stores it in the parameter file (if objectType is 'parameter').
 */

import toast from 'react-hot-toast';
import { fileRegistry } from '../../contexts/TabContext';
import { UpdateManager } from '../UpdateManager';
import type { Graph, DateRange } from '../../types';
import type { CombinedResult } from '../../lib/das/compositeQueryExecutor';
import {
  calculateIncrementalFetch,
  mergeTimeSeriesIntoParameter,
  normalizeDate,
  parseDate,
  isDateInRange,
  aggregateCohortData,
  aggregateLatencyStats,
  isCohortModeValue,
} from '../windowAggregationService';
import {
  shouldRefetch,
  type RefetchDecision,
  type LatencyConfig,
} from '../fetchRefetchPolicy';
import { computeCohortRetrievalHorizon } from '../cohortRetrievalHorizon';
import {
  statisticalEnhancementService,
} from '../statisticalEnhancementService';
import { approximateLogNormalSumPercentileDays, fitLagDistribution, toModelSpaceLagDays } from '../statisticalEnhancementService';
import type { ParameterValue } from '../../types/parameterData';
import { buildScopedParamsFromFlatPack } from '../ParamPackDSLService';
import { isolateSlice, extractSliceDimensions, hasContextAny } from '../sliceIsolation';
import { sessionLogService } from '../sessionLogService';

import { isSignatureWritingEnabled } from '../signaturePolicyService';
import { parseSignature } from '../signatureMatchingService';
import { forecastingSettingsService } from '../forecastingSettingsService';
import { deriveOnsetDeltaDaysFromLagHistogram, roundTo1dp } from '../onsetDerivationService';
import { normalizeConstraintString, parseConstraints, parseDSL } from '../../lib/queryDSL';
import { contextRegistry } from '../contextRegistry';
import { normalizeToUK, formatDateUK, parseUKDate, resolveRelativeDate } from '../../lib/dateFormat';
import { redactDeep } from '../../lib/redact';
import { rateLimiter } from '../rateLimiter';
import { buildDslFromEdge } from '../../lib/das/buildDslFromEdge';
import { createDASRunner } from '../../lib/das';
import { db } from '../../db/appDatabase';
import { querySnapshotsVirtual } from '../snapshotWriteService';
import { RECENCY_HALF_LIFE_DAYS, DEFAULT_T95_DAYS } from '../../constants/latency';
import { LATENCY_PATH_T95_PERCENTILE } from '../../constants/latency';

import {
  isBatchMode,
  batchableToastSuccess,
} from './batchMode';
import {
  formatEdgeForLog,
  formatNodeForLog,
  compileExcludeQuery,
} from './logHelpers';
import {
  computeQuerySignature,
  extractContextKeysFromConstraints,
} from './querySignature';
import {
  selectQuerySignatureForAsat,
  convertVirtualSnapshotToTimeSeries,
  fireAsatWarnings,
  buildDenseSnapshotRowsForDbWrite,
} from './asatQuerySupport';
import {
  addEvidenceAndForecastScalars,
} from './evidenceForecastScalars';
import {
  getParameterFromFile,
} from './fileToGraphSync';
import { applyChanges } from './applyChanges';
import type { CacheAnalysisResult, GetFromSourceResult } from './types';

// Module-level singleton (stateless, safe to duplicate)
const updateManager = new UpdateManager();

function toISOWindowForDAS(window: DateRange): { start?: string; end?: string; [key: string]: unknown } {
  // CRITICAL: keep UK dates internally/logging, but DAS adapters expect ISO strings here.
  // If we pass "6-Dec-25", the Amplitude adapter will produce "6Dec25" (invalid).
  const start = window.start ? parseDate(window.start).toISOString() : undefined;
  const end = window.end ? parseDate(window.end).toISOString() : undefined;
  return { start, end };
}

/**
 * Get data from external source → graph (direct, not versioned)
 * 
 * If window is provided and writeToFile mode is enabled, fetches daily time-series data
 * and stores it in the parameter file (if objectType is 'parameter').
 */
export async function getFromSourceDirect(options: {
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
    LATENCY_MAX_MEAN_MEDIAN_RATIO?: number;
  };
  /**
   * Shared retrieval-batch timestamp (key-fixes.md §2.1).
   * When provided, all snapshot writes use this instead of minting a new Date().
   * Callers that orchestrate multiple slices for the same param (e.g. retrieve-all)
   * should mint one Date and pass it to every per-slice getFromSource call.
   */
  retrievalBatchAt?: Date;
  /**
   * Enforce atomicity at scope S during execution (see getFromSource docs).
   * Used by automated retrieve-all to ensure rate-limit interruptions trigger
   * cooldown + restart at scope S, rather than incremental resume over hours.
   */
  enforceAtomicityScopeS?: boolean;
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
      retrievalBatchAt: externalBatchAt,
      enforceAtomicityScopeS = false,
    } = options;

  // -------------------------------------------------------------------------
  // SNAPSHOT / RETRIEVAL BATCH IDENTITY
  // -------------------------------------------------------------------------
  // `retrieved_at` must be stable for the entire retrieval event so that:
  // - snapshot DB writes are atomic per retrieval batch
  // - retries / double-invocations become idempotent via the DB unique key
  // When a caller (e.g. retrieve-all) orchestrates multiple slices for the
  // same param, it should mint ONE Date and pass it as `retrievalBatchAt` so
  // all slices share the same `retrieved_at`.
  // See: docs/current/project-db/key-fixes.md
  const retrievalBatchAt = externalBatchAt ?? new Date();
  const retrievalBatchAtISO = retrievalBatchAt.toISOString();

  const shouldThrowForAtomicityRateLimit = (message: string): boolean => {
    // For automated retrieve-all, a rate-limit pause implies a long real-world gap.
    // If we already persisted part of scope S (param × slice × hash), we must throw so
    // the orchestrator can apply cooldown + restart semantics (new retrieved_at).
    return enforceAtomicityScopeS === true && rateLimiter.isRateLimitError(message);
  };

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
    // ============================================================================
    // asat() Historical Query Fork Point
    // ============================================================================
    // Check for asat() clause in DSL. If present, route to snapshot DB instead of DAS.
    // This is read-only: no file mutations, no DAS requests.
    const effectiveDSL = targetSlice || currentDSL || '';
    const parsedDSLForAsat = parseConstraints(effectiveDSL);
    
    if (parsedDSLForAsat.asat && objectType === 'parameter' && objectId) {
      sessionLogService.addChild(logOpId, 'info', 'ASAT_FORK', 
        `Detected asat(${parsedDSLForAsat.asat}) - routing to snapshot DB`,
        effectiveDSL,
        { asat: parsedDSLForAsat.asat });
      
      // Build workspace-prefixed param_id from parameter file source metadata
      const paramFile = fileRegistry.getFile(`parameter-${objectId}`);
      const workspaceRepo = paramFile?.source?.repository;
      const workspaceBranch = paramFile?.source?.branch;
      if (!workspaceRepo || !workspaceBranch) {
        // Can't form DB param_id → treat as no-data for this key.
        sessionLogService.endOperation(logOpId, 'warning', 'asat: missing workspace metadata (snapshot lookup skipped)');
        return errorResult;
      }
      const paramId = `${workspaceRepo}-${workspaceBranch}-${objectId}`;

      // MANDATORY: signature integrity. Use the existing stored query_signature from the parameter file.
      // This is the canonical signature produced by the normal fetch path.
      const signatureStr = (() => {
        const values: any[] = Array.isArray((paramFile as any)?.data?.values) ? (paramFile as any).data.values : [];
        const mode: 'window' | 'cohort' = parsedDSLForAsat.cohort ? 'cohort' : 'window';
        return selectQuerySignatureForAsat({ values, mode });
      })();
      if (!signatureStr) {
        // No signature available → cannot form lookup key → no-data.
        const modeLabel = parsedDSLForAsat.cohort ? 'cohort' : 'window';
        console.warn(
          `[DataOperationsService] asat: no query_signature matching mode=${modeLabel} in parameter file; snapshot lookup skipped`
        );
        sessionLogService.endOperation(
          logOpId,
          'warning',
          `asat: no mode-matching query_signature (${modeLabel}) (snapshot lookup skipped)`
        );
        return errorResult;
      }
      const parsedSig = parseSignature(signatureStr);
      if (!parsedSig.coreHash) {
        sessionLogService.endOperation(logOpId, 'warning', 'asat: invalid query_signature (snapshot lookup skipped)');
        return errorResult;
      }
      
      // Resolve window/cohort dates
      const todayUK = formatDateUK(new Date());
      let anchorFrom: string | undefined;
      let anchorTo: string | undefined;
      
      if (parsedDSLForAsat.cohort?.start || parsedDSLForAsat.cohort?.end) {
        // Cohort mode (A-anchored)
        anchorFrom = parsedDSLForAsat.cohort.start 
          ? resolveRelativeDate(parsedDSLForAsat.cohort.start) 
          : undefined;
        anchorTo = parsedDSLForAsat.cohort.end 
          ? resolveRelativeDate(parsedDSLForAsat.cohort.end) 
          : todayUK;
      } else if (parsedDSLForAsat.window?.start || parsedDSLForAsat.window?.end) {
        // Window mode (X-anchored)
        anchorFrom = parsedDSLForAsat.window.start 
          ? resolveRelativeDate(parsedDSLForAsat.window.start) 
          : undefined;
        anchorTo = parsedDSLForAsat.window.end 
          ? resolveRelativeDate(parsedDSLForAsat.window.end) 
          : todayUK;
      } else {
        // No window/cohort specified - use default window
        const defaultStart = resolveRelativeDate('-60d');
        anchorFrom = defaultStart;
        anchorTo = todayUK;
      }
      
      if (!anchorFrom || !anchorTo) {
        sessionLogService.endOperation(logOpId, 'warning', 'asat: missing valid window/cohort range (snapshot lookup skipped)');
        return errorResult;
      }
      
      // Convert UK dates to ISO for API
      const anchorFromISO = parseUKDate(anchorFrom).toISOString().split('T')[0];
      const anchorToISO = parseUKDate(anchorTo).toISOString().split('T')[0];
      
      // Convert asat date to ISO datetime (end of day, UTC)
      const asatDateUK = resolveRelativeDate(parsedDSLForAsat.asat);
      const asatDateObj = parseUKDate(asatDateUK);
      asatDateObj.setUTCHours(23, 59, 59, 999);
      const asAtISO = asatDateObj.toISOString();
      
      // Extract slice_keys from context constraints
      const sliceKeys = extractSliceDimensions(effectiveDSL);
      const sliceKeyArray = sliceKeys ? [sliceKeys] : undefined; // Empty string = uncontexted
      
      sessionLogService.addChild(logOpId, 'info', 'ASAT_QUERY', 
        `Querying virtual snapshot: ${anchorFromISO} to ${anchorToISO} as-at ${asatDateUK}`,
        undefined,
        { paramId, anchorFrom: anchorFromISO, anchorTo: anchorToISO, asAt: asAtISO, sliceKeys: sliceKeyArray });
      
      // Call virtual snapshot query
      const virtualResult = await querySnapshotsVirtual({
        param_id: paramId,
        as_at: asAtISO,
        anchor_from: anchorFromISO,
        anchor_to: anchorToISO,
        slice_keys: sliceKeyArray,
        canonical_signature: signatureStr,
      });
      
      if (!virtualResult.success) {
        sessionLogService.endOperation(logOpId, 'error', `Virtual snapshot query failed: ${virtualResult.error}`);
        toast.error(`Historical query failed: ${virtualResult.error}`);
        return errorResult;
      }
      
      sessionLogService.addChild(logOpId, 'info', 'ASAT_RESULT', 
        `Virtual snapshot returned ${virtualResult.count} rows`,
        undefined,
        { 
          count: virtualResult.count, 
          latestRetrievedAt: virtualResult.latest_retrieved_at_used,
          hasAnchorTo: virtualResult.has_anchor_to 
        });
      
      // Fire warnings per §6.3
      fireAsatWarnings(
        asatDateUK,
        virtualResult.latest_retrieved_at_used,
        virtualResult.has_anchor_to,
        anchorTo,
        entityLabel
      );
      
      // Convert virtual snapshot rows to time series format
      const sliceDims = extractSliceDimensions(effectiveDSL);
      const modeClause = parsedDSLForAsat.cohort ? 'cohort()' : (parsedDSLForAsat.window ? 'window()' : '');
      const sliceFamilyKey = [sliceDims, modeClause].filter(Boolean).join('.');
      const targetSliceKey = sliceFamilyKey || '';
      const timeSeries = convertVirtualSnapshotToTimeSeries(virtualResult.rows, targetSliceKey, {
        workspace: { repository: workspaceRepo, branch: workspaceBranch },
      });
      
      // If we have a graph and setGraph, apply the data to the graph
      if (graph && setGraph && targetId) {
        const targetEdge: any = graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId);
        if (targetEdge) {
          // Simple aggregation: sum n and k from time series
          const totalN = timeSeries.reduce((sum, pt) => sum + pt.n, 0);
          const totalK = timeSeries.reduce((sum, pt) => sum + pt.k, 0);
          const aggregatedP = totalN > 0 ? totalK / totalN : 0;
          
          // Apply to graph edge
          const newGraph = { ...graph };
          const newEdges = [...(newGraph.edges || [])];
          const edgeIndex = newEdges.findIndex((e: any) => e.uuid === targetId || e.id === targetId);
          
          if (edgeIndex >= 0) {
            const newEdge = { ...newEdges[edgeIndex] };
            const paramObj = conditionalIndex !== undefined 
              ? newEdge.conditional_p?.[conditionalIndex]?.p 
              : (paramSlot ? newEdge[paramSlot as keyof typeof newEdge] : newEdge.p);
            
            if (paramObj && typeof paramObj === 'object') {
              // Apply aggregated values
              (paramObj as any).n = totalN;
              (paramObj as any).k = totalK;
              
              // Store daily data for display
              (paramObj as any).n_daily = timeSeries.map(pt => pt.n);
              (paramObj as any).k_daily = timeSeries.map(pt => pt.k);
              (paramObj as any).dates = timeSeries.map(pt => pt.date);
              
              // Mark as from asat query (read-only, no writes)
              (paramObj as any)._asat = parsedDSLForAsat.asat;
              (paramObj as any)._asat_retrieved_at = virtualResult.latest_retrieved_at_used;
            }
            
            newEdges[edgeIndex] = newEdge;
            newGraph.edges = newEdges;
            setGraph(newGraph);
          }
        }
      }
      
      sessionLogService.endOperation(logOpId, 'success', 
        `Historical query complete: ${timeSeries.length} data points from snapshot as-at ${asatDateUK}`);
      
      return {
        success: true,
        cacheHit: true, // Virtual snapshot is effectively a "cache hit" from DB
        daysFetched: 0,
        daysFromCache: timeSeries.length,
      };
    }
    // ============================================================================
    // End asat() Fork - Continue normal DAS path
    // ============================================================================
    
    let connectionName: string | undefined;
    let connectionString: any = {};
    
    // Persisted config selection (critical):
    // - Connection name: always resolved from graph (edge slot → graph.defaultConnection). File connection is provenance only.
    // - Connection string: versioned → file; direct → graph edge.
    // - Cases: versionedCase uses file; direct uses node.case
    if (objectType === 'parameter' && targetId && graph) {
      const targetEdge: any = graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId);
      const paramFile = objectId ? fileRegistry.getFile(`parameter-${objectId}`) : undefined;
      const { selectPersistedProbabilityConfig } = await import('../persistedParameterConfigService');
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
      const { selectPersistedCaseConfig } = await import('../persistedCaseConfigService');
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
    
    // 2. Fall back to graph-level default connection
    if (!connectionName && graph?.defaultConnection) {
      connectionName = graph.defaultConnection;
      console.log(`[DataOps] Using graph.defaultConnection: ${connectionName}`);
    }
    
    // 3. Check if we have a connection configured
    if (!connectionName) {
      sessionLogService.endOperation(logOpId, 'error', 'No connection configured');
      toast.error(`No connection configured. Set a connection on the edge or set a default connection on the graph.`);
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
        const { buildDslFromEdge } = await import('../../lib/das/buildDslFromEdge');
        
        // Get connection to extract provider and check if it requires event_ids
        const { createDASRunner } = await import('../../lib/das');
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
              const { parseConstraints } = await import('../../lib/queryDSL');
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
              const diagnosticOn = sessionLogService.getDiagnosticLoggingEnabled();
              
              if (file && file.data) {
                if (diagnosticOn) {
                  sessionLogService.info('data-fetch', 'EVENT_LOADED', 
                    `Loaded event "${eventId}" for fetch`,
                    undefined,
                    {
                      eventId,
                      source: 'fetch',
                      provider_event_names: file.data.provider_event_names,
                      amplitude_filters: file.data.amplitude_filters,
                    }
                  );
                }
                return file.data;
              }

              // Fall back to IndexedDB (source of truth) if not hydrated in FileRegistry.
              try {
                const dbFile: any = await db.files.get(fileId);
                if (dbFile?.data) {
                  if (diagnosticOn) {
                    sessionLogService.info('data-fetch', 'EVENT_LOADED',
                      `Loaded event "${eventId}" for fetch (IndexedDB fallback)`,
                      undefined,
                      {
                        eventId,
                        source: 'fetch:indexeddb',
                        provider_event_names: dbFile.data.provider_event_names,
                        amplitude_filters: dbFile.data.amplitude_filters,
                      }
                    );
                  }
                  return dbFile.data;
                }
              } catch {
                // ignore DB errors, will throw below
              }
              
              // HARD FAIL: Event files MUST be available. If not, this is a bug.
              throw new Error(`[fetch] Event file "${eventId}" not found in fileRegistry or IndexedDB. This indicates a workspace/clone issue.`);
            };
            
            // Parse and merge constraints from graph-level and edge-specific queries
            // CRITICAL: currentDSL MUST be provided from graphStore.currentDSL (authoritative)
            // NEVER fall back to graph.currentQueryDSL - it's only for historic record!
            let constraints;
            try {
              const { parseConstraints } = await import('../../lib/queryDSL');
              
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
            const { contextRegistry } = await import('../contextRegistry');
            contextRegistry.clearCache();
            
            // Build DSL with event mapping for analytics-style connections (e.g., Amplitude)
            // IMPORTANT: For versioned parameter operations (writeToFile=true), prefer persisted
            // parameter-file config for connection/latency primitives (e.g. conversion_window_days).
            const paramFileForCfg =
              objectType === 'parameter' && objectId
                ? fileRegistry.getFile(`parameter-${objectId}`)
                : undefined;
            const { selectPersistedProbabilityConfig } = await import('../persistedParameterConfigService');
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
              const diagnosticOn = sessionLogService.getDiagnosticLoggingEnabled();
              if (file && file.data) {
                if (diagnosticOn) {
                  sessionLogService.info('data-fetch', 'EVENT_LOADED', 
                    `Loaded event "${eventId}" for fetch (fallback path)`,
                    undefined,
                    {
                      eventId,
                      source: 'fetch-fallback',
                      provider_event_names: file.data.provider_event_names,
                      amplitude_filters: file.data.amplitude_filters,
                    }
                  );
                }
                return file.data;
              }
              
              // Fall back to IndexedDB (source of truth).
              try {
                const dbFile: any = await db.files.get(fileId);
                if (dbFile?.data) {
                  if (diagnosticOn) {
                    sessionLogService.info('data-fetch', 'EVENT_LOADED',
                      `Loaded event "${eventId}" for fetch (fallback path - IndexedDB)`,
                      undefined,
                      {
                        eventId,
                        source: 'fetch-fallback:indexeddb',
                        provider_event_names: dbFile.data.provider_event_names,
                        amplitude_filters: dbFile.data.amplitude_filters,
                      }
                    );
                  }
                  return dbFile.data;
                }
              } catch {
                // ignore DB errors, will throw below
              }
              
              // HARD FAIL: Event files MUST be available. If not, this is a bug.
              throw new Error(`[fetch-fallback] Event file "${eventId}" not found in fileRegistry or IndexedDB. This indicates a workspace/clone issue.`);
            };
            
            // Parse and merge constraints from graph-level and edge-specific queries (fallback path)
            // CRITICAL: currentDSL MUST be provided from graphStore.currentDSL (authoritative)
            // NEVER fall back to graph.currentQueryDSL - it's only for historic record!
            let constraints;
            try {
              const { parseConstraints } = await import('../../lib/queryDSL');
              
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
            const { selectPersistedProbabilityConfig } = await import('../persistedParameterConfigService');
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
          const { parseDSL } = await import('../../lib/queryDSL');
          const parsedQuery = parseDSL(fileQuery);
          
          // Build a minimal query payload from the parsed query
          // This assumes node IDs in query can be resolved via eventLoader
          if (parsedQuery.from && parsedQuery.to) {
            const eventLoader = async (eventId: string) => {
              const fileId = `event-${eventId}`;
              const file = fileRegistry.getFile(fileId);
              const diagnosticOn = sessionLogService.getDiagnosticLoggingEnabled();
              if (file?.data) {
                if (diagnosticOn) {
                  sessionLogService.info('data-fetch', 'EVENT_LOADED', 
                    `Loaded event "${eventId}" for direct query`,
                    undefined,
                    {
                      eventId,
                      source: 'direct-query',
                      provider_event_names: file.data.provider_event_names,
                      amplitude_filters: file.data.amplitude_filters,
                    }
                  );
                }
                return file.data;
              }
              // IndexedDB fallback (source of truth) if not hydrated in FileRegistry.
              try {
                const dbFile: any = await db.files.get(fileId);
                if (dbFile?.data) {
                  if (diagnosticOn) {
                    sessionLogService.info('data-fetch', 'EVENT_LOADED',
                      `Loaded event "${eventId}" for direct query (IndexedDB fallback)`,
                      undefined,
                      {
                        eventId,
                        source: 'direct-query:indexeddb',
                        provider_event_names: dbFile.data.provider_event_names,
                        amplitude_filters: dbFile.data.amplitude_filters,
                      }
                    );
                  }
                  return dbFile.data;
                }
              } catch {
                // ignore DB errors, will throw below
              }
              
              // HARD FAIL: Event files MUST be available. If not, this is a bug.
              throw new Error(`[direct-query] Event file "${eventId}" not found in fileRegistry or IndexedDB. This indicates a workspace/clone issue.`);
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
          
          // Prefer hydrated in-memory fileRegistry.
          const file = fileRegistry.getFile(fileId);
          if (file && file.data) {
            return file.data;
          }
          
          // Fall back to IndexedDB (source of truth).
          try {
            const dbFile: any = await db.files.get(fileId);
            if (dbFile?.data) return dbFile.data;
          } catch {
            // ignore DB errors, will throw below
          }
          
          // HARD FAIL: Event files MUST be available. If not, this is a bug.
          throw new Error(`[n_query] Event file "${eventId}" not found in fileRegistry or IndexedDB. This indicates a workspace/clone issue.`);
        };
        
        // Parse constraints for n_query (same as main query)
        // CRITICAL: currentDSL MUST be provided from graphStore.currentDSL (authoritative)
        // NEVER fall back to graph.currentQueryDSL - it's only for historic record!
        let nQueryConstraints;
        try {
          const { parseConstraints } = await import('../../lib/queryDSL');
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
          const { buildDslFromEdge: buildDslFromEdgeForNQuery } = await import('../../lib/das/buildDslFromEdge');
          
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
              const { parseConstraints, parseDSL } = await import('../../lib/queryDSL');
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
                // Use segmentation endpoint (same as window mode) for cohort denominators.
                // The old approach built from(anchor).to(X) as a 2-step funnel, but when
                // anchor === X (common for entry-node edges), Amplitude treats it as
                // "users who did X twice" → returns 0. Segmentation counts unique users
                // of X during the cohort date range, which is the correct denominator.
                if (xId) {
                  nQueryEdgeData.query = `from(${xId}).to(${xId})`;
                  explicitNQueryWindowDenomUsesFromCount = true;
                  sessionLogService.addChild(logOpId, 'info', 'N_QUERY_COHORT_SEGMENTATION',
                    `Cohort denominator: using segmentation endpoint for to(${xId})`,
                    `Rewrote n_query to from(${xId}).to(${xId}) to avoid anchor===X funnel bug`
                  );
                } else {
                  console.warn('[DataOps:DUAL_QUERY] to(X) n_query in cohort mode but no xId available; skipping explicit n_query for this run');
                  sessionLogService.addChild(logOpId, 'warning', 'N_QUERY_COHORT_NO_XID',
                    'Cohort denominator: no xId available, skipping explicit n_query'
                  );
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
                  sessionLogService.addChild(logOpId, 'info', 'N_QUERY_WINDOW_SEGMENTATION',
                    `Window denominator: using segmentation endpoint for to(${xId})`,
                    `Rewrote n_query to from(${xId}).to(${xId})`
                  );
                }
              }
            } catch (error) {
              console.warn('[DataOps:DUAL_QUERY] Failed to synthesise concrete query for to(X) n_query:', error);
              sessionLogService.addChild(logOpId, 'error', 'N_QUERY_SYNTHESIS_FAILED',
                `Failed to synthesise concrete query for to(X) n_query: ${error instanceof Error ? error.message : String(error)}`
              );
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
          const { parseDSL } = await import('../../lib/queryDSL');
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

        // Mark to(X) denominators as "segmentation" so the Amplitude adapter uses
        // the single-event endpoint rather than /funnels (applies to both window and cohort mode).
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
      const { createDASRunner } = await import('../../lib/das');
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

      // Coalesce contiguous windows to avoid pathological over-many requests.
      // This preserves the exact date-set being fetched (union of inclusive ranges),
      // but reduces HTTP calls when the plan splits adjacent windows (e.g. stale up to yesterday + missing today).
      const beforeCount = actualFetchWindows.length;
      const beforeWindows = actualFetchWindows.map((w) => ({ start: normalizeDate(w.start), end: normalizeDate(w.end) }));
      actualFetchWindows = mergeFetchWindows(actualFetchWindows);
      if (actualFetchWindows.length !== beforeCount) {
        sessionLogService.addChild(
          logOpId,
          'info',
          'FETCH_WINDOWS_COALESCED',
          `Coalesced plan windows for execution: ${beforeCount} → ${actualFetchWindows.length}`,
          undefined,
          {
            before: beforeWindows,
            after: actualFetchWindows.map((w) => ({ start: normalizeDate(w.start), end: normalizeDate(w.end) })),
          } as any
        );
      }
    }

    function mergeFetchWindows(windows: DateRange[]): DateRange[] {
      if (windows.length <= 1) return windows;
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;
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
        // Ranges are inclusive: treat adjacent days as mergeable to avoid extra calls.
        if (nextStart <= lastEnd + ONE_DAY_MS) {
          const nextEnd = parseDate(w.end).getTime();
          if (nextEnd > lastEnd) {
            last.end = w.end;
          }
        } else {
          merged.push({ start: w.start, end: w.end });
        }
      }
      return merged;
    }
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
        workspaceForSignature,
        eventDefinitions  // Pass event definitions for hashing
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
      const { selectPersistedProbabilityConfig } = await import('../persistedParameterConfigService');
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
                    const anchorFit = fitLagDistribution(
                      anchorMedian,
                      anchorMean,
                      totalWNForAnchor,
                      options?.forecasting?.LATENCY_MAX_MEAN_MEDIAN_RATIO
                    );
                    // Onset-aware moment matching:
                    // - FW operates on post-onset (model-space) X components.
                    // - Total path horizon is shifted back into user-space by adding δ.
                    const onsetDeltaDays =
                      typeof (latencyConfig as any)?.onset_delta_days === 'number' &&
                      Number.isFinite((latencyConfig as any).onset_delta_days)
                        ? (latencyConfig as any).onset_delta_days
                        : 0;
                    const edgeMedianX = toModelSpaceLagDays(onsetDeltaDays, edgeLag.median_lag_days);
                    const edgeMeanX =
                      typeof edgeLag.mean_lag_days === 'number'
                        ? toModelSpaceLagDays(onsetDeltaDays, edgeLag.mean_lag_days)
                        : undefined;
                    const edgeFit = fitLagDistribution(
                      edgeMedianX,
                      edgeMeanX,
                      totalWK,
                      options?.forecasting?.LATENCY_MAX_MEAN_MEDIAN_RATIO
                    );
                    const estimateX = approximateLogNormalSumPercentileDays(anchorFit, edgeFit, LATENCY_PATH_T95_PERCENTILE);
                    const estimate = estimateX !== undefined ? (estimateX + onsetDeltaDays) : undefined;
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
        
        // Build signature info for logging (light touch: add to detail/metadata)
        const sigDiag = incrementalResult.signatureDiagnostics;
        const sigInfo = sigDiag 
          ? (sigDiag.matchType === 'dimensional_reduction'
              ? ` | Sig: reduced over ${sigDiag.reducedDimensions?.join(', ') || '?'} (${sigDiag.slicesAggregated} slices)`
              : sigDiag.matchType !== 'no_match' 
                ? ` | Sig: ${sigDiag.matchType}` 
                : '')
          : '';
        
        sessionLogService.addChild(logOpId, 
          cacheStatus === 'CACHE_HIT' ? 'success' : 'info',
          cacheStatus,
          `Cache check for window ${windowDesc}`,
          `${cacheDetail}${sigInfo}${incrementalResult.fetchWindows.length > 0 ? `\n${gapDetails}` : ''}`,
          {
            window: windowDesc,
            totalDays: incrementalResult.totalDays,
            daysAvailable: incrementalResult.daysAvailable,
            daysToFetch: incrementalResult.daysToFetch,
            gapCount: incrementalResult.fetchWindows.length,
            bustCache: bustCache || false,
            targetSlice: currentDSL || targetSlice || '',
            signatureMatch: sigDiag?.matchType,
            signatureFiltered: sigDiag ? `${sigDiag.signatureFilteredCount}/${sigDiag.totalValues}` : undefined,
            dimensionalReduction: sigDiag?.usedDimensionalReduction ? {
              dimensions: sigDiag.reducedDimensions,
              slicesAggregated: sigDiag.slicesAggregated,
            } : undefined,
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
      
      await getParameterFromFile({
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
    const { createDASRunner } = await import('../../lib/das');
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
    // LAG: Capture onset_delta_days from histogram (window slices only)
    let lastOnsetDeltaDays: number | undefined = undefined;
    
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

    // Lazily loaded shared forecasting knobs for this call (avoid repeated IDB reads).
    let forecastingSettingsForThisRun:
      | import('../forecastingSettingsService').ForecastingModelSettings
      | undefined;

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
              // LAG (§0.3): persist onset_delta_days for window() slices (cohort() onset is unreliable).
              ...(!isCohortQuery && lastOnsetDeltaDays !== undefined && {
                latencySummary: {
                  onset_delta_days: lastOnsetDeltaDays,
                },
              }),
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
              // LAG (§0.3): persist onset_delta_days for window() slices (cohort() onset is unreliable).
              ...(!isCohortQuery && lastOnsetDeltaDays !== undefined && {
                latencySummary: {
                  onset_delta_days: lastOnsetDeltaDays,
                },
              }),
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

        // Diagnostic: confirm onset made it into values[].latency for this slice family.
        if (sessionLogService.getDiagnosticLoggingEnabled() && !isCohortQuery) {
          try {
            // We only ever write onset to window-mode values via mergeOptions.latencySummary.
            // Find any window value for this slice family that carries onset.
            const targetDims = extractSliceDimensions(sliceDSLForGapWrites);
            const candidates = (existingValuesForGapWrites || []).filter((v: any) => {
              const s = v?.sliceDSL;
              if (typeof s !== 'string') return false;
              if (!s.includes('window(')) return false;
              return extractSliceDimensions(s) === targetDims;
            });
            const onsets = candidates
              .map((v: any) => v?.latency?.onset_delta_days)
              .filter((v: any) => typeof v === 'number' && Number.isFinite(v));
            sessionLogService.addChild(
              logOpId,
              'info',
              'ONSET_FILE_PERSIST',
              onsets.length > 0
                ? `Onset written to file (slice family): ${[...new Set(onsets)].sort((a: number, b: number) => a - b).join(', ')}`
                : 'Onset not present in file values[] after merge',
              undefined,
              {
                sliceDSL: sliceDSLForGapWrites,
                candidates: candidates.length,
                onset_delta_days: lastOnsetDeltaDays ?? null,
              }
            );
          } catch {
            // non-fatal
          }
        }

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
      // CRITICAL: DRY RUN CHECK - MUST BE BEFORE ANY API CALLS
      // BUG FIX (29-Jan-26): Previously this check was AFTER dual query execution,
      // causing simulation mode to hit real Amplitude API when needsDualQuery=true.
      // =====================================================================
      if (dontExecuteHttp) {
        // Build dry-run log entries showing what HTTP requests WOULD be made
        const redactUrlForLog = (url: string): string => {
          try {
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
          
          const { executeCompositeQuery } = await import('../../lib/das/compositeQueryExecutor');
          
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
            if (shouldThrowForAtomicityRateLimit(errorMsg)) {
              // Force orchestrator-level cooldown + restart for scope S.
              throw new Error(errorMsg);
            }
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
            if (shouldThrowForAtomicityRateLimit(baseResult.error)) {
              // Force orchestrator-level cooldown + restart for scope S.
              throw new Error(baseResult.error);
            }
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
        // CRITICAL (§0.1): Preserve latency fields from base query
        // Normalise single-object time_series (returned by DAS for 1-day windows) into an array
        const baseRawTimeSeries = Array.isArray(baseRaw?.time_series)
          ? baseRaw.time_series
          : (baseRaw?.time_series && typeof baseRaw.time_series === 'object' && baseRaw.time_series.date)
            ? [baseRaw.time_series]
            : undefined;
        if (baseRawTimeSeries) {
          if (explicitNQuery) {
            // For explicit n_query, the "n" for the main query is the "k" of the n_query
            if (explicitNQueryWasToOnlyNormalForm && explicitNQueryWindowDenomUsesFromCount) {
              baseTimeSeries = baseRawTimeSeries.map((day: any) => ({
                date: day.date,
                n: day.n,  // Use from_count as n for window-mode to(X)
                k: day.n,
                p: day.p,
                ...(day.median_lag_days !== undefined && { median_lag_days: day.median_lag_days }),
                ...(day.mean_lag_days !== undefined && { mean_lag_days: day.mean_lag_days }),
                ...(day.anchor_median_lag_days !== undefined && { anchor_median_lag_days: day.anchor_median_lag_days }),
                ...(day.anchor_mean_lag_days !== undefined && { anchor_mean_lag_days: day.anchor_mean_lag_days }),
              }));
            } else {
              baseTimeSeries = baseRawTimeSeries.map((day: any) => ({
                date: day.date,
                n: day.k,  // Use k as n
                k: day.k,  // (k is the same for reference)
                p: day.p,
                ...(day.median_lag_days !== undefined && { median_lag_days: day.median_lag_days }),
                ...(day.mean_lag_days !== undefined && { mean_lag_days: day.mean_lag_days }),
                ...(day.anchor_median_lag_days !== undefined && { anchor_median_lag_days: day.anchor_median_lag_days }),
                ...(day.anchor_mean_lag_days !== undefined && { anchor_mean_lag_days: day.anchor_mean_lag_days }),
              }));
            }
          } else {
            baseTimeSeries = baseRawTimeSeries;
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
        
        const { executeCompositeQuery } = await import('../../lib/das/compositeQueryExecutor');
        
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
              // CRITICAL (§0.1): Also preserve latency from base time-series (k_query result)
              if (needsDualQuery && baseTimeSeries) {
                const baseDateMap = new Map(baseTimeSeries.map((d: any) => [d.date, {
                  n: d.n,
                  median_lag_days: d.median_lag_days,
                  mean_lag_days: d.mean_lag_days,
                  anchor_median_lag_days: d.anchor_median_lag_days,
                  anchor_mean_lag_days: d.anchor_mean_lag_days,
                }]));
                timeSeries = timeSeries.map((day: any) => {
                  const baseData = baseDateMap.get(day.date);
                  const base_n = baseData?.n ?? day.n;
                  return {
                    date: day.date,
                    n: base_n,  // Use base n
                    k: day.k,   // Keep composite k
                    p: base_n > 0 ? day.k / base_n : 0,
                    // Preserve latency from composite (if present) or fall back to base
                    ...(day.median_lag_days !== undefined 
                        ? { median_lag_days: day.median_lag_days }
                        : baseData?.median_lag_days !== undefined 
                          ? { median_lag_days: baseData.median_lag_days }
                          : {}),
                    ...(day.mean_lag_days !== undefined 
                        ? { mean_lag_days: day.mean_lag_days }
                        : baseData?.mean_lag_days !== undefined 
                          ? { mean_lag_days: baseData.mean_lag_days }
                          : {}),
                    ...(day.anchor_median_lag_days !== undefined 
                        ? { anchor_median_lag_days: day.anchor_median_lag_days }
                        : baseData?.anchor_median_lag_days !== undefined 
                          ? { anchor_median_lag_days: baseData.anchor_median_lag_days }
                          : {}),
                    ...(day.anchor_mean_lag_days !== undefined 
                        ? { anchor_mean_lag_days: day.anchor_mean_lag_days }
                        : baseData?.anchor_mean_lag_days !== undefined 
                          ? { anchor_mean_lag_days: baseData.anchor_mean_lag_days }
                          : {}),
                  };
                });
                console.log('[DataOps:DUAL_QUERY] Overrode composite time-series n with base n (latency preserved)');
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
        if (shouldThrowForAtomicityRateLimit(errorMsg)) {
          // Force orchestrator-level cooldown + restart for scope S.
          throw new Error(errorMsg);
        }
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
          if (shouldThrowForAtomicityRateLimit(condResult.error)) {
            // Force orchestrator-level cooldown + restart for scope S.
            throw new Error(condResult.error);
          }
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
          const condTimeSeries = Array.isArray(condRaw?.time_series)
            ? condRaw.time_series
            : (condRaw?.time_series && typeof condRaw.time_series === 'object' && condRaw.time_series.date)
              ? [condRaw.time_series]
              : [];
          
          // Build combined time series
          // For conditional probability: n comes from conditioned query (users at 'from' who visited upstream)
          // unless there's an explicit n_query, in which case n comes from that
          //
          // CRITICAL (3-Feb-26): Preserve latency + anchor lag fields from the conditioned query.
          // Dual-query exists only to source the denominator (n) correctly; it must not discard
          // `median_lag_days` / `mean_lag_days` / `anchor_*_lag_days` which are required for LAG.
          const combinedTimeSeries: Array<
            { date: string; n: number; k: number; p: number } & Record<string, any>
          > = [];
          
          if (explicitNQuery && baseTimeSeries) {
            // With explicit n_query: use base (n_query) for n, conditioned for k.
            // Start from conditioned rows (carry latency), then overwrite n by date from base series.
            const baseNByDate = new Map<string, number>(
              baseTimeSeries
                .filter((d: any) => d && typeof d.date === 'string')
                .map((d: any) => [d.date, Number(d.n ?? 0)])
            );

            const combinedByDate = new Map<
              string,
              { date: string; n: number; k: number; p: number } & Record<string, any>
            >();

            for (const day of condTimeSeries) {
              if (!day || typeof day.date !== 'string') continue;
              const k = Number(day.k ?? 0);
              const nFromBase = baseNByDate.get(day.date);
              const n = Number.isFinite(nFromBase as number) ? Number(nFromBase) : Number(day.n ?? 0);
              combinedByDate.set(day.date, {
                ...day,
                date: day.date,
                n,
                k,
                p: n > 0 ? k / n : 0,
              });
            }

            // Ensure we include base-only dates as well (k=0, no latency fields).
            for (const [date, nVal] of baseNByDate.entries()) {
              if (combinedByDate.has(date)) continue;
              const n = Number(nVal ?? 0);
              combinedByDate.set(date, {
                date,
                n,
                k: 0,
                p: 0,
              });
            }

            combinedTimeSeries.push(...combinedByDate.values());
          } else {
            // Without explicit n_query: use conditioned query for BOTH n and k
            // This is the correct conditional probability P(to | from, visited)
            // Preserve any latency + anchor lag fields present on the conditioned rows.
            for (const day of condTimeSeries) {
              if (!day || typeof day.date !== 'string') continue;
              const n = Number(day.n ?? 0);
              const k = Number(day.k ?? 0);
              combinedTimeSeries.push({
                ...day,
                n, // Users at 'from' who visited upstream
                k, // Users who converted after visiting upstream
                p: n > 0 ? k / n : 0,
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
          if (shouldThrowForAtomicityRateLimit(userMessage)) {
            // Force orchestrator-level cooldown + restart for scope S.
            throw new Error(userMessage);
          }
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
          // LAG: Derive onset_delta_days from histogram (window slices only).
          // Policy: α-mass day (α from settings/settings.yaml) rounded to 1 d.p.
          {
            const rawAny = result.raw as any;
            const isWindowMode = !isCohortQuery;
            // Reset per-gap: onset must correspond to THIS fetch window.
            let onset: number | undefined;

            if (isWindowMode) {
              if (!forecastingSettingsForThisRun) {
                forecastingSettingsForThisRun = await forecastingSettingsService.getForecastingModelSettings();
              }
              const alpha = forecastingSettingsForThisRun.ONSET_MASS_FRACTION_ALPHA;
              const onsetDays = deriveOnsetDeltaDaysFromLagHistogram(rawAny?.lag_histogram, alpha);
              if (typeof onsetDays === 'number' && Number.isFinite(onsetDays)) {
                onset = roundTo1dp(onsetDays);
              }
            }

            // Persist onset for this gap (used by per-gap file persistence).
            lastOnsetDeltaDays = onset;
            if (typeof onset === 'number' && Number.isFinite(onset)) {
              if (sessionLogService.getDiagnosticLoggingEnabled()) {
                sessionLogService.addChild(
                  logOpId,
                  'info',
                  'ONSET_CAPTURED',
                  `Onset derived: ${onset} day${onset === 1 ? '' : 's'}`,
                  undefined,
                  {
                    onset_delta_days: onset,
                    has_lag_histogram: !!rawAny?.lag_histogram,
                    lag_histogram_bins: Array.isArray(rawAny?.lag_histogram?.bins) ? rawAny.lag_histogram.bins.length : undefined,
                    sliceDSL: targetSlice || extractSliceDimensions(currentDSL || ''),
                    mode: isCohortQuery ? 'cohort' : 'window',
                    alpha: forecastingSettingsForThisRun?.ONSET_MASS_FRACTION_ALPHA,
                  }
                );
              }
            } else if (sessionLogService.getDiagnosticLoggingEnabled()) {
              // Important for debugging: distinguish "not present" vs "present but null".
              const hasKey = rawAny && Object.prototype.hasOwnProperty.call(rawAny, 'onset_delta_days');
              sessionLogService.addChild(
                logOpId,
                'info',
                'ONSET_NOT_DERIVED',
                `Onset not derived (${hasKey ? 'present-but-null' : 'missing'})`,
                undefined,
                {
                  onset_delta_days: onset ?? null,
                  has_onset_key: hasKey,
                  has_lag_histogram: !!rawAny?.lag_histogram,
                  lag_histogram_bins: Array.isArray(rawAny?.lag_histogram?.bins) ? rawAny.lag_histogram.bins.length : undefined,
                  sliceDSL: targetSlice || extractSliceDimensions(currentDSL || ''),
                  mode: isCohortQuery ? 'cohort' : 'window',
                  alpha: forecastingSettingsForThisRun?.ONSET_MASS_FRACTION_ALPHA,
                }
              );
            }
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
              const { extractSheetsUpdateDataForEdge } = await import('../dataOperationsService');
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
      updateData.retrieved_at = retrievalBatchAtISO;
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
        retrieved_at: retrievalBatchAtISO,
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
          
          // =========================================================================
          // SNAPSHOT DB: Shadow-write fetched data to database (incremental persist path)
          // This mirrors the snapshot write in the else branch below.
          // =========================================================================
          // Dense snapshot DB writes: write explicit 0 rows for missing days too.
          // This keeps DB coverage aligned with file-side "no data" markers.
          if (querySignature && actualFetchWindows.length > 0 && !dontExecuteHttp) {
            const diagnosticOn = sessionLogService.getDiagnosticLoggingEnabled();
            let dbParamId = '';
            
            try {
              const workspace = (() => {
                const pf = fileRegistry.getFile(`parameter-${objectId}`);
                return {
                  repository: pf?.source?.repository || 'unknown',
                  branch: pf?.source?.branch || 'unknown',
                };
              })();
              
              dbParamId = `${workspace.repository}-${workspace.branch}-${objectId}`;
              const sliceDSL = targetSlice || extractSliceDimensions(currentDSL || '');
              
              const snapshotRows = buildDenseSnapshotRowsForDbWrite({
                allTimeSeriesData,
                actualFetchWindows,
                isCohortQuery,
                lastOnsetDeltaDays,
              });
              
              const { appendSnapshots } = await import('../snapshotWriteService');
              
              const result = await appendSnapshots({
                param_id: dbParamId,
                canonical_signature: String(querySignature || ''),
                inputs_json: (() => {
                  // Minimal, human-diffable evidence blob (flexi_sigs.md §4.3).
                  const canonical_signature = String(querySignature || '');
                  let parsed: any = null;
                  try {
                    parsed = canonical_signature.trim().startsWith('{') ? JSON.parse(canonical_signature) : null;
                  } catch {
                    parsed = null;
                  }
                  const context_def_hashes = (parsed && typeof parsed.x === 'object' && parsed.x) ? parsed.x : {};
                  const core = (parsed && typeof parsed.c === 'string') ? parsed.c : undefined;
                  return {
                    schema: 'flexi_sigs.inputs_json.v1',
                    workspace,
                    param_id: dbParamId,
                    generated_at: retrievalBatchAtISO,
                    canonical_signature,
                    canonical_signature_parts: {
                      core,
                      context_def_hashes,
                    },
                    summary: {
                      slice_key: sliceDSL || '',
                      context_keys: Object.keys(context_def_hashes || {}).sort(),
                    },
                    provenance: {
                      graph_name: (graph as any)?.name,
                      graph_id: (graph as any)?.id ?? (graph as any)?.uuid,
                    },
                  };
                })(),
                sig_algo: 'sig_v1_sha256_trunc128_b64url',
                slice_key: sliceDSL || '',
                retrieved_at: retrievalBatchAt,
                rows: snapshotRows,
                diagnostic: diagnosticOn,
              });
              
              if (result.success) {
                if (result.inserted > 0) {
                  const diag = result.diagnostic;
                  sessionLogService.addChild(logOpId, 'info', 'SNAPSHOT_WRITE',
                    `Wrote ${result.inserted} snapshot rows to DB`,
                    diag ? `${diag.sql_time_ms}ms` : undefined,
                    diag ? {
                      param_id: dbParamId,
                      date_range: diag.date_range,
                      rows_attempted: diag.rows_attempted,
                      rows_inserted: diag.rows_inserted,
                      duplicates_skipped: diag.duplicates_skipped,
                      has_latency: diag.has_latency,
                      has_anchor: diag.has_anchor,
                      slice_key: diag.slice_key,
                    } : { param_id: dbParamId, inserted: result.inserted }
                  );
                }
              } else {
                sessionLogService.addChild(logOpId, 'warning', 'SNAPSHOT_WRITE_FAILED',
                  `Snapshot write failed: ${result.error || 'unknown error'}`,
                  undefined,
                  { param_id: dbParamId, error: result.error }
                );
              }
            } catch (error) {
              console.warn('[DataOps] Snapshot write failed (non-fatal):', error);
              sessionLogService.addChild(logOpId, 'warning', 'SNAPSHOT_WRITE_ERROR',
                `Snapshot write error: ${error instanceof Error ? error.message : error}`,
                undefined,
                { param_id: dbParamId || objectId }
              );
            }
          }
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
                    // LAG: Pass onset_delta_days for per-slice storage (window slices only)
                    ...(lastOnsetDeltaDays !== undefined && {
                      latencySummary: {
                        onset_delta_days: lastOnsetDeltaDays,
                      },
                    }),
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
          
          // =========================================================================
          // SNAPSHOT DB: Shadow-write fetched data to database
          // This is fire-and-forget - failures are logged but don't block the fetch.
          //
          // CRITICAL:
          // - Write is gated on "we actually fetched windows" (actualFetchWindows > 0), not on
          //   "API returned non-empty time-series". Sparse/empty responses should still record
          //   explicit zeros in the DB so coverage checks don't interpret "no rows" as "never fetched".
          // =========================================================================
          if (querySignature && actualFetchWindows.length > 0 && !dontExecuteHttp) {
            const diagnosticOn = sessionLogService.getDiagnosticLoggingEnabled();
            let dbParamId = '';
            
            try {
              const workspace = (() => {
                const pf = fileRegistry.getFile(`parameter-${objectId}`);
                return {
                  repository: pf?.source?.repository || 'unknown',
                  branch: pf?.source?.branch || 'unknown',
                };
              })();
              
              dbParamId = `${workspace.repository}-${workspace.branch}-${objectId}`;
              
              const snapshotRows = buildDenseSnapshotRowsForDbWrite({
                allTimeSeriesData,
                actualFetchWindows,
                isCohortQuery,
                lastOnsetDeltaDays,
              });
              
              // Dynamic import to avoid circular deps and enable tree-shaking
              const { appendSnapshots } = await import('../snapshotWriteService');
              
              // Snapshot DB write: store query signature alongside rows
              // Pass diagnostic flag so backend returns detailed info for session log
              const result = await appendSnapshots({
                param_id: dbParamId,
                canonical_signature: String(querySignature || ''),
                inputs_json: (() => {
                  const canonical_signature = String(querySignature || '');
                  let parsed: any = null;
                  try {
                    parsed = canonical_signature.trim().startsWith('{') ? JSON.parse(canonical_signature) : null;
                  } catch {
                    parsed = null;
                  }
                  const context_def_hashes = (parsed && typeof parsed.x === 'object' && parsed.x) ? parsed.x : {};
                  const core = (parsed && typeof parsed.c === 'string') ? parsed.c : undefined;
                  return {
                    schema: 'flexi_sigs.inputs_json.v1',
                    workspace,
                    param_id: dbParamId,
                    generated_at: retrievalBatchAtISO,
                    canonical_signature,
                    canonical_signature_parts: {
                      core,
                      context_def_hashes,
                    },
                    summary: {
                      slice_key: sliceDSL || '',
                      context_keys: Object.keys(context_def_hashes || {}).sort(),
                    },
                    provenance: {
                      graph_name: (graph as any)?.name,
                      graph_id: (graph as any)?.id ?? (graph as any)?.uuid,
                    },
                  };
                })(),
                sig_algo: 'sig_v1_sha256_trunc128_b64url',
                slice_key: sliceDSL || '',
                retrieved_at: retrievalBatchAt,
                rows: snapshotRows,
                diagnostic: diagnosticOn,  // Request detailed info from backend
              });
              
              if (result.success) {
                if (result.inserted > 0) {
                  // Log success with backend diagnostic info if available
                  const diag = result.diagnostic;
                  sessionLogService.addChild(logOpId, 'info', 'SNAPSHOT_WRITE',
                    `Wrote ${result.inserted} snapshot rows to DB`,
                    diag ? `${diag.sql_time_ms}ms` : undefined,
                    diag ? {
                      param_id: dbParamId,
                      date_range: diag.date_range,
                      rows_attempted: diag.rows_attempted,
                      rows_inserted: diag.rows_inserted,
                      duplicates_skipped: diag.duplicates_skipped,
                      has_latency: diag.has_latency,
                      has_anchor: diag.has_anchor,
                      slice_key: diag.slice_key,
                    } : { param_id: dbParamId, inserted: result.inserted }
                  );
                } else if (diagnosticOn) {
                  // Log duplicates only in diagnostic mode (all rows already existed)
                  const diag = result.diagnostic;
                  sessionLogService.addChild(logOpId, 'info', 'SNAPSHOT_WRITE_SKIPPED',
                    `All ${diag?.rows_attempted || snapshotRows.length} rows already in DB`,
                    diag ? `${diag.sql_time_ms}ms` : undefined,
                    diag ? {
                      param_id: dbParamId,
                      date_range: diag.date_range,
                      duplicates_skipped: diag.duplicates_skipped,
                    } : { param_id: dbParamId }
                  );
                }
              } else {
                // DB returned error but we still have data in file
                sessionLogService.addChild(logOpId, 'warning', 'SNAPSHOT_WRITE_FAILED',
                  `Snapshot write failed: ${result.error || 'unknown error'}`,
                  undefined,
                  { param_id: dbParamId, error: result.error }
                );
              }
            } catch (error) {
              // Network/server error - log but don't fail the fetch
              console.warn('[DataOps] Snapshot write failed (non-fatal):', error);
              sessionLogService.addChild(logOpId, 'warning', 'SNAPSHOT_WRITE_ERROR',
                `Snapshot write error: ${error instanceof Error ? error.message : error}`,
                undefined,
                { param_id: dbParamId || objectId }
              );
            }
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
      await getParameterFromFile({
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
          window_from: normalizeToUK(retrievalBatchAtISO),
          window_to: null,
          variants,
          // Capture provenance on the schedule itself (case file history)
          retrieved_at: retrievalBatchAtISO,
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
            const { UpdateManager } = await import('../UpdateManager');
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
