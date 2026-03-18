/**
 * Analysis Type Metadata
 * 
 * Static metadata for all analysis types including icons, descriptions,
 * and selection hints. This is merged with the backend's availability info.
 */

import {
  BarChart3,
  GitBranch,
  Target,
  Route,
  ArrowRight,
  ArrowDown,
  ArrowLeftRight,
  Split,
  Combine,
  GitMerge,
  Waypoints,
  Network,
  Info,
  Database,
  Calendar,
  TrendingUp,
  CircleDot,
  Cable,
  FlaskConical,
  type LucideIcon,
} from 'lucide-react';

// ============================================================
// Snapshot Contract — declares DB read requirements for an analysis type
// See: docs/current/project-db/1-reads.md §7
// ============================================================

export type ScopeRule =
  | 'selection_edge'
  | 'selection_edges'
  | 'children_of_selected_node'
  | 'funnel_path'
  | 'reachable_from'
  | 'all_graph_parameters';

export type ReadMode = 'raw_snapshots' | 'virtual_snapshot' | 'cohort_maturity' | 'sweep_simple';

export type SlicePolicy = 'explicit' | 'mece_fulfilment_allowed';

export type TimeBoundsSource = 'query_dsl_window' | 'analysis_arguments';

export interface SnapshotContract {
  /** Which parameters are in scope */
  scopeRule: ScopeRule;
  /** What DB query shape is needed */
  readMode: ReadMode;
  /** How slices are resolved for each subject */
  slicePolicy: SlicePolicy;
  /** How anchor_from/to are derived */
  timeBoundsSource: TimeBoundsSource;
  /** Whether per-scenario separation is needed */
  perScenario: boolean;
}

export interface AnalysisTypeMeta {
  id: string;
  name: string;
  shortDescription: string;
  selectionHint: string;
  icon: LucideIcon;
  /** If present, this analysis type requires snapshot DB data */
  snapshotContract?: SnapshotContract;
  /** If true, this type is used by backend pipelines only (e.g. Bayes compiler)
   *  and should never appear in user-facing selectors or chart/satellite UI. */
  internal?: boolean;
}

/**
 * All analysis types with UI metadata.
 * Order determines display order in the selector.
 */
