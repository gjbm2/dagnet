import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
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
// Load expanded sections from localStorage or default to only graphs
const getInitialExpandedSections = (): string[] => {
  try {
    const saved = localStorage.getItem('dagnet:navigator:expandedSections');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch (e) {
    console.warn('Failed to load expanded sections from localStorage:', e);
  }
  // Default: only graphs expanded
  return ['graphs'];
};

export function NavigatorProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<NavigatorState>({
    isOpen: true,  // Open by default
    isPinned: true, // Pinned by default
    searchQuery: '',
    selectedRepo: '',
    selectedBranch: '',
    expandedSections: getInitialExpandedSections(),
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
  const loadingRef = useRef(false); // Track loading state synchronously to prevent race conditions

  // Load state from IndexedDB and credentials on mount
  useEffect(() => {
    const initialize = async () => {
      const savedState = await loadStateFromDB();
      const repoBranch = await loadCredentialsAndUpdateRepo(savedState);
      // Policy: NO remote sync on init unless this is the first time the repo/branch is being initialised locally.
      // We still populate the UI from IndexedDB immediately.
      if (repoBranch?.repo && repoBranch?.branch) {
        await loadItems(repoBranch.repo, repoBranch.branch, { syncMode: 'first-init' });
      }
      setIsInitialized(true);
    };
    initialize();
  }, []);

  // Listen for file dirty state changes and trigger re-load
  // NOTE: Don't reload for credentials changes - those only apply on "Apply and Reload"
  useEffect(() => {
    const handleFileDirtyChanged = (event: any) => {
      const { fileId, isDirty } = event.detail;

      // Ignore credentials file - it shouldn't trigger workspace reload
      if (fileId === 'credentials-credentials') {
        return;
      }

      // NOTE: No need to reload items! The Navigator will automatically update
      // because NavigatorContent subscribes to registry changes via registryService.
      // Reloading here causes unnecessary work and can create race conditions.
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
  const loadCredentialsAndUpdateRepo = async (savedState: any): Promise<{ repo: string; branch: string } | null> => {
    try {
      const result = await credentialsManager.loadCredentials();

      if (result.success && result.credentials) {
        // CRITICAL: Configure gitService with new credentials BEFORE making any API calls
        // This ensures the Octokit instance is initialized with the correct token
        const { gitService } = await import('../services/gitService');
        gitService.setCredentials(result.credentials);
        
        const availableRepos = result.credentials.git.map(repo => repo.name);

        // Determine default repo (prefer isDefault flag, fallback to defaultGitRepo or first repo)
        const repoWithDefaultFlag = result.credentials.git.find(r => r.isDefault);
        let defaultRepo = repoWithDefaultFlag?.name;

        if (!defaultRepo) {
          // Check if defaultGitRepo is valid (exists in available repos)
          if (result.credentials.defaultGitRepo && availableRepos.includes(result.credentials.defaultGitRepo)) {
            defaultRepo = result.credentials.defaultGitRepo;
          } else {
            // Fall back to first available repo
            defaultRepo = availableRepos[0];
          }
        }

        // Use saved repo if it exists and is valid, otherwise use default
        const savedRepoName = savedState?.selectedRepo;

        const repoToUse = savedRepoName && availableRepos.includes(savedRepoName) ? savedRepoName : defaultRepo;
        const gitCreds = result.credentials.git.find(repo => repo.name === repoToUse) || result.credentials.git[0];

        if (gitCreds) {
          // Fetch branches for the selected repository
          const branches = await fetchBranches(gitCreds.name);
          // Prefer configured branch from credentials, then fall back to 'main' or first available
          const selectedBranch = gitCreds.branch || (branches.includes('main') ? 'main' : branches[0]) || 'main';

          // Use saved branch if valid, otherwise use default
          const savedBranchName = savedState?.selectedBranch;
          const branchToUse = savedBranchName && branches.includes(savedBranchName) ? savedBranchName : selectedBranch;

          setState(prev => ({
            ...prev,
            selectedRepo: gitCreds.name,
            selectedBranch: branchToUse,
            availableRepos,
            availableBranches: branches
          }));

          // Return chosen repo/branch to allow caller to immediately load
          return { repo: gitCreds.name, branch: branchToUse };
        } else {
          setState(prev => ({
            ...prev,
            availableRepos
          }));
          return null;
        }
      } else {
        console.warn('NavigatorContext: No credentials available:', result.error);
        setState(prev => ({
          ...prev,
          availableRepos: []
        }));
        return null;
      }
    } catch (error) {
      console.error('NavigatorContext: Failed to load credentials:', error);
      return null;
    }
  };

  /**
   * Load navigator state from IndexedDB
   * Error handling is in db wrapper - if it fails, DB gets nuked and page reloads
   */
  const loadStateFromDB = async () => {
    const appState = await db.getAppState();
    if (appState?.navigatorState) {
      const restoredState = {
        ...appState.navigatorState,
        searchQuery: '',
        selectedRepo: appState.navigatorState.selectedRepo || '',
        selectedBranch: appState.navigatorState.selectedBranch || ''
      };
      setState(restoredState);

      // Restore local items
      if (appState.localItems) {
        setLocalItems(appState.localItems);
      }

      return restoredState;
    }
    return null;
  };

  /**
   * Save navigator state to IndexedDB
   */
  const saveStateToDB = async () => {
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
      return {
        ...prev,
        isOpen: !prev.isOpen,
        isPinned: !prev.isOpen ? prev.isPinned : false // Unpin when closing
      };
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
      const branchesResult = await gitService.getBranches(gitCreds.owner, gitCreds.repo || gitCreds.name, gitCreds.token);

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

      // Get credentials for this repo to find the configured branch
      const credentialsResult = await credentialsManager.loadCredentials();
      const gitCreds = credentialsResult.credentials?.git?.find((r: any) => r.name === repo);
      // Prefer configured branch from credentials, then fall back to 'main' or first available
      const selectedBranch = gitCreds?.branch || (branches.includes('main') ? 'main' : branches[0]) || '';

      setState(prev => ({
        ...prev,
        availableBranches: branches,
        selectedBranch
      }));

      console.log(`🔄 NavigatorContext: Loading items for ${repo}/${selectedBranch} (loadItems will clear FileRegistry)`);

      // User repo change policy:
      // - If workspace exists locally: pull latest
      // - If workspace missing locally: clone
      await loadItems(repo, selectedBranch, { syncMode: 'user-change' });
    }
  }, []);

  /**
   * Select branch
   */
  const selectBranch = useCallback(async (branch: string) => {
    console.log(`🔄 NavigatorContext: selectBranch called with: ${branch}`);

    // Get current repo from state
    let currentRepo = state.selectedRepo;

    setState(prev => {
      currentRepo = prev.selectedRepo; // Get latest value
      return {
        ...prev,
        selectedBranch: branch
      };
    });

    console.log(`🔄 NavigatorContext: Loading items for ${currentRepo}/${branch}`);

    // User branch change policy: treat as repo change (sync allowed).
    await loadItems(currentRepo, branch, { syncMode: 'user-change' });
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
  type LoadItemsSyncMode = 'none' | 'first-init' | 'user-change';

  const loadItems = useCallback(async (
    repo: string,
    branch: string,
    opts?: { syncMode?: LoadItemsSyncMode }
  ) => {
    console.log(`📦 WorkspaceService: loadItems called for ${repo}/${branch}`);
    if (!repo) {
      console.log('📦 WorkspaceService: No repo provided, skipping');
      return;
    }
    const syncMode: LoadItemsSyncMode = opts?.syncMode ?? 'none';

    // Prevent concurrent loads (use ref for synchronous check)
    if (loadingRef.current) {
      console.log(`⚠️ WorkspaceService: Already loading, ignoring duplicate call`);
      return;
    }

    loadingRef.current = true;
    setIsLoading(true);

    // IMPORTANT:
    // - Clearing FileRegistry is disruptive: it will blank already-open tabs and leave them showing
    //   "Loading graph..." (etc.) until the editor reload logic catches up.
    // - We only clear when the user explicitly changes repo/branch (syncMode=user-change),
    //   to avoid nuking restored tabs during startup.
    //
    // Note: we still rely on the single-workspace policy below to prevent IDB mixing.
    if (syncMode === 'user-change') {
      // Clear FileRegistry before loading new workspace to prevent file ID collisions
      // Files from different repos can have same IDs (e.g. parameter-checkout-duration)
      console.log(`🧹 NavigatorContext: Clearing FileRegistry before loading ${repo}/${branch} (syncMode=user-change)`);
      const registrySize = (fileRegistry as any).files.size;
      const filesBefore = Array.from((fileRegistry as any).files.keys());
      (fileRegistry as any).files.clear();
      (fileRegistry as any).listeners.clear();
      console.log(`🧹 NavigatorContext: Cleared ${registrySize} files from FileRegistry:`, filesBefore);
    } else {
      console.log(`🧹 NavigatorContext: Preserving FileRegistry contents (syncMode=${syncMode})`);
    }

    try {
      // SINGLE WORKSPACE POLICY: Ensure only ONE workspace exists in IDB
      // If there are multiple, or the existing one doesn't match, clear everything
      const existingWorkspaces = await db.workspaces.toArray();
      const targetWorkspaceId = `${repo}-${branch}`;
      if (existingWorkspaces.length > 1 || 
          (existingWorkspaces.length === 1 && existingWorkspaces[0].id !== targetWorkspaceId)) {
        console.log(`🧹 NavigatorContext: Single workspace policy - clearing ${existingWorkspaces.length} stale workspace(s)`);
        await workspaceService.clearAllWorkspaces();
      }
      
      // Get credentials
      const credentialsResult = await credentialsManager.loadCredentials();
      console.log('📦 WorkspaceService: Credentials check result:', credentialsResult);

      if (!credentialsResult.success || !credentialsResult.credentials) {
        console.log('📦 NavigatorContext: No credentials available, cannot load repository items');
        // Clear items and registry indexes
        setItems([]);
        setState(prev => ({
          ...prev,
          registryIndexes: {
            parameters: undefined,
            contexts: undefined,
            cases: undefined,
            nodes: undefined
          }
        }));
        setIsLoading(false);
        return;
      }

      // Find the credentials for this repository
      const gitCreds = credentialsResult.credentials.git.find(cred => cred.name === repo);
      console.log(`📦 NavigatorContext: Looking for creds for repo ${repo}:`, gitCreds);

      if (!gitCreds) {
        console.log(`📦 NavigatorContext: No credentials found for repository ${repo}`);
        // Clear items and registry indexes
        setItems([]);
        setState(prev => ({
          ...prev,
          registryIndexes: {
            parameters: undefined,
            contexts: undefined,
            cases: undefined,
            nodes: undefined
          }
        }));
        setIsLoading(false);
        return;
      }

      // Check if workspace exists
      const workspaceExists = await workspaceService.workspaceExists(repo, branch);
      console.log(`🔍 NavigatorContext: Workspace ${repo}/${branch} exists: ${workspaceExists}`);

      if (!workspaceExists) {
        // Allowed remote sync: first init (initial local clone) OR explicit user repo/branch change.
        if (syncMode === 'first-init' || syncMode === 'user-change') {
          console.log(`🔄 NavigatorContext: Workspace ${repo}/${branch} missing, cloning from repository...`);
          await workspaceService.cloneWorkspace(repo, branch, gitCreds);
          console.log(`✅ NavigatorContext: Clone complete for ${repo}/${branch}`);
        } else {
          // Policy: Never clone/pull implicitly. If there's no local workspace and we weren't
          // invoked by an allowed sync trigger, just show empty state from IDB.
          console.log(`📦 NavigatorContext: Workspace ${repo}/${branch} missing; skipping clone (syncMode=${syncMode})`);
        }
      } else {
        // Policy:
        // - Pull ONLY on explicit user repo/branch change (or explicit pull via git menu/service).
        // - Never pull on init hydration or passive loads.
        if (syncMode === 'user-change') {
          console.log(`📦 NavigatorContext: User changed repo/branch; pulling latest for ${repo}/${branch}...`);
          try {
            await workspaceService.pullLatest(repo, branch, gitCreds);
            console.log(`✅ NavigatorContext: Pull complete for ${repo}/${branch}`);
          } catch (pullError) {
            console.warn(`⚠️ NavigatorContext: Pull failed, falling back to IDB cache:`, pullError);
          }
        } else {
          console.log(`📦 NavigatorContext: Loading from IDB only for ${repo}/${branch} (syncMode=${syncMode})`);
        }

        // Always load into FileRegistry from IDB after any attempted sync (or no-op sync).
        await workspaceService.loadWorkspaceFromIDB(repo, branch);
      }

      // Get all files from workspace (IDB)
      let workspaceFiles = await workspaceService.getWorkspaceFiles(repo, branch);
      console.log(`📦 WorkspaceService: Loaded ${workspaceFiles.length} files from workspace`);

      // If workspace exists but has no files, force re-clone
      if (workspaceFiles.length === 0 && workspaceExists) {
        // Treat empty workspace as missing. Only allowed to self-heal if invoked by an allowed sync trigger.
        if (syncMode === 'first-init' || syncMode === 'user-change') {
          console.log(`⚠️ WorkspaceService: Workspace exists but is empty! Re-cloning (syncMode=${syncMode})...`);
          await workspaceService.deleteWorkspace(repo, branch);
          await workspaceService.cloneWorkspace(repo, branch, gitCreds);
          workspaceFiles = await workspaceService.getWorkspaceFiles(repo, branch);
          console.log(`📦 WorkspaceService: Re-cloned, now have ${workspaceFiles.length} files`);
        } else {
          console.log(`⚠️ WorkspaceService: Workspace exists but is empty; skipping re-clone (syncMode=${syncMode})`);
        }
      }

      // Build RepositoryItem list from FileStates
      // DETAILED LOGGING: What node files are in workspaceFiles
      const nodeFiles = workspaceFiles.filter(f => f.type === 'node' && !f.fileId.endsWith('-index'));
      console.log('🔍 NavigatorContext: NODE files in workspaceFiles:', nodeFiles.map(f => ({
        fileId: f.fileId,
        type: f.type,
        name: f.name,
        path: f.path,
        isLocal: f.isLocal,
        id: f.fileId.replace(`${f.type}-`, '')
      })));
      
      const items: RepositoryItem[] = workspaceFiles
        .filter(file => {
          // Exclude system files (credentials) and index files
          if (file.type === 'credentials') return false;
          if (file.fileId.endsWith('-index')) return false;
          // Exclude temporary log files (repository: 'temporary')
          if (file.source?.repository === 'temporary') return false;
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
      
      // DETAILED LOGGING: What node items are built
      const nodeItems = items.filter(i => i.type === 'node');
      console.log('🔍 NavigatorContext: NODE items built from workspaceFiles (before dedup):', nodeItems.map(i => ({
        id: i.id,
        fileId: `${i.type}-${i.id}`,
        type: i.type,
        name: i.name,
        path: i.path,
        isLocal: i.isLocal
      })));
      
      // DEDUPLICATE items by fileId (in case IndexedDB has duplicates)
      const seenFileIds = new Set<string>();
      const deduplicatedItems = items.filter(item => {
        const fileId = `${item.type}-${item.id}`;
        if (seenFileIds.has(fileId)) {
          console.warn(`🔍 NavigatorContext: Skipping duplicate item: ${fileId}`);
          return false;
        }
        seenFileIds.add(fileId);
        return true;
      });
      
      const deduplicatedNodeItems = deduplicatedItems.filter(i => i.type === 'node');
      console.log('🔍 NavigatorContext: NODE items after dedup:', deduplicatedNodeItems.map(i => ({
        id: i.id,
        fileId: `${i.type}-${i.id}`,
        type: i.type
      })));

      // Load registry indexes from current workspace files only (not from stale IDB)
      const parametersIndexFile = workspaceFiles.find(f => f.fileId === 'parameter-index');
      const contextsIndexFile = workspaceFiles.find(f => f.fileId === 'context-index');
      const casesIndexFile = workspaceFiles.find(f => f.fileId === 'case-index');
      const nodesIndexFile = workspaceFiles.find(f => f.fileId === 'node-index');
      const eventsIndexFile = workspaceFiles.find(f => f.fileId === 'event-index');

      console.log(`📦 WorkspaceService: Loaded ${workspaceFiles.length} files total, ${deduplicatedItems.length} non-index items (${items.length - deduplicatedItems.length} duplicates removed)`);
      console.log(`📦 WorkspaceService: Items by type:`, deduplicatedItems.reduce((acc, item) => {
        acc[item.type] = (acc[item.type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>));
      console.log(`📋 NavigatorContext: Index files:`, {
        parameters: parametersIndexFile?.data,
        contexts: contextsIndexFile?.data,
        cases: casesIndexFile?.data,
        nodes: nodesIndexFile?.data,
        events: eventsIndexFile?.data
      });

      setItems(deduplicatedItems);

      // Update state with registry indexes
      setState(prev => ({
        ...prev,
        registryIndexes: {
          parameters: parametersIndexFile?.data || undefined,
          contexts: contextsIndexFile?.data || undefined,
          cases: casesIndexFile?.data || undefined,
          nodes: nodesIndexFile?.data || undefined,
          events: eventsIndexFile?.data || undefined
        }
      }));

    } catch (error) {
      console.error('Failed to load items:', error);
      setItems([]);
    } finally {
      loadingRef.current = false;
      setIsLoading(false);
    }
  }, []); // Empty deps - uses params, not external state

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
      // Refresh is local-only: it should never implicitly pull.
      await loadItems(state.selectedRepo, state.selectedBranch, { syncMode: 'none' });
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
    // Allow external callers (e.g., credentials editor) to reload creds and refresh
    reloadCredentials: async () => {
      console.log('🔄 NavigatorContext: Reloading credentials and workspace...');

      // CRITICAL: Clear credentials cache to pick up changes to credentials.yaml (e.g., new branch)
      credentialsManager.clearCache();

      // Reload credentials and determine NEW repo/branch
      // DON'T use saved state - force re-evaluation of default repo from credentials
      const repoBranch = await loadCredentialsAndUpdateRepo(null);

      if (repoBranch?.repo && repoBranch?.branch) {
        console.log(`🔄 NavigatorContext: New workspace: ${repoBranch.repo}/${repoBranch.branch}`);

        try {
          // CLEAN SLATE: Clear ALL workspaces and files (except credentials/connections)
          // This is safer than trying to manage old/new workspaces separately
          console.log('🧹 NavigatorContext: Clearing all workspaces (clean slate)...');
          await workspaceService.clearAllWorkspaces();

          // Clone the new workspace fresh
          console.log('🔄 NavigatorContext: Cloning new workspace with updated credentials...');
          const credentialsResult = await credentialsManager.loadCredentials();
          if (credentialsResult.success && credentialsResult.credentials) {
            const gitCreds = credentialsResult.credentials.git.find(cred => cred.name === repoBranch.repo);
            if (gitCreds) {
              await workspaceService.cloneWorkspace(repoBranch.repo, repoBranch.branch, gitCreds);
            }
          }

          // Load items from new workspace
          await loadItems(repoBranch.repo, repoBranch.branch);
        } catch (error) {
          console.error('❌ NavigatorContext: Failed to reload credentials:', error);
          // Re-throw with more helpful context
          throw new Error(`Failed to clone repository with new credentials: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },

    // Force full reload - CLEAN SLATE then re-clone (escape hatch for smart pull issues)
    forceFullReload: async () => {
      console.log('🔄 NavigatorContext: Force full reload requested...');

      if (!state.selectedRepo || !state.selectedBranch) {
        console.warn('⚠️ NavigatorContext: No repo/branch selected, cannot force reload');
        return;
      }

      const repo = state.selectedRepo;
      const branch = state.selectedBranch;

      try {
        setIsLoading(true);

        // CLEAN SLATE: Clear ALL workspaces (not just current one)
        // This ensures no stale files from any repo pollute the new clone
        console.log('🧹 NavigatorContext: Clearing all workspaces (clean slate)...');
        await workspaceService.clearAllWorkspaces();

        // Get credentials
        const credentialsResult = await credentialsManager.loadCredentials();
        if (!credentialsResult.success || !credentialsResult.credentials) {
          throw new Error('Failed to load credentials');
        }

        const gitCreds = credentialsResult.credentials.git.find(cred => cred.name === repo);
        if (!gitCreds) {
          throw new Error(`Git credentials not found for ${repo}`);
        }

        // Re-clone fresh
        console.log(`📦 NavigatorContext: Re-cloning workspace ${repo}/${branch}...`);
        await workspaceService.cloneWorkspace(repo, branch, gitCreds);

        // Reload items
        await loadItems(repo, branch);

        console.log('✅ NavigatorContext: Force reload complete!');
      } catch (error) {
        console.error('❌ NavigatorContext: Force reload failed:', error);
        alert('Force reload failed: ' + (error instanceof Error ? error.message : String(error)));
      } finally {
        setIsLoading(false);
      }
    },

    // Filter and sort operations
    setViewMode,
    setShowLocalOnly,
    setShowDirtyOnly,
    setShowOpenOnly,
    setSortBy,
    setGroupBySubCategories,
    setGroupByTags
  };

  // Listen for last view closed events
  // NOTE: We DON'T remove local items when tabs close - they're part of the workspace
  // Local files persist in the navigator until explicitly deleted by the user
  useEffect(() => {
    const handleLastViewClosed = (event: CustomEvent) => {
      const { fileId } = event.detail;

      console.log(`NavigatorContext: Last view of file ${fileId} closed - file persists in workspace`);

      // Local files stay in the navigator - they're part of the workspace
      // Only explicit user delete action removes them
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

/**
 * Hook to check if the current repository is in read-only mode (no token configured)
 * Returns true if no token, false if token exists, null if credentials not yet loaded
 */
export function useIsReadOnly(): boolean | null {
  const { state } = useNavigatorContext();
  const [isReadOnly, setIsReadOnly] = React.useState<boolean | null>(null);
  
  React.useEffect(() => {
    const checkToken = async () => {
      if (!state.selectedRepo) {
        setIsReadOnly(null);
        return;
      }
      
      try {
        const result = await credentialsManager.loadCredentials();
        if (!result.success || !result.credentials?.git) {
          setIsReadOnly(true);
          return;
        }
        
        const gitCreds = result.credentials.git.find(
          (cred: any) => cred.name === state.selectedRepo
        );
        
        // No token = read-only
        setIsReadOnly(!gitCreds?.token || gitCreds.token.trim() === '');
      } catch (error) {
        console.error('Failed to check read-only status:', error);
        setIsReadOnly(true);
      }
    };
    
    checkToken();
  }, [state.selectedRepo]);
  
  return isReadOnly;
}

