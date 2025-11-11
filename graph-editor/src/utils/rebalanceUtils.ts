/**
 * Rebalances case variant weights when one variant changes
 */
export function rebalanceCaseVariants(
  variants: any[],
  currentIndex: number,
  newValue: number
): any[] {
  const currentValue = newValue;
  const remainingWeight = 1 - currentValue;
  
  // Create a copy of variants
  const rebalancedVariants = [...variants];
  
  // Ensure the current variant maintains its value
  rebalancedVariants[currentIndex] = {
    ...rebalancedVariants[currentIndex],
    weight: currentValue
  };
  
  // Calculate total current weight of other variants
  const otherVariants = variants.filter((v: any, i: number) => i !== currentIndex);
  const otherVariantsTotal = otherVariants.reduce((sum, variant) => sum + (variant.weight || 0), 0);
  
  if (otherVariantsTotal > 0) {
    // Rebalance other variants proportionally
    otherVariants.forEach(variant => {
      const variantIndex = rebalancedVariants.findIndex((v: any) => v.name === variant.name);
      if (variantIndex !== undefined && variantIndex >= 0) {
        const variantCurrentWeight = variant.weight || 0;
        const newWeight = (variantCurrentWeight / otherVariantsTotal) * remainingWeight;
        rebalancedVariants[variantIndex] = {
          ...rebalancedVariants[variantIndex],
          weight: newWeight
        };
      }
    });
  } else {
    // If other variants have no weight, distribute equally
    const equalShare = remainingWeight / otherVariants.length;
    otherVariants.forEach(variant => {
      const variantIndex = rebalancedVariants.findIndex((v: any) => v.name === variant.name);
      if (variantIndex !== undefined && variantIndex >= 0) {
        rebalancedVariants[variantIndex] = {
          ...rebalancedVariants[variantIndex],
          weight: equalShare
        };
      }
    });
  }
  
  return rebalancedVariants;
}

/**
 * Rebalances conditional probabilities when one condition changes
 */
export function rebalanceConditionalProbabilities(
  conditions: any[],
  currentIndex: number,
  newValue: number
): any[] {
  const currentValue = newValue;
  const remainingWeight = 1 - currentValue;
  
  // Create a copy of conditions
  const rebalancedConditions = [...conditions];
  
  // Ensure the current condition maintains its value
  rebalancedConditions[currentIndex] = {
    ...rebalancedConditions[currentIndex],
    p: { ...rebalancedConditions[currentIndex].p, mean: currentValue }
  };
  
  // Calculate total current weight of other conditions
  const otherConditions = conditions.filter((c: any, i: number) => i !== currentIndex);
  const otherConditionsTotal = otherConditions.reduce((sum, condition) => sum + (condition.p?.mean || 0), 0);
  
  if (otherConditionsTotal > 0) {
    // Rebalance other conditions proportionally
    otherConditions.forEach(condition => {
      const conditionIndex = rebalancedConditions.findIndex((c: any) => c.condition === condition.condition);
      if (conditionIndex !== undefined && conditionIndex >= 0) {
        const conditionCurrentWeight = condition.p?.mean || 0;
        const newWeight = (conditionCurrentWeight / otherConditionsTotal) * remainingWeight;
        rebalancedConditions[conditionIndex] = {
          ...rebalancedConditions[conditionIndex],
          p: { ...rebalancedConditions[conditionIndex].p, mean: newWeight }
        };
      }
    });
  } else {
    // If other conditions have no weight, distribute equally
    const equalShare = remainingWeight / otherConditions.length;
    otherConditions.forEach(condition => {
      const conditionIndex = rebalancedConditions.findIndex((c: any) => c.condition === condition.condition);
      if (conditionIndex !== undefined && conditionIndex >= 0) {
        rebalancedConditions[conditionIndex] = {
          ...rebalancedConditions[conditionIndex],
          p: { ...rebalancedConditions[conditionIndex].p, mean: equalShare }
        };
      }
    });
  }
  
  return rebalancedConditions;
}

