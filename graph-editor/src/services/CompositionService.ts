/**
 * CompositionService
 * 
 * Handles deep-merging of scenario parameter overlays with deterministic precedence.
 * Null values remove keys from the composition.
 */

import { ScenarioParams, EdgeParamDiff, NodeParamDiff } from '../types/scenarios';

/**
 * Compose multiple scenario parameter overlays into a single merged result.
 * 
 * @param base - Base parameters to start from
 * @param overlays - Array of overlays to merge (in order, later overlays take precedence)
 * @returns Composed parameters
 */
export function composeParams(
  base: ScenarioParams,
  overlays: ScenarioParams[]
): ScenarioParams {
  // Start with a deep copy of base
  let result: ScenarioParams = deepClone(base);
  
  // Apply each overlay in order
  for (const overlay of overlays) {
    result = mergeScenarioParams(result, overlay);
  }
  
  return result;
}

/**
 * Merge a single overlay into the accumulator
 */
function mergeScenarioParams(
  target: ScenarioParams,
  source: ScenarioParams
): ScenarioParams {
  const result: ScenarioParams = { ...target };
  
  // Merge edges
  if (source.edges) {
    result.edges = result.edges || {};
    for (const [edgeId, edgeParams] of Object.entries(source.edges)) {
      if (edgeParams === null) {
        // Null removes the entire edge entry
        delete result.edges[edgeId];
      } else {
        result.edges[edgeId] = mergeEdgeParams(
          result.edges[edgeId] || {},
          edgeParams
        );
      }
    }
  }
  
  // Merge nodes
  if (source.nodes) {
    result.nodes = result.nodes || {};
    for (const [nodeId, nodeParams] of Object.entries(source.nodes)) {
      if (nodeParams === null) {
        // Null removes the entire node entry
        delete result.nodes[nodeId];
      } else {
        result.nodes[nodeId] = mergeNodeParams(
          result.nodes[nodeId] || {},
          nodeParams
        );
      }
    }
  }
  
  return result;
}

/**
 * Merge edge parameters
 */
function mergeEdgeParams(
  target: EdgeParamDiff,
  source: EdgeParamDiff
): EdgeParamDiff {
  const result: EdgeParamDiff = { ...target };
  
  // Merge simple fields
  if (source.p !== undefined) {
    result.p = source.p === null ? undefined : { ...target.p, ...source.p };
  }
  
  if (source.weight_default !== undefined) {
    result.weight_default = source.weight_default;
  }
  
  if (source.cost_gbp !== undefined) {
    result.cost_gbp = source.cost_gbp === null ? undefined : { ...target.cost_gbp, ...source.cost_gbp };
  }
  
  if (source.cost_time !== undefined) {
    result.cost_time = source.cost_time === null ? undefined : { ...target.cost_time, ...source.cost_time };
  }
  
  // Merge conditional_p (special handling for nested record)
  if (source.conditional_p !== undefined) {
    result.conditional_p = result.conditional_p || {};
    for (const [condition, prob] of Object.entries(source.conditional_p)) {
      if (prob === null) {
        // Null removes this condition
        delete result.conditional_p[condition];
      } else {
        result.conditional_p[condition] = {
          ...result.conditional_p[condition],
          ...prob
        };
      }
    }
  }
  
  return result;
}

/**
 * Merge node parameters
 */
function mergeNodeParams(
  target: NodeParamDiff,
  source: NodeParamDiff
): NodeParamDiff {
  const result: NodeParamDiff = { ...target };
  
  // Merge entry
  if (source.entry !== undefined) {
    result.entry = source.entry === null ? undefined : { ...target.entry, ...source.entry };
  }
  
  // Merge costs
  if (source.costs !== undefined) {
    result.costs = source.costs === null ? undefined : {
      monetary: source.costs.monetary !== undefined ? source.costs.monetary : target.costs?.monetary,
      time: source.costs.time !== undefined ? source.costs.time : target.costs?.time
    };
  }
  
  // Merge case
  if (source.case !== undefined) {
    if (source.case === null) {
      result.case = undefined;
    } else {
      result.case = { ...target.case };
      if (source.case.variants !== undefined) {
        result.case.variants = source.case.variants;
      }
    }
  }
  
  return result;
}

/**
 * Deep clone a scenario params object
 */
function deepClone<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  if (typeof obj !== 'object') {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => deepClone(item)) as any;
  }
  
  const cloned: any = {};
  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      cloned[key] = deepClone(obj[key]);
    }
  }
  
  return cloned;
}

/**
 * Check if two scenario params are deeply equal
 */
export function areParamsEqual(a: ScenarioParams, b: ScenarioParams): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}



