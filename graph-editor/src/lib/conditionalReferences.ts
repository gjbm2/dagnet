/**
 * Utility functions for creating stable, unambiguous references to conditional probabilities.
 * 
 * Reference Format:
 * - Base probability: e.<edge-id>.p.mean
 * - Conditional probability (old): e.<edge-id>.visited(<node-id-1>,<node-id-2>).p.mean
 * - Conditional probability (new): e.<edge-id>.<normalized-constraint-string>.p.mean
 * 
 * Examples:
 * - e.gives-bd-to-stops-switch.p.mean
 * - e.gives-bd-to-stops-switch.visited(coffee_promotion).p.mean (old format, still supported)
 * - e.gives-bd-to-stops-switch.visited(coffee_promotion,email_promo).p.stdev (old format)
 * - e.edge-id.visited(promo).exclude(cart).p.mean (new format)
 * - e.edge-id.context(device:mobile).p.mean (new format)
 * 
 * Note: Uses human-readable IDs (edge.id, node.id), not system UUIDs
 */

import type { GraphEdge, ConditionalProbability, Graph } from '../types';
import { normalizeConstraintString, parseConstraints, getVisitedNodeIds } from './queryDSL';

/**
 * Generate a stable reference for a conditional probability parameter.
 * 
 * @param edgeId - The edge ID (human-readable, e.g., "gives-bd-to-stops-switch")
 * @param constraintString - The normalized constraint string (e.g., "visited(promo).exclude(cart)")
 * @param param - The parameter name (e.g., "mean", "stdev")
 * @returns A stable reference string
 */
export function generateConditionalReference(
  edgeId: string,
  constraintString: string,
  param: 'mean' | 'stdev'
): string {
  if (!constraintString || constraintString.trim() === '') {
    // Base case - no condition
    return `e.${edgeId}.p.${param}`;
  }
  
  // Use normalized constraint string directly
  const normalized = normalizeConstraintString(constraintString);
  
  return `e.${edgeId}.${normalized}.p.${param}`;
}

/**
 * Legacy function for backward compatibility.
 * Generates reference using only visited nodes (old format).
 * 
 * @deprecated Use generateConditionalReference() with full constraint string instead
 */
export function generateConditionalReferenceLegacy(
  edgeId: string,
  nodeIds: string[],
  param: 'mean' | 'stdev'
): string {
  if (nodeIds.length === 0) {
    return `e.${edgeId}.p.${param}`;
  }
  
  const sortedIds = [...nodeIds].sort();
  const conditionPart = `visited(${sortedIds.join(',')})`;
  
  return `e.${edgeId}.${conditionPart}.p.${param}`;
}

/**
 * Parse a conditional probability reference back into its components.
 * Supports both old format (visited(...)) and new format (full constraint string).
 * 
 * @param reference - The reference string to parse
 * @returns Parsed components or null if invalid
 */
export function parseConditionalReference(reference: string): {
  edgeId: string;
  constraintString?: string;
  nodeIds: string[]; // For backward compatibility
  param: 'mean' | 'stdev';
  isConditional: boolean;
} | null {
  // Match pattern: e.<edge-id>.p.<param> OR e.<edge-id>.<constraint-string>.p.<param>
  const basePattern = /^e\.([^.]+)\.p\.(mean|stdev)$/;
  
  // Try base pattern first
  const baseMatch = reference.match(basePattern);
  if (baseMatch) {
    const [, edgeId, param] = baseMatch;
    
    return {
      edgeId,
      nodeIds: [],
      param: param as 'mean' | 'stdev',
      isConditional: false
    };
  }
  
  // Try old format: e.<edge-id>.visited(<ids>).p.<param>
  const oldConditionalPattern = /^e\.([^.]+)\.visited\(([^)]+)\)\.p\.(mean|stdev)$/;
  const oldMatch = reference.match(oldConditionalPattern);
  if (oldMatch) {
    const [, edgeId, nodeIdsStr, param] = oldMatch;
    const nodeIds = nodeIdsStr.split(',').map(s => s.trim()).filter(s => s.length > 0);
    
    return {
      edgeId,
      constraintString: `visited(${nodeIds.sort().join(', ')})`,
      nodeIds: nodeIds.sort(),
      param: param as 'mean' | 'stdev',
      isConditional: true
    };
  }
  
  // Try new format: e.<edge-id>.<constraint-string>.p.<param>
  // Extract everything between edge-id and .p. as the constraint string
  const newConditionalPattern = /^e\.([^.]+)\.(.+)\.p\.(mean|stdev)$/;
  const newMatch = reference.match(newConditionalPattern);
  if (newMatch) {
    const [, edgeId, constraintStr, param] = newMatch;
    
    // Extract visited nodes for backward compatibility
    const parsed = parseConstraints(constraintStr);
    const nodeIds = parsed.visited;
    
    return {
      edgeId,
      constraintString: constraintStr,
      nodeIds,
      param: param as 'mean' | 'stdev',
      isConditional: true
    };
  }
  
  return null;
}

