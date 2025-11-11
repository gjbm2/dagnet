import React, { createContext, useContext, useState, useCallback } from 'react';
import { LayoutData } from 'rc-dock';

/**
 * VisibleTabsContext
 * 
 * Tracks which tabs are currently visible in rc-dock layout.
 * A tab is "visible" if:
 * - Its panel is visible (not minimized/hidden)
 * - The tab is in a visible dock panel (not just cached)
 * - Multiple tabs can be visible simultaneously (split view, multiple dock panels)
 */

interface VisibleTabsContextValue {
  visibleTabIds: Set<string>;
  isTabVisible: (tabId: string) => boolean;
  updateFromLayout: (layout: LayoutData | null) => void;
}

const VisibleTabsContext = createContext<VisibleTabsContextValue | null>(null);

/**
 * Extract visible tab IDs from rc-dock layout
 */
function extractVisibleTabs(layout: LayoutData | null): Set<string> {
  const visible = new Set<string>();
  
  if (!layout) {
    console.log('[VisibleTabs] extractVisibleTabs: No layout provided');
    return visible;
  }
  
  /**
   * Recursively traverse layout to find visible tabs
   * Only the ACTIVE tab in each visible panel is considered visible
   */
  const traverse = (node: any) => {
    if (node.tabs && Array.isArray(node.tabs)) {
      // Check if this panel is visible
      // Panels are visible if they have non-zero size or size is undefined (default visible)
      // Panels with size: 0 are minimized/hidden
      const isPanelVisible = node.size === undefined || node.size > 0;
      
      if (isPanelVisible && node.tabs.length > 0) {
        // Only the active tab in this panel is visible
        // rc-dock uses 'activeId' to indicate which tab is currently visible
        const activeId = node.activeId;
        const allTabIds = node.tabs.map((t: any) => t.id).filter(Boolean);
        
        if (activeId) {
          // Add the active tab
          visible.add(activeId);
          console.log(`[VisibleTabs] Panel has activeId=${activeId}, all tabs: [${allTabIds.join(', ')}]`);
        } else {
          // Fallback: if no activeId, use first tab (rc-dock default)
          const firstTab = node.tabs[0];
          if (firstTab?.id) {
            visible.add(firstTab.id);
            console.log(`[VisibleTabs] Panel has no activeId, using first tab=${firstTab.id}, all tabs: [${allTabIds.join(', ')}]`);
          }
        }
      }
    }
    
    // Traverse children
    if (node.children && Array.isArray(node.children)) {
      node.children.forEach(traverse);
    }
  };
  
  // Traverse dockbox (main docked panels)
  if (layout.dockbox) {
    traverse(layout.dockbox);
  }
  
  // Traverse floatbox (floating panels)
  if (layout.floatbox && layout.floatbox.children) {
    layout.floatbox.children.forEach((floatPanel: any) => {
      traverse(floatPanel);
    });
  }
  
  console.log(`[VisibleTabs] extractVisibleTabs: Found ${visible.size} visible tabs: [${Array.from(visible).join(', ')}]`);
  return visible;
}

/**
 * VisibleTabsProvider
 * 
 * Tracks visible tabs from rc-dock layout changes.
 * Should be placed at AppShell level to observe all dock layouts.
 */
export function VisibleTabsProvider({ children }: { children: React.ReactNode }) {
  const [visibleTabIds, setVisibleTabIds] = useState<Set<string>>(new Set());
  
  /**
   * Update visible tabs from layout
   * Called from AppShell's onLayoutChange handler
   */
  const updateFromLayout = useCallback((layout: LayoutData | null) => {
    const newVisible = extractVisibleTabs(layout);
    
    // Only update if changed (avoid unnecessary re-renders)
    setVisibleTabIds(prev => {
      // Quick size check
      if (prev.size !== newVisible.size) {
        console.log(`[VisibleTabs] Visibility changed: ${prev.size} -> ${newVisible.size} tabs`);
        return newVisible;
      }
      
      // Deep equality check
      for (const id of prev) {
        if (!newVisible.has(id)) {
          console.log(`[VisibleTabs] Visibility changed: tab ${id} became invisible`);
          return newVisible;
        }
      }
      for (const id of newVisible) {
        if (!prev.has(id)) {
          console.log(`[VisibleTabs] Visibility changed: tab ${id} became visible`);
          return newVisible;
        }
      }
      
      return prev; // No change
    });
  }, []);
  
  /**
   * Check if a tab is visible
   */
  const isTabVisible = useCallback((tabId: string): boolean => {
    return visibleTabIds.has(tabId);
  }, [visibleTabIds]);
  
  const value: VisibleTabsContextValue = {
    visibleTabIds,
    isTabVisible,
    updateFromLayout
  };
  
  return (
    <VisibleTabsContext.Provider value={value}>
      {children}
    </VisibleTabsContext.Provider>
  );
}

/**
 * Hook to access visible tabs context
 */
export function useVisibleTabs(): VisibleTabsContextValue {
  const context = useContext(VisibleTabsContext);
  if (!context) {
    throw new Error('useVisibleTabs must be used within VisibleTabsProvider');
  }
  return context;
}

