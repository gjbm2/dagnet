/**
 * GraphParamExtractor
 * 
 * Extracts ScenarioParams from a Graph.
 * Converts graph edge/node data into the scenario parameter format.
 */

import { Graph, GraphEdge, GraphNode } from '../types';
import { ScenarioParams, EdgeParamDiff, NodeParamDiff } from '../types/scenarios';

function topoSortNodesForGraph(graph: Graph): string[] | undefined {
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  if (nodes.length === 0 || edges.length === 0) return undefined;

  const uuidById = new Map<string, string>();
  const nodeUuids = new Set<string>();
  for (const n of nodes) {
    if (n.uuid) nodeUuids.add(n.uuid);
    if ((n as any).id && n.uuid) uuidById.set((n as any).id, n.uuid);
  }

  const resolveNode = (ref: any): string => {
    if (typeof ref !== 'string') return String(ref ?? '');
    if (nodeUuids.has(ref)) return ref;
    const mapped = uuidById.get(ref);
    return mapped ?? ref;
  };

  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.uuid) indegree.set(n.uuid, 0);
  }

  for (const e of edges) {
    const from = resolveNode((e as any).from);
    const to = resolveNode((e as any).to);
    if (!from || !to) continue;
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from)!.push(to);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
    if (!indegree.has(from)) indegree.set(from, indegree.get(from) ?? 0);
  }

  const queue: string[] = [];
  for (const [id, deg] of indegree.entries()) {
    if (deg === 0) queue.push(id);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const n = queue.shift()!;
    order.push(n);
    for (const to of adj.get(n) ?? []) {
      const nextDeg = (indegree.get(to) ?? 1) - 1;
      indegree.set(to, nextDeg);
      if (nextDeg === 0) queue.push(to);
    }
  }

  // Cycle / unresolved nodes: bail to preserve existing order
  if (order.length === 0) return undefined;
  return order;
}

function sortEdgesTopologically(graph: Graph): GraphEdge[] {
  const edges = graph.edges ?? [];
  const nodeOrder = topoSortNodesForGraph(graph);
  if (!nodeOrder) return edges;

  const rank = new Map<string, number>();
  for (let i = 0; i < nodeOrder.length; i++) rank.set(nodeOrder[i], i);

  const uuidById = new Map<string, string>();
  const nodes = graph.nodes ?? [];
  const nodeUuids = new Set<string>();
  for (const n of nodes) {
    if (n.uuid) nodeUuids.add(n.uuid);
    if ((n as any).id && n.uuid) uuidById.set((n as any).id, n.uuid);
  }
  const resolveNode = (ref: any): string => {
    if (typeof ref !== 'string') return String(ref ?? '');
    if (nodeUuids.has(ref)) return ref;
    const mapped = uuidById.get(ref);
    return mapped ?? ref;
  };

  return [...edges].sort((a, b) => {
    const aFrom = resolveNode((a as any).from);
    const bFrom = resolveNode((b as any).from);
    const aTo = resolveNode((a as any).to);
    const bTo = resolveNode((b as any).to);
    const aFromRank = rank.get(aFrom) ?? Number.MAX_SAFE_INTEGER;
    const bFromRank = rank.get(bFrom) ?? Number.MAX_SAFE_INTEGER;
    if (aFromRank !== bFromRank) return aFromRank - bFromRank;
    const aToRank = rank.get(aTo) ?? Number.MAX_SAFE_INTEGER;
    const bToRank = rank.get(bTo) ?? Number.MAX_SAFE_INTEGER;
    if (aToRank !== bToRank) return aToRank - bToRank;
    const aKey = (a as any).id || (a as any).uuid || '';
    const bKey = (b as any).id || (b as any).uuid || '';
    return String(aKey).localeCompare(String(bKey));
  });
}

/**
 * Extract all parameters from a graph
 */
