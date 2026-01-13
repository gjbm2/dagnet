/**
 * Dependency Closure
 * 
 * Production TypeScript implementation of graph dependency detection.
 * Mirrors the logic in scripts/export-graph-bundle.js but for browser use.
 * 
 * Given a graph JSON, this module identifies all referenced supporting files:
 * - Parameter IDs (edge.p.id, edge.cost_gbp.id, edge.labour_cost.id, conditional_p[*].p.id)
 * - Event IDs (node.event_id or node.event.id)
 * - Case IDs (node.type === 'case' && node.case.id)
 * - Context keys (from graph DSL fields)
 * - Node IDs (for nodes with external file definitions)
 */

export interface DependencyClosure {
  /** Parameter file IDs referenced by edges */
  parameterIds: Set<string>;
  /** Event file IDs referenced by nodes */
  eventIds: Set<string>;
  /** Case file IDs referenced by case nodes */
  caseIds: Set<string>;
  /** Context keys referenced in DSL fields */
  contextKeys: Set<string>;
  /** Node IDs (for nodes that may have external file definitions) */
  nodeIds: Set<string>;
}

/**
 * Extract context keys from a DSL string.
 * 
 * Recognises:
 * - context(key) or context(key:value)
 * - contextAny(key:value,key:value,...)
 */
export function extractContextKeysFromDSL(dsl: string | undefined | null): Set<string> {
  if (!dsl || typeof dsl !== 'string') return new Set();
  const keys = new Set<string>();

  // context(key) or context(key:value)
  for (const m of dsl.matchAll(/context\(\s*([^:)]+)\s*(?::[^)]*)?\)/g)) {
    if (m[1]) keys.add(m[1].trim());
  }

  // contextAny(key:value,key:value,...)
  for (const m of dsl.matchAll(/contextAny\(\s*([^)]+)\)/g)) {
    const inner = m[1] ?? '';
    const parts = inner.split(',').map((s) => s.trim()).filter(Boolean);
    for (const p of parts) {
      const colon = p.indexOf(':');
      if (colon > 0) {
        keys.add(p.slice(0, colon).trim());
      }
    }
  }

  return keys;
}

/**
 * Collect all dependencies from a graph JSON.
 * 
 * @param graphJson - The graph data (must have nodes and edges arrays)
 * @returns DependencyClosure containing all referenced IDs
 */
export function collectGraphDependencies(graphJson: any): DependencyClosure {
  const parameterIds = new Set<string>();
  const eventIds = new Set<string>();
  const caseIds = new Set<string>();
  const contextKeys = new Set<string>();
  const nodeIds = new Set<string>();

  // Context keys from persisted DSL fields (if present)
  for (const k of extractContextKeysFromDSL(graphJson?.dataInterestsDSL)) contextKeys.add(k);
  for (const k of extractContextKeysFromDSL(graphJson?.currentQueryDSL)) contextKeys.add(k);
  for (const k of extractContextKeysFromDSL(graphJson?.baseDSL)) contextKeys.add(k);

  // Process nodes
  const nodes = Array.isArray(graphJson?.nodes) ? graphJson.nodes : [];
  for (const n of nodes) {
    // Prefer stable human IDs when present; fall back to uuid when not.
    if (typeof n?.id === 'string' && n.id.trim()) nodeIds.add(n.id.trim());
    else if (typeof n?.uuid === 'string' && n.uuid.trim()) nodeIds.add(n.uuid.trim());

    // Event reference
    const eid = n?.event_id || n?.event?.id;
    if (typeof eid === 'string' && eid.trim()) eventIds.add(eid.trim());
    
    // Case reference
    if (n?.type === 'case') {
      const cid = n?.case?.id;
      if (typeof cid === 'string' && cid.trim()) caseIds.add(cid.trim());
    }
  }

  // Process edges
  const edges = Array.isArray(graphJson?.edges) ? graphJson.edges : [];
  for (const e of edges) {
    // Base probability parameter
    const pId = e?.p?.id;
    if (typeof pId === 'string' && pId.trim()) parameterIds.add(pId.trim());

    // Cost parameter
    const costId = e?.cost_gbp?.id;
    if (typeof costId === 'string' && costId.trim()) parameterIds.add(costId.trim());

    // Labour cost parameter
    const labourId = e?.labour_cost?.id;
    if (typeof labourId === 'string' && labourId.trim()) parameterIds.add(labourId.trim());

    // Conditional probability parameters
    const cond = Array.isArray(e?.conditional_p) ? e.conditional_p : [];
    for (const c of cond) {
      const cpId = c?.p?.id;
      if (typeof cpId === 'string' && cpId.trim()) parameterIds.add(cpId.trim());
    }
  }

  return { parameterIds, eventIds, caseIds, contextKeys, nodeIds };
}

/**
 * Merge two dependency closures into one.
 * Useful when processing multiple graphs.
 */
export function mergeDependencies(acc: DependencyClosure, next: DependencyClosure): DependencyClosure {
  for (const v of next.parameterIds) acc.parameterIds.add(v);
  for (const v of next.eventIds) acc.eventIds.add(v);
  for (const v of next.caseIds) acc.caseIds.add(v);
  for (const v of next.contextKeys) acc.contextKeys.add(v);
  for (const v of next.nodeIds) acc.nodeIds.add(v);
  return acc;
}

/**
 * Create an empty dependency closure.
 */
export function createEmptyDependencyClosure(): DependencyClosure {
  return {
    parameterIds: new Set(),
    eventIds: new Set(),
    caseIds: new Set(),
    contextKeys: new Set(),
    nodeIds: new Set(),
  };
}

/**
 * Get the minimal set of parameter IDs needed for a graph.
 * This is the primary use case for live share boot.
 */
export function getMinimalParameterIds(graphJson: any): string[] {
  const deps = collectGraphDependencies(graphJson);
  return Array.from(deps.parameterIds);
}
