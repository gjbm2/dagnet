/**
 * File → Graph sync operations (GET direction).
 *
 * Reads data from parameter/case/node files and applies it to graph edges/nodes,
 * including window/cohort aggregation, asat queries, evidence/forecast scalars,
 * and signature checking.
 *
 * Extracted from dataOperationsService.ts (Cluster F) during slimdown.
 */

import toast from 'react-hot-toast';
import { fileRegistry } from '../../contexts/TabContext';
import { UpdateManager } from '../UpdateManager';
import type { Graph, DateRange, TimeSeriesPoint } from '../../types';
import type { ParameterValue } from '../../types/parameterData';
import type { GetFromFileCopyOptions, PermissionCopyMode } from './types';
import {
  aggregateCohortData,
  aggregateWindowData,
  normalizeDate,
  parseDate,
  isDateInRange,
  isCohortModeValue,
} from '../windowAggregationService';
import { normalizeConstraintString, parseConstraints } from '../../lib/queryDSL';
import { isolateSlice, extractSliceDimensions, hasContextAny } from '../sliceIsolation';
import { parameterValueRecencyMs, selectImplicitUncontextedSliceSetSync } from '../meceSliceService';
import { sessionLogService } from '../sessionLogService';
import { forecastingSettingsService } from '../forecastingSettingsService';
import { normalizeToUK, formatDateUK, parseUKDate, resolveRelativeDate } from '../../lib/dateFormat';
import { db } from '../../db/appDatabase';
import { querySnapshotsVirtual } from '../snapshotWriteService';
import {
  batchableToast,
  batchableToastSuccess,
  batchableToastError,
} from './batchMode';
import { computeQuerySignature, extractContextKeysFromConstraints } from './querySignature';
import { selectQuerySignatureForAsat, convertVirtualSnapshotToTimeSeries, fireAsatWarnings } from './asatQuerySupport';
import { addEvidenceAndForecastScalars } from './evidenceForecastScalars';
import { WindowAggregationService } from '../windowAggregationService';
import { statisticalEnhancementService } from '../statisticalEnhancementService';
import { isSignatureCheckingEnabled } from '../signaturePolicyService';
import { parseSignature } from '../signatureMatchingService';
import { resolveMECEPartitionForImplicitUncontexted } from '../meceSliceService';
import { buildDslFromEdge } from '../../lib/das/buildDslFromEdge';
import { createDASRunner } from '../../lib/das';
import { applyChanges } from './applyChanges';

// Module-level singletons (mirrors dataOperationsService.ts pattern).
const windowAggregationService = new WindowAggregationService();
const updateManager = new UpdateManager();
let _cachedDASRunner: ReturnType<typeof createDASRunner> | null = null;
function getCachedDASRunner() {
  if (!_cachedDASRunner) {
    _cachedDASRunner = createDASRunner();
  }
  return _cachedDASRunner;
}

// =============================================================================
// getParameterFromFile
// =============================================================================

