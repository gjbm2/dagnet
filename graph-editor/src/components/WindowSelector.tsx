/**
 * WindowSelector Component
 * 
 * Graph-level date range picker for data fetching window selection.
 * Automatically checks data coverage when window changes.
 * Shows "Fetch data" button if data is missing for connected parameters/cases.
 */

import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { useGraphStore } from '../contexts/GraphStoreContext';
import type { DateRange } from '../types';
import { dataOperationsService } from '../services/dataOperationsService';
import { calculateIncrementalFetch } from '../services/windowAggregationService';
import { fileRegistry, useTabContext } from '../contexts/TabContext';
import { DateRangePicker } from './DateRangePicker';
import { FileText, Zap } from 'lucide-react';
import { parseConstraints } from '../lib/queryDSL';
import { formatDateUK } from '../lib/dateFormat';
import toast from 'react-hot-toast';
import './WindowSelector.css';
import { ContextValueSelector } from './ContextValueSelector';
import { contextRegistry } from '../services/contextRegistry';
import { QueryExpressionEditor } from './QueryExpressionEditor';
import { PinnedQueryModal } from './modals/PinnedQueryModal';
import { BulkScenarioCreationModal } from './modals/BulkScenarioCreationModal';
import { useFetchData, fetchWithToast, createFetchItem, type FetchItem } from '../hooks/useFetchData';
import { useBulkScenarioCreation } from '../hooks/useBulkScenarioCreation';

interface BatchItem {
  id: string;
  type: 'parameter' | 'case' | 'node';
  name: string;
  objectId: string;
  targetId: string;
  paramSlot?: 'p' | 'cost_gbp' | 'cost_time';
}

// Phase 3: Coverage cache - memoize coverage check results per window
interface CoverageCacheEntry {
  dslKey: string; // DSL string (contains window + context)
  hasMissingData: boolean;
  hasAnyConnection: boolean;
  paramsToAggregate: Array<{ paramId: string; edgeId: string; slot: 'p' | 'cost_gbp' | 'cost_time' }>;
  graphHash: string; // Hash of graph structure to invalidate when graph changes
}

// Module-level cache (scoped to component instance via ref)
const coverageCache = new Map<string, CoverageCacheEntry>();

// Helper to create a simple hash of graph structure (edges/nodes IDs)
function getGraphHash(graph: any): string {
  if (!graph) return '';
  const edgeIds = (graph.edges || []).map((e: any) => e.uuid || e.id).sort().join(',');
  const nodeIds = (graph.nodes || []).map((n: any) => n.uuid || n.id).sort().join(',');
  return `${edgeIds}|${nodeIds}`;
}

interface WindowSelectorProps {
  tabId?: string;
}

