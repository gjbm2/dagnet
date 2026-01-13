import Dexie, { Table } from 'dexie';
import { FileState, TabState, AppState, SettingsData, WorkspaceState } from '../types';
import { CredentialsData } from '../types/credentials';
import { Scenario } from '../types/scenarios';
import { getShareDbName } from '../lib/shareBootResolver';

/** Default workspace DB name */
export const DEFAULT_DB_NAME = 'DagNetGraphEditor';

/**
 * IndexedDB database for persisting app state
 * 
 * Stores:
 * - workspaces: Workspace metadata (repo, branch, lastSynced)
 * - files: FileState records (single source of truth for file data)
 * - tabs: TabState records (views of files)
 * - scenarios: Scenario records (parameter overlays, shared per file)
 * - appState: Application-level state (layout, navigator, etc.)
 * - settings: User settings (local only, not synced to git)
 * - credentials: User authentication credentials (local only, not synced to git)
 * 
 * DB name is determined by shareBootResolver:
 * - Normal workspace: 'DagNetGraphEditor'
 * - Live share: 'DagNetGraphEditorShare:<scopeKey>'
 */
export class AppDatabase extends Dexie {
  // Tables
  workspaces!: Table<WorkspaceState, string>;
  files!: Table<FileState, string>;
  tabs!: Table<TabState, string>;
  scenarios!: Table<Scenario & { fileId: string }, string>;
  appState!: Table<AppState, string>;
  settings!: Table<SettingsData, string>;
  credentials!: Table<CredentialsData & { id: string; source: string; timestamp: number }, string>;

  constructor(dbName: string = DEFAULT_DB_NAME) {
    super(dbName);
    console.log(`[AppDatabase] Initialising with DB name: ${dbName}`);
    
    this.version(1).stores({
      // fileId is primary key
      files: 'fileId, type, isDirty, source.repository, source.branch, lastModified',
      
      // id is primary key
      tabs: 'id, fileId, viewMode',
      
      // id is primary key (singleton: 'app-state')
      appState: 'id, updatedAt',
      
      // id is primary key (singleton: 'settings')
      settings: 'id',
      
      // id is primary key, timestamp for sorting
      credentials: 'id, source, timestamp'
    });
    
    // Version 2: Add workspaces table
    this.version(2).stores({
      // Add workspaces table
      workspaces: 'id, repository, branch, lastSynced',
      
      // Keep existing tables
      files: 'fileId, type, isDirty, source.repository, source.branch, lastModified',
      tabs: 'id, fileId, viewMode',
      appState: 'id, updatedAt',
      settings: 'id',
      credentials: 'id, source, timestamp'
    });
    
    // Version 3: Add scenarios table
    this.version(3).stores({
      // Add scenarios table (scenarios per file)
      scenarios: 'id, fileId, createdAt, updatedAt',
      
      // Keep existing tables
      workspaces: 'id, repository, branch, lastSynced',
      files: 'fileId, type, isDirty, source.repository, source.branch, lastModified',
      tabs: 'id, fileId, viewMode',
      appState: 'id, updatedAt',
      settings: 'id',
      credentials: 'id, source, timestamp'
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
        expandedSections: [],
        availableRepos: [],
        availableBranches: []
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
   * Clears EVERYTHING except credentials
   */
  async clearAll(): Promise<void> {
    // Preserve credentials file before clearing
    const credentialsFile = await this.files.get('credentials-credentials');
    
    // Clear all tables except credentials table
    await this.files.clear();
    await this.tabs.clear();
    await this.appState.clear();
    await this.workspaces.clear();
    await this.scenarios.clear();
    await this.settings.clear();
    // DON'T clear credentials table - those are the user's auth tokens
    
    // Restore credentials file
    if (credentialsFile) {
      await this.files.add(credentialsFile);
    }
    
    // Files (including connections.yaml) will be re-seeded on app reload
  }

  /**
   * Clear all data including settings and credentials
   */
  async clearAllIncludingSettings(): Promise<void> {
    await this.files.clear();
    await this.tabs.clear();
    await this.appState.clear();
    await this.settings.clear();
    await this.credentials.clear();
  }

  /**
   * Get all dirty files
   */
  async getDirtyFiles(): Promise<FileState[]> {
    // Check for truthy isDirty (handles both boolean true and number 1)
    const allFiles = await this.files.toArray();
    return allFiles.filter(file => file.isDirty);
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

// Create singleton instance using resolved DB name from boot config
// This runs at module load time, so shareBootResolver.getShareDbName() is called early
export const db = new AppDatabase(getShareDbName());

// Debug exposure for console access
if (typeof window !== 'undefined') {
  (window as any).db = db;
}

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
  
  // Reload page to start fresh (only in browser, not in tests)
  if (typeof window !== 'undefined' && window.location?.reload) {
    window.location.reload();
  }
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

// Initialize on import - but NOT in test environments where tests manage DB lifecycle
// In tests, fake-indexeddb is used and tests call db.delete()/db.open() themselves
const isTestEnvironment = typeof process !== 'undefined' && 
  (process.env.NODE_ENV === 'test' || process.env.VITEST);

if (!isTestEnvironment) {
  db.initialize().catch(error => {
    console.error('Failed to initialize database:', error);
    handleStorageError(error, 'initialize');
  });
}

