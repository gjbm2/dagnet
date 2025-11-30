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
import { FileText } from 'lucide-react';
import { parseConstraints } from '../lib/queryDSL';
import { formatDateUK, parseUKDate } from '../lib/dateFormat';
import toast from 'react-hot-toast';
import './WindowSelector.css';
import { ContextValueSelector } from './ContextValueSelector';
import { contextRegistry } from '../services/contextRegistry';
import { QueryExpressionEditor } from './QueryExpressionEditor';
import { PinnedQueryModal } from './modals/PinnedQueryModal';

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
  windowKey: string; // Normalized window string
  hasMissingData: boolean;
  hasAnyConnection: boolean;
  paramsToAggregate: Array<{ paramId: string; edgeId: string; slot: 'p' | 'cost_gbp' | 'cost_time' }>;
  graphHash: string; // Hash of graph structure to invalidate when graph changes
}

// Module-level cache (scoped to component instance via ref)
const coverageCache = new Map<string, CoverageCacheEntry>();

// Helper to create cache key from normalized window
function getWindowKey(window: DateRange): string {
  return `${window.start}|${window.end}`;
}

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
  const { graph, window, setWindow, setGraph, lastAggregatedWindow, setLastAggregatedWindow } = graphStore;
  // Use getState() in callbacks to avoid stale closure issues
  const getLatestGraph = () => (graphStore as any).getState?.()?.graph ?? graph;
  const { tabs, operations } = useTabContext();
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
      start: defaultStart.toISOString().split('T')[0],
      end: defaultEnd.toISOString().split('T')[0]
    };
  }, []);
  
  // Initialize window state in store if not set
  useEffect(() => {
    if (!window && setWindow) {
      console.log('[WindowSelector] Initializing default window:', defaultWindowDates);
      setWindow(defaultWindowDates);
    }
  }, [window, setWindow, defaultWindowDates]);
  
  // Initialize currentQueryDSL with default window if not set
  const isInitializedRef = useRef(false);
  useEffect(() => {
    if (graph && !graph.currentQueryDSL && !isInitializedRef.current && setGraph) {
      // Use window from store if set, otherwise use defaults
      const windowToUse = window || defaultWindowDates;
      const defaultDSL = `window(${formatDateUK(windowToUse.start)}:${formatDateUK(windowToUse.end)})`;
      console.log('[WindowSelector] Initializing default DSL:', defaultDSL);
      setGraph({ ...graph, currentQueryDSL: defaultDSL });
      isInitializedRef.current = true;
    }
  }, [graph, window, setGraph, defaultWindowDates]); // Dependencies
  
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
  
  const isInitialMountRef = useRef(true);
  const isAggregatingRef = useRef(false); // Track if we're currently aggregating to prevent loops
  const lastAggregatedWindowRef = useRef<DateRange | null>(null); // Track lastAggregatedWindow to avoid dependency loop
  const lastAggregatedDSLRef = useRef<string | null>(null); // Track lastAggregatedDSL (context+window) to detect context changes
  const graphRef = useRef<typeof graph>(graph); // Track graph to avoid dependency loop
  const prevWindowRef = useRef<string | null>(null); // Track previous window for shimmer trigger
  
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
  
  // Sync refs with state (separate effects to avoid triggering aggregation)
  useEffect(() => {
    graphRef.current = graph;
  }, [graph]);
  
  useEffect(() => {
    if (lastAggregatedWindow) {
      const normalized = {
        start: lastAggregatedWindow.start.includes('T') ? lastAggregatedWindow.start : `${lastAggregatedWindow.start}T00:00:00Z`,
        end: lastAggregatedWindow.end.includes('T') ? lastAggregatedWindow.end : `${lastAggregatedWindow.end}T23:59:59Z`,
      };
      lastAggregatedWindowRef.current = normalized;
    } else {
      lastAggregatedWindowRef.current = null;
      lastAggregatedDSLRef.current = null;
    }
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
  
  // Trigger shimmer whenever window changes and fetch is required
  useEffect(() => {
    if (!window) {
      prevWindowRef.current = null;
      return;
    }
    
    const windowKey = `${window.start}|${window.end}`;
    const windowChanged = windowKey !== prevWindowRef.current;
    
    // Update ref
    prevWindowRef.current = windowKey;
    
    // If window changed and button is visible and fetch is required, trigger shimmer
    if (windowChanged && needsFetch && showButton) {
      setShowShimmer(false); // Reset first
      setTimeout(() => {
        setShowShimmer(true);
        setTimeout(() => setShowShimmer(false), 600);
      }, 50);
    }
  }, [window, needsFetch, showButton]);
  
  // Helper to compare windows (normalized to ISO timestamps)
  const windowsMatch = (w1: DateRange | null, w2: DateRange | null): boolean => {
    if (!w1 || !w2) return false;
    // Normalize start dates to T00:00:00Z and end dates to T23:59:59Z
    const normalizeStart = (d: string) => d.includes('T') ? d : (d.includes('Z') ? d : `${d}T00:00:00Z`);
    const normalizeEnd = (d: string) => {
      if (d.includes('T')) {
        // If already has time, check if it's end-of-day (23:59:59)
        if (d.includes('23:59:59')) return d;
        // Otherwise, replace time with 23:59:59
        return d.replace(/T\d{2}:\d{2}:\d{2}/, 'T23:59:59').replace(/T\d{2}:\d{2}:\d{2}\.\d{3}/, 'T23:59:59');
      }
      if (d.includes('Z')) return d.replace(/T\d{2}:\d{2}:\d{2}/, 'T23:59:59').replace(/T\d{2}:\d{2}:\d{2}\.\d{3}/, 'T23:59:59');
      return `${d}T23:59:59Z`;
    };
    return normalizeStart(w1.start) === normalizeStart(w2.start) && normalizeEnd(w1.end) === normalizeEnd(w2.end);
  };
  
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
      
      // Normalize window dates to ISO timestamps for comparison (define once, use everywhere)
      const normalizedWindow: DateRange = {
        start: currentWindow.start.includes('T') ? currentWindow.start : `${currentWindow.start}T00:00:00Z`,
        end: currentWindow.end.includes('T') ? currentWindow.end : `${currentWindow.end}T23:59:59Z`,
      };
      
      // Use ref value for comparison (avoids dependency loop)
      const normalizedLastAggregated: DateRange | null = lastAggregatedWindowRef.current;
      // Use DSL built from authoritative state (window + context)
      const currentDSL = dslFromState;
      const lastDSL = lastAggregatedDSLRef.current || '';
      
      // If current window matches last aggregated window AND DSL matches, no action needed
      // (Context change should trigger re-aggregation even if window is the same)
      if (windowsMatch(normalizedWindow, normalizedLastAggregated) && currentDSL === lastDSL) {
        setNeedsFetch(false);
        return;
      }
      
      // Log when context changed but window didn't
      if (windowsMatch(normalizedWindow, normalizedLastAggregated) && currentDSL !== lastDSL) {
        console.log('[WindowSelector] Context changed (window same), triggering coverage check:', {
          currentDSL,
          lastDSL
        });
      }
      
      // Window differs from last aggregated - check coverage
      setIsCheckingCoverage(true);
      
      // Phase 3: Check cache first
      // CRITICAL: Cache key must include DSL (context) - not just window!
      // Otherwise changing context reuses wrong cached data
      const windowKey = getWindowKey(normalizedWindow);
      const currentGraphHash = getGraphHash(currentGraph);
      const dslKey = dslFromState || ''; // Include context in cache key
      const cacheKey = `${windowKey}|${currentGraphHash}|${dslKey}`;
      const cachedResult = coverageCache.get(cacheKey);
      
      // If cache hit and graph hash matches, use cached result
      if (cachedResult && cachedResult.graphHash === currentGraphHash) {
        console.log(`[WindowSelector] Using cached coverage result for window:`, normalizedWindow);
        setNeedsFetch(cachedResult.hasAnyConnection && cachedResult.hasMissingData);
        
        // If we have params to aggregate and no missing data, trigger aggregation
        if (cachedResult.paramsToAggregate.length > 0 && !cachedResult.hasMissingData) {
          // Reuse aggregation logic from below
          isAggregatingRef.current = true;
          lastAggregatedWindowRef.current = normalizedWindow;
          lastAggregatedDSLRef.current = dslFromState;
          
          try {
            let updatedGraph = currentGraph;
            for (const { paramId, edgeId, slot } of cachedResult.paramsToAggregate) {
              try {
                await dataOperationsService.getParameterFromFile({
                  paramId,
                  edgeId,
                  graph: updatedGraph,
                  setGraph: (g) => { if (g) updatedGraph = g; },
                  window: normalizedWindow,
                  targetSlice: dslFromState, // Pass context filter to isolateSlice
                });
              } catch (error) {
                console.error(`[WindowSelector] Failed to aggregate param ${paramId}:`, error);
              }
            }
            
            if (updatedGraph !== currentGraph) {
              graphRef.current = updatedGraph;
              setGraph(updatedGraph);
            }
            
            setTimeout(() => {
              setLastAggregatedWindow(normalizedWindow);
              isAggregatingRef.current = false;
            }, 0);
          } catch (error) {
            isAggregatingRef.current = false;
            lastAggregatedWindowRef.current = null;
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
      console.log(`[WindowSelector] Computing coverage check for window:`, normalizedWindow);
      
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
                  normalizedWindow,
                  undefined, // querySignature
                  false, // bustCache
                  currentGraph.currentQueryDSL || '' // targetSlice
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
                // No file exists - check if we've already fetched for this window
                // For direct connections, we can't verify data existence, so we check
                // if the current window matches the last aggregated window
                const normalizedLastAggregated = lastAggregatedWindowRef.current;
                if (!normalizedLastAggregated || !windowsMatch(normalizedWindow, normalizedLastAggregated)) {
                  // Window doesn't match last aggregated - need to fetch
                  hasMissingData = true;
                }
                // If window matches last aggregated, assume data exists (don't set hasMissingData)
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
                  // Has connection but no file - check if we've already fetched for this window
                  const normalizedLastAggregated = lastAggregatedWindowRef.current;
                  if (!normalizedLastAggregated || !windowsMatch(normalizedWindow, normalizedLastAggregated)) {
                    // Window doesn't match last aggregated - need to fetch
                    hasMissingData = true;
                  }
                  // If window matches last aggregated, assume data exists (don't set hasMissingData)
                }
              }
            }
          }
        }
        
        // Set needsFetch flag
        setNeedsFetch(hasAnyConnection && hasMissingData);
        
        // Phase 3: Cache the computed result
        const cacheEntry: CoverageCacheEntry = {
          windowKey,
          hasMissingData,
          hasAnyConnection,
          paramsToAggregate: [...paramsToAggregate], // Copy array
          graphHash: currentGraphHash,
        };
        coverageCache.set(cacheKey, cacheEntry);
        console.log(`[WindowSelector] Cached coverage result for window:`, normalizedWindow);
        
        // Auto-aggregate parameters that have all data for this window
        if (paramsToAggregate.length > 0 && !hasMissingData) {
          console.log(`[WindowSelector] Auto-aggregating ${paramsToAggregate.length} parameters for window:`, normalizedWindow);
          
          // Set flag to prevent re-triggering during aggregation
          isAggregatingRef.current = true;
          
          // Update refs IMMEDIATELY to prevent any re-triggering from setGraph calls
          lastAggregatedWindowRef.current = normalizedWindow;
          lastAggregatedDSLRef.current = dslFromState;
          
          try {
            // Batch all graph updates - collect them and apply once at the end
            let updatedGraph = currentGraph;
            
            for (const { paramId, edgeId, slot } of paramsToAggregate) {
              try {
                // Use a local setGraph that accumulates changes without triggering the effect
                await dataOperationsService.getParameterFromFile({
                  paramId,
                  edgeId,
                  graph: updatedGraph,
                  setGraph: (g) => {
                    if (g) updatedGraph = g;
                  },
                  window: normalizedWindow,
                  targetSlice: dslFromState, // Pass context filter to isolateSlice
                });
              } catch (error) {
                console.error(`[WindowSelector] Failed to aggregate param ${paramId}:`, error);
              }
            }
            
            // Apply all graph updates at once (only if graph actually changed)
            // Update ref immediately to prevent re-triggering
            if (updatedGraph !== currentGraph) {
              graphRef.current = updatedGraph;
              setGraph(updatedGraph);
            }
            
            // Update state (deferred to prevent re-triggering)
            setTimeout(() => {
              setLastAggregatedWindow(normalizedWindow);
              isAggregatingRef.current = false;
            }, 0);
          } catch (error) {
            isAggregatingRef.current = false;
            // Reset refs on error
            lastAggregatedWindowRef.current = null;
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
  
  // Helper: Update both window state and currentQueryDSL
  const updateWindowAndDSL = (start: string, end: string) => {
    setWindow({ start, end });
    
    // Use getLatestGraph() to avoid stale closure
    const currentGraph = getLatestGraph();
    
    // Update currentQueryDSL with new window
    if (setGraph && currentGraph) {
      const parsed = parseConstraints(currentGraph.currentQueryDSL || '');
      
      // Build context part
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
      
      setGraph({ ...currentGraph, currentQueryDSL: newDSL });
    }
  };
  
  const handleDateRangeChange = (start: string, end: string) => {
    updateWindowAndDSL(start, end);
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
    
    const newWindow: DateRange = { start: startStr, end: endStr };
    
    // Phase 3: Early short-circuit - skip if functionally same
    if (windowsMatch(newWindow, window)) {
      console.log(`[WindowSelector] Preset ${days} days skipped (window unchanged):`, {
        start: startStr,
        end: endStr,
        currentWindow: window
      });
      return; // No-op: window is functionally the same
    }
    
    console.log(`[WindowSelector] Preset ${days} days:`, {
      start: startStr,
      end: endStr,
      today: new Date().toISOString().split('T')[0],
      includesToday: endStr === new Date().toISOString().split('T')[0],
    });
    
    // IMPORTANT: Update BOTH window state and graph.currentQueryDSL
    updateWindowAndDSL(startStr, endStr);
  };
  
  // Helper to check if current window matches a preset
  const getActivePreset = (): number | 'today' | null => {
    if (!window) return null;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];
    
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    
    // Check if it's "today" preset (start and end are same day, and it's today)
    if (window.start === window.end && window.start === todayStr) {
      return 'today';
    }
    
    // Check if it's "7d" preset (end is yesterday, start is 7 days before)
    const sevenDaysAgo = new Date(yesterday);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    const sevenDaysAgoStr = sevenDaysAgo.toISOString().split('T')[0];
    if (window.end === yesterdayStr && window.start === sevenDaysAgoStr) {
      return 7;
    }
    
    // Check if it's "30d" preset (end is yesterday, start is 30 days before)
    const thirtyDaysAgo = new Date(yesterday);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];
    if (window.end === yesterdayStr && window.start === thirtyDaysAgoStr) {
      return 30;
    }
    
    // Check if it's "90d" preset (end is yesterday, start is 90 days before)
    const ninetyDaysAgo = new Date(yesterday);
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 89);
    const ninetyDaysAgoStr = ninetyDaysAgo.toISOString().split('T')[0];
    if (window.end === yesterdayStr && window.start === ninetyDaysAgoStr) {
      return 90;
    }
    
    return null;
  };
  
  const activePreset = getActivePreset();
  
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
          
          // Check if this parameter needs fetching for the window
          let needsFetchForThis = false;
          if (!paramFile?.data) {
            // No file exists - check if we've already fetched for this window
            // For direct connections, we can't verify data existence, so we check
            // if the current window matches the last aggregated window
            const normalizedLastAggregated = lastAggregatedWindowRef.current;
            if (!normalizedLastAggregated || !windowsMatch(normalizedWindow, normalizedLastAggregated)) {
              // Window doesn't match last aggregated - need to fetch
              needsFetchForThis = true;
            }
            // If window matches last aggregated, assume data exists (don't set needsFetchForThis)
          } else {
            // File exists - check if data is missing for this window
            const incrementalResult = calculateIncrementalFetch(
              paramFile.data,
              normalizedWindow,
              undefined, // querySignature
              false, // bustCache  
              graph?.currentQueryDSL || '' // targetSlice
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
            const effectiveDSL = graph?.currentQueryDSL || '';
            await dataOperationsService.getFromSource({
              objectType: 'parameter',
              objectId: item.objectId,
              targetId: item.targetId,
              graph,
              setGraph: (g) => {
                if (g) setGraph(g);
              },
              paramSlot: item.paramSlot,
              currentDSL: effectiveDSL,  // CRITICAL: Pass DSL so fetch uses correct window
              targetSlice: effectiveDSL  // CRITICAL: Pass DSL so file loading uses correct slice
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
              currentDSL: graph?.currentQueryDSL || '',  // CRITICAL: Pass DSL for cases too
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
      // Update lastAggregatedWindow after successful fetch
      if (successCount > 0) {
        setLastAggregatedWindow(normalizedWindow);
      }
      
      // Trigger coverage check by updating window (will detect if still needs fetch)
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
            className={`window-selector-preset ${activePreset === 7 ? 'active' : ''}`}
            title="Last 7 days"
          >
            7d
          </button>
          <button
            type="button"
            onClick={() => handlePreset(30)}
            className={`window-selector-preset ${activePreset === 30 ? 'active' : ''}`}
            title="Last 30 days"
          >
            30d
          </button>
          <button
            type="button"
            onClick={() => handlePreset(90)}
            className={`window-selector-preset ${activePreset === 90 ? 'active' : ''}`}
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
                // On blur, persist the full DSL
                if (setGraph && graph) {
                  setGraph({ ...graph, currentQueryDSL: finalDSL });
                }
                
                // Also update window state separately for DateRangePicker
                const parsed = parseConstraints(finalDSL);
                if (parsed.window && setWindow) {
                  try {
                    const startDate = parsed.window.start 
                      ? parseUKDate(parsed.window.start).toISOString().split('T')[0]
                      : window?.start || '';
                    const endDate = parsed.window.end
                      ? parseUKDate(parsed.window.end).toISOString().split('T')[0]
                      : window?.end || '';
                    setWindow({ start: startDate, end: endDate });
                  } catch (err) {
                    console.error('Failed to parse window dates:', err);
                  }
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
    </div>
  );
}

