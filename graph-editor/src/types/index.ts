// Core Types for Tab System

import type { Scenario } from './scenarios';

/**
 * Object types that can be opened in tabs
 */
export type ObjectType = 
  | 'graph' 
  | 'parameter' 
  | 'context' 
  | 'case'
  | 'node'
  | 'event'
  | 'credentials'
  | 'connections'
  | 'settings'
  | 'about'
  | 'markdown'
  | 'image';

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
 * Workspace state - represents a cloned repository in IndexedDB
 */
export interface WorkspaceState {
  id: string;                  // `${repository}-${branch}`
  repository: string;          // Repository name from credentials
  branch: string;              // Branch name
  lastSynced: number;          // Timestamp of last sync with remote
  commitSHA?: string;          // Last synced commit SHA
  fileIds: string[];           // Array of fileIds in this workspace
  isCloning?: boolean;         // True while initial clone is in progress
  cloneError?: string;         // Error message if clone failed
}

/**
 * File state - single source of truth for a file
 * Multiple tabs can view the same file
 */
export interface FileState<T = any> {
  fileId: string;              // Unique ID for this file
  type: ObjectType;
  name?: string;               // Display name
  path?: string;               // File path in repository
  // Scenarios associated with this file (persisted per file)
  scenarios?: Scenario[];
  
  // Data
  data?: T;                    // Current state
  originalData?: T;            // For revert
  isDirty?: boolean;           // Shared across all views
  isInitializing?: boolean;    // True during initial load/validation phase
  
  // Source
  source?: FileSource;
  
  // Loading state
  isLoaded?: boolean;          // Whether file content is loaded
  isLocal?: boolean;           // Whether file is local-only (not in repo)
  
  // Which tabs are viewing this file
  viewTabs: string[];          // Array of tab IDs
  
  // Metadata
  lastModified?: number;
  lastSaved?: number;
  lastOpened?: number;
  
  // Git metadata
  sha?: string;                // Git SHA for conflict detection
  lastSynced?: number;         // Last time synced with remote
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
    // ReactFlow viewport persistence (per tab)
    rfViewport?: { x: number; y: number; zoom: number };
    autoReroute?: boolean;
    useSankeyView?: boolean;
    confidenceIntervalLevel?: 'none' | '80' | '90' | '95' | '99';
    animateFlow?: boolean;
    sidebarOpen?: boolean;
    whatIfOpen?: boolean;
    propertiesOpen?: boolean;
    jsonOpen?: boolean;
    selectedNodeId?: string | null;
    selectedEdgeId?: string | null;
    // What-if analysis state (per-tab, not per-file)
    whatIfAnalysis?: any;
    caseOverrides?: Record<string, string>; // nodeId -> variantName (legacy, will be converted to whatIfDSL)
    conditionalOverrides?: Record<string, string | Set<string>>; // edgeId -> normalized condition string (legacy, will be converted to whatIfDSL)
    whatIfDSL?: string | null; // Unified DSL string (e.g., "case(case_id:treatment).visited(nodea)") - NEW
    // Analytics query DSL (can be auto-generated from selection or manually overridden)
    analyticsQueryDSL?: string | null;
    analyticsQueryOverridden?: boolean; // True if user manually edited the DSL
    // Target panel for "Open in X View" placement
    targetPanel?: string;
    // Node visibility state (per-tab, not per-file)
    hiddenNodes?: Set<string>; // Set of node IDs that are hidden
    // Window selector state (per-file, shared across tabs - stored in first tab's editorState)
    window?: { start: string; end: string } | null;
    // Last window that data was aggregated for (to detect if window changed due to time passing)
    lastAggregatedWindow?: { start: string; end: string } | null;
    // NEW: Sidebar state (Phase 1 - Icon Bar)
    sidebarState?: {
      mode: 'minimized' | 'maximized';
      activePanel: 'what-if' | 'properties' | 'tools' | 'analytics';
      sidebarWidth?: number; // Track sidebar width for minimize button positioning
      isResizing?: boolean; // Track if sidebar is being resized
      floatingPanels: string[];
      hasAutoOpened: boolean;
      whatIfOpen: boolean;
      propertiesOpen: boolean;
      toolsOpen: boolean;
    };
    // Scenarios state (per-tab visibility and selection)
    scenarioState?: {
      scenarioOrder?: string[];           // Full layer order (includes hidden + special layers)
      visibleScenarioIds: string[];       // IDs of visible scenarios (render order)
      visibleColourOrderIds: string[];     // IDs in activation order (for colour assignment)
      selectedScenarioId?: string;        // Currently selected scenario
    };
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
  
