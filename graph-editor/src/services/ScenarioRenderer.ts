/**
 * ScenarioRenderer
 * 
 * Renders scenario overlays with correct colors, widths, and offsets.
 * Handles composition of parameters and computation of edge rendering data.
 */

import { Graph, GraphEdge } from '../types';
import { Scenario, ScenarioParams } from '../types/scenarios';
import { composeParams } from './CompositionService';
import { assignColors } from './ColorAssigner';

/**
 * Rendering data for a single scenario overlay
 */
export interface ScenarioRenderData {
  scenarioId: string;
  name: string;
  color: string;
  edges: ScenarioEdgeRenderData[];
}

/**
 * Rendering data for a single edge within a scenario
 */
export interface ScenarioEdgeRenderData {
  edgeId: string;
  edgeUuid: string;
  width: number;
  sourceOffset: number;
  targetOffset: number;
  // Path data will be computed by the renderer using existing geometry
}

/**
 * Render scenarios for the given graph and tab state
 * 
 * @param graph - Current graph
 * @param baseParams - Base parameter state
 * @param scenarios - All scenarios (visible and hidden)
 * @param visibleScenarioIds - IDs of visible scenarios (in render order)
 * @param visibleColorOrderIds - IDs in activation order (for color assignment)
 * @returns Array of render data for each visible scenario
 */
export function renderScenarios(
  graph: Graph,
  baseParams: ScenarioParams,
  scenarios: Scenario[],
  visibleScenarioIds: string[],
  visibleColorOrderIds: string[]
): ScenarioRenderData[] {
  // Assign colors based on activation order
  const colorMap = assignColors(visibleScenarioIds, visibleColorOrderIds);
  
  const renderData: ScenarioRenderData[] = [];
  
  // Render each visible scenario
  for (const scenarioId of visibleScenarioIds) {
    const scenario = scenarios.find(s => s.id === scenarioId);
    if (!scenario) continue;
    
    const color = colorMap.get(scenarioId) || scenario.color;
    
    // For each scenario, we need to:
    // 1. Compose params up to this layer (Base + all overlays up to and including this one)
    // 2. Compute edge widths using composed params
    // 3. Compute Sankey offsets
    
    // Get all scenarios up to and including this one (in render order)
    const layersUpToThis = visibleScenarioIds
      .slice(0, visibleScenarioIds.indexOf(scenarioId) + 1)
      .map(id => scenarios.find(s => s.id === id))
      .filter((s): s is Scenario => s !== undefined);
    
    // Compose parameters
    const overlays = layersUpToThis.map(s => s.params);
    const composedParams = composeParams(baseParams, overlays);
    
    // Compute edge render data
    const edgeRenderData = computeEdgeRenderData(graph, composedParams);
    
    renderData.push({
      scenarioId,
      name: scenario.name,
      color,
      edges: edgeRenderData
    });
  }
  
  return renderData;
}

/**
 * Compute render data for all edges using the given parameters
 * 
 * This computes widths and Sankey offsets for each edge.
 * The actual path geometry will be computed by the renderer using existing control points.
 */
function computeEdgeRenderData(
  graph: Graph,
  params: ScenarioParams
): ScenarioEdgeRenderData[] {
  if (!graph.edges || graph.edges.length === 0) {
    return [];
  }
  
  const renderData: ScenarioEdgeRenderData[] = [];
  
  // For each edge, compute its width based on the composed parameters
  for (const edge of graph.edges) {
    // Get edge parameters from composed params
    const edgeParams = params.edges?.[edge.uuid];
    
    // Compute edge width
    // TODO: This needs to use the actual edge width calculation logic from the graph renderer
    // For now, use a simple fallback
    const width = computeEdgeWidth(edge, edgeParams);
    
    // Compute Sankey offsets
    // TODO: Implement proper Sankey offset calculation
    // For now, use simple placeholders
    const sourceOffset = 0;
    const targetOffset = 0;
    
    renderData.push({
      edgeId: edge.id || edge.uuid,
      edgeUuid: edge.uuid,
      width,
      sourceOffset,
      targetOffset
    });
  }
  
  return renderData;
}

/**
 * Compute edge width from parameters
 * 
 * This is a simplified version. In production, this should use the same
 * logic as the main graph renderer (calculateEdgeWidth).
 */
function computeEdgeWidth(edge: GraphEdge, edgeParams: any): number {
  // Default width if no params
  if (!edgeParams) {
    return edge.width || 2;
  }
  
  // Use weight_default if available
  if (edgeParams.weight_default !== undefined) {
    // Scale weight to width (adjust scaling factor as needed)
    return Math.max(0.5, edgeParams.weight_default * 10);
  }
  
  // Use probability mean if available
  if (edgeParams.p?.mean !== undefined) {
    return Math.max(0.5, edgeParams.p.mean * 10);
  }
  
  // Fallback to edge's current width
  return edge.width || 2;
}

/**
 * Compute Sankey offsets for a node's edges
 * 
 * This needs to distribute edges vertically at the source/target nodes
 * to avoid overlaps in Sankey diagrams.
 * 
 * TODO: Implement proper Sankey offset calculation
 */
function computeSankeyOffsets(
  graph: Graph,
  nodeId: string,
  direction: 'source' | 'target',
  params: ScenarioParams
): Map<string, number> {
  const offsets = new Map<string, number>();
  
  // Find all edges connected to this node
  const edges = graph.edges?.filter(e => 
    direction === 'source' ? e.from === nodeId : e.to === nodeId
  ) || [];
  
  // For now, just stack them evenly
  // TODO: Implement proper stacking based on weights/flows
  let currentOffset = 0;
  for (const edge of edges) {
    offsets.set(edge.uuid, currentOffset);
    const width = computeEdgeWidth(edge, params.edges?.[edge.uuid]);
    currentOffset += width;
  }
  
  return offsets;
}

/**
 * Check if a scenario overlay should be rendered for a given edge
 * 
 * Handles fail-gracefully rules when graph has changed since snapshot.
 */
export function shouldRenderEdge(
  edge: GraphEdge,
  scenarioParams: ScenarioParams
): boolean {
  // If edge doesn't exist in scenario params, skip it
  // (let base layer handle it)
  if (!scenarioParams.edges?.[edge.uuid]) {
    return false;
  }
  
  return true;
}

/**
 * Memoization cache for composed parameters
 * 
 * Key: hash of (baseParams + overlays)
 * Value: composed ScenarioParams
 */
const compositionCache = new Map<string, ScenarioParams>();

/**
 * Get a cache key for composition memoization
 */
function getCompositionCacheKey(
  baseParams: ScenarioParams,
  overlays: ScenarioParams[]
): string {
  // Simple hash using JSON stringify
  // TODO: Use a better hash function for production
  return JSON.stringify({ base: baseParams, overlays });
}

/**
 * Clear the composition cache
 * Call this when the graph structure changes
 */
export function clearCompositionCache(): void {
  compositionCache.clear();
}

