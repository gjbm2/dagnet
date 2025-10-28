import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { NavigatorState, NavigatorOperations, RepositoryItem, ObjectType } from '../types';
import { db } from '../db/appDatabase';
import { credentialsManager } from '../lib/credentials';
import { gitConfig } from '../config/gitConfig';

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
    availableBranches: []
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

  // Load items when repo or branch changes
  useEffect(() => {
    if (state.selectedRepo && state.selectedBranch) {
      loadItems(state.selectedRepo, state.selectedBranch);
    }
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
          
          // Load items for the selected repository
          console.log(`🔑 NavigatorContext: Loading items for ${gitCreds.name} on branch ${branchToUse}...`);
          await loadItems(gitCreds.name, branchToUse);
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
    setState(prev => ({
      ...prev,
      expandedSections: [...prev.expandedSections, section]
    }));
  }, []);

  /**
   * Collapse a section
   */
  const collapseSection = useCallback((section: string) => {
    setState(prev => ({
      ...prev,
      expandedSections: prev.expandedSections.filter(s => s !== section)
    }));
  }, []);

  /**
   * Load items from repository
   */
  const loadItems = async (repo: string, branch: string) => {
    console.log(`📦 NavigatorContext: loadItems called with repo=${repo}, branch=${branch}`);
    if (!repo) {
      console.log('📦 NavigatorContext: No repo provided, skipping');
      return;
    }

    setIsLoading(true);
    try {
      // First, check if we have credentials available
      console.log('📦 NavigatorContext: Checking credentials...');
      const credentialsResult = await credentialsManager.loadCredentials();
      console.log('📦 NavigatorContext: Credentials check result:', credentialsResult);
      
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

      // Load graphs from repository using credentials
      console.log('📦 NavigatorContext: Importing gitService...');
      const { gitService } = await import('../services/gitService');
      
      console.log(`📦 NavigatorContext: Loading from repo ${gitCreds.name} (${gitCreds.owner}/${gitCreds.repo}), branch ${branch}`);
      
      // Pass credentials to gitService
      console.log('📦 NavigatorContext: Calling gitService.getDirectoryContents for graphs...');
      const graphsPath = gitCreds.basePath ? `${gitCreds.basePath}/graphs` : 'graphs';
      const graphsResult = await gitService.getDirectoryContents(graphsPath, branch, gitCreds.owner, gitCreds.repo, gitCreds.token);
      console.log('📦 NavigatorContext: Graphs result:', graphsResult);
      
      const items: RepositoryItem[] = [];
      
      // Add graphs
      if (graphsResult.success && graphsResult.data && Array.isArray(graphsResult.data)) {
        console.log('Navigator: Found', graphsResult.data.length, 'files in graphs/');
        graphsResult.data.forEach((file: any) => {
          if (file.type === 'file' && file.name.endsWith('.json')) {
            items.push({
              id: file.name,
              type: 'graph',
              name: file.name,
              path: file.path,
              description: `Graph from ${branch}`
            });
          }
        });
      }
      
      // Try to load parameters from registry
      try {
        const { paramRegistryService } = await import('../services/paramRegistryService');
        
        // Configure service for current repo using credentials
        paramRegistryService.setConfig({
          source: 'git',
          gitBasePath: gitCreds.basePath || '',
          gitBranch: branch,
          gitRepoOwner: gitCreds.owner,
          gitRepoName: gitCreds.repo,
          gitToken: gitCreds.token
        });
        
        console.log(`Navigator: Loading parameter registry for ${repo}...`);
        const registry = await paramRegistryService.loadRegistry();
        console.log('Navigator: Loaded parameter registry:', registry);
        
        // Add parameters
        if (registry.parameters && registry.parameters.length > 0) {
          console.log('Navigator: Found', registry.parameters.length, 'parameters in registry');
          registry.parameters.forEach((param: any) => {
            items.push({
              id: param.id,
              type: 'parameter',
              name: param.name || param.id,
              path: param.path || `params/${param.id}`,
              description: param.description
            });
          });
        } else {
          console.log('Navigator: No parameters in registry');
        }
        
        // Add contexts - from registry if available
        if (registry.contexts && registry.contexts.length > 0) {
          console.log('Navigator: Loading contexts from registry');
          registry.contexts.forEach((ctx: any) => {
            items.push({
              id: ctx.id,
              type: 'context',
              name: ctx.name || ctx.id,
              path: ctx.path || `contexts/${ctx.id}`,
              description: ctx.description
            });
          });
        }
        
        // Add cases - from registry if available
        if (registry.cases && registry.cases.length > 0) {
          console.log('Navigator: Loading cases from registry');
          registry.cases.forEach((c: any) => {
            items.push({
              id: c.id,
              type: 'case',
              name: c.name || c.id,
              path: c.path || `cases/${c.id}`,
              description: c.description
            });
          });
        }
      } catch (error) {
        console.warn('Failed to load from registry:', error);
      }
      
      // ALWAYS try to load parameters/contexts/cases from directories (regardless of registry)
      // This ensures we get them even if registry doesn't exist or doesn't include them
      try {
        const { gitService } = await import('../services/gitService');
        
        // Load parameters from configured path
        const paramsPath = gitCreds.basePath ? `${gitCreds.basePath}/${gitCreds.paramsPath || 'parameters'}` : (gitCreds.paramsPath || 'parameters');
        console.log(`Navigator: Loading parameters from ${paramsPath}/ directory...`);
        const paramsResult = await gitService.getDirectoryContents(paramsPath, branch, gitCreds.owner, gitCreds.repo, gitCreds.token);
          
        if (paramsResult.success && paramsResult.data && Array.isArray(paramsResult.data)) {
          console.log(`Navigator: Found ${paramsResult.data.length} files in ${paramsPath}/`);
          paramsResult.data.forEach((file: any) => {
            if (file.type === 'file' && (file.name.endsWith('.yaml') || file.name.endsWith('.yml') || file.name.endsWith('.json'))) {
              const alreadyAdded = items.some(i => i.type === 'parameter' && i.id === file.name);
              if (!alreadyAdded) {
                console.log('Navigator: Adding parameter:', file.name);
                items.push({
                  id: file.name,
                  type: 'parameter',
                  name: file.name,
                  path: file.path,
                  description: `Parameter from ${branch}`
                });
              }
            }
          });
        }
        
        // Load contexts from contexts/ directory
        console.log('Navigator: Loading contexts from /contexts directory...');
        const contextsPath = gitCreds.basePath ? `${gitCreds.basePath}/${gitCreds.contextsPath || 'contexts'}` : (gitCreds.contextsPath || 'contexts');
        const contextsResult = await gitService.getDirectoryContents(contextsPath, branch, gitCreds.owner, gitCreds.repo, gitCreds.token);
        
        if (contextsResult.success && contextsResult.data && Array.isArray(contextsResult.data)) {
          console.log('Navigator: Found', contextsResult.data.length, 'files in contexts/');
          contextsResult.data.forEach((file: any) => {
            if (file.type === 'file' && (file.name.endsWith('.yaml') || file.name.endsWith('.yml') || file.name.endsWith('.json'))) {
              // Only add if not already in items from registry
              const alreadyAdded = items.some(i => i.type === 'context' && i.id === file.name);
              if (!alreadyAdded) {
                console.log('Navigator: Adding context:', file.name);
                items.push({
                  id: file.name,
                  type: 'context',
                  name: file.name,
                  path: file.path,
                  description: `Context from ${branch}`
                });
              }
            }
          });
        }
        
        // Load cases from cases/ directory
        console.log('Navigator: Loading cases from /cases directory...');
        const casesPath = gitCreds.basePath ? `${gitCreds.basePath}/${gitCreds.casesPath || 'cases'}` : (gitCreds.casesPath || 'cases');
        const casesResult = await gitService.getDirectoryContents(casesPath, branch, gitCreds.owner, gitCreds.repo, gitCreds.token);
        
        if (casesResult.success && casesResult.data && Array.isArray(casesResult.data)) {
          console.log('Navigator: Found', casesResult.data.length, 'files in cases/');
          casesResult.data.forEach((file: any) => {
            if (file.type === 'file' && (file.name.endsWith('.yaml') || file.name.endsWith('.yml') || file.name.endsWith('.json'))) {
              // Only add if not already in items from registry
              const alreadyAdded = items.some(i => i.type === 'case' && i.id === file.name);
              if (!alreadyAdded) {
                console.log('Navigator: Adding case:', file.name);
                items.push({
                  id: file.name,
                  type: 'case',
                  name: file.name,
                  path: file.path,
                  description: `Case from ${branch}`
                });
              }
            }
          });
        }
        
        // Load nodes from nodes/ directory
        console.log('Navigator: Loading nodes from /nodes directory...');
        const nodesPath = gitCreds.basePath ? `${gitCreds.basePath}/nodes` : 'nodes';
        const nodesResult = await gitService.getDirectoryContents(nodesPath, branch, gitCreds.owner, gitCreds.repo, gitCreds.token);
        
        if (nodesResult.success && nodesResult.data && Array.isArray(nodesResult.data)) {
          console.log('Navigator: Found', nodesResult.data.length, 'files in nodes/');
          nodesResult.data.forEach((file: any) => {
            if (file.type === 'file' && (file.name.endsWith('.yaml') || file.name.endsWith('.yml') || file.name.endsWith('.json'))) {
              // Only add if not already in items from registry
              const alreadyAdded = items.some(i => i.type === 'node' && i.id === file.name);
              if (!alreadyAdded) {
                console.log('Navigator: Adding node:', file.name);
                items.push({
                  id: file.name,
                  type: 'node',
                  name: file.name,
                  path: file.path,
                  description: `Node from ${branch}`
                });
              }
            }
          });
        }
      } catch (dirError) {
        console.warn('Failed to load contexts/cases/nodes from directories:', dirError);
      }
      
      console.log('Total items loaded:', items.length, {
        graphs: items.filter(i => i.type === 'graph').length,
        parameters: items.filter(i => i.type === 'parameter').length,
        contexts: items.filter(i => i.type === 'context').length,
        cases: items.filter(i => i.type === 'case').length,
        nodes: items.filter(i => i.type === 'node').length
      });
      
      setItems(items);
    } catch (error) {
      console.error('Failed to load items:', error);
      setItems([]);
    } finally {
      setIsLoading(false);
    }
  };

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
   * Filter items by search query
   */
  const getFilteredItems = useCallback((): RepositoryItem[] => {
    const allItems = getAllItems();
    if (!state.searchQuery) return allItems;

    const query = state.searchQuery.toLowerCase();
    return allItems.filter(item => 
      item.name.toLowerCase().includes(query) ||
      item.description?.toLowerCase().includes(query)
    );
  }, [getAllItems, state.searchQuery]);

  /**
   * Get items by type
   */
  const getItemsByType = useCallback((type: ObjectType): RepositoryItem[] => {
    return getFilteredItems().filter(item => item.type === type);
  }, [getFilteredItems]);

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
    refreshItems
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