  // View and filter options
  viewMode?: 'all' | 'files-only';     // Show all index entries or only files
  showLocalOnly?: boolean;              // Filter to local-only files
  showDirtyOnly?: boolean;              // Filter to dirty files
  showOpenOnly?: boolean;               // Filter to open files
  sortBy?: 'name' | 'modified' | 'opened' | 'status' | 'type';  // Sort order
  groupBySubCategories?: boolean;       // Group by sub-categories (parameter_type, node_type, etc.)
  groupByTags?: boolean;                // Group by tags
  
  // Registry indexes (lightweight metadata catalogs)
  registryIndexes?: {
    parameters?: any;  // ParametersIndex from paramRegistryService
    contexts?: any;    // ContextsIndex from paramRegistryService
    cases?: any;       // CasesIndex from paramRegistryService
    nodes?: any;       // NodesIndex from paramRegistryService
  };
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
  isLocal?: boolean; // True if file exists only locally (not yet committed)
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
  localItems?: RepositoryItem[]; // Uncommitted files
  
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
  
  // Node visibility operations
  hideNode: (tabId: string, nodeId: string) => Promise<void>;
  unhideNode: (tabId: string, nodeId: string) => Promise<void>;
  hideUnselectedNodes: (tabId: string, selectedNodeIds: string[]) => Promise<void>;
  showAllNodes: (tabId: string) => Promise<void>;
  isNodeHidden: (tabId: string, nodeId: string) => boolean;
  
  // Scenario operations
  getScenarioState: (
    tabId: string
  ) =>
    | {
        scenarioOrder?: string[];
        visibleScenarioIds: string[];
        visibleColourOrderIds: string[];
        selectedScenarioId?: string;
      }
    | undefined;
  setVisibleScenarios: (tabId: string, scenarioIds: string[]) => Promise<void>;
  addVisibleScenarios: (tabId: string, scenarioIdsToAdd: string[]) => Promise<void>;
  toggleScenarioVisibility: (tabId: string, scenarioId: string) => Promise<void>;
  selectScenario: (tabId: string, scenarioId: string | undefined) => Promise<void>;
  reorderScenarios: (tabId: string, newOrder: string[]) => Promise<void>;
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
  addLocalItem: (item: RepositoryItem) => void;
  removeLocalItem: (fileId: string) => void;
  refreshItems: () => Promise<void>;
  reloadCredentials: () => Promise<void>;
  forceFullReload: () => Promise<void>;
  