/**
 * Finds and rebalances sibling parameters after a data update
 * 
 * Siblings are defined as:
 * 1. Direct edge siblings: Same parent node (for unconditional probabilities)
 * 2. Conditional probability variants: Same parent node, same condition query
 * 3. Case variants: Same case_id, different variant (handled separately)
 * 
 * Logic:
 * - Calculate total weight from overridden parameters
 * - Distribute remaining weight (1 - total_overridden) proportionally across non-overridden siblings
 * - Only updates parameters where _overridden is false
 * 
 * Example: A>B gets data (p=0.3), A has 3 children: B, C, D
 * - If A>C and A>D are not overridden, they get pro-rated: (1-0.3) split proportionally
 * - If A>C is overridden (p=0.5), then A>D gets: 1 - 0.3 - 0.5 = 0.2
 */
export function rebalanceSiblingParameters(
  graph: any,
  updatedEdgeId: string,
  updatedField: 'p' | 'conditional_p'
): any {
  const edge = graph.edges.find((e: any) => e.uuid === updatedEdgeId || e.id === updatedEdgeId);
  if (!edge) return graph;
  
  const nextGraph = structuredClone(graph);
  const edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === updatedEdgeId || e.id === updatedEdgeId);
  const targetEdge = nextGraph.edges[edgeIndex];
  
  // Case 1: Conditional probability variant updated
  if (updatedField === 'conditional_p' && targetEdge.conditional_p && targetEdge.conditional_p.length > 0) {
    // Group by condition query string - each group should sum to 1
    const conditionGroups = new Map<string, any[]>();
    
    targetEdge.conditional_p.forEach((cp: any) => {
      const condition = cp.condition || '';
      if (!conditionGroups.has(condition)) {
        conditionGroups.set(condition, []);
      }
      conditionGroups.get(condition)!.push(cp);
    });
    
    // Rebalance each condition group
    conditionGroups.forEach((group, condition) => {
      const overriddenEntries = group.filter((cp: any) => cp.p?.mean_overridden);
      const nonOverriddenEntries = group.filter((cp: any) => !cp.p?.mean_overridden && cp.p?.mean !== undefined);
      
      if (nonOverriddenEntries.length === 0) return; // Nothing to rebalance
      
      // Calculate total weight from overridden entries
      const overriddenTotal = overriddenEntries.reduce((sum: number, cp: any) => sum + (cp.p?.mean || 0), 0);
      const remainingWeight = 1 - overriddenTotal;
      
      // Calculate current total of non-overridden entries
      const nonOverriddenTotal = nonOverriddenEntries.reduce((sum: number, cp: any) => sum + (cp.p?.mean || 0), 0);
      
      // Pro-rate remaining weight across non-overridden entries
      if (nonOverriddenTotal > 0) {
        nonOverriddenEntries.forEach((cp: any) => {
          const currentWeight = cp.p?.mean || 0;
          const proportion = currentWeight / nonOverriddenTotal;
          cp.p.mean = proportion * remainingWeight;
        });
      } else {
        // Equal distribution if all non-overridden are zero
        const equalShare = remainingWeight / nonOverriddenEntries.length;
        nonOverriddenEntries.forEach((cp: any) => {
          if (!cp.p) cp.p = {};
          cp.p.mean = equalShare;
        });
      }
    });
  }
  
  // Case 2: Direct probability updated - rebalance sibling edges from same parent
  if (updatedField === 'p' && targetEdge.p?.mean !== undefined) {
    const sourceNodeId = targetEdge.from;
    
    // Find all edges from same parent (including the updated one)
    const allSiblings = nextGraph.edges.filter((e: any) => 
      e.from === sourceNodeId && 
      e.p?.mean !== undefined
    );
    
    if (allSiblings.length <= 1) return nextGraph; // No siblings to rebalance
    
    // Separate overridden from non-overridden
    const overriddenEdges = allSiblings.filter((e: any) => e.p.mean_overridden);
    // CRITICAL: Exclude the updated edge from non-overridden edges - it already has its correct value
    const nonOverriddenEdges = allSiblings.filter((e: any) => 
      !e.p.mean_overridden && 
      (e.uuid !== updatedEdgeId && e.id !== updatedEdgeId) // Exclude the updated edge
    );
    
    if (nonOverriddenEdges.length === 0) return nextGraph; // All are overridden or only the updated edge exists, nothing to do
    
    // Calculate total weight from overridden edges AND the updated edge
    // The updated edge's value is fixed and should be included in the total
    const updatedEdgeValue = targetEdge.p?.mean || 0;
    const overriddenTotal = overriddenEdges.reduce((sum: number, e: any) => sum + (e.p?.mean || 0), 0);
    const remainingWeight = Math.max(0, 1 - overriddenTotal - updatedEdgeValue); // Subtract updated edge value
    
    // Calculate current total of non-overridden edges (excluding updated edge)
    const nonOverriddenTotal = nonOverriddenEdges.reduce((sum: number, e: any) => sum + (e.p?.mean || 0), 0);
    
    // Pro-rate remaining weight across non-overridden edges (excluding updated edge)
    if (nonOverriddenTotal > 0) {
      nonOverriddenEdges.forEach((e: any) => {
        const edgeIndexToUpdate = nextGraph.edges.findIndex((edge: any) => 
          edge.uuid === e.uuid || edge.id === e.id
        );
        
        if (edgeIndexToUpdate >= 0) {
          const currentWeight = nextGraph.edges[edgeIndexToUpdate].p?.mean || 0;
          const proportion = currentWeight / nonOverriddenTotal;
          nextGraph.edges[edgeIndexToUpdate].p.mean = proportion * remainingWeight;
        }
      });
    } else {
      // Equal distribution if all non-overridden edges have zero weight
      const equalShare = remainingWeight / nonOverriddenEdges.length;
      nonOverriddenEdges.forEach((e: any) => {
        const edgeIndexToUpdate = nextGraph.edges.findIndex((edge: any) => 
          edge.uuid === e.uuid || edge.id === e.id
        );
        
        if (edgeIndexToUpdate >= 0) {
          nextGraph.edges[edgeIndexToUpdate].p.mean = equalShare;
        }
      });
    }
  }
  
  // Case 3: Case variant updated - handled separately by case logic
  // (This would be in a different code path, as case variants are on nodes, not edges)
  
  return nextGraph;
}

