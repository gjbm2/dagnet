// Core Types for Tab System

/**
 * Object types that can be opened in tabs
 */
export type ObjectType = 
  | 'graph' 
  | 'parameter' 
  | 'context' 
  | 'case'
  | 'credentials'
  | 'settings'
  | 'about'
  | 'markdown';

/**
 * View modes for displaying content
 */
export type ViewMode = 'interactive' | 'raw-json' | 'raw-yaml';

/**
 * Source information for a file
 */
export interface FileSource {
  repository: string;
  path: string;
  branch: string;
  commitHash?: string;
}

/**
 * File state - single source of truth for a file
 * Multiple tabs can view the same file
 */
export interface FileState<T = any> {
  fileId: string;              // Unique ID for this file
  type: ObjectType;
  
  // Data
  data: T;                     // Current state
  originalData: T;             // For revert
  isDirty: boolean;            // Shared across all views
  
  // Source
  source: FileSource;
  
  // Which tabs are viewing this file
  viewTabs: string[];          // Array of tab IDs
  
  // Metadata
  lastModified: number;
  lastSaved?: number;
}

/**
 * Individual tab - view of a file
 */
export interface TabState {
  id: string;                  // Unique tab ID
  fileId: string;              // Points to FileState
  viewMode: ViewMode;
  title: string;               // Display name (includes view type)
  icon?: string;               // Optional icon
  
  // Tab-specific state (e.g. scroll position, selection)
  editorState?: {
    // Graph editor specific
    useUniformScaling?: boolean;
    massGenerosity?: number;
    autoReroute?: boolean;
    sidebarOpen?: boolean;
    whatIfOpen?: boolean;
    propertiesOpen?: boolean;
    jsonOpen?: boolean;
    selectedNodeId?: string | null;
    selectedEdgeId?: string | null;
    // What-if analysis state (per-tab, not per-file)
    whatIfAnalysis?: any;
    caseOverrides?: Record<string, string>; // nodeId -> variantName
    conditionalOverrides?: Record<string, Set<string>>; // edgeId -> forced visited nodes (hyperprior activation)
    // Target panel for "Open in X View" placement
    targetPanel?: string;
  };
  
  // UI state
  closable?: boolean;
  group?: string;              // For rc-dock grouping
}

/**
 * Navigator state
 */
export interface NavigatorState {
  isOpen: boolean;
  isPinned: boolean;
  searchQuery: string;
  selectedRepo: string;
  selectedBranch: string;
  expandedSections: string[];  // Which sections are expanded
  availableRepos: string[];    // Available repositories from credentials
  availableBranches: string[]; // Available branches for selected repo
}

/**
 * Repository item (from navigator tree)
 */
export interface RepositoryItem {
  id: string;
  type: ObjectType;
  name: string;
  path: string;
  description?: string;
  metadata?: Record<string, any>;
}

/**
 * Git commit information
 */
export interface GitCommit {
  message: string;
  branch: string;
  author?: {
    name: string;
    email: string;
  };
  timestamp: number;
}

/**
 * Multi-file commit data
 */
export interface CommitRequest {
  files: Array<{
    fileId: string;
    path: string;
    content: string;
  }>;
  commit: GitCommit;
  createNewBranch?: boolean;
  newBranchName?: string;
}

/**
 * App state persisted to IndexedDB
 */
export interface AppState {
  id: string;                  // 'app-state' (singleton)
  
  // Layout
  dockLayout: any;             // rc-dock layout
  
  // Navigator
  navigatorState: NavigatorState;
  
  // Active tab
  activeTabId?: string;
  
  // Last accessed
  lastRepository?: string;
  lastBranch?: string;
  
  // Timestamp
  updatedAt: number;
}

/**
 * Settings data (stored locally, not in git)
 */
