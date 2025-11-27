/**
 * CompositionService
 * 
 * Handles deep-merging of scenario parameter overlays with deterministic precedence.
 * Null values remove keys from the composition.
 * 
 * This is the SINGLE source of truth for scenario composition logic.
 * All rendering and analysis code should use these functions.
 */

import { ScenarioParams, EdgeParamDiff, NodeParamDiff, Scenario } from '../types/scenarios';
import { Graph, GraphEdge, GraphNode } from '../types';
import { computeEffectiveEdgeProbability, parseWhatIfDSL } from '../lib/whatIf';

/**
 * Minimal scenario interface for composition (avoids full Scenario dependency)
 */
interface ScenarioLike {
  id: string;
  params: ScenarioParams;
}

/**
 * Get composed parameters for a specific layer.
 * 
 * This is the SINGLE entry point for "what are the params for layer X?"
 * Replaces all the duplicated composition patterns across the codebase.
 * 
 * @param layerId - Layer ID: 'base', 'current', or a scenario ID
 * @param baseParams - Base parameters (from graph when file opened)
 * @param currentParams - Current parameters (live working state)
 * @param scenarios - All scenarios
 * @param visibleScenarioIds - Optional: if provided, only compose visible scenarios in this order
 * @returns Composed parameters for the layer
 */
export function getComposedParamsForLayer(
  layerId: string,
  baseParams: ScenarioParams,
  currentParams: ScenarioParams,
  scenarios: ScenarioLike[],
  visibleScenarioIds?: string[]
): ScenarioParams {
  // Special layer: 'base' - return base params as-is
  if (layerId === 'base') {
    return deepClone(baseParams);
  }
  
  // Special layer: 'current' - already composed (base + what-if)
  if (layerId === 'current') {
    return deepClone(currentParams);
  }
  
  // Scenario layer: compose from base through all layers up to this one
  const scenario = scenarios.find(s => s.id === layerId);
  if (!scenario) {
    // Unknown scenario - return base as fallback
    return deepClone(baseParams);
  }
  
  // Determine layer order
  const layerOrder = visibleScenarioIds || scenarios.map(s => s.id);
  const layerIndex = layerOrder.indexOf(layerId);
  
  if (layerIndex === -1) {
    // Layer not in order - just compose this single overlay
    return composeParams(baseParams, [scenario.params]);
  }
  
  // Get all layers up to and including this one
  const layersUpToThis = layerOrder
    .slice(0, layerIndex + 1)
    .map(id => scenarios.find(s => s.id === id))
    .filter((s): s is ScenarioLike => s !== undefined);
  
  // Compose overlays
  const overlays = layersUpToThis.map(s => s.params);
  return composeParams(baseParams, overlays);
}

/**
 * Apply composed parameters to a graph, creating a new graph with values baked in.
 * 
 * This is used for analysis: compose params in TS, then create a graph
 * with those values that can be sent to Python for analysis.
 * 
 * @param graph - Source graph
 * @param composedParams - Composed parameters to apply
 * @returns New graph with parameter values baked in
 */
export function applyComposedParamsToGraph(
  graph: Graph,
  composedParams: ScenarioParams
): Graph {
  // Deep clone the graph
  const result: Graph = JSON.parse(JSON.stringify(graph));
  
  // Apply edge parameters
  if (result.edges && composedParams.edges) {
    for (const edge of result.edges) {
      const edgeKey = edge.id || edge.uuid;
      const edgeParams = composedParams.edges[edgeKey];
      
      if (edgeParams) {
        // Apply probability
        // Note: ScenarioParams.ProbabilityParam has more distribution types than Graph.ProbabilityParam
        // We spread the values, letting TypeScript handle the compatible subset
        if (edgeParams.p !== undefined) {
          edge.p = { 
            ...edge.p, 
            mean: edgeParams.p.mean ?? edge.p?.mean,
            stdev: edgeParams.p.stdev ?? edge.p?.stdev,
          };
        }
        
        // Apply weight_default
        if (edgeParams.weight_default !== undefined) {
          edge.weight_default = edgeParams.weight_default;
        }
        
        // Apply costs
        if (edgeParams.cost_gbp !== undefined) {
          edge.cost_gbp = { ...edge.cost_gbp, ...edgeParams.cost_gbp };
        }
        if (edgeParams.cost_time !== undefined) {
          edge.cost_time = { ...edge.cost_time, ...edgeParams.cost_time };
        }
        
        // Apply conditional_p (convert from Record to array format if needed)
        if (edgeParams.conditional_p !== undefined) {
          // The graph uses array format, params use Record format
          // For now, we'll keep the existing conditional_p structure
          // and let the rendering/analysis code handle the lookup
          // TODO: If needed, convert between formats
        }
      }
    }
  }
  
  // Apply node parameters
  if (result.nodes && composedParams.nodes) {
    for (const node of result.nodes) {
      const nodeKey = node.id || node.uuid;
      const nodeParams = composedParams.nodes[nodeKey];
      
      if (nodeParams) {
        // Apply entry weight
        if (nodeParams.entry?.entry_weight !== undefined) {
          node.entry = node.entry || {};
          node.entry.entry_weight = nodeParams.entry.entry_weight;
        }
        
        // Apply case variants
        if (nodeParams.case?.variants !== undefined && node.case) {
          node.case.variants = nodeParams.case.variants;
        }
      }
    }
  }
  
  return result;
}

