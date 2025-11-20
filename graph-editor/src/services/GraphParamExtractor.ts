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
 */
function extractEdgeParams(edge: GraphEdge): EdgeParamDiff | null {
  const params: EdgeParamDiff = {};

  // Extract base probability (only defined fields)
  if (edge.p) {
    const p: any = {};
    const pAny = edge.p as any; // Type assertion for optional properties
    if (pAny.mean !== undefined) p.mean = pAny.mean;
    if (pAny.stdev !== undefined) p.stdev = pAny.stdev;
    if (pAny.distribution !== undefined) p.distribution = pAny.distribution;
    if (pAny.min !== undefined) p.min = pAny.min;
    if (pAny.max !== undefined) p.max = pAny.max;
    if (pAny.alpha !== undefined) p.alpha = pAny.alpha;
    if (pAny.beta !== undefined) p.beta = pAny.beta;
    
    if (Object.keys(p).length > 0) {
      params.p = p;
    }
  }

  // Extract conditional probabilities (only defined fields)
  if (edge.conditional_p && edge.conditional_p.length > 0) {
    params.conditional_p = {};
    for (const cond of edge.conditional_p) {
      const condP: any = {};
      const condPAny = cond.p as any; // Type assertion for optional properties
      if (condPAny?.mean !== undefined) condP.mean = condPAny.mean;
      if (condPAny?.stdev !== undefined) condP.stdev = condPAny.stdev;
      if (condPAny?.distribution !== undefined) condP.distribution = condPAny.distribution;
      if (condPAny?.min !== undefined) condP.min = condPAny.min;
      if (condPAny?.max !== undefined) condP.max = condPAny.max;
      if (condPAny?.alpha !== undefined) condP.alpha = condPAny.alpha;
      if (condPAny?.beta !== undefined) condP.beta = condPAny.beta;
      
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

  if (edge.cost_time) {
    const costTime: any = {};
    if (edge.cost_time.mean !== undefined) costTime.mean = edge.cost_time.mean;
    if (edge.cost_time.stdev !== undefined) costTime.stdev = edge.cost_time.stdev;
    if (edge.cost_time.distribution !== undefined) costTime.distribution = edge.cost_time.distribution;
    costTime.units = 'days';
    
    if (Object.keys(costTime).length > 1) { // > 1 because units is always set
      params.cost_time = costTime;
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

