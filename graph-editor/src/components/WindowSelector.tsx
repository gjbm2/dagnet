/**
 * WindowSelector Component
 * 
 * Graph-level date range picker for data fetching window selection.
 * Automatically checks data coverage when window changes.
 * Shows "Fetch data" button if data is missing for connected parameters/cases.
 */

import React, { useMemo, useState, useEffect } from 'react';
import { useGraphStore } from '../contexts/GraphStoreContext';
import type { DateRange } from '../types';
import { dataOperationsService } from '../services/dataOperationsService';
import { calculateIncrementalFetch } from '../services/windowAggregationService';
import { fileRegistry } from '../contexts/TabContext';
import { DateRangePicker } from './DateRangePicker';
import toast from 'react-hot-toast';
import './WindowSelector.css';

interface BatchItem {
  id: string;
  type: 'parameter' | 'case' | 'node';
  name: string;
  objectId: string;
  targetId: string;
  paramSlot?: 'p' | 'cost_gbp' | 'cost_time';
}

export function WindowSelector() {
  const { graph, window, setWindow, setGraph } = useGraphStore();
  const [needsFetch, setNeedsFetch] = useState(false);
  const [isCheckingCoverage, setIsCheckingCoverage] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  
  // Track last aggregated window to prevent infinite loops
  const lastAggregatedWindowRef = React.useRef<string | null>(null);
  
  // Show if graph has any edges with parameter files (for windowed aggregation)
  // This includes both external connections and file-based parameters
  const hasParameterFiles = useMemo(() => {
    return graph?.edges?.some(e => e.p?.id || e.cost_gbp?.id || e.cost_time?.id) || false;
  }, [graph]);
  
  // Always show - window selector is useful for any parameter-based aggregation
  
  // Default to last 7 days if no window set
  const defaultEnd = new Date();
  const defaultStart = new Date();
  defaultStart.setDate(defaultEnd.getDate() - 7);
  
  const startDate = window?.start || defaultStart.toISOString().split('T')[0];
  const endDate = window?.end || defaultEnd.toISOString().split('T')[0];
  
  const currentWindow: DateRange = useMemo(() => ({
    start: startDate,
    end: endDate,
  }), [startDate, endDate]);
  
  // Check data coverage and auto-aggregate when window changes
  useEffect(() => {
    const checkDataCoverageAndAggregate = async () => {
      if (!graph || !window) {
        setNeedsFetch(false);
        return;
      }
      
      setIsCheckingCoverage(true);
      
      try {
        let hasMissingData = false;
        let hasAnyConnection = false;
        const paramsToAggregate: Array<{ paramId: string; edgeId: string; slot: 'p' | 'cost_gbp' | 'cost_time' }> = [];
        
        // Normalize window dates to ISO timestamps for calculateIncrementalFetch
        const normalizedWindow: DateRange = {
          start: currentWindow.start.includes('T') ? currentWindow.start : `${currentWindow.start}T00:00:00Z`,
          end: currentWindow.end.includes('T') ? currentWindow.end : `${currentWindow.end}T23:59:59Z`,
        };
        
        // Check all parameters in graph
        if (graph.edges) {
          for (const edge of graph.edges) {
            const edgeId = edge.uuid || edge.id || '';
            
            // Check each parameter slot
            const paramSlots: Array<{ slot: 'p' | 'cost_gbp' | 'cost_time'; param: any }> = [];
            if (edge.p?.id) paramSlots.push({ slot: 'p', param: edge.p });
            if (edge.cost_gbp?.id) paramSlots.push({ slot: 'cost_gbp', param: edge.cost_gbp });
            if (edge.cost_time?.id) paramSlots.push({ slot: 'cost_time', param: edge.cost_time });
            
            for (const { slot, param } of paramSlots) {
              const paramId = param.id;
              if (!paramId) continue;
              
              // Check if parameter has connection (file or direct)
              const paramFile = fileRegistry.getFile(`parameter-${paramId}`);
              const hasConnection = !!paramFile?.data?.connection || !!param?.connection;
              
              if (!hasConnection) continue; // Skip if no connection
              
              hasAnyConnection = true; // We have at least one connected parameter
              
              // Strict validation: check if data exists for this window
              if (paramFile?.data) {
                const incrementalResult = calculateIncrementalFetch(
                  paramFile.data,
                  normalizedWindow
                );
                
                // Strict: if ANY days are missing, require fetch
                if (incrementalResult.needsFetch) {
                  console.log(`[WindowSelector] Param ${paramId} (${slot}) needs fetch:`, {
                    window: normalizedWindow,
                    totalDays: incrementalResult.totalDays,
                    daysAvailable: incrementalResult.daysAvailable,
                    daysToFetch: incrementalResult.daysToFetch,
                    missingDates: incrementalResult.missingDates.slice(0, 5),
                  });
                  hasMissingData = true;
                } else {
                  // All data exists - add to aggregation list
                  // Only aggregate if parameter has daily data
                  const hasDailyData = paramFile.data.values?.some((v: any) => 
                    v.n_daily && v.k_daily && v.dates && v.dates.length > 0
                  );
                  if (hasDailyData) {
                    paramsToAggregate.push({ paramId, edgeId, slot });
                  }
                }
              } else {
                // No file exists - need to fetch
                hasMissingData = true;
              }
            }
          }
        }
        
        // Check cases
        if (graph.nodes) {
          for (const node of graph.nodes) {
            if (node.case?.id) {
              const caseId = node.case.id;
              const caseFile = fileRegistry.getFile(`case-${caseId}`);
              const hasConnection = !!caseFile?.data?.connection || !!node.case?.connection;
              
              if (hasConnection) {
                hasAnyConnection = true;
                if (!caseFile) {
                  // Has connection but no file - need to fetch
                  hasMissingData = true;
                }
              }
            }
          }
        }
        
        // Set needsFetch flag
        setNeedsFetch(hasAnyConnection && hasMissingData);
        
        // Auto-aggregate parameters that have all data for this window
        // But only if we haven't already aggregated for this exact window (prevents loops)
        const windowKey = `${normalizedWindow.start}|${normalizedWindow.end}`;
        const alreadyAggregated = lastAggregatedWindowRef.current === windowKey;
        
        if (paramsToAggregate.length > 0 && !hasMissingData && !alreadyAggregated) {
          console.log(`[WindowSelector] Auto-aggregating ${paramsToAggregate.length} parameters for window:`, normalizedWindow);
          lastAggregatedWindowRef.current = windowKey; // Mark as aggregated
          
          for (const { paramId, edgeId, slot } of paramsToAggregate) {
            try {
              await dataOperationsService.getParameterFromFile({
                paramId,
                edgeId,
                graph,
                setGraph: (g) => {
                  if (g) setGraph(g);
                },
                window: normalizedWindow,
              });
            } catch (error) {
              console.error(`[WindowSelector] Failed to aggregate param ${paramId}:`, error);
            }
          }
        } else if (alreadyAggregated) {
          console.log(`[WindowSelector] Skipping auto-aggregation - already aggregated for this window`);
        }
      } catch (error) {
        console.error('[WindowSelector] Error checking data coverage:', error);
        setNeedsFetch(false);
      } finally {
        setIsCheckingCoverage(false);
      }
    };
    
    // Debounce coverage check
    const timeoutId = setTimeout(checkDataCoverageAndAggregate, 300);
    return () => clearTimeout(timeoutId);
  }, [graph, currentWindow, window, setGraph]);
  
  // Reset aggregated window when window actually changes (user changes it)
  React.useEffect(() => {
    if (window) {
      const windowKey = `${currentWindow.start.includes('T') ? currentWindow.start : `${currentWindow.start}T00:00:00Z`}|${currentWindow.end.includes('T') ? currentWindow.end : `${currentWindow.end}T23:59:59Z`}`;
      if (lastAggregatedWindowRef.current !== windowKey) {
        lastAggregatedWindowRef.current = null; // Reset when window changes
      }
    }
  }, [currentWindow.start, currentWindow.end]);
  
  const handleDateRangeChange = (start: string, end: string) => {
    setWindow({ start, end });
  };
  
  const handlePreset = (days: number | 'today') => {
    const end = new Date();
    const start = new Date();
    
    if (days === 'today') {
      // Today only (start and end are same day)
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
    } else {
      // Last N days (excluding today - end on yesterday)
      // This ensures we only request data that's likely to be available
      end.setDate(end.getDate() - 1); // Yesterday
      start.setDate(end.getDate() - (days - 1));
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
    }
    
    const startStr = start.toISOString().split('T')[0];
    const endStr = end.toISOString().split('T')[0];
    
    console.log(`[WindowSelector] Preset ${days} days:`, {
      start: startStr,
      end: endStr,
      today: new Date().toISOString().split('T')[0],
      includesToday: endStr === new Date().toISOString().split('T')[0],
    });
    
    setWindow({
      start: startStr,
      end: endStr,
    });
  };
  
  // Collect batch items that need fetching (have connections but missing data)
  const batchItemsToFetch = useMemo(() => {
    if (!graph || !needsFetch) return [];
    
    const items: BatchItem[] = [];
    const normalizedWindow: DateRange = {
      start: currentWindow.start.includes('T') ? currentWindow.start : `${currentWindow.start}T00:00:00Z`,
      end: currentWindow.end.includes('T') ? currentWindow.end : `${currentWindow.end}T23:59:59Z`,
    };
    
    // Collect parameters that need fetching
    if (graph.edges) {
      for (const edge of graph.edges) {
        const edgeId = edge.uuid || edge.id || '';
        
        const paramSlots: Array<{ slot: 'p' | 'cost_gbp' | 'cost_time'; param: any }> = [];
        if (edge.p?.id) paramSlots.push({ slot: 'p', param: edge.p });
        if (edge.cost_gbp?.id) paramSlots.push({ slot: 'cost_gbp', param: edge.cost_gbp });
        if (edge.cost_time?.id) paramSlots.push({ slot: 'cost_time', param: edge.cost_time });
        
        for (const { slot, param } of paramSlots) {
          const paramId = param.id;
          if (!paramId) continue;
          
          const paramFile = fileRegistry.getFile(`parameter-${paramId}`);
          const hasConnection = !!paramFile?.data?.connection || !!param?.connection;
          
          if (!hasConnection) continue;
          
          // Check if this parameter needs fetching for the window
          let needsFetchForThis = false;
          if (!paramFile?.data) {
            needsFetchForThis = true; // No file exists
          } else {
            const incrementalResult = calculateIncrementalFetch(
              paramFile.data,
              normalizedWindow
            );
            needsFetchForThis = incrementalResult.needsFetch;
          }
          
          if (needsFetchForThis) {
            items.push({
              id: `param-${paramId}-${slot}-${edgeId}`,
              type: 'parameter',
              name: `${slot}: ${paramId}`,
              objectId: paramId,
              targetId: edgeId,
              paramSlot: slot,
            });
          }
        }
      }
    }
    
    // Collect cases that need fetching
    if (graph.nodes) {
      for (const node of graph.nodes) {
        if (node.case?.id) {
          const caseId = node.case.id;
          const caseFile = fileRegistry.getFile(`case-${caseId}`);
          const hasConnection = !!caseFile?.data?.connection || !!node.case?.connection;
          
          if (hasConnection && !caseFile) {
            items.push({
              id: `case-${caseId}-${node.uuid || node.id}`,
              type: 'case',
              name: `case: ${caseId}`,
              objectId: caseId,
              targetId: node.uuid || node.id || '',
            });
          }
        }
      }
    }
    
    return items;
  }, [graph, needsFetch, currentWindow]);
  
  const handleFetchData = async () => {
    if (!graph || batchItemsToFetch.length === 0) return;
    
    setIsFetching(true);
    
    const normalizedWindow: DateRange = {
      start: currentWindow.start.includes('T') ? currentWindow.start : `${currentWindow.start}T00:00:00Z`,
      end: currentWindow.end.includes('T') ? currentWindow.end : `${currentWindow.end}T23:59:59Z`,
    };
    
    // Show progress toast
    const progressToastId = toast.loading(
      `Fetching 0/${batchItemsToFetch.length}...`,
      { duration: Infinity }
    );
    
    let successCount = 0;
    let errorCount = 0;
    
    try {
      for (let i = 0; i < batchItemsToFetch.length; i++) {
        const item = batchItemsToFetch[i];
        
        // Update progress toast
        toast.loading(
          `Fetching ${i + 1}/${batchItemsToFetch.length}: ${item.name}`,
          { id: progressToastId, duration: Infinity }
        );
        
        try {
          if (item.type === 'parameter') {
            await dataOperationsService.getFromSource({
              objectType: 'parameter',
              objectId: item.objectId,
              targetId: item.targetId,
              graph,
              setGraph: (g) => {
                if (g) setGraph(g);
              },
              paramSlot: item.paramSlot,
              window: normalizedWindow,
            });
            successCount++;
          } else if (item.type === 'case') {
            await dataOperationsService.getFromSource({
              objectType: 'case',
              objectId: item.objectId,
              targetId: item.targetId,
              graph,
              setGraph: (g) => {
                if (g) setGraph(g);
              },
            });
            successCount++;
          }
        } catch (error) {
          console.error(`[WindowSelector] Failed to fetch ${item.name}:`, error);
          errorCount++;
        }
      }
      
      // Dismiss progress toast
      toast.dismiss(progressToastId);
      
      // Show summary
      if (successCount > 0) {
        toast.success(
          `✓ Fetched ${successCount} item${successCount > 1 ? 's' : ''}${errorCount > 0 ? `, ${errorCount} failed` : ''}`,
          { duration: 3000 }
        );
      } else if (errorCount > 0) {
        toast.error(`Failed to fetch ${errorCount} item${errorCount > 1 ? 's' : ''}`);
      }
      
      // Re-check coverage after fetch
      // Trigger coverage check by updating a dependency
      setWindow({ ...window! });
    } catch (error) {
      toast.dismiss(progressToastId);
      console.error('[WindowSelector] Batch fetch failed:', error);
      toast.error('Failed to fetch data');
    } finally {
      setIsFetching(false);
    }
  };
  
  return (
    <div className={`window-selector ${!needsFetch ? 'window-selector-compact' : ''}`}>
      <div className="window-selector-content">
        <label htmlFor="window-start" className="window-selector-label">
          Window:
        </label>
        <div className="window-selector-presets">
          <button
            type="button"
            onClick={() => handlePreset('today')}
            className="window-selector-preset"
            title="Today only"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => handlePreset(7)}
            className="window-selector-preset"
            title="Last 7 days"
          >
            7d
          </button>
          <button
            type="button"
            onClick={() => handlePreset(30)}
            className="window-selector-preset"
            title="Last 30 days"
          >
            30d
          </button>
          <button
            type="button"
            onClick={() => handlePreset(90)}
            className="window-selector-preset"
            title="Last 90 days"
          >
            90d
          </button>
        </div>
        <DateRangePicker
          startDate={startDate}
          endDate={endDate}
          onChange={handleDateRangeChange}
          maxDate={new Date().toISOString().split('T')[0]}
        />
        {needsFetch && (
          <button
            onClick={handleFetchData}
            disabled={isCheckingCoverage || isFetching || batchItemsToFetch.length === 0}
            className="window-selector-button"
            title={
              isCheckingCoverage
                ? "Checking data coverage..."
                : isFetching
                  ? "Fetching data..."
                  : `Fetch ${batchItemsToFetch.length} item${batchItemsToFetch.length > 1 ? 's' : ''} from external sources`
            }
          >
            {isCheckingCoverage ? 'Checking...' : isFetching ? 'Fetching...' : 'Fetch data'}
          </button>
        )}
      </div>
    </div>
  );
}

