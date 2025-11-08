// Validation logic for conditional probabilities
import {
  Graph,
  GraphEdge,
  GraphNode,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  ConditionalProbability,
} from '../types';

// Tolerance for probability sum validation
const PROB_SUM_TOLERANCE = 0.001;

/**
 * Helper function to extract visited node IDs from a condition
 * Handles both old format {visited: [...]} and new string format "visited(node1, node2)"
 */
function getVisitedNodeIds(condition: any): string[] {
  if (!condition) return [];
  
  // Old format: {visited: [...]}
  if (typeof condition === 'object' && condition.visited && Array.isArray(condition.visited)) {
    return condition.visited;
  }
  
  // New format: string like "visited(node1, node2)" or "case(x).visited(y)"
  if (typeof condition === 'string') {
    const visited: string[] = [];
    // Match all visited(...) patterns
    const visitedRegex = /visited\(([^)]+)\)/g;
    let match;
    while ((match = visitedRegex.exec(condition)) !== null) {
      // Split by comma and trim
      const nodes = match[1].split(',').map(s => s.trim()).filter(s => s);
      visited.push(...nodes);
    }
    return visited;
  }
  
  return [];
}

/**
 * Validate conditional probabilities in the graph
 * Checks that probabilities sum to 1.0 for each possible condition state
 */
export function validateConditionalProbabilities(graph: Graph): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // For each node
  for (const node of graph.nodes) {
    const outgoingEdges = graph.edges.filter(e => e.from === node.id);
    
    if (outgoingEdges.length === 0) continue;

    // Check if this is a case node - validate by variant
    const isCaseNode = node.type === 'case' && node.case;
    if (isCaseNode) {
      // Group edges by variant
      const edgesByVariant = new Map<string, GraphEdge[]>();
      for (const edge of outgoingEdges) {
        if (edge.case_variant) {
          if (!edgesByVariant.has(edge.case_variant)) {
            edgesByVariant.set(edge.case_variant, []);
          }
          edgesByVariant.get(edge.case_variant)!.push(edge);
        }
      }
      
      // Validate base probability sum for each variant
      for (const [variantName, variantEdges] of edgesByVariant) {
        const variantProbSum = variantEdges.reduce((sum, edge) => sum + (edge.p?.mean ?? 0), 0);
        if (Math.abs(variantProbSum - 1.0) > PROB_SUM_TOLERANCE) {
          errors.push({
            type: 'probability_sum',
            nodeId: node.id,
            condition: `variant_${variantName}`,
            message: `Probability sum for variant "${variantName}" from case node "${node.id || node.id}" is ${variantProbSum.toFixed(3)}, expected 1.0`,
            sum: variantProbSum,
          });
        }
        
        // Also validate conditional probabilities for this variant
        const conditions = collectUniqueConditions(variantEdges, graph.nodes);
        for (const conditionNodeId of conditions) {
          let conditionNode = graph.nodes.find(n => n.id === conditionNodeId);
          if (!conditionNode) {
            conditionNode = graph.nodes.find(n => n.id === conditionNodeId);
          }
          if (!conditionNode) continue;
          
          const conditionNodeId = conditionNode.id;
          
          // Calculate conditional probability sum for this variant + condition
          const condProbSum = variantEdges.reduce((sum, edge) => {
            if (edge.conditional_p) {
              for (const cp of edge.conditional_p) {
                const resolvedConditionNodes = getVisitedNodeIds(cp.condition).map(ref => 
                  resolveNodeReference(ref, graph.nodes) || ref
                );
                if (resolvedConditionNodes.every(nodeId => nodeId === conditionNodeId)) {
                  return sum + (cp.p.mean ?? 0);
                }
              }
            }
            return sum + (edge.p?.mean ?? 0);
          }, 0);
          
          if (Math.abs(condProbSum - 1.0) > PROB_SUM_TOLERANCE) {
            errors.push({
              type: 'probability_sum',
              nodeId: node.id,
              condition: conditionNodeId,
              message: `Probability sum for variant "${variantName}" from case node "${node.id || node.id}" when "${conditionNode.id || conditionNodeId}" visited is ${condProbSum.toFixed(3)}, expected 1.0`,
              sum: condProbSum,
            });
          }
        }
      }
      
      // Skip regular validation for case nodes
      continue;
    }

    // Collect all unique conditions referenced by these edges
    const conditions = collectUniqueConditions(outgoingEdges, graph.nodes);

    // Validate base case (no conditions)
    const baseProbSum = calculateBaseProbabilitySum(outgoingEdges, graph.nodes);
    if (Math.abs(baseProbSum - 1.0) > PROB_SUM_TOLERANCE) {
      errors.push({
        type: 'probability_sum',
        nodeId: node.id,
        condition: 'base',
        message: `Base probability sum from node "${node.id || node.id}" is ${baseProbSum.toFixed(3)}, expected 1.0`,
        sum: baseProbSum,
      });
    }

    // Validate each condition
    for (const conditionNodeRef of conditions) {
      // Validate that condition node exists
      const conditionNode = graph.nodes.find(n => n.uuid === conditionNodeRef || n.id === conditionNodeRef);
      if (!conditionNode) {
        errors.push({
          type: 'missing_node',
          nodeId: node.uuid,
          condition: conditionNodeRef,
          message: `Condition references non-existent node: ${conditionNodeRef}`,
        });
        continue;
      }
      
      // Use the actual node UUID for further validation
      const conditionNodeId = conditionNode.uuid;

      // Validate that condition node is upstream
      if (!isUpstream(conditionNodeId, node.id, graph)) {
        errors.push({
          type: 'invalid_reference',
          nodeId: node.id,
          condition: conditionNodeId,
          message: `Condition references node "${conditionNode.id || conditionNodeId}" which is not upstream`,
        });
        continue;
      }

      // Validate probability sum for this condition
      const condProbSum = calculateConditionalProbabilitySum(
        outgoingEdges,
        [conditionNodeId],
        graph.nodes
      );
      
      if (Math.abs(condProbSum - 1.0) > PROB_SUM_TOLERANCE) {
        errors.push({
          type: 'probability_sum',
          nodeId: node.id,
          condition: conditionNodeId,
          message: `Probability sum from node "${node.id || node.id}" when "${conditionNode.id || conditionNodeId}" visited is ${condProbSum.toFixed(3)}, expected 1.0`,
          sum: condProbSum,
        });
      }
    }

    // Check for consistency warnings
    const edgesWithConditions = outgoingEdges.filter(e => e.conditional_p && e.conditional_p.length > 0);
    if (edgesWithConditions.length > 0 && edgesWithConditions.length < outgoingEdges.length) {
      warnings.push({
        type: 'incomplete_conditions',
        nodeId: node.id,
        message: `Some sibling edges from node "${node.id || node.id}" have conditions, others do not. Consider adding conditional_p to all siblings for consistency.`,
      });
    }
  }

  // Check for circular dependencies
  const circularErrors = checkCircularDependencies(graph);
  errors.push(...circularErrors);

  return {
    errors,
    warnings,
    isValid: errors.length === 0,
  };
}

