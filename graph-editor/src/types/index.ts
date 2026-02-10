// Core Types for Tab System

import type { Scenario } from './scenarios';

/**
 * Object types that can be opened in tabs
 */
export type ObjectType = 
  | 'graph' 
  | 'chart'
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
  | 'image'
  | 'signature-links';

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
    showNodeImages?: boolean;
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
      // LAG: Per-scenario visibility mode for evidence/forecast display
      visibilityMode?: Record<string, ScenarioVisibilityMode>;
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
  selectedTags?: string[];              // Active tag filter selections
  
  // Registry indexes (lightweight metadata catalogs)
  registryIndexes?: {
    parameters?: any;  // parameters-index.yaml (workspace)
    contexts?: any;    // contexts-index.yaml (workspace)
    cases?: any;       // cases-index.yaml (workspace)
    nodes?: any;       // nodes-index.yaml (workspace)
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

  // Auto-update (local-only, not in repo)
  autoUpdateChartsEnabled?: boolean;
  
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
  data?: {
    /** When true, exclude test accounts (nousemates cohort) from Amplitude queries */
    excludeTestAccounts?: boolean;
  };
}

/**
 * Tab operations interface
 */
export interface TabOperations {
  openTab: (item: RepositoryItem, viewMode?: ViewMode, forceNew?: boolean, initialEditorState?: Partial<TabState['editorState']>) => Promise<void>;
  /**
   * Open a tab for an already-seeded file without triggering any repo fetch.
   *
   * Used by share/live bootstrap codepaths (bundle/chart) where TabContext intentionally skips
   * restoring workspace tabs and the URL payload drives which tabs should be visible.
   */
  openTemporaryTab: (tab: TabState) => Promise<void>;
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
  cycleScenarioVisibilityMode: (tabId: string, scenarioId: string) => Promise<void>;
  getScenarioVisibilityMode: (tabId: string, scenarioId: string) => ScenarioVisibilityMode;
  /** Set scenario visibility mode (render basis only: evidence/forecast/both) */
  setScenarioVisibilityMode: (tabId: string, scenarioId: string, mode: ScenarioVisibilityMode) => Promise<void>;
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
  setSelectedTags: (tags: string[]) => void;
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
// GRAPH SCHEMA TYPES (aligned with schema/conversion-graph-1.1.0.json)
// ============================================================================

export type UUID = string;
export type HumanId = string; // Human-readable identifier
export type OutcomeType = 'success' | 'failure' | 'error' | 'neutral' | 'other';
export type NodeType = 'normal' | 'case';
export type CaseStatus = 'active' | 'paused' | 'completed';
export type OverflowPolicy = 'error' | 'normalize' | 'cap';
export type FreeEdgePolicy = 'complement' | 'uniform' | 'weighted';

/**
 * Scenario visibility mode for LAG (evidence/forecast display).
 *
 * IMPORTANT: This controls **how** a visible scenario is rendered, not
 * **whether** it is visible. Visibility is controlled separately via the
 * visibleScenarioIds list in TabContext.
 *
 * - 'f+e': Show both forecast and evidence (default)
 * - 'f': Forecast only (striped)
 * - 'e': Evidence only (solid)
 */
export type ScenarioVisibilityMode = 'f+e' | 'f' | 'e';

/**
 * Time-series data point (daily breakdown)
 * 
 * For 3-step A→X→Y funnels:
 *   - median_lag_days / mean_lag_days: X→Y transition time (edge latency)
 *   - anchor_n / anchor_median_lag_days / anchor_mean_lag_days: A→X upstream data
 */
export interface TimeSeriesPoint {
  date: string; // YYYY-MM-DD
  n: number;
  k: number;
  p: number;
  median_lag_days?: number;  // For cohort mode: X→Y median lag (days)
  mean_lag_days?: number;    // For cohort mode: X→Y mean lag (days)
  // Anchor data for downstream completeness (3-step funnels)
  anchor_n?: number;                 // Cohort entry count at anchor (step 0)
  anchor_median_lag_days?: number;   // A→X median lag (upstream transition time)
  anchor_mean_lag_days?: number;     // A→X mean lag (upstream transition time)
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
  
