import React, { createContext, useContext, useRef, useEffect } from 'react';
import { create, StoreApi, UseBoundStore } from 'zustand';
import type { GraphData } from '../types';

/**
 * Graph Store Type
 * Each tab gets its own isolated store instance
 */
export interface GraphStore {
  graph: GraphData | null;
  setGraph: (graph: GraphData) => void;
  
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
      set({ graph });
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
const GraphStoreContext = createContext<GraphStoreHook | null>(null);

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
  // Get or create store for this file
  const store = React.useMemo(() => {
    if (!storeRegistry.has(fileId)) {
      console.log(`GraphStoreProvider: Creating new store for file ${fileId}`);
      storeRegistry.set(fileId, createGraphStore());
    } else {
      console.log(`GraphStoreProvider: Reusing existing store for file ${fileId}`);
    }
    return storeRegistry.get(fileId)!;
  }, [fileId]);
  
  // Track active instances of this file
  const instanceCountRef = useRef(0);
  
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

