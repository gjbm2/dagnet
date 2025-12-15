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
      connection: fileParamData.connection,
      connection_string: fileParamData.connection_string,
      latency: fileParamData.latency,
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


