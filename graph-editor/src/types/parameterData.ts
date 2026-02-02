/**
 * Parameter file domain types.
 *
 * NOTE: These types were historically (and incorrectly) defined inside
 * `services/paramRegistryService.ts`, which mixed optional external “registry”
 * loading with core domain modelling.
 *
 * Keeping these types in `src/types/` ensures production code never needs any
 * “param registry” service to compile.
 */

export interface ParameterValue {
  mean: number;
  stdev?: number;
  distribution?: 'normal' | 'beta' | 'gamma' | 'lognormal' | 'uniform';
  n?: number;
  k?: number;

  // Daily breakdown (optional)
  n_daily?: number[];
  k_daily?: number[];
  dates?: string[];

  // Slice identification (primary index key for data lookup)
  sliceDSL?: string;

  // Query signature (consistency checking)
  query_signature?: string;

  // Window mode dates (X-anchored event dates)
  window_from?: string;
  window_to?: string;

  // Cohort mode dates (A-anchored cohort entry dates) - for latency-tracked edges
  cohort_from?: string;
  cohort_to?: string;

  // Latency arrays (cohort mode)
  median_lag_days?: number[];
  mean_lag_days?: number[];
  anchor_n_daily?: number[];
  anchor_median_lag_days?: number[];
  anchor_mean_lag_days?: number[];

  // Aggregate latency summary (cohort mode)
  latency?: {
    median_lag_days?: number;
    mean_lag_days?: number;
    completeness?: number;
    t95?: number;
    onset_delta_days?: number;  // Onset delay before conversions begin (per-slice value from histogram)
    onset_delta_days_overridden?: boolean;  // True if user manually set onset_delta_days
  };

  // Evidence block
  evidence?: {
    mean?: number;
    stdev?: number;
    n?: number;
    k?: number;
    window_from?: string;
    window_to?: string;
    retrieved_at?: string;
    source?: string;
  };

  context_id?: string;
  data_source?: {
    type:
      | 'sheets'
      | 'api'
      | 'file'
      | 'manual'
      | 'calculated'
      | 'analytics'
      | 'amplitude'
      | 'statsig'
      | 'optimizely';
    retrieved_at?: string;
    edited_at?: string;
    query?: any;
    full_query?: string;
    debug_trace?: string;
    experiment_id?: string;
  };
}

export interface Parameter {
  id: string;
  name: string;
  type: 'probability' | 'cost_gbp' | 'labour_cost';
  values: ParameterValue[];
  query?: string;
  query_overridden?: boolean;
  n_query?: string;
  n_query_overridden?: boolean;
  /**
   * One-shot "force replace" marker for pull operations.
   * If the remote file has a newer value than the local dirty file, the client may choose
   * to overwrite local with remote (skip 3-way merge) for this file.
   */
  force_replace_at_ms?: number;
  metadata: {
    description: string;
    units?: string;
    constraints?: any;
    data_source?: any;
    analytics?: any;
    tags?: string[];
    created_at: string;
    updated_at?: string;
    author: string;
    version: string;
    status?: 'active' | 'deprecated' | 'draft' | 'archived';
    aliases?: string[];
    references?: any[];
  };
}


