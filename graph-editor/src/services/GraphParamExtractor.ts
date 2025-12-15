/**
 * GraphParamExtractor
 * 
 * Extracts ScenarioParams from a Graph.
 * Converts graph edge/node data into the scenario parameter format.
 */

import { Graph, GraphEdge, GraphNode } from '../types';
import { ScenarioParams, EdgeParamDiff, NodeParamDiff } from '../types/scenarios';

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
    for (const edge of graph.edges) {
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
 * PARAM PACK FIELDS (scenario-visible, user-overridable):
 * - p.mean, p.stdev
 * - p.forecast.mean, p.forecast.stdev
 * - p.evidence.mean, p.evidence.stdev
 * - p.latency.completeness, p.latency.t95, p.latency.median_lag_days
 * 
 * NOT IN PARAM PACK (internal/config):
 * - distribution, min, max, alpha, beta
 * - evidence.n, evidence.k, evidence.window_from/to, evidence.retrieved_at, evidence.source
 * - latency.latency_parameter, latency.anchor_node_id, latency.mean_lag_days
 */
function extractEdgeParams(edge: GraphEdge): EdgeParamDiff | null {
  const params: EdgeParamDiff = {};

  // Extract base probability (only scenario-visible fields)
  if (edge.p) {
    const p: any = {};
    const pAny = edge.p as any;
    if (pAny.mean !== undefined) p.mean = pAny.mean;
    if (pAny.stdev !== undefined) p.stdev = pAny.stdev;
    // NOTE: distribution, min, max, alpha, beta are NOT in param packs
    
    // === EVIDENCE: Only mean and stdev (scenario-overridable) ===
    // NOTE: n, k, window_from/to, retrieved_at, source are NOT in param packs
    if (pAny.evidence) {
      const evidence: any = {};
      if (pAny.evidence.mean !== undefined) evidence.mean = pAny.evidence.mean;
      if (pAny.evidence.stdev !== undefined) evidence.stdev = pAny.evidence.stdev;
      if (Object.keys(evidence).length > 0) p.evidence = evidence;
    }
    
    // === FORECAST: Projected final conversion (p_∞) ===
    if (pAny.forecast) {
      const forecast: any = {};
      if (pAny.forecast.mean !== undefined) forecast.mean = pAny.forecast.mean;
      if (pAny.forecast.stdev !== undefined) forecast.stdev = pAny.forecast.stdev;
      if (Object.keys(forecast).length > 0) p.forecast = forecast;
    }
    
    // === LATENCY: Only computed stats (completeness, t95, path_t95, median_lag_days) ===
    // NOTE: latency_parameter, anchor_node_id, mean_lag_days, *_overridden are NOT in param packs
    if (pAny.latency) {
      const latency: any = {};
      if (pAny.latency.completeness !== undefined) latency.completeness = pAny.latency.completeness;
      if (pAny.latency.t95 !== undefined) latency.t95 = pAny.latency.t95;
      if (pAny.latency.path_t95 !== undefined) latency.path_t95 = pAny.latency.path_t95;
      if (pAny.latency.median_lag_days !== undefined) latency.median_lag_days = pAny.latency.median_lag_days;
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
      // NOTE: distribution, min, max, alpha, beta are NOT in param packs
      
      // === EVIDENCE: Only mean and stdev ===
      if (condPAny?.evidence) {
        const evidence: any = {};
        if (condPAny.evidence.mean !== undefined) evidence.mean = condPAny.evidence.mean;
        if (condPAny.evidence.stdev !== undefined) evidence.stdev = condPAny.evidence.stdev;
        if (Object.keys(evidence).length > 0) condP.evidence = evidence;
      }
      
      // === FORECAST ===
      if (condPAny?.forecast) {
        const forecast: any = {};
        if (condPAny.forecast.mean !== undefined) forecast.mean = condPAny.forecast.mean;
        if (condPAny.forecast.stdev !== undefined) forecast.stdev = condPAny.forecast.stdev;
        if (Object.keys(forecast).length > 0) condP.forecast = forecast;
      }
      
      // === LATENCY: Only computed stats (completeness, t95, path_t95, median_lag_days) ===
      if (condPAny?.latency) {
        const latency: any = {};
        if (condPAny.latency.completeness !== undefined) latency.completeness = condPAny.latency.completeness;
        if (condPAny.latency.t95 !== undefined) latency.t95 = condPAny.latency.t95;
        if (condPAny.latency.path_t95 !== undefined) latency.path_t95 = condPAny.latency.path_t95;
        if (condPAny.latency.median_lag_days !== undefined) latency.median_lag_days = condPAny.latency.median_lag_days;
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
      
      // Compare and only include differences
      const diffParams: EdgeParamDiff = {};
      
      // Check p.mean difference (most common case)
      if (modifiedParams.p?.mean !== undefined) {
        const baseMean = (baseEdge.p as any)?.mean;
        if (baseMean === undefined || Math.abs(modifiedParams.p.mean - baseMean) > 1e-9) {
          diffParams.p = { ...modifiedParams.p };
        }
      }
      
      // Include other param differences as needed
      if (modifiedParams.cost_gbp?.mean !== undefined) {
        const baseCost = baseEdge.cost_gbp?.mean;
        if (baseCost === undefined || Math.abs(modifiedParams.cost_gbp.mean - baseCost) > 1e-9) {
          diffParams.cost_gbp = { ...modifiedParams.cost_gbp };
        }
      }
      
      if (modifiedParams.labour_cost?.mean !== undefined) {
        const baseCost = baseEdge.labour_cost?.mean;
        if (baseCost === undefined || Math.abs(modifiedParams.labour_cost.mean - baseCost) > 1e-9) {
          diffParams.labour_cost = { ...modifiedParams.labour_cost };
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
      
      // Compare entry weights
      const diffParams: NodeParamDiff = {};
      if (modifiedParams.entry?.entry_weight !== undefined) {
        const baseWeight = baseNode.entry?.entry_weight;
        if (baseWeight === undefined || Math.abs(modifiedParams.entry.entry_weight - baseWeight) > 1e-9) {
          diffParams.entry = { ...modifiedParams.entry };
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
    for (const edge of graph.edges) {
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

