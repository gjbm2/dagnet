/**
 * Bayes graph runtime helpers.
 *
 * `_bayes_evidence` / `_bayes_priors` are request-only payload fields for
 * Bayes submission snapshots. They must never persist onto the live editor
 * graph, IndexedDB, or committed graph files.
 *
 * `__parity*` latency fields are also runtime-only diagnostics.
 */

const EDGE_RUNTIME_FIELDS = ['_bayes_evidence', '_bayes_priors'] as const;
const LATENCY_RUNTIME_FIELDS = ['__parityEvidence', '__parityComputedT95Days'] as const;

function stripFieldsInPlace(target: any, fields: readonly string[]): boolean {
  if (!target || typeof target !== 'object') return false;

  let modified = false;
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(target, field)) {
      delete target[field];
      modified = true;
    }
  }
  return modified;
}

function stripLatencyRuntimeFieldsInPlace(latency: any): boolean {
  return stripFieldsInPlace(latency, LATENCY_RUNTIME_FIELDS);
}

export function stripBayesRuntimeFieldsFromGraphInPlace(graph: any): boolean {
  if (!graph || typeof graph !== 'object') return false;

  let modified = false;
  const edges = Array.isArray(graph.edges) ? graph.edges : [];

  for (const edge of edges) {
    if (!edge || typeof edge !== 'object') continue;

    modified = stripFieldsInPlace(edge, EDGE_RUNTIME_FIELDS) || modified;
    modified = stripLatencyRuntimeFieldsInPlace(edge.p?.latency) || modified;

    if (Array.isArray(edge.conditional_p)) {
      for (const conditional of edge.conditional_p) {
        modified = stripLatencyRuntimeFieldsInPlace(conditional?.p?.latency) || modified;
      }
    }
  }

  return modified;
}

export function cloneGraphWithoutBayesRuntimeFields<T>(graph: T): T {
  if (!graph || typeof graph !== 'object') return graph;
  const clone = structuredClone(graph);
  stripBayesRuntimeFieldsFromGraphInPlace(clone);
  return clone;
}
