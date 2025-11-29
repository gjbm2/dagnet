import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useTabContext } from './TabContext';

export interface ViewPreferencesState {
  useUniformScaling: boolean;
  massGenerosity: number;
  autoReroute: boolean;
  useSankeyView: boolean;
  confidenceIntervalLevel: 'none' | '80' | '90' | '95' | '99';
  animateFlow: boolean;
}

interface ViewPreferencesContextValue extends ViewPreferencesState {
  setUseUniformScaling: (value: boolean) => void;
  setMassGenerosity: (value: number) => void;
  setAutoReroute: (value: boolean) => void;
  setUseSankeyView: (value: boolean) => void;
  setConfidenceIntervalLevel: (value: 'none' | '80' | '90' | '95' | '99') => void;
  setAnimateFlow: (value: boolean) => void;
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
  const [confidenceIntervalLevel, setConfidenceIntervalLevelLocal] = useState<'none' | '80' | '90' | '95' | '99'>(
    (editorState.confidenceIntervalLevel as 'none' | '80' | '90' | '95' | '99') ?? 'none'
  );
  const [animateFlow, setAnimateFlowLocal] = useState<boolean>(editorState.animateFlow ?? true);

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
  useEffect(() => {
    if (editorState.confidenceIntervalLevel !== undefined) {
      setConfidenceIntervalLevelLocal(editorState.confidenceIntervalLevel as 'none' | '80' | '90' | '95' | '99');
    }
  }, [editorState.confidenceIntervalLevel]);
  useEffect(() => {
    if (editorState.animateFlow !== undefined) setAnimateFlowLocal(editorState.animateFlow);
  }, [editorState.animateFlow]);

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
  const setConfidenceIntervalLevel = (value: 'none' | '80' | '90' | '95' | '99') => {
    setConfidenceIntervalLevelLocal(value);
    if (tabId) tabOps.updateTabState(tabId, { confidenceIntervalLevel: value });
  };
  const setAnimateFlow = (value: boolean) => {
    setAnimateFlowLocal(value);
    if (tabId) tabOps.updateTabState(tabId, { animateFlow: value });
  };

  const value = useMemo<ViewPreferencesContextValue>(() => ({
    useUniformScaling,
    massGenerosity,
    autoReroute,
    useSankeyView,
    confidenceIntervalLevel,
    animateFlow,
    setUseUniformScaling,
    setMassGenerosity,
    setAutoReroute,
    setUseSankeyView,
    setConfidenceIntervalLevel,
    setAnimateFlow
  }), [useUniformScaling, massGenerosity, autoReroute, useSankeyView, confidenceIntervalLevel, animateFlow]);

  return (
    <ViewPreferencesContext.Provider value={value}>
      {children}
    </ViewPreferencesContext.Provider>
  );
}


