/**
 * Persisted Case Config Service
 *
 * Centralises the "source of truth by retrieval mode" rule for cases:
 * - Versioned case operations (source → file schedule append) should prefer the persisted case file config.
 * - Direct case operations (source → graph) should prefer the graph node's inline case config.
 *
 * IMPORTANT:
 * - Override flags are not "special at read time" here. They only affect whether persisted values
 *   are overwritten elsewhere.
 * - This service is about choosing WHICH persisted record we consult (file vs graph).
 */

export type PersistedCaseConfigSource = 'file' | 'graph';

export interface PersistedCaseConfig {
  source: PersistedCaseConfigSource;
  caseId?: string;
  connection?: string;
  connection_string?: string;
}

export function selectPersistedCaseConfig(options: {
  versionedCase: boolean;
  fileCaseData?: any;
  graphNode?: any;
}): PersistedCaseConfig {
  const { versionedCase, fileCaseData, graphNode } = options;

  const graphCase = graphNode?.case;

  if (versionedCase && fileCaseData) {
    return {
      source: 'file',
      caseId: fileCaseData.id ?? graphCase?.id,
      connection: fileCaseData.connection,
      connection_string: fileCaseData.connection_string,
    };
  }

  return {
    source: 'graph',
    caseId: graphCase?.id,
    connection: graphCase?.connection,
    connection_string: graphCase?.connection_string,
  };
}