/**
 * Get all conditional probability references for an edge.
 * 
 * @param edge - The edge to generate references for
 * @param graph - The graph (needed to resolve node UUIDs to IDs)
 * @returns Array of reference objects with their values
 */
export function getEdgeConditionalReferences(
  edge: GraphEdge,
  graph: Graph
): Array<{
  reference: string;
  value: number;
  param: 'mean' | 'stdev';
  nodeIds: string[];
  isBase: boolean;
}> {
  const references: Array<{
    reference: string;
    value: number;
    param: 'mean' | 'stdev';
    nodeIds: string[];
    isBase: boolean;
  }> = [];
  
  if (!edge.id) {
    console.warn(`Edge ${edge.uuid} has no ID, cannot generate references`);
    return references;
  }
  
  // Base probability references
  if (edge.p) {
    if (edge.p.mean !== undefined) {
      references.push({
        reference: generateConditionalReference(edge.id, '', 'mean'),
        value: edge.p.mean,
        param: 'mean',
        nodeIds: [],
        isBase: true
      });
    }
    if (edge.p.stdev !== undefined) {
      references.push({
        reference: generateConditionalReference(edge.id, '', 'stdev'),
        value: edge.p.stdev,
        param: 'stdev',
        nodeIds: [],
        isBase: true
      });
    }
  }
  
  // Conditional probability references
  if (edge.conditional_p) {
    for (const conditionalProb of edge.conditional_p) {
      // Skip old format conditions
      if (typeof conditionalProb.condition !== 'string') {
        console.warn(`Skipping old format condition for edge ${edge.id}`);
        continue;
      }
      
      // Normalize constraint string for stable reference
      const normalizedConstraint = normalizeConstraintString(conditionalProb.condition);
      
      // Extract visited nodes for backward compatibility (nodeIds field)
      const visitedNodeIds = getVisitedNodeIds(conditionalProb.condition);
      
      // Resolve node references (UUID or ID) to human-readable IDs
      const nodeIds = visitedNodeIds
        .map((nodeRef: string) => {
          const node = graph.nodes.find(n => n.uuid === nodeRef || n.id === nodeRef);
          if (!node?.id) {
            console.warn(`Node ${nodeRef} not found or has no ID`);
            return null;
          }
          return node.id;
        })
        .filter((id): id is string => id !== null);
      
      // Generate references for mean and stdev using new format
      if (conditionalProb.p.mean !== undefined) {
        references.push({
          reference: generateConditionalReference(edge.id, normalizedConstraint, 'mean'),
          value: conditionalProb.p.mean,
          param: 'mean',
          nodeIds,
          isBase: false
        });
      }
      if (conditionalProb.p.stdev !== undefined) {
        references.push({
          reference: generateConditionalReference(edge.id, normalizedConstraint, 'stdev'),
          value: conditionalProb.p.stdev,
          param: 'stdev',
          nodeIds,
          isBase: false
        });
      }
    }
  }
  
  return references;
}