export function WindowSelector({ tabId }: WindowSelectorProps = {}) {
  const graphStore = useGraphStore();
  const { graph, window, setWindow, setGraph, lastAggregatedWindow, setLastAggregatedWindow, setCurrentDSL } = graphStore;
  // Use getState() in callbacks to avoid stale closure issues
  const getLatestGraph = () => (graphStore as any).getState?.()?.graph ?? graph;
  const { tabs, operations } = useTabContext();
  
  // CRITICAL: These refs must be defined BEFORE useFetchData hook since it uses them
  const isInitialMountRef = useRef(true);
  const isAggregatingRef = useRef(false); // Track if we're currently aggregating to prevent loops
  const lastAggregatedDSLRef = useRef<string | null>(null); // Track DSL (single source of truth for change detection)
  const graphRef = useRef<typeof graph>(graph); // Track graph to avoid dependency loop
  const prevDSLRef = useRef<string | null>(null); // Track previous DSL for shimmer trigger
  
  // Centralized fetch hook - uses refs for batch operations
  // The ref-based setGraph prevents effect re-triggering during auto-aggregation
  // CRITICAL: Uses graphStore.currentDSL as AUTHORITATIVE source, NOT graph.currentQueryDSL!
  const { fetchItem, fetchItems, getItemsNeedingFetch } = useFetchData({
    graph: () => graphRef.current,  // Getter for fresh state during batch
    setGraph: (g) => {
      if (g) {
        graphRef.current = g;  // Update ref immediately
        // Only trigger real setGraph if not in batch mode
        if (!isAggregatingRef.current) {
          setGraph(g);
        }
      }
    },
    currentDSL: () => (graphStore as any).getState?.()?.currentDSL || '',  // AUTHORITATIVE DSL from graphStore
  });
  const [needsFetch, setNeedsFetch] = useState(false);
  const [isCheckingCoverage, setIsCheckingCoverage] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [showButton, setShowButton] = useState(false); // Track button visibility for animations
  const [showShimmer, setShowShimmer] = useState(false); // Track shimmer animation
  
  // Context dropdown and unroll states
  const [showContextDropdown, setShowContextDropdown] = useState(false);
  const [availableKeySections, setAvailableKeySections] = useState<any[]>([]);
  const [isUnrolled, setIsUnrolled] = useState(false);
  const [showPinnedQueryModal, setShowPinnedQueryModal] = useState(false);
  
  // Preset context menu state
  const [presetContextMenu, setPresetContextMenu] = useState<{
    x: number;
    y: number;
    preset: 7 | 30 | 90;
  } | null>(null);
  const presetContextMenuRef = useRef<HTMLDivElement>(null);
  
  // Bulk scenario creation hook
  const {
    createWindowScenario,
    createMultipleWindowScenarios,
    getWindowDSLForPreset,
    openBulkCreateForContext,
    bulkCreateModal,
    closeBulkCreateModal,
    createScenariosForContext
  } = useBulkScenarioCreation();
  const [showingAllContexts, setShowingAllContexts] = useState(false);
  
  const contextButtonRef = useRef<HTMLButtonElement>(null);
  const contextDropdownRef = useRef<HTMLDivElement>(null);
  const windowSelectorRef = useRef<HTMLDivElement>(null);
  
  // Calculate default window dates (last 7 days) - needed early for initialization
  const defaultWindowDates = useMemo(() => {
    const defaultEnd = new Date();
    const defaultStart = new Date();
    defaultStart.setDate(defaultEnd.getDate() - 7);
    return {
      start: formatDateUK(defaultStart),
      end: formatDateUK(defaultEnd)
    };
  }, []);
  
  // Initialize window state in store if not set
  useEffect(() => {
    if (!window && setWindow) {
      console.log('[WindowSelector] Initializing default window:', defaultWindowDates);
      setWindow(defaultWindowDates);
    }
  }, [window, setWindow, defaultWindowDates]);
  
  // Initialize DSL with default window if not set
  // Sets BOTH authoritative DSL (graphStore.currentDSL) AND historic record (graph.currentQueryDSL)
  const isInitializedRef = useRef(false);
  useEffect(() => {
    // Check if authoritative DSL needs initialization
    const authoritativeDSL = (graphStore as any).getState?.()?.currentDSL || '';
    
    if (graph && !authoritativeDSL && !isInitializedRef.current) {
      // Use window from store if set, otherwise use defaults
      const windowToUse = window || defaultWindowDates;
      const defaultDSL = `window(${formatDateUK(windowToUse.start)}:${formatDateUK(windowToUse.end)})`;
      console.log('[WindowSelector] Initializing AUTHORITATIVE DSL:', defaultDSL);
      
      // Set AUTHORITATIVE DSL on graphStore
      setCurrentDSL(defaultDSL);
      
      // Also set historic record on graph (not used for queries!)
      if (setGraph) {
        setGraph({ ...graph, currentQueryDSL: defaultDSL });
      }
      isInitializedRef.current = true;
    }
  }, [graph, window, setGraph, setCurrentDSL, defaultWindowDates, graphStore]); // Dependencies
  
  // Parse current context values and key from currentQueryDSL
  const currentContextValues = useMemo(() => {
    if (!graph?.currentQueryDSL) return [];
    const parsed = parseConstraints(graph.currentQueryDSL);
    
    const valueIds: string[] = [];
    for (const ctx of parsed.context) {
      valueIds.push(ctx.value);
    }
    for (const ctxAny of parsed.contextAny) {
      for (const pair of ctxAny.pairs) {
        valueIds.push(pair.value);
      }
    }
    return valueIds;
  }, [graph?.currentQueryDSL]);
  
  const currentContextKey = useMemo(() => {
    if (!graph?.currentQueryDSL) return undefined;
    const parsed = parseConstraints(graph.currentQueryDSL);
    
    if (parsed.context.length > 0) return parsed.context[0].key;
    if (parsed.contextAny.length > 0 && parsed.contextAny[0].pairs.length > 0) {
      return parsed.contextAny[0].pairs[0].key;
    }
    return undefined;
  }, [graph?.currentQueryDSL]);
  
  // Build DSL from AUTHORITATIVE sources: window state + context from UI
  // NEVER use graph.currentQueryDSL directly for queries - it's just a record
  const buildDSLFromState = useCallback((windowState: DateRange): string => {
    // Get context from graph.currentQueryDSL (this IS where user's selection is stored)
    const parsed = parseConstraints(graph?.currentQueryDSL || '');
    
    const contextParts: string[] = [];
    for (const ctx of parsed.context) {
      contextParts.push(`context(${ctx.key}:${ctx.value})`);
    }
    for (const ctxAny of parsed.contextAny) {
      const pairs = ctxAny.pairs.map(p => `${p.key}:${p.value}`).join(',');
      contextParts.push(`contextAny(${pairs})`);
    }
    
    // Build window from AUTHORITATIVE window state (not from graph.currentQueryDSL)
    const windowPart = `window(${formatDateUK(windowState.start)}:${formatDateUK(windowState.end)})`;
    
    return contextParts.length > 0 
      ? `${contextParts.join('.')}.${windowPart}` 
      : windowPart;
  }, [graph?.currentQueryDSL]);
  
    // Update CSS variable for scenario legend positioning when height changes
  // Set on the container element (not document root) so it's scoped to this tab
  useEffect(() => {
    const updatePosition = () => {
      if (windowSelectorRef.current) {
        const height = windowSelectorRef.current.offsetHeight;
        const gap = 16; // Gap between WindowSelector bottom and scenario legend top
        const topOffset = 16; // WindowSelector's top position
        const bottomPosition = topOffset + height + gap;
        
        // Set on the closest .graph-editor-dock-container (scoped to this tab)
        const container = windowSelectorRef.current.closest('.graph-editor-dock-container') as HTMLElement;
        if (container) {
          container.style.setProperty('--window-selector-bottom', `${bottomPosition}px`);
        }
      }
    };
    
    // Update on mount and when dependencies change
    updatePosition();
    
    // Use ResizeObserver to catch all size changes (context chips expanding, etc.)
    const observer = new ResizeObserver(() => {
      updatePosition();
    });
    
    if (windowSelectorRef.current) {
      observer.observe(windowSelectorRef.current);
    }
    
    return () => observer.disconnect();
  }, [isUnrolled, graph?.currentQueryDSL, showContextDropdown, needsFetch]);
  
  // Load context keys from graph.dataInterestsDSL when dropdown opens
  // Also reload when graph changes (e.g., after F5)
  useEffect(() => {
    // Skip if in "show all" mode - don't overwrite the full list with pinned DSL
    if (showingAllContexts) {
      console.log('[WindowSelector] Skipping context load - in "show all" mode');
      return;
    }
    
    // Always reload contexts when dropdown opens (don't cache stale data)
    if (showContextDropdown) {
      const loadContextsFromPinnedQuery = async () => {
        // Clear cache to get fresh data
        contextRegistry.clearCache();
        // Parse dataInterestsDSL to get pinned context keys
        const pinnedDSL = graph?.dataInterestsDSL || '';
        console.log('[WindowSelector] Pinned DSL:', pinnedDSL);
        
        if (!pinnedDSL) {
          console.warn('[WindowSelector] No dataInterestsDSL set on graph - showing all available contexts');
          // Fall back to showing all available contexts
          const keys = await contextRegistry.getAllContextKeys();
          console.log('[WindowSelector] All available context keys:', keys);
          const sections = await Promise.all(
            keys.map(async key => {
              const context = await contextRegistry.getContext(key.id);
              const values = await contextRegistry.getValuesForContext(key.id);
              return {
                id: key.id,
                name: key.id.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                values,
                otherPolicy: context?.otherPolicy
              };
            })
          );
          setAvailableKeySections(sections);
          return;
        }
        
        // Parse pinned DSL to extract context keys
        const { parseConstraints } = await import('../lib/queryDSL');
        const clauses = pinnedDSL.split(';').map(c => c.trim()).filter(c => c);
        const contextKeySet = new Set<string>();
        
        for (const clause of clauses) {
          const parsed = parseConstraints(clause);
          for (const ctx of parsed.context) {
            contextKeySet.add(ctx.key);
          }
          for (const ctxAny of parsed.contextAny) {
            for (const pair of ctxAny.pairs) {
              contextKeySet.add(pair.key);
            }
          }
        }
        
        console.log('[WindowSelector] Context keys from pinned DSL:', Array.from(contextKeySet));
        
        // Load values for each pinned key
        const sections = await Promise.all(
          Array.from(contextKeySet).map(async keyId => {
            const context = await contextRegistry.getContext(keyId);
            const values = await contextRegistry.getValuesForContext(keyId);
            console.log(`[WindowSelector] Loaded values for ${keyId}:`, values);
            return {
              id: keyId,
              name: keyId.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
              values,
              otherPolicy: context?.otherPolicy
            };
          })
        );
        
        console.log('[WindowSelector] Sections from pinned query:', sections);
        setAvailableKeySections(sections);
      };
      
      loadContextsFromPinnedQuery().catch(err => {
        console.error('Failed to load contexts from pinned query:', err);
      });
    }
  }, [showContextDropdown, showingAllContexts, graph?.dataInterestsDSL]);
  
  // Close context dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        showContextDropdown &&
        contextButtonRef.current &&
        contextDropdownRef.current &&
        !contextButtonRef.current.contains(event.target as Node) &&
        !contextDropdownRef.current.contains(event.target as Node)
      ) {
        setShowContextDropdown(false);
        setShowingAllContexts(false); // Reset for next open
      }
    }
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showContextDropdown]);
  
  // Close preset context menu when clicking outside
  useEffect(() => {
    if (!presetContextMenu) return;
    
    function handleClickOutside(event: MouseEvent) {
      if (presetContextMenuRef.current && !presetContextMenuRef.current.contains(event.target as Node)) {
        setPresetContextMenu(null);
      }
    }
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [presetContextMenu]);
  
  // Sync refs with state (separate effects to avoid triggering aggregation)
  useEffect(() => {
    graphRef.current = graph;
  }, [graph]);
  
  // Sync lastAggregatedDSL from persisted state on load
  useEffect(() => {
    if (!lastAggregatedWindow) {
      lastAggregatedDSLRef.current = null;
    }
    // Note: lastAggregatedDSLRef is set directly when aggregation happens
  }, [lastAggregatedWindow]);
  
  // Handle button appearance/disappearance animations
  useEffect(() => {
    if (needsFetch && !showButton) {
      // Button appearing: show it with fade-in
      setShowButton(true);
      // Trigger shimmer after a short delay to ensure button is visible
      setTimeout(() => {
        setShowShimmer(true);
        setTimeout(() => setShowShimmer(false), 600); // Match shimmer animation duration
      }, 100);
    } else if (!needsFetch && showButton) {
      // Button disappearing: fade out and shrink width smoothly
      setShowShimmer(false);
      // Wait for fade-out animation (300ms) before removing from DOM
      // This allows width animation to complete smoothly
      setTimeout(() => {
        setShowButton(false);
      }, 300);
    }
  }, [needsFetch, showButton]);
  
  // Trigger shimmer whenever DSL changes and fetch is required
  // Use authoritative DSL from graphStore for consistency
  useEffect(() => {
    const authoritativeDSL = (graphStore as any).getState?.()?.currentDSL || '';
    if (!authoritativeDSL) {
      prevDSLRef.current = null;
      return;
    }
    
    const dslChanged = authoritativeDSL !== prevDSLRef.current;
    
    // Update ref
    prevDSLRef.current = authoritativeDSL;
    
    // If DSL changed and button is visible and fetch is required, trigger shimmer
    if (dslChanged && needsFetch && showButton) {
      setShowShimmer(false); // Reset first
      setTimeout(() => {
        setShowShimmer(true);
        setTimeout(() => setShowShimmer(false), 600);
      }, 50);
    }
  }, [graph?.currentQueryDSL, needsFetch, showButton]);
  
  // Show if graph has any edges with parameter files (for windowed aggregation)
  // This includes both external connections and file-based parameters
  const hasParameterFiles = useMemo(() => {
    return graph?.edges?.some(e => e.p?.id || e.cost_gbp?.id || e.cost_time?.id) || false;
  }, [graph]);
  
  // Always show - window selector is useful for any parameter-based aggregation
  
  // Use window from store, falling back to defaults calculated earlier
  const startDate = window?.start || defaultWindowDates.start;
  const endDate = window?.end || defaultWindowDates.end;
  
  const currentWindow: DateRange = useMemo(() => ({
    start: startDate,
    end: endDate,
  }), [startDate, endDate]);
  
  // Check data coverage and auto-aggregate when window changes
  useEffect(() => {
    // Check refs BEFORE scheduling debounced function to prevent multiple queued executions
    if (isAggregatingRef.current) {
      return; // Already aggregating, skip
    }
    
    // CRITICAL: Build DSL from AUTHORITATIVE sources NOW, before async runs.
    // - window: from graphStore (authoritative date range)
    // - context: extracted from graph.currentQueryDSL (where user's selection is stored)
    // We NEVER use graph.currentQueryDSL directly as the query - it's just a record.
    const currentWindowState = window;
    const dslFromState = currentWindowState ? buildDSLFromState(currentWindowState) : '';
    
    const checkDataCoverageAndAggregate = async () => {
      // Use ref for graph structure but DSL from closure (which is fresh)
      const currentGraph = graphRef.current;
      if (!currentGraph || !window) {
        setNeedsFetch(false);
        return;
      }
      
      // Skip on initial mount - wait for lastAggregatedWindow to load from persistence
      if (isInitialMountRef.current) {
        isInitialMountRef.current = false;
        return;
      }
      
      // Double-check aggregation flag (in case it was set between scheduling and execution)
      if (isAggregatingRef.current) {
        return;
      }
      
      // Use DSL as single source of truth (contains both window and context)
      const currentDSL = dslFromState;
      const lastDSL = lastAggregatedDSLRef.current || '';
      
      // DSL contains everything - if it matches, nothing has changed
      if (currentDSL && currentDSL === lastDSL) {
        setNeedsFetch(false);
        return;
      }
      
      // Log what changed
      if (lastDSL && currentDSL !== lastDSL) {
        console.log('[WindowSelector] DSL changed, triggering coverage check:', {
          currentDSL,
          lastDSL
        });
      }
      
      // DSL differs from last aggregated - check coverage
      setIsCheckingCoverage(true);
      
      // Cache key uses DSL (contains window + context) and graph hash
      const currentGraphHash = getGraphHash(currentGraph);
      const cacheKey = `${dslFromState}|${currentGraphHash}`;
      const cachedResult = coverageCache.get(cacheKey);
      
      // If cache hit and graph hash matches, use cached result
      if (cachedResult && cachedResult.graphHash === currentGraphHash) {
        console.log(`[WindowSelector] Using cached coverage result for DSL:`, dslFromState);
        setNeedsFetch(cachedResult.hasAnyConnection && cachedResult.hasMissingData);
        
        // If we have params to aggregate and no missing data, trigger aggregation
        if (cachedResult.paramsToAggregate.length > 0 && !cachedResult.hasMissingData) {
          // Use hook for auto-aggregation (one code path)
          isAggregatingRef.current = true;
          lastAggregatedDSLRef.current = dslFromState;
          
          try {
            // Build FetchItems from paramsToAggregate
            const items = cachedResult.paramsToAggregate.map(({ paramId, edgeId, slot }) =>
              createFetchItem('parameter', paramId, edgeId, { paramSlot: slot })
            );
            
            // Use hook's fetchItems with from-file mode (no API call)
            await fetchItems(items, { mode: 'from-file' });
            
            // Apply accumulated changes (ref was updated by setGraph callback)
            const updatedGraph = graphRef.current;
            if (updatedGraph && updatedGraph !== currentGraph) {
              setGraph(updatedGraph);
            }
            
            setTimeout(() => {
              setLastAggregatedWindow(currentWindow); // Store in UK format
              isAggregatingRef.current = false;
            }, 0);
          } catch (error) {
            isAggregatingRef.current = false;
            lastAggregatedDSLRef.current = null;
            throw error;
          }
        } else {
          isAggregatingRef.current = false;
        }
        
        setIsCheckingCoverage(false);
        return;
      }
      
      // Cache miss - compute coverage
      console.log(`[WindowSelector] Computing coverage check for DSL:`, dslFromState);
      
      try {
        let hasMissingData = false;
        let hasAnyConnection = false;
        const paramsToAggregate: Array<{ paramId: string; edgeId: string; slot: 'p' | 'cost_gbp' | 'cost_time' }> = [];
        
        // Check all parameters in graph (use ref to avoid dependency)
        if (currentGraph.edges) {
          for (const edge of currentGraph.edges) {
            const edgeId = edge.uuid || edge.id || '';
            
            // Check each parameter slot
            // Check all parameter slots (including those with direct connections but no file)
            const paramSlots: Array<{ slot: 'p' | 'cost_gbp' | 'cost_time'; param: any }> = [];
            if (edge.p) paramSlots.push({ slot: 'p', param: edge.p });
            if (edge.cost_gbp) paramSlots.push({ slot: 'cost_gbp', param: edge.cost_gbp });
            if (edge.cost_time) paramSlots.push({ slot: 'cost_time', param: edge.cost_time });
            
            for (const { slot, param } of paramSlots) {
              const paramId = param.id;
              
              // Check if parameter has connection (file or direct)
              const paramFile = paramId ? fileRegistry.getFile(`parameter-${paramId}`) : null;
              const hasConnection = !!paramFile?.data?.connection || !!param?.connection;
              
              if (!hasConnection) continue; // Skip if no connection
              
              hasAnyConnection = true; // We have at least one connected parameter
              
              // Strict validation: check if data exists for this window
              if (paramFile?.data) {
                const incrementalResult = calculateIncrementalFetch(
                  paramFile.data,
                  currentWindow, // Pass UK format dates - function handles normalization
                  undefined, // querySignature
                  false, // bustCache
                  currentGraph.currentQueryDSL || '' // targetSlice
                );
                
                // Strict: if ANY days are missing, require fetch
                if (incrementalResult.needsFetch) {
                  console.log(`[WindowSelector] Param ${paramId} (${slot}) needs fetch:`, {
                    dsl: dslFromState,
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
                // No file exists - check if we've already fetched for this DSL
                // For direct connections, we can't verify data existence, so we check
                // if the current DSL matches the last aggregated DSL
                const lastDSL = lastAggregatedDSLRef.current;
                if (!lastDSL || dslFromState !== lastDSL) {
                  // DSL doesn't match last aggregated - need to fetch
                  hasMissingData = true;
                }
                // If DSL matches last aggregated, assume data exists (don't set hasMissingData)
              }
            }
          }
        }
        
        // Check cases (use ref to avoid dependency)
        if (currentGraph.nodes) {
          for (const node of currentGraph.nodes) {
            if (node.case?.id) {
              const caseId = node.case.id;
              const caseFile = fileRegistry.getFile(`case-${caseId}`);
              const hasConnection = !!caseFile?.data?.connection || !!node.case?.connection;
              
              if (hasConnection) {
                hasAnyConnection = true;
                if (!caseFile) {
                  // Has connection but no file - check if we've already fetched for this DSL
                  const lastDSL = lastAggregatedDSLRef.current;
                  if (!lastDSL || dslFromState !== lastDSL) {
                    // DSL doesn't match last aggregated - need to fetch
                    hasMissingData = true;
                  }
                  // If DSL matches last aggregated, assume data exists (don't set hasMissingData)
                }
              }
            }
          }
        }
        
        // Set needsFetch flag
        setNeedsFetch(hasAnyConnection && hasMissingData);
        
        // Phase 3: Cache the computed result
        const cacheEntry: CoverageCacheEntry = {
          dslKey: dslFromState,
          hasMissingData,
          hasAnyConnection,
          paramsToAggregate: [...paramsToAggregate], // Copy array
          graphHash: currentGraphHash,
        };
        coverageCache.set(cacheKey, cacheEntry);
        console.log(`[WindowSelector] Cached coverage result for DSL:`, dslFromState);
        
        // Auto-aggregate parameters that have all data for this window
        if (paramsToAggregate.length > 0 && !hasMissingData) {
          console.log(`[WindowSelector] Auto-aggregating ${paramsToAggregate.length} parameters via hook for DSL:`, dslFromState);
          
          // Set flag to prevent re-triggering during aggregation
          isAggregatingRef.current = true;
          lastAggregatedDSLRef.current = dslFromState;
          
          try {
            // Build FetchItems from paramsToAggregate
            const items = paramsToAggregate.map(({ paramId, edgeId, slot }) =>
              createFetchItem('parameter', paramId, edgeId, { paramSlot: slot })
            );
            
            // Use hook's fetchItems with from-file mode (no API call)
            await fetchItems(items, { mode: 'from-file' });
            
            // Apply all accumulated changes at once
            const updatedGraph = graphRef.current;
            if (updatedGraph && updatedGraph !== currentGraph) {
              setGraph(updatedGraph);
            }
            
            // Update state (deferred to prevent re-triggering)
            setTimeout(() => {
              setLastAggregatedWindow(currentWindow); // Store in UK format
              isAggregatingRef.current = false;
            }, 0);
          } catch (error) {
            isAggregatingRef.current = false;
            lastAggregatedDSLRef.current = null;
            throw error;
          }
        } else {
          // No aggregation needed - clear flag if it was set
          isAggregatingRef.current = false;
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
  }, [currentWindow, window, setGraph, setLastAggregatedWindow, graph?.currentQueryDSL]); // Added currentQueryDSL to trigger check when context changes
  
  // Helper: Update window state, currentQueryDSL (historic), AND authoritative DSL
  const updateWindowAndDSL = (start: string, end: string) => {
    setWindow({ start, end });
    
    // Use getLatestGraph() to avoid stale closure
    const currentGraph = getLatestGraph();
    
    // Build context part from current graph (context is still stored on graph)
    const parsed = parseConstraints(currentGraph?.currentQueryDSL || '');
    
    const contextParts: string[] = [];
    for (const ctx of parsed.context) {
      contextParts.push(`context(${ctx.key}:${ctx.value})`);
    }
    for (const ctxAny of parsed.contextAny) {
      const pairs = ctxAny.pairs.map(p => `${p.key}:${p.value}`).join(',');
      contextParts.push(`contextAny(${pairs})`);
    }
    
    // Build window part with d-MMM-yy format
    const windowPart = `window(${formatDateUK(start)}:${formatDateUK(end)})`;
    
    // Combine
    const newDSL = contextParts.length > 0 
      ? `${contextParts.join('.')}.${windowPart}`
      : windowPart;
    
    // CRITICAL: Update AUTHORITATIVE DSL on graphStore (for all fetch operations)
    setCurrentDSL(newDSL);
    
    // Also update graph.currentQueryDSL for historic record (NOT for live queries!)
    if (setGraph && currentGraph) {
      setGraph({ ...currentGraph, currentQueryDSL: newDSL });
    }
  };
  
  const handleDateRangeChange = (start: string, end: string) => {
    updateWindowAndDSL(start, end);
  };
  
  const handlePreset = (days: number | 'today') => {
    const today = new Date();
    
    if (days === 'today') {
      // Today only (start and end are same day)
      const todayStr = formatDateUK(today);
      const newWindow: DateRange = { start: todayStr, end: todayStr };
      
      // Skip if window unchanged
      if (window && window.start === todayStr && window.end === todayStr) {
        console.log(`[WindowSelector] Preset today skipped (window unchanged)`);
        return;
      }
      
      console.log('[WindowSelector] Preset today:', todayStr);
      setWindow?.(newWindow);
      return;
    }
    
    // Last N days (excluding today - end on yesterday)
    const end = new Date(today);
    end.setDate(end.getDate() - 1); // Yesterday
    
    // Clone end and subtract days for start
    const start = new Date(end);
    start.setDate(start.getDate() - (days - 1));
    
    const startStr = formatDateUK(start);
    const endStr = formatDateUK(end);
    const newWindow: DateRange = { start: startStr, end: endStr };
    
    // Skip if window unchanged
    if (window && window.start === startStr && window.end === endStr) {
      console.log(`[WindowSelector] Preset ${days} days skipped (window unchanged)`);
      return;
    }
    
    console.log(`[WindowSelector] Preset ${days} days:`, { start: startStr, end: endStr });
    
    // IMPORTANT: Update BOTH window state and graph.currentQueryDSL
    updateWindowAndDSL(startStr, endStr);
  };
  
  // Right-click handler for preset buttons
  const handlePresetContextMenu = useCallback((preset: 7 | 30 | 90, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPresetContextMenu({ x: e.clientX, y: e.clientY, preset });
  }, []);
  
  // Create live scenario from window preset (using hook)
  const handleCreateWindowScenario = useCallback(async (preset: 7 | 30 | 90, offset: number = 0) => {
    const windowDSL = getWindowDSLForPreset(preset, offset);
    await createWindowScenario(windowDSL);
    setPresetContextMenu(null);
  }, [createWindowScenario, getWindowDSLForPreset]);
  
  // Create multiple window scenarios (using hook)
  const handleCreateMultipleWindowScenarios = useCallback(async (preset: 7 | 30 | 90, count: number) => {
    const dsls = Array.from({ length: count }, (_, i) => getWindowDSLForPreset(preset, i));
    await createMultipleWindowScenarios(dsls);
    setPresetContextMenu(null);
  }, [createMultipleWindowScenarios, getWindowDSLForPreset]);
  
  // Helper to check if current window matches a preset
  const getActivePreset = (): number | 'today' | null => {
    if (!window) return null;
    
    const today = new Date();
    const todayStr = formatDateUK(today);
    
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = formatDateUK(yesterday);
    
    // Check if it's "today" preset (start and end are same day, and it's today)
    if (window.start === window.end && window.start === todayStr) {
      return 'today';
    }
    
    // Check if it's "7d" preset (end is yesterday, start is 7 days before)
    const sevenDaysAgo = new Date(yesterday);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    if (window.end === yesterdayStr && window.start === formatDateUK(sevenDaysAgo)) {
      return 7;
    }
    
    // Check if it's "30d" preset (end is yesterday, start is 30 days before)
    const thirtyDaysAgo = new Date(yesterday);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
    if (window.end === yesterdayStr && window.start === formatDateUK(thirtyDaysAgo)) {
      return 30;
    }
    
    // Check if it's "90d" preset (end is yesterday, start is 90 days before)
    const ninetyDaysAgo = new Date(yesterday);
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 89);
    if (window.end === yesterdayStr && window.start === formatDateUK(ninetyDaysAgo)) {
      return 90;
    }
    
    return null;
  };
  
  const activePreset = getActivePreset();
  
  // Collect batch items that need fetching (have connections but missing data)
  const batchItemsToFetch = useMemo(() => {
    if (!graph || !needsFetch) return [];
    
    const items: BatchItem[] = [];
    // Use authoritative DSL from graphStore
    const authoritativeDSL = (graphStore as any).getState?.()?.currentDSL || '';
    
    // Collect parameters that need fetching
    if (graph.edges) {
      for (const edge of graph.edges) {
        const edgeId = edge.uuid || edge.id || '';
        
        // Check all parameter slots (including those with direct connections but no file)
        const paramSlots: Array<{ slot: 'p' | 'cost_gbp' | 'cost_time'; param: any }> = [];
        if (edge.p) paramSlots.push({ slot: 'p', param: edge.p });
        if (edge.cost_gbp) paramSlots.push({ slot: 'cost_gbp', param: edge.cost_gbp });
        if (edge.cost_time) paramSlots.push({ slot: 'cost_time', param: edge.cost_time });
        
        for (const { slot, param } of paramSlots) {
          const paramId = param.id;
          
          // Check if parameter has connection (file or direct)
          const paramFile = paramId ? fileRegistry.getFile(`parameter-${paramId}`) : null;
          const hasConnection = !!paramFile?.data?.connection || !!param?.connection;
          
          if (!hasConnection) continue;
          
          // Check if this parameter needs fetching for the DSL
          let needsFetchForThis = false;
          if (!paramFile?.data) {
            // No file exists - check if we've already fetched for this DSL
            const lastDSL = lastAggregatedDSLRef.current;
            if (!lastDSL || authoritativeDSL !== lastDSL) {
              needsFetchForThis = true;
            }
          } else {
            // File exists - check if data is missing (pass UK format, function normalizes)
            const incrementalResult = calculateIncrementalFetch(
              paramFile.data,
              currentWindow,
              undefined, // querySignature
              false, // bustCache  
              authoritativeDSL // targetSlice - uses authoritative DSL from graphStore
            );
            needsFetchForThis = incrementalResult.needsFetch;
          }
          
          if (needsFetchForThis) {
            // For direct connections without paramId, use edgeId as objectId
            items.push({
              id: `param-${paramId || 'direct'}-${slot}-${edgeId}`,
              type: 'parameter',
              name: `${slot}: ${paramId || 'direct connection'}`,
              objectId: paramId || '', // Empty string for direct connections
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
    
    try {
      // Convert BatchItem to FetchItem (filter out 'node' type which isn't used here)
      const fetchItemsList: FetchItem[] = batchItemsToFetch
        .filter(item => item.type === 'parameter' || item.type === 'case')
        .map(item => ({
          id: item.id,
          type: item.type as 'parameter' | 'case',
          name: item.name,
          objectId: item.objectId,
          targetId: item.targetId,
          paramSlot: item.paramSlot,
        }));
      
      // Use centralized fetch hook with toast notifications
      const results = await fetchWithToast(
        () => fetchItems(fetchItemsList, {
          onProgress: (current, total) => {
            // Progress is handled by fetchWithToast
          }
        }),
        fetchItemsList.length
      );
      
      const successCount = results.filter(r => r.success).length;
      
      // Update lastAggregatedWindow after successful fetch (store in UK format)
      if (successCount > 0) {
        setLastAggregatedWindow(currentWindow);
        // Use authoritative DSL from graphStore for tracking what we aggregated
        lastAggregatedDSLRef.current = (graphStore as any).getState?.()?.currentDSL || '';
      }
      
      // Trigger coverage check by updating window (will detect if still needs fetch)
      setWindow({ ...window! });
    } catch (error) {
      console.error('[WindowSelector] Batch fetch failed:', error);
    } finally {
      setIsFetching(false);
    }
  };
  
  return (
    <div ref={windowSelectorRef} className={`window-selector ${!needsFetch ? 'window-selector-compact' : ''}`}>
      {/* Main area (left side) */}
      <div className="window-selector-main">
      <div className="window-selector-content">
        <div className="window-selector-presets">
          <button
            type="button"
            onClick={() => handlePreset('today')}
            className={`window-selector-preset ${activePreset === 'today' ? 'active' : ''}`}
            title="Today only"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => handlePreset(7)}
            onContextMenu={(e) => handlePresetContextMenu(7, e)}
            className={`window-selector-preset ${activePreset === 7 ? 'active' : ''}`}
            title="Last 7 days (right-click for scenarios)"
          >
            7d
          </button>
          <button
            type="button"
            onClick={() => handlePreset(30)}
            onContextMenu={(e) => handlePresetContextMenu(30, e)}
            className={`window-selector-preset ${activePreset === 30 ? 'active' : ''}`}
            title="Last 30 days (right-click for scenarios)"
          >
            30d
          </button>
          <button
            type="button"
            onClick={() => handlePreset(90)}
            onContextMenu={(e) => handlePresetContextMenu(90, e)}
            className={`window-selector-preset ${activePreset === 90 ? 'active' : ''}`}
            title="Last 90 days (right-click for scenarios)"
          >
            90d
          </button>
        </div>
        <DateRangePicker
          startDate={startDate}
          endDate={endDate}
          onChange={handleDateRangeChange}
          maxDate={formatDateUK(new Date())}
        />
        
        {/* Context area: chips + add button - wrapped together to prevent line break between them */}
        <div className="window-selector-context-group">
        {/* Context chips area using QueryExpressionEditor - CONTEXTS ONLY (window shown in unrolled state) */}
        {(() => {
          const parsed = parseConstraints(graph?.currentQueryDSL || '');
          const hasContexts = parsed.context.length > 0 || parsed.contextAny.length > 0;
          
          if (!hasContexts) return null;
          
          // Build context-only DSL (strip window)
          const contextParts: string[] = [];
          for (const ctx of parsed.context) {
            contextParts.push(`context(${ctx.key}:${ctx.value})`);
          }
          for (const ctxAny of parsed.contextAny) {
            const pairs = ctxAny.pairs.map(p => `${p.key}:${p.value}`).join(',');
            contextParts.push(`contextAny(${pairs})`);
          }
          const contextOnlyDSL = contextParts.join('.');
          
          return (
            <div className="window-selector-context-chips" style={{ 
              minWidth: '120px',
              width: 'auto',
              maxWidth: 'min(450px, 40vw)'
            }}>
              <QueryExpressionEditor
                value={contextOnlyDSL}
                onChange={(newContextDSL) => {
                  // Use getLatestGraph() to avoid stale closure
                  const currentGraph = getLatestGraph();
                  if (!setGraph || !currentGraph) return;
                  
                  // Parse to get new contexts
                  const newParsed = parseConstraints(newContextDSL);
                  const oldParsed = parseConstraints(currentGraph.currentQueryDSL || '');
                  
                  // Rebuild DSL with new contexts + old window
                  const newContextParts: string[] = [];
                  for (const ctx of newParsed.context) {
                    newContextParts.push(`context(${ctx.key}:${ctx.value})`);
                  }
                  for (const ctxAny of newParsed.contextAny) {
                    const pairs = ctxAny.pairs.map(p => `${p.key}:${p.value}`).join(',');
                    newContextParts.push(`contextAny(${pairs})`);
                  }
                  
                  // Preserve window
                  let windowPart = '';
                  if (oldParsed.window) {
                    windowPart = `window(${oldParsed.window.start || ''}:${oldParsed.window.end || ''})`;
                  } else if (window) {
                    windowPart = `window(${formatDateUK(window.start)}:${formatDateUK(window.end)})`;
                  }
                  
                  const fullDSL = [newContextParts.join('.'), windowPart].filter(p => p).join('.');
                  
                  // CRITICAL: Update AUTHORITATIVE DSL on graphStore
                  setCurrentDSL(fullDSL || '');
                  
                  // Also update historic record (NOT for live queries!)
                  setGraph({ ...currentGraph, currentQueryDSL: fullDSL || undefined });
                }}
                graph={graph}
                height="32px"
                placeholder=""
              />
            </div>
          );
        })()}
        
        {/* Add Context button */}
        <div className="window-selector-toolbar-button" style={{ position: 'relative', marginLeft: '8px' }}>
          <button
            ref={contextButtonRef}
            className="window-selector-preset"
            onClick={() => setShowContextDropdown(!showContextDropdown)}
            title="Add context filter"
            style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
          >
            <span>+</span>
            <FileText size={14} />
            {(() => {
              // Show "Context" label when no contexts are selected
              const parsed = parseConstraints(graph?.currentQueryDSL || '');
              const hasContexts = parsed.context.length > 0 || parsed.contextAny.length > 0;
              return !hasContexts ? <span>Context</span> : null;
            })()}
          </button>
          
          {showContextDropdown && availableKeySections.length > 0 && (
            <div ref={contextDropdownRef} className="window-selector-dropdown context-dropdown">
              <ContextValueSelector
                mode="multi-key"
                availableKeys={availableKeySections}
                currentValues={currentContextValues}
                currentContextKey={currentContextKey}
                showingAll={showingAllContexts}
                onCreateScenarios={(contextKey, values) => {
                  if (values) {
                    // Create scenarios for specific values immediately
                    createScenariosForContext(contextKey, values);
                    // Keep dropdown open to allow creating more? Or close?
                    // If user clicked "+", they probably want to see the scenario created.
                    // Let's keep it open for multi-creation workflow.
                  } else {
                    // Open bulk creation modal
                    setShowContextDropdown(false);
                    openBulkCreateForContext(contextKey);
                  }
                }}
                onShowAll={async () => {
                  // Load ALL contexts from registry (not just pinned)
                  contextRegistry.clearCache();
                  const keys = await contextRegistry.getAllContextKeys();
                  console.log('[WindowSelector] Loading ALL context keys:', keys);
                  const sections = await Promise.all(
                    keys.map(async key => {
                      const context = await contextRegistry.getContext(key.id);
                      const values = await contextRegistry.getValuesForContext(key.id);
                      return {
                        id: key.id,
                        name: key.id.replace(/_/g, ' ').replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                        values,
                        otherPolicy: context?.otherPolicy
                      };
                    })
                  );
                  setAvailableKeySections(sections);
                  setShowingAllContexts(true);
                  return sections;
                }}
                onApply={async (key, values) => {
                  setShowContextDropdown(false);
                  setShowingAllContexts(false); // Reset for next open
                  
                  // Use getLatestGraph() to avoid stale closure
                  const currentGraph = getLatestGraph();
                  if (!setGraph || !currentGraph) return;
                  
                  // Parse existing DSL to preserve window
                  const parsed = parseConstraints(currentGraph.currentQueryDSL || '');
                  const existingWindow = parsed.window;
                  
                  // Check if all values selected AND key is MECE (should remove context)
                  const keySection = availableKeySections.find(s => s.id === key);
                  const allValues = keySection?.values || [];
                  const allSelected = allValues.length > 0 && values.length === allValues.length;
                  const isMECE = keySection?.otherPolicy !== 'undefined';
                  
                  // Build new context part
                  let contextPart = '';
                  if (values.length > 0 && !(allSelected && isMECE)) {
                    if (values.length === 1) {
                      contextPart = `context(${key}:${values[0]})`;
                    } else {
                      const valuePairs = values.map(v => `${key}:${v}`).join(',');
                      contextPart = `contextAny(${valuePairs})`;
                    }
                  }
                  
                  // Build window part (preserve existing or use current window state)
                  let windowPart = '';
                  if (existingWindow) {
                    windowPart = `window(${existingWindow.start || ''}:${existingWindow.end || ''})`;
                  } else if (window) {
                    windowPart = `window(${formatDateUK(window.start)}:${formatDateUK(window.end)})`;
                  }
                  
                  // Combine
                  const newDSL = [contextPart, windowPart].filter(p => p).join('.');
                  
                  // CRITICAL: Update AUTHORITATIVE DSL on graphStore
                  setCurrentDSL(newDSL || '');
                  
                  // Also update historic record (NOT for live queries!)
                  setGraph({ ...currentGraph, currentQueryDSL: newDSL || undefined });
                  
                  if (allSelected && isMECE) {
                    toast.success('All values selected = no filter', { duration: 2000 });
                  }
                }}
                onCancel={() => {
                  setShowContextDropdown(false);
                  setShowingAllContexts(false); // Reset for next open
                }}
                anchorEl={contextButtonRef.current}
              />
            </div>
          )}
          
          {showContextDropdown && availableKeySections.length === 0 && (
            <div ref={contextDropdownRef} className="window-selector-dropdown context-dropdown">
              <div className="dropdown-message">
                Loading contexts...
              </div>
            </div>
          )}
        </div>
        </div>{/* End context group */}
      </div>
      
      {/* Unrolled state - shows full DSL and pinned query access */}
      {isUnrolled && (
        <div 
          className="window-selector-extended"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <span style={{ fontSize: '12px', color: '#6B7280', fontWeight: 500 }}>Full query:</span>
          <div style={{ flex: 1 }}>
            <QueryExpressionEditor
              value={(() => {
                // Parse current DSL to extract contexts (strip any window)
                const parsed = parseConstraints(graph?.currentQueryDSL || '');
                
                const contextParts: string[] = [];
                for (const ctx of parsed.context) {
                  contextParts.push(`context(${ctx.key}:${ctx.value})`);
                }
                for (const ctxAny of parsed.contextAny) {
                  const pairs = ctxAny.pairs.map(p => `${p.key}:${p.value}`).join(',');
                  contextParts.push(`contextAny(${pairs})`);
                }
                
                // Add current window
                const windowPart = window 
                  ? `window(${formatDateUK(window.start)}:${formatDateUK(window.end)})` 
                  : '';
                
                // Combine
                const parts = [...contextParts, windowPart].filter(p => p);
                return parts.join('.');
              })()}
              readonly={false}
              onChange={(newDSL) => {
                // During editing, just let it update (don't persist yet)
              }}
              onBlur={(finalDSL) => {
                // CRITICAL: Update AUTHORITATIVE DSL on graphStore
                setCurrentDSL(finalDSL || '');
                
                // Also update historic record (NOT for live queries!)
                if (setGraph && graph) {
                  setGraph({ ...graph, currentQueryDSL: finalDSL });
                }
                
                // Also update window state separately for DateRangePicker
                // DSL already uses UK format dates, so we can use them directly
                const parsed = parseConstraints(finalDSL);
                if (parsed.window && setWindow) {
                  setWindow({
                    start: parsed.window.start || window?.start || '',
                    end: parsed.window.end || window?.end || '',
                  });
                }
              }}
              graph={graph}
              height="32px"
              placeholder="No filters applied"
            />
          </div>
          <span style={{ color: '#ccc', fontSize: '18px' }}>│</span>
          <button
            className="window-selector-preset"
            onClick={() => setShowPinnedQueryModal(true)}
            title={graph?.dataInterestsDSL || 'Click to set pinned query'}
            style={{
              padding: '4px 12px',
              background: graph?.dataInterestsDSL ? '#e3f2fd' : '#f5f5f5',
              border: graph?.dataInterestsDSL ? '1px solid #90caf9' : '1px solid #d0d0d0',
              whiteSpace: 'nowrap'
            }}
          >
            Pinned query {graph?.dataInterestsDSL && '✓'}
          </button>
        </div>
      )}
      </div>{/* End window-selector-main */}
      
      {/* Fetch button column (right side) - spans full height */}
      {showButton && (
        <div className="window-selector-fetch-column">
          <button
            onClick={handleFetchData}
            disabled={isCheckingCoverage || isFetching || batchItemsToFetch.length === 0}
            className={`window-selector-button ${showShimmer ? 'shimmer' : ''}`}
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
        </div>
      )}
      
      {/* Unroll toggle - triangle corner */}
      <button
        className={`window-selector-unroll-toggle ${isUnrolled ? 'expanded' : ''}`}
        onClick={() => setIsUnrolled(!isUnrolled)}
        title={isUnrolled ? "Hide full query" : "Show full query DSL"}
      />
      
      {/* Pinned Query Modal */}
      <PinnedQueryModal
        isOpen={showPinnedQueryModal}
        currentDSL={graph?.dataInterestsDSL || ''}
        onSave={(newDSL) => {
          if (setGraph && graph) {
            setGraph({ ...graph, dataInterestsDSL: newDSL });
            toast.success('Pinned query updated');
            // Reload context sections if dropdown is open
            setAvailableKeySections([]);
          }
        }}
        onClose={() => setShowPinnedQueryModal(false)}
      />
      
      {/* Preset context menu */}
      {presetContextMenu && (
        <div
          ref={presetContextMenuRef}
          style={{
            position: 'fixed',
            left: presetContextMenu.x,
            top: presetContextMenu.y,
            background: '#fff',
            border: '1px solid #dee2e6',
            borderRadius: '6px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            zIndex: 10000,
            minWidth: '200px',
            padding: '4px 0'
          }}
        >
          {/* Current period */}
          <button
            onClick={() => handleCreateWindowScenario(presetContextMenu.preset, 0)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              padding: '8px 12px',
              border: 'none',
              background: 'transparent',
              color: '#374151',
              fontSize: '13px',
              textAlign: 'left',
              cursor: 'pointer'
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            Create scenario ({getWindowDSLForPreset(presetContextMenu.preset, 0)})
            <Zap size={12} style={{ color: 'currentColor', marginLeft: 'auto' }} />
          </button>
          
          {/* Previous period */}
          <button
            onClick={() => handleCreateWindowScenario(presetContextMenu.preset, 1)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              padding: '8px 12px',
              border: 'none',
              background: 'transparent',
              color: '#374151',
              fontSize: '13px',
              textAlign: 'left',
              cursor: 'pointer'
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            Create scenario ({getWindowDSLForPreset(presetContextMenu.preset, 1)})
            <Zap size={12} style={{ color: 'currentColor', marginLeft: 'auto' }} />
          </button>
          
          {/* Two periods ago */}
          <button
            onClick={() => handleCreateWindowScenario(presetContextMenu.preset, 2)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              padding: '8px 12px',
              border: 'none',
              background: 'transparent',
              color: '#374151',
              fontSize: '13px',
              textAlign: 'left',
              cursor: 'pointer'
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            Create scenario ({getWindowDSLForPreset(presetContextMenu.preset, 2)})
            <Zap size={12} style={{ color: 'currentColor', marginLeft: 'auto' }} />
          </button>
          
          {/* Separator */}
          <div style={{ height: '1px', background: '#e5e7eb', margin: '4px 0' }} />
          
          {/* Create 4 periods */}
          <button
            onClick={() => handleCreateMultipleWindowScenarios(presetContextMenu.preset, 4)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              padding: '8px 12px',
              border: 'none',
              background: 'transparent',
              color: '#374151',
              fontSize: '13px',
              textAlign: 'left',
              cursor: 'pointer'
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            Create 4 scenarios ({presetContextMenu.preset === 7 ? 'weekly' : presetContextMenu.preset === 30 ? 'monthly' : 'quarterly'})
            <Zap size={12} style={{ color: 'currentColor', marginLeft: 'auto' }} />
          </button>
        </div>
      )}
      
      {/* Bulk scenario creation modal */}
      {bulkCreateModal && (
        <BulkScenarioCreationModal
          isOpen={true}
          contextKey={bulkCreateModal.contextKey}
          values={bulkCreateModal.values}
          onClose={closeBulkCreateModal}
          onCreate={async (selectedValues) => {
            await createScenariosForContext(bulkCreateModal.contextKey, selectedValues);
          }}
        />
      )}
    </div>
  );
}

