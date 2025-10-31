import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTabContext } from '../contexts/TabContext';

/**
 * Sidebar state interface
 * Per-tab state for the graph editor sidebar
 */
export interface SidebarState {
  mode: 'minimized' | 'maximized';        // Icon bar or full panel view
  activePanel: 'what-if' | 'properties' | 'tools';  // Which tab is selected
  floatingPanels: string[];               // Which panels are floating
  hasAutoOpened: boolean;                 // Smart auto-open tracker (once per tab)
  isTransitioning: boolean;               // True during minimize/maximize animation
  
  // Panel-specific open/closed states (when in maximized mode)
  whatIfOpen: boolean;
  propertiesOpen: boolean;
  toolsOpen: boolean;
}

/**
 * Default sidebar state
 */
export const DEFAULT_SIDEBAR_STATE: SidebarState = {
  mode: 'minimized',  // Default: icon bar
  activePanel: 'properties',
  floatingPanels: [],
  hasAutoOpened: false,
  isTransitioning: false,
  whatIfOpen: false,
  propertiesOpen: true,
  toolsOpen: false
};

/**
 * Hook to manage per-tab sidebar state
 * 
 * @param tabId - The tab ID for this graph editor instance
 * @returns Sidebar state and operations
 */
export function useSidebarState(tabId?: string) {
  const { tabs, operations: tabOps } = useTabContext();
  
  // Find the current tab
  const myTab = tabs.find(t => t.id === tabId);
  const storedState = myTab?.editorState?.sidebarState as SidebarState | undefined;
  
  // Memoize storedState to prevent unnecessary re-renders when reference changes but content doesn't
  const memoizedStoredState = useMemo(() => storedState, [
    storedState?.mode,
    storedState?.activePanel,
    storedState?.floatingPanels?.join(','),
    storedState?.hasAutoOpened,
    storedState?.isTransitioning,
    storedState?.whatIfOpen,
    storedState?.propertiesOpen,
    storedState?.toolsOpen
  ]);
  
  // Local state initialized from tab state
  const [state, setState] = useState<SidebarState>(() => ({
    ...DEFAULT_SIDEBAR_STATE,
    ...memoizedStoredState
  }));
  
  // Track if we're currently updating to prevent circular syncs
  const isUpdatingRef = useRef(false);
  
  /**
   * Update sidebar state (local only)
   */
  const updateState = useCallback((updates: Partial<SidebarState>) => {
    isUpdatingRef.current = true;
    setState(prev => ({ ...prev, ...updates }));
    // Reset flag after current event loop
    setTimeout(() => {
      isUpdatingRef.current = false;
    }, 0);
  }, []);
  
  // Persist local state changes to tab state (separate effect to avoid circular updates)
  const prevStateRef = useRef<SidebarState>(state);
  useEffect(() => {
    // Only persist if state actually changed (not initial mount or tab switch)
    if (tabId && tabOps.updateTabState && prevStateRef.current !== state) {
      // Use a flag to track if this change came from us or from tab state
      const stateMatchesMemoized = memoizedStoredState && 
        state.mode === memoizedStoredState.mode &&
        state.activePanel === memoizedStoredState.activePanel;
      
      if (!stateMatchesMemoized) {
        tabOps.updateTabState(tabId, {
          sidebarState: state
        });
      }
    }
    prevStateRef.current = state;
  }, [state, tabId, tabOps, memoizedStoredState]);
  
  /**
   * Minimize sidebar to icon bar
   */
  const minimize = useCallback(() => {
    updateState({ mode: 'minimized', isTransitioning: true });
    // Clear transition flag after animation completes (300ms)
    setTimeout(() => {
      updateState({ isTransitioning: false });
    }, 300);
  }, [updateState]);
  
  /**
   * Maximize sidebar to full panel view
   * Opens the specified panel (or activePanel if none specified)
   */
  const maximize = useCallback((panel?: 'what-if' | 'properties' | 'tools') => {
    updateState({ 
      mode: 'maximized',
      activePanel: panel || state.activePanel,
      isTransitioning: true
    });
    // Clear transition flag after animation completes (300ms)
    setTimeout(() => {
      updateState({ isTransitioning: false });
    }, 300);
  }, [updateState, state.activePanel]);
  
  /**
   * Toggle sidebar between minimized and maximized
   */
  const toggle = useCallback(() => {
    if (state.mode === 'minimized') {
      maximize();
    } else {
      minimize();
    }
  }, [state.mode, maximize, minimize]);
  
  /**
   * Switch to a specific panel (only works when maximized)
   */
  const switchPanel = useCallback((panel: 'what-if' | 'properties' | 'tools') => {
    updateState({ activePanel: panel });
  }, [updateState]);
  
  /**
   * Mark that properties has auto-opened for this tab
   */
  const markAutoOpened = useCallback(() => {
    updateState({ hasAutoOpened: true });
  }, [updateState]);
  
  /**
   * Smart auto-open logic: opens Properties panel on first selection
   * 
   * Call this when user selects a node or edge
   */
  const handleSelection = useCallback(() => {
    if (state.mode === 'minimized') {
      // Sidebar is minimized - maximize and show Properties
      updateState({
        mode: 'maximized',
        activePanel: 'properties',
        propertiesOpen: true,
        hasAutoOpened: true
      });
    } else if (state.mode === 'maximized') {
      // Sidebar is already maximized - just switch to Properties tab
      updateState({
        activePanel: 'properties',
        propertiesOpen: true
      });
    }
  }, [state.mode, updateState]);
  
  /**
   * Add a panel to floating state
   */
  const floatPanel = useCallback((panelId: string) => {
    updateState({
      floatingPanels: [...state.floatingPanels, panelId]
    });
  }, [state.floatingPanels, updateState]);
  
  /**
   * Remove a panel from floating state (user closed it, return to icon bar)
   */
  const unfloatPanel = useCallback((panelId: string) => {
    updateState({
      floatingPanels: state.floatingPanels.filter(id => id !== panelId)
    });
  }, [state.floatingPanels, updateState]);
  
  // Sync local state with tab state when tab or stored state changes
  // BUT: Don't sync if we just updated locally (prevents circular loop)
  useEffect(() => {
    if (memoizedStoredState && !isUpdatingRef.current) {
      setState({
        ...DEFAULT_SIDEBAR_STATE,
        ...memoizedStoredState
      });
    }
  }, [memoizedStoredState]);
  
  // Memoize operations object to prevent unnecessary re-renders
  const operations = useMemo(() => ({
    minimize,
    maximize,
    toggle,
    switchPanel,
    handleSelection,
    markAutoOpened,
    floatPanel,
    unfloatPanel,
    updateState
  }), [minimize, maximize, toggle, switchPanel, handleSelection, markAutoOpened, floatPanel, unfloatPanel, updateState]);
  
  return {
    state,
    operations
  };
}

