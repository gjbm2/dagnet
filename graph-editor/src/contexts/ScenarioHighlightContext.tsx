/**
 * ScenarioHighlightContext — tracks which scenario is being hovered in the legend.
 * Edges read this to fade non-matching layers.
 */

import React, { createContext, useContext, useState, useCallback } from 'react';

interface ScenarioHighlightContextValue {
  highlightedScenarioId: string | null;
  setHighlightedScenarioId: (id: string | null) => void;
}

const ScenarioHighlightContext = createContext<ScenarioHighlightContextValue>({
  highlightedScenarioId: null,
  setHighlightedScenarioId: () => {},
});

export function ScenarioHighlightProvider({ children }: { children: React.ReactNode }) {
  const [highlightedScenarioId, setHighlighted] = useState<string | null>(null);
  const setHighlightedScenarioId = useCallback((id: string | null) => setHighlighted(id), []);
  return (
    <ScenarioHighlightContext.Provider value={{ highlightedScenarioId, setHighlightedScenarioId }}>
      {children}
    </ScenarioHighlightContext.Provider>
  );
}

export function useScenarioHighlight() {
  return useContext(ScenarioHighlightContext);
}
