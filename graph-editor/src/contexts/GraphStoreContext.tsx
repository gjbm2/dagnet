import React, { createContext, useContext, useRef, useEffect } from 'react';
import { create, StoreApi, UseBoundStore } from 'zustand';
import type { GraphData } from '../types';
import { useTabContext, fileRegistry } from './TabContext';
import { db } from '../db/appDatabase';
import { parseDate } from '../services/windowAggregationService';
import { parseConstraints } from '../lib/queryDSL';

/**
 * DateRange normalization and equality
 * Phase 2: Robust equality checks to prevent persistence loops
 */
type DateRange = { start: string; end: string } | null;

function normalizeDateRange(window: DateRange): DateRange {
  if (!window) return null;
  
  // Helper: Convert any date format (UK or ISO) to proper ISO format with time suffix
  // CRITICAL: UK dates like "1-Nov-25" must become "2025-11-01T00:00:00Z", not "1-Nov-25T00:00:00Z"
  const normalizeStart = (d: string) => {
    if (d.includes('T')) return d;
    const isoDate = parseDate(d).toISOString().split('T')[0];
    return `${isoDate}T00:00:00Z`;
  };
  
  const normalizeEnd = (d: string) => {
    if (d.includes('T')) {
      // If already has time, ensure it's end-of-day
      if (d.includes('23:59:59')) return d;
      // Replace time with 23:59:59
      return d.replace(/T\d{2}:\d{2}:\d{2}(\.\d{3})?/, 'T23:59:59').replace(/T\d{2}:\d{2}:\d{2}\.\d{3}/, 'T23:59:59');
    }
    const isoDate = parseDate(d).toISOString().split('T')[0];
    return `${isoDate}T23:59:59Z`;
  };
  
  return {
    start: normalizeStart(window.start),
    end: normalizeEnd(window.end)
  };
}

function dateRangesEqual(a: DateRange, b: DateRange): boolean {
  if (a === b) return true; // Same reference or both null
  if (!a || !b) return false; // One is null, other isn't
  
  const normalizedA = normalizeDateRange(a);
  const normalizedB = normalizeDateRange(b);
  
  if (!normalizedA || !normalizedB) return false; // Shouldn't happen if a and b are non-null, but TypeScript needs this
  
  return normalizedA.start === normalizedB.start && normalizedA.end === normalizedB.end;
}

/**
 * Graph Store Type
 * Each tab gets its own isolated store instance
 */
export interface GraphStore {
  graph: GraphData | null;
  setGraph: (graph: GraphData) => void;
  
  // Auto-update flag (for animation suppression)
  isAutoUpdating: boolean;
  setAutoUpdating: (updating: boolean) => void;
  
  // Window selector state (for data fetching)
  window: { start: string; end: string } | null;
  setWindow: (window: { start: string; end: string } | null) => void;
  
  // Last window that data was aggregated for (to detect if window changed due to time passing)
  lastAggregatedWindow: { start: string; end: string } | null;
  setLastAggregatedWindow: (window: { start: string; end: string } | null) => void;
  
  /**
   * AUTHORITATIVE current query DSL for ALL fetch operations.
   * This is the SINGLE SOURCE OF TRUTH - maintained by WindowSelector.
   * NEVER read from graph.currentQueryDSL for live queries!
   * graph.currentQueryDSL is ONLY for historical record.
   */
  currentDSL: string;
  setCurrentDSL: (dsl: string) => void;
  
  // History
  history: GraphData[];
  historyIndex: number;
  canUndo: boolean;
  canRedo: boolean;
  saveHistoryState: (action?: string, nodeId?: string, edgeId?: string) => void;
  undo: () => void;
  redo: () => void;
  resetHistory: () => void;
  
}

// Type for the Zustand store with all its methods
export type GraphStoreHook = UseBoundStore<StoreApi<GraphStore>>;

/**
 * Create a new graph store instance
 */