export interface SettingsData {
  id: string;  // Required by Dexie
  git: {
    defaultRepo?: string;
    authTokens?: Record<string, string>;  // repo -> token
  };
  ui: {
    theme?: 'light' | 'dark';
    navigatorDefaultOpen?: boolean;
    tabLimit?: number;
  };
  editor: {
    autoSave?: boolean;
    showLineNumbers?: boolean;
    wordWrap?: boolean;
  };
}

/**
 * Tab operations interface
 */
export interface TabOperations {
  openTab: (item: RepositoryItem, viewMode?: ViewMode, forceNew?: boolean) => Promise<void>;
  closeTab: (tabId: string, force?: boolean) => Promise<boolean>;
  switchTab: (tabId: string) => void;
  updateTabData: (fileId: string, newData: any) => void;
  updateTabState: (tabId: string, editorState: Partial<TabState['editorState']>) => Promise<void>;
  getDirtyTabs: () => TabState[];
  saveTab: (tabId: string) => Promise<void>;
  saveAll: () => Promise<void>;
  revertTab: (tabId: string) => void;
  
  // View mode operations
  openInNewView: (tabId: string, viewMode: ViewMode, targetPanel?: string) => Promise<void>;
  
  // Multi-file commit
  commitFiles: (request: CommitRequest) => Promise<void>;
}

/**
 * Navigator operations interface
 */
export interface NavigatorOperations {
  toggleNavigator: () => void;
  togglePin: () => void;
  setSearchQuery: (query: string) => void;
  selectRepository: (repo: string) => void;
  selectBranch: (branch: string) => void;
  expandSection: (section: string) => void;
  collapseSection: (section: string) => void;
}

/**
 * Editor props - passed to all editor components
 */
export interface EditorProps<T = any> {
  fileId: string;
  data?: T;
  onChange: (newData: T) => void;
  readonly?: boolean;
  viewMode: ViewMode;
}

/**
 * Graph data structure (matches schema/conversion-graph-1.0.0.json)
 */
export interface GraphData {
  nodes: Array<{
    id: string;
    slug: string;
    label?: string;
    description?: string;
    tags?: string[];
    type?: 'normal' | 'case';
    absorbing?: boolean;
    outcome_type?: 'success' | 'failure' | 'error' | 'neutral' | 'other';
    entry?: any;
    costs?: any;
    residual_behavior?: any;
    layout?: {
      x: number;
      y: number;
      color?: string;
    };
    case?: any;
  }>;
  edges: Array<{
    id: string;
    slug?: string;
    from: string;
    to: string;
    fromHandle?: string;
    toHandle?: string;
    description?: string;
    p?: {
      mean?: number;
      stdev?: number;
      locked?: boolean;
      parameter_id?: string;
    };
    conditional_p?: Array<{
      condition: {
        visited: string[];
      };
      p: {
        mean?: number;
        stdev?: number;
        locked?: boolean;
        parameter_id?: string;
      };
    }>;
    weight_default?: number;
    costs?: any;
    case_variant?: string;
    case_id?: string;
    display?: {
      conditional_color?: string;
      conditional_group?: string;
    };
  }>;
  policies?: {
    default_outcome: string;
    overflow_policy?: 'error' | 'normalize' | 'cap';
    free_edge_policy?: 'complement' | 'uniform' | 'weighted';
  };
  metadata?: {
    version: string;
    created_at: string;
    updated_at?: string;
    [key: string]: any;
  };
}

/**
 * Parameter data structure (existing)
 */
export interface ParameterData {
  id: string;
  name: string;
  type: 'probability' | 'cost' | 'time' | 'rate' | 'other';
  value?: number | string;
  description?: string;
  metadata?: Record<string, any>;
}

/**
 * Context data structure (existing)
 */
export interface ContextData {
  id: string;
  name: string;
  description?: string;
  variables?: Record<string, any>;
  metadata?: Record<string, any>;
}

/**
 * Case data structure (existing)
 */
export interface CaseData {
  id: string;
  name: string;
  description?: string;
  inputs?: Record<string, any>;
  expectedOutputs?: Record<string, any>;
  metadata?: Record<string, any>;
}

