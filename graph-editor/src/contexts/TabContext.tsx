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
 * Serialize editorState for IndexedDB storage
 * Converts Set objects to arrays (IndexedDB doesn't support Set)
 */
function serializeEditorState(editorState: any): any {
  if (!editorState) return editorState;
  
  const serialized = { ...editorState };
  
  // Convert conditionalOverrides from Record<string, Set<string>> to Record<string, string[]>
  if (serialized.conditionalOverrides) {
    const serializedConditional: Record<string, string[]> = {};
    Object.entries(serialized.conditionalOverrides).forEach(([key, value]) => {
      serializedConditional[key] = value instanceof Set ? Array.from(value) : value as string[];
    });
    serialized.conditionalOverrides = serializedConditional;
  }
  
  // Convert hiddenNodes from Set<string> to string[]
  if (serialized.hiddenNodes) {
    serialized.hiddenNodes = serialized.hiddenNodes instanceof Set ? Array.from(serialized.hiddenNodes) : serialized.hiddenNodes;
  }
  
  return serialized;
}

/**
 * Deserialize editorState from IndexedDB
 * Converts arrays back to Set objects
 */
function deserializeEditorState(editorState: any): any {
  if (!editorState) return editorState;
  
  const deserialized = { ...editorState };
  
  // Convert conditionalOverrides from Record<string, string[]> to Record<string, Set<string>>
  if (deserialized.conditionalOverrides) {
    const deserializedConditional: Record<string, Set<string>> = {};
    Object.entries(deserialized.conditionalOverrides).forEach(([key, value]) => {
      deserializedConditional[key] = Array.isArray(value) ? new Set(value) : value as Set<string>;
    });
    deserialized.conditionalOverrides = deserializedConditional;
  }
  
  // Convert hiddenNodes from string[] to Set<string>
  if (deserialized.hiddenNodes) {
    deserialized.hiddenNodes = Array.isArray(deserialized.hiddenNodes) ? new Set(deserialized.hiddenNodes) : deserialized.hiddenNodes;
  }
  
  return deserialized;
}

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
          isDirty: source?.repository === 'local', // Local files are dirty by default
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
      
      // Emit dirty state change event for newly created local files
      if (file.isDirty) {
        window.dispatchEvent(new CustomEvent('dagnet:fileDirtyChanged', { 
          detail: { fileId, isDirty: file.isDirty } 
        }));
      }
    }
    
    return file;
  }

  /**
   * Update file data
   */
  async updateFile(fileId: string, newData: any): Promise<void> {
    const file = this.files.get(fileId);
    if (!file) {
      console.warn(`FileRegistry: File ${fileId} not found for update (may have been closed)`);
      return;
    }

    const oldDataStr = JSON.stringify(file.data);
    const newDataStr = JSON.stringify(newData);
    const originalDataStr = JSON.stringify(file.originalData);
    
    file.data = newData;
    const wasDirty = file.isDirty;
    
    // Special handling for settings and credentials files - they are always persisted immediately
    // so they should never be marked as dirty
    if (fileId === 'settings-settings' || fileId === 'credentials-credentials') {
      file.isDirty = false;
      // Update originalData to match current data since these are auto-saved
      file.originalData = structuredClone(newData);
    } else {
      file.isDirty = newDataStr !== originalDataStr;
    }
    
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
    
    // Emit dirty state change event for UI updates
    if (wasDirty !== file.isDirty) {
      window.dispatchEvent(new CustomEvent('dagnet:fileDirtyChanged', { 
        detail: { fileId, isDirty: file.isDirty } 
      }));
    }
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
    
    // Fire custom event so tab indicators can update
    window.dispatchEvent(new CustomEvent('dagnet:fileDirtyChanged', { 
      detail: { fileId, isDirty: false } 
    }));
  }

  /**
   * Revert file to original data
   */
  async revertFile(fileId: string): Promise<void> {
    const file = this.files.get(fileId);
    if (!file) return;

    console.log(`FileRegistry: Reverting ${fileId} to original data`);
    const wasDirty = file.isDirty;
    file.data = structuredClone(file.originalData);
    file.isDirty = false;
    file.lastModified = Date.now();

    await db.files.put(file);
    
    // Emit dirty state change event for UI updates (tab indicators)
    if (wasDirty !== file.isDirty) {
      window.dispatchEvent(new CustomEvent('dagnet:fileDirtyChanged', { 
        detail: { fileId, isDirty: file.isDirty } 
      }));
    }
    
    // Notify listeners - this will add the reverted state to editor history naturally
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
   * 
   * NOTE: Files are NEVER deleted when tabs close. They persist in IndexedDB
   * as part of the local workspace. This allows:
   * - Files to remain dirty when tabs close
   * - Index files to stay loaded even when not viewed
   * - Credentials/settings to persist
   * - Proper workspace model where files != tabs
   */
  async removeViewTab(fileId: string, tabId: string): Promise<void> {
    const file = this.files.get(fileId);
    if (!file) return;

    file.viewTabs = file.viewTabs.filter(id => id !== tabId);
    
    // NEVER delete file - just update view tabs
    // Files persist in workspace regardless of open tabs
    await db.files.put(file);
    
    console.log(`FileRegistry: Removed tab ${tabId} from ${fileId}, file persists in workspace`);
  }
  
  /**
   * Explicitly delete a file from workspace
   * This is a deliberate user action (File > Delete, context menu delete, etc.)
   * NOT called automatically when tabs close
   */
  async deleteFile(fileId: string): Promise<void> {
    const file = this.files.get(fileId);
    if (!file) return;
    
    // Check for open tabs
    if (file.viewTabs.length > 0) {
      throw new Error('Cannot delete file with open tabs. Close all tabs first.');
    }
    
    // Check if dirty (optional - could allow with confirmation)
    if (file.isDirty) {
      throw new Error('Cannot delete dirty file. Commit or revert changes first.');
    }
    
    console.log(`FileRegistry: Explicitly deleting ${fileId} from workspace`);
    
    // Notify listeners BEFORE deleting
    const callbacks = this.listeners.get(fileId);
    if (callbacks) {
      callbacks.forEach(callback => callback(null as any));
    }
    
    // Remove from registry and IDB
    this.files.delete(fileId);
    this.listeners.delete(fileId);
    await db.files.delete(fileId);
    
    // Update index file to remove entry
    const [type] = fileId.split('-');
    if (type === 'parameter' || type === 'context' || type === 'case' || type === 'node') {
      await this.updateIndexOnDelete(type as any, fileId);
    }
  }

  /**
   * Update index file when a new item is created
   * Called automatically when creating parameters, contexts, cases, or nodes
   */
  async updateIndexOnCreate(type: 'parameter' | 'context' | 'case' | 'node', itemId: string, metadata?: any): Promise<void> {
    const indexFileId = `${type}-index`;
    const indexFileName = `${type}s-index.yaml`;
    
    try {
      // Load or create index file
      let indexFile = this.getFile(indexFileId);
      
      if (!indexFile) {
        // Create new index file
        indexFile = {
          fileId: indexFileId,
          type: type,
          name: indexFileName,
          path: `${type}s/${indexFileName}`,
          data: {
            version: '1.0.0',
            entries: []
          },
          isDirty: false,
          isLoaded: true,
          viewTabs: [],
          lastOpened: Date.now(),
          lastModified: Date.now()
        };
        this.files.set(indexFileId, indexFile);
      }
      
      // Ensure data structure exists
      if (!indexFile.data) {
        indexFile.data = { version: '1.0.0', entries: [] };
      }
      
      // Add entry to index
      const entries = indexFile.data.entries || [];
      const newEntry = {
        id: itemId.replace(`${type}-`, ''),
        file_path: `${type}s/${itemId.replace(`${type}-`, '')}.yaml`,
        status: 'active',
        created_at: new Date().toISOString(),
        ...metadata
      };
      
      entries.push(newEntry);
      indexFile.data = {
        ...indexFile.data,
        entries
      };
      indexFile.isDirty = true;
      indexFile.lastModified = Date.now();
      
      // Save to IDB
      await db.files.put(indexFile);
      
      // Notify listeners
      this.notifyListeners(indexFileId, indexFile);
      
      console.log(`FileRegistry: Added ${itemId} to ${type} index`);
    } catch (error) {
      console.error(`FileRegistry: Failed to update index on create:`, error);
    }
  }

  /**
   * Update index file when an item is deleted
   * Called automatically when deleting parameters, contexts, cases, or nodes
   */
  async updateIndexOnDelete(type: 'parameter' | 'context' | 'case' | 'node', itemId: string): Promise<void> {
    const indexFileId = `${type}-index`;
    
    try {
      const indexFile = this.getFile(indexFileId);
      if (!indexFile || !indexFile.data?.entries) {
        console.warn(`FileRegistry: No index file found for ${type}`);
        return;
      }
      
      // Remove entry from index
      const itemIdBase = itemId.replace(`${type}-`, '');
      const entries = indexFile.data.entries.filter((entry: any) => entry.id !== itemIdBase);
      
      indexFile.data = {
        ...indexFile.data,
        entries
      };
      indexFile.isDirty = true;
      indexFile.lastModified = Date.now();
      
      // Save to IDB
      await db.files.put(indexFile);
      
      // Notify listeners
      this.notifyListeners(indexFileId, indexFile);
      
      console.log(`FileRegistry: Removed ${itemId} from ${type} index`);
    } catch (error) {
      console.error(`FileRegistry: Failed to update index on delete:`, error);
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
      console.log(`FileRegistry: Notifying ${callbacks.size} listeners for ${fileId}`);
      // Create COMPLETELY NEW objects to ensure React detects changes
      // Deep clone the data to create new object references at all levels
      const fileCopy: FileState = {
        ...file,
        data: JSON.parse(JSON.stringify(file.data)) // Deep clone = new references everywhere
      };
      console.log(`FileRegistry: Calling ${callbacks.size} callbacks with NEW data object`);
      callbacks.forEach(callback => callback(fileCopy));
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
export const fileRegistry = new FileRegistry();

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

  // Load tabs from IndexedDB on mount and initialize credentials
  useEffect(() => {
    loadTabsFromDB();
    initializeCredentials();
    loadFromURLData();
  }, []);

  /**
   * Initialize credentials file from schema defaults if it doesn't exist
   */
  const initializeCredentials = async () => {
    const credentialsFileId = 'credentials-credentials';
    const existingFile = fileRegistry.getFile(credentialsFileId);
    
    if (!existingFile) {
      // Check if credentials are loaded from URL - if so, don't create a file
      const { credentialsManager } = await import('../lib/credentials');
      const credentialsResult = await credentialsManager.loadCredentials();
      
      if (credentialsResult.success && credentialsResult.source === 'url') {
        console.log('TabContext: Credentials loaded from URL, skipping file creation');
        return;
      }
      
      // Create credentials file with empty data - defaults come from schema
      console.log('TabContext: Creating credentials file from schema defaults');
      await fileRegistry.getOrCreateFile(credentialsFileId, 'credentials', { repository: 'local', path: 'credentials.yaml', branch: 'main' }, {
        version: '1.0.0',
        defaultGitRepo: '',
        git: []
      });
    }
  };

  /**
   * Load graph data from URL parameters (?data=... or ?graph=...)
   */
  const loadFromURLData = async () => {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      
      // Handle ?data parameter (compressed/uncompressed JSON)
      const dataParam = urlParams.get('data');
      if (dataParam) {
        const { decodeStateFromUrl } = await import('../lib/shareUrl');
        const urlData = decodeStateFromUrl();
        
        if (urlData) {
          console.log('TabContext: Loading graph data from ?data parameter');
          
        // Create a temporary graph item for the URL data
        const tempItem: RepositoryItem = {
          id: `url-data-${Date.now()}`,
          name: 'Shared Graph',
          type: 'graph',
          path: 'url-data'
        };
          
        // Create file in registry with URL data
        const fileId = `graph-${tempItem.id}`;
        await fileRegistry.getOrCreateFile(fileId, 'graph', { repository: 'url', path: 'url-data', branch: 'main' }, urlData);
          
          // Open tab with the URL data
          await openTab(tempItem, 'interactive', true);
          
          // Clean up URL parameter
          const url = new URL(window.location.href);
          url.searchParams.delete('data');
          window.history.replaceState({}, document.title, url.toString());
          
          console.log('TabContext: Successfully loaded graph from ?data parameter');
        }
        return;
      }
      
      // Handle ?graph parameter (graph name from default repo)
      const graphName = urlParams.get('graph');
      if (graphName) {
        console.log(`TabContext: Loading graph '${graphName}' from default repo`);
        
        // Create a graph item for the named graph
        const graphItem: RepositoryItem = {
          id: graphName,
          name: graphName,
          type: 'graph',
          path: `graphs/${graphName}.json`
        };
        
        // Open tab with the named graph
        await openTab(graphItem, 'interactive', true);
        
        // Clean up URL parameter
        const url = new URL(window.location.href);
        url.searchParams.delete('graph');
        window.history.replaceState({}, document.title, url.toString());
        
        console.log(`TabContext: Successfully opened graph '${graphName}'`);
        return;
      }
      
      // Handle ?parameter parameter (parameter name from default repo)
      const parameterName = urlParams.get('parameter');
      if (parameterName) {
        console.log(`TabContext: Loading parameter '${parameterName}' from default repo`);
        
        const parameterItem: RepositoryItem = {
          id: parameterName,
          name: parameterName,
          type: 'parameter',
          path: `parameters/${parameterName}.yaml`
        };
        
        await openTab(parameterItem, 'interactive', true);
        
        const url = new URL(window.location.href);
        url.searchParams.delete('parameter');
        window.history.replaceState({}, document.title, url.toString());
        
        console.log(`TabContext: Successfully opened parameter '${parameterName}'`);
        return;
      }
      
      // Handle ?context parameter (context name from default repo)
      const contextName = urlParams.get('context');
      if (contextName) {
        console.log(`TabContext: Loading context '${contextName}' from default repo`);
        
        const contextItem: RepositoryItem = {
          id: contextName,
          name: contextName,
          type: 'context',
          path: `contexts/${contextName}.yaml`
        };
        
        await openTab(contextItem, 'interactive', true);
        
        const url = new URL(window.location.href);
        url.searchParams.delete('context');
        window.history.replaceState({}, document.title, url.toString());
        
        console.log(`TabContext: Successfully opened context '${contextName}'`);
        return;
      }
      
      // Handle ?case parameter (case name from default repo)
      const caseName = urlParams.get('case');
      if (caseName) {
        console.log(`TabContext: Loading case '${caseName}' from default repo`);
        
        const caseItem: RepositoryItem = {
          id: caseName,
          name: caseName,
          type: 'case',
          path: `cases/${caseName}.yaml`
        };
        
        await openTab(caseItem, 'interactive', true);
        
        const url = new URL(window.location.href);
        url.searchParams.delete('case');
        window.history.replaceState({}, document.title, url.toString());
        
        console.log(`TabContext: Successfully opened case '${caseName}'`);
        return;
      }
    } catch (error) {
      console.error('TabContext: Failed to load data from URL:', error);
    }
  };

  /**
   * Load tabs from IndexedDB
   * Error handling is in db wrapper - if it fails, DB gets nuked and page reloads
   */
  const loadTabsFromDB = async () => {
    const savedTabs = await db.tabs.toArray();
    console.log(`TabContext: Loading ${savedTabs.length} tabs from IndexedDB:`, savedTabs.map(t => t.id));
    
    // Deserialize editorState for each tab (convert arrays back to Sets)
    const deserializedTabs = savedTabs.map(tab => ({
      ...tab,
      editorState: deserializeEditorState(tab.editorState)
    }));
    
    // Load file data for each tab
    for (const tab of deserializedTabs) {
      const restored = await fileRegistry.restoreFile(tab.fileId);
      if (restored) {
        console.log(`TabContext: Restored file data for ${tab.fileId}`);
      }
    }
    
    setTabs(deserializedTabs);

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
    viewMode: ViewMode = 'interactive',
    forceNew: boolean = false
  ): Promise<void> => {
    const fileId = `${item.type}-${item.id}`;
    
    // Generate tab ID - add timestamp if forcing new tab to ensure uniqueness
    const tabId = forceNew 
      ? `tab-${fileId}-${viewMode}-${Date.now()}` 
      : `tab-${fileId}-${viewMode}`;

    // Check if tab already exists (skip if forceNew)
    if (!forceNew) {
      const existingTab = tabs.find(t => t.id === tabId);
      if (existingTab) {
        setActiveTabId(tabId);
        await db.saveAppState({ activeTabId: tabId });
        return;
      }
    }

    // Load actual data from repository
    let data: any = {};
    
    try {
      if (item.type === 'graph') {
        console.log(`TabContext: Loading graph ${item.name}...`);
        
        // Get the currently selected repository from NavigatorContext by reading from IndexedDB
        const appState = await db.appState.get('app-state');
        const selectedRepo = appState?.navigatorState?.selectedRepo;
        const selectedBranch = appState?.navigatorState?.selectedBranch || 'main';
        
        console.log(`TabContext: Loading from repo: ${selectedRepo}, branch: ${selectedBranch}`);
        
        // Load credentials to configure gitService
        const { credentialsManager } = await import('../lib/credentials');
        const credentialsResult = await credentialsManager.loadCredentials();
        
        if (credentialsResult.success && credentialsResult.credentials && selectedRepo) {
          console.log(`TabContext: Configuring gitService with credentials for repo: ${selectedRepo}`);
          // Configure gitService with credentials for the selected repository
          const { gitService } = await import('../services/gitService');
          const credentialsWithRepo = {
            ...credentialsResult.credentials,
            defaultGitRepo: selectedRepo
          };
          gitService.setCredentials(credentialsWithRepo);
        } else {
          console.warn('TabContext: No credentials or selected repo available for graph loading');
        }
        
        const { graphGitService } = await import('../services/graphGitService');
        const result = await graphGitService.getGraph(item.name, selectedBranch);
        console.log(`TabContext: Graph load result:`, result);
        if (result.success && result.data) {
          data = result.data.content;
          console.log(`TabContext: Loaded graph data with ${data.nodes?.length || 0} nodes`);
        } else {
          console.warn(`TabContext: Graph load failed or no data`);
        }
      } else if (item.type === 'parameter' || item.type === 'context' || item.type === 'case' || item.type === 'node') {
        console.log(`TabContext: Loading ${item.type} ${item.name}...`);
        const { paramRegistryService } = await import('../services/paramRegistryService');
        
        // Get the currently selected repository from NavigatorContext by reading from IndexedDB
        const appState = await db.appState.get('app-state');
        const selectedRepo = appState?.navigatorState?.selectedRepo;
        const selectedBranch = appState?.navigatorState?.selectedBranch || 'main';
        
        console.log(`TabContext: Loading ${item.type} from repo: ${selectedRepo}, branch: ${selectedBranch}`);
        
        // Load credentials to configure the service
        const { credentialsManager } = await import('../lib/credentials');
        const credentialsResult = await credentialsManager.loadCredentials();
        
        if (credentialsResult.success && credentialsResult.credentials && selectedRepo) {
          const gitCreds = credentialsResult.credentials.git.find(cred => cred.name === selectedRepo);
          if (gitCreds) {
            console.log(`TabContext: Configuring paramRegistryService with credentials for ${gitCreds.name}`);
            paramRegistryService.setConfig({
              source: 'git',
              gitBasePath: gitCreds.basePath || '',
              gitBranch: selectedBranch,
              gitRepoOwner: gitCreds.owner,
              gitRepoName: gitCreds.repo,
              gitToken: gitCreds.token
            });
          } else {
            console.warn(`TabContext: No git credentials found for repo: ${selectedRepo}`);
          }
        } else {
          console.warn('TabContext: No credentials or selected repo available for paramRegistryService');
        }
        
        // Load based on type
        try {
          if (item.type === 'parameter') {
            data = await paramRegistryService.loadParameter(item.id);
          } else if (item.type === 'context') {
            data = await paramRegistryService.loadContext(item.id);
          } else if (item.type === 'case') {
            data = await paramRegistryService.loadCase(item.id);
          } else if (item.type === 'node') {
            data = await paramRegistryService.loadNode(item.id);
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
      } else if (item.type === 'credentials') {
        console.log(`TabContext: Loading credentials ${item.name}...`);
        // Credentials are loaded from IndexedDB, no need to fetch from Git
        data = {};
      } else if (item.type === 'markdown') {
        console.log(`TabContext: Loading markdown ${item.name}...`);
        // Load markdown content from local docs
        try {
          const response = await fetch(`/docs/${item.id}.md`);
          if (response.ok) {
            const markdownContent = await response.text();
            data = { content: markdownContent };
          } else {
            console.warn(`TabContext: Could not load markdown file: ${item.id}.md`);
            data = { content: '# File Not Found\n\nThe requested markdown file could not be loaded.' };
          }
        } catch (error) {
          console.error(`TabContext: Error loading markdown file:`, error);
          data = { content: '# Error Loading File\n\nThere was an error loading the markdown file.' };
        }
      } else {
        console.warn(`TabContext: Unknown item type: ${item.type}`);
        data = {};
      }
    } catch (error) {
      console.error('Failed to load file:', error);
      data = { error: 'Failed to load file' };
    }
    
    const file = await fileRegistry.getOrCreateFile(
      fileId,
      item.type,
      {
        repository: 'local',
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
      title: getTabTitle(item.name, viewMode, item.type),
      icon: getIconForType(item.type),
      closable: true,
      group: 'main-content',
      // Initialize editor state for graph tabs
      editorState: viewMode === 'interactive' && fileId.startsWith('graph-') ? {
        useUniformScaling: false,
        massGenerosity: 0.5,
        autoReroute: true,
        sidebarOpen: true,
        whatIfOpen: false,
        propertiesOpen: true,
        jsonOpen: false,
        selectedNodeId: null,
        selectedEdgeId: null
      } : undefined
    };

    // Add to registry
    await fileRegistry.addViewTab(fileId, tabId);

    // Add to tabs
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(tabId);

    // Persist to IndexedDB (serialize Set objects)
    const serializedTab = {
      ...newTab,
      editorState: serializeEditorState(newTab.editorState)
    };
    await db.tabs.add(serializedTab as TabState);
    await db.saveAppState({ activeTabId: tabId });
  }, [tabs]);

  /**
   * Close a tab - SINGLE SOURCE OF TRUTH FOR CLOSING TABS
   * This is called by:
   * - Custom close button (✕)
   * - Context menu "Close"
   * - Keyboard shortcut (Cmd+W)
   * - "Close All" operations
   */
  const closeTab = useCallback(async (
    tabId: string, 
    force: boolean = false
  ): Promise<boolean> => {
    console.log(`\n=== CLOSE TAB: ${tabId} (force=${force}) ===`);
    
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) {
      console.warn(`closeTab: Tab ${tabId} not found in tabs array`);
      return false;
    }

    const file = fileRegistry.getFile(tab.fileId);
    const isLastView = file && file.viewTabs.length === 1 && file.viewTabs[0] === tabId;
    
    console.log(`closeTab: isDirty=${file?.isDirty}, isLastView=${isLastView}, viewTabs=${file?.viewTabs.length}`);
    
    // Check if file is dirty and this is the last view (unless forced)
    if (!force && file?.isDirty && isLastView) {
      const fileName = tab.title.replace(/ \(.*\)$/, '');
      console.log(`closeTab: Showing confirmation for dirty file ${fileName}`);
      
      const confirmed = await showConfirm({
        title: 'Unsaved Changes',
        message: `"${fileName}" has unsaved changes.\n\nDo you want to discard your changes?`,
        confirmLabel: 'Discard Changes',
        cancelLabel: 'Keep Editing',
        confirmVariant: 'danger'
      });
      
      if (!confirmed) {
        console.log(`closeTab: ❌ User cancelled close`);
        return false;
      }
      
      console.log(`closeTab: User confirmed discard, reverting ${tab.fileId}`);
      await fileRegistry.revertFile(tab.fileId);
      
      if (file.type === 'graph') {
        const { cleanupGraphStore } = await import('./GraphStoreContext');
        cleanupGraphStore(tab.fileId);
      }
    }

    // ATOMIC REMOVAL - all steps with proper state management
    console.log(`closeTab: Step 1 - Remove from file registry`);
    await fileRegistry.removeViewTab(tab.fileId, tabId);

    console.log(`closeTab: Step 2 - Calculate new active tab BEFORE state updates`);
    let newActiveId = activeTabId;
    if (activeTabId === tabId) {
      const remainingTabs = tabs.filter(t => t.id !== tabId);
      newActiveId = remainingTabs.length > 0 ? remainingTabs[remainingTabs.length - 1].id : null;
      console.log(`closeTab: Will switch activeTabId: ${activeTabId} -> ${newActiveId}`);
    }

    console.log(`closeTab: Step 3 - Update ALL state atomically`);
    setTabs(prev => prev.filter(t => t.id !== tabId));
    if (newActiveId !== activeTabId) {
      setActiveTabId(newActiveId);
      await db.saveAppState({ activeTabId: newActiveId || undefined });
    }

    console.log(`closeTab: Step 4 - Remove from IndexedDB`);
    await db.tabs.delete(tabId);
    
    console.log(`closeTab: Step 5 - Check if local file should be removed from navigator`);
    if (isLastView && file) {
      // Dispatch event to let NavigatorContext check if this is a local item
      // and remove it if needed
      window.dispatchEvent(new CustomEvent('dagnet:lastViewClosed', { 
        detail: { 
          fileId: tab.fileId,
          type: file.type
        } 
      }));
    }

    console.log(`closeTab: Step 6 - Signal rc-dock to destroy tab`);
    window.dispatchEvent(new CustomEvent('dagnet:tabClosed', { detail: { tabId } }));

    console.log(`closeTab: ✅ COMPLETED closing ${tabId}\n`);
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
   * Update tab-specific editor state
   */
  const updateTabState = useCallback(async (
    tabId: string,
    editorState: Partial<TabState['editorState']>
  ): Promise<void> => {
    setTabs(prev => prev.map(tab => 
      tab.id === tabId 
        ? { ...tab, editorState: { ...tab.editorState, ...editorState } }
        : tab
    ));
    
    // Persist to IndexedDB (serialize Set objects to arrays)
    const tab = tabs.find(t => t.id === tabId);
    if (tab) {
      const serializedState = serializeEditorState({ ...tab.editorState, ...editorState });
      await db.tabs.update(tabId, { 
        editorState: serializedState
      });
    }
  }, [tabs]);

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

    // Create new tab with UNIQUE ID (always force new, never reuse existing)
    const newTabId = `tab-${tab.fileId}-${viewMode}-${Date.now()}`;

    const newTab: TabState = {
      id: newTabId,
      fileId: tab.fileId,
      viewMode,
      title: getTabTitle(tab.title.split(' (')[0], viewMode, tab.fileId.split('-')[0]),
      icon: tab.icon,
      closable: true,
      group: 'main-content'
    };

    await fileRegistry.addViewTab(tab.fileId, newTabId);
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTabId);
    
    // Serialize before saving to IndexedDB
    const serializedTab = {
      ...newTab,
      editorState: serializeEditorState(newTab.editorState)
    };
    await db.tabs.add(serializedTab as TabState);
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

  /**
   * Hide a node
   */
  const hideNode = useCallback(async (tabId: string, nodeId: string): Promise<void> => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    const hiddenNodes = tab.editorState?.hiddenNodes || new Set<string>();
    hiddenNodes.add(nodeId);

    await updateTabState(tabId, { hiddenNodes });
  }, [tabs, updateTabState]);

  /**
   * Unhide a node
   */
  const unhideNode = useCallback(async (tabId: string, nodeId: string): Promise<void> => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    const hiddenNodes = tab.editorState?.hiddenNodes || new Set<string>();
    hiddenNodes.delete(nodeId);

    await updateTabState(tabId, { hiddenNodes });
  }, [tabs, updateTabState]);

  /**
   * Hide all unselected nodes
   */
  const hideUnselectedNodes = useCallback(async (tabId: string, selectedNodeIds: string[]): Promise<void> => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    // Get all node IDs from the graph
    const file = fileRegistry.getFile(tab.fileId);
    if (!file?.data?.nodes) return;

    const allNodeIds = file.data.nodes.map((node: any) => node.id);
    const selectedSet = new Set(selectedNodeIds);
    const nodesToHide = allNodeIds.filter((id: string) => !selectedSet.has(id));

    const hiddenNodes = new Set<string>(nodesToHide);
    await updateTabState(tabId, { hiddenNodes });
  }, [tabs, updateTabState]);

  /**
   * Show all nodes (unhide all)
   */
  const showAllNodes = useCallback(async (tabId: string): Promise<void> => {
    await updateTabState(tabId, { hiddenNodes: new Set<string>() });
  }, [updateTabState]);

  /**
   * Check if a node is hidden
   */
  const isNodeHidden = useCallback((tabId: string, nodeId: string): boolean => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return false;

    const hiddenNodes = tab.editorState?.hiddenNodes || new Set<string>();
    return hiddenNodes.has(nodeId);
  }, [tabs]);

  const operations: TabOperations = {
    openTab,
    closeTab,
    switchTab,
    updateTabData,
    updateTabState,
    getDirtyTabs,
    saveTab,
    saveAll,
    revertTab,
    openInNewView,
    commitFiles,
    hideNode,
    unhideNode,
    hideUnselectedNodes,
    showAllNodes,
    isNodeHidden
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
  originalData: T | null;
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
        console.log(`useFileState[${fileId}]: Received update notification, updating local state`);
        setFile(updatedFile as FileState<T>);
      }
    });

    return unsubscribe;
  }, [fileId]);

  const updateData = useCallback((newData: T) => {
    console.log(`useFileState.updateData[${fileId}]: Calling FileRegistry.updateFile`);
    fileRegistry.updateFile(fileId, newData);
  }, [fileId]);

  return {
    data: file?.data ?? null,
    originalData: file?.originalData ?? null,
    isDirty: file?.isDirty ?? false,
    updateData
  };
}

/**
 * Helper: Get tab title with view mode suffix
 */
function getTabTitle(name: string, viewMode: ViewMode, type?: string): string {
  // Strip file extension
  const nameWithoutExt = name.replace(/\.(yaml|yml|json)$/, '');
  
  // Don't add icon to title - rc-dock renders the icon separately from the tab.icon property
  // Adding it here would cause double icons
  
  // Add view mode suffix
  if (viewMode === 'raw-json') return `${nameWithoutExt} (JSON)`;
  if (viewMode === 'raw-yaml') return `${nameWithoutExt} (YAML)`;
  return nameWithoutExt;
}

/**
 * Helper: Get icon for object type
 */
function getIconForType(type: string): string {
  // Direct icon mapping - avoid circular imports
  const icons: Record<string, string> = {
    graph: '📊',
    parameter: '📋',
    context: '🏷️',
    case: '📦',
    settings: '⚙️',
    about: 'ℹ️'
  };
  return icons[type] || '📄';
}