export function extractParamsFromGraph(graph: Graph | null): ScenarioParams {
  if (!graph) {
    return { edges: {}, nodes: {} };
  }

  const params: ScenarioParams = {
    edges: {},
    nodes: {}
  };

  // Extract edge parameters
  if (graph.edges) {
    for (const edge of sortEdgesTopologically(graph)) {
      const edgeParams = extractEdgeParams(edge);
      if (edgeParams && Object.keys(edgeParams).length > 0) {
        // Use human-readable ID if available, fallback to UUID
        const key = edge.id || edge.uuid;
        params.edges![key] = edgeParams;
      }
    }
  }

  // Extract node parameters
  if (graph.nodes) {
    for (const node of graph.nodes) {
      const nodeParams = extractNodeParams(node);
      if (nodeParams && Object.keys(nodeParams).length > 0) {
        // Use human-readable ID if available, fallback to UUID
        const key = node.id || node.uuid;
        params.nodes![key] = nodeParams;
      }
    }
  }

  return params;
}

/**
 * Extract parameters from a single edge
 * Only include defined (non-undefined) values
 *
 * PARAM PACK FIELDS (scenario-visible, user-overridable + Bayes-facing):
 * - p.mean, p.stdev, p.n
 * - p.posterior.* — probability posterior (alpha, beta, HDI, ess, rhat, fitted_at,
 *     fingerprint, provenance, cohort_*)
 * - p.forecast.mean, p.forecast.stdev
 * - p.evidence.mean, p.evidence.stdev, p.evidence.n, p.evidence.k
 * - p.latency.completeness, p.latency.completeness_stdev,
 *     p.latency.t95, p.latency.path_t95, p.latency.median_lag_days
 * - p.latency Bayesian scalars (populated by the promotion cascade):
 *     mu, sigma, onset_delta_days,
 *     promoted_t95, promoted_onset_delta_days,
 *     promoted_mu_sd, promoted_sigma_sd, promoted_onset_sd, promoted_onset_mu_corr,
 *     path_mu, path_sigma, path_onset_delta_days,
 *     promoted_path_t95, promoted_path_mu_sd, promoted_path_sigma_sd,
 *     promoted_path_onset_sd
 * - p.latency.posterior.* — full latency posterior block
 *
 * NOT IN PARAM PACK (internal/config):
 * - p.distribution, p.min, p.max, p.alpha, p.beta (raw dist knobs)
 * - evidence.scope_from/to, evidence.retrieved_at, evidence.source
 * - latency.latency_parameter, latency.anchor_node_id, latency.mean_lag_days,
 *     latency.*_overridden flags
 */

// Whitelist of scalar latency fields on edge.p.latency that belong in the pack.
// Every other nested object on latency is handled explicitly (posterior below).
const LATENCY_FIELD_WHITELIST = [
  'completeness', 'completeness_stdev',
  't95', 'path_t95', 'median_lag_days',
  // Bayesian promoted scalars
  'mu', 'sigma', 'onset_delta_days',
  'promoted_t95', 'promoted_onset_delta_days',
  'promoted_mu_sd', 'promoted_sigma_sd', 'promoted_onset_sd', 'promoted_onset_mu_corr',
  'path_mu', 'path_sigma', 'path_onset_delta_days',
  'promoted_path_t95', 'promoted_path_mu_sd', 'promoted_path_sigma_sd',
  'promoted_path_onset_sd',
];

// Whitelist of probability posterior fields (edge.p.posterior) that belong in the pack.
// Keeps posterior metadata (alpha/beta/HDI/ess/rhat/etc.) but drops raw sample arrays
// and any future internal fields by not copying the object wholesale.
const PROBABILITY_POSTERIOR_FIELD_WHITELIST = [
  'distribution',
  'alpha', 'beta',
  'hdi_lower', 'hdi_upper', 'hdi_level',
  'ess', 'rhat',
  'fitted_at', 'fingerprint', 'provenance',
  'cohort_alpha', 'cohort_beta',
  'cohort_hdi_lower', 'cohort_hdi_upper',
];

