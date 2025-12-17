import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

interface DashboardModeContextValue {
  isDashboardMode: boolean;
  setDashboardMode: (enabled: boolean, opts?: { updateUrl?: boolean }) => void;
  toggleDashboardMode: (opts?: { updateUrl?: boolean }) => void;
}

const DashboardModeContext = createContext<DashboardModeContextValue | null>(null);

function setUrlParam(key: string, enabled: boolean) {
  try {
    const url = new URL(window.location.href);
    if (enabled) url.searchParams.set(key, '1');
    else url.searchParams.delete(key);
    window.history.replaceState({}, document.title, url.toString());
  } catch (e) {
    // Best-effort; URL manipulation should never break the app.
    console.warn('DashboardMode: Failed to update URL param', e);
  }
}

export function DashboardModeProvider({ children }: { children: React.ReactNode }) {
  const [isDashboardMode, setIsDashboardMode] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).has('dashboard');
    } catch {
      return false;
    }
  });

  // Bootstrap from ?dashboard on initial mount.
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('dashboard')) {
      setIsDashboardMode(true);
    }
  }, []);

  const value = useMemo<DashboardModeContextValue>(() => {
    const setDashboardMode = (enabled: boolean, opts?: { updateUrl?: boolean }) => {
      setIsDashboardMode(enabled);
      if (opts?.updateUrl !== false) setUrlParam('dashboard', enabled);
    };

    const toggleDashboardMode = (opts?: { updateUrl?: boolean }) => {
      setDashboardMode(!isDashboardMode, opts);
    };

    return { isDashboardMode, setDashboardMode, toggleDashboardMode };
  }, [isDashboardMode]);

  return (
    <DashboardModeContext.Provider value={value}>
      {children}
    </DashboardModeContext.Provider>
  );
}

export function useDashboardMode(): DashboardModeContextValue {
  const ctx = useContext(DashboardModeContext);
  if (!ctx) throw new Error('useDashboardMode must be used within DashboardModeProvider');
  return ctx;
}


