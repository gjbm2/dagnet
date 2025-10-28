import Dexie, { Table } from 'dexie';
import { FileState, TabState, AppState, SettingsData } from '../types';

/**
 * IndexedDB database for persisting app state
 * 
 * Stores:
 * - files: FileState records (single source of truth for file data)
 * - tabs: TabState records (views of files)
 * - appState: Application-level state (layout, navigator, etc.)
 * - settings: User settings (local only, not synced to git)
 */
export class AppDatabase extends Dexie {
  // Tables
  files!: Table<FileState, string>;
  tabs!: Table<TabState, string>;
  appState!: Table<AppState, string>;
  settings!: Table<SettingsData, string>;

  constructor() {
    super('DagNetGraphEditor');
    
    this.version(1).stores({
      // fileId is primary key
      files: 'fileId, type, isDirty, source.repository, source.branch, lastModified',
      
      // id is primary key
      tabs: 'id, fileId, viewMode',
      
      // id is primary key (singleton: 'app-state')
      appState: 'id, updatedAt',
      
      // id is primary key (singleton: 'settings')
      settings: 'id'
    });
  }

  /**
   * Initialize database with default values
   */
  async initialize(): Promise<void> {
    // Check if app state exists
    const existingState = await this.appState.get('app-state');
    
    if (!existingState) {
      // Create default app state
      await this.appState.add({
        id: 'app-state',
        dockLayout: null, // Will be set by rc-dock
        navigatorState: {
          isOpen: false,
          isPinned: false,
          searchQuery: '',
          selectedRepo: '',
          selectedBranch: '',
          expandedSections: []
        },
        updatedAt: Date.now()
      });
    }

    // Check if settings exist
    const existingSettings = await this.settings.get('settings');
    
    if (!existingSettings) {
      // Create default settings
      await this.settings.add({
        id: 'settings',
        git: {},
        ui: {
          theme: 'light',
          navigatorDefaultOpen: false,
          tabLimit: 20
        },
        editor: {
          autoSave: false,
          showLineNumbers: true,
          wordWrap: true
        }
      });
    }
  }

  /**
   * Clear all data (useful for testing or reset)
   */
  async clearAll(): Promise<void> {
    await this.files.clear();
    await this.tabs.clear();
    await this.appState.clear();
    // Don't clear settings - user preferences should persist
  }

  /**
   * Get all dirty files
   */
  async getDirtyFiles(): Promise<FileState[]> {
    return await this.files.where('isDirty').equals(1).toArray();
  }

  /**
   * Get all tabs for a specific file
   */
  async getTabsForFile(fileId: string): Promise<TabState[]> {
    return await this.tabs.where('fileId').equals(fileId).toArray();
  }

  /**
   * Save app state
   */
  async saveAppState(state: Partial<AppState>): Promise<void> {
    await this.appState.update('app-state', {
      ...state,
      updatedAt: Date.now()
    });
  }

  /**
   * Get app state
   */
  async getAppState(): Promise<AppState | undefined> {
    return await this.appState.get('app-state');
  }

  /**
   * Save settings
   */
  async saveSettings(settings: Partial<SettingsData>): Promise<void> {
    const existing = await this.settings.get('settings');
    await this.settings.put({
      id: 'settings',
      git: existing?.git || {},
      ui: existing?.ui || {},
      editor: existing?.editor || {},
      ...settings
    });
  }

  /**
   * Get settings
   */
  async getSettings(): Promise<SettingsData | undefined> {
    return await this.settings.get('settings');
  }
}

// Create singleton instance
export const db = new AppDatabase();

// Global error handler - if ANYTHING fails, nuke the DB and reload
const handleStorageError = async (error: any, context: string) => {
  console.error(`❌ Storage error in ${context}:`, error);
  console.warn('🧹 Nuking corrupted storage and reloading...');
  
  try {
    await db.delete();
    console.log('✅ Storage deleted');
  } catch (e) {
    console.error('Failed to delete storage (non-fatal):', e);
  }
  
  // Reload page to start fresh
  window.location.reload();
};

// Wrap all DB operations to catch errors
const originalGet = db.files.get.bind(db.files);
(db.files as any).get = async (key: string) => {
  try {
    return await originalGet(key);
  } catch (error) {
    await handleStorageError(error, 'files.get');
    return undefined;
  }
};

const originalTabsToArray = db.tabs.toArray.bind(db.tabs);
(db.tabs as any).toArray = async () => {
  try {
    return await originalTabsToArray();
  } catch (error) {
    await handleStorageError(error, 'tabs.toArray');
    return [];
  }
};

const originalGetAppState = db.getAppState.bind(db);
(db as any).getAppState = async () => {
  try {
    return await originalGetAppState();
  } catch (error) {
    await handleStorageError(error, 'getAppState');
    return undefined;
  }
};

// Initialize on import
db.initialize().catch(error => {
  console.error('Failed to initialize database:', error);
  handleStorageError(error, 'initialize');
});

