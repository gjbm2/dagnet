import { create } from 'zustand';

type WhatIfState = {
  caseNodeId: string;
  selectedVariant: string;
} | null;

type State = {
  graph: any | null;
  setGraph: (g: any) => void;
  whatIfAnalysis: WhatIfState;
  setWhatIfAnalysis: (state: WhatIfState) => void;
};

export const useGraphStore = create<State>((set) => ({
  graph: null,
  setGraph: (g) => set({ graph: g }),
  whatIfAnalysis: null,
  setWhatIfAnalysis: (state) => set({ whatIfAnalysis: state }),
}));
