/**
 * Graph Pruning and Renormalization
 * 
 * Shared logic for pruning graph edges and computing renormalization factors.
 * Used by:
 * - Path Analysis (user selects nodes A, C, E)
 * - What-If Analysis (user selects conditional overrides)
 * - Runner (applies overrides during simulation)
 * 
 * Algorithm:
 * 1. Identify forced/visited nodes (from what-if + path selection)
 * 2. Build sibling groups (nodes that share a parent)
 * 3. For each group, prune unselected siblings
 * 4. Calculate renormalization factors to redistribute pruned mass
 */

import { computeEffectiveEdgeProbability, WhatIfOverrides } from './whatIf';
import { parseConstraints } from './queryDSL';

export interface PruningResult {
  excludedEdges: Set<string>;
  renormFactors: Map<string, number>;
}

/**
 * Get nodes implied by case overrides
 * When a case variant is selected, all nodes reached by that variant are implied
 */
function getNodesImpliedByCaseOverrides(
  graph: any,
  caseOverrides: Record<string, string>
): Set<string> {
  const impliedNodes = new Set<string>();
  
  if (!graph?.edges || !graph?.nodes) return impliedNodes;
  
  Object.entries(caseOverrides).forEach(([caseNodeId, selectedVariant]) => {
    // Find all edges from this case node with the selected variant
    graph.edges.forEach((edge: any) => {
      if (edge.case_id && edge.from) {
        const caseNode = graph.nodes.find(
          (n: any) => (n.uuid === edge.from || n.id === edge.from) && n.case?.id === edge.case_id
        );
        if (caseNode?.id === caseNodeId && edge.case_variant === selectedVariant) {
          impliedNodes.add(edge.to);
        }
      }
    });
  });
  
  return impliedNodes;
}

/**
 * Get nodes implied by conditional overrides
 * When a conditional is selected, the visited nodes in that condition are implied
 */
function getNodesImpliedByConditionalOverrides(
  conditionalOverrides: Record<string, Set<string>>
): Set<string> {
  const impliedNodes = new Set<string>();
  
  Object.values(conditionalOverrides).forEach(visitedNodes => {
    visitedNodes.forEach(nodeId => impliedNodes.add(nodeId));
  });
  
  return impliedNodes;
}

/**
 * Compute graph pruning and renormalization factors
 * 
 * This is the SINGLE CODE PATH for all pruning/renormalization logic.
 * 
 * @param graph - The graph data
 * @param edges - ReactFlow edges (with computed data)
 * @param whatIfOverrides - What-if overrides containing whatIfDSL - ALWAYS applied
 * @param pathSelectedNodes - Additional nodes from quick selection (ONLY for Path Analysis panel)
 * @param pathStart - Start node of path (optional, for path analysis)
 * @param pathEnd - End node of path (optional, for path analysis)
 * 
 * @returns Excluded edges and renormalization factors
 * 
 * Usage:
 * - Edge width rendering: Pass whatIfOverrides only (no pathSelectedNodes)
 * - Path Analysis panel: Pass whatIfOverrides + pathSelectedNodes
 * - Runner: Pass whatIfOverrides + pathSelectedNodes
 */
