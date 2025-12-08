/**
 * Scenarios Manager Types
 * 
 * Types for the Scenarios feature that enables users to create, compare,
 * and compose parameter overlays (scenarios) on top of a working graph state.
 */

/**
 * Probability parameter (used in edge params)
 */
export interface ProbabilityParam {
  mean?: number;
  stdev?: number;
  distribution?: 'beta' | 'normal' | 'lognormal' | 'gamma' | 'uniform';
  min?: number;
  max?: number;
  alpha?: number;
  beta?: number;
}

/**
 * Cost parameter (monetary or time)
 */
export interface CostParam {
  mean?: number; // Primary value field (matches schema and graph CostParam)
  stdev?: number;
  distribution?: 'normal' | 'lognormal' | 'gamma' | 'uniform';
  currency?: string; // For monetary costs
  units?: string;    // For time costs
  min?: number;
  max?: number;
}

/**
 * Edge parameter diff (subset of edge params that can be overridden)
 */
export interface EdgeParamDiff {
  p?: ProbabilityParam;
  conditional_p?: Record<string, ProbabilityParam | null>;
  weight_default?: number;
  cost_gbp?: CostParam;
  labour_cost?: CostParam;
}

/**
 * Node parameter diff (subset of node params that can be overridden)
 */
export interface NodeParamDiff {
  entry?: { entry_weight?: number };
  costs?: { 
    monetary?: any; 
    time?: any;
  };
  case?: {
    variants?: Array<{ name: string; weight: number }>;
  };
}

/**
 * Scenario parameters (sparse representation)
 * Keys can be UUIDs or Human-Readable Names (HRNs)
 */
export type ScenarioParams = {
  edges?: Record<string, EdgeParamDiff>;
  nodes?: Record<string, NodeParamDiff>;
};

/**
 * Metadata about a scenario's origin and purpose
 */
export interface ScenarioMeta {
  /** Time window this scenario was captured from */
  window?: { start: string; end: string };
  
  /** Context values active when this scenario was created */
  context?: Record<string, string>;
  
  /** What-If DSL string if scenario was created with What-If active */
  whatIfDSL?: string;
  
  /** Human-readable summary of What-If conditions */
  whatIfSummary?: string;
  
  /** How this scenario was created ('all' or 'differences') */
  source?: 'all' | 'differences';
  
  /** Additional details about source (e.g., "from visible", "from Base") */
  sourceDetail?: string;
  
  /** User who created this scenario */
  createdBy?: string;
  
  /** Tab ID where this scenario was created */
  createdInTabId?: string;
  
  /** User-editable note */
  note?: string;
  
  // === LIVE SCENARIO FIELDS ===
  
  /**
   * Query DSL fragment for live scenarios.
   * When set, this scenario can be regenerated from source.
   * Composed with inherited DSL: effective = smartMerge(inheritedDSL, queryDSL)
   * 
   * Can contain both fetch elements (window, context) and what-if elements (case, visited).
   * 
   * @example "context(channel:google)"
   * @example "window(-7d:).case(my-case:treatment)"
   */
  queryDSL?: string;
  
  /**
   * Whether this is a live (regenerable) scenario.
   * Derived: true if queryDSL is set and non-empty.
   */
  isLive?: boolean;
  
  /**
   * Timestamp of last data regeneration (for live scenarios).
   * Updated each time regenerateScenario is called.
   */
  lastRegeneratedAt?: string;
  
  /**
   * The effective DSL used for last regeneration.
   * This may differ from queryDSL if base or lower layers changed.
   * Stored for debugging and display purposes.
   * 
   * @example If queryDSL="context(channel:google)" and baseDSL="window(-30d:)",
   *          lastEffectiveDSL might be "window(-30d:).context(channel:google)"
   */
  lastEffectiveDSL?: string;
}

/**
 * A scenario is a named parameter overlay
 */
export interface Scenario {
  /** Unique identifier */
  id: string;
  
  /** Display name (user-editable) */
  name: string;
  
  /** Colour for rendering (auto-assigned or user-overridden) */
  colour: string;
  
  /** Timestamp of creation */
  createdAt: string;
  
  /** Timestamp of last update */
  updatedAt?: string;
  
  /** Version number (incremented on each edit) */
  version: number;
  
  /** Parameter overrides */
  params: ScenarioParams;
  
  /** Metadata about origin and purpose */
  meta?: ScenarioMeta;
}

/**
 * Per-tab scenario visibility and selection state
 */
export interface TabScenarioState {
  /** ALL scenario IDs in layer/compositing order (per tab), regardless of visibility */
  scenarioOrder?: string[];
  
  /** IDs of visible scenarios (subset of scenarioOrder that are currently shown) */
  visibleScenarioIds: string[];
  
  /** IDs of scenarios in activation order (for colour assignment) */
  visibleColourOrderIds: string[];
  
  /** Currently selected scenario (for highlighting in UI) */
  selectedScenarioId?: string;
}

/**
 * Options for creating a snapshot
 */
export interface CreateSnapshotOptions {
  /** Name for the new scenario */
  name: string;
  
  /** Type of snapshot ('all' includes all params, 'differences' only deltas) */
  type: 'all' | 'differences';
  
  /** What to diff against ('visible' = composed overlays, 'base' = Base only) */
  source?: 'visible' | 'base';
  
  /** Threshold for difference detection (default 1e-6) */
  diffThreshold?: number;
  
  /** Optional note to attach */
  note?: string;
}

/**
 * Options for applying scenario content
 */
export interface ApplyContentOptions {
  /** Content format */
  format: 'yaml' | 'json';
  
  /** Structure format */
  structure?: 'nested' | 'flat';
  
  /** Whether to validate before applying */
  validate?: boolean;
}

/**
 * Validation result for scenario content
 */
export interface ScenarioValidationResult {
  /** Whether validation passed */
  valid: boolean;
  
  /** Error messages (block Apply) */
  errors: Array<{
    path: string;
    message: string;
  }>;
  
  /** Warning messages (don't block Apply) */
  warnings: Array<{
    path: string;
    message: string;
  }>;
  
  /** Unresolved HRNs (informational) */
  unresolvedHRNs: string[];
}

/**
 * Format for scenario content display
 */
export interface ScenarioContentFormat {
  syntax: 'yaml' | 'json';
  structure: 'nested' | 'flat';
}