  // Filter and sort operations
  setViewMode: (mode: 'all' | 'files-only') => void;
  setShowLocalOnly: (show: boolean) => void;
  setShowDirtyOnly: (show: boolean) => void;
  setShowOpenOnly: (show: boolean) => void;
  setSortBy: (sort: 'name' | 'modified' | 'opened' | 'status' | 'type') => void;
  setGroupBySubCategories: (group: boolean) => void;
  setGroupByTags: (group: boolean) => void;
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

// ============================================================================
// GRAPH SCHEMA TYPES (aligned with schema/conversion-graph-1.0.0.json)
// ============================================================================

export type UUID = string;
export type HumanId = string; // Human-readable identifier
export type OutcomeType = 'success' | 'failure' | 'error' | 'neutral' | 'other';
export type NodeType = 'normal' | 'case';
export type CaseStatus = 'active' | 'paused' | 'completed';
export type OverflowPolicy = 'error' | 'normalize' | 'cap';
export type FreeEdgePolicy = 'complement' | 'uniform' | 'weighted';

/**
 * Time-series data point (daily breakdown)
 */
export interface TimeSeriesPoint {
  date: string; // YYYY-MM-DD
  n: number;
  k: number;
  p: number;
}

/**
 * Date range for window aggregation
 */
export interface DateRange {
  start: string; // YYYY-MM-DD or ISO 8601
  end: string; // YYYY-MM-DD or ISO 8601
}

export interface Evidence {
  n?: number; // Sample size (total trials)
  k?: number; // Number of successes
  window_from?: string; // Time window start (ISO date-time)
  window_to?: string; // Time window end (ISO date-time)
  retrieved_at?: string; // When data was retrieved (ISO date-time)
  source?: string; // Connection name used for this retrieval
  path?: 'direct' | 'file'; // How data was retrieved: 'direct' = fetched from connection, 'file' = synced from parameter file
  full_query?: string; // Complete DSL query string (includes base query + window + context)
  debug_trace?: string; // Complete execution trace as JSON string for debugging/provenance
}

export interface CaseEvidence {
  source?: string; // Connection name used for this fetch
  fetched_at?: string; // ISO timestamp of fetch
  path?: 'direct' | 'file'; // How data was retrieved: 'direct' = fetched from connection, 'file' = synced from case file
  full_query?: string; // Complete query string used for this fetch
  variants?: Array<{
    variant_id?: string;
    name?: string;
    allocation?: number;
  }>;
  debug_trace?: string; // Complete execution trace as JSON string for debugging/provenance
}

export interface ProbabilityParam {
  mean?: number; // [0,1]
  stdev?: number; // >= 0
  locked?: boolean; // DEPRECATED: use mean_overridden instead
  mean_overridden?: boolean; // If true, mean was manually edited
  stdev_overridden?: boolean; // If true, stdev was manually edited
  distribution_overridden?: boolean; // If true, distribution was manually edited
  id?: string; // Reference to parameter file (FK to parameter-{id}.yaml)
  distribution?: 'normal' | 'beta' | 'uniform';
  connection?: string; // Connection name from connections.yaml
  connection_string?: string; // JSON blob of provider-specific settings
  query?: any; // Query object for data retrieval (DSL query: from/to/visited/etc)
  evidence?: Evidence; // Observations from data sources
}

export interface CostParam {
  mean?: number; // >= 0
  stdev?: number; // >= 0
  mean_overridden?: boolean; // If true, mean was manually edited
  stdev_overridden?: boolean; // If true, stdev was manually edited
  distribution_overridden?: boolean; // If true, distribution was manually edited
  id?: string; // Reference to cost parameter file (FK to parameter-{id}.yaml)
  distribution?: 'normal' | 'lognormal' | 'gamma' | 'uniform' | 'beta';
  connection?: string; // Connection name from connections.yaml
  connection_string?: string; // JSON blob of provider-specific settings
  evidence?: Evidence; // Observations from data sources
}

/**
 * @deprecated Use string format for conditions instead (Query DSL)
 * Old format: { visited: ['node-a', 'node-b'] }
 * New format: "visited(node-a, node-b)"
 */
export interface Condition {
  visited: string[]; // Array of node IDs that must be visited
  query?: string; // Query expression for conditionality (alternative to visited array)
}

export interface ConditionalProbability {
  // Semantic constraint: determines WHEN this conditional applies (runtime evaluation)
  // Uses Query DSL string format: "visited(promo)", "context(device:mobile)", etc.
  condition: string;
  
  // Full data retrieval query: determines HOW to fetch data from external sources
  // Auto-derived from condition + edge topology, but can be manually overridden
  query?: string; // Full query: "from(checkout).to(purchase).visited(promo)"
  query_overridden?: boolean; // If true, query was manually edited (don't regenerate)
  
  p: ProbabilityParam; // Probability when condition is satisfied
  
