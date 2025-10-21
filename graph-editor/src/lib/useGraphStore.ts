import { create } from 'zustand';
import { Graph } from './types';

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
};

export const useGraphStore = create<State>((set) => ({
  graph: null,
  setGraph: (g) => set({ graph: g }),
  
  // Legacy what-if (maintained for backward compatibility)
  whatIfAnalysis: null,
  setWhatIfAnalysis: (state) => set({ whatIfAnalysis: state }),
  
  // New what-if overrides
  whatIfOverrides: {
    caseOverrides: new Map(),
    conditionalOverrides: new Map(),
  },
  
  setCaseOverride: (nodeId, variant) => 
    set((state) => {
      const newOverrides = { ...state.whatIfOverrides };
      newOverrides.caseOverrides = new Map(state.whatIfOverrides.caseOverrides);
      
      if (variant === null) {
        newOverrides.caseOverrides.delete(nodeId);
      } else {
        newOverrides.caseOverrides.set(nodeId, variant);
      }
      
      return { whatIfOverrides: newOverrides };
    }),
  
  setConditionalOverride: (edgeId, visitedNodes) =>
    set((state) => {
      const newOverrides = { ...state.whatIfOverrides };
      newOverrides.conditionalOverrides = new Map(state.whatIfOverrides.conditionalOverrides);
      
      if (visitedNodes === null) {
        newOverrides.conditionalOverrides.delete(edgeId);
      } else {
        newOverrides.conditionalOverrides.set(edgeId, new Set(visitedNodes));
      }
      
      return { whatIfOverrides: newOverrides };
    }),
  
  clearAllOverrides: () =>
    set({
      whatIfOverrides: {
        caseOverrides: new Map(),
        conditionalOverrides: new Map(),
      },
    }),
}));
