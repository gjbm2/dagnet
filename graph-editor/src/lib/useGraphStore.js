import { create } from 'zustand';
export const useGraphStore = create((set) => ({
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
    setCaseOverride: (nodeId, variant) => set((state) => {
        const newCaseOverrides = new Map(state.whatIfOverrides.caseOverrides);
        if (variant === null) {
            newCaseOverrides.delete(nodeId);
        }
        else {
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
    setConditionalOverride: (edgeId, visitedNodes) => set((state) => {
        const newConditionalOverrides = new Map(state.whatIfOverrides.conditionalOverrides);
        if (visitedNodes === null) {
            newConditionalOverrides.delete(edgeId);
        }
        else {
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
    clearAllOverrides: () => set({
        whatIfOverrides: {
            caseOverrides: new Map(),
            conditionalOverrides: new Map(),
            _version: 0,
        },
    }),
}));
