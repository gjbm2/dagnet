// Types aligned with schema/conversion-graph-1.0.0.json

export type UUID = string;

export type Slug = string;

export type OutcomeType = 'success' | 'failure' | 'error' | 'neutral' | 'other';

export type OverflowPolicy = 'error' | 'normalize' | 'cap';

export type FreeEdgePolicy = 'complement' | 'uniform' | 'weighted';

export interface ProbabilityParam {
  mean?: number; // [0,1]
  stdev?: number; // >= 0
  locked?: boolean; // default false
}

export interface Costs {
  monetary?: number; // >= 0
  time?: number; // >= 0
  units?: string; // <= 32 chars
}

export interface ResidualBehavior {
  default_outcome?: string; // node slug or id
  overflow_policy?: OverflowPolicy; // default error
}

export interface NodeLayout {
  x?: number;
  y?: number;
  rank?: number; // >= 0
  group?: string; // <= 128 chars
  color?: string; // hex color
}

export interface NodeEntry {
  is_start?: boolean; // default false
  entry_weight?: number; // >= 0
}

export interface GraphNode {
  id: UUID;
  slug: Slug;
  label?: string;
  description?: string;
  tags?: string[];
  absorbing?: boolean; // default false
  outcome_type?: OutcomeType;
  entry?: NodeEntry;
  costs?: Costs;
  residual_behavior?: ResidualBehavior;
  layout?: NodeLayout;
}

export interface GraphEdge {
  id: UUID;
  slug?: Slug;
  from: string; // node id or slug
  to: string;   // node id or slug
  fromHandle?: string; // handle id (e.g., "right", "bottom", "left", "top")
  toHandle?: string;   // handle id (e.g., "left", "top", "right", "bottom")
  description?: string;
  p?: ProbabilityParam; // probability
  weight_default?: number; // >= 0
  costs?: Costs;
}

export interface Policies {
  default_outcome: string;
  overflow_policy?: OverflowPolicy; // default error
  free_edge_policy?: FreeEdgePolicy; // default complement
}

export interface Metadata {
  version: string; // semver
  created_at: string; // ISO datetime
  updated_at?: string; // ISO datetime
  author?: string;
  description?: string;
  tags?: string[];
}

export interface ConversionGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  policies: Policies;
  metadata: Metadata;
}

export type Graph = ConversionGraph;