  // === Query-time scalars (computed from n/k, see design.md §4.8) ===
  /** Evidence probability: raw observed rate = k/n (query-time scalar) */
  mean?: number;
  /** Evidence uncertainty: binomial stdev for the evidence rate */
  stdev?: number;
  
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

/**
 * Latency configuration for edges with time-delayed conversions.
 * Attached to ProbabilityParam (edge.p.latency and edge.conditional_p[i].p.latency)
 * 
 * SEMANTICS:
 * - latency_parameter === true: Latency tracking ENABLED (cohort queries, forecasting, latency UI)
 * - latency_parameter === false or undefined: Latency tracking DISABLED (standard window() behaviour)
 */
export interface LatencyConfig {
  /** Explicit latency enablement flag - set true to enable latency tracking.
   */
  latency_parameter?: boolean;
  /** True if user manually set latency_parameter (vs derived from file) */
  latency_parameter_overridden?: boolean;
  
  /** Anchor node for cohort queries - furthest upstream START node from edge.from
   *  Computed by MSMDC at graph-edit time (not retrieval time)
   */
  anchor_node_id?: string;
  /** True if user manually set anchor_node_id (vs MSMDC-computed) */
  anchor_node_id_overridden?: boolean;
  
  /** 95th percentile lag in days - persisted scalar for caching / A→X maturity
   *  Computed from fitted log-normal CDF. Scenario-independent.
   */
  t95?: number;
  /** True if user manually set t95 (vs computed from stats) */
  t95_overridden?: boolean;
  
  /** Cumulative path latency (t95) from anchor to this edge.
   *  Computed by statisticalEnhancementService.computePathT95().
   *  Used for cohort retrieval horizon calculations.
   */
  path_t95?: number;
  /** True if user manually set path_t95 (vs computed from topo pass) */
  path_t95_overridden?: boolean;
  
  /** Onset delay in days - minimum time before conversions begin.
   *  Aggregated from window() slice histograms (min of per-slice onset values).
   *  Used for shifted lognormal latency fitting and maturity calculations.
   */
  onset_delta_days?: number;
  /** True if user manually set onset_delta_days (vs aggregated from slices) */
  onset_delta_days_overridden?: boolean;
  
  // === Display-only fields (populated from file, not user-editable) ===
  
  /** Weighted median lag in days for this edge */
  median_lag_days?: number;
  
  /** Weighted mean lag in days (used with median to compute t95) */
  mean_lag_days?: number;
  
  /** Maturity progress 0-1 (see design §5.5) */
  completeness?: number;

  /** Fitted log-normal mu parameter (internal, not UI-exposed) */
  mu?: number;
  /** Fitted log-normal sigma parameter (internal, not UI-exposed) */
  sigma?: number;
  /** UK date (d-MMM-yy) when the model was last fitted (staleness detection, not UI-exposed) */
  model_trained_at?: string;
}

/**
 * Latency display data for edge rendering.
 * Used by UI components to show latency information (beads, tooltips).
 * 
 * This interface now includes **pre-computed rendering decisions** so that
 * ConversionEdge doesn't need to recompute mode/widths/dashing/opacity.
 * All decisions are made in `buildScenarioRenderEdges` for consistency.
 */
export interface EdgeLatencyDisplay {
  /** Whether LAG rendering is enabled for this edge (always true if this object exists) */
  enabled: boolean;
  
  // === Raw data fields ===
  
  /** Median lag in days (for bead display) */
  median_days?: number;
  
  /** Completeness percentage 0-100 (for bead display) */
  completeness_pct?: number;
  
  /** 95th percentile lag in days */
  t95?: number;
  
  /** Evidence probability (observed rate from immature + mature cohorts) */
  p_evidence?: number;
  
  /** Forecast probability (projected completion rate) */
  p_forecast?: number;
  
  /** Blended probability (used for rendering) */
  p_mean?: number;
  
  // === Derived booleans (pre-computed) ===
  
  /** True when p_evidence is a number (evidence block exists) */
  hasEvidence?: boolean;
  
  /** True when hasEvidence AND p_evidence === 0 (k=0 case) */
  evidenceIsZero?: boolean;
  
  /** True when p_forecast is a number */
  hasForecast?: boolean;
  
  /** True when median_days or t95 or completeness_pct is present and > 0 */
  hasLatency?: boolean;
  
  // === Rendering mode (pre-computed) ===
  
  /** Final rendering mode after combining user preference + data availability */
  mode?: ScenarioVisibilityMode;
  
  // === Pre-computed widths (replaces lagLayerData computation in ConversionEdge) ===
  
  /** Width for evidence lane (0 when no evidence or evidence=0) */
  evidenceWidth?: number;
  
  /** Width for mean/forecast lane (anchor width) */
  meanWidth?: number;
  
  /** Ratio of evidence to mean (0-1) */
  evidenceRatio?: number;
  
  // === Styling flags (pre-computed) ===
  
  /** True when edge should render with dashed stroke (p.mean=0 OR evidence=0 in E mode) */
  isDashed?: boolean;
  
