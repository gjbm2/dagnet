import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { NavigatorState, NavigatorOperations, RepositoryItem, ObjectType } from '../types';
import { db } from '../db/appDatabase';
import { credentialsManager } from '../lib/credentials';
import { gitConfig } from '../config/gitConfig';
import { workspaceService } from '../services/workspaceService';
import { fileRegistry } from './TabContext';
import { registryService } from '../services/registryService';

/**
 * Navigator Context
 */
interface NavigatorContextValue {
  state: NavigatorState;
  operations: NavigatorOperations;
  items: RepositoryItem[];
  isLoading: boolean;
}

const NavigatorContext = createContext<NavigatorContextValue | null>(null);

/**
 * Navigator Provider
 */
export function NavigatorProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<NavigatorState>({
    isOpen: true,  // Open by default
    isPinned: true, // Pinned by default
    searchQuery: '',
    selectedRepo: '',
    selectedBranch: '',
    expandedSections: ['graphs', 'parameters', 'contexts', 'cases', 'nodes'],
    availableRepos: [],
    availableBranches: [],
    
    // Filter and sort defaults
    viewMode: 'all',
    showLocalOnly: false,
    showDirtyOnly: false,
    showOpenOnly: false,
    sortBy: 'name',
    groupBySubCategories: true, // Enable by default
    groupByTags: false
  });

  const [items, setItems] = useState<RepositoryItem[]>([]);
  const [localItems, setLocalItems] = useState<RepositoryItem[]>([]); // Items not yet committed
  const [isLoading, setIsLoading] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);

  // Load state from IndexedDB and credentials on mount
  useEffect(() => {
    const initialize = async () => {
      console.log('🚀 NavigatorContext: Starting initialization...');
      const savedState = await loadStateFromDB();
      console.log('📁 NavigatorContext: State loaded from DB, now loading credentials...');
      await loadCredentialsAndUpdateRepo(savedState);
      console.log('✅ NavigatorContext: Initialization complete');
      setIsInitialized(true);
    };
    initialize();
  }, []);

  // Listen for file dirty state changes and trigger re-load
  useEffect(() => {
    const handleFileDirtyChanged = (event: any) => {
      const { fileId, isDirty } = event.detail;
      console.log(`🔄 NavigatorContext: File ${fileId} dirty state changed to ${isDirty}, triggering refresh...`);
      // Trigger a full reload of items to pick up dirty state changes
    if (state.selectedRepo && state.selectedBranch) {
      loadItems(state.selectedRepo, state.selectedBranch);
    }
    };

    window.addEventListener('dagnet:fileDirtyChanged', handleFileDirtyChanged);
    return () => {
      window.removeEventListener('dagnet:fileDirtyChanged', handleFileDirtyChanged);
    };
  }, [state.selectedRepo, state.selectedBranch]);

  // Save state to IndexedDB whenever it changes (but not on initial mount)
  useEffect(() => {
    if (isInitialized) {
      saveStateToDB();
    }
  }, [state, localItems, isInitialized]);

  /**
   * Load credentials and update selected repository
   */
  const loadCredentialsAndUpdateRepo = async (savedState: any) => {
    try {
      console.log('🔑 NavigatorContext: Loading credentials...');
      const result = await credentialsManager.loadCredentials();
      console.log('🔑 NavigatorContext: Credentials result:', result);
      
      if (result.success && result.credentials) {
        const availableRepos = result.credentials.git.map(repo => repo.name);
        const defaultRepo = result.credentials.defaultGitRepo || availableRepos[0];
        
        // Use saved repo if it exists and is valid, otherwise use default
        const savedRepoName = savedState?.selectedRepo;
        console.log(`🔑 NavigatorContext: Saved repo from DB: ${savedRepoName}`);
        console.log(`🔑 NavigatorContext: Available repos: ${availableRepos.join(', ')}`);
        console.log(`🔑 NavigatorContext: Default repo: ${defaultRepo}`);
        
        const repoToUse = savedRepoName && availableRepos.includes(savedRepoName) ? savedRepoName : defaultRepo;
        const gitCreds = result.credentials.git.find(repo => repo.name === repoToUse) || result.credentials.git[0];
        
        console.log(`🔑 NavigatorContext: Using repo: ${repoToUse}`);
        console.log(`🔑 NavigatorContext: Selected git creds:`, gitCreds);
        
        if (gitCreds) {
          console.log(`🔑 NavigatorContext: Updating repo to ${gitCreds.name} (${gitCreds.owner}/${gitCreds.repo})`);
          
          // Fetch branches for the selected repository
          console.log(`🔑 NavigatorContext: Fetching branches for ${gitCreds.name}...`);
          const branches = await fetchBranches(gitCreds.name);
          const selectedBranch = branches.includes('main') ? 'main' : branches[0] || gitCreds.branch || 'main';
          
          // Use saved branch if valid, otherwise use default
          const savedBranchName = savedState?.selectedBranch;
          const branchToUse = savedBranchName && branches.includes(savedBranchName) ? savedBranchName : selectedBranch;
          
          setState(prev => {
            const newState = {
              ...prev,
              selectedRepo: gitCreds.name,
              selectedBranch: branchToUse,
              availableRepos,
              availableBranches: branches
            };
            console.log('🔑 NavigatorContext: New state set:', newState);
            return newState;
          });
          
          // Don't call loadItems here - let useEffect handle it
          // This prevents duplicate calls and ensures consistent flow
        } else {
          console.log('🔑 NavigatorContext: No git credentials found');
          setState(prev => ({
            ...prev,
            availableRepos
          }));
        }
      } else {
        console.log('🔑 NavigatorContext: No credentials available:', result.error);
        setState(prev => ({
          ...prev,
          availableRepos: []
        }));
      }
    } catch (error) {
      console.error('🔑 NavigatorContext: Failed to load credentials:', error);
    }
  };

  /**
   * Load navigator state from IndexedDB
   * Error handling is in db wrapper - if it fails, DB gets nuked and page reloads
   */
  const loadStateFromDB = async () => {
    const appState = await db.getAppState();
    console.log('📁 NavigatorContext: Raw state from DB:', appState?.navigatorState);
    if (appState?.navigatorState) {
      const restoredState = {
        ...appState.navigatorState,
        searchQuery: '',
        selectedRepo: appState.navigatorState.selectedRepo || '',
        selectedBranch: appState.navigatorState.selectedBranch || ''
      };
      console.log('📁 NavigatorContext: Restoring state:', restoredState);
      console.log('📁 NavigatorContext: Saved selectedRepo:', appState.navigatorState.selectedRepo);
      setState(restoredState);
      
      // Restore local items
      if (appState.localItems) {
        console.log('📁 NavigatorContext: Restoring local items:', appState.localItems);
        setLocalItems(appState.localItems);
      }
      
      return restoredState;
    } else {
      console.log('📁 NavigatorContext: No saved state found in DB');
      return null;
    }
  };

  /**
   * Save navigator state to IndexedDB
   */
  const saveStateToDB = async () => {
    console.log('NavigatorContext: Saving state to DB:', state);
    await db.saveAppState({
      navigatorState: state,
      localItems: localItems
    });
  };

  /**
   * Toggle navigator open/closed
   */
  const toggleNavigator = useCallback(() => {
    setState(prev => {
      console.log('Navigator toggle:', { wasOpen: prev.isOpen, wasPinned: prev.isPinned });
      const newState = {
        ...prev,
        isOpen: !prev.isOpen,
        isPinned: !prev.isOpen ? prev.isPinned : false // Unpin when closing
      };
      console.log('Navigator new state:', { isOpen: newState.isOpen, isPinned: newState.isPinned });
      return newState;
    });
  }, []);

  /**
   * Toggle navigator pinned
   */
  const togglePin = useCallback(() => {
    setState(prev => ({
      ...prev,
      isPinned: !prev.isPinned,
      isOpen: true // Pinning implies opening
    }));
  }, []);

  /**
   * Set search query
   */
  const setSearchQuery = useCallback((query: string) => {
    setState(prev => ({
      ...prev,
      searchQuery: query
    }));
  }, []);

  /**
   * Fetch available branches for a repository
   */
  const fetchBranches = async (repo: string) => {
    try {
      const credentialsResult = await credentialsManager.loadCredentials();
      
      if (!credentialsResult.success || !credentialsResult.credentials) {
        console.log('NavigatorContext: No credentials available for fetching branches');
        return [];
      }

      const gitCreds = credentialsResult.credentials.git.find(cred => cred.name === repo);
      if (!gitCreds) {
        console.log(`NavigatorContext: No credentials found for repository ${repo}`);
        return [];
      }

      const { gitService } = await import('../services/gitService');
      // @ts-ignore - Dynamic import type inference issue
      const branchesResult = await gitService.getBranches(gitCreds.owner, gitCreds.repo, gitCreds.token);
      
      if (branchesResult.success && branchesResult.data) {
        const branches = branchesResult.data.map((branch: any) => branch.name);
        console.log(`NavigatorContext: Found branches for ${repo}:`, branches);
        return branches;
      }
      
      return [];
    } catch (error) {
      console.error('NavigatorContext: Failed to fetch branches:', error);
      return [];
    }
  };

  /**
   * Select repository
   */
  const selectRepository = useCallback(async (repo: string) => {
    console.log('🔄 NavigatorContext: selectRepository called with:', repo);
    setState(prev => {
      const newState = {
        ...prev,
        selectedRepo: repo,
        selectedBranch: '', // Clear selected branch when repo changes
        availableBranches: [] // Clear available branches
      };
      console.log('🔄 NavigatorContext: Updated state:', newState);
      return newState;
    });

    if (repo) {
      // Fetch branches for the selected repository
      const branches = await fetchBranches(repo);
      const selectedBranch = branches.includes('main') ? 'main' : branches[0] || '';
      
      setState(prev => ({
        ...prev,
        availableBranches: branches,
        selectedBranch
      }));

      // Load items for this repository with the selected branch
      await loadItems(repo, selectedBranch);
    }
  }, []);

  /**
   * Select branch
   */
  const selectBranch = useCallback(async (branch: string) => {
    setState(prev => ({
      ...prev,
      selectedBranch: branch
    }));

    // Reload items for new branch
    await loadItems(state.selectedRepo, branch);
  }, [state.selectedRepo]);

  /**
   * Expand a section
   */
  const expandSection = useCallback((section: string) => {
    setState(prev => {
      const newExpandedSections = [...prev.expandedSections, section];
      // Persist to localStorage for quick restore
      try {
        localStorage.setItem(`dagnet:navigator:expandedSections`, JSON.stringify(newExpandedSections));
      } catch (e) {
        console.warn('Failed to save expanded sections to localStorage:', e);
      }
      return {
      ...prev,
        expandedSections: newExpandedSections
      };
    });
  }, []);

  /**
   * Collapse a section
   */
  const collapseSection = useCallback((section: string) => {
    setState(prev => {
      const newExpandedSections = prev.expandedSections.filter(s => s !== section);
      // Persist to localStorage for quick restore
      try {
        localStorage.setItem(`dagnet:navigator:expandedSections`, JSON.stringify(newExpandedSections));
      } catch (e) {
        console.warn('Failed to save expanded sections to localStorage:', e);
      }
      return {
      ...prev,
        expandedSections: newExpandedSections
      };
    });
  }, []);

  /**
   * Load items from repository (workspace-based)
   * 
   * NEW IMPLEMENTATION:
   * 1. Check if workspace exists in IDB
   * 2. If not: Clone repo to IDB
   * 3. If yes: Load from IDB
   * 4. Build Navigator items from IDB files
   */
  /**
   * Load items from repository (workspace-based implementation)
   * 
   * NEW FLOW:
   * 1. Check if workspace exists in IDB
   * 2. If not: Clone repo to IDB
   * 3. Load from IDB (not Git API)
   * 4. Build Navigator items from FileStates
   */
  const loadItems = useCallback(async (repo: string, branch: string) => {
    console.log(`📦 WorkspaceService: loadItems called for ${repo}/${branch}`);
    if (!repo) {
      console.log('📦 WorkspaceService: No repo provided, skipping');
      return;
    }

    setIsLoading(true);
    
    try {
      // Get credentials
      const credentialsResult = await credentialsManager.loadCredentials();
      console.log('📦 WorkspaceService: Credentials check result:', credentialsResult);
      
      if (!credentialsResult.success || !credentialsResult.credentials) {
        console.log('📦 NavigatorContext: No credentials available, cannot load repository items');
        setIsLoading(false);
        return;
      }

      // Find the credentials for this repository
      const gitCreds = credentialsResult.credentials.git.find(cred => cred.name === repo);
      console.log(`📦 NavigatorContext: Looking for creds for repo ${repo}:`, gitCreds);
      
      if (!gitCreds) {
        console.log(`📦 NavigatorContext: No credentials found for repository ${repo}`);
        setIsLoading(false);
        return;
      }

      // Check if workspace exists
      const workspaceExists = await workspaceService.workspaceExists(repo, branch);
      
      if (!workspaceExists) {
        console.log(`🔄 WorkspaceService: Workspace ${repo}/${branch} doesn't exist, cloning...`);
        await workspaceService.cloneWorkspace(repo, branch, gitCreds);
      } else {
        console.log(`📦 WorkspaceService: Workspace ${repo}/${branch} exists, loading from IDB...`);
        await workspaceService.loadWorkspaceFromIDB(repo, branch);
      }

      // Get all files from workspace (IDB)
      let workspaceFiles = await workspaceService.getWorkspaceFiles(repo, branch);
      console.log(`📦 WorkspaceService: Loaded ${workspaceFiles.length} files from workspace`);
      
      // If workspace exists but has no files, force re-clone
      if (workspaceFiles.length === 0 && workspaceExists) {
        console.log(`⚠️ WorkspaceService: Workspace exists but is empty! Force re-cloning...`);
        await workspaceService.deleteWorkspace(repo, branch);
        await workspaceService.cloneWorkspace(repo, branch, gitCreds);
        workspaceFiles = await workspaceService.getWorkspaceFiles(repo, branch);
        console.log(`📦 WorkspaceService: Re-cloned, now have ${workspaceFiles.length} files`);
      }

      // Build RepositoryItem list from FileStates
      const items: RepositoryItem[] = workspaceFiles
        .filter(file => {
          // Exclude system files (credentials) and index files
          if (file.type === 'credentials') return false;
          if (file.fileId.endsWith('-index')) return false;
          return true;
        })
        .map(file => ({
          id: file.fileId.replace(`${file.type}-`, ''),
          fileId: file.fileId, // Store actual fileId so we don't have to reconstruct
          type: file.type,
          name: file.name || file.fileId,
          path: file.path || '',
          description: file.isLocal ? 'Local only (not committed)' : undefined,
          isLocal: file.isLocal
        }));
      
      // Load registry indexes from FileStates (not Git API)
      const parametersIndexFile = fileRegistry.getFile('parameter-index') || await db.files.get('parameter-index');
      const contextsIndexFile = fileRegistry.getFile('context-index') || await db.files.get('context-index');
      const casesIndexFile = fileRegistry.getFile('case-index') || await db.files.get('case-index');
      const nodesIndexFile = fileRegistry.getFile('node-index') || await db.files.get('node-index');

      console.log(`📦 WorkspaceService: Loaded ${workspaceFiles.length} files total, ${items.length} non-index items`);
      console.log(`📦 WorkspaceService: Items by type:`, items.reduce((acc, item) => {
        acc[item.type] = (acc[item.type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>));
      console.log(`📋 NavigatorContext: Index files:`, {
        parameters: parametersIndexFile?.data,
        contexts: contextsIndexFile?.data,
        cases: casesIndexFile?.data,
        nodes: nodesIndexFile?.data
      });
      
      setItems(items);
      
      // Update state with registry indexes
        setState(prev => ({
          ...prev,
          registryIndexes: {
          parameters: parametersIndexFile?.data || undefined,
          contexts: contextsIndexFile?.data || undefined,
          cases: casesIndexFile?.data || undefined,
          nodes: nodesIndexFile?.data || undefined
          }
        }));

    } catch (error) {
      console.error('Failed to load items:', error);
      setItems([]);
    } finally {
      setIsLoading(false);
    }
  }, []); // Empty deps - uses params, not external state

  // Load items when repo or branch changes
  useEffect(() => {
    if (state.selectedRepo && state.selectedBranch) {
      console.log(`🔄 NavigatorContext: useEffect triggered - loading items for ${state.selectedRepo}/${state.selectedBranch}`);
      loadItems(state.selectedRepo, state.selectedBranch);
    } else {
      console.log(`🔄 NavigatorContext: useEffect triggered but no repo/branch selected`);
    }
  }, [state.selectedRepo, state.selectedBranch, loadItems]);

  /**
   * Add local item (uncommitted)
   */
  const addLocalItem = useCallback((item: RepositoryItem) => {
    setLocalItems(prev => {
      // Check if item already exists
      const exists = prev.some(i => i.id === item.id && i.type === item.type);
      if (exists) return prev;
      
      return [...prev, { ...item, isLocal: true }];
    });
  }, []);
  
  /**
   * Remove local item (e.g., after commit)
   */
  const removeLocalItem = useCallback((fileId: string) => {
    setLocalItems(prev => {
      const [type, ...idParts] = fileId.split('-');
      const id = idParts.join('-');
      return prev.filter(item => !(item.id === id && item.type === type));
    });
  }, []);
  
  /**
   * Refresh items from repository
   */
  const refreshItems = useCallback(async () => {
    if (state.selectedRepo && state.selectedBranch) {
      await loadItems(state.selectedRepo, state.selectedBranch);
    }
  }, [state.selectedRepo, state.selectedBranch]);

  /**
   * Get all items (repository + local)
   */
  const getAllItems = useCallback((): RepositoryItem[] => {
    return [...items, ...localItems];
  }, [items, localItems]);

  /**
   * Filter and sort items based on current state
   */
  const getFilteredItems = useCallback((): RepositoryItem[] => {
    let filteredItems = getAllItems();

    // Apply search query
    if (state.searchQuery) {
    const query = state.searchQuery.toLowerCase();
      filteredItems = filteredItems.filter(item => 
      item.name.toLowerCase().includes(query) ||
      item.description?.toLowerCase().includes(query)
    );
    }

    // Apply view mode filter (All vs Files Only)
    // For now, we'll skip this since we don't have a way to distinguish
    // between index-only items and file items yet
    // TODO: Implement when index loading is complete

    // Apply Local Only filter
    if (state.showLocalOnly) {
      filteredItems = filteredItems.filter(item => item.isLocal);
    }

    // Apply Dirty Only filter
    // TODO: Need to check FileRegistry for dirty state
    // For now, skip this filter

    // Apply Open Only filter
    // TODO: Need to check tabs for open state
    // For now, skip this filter

    // Apply sorting
    if (state.sortBy) {
      filteredItems = [...filteredItems].sort((a, b) => {
        switch (state.sortBy) {
          case 'name':
            return a.name.localeCompare(b.name);
          
          case 'type':
            if (a.type === b.type) {
              return a.name.localeCompare(b.name);
            }
            return a.type.localeCompare(b.type);
          
          case 'status':
            // Sort by local first, then by name
            if (a.isLocal !== b.isLocal) {
              return a.isLocal ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
          
          case 'modified':
          case 'opened':
            // TODO: Implement when we have timestamp data
            return a.name.localeCompare(b.name);
          
          default:
            return 0;
        }
      });
    }

    return filteredItems;
  }, [getAllItems, state.searchQuery, state.showLocalOnly, state.sortBy]);

  /**
   * Get items by type
   */
  const getItemsByType = useCallback((type: ObjectType): RepositoryItem[] => {
    return getFilteredItems().filter(item => item.type === type);
  }, [getFilteredItems]);

  /**
   * Filter and sort operations
   */
  const setViewMode = useCallback((mode: 'all' | 'files-only') => {
    setState(prev => ({ ...prev, viewMode: mode }));
  }, []);

  const setShowLocalOnly = useCallback((show: boolean) => {
    setState(prev => ({ ...prev, showLocalOnly: show }));
  }, []);

  const setShowDirtyOnly = useCallback((show: boolean) => {
    setState(prev => ({ ...prev, showDirtyOnly: show }));
  }, []);

  const setShowOpenOnly = useCallback((show: boolean) => {
    setState(prev => ({ ...prev, showOpenOnly: show }));
  }, []);

  const setSortBy = useCallback((sort: 'name' | 'modified' | 'opened' | 'status' | 'type') => {
    setState(prev => ({ ...prev, sortBy: sort }));
  }, []);

  const setGroupBySubCategories = useCallback((group: boolean) => {
    setState(prev => ({ ...prev, groupBySubCategories: group }));
  }, []);

  const setGroupByTags = useCallback((group: boolean) => {
    setState(prev => ({ ...prev, groupByTags: group }));
  }, []);

  const operations: NavigatorOperations = {
    toggleNavigator,
    togglePin,
    setSearchQuery,
    selectRepository,
    selectBranch,
    expandSection,
    collapseSection,
    addLocalItem,
    removeLocalItem,
    refreshItems,
    
    // Filter and sort operations
    setViewMode,
    setShowLocalOnly,
    setShowDirtyOnly,
    setShowOpenOnly,
    setSortBy,
    setGroupBySubCategories,
    setGroupByTags
  };
  
  // Listen for last view closed events to clean up local items
  useEffect(() => {
    const handleLastViewClosed = (event: CustomEvent) => {
      const { fileId } = event.detail;
      
      // Check if this file exists in localItems (uncommitted)
      const [type, ...idParts] = fileId.split('-');
      const id = idParts.join('-');
      const isLocal = localItems.some(item => item.id === id && item.type === type);
      
      if (isLocal) {
        console.log(`NavigatorContext: Last view of local file ${fileId} closed, removing from navigator`);
        removeLocalItem(fileId);
      }
    };
    
    window.addEventListener('dagnet:lastViewClosed', handleLastViewClosed as EventListener);
    return () => window.removeEventListener('dagnet:lastViewClosed', handleLastViewClosed as EventListener);
  }, [localItems, removeLocalItem]);

  return (
    <NavigatorContext.Provider value={{ 
      state, 
      operations, 
      items: getFilteredItems(), 
      isLoading 
    }}>
      {children}
    </NavigatorContext.Provider>
  );
}

/**
 * Use Navigator Context hook
 */
export function useNavigatorContext(): NavigatorContextValue {
  const context = useContext(NavigatorContext);
  if (!context) {
    throw new Error('useNavigatorContext must be used within NavigatorProvider');
  }
  return context;
}

/**
 * Get items by type hook
 */
export function useNavigatorItems(type: ObjectType): RepositoryItem[] {
  const { items } = useNavigatorContext();
  return items.filter(item => item.type === type);
}

