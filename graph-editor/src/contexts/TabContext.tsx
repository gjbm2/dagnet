import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { 
  TabState, 
  FileState, 
  TabOperations, 
  RepositoryItem, 
  ViewMode,
  CommitRequest 
} from '../types';
import { db } from '../db/appDatabase';
import { useDialog } from './DialogContext';

/**
 * File Registry - Single source of truth for file data
 * Manages files and synchronizes across multiple tabs viewing the same file
 */
class FileRegistry {
  private files = new Map<string, FileState>();
  private listeners = new Map<string, Set<(file: FileState) => void>>();

  /**
   * Get or create a file state
   */
  async getOrCreateFile(
    fileId: string, 
    type: RepositoryItem['type'],
    source: FileState['source'],
    data: any
  ): Promise<FileState> {
    let file = this.files.get(fileId);
    let shouldNotify = false;
    
    if (!file) {
      // Check if file exists in IndexedDB
      file = await db.files.get(fileId);
      
      if (!file) {
        // Create new file state
        file = {
          fileId,
          type,
          data,
          originalData: structuredClone(data),
          isDirty: false,
          source,
          viewTabs: [],
          lastModified: Date.now()
        };
        
        await db.files.add(file);
      }
      
      this.files.set(fileId, file);
      shouldNotify = true; // Notify whenever we add to memory cache
    }
    
    // Notify listeners that file is now available (either newly created or loaded from DB)
    if (shouldNotify) {
      console.log(`FileRegistry: Notifying listeners for ${fileId}, data:`, file.data);
      this.notifyListeners(fileId, file);
    }
    
    return file;
  }

  /**
   * Update file data
   */
  async updateFile(fileId: string, newData: any): Promise<void> {
    const file = this.files.get(fileId);
    if (!file) {
      console.warn(`FileRegistry: File ${fileId} not found for update`);
      return;
    }

    const oldDataStr = JSON.stringify(file.data);
    const newDataStr = JSON.stringify(newData);
    const originalDataStr = JSON.stringify(file.originalData);
    
    file.data = newData;
    const wasDirty = file.isDirty;
    file.isDirty = newDataStr !== originalDataStr;
    file.lastModified = Date.now();

    if (wasDirty !== file.isDirty) {
      console.log(`FileRegistry: ${fileId} dirty state changed:`, wasDirty, '→', file.isDirty);
      console.log('  oldData === newData:', oldDataStr === newDataStr);
      console.log('  newData === original:', newDataStr === originalDataStr);
      if (newDataStr !== originalDataStr && oldDataStr === newDataStr) {
        console.warn('  ⚠️ File marked dirty on first load! Data was modified during initial load.');
      }
    }

    // Update in IndexedDB
    await db.files.put(file);

    // Notify all listeners
    this.notifyListeners(fileId, file);
  }

  /**
   * Mark file as saved
   */
  async markSaved(fileId: string): Promise<void> {
    const file = this.files.get(fileId);
    if (!file) return;

    file.originalData = structuredClone(file.data);
    file.isDirty = false;
    file.lastSaved = Date.now();

    await db.files.put(file);
    this.notifyListeners(fileId, file);
  }

  /**
   * Revert file to original data
   */
  async revertFile(fileId: string): Promise<void> {
    const file = this.files.get(fileId);
    if (!file) return;

    file.data = structuredClone(file.originalData);
    file.isDirty = false;
    file.lastModified = Date.now();

    await db.files.put(file);
    this.notifyListeners(fileId, file);
  }

  /**
   * Add a tab to the file's view list
   */
  async addViewTab(fileId: string, tabId: string): Promise<void> {
    const file = this.files.get(fileId);
    if (!file) return;

    if (!file.viewTabs.includes(tabId)) {
      file.viewTabs.push(tabId);
      await db.files.put(file);
    }
  }

  /**
   * Remove a tab from the file's view list
   */
  async removeViewTab(fileId: string, tabId: string): Promise<void> {
    const file = this.files.get(fileId);
    if (!file) return;

    file.viewTabs = file.viewTabs.filter(id => id !== tabId);

    // If no tabs are viewing this file, remove completely
    if (file.viewTabs.length === 0) {
      console.log(`FileRegistry: No more views of ${fileId}, removing from registry and DB`);
      
      // Notify listeners BEFORE deleting (so Navigator can update)
      // Pass null to indicate file is being deleted
      const callbacks = this.listeners.get(fileId);
      if (callbacks) {
        callbacks.forEach(callback => callback(null as any));
      }
      
      this.files.delete(fileId);
      this.listeners.delete(fileId);
      await db.files.delete(fileId);
    } else {
      // Still has views, just update
      await db.files.put(file);
    }
  }

