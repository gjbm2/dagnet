/**
 * DiffService
 * 
 * Computes differences between scenario parameters.
 * Supports "all" (full params) and "differences" (sparse diff) modes.
 */

import { ScenarioParams, EdgeParamDiff, NodeParamDiff } from '../types/scenarios';

/**
 * Compute diff between current and base parameters
 * 
 * @param current - Current parameter state
 * @param base - Base parameter state to diff against
 * @param type - 'all' returns full current, 'differences' returns sparse diff
 * @param epsilon - Threshold for detecting differences (default 1e-6)
 * @returns Diff as ScenarioParams
 */
export function computeDiff(
  current: ScenarioParams,
  base: ScenarioParams,
  type: 'all' | 'differences',
  epsilon: number = 1e-6
): ScenarioParams {
  if (type === 'all') {
    // Return full current params
    return deepClone(current);
  }
  
  // Compute sparse diff
  const diff: ScenarioParams = {};
  
  // Diff edges
  if (current.edges) {
    diff.edges = {};
    for (const [edgeId, currentEdgeParams] of Object.entries(current.edges)) {
      const baseEdgeParams = base.edges?.[edgeId];
      const edgeDiff = diffEdgeParams(currentEdgeParams, baseEdgeParams, epsilon);
      
      if (edgeDiff && Object.keys(edgeDiff).length > 0) {
        diff.edges[edgeId] = edgeDiff;
      }
    }
    
    if (Object.keys(diff.edges).length === 0) {
      delete diff.edges;
    }
  }
  
  // Diff nodes
  if (current.nodes) {
    diff.nodes = {};
    for (const [nodeId, currentNodeParams] of Object.entries(current.nodes)) {
      const baseNodeParams = base.nodes?.[nodeId];
      const nodeDiff = diffNodeParams(currentNodeParams, baseNodeParams, epsilon);
      
      if (nodeDiff && Object.keys(nodeDiff).length > 0) {
        diff.nodes[nodeId] = nodeDiff;
      }
    }
    
    if (Object.keys(diff.nodes).length === 0) {
      delete diff.nodes;
    }
  }
  
  return diff;
}

/**
 * Compute diff for edge parameters
 */
function diffEdgeParams(
  current: EdgeParamDiff,
  base: EdgeParamDiff | undefined,
  epsilon: number
): EdgeParamDiff | null {
  const diff: EdgeParamDiff = {};
  
  // Diff probability param
  if (current.p) {
    const basep = base?.p;
    const pDiff = diffProbabilityParam(current.p, basep, epsilon);
    if (pDiff) {
      diff.p = pDiff;
    }
  }
  
  // Diff weight_default
  if (current.weight_default !== undefined) {
    const baseWeight = base?.weight_default;
    if (baseWeight === undefined || Math.abs(current.weight_default - baseWeight) > epsilon) {
      diff.weight_default = current.weight_default;
    }
  }
  
  // Diff cost_gbp
  if (current.cost_gbp) {
    const baseCost = base?.cost_gbp;
    const costDiff = diffCostParam(current.cost_gbp, baseCost, epsilon);
    if (costDiff) {
      diff.cost_gbp = costDiff;
    }
  }
  
  // Diff labour_cost
  if (current.labour_cost) {
    const baseCost = base?.labour_cost;
    const costDiff = diffCostParam(current.labour_cost, baseCost, epsilon);
    if (costDiff) {
      diff.labour_cost = costDiff;
    }
  }
  
  // Diff conditional_p
  if (current.conditional_p) {
    diff.conditional_p = {};
    for (const [condition, prob] of Object.entries(current.conditional_p)) {
      const baseProb = base?.conditional_p?.[condition];
      if (prob === null) {
        // Explicit null means removal
        diff.conditional_p[condition] = null;
      } else {
        const probDiff = diffProbabilityParam(prob, baseProb, epsilon);
        if (probDiff) {
          diff.conditional_p[condition] = probDiff;
        }
      }
    }
    
    if (Object.keys(diff.conditional_p).length === 0) {
      delete diff.conditional_p;
    }
  }
  
  return Object.keys(diff).length > 0 ? diff : null;
}

/**
 * Compute diff for node parameters
 */
function diffNodeParams(
  current: NodeParamDiff,
  base: NodeParamDiff | undefined,
  epsilon: number
): NodeParamDiff | null {
  const diff: NodeParamDiff = {};
  
  // Diff entry
  if (current.entry?.entry_weight !== undefined) {
    const baseWeight = base?.entry?.entry_weight;
    if (baseWeight === undefined || Math.abs(current.entry.entry_weight - baseWeight) > epsilon) {
      diff.entry = { entry_weight: current.entry.entry_weight };
    }
  }
  
  // Diff costs (simplified - just check if different)
  if (current.costs) {
    if (!base?.costs || JSON.stringify(current.costs) !== JSON.stringify(base.costs)) {
      diff.costs = deepClone(current.costs);
    }
  }
  
  // Diff case
  if (current.case?.variants) {
    const baseVariants = base?.case?.variants;
    if (!baseVariants || JSON.stringify(current.case.variants) !== JSON.stringify(baseVariants)) {
      diff.case = { variants: deepClone(current.case.variants) };
    }
  }
  
  return Object.keys(diff).length > 0 ? diff : null;
}

/**
 * Diff probability parameters
 */
function diffProbabilityParam(
  current: any,
  base: any | undefined,
  epsilon: number
): any | null {
  if (!base) {
    return deepClone(current);
  }
  
  const diff: any = {};
  let hasDiff = false;
  
  for (const [key, value] of Object.entries(current)) {
    if (typeof value === 'number') {
      const baseValue = base[key];
      if (baseValue === undefined || Math.abs(value - baseValue) > epsilon) {
        diff[key] = value;
        hasDiff = true;
      }
    } else {
      // Non-numeric values (e.g., distribution type)
      if (value !== base[key]) {
        diff[key] = value;
        hasDiff = true;
      }
    }
  }
  
  return hasDiff ? diff : null;
}

/**
 * Diff cost parameters
 */
function diffCostParam(
  current: any,
  base: any | undefined,
  epsilon: number
): any | null {
  if (!base) {
    return deepClone(current);
  }
  
  const diff: any = {};
  let hasDiff = false;
  
  for (const [key, value] of Object.entries(current)) {
    if (typeof value === 'number') {
      const baseValue = base[key];
      if (baseValue === undefined || Math.abs(value - baseValue) > epsilon) {
        diff[key] = value;
        hasDiff = true;
      }
    } else {
      // Non-numeric values
      if (value !== base[key]) {
        diff[key] = value;
        hasDiff = true;
      }
    }
  }
  
  return hasDiff ? diff : null;
}

/**
 * Deep clone helper
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
 * Merge two scenario params (used for testing and utilities)
 */
export function mergeParams(base: ScenarioParams, overlay: ScenarioParams): ScenarioParams {
  // Simple merge for testing - production code uses CompositionService
  return {
    edges: { ...base.edges, ...overlay.edges },
    nodes: { ...base.nodes, ...overlay.nodes }
  };
}








