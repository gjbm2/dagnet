/**
 * Persisted Parameter Config Service
 *
 * Centralises the "source of truth by retrieval mode" rule:
 * - Versioned operations (source → file → graph) should prefer persisted parameter file config.
 * - Direct operations (source → graph) should prefer graph config.
 *
 * IMPORTANT:
 * - Override flags are not "special at read time" here. They only affect whether persisted values
 *   are overwritten elsewhere (e.g. UpdateManager write-back).
 * - This service is about choosing WHICH persisted record we consult (file vs graph).
 *
 * CONNECTION RESOLUTION:
 * - `connection` (the connection name) is always resolved from the graph edge, NOT from the
 *   parameter file. Connection is a graph-level concern — the same parameter file may be shared
 *   across graphs pointing at different environments (e.g. amplitude-prod vs amplitude-staging).
 *   The parameter file may still carry `connection` as provenance, but it is not used as config input.
 *   Callers should further fall back to `graph.defaultConnection` if connection is still undefined.
 * - `connection_string` (the per-parameter JSON blob) continues to come from the file for versioned
 *   operations, since it is genuinely per-parameter configuration.
 */

import type { LatencyConfig } from '../types';

export type PersistedConfigSource = 'file' | 'graph';

export interface PersistedProbabilityConfig {
  source: PersistedConfigSource;
  /** Parameter-level query (file) or edge-level query (graph) depending on mode and availability */
  query?: string;
  query_overridden?: boolean;
  n_query?: string;
  n_query_overridden?: boolean;
  connection?: string;
  connection_string?: string;
  latency?: LatencyConfig;
}

/**
 * Override-gated latency fields: each entry is [valueField, overriddenFlag].
 *
 * `_overridden` on the FILE is an inbound lock ("don't write to me").
 * When the file is NOT locked for a field, the graph's value cascades through.
 * When the file IS locked, the file's value is preserved.
 */
const OVERRIDE_GATED_LATENCY_PAIRS: ReadonlyArray<[keyof LatencyConfig, keyof LatencyConfig]> = [
  ['latency_parameter', 'latency_parameter_overridden'],
  ['t95', 't95_overridden'],
  ['path_t95', 'path_t95_overridden'],
  ['onset_delta_days', 'onset_delta_days_overridden'],
];

/**
 * Inherently graph-mastered latency fields — always from graph regardless of
 * file override state. See mappingConfigurations.ts:653.
 */
const GRAPH_MASTERED_LATENCY_KEYS: ReadonlyArray<keyof LatencyConfig> = [
  'anchor_node_id',
  'anchor_node_id_overridden',
];

/**
 * Lazy cascade: merge file and graph latency configs for versioned mode.
 *
 * The file is the base (it holds persisted derived values: mu, sigma, t95, etc.).
 * The graph cascades override-gated fields when the file isn't locked, and
 * always provides inherently graph-mastered fields (anchor_node_id).
 *
 * File-mastered fields (mu, sigma, path_mu, path_sigma, model_trained_at,
 * completeness, median_lag_days, mean_lag_days, posterior) always come from
 * the file — they have no override mechanism.
 */
export function mergeLatencyConfig(
  fileLatency: Partial<LatencyConfig> | undefined,
  graphLatency: Partial<LatencyConfig> | undefined,
): LatencyConfig | undefined {
  if (!fileLatency && !graphLatency) return undefined;
  if (!fileLatency) return graphLatency as LatencyConfig;
  if (!graphLatency) return fileLatency as LatencyConfig;

  // Start with file as base (file-mastered fields stay untouched)
  const merged: Record<string, any> = { ...fileLatency };

  // Override-gated fields: cascade graph value when file is NOT locked
  for (const [field, overriddenFlag] of OVERRIDE_GATED_LATENCY_PAIRS) {
    if ((fileLatency as any)[overriddenFlag] === true) {
      // File is locked for this field — keep file's value
      continue;
    }
    // File is not locked — cascade graph's value (and its _overridden flag)
    if ((graphLatency as any)[field] !== undefined) {
      merged[field] = (graphLatency as any)[field];
    }
    if ((graphLatency as any)[overriddenFlag] !== undefined) {
      merged[overriddenFlag] = (graphLatency as any)[overriddenFlag];
    }
  }

  // Inherently graph-mastered fields: always from graph
  for (const key of GRAPH_MASTERED_LATENCY_KEYS) {
    if ((graphLatency as any)[key] !== undefined) {
      merged[key] = (graphLatency as any)[key];
    }
  }

  return merged as LatencyConfig;
}

/**
 * Select the persisted probability config for a parameter-backed edge slot.
 *
 * @param writeToFile - true when running versioned parameter retrieval (source→file→graph)
 * @param fileParamData - parameter file data (`parameter-*.yaml`), if loaded
 * @param graphParam - graph edge slot object (`edge.p` or `conditional_p[i].p`)
 */
export function selectPersistedProbabilityConfig(options: {
  writeToFile: boolean;
  fileParamData?: any;
  graphParam?: any;
  graphEdge?: any;
}): PersistedProbabilityConfig {
  const { writeToFile, fileParamData, graphParam, graphEdge } = options;

  if (writeToFile && fileParamData) {
    return {
      source: 'file',
      query: fileParamData.query,
      query_overridden: fileParamData.query_overridden,
      n_query: fileParamData.n_query,
      n_query_overridden: fileParamData.n_query_overridden,
      // Connection name resolved from graph edge, NOT file — connection is a graph-level concern.
      // Callers should fall back to graph.defaultConnection if this is undefined.
      connection: graphParam?.connection,
      connection_string: fileParamData.connection_string,
      latency: mergeLatencyConfig(fileParamData.latency, graphParam?.latency),
    };
  }

  return {
    source: 'graph',
    query: graphEdge?.query,
    query_overridden: graphEdge?.query_overridden,
    n_query: graphEdge?.n_query,
    n_query_overridden: graphEdge?.n_query_overridden,
    connection: graphParam?.connection,
    connection_string: graphParam?.connection_string,
    latency: graphParam?.latency,
  };
}