/**
 * Rebalances edge probabilities when one edge changes
 */
export function rebalanceEdgeProbabilities(
  edges: any[],
  currentEdgeId: string,
  newValue: number,
  sourceNodeId: string
): any[] {
  const currentValue = newValue;
  const remainingWeight = 1 - currentValue;
  
  // Create a copy of edges
  const rebalancedEdges = [...edges];
  
  // Find and update the current edge
  const currentEdgeIndex = rebalancedEdges.findIndex(e => e.id === currentEdgeId);
  if (currentEdgeIndex >= 0) {
    rebalancedEdges[currentEdgeIndex] = {
      ...rebalancedEdges[currentEdgeIndex],
      p: { ...rebalancedEdges[currentEdgeIndex].p, mean: currentValue }
    };
  }
  
  // Find sibling edges (same source)
  const siblingEdges = edges.filter(e => e.from === sourceNodeId && e.id !== currentEdgeId);
  const siblingTotal = siblingEdges.reduce((sum, edge) => sum + (edge.p?.mean || 0), 0);
  
  if (siblingTotal > 0) {
    // Rebalance sibling edges proportionally
    siblingEdges.forEach(edge => {
      const edgeIndex = rebalancedEdges.findIndex(e => e.id === edge.id);
      if (edgeIndex >= 0) {
        const edgeCurrentWeight = edge.p?.mean || 0;
        const newWeight = (edgeCurrentWeight / siblingTotal) * remainingWeight;
        rebalancedEdges[edgeIndex] = {
          ...rebalancedEdges[edgeIndex],
          p: { ...rebalancedEdges[edgeIndex].p, mean: newWeight }
        };
      }
    });
  } else {
    // If siblings have no weight, distribute equally
    const equalShare = remainingWeight / siblingEdges.length;
    siblingEdges.forEach(edge => {
      const edgeIndex = rebalancedEdges.findIndex(e => e.id === edge.id);
      if (edgeIndex >= 0) {
        rebalancedEdges[edgeIndex] = {
          ...rebalancedEdges[edgeIndex],
          p: { ...rebalancedEdges[edgeIndex].p, mean: equalShare }
        };
      }
    });
  }
  
  return rebalancedEdges;
}
