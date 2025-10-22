import { create } from 'zustand';
import { Graph } from './types';
import { graphHistoryService, HistoryState } from '../services/graphHistoryService';

// Legacy single case what-if state (kept for backward compatibility)
type LegacyWhatIfState = {
  caseNodeId: string;
  selectedVariant: string;
} | null;

// New multi-selection what-if state
type WhatIfOverrides = {
  // Case node overrides: nodeId -> selected variant name
  caseOverrides: Map<string, string>;
  
  // Conditional edge overrides: edgeId -> set of visited node IDs
  conditionalOverrides: Map<string, Set<string>>;
  
  // Version counter to force re-renders (Zustand doesn't detect Map changes well)
  _version: number;
};

type State = {
  graph: Graph | null;
  setGraph: (g: Graph | null) => void;
  
  // Legacy what-if analysis (for backward compatibility with existing Quick View)
  whatIfAnalysis: LegacyWhatIfState;
  setWhatIfAnalysis: (state: LegacyWhatIfState) => void;
  
  // New what-if overrides (multi-selection per-element)
  whatIfOverrides: WhatIfOverrides;
  setCaseOverride: (nodeId: string, variant: string | null) => void;
  setConditionalOverride: (edgeId: string, visitedNodes: Set<string> | null) => void;
  clearAllOverrides: () => void;
  
  // History/Undo-Redo functionality
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  saveHistoryState: (action: string, nodeId?: string, edgeId?: string) => void;
  getHistoryStats: () => any;
  updateHistoryState: () => void; // Update UI state for undo/redo buttons
};

export const useGraphStore = create<State>((set) => ({
  graph: null,
  setGraph: (g) => set({ graph: g }),
  
  // Legacy what-if (maintained for backward compatibility)
  whatIfAnalysis: null,
  setWhatIfAnalysis: (state) => set((prevState) => ({ 
    whatIfAnalysis: state,
    // Increment version so edge widths update when legacy what-if changes
    whatIfOverrides: {
      ...prevState.whatIfOverrides,
      _version: prevState.whatIfOverrides._version + 1
    }
  })),
  
  // New what-if overrides
  whatIfOverrides: {
    caseOverrides: new Map(),
    conditionalOverrides: new Map(),
    _version: 0,
  },
  
  setCaseOverride: (nodeId, variant) => 
    set((state) => {
      const newCaseOverrides = new Map(state.whatIfOverrides.caseOverrides);
      
      if (variant === null) {
        newCaseOverrides.delete(nodeId);
      } else {
        newCaseOverrides.set(nodeId, variant);
      }
      
      return { 
        whatIfOverrides: {
          caseOverrides: newCaseOverrides,
          conditionalOverrides: state.whatIfOverrides.conditionalOverrides,
          _version: state.whatIfOverrides._version + 1,
        }
      };
    }),
  
  setConditionalOverride: (edgeId, visitedNodes) =>
    set((state) => {
      const newConditionalOverrides = new Map(state.whatIfOverrides.conditionalOverrides);
      
      if (visitedNodes === null) {
        newConditionalOverrides.delete(edgeId);
      } else {
        newConditionalOverrides.set(edgeId, new Set(visitedNodes));
      }
      
      return { 
        whatIfOverrides: {
          caseOverrides: state.whatIfOverrides.caseOverrides,
          conditionalOverrides: newConditionalOverrides,
          _version: state.whatIfOverrides._version + 1,
        }
      };
    }),
  
  clearAllOverrides: () =>
    set({
      whatIfOverrides: {
        caseOverrides: new Map(),
        conditionalOverrides: new Map(),
        _version: 0,
      },
    }),
  
  // History/Undo-Redo functionality
  canUndo: false,
  canRedo: false,
  
  undo: () => {
    const previousGraph = graphHistoryService.undo();
    if (previousGraph) {
      set({ 
        graph: previousGraph,
        canUndo: graphHistoryService.canUndo(),
        canRedo: graphHistoryService.canRedo()
      });
    }
  },
  
  redo: () => {
    const nextGraph = graphHistoryService.redo();
    if (nextGraph) {
      set({ 
        graph: nextGraph,
        canUndo: graphHistoryService.canUndo(),
        canRedo: graphHistoryService.canRedo()
      });
    }
  },
  
  saveHistoryState: (action, nodeId, edgeId) => {
    console.log('saveHistoryState called with:', action, nodeId, edgeId);
    const state = useGraphStore.getState();
    if (state.graph) {
      console.log('Saving history state:', action, 'canUndo before:', graphHistoryService.canUndo());
      graphHistoryService.saveState(state.graph, action, nodeId, edgeId);
      console.log('canUndo after:', graphHistoryService.canUndo());
      set({
        canUndo: graphHistoryService.canUndo(),
        canRedo: graphHistoryService.canRedo()
      });
    } else {
      console.log('No graph to save history for');
    }
  },
  
  getHistoryStats: () => graphHistoryService.getStats(),
  
  // Update history state (call this when graph changes)
  updateHistoryState: () => {
    set({
      canUndo: graphHistoryService.canUndo(),
      canRedo: graphHistoryService.canRedo()
    });
  },
}));