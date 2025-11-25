/**
 * ScenarioValidator
 * 
 * Validates scenario parameters against graph structure and schema.
 * Checks HRN resolution, param schema compliance, and warns on issues.
 */

import { ScenarioParams, ScenarioValidationResult } from '../types/scenarios';
import { Graph } from '../types';
import { resolveEdgeHRN, resolveNodeHRN, resolveAllHRNs } from './HRNResolver';

/**
 * Validate scenario parameters
 * 
 * @param params - Scenario parameters to validate
 * @param graph - Graph to validate against
 * @returns Validation result with errors and warnings
 */
export function validateScenarioParams(
  params: ScenarioParams,
  graph: Graph
): ScenarioValidationResult {
  const errors: Array<{ path: string; message: string }> = [];
  const warnings: Array<{ path: string; message: string }> = [];
  const unresolvedHRNs: string[] = [];
  
  // Validate structure
  if (typeof params !== 'object' || params === null) {
    errors.push({
      path: 'root',
      message: 'Scenario params must be an object'
    });
    return { valid: false, errors, warnings, unresolvedHRNs };
  }
  
  // Validate edges
  if (params.edges) {
    if (typeof params.edges !== 'object') {
      errors.push({
        path: 'edges',
        message: 'edges must be an object'
      });
    } else {
      for (const [edgeKey, edgeParams] of Object.entries(params.edges)) {
        validateEdgeParams(edgeKey, edgeParams, graph, errors, warnings, unresolvedHRNs);
      }
    }
  }
  
  // Validate nodes
  if (params.nodes) {
    if (typeof params.nodes !== 'object') {
      errors.push({
        path: 'nodes',
        message: 'nodes must be an object'
      });
    } else {
      for (const [nodeKey, nodeParams] of Object.entries(params.nodes)) {
        validateNodeParams(nodeKey, nodeParams, graph, errors, warnings, unresolvedHRNs);
      }
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    unresolvedHRNs
  };
}

/**
 * Validate edge parameters
 */
function validateEdgeParams(
  edgeKey: string,
  edgeParams: any,
  graph: Graph,
  errors: Array<{ path: string; message: string }>,
  warnings: Array<{ path: string; message: string }>,
  unresolvedHRNs: string[]
): void {
  const path = `edges.${edgeKey}`;
  
  // Try to resolve HRN
  const resolvedUuid = resolveEdgeHRN(edgeKey, graph);
  if (!resolvedUuid) {
    warnings.push({
      path,
      message: `Could not resolve edge HRN "${edgeKey}". Use e.uuid() for disambiguation.`
    });
    unresolvedHRNs.push(edgeKey);
  }
  
  // Validate edge param structure
  if (typeof edgeParams !== 'object' || edgeParams === null) {
    errors.push({
      path,
      message: 'Edge params must be an object'
    });
    return;
  }
  
  // Validate p (probability param)
  if (edgeParams.p !== undefined) {
    if (edgeParams.p !== null && typeof edgeParams.p !== 'object') {
      errors.push({
        path: `${path}.p`,
        message: 'p must be an object or null'
      });
    } else if (edgeParams.p) {
      validateProbabilityParam(`${path}.p`, edgeParams.p, errors, warnings);
    }
  }
  
  // Validate weight_default
  if (edgeParams.weight_default !== undefined) {
    if (typeof edgeParams.weight_default !== 'number') {
      errors.push({
        path: `${path}.weight_default`,
        message: 'weight_default must be a number'
      });
    } else if (edgeParams.weight_default < 0) {
      warnings.push({
        path: `${path}.weight_default`,
        message: 'weight_default is negative'
      });
    }
  }
  
  // Validate cost_gbp
  if (edgeParams.cost_gbp !== undefined) {
    if (edgeParams.cost_gbp !== null && typeof edgeParams.cost_gbp !== 'object') {
      errors.push({
        path: `${path}.cost_gbp`,
        message: 'cost_gbp must be an object or null'
      });
    } else if (edgeParams.cost_gbp) {
      validateCostParam(`${path}.cost_gbp`, edgeParams.cost_gbp, errors, warnings);
    }
  }
  
  // Validate cost_time
  if (edgeParams.cost_time !== undefined) {
    if (edgeParams.cost_time !== null && typeof edgeParams.cost_time !== 'object') {
      errors.push({
        path: `${path}.cost_time`,
        message: 'cost_time must be an object or null'
      });
    } else if (edgeParams.cost_time) {
      validateCostParam(`${path}.cost_time`, edgeParams.cost_time, errors, warnings);
    }
  }
  
  // Validate conditional_p
  if (edgeParams.conditional_p !== undefined) {
    if (typeof edgeParams.conditional_p !== 'object' || edgeParams.conditional_p === null) {
      errors.push({
        path: `${path}.conditional_p`,
        message: 'conditional_p must be an object'
      });
    } else {
      for (const [condition, prob] of Object.entries(edgeParams.conditional_p)) {
        if (prob !== null) {
          validateProbabilityParam(`${path}.conditional_p.${condition}`, prob, errors, warnings);
        }
      }
    }
  }
}

/**
 * Validate node parameters
 */
function validateNodeParams(
  nodeKey: string,
  nodeParams: any,
  graph: Graph,
  errors: Array<{ path: string; message: string }>,
  warnings: Array<{ path: string; message: string }>,
  unresolvedHRNs: string[]
): void {
  const path = `nodes.${nodeKey}`;
  
  // Try to resolve HRN
  const resolvedUuid = resolveNodeHRN(nodeKey, graph);
  if (!resolvedUuid) {
    warnings.push({
      path,
      message: `Could not resolve node HRN "${nodeKey}". Use n.uuid() for disambiguation.`
    });
    unresolvedHRNs.push(nodeKey);
  }
  
  // Validate node param structure
  if (typeof nodeParams !== 'object' || nodeParams === null) {
    errors.push({
      path,
      message: 'Node params must be an object'
    });
    return;
  }
  
  // Validate entry
  if (nodeParams.entry !== undefined) {
    if (nodeParams.entry !== null && typeof nodeParams.entry !== 'object') {
      errors.push({
        path: `${path}.entry`,
        message: 'entry must be an object or null'
      });
    } else if (nodeParams.entry?.entry_weight !== undefined) {
      if (typeof nodeParams.entry.entry_weight !== 'number') {
        errors.push({
          path: `${path}.entry.entry_weight`,
          message: 'entry_weight must be a number'
        });
      }
    }
  }
  
  // Validate case
  if (nodeParams.case !== undefined) {
    if (nodeParams.case !== null && typeof nodeParams.case !== 'object') {
      errors.push({
        path: `${path}.case`,
        message: 'case must be an object or null'
      });
    } else if (nodeParams.case?.variants) {
      if (!Array.isArray(nodeParams.case.variants)) {
        errors.push({
          path: `${path}.case.variants`,
          message: 'variants must be an array'
        });
      }
    }
  }
}

/**
 * Validate probability parameter
 */
function validateProbabilityParam(
  path: string,
  param: any,
  errors: Array<{ path: string; message: string }>,
  warnings: Array<{ path: string; message: string }>
): void {
  if (param.mean !== undefined) {
    if (typeof param.mean !== 'number') {
      errors.push({ path: `${path}.mean`, message: 'mean must be a number' });
    } else if (param.mean < 0 || param.mean > 1) {
      warnings.push({ path: `${path}.mean`, message: 'mean should be between 0 and 1' });
    }
  }
  
  if (param.stdev !== undefined) {
    if (typeof param.stdev !== 'number') {
      errors.push({ path: `${path}.stdev`, message: 'stdev must be a number' });
    } else if (param.stdev < 0) {
      warnings.push({ path: `${path}.stdev`, message: 'stdev should be non-negative' });
    }
  }
  
  if (param.distribution !== undefined) {
    const validDistributions = ['beta', 'normal', 'lognormal', 'gamma', 'uniform'];
    if (!validDistributions.includes(param.distribution)) {
      errors.push({
        path: `${path}.distribution`,
        message: `distribution must be one of: ${validDistributions.join(', ')}`
      });
    }
  }
}

/**
 * Validate cost parameter
 */
function validateCostParam(
  path: string,
  param: any,
  errors: Array<{ path: string; message: string }>,
  warnings: Array<{ path: string; message: string }>
): void {
  if (param.value !== undefined && typeof param.value !== 'number') {
    errors.push({ path: `${path}.value`, message: 'value must be a number' });
  }
  
  if (param.stdev !== undefined) {
    if (typeof param.stdev !== 'number') {
      errors.push({ path: `${path}.stdev`, message: 'stdev must be a number' });
    } else if (param.stdev < 0) {
      warnings.push({ path: `${path}.stdev`, message: 'stdev should be non-negative' });
    }
  }
  
  if (param.distribution !== undefined) {
    const validDistributions = ['normal', 'lognormal', 'gamma', 'uniform'];
    if (!validDistributions.includes(param.distribution)) {
      errors.push({
        path: `${path}.distribution`,
        message: `distribution must be one of: ${validDistributions.join(', ')}`
      });
    }
  }
}






