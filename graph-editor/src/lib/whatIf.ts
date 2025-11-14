/**
 * Unified What-If Analysis Logic
 * 
 * Single source of truth for computing effective edge probabilities.
 * Handles both:
 * - Case variant what-ifs (node-driven)
 * - Conditional probability what-ifs (edge-driven)
 */

import { parseConstraints, evaluateConstraint, normalizeConstraintString, parseDSL } from './queryDSL';

export type WhatIfOverrides = {
  caseOverrides?: Record<string, string>;
  // Conditional edge overrides: edgeId -> normalized condition string (e.g., "visited(node-a)")
  // Supports both string (new) and Set<string> (backward compat) formats
  conditionalOverrides?: Record<string, string | Set<string>>;
  // NEW: Unified DSL string (e.g., "case(case_id:treatment).visited(nodea)")
  // If provided, this takes precedence and will be parsed to populate caseOverrides/conditionalOverrides
  whatIfDSL?: string | null;
  // Version counter for triggering re-renders when overrides change
  _version?: number;
};

/**
 * What-If DSL string format (new unified approach)
 * Example: "case(case_id:treatment).visited(nodea).exclude(nodeb)"
 */
export type WhatIfDSL = string | null;

/**
 * Parse a what-if DSL string into separate override objects (for backward compatibility).
 * 
 * @param dsl - DSL string (e.g., "case(case_id:treatment).visited(nodea)")
 * @param graph - Graph object (for resolving node references)
 * @returns Object with caseOverrides and conditionalOverrides
 */
export function parseWhatIfDSL(dsl: WhatIfDSL, graph?: any): WhatIfOverrides {
  if (!dsl || !dsl.trim()) {
    return { caseOverrides: {}, conditionalOverrides: {} };
  }
  
  const parsed = parseDSL(dsl);
  const caseOverrides: Record<string, string> = {};
  const conditionalOverrides: Record<string, string> = {};
  
  // Extract case overrides from case() functions
  // Format: case(case_id:variant) or case(node_id:variant)
  parsed.cases.forEach(({key, value}) => {
    if (graph) {
      // Try to find case node by case.id or node ID/UUID
      const caseNode = graph.nodes?.find((n: any) => 
        n.type === 'case' && (
          n.case?.id === key || 
          n.uuid === key || 
          n.id === key
        )
      );
      
      if (caseNode) {
        // IMPORTANT: use the graph node ID as the key, because all later lookups
        // (e.g. in computeEffectiveEdgeProbability / getEdgeWhatIfDisplay) use caseNode.id
        const nodeIdKey = caseNode.id || caseNode.uuid;
        if (nodeIdKey) {
          caseOverrides[nodeIdKey] = value;
        }
      }
    } else {
      // Without graph, use key as-is (assumes it's a node ID)
      caseOverrides[key] = value;
    }
  });
  
  // Extract conditional overrides from visited/exclude functions
  // For now, we'll create a normalized condition string
  // In the future, we might want to map this to specific edges
  if (parsed.visited.length > 0 || parsed.exclude.length > 0) {
    const conditionString = normalizeConstraintString(dsl);
    // For now, we'll need to match this against edges' conditional_p conditions
    // This is a simplified approach - in practice, you might want to store edge-specific mappings
    if (graph?.edges) {
      graph.edges.forEach((edge: any) => {
        if (edge.conditional_p && edge.conditional_p.length > 0) {
          // Check if any conditional_p condition matches this DSL
          const matches = edge.conditional_p.some((cp: any) => {
            if (typeof cp.condition !== 'string') return false;
            const edgeCondition = normalizeConstraintString(cp.condition);
            return edgeCondition === conditionString;
          });
          
          if (matches) {
            const edgeId = edge.uuid || edge.id || `${edge.from}->${edge.to}`;
            conditionalOverrides[edgeId] = conditionString;
          }
        }
      });
    }
  }
  
  return { caseOverrides, conditionalOverrides };
}

/**
 * Convert old override format to DSL string (for backward compatibility).
 * 
 * @param caseOverrides - Case overrides object
 * @param conditionalOverrides - Conditional overrides object
 * @param graph - Graph object (for resolving node references)
 * @returns DSL string
 */
