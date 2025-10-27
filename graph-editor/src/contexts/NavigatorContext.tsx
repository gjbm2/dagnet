import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { NavigatorState, NavigatorOperations, RepositoryItem, ObjectType } from '../types';
import { db } from '../db/appDatabase';

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

  // Load state from IndexedDB on mount
  useEffect(() => {
    const initialize = async () => {
      await loadStateFromDB();
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
   * Load navigator state from IndexedDB
   */
  const loadStateFromDB = async () => {
    const appState = await db.getAppState();
    console.log('NavigatorContext: Loading state from DB:', appState?.navigatorState);
    if (appState?.navigatorState) {
      // Load state but clear search query on init
      // Also ensure selectedRepo and selectedBranch have values
      const restoredState = {
        ...appState.navigatorState,
        searchQuery: '',
        selectedRepo: appState.navigatorState.selectedRepo || 'nous-conversion',
        selectedBranch: appState.navigatorState.selectedBranch || 'main'
      };
      console.log('NavigatorContext: Restoring state:', restoredState);
      setState(restoredState);
    } else {
      console.log('NavigatorContext: No saved state found, using defaults');
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
      const { graphGitService } = await import('../services/graphGitService');
      const graphsResult = await graphGitService.getAvailableGraphs(branch);
      
      const items: RepositoryItem[] = [];
      
      // Add graphs
      if (graphsResult.success && graphsResult.data) {
        graphsResult.data.forEach((file: any) => {
          items.push({
            id: file.name,
            type: 'graph',
            name: file.name,
            path: file.path,
            description: `Graph from ${branch}`
          });
        });
      }
      
      // Load parameters, contexts, cases from param registry
      try {
        const { paramRegistryService } = await import('../services/paramRegistryService');
        
        // Configure for nous-conversion
        paramRegistryService.setConfig({
          source: 'git',
          gitBasePath: '',
          gitBranch: branch,
          gitRepoOwner: 'gjbm2',
          gitRepoName: repo
        });
        
        // Load registry to get available parameters
        const registry = await paramRegistryService.loadRegistry();
        console.log('Loaded parameter registry:', registry);
        
        // Add parameters
        if (registry.parameters) {
          console.log('Found parameters:', registry.parameters.length);
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
          console.log('No parameters in registry');
        }
        
        // Add contexts
        if (registry.contexts) {
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
        
        // Add cases
        if (registry.cases) {
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
        console.error('Failed to load parameters/contexts/cases:', error);
        // If loading fails, don't add any - better than showing fake ones
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

