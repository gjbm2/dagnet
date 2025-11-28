/**
 * Generalized function to check if probability mass is unbalanced
 * 
 * Checks if probabilities sum to 1.0 within tolerance for:
 * - Regular edge probabilities (same source node)
 * - Conditional probabilities (same source node, same condition)
 * - Case variant weights (same case node)
 * 
 * @param items - Array of items with probability values
 * @param getProbability - Function to extract probability from item
 * @param tolerance - Tolerance for sum check (default 0.0001 = 4 decimal places)
 * @returns true if unbalanced (sum differs from 1.0 by more than tolerance)
 */
export function isProbabilityMassUnbalanced(
  items: any[],
  getProbability: (item: any) => number | undefined,
  tolerance: number = 0.0001  // 4 d.p. tolerance (0.01%) - handles floating point precision
): boolean {
  if (items.length <= 1) return false; // Need at least 2 items to be unbalanced
  
  const total = items.reduce((sum, item) => {
    const prob = getProbability(item);
    return sum + (prob || 0);
  }, 0);
  
  // Round to 4 decimal places to avoid floating-point precision issues
  // e.g., 0.333 + 0.333 + 0.334 might give 0.9999999999999999 instead of 1.0
  const roundedTotal = Math.round(total * 10000) / 10000;
  const diff = Math.abs(roundedTotal - 1);
  return diff > tolerance;
}

/**
 * Generalized function to calculate conditional probability imbalance map
 * 
 * Returns a map of conditionIndex -> isUnbalanced for all conditional probabilities
 * on an edge. Groups conditional probabilities by condition string and checks
 * if each group sums to 1.0 within tolerance.
 * 
 * @param graph - The graph object
 * @param selectedEdge - The edge being edited
 * @param localConditionalP - Local state of conditional probabilities (for immediate feedback)
 * @param tolerance - Tolerance for sum check (default 0.0001 = 4 decimal places)
 * @returns Map<conditionIndex, isUnbalanced>
 */
export function getConditionalProbabilityUnbalancedMap(
  graph: any,
  selectedEdge: any,
  localConditionalP: any[],
  tolerance: number = 0.0001  // 4 d.p. tolerance (0.01%) - handles floating point precision
): Map<number, boolean> {
  // Use localConditionalP if available (for immediate feedback), otherwise use selectedEdge.conditional_p
  const conditionalProbs = localConditionalP.length > 0 ? localConditionalP : (selectedEdge?.conditional_p || []);
  
  if (!selectedEdge || !graph?.edges || conditionalProbs.length === 0) {
    return new Map<number, boolean>();
  }
  
  const result = new Map<number, boolean>();
  const sourceNode = selectedEdge.from;
  
  // For each conditional probability on the selected edge
  conditionalProbs.forEach((condProb: any, condIndex: number) => {
    // Get the condition string (normalize it for comparison)
    const conditionStr = typeof condProb.condition === 'string' 
      ? condProb.condition 
      : '';
    
    if (!conditionStr) {
      result.set(condIndex, false);
      return;
    }
    
    // Find all sibling edges with the same condition
    const siblingsWithSameCondition = graph.edges.filter((e: any) => {
      if (e.from !== sourceNode) return false;
      if (!e.conditional_p || e.conditional_p.length === 0) return false;
      
      // Check if this edge has a conditional probability with the same condition
      return e.conditional_p.some((cp: any) => {
        const cpConditionStr = typeof cp.condition === 'string' ? cp.condition : '';
        return cpConditionStr === conditionStr;
      });
    });
    
    // For the selected edge, use localConditionalP value if available
    const selectedEdgeCondProb = condProb;
    
    // Build array of conditional probabilities with this condition (using local value for selected edge)
    const conditionalProbsForCondition = siblingsWithSameCondition.map((e: any) => {
      const isSelectedEdge = (e.uuid === selectedEdge.uuid) || (e.id === selectedEdge.id);
      if (isSelectedEdge) {
        return { p: { mean: selectedEdgeCondProb?.p?.mean || 0 } };
      }
      const matchingCond = e.conditional_p?.find((cp: any) => {
        const cpConditionStr = typeof cp.condition === 'string' ? cp.condition : '';
        return cpConditionStr === conditionStr;
      });
      return matchingCond || { p: { mean: 0 } };
    });
    
    result.set(condIndex, isProbabilityMassUnbalanced(
      conditionalProbsForCondition,
      (item: any) => item.p?.mean,
      tolerance
    ));
  });
  
  return result;
}
