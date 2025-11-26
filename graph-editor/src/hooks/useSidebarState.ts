import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTabContext } from '../contexts/TabContext';
import { DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from '../lib/uiConstants';

/**
 * Sidebar state interface
 * Per-tab state for the graph editor sidebar
 */
export interface SidebarState {
  mode: 'minimized' | 'maximized';        // Icon bar or full panel view
  activePanel: 'what-if' | 'properties' | 'tools' | 'analytics';  // Which tab is selected
  floatingPanels: string[];               // Which panels are floating (for backwards compat and quick checks)
  savedDockLayout?: any;                  // Saved rc-dock layout structure (components stripped)
  hasAutoOpened: boolean;                 // Smart auto-open tracker (once per tab)
  
  // Panel-specific open/closed states (when in maximized mode)
  whatIfOpen: boolean;
  propertiesOpen: boolean;
  toolsOpen: boolean;
  analyticsOpen: boolean;
  
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
  whatIfOpen: false,
  propertiesOpen: true,
  toolsOpen: false,
  analyticsOpen: false,
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
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
    storedState?.whatIfOpen,
    storedState?.propertiesOpen,
    storedState?.toolsOpen,
    storedState?.sidebarWidth,
    storedState?.isResizing,
    storedState?.savedDockLayout  // Include layout to match comparison logic
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
    
    // Sanitize stored width - never accept tiny values
    const sanitizedWidth = (memoizedStoredState?.sidebarWidth && memoizedStoredState.sidebarWidth >= MIN_SIDEBAR_WIDTH)
      ? memoizedStoredState.sidebarWidth
      : DEFAULT_SIDEBAR_WIDTH;
    
    const initialState = {
      ...DEFAULT_SIDEBAR_STATE,
      ...memoizedStoredState,
      // Ensure floatingPanels is always an array (might be undefined in old saved states)
      floatingPanels: memoizedStoredState?.floatingPanels || [],
      // Use sanitized width
      sidebarWidth: sanitizedWidth
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
  
  
  // Persist local state changes to tab state (separate effect to avoid circular updates)
  const prevStateRef = useRef<SidebarState>(state);
  // Phase 4: Use ref for tabOps to avoid re-running effect when it changes reference
  const tabOpsRef = useRef(tabOps);
  useEffect(() => {
    tabOpsRef.current = tabOps;
  }, [tabOps]);
  
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [useSidebarState] useEffect#SB1: Persist sidebar state (changed=${prevStateRef.current !== state})`);
    // Only persist if state actually changed (not initial mount or tab switch)
    if (tabId && tabOpsRef.current.updateTabState && prevStateRef.current !== state) {
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
        // Note: hasAutoOpened is session-only and not persisted to IndexedDB
        console.log(`[${new Date().toISOString()}] [useSidebarState] Persisting state to tab (mode=${state.mode}, width=${state.sidebarWidth}):`, state);
        tabOpsRef.current.updateTabState(tabId, {
          sidebarState: state
        });
      } else {
        console.log(`[${new Date().toISOString()}] [useSidebarState] Skipping persist (matches memoized)`);
      }
    }
    prevStateRef.current = state;
  }, [state, tabId, memoizedStoredState]); // Phase 4: Removed tabOps - using ref instead
  
  /**
   * Minimize sidebar to icon bar
   */
  const minimize = useCallback(() => {
    console.log(`[${new Date().toISOString()}] [useSidebarState] minimize: Minimizing sidebar`);
    updateState({ mode: 'minimized' });
  }, [updateState]);
  
  /**
   * Maximize sidebar to full panel view
   * Opens the specified panel (or activePanel if none specified)
   */
  const maximize = useCallback((panel?: 'what-if' | 'properties' | 'tools' | 'analytics') => {
    console.log(`[${new Date().toISOString()}] [useSidebarState] maximize: Maximizing sidebar, panel=${panel}, currentWidth=${state.sidebarWidth}`);
    
    // CRITICAL: If sidebar width is 0 or very small (collapsed), restore to default
    const restoredWidth = (!state.sidebarWidth || state.sidebarWidth < MIN_SIDEBAR_WIDTH) ? DEFAULT_SIDEBAR_WIDTH : state.sidebarWidth;
    
    updateState({ 
      mode: 'maximized',
      activePanel: panel || state.activePanel,
      sidebarWidth: restoredWidth
    });
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
  const switchPanel = useCallback((panel: 'what-if' | 'properties' | 'tools' | 'analytics') => {
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
   * CRITICAL: Never store tiny widths - they corrupt state and cause infinite loops
   */
  const setSidebarWidth = useCallback((width: number) => {
    // Guard: Never store widths smaller than MIN_SIDEBAR_WIDTH
    // This prevents corruption when sidebar is minimized (width=0 or 1)
    if (width < MIN_SIDEBAR_WIDTH) {
      console.log(`[useSidebarState] setSidebarWidth: Ignoring tiny width ${width}px (< ${MIN_SIDEBAR_WIDTH})`);
      return;
    }
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
  // Track the last synced stored state to avoid re-syncing the same data
  const lastSyncedStoredStateRef = useRef<SidebarState | null>(null);
  
  useEffect(() => {
    // Skip if no stored state or if we're currently updating
    if (!memoizedStoredState || isUpdatingRef.current) {
      return;
    }
    
    // Skip if this is the same stored state we already synced
    // Use JSON comparison for deep equality (excluding functions)
    const storedStateKey = JSON.stringify({
      mode: memoizedStoredState.mode,
      activePanel: memoizedStoredState.activePanel,
      sidebarWidth: memoizedStoredState.sidebarWidth,
      floatingPanels: memoizedStoredState.floatingPanels
    });
    const lastSyncedKey = lastSyncedStoredStateRef.current ? JSON.stringify({
      mode: lastSyncedStoredStateRef.current.mode,
      activePanel: lastSyncedStoredStateRef.current.activePanel,
      sidebarWidth: lastSyncedStoredStateRef.current.sidebarWidth,
      floatingPanels: lastSyncedStoredStateRef.current.floatingPanels
    }) : null;
    
    if (storedStateKey === lastSyncedKey) {
      return; // Already synced this exact state
    }
    
    console.log(`[${new Date().toISOString()}] [useSidebarState] Syncing from stored state (floatingPanels=${memoizedStoredState.floatingPanels?.length || 0}):`, memoizedStoredState);
    
    // Mark as synced BEFORE setting state to prevent re-entry
    lastSyncedStoredStateRef.current = memoizedStoredState;
    
    // Preserve session-only state (hasAutoOpened) - don't let sync overwrite it
    const currentHasAutoOpened = state.hasAutoOpened;
    
    // Sanitize stored width - never accept tiny values (they corrupt state)
    const sanitizedWidth = (memoizedStoredState.sidebarWidth && memoizedStoredState.sidebarWidth >= MIN_SIDEBAR_WIDTH)
      ? memoizedStoredState.sidebarWidth
      : (state.sidebarWidth && state.sidebarWidth >= MIN_SIDEBAR_WIDTH)
        ? state.sidebarWidth  // Keep current valid width
        : DEFAULT_SIDEBAR_WIDTH;  // Fallback to default
    
    const newState = {
      ...DEFAULT_SIDEBAR_STATE,
      ...memoizedStoredState,
      // Ensure floatingPanels is always an array
      floatingPanels: memoizedStoredState.floatingPanels || [],
      // Use sanitized width
      sidebarWidth: sanitizedWidth
    };
    
    // AFTER spreading, restore session-only hasAutoOpened
    newState.hasAutoOpened = currentHasAutoOpened;
    
    setState(newState);
  }, [memoizedStoredState]); // Removed state.hasAutoOpened - we read it inside via closure
  
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

