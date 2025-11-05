// Types aligned with schema/conversion-graph-1.0.0.json

export type UUID = string;

export type HumanId = string; // Human-readable identifier (formerly "Id")

export type OutcomeType = 'success' | 'failure' | 'error' | 'neutral' | 'other';

export type NodeType = 'normal' | 'case';

export type CaseStatus = 'active' | 'paused' | 'completed';

export type OverflowPolicy = 'error' | 'normalize' | 'cap';

export type FreeEdgePolicy = 'complement' | 'uniform' | 'weighted';

export interface ProbabilityParam {
  mean?: number; // [0,1]
  stdev?: number; // >= 0
  locked?: boolean; // default false
  parameter_id?: string; // Reference to parameter registry
}

// Condition for conditional probability
export interface Condition {
  visited: string[]; // Array of node IDs that must be visited
  // Future v2 enhancements:
  // all_of?: string[];
  // any_of?: string[];
  // none_of?: string[];
}

// Conditional probability: probability that applies when condition is met
export interface ConditionalProbability {
  condition: Condition;
  p: ProbabilityParam; // Probability when condition is satisfied
}

export interface MonetaryCost {
  value: number; // >= 0
  stdev?: number; // >= 0
  distribution?: string; // e.g., "normal", "lognormal", "gamma", "uniform"
  currency?: string; // e.g., "USD", "GBP", "EUR"
}

export interface TimeCost {
  value: number; // >= 0
  stdev?: number; // >= 0
  distribution?: string; // e.g., "normal", "lognormal", "gamma", "uniform"
  units?: string; // e.g., "days", "hours", "weeks"
}

export interface Costs {
  monetary?: MonetaryCost | number; // Support both old (number) and new (object) formats
  time?: TimeCost | number; // Support both old (number) and new (object) formats
  units?: string; // Deprecated: for backward compatibility with old format
}

export interface ResidualBehavior {
  default_outcome?: string; // node id or id
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

export interface CaseVariant {
  name: string;
  weight: number; // [0,1], must sum to 1.0 for all variants in case
  description?: string;
}

export interface CaseData {
  id: string; // Unique case identifier (graph-local)
  parameter_id?: string; // Reference to parameter in registry
  status: CaseStatus;
  variants: CaseVariant[];
}

export interface GraphNode {
  uuid: UUID;       // System-generated UUID (formerly "id")
  id: HumanId;      // Human-readable identifier (formerly "id")
  label?: string;
  description?: string;
  tags?: string[];
  type?: NodeType; // default 'normal'
  absorbing?: boolean; // default false
  outcome_type?: OutcomeType;
  entry?: NodeEntry;
  costs?: Costs;
  residual_behavior?: ResidualBehavior;
  layout?: NodeLayout;
  case?: CaseData; // Only present when type === 'case'
}

export interface EdgeDisplay {
  conditional_color?: string; // Hex color for conditional edges (user override)
  conditional_group?: string; // Optional user-defined group for color assignment
}

export interface GraphEdge {
  uuid: UUID;           // System-generated UUID (formerly "id")
  id?: HumanId;         // Human-readable identifier (formerly "id")
  from: string;         // node uuid
  to: string;           // node uuid
  fromHandle?: string;  // handle id (e.g., "right", "bottom", "left", "top")
  toHandle?: string;    // handle id (e.g., "left", "top", "right", "bottom")
  description?: string;
  p?: ProbabilityParam; // Base probability (fallback when no conditions match)
  conditional_p?: ConditionalProbability[]; // Optional array of conditional probabilities
  weight_default?: number; // >= 0 (used for residual behavior)
  costs?: Costs;
  case_variant?: string; // Name of the variant this edge represents
  case_id?: string; // Reference to parent case node
  display?: EdgeDisplay; // Display parameters (colors, grouping)
  // For case edges: probability comes from case node's variant weight, not from p.mean
  // For conditional edges: first matching condition in conditional_p wins, fallback to p
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

// What-If Analysis State (UI-level only, not persisted)
export interface WhatIfState {
  // Case node overrides: nodeId -> selected variant name
  caseOverrides: Map<string, string>;
  
  // Conditional edge overrides: edgeId -> set of visited node IDs
  conditionalOverrides: Map<string, Set<string>>;
}

// Validation error types
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