  /** True when edge has no evidence block but p.mean > 0 (use NO_EVIDENCE_E_MODE_OPACITY) */
  useNoEvidenceOpacity?: boolean;

  // === Derived basis flags (view-only) ===
  /** True when the evidence basis value used in E mode was derived via sibling residual allocation (display-only). */
  evidenceIsDerived?: boolean;
  /** True when the forecast basis value used in F mode was derived via sibling residual allocation (display-only). */
  forecastIsDerived?: boolean;
  
  // === Latency bead policy (pre-computed based on query mode) ===
  
  /** True when latency bead should be shown for this edge */
  showLatencyBead?: boolean;
  
  /** True when bead should show completeness only (no median-lag label) - for non-latency edges in cohort mode */
  showCompletenessOnly?: boolean;
}

export interface ProbabilityParam {
  mean?: number; // [0,1]
  stdev?: number; // >= 0
  mean_overridden?: boolean; // If true, mean was manually edited
  stdev_overridden?: boolean; // If true, stdev was manually edited
  distribution_overridden?: boolean; // If true, distribution was manually edited
  id?: string; // Reference to parameter file (FK to parameter-{id}.yaml)
  distribution?: 'normal' | 'beta' | 'uniform';
  connection?: string; // Connection name from connections.yaml
  connection_overridden?: boolean; // If true, connection was manually edited
  connection_string?: string; // JSON blob of provider-specific settings
  // NOTE: 'query' field removed - legacy field, actual query lives at edge.query
  evidence?: Evidence; // Observations from data sources (n, k, window, etc.)
  data_source?: { // Provenance information
    type: string; // Data source type (from connections.yaml, e.g., 'amplitude', 'manual', 'sheets')
    retrieved_at?: string;
    edited_at?: string;
    // NOTE: 'query' field removed - was unused and caused type mismatch with Python (Dict vs string)
    full_query?: string; // Full DSL query string (e.g., "from(a).to(b).visited(c)")
    debug_trace?: string;
    experiment_id?: string; // Experiment/gate ID for A/B test sources (e.g., Statsig gate_id)
    no_data?: boolean; // True if data source returned no data
  };
  
  // === LAG (Latency-Aware Graph) fields ===
  
  /** Latency configuration for this probability parameter */
  latency?: LatencyConfig;
  
  /** Forecast probability from mature cohorts (p_∞) */
  forecast?: {
    mean?: number;  // Forecast mean probability
    stdev?: number; // Forecast standard deviation
    /** Expected converters on this edge = p.mean * p.n.
     *  Used for propagating population downstream (inbound-n calculation).
     *  Cached after batch fetch; single-edge fetches sum inbound forecast.k for p.n.
     */
    k?: number;
  };
  
  // === Inbound-n: Forecast population semantics (see inbound-n-fix.md) ===
  
  /** Forecast population for this edge under the current DSL.
   *  
   *  NOT the same as evidence.n (observed population from Amplitude).
   *  This is derived via step-wise convolution from upstream:
   *  - For anchor edges (A=X, where A is START): equals evidence.n
   *  - For downstream edges: sum of inbound p.forecast.k at the from-node
   *  
   *  Query-time value, recomputed when DSL or scenario changes.
   *  May be persisted for pinned DSL only.
   */
  n?: number;
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
  connection_overridden?: boolean; // If true, connection was manually edited
  connection_string?: string; // JSON blob of provider-specific settings
  evidence?: Evidence; // Observations from data sources
  data_source?: { // Provenance information
    type: string; // Data source type (from connections.yaml, e.g., 'amplitude', 'manual', 'sheets')
    retrieved_at?: string;
    edited_at?: string;
    full_query?: string; // Full DSL query string
    debug_trace?: string;
    experiment_id?: string; // Experiment/gate ID for A/B test sources
  };
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
  labour_cost?: CostParam; // Cost in time (e.g., days)
  costs?: Costs; // DEPRECATED: old format, use cost_gbp/labour_cost instead
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
  name?: string; // Human-readable graph name for display in UI
  created_at: string; // ISO datetime or UK format (d-MMM-yy)
  updated_at?: string;
  /**
   * Cross-device marker: last time a full Retrieve All Slices run completed successfully for this graph.
   * Stored as epoch ms to avoid ISO date strings in file storage.
   */
  last_retrieve_all_slices_success_at_ms?: number;
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
  debugging?: boolean;
  
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
  
  /**
   * If true, this graph is included in unattended daily automation runs
   * when ?retrieveall is used without an explicit graph list.
   */
  dailyFetch?: boolean;
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

