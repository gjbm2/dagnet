import { LayoutData } from 'rc-dock';
import { db } from '../db/appDatabase';

/**
 * Layout Service
 * 
 * Handles persistence of rc-dock layout to IndexedDB
 */
export class LayoutService {
  /**
   * Save layout to IndexedDB
   * Strips out tab content/cached data to avoid duplication
   */
  async saveLayout(layout: LayoutData): Promise<void> {
    try {
      // Deep clone and strip tab content
      const cleanedLayout = this.stripTabContent(layout);
      
      await db.saveAppState({
        dockLayout: cleanedLayout
      });
      console.log('Layout saved to IndexedDB (without tab content)');
    } catch (error) {
      console.error('Failed to save layout:', error);
    }
  }

  /**
   * Strip tab content/cached data from layout
   * Keeps only tab IDs and panel structure
   */
  private stripTabContent(layout: LayoutData): LayoutData {
    const stripFromBox = (box: any): any => {
      if (!box) return box;
      
      const cleaned: any = { ...box };
      
      // If this box has tabs, strip their content
      if (cleaned.tabs && Array.isArray(cleaned.tabs)) {
        cleaned.tabs = cleaned.tabs.map((tab: any) => ({
          id: tab.id,
          // Keep only ID, rc-dock will handle the rest
        }));
      }
      
      // Recurse into children
      if (cleaned.children && Array.isArray(cleaned.children)) {
        cleaned.children = cleaned.children.map(stripFromBox);
      }
      
      return cleaned;
    };
    
    return {
      dockbox: stripFromBox(layout.dockbox),
      floatbox: stripFromBox(layout.floatbox),
      windowbox: stripFromBox(layout.windowbox),
      maxbox: stripFromBox(layout.maxbox)
    } as LayoutData;
  }

  /**
   * Load layout from IndexedDB
   * Reconciles with tabs table to remove ghost tabs
   */
  async loadLayout(): Promise<LayoutData | null> {
    const appState = await db.getAppState();
    if (appState?.dockLayout) {
      console.log('Layout loaded from IndexedDB');
      
      // Get valid tab IDs from tabs table
      const validTabs = await db.tabs.toArray();
      const validTabIds = new Set(validTabs.map(t => t.id));
      
      // Filter out ghost tabs from layout
      const cleanedLayout = this.filterGhostTabs(appState.dockLayout, validTabIds);
      
      return cleanedLayout;
    }
    return null;
  }

  /**
   * Remove tabs from layout that don't exist in the tabs table
   * Prevents ghost tabs from persisting across F5
   */
  private filterGhostTabs(layout: LayoutData, validTabIds: Set<string>): LayoutData {
    const filterFromBox = (box: any): any => {
      if (!box) return box;
      
      const cleaned: any = { ...box };
      
      // Filter tabs to only include valid ones
      if (cleaned.tabs && Array.isArray(cleaned.tabs)) {
        const originalCount = cleaned.tabs.length;
        cleaned.tabs = cleaned.tabs.filter((tab: any) => validTabIds.has(tab.id));
        const removedCount = originalCount - cleaned.tabs.length;
        if (removedCount > 0) {
          console.log(`🧹 Removed ${removedCount} ghost tab(s) from layout`);
        }
      }
      
      // Recurse into children
      if (cleaned.children && Array.isArray(cleaned.children)) {
        cleaned.children = cleaned.children.map(filterFromBox);
      }
      
      return cleaned;
    };
    
    return {
      dockbox: filterFromBox(layout.dockbox),
      floatbox: filterFromBox(layout.floatbox),
      windowbox: filterFromBox(layout.windowbox),
      maxbox: filterFromBox(layout.maxbox)
    } as LayoutData;
  }

  /**
   * Clear saved layout
   */
  async clearLayout(): Promise<void> {
    try {
      await db.saveAppState({
        dockLayout: null
      });
      console.log('Layout cleared from IndexedDB');
    } catch (error) {
      console.error('Failed to clear layout:', error);
    }
  }
}

// Export singleton instance
export const layoutService = new LayoutService();

