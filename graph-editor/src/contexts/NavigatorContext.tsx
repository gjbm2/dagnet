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
    selectedRepo: 'nous-conversion',
    selectedBranch: 'main',
    expandedSections: ['graphs', 'parameters', 'contexts', 'cases']
  });

  const [items, setItems] = useState<RepositoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);

  // Load state from IndexedDB and credentials on mount
  useEffect(() => {
    const initialize = async () => {
      await loadStateFromDB();
      await loadCredentialsAndUpdateRepo();
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
  }, [state, isInitialized]);

  /**
   * Load credentials and update selected repository
   */
  const loadCredentialsAndUpdateRepo = async () => {
    try {
      const result = await credentialsManager.loadCredentials();
      
      if (result.success && result.credentials) {
        const defaultRepo = result.credentials.defaultGitRepo || 'nous-conversion';
        const gitCreds = result.credentials.git.find(repo => repo.name === defaultRepo) || result.credentials.git[0];
        
        if (gitCreds) {
          console.log(`NavigatorContext: Updating repo to ${gitCreds.name} (${gitCreds.owner}/${gitCreds.repo})`);
          setState(prev => ({
            ...prev,
            selectedRepo: gitCreds.name,
            selectedBranch: gitCreds.branch || 'main'
          }));
        }
      } else {
        console.log('NavigatorContext: No credentials available, using default repo');
      }
    } catch (error) {
      console.error('NavigatorContext: Failed to load credentials:', error);
    }
  };

  /**
   * Load navigator state from IndexedDB
   * Error handling is in db wrapper - if it fails, DB gets nuked and page reloads
   */
  const loadStateFromDB = async () => {
    const appState = await db.getAppState();
    console.log('NavigatorContext: Loading state from DB:', appState?.navigatorState);
    if (appState?.navigatorState) {
      const restoredState = {
        ...appState.navigatorState,
        searchQuery: '',
        selectedRepo: appState.navigatorState.selectedRepo || 'nous-conversion',
        selectedBranch: appState.navigatorState.selectedBranch || 'main'
      };
      console.log('NavigatorContext: Restoring state:', restoredState);
      setState(restoredState);
    }
  };

  /**
   * Save navigator state to IndexedDB
   */
  const saveStateToDB = async () => {
    console.log('NavigatorContext: Saving state to DB:', state);
    await db.saveAppState({
      navigatorState: state
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
   * Select repository
   */
  const selectRepository = useCallback(async (repo: string) => {
    setState(prev => ({
      ...prev,
      selectedRepo: repo
    }));

    // Load items for this repository
    await loadItems(repo, state.selectedBranch);
  }, [state.selectedBranch]);

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
    if (!repo) return;

    setIsLoading(true);
    try {
      // Load graphs from repository
      const { gitService } = await import('../services/gitService');
      
      console.log(`Navigator: Loading from repo ${repo}, branch ${branch}`);
      
      // Pass repo to gitService so it uses the correct repository
      const graphsResult = await gitService.getDirectoryContents('graphs', branch, 'gjbm2', repo);
      
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
        
        // Configure service for current repo
        paramRegistryService.setConfig({
          source: 'git',
          gitBasePath: '',
          gitBranch: branch,
          gitRepoOwner: 'gjbm2',
          gitRepoName: repo
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
        
        // Load parameters - try both /params and /parameters directories
        const paramDirs = ['params', gitConfig.paramsPath];
        for (const dir of paramDirs) {
          console.log(`Navigator: Trying ${dir}/ directory...`);
          const paramsResult = await gitService.getDirectoryContents(dir, branch, 'gjbm2', repo);
          
          if (paramsResult.success && paramsResult.data && Array.isArray(paramsResult.data)) {
            console.log(`Navigator: Found ${paramsResult.data.length} files in ${dir}/`);
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
            break; // Found parameters, don't try other directory
          }
        }
        
        // Load contexts from contexts/ directory
        console.log('Navigator: Loading contexts from /contexts directory...');
        const contextsResult = await gitService.getDirectoryContents('contexts', branch, 'gjbm2', repo);
        
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
        const casesResult = await gitService.getDirectoryContents('cases', branch, 'gjbm2', repo);
        
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
      } catch (dirError) {
        console.warn('Failed to load contexts/cases from directories:', dirError);
      }
      
      console.log('Total items loaded:', items.length, {
        graphs: items.filter(i => i.type === 'graph').length,
        parameters: items.filter(i => i.type === 'parameter').length,
        contexts: items.filter(i => i.type === 'context').length,
        cases: items.filter(i => i.type === 'case').length
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
   * Filter items by search query
   */
  const getFilteredItems = useCallback((): RepositoryItem[] => {
    if (!state.searchQuery) return items;

    const query = state.searchQuery.toLowerCase();
    return items.filter(item => 
      item.name.toLowerCase().includes(query) ||
      item.description?.toLowerCase().includes(query)
    );
  }, [items, state.searchQuery]);

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
    collapseSection
  };

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