/**
 * Apply What-If DSL overrides to a graph, baking in effective probabilities.
 * 
 * This computes the effective probability for each edge using the What-If DSL
 * (case overrides, conditional overrides) and returns a new graph with those
 * values baked in.
 * 
 * @param graph - Source graph
 * @param whatIfDSL - What-If DSL string (e.g., "case(node-a:variant1).visited(node-b)")
 * @returns New graph with What-If effects applied
 */
export function applyWhatIfToGraph(
  graph: Graph,
  whatIfDSL: string | null | undefined
): Graph {
  // If no What-If DSL, return a clone
  if (!whatIfDSL || !whatIfDSL.trim()) {
    return JSON.parse(JSON.stringify(graph));
  }
  
  // Deep clone the graph
  const result: Graph = JSON.parse(JSON.stringify(graph));
  
  // Parse the DSL to get overrides
  const parsed = parseWhatIfDSL(whatIfDSL, graph);
  
  // Compute effective probability for each edge
  if (result.edges) {
    for (const edge of result.edges) {
      const edgeId = edge.uuid || edge.id;
      if (!edgeId) continue;
      
      // Compute effective probability with What-If DSL
      const effectiveProb = computeEffectiveEdgeProbability(
        graph,  // Use original graph for lookups
        edgeId,
        { whatIfDSL },
        undefined
      );
      
      // Bake the effective probability into the edge
      edge.p = {
        ...edge.p,
        mean: effectiveProb
      };
    }
  }
  
  // Also apply case node variant weights from What-If DSL
  const caseOverrides = parsed.caseOverrides || {};
  
  if (result.nodes) {
    for (const node of result.nodes) {
      if (node.type !== 'case' || !node.case?.variants) continue;
      
      const nodeId = node.id || node.uuid;
      const selectedVariant = caseOverrides[nodeId];
      
      if (selectedVariant) {
        // Set the selected variant to 100% weight, others to 0%
        node.case.variants = node.case.variants.map((v: any) => ({
          ...v,
          weight: v.name === selectedVariant ? 1.0 : 0.0
        }));
      }
    }
  }
  
  return result;
}

/**
 * Build a scenario-modified graph for a specific layer.
 * 
 * Convenience function that combines getComposedParamsForLayer + applyComposedParamsToGraph.
 * For the 'current' layer, also applies What-If DSL if provided.
 * 
 * @param layerId - Layer ID: 'base', 'current', or a scenario ID
 * @param graph - Source graph
 * @param baseParams - Base parameters
 * @param currentParams - Current parameters
 * @param scenarios - All scenarios
 * @param visibleScenarioIds - Optional layer order
 * @param whatIfDSL - Optional What-If DSL to apply (only used for 'current' layer)
 * @returns Graph with the layer's composed parameters baked in
 */
export function buildGraphForLayer(
  layerId: string,
  graph: Graph,
  baseParams: ScenarioParams,
  currentParams: ScenarioParams,
  scenarios: ScenarioLike[],
  visibleScenarioIds?: string[],
  whatIfDSL?: string | null
): Graph {
  const composedParams = getComposedParamsForLayer(
    layerId,
    baseParams,
    currentParams,
    scenarios,
    visibleScenarioIds
  );
  let result = applyComposedParamsToGraph(graph, composedParams);
  
  // For 'current' layer, also apply What-If DSL if provided
  // (Scenario layers have their What-If already baked into their params at snapshot time)
  if (layerId === 'current' && whatIfDSL) {
    result = applyWhatIfToGraph(result, whatIfDSL);
  }
  
  return result;
}

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







