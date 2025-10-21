/**
 * Unified What-If Analysis Logic
 * 
 * Single source of truth for computing effective edge probabilities.
 * Handles both:
 * - Case variant what-ifs (node-driven)
 * - Conditional probability what-ifs (edge-driven)
 */

export type WhatIfOverrides = {
  caseOverrides: Map<string, string>;
  conditionalOverrides: Map<string, Set<string>>;
  _version: number;
};

/**
 * Resolve a node reference (could be ID or slug) to its actual ID
 */
export function resolveNodeRefToId(graph: any, ref: string): string {
  if (!graph?.nodes) return ref;
  
  // Try to find by ID first
  const byId = graph.nodes.find((n: any) => n.id === ref);
  if (byId) return byId.id;
  
  // Try to find by slug
  const bySlug = graph.nodes.find((n: any) => n.slug === ref);
  if (bySlug) return bySlug.id;
  
  // Return as-is if not found
  return ref;
}

/**
 * Determine which nodes would be implicitly visited based on active case what-ifs
 */
function getImplicitlyVisitedNodes(
  graph: any,
  whatIfOverrides: WhatIfOverrides,
  legacyWhatIfAnalysis?: { caseNodeId: string; selectedVariant: string } | null
): Set<string> {
  const visitedNodes = new Set<string>();
  
  if (!graph?.edges || !graph?.nodes) return visitedNodes;
  
  // Check new what-if system (caseOverrides)
  whatIfOverrides?.caseOverrides?.forEach((selectedVariant, caseNodeId) => {
    // Find all edges from this case node with the selected variant
    graph.edges.forEach((edge: any) => {
      if (edge.case_id && edge.from) {
        const caseNode = graph.nodes.find((n: any) => n.id === edge.from && n.case?.id === edge.case_id);
        if (caseNode?.id === caseNodeId && edge.case_variant === selectedVariant) {
          visitedNodes.add(edge.to);
        }
      }
    });
  });
  
  // Check legacy what-if system (backward compatibility)
  if (legacyWhatIfAnalysis?.caseNodeId && legacyWhatIfAnalysis?.selectedVariant) {
    // Find the case node to get its case.id
    const legacyCaseNode = graph.nodes.find((n: any) => n.id === legacyWhatIfAnalysis.caseNodeId);
    const legacyCaseId = legacyCaseNode?.case?.id;
    
    if (legacyCaseId) {
      graph.edges.forEach((edge: any) => {
        if (edge.case_id === legacyCaseId && 
            edge.case_variant === legacyWhatIfAnalysis.selectedVariant) {
          visitedNodes.add(edge.to);
        }
      });
    }
  }
  return visitedNodes;
}

/**
 * Compute the effective probability of an edge, accounting for:
 * - Base probability (edge.p.mean)
 * - Conditional probability overrides (explicit what-if)
 * - Conditional probability implicit activation (from case what-ifs)
 * - Conditional probability path-context activation (from path analysis through specific nodes)
 * - Case variant weights (if case edge)
 * - What-if overrides for both
 * 
 * This is the ONLY function that should determine an edge's effective probability.
 * 
 * @param givenVisitedNodes - Optional set of node IDs that are guaranteed to be visited in the current path context
 */
export function computeEffectiveEdgeProbability(
  graph: any,
  edgeId: string,
  whatIfOverrides: WhatIfOverrides,
  legacyWhatIfAnalysis?: { caseNodeId: string; selectedVariant: string } | null,
  givenVisitedNodes?: Set<string>
): number {
  if (!graph?.edges) return 0;
  
  // Find the edge in the graph
  const edge = graph.edges.find((e: any) => e.id === edgeId || `${e.from}->${e.to}` === edgeId);
  if (!edge) return 0;
  
  // Start with base probability
  let probability = edge.p?.mean ?? 0;
  
  // 1. Apply conditional probability override (EXPLICIT what-if)
  if (edge.conditional_p && edge.conditional_p.length > 0) {
    const override = whatIfOverrides?.conditionalOverrides?.get(edgeId);
    
    if (override && override.size > 0) {
      // Explicit override - find matching condition
      for (const conditionalProb of edge.conditional_p) {
        if (!conditionalProb?.condition?.visited) continue;
        
        // Resolve all condition node references to IDs
        const conditionNodeIds = conditionalProb.condition.visited.map((ref: string) => 
          resolveNodeRefToId(graph, ref)
        );
        
        // Check if override matches this condition
        const matches = conditionNodeIds.length === override.size &&
                       conditionNodeIds.every((nodeId: string) => override.has(nodeId));
        
        if (matches) {
          // Override the base probability with the conditional probability
          probability = conditionalProb.p?.mean ?? probability;
          break;
        }
      }
    } else {
      // IMPLICIT/CONTEXT activation: check if conditional is satisfied by:
      // 1. Case what-ifs (hyperpriors) OR
      // 2. Path analysis context (givenVisitedNodes)
      
      // Combine implicit (from case what-ifs) and explicit path context nodes
      const implicitlyVisited = getImplicitlyVisitedNodes(graph, whatIfOverrides, legacyWhatIfAnalysis);
      const allVisitedNodes = new Set([...implicitlyVisited, ...(givenVisitedNodes || [])]);
      
      if (allVisitedNodes.size > 0) {
        for (const conditionalProb of edge.conditional_p) {
          if (!conditionalProb?.condition?.visited) continue;
          
          // Resolve all condition node references to IDs
          const conditionNodeIds = conditionalProb.condition.visited.map((ref: string) => 
            resolveNodeRefToId(graph, ref)
          );
          
          // Check if ALL required nodes are visited (either implicitly or in path context)
          const allVisited = conditionNodeIds.length > 0 &&
                           conditionNodeIds.every((nodeId: string) => allVisitedNodes.has(nodeId));
          
          if (allVisited) {
            // Automatically apply conditional probability
            probability = conditionalProb.p?.mean ?? probability;
            break;
          }
        }
      }
    }
  }
  
  // 2. Apply case variant weight (if case edge)
  if (edge.case_id && edge.case_variant) {
    // Find the case node
    const caseNode = graph.nodes.find((n: any) => n.type === 'case' && n.case?.id === edge.case_id);
    
    if (caseNode?.case?.variants) {
      // Find the variant
      const variant = caseNode.case.variants.find((v: any) => v.name === edge.case_variant);
      let variantWeight = variant?.weight ?? 0;
      
      // Apply what-if override (new system first, then legacy)
      const newOverride = whatIfOverrides?.caseOverrides?.get(caseNode.id);
      if (newOverride !== undefined) {
        variantWeight = edge.case_variant === newOverride ? 1.0 : 0.0;
      } else if (legacyWhatIfAnalysis?.caseNodeId === caseNode.id) {
        variantWeight = edge.case_variant === legacyWhatIfAnalysis.selectedVariant ? 1.0 : 0.0;
      }
      
      // Multiply probability by variant weight
      probability = probability * variantWeight;
    }
  }
  
  return probability;
}