/**
 * Resolve a node reference (ID or id) to a node ID
 */
function resolveNodeReference(nodeId: string, nodes: GraphNode[]): string | null {
  // Try ID first
  let node = nodes.find(n => n.id === nodeId);
  if (node) return node.id;
  
  // Try id
  node = nodes.find(n => n.id === nodeId);
  if (node) return node.id;
  
  return null;
}

/**
 * Collect all unique node IDs referenced in conditions across edges
 * Resolves IDs for consistency
 */
function collectUniqueConditions(edges: GraphEdge[], nodes: GraphNode[]): Set<string> {
  const conditions = new Set<string>();
  
  for (const edge of edges) {
    if (edge.conditional_p) {
      for (const cp of edge.conditional_p) {
        for (const nodeId of getVisitedNodeIds(cp.condition)) {
          const resolvedId = resolveNodeReference(nodeId, nodes);
          if (resolvedId) {
            conditions.add(resolvedId);
          }
        }
      }
    }
  }
  
  return conditions;
}

/**
 * Calculate base probability sum (when no conditions match)
 */
function calculateBaseProbabilitySum(edges: GraphEdge[], nodes: GraphNode[]): number {
  return edges.reduce((sum, edge) => {
    // For case edges, use variant weight
    if (edge.case_id && edge.case_variant) {
      const caseNode = nodes.find(n => n.case?.id === edge.case_id);
      const variant = caseNode?.case?.variants?.find(v => v.name === edge.case_variant);
      const variantWeight = variant?.weight || 0;
      const subRouteProb = edge.p?.mean ?? 1.0; // Default to 1.0 for single-path
      return sum + (variantWeight * subRouteProb);
    }
    
    // For normal edges, use base probability
    return sum + (edge.p?.mean ?? 0);
  }, 0);
}

/**
 * Calculate conditional probability sum for a specific set of visited nodes
 */
function calculateConditionalProbabilitySum(
  edges: GraphEdge[],
  visitedNodes: string[],
  nodes: GraphNode[]
): number {
  return edges.reduce((sum, edge) => {
    // Find matching conditional probability
    if (edge.conditional_p) {
      for (const cp of edge.conditional_p) {
        // Check if all nodes in condition are in visitedNodes (resolve ids to IDs)
        const resolvedConditionNodes = getVisitedNodeIds(cp.condition).map(ref => 
          resolveNodeReference(ref, nodes) || ref
        );
        const conditionMet = resolvedConditionNodes.every(nodeId => visitedNodes.includes(nodeId));
        
        if (conditionMet) {
        // For case edges, multiply variant weight by conditional probability
        if (edge.case_id && edge.case_variant) {
          const caseNode = nodes.find(n => n.case?.id === edge.case_id);
          const variant = caseNode?.case?.variants?.find(v => v.name === edge.case_variant);
            const variantWeight = variant?.weight || 0;
            const condProb = cp.p.mean ?? 1.0;
            return sum + (variantWeight * condProb);
          }
          
          // For normal edges, use conditional probability
          return sum + (cp.p.mean ?? 0);
        }
      }
    }
    
    // No matching condition, use base probability
    if (edge.case_id && edge.case_variant) {
      const caseNode = nodes.find(n => n.case?.id === edge.case_id);
      const variant = caseNode?.case?.variants?.find(v => v.name === edge.case_variant);
      const variantWeight = variant?.weight || 0;
      const subRouteProb = edge.p?.mean ?? 1.0;
      return sum + (variantWeight * subRouteProb);
    }
    
    return sum + (edge.p?.mean ?? 0);
  }, 0);
}