export async function getParameterFromFile(options: {
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

    // ============================================================================
    // asat() Historical Query Fork Point (getParameterFromFile)
    // ============================================================================
    // If asat is present, route to snapshot DB instead of reading from file.
    // Per §3.2 of 3-asat.md: Signature validation is MANDATORY.
    if (parsed.asat) {
      console.log(`[DataOperationsService] Detected asat(${parsed.asat}) in getParameterFromFile - routing to snapshot DB`);
      const asatLogOpId = sessionLogService.startOperation(
        'info',
        'data-fetch',
        'ASAT_FROM_FILE',
        `As-at snapshot query (from-file): ${paramId}`,
        { paramId, edgeId, fileId: `parameter-${paramId}`, dsl: targetSlice },
        { diagnostic: true }
      );
      
      // Build workspace-prefixed param_id from parameter file source metadata
      const paramFile = fileRegistry.getFile(`parameter-${paramId}`);
      const workspaceRepo = paramFile?.source?.repository;
      const workspaceBranch = paramFile?.source?.branch;
      // Signature is part of the DB lookup key, and param_id is workspace-prefixed.
      // If we can't form the workspace prefix, we can't query snapshots. Treat as "no data".
      if (!workspaceRepo || !workspaceBranch) {
        console.warn('[DataOperationsService] asat: missing parameter file source metadata (repository/branch); snapshot lookup skipped');
        sessionLogService.endOperation(asatLogOpId, 'warning', 'asat: missing workspace metadata (snapshot lookup skipped)');
        return { success: true, warning: 'No snapshot data (missing workspace metadata)' };
      }
      const dbParamId = `${workspaceRepo}-${workspaceBranch}-${paramId}`;
      
      // Resolve window/cohort dates
      let anchorFrom: string | undefined;
      let anchorTo: string | undefined;
      
      if (parsed.cohort?.start || parsed.cohort?.end) {
        anchorFrom = parsed.cohort.start ? resolveRelativeDate(parsed.cohort.start) : undefined;
        anchorTo = parsed.cohort.end ? resolveRelativeDate(parsed.cohort.end) : todayUK;
      } else if (parsed.window?.start || parsed.window?.end) {
        anchorFrom = parsed.window.start ? resolveRelativeDate(parsed.window.start) : undefined;
        anchorTo = parsed.window.end ? resolveRelativeDate(parsed.window.end) : todayUK;
      } else {
        // Default window
        anchorFrom = resolveRelativeDate('-60d');
        anchorTo = todayUK;
      }
      
      if (!anchorFrom || !anchorTo) {
        console.warn('[DataOperationsService] asat query missing valid date range');
        sessionLogService.endOperation(asatLogOpId, 'warning', 'asat: missing valid window/cohort range (snapshot lookup skipped)');
        return { success: false, warning: 'Historical query requires a valid date range' };
      }
      
      // Convert UK dates to ISO for API (defensive: treat inverted bounds as unordered)
      const aFromDate = parseUKDate(anchorFrom);
      const aToDate = parseUKDate(anchorTo);
      const fromISO = aFromDate.toISOString().split('T')[0];
      const toISO = aToDate.toISOString().split('T')[0];
      const anchorFromISO = fromISO <= toISO ? fromISO : toISO;
      const anchorToISO = fromISO <= toISO ? toISO : fromISO;
      
      // Convert asat date to ISO datetime (end of day, UTC)
      const asatDateUK = resolveRelativeDate(parsed.asat);
      const asatDateObj = parseUKDate(asatDateUK);
      asatDateObj.setUTCHours(23, 59, 59, 999);
      const asAtISO = asatDateObj.toISOString();
      
      // Extract slice_keys (slice-family selectors):
      // slice identity = context/case dims + temporal mode (window vs cohort).
      // We intentionally ignore window/cohort *arguments* for matching.
      const sliceDims = extractSliceDimensions(targetSlice);
      const modeClause = parsed.cohort ? 'cohort()' : (parsed.window ? 'window()' : '');
      const sliceFamilyKey = [sliceDims, modeClause].filter(Boolean).join('.');

      // IMPORTANT:
      // If the DSL is uncontexted (no explicit context dims), do NOT apply a slice filter.
      // Uncontexted reads must be able to aggregate across MECE context slices. Slice filtering
      // here is unnecessary and can incorrectly return 0 rows depending on how slice_key was written.
      const sliceKeyArray = sliceDims ? (sliceFamilyKey ? [sliceFamilyKey] : undefined) : undefined;
      
      // ========================================================================
      // MANDATORY: Signature integrity (do NOT recompute).
      // ========================================================================
      // Snapshot reads MUST be keyed by the exact canonical signature that was written
      // with the fetched data. Recomputing here is unsafe (context/pinned-dims and
      // normalisation drift can produce a different signature and yield 0 rows).
      const signatureStr = (() => {
        const values: any[] = Array.isArray((paramFile as any)?.data?.values) ? (paramFile as any).data.values : [];
        const mode: 'window' | 'cohort' = parsed.cohort ? 'cohort' : 'window';
        return selectQuerySignatureForAsat({ values, mode });
      })();
      if (!signatureStr) {
        const modeLabel = parsed.cohort ? 'cohort' : 'window';
        console.warn(
          `[DataOperationsService] asat: no query_signature matching mode=${modeLabel} in parameter file; snapshot lookup skipped`
        );
        sessionLogService.endOperation(
          asatLogOpId,
          'warning',
          `asat: no mode-matching query_signature (${modeLabel}) (snapshot lookup skipped)`
        );
        return { success: true, warning: 'No snapshot data (missing query signature)' };
      }
      const sigParsed = parseSignature(signatureStr);
      if (!sigParsed.coreHash) {
        console.warn('[DataOperationsService] asat: invalid query_signature in parameter file; snapshot lookup skipped');
        sessionLogService.endOperation(asatLogOpId, 'warning', 'asat: invalid query_signature (snapshot lookup skipped)');
        return { success: true, warning: 'No snapshot data (invalid query signature)' };
      }
      
      console.log('[DataOperationsService] asat query params:', {
        dbParamId, anchorFromISO, anchorToISO, asAtISO, sliceKeyArray, coreHash: sigParsed.coreHash
      });
      sessionLogService.addChild(
        asatLogOpId,
        'info',
        'ASAT_QUERY',
        `Querying virtual snapshot: ${anchorFromISO} to ${anchorToISO} as-at ${asatDateUK}`,
        undefined,
        {
          param_id: dbParamId,
          anchor_from: anchorFromISO,
          anchor_to: anchorToISO,
          as_at: asAtISO,
          slice_keys: sliceKeyArray,
          core_hash: sigParsed.coreHash,
        }
      );
      
      // Call virtual snapshot query with MANDATORY canonical_signature
      const virtualResult = await querySnapshotsVirtual({
        param_id: dbParamId,
        as_at: asAtISO,
        anchor_from: anchorFromISO,
        anchor_to: anchorToISO,
        slice_keys: sliceKeyArray,
        canonical_signature: signatureStr,
      });
      
      if (!virtualResult.success) {
        console.error('[DataOperationsService] Virtual snapshot query failed:', virtualResult.error);
        sessionLogService.endOperation(asatLogOpId, 'error', `Virtual snapshot query failed: ${virtualResult.error}`);
        return { success: false, warning: `Snapshot query failed: ${virtualResult.error}` };
      }
      
      console.log('[DataOperationsService] Virtual snapshot returned', virtualResult.count, 'rows');
      sessionLogService.addChild(
        asatLogOpId,
        'info',
        'ASAT_RESULT',
        `Virtual snapshot returned ${virtualResult.count} rows`,
        undefined,
        {
          count: virtualResult.count,
          latestRetrievedAt: virtualResult.latest_retrieved_at_used,
          hasAnchorTo: virtualResult.has_anchor_to,
          hasAnyRows: virtualResult.has_any_rows,
          hasMatchingCoreHash: virtualResult.has_matching_core_hash,
        }
      );

      if (virtualResult.count === 0) {
        // Avoid spamming UI error toasts for every item in batch mode.
        // Propagate as a failure so the batch summary + session log explains what happened.
        const mismatchHint =
          virtualResult.has_any_rows && virtualResult.has_matching_core_hash === false
            ? 'Snapshot DB contains rows for this param/window, but none match the current query signature.'
            : undefined;
        const msg =
          mismatchHint
            ? `No snapshot rows matched signature as-at ${asatDateUK}. ${mismatchHint}`
            : `No snapshot data available as-at ${asatDateUK}.`;
        sessionLogService.endOperation(asatLogOpId, 'warning', msg);
        return { success: false, warning: msg };
      }
      
      // Fire warnings per §6.3 (batch-aware)
      const entityLabel = paramId;
      fireAsatWarnings(
        asatDateUK,
        virtualResult.latest_retrieved_at_used,
        virtualResult.has_anchor_to,
        anchorTo,
        entityLabel
      );
      
      // Convert to time series and apply to graph
      // Use the slice-family key (dims + mode), or mode-only key for uncontexted queries.
      // (convertVirtualSnapshotToTimeSeries handles normalised matching + implicit aggregation.)
      const targetSliceKey = sliceDims ? (sliceFamilyKey || '') : '';
      const timeSeries = convertVirtualSnapshotToTimeSeries(virtualResult.rows, targetSliceKey, {
        workspace: { repository: workspaceRepo, branch: workspaceBranch },
      });
      
      if (graph && setGraph && edgeId) {
        const targetEdge: any = graph.edges?.find((e: any) => e.uuid === edgeId || e.id === edgeId);
        if (targetEdge) {
          // Simple aggregation
          const totalN = timeSeries.reduce((sum, pt) => sum + pt.n, 0);
          const totalK = timeSeries.reduce((sum, pt) => sum + pt.k, 0);
          
          const newGraph = { ...graph };
          const newEdges = [...(newGraph.edges || [])];
          const edgeIndex = newEdges.findIndex((e: any) => e.uuid === edgeId || e.id === edgeId);
          
          if (edgeIndex >= 0) {
            const newEdge = { ...newEdges[edgeIndex] };
            const paramObj = conditionalIndex !== undefined 
              ? newEdge.conditional_p?.[conditionalIndex]?.p 
              : newEdge.p;
            
            if (paramObj && typeof paramObj === 'object') {
              (paramObj as any).n = totalN;
              (paramObj as any).k = totalK;
              (paramObj as any).n_daily = timeSeries.map(pt => pt.n);
              (paramObj as any).k_daily = timeSeries.map(pt => pt.k);
              (paramObj as any).dates = timeSeries.map(pt => pt.date);
              (paramObj as any)._asat = parsed.asat;
              (paramObj as any)._asat_retrieved_at = virtualResult.latest_retrieved_at_used;
            }
            
            newEdges[edgeIndex] = newEdge;
            newGraph.edges = newEdges;
            setGraph(newGraph);
          }
        }
      }
      
      sessionLogService.endOperation(
        asatLogOpId,
        'success',
        `Historical query complete: ${timeSeries.length} data points from snapshot as-at ${asatDateUK}`
      );
      return { success: true };
    }
    // ============================================================================
    // End asat() Fork
    // ============================================================================

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
    { fileId: `parameter-${paramId}`, fileType: 'parameter', targetId: edgeId },
    { diagnostic: true }
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
              // Resolution: edge slot → graph.defaultConnection (file connection is provenance only)
              const connectionName = targetEdge.p?.connection || 
                                   targetEdge.cost_gbp?.connection || 
                                   targetEdge.labour_cost?.connection ||
                                   graph.defaultConnection;
              
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
                const diagnosticOn = sessionLogService.getDiagnosticLoggingEnabled();
                
                if (file && file.data) {
                  if (diagnosticOn) {
                    sessionLogService.info('data-fetch', 'EVENT_LOADED', 
                      `Loaded event "${eventId}" for signature`,
                      undefined,
                      {
                        eventId,
                        source: 'getParameterFromFile',
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
                        `Loaded event "${eventId}" for signature (IndexedDB fallback)`,
                        undefined,
                        {
                          eventId,
                          source: 'getParameterFromFile:indexeddb',
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
                throw new Error(`[getParameterFromFile] Event file "${eventId}" not found in fileRegistry or IndexedDB. This indicates a workspace/clone issue.`);
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
                  signatureContextKeys,
                  undefined,  // workspace
                  compEventDefs  // eventDefinitions
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
              
              // DIAGNOSTIC: Log signature comparison result
              const diagnosticOn = sessionLogService.getDiagnosticLoggingEnabled();
              if (diagnosticOn) {
                sessionLogService.info('data-fetch', 'SIGNATURE_COMPARISON', 
                  `Comparing signatures for ${paramId}`,
                  undefined,
                  {
                    paramId,
                    expectedSignature: expectedQuerySignature,
                    latestCachedSignature: latestQuerySignature,
                    signatureToUse,
                    hasAnySignatures,
                    totalCachedValues: valuesWithDaily.length,
                    mismatchDetected: querySignatureMismatch || (latestQuerySignature && latestQuerySignature !== expectedQuerySignature),
                    mismatchedEntryCount: mismatchedEntries.length,
                  }
                );
              }
              
              if (
                isSignatureCheckingEnabled() &&
                (querySignatureMismatch || (latestQuerySignature && latestQuerySignature !== expectedQuerySignature))
              ) {
                // Log for debugging, but don't toast - file having old signatures is normal
                // and the system handles it correctly by using latest signature data
                if (diagnosticOn) {
                  sessionLogService.warning('data-fetch', 'SIGNATURE_MISMATCH', 
                    `Signature mismatch for ${paramId}: expected differs from cached`,
                    undefined,
                    {
                      paramId,
                      expectedSignature: expectedQuerySignature,
                      latestCachedSignature: latestQuerySignature,
                      mismatchedEntries: mismatchedEntries.slice(0, 5), // First 5 for brevity
                      totalMismatched: mismatchedEntries.length,
                    }
                  );
                }
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
                
                if (staleValues.length > 0 && diagnosticOn) {
                  sessionLogService.warning('data-fetch', 'STALE_VALUES_DETECTED', 
                    `${staleValues.length} values have stale signatures for ${paramId}`,
                    undefined,
                    {
                      paramId,
                      staleCount: staleValues.length,
                      signatureToUse,
                      staleSampleSignatures: staleValues.slice(0, 3).map(v => v.query_signature),
                    }
                  );
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
              source_retrieved_at: latestValueWithSource?.data_source?.source_retrieved_at
                || latestValueWithSource?.data_source?.retrieved_at
                || new Date().toISOString(),
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
          // Fall through to regular file-to-graph update for ALL aggregation
          // errors, including "no data for window". Bailing out entirely
          // prevents window-independent fields (posteriors, latency,
          // model_vars) from syncing to the graph edge.
          if (errorMsg.includes('No data available for window')) {
            const filterRange = (isCohortQuery && cohortWindow) ? cohortWindow : window;
            const rangeLabel = `${filterRange?.start} to ${filterRange?.end}`;
            const paramLabel = edgeId ? `${paramId} (edge ${edgeId})` : paramId;
            aggregationFallbackError = `no data for ${isCohortQuery ? 'cohort' : 'window'} (${rangeLabel})`;
            console.warn(`[DataOperationsService] ${paramLabel}: ${aggregationFallbackError} — falling back to raw file values`);
            sessionLogService.addChild(logOpId, 'warning', 'AGGREGATION_NO_DATA',
              `${paramLabel}: ${aggregationFallbackError}, using raw file values`);
          } else {
            batchableToastError(`${paramId}: window aggregation failed — ${errorMsg}`);
            aggregationFallbackError = errorMsg;
            console.warn('[DataOperationsService] Falling back to regular update:', error);
            sessionLogService.addChild(logOpId, 'warning', 'AGGREGATION_FALLBACK',
              `Window aggregation failed, using raw file values`,
              errorMsg,
              { error: errorMsg }
            );
          }
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
    aggregatedData = addEvidenceAndForecastScalars(
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
        
        const { updateManager } = await import('../UpdateManager');
        
        // Extract values from the changes that UpdateManager's handleFileToEdge produced
        // (these already have transforms applied - rounding, etc.)
        const meanChange = result.changes.find((c: { field: string }) => c.field === 'p.mean');
        const stdevChange = result.changes.find((c: { field: string }) => c.field === 'p.stdev');
        const nChange = result.changes.find((c: { field: string }) => c.field === 'p.evidence.n');
        const kChange = result.changes.find((c: { field: string }) => c.field === 'p.evidence.k');
        const windowFromChange = result.changes.find((c: { field: string }) => c.field === 'p.evidence.scope_from');
        const windowToChange = result.changes.find((c: { field: string }) => c.field === 'p.evidence.scope_to');
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
              scope_from: windowFromChange?.newValue,
              scope_to: windowToChange?.newValue,
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

      // MODEL_VARS: Upsert analytic entry built by UpdateManager (doc 15 §5.1)
      // Preserve path params from the existing entry — the parameter file doesn't
      // contain path_mu/path_sigma (they're topo-pass-derived), so the new entry
      // from UpdateManager won't have them.  Without this, every from-file
      // re-aggregation clobbers path params written by the previous topo pass.
      const analyticEntry = (result.metadata as any)?.analyticModelVarsEntry;
      if (analyticEntry && nextGraph.edges[edgeIndex].p) {
        const { upsertModelVars, applyPromotion } = await import('../modelVarsResolution');
        const existingAnalytic = nextGraph.edges[edgeIndex].p.model_vars?.find(
          (v: any) => v.source === 'analytic'
        );
        if (existingAnalytic?.latency && analyticEntry.latency) {
          const prevLat = existingAnalytic.latency;
          // Carry forward topo-pass-derived fields that the file doesn't contain
          if (analyticEntry.latency.path_mu == null && prevLat.path_mu != null) {
            analyticEntry.latency.path_mu = prevLat.path_mu;
          }
          if (analyticEntry.latency.path_sigma == null && prevLat.path_sigma != null) {
            analyticEntry.latency.path_sigma = prevLat.path_sigma;
          }
          if (analyticEntry.latency.path_t95 == null && prevLat.path_t95 != null) {
            analyticEntry.latency.path_t95 = prevLat.path_t95;
          }
          if (analyticEntry.latency.path_onset_delta_days == null && prevLat.path_onset_delta_days != null) {
            analyticEntry.latency.path_onset_delta_days = prevLat.path_onset_delta_days;
          }
          // Also preserve dispersion SDs
          for (const sdKey of ['mu_sd', 'sigma_sd', 'onset_sd', 'onset_mu_corr',
                               'path_mu_sd', 'path_sigma_sd', 'path_onset_sd'] as const) {
            if ((analyticEntry.latency as any)[sdKey] == null && (prevLat as any)[sdKey] != null) {
              (analyticEntry.latency as any)[sdKey] = (prevLat as any)[sdKey];
            }
          }
        }
        upsertModelVars(nextGraph.edges[edgeIndex].p, analyticEntry);
        // Run resolution to update promoted scalars (doc 15 §8)
        applyPromotion(nextGraph.edges[edgeIndex].p, nextGraph.model_source_preference);
      }

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
        const { UpdateManager } = await import('../UpdateManager');
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


// =============================================================================
// getCaseFromFile
// =============================================================================

export async function getCaseFromFile(options: {
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
    { fileId: `case-${caseId}`, fileType: 'case', targetId: nodeId },
    { diagnostic: true }
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
      const { WindowAggregationService } = await import('../windowAggregationService');
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
            const { updateManager } = await import('../UpdateManager');
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


// =============================================================================
// getNodeFromFile
// =============================================================================

export async function getNodeFromFile(options: {
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
    { fileId: `node-${nodeId}`, fileType: 'node', targetId: targetNodeUuid || nodeId },
    { diagnostic: true }
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

