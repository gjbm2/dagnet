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
} from './windowAggregationService';
import { statisticalEnhancementService } from './statisticalEnhancementService';
import type { ParameterValue } from './paramRegistryService';
import type { TimeSeriesPoint } from '../types';
import { buildScopedParamsFromFlatPack, ParamSlot } from './ParamPackDSLService';
import { isolateSlice } from './sliceIsolation';
import { sessionLogService } from './sessionLogService';

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
async function compileExcludeQuery(queryString: string, graph: any): Promise<string> {
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
      return queryString; // Return original on error
    }
    
    const result = await response.json();
    if (result.compiled_query) {
      return result.compiled_query;
    }
    
    console.warn('[compileExcludeQuery] No compiled_query in response:', result);
    return queryString;
  } catch (error) {
    console.error('[compileExcludeQuery] Failed to call compile API:', error);
    return queryString; // Return original on error
  }
}

// Shared UpdateManager instance
const updateManager = new UpdateManager();

// Shared WindowAggregationService instance
const windowAggregationService = new WindowAggregationService();

/**
 * Extract external update payload from Sheets DAS result for edge parameters.
 * Supports edge-param scope (p/cost_gbp/cost_time) and edge-conditional scope.
 */
export function extractSheetsUpdateDataForEdge(
  raw: any,
  connectionString: any,
  paramSlot: 'p' | 'cost_gbp' | 'cost_time' | undefined,
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
    } else if (slot === 'cost_time' && edgeParams.cost_time) {
      apply('mean', (edgeParams.cost_time as any).mean);
    } else {
      console.warn('[extractSheetsUpdateDataForEdge] No matching slot found:', {
        slot,
        hasP: !!edgeParams.p,
        hasCostGbp: !!edgeParams.cost_gbp,
        hasCostTime: !!edgeParams.cost_time,
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
  paramSlot: 'p' | 'cost_gbp' | 'cost_time' | undefined,
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
      
      // Parse query to get node references
      try {
        const { parseDSL } = await import('../lib/queryDSL');
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
 */
function applyChanges(target: any, changes: Array<{ field: string; newValue: any }>): void {
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
      
      // Handle array append syntax: "field[]"
      if (part.endsWith('[]')) {
        const arrayName = part.slice(0, -2); // Remove "[]"
        if (!obj[arrayName]) {
          console.log(`[applyChanges] Creating new array at ${arrayName}`);
          obj[arrayName] = [];
        }
        // Don't navigate into the array; we'll append to it at the end
        obj = obj[arrayName];
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
    if (finalPart.endsWith('[]')) {
      // Array append: push the new value
      const arrayName = finalPart.slice(0, -2);
      if (!obj[arrayName]) {
        console.log(`[applyChanges] Creating new array at ${arrayName}`);
        obj[arrayName] = [];
      }
      console.log(`[applyChanges] Appending to array ${arrayName}`);
      obj[arrayName].push(change.newValue);
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
    window?: DateRange; // Optional: if provided, aggregate daily data for this window
    targetSlice?: string; // Optional: DSL for specific slice (default '' = uncontexted)
  }): Promise<void> {
    const { paramId, edgeId, graph, setGraph, setAutoUpdating, window, targetSlice = '' } = options;
    
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
        return;
      }
      
      if (!edgeId) {
        toast.error('No edge selected');
        return;
      }
      
      // Check if file exists
      const paramFile = fileRegistry.getFile(`parameter-${paramId}`);
      if (!paramFile) {
        toast.error(`Parameter file not found: ${paramId}`);
        return;
      }
      
      // Find the target edge
      const targetEdge = graph.edges?.find((e: any) => e.uuid === edgeId || e.id === edgeId);
      if (!targetEdge) {
        toast.error(`Edge not found in graph`);
        return;
      }
      
      console.log('[DataOperationsService] TARGET EDGE AT START:', {
        'edge.uuid': targetEdge.uuid,
        'edge.p': JSON.stringify(targetEdge.p),
        'window': window
      });
      
      // If window is provided, aggregate daily data from parameter file
      let aggregatedData = paramFile.data;
      if (window && paramFile.data?.values) {
        // Collect ALL value entries with daily data
        const allValuesWithDaily = (paramFile.data.values as ParameterValue[])
          .filter(v => v.n_daily && v.k_daily && v.dates && v.n_daily.length > 0);
        
        // CRITICAL: Isolate to target slice to prevent cross-slice aggregation
        const valuesWithDaily = isolateSlice(allValuesWithDaily, targetSlice);
        
        if (valuesWithDaily.length > 0) {
          try {
            // Validate query signature consistency
            // Build DSL from edge to compute expected query signature
            let expectedQuerySignature: string | undefined;
            let querySignatureMismatch = false;
            const mismatchedEntries: Array<{ window: string; signature: string | undefined }> = [];
            
            if (edgeId && graph) {
              try {
                // Build DSL from edge to get current query
                const { buildDslFromEdge } = await import('../lib/das/buildDslFromEdge');
                
                // Get connection name for signature computation
                const connectionName = targetEdge.p?.connection || 
                                     targetEdge.cost_gbp?.connection || 
                                     targetEdge.cost_time?.connection ||
                                     paramFile.data.connection;
                
                // Get connection to extract provider
                const { createDASRunner } = await import('../lib/das');
                const tempRunner = createDASRunner();
                let connectionProvider: string | undefined;
                
                try {
                  const connection = connectionName ? await (tempRunner as any).connectionProvider.getConnection(connectionName) : null;
                  connectionProvider = connection?.provider;
                } catch (e) {
                  console.warn('Could not load connection for provider mapping:', e);
                }
                
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
                let constraints;
                try {
                  const { parseConstraints } = await import('../lib/queryDSL');
                  
                  // Parse graph-level constraints (from WindowSelector)
                  const graphConstraints = graph?.currentQueryDSL ? parseConstraints(graph.currentQueryDSL) : null;
                  
                  // Parse edge-specific constraints
                  const edgeConstraints = targetEdge.query ? parseConstraints(targetEdge.query) : null;
                  
                  // Merge: edge-specific overrides graph-level
                  constraints = {
                    context: [...(graphConstraints?.context || []), ...(edgeConstraints?.context || [])],
                    contextAny: [...(graphConstraints?.contextAny || []), ...(edgeConstraints?.contextAny || [])],
                    window: edgeConstraints?.window || graphConstraints?.window || null,
                    visited: edgeConstraints?.visited || [],
                    visitedAny: edgeConstraints?.visitedAny || []
                  };
                  
                  console.log('[DataOps:getDataSnapshot] Merged constraints:', {
                    graphDSL: graph?.currentQueryDSL,
                    edgeQuery: targetEdge.query,
                    merged: constraints
                  });
                } catch (error) {
                  console.warn('[DataOps:getDataSnapshot] Failed to parse constraints:', error);
                }
                
                // Build DSL from edge
                const compResult = await buildDslFromEdge(
                  targetEdge,
                  graph,
                  connectionProvider,
                  eventLoader,
                  constraints  // Pass constraints for context filters
                );
                const compDsl = compResult.queryPayload;
                const compEventDefs = compResult.eventDefinitions;
                
                // Compute expected query signature (include event_ids from nodes)
                expectedQuerySignature = await computeQuerySignature(compDsl, connectionName, graph, targetEdge);
                
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
                    mismatchedEntries.push({
                      window: `${normalizeDate(value.window_from || '')} to ${normalizeDate(value.window_to || '')}`,
                      signature: value.query_signature,
                    });
                  }
                }
                
                // If we found a latest signature and it differs from expected, use the latest one
                // (This handles the case where event definitions changed)
                const signatureToUse = latestQuerySignature || expectedQuerySignature;
                
                if (querySignatureMismatch || (latestQuerySignature && latestQuerySignature !== expectedQuerySignature)) {
                  console.warn('[DataOperationsService] Query signature mismatch detected:', {
                    expectedSignature: expectedQuerySignature,
                    latestSignature: latestQuerySignature,
                    signatureToUse,
                    mismatchedEntries,
                    totalEntries: valuesWithDaily.length,
                  });
                  
                  if (latestQuerySignature && latestQuerySignature !== expectedQuerySignature) {
                    toast(`⚠ Using latest query signature (event definitions may have changed). Filtering to matching entries only.`, {
                      icon: '⚠️',
                      duration: 5000,
                    });
                  } else {
                  toast(`⚠ Aggregating data with different query signatures (${mismatchedEntries.length} entry/entries)`, {
                    icon: '⚠️',
                    duration: 5000,
                  });
                  }
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
            
            // Combine all daily data from all value entries into a single time series
            const allTimeSeries: TimeSeriesPoint[] = [];
            
            // Normalize window for date comparison
            const normalizedWindow: DateRange = {
              start: normalizeDate(window.start),
              end: normalizeDate(window.end),
            };
            
            console.log('[DataOperationsService] Aggregating window:', {
              window: normalizedWindow,
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
              // Sort by retrieved_at or window_to (newest last) so newer entries overwrite older ones
              const aDate = a.data_source?.retrieved_at || a.window_to || a.window_from || '';
              const bDate = b.data_source?.retrieved_at || b.window_to || b.window_from || '';
              return aDate.localeCompare(bDate); // Oldest first, so when we process in order, newer overwrites older
            });
            
            for (let entryIdx = 0; entryIdx < sortedValues.length; entryIdx++) {
              const value = sortedValues[entryIdx];
              if (value.n_daily && value.k_daily && value.dates) {
                const entryWindow = `${normalizeDate(value.window_from || '')} to ${normalizeDate(value.window_to || '')}`;
                let entryDatesInWindow = 0;
                
                for (let i = 0; i < value.dates.length; i++) {
                  const date = normalizeDate(value.dates[i]);
                  // Only add if date is within window and not already added (or overwrite if newer)
                  if (isDateInRange(date, normalizedWindow)) {
                    entryDatesInWindow++;
                    // If date already exists, overwrite with newer data (later in array = newer)
                    const existingIndex = allTimeSeries.findIndex(p => normalizeDate(p.date) === date);
                    if (existingIndex >= 0) {
                      // Overwrite existing entry
                      const oldN = allTimeSeries[existingIndex].n;
                      allTimeSeries[existingIndex] = {
                        date: value.dates[i],
                        n: value.n_daily[i],
                        k: value.k_daily[i],
                        p: value.n_daily[i] > 0 ? value.k_daily[i] / value.n_daily[i] : 0,
                      };
                      console.log(`[DataOperationsService] Entry ${entryIdx}: Overwrote ${date} (n: ${oldN} → ${value.n_daily[i]})`);
                    } else {
                      // Add new entry
                      allTimeSeries.push({
                        date: value.dates[i],
                        n: value.n_daily[i],
                        k: value.k_daily[i],
                        p: value.n_daily[i] > 0 ? value.k_daily[i] / value.n_daily[i] : 0,
                      });
                      console.log(`[DataOperationsService] Entry ${entryIdx}: Added ${date} (n: ${value.n_daily[i]})`);
                    }
                  }
                }
                
                console.log(`[DataOperationsService] Entry ${entryIdx}: window=${entryWindow}, datesInWindow=${entryDatesInWindow}/${value.dates.length}`);
              }
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
            const aggregatedValue: ParameterValue = {
              mean: enhanced.mean,
              stdev: enhanced.stdev,
              n: enhanced.n,
              k: enhanced.k,
              window_from: window.start,
              window_to: window.end,
              data_source: {
                type: latestValueWithSource?.data_source?.type || 'file',
                retrieved_at: new Date().toISOString(),
                query: latestValueWithSource?.data_source?.query,
                full_query: latestValueWithSource?.data_source?.full_query,
              },
            };
            
            // Create a modified parameter file data with aggregated value
            aggregatedData = {
              ...paramFile.data,
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
            
            if (aggregation.days_missing > 0) {
              // Missing data detected - this is expected when filtering to latest signature
              // If called from "get from file", suggest getting from source
              // If called from "get from source", the fetch logic should handle it
              
              // Build detailed message about missing dates
              let message = `⚠ Aggregated ${aggregation.days_included} days (${aggregation.days_missing} missing)`;
              
              if (aggregation.missing_at_start && aggregation.missing_at_end) {
                message += ` - missing at start and end`;
              } else if (aggregation.missing_at_start) {
                message += ` - missing at start`;
              } else if (aggregation.missing_at_end) {
                message += ` - missing at end`;
              }
              
              if (aggregation.has_middle_gaps) {
                message += ` - gaps in middle`;
              }
              
              if (aggregation.gaps.length > 0) {
                const gapSummary = aggregation.gaps.map(g => 
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
            }
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            // If no data available for window, don't fall back - show error and return early
            if (errorMsg.includes('No data available for window')) {
              toast.error(`No data available for selected window (${window.start} to ${window.end})`);
              return; // Don't proceed with file-to-graph update
            }
            toast.error(`Window aggregation failed: ${errorMsg}`);
            // Fall back to regular file-to-graph update only for other errors
            console.warn('[DataOperationsService] Falling back to regular update:', error);
          }
        } else {
          // No daily data available, fall back to regular update
          console.log('[DataOperationsService] No daily data found, using regular update');
        }
      }
      
      // Call UpdateManager to transform data
      const result = await updateManager.handleFileToGraph(
        aggregatedData,    // source (parameter file data, possibly aggregated)
        targetEdge,        // target (graph edge)
        'UPDATE',          // operation
        'parameter',       // sub-destination
        { interactive: true }  // show modals for conflicts
      );
      
      if (!result.success) {
        if (result.conflicts && result.conflicts.length > 0) {
          toast.error(`Conflicts found: ${result.conflicts.length} field(s) overridden`);
          // TODO: Show conflict resolution modal
        } else {
          toast.error('Update failed');
        }
        return;
      }
      
      // Apply changes to graph
      const nextGraph = structuredClone(graph);
      const edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === edgeId || e.id === edgeId);
      
      console.log('[DataOperationsService] BEFORE applyChanges:', {
        edgeId,
        edgeIndex,
        'edge.p': JSON.stringify(nextGraph.edges[edgeIndex]?.p),
        changes: JSON.stringify(result.changes)
      });
      
      if (edgeIndex >= 0 && result.changes) {
        // Apply changes to the edge
        applyChanges(nextGraph.edges[edgeIndex], result.changes);
        
        console.log('[DataOperationsService] AFTER applyChanges:', {
          'edge.p': JSON.stringify(nextGraph.edges[edgeIndex]?.p)
        });
        
        // Ensure we do NOT lose the correct parameter connection id after file update.
        // Detect which slot to use from parameter file type OR from changes
        if (paramId) {
          let slot: 'p' | 'cost_gbp' | 'cost_time' | null = null;
          
          // First, try to determine slot from parameter file type
          const paramType = paramFile.data?.type || paramFile.data?.parameter_type;
          if (paramType === 'probability') {
            slot = 'p';
          } else if (paramType === 'cost_gbp') {
            slot = 'cost_gbp';
          } else if (paramType === 'cost_time') {
            slot = 'cost_time';
          } else {
            // Fallback: try to infer from changes
            const fields = (result.changes || []).map((c: any) => c.field || '');
            if (fields.some(f => f.startsWith('cost_gbp'))) slot = 'cost_gbp';
            else if (fields.some(f => f.startsWith('cost_time'))) slot = 'cost_time';
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
        
        const hadRebalance = finalGraph !== nextGraph;
        if (hadRebalance) {
          toast.success(`✓ Updated from ${paramId}.yaml + siblings rebalanced`, { duration: 2000 });
        } else {
          toast.success(`✓ Updated from ${paramId}.yaml`, { duration: 2000 });
        }
      }
      
    } catch (error) {
      console.error('[DataOperationsService] Failed to get parameter from file:', error);
      toast.error('Failed to get data from file');
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
  }): Promise<void> {
    const { paramId, edgeId, graph } = options;
    
    console.log('[DataOperationsService] putParameterToFile CALLED:', {
      paramId,
      edgeId,
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
        let paramType: 'probability' | 'cost_gbp' | 'cost_time' = 'probability';
        if (sourceEdge.cost_gbp?.id === paramId) {
          paramType = 'cost_gbp';
        } else if (sourceEdge.cost_time?.id === paramId) {
          paramType = 'cost_time';
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
      // (an edge can have p, cost_gbp, AND cost_time - we only want to write ONE)
      let filteredEdge: any = { ...sourceEdge };
      if (sourceEdge.p?.id === paramId) {
        // Writing probability parameter - keep only p field
        filteredEdge = { p: sourceEdge.p };
      } else if (sourceEdge.cost_gbp?.id === paramId) {
        // Writing cost_gbp parameter - keep only cost_gbp field
        filteredEdge = { cost_gbp: sourceEdge.cost_gbp };
      } else if (sourceEdge.cost_time?.id === paramId) {
        // Writing cost_time parameter - keep only cost_time field
        filteredEdge = { cost_time: sourceEdge.cost_time };
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
    
    // Set auto-updating flag to enable animations
    if (setAutoUpdating) {
      setAutoUpdating(true);
      setTimeout(() => setAutoUpdating(false), 500);
    }
    
    try {
      if (!graph || !nodeId) {
        toast.error('No graph or node selected');
        return;
      }
      
      const caseFile = fileRegistry.getFile(`case-${caseId}`);
      if (!caseFile) {
        toast.error(`Case file not found: ${caseId}`);
        return;
      }
      
      const targetNode = graph.nodes?.find((n: any) => n.uuid === nodeId || n.id === nodeId);
      if (!targetNode) {
        toast.error(`Node not found in graph`);
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
        }
      }
    } catch (error) {
      console.error('[DataOperationsService] Failed to get case from file:', error);
      toast.error('Failed to get case from file');
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
    
    // Set auto-updating flag to enable animations
    if (setAutoUpdating) {
      setAutoUpdating(true);
      setTimeout(() => setAutoUpdating(false), 500);
    }
    
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
      
      // Find node: if targetNodeUuid provided, use that; otherwise use nodeId
      const targetNode = targetNodeUuid
        ? graph.nodes?.find((n: any) => n.uuid === targetNodeUuid)
        : graph.nodes?.find((n: any) => n.uuid === nodeId || n.id === nodeId || n.data?.id === nodeId);
      
      if (!targetNode) {
        toast.error(`Node not found in graph`);
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
      }
    } catch (error) {
      console.error('[DataOperationsService] Failed to get node from file:', error);
      toast.error('Failed to get node from file');
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
    paramSlot?: 'p' | 'cost_gbp' | 'cost_time';
    conditionalIndex?: number;
    bustCache?: boolean; // If true, ignore existing dates and re-fetch everything
    targetSlice?: string; // Optional: DSL for specific slice (default '' = uncontexted)
    currentDSL?: string;  // Explicit DSL for window/context (e.g. from WindowSelector / scenario)
  }): Promise<void> {
    const { objectType, objectId, targetId, graph, setGraph, paramSlot, conditionalIndex, bustCache, targetSlice = '', currentDSL } = options;
    sessionLogService.info('data-fetch', 'DATA_GET_FROM_SOURCE', `Get from Source (versioned): ${objectType} ${objectId}`,
      undefined, { fileId: `${objectType}-${objectId}`, fileType: objectType });
    
    try {
      if (objectType === 'parameter') {
        // Parameters: fetch daily data, append to values[], update graph
        // 1. Fetch from source using getFromSourceDirect with dailyMode=true
        // This will fetch data and store it in the parameter file
        await this.getFromSourceDirect({
          objectType: 'parameter',
          objectId, // Parameter file ID
          targetId,
          graph,
          setGraph,
          paramSlot,
          conditionalIndex,
          dailyMode: true, // Internal: write daily time-series into file when provider supports it
          bustCache,       // Pass through bust cache flag
          currentDSL,
          targetSlice,
        });
        
        // 2. Update graph from file (standard file-to-graph flow)
        if (targetId && graph && setGraph) {
          await this.getParameterFromFile({
            paramId: objectId,
            edgeId: targetId,
            graph,
            setGraph
          });
        }
        
        toast.success('Fetched from source and updated graph from file');
        
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
          graph,
          setGraph,
          dailyMode: false, // Cases do not use daily time-series; this is a single snapshot
          versionedCase: true, // Signal to append schedule to case file instead of direct graph apply
          bustCache: false,
          currentDSL,
        });
        
        // 2. Update graph nodes from case file (with windowed aggregation)
        // Find all nodes with this case_id and update their variant weights from file
        if (graph && setGraph && targetId) {
          // Find the first case node with this case_id to update from file
          const caseNode = graph.nodes?.find((n: any) => 
            n.type === 'case' && n.case?.id === objectId
          );
          
          if (caseNode) {
            const nodeId = caseNode.uuid || caseNode.id;
            
            // Use getCaseFromFile for time-weighted aggregation; service will infer window from DSL
            await this.getCaseFromFile({
              caseId: objectId,
              nodeId,
              graph,
              setGraph
            });
          } else {
            console.warn(`[DataOperationsService] No case node found with case_id="${objectId}"`);
          }
        } else if (graph && setGraph && !targetId) {
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
              let updatedGraph = structuredClone(graph);
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
                setGraph(updatedGraph);
                
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
        
        toast.success('Fetched from source and updated graph from file');
        
      } else {
        toast.error(`Versioned fetching not yet supported for ${objectType}`);
        return;
      }
      
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Error fetching from source: ${message}`);
      console.error('getFromSource error:', error);
    }
  }
  
  /**
   * Get data from external source → graph (direct, not versioned)
   * 
   * If window is provided and daily mode is enabled, fetches daily time-series data
   * and stores it in the parameter file (if objectType is 'parameter').
   */
  async getFromSourceDirect(options: {
    objectType: 'parameter' | 'case' | 'node';
    objectId: string;
    targetId?: string;
    graph?: Graph | null;
    setGraph?: (graph: Graph | null) => void;
    // For direct parameter references (no param file)
    paramSlot?: 'p' | 'cost_gbp' | 'cost_time';
    conditionalIndex?: number;
    dailyMode?: boolean;      // INTERNAL: for parameters, whether to write daily time-series into file
    bustCache?: boolean;      // If true, ignore existing dates and re-fetch everything
    // For cases: distinguish direct vs versioned/schedule-based path
    versionedCase?: boolean;  // If true AND objectType==='case', append schedule to case file instead of direct graph update
    currentDSL?: string;      // Explicit DSL for window/context (e.g. from WindowSelector / scenario)
    targetSlice?: string;     // Optional: DSL for specific slice (default '' = uncontexted)
  }): Promise<void> {
      const {
        objectType,
        objectId,
        targetId,
        graph,
        setGraph,
        paramSlot,
        conditionalIndex,
        dailyMode,
        bustCache,
        versionedCase,
        currentDSL,
        targetSlice = '',
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
      dailyMode ? 'DATA_FETCH_VERSIONED' : 'DATA_FETCH_DIRECT',
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
            
            // If paramSlot specified, use that (e.g., 'p', 'cost_gbp', 'cost_time')
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
        // Parameters: build DSL from edge query
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
              // Priority: currentDSL param > graph.currentQueryDSL (for dynamic scenarios)
              let constraints;
              try {
                const { parseConstraints } = await import('../lib/queryDSL');
                
                // Use explicit currentDSL if provided, otherwise fall back to graph.currentQueryDSL
                const effectiveDSL = currentDSL || graph?.currentQueryDSL || '';
                
                // Parse graph-level constraints (from WindowSelector or scenario)
                const graphConstraints = effectiveDSL ? parseConstraints(effectiveDSL) : null;
                
                // Parse edge-specific constraints (use effectiveQuery which may be from conditional_p)
                const edgeConstraints = effectiveQuery ? parseConstraints(effectiveQuery) : null;
                
                // Merge: edge-specific overrides graph-level
                constraints = {
                  context: [...(graphConstraints?.context || []), ...(edgeConstraints?.context || [])],
                  contextAny: [...(graphConstraints?.contextAny || []), ...(edgeConstraints?.contextAny || [])],
                  window: edgeConstraints?.window || graphConstraints?.window || null,
                  visited: edgeConstraints?.visited || [],
                  visitedAny: edgeConstraints?.visitedAny || []
                };
                
                console.log('[DataOps] Merged constraints:', {
                  currentDSL,
                  graphDSL: graph?.currentQueryDSL,
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
              
              // Log query details for user
              const queryDesc = effectiveQuery || 'no query';
              const windowDesc = (queryPayload.start && queryPayload.end) 
                ? `${normalizeDate(queryPayload.start)} to ${normalizeDate(queryPayload.end)}`
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
              let constraints;
              try {
                const { parseConstraints } = await import('../lib/queryDSL');
                
                // Parse graph-level constraints (from WindowSelector)
                const graphConstraints = graph?.currentQueryDSL ? parseConstraints(graph.currentQueryDSL) : null;
                
                // Parse edge-specific constraints
                const edgeConstraints = targetEdge.query ? parseConstraints(targetEdge.query) : null;
                
                // Merge: edge-specific overrides graph-level
                constraints = {
                  context: [...(graphConstraints?.context || []), ...(edgeConstraints?.context || [])],
                  contextAny: [...(graphConstraints?.contextAny || []), ...(edgeConstraints?.contextAny || [])],
                  window: edgeConstraints?.window || graphConstraints?.window || null,
                  visited: edgeConstraints?.visited || [],
                  visitedAny: edgeConstraints?.visitedAny || []
                };
                
                console.log('[DataOps] Merged constraints (fallback):', {
                  graphDSL: graph?.currentQueryDSL,
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
      }
      
      // 5. Check for incremental fetch opportunities (if dailyMode and parameter file exists)
      // Determine default window first
      const now = new Date();
      const sevenDaysAgo = new Date(now);
      sevenDaysAgo.setDate(now.getDate() - 7);
      
      // CRITICAL: Use window dates from DSL object if available (already ISO format from buildDslFromEdge)
      // This is the authoritative source - buildDslFromEdge has already parsed and normalized the window
      let requestedWindow: DateRange;
      if (queryPayload.start && queryPayload.end) {
        // DSL object has window dates (already ISO format from buildDslFromEdge)
        requestedWindow = {
          start: queryPayload.start,
          end: queryPayload.end
        };
        console.log('[DataOps] Using window from DSL object:', requestedWindow);
      } else {
        // No window in DSL, use default last 7 days
        requestedWindow = {
          start: sevenDaysAgo.toISOString(),
          end: now.toISOString()
        };
        console.log('[DataOps] No window in DSL, using default last 7 days:', requestedWindow);
      }
      
      let actualFetchWindows: DateRange[] = [requestedWindow];
      let querySignature: string | undefined;
      let shouldSkipFetch = false;
      
      // CRITICAL: ALWAYS compute query signature when writing to parameter files
      // (we only write for parameter objects in versioned/source-via-file pathway)
      if (objectType === 'parameter' && dailyMode) {
        const targetEdge = targetId && graph ? graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId) : undefined;
        querySignature = await computeQuerySignature(queryPayload, connectionName, graph, targetEdge);
        console.log('[DataOperationsService] Computed query signature for storage:', {
          signature: querySignature?.substring(0, 16) + '...',
          dailyMode,
          objectType
        });
      }
      
      // IMPORTANT: Only check for incremental fetch if bustCache is NOT set and we are
      // in the versioned parameter pathway (source→file→graph).
      const shouldCheckIncrementalFetch = dailyMode && !bustCache && objectType === 'parameter' && objectId;
      
      if (shouldCheckIncrementalFetch) {
        const paramFile = fileRegistry.getFile(`parameter-${objectId}`);
        if (paramFile && paramFile.data) {
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
          const incrementalResult = calculateIncrementalFetch(
            filteredParamData,
            requestedWindow,
            querySignature,
            bustCache || false
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
          
          if (!incrementalResult.needsFetch && !bustCache) {
            // All dates already exist - skip fetching (unless bustCache is true)
            shouldSkipFetch = true;
            toast.success(`All ${incrementalResult.totalDays} days already cached`, { id: 'das-fetch' });
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
        // Not daily mode or no parameter file - use requested window
        actualFetchWindows = [requestedWindow];
        toast.loading(`Fetching data from source...`, { id: 'das-fetch' });
      }
      
      // If all dates are cached, skip fetching and use existing data
      if (shouldSkipFetch && objectType === 'parameter' && objectId && targetId && graph && setGraph) {
        // Use existing data from file
        await this.getParameterFromFile({
          paramId: objectId,
          edgeId: targetId,
          graph,
          setGraph,
          window: requestedWindow,
        });
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
      
      // Check if query uses composite operators (minus/plus for inclusion-exclusion)
      // CRITICAL: Check the ORIGINAL edge query string, NOT queryPayload.query (which doesn't exist after buildDslFromEdge)
      const targetEdge = targetId && graph ? graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId) : undefined;
      let queryString = targetEdge?.query || '';
      const isAlreadyComposite = /\.(minus|plus)\(/.test(queryString);
      const hasExcludes = /\.excludes?\(/.test(queryString);
      
      // If query has excludes but isn't already compiled to minus/plus,
      // we need to compile it for providers that don't support native excludes (like Amplitude)
      let isComposite = isAlreadyComposite;
      if (hasExcludes && !isAlreadyComposite && connectionName?.includes('amplitude')) {
        console.log('[DataOps:EXCLUDE] Query has excludes, compiling to minus/plus for Amplitude');
        try {
          // Call Python API to compile exclude query
          const compiledQuery = await compileExcludeQuery(queryString, graph);
          if (compiledQuery && compiledQuery !== queryString) {
            console.log('[DataOps:EXCLUDE] Compiled query:', compiledQuery);
            queryString = compiledQuery;
            isComposite = true;
          }
        } catch (error) {
          console.error('[DataOps:EXCLUDE] Failed to compile exclude query:', error);
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
      // CRITICAL: Store the DSL STRING (from graph edge), not the DSL object
      // The DSL object has provider event names; we want the original query string
      if (dailyMode && objectType === 'parameter') {
        queryParamsForStorage = queryString || queryPayload; // Use query string first, fall back to DSL object
        fullQueryForStorage = queryString || JSON.stringify(queryPayload);
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
        
        if (actualFetchWindows.length > 1) {
          toast.loading(
            `Fetching gap ${gapIndex + 1}/${actualFetchWindows.length} (${normalizeDate(fetchWindow.start)} to ${normalizeDate(fetchWindow.end)})`,
            { id: 'das-fetch' }
          );
        }
        
        if (isComposite) {
          // Composite query: use inclusion-exclusion executor
          console.log('[DataOps] Detected composite query, using inclusion-exclusion executor');
          
          const { executeCompositeQuery } = await import('../lib/das/compositeQueryExecutor');
          
          try {
            // CRITICAL: Pass context mode to sub-queries (daily or aggregate)
            // Also pass graph for upstream/between categorization of visited nodes
            const combined: CombinedResult = await executeCompositeQuery(
              queryString,
              { ...queryPayload, window: fetchWindow, mode: contextMode },
              connectionName,
              runner,
              graph  // Pass graph for isNodeUpstream checks
            );
            
            console.log(`[DataOperationsService] Composite query result for gap ${gapIndex + 1}:`, combined);
            
            // Extract results based on pathway: for parameters we collect time-series
            if (dailyMode && objectType === 'parameter') {
              // CRITICAL: Extract time-series data from composite result
              if (combined.evidence?.time_series && Array.isArray(combined.evidence.time_series)) {
                const timeSeries = combined.evidence.time_series;
                console.log(`[DataOperationsService] Extracted ${timeSeries.length} days from composite query (gap ${gapIndex + 1})`);
                allTimeSeriesData.push(...timeSeries);
              } else {
                console.warn(`[DataOperationsService] No time-series in composite result for gap ${gapIndex + 1}`, combined);
                toast.error(`Composite query returned no daily data for gap ${gapIndex + 1}`, { id: 'das-fetch' });
                sessionLogService.endOperation(logOpId, 'error', `Composite query returned no daily data for gap ${gapIndex + 1}`);
                return;
              }
            } else {
              // Non-daily mode: use aggregated results
              updateData = {
                mean: combined.p_mean,
                n: combined.n,
                k: combined.k
              };
            }
            
          } catch (error) {
            toast.error(`Composite query failed for gap ${gapIndex + 1}: ${error instanceof Error ? error.message : String(error)}`, { id: 'das-fetch' });
            sessionLogService.endOperation(logOpId, 'error', `Composite query failed: ${error instanceof Error ? error.message : String(error)}`);
            return;
          }
          
        } else {
          // Simple query: use standard DAS runner
          const result = await runner.execute(connectionName, queryPayload, {
            connection_string: connectionString,
            window: fetchWindow as { start?: string; end?: string; [key: string]: unknown },
            context: { mode: contextMode }, // Pass mode to adapter (daily or aggregate)
            edgeId: objectType === 'parameter' ? (targetId || 'unknown') : undefined,
            caseId: objectType === 'case' ? objectId : undefined, // Pass caseId for cases
            nodeId: objectType === 'node' ? (targetId || objectId) : undefined, // Pass nodeId for nodes (future)
            eventDefinitions,  // Event file data for adapter to resolve provider names + filters
          });
          
          // Capture DAS execution history for session logs (request/response details)
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
          
          if (!result.success) {
            // Log technical details to console
            console.error(`[DataOperationsService] DAS execution failed for gap ${gapIndex + 1}:`, {
              error: result.error,
              phase: result.phase,
              details: result.details,
              window: fetchWindow,
            });
            
            // Show user-friendly message in toast
            const userMessage = result.error || 'Failed to fetch data from source';
            toast.error(`${userMessage} (gap ${gapIndex + 1}/${actualFetchWindows.length})`, { id: 'das-fetch' });
            sessionLogService.endOperation(logOpId, 'error', `API call failed: ${userMessage}`);
            return;
          }
          
          console.log(`[DataOperationsService] DAS result for gap ${gapIndex + 1}:`, {
            updates: result.updates.length,
            hasTimeSeries: !!result.raw?.time_series,
            timeSeriesType: typeof result.raw?.time_series,
            timeSeriesIsArray: Array.isArray(result.raw?.time_series),
            timeSeriesLength: Array.isArray(result.raw?.time_series)
              ? result.raw.time_series.length
              : result.raw?.time_series
              ? 'not array'
              : 'null/undefined',
            timeSeriesValue: result.raw?.time_series,
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
          if (dailyMode && objectType === 'parameter' && result.raw?.time_series) {
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
          
          // Parse the updates to extract values for simple queries (use latest result for non-daily mode)
          // UpdateManager now expects schema terminology: mean, n, k (not external API terminology)
          if (!dailyMode) {
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
        toast.success(`✓ Fetched all ${actualFetchWindows.length} gaps`, { id: 'das-fetch' });
      } else if (!dailyMode) {
        toast.success(`Fetched data from source`, { id: 'das-fetch' });
      }
      
      // Add data_source metadata for direct external connections (graph-level provenance)
      if (!dailyMode) {
        updateData.data_source = {
          type: connectionName?.includes('amplitude')
            ? 'amplitude'
            : connectionName?.includes('statsig')
            ? 'statsig'
            : 'api',
          retrieved_at: new Date().toISOString(),
          query: queryPayload,
          full_query: queryPayload.query || JSON.stringify(queryPayload),
        };
      }
      
      // For cases (Statsig, etc.), extract variants from raw transformed data
      // Adapters expose variant weights as `variants_update` (or `variants`) in transform output.
      // For Sheets, variants are extracted from param_pack above and stored in updateData.variants.
      if (objectType === 'case' && !dailyMode && lastResultRaw && !connectionName?.includes('sheets')) {
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
      
      // 6a. If dailyMode is true, write data to files
      // For parameters: write time-series data
      if (dailyMode && allTimeSeriesData.length > 0 && objectType === 'parameter' && objectId) {
        try {
          // Get parameter file (re-read to get latest state)
          let paramFile = fileRegistry.getFile(`parameter-${objectId}`);
          if (paramFile) {
            let existingValues = (paramFile.data.values || []) as ParameterValue[];
            
            // Store each gap as a separate value entry
            for (let gapIndex = 0; gapIndex < actualFetchWindows.length; gapIndex++) {
              const fetchWindow = actualFetchWindows[gapIndex];
              
              // Filter time-series data for this specific gap
              const gapTimeSeries = allTimeSeriesData.filter(point => {
                const pointDate = normalizeDate(point.date);
                return isDateInRange(pointDate, fetchWindow);
              });
              
              if (gapTimeSeries.length > 0) {
                // Append new time-series as a separate value entry for this gap
                existingValues = mergeTimeSeriesIntoParameter(
                  existingValues,
                  gapTimeSeries,
                  fetchWindow,
                  querySignature,
                  queryParamsForStorage,
                  fullQueryForStorage,
                  dataSourceType
                );
                
                console.log(`[DataOperationsService] Prepared daily time-series data for gap ${gapIndex + 1}:`, {
                  paramId: objectId,
                  newDays: gapTimeSeries.length,
                  fetchWindow,
                  querySignature,
                });
              }
            }
            
            // Update file once with all new value entries
            const updatedFileData = structuredClone(paramFile.data);
            updatedFileData.values = existingValues;
            
            // CRITICAL: Push graph's query string to parameter file (graph is master for queries)
            // This is the ONE place where graph→file update happens (when fetching from source)
            if (queryString) {
              updatedFileData.query = queryString;
              console.log('[DataOperationsService] Updated parameter file query from graph:', {
                paramId: objectId,
                query: queryString
              });
            }
            
            await fileRegistry.updateFile(`parameter-${objectId}`, updatedFileData);
            
            toast.success(`✓ Added ${allTimeSeriesData.length} new days across ${actualFetchWindows.length} gap${actualFetchWindows.length > 1 ? 's' : ''}`, { duration: 2000 });
            
            // Log file update
            sessionLogService.addChild(logOpId, 'success', 'FILE_UPDATED',
              `Updated parameter file: ${objectId}`,
              `Added ${allTimeSeriesData.length} days of time-series data`,
              { fileId: `parameter-${objectId}`, rowCount: allTimeSeriesData.length });
            
            // CRITICAL: After writing daily time-series to file, load it back into the graph
            // This is the "versioned path" that applies File→Graph (see comment at line ~2909)
            if (graph && setGraph && targetId) {
              console.log('[DataOperationsService] Loading newly written parameter data from file into graph');
              await this.getParameterFromFile({
                paramId: objectId,
                edgeId: targetId,
                graph,
                setGraph,
                window: requestedWindow // Aggregate across the full requested window
              });
            }
          } else {
            console.warn('[DataOperationsService] Parameter file not found, skipping time-series storage');
          }
        } catch (error) {
          console.error('[DataOperationsService] Failed to append time-series data:', error);
          // Don't fail the whole operation, just log the error
        }
      }
      
      // 6b. For versioned case fetches: write schedule entry to case file
      // NOTE: Controlled by versionedCase flag, NOT dailyMode (dailyMode is parameter-specific and for parameters only)
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
            window_from: new Date().toISOString(),
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
      
      if (!dailyMode) {
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
      
      // 7. Apply directly to graph (only if NOT in dailyMode)
      // When dailyMode is true, the versioned path (getFromSource) will update the graph
      // via getParameterFromFile after the file is updated
      if (!dailyMode && objectType === 'parameter') {
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
        // In dailyMode, we've already updated the parameter file - graph will be updated by getFromSource via getParameterFromFile
        console.log(
          '[DataOperationsService] Skipping direct graph update for parameters (dailyMode=true, versioned path will handle it)'
        );
      }
      
      // 8. For cases in direct mode: Apply variants directly to graph nodes (no case file)
      // (External → Graph Case Node: see Mapping 7 in SCHEMA_FIELD_MAPPINGS.md)
      if (objectType === 'case' && !dailyMode && !versionedCase && graph && setGraph && targetId) {
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
}

// Singleton instance
export const dataOperationsService = new DataOperationsService();