  /**
   * Subscribe to file changes
   */
  subscribe(fileId: string, callback: (file: FileState) => void): () => void {
    if (!this.listeners.has(fileId)) {
      this.listeners.set(fileId, new Set());
    }
    
    this.listeners.get(fileId)!.add(callback);

    // Return unsubscribe function
    return () => {
      const callbacks = this.listeners.get(fileId);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.listeners.delete(fileId);
        }
      }
    };
  }

  /**
   * Notify all listeners of a file change
   */
  private notifyListeners(fileId: string, file: FileState): void {
    const callbacks = this.listeners.get(fileId);
    if (callbacks) {
      callbacks.forEach(callback => callback(file));
    }
  }

  /**
   * Get all dirty files
   */
  getDirtyFiles(): FileState[] {
    return Array.from(this.files.values()).filter(file => file.isDirty);
  }

  /**
   * Get file by ID
   */
  getFile(fileId: string): FileState | undefined {
    return this.files.get(fileId);
  }

  /**
   * Restore file from database
   * Used when loading persisted tabs
   */
  async restoreFile(fileId: string): Promise<FileState | null> {
    const fileInDb = await db.files.get(fileId);
    if (fileInDb) {
      this.files.set(fileId, fileInDb);
      this.notifyListeners(fileId, fileInDb);
      return fileInDb;
    }
    return null;
  }
}

// Create singleton instance
const fileRegistry = new FileRegistry();

/**
 * Use FileRegistry hook - direct access to registry
 */
export function useFileRegistry(): FileRegistry {
  return fileRegistry;
}

/**
 * Tab Context
 */
interface TabContextValue {
  tabs: TabState[];
  activeTabId: string | null;
  operations: TabOperations;
}

const TabContext = createContext<TabContextValue | null>(null);

/**
 * Tab Provider
 */
