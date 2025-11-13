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
        params.edges![edge.uuid] = edgeParams;
      }
    }
  }

  // Extract node parameters
  if (graph.nodes) {
    for (const node of graph.nodes) {
      const nodeParams = extractNodeParams(node);
      if (nodeParams && Object.keys(nodeParams).length > 0) {
        params.nodes![node.uuid] = nodeParams;
      }
    }
  }

  return params;
}

/**
 * Extract parameters from a single edge
 */
function extractEdgeParams(edge: GraphEdge): EdgeParamDiff | null {
  const params: EdgeParamDiff = {};

  // Extract base probability
  if (edge.p) {
    params.p = {
      mean: edge.p.mean,
      stdev: edge.p.stdev,
      distribution: edge.p.distribution,
      min: edge.p.min,
      max: edge.p.max,
      alpha: edge.p.alpha,
      beta: edge.p.beta,
    };
  }

  // Extract conditional probabilities
  if (edge.conditional_p && edge.conditional_p.length > 0) {
    params.conditional_p = {};
    for (const cond of edge.conditional_p) {
      params.conditional_p[cond.condition] = {
        mean: cond.p?.mean,
        stdev: cond.p?.stdev,
        distribution: cond.p?.distribution,
        min: cond.p?.min,
        max: cond.p?.max,
        alpha: cond.p?.alpha,
        beta: cond.p?.beta,
      };
    }
  }

  // Extract weight
  if (edge.weight_default !== undefined) {
    params.weight_default = edge.weight_default;
  }

  // Extract costs
  if (edge.cost_gbp) {
    params.cost_gbp = {
      value: edge.cost_gbp.mean,
      stdev: edge.cost_gbp.stdev,
      distribution: edge.cost_gbp.distribution,
      currency: 'GBP',
    };
  }

  if (edge.cost_time) {
    params.cost_time = {
      value: edge.cost_time.mean,
      stdev: edge.cost_time.stdev,
      distribution: edge.cost_time.distribution,
      units: 'days',
    };
  }

  return Object.keys(params).length > 0 ? params : null;
}

/**
 * Extract parameters from a single node
 */
function extractNodeParams(node: GraphNode): NodeParamDiff | null {
  const params: NodeParamDiff = {};

  // Extract entry weight
  if (node.entry && node.entry.entry_weight !== undefined) {
    params.entry = {
      entry_weight: node.entry.entry_weight
    };
  }

  // Extract costs
  if (node.costs) {
    params.costs = {
      monetary: node.costs.monetary,
      time: node.costs.time,
    };
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

