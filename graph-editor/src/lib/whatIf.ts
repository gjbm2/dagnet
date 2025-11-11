/**
 * Unified What-If Analysis Logic
 * 
 * Single source of truth for computing effective edge probabilities.
 * Handles both:
 * - Case variant what-ifs (node-driven)
 * - Conditional probability what-ifs (edge-driven)
 */

import { parseConstraints, evaluateConstraint } from './queryDSL';

export type WhatIfOverrides = {
  caseOverrides?: Record<string, string>;
  // Conditional edge overrides: edgeId -> forced visited nodes (hyperprior activation)
  conditionalOverrides?: Record<string, Set<string>>;
  // Version counter for triggering re-renders when overrides change
  _version?: number;
};

/**
 * Resolve a node reference (could be ID or id) to its actual ID
 */
export function resolveNodeRefToId(graph: any, ref: string): string {
  if (!graph?.nodes) return ref;
  
  // Try to find by UUID or ID
  const foundNode = graph.nodes.find((n: any) => n.uuid === ref || n.id === ref);
  if (foundNode) return foundNode.uuid;
  
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
  if (whatIfOverrides?.caseOverrides) {
    Object.entries(whatIfOverrides.caseOverrides).forEach(([caseNodeRef, selectedVariant]) => {
      // Find all edges from this case node with the selected variant
      graph.edges.forEach((edge: any) => {
        if (edge.case_id && edge.from) {
          const caseNode = graph.nodes.find((n: any) => n.uuid === edge.from && n.case?.id === edge.case_id);
          if (caseNode && (caseNode.uuid === caseNodeRef || caseNode.id === caseNodeRef) && edge.case_variant === selectedVariant) {
            visitedNodes.add(edge.to);
          }
        }
      });
    });
  }
  
  // Check legacy what-if system (backward compatibility)
  if (legacyWhatIfAnalysis?.caseNodeId && legacyWhatIfAnalysis?.selectedVariant) {
    // Find the case node to get its case.id
    const legacyCaseNode = graph.nodes.find((n: any) => n.uuid === legacyWhatIfAnalysis.caseNodeId || n.id === legacyWhatIfAnalysis.caseNodeId);
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
  
  // Find the edge in the graph (check both uuid and human-readable id after Phase 0.0 migration)
  const edge = graph.edges.find((e: any) => 
    e.uuid === edgeId ||           // ReactFlow uses UUID as edge ID
    e.id === edgeId ||             // Human-readable ID
    `${e.from}->${e.to}` === edgeId  // Fallback format
  );
  if (!edge) return 0;
  
  // Start with base probability
  let probability = edge.p?.mean ?? 0;
  
  // 1. Apply conditional probability override (EXPLICIT what-if)
  if (edge.conditional_p && edge.conditional_p.length > 0) {
    const override = whatIfOverrides?.conditionalOverrides?.[edgeId];
    
    if (override !== undefined) {
      // override is a Set<string> of forced visited nodes (hyperprior activation)
      // Find the conditional_p that matches these visited nodes
      for (const conditionalProb of edge.conditional_p) {
        // Skip old format conditions
        if (typeof conditionalProb.condition !== 'string') {
          continue;
        }
        
        // Parse condition to get visited nodes
        const parsed = parseConstraints(conditionalProb.condition);
        
        // Resolve all condition node references to IDs
        const conditionNodeIds = parsed.visited.map((ref: string) => 
          resolveNodeRefToId(graph, ref)
        );
        
        // Check if the override matches this condition (same set of nodes)
        // Note: For now, we only match on visited nodes. Full DSL evaluation would require
        // context and case information which isn't available in the override Set.
        const overrideArray = Array.from(override).sort();
        const conditionArray = conditionNodeIds.sort();
        
        if (JSON.stringify(overrideArray) === JSON.stringify(conditionArray)) {
          // Force this conditional probability to be active
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
      
      // Build context and case variant maps for evaluation
      // TODO: Extract from whatIfOverrides if we add context/case override support
      const context: Record<string, string> = {};
      const caseVariants: Record<string, string> = {};
      
      if (allVisitedNodes.size > 0 || Object.keys(context).length > 0 || Object.keys(caseVariants).length > 0) {
        for (const conditionalProb of edge.conditional_p) {
          // Skip old format conditions
          if (typeof conditionalProb.condition !== 'string') {
            continue;
          }
          
          // Use evaluateConstraint for full DSL evaluation (supports exclude, context, case)
          if (evaluateConstraint(conditionalProb.condition, allVisitedNodes, context, caseVariants)) {
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
      const newOverride = whatIfOverrides?.caseOverrides?.[caseNode.id];
      if (newOverride !== undefined) {
        variantWeight = edge.case_variant === newOverride ? 1.0 : 0.0;
      } else if (legacyWhatIfAnalysis && legacyWhatIfAnalysis.caseNodeId === caseNode.id) {
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
  
  // Find the edge in the graph (check both uuid and human-readable id after Phase 0.0 migration)
  const edge = graph.edges.find((e: any) => 
    e.uuid === edgeId ||           // ReactFlow uses UUID as edge ID
    e.id === edgeId ||             // Human-readable ID
    `${e.from}->${e.to}` === edgeId  // Fallback format
  );
  if (!edge) return null;
  
  // Check for conditional override (explicit or implicit)
  if (edge.conditional_p && edge.conditional_p.length > 0) {
    const override = whatIfOverrides?.conditionalOverrides?.[edgeId];
    
    if (override !== undefined) {
      // EXPLICIT override - override is Set<string> of forced visited nodes
      // Find the matching conditional probability
      let matchingProb = edge.p?.mean ?? 0;
      for (const conditionalProb of edge.conditional_p) {
        // Skip old format conditions
        if (typeof conditionalProb.condition !== 'string') {
          continue;
        }
        
        // Parse condition to get visited nodes
        const parsed = parseConstraints(conditionalProb.condition);
        
        // Resolve all condition node references to IDs
        const conditionNodeIds = parsed.visited.map((ref: string) => 
          resolveNodeRefToId(graph, ref)
        );
        
        // Check if the override matches this condition (same set of nodes)
        // Note: For now, we only match on visited nodes. Full DSL evaluation would require
        // context and case information which isn't available in the override Set.
        const overrideArray = Array.from(override).sort();
        const conditionArray = conditionNodeIds.sort();
        
        if (JSON.stringify(overrideArray) === JSON.stringify(conditionArray)) {
          matchingProb = conditionalProb.p?.mean ?? matchingProb;
          break;
        }
      }
      
      return {
        type: 'conditional',
        probability: matchingProb,
        isOverridden: true,
        displayLabel: '🔬 What-If'
      };
    } else {
      // IMPLICIT activation via case what-if (hyperprior)
      const implicitlyVisited = getImplicitlyVisitedNodes(graph, whatIfOverrides, legacyWhatIfAnalysis);
      
      // Build context and case variant maps for evaluation
      const context: Record<string, string> = {};
      const caseVariants: Record<string, string> = {};
      
      if (implicitlyVisited.size > 0 || Object.keys(context).length > 0 || Object.keys(caseVariants).length > 0) {
        for (const conditionalProb of edge.conditional_p) {
          // Skip old format conditions
          if (typeof conditionalProb.condition !== 'string') {
            continue;
          }
          
          // Use evaluateConstraint for full DSL evaluation (supports exclude, context, case)
          if (evaluateConstraint(conditionalProb.condition, implicitlyVisited, context, caseVariants)) {
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
      
      const newOverride = whatIfOverrides?.caseOverrides?.[caseNode.id];
      if (newOverride !== undefined) {
        variantWeight = edge.case_variant === newOverride ? 1.0 : 0.0;
        isOverridden = true;
      } else if (legacyWhatIfAnalysis && legacyWhatIfAnalysis.caseNodeId === caseNode.id) {
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