/**
 * Get all conditional probability references for the entire graph.
 * 
 * @param graph - The graph to generate references for
 * @returns Array of all reference objects
 */
export function getAllConditionalReferences(graph: Graph): Array<{
  reference: string;
  value: number;
  param: 'mean' | 'stdev';
  edgeId: string;
  nodeIds: string[];
  isBase: boolean;
}> {
  const allReferences: Array<{
    reference: string;
    value: number;
    param: 'mean' | 'stdev';
    edgeId: string;
    nodeIds: string[];
    isBase: boolean;
  }> = [];
  
  for (const edge of graph.edges) {
    const edgeRefs = getEdgeConditionalReferences(edge, graph);
    allReferences.push(...edgeRefs.map(ref => ({
      ...ref,
      edgeId: edge.id || edge.uuid
    })));
  }
  
  return allReferences;
}

/**
 * Find a specific conditional probability value by reference.
 * 
 * @param reference - The reference string to look up
 * @param graph - The graph to search
 * @returns The value or undefined if not found
 */
export function findConditionalProbabilityByReference(
  reference: string,
  graph: Graph
): number | undefined {
  const parsed = parseConditionalReference(reference);
  if (!parsed) {
    return undefined;
  }
  
  // Find the edge
  const edge = graph.edges.find(e => e.id === parsed.edgeId);
  if (!edge) {
    return undefined;
  }
  
  // Base case
  if (!parsed.isConditional) {
    return parsed.param === 'mean' ? edge.p?.mean : edge.p?.stdev;
  }
  
  // Conditional case - need to find matching condition
  if (!edge.conditional_p) {
    return undefined;
  }
  
  // Normalize the constraint string from reference for comparison
  if (!parsed.constraintString) {
    return undefined;
  }
  
  const normalizedRefConstraint = normalizeConstraintString(parsed.constraintString);
  
  // Find matching condition by comparing normalized constraint strings
  for (const conditionalProb of edge.conditional_p) {
    // Skip old format conditions
    if (typeof conditionalProb.condition !== 'string') {
      continue;
    }
    
    // Normalize condition for comparison
    const normalizedCondition = normalizeConstraintString(conditionalProb.condition);
    
    // Match if normalized strings are equal
    if (normalizedRefConstraint === normalizedCondition) {
      return parsed.param === 'mean' ? conditionalProb.p.mean : conditionalProb.p.stdev;
    }
  }
  
  return undefined;
}

/**
 * Validate that all node and edge IDs in the graph are unique.
 * This is required for the reference system to work correctly.
 * 
 * @param graph - The graph to validate
 * @returns Object with validation results
 */
export function validateIdUniqueness(graph: Graph): {
  isValid: boolean;
  duplicateNodeIds: string[];
  duplicateEdgeIds: string[];
  nodesWithoutIds: string[];
  edgesWithoutIds: string[];
} {
  const nodeIds = new Map<string, number>();
  const edgeIds = new Map<string, number>();
  const nodesWithoutIds: string[] = [];
  const edgesWithoutIds: string[] = [];
  
  // Check node IDs
  for (const node of graph.nodes) {
    if (!node.id) {
      nodesWithoutIds.push(node.uuid);
    } else {
      nodeIds.set(node.id, (nodeIds.get(node.id) || 0) + 1);
    }
  }
  
  // Check edge IDs
  for (const edge of graph.edges) {
    if (!edge.id) {
      edgesWithoutIds.push(edge.uuid);
    } else {
      edgeIds.set(edge.id, (edgeIds.get(edge.id) || 0) + 1);
    }
  }
  
  const duplicateNodeIds = Array.from(nodeIds.entries())
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
  
  const duplicateEdgeIds = Array.from(edgeIds.entries())
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
  
  return {
    isValid: duplicateNodeIds.length === 0 && 
             duplicateEdgeIds.length === 0 && 
             nodesWithoutIds.length === 0 && 
             edgesWithoutIds.length === 0,
    duplicateNodeIds,
    duplicateEdgeIds,
    nodesWithoutIds,
    edgesWithoutIds
  };
}
