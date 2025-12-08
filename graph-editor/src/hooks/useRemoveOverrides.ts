/**
 * useRemoveOverrides Hook
 * 
 * Centralized hook for counting and removing override flags from nodes and edges.
 * Used by EdgeContextMenu, NodeContextMenu, and DataMenu.
 */

import { useCallback, useMemo } from 'react';
import type { GraphData, GraphNode, GraphEdge, ProbabilityParam, CostParam, ConditionalProbability, CaseVariant, NodeImage } from '../types';

interface UseRemoveOverridesResult {
  /** Number of active overrides on the selected node/edge */
  overrideCount: number;
  /** Remove all overrides from the selected node/edge */
  removeOverrides: () => void;
  /** Whether there are any overrides to remove */
  hasOverrides: boolean;
}

/**
 * Count overrides on a ProbabilityParam
 */
function countProbabilityParamOverrides(p: ProbabilityParam | undefined): number {
  if (!p) return 0;
  let count = 0;
  if (p.mean_overridden) count++;
  if (p.stdev_overridden) count++;
  if (p.distribution_overridden) count++;
  return count;
}

/**
 * Count overrides on a CostParam
 */
function countCostParamOverrides(c: CostParam | undefined): number {
  if (!c) return 0;
  let count = 0;
  if (c.mean_overridden) count++;
  if (c.stdev_overridden) count++;
  if (c.distribution_overridden) count++;
  return count;
}

/**
 * Count overrides on a ConditionalProbability
 */
function countConditionalPOverrides(cp: ConditionalProbability | undefined): number {
  if (!cp) return 0;
  let count = 0;
  if (cp.query_overridden) count++;
  count += countProbabilityParamOverrides(cp.p);
  return count;
}

/**
 * Count overrides on a CaseVariant
 */
function countVariantOverrides(v: CaseVariant | undefined): number {
  if (!v) return 0;
  let count = 0;
  if (v.name_overridden) count++;
  if (v.weight_overridden) count++;
  if (v.description_overridden) count++;
  return count;
}

/**
 * Count overrides on a NodeImage
 */
function countImageOverrides(img: NodeImage | undefined): number {
  if (!img) return 0;
  let count = 0;
  if (img.caption_overridden) count++;
  return count;
}

/**
 * Count all overrides on a node
 */
function countNodeOverrides(node: GraphNode | undefined): number {
  if (!node) return 0;
  let count = 0;
  
  // Direct node overrides
  if (node.label_overridden) count++;
  if (node.description_overridden) count++;
  if (node.outcome_type_overridden) count++;
  if (node.event_id_overridden) count++;
  if (node.url_overridden) count++;
  if (node.images_overridden) count++;
  
  // Case overrides
  if (node.case) {
    if (node.case.status_overridden) count++;
    // Variant overrides
    if (node.case.variants) {
      for (const v of node.case.variants) {
        count += countVariantOverrides(v);
      }
    }
  }
  
  // Image caption overrides
  if (node.images) {
    for (const img of node.images) {
      count += countImageOverrides(img);
    }
  }
  
  return count;
}

/**
 * Count all overrides on an edge
 */
function countEdgeOverrides(edge: GraphEdge | undefined): number {
  if (!edge) return 0;
  let count = 0;
  
  // Direct edge overrides
  if (edge.description_overridden) count++;
  if (edge.query_overridden) count++;
  
  // Base probability overrides
  count += countProbabilityParamOverrides(edge.p);
  
  // Conditional probability overrides
  if (edge.conditional_p) {
    for (const cp of edge.conditional_p) {
      count += countConditionalPOverrides(cp);
    }
  }
  
  // Cost overrides
  count += countCostParamOverrides(edge.cost_gbp);
  count += countCostParamOverrides(edge.labour_cost);
  
  return count;
}

/**
 * Clear overrides from a ProbabilityParam (mutates in place)
 */
function clearProbabilityParamOverrides(p: ProbabilityParam | undefined): void {
  if (!p) return;
  delete p.mean_overridden;
  delete p.stdev_overridden;
  delete p.distribution_overridden;
}

/**
 * Clear overrides from a CostParam (mutates in place)
 */
function clearCostParamOverrides(c: CostParam | undefined): void {
  if (!c) return;
  delete c.mean_overridden;
  delete c.stdev_overridden;
  delete c.distribution_overridden;
}

/**
 * Clear overrides from a ConditionalProbability (mutates in place)
 */
function clearConditionalPOverrides(cp: ConditionalProbability | undefined): void {
  if (!cp) return;
  delete cp.query_overridden;
  clearProbabilityParamOverrides(cp.p);
}