export const ANALYSIS_TYPES: AnalysisTypeMeta[] = [
  // Empty selection
  {
    id: 'graph_overview',
    name: 'Graph Overview',
    shortDescription: 'Overall outcomes from all entry points',
    selectionHint: 'No selection needed - analyzes entire graph',
    icon: Network,
  },
  
  // Single node analyses
  {
    id: 'from_node_outcomes',
    name: 'Outcomes from Node',
    shortDescription: 'Probability of reaching each outcome',
    selectionHint: 'Select a single start/entry node with from()',
    icon: ArrowRight,
  },
  {
    id: 'to_node_reach',
    name: 'Reach Probability',
    shortDescription: 'Probability of reaching this node',
    selectionHint: 'Select a single end/absorbing node with to()',
    icon: Target,
  },
  {
    id: 'bridge_view',
    name: 'Bridge View',
    shortDescription: 'Explain Reach Probability change between two scenarios',
    selectionHint: 'Requires exactly 2 visible scenarios. Select a single end node with to()',
    icon: ArrowLeftRight,
  },
  {
    id: 'path_through',
    name: 'Path Through Node',
    shortDescription: 'Paths passing through this node',
    selectionHint: 'Select a single middle node with visited()',
    icon: ArrowDown,
  },
  
  // Two node analyses
  {
    id: 'path_between',
    name: 'Path Between Nodes',
    shortDescription: 'Probability and cost from start to end',
    selectionHint: 'Select two nodes with from() and to()',
    icon: Route,
  },
  {
    id: 'outcome_comparison',
    name: 'Outcome Comparison',
    shortDescription: 'Compare probabilities of reaching nodes',
    selectionHint: 'Select 2+ nodes with visitedAny()',
    icon: BarChart3,
    snapshotContract: {
      scopeRule: 'children_of_selected_node',
      readMode: 'raw_snapshots',
      slicePolicy: 'mece_fulfilment_allowed',
      timeBoundsSource: 'query_dsl_window',
      perScenario: true,
    },
  },
  {
    id: 'branch_comparison',
    name: 'Branch Comparison',
    shortDescription: 'Compare parallel branches',
    selectionHint: 'Select 2+ sibling nodes with visitedAny()',
    icon: Split,
    snapshotContract: {
      scopeRule: 'children_of_selected_node',
      readMode: 'raw_snapshots',
      slicePolicy: 'mece_fulfilment_allowed',
      timeBoundsSource: 'query_dsl_window',
      perScenario: true,
    },
  },
  {
    id: 'multi_waypoint',
    name: 'Multi-Waypoint Path',
    shortDescription: 'Path through multiple waypoints',
    selectionHint: 'Select 2+ waypoints with visited()',
    icon: Waypoints,
  },
  
  // Three+ node analyses - funnel/path
  {
    id: 'conversion_funnel',
    name: 'Conversion Funnel',
    shortDescription: 'Probability at each stage of journey',
    selectionHint: 'Select from(), to(), and visited() nodes',
    icon: ArrowDown,
  },
  {
    id: 'constrained_path',
    name: 'Constrained Path',
    shortDescription: 'Paths forced through all waypoints',
    selectionHint: 'Select from(), to(), and visited() nodes',
    icon: GitMerge,
  },
  {
    id: 'branches_from_start',
    name: 'Branches from Start',
    shortDescription: 'Compare outcomes from starting point',
    selectionHint: 'Select from() and visitedAny() nodes',
    icon: GitBranch,
  },
  {
    id: 'multi_outcome_comparison',
    name: 'Multi-Outcome Comparison',
    shortDescription: 'Compare 3+ node probabilities',
    selectionHint: 'Select 3+ nodes with visitedAny()',
    icon: Combine,
  },
  {
    id: 'multi_branch_comparison',
    name: 'Multi-Branch Comparison',
    shortDescription: 'Compare 3+ parallel branches',
    selectionHint: 'Select 3+ sibling nodes',
    icon: GitBranch,
  },
  
  // Element info (FE-computable, progressive BE augmentation)
  {
    id: 'node_info',
    name: 'Node Info',
    shortDescription: 'Curated summary of a single node',
    selectionHint: 'Hover over a node or select with from()',
    icon: CircleDot,
  },
  {
    id: 'edge_info',
    name: 'Edge Info',
    shortDescription: 'Curated summary of a single edge',
    selectionHint: 'Hover over an edge or select with from().to()',
    icon: Cable,
  },

  // Fallback
  {
    id: 'general_selection',
    name: 'Selection Statistics',
    shortDescription: 'General stats for selected nodes',
    selectionHint: 'Select any nodes',
    icon: Info,
  },
  
  // Snapshot-based analyses (requires DB)
  {
    id: 'lag_histogram',
    name: 'Lag Histogram',
    shortDescription: 'Conversion lag distribution from snapshots',
    selectionHint: 'Use from(a).to(b) with a window() or cohort() range',
    icon: Database,
    snapshotContract: {
      scopeRule: 'funnel_path',
      readMode: 'raw_snapshots',
      slicePolicy: 'mece_fulfilment_allowed',
      timeBoundsSource: 'query_dsl_window',
      perScenario: false,
    },
  },
  {
    id: 'daily_conversions',
    name: 'Daily Conversions',
    shortDescription: 'Conversion counts by calendar date',
    selectionHint: 'Use from(a).to(b) with a window() or cohort() range',
    icon: Calendar,
    snapshotContract: {
      scopeRule: 'funnel_path',
      readMode: 'raw_snapshots',
      slicePolicy: 'mece_fulfilment_allowed',
      timeBoundsSource: 'query_dsl_window',
      perScenario: false,
    },
  },
  {
    id: 'cohort_maturity',
    name: 'Cohort Maturity',
    shortDescription: 'How conversion rates evolved over time for a cohort range',
    selectionHint: 'Use from(a).to(b) with a window() or cohort() range',
    icon: TrendingUp,
    snapshotContract: {
      scopeRule: 'funnel_path',
      readMode: 'cohort_maturity',
      slicePolicy: 'mece_fulfilment_allowed',
      timeBoundsSource: 'query_dsl_window',
      perScenario: false,
    },
  },
  {
    id: 'lag_fit',
    name: 'Lag Fit',
    shortDescription: 'Fitted log-normal lag distribution vs. observed cohort completeness',
    selectionHint: 'Use from(a).to(b) with a window() or cohort() range',
    icon: TrendingUp,
    snapshotContract: {
      scopeRule: 'funnel_path',
      readMode: 'sweep_simple',
      slicePolicy: 'mece_fulfilment_allowed',
      timeBoundsSource: 'query_dsl_window',
      perScenario: false,
    },
  },
  // Bayes fit — not a user-visible analysis type. Used internally by
  // useBayesTrigger to build snapshot subjects for the compiler's
  // evidence assembly (Phase S). Scope: all graph parameters.
  {
    id: 'bayes_fit',
    name: 'Bayesian Fit',
    shortDescription: 'Internal: snapshot subjects for Bayes compiler',
    selectionHint: '',
    icon: FlaskConical,
    internal: true,
    snapshotContract: {
      scopeRule: 'all_graph_parameters',
      readMode: 'sweep_simple',
      slicePolicy: 'mece_fulfilment_allowed',
      timeBoundsSource: 'query_dsl_window',
      perScenario: false,
    },
  },
];

/**
 * Get metadata for an analysis type by ID
 */
export function getAnalysisTypeMeta(id: string): AnalysisTypeMeta | undefined {
  // Handle aliases (backend may use different IDs for same type)
  const normalizedId = id === 'graph_overview_empty' ? 'graph_overview' : id;
  return ANALYSIS_TYPES.find(t => t.id === normalizedId);
}