export function createGraphStore(): GraphStoreHook {
  return create<GraphStore>((set, get) => ({
    // Graph data
    graph: null,
    setGraph: (graph: GraphData) => {
      // On initial load, hydrate the AUTHORITATIVE DSL from the graph's persisted DSL.
      // This ensures any early startup logic (planner/fetch) sees the correct DSL
      // even before WindowSelector mounts.
      //
      // NOTE: We still treat store.currentDSL as the source of truth during runtime;
      // this is a one-way bootstrapping step only (we don't overwrite non-empty currentDSL).
      const { currentDSL, window: currentWindow } = get();
      const isBootstrap = !currentDSL && !!graph?.currentQueryDSL;

      if (!isBootstrap) {
        set({ graph });
        return;
      }

      const nextDSL = graph.currentQueryDSL as string;

      // Also hydrate the WindowSelector's window state from the persisted DSL,
      // otherwise the UI will render a default "last 7 days" window and appear to ignore
      // the graph's stored DSL on load.
      const parsed = parseConstraints(nextDSL);
      const range = parsed.cohort ?? parsed.window;
      const nextWindow =
        range?.start && range?.end
          ? { start: range.start, end: range.end }
          : currentWindow;

      set({ graph, currentDSL: nextDSL, window: nextWindow });
    },
    
    // Auto-update flag
    isAutoUpdating: false,
    setAutoUpdating: (updating: boolean) => {
      set({ isAutoUpdating: updating });
    },
    
    // Window selector state
    window: null,
    setWindow: (window: { start: string; end: string } | null) => {
      set({ window });
      // Persist to localStorage (keyed by fileId, which is available via closure in GraphStoreProvider)
      // Note: We'll save this in the provider effect since fileId isn't available here
    },
    
    // Last aggregated window
    lastAggregatedWindow: null,
    setLastAggregatedWindow: (lastAggregatedWindow: { start: string; end: string } | null) => {
      set({ lastAggregatedWindow });
    },
    
    // AUTHORITATIVE current DSL - maintained by WindowSelector
    // This is the SINGLE source of truth for all fetch operations
    currentDSL: '',
    setCurrentDSL: (currentDSL: string) => {
      set({ currentDSL });
    },
    
    // History management
    history: [],
    historyIndex: -1,
    canUndo: false,
    canRedo: false,
    
    saveHistoryState: (action?: string, nodeId?: string, edgeId?: string) => {
      const { graph, history, historyIndex } = get();
      if (!graph) {
        console.log('GraphStore: saveHistoryState - no graph');
        return;
      }
      
      // Remove any redo states
      const newHistory = history.slice(0, historyIndex + 1);
      
      // Add current state
      newHistory.push(JSON.parse(JSON.stringify(graph)));
      
      // Limit history to 20 states
      const MAX_HISTORY = 20;
      if (newHistory.length > MAX_HISTORY) {
        newHistory.shift();
      }
      
      const newState = {
        history: newHistory,
        historyIndex: newHistory.length - 1,
        canUndo: newHistory.length > 1,
        canRedo: false
      };
      
      console.log('GraphStore: saveHistoryState', {
        action,
        nodeId,
        edgeId,
        historyLength: newHistory.length,
        historyIndex: newState.historyIndex,
        canUndo: newState.canUndo,
        canRedo: newState.canRedo
      });
      
      set(newState);
    },
    
    undo: () => {
      const { history, historyIndex } = get();
      console.log('GraphStore: undo', { historyIndex, historyLength: history.length });
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1;
        const newState = {
          graph: JSON.parse(JSON.stringify(history[newIndex])),
          historyIndex: newIndex,
          canUndo: newIndex > 0,
          canRedo: true
        };
        console.log('GraphStore: undo applied', { newIndex, canUndo: newState.canUndo, canRedo: newState.canRedo });
        set(newState);
      }
    },
    
    redo: () => {
      const { history, historyIndex } = get();
      if (historyIndex < history.length - 1) {
        const newIndex = historyIndex + 1;
        set({
          graph: JSON.parse(JSON.stringify(history[newIndex])),
          historyIndex: newIndex,
          canUndo: true,
          canRedo: newIndex < history.length - 1
        });
      }
    },
    
    resetHistory: () => {
      console.log('GraphStore: Resetting history');
      set({
        history: [],
        historyIndex: -1,
        canUndo: false,
        canRedo: false
      });
    },
    
  }));
}