/**
 * Clear overrides from a CaseVariant (mutates in place)
 */
function clearVariantOverrides(v: CaseVariant | undefined): void {
  if (!v) return;
  delete v.name_overridden;
  delete v.weight_overridden;
  delete v.description_overridden;
}

/**
 * Clear overrides from a NodeImage (mutates in place)
 */
function clearImageOverrides(img: NodeImage | undefined): void {
  if (!img) return;
  delete img.caption_overridden;
}

/**
 * Clear all overrides from a node (mutates in place)
 */
function clearNodeOverrides(node: GraphNode): void {
  // Direct node overrides
  delete node.label_overridden;
  delete node.description_overridden;
  delete node.outcome_type_overridden;
  delete node.event_id_overridden;
  delete node.url_overridden;
  delete node.images_overridden;
  
  // Case overrides
  if (node.case) {
    delete node.case.status_overridden;
    // Variant overrides
    if (node.case.variants) {
      for (const v of node.case.variants) {
        clearVariantOverrides(v);
      }
    }
  }
  
  // Image caption overrides
  if (node.images) {
    for (const img of node.images) {
      clearImageOverrides(img);
    }
  }
}

/**
 * Clear all overrides from an edge (mutates in place)
 */
function clearEdgeOverrides(edge: GraphEdge): void {
  // Direct edge overrides
  delete edge.description_overridden;
  delete edge.query_overridden;
  
  // Base probability overrides
  clearProbabilityParamOverrides(edge.p);
  
  // Conditional probability overrides
  if (edge.conditional_p) {
    for (const cp of edge.conditional_p) {
      clearConditionalPOverrides(cp);
    }
  }
  
  // Cost overrides
  clearCostParamOverrides(edge.cost_gbp);
  clearCostParamOverrides(edge.labour_cost);
}

/**
 * Hook to count and remove override flags from nodes and edges.
 * 
 * ALL LOGIC LIVES HERE - menu items just call removeOverrides()
 * 
 * @param graph - The current graph data
 * @param onUpdateGraph - Function to update the graph (MUST include history label for proper re-render)
 * @param nodeId - Optional node UUID to operate on
 * @param edgeId - Optional edge UUID to operate on
 * @returns Object with overrideCount, hasOverrides, and removeOverrides function
 */
export function useRemoveOverrides(
  graph: GraphData | null | undefined,
  onUpdateGraph: (graph: GraphData, historyLabel: string, objectId?: string) => void,
  nodeId?: string | null,
  edgeId?: string | null
): UseRemoveOverridesResult {
  // Find the selected node and edge
  const node = useMemo(() => {
    if (!graph || !nodeId) return undefined;
    return graph.nodes.find(n => n.uuid === nodeId || n.id === nodeId);
  }, [graph, nodeId]);
  
  const edge = useMemo(() => {
    if (!graph || !edgeId) return undefined;
    return graph.edges.find(e => e.uuid === edgeId || e.id === edgeId);
  }, [graph, edgeId]);
  
  // Count overrides
  const overrideCount = useMemo(() => {
    let count = 0;
    if (node) count += countNodeOverrides(node);
    if (edge) count += countEdgeOverrides(edge);
    return count;
  }, [node, edge]);
  
  const hasOverrides = overrideCount > 0;
  
  // Remove all overrides - ALL LOGIC HERE, menu items just call this
  const removeOverrides = useCallback(() => {
    if (!graph || !hasOverrides) return;
    
    const nextGraph = structuredClone(graph);
    
    // Clear node overrides
    if (nodeId) {
      const nodeIndex = nextGraph.nodes.findIndex(n => n.uuid === nodeId || n.id === nodeId);
      if (nodeIndex >= 0) {
        clearNodeOverrides(nextGraph.nodes[nodeIndex]);
      }
    }
    
    // Clear edge overrides
    if (edgeId) {
      const edgeIndex = nextGraph.edges.findIndex(e => e.uuid === edgeId || e.id === edgeId);
      if (edgeIndex >= 0) {
        clearEdgeOverrides(nextGraph.edges[edgeIndex]);
      }
    }
    
    // Update metadata
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    // ALWAYS call with history label for proper graph update and re-render
    onUpdateGraph(nextGraph, 'Remove overrides', edgeId || nodeId || undefined);
  }, [graph, onUpdateGraph, nodeId, edgeId, hasOverrides]);
  
  return { overrideCount, hasOverrides, removeOverrides };
}

// Export counting functions for use elsewhere if needed
export { countNodeOverrides, countEdgeOverrides };