/**
 * Get display information for an edge's what-if override (for labels)
 */
export function getEdgeWhatIfDisplay(
  graph: any,
  edgeId: string,
  whatIfOverrides: WhatIfOverrides,
  legacyWhatIfAnalysis?: { caseNodeId: string; selectedVariant: string } | null
): { 
  type: 'none' | 'conditional' | 'case';
  probability: number;
  isOverridden: boolean;
  displayLabel?: string;
} | null {
  if (!graph?.edges) return null;
  
  const edge = graph.edges.find((e: any) => e.id === edgeId || `${e.from}->${e.to}` === edgeId);
  if (!edge) return null;
  
  // Check for conditional override (explicit or implicit)
  if (edge.conditional_p && edge.conditional_p.length > 0) {
    const override = whatIfOverrides?.conditionalOverrides?.get(edgeId);
    
    if (override && override.size > 0) {
      // EXPLICIT override
      for (const conditionalProb of edge.conditional_p) {
        if (!conditionalProb?.condition?.visited) continue;
        
        const conditionNodeIds = conditionalProb.condition.visited.map((ref: string) => 
          resolveNodeRefToId(graph, ref)
        );
        
        const matches = conditionNodeIds.length === override.size &&
                       conditionNodeIds.every((nodeId: string) => override.has(nodeId));
        
        if (matches) {
          return {
            type: 'conditional',
            probability: conditionalProb.p?.mean ?? 0,
            isOverridden: true,
            displayLabel: '🔬 What-If'
          };
        }
      }
    } else {
      // IMPLICIT activation via case what-if (hyperprior)
      const implicitlyVisited = getImplicitlyVisitedNodes(graph, whatIfOverrides, legacyWhatIfAnalysis);
      
      if (implicitlyVisited.size > 0) {
        for (const conditionalProb of edge.conditional_p) {
          if (!conditionalProb?.condition?.visited) continue;
          
          const conditionNodeIds = conditionalProb.condition.visited.map((ref: string) => 
            resolveNodeRefToId(graph, ref)
          );
          
          const allVisited = conditionNodeIds.length > 0 &&
                           conditionNodeIds.every((nodeId: string) => implicitlyVisited.has(nodeId));
          
          if (allVisited) {
            return {
              type: 'conditional',
              probability: conditionalProb.p?.mean ?? 0,
              isOverridden: true,
              displayLabel: '🔗 Auto' // Auto-applied due to case what-if
            };
          }
        }
      }
    }
  }
  
  // Check for case variant override
  if (edge.case_id && edge.case_variant) {
    const caseNode = graph.nodes.find((n: any) => n.type === 'case' && n.case?.id === edge.case_id);
    
    if (caseNode?.case?.variants) {
      const variant = caseNode.case.variants.find((v: any) => v.name === edge.case_variant);
      let variantWeight = variant?.weight ?? 0;
      let isOverridden = false;
      
      const newOverride = whatIfOverrides?.caseOverrides?.get(caseNode.id);
      if (newOverride !== undefined) {
        variantWeight = edge.case_variant === newOverride ? 1.0 : 0.0;
        isOverridden = true;
      } else if (legacyWhatIfAnalysis?.caseNodeId === caseNode.id) {
        variantWeight = edge.case_variant === legacyWhatIfAnalysis.selectedVariant ? 1.0 : 0.0;
        isOverridden = true;
      }
      
      const subRouteProbability = edge.p?.mean ?? 1.0;
      
      return {
        type: 'case',
        probability: variantWeight * subRouteProbability,
        isOverridden,
        displayLabel: isOverridden ? '🔬 What-If' : undefined
      };
    }
  }
  
  return null;
}

