/**
 * Scenarios Manager Types
 * 
 * Types for the Scenarios feature that enables users to create, compare,
 * and compose parameter overlays (scenarios) on top of a working graph state.
 */

/**
 * Probability parameter for scenario param packs.
 * 
 * NOTE (design §9.K.1): Param packs contain only the fields needed for scenario
 * composition, NOT the full distribution parameters (alpha, beta, min, max)
 * which are only used at inference time.
 */
export interface ProbabilityParam {
  mean?: number;
  stdev?: number;

  // === POSTERIOR: probability posterior (Bayesian enrichment) ===
  /** Probability posterior (alpha/beta/HDI/quality) projected by applyPatch. */
  posterior?: {
    distribution?: string;
    alpha?: number;
    beta?: number;
    hdi_lower?: number;
    hdi_upper?: number;
    hdi_level?: number;
    ess?: number;
    rhat?: number;
    fitted_at?: string;
    fingerprint?: string;
    provenance?: string;
    cohort_alpha?: number;
    cohort_beta?: number;
    cohort_hdi_lower?: number;
    cohort_hdi_upper?: number;
  };

  // === LAG fields for edge rendering (evidence vs forecast two-layer) ===
  /** Forecast from mature cohorts (p_∞) — DSL: e.X.p.forecast.mean */
  forecast?: {
    mean?: number;
    stdev?: number;
    /** Expected converters on this edge = p.mean * p.n. DSL: e.X.p.forecast.k */
    k?: number;
  };
  /** Evidence (observed rate including immature cohorts) — DSL: e.X.p.evidence.mean */
  evidence?: {
    mean?: number;
    stdev?: number;
    /** Observed trials for evidence rate (binomial n). */
    n?: number;
    /** Observed converters for evidence rate (binomial k). */
    k?: number;
  };

  // === Latency: LAG display + Bayesian promoted scalars + posterior ===
  /** Latency fields — promoted scalars and posterior (after applyPatch). */
  latency?: {
    // LAG display
    median_lag_days?: number;
    completeness?: number;
    completeness_stdev?: number;
    t95?: number;
    path_t95?: number;
    // Bayesian promoted scalars
    mu?: number;
    sigma?: number;
    onset_delta_days?: number;
    promoted_t95?: number;
    promoted_onset_delta_days?: number;
    promoted_mu_sd?: number;
    promoted_sigma_sd?: number;
    promoted_onset_sd?: number;
    promoted_onset_mu_corr?: number;
    path_mu?: number;
    path_sigma?: number;
    path_onset_delta_days?: number;
    promoted_path_t95?: number;
    promoted_path_mu_sd?: number;
    promoted_path_sigma_sd?: number;
    promoted_path_onset_sd?: number;
    // Latency posterior (lognormal)
    posterior?: {
      distribution?: string;
      mu_mean?: number;
      mu_sd?: number;
      sigma_mean?: number;
      sigma_sd?: number;
      onset_mean?: number;
      onset_sd?: number;
      onset_delta_days?: number;
      onset_mu_corr?: number;
      hdi_t95_lower?: number;
      hdi_t95_upper?: number;
      hdi_level?: number;
      ess?: number;
      rhat?: number;
      fitted_at?: string;
      fingerprint?: string;
      provenance?: string;
      path_mu_mean?: number;
      path_mu_sd?: number;
      path_sigma_mean?: number;
      path_sigma_sd?: number;
      path_onset_mean?: number;
      path_onset_sd?: number;
      path_onset_delta_days?: number;
      path_hdi_t95_lower?: number;
      path_hdi_t95_upper?: number;
      path_provenance?: string;
    };
  };

  // === Inbound-n: Forecast population (see inbound-n-fix.md) ===
  /** Forecast population for this edge under the current DSL — DSL: e.X.p.n */
  n?: number;
}

/**
 * Cost parameter for scenario param packs.
 * 
 * NOTE: Distribution fields removed per design §9.K.1 - only mean/stdev needed
 * for scenario composition.
 */
export interface CostParam {
  mean?: number; // Primary value field (matches schema and graph CostParam)
  stdev?: number;
  currency?: string; // For monetary costs
  units?: string;    // For time costs
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

  // === PROVENANCE / STALENESS (dynamic-update.md Tier 1) ===

  /**
   * Scenario dependency stamp (v1).
   * Captures observed inputs + revisions for staleness detection and parity debugging.
   */
  deps_v1?: import('../lib/scenarioDeps').ScenarioDepsStampV1;

  /**
   * Stable signature derived from deps_v1.
   */
  deps_signature_v1?: string;
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
 * Options for capturing a static scenario from the current parameter state
 */
export interface CaptureScenarioOptions {
  /** Name for the new scenario */
  name: string;
  
  /** Type of capture ('all' includes all params, 'differences' only deltas) */
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


