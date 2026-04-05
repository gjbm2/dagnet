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
import {
  WindowAggregationService,
} from './windowAggregationService';
import { buildScopedParamsFromFlatPack, ParamSlot } from './ParamPackDSLService';
import { sessionLogService } from './sessionLogService';

// ── Extracted modules (slimdown) ─────────────────────────────────────────────
import {
  batchableToastSuccess,
  batchableToastError,
} from './dataOperations/batchMode';

// Re-export public API so existing import sites are unchanged.
export { setBatchMode, isBatchMode, discardBatchMode } from './dataOperations/batchMode';
export { formatEdgeForLog, formatNodeForLog, compileExcludeQuery } from './dataOperations/logHelpers';
export { computeQuerySignature, extractContextKeysFromConstraints } from './dataOperations/querySignature';
export { selectQuerySignatureForAsat, convertVirtualSnapshotToTimeSeries, fireAsatWarnings, buildDenseSnapshotRowsForDbWrite } from './dataOperations/asatQuerySupport';
import {
  addEvidenceAndForecastScalars,
} from './dataOperations/evidenceForecastScalars';
export { addEvidenceAndForecastScalars } from './dataOperations/evidenceForecastScalars';
import {
  getParameterFromFile,
  getCaseFromFile,
  getNodeFromFile,
} from './dataOperations/fileToGraphSync';
export { getParameterFromFile, getCaseFromFile, getNodeFromFile } from './dataOperations/fileToGraphSync';
import {
  putParameterToFile,
  putCaseToFile,
  putNodeToFile,
} from './dataOperations/graphToFileSync';
export { putParameterToFile, putCaseToFile, putNodeToFile } from './dataOperations/graphToFileSync';
import { applyChanges } from './dataOperations/applyChanges';
export { applyChanges } from './dataOperations/applyChanges';
import {
  openConnectionSettings,
  openForecastingSettings,
  clearCache,
} from './dataOperations/cacheManagement';
export { openConnectionSettings, openForecastingSettings, clearCache } from './dataOperations/cacheManagement';
import {
  getFromSourceDirect,
} from './dataOperations/getFromSourceDirect';
export { getFromSourceDirect } from './dataOperations/getFromSourceDirect';

// ── Extracted types (slimdown DOS-PR5 + DOS-PR8) ────────────────────────────────
export type { PermissionCopyMode, PutToFileCopyOptions, GetFromFileCopyOptions } from './dataOperations/types';
import type { CacheAnalysisResult, GetFromSourceResult } from './dataOperations/types';
export type { CacheAnalysisResult, FetchWindowsPlanResult, GetFromSourceResult } from './dataOperations/types';

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

class DataOperationsService {
  // Delegate methods for backward compatibility (callers use dataOperationsService.method()).
  getParameterFromFile = getParameterFromFile;
  getCaseFromFile = getCaseFromFile;
  getNodeFromFile = getNodeFromFile;
  putParameterToFile = putParameterToFile;
  putCaseToFile = putCaseToFile;
  putNodeToFile = putNodeToFile;
  // ── Cluster L (cache & settings) extracted to dataOperations/cacheManagement.ts ─
  openConnectionSettings = openConnectionSettings;
  openForecastingSettings = openForecastingSettings;
  clearCache = clearCache;
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
    /**
     * Shared retrieval-batch timestamp (key-fixes.md §2.1).
     * When provided, all snapshot writes use this instead of minting a new Date().
     * Callers that orchestrate multiple slices for the same param (e.g. retrieve-all)
     * should mint one Date and pass it to every per-slice getFromSource call.
     */
    retrievalBatchAt?: Date;
    /**
     * Enforce atomicity at scope S during execution:
     * S = param × slice × hash (slice = window()/cohort() + any context(...) clauses, args discarded).
     *
     * When true, rate-limit interruptions must NOT allow a partially-persisted S to
     * limp to completion hours later (which would split the effective retrieved_at
     * window). Instead, a rate-limit error should be thrown so the caller can apply
     * cooldown + restart semantics for S.
     */
    enforceAtomicityScopeS?: boolean;
  }): Promise<GetFromSourceResult> {
    const { objectType, objectId, targetId, graph, setGraph, paramSlot, conditionalIndex, bustCache, targetSlice = '', currentDSL, boundedCohortWindow, skipCohortBounding, dontExecuteHttp, overrideFetchWindows, onCacheAnalysis, retrievalBatchAt, enforceAtomicityScopeS } = options;
    sessionLogService.info('data-fetch', 'DATA_GET_FROM_SOURCE', `Get from Source (versioned): ${objectType} ${objectId}`,
      undefined, { fileId: `${objectType}-${objectId}`, fileType: objectType }, { diagnostic: true });
    
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
          retrievalBatchAt,
          enforceAtomicityScopeS,
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
          retrievalBatchAt,
          enforceAtomicityScopeS,
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
            await getCaseFromFile({
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
  
  // ── Cluster I (getFromSourceDirect) extracted to dataOperations/getFromSourceDirect.ts ─
  getFromSourceDirect = getFromSourceDirect;
  
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

    // Shared retrieval-batch timestamp for all items in this batch
    // (key-fixes.md §2.1 — atomic retrieval events).
    const retrievalBatchAt = new Date();
    
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
            targetSlice,
            retrievalBatchAt,
          });
        } else if (item.type === 'case') {
          await this.getFromSource({
            objectType: 'case',
            objectId: item.objectId,
            targetId: item.targetId,
            graph: currentGraph,
            setGraph: setGraphInternal,
            currentDSL: currentDSL || '',
            retrievalBatchAt,
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
  ) => addEvidenceAndForecastScalars(
    aggregatedData,
    originalParamData,
    targetSlice,
    undefined
  ),
};