export function convertOverridesToDSL(
  caseOverrides: Record<string, string> | undefined,
  conditionalOverrides: Record<string, string | Set<string>> | undefined,
  graph?: any
): WhatIfDSL {
  const parts: string[] = [];
  
  // Convert case overrides to case() functions
  if (caseOverrides) {
    Object.entries(caseOverrides).forEach(([nodeRef, variant]) => {
      if (graph) {
        const caseNode = graph.nodes?.find((n: any) => 
          n.type === 'case' && (n.uuid === nodeRef || n.id === nodeRef)
        );
        if (caseNode?.case?.id) {
          parts.push(`case(case_id:${variant})`);
        } else {
          parts.push(`case(${nodeRef}:${variant})`);
        }
      } else {
        parts.push(`case(${nodeRef}:${variant})`);
      }
    });
  }
  
  // Convert conditional overrides to visited/exclude functions
  if (conditionalOverrides) {
    const visitedNodes = new Set<string>();
    const excludeNodes = new Set<string>();
    
    Object.values(conditionalOverrides).forEach(override => {
      if (typeof override === 'string') {
        const parsed = parseConstraints(override);
        parsed.visited.forEach(v => visitedNodes.add(v));
        parsed.exclude.forEach(e => excludeNodes.add(e));
      } else if (override instanceof Set) {
        override.forEach(v => visitedNodes.add(v));
      }
    });
    
    if (visitedNodes.size > 0) {
      parts.push(`visited(${Array.from(visitedNodes).sort().join(', ')})`);
    }
    if (excludeNodes.size > 0) {
      parts.push(`exclude(${Array.from(excludeNodes).sort().join(', ')})`);
    }
  }
  
  return parts.length > 0 ? parts.join('.') : null;
}

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
  whatIfOverrides: WhatIfOverrides
): Set<string> {
  const visitedNodes = new Set<string>();
  
  if (!graph?.edges || !graph?.nodes) return visitedNodes;
  
  // Check what-if case overrides
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
  
  // Parse DSL to get overrides
  const parsed = parseWhatIfDSL(whatIfOverrides?.whatIfDSL ?? null, graph);
  const effectiveOverrides = {
    caseOverrides: parsed.caseOverrides,
    conditionalOverrides: parsed.conditionalOverrides
  };
  
  // Start with base probability
  let probability = edge.p?.mean ?? 0;
  
  // 1. Apply conditional probability override (EXPLICIT what-if)
  if (edge.conditional_p && edge.conditional_p.length > 0) {
    const override = effectiveOverrides?.conditionalOverrides?.[edgeId];
    
    if (override !== undefined && typeof override === 'string') {
      // Override is a normalized condition string (e.g., "visited(node-a)")
      // Match it directly against the edge's conditional_p conditions
      for (const conditionalProb of edge.conditional_p) {
        if (typeof conditionalProb.condition !== 'string') continue;
        const normalizedCond = normalizeConstraintString(conditionalProb.condition);
        if (normalizedCond === override) {
          probability = conditionalProb.p?.mean ?? probability;
          break;
        }
      }
    } else {
      // IMPLICIT/CONTEXT activation: check if conditional is satisfied by:
      // 1. Case what-ifs (hyperpriors) OR
      // 2. Path analysis context (givenVisitedNodes)
      
      // Combine implicit (from case what-ifs) and explicit path context nodes
      const implicitlyVisited = getImplicitlyVisitedNodes(graph, effectiveOverrides);
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
  // Case edges can have case_variant set, and we infer case_id from the source node if missing
  if (edge.case_variant) {
    // Infer case_id from source node if not set
    let caseId = edge.case_id;
    if (!caseId) {
      const sourceNode = graph.nodes.find((n: any) => n.uuid === edge.from || n.id === edge.from);
      if (sourceNode?.type === 'case') {
        caseId = sourceNode.case?.id || sourceNode.uuid || sourceNode.id;
      }
    }
    
    if (caseId) {
      // Find the case node (check case.id, uuid, or id)
      const caseNode = graph.nodes.find((n: any) => 
        n.type === 'case' && (
          n.case?.id === caseId || 
          n.uuid === caseId || 
          n.id === caseId
        )
      );
      
      if (caseNode?.case?.variants) {
        // Find the variant
        const variant = caseNode.case.variants.find((v: any) => v.name === edge.case_variant);
        let variantWeight = variant?.weight ?? 0;
        
        // Apply what-if override
        const override = effectiveOverrides?.caseOverrides?.[caseNode.id];
        if (override !== undefined) {
          variantWeight = edge.case_variant === override ? 1.0 : 0.0;
        }
        
        // Multiply probability by variant weight
        probability = probability * variantWeight;
      }
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
  _unused?: null
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
  
  // Parse DSL to get overrides
  const parsed = parseWhatIfDSL(whatIfOverrides?.whatIfDSL ?? null, graph);
  const effectiveOverrides = {
    caseOverrides: parsed.caseOverrides,
    conditionalOverrides: parsed.conditionalOverrides
  };
  
  // Check for conditional override (explicit or implicit)
  if (edge.conditional_p && edge.conditional_p.length > 0) {
    const override = effectiveOverrides?.conditionalOverrides?.[edgeId];
    
    if (override !== undefined) {
      // Override is now a normalized condition string (e.g., "visited(node-a)")
      // Match it directly against the edge's conditional_p conditions
      const overrideCondition = typeof override === 'string' ? override : null;
      
      let matchingProb = edge.p?.mean ?? 0;
      
      if (overrideCondition) {
        // New format: match condition string directly
        for (const conditionalProb of edge.conditional_p) {
          if (typeof conditionalProb.condition !== 'string') continue;
          const normalizedCond = normalizeConstraintString(conditionalProb.condition);
          if (normalizedCond === overrideCondition) {
            matchingProb = conditionalProb.p?.mean ?? matchingProb;
            break;
          }
        }
      } else {
        // Backward compatibility: override is Set<string> of visited nodes
        const overrideSet = override instanceof Set ? override : new Set(Array.isArray(override) ? override : []);
        const context: Record<string, string> = {};
        const caseVariants: Record<string, string> = {};
        
        for (const conditionalProb of edge.conditional_p) {
          if (typeof conditionalProb.condition !== 'string') continue;
          if (evaluateConstraint(conditionalProb.condition, overrideSet, context, caseVariants)) {
            matchingProb = conditionalProb.p?.mean ?? matchingProb;
            break;
          }
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
      const implicitlyVisited = getImplicitlyVisitedNodes(graph, effectiveOverrides);
      
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
      
      const override = effectiveOverrides?.caseOverrides?.[caseNode.id];
      if (override !== undefined) {
        variantWeight = edge.case_variant === override ? 1.0 : 0.0;
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