// Whitelist of latency posterior fields (edge.p.latency.posterior).
const LATENCY_POSTERIOR_FIELD_WHITELIST = [
  'distribution',
  'mu_mean', 'mu_sd', 'sigma_mean', 'sigma_sd',
  'onset_mean', 'onset_sd', 'onset_delta_days', 'onset_mu_corr',
  'hdi_t95_lower', 'hdi_t95_upper', 'hdi_level',
  'ess', 'rhat',
  'fitted_at', 'fingerprint', 'provenance',
  // Path-level (cohort-slice) latency
  'path_mu_mean', 'path_mu_sd', 'path_sigma_mean', 'path_sigma_sd',
  'path_onset_mean', 'path_onset_sd', 'path_onset_delta_days',
  'path_hdi_t95_lower', 'path_hdi_t95_upper',
  'path_provenance',
];

function pickWhitelisted(src: any, whitelist: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  if (!src || typeof src !== 'object') return out;
  for (const k of whitelist) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

const NUMERIC_DIFF_EPSILON = 1e-9;

function cloneParamValue<T>(value: T): T {
  if (value == null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function valuesDiffer(lhs: any, rhs: any): boolean {
  if (lhs === rhs) return false;

  if (typeof lhs === 'number' && typeof rhs === 'number') {
    if (!Number.isFinite(lhs) || !Number.isFinite(rhs)) return lhs !== rhs;
    return Math.abs(lhs - rhs) > NUMERIC_DIFF_EPSILON;
  }

  if (lhs == null || rhs == null) return lhs !== rhs;

  if (Array.isArray(lhs) || Array.isArray(rhs)) {
    if (!Array.isArray(lhs) || !Array.isArray(rhs)) return true;
    if (lhs.length !== rhs.length) return true;
    for (let i = 0; i < lhs.length; i++) {
      if (valuesDiffer(lhs[i], rhs[i])) return true;
    }
    return false;
  }

  if (typeof lhs === 'object' && typeof rhs === 'object') {
    const keys = new Set([...Object.keys(lhs), ...Object.keys(rhs)]);
    for (const key of keys) {
      if (valuesDiffer(lhs[key], rhs[key])) return true;
    }
    return false;
  }

  return lhs !== rhs;
}

function diffParamValue(modifiedValue: any, baseValue: any): any {
  if (modifiedValue === undefined) return undefined;

  // Primitives and arrays are atomic at this layer.
  if (
    modifiedValue == null ||
    typeof modifiedValue !== 'object' ||
    Array.isArray(modifiedValue) ||
    baseValue == null ||
    typeof baseValue !== 'object' ||
    Array.isArray(baseValue)
  ) {
    return valuesDiffer(modifiedValue, baseValue)
      ? cloneParamValue(modifiedValue)
      : undefined;
  }

  // Nested object: keep only changed leaves to preserve sparse overlays.
  const diffObject: Record<string, any> = {};
  for (const key of Object.keys(modifiedValue)) {
    const childDiff = diffParamValue(modifiedValue[key], baseValue[key]);
    if (childDiff !== undefined) diffObject[key] = childDiff;
  }
  return Object.keys(diffObject).length > 0 ? diffObject : undefined;
}

function extractEdgeParams(edge: GraphEdge): EdgeParamDiff | null {
  const params: EdgeParamDiff = {};

  // Extract base probability (only scenario-visible fields)
  if (edge.p) {
    const p: any = {};
    const pAny = edge.p as any;
    if (pAny.mean !== undefined) p.mean = pAny.mean;
    if (pAny.stdev !== undefined) p.stdev = pAny.stdev;
    if (pAny.n !== undefined) p.n = pAny.n;
    // NOTE: distribution, min, max, alpha, beta are NOT in param packs

    // === POSTERIOR: Probability posterior (Bayesian alpha/beta/HDI/quality) ===
    if (pAny.posterior) {
      const posterior = pickWhitelisted(pAny.posterior, PROBABILITY_POSTERIOR_FIELD_WHITELIST);
      if (Object.keys(posterior).length > 0) p.posterior = posterior;
    }

    // === EVIDENCE: Only mean and stdev (scenario-overridable) ===
    // NOTE: window_from/to, retrieved_at, source are NOT in param packs
    if (pAny.evidence) {
      const evidence: any = {};
      if (pAny.evidence.mean !== undefined) evidence.mean = pAny.evidence.mean;
      if (pAny.evidence.stdev !== undefined) evidence.stdev = pAny.evidence.stdev;
      if (pAny.evidence.n !== undefined) evidence.n = pAny.evidence.n;
      if (pAny.evidence.k !== undefined) evidence.k = pAny.evidence.k;
      if (Object.keys(evidence).length > 0) p.evidence = evidence;
    }

    // === FORECAST: Projected final conversion (p_∞) ===
    if (pAny.forecast) {
      const forecast: any = {};
      if (pAny.forecast.mean !== undefined) forecast.mean = pAny.forecast.mean;
      if (pAny.forecast.stdev !== undefined) forecast.stdev = pAny.forecast.stdev;
      if (Object.keys(forecast).length > 0) p.forecast = forecast;
    }

    // === LATENCY: computed stats + Bayesian promoted scalars + posterior ===
    // NOTE: latency_parameter, anchor_node_id, mean_lag_days, *_overridden are NOT in param packs
    if (pAny.latency) {
      const latency: any = pickWhitelisted(pAny.latency, LATENCY_FIELD_WHITELIST);
      if (pAny.latency.posterior) {
        const latPosterior = pickWhitelisted(pAny.latency.posterior, LATENCY_POSTERIOR_FIELD_WHITELIST);
        if (Object.keys(latPosterior).length > 0) latency.posterior = latPosterior;
      }
      if (Object.keys(latency).length > 0) p.latency = latency;
    }

    if (Object.keys(p).length > 0) {
      params.p = p;
    }
  }

  // Extract conditional probabilities (only scenario-visible fields)
  if (edge.conditional_p && edge.conditional_p.length > 0) {
    params.conditional_p = {};
    for (const cond of edge.conditional_p) {
      const condP: any = {};
      const condPAny = cond.p as any;
      if (condPAny?.mean !== undefined) condP.mean = condPAny.mean;
      if (condPAny?.stdev !== undefined) condP.stdev = condPAny.stdev;
      if (condPAny?.n !== undefined) condP.n = condPAny.n;
      // NOTE: distribution, min, max, alpha, beta are NOT in param packs
      
      // === EVIDENCE: Only mean and stdev ===
      if (condPAny?.evidence) {
        const evidence: any = {};
        if (condPAny.evidence.mean !== undefined) evidence.mean = condPAny.evidence.mean;
        if (condPAny.evidence.stdev !== undefined) evidence.stdev = condPAny.evidence.stdev;
        if (condPAny.evidence.n !== undefined) evidence.n = condPAny.evidence.n;
        if (condPAny.evidence.k !== undefined) evidence.k = condPAny.evidence.k;
        if (Object.keys(evidence).length > 0) condP.evidence = evidence;
      }
      
      // === FORECAST ===
      if (condPAny?.forecast) {
        const forecast: any = {};
        if (condPAny.forecast.mean !== undefined) forecast.mean = condPAny.forecast.mean;
        if (condPAny.forecast.stdev !== undefined) forecast.stdev = condPAny.forecast.stdev;
        if (Object.keys(forecast).length > 0) condP.forecast = forecast;
      }
      
      // === POSTERIOR: probability posterior on conditional ===
      if (condPAny?.posterior) {
        const posterior = pickWhitelisted(condPAny.posterior, PROBABILITY_POSTERIOR_FIELD_WHITELIST);
        if (Object.keys(posterior).length > 0) condP.posterior = posterior;
      }

      // === LATENCY: computed stats + Bayesian promoted scalars + posterior ===
      if (condPAny?.latency) {
        const latency: any = pickWhitelisted(condPAny.latency, LATENCY_FIELD_WHITELIST);
        if (condPAny.latency.posterior) {
          const latPosterior = pickWhitelisted(condPAny.latency.posterior, LATENCY_POSTERIOR_FIELD_WHITELIST);
          if (Object.keys(latPosterior).length > 0) latency.posterior = latPosterior;
        }
        if (Object.keys(latency).length > 0) condP.latency = latency;
      }
      
      if (Object.keys(condP).length > 0) {
        params.conditional_p[cond.condition] = condP;
      }
    }
    
    // Remove conditional_p if empty
    if (Object.keys(params.conditional_p).length === 0) {
      delete params.conditional_p;
    }
  }

  // Extract weight
  if (edge.weight_default !== undefined) {
    params.weight_default = edge.weight_default;
  }

  // Extract costs (only defined fields)
  if (edge.cost_gbp) {
    const costGbp: any = {};
    if (edge.cost_gbp.mean !== undefined) costGbp.mean = edge.cost_gbp.mean;
    if (edge.cost_gbp.stdev !== undefined) costGbp.stdev = edge.cost_gbp.stdev;
    if (edge.cost_gbp.distribution !== undefined) costGbp.distribution = edge.cost_gbp.distribution;
    costGbp.currency = 'GBP';
    
    if (Object.keys(costGbp).length > 1) { // > 1 because currency is always set
      params.cost_gbp = costGbp;
    }
  }

  if (edge.labour_cost) {
    const costTime: any = {};
    if (edge.labour_cost.mean !== undefined) costTime.mean = edge.labour_cost.mean;
    if (edge.labour_cost.stdev !== undefined) costTime.stdev = edge.labour_cost.stdev;
    if (edge.labour_cost.distribution !== undefined) costTime.distribution = edge.labour_cost.distribution;
    costTime.units = 'days';
    
    if (Object.keys(costTime).length > 1) { // > 1 because units is always set
      params.labour_cost = costTime;
    }
  }

  return Object.keys(params).length > 0 ? params : null;
}

/**
 * Extract parameters from a single node
 * Only include defined (non-undefined) values
 */
function extractNodeParams(node: GraphNode): NodeParamDiff | null {
  const params: NodeParamDiff = {};

  // Extract entry weight
  if (node.entry && node.entry.entry_weight !== undefined) {
    params.entry = {
      entry_weight: node.entry.entry_weight
    };
  }

  // Extract costs (only defined fields)
  if (node.costs) {
    const costs: any = {};
    if (node.costs.monetary !== undefined) costs.monetary = node.costs.monetary;
    if (node.costs.time !== undefined) costs.time = node.costs.time;
    
    if (Object.keys(costs).length > 0) {
      params.costs = costs;
    }
  }

  // Extract case variants
  if (node.case && node.case.variants) {
    params.case = {
      variants: node.case.variants.map(v => ({
        name: v.name,
        weight: v.weight
      }))
    };
  }

  return Object.keys(params).length > 0 ? params : null;
}

/**
 * Extract parameters from specific nodes and edges
 * Used for copying vars from selected objects
 */
/**
 * Extract parameters that differ between a modified graph and a base graph.
 * Used for live scenarios to capture the fetched data as scenario params.
 * 
 * @param modifiedGraph - Graph with fetched data (scenario-specific)
 * @param baseGraph - Original graph (before fetching)
 * @returns ScenarioParams containing only the differences
 */
export function extractDiffParams(
  modifiedGraph: Graph | null,
  baseGraph: Graph | null
): ScenarioParams {
  if (!modifiedGraph) {
    return { edges: {}, nodes: {} };
  }
  
  const params: ScenarioParams = {
    edges: {},
    nodes: {}
  };
  
  // Extract edge differences
  if (modifiedGraph.edges) {
    for (const modifiedEdge of modifiedGraph.edges) {
      const key = modifiedEdge.id || modifiedEdge.uuid;
      const baseEdge = baseGraph?.edges?.find(e => (e.id || e.uuid) === key);
      
      // Extract params from modified edge
      const modifiedParams = extractEdgeParams(modifiedEdge);
      if (!modifiedParams) continue;
      
      // If no base edge, include all params
      if (!baseEdge) {
        params.edges![key] = modifiedParams;
        continue;
      }
      
      // Contract-aware diff: compare each extracted field (including nested
      // p.posterior / p.n / conditional_p) against the same extracted view
      // on the baseline edge. Do not gate the whole p-block on p.mean.
      const baseParams = extractEdgeParams(baseEdge);
      const diffParams: EdgeParamDiff = {};
      const edgeDiffKeys: Array<keyof EdgeParamDiff> = [
        'p',
        'conditional_p',
        'weight_default',
        'cost_gbp',
        'labour_cost',
      ];
      for (const diffKey of edgeDiffKeys) {
        const modifiedValue = modifiedParams[diffKey];
        if (modifiedValue === undefined) continue;
        const baseValue = baseParams?.[diffKey];
        const diffValue = diffParamValue(modifiedValue, baseValue);
        if (diffValue !== undefined) {
          (diffParams as any)[diffKey] = diffValue;
        }
      }

      if (Object.keys(diffParams).length > 0) {
        params.edges![key] = diffParams;
      }
    }
  }
  
  // Node differences (similar pattern)
  if (modifiedGraph.nodes) {
    for (const modifiedNode of modifiedGraph.nodes) {
      const key = modifiedNode.id || modifiedNode.uuid;
      const baseNode = baseGraph?.nodes?.find(n => (n.id || n.uuid) === key);
      
      const modifiedParams = extractNodeParams(modifiedNode);
      if (!modifiedParams) continue;
      
      if (!baseNode) {
        params.nodes![key] = modifiedParams;
        continue;
      }
      
      const baseParams = extractNodeParams(baseNode);
      const diffParams: NodeParamDiff = {};
      const nodeDiffKeys: Array<keyof NodeParamDiff> = ['entry', 'costs', 'case'];
      for (const diffKey of nodeDiffKeys) {
        const modifiedValue = modifiedParams[diffKey];
        if (modifiedValue === undefined) continue;
        const baseValue = baseParams?.[diffKey];
        const diffValue = diffParamValue(modifiedValue, baseValue);
        if (diffValue !== undefined) {
          (diffParams as any)[diffKey] = diffValue;
        }
      }

      if (Object.keys(diffParams).length > 0) {
        params.nodes![key] = diffParams;
      }
    }
  }
  
  return params;
}

/**
 * Extract parameters from specific nodes and edges
 * Used for copying vars from selected objects
 */
export function extractParamsFromSelection(
  graph: Graph | null,
  selectedNodeUuids: string[],
  selectedEdgeUuids: string[]
): ScenarioParams {
  if (!graph) {
    return { edges: {}, nodes: {} };
  }

  const params: ScenarioParams = {
    edges: {},
    nodes: {}
  };

  // Extract parameters from selected edges
  if (selectedEdgeUuids.length > 0 && graph.edges) {
    for (const edge of sortEdgesTopologically(graph)) {
      if (selectedEdgeUuids.includes(edge.uuid)) {
        const edgeParams = extractEdgeParams(edge);
        if (edgeParams && Object.keys(edgeParams).length > 0) {
          // Use human-readable ID if available, fallback to UUID
          const key = edge.id || edge.uuid;
          params.edges![key] = edgeParams;
        }
      }
    }
  }

  // Extract parameters from selected nodes
  if (selectedNodeUuids.length > 0 && graph.nodes) {
    for (const node of graph.nodes) {
      if (selectedNodeUuids.includes(node.uuid)) {
        const nodeParams = extractNodeParams(node);
        if (nodeParams && Object.keys(nodeParams).length > 0) {
          // Use human-readable ID if available, fallback to UUID
          const key = node.id || node.uuid;
          params.nodes![key] = nodeParams;
        }
      }
    }
  }

  return params;
}

