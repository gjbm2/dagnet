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
