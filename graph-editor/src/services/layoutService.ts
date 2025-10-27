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
   */
  async loadLayout(): Promise<LayoutData | null> {
    try {
      const appState = await db.getAppState();
      if (appState?.dockLayout) {
        console.log('Layout loaded from IndexedDB');
        return appState.dockLayout;
      }
      return null;
    } catch (error) {
      console.error('Failed to load layout:', error);
      return null;
    }
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

