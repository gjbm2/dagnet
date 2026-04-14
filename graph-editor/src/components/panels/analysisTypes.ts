/**
 * Analysis Type Metadata
 *
 * Static metadata for all analysis types including icons, descriptions,
 * and selection hints. This is merged with the backend's availability info.
 */

import React from 'react';
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
  Gauge,
  type LucideIcon,
} from 'lucide-react';
import { MinimisedSurpriseGauge } from '../charts/MinimisedSurpriseGauge';
import { MinimisedBridgeView } from '../charts/MinimisedBridgeView';

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

export type ReadMode = 'raw_snapshots' | 'virtual_snapshot' | 'cohort_maturity' | 'sweep_simple' | 'none';

export type SlicePolicy = 'explicit' | 'mece_fulfilment_allowed' | 'any';

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

/** A kind within a view type, with a human-readable label. */
export interface KindMeta {
  id: string;
  name: string;
}

/** Declares what view types an analysis type supports and which kinds are valid for each. */
export interface ViewSpec {
  chart?: KindMeta[];
  cards?: KindMeta[];
  table?: KindMeta[];
}

/**
 * Custom minimised renderer for an analysis type.
 * Returns a React node to show instead of the generic icon when minimised,
 * or null to fall back to the generic icon (e.g. when data is unavailable).
 */
export type MinimisedRenderer = (props: {
  result: any;
  settings: Record<string, any>;
  label?: string;
}) => React.ReactNode | null;

export interface AnalysisTypeMeta {
  id: string;
  name: string;
  shortDescription: string;
  selectionHint: string;
  icon: LucideIcon;
  /** Valid view_type → kind[] combinations. When absent, inferred from result semantics at runtime. */
  views?: ViewSpec;
  /** If present, this analysis type requires snapshot DB data */
  snapshotContract?: SnapshotContract;
  /** If true, this type is used by backend pipelines only (e.g. Bayes compiler)
   *  and should never appear in user-facing selectors or chart/satellite UI. */
  internal?: boolean;
  /** If true, only visible in local dev (import.meta.env.DEV). Used for
   *  legacy analysis types kept for parity testing but hidden in prod. */
  devOnly?: boolean;
  /**
   * Optional custom renderer for minimised state on the canvas.
   * When provided (and returns non-null), replaces the generic 32×32 icon
   * with a richer indicator (e.g. coloured dot + arrow + label).
   */
  renderMinimised?: MinimisedRenderer;
  /**
   * Optional label override for the minimised hover title.
   * Receives the same props as renderMinimised; returns a string or null to use the default.
   */
  minimisedLabel?: (props: { result: any; settings: Record<string, any>; label?: string }) => string | null;
  /**
   * Dimensions for the custom minimised state. Defaults to { width: 32, height: 32 }.
   * Only used when renderMinimised is provided and returns non-null.
   */
  minimisedSize?: { width: number; height: number };
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
    renderMinimised: (props) => React.createElement(MinimisedBridgeView, props),
    minimisedSize: { width: 144, height: 48 },
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
    views: {
      cards: [
        { id: 'overview', name: 'Overview' },
        { id: 'structure', name: 'Structure' },
      ],
    },
  },
  {
    id: 'edge_info',
    name: 'Edge Info',
    shortDescription: 'Curated summary of a single edge',
    selectionHint: 'Hover over an edge or select with from().to()',
    icon: Cable,
    views: {
      cards: [
        { id: 'overview', name: 'Overview' },
        { id: 'latency', name: 'Latency' },
        { id: 'evidence', name: 'Evidence' },
        { id: 'forecast', name: 'Model' },
        { id: 'depth', name: 'Data Depth' },
        { id: 'diagnostics', name: 'Diagnostics' },
      ],
    },
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
    id: 'cohort_maturity_v1',
    name: 'Cohort Maturity v1',
    shortDescription: 'Legacy cohort maturity (dev only)',
    selectionHint: 'Use from(a).to(b) with a window() or cohort() range',
    icon: TrendingUp,
    devOnly: true,
    snapshotContract: {
      scopeRule: 'funnel_path',
      readMode: 'cohort_maturity',
      slicePolicy: 'mece_fulfilment_allowed',
      timeBoundsSource: 'query_dsl_window',
      perScenario: false,
    },
  },
  {
    id: 'cohort_maturity_v2',
    name: 'Cohort Maturity v2',
    shortDescription: 'Multi-hop cohort maturity with span kernel (dev only)',
    selectionHint: 'Use from(a).to(b) with a window() or cohort() range',
    icon: TrendingUp,
    devOnly: true,
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
  {
    id: 'surprise_gauge',
    name: 'Expectation Gauge',
    shortDescription: 'How surprising is current evidence given the Bayesian posterior',
    selectionHint: 'Use from(a).to(b) to select an edge',
    icon: Gauge,
    snapshotContract: {
      scopeRule: 'funnel_path',
      readMode: 'sweep_simple',
      slicePolicy: 'mece_fulfilment_allowed',
      timeBoundsSource: 'query_dsl_window',
      perScenario: false,
    },
    renderMinimised: (props) => React.createElement(MinimisedSurpriseGauge, props),
    minimisedLabel: ({ result, settings, label }) => {
      const selectedVar = settings?.surprise_var || 'p';
      if (selectedVar === 'all' || !result?.variables) return null;
      const v = result.variables.find((x: any) => x.available && x.name === selectedVar);
      if (!v) return null;
      const subject = label ? ` — ${label}` : '';
      return `${v.label} (${v.name})${subject}`;
    },
    minimisedSize: { width: 32, height: 32 },
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

/**
 * Get the valid kinds for an analysis type × view type combination.
 * Returns KindMeta[] from the registry, or empty array if not declared
 * (caller should fall back to result semantics for chart kinds).
 */
export function getKindsForView(analysisTypeId: string, viewType: 'chart' | 'cards' | 'table'): KindMeta[] {
  const meta = getAnalysisTypeMeta(analysisTypeId);
  return meta?.views?.[viewType] || [];
}

/**
 * Get available view types for an analysis type from the registry.
 * Returns the declared view type keys (e.g. ['cards', 'chart']).
 * If the analysis type has no views declaration, returns null (caller
 * should fall back to result-driven detection via getAvailableExpressions).
 */
export function getAvailableViewTypes(analysisTypeId: string | undefined): ('chart' | 'cards' | 'table')[] | null {
  if (!analysisTypeId) return null;
  const meta = getAnalysisTypeMeta(analysisTypeId);
  if (!meta?.views) return null;
  return (Object.keys(meta.views) as ('chart' | 'cards' | 'table')[]).filter(k => {
    const kinds = meta.views![k];
    return kinds && kinds.length > 0;
  });
}