export function TabProvider({ children }: { children: React.ReactNode }) {
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const { showConfirm } = useDialog();

  // Load tabs from IndexedDB on mount
  useEffect(() => {
    loadTabsFromDB();
  }, []);

  /**
   * Load tabs from IndexedDB
   */
  const loadTabsFromDB = async () => {
    const savedTabs = await db.tabs.toArray();
    console.log(`TabContext: Loading ${savedTabs.length} tabs from IndexedDB:`, savedTabs.map(t => t.id));
    
    // Load file data for each tab
    for (const tab of savedTabs) {
      const restored = await fileRegistry.restoreFile(tab.fileId);
      if (restored) {
        console.log(`TabContext: Restored file data for ${tab.fileId}`);
      } else {
        console.warn(`TabContext: No file data found for ${tab.fileId}, tab may not load correctly`);
      }
    }
    
    setTabs(savedTabs);

    const appState = await db.getAppState();
    if (appState?.activeTabId) {
      setActiveTabId(appState.activeTabId);
    }
  };

  /**
   * Open a tab
   */
  const openTab = useCallback(async (
    item: RepositoryItem, 
    viewMode: ViewMode = 'interactive'
  ): Promise<void> => {
    const fileId = `${item.type}-${item.id}`;
    const tabId = `tab-${fileId}-${viewMode}`;

    // Check if tab already exists
    const existingTab = tabs.find(t => t.id === tabId);
    if (existingTab) {
      setActiveTabId(tabId);
      await db.saveAppState({ activeTabId: tabId });
      return;
    }

    // Load actual data from repository
    let data: any = {};
    
    try {
      if (item.type === 'graph') {
        console.log(`TabContext: Loading graph ${item.name}...`);
        const { graphGitService } = await import('../services/graphGitService');
        const result = await graphGitService.getGraph(item.name, 'main');
        console.log(`TabContext: Graph load result:`, result);
        if (result.success && result.data) {
          data = result.data.content;
          console.log(`TabContext: Loaded graph data with ${data.nodes?.length || 0} nodes`);
        } else {
          console.warn(`TabContext: Graph load failed or no data`);
        }
      } else if (item.type === 'parameter' || item.type === 'context' || item.type === 'case') {
        console.log(`TabContext: Loading ${item.type} ${item.name}...`);
        const { paramRegistryService } = await import('../services/paramRegistryService');
        
        // Configure the service for <private-repo> repository
        paramRegistryService.setConfig({
          source: 'git',
          gitBasePath: '',
          gitBranch: 'main',
          gitRepoOwner: 'gjbm2',
          gitRepoName: '<private-repo>'
        });
        
        // Load based on type
        try {
          if (item.type === 'parameter') {
            data = await paramRegistryService.loadParameter(item.id);
          } else if (item.type === 'context') {
            data = await paramRegistryService.loadContext(item.id);
          } else if (item.type === 'case') {
            data = await paramRegistryService.loadCase(item.id);
          }
          console.log(`TabContext: Loaded ${item.type} data:`, data);
        } catch (loadError) {
          console.error(`TabContext: Failed to load ${item.type}:`, loadError);
          // For now, use empty object with error flag
          data = { 
            _loadError: true,
            _errorMessage: String(loadError),
            _fileId: item.id
          };
        }
      }
    } catch (error) {
      console.error('Failed to load file:', error);
      data = { error: 'Failed to load file' };
    }
    
    const file = await fileRegistry.getOrCreateFile(
      fileId,
      item.type,
      {
        repository: '<private-repo>',
        path: item.path,
        branch: 'main'
      },
      data
    );

    // Create new tab
    const newTab: TabState = {
      id: tabId,
      fileId,
      viewMode,
      title: getTabTitle(item.name, viewMode),
      icon: getIconForType(item.type),
      closable: true,
      group: 'main-content'
    };

    // Add to registry
    await fileRegistry.addViewTab(fileId, tabId);

    // Add to tabs
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(tabId);

    // Persist to IndexedDB
    await db.tabs.add(newTab);
    await db.saveAppState({ activeTabId: tabId });
  }, [tabs]);

  /**
   * Close a tab
   */
  const closeTab = useCallback(async (
    tabId: string, 
    force: boolean = false
  ): Promise<boolean> => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) {
      console.log(`closeTab: Tab ${tabId} not found`);
      return false;
    }

    const file = fileRegistry.getFile(tab.fileId);
    
    // Check if this is the last tab viewing this file
    const isLastView = file && file.viewTabs.length === 1 && file.viewTabs[0] === tabId;
    
    console.log(`closeTab: ${tabId}, isDirty: ${file?.isDirty}, isLastView: ${isLastView}, viewTabs: ${file?.viewTabs.length}, force: ${force}`);
    
    // Check if file is dirty and this is the last view (unless forced)
    if (!force && file?.isDirty && isLastView) {
      const fileName = tab.title.replace(/ \(.*\)$/, ''); // Remove view mode suffix
      console.log(`closeTab: Showing confirmation for dirty file ${fileName}`);
      
      const confirmed = await showConfirm({
        title: 'Unsaved Changes',
        message: `"${fileName}" has unsaved changes.\n\nThis is the last open view of this file.\n\nDo you want to discard your changes?`,
        confirmLabel: 'Discard Changes',
        cancelLabel: 'Keep Editing',
        confirmVariant: 'danger'
      });
      
      if (!confirmed) {
        console.log(`closeTab: User cancelled close`);
        return false;
      }
      
      // User chose to discard - revert the file
      console.log(`closeTab: Discarding changes to ${tab.fileId}`);
      await fileRegistry.revertFile(tab.fileId);
      
      // Clean up the graph store if this is a graph file
      if (file.type === 'graph') {
        const { cleanupGraphStore } = await import('./GraphStoreContext');
        cleanupGraphStore(tab.fileId);
      }
    }

    // Remove from registry
    await fileRegistry.removeViewTab(tab.fileId, tabId);

    // Remove from tabs
    setTabs(prev => prev.filter(t => t.id !== tabId));

    // Update active tab if needed
    if (activeTabId === tabId) {
      const remainingTabs = tabs.filter(t => t.id !== tabId);
      setActiveTabId(remainingTabs.length > 0 ? remainingTabs[remainingTabs.length - 1].id : null);
    }

    // Remove from IndexedDB
    console.log(`TabContext: Deleting tab ${tabId} from IndexedDB`);
    await db.tabs.delete(tabId);
    
    // Verify deletion
    const stillExists = await db.tabs.get(tabId);
    console.log(`TabContext: Tab ${tabId} still exists after delete:`, !!stillExists);

    return true;
  }, [tabs, activeTabId, showConfirm]);

  /**
   * Switch to a tab
   */
  const switchTab = useCallback(async (tabId: string): Promise<void> => {
    if (tabs.find(t => t.id === tabId)) {
      setActiveTabId(tabId);
      await db.saveAppState({ activeTabId: tabId });
    }
  }, [tabs]);

  /**
   * Update tab data
   */
  const updateTabData = useCallback(async (
    fileId: string, 
    newData: any
  ): Promise<void> => {
    await fileRegistry.updateFile(fileId, newData);
  }, []);

  /**
   * Get dirty tabs
   */
  const getDirtyTabs = useCallback((): TabState[] => {
    const dirtyFiles = fileRegistry.getDirtyFiles();
    const dirtyFileIds = new Set(dirtyFiles.map(f => f.fileId));
    return tabs.filter(tab => dirtyFileIds.has(tab.fileId));
  }, [tabs]);

  /**
   * Save a tab
   */
  const saveTab = useCallback(async (tabId: string): Promise<void> => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    const file = fileRegistry.getFile(tab.fileId);
    if (!file) return;

    // TODO: Implement actual save to repository
    console.log('Saving file:', file);

    await fileRegistry.markSaved(tab.fileId);
  }, [tabs]);

  /**
   * Save all dirty tabs
   */
  const saveAll = useCallback(async (): Promise<void> => {
    const dirtyTabs = getDirtyTabs();
    await Promise.all(dirtyTabs.map(tab => saveTab(tab.id)));
  }, [getDirtyTabs, saveTab]);

  /**
   * Revert a tab
   */
  const revertTab = useCallback(async (tabId: string): Promise<void> => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    await fileRegistry.revertFile(tab.fileId);
  }, [tabs]);

  /**
   * Open in new view
   */
  const openInNewView = useCallback(async (
    tabId: string, 
    viewMode: ViewMode
  ): Promise<void> => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    const file = fileRegistry.getFile(tab.fileId);
    if (!file) return;

    // Create new tab with different view mode
    const newTabId = `tab-${tab.fileId}-${viewMode}`;
    
    // Check if already exists
    if (tabs.find(t => t.id === newTabId)) {
      setActiveTabId(newTabId);
      return;
    }

    const newTab: TabState = {
      id: newTabId,
      fileId: tab.fileId,
      viewMode,
      title: getTabTitle(tab.title.split(' (')[0], viewMode),
      icon: tab.icon,
      closable: true,
      group: 'main-content'
    };

    await fileRegistry.addViewTab(tab.fileId, newTabId);
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTabId);
    await db.tabs.add(newTab);
  }, [tabs]);

  /**
   * Commit files
   */
  const commitFiles = useCallback(async (request: CommitRequest): Promise<void> => {
    // TODO: Implement actual git commit
    console.log('Committing files:', request);

    // Mark all files as saved
    await Promise.all(
      request.files.map(f => fileRegistry.markSaved(f.fileId))
    );
  }, []);

  const operations: TabOperations = {
    openTab,
    closeTab,
    switchTab,
    updateTabData,
    getDirtyTabs,
    saveTab,
    saveAll,
    revertTab,
    openInNewView,
    commitFiles
  };

  return (
    <TabContext.Provider value={{ tabs, activeTabId, operations }}>
      {children}
    </TabContext.Provider>
  );
}

