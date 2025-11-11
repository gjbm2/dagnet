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
import { WindowAggregationService, parameterToTimeSeries, calculateIncrementalFetch, mergeTimeSeriesIntoParameter, normalizeDate, parseDate, isDateInRange } from './windowAggregationService';
import { statisticalEnhancementService } from './statisticalEnhancementService';
import type { ParameterValue } from './paramRegistryService';
import type { TimeSeriesPoint } from '../types';

// Shared UpdateManager instance
const updateManager = new UpdateManager();

// Shared WindowAggregationService instance
const windowAggregationService = new WindowAggregationService();

/**
 * Compute query signature (SHA-256 hash) for consistency checking
 * Uses Web Crypto API available in modern browsers
 */
async function computeQuerySignature(dsl: any, connectionName?: string): Promise<string> {
  try {
    // Create a canonical representation of the query
    const canonical = JSON.stringify({
      connection: connectionName || '',
      from: dsl.from || '',
      to: dsl.to || '',
      visited: (dsl.visited || []).sort(),
      event_filters: dsl.event_filters || {},
      context: (dsl.context || []).sort(),
      case: (dsl.case || []).sort(),
    });
    
    // Compute SHA-256 hash
    const encoder = new TextEncoder();
    const data = encoder.encode(canonical);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
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
  }): Promise<void> {
    const { paramId, edgeId, graph, setGraph, setAutoUpdating, window } = options;
    
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
        const valuesWithDaily = (paramFile.data.values as ParameterValue[])
          .filter(v => v.n_daily && v.k_daily && v.dates && v.n_daily.length > 0);
        
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
                
                // Build DSL from edge
                const dsl = await buildDslFromEdge(
                  targetEdge,
                  graph,
                  connectionProvider,
                  eventLoader
                );
                
                // Compute expected query signature
                expectedQuerySignature = await computeQuerySignature(dsl, connectionName);
                
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
                
                if (querySignatureMismatch) {
                  console.warn('[DataOperationsService] Query signature mismatch detected:', {
                    expectedSignature: expectedQuerySignature,
                    mismatchedEntries,
                    totalEntries: valuesWithDaily.length,
                  });
                  
                  toast(`⚠ Aggregating data with different query signatures (${mismatchedEntries.length} entry/entries)`, {
                    icon: '⚠️',
                    duration: 5000,
                  });
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
          const { rebalanceSiblingParameters } = await import('../utils/rebalanceUtils');
          finalGraph = rebalanceSiblingParameters(
            nextGraph,
            (result.metadata as any).updatedEdgeId,
            (result.metadata as any).updatedField
          );
        }
        
        // Save to graph store
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
      
      // Check if file exists
      const paramFile = fileRegistry.getFile(`parameter-${paramId}`);
      if (!paramFile) {
        toast.error(`Parameter file not found: ${paramId}`);
        return;
      }
      
      // Find the source edge
      const sourceEdge = graph.edges?.find((e: any) => e.uuid === edgeId || e.id === edgeId);
      if (!sourceEdge) {
        toast.error(`Edge not found in graph`);
        return;
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
        appendChanges: JSON.stringify(result.changes, null, 2),
        updateChanges: updateResult.changes ? JSON.stringify(updateResult.changes, null, 2) : 'none'
      });
      
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
   * Get data from case file → graph case node
   */
  async getCaseFromFile(options: {
    caseId: string;
    nodeId?: string;
    graph: Graph | null;
    setGraph: (graph: Graph | null) => void;
    setAutoUpdating?: (updating: boolean) => void;
  }): Promise<void> {
    const { caseId, nodeId, graph, setGraph, setAutoUpdating } = options;
    
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
      
      const nextGraph = structuredClone(graph);
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
          'variants': nextGraph.nodes[nodeIndex].case?.variants
        });
        if (nextGraph.metadata) {
          nextGraph.metadata.updated_at = new Date().toISOString();
        }
        setGraph(nextGraph);
        toast.success(`✓ Updated from ${caseId}.yaml`, { duration: 2000 });
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
      
      const caseFile = fileRegistry.getFile(`case-${caseId}`);
      if (!caseFile) {
        toast.error(`Case file not found: ${caseId}`);
        return;
      }
      
      const sourceNode = graph.nodes?.find((n: any) => n.uuid === nodeId || n.id === nodeId);
      if (!sourceNode) {
        toast.error(`Node not found in graph`);
        return;
      }
      
      // Filter node to only include the relevant case data
      const filteredNode: any = { case: sourceNode.case };
      
      const result = await updateManager.handleGraphToFile(
        filteredNode,
        caseFile.data,
        'APPEND', // Use APPEND for case schedules
        'case',
        { interactive: true, validateOnly: true } // Don't apply in UpdateManager, we'll use applyChanges
      );
      
      if (!result.success || !result.changes) {
        toast.error('Failed to update case file');
        return;
      }
      
      const updatedFileData = structuredClone(caseFile.data);
      applyChanges(updatedFileData, result.changes);
      
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
    window?: DateRange;
  }): Promise<void> {
    const { objectType, objectId, targetId, graph, setGraph, paramSlot, conditionalIndex, window } = options;
    
    // For now, only parameters support versioned fetching
    if (objectType !== 'parameter') {
      toast.error('Versioned fetching only supported for parameters');
      return;
    }
    
    try {
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
        window,
        dailyMode: true // Always use daily mode for versioned fetching
      });
      
      // 2. Update graph from file (standard file-to-graph flow)
      if (targetId && graph && setGraph) {
        await this.getParameterFromFile({
          paramId: objectId,
          edgeId: targetId,
          graph,
          setGraph,
          window // Use same window for aggregation
        });
      }
      
      toast.success('Fetched from source and updated graph from file');
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
    window?: DateRange; // Optional: date range for fetching
    dailyMode?: boolean; // If true, fetch daily time-series data
  }): Promise<void> {
    const { objectType, objectId, targetId, graph, setGraph, paramSlot, conditionalIndex, window, dailyMode } = options;
    
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
            
            // If paramSlot specified, use that (e.g., 'p', 'cost_gbp', 'cost_time')
            if (paramSlot) {
              param = target[paramSlot];
              
              // If conditionalIndex specified, get from conditional_ps array
              if (conditionalIndex !== undefined && param?.conditional_ps) {
                param = param.conditional_ps[conditionalIndex];
              }
            }
            // Otherwise, default to p (backward compatibility)
            else {
              param = target.p;
            }
            
            if (param) {
              connectionName = param.connection;
              if (param.connection_string) {
                try {
                  connectionString = typeof param.connection_string === 'string'
                    ? JSON.parse(param.connection_string)
                    : param.connection_string;
                } catch (e) {
                  toast.error('Invalid connection_string JSON on edge');
                  return;
                }
              }
            }
          }
          // For other types, check top-level connection
          else if (target.connection) {
            connectionName = target.connection;
            if (target.connection_string) {
              try {
                connectionString = typeof target.connection_string === 'string'
                  ? JSON.parse(target.connection_string)
                  : target.connection_string;
        } catch (e) {
          toast.error('Invalid connection_string JSON');
          return;
        }
            }
          }
        }
      }
      
      // 2. Check if we have a connection configured
      if (!connectionName) {
        toast.error(`No connection configured. Please set the 'connection' field.`);
        return;
      }
      
      // 3. Build DSL from edge query (if available in graph)
      let dsl: any = {};
      let connectionProvider: string | undefined;
      
      if (targetId && graph) {
        // Find the target edge
        const targetEdge = graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId);
        
        if (targetEdge && targetEdge.query) {
          // Parse query string (format: "from(nodeA).to(nodeB)")
          // For now, pass the edge with query string to buildDslFromEdge
          // which will parse node references and resolve event names
          
          // Load buildDslFromEdge and event loader
          const { buildDslFromEdge } = await import('../lib/das/buildDslFromEdge');
          const { paramRegistryService } = await import('./paramRegistryService');
          
          // Get connection to extract provider
          const { createDASRunner } = await import('../lib/das');
          const tempRunner = createDASRunner();
          try {
            const connection = await (tempRunner as any).connectionProvider.getConnection(connectionName);
            connectionProvider = connection.provider;
          } catch (e) {
            console.warn('Could not load connection for provider mapping:', e);
          }
          
          try {
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
            
            // Build DSL with event mapping
            dsl = await buildDslFromEdge(
              targetEdge,
              graph,
              connectionProvider,
              eventLoader
            );
            console.log('Built DSL from edge with event mapping:', dsl);
          } catch (error) {
            console.error('Error building DSL from edge:', error);
            toast.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
            return;
          }
        }
      }
      
      // 5. Check for incremental fetch opportunities (if dailyMode and parameter file exists)
      // Determine default window first
      const now = new Date();
      const sevenDaysAgo = new Date(now);
      sevenDaysAgo.setDate(now.getDate() - 7);
      
      // Normalize window to ISO timestamps (handle both YYYY-MM-DD strings and ISO timestamps)
      const normalizeWindowDate = (dateStr: string): string => {
        // If already ISO timestamp, return as-is
        if (dateStr.includes('T')) return dateStr;
        // If YYYY-MM-DD format, convert to ISO timestamp at start of day
        return new Date(dateStr + 'T00:00:00Z').toISOString();
      };
      
      const requestedWindow: DateRange = window ? {
        start: normalizeWindowDate(window.start),
        end: normalizeWindowDate(window.end),
      } : {
        start: sevenDaysAgo.toISOString(),
        end: now.toISOString()
      };
      
      let actualFetchWindows: DateRange[] = [requestedWindow];
      let querySignature: string | undefined;
      let shouldSkipFetch = false;
      
      if (dailyMode && objectType === 'parameter' && objectId) {
        const paramFile = fileRegistry.getFile(`parameter-${objectId}`);
        if (paramFile && paramFile.data) {
          // Compute query signature for consistency checking
          querySignature = await computeQuerySignature(dsl, connectionName);
          
          // Calculate incremental fetch
          const incrementalResult = calculateIncrementalFetch(
            paramFile.data,
            requestedWindow,
            querySignature
          );
          
          console.log('[DataOperationsService] Incremental fetch analysis:', {
            totalDays: incrementalResult.totalDays,
            daysAvailable: incrementalResult.daysAvailable,
            daysToFetch: incrementalResult.daysToFetch,
            needsFetch: incrementalResult.needsFetch,
            fetchWindows: incrementalResult.fetchWindows,
            fetchWindow: incrementalResult.fetchWindow, // Combined window for backward compat
          });
          
          if (!incrementalResult.needsFetch) {
            // All dates already exist - skip fetching
            shouldSkipFetch = true;
            toast.success(`All ${incrementalResult.totalDays} days already cached`, { id: 'das-fetch' });
            console.log('[DataOperationsService] Skipping fetch - all dates already exist');
          } else if (incrementalResult.fetchWindows.length > 0) {
            // We have multiple contiguous gaps - chain requests for each
            actualFetchWindows = incrementalResult.fetchWindows;
            const gapCount = incrementalResult.fetchWindows.length;
            toast.loading(
              `Fetching ${incrementalResult.daysToFetch} missing days across ${gapCount} gap${gapCount > 1 ? 's' : ''} (${incrementalResult.daysAvailable}/${incrementalResult.totalDays} cached)`,
              { id: 'das-fetch' }
            );
          } else if (incrementalResult.fetchWindow) {
            // Fallback to combined window (shouldn't happen, but keep for safety)
            actualFetchWindows = [incrementalResult.fetchWindow];
            toast.loading(
              `Fetching ${incrementalResult.daysToFetch} missing days (${incrementalResult.daysAvailable}/${incrementalResult.totalDays} cached)`,
              { id: 'das-fetch' }
            );
          } else {
            // Fallback to requested window
            actualFetchWindows = [requestedWindow];
            toast.loading(`Fetching data from source${dailyMode ? ' (daily mode)' : ''}...`, { id: 'das-fetch' });
          }
        } else {
          // No parameter file - use requested window
          actualFetchWindows = [requestedWindow];
          toast.loading(`Fetching data from source${dailyMode ? ' (daily mode)' : ''}...`, { id: 'das-fetch' });
        }
      } else {
        // Not daily mode or no parameter file - use requested window
        actualFetchWindows = [requestedWindow];
        toast.loading(`Fetching data from source${dailyMode ? ' (daily mode)' : ''}...`, { id: 'das-fetch' });
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
      
      // Set context mode: 'daily' if dailyMode is true, otherwise 'aggregate'
      const contextMode = dailyMode ? 'daily' : 'aggregate';
      
      // Collect all time-series data from all gaps
      const allTimeSeriesData: Array<{ date: string; n: number; k: number; p: number }> = [];
      let updateData: any = {};
      
      // Store query info for daily mode storage
      let queryParamsForStorage: any = undefined;
      let fullQueryForStorage: string | undefined = undefined;
      
      // Check if query uses composite operators (minus/plus for inclusion-exclusion)
      const queryString = dsl.query || '';
      const isComposite = /\.(minus|plus)\(/.test(queryString);
      
      // Capture query info for storage (same for all gaps)
      if (dailyMode) {
        queryParamsForStorage = dsl;
        fullQueryForStorage = queryString || JSON.stringify(dsl);
      }
      
      // Determine data source type from connection name
      const dataSourceType = connectionName?.includes('amplitude') ? 'amplitude' : 'api';
      
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
            const combined = await executeCompositeQuery(
              queryString,
              { ...dsl, window: fetchWindow },
              connectionName,
              runner
            );
            
            // Map combined result to update format (use latest result for non-daily mode)
            if (!dailyMode) {
              updateData = {
                probability: combined.p_mean,
                sample_size: combined.n,
                successes: combined.k
              };
            }
            
            console.log(`[DataOperationsService] Composite query result for gap ${gapIndex + 1}:`, combined);
            
          } catch (error) {
            toast.error(`Composite query failed for gap ${gapIndex + 1}: ${error instanceof Error ? error.message : String(error)}`, { id: 'das-fetch' });
            return;
          }
          
        } else {
          // Simple query: use standard DAS runner
          const result = await runner.execute(connectionName, dsl, {
            connection_string: connectionString,
            window: fetchWindow as { start?: string; end?: string; [key: string]: unknown },
            context: { mode: contextMode }, // Pass mode to adapter (daily or aggregate)
            edgeId: targetId || 'unknown'
          });
          
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
            return;
          }
          
          console.log(`[DataOperationsService] DAS result for gap ${gapIndex + 1}:`, {
            updates: result.updates.length,
            hasTimeSeries: !!result.raw?.time_series,
            timeSeriesLength: Array.isArray(result.raw?.time_series) ? result.raw.time_series.length : 0,
            window: fetchWindow,
          });
        
          // Collect time-series data if in daily mode
          if (dailyMode && result.raw?.time_series) {
            const timeSeries = result.raw.time_series as Array<{ date: string; n: number; k: number; p: number }>;
            allTimeSeriesData.push(...timeSeries);
          }
          
          // Parse the updates to extract values for simple queries (use latest result for non-daily mode)
          if (!dailyMode) {
            for (const update of result.updates) {
              const parts = update.target.split('/').filter(Boolean);
              const field = parts[parts.length - 1];
              
              // Map to UpdateManager's expected field names for external data
              if (field === 'mean') {
                updateData.probability = typeof update.value === 'number' ? update.value : Number(update.value);
              } else if (field === 'n') {
                updateData.sample_size = typeof update.value === 'number' ? update.value : Number(update.value);
              } else if (field === 'k') {
                updateData.successes = typeof update.value === 'number' ? update.value : Number(update.value);
              } else {
                updateData[field] = update.value;
              }
            }
          }
        }
      }
      
      // Show success message after all gaps are fetched
      if (actualFetchWindows.length > 1) {
        toast.success(`✓ Fetched all ${actualFetchWindows.length} gaps`, { id: 'das-fetch' });
      } else if (!dailyMode) {
        toast.success(`Fetched data from source`, { id: 'das-fetch' });
      }
      
      // Add data_source metadata for direct external connections
      if (!dailyMode) {
        updateData.data_source = {
          type: connectionName?.includes('amplitude') ? 'amplitude' : 'api',
          retrieved_at: new Date().toISOString(),
          query: dsl,
          full_query: dsl.query || JSON.stringify(dsl),
        };
      }
      
      // 6a. If dailyMode is true, merge all collected time-series data
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
            
            await fileRegistry.updateFile(`parameter-${objectId}`, updatedFileData);
            
            toast.success(`✓ Added ${allTimeSeriesData.length} new days across ${actualFetchWindows.length} gap${actualFetchWindows.length > 1 ? 's' : ''}`, { duration: 2000 });
          } else {
            console.warn('[DataOperationsService] Parameter file not found, skipping time-series storage');
          }
        } catch (error) {
          console.error('[DataOperationsService] Failed to append time-series data:', error);
          // Don't fail the whole operation, just log the error
        }
      } else if (!dailyMode) {
        console.log('Extracted data from DAS (mapped to external format):', updateData);
      }
      
      // 7. Apply directly to graph (no file update)
      if (!targetId || !graph || !setGraph) {
        toast.error('Cannot apply to graph: missing context');
        return;
      }
      
      // Find the target edge
      const targetEdge = graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId);
      if (!targetEdge) {
        toast.error('Target edge not found in graph');
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
        changes: updateResult.changes
      });
      
      if (!updateResult.success) {
        toast.error('Failed to apply updates to graph');
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
          let finalGraph = nextGraph;
          if ((updateResult.metadata as any)?.requiresSiblingRebalance) {
            const { rebalanceSiblingParameters } = await import('../utils/rebalanceUtils');
            finalGraph = rebalanceSiblingParameters(
              nextGraph,
              (updateResult.metadata as any).updatedEdgeId,
              (updateResult.metadata as any).updatedField
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
      
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Error: ${message}`);
      console.error('getFromSourceDirect error:', error);
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

