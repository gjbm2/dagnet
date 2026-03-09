import React, { createContext, useContext, useMemo, useState } from 'react';

interface ProjectionModeContextValue {
  isProjectionMode: boolean;
  setProjectionMode: (enabled: boolean, opts?: { updateUrl?: boolean }) => void;
  toggleProjectionMode: (opts?: { updateUrl?: boolean }) => void;
  /** `${graphFileId}::${edgeUuid}` — persists the last selected edge across open/close */
  selectedEdgeKey: string | null;
  setSelectedEdgeKey: (key: string | null) => void;
}

const ProjectionModeContext = createContext<ProjectionModeContextValue | null>(null);

function setUrlParam(key: string, enabled: boolean) {
  try {
    const url = new URL(window.location.href);
    if (enabled) url.searchParams.set(key, '1');
    else url.searchParams.delete(key);
    window.history.replaceState({}, document.title, url.toString());
  } catch (e) {
    console.warn('ProjectionMode: Failed to update URL param', e);
  }
}

export function ProjectionModeProvider({ children }: { children: React.ReactNode }) {
  const [isProjectionMode, setIsProjectionMode] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).has('projection');
    } catch {
      return false;
    }
  });

  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);

  const value = useMemo<ProjectionModeContextValue>(() => {
    const setProjectionMode = (enabled: boolean, opts?: { updateUrl?: boolean }) => {
      setIsProjectionMode(enabled);
      if (opts?.updateUrl !== false) setUrlParam('projection', enabled);
    };
    const toggleProjectionMode = (opts?: { updateUrl?: boolean }) => {
      setProjectionMode(!isProjectionMode, opts);
    };
    return { isProjectionMode, setProjectionMode, toggleProjectionMode, selectedEdgeKey, setSelectedEdgeKey };
  }, [isProjectionMode, selectedEdgeKey]);

  return (
    <ProjectionModeContext.Provider value={value}>
      {children}
    </ProjectionModeContext.Provider>
  );
}

export function useProjectionMode(): ProjectionModeContextValue {
  const ctx = useContext(ProjectionModeContext);
  if (!ctx) throw new Error('useProjectionMode must be used within ProjectionModeProvider');
  return ctx;
}