export function computeGraphPruning(
  graph: any,
  edges: any[], // ReactFlow edges
  whatIfOverrides: WhatIfOverrides,
  pathSelectedNodes?: Set<string>,
  pathStart?: string,
  pathEnd?: string
): PruningResult {
  const excludedEdges = new Set<string>();
  const renormFactors = new Map<string, number>();
  
  if (!graph?.edges || !graph?.nodes) {
    return { excludedEdges, renormFactors };
  }
  
  // 1. Collect ALL forced visited nodes (what-if first, then path selection)
  const forcedNodes = new Set<string>();
  
  // From case overrides (what-if)
  const caseImpliedNodes = getNodesImpliedByCaseOverrides(graph, whatIfOverrides?.caseOverrides || {});
  caseImpliedNodes.forEach(nodeId => forcedNodes.add(nodeId));
  
  // From conditional overrides (what-if)
  // Handle both string (new DSL format) and Set<string> (backward compat) formats
  const conditionalOverrides = whatIfOverrides?.conditionalOverrides || {};
  const conditionalOverridesAsSets: Record<string, Set<string>> = {};
  Object.entries(conditionalOverrides).forEach(([edgeId, override]) => {
    if (override instanceof Set) {
      conditionalOverridesAsSets[edgeId] = override;
    } else if (typeof override === 'string') {
      // Parse DSL string to extract visited nodes
      const parsed = parseConstraints(override);
      conditionalOverridesAsSets[edgeId] = new Set(parsed.visited);
    }
  });
  const conditionalImpliedNodes = getNodesImpliedByConditionalOverrides(conditionalOverridesAsSets);
  conditionalImpliedNodes.forEach(nodeId => forcedNodes.add(nodeId));
  
  // From path selection (quick select), excluding start and end
  if (pathSelectedNodes && pathStart && pathEnd) {
    pathSelectedNodes.forEach(nodeId => {
      if (nodeId !== pathStart && nodeId !== pathEnd) {
        forcedNodes.add(nodeId);
      }
    });
  }
  
  console.log(`[Pruning] Forced nodes: ${Array.from(forcedNodes).join(', ')}`);
  
  if (forcedNodes.size === 0) {
    return { excludedEdges, renormFactors };
  }
  
  // 2. Build sibling groups (case variants and regular edges)
  const siblingGroups = new Map<string, { parent: string, siblings: string[], caseId?: string }>();
  
  edges.forEach(edge => {
    if (edge.data?.case_id) {
      // Case variant edges - group by case_id
      const key = `case_${edge.data.case_id}`;
      if (!siblingGroups.has(key)) {
        siblingGroups.set(key, { parent: edge.source, siblings: [], caseId: edge.data.case_id });
      }
      if (!siblingGroups.get(key)!.siblings.includes(edge.target)) {
        siblingGroups.get(key)!.siblings.push(edge.target);
      }
    } else {
      // Regular edges - group by parent
      const key = `parent_${edge.source}`;
      if (!siblingGroups.has(key)) {
        siblingGroups.set(key, { parent: edge.source, siblings: [] });
      }
      if (!siblingGroups.get(key)!.siblings.includes(edge.target)) {
        siblingGroups.get(key)!.siblings.push(edge.target);
      }
    }
  });
  
  // 3. Build set of ALL selected nodes (including path start and end)
  const allSelectedNodes = new Set<string>(forcedNodes);
  if (pathStart) allSelectedNodes.add(pathStart);
  if (pathEnd) allSelectedNodes.add(pathEnd);
  
  // 4. For each sibling group, prune unselected siblings and calculate renorm factors
  siblingGroups.forEach((group, key) => {
    if (group.siblings.length <= 1) return; // No siblings to prune
    
    // Check against ALL selected nodes (not just forced intermediates)
    // This allows paths to the end node even if it's not an interstitial
    const selectedSiblings = group.siblings.filter(id => allSelectedNodes.has(id));
    
    console.log(`[Pruning] Group ${key}: siblings=[${group.siblings}], selected=${selectedSiblings.length}/${group.siblings.length}`);
    
    // Only prune if some (but not all) siblings are selected
    if (selectedSiblings.length > 0 && selectedSiblings.length < group.siblings.length) {
      const unselectedSiblings = group.siblings.filter(id => !allSelectedNodes.has(id));
      
      // Get all edges in this sibling group
      const groupEdges = edges.filter(e => {
        if (group.caseId) {
          return e.data?.case_id === group.caseId && group.siblings.includes(e.target);
        } else {
          return e.source === group.parent && group.siblings.includes(e.target);
        }
      });
      
      let totalEffectiveProb = 0;
      let prunedEffectiveProb = 0;
      
      // Calculate effective probabilities (with what-if overrides applied)
      groupEdges.forEach(edge => {
        const effectiveProb = computeEffectiveEdgeProbability(
          graph, 
          edge.id, 
          whatIfOverrides
        );
        
        totalEffectiveProb += effectiveProb;
        
        if (unselectedSiblings.includes(edge.target)) {
          prunedEffectiveProb += effectiveProb;
          excludedEdges.add(edge.id);
          console.log(`[Pruning]   Exclude ${edge.id} (target=${edge.target}, effectiveProb=${effectiveProb})`);
        }
      });
      
      console.log(`[Pruning]   Total=${totalEffectiveProb}, Pruned=${prunedEffectiveProb}, Remaining=${totalEffectiveProb - prunedEffectiveProb}`);
      
      // Calculate renormalization factor
      const remainingEffectiveProb = totalEffectiveProb - prunedEffectiveProb;
      if (remainingEffectiveProb > 0 && totalEffectiveProb > 0) {
        const renormFactor = totalEffectiveProb / remainingEffectiveProb;
        console.log(`[Pruning]   RENORM FACTOR = ${renormFactor}`);
        
        groupEdges.forEach(edge => {
          if (!excludedEdges.has(edge.id)) {
            renormFactors.set(edge.id, renormFactor);
          }
        });
      }
    }
  });
  
  console.log(`[Pruning] Result: excluded=${excludedEdges.size} edges, renorm=${renormFactors.size} factors`);
  
  return { excludedEdges, renormFactors };
}

/**
 * Apply pruning and renormalization to an edge probability
 * 
 * @param edgeId - Edge ID
 * @param baseProb - Base probability (before pruning)
 * @param pruningResult - Result from computeGraphPruning
 * @returns Final probability after pruning/renormalization, or 0 if pruned
 */
export function applyPruningToEdgeProbability(
  edgeId: string,
  baseProb: number,
  pruningResult: PruningResult
): number {
  // If edge is pruned, return 0
  if (pruningResult.excludedEdges.has(edgeId)) {
    return 0;
  }
  
  // Apply renormalization factor if present
  const renormFactor = pruningResult.renormFactors.get(edgeId);
  if (renormFactor) {
    return baseProb * renormFactor;
  }
  
  return baseProb;
}