  // Display colour for this condition (propagates to matching conditions on sibling edges)
  colour?: string; // hex colour
}

export interface MonetaryCost {
  value: number; // >= 0
  stdev?: number; // >= 0
  distribution?: string;
  currency?: string; // e.g., "USD", "GBP", "EUR"
}

export interface TimeCost {
  value: number; // >= 0
  stdev?: number; // >= 0
  distribution?: string;
  units?: string; // e.g., "days", "hours", "weeks"
}

export interface Costs {
  monetary?: MonetaryCost | number;
  time?: TimeCost | number;
  units?: string; // Deprecated: for backward compatibility
}

export interface ResidualBehavior {
  default_outcome?: string;
  overflow_policy?: OverflowPolicy;
}

export interface NodeLayout {
  x?: number;
  y?: number;
  rank?: number; // >= 0
  group?: string; // <= 128 chars
  colour?: string; // hex colour
}

export interface NodeEntry {
  is_start?: boolean;
  entry_weight?: number; // >= 0
}

export interface CaseVariant {
  name: string;
  name_overridden?: boolean; // If true, name was manually edited
  weight: number; // [0,1], must sum to 1.0 for all variants in case
  weight_overridden?: boolean; // If true, weight was manually edited
  description?: string;
  description_overridden?: boolean; // If true, description was manually edited
  edges?: string[]; // Graph-only: edges that use this variant
}

export interface NodeImage {
  image_id: string;
  caption: string;
  caption_overridden?: boolean;  // Graph-level only
  file_extension: 'png' | 'jpg' | 'jpeg';
  uploaded_at?: string;  // Registry-level only
  uploaded_by?: string;  // Registry-level only
}

export interface GraphNode {
  uuid: UUID;       // System-generated UUID
  id: HumanId;      // Human-readable identifier
  label?: string;
  label_overridden?: boolean;  // Override flag for auto-sync
  description?: string;
  description_overridden?: boolean;  // Override flag for auto-sync
  tags?: string[];
  type?: NodeType; // default 'normal'
  absorbing?: boolean; // default false
  outcome_type?: OutcomeType;
  outcome_type_overridden?: boolean; // Override flag for auto-sync
  event_id?: string; // Reference to event file (FK to event-{id}.yaml)
  event_id_overridden?: boolean; // Override flag for auto-sync
  entry?: NodeEntry;
  costs?: Costs;
  residual_behavior?: ResidualBehavior;
  layout?: NodeLayout;
  url?: string;
  url_overridden?: boolean;
  images?: NodeImage[];
  images_overridden?: boolean;
  case?: {
    id: string; // Reference to case file (FK to case-{id}.yaml)
    status: CaseStatus;
    status_overridden?: boolean; // Override flag for auto-sync
    connection?: string; // Connection name from connections.yaml
    connection_string?: string; // JSON blob of provider-specific settings
    evidence?: CaseEvidence; // Evidence from last variant fetch
    variants: CaseVariant[];
  };
}

export interface EdgeDisplay {
  conditional_colour?: string;
  conditional_group?: string;
}

export interface GraphEdge {
  uuid: UUID;           // System-generated UUID
  id?: HumanId;         // Human-readable identifier
  from: string;         // node uuid
  to: string;           // node uuid
  fromHandle?: string;
  toHandle?: string;
  description?: string;
  description_overridden?: boolean;  // Override flag for auto-sync
  p?: ProbabilityParam; // Base probability (fallback when no conditions match)
  conditional_p?: ConditionalProbability[];
  weight_default?: number; // >= 0
  cost_gbp?: CostParam; // Cost in GBP
  cost_time?: CostParam; // Cost in time (e.g., days)
  costs?: Costs; // DEPRECATED: old format, use cost_gbp/cost_time instead
  case_variant?: string;
  case_id?: string;
  display?: EdgeDisplay;
  query?: string; // Query expression for data retrieval (e.g., path constraints)
  query_overridden?: boolean; // If true, query was manually edited
  n_query?: string; // Optional: explicit query for n (denominator) when it differs from k query
  n_query_overridden?: boolean; // If true, n_query was manually edited
}

export interface Policies {
  default_outcome: string;
  overflow_policy?: OverflowPolicy;
  free_edge_policy?: FreeEdgePolicy;
}

export interface Metadata {
  version: string; // semver
  created_at: string; // ISO datetime
  updated_at?: string;
  author?: string;
  description?: string;
  tags?: string[];
}

export interface PostIt {
  id: string;
  text: string;
  colour: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
}

export interface ConversionGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  policies: Policies;
  metadata: Metadata;
  postits?: PostIt[];
  
  // Contexts: Data interests specification for nightly runner
  dataInterestsDSL?: string; // Query template (e.g., "context(channel);context(browser-type).window(-90d:)")
                              // Drives which slices the nightly runner will fetch and cache
  
  // Contexts: Current query state for UI persistence
  currentQueryDSL?: string; // Current user query (e.g., "context(channel:google).window(1-Jan-25:31-Mar-25)")
                             // Persisted so graph reopens with same query state
  
  /**
   * Base query DSL for live scenario composition.
   * 
   * Live scenarios inherit from this DSL unless they override specific constraints.
   * Set via "To Base" action or manually.
   * Persists to YAML file.
   * 
   * @example "window(-30d:)" — all live scenarios inherit this window unless they specify their own
   * @example "window(-90d:).context(channel:google)" — both window and context inherited
   */
  baseDSL?: string;
}

export type Graph = ConversionGraph;
export type GraphData = ConversionGraph; // Alias for backward compatibility

export interface WhatIfState {
  caseOverrides: Map<string, string>;
  conditionalOverrides: Map<string, Set<string>>;
}

export interface ValidationError {
  type: 'probability_sum' | 'invalid_reference' | 'circular_dependency' | 'missing_node';
  nodeId?: string;
  edgeId?: string;
  condition?: string;
  message: string;
  sum?: number;
}

export interface ValidationWarning {
  type: 'incomplete_conditions' | 'inconsistent_siblings';
  nodeId?: string;
  edgeId?: string;
  message: string;
}

export interface ValidationResult {
  errors: ValidationError[];
  warnings: ValidationWarning[];
  isValid: boolean;
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
 * Case data structure (registry file format)
 * NOTE: This is the REGISTRY file format (case-{id}.yaml), NOT the inline graph case data!
 * For inline graph case data, see GraphNode.case property above.
 */
export interface CaseRegistryData {
  id: string;
  name: string;
  description?: string;
  inputs?: Record<string, any>;
  expectedOutputs?: Record<string, any>;
  metadata?: Record<string, any>;
}