/**
 * Use Tab Context hook
 */
export function useTabContext(): TabContextValue {
  const context = useContext(TabContext);
  if (!context) {
    throw new Error('useTabContext must be used within TabProvider');
  }
  return context;
}

/**
 * Use file state hook - subscribe to file changes
 */
export function useFileState<T = any>(fileId: string): {
  data: T | null;
  isDirty: boolean;
  updateData: (newData: T) => void;
} {
  const [file, setFile] = useState<FileState<T> | null>(null);

  useEffect(() => {
    console.log(`useFileState: Setting up for ${fileId}`);
    
    // Get initial file state if it exists
    const initialFile = fileRegistry.getFile(fileId);
    if (initialFile) {
      console.log(`useFileState: Found initial file for ${fileId}`, initialFile.data);
      setFile(initialFile as FileState<T>);
    } else {
      console.log(`useFileState: No initial file for ${fileId}, waiting for notification`);
    }

    // Subscribe to changes (will be notified when file is created/loaded/deleted)
    const unsubscribe = fileRegistry.subscribe(fileId, (updatedFile) => {
      if (updatedFile === null) {
        console.log(`useFileState: File ${fileId} was deleted`);
        setFile(null);
      } else {
        console.log(`useFileState: Received update for ${fileId}`, updatedFile.data);
        setFile(updatedFile as FileState<T>);
      }
    });

    return unsubscribe;
  }, [fileId]);

  const updateData = useCallback((newData: T) => {
    fileRegistry.updateFile(fileId, newData);
  }, [fileId]);

  return {
    data: file?.data ?? null,
    isDirty: file?.isDirty ?? false,
    updateData
  };
}

/**
 * Helper: Get tab title with view mode suffix
 */
function getTabTitle(name: string, viewMode: ViewMode): string {
  if (viewMode === 'raw-json') return `${name} (JSON)`;
  if (viewMode === 'raw-yaml') return `${name} (YAML)`;
  return name;
}

/**
 * Helper: Get icon for object type
 */
function getIconForType(type: string): string {
  const icons: Record<string, string> = {
    graph: '📊',
    parameter: '📋',
    context: '📄',
    case: '🗂',
    settings: '⚙️',
    about: 'ℹ️'
  };
  return icons[type] || '📄';
}