/**
 * Check if targetNode is upstream of sourceNode
 * Uses simple reachability check (BFS)
 */
function isUpstream(targetNodeId: string, sourceNodeId: string, graph: Graph): boolean {
  const visited = new Set<string>();
  const queue: string[] = [sourceNodeId];
  
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    
    // Find incoming edges to current node
    const incomingEdges = graph.edges.filter(e => e.to === currentId);
    
    for (const edge of incomingEdges) {
      if (edge.from === targetNodeId) {
        return true; // Found path from target to source (target is upstream)
      }
      queue.push(edge.from);
    }
  }
  
  return false;
}

/**
 * Check for circular dependencies in conditions
 */
function checkCircularDependencies(graph: Graph): ValidationError[] {
  const errors: ValidationError[] = [];
  
  for (const edge of graph.edges) {
    if (!edge.conditional_p) continue;
    
    for (const cp of edge.conditional_p) {
      for (const condNodeId of getVisitedNodeIds(cp.condition)) {
        // Check if there's a path from target node back to condition node
        // that uses edges with conditions dependent on the target node
        if (hasCircularDependency(edge.to, condNodeId, edge.from, graph, new Set())) {
          errors.push({
            type: 'circular_dependency',
            edgeId: edge.id,
            condition: condNodeId,
            message: `Circular dependency detected: edge condition depends on node that may depend on this edge's outcome`,
          });
        }
      }
    }
  }
  
  return errors;
}

/**
 * Check if there's a circular dependency between nodes
 */
function hasCircularDependency(
  fromNode: string,
  targetNode: string,
  originalNode: string,
  graph: Graph,
  visited: Set<string>
): boolean {
  if (visited.has(fromNode)) return false;
  visited.add(fromNode);
  
  // Find outgoing edges from current node
  const outgoingEdges = graph.edges.filter(e => e.from === fromNode);
  
  for (const edge of outgoingEdges) {
    // If edge has condition depending on original node, this is a problem
    if (edge.conditional_p) {
      for (const cp of edge.conditional_p) {
        if (getVisitedNodeIds(cp.condition).includes(originalNode)) {
          return true;
        }
      }
    }
    
    // If we reached the target node, check for dependency
    if (edge.to === targetNode) {
      return true;
    }
    
    // Recurse to next node
    if (hasCircularDependency(edge.to, targetNode, originalNode, graph, visited)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Get upstream nodes for a given edge (for condition selector)
 */
export function getUpstreamNodes(edgeFromNodeId: string, graph: Graph): GraphNode[] {
  const upstreamNodeIds = new Set<string>();
  const visited = new Set<string>();
  const queue: string[] = [edgeFromNodeId];
  
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    
    // Find incoming edges
    const incomingEdges = graph.edges.filter(e => e.to === currentId);
    
    for (const edge of incomingEdges) {
      upstreamNodeIds.add(edge.from);
      queue.push(edge.from);
    }
  }
  
  // Convert IDs to nodes
  return Array.from(upstreamNodeIds)
    .map(id => graph.nodes.find(n => n.id === id))
    .filter(Boolean) as GraphNode[];
}

/**
 * Evaluate which conditional probability applies for a given edge
 * Used by runner and what-if analysis
 */
export function getEffectiveProbability(
  edge: GraphEdge,
  visitedNodes: Set<string>,
  nodes: GraphNode[]
): number {
  // For case edges, multiply variant weight by probability
  if (edge.case_id && edge.case_variant) {
    const caseNode = nodes.find(n => n.case?.id === edge.case_id);
    const variant = caseNode?.case?.variants?.find(v => v.name === edge.case_variant);
    const variantWeight = variant?.weight || 0;
    
    // Check for conditional probability
    if (edge.conditional_p) {
      for (const cp of edge.conditional_p) {
        const conditionMet = getVisitedNodeIds(cp.condition).every(nodeId => visitedNodes.has(nodeId));
        if (conditionMet) {
          return variantWeight * (cp.p.mean ?? 1.0);
        }
      }
    }
    
    // Fall back to base probability
    return variantWeight * (edge.p?.mean ?? 1.0);
  }
  
  // For normal edges, check conditional probabilities
  if (edge.conditional_p) {
    for (const cp of edge.conditional_p) {
      const conditionMet = getVisitedNodeIds(cp.condition).every(nodeId => visitedNodes.has(nodeId));
      if (conditionMet) {
        return cp.p.mean ?? 0;
      }
    }
  }
  
  // Fall back to base probability
  return edge.p?.mean ?? 0;
}