/**
 * Context for graph store
 */
// Create a React Context for the store hook (not the state)
export const GraphStoreContext = createContext<GraphStoreHook | null>(null);

/**
 * Global registry of stores per file
 * This ensures multiple tabs viewing the same file share the same store
 */
const storeRegistry = new Map<string, GraphStoreHook>();

/**
 * Force cleanup of a store for a specific file
 * Used when user discards changes to a file
 */
export function cleanupGraphStore(fileId: string): void {
  const store = storeRegistry.get(fileId);
  if (store) {
    console.log(`GraphStoreContext: Force cleaning up store for ${fileId}`);
    store.setState({ 
      graph: null,
      history: []
    });
    storeRegistry.delete(fileId);
  }
}

/**
 * Get the graph store for a specific file
 * Used by menu bar and other global components to access active tab's store
 */
export function getGraphStore(fileId: string): GraphStoreHook | null {
  return storeRegistry.get(fileId) || null;
}

/**
 * Graph Store Provider
 * Creates one store instance per FILE (not per tab)
 * Multiple tabs opening the same file will share the same store
 */
export function GraphStoreProvider({ 
  children,
  fileId 
}: { 
  children: React.ReactNode;
  fileId: string;
}) {
  const { tabs, operations: tabOps } = useTabContext();
  
  // Get or create store for this file
  const store = React.useMemo(() => {
    if (!storeRegistry.has(fileId)) {
      console.log(`GraphStoreProvider: Creating new store for file ${fileId}`);
      const newStore = createGraphStore();
      storeRegistry.set(fileId, newStore);
    } else {
      console.log(`GraphStoreProvider: Reusing existing store for file ${fileId}`);
    }
    return storeRegistry.get(fileId)!;
  }, [fileId]);
  
  // Load persisted window state from any tab's editorState (IndexedDB)
  // Phase 2: Add loop guards to prevent reload loops
  // Track what we've loaded to prevent reload loops when tabs change due to persistence
  const lastLoadedWindowRef = useRef<DateRange>(null);
  const lastLoadedLastAggregatedWindowRef = useRef<DateRange>(null);
  
  useEffect(() => {
    const loadWindowFromTabs = async () => {
      // If the graph has a persisted DSL (or we've already bootstrapped currentDSL from it),
      // we intentionally DO NOT override the store's window from tab persistence.
      // The graph's DSL is the source of truth on load; tab window persistence is only a
      // convenience fallback for graphs that have no stored DSL yet.
      const stateAtStart = store.getState();
      const hasGraphDSL = Boolean(stateAtStart.graph?.currentQueryDSL && String(stateAtStart.graph.currentQueryDSL).trim());
      const hasBootstrappedDSL = Boolean(stateAtStart.currentDSL && String(stateAtStart.currentDSL).trim());
      if (hasGraphDSL || hasBootstrappedDSL) {
        return;
      }

      // Find any tab for this fileId
      const fileTabs = tabs.filter(t => t.fileId === fileId);
      if (fileTabs.length > 0) {
        const firstTab = fileTabs[0];
        const savedWindow = firstTab.editorState?.window;
        const savedLastAggregatedWindow = firstTab.editorState?.lastAggregatedWindow;
        
        // Phase 2: Only load if different from current AND different from what we last loaded (loop guard)
        const currentWindow = store.getState().window;
        const currentLastAggregatedWindow = store.getState().lastAggregatedWindow;
        
        if (savedWindow !== undefined) {
          // Check if it's different from current AND different from what we last loaded
          const isDifferentFromCurrent = !dateRangesEqual(savedWindow, currentWindow);
          const isDifferentFromLastLoaded = !dateRangesEqual(savedWindow, lastLoadedWindowRef.current);
          
          if (isDifferentFromCurrent && isDifferentFromLastLoaded) {
            store.setState({ window: savedWindow });
            lastLoadedWindowRef.current = savedWindow;
            console.log(`GraphStoreProvider: Loaded persisted window for ${fileId} from tab ${firstTab.id}:`, savedWindow);
          } else {
            console.log(`GraphStoreProvider: Skipped loading window (matches current or last loaded):`, savedWindow);
          }
        }
        
        if (savedLastAggregatedWindow !== undefined) {
          const isDifferentFromCurrent = !dateRangesEqual(savedLastAggregatedWindow, currentLastAggregatedWindow);
          const isDifferentFromLastLoaded = !dateRangesEqual(savedLastAggregatedWindow, lastLoadedLastAggregatedWindowRef.current);
          
          if (isDifferentFromCurrent && isDifferentFromLastLoaded) {
            store.setState({ lastAggregatedWindow: savedLastAggregatedWindow });
            lastLoadedLastAggregatedWindowRef.current = savedLastAggregatedWindow;
            console.log(`GraphStoreProvider: Loaded persisted lastAggregatedWindow for ${fileId} from tab ${firstTab.id}:`, savedLastAggregatedWindow);
          } else {
            console.log(`GraphStoreProvider: Skipped loading lastAggregatedWindow (matches current or last loaded):`, savedLastAggregatedWindow);
          }
        }
      } else {
        // No tabs yet - try loading from IndexedDB directly
        try {
          const dbTabs = await db.getTabsForFile(fileId);
          if (dbTabs.length > 0) {
            const savedWindow = dbTabs[0].editorState?.window;
            const savedLastAggregatedWindow = dbTabs[0].editorState?.lastAggregatedWindow;
            
            const currentWindow = store.getState().window;
            const currentLastAggregatedWindow = store.getState().lastAggregatedWindow;
            
            if (savedWindow !== undefined) {
              const isDifferentFromCurrent = !dateRangesEqual(savedWindow, currentWindow);
              const isDifferentFromLastLoaded = !dateRangesEqual(savedWindow, lastLoadedWindowRef.current);
              
              if (isDifferentFromCurrent && isDifferentFromLastLoaded) {
                store.setState({ window: savedWindow });
                lastLoadedWindowRef.current = savedWindow;
                console.log(`GraphStoreProvider: Loaded persisted window for ${fileId} from IndexedDB:`, savedWindow);
              }
            }
            if (savedLastAggregatedWindow !== undefined) {
              const isDifferentFromCurrent = !dateRangesEqual(savedLastAggregatedWindow, currentLastAggregatedWindow);
              const isDifferentFromLastLoaded = !dateRangesEqual(savedLastAggregatedWindow, lastLoadedLastAggregatedWindowRef.current);
              
              if (isDifferentFromCurrent && isDifferentFromLastLoaded) {
                store.setState({ lastAggregatedWindow: savedLastAggregatedWindow });
                lastLoadedLastAggregatedWindowRef.current = savedLastAggregatedWindow;
                console.log(`GraphStoreProvider: Loaded persisted lastAggregatedWindow for ${fileId} from IndexedDB:`, savedLastAggregatedWindow);
              }
            }
          }
        } catch (e) {
          console.warn(`GraphStoreProvider: Failed to load window from IndexedDB for ${fileId}:`, e);
        }
      }
    };
    
    loadWindowFromTabs();
  }, [fileId, tabs, store]);
  
  // Track active instances of this file
  const instanceCountRef = useRef(0);
  
  // Phase 2: Centralized debounced persistence with equality checks and loop guards
  const persistDebounceTimerRef = useRef<number | null>(null);
  const lastPersistedWindowRef = useRef<DateRange>(null);
  const lastPersistedLastAggregatedWindowRef = useRef<DateRange>(null);
  
  // Subscribe to window changes and persist to all tabs' editorState (IndexedDB)
  // Phase 2: Debounced, with equality checks and loop guards
  useEffect(() => {
    const unsubscribe = store.subscribe(async (state) => {
      const currentWindow = state.window;
      const currentLastAggregatedWindow = state.lastAggregatedWindow;
      
      // Phase 2: Check equality before persisting (prevents unnecessary writes)
      const windowChanged = !dateRangesEqual(currentWindow, lastPersistedWindowRef.current);
      const lastAggregatedChanged = !dateRangesEqual(currentLastAggregatedWindow, lastPersistedLastAggregatedWindowRef.current);
      
      if (windowChanged || lastAggregatedChanged) {
        // Clear existing debounce timer
        if (persistDebounceTimerRef.current) {
          clearTimeout(persistDebounceTimerRef.current);
        }
        
        // Debounce persistence (500ms)
        persistDebounceTimerRef.current = window.setTimeout(async () => {
          // ATOMIC RESTORATION: Check if we're in atomic restore window
          // If so, defer persistence to avoid triggering tab updates during restoration
          try {
            const w = (typeof window !== 'undefined') ? (window as any) : null;
            if (w && w.__DAGNET_ATOMIC_RESTORE_ACTIVE) {
              console.log('[ATOMIC GUARD] GraphStoreProvider persistence blocked during atomic restore');
              // Defer persistence using setTimeout so it runs after flushSync completes
              persistDebounceTimerRef.current = window.setTimeout(async () => {
                // Run this block again after atomic window closes
                const finalWindow = store.getState().window;
                const finalLastAggregatedWindow = store.getState().lastAggregatedWindow;
                
                const stillWindowChanged = !dateRangesEqual(finalWindow, lastPersistedWindowRef.current);
                const stillLastAggregatedChanged = !dateRangesEqual(finalLastAggregatedWindow, lastPersistedLastAggregatedWindowRef.current);
                
                if (stillWindowChanged) {
                  const fileTabs = tabs.filter(t => t.fileId === fileId);
                  if (fileTabs.length > 0) {
                    console.log(`GraphStoreProvider: Persisting window (deferred) for ${fileId}:`, finalWindow);
                    lastPersistedWindowRef.current = finalWindow;
                    await Promise.all(
                      fileTabs.map(tab => 
                        tabOps.updateTabState(tab.id, { window: finalWindow })
                      )
                    );
                  }
                }
                
                if (stillLastAggregatedChanged) {
                  const fileTabs = tabs.filter(t => t.fileId === fileId);
                  if (fileTabs.length > 0) {
                    console.log(`GraphStoreProvider: Persisting lastAggregatedWindow (deferred) for ${fileId}:`, finalLastAggregatedWindow);
                    lastPersistedLastAggregatedWindowRef.current = finalLastAggregatedWindow;
                    await Promise.all(
                      fileTabs.map(tab => 
                        tabOps.updateTabState(tab.id, { lastAggregatedWindow: finalLastAggregatedWindow })
                      )
                    );
                  }
                }
                
                persistDebounceTimerRef.current = null;
              }, 100);
              return;
            }
          } catch {
            // best-effort guards only
          }
          
          const finalWindow = store.getState().window;
          const finalLastAggregatedWindow = store.getState().lastAggregatedWindow;
          
          // Phase 2: Final equality check (state may have changed during debounce)
          const stillWindowChanged = !dateRangesEqual(finalWindow, lastPersistedWindowRef.current);
          const stillLastAggregatedChanged = !dateRangesEqual(finalLastAggregatedWindow, lastPersistedLastAggregatedWindowRef.current);
          
          if (stillWindowChanged) {
            // Update all tabs for this fileId
            const fileTabs = tabs.filter(t => t.fileId === fileId);
            if (fileTabs.length > 0) {
              console.log(`GraphStoreProvider: Persisting window for ${fileId} to ${fileTabs.length} tabs:`, finalWindow);
              lastPersistedWindowRef.current = finalWindow;
              await Promise.all(
                fileTabs.map(tab => 
                  tabOps.updateTabState(tab.id, { window: finalWindow })
                )
              );
            }
          }
          
          if (stillLastAggregatedChanged) {
            // Update all tabs for this fileId
            const fileTabs = tabs.filter(t => t.fileId === fileId);
            if (fileTabs.length > 0) {
              console.log(`GraphStoreProvider: Persisting lastAggregatedWindow for ${fileId} to ${fileTabs.length} tabs:`, finalLastAggregatedWindow);
              lastPersistedLastAggregatedWindowRef.current = finalLastAggregatedWindow;
              await Promise.all(
                fileTabs.map(tab => 
                  tabOps.updateTabState(tab.id, { lastAggregatedWindow: finalLastAggregatedWindow })
                )
              );
            }
          }
          
          persistDebounceTimerRef.current = null;
        }, 500);
      }
    });
    
    return () => {
      unsubscribe();
      if (persistDebounceTimerRef.current) {
        clearTimeout(persistDebounceTimerRef.current);
      }
    };
  }, [store, fileId, tabs, tabOps]);
  
  // Subscribe to graph changes and sync to FileRegistry (marks file dirty)
  // This ensures ALL graph changes (node moves, edits, etc.) are tracked for commit
  const lastSyncedGraphRef = useRef<string | null>(null);
  const graphSyncDebounceRef = useRef<number | null>(null);
  
  useEffect(() => {
    const unsubscribeGraph = store.subscribe((state) => {
      const currentGraph = state.graph;
      if (!currentGraph) return;
      
      const currentGraphStr = JSON.stringify(currentGraph);
      
      // Skip if unchanged
      if (currentGraphStr === lastSyncedGraphRef.current) return;
      
      // Debounce to avoid excessive updates during rapid changes (e.g., dragging)
      if (graphSyncDebounceRef.current) {
        clearTimeout(graphSyncDebounceRef.current);
      }
      
      graphSyncDebounceRef.current = window.setTimeout(async () => {
        const finalGraph = store.getState().graph;
        if (!finalGraph) return;
        
        const finalGraphStr = JSON.stringify(finalGraph);
        if (finalGraphStr === lastSyncedGraphRef.current) return;
        
        lastSyncedGraphRef.current = finalGraphStr;
        
        // Update FileRegistry to mark file as dirty
        await fileRegistry.updateFile(fileId, finalGraph);
        console.log(`GraphStoreProvider: Synced graph changes to FileRegistry for ${fileId}`);
        
        graphSyncDebounceRef.current = null;
      }, 100); // 100ms debounce for graph changes
    });
    
    return () => {
      unsubscribeGraph();
      if (graphSyncDebounceRef.current) {
        clearTimeout(graphSyncDebounceRef.current);
      }
    };
  }, [store, fileId]);
  
  useEffect(() => {
    instanceCountRef.current++;
    const currentCount = instanceCountRef.current;
    console.log(`GraphStoreProvider: Instance mounted for ${fileId} (count: ${currentCount})`);
    
    return () => {
      instanceCountRef.current--;
      const remainingCount = instanceCountRef.current;
      console.log(`GraphStoreProvider: Instance unmounted for ${fileId} (remaining: ${remainingCount})`);
      
      // If this was the last instance, cleanup the store after a delay
      // (delay allows for quick tab switches without losing state)
      if (remainingCount === 0) {
        setTimeout(() => {
          if (instanceCountRef.current === 0) {
            console.log(`GraphStoreProvider: Cleaning up store for ${fileId}`);
            const storeToClean = storeRegistry.get(fileId);
            if (storeToClean) {
              // CRITICAL: Delete from registry FIRST to prevent race condition
              // where new instance tries to reuse the store while we're clearing it
              storeRegistry.delete(fileId);
              
              // Then clean up the store state
              storeToClean.setState({ 
                graph: null,
                history: []
              });
            }
          }
        }, 1000); // 1 second grace period
      }
    };
  }, [fileId]);
  
  return (
    <GraphStoreContext.Provider value={store}>
      {children}
    </GraphStoreContext.Provider>
  );
}

/**
 * Use Graph Store hook
 * Must be used within GraphStoreProvider
 * 
 * Returns a Zustand store hook with all methods (.getState(), .setState(), etc.)
 */
export function useGraphStore<T = GraphStore>(
  selector?: (state: GraphStore) => T
): T & GraphStoreHook {
  const store = useContext(GraphStoreContext);
  if (!store) {
    throw new Error('useGraphStore must be used within GraphStoreProvider');
  }
  
  // If called with a selector, use the selector
  if (selector) {
    return store(selector) as any;
  }
  
  // If called without selector, return the store state
  // BUT also attach the store methods (.getState, .setState, etc.) as properties
  const state = store();
  const extendedState = state as any;
  
  // Attach store methods
  extendedState.getState = store.getState;
  extendedState.setState = store.setState;
  extendedState.subscribe = store.subscribe;
  extendedState.destroy = store.destroy;
  
  return extendedState;
}

