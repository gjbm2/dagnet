import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useTabContext } from './TabContext';

export interface ViewPreferencesState {
  useUniformScaling: boolean;
  massGenerosity: number;
  autoReroute: boolean;
  useSankeyView: boolean;
}

interface ViewPreferencesContextValue extends ViewPreferencesState {
  setUseUniformScaling: (value: boolean) => void;
  setMassGenerosity: (value: number) => void;
  setAutoReroute: (value: boolean) => void;
  setUseSankeyView: (value: boolean) => void;
}

const ViewPreferencesContext = createContext<ViewPreferencesContextValue | null>(null);

export function useViewPreferencesContext(): ViewPreferencesContextValue | null {
  const ctx = useContext(ViewPreferencesContext);
  return ctx;
}

export function ViewPreferencesProvider({ tabId, children }: { tabId?: string; children: React.ReactNode }) {
  const { tabs, operations: tabOps } = useTabContext();
  const myTab = tabs.find(t => t.id === tabId);
  const editorState = myTab?.editorState || {};

  // Local, fast-reacting state mirrors tab editorState; persisted asynchronously
  const [useUniformScaling, setUseUniformScalingLocal] = useState<boolean>(editorState.useUniformScaling ?? false);
  const [massGenerosity, setMassGenerosityLocal] = useState<number>(editorState.massGenerosity ?? 0.5);
  const [autoReroute, setAutoRerouteLocal] = useState<boolean>(editorState.autoReroute ?? true);
  const [useSankeyView, setUseSankeyViewLocal] = useState<boolean>(editorState.useSankeyView ?? false);

  // Sync FROM tab state when it changes externally (tab switch/restore)
  useEffect(() => {
    if (editorState.useUniformScaling !== undefined) setUseUniformScalingLocal(editorState.useUniformScaling);
  }, [editorState.useUniformScaling]);
  useEffect(() => {
    if (editorState.massGenerosity !== undefined) setMassGenerosityLocal(editorState.massGenerosity);
  }, [editorState.massGenerosity]);
  useEffect(() => {
    if (editorState.autoReroute !== undefined) setAutoRerouteLocal(editorState.autoReroute);
  }, [editorState.autoReroute]);
  useEffect(() => {
    if (editorState.useSankeyView !== undefined) setUseSankeyViewLocal(editorState.useSankeyView);
  }, [editorState.useSankeyView]);

  // Setters: update local immediately, persist to tab state asynchronously
  const setUseUniformScaling = (value: boolean) => {
    setUseUniformScalingLocal(value);
    if (tabId) tabOps.updateTabState(tabId, { useUniformScaling: value });
  };
  const setMassGenerosity = (value: number) => {
    setMassGenerosityLocal(value);
    if (tabId) tabOps.updateTabState(tabId, { massGenerosity: value });
  };
  const setAutoReroute = (value: boolean) => {
    setAutoRerouteLocal(value);
    if (tabId) tabOps.updateTabState(tabId, { autoReroute: value });
  };
  const setUseSankeyView = (value: boolean) => {
    setUseSankeyViewLocal(value);
    if (tabId) tabOps.updateTabState(tabId, { useSankeyView: value });
  };

  const value = useMemo<ViewPreferencesContextValue>(() => ({
    useUniformScaling,
    massGenerosity,
    autoReroute,
    useSankeyView,
    setUseUniformScaling,
    setMassGenerosity,
    setAutoReroute,
    setUseSankeyView
  }), [useUniformScaling, massGenerosity, autoReroute, useSankeyView]);

  return (
    <ViewPreferencesContext.Provider value={value}>
      {children}
    </ViewPreferencesContext.Provider>
  );
}


