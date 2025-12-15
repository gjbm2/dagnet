/**
 * useRemoveOverrides Hook
 * 
 * Centralized hook for counting and removing override flags from nodes and edges.
 * Used by EdgeContextMenu, NodeContextMenu, and DataMenu.
 */

import { useCallback, useMemo } from 'react';
import type { GraphData, GraphNode, GraphEdge, ProbabilityParam, CostParam, ConditionalProbability, CaseVariant, NodeImage } from '../types';
import { querySelectionUuids } from './useQuerySelectionUuids';
import { hasAnyEdgeQueryOverride, hasAnyOverriddenFlag } from '../utils/overrideFlags';

interface UseRemoveOverridesResult {
  /** Number of active overrides on the selected node/edge */
  overrideCount: number;
  /** Remove all overrides from the selected node/edge */
  removeOverrides: () => void;
  /** Whether there are any overrides to remove */
  hasOverrides: boolean;
}

interface UseRemoveOverridesOptions {
  /**
   * If true, operate on the current multi-selection (nodes + edges) rather than
   * just the single selected node/edge IDs passed in.
   *
   * Falls back to the single IDs if the graph canvas is not mounted or selection is empty.
   */
  includeMultiSelection?: boolean;
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
 * Clear all `_overridden` flags (recursively) from an object.
 *
 * This intentionally does NOT clear the underlying values, only the override markers.
 */
function clearAllOverriddenFlags(value: unknown, maxDepth = 6): void {
  if (maxDepth <= 0) return;
  if (!value || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const item of value) clearAllOverriddenFlags(item, maxDepth - 1);
    return;
  }

  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key.endsWith('_overridden')) {
      delete obj[key];
      continue;
    }
    const v = obj[key];
    if (v && typeof v === 'object') {
      clearAllOverriddenFlags(v, maxDepth - 1);
    }
  }
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

  // Catch-all for newer/less-centralised override flags (e.g. latency.*_overridden in future node fields)
  clearAllOverriddenFlags(node);
}

/**
 * Clear all overrides from an edge (mutates in place)
 */
function clearEdgeOverrides(edge: GraphEdge): void {
  // Direct edge overrides
  delete edge.description_overridden;
  delete edge.query_overridden;
  // `n_query` presence is treated as a query override in the UI, so "remove overrides" must clear it too.
  delete (edge as any).n_query_overridden;
  delete (edge as any).n_query;
  
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

  // Catch-all for newer/less-centralised override flags (e.g. latency.*_overridden, connection_overridden)
  clearAllOverriddenFlags(edge);
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
  edgeId?: string | null,
  options?: UseRemoveOverridesOptions
): UseRemoveOverridesResult {
  const includeMultiSelection = options?.includeMultiSelection === true;

  const selection = useMemo(() => {
    if (!includeMultiSelection) {
      return { selectedNodeUuids: [], selectedEdgeUuids: [] };
    }
    return querySelectionUuids();
  }, [includeMultiSelection]);

  const targetNodeIds = useMemo(() => {
    if (selection.selectedNodeUuids.length > 0) return selection.selectedNodeUuids;
    return nodeId ? [nodeId] : [];
  }, [selection.selectedNodeUuids, nodeId]);

  const targetEdgeIds = useMemo(() => {
    if (selection.selectedEdgeUuids.length > 0) return selection.selectedEdgeUuids;
    return edgeId ? [edgeId] : [];
  }, [selection.selectedEdgeUuids, edgeId]);

  // Find the selected node and edge
  const nodes = useMemo(() => {
    if (!graph || targetNodeIds.length === 0) return [];
    const ids = new Set(targetNodeIds);
    const graphNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    return graphNodes.filter(n => ids.has(n.uuid) || (n.id ? ids.has(n.id) : false));
  }, [graph, targetNodeIds]);

  const edges = useMemo(() => {
    if (!graph || targetEdgeIds.length === 0) return [];
    const ids = new Set(targetEdgeIds);
    const graphEdges = Array.isArray((graph as any).edges) ? (graph as any).edges : [];
    return graphEdges.filter((e: any) => ids.has(e.uuid) || (e.id ? ids.has(e.id) : false));
  }, [graph, targetEdgeIds]);
  
  // Count overrides
  const overrideCount = useMemo(() => {
    let count = 0;
    for (const n of nodes) count += countNodeOverrides(n);
    for (const e of edges) count += countEdgeOverrides(e);
    return count;
  }, [nodes, edges]);
  
  // Note: overrideCount intentionally counts a conservative subset (legacy behaviour used in menus/tests).
  // hasOverrides must reflect *any* override flags so the user can clear them reliably.
  const hasOverrides = useMemo(() => {
    if (overrideCount > 0) return true;
    if (nodes.some(n => hasAnyOverriddenFlag(n))) return true;
    if (edges.some(e => hasAnyOverriddenFlag(e) || hasAnyEdgeQueryOverride(e))) return true;
    return false;
  }, [overrideCount, nodes, edges]);
  
  // Remove all overrides - ALL LOGIC HERE, menu items just call this
  const removeOverrides = useCallback(() => {
    if (!graph || !hasOverrides) return;
    
    const nextGraph = structuredClone(graph);
    
    // Clear node overrides
    for (const id of targetNodeIds) {
      const nodeIndex = nextGraph.nodes.findIndex(n => n.uuid === id || n.id === id);
      if (nodeIndex >= 0) clearNodeOverrides(nextGraph.nodes[nodeIndex]);
    }
    
    // Clear edge overrides
    for (const id of targetEdgeIds) {
      const edgeIndex = nextGraph.edges.findIndex(e => e.uuid === id || e.id === id);
      if (edgeIndex >= 0) clearEdgeOverrides(nextGraph.edges[edgeIndex]);
    }
    
    // Update metadata
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    // ALWAYS call with history label for proper graph update and re-render
    // For multi-selection, avoid pinning to a single object id.
    const objectId = includeMultiSelection ? undefined : (targetEdgeIds[0] || targetNodeIds[0] || undefined);
    onUpdateGraph(nextGraph, 'Remove overrides', objectId);
  }, [graph, onUpdateGraph, targetNodeIds, targetEdgeIds, hasOverrides, includeMultiSelection]);
  
  return { overrideCount, hasOverrides, removeOverrides };
}

// Export counting functions for use elsewhere if needed
export { countNodeOverrides, countEdgeOverrides };

