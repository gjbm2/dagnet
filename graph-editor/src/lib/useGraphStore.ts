import { create } from 'zustand';

type State = {
  graph: any | null;
  setGraph: (g: any) => void;
};

export const useGraphStore = create<State>((set) => ({
  graph: null,
  setGraph: (g) => set({ graph: g }),
}));
