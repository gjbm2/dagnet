import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTabContext } from '../contexts/TabContext';

/**
 * Sidebar state interface
 * Per-tab state for the graph editor sidebar
 */
export interface SidebarState {
  mode: 'minimized' | 'maximized';        // Icon bar or full panel view
  activePanel: 'what-if' | 'properties' | 'tools';  // Which tab is selected
  floatingPanels: string[];               // Which panels are floating (for backwards compat and quick checks)
  savedDockLayout?: any;                  // Saved rc-dock layout structure (components stripped)
  hasAutoOpened: boolean;                 // Smart auto-open tracker (once per tab)
  isTransitioning: boolean;               // True during minimize/maximize animation
  
  // Panel-specific open/closed states (when in maximized mode)
  whatIfOpen: boolean;
  propertiesOpen: boolean;
  toolsOpen: boolean;
  
  // Per-tab positioning state for minimize button
  sidebarWidth?: number;                  // Tracked width of sidebar panel
  isResizing?: boolean;                   // True during resize drag
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
  toolsOpen: false,
  sidebarWidth: 300,  // Default sidebar width
  isResizing: false    // Not resizing by default
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
    storedState?.toolsOpen,
    storedState?.sidebarWidth,
    storedState?.isResizing
  ]);
  
  // Local state initialized from tab state
  // Use ref for hasAutoOpened to prevent sync from overwriting it
  const hasAutoOpenedRef = useRef<boolean>(false);
  
  const [state, setState] = useState<SidebarState>(() => {
    console.log(`[${new Date().toISOString()}] [useSidebarState] Initializing state from:`, { 
      memoizedStoredState, 
      floatingPanels: memoizedStoredState?.floatingPanels,
      sidebarWidth: memoizedStoredState?.sidebarWidth
    });
    const initialState = {
      ...DEFAULT_SIDEBAR_STATE,
      ...memoizedStoredState,
      // Ensure floatingPanels is always an array (might be undefined in old saved states)
      floatingPanels: memoizedStoredState?.floatingPanels || [],
      // ALWAYS force isTransitioning to false on load - it's a transient animation flag
      isTransitioning: false
    };
    console.log(`[${new Date().toISOString()}] [useSidebarState] Initial state result:`, initialState);
    return initialState;
  });
  
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
  
  // ONE-TIME FIX: Force clear isTransitioning on mount if it's stuck in stored state
  const hasClearedTransitionRef = useRef(false);
  useEffect(() => {
    if (!hasClearedTransitionRef.current && state.isTransitioning) {
      console.log(`[${new Date().toISOString()}] [useSidebarState] ONE-TIME FIX: Clearing stuck isTransitioning flag`);
      updateState({ isTransitioning: false });
      hasClearedTransitionRef.current = true;
    }
  }, [state.isTransitioning, updateState]);
  
  // Persist local state changes to tab state (separate effect to avoid circular updates)
  const prevStateRef = useRef<SidebarState>(state);
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [useSidebarState] useEffect#SB1: Persist sidebar state (changed=${prevStateRef.current !== state})`);
    // Only persist if state actually changed (not initial mount or tab switch)
    if (tabId && tabOps.updateTabState && prevStateRef.current !== state) {
      // Use a flag to track if this change came from us or from tab state
      // Note: We skip comparing savedDockLayout because it's large and may have circular refs
      // Instead, we rely on the fact that savedDockLayout only changes when the layout actually changes
      const stateMatchesMemoized = memoizedStoredState && 
        state.mode === memoizedStoredState.mode &&
        state.activePanel === memoizedStoredState.activePanel &&
        state.sidebarWidth === memoizedStoredState.sidebarWidth &&
        state.isResizing === memoizedStoredState.isResizing &&
        // hasAutoOpened is session-only, not persisted, so don't compare it
        JSON.stringify(state.floatingPanels.sort()) === JSON.stringify((memoizedStoredState.floatingPanels || []).sort()) &&
        state.savedDockLayout === memoizedStoredState.savedDockLayout; // Reference equality check
      
      if (!stateMatchesMemoized) {
        // Strip out hasAutoOpened (session-only, not persisted)
        const { isTransitioning, hasAutoOpened, ...stateToSave } = state;
        console.log(`[${new Date().toISOString()}] [useSidebarState] Persisting state to tab (mode=${stateToSave.mode}, width=${stateToSave.sidebarWidth}):`, stateToSave);
        tabOps.updateTabState(tabId, {
          sidebarState: { ...stateToSave, isTransitioning: false }
        });
      } else {
        console.log(`[${new Date().toISOString()}] [useSidebarState] Skipping persist (matches memoized)`);
      }
    }
    prevStateRef.current = state;
  }, [state, tabId, tabOps, memoizedStoredState]);
  
  /**
   * Minimize sidebar to icon bar
   */
  const minimize = useCallback(() => {
    console.log(`[${new Date().toISOString()}] [useSidebarState] minimize: Setting isTransitioning=true`);
    updateState({ mode: 'minimized', isTransitioning: true });
    // Clear transition flag after animation completes (300ms)
    setTimeout(() => {
      console.log(`[${new Date().toISOString()}] [useSidebarState] minimize: Clearing isTransitioning after 300ms`);
      updateState({ isTransitioning: false });
    }, 300);
  }, [updateState]);
  
  /**
   * Maximize sidebar to full panel view
   * Opens the specified panel (or activePanel if none specified)
   */
  const maximize = useCallback((panel?: 'what-if' | 'properties' | 'tools') => {
    console.log(`[${new Date().toISOString()}] [useSidebarState] maximize: Setting isTransitioning=true, panel=${panel}, currentWidth=${state.sidebarWidth}`);
    
    // CRITICAL: If sidebar width is 0 or very small (collapsed), restore to default 300px
    const restoredWidth = (!state.sidebarWidth || state.sidebarWidth < 50) ? 300 : state.sidebarWidth;
    
    updateState({ 
      mode: 'maximized',
      activePanel: panel || state.activePanel,
      sidebarWidth: restoredWidth,
      isTransitioning: true
    });
    // Clear transition flag after animation completes (300ms)
    setTimeout(() => {
      console.log(`[${new Date().toISOString()}] [useSidebarState] maximize: Clearing isTransitioning after 300ms`);
      updateState({ isTransitioning: false });
    }, 300);
  }, [updateState, state.activePanel, state.sidebarWidth]);
  
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
    // Only auto-open once per tab session (use ref, not state)
    if (hasAutoOpenedRef.current) {
      console.log(`[${new Date().toISOString()}] [useSidebarState] handleSelection: Already auto-opened, skipping`);
      return;
    }
    
    // Set ref immediately to prevent race conditions
    hasAutoOpenedRef.current = true;
    
    if (state.mode === 'minimized') {
      // Sidebar is minimized - maximize and show Properties (first time only)
      console.log(`[${new Date().toISOString()}] [useSidebarState] handleSelection: Auto-opening sidebar (first selection)`);
      updateState({
        mode: 'maximized',
        activePanel: 'properties',
        propertiesOpen: true,
        hasAutoOpened: true
      });
    } else if (state.mode === 'maximized') {
      // Sidebar is already maximized - just switch to Properties tab (first time only)
      console.log(`[${new Date().toISOString()}] [useSidebarState] handleSelection: Switching to Properties (first selection)`);
      updateState({
        activePanel: 'properties',
        propertiesOpen: true,
        hasAutoOpened: true
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
  
  /**
   * Update sidebar width (for minimize button positioning)
   */
  const setSidebarWidth = useCallback((width: number) => {
    updateState({ sidebarWidth: width });
  }, [updateState]);
  
  /**
   * Update resizing state (for hiding minimize button during resize)
   */
  const setIsResizing = useCallback((resizing: boolean) => {
    updateState({ isResizing: resizing });
  }, [updateState]);
  
  /**
   * Reset sidebar to default state (for recovery from weird docking configurations)
   */
  const resetToDefault = useCallback(() => {
    console.log('Resetting sidebar to default state');
    updateState({
      ...DEFAULT_SIDEBAR_STATE
    });
  }, [updateState]);
  
  // Sync local state with tab state when tab or stored state changes
  // BUT: Don't sync if we just updated locally (prevents circular loop)
  useEffect(() => {
    if (memoizedStoredState && !isUpdatingRef.current) {
      console.log(`[${new Date().toISOString()}] [useSidebarState] Syncing from stored state (floatingPanels=${memoizedStoredState.floatingPanels?.length || 0}):`, memoizedStoredState);
      
      // Preserve session-only state (hasAutoOpened) - don't let sync overwrite it
      const currentHasAutoOpened = state.hasAutoOpened;
      
      const newState = {
        ...DEFAULT_SIDEBAR_STATE,
        ...memoizedStoredState,
        // Ensure floatingPanels is always an array
        floatingPanels: memoizedStoredState.floatingPanels || [],
        // ALWAYS force isTransitioning to false - it's a transient animation flag
        isTransitioning: false
      };
      
      // AFTER spreading, restore session-only hasAutoOpened
      newState.hasAutoOpened = currentHasAutoOpened;
      
      setState(newState);
    }
  }, [memoizedStoredState, state.hasAutoOpened]);
  
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
    setSidebarWidth,
    setIsResizing,
    resetToDefault,
    updateState
  }), [minimize, maximize, toggle, switchPanel, handleSelection, markAutoOpened, floatPanel, unfloatPanel, setSidebarWidth, setIsResizing, resetToDefault, updateState]);
  
  return {
    state,
    operations
  };
}

